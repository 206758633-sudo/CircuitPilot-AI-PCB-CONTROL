import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutors } from '../automation/executors.mjs';
import { createDefaultRecipeRegistry, RECIPE_CHANGELOG } from '../automation/recipes.mjs';

test('E6：每条内置配方的当前版本都有变更记录（版本号可追溯）', () => {
  const registry = createDefaultRecipeRegistry();
  for (const recipe of registry.list()) {
    assert.ok(Number.isInteger(recipe.version) && recipe.version >= 1, `${recipe.id} 版本号必须是正整数`);
    const entry = RECIPE_CHANGELOG[recipe.id]?.[recipe.version];
    assert.ok(entry, `${recipe.id}@v${recipe.version} 缺少变更记录`);
    assert.ok(entry.note && entry.note.length >= 8, `${recipe.id}@v${recipe.version} 变更记录太短`);
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}$/);
  }
  // 历史版本必须保留（升级不删旧记录）。
  assert.ok(RECIPE_CHANGELOG['pcb-sync-from-schematic'][1]);
  assert.ok(RECIPE_CHANGELOG['pcb-sync-from-schematic'][2]);
});

test('E6：GUI clickText 支持文案 alternatives——首个文案漂移时按顺序尝试并成功', async () => {
  const calls = [];
  const gui = {
    execute: async (action, params) => {
      calls.push(params.text);
      if (params.text === '更新/转换原理图到 PCB') throw Object.assign(new Error('找不到元素'), { code: 'EDA_GUI_ELEMENT_NOT_FOUND' });
      return { clicked: params.text };
    },
  };
  const executors = createExecutors({ gui });
  const result = await executors.gui({ action: 'clickText', params: { text: '更新/转换原理图到 PCB', exact: false, alternatives: ['更新PCB'] } });
  assert.deepEqual(calls, ['更新/转换原理图到 PCB', '更新PCB']);
  assert.equal(result.clicked, '更新PCB');
});

test('E6：全部文案都找不到时给出 attemptedTexts + 能力探测提示（不盲试无关动作）', async () => {
  const gui = { execute: async () => { throw Object.assign(new Error('找不到元素'), { code: 'EDA_GUI_ELEMENT_NOT_FOUND' }); } };
  const executors = createExecutors({ gui });
  await assert.rejects(
    () => executors.gui({ action: 'clickText', params: { text: '更新/转换原理图到 PCB', exact: false, alternatives: ['更新PCB', 'Update PCB'] } }),
    (error) => error.code === 'EDA_GUI_ELEMENT_NOT_FOUND'
      && Array.isArray(error.details?.attemptedTexts)
      && error.details.attemptedTexts.length === 3
      && /菜单文案/.test(error.details.hint),
  );
});

test('E6：alternatives 里的危险文案同样被拦截（不能借变体绕过红线）', async () => {
  const gui = { execute: async () => ({ ok: true }) };
  const executors = createExecutors({ gui });
  await assert.rejects(
    () => executors.gui({ action: 'clickText', params: { text: '设计', alternatives: ['立即下单'] } }),
    (error) => error.code === 'AUTOMATION_DANGEROUS_TEXT',
  );
});
