import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../state/AppContext';
import { SettingsPage } from '../SettingsPage';

/**
 * 平台 P1-4 / P1-5 的可见面：
 *  - 联网研究面板必须展示 `/api/research/status` 的**运行时真实状态**；
 *    读失败 / 配置损坏时明确显示"状态未知"，不能当成"已关闭"。
 *  - 外发清单（G4）必须前置"清单 = 接口契约，不是全部网络行为"，并展示 server 的 `egress.warnings`。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const token = 'test-token-research-status';
let container: HTMLDivElement;
let root: Root;
let researchStatusResponder: () => { status: number; body: unknown };
let egressResponder: () => { status: number; body: unknown };
let calls: Array<{ method: string; url: string }> = [];

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const configBody = { ok: true, config: { enabled: false, updatedAt: null, actor: null, version: 1 } };

function installFetch() {
  calls = [];
  researchStatusResponder = () => ({ status: 200, body: { ok: true, research: { enabled: false, schedulerRunning: false, sources: [{ id: 'duckduckgo', label: 'DuckDuckGo' }], note: '联网默认关闭' } } });
  egressResponder = () => ({ status: 200, body: { ok: true, egress: { schemaVersion: 1, policyVersion: 'test-policy', consentMode: 'per-action', consentNote: '每次外发都由用户显式触发', orderEnabled: false, redaction: 'redactSecrets', endpoints: [{ id: 'chat.turn', route: 'POST /api/chat/sessions/:id/messages', trigger: '用户点击发送', data: [{ field: 'messages', source: '用户输入' }], excluded: ['API Key'] }], notSent: ['API Key/令牌原文'], boundaries: [], warnings: ['知识维护队列存在 1 条未列出的外发候选，需人工核对'] } } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ method: 'GET', url });
    if (url.endsWith('/api/health')) return json({ ok: true, service: 'circuitpilot-runtime', version: 'test', sessionProof: token });
    if (url.endsWith('/api/providers')) return json({ ok: true, providers: [{ id: 'codex', label: 'Codex', ready: true }] });
    if (url.endsWith('/api/diagnostics')) return json({ ok: true, diagnostics: [] });
    if (url.endsWith('/api/write-gate')) return json({ ok: true, gate: { paused: false, sessionPaused: false } });
    if (url.endsWith('/api/project-state')) return json({ ok: true, state: null, savedAt: null });
    if (url.endsWith('/api/trace-state')) return json({ ok: true, state: { versions: [], changes: [], audit: [] }, savedAt: null });
    if (url.endsWith('/api/issue-state')) return json({ ok: true, state: { issues: [] }, savedAt: null });
    if (url.endsWith('/api/validation-state')) return json({ ok: true, state: { validations: [] }, savedAt: null });
    if (url.endsWith('/api/research/config')) return json(configBody);
    if (url.endsWith('/api/research/status')) {
      const response = researchStatusResponder();
      return json(response.body, response.status);
    }
    if (url.endsWith('/api/provider/egress')) {
      const response = egressResponder();
      return json(response.body, response.status);
    }
    if (url.includes('/api/agent/status')) return json({ ok: true, agent: { available: false, file: null, name: 'agent', scopes: [], createdAt: null, reason: 'RUNTIME_AGENT_DISABLED' }, audit: [], auditIntegrity: { events: 0, anchored: false } });
    if (url.includes('/api/agent/audit')) return json({ ok: true, events: [], total: 0, integrity: { events: 0, anchored: false } });
    if (url.includes('/api/agent/approvals')) return json({ ok: true, total: 0, approvals: [] });
    if (url.includes('/api/agent/plan-requests')) return json({ ok: true, total: 0, requests: [] });
    if (url.includes('/api/approvals/ledger')) return json({ ok: true, entries: [], summary: { total: 0, byScope: {}, byAction: {} }, chain: { ok: true, brokenAt: null, reason: '' }, loadError: null });
    return json({ ok: true });
  }));
}

const flush = async (rounds = 24) => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
};

const render = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<AppProvider><SettingsPage /></AppProvider>); });
  await flush();
};

const researchBlock = () => container.querySelector('[data-testid="research-runtime-status"]');
const clickButton = async (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find((item) => (item.textContent || '').trim() === label);
  expect(button, `找不到按钮 ${label}`).toBeTruthy();
  await act(async () => { (button as HTMLElement).click(); });
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

describe('联网检索真实状态（平台 P1-4）', () => {
  it('status 可读：展示真实 enabled 与调度器状态（不是只回显本地 config）', async () => {
    researchStatusResponder = () => ({ status: 200, body: { ok: true, research: { enabled: true, schedulerRunning: true, note: '联网检索已开启：后台知识维护随之启动', source: 'runtime-file' } } });
    await render();
    expect(calls.some((call) => call.url.endsWith('/api/research/status'))).toBe(true);
    const text = researchBlock()?.textContent || '';
    expect(text).toContain('真实状态：已开启');
    expect(text).toContain('调度器运行中');
    expect(text).toContain('来源 runtime-file');
  });

  it('status 带 loadError（配置损坏）：显示"状态未知"，不冒充"已关闭"', async () => {
    researchStatusResponder = () => ({ status: 200, body: { ok: true, research: { enabled: false, loadError: 'research-config.json 解析失败' } } });
    await render();
    const text = researchBlock()?.textContent || '';
    expect(text).toContain('状态未知');
    expect(text).toContain('research-config.json 解析失败');
    expect(text).toContain('这不代表已关闭');
  });

  it('status 请求失败：显示"状态未知"并给出错误码，而不是当成关闭', async () => {
    researchStatusResponder = () => ({ status: 500, body: { ok: false, error: { code: 'RESEARCH_STATUS_UNAVAILABLE', message: 'status file unreadable' } } });
    await render();
    const text = researchBlock()?.textContent || '';
    expect(text).toContain('状态未知');
    expect(text).toContain('[RESEARCH_STATUS_UNAVAILABLE]');
    expect(text).toContain('这不代表已关闭');
    // 面板角标也必须是"状态未知"，不能显示"默认关闭"。
    expect(container.textContent).toContain('状态未知');
  });
});

describe('数据外发清单边界（平台 P1-5）', () => {
  it('前置说明"清单=接口契约，不是全部网络行为"，并展示 egress.warnings', async () => {
    await render();
    const boundary = container.querySelector('[data-testid="egress-boundary"]')?.textContent || '';
    expect(boundary).toContain('清单 = 接口契约，不是全部网络行为');
    expect(boundary).toContain('不能证明');

    await clickButton('读取外发清单');
    const warnings = container.querySelector('[data-testid="egress-warnings"]')?.textContent || '';
    expect(warnings).toContain('知识维护队列存在 1 条未列出的外发候选');
    // 每条 endpoint 仍展示 route/trigger（原有能力不能被新提示挤掉）。
    expect(container.textContent).toContain('POST /api/chat/sessions/:id/messages');
    expect(container.textContent).toContain('触发：用户点击发送');
  });
});
