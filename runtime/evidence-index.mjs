/**
 * C5：证据索引 + 保留计划（只读索引，dry-run 治理）。
 *
 * ## 为什么需要它
 *
 * `runtime/evidence-store.mjs` 把 DRC 报告 / DFM 回填 / 人工终审 / ERC / 仿真 / 下单确认
 * 落成 `artifacts/evidence/<kind>/<kind>-<时间>-<digest前12位>.json`。文件一多就出现两个问题：
 *
 *  1. **找不回**：要复核"当时那次放行到底引用了哪份证据"时，只能靠手翻目录、肉眼比 digest；
 *  2. **不敢清**：证据目录会无限增长，但"看起来旧"和"可以删"完全是两件事——
 *     删错一份 DRC 报告，放行链条就断了。
 *
 * 本模块只做三件事，且**绝不删除任何文件**：
 *   - `buildEvidenceIndex({dirs,...})`：把证据目录扫成一份**带来源路径**的索引；
 *   - `findEvidence(index,{kind,digest})`：按 kind/digest 精确找回（找不到就明确返回 null，不猜）；
 *   - `planEvidenceRetention({index,now,keepPerKind,keepDays})`：给出"哪些可以删"的**计划**，
 *     语义固定为 dry-run（`dryRun: true`），真正的删除不在这里实现。
 *
 * ## fail-closed（拿不准就保留）
 *
 * - 读不出来的文件、解析失败的文件、字段不全的文件 → 进 `invalid`，**不会**成为删除候选；
 * - 目录读失败（权限/不存在）→ 进 `errors` 且 `complete:false`，此时计划 `safeToApply:false`；
 * - 同一 `kind+digest` 的重复文件只保留最新一条进索引，旧的进 `duplicates` 且不自动清理；
 * - 时间戳缺失/不可解析/来自未来 → 一律保留，并给出可读原因；
 * - 只有**同时**满足"超出每类保留条数"和"超过保留天数"的证据才会进入 `prune`。
 *   两个条件取交集而不是并集，是因为多保留一份的代价远小于删错一份。
 *
 * ## 目录约定
 *
 * `dirs` 里每一项既可以是目录（递归扫描其下 `*.json`），也可以直接是一个证据 JSON 文件。
 * `readFile` / `readdir` 可注入，测试不需要真实磁盘（默认用 `node:fs`）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const EVIDENCE_INDEX_SCHEMA_VERSION = 1;
export const EVIDENCE_INDEX_KIND = 'evidence-index';
export const EVIDENCE_RETENTION_PLAN_KIND = 'evidence-retention-plan';

/** 保留计划的默认值：每类留 3 份、留 30 天。改默认值必须同步测试。 */
export const EVIDENCE_RETENTION_DEFAULTS = Object.freeze({ keepPerKind: 3, keepDays: 30 });

export const EVIDENCE_INDEX_CODES = Object.freeze({
  DIRS_REQUIRED: 'EVIDENCE_INDEX_DIRS_REQUIRED',
  DIRS_INVALID: 'EVIDENCE_INDEX_DIRS_INVALID',
  READ_FAILED: 'EVIDENCE_INDEX_READ_FAILED',
  CORRUPT: 'EVIDENCE_INDEX_CORRUPT',
  INDEX_INVALID: 'EVIDENCE_INDEX_INVALID',
  QUERY_INVALID: 'EVIDENCE_INDEX_QUERY_INVALID',
  POLICY_INVALID: 'EVIDENCE_RETENTION_POLICY_INVALID',
});

/** 最多扫多少个文件 / 递归多深：防止误把仓库根目录当证据目录扫爆内存。 */
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_DEPTH = 4;
/** 时钟偏差容忍：证据时间比 now 还新不一定是错误（机器时钟略快），但绝不因此删除。 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 把 ISO 字符串 / Date / 毫秒数字统一成毫秒；不可解析返回 null（调用方据此 fail-closed）。 */
function toMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `now` 允许传函数（默认）或 Date/ISO/毫秒；取不到合法时间就报错，而不是当成 0 导致全部"过期"。 */
function resolveNowMs(now) {
  let raw;
  try {
    raw = typeof now === 'function' ? now() : now;
  } catch (error) {
    throw fail(EVIDENCE_INDEX_CODES.POLICY_INVALID, `now 取值失败：${text(error?.message) || '未知错误'}`);
  }
  const ms = toMs(raw);
  if (ms === null) throw fail(EVIDENCE_INDEX_CODES.POLICY_INVALID, 'now 必须是合法时间（Date/ISO/毫秒数/返回它们的函数）');
  return ms;
}

const readAsText = (raw) => (Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);

function normalizeReadResult(item) {
  if (typeof item === 'string') return { name: item, isDirectory: null };
  return {
    name: text(item?.name),
    isDirectory: typeof item?.isDirectory === 'function' ? item.isDirectory() : null,
  };
}

/**
 * 从一份证据 JSON 里取出索引需要的头字段。
 * 注意：**只保留头**（kind/digest/savedAt/fingerprint/note），不把 payload 塞进索引——
 * DRC 报告的 payload 可以到几十 MB，索引必须保持轻量。
 */
function headerOf(parsed) {
  if (!isPlainObject(parsed)) return { invalid: { reason: 'NOT_OBJECT', detail: '顶层必须是 JSON 对象' } };
  const kind = text(parsed.kind);
  const digest = text(parsed.digest);
  const savedAtMs = toMs(parsed.savedAt);
  const missing = [];
  if (!kind) missing.push('kind');
  if (!digest) missing.push('digest');
  if (savedAtMs === null) missing.push('savedAt');
  if (missing.length) return { invalid: { reason: 'MISSING_FIELDS', detail: `缺少或非法的字段：${missing.join(', ')}`, fields: missing } };
  if (!isPlainObject(parsed.fingerprint)) {
    return { invalid: { reason: 'FINGERPRINT_INVALID', detail: 'fingerprint 必须是对象（证据必须能绑定到具体设计对象）' } };
  }
  return {
    entry: {
      kind,
      digest,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(savedAtMs).toISOString(),
      savedAtMs,
      fingerprint: parsed.fingerprint,
      note: typeof parsed.note === 'string' ? parsed.note : null,
      schemaVersion: Number.isFinite(Number(parsed.schemaVersion)) ? Number(parsed.schemaVersion) : null,
    },
  };
}

/**
 * 扫描证据目录，生成索引。
 *
 * @param {object} options
 * @param {Array<string|URL>} options.dirs 目录（递归）或单个 `.json` 证据文件
 * @param {(path: string) => string|Buffer} [options.readFile] 注入的读文件实现（默认 fs.readFileSync）
 * @param {(path: string, options?: object) => Array} [options.readdir] 注入的列目录实现（默认 fs.readdirSync）
 * @param {() => Date|Date|string|number} [options.now] 生成时间（默认当前时间）
 * @param {number} [options.maxFiles] 文件上限（默认 5000，超出置 `truncated:true`）
 * @param {number} [options.maxDepth] 递归深度上限（默认 4）
 * @returns {{schemaVersion:number, kind:string, generatedAt:string, dirs:string[], complete:boolean, truncated:boolean,
 *   entries:Array<object>, invalid:Array<object>, duplicates:Array<object>, errors:Array<object>,
 *   summary:object}}
 */
export function buildEvidenceIndex({
  dirs = [],
  readFile = readFileSync,
  readdir = readdirSync,
  now = () => new Date(),
  maxFiles = DEFAULT_MAX_FILES,
  maxDepth = DEFAULT_MAX_DEPTH,
} = {}) {
  if (!Array.isArray(dirs) || dirs.length === 0) {
    throw fail(EVIDENCE_INDEX_CODES.DIRS_REQUIRED, '证据索引至少需要一个目录或证据文件路径');
  }
  if (dirs.some((dir) => !text(typeof dir === 'string' ? dir : dir instanceof URL ? dir.pathname : ''))) {
    throw fail(EVIDENCE_INDEX_CODES.DIRS_INVALID, 'dirs 里每一项都必须是非空的目录/文件路径');
  }
  if (typeof readFile !== 'function') throw fail(EVIDENCE_INDEX_CODES.DIRS_INVALID, 'readFile 必须是可注入的读文件函数');
  if (typeof readdir !== 'function') throw fail(EVIDENCE_INDEX_CODES.DIRS_INVALID, 'readdir 必须是可注入的列目录函数');
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw fail(EVIDENCE_INDEX_CODES.DIRS_INVALID, 'maxFiles 必须是正整数');
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw fail(EVIDENCE_INDEX_CODES.DIRS_INVALID, 'maxDepth 必须是非负整数');

  const generatedAt = resolveNowMs(now);
  const rootDirs = dirs.map((dir) => resolve(String(dir instanceof URL ? dir.pathname : dir)));
  const entries = [];
  const invalid = [];
  const duplicates = [];
  const errors = [];
  const byKey = new Map();
  let filesSeen = 0;
  let truncated = false;

  const indexFile = (path) => {
    let raw;
    try {
      raw = readAsText(readFile(path));
    } catch (error) {
      errors.push({ path, code: EVIDENCE_INDEX_CODES.READ_FAILED, reason: 'READ_FAILED', detail: text(error?.message) || '读取失败' });
      return;
    }
    if (typeof raw !== 'string') {
      invalid.push({ path, code: EVIDENCE_INDEX_CODES.CORRUPT, reason: 'NOT_TEXT', detail: '读到的内容不是文本' });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      invalid.push({ path, code: EVIDENCE_INDEX_CODES.CORRUPT, reason: 'PARSE_ERROR', detail: text(error?.message) || '不是合法 JSON' });
      return;
    }
    const header = headerOf(parsed);
    if (header.invalid) {
      invalid.push({ path, code: EVIDENCE_INDEX_CODES.CORRUPT, ...header.invalid });
      return;
    }
    const entry = { path, ...header.entry };
    const key = `${entry.kind}\u0000${entry.digest.toLowerCase()}`;
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      byKey.set(key, entries.length);
      entries.push(entry);
      return;
    }
    // 同一份证据被复制过多份：只索引最新的一条；旧副本进 duplicates，**不自动清理**。
    const existing = entries[existingIndex];
    if (entry.savedAtMs > existing.savedAtMs) {
      duplicates.push({ ...existing, reason: 'DUPLICATE_DIGEST' });
      entries[existingIndex] = entry;
    } else {
      duplicates.push({ ...entry, reason: 'DUPLICATE_DIGEST' });
    }
  };

  const walk = (dir, depth) => {
    if (truncated) return;
    let items;
    try {
      items = readdir(dir, { withFileTypes: true });
    } catch (error) {
      errors.push({
        path: dir,
        code: EVIDENCE_INDEX_CODES.READ_FAILED,
        reason: error?.code === 'ENOENT' ? 'NOT_FOUND' : 'READ_FAILED',
        detail: text(error?.message) || '目录读取失败',
      });
      return;
    }
    if (!Array.isArray(items)) {
      errors.push({ path: dir, code: EVIDENCE_INDEX_CODES.READ_FAILED, reason: 'READ_FAILED', detail: 'readdir 没有返回数组' });
      return;
    }
    const names = items.map(normalizeReadResult);
    for (const item of names.sort((left, right) => left.name.localeCompare(right.name))) {
      if (truncated) return;
      if (!item.name || item.name.startsWith('.')) continue;
      if (filesSeen >= maxFiles) { truncated = true; return; }
      const full = join(dir, item.name);
      const looksLikeJson = /\.json$/i.test(item.name);
      const isDirectory = item.isDirectory === null ? !looksLikeJson : item.isDirectory;
      if (isDirectory) {
        if (depth >= maxDepth) {
          truncated = true;
          errors.push({ path: full, code: EVIDENCE_INDEX_CODES.READ_FAILED, reason: 'DEPTH_LIMIT', detail: `递归深度超过 ${maxDepth}` });
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!looksLikeJson) continue;
      filesSeen += 1;
      indexFile(full);
    }
  };

  for (const rootDir of rootDirs) {
    if (/\.json$/i.test(rootDir)) {
      filesSeen += 1;
      indexFile(rootDir);
    } else {
      walk(rootDir, 0);
    }
  }

  entries.sort((left, right) => (right.savedAtMs - left.savedAtMs) || left.kind.localeCompare(right.kind) || left.digest.localeCompare(right.digest));
  const kinds = {};
  for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  const savedTimes = entries.map((entry) => entry.savedAtMs);

  return {
    schemaVersion: EVIDENCE_INDEX_SCHEMA_VERSION,
    kind: EVIDENCE_INDEX_KIND,
    generatedAt: new Date(generatedAt).toISOString(),
    dirs: rootDirs,
    /** 只有"没有读错误、没有被截断"的索引才算完整；不完整时保留计划必须拒绝落地。 */
    complete: errors.length === 0 && !truncated,
    truncated,
    entries,
    invalid,
    duplicates,
    errors,
    summary: {
      entries: entries.length,
      kinds,
      invalid: invalid.length,
      duplicates: duplicates.length,
      errors: errors.length,
      truncated,
      newestSavedAt: savedTimes.length ? new Date(Math.max(...savedTimes)).toISOString() : null,
      oldestSavedAt: savedTimes.length ? new Date(Math.min(...savedTimes)).toISOString() : null,
    },
  };
}

/**
 * 按 kind（和/或 digest）精确找回证据。
 *
 * - 找不到返回 `null`（"没有"和"坏了"必须分开：坏文件在 index.invalid 里）；
 * - digest 比较忽略大小写、保留原始写法；
 * - 两者都给了就同时匹配；只给 kind 时返回该 kind 最新一条。
 *
 * @param {object} index `buildEvidenceIndex` 的返回值
 * @param {{kind?: string, digest?: string}} query
 */
export function findEvidence(index, { kind = null, digest = null } = {}) {
  if (!isPlainObject(index) || !Array.isArray(index.entries)) {
    throw fail(EVIDENCE_INDEX_CODES.INDEX_INVALID, 'index 必须是 buildEvidenceIndex 的返回值（含 entries 数组）');
  }
  const wantsKind = kind === null || kind === undefined ? null : text(kind);
  const wantsDigest = digest === null || digest === undefined ? null : text(digest);
  if (kind !== null && kind !== undefined && !wantsKind) throw fail(EVIDENCE_INDEX_CODES.QUERY_INVALID, 'kind 必须是非空字符串');
  if (digest !== null && digest !== undefined && !wantsDigest) throw fail(EVIDENCE_INDEX_CODES.QUERY_INVALID, 'digest 必须是非空字符串');
  if (!wantsKind && !wantsDigest) throw fail(EVIDENCE_INDEX_CODES.QUERY_INVALID, 'findEvidence 至少需要 kind 或 digest 之一');
  const lowerDigest = wantsDigest ? wantsDigest.toLowerCase() : null;
  const matches = index.entries.filter((entry) => {
    if (!isPlainObject(entry)) return false;
    if (wantsKind && entry.kind !== wantsKind) return false;
    if (lowerDigest && text(entry.digest).toLowerCase() !== lowerDigest) return false;
    return true;
  });
  if (!matches.length) return null;
  matches.sort((left, right) => (Number(right.savedAtMs) || 0) - (Number(left.savedAtMs) || 0));
  return matches[0];
}

function resolveKeepPerKind(value) {
  if (value === undefined || value === null) return EVIDENCE_RETENTION_DEFAULTS.keepPerKind;
  if (!Number.isInteger(value) || value < 1) {
    throw fail(EVIDENCE_INDEX_CODES.POLICY_INVALID, 'keepPerKind 必须是 >=1 的整数（等于"每类至少保留的条数"，不允许 0）');
  }
  return value;
}

function resolveKeepDays(value) {
  if (value === undefined || value === null) return EVIDENCE_RETENTION_DEFAULTS.keepDays;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw fail(EVIDENCE_INDEX_CODES.POLICY_INVALID, 'keepDays 必须是 >=0 的有限数字（0 表示只保留 keepPerKind 条）');
  }
  return value;
}

const planRecord = (entry, reason) => ({
  kind: entry.kind,
  digest: entry.digest,
  savedAt: entry.savedAt,
  savedAtMs: entry.savedAtMs,
  path: entry.path,
  fingerprint: entry.fingerprint ?? {},
  reason,
});

/**
 * 证据保留计划（**dry-run**）。
 *
 * 判定规则（fail-closed）：
 *   1. 每个 kind 内按 savedAt 倒序，最新 `keepPerKind` 条一定保留；
 *   2. 年龄未超过 `keepDays` 的一定保留；
 *   3. 只有 **既超出条数窗口、又超过天数窗口** 的条目才进入 `prune`；
 *   4. 时间戳缺失/未来 → 保留；重复副本/损坏文件 → 不进入删除候选。
 *
 * `safeToApply` 只有在索引完整且没有被隔离文件时才为 true。它只是给上层/人工的**建议**，
 * 本函数没有任何文件系统写操作，也不可能删除真实文件。
 *
 * @param {object} options
 * @param {object} options.index buildEvidenceIndex 的返回值
 * @param {() => Date|Date|string|number} [options.now]
 * @param {number} [options.keepPerKind] 默认 3
 * @param {number} [options.keepDays] 默认 30
 */
export function planEvidenceRetention({
  index = null,
  now = () => new Date(),
  keepPerKind = EVIDENCE_RETENTION_DEFAULTS.keepPerKind,
  keepDays = EVIDENCE_RETENTION_DEFAULTS.keepDays,
} = {}) {
  if (!isPlainObject(index) || !Array.isArray(index.entries)) {
    throw fail(EVIDENCE_INDEX_CODES.INDEX_INVALID, 'planEvidenceRetention 需要 buildEvidenceIndex 生成的索引（含 entries 数组）');
  }
  const keepCount = resolveKeepPerKind(keepPerKind);
  const days = resolveKeepDays(keepDays);
  const nowMsValue = resolveNowMs(now);
  const ageWindowMs = days * DAY_MS;

  const keep = [];
  const prune = [];
  const unindexed = [];
  const groups = new Map();

  for (const entry of index.entries) {
    if (!isPlainObject(entry) || !text(entry.kind) || !text(entry.digest)) {
      unindexed.push({ path: isPlainObject(entry) ? entry.path ?? null : null, code: EVIDENCE_INDEX_CODES.CORRUPT, reason: 'ENTRY_INVALID', detail: '索引条目缺少 kind/digest' });
      continue;
    }
    // 注意 Number(null) === 0：缺失的时间戳必须先判 null，否则会被当成 1970 年而误删。
    const rawSavedAtMs = entry.savedAtMs;
    const savedAtMs = rawSavedAtMs === null || rawSavedAtMs === undefined ? null : Number(rawSavedAtMs);
    if (savedAtMs === null || !Number.isFinite(savedAtMs)) {
      // 不知道年龄就保留：宁多留一份，不赌"它应该很旧"。
      keep.push(planRecord({ ...entry, savedAtMs: null }, 'UNKNOWN_SAVED_AT'));
      continue;
    }
    if (!groups.has(entry.kind)) groups.set(entry.kind, []);
    groups.get(entry.kind).push({ ...entry, savedAtMs });
  }

  for (const list of groups.values()) {
    list.sort((left, right) => (right.savedAtMs - left.savedAtMs) || String(left.digest).localeCompare(String(right.digest)));
    list.forEach((entry, position) => {
      const ageMs = nowMsValue - entry.savedAtMs;
      if (ageMs < -CLOCK_SKEW_MS) {
        keep.push(planRecord(entry, 'KEPT_FUTURE_SAVED_AT'));
        return;
      }
      if (position < keepCount) {
        keep.push(planRecord(entry, 'KEPT_RECENT_COUNT'));
        return;
      }
      if (ageMs <= ageWindowMs) {
        keep.push(planRecord(entry, 'KEPT_WITHIN_DAYS'));
        return;
      }
      prune.push(planRecord(entry, 'PRUNE_EXPIRED'));
    });
  }

  for (const item of Array.isArray(index.invalid) ? index.invalid : []) {
    unindexed.push({ path: item?.path ?? null, code: item?.code ?? EVIDENCE_INDEX_CODES.CORRUPT, reason: item?.reason ?? 'INVALID', detail: item?.detail ?? null });
  }
  const duplicates = (Array.isArray(index.duplicates) ? index.duplicates : []).map((item) => ({
    kind: item?.kind ?? null,
    digest: item?.digest ?? null,
    path: item?.path ?? null,
    savedAt: item?.savedAt ?? null,
    reason: item?.reason ?? 'DUPLICATE_DIGEST',
  }));

  keep.sort((left, right) => (Number(right.savedAtMs) || 0) - (Number(left.savedAtMs) || 0) || left.kind.localeCompare(right.kind));
  prune.sort((left, right) => (Number(left.savedAtMs) || 0) - (Number(right.savedAtMs) || 0) || left.kind.localeCompare(right.kind));

  const blockedReasons = [];
  if (index.complete !== true) blockedReasons.push('INDEX_INCOMPLETE');
  if (unindexed.length > 0) blockedReasons.push('UNINDEXED_EVIDENCE_PRESENT');

  const reasons = {};
  for (const item of [...keep, ...prune]) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
  if (unindexed.length) reasons.UNINDEXED = unindexed.length;

  return {
    schemaVersion: EVIDENCE_INDEX_SCHEMA_VERSION,
    kind: EVIDENCE_RETENTION_PLAN_KIND,
    generatedAt: new Date(nowMsValue).toISOString(),
    /** 固定为 true：本模块只产出计划，从不删除真实文件。 */
    dryRun: true,
    policy: { keepPerKind: keepCount, keepDays: days },
    keep,
    prune,
    unindexed,
    duplicates,
    blockedReasons,
    /** 索引不完整或被隔离的文件存在时，拒绝把这份计划当可执行结论。 */
    safeToApply: blockedReasons.length === 0,
    reasons,
    summary: {
      indexed: index.entries.length,
      keep: keep.length,
      prune: prune.length,
      unindexed: unindexed.length,
      duplicates: duplicates.length,
      preserved: keep.length + unindexed.length,
    },
    note: 'dry-run：这里只给出建议，绝不删除任何文件；删除必须由上层在人工确认 safeToApply 后另行实现并留审计。',
  };
}
