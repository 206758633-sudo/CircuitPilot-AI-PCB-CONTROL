/**
 * 进程内单元测试：MCP 协议分发 + 配置解析。
 *
 * 这里注入 fake RuntimeClient（只实现 request），不启动 HTTP/子进程，
 * 用于精确断言 JSON-RPC 语义、工具投影、取消语义与配置校验。
 * 真实 stdio 子进程 + fake HTTP Runtime 的集成测试见 stdio-session.test.mjs。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  MCP_DEFAULT_PROTOCOL_VERSION,
  MCP_ERROR_CODES,
  MCP_INSTRUCTIONS,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_MODERN_PROBE_METHOD,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  McpConfigError,
  buildMcpToolList,
  createMcpServer,
  parseMcpConfig,
  redactConfig,
  resolveMcpConfig,
  resolveProtocolVersion,
  toCallToolResult,
} from '../mcp-server.mjs';
import { TOOL_NAMES } from '../../plugin/dsh-circuitpilot/lib/tools.mjs';

/* ------------------------------------------------------------------ */
/* 测试工具                                                            */
/* ------------------------------------------------------------------ */

const RUNTIME_URL = 'http://127.0.0.1:4178';

function okEnvelope(data = {}) {
  return { ok: true, status: 200, data, truncated: false };
}

function errorEnvelope(code = 'RUNTIME_UNREACHABLE', message = 'fake runtime down') {
  return { ok: false, status: 0, code, message, nextActions: ['启动 CircuitPilot Runtime 后重试'] };
}

function createFakeClient(handler = () => okEnvelope({})) {
  const calls = [];
  return {
    calls,
    async request(method, requestPath, options = {}) {
      calls.push({ method, path: requestPath, options });
      return handler(method, requestPath, options);
    },
  };
}

function makeServer({ client = createFakeClient(), config = {} } = {}) {
  const lines = [];
  const logs = [];
  const server = createMcpServer({
    config: { runtimeUrl: RUNTIME_URL, ...config },
    client,
    write: (line) => lines.push(line),
    log: (message) => logs.push(message),
  });
  return {
    server,
    lines,
    logs,
    /** 解析已写出的全部 JSON-RPC 响应。 */
    messages: () => lines.map((line) => JSON.parse(line)),
  };
}

function requestMessage(id, method, params) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

async function initialize(server, protocolVersion = '2025-11-25') {
  return server.handleMessage(requestMessage(1, 'initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'unit-test-client', version: '0.0.1' },
  }));
}

/* ------------------------------------------------------------------ */
/* 协议常量 / 投影                                                     */
/* ------------------------------------------------------------------ */

test('协议元数据：legacy 版本降序、默认 2025-11-25、探测方法 server/discover', () => {
  assert.deepEqual([...MCP_LEGACY_PROTOCOL_VERSIONS], [
    '2025-11-25',
    '2025-06-18',
    '2025-03-26',
    '2024-11-05',
    '2024-10-07',
  ]);
  assert.equal(MCP_DEFAULT_PROTOCOL_VERSION, '2025-11-25');
  assert.equal(MCP_MODERN_PROBE_METHOD, 'server/discover');
  assert.equal(resolveProtocolVersion('2025-11-25'), '2025-11-25');
  assert.equal(resolveProtocolVersion('2025-06-18'), '2025-06-18');
  assert.equal(resolveProtocolVersion('2024-10-07'), '2024-10-07');
  // 现代/未知版本一律回落到默认 legacy 版本，绝不假装支持 2026-07-28。
  assert.equal(resolveProtocolVersion('2026-07-28'), '2025-11-25');
  assert.equal(resolveProtocolVersion('1999-01-01'), '2025-11-25');
  assert.equal(resolveProtocolVersion(undefined), '2025-11-25');
});

test('instructions 精简且不超过 DSH maxInstructionBytes 默认上限 32768 字节', () => {
  assert.ok(MCP_INSTRUCTIONS.length > 200);
  assert.ok(Buffer.byteLength(MCP_INSTRUCTIONS, 'utf8') <= 32_768);
  assert.match(MCP_INSTRUCTIONS, /cp_status/);
  assert.match(MCP_INSTRUCTIONS, /cp_approve/);
  assert.match(MCP_INSTRUCTIONS, /cp_execute/);
});

test('toCallToolResult 保留 envelope，非对象结果也包装成合法 structuredContent', () => {
  const value = { ok: true, summary: 's', data: {}, evidence: [], nextActions: [], truncated: false };
  const result = toCallToolResult(value);
  assert.deepEqual(result.structuredContent, value);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), value);
  assert.equal(result.isError, undefined);

  const wrapped = toCallToolResult('plain-text');
  assert.equal(wrapped.structuredContent.ok, true);
  assert.equal(wrapped.structuredContent.data, 'plain-text');
});

test('buildMcpToolList 恰好投影 12 个工具且去掉内部字段', () => {
  const tools = TOOL_NAMES.map((name) => ({
    name,
    description: `desc ${name}`,
    type: name.startsWith('cp_') ? 'read' : 'execute',
    inputSchema: { type: 'object', properties: {}, required: [] },
    execute: () => {},
  }));
  const list = buildMcpToolList(tools);
  assert.equal(list.length, 12);
  assert.equal(list[0].execute, undefined);
  assert.equal(list[0].type, undefined);
  assert.deepEqual(list.map((item) => item.name), [...TOOL_NAMES]);
  for (const item of list) {
    assert.equal(item.inputSchema.type, 'object');
    assert.equal(item.annotations.openWorldHint, false);
  }
});

/* ------------------------------------------------------------------ */
/* initialize / 协商 / 生命周期                                        */
/* ------------------------------------------------------------------ */

test('initialize：回显 2025-11-25、声明 tools 能力、serverInfo 与 instructions', async () => {
  const { server } = makeServer();
  const response = await initialize(server);
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.error, undefined);
  const result = response.result;
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.equal(result.serverInfo.name, MCP_SERVER_NAME);
  assert.equal(result.serverInfo.version, MCP_SERVER_VERSION);
  assert.equal(typeof result.capabilities.tools, 'object');
  assert.equal(result.capabilities.tools.listChanged, false);
  assert.equal(result.instructions, MCP_INSTRUCTIONS);
  assert.equal(server.state.initialized, true);
  assert.equal(server.state.negotiatedProtocolVersion, '2025-11-25');
});

test('initialize：客户端 offer 旧版本时回显，offer 未来版本时回落到 2025-11-25', async () => {
  const legacy = makeServer();
  const legacyResponse = await initialize(legacy.server, '2025-06-18');
  assert.equal(legacyResponse.result.protocolVersion, '2025-06-18');

  const future = makeServer();
  const futureResponse = await initialize(future.server, '2026-07-28');
  assert.equal(futureResponse.result.protocolVersion, '2025-11-25');
  assert.equal(future.server.state.negotiatedProtocolVersion, '2025-11-25');
});

test('initialize：重复 initialize 返回 -32600；缺 protocolVersion 返回 -32602', async () => {
  const first = makeServer();
  await initialize(first.server);
  const again = await initialize(first.server);
  assert.equal(again.error.code, MCP_ERROR_CODES.INVALID_REQUEST);

  const missing = makeServer();
  const response = await missing.server.handleMessage(requestMessage(9, 'initialize', {}));
  assert.equal(response.error.code, MCP_ERROR_CODES.INVALID_PARAMS);

  const notObject = makeServer();
  const bad = await notObject.server.handleMessage(requestMessage(10, 'initialize', 'oops'));
  assert.equal(bad.error.code, MCP_ERROR_CODES.INVALID_PARAMS);
});

test('server/discover 返回 -32601：这是官方 SDK auto 协商的明确 legacy 信号', async () => {
  const { server } = makeServer();
  const response = await server.handleMessage(requestMessage('probe-1', MCP_MODERN_PROBE_METHOD, {
    _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'probe', version: '1' } },
  }));
  assert.equal(response.id, 'probe-1');
  assert.equal(response.result, undefined);
  assert.equal(response.error.code, MCP_ERROR_CODES.METHOD_NOT_FOUND);
  assert.match(response.error.message, /legacy/);
  // 探测失败不应污染初始化状态：随后仍可正常 initialize。
  const init = await initialize(server);
  assert.equal(init.result.protocolVersion, '2025-11-25');
});

test('未 initialize 前 tools/list 返回 -32600；ping 允许随时发送', async () => {
  const { server } = makeServer();
  const tools = await server.handleMessage(requestMessage(2, 'tools/list'));
  assert.equal(tools.error.code, MCP_ERROR_CODES.INVALID_REQUEST);
  const ping = await server.handleMessage(requestMessage(3, 'ping'));
  assert.deepEqual(ping.result, {});
});

test('未知方法返回 -32601，不影响后续请求', async () => {
  const { server } = makeServer();
  await initialize(server);
  const response = await server.handleMessage(requestMessage(5, 'resources/list'));
  assert.equal(response.error.code, MCP_ERROR_CODES.METHOD_NOT_FOUND);
  const ping = await server.handleMessage(requestMessage(6, 'ping'));
  assert.deepEqual(ping.result, {});
});

test('非法 JSON 行返回 -32700（id=null），空行被忽略', async () => {
  const { server, messages } = makeServer();
  await server.handleLine('{not json');
  await server.handleLine('   ');
  await server.handleLine(JSON.stringify(requestMessage(1, 'ping')));
  const parsed = messages();
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].error.code, MCP_ERROR_CODES.PARSE_ERROR);
  // 官方 MCP schema 的 error 响应不允许 id:null：无法确定 id 时省略 id 字段。
  assert.equal(Object.hasOwn(parsed[0], 'id'), false);
  assert.deepEqual(parsed[1].result, {});
});

test('JSON-RPC 基础校验：缺 jsonrpc、batch、非法 id 类型都返回 -32600', async () => {
  const { server } = makeServer();
  await initialize(server);

  const noJsonrpc = await server.handleMessage({ id: 7, method: 'ping' });
  assert.equal(noJsonrpc.error.code, MCP_ERROR_CODES.INVALID_REQUEST);

  const batch = await server.handleMessage([requestMessage(8, 'ping')]);
  assert.equal(batch.error.code, MCP_ERROR_CODES.INVALID_REQUEST);

  const badId = await server.handleMessage({ jsonrpc: '2.0', id: { nested: true }, method: 'ping' });
  assert.equal(badId.error.code, MCP_ERROR_CODES.INVALID_REQUEST);
  assert.equal(Object.hasOwn(badId, 'id'), false);

  const bareString = await server.handleMessage('oops');
  assert.equal(bareString.error.code, MCP_ERROR_CODES.INVALID_REQUEST);
});

test('notifications/initialized 与未知通知不产生响应', async () => {
  const { server, lines } = makeServer();
  // 走 handleLine 路径，确保写入行为只发生在请求响应上。
  await server.handleLine(JSON.stringify(requestMessage(1, 'initialize', { protocolVersion: '2025-11-25' })));
  assert.equal(lines.length, 1);
  const result = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(result, null);
  const unknown = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/progress', params: {} });
  assert.equal(unknown, null);
  assert.equal(lines.length, 1); // 通知不写响应
});

/* ------------------------------------------------------------------ */
/* tools/list                                                          */
/* ------------------------------------------------------------------ */

test('tools/list 返回恰好 12 个 CircuitPilot 工具，schema 都是 object 根', async () => {
  const { server } = makeServer();
  await initialize(server);
  const response = await server.handleMessage(requestMessage(2, 'tools/list'));
  const { tools } = response.result;
  assert.equal(tools.length, 12);
  assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES]);
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 10);
    assert.equal(tool.inputSchema.type, 'object');
    // MCP 客户端会原样把 schema 交给模型，必须是可安全 JSON 往返的纯数据。
    assert.deepEqual(JSON.parse(JSON.stringify(tool.inputSchema)), tool.inputSchema);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  }
});

/* ------------------------------------------------------------------ */
/* tools/call                                                          */
/* ------------------------------------------------------------------ */

test('tools/call cp_status：正常返回 content 文本 + structuredContent，不带 isError', async () => {
  const client = createFakeClient((method, requestPath) => {
    if (requestPath === '/api/health') {
      return okEnvelope({ version: '0.9.0-test', service: 'circuitpilot-runtime', host: '127.0.0.1' });
    }
    if (requestPath === '/api/project-state') {
      return okEnvelope({ state: { activeProjectId: 'p1', projects: [{ id: 'p1', name: 'Demo', stage: 'schematic' }] } });
    }
    if (requestPath === '/api/write-gate') return okEnvelope({ gate: { paused: false } });
    if (requestPath === '/api/eda/workspaces/current') return okEnvelope({ workspace: { windowId: 'win-1' } });
    if (requestPath === '/api/issue-state') return okEnvelope({ state: { issues: [] } });
    if (requestPath === '/api/evidence/index') return okEnvelope({ index: { summary: { entries: 0 } } });
    return errorEnvelope('ROUTE_NOT_FOUND', `unexpected ${requestPath}`);
  });
  const { server } = makeServer({ client });
  await initialize(server);

  const response = await server.handleMessage(requestMessage(3, 'tools/call', { name: 'cp_status', arguments: {} }));
  assert.equal(response.error, undefined);
  const result = response.result;
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.ok, true);
  assert.match(value.summary, /CircuitPilot Runtime/);
  assert.deepEqual(result.structuredContent, value);
  assert.equal(value.data.runtime.reachable, true);
  assert.ok(value.evidence.length >= 0);
  // Runtime 只应收到读路由 + agent token header。
  assert.ok(client.calls.length >= 5);
  for (const call of client.calls) {
    assert.equal(call.method, 'GET');
    assert.match(call.path, /^\/api\//);
  }
});

test('tools/call 领域错误保持 ok:false envelope（协议层成功，无 isError）', async () => {
  const client = createFakeClient(() => errorEnvelope('RUNTIME_UNREACHABLE', '无法连接 CircuitPilot Runtime'));
  const { server } = makeServer({ client });
  await initialize(server);
  const response = await server.handleMessage(requestMessage(4, 'tools/call', { name: 'cp_status', arguments: {} }));
  const result = response.result;
  assert.equal(result.isError, undefined);
  const value = result.structuredContent;
  assert.equal(value.ok, false);
  assert.equal(value.code, 'RUNTIME_UNREACHABLE');
  assert.ok(Array.isArray(value.nextActions) && value.nextActions.length > 0);
});

test('tools/call 参数校验失败：cp_approve 缺 confirm 返回 INVALID_ARGUMENTS 而不是协议错误', async () => {
  const { server } = makeServer();
  await initialize(server);
  const response = await server.handleMessage(requestMessage(5, 'tools/call', {
    name: 'cp_approve',
    arguments: { planHash: 'design-plan-hash-000001' },
  }));
  assert.equal(response.error, undefined);
  assert.equal(response.result.structuredContent.ok, false);
  assert.equal(response.result.structuredContent.code, 'INVALID_ARGUMENTS');
});

test('tools/call 未知工具返回 -32602；name/arguments 类型错误返回 -32602', async () => {
  const { server } = makeServer();
  await initialize(server);

  const unknown = await server.handleMessage(requestMessage(6, 'tools/call', { name: 'nope', arguments: {} }));
  assert.equal(unknown.error.code, MCP_ERROR_CODES.INVALID_PARAMS);

  const noName = await server.handleMessage(requestMessage(7, 'tools/call', { arguments: {} }));
  assert.equal(noName.error.code, MCP_ERROR_CODES.INVALID_PARAMS);

  const badArgs = await server.handleMessage(requestMessage(8, 'tools/call', { name: 'cp_status', arguments: 'oops' }));
  assert.equal(badArgs.error.code, MCP_ERROR_CODES.INVALID_PARAMS);
});

test('tools/call 参数缺省时按空对象处理（cp_status 无参数）', async () => {
  const client = createFakeClient((method, requestPath) => {
    if (requestPath === '/api/health') return okEnvelope({ version: '1' });
    if (requestPath === '/api/project-state') return okEnvelope({ state: { projects: [] } });
    if (requestPath === '/api/write-gate') return okEnvelope({ gate: {} });
    if (requestPath === '/api/eda/workspaces/current') return okEnvelope({ workspace: null });
    if (requestPath === '/api/issue-state') return okEnvelope({ state: { issues: [] } });
    if (requestPath === '/api/evidence/index') return okEnvelope({ index: { summary: { entries: 0 } } });
    return errorEnvelope('ROUTE_NOT_FOUND', requestPath);
  });
  const { server } = makeServer({ client });
  await initialize(server);
  const response = await server.handleMessage(requestMessage(9, 'tools/call', { name: 'cp_status' }));
  assert.equal(response.result.structuredContent.ok, true);
});

test('notifications/cancelled 中止执行中的工具，且不发送被取消请求的响应', async () => {
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const client = {
    async request(method, requestPath, options = {}) {
      started();
      return new Promise((resolve) => {
        if (options.signal?.aborted) {
          resolve({ ok: false, status: 0, code: 'CALL_CANCELLED', message: '调用已被取消', nextActions: [] });
          return;
        }
        options.signal?.addEventListener('abort', () => {
          resolve({ ok: false, status: 0, code: 'CALL_CANCELLED', message: '调用已被取消', nextActions: [] });
        }, { once: true });
      });
    },
  };
  const { server, lines } = makeServer({ client });
  await initialize(server);
  const before = lines.length;

  const callPromise = server.handleMessage(requestMessage(42, 'tools/call', { name: 'cp_status', arguments: {} }));
  await startedPromise;
  const notification = await server.handleMessage({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 42, reason: 'user cancelled' },
  });
  assert.equal(notification, null);
  const response = await callPromise;
  assert.equal(response, null, '被取消的请求不应返回 JSON-RPC 响应');
  assert.equal(lines.length, before, 'stdout 不应新增任何行');
  assert.ok(server.stats().cancelled >= 1);

  // 取消后 server 仍可服务新请求。
  const ping = await server.handleMessage(requestMessage(43, 'ping'));
  assert.deepEqual(ping.result, {});
});

/* ------------------------------------------------------------------ */
/* 配置解析                                                            */
/* ------------------------------------------------------------------ */

test('配置：env 提供默认值，flag 覆盖 env', () => {
  const env = {
    CIRCUITPILOT_RUNTIME_URL: 'http://127.0.0.1:9999',
    CIRCUITPILOT_AGENT_TOKEN_FILE: '/tmp/agent-token.json',
    CIRCUITPILOT_APPROVAL_MODE: 'off',
    CIRCUITPILOT_MAX_RESULT_BYTES: '2048',
  };
  const resolved = resolveMcpConfig({ argv: [], env });
  assert.equal(resolved.config.runtimeUrl, 'http://127.0.0.1:9999');
  assert.equal(resolved.config.tokenFile, path.resolve('/tmp/agent-token.json'));
  assert.equal(resolved.config.approvalMode, 'off');
  assert.equal(resolved.config.maxResultBytes, 2048);
  assert.equal(resolved.config.requestTimeoutMs, 30_000);
  assert.equal(resolved.help, false);

  const overridden = resolveMcpConfig({
    argv: [
      '--runtime-url', 'http://localhost:4000/',
      '--approval-mode=chat',
      '--max-result-bytes', '4096',
      '--request-timeout-ms', '5000',
    ],
    env,
  });
  assert.equal(overridden.config.runtimeUrl, 'http://localhost:4000');
  assert.equal(overridden.config.approvalMode, 'chat');
  assert.equal(overridden.config.maxResultBytes, 4096);
  assert.equal(overridden.config.requestTimeoutMs, 5000);
});

test('配置：--help/--version/--print-config 只作为模式返回，不进入 stdio 循环', () => {
  assert.equal(resolveMcpConfig({ argv: ['--help'], env: {} }).help, true);
  assert.equal(resolveMcpConfig({ argv: ['--version'], env: {} }).version, true);
  assert.equal(resolveMcpConfig({ argv: ['--print-config'], env: {} }).printConfig, true);

  const printed = redactConfig(resolveMcpConfig({
    argv: ['--token', 'cpa_secret_token_123456'],
    env: {},
  }).config);
  assert.equal(printed.tokenSource, 'explicit-token');
  assert.equal(Object.hasOwn(printed, 'token'), false);
  assert.equal(JSON.stringify(printed).includes('cpa_secret_token_123456'), false);
});

test('配置：非法输入抛 McpConfigError（approvalMode/url/数字/未知 flag/token 冲突）', () => {
  assert.throws(() => parseMcpConfig({ argv: ['--approval-mode', 'auto'], env: {} }), McpConfigError);
  assert.throws(() => parseMcpConfig({ argv: ['--runtime-url', 'ftp://x/y'], env: {} }), McpConfigError);
  assert.throws(() => parseMcpConfig({ argv: ['--runtime-url', 'not-a-url'], env: {} }), McpConfigError);
  assert.throws(() => parseMcpConfig({ argv: ['--request-timeout-ms', '0'], env: {} }), McpConfigError);
  assert.throws(() => parseMcpConfig({ argv: ['--request-timeout-ms', 'abc'], env: {} }), McpConfigError);
  assert.throws(() => parseMcpConfig({ argv: ['--max-result-bytes', '999'], env: {} }), McpConfigError);
  assert.throws(() => parseMcpConfig({ argv: ['--unknown'], env: {} }), McpConfigError);
  assert.throws(() => parseMcpConfig({ argv: ['--token', 'cpa_token_123456', '--token-file', '/tmp/x'], env: {} }), McpConfigError);
  assert.throws(() => parseMcpConfig({ argv: ['--token', 'has space token'], env: {} }), McpConfigError);
  assert.throws(() => parseMcpConfig({ argv: ['--token'], env: {} }), McpConfigError);
});

test('配置：显式 token 与 tokenFile 二选一，Runtime URL 去掉尾部斜杠', () => {
  const withToken = parseMcpConfig({ argv: ['--token', 'cpa_token_abcdef12', '--runtime-url', 'http://127.0.0.1:5555///'], env: {} });
  assert.equal(withToken.token, 'cpa_token_abcdef12');
  assert.equal(withToken.tokenFile, '');
  assert.equal(withToken.runtimeUrl, 'http://127.0.0.1:5555');

  const withFile = parseMcpConfig({ argv: ['--token-file', './relative/agent-token.json'], env: {} });
  assert.equal(withFile.token, '');
  assert.equal(path.isAbsolute(withFile.tokenFile), true);
});

test('createMcpServer 拒绝超长 instructions（DSH maxInstructionBytes 限制）', () => {
  assert.throws(() => createMcpServer({ instructions: 'x'.repeat(32_769) }), McpConfigError);
});
