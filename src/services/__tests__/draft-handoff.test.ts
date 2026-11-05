import { beforeEach, describe, expect, it } from 'vitest';
import {
  DRAFT_MAX_AGE_MS,
  clearSchematicPlanDraft,
  clearSemanticPlanDraft,
  readSchematicPlanDraft,
  readSemanticPlanDraft,
  saveSchematicPlanDraft,
  saveSemanticPlanDraft,
} from '../draftStore';

/**
 * UI P2-5（2026-11-05 审计）：草稿交接必须校验项目归属与时效。
 * 修复前 sessionStorage 里的计划草稿没有项目绑定也不会过期：切到别的项目后，
 * 上一个项目的计划仍会被 EDA 页当作待批准计划载入。这些用例锁住"跨项目/过期一律忽略并清理"。
 */
const semantic = (projectId?: string) => saveSemanticPlanDraft({
  plan: { title: '板A', board: { widthMm: 45 } },
  planHash: 'a'.repeat(16),
  explanation: '计划候选已生成',
  source: 'ai-page',
  ...(projectId ? { projectId } : {}),
});

describe('语义计划草稿：项目绑定与时效', () => {
  beforeEach(() => { clearSemanticPlanDraft(); clearSchematicPlanDraft(); });

  it('同项目、24h 内的草稿可读取，并保留 projectId 供追溯', () => {
    semantic('proj-a');
    const draft = readSemanticPlanDraft({ activeProjectId: 'proj-a' });
    expect(draft?.planHash).toBe('a'.repeat(16));
    expect(draft?.projectId).toBe('proj-a');
  });

  it('切到别的项目后草稿被忽略并清理（不会把 A 项目计划当 B 项目交接）', () => {
    semantic('proj-a');
    expect(readSemanticPlanDraft({ activeProjectId: 'proj-b' })).toBeNull();
    // 清理后即使切回原项目也读不到：失效草稿不允许"再看一眼又活了"。
    expect(readSemanticPlanDraft({ activeProjectId: 'proj-a' })).toBeNull();
  });

  it('超过 24h 的草稿被忽略（注入 now 模拟隔天打开页面）', () => {
    semantic('proj-a');
    expect(readSemanticPlanDraft({ activeProjectId: 'proj-a', now: Date.now() + DRAFT_MAX_AGE_MS + 1000 })).toBeNull();
    expect(readSemanticPlanDraft({ activeProjectId: 'proj-a' })).toBeNull();
  });

  it('createdAt 不可解析时按不可用处理（fail-closed，而不是当新草稿用）', () => {
    sessionStorage.setItem('circuitpilot.semantic-plan-draft', JSON.stringify({
      plan: { title: 'x' }, planHash: 'b'.repeat(16), explanation: 'e', source: 'ai-page', createdAt: 'not-a-date',
    }));
    expect(readSemanticPlanDraft()).toBeNull();
  });

  it('旧草稿没有 projectId 时保持向后兼容（仍受 24h 时效约束）', () => {
    semantic();
    expect(readSemanticPlanDraft({ activeProjectId: 'proj-a' })?.planHash).toBe('a'.repeat(16));
  });

  it('读取方没有指定当前项目时不做归属校验（避免把可用草稿误清掉）', () => {
    semantic('proj-a');
    expect(readSemanticPlanDraft()?.projectId).toBe('proj-a');
  });
});

describe('原理图计划草稿：项目绑定与时效', () => {
  beforeEach(() => { clearSchematicPlanDraft(); });

  const schematic = (projectId?: string) => saveSchematicPlanDraft({
    plan: { kind: 'reviewed-netlist', title: '选型计划' },
    planHash: 'f'.repeat(16),
    sourceLabel: '选型提案 abc123',
    source: 'part-proposal',
    ...(projectId ? { projectId } : {}),
  });

  it('同项目草稿可读取', () => {
    schematic('proj-a');
    expect(readSchematicPlanDraft({ activeProjectId: 'proj-a' })?.sourceLabel).toBe('选型提案 abc123');
  });

  it('跨项目草稿被忽略并清理', () => {
    schematic('proj-a');
    expect(readSchematicPlanDraft({ activeProjectId: 'proj-b' })).toBeNull();
    expect(readSchematicPlanDraft({ activeProjectId: 'proj-a' })).toBeNull();
  });

  it('过期草稿被忽略', () => {
    schematic('proj-a');
    expect(readSchematicPlanDraft({ activeProjectId: 'proj-a', now: Date.now() + DRAFT_MAX_AGE_MS + 1 })).toBeNull();
  });
});
