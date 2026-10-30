import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { ensureAgentTokenFile } from '../agent-token.mjs';

// Agent 第二认证通道的 HTTP 级契约：UI token 与 agent token 隔离，agent 只能走
// 允许的路由；写暂停/签核/设置/审批之外的敏感链路必须 fail-closed。
const ENV_KEYS = ['CIRCUITPILOT_STATE_DIR', 'CIRCUITPILOT_EVIDENCE_DIR', 'CIRCUITPILOT_AUTOMATION_DIR'];
const UI_TOKEN = 'ui-session-token-for-test';

const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};

async function start(context, { tokenFileMode } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-agent-http-'));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const dir of ['state', 'evidence', 'automation']) mkdirSync(join(root, dir), { recursive: true });
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation');
  context.after(() => {
    for (const key of ENV_KEYS) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  const tokenPath = join(root, 'agent-token.json');
  const issued = await ensureAgentTokenFile({ file: tokenPath });
  if (tokenFileMode) {
    const fs = await import('node:fs');
    fs.chmodSync(tokenPath, tokenFileMode);
  }
  const { server } = createRuntimeServer({ keychain: fakeKeychain, runtimeToken: UI_TOKEN, agentTokenPath: tokenPath });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const uiHeaders = { 'content-type': 'application/json', 'x-circuitpilot-token': UI_TOKEN };
  const agentHeaders = { 'content-type': 'application/json', 'x-circuitpilot-agent-token': issued.token };
  return { base, uiHeaders, agentHeaders, token: issued.token, tokenPath };
}

test('agent token 可读项目状态，UI token 仍可独立工作', async (context) => {
  const { base, uiHeaders, agentHeaders } = await start(context);
  const ui = await fetch(`${base}/api/project-state`, { headers: uiHeaders });
  assert.equal(ui.status, 200);
  const agent = await fetch(`${base}/api/project-state`, { headers: agentHeaders });
  assert.equal(agent.status, 200);
  assert.equal((await agent.json()).ok, true);
});

test('无 token / 错误 agent token → 401', async (context) => {
  const { base, token } = await start(context);
  const missing = await fetch(`${base}/api/project-state`);
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, 'RUNTIME_TOKEN_INVALID');
  const wrong = await fetch(`${base}/api/project-state`, { headers: { 'x-circuitpilot-agent-token': `cpa_${'0'.repeat(48)}` } });
  assert.equal(wrong.status, 401);
});

test('agent 不能改设置、签核、改写暂停；GET 写暂停仍可读', async (context) => {
  const { base, agentHeaders } = await start(context);
  const settings = await fetch(`${base}/api/settings`, { method: 'POST', headers: agentHeaders, body: JSON.stringify({ settings: {} }) });
  assert.equal(settings.status, 403);
  assert.equal((await settings.json()).error.code, 'AGENT_ROUTE_FORBIDDEN');
  const signoff = await fetch(`${base}/api/production/signoff`, { method: 'POST', headers: agentHeaders, body: JSON.stringify({}) });
  assert.equal(signoff.status, 403);
  const writeGate = await fetch(`${base}/api/write-gate`, { method: 'POST', headers: agentHeaders, body: JSON.stringify({ paused: true }) });
  assert.equal(writeGate.status, 403);
  const gateRead = await fetch(`${base}/api/write-gate`, { headers: agentHeaders });
  assert.equal(gateRead.status, 200);
});

test('agent 的 design/pcb approve 只放行 POST 精确路径，且必须确认 chat 模式', async (context) => {
  const { base, agentHeaders } = await start(context);
  for (const path of ['/api/design/approve', '/api/pcb/approve']) {
    const missing = await fetch(`${base}${path}`, { method: 'POST', headers: agentHeaders, body: JSON.stringify({}) });
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).error.code, 'AGENT_APPROVAL_CONFIRMATION_REQUIRED');

    const confirmed = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({ confirm: true, approvalMode: 'chat' }),
    });
    assert.notEqual(confirmed.status, 403, `${path} 带 confirm 后不应被路由/确认边界拒绝`);
    assert.notEqual((await confirmed.json())?.error?.code, 'AGENT_ROUTE_FORBIDDEN');
  }
});

test('agent token 文件权限过宽时 agent 通道关闭，但 UI 会话不受影响', async (context) => {
  const { base, uiHeaders, agentHeaders } = await start(context, { tokenFileMode: 0o644 });
  const agent = await fetch(`${base}/api/project-state`, { headers: agentHeaders });
  assert.equal(agent.status, 401);
  const ui = await fetch(`${base}/api/project-state`, { headers: uiHeaders });
  assert.equal(ui.status, 200);
});
