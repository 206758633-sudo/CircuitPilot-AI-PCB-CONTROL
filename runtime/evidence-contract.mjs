import { createHash } from 'node:crypto';

/**
 * 统一证据契约（W2-02）：所有 agent / 门禁 / 知识库产出的证据都必须过这里。
 *
 * 为什么需要统一契约：
 *   - 每个 agent 自己定字段，门禁就没法“按证据判放行”，只能靠人肉看；
 *   - 更危险的是“通过”可以是空证据：没有 findings 也被当合格。
 * 这里用一条 fail-closed 规则堵住：
 *   1. `verdict='pass'` 时不允许存在 severity='error' 的 finding；
 *   2. `verdict='blocked'` 必须有 error finding 或明确原因；
 *   3. 证据必须绑定 `fingerprint`（pcbUuid/boardId/digest…至少一个非空值）；
 *   4. agent 证据必须声明 `source.readOnly === true`（生成方不得写回）。
 * 门禁 `evaluateGate()` 对“缺证据/unknown”一律不给 pass。
 */

export const EVIDENCE_ENVELOPE_VERSION = 1;
export const EVIDENCE_VERDICTS = Object.freeze(['pass', 'blocked', 'unknown', 'advisory']);
export const EVIDENCE_SEVERITIES = Object.freeze(['error', 'warning', 'info']);
export const EVIDENCE_SUBJECT_TYPES = Object.freeze(['project', 'board', 'pcb', 'schematic', 'part', 'spec', 'library']);

export const EVIDENCE_CONTRACT_CODES = Object.freeze({
  INVALID: 'EVIDENCE_CONTRACT_INVALID',
  AGENT_NOT_READONLY: 'EVIDENCE_AGENT_NOT_READONLY',
  PASS_WITH_ERRORS: 'EVIDENCE_PASS_WITH_ERRORS',
  BLOCKED_WITHOUT_REASON: 'EVIDENCE_BLOCKED_WITHOUT_REASON',
  GATE_MISSING: 'EVIDENCE_GATE_MISSING',
});

const KIND_RE = /^[a-z][a-z0-9-]+$/;
const CODE_RE = /^[A-Z][A-Z0-9_]+$/;

const invalid = (message, details = null) => Object.assign(new Error(message), { code: EVIDENCE_CONTRACT_CODES.INVALID, details });
const digestOf = (value) => createHash('sha256').update(canonical(value)).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 校验并返回规范化证据信封（不修改输入对象）。 */
export function assertEvidenceEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw invalid('证据信封必须是对象');
  if (envelope.schemaVersion !== EVIDENCE_ENVELOPE_VERSION) throw invalid(`不支持的证据 schemaVersion：${envelope.schemaVersion}`);
  if (typeof envelope.kind !== 'string' || !KIND_RE.test(envelope.kind)) throw invalid('kind 必须是小写连字符标识');
  const subject = envelope.subject;
  if (!subject || typeof subject !== 'object' || typeof subject.id !== 'string' || !subject.id.trim()) throw invalid('subject.id 不能为空');
  if (!EVIDENCE_SUBJECT_TYPES.includes(subject.type)) throw invalid(`未知 subject.type：${subject.type}`);
  const fingerprint = envelope.fingerprint;
  if (!fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)) throw invalid('fingerprint 必须是对象');
  const bound = Object.values(fingerprint).filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
  if (!bound.length) throw invalid('fingerprint 至少要有 1 个非空绑定值（pcbUuid/boardId/digest…）');
  const source = envelope.source;
  if (!source || typeof source !== 'object' || typeof source.agent !== 'string' || !source.agent.trim()) throw invalid('source.agent 不能为空');
  if (source.readOnly !== true) throw Object.assign(new Error('agent 证据必须声明只读（source.readOnly=true），生成方不得写回'), { code: EVIDENCE_CONTRACT_CODES.AGENT_NOT_READONLY });
  if (!EVIDENCE_VERDICTS.includes(envelope.verdict)) throw invalid(`未知 verdict：${envelope.verdict}`);
  if (!Array.isArray(envelope.findings)) throw invalid('findings 必须是数组');
  const findings = envelope.findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object') throw invalid(`findings[${index}] 必须是对象`);
    if (typeof finding.code !== 'string' || !CODE_RE.test(finding.code)) throw invalid(`findings[${index}].code 必须是大写错误码`);
    if (!EVIDENCE_SEVERITIES.includes(finding.severity)) throw invalid(`findings[${index}].severity 必须是 ${EVIDENCE_SEVERITIES.join('/')}`);
    if (typeof finding.message !== 'string' || !finding.message.trim()) throw invalid(`findings[${index}].message 不能为空`);
    return finding;
  });
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (envelope.verdict === 'pass' && errors.length) throw Object.assign(new Error(`verdict=pass 但存在 ${errors.length} 条 error finding`), { code: EVIDENCE_CONTRACT_CODES.PASS_WITH_ERRORS });
  if (envelope.verdict === 'blocked' && !errors.length && !envelope.blockedReason) throw Object.assign(new Error('verdict=blocked 但没有 error finding 或 blockedReason'), { code: EVIDENCE_CONTRACT_CODES.BLOCKED_WITHOUT_REASON });
  if (envelope.verdict === 'unknown' && !errors.length && !envelope.blockedReason && !findings.length) throw invalid('verdict=unknown 时至少要说明原因');
  return { ...envelope, findings };
}

export function createEvidenceEnvelope({
  kind,
  subject,
  fingerprint,
  source = { agent: 'unknown', readOnly: true, version: '1.0.0' },
  verdict,
  findings = [],
  counts = {},
  details = null,
  blockedReason = null,
  digest = null,
  now = () => new Date(),
} = {}) {
  const envelope = {
    schemaVersion: EVIDENCE_ENVELOPE_VERSION,
    kind,
    subject,
    fingerprint,
    source,
    verdict,
    findings,
    counts,
    details,
    blockedReason,
    generatedAt: now().toISOString(),
    digest,
  };
  assertEvidenceEnvelope(envelope);
  return { ...envelope, digest: digestOf({ ...envelope, digest: null }) };
}

/** 门禁裁决：缺证据=unknown，绝不默认 pass；任一 blocked/unknown 都阻断。 */
export function evaluateGate({ envelopes = [], requiredKinds = [] } = {}) {
  const byKind = new Map();
  for (const envelope of envelopes) {
    assertEvidenceEnvelope(envelope);
    if (!byKind.has(envelope.kind)) byKind.set(envelope.kind, []);
    byKind.get(envelope.kind).push(envelope);
  }
  const missing = requiredKinds.filter((kind) => !byKind.has(kind));
  const blockedBy = [];
  const unknownBy = [];
  for (const envelope of envelopes) {
    if (envelope.verdict === 'blocked') blockedBy.push({ kind: envelope.kind, subject: envelope.subject, digest: envelope.digest, findings: envelope.findings.filter((finding) => finding.severity === 'error').slice(0, 10) });
    if (envelope.verdict === 'unknown') unknownBy.push({ kind: envelope.kind, subject: envelope.subject, digest: envelope.digest });
  }
  const verdict = blockedBy.length ? 'blocked' : (missing.length || unknownBy.length) ? 'unknown' : 'pass';
  return { verdict, missing, blockedBy, unknownBy, checked: envelopes.length };
}
