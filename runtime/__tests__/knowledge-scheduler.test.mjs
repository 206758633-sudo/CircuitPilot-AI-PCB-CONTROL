import assert from 'node:assert/strict';
import test from 'node:test';
import { createKnowledgeScheduler } from '../knowledge-scheduler.mjs';

const memoryFs = () => {
  const files = new Map();
  return {
    files,
    io: {
      existsSync: (path) => files.has(path),
      readFileSync: (path) => files.get(path),
      writeFileSync: (path, content) => files.set(path, content),
      mkdirSync: () => {},
    },
  };
};

const managerStub = (cycle = null) => {
  const calls = [];
  return {
    calls,
    runCycle: async (options) => {
      calls.push(options);
      return cycle ?? { ok: true, startedAt: '2026-10-22T00:00:00.000Z', finishedAt: '2026-10-22T00:00:01.000Z', tasks: options.tasks, badcases: { created: 2, duplicates: 0, candidates: 2 }, web: { created: 1, failed: [], collectors: 1 }, maintenance: { pendingReview: 3, expired: { count: 0 }, conflicts: { count: 0 } } };
    },
  };
};

test('scheduler：start 安排首轮；到点执行并写入状态/历史，再排下一轮', async () => {
  const timers = [];
  const fakeTimers = { setTimeout: (fn, ms) => { const handle = { fn, ms, cleared: false }; timers.push(handle); return handle; }, clearTimeout: (handle) => { if (handle) handle.cleared = true; } };
  const { io, files } = memoryFs();
  const manager = managerStub();
  const scheduler = createKnowledgeScheduler({ manager, stateFile: '/state/knowledge-agent.json', intervalMs: 6 * 3600 * 1000, initialDelayMs: 60 * 1000, timers: fakeTimers, fileIo: io, now: () => new Date('2026-10-22T01:00:00.000Z') });
  const started = scheduler.start();
  assert.equal(started.enabled, true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60 * 1000);
  await timers[0].fn();
  assert.equal(manager.calls.length, 1);
  assert.deepEqual(manager.calls[0].tasks, ['badcases', 'web', 'maintain']);
  const status = scheduler.status();
  assert.equal(status.lastResult.badcases.created, 2);
  assert.equal(status.history.length, 1);
  assert.ok(status.lastRunAt);
  assert.equal(timers.length, 2);
  assert.equal(timers[1].ms, 6 * 3600 * 1000);
  assert.equal(files.has('/state/knowledge-agent.json'), true);
  assert.equal(JSON.parse(files.get('/state/knowledge-agent.json')).history.length, 1);
});

test('scheduler：running 时拒绝并发；stop 清理定时器；间隔过小拒绝', async () => {
  let release;
  const slowManager = { runCycle: () => new Promise((resolve) => { release = () => resolve({ ok: true, badcases: { created: 0 }, web: { created: 0 }, maintenance: { pendingReview: 0 }, startedAt: null, finishedAt: null, tasks: [] }); }) };
  const timers = [];
  const fakeTimers = { setTimeout: (fn, ms) => { const handle = { fn, ms }; timers.push(handle); return handle; }, clearTimeout: (handle) => { if (handle) handle.cleared = true; } };
  const scheduler = createKnowledgeScheduler({ manager: slowManager, stateFile: null, timers: fakeTimers, fileIo: memoryFs().io, initialDelayMs: 120000 });
  const first = scheduler.runNow({ reason: 'manual' });
  const second = await scheduler.runNow({ reason: 'manual' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'KMA_BUSY');
  release();
  await first;
  assert.equal(scheduler.status().running, false);
  scheduler.start();
  const stopped = scheduler.stop();
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.nextRunAt, null);
  assert.throws(() => createKnowledgeScheduler({ manager: managerStub(), intervalMs: 1000 }), /不能小于 60 秒/);
});

test('scheduler：runCycle 抛错时记录失败状态，不向调用方抛', async () => {
  const failing = { runCycle: async () => { throw Object.assign(new Error('断网'), { code: 'KMA_NET_FAILED' }); } };
  const scheduler = createKnowledgeScheduler({ manager: failing, stateFile: null, timers: { setTimeout: () => null, clearTimeout: () => {} }, fileIo: memoryFs().io });
  const cycle = await scheduler.runNow({ reason: 'manual', tasks: ['web'] });
  assert.equal(cycle.ok, false);
  const status = scheduler.status();
  assert.equal(status.lastResult.ok, false);
  assert.equal(status.lastResult.failed[0].task, 'web');
  assert.equal(status.lastResult.failed[0].code, 'KMA_NET_FAILED');
});
