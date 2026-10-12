import type { AiTask, EdaState, SettingsState } from '../types';

/**
 * 受控写入的统一执行门禁。
 *
 * 这是 UI 唯一的权威写门禁：原理图/PCB 受控流水线、AI 对话驱动的 PCB 执行都必须先通过它，
 * 不再各自复制一份 connected / writePaused / activeWindowId 内联判断。
 *
 * 门禁事实由调用方从真实生产状态推导，规则本身保持与 Runtime 侧一致的五条：
 *   1. 计划已被人工批准（原AiTask语义：status === 'approved' | 'failed'；
 *      受控流水线语义：一次性批准令牌已签发 / 用户在最终确认框中确认了 ready+complete 的计划）；
 *   2. 至少有一个可执行步骤（原AiTask语义：已勾选步骤；流水线语义：计划中至少有一个操作）；
 *   3. EDA 桥接已连接；
 *   4. 全局与会话写入均未暂停；
 *   5. 已选定目标 EDA 窗口。
 *
 * 说明：旧版本该模块只服务于演示用的 AiTask 状态机，从未被生产代码引用。
 * 现已改为真实执行路径共用的门禁；AiTask 的“计划是否已批准/是否有可执行步骤”由调用方
 * 映射为下面的 ExecutionGateSubject，避免继续保留一套无人使用的任务状态机。
 */
export interface ExecutionGateSubject {
  /** 计划是否已被人工批准；未批准时禁止任何写入。 */
  planApproved: boolean;
  /** 将被写入的计划步骤数，必须至少 1。 */
  executableStepCount: number;
}

export interface ExecutionGateResult {
  allowed: boolean;
  reason: string;
}

export function getExecutionGate(subject: ExecutionGateSubject, eda: EdaState, settings: SettingsState): ExecutionGateResult {
  if (!subject.planApproved) return { allowed: false, reason: '必须先批准当前计划哈希' };
  if (subject.executableStepCount < 1) return { allowed: false, reason: '没有已选择的计划步骤' };
  if (!eda.connected) return { allowed: false, reason: 'EDA桥接未连接' };
  if (eda.writePaused || settings.writePaused) return { allowed: false, reason: '全局写入已暂停' };
  if (!eda.activeWindowId) return { allowed: false, reason: '尚未选定目标EDA窗口' };
  return { allowed: true, reason: '' };
}

/** 统计受控计划里真正会被执行的操作数；门禁据此判断“是否有可执行步骤”。 */
export function countPlanOperations(plan: Record<string, unknown> | null | undefined): number {
  return Array.isArray(plan?.operations) ? plan.operations.length : 0;
}

/**
 * 计划范围或哈希变化时使原有批准失效：回到待审状态、清空进度与错误、重置步骤为待执行。
 * 任何“重新生成/修改计划”的生产路径都必须调用它，否则旧批准会被静默复用到新计划上。
 * 若调用方已算出新的计划哈希，则以新哈希为准（新哈希本身就是未批准状态）。
 */
export function invalidateTaskApproval(task: AiTask, patch: Partial<AiTask>, timestamp = Date.now()): AiTask {
  return {
    ...task,
    ...patch,
    status: task.steps.length ? 'planned' : 'draft',
    planHash: patch.planHash ?? `invalidated-${timestamp.toString(36)}`,
    progress: 0,
    error: undefined,
    steps: task.steps.map((step) => ({ ...step, status: 'pending' })),
  };
}
