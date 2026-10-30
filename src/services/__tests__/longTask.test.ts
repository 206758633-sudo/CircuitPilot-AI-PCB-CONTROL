import { describe, expect, it } from 'vitest';
import { createLongTask, createSingleCallTask } from '../longTask';

/** 可控时钟：sleep 推进虚拟时间，避免测试真的等 2 秒。 */
function fakeClock() {
  let time = 1_000;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
    advance: (ms: number) => { time += ms; },
    sleeps,
  };
}

describe('D8 统一长任务控制器', () => {
  it('running → done：轮询到 done 才成功，记录轮询次数与结果', async () => {
    const clock = fakeClock();
    let pollCount = 0;
    const task = createLongTask<{ jobId: string }, { items: number }>({
      start: async () => ({ jobId: 'job-1' }),
      poll: async () => {
        pollCount += 1;
        if (pollCount < 2) return { status: 'running' };
        return { status: 'done', result: { items: 3 } };
      },
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 50,
    });
    const snapshot = await task.startTask();
    expect(snapshot.status).toBe('done');
    expect(snapshot.polls).toBe(2);
    expect(snapshot.result).toEqual({ items: 3 });
    expect(snapshot.error).toBeNull();
    expect(clock.sleeps).toEqual([50]);
  });

  it('poll failed → failed，带服务端原因；不会伪装 completed', async () => {
    const clock = fakeClock();
    const task = createLongTask({
      start: async () => ({}),
      poll: async () => ({ status: 'failed' as const, error: 'EDA 渲染进程崩溃' }),
      now: clock.now,
      sleep: clock.sleep,
    });
    const snapshot = await task.startTask();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toContain('EDA 渲染进程崩溃');
    expect(snapshot.result).toBeNull();
  });

  it('超过 timeoutMs → timeout，并说明"后台可能仍在执行"（不冒充失败/取消）', async () => {
    const clock = fakeClock();
    const task = createLongTask({
      start: async () => ({}),
      poll: async () => ({ status: 'running' as const }),
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 250,
    });
    const snapshot = await task.startTask();
    expect(snapshot.status).toBe('timeout');
    expect(snapshot.note).toContain('后台任务可能仍在执行');
    expect(snapshot.error).toBeNull();
  });

  it('取消：调用服务端 cancel，随后停止轮询并如实写"本页停止等待"', async () => {
    const clock = fakeClock();
    let cancelled = false;
    let polls = 0;
    const task = createLongTask({
      start: async () => ({ jobId: 'job-2' }),
      poll: async () => {
        polls += 1;
        if (polls === 1) { await task.cancelTask(); return { status: 'running' as const }; }
        return { status: 'done' as const, result: { ok: true } };
      },
      cancel: async () => { cancelled = true; },
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 10,
    });
    const snapshot = await task.startTask();
    expect(cancelled).toBe(true);
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.note).toContain('本页停止等待');
    expect(snapshot.result).toBeNull();
  });

  it('start 抛错 → failed；重试（reset + start）可再次执行成功', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const task = createLongTask({
      start: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('运行时未连接');
        return { jobId: 'retry-ok' };
      },
      poll: async () => ({ status: 'done' as const, result: { ok: true } }),
      now: clock.now,
      sleep: clock.sleep,
    });
    const failed = await task.startTask();
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('运行时未连接');
    task.reset();
    expect(task.snapshot().status).toBe('idle');
    const retried = await task.startTask();
    expect(retried.status).toBe('done');
  });

  it('启动完成前请求取消：不发服务端 cancel，但如实标记 cancelled 并给出说明', async () => {
    const clock = fakeClock();
    const switcher: { resolve: ((value: { jobId: string }) => void) | null } = { resolve: null };
    const task = createLongTask({
      start: () => new Promise<{ jobId: string }>((resolve) => { switcher.resolve = resolve; }),
      poll: async () => ({ status: 'done' as const }),
      now: clock.now,
      sleep: clock.sleep,
    });
    const running = task.startTask();
    await Promise.resolve();
    await task.cancelTask();
    switcher.resolve?.({ jobId: 'late-job' });
    const snapshot = await running;
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.note).toContain('启动完成前已请求取消');
  });
});

describe('D8 单调用长任务（生产导出这类无 job 可轮询的长调用）', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('调用成功 → done，记录结果与耗时', async () => {
    const clock = fakeClock();
    const task = createSingleCallTask<{ files: number }>({
      call: async () => {
        clock.advance(1200);
        return { files: 4 };
      },
      now: clock.now,
      timeoutMs: 60_000,
    });
    const snapshot = await task.startTask();
    expect(snapshot.status).toBe('done');
    expect(snapshot.result).toEqual({ files: 4 });
    expect(snapshot.elapsedMs).toBe(1200);
  });

  it('用户取消 → cancelled，signal 被 abort，措辞不冒充服务端已终止', async () => {
    const task = createSingleCallTask<{ files: number }>({
      call: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
      timeoutMs: 60_000,
    });
    const pending = task.startTask();
    expect(task.snapshot().status).toBe('running');
    const afterCancel = task.cancelTask();
    expect(afterCancel.status).toBe('running');
    expect(afterCancel.note).toMatch(/服务端任务可能仍在执行/);
    const snapshot = await pending;
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.note).toMatch(/以审计与产物目录为准/);
  });

  it('超时 → timeout（不是 failed），明确说明任务可能仍在后台/已落盘', async () => {
    const task = createSingleCallTask<{ files: number }>({
      call: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
      timeoutMs: 30,
    });
    const snapshot = await task.startTask();
    expect(snapshot.status).toBe('timeout');
    expect(snapshot.note).toMatch(/服务端任务可能仍在执行/);
  });

  it('调用失败 → failed 带错误摘要；失败后可重试并成功', async () => {
    let attempt = 0;
    const first = deferred<{ ok: boolean }>();
    const task = createSingleCallTask<{ ok: boolean }>({
      call: async () => {
        attempt += 1;
        if (attempt === 1) return first.promise;
        return { ok: true };
      },
      timeoutMs: 60_000,
    });
    const pending = task.startTask();
    first.reject(new Error('生产导出失败：证据缺失'));
    const failed = await pending;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('证据缺失');
    const retried = await task.startTask();
    expect(retried.status).toBe('done');
    expect(retried.result).toEqual({ ok: true });
  });
});
