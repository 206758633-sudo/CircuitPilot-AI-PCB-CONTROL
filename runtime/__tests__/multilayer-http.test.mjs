import assert from 'node:assert/strict';
import test from 'node:test';
import { LAYER_IDS, copperLayerIds } from '../engineering/layers.mjs';
import { createRuntimeServer } from '../server.mjs';

/**
 * 走通“全流程”的最强离线证据：不直接调库函数，而是通过**真实运行时 HTTP 服务**
 * 完成 语义计划 -> 编译 -> 取上下文 -> 人工批准 -> 受控执行。
 * 桥被替换成忠实记录命令的假桥（无法在无人值守环境驱动 EDA 界面），
 * 除此之外全部是产品真实代码路径。
 */

const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

const stackupOf = (copperLayers) => ({
  id: `local-${copperLayers}l`, source: '本地记录的板厂叠层',
  layers: Array.from({ length: copperLayers * 2 - 1 }, (_, index) => (index % 2 === 0
    ? { name: `L${index / 2 + 1}`, type: 'copper', thicknessUm: 35 }
    : { name: `d${index}`, type: 'dielectric', thicknessMm: 0.2, er: 4.3 })),
});

function twelveLayerSemanticPlan() {
  return {
    projectId: 'http-12l', title: '12 层高速板',
    board: { widthMm: 80, heightMm: 60, layers: 12, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 },
    components: [
      { ref: 'U1', primitiveId: 'c-u1', footprint: 'BGA-256', side: 'top', placement: { xMm: 20, yMm: 20, rotation: 0 }, sizeMm: { width: 10, height: 10 } },
      { ref: 'U2', primitiveId: 'c-u2', footprint: 'QFN-48', side: 'top', placement: { xMm: 55, yMm: 40, rotation: 0 }, sizeMm: { width: 7, height: 7 } },
    ],
    nets: [
      { name: 'VBUS', class: 'power', endpoints: [{ ref: 'U1', pin: 'A1', xMm: 20, yMm: 20 }, { ref: 'U2', pin: 'VDD', xMm: 55, yMm: 40 }] },
      { name: 'DDR_DQ0', class: 'signal', layer: 'L4', endpoints: [{ ref: 'U1', pin: 'B1', xMm: 20, yMm: 25 }, { ref: 'U2', pin: 'D0', xMm: 55, yMm: 45 }] },
    ],
    silkscreen: [], decisions: [], evidence: [{ kind: 'stackup', id: 'stack-12l' }],
    constraints: { profileId: 'jlc-12l', minClearanceMm: 0.2, minCopperToEdgeMm: 0.3, impedance: { stackupSource: '板厂叠层单' }, stackup: stackupOf(12) },
  };
}

/** 忠实记录全部命令的假桥；除 EDA 本体外不替换任何产品代码。 */
function createRecordingBridge() {
  const commands = [];
  let source = '{"board":"before"}';
  const documentLayers = [...copperLayerIds(12), LAYER_IDS.BOARD_OUTLINE].map((id) => ({ id }));
  return {
    commands,
    selectedWindowId: 'W1',
    async execute(id, args = {}) {
      commands.push({ id, args });
      if (id === 'project.current') return { result: { uuid: 'P1' } };
      if (id === 'document.current') return { result: { uuid: 'D1', documentType: 3 } };
      if (id === 'pcb.layers.read') return { result: documentLayers };
      if (/^pcb\.(nets|components|lines|vias|pours|regions|texts)\.read$/.test(id)) return { result: [] };
      if (id === 'pcb.rules.read') return { result: {} };
      if (id === 'pcb.source.read') return { result: source };
      if (id === 'document.source.restore') { source = args.source; return { result: true }; }
      if (id === 'pcb.save') return { result: true };
      if (id === 'pcb.drc') return { result: [] };
      source = '{"board":"mutated"}';
      return { result: { primitiveId: `${id}-1` } };
    },
  };
}

async function startServer(bridge) {
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('真实 HTTP 服务上走通 12 层板全流程：编译 -> 批准 -> 受控执行', async (context) => {
  const bridge = createRecordingBridge();
  const { server, base } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const token = health.sessionProof;
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': token };
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  // 1) 编译语义计划：四层以上的计划必须能通过 HTTP 编译成可执行计划。
  const compiled = await post('/api/production/plans/compile', { plan: twelveLayerSemanticPlan() });
  assert.equal(compiled.status, 200, JSON.stringify(compiled.body));
  assert.equal(compiled.body.planning.ready, true, JSON.stringify(compiled.body.planning.issues));
  const executablePlan = compiled.body.planning.compiled;
  assert.ok(executablePlan && Array.isArray(executablePlan.operations));
  assert.equal(executablePlan.operations.at(-1).type, 'pcb.drc', '官方 DRC 必须是最后一个操作');

  // 2) 取真实上下文（目标指纹 + 窗口），并核对 12 层文档的铜层。
  const contextResponse = await fetch(`${base}/api/pcb/context`, { headers: { 'x-circuitpilot-token': token } });
  const contextBody = await contextResponse.json();
  assert.equal(contextResponse.status, 200, JSON.stringify(contextBody));
  const { targetFingerprint, windowId } = contextBody.context;
  assert.equal(typeof targetFingerprint, 'string');
  assert.equal(windowId, 'W1');

  // 3) 未批准不得执行：先证明门禁在 HTTP 层是活的（反向对照）。
  const beforeUnapproved = bridge.commands.length;
  const unapproved = await post('/api/pcb/execute', { plan: executablePlan, approvalToken: 'forged-token-1234567890', targetFingerprint, windowId });
  assert.ok(unapproved.status >= 400, `伪造令牌必须被拒绝: ${unapproved.status} ${JSON.stringify(unapproved.body)}`);
  const mutationsAfterUnapproved = bridge.commands.slice(beforeUnapproved).filter((command) => ['pcb.line.create', 'pcb.pour.create', 'pcb.via.create', 'pcb.component.modify'].includes(command.id));
  assert.equal(mutationsAfterUnapproved.length, 0, `未批准不得产生任何改板写入: ${JSON.stringify(mutationsAfterUnapproved)}`);

  // 4) 人工批准（一次性令牌绑定计划哈希 + 目标指纹 + 窗口）。
  const approved = await post('/api/pcb/approve', { plan: executablePlan, targetFingerprint, windowId });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const approvalToken = approved.body.approval.token;
  assert.ok(typeof approved.body.approval.planHash === 'string' && approved.body.approval.planHash.length > 0);
  assert.ok(typeof compiled.body.planning.compiledPlanHash === 'string' && compiled.body.planning.compiledPlanHash.length > 0);

  // 5) 受控执行。
  const executed = await post('/api/pcb/execute', { plan: executablePlan, approvalToken, targetFingerprint, windowId });
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(executed.body.execution.state, 'completed', JSON.stringify(executed.body.execution.error ?? {}));
  assert.equal(executed.body.execution.drc.passed, true, '官方 DRC 必须无报错才放行');

  // 6) 内层走线真正下发到 EDA：L4 必须换算成 17 层。
  const ids = bridge.commands.map((command) => command.id);
  assert.ok(bridge.commands.some((command) => command.id === 'pcb.line.create' && command.args.net === 'DDR_DQ0' && command.args.layer === 17), '内层走线未以 17 层下发');
  // 7) 受控执行属性未被削弱：DRC 晚于全部改板写入，且之后无写命令。
  const drcIndex = ids.lastIndexOf('pcb.drc');
  assert.ok(drcIndex > 0);
  for (const mutation of ['pcb.line.create', 'pcb.pour.create', 'pcb.via.create', 'pcb.component.modify']) {
    assert.ok(ids.lastIndexOf(mutation) < drcIndex, `官方 DRC 必须晚于 ${mutation}`);
  }
  assert.equal(executed.body.execution.planHash, approved.body.approval.planHash, '执行的必须是被批准的那一份计划');

  // 8) 一次性令牌：同一令牌不得重复执行。
  const replayed = await post('/api/pcb/execute', { plan: executablePlan, approvalToken, targetFingerprint, windowId });
  assert.ok(replayed.status >= 400, `批准令牌必须一次性: ${replayed.status} ${JSON.stringify(replayed.body)}`);

  // 9) 批准绑定计划内容：拿了令牌但换一块板，必须拒绝。
  const tampered = structuredClone(executablePlan);
  const firstLine = tampered.operations.find((operation) => operation.type === 'pcb.line.create');
  firstLine.args.endX = Number(firstLine.args.endX) + 5;
  const approveForTamper = await post('/api/pcb/approve', { plan: executablePlan, targetFingerprint, windowId });
  assert.equal(approveForTamper.status, 200, JSON.stringify(approveForTamper.body));
  const tamperedExecution = await post('/api/pcb/execute', { plan: tampered, approvalToken: approveForTamper.body.approval.token, targetFingerprint, windowId });
  assert.ok(tamperedExecution.status >= 400, `更换计划内容后批准必须失效: ${tamperedExecution.status} ${JSON.stringify(tamperedExecution.body)}`);
});

test('HTTP 能力清单如实反映扩容后的层数与档位', async (context) => {
  const { server, base } = await startServer(createRecordingBridge());
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const response = await fetch(`${base}/api/engineering/profiles`, { headers: { 'x-circuitpilot-token': health.sessionProof } });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.profiles.layers, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]);
  assert.equal(payload.profiles.maxCopperLayers, 32);
  assert.ok(payload.profiles.layerProfiles.includes('jlc-32l'), '能力清单必须包含高层数档位');

  // PCB 能力清单也必须如实描述现行层数范围。
  const capabilities = await (await fetch(`${base}/api/pcb/capabilities`, { headers: { 'x-circuitpilot-token': health.sessionProof } })).json();
  assert.equal(capabilities.ok, true);
  assert.ok(Array.isArray(capabilities.capabilities.items), '能力清单应带 items 数组');
  const multi = capabilities.capabilities.items.find((item) => item.id === 'multi-layer');
  assert.match(multi.reason, /32/, 'multi-layer 能力说明不得再声称只放行 2/4/6/8');
});
