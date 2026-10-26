import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDefaultRecipeRegistry } from '../automation/recipes.mjs';
import { runRecipe } from '../automation/runner.mjs';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-abort-state-'));

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

test('E7 中止（runner）：预中止信号 → aborted 且 0 步执行；不返回 completed', async () => {
  const registry = createDefaultRecipeRegistry();
  const base = registry.get('eda-read-project');
  let calls = 0;
  const executors = {
    api: async ({ command }) => { calls += 1; return command === 'project.current' ? { uuid: 'p1', data: [{ uuid: 'p1' }] } : { uuid: 'd1' }; },
    gui: async () => { throw new Error('不应调用 GUI'); },
  };
  const recipe = { ...base, id: 'abort-probe', steps: [base.steps[0], { ...base.steps[0], id: 'read-again' }] };
  const controller = new AbortController();
  controller.abort('test-pre-abort');
  const result = await runRecipe({ recipe, executors, signal: controller.signal });
  assert.equal(result.state, 'aborted');
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 0);
  assert.equal(calls, 0, '预中止不得执行任何动作');
  assert.equal(result.aborted.reason, 'test-pre-abort');
});

test('E7 中止（runner）：动作执行中收到中止 → 不再读回/后续步骤，标记 mayHaveTakenEffect=false（只读）', async () => {
  const registry = createDefaultRecipeRegistry();
  const base = registry.get('eda-read-project');
  const commands = [];
  const executors = {
    api: async ({ command }) => {
      commands.push(command);
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { uuid: 'p1', data: [{ uuid: 'p1' }], ok: true };
    },
    gui: async () => { throw new Error('不应调用 GUI'); },
  };
  const recipe = { ...base, id: 'abort-mid', steps: [base.steps[0], { ...base.steps[0], id: 'read-again' }] };
  const controller = new AbortController();
  setTimeout(() => controller.abort('operator_requested'), 30);
  const result = await runRecipe({ recipe, executors, signal: controller.signal });
  assert.equal(result.state, 'aborted');
  assert.equal(result.aborted.phaseNote, 'after_action_before_readback');
  assert.equal(result.aborted.mayHaveTakenEffect, false, '只读动作不得标记可能已改状态');
  assert.equal(result.steps.length, 0);
  assert.deepEqual(commands, ['project.current'], '中止到达后不得再发起读回或下一步动作');
});

function fakeBridge(state) {
  return {
    port: 49620,
    selectedWindowId: 'window-abort',
    async discover() {},
    async windows() { return { selectionRequired: false, windows: [{ id: 'window-abort' }] }; },
    async execute(command) {
      state.commands.push(command);
      if (command === 'project.current') {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { ok: true, result: { uuid: 'p-abort', data: [{ uuid: 'p-abort', name: '中止测试板' }] } };
      }
      if (command === 'document.current') return { ok: true, result: { uuid: 'd-abort' } };
      return { ok: true, result: {} };
    },
  };
}

async function startServer(state) {
  const automationDir = mkdtempSync(join(tmpdir(), 'cp-abort-automation-'));
  const previousAutomation = process.env.CIRCUITPILOT_AUTOMATION_DIR;
  process.env.CIRCUITPILOT_AUTOMATION_DIR = automationDir;
  const { server } = createRuntimeServer({ bridge: fakeBridge(state), gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return {
    base,
    headers,
    post: (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }),
    get: (path) => fetch(`${base}${path}`, { headers }),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(automationDir, { recursive: true, force: true });
      if (previousAutomation === undefined) delete process.env.CIRCUITPILOT_AUTOMATION_DIR; else process.env.CIRCUITPILOT_AUTOMATION_DIR = previousAutomation;
    },
  };
}

test('E7 中止（HTTP）：执行中的 run 可中止 → aborted + journal 记录 + 锁释放后可再跑', async (context) => {
  const server = await startServer({ commands: [] });
  context.after(() => server.close());
  const running = server.post('/api/automation/run', { recipeId: 'eda-read-project', params: {}, runId: 'abort-http-1' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const abortResponse = await server.post('/api/automation/runs/abort-http-1/abort', {});
  assert.equal(abortResponse.status, 200);
  const abortBody = await abortResponse.json();
  assert.equal(abortBody.abortRequested, true);
  const runResponse = await running;
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.equal(run.runId, 'abort-http-1');
  assert.equal(run.run.state, 'aborted');
  assert.equal(run.run.ok, false);
  assert.ok(['after_action_before_readback', 'at_step_boundary'].includes(run.run.aborted.phaseNote));
  const audit = await (await server.get('/api/automation/runs/abort-http-1')).json();
  assert.ok(audit.run.entries.some((entry) => entry.phase === 'run.abort'), '审计链必须记录 run.abort');
  // 锁必须释放：下一个 run 能正常执行
  const next = await (await server.post('/api/automation/run', { recipeId: 'eda-read-project', params: {}, runId: 'abort-http-2' })).json();
  assert.notEqual(next.run?.state, 'aborted');
  assert.equal(next.run?.state, 'completed');
});

test('E7 中止（HTTP）：不在执行中的 run（已完成/不存在）→ 409 AUTOMATION_RUN_NOT_RUNNING', async (context) => {
  const server = await startServer({ commands: [] });
  context.after(() => server.close());
  const unknown = await server.post('/api/automation/runs/no-such-run/abort', {});
  assert.equal(unknown.status, 409);
  assert.equal((await unknown.json()).error.code, 'AUTOMATION_RUN_NOT_RUNNING');
});
