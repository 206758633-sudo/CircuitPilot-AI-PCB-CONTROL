/**
 * D4：问题中心 → 修复任务草稿。
 *
 * 失败/问题记录不能只停在"看一眼然后关掉"。这里把问题转成 **只读** 的 AI 任务草稿：
 *   - 目标里带 code/summary/detail/suggestedAction，AI 页不需要人再抄一遍；
 *   - evidence 带 `issue:<id>`，后续执行/批准可回溯到原始证据；
 *   - 默认 mode=read_only、带 unknowns/risks，不允许从问题一键跳到写板。
 */
import type { AiTask, IssueRecord } from '../types';

export function buildFixTaskFromFailure(failure: { code: string; summary: string; detail?: string; suggestedAction?: string; source?: string; evidence?: string[] }, now: Date = new Date()): AiTask {
  const stamp = now.getTime().toString(36);
  const detail = failure.detail ? `详情：${failure.detail}` : '';
  return {
    id: `fix-task-${stamp}`,
    goal: `修复问题 ${failure.code}：${failure.summary}。${detail}建议：${failure.suggestedAction || '先只读复现并确认根因，再生成受控计划。'}`,
    mode: 'read_only',
    scope: [failure.source || 'system'],
    status: 'draft',
    planHash: '',
    evidence: failure.evidence?.length ? failure.evidence : [`failure:${failure.code}`],
    unknowns: ['失败根因需用只读证据确认（日志/截图/运行 ID）'],
    risks: ['未完成只读复现前不得进入受控写入'],
    steps: [],
    alternative: false,
    simulateFailure: false,
    progress: 0,
  };
}

/** 兼容问题中心：IssueRecord → 任务草稿（A13 的 ERC 修复任务复用同一个只读结构）。 */
export function buildFixTaskDraft(issue: IssueRecord, now: Date = new Date()): AiTask {
  return buildFixTaskFromFailure({
    code: issue.code,
    summary: issue.summary,
    detail: issue.detail,
    suggestedAction: issue.suggestedAction,
    source: issue.source,
    evidence: [`issue:${issue.id}`],
  }, now);
}
