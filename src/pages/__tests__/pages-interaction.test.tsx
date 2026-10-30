import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../state/AppContext';
import { PartProposalPage } from '../PartProposalPage';
import { SettingsPage } from '../SettingsPage';
import { ValidationPage } from '../ValidationPage';

/**
 * F5：页面级**真实点击**交互（jsdom + 假 fetch），补足只有 SSR 冒烟的空白：
 *   - SettingsPage G4：点「读取外发清单」→ 渲染接口契约清单；
 *   - ValidationPage A4：点「生成两阶段计划」→ 渲染服务端返回的 fail-closed 阻断。
 * 只 mock HTTP，不 mock 页面/控制器逻辑；断言的是用户可见结果。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const token = 'test-token-1234567890';
let container: HTMLDivElement;
let root: Root;

const PROPOSAL = {
  apiVersion: 1, proposalId: 'proposal-f5-1', requirement: 'F5 测试需求', title: 'F5 候选提案', queries: ['WS2812B'], lcscIds: [], nets: [], target: 'schematic', createdAt: '2026-10-20T05:00:00.000Z',
  candidates: [{ candidateId: 'cand-1', name: 'WS2812B-2020', uuid: 'dev-1', libraryUuid: 'lib-1', lcscId: 'C2908603', manufacturer: 'Worldsemi', manufacturerPart: 'WS2812B-2020', description: 'RGB LED', footprintName: 'LED-SMD', symbolName: 'WS2812B', datasheet: null, price: { status: 'priced', unitPrice: 0.05, stock: 12345, currency: 'USD', checkedAt: '2026-10-20T05:00:00.000Z' }, stockNote: null, rank: 1, evidence: { libraryIdentity: true, lcscId: true, price: true, confirmed: false } }],
  summary: { candidates: 1, withLcscId: 1, priced: 1, unknownPrice: 0, stockWarnings: 0 },
};

const BATCH_PLAN = {
  plan: { planHash: 'b'.repeat(64), items: [{ designator: 'U1', action: 'create', reason: '不存在', key: 'k1', coordinate: '(10, 20)', matchedBy: 'refdes' }], counts: { total: 1, create: 1, skipExisting: 0, blocked: 0 }, identityUnproven: [], findings: [] },
};

const EGRESS = {
  schemaVersion: 1, policyVersion: 'g4-test-1', consentMode: 'per-action', consentNote: '每次外发前可预览', orderEnabled: false, redaction: 'pattern-based',
  endpoints: [{ id: 'chat.turn', route: 'POST /api/chat/turn', trigger: '用户发送聊天', data: [{ field: 'message', source: '用户输入' }], excluded: ['令牌'] }],
  notSent: ['本地工程文件二进制'], boundaries: ['只列出实际会发送的字段'],
};

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const installFetch = () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/health')) return json({ ok: true, service: 'circuitpilot-runtime', version: 'test', sessionProof: token });
    if (url.endsWith('/api/providers')) return json({ ok: true, providers: [{ id: 'codex', label: 'Codex', ready: true }] });
    if (url.endsWith('/api/diagnostics')) return json({ ok: true, diagnostics: [] });
    if (url.endsWith('/api/project-state')) return json({ ok: true, state: null, savedAt: null });
    if (url.endsWith('/api/trace-state')) return json({ ok: true, state: { versions: [], changes: [], audit: [] }, savedAt: null });
    if (url.endsWith('/api/issue-state')) return json({ ok: true, state: { issues: [] }, savedAt: null });
    if (url.endsWith('/api/provider/egress') && !url.includes('preview')) return json({ ok: true, egress: EGRESS });
    if (url.endsWith('/api/library/proposals')) return json({ ok: true, proposal: PROPOSAL });
    if (url.endsWith('/api/eda/schematic/component-batch')) return json(BATCH_PLAN);
    if (url.endsWith('/api/automation/flows/pin-first-netlist')) return json({
      ok: true,
      plan: {
        schemaVersion: 1, kind: 'pin-first-netlist-flow', planId: 'f'.repeat(64), executable: false, autoExecute: false, pcbExecutionId: null, pinEvidenceDigest: null,
        blockers: [{ code: 'PIN_FLOW_PCB_NOT_PLACED', message: '先走 R2 落板（需一次性写板批准）' }],
        decisionLog: ['未提供 pcbExecutionId'],
        stages: [
          { id: 'pcb-placement', order: 1, type: 'write', title: '先落器件到 PCB（R2）', dependsOn: [], requiresApproval: true, reason: '焊盘证据来源', expectedEvidence: ['pcbExecutionId'] },
          { id: 'pin-evidence', order: 2, type: 'read', title: '采集引脚证据', dependsOn: ['pcb-placement'], requiresApproval: false, reason: '只读', expectedEvidence: ['evidence.rows'] },
          { id: 'pin-audit', order: 3, type: 'gate', title: '引脚审计', dependsOn: ['pin-evidence'], requiresApproval: false, reason: 'fail-closed', expectedEvidence: ['audit.ok'] },
          { id: 'netlist-ai', order: 4, type: 'ai', title: '生成网表', dependsOn: ['pin-audit'], requiresApproval: false, reason: '带证据', expectedEvidence: ['assumptionAudit'] },
        ],
      },
    });
    return json({ ok: false, error: { code: 'NOT_MOCKED', message: `unmocked ${url}` } }, 404);
  }));
};

const flush = async (rounds = 12) => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
};
const buttonByText = (text: string) => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(text));

beforeEach(() => {
  installFetch();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('F5 页面级交互（真实点击）', () => {
  it('SettingsPage：点「读取外发清单」渲染接口契约（含 chat.turn 与 notSent）', async () => {
    await act(async () => { root.render(<AppProvider><SettingsPage /></AppProvider>); });
    await flush();
    const button = buttonByText('读取外发清单');
    expect(button).toBeTruthy();
    await act(async () => { button?.click(); });
    await flush();
    expect(container.textContent).toContain('chat.turn');
    expect(container.textContent).toContain('本地工程文件二进制');
    expect(container.textContent).toContain('策略 g4-test-1');
    expect(container.textContent).toContain('令牌');
  });

  it('ValidationPage A4：点「生成两阶段计划」渲染 fail-closed 阻断与阶段表', async () => {
    await act(async () => { root.render(<AppProvider><ValidationPage /></AppProvider>); });
    await flush();
    const button = buttonByText('生成两阶段计划');
    expect(button).toBeTruthy();
    await act(async () => { button?.click(); });
    await flush();
    expect(container.textContent).toContain('PIN_FLOW_PCB_NOT_PLACED');
    expect(container.textContent).toContain('先走 R2 落板');
    expect(container.textContent).toContain('先落器件到 PCB（R2）');
    expect(container.textContent).toContain('本页只生成计划');
  });

  it('PartProposalPage D8：点「生成候选提案」走长任务控制器并渲染候选与取消/重试面板', async () => {
    await act(async () => { root.render(<AppProvider><PartProposalPage /></AppProvider>); });
    await flush();
    const button = buttonByText('生成候选提案');
    expect(button).toBeTruthy();
    await act(async () => { button?.click(); });
    await flush(20);
    // 真实 HTTP 假响应 → 候选渲染（不是本地兜底数据）
    expect(container.textContent).toContain('WS2812B-2020');
    expect(container.textContent).toContain('提案');
    // D8 统一长任务面板在场，措辞明确"取消只停止本页等待"
    expect(container.textContent).toContain('候选提案长任务');
    expect(container.textContent).toContain('本页等待');
  });

  it('PartProposalPage D8：点「生成计划（dry-run）」走计划长任务并渲染 planHash（不写板）', async () => {
    await act(async () => { root.render(<AppProvider><PartProposalPage /></AppProvider>); });
    await flush();
    const button = buttonByText('生成计划（dry-run，不写）') ?? buttonByText('生成计划（dry-run）');
    expect(button).toBeTruthy();
    await act(async () => { button?.click(); });
    await flush(20);
    expect(container.textContent).toContain('planHash');
    expect(container.textContent).toContain('总项数');
    expect(container.textContent).toContain('已存在（跳过）');
    expect(container.textContent).toContain('批量落件计划长任务');
  });
});
