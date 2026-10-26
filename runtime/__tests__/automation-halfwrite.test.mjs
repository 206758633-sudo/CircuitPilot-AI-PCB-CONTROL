import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultRecipeRegistry, validateRecipe } from '../automation/recipes.mjs';
import { runRecipe } from '../automation/runner.mjs';

const approvals = { write: true };

function recipe(overrides = {}) {
  return validateRecipe({
    id: 'half-write-demo',
    title: 'E8 半写注入测试配方',
    version: 1,
    requiredApprovals: ['write'],
    params: { existingIds: { required: true } },
    steps: [{
      id: 'write',
      action: { kind: 'api', command: 'demo.write', params: {}, allowWrite: true },
      expect: { readback: { kind: 'api', command: 'demo.read' }, assertions: [{ path: 'count', op: 'equals', value: 2 }] },
      onFail: { then: 'rollback' },
    }],
    rollback: [{ kind: 'api', command: 'demo.rollback', params: { ids: { $param: 'existingIds' } }, allowWrite: true }],
    ...overrides,
  });
}

function executors(log, { readCount = 1, writeResult = { primitiveId: 'created-pour-1' } } = {}) {
  return {
    api: async (action) => {
      log.push({ command: action.command, params: action.params, allowWrite: action.allowWrite });
      if (action.command === 'demo.write') return writeResult;
      if (action.command === 'demo.read') return { count: readCount };
      if (action.command === 'demo.rollback') return { deleted: action.params.ids };
      throw new Error(`unexpected ${action.command}`);
    },
    gui: async () => ({}),
  };
}

test('E8：写成功但读回不符（半写）⇒ onFail=rollback 自动收敛，并留 rollback 证据', async () => {
  const log = [];
  const result = await runRecipe({ recipe: recipe(), executors: executors(log), params: { existingIds: ['a', 'b'] }, approvals });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'failed');
  assert.equal(result.failedStep.stepId, 'write');
  assert.equal(result.rollback.ok, true);
  assert.deepEqual(result.rollback.failures, []);
  const rollbackCall = log.find((item) => item.command === 'demo.rollback');
  assert.deepEqual(rollbackCall.params, { ids: ['a', 'b'] });
  assert.equal(rollbackCall.allowWrite, true, '回退写命令必须显式 allowWrite，不能走只读通道');
  // 主写只执行一次：半写后绝不重放写动作。
  assert.equal(log.filter((item) => item.command === 'demo.write').length, 1);
});

test('E8：回退动作可用 $result 引用本 run 的动作结果（删除刚创建的图元）', async () => {
  const log = [];
  const withResult = recipe({
    rollback: [{ kind: 'api', command: 'demo.rollback', params: { id: { $result: 'write.primitiveId' } }, allowWrite: true }],
  });
  const result = await runRecipe({ recipe: withResult, executors: executors(log), params: { existingIds: [] }, approvals });
  assert.equal(result.state, 'failed');
  assert.equal(result.rollback.ok, true);
  assert.deepEqual(log.find((item) => item.command === 'demo.rollback').params, { id: 'created-pour-1' });
});

test('E8：回退失败 ⇒ rollback_failed（不冒充 failed，更不冒充 completed）', async () => {
  const log = [];
  const failing = {
    api: async (action) => {
      log.push({ command: action.command, params: action.params });
      if (action.command === 'demo.write') return { primitiveId: 'p1' };
      if (action.command === 'demo.read') return { count: 1 };
      if (action.command === 'demo.rollback') throw new Error('EDA delete rejected');
      throw new Error('unexpected');
    },
    gui: async () => ({}),
  };
  const result = await runRecipe({ recipe: recipe(), executors: failing, params: { existingIds: ['a'] }, approvals });
  assert.equal(result.state, 'rollback_failed');
  assert.equal(result.rollback.ok, false);
  assert.match(result.rollback.failures[0].error, /EDA delete rejected/);
});

test('E8：回退 $result 引用不存在的步骤 ⇒ 配方校验先拒绝（fail-closed 在跑之前）', () => {
  assert.throws(() => recipe({ rollback: [{ kind: 'api', command: 'demo.rollback', params: { id: { $result: 'missing-step.primitiveId' } } }] }), (error) => error.code === 'AUTOMATION_RECIPE_INVALID');
});

test('E8：pcb-create-pour v2 已登记 half-write 回退（快照差集删除）', () => {
  const recipeEntry = createDefaultRecipeRegistry().get('pcb-create-pour');
  assert.equal(recipeEntry.version, 2);
  assert.equal(recipeEntry.params.existingPourIds.required, true);
  assert.equal(recipeEntry.steps[0].onFail.then, 'rollback');
  assert.equal(recipeEntry.rollback.length, 1);
  assert.equal(recipeEntry.rollback[0].command, 'pcb.pour.deleteAdded');
  assert.equal(recipeEntry.rollback[0].allowWrite, true);
});
