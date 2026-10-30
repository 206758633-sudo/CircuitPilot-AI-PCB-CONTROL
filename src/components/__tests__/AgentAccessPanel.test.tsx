import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../state/AppContext';
import { AgentAccessPanel } from '../AgentAccessPanel';

/**
 * 设置页「Agent 接入」面板：真实渲染 + 假 fetch（不 mock 组件/客户端逻辑）。
 * 覆盖两条关键路径：旧 Runtime 无路由（404）必须降级不白屏；可用态展示元数据/审计且绝不出现令牌原文；
 * 以及轮换的二次确认 + 成功文案。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessionToken = 'test-session-token-12345';
let container: HTMLDivElement;
let root: Root;
let calls: Array<{ method: string; url: string; body: unknown }> = [];
let statusResponse: { body: unknown; status: number };
let auditResponse: { body: unknown; status: number };
let rotateResponse: { body: unknown; status: number };
let ledgerResponse: { body: unknown; status: number };
let approvalsResponse: { body: unknown; status: number };
let revokeApprovalResponse: { body: unknown; status: number };
let planRequestsResponse: { body: unknown; status: number };
let planDecisionResponse: { body: unknown; status: number };

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const availableAgent = {
  available: true,
  file: '/Users/tester/Library/Application Support/CircuitPilot/agent-token.json',
  name: 'dsh-plugin',
  scopes: ['read', 'plan', 'execute'],
  createdAt: '2026-10-29T02:00:00.000Z',
};

const auditEvents = [
  { at: '2026-10-29T03:00:00.000Z', kind: 'tool', actor: 'dsh-plugin', method: 'POST', path: '/api/agent/tools/plan', outcome: 'ok' },
  { at: '2026-10-29T03:01:00.000Z', kind: 'tool', actor: 'dsh-plugin', method: 'POST', path: '/api/agent/tools/execute', outcome: 'denied' },
];

const installFetch = (status = 200, integrity?: Record<string, unknown>) => {
  calls = [];
  statusResponse = status === 200
    ? { body: { ok: true, agent: availableAgent, audit: auditEvents, ...(integrity ? { auditIntegrity: integrity } : {}) }, status: 200 }
    : { body: { ok: false, error: { code: 'RUNTIME_HTTP_ERROR', message: 'not found' } }, status };
  auditResponse = { body: { ok: true, events: auditEvents, total: 2, ...(integrity ? { integrity } : {}) }, status: 200 };
  rotateResponse = { body: { ok: true, agent: { ...availableAgent, createdAt: '2026-10-29T04:00:00.000Z', rotated: true } }, status: 200 };
  ledgerResponse = { body: { ok: true, entries: [], summary: { total: 0, byScope: {}, byAction: {} }, chain: { ok: true, brokenAt: null, reason: '' }, loadError: null }, status: 200 };
  approvalsResponse = { body: { ok: true, total: 0, approvals: [] }, status: 200 };
  revokeApprovalResponse = { body: { ok: true, cancelled: true, kind: 'design', approvalId: 'approval-pending-1' }, status: 200 };
  planRequestsResponse = { body: { ok: true, total: 0, requests: [] }, status: 200 };
  planDecisionResponse = { body: { ok: true, request: { requestId: 'apr_0123456789abcdef', status: 'approved' } }, status: 200 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });
    if (url.endsWith('/api/health')) return json({ ok: true, service: 'circuitpilot-runtime', version: 'test', sessionProof: sessionToken });
    if (url.endsWith('/api/diagnostics')) return json({ ok: true, diagnostics: {} });
    if (url.endsWith('/api/providers')) return json({ ok: true, providers: [] });
    if (url.endsWith('/api/project-state')) return json({ ok: true, state: null, savedAt: null });
    if (url.endsWith('/api/trace-state')) return json({ ok: true, state: { versions: [], changes: [], audit: [] }, savedAt: null });
    if (url.endsWith('/api/issue-state')) return json({ ok: true, state: { issues: [] }, savedAt: null });
    if (url.endsWith('/api/validation-state')) return json({ ok: true, state: { validations: [] }, savedAt: null });
    if (url.endsWith('/api/write-gate')) return json({ ok: true, gate: { paused: false } });
    if (url.endsWith('/api/agent/status')) return json(statusResponse.body, statusResponse.status);
    if (url.includes('/api/agent/audit')) return json(auditResponse.body, auditResponse.status);
    if (url.includes('/api/agent/plan-requests')) {
      if (url.includes('/decision')) return json(planDecisionResponse.body, planDecisionResponse.status);
      return json(planRequestsResponse.body, planRequestsResponse.status);
    }
    if (url.endsWith('/api/agent/token/rotate')) return json(rotateResponse.body, rotateResponse.status);
    if (url.includes('/api/approvals/ledger')) return json(ledgerResponse.body, ledgerResponse.status);
    if (url.includes('/api/agent/approvals/') && url.endsWith('/revoke')) return json(revokeApprovalResponse.body, revokeApprovalResponse.status);
    if (url.endsWith('/api/agent/approvals')) return json(approvalsResponse.body, approvalsResponse.status);
    return json({ ok: false, error: { code: 'NOT_MOCKED', message: `unmocked ${method} ${url}` } }, 404);
  }));
};

const flush = async (rounds = 16) => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
};
const buttonByText = (text: string) => Array.from(document.querySelectorAll('button')).find((item) => (item.textContent || '').trim() === text);
const badgeTexts = () => Array.from(container.querySelectorAll('.badge')).map((item) => (item.textContent || '').trim());
const click = async (element: Element | undefined | null) => {
  expect(element, '找不到可点击元素').toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
};

const render = async () => {
  root = createRoot(container);
  await act(async () => {
    root.render(<AppProvider><AgentAccessPanel /></AppProvider>);
  });
  await flush();
};

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('设置页 Agent 接入面板', () => {
  it('旧 Runtime 没有 /api/agent/*（404）时降级为说明文案，不白屏、不假装"无令牌"', async () => {
    installFetch(404);
    await render();
    expect(container.textContent).toContain('该 Runtime 版本尚未提供 Agent 控制台');
    expect(container.textContent).not.toContain('Agent 令牌不可用');
    expect(callsTo('GET', '/api/agent/status')).toHaveLength(1);
  });

  it('可用态展示文件路径/scopes/创建时间与最近审计，且页面不出现令牌原文', async () => {
    installFetch(200);
    await render();
    expect(container.textContent).toContain('/Users/tester/Library/Application Support/CircuitPilot/agent-token.json');
    expect(container.textContent).toContain('read · plan · execute');
    expect(container.textContent).toContain('dsh-plugin');
    expect(container.textContent).toContain('/api/agent/tools/plan');
    expect(container.textContent).toContain('成功');
    expect(container.textContent).toContain('denied');
    // 服务端不返回令牌原文，UI 也不得凭空展示任何 cpa_ 前缀内容。
    expect(container.textContent).not.toContain('cpa_');
    // 旧 Runtime 没有 auditIntegrity 字段 → 不显示任何完整性徽标，也不显示"链校验"统计。
    expect(badgeTexts().some((text) => text.includes('审计链') || text.includes('旧格式'))).toBe(false);
    expect(container.textContent).not.toContain('链校验：');
    expect(callsTo('GET', '/api/agent/audit')).toHaveLength(1);
    expect(calls[0]?.url ?? '').toBeTruthy();
  });

  it('轮换必须二次确认；成功文案说明旧令牌立即失效、插件自动读取新令牌，且不显示令牌原文', async () => {
    installFetch(200);
    await render();
    await click(buttonByText('轮换 Agent 令牌'));
    // 确认弹窗走 portal 挂到 body，不在面板容器内。
    expect(document.body.textContent).toContain('轮换 Agent 令牌？');
    await click(buttonByText('确认轮换'));
    expect(callsTo('POST', '/api/agent/token/rotate')).toHaveLength(1);
    expect(container.textContent).toContain('旧令牌已立即失效');
    expect(container.textContent).not.toContain('cpa_');
  });
});

describe('设置页 Agent 接入面板 · 审计链完整性（task-26 契约）', () => {
  it('chain=ok：审计标题旁显示"审计链完整"徽标 + verified/legacy/badLines 统计', async () => {
    installFetch(200, { ok: true, chain: 'ok', verified: true, legacy: false, badLines: 0 });
    await render();
    expect(badgeTexts()).toContain('审计链完整');
    expect(container.textContent).toContain('verified 是');
    expect(container.textContent).toContain('无旧格式');
    expect(container.textContent).toContain('badLines 0');
    expect(container.textContent).not.toContain('审计链异常');
  });

  it('chain=broken：红色告警要求保留现场，且不提供修复/清空入口', async () => {
    installFetch(200, { ok: false, chain: 'broken', verified: false, legacy: 3, badLines: 2, firstBadSeq: 5, reason: 'hash mismatch' });
    await render();
    expect(badgeTexts()).toContain('审计链异常');
    expect(container.textContent).toContain('首个异常行 #5');
    expect(container.textContent).toContain('请保留现场');
    expect(container.textContent).toContain('hash mismatch');
    expect(container.textContent).toContain('3 行旧格式');
    // 只读面板：不提供修复/清空按钮（避免把证据一起抹掉）。
    const texts = Array.from(document.querySelectorAll('button')).map((item) => (item.textContent || '').trim());
    expect(texts.some((text) => text.includes('修复') || text.includes('清空'))).toBe(false);
  });

  it('chain=legacy：显示"含旧格式"警示徽标（warning），不当成异常', async () => {
    installFetch(200, { ok: true, chain: 'legacy', verified: true, legacy: true, badLines: 0 });
    await render();
    expect(badgeTexts()).toContain('含旧格式');
    expect(badgeTexts()).not.toContain('审计链异常');
    expect(badgeTexts()).not.toContain('审计链完整');
  });
});

describe('设置页 Agent 接入面板 · 批准账本（UI 审批控制台只读）', () => {
  const ledgerEntry = {
    index: 0,
    at: '2026-10-29T05:00:00.000Z',
    scope: 'plan',
    action: 'issued',
    approvalId: 'approval-1234567890abcdef',
    bindings: { planHash: 'planhash-abcdef1234567890', windowId: 'window-abcdef123456', targetFingerprint: 'fingerprint-xyz' },
    note: '',
    prevHash: 'GENESIS',
    entryHash: 'entryhash-123',
  };

  it('正常账本：展示作用域/动作、批准 ID 与 plan/window 前缀，且不出现令牌原文', async () => {
    installFetch(200);
    ledgerResponse = { body: { ok: true, entries: [ledgerEntry], summary: { total: 1, byScope: { plan: 1 }, byAction: { issued: 1 } }, chain: { ok: true, brokenAt: null, reason: '' }, loadError: null }, status: 200 };
    await render();
    expect(container.textContent).toContain('批准账本');
    expect(container.textContent).toContain('plan / issued');
    expect(container.textContent).toContain('approval'); // 批准 ID 前缀
    expect(container.textContent).toContain('planhash-abc'); // planHash 前缀
    expect(container.textContent).toContain('window-abc'); // windowId 前缀
    expect(container.textContent).not.toContain('cpa_');
    expect(badgeTexts()).toContain('账本链完整');
  });

  it('账本链异常：红色告警要求保留现场，且不提供修复/清空入口', async () => {
    installFetch(200);
    ledgerResponse = { body: { ok: true, entries: [ledgerEntry], summary: { total: 1, byScope: { plan: 1 }, byAction: { issued: 1 } }, chain: { ok: false, brokenAt: 0, reason: 'entryHash mismatch' }, loadError: null }, status: 200 };
    await render();
    expect(badgeTexts()).toContain('账本链异常');
    expect(container.textContent).toContain('保留现场');
    expect(container.textContent).toContain('entryHash mismatch');
    const texts = Array.from(document.querySelectorAll('button')).map((item) => (item.textContent || '').trim());
    expect(texts.some((text) => text.includes('修复') || text.includes('清空'))).toBe(false);
  });

  it('空账本：显示“暂无批准记录”空态', async () => {
    installFetch(200);
    await render();
    expect(container.textContent).toContain('暂无批准记录');
  });

  it('旧 Runtime 没有批准账本（404）：只隐藏账本区块，不影响令牌与审计', async () => {
    installFetch(200);
    ledgerResponse = { body: { ok: false, error: { code: 'ROUTE_NOT_FOUND', message: 'not found' } }, status: 404 };
    await render();
    expect(container.textContent).toContain('Agent 令牌');
    expect(container.textContent).toContain('该 Runtime 版本尚未提供批准账本');
    expect(container.textContent).not.toContain('账本链异常');
  });

  it('审计锚点：anchored=true → 已锚定；false → 未锚定（旧审计）', async () => {
    installFetch(200, { ok: true, chain: 'ok', verified: true, legacy: false, badLines: 0, anchored: true });
    await render();
    expect(badgeTexts()).toContain('已锚定');

    act(() => root?.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    installFetch(200, { ok: true, chain: 'ok', verified: true, legacy: false, badLines: 0, anchored: false });
    await render();
    expect(badgeTexts()).toContain('未锚定（旧审计）');
  });
});

describe('设置页 Agent 接入面板 · 待执行批准（UI 撤销）', () => {
  const pending = {
    approvalId: 'approval-pending-1',
    kind: 'design',
    scope: 'plan',
    bindings: { planHash: 'pending-plan-hash-123456', windowId: 'pending-window-1', targetFingerprint: 'fp' },
    note: '',
    issuedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 240_000,
  };

  it('展示已签发未使用的批准、计划/窗口前缀与过期时间，不出现令牌原文', async () => {
    installFetch(200);
    approvalsResponse = { body: { ok: true, total: 1, approvals: [pending] }, status: 200 };
    await render();
    expect(container.textContent).toContain('待执行批准');
    expect(container.textContent).toContain('1 条待执行');
    expect(container.textContent).toContain('pending-plan');
    expect(container.textContent).toContain('pending-wi');
    expect(container.textContent).not.toContain('cpa_');
    expect(callsTo('GET', '/api/agent/approvals')).toHaveLength(1);
  });

  it('空队列显示“暂无待执行批准”，不渲染撤销按钮', async () => {
    installFetch(200);
    await render();
    expect(container.textContent).toContain('暂无待执行批准');
    expect(buttonByText('撤销')).toBeFalsy();
  });

  it('撤销必须二次确认；确认后 POST 到 revoke 并刷新队列', async () => {
    installFetch(200);
    approvalsResponse = { body: { ok: true, total: 1, approvals: [pending] }, status: 200 };
    await render();
    await click(buttonByText('撤销'));
    expect(document.body.textContent).toContain('撤销这条待执行批准？');
    approvalsResponse = { body: { ok: true, total: 0, approvals: [] }, status: 200 };
    await click(buttonByText('确认撤销'));
    expect(callsTo('POST', '/api/agent/approvals/approval-pending-1/revoke')).toHaveLength(1);
    expect(container.textContent).toContain('暂无待执行批准');
    expect(container.textContent).not.toContain('cpa_');
  });

  it('旧 Runtime 没有待执行批准路由（404）：只隐藏该区块，不影响审计/账本', async () => {
    installFetch(200);
    approvalsResponse = { body: { ok: false, error: { code: 'ROUTE_NOT_FOUND', message: 'not found' } }, status: 404 };
    await render();
    expect(container.textContent).toContain('该 Runtime 版本尚未提供待执行批准');
    expect(container.textContent).toContain('批准账本');
  });
});

describe('设置页 Agent 接入面板 · 计划级审查请求', () => {
  const pendingPlan = {
    requestId: 'apr_0123456789abcdef',
    kind: 'design',
    planHash: 'a'.repeat(64),
    targetFingerprint: 'fp-target-1',
    windowId: 'win-1',
    projectId: 'project-1',
    documentUuid: 'doc-1',
    title: '给 C25 增加去耦电容',
    summary: 'ready；operations 3；risk 1',
    risks: ['会改动电源网络'],
    missing: [],
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400_000,
  };

  it('展示计划级请求；批准必须二次确认，POST body 带 decision/confirm，不显示 token', async () => {
    installFetch(200);
    planRequestsResponse = { body: { ok: true, total: 1, requests: [pendingPlan] }, status: 200 };
    planDecisionResponse = { body: { ok: true, request: { ...pendingPlan, status: 'approved' } }, status: 200 };
    await render();

    expect(container.textContent).toContain('计划级审查请求');
    expect(container.textContent).toContain('给 C25 增加去耦电容');
    expect(container.textContent).toContain('待审查');
    expect(container.textContent).not.toContain('cpa_');

    await click(buttonByText('批准'));
    expect(document.body.textContent).toContain('批准这条计划请求？');
    expect(document.body.textContent).toContain('UI 只记录人工决定');
    await click(buttonByText('确认批准'));

    const calls = callsTo('POST', '/api/agent/plan-requests/apr_0123456789abcdef/decision');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ decision: 'approve', confirm: true });
    expect(calls[0]?.body ?? {}).not.toHaveProperty('approvalToken');
  });

  it('拒绝必须二次确认，POST body 带 decision=reject，且不显示 token', async () => {
    installFetch(200);
    planRequestsResponse = { body: { ok: true, total: 1, requests: [pendingPlan] }, status: 200 };
    planDecisionResponse = { body: { ok: true, request: { ...pendingPlan, status: 'rejected' } }, status: 200 };
    await render();

    await click(buttonByText('拒绝'));
    expect(document.body.textContent).toContain('拒绝这条计划请求？');
    await click(buttonByText('确认拒绝'));

    const calls = callsTo('POST', '/api/agent/plan-requests/apr_0123456789abcdef/decision');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ decision: 'reject', confirm: true });
    expect(container.textContent).not.toContain('cpa_');
  });

  it('已批准请求显示等待 Agent cp_approve', async () => {
    installFetch(200);
    planRequestsResponse = { body: { ok: true, total: 1, requests: [{ ...pendingPlan, status: 'approved' }] }, status: 200 };
    await render();
    expect(container.textContent).toContain('已批准（等待 Agent）');
    expect(container.textContent).toContain('等待 Agent cp_approve');
    expect(buttonByText('批准')).toBeUndefined();
  });
});

describe('设置页 Agent 接入面板 · 审批 deep link', () => {
  it('?agent=approvals#settings 会滚动到待执行批准区；区块存在稳定 id', async () => {
    installFetch(200);
    approvalsResponse = { body: { ok: true, total: 0, approvals: [] }, status: 200 };
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      window.history.replaceState(null, '', '/?agent=approvals#settings');
      await render();
      expect(container.querySelector('#agent-approvals')).toBeTruthy();
      expect(scroll).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('?agent=plans 指向计划级审查请求区（深链）', async () => {
    installFetch(200);
    planRequestsResponse = { body: { ok: true, total: 0, requests: [] }, status: 200 };
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      window.history.replaceState(null, '', '/?agent=plans#settings');
      await render();
      expect(container.querySelector('#agent-plan-requests')).toBeTruthy();
      expect(scroll).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('?agent=ledger 指向批准账本；未知 agent 值不滚动', async () => {
    installFetch(200);
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      window.history.replaceState(null, '', '/?agent=ledger#settings');
      await render();
      expect(container.querySelector('#agent-ledger')).toBeTruthy();
      expect(scroll).toHaveBeenCalled();

      act(() => root?.unmount());
      container.remove();
      container = document.createElement('div');
      document.body.appendChild(container);
      scroll.mockClear();
      window.history.replaceState(null, '', '/?agent=nonsense#settings');
      await render();
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

const callsTo = (method: string, suffix: string) => calls.filter((item) => item.method === method && item.url.includes(suffix));
