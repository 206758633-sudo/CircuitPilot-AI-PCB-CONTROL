import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDefaultRecipeRegistry } from '../automation/recipes.mjs';
import { decideFailureRecovery, listGoalProfiles, planOrchestration } from '../automation/orchestration.mjs';
import { createRuntimeServer } from '../server.mjs';

const recipes = createDefaultRecipeRegistry().list();

test('E10 目标 → 配方序列：网表到 DRC 计划含读/写/校验/gate，写步骤必须批准，预算通过', () => {
  const plan = planOrchestration({ goal: '把这块板从网表同步到 PCB，并跑 DRC', recipes });
  assert.equal(plan.ok, true);
  assert.equal(plan.profile.id, 'netlist-to-drc');
  const ids = plan.nodes.map((node) => node.id);
  assert.deepEqual(ids, ['read-project', 'read-document', 'write-sync', 'readback', 'gate-drc', 'gate-human-review']);
  const write = plan.nodes.find((node) => node.id === 'write-sync');
  assert.equal(write.stage, 'write');
  assert.equal(write.approvalRequired, true);
  assert.deepEqual(write.dependsOn, ['read-document']);
  const gates = plan.nodes.filter((node) => node.kind === 'gate');
  assert.deepEqual(gates.map((node) => node.gateId), ['official-drc', 'human-review']);
  assert.equal(plan.budget.usage.writeRecipes, 1);
  assert.equal(plan.budget.ok, true);
  assert.equal(plan.budget.tokenBudget, 'not-accounted');
  assert.ok(plan.decisionLog.some((item) => item.step === 'approval.policy'));
  assert.ok(plan.warnings.some((warning) => warning.includes('不自动执行')));
});

test('E10 目标无法映射 → fail-closed，给 supported 列表，不返回伪计划', () => {
  assert.throws(() => planOrchestration({ goal: '帮我把衣服烘干', recipes }), (error) => {
    assert.equal(error.code, 'E10_GOAL_UNSUPPORTED');
    assert.ok(Array.isArray(error.details.supported) && error.details.supported.length >= 4);
    return true;
  });
  assert.throws(() => planOrchestration({ goal: '   ', recipes }), (error) => error.code === 'E10_GOAL_INVALID');
  assert.ok(listGoalProfiles().some((goal) => goal.id === 'pour-create'));
});

test('E10 预算超限/配方缺失 → ok:false + blockers，不静默放行', () => {
  const overBudget = planOrchestration({ goal: '新建覆铜并读回', budget: { maxWriteRecipes: 0 }, recipes });
  assert.equal(overBudget.ok, false);
  assert.ok(overBudget.budget.blockers.some((item) => item.code === 'E10_BUDGET_EXCEEDED'));
  const missing = planOrchestration({ goal: '重建铺铜', recipes: recipes.filter((recipe) => recipe.id !== 'pcb-rebuild-pours') });
  assert.equal(missing.ok, false);
  assert.ok(missing.budget.blockers.some((item) => item.code === 'ORCHESTRATION_RECIPE_MISSING'));
  assert.throws(() => planOrchestration({ goal: '重建铺铜', budget: { maxRecipes: 0 }, recipes }), (error) => error.code === 'E10_BUDGET_INVALID');
});

test('E10 失败恢复：只读暂时性错误可重试；写步骤失败一律人工检查且禁自动重放', () => {
  const readRetry = decideFailureRecovery({ errorCode: 'EDA_JOB_BUSY', stage: 'read', nodeId: 'read-project', attempt: 1 });
  assert.equal(readRetry.decision.action, 'retry_same_node');
  assert.equal(readRetry.decision.autoReplayAllowed, false);
  assert.equal(readRetry.humanReviewRequired, false);

  const writeFail = decideFailureRecovery({ errorCode: 'READBACK_MISMATCH', stage: 'write', nodeId: 'write-sync', attempt: 1 });
  assert.equal(writeFail.decision.action, 'needs_human_inspection');
  assert.equal(writeFail.decision.requiresReapproval, true);
  assert.match(writeFail.explanation.join(''), /写动作永不自动重放/);

  const drift = decideFailureRecovery({ errorCode: 'TARGET_DRIFT', stage: 'write' });
  assert.equal(drift.decision.action, 'needs_reapproval');

  const gate = decideFailureRecovery({ errorCode: 'DRC_FAILED', stage: 'gate' });
  assert.equal(gate.decision.action, 'needs_human');
  assert.equal(gate.humanReviewRequired, true);

  const repeated = decideFailureRecovery({ errorCode: 'EDA_JOB_BUSY', stage: 'read', attempt: 5 });
  assert.equal(repeated.decision.action, 'needs_human_inspection');
  assert.throws(() => decideFailureRecovery({ errorCode: 'X', stage: 'auto' }), (error) => error.code === 'E10_STAGE_INVALID');
});

test('E10 HTTP：goals / plan / failure 端到端；非法参数 400/422', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-e10-http-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'automation'), { recursive: true });
  mkdirSync(join(root, 'evidence'), { recursive: true });
  const keys = ['CIRCUITPILOT_STATE_DIR', 'CIRCUITPILOT_AUTOMATION_DIR', 'CIRCUITPILOT_EVIDENCE_DIR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation');
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  const { server } = createRuntimeServer({ keychain: { async configured() { return false; }, async read() { throw new Error('unused'); } }, bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const headers = { 'x-circuitpilot-token': health.sessionProof, 'content-type': 'application/json' };
  const post = (path, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

  const goals = await (await fetch(`${base}/api/automation/orchestration/goals`, { headers })).json();
  assert.equal(goals.goals.length, 4);

  const planned = await post('/api/automation/orchestration/plan', { goal: '重建铺铜' });
  assert.equal(planned.status, 200);
  const planPayload = await planned.json();
  assert.equal(planPayload.plan.profile.id, 'pour-rebuild');
  assert.equal(planPayload.plan.ok, true);

  const unsupported = await post('/api/automation/orchestration/plan', { goal: '帮我做一杯咖啡' });
  assert.equal(unsupported.status, 422);
  assert.equal((await unsupported.json()).error.code, 'E10_GOAL_UNSUPPORTED');

  const decision = await post('/api/automation/orchestration/failure', { errorCode: 'EDA_JOB_BUSY', stage: 'read', attempt: 1 });
  assert.equal(decision.status, 200);
  assert.equal((await decision.json()).recovery.decision.action, 'retry_same_node');

  const badStage = await post('/api/automation/orchestration/failure', { errorCode: 'X', stage: 'auto' });
  assert.equal(badStage.status, 400);
  assert.equal((await badStage.json()).error.code, 'E10_STAGE_INVALID');
});
