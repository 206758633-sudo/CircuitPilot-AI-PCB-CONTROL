import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecipeRegistry, createDefaultRecipeRegistry, validateRecipe } from './recipes.mjs';
import { createApprovalStore, fingerprintOf } from './approvals.mjs';
import { runRecipe, RUN_STATES } from './runner.mjs';
import { createExecutors } from './executors.mjs';
import { createAutomationJournal, verifyChain } from './journal.mjs';
import { evaluateAssertions, getPath, unwrapReadback } from './verify.mjs';
import {
  assertApprovals, assertEdaTarget, assertGuiActionAllowed, assertShortcutAllowed,
  findDangerousText, requiredApprovalFor,
} from './safety.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'cp-automation-'));

const readRecipe = (overrides = {}) => ({
  id: 'test-read',
  title: '读取工程',
  version: 1,
  steps: [{
    id: 'read',
    action: { kind: 'api', command: 'project.current', params: {} },
    expect: { readback: { kind: 'api', command: 'project.current' }, assertions: [{ path: 'data', op: 'nonEmpty' }] },
  }],
  ...overrides,
});

const clickRecipe = (overrides = {}) => ({
  id: 'test-click',
  title: '点击',
  version: 1,
  steps: [{
    id: 'click',
    action: { kind: 'gui', action: 'click', params: { x: 10, y: 10 } },
    expect: { readback: { kind: 'gui', action: 'state' }, assertions: [{ path: 'url', op: 'matches', value: 'easyeda' }] },
  }],
  ...overrides,
});

// —— 配方校验 ——————————————————————————————————————————————

test('内置配方全部通过校验且只含只读步骤', () => {
  const registry = createDefaultRecipeRegistry();
  const list = registry.list();
  assert.ok(list.length >= 3);
  for (const recipe of list) {
    assert.equal(recipe.schemaVersion, 1);
    for (const step of recipe.steps) {
      assert.ok(['api', 'gui', 'human'].includes(step.action.kind));
      if (step.action.kind === 'gui') assert.notEqual(step.action.action, 'eval');
    }
  }
  assert.ok(registry.summaries().some((item) => item.id === 'eda-read-state'));
});

test('配方校验 fail-closed：缺 expect / eval / 非法 id / 非法 onFail 全部拒绝', () => {
  assert.throws(() => validateRecipe({ id: 'X Bad', title: 't', steps: [] }), (error) => error.code === 'AUTOMATION_RECIPE_INVALID');
  assert.throws(() => validateRecipe({ id: 'test-ok', title: 't', steps: [] }), (error) => error.code === 'AUTOMATION_RECIPE_INVALID');
  assert.throws(() => validateRecipe({
    id: 'test-no-expect', title: 't',
    steps: [{ id: 'step', action: { kind: 'api', command: 'project.current' } }],
  }), (error) => error.code === 'AUTOMATION_RECIPE_INVALID');
  assert.throws(() => validateRecipe({
    id: 'test-eval', title: 't',
    steps: [{ id: 'step', action: { kind: 'gui', action: 'eval', params: { expression: '1' } }, expect: { readback: { kind: 'gui', action: 'state' }, assertions: [{ path: 'url', op: 'nonEmpty' }] } }],
  }), (error) => error.code === 'AUTOMATION_RECIPE_INVALID');
  assert.throws(() => validateRecipe({
    id: 'test-onfail', title: 't',
    steps: [{ id: 'step', action: { kind: 'api', command: 'project.current' }, expect: { readback: { kind: 'api', command: 'project.current' }, assertions: [{ path: 'data', op: 'nonEmpty' }] }, onFail: { then: 'explode' } }],
  }), (error) => error.code === 'AUTOMATION_RECIPE_INVALID');
  assert.throws(() => createRecipeRegistry([readRecipe({ id: 'dup-ok' }), readRecipe({ id: 'dup-ok' })]), /重复/);
});

test('GUI 写动作自动要求 write 批准；只读动作不要求', () => {
  const click = validateRecipe(clickRecipe());
  assert.deepEqual(click.requiredApprovals, ['write']);
  assert.equal(requiredApprovalFor('click'), 'write');
  assert.equal(requiredApprovalFor('state'), null);
  assert.equal(requiredApprovalFor('screenshot'), null);
});

// —— 安全层 ——————————————————————————————————————————————

test('eval 默认禁用；危险文案与危险快捷键被拒绝', () => {
  assert.throws(() => assertGuiActionAllowed('eval'), (error) => error.code === 'AUTOMATION_EVAL_DISABLED');
  assert.doesNotThrow(() => assertGuiActionAllowed('eval', { allowEval: true }));
  assert.throws(() => assertGuiActionAllowed('download'), (error) => error.code === 'AUTOMATION_GUI_ACTION_NOT_ALLOWED');
  assert.equal(findDangerousText('立即支付')?.matched, '支付');
  assert.equal(findDangerousText('打开铺铜管理器'), null);
  assert.throws(() => assertShortcutAllowed({ key: 'q', modifiers: ['meta'] }), (error) => error.code === 'AUTOMATION_SHORTCUT_FORBIDDEN');
  assert.doesNotThrow(() => assertShortcutAllowed({ key: 'a', modifiers: ['meta'] }));
  assert.doesNotThrow(() => assertShortcutAllowed({ key: 'q', modifiers: [] }));
});

test('目标锁定只允许 EDA 页面；批准作用域按值校验', () => {
  assert.doesNotThrow(() => assertEdaTarget({ url: 'https://pro.easyeda.com/editor', title: '嘉立创EDA' }));
  assert.throws(() => assertEdaTarget({ url: 'https://example.com', title: '别的东西' }), (error) => error.code === 'AUTOMATION_TARGET_NOT_EDA');
  assert.doesNotThrow(() => assertApprovals({ plan: true, write: true }, ['plan', 'write']));
  assert.throws(() => assertApprovals({ plan: true }, ['plan', 'write']), (error) => error.code === 'AUTOMATION_APPROVAL_REQUIRED');
  // 只看 === true，字符串 "true" 不算批准
  assert.throws(() => assertApprovals({ write: 'true' }, ['write']), (error) => error.code === 'AUTOMATION_APPROVAL_REQUIRED');
});

// —— 验证层 ——————————————————————————————————————————————

test('断言：路径缺失/空断言/未知 op 都判失败', () => {
  const state = { url: 'https://pro.easyeda.com/x', sync: { ready: true, count: 12 }, tabs: ['PCB1'] };
  assert.equal(evaluateAssertions([{ path: 'sync.count', op: 'atLeast', value: 12 }], state).ok, true);
  assert.equal(evaluateAssertions([{ path: 'tabs', op: 'contains', value: 'PCB1' }], state).ok, true);
  assert.equal(evaluateAssertions([{ path: 'missing.path', op: 'nonEmpty' }], state).ok, false);
  assert.equal(evaluateAssertions([], state).ok, false);
  assert.equal(evaluateAssertions([{ path: 'url', op: 'teleport' }], state).ok, false);
  assert.deepEqual(getPath(state, 'tabs[0]'), { value: 'PCB1' });
  assert.equal(getPath(state, 'nope.deep').missing, true);
});

// —— 审计日志 ——————————————————————————————————————————————

test('审计日志是哈希链：追加递增、篡改可定位', () => {
  const dir = tempDir();
  try {
    const journal = createAutomationJournal({ dir });
    journal.append('run-1', { phase: 'run.start' });
    journal.append('run-1', { phase: 'step.verified', stepId: 'read' });
    journal.append('run-1', { phase: 'run.end' });
    const entries = journal.read('run-1');
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((entry) => entry.seq), [1, 2, 3]);
    assert.equal(verifyChain(entries).ok, true);
    // 篡改中间一条
    entries[1].phase = 'tampered';
    const broken = verifyChain(entries);
    assert.equal(broken.ok, false);
    assert.equal(broken.brokenAt, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// —— 执行器 ——————————————————————————————————————————————

test('执行器：api 透传 allowWrite，gui 拒绝 eval/危险点击', async () => {
  const calls = [];
  const bridge = { execute: async (command, args, options) => { calls.push({ command, args, options }); return { ok: true, result: { data: [] } }; } };
  const gui = { execute: async (action, params) => ({ ok: true, action, params }) };
  const executors = createExecutors({ bridge, gui });
  await executors.api({ command: 'project.current', params: {}, allowWrite: false });
  await executors.api({ command: 'pcb.component.modify', params: {}, allowWrite: true });
  assert.equal(calls[0].options.allowWrite, false);
  assert.equal(calls[1].options.allowWrite, true);
  await assert.rejects(() => executors.gui({ action: 'eval', params: { expression: '1' } }), (error) => error.code === 'AUTOMATION_EVAL_DISABLED');
  await assert.rejects(() => executors.gui({ action: 'clickText', params: { text: '删除工程' } }), (error) => error.code === 'AUTOMATION_DANGEROUS_TEXT');
  await assert.rejects(() => executors.gui({ action: 'shortcut', params: { key: 'q', modifiers: ['meta'] } }), (error) => error.code === 'AUTOMATION_SHORTCUT_FORBIDDEN');
});

// —— 执行器 ——————————————————————————————————————————————

test('runner：读回不符绝不返回成功', async () => {
  const bridge = { execute: async () => ({ ok: true, result: { data: [] } }) };
  const gui = { execute: async () => ({ url: 'https://pro.easyeda.com/editor' }) };
  const run = await runRecipe({ recipe: readRecipe(), executors: createExecutors({ bridge, gui }) });
  assert.equal(run.ok, false);
  assert.equal(run.state, RUN_STATES.FAILED);
  assert.equal(run.failedStep.stepId, 'read');
  assert.ok(run.failedStep.failures.length > 0);
});

test('runner：全部断言通过才是 completed，并写审计链', async () => {
  const dir = tempDir();
  try {
    const bridge = { execute: async () => ({ ok: true, result: { data: [{ uuid: 'board-1' }] } }) };
    const gui = { execute: async () => ({ url: 'https://pro.easyeda.com/editor' }) };
    const journal = createAutomationJournal({ dir });
    const run = await runRecipe({ recipe: readRecipe(), executors: createExecutors({ bridge, gui }), journal, runId: 'run-ok' });
    assert.equal(run.ok, true);
    assert.equal(run.state, RUN_STATES.COMPLETED);
    const entries = journal.read('run-ok');
    assert.equal(verifyChain(entries).ok, true);
    assert.ok(entries.some((entry) => entry.phase === 'step.verified'));
    assert.ok(entries.some((entry) => entry.phase === 'run.end' && entry.ok === true));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner：缺批准时一步都不执行', async () => {
  const calls = [];
  const bridge = { execute: async (command) => { calls.push(command); return { ok: true, result: { data: [1] } }; } };
  const gui = { execute: async () => ({ url: 'https://pro.easyeda.com/editor' }) };
  const run = await runRecipe({ recipe: clickRecipe(), executors: createExecutors({ bridge, gui }), approvals: {} });
  assert.equal(run.ok, false);
  assert.equal(run.state, RUN_STATES.NEEDS_APPROVAL);
  assert.deepEqual(run.missingApprovals, ['write']);
  assert.equal(calls.length, 0);
});

test('runner：动作报错时 focus 恢复后重试成功', async () => {
  let attempts = 0;
  const guiCalls = [];
  const bridge = {
    execute: async (command) => {
      if (command === 'project.current') {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('窗口失焦'), { code: 'EDA_WINDOW_NOT_FOUND' });
        return { ok: true, result: { data: [1] } };
      }
      return { ok: true, result: {} };
    },
  };
  const gui = { execute: async (action) => { guiCalls.push(action); return { url: 'https://pro.easyeda.com/editor' }; } };
  const run = await runRecipe({
    recipe: readRecipe({ steps: [{ ...readRecipe().steps[0], onFail: { retries: 1, recover: ['focus'] } }] }),
    executors: createExecutors({ bridge, gui }),
  });
  assert.equal(run.ok, true);
  assert.equal(attempts, 3); // 2 次动作 + 1 次读回
  assert.ok(guiCalls.includes('focus'));
});

test('runner：读回不符时只重新读回，不重放动作', async () => {
  let actionCalls = 0;
  let readCalls = 0;
  const bridge = {
    execute: async () => {
      // 动作与读回用同一命令：第 1 次是动作，之后是读回
      actionCalls += 1;
      if (actionCalls === 1) return { ok: true, result: { data: [] } };
      readCalls += 1;
      return { ok: true, result: { data: readCalls >= 2 ? [1] : [] } };
    },
  };
  const gui = { execute: async () => ({ url: 'https://pro.easyeda.com/editor' }) };
  const run = await runRecipe({
    recipe: readRecipe({ steps: [{ ...readRecipe().steps[0], onFail: { retries: 1 } }] }),
    executors: createExecutors({ bridge, gui }),
  });
  assert.equal(run.ok, true);
  assert.equal(actionCalls, 3); // 1 次动作 + 2 次读回
});

test('runner：rollback 策略执行回退；回退失败报 rollback_failed', async () => {
  const restoreCalls = [];
  const failingBridge = {
    execute: async (command) => {
      if (command === 'document.source.restore') { restoreCalls.push(command); return { ok: true, result: {} }; }
      throw Object.assign(new Error('写入失败'), { code: 'EDA_WRITE_FAILED' });
    },
  };
  const recipe = readRecipe({
    steps: [{ ...readRecipe().steps[0], onFail: { retries: 0, then: 'rollback' } }],
    rollback: [{ kind: 'api', command: 'document.source.restore', params: {} }],
  });
  const run = await runRecipe({ recipe, executors: createExecutors({ bridge: failingBridge, gui: null }) });
  assert.equal(run.ok, false);
  assert.equal(run.state, RUN_STATES.FAILED);
  assert.equal(run.rollback.ok, true);
  assert.deepEqual(restoreCalls, ['document.source.restore']);

  const brokenRollbackBridge = { execute: async (command) => { if (command === 'document.source.restore') throw new Error('回退也失败'); throw new Error('写入失败'); } };
  const broken = await runRecipe({ recipe, executors: createExecutors({ bridge: brokenRollbackBridge, gui: null }) });
  assert.equal(broken.state, RUN_STATES.ROLLBACK_FAILED);
});

test('runner：人工步骤没有执行器时停在 needs_human，有执行器且 done 才算通过', async () => {
  const humanRecipe = {
    id: 'test-human', title: '人工上传 DFM', version: 1,
    steps: [{ id: 'upload', action: { kind: 'human', action: 'upload-dfm', instructions: '上传 Gerber 到在线 DFM 并回填结论' } }],
  };
  const paused = await runRecipe({ recipe: humanRecipe, executors: createExecutors({ bridge: null, gui: null }) });
  assert.equal(paused.state, RUN_STATES.NEEDS_HUMAN);
  const done = await runRecipe({ recipe: humanRecipe, executors: { ...createExecutors({ bridge: null, gui: null }), human: async () => ({ done: true, evidence: { url: 'dfm-result' } }) } });
  assert.equal(done.ok, true);
  const rejected = await runRecipe({ recipe: humanRecipe, executors: { ...createExecutors({ bridge: null, gui: null }), human: async () => ({ done: false }) } });
  assert.equal(rejected.state, RUN_STATES.FAILED);
});

test('runner：审计日志写失败时 fail-closed，不产生"成功但没记录"', async () => {
  const bridge = { execute: async () => ({ ok: true, result: { data: [1] } }) };
  const gui = null;
  const brokenJournal = { append: () => { throw new Error('磁盘满了'); }, pathFor: () => '' };
  await assert.rejects(() => runRecipe({ recipe: readRecipe(), executors: createExecutors({ bridge, gui }), journal: brokenJournal }), (error) => error.code === 'AUTOMATION_JOURNAL_FAILED');
});


// —— Phase 1：新内核能力 ——————————————————————————————————————

test('断言：跨读回路径比较（PCB 器件数 ≥ 原理图器件数）', () => {
  const state = { schematic: [1, 2, 3], pcb: { components: [1, 2, 3, 4] } };
  assert.equal(evaluateAssertions([{ path: 'pcb.components.length', op: 'atLeastPath', value: 'schematic.length' }], state).ok, true);
  const fewer = { schematic: [1, 2, 3], pcb: { components: [1] } };
  const result = evaluateAssertions([{ path: 'pcb.components.length', op: 'atLeastPath', value: 'schematic.length' }], fewer);
  assert.equal(result.ok, false);
  assert.equal(evaluateAssertions([{ path: 'pcb.components.length', op: 'equalsPath', value: 'missing.path' }], state).ok, false);
});

test('写入配方：自动要求 write 批准；参数引用必须已声明', () => {
  const registry = createDefaultRecipeRegistry();
  const sync = registry.get('pcb-sync-from-schematic');
  assert.deepEqual(sync.requiredApprovals, ['write']);
  assert.equal(sync.params.schematicUuid.required, false);
  const open = registry.get('eda-open-project');
  assert.equal(open.params.projectText.required, true);
  assert.throws(() => validateRecipe({
    id: 'test-undeclared-param', title: 't',
    steps: [{
      id: 'step',
      action: { kind: 'gui', action: 'click', params: { text: { $param: 'nope' } } },
      expect: { readback: { kind: 'gui', action: 'state' }, assertions: [{ path: 'url', op: 'nonEmpty' }] },
    }],
  }), (error) => error.code === 'AUTOMATION_RECIPE_INVALID');
});

test('runner：主通道成功但读回不符时，执行 GUI 兜底并复核', async () => {
  const guiCalls = [];
  const bridge = {
    execute: async (command) => {
      if (command === 'pcb.importChanges') return { ok: true, result: { applied: true } };
      if (command === 'pcb.placement.read') {
        // 第一次读回为空（模拟 importChanges 空转），兜底动作后变好
        const pcb = guiCalls.length > 0
          ? { components: [{ ref: 'A' }, { ref: 'B' }], componentCount: 2 }
          : { components: [], componentCount: 0 };
        return { ok: true, result: pcb };
      }
      return { ok: true, result: {} };
    },
  };
  const gui = {
    execute: async (action, params) => {
      guiCalls.push(action === 'clickText' ? params.text : action);
      if (action === 'focus') return { focused: true };
      if (action === 'screenshot') return { base64: 'AA==', bytes: 2 };
      return { clicked: true };
    },
  };
  const registry = createDefaultRecipeRegistry();
  const recipe = registry.get('pcb-sync-from-schematic');
  const run = await runRecipe({ recipe, executors: createExecutors({ bridge, gui }), approvals: { write: true }, params: { expectedComponentCount: '2' } });
  assert.equal(run.ok, true);
  assert.equal(run.steps[0].strategy, 'fallback');
  assert.ok(guiCalls.includes('设计'));
  assert.ok(guiCalls.includes('更新/转换原理图到 PCB'));
});

test('runner：compose 读回 + 参数解析（edra-open-project 缺必填参数时 needs_params）', async () => {
  const registry = createDefaultRecipeRegistry();
  const bridge = { execute: async () => ({ ok: true, result: { data: [] } }) };
  const gui = { execute: async () => ({}) };
  const missing = await runRecipe({ recipe: registry.get('eda-open-project'), executors: createExecutors({ bridge, gui }), approvals: { write: true }, params: {} });
  assert.equal(missing.state, RUN_STATES.NEEDS_PARAMS);
  assert.deepEqual(missing.missingParams, ['projectText']);
  // 参数齐全后，主通道读回不满足 → 兜底双击 → 仍不满足 → failed（不假通过）
  const failed = await runRecipe({ recipe: registry.get('eda-open-project'), executors: createExecutors({ bridge, gui }), approvals: { write: true }, params: { projectText: 'DemoBoard' } });
  assert.equal(failed.ok, false);
  assert.equal(failed.state, RUN_STATES.FAILED);
});

test('批准存储：签发→一次性消费；过期/指纹/配方不匹配都拒绝', () => {
  let current = '2026-10-19T00:00:00.000Z';
  const store = createApprovalStore({ now: () => current, ttlMs: 60_000 });
  const issued = store.issue({ scope: 'write', recipeId: 'pcb-rebuild-pours', fingerprint: 'fp-a' });
  assert.equal(store.list().length, 1);
  const ok = store.resolve({ approvalIds: [issued.approvalId], requiredScopes: ['write'], recipeId: 'pcb-rebuild-pours', fingerprint: 'fp-a' });
  assert.equal(ok.ok, true);
  assert.equal(ok.approvals.write, true);
  // 一次性
  assert.equal(store.resolve({ approvalIds: [issued.approvalId], requiredScopes: ['write'], recipeId: 'pcb-rebuild-pours', fingerprint: 'fp-a' }).ok, false);
  // 指纹不匹配
  const forA = store.issue({ scope: 'write', recipeId: 'pcb-rebuild-pours', fingerprint: 'fp-a' });
  assert.equal(store.resolve({ approvalIds: [forA.approvalId], requiredScopes: ['write'], recipeId: 'pcb-rebuild-pours', fingerprint: 'fp-b' }).ok, false);
  // 配方不匹配
  const forOther = store.issue({ scope: 'write', recipeId: 'eda-open-project', fingerprint: 'fp-a' });
  assert.equal(store.resolve({ approvalIds: [forOther.approvalId], requiredScopes: ['write'], recipeId: 'pcb-rebuild-pours', fingerprint: 'fp-a' }).ok, false);
  // 过期
  const expiring = store.issue({ scope: 'write', recipeId: 'pcb-rebuild-pours', fingerprint: 'fp-a' });
  current = '2026-10-19T00:02:00.000Z';
  assert.equal(store.resolve({ approvalIds: [expiring.approvalId], requiredScopes: ['write'], recipeId: 'pcb-rebuild-pours', fingerprint: 'fp-a' }).ok, false);
  assert.equal(store.issue({ scope: 'release' }).scope, 'release');
  assert.throws(() => store.issue({ scope: 'admin' }), (error) => error.code === 'AUTOMATION_APPROVAL_SCOPE_INVALID');
  assert.equal(fingerprintOf({ windowId: 'w', projectUuid: 'p', documentUuid: 'd' }).length, 32);
});


test('读回解包：桥成功信封是 { success:true, result }，不能被当成业务字段找路径', () => {
  // 真机踩坑回归：eda-read-project 曾因为信封没解开而永远报"没有路径 data"。
  assert.deepEqual(unwrapReadback({ success: true, result: { data: [1] } }), { data: [1] });
  assert.deepEqual(unwrapReadback({ ok: true, result: { data: [1] } }), { data: [1] });
  assert.deepEqual(unwrapReadback({ data: [1] }), { data: [1] });
  assert.equal(unwrapReadback(undefined), undefined);
});
