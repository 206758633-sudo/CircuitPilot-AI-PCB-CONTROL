/**
 * lib/host.mjs 单测：DSH 宿主版本探测 + MCP/native/legacy 三态自适应注册。
 * 全部离线，不依赖真实 DSH 实例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  REGISTRATION_MODES,
  TOOL_RESULT_SCHEMA,
  createToolRegistrar,
  describeHost,
  detectHost,
  resultText,
  toToolResult,
} from '../lib/host.mjs';
import { TOOL_NAMES, createCircuitPilotTools } from '../lib/tools.mjs';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));

const compat = JSON.parse(await readFile(join(pluginDir, 'compat.json'), 'utf8'));

/** 只提供 ctx.tools.register 的最小 fake ctx。 */
function fakeCtx(register) {
  return { tools: { register } };
}

/** 真实工具集（不联网：client 只返回错误信封，注册阶段不会调用它）。 */
function realTools(host) {
  const client = { request: async () => ({ ok: false, code: 'FAKE', message: 'fake client', nextActions: [] }) };
  return createCircuitPilotTools({
    config: { runtimeUrl: 'http://127.0.0.1:1', agentTokenFile: join(pluginDir, '.no-token') },
    client,
    host,
  });
}

function assertToolResultShape(value) {
  assert.ok(Array.isArray(value.content) && value.content.length > 0, 'content 必须是非空数组');
  assert.equal(value.content[0].type, 'text');
  assert.equal(typeof value.content[0].text, 'string');
  assert.ok(value.structuredContent && typeof value.structuredContent === 'object');
}

/* ---------------------------------------------------------------- */
test('detectHost：0.2.1-rc.5 兼容 / 0.2.0 不兼容 / 探测不到版本不崩', () => {
  const ok = detectHost({ version: '0.2.1-rc.5', packageVersion: '0.2.0' });
  assert.equal(ok.version, '0.2.1-rc.5');
  assert.equal(ok.compatible, true);
  assert.equal(ok.unknown, false);
  assert.equal(ok.supportedRange, compat.dsh.supported);
  assert.deepEqual(ok.verified, compat.dsh.verified);
  assert.equal(ok.pluginVersion, '0.2.0');

  const old = detectHost({ version: '0.2.0' });
  assert.equal(old.compatible, false);
  assert.match(String(old.reason), /不在插件支持区间/);

  const unknown = detectHost({ version: '', env: { DSH_HOME: join(pluginDir, '.no-such-home'), HOME: join(pluginDir, '.no-home') } });
  assert.equal(unknown.version, null);
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.compatible, false);
  assert.ok(typeof unknown.reason === 'string' && unknown.reason.length > 0);
});

test('detectHost：从 DSH_HOME 的 runtime.json 读取 desktopVersion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-home-'));
  try {
    const dir = join(home, 'dsh-runtimes', 'dsh-primary-runtime');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.1-rc.5' }), 'utf8');
    const host = detectHost({ env: { DSH_HOME: home, HOME: home } });
    assert.equal(host.version, '0.2.1-rc.5');
    assert.equal(host.compatible, true);
    assert.match(String(host.source), /runtime\.json$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('describeHost：包含版本、兼容判定与注册模式', () => {
  const host = detectHost({ version: '0.2.1-rc.5' });
  host.registration = 'native';
  const text = describeHost(host);
  assert.match(text, /0\.2\.1-rc\.5/);
  assert.match(text, /兼容/);
  assert.match(text, /native/);
  assert.match(describeHost(null), /未知/);
});

/* ---------------------------------------------------------------- */
test('自适应注册 MCP 模式：createMcpToolDefinition 可用时优先使用官方定义', () => {
  const registered = [];
  const ctx = fakeCtx((definition) => {
    registered.push(definition);
    return () => {};
  });
  const createMcpToolDefinition = (c, options) => ({
    name: options.name,
    description: options.description,
    parameters: options.inputSchema,
    output: { schema: TOOL_RESULT_SCHEMA, render: () => [{ type: 'text', text: 'x' }] },
    execute: options.call,
  });
  const host = detectHost({ version: '0.2.1-rc.5' });
  const registrar = createToolRegistrar(ctx, { createMcpToolDefinition, host });
  for (const tool of realTools(host)) registrar.registerTool(tool);

  assert.equal(registrar.mode, 'mcp');
  assert.deepEqual(registrar.modesUsed, ['mcp']);
  assert.deepEqual(registered.map((definition) => definition.name), [...TOOL_NAMES]);
  assert.equal(registrar.failed.length, 0);
});

test('自适应注册 native 模式：rc.5 契约（output.schema + render + parameters）', async () => {
  const registered = [];
  const ctx = fakeCtx((definition) => {
    // 模拟 DSH 0.2.1-rc.5 的 dsh-tools 校验
    if (definition.output === undefined || typeof definition.output.render !== 'function') {
      throw new TypeError(`tool "${definition.name}" must declare output { schema, render, presentationMeta? }`);
    }
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(definition.parameters.type, 'object');
    registered.push(definition);
    return () => {};
  });
  const host = detectHost({ version: '0.2.1-rc.5' });
  const registrar = createToolRegistrar(ctx, { createMcpToolDefinition: null, host });
  for (const tool of realTools(host)) registrar.registerTool(tool);

  assert.equal(registrar.mode, 'native');
  assert.deepEqual(registered.map((definition) => definition.name), [...TOOL_NAMES]);
  assert.equal(registrar.failed.length, 0);

  // native 定义的 execute 必须返回 MCP 信封，render 必须产出模型可见 text。
  const tool = {
    name: 'cp_status',
    description: 'fake status',
    type: 'read',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: async () => ({ ok: true, summary: 'hello-native' }),
  };
  const single = [];
  const ctx2 = fakeCtx((definition) => {
    single.push(definition);
    return () => {};
  });
  const registrar2 = createToolRegistrar(ctx2, { host });
  registrar2.registerTool(tool);
  const definition = single[0];
  const value = await definition.execute({}, { signal: undefined });
  assertToolResultShape(value);
  assert.equal(value.structuredContent.summary, 'hello-native');
  const rendered = definition.output.render({}, value);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /hello-native/);
  assert.equal(typeof definition.isConcurrencySafe, 'function');
  assert.equal(definition.isConcurrencySafe(), true);
});

test('自适应注册 legacy 模式：旧宿主只接受 inputSchema + execute 时自动降级', () => {
  const registered = [];
  const ctx = fakeCtx((definition) => {
    if (definition.parameters !== undefined || definition.output !== undefined) {
      throw new TypeError('legacy host: unexpected fields parameters/output');
    }
    if (definition.inputSchema === undefined) throw new TypeError('legacy host requires inputSchema');
    registered.push(definition);
    return () => {};
  });
  const host = detectHost({ version: '0.2.0' });
  const registrar = createToolRegistrar(ctx, { host });
  for (const tool of realTools(host)) registrar.registerTool(tool);

  assert.equal(registrar.mode, 'legacy');
  assert.deepEqual(registered.map((definition) => definition.name), [...TOOL_NAMES]);
  assert.ok(registered.every((definition) => definition.inputSchema.type === 'object'));
  assert.equal(registrar.failed.length, 0);
});

test('注册失败隔离：单个工具注册抛错不影响其它工具，失败被记录', () => {
  const registered = [];
  const ctx = fakeCtx((definition) => {
    if (definition.name === 'cp_status') throw new Error('boom');
    registered.push(definition);
    return () => {};
  });
  const host = detectHost({ version: '0.2.1-rc.5' });
  const registrar = createToolRegistrar(ctx, { host });
  const tools = realTools(host);
  for (const tool of tools) registrar.registerTool(tool);

  assert.equal(registered.length, tools.length - 1);
  assert.equal(registrar.failed.length, 1);
  assert.equal(registrar.failed[0].name, 'cp_status');
  assert.ok(registrar.failed[0].attempts.length >= 1);
});

test('disposeAll：注册 disposer 全部被调用，清理函数可重复调用', () => {
  let disposed = 0;
  const ctx = fakeCtx(() => () => { disposed += 1; });
  const host = detectHost({ version: '0.2.1-rc.5' });
  const registrar = createToolRegistrar(ctx, { host });
  for (const tool of realTools(host)) registrar.registerTool(tool);
  registrar.disposeAll();
  assert.equal(disposed, TOOL_NAMES.length);
  registrar.disposeAll();
  assert.equal(disposed, TOOL_NAMES.length);
});

test('工具返回值透传：execute 抛错不被 host 层吞掉', async () => {
  const ctx = fakeCtx(() => () => {});
  const host = detectHost({ version: '0.2.1-rc.5' });
  const registrar = createToolRegistrar(ctx, { host });
  let captured = null;
  const ctxCapturing = fakeCtx((definition) => {
    captured = definition;
    return () => {};
  });
  const registrar2 = createToolRegistrar(ctxCapturing, { host });
  registrar2.registerTool({
    name: 'cp_status',
    description: 'throws',
    type: 'read',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => { throw new Error('execute-boom'); },
  });
  await assert.rejects(() => captured.execute({}, {}), /execute-boom/);
  assert.equal(typeof registrar.registerTool, 'function');
});

test('toToolResult / resultText：MCP 信封与文本投影', () => {
  const value = { ok: true, summary: 'summary-text' };
  const envelope = toToolResult(value);
  assertToolResultShape(envelope);
  assert.deepEqual(envelope.structuredContent, value);
  assert.match(resultText(envelope), /summary-text/);
});

test('REGISTRATION_MODES 顺序与 package.json / compat.json 一致性', async () => {
  assert.deepEqual(REGISTRATION_MODES, ['mcp', 'native', 'legacy']);
  const pkg = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.dsh, compat.dsh.supported);
  assert.ok(pkg.files.includes('compat.json'));
  assert.equal(pkg.files.includes('compat.json'), true);
});
