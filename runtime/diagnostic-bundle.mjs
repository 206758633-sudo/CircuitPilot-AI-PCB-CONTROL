/**
 * H5：可定位一次失败的诊断包（只读、脱敏、可复现）。
 *
 * 设计取舍：
 *  - 诊断包不是"把内存全倒出来"：只收集定位失败真正需要的字段（版本/平台/指纹/证据索引/
 *    追溯计数/自动化 journal 统计/最近错误），并且每段都有硬上限，避免把用户工程数据带出去；
 *  - 复用 `redactSecrets` 做整体脱敏：token/API Key/邮箱/绝对路径前缀一律不出现；
 *  - `bundleHash` 覆盖除自身与时间戳外的内容：同一状态两次生成的 hash 一致，便于确认"补发的
 *    是同一份诊断包"；
 *  - 拿不到某段数据时写 `null` + `reason`，**不伪造空对象**（否则会被误读成"没有失败/没有证据"）。
 *
 * 本模块不读磁盘、不发网络请求：调用方把已收集的数据传进来，便于单测与 HTTP 复用。
 */
import { createHash } from 'node:crypto';
import { redactSecrets } from './log-redaction.mjs';

export const DIAGNOSTIC_BUNDLE_KIND = 'circuitpilot-diagnostic-bundle';
export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1;
export const DIAGNOSTIC_BUNDLE_CODES = { INVALID: 'DIAGNOSTIC_BUNDLE_INVALID' };

/** 每段的硬上限：诊断包再"有用"也不能变成数据导出。 */
export const BUNDLE_LIMITS = Object.freeze({
  evidenceKinds: 30,
  evidenceEntriesPerKind: 5,
  traceVersions: 10,
  traceChanges: 20,
  traceAudit: 20,
  recentErrors: 20,
  journalRuns: 10,
  journalEntries: 20,
  string: 400,
});

const text = (value, limit = BUNDLE_LIMITS.string) => (typeof value === 'string' ? value.slice(0, limit) : null);
const list = (value) => (Array.isArray(value) ? value : []);
const bounded = (value, limit) => list(value).slice(0, limit);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function summarizeEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return { available: false, reason: '调用方未提供证据索引' };
  if (evidence.available === false) return { available: false, reason: evidence.reason || '证据索引不可用' };
  const entries = list(evidence.entries ?? evidence.files);
  const byKind = {};
  for (const entry of entries) {
    const kind = text(entry?.kind, 80);
    if (!kind) continue;
    byKind[kind] = byKind[kind] || [];
    if (byKind[kind].length < BUNDLE_LIMITS.evidenceEntriesPerKind) {
      byKind[kind].push({ digest: text(entry?.digest, 128), file: text(entry?.relativePath ?? entry?.path, 200), modifiedAt: text(entry?.modifiedAt ?? entry?.at, 40) });
    }
  }
  const kinds = Object.keys(byKind).sort().slice(0, BUNDLE_LIMITS.evidenceKinds);
  return {
    available: true,
    complete: evidence.complete !== false,
    total: entries.length,
    kinds: kinds.map((kind) => ({ kind, count: byKind[kind].length, samples: byKind[kind] })),
    errors: bounded(evidence.errors, 10).map((item) => text(item, 200)),
    invalid: bounded(evidence.invalid, 10).map((item) => text(item, 200)),
  };
}

function summarizeTrace(trace) {
  if (!trace || typeof trace !== 'object') return { available: false, reason: '调用方未提供追溯状态' };
  if (trace.available === false) return { available: false, reason: trace.reason || '追溯状态不可用' };
  const state = trace.state ?? trace;
  const versions = bounded(state.versions, BUNDLE_LIMITS.traceVersions).map((item) => ({ id: text(item?.id, 80), label: text(item?.label, 120), at: text(item?.at, 40) }));
  const changes = bounded(state.changes, BUNDLE_LIMITS.traceChanges).map((item) => ({ id: text(item?.id, 80), at: text(item?.at, 40), summary: text(item?.summary ?? item?.title, 160) }));
  const audit = bounded(state.audit, BUNDLE_LIMITS.traceAudit).map((item) => ({ id: text(item?.id, 80), at: text(item?.at, 40), action: text(item?.action, 120) }));
  return {
    available: true,
    savedAt: text(trace.savedAt, 40),
    counts: { versions: list(state.versions).length, changes: list(state.changes).length, audit: list(state.audit).length },
    truncated: Boolean(trace.truncated?.versions || trace.truncated?.changes || trace.truncated?.audit),
    versions, changes, audit,
  };
}

function summarizeJournal(journal) {
  if (!journal || typeof journal !== 'object') return { available: false, reason: '调用方未提供自动化 journal 摘要' };
  return {
    available: true,
    runs: bounded(journal.runs, BUNDLE_LIMITS.journalRuns).map((run) => ({ runId: text(run?.runId, 80), recipeId: text(run?.recipeId, 80), status: text(run?.status, 40), at: text(run?.at, 40), entries: Number(run?.entries) || 0 })),
    chainOk: journal.chainOk && typeof journal.chainOk === 'object'
      ? { ok: journal.chainOk.ok === true, brokenAt: journal.chainOk.brokenAt ?? null, entries: Number(journal.chainOk.entries) || 0, lastHash: text(journal.chainOk.lastHash, 64) }
      : (typeof journal.chainOk === 'boolean' ? journal.chainOk : null),
    lastEntries: bounded(journal.lastEntries, BUNDLE_LIMITS.journalEntries).map((entry) => ({ at: text(entry?.at, 40), step: text(entry?.step, 80), status: text(entry?.status, 40), hash: text(entry?.hash, 64) })),
  };
}

/**
 * 组装诊断包。
 * @param {object} input
 * @param {string} input.version 运行时版本（必填）
 * @param {object|null} input.diagnostics systemDiagnostics() 结果
 * @param {object|null} input.evidence `buildEvidenceIndex()` 结果
 * @param {object|null} input.trace `createTraceStateStore().load()` 结果
 * @param {object|null} input.journal 自动化 journal 摘要
 * @param {Array} input.recentErrors 最近的错误 {code,message,at}
 * @param {string} [input.now] ISO 时间
 */
export function buildDiagnosticBundle({ version, diagnostics = null, evidence = null, trace = null, journal = null, recentErrors = [], runtime = {}, now = new Date().toISOString() } = {}) {
  if (!version || typeof version !== 'string') throw Object.assign(new Error('诊断包缺少运行时版本：拒绝生成无法复现的包'), { code: DIAGNOSTIC_BUNDLE_CODES.INVALID });
  if (!Array.isArray(recentErrors)) throw Object.assign(new Error('recentErrors 必须是数组'), { code: DIAGNOSTIC_BUNDLE_CODES.INVALID });

  const body = redactSecrets({
    kind: DIAGNOSTIC_BUNDLE_KIND,
    schemaVersion: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    generatedAt: text(now, 40),
    runtime: {
      version: text(version, 80),
      node: text(runtime.node ?? process.version, 40),
      platform: text(runtime.platform ?? process.platform, 40),
      arch: text(runtime.arch ?? process.arch, 20),
      // 不收集工作目录绝对路径：只报"有无 EDA 状态目录"这类布尔事实。
      stateDirPresent: runtime.stateDirPresent ?? null,
    },
    diagnostics: diagnostics ? redactSecrets(diagnostics) : { available: false, reason: '未提供本机诊断' },
    evidence: summarizeEvidence(evidence),
    trace: summarizeTrace(trace),
    journal: summarizeJournal(journal),
    recentErrors: bounded(recentErrors, BUNDLE_LIMITS.recentErrors).map((error) => ({
      at: text(error?.at, 40),
      code: text(error?.code, 80),
      message: text(error?.message, BUNDLE_LIMITS.string),
      operation: text(error?.operation, 120),
    })),
    redaction: { applied: true, note: 'token/API Key/邮箱/用户目录路径已脱敏；诊断包不含工程文件内容' },
  });

  const digestInput = { ...body, generatedAt: undefined };
  body.bundleHash = createHash('sha256').update(stable(digestInput)).digest('hex');
  return body;
}
