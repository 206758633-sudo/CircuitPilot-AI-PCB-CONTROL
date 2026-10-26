import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

/**
 * 自定义模型 Provider 的 HTTP 契约测试。
 *
 * 隔离方式（必须，否则会把开发机上的真实配置/钥匙串写坏）：
 * - `CIRCUITPILOT_STATE_DIR` 等目录指向 mkdtemp；
 * - keychain 用内存假实现（记录 store/remove，绝不碰真实钥匙串）；
 * - "厂商网关"起一个本机回环 HTTP server 充当，既能验证真实请求路径/鉴权头，
 *   又不需要 mock 全局 fetch（否则会打断测试自己访问 Runtime 的 fetch）。
 */

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const root = mkdtempSync(join(tmpdir(), 'cp-custom-http-'));
process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation');
process.env.CIRCUITPILOT_RELEASES_DIR = join(root, 'releases');
process.env.CIRCUITPILOT_PROJECT_MEMO = join(root, 'memo.json');

function fakeKeychain() {
  const keys = new Map();
  const calls = [];
  return {
    keys, calls,
    async configured(id) { return keys.has(id); },
    async store(id, key) { calls.push(['store', id]); keys.set(id, key); return { configured: true, hint: `••••${String(key).slice(-4)}` }; },
    async read(id) { if (!keys.has(id)) throw Object.assign(new Error('Provider密钥未配置'), { code: 'KEY_NOT_CONFIGURED' }); return keys.get(id); },
    async remove(id) { calls.push(['remove', id]); keys.delete(id); return { configured: false }; },
  };
}

/** 假厂商网关：记录请求（路径 + 关键头），返回 OpenAI/Anthropic 风格的模型列表。 */
async function startGateway(body) {
  const requests = [];
  const gateway = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
  return { gateway, requests, baseUrl: `http://127.0.0.1:${gateway.address().port}/v1` };
}

async function startRuntime(keychain) {
  const { server } = createRuntimeServer({ keychain, bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const token = health.sessionProof;
  assert.equal(typeof token, 'string');
  const call = async (path, { method = 'GET', body, authorized = true } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(authorized ? { 'x-circuitpilot-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 响应保留原文用于断言 */ }
    return { status: response.status, text, json };
  };
  return { server, call, token };
}

function providerBody(baseUrl, overrides = {}) {
  return {
    label: 'Acme 网关',
    protocol: 'openai',
    baseUrl,
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 256000, maxOutputTokens: 32000, input: ['text', 'image'], reasoning: false },
      { id: 'gpt-5.6-mini', contextWindow: 128000, maxOutputTokens: 8192, input: ['text'], reasoning: false },
    ],
    ...overrides,
  };
}

test('自定义 Provider HTTP：鉴权、创建、列表合并、探测模型、测试连接、删除、持久化', async (context) => {
  const gateway = await startGateway({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-mini' }] });
  const keychain = fakeKeychain();
  const { server, call } = await startRuntime(keychain);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => gateway.gateway.close(resolve));
  });

  // 1) 三条新路由都必须受会话令牌保护（与其它路由一致，避免本机任意进程改配置）。
  for (const [path, method] of [['/api/custom-providers/acme-gateway', 'PUT'], ['/api/custom-providers/acme-gateway', 'DELETE'], ['/api/custom-providers/acme-gateway/models', 'POST']]) {
    const denied = await call(path, { method, body: {}, authorized: false });
    assert.equal(denied.status, 401, `${method} ${path} 必须要求令牌`);
  }

  // 2) 创建：路径 id 是唯一来源，body 里的 id 必须与之一致。
  const created = await call('/api/custom-providers/acme-gateway', { method: 'PUT', body: providerBody(gateway.baseUrl) });
  assert.equal(created.status, 200);
  assert.equal(created.json.ok, true);
  assert.equal(created.json.customProvider.id, 'acme-gateway');
  assert.equal(created.json.customProvider.label, 'Acme 网关');
  assert.equal(created.json.customProvider.protocol, 'openai');
  assert.equal(created.json.customProvider.configured, false);
  assert.equal(created.json.customProvider.ready, false);
  assert.equal(created.json.customProvider.models.length, 2);
  // 全局响应脱敏按字段名擦除，token/credential 这类名字容易被误伤：协议里的数字配置必须原样返回。
  assert.equal(created.json.customProvider.models[0].maxOutputTokens, 32000);
  assert.equal(created.json.customProvider.models[0].contextWindow, 256000);
  assert.deepEqual(created.json.customProvider.models[0].input, ['text', 'image']);
  assert.equal(created.json.customProvider.models[0].reasoning, false);
  assert.match(created.json.customProvider.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(created.text.includes('sk-'), false, '响应里不能出现任何密钥');

  const mismatch = await call('/api/custom-providers/acme-gateway', { method: 'PUT', body: { ...providerBody(gateway.baseUrl), id: 'other-gateway' } });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.error.code, 'CUSTOM_PROVIDER_INVALID');

  const invalid = await call('/api/custom-providers/bad-gateway', { method: 'PUT', body: { ...providerBody(gateway.baseUrl), label: '' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'CUSTOM_PROVIDER_INVALID');

  const reserved = await call('/api/custom-providers/custom_api', { method: 'PUT', body: providerBody(gateway.baseUrl) });
  assert.equal(reserved.status, 400);
  assert.equal(reserved.json.error.code, 'CUSTOM_PROVIDER_INVALID', '内置 custom_api 不能被自定义 Provider 占用');

  // 3) GET /api/providers：内置在前 + 自定义摘要（editable/custom/models），且不含密钥字段。
  const list = await call('/api/providers');
  assert.equal(list.status, 200);
  const summary = list.json.providers.find((item) => item.id === 'acme-gateway');
  assert.ok(summary, '自定义 Provider 必须出现在 /api/providers');
  assert.equal(summary.custom, true);
  assert.equal(summary.editable, true);
  assert.equal(summary.kind, 'api');
  assert.equal(summary.protocol, 'openai');
  assert.equal(summary.baseUrl, gateway.baseUrl);
  assert.deepEqual(summary.models.map((item) => item.id), ['gpt-5.6-sol', 'gpt-5.6-mini']);
  assert.equal(summary.models[0].maxOutputTokens, 32000, '摘要里的输出上限不能被响应脱敏擦成字符串');
  // 内置 custom_api 仍然只有 custom 标记（没有 editable/models），前端据此区分两种"自定义"。
  const builtinCustom = list.json.providers.find((item) => item.id === 'custom_api');
  assert.equal(builtinCustom.custom, true);
  assert.equal(builtinCustom.editable, undefined);
  assert.equal(builtinCustom.models, undefined);
  assert.equal(list.json.providers[0].id, 'codex_account', '内置 Provider 排在前面');
  for (const item of list.json.providers) {
    const suspicious = Object.keys(item).filter((field) => /secret|credential|password|token|^key$|apikey/i.test(field));
    assert.deepEqual(suspicious, [], `${item.id} 的摘要里出现了疑似密钥字段`);
  }
  // 内置 CLI 账号状态里可能出现 CLI 自己打码后的片段（既有行为，不在本次收紧范围）；
  // 这里只断言本功能新增的部分不含密钥值/密钥字段。
  assert.equal(JSON.stringify(summary).includes('sk-acme'), false);

  // 4) 未存 Key 时"获取可用模型"明确要求先保存密钥（409），且不会去打网关。
  const keyRequired = await call('/api/custom-providers/acme-gateway/models', { method: 'POST' });
  assert.equal(keyRequired.status, 409);
  assert.equal(keyRequired.json.error.code, 'CUSTOM_PROVIDER_KEY_REQUIRED');
  assert.match(keyRequired.json.error.message, /密钥/);
  assert.equal(gateway.requests.length, 0, '没有 Key 时不能对外发请求');

  // 5) 保存 Key（响应不得回显明文）→ 状态变 configured，再探测模型。
  const keySaved = await call('/api/providers/acme-gateway/key', { method: 'POST', body: { key: 'sk-acme-secret-1234' } });
  assert.equal(keySaved.status, 200);
  assert.equal(keySaved.json.credential.configured, true);
  assert.equal(keySaved.text.includes('sk-acme-secret-1234'), false, '保存接口不能回显 Key');
  assert.deepEqual(keychain.calls.filter(([kind]) => kind === 'store').map(([, id]) => id), ['acme-gateway']);

  const configuredList = await call('/api/providers');
  assert.equal(configuredList.json.providers.find((item) => item.id === 'acme-gateway').configured, true);
  assert.equal(configuredList.text.includes('sk-acme-secret-1234'), false, '列表里绝不能回显已保存的密钥');

  const probed = await call('/api/custom-providers/acme-gateway/models', { method: 'POST' });
  assert.equal(probed.status, 200);
  assert.deepEqual(probed.json.models, [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-mini' }]);
  assert.equal(gateway.requests.length, 1);
  assert.equal(gateway.requests[0].url, '/v1/models', '按注册表里的 Base URL 探测');
  assert.equal(gateway.requests[0].headers.authorization, 'Bearer sk-acme-secret-1234', 'Key 只在鉴权头里');
  assert.equal(String(gateway.requests[0].url).includes('sk-acme'), false);

  // 6) 测试连接走同一描述符（地址以注册表为准，不允许请求体覆盖成任意 URL）。
  const tested = await call('/api/providers/acme-gateway/test', { method: 'POST', body: { baseUrl: 'https://attacker.example/v1' } });
  assert.equal(tested.status, 200);
  assert.deepEqual(tested.json.test.models, ['gpt-5.6-sol', 'gpt-5.6-mini']);
  assert.equal(gateway.requests.length, 2);
  assert.equal(gateway.requests[1].url, '/v1/models', '请求体里的 baseUrl 不生效，仍打注册表地址');

  // 7) 未知 id 一律 404 CUSTOM_PROVIDER_NOT_FOUND（而不是钥匙串的 Unsupported provider）。
  for (const [path, method] of [['/api/providers/not-a-provider/key', 'POST'], ['/api/providers/not-a-provider/test', 'POST'], ['/api/providers/not-a-provider/key', 'DELETE'], ['/api/custom-providers/not-a-provider/models', 'POST'], ['/api/custom-providers/not-a-provider', 'DELETE']]) {
    const missing = await call(path, { method, body: method === 'POST' ? { key: 'sk-x-long-enough-key' } : undefined });
    assert.equal(missing.status, 404, `${method} ${path} 应 404`);
    assert.equal(missing.json.error.code, 'CUSTOM_PROVIDER_NOT_FOUND', `${method} ${path} 错误码`);
  }

  // 8) 落盘文件：schemaVersion 1 + 原子写，且不含任何密钥。
  const savedFile = join(process.env.CIRCUITPILOT_STATE_DIR, 'custom-providers.json');
  const saved = JSON.parse(readFileSync(savedFile, 'utf8'));
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(saved.data.providers.map((item) => item.id), ['acme-gateway']);
  assert.equal(readFileSync(savedFile, 'utf8').includes('sk-acme-secret'), false, '密钥绝不能落盘');

  // 9) 删除：配置 + 钥匙串条目一起清掉，列表里不再出现。
  const deleted = await call('/api/custom-providers/acme-gateway', { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.removed, true);
  assert.deepEqual(deleted.json.credential, { configured: false });
  assert.deepEqual(keychain.calls.filter(([kind]) => kind === 'remove').map(([, id]) => id), ['acme-gateway']);
  const afterDelete = await call('/api/providers');
  assert.equal(afterDelete.json.providers.some((item) => item.id === 'acme-gateway'), false);
  const afterDeleteFile = JSON.parse(readFileSync(savedFile, 'utf8'));
  assert.deepEqual(afterDeleteFile.data.providers, []);

  // 10) 删除不存在的 id → 404（不静默成功）。
  const deleteMissing = await call('/api/custom-providers/acme-gateway', { method: 'DELETE' });
  assert.equal(deleteMissing.status, 404);
  assert.equal(deleteMissing.json.error.code, 'CUSTOM_PROVIDER_NOT_FOUND');
});

test('自定义 Provider HTTP：Anthropic 协议的探测带 x-api-key 与 anthropic-version', async (context) => {
  const gateway = await startGateway({ data: [{ id: 'claude-sonnet-4' }] });
  const keychain = fakeKeychain();
  keychain.keys.set('claude-gw', 'sk-ant-secret-1234');
  const { server, call } = await startRuntime(keychain);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => gateway.gateway.close(resolve));
  });

  const created = await call('/api/custom-providers/claude-gw', {
    method: 'PUT',
    body: {
      label: 'Claude 网关', protocol: 'anthropic', baseUrl: gateway.baseUrl,
      models: [{ id: 'claude-sonnet-4', label: 'Claude Sonnet 4', contextWindow: 200000, maxOutputTokens: 64000, input: ['text', 'image'], reasoning: false }],
    },
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.customProvider.protocol, 'anthropic');

  const probed = await call('/api/custom-providers/claude-gw/models', { method: 'POST' });
  assert.equal(probed.status, 200);
  assert.deepEqual(probed.json.models, [{ id: 'claude-sonnet-4' }]);
  assert.equal(gateway.requests[0].headers['x-api-key'], 'sk-ant-secret-1234');
  assert.equal(gateway.requests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(gateway.requests[0].headers.authorization, undefined);
});

test('自定义 Provider HTTP：状态文件损坏时 Runtime 仍可启动并给出明确错误（降级为内存）', async (context) => {
  const brokenRoot = mkdtempSync(join(tmpdir(), 'cp-custom-http-broken-'));
  const previous = process.env.CIRCUITPILOT_STATE_DIR;
  process.env.CIRCUITPILOT_STATE_DIR = brokenRoot;
  // 先写一个损坏的状态文件，再起服务：不能因为坏文件就起不来，也不能假装是空注册表还允许覆盖写。
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(brokenRoot, { recursive: true });
  writeFileSync(join(brokenRoot, 'custom-providers.json'), '{ not json', 'utf8');
  try {
    const keychain = fakeKeychain();
    const { server, call } = await startRuntime(keychain);
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const list = await call('/api/providers');
    assert.equal(list.status, 200, '降级后 /api/providers 仍可用');
    assert.equal(list.json.providers.some((item) => item.custom && item.editable), false, '坏文件不会变成"有配置"');
    // 对外必须明确：不能把"状态文件坏了"伪装成"没有自定义 Provider"。
    assert.equal(list.json.customProviders.available, false);
    assert.equal(list.json.customProviders.code, 'STORE_CORRUPT');
    assert.match(list.json.customProviders.message, /STORE_CORRUPT/);
    // 写操作 fail-closed 拒绝：内存注册表的写入重启即丢，假装保存成功比报错更糟。
    const created = await call('/api/custom-providers/memory-gw', { method: 'PUT', body: providerBody('https://gateway.example/v1') });
    assert.equal(created.status, 503);
    assert.equal(created.json.error.code, 'CUSTOM_PROVIDER_STORE_UNAVAILABLE');
    assert.match(created.json.error.message, /custom-providers\.json/);
  } finally {
    if (previous === undefined) delete process.env.CIRCUITPILOT_STATE_DIR; else process.env.CIRCUITPILOT_STATE_DIR = previous;
    rmSync(brokenRoot, { recursive: true, force: true });
  }
});

test('CORS 预检必须放行 PUT：否则浏览器里的保存请求根本发不出去', async (context) => {
  // 真实故障：allow-methods 漏了 PUT 时，WebView 的预检被拒，fetch 直接抛错 →
  // 前端显示“无法连接本机Runtime”，而 Runtime 日志里一条 PUT 都没有。
  const keychain = fakeKeychain();
  const { server } = await startRuntime(keychain);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const target of ['/api/custom-providers/acme-gateway', '/api/project-state', '/api/settings']) {
    const preflight = await fetch(`${base}${target}`, {
      method: 'OPTIONS',
      headers: {
        origin: TRUSTED_ORIGIN,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,x-circuitpilot-token',
      },
    });
    assert.equal(preflight.status, 204, `${target} 预检必须 204`);
    assert.equal(preflight.headers.get('access-control-allow-origin'), TRUSTED_ORIGIN);
    const methods = (preflight.headers.get('access-control-allow-methods') || '').toUpperCase();
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.ok(methods.includes(method), `${target} 预检必须允许 ${method}（当前：${methods}）`);
    }
    const headers = (preflight.headers.get('access-control-allow-headers') || '').toLowerCase();
    assert.ok(headers.includes('x-circuitpilot-token'), `${target} 预检必须允许会话令牌头`);
    assert.ok(headers.includes('content-type'), `${target} 预检必须允许 JSON 请求头`);
  }

  // 未知来源仍然必须被拒（顺带确认预检没有因为放行 PUT 而放宽来源校验）。
  const foreign = await fetch(`${base}/api/custom-providers/acme-gateway`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' },
  });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error.code, 'ORIGIN_FORBIDDEN');
});
