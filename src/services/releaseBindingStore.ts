import type { ExecutionHistoryItem } from '../types';

/**
 * UI P2-5（2026-11-05 审计）：`circuitpilot:release-binding` 是 AssetsPage → ValidationPage 的
 * readiness 交接。修复前 ValidationPage 直接 JSON.parse 后无条件信任：切项目后旧交接照样被预填，
 * 隔天再打开页面也照样把过期哈希当作"本次"证据。这里把读取收口成带项目/时效校验的函数，
 * 失效时给出明确原因（而不是静默当没交接，或更糟：静默当真）。
 */
export const RELEASE_HANDOFF_KEY = 'circuitpilot:release-binding';
/** 交接默认最长可用 24h：超过就要求重跑 readiness，避免把旧结论当新证据。 */
export const RELEASE_HANDOFF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ReleaseHandoff {
  manifestHash: string | null;
  binding: Record<string, string> | null;
  savedAt: string | null;
  /** null = 可用；否则是给人看的失效原因（跨项目/过期/时间戳不可信）。 */
  staleReason: string | null;
}

export interface ReleaseHandoffReadOptions {
  /** 当前 App 项目 id：交接若带 projectId（新版写入）就据此校验归属。 */
  activeProjectId?: string | null;
  /** 当前项目绑定的 EDA 工程 uuid：readiness binding.projectId 存的是 EDA 工程 uuid（不是 App 项目 id）。 */
  edaProjectUuid?: string | null;
  maxAgeMs?: number;
  /** 仅测试注入"当前时间"。 */
  now?: number;
}

/** 读取 readiness 交接并校验项目归属/时效；没有交接或结构不可解析时返回 null。 */
export function readReleaseHandoff(options: ReleaseHandoffReadOptions = {}): ReleaseHandoff | null {
  let parsed: unknown;
  try {
    const raw = typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage.getItem(RELEASE_HANDOFF_KEY) : null;
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as { manifestHash?: unknown; binding?: unknown; savedAt?: unknown; projectId?: unknown };
  const binding = record.binding && typeof record.binding === 'object' ? record.binding as Record<string, string> : null;
  const manifestHash = typeof record.manifestHash === 'string' && record.manifestHash ? record.manifestHash : null;
  const savedAt = typeof record.savedAt === 'string' && record.savedAt ? record.savedAt : null;
  const maxAgeMs = options.maxAgeMs ?? RELEASE_HANDOFF_MAX_AGE_MS;
  const now = options.now ?? Date.now();

  let staleReason: string | null = null;
  const handoffProjectId = typeof record.projectId === 'string' && record.projectId ? record.projectId : null;
  if (handoffProjectId && options.activeProjectId && handoffProjectId !== options.activeProjectId) {
    staleReason = 'readiness 交接属于别的项目，请在本项目重跑 readiness 生成新交接。';
  } else if (binding?.projectId && options.edaProjectUuid && binding.projectId !== options.edaProjectUuid) {
    staleReason = 'readiness 交接绑定的 EDA 工程与当前项目不一致，请在本项目重跑 readiness。';
  } else {
    const savedMs = savedAt ? Date.parse(savedAt) : NaN;
    if (!Number.isFinite(savedMs)) {
      staleReason = 'readiness 交接缺少可校验的时间戳，请重跑 readiness。';
    } else if (now - savedMs > maxAgeMs) {
      staleReason = `readiness 交接已超过 ${Math.round(maxAgeMs / 3_600_000)} 小时（保存于 ${savedAt}），请重跑 readiness。`;
    } else if (savedMs - now > 5 * 60_000) {
      staleReason = 'readiness 交接时间戳在未来，无法确认时效，请重跑 readiness。';
    }
  }
  return { manifestHash, binding, savedAt, staleReason };
}


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

/**
 * 2026-11-05 全链闭环审计（交付 P2-1）：这里原本还有一组 `saveReadinessInputs/readReadinessInputs`
 * 的 sessionStorage 读写，但产品内没有任何消费者（只有测试在读），且真实交接走
 * `circuitpilot:release-binding`（AssetsPage 写 → ValidationPage 读）。死存储会让"交接成功"
 * 看起来有两条互相可能不一致的来源，已删除；readiness 输入仍由服务端重算校验。
 */

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
