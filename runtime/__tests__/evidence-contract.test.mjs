import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVIDENCE_CONTRACT_CODES,
  assertEvidenceEnvelope,
  createEvidenceEnvelope,
  evaluateGate,
} from '../evidence-contract.mjs';

const base = () => ({
  kind: 'netlist-diff',
  subject: { type: 'pcb', id: 'pcb-a' },
  fingerprint: { pcbUuid: 'pcb-a', intentDigest: 'a'.repeat(64) },
  source: { agent: 'netlist-auditor', readOnly: true, version: '1.0.0' },
  verdict: 'pass',
  findings: [],
  counts: { errors: 0 },
});

test('createEvidenceEnvelope：合法证据通过并生成 schemaVersion/generatedAt/digest', () => {
  const envelope = createEvidenceEnvelope({ ...base(), now: () => new Date('2026-10-21T12:00:00.000Z') });
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.generatedAt, '2026-10-21T12:00:00.000Z');
  assert.match(envelope.digest, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => assertEvidenceEnvelope(envelope));
});

test('pass 不允许携带 error finding（防止“空通过/带错通过”）', () => {
  assert.throws(() => createEvidenceEnvelope({ ...base(), findings: [{ code: 'NETLIST_GND_EMPTY', severity: 'error', message: 'GND 空网' }] }), (error) => error.code === EVIDENCE_CONTRACT_CODES.PASS_WITH_ERRORS);
});

test('blocked 必须有 error finding 或 blockedReason', () => {
  assert.throws(() => createEvidenceEnvelope({ ...base(), verdict: 'blocked', findings: [] }), (error) => error.code === EVIDENCE_CONTRACT_CODES.BLOCKED_WITHOUT_REASON);
  const withReason = createEvidenceEnvelope({ ...base(), verdict: 'blocked', blockedReason: 'DRC 报告缺失' });
  assert.equal(withReason.verdict, 'blocked');
  const withFinding = createEvidenceEnvelope({ ...base(), verdict: 'blocked', findings: [{ code: 'DRC_UNEXPLAINED', severity: 'error', message: '3 条未处理' }] });
  assert.equal(withFinding.findings.length, 1);
});

test('agent 证据必须只读：readOnly=false 直接拒绝', () => {
  assert.throws(() => createEvidenceEnvelope({ ...base(), source: { agent: 'generator', readOnly: false } }), (error) => error.code === EVIDENCE_CONTRACT_CODES.AGENT_NOT_READONLY);
});

test('fingerprint 必须有非空绑定值；subject/kind/verdict/findings 逐项校验', () => {
  for (const mutate of [
    (value) => { value.fingerprint = { pcbUuid: '', boardId: null }; },
    (value) => { value.subject = { type: 'unknown-type', id: 'x' }; },
    (value) => { value.subject = { type: 'pcb', id: '' }; },
    (value) => { value.kind = 'Not Valid'; },
    (value) => { value.verdict = 'ok'; },
    (value) => { value.findings = [{ code: 'bad code', severity: 'error', message: 'x' }]; },
    (value) => { value.findings = [{ code: 'OK_CODE', severity: 'fatal', message: 'x' }]; },
    (value) => { value.findings = [{ code: 'OK_CODE', severity: 'error', message: '' }]; },
  ]) {
    const value = base();
    mutate(value);
    assert.throws(() => createEvidenceEnvelope(value), (error) => error.code === EVIDENCE_CONTRACT_CODES.INVALID, JSON.stringify(value).slice(0, 120));
  }
});

test('evaluateGate：缺必需证据 → unknown（绝不默认 pass）', () => {
  const netlist = createEvidenceEnvelope({ ...base() });
  const gate = evaluateGate({ envelopes: [netlist], requiredKinds: ['netlist-diff', 'rules'] });
  assert.equal(gate.verdict, 'unknown');
  assert.deepEqual(gate.missing, ['rules']);
});

test('evaluateGate：任一 blocked → blocked；unknown 证据 → unknown；全部 pass → pass', () => {
  const rulesBlocked = createEvidenceEnvelope({
    kind: 'rules', subject: { type: 'pcb', id: 'pcb-a' }, fingerprint: { pcbUuid: 'pcb-a' },
    source: { agent: 'rule-runner', readOnly: true }, verdict: 'blocked',
    findings: [{ code: 'DRC_UNEXPLAINED', severity: 'error', message: '1 条未处理' }],
  });
  const netlistPass = createEvidenceEnvelope({ ...base() });
  assert.equal(evaluateGate({ envelopes: [netlistPass, rulesBlocked], requiredKinds: ['netlist-diff', 'rules'] }).verdict, 'blocked');
  const netlistUnknown = createEvidenceEnvelope({ ...base(), verdict: 'unknown', blockedReason: '实际网表导出失败' });
  assert.equal(evaluateGate({ envelopes: [netlistUnknown], requiredKinds: ['netlist-diff'] }).verdict, 'unknown');
  assert.equal(evaluateGate({ envelopes: [netlistPass], requiredKinds: ['netlist-diff'] }).verdict, 'pass');
});

test('digest 确定性：同内容两次生成 digest 相同（时间注入）', () => {
  const now = () => new Date('2026-10-21T12:00:00.000Z');
  assert.equal(createEvidenceEnvelope({ ...base(), now }).digest, createEvidenceEnvelope({ ...base(), now }).digest);
});
