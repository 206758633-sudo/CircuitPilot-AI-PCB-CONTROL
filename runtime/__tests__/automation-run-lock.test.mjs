import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRunLock } from '../automation/run-lock.mjs';
import { createRuntimeServer } from '../server.mjs';

// 文件锁放在状态目录：测试必须隔离，否则多个测试文件并行时会互相抢同一把锁。
process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-auto-lock-state-'));

test('E7：单写锁——持有中拒绝第二个 run，释放后可重新获取，非持有者不能释放', () => {
  const lock = createRunLock({ idFactory: (() => { let n = 0; return () => `t${++n}`; })() });
  const first = lock.tryAcquire({ runId: 'r1', recipeId: 'eda-read-project' });
  assert.equal(first.ok, true);
  const second = lock.tryAcquire({ runId: 'r2', recipeId: 'eda-read-project' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'EXECUTION_BUSY');
  assert.equal(second.status.runId, 'r1');
  assert.equal(lock.release('wrong-token').ok, false);
  assert.equal(lock.release(first.token).ok, true);
  assert.equal(lock.tryAcquire({ runId: 'r2' }).ok, true);
});

test('E7：陈旧锁可接管且如实标记 stale（不悄悄覆盖）', () => {
  let clock = 1_000;
  const lock = createRunLock({ now: () => clock, ttlMs: 100 });
  const first = lock.tryAcquire({ runId: 'r1' });
  clock += 500;
  assert.equal(lock.status().stale, true);
  const takeover = lock.tryAcquire({ runId: 'r2' });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.staleTakeover.runId, 'r1');
  assert.equal(lock.status().runId, 'r2');
});

function fakeBridge(state) {
  return {
    port: 49620,
    selectedWindowId: 'window-lock',
    async discover() {},
    async windows() { return { selectionRequired: false, windows: [{ id: 'window-lock' }] }; },
    async execute(command) {
      if (command === 'project.current') {
        state.projectReads += 1;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { ok: true, result: { uuid: state.projectUuid, data: [{ uuid: state.projectUuid, name: '锁测试板' }] } };
      }
      if (command === 'document.current') return { ok: true, result: { uuid: state.documentUuid } };
      return { ok: true, result: {} };
    },
  };
}

async function startServer(context) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-run-lock-'));
  const previous = process.env.CIRCUITPILOT_AUTOMATION_DIR;
  process.env.CIRCUITPILOT_AUTOMATION_DIR = dir;
  const state = { projectReads: 0, projectUuid: 'p-lock', documentUuid: 'd-lock' };
  const { server } = createRuntimeServer({ bridge: fakeBridge(state), gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => {
    if (previous === undefined) delete process.env.CIRCUITPILOT_AUTOMATION_DIR;
    else process.env.CIRCUITPILOT_AUTOMATION_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return { base, headers, state, post: (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }) };
}

test('E7 HTTP：并发两个 run 只有一个能执行，另一个 409 EXECUTION_BUSY', async (context) => {
  const { post } = await startServer(context);
  const run = () => post('/api/automation/run', { recipeId: 'eda-read-project', params: {} });
  const [a, b] = await Promise.all([run(), run()]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const busy = a.status === 409 ? await a.json() : await b.json();
  assert.equal(busy.error.code, 'EXECUTION_BUSY');
  assert.ok(busy.error.details.activeRun.runId);
});

test('E7 HTTP：同一 runId 重复提交返回同一结果（幂等），不重复执行配方', async (context) => {
  const { post, state } = await startServer(context);
  const body = { recipeId: 'eda-read-project', params: {}, runId: 'dup-run-1' };
  const first = await (await post('/api/automation/run', body)).json();
  assert.equal(first.ok, true);
  const readsAfterFirst = state.projectReads;
  const second = await (await post('/api/automation/run', body)).json();
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(second.runId, 'dup-run-1');
  assert.equal(second.run.state, first.run.state);
  assert.equal(state.projectReads, readsAfterFirst, '幂等重放不能再执行一次配方');
});

test('E7 HTTP：参数缺失使 run 停在 needs_params，锁必须释放（下一次 run 可正常跑）', async (context) => {
  const { post } = await startServer(context);
  const paused = await (await post('/api/automation/run', { recipeId: 'eda-open-project', params: {}, runId: 'paused-1' })).json();
  assert.equal(paused.run.state, 'needs_params');
  const next = await (await post('/api/automation/run', { recipeId: 'eda-read-project', params: {}, runId: 'after-paused' })).json();
  assert.equal(next.ok, true);
  assert.equal(next.run.state, 'completed');
});

test('E7 文件锁：跨实例（模拟多进程）互斥，释放后可获取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-runlock-'));
  try {
    const file = join(dir, 'automation-run.lock');
    const a = createRunLock({ file, pid: process.pid });
    const b = createRunLock({ file, pid: process.pid });
    const first = a.tryAcquire({ runId: 'proc-a', recipeId: 'eda-read-project' });
    assert.equal(first.ok, true);
    const second = b.tryAcquire({ runId: 'proc-b', recipeId: 'eda-read-project' });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'EXECUTION_BUSY');
    assert.equal(second.status.runId, 'proc-a');
    // 非持有者不能释放另一个进程的锁
    assert.equal(b.release('not-the-token').ok, false);
    assert.equal(a.release(first.token).ok, true);
    assert.equal(b.tryAcquire({ runId: 'proc-b' }).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('E7 文件锁：同机持有进程已死 → 可原子接管并记录 staleTakeover', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-runlock-'));
  try {
    const file = join(dir, 'automation-run.lock');
    // 手工制造一个"心跳还在 TTL 内但进程已死"的锁：不加 pid 存活判断的话会误判为 busy。
    writeFileSync(file, JSON.stringify({ token: 'dead-token', pid: 999999, host: hostname(), runId: 'dead-run', recipeId: 'eda-read-project', acquiredAt: Date.now(), heartbeatAt: Date.now() }));
    const lock = createRunLock({ file, pid: process.pid });
    const takeover = lock.tryAcquire({ runId: 'new-run' });
    assert.equal(takeover.ok, true);
    assert.equal(takeover.staleTakeover.runId, 'dead-run');
    assert.equal(takeover.staleTakeover.stale, true);
    assert.equal(lock.status().runId, 'new-run');
    // 旧持有者拿着旧 token 也不能再释放/心跳
    assert.equal(lock.release('dead-token').ok, false);
    assert.equal(lock.heartbeat('dead-token').ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('E7 文件锁：锁文件损坏时拒绝接管（fail-closed，不猜）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-runlock-'));
  try {
    const file = join(dir, 'automation-run.lock');
    writeFileSync(file, '{ this is not json');
    const lock = createRunLock({ file });
    const result = lock.tryAcquire({ runId: 'r1' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EXECUTION_BUSY');
    assert.equal(result.status.unreadable, true);
    assert.ok(result.status.reason && result.status.reason.length > 0, '必须给出不可读原因');
    assert.equal(lock.status().unreadable, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('E7 文件锁：心跳可延长 TTL；非持有者心跳被拒', () => {
  let clock = 1_000;
  const dir = mkdtempSync(join(tmpdir(), 'cp-runlock-'));
  try {
    const file = join(dir, 'automation-run.lock');
    const lock = createRunLock({ file, now: () => clock, ttlMs: 100, pid: process.pid });
    const first = lock.tryAcquire({ runId: 'long-run' });
    assert.equal(first.ok, true);
    assert.equal(lock.heartbeat('wrong').ok, false);
    clock += 90;
    assert.equal(lock.heartbeat(first.token).ok, true);
    clock += 90;
    assert.equal(lock.status().stale, false, '心跳后不应判陈旧');
    assert.equal(lock.release(first.token).ok, true);
    assert.equal(lock.status(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
