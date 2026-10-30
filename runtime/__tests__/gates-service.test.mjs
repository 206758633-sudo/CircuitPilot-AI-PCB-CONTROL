import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApprovalLedger } from '../approval-ledger.mjs';
import { createEvidenceEnvelope } from '../evidence-contract.mjs';
import { createEvidenceStore } from '../evidence-store.mjs';
import { GATE_SERVICE_CODES, createGateService } from '../gates-service.mjs';
import { PCB_GATES } from '../gate-engine.mjs';

const envelope = (kind, pcbUuid = 'pcb-a') => createEvidenceEnvelope({ kind, subject: { type: 'pcb', id: pcbUuid }, fingerprint: { pcbUuid }, source: { agent: 'fake', readOnly: true }, verdict: 'pass', findings: [] });

function makeService() {
  const root = mkdtempSync(join(tmpdir(), 'gates-'));
  const store = createEvidenceStore({ root: join(root, 'evidence') });
  const ledger = createApprovalLedger();
  return { root, store, ledger, service: createGateService({ evidenceStore: store, approvalLedger: ledger, now: () => new Date('2026-10-21T12:00:00.000Z') }) };
}

test('status：缺全部证据 → unknown（不默认通过），且不写证据', () => {
  const { root, service, store } = makeService();
  try {
    const { report, evidenceRefs } = service.status({ pcbUuid: 'pcb-a' });
    assert.equal(report.verdict, 'unknown');
    assert.equal(evidenceRefs.length, 0);
    assert.equal(store.list('signoff').length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P0-5：evaluate 报告落独立 kind=gate-report，绝不写进交付签核目录', () => {
  const { root, service, store } = makeService();
  try {
    // task-16：六门都已接入生产者；只喂 G2/G3/G4 三类 → G1/G5/G6 缺证据判 unknown，仍不能签字。
    for (const kind of ['lib-evidence', 'netlist-diff', 'rules']) store.save({ kind, payload: envelope(kind), fingerprint: { pcbUuid: 'pcb-a' } });
    const evaluated = service.evaluate({ pcbUuid: 'pcb-a' });
    assert.equal(evaluated.report.verdict, 'unknown');
    assert.deepEqual(evaluated.report.notImplementedGates, [], '六门均已实现，不能再报 not-implemented');
    const byId = Object.fromEntries(evaluated.report.gates.map((gate) => [gate.id, gate]));
    for (const id of ['G1', 'G5', 'G6']) {
      assert.equal(byId[id].verdict, 'unknown', `${id} 缺证据只能是 unknown，不能冒充通过`);
      assert.equal(byId[id].implemented, true);
    }
    assert.equal(evaluated.evidenceRefs.length, 3);
    assert.ok(evaluated.evidencePath);
    const saved = store.latest('gate-report', { fingerprint: { pcbUuid: 'pcb-a' } });
    assert.equal(saved.payload.kind, 'gate-report');
    assert.equal(store.list('signoff').length, 0, '评估不得遮蔽交付签核');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P0-5：已落交付签核时点一次"评估"，最新 signoff 仍是真实签核（gate-report 不遮蔽）', () => {
  const { root, service, store } = makeService();
  try {
    const productionSignoff = store.save({
      kind: 'signoff',
      payload: { kind: 'signoff-record', passed: true, manifestHash: 'm'.repeat(16), roles: [{ role: '硬件', name: '张三' }] },
      fingerprint: { pcbUuid: 'pcb-a', manifestHash: 'm'.repeat(16) },
      note: '三方签核',
    });
    service.evaluate({ pcbUuid: 'pcb-a' });
    const latest = store.latest('signoff', { fingerprint: { pcbUuid: 'pcb-a' } });
    assert.equal(latest.digest, productionSignoff.digest, '交付签核必须仍是最新 signoff');
    assert.equal(latest.payload.kind, 'signoff-record');
    const report = store.latest('gate-report', { fingerprint: { pcbUuid: 'pcb-a' } });
    assert.equal(report.payload.kind, 'gate-report');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('signoff：blocked/unknown 不允许签字放行；pass 才可签并写账本', () => {
  const { root, service, ledger, store } = makeService();
  try {
    assert.throws(() => service.signoff({ pcbUuid: 'pcb-a', signedBy: 'lead' }), (error) => error.code === GATE_SERVICE_CODES.SIGNOFF_BLOCKED);
    assert.throws(() => service.signoff({ pcbUuid: 'pcb-a' }), (error) => error.code === GATE_SERVICE_CODES.SIGNOFF_REQUIRED);
    const result = service.signoff({ pcbUuid: 'pcb-a', signedBy: 'lead', decision: 'reject', note: '证据不足' });
    assert.equal(result.record.decision, 'reject');
    assert.equal(ledger.verify().ok, true);
    assert.ok(ledger.snapshot().entries.some((entry) => entry.action === 'rejected'));
    const saved = store.latest('gate-signoff', { fingerprint: { pcbUuid: 'pcb-a' } });
    assert.equal(saved.payload.kind, 'signoff-record');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** 非通过信封：blocked 需要 error finding + blockedReason（证据契约 fail-closed）。 */
const blockedEnvelope = (kind, pcbUuid = 'pcb-a') => createEvidenceEnvelope({
  kind,
  subject: { type: 'pcb', id: pcbUuid },
  fingerprint: { pcbUuid },
  source: { agent: 'fake', readOnly: true },
  verdict: 'blocked',
  findings: [{ code: 'FAKE_BLOCKED', severity: 'error', message: `${kind} 被阻断（测试）` }],
  blockedReason: `${kind} 被阻断（测试）`,
});

const SIX_KINDS = ['design-spec', 'lib-evidence', 'netlist-diff', 'rules', 'placement', 'fabrication-release'];

test('task-16：G2 聚合全部器件的 lib-evidence —— 最新一条是 pass 也不能盖住更早的 blocked', () => {
  const { root, service, store } = makeService();
  try {
    // 先落 blocked（旧），再落 pass（新）：按 latest 取会得到 pass，必须靠 list 聚合才能发现 blocked。
    store.save({ kind: 'lib-evidence', payload: blockedEnvelope('lib-evidence'), fingerprint: { pcbUuid: 'pcb-a' }, note: 'U2 缺供应商数据' });
    store.save({ kind: 'lib-evidence', payload: envelope('lib-evidence'), fingerprint: { pcbUuid: 'pcb-a' }, note: 'U1 通过' });
    const { report, evidenceRefs } = service.status({ pcbUuid: 'pcb-a' });
    const g2 = report.gates.find((gate) => gate.id === 'G2');
    assert.equal(g2.verdict, 'blocked', '任一器件 blocked → G2 必须 blocked');
    assert.ok(g2.reasons.some((reason) => /阻断|blocked/i.test(reason.message ?? '')), `G2 应给出阻断原因：${JSON.stringify(g2.reasons)}`);
    assert.equal(evidenceRefs.filter((ref) => ref.kind === 'lib-evidence').length, 2, 'evidenceRefs 必须保留两条 lib-evidence');
    assert.equal(report.verdict, 'blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('task-16：六类证据齐备 → 整体 pass，evaluate 落 gate-report，人工 approve 可签并写账本', () => {
  const { root, service, ledger, store } = makeService();
  try {
    for (const kind of SIX_KINDS) store.save({ kind, payload: envelope(kind), fingerprint: { pcbUuid: 'pcb-a' } });
    const { report } = service.status({ pcbUuid: 'pcb-a' });
    assert.equal(report.verdict, 'pass', `六门齐备应 pass：${JSON.stringify(report.gates.map((gate) => [gate.id, gate.verdict, gate.missing]))}`);
    const evaluated = service.evaluate({ pcbUuid: 'pcb-a' });
    assert.equal(evaluated.report.verdict, 'pass');
    assert.ok(evaluated.evidencePath);
    const signed = service.signoff({ pcbUuid: 'pcb-a', signedBy: 'lead', decision: 'approve', note: '六门齐备' });
    assert.equal(signed.record.decision, 'approve');
    assert.equal(signed.record.gateVerdict, 'pass');
    assert.equal(ledger.verify().ok, true);
    assert.equal(store.latest('gate-signoff', { fingerprint: { pcbUuid: 'pcb-a' } }).payload.decision, 'approve');
    assert.equal(store.list('signoff').length, 0, '门禁签字不得写交付签核目录');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('task-16：缺任意一门 → 整体不是 pass，approve 被拒并说明缺哪门', () => {
  const { root, service, store } = makeService();
  try {
    for (const kind of SIX_KINDS.filter((kind) => kind !== 'placement')) store.save({ kind, payload: envelope(kind), fingerprint: { pcbUuid: 'pcb-a' } });
    const { report } = service.status({ pcbUuid: 'pcb-a' });
    assert.equal(report.verdict, 'unknown');
    assert.ok(report.gates.find((gate) => gate.id === 'G5').missing.some((item) => /placement/.test(item)));
    assert.throws(
      () => service.signoff({ pcbUuid: 'pcb-a', signedBy: 'lead', decision: 'approve' }),
      (error) => error.code === GATE_SERVICE_CODES.SIGNOFF_BLOCKED && /G5|未知|unknown/.test(error.message),
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
