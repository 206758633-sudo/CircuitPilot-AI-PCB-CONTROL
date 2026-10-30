import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RuntimeClient, resolveAgentTokenFile, defaultAgentTokenFile, AGENT_TOKEN_HEADER } from '../lib/runtime.mjs';
import { startFakeRuntime, makeTokenFile, TEST_TOKEN } from './helpers.mjs';

test('从临时 token 文件读取 token，并按契约 header 发送', async () => {
  const tokenFile = await makeTokenFile();
  const runtime = await startFakeRuntime({
    handler: (call) => ({ ok: true, seenHeader: call.headers[AGENT_TOKEN_HEADER], path: call.path }),
  });
  try {
    const client = new RuntimeClient({ baseUrl: runtime.url, tokenFile: tokenFile.file, timeoutMs: 2000 });
    const env = await client.request('GET', '/api/health');
    assert.equal(env.ok, true);
    assert.equal(env.data.seenHeader, TEST_TOKEN);
    assert.equal(env.data.path, '/api/health');
    assert.equal(runtime.calls.length, 1);
  } finally {
    await runtime.close();
    await tokenFile.cleanup();
  }
});

test('resolveAgentTokenFile：显式路径 > 环境变量 > 默认路径', async () => {
  const tokenFile = await makeTokenFile();
  const previous = process.env.CIRCUITPILOT_AGENT_TOKEN_FILE;
  try {
    assert.equal(resolveAgentTokenFile('/tmp/explicit-token.json'), '/tmp/explicit-token.json');
    process.env.CIRCUITPILOT_AGENT_TOKEN_FILE = tokenFile.file;
    assert.equal(resolveAgentTokenFile(), tokenFile.file);
    delete process.env.CIRCUITPILOT_AGENT_TOKEN_FILE;
    assert.equal(resolveAgentTokenFile(), defaultAgentTokenFile());
    assert.match(defaultAgentTokenFile(), /Library\/Application Support\/CircuitPilot\/agent-token\.json$/);
  } finally {
    if (previous === undefined) delete process.env.CIRCUITPILOT_AGENT_TOKEN_FILE;
    else process.env.CIRCUITPILOT_AGENT_TOKEN_FILE = previous;
    await tokenFile.cleanup();
  }
});

test('defaultAgentTokenFile：Windows/Linux 不落到 macOS Library 路径', () => {
  assert.equal(
    defaultAgentTokenFile({ platform: 'win32', env: { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }, home: 'C:\\Users\\t' }),
    'C:\\Users\\t\\AppData\\Roaming\\CircuitPilot\\agent-token.json',
  );
  assert.equal(
    defaultAgentTokenFile({ platform: 'linux', env: {}, home: '/home/t' }),
    '/home/t/.local/state/circuitpilot/agent-token.json',
  );
  assert.equal(
    defaultAgentTokenFile({ platform: 'linux', env: { XDG_STATE_HOME: '/var/state' }, home: '/home/t' }),
    '/var/state/circuitpilot/agent-token.json',
  );
});

test('token 文件缺失：AGENT_TOKEN_MISSING，错误含路径但不含 token', async () => {
  const client = new RuntimeClient({ baseUrl: 'http://127.0.0.1:1', tokenFile: '/tmp/cp-definitely-missing-token.json', timeoutMs: 100 });
  const env = await client.request('GET', '/api/health');
  assert.equal(env.ok, false);
  assert.equal(env.code, 'AGENT_TOKEN_MISSING');
  assert.match(env.message, /cp-definitely-missing-token\.json/);
  assert.equal(env.message.includes(TEST_TOKEN), false);
  assert.ok(env.nextActions.length > 0);
});

test('token 文件损坏：AGENT_TOKEN_INVALID（不泄露文件内容）', async () => {
  const tokenFile = await makeTokenFile({ token: 'cpa_broken' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(tokenFile.file, '{ not-json', 'utf8');
  try {
    const client = new RuntimeClient({ baseUrl: 'http://127.0.0.1:1', tokenFile: tokenFile.file, timeoutMs: 100 });
    const env = await client.request('GET', '/api/health');
    assert.equal(env.ok, false);
    assert.equal(env.code, 'AGENT_TOKEN_INVALID');
    assert.equal(env.message.includes('not-json'), false);
  } finally {
    await tokenFile.cleanup();
  }
});

test('显式 token 可用，不需要 token 文件', async () => {
  const runtime = await startFakeRuntime({
    token: 'explicit-token-123456',
    handler: () => ({ ok: true, okExplicit: true }),
  });
  try {
    const client = new RuntimeClient({ baseUrl: runtime.url, token: 'explicit-token-123456', timeoutMs: 1000 });
    const env = await client.request('GET', '/api/health');
    assert.equal(env.ok, true);
    assert.equal(env.data.okExplicit, true);
  } finally {
    await runtime.close();
  }
});

test('HTTP 401 映射 AGENT_TOKEN_INVALID；token 不出现在错误信息里', async () => {
  const runtime = await startFakeRuntime({
    token: 'server-side-token-not-shared',
    handler: () => ({ ok: true }),
  });
  try {
    const client = new RuntimeClient({ baseUrl: runtime.url, token: TEST_TOKEN, timeoutMs: 1000 });
    const env = await client.request('GET', '/api/project-state');
    assert.equal(env.ok, false);
    assert.equal(env.code, 'AGENT_TOKEN_INVALID');
    assert.equal(env.status, 401);
    assert.equal(env.message.includes(TEST_TOKEN), false);
  } finally {
    await runtime.close();
  }
});

test('错误映射保留 Runtime body code/message；响应里出现的 token 会被 redact', async () => {
  const runtime = await startFakeRuntime({
    handler: () => [409, { ok: false, error: { code: 'EDA_WRITE_PAUSED', message: `写暂停中（token=${TEST_TOKEN}）` } }],
  });
  try {
    const client = new RuntimeClient({ baseUrl: runtime.url, token: TEST_TOKEN, timeoutMs: 1000 });
    const env = await client.request('POST', '/api/design/execute', { body: { plan: {} } });
    assert.equal(env.ok, false);
    assert.equal(env.code, 'EDA_WRITE_PAUSED');
    assert.equal(env.status, 409);
    assert.equal(env.message.includes(TEST_TOKEN), false);
    assert.match(env.message, /\[REDACTED\]/);
    assert.ok(env.nextActions.some((item) => /写暂停|冲突/.test(item)));
  } finally {
    await runtime.close();
  }
});

test('请求体非 2xx 的 HTTP 404/500 也有可执行 nextActions', async () => {
  const runtime = await startFakeRuntime({
    handler: (call) => {
      if (call.path === '/api/missing') return [404, { ok: false, error: { code: 'ROUTE_NOT_FOUND', message: 'no route' } }];
      return [500, { ok: false, error: { code: 'RUNTIME_INTERNAL', message: 'boom' } }];
    },
  });
  try {
    const client = new RuntimeClient({ baseUrl: runtime.url, token: TEST_TOKEN, timeoutMs: 1000 });
    const notFound = await client.request('GET', '/api/missing');
    assert.equal(notFound.code, 'ROUTE_NOT_FOUND');
    assert.ok(notFound.nextActions.length > 0);
    const failure = await client.request('GET', '/api/boom');
    assert.equal(failure.code, 'RUNTIME_INTERNAL');
    assert.ok(failure.nextActions.length > 0);
  } finally {
    await runtime.close();
  }
});

test('超时映射 RUNTIME_TIMEOUT', async () => {
  const runtime = await startFakeRuntime({
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true };
    },
  });
  try {
    const client = new RuntimeClient({ baseUrl: runtime.url, token: TEST_TOKEN, timeoutMs: 30 });
    const env = await client.request('GET', '/api/health');
    assert.equal(env.ok, false);
    assert.equal(env.code, 'RUNTIME_TIMEOUT');
    assert.equal(env.status, 0);
  } finally {
    await runtime.close();
  }
});

test('连接失败映射 RUNTIME_UNREACHABLE', async () => {
  const runtime = await startFakeRuntime({ handler: () => ({ ok: true }) });
  const url = runtime.url;
  await runtime.close();
  const client = new RuntimeClient({ baseUrl: url, token: TEST_TOKEN, timeoutMs: 200 });
  const env = await client.request('GET', '/api/health');
  assert.equal(env.ok, false);
  assert.equal(env.code, 'RUNTIME_UNREACHABLE');
  assert.ok(env.nextActions.length > 0);
});

test('非 JSON 成功响应降级为 raw 文本', async () => {
  const runtime = await startFakeRuntime({
    handler: (_call, { res }) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('plain-text-ok');
      return undefined;
    },
  });
  try {
    const client = new RuntimeClient({ baseUrl: runtime.url, token: TEST_TOKEN, timeoutMs: 1000 });
    const env = await client.request('GET', '/api/health');
    assert.equal(env.ok, true);
    assert.equal(env.data.raw, 'plain-text-ok');
  } finally {
    await runtime.close();
  }
});

test('query 编码与路径校验', async () => {
  const runtime = await startFakeRuntime({
    handler: (call) => ({ ok: true, query: call.query }),
  });
  try {
    const client = new RuntimeClient({ baseUrl: runtime.url, token: TEST_TOKEN, timeoutMs: 1000 });
    const env = await client.request('GET', '/api/knowledge/entries', { query: { reviewState: 'approved', text: '间距 规则', skip: undefined } });
    assert.equal(env.ok, true);
    assert.equal(env.data.query.reviewState, 'approved');
    assert.equal(env.data.query.text, '间距 规则');
    assert.equal('skip' in env.data.query, false);
    const invalid = await client.request('GET', 'http://evil.example/api/health');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'INVALID_PATH');
  } finally {
    await runtime.close();
  }
});

test('响应体超过 maxResponseBytes 时拒绝，避免上下文爆炸', async () => {
  const runtime = await startFakeRuntime({
    handler: () => ({ ok: true, payload: 'x'.repeat(500) }),
  });
  try {
    const client = new RuntimeClient({ baseUrl: runtime.url, token: TEST_TOKEN, timeoutMs: 1000, maxResponseBytes: 50 });
    const env = await client.request('GET', '/api/health');
    assert.equal(env.ok, false);
    assert.equal(env.code, 'RESPONSE_TOO_LARGE');
    assert.ok(env.nextActions.length > 0);
  } finally {
    await runtime.close();
  }
});

test('token 轮换：文件 mtime 变化后会重新读取', async () => {
  const tokenFile = await makeTokenFile({ token: 'cpa_first_token_1234567890' });
  const runtime = await startFakeRuntime({
    token: 'cpa_second_token_0987654321',
    handler: () => ({ ok: true }),
  });
  try {
    const client = new RuntimeClient({ baseUrl: runtime.url, tokenFile: tokenFile.file, timeoutMs: 1000 });
    const first = await client.request('GET', '/api/health');
    assert.equal(first.ok, false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tokenFile.file, JSON.stringify({ version: 1, name: 'dsh-plugin', token: 'cpa_second_token_0987654321' }), 'utf8');
    const second = await client.request('GET', '/api/health');
    assert.equal(second.ok, true);
  } finally {
    await runtime.close();
    await tokenFile.cleanup();
  }
});

test('readToken 不把 token 写进错误/对象日志字段', async () => {
  const tokenFile = await makeTokenFile();
  const client = new RuntimeClient({ baseUrl: 'http://127.0.0.1:1', tokenFile: tokenFile.file, timeoutMs: 100 });
  const token = await client.readToken();
  assert.equal(token, TEST_TOKEN);
  assert.equal(token, await readFile(tokenFile.file, 'utf8').then((raw) => JSON.parse(raw).token));
  await tokenFile.cleanup();
});
