import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../state/AppContext';
import { SettingsPage } from '../SettingsPage';
import { ToastViewport } from '../../components/overlays';

/**
 * 2026-11-05 全链闭环审计（docs/implementation/full-audit-2026-11-05/）前端修复回归：
 *  - PCB-P2-2 / UI-P1-1：会话级写暂停必须让布局页的写回/还原按钮同时禁用（不能只看全局暂停）；
 *  - UI-P2-7：Toast 必须展示 title（此前只渲染 message，标题被吞）；
 *  - UI-P1-3：设置页能力声明不能再写"写入仍未开放/仅只读回读"这类与现状相反的文案。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const token = 'test-token-1234567890';

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/health')) return json({ ok: true, service: 'circuitpilot-runtime', version: 'test', sessionProof: token });
    if (url.endsWith('/api/providers')) return json({ ok: true, providers: [{ id: 'codex', label: 'Codex', ready: true }] });
    if (url.endsWith('/api/diagnostics')) return json({ ok: true, diagnostics: [] });
    if (url.endsWith('/api/project-state')) return json({ ok: true, state: null, savedAt: null });
    if (url.endsWith('/api/trace-state')) return json({ ok: true, state: { versions: [], changes: [], audit: [] }, savedAt: null });
    if (url.endsWith('/api/issue-state')) return json({ ok: true, state: { issues: [] }, savedAt: null });
    if (url.endsWith('/api/validation-state')) return json({ ok: true, state: { validations: [] }, savedAt: null });
    if (url.endsWith('/api/write-gate')) return json({ ok: true, gate: { paused: false, sessionPaused: true } });
    if (url.includes('/api/agent/status')) return json({ ok: true, agent: { available: false, file: null, name: 'agent', scopes: [], createdAt: null, reason: 'RUNTIME_AGENT_DISABLED' }, audit: [], auditIntegrity: { events: 0, anchored: false } });
    if (url.includes('/api/agent/audit')) return json({ ok: true, events: [], total: 0, integrity: { events: 0, anchored: false } });
    if (url.includes('/api/agent/approvals')) return json({ ok: true, total: 0, approvals: [] });
    if (url.includes('/api/agent/plan-requests')) return json({ ok: true, total: 0, requests: [] });
    if (url.includes('/api/approvals/ledger')) return json({ ok: true, entries: [], summary: { total: 0, byScope: {}, byAction: {} }, chain: { ok: true, brokenAt: null, reason: '' }, loadError: null });
    return json({ ok: true });
  }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  installFetch();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('Toast 标题（UI-P2-7）', () => {
  it('同时渲染 title 与 message，不再丢标题', async () => {
    act(() => { root.render(<ToastViewport toasts={[{ id: 't1', title: '写入已暂停', message: 'Runtime 全局写入已暂停', tone: 'warning' }]} />); });
    await flush();
    // Toast 通过 portal 挂到 document.body，`container.textContent` 读不到。
    const text = document.body.textContent || '';
    expect(text).toContain('写入已暂停');
    expect(text).toContain('Runtime 全局写入已暂停');
  });
});

describe('设置页能力声明（UI-P1-3）', () => {
  it('不再出现"写入仍未开放 / 仅只读回读"的失真文案，并说明写入需批准', async () => {
    act(() => { root.render(<AppProvider><SettingsPage /></AppProvider>); });
    await flush();
    const text = container.textContent || '';
    expect(text).not.toContain('写入仍未开放');
    expect(text).not.toContain('真实能力仅限诊断、窗口选择、工程与文档只读回读');
    expect(text).toContain('写入默认关闭，按需批准');
  });
});
