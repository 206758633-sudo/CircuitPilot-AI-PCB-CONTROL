import crypto from 'node:crypto';

/**
 * 统一批准服务（C2 / E5）。
 *
 * 背景：计划批准（Design `ApprovalStore`）和写板批准（automation `createApprovalStore`）
 * 各自实现了一遍"签发 → TTL → 一次性消费 → 绑定校验 → 审计"。两份实现的差异本身不是问题，
 * 问题是**语义会漂移**：比如一边允许复用、一边拒绝；一边过期返回 A 码、一边返回 B 码。
 * 这里把核心收敛成唯一实现，两个上层只做"适配器"（字段命名/审计落点保持原样）：
 *
 *   1. 身份：每次签发产生随机 `token`（返回给客户端）与 `approvalId`（可公开的标识，不含令牌原文）；
 *   2. 作用域：plan / write / release，可扩展但默认这三个；
 *   3. 有效期：默认 30 分钟，可由调用方按批准类型覆盖；
 *   4. 一次性：消费即失效，重放返回 APPROVAL_REPLAYED（不是"再放行一次"）；
 *   5. 绑定：调用方通过 `match` 谓词校验绑定（指纹/计划哈希/配方），不匹配即拒绝；
 *   6. 审计：所有生命周期事件通过 `onEvent` 回调交给上层写 journal / 哈希链账本；
 *      服务本身不落盘（进程内有效，重启即失效——这是有意的安全行为）。
 *
 * 错误码是本模块的一部分：上层适配器会映射成它们原有的对外错误码，测试也断言具体 code，
 * 不允许用"抛了个错"当通过。
 */

export const APPROVAL_SERVICE_DEFAULT_TTL_MS = 30 * 60 * 1000;
export const APPROVAL_SERVICE_DEFAULT_MAX_ENTRIES = 500;
export const APPROVAL_SERVICE_SCOPES = Object.freeze(['plan', 'write', 'release']);

const code = (message, errorCode, details) => Object.assign(new Error(message), { code: errorCode, ...(details ? { details } : {}) });
const digestOfToken = (token) => crypto.createHash('sha256').update(String(token ?? '')).digest('hex');

/**
 * @param {{
 *   now?: () => number,
 *   defaultTtlMs?: number,
 *   maxEntries?: number,
 *   allowedScopes?: readonly string[],
 *   onEvent?: null | ((event: {action: string, record: object|null, at: number}) => void)
 * }} options
 */
export function createApprovalService({
  now = () => Date.now(),
  defaultTtlMs = APPROVAL_SERVICE_DEFAULT_TTL_MS,
  maxEntries = APPROVAL_SERVICE_DEFAULT_MAX_ENTRIES,
  allowedScopes = APPROVAL_SERVICE_SCOPES,
  onEvent = null,
} = {}) {
  if (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0) throw code('批准默认有效期必须是正数', 'APPROVAL_TTL_INVALID');
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw code('批准容量上限必须是正整数', 'APPROVAL_CAPACITY_INVALID');
  const scopes = Object.freeze([...new Set(allowedScopes)]);
  if (!scopes.length) throw code('批准作用域不能为空', 'APPROVAL_SCOPE_INVALID');

  /** approvalId -> record（record 内不含 token，只含其摘要） */
  const records = new Map();

  const emit = (action, record) => {
    if (!onEvent) return;
    onEvent({ action, record: record ? { ...record, bindings: { ...record.bindings } } : null, at: now() });
  };
  const isLive = (record) => !record.usedAt && !record.revokedAt && record.expiresAt > now();
  const prune = () => {
    // 只做容量淘汰：已使用/已过期/已撤销的记录保留到容量上限，便于按 approvalId
    // 解释“为什么不能撤销”（区分 missing/used/expired/revoked），list() 仍只回 live。
    // 防御性上限：极端情况下也不让内存无限增长（最早签发的先淘汰）。
    while (records.size > maxEntries) records.delete(records.keys().next().value);
  };
  const publicView = (record) => ({
    approvalId: record.approvalId,
    scope: record.scope,
    bindings: { ...record.bindings },
    note: record.note,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  });

  return {
    scopes,
    /**
     * 签发一次性批准。token 只在这里返回一次；调用方必须把它交给客户端/人工，服务端不再保存原文。
     */
    issue({ scope, bindings = {}, ttlMs = defaultTtlMs, note = '' } = {}) {
      if (!scopes.includes(scope)) throw code(`批准作用域必须是 ${scopes.join('/')}`, 'APPROVAL_SCOPE_INVALID', { scope, allowed: scopes });
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw code('批准有效期必须是正数', 'APPROVAL_TTL_INVALID');
      if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw code('批准绑定必须是对象', 'APPROVAL_BINDINGS_INVALID');
      prune();
      const token = crypto.randomBytes(32).toString('base64url');
      const issuedAt = now();
      const record = {
        approvalId: crypto.randomUUID(),
        tokenDigest: digestOfToken(token),
        scope,
        bindings: { ...bindings },
        note: String(note || '').slice(0, 200),
        issuedAt,
        expiresAt: issuedAt + ttlMs,
        usedAt: null,
        revokedAt: null,
      };
      records.set(record.approvalId, record);
      emit('issued', record);
      return { ...publicView(record), token };
    },
    /** 仅列出仍可用的批准（不含已用/已过期/已撤销）。 */
    list() {
      prune();
      return [...records.values()].filter(isLive).map(publicView);
    },
    /**
     * 按 approvalId 批量消费：requiredScopes 全部满足才一次性全部消费（原子：先全查再全消费）。
     * `match(record)` 由上层提供，用于配方/指纹等额外绑定校验。
     */
    resolve({ approvalIds = [], requiredScopes = [], match = null } = {}) {
      prune();
      const ids = Array.isArray(approvalIds) ? approvalIds.map(String) : [];
      const candidates = ids.map((id) => records.get(id)).filter((record) => record && isLive(record));
      const missing = [];
      const matched = [];
      for (const scope of requiredScopes) {
        const found = candidates.find((record) => record.scope === scope && !matched.includes(record) && (!match || match(record)));
        if (!found) {
          missing.push({ scope, reason: '没有匹配的批准（可能未签发/已使用/已过期/配方或目标不匹配）' });
          continue;
        }
        matched.push(found);
      }
      if (missing.length) return { ok: false, missing, approvals: {}, used: [] };
      const usedAt = now();
      for (const record of matched) { record.usedAt = usedAt; }
      for (const record of matched) emit('consumed', record);
      return {
        ok: true,
        missing: [],
        approvals: Object.fromEntries(matched.map((record) => [record.scope, true])),
        used: matched.map((record) => ({ ...publicView(record), usedAt })),
      };
    },
    /** 按令牌消费单个批准；绑定校验由 `expectedBindings` 字段逐一比对。 */
    consumeToken({ token, requiredScope = null, expectedBindings = null } = {}) {
      const record = [...records.values()].find((item) => item.tokenDigest === digestOfToken(token));
      if (!record) { emit('replayed', null); throw code('批准令牌无效', 'APPROVAL_INVALID'); }
      if (record.usedAt) { emit('replayed', record); throw code('批准令牌已使用', 'APPROVAL_REPLAYED', { approvalId: record.approvalId }); }
      if (record.revokedAt) { emit('revoked', record); throw code('批准令牌已撤销', 'APPROVAL_INVALID', { approvalId: record.approvalId }); }
      if (record.expiresAt <= now()) { emit('expired', record); throw code('批准令牌已过期', 'APPROVAL_EXPIRED', { approvalId: record.approvalId }); }
      if (requiredScope && record.scope !== requiredScope) {
        emit('mismatch', record);
        throw code(`批准作用域不匹配：需要 ${requiredScope}，实际 ${record.scope}`, 'APPROVAL_SCOPE_MISMATCH', { approvalId: record.approvalId });
      }
      if (expectedBindings && typeof expectedBindings === 'object') {
        for (const [field, value] of Object.entries(expectedBindings)) {
          if (record.bindings[field] !== value) {
            emit('mismatch', record);
            throw code(`批准绑定不匹配:${field}`, 'APPROVAL_MISMATCH', { approvalId: record.approvalId, field });
          }
        }
      }
      const usedAt = now();
      record.usedAt = usedAt;
      emit('consumed', record);
      return { ...publicView(record), usedAt };
    },
    /**
     * 按 approvalId 撤销仍可用的批准（UI 待执行队列用；不接收令牌原文）。
     * 只允许 live 记录；不存在/已使用/已过期/已撤销一律 APPROVAL_INVALID，不写假审计。
     * `details.reason` 仅供路由区分 404（不存在/已撤销）与 409（已使用/已过期），不含敏感信息。
     */
    revokeById({ approvalId } = {}) {
      const id = String(approvalId ?? '').trim();
      const record = id ? records.get(id) : null;
      if (!record) throw code('批准不存在或已失效', 'APPROVAL_INVALID', { approvalId: id, reason: 'missing' });
      if (record.usedAt) throw code('批准已使用，不能撤销', 'APPROVAL_INVALID', { approvalId: id, reason: 'used' });
      if (record.revokedAt) throw code('批准已撤销', 'APPROVAL_INVALID', { approvalId: id, reason: 'revoked' });
      if (record.expiresAt <= now()) throw code('批准已过期，不能撤销', 'APPROVAL_INVALID', { approvalId: id, reason: 'expired' });
      record.revokedAt = now();
      emit('revoked', record);
      return publicView(record);
    },
    /** 撤销未使用的批准；已使用/不存在一律按无效拒绝（不制造"撤销成功"的假象，也不写假审计）。 */
    revokeToken({ token } = {}) {
      const record = [...records.values()].find((item) => item.tokenDigest === digestOfToken(token));
      if (!record || record.usedAt || record.revokedAt) throw code('批准令牌无效或已使用', 'APPROVAL_INVALID');
      record.revokedAt = now();
      emit('revoked', record);
      return publicView(record);
    },
    /** 只读快照（含内部字段的副本），用于测试与诊断，不含令牌原文。 */
    snapshot() {
      prune();
      return [...records.values()].map((record) => ({ ...record, bindings: { ...record.bindings } }));
    },
  };
}
