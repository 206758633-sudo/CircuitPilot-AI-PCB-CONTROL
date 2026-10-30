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
 */
export interface SemanticPlanDraft {
  plan: Record<string, unknown>;
  planHash: string;
  explanation: string;
  source: 'ai-page';
  createdAt: string;
}

const KEY = 'circuitpilot.semantic-plan-draft';
let memory: SemanticPlanDraft | null = null;

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

export function saveSemanticPlanDraft(input: { plan: Record<string, unknown>; planHash: string; explanation: string; source: 'ai-page' }): SemanticPlanDraft {
  const draft: SemanticPlanDraft = { ...input, createdAt: new Date().toISOString() };
  memory = draft;
  try { storage()?.setItem(KEY, JSON.stringify(draft)); } catch { /* 存不下就只保留内存这份，不影响本页交接 */ }
  return draft;
}

export function readSemanticPlanDraft(): SemanticPlanDraft | null {
  if (memory && isDraft(memory)) return memory;
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isDraft(parsed)) return null;
    memory = parsed;
    return parsed;
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
}

const SCHEMATIC_KEY = 'circuitpilot.schematic-plan-draft';
let schematicMemory: SchematicPlanDraft | null = null;

const isSchematicDraft = (value: unknown): value is SchematicPlanDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  return Boolean(draft.plan && typeof draft.plan === 'object' && typeof draft.sourceLabel === 'string');
};

export function saveSchematicPlanDraft(input: { plan: Record<string, unknown>; planHash?: string | null; sourceLabel: string; source: 'part-proposal' }): SchematicPlanDraft {
  const draft: SchematicPlanDraft = { ...input, planHash: input.planHash ?? null, createdAt: new Date().toISOString() };
  schematicMemory = draft;
  try { storage()?.setItem(SCHEMATIC_KEY, JSON.stringify(draft)); } catch { /* 内存兜底 */ }
  return draft;
}

export function readSchematicPlanDraft(): SchematicPlanDraft | null {
  if (schematicMemory && isSchematicDraft(schematicMemory)) return schematicMemory;
  try {
    const raw = storage()?.getItem(SCHEMATIC_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isSchematicDraft(parsed)) return null;
    schematicMemory = parsed;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSchematicPlanDraft(): void {
  schematicMemory = null;
  try { storage()?.removeItem(SCHEMATIC_KEY); } catch { /* 忽略 */ }
}
