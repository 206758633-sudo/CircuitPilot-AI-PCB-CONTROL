import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

/**
 * P0-1：用户批准的来源计划哈希必须沿计划/令牌/账本整链绑定；
 * 计划被换掉（哈希不一致）时写入口必须 409 APPROVAL_MISMATCH，而不是照写。
 */

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-p01-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-p01-evidence-'));
process.env.CIRCUITPILOT_AUTOMATION_DIR = mkdtempSync(join(tmpdir(), 'cp-p01-automation-'));
process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(tmpdir(), `cp-p01-drc-${process.pid}.json`);
process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmpdir(), `cp-p01-memo-${process.pid}.json`);

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const SEMANTIC = 'a'.repeat(64);
const COMPILED = 'b'.repeat(64);

const reviewedNetlistPlan = {
  kind: 'reviewed-netlist',
  nets: ['3V3', 'GND'],
  operations: [
    { type: 'component.create', args: { component: { libraryUuid: 'lib-mcu', uuid: 'dev-mcu' }, x: 10, y: 20 } },
    { type: 'net.connect', args: { net: '3V3', endpoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } },
  ],
};

function createOfflineBridge() {
  return {
    port: 49642,
    selectedWindowId: 'W-P01',
    async discover() { return { port: 49642 }; },
    async windows() { return { windows: [{ id: 'W-P01' }], selectedWindowId: 'W-P01', selectionRequired: false }; },
    listCommands() { return []; },
    async execute(id) { throw Object.assign(new Error(`P0-1 离线测试不应执行 EDA 命令：${id}`), { code: 'EDA_OFFLINE' }); },
  };
}

test('P0-1：批准绑定语义+编译双哈希；计划被换掉 → 409 APPROVAL_MISMATCH', async (context) => {
  const { server } = createRuntimeServer({ bridge: createOfflineBridge() });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } }).then((response) => response.json());
  const headers = { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  // 1) 批准：计划带来源双哈希。
  const approved = await post('/api/design/approve', {
    plan: { ...reviewedNetlistPlan, semanticPlanHash: SEMANTIC, compiledPlanHash: COMPILED },
    targetFingerprint: 'fp-current', windowId: 'W-P01',
  });
  assert.equal(approved.status, 200);
  const approval = (await approved.json()).approval;
  assert.ok(approval.token);
  assert.equal(approval.semanticPlanHash, SEMANTIC);
  assert.equal(approval.compiledPlanHash, COMPILED);

  // 2) 执行时计划已经被换掉（少了一个操作 → planHash 变）：必须在触碰 EDA 前 409。
  const tampered = await post('/api/design/execute', {
    plan: { ...reviewedNetlistPlan, operations: reviewedNetlistPlan.operations.slice(0, 1), semanticPlanHash: SEMANTIC, compiledPlanHash: COMPILED },
    approvalToken: approval.token, targetFingerprint: 'fp-current', windowId: 'W-P01',
  });
  assert.equal(tampered.status, 409);
  const body = await tampered.json();
  assert.equal(body.error?.code, 'APPROVAL_MISMATCH');
  assert.equal(body.error?.details?.field, 'planHash');
});

test('P0-1：PCB 计划/批准同样保留并可核对双哈希；换计划 → 409', async (context) => {
  const { server } = createRuntimeServer({ bridge: createOfflineBridge() });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } }).then((response) => response.json());
  const headers = { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  const plan = {
    title: 'P0-1 PCB 计划',
    board: { widthMm: 100, heightMm: 80, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 },
    operations: [{ type: 'pcb.importChanges', args: {} }, { type: 'pcb.save', args: {} }, { type: 'pcb.drc', args: {} }],
    semanticPlanHash: SEMANTIC,
    compiledPlanHash: COMPILED,
  };
  const normalized = await post('/api/pcb/plan', { plan });
  assert.equal(normalized.status, 200);
  const planning = (await normalized.json()).planning;
  assert.equal(planning.plan.semanticPlanHash, SEMANTIC);
  assert.equal(planning.plan.compiledPlanHash, COMPILED);

  const approved = await post('/api/pcb/approve', { plan: planning.plan, targetFingerprint: 'fp-pcb', windowId: 'W-P01' });
  assert.equal(approved.status, 200);
  const approval = (await approved.json()).approval;
  assert.equal(approval.semanticPlanHash, SEMANTIC);
  assert.equal(approval.compiledPlanHash, COMPILED);

  const tampered = await post('/api/pcb/execute', {
    plan: { ...planning.plan, operations: [{ type: 'pcb.save', args: {} }, { type: 'pcb.drc', args: {} }] },
    approvalToken: approval.token, targetFingerprint: 'fp-pcb', windowId: 'W-P01',
  });
  assert.equal(tampered.status, 409);
  assert.equal((await tampered.json()).error?.code, 'APPROVAL_MISMATCH');
});
