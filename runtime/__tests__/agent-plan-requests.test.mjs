/**
 * task-40：计划级待审批队列（PlanRequestStore + HTTP 路由 + design/pcb approve 消费）。
 *
 * 覆盖：
 *   - Store：create/list/decide/expire/consume/binding mismatch/持久化/容量/字段白名单/损坏 fail-closed；
 *   - HTTP：Agent POST 创建、Agent GET/decision 403、UI GET/decision、confirm、审计；
 *   - design/pcb approve 带 approvalRequestId：成功消费、绑定 mismatch、manager 失败回滚、消费失败撤销 token；
 *   - 旧对话审批路径（不带 approvalRequestId）行为不变；
 *   - 状态文件损坏时 server 对相关路由 fail-closed（503），不伪装空队列。
 *
 * 使用真实 PlanRequestStore + 真实 createRuntimeServer（临时 state/token），design/pcb 用 fake manager，
 * 不启动真实 EDA/Bridge、不重启 4178。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRuntimeServer } from '../server.mjs';
import { ensureAgentTokenFile } from '../agent-token.mjs';
import { readAgentAudit } from '../agent-console.mjs';
import { PLAN_REQUEST_CODES, PlanRequestStore } from '../plan-requests.mjs';
import { DesignManager, normalizePlan } from '../design.mjs';

const ENV_KEYS = ['CIRCUITPILOT_STATE_DIR', 'CIRCUITPILOT_EVIDENCE_DIR', 'CIRCUITPILOT_AUTOMATION_DIR'];
const UI_TOKEN = 'ui-session-token-for-plan-requests';
const TOKEN_LIKE = /cpa_[0-9a-f]{48}/;

const reviewedNetlistPlan = {
  kind: 'reviewed-netlist',
  nets: ['3V3', 'GND'],
  operations: [
    { type: 'component.create', args: { component: { libraryUuid: 'lib-mcu', uuid: 'dev-mcu' }, x: 10, y: 20 } },
    { type: 'net.connect', args: { net: '3V3', endpoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } },
  ],
};
const designPlanHash = normalizePlan(reviewedNetlistPlan).planHash;

function makeStore(context, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-plan-requests-store-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { file: _ignoredFile, fileName, ...storeOptions } = options;
  const file = options.file === null ? null : join(root, fileName || 'plan-requests.json');
  const store = new PlanRequestStore({ file, ...storeOptions });
  return { store, file, root };
}

function planRequestInput(overrides = {}) {
  return {
    kind: 'design',
    planHash: 'plan-hash-1',
    targetFingerprint: 'fp-1',
    windowId: 'W-1',
    title: '计划审查',
    summary: '请确认目标与风险',
    risks: ['会写入原理图'],
    missing: [],
    ...overrides,
  };
}

const EXPECTED_FIELDS = ['consumedAt', 'createdAt', 'decidedAt', 'decisionNote', 'documentUuid', 'expiresAt', 'kind', 'missing', 'planHash', 'projectId', 'requestId', 'risks', 'status', 'summary', 'targetFingerprint', 'title', 'windowId'];

/* ------------------------------------------------------------------ */
/* Store 单测                                                          */
/* ------------------------------------------------------------------ */

test('PlanRequestStore：create 生成 apr_id、字段白名单、默认 24h、不含 token；list 默认 pending', (context) => {
  let now = 1_000_000;
  const { store, file } = makeStore(context, { now: () => now, file: 'requests.json' });
  const created = store.create(planRequestInput());
  assert.match(created.requestId, /^apr_[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(created).sort(), [...EXPECTED_FIELDS].sort());
  assert.equal(created.status, 'pending');
  assert.equal(created.createdAt, now);
  assert.equal(created.expiresAt, now + 24 * 60 * 60 * 1000);
  assert.equal(created.decidedAt, null);
  assert.equal(created.consumedAt, null);
  assert.equal(created.decisionNote, '');
  assert.equal(JSON.stringify(created).includes('token'), false);
  assert.equal(JSON.stringify(created).includes('approvalToken'), false);

  assert.equal(store.list().length, 1);
  assert.equal(store.list({ status: 'approved' }).length, 0);
  assert.equal(store.list({ status: 'all' }).length, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600, '状态文件必须是 0600');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).requests.length, 1);
});

test('PlanRequestStore：create 校验 kind/必填/长度/risks/missing/expiresAt', (context) => {
  const { store } = makeStore(context, { file: null });
  assert.throws(() => store.create(planRequestInput({ kind: 'other' })), { code: PLAN_REQUEST_CODES.INVALID });
  assert.throws(() => store.create(planRequestInput({ planHash: '' })), { code: PLAN_REQUEST_CODES.INVALID });
  assert.throws(() => store.create(planRequestInput({ planHash: 'x'.repeat(129) })), { code: PLAN_REQUEST_CODES.INVALID });
  assert.throws(() => store.create(planRequestInput({ targetFingerprint: '' })), { code: PLAN_REQUEST_CODES.INVALID });
  assert.throws(() => store.create(planRequestInput({ windowId: 'x'.repeat(257) })), { code: PLAN_REQUEST_CODES.INVALID });
  assert.throws(() => store.create(planRequestInput({ title: 'x'.repeat(501) })), { code: PLAN_REQUEST_CODES.INVALID });
  assert.throws(() => store.create(planRequestInput({ summary: 'x'.repeat(2001) })), { code: PLAN_REQUEST_CODES.INVALID });
  assert.throws(() => store.create(planRequestInput({ risks: Array.from({ length: 21 }, (_, i) => `r${i}`) })), { code: PLAN_REQUEST_CODES.INVALID });
  assert.throws(() => store.create(planRequestInput({ missing: ['x'.repeat(301)] })), { code: PLAN_REQUEST_CODES.INVALID });
  const now = store.nowMs();
  assert.throws(() => store.create(planRequestInput({ expiresAt: now - 1 })), { code: PLAN_REQUEST_CODES.INVALID });
  assert.throws(() => store.create(planRequestInput({ expiresAt: now + 7 * 24 * 60 * 60 * 1000 + 1 })), { code: PLAN_REQUEST_CODES.INVALID });
  const customExpiry = store.create(planRequestInput({ expiresAt: now + 60_000 }));
  assert.equal(customExpiry.expiresAt, now + 60_000);
});

test('PlanRequestStore：list 排序/过滤、decide 只改记录且一次性', (context) => {
  let now = 1_000_000;
  const { store } = makeStore(context, { now: () => now, file: null });
  const first = store.create(planRequestInput({ title: 'first' }));
  now += 10;
  const second = store.create(planRequestInput({ title: 'second' }));
  assert.deepEqual(store.list().map((row) => row.requestId), [first.requestId, second.requestId]);
  assert.equal(store.list({ limit: 1 }).length, 1);

  const approved = store.decide(first.requestId, { decision: 'approve', note: '可以执行' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decidedAt, now);
  assert.equal(approved.decisionNote, '可以执行');
  assert.equal(store.list({ status: 'pending' }).length, 1);
  assert.equal(store.list({ status: 'approved' })[0].requestId, first.requestId);
  assert.throws(() => store.decide(first.requestId, { decision: 'reject' }), { code: PLAN_REQUEST_CODES.ALREADY_DECIDED });
  const rejected = store.decide(second.requestId, { decision: 'reject' });
  assert.equal(rejected.status, 'rejected');
  assert.throws(() => store.decide(second.requestId, { decision: 'approve' }), { code: PLAN_REQUEST_CODES.ALREADY_DECIDED });
  assert.throws(() => store.decide('apr_0000000000000000', { decision: 'approve' }), { code: PLAN_REQUEST_CODES.NOT_FOUND });
  assert.throws(() => store.decide(first.requestId, { decision: 'maybe' }), { code: PLAN_REQUEST_CODES.ALREADY_DECIDED });
});

test('PlanRequestStore：过期请求不可决定/消费且不出现在 list', (context) => {
  let now = 1_000_000;
  const { store } = makeStore(context, { now: () => now, file: null });
  const request = store.create(planRequestInput({ expiresAt: now + 1_000 }));
  now += 1_001;
  assert.deepEqual(store.list({ status: 'all' }), []);
  assert.throws(() => store.decide(request.requestId, { decision: 'approve' }), { code: PLAN_REQUEST_CODES.EXPIRED, status: 409 });
  assert.throws(() => store.consumeApproved({ requestId: request.requestId, kind: 'design', planHash: 'plan-hash-1', targetFingerprint: 'fp-1', windowId: 'W-1' }), { code: PLAN_REQUEST_CODES.EXPIRED });
});

test('PlanRequestStore：consumeApproved 一次性且绑定必须完全一致（kind/planHash/target/window）', (context) => {
  const { store } = makeStore(context, { file: null });
  const request = store.create(planRequestInput());
  assert.throws(() => store.consumeApproved({ requestId: request.requestId, kind: 'design', planHash: 'plan-hash-1', targetFingerprint: 'fp-1', windowId: 'W-1' }), { code: PLAN_REQUEST_CODES.NOT_APPROVED });
  store.decide(request.requestId, { decision: 'approve' });

  for (const mismatch of [
    { kind: 'pcb' },
    { planHash: 'other-plan' },
    { targetFingerprint: 'other-fp' },
    { windowId: 'other-window' },
  ]) {
    assert.throws(
      () => store.consumeApproved({ requestId: request.requestId, kind: 'design', planHash: 'plan-hash-1', targetFingerprint: 'fp-1', windowId: 'W-1', ...mismatch }),
      { code: PLAN_REQUEST_CODES.BINDING_MISMATCH, status: 409 },
      `binding mismatch ${JSON.stringify(mismatch)} 必须被拒绝`,
    );
  }
  assert.equal(store.get(request.requestId).status, 'approved', '绑定不一致不得消费');

  const consumed = store.consumeApproved({ requestId: request.requestId, kind: 'design', planHash: 'plan-hash-1', targetFingerprint: 'fp-1', windowId: 'W-1' });
  assert.equal(consumed.status, 'consumed');
  assert.ok(consumed.consumedAt > 0);
  assert.throws(
    () => store.consumeApproved({ requestId: request.requestId, kind: 'design', planHash: 'plan-hash-1', targetFingerprint: 'fp-1', windowId: 'W-1' }),
    { code: PLAN_REQUEST_CODES.ALREADY_CONSUMED },
  );
  assert.throws(() => store.consumeApproved({ requestId: 'apr_ffffffffffffffff', kind: 'design', planHash: 'x', targetFingerprint: 'x', windowId: 'x' }), { code: PLAN_REQUEST_CODES.NOT_FOUND });
});

test('PlanRequestStore：持久化重启保留、损坏 fail-closed、容量淘汰只删 expired/consumed/rejected', (context) => {
  let now = 1_000_000;
  const root = mkdtempSync(join(tmpdir(), 'cp-plan-requests-persist-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'requests.json');
  const store = new PlanRequestStore({ file, now: () => now, maxEntries: 2 });
  const first = store.create(planRequestInput({ title: 'kept' }));
  store.decide(first.requestId, { decision: 'approve' });

  const reloaded = new PlanRequestStore({ file, now: () => now, maxEntries: 2 });
  assert.equal(reloaded.get(first.requestId).status, 'approved');
  assert.equal(reloaded.list({ status: 'approved' }).length, 1);

  // 容量：两个 pending 已满，第三个必须 CAPACITY（没有可淘汰记录）。
  const second = reloaded.create(planRequestInput({ title: 'second' }));
  assert.throws(() => reloaded.create(planRequestInput({ title: 'third' })), { code: PLAN_REQUEST_CODES.CAPACITY, status: 409 });
  // reject 一个 → 可淘汰，再创建成功。
  reloaded.decide(second.requestId, { decision: 'reject' });
  const third = reloaded.create(planRequestInput({ title: 'third' }));
  assert.equal(third.status, 'pending');
  assert.equal(reloaded.list({ status: 'all' }).length, 2);
  assert.ok(!reloaded.list({ status: 'all' }).some((row) => row.requestId === second.requestId), 'rejected 先被淘汰');

  // 损坏文件：构造必须 fail-closed（不能静默空队列）。
  writeFileSync(file, '{not json');
  assert.throws(() => new PlanRequestStore({ file, now: () => now }), { code: PLAN_REQUEST_CODES.STORE_CORRUPT });
});

/* ------------------------------------------------------------------ */
/* HTTP 集成                                                           */
/* ------------------------------------------------------------------ */

function makeFakeManager({ planHash = 'plan-hash-1', fail = null } = {}) {
  const calls = [];
  const revoked = [];
  return {
    calls,
    revoked,
    approvals: { revoke(token) { revoked.push(token); return { cancelled: true }; } },
    approve(body) {
      calls.push(body);
      if (fail) throw fail;
      return {
        token: `approval-token-${planHash}-${calls.length}`,
        planHash,
        targetFingerprint: typeof body?.targetFingerprint === 'string' ? body.targetFingerprint : null,
        windowId: typeof body?.windowId === 'string' ? body.windowId : null,
        approvalId: `approval-${calls.length}`,
        expiresAt: Date.now() + 60_000,
      };
    },
  };
}

async function start(context, { design = null, pcb = null, corruptStore = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-plan-requests-http-'));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const dir of ['state', 'evidence', 'automation']) mkdirSync(join(root, dir), { recursive: true });
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation');
  if (corruptStore) writeFileSync(join(root, 'state', 'agent-plan-requests.json'), '{definitely not json');

  const tokenPath = join(root, 'agent-token.json');
  const auditPath = join(root, 'agent-audit.jsonl');
  const issued = await ensureAgentTokenFile({ file: tokenPath });
  const { server } = createRuntimeServer({
    keychain: {
      async configured() { return false; },
      async store(_id, key) { return { configured: true, hint: `••••${String(key).slice(-4)}` }; },
      async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
      async remove() { return { configured: false }; },
    },
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
    stateDir: join(root, 'state'),
    auditPath,
    base: `http://127.0.0.1:${server.address().port}`,
    uiHeaders: { 'content-type': 'application/json', 'x-circuitpilot-token': UI_TOKEN },
    agentHeaders: { 'content-type': 'application/json', 'x-circuitpilot-agent-token': issued.token },
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

const postJson = async (base, path, headers, body) => {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const getJson = async (base, path, headers) => {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await response.json() };
};
const createRequest = (base, headers, overrides = {}) => postJson(base, '/api/agent/plan-requests', headers, planRequestInput(overrides));
const decideRequest = (base, headers, requestId, decision, extra = {}) => postJson(base, `/api/agent/plan-requests/${encodeURIComponent(requestId)}/decision`, headers, { decision, confirm: true, ...extra });

test('HTTP：Agent 创建 + UI 查看/批准 + 审计；Agent GET/decision 403；design approve 消费成功且二次 409', async (context) => {
  const design = makeFakeManager({ planHash: designPlanHash });
  const { base, uiHeaders, agentHeaders, auditPath, stateDir } = await start(context, { design });

  const created = await createRequest(base, agentHeaders, { planHash: designPlanHash, targetFingerprint: 'fp-1', windowId: 'W-1' });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  const request = created.body.request;
  assert.match(request.requestId, /^apr_[0-9a-f]{16}$/);
  assert.equal(request.status, 'pending');
  assert.equal(JSON.stringify(created.body).includes('approval-token'), false);
  assert.equal(JSON.stringify(created.body).includes('approvalToken'), false);

  // Agent 只允许创建；GET/decision 仍然 403。
  assert.equal((await getJson(base, '/api/agent/plan-requests', agentHeaders)).status, 403);
  assert.equal((await postJson(base, `/api/agent/plan-requests/${request.requestId}/decision`, agentHeaders, { decision: 'approve', confirm: true })).status, 403);

  const listed = await getJson(base, '/api/agent/plan-requests?status=pending', uiHeaders);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.requests[0].requestId, request.requestId);
  assert.equal(JSON.stringify(listed.body).includes('approval-token'), false);

  // UI 决策必须 confirm=true；approve 只改队列，不签 token。
  const noConfirm = await postJson(base, `/api/agent/plan-requests/${request.requestId}/decision`, uiHeaders, { decision: 'approve' });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.error.code, PLAN_REQUEST_CODES.CONFIRM_REQUIRED);
  const decided = await decideRequest(base, uiHeaders, request.requestId, 'approve', { note: '同意' });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.request.status, 'approved');
  assert.equal(decided.body.request.decisionNote, '同意');
  assert.equal(JSON.stringify(decided.body).includes('approval-token'), false);

  const approvedList = await getJson(base, '/api/agent/plan-requests?status=approved', uiHeaders);
  assert.equal(approvedList.body.total, 1);

  // Agent 带 approvalRequestId 调 design approve：manager 收到 body 不含 approvalRequestId，请求被消费。
  const approveBody = {
    plan: reviewedNetlistPlan,
    targetFingerprint: 'fp-1',
    windowId: 'W-1',
    approvalRequestId: request.requestId,
    confirm: true,
    approvalMode: 'chat',
  };
  const approved = await postJson(base, '/api/design/approve', agentHeaders, approveBody);
  assert.equal(approved.status, 200);
  assert.ok(approved.body.approval?.token, '旧行为：design approve 仍返回 approval token 给调用方');
  assert.equal(Object.hasOwn(design.calls[0], 'approvalRequestId'), false, 'manager body 必须去掉 approvalRequestId');
  const all = await getJson(base, '/api/agent/plan-requests?status=all', uiHeaders);
  assert.equal(all.body.requests.find((row) => row.requestId === request.requestId).status, 'consumed');

  // 二次消费：409 且不再返回新 token。
  const again = await postJson(base, '/api/design/approve', agentHeaders, approveBody);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, PLAN_REQUEST_CODES.ALREADY_CONSUMED);
  assert.equal(JSON.stringify(again.body).includes('approval-token'), false);

  // 审计：创建 actor=agent/outcome=created；决策 actor=ui/outcome=approved；不含 approval token。
  const events = await waitFor(async () => {
    const audit = await readAgentAudit({ auditFile: auditPath, limit: 50 });
    const hasCreated = audit.events.some((event) => event.kind === 'request' && event.actor === 'agent' && event.outcome === 'created' && event.requestId === request.requestId);
    const hasApproved = audit.events.some((event) => event.kind === 'approve' && event.actor === 'ui' && event.outcome === 'approved' && event.requestId === request.requestId);
    return hasCreated && hasApproved ? audit.events : null;
  });
  assert.ok(events, '创建/批准审计应落盘');
  const auditText = readFileSync(auditPath, 'utf8');
  assert.equal(auditText.includes('approval-token'), false);
  assert.doesNotMatch(auditText, TOKEN_LIKE);

  const stateFile = join(stateDir, 'agent-plan-requests.json');
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).requests[0].requestId, request.requestId);
});

test('HTTP：design approve 绑定 mismatch → 409 且不消费；manager 失败 → 回滚 approved；旧路径不变', async (context) => {
  const design = makeFakeManager({ planHash: designPlanHash });
  const { base, uiHeaders, agentHeaders } = await start(context, { design });

  const a = (await createRequest(base, agentHeaders, { planHash: designPlanHash, targetFingerprint: 'fp-a', windowId: 'W-A' })).body.request;
  await decideRequest(base, uiHeaders, a.requestId, 'approve');
  const mismatch = await postJson(base, '/api/design/approve', agentHeaders, {
    plan: reviewedNetlistPlan, targetFingerprint: 'fp-OTHER', windowId: 'W-A', approvalRequestId: a.requestId, confirm: true, approvalMode: 'chat',
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, PLAN_REQUEST_CODES.BINDING_MISMATCH);
  assert.equal(design.calls.length, 0, '绑定不一致必须在 manager.approve 之前拒绝');
  assert.equal((await getJson(base, '/api/agent/plan-requests?status=all', uiHeaders)).body.requests.find((row) => row.requestId === a.requestId).status, 'approved');

  // 旧路径：不带 approvalRequestId，行为不变（manager 直接签发，不触碰任何请求）。
  const legacy = await postJson(base, '/api/design/approve', agentHeaders, { plan: reviewedNetlistPlan, targetFingerprint: 'fp-a', windowId: 'W-A', confirm: true, approvalMode: 'chat' });
  assert.equal(legacy.status, 200);
  assert.equal(Object.hasOwn(design.calls[0], 'approvalRequestId'), false);

  // manager 抛错：请求回滚到 approved，原始错误向上抛。
  const failDesign = makeFakeManager({ planHash: designPlanHash, fail: Object.assign(new Error('mock manager failed'), { code: 'MOCK_MANAGER_FAILED', status: 500 }) });
  const { base: base2, uiHeaders: ui2, agentHeaders: agent2 } = await start(context, { design: failDesign });
  const b = (await createRequest(base2, agent2, { planHash: designPlanHash, targetFingerprint: 'fp-b', windowId: 'W-B' })).body.request;
  await decideRequest(base2, ui2, b.requestId, 'approve');
  const failed = await postJson(base2, '/api/design/approve', agent2, {
    plan: reviewedNetlistPlan, targetFingerprint: 'fp-b', windowId: 'W-B', approvalRequestId: b.requestId, confirm: true, approvalMode: 'chat',
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error.code, 'MOCK_MANAGER_FAILED');
  const afterFail = (await getJson(base2, '/api/agent/plan-requests?status=all', ui2)).body.requests.find((row) => row.requestId === b.requestId);
  assert.equal(afterFail.status, 'approved', 'manager 失败必须回滚 consumed→approved');
  assert.equal(failDesign.calls.length, 1);
});

test('HTTP：approve 签发后无法消费 → 撤销刚签发的 token（不返回可用批准）', async (context) => {
  const design = makeFakeManager({ planHash: 'plan-fallback' });
  const { base, uiHeaders, agentHeaders } = await start(context, { design });
  const request = (await createRequest(base, agentHeaders, { planHash: 'plan-fallback', targetFingerprint: 'fp-1', windowId: 'W-1' })).body.request;
  await decideRequest(base, uiHeaders, request.requestId, 'approve');

  // plan 不完整（{}）→ 走“先签发再消费”的兜底路径；第一次消费成功。
  const body = { plan: {}, targetFingerprint: 'fp-1', windowId: 'W-1', approvalRequestId: request.requestId, confirm: true, approvalMode: 'chat' };
  const first = await postJson(base, '/api/design/approve', agentHeaders, body);
  assert.equal(first.status, 200);
  assert.equal(first.body.approval.planHash, 'plan-fallback');
  assert.equal((await getJson(base, '/api/agent/plan-requests?status=all', uiHeaders)).body.requests.find((row) => row.requestId === request.requestId).status, 'consumed');

  // 第二次已 consumed：仍会先签发（manager 成功），随后 consume 失败 → revoke 新 token + 409。
  const second = await postJson(base, '/api/design/approve', agentHeaders, body);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, PLAN_REQUEST_CODES.ALREADY_CONSUMED);
  assert.equal(design.revoked.length, 1, '消费失败必须撤销刚签发的 token');
  assert.equal(design.revoked[0], `approval-token-plan-fallback-2`);
});

test('HTTP：PCB approve 同样消费 approvalRequestId；UI reject/confirm 与 Agent decision 403', async (context) => {
  const pcb = makeFakeManager({ planHash: 'pcb-plan-hash' });
  const { base, uiHeaders, agentHeaders } = await start(context, { pcb });

  const request = (await createRequest(base, agentHeaders, { kind: 'pcb', planHash: 'pcb-plan-hash', targetFingerprint: 'fp-pcb', windowId: 'W-PCB' })).body.request;
  const agentDecision = await postJson(base, `/api/agent/plan-requests/${request.requestId}/decision`, agentHeaders, { decision: 'approve', confirm: true });
  assert.equal(agentDecision.status, 403);
  const noConfirm = await postJson(base, `/api/agent/plan-requests/${request.requestId}/decision`, uiHeaders, { decision: 'reject' });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.error.code, PLAN_REQUEST_CODES.CONFIRM_REQUIRED);
  const rejected = await decideRequest(base, uiHeaders, request.requestId, 'reject', { note: '目标不对' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.request.status, 'rejected');

  // approved 才能消费：rejected 请求不能用于 approve。
  const rejectedApprove = await postJson(base, '/api/pcb/approve', agentHeaders, { plan: {}, targetFingerprint: 'fp-pcb', windowId: 'W-PCB', approvalRequestId: request.requestId, confirm: true, approvalMode: 'chat' });
  assert.equal(rejectedApprove.status, 409);
  assert.equal(rejectedApprove.body.error.code, PLAN_REQUEST_CODES.NOT_APPROVED);

  const request2 = (await createRequest(base, agentHeaders, { kind: 'pcb', planHash: 'pcb-plan-hash', targetFingerprint: 'fp-pcb', windowId: 'W-PCB' })).body.request;
  await decideRequest(base, uiHeaders, request2.requestId, 'approve');
  const approved = await postJson(base, '/api/pcb/approve', uiHeaders, { plan: {}, targetFingerprint: 'fp-pcb', windowId: 'W-PCB', approvalRequestId: request2.requestId });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.approval.planHash, 'pcb-plan-hash');
  assert.equal((await getJson(base, '/api/agent/plan-requests?status=all', uiHeaders)).body.requests.find((row) => row.requestId === request2.requestId).status, 'consumed');
});

test('HTTP：真实 DesignManager + 离线 bridge 端到端消费（不是 mock approve）', async (context) => {
  const bridge = {
    port: 49_642,
    selectedWindowId: 'W-REAL',
    async discover() { return { port: 49_642 }; },
    async windows() { return { windows: [{ id: 'W-REAL' }], selectedWindowId: 'W-REAL', selectionRequired: false }; },
    listCommands() { return []; },
    async execute(id) { throw Object.assign(new Error(`离线测试不应执行 EDA 命令：${id}`), { code: 'EDA_OFFLINE' }); },
  };
  const design = new DesignManager({ bridge });
  const { base, uiHeaders, agentHeaders } = await start(context, { design });

  const request = (await createRequest(base, agentHeaders, {
    planHash: designPlanHash, targetFingerprint: 'fp-real', windowId: 'W-REAL',
  })).body.request;
  await decideRequest(base, uiHeaders, request.requestId, 'approve');
  const approved = await postJson(base, '/api/design/approve', agentHeaders, {
    plan: reviewedNetlistPlan,
    targetFingerprint: 'fp-real',
    windowId: 'W-REAL',
    approvalRequestId: request.requestId,
    confirm: true,
    approvalMode: 'chat',
  });
  assert.equal(approved.status, 200);
  assert.ok(approved.body.approval.token, '真实 manager 应签发 approval token');
  assert.equal(approved.body.approval.planHash, designPlanHash);
  assert.equal((await getJson(base, '/api/agent/plan-requests?status=all', uiHeaders)).body.requests.find((row) => row.requestId === request.requestId).status, 'consumed');
});

test('HTTP：状态文件损坏时相关路由 503（fail-closed），不伪装空队列', async (context) => {
  const { base, uiHeaders, agentHeaders } = await start(context, { corruptStore: true });
  const created = await createRequest(base, agentHeaders, {});
  assert.equal(created.status, 503);
  assert.equal(created.body.error.code, 'PLAN_REQUEST_STORE_UNAVAILABLE');
  const listed = await getJson(base, '/api/agent/plan-requests', uiHeaders);
  assert.equal(listed.status, 503);
  assert.equal(listed.body.error.code, 'PLAN_REQUEST_STORE_UNAVAILABLE');
  const approved = await postJson(base, '/api/design/approve', uiHeaders, { plan: {}, targetFingerprint: 'fp', windowId: 'W', approvalRequestId: 'apr_0000000000000000' });
  assert.equal(approved.status, 503);
  assert.equal(approved.body.error.code, 'PLAN_REQUEST_STORE_UNAVAILABLE');
});
