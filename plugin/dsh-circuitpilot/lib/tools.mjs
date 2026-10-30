/**
 * CircuitPilot 工具集（host-independent，不依赖 DSH 包）。
 *
 * 12 个工具按 docs/agent/agent-contract.md §3 收敛：
 *   read     cp_status / cp_project_context / cp_issues / cp_evidence / cp_knowledge / cp_job
 *   plan     cp_design_plan / cp_pcb_plan
 *   approve  cp_approve（仅 approvalMode='chat'，必须 planHash + confirm=true）
 *   execute  cp_execute / cp_validation / cp_export（长任务走 JobManager，写操作必须 requestId）
 *
 * 安全边界（与契约一致）：
 *  - 只调用白名单 Runtime 路由，不绕过 planHash/lineage/写锁/DRC 基线；
 *  - 写操作必须带 requestId；同 requestId 幂等，不重复执行；
 *  - approvalToken 只存在于插件内存，不返回给模型、不写入日志；
 *  - 结果统一 { ok, summary, data, evidence, nextActions, truncated }，超过 maxResultBytes 裁剪。
 */
import { createHash } from 'node:crypto';
import { JobManager } from './jobs.mjs';
import { RuntimeClient, resolveAgentTokenFile, DEFAULT_RUNTIME_URL, DEFAULT_REQUEST_TIMEOUT_MS } from './runtime.mjs';
import { capResult, okResult, failResult, evidenceRef } from './projection.mjs';

export const DEFAULT_MAX_RESULT_BYTES = 16384;

/** CircuitPilot UI 默认地址（仅用于生成审批深链，不参与任何网络请求）。 */
export const DEFAULT_UI_URL = 'http://127.0.0.1:4177';

export const DEFAULT_TOOL_CONFIG = Object.freeze({
  runtimeUrl: DEFAULT_RUNTIME_URL,
  uiUrl: DEFAULT_UI_URL,
  approvalMode: 'chat',
  agentTokenFile: '',
  maxResultBytes: DEFAULT_MAX_RESULT_BYTES,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  jobTimeoutMs: 300_000,
  approvalTtlMs: 600_000,
  planTtlMs: 1_800_000,
  drcPollIntervalMs: 1_000,
  drcPollTimeoutMs: 120_000,
  clock: () => Date.now(),
});

/** 工具名（顺序即 catalog 顺序）。 */
export const TOOL_NAMES = Object.freeze([
  'cp_status',
  'cp_project_context',
  'cp_issues',
  'cp_evidence',
  'cp_knowledge',
  'cp_design_plan',
  'cp_pcb_plan',
  'cp_approve',
  'cp_execute',
  'cp_validation',
  'cp_export',
  'cp_job',
]);

/** 工具 → Runtime 路由映射（README / 验收时对照用）。 */
export const TOOL_ROUTES = Object.freeze({
  cp_status: ['GET /api/health', 'GET /api/project-state', 'GET /api/write-gate', 'GET /api/eda/workspaces/current', 'GET /api/issue-state', 'GET /api/evidence/index'],
  cp_project_context: ['GET /api/project-state', 'GET /api/eda/workspaces/current', 'GET /api/issue-state'],
  cp_issues: ['GET /api/issue-state'],
  cp_evidence: ['GET /api/evidence/index', 'GET /api/evidence/find', 'GET /api/design/executions/:id/evidence', 'GET /api/pcb/executions/:id'],
  cp_knowledge: ['GET /api/knowledge/entries', 'POST /api/rag/query'],
  cp_design_plan: ['POST /api/design/plan', 'POST /api/design/plan/ai'],
  cp_pcb_plan: ['POST /api/pcb/plan'],
  cp_approve: ['GET /api/design/context', 'POST /api/design/approve', 'GET /api/pcb/context', 'POST /api/pcb/approve'],
  cp_execute: ['POST /api/design/execute', 'POST /api/pcb/execute'],
  cp_validation: ['POST /api/eda/schematic/erc/run', 'POST /api/eda/pcb/drc/start', 'POST /api/eda/pcb/drc/report', 'POST /api/eda/gates/evaluate'],
  cp_export: ['POST /api/production/export'],
  cp_job: ['(plugin-local JobManager; no Runtime route)'],
});

const RUNTIME_DOWN_ACTIONS = [
  '启动 CircuitPilot 应用并确认 Runtime 在配置的 runtimeUrl 上运行（默认 http://127.0.0.1:4178）',
  '确认 agent token 文件存在（默认 ~/Library/Application Support/CircuitPilot/agent-token.json，可用 CIRCUITPILOT_AGENT_TOKEN_FILE 覆盖）',
];

const APPROVE_MODE_HINT = [
  '当前 approvalMode 不是 chat：cp_approve 不可用（只读模式）',
  '如需执行写操作，请用户把插件配置 approvalMode 设为 chat 并在对话中明确批准',
];

const SEVERITY_RANK = { critical: 0, error: 1, warning: 2, info: 3 };

/* ------------------------------------------------------------------ */
/* 纯函数：输入校验 / 结果摘要                                         */
/* ------------------------------------------------------------------ */

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function typeMatches(type, value) {
  if (value === undefined) return true;
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function validateInput(schema, value, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object' || value === undefined) return errors;
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${path} 应为 ${schema.type}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} 必须是 ${schema.enum.join(' / ')} 之一`);
  }
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push(`${path} 长度不能小于 ${schema.minLength}`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path} 长度不能大于 ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${path} 不能小于 ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${path} 不能大于 ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.slice(0, 50).forEach((item, index) => {
      errors.push(...validateInput(schema.items, item, `${path}[${index}]`));
    });
  }
  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (value[key] === undefined || value[key] === null || value[key] === '') errors.push(`${path}.${key} 必填`);
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      errors.push(...validateInput(childSchema, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

export function summarizeProjectState(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const activeId = typeof state?.activeProjectId === 'string' ? state.activeProjectId : '';
  const active = projects.find((item) => item?.id === activeId) ?? projects[0] ?? null;
  return {
    id: active?.id ?? null,
    name: typeof active?.name === 'string' ? active.name : (typeof active?.title === 'string' ? active.title : null),
    stage: active?.stage ?? null,
    progress: Number.isFinite(Number(active?.progress)) ? Number(active.progress) : null,
    archived: active?.archived === true,
    projectCount: projects.length,
    edaWorkspace: active?.edaWorkspace ?? null,
    requirements: Array.isArray(state?.requirements) ? state.requirements.length : null,
    components: Array.isArray(state?.components) ? state.components.length : null,
    assets: Array.isArray(state?.assets) ? state.assets.length : null,
  };
}

/** 多项目总览：每个项目最多列出的 board 数（契约上限，防止单项目把结果撑爆）。 */
const MAX_BOARDS_PER_PROJECT = 20;
/** 多项目总览：一次性最多读取的项目数（projectLimit 上限）。 */
const MAX_PROJECTS_PER_OVERVIEW = 20;

/**
 * 从“项目状态”里递归找 EDA Board 条目。
 * 契约口径是 state.data（数组或对象）里 itemType==='Board'；真实 Runtime 的
 * project.current 也可能把 boards 放在 { itemType:'Project', data:[...] } 里，
 * 所以对 data/items/boards/project 这几个容器键做有限递归（深度/去重都有上限）。
 */
function collectBoardItems(value, depth, seen, out) {
  if (value == null || depth > 4 || out.length >= MAX_BOARDS_PER_PROJECT * 2) return;
  if (Array.isArray(value)) {
    for (const item of value) collectBoardItems(item, depth + 1, seen, out);
    return;
  }
  if (!isPlainObject(value) || seen.has(value)) return;
  seen.add(value);
  if (value.itemType === 'Board') out.push(value);
  for (const key of ['data', 'items', 'boards', 'project']) {
    const child = value[key];
    if (child && typeof child === 'object') collectBoardItems(child, depth + 1, seen, out);
  }
}

/** 提取项目状态里的 boards：[{name,pcbUuid,schematicUuid?}]，最多 20 个，去重。 */
export function extractProjectBoards(state) {
  const candidates = [];
  const seen = new Set();
  collectBoardItems(state?.data, 0, seen, candidates);
  collectBoardItems(state?.boards, 0, seen, candidates);
  collectBoardItems(state?.project, 0, seen, candidates);
  const boards = [];
  const boardKeys = new Set();
  for (const item of candidates) {
    if (!isPlainObject(item) || item.itemType !== 'Board') continue;
    const name = typeof item.name === 'string'
      ? item.name
      : (typeof item.parentBoardName === 'string' ? item.parentBoardName : '');
    const pcbUuid = typeof item.pcb?.uuid === 'string' ? item.pcb.uuid
      : (typeof item.pcbUuid === 'string' ? item.pcbUuid : null);
    const schematicUuid = typeof item.schematic?.uuid === 'string' ? item.schematic.uuid
      : (typeof item.schematicUuid === 'string' ? item.schematicUuid : null);
    const key = `${pcbUuid ?? ''}\u0000${name}`;
    if (boardKeys.has(key)) continue;
    boardKeys.add(key);
    boards.push({ name, pcbUuid, ...(schematicUuid ? { schematicUuid } : {}) });
    if (boards.length >= MAX_BOARDS_PER_PROJECT) break;
  }
  return boards;
}

/** 取 requirements/components/assets 计数：state.data → state → 项目列表字段。 */
function countProjectItems(state, project, key) {
  const sources = [];
  if (isPlainObject(state?.data)) sources.push(state.data);
  if (isPlainObject(state)) sources.push(state);
  for (const source of sources) {
    const value = source?.[key] ?? source?.counts?.[key];
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const fromList = project?.[key];
  if (Array.isArray(fromList)) return fromList.length;
  if (typeof fromList === 'number' && Number.isFinite(fromList)) return fromList;
  return null;
}

/**
 * Runtime 的 issue-state 兼容两种形态：新条目写 code/summary，旧条目（以及 r54 门禁问题）
 * 只写 id 里的 code 和 title。这里统一回退，避免 cp_issues 对真实问题返回空 summary/code。
 */
function normalizeIssueCode(item) {
  if (typeof item?.code === 'string' && item.code.trim()) return item.code;
  const id = typeof item?.id === 'string' ? item.id : '';
  const match = /^issue-[^-]+-(.+)$/.exec(id);
  return match ? match[1] : null;
}

export function summarizeIssues(state, { limit = 20 } = {}) {
  const issues = Array.isArray(state?.issues) ? state.issues : [];
  const open = issues.filter((item) => item && (item.status === 'open' || item.status === 'investigating'));
  open.sort((left, right) => (SEVERITY_RANK[left.severity] ?? 9) - (SEVERITY_RANK[right.severity] ?? 9)
    || (Number(right.occurrences) || 0) - (Number(left.occurrences) || 0));
  const bySeverity = {};
  for (const item of open) {
    const key = typeof item.severity === 'string' ? item.severity : 'unknown';
    bySeverity[key] = (bySeverity[key] ?? 0) + 1;
  }
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const items = open.slice(0, max).map((item) => ({
    id: item.id ?? null,
    severity: item.severity ?? null,
    status: item.status ?? null,
    code: normalizeIssueCode(item),
    summary: String(item.summary ?? item.title ?? item.message ?? '').slice(0, 300),
    occurrences: Number(item.occurrences) || 0,
    suggestedAction: item.suggestedAction ? String(item.suggestedAction).slice(0, 300) : null,
    lastOccurredAt: item.lastOccurredAt ?? null,
    projectId: item.context?.projectId ?? null,
  }));
  return {
    totalIssues: issues.length,
    open: open.length,
    bySeverity,
    items,
    truncated: open.length > items.length,
  };
}

export function summarizeEvidenceIndex(index) {
  const summary = index?.summary ?? {};
  return {
    entries: Number(summary.entries) || 0,
    kinds: isPlainObject(summary.kinds) ? summary.kinds : {},
    newestSavedAt: summary.newestSavedAt ?? null,
    oldestSavedAt: summary.oldestSavedAt ?? null,
    complete: index?.complete !== false,
    truncated: index?.truncated === true,
    invalid: Number(summary.invalid) || 0,
    duplicates: Number(summary.duplicates) || 0,
    errors: Number(summary.errors) || 0,
  };
}

export function evidenceRefsFromIndex(index, limit = 5) {
  const entries = Array.isArray(index?.entries) ? index.entries : [];
  return entries.slice(0, Math.max(0, Number(limit) || 0)).map((entry) => evidenceRef(
    entry?.kind ?? 'evidence',
    entry?.path ?? `/api/evidence/find?kind=${encodeURIComponent(String(entry?.kind ?? ''))}&digest=${encodeURIComponent(String(entry?.digest ?? ''))}`,
    entry?.digest,
  ));
}

export function summarizeExecution(kind, execution) {
  if (!isPlainObject(execution)) return { kind, raw: execution ?? null };
  const out = {
    kind,
    id: execution.id ?? execution.executionId ?? null,
    state: execution.state ?? null,
    planHash: execution.planHash ?? null,
    projectId: execution.projectId ?? null,
    documentUuid: execution.documentUuid ?? null,
  };
  for (const key of ['ok', 'error', 'errorCode', 'message', 'steps', 'phase', 'readback', 'verified', 'verification', 'rollback', 'drc', 'saved', 'completedOperations', 'failedOperations']) {
    if (execution[key] !== undefined && out[key] === undefined) out[key] = execution[key];
  }
  return out;
}

export function summarizeErc(data) {
  const report = data?.erc ?? data?.report ?? null;
  return {
    documentUuid: report?.documentUuid ?? data?.documentUuid ?? null,
    counts: report?.counts ?? null,
    aggregateOnly: report?.aggregateOnly ?? null,
    ercDetail: data?.ercDetail ? { ok: data.ercDetail.ok === true, reason: data.ercDetail.reason ?? null } : null,
    saved: data?.saved ?? null,
  };
}

export function summarizeDrc(data) {
  const report = data?.report ?? null;
  const classification = data?.classification ?? null;
  return {
    jobId: data?.jobId ?? null,
    counts: report?.counts ?? null,
    itemCount: report?.itemCount ?? (Array.isArray(report?.items) ? report.items.length : null),
    truncated: report?.truncated === true,
    classification: classification
      ? {
        ready: classification.ready === true,
        summary: classification.summary ?? null,
        findings: Array.isArray(classification.findings) ? classification.findings.slice(0, 10) : [],
      }
      : null,
    saved: data?.saved ?? null,
  };
}

/**
 * 批量校验的“该板是否通过”判定。
 *
 * 真机教训（2026-10-29）：第二块板的 DRC 报告里有 1 条 unexplained violation，
 * `drc` target 本身 `ok:true`（任务跑完了），旧逻辑却把整板算作“通过”，
 * 批量摘要输出“2 板 2 通过”。任务成功 ≠ 板子通过；这里按 target 语义分别判定：
 * - DRC：classification.ready 必须为 true，且报告未截断；
 * - ERC：fatal/error 必须为 0（warning 不算放行失败）；
 * - gates：verdict 必须 pass；
 * - 其余 target 仍以 ok 为准（未知 target 由上层拒绝）。
 * 任一 target 不通过，整板 ok=false，批量摘要不能把它算成通过。
 */
export function validationTargetPassed(target, result) {
  if (!result || result.ok !== true) return false;
  if (target === 'drc') {
    if (result.truncated === true) return false;
    return result.classification?.ready === true;
  }
  if (target === 'erc') {
    const counts = result.counts;
    if (!counts || typeof counts !== 'object') return false;
    return !(Number(counts.fatal) > 0 || Number(counts.error) > 0);
  }
  if (target === 'gates') {
    return result.verdict === 'pass' && result.ready !== false;
  }
  return true;
}

export function summarizeGates(data) {
  const report = data?.report ?? data ?? {};
  const gates = Array.isArray(report.gates) ? report.gates : [];
  const advice = data?.knowledgeAdvice;
  return {
    verdict: report.verdict ?? null,
    ready: report.ready ?? null,
    gates: gates.slice(0, 12).map((gate) => ({
      id: gate?.id ?? gate?.code ?? null,
      status: gate?.status ?? null,
      summary: gate?.summary ?? gate?.reason ?? null,
    })),
    knowledgeAdvice: isPlainObject(advice)
      ? {
        suggested: Array.isArray(advice.suggested) ? advice.suggested.length : 0,
        candidates: Array.isArray(advice.candidates) ? advice.candidates.length : 0,
      }
      : null,
  };
}

export function summarizeExport(data) {
  const files = Array.isArray(data?.files) ? data.files : [];
  return {
    exported: data?.exported === true,
    final: data?.final === true,
    outDir: data?.outDir ?? null,
    manifestHash: data?.manifestHash ?? null,
    fileCount: files.length,
    files: files.slice(0, 20).map((file) => (typeof file === 'string' ? file : file?.path ?? null)).filter(Boolean),
    decision: isPlainObject(data?.decision)
      ? {
        allowed: data.decision.allowed === true,
        outputClass: data.decision.outputClass ?? null,
        blockers: Array.isArray(data.decision.blockers) ? data.decision.blockers.slice(0, 10) : [],
      }
      : null,
    code: data?.code ?? null,
    message: data?.message ?? null,
    blockers: Array.isArray(data?.blockers) ? data.blockers.slice(0, 10) : [],
  };
}

/* ------------------------------------------------------------------ */
/* 配置归一化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 规范化 UI 地址（只用于生成审批深链）：
 *  - 仅接受 http/https；非法/非字符串回退默认；
 *  - 去掉末尾斜杠，保留 path（丢弃 query/hash，避免深链拼接歧义）；
 *  - 不发起任何网络请求。
 */
export function normalizeUiUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_UI_URL;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return DEFAULT_UI_URL;
    const path = parsed.pathname.replace(/\/+$/, '');
    const origin = parsed.origin.replace(/\/+$/, '');
    return `${origin}${path}` || DEFAULT_UI_URL;
  } catch {
    return DEFAULT_UI_URL;
  }
}

export function normalizeToolConfig(config = {}) {
  const source = isPlainObject(config) ? config : {};
  const approvalMode = source.approvalMode === 'off' ? 'off' : 'chat';
  const runtimeUrl = typeof source.runtimeUrl === 'string' && source.runtimeUrl.trim()
    ? source.runtimeUrl.trim().replace(/\/+$/, '')
    : DEFAULT_RUNTIME_URL;
  const uiUrl = normalizeUiUrl(source.uiUrl);
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);
  const maxResultBytes = Number.isFinite(source.maxResultBytes)
    ? Math.min(262_144, Math.max(1024, Math.floor(source.maxResultBytes)))
    : DEFAULT_MAX_RESULT_BYTES;
  return {
    runtimeUrl,
    uiUrl,
    approvalMode,
    agentTokenFile: typeof source.agentTokenFile === 'string' ? source.agentTokenFile : '',
    maxResultBytes,
    requestTimeoutMs: positive(source.requestTimeoutMs, DEFAULT_TOOL_CONFIG.requestTimeoutMs),
    jobTimeoutMs: positive(source.jobTimeoutMs, DEFAULT_TOOL_CONFIG.jobTimeoutMs),
    approvalTtlMs: positive(source.approvalTtlMs, DEFAULT_TOOL_CONFIG.approvalTtlMs),
    planTtlMs: positive(source.planTtlMs, DEFAULT_TOOL_CONFIG.planTtlMs),
    drcPollIntervalMs: positive(source.drcPollIntervalMs, DEFAULT_TOOL_CONFIG.drcPollIntervalMs),
    drcPollTimeoutMs: positive(source.drcPollTimeoutMs, DEFAULT_TOOL_CONFIG.drcPollTimeoutMs),
    clock: typeof source.clock === 'function' ? source.clock : DEFAULT_TOOL_CONFIG.clock,
  };
}

/* ------------------------------------------------------------------ */
/* Schema 构造                                                         */
/* ------------------------------------------------------------------ */

function objectSchema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const stringField = (description, extra = {}) => ({ type: 'string', description, ...extra });
const booleanField = (description) => ({ type: 'boolean', description });
const numberField = (description, extra = {}) => ({ type: 'number', description, ...extra });
const requestIdField = stringField('本次写/长任务的唯一幂等键（由调用方生成，例如 "req-20261029-1"）。同一 requestId 重复调用返回同一 job，不会重复执行。', { minLength: 1, maxLength: 200 });
const planHashField = stringField('计划哈希（来自 cp_design_plan / cp_pcb_plan 返回的 planHash）。', { minLength: 8, maxLength: 256 });
const confirmField = booleanField('必须显式传 true，表示用户已在对话中明确批准。缺省或 false 一律拒绝。');

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function jobStateText(state) {
  switch (state) {
    case 'queued': return '排队中';
    case 'running': return '运行中';
    case 'done': return '完成';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
    case 'timeout': return '超时（可能已生效）';
    default: return String(state ?? 'unknown');
  }
}

function jobNextActions(job) {
  if (!job) return ['用 cp_job{action:"status", jobId} 查询任务'];
  switch (job.state) {
    case 'queued':
    case 'running':
      return ['继续用 cp_job{action:"wait", jobId} 等待；不要重复提交同一写操作'];
    case 'done':
      return Array.isArray(job.result?.nextActions) && job.result.nextActions.length
        ? job.result.nextActions
        : ['核对结果与证据；需要时用 cp_evidence / cp_status 复核'];
    case 'failed':
      return [
        '把错误码/消息和证据报告给用户；不要自动重试写操作',
        ...(job.mayHaveTakenEffect ? ['副作用可能已发生：先用 cp_status / cp_evidence 核对，再决定是否重新批准'] : []),
      ];
    case 'timeout':
    case 'cancelled':
      return [
        '超时/取消不代表没有生效：禁止自动重试写操作',
        '先用 cp_status / cp_evidence / cp_job status 核对实际状态，再决定是否重新批准并换新 requestId',
      ];
    default:
      return ['用 cp_job 继续查询任务状态'];
  }
}

/* ------------------------------------------------------------------ */
/* 工具工厂                                                            */
/* ------------------------------------------------------------------ */

/**
 * 创建工具定义数组。返回的每个工具：
 *   { name, description, type:'read'|'plan'|'approve'|'execute', inputSchema, execute(args, {signal}) }
 * execute 永远返回 JSON 可序列化对象（已按 maxResultBytes 裁剪）。
 */
/**
 * cp_validation 批量模式：校验并规范化 boards。
 * 契约：非空数组，最多 3 块；每项 {pcbUuid 必填(≤200), schematicUuid? 非空(≤200)}；
 * 重复 pcbUuid 按首次出现去重（避免同一块板跑两遍 DRC）。
 * 返回 {boards, duplicates} 或 {error}；错误一律由调用方映射为 INVALID_ARGUMENTS。
 */
export function normalizeValidationBoards(boards) {
  if (!Array.isArray(boards) || boards.length === 0) {
    return { error: 'boards 必须是非空数组（最多 3 块板）' };
  }
  if (boards.length > 3) {
    return { error: `boards 最多 3 块板（收到 ${boards.length} 块）` };
  }
  const normalized = [];
  const seen = new Set();
  let duplicates = 0;
  for (let index = 0; index < boards.length; index += 1) {
    const item = boards[index];
    if (!isPlainObject(item)) {
      return { error: `boards[${index}] 必须是 {pcbUuid, schematicUuid?} 对象` };
    }
    const pcbUuid = typeof item.pcbUuid === 'string' ? item.pcbUuid.trim() : '';
    if (!pcbUuid) return { error: `boards[${index}].pcbUuid 必填` };
    if (pcbUuid.length > 200) return { error: `boards[${index}].pcbUuid 长度不能超过 200` };
    let schematicUuid = null;
    if (item.schematicUuid !== undefined && item.schematicUuid !== null) {
      if (typeof item.schematicUuid !== 'string' || !item.schematicUuid.trim()) {
        return { error: `boards[${index}].schematicUuid 必须是非空字符串` };
      }
      if (item.schematicUuid.length > 200) return { error: `boards[${index}].schematicUuid 长度不能超过 200` };
      schematicUuid = item.schematicUuid.trim();
    }
    if (seen.has(pcbUuid)) {
      duplicates += 1;
      continue;
    }
    seen.add(pcbUuid);
    normalized.push({ pcbUuid, ...(schematicUuid ? { schematicUuid } : {}) });
  }
  if (!normalized.length) return { error: 'boards 去重后为空' };
  return { boards: normalized, duplicates };
}

/** 计划级审批请求的文本列表：最多 20 条、每条 ≤300；非字符串安全转 JSON 文本。 */
function requestTextList(values, limit = 20) {
  const list = [];
  for (const value of Array.isArray(values) ? values : []) {
    let text = '';
    if (typeof value === 'string') text = value.trim();
    else if (value != null) {
      try {
        text = JSON.stringify(value);
      } catch {
        text = '';
      }
    }
    if (!text) continue;
    list.push(text.slice(0, 300));
    if (list.length >= limit) break;
  }
  return list;
}

/** risks：从 plan.risks / plan.assumptions 取，≤20 条、每条 ≤300。 */
function collectPlanRequestRisks(plan) {
  const values = [];
  if (Array.isArray(plan?.risks)) values.push(...plan.risks);
  if (Array.isArray(plan?.assumptions)) values.push(...plan.assumptions);
  return requestTextList(values, 20);
}

export function createCircuitPilotTools({ config, client, jobs } = {}) {
  const cfg = normalizeToolConfig(config);
  const runtime = client ?? new RuntimeClient({
    baseUrl: cfg.runtimeUrl,
    tokenFile: cfg.agentTokenFile || resolveAgentTokenFile(),
    timeoutMs: cfg.requestTimeoutMs,
  });
  const manager = jobs ?? new JobManager({ defaultTimeoutMs: cfg.jobTimeoutMs });
  const planStore = new Map(); // planHash -> { kind, plan, planHash, storedAt }
  const approvals = new Map(); // planHash -> approval record
  const clock = cfg.clock;
  // 审批深链：只拼 UI 地址，不携带 token/planHash 等敏感或易变参数。
  const approvalUrl = `${cfg.uiUrl}/?agent=approvals#settings`;
  const approvalUiAction = `在 UI 查看/撤销待执行批准：${approvalUrl}`;
  // 计划级 UI 审批（task-40）深链：只到“计划待审批”区，不携带 requestId/token。
  const planApprovalUrl = `${cfg.uiUrl}/?agent=plans#settings`;
  const planApprovalWaitAction = `等待用户在 UI 批准/拒绝；批准后再 cp_approve；UI 批准不签发 token（${planApprovalUrl}）`;

  const call = (method, path, options = {}) => runtime.request(method, path, options);

  /**
   * 多项目/多板只读总览：GET /api/projects → 逐项目 GET /api/projects/:id/state（并发）。
   * 单项目失败只进 errors 并标记 projectOverview.partial，不拖垮当前项目上下文。
   */
  async function loadProjectOverview({ projectLimit, signal }) {
    const listEnv = await call('GET', '/api/projects', { signal });
    if (!listEnv.ok) {
      return {
        projects: [],
        overview: {
          total: 0,
          returned: 0,
          partial: true,
          errors: [{ projectId: null, code: listEnv.code, message: listEnv.message }],
        },
      };
    }
    const all = Array.isArray(listEnv.data?.projects) ? listEnv.data.projects : [];
    const total = all.length;
    const selected = all.slice(0, projectLimit);
    const settled = await Promise.all(selected.map(async (item, index) => {
      const projectId = item?.id == null ? '' : String(item.id);
      const base = {
        id: projectId,
        name: typeof item?.name === 'string' ? item.name : null,
        stage: item?.stage ?? null,
        archived: item?.archived === true,
        edaBound: item?.edaBound === true,
        savedAt: item?.savedAt ?? null,
      };
      if (!projectId) {
        const code = 'PROJECT_ID_MISSING';
        const message = `项目列表第 ${index + 1} 项缺少 id，跳过状态读取`;
        return { entry: { ...base, counts: null, boards: [], error: { code, message } }, error: { projectId: null, code, message } };
      }
      const env = await call('GET', `/api/projects/${encodeURIComponent(projectId)}/state`, { signal });
      if (!env.ok) {
        return {
          entry: { ...base, counts: null, boards: [], error: { code: env.code, message: env.message } },
          error: { projectId, code: env.code, message: env.message },
        };
      }
      const projectState = env.data?.state;
      return {
        entry: {
          ...base,
          savedAt: env.data?.savedAt ?? base.savedAt,
          counts: {
            requirements: countProjectItems(projectState, item, 'requirements'),
            components: countProjectItems(projectState, item, 'components'),
            assets: countProjectItems(projectState, item, 'assets'),
          },
          boards: extractProjectBoards(projectState),
        },
        error: null,
      };
    }));
    const projects = settled.map((item) => item.entry);
    const errors = settled.map((item) => item.error).filter(Boolean);
    return { projects, overview: { total, returned: projects.length, partial: errors.length > 0, errors } };
  }

  /** 单板目标执行（单板模式与批量模式共用）。allowCurrentFallback=false 时 ERC 绝不回退当前原理图。 */
  async function runValidationTargets({ targets, pcbUuid, schematicUuid, signal, allowCurrentFallback }) {
    const results = {};
    const evidence = [];
    let failures = 0;
    for (const target of targets) {
      if (target === 'erc') {
        if (!schematicUuid && !allowCurrentFallback) {
          failures += 1;
          results.erc = {
            ok: false,
            code: 'SCHEMATIC_UUID_REQUIRED',
            message: 'ERC 需要该板的 schematicUuid；批量模式不会回退到当前原理图（防止把 A 板结果记到 B 板）',
          };
          continue;
        }
        const env = await call('POST', '/api/eda/schematic/erc/run', {
          body: schematicUuid ? { schematicUuid } : {},
          signal,
        });
        if (!env.ok) {
          failures += 1;
          results.erc = { ok: false, code: env.code, message: env.message, nextActions: env.nextActions };
          continue;
        }
        const summary = summarizeErc(env.data);
        results.erc = { ok: true, ...summary };
        if (env.data?.saved?.path) {
          evidence.push(evidenceRef('schematic-erc', env.data.saved.path, env.data.saved.digest));
        }
      } else if (target === 'drc') {
        const started = await call('POST', '/api/eda/pcb/drc/start', {
          body: pcbUuid ? { pcbUuid } : {},
          signal,
        });
        if (!started.ok) {
          failures += 1;
          results.drc = { ok: false, code: started.code, message: started.message, nextActions: started.nextActions };
          continue;
        }
        const drcJobId = started.data?.jobId;
        if (typeof drcJobId !== 'string' || !drcJobId) {
          failures += 1;
          results.drc = { ok: false, code: 'DRC_JOB_ID_MISSING', message: 'DRC 启动没有返回 jobId' };
          continue;
        }
        const startedAt = clock();
        let final = null;
        while (!final) {
          const report = await call('POST', '/api/eda/pcb/drc/report', {
            body: { jobId: drcJobId, ...(pcbUuid ? { pcbUuid } : {}) },
            signal,
          });
          if (!report.ok) {
            failures += 1;
            results.drc = { ok: false, code: report.code, message: report.message, nextActions: report.nextActions, jobId: drcJobId };
            break;
          }
          const state = report.data?.state;
          if (state === 'done') {
            final = report.data;
            break;
          }
          if (state === 'running' || state === 'pending' || state === 'unknown') {
            if (clock() - startedAt >= cfg.drcPollTimeoutMs) {
              failures += 1;
              results.drc = {
                ok: false,
                code: 'DRC_POLL_TIMEOUT',
                message: `DRC 在 ${cfg.drcPollTimeoutMs}ms 内未完成（EDA jobId=${drcJobId}）；不要重复启动，稍后回查`,
                nextActions: ['稍后用 cp_job / cp_validation 重试前先确认 EDA 是否仍在跑 DRC', '不要连续启动 DRC 任务'],
                jobId: drcJobId,
              };
              break;
            }
            await sleep(cfg.drcPollIntervalMs, signal);
            continue;
          }
          failures += 1;
          results.drc = { ok: false, code: 'DRC_FAILED', message: `DRC 状态 ${String(state)}`, jobId: drcJobId };
          break;
        }
        if (final) {
          const summary = summarizeDrc(final);
          results.drc = { ok: true, ...summary };
          if (final.saved?.path) evidence.push(evidenceRef('drc-report', final.saved.path, final.saved.digest));
        }
      } else if (target === 'gates') {
        const env = await call('POST', '/api/eda/gates/evaluate', { body: pcbUuid ? { pcbUuid } : {}, signal });
        if (!env.ok) {
          failures += 1;
          results.gates = { ok: false, code: env.code, message: env.message, nextActions: env.nextActions };
          continue;
        }
        results.gates = { ok: true, ...summarizeGates(env.data) };
        evidence.push(evidenceRef('gate-report', '/api/eda/gates/status', null));
      }
    }
    return { results, evidence, failures };
  }

  /** 批量只读校验：按 boards 顺序逐板跑 targets；单板失败记录 error 后继续，不拖垮整批。 */
  async function runBatchValidation({ targets, boards, signal }) {
    const boardReports = [];
    const evidence = [];
    let succeeded = 0;
    let failed = 0;
    for (const board of boards) {
      if (targets.includes('erc') && !board.schematicUuid) {
        failed += 1;
        boardReports.push({
          pcbUuid: board.pcbUuid,
          ok: false,
          results: {},
          error: {
            code: 'SCHEMATIC_UUID_REQUIRED',
            message: '该板没有 schematicUuid：批量模式拒绝回退到当前原理图（防止 ERC 结果串板）；请为该板补上 schematicUuid 后换新 requestId 重跑',
          },
        });
        continue;
      }
      try {
        const run = await runValidationTargets({
          targets,
          pcbUuid: board.pcbUuid,
          schematicUuid: board.schematicUuid,
          signal,
          allowCurrentFallback: false,
        });
        const failedTargets = Object.entries(run.results)
          .filter(([target, value]) => !validationTargetPassed(target, value))
          .map(([target]) => target);
        const ok = run.failures === 0 && failedTargets.length === 0;
        if (ok) succeeded += 1;
        else failed += 1;
        const entry = {
          pcbUuid: board.pcbUuid,
          ...(board.schematicUuid ? { schematicUuid: board.schematicUuid } : {}),
          ok,
          results: run.results,
        };
        if (!ok) {
          entry.error = {
            code: 'BOARD_VALIDATION_FAILED',
            message: `${failedTargets.join('/') || '部分目标'} 未通过（任务完成不等于板子通过）；该板不能当作通过`,
            failedTargets,
          };
        }
        boardReports.push(entry);
        for (const ref of run.evidence) evidence.push({ ...ref, boardPcbUuid: board.pcbUuid });
      } catch (error) {
        if (signal?.aborted) throw error;
        failed += 1;
        boardReports.push({
          pcbUuid: board.pcbUuid,
          ...(board.schematicUuid ? { schematicUuid: board.schematicUuid } : {}),
          ok: false,
          results: {},
          error: { code: error?.code ?? 'BOARD_VALIDATION_ERROR', message: error?.message ?? String(error) },
        });
      }
    }
    const summary = `批量校验：${boardReports.length} 板，${succeeded} 通过，${failed} 失败`;
    const data = { targets, batch: { total: boardReports.length, succeeded, failed, boards: boardReports } };
    const nextActions = failed > 0
      ? ['逐板修复失败目标后换新 requestId 整批重跑；不要重复提交同一 requestId', '失败板不能当作通过；把每板 error 与已有证据一起报告给用户', '批量只读校验不改变 EDA 状态，也不替代用户放行/签核']
      : ['把每板 ERC/DRC 计数、gates verdict 与证据引用报告给用户', '批量只读校验不替代用户放行；导出/签核仍需人工门禁', '不要重复提交同一 requestId（同 id 返回同一 job）'];
    if (failed > 0) {
      const code = failed === boardReports.length ? 'VALIDATION_ALL_FAILED' : 'VALIDATION_PARTIAL_FAILED';
      return capResult({ ...failResult(code, summary, { data, evidence, nextActions }), summary }, cfg.maxResultBytes);
    }
    return capResult(okResult(summary, { data, evidence, nextActions }), cfg.maxResultBytes);
  }

  /**
   * 计划级 UI 审批（task-40）：登记 pending 请求，只落队列，不签发/保存 token。
   * 返回 { ok:true, requestId } / { ok:false, fatal, code, message, nextActions }；
   * fatal=true 表示 EDA 上下文不可用/不完整：整工具失败，绝不发送空绑定。
   */
  async function submitPlanApprovalRequest({ kind, plan, planHash, ready, missing, operationCount, title, signal }) {
    const contextEnv = kind === 'pcb'
      ? await call('GET', '/api/pcb/context', { signal })
      : await call('GET', '/api/design/context', { signal });
    if (!contextEnv.ok) {
      return {
        ok: false,
        fatal: true,
        code: contextEnv.code,
        message: contextEnv.message,
        nextActions: [...(contextEnv.nextActions ?? []), '读取 EDA 目标上下文失败：可重试 requestApproval，或改用对话审批（cp_approve + confirm=true）'],
      };
    }
    const context = contextEnv.data?.context ?? {};
    const windowId = context.windowId;
    const targetFingerprint = context.targetFingerprint;
    if (typeof windowId !== 'string' || !windowId || typeof targetFingerprint !== 'string' || !targetFingerprint) {
      return {
        ok: false,
        fatal: true,
        code: 'APPROVAL_CONTEXT_INCOMPLETE',
        message: 'EDA 上下文缺少 windowId/targetFingerprint，无法登记计划级审批请求（不会发送空绑定）',
        nextActions: ['确认 EDA 已打开目标文档且 Bridge 正常；重新 cp_status 后再试', '或让用户使用对话审批（cp_approve + confirm=true）'],
      };
    }
    const projectId = context.project?.uuid ?? context.projectId ?? null;
    const documentUuid = context.document?.uuid ?? context.document?.documentUuid ?? context.pcb?.document?.uuid ?? null;
    const risks = collectPlanRequestRisks(plan);
    const missingList = requestTextList(missing, 20);
    const kindLabel = kind === 'pcb' ? 'PCB' : '原理图';
    const defaultTitle = kind === 'pcb' ? 'PCB 计划审批请求' : '原理图设计计划审批请求';
    const requestTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0, 500) : defaultTitle;
    const summary = `${kindLabel}计划：ready=${ready === true}；missing ${missingList.length} 项；operations ${Number.isFinite(operationCount) ? operationCount : 0} 个；risks ${risks.length} 条`;
    const env = await call('POST', '/api/agent/plan-requests', {
      body: {
        kind,
        planHash,
        targetFingerprint,
        windowId,
        ...(projectId ? { projectId: String(projectId) } : {}),
        ...(documentUuid ? { documentUuid: String(documentUuid) } : {}),
        title: requestTitle,
        summary,
        risks,
        missing: missingList,
      },
      signal,
    });
    if (!env.ok) {
      return {
        ok: false,
        fatal: false,
        code: env.code,
        message: env.message,
        nextActions: [...(env.nextActions ?? []), '可重试 requestApproval，或让用户使用对话审批（cp_approve + confirm=true）；不要伪造 requestId'],
      };
    }
    const request = env.data?.request ?? {};
    const requestId = typeof request.requestId === 'string' ? request.requestId.trim() : '';
    if (!requestId) {
      return {
        ok: false,
        fatal: false,
        code: 'APPROVAL_REQUEST_INVALID',
        message: 'Runtime 没有返回 approval requestId，不能把该请求当作已登记',
        nextActions: ['可重试 requestApproval，或让用户使用对话审批；不要伪造 requestId'],
      };
    }
    return { ok: true, requestId };
  }

  function storePlan(kind, plan, planHash, extra = {}) {
    if (!planHash) return;
    if (planStore.size >= 50) {
      const oldest = [...planStore.entries()].sort((left, right) => left[1].storedAt - right[1].storedAt)[0];
      if (oldest) planStore.delete(oldest[0]);
    }
    planStore.set(planHash, { kind, plan, planHash, storedAt: clock(), ...extra });
  }

  /** 把计划级审批 requestId 附着到已缓存计划，供 cp_approve 自动带上；不覆盖其它字段。 */
  function attachApprovalRequest(planHash, approvalRequestId) {
    const item = planStore.get(planHash);
    if (!item || !approvalRequestId) return;
    planStore.set(planHash, { ...item, approvalRequestId });
  }

  function getPlan(planHash) {
    const item = planStore.get(planHash);
    if (!item) return null;
    if (clock() - item.storedAt > cfg.planTtlMs) {
      planStore.delete(planHash);
      return null;
    }
    return item;
  }

  function recordApproval(record) {
    if (approvals.size >= 20) {
      const oldest = [...approvals.entries()].sort((left, right) => left[1].approvedAtMs - right[1].approvedAtMs)[0];
      if (oldest) approvals.delete(oldest[0]);
    }
    approvals.set(record.planHash, record);
  }

  function getApproval(planHash) {
    return approvals.get(planHash) ?? null;
  }

  function jobHandle(job, extra = {}) {
    return {
      jobId: job.jobId,
      kind: job.kind,
      requestId: job.requestId,
      state: job.state,
      timeoutMs: job.timeoutMs,
      mayHaveTakenEffect: job.mayHaveTakenEffect === true,
      ...extra,
    };
  }

  function jobResultView(job) {
    const snapshot = manager.snapshot(job.jobId) ?? manager.snapshot(job);
    if (!snapshot) return null;
    return snapshot;
  }

  function makeTool({ name, description, type, inputSchema, handler }) {
    return {
      name,
      description,
      type,
      inputSchema,
      async execute(args, exec = {}) {
        const input = isPlainObject(args) ? args : {};
        const errors = validateInput(inputSchema, input);
        if (errors.length) {
          return capResult(failResult('INVALID_ARGUMENTS', `参数不合法：${errors.slice(0, 6).join('；')}`, {
            nextActions: ['按工具 inputSchema 修正参数后重试', '不要猜测字段名或跳过必填参数'],
          }), cfg.maxResultBytes);
        }
        const signal = exec?.signal;
        try {
          return capResult(await handler(input, { signal, exec }), cfg.maxResultBytes);
        } catch (error) {
          return capResult(failResult(error?.code || 'TOOL_ERROR', error?.message || String(error), {
            nextActions: Array.isArray(error?.nextActions) ? error.nextActions : ['插件内部错误：把错误码反馈给用户，并检查 CircuitPilot Runtime 日志'],
          }), cfg.maxResultBytes);
        }
      },
    };
  }

  const tools = [];

  /* ---------------- read ---------------- */

  tools.push(makeTool({
    name: 'cp_status',
    description: '读取 CircuitPilot 当前状态（Runtime 版本、当前项目、EDA 工作区、写暂停、未收口问题数、最近证据）。开始任何 CircuitPilot 任务前先调用。只读；不改变项目、不执行 EDA 动作。',
    type: 'read',
    inputSchema: objectSchema(),
    async handler(_args, { signal }) {
      const health = await call('GET', '/api/health', { signal });
      if (!health.ok) {
        return failResult(health.code, health.message, { nextActions: health.nextActions.length ? health.nextActions : RUNTIME_DOWN_ACTIONS });
      }
      const [projectEnv, gateEnv, workspaceEnv, issueEnv, evidenceEnv] = await Promise.all([
        call('GET', '/api/project-state', { signal }),
        call('GET', '/api/write-gate', { signal }),
        call('GET', '/api/eda/workspaces/current', { signal }),
        call('GET', '/api/issue-state', { signal }),
        call('GET', '/api/evidence/index', { signal }),
      ]);
      if (!projectEnv.ok) {
        return failResult(projectEnv.code, projectEnv.message, { nextActions: projectEnv.nextActions.length ? projectEnv.nextActions : RUNTIME_DOWN_ACTIONS });
      }
      const project = summarizeProjectState(projectEnv.data?.state);
      const gate = gateEnv.ok
        ? {
          available: true,
          paused: gateEnv.data?.gate?.paused === true,
          sessionPaused: gateEnv.data?.gate?.sessionPaused === true,
          reason: gateEnv.data?.gate?.reason ?? null,
          actor: gateEnv.data?.gate?.actor ?? null,
        }
        : { available: false, error: { code: gateEnv.code, message: gateEnv.message } };
      const eda = workspaceEnv.ok
        ? { online: true, workspace: workspaceEnv.data?.workspace ?? null }
        : { online: false, error: { code: workspaceEnv.code, message: workspaceEnv.message } };
      const issues = issueEnv.ok ? summarizeIssues(issueEnv.data?.state) : null;
      const evidence = evidenceEnv.ok
        ? summarizeEvidenceIndex(evidenceEnv.data?.index)
        : { available: false, error: { code: evidenceEnv.code, message: evidenceEnv.message } };
      const warnings = [];
      if (!gate.available) warnings.push('写暂停状态读取失败：写操作前必须人工确认 Runtime 写门禁');
      if (!eda.online) warnings.push('EDA 工作区读取失败（常见：EDA 未启动/未选中 PCB 文档/多窗口未选择）');
      if (!issues) warnings.push('问题状态读取失败');
      const nextActions = [];
      if (gate.paused || gate.sessionPaused) {
        nextActions.push(`写入已暂停${gate.reason ? `（${gate.reason}）` : ''}：不要执行任何写操作；让用户在 CircuitPilot 解除写暂停`);
      }
      if (!eda.online) nextActions.push('打开嘉立创EDA并选中目标 PCB 文档/绑定工作区后重试');
      if (issues?.open > 0) nextActions.push('存在未收口问题：调用 cp_issues 查看详情，先处理 P0/P1 再计划写入');
      if (!nextActions.length) nextActions.push('需要设计方案时调用 cp_design_plan；需要 PCB 计划时调用 cp_pcb_plan');
      const version = health.data?.version ?? null;
      return okResult(
        `CircuitPilot Runtime ${version ?? '(未知版本)'} 在线；项目「${project.name ?? '未知'}」阶段 ${project.stage ?? '未知'}；EDA ${eda.online ? '在线' : '离线'}；写暂停 ${gate.paused || gate.sessionPaused ? '是' : '否'}；未收口问题 ${issues?.open ?? '未知'}；证据 ${evidence.entries ?? '未知'} 份`,
        {
          data: {
            runtime: { reachable: true, version, service: health.data?.service ?? null, host: health.data?.host ?? null },
            project,
            eda,
            writeGate: gate,
            issues: issues ? { open: issues.open, bySeverity: issues.bySeverity, top: issues.items.slice(0, 5) } : null,
            evidence,
            warnings,
          },
          evidence: evidenceEnv.ok ? evidenceRefsFromIndex(evidenceEnv.data?.index, 5) : [],
          nextActions,
        },
      );
    },
  }));

  tools.push(makeTool({
    name: 'cp_project_context',
    description: '读取当前 CircuitPilot 项目上下文：项目身份/阶段/统计、EDA 工作区绑定、未收口问题摘要。比 cp_status 更聚焦项目；只读，不改变状态。可选 includeAllProjects=true 额外读取全部项目/多板只读总览（不切换 EDA、不写），用于批量/多板任务前建立全局视图。',
    type: 'read',
    inputSchema: objectSchema({
      includeAllProjects: booleanField('是否额外读取全部项目/多板只读总览（默认 false）。只读：不切换当前项目、不调用任何写路由。'),
      projectLimit: { type: 'integer', description: 'includeAllProjects=true 时最多读取多少个项目（1–20，默认 10）。', minimum: 1, maximum: 20 },
    }),
    async handler(args, { signal }) {
      const [projectEnv, workspaceEnv, issueEnv] = await Promise.all([
        call('GET', '/api/project-state', { signal }),
        call('GET', '/api/eda/workspaces/current', { signal }),
        call('GET', '/api/issue-state', { signal }),
      ]);
      if (!projectEnv.ok) {
        return failResult(projectEnv.code, projectEnv.message, { nextActions: projectEnv.nextActions.length ? projectEnv.nextActions : RUNTIME_DOWN_ACTIONS });
      }
      const state = projectEnv.data?.state;
      const project = summarizeProjectState(state);
      const workspace = workspaceEnv.ok ? workspaceEnv.data?.workspace ?? null : null;
      const issues = issueEnv.ok ? summarizeIssues(issueEnv.data?.state) : null;

      // 可选：多项目/多板只读总览。只 GET；单项目失败只记 error，不影响其它项目与当前项目上下文。
      let allProjects = null;
      if (args.includeAllProjects === true) {
        const projectLimit = Number.isInteger(args.projectLimit)
          ? Math.min(MAX_PROJECTS_PER_OVERVIEW, Math.max(1, args.projectLimit))
          : 10;
        allProjects = await loadProjectOverview({ projectLimit, signal });
      }

      const data = {
        project,
        edaWorkspace: workspace,
        edaError: workspaceEnv.ok ? null : { code: workspaceEnv.code, message: workspaceEnv.message },
        issues: issues ? { open: issues.open, bySeverity: issues.bySeverity } : null,
        counts: { requirements: project.requirements, components: project.components, assets: project.assets },
      };
      const nextActions = [];
      if (workspace) nextActions.push('计划改动前先调用 cp_design_plan / cp_pcb_plan 并让用户确认');
      else nextActions.push('先让用户在 CircuitPilot 绑定/选中 EDA 工程与 PCB 文档；未绑定无法读取真机上下文');
      let overviewText = '';
      if (allProjects) {
        data.projects = allProjects.projects;
        data.projectOverview = allProjects.overview;
        overviewText = `；全部项目 ${allProjects.overview.returned}/${allProjects.overview.total}${allProjects.overview.partial ? '（partial）' : ''}`;
        if (allProjects.overview.partial) {
          nextActions.push('部分项目读取失败（见 data.projectOverview.errors）：不要假设已看到全部项目/板，按错误逐个补读或让用户在 UI 核对');
        }
        if (allProjects.overview.returned < allProjects.overview.total) {
          nextActions.push(`projectLimit 截断：只读了前 ${allProjects.overview.returned} 个项目；需要更多时调大 projectLimit（≤20）`);
        }
        if (!allProjects.overview.partial && allProjects.overview.returned === allProjects.overview.total && allProjects.projects.length) {
          nextActions.push('多项目视图只读：执行写操作前仍需先切到目标项目并重新读取 cp_design_plan / cp_pcb_plan 计划');
        }
      }
      return okResult(
        `项目「${project.name ?? '未知'}」阶段 ${project.stage ?? '未知'}；项目数 ${project.projectCount}；EDA ${workspace ? '已绑定' : '未绑定/不可用'}；未收口问题 ${issues?.open ?? '未知'}${overviewText}`,
        { data, nextActions },
      );
    },
  }));

  tools.push(makeTool({
    name: 'cp_issues',
    description: '读取当前项目官方未收口问题（issue-state 中 open/investigating 的条目），按严重度排序。只读。此工具不修复问题；修复建议需结合 approved 知识（cp_knowledge）与验证证据（cp_validation）。',
    type: 'read',
    inputSchema: objectSchema({
      limit: numberField('最多返回多少条，默认 20，上限 50。', { minimum: 1, maximum: 50 }),
      severity: { type: 'string', enum: ['critical', 'error', 'warning', 'info'], description: '只返回指定严重度。' },
    }),
    async handler(args, { signal }) {
      const env = await call('GET', '/api/issue-state', { signal });
      if (!env.ok) return failResult(env.code, env.message, { nextActions: env.nextActions });
      const summary = summarizeIssues(env.data?.state, { limit: args.limit ?? 20 });
      const items = args.severity ? summary.items.filter((item) => item.severity === args.severity) : summary.items;
      const bySeverity = {};
      for (const item of items) bySeverity[item.severity ?? 'unknown'] = (bySeverity[item.severity ?? 'unknown'] ?? 0) + 1;
      return okResult(
        `未收口问题 ${summary.open} 条${args.severity ? `（筛选 ${args.severity} 后 ${items.length} 条）` : ''}；严重度分布 ${JSON.stringify(bySeverity)}`,
        {
          data: { totalIssues: summary.totalIssues, open: summary.open, bySeverity, items, truncated: summary.truncated || items.length < summary.open },
          nextActions: items.length
            ? ['按严重度从高到低处理；改动前先出计划并让用户确认', '修复后运行 cp_validation 获取官方 ERC/DRC 结论']
            : ['当前没有未收口问题；可运行 cp_validation 复核官方 ERC/DRC'],
        },
      );
    },
  }));

  tools.push(makeTool({
    name: 'cp_evidence',
    description: '查询 CircuitPilot 证据索引/证据文件引用（DRC、ERC、门禁、导出等）。只读。可指定 kind/digest 精确查找，或用 executionId 查某次设计/PCB 执行的证据。返回文件路径与 digest 供引用；不返回完整原始大 JSON。',
    type: 'read',
    inputSchema: objectSchema({
      kind: stringField('证据 kind，例如 drc-report / schematic-erc / lib-evidence / release-signoff。', { maxLength: 100 }),
      digest: stringField('证据 digest（精确匹配，大小写不敏感）。提供时走 find 接口。', { maxLength: 128 }),
      executionId: stringField('设计或 PCB 执行 id（先查 design evidence，不存在时查 PCB execution 记录）。', { maxLength: 200 }),
      limit: numberField('最多返回条数，默认 10，上限 50。', { minimum: 1, maximum: 50 }),
    }),
    async handler(args, { signal }) {
      const limit = args.limit ?? 10;
      if (args.executionId) {
        const designPath = `/api/design/executions/${encodeURIComponent(args.executionId)}/evidence`;
        const env = await call('GET', designPath, { signal });
        if (env.ok) {
          const evidence = env.data?.evidence ?? env.data;
          return okResult(`执行 ${args.executionId} 的证据已返回（文件引用见 evidence）`, {
            data: { executionId: args.executionId, kind: 'design', evidence },
            evidence: [evidenceRef('design-execution-evidence', designPath, env.data?.digest ?? null)],
            nextActions: ['引用证据时带上 evidence.kind/ref/digest；不要声称"通过"而没有对应证据'],
          });
        }
        /**
         * 真机教训（2026-10-29）：PCB 执行（pcb.save / pcb.drc）完成后，设计执行 evidence 路由
         * 必然 404；旧实现直接把 EXECUTION_NOT_FOUND 返回给模型，真实写板证据无法通过 cp_evidence 取回。
         * 此时回退到 PCB execution 记录（含 snapshot/readback/drc/write-verify），不伪造“设计证据”。
         */
        if (env.code === 'EXECUTION_NOT_FOUND') {
          const pcbPath = `/api/pcb/executions/${encodeURIComponent(args.executionId)}`;
          const pcbEnv = await call('GET', pcbPath, { signal });
          if (pcbEnv.ok) {
            const execution = pcbEnv.data?.execution ?? pcbEnv.data;
            return okResult(`PCB 执行 ${args.executionId} 的记录已返回（snapshot/readback/DRC/write-verify）`, {
              data: { executionId: args.executionId, kind: 'pcb', execution },
              evidence: [evidenceRef('pcb-execution', pcbPath, execution?.planHash ?? null)],
              nextActions: ['引用 execution.readback/drc/snapshot/write-verify 作为真实写链路证据；不要把它当作设计执行证据'],
            });
          }
          return failResult(pcbEnv.code, pcbEnv.message, { nextActions: pcbEnv.nextActions });
        }
        return failResult(env.code, env.message, { nextActions: env.nextActions });
      }
      if (args.digest) {
        const env = await call('GET', '/api/evidence/find', { query: { kind: args.kind, digest: args.digest }, signal });
        if (!env.ok) {
          return failResult(env.code, env.message, {
            nextActions: ['确认 kind/digest 拼写；不带 digest 调用 cp_evidence 可列出索引', '不要伪造 digest：找不到就是找不到'],
          });
        }
        const entry = env.data?.evidence ?? null;
        return okResult(entry ? `找到证据：${entry.kind ?? args.kind} / ${entry.digest ?? args.digest}` : '未找到匹配证据', {
          data: { entry, indexSummary: env.data?.index?.summary ?? null },
          evidence: entry ? [evidenceRef(entry.kind, entry.path, entry.digest)] : [],
          nextActions: entry ? ['用 evidence.ref 引用文件；需要细节时再按 kind 查询'] : ['换 kind/digest 再查，或先列出证据索引'],
        });
      }
      const env = await call('GET', '/api/evidence/index', { signal });
      if (!env.ok) return failResult(env.code, env.message, { nextActions: env.nextActions });
      const index = env.data?.index ?? {};
      const entries = (Array.isArray(index.entries) ? index.entries : [])
        .filter((entry) => !args.kind || entry.kind === args.kind)
        .slice(0, limit)
        .map((entry) => ({
          kind: entry.kind ?? null,
          digest: entry.digest ?? null,
          savedAt: entry.savedAt ?? null,
          note: entry.note ?? null,
          path: entry.path ?? null,
          fingerprint: entry.fingerprint ?? null,
        }));
      return okResult(`证据索引共 ${index.summary?.entries ?? entries.length} 份，返回 ${entries.length} 份${args.kind ? `（kind=${args.kind}）` : ''}`, {
        data: { filter: { kind: args.kind ?? null }, entries, summary: summarizeEvidenceIndex(index) },
        evidence: entries.map((entry) => evidenceRef(entry.kind, entry.path, entry.digest)),
        nextActions: entries.length
          ? ['引用证据时说明 kind/ref/digest；truncated=true 表示只看到一部分，需要时用 kind/digest 下钻']
          : ['没有匹配证据：先运行 cp_validation 生成 ERC/DRC 证据，或换 kind 查询'],
      });
    },
  }));

  tools.push(makeTool({
    name: 'cp_knowledge',
    description: '检索 CircuitPilot 知识库中 approved 的工程知识（带 citation）。只读。只把 approved 条目当依据；candidate 未经审核不能作为门禁/修复依据。可同时返回 RAG 语义检索 citation；RAG 不可用时如实标注。',
    type: 'read',
    inputSchema: objectSchema({
      query: stringField('检索关键词/问题；为空则列出 approved 条目。', { maxLength: 500 }),
      kind: stringField('知识 kind 过滤。', { maxLength: 100 }),
      trust: stringField('可信等级过滤（如 high/medium/low，以 Runtime 枚举为准）。', { maxLength: 50 }),
      limit: numberField('最多返回条数，默认 10，上限 30。', { minimum: 1, maximum: 30 }),
    }),
    async handler(args, { signal }) {
      const limit = args.limit ?? 10;
      const entriesEnv = await call('GET', '/api/knowledge/entries', {
        query: { reviewState: 'approved', kind: args.kind, trust: args.trust, text: args.query, includeExpired: 'false' },
        signal,
      });
      if (!entriesEnv.ok) return failResult(entriesEnv.code, entriesEnv.message, { nextActions: entriesEnv.nextActions });
      const rawEntries = Array.isArray(entriesEnv.data?.knowledge)
        ? entriesEnv.data.knowledge
        : (Array.isArray(entriesEnv.data?.entries) ? entriesEnv.data.entries : []);
      const entries = rawEntries.slice(0, limit).map((entry) => ({
        id: entry.id ?? null,
        kind: entry.kind ?? null,
        title: entry.title ?? null,
        trust: entry.trust ?? null,
        reviewState: entry.review?.state ?? entry.reviewState ?? null,
        digest: entry.digest ?? null,
        updatedAt: entry.updatedAt ?? null,
        expiresAt: entry.expiresAt ?? null,
      }));
      let rag = null;
      let ragError = null;
      if (args.query) {
        const ragEnv = await call('POST', '/api/rag/query', {
          body: { query: args.query, topK: limit, ...(args.kind ? { kinds: [args.kind] } : {}) },
          signal,
        });
        if (ragEnv.ok) {
          const results = Array.isArray(ragEnv.data?.rag?.results) ? ragEnv.data.rag.results : [];
          rag = results.slice(0, limit).map((item) => ({
            id: item.id ?? null,
            title: item.title ?? null,
            kind: item.kind ?? null,
            score: typeof item.score === 'number' ? Math.round(item.score * 1000) / 1000 : null,
            reviewState: item.reviewState ?? item.review?.state ?? null,
          }));
        } else {
          ragError = { code: ragEnv.code, message: ragEnv.message };
        }
      }
      const citations = entries.map((entry) => evidenceRef('knowledge', `knowledge:${entry.id ?? entry.digest ?? 'unknown'}`, entry.digest));
      return okResult(
        `approved 知识 ${entries.length} 条${rag ? `；RAG citation ${rag.length} 条` : ''}${ragError ? '；RAG 不可用（已标注）' : ''}`,
        {
          data: { query: args.query ?? null, approvedEntries: entries, ragCitations: rag, ragError },
          evidence: citations,
          nextActions: entries.length || rag?.length
            ? ['引用知识时必须带 citation（id/digest 与 title）；candidate 条目不能当依据', '把知识与当前项目证据（cp_evidence）交叉验证，不要仅凭知识断言通过']
            : ['没有匹配的 approved 知识；不要伪造引用，必要时让用户审核知识条目'],
        },
      );
    },
  }));

  /* ---------------- plan ---------------- */

  tools.push(makeTool({
    name: 'cp_design_plan',
    description: '生成/规范化原理图设计计划（只出计划，不执行、不批准）。两种输入：mode=normalize 传 plan 对象；mode=ai 传 requirements 让 Runtime AI 生成候选计划。返回 planHash、ready、missing、风险/假设；必须先把计划给用户看，用户明确批准后才能调用 cp_approve。',
    type: 'plan',
    inputSchema: objectSchema({
      mode: { type: 'string', enum: ['auto', 'normalize', 'ai'], description: 'auto（默认）：有 plan 用 normalize，否则用 ai。' },
      plan: { type: 'object', description: '结构化设计计划（Runtime /api/design/plan 的 body.plan）。', additionalProperties: true },
      requirements: stringField('自然语言需求（mode=ai 时必填）。', { maxLength: 4000 }),
      title: stringField('计划标题（可选）。', { maxLength: 200 }),
      requestApproval: booleanField('是否登记“计划级 UI 审批请求”（默认 false）。仅 ready 且用户希望在 UI 审批时使用；UI 批准不签发 token，之后仍需 cp_approve。'),
    }),
    async handler(args, { signal }) {
      const mode = args.mode === 'normalize' || args.mode === 'ai'
        ? args.mode
        : (isPlainObject(args.plan) ? 'normalize' : 'ai');
      let env;
      if (mode === 'normalize') {
        if (!isPlainObject(args.plan)) {
          return failResult('INVALID_ARGUMENTS', 'mode=normalize 需要提供 plan 对象', { nextActions: ['提供结构化 plan，或改用 mode=ai + requirements'] });
        }
        env = await call('POST', '/api/design/plan', { body: { plan: args.plan }, signal });
      } else {
        const requirements = String(args.requirements ?? '').trim();
        if (!requirements) {
          return failResult('INVALID_ARGUMENTS', 'mode=ai 需要提供 requirements（自然语言需求）', { nextActions: ['提供需求描述，或改用 mode=normalize + plan'] });
        }
        env = await call('POST', '/api/design/plan/ai', {
          body: { requirement: requirements, context: { requirement: requirements, notes: args.title ?? undefined } },
          signal,
        });
      }
      if (!env.ok) return failResult(env.code, env.message, { nextActions: env.nextActions });
      const planning = env.data?.planning ?? env.data ?? {};
      const plan = planning.plan ?? null;
      const planHash = typeof planning.planHash === 'string' ? planning.planHash : '';
      if (!planHash) {
        return failResult('PLAN_HASH_MISSING', 'Runtime 没有返回 planHash，无法安全绑定批准', {
          nextActions: ['检查 Runtime 版本是否支持 /api/design/plan', '没有 planHash 不允许进入批准/执行流程'],
        });
      }
      storePlan('design', plan, planHash);
      const missing = Array.isArray(planning.missing) ? planning.missing : [];
      const ready = planning.ready === true;
      const counts = {
        blocks: isPlainObject(plan?.blocks) ? Object.keys(plan.blocks).length : null,
        nets: Array.isArray(plan?.nets) ? plan.nets.length : null,
        placements: Array.isArray(plan?.placements) ? plan.placements.length : null,
        operations: Array.isArray(plan?.operations) ? plan.operations.length : null,
        assumptions: Array.isArray(plan?.assumptions) ? plan.assumptions.length : null,
      };
      let approvalRequestId = null;
      let approvalRequestError = null;
      if (args.requestApproval === true && ready) {
        const outcome = await submitPlanApprovalRequest({
          kind: 'design',
          plan,
          planHash,
          ready,
          missing,
          operationCount: counts.operations,
          title: args.title,
          signal,
        });
        if (!outcome.ok) {
          if (outcome.fatal) return failResult(outcome.code, outcome.message, { nextActions: outcome.nextActions });
          approvalRequestError = { code: outcome.code, message: outcome.message };
        } else {
          approvalRequestId = outcome.requestId;
          attachApprovalRequest(planHash, approvalRequestId);
        }
      }
      return okResult(
        `设计计划已生成${ready ? '（ready）' : '（不完整）'}：planHash ${planHash.slice(0, 16)}…；missing ${missing.length} 项；operations ${counts.operations ?? '?'} 个`,
        {
          data: {
            source: mode,
            planHash,
            ready,
            missing,
            counts,
            assumptions: Array.isArray(plan?.assumptions) ? plan.assumptions.slice(0, 10) : [],
            plan,
            ...(ready ? { approvalUrl } : {}),
            ...(approvalRequestId ? { approvalRequestId, planApprovalUrl } : {}),
            ...(approvalRequestError ? { approvalRequestError } : {}),
          },
          nextActions: ready
            ? [
              '把计划（目标/操作数/风险/假设/missing）完整展示给用户，等用户明确说“批准/执行”',
              '用户明确批准后调用 cp_approve({planHash, confirm:true})；不要自行批准或执行',
              approvalUiAction,
              ...(approvalRequestId ? [planApprovalWaitAction] : []),
              ...(approvalRequestError ? [`计划级 UI 审批请求创建失败（${approvalRequestError.code}）：可重试 requestApproval，或让用户使用对话审批（cp_approve + confirm=true）；不要伪造 requestId`] : []),
            ]
            : [
              `计划缺少 ${missing.length} 项：先把 missing 展示给用户并补齐需求/证据`,
              '在 missing 补齐前不要批准或执行该计划',
            ],
        },
      );
    },
  }));

  tools.push(makeTool({
    name: 'cp_pcb_plan',
    description: '生成/规范化 PCB 落板/布局/布线/叠层计划（只出计划，不执行、不批准）。返回 planHash、ready、missing、板参数与操作统计。注意：PCB 写入受嘉立创EDA公开API能力限制，Runtime 执行时会 fail-closed，绝不能承诺“一定写成功”。',
    type: 'plan',
    inputSchema: objectSchema({
      plan: { type: 'object', description: 'PCB 计划（Runtime /api/pcb/plan 的 body.plan）。', additionalProperties: true },
      title: stringField('计划标题（可选，UI 审批请求展示用）。', { maxLength: 200 }),
      requestApproval: booleanField('是否登记“计划级 UI 审批请求”（默认 false）。仅 ready 且用户希望在 UI 审批时使用；UI 批准不签发 token，之后仍需 cp_approve。'),
    }, ['plan']),
    async handler(args, { signal }) {
      if (!isPlainObject(args.plan)) {
        return failResult('INVALID_ARGUMENTS', 'cp_pcb_plan 需要 plan 对象', { nextActions: ['提供 PCB 计划对象（board/operations/expectations）'] });
      }
      const env = await call('POST', '/api/pcb/plan', { body: { plan: args.plan }, signal });
      if (!env.ok) return failResult(env.code, env.message, { nextActions: env.nextActions });
      const planning = env.data?.planning ?? env.data ?? {};
      const plan = planning.plan ?? null;
      const planHash = typeof planning.planHash === 'string' ? planning.planHash : '';
      if (!planHash) {
        return failResult('PLAN_HASH_MISSING', 'Runtime 没有返回 PCB planHash，无法安全绑定批准', { nextActions: ['检查 Runtime 版本是否支持 /api/pcb/plan', '没有 planHash 不允许进入批准/执行流程'] });
      }
      storePlan('pcb', plan, planHash);
      const missing = Array.isArray(planning.missing) ? planning.missing : [];
      const ready = planning.ready === true;
      const operations = Array.isArray(plan?.operations) ? plan.operations : [];
      const operationTypes = {};
      for (const operation of operations) {
        const key = typeof operation?.type === 'string' ? operation.type : 'unknown';
        operationTypes[key] = (operationTypes[key] ?? 0) + 1;
      }
      let approvalRequestId = null;
      let approvalRequestError = null;
      if (args.requestApproval === true && ready) {
        const outcome = await submitPlanApprovalRequest({
          kind: 'pcb',
          plan,
          planHash,
          ready,
          missing,
          operationCount: operations.length,
          title: typeof args.title === 'string' ? args.title : (typeof plan?.title === 'string' ? plan.title : undefined),
          signal,
        });
        if (!outcome.ok) {
          if (outcome.fatal) return failResult(outcome.code, outcome.message, { nextActions: outcome.nextActions });
          approvalRequestError = { code: outcome.code, message: outcome.message };
        } else {
          approvalRequestId = outcome.requestId;
          attachApprovalRequest(planHash, approvalRequestId);
        }
      }
      return okResult(
        `PCB 计划已生成${ready ? '（ready）' : '（不完整）'}：planHash ${planHash.slice(0, 16)}…；operations ${operations.length}；missing ${missing.length} 项`,
        {
          data: {
            planHash,
            ready,
            missing,
            board: plan?.board ?? null,
            expectationDesignators: Array.isArray(plan?.expectations?.designators) ? plan.expectations.designators.length : null,
            counts: { operations: operations.length, operationTypes },
            plan,
            ...(ready ? { approvalUrl } : {}),
            ...(approvalRequestId ? { approvalRequestId, planApprovalUrl } : {}),
            ...(approvalRequestError ? { approvalRequestError } : {}),
          },
          nextActions: ready
            ? [
              '把板参数/操作类型/预期位号/风险展示给用户，等用户明确批准',
              '用户批准后调用 cp_approve({planHash, confirm:true, kind:"pcb"})；不要在未批准时调用 cp_execute',
              '执行前提醒：受 EDA 能力限制，部分操作可能无法落板，Runtime 会如实失败并回滚',
              approvalUiAction,
              ...(approvalRequestId ? [planApprovalWaitAction] : []),
              ...(approvalRequestError ? [`计划级 UI 审批请求创建失败（${approvalRequestError.code}）：可重试 requestApproval，或让用户使用对话审批（cp_approve + confirm=true）；不要伪造 requestId`] : []),
            ]
            : [`计划缺少 ${missing.length} 项：先补齐再批准`, '不要用不完整计划执行 PCB 写入'],
        },
      );
    },
  }));

  /* ---------------- approve ---------------- */

  tools.push(makeTool({
    name: 'cp_approve',
    description: '记录“对话批准”（approvalMode=chat 时可用）：必须提供 planHash 且 confirm=true，且该 planHash 必须是本会话 cp_design_plan/cp_pcb_plan 刚生成、用户已明确看过的计划。调用前必须有用户明确的批准语句；禁止自行批准。返回 approvalId（不返回 approvalToken）。',
    type: 'approve',
    inputSchema: objectSchema({
      planHash: planHashField,
      confirm: confirmField,
      kind: { type: 'string', enum: ['design', 'pcb'], description: '批准类型；缺省时按 planHash 对应的计划类型推断。' },
      note: stringField('批准备注（可选，写入会话侧记录）。', { maxLength: 500 }),
    }, ['planHash', 'confirm']),
    async handler(args, { signal }) {
      if (cfg.approvalMode !== 'chat') {
        return failResult('APPROVAL_MODE_DISABLED', '当前插件 approvalMode 不是 chat，cp_approve 不可用', { nextActions: APPROVE_MODE_HINT });
      }
      if (args.confirm !== true) {
        return failResult('CONFIRM_REQUIRED', 'cp_approve 需要 confirm=true，表示用户已在对话中明确批准该 planHash', {
          nextActions: ['先把计划展示给用户，得到明确批准后再传 confirm:true', '禁止猜测用户意图自动批准'],
        });
      }
      const stored = getPlan(args.planHash);
      if (!stored) {
        return failResult('PLAN_NOT_KNOWN', '这个 planHash 不是本会话刚生成并缓存的计划，无法批准', {
          nextActions: ['先调用 cp_design_plan / cp_pcb_plan 取得 planHash，把计划给用户看', '不要批准来源不明的 planHash'],
        });
      }
      const kind = args.kind === 'design' || args.kind === 'pcb' ? args.kind : stored.kind;
      const contextEnv = kind === 'pcb'
        ? await call('GET', '/api/pcb/context', { signal })
        : await call('GET', '/api/design/context', { signal });
      if (!contextEnv.ok) {
        return failResult(contextEnv.code, contextEnv.message, {
          nextActions: [...(contextEnv.nextActions ?? []), '批准前必须能读取 EDA 目标上下文（windowId/targetFingerprint）；否则无法防止批准 A 写到 B'],
        });
      }
      const context = contextEnv.data?.context ?? {};
      const windowId = context.windowId;
      const targetFingerprint = context.targetFingerprint;
      if (typeof windowId !== 'string' || !windowId || typeof targetFingerprint !== 'string' || !targetFingerprint) {
        return failResult('APPROVAL_CONTEXT_INCOMPLETE', 'EDA 上下文缺少 windowId/targetFingerprint，无法安全批准', {
          nextActions: ['确认 EDA 已打开目标文档且 Bridge 正常；重新读取 cp_status 后再试'],
        });
      }
      const projectId = context.project?.uuid ?? context.projectId ?? null;
      const documentUuid = context.document?.uuid ?? context.document?.documentUuid ?? context.pcb?.document?.uuid ?? null;
      // 带上 planHash/confirm：Runtime 审批审计需要能核对“批准的是哪一份计划 + 用户显式确认”。
      // manager.approve 会忽略未知字段，真正绑定仍由 Runtime 用 normalizePlan(plan).planHash 计算。
      // 计划级 UI 审批（task-40）：本会话登记过 requestId 时自动带上；无则保持旧对话审批请求体不变。
      const approvalRequestRef = stored.approvalRequestId ? { approvalRequestId: stored.approvalRequestId } : {};
      const body = kind === 'pcb'
        ? { plan: stored.plan, planHash: args.planHash, targetFingerprint, windowId, confirm: true, approvalMode: 'chat', ...approvalRequestRef }
        : { plan: stored.plan, planHash: args.planHash, targetFingerprint, windowId, confirm: true, approvalMode: 'chat', projectId, documentUuid, ...approvalRequestRef };
      const route = kind === 'pcb' ? '/api/pcb/approve' : '/api/design/approve';
      const env = await call('POST', route, { body, signal });
      if (!env.ok) {
        const nextActions = [...(env.nextActions ?? [])];
        if (env.code === 'AGENT_ROUTE_FORBIDDEN' || env.status === 403) {
          nextActions.unshift('Runtime 未开放 agent 对话审批路由：请用户在 CircuitPilot UI 批准，或升级 Runtime 后重试');
        }
        if (stored.approvalRequestId && /^PLAN_REQUEST_/.test(String(env.code ?? ''))) {
          nextActions.push(`让用户在 UI 审批该计划请求：${planApprovalUrl}`);
          nextActions.push('UI 批准不签发 token；UI 批准后重新 cp_approve 才会签发；禁止把 UI 批准当执行');
        }
        return failResult(env.code, env.message, { nextActions });
      }
      const approval = env.data?.approval ?? env.data ?? {};
      // Runtime approval-service 的字段是 { approvalId, token, expiresAt, bindings:{planHash,targetFingerprint,windowId,...} }；
      // 设计路由还会把 planHash 平铺到顶层。这里两种形态都接受，并核对绑定，防止批准 A 执行 B。
      const approvalToken = approval.approvalToken ?? approval.token;
      if (typeof approvalToken !== 'string' || !approvalToken) {
        return failResult('APPROVAL_REQUIRED', 'Runtime 没有返回 approvalToken，不能进入执行', {
          nextActions: ['不要执行写操作；检查 Runtime 版本/审批路由是否正常', '没有 approvalToken 时 cp_execute 会拒绝'],
        });
      }
      const bindings = isPlainObject(approval.bindings) ? approval.bindings : {};
      const runtimePlanHash = typeof approval.planHash === 'string' && approval.planHash
        ? approval.planHash
        : (typeof bindings.planHash === 'string' ? bindings.planHash : '');
      if (runtimePlanHash && runtimePlanHash !== args.planHash) {
        return failResult('PLAN_HASH_MISMATCH', 'Runtime 返回的 planHash 与请求不一致，拒绝记录批准', {
          nextActions: ['重新生成计划并重新批准；不要执行 planHash 不一致的批准'],
        });
      }
      if (typeof bindings.targetFingerprint === 'string' && bindings.targetFingerprint && bindings.targetFingerprint !== targetFingerprint) {
        return failResult('APPROVAL_TARGET_MISMATCH', 'Runtime 批准的 EDA 目标指纹与当前上下文不一致，拒绝记录批准', {
          nextActions: ['重新读取上下文、重新生成计划并让用户重新批准', '不要执行目标指纹不一致的批准'],
        });
      }
      if (typeof bindings.windowId === 'string' && bindings.windowId && bindings.windowId !== windowId) {
        return failResult('APPROVAL_TARGET_MISMATCH', 'Runtime 批准的 EDA 窗口与当前上下文不一致，拒绝记录批准', {
          nextActions: ['确认 EDA 目标窗口未变化后再批准'],
        });
      }
      const expiresAtMs = (() => {
        const raw = approval.expiresAt;
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw === 'string' && raw.trim()) {
          const parsed = Date.parse(raw);
          if (Number.isFinite(parsed)) return parsed;
        }
        return clock() + cfg.approvalTtlMs;
      })();
      const approvalId = typeof approval.approvalId === 'string' && approval.approvalId
        ? approval.approvalId
        : createHash('sha256').update(approvalToken).digest('hex').slice(0, 16);
      recordApproval({
        planHash: args.planHash,
        kind,
        plan: stored.plan,
        token: approvalToken, // 仅插件内存；不返回、不写日志
        approvalId,
        targetFingerprint,
        windowId,
        projectId,
        documentUuid,
        expiresAtMs,
        approvedAtMs: clock(),
        note: typeof args.note === 'string' ? args.note : null,
        used: false,
      });
      return okResult(
        `已记录对话批准（${kind}）：approvalId ${approvalId}；planHash ${args.planHash.slice(0, 16)}…；有效至 ${new Date(expiresAtMs).toISOString()}`,
        {
          data: {
            approvalId,
            planHash: args.planHash,
            kind,
            expiresAt: new Date(expiresAtMs).toISOString(),
            targetFingerprint,
            windowId,
            projectId,
            documentUuid,
            confirmation: 'chat',
            approvalTokenExposed: false,
            approvalUrl,
            ...(stored.approvalRequestId ? { approvalRequestId: stored.approvalRequestId } : {}),
          },
          nextActions: [
            '批准只对本次 planHash/目标指纹有效；目标变化或计划变化必须重新批准',
            '用户没有再次明确同意前，不要调用 cp_execute；如需执行，用 cp_execute({planHash, requestId})',
            approvalUiAction,
          ],
        },
      );
    },
  }));

  /* ---------------- execute ---------------- */

  tools.push(makeTool({
    name: 'cp_execute',
    description: '执行已获对话批准的计划（approvalMode=chat）。必须提供 planHash + 唯一 requestId；没有对应批准、批准已用/已过期、或 planHash 不匹配时直接拒绝。返回 jobId（异步执行），用 cp_job 查询；同 requestId 幂等，绝不重复执行。执行使用插件内存里的计划与 approvalToken，模型不能替换计划。',
    type: 'execute',
    inputSchema: objectSchema({
      planHash: planHashField,
      requestId: requestIdField,
      note: stringField('执行备注（可选）。', { maxLength: 500 }),
    }, ['planHash', 'requestId']),
    async handler(args) {
      const deduped = manager.find(args.requestId);
      if (deduped) {
        return okResult(`requestId 已存在：返回同一 job（${deduped.jobId}），不会重复执行`, {
          data: jobHandle(deduped, { deduped: true }),
          nextActions: ['用 cp_job{action:"wait", jobId} 查看结果；不要换 requestId 重复提交同一操作'],
        });
      }
      if (cfg.approvalMode !== 'chat') {
        return failResult('APPROVAL_MODE_DISABLED', '当前插件 approvalMode 不是 chat，不能执行写操作', { nextActions: APPROVE_MODE_HINT });
      }
      const approval = getApproval(args.planHash);
      if (!approval) {
        return failResult('APPROVAL_REQUIRED', '没有找到该 planHash 的对话批准，拒绝执行', {
          nextActions: ['先把计划给用户看，得到明确批准后调用 cp_approve({planHash, confirm:true})', '禁止绕过批准执行写操作'],
        });
      }
      if (approval.used) {
        return failResult('APPROVAL_REQUIRED', '该批准已被使用；Runtime 批准令牌是一次性的', {
          nextActions: ['如需再次执行，请用户重新确认并重新调用 cp_approve', '换新的 requestId；不要复用已用批准'],
        });
      }
      if (clock() >= approval.expiresAtMs) {
        return failResult('APPROVAL_EXPIRED', '该批准已过期', {
          nextActions: ['重新读取计划/上下文，让用户重新批准', '过期批准不能执行'],
        });
      }
      const route = approval.kind === 'pcb' ? '/api/pcb/execute' : '/api/design/execute';
      const executeBody = approval.kind === 'pcb'
        ? {
          plan: approval.plan,
          approvalToken: approval.token,
          targetFingerprint: approval.targetFingerprint,
          windowId: approval.windowId,
        }
        : {
          plan: approval.plan,
          approvalToken: approval.token,
          targetFingerprint: approval.targetFingerprint,
          windowId: approval.windowId,
          ...(approval.projectId ? { projectId: approval.projectId } : {}),
          ...(approval.documentUuid ? { documentUuid: approval.documentUuid } : {}),
        };
      const job = manager.start(`${approval.kind}.execute`, args.requestId, async ({ signal }) => {
        const env = await call('POST', route, { body: executeBody, signal });
        if (!env.ok) {
          return capResult(failResult(env.code, env.message, {
            nextActions: env.nextActions,
            data: { route, kind: approval.kind },
          }), cfg.maxResultBytes);
        }
        const execution = env.data?.execution ?? env.data;
        const summary = summarizeExecution(approval.kind, execution);
        const ref = approval.kind === 'pcb'
          ? `/api/pcb/executions/${encodeURIComponent(String(summary.id ?? 'unknown'))}`
          : `/api/design/executions/${encodeURIComponent(String(summary.id ?? 'unknown'))}`;
        return capResult(okResult(
          `执行完成：${summary.id ?? '(无 id)'}（${summary.state ?? 'unknown'}）`,
          {
            data: { execution: summary },
            evidence: [evidenceRef(`${approval.kind}-execution`, ref, summary.planHash ?? summary.id)],
            nextActions: [
              '核对执行状态与回读结果；必要时用 cp_evidence 查执行证据',
              '若 state 不是 completed/success，把错误与证据报告给用户，不要自动重试写操作',
            ],
          },
        ), cfg.maxResultBytes);
      }, { timeoutMs: cfg.jobTimeoutMs, mayHaveTakenEffect: true, label: `execute ${approval.kind} plan` });
      approval.used = true;
      approval.usedAtMs = clock();
      approval.usedByRequestId = args.requestId;
      return okResult(`已提交${approval.kind === 'pcb' ? ' PCB ' : '原理图'}执行任务（jobId ${job.jobId}）`, {
        data: { ...jobHandle(job), planHash: args.planHash, approvalId: approval.approvalId, kind: approval.kind },
        nextActions: [
          '用 cp_job{action:"wait", jobId} 等待并读取结果；长任务不要重复提交',
          '同 requestId 重复调用返回同一 job；需要重试必须重新批准并换 requestId',
        ],
      });
    },
  }));

  tools.push(makeTool({
    name: 'cp_validation',
    description: '运行官方 ERC / PCB DRC / 六门门禁评估并返回摘要+证据引用（execute 类长任务）。必须带 requestId；同 requestId 幂等。支持单板（pcbUuid/schematicUuid）或批量模式 boards（最多 3 块板，按顺序逐板执行，单板失败不拖垮整批；ERC 只用该板 schematicUuid，缺失即该板失败，绝不回退当前原理图）。DRC 是异步 job，工具内部轮询但不会自动重试失败任务。不写 EDA；但会运行 EDA 检查并归档门禁报告。',
    type: 'execute',
    inputSchema: objectSchema({
      requestId: requestIdField,
      targets: {
        type: 'array',
        description: '要运行的目标，默认 ["erc","drc","gates"]。',
        items: { type: 'string', enum: ['erc', 'drc', 'gates'] },
        maxItems: 3,
      },
      pcbUuid: stringField('PCB 文档 uuid（单板模式；与 boards 互斥）。', { maxLength: 200 }),
      schematicUuid: stringField('原理图 uuid（单板模式；与 boards 互斥）。', { maxLength: 200 }),
      boards: {
        type: 'array',
        description: '批量模式：最多 3 块板，按顺序逐板执行 targets；每项 {pcbUuid 必填, schematicUuid?}。与 pcbUuid/schematicUuid 互斥。',
        maxItems: 3,
        items: {
          type: 'object',
          required: ['pcbUuid'],
          properties: {
            pcbUuid: stringField('该板 PCB 文档 uuid（DRC/gates 用它，必填）。', { maxLength: 200 }),
            schematicUuid: stringField('该板原理图 uuid；targets 含 erc 时必填，缺失则整板失败 SCHEMATIC_UUID_REQUIRED（不回退当前原理图）。', { maxLength: 200 }),
          },
        },
      },
    }, ['requestId']),
    async handler(args) {
      const deduped = manager.find(args.requestId);
      if (deduped) {
        return okResult(`requestId 已存在：返回同一 validation job（${deduped.jobId}）`, {
          data: jobHandle(deduped, { deduped: true }),
          nextActions: ['用 cp_job{action:"wait", jobId} 查看结果；不要重复提交'],
        });
      }
      const usingBoards = args.boards !== undefined;
      const usingSingle = args.pcbUuid !== undefined || args.schematicUuid !== undefined;
      if (usingBoards && usingSingle) {
        return failResult('INVALID_ARGUMENTS', 'boards 与 pcbUuid/schematicUuid 互斥：批量模式不能再给单板参数', {
          nextActions: ['二选一：要么传 boards 数组（最多 3 块），要么传单个 pcbUuid/schematicUuid'],
        });
      }
      const targets = Array.isArray(args.targets) && args.targets.length
        ? [...new Set(args.targets.filter((item) => ['erc', 'drc', 'gates'].includes(item)))]
        : ['erc', 'drc', 'gates'];
      if (!targets.length) {
        return failResult('INVALID_ARGUMENTS', 'targets 必须包含 erc/drc/gates 至少一项', { nextActions: ['按 schema 传入 targets'] });
      }
      let batch = null;
      if (usingBoards) {
        batch = normalizeValidationBoards(args.boards);
        if (batch.error) {
          return failResult('INVALID_ARGUMENTS', batch.error, {
            nextActions: ['boards 为非空数组、最多 3 块；每项至少提供 pcbUuid（targets 含 erc 时还要提供该板 schematicUuid）', '同一块板只提交一次（重复 pcbUuid 会按首次出现去重）'],
          });
        }
      }
      const isBatch = batch !== null;
      const job = manager.start('validation.run', args.requestId, async ({ signal }) => {
        if (isBatch) {
          return runBatchValidation({ targets, boards: batch.boards, signal });
        }
        const { results, evidence, failures } = await runValidationTargets({
          targets,
          pcbUuid: args.pcbUuid,
          schematicUuid: args.schematicUuid,
          signal,
          allowCurrentFallback: true,
        });
        const data = { targets, results, failures, requested: targets.length };
        if (failures >= targets.length) {
          return capResult(failResult('VALIDATION_ALL_FAILED', `全部 ${targets.length} 个验证目标失败；不要把失败当通过`, {
            data,
            evidence,
            nextActions: ['检查 EDA/Bridge 是否在线、文档是否选中、写暂停状态', '修复后换新的 requestId 重新运行'],
          }), cfg.maxResultBytes);
        }
        if (failures > 0) {
          return capResult(failResult('VALIDATION_PARTIAL_FAILED', `${failures}/${targets.length} 个验证目标失败；部分结果不可当作通过`, {
            data,
            evidence,
            nextActions: ['先解决失败的目标，再重跑完整验证', '把失败原因与已有证据一起报告给用户，不要下"通过"结论'],
          }), cfg.maxResultBytes);
        }
        return capResult(okResult(
          `验证完成：${targets.join(' / ')}；gates verdict ${results.gates?.verdict ?? 'n/a'}`,
          {
            data,
            evidence,
            nextActions: [
              '把 ERC/DRC 计数、门禁 verdict、证据引用报告给用户',
              '若 DRC/ERC 有 blocking/error，不要批准后续写入或导出；先修复并重新验证',
            ],
          },
        ), cfg.maxResultBytes);
      }, { timeoutMs: cfg.jobTimeoutMs, mayHaveTakenEffect: false, label: isBatch ? 'batch validation' : 'validation run' });

      if (isBatch) {
        const dedupeText = batch.duplicates > 0 ? `，已按 pcbUuid 去重 ${batch.duplicates} 块` : '';
        return okResult(`已提交批量校验任务（jobId ${job.jobId}，${batch.boards.length} 板，targets: ${targets.join(' / ')}${dedupeText}）`, {
          data: jobHandle(job),
          nextActions: [
            '用 cp_job{action:"wait", jobId} 等待；批量按板顺序执行，DRC 逐板轮询',
            '不要重复提交同一 requestId（同 id 返回同一 job）',
            '每板失败会记录在 data.batch.boards[].error；失败板不能当作通过',
          ],
        });
      }
      return okResult(`已提交验证任务（jobId ${job.jobId}，targets: ${targets.join(' / ')}）`, {
        data: jobHandle(job),
        nextActions: ['用 cp_job{action:"wait", jobId} 等待；DRC 是异步任务，工具内部会轮询', '不要重复提交同一 requestId'],
      });
    },
  }));

  tools.push(makeTool({
    name: 'cp_export',
    description: '导出/归档生产文件（execute 类，需显式确认 confirm=true + requestId）。只调用 Runtime /api/production/export，由 Runtime 的放行门禁决定是否允许正式导出；被拒绝时如实返回 blockers，不做任何绕过。',
    type: 'execute',
    inputSchema: objectSchema({
      requestId: requestIdField,
      confirm: confirmField,
      pcbUuid: stringField('PCB 文档 uuid（lineage）。', { maxLength: 200 }),
      planHash: stringField('计划哈希（lineage，可选）。', { maxLength: 256 }),
      semanticPlanHash: stringField('语义计划哈希（可选）。', { maxLength: 256 }),
      compiledPlanHash: stringField('编译计划哈希（可选）。', { maxLength: 256 }),
      executionId: stringField('PCB 执行 id（lineage，可选）。', { maxLength: 200 }),
      projectId: stringField('项目 id（可选）。', { maxLength: 200 }),
      documentId: stringField('文档 id（可选）。', { maxLength: 200 }),
      sourceDigest: stringField('源码摘要（可选）。', { maxLength: 256 }),
      kinds: { type: 'array', items: { type: 'string' }, description: '导出类型（可选，Runtime 默认值）。', maxItems: 20 },
    }, ['requestId', 'confirm']),
    async handler(args) {
      if (args.confirm !== true) {
        return failResult('CONFIRM_REQUIRED', 'cp_export 是写文件操作，必须显式传 confirm=true', {
          nextActions: ['先把导出内容/产物目录告知用户并取得明确同意', '不要自动导出或代替用户签核'],
        });
      }
      const deduped = manager.find(args.requestId);
      if (deduped) {
        return okResult(`requestId 已存在：返回同一 export job（${deduped.jobId}）`, {
          data: jobHandle(deduped, { deduped: true }),
          nextActions: ['用 cp_job{action:"wait", jobId} 查看结果；不要重复导出'],
        });
      }
      const body = {
        confirm: true,
        approvalMode: cfg.approvalMode,
        ...(args.pcbUuid ? { pcbUuid: args.pcbUuid } : {}),
        ...(args.planHash ? { planHash: args.planHash } : {}),
        ...(args.semanticPlanHash ? { semanticPlanHash: args.semanticPlanHash } : {}),
        ...(args.compiledPlanHash ? { compiledPlanHash: args.compiledPlanHash } : {}),
        ...(args.executionId ? { executionId: args.executionId } : {}),
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.documentId ? { documentId: args.documentId } : {}),
        ...(args.sourceDigest ? { sourceDigest: args.sourceDigest } : {}),
        ...(Array.isArray(args.kinds) && args.kinds.length ? { kinds: args.kinds } : {}),
      };
      const job = manager.start('production.export', args.requestId, async ({ signal }) => {
        const env = await call('POST', '/api/production/export', { body, signal });
        if (!env.ok) {
          return capResult(failResult(env.code, env.message, { nextActions: env.nextActions }), cfg.maxResultBytes);
        }
        const summary = summarizeExport(env.data);
        const evidence = summary.final
          ? [evidenceRef('production-export', summary.outDir ?? '/api/production/export', summary.manifestHash)]
          : [];
        if (!summary.exported) {
          const blockers = summary.blockers.length ? summary.blockers : summary.decision?.blockers ?? [];
          return capResult(failResult('EXPORT_BLOCKED', summary.message ?? (blockers.length ? `Runtime 放行门禁拒绝导出（${blockers.join(' / ')}）` : 'Runtime 放行门禁拒绝导出（未写正式文件）'), {
            data: { ...summary, blockers },
            nextActions: ['不要绕过门禁；把 blockers 报告给用户', '先通过 cp_validation 生成证据并完成所需审批，再重新导出'],
          }), cfg.maxResultBytes);
        }
        return capResult(okResult(
          `${summary.final ? '正式导出完成' : '导出完成（draft/非正式）'}：${summary.fileCount} 个文件；manifestHash ${summary.manifestHash ?? 'n/a'}`,
          {
            data: summary,
            evidence,
            nextActions: [
              summary.final ? '正式导出仍需人工签核/下单流程（agent 不得代签）' : '这是 draft/非最终产物：不要当正式交付物',
              '把产物目录与 manifestHash 报告给用户；不要自动下单',
            ],
          },
        ), cfg.maxResultBytes);
      }, { timeoutMs: cfg.jobTimeoutMs, mayHaveTakenEffect: true, label: 'production export' });
      return okResult(`已提交导出任务（jobId ${job.jobId}）`, {
        data: jobHandle(job),
        nextActions: ['用 cp_job{action:"wait", jobId} 等待结果', '导出被门禁拒绝时不要自动重试或绕过'],
      });
    },
  }));

  tools.push(makeTool({
    name: 'cp_job',
    description: '查询/等待/取消插件内长任务（cp_execute / cp_validation / cp_export 返回的 jobId）。action=status|wait|list|cancel。只读任务表；wait 超时只表示"还在跑"，不代表没生效。写任务超时/取消后禁止自动重试。',
    type: 'read',
    inputSchema: objectSchema({
      action: { type: 'string', enum: ['status', 'wait', 'list', 'cancel'], description: '要执行的任务操作。' },
      jobId: stringField('job id（status/wait/cancel 需要，或改用 requestId）。', { maxLength: 200 }),
      requestId: stringField('创建任务时的 requestId（与 jobId 二选一）。', { maxLength: 200 }),
      timeoutMs: numberField('wait 的最长等待毫秒数，默认 30000，上限 300000。', { minimum: 0, maximum: 300000 }),
      limit: numberField('list 返回的最大条数，默认 20，上限 100。', { minimum: 1, maximum: 100 }),
    }, ['action']),
    async handler(args, { signal }) {
      if (args.action === 'list') {
        const jobs = manager.list({ limit: args.limit ?? 20 });
        return okResult(`最近 ${jobs.length} 个任务`, {
          data: { count: jobs.length, jobs },
          nextActions: jobs.length ? ['用 cp_job{action:"status", jobId} 查看单个任务结果'] : ['当前没有任务；执行类工具提交后会返回 jobId'],
        });
      }
      let jobId = typeof args.jobId === 'string' && args.jobId ? args.jobId : null;
      let job = jobId ? manager.get(jobId) : null;
      if (!job && typeof args.requestId === 'string' && args.requestId) {
        job = manager.find(args.requestId);
        jobId = job?.jobId ?? null;
      }
      if (!job || !jobId) {
        return failResult('JOB_NOT_FOUND', '找不到对应 job（插件进程重启后内存任务会丢失）', {
          nextActions: ['用 cp_job{action:"list"} 查看现存任务', 'Runtime 侧的真实执行记录请用 cp_status / cp_evidence 核对；不要盲目重放写操作'],
        });
      }
      if (args.action === 'cancel') {
        const cancelled = manager.cancel(jobId);
        const snapshot = manager.snapshot(jobId);
        return okResult(
          cancelled.cancelled ? `任务 ${jobId} 已标记取消（底层副作用可能已发生）` : `任务 ${jobId} 已结束，无法取消`,
          {
            data: { cancelled: cancelled.cancelled, job: snapshot },
            evidence: Array.isArray(snapshot?.result?.evidence) ? snapshot.result.evidence : [],
            nextActions: cancelled.cancelled
              ? ['不要太快重试：先 cp_status / cp_evidence 核对实际状态', '取消不等于回滚；写操作可能需要人工核查']
              : jobNextActions(snapshot),
          },
        );
      }
      if (args.action === 'status') {
        const snapshot = manager.snapshot(jobId);
        return okResult(`任务 ${jobId}：${jobStateText(snapshot?.state)}`, {
          data: { job: snapshot },
          evidence: Array.isArray(snapshot?.result?.evidence) ? snapshot.result.evidence : [],
          nextActions: jobNextActions(snapshot),
        });
      }
      // wait
      const waitTimeout = Math.min(300_000, Number.isFinite(args.timeoutMs) ? Math.max(0, Math.floor(args.timeoutMs)) : 30_000);
      const waited = await manager.wait(jobId, { timeoutMs: waitTimeout, signal });
      if (!waited.found) {
        return failResult('JOB_NOT_FOUND', '等待时找不到对应 job', { nextActions: ['用 cp_job{action:"list"} 查看现存任务'] });
      }
      const snapshot = waited.job;
      return okResult(
        waited.timedOut
          ? `等待 ${waitTimeout}ms 超时：任务 ${jobId} 仍在${jobStateText(snapshot?.state)}；超时不代表未生效`
          : `任务 ${jobId}：${jobStateText(snapshot?.state)}`,
        {
          data: { timedOut: waited.timedOut === true, aborted: waited.aborted === true, job: snapshot },
          evidence: Array.isArray(snapshot?.result?.evidence) ? snapshot.result.evidence : [],
          nextActions: waited.timedOut
            ? ['任务仍在运行；不要重复写，稍后再 cp_job wait 或 status', ...jobNextActions(snapshot)]
            : jobNextActions(snapshot),
        },
      );
    },
  }));

  return tools;
}

export { JobManager, RuntimeClient };
