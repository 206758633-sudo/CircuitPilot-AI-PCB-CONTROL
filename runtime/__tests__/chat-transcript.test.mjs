import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChatManager } from '../chat.mjs';
import { createJsonStore } from '../store.mjs';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-chat-tr-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-chat-tr-evidence-'));
process.env.CIRCUITPILOT_PROJECT_MEMO = join(mkdtempSync(join(tmpdir(), 'cp-chat-tr-memo-')), 'memo.json');

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const readyProviders = async () => [{ id: 'codex_account', label: 'Codex账号', kind: 'cli', ready: true, authenticated: true }];
const unavailableBridge = { async discover() { return null; } };
const reply = (message) => ({ text: JSON.stringify({ reply: `收到：${message}`, questions: [], requirementSuggestions: [] }) });

function newStore() {
  return createJsonStore({ file: join(mkdtempSync(join(tmpdir(), 'cp-chat-tr-file-')), 'chat-transcripts.json'), schemaVersion: 1, initial: () => ({ sessions: {} }) });
}

test('聊天 transcript：一轮问答落盘；重启后用历史指令重建线程，而不是假装线程还在', async () => {
  const store = newStore();
  const firstCalls = [];
  const firstClient = {
    async createThread(options) { firstCalls.push(options); return 'thread-A'; },
    async runTurn({ input }) { return reply(input.includes('第一问') ? '第一答' : '后续'); },
    close() {},
  };
  const managerA = new ChatManager({ bridge: unavailableBridge, client: firstClient, providerStatus: readyProviders, transcriptStore: store });
  await managerA.send('chat-p1', { message: '第一问', context: {} });
  assert.deepEqual(managerA.transcript('chat-p1').messages.map((entry) => entry.role), ['user', 'assistant']);
  assert.match(managerA.transcript('chat-p1').messages[1].content, /第一答/);
  assert.doesNotMatch(firstCalls[0].instructions, /第一问/, '首次线程不应注入空历史');

  // 模拟 Runtime 重启：新 manager、新 client，同一份 transcript store。
  const secondCalls = [];
  const secondClient = {
    async createThread(options) { secondCalls.push(options); return 'thread-B'; },
    async runTurn({ input }) { return reply(input.includes('第二问') ? '第二答' : '后续'); },
    close() {},
  };
  const managerB = new ChatManager({ bridge: unavailableBridge, client: secondClient, providerStatus: readyProviders, transcriptStore: store });
  assert.equal(managerB.transcript('chat-p1').messages.length, 2, '重启后 transcript 仍在');
  await managerB.send('chat-p1', { message: '第二问', context: {} });
  assert.equal(secondCalls.length, 1);
  assert.match(secondCalls[0].instructions, /第一问/, '重建线程时必须带上历史用户消息');
  assert.match(secondCalls[0].instructions, /第一答/, '重建线程时必须带上历史助手答复');
  assert.deepEqual(managerB.transcript('chat-p1').messages.map((entry) => entry.role), ['user', 'assistant', 'user', 'assistant']);
});

test('聊天 transcript：reset 同时清空落盘记录（用户主动重开对话）', async () => {
  const store = newStore();
  const client = { async createThread() { return 'thread-C'; }, async runTurn() { return reply('ok'); }, close() {} };
  const manager = new ChatManager({ bridge: unavailableBridge, client, providerStatus: readyProviders, transcriptStore: store });
  await manager.send('chat-p2', { message: 'hello', context: {} });
  assert.equal(manager.transcript('chat-p2').messages.length, 2);
  manager.reset('chat-p2');
  assert.equal(manager.transcript('chat-p2').messages.length, 0);
});

test('聊天 transcript HTTP：登录后可读回；无会话令牌 401；DELETE 后为空', async (context) => {
  const store = newStore();
  const client = { async createThread() { return 'thread-D'; }, async runTurn() { return reply('HTTP答复'); }, close() {} };
  const manager = new ChatManager({ bridge: unavailableBridge, client, providerStatus: readyProviders, transcriptStore: store });
  await manager.send('chat-http', { message: 'HTTP问题', context: {} });
  const { server } = createRuntimeServer({ chat: manager });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${base}/api/chat/sessions/chat-http/transcript`, { headers: { origin: TRUSTED_ORIGIN } });
  assert.equal(unauthorized.status, 401);

  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const read = await (await fetch(`${base}/api/chat/sessions/chat-http/transcript`, { headers })).json();
  assert.equal(read.transcript.messages.length, 2);
  assert.equal(read.transcript.messages[0].content, 'HTTP问题');

  const reset = await fetch(`${base}/api/chat/sessions/chat-http`, { method: 'DELETE', headers });
  assert.equal(reset.status, 200);
  const after = await (await fetch(`${base}/api/chat/sessions/chat-http/transcript`, { headers })).json();
  assert.equal(after.transcript.messages.length, 0);
});
