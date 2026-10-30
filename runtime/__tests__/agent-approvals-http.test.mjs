/**
 * task-37：UI 待执行批准队列 HTTP 级契约。
 *
 * 覆盖：
 *   - GET /api/agent/approvals（仅 UI）：合并 design/pcb、kind 标注、公开字段白名单、无 token/tokenDigest；
 *   - Agent 令牌对 GET/POST /api/agent/* 默认 403（不加入 AGENT_PUBLIC_ROUTES）；
 *   - POST /api/agent/approvals/:approvalId/revoke：成功 200、二次 404、已用/过期 409、非法 id 不 500；
 *   - UI 审计 kind=approve/actor=ui/outcome=revoked 且审计文件不含令牌/摘要；
 *   - manager 缺 approvals.list / list 抛错时降级为空列表（不 500）。
 *
 * 使用真实 ApprovalStore（design.mjs）+ 真实 createRuntimeServer（临时 state 目录、fake keychain），
 * 不启动真实 EDA/Bridge，不重启 4178。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRuntimeServer } from '../server.mjs';
import { ensureAgentTokenFile } from '../agent-token.mjs';
import { readAgentAudit } from '../agent-console.mjs';
import { ApprovalStore } from '../design.mjs';

const ENV_KEYS = ['CIRCUITPILOT_STATE_DIR', 'CIRCUITPILOT_EVIDENCE_DIR', 'CIRCUITPILOT_AUTOMATION_DIR'];
const UI_TOKEN = 'ui-session-token-for-agent-approvals';
const TOKEN_LIKE = /cpa_[0-9a-f]{48}/;

const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};

async function start(context, { design = null, pcb = null, withToken = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-agent-approvals-'));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const dir of ['state', 'evidence', 'automation']) mkdirSync(join(root, dir), { recursive: true });
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation');

  const tokenPath = join(root, 'agent-token.json');
  const auditPath = join(root, 'agent-audit.jsonl');
  const issued = withToken ? await ensureAgentTokenFile({ file: tokenPath }) : null;
  const { server } = createRuntimeServer({
    keychain: fakeKeychain,
    runtimeToken: UI_TOKEN,
    agentTokenPath: tokenPath,
    agentAuditFile: auditPath,
    ...(design ? { design } : {}),
    ...(pcb ? { pcb } : {}),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // 清理顺序：先关 server → 等 recordAgentAudit 的异步 append 落盘 → 恢复 env → 删临时目录。
  // 否则测试结束后仍在飞的审计 append 会在 rm 之后把目录重新建出来（临时目录残留）。
  context.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    base: `http://127.0.0.1:${server.address().port}`,
    tokenPath,
    auditPath,
    uiHeaders: { 'content-type': 'application/json', 'x-circuitpilot-token': UI_TOKEN },
    agentHeaders: { 'content-type': 'application/json', 'x-circuitpilot-agent-token': issued?.token || '' },
  };
}

async function waitFor(check, { timeoutMs = 2_000, intervalMs = 20 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

function issuePlan(store, { planHash = 'plan-hash-1', targetFingerprint = 'fp-1', windowId = 'win-1' } = {}) {
  return store.issue({ planHash, targetFingerprint, windowId, steps: [] });
}

const listApprovals = async (base, headers) => {
  const response = await fetch(`${base}/api/agent/approvals`, { headers });
  return { status: response.status, body: await response.json() };
};

const revokeApproval = async (base, headers, approvalId) => {
  const response = await fetch(`${base}/api/agent/approvals/${encodeURIComponent(approvalId)}/revoke`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  return { status: response.status, body: await response.json() };
};

test('UI 队列生命周期：issue → list 1 条无 token → Agent 403 → UI revoke 200 → list 空 → 二次 404 → 审计 ui/revoked', async (context) => {
  let now = 1_000_000;
  const designStore = new ApprovalStore({ ttlMs: 60_000, now: () => now });
  const issued = issuePlan(designStore);
  const [record] = designStore.service.snapshot();
  const approvalId = record.approvalId;
  const { base, auditPath, uiHeaders, agentHeaders } = await start(context, { design: { approvals: designStore } });

  // 1) UI list：合并后的公开字段，绝不含 token/tokenDigest。
  const listed = await listApprovals(base, uiHeaders);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.ok, true);
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.approvals.length, 1);
  const row = listed.body.approvals[0];
  assert.equal(row.approvalId, approvalId);
  assert.equal(row.kind, 'design');
  assert.equal(row.scope, 'plan');
  assert.deepEqual(row.bindings, record.bindings);
  assert.equal(row.note, '');
  assert.equal(row.issuedAt, record.issuedAt);
  assert.equal(row.expiresAt, record.expiresAt);
  assert.deepEqual(
    Object.keys(row).sort(),
    ['approvalId', 'bindings', 'expiresAt', 'issuedAt', 'kind', 'note', 'scope'].sort(),
    '响应字段必须严格白名单（多一个内部字段都可能泄漏）',
  );
  const listText = JSON.stringify(listed.body);
  assert.doesNotMatch(listText, TOKEN_LIKE);
  assert.equal(listText.includes(issued.token), false, 'list 不得回显 token 原文');
  assert.equal(listText.includes('tokenDigest'), false);
  assert.equal(listText.includes('cpa_'), false);

  // 2) Agent 令牌：GET 列表、POST 撤销均被 /api/agent/* 边界 403。
  const agentList = await listApprovals(base, agentHeaders);
  assert.equal(agentList.status, 403);
  assert.equal(agentList.body.error.code, 'AGENT_ROUTE_FORBIDDEN');
  const agentRevoke = await revokeApproval(base, agentHeaders, approvalId);
  assert.equal(agentRevoke.status, 403);
  assert.equal(agentRevoke.body.error.code, 'AGENT_ROUTE_FORBIDDEN');

  // 3) UI 撤销：200 + 精确响应形状；随后列表为空。
  const revoked = await revokeApproval(base, uiHeaders, approvalId);
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body, { ok: true, cancelled: true, kind: 'design', approvalId });
  assert.doesNotMatch(JSON.stringify(revoked.body), TOKEN_LIKE);

  const after = await listApprovals(base, uiHeaders);
  assert.equal(after.status, 200);
  assert.equal(after.body.total, 0);
  assert.deepEqual(after.body.approvals, []);

  // 4) 二次撤销：已不在 live 队列 → 404（不是 200，也不是 500）。
  const again = await revokeApproval(base, uiHeaders, approvalId);
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, 'APPROVAL_NOT_FOUND');

  // 5) UI 审计：kind=approve/actor=ui/outcome=revoked/approvalId，且文件不含令牌/摘要。
  const events = await waitFor(async () => {
    const audit = await readAgentAudit({ auditFile: auditPath, limit: 50 });
    return audit.events.find((event) => event.kind === 'approve'
      && event.actor === 'ui'
      && event.outcome === 'revoked'
      && event.approvalId === approvalId) ? audit.events : null;
  });
  assert.ok(events, 'UI revoke 审计应落盘');
  const event = events.find((item) => item.kind === 'approve' && item.actor === 'ui' && item.outcome === 'revoked');
  assert.equal(event.status, 200);
  assert.equal(event.method, 'POST');
  assert.match(event.path, /^\/api\/agent\/approvals\/[^/]+\/revoke$/);
  const auditText = readFileSync(auditPath, 'utf8');
  assert.doesNotMatch(auditText, TOKEN_LIKE);
  assert.equal(auditText.includes(issued.token), false, '审计不得记录令牌原文');
  assert.equal(auditText.includes('tokenDigest'), false, '审计不得记录令牌摘要');
});

test('合并 design + pcb 队列：每条标 kind，字段仅公开白名单', async (context) => {
  const designStore = new ApprovalStore({ ttlMs: 60_000 });
  const pcbStore = new ApprovalStore({ ttlMs: 60_000 });
  const designIssued = issuePlan(designStore, { planHash: 'design-plan' });
  const pcbIssued = issuePlan(pcbStore, { planHash: 'pcb-plan' });
  const { base, uiHeaders } = await start(context, {
    design: { approvals: designStore },
    pcb: { approvals: pcbStore },
  });

  const listed = await listApprovals(base, uiHeaders);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 2);
  const kinds = listed.body.approvals.map((row) => row.kind).sort();
  assert.deepEqual(kinds, ['design', 'pcb']);
  assert.equal(listed.body.approvals.find((row) => row.kind === 'pcb').bindings.planHash, 'pcb-plan');
  const serialized = JSON.stringify(listed.body);
  assert.equal(serialized.includes(designIssued.token), false);
  assert.equal(serialized.includes(pcbIssued.token), false);
  assert.doesNotMatch(serialized, TOKEN_LIKE);
  assert.equal(serialized.includes('tokenDigest'), false);
});

test('list 只返回 live：已使用/已过期批准不出现；按 id 撤销已用/过期走既有错误映射（409）', async (context) => {
  let now = 1_000_000;
  const designStore = new ApprovalStore({ ttlMs: 60_000, now: () => now });

  const used = issuePlan(designStore, { planHash: 'used-plan' });
  const usedId = designStore.service.snapshot().find((row) => row.bindings.planHash === 'used-plan').approvalId;
  designStore.service.resolve({ approvalIds: [usedId], requiredScopes: ['plan'] });

  const expiring = issuePlan(designStore, { planHash: 'expired-plan' });
  const expiredId = designStore.service.snapshot().find((row) => row.bindings.planHash === 'expired-plan').approvalId;
  now += 120_000; // expiring 过期；随后签发 live。

  const live = issuePlan(designStore, { planHash: 'live-plan' });
  const liveId = designStore.service.snapshot().find((row) => row.bindings.planHash === 'live-plan').approvalId;
  assert.ok(usedId && expiredId && liveId);
  assert.ok(designStore.service.snapshot().find((row) => row.approvalId === usedId)?.usedAt, 'used 记录应保留 usedAt');

  const { base, uiHeaders } = await start(context, { design: { approvals: designStore } });
  const listed = await listApprovals(base, uiHeaders);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 1, '只有 live 批准出现在待执行队列');
  assert.equal(listed.body.approvals[0].approvalId, liveId);
  assert.equal(listed.body.approvals.some((row) => row.approvalId === usedId), false);
  assert.equal(listed.body.approvals.some((row) => row.approvalId === expiredId), false);

  // 已使用/已过期不是“找不到”：沿用既有批准冲突映射（APPROVAL_INVALID→409）。
  const usedRevoke = await revokeApproval(base, uiHeaders, usedId);
  assert.equal(usedRevoke.status, 409);
  assert.equal(usedRevoke.body.error.code, 'APPROVAL_INVALID');
  const expiredRevoke = await revokeApproval(base, uiHeaders, expiredId);
  assert.equal(expiredRevoke.status, 409);
  assert.equal(expiredRevoke.body.error.code, 'APPROVAL_INVALID');

  // 真实 live 批准仍可撤销，且撤销撤销后列表为空。
  const revoked = await revokeApproval(base, uiHeaders, liveId);
  assert.equal(revoked.status, 200);
  const after = await listApprovals(base, uiHeaders);
  assert.equal(after.body.total, 0);
  assert.ok(used.token && expiring.token && live.token);
});

test('撤销不存在/非法 id：404 或 400，绝不 500', async (context) => {
  const designStore = new ApprovalStore({ ttlMs: 60_000 });
  const { base, uiHeaders } = await start(context, { design: { approvals: designStore } });

  const uuidLike = '00000000-0000-4000-8000-000000000000';
  const missing = await revokeApproval(base, uiHeaders, uuidLike);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'APPROVAL_NOT_FOUND');

  const arbitrary = await revokeApproval(base, uiHeaders, 'not-a-real-approval-id');
  assert.equal(arbitrary.status, 404);
  assert.equal(arbitrary.body.error.code, 'APPROVAL_NOT_FOUND');

  const malformed = await fetch(`${base}/api/agent/approvals/%E0%A4%A/revoke`, {
    method: 'POST',
    headers: uiHeaders,
    body: '{}',
  });
  assert.equal(malformed.status, 400, '非法 URL 编码应是 400，不能 500');
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.ok, false);
  assert.equal(malformedBody.error.code, 'APPROVAL_ID_INVALID');
});

test('缺 approvals.list / list 抛错的 manager 降级为空列表，不 500', async (context) => {
  const throwingStore = {
    list() { throw Object.assign(new Error('approval store unavailable'), { code: 'APPROVALS_UNAVAILABLE' }); },
  };
  const { base, uiHeaders } = await start(context, {
    design: {},
    pcb: { approvals: throwingStore },
  });

  const listed = await listApprovals(base, uiHeaders);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.ok, true);
  assert.equal(listed.body.total, 0);
  assert.deepEqual(listed.body.approvals, []);
});

test('没有 agent token 文件时 UI 队列仍可用、Agent 401', async (context) => {
  const designStore = new ApprovalStore({ ttlMs: 60_000 });
  issuePlan(designStore);
  const { base, uiHeaders } = await start(context, { design: { approvals: designStore }, withToken: false });

  const listed = await listApprovals(base, uiHeaders);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 1);

  const agent = await fetch(`${base}/api/agent/approvals`, { headers: { 'x-circuitpilot-agent-token': 'cpa_' + '0'.repeat(48) } });
  assert.equal(agent.status, 401);
});
