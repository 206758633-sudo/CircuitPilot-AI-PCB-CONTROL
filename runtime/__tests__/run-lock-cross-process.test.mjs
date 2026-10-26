import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';

function fakeBridge(state) {
  return {
    port: 49620,
    selectedWindowId: 'window-x',
    async discover() {},
    async windows() { return { selectionRequired: false, windows: [{ id: 'window-x' }] }; },
    async execute(command) {
      if (command === 'project.current') {
        state.reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { ok: true, result: { uuid: state.projectUuid, data: [{ uuid: state.projectUuid, name: '跨进程锁测试板' }] } };
      }
      if (command === 'document.current') return { ok: true, result: { uuid: state.documentUuid } };
      return { ok: true, result: {} };
    },
  };
}

async function startServer(state) {
  const { server } = createRuntimeServer({ bridge: fakeBridge(state), gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return {
    server,
    post: (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}

test('E7 跨进程文件锁：两个 runtime 实例共用一个状态目录时，同一时刻只有一个 run 能执行', async (context) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cp-cross-lock-state-'));
  const automationDir = mkdtempSync(join(tmpdir(), 'cp-cross-lock-automation-'));
  const previousState = process.env.CIRCUITPILOT_STATE_DIR;
  const previousAutomation = process.env.CIRCUITPILOT_AUTOMATION_DIR;
  process.env.CIRCUITPILOT_STATE_DIR = stateDir;
  process.env.CIRCUITPILOT_AUTOMATION_DIR = automationDir;
  context.after(() => {
    if (previousState === undefined) delete process.env.CIRCUITPILOT_STATE_DIR; else process.env.CIRCUITPILOT_STATE_DIR = previousState;
    if (previousAutomation === undefined) delete process.env.CIRCUITPILOT_AUTOMATION_DIR; else process.env.CIRCUITPILOT_AUTOMATION_DIR = previousAutomation;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(automationDir, { recursive: true, force: true });
  });

  // 两个实例各自独立（不同的进程内状态），但共享同一个 stateDir → 共享同一个锁文件。
  const a = await startServer({ reads: 0, projectUuid: 'p-a', documentUuid: 'd-a' });
  const b = await startServer({ reads: 0, projectUuid: 'p-b', documentUuid: 'd-b' });
  context.after(() => new Promise((resolve) => a.server.close(resolve)));
  context.after(() => new Promise((resolve) => b.server.close(resolve)));

  const running = a.post('/api/automation/run', { recipeId: 'eda-read-project', params: {}, runId: 'cross-a' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = await b.post('/api/automation/run', { recipeId: 'eda-read-project', params: {}, runId: 'cross-b' });
  assert.equal(second.status, 409, '另一个实例的 run 必须被文件锁挡住');
  const busy = await second.json();
  assert.equal(busy.error.code, 'EXECUTION_BUSY');
  assert.equal(busy.error.details.activeRun.runId, 'cross-a');

  const first = await (await running).json();
  assert.equal(first.ok, true);
  assert.equal(first.run.state, 'completed');
});
