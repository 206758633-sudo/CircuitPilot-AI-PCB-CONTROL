import type { AiTask, EdaState, SettingsState } from '../types';

export const executionStages = [
  { status: 'snapshotting', progress: 8 },
  { status: 'executing', progress: 20 },
  { status: 'reading', progress: 76 },
  { status: 'verifying', progress: 90 },
  { status: 'completed', progress: 100 },
] as const;

export function invalidateTaskApproval(task: AiTask, patch: Partial<AiTask>, timestamp = Date.now()): AiTask {
  return {
    ...task,
    ...patch,
    status: task.steps.length ? 'planned' : 'draft',
    planHash: `invalidated-${timestamp.toString(36)}`,
    progress: 0,
    error: undefined,
    steps: task.steps.map((step) => ({ ...step, status: 'pending' })),
  };
}

export function getExecutionGate(task: AiTask, eda: EdaState, settings: SettingsState) {
  if (task.status !== 'approved' && task.status !== 'failed') return { allowed: false, reason: '必须先批准当前计划哈希' };
  if (!task.steps.some((step) => step.selected)) return { allowed: false, reason: '没有已选择的计划步骤' };
  if (!eda.connected) return { allowed: false, reason: 'EDA桥接未连接' };
  if (eda.writePaused || settings.writePaused) return { allowed: false, reason: '全局写入已暂停' };
  if (!eda.activeWindowId) return { allowed: false, reason: '尚未选定目标EDA窗口' };
  return { allowed: true, reason: '' };
}
