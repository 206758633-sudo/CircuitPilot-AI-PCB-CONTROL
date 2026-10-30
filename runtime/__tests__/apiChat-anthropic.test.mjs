import assert from 'node:assert/strict';
import test from 'node:test';
import { completeJson } from '../apiChat.mjs';

/**
 * 协议适配层测试：Anthropic Messages 与 OpenAI Chat Completions 的请求形状。
 *
 * 只测"发出什么请求 / 如何解析响应"，全部用 fetchImpl 注入，不联网；
 * 同时固定住三条安全属性：Key 只出现在鉴权头、不出现在 URL/错误消息里，
 * 图片以 base64 块内联（不经图床），anthropic 不使用 response_format。
 */

const descriptor = ({ protocol = 'openai', auth, headers, baseUrl = 'https://gateway.example/v1', model = 'm-1' } = {}) => ({
  id: 'acme-gateway', label: 'Acme 网关', kind: 'api', custom: true, editable: true,
  protocol,
  baseUrl,
  chatBaseUrl: baseUrl,
  chatModel: model,
  auth: auth || (protocol === 'anthropic' ? 'x-api-key' : 'bearer'),
  headers: headers || (protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
  models: [],
});

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const chatPayload = JSON.stringify({ reply: '你好', questions: [], requirementSuggestions: [], bomDraft: null });

test('Anthropic：POST {base}/messages，x-api-key + anthropic-version，system 顶层字段', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return response(200, { model: 'claude-sonnet-4', content: [{ type: 'text', text: chatPayload }] });
  };
  const result = await completeJson({
    providerId: 'acme-gateway', provider: descriptor({ protocol: 'anthropic', model: 'claude-sonnet-4' }),
    key: 'sk-ant-secret', protocol: 'anthropic', auth: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' },
    maxTokens: 2400, instructions: '你是测试助手', input: '你好', schema: { type: 'object' },
    history: [{ role: 'user', content: '上一轮问题' }, { role: 'assistant', content: '上一轮回答' }],
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gateway.example/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-secret');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].headers.authorization, undefined, 'Anthropic 不走 Bearer');
  assert.ok(!calls[0].url.includes('sk-ant-secret'), 'Key 绝不能进 URL');

  const payload = calls[0].body;
  assert.deepEqual(Object.keys(payload).sort(), ['max_tokens', 'messages', 'model', 'system', 'temperature']);
  assert.equal(payload.model, 'claude-sonnet-4');
  assert.equal(payload.max_tokens, 2400);
  assert.equal(payload.temperature, 0.2);
  assert.match(payload.system, /你是测试助手/);
  assert.match(payload.system, /JSON Schema/, 'Schema 提示词必须保留（Anthropic 没有 response_format）');
  assert.equal('response_format' in payload, false);
  assert.equal(payload.messages.length, 3, '历史两轮 + 本轮');
  assert.deepEqual(payload.messages[0], { role: 'user', content: '上一轮问题' });
  assert.deepEqual(payload.messages[1], { role: 'assistant', content: '上一轮回答' });
  assert.equal(payload.messages[2].role, 'user');
  assert.equal(payload.messages[2].content, '你好', '没有图片时 content 仍是字符串');

  assert.deepEqual(result.json, { reply: '你好', questions: [], requirementSuggestions: [], bomDraft: null });
  assert.equal(result.model, 'claude-sonnet-4');
  assert.equal(result.protocol, 'anthropic');
});

test('Anthropic：图片按 base64 source 块内联，多文本块按序拼接后解析 JSON', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return response(200, {
      model: 'claude-sonnet-4',
      content: [{ type: 'thinking', thinking: '内部推理' }, { type: 'text', text: '```json\n{"status":"ready"}\n```' }],
    });
  };
  const result = await completeJson({
    provider: descriptor({ protocol: 'anthropic', model: 'claude-sonnet-4' }), key: 'sk-ant',
    protocol: 'anthropic', auth: 'x-api-key', maxTokens: 1000,
    instructions: '看图', input: '分析这张板图',
    images: [{ name: 'board.png', mime: 'image/png', dataBase64: pngBase64 }],
    fetchImpl,
  });
  const userMessage = calls[0].body.messages.at(-1);
  assert.equal(Array.isArray(userMessage.content), true);
  assert.deepEqual(userMessage.content[0], { type: 'text', text: '分析这张板图' });
  assert.deepEqual(userMessage.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } });
  // 只拼接 text 块：thinking 等其它块不能混进 JSON 解析。
  assert.deepEqual(result.json, { status: 'ready' });
  assert.equal(result.text, '```json\n{"status":"ready"}\n```');
});

test('Anthropic：401/超时映射为稳定错误码，错误消息里不含 Key', async () => {
  const unauthorized = async () => response(401, { error: { message: 'invalid x-api-key sk-ant-very-secret' } });
  await assert.rejects(() => completeJson({
    provider: descriptor({ protocol: 'anthropic' }), key: 'sk-ant-very-secret', protocol: 'anthropic', auth: 'x-api-key',
    instructions: 'x', input: 'y', fetchImpl: unauthorized,
  }), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAUTHORIZED');
    assert.equal(error.status, 401);
    assert.ok(!String(error.message).includes('sk-ant-very-secret'));
    return true;
  });

  const hanging = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await assert.rejects(() => completeJson({
    provider: descriptor({ protocol: 'anthropic' }), key: 'k', protocol: 'anthropic', instructions: 'x', input: 'y', fetchImpl: hanging,
  }), { code: 'PROVIDER_TIMEOUT' });
});

test('OpenAI 自定义：max_tokens 取 options.maxTokens，缺省回落 4000，且不发 anthropic 头', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return response(200, { choices: [{ message: { content: '{"ok":true}' } }] }); };
  const provider = descriptor({ protocol: 'openai' });

  await completeJson({ provider, providerId: 'acme-gateway', key: 'sk-openai', protocol: 'openai', auth: 'bearer', headers: {}, maxTokens: 1234, model: 'm-2', instructions: 'x', input: 'y', fetchImpl });
  assert.equal(sent[0].url, 'https://gateway.example/v1/chat/completions');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-openai');
  assert.equal(sent[0].headers['anthropic-version'], undefined);
  assert.equal(sent[0].body.max_tokens, 1234);
  assert.equal(sent[0].body.stream, false);

  await completeJson({ provider, providerId: 'acme-gateway', key: 'sk-openai', model: 'm-2', instructions: 'x', input: 'y', fetchImpl });
  assert.equal(sent[1].body.max_tokens, 4000, '未指定上限时保持既有默认值');
  assert.equal(sent[1].body.model, 'm-2');
});

test('OpenAI 自定义：图片拼成 image_url data URL 块，无图片时 user content 仍是字符串', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return response(200, { choices: [{ message: { content: '{"ok":true}' } }] }); };
  await completeJson({
    provider: descriptor(), providerId: 'acme-gateway', key: 'k', model: 'vision-model', instructions: 'x', input: '看图',
    images: [{ name: 'board.png', mime: 'image/png', dataBase64: pngBase64 }], fetchImpl,
  });
  const blocks = sent[0].body.messages.at(-1).content;
  assert.deepEqual(blocks[0], { type: 'text', text: '看图' });
  assert.deepEqual(blocks[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}` } });

  await completeJson({ provider: descriptor(), providerId: 'acme-gateway', key: 'k', model: 'text-model', instructions: 'x', input: '纯文本', fetchImpl });
  assert.equal(sent[1].body.messages.at(-1).content, '纯文本');
  assert.equal(sent[1].body.messages[0].role, 'system');
});

test('自定义 Provider：没有模型也没有平台默认模型时明确要求选择模型', async () => {
  const fetchImpl = async () => { throw new Error('不应发起请求'); };
  await assert.rejects(() => completeJson({
    provider: descriptor({ protocol: 'anthropic', model: null }), key: 'k', protocol: 'anthropic', instructions: 'x', input: 'y', fetchImpl,
  }), { code: 'PROVIDER_MODEL_REQUIRED' });
});

test('缺少描述符时仍按内置声明表解读（旧调用兼容）', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return response(200, { choices: [{ message: { content: '{"ok":true}' } }] }); };
  const result = await completeJson({ providerId: 'deepseek_api', key: 'sk-builtin', instructions: 'x', input: 'y', fetchImpl });
  assert.equal(result.json.ok, true);
  assert.equal(sent[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(sent[0].body.model, 'deepseek-chat');
});
