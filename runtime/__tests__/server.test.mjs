import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { createRuntimeServer, readTokenFromStdin, resolveStartupToken } from '../server.mjs';

const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};

// 令牌引导只在受信任的浏览器来源上发生（开发端口或 Tauri WebView）。
// 运行时文件锁/状态文件落在状态目录：测试隔离，避免并行测试互相干扰。
process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-server-state-'));

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

  // 打开平台控制台会调起系统浏览器，属于会产生可见副作用的动作，必须同样受会话令牌保护，
  // 否则本机任意进程都能反复弹出浏览器窗口。（未授权时在路由前就被拒绝，不会真的打开浏览器。）
  const deniedConsole = await fetch(`${base}/api/providers/deepseek_api/console`, { method: 'POST', headers: { origin: 'http://127.0.0.1:4177' } });
  assert.equal(deniedConsole.status, 401);

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

test('injected shell token disables HTTP token issuance entirely (the C-03 residual risk)', async (context) => {
  // Tauri 壳层通过环境变量注入令牌时，任何本机进程都不应再能从 HTTP 领到令牌，
  // 即使它伪造了受信任的 Origin —— 这正是“本机同用户进程可伪造 Origin”的收口。
  const injected = 'shell-injected-token-0123456789abcdef';
  const { server, httpTokenIssuance } = createRuntimeServer({ keychain: fakeKeychain, runtimeToken: injected });
  assert.equal(httpTokenIssuance, false, 'injected mode must turn HTTP token issuance off');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const noOrigin = await (await fetch(`${base}/api/health`)).json();
  assert.equal('sessionProof' in noOrigin, false);

  // 攻击者伪造受信任 Origin 也拿不到令牌。
  const forgedOrigin = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  assert.equal('sessionProof' in forgedOrigin, false, 'Origin forgery must not yield the token when the shell owns it');

  // 只有真正持有令牌的 WebView 能通过鉴权。
  assert.equal((await fetch(`${base}/api/providers`)).status, 401);
  assert.equal((await fetch(`${base}/api/providers`, { headers: { 'x-circuitpilot-token': 'wrong-token-wrong-token' } })).status, 401);
  const authorized = await fetch(`${base}/api/providers`, { headers: { 'x-circuitpilot-token': injected } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).ok, true);

  // health 仍然公开可读（用于连通性探测），只是不再携带凭据。
  assert.equal(noOrigin.ok, true);
});

test('令牌经 stdin 管道下发：读到首行即为令牌', async () => {
  const stdin = new PassThrough();
  const pending = readTokenFromStdin({ stdin });
  stdin.write('shell-piped-token-0123456789abcdef\n');
  assert.equal(await pending, 'shell-piped-token-0123456789abcdef');
});

test('令牌经 stdin 下发：EOF 前没有换行也能读到（管道写完即关闭的情况）', async () => {
  const stdin = new PassThrough();
  const pending = readTokenFromStdin({ stdin });
  stdin.end('shell-piped-token-0123456789abcdef');
  assert.equal(await pending, 'shell-piped-token-0123456789abcdef');
});

test('stdin 一直没有数据时按超时返回空串，不挂死启动流程', async () => {
  const stdin = new PassThrough();
  assert.equal(await readTokenFromStdin({ stdin, timeoutMs: 30 }), '');
});

test('壳层声明用 stdin 传令牌却没送到时必须 fail closed（不允许退化成 HTTP 发放）', async () => {
  // 关键安全属性：退回“随机令牌 + HTTP 发放”会把已关闭的攻击面重新打开。
  const missing = await resolveStartupToken({ env: { CIRCUITPILOT_TOKEN_STDIN: '1' }, readStdin: async () => '' });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /stdin/);

  // 过短的“令牌”同样不算数（与注入令牌 >= 16 字符的下限一致）。
  const tooShort = await resolveStartupToken({ env: { CIRCUITPILOT_TOKEN_STDIN: '1' }, readStdin: async () => 'short' });
  assert.equal(tooShort.ok, false);
});

test('管道令牌优先于环境变量；没有声明用管道时回退到环境变量', async () => {
  const fromStdin = await resolveStartupToken({ env: { CIRCUITPILOT_TOKEN_STDIN: '1', CIRCUITPILOT_RUNTIME_TOKEN: 'env-token-should-lose-000' }, readStdin: async () => 'piped-token-wins-0123456789ab' });
  assert.deepEqual(fromStdin, { ok: true, runtimeToken: 'piped-token-wins-0123456789ab', source: 'stdin' });

  const fromEnv = await resolveStartupToken({ env: { CIRCUITPILOT_RUNTIME_TOKEN: 'env-token-only-0123456789ab' }, readStdin: async () => 'ignored-token-0123456789abcde' });
  assert.deepEqual(fromEnv, { ok: true, runtimeToken: 'env-token-only-0123456789ab', source: 'env' });

  // 两条通道都没有：开发模式的随机令牌 + 受信 Origin 引导，来源必须如实标注为 none。
  const neither = await resolveStartupToken({ env: {}, readStdin: async () => '' });
  assert.deepEqual(neither, { ok: true, runtimeToken: undefined, source: 'none' });
});

test('经 stdin 取得的令牌进入 Runtime 后同样关闭 HTTP 令牌发放', async () => {
  // 端到端串起来：管道 -> resolveStartupToken -> createRuntimeServer，
  // 确认新通道拿到的令牌与之前环境变量注入的令牌具有同等的安全效果。
  const stdin = new PassThrough();
  const pending = readTokenFromStdin({ stdin });
  stdin.end('piped-token-from-shell-0123456789\n');
  const resolved = await resolveStartupToken({ env: { CIRCUITPILOT_TOKEN_STDIN: '1' }, readStdin: () => pending });
  assert.equal(resolved.ok, true);

  const { server, sessionToken, httpTokenIssuance } = createRuntimeServer({ keychain: fakeKeychain, runtimeToken: resolved.runtimeToken });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal(sessionToken, 'piped-token-from-shell-0123456789');
    assert.equal(httpTokenIssuance, false);
    // 伪造受信 Origin 也领不到引导令牌。
    const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
    assert.equal(health.sessionProof, undefined);
    // 不带令牌被拒，带管道令牌可用。
    assert.equal((await fetch(`${base}/api/providers`)).status, 401);
    assert.equal((await fetch(`${base}/api/providers`, { headers: { 'x-circuitpilot-token': resolved.runtimeToken } })).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
