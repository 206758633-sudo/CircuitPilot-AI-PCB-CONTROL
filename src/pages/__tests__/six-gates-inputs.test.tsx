import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, STORAGE_KEY } from '../../state/AppContext';
import { createSeedState } from '../../data/seed';
import type { AppState, ComponentItem, Project } from '../../types';
import { VerificationCenterPage } from '../VerificationCenterPage';
import { PlacementPage } from '../PlacementPage';
import {
  buildBoardSpec, buildGateComponents, formatIntentNetlistText, parseIntentNetlistText,
  readReviewedNetlistHandoff, REVIEWED_NETLIST_HANDOFF_KEY, saveReviewedNetlistHandoff,
  summarizeGateComponentSources,
} from '../../services/gateEvidenceInputs';

/**
 * 全链审计 P0-1（2026-11-05）：六门前端输入通道。
 * 这里断言的是"请求体真的带上了用户填的输入"，而不是页面"看起来有输入框"：
 *  · G1 boards / G2 eda+supply 映射 / G3 intentNetlist 必须出现在 gates/collect 请求体里；
 *  · 没填完整时**不能**上传 boards，页面要如实展示 missing；
 *  · G5 人工确认（userConfirmed:true）只出现在真实写回，预演不能带。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const token = 'test-token-1234567890';
let container: HTMLDivElement;
let root: Root;
let requests: Array<{ path: string; method: string; body: any }> = [];

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const flush = async (rounds = 16) => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
};
// 按钮可能渲染在容器里，也可能在 Modal 的 body portal 里（确认写回），所以从 document.body 查。
const buttonByText = (text: string) => Array.from(document.body.querySelectorAll('button')).find((item) => item.textContent?.includes(text));
const setFieldValue = async (label: string, value: string) => {
  const field = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
  expect(field).toBeTruthy();
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** 一块已绑定 EDA 的板 + 一个带 EDA 库绑定/一个没有的器件，用来区分 G2 三源映射。 */
const buildState = (): AppState => {
  const seed = createSeedState();
  const baseProject = seed.projects[0];
  const project: Project = {
    ...baseProject,
    edaWorkspace: {
      projectUuid: 'proj-1', boardName: '测试主板', schematicUuid: 'sch-1', schematicPageUuid: 'page-1',
      pcbUuid: 'pcb-1', schematicStatus: 'generated',
    },
  };
  const components: ComponentItem[] = seed.components.map((item, index) => index === 0 ? {
    ...item,
    easyEdaBinding: {
      uuid: 'dev-uuid-1', name: 'nRF52840', libraryUuid: 'lib-1',
      symbol: { name: 'nRF52840', uuid: 'sym-1', libraryUuid: 'lib-1' },
      footprint: { name: 'aQFN-73', uuid: 'fp-1', libraryUuid: 'lib-1' },
      model3D: { name: 'nRF52840.step', uuid: '3d-1', libraryUuid: 'lib-1' },
      boundAt: '2026-10-01T00:00:00.000Z',
    },
  } : item);
  return { ...seed, activeProjectId: project.id, projects: [project], components };
};

const gateReport = (missingKinds: string[] = []) => ({
  verdict: 'unknown', targetPcbUuid: 'pcb-1', blockedGates: [], unknownGates: ['G1', 'G2', 'G3'], notImplementedGates: [],
  gates: [
    { id: 'G1', name: '规格门', purpose: '板卡规格可校验', requiredKinds: ['design-spec'], verdict: 'unknown', evidenceDigests: [], missing: missingKinds.includes('design-spec') ? ['design-spec'] : [], reasons: [] },
    { id: 'G2', name: '器件身份门', purpose: 'EDA/供应商/资料三源', requiredKinds: ['lib-evidence'], verdict: 'unknown', evidenceDigests: [], missing: missingKinds.includes('lib-evidence') ? ['lib-evidence'] : [], reasons: [] },
    { id: 'G3', name: '网表门', purpose: '意图网表 vs 实际网表', requiredKinds: ['netlist-diff'], verdict: 'unknown', evidenceDigests: [], missing: missingKinds.includes('netlist-diff') ? ['netlist-diff'] : [], reasons: [] },
  ],
});

const pricingEvidence = {
  kind: 'supply-pricing', freshnessKnown: true, source: 'lcsc', checkedAt: '2026-11-01T00:00:00.000Z',
  entries: [
    { lcsc: 'C190794', status: 'priced', price: 1.5, currency: 'CNY', stock: 120, checkedAt: '2026-11-01T00:00:00.000Z', url: 'https://example.test/C190794' },
    { lcsc: 'C2836819', status: 'unknown', price: null, currency: null, stock: null },
  ],
  unknownEntries: [{ lcsc: 'C2836819', status: 'unknown', reason: 'NOT_FOUND' }],
  summary: { requested: 2, priced: 1, unknown: 1 },
};

const placementPlanResponse = {
  ok: true, source: 'auto-placement', outline: { points: [[0, 0], [45, 0], [45, 30], [0, 30]], closed: true },
  componentCount: 1, unknownSize: [], affinity: { netCount: 1, topPairs: [] as Array<[string, number]> },
  plan: {
    ok: true,
    placements: [{ ref: 'U1', primitiveId: 'p-1', xMm: 10, yMm: 10, rotationDeg: 0, side: 'top', widthMm: 5, heightMm: 5, current: { xMm: 12, yMm: 12, rotationDeg: 0 } }],
    unplaced: [], findings: [],
    stats: { placedCount: 1, unplacedCount: 0, gridMm: 1, edgeClearanceMm: 1, spacingMm: 1, utilization: 0.4 },
  },
  verification: { ok: true, checkedCount: 1, findings: [] },
  currentVerification: { ok: true, checkedCount: 1, findings: [] },
  diff: { rows: [], movedCount: 1, newCount: 0, unchangedCount: 0 },
};

const installFetch = (state: AppState, collectResponse: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('http://127.0.0.1:4178', '');
    const method = (init?.method || 'GET').toUpperCase();
    let body: any = null;
    if (init?.body) { try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); } }
    requests.push({ path, method, body });
    if (path.startsWith('/api/health')) return json({ ok: true, service: 'circuitpilot-runtime', version: 'test', sessionProof: token });
    if (path === '/api/providers') return json({ ok: true, providers: [] });
    if (path === '/api/diagnostics') return json({ ok: true, diagnostics: [] });
    if (path === '/api/project-state') return json({ ok: true, state, savedAt: null });
    if (path.startsWith('/api/projects/') && path.endsWith('/state')) return json({ ok: true, projectId: 'proj-1', state, savedAt: null, source: 'project' });
    if (path.startsWith('/api/eda/gates/status')) return json({ ok: true, report: gateReport(), evidenceRefs: [] });
    if (path === '/api/eda/gates/collect') return json(collectResponse);
    if (path === '/api/supply/pricing') return json({ ok: true, pricing: pricingEvidence });
    if (path === '/api/automation/approvals') return json({ ok: true, approval: { approvalId: 'appr-1' } });
    if (path === '/api/eda/pcb/placement/plan') return json(placementPlanResponse);
    if (path === '/api/eda/pcb/placement/apply') return json({ ok: true, applied: body?.dryRun !== true, saved: false, dryRun: body?.dryRun === true, updates: [], skipped: [], missing: [], steps: [], findings: [], verified: { ok: true, checkedCount: 1, findings: [] }, rollback: null });
    return json({ ok: true, state: null, savedAt: null });
  }));
};

beforeEach(() => {
  requests = [];
  localStorage.clear();
  sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('六门前端输入通道 · 纯映射', () => {
  it('板卡规格：完整才生成 boards；缺项返回 missing 而不是默认值', () => {
    const complete = buildBoardSpec({ id: 'pcb-1', name: '主板', layers: '4', widthMm: '45', heightMm: '30' });
    expect(complete.board).toEqual({ id: 'pcb-1', name: '主板', layers: 4, outline: { widthMm: 45, heightMm: 30 } });
    expect(complete.missing).toEqual([]);

    const incomplete = buildBoardSpec({ id: 'pcb-1', name: '主板', layers: '', widthMm: '45', heightMm: '' });
    expect(incomplete.board).toBeNull();
    expect(incomplete.missing).toContain('层数（>=2 的整数）');
    expect(incomplete.missing).toContain('板高 heightMm（正数）');
  });

  it('G2 映射：有 easyEdaBinding 才给 eda，priced 才有 supply；unknown 不算供应源', () => {
    const state = buildState();
    const components = buildGateComponents(state.components, pricingEvidence as never);
    const mapped = components.find((item) => item.refdes === 'U1')!;
    expect(mapped.eda).toEqual({ deviceUuid: 'dev-uuid-1', symbol: 'nRF52840', footprint: 'aQFN-73', model3D: 'nRF52840.step', lcscId: 'C190794' });
    expect(mapped.supply?.price).toBe(1.5);
    expect(mapped.supply?.stock).toBe(120);

    // 没有 EDA 绑定、供应商只返回 unknown 的器件：两个来源都必须为 null（让 G2 报缺，不补假数据）。
    const unbound = components.find((item) => item.refdes === 'U2')!;
    expect(unbound.eda).toBeNull();
    expect(unbound.supply).toBeNull();
    expect(summarizeGateComponentSources(components)).toMatchObject({ total: 6, withEda: 1, withSupply: 1 });
  });

  it('意图网表：空串不传；坏 JSON 报错；合法 JSON 原样返回', () => {
    expect(parseIntentNetlistText('  ')).toEqual({ netlist: null, error: null });
    expect(parseIntentNetlistText('{ bad').error).toBeTruthy();
    expect(parseIntentNetlistText('"text"').error).toBeTruthy();
    const intent = { nets: [{ name: 'GND', endpoints: [{ ref: 'U1', pin: '1' }] }] };
    expect(parseIntentNetlistText(JSON.stringify(intent))).toEqual({ netlist: intent, error: null });
  });

  it('EDA→验证中心 G3 交接：写入后可读回，空网表不覆盖已有交接', () => {
    expect(readReviewedNetlistHandoff()).toBeNull();
    saveReviewedNetlistHandoff({ netlist: null });
    expect(readReviewedNetlistHandoff()).toBeNull();

    const netlist = { nets: [{ name: 'VCC', endpoints: [{ ref: 'U1', pin: '2' }, { ref: 'C1', pin: '1' }] }] };
    saveReviewedNetlistHandoff({ netlist, plan: { kind: 'reviewed-netlist' } });
    const handoff = readReviewedNetlistHandoff()!;
    expect(handoff.netlist).toEqual(netlist);
    expect(handoff.plan).toEqual({ kind: 'reviewed-netlist' });
    expect(Date.parse(handoff.createdAt)).toBeGreaterThan(0);
    expect(sessionStorage.getItem(REVIEWED_NETLIST_HANDOFF_KEY)).toBeTruthy();
    expect(formatIntentNetlistText(handoff)).toContain('"VCC"');
  });
});

describe('验证中心取证请求体（真实点击）', () => {
  const state = buildState();
  const collect = (body: any) => ({ ok: true, saved: [], missing: [], skipped: [], report: gateReport(), evidenceRefs: [] });

  it('填了板卡规格：collect 请求体带 boards + eda/supply 映射；G3 交接自动载入意图网表', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const handoffNetlist = { nets: [{ name: 'GND', endpoints: [{ ref: 'U1', pin: '1' }, { ref: 'C1', pin: '2' }] }] };
    saveReviewedNetlistHandoff({ netlist: handoffNetlist });
    installFetch(state, collect({}));

    await act(async () => { root.render(<AppProvider><VerificationCenterPage /></AppProvider>); });
    await flush();

    await setFieldValue('板卡层数', '2');
    await setFieldValue('板宽', '45');
    await setFieldValue('板高', '30');
    expect(container.textContent).toContain('G1 将带 boards');

    await act(async () => { buttonByText('运行门禁取证 G1–G6')?.click(); });
    await flush();

    const pricingCall = requests.find((item) => item.path === '/api/supply/pricing');
    expect(pricingCall).toBeTruthy();
    expect(pricingCall!.body.lcscIds).toEqual(['C190794', 'C2836819', 'C2675254', 'C1591', 'C14663', 'C165948']);

    const call = requests.find((item) => item.path === '/api/eda/gates/collect')!;
    expect(call).toBeTruthy();
    expect(call.body.specInput.boards).toEqual([{ id: 'pcb-1', name: state.projects[0].name, layers: 2, outline: { widthMm: 45, heightMm: 30 } }]);
    const u1 = call.body.components.find((item: any) => item.refdes === 'U1');
    expect(u1.eda.deviceUuid).toBe('dev-uuid-1');
    expect(u1.supply.price).toBe(1.5);
    const u2 = call.body.components.find((item: any) => item.refdes === 'U2');
    expect(u2.eda).toBeNull();
    expect(u2.supply).toBeNull();
    expect(call.body.intentNetlist).toEqual(handoffNetlist);
    expect(container.textContent).toContain('已从 EDA 页载入已审核网表');
  });

  it('未填板卡规格：请求体不带 boards，页面如实展示 missing 与人话补输入路径', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    installFetch(state, {
      ok: true, saved: [], skipped: [], evidenceRefs: [],
      missing: [{ kind: 'design-spec', reason: '缺少 design-spec 输入：boards 至少需要一块板' }],
      report: gateReport(['design-spec']),
    });

    await act(async () => { root.render(<AppProvider><VerificationCenterPage /></AppProvider>); });
    await flush();
    expect(container.textContent).toContain('板卡规格未填完整');

    await act(async () => { buttonByText('运行门禁取证 G1–G6')?.click(); });
    await flush();

    const call = requests.find((item) => item.path === '/api/eda/gates/collect')!;
    expect(call.body.specInput?.boards).toBeUndefined();
    expect(call.body.intentNetlist).toBeUndefined();
    const text = container.textContent || '';
    expect(text).toContain('缺少 design-spec 输入：boards 至少需要一块板');
    expect(text).toContain('G1 规格门');
    // 可签/不可签原因必须写在页面上，而不是只藏在禁用按钮的 title 里。
    expect(text).toContain('当前不可签');
  });
});

describe('布局写回 G5 人工确认', () => {
  it('预演不带 userConfirmed；确认框里点“确认写回”后真实写回带 userConfirmed:true', async () => {
    const state = buildState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    installFetch(state, { ok: true, saved: [], missing: [], skipped: [], report: gateReport(), evidenceRefs: [] });

    await act(async () => { root.render(<AppProvider><PlacementPage /></AppProvider>); });
    await flush();
    await act(async () => { buttonByText('读取板框并自动布局')?.click(); });
    await flush();
    expect(container.textContent).toContain('方案复核通过');

    await act(async () => { buttonByText('预演写回')?.click(); });
    await flush();
    await act(async () => { buttonByText('执行写回')?.click(); });
    await flush();
    await act(async () => { buttonByText('确认写回')?.click(); });
    await flush(24);

    const applyCalls = requests.filter((item) => item.path === '/api/eda/pcb/placement/apply');
    expect(applyCalls.length).toBeGreaterThanOrEqual(2);
    expect(applyCalls[0].body.dryRun).toBe(true);
    expect(applyCalls[0].body.userConfirmed).toBeUndefined();
    const realWrite = applyCalls.find((item) => item.body.dryRun === false && item.body.plan?.placements?.length);
    expect(realWrite).toBeTruthy();
    expect(realWrite!.body.userConfirmed).toBe(true);
    expect(requests.some((item) => item.path === '/api/automation/approvals' && item.body.scope === 'write')).toBe(true);
  });
});
