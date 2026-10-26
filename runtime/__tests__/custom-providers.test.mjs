import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CUSTOM_KEYCHAIN_PREFIX, customKeychainService } from '../config.mjs';
import { serviceFor } from '../keychain.mjs';
import { testProvider } from '../providers.mjs';
import { ChatManager } from '../chat.mjs';
import {
  CUSTOM_PROVIDER_PROTOCOLS, CustomProviderRegistry, customProviderNotFound,
  summarizeCustomProvider, validateCustomProvider,
} from '../customProviders.mjs';

/**
 * 自定义模型 Provider 注册表（Runtime 侧单元测试）。
 *
 * 全部用临时状态目录 + fake keychain + fake fetch：不碰真实钥匙串、不联网，
 * 这样才能在 CI/无 macOS 环境里稳定跑，也不会因为本机恰好存过 Key 而变绿。
 */

// 不能把 maxOutputTokens 这类字段误判成密钥：只看「整个字段名」是否具有密钥语义。
const SENSITIVE_FIELD = /secret|credential|password|apikey|^key$|^token$/i;

function stateFile() {
  return join(mkdtempSync(join(tmpdir(), 'cp-custom-providers-')), 'custom-providers.json');
}

function validInput(overrides = {}) {
  return {
    id: 'acme-gateway',
    label: 'Acme 网关',
    protocol: 'openai',
    baseUrl: 'https://gateway.example/v1',
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 256000, maxOutputTokens: 32000, input: ['text', 'image'], reasoning: false },
      { id: 'gpt-5.6-mini', contextWindow: 128000, maxOutputTokens: 8192, input: ['text'], reasoning: false },
    ],
    ...overrides,
  };
}

/** 递归检查某个对象里没有敏感字段名（用于"配置/摘要里没有密钥"的断言）。 */
function assertNoSensitiveFields(value, at = 'root') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoSensitiveFields(item, `${at}[${index}]`)); return; }
  for (const [key, nested] of Object.entries(value)) {
    assert.doesNotMatch(key, SENSITIVE_FIELD, `${at}.${key} 疑似密钥字段`);
    assertNoSensitiveFields(nested, `${at}.${key}`);
  }
}

test('校验：合法配置被归一化（label 去空白、模型 label 缺省用 id、输入类型去重保序）', () => {
  const normalized = validateCustomProvider({
    ...validInput({ label: '  Acme 网关  ' }),
    models: [
      { id: 'm-1', contextWindow: 128000, maxOutputTokens: 4096, input: ['text', 'image', 'text'] },
      { id: 'm-2', label: '  第二个模型  ', contextWindow: 1000, maxOutputTokens: 100, input: ['text'], reasoning: true },
    ],
  }, { reservedIds: ['codex_account', 'custom_api'] });
  assert.equal(normalized.id, 'acme-gateway');
  assert.equal(normalized.label, 'Acme 网关');
  assert.equal(normalized.protocol, 'openai');
  assert.equal(normalized.baseUrl, 'https://gateway.example/v1');
  assert.deepEqual(normalized.models[0], { id: 'm-1', label: 'm-1', contextWindow: 128000, maxOutputTokens: 4096, input: ['text', 'image'], reasoning: false });
  assert.deepEqual(normalized.models[1].input, ['text']);
  assert.equal(normalized.models[1].reasoning, true);
  assert.equal(normalized.models[1].label, '第二个模型');
  // 只接受两种协议，且协议是原样落库的"数据"，不是运行时猜测。
  assert.deepEqual([...CUSTOM_PROVIDER_PROTOCOLS], ['openai', 'anthropic']);
  assert.equal(validateCustomProvider(validInput({ id: 'claude-gw', protocol: 'anthropic' })).protocol, 'anthropic');
});

test('校验：id 规则与内置保留 id', () => {
  const code = (input, options) => {
    try { validateCustomProvider(input, options); return null; } catch (error) { return error.code; }
  };
  assert.equal(code(validInput({ id: 'A-upper' })), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code(validInput({ id: 'a' })), 'CUSTOM_PROVIDER_INVALID', '最短 2 字符');
  assert.equal(code(validInput({ id: '1abc' })), 'CUSTOM_PROVIDER_INVALID', '不能以数字开头');
  assert.equal(code(validInput({ id: 'a'.repeat(41) })), 'CUSTOM_PROVIDER_INVALID', '最长 40 字符');
  assert.equal(code(validInput({ id: 'acme gateway' })), 'CUSTOM_PROVIDER_INVALID', '不能含空格');
  assert.equal(code(validInput({ id: 'acme_gateway.1-2' })), null, '点/下划线/连字符合法');
  for (const reserved of ['demo', 'codex_account', 'claude_account', 'openai_api', 'custom_api']) {
    assert.equal(code(validInput({ id: reserved }), { reservedIds: ['codex_account', 'claude_account', 'openai_api', 'custom_api'] }), 'CUSTOM_PROVIDER_INVALID', `${reserved} 是保留 id`);
  }
  // 路径 id 与 body id 不一致必须拒绝：否则"PUT /a 改了 b"无法排查。
  assert.equal(code({ ...validInput(), id: 'other-id' }, { idFromPath: 'acme-gateway' }), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code(validInput({ id: undefined }), { idFromPath: 'path-only-id' }), null, '允许 id 只在路径里');
});

test('校验：label / 协议 / baseUrl（仅 HTTPS 或本机回环 HTTP，禁止内嵌凭据）', () => {
  const code = (input) => { try { validateCustomProvider(input); return null; } catch (error) { return error.code; } };
  assert.equal(code(validInput({ label: '' })), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code(validInput({ label: '  ' })), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code(validInput({ label: 'x'.repeat(61) })), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code(validInput({ protocol: 'gemini' })), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code(validInput({ protocol: undefined })), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code(validInput({ baseUrl: '' })), 'CUSTOM_PROVIDER_INVALID', '缺地址是配置错误，不是 URL 格式错误');
  assert.equal(code(validInput({ baseUrl: 'http://gateway.example/v1' })), 'PROVIDER_BASE_URL_INVALID', '明文 HTTP 只允许本机回环');
  assert.equal(code(validInput({ baseUrl: 'https://user:pass@gateway.example/v1' })), 'PROVIDER_BASE_URL_INVALID');
  assert.equal(code(validInput({ baseUrl: 'not-a-url' })), 'PROVIDER_BASE_URL_INVALID');
  assert.equal(code(validInput({ baseUrl: 'http://127.0.0.1:8080/v1' })), null, '本机回环网关允许 HTTP');
  assert.equal(code(validInput({ baseUrl: 'http://localhost:11434/v1' })), null);
  assert.equal(validateCustomProvider(validInput({ baseUrl: 'https://gateway.example/v1/' })).baseUrl, 'https://gateway.example/v1', '去掉尾部斜杠');
});

test('校验：模型目录边界（数量/ID/上下文/输出上限/输入类型/推理等级）', () => {
  const code = (models) => { try { validateCustomProvider(validInput({ models })); return null; } catch (error) { return error.code; } };
  const model = (overrides = {}) => ({ id: 'm-1', contextWindow: 32000, maxOutputTokens: 4096, input: ['text'], reasoning: false, ...overrides });
  assert.equal(code([]), 'CUSTOM_PROVIDER_INVALID', '至少 1 个模型');
  assert.equal(code(Array.from({ length: 21 }, (_, index) => model({ id: `m-${index}` }))), 'CUSTOM_PROVIDER_INVALID', '最多 20 个模型');
  assert.equal(code([model({ id: 'same' }), model({ id: 'same' })]), 'CUSTOM_PROVIDER_INVALID', '模型 ID 唯一');
  assert.equal(code([model({ id: '' })]), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code([model({ id: 'has space' })]), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code([model({ id: 'x'.repeat(121) })]), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code([model({ contextWindow: 999 })]), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code([model({ contextWindow: 10_000_001 })]), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code([model({ contextWindow: 32000.5 })]), 'CUSTOM_PROVIDER_INVALID', '必须是整数');
  assert.equal(code([model({ maxOutputTokens: 99 })]), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code([model({ maxOutputTokens: 1_000_001, contextWindow: 10_000_000 })]), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code([model({ maxOutputTokens: 32_001, contextWindow: 32_000 })]), 'CUSTOM_PROVIDER_INVALID', '输出不能大于上下文窗口');
  assert.equal(code([model({ input: [] })]), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code([model({ input: ['image'] })]), 'CUSTOM_PROVIDER_INVALID', '必须包含 text');
  assert.equal(code([model({ input: ['text', 'audio'] })]), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code([model({ reasoning: 'yes' })]), 'CUSTOM_PROVIDER_INVALID');
  assert.equal(code([model({ reasoning: undefined })]), null, 'reasoning 缺省按 false 处理');
});

test('注册表：CRUD 落盘 + 重载（createdAt 保留、updatedAt 更新、文件里没有密钥字段）', () => {
  const file = stateFile();
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 9, 20, 8, 0, clock));
  const registry = new CustomProviderRegistry({ file, reservedIds: ['custom_api'], now });

  const created = registry.upsert(validInput(), { idFromPath: 'acme-gateway' });
  assert.equal(created.created, true);
  assert.equal(created.provider.id, 'acme-gateway');
  assert.equal(created.provider.models.length, 2);
  assert.equal(created.provider.createdAt, '2026-10-20T08:00:00.000Z');
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get('acme-gateway').label, 'Acme 网关');
  assert.equal(registry.get('missing'), null);

  // 落盘内容：schemaVersion 1 + providers 数组，且**不含任何密钥字段**。
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(saved.data.providers.map((item) => item.id), ['acme-gateway']);
  assertNoSensitiveFields(saved.data);

  clock = 1;
  const updated = registry.upsert(validInput({ label: 'Acme 网关（更新）' }), { idFromPath: 'acme-gateway' });
  assert.equal(updated.created, false);
  assert.equal(updated.provider.createdAt, '2026-10-20T08:00:00.000Z', '更新不能重置创建时间');
  assert.equal(updated.provider.updatedAt, '2026-10-20T08:00:01.000Z');

  // 重新构造 = 模拟 Runtime 重启：配置必须还在（权威持久化在 Runtime 侧）。
  const reloaded = new CustomProviderRegistry({ file, reservedIds: ['custom_api'] });
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.get('acme-gateway').label, 'Acme 网关（更新）');

  assert.deepEqual(reloaded.remove('acme-gateway'), { removed: true });
  assert.equal(reloaded.list().length, 0);
  const afterRemove = new CustomProviderRegistry({ file });
  assert.equal(afterRemove.list().length, 0, '删除必须落盘');
  assert.throws(() => afterRemove.remove('acme-gateway'), (error) => error.code === 'CUSTOM_PROVIDER_NOT_FOUND' && error.status === 404);
});

test('注册表：数量上限 20 个，第 21 个明确拒绝', () => {
  const registry = new CustomProviderRegistry({ file: stateFile() });
  for (let index = 0; index < 20; index += 1) registry.upsert(validInput({ id: `gw-${index}` }), { idFromPath: `gw-${index}` });
  assert.throws(() => registry.upsert(validInput({ id: 'gw-over' }), { idFromPath: 'gw-over' }), (error) => error.code === 'CUSTOM_PROVIDER_LIMIT' && error.status === 409);
  // 更新已存在的配置不受上限影响（否则满额后再也不能改配置）。
  assert.equal(registry.upsert(validInput({ id: 'gw-0', label: '改名' }), { idFromPath: 'gw-0' }).created, false);
});

test('注册表：损坏/版本不符 fail-closed（抛 STORE_*，不伪装成空注册表）', () => {
  const corrupt = stateFile();
  writeFileSync(corrupt, '{ this is not json', 'utf8');
  assert.throws(() => new CustomProviderRegistry({ file: corrupt }), (error) => error.code === 'STORE_CORRUPT');

  const future = stateFile();
  writeFileSync(future, JSON.stringify({ schemaVersion: 9, data: { providers: [] } }), 'utf8');
  assert.throws(() => new CustomProviderRegistry({ file: future }), (error) => error.code === 'STORE_SCHEMA_MISMATCH');

  const wrongShape = stateFile();
  writeFileSync(wrongShape, JSON.stringify({ schemaVersion: 1, data: { providers: 'nope' } }), 'utf8');
  assert.throws(() => new CustomProviderRegistry({ file: wrongShape }), (error) => error.code === 'STORE_CORRUPT');

  // 降级路径（server 侧捕获后使用）：无 file 的纯内存注册表仍可正常读写，不会因为文件坏了就整块功能不可用。
  const memory = new CustomProviderRegistry();
  assert.deepEqual(memory.list(), []);
  assert.equal(memory.upsert(validInput()).created, true);
  assert.equal(memory.list().length, 1);
});

test('摘要：形状与契约一致，且不含任何密钥字段', async () => {
  const registry = new CustomProviderRegistry({ file: stateFile() });
  registry.upsert(validInput(), { idFromPath: 'acme-gateway' });
  const keychain = { async configured(id) { return id === 'acme-gateway'; } };
  const [summary] = await registry.statuses(keychain);
  assert.equal(summary.id, 'acme-gateway');
  assert.equal(summary.label, 'Acme 网关');
  assert.equal(summary.kind, 'api');
  assert.equal(summary.configured, true);
  assert.equal(summary.ready, true);
  assert.equal(summary.custom, true);
  assert.equal(summary.editable, true);
  assert.equal(summary.protocol, 'openai');
  assert.equal(summary.baseUrl, 'https://gateway.example/v1');
  assert.deepEqual(summary.models.map((item) => item.id), ['gpt-5.6-sol', 'gpt-5.6-mini']);
  assert.deepEqual(summary.models[0].input, ['text', 'image']);
  assertNoSensitiveFields(summary);
  // 钥匙串探测失败只让该条目标为未配置，不拖垮整个列表。
  const [degraded] = await registry.statuses({ async configured() { throw Object.assign(new Error('boom'), { code: 'KEYCHAIN_UNAVAILABLE' }); } });
  assert.equal(degraded.configured, false);
  assert.equal(degraded.ready, false);
  assert.equal(summarizeCustomProvider({ id: 'x', label: 'X', protocol: 'anthropic', baseUrl: 'https://x.example/v1', models: [] }, false).kind, 'api');
});

test('resolve：描述符按协议派生鉴权头与端点（openai=Bearer / anthropic=x-api-key）', () => {
  const registry = new CustomProviderRegistry({ file: stateFile() });
  registry.upsert(validInput(), { idFromPath: 'acme-gateway' });
  registry.upsert(validInput({ id: 'claude-gw', label: 'Claude 网关', protocol: 'anthropic' }), { idFromPath: 'claude-gw' });

  const openai = registry.resolve('acme-gateway');
  assert.deepEqual(openai, {
    id: 'acme-gateway', label: 'Acme 网关', kind: 'api', custom: true, editable: true,
    protocol: 'openai', baseUrl: 'https://gateway.example/v1', chatBaseUrl: 'https://gateway.example/v1',
    chatModel: 'gpt-5.6-sol', auth: 'bearer', headers: {}, models: openai.models,
  });
  assert.deepEqual(openai.models.map((item) => item.id), ['gpt-5.6-sol', 'gpt-5.6-mini']);

  const anthropic = registry.resolve('claude-gw');
  assert.equal(anthropic.protocol, 'anthropic');
  assert.equal(anthropic.auth, 'x-api-key');
  assert.deepEqual(anthropic.headers, { 'anthropic-version': '2023-06-01' });
  assert.equal(registry.resolve('nope'), null);
  assert.equal(customProviderNotFound('nope').status, 404);
});

test('钥匙串：内置平台用声明表服务名，自定义 id 派生独立条目，非法 id 拒绝', () => {
  assert.equal(CUSTOM_KEYCHAIN_PREFIX, 'com.circuitpilot.provider.custom');
  assert.equal(customKeychainService('acme-gateway'), 'com.circuitpilot.provider.custom.acme-gateway');
  assert.equal(serviceFor('openai_api'), 'com.circuitpilot.provider.openai');
  assert.equal(serviceFor('custom_api'), 'com.circuitpilot.provider.custom');
  assert.equal(serviceFor('acme-gateway'), 'com.circuitpilot.provider.custom.acme-gateway');
  // 两个自定义 Provider 的条目互不相同：撤销/轮换一个不会影响另一个。
  assert.notEqual(serviceFor('acme-gateway'), serviceFor('internal-gateway'));
  for (const bad of ['a', 'Bad Id', 'https://evil.example', '', null, undefined]) {
    assert.throws(() => serviceFor(bad), (error) => error.code === 'KEYCHAIN_PROVIDER_UNSUPPORTED', String(bad));
  }
});

test('testProvider：用注册表描述符请求 {base}/models 并按协议带鉴权头', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, headers: init.headers }); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-mini' }] }) }; };
  const registry = new CustomProviderRegistry({ file: stateFile() });
  registry.upsert(validInput(), { idFromPath: 'acme-gateway' });
  registry.upsert(validInput({ id: 'claude-gw', protocol: 'anthropic' }), { idFromPath: 'claude-gw' });
  const keychain = { async read(id) { return `key-for-${id}`; } };
  try {
    const openai = await testProvider('acme-gateway', keychain, { provider: registry.resolve('acme-gateway') });
    assert.deepEqual(openai.models, ['gpt-5.6-sol', 'gpt-5.6-mini']);
    assert.equal(calls[0].url, 'https://gateway.example/v1/models');
    assert.equal(calls[0].headers.authorization, 'Bearer key-for-acme-gateway');
    assert.ok(!calls[0].url.includes('key-for-'), 'Key 绝不能出现在 URL 里');

    const anthropic = await testProvider('claude-gw', keychain, { provider: registry.resolve('claude-gw') });
    assert.equal(anthropic.ok, true);
    assert.equal(calls[1].url, 'https://gateway.example/v1/models');
    assert.equal(calls[1].headers['x-api-key'], 'key-for-claude-gw');
    assert.equal(calls[1].headers['anthropic-version'], '2023-06-01');
    assert.equal(calls[1].headers.authorization, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

// ---------------------------------------------------------------------------
// ChatManager 接入：后端解析、模型目录校验、图片门禁、协议透传
// ---------------------------------------------------------------------------

const unavailableBridge = { async discover() { return null; } };
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function customRegistry() {
  const registry = new CustomProviderRegistry({ file: stateFile() });
  registry.upsert({
    id: 'acme-gateway', label: 'Acme 网关', protocol: 'openai', baseUrl: 'https://gateway.example/v1',
    models: [
      { id: 'text-model', contextWindow: 256000, maxOutputTokens: 200000, input: ['text'], reasoning: false },
      { id: 'vision-model', contextWindow: 128000, maxOutputTokens: 1234, input: ['text', 'image'], reasoning: true },
    ],
  }, { idFromPath: 'acme-gateway' });
  registry.upsert({
    id: 'claude-gw', label: 'Claude 网关', protocol: 'anthropic', baseUrl: 'https://claude-gw.example/v1',
    models: [{ id: 'claude-vision', contextWindow: 200000, maxOutputTokens: 64000, input: ['text', 'image'], reasoning: false }],
  }, { idFromPath: 'claude-gw' });
  return registry;
}

const keychainWith = (keys) => ({
  async read(id) { if (!(id in keys)) throw Object.assign(new Error('Provider密钥未配置'), { code: 'KEY_NOT_CONFIGURED' }); return keys[id]; },
  async configured(id) { return id in keys; },
});
const chatJson = JSON.stringify({ reply: '收到', questions: [], requirementSuggestions: [], bomDraft: null });

test('ChatManager：状态/后端解析（内置优先、目录校验、默认模型、maxTokens 上限）', async () => {
  const manager = new ChatManager({
    keychain: keychainWith({ 'acme-gateway': 'sk-acme', 'claude-gw': 'sk-ant' }), bridge: unavailableBridge,
    client: { async createThread() { throw new Error('Codex 不应被调用'); }, close() {} },
    customProviders: customRegistry(),
  });
  const status = await manager.status('acme-gateway');
  assert.equal(status.ready, true);
  assert.equal(status.provider.custom, true);
  assert.equal(status.provider.editable, true);
  assert.equal(status.provider.protocol, 'openai');
  assert.equal((await manager.status('unknown-gateway')).ready, false);

  const defaultBackend = await manager.backend({ provider: 'acme-gateway' });
  assert.equal(defaultBackend.kind, 'api');
  assert.equal(defaultBackend.model, 'text-model', '未选模型时用目录首项');
  assert.equal(defaultBackend.protocol, 'openai');
  assert.equal(defaultBackend.auth, 'bearer');
  assert.equal(defaultBackend.baseUrl, 'https://gateway.example/v1');
  assert.equal(defaultBackend.maxTokens, 32000, '成本上限=min(32000, 模型 maxOutputTokens)；推理模型的思考 token 也计入 completion，4000 会被吃光');

  const visionBackend = await manager.backend({ provider: 'acme-gateway', model: 'vision-model' });
  assert.equal(visionBackend.model, 'vision-model');
  assert.equal(visionBackend.maxTokens, 1234, '取 min(4000, 模型 maxOutputTokens)');

  const anthropicBackend = await manager.backend({ provider: 'claude-gw', model: 'claude-vision' });
  assert.equal(anthropicBackend.protocol, 'anthropic');
  assert.equal(anthropicBackend.auth, 'x-api-key');
  assert.deepEqual(anthropicBackend.headers, { 'anthropic-version': '2023-06-01' });

  // 模型必须是目录内的：否则网关只会回一句 404/400，用户看不出是配置问题。
  await assert.rejects(() => manager.backend({ provider: 'acme-gateway', model: 'not-in-catalog' }), (error) => {
    assert.equal(error.code, 'CUSTOM_PROVIDER_MODEL_UNKNOWN');
    assert.equal(error.status, 400);
    assert.match(error.message, /text-model/);
    assert.match(error.message, /vision-model/);
    return true;
  });
  // 没有 Key 时明确要求先保存（与内置平台一致）。
  const noKey = new ChatManager({ keychain: keychainWith({}), bridge: unavailableBridge, customProviders: customRegistry() });
  await assert.rejects(() => noKey.backend({ provider: 'acme-gateway' }), { code: 'PROVIDER_CREDENTIAL_MISSING' });
});

test('ChatManager：OpenAI 协议下按模型元数据放行图片，并透传 max_tokens', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ model: 'vision-model', choices: [{ message: { content: chatJson } }] }) }; };
  try {
    const manager = new ChatManager({
      keychain: keychainWith({ 'acme-gateway': 'sk-acme', 'deepseek_api': 'sk-deepseek' }), bridge: unavailableBridge,
      client: { async createThread() { throw new Error('Codex 不应被调用'); }, close() {} },
      customProviders: customRegistry(),
    });
    const result = await manager.send('session-custom', {
      message: '看图并回答', provider: 'acme-gateway', model: 'vision-model', context: {},
      attachments: [{ kind: 'image', name: 'board.png', mime: 'image/png', dataBase64: pngBase64 }],
    });
    assert.equal(result.reply, '收到');
    assert.equal(result.provider, 'acme-gateway');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://gateway.example/v1/chat/completions');
    assert.equal(calls[0].headers.authorization, 'Bearer sk-acme');
    assert.equal(calls[0].body.model, 'vision-model');
    assert.equal(calls[0].body.max_tokens, 1234, 'maxTokens 来自模型目录的成本上限');
    const userMessage = calls[0].body.messages.at(-1);
    assert.equal(Array.isArray(userMessage.content), true, '有图片时 user content 必须是块数组');
    assert.equal(userMessage.content[0].type, 'text');
    assert.match(userMessage.content[0].text, /看图并回答/);
    assert.deepEqual(userMessage.content[1].type, 'image_url');
    assert.match(userMessage.content[1].image_url.url, /^data:image\/png;base64,/);
    // 纯文本模型仍然明确拒绝图片，而不是静默丢弃。
    await assert.rejects(() => manager.send('session-text-only', {
      message: '看图', provider: 'acme-gateway', model: 'text-model', context: {},
      attachments: [{ kind: 'image', name: 'board.png', mime: 'image/png', dataBase64: pngBase64 }],
    }), { code: 'PROVIDER_IMAGE_UNSUPPORTED' });
    // 内置第三方平台没有模型目录 → 维持原有"明确拒绝图片"的行为。
    await assert.rejects(() => manager.send('session-builtin', {
      message: '看图', provider: 'deepseek_api', model: 'deepseek-chat', context: {},
      attachments: [{ kind: 'image', name: 'board.png', mime: 'image/png', dataBase64: pngBase64 }],
    }), { code: 'PROVIDER_IMAGE_UNSUPPORTED' });
  } finally { globalThis.fetch = originalFetch; }
});

test('ChatManager：Anthropic 协议把图片放进 source 块，并按 messages 端点 + x-api-key 发请求', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ model: 'claude-vision', content: [{ type: 'text', text: chatJson }] }) };
  };
  try {
    const manager = new ChatManager({
      keychain: keychainWith({ 'claude-gw': 'sk-ant' }), bridge: unavailableBridge,
      client: { async createThread() { throw new Error('Codex 不应被调用'); }, close() {} },
      customProviders: customRegistry(),
    });
    const result = await manager.send('session-anthropic', {
      message: '看看这块板', provider: 'claude-gw', model: 'claude-vision', context: {},
      attachments: [{ kind: 'image', name: 'board.png', mime: 'image/png', dataBase64: pngBase64 }],
    });
    assert.equal(result.reply, '收到');
    assert.equal(calls[0].url, 'https://claude-gw.example/v1/messages');
    assert.equal(calls[0].headers['x-api-key'], 'sk-ant');
    assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(calls[0].headers.authorization, undefined);
    assert.equal(calls[0].body.system.includes('CircuitPilot'), true, 'system 是顶层字段');
    assert.equal('response_format' in calls[0].body, false, 'Anthropic 不支持 response_format');
    const userMessage = calls[0].body.messages.at(-1);
    assert.equal(userMessage.role, 'user');
    assert.equal(userMessage.content[0].type, 'text');
    assert.deepEqual(userMessage.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } });
    assert.equal(calls[0].body.max_tokens, 32000, 'min(32000, 64000)');
  } finally { globalThis.fetch = originalFetch; }
});

test('ChatManager：计划/生产计划/网表也走同一个自定义 Provider 后端', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const isSelection = /选型助手/.test(body.system || '');
    const content = isSelection
      ? JSON.stringify({ queries: [{ block: 'mcu', query: 'STM32G0' }] })
      : JSON.stringify({ status: 'blocked', explanation: '证据不足', blockingInformation: [], plan: null, blockers: [], netlist: null, title: 'x', blocks: {}, nets: [], placements: [], operations: [], assumptions: [] });
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: content }] }) };
  };
  try {
    const manager = new ChatManager({
      keychain: keychainWith({ 'claude-gw': 'sk-ant' }), bridge: unavailableBridge,
      client: { async createThread() { throw new Error('Codex 不应被调用'); }, close() {} },
      customProviders: customRegistry(),
    });
    const plan = await manager.plan({ requirement: '做一个控制板', provider: 'claude-gw', model: 'claude-vision', context: { requirement: '做一个控制板' } });
    assert.equal(plan.status, 'blocked');
    // 选型关键词 + 计划两次调用都走 Anthropic 端点，且都带 x-api-key。
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, 'https://claude-gw.example/v1/messages');
      assert.equal(call.headers['x-api-key'], 'sk-ant');
    }
    const production = await manager.productionPlan({ instruction: '挪一下USB', provider: 'claude-gw', model: 'claude-vision', context: {} });
    assert.equal(production.status, 'blocked');
    const netlist = await manager.netlist({ provider: 'claude-gw', model: 'claude-vision', context: {} });
    assert.equal(netlist.status, 'blocked');
  } finally { globalThis.fetch = originalFetch; }
});
