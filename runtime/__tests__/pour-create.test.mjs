import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-pour-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-pour-evidence-'));
process.env.CIRCUITPILOT_AUTOMATION_DIR = mkdtempSync(join(tmpdir(), 'cp-pour-automation-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-pour-memo-')), 'memo.json');
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

function fakeBridge(state) {
  return {
    port: 49630,
    selectedWindowId: 'W-POUR',
    async discover() { return { port: 49630 }; },
    async windows() { return { windows: [{ id: 'W-POUR' }], selectedWindowId: 'W-POUR', selectionRequired: false }; },
    async execute(command, args = {}) {
      if (command === 'project.current') return { result: { uuid: 'P-POUR', data: [{ uuid: 'P-POUR', name: '覆铜测试板' }] } };
      if (command === 'document.current') return { result: { uuid: 'D-POUR', documentType: 3 } };
      if (command === 'pcb.pours.detail') return { result: state.pours.map((item) => ({ ...item })) };
      if (command === 'pcb.pour.create') {
        state.createCalls += 1;
        if (state.createFails) throw Object.assign(new Error('EDA 创建覆铜失败'), { code: 'BRIDGE_HTTP_ERROR' });
        const id = state.createId || `new-${state.pours.length + 1}`;
        state.pours.push({ primitiveId: id, net: state.createNet ?? args.net, layer: state.createLayer ?? args.layer, pourName: args.pourName });
        return { result: { primitiveId: id, net: args.net, layer: args.layer } };
      }
      if (command === 'pcb.pour.delete') {
        state.deleteCalls += 1;
        state.pours = state.pours.filter((item) => item.primitiveId !== args.primitiveId);
        return { result: { deleted: true, primitiveId: args.primitiveId } };
      }
      if (command === 'pcb.save') {
        state.saveCalls += 1;
        return { result: state.saveResult !== false };
      }
      throw Object.assign(new Error(`不应执行的命令：${command}`), { code: 'EDA_OFFLINE' });
    },
  };
}

async function startServer(context, overrides = {}) {
  const state = { pours: [{ primitiveId: 'p1', net: 'GND', layer: 1, pourName: 'GND' }], createCalls: 0, deleteCalls: 0, saveCalls: 0, ...overrides };
  const { server } = createRuntimeServer({ bridge: fakeBridge(state) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const issueWriteApproval = async () => {
    const issued = await (await post('/api/automation/approvals', { scope: 'write', note: 'A11 测试：新建覆铜' })).json();
    const approval = issued.approval || issued;
    return [approval.id || approval.approvalId];
  };
  return { state, post, issueWriteApproval };
}

const baseBody = { net: 'GND', layer: 1, outline: [[100, 100], [200, 100], [200, 200], [100, 200]], pourName: 'GND', save: true };

test('A11：新建覆铜必须带写板批准（缺批准不写）', async (context) => {
  const { state, post } = await startServer(context);
  const response = await post('/api/eda/pcb/pour/create', baseBody);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'AUTOMATION_APPROVAL_REQUIRED');
  assert.equal(state.createCalls, 0);
});

test('A11：新建→按网络/层读回→保存成功，返回真实 created/verification', async (context) => {
  const { state, post, issueWriteApproval } = await startServer(context);
  const approvalIds = await issueWriteApproval();
  const response = await post('/api/eda/pcb/pour/create', { ...baseBody, approvalIds });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'create');
  assert.equal(body.saved, true);
  assert.equal(body.created.net, 'GND');
  assert.equal(body.created.layer, 1);
  assert.equal(body.verification.newCount, 1);
  assert.equal(body.verification.matched.length, 1);
  assert.equal(state.pours.length, 2);
  assert.equal(state.saveCalls, 1);
});

test('A11：cleanup 验证模式——建后立即删并读回，不保存（用于真机自检）', async (context) => {
  const { state, post, issueWriteApproval } = await startServer(context);
  const approvalIds = await issueWriteApproval();
  const response = await post('/api/eda/pcb/pour/create', { ...baseBody, approvalIds, cleanup: true });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, 'verify-cleanup');
  assert.equal(body.cleanup.ok, true);
  assert.equal(body.saved, false);
  assert.equal(state.deleteCalls, 1);
  assert.equal(state.saveCalls, 0);
  assert.equal(state.pours.length, 1);
});

test('A11：读回网络/层不符 → 回滚新建并报 PCB_POUR_VERIFY_FAILED（不假通过）', async (context) => {
  const { state, post, issueWriteApproval } = await startServer(context, { createNet: 'SIG' });
  const approvalIds = await issueWriteApproval();
  const response = await post('/api/eda/pcb/pour/create', { ...baseBody, approvalIds });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'PCB_POUR_VERIFY_FAILED');
  assert.equal(state.deleteCalls, 1);
  assert.equal(state.pours.length, 1);
});

test('A11：保存未确认 → 回滚并报 SAVE_FAILED', async (context) => {
  const { state, post, issueWriteApproval } = await startServer(context, { saveResult: false });
  const approvalIds = await issueWriteApproval();
  const response = await post('/api/eda/pcb/pour/create', { ...baseBody, approvalIds });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'SAVE_FAILED');
  assert.equal(state.deleteCalls, 1);
  assert.equal(state.pours.length, 1);
});
