import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDefaultRecipeRegistry } from '../automation/recipes.mjs';
import { analyzeRunEntries, canReplay, findInterruptedRuns } from '../automation/recovery.mjs';
import { createAutomationJournal } from '../automation/journal.mjs';
import { createRuntimeServer } from '../server.mjs';

process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-recovery-state-'));

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const registry = createDefaultRecipeRegistry();

function seedInterrupted(dir, runId, { recipeId, stepId, write = false }) {
  const journal = createAutomationJournal({ dir });
  const at = new Date().toISOString();
  journal.append(runId, { at, recipeId, recipeVersion: 1, phase: 'run.start' });
  journal.append(runId, { at, phase: 'step.start', stepId, kind: 'api', action: 'x' });
  if (write) journal.append(runId, { at, phase: 'attempt', stepId, ok: true, strategy: 'primary' });
  return journal;
}

test('E7 恢复分析：终态事件 → finished；只读中断 → readonly_replayable；写后中断 → needs_human', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-recovery-analysis-'));
  try {
    const journal = seedInterrupted(dir, 'ro-run', { recipeId: 'eda-read-project', stepId: 'read-project' });
    const roEntries = journal.read('ro-run');
    const ro = analyzeRunEntries(roEntries, { registry, runId: 'ro-run' });
    assert.equal(ro.terminal, false);
    assert.equal(ro.verdict, 'readonly_replayable');
    assert.equal(canReplay(ro).ok, true);

    journal.append('ro-run', { at: new Date().toISOString(), phase: 'run.end', ok: true, state: 'completed' });
    const finished = analyzeRunEntries(journal.read('ro-run'), { registry, runId: 'ro-run' });
    assert.equal(finished.terminal, true);
    assert.equal(finished.verdict, 'finished');
    assert.equal(canReplay(finished).ok, false);

    const writeJournal = seedInterrupted(dir, 'write-run', { recipeId: 'pcb-rebuild-pours', stepId: 'rebuild-pours', write: true });
    const writeAnalysis = analyzeRunEntries(writeJournal.read('write-run'), { registry, runId: 'write-run' });
    assert.equal(writeAnalysis.writeStarted, true);
    assert.equal(writeAnalysis.verdict, 'needs_human');
    const gate = canReplay(writeAnalysis);
    assert.equal(gate.ok, false);
    assert.match(gate.reason, /写动作|人工/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('E7 恢复分析：未知配方/坏文件/目录不存在都显式给出原因（不静默跳过、不假空）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-recovery-edge-'));
  try {
    const journal = seedInterrupted(dir, 'ghost-run', { recipeId: 'old-removed-recipe', stepId: 's1' });
    assert.ok(journal.read('ghost-run').length > 0);
    const ghost = analyzeRunEntries(journal.read('ghost-run'), { registry, runId: 'ghost-run' });
    assert.equal(ghost.verdict, 'unknown_recipe');
    writeFileSync(join(dir, 'broken-run.jsonl'), '{not-json\n', 'utf8');
    // 批准账本也放在同一目录：不能被误报成“中断的 run”。
    const journal2 = createAutomationJournal({ dir });
    journal2.append('approval-abc', { at: new Date().toISOString(), phase: 'approval.issued', scope: 'write' });
    journal2.append('approval-abc', { at: new Date().toISOString(), phase: 'approval.consumed' });
    const scan = findInterruptedRuns({ dir, registry });
    assert.equal(scan.available, true);
    assert.equal(scan.corrupt, 1);
    assert.ok(scan.runs.some((run) => run.verdict === 'corrupt' && run.runId === 'broken-run'));
    assert.equal(scan.runs.some((run) => run.runId === 'approval-abc'), false, '批准账本不是 run，不能出现在中断列表');
    assert.ok(scan.runs.some((run) => run.runId === 'ghost-run'));
    const missing = findInterruptedRuns({ dir: join(dir, 'nope'), registry });
    assert.equal(missing.available, false);
    assert.match(missing.reason, /目录不存在/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fakeBridge() {
  return {
    port: 49620,
    selectedWindowId: 'window-recovery',
    async discover() {},
    async windows() { return { selectionRequired: false, windows: [{ id: 'window-recovery' }] }; },
    async execute(command) {
      if (command === 'project.current') return { ok: true, result: { uuid: 'p-rec', data: [{ uuid: 'p-rec', name: '恢复测试板' }] } };
      if (command === 'document.current') return { ok: true, result: { uuid: 'd-rec' } };
      return { ok: true, result: {} };
    },
  };
}

async function startServer(automationDir) {
  const previousAutomation = process.env.CIRCUITPILOT_AUTOMATION_DIR;
  process.env.CIRCUITPILOT_AUTOMATION_DIR = automationDir;
  const { server } = createRuntimeServer({ bridge: fakeBridge(), gui: null, runtimeToken: 'recovery-test-token' });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': 'recovery-test-token', origin: TRUSTED_ORIGIN };
  return {
    server,
    base,
    headers,
    get: (path) => fetch(`${base}${path}`, { headers }),
    post: (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (previousAutomation === undefined) delete process.env.CIRCUITPILOT_AUTOMATION_DIR; else process.env.CIRCUITPILOT_AUTOMATION_DIR = previousAutomation;
    },
  };
}

test('E7 恢复 HTTP：列出中断 run；只读的可安全重放并标记原 run 已恢复；写过的 409', async (context) => {
  const automationDir = mkdtempSync(join(tmpdir(), 'cp-recovery-http-'));
  context.after(() => rmSync(automationDir, { recursive: true, force: true }));
  seedInterrupted(automationDir, 'interrupted-ro', { recipeId: 'eda-read-project', stepId: 'read-project' });
  seedInterrupted(automationDir, 'interrupted-write', { recipeId: 'pcb-rebuild-pours', stepId: 'rebuild-pours', write: true });
  const server = await startServer(automationDir);
  context.after(() => server.close());

  const listed = await (await server.get('/api/automation/recovery')).json();
  assert.equal(listed.ok, true);
  assert.equal(listed.recovery.available, true);
  const ro = listed.recovery.runs.find((run) => run.runId === 'interrupted-ro');
  const write = listed.recovery.runs.find((run) => run.runId === 'interrupted-write');
  assert.equal(ro.verdict, 'readonly_replayable');
  assert.equal(write.verdict, 'needs_human');

  const replay = await (await server.post('/api/automation/runs/interrupted-ro/replay', {})).json();
  assert.equal(replay.ok, true);
  assert.equal(replay.replay.recoveredFrom, 'interrupted-ro');
  assert.equal(replay.replay.run.state, 'completed');
  // 原 run 被标记 run.recovered（终态），不再出现在中断列表
  const after = await (await server.get('/api/automation/recovery')).json();
  assert.equal(after.recovery.runs.some((run) => run.runId === 'interrupted-ro'), false);

  const blocked = await server.post('/api/automation/runs/interrupted-write/replay', {});
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.error.code, 'AUTOMATION_RECOVERY_NOT_SAFE');
  assert.equal(blockedBody.error.details.verdict, 'needs_human');

  const missing = await server.post('/api/automation/runs/no-such-run/replay', {});
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'AUTOMATION_RUN_NOT_FOUND');
});
