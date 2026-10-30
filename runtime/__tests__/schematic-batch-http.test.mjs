import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-batch-http-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-batch-http-evidence-'));
process.env.CIRCUITPILOT_AUTOMATION_DIR = mkdtempSync(join(tmpdir(), 'cp-batch-http-automation-'));
process.env.CIRCUITPILOT_BATCH_DIR = mkdtempSync(join(tmpdir(), 'cp-batch-http-batches-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-batch-http-memo-')), 'memo.json');

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const device = (uuid) => ({ libraryUuid: 'lib-1', uuid });

function fakeBridge() {
  const parts = [{ primitiveId: 'existing-1', uuid: 'cap', libraryUuid: 'lib-1', x: 10, y: 10, props: { Designator: 'C1' } }];
  const created = [];
  let saved = false;
  return {
    parts, created,
    get saved() { return saved; },
    port: 49631,
    selectedWindowId: 'W-BATCH',
    async discover() { return { port: 49631 }; },
    async windows() { return { windows: [{ id: 'W-BATCH' }], selectedWindowId: 'W-BATCH', selectionRequired: false }; },
    listCommands() { return ['schematic.parts.read', 'schematic.component.create', 'schematic.save', 'project.current', 'document.current']; },
    async execute(id, args = {}) {
      if (id === 'project.current') return { result: { uuid: 'P-BATCH' } };
      if (id === 'document.current') return { result: { uuid: 'D-BATCH', documentType: 1 } };
      if (id === 'schematic.parts.read') return { result: parts.map((item) => ({ ...item })) };
      if (id === 'schematic.component.create') {
        const item = { primitiveId: `p-${parts.length + 1}`, uuid: args.component.uuid, libraryUuid: args.component.libraryUuid, x: args.x, y: args.y, props: { Designator: `U${parts.length + 1}` } };
        parts.push(item); created.push(item); return { result: item };
      }
      if (id === 'schematic.save') { saved = true; return { result: true }; }
      throw Object.assign(new Error(`不应执行的命令：${id}`), { code: 'EDA_OFFLINE' });
    },
  };
}

async function start() {
  const bridge = fakeBridge();
  const { server } = createRuntimeServer({ bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return { bridge, server, base, headers };
}

test('A6 HTTP：dryRun 只出计划不写盘；缺写板批准 409 且 0 次创建', async (context) => {
  const { bridge, server, base, headers } = await start();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });

  const items = [{ component: device('cap'), x: 10, y: 10 }, { component: device('cap'), x: 30, y: 10 }, { component: device('res'), x: 40, y: 10 }];
  const dry = await post('/api/eda/schematic/component-batch', { items, dryRun: true });
  assert.equal(dry.status, 200);
  const dryBody = await dry.json();
  assert.equal(dryBody.dryRun, true);
  assert.equal(dryBody.plan.counts.create, 2);
  assert.equal(dryBody.plan.counts.skipExisting, 1);
  assert.equal(dryBody.plan.items[0].matchedBy, 'identity');
  assert.equal(bridge.parts.length, 1, 'dryRun 不得写入');
  assert.equal(bridge.saved, false);

  const noApproval = await post('/api/eda/schematic/component-batch', { items, dryRun: false });
  assert.equal(noApproval.status, 409);
  const body = await noApproval.json();
  assert.equal(body.error.code, 'AUTOMATION_APPROVAL_REQUIRED');
  assert.equal(bridge.parts.length, 1, '缺批准必须在写入前停手');
  assert.equal(bridge.created.length, 0);
});

test('A6 HTTP：显式写板批准后批量执行 + 保存 + 读回验收；重复执行幂等', async (context) => {
  const { bridge, server, base, headers } = await start();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });

  const approval = await (await post('/api/automation/approvals', { scope: 'write', note: 'A6 测试：批量落件（离线假桥）' })).json();
  assert.equal(approval.ok, true);
  const approvalIds = [approval.approval.id || approval.approval.approvalId];

  const items = [{ component: device('cap'), x: 30, y: 10 }, { component: device('res'), x: 40, y: 10 }];
  const write = await post('/api/eda/schematic/component-batch', { items, dryRun: false, approvalIds, save: true });
  assert.equal(write.status, 200);
  const body = await write.json();
  assert.equal(body.applied.ok, true);
  assert.equal(body.applied.created.length, 2);
  assert.equal(body.applied.saved, true);
  assert.equal(body.applied.verification.ok, true);
  assert.equal(bridge.parts.length, 3);

  // 同一批准不能复用；但重复执行本身应该因"已存在"而 0 创建（用新批准验证幂等）。
  const approval2 = await (await post('/api/automation/approvals', { scope: 'write', note: 'A6 测试：幂等复跑' })).json();
  const again = await (await post('/api/eda/schematic/component-batch', { items, dryRun: false, approvalIds: [approval2.approval.id || approval2.approval.approvalId], save: true })).json();
  assert.equal(again.applied.created.length, 0);
  assert.equal(again.applied.skipped.length, 2);
  assert.equal(bridge.parts.length, 3, '重复执行不能产生重复件');
});
