import type { BomDraft, ChatTranscript, CustomModelConfig, CustomProviderConfig, CustomProviderProtocol, FailureDiagnosis, DfmEvidenceEntry, DrcEvidenceEntry, DrcReport, ErcConvergenceSummary, ErcDetailMeta, ErcEvidenceEntry, ErcReport, LayoutRuleAudit, LayoutRulePackSummary, DesignApproval, DesignExecution, EasyEdaDeviceSearchItem, EdaDesignContext, EdaWindow, EdaWorkspaceBinding, EngineeringAnalysis, FabricationOrderCard, PcbCapabilities, PcbContext, PcbExecution, PcbSyncVerification, PlacementPlanResult, PlacementWritebackResult, ProductionExportResult, ProductionFinalReviewRequest, ProductionInspection, ProductionOutputDecision, ProductionReadiness, ExecutionHistoryItem, ExecutionHistoryList, SupplyPricingEvidence, ApprovalLedgerSnapshot, ProviderId, ProviderSummary, ReleaseArchiveRecord, ReleaseArchiveSummary, ReleaseGateReport, RequirementSuggestion, RuntimeDiagnostic, SchematicRepairReport, SemanticPlanResult, SignoffEvidenceEntry, SimpleBoardPlanResult, OrderConfirmationPayload, PcbLayerStack, PcbLayerStackChange, PcbPourInfo } from '../types';

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

async function request<T>(path: string, init: RequestInit = {}, retry = true, timeoutMs = REQUEST_TIMEOUT, externalSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
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
    if (error instanceof DOMException && error.name === 'AbortError') {
      // D8：用户主动取消与超时分开报，措辞都不冒充"服务端任务已终止"。
      if (externalSignal?.aborted) throw new RuntimeApiError('REQUEST_ABORTED', '已停止等待本页请求；服务端任务可能仍在执行或已落盘，以审计与产物目录为准');
      throw new RuntimeApiError('RUNTIME_TIMEOUT', '本机Runtime响应超时');
    }
    // 桌面版会自动拉起本机 Runtime，让用户去跑 dev:full 只会误导；这里给出可执行的两步。
    throw new RuntimeApiError('RUNTIME_UNREACHABLE', '无法连接本机Runtime：桌面版会自动启动它，请稍等几秒或重启应用；开发模式请运行 npm run dev:full');
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/** C6：项目列表行（状态文件独立性可见）。 */
export interface ProjectSummary {
  id: string;
  name: string;
  stage: string | null;
  archived: boolean;
  edaBound: boolean;
  savedAt: string | null;
  requirements: number | null;
  components: number | null;
  assets: number | null;
}

/** C6：EDA 窗口与项目绑定校验结果（expected 是项目登记值，current 是窗口真实值）。 */
export interface ProjectBindingVerification {
  ok: true;
  projectId: string;
  bound: boolean;
  expected: { projectUuid?: string; pcbUuid?: string; schematicPageUuid?: string } | null;
  current: { projectUuid: string | null; boardName: string | null; schematicUuid: string | null; schematicPageUuid: string | null; pcbUuid: string | null; documentUuid: string | null } | null;
  currentError?: string | null;
  ready: boolean;
  mismatches: string[];
}

/** C3：统一证据时间线条目（run 步骤 / 批准生命周期 / 证据文件）。 */
export interface TimelineEntry {
  at: string | null;
  kind: 'run' | 'approval' | 'evidence';
  runId: string | null;
  seq?: number | null;
  phase: string;
  stepId?: string | null;
  summary: string;
  digest: string | null;
  detail?: Record<string, unknown>;
}

export interface TimelineResult {
  ok: true;
  generatedAt: string;
  runId: string | null;
  entries: TimelineEntry[];
  counts: Record<string, number>;
  total: number;
  truncated: boolean;
  invalid: Array<{ file: string; line?: number; error: string }>;
  sources: {
    journal: { available: boolean; reason: string | null; files?: number };
    approvals: { available: boolean; reason: string | null; entries?: number };
    evidence: { available: boolean; reason: string | null; entries?: number; complete?: boolean; truncated?: boolean };
    links?: { available: boolean; reason: string | null; count: number };
  };
  complete: boolean;
}

export const runtimeClient = {
  baseUrl: BASE_URL,
  async getProjectState() {
    return request<{ ok: true; state: import('../types').BusinessState; savedAt: string | null }>('/api/project-state');
  },
  /** C1：版本/修改/审计的 Runtime 权威副本（读回）。 */
  async getTraceState() {
    return request<{ ok: true; state: { versions: import('../types').VersionItem[]; changes: import('../types').ChangeLogEntry[]; audit: import('../types').AuditEvent[] }; savedAt: string | null; total?: { versions: number; changes: number; audit: number } }>('/api/trace-state');
  },
  /** C1：问题中心记录的 Runtime 权威副本（读回）。 */
  async getIssueState() {
    return request<{ ok: true; state: { issues: import('../types').IssueRecord[] }; savedAt: string | null; total?: number }>('/api/issue-state');
  },
  /** C1：写回问题中心记录（服务端校验失败 400 ISSUE_STATE_INVALID，不静默修正）。 */
  async saveIssueState(state: { issues: import('../types').IssueRecord[] }) {
    return request<{ ok: true; state: { issues: import('../types').IssueRecord[] }; savedAt: string; total?: number }>('/api/issue-state', { method: 'PUT', body: JSON.stringify({ state }) });
  },
  /** C1：写回追溯三件套（服务端校验失败 400 TRACE_STATE_INVALID，不静默修正）。 */
  async saveTraceState(state: { versions: import('../types').VersionItem[]; changes: import('../types').ChangeLogEntry[]; audit: import('../types').AuditEvent[] }) {
    return request<{ ok: true; state: { versions: import('../types').VersionItem[]; changes: import('../types').ChangeLogEntry[]; audit: import('../types').AuditEvent[] }; savedAt: string; total?: { versions: number; changes: number; audit: number } }>('/api/trace-state', {
      method: 'PUT',
      body: JSON.stringify({ state }),
    });
  },
  async saveProjectState(state: import('../types').BusinessState) {
    return request<{ ok: true; state: import('../types').BusinessState; savedAt: string }>('/api/project-state', {
      method: 'PUT',
      body: JSON.stringify({ state }),
    });
  },
  /** C6：项目列表（每个项目的状态文件独立性：savedAt/计数来自各自文件）。 */
  async listProjects() {
    return request<{ ok: true; projects: ProjectSummary[]; scopedFiles: number }>('/api/projects');
  },
  /** C6：项目级状态切面（读）——只返回该项目的数据；无项目文件时从聚合状态迁移出只读切片。 */
  async getProjectStateScoped(projectId: string) {
    return request<{ ok: true; projectId: string; state: import('../types').BusinessState; savedAt: string | null; source: 'project' | 'legacy-migration' }>(`/api/projects/${encodeURIComponent(projectId)}/state`);
  },
  /** C6：项目级状态切面（写）——服务端强制按项目打标，跨项目实体会被 400 拒绝。 */
  async saveProjectStateScoped(projectId: string, state: import('../types').BusinessState) {
    return request<{ ok: true; projectId: string; state: import('../types').BusinessState; savedAt: string; tagged: number }>(`/api/projects/${encodeURIComponent(projectId)}/state`, {
      method: 'PUT',
      body: JSON.stringify({ state }),
    });
  },
  /** C6：EDA 窗口与项目绑定校验（只读）——防止在 A 项目页面对 B 项目窗口签发批准。 */
  async verifyProjectBinding(projectId: string) {
    return request<ProjectBindingVerification>(`/api/projects/${encodeURIComponent(projectId)}/binding/verify`);
  },
  async health() {
    const result = await request<{ ok: true; service: string; version: string; sessionProof?: string }>('/api/health');
    // 只有 Runtime 真的下发了令牌（开发模式）才更新；生产模式下 HTTP 不再发放令牌，
    // 必须保留壳层注入的令牌，否则会被 undefined 覆盖掉。
    if (typeof result.sessionProof === 'string' && result.sessionProof.length >= 16) sessionProof = result.sessionProof;
    return { service: result.service, version: result.version };
  },
  /** H5：生成脱敏、有界、可复现的诊断包（失败定位用；不写文件、不含工程内容）。 */
  async diagnosticBundle() {
    const result = await request<{ bundle: Record<string, unknown> }>('/api/diagnostics/bundle', { method: 'GET' }, true, 60_000);
    return result.bundle;
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
  /** 统一失败诊断（D4）：失败 → 带证据/修复入口的 issue；Runtime 不可达时由调用方退回本地记录。 */
  async diagnoseFailure(input: { source?: FailureDiagnosis['source']; error?: { code?: string; message?: string; details?: unknown }; context?: Record<string, unknown> }) {
    return request<{ ok: boolean; diagnosis: FailureDiagnosis }>('/api/diagnostics/failure', { method: 'POST', body: JSON.stringify(input) });
  },

  /** G4：数据外发清单（现有 provider 调用点/触发条件/发送字段/明确不发送的内容）。 */
  async providerEgress() {
    return request<{ ok: true; egress: { schemaVersion: number; policyVersion: string; consentMode: string; consentNote: string; orderEnabled: boolean; redaction: string; endpoints: Array<{ id: string; route: string; trigger: string; data: Array<{ field: string; source: string }>; excluded: string[] }>; notSent: string[]; boundaries: string[] } }>('/api/provider/egress', {}, false);
  },

  /** G4：脱敏预览（与日志/诊断包同一套 redactSecrets；不改发送行为）。 */
  async previewProviderEgress(payload: unknown) {
    return request<{ ok: true; policyVersion: string; changed: boolean; bytes: number; sanitized: unknown; note: string }>('/api/provider/egress/preview', { method: 'POST', body: JSON.stringify({ payload }) }, false);
  },

  /** S1：联网检索（设置里开启后，由调用方显式 allowResearch 放行；只读取证、不写工程）。 */
  async researchSearch(input: { query: string; provider?: 'duckduckgo' | 'bing'; limit?: number; allowResearch?: boolean }) {
    return request<{ ok: true; research: { provider: string; query: string; results: Array<{ title: string; url: string; snippet: string }>; fetchedAt: string; digest: string } }>(
      '/api/research/search',
      { method: 'POST', body: JSON.stringify({ ...input, allowResearch: input.allowResearch === true }) },
      false,
      30_000,
    );
  },
  /** S1：抓取单个公网页面并转纯文本（服务端做 SSRF 校验与体积/超时限制）。 */
  async researchFetch(input: { url: string; allowResearch?: boolean }) {
    return request<{ ok: true; page: { finalUrl: string; status: number; contentType: string; bytes: number; text: string; digest: string; fetchedAt: string } }>(
      '/api/research/fetch',
      { method: 'POST', body: JSON.stringify({ ...input, allowResearch: input.allowResearch === true }) },
      false,
      30_000,
    );
  },
  /** W5-03/W6-01：门禁状态（只读，不写证据）。 */
  async gatesStatus(pcbUuid: string) {
    return request<{ ok: true; report: import('../types').PcbGateReport; evidenceRefs: import('../types').GateEvidenceRef[] }>(
      `/api/eda/gates/status?pcbUuid=${encodeURIComponent(pcbUuid)}`,
    );
  },
  /** W5-03：评估门禁并归档报告（写 signoff 证据）。 */
  async gatesEvaluate(pcbUuid: string) {
    return request<{ ok: true; report: import('../types').PcbGateReport; evidenceRefs: import('../types').GateEvidenceRef[]; evidencePath: string; digest: string }>(
      '/api/eda/gates/evaluate',
      { method: 'POST', body: JSON.stringify({ pcbUuid }) },
      false,
      30_000,
    );
  },
  /** W5-04：人工终审签字（approve 仅当门禁 pass；记录进哈希链账本）。 */
  async gatesSignoff(input: { pcbUuid: string; signedBy: string; decision: 'approve' | 'reject'; note?: string }) {
    return request<{ ok: true; record: import('../types').GateSignoffRecord; evidencePath: string; digest: string; report: import('../types').PcbGateReport }>(
      '/api/eda/gates/signoff',
      { method: 'POST', body: JSON.stringify(input) },
      false,
      30_000,
    );
  },
  /** 批准账本快照（哈希链可核对）。 */
  async gatesApprovals(limit = 100) {
    return request<{ ok: true } & import('../types').ApprovalLedgerView>(`/api/eda/gates/approvals?limit=${encodeURIComponent(String(limit))}`);
  },
  /** W3-17：知识库检索（结构化/全文）。 */
  async knowledgeList(params: { kind?: string; trust?: string; reviewState?: string; entityKey?: string; text?: string; includeExpired?: boolean } = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      query.set(key, String(value));
    }
    // 注意：这里用 `${query}` 形式，route-contract 静态检查会把该模板变量识别为查询串并丢弃。
    return request<{ ok: true; knowledge: { total: number; returned: number; entries: import('../types').KnowledgeEntryView[]; gateUsable: number; expired: number } }>(`/api/knowledge/entries?${query}`);
  },
  /** W3-03：新增知识条目（服务端强制 candidate）。 */
  async knowledgeSave(input: { kind: string; title: string; payload: Record<string, unknown>; provenance: Record<string, unknown>; trust?: string; ttlDays?: number | null }) {
    return request<{ ok: true; entry: import('../types').KnowledgeEntryView; created: boolean }>('/api/knowledge/entries', { method: 'POST', body: JSON.stringify(input) });
  },
  /** W3-12：人工审核（必须 reviewedBy）。 */
  async knowledgeReview(id: string, input: { state: 'approved' | 'rejected'; reviewedBy: string }) {
    return request<{ ok: true; entry: import('../types').KnowledgeEntryView }>(`/api/knowledge/entries/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify(input) });
  },
  /** W3-11：同一 entityKey 的多源冲突。 */
  async knowledgeConflicts(entityKey: string) {
    return request<{ ok: true; entityKey: string; conflicts: Array<{ field: string; values: Array<{ id: string; value: unknown }> }> }>(`/api/knowledge/conflicts?entityKey=${encodeURIComponent(entityKey)}`);
  },
  /** W3-18：健康度指标。 */
  async knowledgeHealth() {
    return request<{ ok: true; metrics: import('../types').KnowledgeHealth }>('/api/knowledge/health');
  },
  /** W3-17：审核队列（候选/冲突/过期）。 */
  async knowledgeReviewQueue() {
    return request<{ ok: true } & import('../types').KnowledgeReviewQueueView>('/api/knowledge/review-queue');
  },
  /** W3-18：KMA 状态（定时调度 + 维护统计）。 */
  async knowledgeAgentStatus() {
    return request<{ ok: true; scheduler: import('../types').KnowledgeAgentSchedulerStatus; manager: import('../types').KnowledgeAgentManagerStatus }>('/api/knowledge/agent/status');
  },
  /** W3-18：手动触发 KMA（all / badcases / web / maintain）。 */
  async knowledgeAgentRun(task: 'all' | 'badcases' | 'web' | 'maintain') {
    return request<{ ok: boolean; cycle: import('../types').KnowledgeAgentCycle }>('/api/knowledge/agent/run', { method: 'POST', body: JSON.stringify({ task }) });
  },
  /** W3-20：RAG 索引状态。 */
  async ragStatus() {
    return request<{ ok: true; rag: import('../types').RagStatus }>('/api/rag/status');
  },
  /** W3-20：重建 RAG 索引（知识库条目 + 工程文档）。 */
  async ragReindex() {
    return request<{ ok: true; rag: import('../types').RagRebuildResult }>('/api/rag/reindex', { method: 'POST', body: JSON.stringify({}) });
  },
  /** W3-20：混合检索（BM25 + 特征哈希向量）。 */
  async ragQuery(input: { query: string; topK?: number; kinds?: string[]; minScore?: number }) {
    return request<{ ok: true; rag: import('../types').RagQueryResult }>('/api/rag/query', { method: 'POST', body: JSON.stringify(input) });
  },
  /** W3-18：badcase（failure 类知识，含证据来源）。 */
  async knowledgeBadcases(limit = 50) {
    return request<{ ok: true; badcases: import('../types').KnowledgeEntryView[] }>(`/api/knowledge/badcases?limit=${encodeURIComponent(String(limit))}`);
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
  async testProvider(id: ProviderId, baseUrl?: string) {
    const result = await request<{ test: { ready?: boolean; ok?: boolean; models?: string[]; status?: string } }>(`/api/providers/${id}/test`, { method: 'POST', body: JSON.stringify({ baseUrl: baseUrl || undefined }) });
    return result.test;
  },
  /**
   * 自定义模型 API（契约 §2.6）：PUT 全量覆盖一个注册表 Provider。
   * 只提交可编辑字段；API Key 走 storeKey（钥匙串独立条目），绝不进这个 body。
   */
  async saveCustomProvider(id: string, input: { label: string; protocol: CustomProviderProtocol; baseUrl: string; models: CustomModelConfig[] }) {
    const result = await request<{ ok: true; customProvider: CustomProviderConfig }>(`/api/custom-providers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) });
    return result.customProvider;
  },
  async deleteCustomProvider(id: string) {
    return request<{ ok: true; removed: boolean; credential: { configured: boolean } }>(`/api/custom-providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  /** 用已保存的钥匙串 Key 探测 {baseUrl}/models，供「获取可用模型」合并进模型目录。 */
  async probeCustomProviderModels(id: string) {
    const result = await request<{ ok: true; models: Array<{ id: string; label?: string; contextWindow?: number }> }>(`/api/custom-providers/${encodeURIComponent(id)}/models`, { method: 'POST' });
    return result.models;
  },
  /** 桌面壳层不允许 target="_blank" 新窗口，因此由本机 Runtime 调起系统浏览器打开平台控制台。 */
  async openProviderConsole(id: ProviderId) {
    const result = await request<{ console: { provider: string; url: string; opened: boolean } }>(`/api/providers/${id}/console`, { method: 'POST' });
    return result.console;
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
  /** A2：只读回退检索诊断（原始→去括号→去品牌→首段→去斜杠后缀），保留每次尝试与命中来源。 */
  async probeSelectionFallback(queries: string[]) {
    return request<{ ok: boolean; queries: number; hit: number; fallbackHits: number; empty: number; results: Array<{ query: string; found: number; usedQuery: string | null; fallback: boolean; attempts: Array<{ query: string; found: number; error: string | null }>; candidates: Array<{ name: string | null; lcscId: string | null; uuid: string | null; libraryUuid: string | null }>; error?: string }> }>('/api/eda/library/search/fallback', { method: 'POST', body: JSON.stringify({ queries }) }, true, 60_000);
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
  /** @legacy LEGACY/未接 UI（D8 白名单：无 AbortSignal 需求）：生产计划改走 `generateReviewedNetlist` + 语义计划草稿；保留此方法仅为兼容旧调用方。 */
  async generateDesignPlan(context: unknown, model?: string | null) {
    const result = await request<{ candidate: Record<string, unknown>; planning: SimpleBoardPlanResult }>('/api/design/plan/ai', { method: 'POST', body: JSON.stringify({ context, model }) }, true, 150_000);
    return result;
  },
  async generateReviewedNetlist(context: unknown, model?: string | null, provider?: string, baseUrl?: string, options: { pinEvidence?: unknown; requirePinEvidence?: boolean; signal?: AbortSignal } = {}) {
    const result = await request<{ netlist: { status: 'ready' | 'blocked'; explanation: string; blockers: string[]; netlist: Record<string, unknown> | null; compilation: SimpleBoardPlanResult | null; pinEvidence?: { digest: string; counts: { components: number; pins: number; withNet: number; assumed: number; unknown: number } } | null } }>('/api/design/netlist/ai', { method: 'POST', body: JSON.stringify({ context, model, provider, baseUrl: baseUrl || undefined, pinEvidence: options.pinEvidence, requirePinEvidence: options.requirePinEvidence, signal: options.signal }) }, true, 150_000, options.signal);
    return result.netlist;
  },
  async approveDesign(body: { plan: unknown; targetFingerprint: string; windowId: string; steps?: string[] }) {
    const result = await request<{ approval: DesignApproval }>('/api/design/approve', { method: 'POST', body: JSON.stringify(body) });
    return result.approval;
  },
  async executeDesign(body: { plan: unknown; approvalToken: string; targetFingerprint: string; windowId: string }, options: { signal?: AbortSignal } = {}) {
    const result = await request<{ execution: DesignExecution }>('/api/design/execute', { method: 'POST', body: JSON.stringify(body) }, true, 150_000, options.signal);
    return result.execution;
  },
  /** G5：EDA 版本适配诊断（版本来源如实标注；未知/未验证版本明确降级提示）。 */
  async edaAdaptation(version?: string) {
    const query = version && version.trim() ? `?version=${encodeURIComponent(version.trim())}` : '';
    return request<{ ok: true; adaptation: { schemaVersion: number; version: string | null; versionSource: string; status: 'tested' | 'patch-drift' | 'untested' | 'unknown'; level: 'ok' | 'warn'; supported: boolean; testedVersions: string[]; baselineVersions: string[]; testedVersionsNote: string; warnings: string[]; degradations: string[]; missingApi: Array<{ name: string; method: string; usedBy: string; problem: string }>; unavailableCapabilities: Array<{ id: string; reason: string | null }>; knownIssues: Array<{ id: string; title: string; affects: string; fallback: string; evidence: string }>; guidance: string } }>(`/api/eda/version/adaptation${query}`, {}, false);
  },

  async pcbCapabilities() {
    const result = await request<{ capabilities: PcbCapabilities }>('/api/pcb/capabilities');
    return result.capabilities;
  },
  /**
   * 同步验收（路径 2，真机边界）：判定"原理图要上板的器件 vs PCB 现况"。
   * ready=false 时必须把差异与指引如实展示，且**不得**解锁后续自动布局。
   */
  async pcbSyncVerify(pcbUuid?: string) {
    const query = typeof pcbUuid === 'string' && pcbUuid ? `?pcbUuid=${encodeURIComponent(pcbUuid)}` : '';
    const result = await request<{ pcbUuid: string; schematicPageUuid: string; schematic: { designators: string[]; componentCount: number }; verification: PcbSyncVerification }>(`/api/pcb/sync/verify${query}`);
    return result;
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
  async executePcb(body: { plan: unknown; approvalToken: string; targetFingerprint: string; windowId: string }, options: { signal?: AbortSignal } = {}) {
    const result = await request<{ execution: PcbExecution }>('/api/pcb/execute', { method: 'POST', body: JSON.stringify(body) }, true, 180_000, options.signal);
    return result.execution;
  },
  /** @legacy LEGACY/未接 UI：统一裁决后由服务端对语义/编译计划做 normalize；页面不再直接调用。 */
  async normalizeProductionPlan(plan: unknown) {
    const result = await request<{ planning: SemanticPlanResult }>('/api/production/plans/normalize', { method: 'POST', body: JSON.stringify({ plan }) });
    return result.planning;
  },
  async compileProductionPlan(plan: unknown) {
    const result = await request<{ planning: SemanticPlanResult }>('/api/production/plans/compile', { method: 'POST', body: JSON.stringify({ plan }) });
    return result.planning;
  },
  async generateProductionPlan(context: unknown, model?: string | null, instruction?: string, provider?: string, baseUrl?: string, options: { signal?: AbortSignal } = {}) {
    return request<{ candidate: { status: 'ready' | 'blocked'; explanation: string; blockingInformation: Array<{ code: string; question: string; reason: string }>; plan: Record<string, unknown> | null }; planning: SemanticPlanResult | null }>('/api/production/plans/ai', { method: 'POST', body: JSON.stringify({ context, model, instruction, provider, baseUrl: baseUrl || undefined }) }, true, 180_000, options.signal);
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
  /** @legacy LEGACY/未接 UI：产品内的终审走三方签核证据（`recordSignoff`）+ 签名绑定 manifest，不再单独登记内存终审。 */
  async recordProductionFinalReview(body: ProductionFinalReviewRequest) {
    const result = await request<{ review: ProductionFinalReviewRequest & { reviewHash: string; reviewedAt: string } }>('/api/production/reviews/final', { method: 'POST', body: JSON.stringify(body) });
    return result.review;
  },
  /** @legacy 未接 UI：工程档位暂未产品化；调用前需要产品定义。 */
  async engineeringProfiles() {
    return request<{ profiles: { highSpeed: string[]; layers: number[]; rfMaxGHz: number; transmissionLines: string[]; solvers: Record<string, string>; productionBoundary: string }; fixtures: string[] }>('/api/engineering/profiles');
  },
  async analyzeEngineering(body: { fixtureId?: string; input?: unknown }) {
    const result = await request<{ analysis: EngineeringAnalysis }>('/api/engineering/analyze', { method: 'POST', body: JSON.stringify(body) }, true, 30_000);
    return result.analysis;
  },
  async layoutRulePack() {
    return request<{ pack: LayoutRulePackSummary; fixtures: string[] }>('/api/engineering/layout-rules');
  },
  async auditLayoutRules(body: { fixtureId?: string; input?: unknown }) {
    const result = await request<{ audit: LayoutRuleAudit }>('/api/engineering/layout-rules/audit', { method: 'POST', body: JSON.stringify(body) }, true, 30_000);
    return result.audit;
  },
  /** 系统事件时间线（C3）：VersionsPage「系统事件」页消费。 */
  async events() {
    const result = await request<{ events: Array<{ timestamp: string; level: string; module: string; message: string; data?: unknown }> }>('/api/events');
    return result.events;
  },
  async chatStatus(provider?: string) {
    const query = provider && provider !== 'codex_account' ? `?provider=${encodeURIComponent(provider)}` : '';
    const result = await request<{ chat: { ready: boolean; provider: ProviderSummary | null; activeSessions: number } }>(`/api/chat/status${query}`);
    return result.chat;
  },
  /** 列出 Runtime 落盘的全部对话会话：自动化/API 创建的对话也能在 UI 里重新打开查看。 */
  async chatSessions() {
    const result = await request<{ ok: boolean; sessions: Array<{ sessionId: string; updatedAt: string | null; messageCount: number; preview: string }> }>('/api/chat/sessions');
    return result.sessions;
  },

  /** C1：聊天 transcript（Runtime 落盘）。换浏览器/清缓存后用它恢复对话，而不是依赖 localStorage。 */
  async chatTranscript(sessionId: string) {
    return request<{ ok: boolean; transcript: ChatTranscript }>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/transcript`);
  },
  async sendChat(sessionId: string, body: { message: string; model?: string | null; provider?: string; baseUrl?: string; context: unknown; attachments?: Array<{ kind: 'image'; name: string; mime: string; dataBase64: string } | { kind: 'text'; name: string; mime: string; text: string }> }, options: { signal?: AbortSignal } = {}) {
    const result = await request<{ chat: { sessionId: string; threadActive: boolean; reply: string; questions: string[]; requirementSuggestions: RequirementSuggestion[]; bomDraft: BomDraft | null; eda: { status: 'available' | 'unavailable' | 'selection_required'; reason: string; windowCount?: number; project?: unknown; document?: unknown } } }>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: JSON.stringify(body) }, true, 150_000, options.signal);
    return result.chat;
  },
  async resetChat(sessionId: string) {
    const result = await request<{ chat: { sessionId: string; reset: boolean; hadThread: boolean } }>(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    return result.chat;
  },

  /** R5 自动布线：只读规划（返回断网/路由/独立复核），不写 EDA。 */
  async routingPlan(body: { nets?: string[]; maxConnections?: number } = {}, options: { signal?: AbortSignal } = {}) {
    return request<{ ok: boolean; source: string; copper: { pads: number; lines: number; vias: number }; brokenNets: Array<{ net: string; islands: number; items: number }>; requested: number; routes: Array<{ ok: boolean; net: string; reason?: string; segments?: Array<{ layer: number; x1: number; y1: number; x2: number; y2: number }>; vias?: unknown[] }>; verification: unknown }>('/api/eda/pcb/routing/plan', { method: 'POST', body: JSON.stringify(body) }, true, 300_000, options.signal);
  },
  /** R5 布线写入：默认预演；dryRun=false 必须带服务端签发的 write 批准。永不自动保存。 */
  async routingApply(body: { plan: unknown; dryRun?: boolean; save?: boolean; approvalIds?: string[] }, options: { signal?: AbortSignal } = {}) {
    return request<{ ok: boolean; dryRun: boolean; executed: number; saved: boolean; verification: unknown; written?: Array<{ kind: string; net: string; id: string }> }>('/api/eda/pcb/routing/apply', { method: 'POST', body: JSON.stringify(body) }, true, 300_000, options.signal);
  },
  /** R5 布线回滚：按写入返回的图元 id 删除并回读确认没残留。 */
  async routingRollback(body: { items: Array<{ kind: string; net: string; id: string }>; approvalIds?: string[] }, options: { signal?: AbortSignal } = {}) {
    return request<{ removed: number; residual: string[] }>('/api/eda/pcb/routing/rollback', { method: 'POST', body: JSON.stringify(body) }, true, 120_000, options.signal);
  },
  /**
   * 叠层只读：铜层数 + 层列表。
   * 服务端读不到铜层数时返回 409 `PCB_LAYER_COUNT_READ_FAILED`（绝不把"读不到"当成 2 层成功返回）。
   */
  async pcbLayers() {
    return request<{ ok: boolean; layers: PcbLayerStack }>('/api/eda/pcb/layers', {}, false);
  },
  /**
   * 叠层写入：2,4,6,…,32 层（官方 Beta `PCB_Layer.setTheNumberOfCopperLayers`）。
   * 必须带服务端签发的 write 批准；服务端写后强制读回层数 + 层类型（SIGNAL）+ 取证 + 默认保存。
   */
  async setPcbLayers(body: { copperLayers: number; approvalIds?: string[]; save?: boolean }, options: { signal?: AbortSignal } = {}) {
    return request<PcbLayerStackChange>('/api/eda/pcb/layers', { method: 'POST', body: JSON.stringify(body) }, true, 180_000, options.signal);
  },
  /** 覆铜只读详情（布线收尾后核对铺铜是否真的重建；只读不写）。 */
  async pcbPours() {
    return request<{ ok: boolean; pours: PcbPourInfo[] }>('/api/eda/pcb/pours', {}, false);
  },
  /**
   * R5 布线收尾：新铜会切平面 → 重建已有覆铜 + 保存（都是写动作，必须带 write 批准）。
   * 不调这个就只在内存里布线，铺铜与保存状态和全流程脚本不一致。
   */
  async routingFinish(body: { approvalIds?: string[]; rebuildPours?: boolean; save?: boolean } = {}, options: { signal?: AbortSignal } = {}) {
    return request<{ ok: boolean; pours: { rebuilt?: number; items?: Array<{ primitiveId: string; ok: boolean }> } | null; saved: boolean }>('/api/eda/pcb/routing/finish', { method: 'POST', body: JSON.stringify(body) }, true, 240_000, options.signal);
  },
  /**
   * 按板框自动布局：只读，返回方案 + 独立复核 + 与现状的差异。
   * `pcbUuid` 可省略——省略时运行时读当前打开的 PCB 文档。
   */
  async placementPlan(body: { pcbUuid?: string; edgeClearanceMm?: number; spacingMm?: number; gridMm?: number; anchors?: Record<string, unknown>; overhangAllowances?: Record<string, unknown>; designIntent?: unknown; drcReport?: unknown; drcScope?: string; autoDrc?: boolean } = {}, options: { signal?: AbortSignal } = {}) {
    return request<PlacementPlanResult>('/api/eda/pcb/placement/plan', { method: 'POST', body: JSON.stringify(body) }, true, 150_000, options.signal);
  },
  /**
   * 写回布局。**默认预演**（dryRun 未显式给 false 时只算不写）；
   * 运行时会在写入后逐项回读、独立复核，不通过自动回滚，且**永不自动保存**。
   */
  async applyPlacement(body: { pcbUuid?: string; plan: unknown; dryRun?: boolean; edgeClearanceMm?: number; spacingMm?: number; overhangAllowances?: Record<string, unknown>; approvalIds?: string[]; designIntent?: unknown; drcReport?: unknown; drcScope?: string; autoDrc?: boolean }, options: { signal?: AbortSignal } = {}) {
    return request<PlacementWritebackResult>('/api/eda/pcb/placement/apply', { method: 'POST', body: JSON.stringify(body) }, true, 180_000, options.signal);
  },
  /**
   * 下单前闸门：原理图/仿真/DRC/布局/产物/供应链合成一个裁决。
   * 不给 drcReport 时就如实报"没有 DRC 报告"（阻断），绝不当成通过。
   */
  /**
   * 产出裁决：门禁没通过就只能出草稿（正式命名一律拒绝）。
   * 任何"导出正式生产文件"的入口都必须先问这里，不许自己判断门禁过没过。
   */
  /** @legacy LEGACY/未接 UI：放行与产出统一走 `productionExport`（内部已计算 `ReleaseDecision`）；此方法仅保留兼容。 */
  /** @legacy LEGACY/未接 UI（无页面调用方，D8 白名单）：生产输出改走 `productionExport`/`releaseGate`；保留仅为兼容未知外部调用方。 */
  async productionRelease(body: { requested?: 'draft' | 'final'; pcbUuid?: string; pageUuid?: string; documentUuid?: string; drcReport?: unknown; drcReportPath?: string; exemptions?: unknown[]; exemptionsPath?: string; writeback?: unknown; userConfirmed?: boolean; artifactsDir?: string; pricing?: unknown; overhangAllowances?: Record<string, unknown> } = {}) {
    return request<ProductionOutputDecision>('/api/production/release', { method: 'POST', body: JSON.stringify(body) }, true, 180_000);
  },
  /**
   * 导出生产文件：请求里说明要草稿还是正式，运行时**先跑门禁与产出裁决**，获准才写盘。
   * 被拒时不会写任何文件，返回里 `exported=false` 且给出阻断码。
   */
  async productionExport(body: { requested?: 'draft' | 'final'; outDir?: string; kinds?: string[]; pcbUuid?: string; pageUuid?: string; documentUuid?: string; artifactsDir?: string; drcReportPath?: string; exemptionsPath?: string; userConfirmed?: boolean; pricing?: SupplyPricingEvidence | null; overhangAllowances?: Record<string, unknown>; manifestHash?: string; binding?: Record<string, string>; constraints?: unknown[]; designFacts?: Record<string, unknown> | null } = {}, options: { signal?: AbortSignal } = {}) {
    return request<ProductionExportResult>('/api/production/export', { method: 'POST', body: JSON.stringify(body) }, true, 240_000, options.signal);
  },
  /**
   * 板厂下单参数卡：把实测板事实与下单参数放一起核对（只读，不写 EDA，不猜价格）。
   */
  async orderCard(body: { requested?: { layers?: number; thicknessMm?: number; copperWeightOz?: number; surfaceFinish?: string; impedanceControl?: boolean; quantity?: number; panelize?: boolean; leadMaskColor?: string }; pcbUuid?: string; artifactsDir?: string; exportManifestPath?: string; drcReportPath?: string; impedanceNets?: Array<{ name: string; impedanceOhm?: number }>; price?: { amount?: number; currency?: string; source?: string } | null; facts?: unknown; pricingEvidence?: unknown; supplyMaxAgeHours?: number } = {}) {
    return request<FabricationOrderCard>('/api/production/order-card', { method: 'POST', body: JSON.stringify(body) }, true, 60_000);
  },
  /**
   * 按验收结论自动修复原理图（受控写入）：缺 Rd / 缺 I2C 上拉这类缺陷直接落到原理图上，
   * 写完立刻用网表复核并重跑验收。不传 dryRun:false 就只预演，绝不写盘。
   */
  async repairSchematic(body: { pageUuid?: string; dryRun?: boolean; repairs?: Array<{ id?: string; net: string; otherNet: string; valueOhm?: number; mpnKeyword?: string; device?: { libraryUuid: string; uuid: string } }>; spacingMm?: number; startX?: number; skipSimulation?: boolean } = {}, options: { signal?: AbortSignal } = {}) {
    return request<SchematicRepairReport>('/api/eda/schematic/repair', { method: 'POST', body: JSON.stringify(body) }, true, 240_000, options.signal);
  },
  /** B8：不可变发布版本列表（只读；每条带证据文件重校验结果）。 */
  async releaseArchives() {
    return request<{ ok: true; releases: ReleaseArchiveSummary[]; corrupt: Array<{ file: string; error: string }> }>('/api/production/releases', {}, false);
  },

  /** B8：读取单个发布版本（含证据文件与重校验）。 */
  async releaseArchive(releaseId: string) {
    return request<{ ok: true; release: ReleaseArchiveRecord }>(`/api/production/releases/${encodeURIComponent(releaseId)}`, {}, false);
  },

  /** B8：归档一次 ready 的放行（服务端重算门禁/裁决，不接受客户端自报 ready）。 */
  async archiveRelease(body: { artifactsDir?: string; pcbUuid?: string; planHash?: string; compiledPlanHash?: string; pcbExecutionId?: string; reviewHash?: string; notes?: string; acceptance?: unknown; design?: unknown; placementVerification?: unknown; drcReport?: unknown; drcReportPath?: string; userConfirmed?: boolean; pricing?: SupplyPricingEvidence | null; constraints?: unknown[]; designFacts?: Record<string, unknown> | null; engineering?: unknown; layoutAudit?: unknown; engineeringExemptions?: unknown[] } = {}, options: { signal?: AbortSignal } = {}) {
    return request<{ ok: true; release: ReleaseArchiveRecord }>('/api/production/releases/archive', { method: 'POST', body: JSON.stringify(body) }, false, 120_000, options.signal);
  },

  async releaseGate(body: { pcbUuid?: string; pageUuid?: string; documentUuid?: string; drcReport?: unknown; drcReportPath?: string; exemptions?: unknown[]; exemptionsPath?: string; writeback?: unknown; userConfirmed?: boolean; artifactsDir?: string; pricing?: SupplyPricingEvidence | null; overhangAllowances?: Record<string, unknown>; constraints?: unknown[]; designFacts?: Record<string, unknown> | null } = {}, options: { signal?: AbortSignal } = {}) {
    return request<ReleaseGateReport>('/api/eda/release/gate', { method: 'POST', body: JSON.stringify(body) }, true, 180_000, options.signal);
  },
  /**
   * 元件候选提案（只读）：需求/关键词/LCSC 料号 → 真实库检索 + 价格库存证据。
   * 查不到价格就是 unknown + 具体理由，不猜价格；本调用不写任何工程、不落文件。
   */
  async partProposal(body: { requirement?: string; queries?: string[]; lcscIds?: string[]; nets?: string[]; title?: string; target?: 'schematic' | 'pcb'; fetchPricing?: boolean; timeoutMs?: number } = {}, options: { signal?: AbortSignal } = {}) {
    return request<{ proposal: PartProposal }>('/api/library/proposals', { method: 'POST', body: JSON.stringify(body) }, true, 180_000, options.signal);
  },
  /**
   * 用户勾选 → 落 plan（只生成计划，不回写工程）。同一 candidateId 重复出现 = 用量。
   * 真正落板仍必须走 approve（审批令牌绑定 planHash）→ execute。
   */
  async partProposalPlan(body: { proposal: PartProposal; selectedIds: string[]; nets?: string[]; title?: string }) {
    return request<PartProposalPlanResult>('/api/library/proposals/plan', { method: 'POST', body: JSON.stringify(body) }, true, 60_000);
  },
  /**
   * 自动化内核（Phase 0）：列出已登记配方。只读配方不需要批准；写入配方会显式标注 requiredApprovals。
   */
  /** E9：GUI 兜底能力只读探测（findTexts，不点击；可指定 viewport 验证两种尺寸）。 */
  async guiCapabilityProbe(body: { viewport?: { width: number; height: number }; captureScreenshot?: boolean; texts?: string[] } = {}, options: { signal?: AbortSignal } = {}) {
    return request<{ ok: boolean; viewport: { width: number; height: number } | null; requestedViewport: { width: number; height: number } | null; catalogVersion: number; availableCount: number; blockedCount: number; missingTexts: string[]; capabilities: Array<{ id: string; label: string; group: string; write: boolean; blocked: boolean; reason: string | null; recipeIds: string[]; wired: boolean; available: boolean; complete: boolean; missingTexts: string[] }>; screenshot: { ok?: boolean; kind?: string; path?: string; sha256?: string; error?: string; cdpError?: string; fallbackError?: string } | null }>('/api/eda/gui/capabilities/probe', { method: 'POST', body: JSON.stringify(body) }, true, 120_000, options.signal);
  },
  async automationRecipes() {
    const result = await request<{ recipes: AutomationRecipeSummary[] }>('/api/automation/recipes');
    return result.recipes;
  },
  /**
   * 跑一个自动化配方：每步执行后用只读通道读回断言，只有全部通过才返回 completed。
   * approvals 是人工批准作用域（plan/write/release）；缺批准会在执行第一步前被拦下（needs_approval）。
   */
  async runAutomation(body: { recipeId: string; params?: Record<string, unknown>; approvalIds?: string[]; runId?: string }) {
    const result = await request<{ runId?: string; run: AutomationRunResult }>('/api/automation/run', { method: 'POST', body: JSON.stringify(body) }, true, 600_000);
    return result.run;
  },
  /** E7 恢复：列出重启后未完成的 run 及其安全结论（只读；写过的 run 一律 needs_human）。 */
  async automationRecovery() {
    const result = await request<{ recovery: { available: boolean; reason?: string; scanned: number; corrupt?: number; runs: AutomationRecoveryRun[] } }>('/api/automation/recovery');
    return result.recovery;
  },
  /** E7 恢复：只对“全程只读”的中断 run 显式安全重放；其它结论服务端 409。 */
  async replayAutomationRun(runId: string, options: { signal?: AbortSignal } = {}) {
    const result = await request<{ replay: { recoveredFrom: string; runId: string; run: AutomationRunResult; snapshot: AutomationRecoveryRun } }>(`/api/automation/runs/${encodeURIComponent(runId)}/replay`, { method: 'POST', body: JSON.stringify({}) }, true, 600_000, options.signal);
    return result.replay;
  },
  /** A6/R3：原理图批量落件计划（默认 dryRun，只读比对；返回 planHash/逐项动作）。 */
  async schematicComponentBatchPlan(body: { items: SchematicBatchItem[]; dryRun?: boolean; save?: boolean; resume?: boolean; approvalIds?: string[]; documentUuid?: string; pageUuid?: string; toleranceMm?: number }, options: { signal?: AbortSignal } = {}) {
    return request<SchematicBatchResult>('/api/eda/schematic/component-batch', { method: 'POST', body: JSON.stringify(body) }, true, 600_000, options.signal);
  },
  /** A6/R3：原理图批量落件执行（dryRun:false 且必须带一次性写板批准；逐件写进度，失败即停可续跑）。 */
  async schematicComponentBatchApply(body: { items: SchematicBatchItem[]; dryRun: false; save?: boolean; resume?: boolean; approvalIds: string[]; documentUuid?: string; pageUuid?: string; toleranceMm?: number }, options: { signal?: AbortSignal } = {}) {
    return request<SchematicBatchResult>('/api/eda/schematic/component-batch', { method: 'POST', body: JSON.stringify(body) }, true, 600_000, options.signal);
  },
  /** E7 中止：只对“正在执行”的 run 有效；在下一个步骤边界生效，结束后的 run 会被 409 拒绝。 */
  async abortAutomationRun(runId: string) {
    return request<{ ok: boolean; runId: string; abortRequested: boolean; note?: string }>(`/api/automation/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST', body: JSON.stringify({}) }, true, 30_000);
  },
  /** 签发一次人工批准（服务端绑定当前 EDA 窗口+工程+文档指纹；一次性、30 分钟有效）。 */
  async issueAutomationApproval(body: { scope: 'plan' | 'write' | 'release'; recipeId?: string | null; planHash?: string | null; note?: string }) {
    const result = await request<{ approval: AutomationApproval }>('/api/automation/approvals', { method: 'POST', body: JSON.stringify(body) }, true, 60_000);
    return result.approval;
  },
  /** 列出仍可用的人工批准。 */
  async automationApprovals() {
    const result = await request<{ approvals: AutomationApproval[] }>('/api/automation/approvals');
    return result.approvals;
  },
  /** 读取一次自动化运行的哈希链审计记录（含篡改检测结果）。 */
  /** E11：写步骤安全审计包（before/after 截图摘要 + 读回 + 批准 id/目标指纹 + 哈希链校验；只读）。 */
  /** E10：可编排目标列表（确定性 profile 表）。 */
  async orchestrationGoals() {
    return request<{ ok: true; goals: Array<{ id: string; label: string }> }>('/api/automation/orchestration/goals', {}, false);
  },

  /** E10：目标 → 配方序列计划（只出计划；预算超限/目标不支持时 fail-closed）。 */
  async planOrchestration(body: { goal: string; budget?: { maxRecipes?: number; maxWriteRecipes?: number; maxEstimatedSeconds?: number }; evidence?: unknown }) {
    return request<{ ok: true; plan: OrchestrationPlan }>('/api/automation/orchestration/plan', { method: 'POST', body: JSON.stringify(body) }, false);
  },

  /** E10：失败分类 → 恢复决策（人审；写动作永不自动重放）。 */
  async orchestrationFailure(body: { errorCode: string; stage: 'read' | 'write' | 'verify' | 'gate'; attempt?: number; planId?: string; nodeId?: string }) {
    return request<{ ok: true; recovery: OrchestrationRecovery }>('/api/automation/orchestration/failure', { method: 'POST', body: JSON.stringify(body) }, false);
  },

  async automationAuditBundle(runId: string) {
    return request<{ ok: true; bundle: AutomationAuditBundle }>(`/api/automation/runs/${encodeURIComponent(runId)}/audit-bundle`);
  },
  async automationRun(runId: string) {
    const result = await request<{ run: { runId: string; entries: AutomationJournalEntry[]; chain: AutomationChainReport; journalPath: string } }>(`/api/automation/runs/${encodeURIComponent(runId)}`);
    return result.run;
  },

  // ------------------------------------------------------------ DRC 取证（A12）
  async latestPcbDrc() {
    const result = await request<{ evidence: DrcEvidenceEntry | null }>('/api/eda/pcb/drc/latest', {}, false);
    return result.evidence;
  },
  async startPcbDrc() {
    return request<{ ok: boolean; jobId: string; state: string; startedAt?: string | null }>('/api/eda/pcb/drc/start', { method: 'POST', body: JSON.stringify({}) }, false, 30_000);
  },
  async pcbDrcReport(jobId: string, pcbUuid?: string) {
    return request<{ ok: boolean; state: string; jobId: string; report?: DrcReport; classification?: Record<string, unknown>; exemptions?: Record<string, unknown>; template?: unknown; saved?: { path: string; digest: string; savedAt: string } }>('/api/eda/pcb/drc/report', { method: 'POST', body: JSON.stringify({ jobId, ...(pcbUuid ? { pcbUuid } : {}) }) }, false, 60_000);
  },
  async pcbDrcCancel(jobId: string) {
    return request<{ ok: boolean; jobId: string; cancelled?: unknown }>('/api/eda/pcb/drc/cancel', { method: 'POST', body: JSON.stringify({ jobId }) }, false, 30_000);
  },
  async pcbDrcExemptions() {
    return request<{ ok: boolean; path?: string; exists?: boolean; count?: number; exemptions?: Array<Record<string, unknown>>; invalid?: unknown[] }>('/api/eda/pcb/drc/exemptions', {}, false);
  },
  async savePcbDrcExemptions(exemptions: Array<Record<string, unknown>>) {
    return request<{ ok: boolean; path?: string; count?: number }>('/api/eda/pcb/drc/exemptions', { method: 'PUT', body: JSON.stringify({ exemptions }) }, false);
  },
  // ------------------------------------------------------------ 原理图 ERC 收敛（A13，只读取证）
  async ercRun(options: { signal?: AbortSignal } = {}) {
    return request<{ ok: boolean; erc: ErcReport; summary: ErcConvergenceSummary; ercDetail: ErcDetailMeta | null; saved: { path: string; digest: string; savedAt: string } }>('/api/eda/schematic/erc/run', { method: 'POST', body: '{}' }, true, 120_000, options.signal);
  },
  async ercLatest() {
    return request<{ ok: boolean; evidence: ErcEvidenceEntry | null }>('/api/eda/schematic/erc/latest');
  },
  async ercExemptions() {
    return request<{ ok: boolean; path?: string; exists?: boolean; exemptions?: Array<{ code: string; object: string | null; reason: string }>; invalid?: Array<{ index: number; problems: string[] }> }>('/api/eda/schematic/erc/exemptions');
  },
  /** A4：引脚证据采集（只读；PCB 焊盘为权威来源，可核对原理图位号覆盖）。 */
  /** A4：两阶段"先落器件→读引脚→再生成网表"的计划层（只出计划，不执行、不代批准）。 */
  async pinFirstFlowPlan(body: { pcbExecutionId?: string | null; pinEvidence?: unknown; pinAudit?: unknown; assumptionAudit?: unknown; assumptions?: string[]; notes?: string } = {}) {
    return request<{ ok: true; plan: { schemaVersion: number; kind: string; planId: string; executable: boolean; autoExecute: boolean; pcbExecutionId: string | null; pinEvidenceDigest: string | null; blockers: Array<{ code: string; message: string }>; decisionLog: string[]; stages: Array<{ id: string; order: number; type: string; title: string; dependsOn: string[]; requiresApproval: boolean; reason: string; expectedEvidence: string[] }> } }>('/api/automation/flows/pin-first-netlist', { method: 'POST', body: JSON.stringify(body) }, false);
  },

  async pinEvidence(body: { pcbUuid?: string; includeSchematic?: boolean; assumptions?: Array<{ designator: string; pad: string; reason: string }> } = {}, options: { signal?: AbortSignal } = {}) {
    return request<{ ok: boolean; evidence: { rows: Array<{ designator: string; pad: string; net: string; layer: number | null; throughHole: boolean; assumption: string | null }>; components: Array<{ designator: string; pins: number; withNet: number; assumed: number }>; schematic: { parts: number; onlySchematic: string[]; onlyPcb: string[] } }; audit: { ok: boolean; counts: { components: number; pins: number; withNet: number; assumed: number; unknown: number }; blockers: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> }; readback: { pads: number; components: number; schematicParts: number | null } }>('/api/eda/pins/evidence', { method: 'POST', body: JSON.stringify(body) }, true, 120_000, options.signal);
  },
  /** 原理图验收（网表/ERC/结构比对 + 仿真或设计检查点）；仿真结论会落盘为 spice-simulation 证据。 */
  async schematicAcceptance(body: { schematicUuid?: string; plan?: unknown; skipSimulation?: boolean; expectations?: Record<string, [number, number]>; timeoutMs?: number; solverPath?: string; persistSimulation?: boolean } = {}, options: { signal?: AbortSignal } = {}) {
    return request<{ ok: boolean; schematic: { schematicUuid: string | null; activated: boolean }; acceptance: { ready: boolean; netlist: unknown; simulation: unknown; designChecks: { summary?: { total: number; passed: number; failed: number; simulated?: boolean }; results?: Array<{ id: string; title: string; status: string }>; findings?: unknown[] } | null; findings: Array<{ code?: string; message?: string; severity?: string }> }; savedSimulation: { path: string; digest: string; savedAt: string } | null }>('/api/eda/schematic/acceptance', { method: 'POST', body: JSON.stringify(body) }, true, 300_000, options.signal);
  },
  /** A14：SPICE 仿真取证（真实求解器；缺求解器/网表时结构化失败，不伪造通过）。 */
  async simulationRun(body: { netlistText?: string; schematicUuid?: string; solverPath?: string; timeoutMs?: number; expectations?: Record<string, [number, number]>; persist?: boolean } = {}) {
    return request<{ ok: boolean; ran: boolean; evidence: { evidenceHash?: string; solver?: { path?: string; version?: string | null }; operatingPoint?: Record<string, number>; netlist?: { sha256?: string }; output?: { sha256?: string } } | null; verification: { ok: boolean; findings: unknown[] }; findings: unknown[]; saved: { path: string; digest: string; savedAt: string } | null; netlist: { bytes: number; exportMeta: unknown } }>('/api/eda/schematic/simulation/run', { method: 'POST', body: JSON.stringify(body) }, true, 90_000);
  },
  async simulationLatest() {
    return request<{ ok: boolean; evidence: { digest: string; path: string; savedAt: string; payload?: { evidence?: { evidenceHash?: string; solver?: { path?: string }; operatingPoint?: Record<string, number> } } } | null }>('/api/eda/schematic/simulation/latest');
  },
  async saveErcExemptions(exemptions: Array<{ code: string; object?: string | null; reason: string }>) {
    return request<{ ok: boolean; saved: { path: string; count: number } }>('/api/eda/schematic/erc/exemptions', { method: 'PUT', body: JSON.stringify({ exemptions }) });
  },

  // ------------------------------------------------------------ 统一批准账本（计划/写板/放行）
  async approvalLedger() { return request<ApprovalLedgerSnapshot & { ok: boolean }>('/api/approvals/ledger'); },

  // ------------------------------------------------------------ C5 证据索引 / B10 制造物保留计划（只读/ dry-run）
  /** C5：服务端证据目录索引（kind/digest/savedAt/fingerprint，含坏文件与重复副本）。 */
  /** C3：执行 journal + 批准账本 + 证据索引合成的统一时间线（只读、有界、坏行暴露）。 */
  async timeline(runId?: string, limit = 200) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (runId && runId.trim()) params.set('runId', runId.trim());
    return request<TimelineResult>(`/api/timeline?${params.toString()}`);
  },
  /** C3（剩余）：把证据 digest 显式关联到一次 run（append-only；不存在的 run/证据 404，重复 409）。 */
  async linkTimeline(body: { runId: string; digest: string; note?: string }) {
    return request<{ ok: true; link: { runId: string; digest: string; note: string | null; at: string } }>('/api/timeline/link', { method: 'POST', body: JSON.stringify(body) });
  },
  async evidenceIndex() {
    return request<{ ok: boolean; index: { generatedAt: string; complete: boolean; truncated: boolean; summary: { entries: number; kinds: Record<string, number>; invalid: number; duplicates: number }; entries: Array<{ path: string; kind: string; digest: string | null; savedAt: string | null; fingerprint: Record<string, unknown>; schemaVersion: number | null; note: string | null }>; invalid: Array<{ path: string; code: string; message: string }>; errors: Array<{ dir: string; message: string }> } }>('/api/evidence/index');
  },
  /** C5：按 kind/digest 在索引里查找证据（未命中返回 404，不伪造命中）。 */
  async evidenceFind(params: { kind?: string; digest?: string }) {
    const query = new URLSearchParams();
    if (params.kind) query.set('kind', params.kind);
    if (params.digest) query.set('digest', params.digest);
    return request<{ ok: boolean; evidence: { path: string; kind: string; digest: string | null; savedAt: string | null; fingerprint: Record<string, unknown> }; index: { generatedAt: string; complete: boolean; summary: unknown } }>(`/api/evidence/find?${query.toString()}`);
  },
  /** C5：证据保留计划（dry-run；模块本身没有删除能力）。 */
  async evidenceRetentionPlan(body: { keepPerKind?: number; keepDays?: number } = {}) {
    return request<{ ok: boolean; plan: { dryRun: true; safeToApply: boolean; blockedReasons: string[]; summary: Record<string, number>; keep: unknown[]; prune: Array<{ kind: string; path: string; digest: string | null; savedAt: string | null; reason: string }> } }>('/api/evidence/retention/plan', { method: 'POST', body: JSON.stringify(body) });
  },
  /** B10：制造物保留计划（dry-run；扫描白名单目录，不接受任意路径）。 */
  async artifactRetentionPlan(body: { dirs?: string[]; policy?: Record<string, unknown> } = {}) {
    return request<{ ok: boolean; plan: { dryRun: true; targets: Array<{ kind: string; path: string; bytes: number; savedAt: string; reason: string }>; keep: unknown[]; disabled: unknown[]; summary: Record<string, number> }; scanned: { dirs: string[]; entries: number } }>('/api/artifacts/retention/plan', { method: 'POST', body: JSON.stringify(body) });
  },

  // ------------------------------------------------------------ 产物下载（仅放行目录内已知类型）
  /** 下载放行产物：服务端做路径白名单/realpath 校验/扩展名白名单，客户端只负责取回字节流。 */
  async downloadProductionArtifact(path: string): Promise<{ blob: Blob; name: string }> {
    if (!sessionProof) await runtimeClient.health();
    const response = await fetch(`${BASE_URL}/api/production/download?path=${encodeURIComponent(path)}`, {
      headers: sessionProof ? { 'x-circuitpilot-token': sessionProof } : {},
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = (body as { error?: { code?: string; message?: string } }).error;
      throw new RuntimeApiError(error?.code || 'DOWNLOAD_FAILED', error?.message || `下载失败（HTTP ${response.status}）`, response.status);
    }
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const name = match ? decodeURIComponent(match[1]) : 'artifact';
    return { blob: await response.blob(), name };
  },

  // ------------------------------------------------------------ 供应链证据（在线价格/库存，人工触发）
  /** 只查精确 LCSC 料号；查不到就是 unknown + 原因，前端绝不把 unknown 当 0 元。 */
  async supplyPricing(body: { lcscIds: string[]; timeoutMs?: number }) {
    const result = await request<{ ok: boolean; pricing: SupplyPricingEvidence }>('/api/supply/pricing', { method: 'POST', body: JSON.stringify(body) }, true, 60_000);
    return result.pricing;
  },

  /** B9：缺料替代候选（真实关键词检索；候选显式 equivalence=unverified，不冒充等价替代）。 */
  async supplyAlternatives(body: { items: Array<{ lcscId?: string; mpn?: string; value?: string; package?: string }>; maxCandidates?: number; timeoutMs?: number }) {
    return request<{ ok: boolean; source: string; checkedAt: string; results: Array<{ lcscId: string | null; query: string | null; status: 'found' | 'empty' | 'invalid' | 'failed'; code?: string; message?: string; checkedAt?: string | null; source?: string | null; candidates: Array<{ lcscId: string; model: string | null; package: string | null; brand: string | null; description: string | null; price: number | null; currency: string | null; stock: number | null; minQty: number | null; url: string | null; match: 'keyword'; equivalence: 'unverified'; inStock: boolean; stockUnknown: boolean }> }>; summary: { requested: number; found: number; empty: number; invalid: number; failed: number; candidates: number } }>('/api/supply/alternatives', { method: 'POST', body: JSON.stringify(body) }, true, 90_000);
  },

  // ------------------------------------------------------------ 执行历史（落盘，重启后仍在）
  async designExecutions() {
    return request<ExecutionHistoryList>('/api/design/executions');
  },
  async pcbExecutions() {
    return request<ExecutionHistoryList>('/api/pcb/executions');
  },
  async designExecution(executionId: string) {
    const result = await request<{ ok: boolean; execution: Record<string, unknown> }>(`/api/design/executions/${encodeURIComponent(executionId)}`);
    return result.execution;
  },
  async pcbExecution(executionId: string) {
    const result = await request<{ ok: boolean; execution: Record<string, unknown> }>(`/api/pcb/executions/${encodeURIComponent(executionId)}`);
    return result.execution;
  },

  // ------------------------------------------------------------ 3D 模型导出（STEP / GLB）
  async pcb3dExport(body: { pcbUuid?: string; format?: 'step' | 'glb' }, options: { signal?: AbortSignal } = {}) {
    return request<{ ok: boolean; pcbUuid: string; model: { path: string; bytes: number; sha256: string; format: string; chunks: number; elements: number | null } }>(
      '/api/pcb/3d/export', { method: 'POST', body: JSON.stringify(body) }, true, 320_000, options.signal,
    );
  },

  // ------------------------------------------------------------ 人工证据（DFM / 终审）
  async saveDfmEvidence(payload: { passed: boolean; operator?: string; conclusion?: string; source?: string; url?: string; planHash?: string; pcbUuid?: string; artifacts?: Array<Record<string, unknown>> }) {
    const result = await request<{ evidence: DfmEvidenceEntry }>('/api/production/dfm-evidence', { method: 'POST', body: JSON.stringify(payload) }, false);
    return result.evidence;
  },
  async latestDfmEvidence(planHash?: string) {
    const query = planHash ? `?planHash=${encodeURIComponent(planHash)}` : '';
    const result = await request<{ evidence: DfmEvidenceEntry | null }>(`/api/production/dfm-evidence/latest${query}`, {}, false);
    return result.evidence;
  },
  /** E3/R10：下单参数卡人工确认 + 支付人工声明（只落证据；系统不代下单、不代付）。 */
  async saveOrderConfirmation(payload: { card: FabricationOrderCard; operator: string; note?: string; paymentManual: boolean }) {
    const result = await request<{ confirmation: { path: string; digest: string; savedAt: string; payload: OrderConfirmationPayload } }>('/api/production/order-confirmation', { method: 'POST', body: JSON.stringify(payload) }, false);
    return result.confirmation;
  },
  async latestOrderConfirmation() {
    const result = await request<{ evidence: { path: string; digest: string; savedAt: string; payload: OrderConfirmationPayload } | null }>('/api/production/order-confirmation/latest', {}, false);
    return result.evidence;
  },
  async recordSignoff(payload: { passed: boolean; roles: Array<{ role: string; name: string; conclusion?: string }>; manifestHash: string; planHash?: string; pcbUuid?: string; operator?: string; conclusion?: string }) {
    const result = await request<{ evidence: SignoffEvidenceEntry }>('/api/production/signoff', { method: 'POST', body: JSON.stringify(payload) }, false);
    return result.evidence;
  },
  async latestSignoff(manifestHash?: string) {
    const query = manifestHash ? `?manifestHash=${encodeURIComponent(manifestHash)}` : '';
    const result = await request<{ evidence: SignoffEvidenceEntry | null }>(`/api/production/signoff/latest${query}`, {}, false);
    return result.evidence;
  },
};

export interface PartProposalPrice {
  status: 'priced' | 'unknown';
  reason?: string;
  unitPrice?: number;
  stock?: number | null;
  currency?: string;
  minQty?: number | null;
  checkedAt?: string | null;
}

export interface PartProposalCandidate {
  candidateId: string;
  name: string;
  uuid: string;
  libraryUuid: string;
  lcscId: string | null;
  manufacturer?: string | null;
  manufacturerPart?: string | null;
  description?: string | null;
  footprintName?: string | null;
  symbolName?: string | null;
  datasheet?: string | null;
  price: PartProposalPrice;
  stockNote?: string | null;
  rank: number;
  evidence: { libraryIdentity: boolean; lcscId: boolean; price: boolean; confirmed: boolean };
}

export interface PartProposal {
  apiVersion: number;
  proposalId: string;
  requirement: string;
  title: string;
  queries: string[];
  lcscIds: string[];
  nets: string[];
  target: 'schematic' | 'pcb';
  createdAt: string;
  candidates: PartProposalCandidate[];
  summary: { candidates: number; withLcscId: number; priced: number; unknownPrice: number; stockWarnings: number };
}

export interface PartProposalPlanResult {
  apiVersion: number;
  proposalId: string | null;
  selection: {
    selected: Array<{ candidateId: string; name: string; lcscId: string | null; uuid: string; libraryUuid: string; quantity: number; price: PartProposalPrice; stockNote?: string | null }>;
    confirmedByUser: boolean;
    totalParts: number;
  };
  plan: { kind: string; title: string; nets: string[]; operations: Array<{ type: string; args: Record<string, unknown> }> };
  planHash: string;
  planning: { ready: boolean; missing: string[] };
  notes: string[];
}


export interface AutomationRecipeStepSummary {
  id: string;
  title: string;
  kind: 'api' | 'gui' | 'human';
  action: string;
  approval: 'plan' | 'write' | 'release' | null;
  policy: 'abort' | 'rollback' | 'human';
  fallback?: number;
}

export interface AutomationRecipeSummary {
  id: string;
  title: string;
  version: number;
  summary: string;
  stepCount: number;
  requiredApprovals: Array<'plan' | 'write' | 'release'>;
  params: Record<string, { required: boolean; description: string; pattern?: string | null; example?: unknown }>;
  steps: AutomationRecipeStepSummary[];
}

export type AutomationRunState = 'completed' | 'failed' | 'needs_approval' | 'needs_params' | 'needs_human' | 'rollback_failed';

export interface AutomationApprovalTarget {
  fingerprint: string;
  windowId: string | null;
  projectUuid: string | null;
  documentUuid: string | null;
}

export interface AutomationApproval {
  approvalId: string;
  scope: 'plan' | 'write' | 'release';
  recipeId: string | null;
  fingerprint: string | null;
  planHash: string | null;
  issuedAt: string;
  expiresAt: string;
  target?: AutomationApprovalTarget;
}

export interface AutomationStepResult {
  stepId: string;
  ok: boolean;
  verified: boolean;
  attempts?: number;
  kind?: 'human';
  strategy?: 'primary' | 'fallback';
  evidence?: {
    stateDigest?: string;
    checks?: number;
    /** E11：动作前截图（sha256 绑定；取不到则 ok:false + error，不伪装成功）。 */
    before?: { bytes?: number | null; sha256?: string | null; ok?: boolean; error?: string | null; kind?: string | null; path?: string | null; fallbackFrom?: string | null };
    /** E11：验证通过后截图。 */
    after?: { bytes?: number | null; sha256?: string | null; ok?: boolean; error?: string | null; kind?: string | null; path?: string | null; fallbackFrom?: string | null };
    /** 兼容旧字段：等同 after。 */
    screenshot?: { bytes?: number | null; sha256?: string | null; ok?: boolean; error?: string };
  };
}

export interface AutomationChainReport {
  ok: boolean;
  brokenAt: number | null;
  entries: number;
  lastHash: string;
  message?: string;
}

/** A6/R3 原理图批量落件：单项身份（库身份 + 坐标是硬要求，服务端拒绝猜身份）。 */
export interface SchematicBatchItem {
  component: { libraryUuid: string; uuid: string };
  x: number;
  y: number;
  rotation?: number;
  mirror?: boolean;
  subPartName?: string;
  addIntoBom?: boolean;
  addIntoPcb?: boolean;
}

export interface SchematicBatchPlanItem { key: string; coordinate: string; action: 'create' | 'skip-existing' | string; matchedBy: string | null; existing?: unknown; x: number; y: number }

export interface SchematicBatchResult {
  dryRun: boolean;
  plan: {
    planHash: string;
    counts: { total?: number; create?: number; skipExisting?: number; [key: string]: number | undefined };
    identityUnproven: string[];
    duplicateGroups: unknown[];
    findings: Array<{ code?: string; message?: string; [key: string]: unknown }>;
    items: SchematicBatchPlanItem[];
  };
  applied?: { created?: number; skipped?: number; saved?: boolean; verified?: boolean; resumedFrom?: string | null; [key: string]: unknown } | null;
}

/** E7 恢复：重启后未完成 run 的只读分析结论（写过的 run 一律 needs_human）。 */
export interface AutomationRecoveryRun {
  runId: string;
  recipeId: string | null;
  recipeTitle?: string | null;
  terminal: boolean;
  lastPhase: string | null;
  lastAt?: string | null;
  entries: number;
  completedSteps: string[];
  currentStep: string | null;
  writeStarted: boolean;
  verdict: 'readonly_replayable' | 'needs_human' | 'unknown_recipe' | 'corrupt' | 'finished';
  reason: string;
}

/** E10：目标编排计划（确定性映射；只出计划，不执行、不代批准）。 */
export interface OrchestrationPlanNode {
  id: string;
  kind: 'recipe' | 'gate';
  gateId: string | null;
  recipeId: string | null;
  stage: 'read' | 'write' | 'verify' | 'gate';
  dependsOn: string[];
  approvalRequired: boolean;
  params: Record<string, unknown>;
  paramsInference?: { ok: boolean | null; status?: string; code?: string | null; message?: string | null; sources?: Record<string, string>; missing?: string[]; notes?: string[] };
  expectedEvidence: string;
  reason: string;
}

export interface OrchestrationPlan {
  ok: boolean;
  planId: string;
  goal: string;
  profile: { id: string; label: string };
  nodes: OrchestrationPlanNode[];
  budget: {
    limits: { maxRecipes: number; maxWriteRecipes: number; maxEstimatedSeconds: number };
    usage: { recipes: number; writeRecipes: number; estimatedSeconds: number };
    ok: boolean;
    blockers: Array<{ code: string; message: string }>;
    estimateBasis: string;
    tokenBudget: string;
    note: string;
  };
  decisionLog: Array<{ at: string; step: string; detail: string }>;
  warnings: string[];
}

export interface OrchestrationRecovery {
  ok: boolean;
  errorCode: string;
  stage: 'read' | 'write' | 'verify' | 'gate';
  planId: string | null;
  nodeId: string | null;
  decision: { action: 'retry_same_node' | 'needs_reapproval' | 'needs_human_inspection' | 'needs_human'; retryNodeId: string | null; requiresReapproval: boolean; autoReplayAllowed: boolean; maxAttempts?: number };
  explanation: string[];
  policy: string;
  humanReviewRequired: boolean;
}

/** E11：一次运行的写步骤安全审计包（before/after 截图摘要 + 读回 + 批准 id/指纹 + 链校验 + warnings）。 */
export interface AutomationAuditEvidenceSummary {
  ok: boolean;
  sha256: string | null;
  bytes: number | null;
  kind: string | null;
  path: string | null;
  fallbackFrom: string | null;
  error: string | null;
  at: string | null;
}

export interface AutomationAuditBundle {
  ok: boolean;
  runId: string;
  recipeId: string | null;
  recipeVersion: number | null;
  generatedAt: string;
  chain: { ok: boolean; entries: number; lastHash: string | null; brokenAt: number | null; message: string | null };
  approvals: {
    required: string[];
    granted: Record<string, boolean>;
    operatorBinding: { mode: string; fingerprint: string | null; note: string };
    approvalIds: string[];
  };
  steps: Array<{
    stepId: string;
    stepIndex: number | null;
    title: string | null;
    phase: string | null;
    ok: boolean | null;
    approvalScope?: string;
    evidence: { before: AutomationAuditEvidenceSummary | null; after: AutomationAuditEvidenceSummary | null };
    readbacks: Array<{ attempt: number | null; strategy: string | null; ok: boolean; stateDigest: string | null; reason: string | null; at: string | null }>;
  }>;
  writeSteps: Array<{ stepId: string; evidence: { before: AutomationAuditEvidenceSummary | null; after: AutomationAuditEvidenceSummary | null }; readbacks: AutomationAuditBundle['steps'][number]['readbacks'] }>;
  summary: { steps: number; writeSteps: number; verifications: number; failures: number; evidenceComplete: boolean };
  warnings: Array<{ code: string; message: string }>;
}

export interface AutomationRunResult {
  ok: boolean;
  state: AutomationRunState;
  runId: string;
  recipeId: string;
  steps: AutomationStepResult[];
  requiredApprovals?: Array<'plan' | 'write' | 'release'>;
  missingApprovals?: Array<'plan' | 'write' | 'release'>;
  missingParams?: string[];
  invalidParams?: Array<{ name: string; pattern: string }>;
  failedStep?: { stepId: string; stepIndex: number; title: string; policy: string; failures: string[] };
  pausedStep?: { stepId: string; stepIndex: number; title: string; policy?: string; failures?: string[] };
  rollback?: { ok: boolean; executed: Array<{ index: number; ok: boolean }>; failures: Array<{ index: number; error: string }> };
  journalPath?: string | null;
}

export interface AutomationJournalEntry {
  schemaVersion: number;
  runId: string;
  seq: number;
  at: string;
  phase: string;
  prevHash: string;
  hash: string;
  [key: string]: unknown;
}
