import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAYER_IDS, copperLayerIds } from '../engineering/layers.mjs';
import { createRuntimeServer } from '../server.mjs';

/**
 * 产品 HTTP 层的"叠层铜层数"读写能力：
 *   GET  /api/eda/pcb/layers（只读）
 *   POST /api/eda/pcb/layers（受批准写入 + 写后读回校验 + 保存确认 + 取证）
 *
 * 全部离线：bridge 用忠实记录命令的假桥替换（不能无人值守驱动真实 EDA），
 * 其余都是产品真实代码路径（鉴权 / 批准门禁 / 路由 / 校验 / 证据落盘）。
 */

// 状态/证据/记忆文件必须隔离到临时目录：否则并行测试会互相抢文件锁，
// 或者读到开发机上真实用过的工程（"开发机绿、别的机器红"）。
process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-layers-http-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = process.env.CIRCUITPILOT_EVIDENCE_DIR || mkdtempSync(join(tmpdir(), 'cp-layers-http-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = process.env.CIRCUITPILOT_PROJECT_MEMO || join(tmpdir(), `cp-layers-http-memo-${process.pid}.json`);

const fakeKeychain = {
  async configured() { return false; },
  async read() { throw new Error('unused'); },
};

const fakeGui = { async execute() { return {}; } };

/** 官方 EPCB_LayerType 是字符串枚举，铜层为 'SIGNAL'；inner 层物理上一直存在，只是未启用。 */
function synthLayers(copperCount) {
  const layers = [
    { id: LAYER_IDS.TOP, name: 'Top Layer', type: 'SIGNAL', layerStatus: 1 },
    { id: LAYER_IDS.BOTTOM, name: 'Bottom Layer', type: 'SIGNAL', layerStatus: 1 },
  ];
  for (let id = 3; id <= 14; id += 1) {
    const type = id <= 4 ? 'SILKSCREEN' : (id <= 6 ? 'SOLDER_MASK' : 'OTHER');
    layers.push({ id, name: `Layer ${id}`, type, layerStatus: 0 });
  }
  for (let id = LAYER_IDS.INNER_1; id <= LAYER_IDS.LAST_INNER; id += 1) {
    // 与真实 EDA 一致：内层始终在列表里；当前叠层之外的铜层是"未使用"状态。
    const active = copperLayerIds(copperCount).includes(id);
    layers.push({ id, name: `Inner Layer ${id}`, type: 'SIGNAL', layerStatus: active ? 1 : 0 });
  }
  return layers;
}

function createFakeBridge({ copperCount = 2 } = {}) {
  const state = {
    copperCount,
    ignoreSetCount: false,
    saveCount: 0,
  };
  const calls = [];
  return {
    state,
    calls,
    port: 49620,
    selectedWindowId: 'window-1',
    async discover() {},
    async windows() { return { selectionRequired: false, windows: [{ id: 'window-1' }] }; },
    async execute(id, args = {}, options = {}) {
      calls.push({ id, args, options });
      switch (id) {
        case 'project.current':
          return { ok: true, result: { uuid: 'project-1', data: [] } };
        case 'document.current':
          return { ok: true, result: { uuid: 'doc-1', documentType: 3 } };
        case 'pcb.layers.copperCount':
          return { ok: true, result: state.copperCount };
        case 'pcb.layers.read':
          return { ok: true, result: synthLayers(state.copperCount) };
        case 'pcb.layers.setCount':
          // 忠实模拟官方 Beta API：只认 true/false；"返回 true 但层数没变"是真机出现过的情形。
          if (state.ignoreSetCount) return { ok: true, result: true };
          state.copperCount = Number(args.layers);
          return { ok: true, result: true };
        case 'pcb.save':
          state.saveCount += 1;
          return { ok: true, result: true };
        default:
          return { ok: true, result: {} };
      }
    },
  };
}

async function startServer(context, bridge) {
  const automationDir = mkdtempSync(join(tmpdir(), 'cp-layers-http-automation-'));
  const previousAutomationDir = process.env.CIRCUITPILOT_AUTOMATION_DIR;
  process.env.CIRCUITPILOT_AUTOMATION_DIR = automationDir;
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge, gui: fakeGui });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => {
    if (previousAutomationDir === undefined) delete process.env.CIRCUITPILOT_AUTOMATION_DIR;
    else process.env.CIRCUITPILOT_AUTOMATION_DIR = previousAutomationDir;
    rmSync(automationDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const headers = { 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = (path) => fetch(`${base}${path}`, { headers });
  return { base, headers, post, get };
}

/** 签发一次绑定当前 EDA 目标（窗口+工程+文档）的 write 批准。 */
async function issueWriteApproval(post) {
  const response = await post('/api/automation/approvals', { scope: 'write' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.approval?.approvalId, JSON.stringify(body));
  return body.approval.approvalId;
}

test('GET /api/eda/pcb/layers：返回当前 2 层铜层数与层列表', async (context) => {
  const bridge = createFakeBridge({ copperCount: 2 });
  const { get } = await startServer(context, bridge);

  const response = await get('/api/eda/pcb/layers');
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.layers.copperCount, 2);
  assert.equal(body.layers.count, body.layers.layers.length);
  assert.ok(body.layers.count > 2);
  const ids = body.layers.layers.map((layer) => layer.id);
  assert.ok(ids.includes(LAYER_IDS.TOP));
  assert.ok(ids.includes(LAYER_IDS.BOTTOM));
  // 只读路由不得产生任何写命令。
  assert.equal(bridge.calls.filter((call) => call.options?.allowWrite).length, 0);
});

test('POST /api/eda/pcb/layers：无批准时必须被服务端批准门禁拒绝，且不得写板', async (context) => {
  const bridge = createFakeBridge({ copperCount: 2 });
  const { post } = await startServer(context, bridge);

  const response = await post('/api/eda/pcb/layers', { copperLayers: 4 });
  const body = await response.json();
  assert.ok(response.status >= 400 && response.status < 500, `无批准必须 4xx，实际 ${response.status} ${JSON.stringify(body)}`);
  // 门禁错误码来自相邻写路由同一套批准服务；只断言"属于批准类"，不臆造具体码。
  assert.match(body.error.code, /APPROVAL/, JSON.stringify(body));
  assert.equal(bridge.calls.filter((call) => call.id === 'pcb.layers.setCount').length, 0, '未批准不得写板');
  assert.equal(bridge.calls.filter((call) => call.id === 'pcb.save').length, 0, '未批准不得保存');
});

test('POST /api/eda/pcb/layers：签发 write 批准后 2 层改 4 层，写后读回校验通过', async (context) => {
  const bridge = createFakeBridge({ copperCount: 2 });
  const { post } = await startServer(context, bridge);

  const approvalId = await issueWriteApproval(post);
  const response = await post('/api/eda/pcb/layers', { copperLayers: 4, approvalIds: [approvalId] });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.changed, true);
  assert.equal(body.copperLayers, 4);
  assert.equal(body.before.copperCount, 2);
  assert.equal(body.after.copperCount, 4);
  assert.deepEqual(body.verification.expectedLayerIds, [1, 15, 16, 2]);
  assert.equal(body.verification.matched, true);
  assert.equal(body.saved, true);

  // setCount 必须以"层数"传参并显式授权写入；四层板的内层确实是 15/16，不是 3/4。
  const setCountCalls = bridge.calls.filter((call) => call.id === 'pcb.layers.setCount');
  assert.equal(setCountCalls.length, 1);
  assert.equal(setCountCalls[0].args.layers, 4);
  assert.equal(setCountCalls[0].options.allowWrite, true);
  // 写后必须真的保存过一次。
  assert.equal(bridge.state.saveCount, 1);
});

test('POST /api/eda/pcb/layers：非法层数（3）在批准之前就 400', async (context) => {
  const bridge = createFakeBridge({ copperCount: 2 });
  const { post } = await startServer(context, bridge);

  // 不给批准：非法参数必须在批准门禁之前被拒，否则会白烧一次性批准。
  const response = await post('/api/eda/pcb/layers', { copperLayers: 3 });
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.error.code, 'EDA_COMMAND_ARGS_INVALID');
  assert.equal(bridge.calls.filter((call) => call.id === 'pcb.layers.setCount').length, 0);
});

test('POST /api/eda/pcb/layers：setCount 返回 true 但层数没变 → 409 PCB_LAYER_COUNT_VERIFY_FAILED', async (context) => {
  const bridge = createFakeBridge({ copperCount: 2 });
  // 复现实机 Beta API 的坑：命令返回 true，层列表却没变。
  bridge.state.ignoreSetCount = true;
  const { post } = await startServer(context, bridge);

  const approvalId = await issueWriteApproval(post);
  const response = await post('/api/eda/pcb/layers', { copperLayers: 4, approvalIds: [approvalId] });
  const body = await response.json();
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.error.code, 'PCB_LAYER_COUNT_VERIFY_FAILED');
  assert.equal(body.error.details.before.copperCount, 2);
  assert.equal(body.error.details.after.copperCount, 2);
  assert.deepEqual(body.error.details.expectedLayerIds, [1, 15, 16, 2]);
  // 读回不符不得保存、不得声称成功。
  assert.equal(bridge.state.saveCount, 0);
});
