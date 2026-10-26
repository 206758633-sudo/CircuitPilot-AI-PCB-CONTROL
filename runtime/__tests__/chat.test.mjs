import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatManager, collectEdaEvidence, enrichBomDraft, parseChatResponse, validateChatRequest } from '../chat.mjs';

const readyProviders = async () => [{ id: 'codex_account', label: 'Codex账号', kind: 'cli', ready: true, authenticated: true }];
const unavailableBridge = { async discover() { return null; } };

test('chat manager creates a real thread mapping and returns normalized suggestions', async () => {
  const calls = [];
  const client = {
    async createThread(options) { calls.push(['thread', options]); return 'thread-1'; },
    async runTurn(options) { calls.push(['turn', options]); return { text: JSON.stringify({ reply: '需要确认输入电压。', questions: ['输入电压范围是多少？'], requirementSuggestions: [{ action: 'add', targetRequirementId: null, category: '电源', name: '输入电压', value: '5', unit: 'V', kind: 'hard', blocking: true, note: '影响电源架构' }] }) }; },
    close() {},
  };
  const manager = new ChatManager({ bridge: unavailableBridge, client, providerStatus: readyProviders });
  const result = await manager.send('session-1', { message: '帮我检查缺失项', context: { project: { id: 'p1', name: '控制板' } } });
  assert.equal(result.reply, '需要确认输入电压。');
  assert.equal(result.requirementSuggestions[0].status, 'pending');
  assert.equal(result.eda.status, 'unavailable');
  assert.equal(calls.filter(([kind]) => kind === 'thread').length, 1);
  await manager.send('session-1', { message: '5V', context: {} });
  assert.equal(calls.filter(([kind]) => kind === 'thread').length, 1);
  assert.equal(manager.reset('session-1').hadThread, true);
});

test('chat manager blocks unavailable Codex before starting a thread', async () => {
  const client = { async createThread() { throw new Error('must not run'); }, close() {} };
  const manager = new ChatManager({ bridge: unavailableBridge, client, providerStatus: async () => [{ id: 'codex_account', ready: false }] });
  await assert.rejects(() => manager.send('session-1', { message: 'hello', context: {} }), (error) => error.code === 'CODEX_ACCOUNT_NOT_READY');
});

test('production planning includes the bounded user design instruction', async () => {
  let capturedInput = '';
  const client = {
    async createThread() { return 'pcb-plan-thread'; },
    async runTurn(options) { capturedInput = options.input; return { text: JSON.stringify({ status: 'blocked', explanation: '需要PCB实时证据', blockingInformation: [{ code: 'PCB_CONTEXT_REQUIRED', question: '请打开PCB文档', reason: '布局微调需要真实坐标' }], plan: null }) }; },
    close() {},
  };
  const manager = new ChatManager({ bridge: unavailableBridge, client, providerStatus: readyProviders });
  const result = await manager.productionPlan({ instruction: '把USB-C向右移动2mm', context: { project: { id: 'p1', name: '控制板' } } });
  assert.equal(result.status, 'blocked');
  assert.match(capturedInput, /把USB-C向右移动2mm/);
});

test('chat manager clears the in-flight gate after a Codex timeout', async () => {
  let turns = 0;
  const client = { async createThread() { return 'thread-timeout'; }, async runTurn() { turns += 1; if (turns === 1) throw Object.assign(new Error('timeout'), { code: 'CODEX_TIMEOUT' }); return { text: JSON.stringify({ reply: '已恢复', questions: [], requirementSuggestions: [] }) }; }, close() {} };
  const manager = new ChatManager({ bridge: unavailableBridge, client, providerStatus: readyProviders });
  await assert.rejects(() => manager.send('session-timeout', { message: 'first', context: {} }), (error) => error.code === 'CODEX_TIMEOUT');
  const retried = await manager.send('session-timeout', { message: 'retry', context: {} });
  assert.equal(retried.reply, '已恢复');
});

test('chat validation rejects oversized input and malformed model output', () => {
  assert.throws(() => validateChatRequest({ message: 'x'.repeat(4_001), context: {} }), (error) => error.code === 'CHAT_MESSAGE_TOO_LONG');
  assert.throws(() => validateChatRequest({ message: 'ok', context: { requirements: Array.from({ length: 121 }, () => ({})) } }), (error) => error.code === 'CHAT_CONTEXT_TOO_LARGE');
  assert.throws(() => parseChatResponse('{not-json'), (error) => error.code === 'CHAT_RESPONSE_INVALID');
  assert.throws(() => parseChatResponse(JSON.stringify({ reply: 'ok', questions: 'wrong', requirementSuggestions: [] })), (error) => error.code === 'CHAT_RESPONSE_INVALID');
  assert.throws(() => validateChatRequest({ message: 'ok', attachments: Array.from({ length: 5 }, () => ({ kind: 'text', name: 'a.txt', mime: 'text/plain', text: 'a' })) }), (error) => error.code === 'CHAT_ATTACHMENT_LIMIT');
  assert.throws(() => validateChatRequest({ message: 'ok', attachments: [{ kind: 'image', name: 'a.svg', mime: 'image/svg+xml', dataBase64: 'PHN2Zz4=' }] }), (error) => error.code === 'CHAT_ATTACHMENT_INVALID');
  assert.throws(() => validateChatRequest({ message: 'ok', attachments: [{ kind: 'image', name: 'empty.png', mime: 'image/png', dataBase64: '' }] }), (error) => error.code === 'CHAT_ATTACHMENT_INVALID');
  assert.throws(() => validateChatRequest({ message: 'ok', attachments: [{ kind: 'image', name: 'fake.png', mime: 'image/png', dataBase64: Buffer.from('not a png').toString('base64') }] }), (error) => error.code === 'CHAT_ATTACHMENT_INVALID');
});

test('chat sends images as local image inputs and text files as untrusted evidence', async () => {
  let turn;
  const client = { async createThread() { return 'attachment-thread'; }, async runTurn(options) { turn = options; return { text: JSON.stringify({ reply: '已分析附件', questions: [], requirementSuggestions: [], bomDraft: null }) }; }, close() {} };
  const manager = new ChatManager({ bridge: unavailableBridge, client, providerStatus: readyProviders });
  const result = await manager.send('attachments', { message: '分析', context: {}, attachments: [{ kind: 'image', name: 'board.png', mime: 'image/png', dataBase64: 'iVBORw0KGgo=' }, { kind: 'text', name: 'bom.csv', mime: 'text/csv', text: 'Ref,MPN\nU1,ABC' }] });
  assert.equal(result.reply, '已分析附件');
  assert.equal(turn.images.length, 1);
  assert.match(turn.images[0], /circuitpilot-chat-/);
  assert.match(turn.input, /bom\.csv/);
  assert.match(turn.input, /Ref,MPN/);
});

test('chat response normalizes reviewable and blocked BOM drafts', () => {
  const draft = parseChatResponse(JSON.stringify({ reply: '已生成草案', questions: [], requirementSuggestions: [], bomDraft: { status: 'draft', title: '控制板BOM', summary: '基于已确认需求', blockingQuestions: [], assumptions: ['连接器颜色待确认'], items: [{ refdes: 'U1', qty: 1, value: 'MCU', mpn: 'STM32G0', manufacturer: 'ST', package: 'LQFP-48', lcscId: '', status: 'pending', risk: '', evidence: ['MCU需求'], confidence: 'medium' }] } }));
  assert.equal(draft.bomDraft.status, 'draft');
  assert.equal(draft.bomDraft.items[0].candidates.length, 0);
  const blocked = parseChatResponse(JSON.stringify({ reply: '需要供电信息', questions: ['输入电压？'], requirementSuggestions: [], bomDraft: { status: 'blocked', title: 'BOM', summary: '', blockingQuestions: ['输入电压？'], assumptions: [], items: [] } }));
  assert.equal(blocked.bomDraft.status, 'blocked');
  assert.equal(blocked.bomDraft.items.length, 0);
});

test('BOM draft enrichment uses fixed read-only library search and keeps rows unbound', async () => {
  const calls = [];
  const draft = { status: 'draft', items: [{ id: 'row-1', mpn: 'nRF52840', lcscId: 'C190794', candidates: [] }] };
  const result = await enrichBomDraft({ port: 49620, async execute(id, args) { calls.push([id, args]); return { result: [{ name: 'nRF52840-QIAA', uuid: 'device-1', libraryUuid: 'lib-1' }] }; } }, draft);
  assert.equal(calls[0][0], 'library.device.search');
  assert.equal(calls[0][1].mode, 'lcsc');
  assert.equal(result.items[0].candidates[0].uuid, 'device-1');
  assert.equal(result.items[0].easyEdaBinding, undefined);
});

test('EDA evidence uses only fixed read commands and degrades on failure', async () => {
  const commands = [];
  const available = await collectEdaEvidence({
    async discover() { return { port: 49620 }; },
    async windows() { return { windows: [{ windowId: 'w1' }], selectedWindowId: 'w1', selectionRequired: false }; },
    async execute(id) { commands.push(id); return { id }; },
  });
  assert.equal(available.status, 'available');
  assert.deepEqual(commands.sort(), ['document.current', 'project.current']);
  const fallback = await collectEdaEvidence({ async discover() { throw new Error('bridge down'); } });
  assert.equal(fallback.status, 'unavailable');
  assert.match(fallback.reason, /bridge down/);
});

const apiKeychain = (key = 'sk-vendor') => ({ async read() { return key; }, async configured() { return Boolean(key); } });
const chatJson = JSON.stringify({ reply: '需要确认输入电压。', questions: ['输入电压范围？'], requirementSuggestions: [], bomDraft: null });

test('第三方平台 Provider：用 API Key 走 OpenAI 兼容通道，不再要求 Codex 登录', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ model: 'deepseek-chat', choices: [{ message: { content: chatJson } }] }) }; };
  try {
    const client = { async createThread() { throw new Error('Codex 不应被调用'); }, close() {} };
    const manager = new ChatManager({ keychain: apiKeychain(), bridge: unavailableBridge, client, providerStatus: readyProviders });
    const result = await manager.send('session-api', { message: '检查需求', provider: 'deepseek_api', model: 'deepseek-chat', context: { project: { id: 'p1', name: '控制板' } } });
    assert.equal(result.reply, '需要确认输入电压。');
    assert.equal(result.threadActive, false);
    assert.equal(result.provider, 'deepseek_api');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(calls[0].headers.authorization, 'Bearer sk-vendor');
    assert.equal(calls[0].body.model, 'deepseek-chat');
    // 图片附件对 DeepSeek 系模型明确拒绝，而不是静默丢弃。
    await assert.rejects(() => manager.send('session-api-2', { message: '看图', provider: 'deepseek_api', context: {}, attachments: [{ kind: 'image', name: 'a.png', mime: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }] }), { code: 'PROVIDER_IMAGE_UNSUPPORTED' });
  } finally { globalThis.fetch = originalFetch; }
});

test('第三方平台 Provider：状态只检查钥匙串，没有 Key 时明确拒绝', async () => {
  const manager = new ChatManager({ keychain: apiKeychain(''), bridge: unavailableBridge, providerStatus: readyProviders });
  const status = await manager.status('ark_api');
  assert.equal(status.ready, false);
  assert.equal(status.provider.kind, 'api');
  await assert.rejects(() => manager.send('session-no-key', { message: 'hi', provider: 'ark_api', context: {} }), { code: 'PROVIDER_CREDENTIAL_MISSING' });
  assert.equal((await manager.status('deepseek_api')).ready, false);
});

test('第三方平台 Provider：生产计划也走同一 API 通道并保留阻断结构校验', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ status: 'blocked', explanation: '需要PCB实时证据', blockingInformation: [{ code: 'PCB_CONTEXT_REQUIRED', question: '请打开PCB文档', reason: '布局微调需要真实坐标' }], plan: null }) } }] }) };
  };
  try {
    const manager = new ChatManager({ keychain: apiKeychain(), bridge: unavailableBridge, providerStatus: readyProviders });
    const result = await manager.productionPlan({ instruction: '把USB-C向右移动2mm', provider: 'siliconflow_api', model: 'deepseek-ai/DeepSeek-V3', context: { project: { id: 'p1', name: '控制板' } } });
    assert.equal(result.status, 'blocked');
    assert.equal(captured.model, 'deepseek-ai/DeepSeek-V3');
    assert.match(captured.messages[0].content, /JSON Schema/);
  } finally { globalThis.fetch = originalFetch; }
});

test('第三方平台 Provider：候选计划先用同一后端生成检索关键词，再向只读器件库取证', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const isSelection = /选型助手/.test(body.messages[0].content);
    const content = isSelection
      ? JSON.stringify({ queries: [{ block: 'mcu', query: 'STM32G0' }] })
      : JSON.stringify({ title: '候选计划', blocks: {}, nets: [], placements: [], operations: [], assumptions: ['证据不足'] });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const searched = [];
  const bridge = { async discover() { return null; }, async execute(id, args) { searched.push([id, args]); return { result: { devices: [{ name: 'STM32G0', lcscId: 'C12345' }] } }; } };
  try {
    const client = { async createThread() { throw new Error('Codex 不应被调用'); }, close() {} };
    const manager = new ChatManager({ keychain: apiKeychain(), bridge, client, providerStatus: readyProviders });
    const result = await manager.plan({ requirement: '做一个STM32控制板', provider: 'deepseek_api', model: 'deepseek-reasoner', context: { requirement: '做一个STM32控制板' } });
    assert.equal(result.title, '候选计划');
    assert.equal(calls.length, 2);
    assert.match(calls[0].messages[0].content, /选型助手/);
    assert.match(calls[1].messages[0].content, /原理图计划生成器/);
    assert.deepEqual(searched, [['library.device.search', { query: 'STM32G0', mode: 'keyword', limit: 3, page: 1 }]]);
  } finally { globalThis.fetch = originalFetch; }
});
