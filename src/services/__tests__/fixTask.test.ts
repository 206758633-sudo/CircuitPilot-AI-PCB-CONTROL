import { describe, expect, it } from 'vitest';
import type { IssueRecord } from '../../types';
import { buildFixTaskDraft, buildFixTaskFromFailure } from '../fixTask';

const issue: IssueRecord = {
  id: 'issue-123',
  fingerprint: 'eda:EXEC_FAIL',
  source: 'eda',
  severity: 'error',
  status: 'open',
  code: 'AUTOMATION_FAILED',
  summary: '自动化执行未成功',
  detail: '第 2 步读回不符',
  suggestedAction: '查看 journal 的 rollback.step 再重试',
  firstOccurredAt: '2026-10-19T12:00:00Z',
  lastOccurredAt: '2026-10-19T12:00:00Z',
  occurrences: 1,
  context: { runId: 'run-1' },
  handling: [],
};

describe('D4 问题 → 修复任务草稿', () => {
  it('目标包含 code/摘要/详情/建议，默认只读且不伪造计划', () => {
    const task = buildFixTaskDraft(issue, new Date('2026-10-19T12:34:56Z'));
    expect(task.goal).toContain('AUTOMATION_FAILED');
    expect(task.goal).toContain('自动化执行未成功');
    expect(task.goal).toContain('第 2 步读回不符');
    expect(task.goal).toContain('查看 journal 的 rollback.step');
    expect(task.mode).toBe('read_only');
    expect(task.status).toBe('draft');
    expect(task.planHash).toBe('');
    expect(task.steps).toEqual([]);
    expect(task.progress).toBe(0);
  });

  it('证据回溯到问题 ID，并显式标注未知与风险', () => {
    const task = buildFixTaskDraft(issue);
    expect(task.evidence).toContain('issue:issue-123');
    expect(task.scope).toEqual(['eda']);
    expect(task.unknowns.length).toBeGreaterThan(0);
    expect(task.risks.length).toBeGreaterThan(0);
    expect(task.risks.join(' ')).toMatch(/只读/);
  });

  it('没有建议时用安全的默认下一步，不编造修复动作', () => {
    const task = buildFixTaskDraft({ ...issue, suggestedAction: undefined });
    expect(task.goal).toContain('先只读复现并确认根因');
  });
});

describe('A13 ERC 建议 → 修复任务草稿', () => {
  it('保留 ERC 证据与验证方法，默认只读', () => {
    const task = buildFixTaskFromFailure({
      code: 'ERC_PIN_FLOATING',
      summary: '引脚悬空（对象 U1.7）',
      detail: 'Pin U1.7 is floating',
      suggestedAction: '确认悬空引脚：补线或加 noConnect；验证：重跑 ERC',
      source: 'validation',
      evidence: ['erc:erc-abc', 'erc-digest:digest-1'],
    }, new Date('2026-10-19T12:00:00Z'));
    expect(task.mode).toBe('read_only');
    expect(task.scope).toEqual(['validation']);
    expect(task.evidence).toEqual(['erc:erc-abc', 'erc-digest:digest-1']);
    expect(task.goal).toContain('ERC_PIN_FLOATING');
    expect(task.goal).toContain('重跑 ERC');
  });
});
