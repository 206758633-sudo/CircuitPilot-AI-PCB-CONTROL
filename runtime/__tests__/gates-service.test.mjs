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

test('evaluate：六门证据齐全 pass → 归档门禁报告（kind=signoff）', () => {
  const { root, service, store } = makeService();
  try {
    for (const gate of PCB_GATES) store.save({ kind: gate.requiredKinds[0], payload: envelope(gate.requiredKinds[0]), fingerprint: { pcbUuid: 'pcb-a' } });
    const evaluated = service.evaluate({ pcbUuid: 'pcb-a' });
    assert.equal(evaluated.report.verdict, 'pass');
    assert.equal(evaluated.evidenceRefs.length, 6);
    assert.ok(evaluated.evidencePath);
    const saved = store.latest('signoff', { fingerprint: { pcbUuid: 'pcb-a' } });
    assert.equal(saved.payload.kind, 'gate-report');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('signoff：blocked/unknown 不允许签字放行；pass 才可签并写账本', () => {
  const { root, service, ledger } = makeService();
  try {
    assert.throws(() => service.signoff({ pcbUuid: 'pcb-a', signedBy: 'lead' }), (error) => error.code === GATE_SERVICE_CODES.SIGNOFF_BLOCKED);
    assert.throws(() => service.signoff({ pcbUuid: 'pcb-a' }), (error) => error.code === GATE_SERVICE_CODES.SIGNOFF_REQUIRED);
    const result = service.signoff({ pcbUuid: 'pcb-a', signedBy: 'lead', decision: 'reject', note: '证据不足' });
    assert.equal(result.record.decision, 'reject');
    assert.equal(ledger.verify().ok, true);
    assert.ok(ledger.snapshot().entries.some((entry) => entry.action === 'rejected'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
