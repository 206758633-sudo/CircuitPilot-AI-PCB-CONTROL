import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeServer } from '../server.mjs';

// 文件锁放在状态目录：测试必须隔离，否则多个测试文件并行时会互相抢同一把锁。
process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-auto-http-state-'));

const fakeKeychain = {
  async configured() { return false; },
  async read() { throw new Error('unused'); },
};

const fakeGui = {
  async execute(action, params) {
    if (action === 'state') return { url: 'https://pro.easyeda.com/editor', text: '嘉立创EDA 原理图 PCB1', tabs: ['PCB1'] };
    if (action === 'focus') return { focused: true };
    if (action === 'screenshot') return { base64: 'AA==', bytes: 2 };
    if (action === 'clickText') return { clicked: true, text: params?.text };
    return {};
  },
};

// 可变状态：用于验证"批准绑定的是哪块板"
const bridgeState = { projectUuid: 'board-1', documentUuid: 'doc-1' };
const fakeBridge = {
  port: 49620,
  selectedWindowId: 'window-1',
  async discover() {},
  async windows() { return { selectionRequired: false, windows: [{ id: 'window-1' }] }; },
  async execute(command) {
    switch (command) {
      case 'project.current': return { ok: true, result: { uuid: bridgeState.projectUuid, data: [{ uuid: bridgeState.projectUuid, name: '测试板' }] } };
      case 'document.current': return { ok: true, result: { uuid: bridgeState.documentUuid } };
      case 'pcb.pour.rebuild': return { ok: true, result: { rebuilt: 1 } };
      case 'pcb.pours.read': return { ok: true, result: [{ primitiveId: 'pour-1' }] };
      case 'pcb.placement.read': return { ok: true, result: { components: [{ ref: 'U1' }, { ref: 'R1' }] } };
      case 'schematic.components': return { ok: true, result: [{ uuid: 's1' }, { uuid: 's2' }] };
      case 'pcb.importChanges': return { ok: true, result: { applied: true } };
      default: return { ok: true, result: {} };
    }
  },
};

async function startServer(context) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-automation-http-'));
  const previous = process.env.CIRCUITPILOT_AUTOMATION_DIR;
  process.env.CIRCUITPILOT_AUTOMATION_DIR = dir;
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge: fakeBridge, gui: fakeGui });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => {
    if (previous === undefined) delete process.env.CIRCUITPILOT_AUTOMATION_DIR;
    else process.env.CIRCUITPILOT_AUTOMATION_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const headers = { 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { base, headers, post, dir };
}

test('自动化 API：列出只读配方，跑通读回验证并落审计链', async (context) => {
  const { base, headers, post, dir } = await startServer(context);
  const recipesResponse = await fetch(`${base}/api/automation/recipes`, { headers });
  const recipes = await recipesResponse.json();
  assert.equal(recipesResponse.status, 200);
  const ids = recipes.recipes.map((recipe) => recipe.id);
  assert.ok(ids.includes('eda-read-state'));
  assert.ok(ids.includes('eda-read-project'));
  assert.ok(recipes.recipes.every((recipe) => recipe.requiredApprovals.every((scope) => ['plan', 'write', 'release'].includes(scope))));

  const stateRun = await (await post('/api/automation/run', { recipeId: 'eda-read-state' })).json();
  assert.equal(stateRun.ok, true);
  assert.equal(stateRun.run.state, 'completed');
  assert.ok(stateRun.run.journalPath.startsWith(dir));
  // 响应里的 runId 必须与 journal 里的 runId 一致：否则"用接口返回的 runId 去查审计"会 404。
  assert.equal(stateRun.runId, stateRun.run.runId);
  const byRouteIdResponse = await fetch(`${base}/api/automation/runs/${stateRun.runId}`, { headers });
  assert.equal(byRouteIdResponse.status, 200, '用响应 runId 必须能查到审计记录');
  const byRouteId = await byRouteIdResponse.json();
  assert.equal(byRouteId.run.chain.ok, true);

  const projectRun = await (await post('/api/automation/run', { recipeId: 'eda-read-project' })).json();
  assert.equal(projectRun.run.state, 'completed');

  const journalResponse = await fetch(`${base}/api/automation/runs/${stateRun.run.runId}`, { headers });
  const journal = await journalResponse.json();
  assert.equal(journalResponse.status, 200);
  assert.equal(journal.run.chain.ok, true);
  assert.ok(journal.run.entries.some((entry) => entry.phase === 'step.verified'));

  const runFile = join(dir, `${stateRun.run.runId}.jsonl`);
  assert.equal(existsSync(runFile), true);
});

test('自动化 API：读回不符时返回 failed（不是 200 completed），不产生假通过', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-automation-http-bad-'));
  const previous = process.env.CIRCUITPILOT_AUTOMATION_DIR;
  process.env.CIRCUITPILOT_AUTOMATION_DIR = dir;
  const badGui = { async execute() { return { url: 'https://example.com', text: '' }; } };
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge: fakeBridge, gui: badGui });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => {
    if (previous === undefined) delete process.env.CIRCUITPILOT_AUTOMATION_DIR;
    else process.env.CIRCUITPILOT_AUTOMATION_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const headers = { 'x-circuitpilot-token': health.sessionProof };
  const response = await fetch(`${base}/api/automation/run`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ recipeId: 'eda-read-state' }) });
  const body = await response.json();
  assert.equal(body.ok, true); // HTTP 层请求成功
  assert.equal(body.run.ok, false); // 自动化结果失败
  assert.equal(body.run.state, 'failed');
  assert.ok(body.run.failedStep.failures.length > 0);
});

test('自动化 API：未知配方 404、未知 run 404、路径穿越 runId 400', async (context) => {
  const { base, headers, post } = await startServer(context);
  const unknownRecipe = await post('/api/automation/run', { recipeId: 'no-such-recipe' });
  assert.equal(unknownRecipe.status, 404);
  assert.equal((await unknownRecipe.json()).error.code, 'AUTOMATION_RECIPE_NOT_FOUND');

  const unknownRun = await fetch(`${base}/api/automation/runs/not-a-run-xyz`, { headers });
  assert.equal(unknownRun.status, 404);
  assert.equal((await unknownRun.json()).error.code, 'AUTOMATION_RUN_NOT_FOUND');

  const traversal = await fetch(`${base}/api/automation/runs/..%2F..%2Fetc%2Fpasswd`, { headers });
  assert.equal(traversal.status, 400);
  assert.equal((await traversal.json()).error.code, 'AUTOMATION_JOURNAL_RUN_ID_INVALID');
});


test('自动化批准：写入配方必须由服务端签发批准，消费后不可复用', async (context) => {
  bridgeState.projectUuid = 'board-1';
  bridgeState.documentUuid = 'doc-1';
  const { headers, post } = await startServer(context);

  const blocked = await (await post('/api/automation/run', { recipeId: 'pcb-rebuild-pours' })).json();
  assert.equal(blocked.run.state, 'needs_approval');
  assert.deepEqual(blocked.run.missingApprovals, ['write']);

  const issued = await (await post('/api/automation/approvals', { scope: 'write', recipeId: 'pcb-rebuild-pours' })).json();
  assert.ok(issued.approval.approvalId);
  assert.match(issued.approval.fingerprint, /^[0-9a-f]{32}$/);

  const ran = await (await post('/api/automation/run', { recipeId: 'pcb-rebuild-pours', approvalIds: [issued.approval.approvalId] })).json();
  assert.equal(ran.run.state, 'completed');

  // 同一批准第二次使用 → 409
  const reused = await post('/api/automation/run', { recipeId: 'pcb-rebuild-pours', approvalIds: [issued.approval.approvalId] });
  assert.equal(reused.status, 409);
  assert.equal((await reused.json()).error.code, 'AUTOMATION_APPROVAL_INVALID');
});

test('自动化批准：批准后换文档（指纹变化）执行必须被拒绝', async (context) => {
  bridgeState.projectUuid = 'board-1';
  bridgeState.documentUuid = 'doc-1';
  const { post } = await startServer(context);
  const issued = await (await post('/api/automation/approvals', { scope: 'write', recipeId: 'pcb-rebuild-pours' })).json();
  bridgeState.documentUuid = 'doc-other';
  const response = await post('/api/automation/run', { recipeId: 'pcb-rebuild-pours', approvalIds: [issued.approval.approvalId] });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'AUTOMATION_APPROVAL_INVALID');
  assert.ok(body.error.details.currentFingerprint);
});

test('自动化配方：缺必填参数返回 needs_params；非法批准作用域 400', async (context) => {
  const { post } = await startServer(context);
  const missing = await (await post('/api/automation/run', { recipeId: 'eda-open-project', params: {} })).json();
  assert.equal(missing.run.state, 'needs_params');
  assert.deepEqual(missing.run.missingParams, ['projectText']);

  const badScope = await post('/api/automation/approvals', { scope: 'admin' });
  assert.equal(badScope.status, 400);
  assert.equal((await badScope.json()).error.code, 'AUTOMATION_APPROVAL_SCOPE_INVALID');
});
