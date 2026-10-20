import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LAYER_IDS, copperLayerIds } from '../engineering/layers.mjs';
import { createRuntimeServer } from '../server.mjs';
import { inspectProductionArtifacts } from '../production.mjs';

// 真机踩过：本机登记过的 DRC 豁免会经"默认豁免文件"影响发布门禁判定（表现为开发机绿、别的机器红）。
// 单测必须把豁免文件隔离到临时路径，测的才是代码而不是这台机器的历史状态。
process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(tmpdir(), `cp-drc-exemptions-isolated-${process.pid}.json`);
// 同理隔离"上次用过的工程"记忆文件：否则测试会读/写这台机器真实用过的工程。
process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmpdir(), `cp-project-memo-isolated-${process.pid}.json`);
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), `cp-multilayer-evidence-${process.pid}-`));

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
// 运行时文件锁/状态文件落在状态目录：测试隔离，避免并行测试互相干扰。
process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-multi-state-'));

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
  let exportPayload = 'ISO-10303-21;\nHEADER;\n';
  const documentLayers = [...copperLayerIds(12), LAYER_IDS.BOARD_OUTLINE].map((id) => ({ id }));
  return {
    commands,
    setExportPayload(value) { exportPayload = value; },
    port: 49620,
    selectedWindowId: 'W1',
    async discover() { return { port: 49620 }; },
    async windows() { return { windows: [{ id: 'W1' }], selectedWindowId: 'W1', selectionRequired: false }; },
    listCommands() { return [{ id: 'document.current', permission: 'read' }, { id: 'pcb.open', permission: 'navigate' }]; },
    async execute(id, args = {}) {
      commands.push({ id, args });
      if (id === 'project.current') return { result: { uuid: 'P1' } };
      if (id === 'document.current') return { result: { uuid: 'D1', documentType: 3 } };
      if (id === 'pcb.layers.read') return { result: documentLayers };
      if (/^pcb\.(nets|components|lines|vias|pours|regions|texts|outline)\.read$/.test(id)) return { result: [] };
      if (id === 'pcb.rules.read') return { result: {} };
      if (id === 'pcb.source.read') return { result: source };
      if (id === 'document.source.restore') { source = args.source; return { result: true }; }
      if (id === 'pcb.save') return { result: true };
      // DRC 走 EDA 渲染进程后台任务：start 只回 jobId，poll 回结果信封。
      // 改造前这里是单次阻塞调用，真实板子上永远装不进一次 HTTP 预算。
      if (id === 'pcb.open') return { result: { opened: true, documentUuid: args.documentUuid } };
      if (id === 'pcb.3d.export') return { result: { exportId: 'e3d', name: 'CircuitPilot-Assembled-3D', size: Buffer.byteLength(exportPayload), chunkSize: 262144, chunks: 1, elements: ['Component Model', 'Via', 'Silkscreen', 'Wire In Signal Layer'] } };
      if (id === 'pcb.3d.chunk') return { result: { base64: Buffer.from(exportPayload, 'binary').toString('base64'), bytes: Buffer.byteLength(exportPayload), index: args.index } };
      if (id === 'pcb.drc.job.start') return { result: { jobId: args.jobId, accepted: true, state: 'running' } };
      if (id === 'pcb.job.poll') return { result: { jobId: args.jobId, state: 'done', result: { kind: 'array', count: 0, items: [], truncated: false } } };
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
  const drcIndex = ids.lastIndexOf('pcb.drc.job.start');
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

/**
 * 下单前闸门走真实 HTTP：body 自带证据（离线可复现），缺证据时必须阻断而不是放行。
 * 这条测试的价值在于"路由真的被发过请求"——上一个路由我用了本文件里不存在的解包函数，
 * node --check 看不出来，只有真发请求才会炸。
 */
test('POST /api/eda/release/gate：证据齐全可放行；缺证据一律阻断', async () => {
  const bridge = { port: 1, selectedWindowId: 'w1', async discover() { return { port: 1 }; }, async execute() { throw Object.assign(new Error('离线：不应触发实机读取'), { code: 'EDA_OFFLINE' }); } };
  const { server, base } = await startServer(bridge);
  try {
    // 运行时要求会话凭证：先取 /api/health 的 sessionProof（与其他路由测试同一套鉴权）
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
    const post = (payload) => fetch(`${base}/api/eda/release/gate`, { method: 'POST', headers, body: JSON.stringify(payload) });
    const placement = [{ ref: 'U1', xMm: 10, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }];
    const body = {
      userConfirmed: true,
      acceptance: { ready: true, netlist: { components: 2, nets: 2, namedPins: 4 }, findings: [], designChecks: { summary: { simulated: true, total: 1, passed: 1, failed: 0, notRun: 0, notApplicable: 0 }, results: [{ id: 'cc-rd', title: 'CC Rd', status: 'pass', spec: '0.25~0.61V', measured: { cc1: 0.42 } }] } },
      drcReport: { ok: true, items: [], reportedCount: 0, truncated: false, digest: 'f'.repeat(64) },
      placementVerification: { ok: true, checkedCount: 2, findings: [] },
      design: { designators: ['U1', 'U2'], placement, boardLayerCount: 2, coordinateToleranceMm: 0.05, netlistSha256: 'a'.repeat(64) },
      pricing: { entries: [{ lcsc: 'C1' }, { lcsc: 'C2' }], freshnessKnown: true },
      artifacts: [
        { kind: 'gerber', path: '/tmp/final-gerber.zip', bytes: 900, entries: [{ name: 'Gerber_TopLayer.GTL' }, { name: 'Gerber_BottomLayer.GBL' }, { name: 'Gerber_BoardOutlineLayer.GKO' }, { name: 'Drill_PTH_Through.DRL' }], gerber: { copper: { top: ['a.GTL'], bottom: ['b.GBL'], inner: [] }, outline: ['c.GKO'], drills: ['d.DRL'], copperLayerCount: 2 }, archive: { declaredCount: 4, consistent: true } },
        { kind: 'bom', path: '/tmp/final-bom.csv', bytes: 300, headers: ['Designator', 'Value', 'Supplier Part'], rows: [{ Designator: 'U1', Value: '', 'Supplier Part': 'C1' }, { Designator: 'U2', Value: '', 'Supplier Part': 'C2' }] },
        { kind: 'cpl', path: '/tmp/final-cpl.csv', bytes: 300, headers: ['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'], rows: [{ Designator: 'U1', 'Mid X': '10mm', 'Mid Y': '-20mm', Layer: 'T', Rotation: '0' }, { Designator: 'U2', 'Mid X': '28mm', 'Mid Y': '-11mm', Layer: 'T', Rotation: '0' }] },
        { kind: 'step', path: '/tmp/final.step', bytes: 90000, head: 'ISO-10303-21;' },
      ],
    };
    const okResponse = await post(body);
    assert.equal(okResponse.status, 200);
    const ok = await okResponse.json();
    const report = ok.result ?? ok;
    assert.equal(report.kind, 'fabrication-release-gate');
    assert.equal(report.ready, true, JSON.stringify(report.blockers));
    assert.equal(report.verdict, 'ready-to-order');
    assert.equal(report.humanSignoffRequired, true);

    // 同一个 body，只把"布局确认"撤掉 → 必须阻断
    const declined = await (await post({ ...body, userConfirmed: false })).json();
    const report2 = declined.result ?? declined;
    assert.equal(report2.ready, false);
    assert.ok(report2.blockers.some((item) => item.code === 'RELEASE_PLACEMENT_NOT_CONFIRMED'));

    // 显式声明"这些证据都没有"（null）→ 一律阻断，而且不许去实机读（假桥一被调用就抛 EDA_OFFLINE）
    const empty = await (await post({ acceptance: null, placementVerification: null, design: { designators: [], placement: [], boardLayerCount: null } })).json();
    const report3 = empty.result ?? empty;
    assert.equal(report3.ready, false);
    assert.ok(report3.blockers.length >= 4, JSON.stringify(report3.blockers));
    // 反过来：什么都不传（没传 = 请去实机读）→ 假桥抛错 → 如实 400，不假装成功
    const liveAttempt = await fetch(`${base}/api/eda/release/gate`, { method: 'POST', headers, body: JSON.stringify({}) });
    assert.equal(liveAttempt.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * 布局微调与门禁的 HTTP 回归。
 *
 * 这两条路由是**真机 HTTP 抓出来的 bug** 换来的：一开始它们直接 bridge.execute，
 * 忘了先 discover，真机发请求立刻 400 BRIDGE_NOT_FOUND；离线单测当时全绿也照样漏。
 * 所以这里对"路由真的被请求过"这件事本身做断言。
 */
test('POST /api/eda/pcb/placement/plan：路由自己打开文档、先发现桥、返回方案与复核', async () => {
  const calls = [];
  const bridge = {
    port: 49620,
    selectedWindowId: 'W1',
    async discover() { return { port: 49620 }; },
    async windows() { return { windows: [{ id: 'W1' }], selectedWindowId: 'W1', selectionRequired: false }; },
    async execute(id, args = {}) {
      calls.push({ id, args });
      if (id === 'pcb.open') return { result: { opened: true, tabId: 'T1' } };
      if (id === 'pcb.placement.read') {
        return {
          result: {
            outline: [{ source: [0, 0, 'L', 2362.2047, 0, 2362.2047, -1574.8031, 0, -1574.8031, 0, 0] }],
            components: [
              { designator: 'U1', primitiveId: 'p-u1', xMm: 10, yMm: -20, rotationDeg: 0, layerSide: 'top', padCount: 25, bboxMm: { xMm: 3.5, yMm: 3.5 }, nets: ['GND', '3V3'] },
              { designator: 'U2', primitiveId: 'p-u2', xMm: 28, yMm: -11, rotationDeg: 0, layerSide: 'top', padCount: 10, bboxMm: { xMm: 3, yMm: 3 } },
            ],
          },
        };
      }
      return { result: null };
    },
  };
  const { server, base } = await startServer(bridge);
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
    const response = await fetch(`${base}/api/eda/pcb/placement/plan`, { method: 'POST', headers, body: JSON.stringify({ pcbUuid: 'PCB1' }) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.componentCount, 2);
    assert.equal(body.outline.closed, true);
    assert.equal(body.plan.placements.length, 2);
    assert.ok(body.verification, '方案必须带独立复核');
    assert.ok(body.currentVerification, '现状也要复核，否则无法说明"改前就有问题"');
    assert.ok(calls.some((call) => call.id === 'pcb.open' && call.args.documentUuid === 'PCB1'), '给了 pcbUuid 就必须由路由自己打开文档');
    assert.ok(calls.some((call) => call.id === 'pcb.placement.read'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/eda/release/gate：DRC 报告按路径读真文件；路径不存在必须 400 而不是当作"没问题"', async () => {
  const bridge = { port: 1, selectedWindowId: 'w1', async discover() { return { port: 1 }; }, async windows() { return { windows: [{ id: 'w1' }], selectedWindowId: 'w1', selectionRequired: false }; }, async execute() { throw Object.assign(new Error('离线：不应触发实机读取'), { code: 'EDA_OFFLINE' }); } };
  const { server, base } = await startServer(bridge);
  const dir = mkdtempSync(join(tmpdir(), 'cp-drc-'));
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
    const post = (payload) => fetch(`${base}/api/eda/release/gate`, { method: 'POST', headers, body: JSON.stringify(payload) });

    // 路径不存在：必须 400 且说清路径，绝不能变成"没有 DRC 报告 ⇒ 放行"
    const missing = await post({ drcReportPath: join(dir, 'nope.json') });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, 'EDA_COMMAND_ARGS_INVALID');

    // 真报告（2 条未处理、无豁免）→ DRC 闸门必须是 blocked，不能是 unknown
    const reportPath = join(dir, 'drc.json');
    writeFileSync(reportPath, JSON.stringify({ ok: true, items: [{ name: 'Clearance', errorType: 'Clearance Error' }, { name: 'Connection', errorType: 'Connection Error' }], reportedCount: 2, truncated: false, digest: 'e'.repeat(64) }), 'utf8');
    const basePayload = {
      userConfirmed: true,
      acceptance: { ready: true, netlist: { components: 2, nets: 2, namedPins: 4 }, findings: [], designChecks: { summary: { simulated: true, total: 1, passed: 1, failed: 0, notRun: 0, notApplicable: 0 }, results: [] } },
      placementVerification: { ok: true, checkedCount: 2, findings: [] },
      design: { designators: ['U1', 'U2'], placement: [{ ref: 'U1', xMm: 10, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }], boardLayerCount: 2, coordinateToleranceMm: 0.05, netlistSha256: 'a'.repeat(64) },
      pricing: { entries: [{ lcsc: 'C1' }, { lcsc: 'C2' }], freshnessKnown: true },
      artifacts: [
        { kind: 'gerber', path: join(dir, 'g.zip'), bytes: 900, entries: [{ name: 'a.GTL' }, { name: 'b.GBL' }, { name: 'c.GKO' }, { name: 'd.DRL' }], gerber: { copper: { top: ['a.GTL'], bottom: ['b.GBL'], inner: [] }, outline: ['c.GKO'], drills: ['d.DRL'], copperLayerCount: 2 }, archive: { declaredCount: 4, consistent: true } },
        { kind: 'bom', path: join(dir, 'bom.csv'), bytes: 300, headers: ['Designator', 'Value', 'Supplier Part'], rows: [{ Designator: 'U1', Value: '', 'Supplier Part': 'C1' }, { Designator: 'U2', Value: '', 'Supplier Part': 'C2' }] },
        { kind: 'cpl', path: join(dir, 'cpl.csv'), bytes: 300, headers: ['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'], rows: [{ Designator: 'U1', 'Mid X': '10mm', 'Mid Y': '-20mm', Layer: 'T', Rotation: '0' }, { Designator: 'U2', 'Mid X': '28mm', 'Mid Y': '-11mm', Layer: 'T', Rotation: '0' }] },
        { kind: 'step', path: join(dir, 'b.step'), bytes: 90000, head: 'ISO-10303-21;' },
      ],
    };
    const withReport = await (await post({ ...basePayload, drcReportPath: reportPath })).json();
    const report = withReport.result ?? withReport;
    const drcGate = report.gates.find((gate) => gate.id === 'drc');
    assert.equal(drcGate.status, 'blocked', JSON.stringify(drcGate));
    assert.ok(report.blockers.some((item) => item.code === 'RELEASE_DRC_UNEXPLAINED'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** 真机踩过的两个坑：读不到 PCB 时原样 500；原理图切标签后没等它就导出空网表。 */
test('POST /api/eda/pcb/placement/plan：当前文档不是 PCB 时给可操作指引（409），不原样抛桥的 500', async () => {
  const bridge = {
    port: 1,
    selectedWindowId: 'W1',
    async discover() { return { port: 1 }; },
    async windows() { return { windows: [{ id: 'W1' }], selectedWindowId: 'W1', selectionRequired: false }; },
    async execute(id) {
      if (id === 'pcb.placement.read') throw Object.assign(new Error('Bridge HTTP 500'), { code: 'BRIDGE_HTTP_ERROR' });
      if (id === 'document.current') return { result: { uuid: 'sch-1', documentType: 1 } };
      return { result: null };
    },
  };
  const { server, base } = await startServer(bridge);
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
    const response = await fetch(`${base}/api/eda/pcb/placement/plan`, { method: 'POST', headers, body: JSON.stringify({}) });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.error.code, 'EDA_DOCUMENT_REQUIRED');
    assert.match(body.error.message, /PCB/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/eda/release/gate：原理图打开了却始终没成为活动文档 → 409，绝不用空网表下结论', async () => {
  let currentCalls = 0;
  const bridge = {
    port: 1,
    selectedWindowId: 'W1',
    async discover() { return { port: 1 }; },
    async windows() { return { windows: [{ id: 'W1' }], selectedWindowId: 'W1', selectionRequired: false }; },
    async execute(id) {
      if (id === 'schematic.open') return { result: { opened: true, tabId: 'T1' } };
      if (id === 'document.current') { currentCalls += 1; return { result: { uuid: 'pcb-1', documentType: 3 } }; }
      throw Object.assign(new Error(`不该走到这里：${id}`), { code: 'UNEXPECTED_COMMAND' });
    },
  };
  const { server, base } = await startServer(bridge);
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
    const response = await fetch(`${base}/api/eda/release/gate`, { method: 'POST', headers, body: JSON.stringify({ pageUuid: 'PAGE1' }) });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.error.code, 'EDA_DOCUMENT_OPEN_FAILED');
    assert.ok(currentCalls >= 2, '必须轮询活动文档，而不是盲等一个固定时长');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * 产出决策路由：门禁没通过就只能出草稿。
 * 这条测试同时守住"单一事实来源"——门禁报告里的 outputDecision 与专门路由的结论必须一致，
 * 否则会出现"界面说能下单、导出脚本说不能"这种最难查的分歧。
 */
test('POST /api/production/release：门禁没过只能出草稿；通过后按正式命名放行', async () => {
  const bridge = { port: 1, selectedWindowId: 'w1', async discover() { return { port: 1 }; }, async windows() { return { windows: [{ id: 'w1' }], selectedWindowId: 'w1', selectionRequired: false }; }, async execute() { throw Object.assign(new Error('离线：不应触发实机读取'), { code: 'EDA_OFFLINE' }); } };
  const { server, base } = await startServer(bridge);
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
    const post = (path, payload) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });

    // 全套齐全的离线证据（与门禁测试同一份，便于比对两处结论）
    const green = {
      userConfirmed: true,
      acceptance: { ready: true, netlist: { components: 2, nets: 2, namedPins: 4 }, findings: [], designChecks: { summary: { simulated: true, total: 1, passed: 1, failed: 0, notRun: 0, notApplicable: 0 }, results: [] } },
      drcReport: { ok: true, items: [], reportedCount: 0, truncated: false, digest: 'f'.repeat(64) },
      placementVerification: { ok: true, checkedCount: 2, findings: [] },
      design: { designators: ['U1', 'U2'], placement: [{ ref: 'U1', xMm: 10, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }], boardLayerCount: 2, coordinateToleranceMm: 0.05, netlistSha256: 'a'.repeat(64) },
      pricing: { entries: [{ lcsc: 'C1' }, { lcsc: 'C2' }], freshnessKnown: true },
      artifacts: [
        { kind: 'gerber', path: '/tmp/final-gerber.zip', bytes: 900, entries: [{ name: 'Gerber_TopLayer.GTL' }, { name: 'Gerber_BottomLayer.GBL' }, { name: 'Gerber_BoardOutlineLayer.GKO' }, { name: 'Drill_PTH_Through.DRL' }], gerber: { copper: { top: ['a.GTL'], bottom: ['b.GBL'], inner: [] }, outline: ['c.GKO'], drills: ['d.DRL'], copperLayerCount: 2 }, archive: { declaredCount: 4, consistent: true } },
        { kind: 'bom', path: '/tmp/final-bom.csv', bytes: 300, headers: ['Designator', 'Value', 'Supplier Part'], rows: [{ Designator: 'U1', Value: '', 'Supplier Part': 'C1' }, { Designator: 'U2', Value: '', 'Supplier Part': 'C2' }] },
        { kind: 'cpl', path: '/tmp/final-cpl.csv', bytes: 300, headers: ['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'], rows: [{ Designator: 'U1', 'Mid X': '10mm', 'Mid Y': '-20mm', Layer: 'T', Rotation: '0' }, { Designator: 'U2', 'Mid X': '28mm', 'Mid Y': '-11mm', Layer: 'T', Rotation: '0' }] },
        { kind: 'step', path: '/tmp/final.step', bytes: 90000, head: 'ISO-10303-21;' },
      ],
    };

    // 1) 门禁通过 → 允许正式产出，且示例文件名里不能有 DRAFT
    const ok = await (await post('/api/production/release', { ...green, requested: 'final' })).json();
    assert.equal(ok.allowed, true, JSON.stringify(ok));
    assert.equal(ok.outputClass, 'final');
    assert.ok(ok.exampleNames.every((name) => !/DRAFT/i.test(name)));
    assert.equal(ok.humanSignoffRequired, true);

    // 2) 同一份证据砍掉布局确认 → 门禁阻断 → 正式产出被拒，但草稿仍可出
    const blockedPayload = { ...green, userConfirmed: false };
    const refused = await (await post('/api/production/release', { ...blockedPayload, requested: 'final' })).json();
    assert.equal(refused.allowed, false);
    assert.equal(refused.code, 'PRODUCTION_OUTPUT_BLOCKED');
    assert.ok(refused.blockers.includes('RELEASE_PLACEMENT_NOT_CONFIRMED'), JSON.stringify(refused.blockers));
    const draft = await (await post('/api/production/release', { ...blockedPayload, requested: 'draft' })).json();
    assert.equal(draft.allowed, true);
    assert.equal(draft.outputClass, 'draft');
    assert.equal(draft.naming.suffix, '-DRAFT-NOT-FOR-ORDER');

    // 3) 单一事实来源：门禁报告里的 outputDecision 必须与专门路由的结论一致
    const gateRoute = await (await post('/api/eda/release/gate', blockedPayload)).json();
    const report = gateRoute.result ?? gateRoute;
    assert.equal(report.outputDecision.allowed, refused.allowed);
    assert.equal(report.outputDecision.code, refused.code);
    assert.deepEqual(report.outputDecision.blockers, refused.blockers);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** 手搓一个只有中央目录的 zip（条目名 + EOCD 声明数），够 gateArtifacts 校验用。 */
function exportTestZip(names) {
  const parts = [];
  for (const name of names) {
    const header = Buffer.alloc(46);
    header.write('PK\x01\x02', 0, 'latin1');
    header.writeUInt16LE(Buffer.byteLength(name), 28);
    header.writeUInt32LE(0, 24);
    parts.push(Buffer.concat([header, Buffer.from(name, 'latin1')]));
  }
  const central = Buffer.concat(parts);
  const eocd = Buffer.alloc(22);
  eocd.write('PK\x05\x06', 0, 'latin1');
  eocd.writeUInt16LE(names.length, 10);
  return Buffer.concat([central, eocd]);
}

/**
 * 生产文件导出路由：**没获准就不许写盘**；草稿获准就真写盘（带草稿标记 + 清单）。
 * 这条测试用手搓的 Gerber zip / BOM / CPL 字节走**真实的落盘与复核代码**，
 * 因此"文件写了没有""复核结论是什么"都不是靠 mock 假装的。
 */
test('POST /api/production/export：未获准不写盘；草稿获准后真写盘并出清单', async () => {
  const gerberBytes = exportTestZip(['Gerber_TopLayer.GTL', 'Gerber_BottomLayer.GBL', 'Gerber_BoardOutlineLayer.GKO', 'Drill_PTH_Through.DRL']);
  const bomBytes = Buffer.from('Designator,Value,Supplier Part\nU1,,C529344\nU2,,C49851\n');
  const cplBytes = Buffer.from('Designator,Mid X,Mid Y,Layer,Rotation\nU1,10mm,-20mm,T,0\nU2,28mm,-11mm,T,0\n');
  const payloads = { gerber: gerberBytes, bom: bomBytes, cpl: cplBytes };
  const calls = [];
  const bridge = {
    port: 1, selectedWindowId: 'w1',
    async discover() { return { port: 1 }; },
    async windows() { return { windows: [{ id: 'w1' }], selectedWindowId: 'w1', selectionRequired: false }; },
    async execute(commandId, args) {
      calls.push({ commandId, args });
      if (commandId === 'pcb.manufacture.export') {
        const body = payloads[args.kind];
        return { result: { exportId: `exp-${args.kind}123456`, kind: args.kind, name: `${args.fileName}.bin`, size: body.length, chunkSize: 262144, chunks: 1 } };
      }
      if (commandId === 'pcb.export.chunk') {
        const kind = String(args.exportId).replace(/^exp-/, '').replace(/123456$/, '');
        const body = payloads[kind];
        return { result: { index: 0, total: 1, bytes: body.length, size: body.length, base64: body.toString('base64') } };
      }
      throw Object.assign(new Error(`离线：不应触发 ${commandId}`), { code: 'EDA_OFFLINE' });
    },
  };
  const { server, base } = await startServer(bridge);
  const outRoot = mkdtempSync(join(tmpdir(), 'cp-http-export-'));
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
    const post = (path, payload) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });

    const evidence = {
      userConfirmed: false,
      acceptance: { ready: false, netlist: { components: 2, nets: 1, namedPins: 2 }, findings: [{ code: 'ACCEPTANCE_NETLIST_DANGLING', severity: 'blocking', message: 'CC1 悬空' }], designChecks: { summary: { simulated: false, total: 0, passed: 0, failed: 0, notRun: 0, notApplicable: 0 }, results: [] } },
      design: { designators: ['U1', 'U2'], placement: [{ ref: 'U1', xMm: 10, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }], boardLayerCount: 2, coordinateToleranceMm: 0.05, netlistSha256: 'a'.repeat(64) },
      placementVerification: { ok: true, checkedCount: 2, findings: [] },
      drcReport: { ok: true, items: [], reportedCount: 0, truncated: false, digest: 'f'.repeat(64) },
      artifacts: [],
    };

    // 1) 申请正式产出：门禁没过 → 拒绝，且**一个文件都不许写**（连目录都不建）
    const refusedDir = join(outRoot, 'final');
    const refused = await (await post('/api/production/export', { ...evidence, requested: 'final', outDir: refusedDir })).json();
    assert.equal(refused.exported, false);
    assert.deepEqual(refused.wrote, []);
    assert.equal(refused.code, 'PRODUCTION_OUTPUT_BLOCKED');
    assert.equal(existsSync(refusedDir), false, '被拒时目录都不许出现');

    // 2) 申请草稿产出：获准 → 真写盘（草稿命名 + 清单），且导出后复核用门禁同一套规则
    const draftDir = join(outRoot, 'draft');
    const drafted = await (await post('/api/production/export', { ...evidence, requested: 'draft', outDir: draftDir })).json();
    assert.equal(drafted.exported, true, JSON.stringify(drafted).slice(0, 400));
    assert.equal(drafted.wrote.length, 3);
    const names = readdirSync(draftDir).sort();
    assert.deepEqual(names, [
      'BOM_CircuitPilot-bom-DRAFT-NOT-FOR-ORDER.csv',
      'CPL_CircuitPilot-cpl-DRAFT-NOT-FOR-ORDER.csv',
      'GERBER_CircuitPilot-gerber-DRAFT-NOT-FOR-ORDER.zip',
      'manifest.json',
    ].sort());
    assert.equal(readFileSync(join(draftDir, 'GERBER_CircuitPilot-gerber-DRAFT-NOT-FOR-ORDER.zip')).length, gerberBytes.length);
    const manifest = JSON.parse(readFileSync(join(draftDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.released, false, '草稿永远不算已放行');
    assert.equal(manifest.verification.status, 'pass', `草稿也要过内容复核：${JSON.stringify(manifest.verification.findings)}`);
    assert.ok(manifest.verification.waived.length >= 3, '豁免的检查必须如实记进清单，不能悄悄丢掉');
    assert.ok(manifest.verification.waived.every((item) => item.why && item.why.length > 8), '每条豁免都要写清为什么');
    assert.ok(calls.some((call) => call.commandId === 'pcb.manufacture.export' && call.args.kind === 'gerber'));

    // 3) 自产草稿豁免（真机踩到的"鸡生蛋"）：目录里已经躺着上一轮草稿时，`requested:'final'`
    //    必须仍能出正式件——否则正式导出这条路永远是死的（门禁要求无草稿、而草稿只能靠正式导出替换）。
    const artifactDir = mkdtempSync(join(outRoot, 'artifacts-'));
    const drafts = {
      gerber: join(artifactDir, 'GERBER_CircuitPilot-gerber-DRAFT-NOT-FOR-ORDER.zip'),
      bom: join(artifactDir, 'BOM_CircuitPilot-bom-DRAFT-NOT-FOR-ORDER.csv'),
      cpl: join(artifactDir, 'CPL_CircuitPilot-cpl-DRAFT-NOT-FOR-ORDER.csv'),
      step: join(artifactDir, 'STEP_CircuitPilot-assembled.step'),
    };
    writeFileSync(drafts.gerber, gerberBytes);
    writeFileSync(drafts.bom, bomBytes);
    writeFileSync(drafts.cpl, cplBytes);
    writeFileSync(drafts.step, Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\n', 'utf8'));
    const finalEvidence = {
      userConfirmed: true,
      artifactsDir: artifactDir,
      acceptance: { ready: true, netlist: { components: 2, nets: 1, namedPins: 2, meta: { sha256: 'b'.repeat(64) } }, findings: [], designChecks: { summary: { simulated: true, total: 1, passed: 1, failed: 0, notRun: 0, notApplicable: 0 }, results: [{ id: 'cc-rd', title: 'USB-C CC 下拉', status: 'pass', spec: '0.25~0.61V', measured: { cc1: 0.41 } }] } },
      design: { designators: ['U1', 'U2'], placement: [{ ref: 'U1', xMm: 10, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }], boardLayerCount: 2, coordinateToleranceMm: 0.05, netlistSha256: 'b'.repeat(64) },
      placementVerification: { ok: true, checkedCount: 2, findings: [] },
      drcReport: { ok: true, items: [], reportedCount: 0, truncated: false, digest: 'f'.repeat(64) },
      artifacts: Object.entries(drafts).map(([kind, path]) => ({ kind, path, bytes: readFileSync(path).length })),
    };
    // 断言聚焦"这次修的那个开关"：草稿标记**不再是**正式导出的阻断原因。
    // （本夹具的 gerber/BOM 内容不是真 EDA 格式，内容类检查照旧会拦——那不影响这条判据。）
    const finalOut = join(outRoot, 'final-after-draft');
    const finalResult = await (await post('/api/production/export', { ...finalEvidence, requested: 'final', outDir: finalOut })).json();
    const blockerCodes = finalResult.gate?.blockerCodes || [];
    assert.ok(!blockerCodes.includes('RELEASE_ARTIFACT_DRAFT_MARKER'), `本目录内的自产草稿必须被"将被替换"豁免：${JSON.stringify(blockerCodes)}`);

    // 反向对照：把 artifactsDir 指到别的（空）目录，同一批草稿就不在"将被替换"范围内 → 必须照旧阻断。
    const elsewhere = mkdtempSync(join(outRoot, 'elsewhere-'));
    const notWaived = await (await post('/api/production/export', { ...finalEvidence, artifactsDir: elsewhere, requested: 'final', outDir: join(outRoot, 'final-not-waived') })).json();
    assert.ok((notWaived.gate?.blockerCodes || []).includes('RELEASE_ARTIFACT_DRAFT_MARKER'), '目录外的草稿不许被豁免（否则随便放个草稿就能绕过闸门）');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(outRoot, { recursive: true, force: true });
  }
});

/**
 * 下单参数卡：只读、不写 EDA；事实来自板子实测，假设必须显式，价格不许猜。
 * 这条测试用手搓的板框/层数走真实路由，因此"实测值从哪来"不是靠 mock 假装。
 */
test('POST /api/production/order-card：实测事实 + 参数一致性 + 草稿文件必须拦住', async () => {
  const calls = [];
  const bridge = {
    port: 1, selectedWindowId: 'w1',
    async discover() { return { port: 1 }; },
    async windows() { return { windows: [{ id: 'w1' }], selectedWindowId: 'w1', selectionRequired: false }; },
    async execute(commandId) {
      calls.push(commandId);
      if (commandId === 'pcb.open') return { result: { opened: true } };
      if (commandId === 'pcb.placement.read') {
        // 真机同款：板框是 mil 单位的闭合多边形（60.0×40.0mm）
        return { result: { outline: [{ source: [0, 0, 'L', 2362.2047, 0, 2362.2047, -1574.8031, 0, -1574.8031, 0, 0] }], components: [{ designator: 'U1' }, { designator: 'U2' }] } };
      }
      if (commandId === 'pcb.layers.copperCount') return { result: 6 };
      throw Object.assign(new Error(`离线：不应触发 ${commandId}`), { code: 'EDA_OFFLINE' });
    },
  };
  const { server, base } = await startServer(bridge);
  const dir = mkdtempSync(join(tmpdir(), 'cp-order-'));
  try {
    // 目录里放三个"草稿命名"的文件（真机导出的就是这个命名）
    for (const name of ['GERBER_CircuitPilot-gerber-DRAFT-NOT-FOR-ORDER.zip', 'BOM_CircuitPilot-bom-DRAFT-NOT-FOR-ORDER.csv', 'CPL_CircuitPilot-cpl-DRAFT-NOT-FOR-ORDER.csv']) {
      writeFileSync(join(dir, name), 'x');
    }
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
    const post = (payload) => fetch(`${base}/api/production/order-card`, { method: 'POST', headers, body: JSON.stringify(payload) });

    // 1) 实测：板框 60×40mm、铜层 6；请求 4 层 → 层数不一致必须阻断
    const mismatch = await (await post({ pcbUuid: '10886966233af924', artifactsDir: dir, requested: { layers: 4 }, drcReport: { items: [{ disposition: 'must-fix' }], byNet: { GND: 1, VCC: 1 } } })).json();
    assert.deepEqual(mismatch.derived.sizeMm, { x: 60, y: 40 });
    assert.equal(mismatch.derived.copperLayerCount, 6);
    assert.equal(mismatch.derived.componentCount, 2);
    assert.equal(mismatch.derived.netCount, 2, '网络数来自 DRC 报告的 byNet');
    assert.ok(mismatch.findings.some((item) => item.code === 'ORDER_LAYER_COUNT_MISMATCH' && item.severity === 'blocking'));
    assert.equal(mismatch.readyToOrder, false);
    // 关键：路由自己打开了 PCB（小白用户不该手动切文档）
    assert.ok(calls.includes('pcb.open') && calls.includes('pcb.placement.read'));

    // 2) 六个实测值都对上，但文件是草稿 → 仍然不许下单，且指名道姓
    const drafted = await (await post({ pcbUuid: '10886966233af924', artifactsDir: dir, requested: { layers: 6 }, drcReport: { items: [], byNet: { GND: 1 } } })).json();
    assert.equal(drafted.findings.filter((item) => item.code === 'ORDER_FILE_IS_DRAFT').length, 3);
    assert.equal(drafted.readyToOrder, false);
    assert.equal(drafted.price.status, 'unknown', '没有报价来源就必须写 unknown');
    assert.match(drafted.price.reason, /不猜价格/);
    assert.ok(drafted.assumptions.some((item) => item.field === 'capability' && item.why.includes('板厂官网')), '示例能力档必须作为假设显式列出');

    // 3) 显式给了实测事实就不该再碰 EDA（离线可复现）
    const callsBefore = calls.length;
    const offlined = await (await post({ facts: { sizeMm: { x: 60, y: 40 }, copperLayerCount: 6, componentCount: 8, netCount: 13, drcMustFixCount: 0, drcItemCount: 0, impedanceNets: [] }, files: [{ kind: 'gerber', name: 'g.zip', path: '/x/g.zip' }, { kind: 'bom', name: 'b.csv', path: '/x/b.csv' }, { kind: 'cpl', name: 'c.csv', path: '/x/c.csv' }], requested: { layers: 6 }, price: { amount: 99, currency: 'CNY', source: 'fab-api' } })).json();
    assert.equal(calls.length, callsBefore, '给了 facts 就不该再去读 EDA');
    assert.equal(offlined.readyToOrder, true, JSON.stringify(offlined.findings));
    assert.equal(offlined.counts.blocking, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 原理图自动修复路由：dry-run 绝不写盘；真写必须 addIntoPcb=true（否则元件不进网表，
 * 复核和验收都看不到——这是真机踩出来的坑）；写完必须重跑验收，且复核不过要回滚。
 */
test('POST /api/eda/schematic/repair：dry-run 不写盘；真写带授权、addIntoPcb=true、写完立刻重跑验收', async () => {
  const netlistText = JSON.stringify({
    components: {
      'c-j1': { props: { Designator: 'J1' }, pinInfoMap: { A5: { number: 'A5', net: 'CC1' }, B5: { number: 'B5', net: 'CC2' } } },
      'c-u1': { props: { Designator: 'U1' }, pinInfoMap: { A4: { number: 'A4', net: 'SDA' }, B3: { number: 'B3', net: 'SCL' }, C5: { number: 'C5', net: '3V3' }, D5: { number: 'D5', net: 'GND' } } },
    },
    designRule: {},
  });
  const calls = [];
  let created = 0;
  let emptyNext = false;
  // 写入后网表必须真的"长出"新引脚——否则路由的复核会（正确地）判定没生效并回滚
  const augmented = () => JSON.stringify({
    components: {
      'c-j1': { props: { Designator: 'J1' }, pinInfoMap: { A5: { number: 'A5', net: 'CC1' }, B5: { number: 'B5', net: 'CC2' } } },
      'c-u1': { props: { Designator: 'U1' }, pinInfoMap: { A4: { number: 'A4', net: 'SDA' }, B3: { number: 'B3', net: 'SCL' }, C5: { number: 'C5', net: '3V3' }, D5: { number: 'D5', net: 'GND' } } },
      'c-r1': { props: { Designator: 'R1' }, pinInfoMap: { 1: { number: '1', net: 'GND' }, 2: { number: '2', net: 'CC1' } } },
      'c-r2': { props: { Designator: 'R2' }, pinInfoMap: { 1: { number: '1', net: 'GND' }, 2: { number: '2', net: 'CC2' } } },
      'c-r3': { props: { Designator: 'R3' }, pinInfoMap: { 1: { number: '1', net: '3V3' }, 2: { number: '2', net: 'SDA' } } },
      'c-r4': { props: { Designator: 'R4' }, pinInfoMap: { 1: { number: '1', net: '3V3' }, 2: { number: '2', net: 'SCL' } } },
    },
    designRule: {},
  });
  const bridge = {
    port: 1,
    selectedWindowId: 'W1',
    async discover() { return { port: 1 }; },
    async windows() { return { windows: [{ id: 'W1' }], selectedWindowId: 'W1', selectionRequired: false }; },
    async execute(id, args = {}, options = {}) {
      calls.push({ id, args, options });
      if (id === 'project.current') return { result: { uuid: 'P1' } };
      if (id === 'document.current') return { result: { uuid: 'S1', documentType: 1 } };
      if (id === 'schematic.open') return { result: { opened: true, tabId: 't1' } };
      if (id === 'schematic.netlist.export') {
        if (emptyNext) { emptyNext = false; return { result: { name: 'n', size: 0, text: '' } }; }
        const text = calls.some((call) => call.id === 'schematic.save') ? augmented() : netlistText;
        return { result: { name: 'n', size: text.length, text } };
      }
      if (id === 'schematic.components') {
        const base = [{ primitiveId: 'c-j1', componentType: 'part', designator: 'J1', x: 1500, y: 200 }];
        // 位号在保存后由 EDA 标注落定：真机实测保存前是 R?，保存后是 R1/R2…
        const annotated = calls.some((call) => call.id === 'schematic.save');
        const made = Array.from({ length: created }, (_, i) => ({ primitiveId: `new-${i + 1}`, componentType: 'part', designator: annotated ? `R${i + 1}` : 'R?', x: 400 + i * 240, y: 560 }));
        const pins = Object.fromEntries(made.map((c, i) => [c.primitiveId, [{ pinNumber: '1', x: c.x, y: c.y }, { pinNumber: '2', x: c.x + 40, y: c.y }]]));
        return { result: { components: [...base, ...made], pins } };
      }
      if (id === 'library.device.search') {
        // 忠实模拟真机库：按关键词返回对应阻值编码的器件（5101=5.1kΩ，4701=4.7kΩ）
        const keyword = String(args.query || '').match(/\b(5101|4701)\b/)?.[1] ?? '0000';
        return { result: [{ name: `0603WAF${keyword}T5E`, uuid: `dev-${keyword}`, libraryUuid: 'lib-0603', description: '0603 电阻' }] };
      }
      if (id === 'schematic.component.create') { created += 1; return { result: { primitiveId: `new-${created}` } }; }
      if (id === 'schematic.netPort.create') { return { result: { primitiveId: `port-${calls.filter((c) => c.id === 'schematic.netPort.create').length}` } }; }
      if (id === 'schematic.component.delete') { created = 0; return { result: true }; }
      if (id === 'schematic.save') return { result: true };
      if (id === 'document.source.read') return { result: '{"board":"before"}' };
      if (id === 'schematic.drc') return { result: { errors: 0, warnings: 0 } };
      if (id === 'schematic.simulation.netlist.export') return { result: null };
      return { result: null };
    },
  };
  const { server, base } = await startServer(bridge);
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
    const post = (payload) => fetch(`${base}/api/eda/schematic/repair`, { method: 'POST', headers, body: JSON.stringify(payload) });
    // 写板批准必须由服务端签发（绑定当前窗口+工程+文档指纹）；这里模拟用户在自动化页点"签发写板批准"。
    const approveWrite = async () => {
      const response = await fetch(`${base}/api/automation/approvals`, { method: 'POST', headers, body: JSON.stringify({ scope: 'write', note: '测试：批准原理图修复写盘' }) });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body).slice(0, 300));
      return body.approval.approvalId;
    };

    // 1) 默认 dry-run：给出计划与器件，但一条写命令都不许发
    const dryResponse = await post({ pageUuid: 'S1' });
    const dry = await dryResponse.json();
    assert.equal(dry.dryRun, true, `HTTP ${dryResponse.status} body=${JSON.stringify(dry).slice(0, 300)}`);
    assert.equal(dry.plan.operations.length, 12, '4 个电阻 = 4 次建元件 + 8 次挂端口');
    assert.deepEqual(dry.plan.expectedGain, { CC1: 1, GND: 2, CC2: 1, SDA: 1, '3V3': 2, SCL: 1 });
    assert.equal(dry.devices.length, 4);
    // 真机 LCSC 在线库检索很慢（1~30s），所以同一个关键词只允许查一次（4 个电阻只有 2 个阻值）
    assert.equal(calls.filter((call) => call.id === 'library.device.search').length, 2, '按关键词去重：两两复用同一次检索');
    assert.ok(dry.devices.every((d) => d.mpn));
    assert.equal(calls.filter((c) => c.options?.allowWrite).length, 0, 'dry-run 不许有任何写命令');

    // 2) 真写：没有服务端签发的写板批准 → 409，且一条写命令都不能发出去
    const denied = await post({ pageUuid: 'S1', dryRun: false });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error.code, 'AUTOMATION_APPROVAL_REQUIRED');

    // 3) 真写：必须带写板批准、addIntoPcb=true，并在写完后重跑验收
    const approvalId = await approveWrite();
    const appliedResponse = await post({ pageUuid: 'S1', dryRun: false, approvalIds: [approvalId] });
    const applied = await appliedResponse.json();
    assert.equal(applied.dryRun, false, `HTTP ${appliedResponse.status} body=${JSON.stringify(applied).slice(0, 300)}`);
    const writes = calls.filter((c) => c.options?.allowWrite);
    assert.ok(writes.length >= 12);
    const creates = calls.filter((c) => c.id === 'schematic.component.create');
    assert.equal(creates.length, 4);
    assert.ok(creates.every((c) => c.args.addIntoPcb === true), 'addIntoPcb 必须为 true，否则元件不进网表');
    assert.ok(creates.every((c) => c.args.addIntoBom === true));
    assert.ok(calls.some((c) => c.id === 'schematic.save' && c.options.allowWrite));
    assert.ok(applied.applied.diff.ok, JSON.stringify(applied.applied.diff.unexpected));
    assert.ok(applied.acceptance, '写完必须重跑验收');
    assert.equal(typeof applied.acceptance.ready, 'boolean');

    // 4) 网表为空 → 409，绝不在"看不到网络"的情况下改设计（同样先拿到新的写板批准，证明拒绝原因是网表而不是缺批准）
    emptyNext = true;
    const emptyApproval = await approveWrite();
    const empty = await post({ dryRun: false, pageUuid: 'S1', approvalIds: [emptyApproval] });
    assert.equal(empty.status, 409);
    assert.equal((await empty.json()).error.code, 'EDA_NETLIST_EMPTY');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * 真机 A/B 实验固化：活动文档停在原理图、调用方又没给 pcbUuid 时，读 PCB 会稳定 500。
 * 所以运行时必须**自己**从工程里找到 PCB 文档并打开它——这是"小白用户不该手动切文档"的硬要求。
 */
test('POST /api/eda/pcb/placement/plan：没给 pcbUuid 也要自己去工程里找出 PCB 文档并打开', async () => {
  const calls = [];
  const bridge = {
    port: 49620,
    selectedWindowId: 'W1',
    async discover() { return { port: 49620 }; },
    async windows() { return { windows: [{ id: 'W1' }], selectedWindowId: 'W1', selectionRequired: false }; },
    async execute(id, args = {}) {
      calls.push({ id, args });
      if (id === 'project.current') {
        return {
          result: {
            uuid: 'proj-1',
            data: [
              { itemType: 'Board', name: 'Board1', pcb: { itemType: 'PCB', uuid: 'PCB-AUTO', name: 'PCB1' }, schematic: { itemType: 'Schematic', uuid: 'sch-1', page: [{ uuid: 'page-1' }] } },
            ],
          },
        };
      }
      if (id === 'pcb.open') return { result: { opened: true, tabId: 'T1' } };
      if (id === 'document.current') return { result: { uuid: 'PCB-AUTO', documentType: 3 } };
      if (id === 'pcb.placement.read') {
        return { result: { outline: [{ source: [0, 0, 'L', 2362.2047, 0, 2362.2047, -1574.8031, 0, -1574.8031, 0, 0] }], components: [{ designator: 'U1', primitiveId: 'p-u1', xMm: 10, yMm: -20, rotationDeg: 0, layerSide: 'top', padCount: 25, bboxMm: { xMm: 3.5, yMm: 3.5 } }] } };
      }
      return { result: null };
    },
  };
  const { server, base } = await startServer(bridge);
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
    const response = await fetch(`${base}/api/eda/pcb/placement/plan`, { method: 'POST', headers, body: JSON.stringify({}) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(calls.some((call) => call.id === 'project.current'), '没给 pcbUuid 时应当自己去查工程');
    assert.ok(calls.some((call) => call.id === 'pcb.open' && call.args.documentUuid === 'PCB-AUTO'), '必须打开工程里那块 PCB，而不是读当前碰巧打开的文档');
    assert.equal(body.pcbUuid, 'PCB-AUTO', '结论里要写清读的是哪块板');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * 真机教训（第 16 轮）：运行时**刚起来**、谁都还没 discover 桥的时候，
 * 第一条 `/api/pcb/context` 直接 400 BRIDGE_NOT_FOUND——桥明明就在那儿。
 * PCB 管理器的路由必须自己先建立会话，不能指望别的路由先替它 discover。
 */
test('GET /api/pcb/context：桥还没被发现时也必须自己 discover，而不是 400 BRIDGE_NOT_FOUND', async (context) => {
  const bridge = createRecordingBridge();
  bridge.port = null; // 模拟"运行时刚起来，还没人发现桥"
  let discovered = 0;
  bridge.discover = async () => { discovered += 1; bridge.port = 49620; return { port: 49620 }; };
  const { server, base } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const response = await fetch(`${base}/api/pcb/context`, { headers });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body).slice(0, 200));
  assert.ok(discovered >= 1, 'context 必须先把桥找出来');
  assert.equal(bridge.port, 49620);
});

test('POST /api/eda/commands/:id：运行时还没发现桥时也要自己 discover（连 pcb.open 都不能 400）', async (context) => {
  const bridge = createRecordingBridge();
  bridge.port = null;
  let discovered = 0;
  bridge.discover = async () => { discovered += 1; bridge.port = 49620; return { port: 49620 }; };
  const { server, base } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const response = await fetch(`${base}/api/eda/commands/document.current`, { method: 'POST', headers, body: JSON.stringify({}) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body).slice(0, 200));
  assert.ok(discovered >= 1);
});

test('3D 导出：STEP/GLB 各按自身结构校验，坏 GLB 与假 STEP 都必须被拒', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cp-3d-'));
  const bridge = createRecordingBridge();
  const { server, base } = await startServer(bridge);
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
    // 每条请求都带超时：这条路由卡住时必须表现为测试失败，而不是把整个测试文件挂住。
    const post = (payload) => fetch(`${base}/api/pcb/3d/export`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    const payloadOf = async (response) => { const body = await response.json(); return body.result ?? body; };

    // 1) 真 GLB：magic 'glTF' + version 2 + 头部声明长度自洽
    const glbBody = Buffer.from('{"meshes":[]}');
    const glb = Buffer.alloc(12 + glbBody.length);
    glb.write('glTF', 0, 'latin1'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glbBody.copy(glb, 12);
    bridge.setExportPayload(glb.toString('binary'));
    const glbResponse = await post({ pcbUuid: 'D1', format: 'glb', fileName: 'CircuitPilot-Assembled-3D', outDir: join(tmp, 'glb') });
    assert.equal(glbResponse.status, 200);
    const glbResult = await payloadOf(glbResponse);
    assert.equal(glbResult.model.format, 'glb');
    assert.ok(glbResult.model.path.endsWith('.glb'), `产物扩展名必须是 .glb：${glbResult.model.path}`);
    assert.equal(readFileSync(glbResult.model.path).length, glb.length, '落盘字节必须与取回字节一致');

    // 2) 坏 GLB（magic 不对）：必须判失败，不能因为"有文件"就放行
    bridge.setExportPayload('NOT-A-GLB-FILE-AT-ALL');
    const badGlb = await post({ pcbUuid: 'D1', format: 'glb', outDir: join(tmp, 'bad') });
    assert.equal(badGlb.status, 502);
    assert.equal((await badGlb.json()).error.code, 'PCB_3D_NOT_GLB');

    // 3) 假 STEP：同样必须被拒（本轮改格式分支时最容易回归的一条）
    bridge.setExportPayload('{"not":"step"}');
    const badStep = await post({ pcbUuid: 'D1', outDir: join(tmp, 'bad-step') });
    assert.equal(badStep.status, 502);
    assert.equal((await badStep.json()).error.code, 'PCB_3D_NOT_STEP');

    // 4) 未声明 format 时默认仍是 STEP，且扩展名不能变成 .glb
    bridge.setExportPayload('ISO-10303-21;\nEND-ISO-10303-21;\n');
    const stepResponse = await post({ pcbUuid: 'D1', outDir: join(tmp, 'step') });
    assert.equal(stepResponse.status, 200);
    const stepResult = await payloadOf(stepResponse);
    assert.equal(stepResult.model.format, 'step');
    assert.ok(stepResult.model.path.endsWith('.step'));
  } finally {
    // 只 close() 不够：keep-alive 连接会让关闭一直等下去（真机踩过：整个测试文件跑了 15 分钟）。
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('3D 导出：EDA 导出 RPC 卡住时必须按时限报错，不能把 HTTP 请求无限挂住', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cp-3d-hang-'));
  process.env.CIRCUITPILOT_3D_EXPORT_DEADLINE_MS = '300';
  const bridge = createRecordingBridge();
  // 模拟真机现象：桥把请求派出去了，但 EDA 侧永远不返回（调用方只能靠超时自救）
  bridge.execute = async function execute(id, args = {}) {
    this.commands.push({ id, args });
    if (id === 'document.current') return { result: { uuid: 'D1', documentType: 3 } };
    if (id === 'pcb.open') return { result: { opened: true } };
    if (id === 'pcb.3d.export') return new Promise(() => {});
    return { result: { primitiveId: `${id}-1` } };
  };
  const { server, base } = await startServer(bridge);
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const started = Date.now();
    const response = await fetch(`${base}/api/pcb/3d/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof },
      body: JSON.stringify({ pcbUuid: 'D1', outDir: tmp }),
      signal: AbortSignal.timeout(20000),
    });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'PCB_3D_EXPORT_DEADLINE');
    assert.ok(elapsed < 15000, `必须按时限失败，实际等待 ${elapsed}ms`);
  } finally {
    delete process.env.CIRCUITPILOT_3D_EXPORT_DEADLINE_MS;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('POST /api/eda/project/open：EDA 重启停在首页时，运行时自己按 UUID 打开工程并激活 PCB', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cp-proj-'));
  process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmp, 'memo.json');
  const bridge = createRecordingBridge();
  let projectOpen = null;
  let currentPolls = 0;
  const execute = bridge.execute.bind(bridge);
  bridge.execute = async (id, args = {}) => {
    bridge.commands.push({ id, args });
    if (id === 'project.current') {
      if (!projectOpen) return { result: null };
      // 真机现象：openProject 立即返回，但工程内容是异步加载的——先空数组，之后才有板。
      currentPolls += 1;
      const loaded = currentPolls > 2;
      return { result: { uuid: projectOpen, friendlyName: 'CircuitPilot 多层监测板', data: loaded ? [{ itemType: 'Board', pcb: { uuid: 'D1' } }] : [] } };
    }
    if (id === 'project.open') { projectOpen = args.projectUuid; return { result: { opened: true, projectUuid: args.projectUuid } }; }
    if (id === 'document.current') return { result: { uuid: 'D1', documentType: 3 } };
    if (id === 'pcb.open') return { result: { opened: true } };
    return execute(id, args);
  };
  const { server, base } = await startServer(bridge);
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const post = (payload) => fetch(`${base}/api/eda/project/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });

    const opened = await post({ projectUuid: 'P-TEST-1' });
    assert.equal(opened.status, 200);
    const raw = await opened.json();
    const body = raw.result ?? raw;
    assert.equal(body.ok, true);
    assert.equal(body.project.projectUuid, 'P-TEST-1');
    assert.equal(body.pcbUuid, 'D1', '打开工程后必须自己找到并激活 PCB');
    assert.ok(bridge.commands.some((entry) => entry.id === 'project.open' && entry.args.projectUuid === 'P-TEST-1'));

    // 记忆文件要真的写下来，供"EDA 重启后自动打开"复用
    assert.equal(JSON.parse(readFileSync(join(tmp, 'memo.json'), 'utf8')).projectUuid, 'P-TEST-1');

    // 没有入参且从未成功用过工程时，必须 400 说清楚，而不是假装打开
    rmSync(join(tmp, 'memo.json'), { force: true });
    const empty = await post({});
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, 'EDA_COMMAND_ARGS_INVALID');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('POST /api/eda/schematic/acceptance：活动文档是 PCB 时，运行时自己切到原理图再跑验收', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cp-sch-'));
  process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmp, 'memo.json');
  const bridge = createRecordingBridge();
  const execute = bridge.execute.bind(bridge);
  let activeType = 3; // 一开始停在 PCB（真机现象）
  bridge.execute = async (id, args = {}) => {
    bridge.commands.push({ id, args });
    if (id === 'document.current') return { result: { uuid: activeType === 1 ? 'SCH1' : 'D1', documentType: activeType } };
    if (id === 'project.current') return { result: { uuid: 'P1', data: [{ itemType: 'Board', schematic: { uuid: 'SCH1', page: [{ uuid: 'SCHPAGE1' }] }, pcb: { uuid: 'D1' } }] } };
    if (id === 'schematic.open') { activeType = 1; return { result: { opened: true, tabId: 'T1', usedId: args.documentUuid } }; }
    if (id === 'schematic.netlist.export') return { result: { text: 'V1 U1 1 0 DC 1\n.end\n', meta: { components: 1, nets: 1 } } };
    return execute(id, args);
  };
  const { server, base } = await startServer(bridge);
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const response = await fetch(`${base}/api/eda/schematic/acceptance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof },
      body: JSON.stringify({ skipSimulation: true }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    const raw = await response.json();
    const body = raw.result ?? raw;
    assert.ok(bridge.commands.some((entry) => entry.id === 'schematic.open' && entry.args.pageUuid === 'SCHPAGE1'), '必须先切到原理图页再验收');
    assert.equal(body.schematic.activated, true);
    const codes = (body.acceptance.findings || []).map((finding) => finding.code);
    assert.ok(!codes.includes('ACCEPTANCE_NETLIST_WRONG_DOCUMENT'), `切换后不该再报"文档不对"：${JSON.stringify(codes)}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('POST /api/eda/library/devices/search：桥返回 {result:[...]} 信封 + 真机扁平字段时，必须给出带立创编号的候选', async () => {
  // 真机踩到的缺口：旧归一化把 {result:[...]} 当成"一个器件"，再被 name/uuid 过滤掉 ⇒ 永远 0 候选，
  // 而同一时刻 EDA 里 getByLcscIds('C45924513') 明明返回 1 条。这里用**真机字段**钉住信封解包与身份映射。
  const device = {
    uuid: '3816921205274a4c8cb335dbad2452d0', libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
    classification: { libraryUuid: '0819f05c4eef4c71ace90d822a990e87', libraryType: '3' },
    name: '', symbolName: 'SHT40', symbolUuid: '3652d25281eb4e409df2ef5ed1d6355d',
    footprintName: 'SENSORM-SMD_SHT40-AD1B', footprintUuid: '8692968544824d24b10435a7dc75e6e6',
    model3DName: 'SENSORM-SMD_SHT40-AD1B', model3DUuid: 'b072df17cf924247b6ef5dae8141f359',
    description: '数字式温湿度传感器', manufacturer: 'Sensirion', manufacturerId: 'SHT40-AD1P-R2',
    supplier: 'LCSC', supplierId: 'C45924513',
    otherProperty: { 'LCSC Part Name': '数字式温湿度传感器（带防护罩）', 'Supplier Part': 'C45924513', 'Supplier Footprint': 'DFN-4(1.5x1.5)', 'JLCPCB Part Class': 'Extended Part', Datasheet: 'https://item.szlcsc.com/datasheet/SHT40-AD1P-R2/48031806.html' },
  };
  const bridge = createRecordingBridge();
  const execute = bridge.execute.bind(bridge);
  bridge.execute = async (id, args = {}) => (id === 'library.device.search' ? { result: [device] } : execute(id, args));
  const { server, base } = await startServer(bridge);
  try {
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    const response = await fetch(`${base}/api/eda/library/devices/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof },
      body: JSON.stringify({ query: 'C45924513' }),
      signal: AbortSignal.timeout(20000),
    });
    const raw = await response.json();
    const body = raw.result ?? raw;
    assert.equal(response.status, 200, JSON.stringify(body).slice(0, 300));
    assert.equal(body.search.candidates.length, 1, '信封必须被解开，候选不许是 0');
    const [candidate] = body.search.candidates;
    assert.equal(candidate.lcscId, 'C45924513');
    assert.equal(candidate.footprintName, 'SENSORM-SMD_SHT40-AD1B');
    assert.ok(candidate.name && candidate.name.length > 0, '顶层 name 为空时必须回退到商城属性名');
    assert.equal(candidate.jlcClass, 'Extended Part');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * 写板批准必须是服务端闸门：以前 placement/routing 这些工程写路由绕开页面直接打 HTTP 就能写板，
 * 页面上的"批准"只是自觉。现在真实写入（非 dryRun / 会保存/回滚）一律要在服务端消费一次
 * 绑定当前 EDA 指纹的 write 批准，否则 409。
 */
test('工程写路由：没有服务端签发的写板批准一律 409 AUTOMATION_APPROVAL_REQUIRED', async (context) => {
  const bridge = {
    port: 49620,
    selectedWindowId: 'W1',
    async discover() { return { port: 49620 }; },
    async windows() { return { windows: [{ id: 'W1' }], selectedWindowId: 'W1', selectionRequired: false }; },
    async execute(id) {
      if (id === 'project.current') return { result: { uuid: 'P1' } };
      if (id === 'document.current') return { result: { uuid: 'D1' } };
      return { result: null };
    },
  };
  const { server, base } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const post = (path, payload) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const cases = [
    ['/api/eda/pcb/placement/apply', { plan: { placements: [] }, dryRun: false }],
    ['/api/eda/pcb/routing/apply', { plan: { routes: [] }, dryRun: false }],
    ['/api/eda/pcb/routing/finish', {}],
    ['/api/eda/pcb/routing/rollback', { items: [] }],
  ];
  for (const [path, payload] of cases) {
    const response = await post(path, payload);
    const body = await response.json();
    assert.equal(response.status, 409, `${path} 应拒绝：${JSON.stringify(body).slice(0, 200)}`);
    assert.equal(body.error.code, 'AUTOMATION_APPROVAL_REQUIRED', path);
  }
});

test('B1/B4：正式导出必须绑定当前物料清单（旧签核/缺 manifestHash 一律挡住，0 写盘）', async (context) => {
  let writeCalls = 0;
  // 只读命令返回空结果让"取证"走通；任何制造/写入命令都算失败证据（门禁没过时不应发生）。
  const bridge = {
    port: 1, selectedWindowId: 'w1',
    async discover() { return { port: 1 }; },
    async windows() { return { windows: [{ id: 'w1' }], selectedWindowId: 'w1', selectionRequired: false }; },
    async execute(commandId) {
      if (/manufacture|export|\.create|\.apply|\.save|\.modify/i.test(commandId)) {
        writeCalls += 1;
        throw Object.assign(new Error(`不应执行写入：${commandId}`), { code: 'EDA_OFFLINE' });
      }
      return { result: {} };
    },
  };
  const { server, base } = await startServer(bridge);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const post = (path, payload) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) }).then(async (response) => ({ status: response.status, body: await response.json() }));

  const emptyDir = mkdtempSync(join(tmpdir(), 'cp-export-binding-'));
  const recomputed = inspectProductionArtifacts(emptyDir, {}).manifest.manifestHash;

  // 离线证据包：门禁结论由本地证据算出，不依赖 EDA（本用例只验证清单绑定，不验证导出）。
  const offlineEvidence = {
    userConfirmed: false,
    acceptance: { ready: false, netlist: { components: 2, nets: 1, namedPins: 2 }, findings: [{ code: 'ACCEPTANCE_NETLIST_DANGLING', severity: 'blocking', message: 'CC1 悬空' }], designChecks: { summary: { simulated: false, total: 0, passed: 0, failed: 0, notRun: 0, notApplicable: 0 }, results: [] } },
    design: { designators: ['U1', 'U2'], placement: [{ ref: 'U1', xMm: 10, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }], boardLayerCount: 2, coordinateToleranceMm: 0.05, netlistSha256: 'a'.repeat(64) },
    placementVerification: { ok: true, checkedCount: 2, findings: [] },
    drcReport: { ok: true, items: [], reportedCount: 0, truncated: false, digest: 'f'.repeat(64) },
    artifacts: [],
  };

  // 先登记一份"旧物料"的签核证据：它绑定的是另一个哈希。
  const signed = await post('/api/production/signoff', { passed: true, manifestHash: 'stale-manifest-hash', roles: [{ role: '设计', name: 'A' }, { role: '工艺', name: 'B' }, { role: '质量', name: 'C' }] });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));

  // 1) 正式导出没给 manifestHash → 明确阻断，且不写盘、不调用任何 EDA 写入。
  const outDir = join(emptyDir, 'final-out');
  const missing = await post('/api/production/export', { ...offlineEvidence, requested: 'final', artifactsDir: emptyDir, outDir });
  assert.equal(missing.status, 200, JSON.stringify(missing.body));
  assert.equal(missing.body.exported, false);
  assert.equal(missing.body.code, 'RELEASE_MANIFEST_BINDING_REQUIRED', JSON.stringify(missing.body).slice(0, 400));
  assert.equal(missing.body.manifestBinding.ok, false);
  assert.equal(existsSync(outDir), false, '被拒时不许建输出目录');
  assert.equal(writeCalls, 0);

  // 2) 给了 manifestHash 但与当前产物重算不一致 → RELEASE_MANIFEST_MISMATCH。
  const mismatch = await post('/api/production/export', { ...offlineEvidence, requested: 'final', artifactsDir: emptyDir, outDir, manifestHash: 'not-the-current-one' });
  assert.equal(mismatch.body.code, 'RELEASE_MANIFEST_MISMATCH', JSON.stringify(mismatch.body).slice(0, 400));
  assert.equal(existsSync(outDir), false);

  // 3) 提供当前产物哈希（且签核换绑到同一哈希）→ 绑定核对通过；是否放行交给统一裁决，不再以清单绑定为由拒绝。
  const signedCurrent = await post('/api/production/signoff', { passed: true, manifestHash: recomputed, roles: [{ role: '设计', name: 'A' }] });
  assert.equal(signedCurrent.status, 200);
  const fresh = await post('/api/production/export', { ...offlineEvidence, requested: 'final', artifactsDir: emptyDir, outDir, manifestHash: recomputed });
  assert.notEqual(fresh.body.code, 'RELEASE_MANIFEST_BINDING_REQUIRED');
  assert.notEqual(fresh.body.code, 'RELEASE_MANIFEST_MISMATCH');
  assert.equal(fresh.body.manifestBinding.ok, true, JSON.stringify(fresh.body.manifestBinding));
  assert.equal(writeCalls, 0, '门禁未过时仍不允许任何 EDA 写入');
});
