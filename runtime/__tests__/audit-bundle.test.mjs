import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildRunAuditBundle } from '../automation/audit-bundle.mjs';
import { createAutomationJournal } from '../automation/journal.mjs';
import { createRuntimeServer } from '../server.mjs';

const NOW = '2026-10-20T03:00:00.000Z';

function makeJournal(root) {
  const journal = createAutomationJournal({ dir: join(root, 'automation-runs') });
  const runId = 'run-e11-audit';
  journal.append(runId, { at: NOW, phase: 'run.start', recipeId: 'pcb-sync-from-schematic', recipeVersion: 1 });
  journal.append(runId, { at: NOW, phase: 'run.start.approvals', requiredApprovals: ['write'], approvals: { write: true }, approvalIds: ['auto-123'], approvalFingerprint: 'fp-abc' });
  journal.append(runId, { at: NOW, phase: 'step.start', stepId: 'sync', stepIndex: 0, title: '同步位号', kind: 'api', action: 'pcb.sync', approval: 'write' });
  journal.append(runId, { at: NOW, phase: 'step.evidence.before', stepId: 'sync', ok: true, sha256: 'a'.repeat(64), bytes: 1024, kind: 'os-window-capture', path: '/tmp/before.png' });
  journal.append(runId, { at: NOW, phase: 'attempt', stepId: 'sync', strategy: 'primary', ok: true });
  journal.append(runId, { at: NOW, phase: 'readback', stepId: 'sync', attempt: 1, strategy: 'primary', ok: true, stateDigest: 'b'.repeat(64) });
  journal.append(runId, { at: NOW, phase: 'step.evidence.after', stepId: 'sync', ok: true, sha256: 'c'.repeat(64), bytes: 1100, kind: 'os-window-capture', path: '/tmp/after.png' });
  journal.append(runId, { at: NOW, phase: 'step.verified', stepId: 'sync' });
  journal.append(runId, { at: NOW, phase: 'run.end', ok: true, state: 'completed' });
  return { journal, runId };
}

test('E11 审计包：写步骤 before/after 摘要 + 读回 + 批准 id/指纹 + 链完整', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-audit-bundle-'));
  try {
    const { journal, runId } = makeJournal(root);
    const bundle = buildRunAuditBundle(journal.read(runId), { runId, writeStepIds: ['sync'] });
    assert.equal(bundle.ok, true);
    assert.equal(bundle.chain.ok, true);
    assert.equal(bundle.chain.entries, 9);
    assert.equal(bundle.recipeId, 'pcb-sync-from-schematic');
    assert.deepEqual(bundle.approvals.approvalIds, ['auto-123']);
    assert.equal(bundle.approvals.operatorBinding.fingerprint, 'fp-abc');
    assert.match(bundle.approvals.operatorBinding.note, /无独立第三方签名/);
    const step = bundle.steps.find((item) => item.stepId === 'sync');
    assert.equal(step.evidence.before.sha256, 'a'.repeat(64));
    assert.equal(step.evidence.after.sha256, 'c'.repeat(64));
    assert.equal(step.readbacks[0].stateDigest, 'b'.repeat(64));
    assert.equal(step.ok, true);
    assert.equal(bundle.summary.evidenceComplete, true);
    assert.equal(bundle.warnings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E11 审计包 fail-closed：写步骤缺 before/after 证据 → warnings + evidenceComplete=false', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-audit-missing-'));
  try {
    const journal = createAutomationJournal({ dir: join(root, 'runs') });
    const runId = 'run-missing-evidence';
    journal.append(runId, { at: NOW, phase: 'run.start', recipeId: 'r2' });
    journal.append(runId, { at: NOW, phase: 'step.start', stepId: 'write-1', stepIndex: 0, approval: 'write' });
    journal.append(runId, { at: NOW, phase: 'readback', stepId: 'write-1', ok: true, stateDigest: 'd'.repeat(64) });
    journal.append(runId, { at: NOW, phase: 'step.verified', stepId: 'write-1' });
    const bundle = buildRunAuditBundle(journal.read(runId), { runId });
    assert.equal(bundle.summary.writeSteps, 1);
    assert.equal(bundle.summary.evidenceComplete, false);
    const codes = bundle.warnings.map((item) => item.code);
    assert.ok(codes.includes('EVIDENCE_MISSING'));
    assert.ok(bundle.warnings.some((item) => item.message.includes('before')));
    assert.ok(bundle.warnings.some((item) => item.message.includes('after')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E11 审计包：链被篡改 → ok=false + brokenAt（不假装完整）；base64 泄漏单独告警', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-audit-tamper-'));
  try {
    const journal = createAutomationJournal({ dir: join(root, 'runs') });
    const runId = 'run-tamper';
    journal.append(runId, { at: NOW, phase: 'run.start', recipeId: 'r2' });
    journal.append(runId, { at: NOW, phase: 'step.start', stepId: 'write-1', stepIndex: 0, approval: 'write' });
    journal.append(runId, { at: NOW, phase: 'step.evidence.before', stepId: 'write-1', ok: true, sha256: 'e'.repeat(64) });
    journal.append(runId, { at: NOW, phase: 'step.evidence.before', stepId: 'write-1', ok: true, sha256: 'f'.repeat(64), base64: 'aGVsbG8=' });
    const entries = journal.read(runId);
    const tampered = entries.map((entry, index) => index === 1 ? { ...entry, approval: 'read' } : entry);
    const bundle = buildRunAuditBundle(tampered, { runId });
    assert.equal(bundle.ok, false);
    assert.equal(bundle.chain.ok, false);
    assert.notEqual(bundle.chain.brokenAt, null);
    assert.ok(bundle.warnings.some((item) => item.code === 'CHAIN_BROKEN'));
    const clean = buildRunAuditBundle(entries, { runId });
    assert.ok(clean.warnings.some((item) => item.code === 'EVIDENCE_BASE64_LEAK'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E11 审计包 HTTP：GET /api/automation/runs/:runId/audit-bundle 返回 bundle；未知 run 404', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-audit-http-'));
  mkdirSync(join(root, 'automation-runs'), { recursive: true });
  const previous = {
    auto: process.env.CIRCUITPILOT_AUTOMATION_DIR,
    evidence: process.env.CIRCUITPILOT_EVIDENCE_DIR,
    state: process.env.CIRCUITPILOT_STATE_DIR,
  };
  process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation-runs');
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'evidence'), { recursive: true });
  const { runId } = makeJournal(root);
  const { server } = createRuntimeServer({ keychain: { async configured() { return false; }, async read() { throw new Error('unused'); } }, bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => {
    for (const [key, value] of Object.entries({ auto: previous.auto, evidence: previous.evidence, state: previous.state })) {
      const envKey = { auto: 'CIRCUITPILOT_AUTOMATION_DIR', evidence: 'CIRCUITPILOT_EVIDENCE_DIR', state: 'CIRCUITPILOT_STATE_DIR' }[key];
      if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const headers = { 'x-circuitpilot-token': health.sessionProof };
  const response = await fetch(`${base}/api/automation/runs/${runId}/audit-bundle`, { headers });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.bundle.ok, true);
  assert.equal(payload.bundle.runId, runId);
  assert.ok(payload.bundle.steps.length >= 1);
  const missing = await fetch(`${base}/api/automation/runs/run-does-not-exist/audit-bundle`, { headers });
  assert.equal(missing.status, 404);
  const missingPayload = await missing.json();
  assert.equal(missingPayload.error.code, 'AUTOMATION_RUN_NOT_FOUND');
});
