import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 通用知识库存储层（W3-01 存储 + W3-02 条目 schema/版本）。
 *
 * 定位：给 CircuitPilot 的"通用 PCB 设计能力"打底，不针对任何具体板子。
 * 四类条目：part（器件）/ module（模块）/ rule（规则）/ failure（失败/回归）。
 *
 * 为什么是"文件 + 哈希"而不是内存/数据库：
 *   - 知识条目必须能被第三人复核、被 gate 引用，重启后仍可追溯；
 *   - 条目身份由 entityKey（料号/封装/模块号/规则号/失败号）确定，内容由 fingerprint 分版本；
 *   - 每次落盘算 digest（整条内容 sha256），读取时重算校验，损坏一律 fail-closed（不静默跳过）；
 *   - 写入用 "临时文件 + rename" 原子替换，中途崩溃不留半文件；
 *   - review 状态机 + trust 等级 + TTL + 冲突检测，保证"能进放行判定的知识"是可信且不过期的。
 *
 * 目录约定（root 下）：
 *   <kind>/<id>-<digest前8>.json   每条知识一个文件
 *   usage.jsonl                    使用记录（append-only，谁在哪个判定里引用/否决过）
 *
 * 版本策略（W3-02）：同 entityKey 下 payload 不同 = 不同 fingerprint = 不同版本，
 * 各占一个 id/文件，查询时都能取回；完全相同的 fingerprint 重复保存只更新元数据
 * （title/provenance/trust/ttlDays/updatedAt），不新增条目、也不把已 approved 的审核打回 candidate。
 */

export const KNOWLEDGE_KINDS = Object.freeze(['part', 'module', 'rule', 'failure']);
export const KNOWLEDGE_TRUST_LEVELS = Object.freeze(['authoritative', 'reference', 'unverified']);
export const KNOWLEDGE_REVIEW_STATES = Object.freeze(['candidate', 'approved', 'rejected']);
export const KNOWLEDGE_USAGE_OUTCOMES = Object.freeze(['used', 'overturned']);

export const KNOWLEDGE_CODES = Object.freeze({
  ROOT_REQUIRED: 'KNOWLEDGE_ROOT_REQUIRED',
  ID_REQUIRED: 'KNOWLEDGE_ID_REQUIRED',
  KIND_INVALID: 'KNOWLEDGE_KIND_INVALID',
  TITLE_INVALID: 'KNOWLEDGE_TITLE_INVALID',
  PAYLOAD_INVALID: 'KNOWLEDGE_PAYLOAD_INVALID',
  PROVENANCE_INVALID: 'KNOWLEDGE_PROVENANCE_INVALID',
  TRUST_INVALID: 'KNOWLEDGE_TRUST_INVALID',
  TTL_INVALID: 'KNOWLEDGE_TTL_INVALID',
  KEY_MISSING: 'KNOWLEDGE_KEY_MISSING',
  QUERY_INVALID: 'KNOWLEDGE_QUERY_INVALID',
  REVIEW_INVALID: 'KNOWLEDGE_REVIEW_INVALID',
  NOT_FOUND: 'KNOWLEDGE_NOT_FOUND',
  CORRUPT: 'KNOWLEDGE_CORRUPT',
  WRITE_FAILED: 'KNOWLEDGE_WRITE_FAILED',
  USAGE_INVALID: 'KNOWLEDGE_USAGE_INVALID',
  ID_COLLISION: 'KNOWLEDGE_ID_COLLISION',
});

const DAY_MS = 24 * 60 * 60 * 1000;
const ID_PATTERN = /^kn-(?:part|module|rule|failure)-[a-f0-9]{16}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const REVIEW_DECISIONS = Object.freeze(['approved', 'rejected']);
const PROVENANCE_TEXT_FIELDS = Object.freeze(['url', 'version', 'fetchedAt', 'collector']);
// pins / pinout 是同一概念的不同写法，冲突检测时归并到同一字段。
const CONFLICT_FIELD_ALIASES = Object.freeze({ pinout: 'pins' });

const code = (message, errorCode, details) => Object.assign(new Error(message), { code: errorCode, details });

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 确定性序列化：对象键排序，用于 digest / fingerprint / 冲突值比较。 */
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const digestOf = (value) => sha256(canonical(value));

/** JSON 往返克隆：既是"可序列化"的强校验，也让落盘内容与内存 canonical 完全一致。 */
const jsonClone = (value, label, errorCode) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw code(`${label} 不是合法 JSON 数据：${String(error?.message || error).slice(0, 120)}`, errorCode, { label });
  }
};

const normalizePayload = (payload) => {
  if (!isPlainObject(payload)) {
    throw code('payload 必须是对象', KNOWLEDGE_CODES.PAYLOAD_INVALID, {
      payloadType: Array.isArray(payload) ? 'array' : payload === null ? 'null' : typeof payload,
    });
  }
  return jsonClone(payload, 'payload', KNOWLEDGE_CODES.PAYLOAD_INVALID);
};

const normalizeProvenance = (provenance) => {
  if (!isPlainObject(provenance)) {
    throw code('provenance 必须是对象', KNOWLEDGE_CODES.PROVENANCE_INVALID, { provenance: provenance ?? null });
  }
  const source = typeof provenance.source === 'string' ? provenance.source.trim() : '';
  if (!source) throw code('provenance.source 必填（来源是知识的可信度基础）', KNOWLEDGE_CODES.PROVENANCE_INVALID, { field: 'source' });
  const normalized = { ...provenance, source };
  for (const field of PROVENANCE_TEXT_FIELDS) {
    if (normalized[field] === undefined || normalized[field] === null) {
      delete normalized[field];
      continue;
    }
    if (typeof normalized[field] !== 'string' || !normalized[field].trim()) {
      throw code(`provenance.${field} 必须是非空字符串`, KNOWLEDGE_CODES.PROVENANCE_INVALID, { field });
    }
    normalized[field] = normalized[field].trim();
  }
  return jsonClone(normalized, 'provenance', KNOWLEDGE_CODES.PROVENANCE_INVALID);
};

const textKey = (value) => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

/**
 * entityKey 规则（W3-02）：
 *   part    → payload.lcscId || payload.mpn || payload.url || `${value}|${footprint}`
 *             （url 兜底用于“网页资料/参考页”这类还没有料号的候选知识）
 *   module  → payload.moduleId
 *   rule    → payload.ruleId
 *   failure → payload.failureId
 * 取不到稳定实体标识时抛 KNOWLEDGE_KEY_MISSING，而不是落一条无法再去重的知识。
 */
const entityKeyOf = (kind, payload) => {
  if (!isPlainObject(payload)) throw code('payload 必须是对象才能推导 entityKey', KNOWLEDGE_CODES.PAYLOAD_INVALID);
  if (kind === 'part') {
    const direct = textKey(payload.lcscId) || textKey(payload.mpn) || textKey(payload.url);
    if (direct) return direct;
    const value = textKey(payload.value);
    const footprint = textKey(payload.footprint);
    if (value && footprint) return `${value}|${footprint}`;
    throw code('part 条目缺少实体标识：需要 lcscId、mpn、url 或 value+footprint', KNOWLEDGE_CODES.KEY_MISSING, {
      kind,
      tried: ['lcscId', 'mpn', 'url', 'value+footprint'],
    });
  }
  const field = { module: 'moduleId', rule: 'ruleId', failure: 'failureId' }[kind];
  if (!field) throw code(`未知知识条目类型：${String(kind)}`, KNOWLEDGE_CODES.KIND_INVALID, { allowed: KNOWLEDGE_KINDS });
  const key = textKey(payload[field]);
  if (!key) throw code(`${kind} 条目缺少实体标识 ${field}`, KNOWLEDGE_CODES.KEY_MISSING, { kind, field });
  return key;
};

const fingerprintOf = (kind, entityKey, payload) => sha256(`${kind}\u0000${entityKey}\u0000${canonical(payload)}`);

/** digest 绑定条目全部业务字段（不含派生注解 expired / 文件路径）。 */
const entryDigest = (entry) => digestOf({
  kind: entry.kind,
  id: entry.id,
  title: entry.title,
  payload: entry.payload,
  provenance: entry.provenance,
  trust: entry.trust,
  ttlDays: entry.ttlDays ?? null,
  review: entry.review,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
});

const expiredOf = (entry, at) => {
  if (typeof entry.ttlDays !== 'number') return false;
  const createdMs = Date.parse(entry.createdAt);
  if (!Number.isFinite(createdMs)) return false; // schema 校验会先拦住非法时间
  return at.getTime() > createdMs + entry.ttlDays * DAY_MS;
};

/** 校验磁盘上的条目文档：字段/schema/digest 任一不符都视为损坏（fail-closed）。 */
const verifyEntryDocument = (parsed, file) => {
  const corrupt = (reason, details = {}) => {
    throw code(`知识库文件损坏（${reason}）：${file}`, KNOWLEDGE_CODES.CORRUPT, { file, reason, ...details });
  };
  if (!isPlainObject(parsed)) corrupt('顶层不是 JSON 对象');
  for (const field of ['id', 'kind', 'title', 'trust', 'createdAt', 'updatedAt', 'digest']) {
    if (typeof parsed[field] !== 'string' || !parsed[field].trim()) corrupt(`字段 ${field} 缺失或类型错误`);
  }
  if (!ID_PATTERN.test(parsed.id)) corrupt('id 格式不符合 kn-<kind>-<16 位十六进制>');
  if (!KNOWLEDGE_KINDS.includes(parsed.kind)) corrupt(`未知 kind：${String(parsed.kind)}`);
  if (!KNOWLEDGE_TRUST_LEVELS.includes(parsed.trust)) corrupt(`未知 trust：${String(parsed.trust)}`);
  if (!isPlainObject(parsed.payload)) corrupt('payload 不是对象');
  if (!isPlainObject(parsed.provenance) || typeof parsed.provenance.source !== 'string' || !parsed.provenance.source.trim()) {
    corrupt('provenance.source 缺失');
  }
  if (!isPlainObject(parsed.review) || !KNOWLEDGE_REVIEW_STATES.includes(parsed.review.state)) corrupt('review.state 非法');
  if (parsed.review.reviewedBy !== undefined && (typeof parsed.review.reviewedBy !== 'string' || !parsed.review.reviewedBy.trim())) {
    corrupt('review.reviewedBy 非法');
  }
  if (parsed.review.reviewedAt !== undefined && !Number.isFinite(Date.parse(parsed.review.reviewedAt))) {
    corrupt('review.reviewedAt 非法');
  }
  if (parsed.ttlDays !== undefined && !(typeof parsed.ttlDays === 'number' && Number.isFinite(parsed.ttlDays) && parsed.ttlDays >= 0)) {
    corrupt('ttlDays 非法');
  }
  if (!Number.isFinite(Date.parse(parsed.createdAt)) || !Number.isFinite(Date.parse(parsed.updatedAt))) {
    corrupt('时间字段不是合法时间');
  }
  if (!DIGEST_PATTERN.test(parsed.digest)) corrupt('digest 格式非法');
  try {
    entityKeyOf(parsed.kind, parsed.payload);
  } catch {
    corrupt('payload 无法推导 entityKey');
  }
  const recomputed = entryDigest(parsed);
  if (recomputed !== parsed.digest) {
    corrupt('digest 不匹配（文件可能被改动）', { expected: parsed.digest, actual: recomputed });
  }
  return {
    id: parsed.id,
    kind: parsed.kind,
    title: parsed.title,
    payload: parsed.payload,
    provenance: parsed.provenance,
    trust: parsed.trust,
    ...(parsed.ttlDays === undefined ? {} : { ttlDays: parsed.ttlDays }),
    review: parsed.review,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    digest: parsed.digest,
  };
};

/**
 * @param {{ root: string, now?: () => Date }} options
 */
export function createKnowledgeStore({ root, now = () => new Date() } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw code('知识库根目录不能为空', KNOWLEDGE_CODES.ROOT_REQUIRED);

  const dirFor = (kind) => join(root, kind);
  const usagePath = join(root, 'usage.jsonl');
  // WP4 P1-9：语料修订号。任何落盘（新增/更新/审核）都会递增；RAG 索引记录构建时的 revision，
  // 检索/状态发现 revision 变化就自动失效重建，不再需要用户手动 reindex。
  // 只存内存：进程重启后从头计数，此时已落盘的 RAG 索引会因 revision 不匹配在首次检索时重建一次（安全方向）。
  let revision = 0;

  const ensureDir = (kind) => {
    const dir = dirFor(kind);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  };

  const fileFor = (entry) => join(dirFor(entry.kind), `${entry.id}-${entry.digest.slice(0, 8)}.json`);

  /** 临时文件 + rename 原子替换；若条目 id 不变而 digest 变了（更新/审核），再删掉旧文件。 */
  const persist = (entry, previousFile = null) => {
    ensureDir(entry.kind);
    const file = fileFor(entry);
    const tempPath = join(dirFor(entry.kind), `.tmp-${process.pid}-${randomBytes(4).toString('hex')}.json`);
    try {
      writeFileSync(tempPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
      renameSync(tempPath, file);
    } catch (error) {
      try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* 清理失败不掩盖原始错误 */ }
      throw code(`知识库写入失败：${String(error?.message || error).slice(0, 160)}`, KNOWLEDGE_CODES.WRITE_FAILED, { kind: entry.kind, path: file });
    }
    if (previousFile && previousFile !== file) {
      try { if (existsSync(previousFile)) unlinkSync(previousFile); } catch { /* 旧版本清理失败不掩盖成功写入 */ }
    }
    revision += 1;
    return file;
  };

  const readKind = (kind) => {
    const dir = dirFor(kind);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
    const entries = [];
    for (const name of files) {
      const file = join(dir, name);
      let raw;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        throw code(`知识库文件无法读取：${file}`, KNOWLEDGE_CODES.CORRUPT, { file });
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw code(`知识库文件不是合法 JSON：${file}`, KNOWLEDGE_CODES.CORRUPT, { file });
      }
      entries.push(verifyEntryDocument(parsed, file));
    }
    return entries;
  };

  /** 同一 id 万一残留多个文件（如崩溃在 rename 与 unlink 之间），取 updatedAt 最新的一份。 */
  const newestById = (entries) => {
    const byId = new Map();
    for (const entry of entries) {
      const previous = byId.get(entry.id);
      if (!previous || Date.parse(entry.updatedAt) >= Date.parse(previous.updatedAt)) byId.set(entry.id, entry);
    }
    return [...byId.values()];
  };

  const readAll = () => {
    const entries = [];
    for (const kind of KNOWLEDGE_KINDS) entries.push(...readKind(kind));
    return newestById(entries);
  };

  const newestFirst = (entries) => [...entries].sort((left, right) => (
    (Date.parse(right.createdAt) - Date.parse(left.createdAt))
    || (Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    || left.id.localeCompare(right.id)
  ));

  const oldestFirst = (entries) => [...entries].sort((left, right) => (
    (Date.parse(left.createdAt) - Date.parse(right.createdAt))
    || left.id.localeCompare(right.id)
  ));

  // 返回条目附带 entityKey：检索/冲突队列/UI 都需要它，避免每个调用方各自再推导一遍。
  const annotate = (entry, at) => ({ ...entry, entityKey: entityKeyOf(entry.kind, entry.payload), expired: expiredOf(entry, at) });

  const validateFilters = ({ kind, trust, reviewState }) => {
    if (kind !== undefined && !KNOWLEDGE_KINDS.includes(kind)) {
      throw code(`未知知识条目类型：${String(kind)}`, KNOWLEDGE_CODES.KIND_INVALID, { allowed: KNOWLEDGE_KINDS });
    }
    if (trust !== undefined && !KNOWLEDGE_TRUST_LEVELS.includes(trust)) {
      throw code(`未知可信等级：${String(trust)}`, KNOWLEDGE_CODES.TRUST_INVALID, { allowed: KNOWLEDGE_TRUST_LEVELS });
    }
    if (reviewState !== undefined && !KNOWLEDGE_REVIEW_STATES.includes(reviewState)) {
      throw code(`未知审核状态：${String(reviewState)}`, KNOWLEDGE_CODES.REVIEW_INVALID, { allowed: KNOWLEDGE_REVIEW_STATES });
    }
  };

  const collect = ({ kind, trust, reviewState, includeExpired = false, at }) => {
    validateFilters({ kind, trust, reviewState });
    const entries = newestFirst(kind === undefined ? readAll() : readKind(kind));
    return entries
      .map((entry) => annotate(entry, at))
      .filter((entry) => {
        if (!includeExpired && entry.expired) return false;
        if (trust !== undefined && entry.trust !== trust) return false;
        if (reviewState !== undefined && entry.review.state !== reviewState) return false;
        return true;
      });
  };

  const get = (id) => {
    if (typeof id !== 'string' || !id.trim()) throw code('知识库条目 id 不能为空', KNOWLEDGE_CODES.ID_REQUIRED);
    const wanted = id.trim();
    const entry = readAll().find((item) => item.id === wanted) ?? null;
    return entry ? annotate(entry, now()) : null;
  };

  /** 按类型/可信等级/审核状态列条目；过期条目默认排除，includeExpired 时保留并标 expired:true。 */
  const list = ({ kind, trust, reviewState, includeExpired = false } = {}) => collect({ kind, trust, reviewState, includeExpired, at: now() });

  /**
   * 结构化检索：text 在 title + payload JSON 中不区分大小写包含；entityKey 按条目类型推导后精确匹配。
   * 同一个 entityKey 的不同版本（不同 fingerprint）都会返回。
   */
  const query = ({ kind, text, entityKey, trust, reviewState, includeExpired = false } = {}) => {
    if (text !== undefined && (typeof text !== 'string' || !text.trim())) {
      throw code('text 必须是非空字符串', KNOWLEDGE_CODES.QUERY_INVALID, { text });
    }
    if (entityKey !== undefined && (typeof entityKey !== 'string' || !entityKey.trim())) {
      throw code('entityKey 必须是非空字符串', KNOWLEDGE_CODES.QUERY_INVALID, { entityKey });
    }
    const wantedText = text === undefined ? null : text.trim().toLowerCase();
    const wantedEntityKey = entityKey === undefined ? null : entityKey.trim();
    return collect({ kind, trust, reviewState, includeExpired, at: now() }).filter((entry) => {
      if (wantedText !== null) {
        const haystack = `${entry.title}\n${JSON.stringify(entry.payload)}`.toLowerCase();
        if (!haystack.includes(wantedText)) return false;
      }
      if (wantedEntityKey !== null && entityKeyOf(entry.kind, entry.payload) !== wantedEntityKey) return false;
      return true;
    });
  };

  /**
   * 保存条目。校验失败抛对应错误码；返回 { entry, created }。
   * 相同 fingerprint 重复保存：更新 title/provenance/trust/ttlDays 与 updatedAt，保留原 id、createdAt 和审核状态。
   * 同一 entityKey 但 payload 不同：作为新版本新条目（created:true，review 从 candidate 开始），旧版本仍可取回。
   */
  const save = ({ kind, title, payload, provenance, trust, ttlDays, reviewState = 'candidate' } = {}) => {
    if (!KNOWLEDGE_KINDS.includes(kind)) {
      throw code(`未知知识条目类型：${String(kind)}`, KNOWLEDGE_CODES.KIND_INVALID, { allowed: KNOWLEDGE_KINDS });
    }
    if (typeof title !== 'string' || !title.trim()) {
      throw code('条目标题不能为空', KNOWLEDGE_CODES.TITLE_INVALID, { title: title ?? null });
    }
    const cleanPayload = normalizePayload(payload);
    const cleanProvenance = normalizeProvenance(provenance);
    if (!KNOWLEDGE_TRUST_LEVELS.includes(trust)) {
      throw code(`未知可信等级：${String(trust)}`, KNOWLEDGE_CODES.TRUST_INVALID, { allowed: KNOWLEDGE_TRUST_LEVELS });
    }
    let normalizedTtl;
    if (ttlDays !== undefined && ttlDays !== null) {
      if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays) || ttlDays < 0) {
        throw code('ttlDays 必须是 >= 0 的有限数字（天）', KNOWLEDGE_CODES.TTL_INVALID, { ttlDays });
      }
      normalizedTtl = ttlDays;
    }
    if (!KNOWLEDGE_REVIEW_STATES.includes(reviewState)) {
      throw code(`初始审核状态非法：${String(reviewState)}`, KNOWLEDGE_CODES.REVIEW_INVALID, { allowed: KNOWLEDGE_REVIEW_STATES });
    }

    const entityKey = entityKeyOf(kind, cleanPayload);
    const fingerprint = fingerprintOf(kind, entityKey, cleanPayload);
    const id = `kn-${kind}-${fingerprint.slice(0, 16)}`;
    const at = now();
    const stampIso = at.toISOString();

    const existing = readKind(kind).find((entry) => entry.id === id) ?? null;
    if (existing) {
      const existingFingerprint = fingerprintOf(existing.kind, entityKeyOf(existing.kind, existing.payload), existing.payload);
      if (existingFingerprint !== fingerprint) {
        throw code('知识库条目 id 哈希前缀冲突（不同 fingerprint 落到同一 id）', KNOWLEDGE_CODES.ID_COLLISION, { id });
      }
      // 相同 payload 的重复保存：只更新元数据。payload 未变，不得把已 approved 的审核打回 candidate。
      const nextTtl = ttlDays === undefined ? existing.ttlDays : normalizedTtl;
      const next = {
        id: existing.id,
        kind: existing.kind,
        title: title.trim(),
        payload: cleanPayload,
        provenance: cleanProvenance,
        trust,
        ...(nextTtl === undefined ? {} : { ttlDays: nextTtl }),
        review: { ...existing.review },
        createdAt: existing.createdAt,
        updatedAt: stampIso,
      };
      next.digest = entryDigest(next);
      persist(next, fileFor(existing));
      return { entry: next, created: false };
    }

    const newEntry = {
      id,
      kind,
      title: title.trim(),
      payload: cleanPayload,
      provenance: cleanProvenance,
      trust,
      ...(normalizedTtl === undefined ? {} : { ttlDays: normalizedTtl }),
      review: reviewState === 'candidate' ? { state: 'candidate' } : { state: reviewState, reviewedAt: stampIso },
      createdAt: stampIso,
      updatedAt: stampIso,
    };
    newEntry.digest = entryDigest(newEntry);
    persist(newEntry);
    return { entry: newEntry, created: true };
  };

  /**
   * 审核：只能落到 approved / rejected。
   *   - candidate → approved / rejected；
   *   - rejected  → 可重新审核为 approved / rejected；
   *   - approved  → 可改为 rejected（撤销），但**不得改回 candidate**——只有 payload 变化产生新版本时才回到 candidate。
   */
  const review = (id, { state, reviewedBy } = {}) => {
    if (typeof id !== 'string' || !id.trim()) throw code('知识库条目 id 不能为空', KNOWLEDGE_CODES.ID_REQUIRED);
    if (!REVIEW_DECISIONS.includes(state)) {
      throw code('审核结果只能是 approved 或 rejected（payload 变化会产生新版本并回到 candidate）', KNOWLEDGE_CODES.REVIEW_INVALID, {
        state: state ?? null,
        allowed: REVIEW_DECISIONS,
      });
    }
    let reviewer = null;
    if (reviewedBy !== undefined && reviewedBy !== null) {
      if (typeof reviewedBy !== 'string' || !reviewedBy.trim()) {
        throw code('reviewedBy 必须是非空字符串', KNOWLEDGE_CODES.REVIEW_INVALID, { reviewedBy });
      }
      reviewer = reviewedBy.trim();
    }
    const wanted = id.trim();
    const existing = readAll().find((entry) => entry.id === wanted) ?? null;
    if (!existing) throw code(`知识库条目不存在：${wanted}`, KNOWLEDGE_CODES.NOT_FOUND, { id: wanted });

    const at = now();
    const next = {
      ...existing,
      review: { state, ...(reviewer === null ? {} : { reviewedBy: reviewer }), reviewedAt: at.toISOString() },
      updatedAt: at.toISOString(),
    };
    next.digest = entryDigest(next);
    persist(next, fileFor(existing));
    return next;
  };

  /** 放行判定准入：可信（非 unverified）+ 已 approved + 未过期，三者缺一不可。 */
  const isUsableForGate = (entry) => {
    if (!isPlainObject(entry)) return false;
    if (entry.trust === 'unverified' || !KNOWLEDGE_TRUST_LEVELS.includes(entry.trust)) return false;
    if (entry.review?.state !== 'approved') return false;
    if (typeof entry.createdAt !== 'string') return false;
    return !expiredOf(entry, now());
  };

  /**
   * 冲突检测：同一 entityKey 下所有 approved 条目，payload 任意字段值不一致即冲突。
   * 只比较 approved——candidate/rejected 不参与放行，也不该污染冲突结论。
   * 返回 { entityKey, conflicts: [{ field, values: [{ id, value }] }] }，无冲突时 conflicts 为 []。
   */
  const detectConflicts = ({ entityKey } = {}) => {
    if (typeof entityKey !== 'string' || !entityKey.trim()) {
      throw code('冲突检测需要 entityKey', KNOWLEDGE_CODES.KEY_MISSING, { entityKey: entityKey ?? null });
    }
    const wanted = entityKey.trim();
    const approved = oldestFirst(readAll()).filter((entry) => (
      entry.review.state === 'approved' && entityKeyOf(entry.kind, entry.payload) === wanted
    ));
    const byField = new Map();
    for (const entry of approved) {
      for (const [rawField, value] of Object.entries(entry.payload)) {
        const field = CONFLICT_FIELD_ALIASES[rawField] ?? rawField;
        if (!byField.has(field)) byField.set(field, []);
        byField.get(field).push({ id: entry.id, value });
      }
    }
    const conflicts = [];
    for (const field of [...byField.keys()].sort()) {
      const values = byField.get(field);
      const distinct = new Set(values.map((item) => canonical(item.value)));
      if (distinct.size > 1) conflicts.push({ field, values });
    }
    return { entityKey: wanted, conflicts };
  };

  /** 使用记录：append-only 到 root/usage.jsonl，用于事后回答"这条知识进过哪个判定、后来是否被推翻"。 */
  const recordUsage = ({ id, agent, outcome, note } = {}) => {
    if (typeof id !== 'string' || !id.trim()) throw code('使用记录需要条目 id', KNOWLEDGE_CODES.ID_REQUIRED, { id: id ?? null });
    if (typeof agent !== 'string' || !agent.trim()) throw code('使用记录需要 agent', KNOWLEDGE_CODES.USAGE_INVALID, { agent: agent ?? null });
    if (!KNOWLEDGE_USAGE_OUTCOMES.includes(outcome)) {
      throw code(`使用结果非法：${String(outcome)}`, KNOWLEDGE_CODES.USAGE_INVALID, { allowed: KNOWLEDGE_USAGE_OUTCOMES });
    }
    if (note !== undefined && note !== null && typeof note !== 'string') {
      throw code('使用记录 note 必须是字符串', KNOWLEDGE_CODES.USAGE_INVALID, { note });
    }
    const record = {
      id: id.trim(),
      agent: agent.trim(),
      outcome,
      note: note ?? null,
      at: now().toISOString(),
    };
    try {
      if (!existsSync(root)) mkdirSync(root, { recursive: true });
      appendFileSync(usagePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      throw code(`使用记录写入失败：${String(error?.message || error).slice(0, 160)}`, KNOWLEDGE_CODES.WRITE_FAILED, { path: usagePath });
    }
    return record;
  };

  /** 读回使用记录；文件缺行/非法 JSON 一律 KNOWLEDGE_CORRUPT，不静默跳过。 */
  const listUsages = ({ id } = {}) => {
    let wanted = null;
    if (id !== undefined) {
      if (typeof id !== 'string' || !id.trim()) throw code('知识库条目 id 不能为空', KNOWLEDGE_CODES.ID_REQUIRED);
      wanted = id.trim();
    }
    if (!existsSync(usagePath)) return [];
    let raw;
    try {
      raw = readFileSync(usagePath, 'utf8');
    } catch {
      throw code(`使用记录无法读取：${usagePath}`, KNOWLEDGE_CODES.CORRUPT, { file: usagePath });
    }
    const records = [];
    raw.split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw code(`使用记录第 ${index + 1} 行不是合法 JSON`, KNOWLEDGE_CODES.CORRUPT, { file: usagePath, line: index + 1 });
      }
      const valid = isPlainObject(record)
        && typeof record.id === 'string' && record.id
        && typeof record.agent === 'string' && record.agent
        && KNOWLEDGE_USAGE_OUTCOMES.includes(record.outcome)
        && typeof record.at === 'string';
      if (!valid) {
        throw code(`使用记录第 ${index + 1} 行 schema 不符`, KNOWLEDGE_CODES.CORRUPT, { file: usagePath, line: index + 1 });
      }
      records.push(record);
    });
    return wanted === null ? records : records.filter((record) => record.id === wanted);
  };

  return {
    root,
    dirFor,
    get revision() { return revision; },
    save,
    get,
    list,
    query,
    review,
    isUsableForGate,
    detectConflicts,
    recordUsage,
    listUsages,
  };
}
