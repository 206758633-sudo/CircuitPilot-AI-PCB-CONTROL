/**
 * Field Loop（W4-04）：样机/产测问题 → 结构化问题单 → 回归用例 → 知识库失败条目。
 *
 * 规则：
 *   - 没有根因的问题单标记 `needsInvestigation`，不强行生成“以为知道原因”的回归用例；
 *   - 回归用例必须带期望 verdict 与必须出现的 finding codes，才能被后续自动校验；
 *   - 写入知识库的是 failure 类候选条目，仍走 review，不算权威结论。
 */
export const FIELD_LOOP_CODES = Object.freeze({ INVALID: 'FIELD_LOOP_INVALID' });
const invalid = (message, details = null) => Object.assign(new Error(message), { code: FIELD_LOOP_CODES.INVALID, details });

export function createFieldIssue({ issueId, boardId = null, pcbUuid = null, symptom, rootCause = null, severity = 'error', evidence = [], now = () => new Date() } = {}) {
  if (!issueId || !String(issueId).trim()) throw invalid('问题单需要 issueId');
  if (!symptom || !String(symptom).trim()) throw invalid('问题单需要 symptom');
  if (!['error', 'warning', 'info'].includes(severity)) throw invalid('severity 只能是 error/warning/info');
  return {
    schemaVersion: 1, kind: 'field-issue', issueId: String(issueId).trim(), boardId, pcbUuid,
    symptom: String(symptom).trim(), rootCause: rootCause ? String(rootCause).trim() : null,
    severity, evidence: Array.isArray(evidence) ? evidence.slice(0, 50) : [],
    needsInvestigation: !rootCause, createdAt: now().toISOString(),
  };
}

export function buildRegressionCase(issue, { expectedCodes = [], fixture = null } = {}) {
  if (!issue || issue.kind !== 'field-issue') throw invalid('需要 createFieldIssue 生成的问题单');
  if (!Array.isArray(expectedCodes) || !expectedCodes.length) throw invalid('回归用例需要至少 1 个期望 finding code');
  return {
    schemaVersion: 1, kind: 'regression-case', caseId: `reg-${issue.issueId}`,
    sourceIssue: issue.issueId, boardId: issue.boardId, pcbUuid: issue.pcbUuid,
    needsInvestigation: issue.needsInvestigation,
    fixture, expected: { verdict: 'blocked', codes: [...new Set(expectedCodes)] },
  };
}

export async function submitFieldIssue({ issue, evidenceStore = null, knowledgeStore = null, expectedCodes = [], fixture = null } = {}) {
  if (!issue || issue.kind !== 'field-issue') throw invalid('需要 createFieldIssue 生成的问题单');
  if (!issue.rootCause) throw invalid('缺少根因，不能生成回归用例；请先调查（needsInvestigation=true）');
  const regression = buildRegressionCase(issue, { expectedCodes, fixture });
  let evidencePath = null;
  let knowledgeId = null;
  if (evidenceStore) {
    const entry = evidenceStore.save({ kind: 'field-issue', payload: { issue, regression }, fingerprint: { issueId: issue.issueId, pcbUuid: issue.pcbUuid }, note: 'W4-04 样机回归问题单' });
    evidencePath = entry.path;
  }
  if (knowledgeStore) {
    const saved = knowledgeStore.save({
      kind: 'failure',
      title: `失败模式：${issue.symptom.slice(0, 80)}`,
      payload: { failureId: issue.issueId, symptom: issue.symptom, rootCause: issue.rootCause, expectedCodes: regression.expected.codes, boardId: issue.boardId, pcbUuid: issue.pcbUuid },
      provenance: { source: 'field-loop', version: '1.0.0', fetchedAt: issue.createdAt, collector: 'field-loop' },
      trust: 'reference',
      reviewState: 'candidate',
    });
    knowledgeId = saved.entry.id;
  }
  return { issue, regression, evidencePath, knowledgeId };
}
