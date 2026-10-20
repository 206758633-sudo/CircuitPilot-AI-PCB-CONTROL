import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-g3-state-'));
process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(tmpdir(), `cp-g3-drc-${process.pid}.json`);
process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmpdir(), `cp-g3-memo-${process.pid}.json`);
delete process.env.CIRCUITPILOT_ALLOW_GUI_EVAL;

const keychain = { async configured() { return false; }, async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; }, async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); }, async remove() { return { configured: false }; } };
const bridge = { port: 1, selectedWindowId: null, async discover() { return { port: 1 }; }, async windows() { return { windows: [], selectedWindowId: null, selectionRequired: true }; }, async execute() { throw Object.assign(new Error('离线'), { code: 'EDA_OFFLINE' }); } };
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

async function start() {
  const { server } = createRuntimeServer({ keychain, bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const post = async (path, body, withToken = true) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: withToken ? headers : { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { server, post };
}

test('G3：GUI eval（任意 JS 注入）默认被 403 GUI_EVAL_DISABLED 拒绝', async (context) => {
  const { server, post } = await start();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await post('/api/eda/gui/execute', { action: 'eval', params: { expression: 'require("fs").readFileSync("/etc/passwd")' } });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'GUI_EVAL_DISABLED');
  assert.match(result.body.error.message, /默认禁用/);
});

test('G3：GUI 未知动作被白名单拒绝（不落到任意代码执行）', async (context) => {
  const { server, post } = await start();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await post('/api/eda/gui/execute', { action: 'execShell', params: { command: 'rm -rf /' } });
  assert.ok(result.status >= 400 && result.status < 500, `期望 4xx，实际 ${result.status}`);
  assert.equal(result.body.error.code, 'EDA_GUI_ACTION_NOT_ALLOWED');
  const details = result.body.error.details || result.body.error;
  assert.ok(Array.isArray(details?.allowed), JSON.stringify(result.body));
  assert.ok(!details.allowed.includes('execShell'));
});

test('G3：GUI 动作路由仍要求 Runtime 会话令牌（无令牌 401）', async (context) => {
  const { server, post } = await start();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await post('/api/eda/gui/execute', { action: 'state' }, false);
  assert.equal(result.status, 401);
});
