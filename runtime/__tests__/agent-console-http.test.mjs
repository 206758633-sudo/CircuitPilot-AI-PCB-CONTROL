import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { ensureAgentTokenFile, readAgentToken } from '../agent-token.mjs';
import { readAgentAudit } from '../agent-console.mjs';

// Agent 控制台 HTTP 级契约：UI 可读状态/审计/轮换；Agent 只能读 status，
// 读审计与非 GET 轮换必须 403；审计只记元数据，永远不出现令牌原文。
const ENV_KEYS = ['CIRCUITPILOT_STATE_DIR', 'CIRCUITPILOT_EVIDENCE_DIR', 'CIRCUITPILOT_AUTOMATION_DIR'];
const UI_TOKEN = 'ui-session-token-for-agent-console';

const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};

const fakeDesign = {
  approve(_body) { return { approvalId: 'approval-test-1', planHash: 'plan-hash-test-1', expiresAt: new Date(Date.now() + 60_000).toISOString(), windowId: 'window-test' }; },
};

async function start(context, { withToken = true, design = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-agent-console-'));
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
  const auditPath = join(root, 'agent-audit.jsonl');
  const issued = withToken ? await ensureAgentTokenFile({ file: tokenPath }) : null;
  const { server } = createRuntimeServer({
    keychain: fakeKeychain,
    runtimeToken: UI_TOKEN,
    agentTokenPath: tokenPath,
    agentAuditFile: auditPath,
    ...(design ? { design } : {}),
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    root,
    base: `http://127.0.0.1:${server.address().port}`,
    tokenPath,
    auditPath,
    uiHeaders: { 'content-type': 'application/json', 'x-circuitpilot-token': UI_TOKEN },
    agentHeaders: { 'content-type': 'application/json', 'x-circuitpilot-agent-token': issued?.token || '' },
  };
}

async function waitFor(check, { timeoutMs = 1500, intervalMs = 20 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

const tokenLike = /cpa_[0-9a-f]{48}/;

test('UI 读状态：可用、含文件/scope/审计，绝不含 token 原文', async (context) => {
  const { base, uiHeaders, auditPath } = await start(context);
  const response = await fetch(`${base}/api/agent/status`, { headers: uiHeaders });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.agent.available, true);
  assert.match(body.agent.file, /agent-token\.json$/);
  assert.deepEqual(body.agent.scopes, ['read', 'plan', 'execute']);
  assert.match(body.agent.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Array.isArray(body.audit));
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, tokenLike);
  const auditText = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim() : '';
  if (auditText) assert.ok(!serialized.includes(auditText), 'status 不应回显审计文件全文');
});

test('令牌缺失时 status 返回 available:false + AGENT_TOKEN_MISSING，不 500', async (context) => {
  const { base, uiHeaders } = await start(context, { withToken: false });
  const response = await fetch(`${base}/api/agent/status`, { headers: uiHeaders });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.agent.available, false);
  assert.equal(body.agent.reason, 'AGENT_TOKEN_MISSING');
});

test('UI 轮换令牌：旧 token 立即 401，新 token 可用，审计记录 rotate 且不含 token', async (context) => {
  const { base, uiHeaders, agentHeaders, tokenPath, auditPath } = await start(context);
  const before = await readAgentToken(tokenPath);
  const response = await fetch(`${base}/api/agent/token/rotate`, { method: 'POST', headers: uiHeaders, body: '{}' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.agent.rotated, true);
  assert.doesNotMatch(JSON.stringify(body), tokenLike);

  const after = await readAgentToken(tokenPath);
  assert.notEqual(after.token, before.token);

  const oldUse = await fetch(`${base}/api/project-state`, { headers: agentHeaders });
  assert.equal(oldUse.status, 401);
  const newUse = await fetch(`${base}/api/project-state`, { headers: { ...agentHeaders, 'x-circuitpilot-agent-token': after.token } });
  assert.equal(newUse.status, 200);

  const events = await waitFor(async () => {
    const audit = await readAgentAudit({ auditFile: auditPath, limit: 20 });
    return audit.events.some((event) => event.kind === 'rotate' && event.actor === 'ui') ? audit.events : null;
  });
  assert.ok(events, '轮换审计应落盘');
  assert.ok(events.some((event) => event.kind === 'rotate' && event.actor === 'ui'));
  assert.doesNotMatch(readFileSync(auditPath, 'utf8'), tokenLike);
});

test('Agent 可读 status，但读 audit / 轮换 / 改设置被 403，并留下 denied 审计', async (context) => {
  const { base, agentHeaders, auditPath } = await start(context);
  const status = await fetch(`${base}/api/agent/status`, { headers: agentHeaders });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).agent.available, true);

  const audit = await fetch(`${base}/api/agent/audit`, { headers: agentHeaders });
  assert.equal(audit.status, 403);
  assert.equal((await audit.json()).error.code, 'AGENT_ROUTE_FORBIDDEN');

  const rotate = await fetch(`${base}/api/agent/token/rotate`, { method: 'POST', headers: agentHeaders, body: '{}' });
  assert.equal(rotate.status, 403);

  const settings = await fetch(`${base}/api/settings`, { method: 'POST', headers: agentHeaders, body: JSON.stringify({ settings: {} }) });
  assert.equal(settings.status, 403);

  const denied = await waitFor(async () => {
    const result = await readAgentAudit({ auditFile: auditPath, limit: 50 });
    return result.events.filter((event) => event.kind === 'denied').length >= 2 ? result.events : null;
  });
  assert.ok(denied, 'denied 审计应至少记录 audit 与 settings 两次拒绝');
  assert.ok(denied.some((event) => event.path === '/api/agent/audit' && event.status === 403));
});

test('UI 读审计：limit 生效、事件最新在前、包含 request/denied/rotate', async (context) => {
  const { base, uiHeaders, agentHeaders } = await start(context);
  // 制造一条被接受的写请求（pcb plan 是只读计划，不会碰 EDA）。
  const plan = await fetch(`${base}/api/pcb/plan`, { method: 'POST', headers: agentHeaders, body: JSON.stringify({ plan: {} }) });
  assert.equal(plan.status, 200);
  // 制造一条拒绝。
  await fetch(`${base}/api/settings`, { method: 'POST', headers: agentHeaders, body: JSON.stringify({ settings: {} }) });
  // 轮换。
  await fetch(`${base}/api/agent/token/rotate`, { method: 'POST', headers: uiHeaders, body: '{}' });

  // 审计是旁路异步写入：先等三条事件都落盘，再验证 limit/顺序。
  const all = await waitFor(async () => {
    const response = await fetch(`${base}/api/agent/audit?limit=50`, { headers: uiHeaders });
    const payload = await response.json();
    const kinds = new Set(payload.events.map((event) => event.kind));
    return kinds.has('request') && kinds.has('denied') && kinds.has('rotate') ? payload : null;
  });
  assert.ok(all, 'request/denied/rotate 三条审计应最终落盘');
  assert.ok(all.total >= 3);
  const limited = await fetch(`${base}/api/agent/audit?limit=2`, { headers: uiHeaders });
  assert.equal(limited.status, 200);
  const body = await limited.json();
  assert.equal(body.ok, true);
  assert.equal(body.events.length, 2);
  assert.ok(body.total >= 3);
  assert.ok(all.events[0].at >= all.events[all.events.length - 1].at);
});

test('Agent 对话审批成功写 approve 审计（planHash/approvalId）', async (context) => {
  const { base, agentHeaders, auditPath } = await start(context, { design: fakeDesign });
  const response = await fetch(`${base}/api/design/approve`, {
    method: 'POST',
    headers: agentHeaders,
    body: JSON.stringify({ planHash: 'plan-hash-test-1', windowId: 'window-test', confirm: true, approvalMode: 'chat' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);

  const event = await waitFor(async () => {
    const audit = await readAgentAudit({ auditFile: auditPath, limit: 20 });
    return audit.events.find((item) => item.kind === 'approve' && item.planHash === 'plan-hash-test-1') || null;
  });
  assert.ok(event, 'approve 审计应落盘');
  assert.equal(event.actor, 'agent');
  assert.equal(event.approvalId, 'approval-test-1');
});

test('Agent 未按 chat 模式确认审批 → 403 且不写 approve 审计', async (context) => {
  const { base, agentHeaders } = await start(context, { design: fakeDesign });
  const response = await fetch(`${base}/api/design/approve`, {
    method: 'POST',
    headers: agentHeaders,
    body: JSON.stringify({ planHash: 'plan-hash-test-1' }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'AGENT_APPROVAL_CONFIRMATION_REQUIRED');
});

test('UI/Agent 可看到审计 integrity；篡改审计文件后 broken 但不 500', async (context) => {
  const { base, uiHeaders, agentHeaders, auditPath } = await start(context);
  await fetch(`${base}/api/pcb/plan`, { method: 'POST', headers: agentHeaders, body: JSON.stringify({ plan: {} }) });
  const ready = await waitFor(async () => {
    const audit = await fetch(`${base}/api/agent/audit?limit=20`, { headers: uiHeaders });
    const body = await audit.json();
    return body.integrity?.ok && body.integrity.chain === 'ok' ? body : null;
  });
  assert.ok(ready, '正常写入后 integrity 应为 ok');
  assert.ok(ready.integrity.verified >= 1);

  const status = await fetch(`${base}/api/agent/status`, { headers: uiHeaders });
  const statusBody = await status.json();
  assert.equal(statusBody.auditIntegrity?.ok, true);

  // 篡改第一条事件内容，但不重算 HMAC。
  const original = readFileSync(auditPath, 'utf8');
  const lines = original.trim().split('\n');
  const first = JSON.parse(lines[0]);
  first.outcome = 'forged';
  lines[0] = JSON.stringify(first);
  writeFileSync(auditPath, `${lines.join('\n')}\n`);

  const tampered = await fetch(`${base}/api/agent/audit?limit=20`, { headers: uiHeaders });
  assert.equal(tampered.status, 200);
  const body = await tampered.json();
  assert.equal(body.integrity?.ok, false);
  assert.equal(body.integrity?.chain, 'broken');
  assert.ok(body.events.length >= 1, '即使链断也要尽量返回事件供展示');
});


test('尾部删除：删掉最后一条审计记录 → /api/agent/audit integrity broken/head-ahead，status 同步不 500', async (context) => {
  const { root, base, uiHeaders, agentHeaders, auditPath } = await start(context);
  await fetch(`${base}/api/pcb/plan`, { method: 'POST', headers: agentHeaders, body: JSON.stringify({ plan: {} }) });

  const ready = await waitFor(async () => {
    const audit = await fetch(`${base}/api/agent/audit?limit=20`, { headers: uiHeaders });
    const body = await audit.json();
    return body.integrity?.ok && body.integrity.chain === 'ok' && body.integrity.anchored === true ? body : null;
  });
  assert.ok(ready, '正常写入后 integrity 应 ok 且 anchored=true');
  assert.ok(ready.events.length >= 1);

  // 写入后必须出现 head 锚点文件，内容与 integrity.headSeq/headHash 一致。
  const headPath = join(root, 'agent-audit.head.json');
  assert.equal(existsSync(headPath), true);
  const head = JSON.parse(readFileSync(headPath, 'utf8'));
  assert.equal(head.seq, ready.integrity.headSeq);
  assert.equal(head.hash, ready.integrity.headHash);

  // 删除最后一条完整记录（仅保留其之前的行）。
  const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
  const removedSeq = JSON.parse(lines[lines.length - 1]).seq;
  writeFileSync(auditPath, lines.length > 1 ? `${lines.slice(0, -1).join('\n')}\n` : '', 'utf8');

  const tampered = await fetch(`${base}/api/agent/audit?limit=20`, { headers: uiHeaders });
  assert.equal(tampered.status, 200, '审计链 broken 也不能 500');
  const body = await tampered.json();
  assert.equal(body.integrity?.ok, false);
  assert.equal(body.integrity?.chain, 'broken');
  assert.equal(body.integrity?.reason, 'head-ahead');
  assert.equal(body.integrity?.anchored, false);
  assert.equal(body.integrity?.headSeq, removedSeq);

  const status = await fetch(`${base}/api/agent/status`, { headers: uiHeaders });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.auditIntegrity?.ok, false);
  assert.equal(statusBody.auditIntegrity?.chain, 'broken');
  assert.equal(statusBody.auditIntegrity?.reason, 'head-ahead');
});
