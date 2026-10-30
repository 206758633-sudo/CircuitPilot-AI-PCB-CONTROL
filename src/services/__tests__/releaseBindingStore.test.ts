import { beforeEach, describe, expect, it } from 'vitest';
import { clearReadinessInputs, pickReadinessPcbExecution, readReadinessInputs, releaseBindingRequestFields, saveReadinessInputs } from '../releaseBindingStore';
import type { ExecutionHistoryItem } from '../../types';

const execution = (overrides: Partial<ExecutionHistoryItem> = {}): ExecutionHistoryItem => ({
  kind: 'pcb',
  id: 'exec-1',
  state: 'completed',
  planHash: 'p'.repeat(16),
  createdAt: '2026-10-20T00:00:00.000Z',
  eventCount: 3,
  drc: { passed: true, findings: 0 },
  ...overrides,
});

describe('P0-7 readiness 输入：真实计划哈希 + 真实执行记录', () => {
  beforeEach(() => clearReadinessInputs());

  it('保存/读回三项真实引用；任一缺失都不返回（不拿 task id 凑）', () => {
    saveReadinessInputs({ semanticPlanHash: 'a'.repeat(16), compiledPlanHash: 'b'.repeat(16), pcbExecutionId: 'exec-1', executionState: 'completed', drcPassed: true });
    const inputs = readReadinessInputs();
    expect(inputs).toMatchObject({ semanticPlanHash: 'a'.repeat(16), compiledPlanHash: 'b'.repeat(16), pcbExecutionId: 'exec-1' });
    expect(inputs?.updatedAt).toBeTruthy();
    sessionStorage.setItem('circuitpilot.release-readiness-inputs', JSON.stringify({ semanticPlanHash: 'a', compiledPlanHash: '', pcbExecutionId: 'x' }));
    expect(readReadinessInputs()).toBeNull();
  });

  it('只挑 completed 且官方 DRC 通过的 PCB 执行记录，并给出精确失败原因', () => {
    const rolled = execution({ id: 'rolled', state: 'rolled_back' });
    const failedDrc = execution({ id: 'drc-fail', drc: { passed: false, findings: 2 } });
    const good = execution({ id: 'good', createdAt: '2026-10-22T00:00:00.000Z' });
    expect(pickReadinessPcbExecution([rolled, failedDrc, good])).toEqual({ execution: good });

    const onlyDrcFail = pickReadinessPcbExecution([failedDrc]);
    expect('error' in onlyDrcFail && onlyDrcFail.error).toMatch(/官方 DRC 未通过/);

    const none = pickReadinessPcbExecution([rolled]);
    expect('error' in none && none.error).toMatch(/没有已完成的 PCB 受控执行记录/);
  });
});

describe('P1-7/P1-8 复审 2026-10-29：放行/导出/归档 binding 请求字段', () => {
  it('把 readiness 交接里的计划/工程/执行/物料标识转成服务端字段', () => {
    const fields = releaseBindingRequestFields({
      manifestHash: 'm'.repeat(64),
      binding: {
        projectId: 'proj-1',
        projectName: 'Demo',
        documentId: 'doc-1',
        sourceDigest: 's'.repeat(64),
        semanticPlanHash: 'p'.repeat(64),
        compiledPlanHash: 'c'.repeat(64),
        executionId: 'exec-1',
      },
    });
    expect(fields).toMatchObject({
      planHash: 'p'.repeat(64),
      semanticPlanHash: 'p'.repeat(64),
      compiledPlanHash: 'c'.repeat(64),
      pcbExecutionId: 'exec-1',
      executionId: 'exec-1',
      projectId: 'proj-1',
      documentId: 'doc-1',
      sourceDigest: 's'.repeat(64),
      manifestHash: 'm'.repeat(64),
    });
    expect(fields.binding).toMatchObject({ semanticPlanHash: 'p'.repeat(64) });
  });

  it('没有交接时返回空对象：不编哈希，让服务端按缺域明确报错', () => {
    expect(releaseBindingRequestFields({ manifestHash: null, binding: null })).toEqual({});
  });

  it('稀疏 binding 只转发已有字段（缺域保持缺失）', () => {
    const fields = releaseBindingRequestFields({ manifestHash: null, binding: { projectId: 'proj-1' } });
    expect(fields).toEqual({ projectId: 'proj-1', binding: { projectId: 'proj-1' } });
    expect(fields.planHash).toBeUndefined();
    expect(fields.manifestHash).toBeUndefined();
  });
});
