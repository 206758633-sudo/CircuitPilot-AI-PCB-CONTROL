import { applyErcExemptions, normalizeErcReport, summarizeErcConvergence } from '../erc.mjs';
import { classifyDrcItems, normalizeDrcReport } from '../drc.mjs';
import { createEvidenceEnvelope } from '../evidence-contract.mjs';

/**
 * Rule Runner（W4-02）：把 ERC / DRC 的“原始报告 + 豁免清单”变成**可阻断的证据**。
 *
 * 设计要点：
 *   - 只做归一化/归类，不重新实现规则引擎：复用 `erc.mjs`（ERC 归一化、豁免校验、收敛汇总）
 *     与 `drc.mjs`（DRC 归一化、叶子计数、解释/豁免归类）。规则的真伪由 EDA/既有模块决定；
 *   - 输入是**注入的已获取报告**（由调用方通过 bridge/路由取回），本 agent 不直接访问 EDA；
 *   - 未解释的 DRC 违规、未处理 ERC 错误、无效豁免 → error；未使用豁免 → warning；
 *   - 任一缺失（ERC 或 DRC 未提供）→ `unknown`，绝不按“没报错=通过”处理；
 *   - 输出遵循统一证据契约（`createEvidenceEnvelope`），fail-closed 由契约兜底。
 */

export const RULE_RUNNER_VERSION = '1.0.0';

export const RULE_RUNNER_CODES = Object.freeze({
  INPUT_MISSING: 'RULES_INPUT_MISSING',
  DRC_INVALID: 'RULES_DRC_INVALID',
});

const codedError = (code, message, details = null) => Object.assign(new Error(message), { code, details });
const severityOf = (value) => (value === 'blocking' || value === 'fatal' || value === 'error' ? 'error' : value === 'warning' ? 'warning' : 'info');

export function runRuleChecks({
  erc = null,
  drc = null,
  ercExemptions = [],
  drcExemptions = [],
  pcbUuid = null,
  boardId = null,
  schematicUuid = null,
  projectUuid = null,
  now = () => new Date(),
} = {}) {
  if (!erc && !drc) throw codedError(RULE_RUNNER_CODES.INPUT_MISSING, 'ERC 与 DRC 报告都没有提供，无法形成规则证据');

  const findings = [];
  let ercSummary = null;
  let drcSummary = null;
  let drcDigest = null;

  if (erc) {
    // 已归一化（schemaVersion=1 且有 findings）直接复用；否则按 EDA 原始返回归一化。
    const normalized = erc?.schemaVersion === 1 && Array.isArray(erc.findings) ? erc : normalizeErcReport(erc);
    const withExemptions = applyErcExemptions(normalized, ercExemptions);
    ercSummary = summarizeErcConvergence(withExemptions);
    for (const finding of withExemptions.findings || []) {
      if (finding.exempted) continue;
      const count = finding.aggregate ? Number(finding.count) || 1 : 1;
      findings.push({
        code: `ERC_${String(finding.code || 'UNKNOWN').replace(/^ERC_?/, '') || 'UNKNOWN'}`.slice(0, 80),
        severity: finding.severity === 'warning' ? 'warning' : finding.severity === 'info' ? 'info' : 'error',
        message: `${finding.code || 'ERC'}${finding.object ? ` [${finding.object}]` : ''}：${String(finding.detail || finding.title || '').slice(0, 320)}`,
        ref: finding.object || null,
        count,
        source: 'erc',
      });
    }
    for (const invalid of withExemptions.invalidExemptions || []) {
      findings.push({ code: 'ERC_EXEMPTION_INVALID', severity: 'error', message: `ERC 豁免 #${invalid.index} 无效（缺理由/风险或对象不完整）：${(invalid.problems || []).join('；')}`.slice(0, 400), source: 'erc' });
    }
  }

  if (drc) {
    const normalizedDrc = normalizeDrcReport(drc);
    if (!normalizedDrc.ok) throw codedError(RULE_RUNNER_CODES.DRC_INVALID, normalizedDrc.message || 'DRC 报告结构不可识别');
    drcDigest = normalizedDrc.digest ?? null;
    const classified = classifyDrcItems({ items: normalizedDrc.items, exemptions: drcExemptions, truncated: normalizedDrc.truncated, reportedCount: normalizedDrc.reportedCount });
    drcSummary = {
      raised: normalizedDrc.itemCount,
      unexplained: classified.unexplained.length,
      exempted: classified.exempted.length,
      invalidExemptions: classified.invalidExemptions.length,
      ready: classified.ready === true,
      digest: drcDigest,
    };
    for (const item of classified.unexplained) {
      findings.push({
        code: 'DRC_UNEXPLAINED', severity: 'error',
        message: `DRC 未处理：${item.errorType || '违规'}${item.net ? `（网络 ${item.net}）` : ''}${item.layer ? ` @${item.layer}` : ''} ${String(item.explanation || '').slice(0, 240)}`.slice(0, 400),
        ref: (item.objects || []).map((object) => object.type).filter(Boolean).join('+') || null,
        net: item.net || null,
        layer: item.layer || null,
        source: 'drc',
      });
    }
    for (const finding of classified.findings || []) {
      findings.push({
        code: `DRC_${String(finding.code || 'ERROR').replace(/^DRC_?/, '')}`.slice(0, 80),
        severity: severityOf(finding.severity),
        message: String(finding.message || '').slice(0, 400),
        source: 'drc',
      });
    }
  }

  const errors = findings.filter((finding) => finding.severity === 'error');
  const missing = [];
  if (!erc) missing.push('erc');
  if (!drc) missing.push('drc');
  const verdict = errors.length ? 'blocked' : missing.length ? 'unknown' : 'pass';
  return createEvidenceEnvelope({
    kind: 'rules',
    subject: { type: 'pcb', id: pcbUuid || schematicUuid || projectUuid || 'unknown' },
    fingerprint: { pcbUuid, boardId, schematicUuid, projectUuid, ercDigest: ercSummary?.digest ?? null, drcDigest },
    source: { agent: 'rule-runner', version: RULE_RUNNER_VERSION, readOnly: true },
    verdict,
    findings,
    counts: { erc: ercSummary, drc: drcSummary, errors: errors.length, warnings: findings.filter((finding) => finding.severity === 'warning').length },
    blockedReason: missing.length ? `缺少 ${missing.join('/')} 报告，无法完成规则检查` : (errors.length ? `${errors.length} 条规则错误未处理` : null),
    now,
  });
}
