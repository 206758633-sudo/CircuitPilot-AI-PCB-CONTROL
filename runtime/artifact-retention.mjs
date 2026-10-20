/**
 * B10：制造物保留策略（Gerber/BOM/CPL/STEP/发布包等"造出来就不能乱丢"的文件）。
 *
 * ## 为什么需要它
 *
 * `manufacturing/`、`release/<日期>/`、`deliverables/` 里堆着历次导出的制造物。
 * 它们既是交付物、也是"当时那一版设计到底长什么样"的证据，但磁盘不是无限的。
 * 关键矛盾在于：**"旧"不等于"可以删"**——删掉唯一一份正式 Gerber，事后就无法证明当时下了什么单。
 *
 * 所以这里把"能不能删"拆成两步，职责严格分开：
 *
 *  1. `evaluateRetention({entries,now,policy})`：纯函数，只做裁决，返回
 *     `{keep, prune, disabled, reasons}`。**不碰文件系统。**
 *  2. `planRetention(...)`：把裁决结果整理成可执行计划（`dryRun: true`）。
 *  3. `applyRetention(...)`：只有**显式** `dryRun: false` 且注入了 `remove(path)` 才会真删；
 *     默认 dry-run，宁可什么都不做。
 *
 * ## fail-closed（拿不准就保留）
 *
 * - 没有 policy → 保留策略视为关闭，所有制造物进 `disabled`（**不是**"全部可删"）；
 * - 不在 kind 白名单里的、时间戳缺失的、条目结构不对的 → `disabled`，永不进入 `prune`；
 * - 时间戳比 `now` 还新的（时钟偏差/伪造）→ 保留；
 * - 配了总大小预算但**有任一条目缺 bytes** → 无法证明删除安全，本次不做大小裁剪（整批保留）；
 * - `prune` 条目没有 path 的 → 退回 `disabled`（没有路径就无法安全删除）。
 *
 * 策略形状（都是可选项，但至少要给一个约束才会真的裁剪）：
 *
 * ```js
 * {
 *   enabled?: boolean,        // 显式 false = 关闭保留策略，全部保留
 *   kinds?: string[],         // 允许参与裁剪的 kind 白名单；省略 = 不限 kind
 *   maxAgeDays?: number,      // 超过 N 天 → prune（>0）
 *   maxTotalBytes?: number,   // 保留物总字节预算，按时间从新到旧保留（>0 整数）
 * }
 * ```
 */
export const ARTIFACT_RETENTION_SCHEMA_VERSION = 1;
export const ARTIFACT_RETENTION_KIND = 'artifact-retention-evaluation';
export const ARTIFACT_RETENTION_PLAN_KIND = 'artifact-retention-plan';

export const ARTIFACT_RETENTION_CODES = Object.freeze({
  ENTRIES_INVALID: 'ARTIFACT_RETENTION_ENTRIES_INVALID',
  POLICY_INVALID: 'ARTIFACT_RETENTION_POLICY_INVALID',
  NOW_INVALID: 'ARTIFACT_RETENTION_NOW_INVALID',
  PLAN_INVALID: 'ARTIFACT_RETENTION_PLAN_INVALID',
  OPS_REQUIRED: 'ARTIFACT_RETENTION_APPLY_OPS_REQUIRED',
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** 时钟偏差容忍：比 now 新 5 分钟以内当正常；再新就说明时间戳不可信，只保留不删。 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function toMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `now` 允许函数/Date/ISO/毫秒；取不到合法时间就报错（当成 0 会让所有东西"过期"）。 */
function resolveNowMs(now) {
  let raw;
  try {
    raw = typeof now === 'function' ? now() : now;
  } catch (error) {
    throw fail(ARTIFACT_RETENTION_CODES.NOW_INVALID, `now 取值失败：${text(error?.message) || '未知错误'}`);
  }
  const ms = toMs(raw);
  if (ms === null) throw fail(ARTIFACT_RETENTION_CODES.NOW_INVALID, 'now 必须是合法时间（Date/ISO/毫秒数/返回它们的函数）');
  return ms;
}

function normalizePolicy(policy) {
  if (policy === null || policy === undefined) {
    // 缺策略 = 保留策略未启用：全部保留。这是 fail-closed 的默认，不是"没配就随便删"。
    return { enabled: false, kinds: null, maxAgeDays: null, maxTotalBytes: null };
  }
  if (!isPlainObject(policy)) throw fail(ARTIFACT_RETENTION_CODES.POLICY_INVALID, 'policy 必须是对象');
  if (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') {
    throw fail(ARTIFACT_RETENTION_CODES.POLICY_INVALID, 'policy.enabled 必须是布尔值');
  }
  const enabled = policy.enabled !== false;
  let kinds = null;
  if (policy.kinds !== undefined && policy.kinds !== null) {
    if (!Array.isArray(policy.kinds) || policy.kinds.some((kind) => !text(kind))) {
      throw fail(ARTIFACT_RETENTION_CODES.POLICY_INVALID, 'policy.kinds 必须是非空字符串数组（或省略）');
    }
    kinds = [...new Set(policy.kinds.map((kind) => text(kind)))];
  }
  let maxAgeDays = null;
  if (policy.maxAgeDays !== undefined && policy.maxAgeDays !== null) {
    if (typeof policy.maxAgeDays !== 'number' || !Number.isFinite(policy.maxAgeDays) || policy.maxAgeDays <= 0) {
      throw fail(ARTIFACT_RETENTION_CODES.POLICY_INVALID, 'policy.maxAgeDays 必须是 >0 的有限数字');
    }
    maxAgeDays = policy.maxAgeDays;
  }
  let maxTotalBytes = null;
  if (policy.maxTotalBytes !== undefined && policy.maxTotalBytes !== null) {
    if (!Number.isInteger(policy.maxTotalBytes) || policy.maxTotalBytes <= 0) {
      throw fail(ARTIFACT_RETENTION_CODES.POLICY_INVALID, 'policy.maxTotalBytes 必须是 >0 的整数');
    }
    maxTotalBytes = policy.maxTotalBytes;
  }
  return { enabled, kinds, maxAgeDays, maxTotalBytes };
}

const TIMESTAMP_FIELDS = Object.freeze(['createdAt', 'savedAt', 'modifiedAt', 'mtime', 'timestamp', 'date', 'mtimeMs']);

function timestampOf(entry) {
  for (const field of TIMESTAMP_FIELDS) {
    if (entry[field] === undefined || entry[field] === null) continue;
    const ms = toMs(entry[field]);
    if (ms !== null) return { ms, field };
  }
  return null;
}

const SIZE_FIELDS = Object.freeze(['bytes', 'size', 'byteLength']);

/** 大小必须是 >=0 的有限数；拿不到就是 null（调用方据此判定"无法按大小裁剪"）。 */
function sizeOf(entry) {
  for (const field of SIZE_FIELDS) {
    const value = entry[field];
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function recordOf(item, reason, extra = {}) {
  return {
    kind: item.kind,
    path: item.path,
    bytes: item.bytes,
    savedAt: item.savedAt,
    savedAtMs: item.savedAtMs,
    reason,
    ...extra,
  };
}

const byNewest = (left, right) => (right.savedAtMs - left.savedAtMs) || String(left.path || '').localeCompare(String(right.path || ''));
const byOldest = (left, right) => (left.savedAtMs - right.savedAtMs) || String(left.path || '').localeCompare(String(right.path || ''));

function resultOf({ nowMs, policy, keep, prune, disabled, reasons, totalEntries }) {
  keep.sort(byNewest);
  prune.sort(byOldest);
  const sumBytes = (list) => list.reduce((sum, item) => sum + (Number.isFinite(item.bytes) ? item.bytes : 0), 0);
  const unknownSize = [...keep, ...prune, ...disabled].filter((item) => item.bytes === null || item.bytes === undefined).length;
  return {
    schemaVersion: ARTIFACT_RETENTION_SCHEMA_VERSION,
    kind: ARTIFACT_RETENTION_KIND,
    evaluatedAt: new Date(nowMs).toISOString(),
    policy: {
      enabled: policy.enabled,
      kinds: policy.kinds,
      maxAgeDays: policy.maxAgeDays,
      maxTotalBytes: policy.maxTotalBytes,
    },
    keep,
    prune,
    disabled,
    /** 原因 → 条数（keep/prune/disabled 都统计），给界面做一行摘要用。 */
    reasons,
    summary: {
      entries: totalEntries,
      keep: keep.length,
      prune: prune.length,
      disabled: disabled.length,
      bytesToFree: sumBytes(prune),
      bytesKept: sumBytes(keep),
      unknownSize,
    },
    note: '纯裁决结果，不涉及任何文件系统操作；真正的删除只能由 applyRetention 在 dryRun:false 且注入 remove 后执行。',
  };
}

/**
 * 评估制造物保留策略（纯函数，不碰磁盘）。
 *
 * @param {object} [options]
 * @param {Array<{kind?: string, path?: string, bytes?: number, size?: number, createdAt?: string|Date|number, savedAt?: string|Date|number}>} [options.entries] 制造物条目
 * @param {() => Date|Date|string|number} [options.now] 当前时间
 * @param {object|null} [options.policy] 保留策略（形状见文件头注释）；缺省 = 保留策略关闭
 * @returns {{schemaVersion:number, kind:string, evaluatedAt:string, policy:object,
 *   keep:Array<object>, prune:Array<object>, disabled:Array<object>,
 *   reasons:Record<string, number>, summary:object}}
 */
export function evaluateRetention({ entries = [], now = () => new Date(), policy = null } = {}) {
  if (!Array.isArray(entries)) throw fail(ARTIFACT_RETENTION_CODES.ENTRIES_INVALID, 'entries 必须是数组');
  const nowMs = resolveNowMs(now);
  const normalized = normalizePolicy(policy);
  const reasons = {};
  const bump = (reason) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };

  const keep = [];
  const prune = [];
  const disabled = [];

  // 策略关闭：所有条目进 disabled（=保留，不裁剪）。不把 entries 直接塞进 keep，
  // 是为了让上层能一眼看出"这次根本没有做保留判定"。
  if (!normalized.enabled) {
    for (const entry of entries) {
      const item = isPlainObject(entry)
        ? { kind: text(entry.kind) || null, path: text(entry.path) || null, bytes: sizeOf(entry), savedAt: null, savedAtMs: null }
        : { kind: null, path: null, bytes: null, savedAt: null, savedAtMs: null };
      disabled.push({ ...recordOf(item, 'RETENTION_DISABLED'), detail: '未提供保留策略（或 enabled:false）：全部保留' });
      bump('RETENTION_DISABLED');
    }
    return resultOf({ nowMs, policy: normalized, keep, prune, disabled, reasons, totalEntries: entries.length });
  }

  const eligible = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      disabled.push({ kind: null, path: null, bytes: null, savedAt: null, savedAtMs: null, reason: 'ENTRY_INVALID', detail: '条目不是对象' });
      bump('ENTRY_INVALID');
      continue;
    }
    const kind = text(entry.kind);
    const path = text(entry.path);
    const bytes = sizeOf(entry);
    if (!kind) {
      disabled.push({ kind: null, path: path || null, bytes, savedAt: null, savedAtMs: null, reason: 'ENTRY_INVALID', detail: '条目缺 kind，无法判断保留规则' });
      bump('ENTRY_INVALID');
      continue;
    }
    if (normalized.kinds !== null && !normalized.kinds.includes(kind)) {
      disabled.push({ kind, path: path || null, bytes, savedAt: null, savedAtMs: null, reason: 'KIND_NOT_IN_POLICY', detail: `kind=${kind} 不在策略白名单内` });
      bump('KIND_NOT_IN_POLICY');
      continue;
    }
    const stamp = timestampOf(entry);
    if (!stamp) {
      disabled.push({ kind, path: path || null, bytes, savedAt: null, savedAtMs: null, reason: 'UNKNOWN_TIMESTAMP', detail: '没有可解析的时间字段：无法判断新旧，保留' });
      bump('UNKNOWN_TIMESTAMP');
      continue;
    }
    eligible.push({ kind, path, bytes, savedAt: new Date(stamp.ms).toISOString(), savedAtMs: stamp.ms, timestampField: stamp.field });
  }

  const ageLimitMs = normalized.maxAgeDays === null ? null : normalized.maxAgeDays * DAY_MS;
  const sizeCandidates = [];

  for (const item of eligible) {
    if (item.savedAtMs > nowMs + CLOCK_SKEW_MS) {
      keep.push(recordOf(item, 'KEPT_FUTURE_TIMESTAMP'));
      bump('KEPT_FUTURE_TIMESTAMP');
      continue;
    }
    if (ageLimitMs !== null && nowMs - item.savedAtMs > ageLimitMs) {
      // 过期是明确结论；但如果连 path 都没有，删不掉，退回 disabled（fail-closed）。
      if (!item.path) {
        disabled.push({ ...recordOf(item, 'PATH_MISSING'), detail: '超过保留天数但缺少 path，无法删除' });
        bump('PATH_MISSING');
        continue;
      }
      prune.push(recordOf(item, 'PRUNE_EXPIRED'));
      bump('PRUNE_EXPIRED');
      continue;
    }
    sizeCandidates.push(item);
  }

  if (normalized.maxTotalBytes === null) {
    for (const item of sizeCandidates) {
      keep.push(recordOf(item, 'KEPT_NO_SIZE_LIMIT'));
      bump('KEPT_NO_SIZE_LIMIT');
    }
  } else {
    const unknownSize = sizeCandidates.filter((item) => item.bytes === null);
    if (unknownSize.length > 0) {
      // 有预算但存在未知大小：无法证明"删了就不超预算"，整批保留（fail-closed）。
      for (const item of sizeCandidates) {
        keep.push(recordOf(item, 'KEPT_SIZE_QUOTA_UNVERIFIABLE'));
        bump('KEPT_SIZE_QUOTA_UNVERIFIABLE');
      }
      reasons.SIZE_QUOTA_UNVERIFIABLE = unknownSize.length;
    } else {
      const sorted = [...sizeCandidates].sort(byNewest);
      let usedBytes = 0;
      for (const item of sorted) {
        if (usedBytes + item.bytes <= normalized.maxTotalBytes) {
          usedBytes += item.bytes;
          keep.push(recordOf(item, 'KEPT_WITHIN_SIZE_QUOTA'));
          bump('KEPT_WITHIN_SIZE_QUOTA');
          continue;
        }
        if (!item.path) {
          disabled.push({ ...recordOf(item, 'PATH_MISSING'), detail: '超出大小预算但缺少 path，无法删除' });
          bump('PATH_MISSING');
          continue;
        }
        prune.push(recordOf(item, 'PRUNE_OVER_SIZE_QUOTA'));
        bump('PRUNE_OVER_SIZE_QUOTA');
      }
    }
  }

  return resultOf({ nowMs, policy: normalized, keep, prune, disabled, reasons, totalEntries: entries.length });
}

/**
 * 把裁决结果整理成 dry-run 计划（**不执行任何删除**）。
 *
 * @param {object} [options]
 * @param {Array<object>} [options.entries]
 * @param {() => Date|Date|string|number} [options.now]
 * @param {object|null} [options.policy]
 */
export function planRetention({ entries = [], now = () => new Date(), policy = null } = {}) {
  const evaluation = evaluateRetention({ entries, now, policy });
  const targets = evaluation.prune.map((item) => ({
    kind: item.kind,
    path: item.path,
    bytes: item.bytes,
    savedAt: item.savedAt,
    reason: item.reason,
  }));
  return {
    schemaVersion: ARTIFACT_RETENTION_SCHEMA_VERSION,
    kind: ARTIFACT_RETENTION_PLAN_KIND,
    generatedAt: evaluation.evaluatedAt,
    /** 固定为 true：planRetention 只产出计划。 */
    dryRun: true,
    policy: evaluation.policy,
    keep: evaluation.keep,
    prune: evaluation.prune,
    disabled: evaluation.disabled,
    reasons: evaluation.reasons,
    /** 真正会被删除的目标（path 非空）。 */
    targets,
    /** 构造上 targets 的 path 都非空；保留该字段供上层在展示前再断言一次。 */
    safeToApply: targets.every((target) => typeof target.path === 'string' && target.path.length > 0),
    summary: {
      ...evaluation.summary,
      targets: targets.length,
      bytesToFree: targets.reduce((sum, target) => sum + (Number.isFinite(target.bytes) ? target.bytes : 0), 0),
    },
    note: 'dry-run：只给出计划；真正删除必须调用 applyRetention 且显式 dryRun:false 并注入 remove(path)。',
  };
}

/**
 * 执行保留计划。
 *
 * 默认 `dryRun: true`，返回"本来会删什么"但不碰磁盘；
 * 只有调用方显式传 `dryRun: false` **并且**注入 `remove(path)`（支持同步/异步）才真正删除。
 * 单个删除失败不中断整批，失败进 `failed` 并如实返回（不伪装成成功）。
 *
 * @param {object} [options]
 * @param {object|null} [options.plan] planRetention/evaluateRetention 的结果；缺省时按 entries+policy 现场计算
 * @param {Array<object>} [options.entries] 未给 plan 时使用
 * @param {() => Date|Date|string|number} [options.now]
 * @param {object|null} [options.policy]
 * @param {boolean} [options.dryRun] 默认 true；只有严格 false 才删除
 * @param {(path: string) => unknown} [options.remove] 注入的删除操作（如 fs.unlinkSync / fs.promises.rm）
 */
export async function applyRetention({ plan = null, entries = [], now = () => new Date(), policy = null, dryRun = true, remove = null } = {}) {
  const evaluated = plan === null || plan === undefined
    ? planRetention({ entries, now, policy })
    : plan;
  if (!isPlainObject(evaluated) || !Array.isArray(evaluated.prune)) {
    throw fail(ARTIFACT_RETENTION_CODES.PLAN_INVALID, 'plan 必须是 planRetention/evaluateRetention 的返回值（含 prune 数组）');
  }

  if (dryRun !== false) {
    return {
      dryRun: true,
      applied: [],
      skipped: evaluated.prune.map((item) => ({ path: item?.path ?? null, reason: 'DRY_RUN' })),
      failed: [],
      removedBytes: 0,
      message: 'dry-run：未删除任何文件。真正删除需要显式 dryRun:false 且注入 remove(path)。',
    };
  }

  if (typeof remove !== 'function') {
    // 没注入删除操作就拒绝执行：绝不偷偷用默认 fs 删东西。
    throw fail(ARTIFACT_RETENTION_CODES.OPS_REQUIRED, 'applyRetention 真正执行删除时必须注入 remove(path) 操作（默认永远 dry-run）');
  }

  const applied = [];
  const skipped = [];
  const failed = [];
  const seen = new Set();
  for (const item of evaluated.prune) {
    const path = text(item?.path);
    if (!path) {
      failed.push({ path: item?.path ?? null, reason: 'PATH_MISSING', detail: '缺少 path，跳过删除' });
      continue;
    }
    if (seen.has(path)) {
      skipped.push({ path, reason: 'DUPLICATE_TARGET' });
      continue;
    }
    seen.add(path);
    try {
      await remove(path);
      applied.push({ path, kind: item?.kind ?? null, bytes: Number.isFinite(item?.bytes) ? item.bytes : null, reason: item?.reason ?? null });
    } catch (error) {
      failed.push({ path, reason: 'REMOVE_FAILED', code: text(error?.code) || null, detail: text(error?.message) || '删除失败' });
    }
  }

  return {
    dryRun: false,
    applied,
    skipped,
    failed,
    removedBytes: applied.reduce((sum, item) => sum + (Number.isFinite(item.bytes) ? item.bytes : 0), 0),
    message: failed.length > 0
      ? `已删除 ${applied.length} 个制造物，${failed.length} 个失败（见 failed，未重试）`
      : `已删除 ${applied.length} 个制造物`,
  };
}
