import { describe, expect, it } from 'vitest';
import { createSeedState } from '../../data/seed';
import { getExecutionGate, invalidateTaskApproval } from '../taskMachine';

describe('AI task approval and execution gates', () => {
  it('invalidates an approved plan when scope changes', () => {
    const state = createSeedState();
    const task = { ...state.task, status: 'approved' as const, steps: [{ id: 's1', title: 'step', description: 'desc', affected: ['U1'], selected: true, status: 'approved' as const, risk: 'low' as const }] };
    const next = invalidateTaskApproval(task, { scope: ['读取原理图'] }, 1234);
    expect(next.status).toBe('planned');
    expect(next.planHash).not.toBe(task.planHash);
    expect(next.steps[0].status).toBe('pending');
  });

  it('blocks an unapproved task even when EDA is connected', () => {
    const state = createSeedState();
    expect(getExecutionGate(state.task, state.eda, state.settings)).toEqual({ allowed: false, reason: '必须先批准当前计划哈希' });
  });

  it('allows only an approved selected plan with connection, window and write gate', () => {
    const state = createSeedState();
    const task = { ...state.task, status: 'approved' as const, steps: [{ id: 's1', title: 'step', description: 'desc', affected: ['U1'], selected: true, status: 'approved' as const, risk: 'low' as const }] };
    expect(getExecutionGate(task, state.eda, state.settings).allowed).toBe(true);
    expect(getExecutionGate(task, { ...state.eda, activeWindowId: null }, state.settings).reason).toBe('尚未选定目标EDA窗口');
    expect(getExecutionGate(task, state.eda, { ...state.settings, writePaused: true }).reason).toBe('全局写入已暂停');
  });
});
