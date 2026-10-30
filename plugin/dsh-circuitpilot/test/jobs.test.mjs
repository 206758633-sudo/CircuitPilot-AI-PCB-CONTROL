import test from 'node:test';
import assert from 'node:assert/strict';
import { JobManager } from '../lib/jobs.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('start 执行任务并进入 done，status 返回结果', async () => {
  const jobs = new JobManager({ defaultTimeoutMs: 1000 });
  const started = jobs.start('demo', 'req-1', async () => ({ value: 42 }));
  assert.equal(started.state, 'queued');
  const waited = await jobs.wait(started.jobId, { timeoutMs: 1000 });
  assert.equal(waited.timedOut, false);
  assert.equal(waited.job.state, 'done');
  assert.deepEqual(waited.job.result, { value: 42 });
  assert.equal(jobs.status(started.jobId).state, 'done');
});

test('同 requestId 幂等：返回同一 job，不重复执行', async () => {
  const jobs = new JobManager({ defaultTimeoutMs: 1000 });
  let runs = 0;
  const first = jobs.start('demo', 'req-same', async () => {
    runs += 1;
    return { runs };
  });
  const second = jobs.start('demo', 'req-same', async () => {
    runs += 1;
    return { runs: -1 };
  });
  assert.equal(second.deduped, true);
  assert.equal(second.jobId, first.jobId);
  await jobs.wait(first.jobId, { timeoutMs: 1000 });
  assert.equal(runs, 1);
});

test('requestId 必填；缺失直接拒绝', () => {
  const jobs = new JobManager();
  assert.throws(() => jobs.start('demo', '', async () => ({})), (error) => error.code === 'REQUEST_ID_REQUIRED');
  assert.throws(() => jobs.start('demo', '   ', async () => ({})), (error) => error.code === 'REQUEST_ID_REQUIRED');
});

test('超时：state=timeout，mayHaveTakenEffect=true，不自动重试', async () => {
  const jobs = new JobManager({ defaultTimeoutMs: 30 });
  const started = jobs.start('demo.write', 'req-timeout', async ({ signal }) => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    return { late: true };
  }, { timeoutMs: 30, mayHaveTakenEffect: true });
  const waited = await jobs.wait(started.jobId, { timeoutMs: 1000 });
  assert.equal(waited.job.state, 'timeout');
  assert.equal(waited.job.mayHaveTakenEffect, true);
  assert.equal(waited.job.error.code, 'JOB_TIMEOUT');
  assert.equal(waited.job.error.mayHaveTakenEffect, true);
});

test('取消：标记 cancelled 并 abort；已结束任务取消返回 false', async () => {
  const jobs = new JobManager({ defaultTimeoutMs: 5000 });
  let aborted = false;
  const started = jobs.start('demo.write', 'req-cancel', async ({ signal }) => {
    await new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        resolve();
      }, { once: true });
    });
    return { finished: true };
  }, { mayHaveTakenEffect: true });
  await tick();
  const cancelled = jobs.cancel(started.jobId);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.job.state, 'cancelled');
  assert.equal(cancelled.job.mayHaveTakenEffect, true);
  await tick();
  assert.equal(aborted, true);
  const again = jobs.cancel(started.jobId);
  assert.equal(again.cancelled, false);
  assert.equal(again.reason, 'already_finished');
});

test('失败任务携带 code；mightHaveTakenEffect 默认 false', async () => {
  const jobs = new JobManager({ defaultTimeoutMs: 1000 });
  const started = jobs.start('demo', 'req-fail', async () => {
    throw Object.assign(new Error('boom'), { code: 'BOOM' });
  });
  const waited = await jobs.wait(started.jobId, { timeoutMs: 1000 });
  assert.equal(waited.job.state, 'failed');
  assert.equal(waited.job.error.code, 'BOOM');
  assert.equal(waited.job.error.mayHaveTakenEffect, false);
});

test('wait 超时返回 timedOut 且任务继续运行；未知 jobId 返回 found=false', async () => {
  const jobs = new JobManager({ defaultTimeoutMs: 5000 });
  const started = jobs.start('demo', 'req-slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ok: true };
  });
  const waited = await jobs.wait(started.jobId, { timeoutMs: 5 });
  assert.equal(waited.found, true);
  assert.equal(waited.timedOut, true);
  assert.equal(waited.job.state === 'running' || waited.job.state === 'queued', true);
  await jobs.wait(started.jobId, { timeoutMs: 1000 });
  assert.equal(jobs.status(started.jobId).state, 'done');
  const missing = await jobs.wait('job-missing', { timeoutMs: 10 });
  assert.equal(missing.found, false);
});

test('list 返回任务快照（不含结果）；cancelAll 取消所有在途任务', async () => {
  const jobs = new JobManager({ defaultTimeoutMs: 5000 });
  const running = jobs.start('demo', 'req-list', async () => {
    await tick();
    return { ok: true };
  });
  await tick();
  const list = jobs.list({ limit: 10 });
  assert.equal(list.length, 1);
  assert.equal(list[0].jobId, running.jobId);
  assert.equal('result' in list[0], false);
  const cancelled = jobs.cancelAll();
  assert.deepEqual(cancelled, [running.jobId]);
  assert.equal(jobs.status(running.jobId).state, 'cancelled');
});
