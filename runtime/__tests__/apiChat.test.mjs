import test from 'node:test';
import assert from 'node:assert/strict';
import { completeJson, extractJson } from '../apiChat.mjs';
import { normalizeBaseUrl, resolveChatBaseUrl, PROVIDERS, testProvider } from '../providers.mjs';

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const okBody = (content) => ({ model: 'deepseek-chat', choices: [{ message: { content } }] });

test('normalizeBaseUrl：只接受 HTTPS 或本机回环 HTTP，且不允许内嵌凭据', () => {
  assert.equal(normalizeBaseUrl('https://gateway.example.com/v1/'), 'https://gateway.example.com/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1');
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl(''), null);
  assert.equal(normalizeBaseUrl(undefined), null);
  for (const bad of ['http://gateway.example.com/v1', 'https://user:pass@gateway.example.com/v1', 'not-a-url']) {
    assert.throws(() => normalizeBaseUrl(bad), { code: 'PROVIDER_BASE_URL_INVALID' }, bad);
  }
});

test('resolveChatBaseUrl：请求覆盖优先，未声明的平台必须给出兼容 Base URL', () => {
  assert.equal(resolveChatBaseUrl(PROVIDERS.deepseek_api, 'https://vendor.example.com/v1'), 'https://vendor.example.com/v1');
  assert.equal(resolveChatBaseUrl(PROVIDERS.deepseek_api, ''), 'https://api.deepseek.com/v1');
  assert.throws(() => resolveChatBaseUrl(PROVIDERS.anthropic_api, ''), { code: 'PROVIDER_CHAT_UNSUPPORTED' });
  assert.ok(resolveChatBaseUrl(PROVIDERS.ark_api, undefined).includes('ark.cn-beijing.volces.com'));
  assert.ok(resolveChatBaseUrl(PROVIDERS.qianfan_api, undefined).includes('qianfan.baidubce.com'));
});

test('extractJson：兼容 Markdown 围栏与前后说明文字', () => {
  assert.deepEqual(extractJson('```json\n{"status":"ready"}\n```'), { status: 'ready' });
  assert.deepEqual(extractJson('结果如下：{"status":"blocked"} 仅供参考'), { status: 'blocked' });
  assert.throws(() => extractJson('没有 JSON'), { code: 'PROVIDER_RESPONSE_INVALID' });
});

test('completeJson：向第三方供应商 Base URL 发起 OpenAI 兼容请求并解析 JSON', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response(200, okBody('{"reply":"你好","questions":[],"requirementSuggestions":[],"bomDraft":null}'));
  };
  const result = await completeJson({
    providerId: 'deepseek_api', key: 'sk-test', model: 'deepseek-chat', baseUrl: 'https://vendor.example.com/v1',
    instructions: '你是测试助手', input: '你好', schema: { type: 'object' }, fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://vendor.example.com/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.ok(!calls[0].url.includes('sk-test'), 'Key 不得出现在 URL 中');
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.model, 'deepseek-chat');
  assert.equal(payload.messages[0].role, 'system');
  assert.match(payload.messages[0].content, /你是测试助手/);
  assert.deepEqual(payload.response_format, { type: 'json_object' });
  assert.equal(result.json.reply, '你好');
});

test('completeJson：平台不支持 response_format 时自动降级重试一次', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    if (!('response_format' in JSON.parse(init.body))) return response(200, okBody('{"status":"ready"}'));
    return response(400, { error: { message: 'response_format is not supported' } });
  };
  const result = await completeJson({ providerId: 'deepseek_api', key: 'k', instructions: 'x', input: 'y', schema: { type: 'object' }, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(result.json.status, 'ready');
});

test('completeJson：401 映射为明确的凭据错误，不泄露 Key', async () => {
  const fetchImpl = async () => response(401, { error: { message: 'invalid api key sk-very-secret' } });
  await assert.rejects(() => completeJson({ providerId: 'deepseek_api', key: 'sk-very-secret', instructions: 'x', input: 'y', fetchImpl }), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAUTHORIZED');
    assert.ok(!String(error.message).includes('sk-very-secret'));
    return true;
  });
});

test('testProvider：支持用自定义 Base URL 探测 /models', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, headers: init.headers }); return response(200, { data: [{ id: 'deepseek-chat' }] }); };
  try {
    const result = await testProvider('deepseek_api', { async read() { return 'k-1'; } }, { baseUrl: 'https://vendor.example.com/v1' });
    assert.deepEqual(result.models, ['deepseek-chat']);
    assert.equal(calls[0].url, 'https://vendor.example.com/v1/models');
    assert.equal(calls[0].headers.authorization, 'Bearer k-1');
  } finally { globalThis.fetch = original; }
  await assert.rejects(() => testProvider('deepseek_api', { async read() { return 'k'; } }, { baseUrl: 'http://evil.example.com' }), { code: 'PROVIDER_BASE_URL_INVALID' });
});

test('completeJson：auto(空模型) 使用平台默认 DeepSeek 模型，未声明默认值的平台要求显式选择', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return response(200, okBody('{"ok":true}')); };
  await completeJson({ providerId: 'deepseek_api', key: 'k', instructions: 'x', input: 'y', fetchImpl });
  assert.equal(sent[0].model, 'deepseek-chat');
  await completeJson({ providerId: 'ark_api', key: 'k', instructions: 'x', input: 'y', fetchImpl });
  assert.equal(sent[1].model, 'deepseek-v3-250324');
  await assert.rejects(() => completeJson({ providerId: 'openai_api', key: 'k', instructions: 'x', input: 'y', fetchImpl }), { code: 'PROVIDER_MODEL_REQUIRED' });
});

test('custom_api：URL 由用户填写，缺失时明确报错，填写后按该 URL 调用', async () => {
  assert.throws(() => resolveChatBaseUrl(PROVIDERS.custom_api, ''), { code: 'PROVIDER_BASE_URL_REQUIRED' });
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return response(200, okBody('{"ok":true}')); };
  const result = await completeJson({ providerId: 'custom_api', key: 'sk-custom', model: 'deepseek-chat', baseUrl: 'https://gateway.example.com/v1', instructions: 'x', input: 'y', fetchImpl });
  assert.equal(result.json.ok, true);
  assert.equal(sent[0].url, 'https://gateway.example.com/v1/chat/completions');
  assert.equal(sent[0].body.model, 'deepseek-chat');
  await assert.rejects(() => completeJson({ providerId: 'custom_api', key: 'k', model: '', baseUrl: 'https://gateway.example.com/v1', instructions: 'x', input: 'y', fetchImpl }), { code: 'PROVIDER_MODEL_REQUIRED' });
});
