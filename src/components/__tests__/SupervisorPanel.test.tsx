import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupervisorPanel } from '../SupervisorPanel';
import type { SupervisorTicket, SupervisorTicketStatus } from '../../types';

/**
 * C 方案「只读 Agent 值守队列」组件测试：真实渲染 + 假 fetch（不 mock 组件/runtimeClient 逻辑）。
 *
 * 断言的是用户可见结果 + 实际发出的 HTTP 路由：加载渲染、空态、GET 失败错误码与重试、
 * 接单 POST 后刷新，以及"不写 EDA / 不自动执行"的文案边界。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessionToken = 'test-session-token-supervisor';
let container: HTMLDivElement;
let root: Root;
let calls: Array<{ method: string; url: string; body: unknown }> = [];
let attentionResponder: () => { status: number; body: unknown };
let ticketResponder: (ticketId: string, action: string) => { status: number; body: unknown };

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const baseTicket = (patch: Partial<SupervisorTicket> = {}): SupervisorTicket => ({
  ticketId: 'tkt-1',
  fingerprint: 'fp-drc-clearance',
  source: 'validation',
  severity: 'error',
  status: 'open',
  title: '官方 DRC 未通过：U3 焊盘间距不足',
  summary: 'DRC 报告有 2 条间距违规，未修复前不能进入生产放行。',
  projectId: 'proj-1',
  subject: { pcbUuid: 'pcb-1' },
  evidence: [
    { kind: 'drc-report', ref: 'artifacts/drc/report.json', digest: 'a'.repeat(64) },
    { kind: 'official-pcb-drc', ref: 'job-42', digest: null },
  ],
  suggestedAction: '打开验证页重跑 DRC；或登记豁免后重新取证。',
  worker: { name: 'supervisor-readonly', verdict: '等待人工修复，未自动执行', steps: ['读取 DRC 报告', '定位违规焊盘'] },
  createdAt: '2026-11-02T01:00:00.000Z',
  updatedAt: '2026-11-02T01:30:00.000Z',
  lastSeenAt: '2026-11-02T01:30:00.000Z',
  sourceUpdatedAt: '2026-11-02T01:20:00.000Z',
  dueAt: null,
  acknowledgedAt: null,
  closedAt: null,
  note: '',
  occurrences: 2,
  ...patch,
});

const count = (tickets: SupervisorTicket[], pick: (ticket: SupervisorTicket) => string) => tickets.reduce<Record<string, number>>((acc, ticket) => {
  const key = pick(ticket);
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

const attentionBody = (tickets: SupervisorTicket[]) => ({
  ok: true,
  generatedAt: '2026-11-02T02:00:00.000Z',
  summary: {
    total: tickets.length,
    attention: tickets.filter((ticket) => ticket.status === 'open' || ticket.status === 'acknowledged' || ticket.status === 'blocked').length,
    byStatus: { open: 0, acknowledged: 0, blocked: 0, done: 0, dismissed: 0, ...count(tickets, (ticket) => ticket.status) },
    bySeverity: { critical: 0, error: 0, warning: 0, info: 0, ...count(tickets, (ticket) => ticket.severity) },
    bySource: { validation: 0, issue: 0, plan: 0, ...count(tickets, (ticket) => ticket.source) },
  },
  tickets,
});

const installFetch = () => {
  calls = [];
  attentionResponder = () => ({ status: 200, body: attentionBody([baseTicket()]) });
  ticketResponder = (ticketId, action) => ({
    status: 200,
    body: { ok: true, ticket: { ...baseTicket({ ticketId }), status: (action === 'ack' ? 'acknowledged' : action === 'dismiss' ? 'dismissed' : 'done') as SupervisorTicketStatus } },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });
    if (url.endsWith('/api/health')) return json({ ok: true, service: 'circuitpilot-runtime', version: 'test', sessionProof: sessionToken });
    if (url.endsWith('/api/supervisor/attention')) {
      const response = attentionResponder();
      return json(response.body, response.status);
    }
    const ticketRoute = url.match(/\/api\/supervisor\/tickets\/([^/]+)\/(ack|dismiss|resolve)$/);
    if (ticketRoute && method === 'POST') {
      const response = ticketResponder(decodeURIComponent(ticketRoute[1]), ticketRoute[2]);
      return json(response.body, response.status);
    }
    return json({ ok: false, error: { code: 'NOT_MOCKED', message: `unmocked ${method} ${url}` } }, 404);
  }));
};

const flush = async (rounds = 16) => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
};
const buttons = () => Array.from(document.querySelectorAll('button'));
const buttonByText = (text: string) => buttons().find((item) => (item.textContent || '').trim() === text);
const click = async (element: Element | undefined | null) => {
  expect(element, '找不到可点击元素').toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
};
const callsTo = (method: string, suffix: string) => calls.filter((item) => item.method === method && item.url.includes(suffix));

const render = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SupervisorPanel />);
  });
  await flush();
};

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '';
  installFetch();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe('只读 Agent 值守队列（SupervisorPanel）', () => {
  it('挂载即加载并渲染票据：来源/严重度/状态、标题、摘要、建议动作、证据、更新时间与「去处理」', async () => {
    attentionResponder = () => ({
      status: 200,
      body: attentionBody([
        baseTicket(),
        baseTicket({ ticketId: 'tkt-2', source: 'plan', severity: 'warning', status: 'acknowledged', title: '待审批：PCB 布线计划未签核', summary: '计划等待人工批准后才能执行。', acknowledgedAt: '2026-11-02T01:40:00.000Z' }),
      ]),
    });
    await render();
    expect(callsTo('GET', '/api/supervisor/attention')).toHaveLength(1);
    const text = container.textContent || '';
    expect(text).toContain('官方 DRC 未通过：U3 焊盘间距不足');
    expect(text).toContain('DRC 报告有 2 条间距违规');
    expect(text).toContain('打开验证页重跑 DRC');
    expect(text).toContain('证据 2 条');
    expect(text).toContain('drc-report');
    expect(text).toContain('验证');
    expect(text).toContain('计划');
    expect(text).toContain('已接单');
    expect(text).toContain('更新');
    expect(text).toContain('值守建议');
    expect(text).toContain('不会自动执行');
    // 每张票都有「去处理」；open 票才有「接单」
    expect(buttons().filter((item) => (item.textContent || '').trim() === '去处理')).toHaveLength(2);
    expect(buttons().filter((item) => (item.textContent || '').trim() === '接单')).toHaveLength(1);
    // 「去处理」直接改 hash 跳现有页签（validation → #validation）
    await click(buttons().find((item) => (item.textContent || '').trim() === '去处理'));
    expect(window.location.hash).toBe('#validation');
  });

  it('空态显示"当前没有需要你处理的事项；后台只读巡检仍在运行。"且不报错', async () => {
    attentionResponder = () => ({ status: 200, body: attentionBody([]) });
    await render();
    expect(container.textContent).toContain('当前没有需要你处理的事项；后台只读巡检仍在运行。');
    expect(container.textContent).not.toContain('读取值守队列失败');
    expect(buttons().some((item) => (item.textContent || '').trim() === '接单')).toBe(false);
  });

  it('GET 失败显示 RuntimeApiError 错误码/说明并可重试恢复', async () => {
    attentionResponder = () => ({ status: 500, body: { ok: false, error: { code: 'SUPERVISOR_UNAVAILABLE', message: 'aggregator offline' } } });
    await render();
    expect(container.textContent).toContain('读取值守队列失败');
    expect(container.textContent).toContain('[SUPERVISOR_UNAVAILABLE] aggregator offline');
    const retry = buttonByText('重试');
    expect(retry).toBeTruthy();

    // 重试时后端恢复：应能渲染真实列表且错误提示消失。
    attentionResponder = () => ({ status: 200, body: attentionBody([baseTicket()]) });
    await click(retry);
    expect(container.textContent).toContain('官方 DRC 未通过：U3 焊盘间距不足');
    expect(container.textContent).not.toContain('读取值守队列失败');
    expect(callsTo('GET', '/api/supervisor/attention')).toHaveLength(2);
  });

  it('点击「接单」发出 POST 并刷新队列（状态以 Runtime 返回为准）', async () => {
    let acknowledged = false;
    attentionResponder = () => ({
      status: 200,
      body: attentionBody([baseTicket(acknowledged ? { status: 'acknowledged', acknowledgedAt: '2026-11-02T02:10:00.000Z' } : {})]),
    });
    ticketResponder = (ticketId, action) => {
      acknowledged = action === 'ack';
      return { status: 200, body: { ok: true, ticket: baseTicket({ ticketId, status: acknowledged ? 'acknowledged' : 'open' }) } };
    };
    await render();
    const ack = buttonByText('接单');
    expect(ack).toBeTruthy();
    await click(ack);

    const posts = callsTo('POST', '/api/supervisor/tickets/tkt-1/ack');
    expect(posts).toHaveLength(1);
    // 操作后重新拉取队列（GET 次数 1 → 2），并显示 Runtime 返回的"已接单"。
    expect(callsTo('GET', '/api/supervisor/attention')).toHaveLength(2);
    expect(container.textContent).toContain('已接单');
    expect(buttonByText('接单')).toBeFalsy();
  });

  it('点击「忽略」先确认；确认后 POST dismiss 并从队列移除', async () => {
    let dismissed = false;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      attentionResponder = () => ({ status: 200, body: attentionBody(dismissed ? [] : [baseTicket()]) });
      ticketResponder = (ticketId, action) => {
        if (action === 'dismiss') dismissed = true;
        return { status: 200, body: { ok: true, ticket: baseTicket({ ticketId, status: action === 'dismiss' ? 'dismissed' : 'open' }) } };
      };
      await render();
      await click(buttonByText('忽略'));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(callsTo('POST', '/api/supervisor/tickets/tkt-1/dismiss')).toHaveLength(1);
      expect(container.textContent).toContain('当前没有需要你处理的事项');
    } finally {
      confirm.mockRestore();
    }
  });

  it('文案明确只读：无写 EDA / 无自动执行 / 无下单或自动修复入口', async () => {
    await render();
    const text = container.textContent || '';
    expect(text).toContain('只读值守');
    expect(text).toContain('不写 EDA');
    expect(text).toContain('不会自动执行');
    expect(text).toContain('任何写入仍需你在那里人工批准');
    const labels = buttons().map((item) => (item.textContent || '').trim());
    expect(labels.some((label) => /自动执行|写入|下单|自动修复/.test(label))).toBe(false);
  });
});
