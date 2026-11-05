import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApprovalLedger } from '../approval-ledger.mjs';
import { ApprovalStore } from '../design.mjs';
import { createApprovalStore } from '../automation/approvals.mjs';
import { createJsonStore } from '../store.mjs';
import { createRuntimeServer } from '../server.mjs';

const fakeKeychain = { async configured() { return false; }, async read() { throw new Error('unused'); } };
const fakeGui = { async execute() { return {}; } };
const fakeBridge = { port: 49620, selectedWindowId: 'window-1', async discover() {}, async windows() { return { selectionRequired: false, windows: [{ id: 'window-1' }] }; }, async execute() { return { ok: true, result: {} }; } };

test('批准账本：哈希链可校验，篡改会暴露，落盘后重启仍可核对', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-ledger-'));
  try {
    const file = join(dir, 'approvals-ledger.json');
    const store = createJsonStore({ file, schemaVersion: 1, initial: () => ({ entries: [] }) });
    const ledger = createApprovalLedger({ store });
    ledger.record({ scope: 'plan', action: 'issued', approvalId: 'approval-1', bindings: { planHash: 'h1' } });
    ledger.record({ scope: 'plan', action: 'consumed', approvalId: 'approval-1', bindings: { planHash: 'h1' } });
    ledger.record({ scope: 'write', action: 'issued', approvalId: 'approval-2', bindings: { recipeId: 'pcb-drc' } });
    let snapshot = ledger.snapshot();
    assert.equal(snapshot.entries.length, 3);
    assert.deepEqual(snapshot.chain, { ok: true, brokenAt: null, reason: '' });
    assert.equal(snapshot.summary.byScope.plan, 2);
    assert.equal(snapshot.entries[0].prevHash, 'GENESIS');

    // 落盘重启：新实例从文件恢复，链仍成立。
    ledger.record({ scope: 'release', action: 'issued', approvalId: 'approval-3', bindings: {} });
    const reopened = createApprovalLedger({ store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ entries: [] }) }) });
    const restored = reopened.snapshot();
    assert.equal(restored.entries.length, 4);
    assert.deepEqual(restored.chain, { ok: true, brokenAt: null, reason: '' });

    // 篡改落盘文件里的任意一条：重开后哈希链必须报断点，而不是"看起来正常"。
    const tampered = JSON.parse(readFileSync(file, 'utf8'));
    tampered.data.entries[1].bindings.planHash = 'evil';
    writeFileSync(file, JSON.stringify(tampered), 'utf8');
    const afterTamper = createApprovalLedger({ store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ entries: [] }) }) });
    const verdict = afterTamper.verify();
    assert.equal(verdict.ok, false);
    assert.equal(verdict.brokenAt, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏的账本文件不静默伪造历史：给出 loadError，链从空账本重新起锚', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-ledger-bad-'));
  try {
    const file = join(dir, 'approvals-ledger.json');
    writeFileSync(file, '{not-json', 'utf8');
    const ledger = createApprovalLedger({ store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ entries: [] }) }) });
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.entries.length, 0);
    assert.equal(snapshot.loadError, 'STORE_CORRUPT');
    assert.equal(snapshot.chain.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('计划批准接入账本：签发/消费/复用拒绝都留痕，且账本不存令牌原文', () => {
  const ledger = createApprovalLedger();
  const approvals = new ApprovalStore({ ledger });
  const issued = approvals.issue({ planHash: 'plan-hash', targetFingerprint: 'fingerprint', windowId: 'window-1', steps: ['write'] });
  let snapshot = ledger.snapshot();
  assert.equal(snapshot.entries[0].scope, 'plan');
  assert.equal(snapshot.entries[0].action, 'issued');
  assert.equal(snapshot.entries[0].approvalId.length, 16);
  assert.ok(!JSON.stringify(snapshot).includes(issued.token), '账本绝不能泄露令牌原文');

  approvals.consume(issued.token, { planHash: 'plan-hash', targetFingerprint: 'fingerprint', windowId: 'window-1' });
  assert.equal(ledger.snapshot().entries[1].action, 'consumed');
  assert.throws(() => approvals.consume(issued.token, { planHash: 'plan-hash', targetFingerprint: 'fingerprint', windowId: 'window-1' }), { code: 'APPROVAL_REPLAYED' });
  snapshot = ledger.snapshot();
  assert.equal(snapshot.entries[2].action, 'replayed');
  assert.equal(snapshot.chain.ok, true);
});

test('自动化写板批准接入同一账本：签发与消费同链', () => {
  const ledger = createApprovalLedger();
  const store = createApprovalStore({ ledger });
  const issued = store.issue({ scope: 'write', recipeId: 'pcb-drc', fingerprint: 'fp-1' });
  assert.equal(ledger.snapshot().entries[0].scope, 'write');
  const resolved = store.resolve({ approvalIds: [issued.approvalId], requiredScopes: ['write'], recipeId: 'pcb-drc', fingerprint: 'fp-1' });
  assert.equal(resolved.ok, true);
  const snapshot = ledger.snapshot();
  assert.deepEqual(snapshot.entries.map((entry) => entry.action), ['issued', 'consumed']);
  assert.deepEqual(snapshot.chain, { ok: true, brokenAt: null, reason: '' });
});

test('HTTP：GET /api/approvals/ledger 返回账本与链校验结果', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-ledger-http-'));
  const previousStateDir = process.env.CIRCUITPILOT_STATE_DIR;
  process.env.CIRCUITPILOT_STATE_DIR = dir;
  try {
    const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge: fakeBridge, gui: fakeGui });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
    const response = await fetch(`${base}/api/approvals/ledger`, { headers: { 'x-circuitpilot-token': health.sessionProof } });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(Array.isArray(body.entries), true);
    assert.equal(body.chain.ok, true);
    assert.equal(typeof body.summary.total, 'number');
    assert.equal(body.degraded, false, '正常账本不应带降级标记');
  } finally {
    if (previousStateDir === undefined) delete process.env.CIRCUITPILOT_STATE_DIR; else process.env.CIRCUITPILOT_STATE_DIR = previousStateDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P2-9（2026-11-05 运行时/运维审计）：降级签发语义。
// 文件损坏时旧实现只给 loadError，审计/UI 无法区分"这是新链"和"历史链丢了"。
// 现在降级期间写入的条目带 degraded:true，快照给 degraded/degradedSince；验链行为不变。
// ---------------------------------------------------------------------------

test('账本降级标记：损坏文件 → degraded/degradedSince 出现，降级期条目带 degraded:true，验链行为不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-ledger-degraded-'));
  try {
    const file = join(dir, 'approvals-ledger.json');
    writeFileSync(file, '{not-json', 'utf8');
    const fixedNow = '2026-11-05T00:00:00.000Z';
    const ledger = createApprovalLedger({ store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ entries: [] }) }), now: () => fixedNow });
    const before = ledger.snapshot();
    assert.equal(before.degraded, true, '文件读坏必须进入显式降级态');
    assert.equal(before.degradedSince, fixedNow);
    assert.equal(before.loadError, 'STORE_CORRUPT');
    assert.equal(ledger.degraded, true, 'getter 与快照必须一致');

    const first = ledger.record({ scope: 'plan', action: 'issued', approvalId: 'approval-1', bindings: { planHash: 'h1' } });
    const second = ledger.record({ scope: 'plan', action: 'consumed', approvalId: 'approval-1', bindings: { planHash: 'h1' } });
    assert.equal(first.degraded, true, '降级期写入的条目必须可事后识别');
    assert.equal(second.degraded, true);
    const after = ledger.snapshot();
    assert.deepEqual(after.chain, { ok: true, brokenAt: null, reason: '' }, '新链自身必须首尾相接（不改变验链行为）');
    assert.equal(after.entries.every((entry) => entry.degraded === true), true);

    // 落盘后重开（文件已由新链修好）：不再是降级态，但历史条目上的 degraded 标记不能被洗掉。
    const reopened = createApprovalLedger({ store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ entries: [] }) }) });
    const restored = reopened.snapshot();
    assert.equal(restored.degraded, false, '文件已修复，重开不应继续报降级');
    assert.equal(restored.degradedSince, null);
    assert.equal(restored.entries.length, 2);
    assert.equal(restored.entries[0].degraded, true, '降级标记参与 entryHash，重开后仍在');
    assert.deepEqual(restored.chain, { ok: true, brokenAt: null, reason: '' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('账本降级标记：正常账本/纯内存账本不带 degraded 字段（避免把正常路径也说成降级）', () => {
  const clean = createApprovalLedger();
  const snapshot = clean.snapshot();
  assert.equal(snapshot.degraded, false);
  assert.equal(snapshot.degradedSince, null);
  const entry = clean.record({ scope: 'write', action: 'issued', approvalId: 'approval-9', bindings: {} });
  assert.equal('degraded' in entry, false);
  assert.equal(snapshot.chain.ok, true);
});
