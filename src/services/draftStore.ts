/**
 * 跨页面的"计划草稿"交接。
 *
 * 之前 AI 任务页生成了语义计划，点"进入EDA编译与审批"却只是切页面：
 * EDA 页什么都不知道，用户得从头再生成一次；生成结果只活在某页的 useState 里，
 * 刷新/切页就丢，等于把可复用的工程结论当临时 UI 状态。
 *
 * 这里用 sessionStorage（+ 内存兜底）保存**结构化计划对象**本身，
 * 而不是只传一个哈希或一句说明——下一个页面拿到就能直接编译/审批。
 * 只存会话级：换浏览器标签页/关进程即失效，避免旧计划被静默复用。
 *
 * UI P2-5（2026-11-05 审计）：只靠"会话级"还不够——同一浏览器会话内切换项目后，
 * 上一个项目的计划会原样出现在新项目里，旧计划也不会自己过期。
 * 因此草稿带上 projectId/createdAt，读取时校验项目归属与时效，不可用就**忽略并清理**，
 * 绝不让"别的项目的旧计划"被当成当前项目的待批准计划。
 */
export interface SemanticPlanDraft {
  plan: Record<string, unknown>;
  planHash: string;
  explanation: string;
  source: 'ai-page';
  createdAt: string;
  /** 写入草稿时所属的 App 项目 id（旧草稿没有该字段时跳过项目校验）。 */
  projectId?: string;
}

const KEY = 'circuitpilot.semantic-plan-draft';
let memory: SemanticPlanDraft | null = null;

/** 草稿超过该时长就不再当作可复用交接：工程/需求变化很快，旧计划静默复用比重新生成更危险。 */
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface DraftReadOptions {
  /** 当前项目 id：草稿里的 projectId 与它不一致时视为跨项目交接，忽略并清理。 */
  activeProjectId?: string | null;
  /** 允许的最大草稿年龄（毫秒）；默认 24h。 */
  maxAgeMs?: number;
  /** 仅测试注入"当前时间"。 */
  now?: number;
}

interface DraftMeta {
  projectId?: string;
  createdAt?: string;
}

/**
 * 返回草稿不可用的原因；null 表示可以复用。
 * 跨项目 / 过期 / 时间戳不可解析一律按不可用处理（fail-closed），不猜测"应该还能用"。
 */
function draftStaleReason(draft: DraftMeta, options: DraftReadOptions): 'project' | 'expired' | 'invalid-time' | null {
  // 只有调用方明确给了"当前项目"才做归属校验：没给的读取者（如只想拿草稿做二次确认）保持旧行为，
  // 避免把"调用方不关心项目"误判成"跨项目"而把可用草稿清掉。给了 null（当前无项目）则按跨项目处理。
  if (draft.projectId && options.activeProjectId !== undefined && draft.projectId !== (options.activeProjectId ?? null)) return 'project';
  const createdMs = typeof draft.createdAt === 'string' ? Date.parse(draft.createdAt) : NaN;
  if (!Number.isFinite(createdMs)) return 'invalid-time';
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DRAFT_MAX_AGE_MS;
  if (now - createdMs > maxAgeMs) return 'expired';
  return null;
}

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
};

const isDraft = (value: unknown): value is SemanticPlanDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  return Boolean(draft.plan && typeof draft.plan === 'object' && typeof draft.planHash === 'string' && typeof draft.explanation === 'string');
};

export function saveSemanticPlanDraft(input: { plan: Record<string, unknown>; planHash: string; explanation: string; source: 'ai-page'; projectId?: string | null }): SemanticPlanDraft {
  const { projectId, ...rest } = input;
  const draft: SemanticPlanDraft = { ...rest, createdAt: new Date().toISOString(), ...(projectId ? { projectId } : {}) };
  memory = draft;
  try { storage()?.setItem(KEY, JSON.stringify(draft)); } catch { /* 存不下就只保留内存这份，不影响本页交接 */ }
  return draft;
}

export function readSemanticPlanDraft(options: DraftReadOptions = {}): SemanticPlanDraft | null {
  const evaluate = (draft: SemanticPlanDraft): SemanticPlanDraft | null => {
    if (draftStaleReason(draft, options)) { clearSemanticPlanDraft(); return null; }
    return draft;
  };
  if (memory && isDraft(memory)) return evaluate(memory);
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isDraft(parsed)) return null;
    memory = parsed;
    return evaluate(parsed);
  } catch {
    return null;
  }
}

export function clearSemanticPlanDraft(): void {
  memory = null;
  try { storage()?.removeItem(KEY); } catch { /* 清理失败不影响功能 */ }
}

/**
 * 原理图/网络表计划草稿：器件选型页"送到设计批准"用。
 * 与语义计划草稿分开存：两者的 plan 结构、校验器、审批链不同，混在一个键里迟早互相覆盖。
 */
export interface SchematicPlanDraft {
  plan: Record<string, unknown>;
  planHash: string | null;
  sourceLabel: string;
  source: 'part-proposal';
  createdAt: string;
  /** 写入草稿时所属的 App 项目 id（旧草稿没有该字段时跳过项目校验）。 */
  projectId?: string;
}

const SCHEMATIC_KEY = 'circuitpilot.schematic-plan-draft';
let schematicMemory: SchematicPlanDraft | null = null;

const isSchematicDraft = (value: unknown): value is SchematicPlanDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  return Boolean(draft.plan && typeof draft.plan === 'object' && typeof draft.sourceLabel === 'string');
};

export function saveSchematicPlanDraft(input: { plan: Record<string, unknown>; planHash?: string | null; sourceLabel: string; source: 'part-proposal'; projectId?: string | null }): SchematicPlanDraft {
  const { projectId, ...rest } = input;
  const draft: SchematicPlanDraft = { ...rest, planHash: input.planHash ?? null, createdAt: new Date().toISOString(), ...(projectId ? { projectId } : {}) };
  schematicMemory = draft;
  try { storage()?.setItem(SCHEMATIC_KEY, JSON.stringify(draft)); } catch { /* 内存兜底 */ }
  return draft;
}

export function readSchematicPlanDraft(options: DraftReadOptions = {}): SchematicPlanDraft | null {
  const evaluate = (draft: SchematicPlanDraft): SchematicPlanDraft | null => {
    if (draftStaleReason(draft, options)) { clearSchematicPlanDraft(); return null; }
    return draft;
  };
  if (schematicMemory && isSchematicDraft(schematicMemory)) return evaluate(schematicMemory);
  try {
    const raw = storage()?.getItem(SCHEMATIC_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isSchematicDraft(parsed)) return null;
    schematicMemory = parsed;
    return evaluate(parsed);
  } catch {
    return null;
  }
}

export function clearSchematicPlanDraft(): void {
  schematicMemory = null;
  try { storage()?.removeItem(SCHEMATIC_KEY); } catch { /* 忽略 */ }
}
