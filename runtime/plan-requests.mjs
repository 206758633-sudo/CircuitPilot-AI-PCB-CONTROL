/**
 * 计划级待审批队列 Store（task-40）。
 *
 * 定位：Agent 把「已生成、尚未执行」的 design/pcb 计划登记为 pending 人工审查请求；
 * UI 只做 approve/reject 决策；Agent 之后带 `approvalRequestId` 调 `/api/design/approve`
 * 或 `/api/pcb/approve` 时，server 必须消费「已批准且绑定完全一致」的请求才能签发审批令牌。
 *
 * 安全口径：
 *   - 只存计划元数据（planHash/targetFingerprint/windowId/kind 等），**绝不存/返回 approval token**；
 *   - 批准/拒绝只改变本 Store 的记录，不执行任何写操作、不签发任何令牌；
 *   - 绑定（kind/planHash/targetFingerprint/windowId）必须完全一致，防止 UI 批准后被换计划/换目标；
 *   - 持久化 JSON 用 temp+rename 原子写，文件权限 0600；加载损坏 fail-closed（构造抛错，
 *     由 server 决定降级策略），绝不把“读坏了”伪装成“没有待审批请求”；
 *   - 只允许内存中一次消费（status=consumed），重复消费明确报错，不产生二次签发。
 *
 * 零第三方依赖：node:crypto / node:fs / node:path。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 状态与允许的 kind（与 approval-service 的 plan/write 语义无关，这里是“计划审查”）。 */
export const PLAN_REQUEST_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'consumed']);
export const PLAN_REQUEST_KINDS = Object.freeze(['design', 'pcb']);
export const PLAN_REQUEST_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const PLAN_REQUEST_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PLAN_REQUEST_DEFAULT_MAX_ENTRIES = 100;
export const PLAN_REQUEST_ID_PATTERN = /^apr_[0-9a-f]{16}$/;

/** 错误码（HTTP 映射见 server：400 INVALID/CONFIRM，404 NOT_FOUND，409 其余冲突）。 */
export const PLAN_REQUEST_CODES = Object.freeze({
  INVALID: 'PLAN_REQUEST_INVALID',
  CONFIRM_REQUIRED: 'PLAN_REQUEST_CONFIRM_REQUIRED',
  NOT_FOUND: 'PLAN_REQUEST_NOT_FOUND',
  EXPIRED: 'PLAN_REQUEST_EXPIRED',
  NOT_APPROVED: 'PLAN_REQUEST_NOT_APPROVED',
  ALREADY_DECIDED: 'PLAN_REQUEST_ALREADY_DECIDED',
  ALREADY_CONSUMED: 'PLAN_REQUEST_ALREADY_CONSUMED',
  BINDING_MISMATCH: 'PLAN_REQUEST_BINDING_MISMATCH',
  CAPACITY: 'PLAN_REQUEST_CAPACITY',
  STORE_CORRUPT: 'PLAN_REQUEST_STORE_CORRUPT',
  STORE_UNAVAILABLE: 'PLAN_REQUEST_STORE_UNAVAILABLE',
  STORE_WRITE_FAILED: 'PLAN_REQUEST_STORE_WRITE_FAILED',
});

const STATUS_SET = new Set(PLAN_REQUEST_STATUSES);
const KIND_SET = new Set(PLAN_REQUEST_KINDS);
const REMOVABLE_STATUSES = new Set(['consumed', 'rejected']);
const FIELD_LIMITS = Object.freeze({
  planHash: 128,
  targetFingerprint: 256,
  windowId: 256,
  projectId: 256,
  documentUuid: 256,
  title: 500,
  summary: 2000,
  decisionNote: 500,
});

function storeError(message, code = PLAN_REQUEST_CODES.INVALID, status = 400, details) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value, field, { required = false, max = 500 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw storeError(`${field} 不能为空`, PLAN_REQUEST_CODES.INVALID, 400);
    return '';
  }
  if (typeof value !== 'string') throw storeError(`${field} 必须是字符串`, PLAN_REQUEST_CODES.INVALID, 400);
  const text = value.trim();
  if (required && !text) throw storeError(`${field} 不能为空`, PLAN_REQUEST_CODES.INVALID, 400);
  if (text.length > max) throw storeError(`${field} 长度不能超过 ${max}`, PLAN_REQUEST_CODES.INVALID, 400);
  return text;
}

function optionalId(value, field) {
  const text = safeText(value, field, { max: FIELD_LIMITS[field] ?? 256 });
  return text || null;
}

function safeList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw storeError(`${field} 必须是字符串数组`, PLAN_REQUEST_CODES.INVALID, 400);
  if (value.length > 20) throw storeError(`${field} 最多 20 条`, PLAN_REQUEST_CODES.INVALID, 400);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw storeError(`${field}[${index}] 必须是字符串`, PLAN_REQUEST_CODES.INVALID, 400);
    const text = item.trim();
    if (!text) throw storeError(`${field}[${index}] 不能为空`, PLAN_REQUEST_CODES.INVALID, 400);
    if (text.length > 300) throw storeError(`${field}[${index}] 长度不能超过 300`, PLAN_REQUEST_CODES.INVALID, 400);
    return text;
  });
}

function normalizeExpiresAt(value, nowMs, ttlMs) {
  if (value === undefined || value === null || value === '') return nowMs + ttlMs;
  let ms;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string') ms = Date.parse(value);
  else ms = Number.NaN;
  if (!Number.isFinite(ms)) throw storeError('expiresAt 必须是毫秒时间戳或 ISO 时间字符串', PLAN_REQUEST_CODES.INVALID, 400);
  if (ms <= nowMs) throw storeError('expiresAt 必须是未来时间', PLAN_REQUEST_CODES.INVALID, 400);
  if (ms > nowMs + PLAN_REQUEST_MAX_TTL_MS) throw storeError('expiresAt 距现在不能超过 7 天', PLAN_REQUEST_CODES.INVALID, 400);
  return Math.floor(ms);
}

function normalizeStatus(value, field = 'status') {
  if (value === undefined || value === null || value === '') return 'pending';
  if (typeof value !== 'string' || !STATUS_SET.has(value)) throw storeError(`${field} 只能是 ${PLAN_REQUEST_STATUSES.join('/')}`, PLAN_REQUEST_CODES.INVALID, 400);
  return value;
}

/** 公开视图（字段白名单）：任何内部字段/令牌都不可能从这里漏出。 */
export function planRequestPublicView(record) {
  if (!record) return null;
  return {
    requestId: record.requestId,
    kind: record.kind,
    planHash: record.planHash,
    targetFingerprint: record.targetFingerprint,
    windowId: record.windowId,
    projectId: record.projectId ?? null,
    documentUuid: record.documentUuid ?? null,
    title: record.title ?? '',
    summary: record.summary ?? '',
    risks: Array.isArray(record.risks) ? [...record.risks] : [],
    missing: Array.isArray(record.missing) ? [...record.missing] : [],
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    decidedAt: record.decidedAt ?? null,
    consumedAt: record.consumedAt ?? null,
    decisionNote: record.decisionNote ?? '',
  };
}

/**
 * 计划级待审批队列。
 *
 * @param {object} [options]
 * @param {string|null} [options.file] 持久化文件；null/'' = 仅内存（测试/临时模式）
 * @param {() => number} [options.now] 时钟注入（毫秒）；默认 Date.now
 * @param {number} [options.maxEntries] 容量上限（默认 100）
 * @param {number} [options.ttlMs] 默认 TTL（默认 24h，签发时也可显式 expiresAt，但 ≤7d）
 */
export class PlanRequestStore {
  constructor({ file = null, now = () => Date.now(), maxEntries = PLAN_REQUEST_DEFAULT_MAX_ENTRIES, ttlMs = PLAN_REQUEST_DEFAULT_TTL_MS } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw storeError('maxEntries 必须是正整数', PLAN_REQUEST_CODES.INVALID, 400);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > PLAN_REQUEST_MAX_TTL_MS) {
      throw storeError('ttlMs 必须在 (0, 7d] 内', PLAN_REQUEST_CODES.INVALID, 400);
    }
    this.file = typeof file === 'string' && file.trim() ? file.trim() : null;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.records = new Map();
    if (this.file) this.load();
  }

  /* ------------------------------------------------------------------ */
  /* 内部：时钟 / 过期 / 序列化                                          */
  /* ------------------------------------------------------------------ */

  nowMs() {
    const value = this.now();
    const ms = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(ms)) throw storeError('PlanRequestStore 的 now() 必须返回合法时间', PLAN_REQUEST_CODES.STORE_WRITE_FAILED, 500);
    return ms;
  }

  isExpired(record, nowMs) {
    return !record || !Number.isFinite(record.expiresAt) || record.expiresAt <= nowMs;
  }

  /** 加载：任何字段/结构异常都 fail-closed，不静默清空。 */
  load() {
    try {
      if (!existsSync(this.file)) return;
      const raw = readFileSync(this.file, 'utf8');
      const payload = JSON.parse(raw);
      const rows = Array.isArray(payload) ? payload : payload?.requests;
      if (!Array.isArray(rows)) throw new Error('payload.requests 不是数组');
      if (rows.length > this.maxEntries * 10) throw new Error(`记录数 ${rows.length} 超过合理上限`);
      for (const row of rows) {
        const record = this.normalizeStored(row);
        if (this.records.has(record.requestId)) throw new Error(`重复 requestId：${record.requestId}`);
        this.records.set(record.requestId, record);
      }
      this.pruneForCapacity(this.nowMs());
    } catch (error) {
      if (error?.code === PLAN_REQUEST_CODES.STORE_CORRUPT) throw error;
      throw storeError(
        `计划级待审批队列状态文件损坏（fail-closed，拒绝用空队列继续）：${this.file}（${error?.code || error?.message || error}）`,
        PLAN_REQUEST_CODES.STORE_CORRUPT,
        500,
        { file: this.file },
      );
    }
  }

  normalizeStored(row) {
    if (!isPlainObject(row)) throw new Error('记录不是对象');
    const requestId = String(row.requestId ?? '');
    if (!PLAN_REQUEST_ID_PATTERN.test(requestId)) throw new Error(`requestId 非法：${requestId}`);
    const kind = String(row.kind ?? '');
    if (!KIND_SET.has(kind)) throw new Error(`kind 非法：${kind}`);
    const status = String(row.status ?? '');
    if (!STATUS_SET.has(status)) throw new Error(`status 非法：${status}`);
    const createdAt = Number(row.createdAt);
    const expiresAt = Number(row.expiresAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) throw new Error('createdAt/expiresAt 非法');
    return {
      requestId,
      kind,
      planHash: safeText(row.planHash, 'planHash', { required: true, max: FIELD_LIMITS.planHash }),
      targetFingerprint: safeText(row.targetFingerprint, 'targetFingerprint', { required: true, max: FIELD_LIMITS.targetFingerprint }),
      windowId: safeText(row.windowId, 'windowId', { required: true, max: FIELD_LIMITS.windowId }),
      projectId: optionalId(row.projectId, 'projectId'),
      documentUuid: optionalId(row.documentUuid, 'documentUuid'),
      title: safeText(row.title, 'title', { max: FIELD_LIMITS.title }),
      summary: safeText(row.summary, 'summary', { max: FIELD_LIMITS.summary }),
      risks: safeList(row.risks, 'risks'),
      missing: safeList(row.missing, 'missing'),
      status,
      createdAt,
      expiresAt,
      decidedAt: row.decidedAt === null || row.decidedAt === undefined ? null : Number(row.decidedAt),
      consumedAt: row.consumedAt === null || row.consumedAt === undefined ? null : Number(row.consumedAt),
      decisionNote: safeText(row.decisionNote, 'decisionNote', { max: FIELD_LIMITS.decisionNote }),
    };
  }

  serialize() {
    return {
      version: 1,
      requests: [...this.records.values()].map((record) => ({ ...record, risks: [...record.risks], missing: [...record.missing] })),
    };
  }

  /**
   * 原子写：同目录 temp → fsync 由 Node 负责的 writeFileSync（同步写）→ rename 覆盖。
   * 文件权限固定 0600；写失败抛 STORE_WRITE_FAILED，不静默降级。
   */
  persist() {
    if (!this.file) return;
    const temp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temp, `${JSON.stringify(this.serialize())}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* 忽略清理失败 */ }
      throw storeError(
        `计划级待审批队列写入失败：${this.file}（${error?.code || error?.message || error}）`,
        PLAN_REQUEST_CODES.STORE_WRITE_FAILED,
        500,
        { file: this.file },
      );
    }
  }

  /** 只删最旧的可淘汰记录（expired/consumed/rejected），绝不删 live pending/approved。 */
  pruneForCapacity(nowMs = this.nowMs()) {
    while (this.records.size >= this.maxEntries) {
      let victim = null;
      for (const record of this.records.values()) {
        const expired = this.isExpired(record, nowMs);
        if (!expired && !REMOVABLE_STATUSES.has(record.status)) continue;
        if (!victim || record.createdAt < victim.createdAt) victim = record;
      }
      if (!victim) return false;
      this.records.delete(victim.requestId);
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 公开 API                                                            */
  /* ------------------------------------------------------------------ */

  create(input = {}) {
    if (!isPlainObject(input)) throw storeError('请求体必须是对象', PLAN_REQUEST_CODES.INVALID, 400);
    const kind = String(input.kind ?? '');
    if (!KIND_SET.has(kind)) throw storeError('kind 只能是 design 或 pcb', PLAN_REQUEST_CODES.INVALID, 400);
    const planHash = safeText(input.planHash, 'planHash', { required: true, max: FIELD_LIMITS.planHash });
    const targetFingerprint = safeText(input.targetFingerprint, 'targetFingerprint', { required: true, max: FIELD_LIMITS.targetFingerprint });
    const windowId = safeText(input.windowId, 'windowId', { required: true, max: FIELD_LIMITS.windowId });
    const nowMs = this.nowMs();
    const expiresAt = normalizeExpiresAt(input.expiresAt, nowMs, this.ttlMs);
    const record = {
      requestId: this.nextRequestId(),
      kind,
      planHash,
      targetFingerprint,
      windowId,
      projectId: optionalId(input.projectId, 'projectId'),
      documentUuid: optionalId(input.documentUuid, 'documentUuid'),
      title: safeText(input.title, 'title', { max: FIELD_LIMITS.title }),
      summary: safeText(input.summary, 'summary', { max: FIELD_LIMITS.summary }),
      risks: safeList(input.risks, 'risks'),
      missing: safeList(input.missing, 'missing'),
      status: 'pending',
      createdAt: nowMs,
      expiresAt,
      decidedAt: null,
      consumedAt: null,
      decisionNote: '',
    };
    this.pruneForCapacity(nowMs);
    if (this.records.size >= this.maxEntries) {
      throw storeError(`待审批队列已满（${this.maxEntries} 条，且没有可淘汰的 expired/consumed/rejected），请先处理`, PLAN_REQUEST_CODES.CAPACITY, 409);
    }
    this.records.set(record.requestId, record);
    this.persist();
    return planRequestPublicView(record);
  }

  nextRequestId() {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const requestId = `apr_${randomBytes(8).toString('hex')}`;
      if (!this.records.has(requestId)) return requestId;
    }
    throw storeError('无法生成唯一 requestId', PLAN_REQUEST_CODES.INVALID, 500);
  }

  get(requestId) {
    const id = String(requestId ?? '').trim();
    if (!id) return null;
    return planRequestPublicView(this.records.get(id));
  }

  /**
   * 列表：默认 pending；可指定 approved/rejected/consumed/all；排除 expired；createdAt asc。
   * limit 默认 100（最大 100）。
   */
  list({ status = 'pending', limit = PLAN_REQUEST_DEFAULT_MAX_ENTRIES } = {}) {
    const wanted = status === undefined || status === null || status === '' ? 'pending' : status;
    if (wanted !== 'all' && !STATUS_SET.has(wanted)) {
      throw storeError(`status 只能是 pending/approved/rejected/consumed/all，收到：${String(wanted).slice(0, 40)}`, PLAN_REQUEST_CODES.INVALID, 400);
    }
    const parsedLimit = Number(limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
      throw storeError('limit 必须是 1..100 的整数', PLAN_REQUEST_CODES.INVALID, 400);
    }
    const take = Math.min(parsedLimit, PLAN_REQUEST_DEFAULT_MAX_ENTRIES);
    const nowMs = this.nowMs();
    const rows = [...this.records.values()]
      .filter((record) => (wanted === 'all' || record.status === wanted) && !this.isExpired(record, nowMs))
      .sort((left, right) => left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId))
      .slice(0, take)
      .map(planRequestPublicView);
    return rows;
  }

  listAll() {
    const nowMs = this.nowMs();
    return [...this.records.values()]
      .filter((record) => !this.isExpired(record, nowMs))
      .sort((left, right) => left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId))
      .map(planRequestPublicView);
  }

  /** 人工决定：只允许 pending；只改记录，绝不签发 token / 执行写操作。 */
  decide(requestId, { decision, note } = {}) {
    const record = this.requireRecord(requestId);
    const nowMs = this.nowMs();
    if (this.isExpired(record, nowMs)) {
      throw storeError('待审批请求已过期，不能再决定', PLAN_REQUEST_CODES.EXPIRED, 409, { requestId: record.requestId });
    }
    if (record.status !== 'pending') {
      throw storeError(`待审批请求已是 ${record.status}，不能重复决定`, PLAN_REQUEST_CODES.ALREADY_DECIDED, 409, { requestId: record.requestId, status: record.status });
    }
    if (decision !== 'approve' && decision !== 'reject') {
      throw storeError('decision 只能是 approve 或 reject', PLAN_REQUEST_CODES.INVALID, 400);
    }
    const decisionNote = safeText(note, 'note', { max: FIELD_LIMITS.decisionNote });
    record.status = decision === 'approve' ? 'approved' : 'rejected';
    record.decidedAt = nowMs;
    record.decisionNote = decisionNote;
    this.persist();
    return planRequestPublicView(record);
  }

  /**
   * 消费已批准请求：必须 approved、未过期、kind/planHash/targetFingerprint/windowId 全一致。
   * 成功置 consumed（一次性）；错误码严格区分，调用方据此 404/409。
   */
  consumeApproved({ requestId, kind, planHash, targetFingerprint, windowId } = {}) {
    const record = this.requireRecord(requestId);
    const nowMs = this.nowMs();
    if (this.isExpired(record, nowMs)) {
      throw storeError('待审批请求已过期，不能消费', PLAN_REQUEST_CODES.EXPIRED, 409, { requestId: record.requestId });
    }
    if (record.status === 'consumed') {
      throw storeError('待审批请求已被消费', PLAN_REQUEST_CODES.ALREADY_CONSUMED, 409, { requestId: record.requestId });
    }
    if (record.status !== 'approved') {
      throw storeError(`待审批请求状态是 ${record.status}，只有 approved 才能消费`, PLAN_REQUEST_CODES.NOT_APPROVED, 409, { requestId: record.requestId, status: record.status });
    }
    const expected = {
      kind: String(kind ?? '').trim(),
      planHash: String(planHash ?? '').trim(),
      targetFingerprint: String(targetFingerprint ?? '').trim(),
      windowId: String(windowId ?? '').trim(),
    };
    const actual = {
      kind: record.kind,
      planHash: record.planHash,
      targetFingerprint: record.targetFingerprint,
      windowId: record.windowId,
    };
    const mismatched = Object.keys(expected).filter((field) => expected[field] !== actual[field]);
    if (mismatched.length) {
      throw storeError(
        `批准请求与本次计划绑定不一致：${mismatched.join(', ')}`,
        PLAN_REQUEST_CODES.BINDING_MISMATCH,
        409,
        { requestId: record.requestId, fields: mismatched },
      );
    }
    record.status = 'consumed';
    record.consumedAt = nowMs;
    this.persist();
    return planRequestPublicView(record);
  }

  /** server 内部：manager 签发失败时把 consumed 回滚到 approved（只回滚本次消费）。 */
  rollbackConsumed(requestId) {
    const id = String(requestId ?? '').trim();
    const record = id ? this.records.get(id) : null;
    if (!record || record.status !== 'consumed') return planRequestPublicView(record);
    record.status = 'approved';
    record.consumedAt = null;
    this.persist();
    return planRequestPublicView(record);
  }

  requireRecord(requestId) {
    const id = String(requestId ?? '').trim();
    if (!id) throw storeError('requestId 不能为空', PLAN_REQUEST_CODES.NOT_FOUND, 404);
    const record = this.records.get(id);
    if (!record) throw storeError('待审批请求不存在', PLAN_REQUEST_CODES.NOT_FOUND, 404, { requestId: id });
    return record;
  }

  /** 只读快照（测试/诊断用，不含 token）。 */
  snapshot() {
    return this.listAll().map((row) => ({ ...row, risks: [...row.risks], missing: [...row.missing] }));
  }
}

/** 便捷工厂（与其它 Store 的 createXxx 风格一致）。 */
export function createPlanRequestStore(options = {}) {
  return new PlanRequestStore(options);
}
