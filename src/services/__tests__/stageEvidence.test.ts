import { describe, expect, it } from 'vitest';
import { createSeedState } from '../../data/seed';
import type { AppState, EdaWorkspaceBinding, Project, Requirement } from '../../types';
import { applyEvidencePatch, deriveStageEvidence, tryAdvanceProjectStage } from '../stageEvidence';

const workspace: EdaWorkspaceBinding = {
  projectUuid: 'project-uuid-0001',
  boardName: '衣柜助手主板',
  schematicUuid: 'schematic-uuid-0001',
  schematicPageUuid: 'schematic-page-0001',
  pcbUuid: 'pcb-uuid-0001',
  schematicStatus: 'empty',
};

function fixture(): { state: AppState; project: Project } {
  const seed = createSeedState();
  const project: Project = {
    ...seed.projects[0],
    id: 'p1',
    stage: '需求',
    archived: false,
    edaWorkspace: { ...workspace },
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
  const requirement: Requirement = { ...seed.requirements[0], id: 'req-a', status: 'confirmed' };
  const state: AppState = {
    ...seed,
    activeProjectId: 'p1',
    projects: [project],
    requirements: [requirement],
    components: seed.components
      .filter((item) => item.refdes === 'U1' || item.refdes === 'U2')
      .map((item) => ({ ...item, projectId: 'p1', status: 'approved' as const })),
    validations: [{ ...seed.validations.find((item) => item.name === 'DRC')!, status: 'pass', source: undefined }],
    task: { ...seed.task, status: 'draft' },
  };
  return { state, project };
}

describe('D5 阶段证据：fail-closed 推导 + 证据推进阶段', () => {
  it('空证据全部 false：没有执行/回读证据就不推进阶段', () => {
    const { state, project } = fixture();
    const evidence = deriveStageEvidence(state, project);
    expect(evidence.netlistApproved).toBe(false);
    expect(evidence.schematicGenerated).toBe(false);
    expect(evidence.pcbPlaced).toBe(false);
    expect(evidence.drcPassed).toBe(false);
    // 放在「原理图」阶段：下一阶段是 PCB，需要网表批准 + 原理图已生成两件执行证据，当前都没有 → 阻断。
    const atSchematic: Project = { ...project, stage: '原理图' };
    const attempt = tryAdvanceProjectStage({ ...state, projects: [atSchematic] }, atSchematic);
    expect(attempt.advanced).toEqual([]);
    expect(attempt.project.stage).toBe('原理图');
    expect(attempt.blocked.length).toBeGreaterThan(0);
    expect(attempt.blocked.join('；')).toMatch(/网表|原理图已生成/);
  });

  it('原理图执行证据 + 需求/BOM 齐备：允许推进到相邻阶段；缺 DRC 时不再前进', () => {
    const { state, project } = fixture();
    const executedAt = '2026-10-20T01:00:00.000Z';
    const patched = applyEvidencePatch(project, {
      schematicStatus: 'generated',
      schematicExecutedAt: executedAt,
      schematicExecutionId: 'exec-1',
      netlistExecutedAt: executedAt,
      netlistExecutionId: 'exec-1',
    }, executedAt);
    const evidence = deriveStageEvidence({ ...state, projects: [patched] }, patched);
    expect(evidence.schematicGenerated).toBe(true);
    expect(evidence.netlistApproved).toBe(true);
    const attempt = tryAdvanceProjectStage(state, patched);
    // 当前阶段=需求 → 下一阶段=选型：需求/BOM 已齐 → 推进到选型（不是直接跳到原理图/PCB）
    expect(attempt.advanced).toEqual(['选型']);
    expect(attempt.project.stage).toBe('选型');
    // 再推一次：选型 → 原理图 需要需求/BOM，仍应通过（不会一次跳到验证）
    const second = tryAdvanceProjectStage({ ...state, projects: [attempt.project] }, attempt.project);
    expect(second.advanced).toEqual(['原理图']);
    expect(second.project.stage).toBe('原理图');
    // 原理图 → PCB 需要网表批准 + 原理图生成证据（已有）→ 推进到 PCB
    const third = tryAdvanceProjectStage({ ...state, projects: [second.project] }, second.project);
    expect(third.advanced).toEqual(['PCB']);
    // PCB → 验证 需要 pcbPlaced 布局回读证据，当前没有 → 阻断并说明缺什么
    const fourth = tryAdvanceProjectStage({ ...state, projects: [third.project] }, third.project);
    expect(fourth.advanced).toEqual([]);
    expect(fourth.blocked.join('；')).toMatch(/布局/);
  });

  it('布局写回证据只认"执行时间 + 批准 id"同时存在；缺批准 id 视为未验证', () => {
    const { state, project } = fixture();
    const executedAt = '2026-10-20T02:00:00.000Z';
    const onlyTime = applyEvidencePatch(project, { pcbPlacementExecutedAt: executedAt }, executedAt);
    expect(deriveStageEvidence({ ...state, projects: [onlyTime] }, onlyTime).pcbPlaced).toBe(false);
    const full = applyEvidencePatch(project, { pcbPlacementExecutedAt: executedAt, pcbPlacementApprovalId: 'auto-9' }, executedAt);
    expect(deriveStageEvidence({ ...state, projects: [full] }, full).pcbPlaced).toBe(true);
  });

  it('DRC 只认官方报告：Demo/未知来源即使 pass 也不算', () => {
    const { state, project } = fixture();
    const drc = state.validations.find((item) => item.name === 'DRC')!;
    const demo: AppState = { ...state, validations: [{ ...drc, status: 'pass', source: 'demo' as const }] };
    expect(deriveStageEvidence(demo, project).drcPassed).toBe(false);
    const official: AppState = { ...state, validations: [{ ...drc, status: 'pass', source: 'official' as const }] };
    expect(deriveStageEvidence(official, project).drcPassed).toBe(true);
  });

  it('非当前项目不认需求/网表/DRC 证据（多项目隔离下不能借用当前工作集）', () => {
    const { state, project } = fixture();
    const other: Project = { ...project, id: 'p2', stage: '验证' };
    const mixed: AppState = { ...state, projects: [project, other] };
    const evidence = deriveStageEvidence(mixed, other);
    expect(evidence.requirementsConfirmed).toBe(false);
    expect(evidence.netlistApproved).toBe(false);
    expect(evidence.drcPassed).toBe(false);
  });
});
