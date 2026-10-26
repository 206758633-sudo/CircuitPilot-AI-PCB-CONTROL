export type PageId =
  | 'overview'
  | 'design'
  | 'projects'
  | 'requirements'
  | 'assets'
  | 'ai'
  | 'eda'
  | 'automation'
  | 'placement'
  | 'validation'
  | 'knowledge'
  | 'versions'
  | 'settings'
  | 'proposal';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
export type RequirementStatus = 'confirmed' | 'suggested' | 'missing' | 'conflict';
export type TaskStatus =
  | 'draft'
  | 'planning'
  | 'waiting'
  | 'planned'
  | 'approved'
  | 'snapshotting'
  | 'executing'
  | 'reading'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** D5：项目阶段与 stageMachine 的 8 阶段 canonical 值一致（旧记录的 'PCB布局' 由 stageOfProjectStage 映射）。 */
export type ProjectStage = '概念' | '需求' | '选型' | '原理图' | 'PCB' | '验证' | '生产' | '归档';

/**
 * 当前项目在嘉立创EDA中绑定的设计身份。
 * 来源：POST /api/eda/workspaces 或 GET /api/eda/workspaces/current
 * 返回结构见 runtime/server.mjs。schematicStatus 由前端在绑定/写入成功后维护。
 */
export interface EdaWorkspaceBinding {
  projectUuid: string;
  boardName: string;
  schematicUuid: string;
  schematicPageUuid: string;
  pcbUuid: string;
  schematicStatus: 'empty' | 'generated';
  tabId?: string;
  activated?: boolean;
  /**
   * D5：受控写入证据（只有 Runtime 回读成功才写；用于阶段机 UI 预检，**不代替** Runtime 账本/执行记录）。
   * 旧项目没有这些字段 = 未验证，阶段机不认。
   */
  schematicExecutedAt?: string;
  schematicExecutionId?: string;
  netlistExecutedAt?: string;
  netlistExecutionId?: string;
  pcbPlacementExecutedAt?: string;
  pcbPlacementApprovalId?: string;
}

export interface Project {
  id: string;
  name: string;
  code: string;
  description: string;
  stage: ProjectStage;
  rootPath: string;
  edaProjectPath: string;
  edaWorkspace?: EdaWorkspaceBinding;
  /** 归档前的工作流阶段，供取消归档时还原，避免恢复后一律退回“概念”。 */
  stageBeforeArchive?: ProjectStage;
  archived: boolean;
  progress: number;
  updatedAt: string;
}

export interface Requirement {
  id: string;
  category: string;
  name: string;
  value: string;
  unit: string;
  source: string;
  status: RequirementStatus;
  kind: 'hard' | 'soft';
  blocking: boolean;
  note: string;
  updatedAt: string;
}

export interface FileAsset {
  id: string;
  name: string;
  type: string;
  size: string;
  version: string;
  status: 'official' | 'parsed' | 'warning';
  authoritative: boolean;
  addedByUser: boolean;
  hash: string;
  linkedTo: string[];
}

export interface ComponentItem {
  id: string;
  projectId?: string;
  refdes: string;
  mpn: string;
  manufacturer: string;
  package: string;
  lcscId: string;
  qty: number;
  status: 'approved' | 'risk' | 'pending';
  value: string;
  alternate?: string;
  alternateApproved?: boolean;
  risk?: string;
  easyEdaBinding?: EasyEdaDeviceBinding;
}

export interface EasyEdaLibraryPart { name: string; uuid: string; libraryUuid: string }
export interface EasyEdaDeviceSearchItem {
  name: string;
  uuid: string;
  libraryUuid: string;
  description?: string;
  symbol?: EasyEdaLibraryPart;
  footprint?: EasyEdaLibraryPart;
  model3D?: EasyEdaLibraryPart;
  otherProperty?: Record<string, boolean | number | string>;
}
export type EasyEdaDeviceBinding = Omit<EasyEdaDeviceSearchItem, 'description' | 'otherProperty'> & { boundAt: string };

export interface BomDraftItem {
  id: string;
  refdes: string;
  qty: number;
  value: string;
  mpn: string;
  manufacturer: string;
  package: string;
  lcscId: string;
  status: 'ready' | 'pending' | 'risk';
  risk: string;
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
  candidates: EasyEdaDeviceSearchItem[];
}

export interface BomDraft {
  id: string;
  status: 'blocked' | 'draft' | 'applied';
  title: string;
  summary: string;
  blockingQuestions: string[];
  assumptions: string[];
  items: BomDraftItem[];
  /** 生成该草案时所属的项目，用于阻止确认写入时误写到其他项目。 */
  projectId?: string;
  appliedAt?: string;
}

export interface TaskStep {
  id: string;
  title: string;
  description: string;
  affected: string[];
  selected: boolean;
  status: 'pending' | 'approved' | 'running' | 'done' | 'failed';
  risk: 'low' | 'medium' | 'high';
}

export interface AiTask {
  id: string;
  goal: string;
  mode: 'read_only' | 'controlled_write';
  scope: string[];
  status: TaskStatus;
  planHash: string;
  evidence: string[];
  unknowns: string[];
  risks: string[];
  steps: TaskStep[];
  alternative: boolean;
  simulateFailure: boolean;
  error?: string;
  progress: number;
  /** 输入变化导致旧批准失效的记录：说明是哪个触发器、何时失效，避免"看起来还批准着"。 */
  invalidation?: { trigger: 'requirement' | 'component' | 'asset' | 'project' | 'eda' | 'code'; reason: string; at: string };
  /** C4：批准时绑定的环境快照（EDA 目标指纹 / Runtime 版本）；任一漂移都会自动标废。 */
  boundEnv?: { edaFingerprint: string | null; runtimeVersion: string | null; at: string };
}

export type ChatMessageStatus = 'sending' | 'complete' | 'error';
export type RequirementSuggestionStatus = 'pending' | 'accepted' | 'rejected';

export interface RequirementSuggestion {
  id: string;
  action: 'add' | 'update';
  targetRequirementId: string | null;
  category: string;
  name: string;
  value: string;
  unit: string;
  kind: 'hard' | 'soft';
  blocking: boolean;
  note: string;
  status: RequirementSuggestionStatus;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status: ChatMessageStatus;
  questions?: string[];
  suggestions?: RequirementSuggestion[];
  bomDraft?: BomDraft;
  errorCode?: string;
  attachments?: Array<{ id: string; name: string; mime: string; size: number; kind: 'image' | 'text' }>;
}

export interface ChatState {
  sessionId: string;
  messages: ChatMessage[];
  status: 'idle' | 'sending' | 'error';
  lastError: { code: string; message: string } | null;
  lastEdaEvidence: { status: 'available' | 'unavailable' | 'selection_required'; reason: string; windowCount?: number } | null;
}

export interface DiagnosticItem {
  id: string;
  name: string;
  detail: string;
  status: 'idle' | 'checking' | 'pass' | 'warn' | 'fail';
}

export interface CommandLog {
  id: string;
  time: string;
  command: string;
  permission: 'read' | 'write';
  duration: number;
  result: string;
  status: 'success' | 'blocked' | 'error';
}

export interface EdaState {
  connected: boolean;
  bridgeStatus: 'stopped' | 'running' | 'error';
  port: number;
  windowCount: number;
  activeWindowId: string | null;
  windows: EdaWindow[];
  projectInfo: unknown | null;
  documentInfo: unknown | null;
  writePaused: boolean;
  diagnostics: DiagnosticItem[];
  commandLogs: CommandLog[];
  /** C4：最近一次真实读回的 EDA 目标指纹（窗口+项目+文档+内容），用于前端提前发现旧批准失效。 */
  targetFingerprint: string | null;
  lastContextAt?: string | null;
}

export interface EdaWindow {
  windowId: string;
  title?: string;
  projectName?: string;
  documentName?: string;
}

export interface EdaDesignContext {
  apiVersion: 1;
  windowId: string;
  capturedAt: string;
  targetFingerprint: string;
  sourceDigest: string | null;
  project: unknown;
  document: unknown;
  catalog: unknown;
  components: unknown;
  wires: unknown;
}

export interface SimpleBoardPlanResult {
  plan: Record<string, unknown>;
  missing: string[];
  ready: boolean;
  planHash: string;
}

export interface DesignApproval {
  token: string;
  planHash: string;
  targetFingerprint: string;
  windowId: string;
  steps: string[];
  expiresAt: number;
  used: boolean;
}

export type DesignExecutionState = 'snapshotting' | 'executing' | 'reading' | 'verifying' | 'completed' | 'failed' | 'rollback_required' | 'rolled_back' | 'rollback_failed';
export interface DesignExecution {
  id: string;
  state: DesignExecutionState;
  planHash: string;
  targetFingerprint: string;
  events: Array<{ at: string; stage: string; status: string; detail: Record<string, unknown> }>;
  snapshot: { id: string; digest: string; size: number } | null;
  drc: { passed: boolean; findings: unknown[] } | null;
  error?: { code: string; message: string };
}

export interface PcbCapability {
  id: string;
  status: 'supported' | 'experimental' | 'user-assisted' | 'unavailable';
  api: string | null;
  production: boolean;
  reason?: string;
}

export interface PcbCapabilities {
  apiVersion: 1;
  edaVersion: string;
  items: PcbCapability[];
}

/**
 * 同步验收结果。真机边界（第 20–23 轮）：PCB 新增器件的公开 API 不存在，
 * 落板必须由 EDA 原生能力完成；CircuitPilot 负责判定差异并验收，绝不放行未清零的差异。
 */
export interface PcbSyncVerification {
  schematicCount: number;
  pcbCount: number;
  matched: string[];
  missing: string[];
  extra: string[];
  unannotated: string[];
  ready: boolean;
  guide: string;
}

export interface PcbContext {
  apiVersion: 1;
  windowId: string;
  capturedAt: string;
  targetFingerprint: string;
  sourceDigest: string | null;
  project: unknown;
  complete: boolean;
  pcb: { document?: unknown; components?: unknown[]; lines?: unknown[]; vias?: unknown[]; pours?: unknown[]; readErrors?: Array<{ name: string; error: string }> };
  rules: unknown;
}

export interface PcbExecution extends Omit<DesignExecution, 'readback'> {
  readback: { sourceDigest: string; targetFingerprint: string; componentCount: number | null; lineCount: number | null; viaCount: number | null; pourCount: number | null } | null;
}

export interface ProductionFinding { code: string; message: string; path: string; severity: 'blocking' | 'warning' }
export interface SemanticPlanResult {
  plan: Record<string, unknown>;
  issues: ProductionFinding[];
  blocking: ProductionFinding[];
  ready: boolean;
  planHash: string;
  compiled?: Record<string, unknown> | null;
  compiledPlanHash?: string;
  quality?: { passed: boolean; findings: ProductionFinding[]; metrics: Record<string, number>; humanReviewRequired: boolean };
}
export interface ProductionInspection {
  manifest: {
    manifestHash: string;
    projectId: string;
    projectName?: string;
    documentId: string;
    sourceDigest?: string;
    semanticPlanHash?: string;
    compiledPlanHash?: string;
    executionId?: string;
    files: Array<{ name: string; size: number; sha256: string; kind: string }>;
    checks: Array<{ id: string; passed: boolean; message: string; manualReview?: boolean }>;
    contentValidation: { passed: boolean; findings: ProductionFinding[]; bomRefCount: number; cplRefCount: number };
    dfm: { status: string; portalUrl: string; uploadFiles: string[]; reason: string };
    procurement: { status: string; reason: string };
  };
  readyForHumanReview: boolean;
  productionReleased: boolean;
  blockers: string[];
}
/** Runtime 日志事件（C3 事件时间线；只存在于本次进程内存，重启清空——这是日志不是账本）。 */
export interface RuntimeEvent {
  timestamp: string;
  level: string;
  module: string;
  message: string;
  data?: unknown;
}

/** 统一批准账本（计划/写板/放行共用哈希链）：只含审计事实，不含令牌原文。 */
export interface ApprovalLedgerEntry {
  index: number;
  at: string;
  scope: 'plan' | 'write' | 'release';
  action: string;
  approvalId: string | null;
  bindings: Record<string, unknown>;
  note: string;
  prevHash: string;
  entryHash: string;
}

export interface ApprovalLedgerSnapshot {
  entries: ApprovalLedgerEntry[];
  summary: { total: number; byScope: Record<string, number>; byAction: Record<string, number> };
  chain: { ok: boolean; brokenAt: number | null; reason: string };
  loadError: string | null;
}

/** 在线价格/库存证据（查询时刻快照；unknown 表示没证据，不是 0 元）。 */
export interface SupplyPricingEvidence {
  kind: string;
  schemaVersion?: number;
  source?: string;
  sourceLabel?: string;
  checkedAt?: string | null;
  freshnessKnown: boolean;
  entries: Array<{ lcsc: string; status: string; price: number | null; currency: string | null; stock: number | null; checkedAt?: string | null; priceBreaks?: unknown[]; url?: string }>;
  unknownEntries: Array<{ lcsc: string | null; status: string; reason?: string; detail?: string | null }>;
  summary: { requested: number; priced: number; unknown: number };
}

/** 执行历史摘要（原理图/PCB 共用）：来自落盘状态，重启后仍在。 */
export interface ExecutionHistoryItem {
  kind: 'schematic' | 'pcb';
  id: string;
  state: string;
  planHash: string;
  createdAt: string | null;
  eventCount: number;
  error?: { code: string; message: string } | null;
  drc?: { passed: boolean; findings: number | null } | null;
  createdPrimitiveIds?: number;
  progress?: { completed: number; total: number } | null;
}

export interface ExecutionHistoryList {
  ok: boolean;
  executions: ExecutionHistoryItem[];
  persistenceError: { code: string; message: string } | null;
}

export interface ProductionReadiness {
  ready: boolean;
  orderEnabled: false;
  reason: string;
  gates: Array<{ id: string; passed: boolean; source: string; reason?: string }>;
  /** 服务端据此重算门禁的实际引用；门禁结论不接受客户端提交。 */
  referenced?: { semanticPlanHash: string; compiledPlanHash: string | null; pcbExecutionId: string | null; manifestHash: string; reviewHash: string | null };
}

/** 人工终审请求：只提交引用，由 Runtime 绑定并登记，避免被伪造或跨物料复用。 */
export interface ProductionFinalReviewRequest {
  semanticPlanHash: string;
  compiledPlanHash: string;
  pcbExecutionId: string;
  manifestHash: string;
  reviewer?: string;
}

export interface EngineeringFinding { code: string; message: string; path: string; severity: 'blocking' | 'warning' }
export interface EngineeringAnalysis {
  schemaVersion: number;
  kind: 'advanced-pcb-engineering-report';
  passed: boolean;
  reportHash: string;
  findings: EngineeringFinding[];
  operations: Array<{ type: 'pcb.component.modify' | 'pcb.line.create' | 'pcb.outline.create' | 'pcb.via.create' | 'pcb.pour.create' | 'pcb.importChanges' | 'pcb.save' | 'pcb.drc'; stage: string; args: Record<string, unknown> }>;
  highSpeed: Array<{ passed: boolean; findings: EngineeringFinding[]; metrics: Record<string, unknown>; provenance: Record<string, unknown> }>;
  hdi: { viaCapabilities: { ready: boolean; findings: EngineeringFinding[] }; transitions: Array<{ passed: boolean; findings: EngineeringFinding[]; transitions: unknown[] }>; bga: Array<{ passed: boolean; findings: EngineeringFinding[] }> };
  rf: Array<{ passed: boolean; findings: EngineeringFinding[]; metrics: Record<string, unknown>; provenance: Record<string, unknown> }>;
  layout: { passed: boolean; findings: EngineeringFinding[]; placements: unknown[]; deterministic: boolean };
  silkscreen: { passed: boolean; findings: EngineeringFinding[]; labels: unknown[] };
  simulationJobs: Array<{ jobHash: string; executable: false; reason: string }>;
  /** 传入 input.layoutRules 时才有的 PCBA 布局规则审计段 */
  layoutRules?: LayoutRuleAudit | null;
  releaseReady?: boolean;
  humanReviewRequired: true;
  officialDrcRequired: true;
  onlineDfmRequired: true;
}


/** PCBA 布局规则引擎（runtime/engineering/layout-rules.mjs）的输出类型 */
export type LayoutRuleStatus = 'PASS' | 'FAIL' | 'REVIEW' | 'NA';
export type LayoutRuleLevel = '硬门禁' | '推荐';
export interface LayoutRuleResult {
  id: string;
  group: string;
  groupName: string;
  level: LayoutRuleLevel;
  name: string;
  value: string;
  basis: string;
  status: LayoutRuleStatus;
  message: string;
  evidence: Record<string, unknown> | null;
  /** REVIEW 规则由哪些已通过门禁的外部证据覆盖（不代表引擎已验证） */
  coveredBy: string[];
}
export interface LayoutRuleGate { id: string; status: LayoutRuleStatus; message: string; evidence: Record<string, unknown> | null }
export interface LayoutRuleAuditSummary {
  total: number;
  PASS: number;
  FAIL: number;
  REVIEW: number;
  NA: number;
  blockingFailures: number;
  warningFailures: number;
  byGroup: Record<string, { PASS: number; FAIL: number; REVIEW: number; NA: number; total: number }>;
}
export interface LayoutRuleAudit {
  kind: 'pcba-layout-rule-audit';
  schemaVersion: number;
  packVersion: string;
  packHash: string;
  board: { widthMm: number | null; heightMm: number | null; thicknessMm: number | null };
  rules: LayoutRuleResult[];
  gates: LayoutRuleGate[];
  gatesSummary: Record<string, LayoutRuleStatus>;
  redLines: Array<{ key: string; hit: boolean | null }>;
  summary: LayoutRuleAuditSummary;
  findings: EngineeringFinding[];
  passed: boolean;
  releaseReady: boolean;
  uncoveredReviews: number;
  humanReviewRequired: true;
  officialDrcRequired: true;
  policy: string;
  auditHash: string;
}
export interface LayoutRulePackSummary {
  version: string;
  total: number;
  counts: Record<string, number>;
  levels: Record<string, number>;
  hash: string;
  groups: Array<{ id: string; name: string; count: number }>;
  documents: Record<string, string>;
  policy: { reviewIsNotPass: boolean; officialDrcRequired: boolean; valueSource: string };
}

export type RuntimeMode = 'demo' | 'real_read_only' | 'controlled_write';
export type AccountProviderId = 'codex_account' | 'claude_account';
export type ApiProviderId =
  | 'openai_api'
  | 'anthropic_api'
  | 'deepseek_api'
  | 'moonshot_api'
  | 'zhipu_api'
  | 'dashscope_api'
  | 'siliconflow_api'
  | 'openrouter_api'
  | 'gemini_api'
  | 'xai_api'
  | 'groq_api'
  | 'mistral_api'
  | 'ark_api'
  | 'qianfan_api'
  | 'custom_api';

/**
 * Provider ID 保留内置字面量补全，同时允许 Runtime 上报的注册表 id（自定义模型 API）。
 * 自定义 Provider 由 runtime/customProviders.mjs 校验，前端不重复做白名单，只在表单里镜像校验规则。
 */
export type ProviderId = 'demo' | AccountProviderId | ApiProviderId | (string & {});

/** 自定义模型 API 的协议适配方式：OpenAI Chat Completions / Anthropic Messages。 */
export type CustomProviderProtocol = 'openai' | 'anthropic';

/** 模型目录中的一条模型（与 runtime/customProviders.mjs#validateCustomProvider 的归一化结果一致）。 */
export interface CustomModelConfig {
  id: string;
  label?: string;
  contextWindow: number;
  maxOutputTokens: number;
  input: Array<'text' | 'image'>;
  reasoning: boolean;
}

/** 自定义 Provider 配置；不含任何密钥字段（Key 只落 macOS 钥匙串）。 */
export interface CustomProviderConfig {
  id: string;
  label: string;
  protocol: CustomProviderProtocol;
  baseUrl: string;
  models: CustomModelConfig[];
  createdAt?: string;
  updatedAt?: string;
  configured?: boolean;
  ready?: boolean;
}

export interface ProviderSummary {
  id: Exclude<ProviderId, 'demo'>;
  label: string;
  kind: 'cli' | 'api';
  installed?: boolean;
  authenticated?: boolean;
  configured?: boolean;
  /** 自定义 API：URL 由用户在设置里填写，没有固定平台地址。 */
  custom?: boolean;
  /**
   * 注册表里的自定义 Provider（可在「自定义模型 API」页签编辑）。
   * 内置 custom_api 只有 custom 而没有 editable，前端据此区分“快捷自定义槽”与“注册表 Provider”。
   */
  editable?: boolean;
  /** editable Provider 的协议、地址与模型目录摘要（由 Runtime 上报，无密钥字段）。 */
  protocol?: CustomProviderProtocol;
  baseUrl?: string;
  models?: CustomModelConfig[];
  ready: boolean;
  version?: string;
  status?: string;
  personalOnly?: boolean;
  /** 平台控制台（Key 申请）地址，只有 API 型 Provider 由 Runtime 声明。 */
  keyUrl?: string;
}

export interface RuntimeDiagnostic {
  id: string;
  name: string;
  available: boolean;
  detail: string;
}

export interface RuntimeState {
  reachable: boolean;
  serviceVersion: string | null;
  mode: RuntimeMode;
  checkedAt: string | null;
  providers: ProviderSummary[];
  diagnostics: RuntimeDiagnostic[];
  lastError: { code: string; message: string } | null;
}

export interface Finding {
  id: string;
  title: string;
  object: string;
  rule: string;
  severity: 'warning' | 'error';
  suggestion: string;
  status: 'open' | 'waived';
  waiverReason?: string;
}

export interface ValidationCheck {
  id: string;
  name: string;
  description: string;
  status: 'pass' | 'warn' | 'fail' | 'running' | 'idle';
  count: number;
  findings: Finding[];
  /** 数据来源：demo=模拟适配器；runtime=本机运行时真实计算；official=EDA 原生报告；manual=人工登记。 */
  source?: 'demo' | 'runtime' | 'official' | 'manual';
}

export interface VersionItem {
  id: string;
  label: string;
  kind: 'snapshot' | 'milestone' | 'rollback';
  date: string;
  summary: string;
  validationStatus: 'pass' | 'warn' | 'fail';
  requirements: number;
  components: number;
  designObjects: number;
}

export interface AuditEvent {
  id: string;
  time: string;
  type: 'project' | 'requirement' | 'ai' | 'eda' | 'validation' | 'version' | 'settings';
  title: string;
  detail: string;
  status: 'success' | 'warning' | 'error' | 'info';
  taskId?: string;
}

export interface ChangeLogEntry {
  id: string;
  time: string;
  source: 'user' | 'ai' | 'runtime' | 'eda' | 'system';
  actor: string;
  action: string;
  objectType: string;
  objectId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  relations?: Record<string, string>;
}

export type IssueStatus = 'open' | 'investigating' | 'resolved' | 'ignored';
export interface IssueHandlingEvent {
  id: string;
  time: string;
  action: IssueStatus | 'reopened';
  note: string;
  actor: string;
}

export interface ChatTranscriptEntry { role: 'user' | 'assistant'; content: string; at: string; }
export interface ChatTranscript {
  sessionId: string;
  messages: ChatTranscriptEntry[];
  updatedAt: string | null;
  persisted: boolean;
}
export interface FailureDiagnosis {
  source: IssueRecord['source'];
  severity: IssueRecord['severity'];
  code: string;
  summary: string;
  detail: string;
  fingerprint: string;
  context: Record<string, string>;
  suggestedAction: string;
  repair: { page: PageId; label: string } | null;
  known: boolean;
}
export interface IssueRecord {
  id: string;
  fingerprint: string;
  source: 'ai' | 'eda' | 'validation' | 'runtime' | 'persistence' | 'provider';
  severity: 'info' | 'warning' | 'error' | 'critical';
  status: IssueStatus;
  code: string;
  summary: string;
  detail: string;
  firstOccurredAt: string;
  lastOccurredAt: string;
  occurrences: number;
  context?: Record<string, string>;
  suggestedAction?: string;
  handling: IssueHandlingEvent[];
}

export interface SettingsState {
  provider: ProviderId;
  /** 第三方供应商平台的自定义 OpenAI 兼容 Base URL（可选，空 = 用平台默认）。 */
  baseUrl: string;
  /**
   * S1 联网检索（可选字段：旧版本状态没有这两个字段，一律按“关闭/自动”处理，避免迁移成本）。
   * 开启后 AI 才能查询公网 datasheet/器件资料；每次请求仍由客户端显式带 allowResearch 放行。
   */
  researchEnabled?: boolean;
  researchProvider?: 'auto' | 'duckduckgo' | 'bing';
  onboardingComplete: boolean;
  model: string;
  budget: number;
  readOnlyDefault: boolean;
  autoSnapshot: boolean;
  autoSave: boolean;
  confirmExport: boolean;
  writePaused: boolean;
  providerReady: boolean;
}

/** C1：跨设备恢复的最小业务状态（Runtime `/api/project-state` 的权威副本形状）。 */
export interface BusinessState {
  projects: Project[];
  activeProjectId: string;
  requirements: Requirement[];
  components: ComponentItem[];
  assets: FileAsset[];
}

export interface AppState {
  schemaVersion: 4;
  currentPage: PageId;
  activeProjectId: string;
  projects: Project[];
  requirements: Requirement[];
  assets: FileAsset[];
  components: ComponentItem[];
  task: AiTask;
  projectChats: Record<string, ChatState>;
  eda: EdaState;
  validations: ValidationCheck[];
  versions: VersionItem[];
  audit: AuditEvent[];
  changes: ChangeLogEntry[];
  issues: IssueRecord[];
  settings: SettingsState;
  runtime: RuntimeState;
}

export type AppAction =
  | { type: 'NAVIGATE'; page: PageId }
  | { type: 'ADD_PROJECT'; project: Project }
  | { type: 'UPDATE_PROJECT'; project: Project }
  | { type: 'SET_ACTIVE_PROJECT'; id: string }
  | { type: 'ARCHIVE_PROJECT'; id: string; archived: boolean }
  | { type: 'DELETE_PROJECT'; id: string }
  | { type: 'ADD_REQUIREMENT'; requirement: Requirement }
  | { type: 'UPDATE_REQUIREMENT'; requirement: Requirement }
  | { type: 'ADD_ASSETS'; assets: FileAsset[] }
  | { type: 'UPDATE_ASSET'; asset: FileAsset }
  | { type: 'REMOVE_ASSET'; id: string }
  | { type: 'UPDATE_COMPONENT'; component: ComponentItem }
  | { type: 'APPLY_BOM_DRAFT'; messageId: string; components: ComponentItem[]; appliedAt: string }
  | { type: 'SET_TASK'; task: AiTask }
  | { type: 'PATCH_TASK'; patch: Partial<AiTask> }
  | { type: 'SET_TASK_STEP'; step: TaskStep }
  | { type: 'ADD_CHAT_MESSAGE'; message: ChatMessage }
  | { type: 'UPDATE_CHAT_MESSAGE'; id: string; patch: Partial<ChatMessage> }
  | { type: 'PATCH_CHAT'; patch: Partial<ChatState> }
  | { type: 'DECIDE_CHAT_SUGGESTION'; messageId: string; suggestionId: string; status: RequirementSuggestionStatus }
  | { type: 'RESET_CHAT'; sessionId: string }
  | { type: 'SET_EDA'; eda: EdaState }
  | { type: 'PATCH_EDA'; patch: Partial<EdaState> }
  | { type: 'CHECK_ENV_DRIFT'; edaFingerprint?: string | null; runtimeVersion?: string | null }
  | { type: 'ADD_COMMAND_LOG'; log: CommandLog }
  | { type: 'SET_VALIDATIONS'; validations: ValidationCheck[] }
  | { type: 'UPDATE_VALIDATION'; validation: ValidationCheck }
  | { type: 'ADD_VERSION'; version: VersionItem }
  | { type: 'ADD_AUDIT'; event: AuditEvent }
  | { type: 'ADD_CHANGE'; entry: ChangeLogEntry }
  | { type: 'REPORT_ISSUE'; issue: IssueRecord }
  | { type: 'UPDATE_ISSUE'; id: string; status: IssueStatus; note: string }
  | { type: 'SET_SETTINGS'; settings: SettingsState }
  | { type: 'PATCH_RUNTIME'; patch: Partial<RuntimeState> }
  | { type: 'BOOTSTRAP_RUNTIME'; patch: Partial<RuntimeState>; preferredProvider?: ProviderSummary }
  | { type: 'HYDRATE_BUSINESS_STATE'; state: BusinessState }
  /** C1：从 Runtime 恢复版本/修改/审计的权威副本（换机器/清缓存后仍可追溯）。 */
  | { type: 'HYDRATE_TRACE_STATE'; versions: VersionItem[]; changes: ChangeLogEntry[]; audit: AuditEvent[] }
  | { type: 'HYDRATE_ISSUES'; issues: IssueRecord[] }
  | { type: 'RESET_DEMO'; state: AppState };

export interface ToastMessage {
  id: string;
  title: string;
  message: string;
  tone: Tone;
}


/* ---------------------------------------------------------------- 布局微调与下单前闸门 */

/** 布局相关的发现项：sev 为 blocking 时必须修，unknown 表示"没读到"（同样不许放行）。 */
export interface PlacementFinding {
  code: string;
  severity: 'blocking' | 'warning' | 'info' | 'unknown';
  message: string;
  field?: string | null;
}

export interface PlacementPoint { x: number; y: number }

export interface PlacementOutline {
  points: PlacementPoint[];
  source: Array<number | string>;
  closed: boolean;
}

export interface PlacementCoordinate { xMm: number; yMm: number; rotationDeg: number }

export interface PlacementItem {
  ref: string;
  primitiveId: string | null;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  side: 'top' | 'bottom';
  widthMm?: number | null;
  heightMm?: number | null;
  current?: PlacementCoordinate | null;
  partnerCount?: number;
}

export interface PlacementVerification {
  ok: boolean;
  blockingCount: number;
  checkedCount: number;
  findings: PlacementFinding[];
}

export interface PlacementDiffRow {
  ref: string;
  status: 'moved' | 'new' | 'unchanged';
  from: PlacementCoordinate | null;
  to: PlacementCoordinate | null;
  deltaXMm?: number;
  deltaYMm?: number;
  deltaRotationDeg?: number;
  distanceMm?: number;
}

export interface LayoutSupplementRule {
  id: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'REVIEW' | 'NA';
  message: string;
  evidence?: unknown;
}

export interface LayoutSupplementAudit {
  kind: 'pcba-layout-supplement-audit';
  rules: LayoutSupplementRule[];
  summary: { total: number; PASS: number; FAIL: number; REVIEW: number; NA: number; blockingFailures: number };
  passed: boolean;
  releaseReady: boolean;
}

/** A9：布局规则审计（128 条规则里与布局几何相关部分）的真实结论。 */
export interface LayoutAuditSummary {
  ok: boolean;
  evidenceGapFailures: number;
  auditHash: string;
  summary: { total: number; PASS: number; FAIL: number; REVIEW: number; NA: number; blockingFailures: number; warningFailures: number };
  blockingFailures: number;
  warningFailures: number;
  review: number;
  passed: number;
  releaseReady: boolean;
  blocking: Array<{ ruleId: string | null; title: string | null; message: string | null; evidence?: unknown }>;
  evidenceGaps: Array<{ ruleId: string | null; title: string | null; message: string | null }>;
  gates: Record<string, unknown>;
  /** P2：独立补充规则族（热/PDN/高速/爬电/外壳/EMC），不改变 128 条规则包。 */
  supplements?: LayoutSupplementAudit;
  supplementFailures?: number;
  inputSummary: { board: { widthMm: number | null; heightMm: number | null; outlineClosed: boolean }; components: number; silkTexts?: number | null; decouplingPairs?: number | null };
}

export interface PlacementPlanResult {
  ok: boolean;
  source?: string;
  openedPcb?: { opened: boolean; tabId?: string } | null;
  outline: PlacementOutline;
  componentCount: number;
  unknownSize: string[];
  affinity: { netCount: number; topPairs: Array<[string, number]> };
  plan: {
    ok: boolean;
    placements: PlacementItem[];
    unplaced: Array<{ ref?: string; reason?: string }>;
    findings: PlacementFinding[];
    stats: { placedCount: number; unplacedCount: number; gridMm: number; edgeClearanceMm: number; spacingMm: number; utilization: number; usableBounds?: Record<string, number> };
  };
  verification: PlacementVerification;
  currentVerification: PlacementVerification;
  diff: { rows: PlacementDiffRow[]; movedCount: number; newCount: number; unchangedCount: number };
  /** A9：布局规则审计结论（证据不足的项单独计数，不冒充违规）。 */
  layoutAudit?: LayoutAuditSummary;
  /** autoDrc=true 时的自动 DRC 采集结果；失败不阻断布局，只让 GATE-02 保持 REVIEW。 */
  drcAuto?: { requested: boolean; used: boolean; error: string | null };
}

export interface PlacementWritebackUpdate {
  ref: string;
  primitiveId: string;
  fromMm: PlacementCoordinate;
  toMm: PlacementCoordinate;
  deltaMm: number;
  deltaRotationDeg: number;
}

export interface PlacementWritebackResult {
  ok: boolean;
  applied: boolean;
  /** 运行时不代用户保存：改动只在 EDA 内存里，必须由人在 EDA 中确认并保存。 */
  saved: boolean;
  dryRun: boolean;
  updates: PlacementWritebackUpdate[];
  skipped: Array<{ ref: string; reason: string }>;
  missing: Array<{ ref: string; reason: string }>;
  steps: Array<{ step: string; ok?: boolean; [key: string]: unknown }>;
  findings: PlacementFinding[];
  verified: PlacementVerification | null;
  rollback: { attempted?: boolean; ok?: boolean; manualCoordinates?: Array<{ ref: string; xMil: number; yMil: number; rotationDeg: number }> } | null;
  summary?: unknown;
  /** A9：写回前实际跑过的规则审计（被硬门禁拒绝时异常 details 里也有）。 */
  layoutAudit?: LayoutAuditSummary;
  drcAuto?: { requested: boolean; used: boolean; error: string | null };
}

export type ReleaseGateStatus = 'pass' | 'warn' | 'blocked' | 'unknown';

export interface ReleaseGateFinding { code: string; message: string; field?: string | null }

export interface ReleaseGateSection {
  id: string;
  title: string;
  status: ReleaseGateStatus;
  blockingCount: number;
  evidence: Record<string, unknown> | null;
  findings: PlacementFinding[];
}

/** 产出裁决：门禁没通过就只能出草稿；正式命名一律拒绝（规则实现在 runtime/production-release.mjs）。 */
export interface ProductionOutputDecision {
  kind: 'production-output-decision';
  requested: 'draft' | 'final';
  allowed: boolean;
  outputClass: 'draft' | 'final' | null;
  code?: string;
  message?: string;
  blockers: string[];
  fix?: string[];
  staleArtifacts?: string[];
  exampleNames?: string[];
  draftNaming?: string;
  naming?: { suffix: string };
  warning?: string;
  ticket?: string | null;
  humanSignoffRequired: boolean;
  gate: { verdict: string | null; ready: boolean; fingerprint: string | null; blockerCodes: string[] };
}

/** B8：不可变发布版本（归档记录，创建后无更新/删除接口）。 */
export interface ReleaseArchiveEvidenceFile {
  role: string;
  path: string;
  bytes: number | null;
  sha256: string | null;
  error?: string;
}

export interface ReleaseArchiveSummary {
  releaseId: string;
  createdAt: string;
  binding: { planHash: string | null; manifestHash: string | null; reviewHash: string | null; pcbUuid: string | null };
  verdict: string | null;
  files: number;
  verification: { verified: boolean; problems: string[] };
}

export interface ReleaseArchiveRecord {
  schemaVersion: number;
  kind: string;
  releaseId: string;
  createdAt: string;
  immutable: boolean;
  binding: {
    planHash: string | null;
    compiledPlanHash: string | null;
    pcbUuid: string | null;
    pcbExecutionId: string | null;
    reviewHash: string | null;
    manifestHash: string | null;
    gateFingerprint: string | null;
    decisionFingerprint: string | null;
  };
  gate: { ready: boolean; verdict: string | null; blockers: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }>; gates: Array<{ id: string; status: string; blockingCount: number }> };
  releaseDecision: { ready: boolean; verdict: string; blockedBy: string[]; gates: Array<{ id: string; scope: string; status: string; passed: boolean }>; evidence: Record<string, unknown> | null };
  evidence: { artifactsDir: string | null; files: ReleaseArchiveEvidenceFile[] };
  notes: string | null;
  archiveHash: string;
  filePath: string;
  verification: { verified: boolean; problems: string[] };
}

export interface ReleaseGateReport {
  kind: 'fabrication-release-gate';
  schemaVersion: number;
  generatedAt: string;
  ready: boolean;
  verdict: 'blocked' | 'ready-with-warnings' | 'ready-to-order';
  blockers: ReleaseGateFinding[];
  warnings: ReleaseGateFinding[];
  gates: ReleaseGateSection[];
  fingerprint: { sha256: string; parts: unknown };
  /** 下单这件事永远需要人签字：机器只负责把证据摆全。 */
  humanSignoffRequired: boolean;
  /** 能不能出正式生产文件的裁决（运行时装在报告里，界面直接显示，不自己再推导一遍）。 */
  outputDecision?: ProductionOutputDecision;
  /** 统一裁决：本地门禁 + DFM/终审人工证据；界面只显示这一条结论。 */
  releaseDecision?: ReleaseDecision;
}

/** DRC 报告（落盘证据里的核心负载；字段与 runtime/drc.mjs 的归一化输出对齐）。 */
export interface DrcReportItem {
  errorType?: string | null;
  signature?: string | null;
  instanceKey?: string | null;
  objects?: Array<{ type?: string }>;
  [key: string]: unknown;
}
export interface DrcReport {
  ok?: boolean;
  items: DrcReportItem[];
  reportedCount?: number | null;
  itemCount?: number | null;
  truncated?: boolean;
  byErrorType?: Record<string, number>;
  byRule?: Record<string, number>;
  byLayer?: Record<string, number>;
  countsConsistent?: boolean | null;
  [key: string]: unknown;
}
export interface DrcEvidenceEntry {
  schemaVersion: number;
  kind: 'drc-report';
  savedAt: string;
  digest: string;
  path: string;
  fingerprint: Record<string, string | null>;
  note?: string | null;
  payload: {
    report: DrcReport;
    classification?: Record<string, unknown> | null;
    jobId?: string | null;
    pcbUuid?: string | null;
  };
}
export interface ErcCounts { fatal: number; error: number; warning: number; info: number; total: number; }
/** 第 60 轮：ERC 明细来源——`ui-dom` = 从 EDA 检查面板抓到逐条；`aggregate` = 只有聚合计数。 */
export type ErcDetailSource = 'ui-dom' | 'aggregate';
/** ERC 逐条明细抓取的元数据。`ok=false` 时 `reason` 是运行时如实给出的失败原因（不伪造明细）。 */
export interface ErcDetailMeta {
  ok: boolean;
  source?: ErcDetailSource | string | null;
  reason?: string | null;
  counts?: Record<string, unknown> | null;
  targetBefore?: Record<string, string | null> | null;
  targetAfter?: Record<string, string | null> | null;
}
export interface ErcFinding {
  id: string;
  severity: 'fatal' | 'error' | 'warning' | 'info';
  code: string;
  title: string;
  object: string;
  detail: string;
  suggestion: string;
  /** A13：逐条结构化修复建议（不自动改图；autoFixable 恒为 false，电气意图需人确认）。 */
  repair?: {
    kind: 'pwr-flag' | 'no-connect' | 'no-connect-review' | 'net-flag' | 'manual';
    label: string;
    risk: 'low' | 'medium' | 'high';
    autoFixable: boolean;
    requiresHumanConfirm: boolean;
    steps: string[];
    verify: string;
    suggestedCommand?: { command: string; needs: string[]; note: string };
    blockedReason?: string;
  };
  aggregate: boolean;
  count: number;
  exempted?: boolean;
  exemptionReason?: string;
}
export interface ErcReport {
  schemaVersion: number;
  ran: boolean;
  aggregateOnly: boolean;
  detailAvailable: boolean;
  counts: ErcCounts;
  openCounts?: ErcCounts;
  findings: ErcFinding[];
  groups: Array<{ type: string; count: number; detailAvailable: boolean }>;
  digest: string;
  exemptions?: Array<{ code: string; object: string | null; reason: string }>;
  invalidExemptions?: Array<{ index: number; code: string | null; problems: string[] }>;
  repairSummary?: { kinds: Record<string, number>; autoFixable: number; requiresHuman: number; total: number };
  /** 第 60 轮：本次 ERC 实际检查的原理图 documentUuid（多板工程必须能回答“查的是哪一页”）。 */
  documentUuid?: string | null;
  /** 第 60 轮：逐条明细来源；缺省表示运行时没有标注（旧版证据），不等于有逐条明细。 */
  detailSource?: ErcDetailSource | string | null;
  /** `ui-dom` 明细抓取计数与未覆盖级别（部分明细），仅作如实展示。 */
  detailCounts?: {
    fatal?: number;
    error?: number;
    warning?: number;
    info?: number;
    total?: number;
    partial?: Record<string, { detailed: number; expected: number }>;
  } | null;
}
export interface ErcEvidenceEntry {
  schemaVersion: number;
  kind: 'schematic-erc';
  savedAt: string;
  digest: string;
  path: string;
  fingerprint: Record<string, string | null>;
  note?: string | null;
  payload: {
    report: ErcReport;
    exemptionFile?: { path?: string; exists?: boolean; invalid?: unknown[] };
    /** 第 60 轮：明细抓取结果（成功含 source/counts；失败含 reason），用于诚实展示“为什么没有逐条”。 */
    ercDetail?: ErcDetailMeta | null;
  };
}
export interface ErcConvergenceSummary {
  ran: boolean;
  aggregateOnly: boolean;
  detailAvailable: boolean;
  counts: ErcCounts;
  errorsOpen: number;
  warningsOpen: number;
  exempted: number;
  invalidExemptions: number;
  digest: string;
}
export interface DfmEvidenceEntry {
  schemaVersion: number;
  kind: 'dfm-evidence';
  savedAt: string;
  digest: string;
  path: string;
  fingerprint: Record<string, string | null>;
  payload: {
    passed: boolean;
    operator: string;
    source: string;
    conclusion: string;
    url: string | null;
    artifacts: Array<Record<string, unknown>>;
    uploadedAt: string;
  };
}
export interface SignoffEvidenceEntry {
  schemaVersion: number;
  kind: 'signoff';
  savedAt: string;
  digest: string;
  path: string;
  fingerprint: Record<string, string | null>;
  payload: {
    passed: boolean;
    operator: string;
    planHash: string | null;
    manifestHash: string;
    conclusion: string;
    roles: Array<{ role: string; name: string; conclusion: string; signedAt: string }>;
  };
}

/** 统一放行决策（runtime/release-decision.mjs）：本地门禁 + 人工证据只有一条结论。 */
export interface ReleaseDecisionGate {
  id: string;
  scope: 'local' | 'manual';
  title: string;
  status: string;
  passed: boolean;
  reason: string | null;
  evidence: Record<string, unknown> | null;
}
export interface ReleaseDecision {
  schemaVersion: number;
  kind: 'release-decision';
  generatedAt: string;
  ready: boolean;
  orderEnabled: false;
  humanSignoffRequired: true;
  verdict: 'ready' | 'ready-with-warnings' | 'blocked';
  gates: ReleaseDecisionGate[];
  blockedBy: string[];
  reason: string;
  evidence: { gateFingerprint: unknown; dfm: unknown; signoff: unknown };
  fingerprint: string;
}

/** 生产文件导出结果：`exported` 是布尔（成不成），`files` 是确实落盘的文件。 */
export interface ProductionExportFile { kind: string; name: string; path: string; bytes: number; sha256: string; chunks?: number | null; edaName?: string | null }
export interface ProductionExportVerification {
  id?: string; title?: string; status?: 'pass' | 'fail' | 'unknown';
  blockingCount?: number; note?: string | null;
  findings?: Array<{ code: string; severity: string; message: string }>;
  waived?: Array<{ code: string; message: string; why: string }>;
  evidence?: Record<string, unknown>;
}
export interface ProductionExportResult extends ProductionOutputDecision {
  exported: boolean;
  /** 服务端统一裁决（本地门禁 + 落盘人工证据），导出被拒时给出 blockedBy。 */
  releaseDecision?: ReleaseDecision;
  /** B1/B4：本次导出与人工签核的物料清单绑定核对结果（provided/recomputed/signoff 三值对照）。 */
  manifestBinding?: {
    requested: 'draft' | 'final';
    providedManifestHash: string | null;
    recomputedManifestHash: string | null;
    signoffManifestHash: string | null;
    boundManifestHash: string | null;
    ok: boolean;
    code?: string;
    message?: string;
  };
  ok?: boolean;
  code?: string;
  message?: string;
  files?: ProductionExportFile[];
  wrote?: string[];
  outDir?: string | null;
  manifest?: { outputClass: 'draft' | 'final'; released: boolean; decisionTicket?: string | null; manifestPath?: string; manifestSha256?: string; verification?: ProductionExportVerification | null };
}

/** 板厂下单参数卡：实测事实 + 下单参数 + 一致性结论（规则实现在 runtime/fabrication-order.mjs）。 */
export interface FabricationOrderFinding { code: string; severity: 'blocking' | 'unknown' | 'warning'; message: string; field: string | null }
export interface FabricationOrderCard {
  kind: 'fabrication-order-card';
  generatedAt: string;
  readyToOrder: boolean;
  nextStep: string;
  parameters: { layers: number | null; sizeMm: { x: number; y: number } | null; thicknessMm: number; copperWeightOz: number; surfaceFinish: string; impedanceControl: boolean; quantity: number; panelize: boolean; soldermaskColor: string; leadTimeDays: number | null };
  derived: { sizeMm: { x: number; y: number } | null; copperLayerCount: number | null; componentCount: number | null; netCount: number | null; drcMustFixCount: number | null; drcItemCount: number | null; impedanceNets: Array<{ name: string | null; impedanceOhm: number | null }> };
  capability: { provenance: string; note?: string; maxSizeMm?: { x: number; y: number } };
  files: Array<{ kind: string | null; name: string | null; path: string | null; bytes: number | null; draft: boolean }>;
  price: { status: 'known' | 'unknown'; amount?: number; currency?: string; source?: string; reason?: string };
  findings: FabricationOrderFinding[];
  assumptions: Array<{ field: string; value: unknown; why: string }>;
  counts: { blocking: number; unknown: number; warning: number };
  humanSignoffRequired: boolean;
  /** B3：供应链价格/库存摘要（有证据时由运行时汇入；缺证据不出现，不猜总价）。 */
  supplySummary?: {
    known: boolean;
    pricedCount: number;
    unknownCount: number;
    totalKnownAmount: number | null;
    currency: string | null;
    outOfStock: Array<{ lcsc: string; stock: number; price: number | null }>;
    stockUnknown: Array<{ lcsc: string; reason: string }>;
    checkedAt: string | null;
    ageHours: number | null;
    stale: boolean | null;
    staleAfterHours?: number;
    findings: Array<{ code: string; severity: string; message: string }>;
  };
}

/** E3/R10：下单参数卡人工确认证据（系统不代下单、不代付）。 */
export interface OrderConfirmationPayload {
  operator: string;
  note: string | null;
  paymentManual: true;
  acknowledged: { orderExecutedBySystem: false; paymentExecutedBySystem: false; humanExecutor: string };
  card: {
    generatedAt: string | null;
    readyToOrder: true;
    counts: FabricationOrderCard['counts'] | null;
    parameters: FabricationOrderCard['parameters'] | null;
    price: FabricationOrderCard['price'] | null;
    humanSignoffRequired: boolean;
    files: Array<{ kind: string | null; name: string | null; draft: boolean }>;
  };
  source?: string;
  confirmedAt?: string;
}

/** 原理图自动修复：预演（dryRun）或受控写入 + 网表复核 + 立刻重跑验收的结果。 */
export interface SchematicRepairDevice {
  id?: string;
  mpn?: string | null;
  net: string;
  otherNet: string;
  valueOhm?: number;
  position?: { x: number; y: number };
}

export interface SchematicRepairReport {
  dryRun: boolean;
  skipped?: boolean;
  skippedReason?: 'ALREADY_SATISFIED' | 'NOTHING_TO_DO' | string;
  devices?: SchematicRepairDevice[];
  plan?: {
    ok: boolean;
    operations: Array<{ type: string; repairId?: string; expectedNet?: string; pinIndex?: number; args?: Record<string, unknown> }>;
    satisfied?: Array<{ id?: string; designator?: string; value?: string | null; part?: string | null; why?: string }>;
    expectedGain: Record<string, number>;
    findings?: Array<{ severity: string; code: string; message: string }>;
  };
  applied?: {
    createdPins: string[];
    diff: { ok: boolean; gained: Record<string, string[]>; missing: unknown[]; unexpected: unknown[]; identityComplete: boolean };
    events: Array<{ step: string; status: string; [key: string]: unknown }>;
  };
  acceptance?: {
    ready: boolean;
    netlist: { components: number; nets: number; pins: number; namedPins: number; meta?: { sha256?: string | null } | null } | null;
    designChecks?: {
      ok: boolean;
      summary: { total: number; passed: number; failed: number; notRun: number; notApplicable: number; simulated: boolean };
      results: Array<{ id: string; title: string; status: string; spec?: unknown; measured?: unknown; defect?: unknown; recommendation?: string | null }>;
    } | null;
    findings: Array<{ code: string; severity: string; message: string; field?: string | null }>;
  };
}

/** 叠层（铜层）只读信息：层号、名称、类型（SIGNAL=铜层，SILKSCREEN/SOLDERMASK 等非铜层）。 */
export interface PcbLayerInfo {
  id: number;
  name: string;
  type: string;
  color?: string;
  locked?: boolean;
  layerStatus?: string;
  transparency?: number;
}

export interface PcbLayerStack {
  copperCount: number;
  count: number;
  layers: PcbLayerInfo[];
}

/** 叠层写入结果（服务端写后读回校验 + 取证 + 保存状态，绝不凭 setCount 返回值声称成功）。 */
export interface PcbLayerStackChange {
  ok: boolean;
  changed: boolean;
  copperLayers: number;
  before: { copperCount: number; layers: PcbLayerInfo[] };
  after: { copperCount: number; layers: PcbLayerInfo[] };
  verification: { expectedLayerIds: number[]; matched: boolean };
  saved: boolean;
}

/** 覆铜详情（布线收尾/半写回滚时的只读快照）。 */
export interface PcbPourInfo {
  primitiveId: string;
  net: string;
  layer: number;
  pourName: string;
  pourPriority: number;
}

// ---------------------------------------------------------------- W5/W6 门禁与知识库（前端视图类型）

export interface GateReason { code: string; severity: 'error' | 'warning' | 'info' | 'blocking' | 'unknown'; message: string }
export interface PcbGateResult { id: string; name: string; purpose: string; requiredKinds: string[]; verdict: 'pass' | 'blocked' | 'unknown'; evidenceDigests: string[]; missing: string[]; reasons: GateReason[] }
export interface PcbGateReport { verdict: 'pass' | 'blocked' | 'unknown'; targetPcbUuid: string | null; gates: PcbGateResult[]; blockedGates: string[]; unknownGates: string[] }
export interface GateEvidenceRef { kind: string; digest: string; path: string; savedAt: string }
export interface GateSignoffRecord { schemaVersion: number; kind: string; pcbUuid: string; decision: 'approve' | 'reject'; signedBy: string; note: string; gateVerdict: string; reportDigest: string; signedAt: string }
export interface KnowledgeEntryView { id: string; kind: string; title: string; payload: Record<string, unknown>; provenance: Record<string, unknown>; trust: string; review: { state: string; reviewedBy?: string | null; reviewedAt?: string | null }; entityKey?: string | null; createdAt: string; updatedAt: string; expired?: boolean; digest?: string }
export interface KnowledgeHealth { total: number; byKind: Record<string, number>; coverage: number; approved: number; candidates: number; expired: number; expiredRate: number; conflictKeys: number; conflictRate: number; hitRate: number; generatedAt: string }
export interface KnowledgeReviewQueueView { candidates: Array<{ id: string; kind: string; title: string; trust: string; entityKey?: string | null; createdAt: string }>; candidateCount: number; conflicts: Array<{ entityKey: string; conflicts: number; ids: string[] }>; conflictCount: number; expired: Array<{ id: string; title: string; expiredAt?: string | null }>; expiredCount: number; generatedAt: string }
export interface ApprovalLedgerView { entries: Array<{ index: number; at: string; scope: string; action: string; approvalId?: string | null; bindings?: Record<string, unknown>; note?: string }>; summary: { total: number; byScope: Record<string, number>; byAction: Record<string, number> }; chain: { ok: boolean; brokenAt: number | null; reason: string }; loadError?: string | null }

export interface KnowledgeAgentRunSummary {
  reason: string;
  ok: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  badcases: { created: number; duplicates: number; candidates: number } | null;
  web: { created: number; failed: number; collectors: number } | null;
  maintenance: { pendingReview: number; expired: number; conflicts: number; evidencePath?: string | null } | null;
  failed: Array<{ task: string; code?: string | null; failed?: number }>;
}
export interface KnowledgeAgentSchedulerStatus {
  enabled: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  running: boolean;
  lastResult: KnowledgeAgentRunSummary | null;
  history: Array<{ at: string; reason: string; ok: boolean; badcases: number | null; web: number | null; pendingReview: number | null }>;
  corruptState: boolean;
}
export interface KnowledgeAgentManagerStatus {
  totals: { total: number; candidates: number; approved: number; expired: number; coverage: number };
  badcases: { count: number; pendingReview: number };
  webCollectors: number;
  evidenceRoot: string | null;
}
export interface KnowledgeAgentCycle {
  startedAt: string;
  finishedAt: string;
  tasks: string[];
  ok: boolean;
  badcases?: { ok: boolean; created?: number; duplicates?: number; candidates?: number; scanned?: number; code?: string; message?: string } | null;
  web?: { ok: boolean; created?: number; failed?: unknown[]; collectors?: number; code?: string; message?: string } | null;
  maintenance?: { ok: boolean; pendingReview?: number; expired?: { count: number }; conflicts?: { count: number }; evidencePath?: string; code?: string; message?: string } | null;
}

export interface RagStatus {
  built: boolean;
  docs: number;
  chunks: number;
  terms: number;
  dims: number;
  builtAt: string | null;
  corpusDigest: string | null;
  file: string | null;
  loadError: { code: string; message: string } | null;
  corpus: { knowledge: number; docs: number; skipped: number; truncated: boolean } | null;
  lastQueryAt: string | null;
}
export interface RagHit {
  chunkId: string;
  docId: string;
  title: string;
  heading: string;
  kind: string;
  path: string | null;
  knowledgeId: string | null;
  text: string;
  score: number;
  bm25: number;
  cosine: number;
  provenance: Record<string, unknown> | null;
  meta: Record<string, unknown>;
}
export interface RagQueryResult { query: string; results: RagHit[]; total: number; mode: string }
export interface RagRebuildResult { docs: number; chunks: number; terms: number; reason: string; corpus: { knowledge: number; docs: number; skipped: number; truncated: boolean } | null; file: string | null }
