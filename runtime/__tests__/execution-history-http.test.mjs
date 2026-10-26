import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

const fakeKeychain = { async configured() { return false; }, async read() { throw new Error('unused'); } };
const fakeGui = { async execute() { return {}; } };
const fakeBridge = { port: 49620, selectedWindowId: 'window-1', async discover() {}, async windows() { return { selectionRequired: false, windows: [{ id: 'window-1' }] }; }, async execute() { return { ok: true, result: {} }; } };

const designExecutions = [
  { kind: 'schematic', id: 'e1', state: 'completed', planHash: 'plan-1', createdAt: '2026-10-19T00:00:00.000Z' },
  { kind: 'schematic', id: 'e2', state: 'rolled_back', planHash: 'plan-2', createdAt: '2026-10-18T00:00:00.000Z' },
];
const pcbExecutions = [{ kind: 'pcb', id: 'p1', state: 'completed', planHash: 'pplan-1', createdAt: '2026-10-19T01:00:00.000Z' }];

const fakeDesign = {
  persistenceError: null,
  list: () => designExecutions,
  get: (id) => (id === 'e1' ? { id: 'e1', state: 'completed', planHash: 'plan-1', events: [{ at: '2026-10-19T00:00:00.000Z', stage: 'readback', status: 'passed', detail: {} }] } : null),
  evidence: (id) => (id === 'e1' ? { id: 'e1', state: 'completed' } : null),
};
const fakePcb = {
  persistenceError: { code: 'EXECUTION_PERSIST_FAILED', message: '磁盘只读' },
  list: () => pcbExecutions,
  get: (id) => (id === 'p1' ? { id: 'p1', state: 'completed', planHash: 'pplan-1' } : null),
  evidence: (id) => fakePcb.get(id),
};

async function startServer(context) {
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge: fakeBridge, gui: fakeGui, design: fakeDesign, pcb: fakePcb });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  return { base, headers: { 'x-circuitpilot-token': health.sessionProof } };
}

// 运行时文件锁/状态文件落在状态目录：测试隔离，避免并行测试互相干扰。
process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-hist-state-'));

test('执行历史 HTTP：列表按重启后状态返回；按 id 取详情；不存在 404；落盘失败标志如实透出', async (context) => {
  const { base, headers } = await startServer(context);
  const design = await (await fetch(`${base}/api/design/executions`, { headers })).json();
  assert.equal(design.ok, true);
  assert.equal(design.executions.length, 2);
  assert.equal(design.persistenceError, null);
  const detail = await (await fetch(`${base}/api/design/executions/e1`, { headers })).json();
  assert.equal(detail.execution.planHash, 'plan-1');
  const missing = await fetch(`${base}/api/design/executions/nope`, { headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'EXECUTION_NOT_FOUND');

  const pcb = await (await fetch(`${base}/api/pcb/executions`, { headers })).json();
  assert.equal(pcb.ok, true);
  assert.equal(pcb.executions[0].id, 'p1');
  // 持久化失败绝不能静默：列表响应必须带出错误，让用户知道“历史可能没存住”。
  assert.equal(pcb.persistenceError.code, 'EXECUTION_PERSIST_FAILED');
  const pcbDetail = await (await fetch(`${base}/api/pcb/executions/p1`, { headers })).json();
  assert.equal(pcbDetail.execution.state, 'completed');
});
