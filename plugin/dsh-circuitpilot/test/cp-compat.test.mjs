import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CP_CAPABILITIES,
  CP_CAPABILITY_STATUS,
  CP_PLUGIN_METADATA,
  clearCompatCache,
  classifyCapabilityOutcome,
  compatNextActions,
  ensureRuntimeCompatible,
  evaluateHealthCompat,
  isRouteMissingEnvelope,
  listMissingCapabilityDeclarations,
  probeCapabilities,
  summarizeCompat,
  summarizePluginHost,
} from '../lib/cp-compat.mjs';
import {
  CP_REQUIRED_CAPABILITIES,
  CP_SUPPORTED_RUNTIME_RANGE,
  CP_VERIFIED_RUNTIME_VERSIONS,
  DSH_SUPPORTED_RANGE,
  DSH_VERIFIED_VERSIONS,
} from '../lib/compat.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';
import { RuntimeClient } from '../lib/runtime.mjs';
import { TEST_TOKEN, createDefaultRouter, startFakeRuntime } from './helpers.mjs';

/* ------------------------------------------------------------------ */
/* 测试辅助：同形 RuntimeClient 的 stub（零网络、可注入失败）           */
/* ------------------------------------------------------------------ */

function okEnvelope(data) {
  return { ok: true, status: 200, data, truncated: false };
}

function errorEnvelope(code, { status = 400, message = `fake error ${code}` } = {}) {
  return { ok: false, status, code, message, nextActions: [] };
}

/** routes: path -> envelope | (call) => envelope（缺省 404 ROUTE_NOT_FOUND）。 */
function stubClient(routes = {}) {
  const calls = [];
  return {
    calls,
    async request(method, path, options = {}) {
      calls.push({ method, path, options });
      const route = routes[path];
      if (route === undefined) return errorEnvelope('ROUTE_NOT_FOUND', { status: 404, message: `fake runtime 没有实现 ${method} ${path}` });
      return typeof route === 'function' ? route({ method, path, options }) : route;
    },
  };
}

function healthBody(version) {
  return { ok: true, service: 'circuitpilot-runtime', host: '127.0.0.1', ...(version === undefined ? {} : { version }) };
}

function healthClient(version, extraRoutes = {}) {
  return stubClient({ '/api/health': () => okEnvelope(healthBody(version)), ...extraRoutes });
}

/** 所有能力都存在的路由表（成功响应）。 */
function allCapabilitiesRoutes() {
  const routes = {};
  for (const capability of CP_CAPABILITIES) routes[capability.path] = () => okEnvelope({ ok: true });
  return routes;
}

/* ------------------------------------------------------------------ */
/* 能力矩阵不变量                                                      */
/* ------------------------------------------------------------------ */

test('CP_CAPABILITIES：覆盖 compat.json 声明的全部必需能力，且全部是 GET 只读路由', () => {
  assert.deepEqual(listMissingCapabilityDeclarations(), [], 'CP_CAPABILITIES 必须覆盖 requiredCapabilities');
  assert.deepEqual(CP_CAPABILITIES.map((item) => item.id), [...CP_REQUIRED_CAPABILITIES]);
  const ids = CP_CAPABILITIES.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, '能力 id 必须唯一');
  for (const capability of CP_CAPABILITIES) {
    assert.equal(capability.method, 'GET', `${capability.id} 只能是 GET 只读探测`);
    assert.match(capability.path, /^\/api\//);
    assert.ok(capability.label.length > 0);
    assert.ok(Array.isArray(capability.requiredBy) && capability.requiredBy.length > 0);
    for (const toolName of capability.requiredBy) {
      assert.ok(TOOL_NAMES.includes(toolName), `${capability.id}.requiredBy 含未知工具 ${toolName}`);
    }
  }
  assert.deepEqual(
    CP_CAPABILITIES.find((item) => item.id === 'agent-api').requiredBy,
    ['cp_design_plan', 'cp_pcb_plan', 'cp_approve'],
  );
  assert.equal(CP_CAPABILITIES.find((item) => item.id === 'agent-api').path, '/api/agent/status');
  assert.equal(CP_CAPABILITIES.find((item) => item.id === 'eda-workspace').path, '/api/eda/workspaces/current');
  assert.equal(Object.isFrozen(CP_CAPABILITIES), true);
  assert.equal(Object.isFrozen(CP_CAPABILITIES[0].requiredBy), true);
});

/* ------------------------------------------------------------------ */
/* health / 版本判定矩阵                                               */
/* ------------------------------------------------------------------ */

test('evaluateHealthCompat：版本判定矩阵（0.2.x 支持；0.8.15/0.3.0/9.9.9-test 越界；缺失/非法 unknown）', () => {
  for (const version of ['0.2.0', '0.2.1']) {
    const evaluated = evaluateHealthCompat(healthBody(version));
    assert.equal(evaluated.version, version);
    assert.equal(evaluated.service, 'circuitpilot-runtime');
    assert.equal(evaluated.versionCompat.supported, true, `${version} 应支持`);
    assert.equal(evaluated.versionCompat.unknown, false);
    assert.equal(evaluated.usable, true);
    assert.equal(evaluated.reason, null);
    assert.equal(evaluated.versionCompat.range, CP_SUPPORTED_RUNTIME_RANGE);
    assert.deepEqual(evaluated.versionCompat.verified, [...CP_VERIFIED_RUNTIME_VERSIONS]);
  }
  for (const version of ['0.8.15', '0.3.0', '9.9.9-test']) {
    const evaluated = evaluateHealthCompat(healthBody(version));
    assert.equal(evaluated.versionCompat.supported, false, `${version} 不应支持`);
    assert.equal(evaluated.versionCompat.unknown, false, `${version} 是可解析版本`);
    assert.equal(evaluated.usable, false, `${version} 不可用`);
    assert.match(evaluated.reason, /不在插件支持区间/);
  }
  for (const data of [null, {}, { version: '' }, { version: 'not-a-version' }, { version: '0.2' }]) {
    const evaluated = evaluateHealthCompat(data);
    assert.equal(evaluated.versionCompat.unknown, true);
    assert.equal(evaluated.versionCompat.supported, false);
    assert.equal(evaluated.usable, true, '无法判定的版本不能硬拦（保持只读诊断可用）');
    assert.ok(evaluated.reason);
  }
});

test('ensureRuntimeCompatible：兼容版本 → ok:true 且带 versionCompat/health', async () => {
  const client = healthClient('0.2.0');
  const result = await ensureRuntimeCompatible({ client });
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.2.0');
  assert.equal(result.service, 'circuitpilot-runtime');
  assert.equal(result.versionCompat.supported, true);
  assert.equal(result.warning, null);
  assert.equal(result.health.version, '0.2.0');
  assert.deepEqual(client.calls.map((call) => `${call.method} ${call.path}`), ['GET /api/health']);
});

test('ensureRuntimeCompatible：可解析且越界 → RUNTIME_VERSION_UNSUPPORTED（0.8.15 / 0.3.0 / 9.9.9-test）', async () => {
  for (const version of ['0.8.15', '0.3.0', '9.9.9-test']) {
    const client = healthClient(version);
    const result = await ensureRuntimeCompatible({ client });
    assert.equal(result.ok, false, `${version} 必须 fail-closed`);
    assert.equal(result.code, 'RUNTIME_VERSION_UNSUPPORTED');
    assert.match(result.message, /版本不兼容/);
    assert.ok(result.message.includes(version), 'message 必须写明检测到的版本');
    assert.ok(result.message.includes(CP_SUPPORTED_RUNTIME_RANGE), 'message 必须写明支持区间');
    assert.equal(result.data.runtimeVersion, version);
    assert.equal(result.data.supportedRange, CP_SUPPORTED_RUNTIME_RANGE);
    assert.deepEqual(result.data.verified, [...CP_VERIFIED_RUNTIME_VERSIONS]);
    assert.ok(Array.isArray(result.nextActions) && result.nextActions.length >= 3, '必须给出可操作 nextActions');
    const actions = result.nextActions.join(' ');
    assert.match(actions, /升级|切换/);
    assert.match(actions, /回退/);
    assert.match(actions, new RegExp(CP_SUPPORTED_RUNTIME_RANGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('ensureRuntimeCompatible：版本缺失/非法 → ok:true + warning（不硬失败）', async () => {
  for (const version of [undefined, '', 'not-a-version']) {
    const client = healthClient(version);
    const result = await ensureRuntimeCompatible({ client });
    assert.equal(result.ok, true, `${String(version)} 不能硬失败`);
    assert.equal(result.versionCompat.unknown, true);
    assert.match(result.warning, /无法判定 Runtime 版本兼容性/);
    assert.equal(result.version, version ? version : null);
  }
});

test('ensureRuntimeCompatible：Runtime 不可达 → RUNTIME_UNREACHABLE + 可执行提示', async () => {
  const networkClient = stubClient({
    '/api/health': () => errorEnvelope('RUNTIME_UNREACHABLE', { status: 0, message: '无法连接 CircuitPilot Runtime' }),
  });
  const networkResult = await ensureRuntimeCompatible({ client: networkClient });
  assert.equal(networkResult.ok, false);
  assert.equal(networkResult.code, 'RUNTIME_UNREACHABLE');
  assert.match(networkResult.message, /无法连接/);
  assert.ok(networkResult.nextActions.length > 0);
  assert.equal(networkResult.data.originalCode, 'RUNTIME_UNREACHABLE');

  const throwingClient = {
    async request() {
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    },
  };
  const thrown = await ensureRuntimeCompatible({ client: throwingClient });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, 'RUNTIME_UNREACHABLE');
  assert.match(thrown.message, /fetch failed/);
});

test('ensureRuntimeCompatible：health 业务错误（409/500/token）→ 放行 + warning，交给具体工具报真实错误', async () => {
  for (const [code, status] of [['PLAN_INCOMPLETE', 409], ['RUNTIME_ERROR', 500], ['AGENT_TOKEN_MISSING', 0]]) {
    const client = stubClient({ '/api/health': () => errorEnvelope(code, { status }) });
    const result = await ensureRuntimeCompatible({ client });
    assert.equal(result.ok, true, `${code} 不应被误报为版本不兼容`);
    assert.match(result.warning, /无法判定 Runtime 版本兼容性/);
    assert.equal(result.versionCompat.unknown, true);
  }
});

test('ensureRuntimeCompatible：成功结果缓存 30s，失败不缓存', async () => {
  let now = 1_000_000;
  const clock = () => now;
  const client = healthClient('0.2.0');
  const healthCalls = () => client.calls.filter((call) => call.path === '/api/health').length;

  assert.equal((await ensureRuntimeCompatible({ client, clock })).cached, false);
  assert.equal((await ensureRuntimeCompatible({ client, clock })).cached, true);
  assert.equal(healthCalls(), 1, 'TTL 内只打一次 health');
  now += 29_999;
  await ensureRuntimeCompatible({ client, clock });
  assert.equal(healthCalls(), 1, 'TTL 边界内仍命中缓存');
  now += 1;
  await ensureRuntimeCompatible({ client, clock });
  assert.equal(healthCalls(), 2, 'TTL 过期后重新探测');
  await ensureRuntimeCompatible({ client, clock, force: true });
  assert.equal(healthCalls(), 3, 'force 跳过缓存');

  const unsupported = healthClient('0.8.15');
  await ensureRuntimeCompatible({ client: unsupported, clock });
  await ensureRuntimeCompatible({ client: unsupported, clock });
  assert.equal(unsupported.calls.filter((call) => call.path === '/api/health').length, 2, '失败结果不缓存');
});

test('ensureRuntimeCompatible / probeCapabilities：没有 client 时优雅降级、不抛异常', async () => {
  const gate = await ensureRuntimeCompatible({});
  assert.equal(gate.ok, true);
  assert.match(gate.warning, /跳过版本兼容门禁/);
  const probe = await probeCapabilities({});
  assert.equal(probe.complete, false);
  assert.deepEqual(probe.missing, []);
  assert.ok(probe.error);
});

/* ------------------------------------------------------------------ */
/* 能力探测                                                            */
/* ------------------------------------------------------------------ */

test('classifyCapabilityOutcome / isRouteMissingEnvelope：404=缺失、409/业务错误=存在、网络=unknown', () => {
  assert.equal(isRouteMissingEnvelope(errorEnvelope('ROUTE_NOT_FOUND', { status: 404 })), true);
  assert.equal(isRouteMissingEnvelope({ ok: false, status: 404, code: 'SOMETHING_ELSE', message: '' }), true);
  assert.equal(isRouteMissingEnvelope({ ok: true, status: 200, data: {} }), false);
  assert.equal(isRouteMissingEnvelope(null), false);

  assert.equal(classifyCapabilityOutcome(okEnvelope({ ok: true })), CP_CAPABILITY_STATUS.AVAILABLE);
  assert.equal(classifyCapabilityOutcome(errorEnvelope('ROUTE_NOT_FOUND', { status: 404 })), CP_CAPABILITY_STATUS.MISSING);
  assert.equal(classifyCapabilityOutcome(errorEnvelope('EDA_WINDOW_NOT_FOUND', { status: 409 })), CP_CAPABILITY_STATUS.AVAILABLE);
  assert.equal(classifyCapabilityOutcome(errorEnvelope('RUNTIME_CONFLICT', { status: 409 })), CP_CAPABILITY_STATUS.AVAILABLE);
  assert.equal(classifyCapabilityOutcome(errorEnvelope('BRIDGE_NOT_FOUND', { status: 503 })), CP_CAPABILITY_STATUS.AVAILABLE);
  assert.equal(classifyCapabilityOutcome(errorEnvelope('AGENT_ROUTE_FORBIDDEN', { status: 403 })), CP_CAPABILITY_STATUS.AVAILABLE);
  for (const code of ['RUNTIME_UNREACHABLE', 'RUNTIME_NETWORK_ERROR', 'RUNTIME_TIMEOUT', 'CALL_CANCELLED', 'AGENT_TOKEN_MISSING', 'AGENT_TOKEN_INVALID']) {
    assert.equal(classifyCapabilityOutcome(errorEnvelope(code, { status: 0 })), CP_CAPABILITY_STATUS.UNKNOWN, code);
  }
});

test('probeCapabilities：全部能力存在 → complete:true，且只发 GET', async () => {
  const client = healthClient('0.2.0', allCapabilitiesRoutes());
  const probe = await probeCapabilities({ client });
  assert.equal(probe.complete, true);
  assert.deepEqual(probe.missing, []);
  assert.deepEqual(probe.unknown, []);
  assert.deepEqual(probe.checked, CP_CAPABILITIES.map((item) => item.id));
  assert.equal(probe.cached, false);
  assert.match(probe.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(client.calls.length, CP_CAPABILITIES.length);
  assert.ok(client.calls.every((call) => call.method === 'GET'), '能力探测绝不允许写请求');
});

test('probeCapabilities：缺 project-state → missing 明确到 id/path/code；409 EDA 未连视为路由存在', async () => {
  const routes = allCapabilitiesRoutes();
  delete routes['/api/project-state'];
  routes['/api/eda/workspaces/current'] = () => errorEnvelope('EDA_WINDOW_NOT_FOUND', { status: 409, message: '没有已连接的嘉立创EDA窗口' });
  const client = healthClient('0.2.0', routes);
  const probe = await probeCapabilities({ client });
  assert.equal(probe.complete, false);
  assert.deepEqual(probe.missing.map((item) => item.id), ['project-state']);
  assert.equal(probe.missing[0].path, '/api/project-state');
  assert.equal(probe.missing[0].code, 'ROUTE_NOT_FOUND');
  assert.ok(probe.missing[0].label.length > 0);
  assert.deepEqual(probe.unknown, [], 'EDA 409 是业务错误，不能算缺失/unknown');
  assert.equal(probe.checked.length, CP_CAPABILITIES.length);
});

test('probeCapabilities：网络错误/token 不可用 → unknown（不谎称缺失）', async () => {
  const routes = allCapabilitiesRoutes();
  routes['/api/evidence/index'] = () => {
    throw Object.assign(new Error('socket hang up'), { code: 'RUNTIME_NETWORK_ERROR' });
  };
  routes['/api/agent/status'] = () => errorEnvelope('AGENT_TOKEN_MISSING', { status: 0 });
  const client = healthClient('0.2.0', routes);
  const probe = await probeCapabilities({ client });
  assert.equal(probe.complete, false);
  assert.deepEqual(probe.missing, []);
  assert.deepEqual(probe.unknown.map((item) => item.id).sort(), ['agent-api', 'evidence-index']);
  const evidenceUnknown = probe.unknown.find((item) => item.id === 'evidence-index');
  assert.equal(evidenceUnknown.code, 'RUNTIME_NETWORK_ERROR');
});

test('probeCapabilities：缓存 TTL 生效；force 与 clearCompatCache 可重探', async () => {
  let now = 2_000_000;
  const clock = () => now;
  const client = healthClient('0.2.0', allCapabilitiesRoutes());
  const first = await probeCapabilities({ client, clock });
  assert.equal(first.cached, false);
  assert.equal(client.calls.length, CP_CAPABILITIES.length);

  const second = await probeCapabilities({ client, clock });
  assert.equal(second.cached, true);
  assert.equal(client.calls.length, CP_CAPABILITIES.length, 'TTL 内不再发请求');
  assert.equal(second.complete, true);

  now += 30_000;
  const third = await probeCapabilities({ client, clock });
  assert.equal(third.cached, false);
  assert.equal(client.calls.length, CP_CAPABILITIES.length * 2, 'TTL 过期后重新探测');

  await probeCapabilities({ client, clock, force: true });
  assert.equal(client.calls.length, CP_CAPABILITIES.length * 3);
  clearCompatCache(client);
  await probeCapabilities({ client, clock });
  assert.equal(client.calls.length, CP_CAPABILITIES.length * 4);
});

test('probeCapabilities：可按需只探测部分能力；已 abort 的 signal 不误报', async () => {
  const client = healthClient('0.2.0', allCapabilitiesRoutes());
  const subset = await probeCapabilities({ client, capabilities: [CP_CAPABILITIES[0]] });
  assert.deepEqual(subset.checked, ['agent-api']);
  assert.equal(subset.complete, true);

  const controller = new AbortController();
  controller.abort();
  const other = healthClient('0.2.0', allCapabilitiesRoutes());
  const aborted = await probeCapabilities({ client: other, signal: controller.signal });
  assert.deepEqual(aborted.checked, []);
  assert.equal(aborted.complete, false);
  assert.equal(other.calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* nextActions / 汇总                                                  */
/* ------------------------------------------------------------------ */

test('compatNextActions：非空、中文可操作，缺能力时点名具体能力', () => {
  const plain = compatNextActions();
  assert.ok(plain.length >= 3);
  assert.ok(plain.every((item) => typeof item === 'string' && item.length > 10));
  const joined = plain.join('\n');
  assert.match(joined, /CircuitPilot Runtime/);
  assert.match(joined, /升级|切换/);
  assert.match(joined, /回退/);
  assert.match(joined, /插件/);

  const withMissing = compatNextActions({ missing: [{ id: 'agent-api' }, 'project-state'] });
  assert.ok(withMissing.length > plain.length);
  assert.match(withMissing[0], /agent-api/);
  assert.match(withMissing[0], /project-state/);
});

test('summarizeCompat：稳定字段（runtimeVersion/supported/supportedRange/verified/capabilities/plugin）', async () => {
  const probe = await probeCapabilities({ client: healthClient('0.2.0', allCapabilitiesRoutes()) });
  const success = await ensureRuntimeCompatible({ client: healthClient('0.2.0') });
  const summary = summarizeCompat({ ...success, capabilities: probe });
  assert.deepEqual(Object.keys(summary).sort(), ['capabilities', 'plugin', 'runtimeVersion', 'supported', 'supportedRange', 'verified', 'warning']);
  assert.equal(summary.runtimeVersion, '0.2.0');
  assert.equal(summary.supported, true);
  assert.equal(summary.supportedRange, CP_SUPPORTED_RUNTIME_RANGE);
  assert.deepEqual(summary.verified, [...CP_VERIFIED_RUNTIME_VERSIONS]);
  assert.deepEqual(summary.capabilities, { missing: [], unknown: [], complete: true });
  assert.equal(summary.plugin.name, CP_PLUGIN_METADATA.name);
  assert.equal(summary.warning, null);

  const failure = await ensureRuntimeCompatible({ client: healthClient('0.8.15') });
  const failureSummary = summarizeCompat(failure);
  assert.equal(failureSummary.runtimeVersion, '0.8.15');
  assert.equal(failureSummary.supported, false);
  assert.equal(failureSummary.supportedRange, CP_SUPPORTED_RUNTIME_RANGE);
  assert.deepEqual(failureSummary.verified, [...CP_VERIFIED_RUNTIME_VERSIONS]);
  assert.deepEqual(failureSummary.capabilities, { missing: [], unknown: [], complete: null });
  assert.equal(failureSummary.plugin.version, CP_PLUGIN_METADATA.version);

  const withMissing = summarizeCompat({}, { capabilities: { missing: [{ id: 'issue-state' }, 'write-gate'], complete: false } });
  assert.deepEqual(withMissing.capabilities, { missing: ['issue-state', 'write-gate'], unknown: [], complete: false });
});

test('summarizePluginHost：host 缺失时优雅降级；有 host 时输出稳定宿主结构', () => {
  const absent = summarizePluginHost(undefined);
  assert.equal(absent.version, CP_PLUGIN_METADATA.version);
  assert.equal(absent.host.dshVersion, null);
  assert.equal(absent.host.supported, null);
  assert.equal(absent.host.supportedRange, DSH_SUPPORTED_RANGE);
  assert.deepEqual(absent.host.verified, [...DSH_VERIFIED_VERSIONS]);
  assert.equal(absent.host.registration, null);
  assert.deepEqual(Object.keys(absent).sort(), ['host', 'version']);
  assert.deepEqual(Object.keys(absent.host).sort(), ['dshVersion', 'registration', 'supported', 'supportedRange', 'verified']);

  const withHost = summarizePluginHost({
    version: '0.2.1-rc.5',
    source: 'runtime.json',
    registration: 'mcp',
    compatible: true,
  });
  assert.equal(withHost.host.dshVersion, '0.2.1-rc.5');
  assert.equal(withHost.host.supported, true);
  assert.equal(withHost.host.registration, 'mcp');

  const withCompat = summarizePluginHost({ compat: { supported: false, range: '>=9.0.0 <10.0.0', verified: ['9.1.0'] } });
  assert.equal(withCompat.host.supported, false);
  assert.equal(withCompat.host.supportedRange, '>=9.0.0 <10.0.0');
  assert.deepEqual(withCompat.host.verified, ['9.1.0']);
});

/* ------------------------------------------------------------------ */
/* 真实 HTTP（本地 fake Runtime）端到端                                */
/* ------------------------------------------------------------------ */

test('真实 HTTP：fake Runtime 0.2.0 上版本门禁通过、能力探测完整；缺路由/409/越界按规则分类', async () => {
  const runtime = await startFakeRuntime({ handler: createDefaultRouter().handler });
  const client = new RuntimeClient({ baseUrl: runtime.url, token: TEST_TOKEN, timeoutMs: 2000 });
  try {
    const gate = await ensureRuntimeCompatible({ client });
    assert.equal(gate.ok, true);
    assert.equal(gate.version, '0.2.0');
    assert.equal(gate.versionCompat.supported, true);

    const probe = await probeCapabilities({ client });
    assert.equal(probe.complete, true, '默认 fixture 应具备全部 6 项能力');
    assert.deepEqual(probe.missing, []);
    // fake fixture 的 agent 路由与其它路由一样必须带 agent token。
    const agentCall = runtime.calls.find((call) => call.path === '/api/agent/status');
    assert.ok(agentCall, '应探测 GET /api/agent/status');
    assert.equal(agentCall.headers['x-circuitpilot-agent-token'], TEST_TOKEN);
  } finally {
    await runtime.close();
  }

  // 缺路由 + EDA 409：只读探测必须区分“缺失”和“业务错误”。
  const partialRouter = createDefaultRouter({
    missingRoutes: ['GET /api/project-state'],
    routeOverrides: {
      'GET /api/eda/workspaces/current': [409, { ok: false, error: { code: 'EDA_WINDOW_NOT_FOUND', message: '没有已连接的嘉立创EDA窗口' } }],
    },
  });
  const partialRuntime = await startFakeRuntime({ handler: partialRouter.handler });
  const partialClient = new RuntimeClient({ baseUrl: partialRuntime.url, token: TEST_TOKEN, timeoutMs: 2000 });
  try {
    const probe = await probeCapabilities({ client: partialClient });
    assert.deepEqual(probe.missing.map((item) => item.id), ['project-state']);
    assert.deepEqual(probe.unknown, []);
    assert.equal(probe.complete, false);
  } finally {
    await partialRuntime.close();
  }

  // 旧构建 0.8.15：门禁硬失败，不再打后续路由。
  const oldRouter = createDefaultRouter({ healthVersion: '0.8.15', missingRoutes: ['/api/project-state', '/api/issue-state'] });
  const oldRuntime = await startFakeRuntime({ handler: oldRouter.handler });
  const oldClient = new RuntimeClient({ baseUrl: oldRuntime.url, token: TEST_TOKEN, timeoutMs: 2000 });
  try {
    const gate = await ensureRuntimeCompatible({ client: oldClient });
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'RUNTIME_VERSION_UNSUPPORTED');
    assert.equal(gate.data.runtimeVersion, '0.8.15');
    assert.deepEqual(oldRuntime.calls.map((call) => call.path), ['/api/health'], '版本门禁失败后不应继续请求其它路由');
  } finally {
    await oldRuntime.close();
  }
});

test('真实 HTTP：token 错误时能力探测归为 unknown（不会因 401 谎称能力缺失）', async () => {
  const runtime = await startFakeRuntime({ handler: createDefaultRouter().handler });
  const client = new RuntimeClient({ baseUrl: runtime.url, token: 'wrong-token-0123456789abcdef', timeoutMs: 2000 });
  try {
    const probe = await probeCapabilities({ client });
    assert.equal(probe.complete, false);
    assert.deepEqual(probe.missing, [], '401 不能算能力缺失');
    assert.equal(probe.unknown.length, CP_CAPABILITIES.length);
    assert.ok(probe.unknown.every((item) => ['AGENT_TOKEN_INVALID', 'RUNTIME_TOKEN_INVALID'].includes(item.code)));
  } finally {
    await runtime.close();
  }
});
