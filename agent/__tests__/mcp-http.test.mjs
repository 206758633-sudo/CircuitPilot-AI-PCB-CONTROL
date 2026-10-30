/**
 * task-35：MCP Streamable HTTP 传输测试。
 *
 * 不启动真实 Runtime / 不连网络：注入 fake RuntimeClient + JobManager，只验证
 * HTTP 传输层语义（initialize / session header / 通知 202 / 畸形 JSON / 405/404/health /
 * 工具调用 / 关闭释放端口），与 stdio 测试共用同一套 createMcpServer 语义。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MCP_HTTP_AUTH_ERROR,
  MCP_HTTP_BODY_LIMIT_BYTES,
  MCP_HTTP_DEFAULT_HOST,
  MCP_HTTP_DEFAULT_PORT,
  MCP_HTTP_SESSION_HEADER,
  MCP_HTTP_TOKEN_HEADER,
  MCP_PROTOCOL_SUPPORT,
  MCP_SERVER_NAME,
  MCP_USAGE,
  MCP_HTTP_TOKEN_FILE_MODE,
  McpConfigError,
  redactConfig,
  resolveMcpConfig,
  runHttpServer,
} from '../mcp-server.mjs';
import { JobManager } from '../../plugin/dsh-circuitpilot/lib/jobs.mjs';

const RUNTIME_URL = 'http://127.0.0.1:4178';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createFakeClient(handler = () => ({ ok: true, status: 200, data: {}, truncated: false })) {
  const calls = [];
  return {
    calls,
    async request(method, requestPath, options = {}) {
      calls.push({ method, path: requestPath, options });
      return handler(method, requestPath, options);
    },
  };
}

function initializeMessage(id = 1, protocolVersion = '2025-11-25') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'http-test-client', version: '0.0.1' } },
  };
}

async function startServer(context, overrides = {}) {
  const logs = [];
  const instance = await runHttpServer({
    port: 0,
    host: '127.0.0.1',
    config: { runtimeUrl: RUNTIME_URL, approvalMode: 'chat' },
    client: createFakeClient(),
    jobs: new JobManager({ defaultTimeoutMs: 5_000 }),
    log: (message) => logs.push(message),
    ...overrides,
  });
  context.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.port}`;

  const request = async (pathname, { method = 'GET', headers = {}, body } = {}) => {
    const response = await fetch(`${base}${pathname}`, { method, headers, body });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    return { response, status: response.status, headers: response.headers, text, json };
  };
  const postRaw = (body, headers = {}) => request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  const rpc = (payload, headers = {}) => postRaw(JSON.stringify(payload), headers);

  return { instance, base, logs, request, postRaw, rpc };
}

test('Streamable HTTP：initialize 200 + application/json + Mcp-Session-Id(UUID)，后续 tools/list=12、ping', async (context) => {
  const { rpc, instance } = await startServer(context);

  const init = await rpc(initializeMessage());
  assert.equal(init.status, 200);
  assert.match(init.headers.get('content-type') || '', /application\/json/);
  const sessionId = init.headers.get(MCP_HTTP_SESSION_HEADER);
  assert.match(sessionId, UUID_PATTERN, 'initialize 响应必须带 UUID 形式的 Mcp-Session-Id');
  assert.equal(init.json.result.protocolVersion, '2025-11-25');
  assert.equal(init.json.result.serverInfo.name, MCP_SERVER_NAME);
  assert.equal(init.json.result.serverInfo.version, '0.1.0');
  assert.equal(typeof instance.port, 'number');
  assert.ok(instance.server && typeof instance.close === 'function');

  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { [MCP_HTTP_SESSION_HEADER]: sessionId });
  assert.equal(tools.status, 200);
  assert.equal(tools.json.result.tools.length, 12);

  // session header 仅作会话标识、不作认证：不带、带错误值都必须接受。
  const toolsNoSession = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(toolsNoSession.status, 200);
  assert.equal(toolsNoSession.json.result.tools.length, 12);
  const toolsWrongSession = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { [MCP_HTTP_SESSION_HEADER]: 'not-a-real-session' });
  assert.equal(toolsWrongSession.status, 200);
  assert.equal(toolsWrongSession.json.result.tools.length, 12);

  const ping = await rpc({ jsonrpc: '2.0', id: 5, method: 'ping' });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json.result, {});
});

test('Streamable HTTP：通知（initialized / 未知通知）→ 202 空 body', async (context) => {
  const { rpc } = await startServer(context);
  await rpc(initializeMessage());

  const initialized = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(initialized.status, 202);
  assert.equal(initialized.text, '');

  const unknown = await rpc({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } });
  assert.equal(unknown.status, 202);
  assert.equal(unknown.text, '');
});

test('Streamable HTTP：畸形 JSON → 400 + JSON-RPC -32700，之后 server 仍可用', async (context) => {
  const { postRaw, rpc } = await startServer(context);

  const bad = await postRaw('{not-json');
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type') || '', /application\/json/);
  assert.equal(bad.json.error.code, -32700);
  assert.equal(Object.hasOwn(bad.json, 'id'), false, '无法确定 id 时省略 id 字段');
  assert.equal(bad.text.includes('not-json'), false, '错误响应不得回显原始 body');

  const ping = await rpc({ jsonrpc: '2.0', id: 9, method: 'ping' });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json.result, {});
});

test('Streamable HTTP：GET /mcp 405、DELETE 204（会话重置）、GET /health、未知路径 404', async (context) => {
  const { request, rpc } = await startServer(context);

  const getMcp = await request('/mcp');
  assert.equal(getMcp.status, 405);
  assert.equal(getMcp.json.ok, false);
  assert.equal(getMcp.headers.get('allow'), 'POST, DELETE');

  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, service: 'circuitpilot-mcp', transport: 'streamable-http' });

  const missing = await request('/not-found');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.error.code, 'MCP_HTTP_NOT_FOUND');

  const first = await rpc(initializeMessage(1));
  assert.equal(first.status, 200);
  const deleted = await request('/mcp', { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal(deleted.text, '');
  // DELETE 结束会话后，新 initialize 能重新开始（单客户端场景）。
  const second = await rpc(initializeMessage(2));
  assert.equal(second.status, 200);
  assert.equal(second.json.result.protocolVersion, '2025-11-25');
});

test('Streamable HTTP：tools/call cp_status（fake client）返回 CallToolResult，响应无 token', async (context) => {
  const calls = [];
  const client = {
    async request(method, requestPath, options = {}) {
      calls.push({ method, path: requestPath, options });
      return { ok: true, status: 200, data: {}, truncated: false };
    },
  };
  const { rpc } = await startServer(context, { client });
  await rpc(initializeMessage());

  const call = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cp_status', arguments: {} } });
  assert.equal(call.status, 200);
  const result = call.json.result;
  assert.equal(Array.isArray(result.content), true);
  assert.equal(result.content[0].type, 'text');
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, true);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(call.text.includes('cpa_'), false, 'HTTP 响应不得出现 cpa_ token 样式');
  assert.equal(call.text.toLowerCase().includes('authorization'), false);
  assert.ok(calls.length >= 1, 'cp_status 必须真实调用 Runtime client');
});

test('Streamable HTTP：body 超过 8MB → 413（不崩，之后仍可用）', async (context) => {
  const { postRaw, rpc } = await startServer(context);
  assert.equal(MCP_HTTP_BODY_LIMIT_BYTES, 8 * 1024 * 1024);
  const tooBig = await postRaw('x'.repeat(MCP_HTTP_BODY_LIMIT_BYTES + 16));
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.json.error.code, -32600);

  const ping = await rpc({ jsonrpc: '2.0', id: 10, method: 'ping' });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json.result, {});
});

test('协议元数据：transports 含 stdio + streamable-http，协议仍是 legacy 2025-era', () => {
  assert.deepEqual([...MCP_PROTOCOL_SUPPORT.transports], ['stdio', 'streamable-http']);
  assert.equal(MCP_PROTOCOL_SUPPORT.era, 'legacy');
  assert.equal(MCP_PROTOCOL_SUPPORT.defaultProtocolVersion, '2025-11-25');
  assert.equal(MCP_PROTOCOL_SUPPORT.modernProbeMethod, 'server/discover');
});

test('CLI 配置：--http/--http-port/--http-host 与 env 覆盖，非法值抛 McpConfigError', () => {
  assert.equal(MCP_HTTP_DEFAULT_PORT, 4180);
  assert.equal(MCP_HTTP_DEFAULT_HOST, '127.0.0.1');

  const defaults = resolveMcpConfig({ argv: ['--http'], env: {} });
  assert.equal(defaults.http, true);
  assert.equal(defaults.config.transport, 'streamable-http');
  assert.equal(defaults.config.httpPort, 4180);
  assert.equal(defaults.config.httpHost, '127.0.0.1');

  const custom = resolveMcpConfig({
    argv: ['--http', '--http-port', '5555', '--http-host', '0.0.0.0'],
    env: { CIRCUITPILOT_MCP_HTTP_PORT: '6000', CIRCUITPILOT_MCP_HTTP_HOST: '127.0.0.2' },
  });
  assert.equal(custom.config.httpPort, 5555, 'flag 优先于 env');
  assert.equal(custom.config.httpHost, '0.0.0.0');

  const envOnly = resolveMcpConfig({
    argv: [],
    env: { CIRCUITPILOT_MCP_HTTP_PORT: '6000', CIRCUITPILOT_MCP_HTTP_HOST: '127.0.0.2' },
  });
  assert.equal(envOnly.http, false, '没有 --http 时默认仍是 stdio');
  assert.equal(envOnly.config.transport, 'stdio');
  assert.equal(envOnly.config.httpPort, 6000);
  assert.equal(envOnly.config.httpHost, '127.0.0.2');

  assert.throws(() => resolveMcpConfig({ argv: ['--http', '--http-port', '0'], env: {} }), McpConfigError);
  assert.throws(() => resolveMcpConfig({ argv: ['--http', '--http-port', '70000'], env: {} }), McpConfigError);
  assert.throws(() => resolveMcpConfig({ argv: ['--http', '--http-host', 'http://x'], env: {} }), McpConfigError);
  assert.throws(() => resolveMcpConfig({ argv: ['--http', '--http-host', 'has space'], env: {} }), McpConfigError);
});

test('close() 释放端口且幂等（同一端口可立即重新监听）', async () => {
  const makeInstance = (port) => runHttpServer({
    port,
    host: '127.0.0.1',
    config: { runtimeUrl: RUNTIME_URL },
    client: createFakeClient(),
    jobs: new JobManager({ defaultTimeoutMs: 5_000 }),
    log: () => {},
  });

  const first = await makeInstance(0);
  const { port } = first;
  assert.ok(port > 0);
  await first.close();
  await first.close(); // 幂等

  const second = await makeInstance(port);
  assert.equal(second.port, port, '关闭后端口必须释放');
  await second.close();
});


const AUTH_TOKEN = 'mcp-http-auth-token-0123456789abcdef';

test('HTTP 认证：无/错 token → 401 且不执行 JSON-RPC；Bearer 与 x header 正确可 initialize/tools/list', async (context) => {
  const { rpc, request, logs } = await startServer(context, { authToken: AUTH_TOKEN });

  // 无 header：401 固定 JSON（无工具细节、无 token），且不得执行 initialize。
  const missing = await rpc(initializeMessage());
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.json, { ok: false, error: MCP_HTTP_AUTH_ERROR });
  assert.equal(missing.text.includes(AUTH_TOKEN), false);
  assert.equal(/tools|initialize|protocolVersion/i.test(missing.text), false, '401 不得泄漏工具/协议细节');

  const wrongBearer = await rpc(initializeMessage(2), { authorization: 'Bearer wrong-token-value' });
  assert.equal(wrongBearer.status, 401);
  const wrongHeader = await rpc(initializeMessage(3), { [MCP_HTTP_TOKEN_HEADER]: 'wrong-token-value' });
  assert.equal(wrongHeader.status, 401);
  const basicAuth = await rpc(initializeMessage(4), { authorization: 'Basic dXNlcjpwYXNz' });
  assert.equal(basicAuth.status, 401);

  // 认证失败不消耗/污染 JSON-RPC 状态：随后正确的 initialize 仍应正常返回。
  const bearerInit = await rpc(initializeMessage(5), { authorization: `Bearer ${AUTH_TOKEN}` });
  assert.equal(bearerInit.status, 200);
  assert.equal(bearerInit.json.result.serverInfo.name, MCP_SERVER_NAME);
  assert.match(bearerInit.headers.get(MCP_HTTP_SESSION_HEADER), UUID_PATTERN);

  const bearerTools = await rpc(
    { jsonrpc: '2.0', id: 6, method: 'tools/list' },
    { authorization: `Bearer ${AUTH_TOKEN}`, [MCP_HTTP_SESSION_HEADER]: bearerInit.headers.get(MCP_HTTP_SESSION_HEADER) },
  );
  assert.equal(bearerTools.status, 200);
  assert.equal(bearerTools.json.result.tools.length, 12);

  // x-circuitpilot-mcp-token 同样有效（大小写不敏感 Bearer scheme 也接受）。
  const headerTools = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { [MCP_HTTP_TOKEN_HEADER]: AUTH_TOKEN });
  assert.equal(headerTools.status, 200);
  assert.equal(headerTools.json.result.tools.length, 12);
  const lowercaseBearer = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, { authorization: `bearer ${AUTH_TOKEN}` });
  assert.equal(lowercaseBearer.status, 200);
  assert.equal(lowercaseBearer.json.result.tools.length, 12);

  // GET/DELETE /mcp 也要认证；认证后 GET=405、DELETE=204（支持范围与旧行为一致）。
  const getUnauth = await request('/mcp', { method: 'GET' });
  assert.equal(getUnauth.status, 401);
  const deleteUnauth = await request('/mcp', { method: 'DELETE' });
  assert.equal(deleteUnauth.status, 401);
  const getAuth = await request('/mcp', { method: 'GET', headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
  assert.equal(getAuth.status, 405);
  const deleteAuth = await request('/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
  assert.equal(deleteAuth.status, 204);

  // /health 公开且不含 token；未知路径无 token 也仍是 404（不暴露认证状态）。
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, service: 'circuitpilot-mcp', transport: 'streamable-http' });
  assert.equal(health.text.includes(AUTH_TOKEN), false);
  const unknown = await request('/api/does-not-exist');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'MCP_HTTP_NOT_FOUND');
  assert.equal(unknown.text.includes(AUTH_TOKEN), false);

  // 日志也不能包含 token（401 只记录“认证失败”）。
  assert.equal(JSON.stringify(logs).includes(AUTH_TOKEN), false);
});

test('HTTP 认证：无 authToken 时默认不认证（原行为，仅 loopback warning）', async (context) => {
  const { rpc, request, logs } = await startServer(context);
  const init = await rpc(initializeMessage());
  assert.equal(init.status, 200, '不配置 authToken 时保持旧行为');
  assert.equal(init.json.result.protocolVersion, '2025-11-25');
  assert.equal((await request('/health')).status, 200);
  assert.equal(logs.some((line) => /WARNING/.test(line) && /--http-token-file/.test(line)), true, '无认证时应 warning 建议 token');
  assert.equal(logs.some((line) => line.includes(AUTH_TOKEN)), false);
});

test('CLI 配置：--http-token-file 0600/非空/缺失/宽权限，--http-token 互斥，print-config 不带 token', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-mcp-http-auth-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const token = 'mcp-http-file-token-abcdef0123456789';
  assert.equal(MCP_HTTP_TOKEN_FILE_MODE, 0o600, 'token 文件必须是严格的 0600 语义');
  const tokenFile = join(root, 'http-token');
  writeFileSync(tokenFile, `${token}\n`);
  chmodSync(tokenFile, 0o600);

  // 文件 0600 + 非空：启用认证；config 内部带 token，但 redactConfig/print-config 不带。
  const resolved = resolveMcpConfig({ argv: ['--http', '--http-token-file', tokenFile], env: {} });
  assert.equal(resolved.http, true);
  assert.equal(resolved.config.httpAuth, true);
  assert.equal(resolved.config.httpTokenFile, tokenFile);
  assert.equal(resolved.config.httpToken, token);
  const redacted = redactConfig(resolved.config);
  assert.equal(redacted.httpAuth, true);
  assert.equal(redacted.httpTokenFile, tokenFile);
  assert.equal(JSON.stringify(redacted).includes(token), false, '--print-config 不得打印 token');
  assert.equal(Object.hasOwn(redacted, 'httpToken'), false);

  // env 变量等价于 flag（flag 优先）。
  const envOnly = resolveMcpConfig({ argv: ['--http'], env: { CIRCUITPILOT_MCP_HTTP_TOKEN_FILE: tokenFile } });
  assert.equal(envOnly.config.httpAuth, true);
  assert.equal(envOnly.config.httpTokenFile, tokenFile);

  // --http-token 仅测试用：可启用，但绝不会出现在脱敏配置里。
  const explicit = resolveMcpConfig({ argv: ['--http', '--http-token', token], env: {} });
  assert.equal(explicit.config.httpAuth, true);
  assert.equal(explicit.config.httpTokenFile, '');
  assert.equal(JSON.stringify(redactConfig(explicit.config)).includes(token), false);

  // 默认（不配置）：httpAuth=false，旧配置字段不变。
  const noAuth = resolveMcpConfig({ argv: ['--http'], env: {} });
  assert.equal(noAuth.config.httpAuth, false);
  assert.equal(noAuth.config.httpTokenFile, '');
  assert.equal(redactConfig(noAuth.config).httpAuth, false);
  assert.equal(redactConfig(noAuth.config).httpTokenFile, null);

  // 互斥。
  assert.throws(
    () => resolveMcpConfig({ argv: ['--http-token', token, '--http-token-file', tokenFile], env: {} }),
    McpConfigError,
  );

  // 缺失文件 → 配置错误（exit 2 路径）。
  assert.throws(
    () => resolveMcpConfig({ argv: ['--http-token-file', join(root, 'missing-token')], env: {} }),
    (error) => error instanceof McpConfigError && /不存在|不可读/.test(error.message),
  );

  // 空文件（trim 后）→ 配置错误。
  const emptyFile = join(root, 'empty-token');
  writeFileSync(emptyFile, '\n   \n');
  chmodSync(emptyFile, 0o600);
  assert.throws(
    () => resolveMcpConfig({ argv: ['--http-token-file', emptyFile], env: {} }),
    (error) => error instanceof McpConfigError && /内容为空/.test(error.message),
  );

  // 权限过宽（0644）→ 配置错误。
  const wideFile = join(root, 'wide-token');
  writeFileSync(wideFile, 'wide-token-value-0123456789');
  chmodSync(wideFile, 0o644);
  assert.throws(
    () => resolveMcpConfig({ argv: ['--http-token-file', wideFile], env: {} }),
    (error) => error instanceof McpConfigError && /权限必须是 0600/.test(error.message),
  );

  // 真实 CLI 子进程：--print-config 只写 stderr 且不泄 token；缺失/空/宽权限 exit 2。
  const serverPath = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));
  const childEnv = { ...process.env, CIRCUITPILOT_MCP_HTTP_TOKEN_FILE: '' };
  const runCli = (args) => spawnSync(process.execPath, [serverPath, ...args], { encoding: 'utf8', env: childEnv });
  const ok = runCli(['--http', '--http-token-file', tokenFile, '--print-config']);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '', '--print-config 不得污染 stdout');
  const printed = JSON.parse(ok.stderr);
  assert.equal(printed.httpAuth, true);
  assert.equal(printed.httpTokenFile, tokenFile);
  assert.equal(ok.stderr.includes(token), false, '--print-config 不得打印 token');
  assert.equal(Object.hasOwn(printed, 'httpToken'), false, '脱敏配置不得包含 httpToken');

  const explicitPrint = runCli(['--http', '--http-token', token, '--print-config']);
  assert.equal(explicitPrint.status, 0);
  assert.equal(explicitPrint.stderr.includes(token), false);

  for (const badFile of [join(root, 'missing-token'), emptyFile, wideFile]) {
    const bad = runCli(['--http', '--http-token-file', badFile, '--print-config']);
    assert.equal(bad.status, 2, 'token 文件缺失/空/权限过宽必须 exit 2');
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /配置错误/);
    assert.equal(bad.stderr.includes(token), false);
  }

  // help 里必须明确 --http-token 不推荐（进程列表可见），并提供 token 文件用法。
  assert.match(MCP_USAGE, /--http-token-file <path>/);
  assert.match(MCP_USAGE, /--http-token <token>/);
  assert.match(MCP_USAGE, /进程列表|不推荐/);
  assert.match(MCP_USAGE, /MCP_HTTP_UNAUTHORIZED/);
});
