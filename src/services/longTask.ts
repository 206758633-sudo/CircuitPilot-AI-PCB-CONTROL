/**
 * D8：统一长任务控制器（轮询 / 取消 / 超时 / 重试）。
 *
 * 为什么单独抽出来：DRC、布线、导出这类长任务各自的页面都在手写"for 循环 + sleep"，
 * 取消/超时/失败措辞各写一遍，容易把"本页停止等待"说成"任务已取消"。这里把状态机定死：
 *   idle → running → done | failed | timeout | cancelled
 * 语义纪律：
 *   - 取消只代表"本页停止等待"，服务端任务是否收尾以审计/报告为准（note 里写清楚）；
 *   - 超时同理：任务可能仍在后台跑，不冒充 failed/cancelled；
 *   - 重试 = 重新走 start（调用方保证 start 幂等或可重复受理）。
 */
export type LongTaskStatus = 'idle' | 'running' | 'done' | 'failed' | 'timeout' | 'cancelled';

export interface LongTaskSnapshot<TPoll> {
  status: LongTaskStatus;
  polls: number;
  startedAt: number | null;
  finishedAt: number | null;
  elapsedMs: number;
  result: TPoll | null;
  error: string | null;
  note: string | null;
}

export interface LongTaskPollResult<TPoll> {
  status: 'running' | 'done' | 'failed' | 'cancelled';
  result?: TPoll | null;
  error?: string | null;
}

export interface LongTaskOptions<TStart, TPoll> {
  start: () => Promise<TStart>;
  poll: (started: TStart) => Promise<LongTaskPollResult<TPoll>>;
  cancel?: (started: TStart) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxPolls?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onUpdate?: (snapshot: LongTaskSnapshot<TPoll>) => void;
}

export interface LongTaskController<TStart, TPoll> {
  startTask: () => Promise<LongTaskSnapshot<TPoll>>;
  cancelTask: () => Promise<LongTaskSnapshot<TPoll>>;
  reset: () => LongTaskSnapshot<TPoll>;
  snapshot: () => LongTaskSnapshot<TPoll>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createLongTask<TStart, TPoll>(options: LongTaskOptions<TStart, TPoll>): LongTaskController<TStart, TPoll> {
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 2_000);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 180_000);
  const maxPolls = Math.max(1, options.maxPolls ?? 200);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;

  let status: LongTaskStatus = 'idle';
  let polls = 0;
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let result: TPoll | null = null;
  let error: string | null = null;
  let note: string | null = null;
  let started: TStart | null = null;
  let cancelRequested = false;
  let runningPromise: Promise<LongTaskSnapshot<TPoll>> | null = null;

  const snapshot = (): LongTaskSnapshot<TPoll> => ({
    status,
    polls,
    startedAt,
    finishedAt,
    elapsedMs: startedAt === null ? 0 : Math.max(0, (finishedAt ?? now()) - startedAt),
    result,
    error,
    note,
  });
  const update = () => { options.onUpdate?.(snapshot()); return snapshot(); };
  const finish = (next: LongTaskStatus, extra: { error?: string | null; note?: string | null } = {}) => {
    status = next;
    error = extra.error ?? null;
    note = extra.note ?? null;
    finishedAt = now();
    return update();
  };

  const startTask = async (): Promise<LongTaskSnapshot<TPoll>> => {
    if (runningPromise) return runningPromise;
    status = 'running';
    polls = 0;
    startedAt = now();
    finishedAt = null;
    result = null;
    error = null;
    note = null;
    started = null;
    cancelRequested = false;
    update();
    runningPromise = (async () => {
      try {
        started = await options.start();
        if (cancelRequested) return finish('cancelled', { note: '启动完成前已请求取消：本页停止等待，服务端任务是否收尾以审计/报告为准' });
        for (let attempt = 0; attempt < maxPolls; attempt += 1) {
          if (timeoutMs > 0 && now() - (startedAt ?? now()) > timeoutMs) {
            return finish('timeout', { note: '超时只是停止本页轮询：后台任务可能仍在执行，稍后刷新报告或看审计链确认' });
          }
          const polled = await options.poll(started);
          polls += 1;
          if (polled?.status === 'done') { result = polled.result ?? null; return finish('done'); }
          if (polled?.status === 'failed') return finish('failed', { error: polled.error || '任务执行失败（服务端未给出具体原因）' });
          if (polled?.status === 'cancelled') return finish('cancelled', { note: '服务端任务已取消' });
          update();
          if (cancelRequested) return finish('cancelled', { note: '已请求取消：本页停止等待，服务端任务是否收尾以审计/报告为准' });
          await sleep(pollIntervalMs);
        }
        return finish('timeout', { error: `轮询次数达到上限（${maxPolls} 次）`, note: '任务可能仍在后台执行' });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return finish('failed', { error: message.slice(0, 400) });
      } finally {
        runningPromise = null;
      }
    })();
    return runningPromise;
  };

  const cancelTask = async (): Promise<LongTaskSnapshot<TPoll>> => {
    if (status !== 'running') return snapshot();
    cancelRequested = true;
    if (started && options.cancel) {
      try {
        await options.cancel(started);
        note = '已请求服务端取消；本页停止轮询，最终状态以服务端任务/审计为准';
      } catch (caught) {
        note = `请求服务端取消失败：${caught instanceof Error ? caught.message.slice(0, 200) : String(caught).slice(0, 200)}`;
      }
    } else {
      note = '本页停止等待；服务端任务是否收尾以审计/报告为准';
    }
    // 让轮询循环在下一个检查点收尾；不能在这里直接把 running 改成 cancelled（可能吞掉刚完成的 done）。
    update();
    return snapshot();
  };

  const reset = () => {
    status = 'idle'; polls = 0; startedAt = null; finishedAt = null; result = null; error = null; note = null; started = null; cancelRequested = false;
    return update();
  };

  return { startTask, cancelTask, reset, snapshot };
}
/**
 * D8（单调用版）：一次 HTTP/长调用没有服务端 job 可轮询时（例如生产导出），
 * 仍然需要统一的"运行中/完成/失败/超时/停止等待"状态与中断能力。
 *
 * 与 createLongTask 的区别：没有 start→poll 两段，直接 await 一个可中断的调用；
 * 取消 = 中断本页请求（AbortSignal），**不代表服务端已终止**——导出这类操作可能已在服务端落盘，
 * 所以 cancelled/timeout 的 note 必须提示"以审计与产物目录为准"。
 */
export interface SingleCallOptions<TResult> {
  call: (signal: AbortSignal) => Promise<TResult>;
  timeoutMs?: number;
  now?: () => number;
  onUpdate?: (snapshot: LongTaskSnapshot<TResult>) => void;
}

export interface SingleCallController<TResult> {
  startTask: () => Promise<LongTaskSnapshot<TResult>>;
  cancelTask: () => LongTaskSnapshot<TResult>;
  reset: () => LongTaskSnapshot<TResult>;
  snapshot: () => LongTaskSnapshot<TResult>;
}

export function createSingleCallTask<TResult>(options: SingleCallOptions<TResult>): SingleCallController<TResult> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 240_000);
  const now = options.now ?? (() => Date.now());
  let status: LongTaskStatus = 'idle';
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let result: TResult | null = null;
  let error: string | null = null;
  let note: string | null = null;
  let controller: AbortController | null = null;
  let runningPromise: Promise<LongTaskSnapshot<TResult>> | null = null;
  let cancelled = false;
  let timedOut = false;

  const snapshot = (): LongTaskSnapshot<TResult> => ({
    status,
    polls: 0,
    startedAt,
    finishedAt,
    elapsedMs: startedAt === null ? 0 : Math.max(0, (finishedAt ?? now()) - startedAt),
    result,
    error,
    note,
  });
  const update = () => { options.onUpdate?.(snapshot()); return snapshot(); };
  const finish = (next: LongTaskStatus, extra: { error?: string | null; note?: string | null } = {}) => {
    status = next;
    error = extra.error ?? null;
    note = extra.note ?? null;
    finishedAt = now();
    controller = null;
    return update();
  };

  const startTask = async (): Promise<LongTaskSnapshot<TResult>> => {
    if (runningPromise) return runningPromise;
    const localController = new AbortController();
    controller = localController;
    cancelled = false;
    timedOut = false;
    status = 'running';
    startedAt = now();
    finishedAt = null;
    result = null;
    error = null;
    note = '长任务进行中；取消只停止本页等待，不代表服务端已终止';
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; localController.abort(); }, timeoutMs) : null;
    runningPromise = (async () => {
      try {
        result = await options.call(localController.signal);
        return finish('done', { note: null });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        // 主动取消/超时优先按对应状态收尾（底层请求通常以 AbortError 拒绝）。
        if (cancelled) return finish('cancelled', { note: '已停止本页等待：服务端任务可能仍在执行或已落盘，以审计与产物目录为准' });
        if (timedOut) return finish('timeout', { error: `超过 ${Math.round(timeoutMs / 1000)}s 未返回`, note: '超时只是停止本页等待：服务端任务可能仍在执行或已落盘，稍后看审计/产物目录' });
        return finish('failed', { error: message.slice(0, 400) });
      } finally {
        if (timer) clearTimeout(timer);
        runningPromise = null;
      }
    })();
    return runningPromise;
  };

  const cancelTask = (): LongTaskSnapshot<TResult> => {
    if (status !== 'running' || !controller) return snapshot();
    cancelled = true;
    note = '已请求中断本页等待：服务端任务可能仍在执行或已落盘，以审计与产物目录为准';
    controller.abort();
    return update();
  };

  const reset = () => {
    status = 'idle'; startedAt = null; finishedAt = null; result = null; error = null; note = null; controller = null;
    return update();
  };

  return { startTask, cancelTask, reset, snapshot };
}
