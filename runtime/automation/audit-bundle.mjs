/**
 * E11：写步骤安全审计包。
 *
 * 目标：把"这次运行里每个写步骤"的证据收成一个可核对的包——before/after 截图摘要（sha256/bytes/kind/path）、
 * 读回摘要（stateDigest）、使用的批准 id 与目标指纹、哈希链完整性。不重新执行任何动作、不读 EDA。
 *
 * fail-closed 取向：
 *   - journal 不存在/不是 run 记录 → AUTOMATION_RUN_NOT_FOUND（404）；
 *   - 链断/被改 → ok:false + brokenAt（不假装完整）；
 *   - 写步骤缺 before/after 证据 → warning（EVIDENCE_MISSING），并把缺口暴露给调用方；
 *   - journal 里的 evidence 记录只含摘要字段；若发现 base64 字段，视为异常并告警（不应落盘）。
 */
import { verifyChain } from './journal.mjs';

export const AUDIT_BUNDLE_CODES = Object.freeze({
  RUN_NOT_FOUND: 'AUTOMATION_RUN_NOT_FOUND',
  JOURNAL_INVALID: 'AUTOMATION_AUDIT_BUNDLE_INVALID',
});

const text = (value) => String(value ?? '').trim();

/** 从证据阶段记录里提取摘要（只允许摘要字段，发现 base64 就告警）。 */
function evidenceSummaryOf(entry) {
  const summary = {
    ok: entry?.ok !== false,
    sha256: typeof entry?.sha256 === 'string' ? entry.sha256 : null,
    bytes: Number.isFinite(entry?.bytes) ? entry.bytes : null,
    kind: typeof entry?.kind === 'string' ? entry.kind : null,
    path: typeof entry?.path === 'string' ? entry.path : null,
    fallbackFrom: typeof entry?.fallbackFrom === 'string' ? entry.fallbackFrom : null,
    error: typeof entry?.error === 'string' ? entry.error : null,
    at: typeof entry?.at === 'string' ? entry.at : null,
  };
  const rawBase64Leak = typeof entry?.base64 === 'string' && entry.base64.length > 0;
  return { summary, rawBase64Leak };
}

/**
 * 构造一次运行的审计包。
 * @param {Array<object>} entries journal 记录（按 seq 升序）
 * @param {object} options
 */
export function buildRunAuditBundle(entries, { runId, writeStepIds = [], recipeId = null } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw Object.assign(new Error(`审计记录不存在（不是 run 记录）：${runId || 'unknown'}`), { code: AUDIT_BUNDLE_CODES.RUN_NOT_FOUND, status: 404 });
  }
  const first = entries[0];
  if (first?.phase !== 'run.start' || !text(first?.recipeId)) {
    throw Object.assign(new Error(`审计记录不是一次运行（首条不是 run.start）：${runId || 'unknown'}`), { code: AUDIT_BUNDLE_CODES.RUN_NOT_FOUND, status: 404 });
  }
  const chain = verifyChain(entries);
  const warnings = [];
  if (chain.ok !== true) {
    warnings.push({
      code: 'CHAIN_BROKEN',
      message: `哈希链在 ${chain.brokenAt === null ? '未知位置' : `第 ${chain.brokenAt + 1} 条`} 断开：${chain.message}`,
    });
  }

  const run = entries[0];
  const approvalRecord = entries.find((entry) => entry.phase === 'run.start.approvals') || null;
  const approvalIds = Array.isArray(approvalRecord?.approvalIds) ? approvalRecord.approvalIds : [];
  const approvalFingerprint = text(approvalRecord?.approvalFingerprint) || null;

  const steps = new Map();
  const ensureStep = (stepId, index = null, title = null) => {
    const id = stepId || `step-${index ?? steps.size}`;
    if (!steps.has(id)) {
      steps.set(id, {
        stepId: id,
        stepIndex: Number.isInteger(index) ? index : null,
        title: title || null,
        startedAt: null,
        finishedAt: null,
        attempts: [],
        readbacks: [],
        evidence: { before: null, after: null },
        phase: null,
        ok: null,
        approvalIds: [],
      });
    }
    const current = steps.get(id);
    if (current.stepIndex === null && Number.isInteger(index)) current.stepIndex = index;
    if (!current.title && title) current.title = title;
    return current;
  };

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const step = entry.stepId ? ensureStep(entry.stepId, entry.stepIndex, entry.title) : null;
    switch (entry.phase) {
      case 'step.start':
        step.startedAt = entry.at || null;
        step.phase = 'started';
        if (entry.kind) step.kind = entry.kind;
        if (entry.action) step.action = entry.action;
        if (entry.approval) step.approvalScope = entry.approval;
        // 写步骤可由 journal 自身推断（step.start 记录 approval 作用域），不依赖当前注册表。
        if (typeof entry.approval === 'string' && ['write', 'destructive', 'release'].includes(entry.approval)) step.isWrite = true;
        break;
      case 'attempt': {
        const attempt = { at: entry.at || null, strategy: entry.strategy || null, ok: entry.ok ?? null, error: entry.error?.code || entry.error || null };
        step.attempts.push(attempt);
        break;
      }
      case 'step.evidence.before': {
        const { summary, rawBase64Leak } = evidenceSummaryOf(entry);
        step.evidence.before = summary;
        if (rawBase64Leak) warnings.push({ code: 'EVIDENCE_BASE64_LEAK', message: `步骤 ${step.stepId} 的 before 证据里出现了 base64 字段：证据不应把原始截图写进 journal` });
        if (summary.ok === false) warnings.push({ code: 'EVIDENCE_CAPTURE_FAILED', message: `步骤 ${step.stepId} 的 before 截图失败：${summary.error || '未给出原因'}` });
        break;
      }
      case 'step.evidence.after': {
        const { summary, rawBase64Leak } = evidenceSummaryOf(entry);
        step.evidence.after = summary;
        if (rawBase64Leak) warnings.push({ code: 'EVIDENCE_BASE64_LEAK', message: `步骤 ${step.stepId} 的 after 证据里出现了 base64 字段：证据不应把原始截图写进 journal` });
        if (summary.ok === false) warnings.push({ code: 'EVIDENCE_CAPTURE_FAILED', message: `步骤 ${step.stepId} 的 after 截图失败：${summary.error || '未给出原因'}` });
        break;
      }
      case 'readback':
        step.readbacks.push({ at: entry.at || null, attempt: entry.attempt ?? null, strategy: entry.strategy || null, ok: entry.ok === true, stateDigest: entry.stateDigest || null, reason: entry.reason || null });
        break;
      case 'step.verified':
        step.finishedAt = entry.at || null;
        step.phase = 'verified';
        step.ok = true;
        break;
      case 'step.failed':
        step.finishedAt = entry.at || null;
        step.phase = 'failed';
        step.ok = false;
        step.error = entry.error || entry.reason || null;
        break;
      case 'step.paused':
        step.finishedAt = entry.at || null;
        step.phase = 'paused';
        step.ok = null;
        break;
      default:
        break;
    }
  }

  // 写步骤证据缺口：显式列出来，不把"没有证据"当成通过。
  const writeSet = new Set((Array.isArray(writeStepIds) ? writeStepIds : []).map((id) => text(id)).filter(Boolean));
  for (const step of steps.values()) if (step.isWrite) writeSet.add(step.stepId);
  const stepList = [...steps.values()].sort((left, right) => (left.stepIndex ?? 999) - (right.stepIndex ?? 999));
  for (const step of stepList) {
    const isWrite = writeSet.has(step.stepId);
    if (!isWrite) continue;
    if (!step.evidence.before) warnings.push({ code: 'EVIDENCE_MISSING', message: `写步骤 ${step.stepId} 缺 before 截图证据` });
    if (!step.evidence.after) warnings.push({ code: 'EVIDENCE_MISSING', message: `写步骤 ${step.stepId} 缺 after 截图证据（可能未验证通过或未声明 screenshot 证据）` });
    if (!step.readbacks.some((item) => item.ok === true)) warnings.push({ code: 'READBACK_MISSING', message: `写步骤 ${step.stepId} 没有成功的读回记录` });
  }

  const verifications = entries.filter((entry) => entry.phase === 'step.verified').length;
  const failures = entries.filter((entry) => entry.phase === 'step.failed').length;
  const writeSteps = stepList.filter((step) => writeSet.has(step.stepId));
  const evidenceComplete = writeSteps.every((step) => step.evidence.before && step.evidence.after && step.readbacks.some((item) => item.ok === true));
  return {
    ok: chain.ok === true,
    runId: text(run.runId) || runId,
    recipeId: text(run.recipeId) || recipeId,
    recipeVersion: run.recipeVersion ?? null,
    generatedAt: new Date().toISOString(),
    chain: { ok: chain.ok === true, entries: entries.length, lastHash: chain.ok ? chain.lastHash : null, brokenAt: chain.ok ? null : (chain.brokenAt ?? null), message: chain.ok ? null : chain.message },
    approvals: {
      required: Array.isArray(approvalRecord?.requiredApprovals) ? approvalRecord.requiredApprovals : [],
      granted: approvalRecord?.approvals && typeof approvalRecord.approvals === 'object' ? approvalRecord.approvals : {},
      // 操作人身份由"本地会话 + 签发时目标指纹"表达；批准 id 用于事后对账，不是独立账号签名。
      operatorBinding: { mode: 'local-session-fingerprint', fingerprint: approvalFingerprint, note: '批准在服务端本地会话签发，绑定目标窗口/工程/文档指纹；无独立第三方签名' },
      approvalIds,
    },
    steps: stepList,
    writeSteps: writeSteps.map((step) => ({ stepId: step.stepId, evidence: step.evidence, readbacks: step.readbacks })),
    summary: { steps: stepList.length, writeSteps: writeSteps.length, verifications, failures, evidenceComplete },
    warnings,
  };
}
