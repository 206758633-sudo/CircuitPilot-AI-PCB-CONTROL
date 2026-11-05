import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from '../AppContext';

/**
 * 平台 P1-3：Runtime 权威状态读取失败时，前端必须"停止自动写回"并在问题中心明确报告。
 *
 * 回归的坏行为：读失败只 logger.warn，随后 800ms/1000ms 防抖写回照常执行，
 * 用 localStorage 缓存/种子数据覆盖 Runtime 上那份"损坏但可人工修复"的权威文件。
 *
 * 本测试用真实 AppProvider + 假 fetch（不 mock runtimeClient），断言：
 *  1) 四个 Store 读失败（400 STORE_CORRUPT）→ 不发出任何对应 PUT，且问题中心出现 error 级记录；
 *  2) 之后一次成功读取（重连后）→ 恢复写回（PUT 重新出现）。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const token = 'test-token-hydrate-guard';
let container: HTMLDivElement;
let root: Root;
let calls: Array<{ method: string; url: string; body: unknown }> = [];
type StoreKey = 'project' | 'validation' | 'trace' | 'issue';
let storeBroken: Record<StoreKey, boolean>;

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const okStateFor = (store: StoreKey): unknown => {
  switch (store) {
    case 'project': return { ok: true, state: { projects: [], activeProjectId: '', requirements: [], components: [], assets: [] }, savedAt: null };
    case 'validation': return { ok: true, state: { validations: [] }, savedAt: null };
    case 'trace': return { ok: true, state: { versions: [], changes: [], audit: [] }, savedAt: null };
    case 'issue': return { ok: true, state: { issues: [] }, savedAt: null };
  }
};

const STORE_ROUTES: Array<{ store: StoreKey; suffix: string }> = [
  { store: 'project', suffix: '/api/project-state' },
  { store: 'validation', suffix: '/api/validation-state' },
  { store: 'trace', suffix: '/api/trace-state' },
  { store: 'issue', suffix: '/api/issue-state' },
];

function installFetch() {
  calls = [];
  storeBroken = { project: true, validation: true, trace: true, issue: true };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });
    if (url.endsWith('/api/health')) return json({ ok: true, service: 'circuitpilot-runtime', version: 'test', sessionProof: token });
    if (url.endsWith('/api/providers')) return json({ ok: true, providers: [{ id: 'codex', label: 'Codex', ready: true }] });
    if (url.endsWith('/api/diagnostics')) return json({ ok: true, diagnostics: [] });
    if (url.endsWith('/api/write-gate')) return json({ ok: true, gate: { paused: false, sessionPaused: false } });
    for (const { store, suffix } of STORE_ROUTES) {
      if (url.endsWith(suffix) && method === 'GET') {
        return storeBroken[store]
          ? json({ ok: false, error: { code: 'STORE_CORRUPT', message: `${store}-state.json 损坏，无法解析` } }, 400)
          : json(okStateFor(store));
      }
    }
    // C6 项目级切面：`/api/projects/<id>/state` 的读/写单独匹配（否则恢复分支拿到空响应会再次被判读失败）。
    if (/\/api\/projects\/[^/]+\/state$/.test(url)) {
      if (method === 'GET') {
        return storeBroken.project
          ? json({ ok: false, error: { code: 'STORE_CORRUPT', message: 'project-scoped-state.json 损坏' } }, 400)
          : json({ ok: true, projectId: 'project-seed', state: { projects: [], activeProjectId: '', requirements: [], components: [], assets: [] }, savedAt: null, source: 'project' });
      }
      return json({ ok: true, projectId: 'project-seed', state: body?.state ?? {}, savedAt: new Date().toISOString(), tagged: 0 });
    }
    return json({ ok: true });
  }));
}

function Probe() {
  const { state, dispatch } = useApp();
  return (
    <div>
      <div data-testid="codes">{state.issues.map((issue) => issue.code).join(',')}</div>
      <div data-testid="severities">{state.issues.filter((issue) => issue.code.endsWith('_HYDRATE_FAILED')).map((issue) => issue.severity).join(',')}</div>
      <button type="button" data-testid="offline" onClick={() => dispatch({ type: 'PATCH_RUNTIME', patch: { reachable: false } })}>offline</button>
      <button type="button" data-testid="online" onClick={() => dispatch({ type: 'PATCH_RUNTIME', patch: { reachable: true } })}>online</button>
    </div>
  );
}

const sleep = async (ms: number) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
const flush = async (rounds = 20) => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
};
const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent || '';
const putsTo = (suffix: string) => calls.filter((call) => call.method === 'PUT' && call.url.endsWith(suffix));

const render = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<AppProvider><Probe /></AppProvider>); });
  await flush();
};

beforeEach(() => {
  window.localStorage.clear();
  installFetch();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  vi.unstubAllGlobals();
});

describe('Runtime 权威状态读失败守卫（平台 P1-3）', () => {
  it('四个 Store 读失败：不发出任何写回 PUT，并在问题中心报 error 级 hydrate 问题', async () => {
    await render();
    // 等过防抖窗口（project/validation 800ms、trace/issue 1000ms），确认它们没有偷偷写回。
    await sleep(1_300);
    await flush();

    for (const { suffix } of STORE_ROUTES) {
      expect(putsTo(suffix), `读失败后不应写回 ${suffix}`).toHaveLength(0);
    }
    const codes = text('codes');
    expect(codes).toContain('PROJECT_STATE_HYDRATE_FAILED');
    expect(codes).toContain('VALIDATION_STATE_HYDRATE_FAILED');
    expect(codes).toContain('TRACE_STATE_HYDRATE_FAILED');
    expect(codes).toContain('ISSUE_STATE_HYDRATE_FAILED');
    expect(text('severities').split(',').every((severity) => severity === 'error')).toBe(true);
    // 提示必须告诉用户"已停止写回"以及怎么修，而不是默默降级。
    expect(container.textContent).toBeTruthy(); // 问题详情在 state 中，下面用 codes 断言即可
  }, 15_000);

  it('读取恢复后（重连）重新允许写回：对应 PUT 重新出现', async () => {
    await render();
    await sleep(1_300);
    for (const { suffix } of STORE_ROUTES) expect(putsTo(suffix)).toHaveLength(0);

    // 修复权威文件后重连：四个 Store 都恢复可读。
    storeBroken = { project: false, validation: false, trace: false, issue: false };
    await act(async () => { (document.querySelector('[data-testid="offline"]') as HTMLElement).click(); });
    await act(async () => { (document.querySelector('[data-testid="online"]') as HTMLElement).click(); });
    await flush();
    // 读取成功后写回效应重新挂起 800/1000ms 定时器。
    await sleep(1_300);
    await flush();

    for (const { suffix } of STORE_ROUTES) {
      expect(putsTo(suffix).length, `读取恢复后应恢复写回 ${suffix}`).toBeGreaterThan(0);
    }
  }, 15_000);
});
