import { useMemo, useState } from 'react';
import { Archive, ArrowRight, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useApp } from '../state/AppContext';
import type { Project } from '../types';
import { Button, Field, Panel, Progress, SegmentedTabs, Stat, Badge } from '../components/ui';
import { ConfirmDialog, Drawer, Modal } from '../components/overlays';
import { runtimeClient } from '../services/runtimeClient';

const emptyForm = { name: '', code: '', description: '', rootPath: '', edaProjectPath: '' };

export function ProjectsPage() {
  const { state, dispatch, activeProject, requirementCompleteness, openRiskCount, notify, addAudit, navigate } = useApp();
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [createOpen, setCreateOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [detailProject, setDetailProject] = useState<Project | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [form, setForm] = useState(emptyForm);
  const visible = useMemo(() => state.projects.filter((item) => view === 'archived' ? item.archived : !item.archived), [state.projects, view]);

  const createProject = () => {
    if (!form.name.trim() || !form.code.trim()) return;
    const project: Project = {
      id: `project-${Date.now()}`,
      name: form.name.trim(), code: form.code.trim().toUpperCase(), description: form.description.trim() || '尚未填写项目描述。',
      rootPath: form.rootPath.trim() || '/Demo/LocalProject', edaProjectPath: form.edaProjectPath.trim() || '/Demo/LCEDA-Pro/NewProject.eprj2',
      stage: '概念', archived: false, progress: 12, updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
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

      <Panel className="hero-panel" eyebrow="ACTIVE ENGINEERING CONTEXT" title={activeProject?.name || '尚未选择项目'} actions={<><Button icon={<Pencil size={15} />} onClick={() => activeProject && setEditProject(activeProject)} disabled={!activeProject} title={!activeProject ? '请先创建项目' : undefined}>编辑</Button><Button variant="primary" icon={<ArrowRight size={15} />} onClick={() => navigate('requirements')}>继续完善约束</Button></>}>
        {activeProject && <div className="project-hero"><div><div className="project-code">{activeProject.code}</div><p>{activeProject.description}</p><div className="path-row"><span>WORKSPACE</span><code>{activeProject.rootPath}</code></div><div className="path-row"><span>EDA PROJECT</span><code>{activeProject.edaProjectPath}</code></div></div><div className="project-progress"><Progress value={activeProject.progress} label="工程成熟度" /><div className="hero-tags"><Badge tone="info">{activeProject.stage}</Badge><Badge tone={state.eda.connected ? 'success' : 'warning'}>{state.eda.connected ? 'EDA 已连接' : 'EDA 未连接'}</Badge><Badge tone="neutral">本地持久化</Badge></div></div></div>}
      </Panel>

      <Panel eyebrow="PROJECT REGISTRY" title="工程列表" meta="切换项目会改变全局工作上下文" actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>新建项目</Button>}>
        <div className="toolbar"><SegmentedTabs label="项目状态" value={view} onChange={(value) => setView(value as 'active' | 'archived')} items={[{ value: 'active', label: '进行中', count: state.projects.filter((item) => !item.archived).length }, { value: 'archived', label: '已归档', count: state.projects.filter((item) => item.archived).length }]} /></div>
        <div className="project-grid">
          {visible.map((project) => <article className={`project-card ${project.id === state.activeProjectId ? 'is-active' : ''}`} key={project.id}>
            <button type="button" className="project-card__main" onClick={() => setDetailProject(project)} aria-label={`查看${project.name}详情`}><div className="project-card__top"><span className="project-code">{project.code}</span><Badge tone={project.stage === '归档' ? 'neutral' : project.stage === '验证' ? 'success' : 'info'}>{project.stage}</Badge></div><h3>{project.name}</h3><p>{project.description}</p><Progress value={project.progress} /><div className="project-card__meta"><span>更新 {project.updatedAt}</span><span>{project.progress}%</span></div></button>
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

      <Drawer open={Boolean(detailProject)} onClose={() => setDetailProject(null)} title={detailProject?.name || '项目详情'} eyebrow="PROJECT INSPECTOR" footer={<Button variant="primary" onClick={() => { if (detailProject) { dispatch({ type: 'SET_ACTIVE_PROJECT', id: detailProject.id }); setDetailProject(null); notify('项目已切换', detailProject.name, 'success'); } }} disabled={detailProject?.archived}>设为当前工作项目</Button>}>
        {detailProject && <div className="detail-stack"><div className="detail-block"><span>项目代号</span><strong>{detailProject.code}</strong></div><div className="detail-block"><span>设计阶段</span><strong>{detailProject.stage}</strong></div><div className="detail-block"><span>工程进度</span><Progress value={detailProject.progress} label={`${detailProject.progress}%`} /></div><div className="detail-block"><span>工作目录</span><code>{detailProject.rootPath}</code></div><div className="detail-block"><span>EDA 工程</span><code>{detailProject.edaProjectPath}</code></div></div>}
      </Drawer>
      <ConfirmDialog open={Boolean(archiveTarget)} onClose={() => setArchiveTarget(null)} onConfirm={() => archiveTarget && setArchived(archiveTarget, true)} title="归档这个项目？" description={<>项目 <strong>{archiveTarget?.name}</strong> 会从进行中列表移出，数据仍可恢复。</>} confirmLabel="确认归档" danger />
      <ConfirmDialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (deleteTarget) void deleteProject(deleteTarget); }} title="永久删除这个项目？" description={<div className="delete-project-warning"><p>项目 <strong>{deleteTarget?.name}</strong> 及其专属AI会话记忆将从应用内永久删除，无法恢复。</p><p><strong>不会删除</strong>你电脑上的工程目录，也不会修改或删除嘉立创EDA工程文件。</p></div>} confirmLabel="永久删除" danger />
    </>
  );
}
