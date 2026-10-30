import { useMemo, useState } from 'react';
import { Archive, ArrowRight, FastForward, Link2, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { clearEdaDocumentBinding } from '../services/edaWorkspaceStore';
import {
  STAGE_EVIDENCE_DEFINITIONS,
  STAGE_ORDER,
  evaluateStageAdvance,
  nextStage,
  projectStageValue,
  stageOfProjectStage,
  stageProgress,
  type Stage,
  type StageAdvanceResult,
  type StageEvidence,
} from '../services/stageMachine';
import { deriveStageEvidence } from '../services/stageEvidence';
import type { AppState, Project } from '../types';
import { Button, Field, Panel, Progress, SegmentedTabs, Stat, Badge } from '../components/ui';
import { ConfirmDialog, Drawer, Modal } from '../components/overlays';
import { runtimeClient, type ProjectBindingVerification } from '../services/runtimeClient';

const emptyForm = { name: '', code: '', description: '', rootPath: '', edaProjectPath: '' };

interface StageGateView {
  from: Stage | null;
  to: Stage | null;
  evidence: StageEvidence;
  result: StageAdvanceResult | null;
}

/** 组装项目页展示需要的阶段机视图（纯函数，渲染时直接调用，不产生副作用）。 */
function stageGateView(state: AppState, project: Project): StageGateView {
  const from = stageOfProjectStage(project.stage);
  const to = from ? nextStage(from) : null;
  const evidence = deriveStageEvidence(state, project);
  return {
    from,
    to,
    evidence,
    result: from && to ? evaluateStageAdvance({ from, to, evidence }) : null,
  };
}

export function ProjectsPage() {
  const { state, dispatch, activeProject, requirementCompleteness, openRiskCount, notify, addAudit, recordChange, navigate } = useApp();
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [createOpen, setCreateOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [detailProject, setDetailProject] = useState<Project | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [form, setForm] = useState(emptyForm);
  // C6：EDA 窗口↔项目绑定校验结果（只读；防止在 A 项目页面对 B 项目窗口签发批准）。
  const [binding, setBinding] = useState<ProjectBindingVerification | null>(null);
  const [bindingBusy, setBindingBusy] = useState(false);
  const visible = useMemo(() => state.projects.filter((item) => view === 'archived' ? item.archived : !item.archived), [state.projects, view]);

  const createProject = () => {
    if (!form.name.trim() || !form.code.trim()) return;
    const project: Project = {
      id: `project-${Date.now()}`,
      name: form.name.trim(), code: form.code.trim().toUpperCase(), description: form.description.trim() || '尚未填写项目描述。',
      rootPath: form.rootPath.trim() || '/Demo/LocalProject', edaProjectPath: form.edaProjectPath.trim() || '/Demo/LCEDA-Pro/NewProject.eprj2',
      stage: '概念', archived: false, progress: stageProgress('概念'), updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    };
    dispatch({ type: 'ADD_PROJECT', project });
    addAudit('project', '创建项目', `${project.name} · ${project.code}`, 'success');
    notify('项目已创建', `${project.name} 已设为当前项目。`, 'success');
    setForm(emptyForm); setCreateOpen(false); setView('active');
  };

  const saveProject = () => {
    if (!editProject || !editProject.name.trim() || !editProject.code.trim()) return;
    dispatch({ type: 'UPDATE_PROJECT', project: { ...editProject, updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }) } });
    addAudit('project', '更新项目资料', editProject.name, 'success');
    notify('已保存', '项目资料已更新。', 'success'); setEditProject(null);
  };

  const verifyProjectBinding = async (project: Project) => {
    setBindingBusy(true);
    setBinding(null);
    try {
      const result = await runtimeClient.verifyProjectBinding(project.id);
      setBinding(result);
      if (result.ready) notify('EDA 窗口绑定一致', `当前窗口就是「${project.name}」绑定的工程。`, 'success');
      else notify('EDA 窗口绑定不一致', result.mismatches.join('；') || '项目尚未绑定 EDA 工程', 'warning');
    } catch (error) {
      notify('绑定校验失败', error instanceof Error ? error.message : String(error), 'danger');
    } finally {
      setBindingBusy(false);
    }
  };

  /**
   * D5 阶段推进：先过阶段机证据门禁，缺证据只提示、不 dispatch 阶段。
   *
   * UI 只是提前提示，真正权威是 Runtime 落盘的审批/执行/DRC 证据；成功推进必须写 audit + change，
   * 让“谁在什么时候把项目从哪个阶段推到哪个阶段、依据哪些证据”可回溯。
   */
  const advanceProjectStage = (project: Project) => {
    const gate = stageGateView(state, project);
    if (!gate.from) {
      notify('阶段推进被阻断', `项目阶段「${project.stage}」不在 D5 阶段机定义内；请先修正项目状态，不能猜测推进。`, 'danger');
      addAudit('project', '阶段推进被阻断', `${project.name} · 未知阶段「${project.stage}」`, 'warning');
      return;
    }
    if (!gate.to || !gate.result) {
      notify('阶段推进被阻断', `「${gate.from}」已是终态，没有下一阶段可推进。`, 'warning');
      return;
    }
    if (!gate.result.allowed) {
      // 缺证据/跳级/回退：只提示并写审计，绝不直接 dispatch 项目阶段。
      notify('阶段推进被阻断', gate.result.reason, 'warning');
      addAudit('project', '阶段推进被证据门禁阻断', `${project.name} · ${gate.from} → ${gate.to} · ${gate.result.blocking.join('；')}`, 'warning');
      return;
    }
    const nextProject: Project = {
      ...project,
      // types.ts 的 ProjectStage 仍是旧 5 值；通过 stageMachine 的兼容桥写入 canonical 阶段。
      // 等 Lead 把 ProjectStage 扩成 8 阶段后，这里直接写 gate.to 即可。
      stage: projectStageValue(gate.to),
      updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    };
    dispatch({ type: 'UPDATE_PROJECT', project: nextProject });
    addAudit('project', '推进项目阶段', `${project.name} · ${gate.from} → ${gate.to}`, 'success');
    recordChange({
      source: 'user',
      actor: '本机用户',
      action: 'advance-stage',
      objectType: 'project',
      objectId: project.id,
      summary: `阶段推进 ${gate.from} → ${gate.to}`,
      before: { stage: project.stage },
      after: { stage: gate.to, evidence: gate.evidence },
      reason: `${gate.result.reason}（UI 仅做提示；真正权威是 Runtime 证据）`,
    });
    notify('阶段已推进', `${project.name}：${gate.from} → ${gate.to}`, 'success');
    if (detailProject?.id === project.id) setDetailProject(nextProject);
  };

  const setArchived = (project: Project, archived: boolean) => {
    dispatch({ type: 'ARCHIVE_PROJECT', id: project.id, archived });
    addAudit('project', archived ? '归档项目' : '恢复项目', project.name, 'warning');
    notify(archived ? '项目已归档' : '项目已恢复', `${project.name} 的状态已更新。`, archived ? 'warning' : 'success');
    if (archived && project.id === state.activeProjectId) {
      const fallback = state.projects.find((item) => !item.archived && item.id !== project.id);
      if (fallback) dispatch({ type: 'SET_ACTIVE_PROJECT', id: fallback.id });
    }
  };

  const deleteProject = async (project: Project) => {
    const sessionId = state.projectChats[project.id]?.sessionId;
    if (sessionId) {
      try { await runtimeClient.resetChat(sessionId); } catch { /* App-local deletion remains available while Runtime is offline. */ }
    }
    dispatch({ type: 'DELETE_PROJECT', id: project.id });
    clearEdaDocumentBinding(project.id);
    addAudit('project', '永久删除项目', `${project.name} · ${project.code}（未删除本机或EDA文件）`, 'warning');
    notify('项目已删除', `${project.name} 及其AI会话记忆已从应用内永久删除。`, 'warning');
    if (detailProject?.id === project.id) setDetailProject(null);
  };

  return (
    <>
      <div className="stats-grid stats-grid--4">
        <Stat label="当前阶段" value={activeProject?.stage || '—'} hint={activeProject?.code} tone="info" />
        <Stat label="需求完整度" value={`${requirementCompleteness}%`} hint={`${state.requirements.length} 条受控约束`} tone={requirementCompleteness >= 75 ? 'success' : 'warning'} />
        <Stat label="开放风险" value={openRiskCount} hint="需求冲突 + BOM风险" tone={openRiskCount ? 'warning' : 'success'} />
        <Stat label="最新版本" value={state.versions[0]?.label || '—'} hint={state.versions[0]?.date} />
      </div>

      <Panel className="hero-panel" eyebrow="ACTIVE ENGINEERING CONTEXT" title={activeProject?.name || '尚未选择项目'} actions={<><Button icon={<Pencil size={15} />} onClick={() => activeProject && setEditProject(activeProject)} disabled={!activeProject} title={!activeProject ? '请先创建项目' : undefined}>编辑</Button><Button icon={<FastForward size={15} />} onClick={() => activeProject && advanceProjectStage(activeProject)} disabled={!activeProject || activeProject.archived} title="阶段推进先过证据门禁：缺证据会阻断并说明原因（UI 只是提示，真正权威是 Runtime 证据）">推进阶段</Button><Button variant="primary" icon={<ArrowRight size={15} />} onClick={() => navigate('requirements')}>继续完善约束</Button></>}>
        {activeProject && <div className="project-hero"><div><div className="project-code">{activeProject.code}</div><p>{activeProject.description}</p><div className="path-row"><span>WORKSPACE</span><code>{activeProject.rootPath}</code></div><div className="path-row"><span>EDA PROJECT</span><code>{activeProject.edaProjectPath}</code></div></div><div className="project-progress"><Progress value={stageProgress(activeProject.stage)} label="工程成熟度" /><div className="hero-tags"><Badge tone="info">{activeProject.stage}</Badge><Badge tone={state.eda.connected ? 'success' : 'warning'}>{state.eda.connected ? 'EDA 已连接' : 'EDA 未连接'}</Badge><Badge tone="neutral">本地持久化</Badge></div></div></div>}
      </Panel>

      <Panel eyebrow="PROJECT REGISTRY" title="工程列表" meta="切换项目会改变全局工作上下文" actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>新建项目</Button>}>
        <div className="toolbar"><SegmentedTabs label="项目状态" value={view} onChange={(value) => setView(value as 'active' | 'archived')} items={[{ value: 'active', label: '进行中', count: state.projects.filter((item) => !item.archived).length }, { value: 'archived', label: '已归档', count: state.projects.filter((item) => item.archived).length }]} /></div>
        <div className="project-grid">
          {visible.map((project) => <article className={`project-card ${project.id === state.activeProjectId ? 'is-active' : ''}`} key={project.id}>
            <button type="button" className="project-card__main" onClick={() => setDetailProject(project)} aria-label={`查看${project.name}详情`}><div className="project-card__top"><span className="project-code">{project.code}</span><Badge tone={project.stage === '归档' ? 'neutral' : project.stage === '验证' ? 'success' : 'info'}>{project.stage}</Badge></div><h3>{project.name}</h3><p>{project.description}</p><Progress value={stageProgress(project.stage)} /><div className="project-card__meta"><span>更新 {project.updatedAt}</span><span>{stageProgress(project.stage)}%</span></div></button>
            <div className="project-card__actions">
              {!project.archived && <Button size="sm" variant={project.id === state.activeProjectId ? 'ghost' : 'secondary'} onClick={() => { dispatch({ type: 'SET_ACTIVE_PROJECT', id: project.id }); notify('项目已切换', `当前工作上下文：${project.name}`, 'success'); }} disabled={project.id === state.activeProjectId}>{project.id === state.activeProjectId ? '当前项目' : '设为当前'}</Button>}
              {project.archived ? <Button size="sm" icon={<RotateCcw size={14} />} onClick={() => setArchived(project, false)}>恢复</Button> : <Button size="sm" variant="ghost" icon={<Archive size={14} />} onClick={() => setArchiveTarget(project)} disabled={state.projects.filter((item) => !item.archived).length <= 1} title={state.projects.filter((item) => !item.archived).length <= 1 ? '至少保留一个进行中的项目' : undefined}>归档</Button>}
              <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => setDeleteTarget(project)}>删除</Button>
            </div>
          </article>)}
        </div>
      </Panel>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="创建受控项目" eyebrow="NEW PROJECT" footer={<><Button onClick={() => setCreateOpen(false)}>取消</Button><Button variant="primary" onClick={createProject} disabled={!form.name.trim() || !form.code.trim()}>创建并设为当前</Button></>}>
        <div className="form-grid"><Field label="项目名称" required><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：传感器控制板" /></Field><Field label="项目代号" required><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="SENSOR-A01" /></Field><Field label="项目描述"><textarea className="input textarea" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field><Field label="本地工作目录" hint="Demo 不会访问该路径"><input className="input" value={form.rootPath} onChange={(e) => setForm({ ...form, rootPath: e.target.value })} placeholder="/Users/.../Project" /></Field><Field label="嘉立创EDA工程路径" hint="Demo 不会打开真实工程"><input className="input" value={form.edaProjectPath} onChange={(e) => setForm({ ...form, edaProjectPath: e.target.value })} placeholder="/Demo/.../Project.eprj2" /></Field></div>
      </Modal>

      <Modal open={Boolean(editProject)} onClose={() => setEditProject(null)} title="编辑项目资料" eyebrow="PROJECT METADATA" footer={<><Button onClick={() => setEditProject(null)}>取消</Button><Button variant="primary" onClick={saveProject}>保存更改</Button></>}>
        {editProject && <div className="form-grid"><Field label="项目名称" required><input className="input" value={editProject.name} onChange={(e) => setEditProject({ ...editProject, name: e.target.value })} /></Field><Field label="项目代号" required><input className="input" value={editProject.code} onChange={(e) => setEditProject({ ...editProject, code: e.target.value })} /></Field><Field label="项目描述"><textarea className="input textarea" value={editProject.description} onChange={(e) => setEditProject({ ...editProject, description: e.target.value })} /></Field></div>}
      </Modal>

      <Drawer
        open={Boolean(detailProject)}
        onClose={() => setDetailProject(null)}
        title={detailProject?.name || '项目详情'}
        eyebrow="PROJECT INSPECTOR"
        footer={detailProject ? <><Button icon={<FastForward size={14} />} onClick={() => advanceProjectStage(detailProject)} disabled={detailProject.archived} title="阶段推进受证据门禁约束：缺证据会阻断并给出中文原因">推进阶段</Button><Button variant="primary" onClick={() => { dispatch({ type: 'SET_ACTIVE_PROJECT', id: detailProject.id }); setDetailProject(null); notify('项目已切换', detailProject.name, 'success'); }} disabled={detailProject.archived}>设为当前工作项目</Button></> : null}
      >
        {detailProject && (() => {
          const gate = stageGateView(state, detailProject);
          return <div className="detail-stack">
            <div className="detail-block"><span>项目代号</span><strong>{detailProject.code}</strong></div>
            <div className="detail-block"><span>设计阶段</span><strong>{detailProject.stage}</strong></div>
            <div className="detail-block">
              <span>D5 阶段机（证据门禁）</span>
              <strong>{STAGE_ORDER.join(' → ')}</strong>
              <p>当前：{gate.from ?? `未知（${detailProject.stage}）`}{gate.to ? ` · 下一阶段：${gate.to}` : ' · 已是终态'}</p>
              {gate.result ? <p>{gate.result.allowed ? gate.result.reason : gate.result.blocking.join('；')}</p> : <p>当前阶段不在阶段机定义内，无法推进。</p>}
              <small>UI 只做提示；真正权威是 Runtime 落盘的审批、执行回读与 DRC 证据。</small>
            </div>
            <div className="detail-block">
              <span>阶段证据（UI 预检）</span>
              {STAGE_EVIDENCE_DEFINITIONS.map((definition) => <p key={definition.key}><Badge tone={gate.evidence[definition.key] === true ? 'success' : 'warning'}>{gate.evidence[definition.key] === true ? '已具备' : '缺失'}</Badge> <strong>{definition.label}</strong>：{definition.hint}</p>)}
            </div>
            <div className="detail-block"><span>工程进度</span><Progress value={stageProgress(detailProject.stage)} label={`${stageProgress(detailProject.stage)}%`} /></div>
            <div className="detail-block"><span>工作目录</span><code>{detailProject.rootPath}</code></div>
            <div className="detail-block"><span>EDA 工程</span><code>{detailProject.edaProjectPath}</code></div>
            <div className="detail-block">
              <span>C6 EDA 窗口绑定校验（多项目隔离）</span>
              {detailProject.edaWorkspace
                ? <p>已绑定工程 <code>{detailProject.edaWorkspace.projectUuid}</code>{detailProject.edaWorkspace.pcbUuid ? <> · PCB <code>{detailProject.edaWorkspace.pcbUuid}</code></> : null}</p>
                : <p>尚未绑定 EDA 工程：多项目并行时请先绑定，否则无法判断当前窗口属于哪个项目。</p>}
              <div className="row-actions">
                <Button size="sm" icon={<Link2 size={14} />} loading={bindingBusy} onClick={() => void verifyProjectBinding(detailProject)} disabled={bindingBusy}>校验当前 EDA 窗口</Button>
              </div>
              {binding && binding.projectId === detailProject.id ? (
                binding.ready
                  ? <p><Badge tone="success">一致</Badge> 当前窗口工程/PCB 与项目登记一致，可安全操作。</p>
                  : <><p><Badge tone="warning">不一致</Badge> 不要在这个项目里签发写板批准：</p><ul>{binding.mismatches.map((item) => <li key={item}>{item}</li>)}</ul></>
              ) : null}
            </div>
          </div>;
        })()}
      </Drawer>
      <ConfirmDialog open={Boolean(archiveTarget)} onClose={() => setArchiveTarget(null)} onConfirm={() => archiveTarget && setArchived(archiveTarget, true)} title="归档这个项目？" description={<>项目 <strong>{archiveTarget?.name}</strong> 会从进行中列表移出，数据仍可恢复。</>} confirmLabel="确认归档" danger />
      <ConfirmDialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (deleteTarget) void deleteProject(deleteTarget); }} title="永久删除这个项目？" description={<div className="delete-project-warning"><p>项目 <strong>{deleteTarget?.name}</strong> 及其专属AI会话记忆将从应用内永久删除，无法恢复。</p><p><strong>不会删除</strong>你电脑上的工程目录，也不会修改或删除嘉立创EDA工程文件。</p></div>} confirmLabel="永久删除" danger />
    </>
  );
}
