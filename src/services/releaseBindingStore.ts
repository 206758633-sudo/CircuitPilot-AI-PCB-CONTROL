import type { ExecutionHistoryItem } from '../types';

/**
 * P0-7：readiness 输入的唯一来源。
 *
 * 修复前 AssetsPage 把 `state.task.planHash` 同时当 semanticPlanHash 与 compiledPlanHash、
 * 把 `state.task.id`（AI 任务 id）当 pcbExecutionId：前者让服务端 `compiled-quality` 恒红，
 * 后者让 `official-pcb-drc` 恒红，而 seed/demo 计划还会直接 404 `PRODUCTION_PLAN_UNKNOWN`。
 *
 * 现在只接受三份真实来源：
 * - semanticPlanHash：Runtime `POST /api/production/plans/compile` 返回的已登记计划哈希；
 * - compiledPlanHash：同一响应里的编译计划哈希（服务端会重新编译比对）；
 * - pcbExecutionId：真实 PCB 受控执行记录 id（`pcbExecutions()` 里 DRC 通过的那条）。
 * 任何一项拿不到就明确报错，不再用 task id / 同一个 hash 冒充。
 */

const STORAGE_KEY = 'circuitpilot.release-readiness-inputs';

export interface ReleaseReadinessInputs {
  semanticPlanHash: string;
  compiledPlanHash: string;
  pcbExecutionId: string;
  executionState?: string;
  drcPassed?: boolean;
  updatedAt: string;
}

export function saveReadinessInputs(inputs: Omit<ReleaseReadinessInputs, 'updatedAt'>): ReleaseReadinessInputs {
  const value: ReleaseReadinessInputs = { ...inputs, updatedAt: new Date().toISOString() };
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* 存储不可用不阻塞流程 */ }
  return value;
}

export function readReadinessInputs(): ReleaseReadinessInputs | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReleaseReadinessInputs>;
    if (typeof parsed.semanticPlanHash !== 'string' || !parsed.semanticPlanHash) return null;
    if (typeof parsed.compiledPlanHash !== 'string' || !parsed.compiledPlanHash) return null;
    if (typeof parsed.pcbExecutionId !== 'string' || !parsed.pcbExecutionId) return null;
    return { ...parsed, updatedAt: parsed.updatedAt || new Date().toISOString() } as ReleaseReadinessInputs;
  } catch { return null; }
}

export function clearReadinessInputs() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * 从真实执行历史挑"可用于 readiness"的 PCB 执行：必须 completed 且官方 DRC 通过。
 * 不允许退而求其次拿最近一条（可能 rolled_back / DRC fail）冒充——那会让 official-pcb-drc 假绿。
 */
/**
 * P1-7/P1-8（复审 2026-10-29）：放行闸门/正式导出/归档共用的 binding 请求字段。
 *
 * 修复前三条请求都缺 planHash/manifestHash：服务端只能看"目录里有没有文件"，
 * 归档还会因稀疏 binding 结构性 400（RELEASE_ARCHIVE_BINDING_INCOMPLETE）。
 * 这里只转发 readiness 交接里的真实值；取不到就不传（服务端会按缺域明确报错，不猜哈希）。
 */
export function releaseBindingRequestFields(handoff: { manifestHash: string | null; binding: Record<string, string> | null }): Record<string, string> {
  const binding = handoff.binding;
  const semanticPlanHash = binding?.semanticPlanHash || null;
  const compiledPlanHash = binding?.compiledPlanHash || null;
  const executionId = binding?.executionId || null;
  return {
    ...(semanticPlanHash ? { planHash: semanticPlanHash, semanticPlanHash } : {}),
    ...(compiledPlanHash ? { compiledPlanHash } : {}),
    ...(executionId ? { pcbExecutionId: executionId, executionId } : {}),
    ...(binding?.projectId ? { projectId: binding.projectId } : {}),
    ...(binding?.documentId ? { documentId: binding.documentId } : {}),
    ...(binding?.sourceDigest ? { sourceDigest: binding.sourceDigest } : {}),
    ...(handoff.manifestHash ? { manifestHash: handoff.manifestHash } : {}),
    ...(binding ? { binding } : {}),
  } as Record<string, string>;
}

export function pickReadinessPcbExecution(executions: ExecutionHistoryItem[]): { execution: ExecutionHistoryItem } | { error: string } {
  const usable = executions.filter((item) => item.state === 'completed' && item.drc?.passed === true);
  // 服务端执行历史按写入顺序返回；同状态时取最近创建的一条（createdAt 可空则保留原顺序）。
  if (usable.length) return { execution: usable.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] };
  const completedWithoutDrc = executions.filter((item) => item.state === 'completed').length;
  if (completedWithoutDrc) return { error: '有已完成的 PCB 执行记录，但官方 DRC 未通过：readiness 的 official-pcb-drc 门禁不能放行，请先修复并重新执行 DRC。' };
  return { error: '没有已完成的 PCB 受控执行记录：先在 EDA 页完成一次 PCB 计划审批与写入（含官方 DRC），readiness 不接受 AI 任务 id 冒充执行记录。' };
}
