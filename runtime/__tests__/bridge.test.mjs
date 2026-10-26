import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BridgeClient, COMMANDS, JOB_COMMAND_KINDS, commandTimeoutMs, validateArgs } from '../bridge.mjs';
import { rectPolygonSource } from '../engineering/eda-primitives.mjs';
import { createRuntimeServer } from '../server.mjs';

const INJECTION_MARKER = '__CIRCUITPILOT_INJECTION_MARKER__';
const HOSTILE = `0,0,true,true);globalThis.${INJECTION_MARKER}=1;//`;

test('every argument interpolated into EDA source is type-checked', () => {
  const component = { libraryUuid: 'lib', uuid: 'dev' };
  const cases = [
    ['schematic.component.create', { component, x: 1, y: 1, rotation: HOSTILE }],
    ['schematic.component.create', { component, x: 1, y: 1, mirror: HOSTILE }],
    ['schematic.component.create', { component, x: 1, y: 1, addIntoBom: HOSTILE }],
    ['schematic.component.create', { component, x: 1, y: 1, addIntoPcb: HOSTILE }],
    ['schematic.netFlag.create', 'schematic.netPort.create', 'schematic.component.delete', { identification: 'Power', net: '3V3', x: 1, y: 1, rotation: HOSTILE }],
    ['schematic.netFlag.create', { identification: 'Power', net: '3V3', x: 1, y: 1, mirror: HOSTILE }],
    ['schematic.netPort.create', 'schematic.netPort.create', { portType: 'BI', net: 'SDA', x: 1, y: 1, rotation: HOSTILE }],
    ['schematic.netPort.create', { portType: 'BI', net: 'SDA', x: 1, y: 1, mirror: HOSTILE }],
    ['schematic.component.delete', 'schematic.component.delete', { primitiveIds: [HOSTILE] }],
    ['pcb.line.create', { layer: 1, startX: 0, startY: 0, endX: 1, endY: 1, primitiveLock: HOSTILE }],
    ['pcb.pour.create', { net: 'GND', layer: 1, complexPolygon: {}, preserveSilos: HOSTILE }],
    ['pcb.pour.create', { net: 'GND', layer: 1, complexPolygon: {}, pourPriority: HOSTILE }],
    ['pcb.pour.create', { net: 'GND', layer: 1, complexPolygon: {}, lineWidth: HOSTILE }],
    ['pcb.pour.create', { net: 'GND', layer: 1, complexPolygon: {}, primitiveLock: HOSTILE }],
    ['pcb.via.create', { net: '', x: 1, y: 1, holeDiameter: 0.3, diameter: 0.6, viaType: { nested: true } }],
    ['pcb.placement.write', { updates: [{ primitiveId: HOSTILE, designator: HOSTILE, xMil: 0, yMil: 0, rotationDeg: 0 }] }],
  ];
  for (const [commandId, args] of cases) {
    assert.throws(() => validateArgs(commandId, args), { code: 'EDA_COMMAND_ARGS_INVALID' }, `${commandId} accepted ${JSON.stringify(args)}`);
  }
});

test('hostile plan arguments stay inert data instead of executing inside the EDA extension', async () => {
  const cases = {
    'schematic.component.create': { component: { libraryUuid: 'lib', uuid: 'dev' }, x: 1, y: 1, rotation: HOSTILE, mirror: false, addIntoBom: true, addIntoPcb: true },
    'schematic.component.designator.set': { primitiveId: 'abc123', designator: HOSTILE },
    'schematic.netFlag.create': { identification: 'Power', net: '3V3', x: 1, y: 1, rotation: 0, mirror: HOSTILE },
    'pcb.line.create': { layer: 1, startX: 0, startY: 0, endX: 1, endY: 1, lineWidth: 0.2, primitiveLock: HOSTILE },
    'pcb.pour.create': { net: 'GND', layer: 1, complexPolygon: {}, preserveSilos: HOSTILE, pourName: 'GND', pourPriority: HOSTILE, lineWidth: 0.2, primitiveLock: HOSTILE },
    'pcb.via.create': { net: '', x: 1, y: 1, holeDiameter: 0.3, diameter: 0.6, viaType: HOSTILE },
  };
  const executed = [];
  const fakeEda = new Proxy({}, { get: (_target, namespace) => new Proxy(async () => ({}), { get: (_t, method) => async () => { executed.push(`${String(namespace)}.${String(method)}`); return {}; } }) });
  globalThis[INJECTION_MARKER] = undefined;
  for (const [commandId, args] of Object.entries(cases)) {
    const code = COMMANDS[commandId].buildCode(args);
    const withoutStrings = code.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    assert.ok(!withoutStrings.includes(INJECTION_MARKER), `${commandId} interpolated a value outside a string literal: ${code}`);
    // Real execution: wrap in an async IIFE so the generated `await` resolves, then run it.
    await new Function('eda', `return (async () => { ${code} })()`)(fakeEda);
  }
  assert.ok(executed.length >= Object.keys(cases).length, 'every generated command should have really executed against the fake EDA API');
  assert.ok(executed.includes('sch_PrimitiveComponent.modify'), '位号标注命令必须真的调用到 EDA modify');
  assert.equal(globalThis[INJECTION_MARKER], undefined, 'generated EDA source executed an injected statement');
  delete globalThis[INJECTION_MARKER];
});

test('discovery ignores non-EasyEDA services and accepts verified bridge identity', async () => {
  const client = new BridgeClient({ ports: [49620, 49621], fetcher: async (url) => url.includes('49620') ? { service: 'unrelated-service' } : { service: 'easyeda-bridge', version: 'test' } });
  const match = await client.discover();
  assert.equal(match.port, 49621);
});

test('multiple windows require explicit target selection before command execution', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) return { service: 'easyeda-bridge' };
    if (url.endsWith('/eda-windows')) return { windows: [{ windowId: 'A' }, { windowId: 'B' }] };
    if (url.endsWith('/eda-windows/select')) return { ok: true };
    if (url.endsWith('/execute')) return { project: 'selected' };
    throw new Error(`Unexpected URL ${url}`);
  };
  const client = new BridgeClient({ ports: [49620], fetcher });
  await client.discover();
  await assert.rejects(() => client.execute('project.current'), { code: 'EDA_WINDOW_SELECTION_REQUIRED' });
  await client.selectWindow('B');
  const result = await client.execute('project.current');
  assert.deepEqual(result, { project: 'selected' });
  assert.match(calls.at(-1).options.body, /"windowId":"B"/);
});

test('每条命令有自己的传输预算：重活给足，读操作给宽（真机上曾因一律 8s 而必然超时）', async () => {
  const seen = [];
  const fetcher = async (url, options, timeoutMs) => {
    if (url.endsWith('/health')) return { service: 'easyeda-bridge' };
    if (url.endsWith('/eda-windows')) return { windows: [{ windowId: 'A' }] };
    seen.push(timeoutMs);
    return { result: [] };
  };
  const client = new BridgeClient({ ports: [49620], fetcher });
  await client.discover();
  const jobId = '11111111-2222-3333-4444-555555555555';
  await client.execute('workspace.create', { friendlyName: '控制板', projectName: 'cp', description: '' }, { allowWrite: true });
  await client.execute('pcb.outline.create', { widthMm: 60, heightMm: 40 }, { allowWrite: true });
  await client.execute('pcb.outline.read');
  await client.execute('pcb.drc.job.start', { jobId });
  await client.execute('document.source.restore', { source: '{"type":"DOCHEAD"}||{}|' }, { allowWrite: true });
  await client.execute('pcb.via.create', { net: '', x: 1, y: 1, holeDiameter: 0.3, diameter: 0.6 }, { allowWrite: true });
  // 建工程（真机曾 60s 被打爆、留下“工程已建但板/原理图/PCB 全空”的半成品 → 提到传输上限）/ 板框创建 / 读命令 / 后台任务启动 / 源码还原 / 缺省
  assert.deepEqual(seen, [110_000, 30_000, 20_000, 10_000, 60_000, 15_000]);
});

test('unregistered and write-like command identifiers are denied by default', async () => {
  const client = new BridgeClient({ ports: [49620], fetcher: async () => ({ service: 'easyeda-bridge' }) });
  await client.discover();
  await assert.rejects(() => client.execute('project.save'), { code: 'EDA_COMMAND_NOT_ALLOWED' });
});

test('workspace creation is fixed, validated and requires explicit write authorization', async () => {
  const calls = [];
  const bridge = new BridgeClient({ ports: [49620], fetcher: async (url, options = {}) => {
    if (url.endsWith('/health')) return { service: 'easyeda-bridge' };
    if (url.endsWith('/eda-windows')) return { windows: [{ windowId: 'W1' }] };
    if (url.endsWith('/execute')) { calls.push(JSON.parse(options.body)); return { result: { projectUuid: 'P1', pcbUuid: 'PCB1' } }; }
    return {};
  } });
  await bridge.discover();
  await assert.rejects(() => bridge.execute('workspace.create', { friendlyName: '控制板', projectName: 'control-board', description: '' }), (error) => error.code === 'EDA_WRITE_BLOCKED');
  await assert.rejects(() => bridge.execute('workspace.create', { friendlyName: '控制板', projectName: '不合法名称', description: '' }, { allowWrite: true }), (error) => error.code === 'EDA_COMMAND_ARGS_INVALID');
  const result = await bridge.execute('workspace.create', { friendlyName: '控制板', projectName: 'control-board', description: '' }, { allowWrite: true });
  assert.equal(result.result.pcbUuid, 'PCB1');
  assert.match(calls[0].code, /dmt_Project\.createProject/);
  assert.match(calls[0].code, /dmt_Schematic\.createSchematic/);
  assert.match(calls[0].code, /dmt_Pcb\.createPcb/);
  assert.match(calls[0].code, /dmt_EditorControl\.openDocument/);
});

test('typed write commands require internal authorization and reject invalid arguments', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) return { service: 'easyeda-bridge' };
    if (url.endsWith('/eda-windows')) return { windows: [{ windowId: 'A' }] };
    if (url.endsWith('/execute')) return { primitiveId: 'P1' };
    throw new Error(`Unexpected URL ${url}`);
  };
  const client = new BridgeClient({ ports: [49620], fetcher });
  await client.discover();
  await assert.rejects(() => client.execute('schematic.component.create', { component: { libraryUuid: 'L', uuid: 'U' }, x: 1, y: 2 }), { code: 'EDA_WRITE_BLOCKED' });
  await assert.rejects(() => client.execute('schematic.wire.create', { line: [1, 2, Number.NaN, 4] }, { allowWrite: true }), { code: 'EDA_COMMAND_ARGS_INVALID' });
  await client.execute('schematic.component.create', { component: { libraryUuid: 'L', uuid: 'U' }, x: 1, y: 2 }, { allowWrite: true });
  await assert.rejects(() => client.execute('schematic.pin.noConnect', { componentPrimitiveId: 'P1', pinNumbers: [] }, { allowWrite: true }), { code: 'EDA_COMMAND_ARGS_INVALID' });
  await assert.rejects(() => client.execute('schematic.wire.read', { primitiveIds: [] }), { code: 'EDA_COMMAND_ARGS_INVALID' });
  assert.match(calls.at(-1).options.body, /sch_PrimitiveComponent\.create/);
});

test('device library search is fixed read-only and validates keyword or LCSC input', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) return { service: 'easyeda-bridge' };
    if (url.endsWith('/eda-windows')) return { windows: [{ windowId: 'A' }] };
    if (url.endsWith('/execute')) return [];
    throw new Error(`Unexpected URL ${url}`);
  };
  const client = new BridgeClient({ ports: [49620], fetcher });
  await client.discover();
  await assert.rejects(() => client.execute('library.device.search', { query: '', mode: 'keyword', limit: 20, page: 1 }), { code: 'EDA_COMMAND_ARGS_INVALID' });
  await client.execute('library.device.search', { query: 'STM32', mode: 'keyword', limit: 20, page: 1 });
  assert.match(calls.at(-1).options.body, /lib_Device\.search/);
  await client.execute('library.device.search', { query: 'C12345', mode: 'lcsc', limit: 20, page: 1 });
  assert.match(calls.at(-1).options.body, /getByLcscIds/);
});

/**
 * 每个 buildCode 命令的**合法参数夹具**。
 *
 * 为什么需要它：整体不变量原先用 Proxy 把"任意属性"都变成恶意字符串，
 * 结果新命令（板框/后台任务）因为参数本来就不合法而抛错，不变量被绕过。
 * 夹具保证不变量是在**合法调用形状**上检查注入，而不是在非法参数上空转。
 */
const VALID_ARGS = {
  'pcb.pins.read': { primitiveId: 'e62cb8acd7a12cc9' },
  'pcb.pour.deleteAdded': { existingIds: ['e22091677d2bce31', '899554a7b177f308'] },
  'pcb.copper.read': {},
  'pcb.pads.read': { pcbUuid: 'e'.repeat(16), restoreUuid: 'f'.repeat(16) },
  'pcb.lines.delete': { primitiveIds: ['a1'] },
  'pcb.vias.delete': { primitiveIds: ['b2'] },
  'workspace.create': { friendlyName: '控制板', projectName: 'control-board', description: '' },
  'schematic.open': { documentUuid: 'a'.repeat(16) },
  'library.device.search': { query: 'STM32', mode: 'keyword', limit: 20, page: 1 },
  'schematic.wire.read': { primitiveIds: ['P1'] },
  'document.source.restore': { source: '{"type":"DOCHEAD"}||{}|' },
  'schematic.component.create': { component: { libraryUuid: 'L', uuid: 'U' }, x: 1, y: 2, rotation: 0, mirror: false, addIntoBom: true, addIntoPcb: true },
  'schematic.component.designator.set': { primitiveId: 'abc123', designator: 'C12' },
  'schematic.pin.noConnect': { componentPrimitiveId: 'C1', pinNumbers: ['1'] },
  'schematic.netFlag.create': { identification: 'Power', net: '3V3', x: 1, y: 2, rotation: 0, mirror: false },
  'schematic.netPort.create': { portType: 'BI', net: 'SDA', x: 1, y: 2, rotation: 0, mirror: false },
  'schematic.component.delete': { primitiveIds: ['abc123'] },
  'schematic.wire.create': { line: [0, 0, 1, 1], net: 'GND' },
  'pcb.layers.setCount': { layers: 4 },
  'pcb.open': { documentUuid: 'b'.repeat(16) },
  'pcb.region.create': { layer: 12, originXMm: 50, originYMm: 50, widthMm: 5, heightMm: 5, ruleType: [7], regionName: 'CP_REGION', lineWidthMil: 10, primitiveLock: false },
  'pcb.region.delete': { primitiveIds: ['r1'] },
  'pcb.text.create': { layer: 3, xMil: 2000, yMil: 2000, text: 'CPTEST', fontFamily: 'Arial', fontSizeMil: 40, lineWidthMil: 6, alignMode: 5, rotationDeg: 0, reverse: true, mirror: false, expansion: 0, primitiveLock: false },
  'pcb.text.delete': { primitiveIds: ['t1'] },
  'pcb.reload': { saved: true },
  'project.open': { projectUuid: 'd'.repeat(16) },
  'pcb.importChanges': { schematicUuid: 'c'.repeat(16) },
  'pcb.component.modify': { primitiveId: 'P1', property: { x: 1, y: 2, rotation: 0 } },
  'pcb.component.create': { component: { libraryUuid: 'L', uuid: 'U' }, layer: 1, xMil: 1574.8, yMil: -1181.1, rotationDeg: 0, primitiveLock: false },
  'pcb.line.create': { layer: 4, startX: 0, startY: 0, endX: 1, endY: 1, lineWidth: 0.2, primitiveLock: false },
  'pcb.pour.rebuild': { primitiveIds: ['abc123'] },
  'pcb.poured.read': {},
  'pcb.autoRoute.start': { nets: ['GND'], ignoreNets: [], layers: [1, 2] },
  'pcb.routing.capabilities': {},
  'pcb.placement.write': { updates: [{ primitiveId: 'P1', designator: 'U1', xMil: 255.905512, yMil: -1102.362205, rotationDeg: 0 }] },
  'pcb.outline.create': { widthMm: 45, heightMm: 30, originXMm: 0, originYMm: 0, lineWidth: 10 },
  'pcb.via.create': { net: 'GND', x: 1, y: 2, holeDiameter: 0.3, diameter: 0.6 },
  'pcb.pour.create': { net: 'GND', layer: 1, complexPolygon: {}, preserveSilos: false, pourName: 'GND', pourPriority: 0, lineWidth: 0.2, primitiveLock: false },
  'pcb.pour.delete': { primitiveId: 'abc123' },
  'pcb.drc.job.start': { jobId: '11111111-2222-3333-4444-555555555555' },
  'pcb.job.poll': { jobId: '11111111-2222-3333-4444-555555555555' },
  'pcb.job.cancel': { jobId: '11111111-2222-3333-4444-555555555555' },
  'schematic.simulation.netlist.export': { fileName: 'circuitpilot-sim', netlistType: 'Ngspice', inlineLimit: 262144 },
  'schematic.netlist.export': { fileName: 'circuitpilot-netlist', netlistType: 'EasyEDA', inlineLimit: 262144 },
  'schematic.netlist.chunk': { exportId: 'exp-abc12345', index: 0 },
  'schematic.parts.read': {},
  'pcb.3d.export': {},
  'pcb.3d.chunk': { exportId: 'exp-abc12345', index: 0 },
  'pcb.export.chunk': { exportId: 'exp-abc12345', index: 0 },
  'pcb.manufacture.export': { kind: 'gerber', fileName: 'CP-Gerber' },
};

test('贴装整机3D：导出必须显式要求器件模型与整机装配（不传就是光板/丢器件），分片必须能识别缓冲丢失', () => {
  const code = COMMANDS['pcb.3d.export'].buildCode({ fileName: 'CP-Assembled-3D' });
  assert.match(code, /Component Model/, 'element 必须含器件模型，否则 STEP 里没有器件');
  assert.match(code, /'Outfit'/, 'modelMode 必须是整机装配');
  assert.match(code, /get3DFile/);
  const chunk = COMMANDS['pcb.3d.chunk'].buildCode({ exportId: 'exp-abc12345', index: 3 });
  assert.match(chunk, /EDA_EXPORT_BUFFER_LOST/, '缓冲丢失必须显式表达，不能返回空内容');
  assert.match(chunk, /btoa/);
  assert.match(chunk, /slice/);
});

test('3D分片参数校验：坏 exportId / 坏 index 一律拒绝，绝不带进渲染进程', () => {
  const bad = (args) => assert.throws(() => validateArgs('pcb.3d.chunk', args), (error) => error.code === 'EDA_COMMAND_ARGS_INVALID');
  bad({ exportId: 'bad id!', index: 0 });
  bad({ exportId: 'exp-abc12345', index: -1 });
  bad({ exportId: 'exp-abc12345', index: 1.5 });
  bad({ exportId: 'exp-abc12345', index: 9000 });
  assert.doesNotThrow(() => validateArgs('pcb.3d.chunk', { exportId: 'exp-abc12345', index: 0 }));
  assert.throws(() => validateArgs('pcb.3d.export', { fileName: '' }), (error) => error.code === 'EDA_COMMAND_ARGS_INVALID');
});


test('预算策略：凡有效预算 >20s 的非读命令，必须显式声明 longRunning（否则就是下一个“110s 神秘超时”）', () => {
  const offenders = [];
  for (const [commandId, command] of Object.entries(COMMANDS)) {
    const budget = Math.min(command.timeoutMs ?? commandTimeoutMs(commandId), 110_000);
    const isRead = command.permission === 'read' || command.permission === 'sensitive-read';
    if (budget > 20_000 && !isRead && typeof command.longRunning !== 'string') offenders.push(`${commandId}(${budget}ms)`);
  }
  assert.deepEqual(offenders, [], `这些命令拿着长预算却没说明用途：${offenders.join(', ')}`);
});

test('健康探针与长任务登记：eda.session 必须注册，长任务派发必须登记在 JOB_COMMAND_KINDS', () => {
  assert.equal(COMMANDS['eda.session']?.permission, 'read');
  assert.ok(COMMANDS['eda.session'].timeoutMs <= 3_000, '健康探针必须便宜，否则拦不住“发一个长调用等满 118s”');
  assert.match(COMMANDS['eda.session'].code, /epoch/);
  assert.equal(JOB_COMMAND_KINDS['pcb.drc.job.start'], 'pcb.drc');
  assert.ok(COMMANDS['pcb.drc.job.start'], '有 job 变体的长任务必须真的注册');
});

test('同类长任务在途互斥：不允许靠“重试”把仍在渲染进程里跑的活堆起来', async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith('/health')) return { service: 'easyeda-bridge' };
    if (String(url).endsWith('/eda-windows')) return { windows: [{ windowId: 'A' }] };
    return { result: { jobId: null, accepted: true, state: 'running', epoch: 'epoch-A' } };
  };
  const client = new BridgeClient({ ports: [49620], fetcher });
  await client.discover();
  const first = '11111111-2222-3333-4444-555555555555';
  const second = '22222222-3333-4444-5555-666666666666';
  await client.execute('pcb.drc.job.start', { jobId: first }, { allowWrite: true });
  assert.equal(client.jobs.get(first).state, 'running');
  await assert.rejects(
    () => client.execute('pcb.drc.job.start', { jobId: second }, { allowWrite: true }),
    (error) => error.code === 'EDA_JOB_BUSY' && error.jobId === first,
  );
  // 任务被如实收口后必须能重新派发，否则会永久卡死
  client.jobs.interruptInFlight({ code: 'EDA_RENDERER_RELOADED', message: 'test' });
  await client.execute('pcb.drc.job.start', { jobId: second }, { allowWrite: true });
  assert.equal(client.jobs.get(second).state, 'running');
});

test('派发前失败（桥/窗口不可用）不能让长任务留下永久占位：否则 DRC 通道被 EDA_JOB_BUSY 永久堵死', async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith('/health')) return { service: 'easyeda-bridge' };
    if (String(url).endsWith('/eda-windows')) throw Object.assign(new Error('未发现EasyEDA Bridge'), { code: 'BRIDGE_NOT_FOUND' });
    return { result: {} };
  };
  const client = new BridgeClient({ ports: [49620], fetcher });
  await client.discover();
  const first = '44444444-5555-6666-7777-888888888888';
  const second = '55555555-6666-7777-8888-999999999999';
  await assert.rejects(
    () => client.execute('pcb.drc.job.start', { jobId: first }, { allowWrite: true }),
    (error) => error.code === 'BRIDGE_NOT_FOUND',
  );
  assert.equal(client.jobs.get(first).state, 'error', '派发失败必须当场收口，不能留 created 幽灵任务');
  assert.equal(client.jobs.runningOfKind('pcb.drc'), null, '收口后同类长任务必须能重新派发');
  // 再派发要能走到真正的派发阶段（仍因桥不可用失败），而不是被 EDA_JOB_BUSY 拦住
  await assert.rejects(
    () => client.execute('pcb.drc.job.start', { jobId: second }, { allowWrite: true }),
    (error) => error.code === 'BRIDGE_NOT_FOUND',
  );
});

test('服务端超时（dispatched:true）必须表达成 EDA_REQUEST_ABANDONED，而不是普通 HTTP 错误', async () => {
  const originalFetch = globalThis.fetch;
  const json = (value, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(value) });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/health')) return json({ service: 'easyeda-bridge' });
    if (String(url).endsWith('/eda-windows')) return json({ windows: [{ windowId: 'A' }] });
    return json({ success: false, dispatched: true, error: { message: 'EDA request timeout' } }, 504);
  };
  try {
    const client = new BridgeClient({ ports: [49620] });
    await client.discover();
    await assert.rejects(
      () => client.execute('document.current'),
      (error) => error.code === 'EDA_REQUEST_ABANDONED' && error.dispatched === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const buildCodeCommands = () => Object.entries(COMMANDS).filter(([, command]) => typeof command.buildCode === 'function');

test('每个 buildCode 命令的合法参数夹具本身是完整的（新命令必须补夹具）', () => {
  const missing = buildCodeCommands().map(([id]) => id).filter((id) => !VALID_ARGS[id]);
  assert.deepEqual(missing, [], `以下 buildCode 命令缺少合法参数夹具：${missing.join(', ')}`);
});

test('每个 buildCode 命令都把参数当作 JSON 数据插值（整体不变量，含未来新增命令）', () => {
  // 对每个命令：先用合法夹具生成一次（证明形状合法），再把**所有字符串字段**替换成恶意载荷，
  // 要求生成的源码里恶意片段只可能出现在字符串字面量内；主动校验并抛错的命令同样算作安全的拒绝。
  const injectStrings = (value) => {
    if (typeof value === 'string') return HOSTILE;
    if (Array.isArray(value)) return value.map(injectStrings);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, injectStrings(item)]));
    return value;
  };
  for (const [commandId, command] of buildCodeCommands()) {
    const fixture = VALID_ARGS[commandId];
    assert.equal(typeof command.buildCode(fixture), 'string', `${commandId} 用合法夹具生成的不是字符串`);
    const hostile = injectStrings(fixture);
    const hasStringField = JSON.stringify(hostile) !== JSON.stringify(fixture);
    let code;
    try { code = command.buildCode(hostile); }
    catch (error) {
      assert.match(String(error?.code || ''), /^EDA_/, `${commandId} 拒绝恶意参数时必须抛带 EDA_ 前缀的错误码`);
      continue;
    }
    if (!hasStringField) continue;
    const withoutStrings = code.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    assert.ok(!withoutStrings.includes(INJECTION_MARKER), `${commandId} 把参数插到了字符串字面量之外：${code}`);
    assert.ok(code.includes(INJECTION_MARKER), `${commandId} 没有把注入标记放入字符串字面量：${code}`);
  }
});

test('所有 buildCode 命令生成的源码都是可解析的合法表达式（含恶意字符串）', () => {
  const injectStrings = (value) => {
    if (typeof value === 'string') return HOSTILE;
    if (Array.isArray(value)) return value.map(injectStrings);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, injectStrings(item)]));
    return value;
  };
  for (const [commandId, command] of buildCodeCommands()) {
    for (const args of [VALID_ARGS[commandId], injectStrings(VALID_ARGS[commandId])]) {
      let code;
      try { code = command.buildCode(args); } catch { continue; }
      // 只做语法解析，不执行：注入成功的话这里会直接抛 SyntaxError。
      assert.doesNotThrow(() => new Function('eda', `return (async () => { ${code} })()`), `${commandId} 生成的源码无法解析`);
    }
  }
});

test('每个 buildCode 命令在函数体语义下都必须 return 出值（写漏 return 会让结果被桥接层丢弃）', async () => {
  // 真机教训：桥接层把生成的源码当作**函数体**执行。写成 (function(){…})() / (async()=>{…})()
  // 而不写 return 的话，副作用照样发生，但返回值是 undefined——板框回读校验、后台任务 jobId
  // 都会被丢掉，表现为 result:null、任务误判为“已丢失”。这条不变量专门拦这个错误。
  // 注意 then 必须返回 undefined：否则假代理会伪装成 thenable，
  // 让后台任务里的 Promise 链永远不 settle，测试直接挂死。
  const anyProxy = new Proxy(function () {}, { get: (_target, key) => (key === 'then' ? undefined : anyProxy), apply: () => anyProxy });
  for (const [commandId, command] of buildCodeCommands()) {
    const code = command.buildCode(VALID_ARGS[commandId]);
    let returned;
    try { returned = await new Function('eda', code)(anyProxy); }
    catch (error) { assert.match(code, /\breturn\b/, `${commandId} 既抛错又没有 return：${error.message}`); continue; }
    assert.notEqual(returned, undefined, `${commandId} 生成的源码没有 return，结果会被丢弃：${code.slice(0, 140)}`);
  }
});

test('板框：Line 写板框层被客户端直接拒绝，且错误里给出可执行的替代通道', () => {
  // 板框层用 Line：客户端直接拒绝，且错误里必须给出可照做的替代通道（不能只说"参数不正确"）。
  assert.throws(() => validateArgs('pcb.line.create', { layer: 11, startX: 0, startY: 0, endX: 1, endY: 1 }), (error) => error.code === 'EDA_LAYER_NOT_SUPPORTED' && /PCB_PrimitivePolyline/.test(error.message));
  const outline = COMMANDS['pcb.outline.create'];
  validateArgs('pcb.outline.create', VALID_ARGS['pcb.outline.create']);
  const code = outline.buildCode(VALID_ARGS['pcb.outline.create']);
  // 必须走 Polyline + 坐标开头的多边形编码；不能再用 Line。
  assert.match(code, /pcb_PrimitivePolyline\.create\('',11,/);
  assert.match(code, /pcb_MathPolygon\.createPolygon\(source\)/);
  // 与能力层同源比对：必须是「坐标开头 + "L" 段类型」的闭合矩形，而不是 token 开头的 ['R',…]（实测被拒）。
  const expectedSource = JSON.stringify(rectPolygonSource({ widthMm: 45, heightMm: 30, originXMm: 0, originYMm: 0 }));
  assert.ok(code.includes(`const source=${expectedSource}`), `板框源码必须是实测可用的编码：${code}`);
  assert.match(code, /\[0,0,"L",/);
  // 回读校验必须内置：几何偏差要在命令内部被发现，而不是"发出去就算成功"。
  assert.match(code, /getPrimitivesBBox/);
});

test('后台任务命令：jobId 必须是 UUID，userInterface 必须是布尔', () => {
  const jobId = '11111111-2222-3333-4444-555555555555';
  for (const commandId of ['pcb.job.poll', 'pcb.job.cancel', 'pcb.drc.job.start']) {
    assert.throws(() => validateArgs(commandId, { jobId: 'not-a-uuid' }), { code: 'EDA_COMMAND_ARGS_INVALID' });
    assert.throws(() => validateArgs(commandId, {}), { code: 'EDA_COMMAND_ARGS_INVALID' });
    validateArgs(commandId, { jobId });
  }
  assert.throws(() => validateArgs('pcb.drc.job.start', { jobId, userInterface: 'yes' }), { code: 'EDA_COMMAND_ARGS_INVALID' });
  const start = COMMANDS['pcb.drc.job.start'].buildCode({ jobId });
  assert.match(start, /__circuitpilotEdaJobs/);
  assert.match(start, /pcb_Drc\.check\(true,false,true\)/);
  assert.match(start, /return \{jobId:.*accepted:true\}/);
});

test('盲埋孔：规则项名必须与 viaType 同时给出，且不能注入', () => {
  const base = { net: 'GND', x: 1, y: 2, holeDiameter: 0.3, diameter: 0.6 };
  // 只给规则项名不给 viaType：位置参数顺序上说不通，拒绝而不是猜。
  assert.throws(() => validateArgs('pcb.via.create', { ...base, designRuleBlindViaName: 'L1-L2' }), { code: 'EDA_COMMAND_ARGS_INVALID' });
  // 规则项名类型/长度非法。
  for (const bad of ['', '   ', 7, 'x'.repeat(121)]) {
    assert.throws(() => validateArgs('pcb.via.create', { ...base, viaType: 'blind', designRuleBlindViaName: bad }), { code: 'EDA_COMMAND_ARGS_INVALID' });
  }
  // 合法组合通过，并且两个值都以 JSON 字面量出现在第 6、7 个位置参数上。
  validateArgs('pcb.via.create', { ...base, viaType: 'blind', designRuleBlindViaName: 'L1-L2' });
  const code = COMMANDS['pcb.via.create'].buildCode({ ...base, viaType: 'blind', designRuleBlindViaName: 'L1-L2' });
  assert.match(code, /create\("GND",1,2,0\.3,0\.6,"blind","L1-L2"\)/);
  // 不给规则项名时，签名与改造前一致（通孔路径行为不变）。
  const through = COMMANDS['pcb.via.create'].buildCode({ ...base, viaType: 'via' });
  assert.match(through, /create\("GND",1,2,0\.3,0\.6,"via"\)/);
  assert.equal(COMMANDS['pcb.via.create'].buildCode(base), 'return await eda.pcb_PrimitiveVia.create("GND",1,2,0.3,0.6);');
});

test('铜箔层数命令：只放行偶数层，写入命令需要内部授权', () => {
  assert.equal(COMMANDS['pcb.layers.setCount'].permission, 'write');
  for (const good of [2, 4, 6, 8, 32]) validateArgs('pcb.layers.setCount', { layers: good });
  for (const bad of [0, 1, 3, 5, 34, 2.5, '4']) {
    assert.throws(() => validateArgs('pcb.layers.setCount', { layers: bad }), { code: 'EDA_COMMAND_ARGS_INVALID' }, `layers=${bad} 应被拒`);
  }
  const code = COMMANDS['pcb.layers.setCount'].buildCode({ layers: 4 });
  assert.match(code, /setTheNumberOfCopperLayers\(4\)/);
  // 返回 false 不是成功：必须抛错，不能让“没设成”被当成设成了。
  assert.match(code, /ok!==true\)throw/);
  assert.equal(COMMANDS['pcb.layers.copperCount'].permission, 'read');
});

test('网表导出：类型/文件名/内联上限必须校验，且大网表走分片而不是塞爆单次响应', () => {
  const bad = (args) => assert.throws(() => validateArgs('schematic.netlist.export', args), (error) => error.code === 'EDA_COMMAND_ARGS_INVALID');
  bad({ netlistType: 'NotAFormat' });
  bad({ fileName: '   ' });
  bad({ inlineLimit: 10 });
  assert.doesNotThrow(() => validateArgs('schematic.netlist.export', { netlistType: 'JLCEDA' }));
  const code = COMMANDS['schematic.netlist.export'].buildCode({ inlineLimit: 4096 });
  assert.match(code, /getNetlistFile/);
  assert.match(code, /__circuitpilotExportCache/, '大网表必须走缓存分片');
});

test('网表分片取回：参数校验 + 取回失败返回显式错误而不是空串', () => {
  const bad = (args) => assert.throws(() => validateArgs('schematic.netlist.chunk', args), (error) => error.code === 'EDA_COMMAND_ARGS_INVALID');
  bad({ exportId: '', index: 0 });
  bad({ exportId: 'exp-1', index: -1 });
  bad({ exportId: 'exp-1', index: 1.5 });
  bad({ exportId: 'x'.repeat(201), index: 0 });
  assert.doesNotThrow(() => validateArgs('schematic.netlist.chunk', { exportId: 'exp-1', index: 0 }));
  const code = COMMANDS['schematic.netlist.chunk'].buildCode({ exportId: 'exp-1', index: 2 });
  assert.match(code, /EDA_EXPORT_BUFFER_LOST/);
  assert.match(code, /EDA_EXPORT_CHUNK_RANGE/);
  assert.match(code, /entry\.file\.text\(\)/, '网表是文本，用 text() 取回');
});

test('仿真网表导出：无仿真模型时返回 null（不伪造），类型只放行 Ngspice', () => {
  assert.throws(() => validateArgs('schematic.simulation.netlist.export', { netlistType: 'LTspice' }), (error) => error.code === 'EDA_COMMAND_ARGS_INVALID');
  assert.doesNotThrow(() => validateArgs('schematic.simulation.netlist.export', { netlistType: 'Ngspice' }));
  const code = COMMANDS['schematic.simulation.netlist.export'].buildCode({});
  assert.match(code, /getSimulationNetlistFile/);
  assert.match(code, /if \(!file\) return null/, '导出不到必须返回 null，不能返回值假装成功');
});

test('桥对读命令的瞬时 500：自动重试一次并成功；写命令绝不自动重试', async () => {
  const flaky = [];
  let calls = 0;
  const fetcher = async (url) => {
    if (String(url).endsWith('/health')) return { service: 'easyeda-bridge', status: 'ok' };
    if (String(url).endsWith('/eda-windows')) return { windows: [{ windowId: 'W1', connected: true }] };
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('Bridge HTTP 500'), { code: 'BRIDGE_HTTP_ERROR', status: 500 });
    return { result: { ok: true } };
  };
  const bridge = new BridgeClient({ ports: [49620], fetcher, logger: { warn: (message) => flaky.push(message) } });
  await bridge.discover();
  const read = await bridge.execute('schematic.components');
  assert.deepEqual(read, { result: { ok: true } });
  assert.equal(calls, 2, '读命令应当重试一次');
  assert.ok(flaky.some((message) => message.includes('读命令')), '重试必须留痕，不能偷偷重试');

  // 写命令：同样的瞬时 500 必须直接失败，不能重试（重试可能造成第二次创建）
  calls = 0;
  const writeFetcher = async (url) => {
    if (String(url).endsWith('/health')) return { service: 'easyeda-bridge', status: 'ok' };
    if (String(url).endsWith('/eda-windows')) return { windows: [{ windowId: 'W1', connected: true }] };
    calls += 1;
    throw Object.assign(new Error('Bridge HTTP 500'), { code: 'BRIDGE_HTTP_ERROR', status: 500 });
  };
  const writer = new BridgeClient({ ports: [49620], fetcher: writeFetcher, logger: { warn: () => undefined } });
  await writer.discover();
  await assert.rejects(() => writer.execute('schematic.save', {}, { allowWrite: true }), (error) => error.code === 'BRIDGE_HTTP_ERROR');
  assert.equal(calls, 1, '写命令只允许一次');
});

test('桥慢到打满预算（AbortError/code 20）：读命令重试两次仍可成功', async () => {
  let calls = 0;
  const fetcher = async (url) => {
    if (String(url).endsWith('/health')) return { service: 'easyeda-bridge', status: 'ok' };
    if (String(url).endsWith('/eda-windows')) return { windows: [{ windowId: 'W1', connected: true }] };
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error('This operation was aborted'), { code: 20, name: 'AbortError' });
    return { result: { nets: 13 } };
  };
  const bridge = new BridgeClient({ ports: [49620], fetcher, logger: { warn: () => undefined } });
  await bridge.discover();
  const out = await bridge.execute('schematic.components');
  assert.deepEqual(out, { result: { nets: 13 } });
  assert.equal(calls, 3, '读命令允许两次重试');
});

test('单飞队列：并发发起多个桥命令时，同一时刻只有一个 /execute 在飞（EDA 扩展是单线程，抢就会 500）', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];
  const fetcher = async (url, options = {}) => {
    if (String(url).endsWith('/health')) return { service: 'easyeda-bridge', status: 'ok' };
    if (String(url).endsWith('/eda-windows')) return { windows: [{ windowId: 'W1', connected: true }] };
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const code = String(options.body || '');
    const id = code.includes('B') ? 'B' : 'A';
    order.push(`start-${id}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    order.push(`end-${id}`);
    inFlight -= 1;
    return { result: { ok: true } };
  };
  const bridge = new BridgeClient({ ports: [49620], fetcher, logger: { warn: () => undefined } });
  await bridge.discover();
  await Promise.all([
    bridge.execute('pcb.layers.copperCount', {}),
    bridge.execute('pcb.placement.read', {}),
  ]);
  assert.equal(maxInFlight, 1, '并发命令必须排队，不能同时打桥');
  assert.deepEqual(order, ['start-A', 'end-A', 'start-B', 'end-B']);
});

test('单飞队列：前一条命令失败也要放行下一条（不能因为一次失败把队列锁死）', async () => {
  let firstBody = null;
  const fetcher = async (url, options = {}) => {
    if (String(url).endsWith('/health')) return { service: 'easyeda-bridge', status: 'ok' };
    if (String(url).endsWith('/eda-windows')) return { windows: [{ windowId: 'W1', connected: true }] };
    const body = String(options.body || '');
    if (firstBody === null) firstBody = body;
    // 第一条命令（连同它的重试）一直失败；第二条命令立刻成功
    if (body === firstBody) throw Object.assign(new Error('Bridge HTTP 500'), { code: 'BRIDGE_HTTP_ERROR', status: 500 });
    return { result: { ok: true } };
  };
  const bridge = new BridgeClient({ ports: [49620], fetcher, logger: { warn: () => undefined } });
  await bridge.discover();
  await assert.rejects(() => bridge.execute('pcb.layers.copperCount', {}), (error) => error.code === 'BRIDGE_HTTP_ERROR');
  const ok = await bridge.execute('pcb.placement.read', {});
  assert.deepEqual(ok, { result: { ok: true } });
  assert.equal(bridge._inFlight, 0, '队列不能残留"在飞"计数');
});

/**
 * `pcb.component.create`：签名来自嘉立创EDA 自带 api-types.d.ts（不是猜的），
 * 参数校验必须在**发出请求之前**把明显错误拦下（层号、坐标、缺器件）。
 */
test('pcb.component.create：生成的调用参数正确，明显错误的参数在发请求前就被拦下', async () => {
  const command = COMMANDS['pcb.component.create'];
  assert.ok(command, '命令必须注册');
  assert.equal(command.permission, 'write-beta');
  const code = command.buildCode({ component: { libraryUuid: 'LIB', uuid: 'DEV' }, layer: 1, xMil: 1574.8, yMil: -1181.1, rotationDeg: 90, primitiveLock: true });
  assert.ok(code.includes('"LIB"') && code.includes('"DEV"'), '器件必须原样传进去');
  assert.ok(code.includes('1,1574.8,-1181.1,90,true'), `层/坐标/旋转/锁定顺序必须对: ${code.slice(0, 120)}`);

  let fetches = 0;
  const fetcher = async (url) => {
    if (String(url).endsWith('/health')) return { service: 'easyeda-bridge', status: 'ok' };
    if (String(url).endsWith('/eda-windows')) return { windows: [{ windowId: 'W1', connected: true }] };
    fetches += 1;
    return { result: { primitiveId: 'P1' } };
  };
  const bridge = new BridgeClient({ ports: [49620], fetcher, logger: { warn: () => undefined } });
  await bridge.discover();
  const bad = [
    [ { layer: 1, xMil: 0, yMil: 0 }, '缺器件' ],
    [ { component: { uuid: 'D' }, layer: 3, xMil: 0, yMil: 0 }, '层号必须是 1/2' ],
    [ { component: { uuid: 'D' }, layer: 1, xMil: Number.NaN, yMil: 0 }, '坐标必须是有限数' ],
    [ { component: { uuid: 'D' }, layer: 1, xMil: 0, yMil: 0, rotationDeg: 'left' }, '旋转必须是数' ],
  ];
  for (const [args, why] of bad) {
    await assert.rejects(() => bridge.execute('pcb.component.create', args, { allowWrite: true }), (error) => error.code === 'EDA_COMMAND_ARGS_INVALID', why);
  }
  assert.equal(fetches, 0, '参数错误不得发出任何桥请求');
  const ok = await bridge.execute('pcb.component.create', { component: { uuid: 'D' }, layer: 2, xMil: 1, yMil: 2 }, { allowWrite: true });
  assert.deepEqual(ok, { result: { primitiveId: 'P1' } });
  assert.equal(fetches, 1);
});

test('document.source.restore：默认不校验文档；传 expectedDocumentUuid 时必须先比对激活文档再写', async () => {
  const command = COMMANDS['document.source.restore'];
  assert.ok(command, '命令必须注册');
  const plain = command.buildCode({ source: '{"type":"DOCHEAD"}||{}|' });
  assert.ok(!plain.includes('getCurrentDocumentInfo'), '不传期望文档时保持原行为，不额外读文档');
  assert.ok(plain.includes('setDocumentSource'), '必须调用官方写接口');

  const guarded = command.buildCode({ source: '{"type":"DOCHEAD"}||{}|', expectedDocumentUuid: 'DOC-1' });
  assert.ok(guarded.includes('getCurrentDocumentInfo'), '传期望文档时必须先读激活文档');
  assert.ok(guarded.includes('"DOC-1"'), '期望文档 id 必须进入校验');
  assert.ok(guarded.includes('EDA_SOURCE_RESTORE_TARGET_MISMATCH'), '不一致必须有稳定错误码');
  assert.ok(guarded.indexOf('getCurrentDocumentInfo') < guarded.indexOf('setDocumentSource'), '校验必须在写入之前');

  let fetches = 0;
  const fetcher = async (url) => {
    if (String(url).endsWith('/health')) return { service: 'easyeda-bridge', status: 'ok' };
    if (String(url).endsWith('/eda-windows')) return { windows: [{ windowId: 'W1', connected: true }] };
    fetches += 1;
    return { result: true };
  };
  const bridge = new BridgeClient({ ports: [49620], fetcher, logger: { warn: () => undefined } });
  await bridge.discover();
  await assert.rejects(
    () => bridge.execute('document.source.restore', { source: 'x', expectedDocumentUuid: '  ' }, { allowWrite: true }),
    (error) => error.code === 'EDA_COMMAND_ARGS_INVALID',
    '空白 expectedDocumentUuid 必须被拦下',
  );
  assert.equal(fetches, 0, '参数错误不得发出任何桥请求');
});

test('未显式发现时 execute 会自动发现桥：运行时重启后首次调用不应 BRIDGE_NOT_FOUND', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) return { service: 'easyeda-bridge' };
    if (url.endsWith('/eda-windows')) return { windows: [{ windowId: 'A', active: true }] };
    if (url.endsWith('/execute')) return { ok: true };
    throw new Error(`Unexpected URL ${url}`);
  };
  const client = new BridgeClient({ ports: [49620], fetcher });
  // 刻意不调 discover()：模拟运行时刚重启、还没人触发过发现的真机状态
  const result = await client.execute('project.current');
  assert.deepEqual(result, { ok: true }, '惰性发现后应能直接执行命令');
  assert.ok(calls.some((call) => call.url.endsWith('/health')), '必须先探测 /health 完成发现');
});

test('pcb.copper.read：矩形焊盘半径走"内切半径" helper（0.4mm 间距器件不再被判焊盘重叠）', () => {
  const code = COMMANDS['pcb.copper.read'].code;
  assert.match(code, /const padRadius=function padClearanceRadiusMil\(sizes\)/, '焊盘半径 helper 必须内联进远程脚本');
  assert.match(code, /const radius=padRadius\(sizes\);/, '必须调用 helper，而不是各自内联取 max');
  assert.doesNotMatch(code, /Math\.max\.apply\(null,sizes\)\/2/, '旧实现（长边/2）不得残留');
});

test('桥重启后 windows() 自动重新发现端口：不再永久 BRIDGE_NOT_FOUND（真机演练回归）', async () => {
  const calls = [];
  const client = new BridgeClient({
    ports: [49620, 49621],
    fetcher: async (url) => {
      calls.push(url);
      if (url.includes('/health')) return { service: 'easyeda-bridge', version: 'test', edaConnected: true };
      if (url.includes('/eda-windows')) return { windows: [{ windowId: 'w-after-restart', connected: true }], count: 1 };
      throw new Error(`unexpected ${url}`);
    },
  });
  // 模拟"上一次 discover 没发现桥"把 port 置空的状态。
  client.port = null;
  const data = await client.windows();
  assert.equal(data.windows.length, 1);
  assert.equal(data.windows[0].windowId, 'w-after-restart');
  assert.equal(client.selectedWindowId, 'w-after-restart');
  assert.ok(calls.some((url) => url.endsWith('/health')), '必须先发现桥端口');
});

// ---------------------------------------------------------------------------
// HTTP 语义契约（第 61 轮）：桥连通性故障必须是 503 Service Unavailable，而不是 400。
//
// 背景：bridge.mjs 抛出的 BRIDGE_UNREACHABLE / BRIDGE_TIMEOUT 不带 status，顶层 catch
// 以前一律兜底成 400，把"桥暂时不可用、可重试"说成了"请求参数错误"。这里用注入假桥
// 的真实 Runtime HTTP 服务（不碰真机 EDA）锁死：状态码、错误码/文案、retryable 标记。
// ---------------------------------------------------------------------------

const fakeKeychain = { async configured() { return false; }, async read() { throw new Error('unused'); } };

/**
 * 起一个只注入假桥的真实 Runtime HTTP 服务（离线）。
 * 状态/证据目录隔离到临时目录，避免读到开发机上真实的工程/证据。
 */
async function withRuntimeServer(bridge, run) {
  const savedStateDir = process.env.CIRCUITPILOT_STATE_DIR;
  const savedEvidenceDir = process.env.CIRCUITPILOT_EVIDENCE_DIR;
  const stateDir = mkdtempSync(join(tmpdir(), 'cp-bridge-status-state-'));
  const evidenceDir = mkdtempSync(join(tmpdir(), 'cp-bridge-status-evidence-'));
  process.env.CIRCUITPILOT_STATE_DIR = stateDir;
  process.env.CIRCUITPILOT_EVIDENCE_DIR = evidenceDir;
  const { server, sessionToken } = createRuntimeServer({ keychain: fakeKeychain, bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { 'x-circuitpilot-token': sessionToken, ...(init.headers || {}) },
  });
  try {
    await run({ request, base });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (savedStateDir === undefined) delete process.env.CIRCUITPILOT_STATE_DIR;
    else process.env.CIRCUITPILOT_STATE_DIR = savedStateDir;
    if (savedEvidenceDir === undefined) delete process.env.CIRCUITPILOT_EVIDENCE_DIR;
    else process.env.CIRCUITPILOT_EVIDENCE_DIR = savedEvidenceDir;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
}

/** 假桥：windows() 永远抛指定连通性错误；discover() 模拟"端口确实还能发现"。 */
function bridgeWithConnectivityFailure(code) {
  const message = code === 'BRIDGE_TIMEOUT'
    ? 'Bridge 请求超时（未在预算内返回）'
    : 'Bridge 不可达（fetch failed）：桥进程可能已随 EDA 退出';
  return {
    port: 49620,
    selectedWindowId: 'w-bridge-status',
    async discover() { this.port = 49620; return { port: 49620 }; },
    async windows() { throw Object.assign(new Error(message), { code }); },
    async execute() { throw Object.assign(new Error('不应执行到命令'), { code: 'EDA_OFFLINE' }); },
    listCommands() { return []; },
  };
}

test('桥不可达：只读 EDA 路由返回 503 + retryable，而不是 400', async () => {
  await withRuntimeServer(bridgeWithConnectivityFailure('BRIDGE_UNREACHABLE'), async ({ request }) => {
    // 直连 bridge.windows() 的路由。
    const windows = await request('/api/eda/windows');
    assert.equal(windows.status, 503, '桥不可达必须是 503 Service Unavailable（不是 400）');
    const windowsBody = await windows.json();
    assert.equal(windowsBody.ok, false);
    assert.equal(windowsBody.error.code, 'BRIDGE_UNREACHABLE', '原有错误码必须保留');
    assert.match(windowsBody.error.message, /Bridge 不可达/, '原有文案必须保留');
    assert.equal(windowsBody.error.retryable, true, '瞬时断线必须标 retryable');

    // 走 ensureEdaSession（先 discover 再 windows）的只读路由也必须同样映射，
    // 不能只在"某个刚好没被包装的路由"上生效。
    const layers = await request('/api/eda/pcb/layers');
    assert.equal(layers.status, 503);
    const layersBody = await layers.json();
    assert.equal(layersBody.error.code, 'BRIDGE_UNREACHABLE');
    assert.equal(layersBody.error.retryable, true);
  });
});

test('桥超时：只读 EDA 路由返回 503 + retryable，而不是 400', async () => {
  await withRuntimeServer(bridgeWithConnectivityFailure('BRIDGE_TIMEOUT'), async ({ request }) => {
    const response = await request('/api/eda/pcb/layers');
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'BRIDGE_TIMEOUT');
    assert.equal(body.error.retryable, true);
  });
});

test('桥未发现：保持 503（契约不变），但不标 retryable（需先启动/发现桥）', async () => {
  const bridge = {
    port: null,
    selectedWindowId: null,
    async discover() { this.port = null; return null; },
    async windows() { throw new Error('未发现桥时不应调用 windows'); },
    async execute() { throw new Error('未发现桥时不应执行命令'); },
    listCommands() { return []; },
  };
  await withRuntimeServer(bridge, async ({ request }) => {
    const response = await request('/api/eda/pcb/layers');
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'BRIDGE_NOT_FOUND');
    assert.equal(body.error.retryable, undefined, '未发现桥不是"立即可重试"的瞬时故障');
  });
});

test('非桥连通性错误维持原状态码：未知路由 404、参数错误 400（503 映射不得放大）', async () => {
  await withRuntimeServer(bridgeWithConnectivityFailure('BRIDGE_UNREACHABLE'), async ({ request }) => {
    const missing = await request('/api/not-a-route');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'ROUTE_NOT_FOUND');

    const bad = await request('/api/eda/pcb/layers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ copperLayers: 3 }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'EDA_COMMAND_ARGS_INVALID');
  });
});
