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
