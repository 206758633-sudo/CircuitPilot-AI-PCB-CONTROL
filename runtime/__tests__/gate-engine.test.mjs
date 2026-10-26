import assert from 'node:assert/strict';
import test from 'node:test';
import { GATE_CODES, PCB_GATES, evaluatePcbGates, explainPcbGates } from '../gate-engine.mjs';
import { createEvidenceEnvelope } from '../evidence-contract.mjs';
import { RELEASE_CODES, gateFabricationRelease, gateNetlistEvidence, gateRulesEvidence } from '../release-gate.mjs';

const envelope = (kind, { verdict = 'pass', pcbUuid = 'pcb-a', findings = [] } = {}) => createEvidenceEnvelope({
  kind,
  subject: { type: 'pcb', id: pcbUuid },
  fingerprint: { pcbUuid },
  source: { agent: `fake-${kind}`, readOnly: true },
  verdict,
  findings,
});
const allKinds = () => PCB_GATES.map((gate) => gate.requiredKinds[0]);
const blockedEnvelope = (kind, pcbUuid = 'pcb-a') => envelope(kind, { verdict: 'blocked', pcbUuid, findings: [{ code: 'X_BLOCKED', severity: 'error', message: '未处理错误' }] });

test('门定义：G1~G6 每门都有输入/输出/用途', () => {
  assert.deepEqual(PCB_GATES.map((gate) => gate.id), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']);
  for (const gate of PCB_GATES) {
    assert.ok(gate.requiredKinds.length >= 1, gate.id);
    assert.ok(gate.name && gate.purpose, gate.id);
  }
});

test('六门证据齐全且 pass → 全局 pass；解释文本可读', () => {
  const result = evaluatePcbGates({ envelopes: allKinds().map((kind) => envelope(kind)), targetPcbUuid: 'pcb-a' });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.gates.length, 6);
  assert.equal(result.gates.filter((gate) => gate.verdict === 'pass').length, 6);
  assert.ok(explainPcbGates(result).every((line) => line.includes('pass')));
});

test('缺证据（G3 网表）→ unknown，且明确指出缺口', () => {
  const result = evaluatePcbGates({ envelopes: allKinds().filter((kind) => kind !== 'netlist-diff').map((kind) => envelope(kind)) });
  assert.equal(result.verdict, 'unknown');
  const g3 = result.gates.find((gate) => gate.id === 'G3');
  assert.equal(g3.verdict, 'unknown');
  assert.deepEqual(g3.missing, ['netlist-diff']);
  assert.ok(g3.reasons.some((reason) => reason.code === GATE_CODES.EVIDENCE_MISSING));
});

test('任一 blocked 证据 → 全局 blocked，且带阻断原因', () => {
  const envelopes = allKinds().map((kind) => kind === 'rules' ? blockedEnvelope('rules') : envelope(kind));
  const result = evaluatePcbGates({ envelopes });
  assert.equal(result.verdict, 'blocked');
  assert.deepEqual(result.blockedGates, ['G4']);
  assert.ok(result.gates.find((gate) => gate.id === 'G4').reasons.some((reason) => reason.code === GATE_CODES.BLOCKED));
});

test('证据 pcbUuid 与目标不一致 → 不能当当前板结论', () => {
  const envelopes = allKinds().map((kind) => envelope(kind, { pcbUuid: kind === 'design-spec' ? 'other' : 'pcb-a' }));
  const result = evaluatePcbGates({ envelopes, targetPcbUuid: 'pcb-a' });
  assert.equal(result.verdict, 'blocked');
  const g1 = result.gates.find((gate) => gate.id === 'G1');
  assert.ok(g1.reasons.some((reason) => reason.code === GATE_CODES.EVIDENCE_UNBOUND));
});

test('非法证据（不满足契约）→ unknown，不当通过', () => {
  const result = evaluatePcbGates({ envelopes: [{ kind: 'netlist-diff', verdict: 'pass' }] });
  const g3 = result.gates.find((gate) => gate.id === 'G3');
  assert.equal(g3.verdict, 'unknown');
  assert.ok(g3.reasons.some((reason) => reason.code === GATE_CODES.EVIDENCE_INVALID));
});

test('release-gate G2：缺网表证据=unknown；blocked=blocked；pass 但错板=blocked', () => {
  assert.equal(gateNetlistEvidence({}).status, 'unknown');
  assert.equal(gateNetlistEvidence({}).findings[0].code, RELEASE_CODES.NETLIST_EVIDENCE_MISSING);
  const blocked = gateNetlistEvidence({ envelope: blockedEnvelope('netlist-diff') });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.findings[0].code, RELEASE_CODES.NETLIST_BLOCKED);
  const wrongBoard = gateNetlistEvidence({ envelope: envelope('netlist-diff', { pcbUuid: 'other' }), targetPcbUuid: 'pcb-a' });
  assert.equal(wrongBoard.status, 'blocked');
  assert.ok(wrongBoard.findings.some((finding) => finding.code === RELEASE_CODES.NETLIST_EVIDENCE_UNBOUND));
  assert.equal(gateNetlistEvidence({ envelope: envelope('netlist-diff'), targetPcbUuid: 'pcb-a' }).status, 'pass');
});

test('release-gate G3：规则证据缺失/阻断/通过；下单门禁消费两者后 blocked', () => {
  assert.equal(gateRulesEvidence({}).status, 'unknown');
  assert.equal(gateRulesEvidence({ envelope: blockedEnvelope('rules') }).status, 'blocked');
  assert.equal(gateRulesEvidence({ envelope: envelope('rules'), targetPcbUuid: 'pcb-a' }).status, 'pass');
  const report = gateFabricationRelease({
    acceptance: null, drcReport: null, netlistEvidence: blockedEnvelope('netlist-diff'), rulesEvidence: envelope('rules'), targetPcbUuid: 'pcb-a', generatedAt: '2026-10-21T12:00:00.000Z',
  });
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((blocker) => blocker.code === RELEASE_CODES.NETLIST_BLOCKED));
  assert.ok(report.gates.some((gate) => gate.id === 'netlist'));
  assert.ok(report.evidenceBinding.netlist);
});
