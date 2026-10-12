import type { BomDraft, DesignApproval, DesignExecution, EasyEdaDeviceSearchItem, EdaDesignContext, EdaWindow, EdaWorkspaceBinding, EngineeringAnalysis, PcbCapabilities, PcbContext, PcbExecution, ProductionFinalReviewRequest, ProductionInspection, ProductionReadiness, ProviderId, ProviderSummary, RequirementSuggestion, RuntimeDiagnostic, SemanticPlanResult, SimpleBoardPlanResult } from '../types';

const BASE_URL = import.meta.env.VITE_RUNTIME_URL || 'http://127.0.0.1:4178';
const REQUEST_TIMEOUT = 12_000;

declare global {
  interface Window {
    /**
     * Tauri 壳层在页面脚本执行前注入的运行时会话令牌。
     * 一旦存在，令牌就完全不经由 HTTP 分发（生产模式下 Runtime 也会关闭 HTTP 发放），
     * 因此本机其它进程即使伪造 Origin 也无法再领取令牌。
     */
    __CIRCUITPILOT_RUNTIME_TOKEN__?: string;
  }
}

function readInjectedToken(): string | null {
  if (typeof window === 'undefined') return null;
  const value = window.__CIRCUITPILOT_RUNTIME_TOKEN__;
  return typeof value === 'string' && value.length >= 16 ? value : null;
}

// 注入的令牌是权威凭据：它无法通过 /api/health 重新获取，所以 401 时不能清空后盲目重试。
const injectedToken = readInjectedToken();
let sessionProof: string | null = injectedToken;

export class RuntimeApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'RuntimeApiError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}, retry = true, timeoutMs = REQUEST_TIMEOUT): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 除 /api/health 外，Runtime 的所有路由（含只读 GET）都要求会话令牌。
    // 开发模式下先完成一次引导握手；壳层注入令牌时 sessionProof 已就绪，不会走这一步。
    if (!sessionProof && path !== '/api/health') await runtimeClient.health();
    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(sessionProof ? { 'x-circuitpilot-token': sessionProof } : {}),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && retry && !injectedToken) {
        sessionProof = null;
        await runtimeClient.health();
        return request<T>(path, init, false, timeoutMs);
      }
      throw new RuntimeApiError(body?.error?.code || 'RUNTIME_HTTP_ERROR', body?.error?.message || `Runtime HTTP ${response.status}`, response.status);
    }
    return body as T;
  } catch (error) {
    if (error instanceof RuntimeApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new RuntimeApiError('RUNTIME_TIMEOUT', '本机Runtime响应超时');
    throw new RuntimeApiError('RUNTIME_UNREACHABLE', '无法连接本机Runtime，请运行 npm run dev:full');
  } finally {
    window.clearTimeout(timer);
  }
}

export const runtimeClient = {
  baseUrl: BASE_URL,
  async health() {
    const result = await request<{ ok: true; service: string; version: string; sessionProof?: string }>('/api/health');
    // 只有 Runtime 真的下发了令牌（开发模式）才更新；生产模式下 HTTP 不再发放令牌，
    // 必须保留壳层注入的令牌，否则会被 undefined 覆盖掉。
    if (typeof result.sessionProof === 'string' && result.sessionProof.length >= 16) sessionProof = result.sessionProof;
    return { service: result.service, version: result.version };
  },
  async diagnostics() {
    const result = await request<{ diagnostics: Record<string, { id?: string; status?: string; detail?: string; path?: string; arch?: string; release?: string }> & { checkedAt?: string } }>('/api/diagnostics');
    return Object.entries(result.diagnostics)
      .filter(([id]) => id !== 'checkedAt')
      .map(([id, value]) => {
        const item = typeof value === 'string' ? { detail: value } : value;
        return ({
        id,
        name: id === 'macos' || id === 'platform' ? 'macOS' : id === 'easyeda' ? '嘉立创EDA' : id === 'cargo' ? 'Rust / Cargo' : id,
        available: item.status === 'pass' || item.status === 'warn',
        detail: item.detail || item.path || [item.arch, item.release].filter(Boolean).join(' · ') || item.status || '未知',
        } satisfies RuntimeDiagnostic);
      });
  },
  async providers() {
    const result = await request<{ providers: ProviderSummary[] }>('/api/providers');
    return result.providers;
  },
  async startLogin(id: ProviderId) {
    return request<{ login: { state: 'started' | 'already_authenticated'; started: boolean; authenticated: boolean; pid?: number; status?: string } }>(`/api/providers/${id}/login`, { method: 'POST' });
  },
  async storeKey(id: ProviderId, key: string) {
    return request<{ credential: { configured: boolean; hint: string } }>(`/api/providers/${id}/key`, { method: 'POST', body: JSON.stringify({ key }) });
  },
  async removeKey(id: ProviderId) {
    return request<{ credential: { configured: boolean } }>(`/api/providers/${id}/key`, { method: 'DELETE' });
  },
  async testProvider(id: ProviderId) {
    const result = await request<{ test: { ready?: boolean; ok?: boolean; models?: string[]; status?: string } }>(`/api/providers/${id}/test`, { method: 'POST' });
    return result.test;
  },
  async discoverBridge() {
    const result = await request<{ bridge: { port: number; health: unknown } | null }>('/api/eda/discover');
    return result.bridge;
  },
  async windows() {
    return request<{ windows: EdaWindow[]; selectedWindowId: string | null; selectionRequired: boolean }>('/api/eda/windows');
  },
  async selectWindow(windowId: string) {
    return request<{ selectedWindowId: string }>('/api/eda/windows/select', { method: 'POST', body: JSON.stringify({ windowId }) });
  },
  async executeCommand(id: 'project.current' | 'document.current' | 'schematic.catalog' | 'schematic.components' | 'schematic.wires' | 'schematic.drc') {
    const result = await request<{ command: { id: string; permission: 'read'; duration: number; result: unknown } }>(`/api/eda/commands/${encodeURIComponent(id)}`, { method: 'POST' });
    return result.command;
  },
  async openPcb(documentUuid: string) {
    const result = await request<{ command: { id: string; permission: 'navigate'; duration: number; result: unknown } }>('/api/eda/commands/pcb.open', { method: 'POST', body: JSON.stringify({ documentUuid }) });
    return result.command;
  },
  async searchEasyEdaDevices(query: string, mode: 'keyword' | 'lcsc' = 'keyword', page = 1) {
    const result = await request<{ search: { query: string; mode: 'keyword' | 'lcsc'; beta: true; readOnly: true; candidates: EasyEdaDeviceSearchItem[] } }>('/api/eda/library/devices/search', { method: 'POST', body: JSON.stringify({ query, mode, page }) }, true, 20_000);
    return result.search;
  },
  async designContext() {
    const result = await request<{ context: EdaDesignContext }>('/api/design/context');
    return result.context;
  },
  /**
   * 打开原理图页。必须传 documentUuid，否则 Runtime 会回退到“工程里第一张合法页面”，
   * 导致打开的不是本项目绑定的那张图（见 server.mjs 的 requestedUuid 回退分支）。
   */
  async openCurrentSchematic(schematicPageUuid?: string) {
    const result = await request<{ schematic: { documentUuid: string; page: unknown; navigation: unknown } }>('/api/eda/schematic/open-current', { method: 'POST', body: JSON.stringify({ documentUuid: schematicPageUuid || '' }) });
    return result.schematic;
  },
  async normalizeDesignPlan(plan: unknown) {
    const result = await request<{ planning: SimpleBoardPlanResult }>('/api/design/plan', { method: 'POST', body: JSON.stringify({ plan }) });
    return result.planning;
  },
  async generateDesignPlan(context: unknown, model?: string | null) {
    const result = await request<{ candidate: Record<string, unknown>; planning: SimpleBoardPlanResult }>('/api/design/plan/ai', { method: 'POST', body: JSON.stringify({ context, model }) }, true, 150_000);
    return result;
  },
  async generateReviewedNetlist(context: unknown, model?: string | null) {
    const result = await request<{ netlist: { status: 'ready' | 'blocked'; explanation: string; blockers: string[]; netlist: Record<string, unknown> | null; compilation: SimpleBoardPlanResult | null } }>('/api/design/netlist/ai', { method: 'POST', body: JSON.stringify({ context, model }) }, true, 150_000);
    return result.netlist;
  },
  async approveDesign(body: { plan: unknown; targetFingerprint: string; windowId: string; steps?: string[] }) {
    const result = await request<{ approval: DesignApproval }>('/api/design/approve', { method: 'POST', body: JSON.stringify(body) });
    return result.approval;
  },
  async executeDesign(body: { plan: unknown; approvalToken: string; targetFingerprint: string; windowId: string }) {
    const result = await request<{ execution: DesignExecution }>('/api/design/execute', { method: 'POST', body: JSON.stringify(body) }, true, 150_000);
    return result.execution;
  },
  async pcbCapabilities() {
    const result = await request<{ capabilities: PcbCapabilities }>('/api/pcb/capabilities');
    return result.capabilities;
  },
  async pcbContext() {
    const result = await request<{ context: PcbContext }>('/api/pcb/context');
    return result.context;
  },
  async focusEasyEda() {
    return request<{ application: { path: string; focused: boolean } }>('/api/eda/app/focus', { method: 'POST' });
  },
  async createEasyEdaWorkspace(body: { friendlyName: string; projectName: string; description?: string }) {
    return request<{ workspace: { projectUuid: string; boardName: string; schematicUuid: string; schematicPageUuid: string; pcbUuid: string; tabId: string; activated: boolean; project?: unknown; document?: unknown } }>('/api/eda/workspaces', { method: 'POST', body: JSON.stringify(body) }, true, 30_000);
  },
  /** 读取并校验当前嘉立创EDA中选中的 PCB 及其同 Board 关联的原理图页，用于把设计身份绑定到项目。 */
  async currentEasyEdaWorkspace() {
    const result = await request<{ workspace: Omit<EdaWorkspaceBinding, 'schematicStatus'> }>('/api/eda/workspaces/current');
    return result.workspace;
  },
  /** 把 CircuitPilot 桌面窗口切回前台，便于用户在写入前确认目标。 */
  async focusCircuitPilot() {
    return request<{ application: { path: string; focused: boolean } }>('/api/app/focus', { method: 'POST' });
  },
  async compileCh32v003Pcb(placements: Record<string, unknown> = {}) {
    const result = await request<{ planning: SimpleBoardPlanResult }>('/api/pcb/fixtures/ch32v003/compile', { method: 'POST', body: JSON.stringify({ placements }) });
    return result.planning;
  },
  async normalizePcbPlan(plan: unknown) {
    const result = await request<{ planning: SimpleBoardPlanResult }>('/api/pcb/plan', { method: 'POST', body: JSON.stringify({ plan }) });
    return result.planning;
  },
  async approvePcb(body: { plan: unknown; targetFingerprint: string; windowId: string; stages?: string[] }) {
    const result = await request<{ approval: DesignApproval }>('/api/pcb/approve', { method: 'POST', body: JSON.stringify(body) });
    return result.approval;
  },
  async executePcb(body: { plan: unknown; approvalToken: string; targetFingerprint: string; windowId: string }) {
    const result = await request<{ execution: PcbExecution }>('/api/pcb/execute', { method: 'POST', body: JSON.stringify(body) }, true, 180_000);
    return result.execution;
  },
  async normalizeProductionPlan(plan: unknown) {
    const result = await request<{ planning: SemanticPlanResult }>('/api/production/plans/normalize', { method: 'POST', body: JSON.stringify({ plan }) });
    return result.planning;
  },
  async compileProductionPlan(plan: unknown) {
    const result = await request<{ planning: SemanticPlanResult }>('/api/production/plans/compile', { method: 'POST', body: JSON.stringify({ plan }) });
    return result.planning;
  },
  async generateProductionPlan(context: unknown, model?: string | null, instruction?: string) {
    return request<{ candidate: { status: 'ready' | 'blocked'; explanation: string; blockingInformation: Array<{ code: string; question: string; reason: string }>; plan: Record<string, unknown> | null }; planning: SemanticPlanResult | null }>('/api/production/plans/ai', { method: 'POST', body: JSON.stringify({ context, model, instruction }) }, true, 180_000);
  },
  async inspectProductionArtifacts(binding: Record<string, string>) {
    const result = await request<{ inspection: ProductionInspection }>('/api/production/artifacts/inspect', { method: 'POST', body: JSON.stringify({ binding }) }, true, 30_000);
    return result.inspection;
  },
  /** 只提交引用（哈希与ID），门禁结论由 Runtime 依据服务端记录重算。 */
  async productionReadiness(body: { semanticPlanHash: string; compiledPlanHash: string; pcbExecutionId: string; reviewHash?: string; binding?: Record<string, string> }) {
    const result = await request<{ readiness: ProductionReadiness }>('/api/production/readiness', { method: 'POST', body: JSON.stringify(body) });
    return result.readiness;
  },
  /** 登记人工终审；Runtime 会把它绑定到语义计划、编译计划、PCB执行记录与物料清单哈希。 */
  async recordProductionFinalReview(body: ProductionFinalReviewRequest) {
    const result = await request<{ review: ProductionFinalReviewRequest & { reviewHash: string; reviewedAt: string } }>('/api/production/reviews/final', { method: 'POST', body: JSON.stringify(body) });
    return result.review;
  },
  async engineeringProfiles() {
    return request<{ profiles: { highSpeed: string[]; layers: number[]; rfMaxGHz: number; transmissionLines: string[]; solvers: Record<string, string>; productionBoundary: string }; fixtures: string[] }>('/api/engineering/profiles');
  },
  async analyzeEngineering(body: { fixtureId?: string; input?: unknown }) {
    const result = await request<{ analysis: EngineeringAnalysis }>('/api/engineering/analyze', { method: 'POST', body: JSON.stringify(body) }, true, 30_000);
    return result.analysis;
  },
  async events() {
    const result = await request<{ events: Array<{ timestamp: string; level: string; module: string; message: string; data?: unknown }> }>('/api/events');
    return result.events;
  },
  async chatStatus() {
    const result = await request<{ chat: { ready: boolean; provider: ProviderSummary | null; activeSessions: number } }>('/api/chat/status');
    return result.chat;
  },
  async sendChat(sessionId: string, body: { message: string; model?: string | null; context: unknown; attachments?: Array<{ kind: 'image'; name: string; mime: string; dataBase64: string } | { kind: 'text'; name: string; mime: string; text: string }> }) {
    const result = await request<{ chat: { sessionId: string; threadActive: boolean; reply: string; questions: string[]; requirementSuggestions: RequirementSuggestion[]; bomDraft: BomDraft | null; eda: { status: 'available' | 'unavailable' | 'selection_required'; reason: string; windowCount?: number; project?: unknown; document?: unknown } } }>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: JSON.stringify(body) }, true, 150_000);
    return result.chat;
  },
  async resetChat(sessionId: string) {
    const result = await request<{ chat: { sessionId: string; reset: boolean; hadThread: boolean } }>(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    return result.chat;
  },
};
