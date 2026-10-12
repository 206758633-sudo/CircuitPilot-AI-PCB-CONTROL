import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeClient, COMMANDS, validateArgs } from '../bridge.mjs';

const INJECTION_MARKER = '__CIRCUITPILOT_INJECTION_MARKER__';
const HOSTILE = `0,0,true,true);globalThis.${INJECTION_MARKER}=1;//`;

test('every argument interpolated into EDA source is type-checked', () => {
  const component = { libraryUuid: 'lib', uuid: 'dev' };
  const cases = [
    ['schematic.component.create', { component, x: 1, y: 1, rotation: HOSTILE }],
    ['schematic.component.create', { component, x: 1, y: 1, mirror: HOSTILE }],
    ['schematic.component.create', { component, x: 1, y: 1, addIntoBom: HOSTILE }],
    ['schematic.component.create', { component, x: 1, y: 1, addIntoPcb: HOSTILE }],
    ['schematic.netFlag.create', { identification: 'Power', net: '3V3', x: 1, y: 1, rotation: HOSTILE }],
    ['schematic.netFlag.create', { identification: 'Power', net: '3V3', x: 1, y: 1, mirror: HOSTILE }],
    ['pcb.line.create', { layer: 11, startX: 0, startY: 0, endX: 1, endY: 1, primitiveLock: HOSTILE }],
    ['pcb.pour.create', { net: 'GND', layer: 1, complexPolygon: {}, preserveSilos: HOSTILE }],
    ['pcb.pour.create', { net: 'GND', layer: 1, complexPolygon: {}, pourPriority: HOSTILE }],
    ['pcb.pour.create', { net: 'GND', layer: 1, complexPolygon: {}, lineWidth: HOSTILE }],
    ['pcb.pour.create', { net: 'GND', layer: 1, complexPolygon: {}, primitiveLock: HOSTILE }],
    ['pcb.via.create', { net: '', x: 1, y: 1, holeDiameter: 0.3, diameter: 0.6, viaType: { nested: true } }],
  ];
  for (const [commandId, args] of cases) {
    assert.throws(() => validateArgs(commandId, args), { code: 'EDA_COMMAND_ARGS_INVALID' }, `${commandId} accepted ${JSON.stringify(args)}`);
  }
});

test('hostile plan arguments stay inert data instead of executing inside the EDA extension', async () => {
  const cases = {
    'schematic.component.create': { component: { libraryUuid: 'lib', uuid: 'dev' }, x: 1, y: 1, rotation: HOSTILE, mirror: false, addIntoBom: true, addIntoPcb: true },
    'schematic.netFlag.create': { identification: 'Power', net: '3V3', x: 1, y: 1, rotation: 0, mirror: HOSTILE },
    'pcb.line.create': { layer: 11, startX: 0, startY: 0, endX: 1, endY: 1, lineWidth: 0.2, primitiveLock: HOSTILE },
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
  assert.equal(executed.length, Object.keys(cases).length, 'every generated command should have really executed against the fake EDA API');
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

test('每个 buildCode 命令都把参数当作 JSON 数据插值（整体不变量，含未来新增命令）', () => {
  // 上面的用例手工列出了 5 个命令。这里改成对 COMMANDS 里所有 buildCode 命令统一施加不变量：
  // 任何一个“新加命令时忘了 JSON.stringify”的改动都会在这里失败，而不是等到线上被注入。
  // 扩展源码不在本仓库内，无法验证接收端，所以协议安全只能靠这条出栈侧的冻结不变量守住。
  const generators = Object.entries(COMMANDS).filter(([, command]) => typeof command.buildCode === 'function');
  assert.ok(generators.length >= 10, `buildCode 命令数量异常（${generators.length}），不变量可能已失效`);

  // 用 Proxy 让任意参数名都返回恶意字符串，无需为每个命令维护参数表。
  const hostileArgs = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? HOSTILE : undefined), has: () => true });

  for (const [commandId, command] of generators) {
    const code = command.buildCode(hostileArgs);
    assert.equal(typeof code, 'string', `${commandId} 的 buildCode 未返回字符串`);
    // 把字符串字面量全部替换掉后，生成的源码里不允许再残留任何恶意片段。
    const withoutStrings = code.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    assert.ok(!withoutStrings.includes(INJECTION_MARKER), `${commandId} 把参数插到了字符串字面量之外：${code}`);
    // 反向确认：恶意值确实作为转义后的数据出现在字符串字面量里（否则上面的检查是空转）。
    assert.ok(code.includes('__CIRCUITPILOT_INJECTION_MARKER__'), `${commandId} 没有把注入标记放入字符串字面量：${code}`);
  }
});

test('所有 buildCode 命令在恶意参数下生成的源码都是可解析的合法表达式', () => {
  const generators = Object.entries(COMMANDS).filter(([, command]) => typeof command.buildCode === 'function');
  const hostileArgs = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? HOSTILE : undefined), has: () => true });
  for (const [commandId, command] of generators) {
    const code = command.buildCode(hostileArgs);
    // 只做语法解析，不执行：注入成功的话这里会直接抛 SyntaxError。
    assert.doesNotThrow(() => new Function('eda', `return (async () => { ${code} })()`), `${commandId} 生成的源码无法解析`);
  }
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
