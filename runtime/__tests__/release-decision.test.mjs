import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReleaseDecision } from '../release-decision.mjs';

const localGate = (statuses = ['pass', 'pass'], extra = {}) => ({
  ready: statuses.every((status) => status === 'pass' || status === 'warn'),
  verdict: 'ready-to-order',
  warnings: [],
  gates: statuses.map((status, index) => ({ id: `gate-${index}`, title: `门禁${index}`, status, findings: [], evidence: null })),
  fingerprint: { sha256: 'abc' },
  ...extra,
});

const dfmEntry = (passed = true, planHash = 'plan-1') => ({ digest: 'dfm-digest', savedAt: '2026-10-19T00:00:00.000Z', path: '/tmp/dfm.json', fingerprint: { planHash }, payload: { passed, roles: [] } });
const signoffEntry = (roles = 3) => ({ digest: 'sign-digest', savedAt: '2026-10-19T00:00:00.000Z', path: '/tmp/sign.json', fingerprint: { planHash: 'plan-1', manifestHash: 'm-1' }, payload: { passed: true, roles: Array.from({ length: roles }, (_, index) => ({ role: `角色${index}`, name: `人${index}` })) } });

test('缺本地门禁/缺人工证据 → blocked，且逐项列出原因；orderEnabled 恒 false', () => {
  const decision = buildReleaseDecision({});
  assert.equal(decision.ready, false);
  assert.equal(decision.verdict, 'blocked');
  assert.equal(decision.orderEnabled, false);
  assert.equal(decision.humanSignoffRequired, true);
  assert.deepEqual(decision.blockedBy, ['local:release-gate', 'manual:dfm', 'manual:signoff']);
  assert.ok(decision.reason.includes('不能声称可以放行'));
});

test('本地门禁全过 + DFM 回填 + 终审签核 → ready；但仍禁止自动下单', () => {
  const decision = buildReleaseDecision({ gate: localGate(), dfm: dfmEntry(), signoff: signoffEntry() });
  assert.equal(decision.ready, true);
  assert.equal(decision.verdict, 'ready');
  assert.equal(decision.orderEnabled, false);
  assert.deepEqual(decision.blockedBy, []);
  assert.ok(decision.evidence.dfm.digest);
  assert.ok(decision.evidence.signoff.path.endsWith('.json'));
});

test('本地有警告时 verdict 是 ready-with-warnings，不是 ready', () => {
  const gate = localGate(['pass', 'warn'], { warnings: [{ code: 'W', message: '警告' }] });
  const decision = buildReleaseDecision({ gate, dfm: dfmEntry(), signoff: signoffEntry() });
  assert.equal(decision.ready, true);
  assert.equal(decision.verdict, 'ready-with-warnings');
});

test('本地门禁被阻断 → blocked，即使 DFM/签核齐全', () => {
  const decision = buildReleaseDecision({ gate: localGate(['pass', 'blocked']), dfm: dfmEntry(), signoff: signoffEntry() });
  assert.equal(decision.ready, false);
  assert.ok(decision.blockedBy.includes('local:gate-1'));
  assert.ok(decision.reason.includes('本地门禁未通过'));
});

test('DFM 明确不通过 / 签核无角色 → 仍 blocked', () => {
  const failedDfm = buildReleaseDecision({ gate: localGate(), dfm: dfmEntry(false), signoff: signoffEntry() });
  assert.equal(failedDfm.ready, false);
  assert.deepEqual(failedDfm.blockedBy, ['manual:dfm']);
  const emptySignoff = buildReleaseDecision({ gate: localGate(), dfm: dfmEntry(), signoff: signoffEntry(0) });
  assert.equal(emptySignoff.ready, false);
  assert.deepEqual(emptySignoff.blockedBy, ['manual:signoff']);
});

test('决策指纹随证据变化；同一输入稳定可复算', () => {
  const one = buildReleaseDecision({ gate: localGate(), dfm: dfmEntry(), signoff: signoffEntry() });
  const two = buildReleaseDecision({ gate: localGate(), dfm: dfmEntry(), signoff: signoffEntry() });
  assert.equal(one.fingerprint, two.fingerprint);
  const other = buildReleaseDecision({ gate: localGate(), dfm: dfmEntry(false), signoff: signoffEntry() });
  assert.notEqual(one.fingerprint, other.fingerprint);
  assert.match(one.fingerprint, /^[a-f0-9]{64}$/);
});

test('证据绑定：给了 binding 后，别的板/别的计划的 DFM 或签核不能充数', () => {
  const boundDfm = { ...dfmEntry(true), fingerprint: { planHash: 'plan-1', pcbUuid: 'board-1' } };
  const boundSignoff = { ...signoffEntry(), fingerprint: { planHash: 'plan-1', pcbUuid: 'board-1', manifestHash: 'm-1' } };
  const ok = buildReleaseDecision({ gate: localGate(), dfm: boundDfm, signoff: boundSignoff, binding: { planHash: 'plan-1', pcbUuid: 'board-1' } });
  assert.equal(ok.ready, true);
  assert.equal(ok.evidence.binding.pcbUuid, 'board-1');

  const otherBoard = buildReleaseDecision({ gate: localGate(), dfm: boundDfm, signoff: boundSignoff, binding: { pcbUuid: 'board-2' } });
  assert.equal(otherBoard.ready, false);
  assert.deepEqual(otherBoard.blockedBy.sort(), ['manual:dfm', 'manual:signoff']);
  assert.match(otherBoard.gates.find((item) => item.id === 'manual:dfm').reason, /不一致/);

  const unbound = buildReleaseDecision({ gate: localGate(), dfm: { ...dfmEntry(), fingerprint: {} }, signoff: signoffEntry(), binding: { planHash: 'plan-1' } });
  assert.equal(unbound.ready, false);
  assert.match(unbound.gates.find((item) => item.id === 'manual:dfm').reason, /未绑定 planHash/);

  const manifestMismatch = buildReleaseDecision({ gate: localGate(), dfm: boundDfm, signoff: boundSignoff, binding: { manifestHash: 'other-manifest' } });
  assert.equal(manifestMismatch.ready, false);
  assert.deepEqual(manifestMismatch.blockedBy, ['manual:signoff']);
});
