import { describe, expect, it } from 'vitest';
import { pickReadinessPcbExecution, releaseBindingRequestFields } from '../releaseBindingStore';
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
