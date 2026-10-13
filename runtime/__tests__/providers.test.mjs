import assert from 'node:assert/strict';
import test from 'node:test';
import { API_PROVIDER_IDS, PROVIDERS, PROVIDER_IDS, authHeaders, modelIds, openProviderConsole, providerStatuses, startProviderLogin, testProvider } from '../providers.mjs';

/** 除官方两家外，本轮新增的第三方平台必须都在这张表里，避免“前端能选、后端不认”。 */
const THIRD_PARTY_IDS = ['deepseek_api', 'moonshot_api', 'zhipu_api', 'dashscope_api', 'siliconflow_api', 'openrouter_api', 'gemini_api', 'xai_api', 'groq_api', 'mistral_api'];

test('provider status exposes summaries while Keychain remains abstracted', async () => {
  const requested = [];
  const keychain = { async configured(id) { requested.push(id); return id === 'openai_api'; } };
  const providers = await providerStatuses(keychain);
  assert.deepEqual(requested.sort(), [...API_PROVIDER_IDS].sort());
  assert.deepEqual(providers.map((item) => item.id), PROVIDER_IDS);
  assert.equal(providers.find((item) => item.id === 'openai_api').ready, true);
  assert.equal(providers.find((item) => item.id === 'deepseek_api').configured, false);
  assert.equal(providers.find((item) => item.id === 'codex_account').kind, 'cli');
  // 状态里只能有摘要字段：不允许出现凭据明文或密钥字段（keyUrl 是公开的控制台地址，单独放行）。
  for (const provider of providers) {
    const suspicious = Object.keys(provider).filter((field) => /secret|credential|password|token|^key$|apikey/i.test(field));
    assert.deepEqual(suspicious, [], `${provider.id} 的状态里出现了疑似密钥字段`);
  }
});

test('third-party platforms are declared as API providers with HTTPS endpoints', () => {
  assert.deepEqual(API_PROVIDER_IDS.filter((id) => !['openai_api', 'anthropic_api'].includes(id)).sort(), [...THIRD_PARTY_IDS].sort());
  for (const id of THIRD_PARTY_IDS) {
    const provider = PROVIDERS[id];
    assert.ok(provider, `${id} 必须在 PROVIDERS 中声明`);
    assert.equal(provider.kind, 'api', `${id} 必须是 api 型`);
    assert.match(provider.modelsUrl, /^https:\/\//, `${id} 的模型地址必须是 HTTPS，避免明文传输 Key`);
  }
});

test('auth headers only ever carry the key in the platform-specific header', () => {
  assert.deepEqual(authHeaders(PROVIDERS.openai_api, 'k'), { authorization: 'Bearer k' });
  assert.deepEqual(authHeaders(PROVIDERS.deepseek_api, 'k'), { authorization: 'Bearer k' });
  assert.deepEqual(authHeaders(PROVIDERS.anthropic_api, 'k'), { 'anthropic-version': '2023-06-01', 'x-api-key': 'k' });
  assert.deepEqual(authHeaders(PROVIDERS.gemini_api, 'k'), { 'x-goog-api-key': 'k' });
});

test('model ids normalize both OpenAI-style and Google-style payloads', () => {
  assert.deepEqual(modelIds({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }), ['deepseek-chat', 'deepseek-reasoner']);
  assert.deepEqual(modelIds({ models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }] }), ['gemini-2.5-pro', 'gemini-2.5-flash']);
  assert.deepEqual(modelIds({ data: [] }), []);
  assert.deepEqual(modelIds(null), []);
});

test('a third-party API provider is tested against its own endpoint and header', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, headers: init.headers }); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-chat' }] }) }; };
  try {
    const result = await testProvider('deepseek_api', { async read(id) { return `key-for-${id}`; } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ['deepseek-chat']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, PROVIDERS.deepseek_api.modelsUrl);
    assert.equal(calls[0].headers.authorization, 'Bearer key-for-deepseek_api');
  } finally { globalThis.fetch = originalFetch; }
});

test('Google Gemini sends the key in a header, never in the URL', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, headers: init.headers }); return { ok: true, status: 200, json: async () => ({ models: [{ name: 'models/gemini-2.5-pro' }] }) }; };
  try {
    const result = await testProvider('gemini_api', { async read() { return 'AIza-test-key-1234567890'; } });
    assert.deepEqual(result.models, ['gemini-2.5-pro']);
    assert.equal(calls[0].headers['x-goog-api-key'], 'AIza-test-key-1234567890');
    assert.equal(String(calls[0].url).includes('AIza'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('provider status can be scoped to a subset so unrelated platforms are not probed', async () => {
  const requested = [];
  const keychain = { async configured(id) { requested.push(id); return false; } };
  const providers = await providerStatuses(keychain, ['codex_account']);
  assert.deepEqual(requested, []);
  assert.deepEqual(providers.map((item) => item.id), ['codex_account']);
  // 未声明的 id 直接被忽略，而不是让整个状态查询失败。
  assert.deepEqual(await providerStatuses(keychain, ['not_a_provider']), []);
});

test('平台控制台只能打开声明表里的地址，且拒绝账号型 Provider', async () => {
  const opened = [];
  const result = await openProviderConsole('deepseek_api', { open: async (url) => { opened.push(url); return { ok: true }; } });
  assert.equal(result.opened, true);
  assert.equal(result.url, PROVIDERS.deepseek_api.keyUrl);
  assert.deepEqual(opened, [PROVIDERS.deepseek_api.keyUrl]);
  // 调用方只能传 Provider id：账号型 Provider 没有控制台，未知 id 也不成立。
  await assert.rejects(() => openProviderConsole('codex_account', { open: async () => ({ ok: true }) }), { code: 'CONSOLE_UNSUPPORTED' });
  await assert.rejects(() => openProviderConsole('not_a_provider', { open: async () => ({ ok: true }) }), { code: 'CONSOLE_UNSUPPORTED' });
  // 浏览器调起失败必须显式报错，而不是静默成功。
  await assert.rejects(() => openProviderConsole('gemini_api', { open: async () => ({ ok: false, stderr: 'no browser' }) }), { code: 'CONSOLE_OPEN_FAILED' });
});

test('API 平台都声明了 HTTPS 控制台地址，并随状态一起下发给前端', async () => {
  for (const id of THIRD_PARTY_IDS) assert.match(PROVIDERS[id].keyUrl, /^https:\/\//, `${id} 缺少 HTTPS 控制台地址`);
  const statuses = await providerStatuses({ async configured() { return false; } });
  for (const status of statuses.filter((item) => item.kind === 'api')) assert.match(status.keyUrl, /^https:\/\//, `${status.id} 的状态里没有 keyUrl`);
  assert.equal(statuses.find((item) => item.id === 'codex_account').keyUrl, undefined);
});

test('unknown provider cannot trigger a network request', async () => {
  await assert.rejects(() => testProvider('unknown', { read: async () => 'never' }), { code: 'PROVIDER_UNKNOWN' });
});

test('API platforms cannot be driven through the CLI login path', async () => {
  await assert.rejects(() => startProviderLogin('deepseek_api'), { code: 'LOGIN_UNSUPPORTED' });
});

test('login short-circuits an already authenticated Codex account', async()=>{
  let spawned=false; const result=await startProviderLogin('codex_account',{findExecutable:async()=>'/fixed/codex',cliStatus:async()=>({authenticated:true,status:'Logged in using ChatGPT'}),startObserved:async()=>{spawned=true;}});
  assert.equal(result.state,'already_authenticated'); assert.equal(result.authenticated,true); assert.equal(spawned,false);
});

test('login reports early CLI exit instead of false success',async()=>{
  await assert.rejects(()=>startProviderLogin('codex_account',{findExecutable:async()=>'/fixed/codex',cliStatus:async()=>({authenticated:false}),startObserved:async()=>({state:'failed',started:false,detail:'browser launch failed'})}),{code:'LOGIN_PROCESS_EXITED'});
});
