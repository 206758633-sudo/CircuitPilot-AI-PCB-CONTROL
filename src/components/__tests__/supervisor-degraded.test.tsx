import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupervisorPanel } from '../SupervisorPanel';
import type { SupervisorAttentionSources, SupervisorTicket } from '../../types';

/**
 * 平台 P1-6：值守队列的"来源降级"必须可见。
 *
 * 回归的坏行为：`/api/supervisor/attention` 某个来源（验证/问题/计划）读失败时，
 * 汇总与票据里该来源为 0，UI 显示"暂无待处理/当前没有需要你处理的事项"——
 * 用户会把"读不到"误读成"没有待办"。
 *
 * 现在服务端带 `sources`（available/reason），UI 必须：
 *  1) 顶部显示降级横幅（点名来源 + reason + "不是没有待办"）；
 *  2) 空队列文案不得再宣称"没有需要你处理的事项"；
 *  3) 老 Runtime 不返回 sources 时不误报降级。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessionToken = 'test-session-token-supervisor-degraded';
let container: HTMLDivElement;
let root: Root;
let attentionBody: unknown;
let sources: SupervisorAttentionSources | undefined;

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const ticket = (patch: Partial<SupervisorTicket> = {}): SupervisorTicket => ({
  ticketId: 'tkt-1',
  fingerprint: 'fp-drc',
  source: 'validation',
  severity: 'error',
  status: 'open',
  title: '官方 DRC 未通过',
  summary: 'DRC 有 1 条违规。',
  projectId: 'proj-1',
  subject: null,
  evidence: [],
  suggestedAction: '重跑 DRC。',
  worker: { name: 'supervisor-readonly', verdict: '等待人工修复', steps: [] },
  createdAt: '2026-11-02T01:00:00.000Z',
  updatedAt: '2026-11-02T01:30:00.000Z',
  lastSeenAt: '2026-11-02T01:30:00.000Z',
  sourceUpdatedAt: null,
  dueAt: null,
  acknowledgedAt: null,
  closedAt: null,
  note: '',
  occurrences: 1,
  ...patch,
});

const view = (tickets: SupervisorTicket[]) => ({
  ok: true,
  generatedAt: '2026-11-02T02:00:00.000Z',
  summary: {
    total: tickets.length,
    attention: tickets.filter((item) => item.status === 'open').length,
    byStatus: { open: tickets.length, acknowledged: 0, blocked: 0, done: 0, dismissed: 0 },
    bySeverity: { critical: 0, error: tickets.length, warning: 0, info: 0 },
    bySource: { validation: 0, issue: tickets.length, plan: 0 },
  },
  tickets,
  ...(sources ? { sources } : {}),
});

const installFetch = () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/health')) return json({ ok: true, service: 'circuitpilot-runtime', version: 'test', sessionProof: sessionToken });
    if (url.endsWith('/api/supervisor/attention')) return json(attentionBody);
    return json({ ok: false, error: { code: 'NOT_MOCKED', message: `unmocked ${url}` } }, 404);
  }));
};

const flush = async (rounds = 16) => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
};

const render = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<SupervisorPanel />); });
  await flush();
};

const degradedBanner = () => container.querySelector('[data-testid="supervisor-degraded"]');

beforeEach(() => {
  installFetch();
  attentionBody = view([ticket()]);
  sources = undefined;
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  vi.unstubAllGlobals();
});

describe('值守队列来源降级横幅（平台 P1-6）', () => {
  it('任一来源 available=false：顶部横幅点名来源与原因，并明确"不是没有待办"', async () => {
    sources = {
      validations: { available: false, reason: 'validation-state.json 损坏（STORE_CORRUPT）' },
      issues: { available: true },
      planRequests: { available: true },
    };
    attentionBody = view([ticket()]);
    await render();

    const banner = degradedBanner();
    expect(banner, '应显示降级横幅').toBeTruthy();
    const text = banner?.textContent || '';
    expect(text).toContain('验证源 不可用：该来源的待办无法列出（不是没有待办）');
    expect(text).toContain('validation-state.json 损坏');
    // 面板角标不能再显示"暂无待处理"这类会把降级当正常的文案。
    expect(container.textContent).toContain('1 个来源不可用');
  });

  it('只有部分来源不可用且队列为空：不得宣称"当前没有需要你处理的事项"', async () => {
    sources = {
      validations: { available: true },
      issues: { available: false, reason: 'issue-state.json 不可读' },
      planRequests: { available: true },
    };
    attentionBody = view([]);
    await render();

    expect(degradedBanner()?.textContent).toContain('问题源 不可用：该来源的待办无法列出（不是没有待办）');
    const text = container.textContent || '';
    expect(text).toContain('不代表没有待办');
    expect(text).not.toContain('当前没有需要你处理的事项；后台只读巡检仍在运行。');
  });

  it('老 Runtime 不返回 sources：不误报降级，空队列仍显示正常文案', async () => {
    sources = undefined;
    attentionBody = view([]);
    await render();

    expect(degradedBanner()).toBeNull();
    expect(container.textContent).toContain('当前没有需要你处理的事项；后台只读巡检仍在运行。');
  });
});
