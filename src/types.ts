export type PageId =
  | 'projects'
  | 'requirements'
  | 'assets'
  | 'ai'
  | 'eda'
  | 'validation'
  | 'versions'
  | 'settings';

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

export type ProjectStage = '概念' | '原理图' | 'PCB布局' | '验证' | '归档';

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
    documentId: string;
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
  operations: Array<{ type: 'pcb.component.modify' | 'pcb.line.create' | 'pcb.via.create'; stage: string; args: Record<string, unknown> }>;
  highSpeed: Array<{ passed: boolean; findings: EngineeringFinding[]; metrics: Record<string, unknown>; provenance: Record<string, unknown> }>;
  hdi: { viaCapabilities: { ready: boolean; findings: EngineeringFinding[] }; transitions: Array<{ passed: boolean; findings: EngineeringFinding[]; transitions: unknown[] }>; bga: Array<{ passed: boolean; findings: EngineeringFinding[] }> };
  rf: Array<{ passed: boolean; findings: EngineeringFinding[]; metrics: Record<string, unknown>; provenance: Record<string, unknown> }>;
  layout: { passed: boolean; findings: EngineeringFinding[]; placements: unknown[]; deterministic: boolean };
  silkscreen: { passed: boolean; findings: EngineeringFinding[]; labels: unknown[] };
  simulationJobs: Array<{ jobHash: string; executable: false; reason: string }>;
  humanReviewRequired: true;
  officialDrcRequired: true;
  onlineDfmRequired: true;
}

export type RuntimeMode = 'demo' | 'real_read_only' | 'controlled_write';
export type ProviderId = 'demo' | 'codex_account' | 'openai_api' | 'claude_account' | 'anthropic_api';

export interface ProviderSummary {
  id: Exclude<ProviderId, 'demo'>;
  label: string;
  kind: 'cli' | 'api';
  installed?: boolean;
  authenticated?: boolean;
  configured?: boolean;
  ready: boolean;
  version?: string;
  status?: string;
  personalOnly?: boolean;
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
  | { type: 'RESET_DEMO'; state: AppState };

export interface ToastMessage {
  id: string;
  title: string;
  message: string;
  tone: Tone;
}
