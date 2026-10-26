import { describe, expect, it } from 'vitest';
import { createSeedState } from '../../data/seed';
import { countPlanOperations, getExecutionGate, invalidateTaskApproval, type ExecutionGateSubject } from '../taskMachine';

const approved: ExecutionGateSubject = { planApproved: true, executableStepCount: 1 };

describe('getExecutionGate', () => {
  const { eda, settings } = createSeedState();

  it('allows execution only when all five conditions hold', () => {
    expect(getExecutionGate(approved, eda, settings)).toEqual({ allowed: true, reason: '' });
  });

  it('blocks when the plan has not been approved', () => {
    expect(getExecutionGate({ ...approved, planApproved: false }, eda, settings)).toEqual({ allowed: false, reason: '必须先批准当前计划哈希' });
  });

  it('blocks when no executable step is selected', () => {
    expect(getExecutionGate({ ...approved, executableStepCount: 0 }, eda, settings)).toEqual({ allowed: false, reason: '没有已选择的计划步骤' });
  });

  it('blocks when the EDA bridge is not connected', () => {
    expect(getExecutionGate(approved, { ...eda, connected: false }, settings)).toEqual({ allowed: false, reason: 'EDA桥接未连接' });
  });

  it('blocks when either the session or the global write pause is active', () => {
    expect(getExecutionGate(approved, { ...eda, writePaused: true }, settings)).toEqual({ allowed: false, reason: '全局写入已暂停' });
    expect(getExecutionGate(approved, eda, { ...settings, writePaused: true })).toEqual({ allowed: false, reason: '全局写入已暂停' });
  });

  it('blocks when no target EDA window has been selected', () => {
    expect(getExecutionGate(approved, { ...eda, activeWindowId: null }, settings)).toEqual({ allowed: false, reason: '尚未选定目标EDA窗口' });
  });
});

describe('countPlanOperations', () => {
  it('counts only real operation entries', () => {
    expect(countPlanOperations({ operations: [{ type: 'pcb.save' }, { type: 'pcb.drc' }] })).toBe(2);
    expect(countPlanOperations({ operations: [] })).toBe(0);
    expect(countPlanOperations({ operations: 'nope' })).toBe(0);
    expect(countPlanOperations({})).toBe(0);
    expect(countPlanOperations(null)).toBe(0);
    expect(countPlanOperations(undefined)).toBe(0);
  });
});

describe('invalidateTaskApproval', () => {
  it('invalidates an approved plan when scope changes', () => {
    const state = createSeedState();
    const task = { ...state.task, status: 'approved' as const, steps: [{ id: 's1', title: 'step', description: 'desc', affected: ['U1'], selected: true, status: 'approved' as const, risk: 'low' as const }] };
    const next = invalidateTaskApproval(task, { scope: ['读取原理图'] }, 1234);
    expect(next.status).toBe('planned');
    expect(next.planHash).not.toBe(task.planHash);
    expect(next.steps[0].status).toBe('pending');
  });

  it('falls back to draft when the plan has no steps left to re-approve', () => {
    const state = createSeedState();
    const next = invalidateTaskApproval({ ...state.task, status: 'approved' }, { goal: '新的目标' }, 99);
    expect(next.status).toBe('draft');
    expect(next.progress).toBe(0);
    expect(next.error).toBeUndefined();
    expect(next.goal).toBe('新的目标');
  });

  it('adopts the freshly computed plan hash instead of the previous approved one', () => {
    const state = createSeedState();
    const next = invalidateTaskApproval({ ...state.task, status: 'approved', planHash: 'approved-hash' }, { planHash: 'recomputed-hash' });
    expect(next.planHash).toBe('recomputed-hash');
    expect(next.status).not.toBe('approved');
  });
});

describe('invalidateTaskApproval 失效上下文', () => {
  it('记录触发器与原因（C4 自动标废要给用户可读解释）', () => {
    const state = createSeedState();
    const task = { ...state.task, status: 'approved' as const, steps: [{ id: 's1', title: 'step', description: 'desc', affected: ['U1'], selected: true, status: 'approved' as const, risk: 'low' as const }] };
    const next = invalidateTaskApproval(task, {}, 1700000000000, { trigger: 'component', reason: '器件清单变化' });
    expect(next.invalidation).toEqual({ trigger: 'component', reason: '器件清单变化', at: new Date(1700000000000).toISOString() });
    expect(next.planHash.startsWith('invalidated-')).toBe(true);
  });
});
