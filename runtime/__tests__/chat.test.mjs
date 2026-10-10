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
