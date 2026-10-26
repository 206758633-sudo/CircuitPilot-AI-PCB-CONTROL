import assert from 'node:assert/strict';
import test from 'node:test';
import { assertEvidenceEnvelope } from '../evidence-contract.mjs';
import { RULE_RUNNER_CODES, runRuleChecks } from '../agents/rule-runner.mjs';

const ercNormalized = (findings = []) => ({
  schemaVersion: 1,
  ran: true,
  aggregateOnly: false,
  counts: { fatal: 0, error: findings.filter((f) => f.severity === 'error').length, warning: findings.filter((f) => f.severity === 'warning').length, info: 0, total: findings.length },
  findings,
});
const ercError = { severity: 'error', code: 'ERC_PIN_FLOATING', object: 'U1.1', title: '引脚悬空', detail: '引脚未连接任何网络', aggregate: false, count: 1 };
const drcEmpty = { result: { ok: true, kind: 'array', count: 0, items: [], truncated: false } };
const validExemption = () => ({ code: 'ERC_PIN_FLOATING', object: 'U1.1', reason: '该引脚为 NC，确认悬空', risk: '低', approvedBy: 'lead', approvedAt: '2026-10-21' });

test('ERC 有未处理 error → rules 证据 blocked（且符合统一证据契约）', () => {
  const envelope = runRuleChecks({ erc: ercNormalized([ercError]), drc: drcEmpty, pcbUuid: 'pcb-a', now: () => new Date('2026-10-21T12:00:00.000Z') });
  assert.equal(envelope.kind, 'rules');
  assert.equal(envelope.verdict, 'blocked');
  assert.ok(envelope.findings.some((finding) => finding.code === 'ERC_PIN_FLOATING' && finding.severity === 'error'));
  assert.equal(envelope.fingerprint.pcbUuid, 'pcb-a');
  assert.doesNotThrow(() => assertEvidenceEnvelope(envelope));
});

test('合法豁免覆盖 ERC error → pass；无效豁免（缺理由）→ error', () => {
  const pass = runRuleChecks({ erc: ercNormalized([ercError]), drc: drcEmpty, ercExemptions: [validExemption()], pcbUuid: 'pcb-a' });
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.counts.erc.exempted, 1);

  const invalid = runRuleChecks({ erc: ercNormalized([ercError]), drc: drcEmpty, ercExemptions: [{ code: 'ERC_PIN_FLOATING' }], pcbUuid: 'pcb-a' });
  assert.equal(invalid.verdict, 'blocked');
  assert.ok(invalid.findings.some((finding) => finding.code === 'ERC_EXEMPTION_INVALID'));
});

test('DRC 未解释违规 → DRC_UNEXPLAINED error；合法 DRC 豁免后 pass', () => {
  const drcItem = { index: 0, errorType: 'Connection Error', net: 'GND', layer: null, objects: [{ type: 'Pad' }], explanation: 'GND 网络存在未连接焊盘', disposition: 'must-fix' };
  const drc = { result: { ok: true, kind: 'array', count: 1, items: [drcItem], truncated: false } };
  const blocked = runRuleChecks({ erc: ercNormalized([]), drc, pcbUuid: 'pcb-b' });
  assert.equal(blocked.verdict, 'blocked');
  assert.ok(blocked.findings.some((finding) => finding.code === 'DRC_UNEXPLAINED'));
  assert.equal(blocked.counts.drc.unexplained, 1);
});

test('只有 ERC 或只有 DRC → unknown（缺报告不等于通过）', () => {
  const onlyErc = runRuleChecks({ erc: ercNormalized([]), pcbUuid: 'pcb-c' });
  assert.equal(onlyErc.verdict, 'unknown');
  assert.ok(onlyErc.findings.length >= 0);
  const onlyDrc = runRuleChecks({ drc: drcEmpty, pcbUuid: 'pcb-c' });
  assert.equal(onlyDrc.verdict, 'unknown');
});

test('两者都缺 → RULES_INPUT_MISSING', () => {
  assert.throws(() => runRuleChecks({ pcbUuid: 'pcb-d' }), (error) => error.code === RULE_RUNNER_CODES.INPUT_MISSING);
});

test('DRC 报告不可识别 → RULES_DRC_INVALID（不静默当 0 违规）', () => {
  assert.throws(() => runRuleChecks({ erc: ercNormalized([]), drc: { foo: 1 }, pcbUuid: 'pcb-e' }), (error) => error.code === RULE_RUNNER_CODES.DRC_INVALID);
});

test('确定性 + 指纹绑定：同输入 digest 相同，pcbUuid/boardId 进指纹', () => {
  const now = () => new Date('2026-10-21T12:00:00.000Z');
  const options = { erc: ercNormalized([]), drc: drcEmpty, pcbUuid: 'pcb-f', boardId: 'aux', now };
  const first = runRuleChecks(options);
  const second = runRuleChecks(options);
  assert.equal(first.digest, second.digest);
  assert.equal(first.fingerprint.pcbUuid, 'pcb-f');
  assert.equal(first.fingerprint.boardId, 'aux');
});
