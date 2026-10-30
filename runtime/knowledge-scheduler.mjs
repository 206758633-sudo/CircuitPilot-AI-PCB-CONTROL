import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * KMA 定时调度（W3-18）：把"badcase 采集 + 网页知识抓取 + 定期维护"挂到运行时定时器上。
 *
 * 设计：
 *   - 计时/持久化可注入（单测不联网、不等真时间）；
 *   - 状态落 stateFile：最近一次运行摘要、下一次时间、历史（最多 10 条）；
 *   - 运行失败只记录原因码，不抛给 HTTP/定时器（避免一次断网拖垮运行时）；
 *   - 同一时刻只允许一轮（running 标志），避免人工触发与定时任务并发写库。
 */

export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INITIAL_DELAY_MS = 2 * 60 * 1000;
const HISTORY_LIMIT = 10;

const stateTemplate = () => ({ schemaVersion: 1, enabled: true, intervalMs: null, lastRunAt: null, nextRunAt: null, lastResult: null, history: [] });

export function createKnowledgeScheduler({
  manager,
  stateFile = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  now = () => new Date(),
  timers = { setTimeout, clearTimeout },
  fileIo = { readFileSync, writeFileSync, mkdirSync, existsSync },
} = {}) {
  if (!manager || typeof manager.runCycle !== 'function') throw Object.assign(new Error('调度器需要 KMA manager'), { code: 'KMA_SCHEDULER_INVALID' });
  if (!Number.isFinite(intervalMs) || intervalMs < 60_000) throw Object.assign(new Error('定时间隔不能小于 60 秒'), { code: 'KMA_SCHEDULER_INVALID' });

  let state = stateTemplate();
  let timer = null;
  let running = false;

  const load = () => {
    state = stateTemplate();
    if (!stateFile || !fileIo.existsSync(stateFile)) return state;
    try {
      const raw = JSON.parse(fileIo.readFileSync(stateFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        state = {
          ...state,
          enabled: raw.enabled !== false,
          intervalMs: Number.isFinite(Number(raw.intervalMs)) && Number(raw.intervalMs) >= 60_000 ? Number(raw.intervalMs) : intervalMs,
          lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
          nextRunAt: typeof raw.nextRunAt === 'string' ? raw.nextRunAt : null,
          lastResult: raw.lastResult && typeof raw.lastResult === 'object' ? raw.lastResult : null,
          history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_LIMIT) : [],
        };
      }
    } catch { state = stateTemplate(); state.corrupt = true; }
    if (Number.isFinite(intervalMs)) state.intervalMs = intervalMs;
    return state;
  };

  const persist = () => {
    if (!stateFile) return;
    try {
      fileIo.mkdirSync(dirname(stateFile), { recursive: true });
      fileIo.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch { /* 状态写失败不影响知识库本身；status 会给 lastResult 保留原因 */ }
  };

  const status = () => ({
    enabled: state.enabled,
    intervalMs: state.intervalMs ?? intervalMs,
    lastRunAt: state.lastRunAt,
    nextRunAt: state.nextRunAt,
    running,
    lastResult: state.lastResult,
    history: state.history,
    corruptState: state.corrupt === true,
  });

  const schedule = (delay) => {
    if (timer) { timers.clearTimeout(timer); timer = null; }
    if (!state.enabled) return;
    state.nextRunAt = new Date(now().getTime() + Math.max(1_000, Number(delay) || initialDelayMs)).toISOString();
    timer = timers.setTimeout(() => runNow({ reason: 'schedule' }).finally(() => { if (state.enabled) schedule(state.intervalMs ?? intervalMs); }), Math.max(1_000, Number(delay) || initialDelayMs));
    if (timer && typeof timer.unref === 'function') timer.unref();
    persist();
  };

  const runNow = async ({ reason = 'manual', tasks = ['badcases', 'web', 'maintain'] } = {}) => {
    if (running) return { ok: false, code: 'KMA_BUSY', message: '上一轮维护仍在运行' };
    running = true;
    const startedAt = now().toISOString();
    let cycle;
    try {
      cycle = await manager.runCycle({ tasks });
    } catch (error) {
      cycle = { ok: false, code: error?.code ?? 'KMA_RUN_FAILED', message: String(error?.message || error).slice(0, 240), startedAt, finishedAt: now().toISOString(), tasks };
    }
    running = false;
    const finishedAt = now().toISOString();
    state.lastRunAt = finishedAt;
    state.lastResult = summarize(cycle, reason);
    state.history = [...state.history, { at: finishedAt, reason, ok: cycle.ok !== false, badcases: cycle.badcases?.created ?? null, web: cycle.web?.created ?? null, pendingReview: cycle.maintenance?.pendingReview ?? null }].slice(-HISTORY_LIMIT);
    if (state.enabled) state.nextRunAt = new Date(now().getTime() + (state.intervalMs ?? intervalMs)).toISOString();
    persist();
    return cycle;
  };

  const start = () => { state.enabled = true; schedule(initialDelayMs); return status(); };
  const stop = () => { state.enabled = false; if (timer) { timers.clearTimeout(timer); timer = null; } state.nextRunAt = null; persist(); return status(); };

  load();
  return { load, start, stop, runNow, status, persist };
}

function summarize(cycle, reason) {
  const failed = [];
  if (cycle.badcases?.ok === false) failed.push({ task: 'badcases', code: cycle.badcases.code ?? null });
  if (cycle.web?.ok === false) failed.push({ task: 'web', code: cycle.web.code ?? null, failed: cycle.web.failed?.length ?? 0 });
  if (cycle.maintenance?.ok === false) failed.push({ task: 'maintain', code: cycle.maintenance.code ?? null });
  if (cycle.ok === false && failed.length === 0) failed.push({ task: Array.isArray(cycle.tasks) ? cycle.tasks.join(',') : 'cycle', code: cycle.code ?? null });
  return {
    reason,
    ok: cycle.ok !== false,
    startedAt: cycle.startedAt ?? null,
    finishedAt: cycle.finishedAt ?? null,
    badcases: cycle.badcases ? { created: cycle.badcases.created ?? 0, duplicates: cycle.badcases.duplicates ?? 0, candidates: cycle.badcases.candidates ?? 0 } : null,
    web: cycle.web ? { created: cycle.web.created ?? 0, failed: cycle.web.failed?.length ?? 0, collectors: cycle.web.collectors ?? 0 } : null,
    maintenance: cycle.maintenance ? { pendingReview: cycle.maintenance.pendingReview ?? 0, expired: cycle.maintenance.expired?.count ?? 0, conflicts: cycle.maintenance.conflicts?.count ?? 0, evidencePath: cycle.maintenance.evidencePath ?? null } : null,
    failed,
  };
}
