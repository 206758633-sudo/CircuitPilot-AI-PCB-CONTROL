/**
 * 插件内 JobManager（内存实现）。
 *
 * 契约 docs/agent/agent-contract.md §4：
 *  - start(kind, requestId, fn) -> { jobId }，同 requestId 幂等（返回同一 job，不重复执行）；
 *  - status / wait / cancel；
 *  - 超时返回 mayHaveTakenEffect:true + jobId；写操作禁止自动重试；
 *  - 结果由工具层裁剪，本模块只负责生命周期与快照。
 *
 * 这是"插件进程内"的任务表：DSH 重启后 job 会丢失（如实标记 interrupted 由上层处理，
 * 本 MVP 不假装可恢复）。Runtime 侧真正的执行记录仍在 CircuitPilot 里，用 cp_job 拿不到时
 * 应回到 cp_status / cp_evidence 核对，而不是重放写。
 */
import { randomUUID } from 'node:crypto';

const TERMINAL_STATES = new Set(['done', 'failed', 'cancelled', 'timeout']);

function jobError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export class JobManager {
  constructor({ now = Date.now, idFactory = () => `job_${randomUUID()}`, defaultTimeoutMs = 300_000, maxJobs = 200 } = {}) {
    this.now = now;
    this.idFactory = idFactory;
    this.defaultTimeoutMs = Number.isFinite(defaultTimeoutMs) && defaultTimeoutMs > 0 ? defaultTimeoutMs : 300_000;
    this.maxJobs = Number.isFinite(maxJobs) && maxJobs > 0 ? Math.floor(maxJobs) : 200;
    this._jobs = new Map(); // jobId -> job
    this._byRequest = new Map(); // requestId -> jobId
    this._waiters = new Map(); // jobId -> Set<resolve>
  }

  /** 同 requestId 的既有 job（没有则 null）。 */
  find(requestId) {
    if (typeof requestId !== 'string' || !requestId) return null;
    const jobId = this._byRequest.get(requestId);
    return jobId ? this._jobs.get(jobId) ?? null : null;
  }

  get(jobId) {
    return this._jobs.get(jobId) ?? null;
  }

  /**
   * 启动一个 job。requestId 必填；同 id 返回既有 job（deduped:true），不重复执行。
   *
   * @param {string} kind 任务类型（例如 design.execute / pcb.execute / validation.run / export）
   * @param {string} requestId 幂等键（写操作必须由调用方生成）
   * @param {(context:{jobId:string, requestId:string, kind:string, signal:AbortSignal, job:object}) => Promise<any>} fn
   * @param {{timeoutMs?:number, mayHaveTakenEffect?:boolean, metadata?:object, label?:string}} [options]
   */
  start(kind, requestId, fn, options = {}) {
    if (typeof requestId !== 'string' || !requestId.trim()) {
      throw jobError('REQUEST_ID_REQUIRED', '长任务/写操作必须提供非空 requestId（用于幂等与去重）');
    }
    if (typeof fn !== 'function') throw jobError('JOB_FUNCTION_REQUIRED', 'JobManager.start 需要可执行函数');
    const cleanRequestId = requestId.trim();
    const existing = this.find(cleanRequestId);
    if (existing) return { ...this.snapshot(existing), deduped: true };

    const now = this.now();
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : this.defaultTimeoutMs;
    const job = {
      jobId: this.idFactory(),
      kind: String(kind || 'job'),
      requestId: cleanRequestId,
      label: options.label ? String(options.label).slice(0, 200) : null,
      state: 'queued',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      timeoutMs,
      mayHaveTakenEffect: options.mayHaveTakenEffect === true,
      metadata: options.metadata && typeof options.metadata === 'object' ? { ...options.metadata } : null,
      result: null,
      error: null,
      lateResult: null,
      lateError: null,
      controller: new AbortController(),
    };
    this._jobs.set(job.jobId, job);
    this._byRequest.set(job.requestId, job.jobId);
    this._prune();

    const timer = setTimeout(() => this._timeout(job), Math.max(1, timeoutMs));
    queueMicrotask(async () => {
      if (job.state !== 'queued') {
        clearTimeout(timer);
        this._settle(job);
        return;
      }
      job.state = 'running';
      job.startedAt = this.now();
      try {
        const value = await fn({
          jobId: job.jobId,
          requestId: job.requestId,
          kind: job.kind,
          signal: job.controller.signal,
          job,
        });
        if (job.state === 'running' || job.state === 'queued') {
          job.state = 'done';
          job.result = value === undefined ? null : value;
          job.finishedAt = this.now();
        } else {
          job.lateResult = value === undefined ? null : value;
        }
      } catch (error) {
        const failure = {
          code: typeof error?.code === 'string' && error.code ? error.code : 'JOB_FAILED',
          message: String(error?.message || error || '任务失败').slice(0, 1000),
        };
        if (job.state === 'running' || job.state === 'queued') {
          job.state = 'failed';
          job.error = { ...failure, mayHaveTakenEffect: error?.mayHaveTakenEffect === true };
          job.finishedAt = this.now();
        } else {
          job.lateError = failure;
        }
      } finally {
        clearTimeout(timer);
        this._settle(job);
      }
    });
    return this.snapshot(job);
  }

  snapshot(jobOrId) {
    const job = typeof jobOrId === 'string' ? this._jobs.get(jobOrId) : jobOrId;
    if (!job) return null;
    return {
      jobId: job.jobId,
      kind: job.kind,
      requestId: job.requestId,
      label: job.label,
      state: job.state,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      timeoutMs: job.timeoutMs,
      mayHaveTakenEffect: job.mayHaveTakenEffect,
      metadata: job.metadata,
      result: job.state === 'done' ? job.result : null,
      error: job.error,
      lateResult: job.lateResult ?? null,
      lateError: job.lateError ?? null,
      terminal: TERMINAL_STATES.has(job.state),
    };
  }

  status(jobId) {
    return this.snapshot(jobId);
  }

  list({ limit = 20 } = {}) {
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    const jobs = [...this._jobs.values()].slice(-max).reverse().map((job) => {
      const snap = this.snapshot(job);
      if (snap) delete snap.result; // 列表不带结果，避免上下文爆炸；用 status 查
      return snap;
    });
    return jobs;
  }

  /**
   * 等待 job 进入终态或等待超时。
   * 超时返回 { found:true, timedOut:true, job }（不是错误：调用方应提示"仍在跑/可能已生效"）。
   */
  async wait(jobId, { timeoutMs = 30_000, signal } = {}) {
    const job = this._jobs.get(jobId);
    if (!job) return { found: false, timedOut: false, job: null };
    if (TERMINAL_STATES.has(job.state)) return { found: true, timedOut: false, job: this.snapshot(job) };
    const waitMs = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : 30_000;
    if (signal?.aborted) return { found: true, timedOut: false, job: this.snapshot(job), aborted: true };

    return await new Promise((resolvePromise) => {
      let settled = false;
      const finish = (timedOut) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (waiterSet) waiterSet.delete(onSettle);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolvePromise({ found: true, timedOut, job: this.snapshot(job), ...(signal?.aborted ? { aborted: true } : {}) });
      };
      const onSettle = () => finish(false);
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(true), Math.max(0, waitMs));
      if (timer.unref) timer.unref();
      let waiterSet = this._waiters.get(jobId);
      if (!waiterSet) {
        waiterSet = new Set();
        this._waiters.set(jobId, waiterSet);
      }
      waiterSet.add(onSettle);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 取消：标记 cancelled 并 abort；已结束则返回 cancelled:false。不假装副作用已回滚。 */
  cancel(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return { found: false, cancelled: false, job: null };
    if (TERMINAL_STATES.has(job.state)) {
      return { found: true, cancelled: false, job: this.snapshot(job), reason: 'already_finished' };
    }
    job.state = 'cancelled';
    job.finishedAt = this.now();
    job.error = {
      code: 'JOB_CANCELLED',
      message: '任务已取消（底层调用可能仍在 EDA 侧执行；请用 cp_status/cp_evidence 核对是否已生效）',
      mayHaveTakenEffect: job.mayHaveTakenEffect,
    };
    try {
      job.controller.abort();
    } catch {
      /* ignore */
    }
    this._settle(job);
    return { found: true, cancelled: true, job: this.snapshot(job) };
  }

  /** 插件卸载时取消所有在途 job（在途写仍可能已生效，不自动回滚）。 */
  cancelAll() {
    const cancelled = [];
    for (const job of this._jobs.values()) {
      if (!TERMINAL_STATES.has(job.state)) {
        job.state = 'cancelled';
        job.finishedAt = this.now();
        job.error = {
          code: 'PLUGIN_SHUTDOWN',
          message: '插件卸载/会话结束，任务被取消；副作用可能已发生，请回到 CircuitPilot 核对',
          mayHaveTakenEffect: job.mayHaveTakenEffect,
        };
        try {
          job.controller.abort();
        } catch {
          /* ignore */
        }
        cancelled.push(job.jobId);
        this._settle(job);
      }
    }
    return cancelled;
  }

  _timeout(job) {
    if (TERMINAL_STATES.has(job.state)) return;
    job.state = 'timeout';
    job.finishedAt = this.now();
    job.error = {
      code: 'JOB_TIMEOUT',
      message: `任务超过 ${job.timeoutMs}ms 未完成；超时不代表没有生效，禁止自动重试写操作`,
      mayHaveTakenEffect: job.mayHaveTakenEffect,
    };
    try {
      job.controller.abort();
    } catch {
      /* ignore */
    }
    this._settle(job);
  }

  _settle(job) {
    const waiters = this._waiters.get(job.jobId);
    this._waiters.delete(job.jobId);
    if (!waiters) return;
    for (const resolveWaiter of [...waiters]) {
      try {
        resolveWaiter();
      } catch {
        /* ignore */
      }
    }
  }

  _prune() {
    if (this._jobs.size <= this.maxJobs) return;
    for (const [jobId, job] of this._jobs) {
      if (this._jobs.size <= this.maxJobs) break;
      if (!TERMINAL_STATES.has(job.state)) continue;
      this._jobs.delete(jobId);
      if (this._byRequest.get(job.requestId) === jobId) this._byRequest.delete(job.requestId);
    }
  }
}
