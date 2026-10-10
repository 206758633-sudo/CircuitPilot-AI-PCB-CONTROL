import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};

// 令牌引导只在受信任的浏览器来源上发生（开发端口或 Tauri WebView）。
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
async function bootstrapToken(base) {
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  return health.sessionProof;
}

test('session token is issued only to a trusted browser origin, never to an un-Origin-ed local process', async (context) => {
  const { server } = createRuntimeServer({ keychain: fakeKeychain });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const anonymous = await (await fetch(`${base}/api/health`)).json();
  assert.equal(anonymous.ok, true);
  assert.equal('sessionProof' in anonymous, false, 'a local process without an Origin header must not receive the write credential');

  const untrusted = await (await fetch(`${base}/api/health`, { headers: { origin: 'https://attacker.example' } }));
  assert.equal(untrusted.status, 403);

  const trusted = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  assert.equal(typeof trusted.sessionProof, 'string');
  assert.ok(trusted.sessionProof.length > 20);
});

test('read-only routes also require the session token', async (context) => {
  const { server } = createRuntimeServer({ keychain: fakeKeychain });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/providers', '/api/diagnostics', '/api/events']) {
    const anonymous = await fetch(`${base}${path}`);
    assert.equal(anonymous.status, 401, `${path} must not be readable without the session token`);
    const authorized = await fetch(`${base}${path}`, { headers: { 'x-circuitpilot-token': await bootstrapToken(base) } });
    assert.equal(authorized.status, 200, `${path} should succeed with the session token`);
  }
});

test('non-loopback Host headers are rejected', async (context) => {
  const { server } = createRuntimeServer({ keychain: fakeKeychain });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  // fetch() refuses to send a forged Host header, so go one level down to raw HTTP.
  const statusOf = (host) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', setHost: false, headers: { host, origin: TRUSTED_ORIGIN } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end();
  });
  assert.equal(await statusOf('attacker.example'), 403);
  assert.equal(await statusOf('attacker.example:4178'), 403);
  assert.equal(await statusOf(`127.0.0.1:${port}`), 200);
});

test('runtime binds a session proof and rejects untrusted mutations', async (context) => {
  const { server } = createRuntimeServer({ keychain: fakeKeychain, diagnostics: async () => ({ checkedAt: new Date().toISOString() }) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const healthResponse = await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } });
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.sessionProof, 'string');
  assert.ok(health.sessionProof.length > 20);

  const denied = await fetch(`${base}/api/providers/openai_api/key`, { method: 'POST', headers: { origin: 'http://127.0.0.1:4177', 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sk-not-a-real-key-1234' }) });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${base}/api/providers/openai_api/key`, { method: 'POST', headers: { origin: 'http://127.0.0.1:4177', 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof }, body: JSON.stringify({ key: 'sk-not-a-real-key-1234' }) });
  const body = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.equal(JSON.stringify(body).includes('sk-not-a-real-key'), false);
});

test('runtime rejects browser origins outside the allowlist', async (context) => {
  const { server } = createRuntimeServer({ keychain: fakeKeychain });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`, { headers: { origin: 'https://attacker.example' } });
  assert.equal(response.status, 403);
});

test('authenticated design approval returns its single-use approval token', async (context) => {
  const design = {
    approve() { return { token: 'approval-proof-1234567890', planHash: 'hash', expiresAt: Date.now() + 60_000 }; },
  };
  const { server } = createRuntimeServer({ keychain: fakeKeychain, design });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const response = await fetch(`${base}/api/design/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof },
    body: JSON.stringify({ plan: {}, targetFingerprint: 'target', windowId: 'window' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.approval.token, 'approval-proof-1234567890');
});

test('runtime exposes authenticated chat status, message and reset routes', async (context) => {
  const chat = {
    async status() { return { ready: true, activeSessions: 0 }; },
    async send(sessionId, body) { return { sessionId, reply: `收到：${body.message}`, questions: [], requirementSuggestions: [], eda: { status: 'unavailable', reason: 'test' } }; },
    reset(sessionId) { return { sessionId, reset: true, hadThread: true }; },
    close() {},
  };
  const { server } = createRuntimeServer({ keychain: fakeKeychain, chat });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = await bootstrapToken(base);
  const status = await (await fetch(`${base}/api/chat/status`, { headers: { 'x-circuitpilot-token': token } })).json();
  assert.equal(status.chat.ready, true);
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': token };
  const message = await (await fetch(`${base}/api/chat/sessions/test/messages`, { method: 'POST', headers, body: JSON.stringify({ message: 'hello' }) })).json();
  assert.equal(message.chat.reply, '收到：hello');
  const reset = await (await fetch(`${base}/api/chat/sessions/test`, { method: 'DELETE', headers })).json();
  assert.equal(reset.chat.reset, true);
});

test('runtime exposes normalized authenticated read-only EasyEDA device search', async (context) => {
  const bridge = {
    port: 49620,
    async execute(id, args) {
      assert.equal(id, 'library.device.search');
      assert.equal(args.mode, 'lcsc');
      return [{ name: 'STM32 Device', uuid: 'D1', libraryUuid: 'L1', symbol: { name: 'STM32 Symbol', uuid: 'S1', libraryUuid: 'L1' }, footprint: { name: 'LQFP48', uuid: 'F1', libraryUuid: 'L1' }, otherProperty: { manufacturer: 'ST' } }];
    },
    listCommands() { return []; },
  };
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const response = await fetch(`${base}/api/eda/library/devices/search`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof }, body: JSON.stringify({ query: 'C12345', mode: 'keyword' }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.search.mode, 'lcsc');
  assert.equal(body.search.readOnly, true);
  assert.deepEqual(body.search.candidates[0].footprint, { name: 'LQFP48', uuid: 'F1', libraryUuid: 'L1' });
});
