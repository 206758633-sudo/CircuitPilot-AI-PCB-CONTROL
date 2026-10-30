/**
 * D5：阶段证据推导与"由证据推进阶段"的单一实现。
 *
 * 此前 `deriveStageEvidence` 埋在 `ProjectsPage.tsx` 里，只有"项目页手动推进"一个消费者；
 * EDA 执行成功后却直接写 `stage='原理图'`（历史行为），绕过证据门禁。这里把两件事收口：
 *   1. `deriveStageEvidence`：所有页面（项目页预检、执行成功后自动推进）都用同一套 fail-closed 规则；
 *   2. `applyEvidencePatch` + `tryAdvanceProjectStage`：证据更新后**只允许相邻正向推进**，缺证据不推进并给出缺失项。
 *
 * 纪律：AppContext 里的证据只是"执行/回读成功"的快照，权威仍是 Runtime 的执行记录、批准账本与官方 DRC 报告；
 * 读不到、无法归属当前项目的一律 false。
 */
import type { AppState, EdaWorkspaceBinding, Project } from '../types';
import {
  evaluateStageAdvance,
  nextStage,
  stageOfProjectStage,
  type Stage,
  type StageEvidence,
} from './stageMachine';

/** 从 AppContext + 项目 EDA 绑定里推导阶段证据；任何无法核验的项都保持 false。 */
export function deriveStageEvidence(state: AppState, project: Project): StageEvidence {
  const isActiveProject = project.id === state.activeProjectId;
  // 需求库当前只保存当前项目的一份，无法归属到其他项目 → 非当前项目不认该证据。
  const requirementsConfirmed = isActiveProject
    && state.requirements.length > 0
    && state.requirements.every((item) => item.status === 'confirmed');
  // 只统计明确归属当前项目的器件；无归属/跨项目器件不能当作本项目 BOM 已批准。
  const components = state.components.filter((item) => item.projectId === project.id);
  const bomApproved = components.length > 0 && components.every((item) => item.status === 'approved');
  const workspace = project.edaWorkspace;
  // 原理图生成：Runtime 原理图执行成功（schematicStatus 由执行成功后写回），两者任一即可但必须有执行证据。
  const schematicGenerated = Boolean(workspace?.schematicStatus === 'generated' && workspace?.schematicExecutedAt);
  /**
   * 网表批准：只认 Runtime 受控原理图执行成功后的回读证据。
   * 审计确认 `state.task.status='approved'` 与 `workspace.netlistExecutionId` 没有真实写入者
   * （前者是 AI 任务状态，不是网表批准），把它们当证据会让「原理图→PCB」永久被阻断或凭伪造状态放行。
   * 原理图受控执行必须先过一次性批准令牌 + 快照 + 回读，因此 `schematicExecutedAt` 是可核验的批准证据。
   */
  const netlistApproved = isActiveProject && Boolean(
    (workspace?.schematicExecutionId && workspace?.schematicExecutedAt)
    || (workspace?.netlistExecutionId && workspace?.netlistExecutedAt)
    || schematicGenerated
  );
  // PCB 布局：只认 R4 写回成功且 A9 复核通过后落下的证据；没证据不猜。
  const pcbPlaced = Boolean(workspace?.pcbPlacementExecutedAt && workspace?.pcbPlacementApprovalId);
  /**
   * DRC：只认"当前项目 + 官方 EDA 报告"的 pass。
   * P0-3 修复前这里 `find` 第一条 DRC 记录且不校验 projectId：Demo/种子 pass、别的项目的 pass
   * 都能推进本项目阶段。现在按 projectId 精确归属；没有官方记录就保持 false。
   */
  const drc = state.validations.find((item) => item.name === 'DRC' && item.source === 'official' && item.projectId === project.id);
  const drcPassed = Boolean(drc && drc.status === 'pass');
  return { requirementsConfirmed, bomApproved, netlistApproved, schematicGenerated, pcbPlaced, drcPassed };
}

/** 把执行/回读成功的证据写回项目 EDA 绑定（不可变，返回新项目对象）。 */
export function applyEvidencePatch(project: Project, patch: Partial<EdaWorkspaceBinding>, updatedAt = new Date().toISOString()): Project {
  return {
    ...project,
    edaWorkspace: { ...(project.edaWorkspace as EdaWorkspaceBinding), ...patch },
    updatedAt,
  };
}

export interface StageAdvanceAttempt {
  project: Project;
  advanced: Stage[];      // 实际推进经过的阶段（通常 0 或 1 个）
  blocked: string[];      // 未推进原因（缺证据/已是终态/阶段未知）
}

/**
 * 证据更新后尝试推进阶段：只允许相邻正向推进，缺证据明确返回缺失项。
 * 不修改传入对象；调用方用返回的 project 去 dispatch UPDATE_PROJECT。
 */
export function tryAdvanceProjectStage(state: AppState, updatedProject: Project): StageAdvanceAttempt {
  const from = stageOfProjectStage(updatedProject.stage);
  if (!from) return { project: updatedProject, advanced: [], blocked: [`阶段「${updatedProject.stage}」不在阶段机定义内`] };
  const to = nextStage(from);
  if (!to) return { project: updatedProject, advanced: [], blocked: [`阶段「${from}」已是终态，无需推进`] };
  const projectedState: AppState = {
    ...state,
    projects: state.projects.map((item) => (item.id === updatedProject.id ? updatedProject : item)),
  };
  const gate = evaluateStageAdvance({ from, to, evidence: deriveStageEvidence(projectedState, updatedProject) });
  if (!gate.allowed) return { project: updatedProject, advanced: [], blocked: gate.blocking };
  return { project: { ...updatedProject, stage: to }, advanced: [to], blocked: [] };
}
