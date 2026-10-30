import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, Copy, Download, GitCompare, Plus, RefreshCw, RotateCcw, Search, ShieldAlert, Sparkles } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { downloadDemoFile } from '../services/demoAdapter';
import { buildFixTaskDraft } from '../services/fixTask';
import { RuntimeApiError, runtimeClient, type TimelineResult } from '../services/runtimeClient';
import type { ChangeLogEntry, IssueRecord, IssueStatus, PageId, RuntimeEvent, VersionItem } from '../types';
import { Badge, Button, CopyValue, Field, Panel, SegmentedTabs, Stat } from '../components/ui';
import { ConfirmDialog, Drawer, Modal } from '../components/overlays';

type TraceTab = 'versions' | 'changes' | 'issues' | 'audit' | 'events';

export function VersionsPage() {
  const { state, dispatch, notify, addAudit, recordChange, updateIssue, navigate } = useApp();
  const [tab, setTab] = useState<TraceTab>('versions');
  // C3 系统事件时间线：来自 Runtime 日志（进程内存），只读；不可当持久审计账本（账本见批准哈希链）。
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [eventsBusy, setEventsBusy] = useState(false);
  const [eventsError, setEventsError] = useState('');
  // C5：证据索引（只读汇总）；B10：保留计划只做 dry-run，不提供删除入口。
  const [evidenceIndex, setEvidenceIndex] = useState<Awaited<ReturnType<typeof runtimeClient.evidenceIndex>>['index'] | null>(null);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [evidenceError, setEvidenceError] = useState('');
  // C3：统一证据时间线（执行 journal + 批准账本 + 证据索引），只读；坏行/不可用来源如实暴露。
  const [timeline, setTimeline] = useState<TimelineResult | null>(null);
  const [timelineBusy, setTimelineBusy] = useState(false);
  const [timelineError, setTimelineError] = useState('');
  const [timelineRunId, setTimelineRunId] = useState('');
  // C3（剩余）：人工显式关联证据 ↔ run（digest 需在服务端证据索引里真实存在）。
  const [linkDigest, setLinkDigest] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [retentionPlan, setRetentionPlan] = useState<Awaited<ReturnType<typeof runtimeClient.evidenceRetentionPlan>>['plan'] | null>(null);
  // B8：不可变发布版本（只读；记录 + 证据文件重校验结果）。
  const [releaseArchives, setReleaseArchives] = useState<Awaited<ReturnType<typeof runtimeClient.releaseArchives>>['releases'] | null>(null);
  const [releaseArchivesCorrupt, setReleaseArchivesCorrupt] = useState<Awaited<ReturnType<typeof runtimeClient.releaseArchives>>['corrupt']>([]);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseError, setReleaseError] = useState('');
  const [artifactPlan, setArtifactPlan] = useState<Awaited<ReturnType<typeof runtimeClient.artifactRetentionPlan>>['plan'] | null>(null);
  const [retentionBusy, setRetentionBusy] = useState(false);
  const [evidenceDigest, setEvidenceDigest] = useState('');
  const [evidenceHit, setEvidenceHit] = useState<Awaited<ReturnType<typeof runtimeClient.evidenceFind>>['evidence'] | null>(null);
  const [eventLevel, setEventLevel] = useState('all');
  const [selectedVersions, setSelectedVersions] = useState<string[]>(state.versions.slice(0, 2).map((item) => item.id));
  const [detail, setDetail] = useState<VersionItem | null>(null);
  const [changeDetail, setChangeDetail] = useState<ChangeLogEntry | null>(null);
  const [issueDetail, setIssueDetail] = useState<IssueRecord | null>(null);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [snapshotName, setSnapshotName] = useState('手动工程快照');
  const [rollbackTarget, setRollbackTarget] = useState<VersionItem | null>(null);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [limit, setLimit] = useState(25);
  const [downloadType, setDownloadType] = useState<'diagnostic' | 'review' | null>(null);
  const [issueAction, setIssueAction] = useState<{ issue: IssueRecord; status: IssueStatus } | null>(null);
  const [actionNote, setActionNote] = useState('');

  const loadRuntimeEvents = async () => {
    setEventsBusy(true);
    try {
      const events = await runtimeClient.events();
      setRuntimeEvents(events);
      setEventsError('');
    } catch (error) {
      setEventsError(error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误');
    } finally { setEventsBusy(false); }
  };
  const loadReleaseArchives = async () => {
    setReleaseBusy(true);
    setReleaseError('');
    try {
      const result = await runtimeClient.releaseArchives();
      setReleaseArchives(result.releases);
      setReleaseArchivesCorrupt(result.corrupt);
    } catch (caught) {
      setReleaseArchives(null);
      setReleaseError(caught instanceof RuntimeApiError ? `[${caught.code}] ${caught.message}` : caught instanceof Error ? caught.message : '未知错误');
    } finally {
      setReleaseBusy(false);
    }
  };

  const linkEvidenceToRun = async () => {
    const runId = timelineRunId.trim(); const digest = linkDigest.trim().toLowerCase();
    if (!runId || !digest) return;
    setLinkBusy(true);
    try {
      const result = await runtimeClient.linkTimeline({ runId, digest });
      notify('证据已关联到运行', `${result.link.digest.slice(0, 12)}… → ${result.link.runId}（append-only，可在时间线按 runId 过滤查看）`, 'success');
      setLinkDigest('');
      await loadTimeline();
    } catch (error) {
      notify('证据关联失败', error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : (error instanceof Error ? error.message : '未知错误'), 'danger');
    } finally { setLinkBusy(false); }
  };

  const loadTimeline = async () => {
    setTimelineBusy(true);
    setTimelineError('');
    try {
      const result = await runtimeClient.timeline(timelineRunId.trim() || undefined, 200);
      setTimeline(result);
    } catch (error) {
      setTimeline(null);
      setTimelineError(error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误');
    } finally { setTimelineBusy(false); }
  };
  const loadEvidenceIndex = async () => {
    setEvidenceBusy(true);
    setEvidenceError('');
    try {
      const result = await runtimeClient.evidenceIndex();
      setEvidenceIndex(result.index);
    } catch (error) {
      setEvidenceError(error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误');
    } finally { setEvidenceBusy(false); }
  };

  const findEvidenceByDigest = async () => {
    const digest = evidenceDigest.trim();
    if (!digest) return notify('请填写证据 digest', 'digest 来自证据文件索引；查找未命中会明确报 EVIDENCE_NOT_FOUND，不会伪造命中。', 'warning');
    setEvidenceBusy(true);
    setEvidenceError('');
    setEvidenceHit(null);
    try {
      const result = await runtimeClient.evidenceFind({ digest });
      setEvidenceHit(result.evidence);
      notify('证据命中', `${result.evidence.kind} · ${result.evidence.savedAt || '时间未知'}`, 'success');
      addAudit('version', '按 digest 查找证据', `${result.evidence.kind} · ${digest.slice(0, 12)}`, 'info');
    } catch (error) {
      setEvidenceError(error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误');
    } finally { setEvidenceBusy(false); }
  };

  const planRetention = async () => {
    setRetentionBusy(true);
    setEvidenceError('');
    try {
      const [evidence, artifacts] = await Promise.all([
        runtimeClient.evidenceRetentionPlan({ keepPerKind: 3, keepDays: 30 }),
        runtimeClient.artifactRetentionPlan({ policy: { enabled: true, maxAgeDays: 30, maxTotalBytes: 2 * 1024 * 1024 * 1024 } }),
      ]);
      setRetentionPlan(evidence.plan);
      setArtifactPlan(artifacts.plan);
      notify('保留计划已生成（未删除任何文件）', `证据计划保留 ${evidence.plan.keep.length} / 清理 ${evidence.plan.prune.length}；制造物计划 ${artifacts.plan.summary.prune ?? 0} 个候选。dry-run 只做计划，模块没有删除能力。`, 'info');
      addAudit('version', '生成证据/制造物保留计划（dry-run）', `证据 prune=${evidence.plan.prune.length} · 制造物 prune=${artifacts.plan.summary.prune ?? 0}`, 'info');
    } catch (error) {
      setEvidenceError(error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误');
    } finally { setRetentionBusy(false); }
  };

  useEffect(() => { if (tab === 'events') { void loadRuntimeEvents(); void loadEvidenceIndex(); void loadTimeline(); } }, [tab]);

  const exportRuntimeEvents = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      note: 'Runtime 日志事件（进程内存，重启清空）；持久审计请看批准账本/执行历史/证据文件',
      runtime: { mode: state.runtime.mode, reachable: state.runtime.reachable, serviceVersion: state.runtime.serviceVersion },
      events: runtimeEvents,
      uiAudit: state.audit.slice(0, 200),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `circuitpilot-runtime-events-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify('已导出运行事件', `${runtimeEvents.length} 条 Runtime 事件 + ${Math.min(state.audit.length, 200)} 条界面审计。`, 'success');
    addAudit('version', '导出运行事件时间线', `${runtimeEvents.length} 条事件`, 'info');
  };

  const openIssues = state.issues.filter((item) => item.status === 'open' || item.status === 'investigating');
  const compared = selectedVersions.map((id) => state.versions.find((item) => item.id === id)).filter(Boolean) as VersionItem[];
  const changes = useMemo(() => state.changes.filter((item) => (sourceFilter === 'all' || item.source === sourceFilter) && `${item.summary} ${item.objectType} ${item.objectId} ${item.actor}`.toLowerCase().includes(query.toLowerCase())).slice(0, limit), [state.changes, sourceFilter, query, limit]);
  const issues = useMemo(() => state.issues.filter((item) => (sourceFilter === 'all' || item.source === sourceFilter) && (statusFilter === 'all' || item.status === statusFilter) && `${item.summary} ${item.code} ${item.detail}`.toLowerCase().includes(query.toLowerCase())).slice(0, limit), [state.issues, sourceFilter, statusFilter, query, limit]);
  const audit = useMemo(() => state.audit.filter((item) => (sourceFilter === 'all' || item.type === sourceFilter) && `${item.title} ${item.detail} ${item.time}`.toLowerCase().includes(query.toLowerCase())).slice(0, limit), [state.audit, sourceFilter, query, limit]);

  const toggleVersion = (id: string) => setSelectedVersions((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length >= 2 ? [current[1], id] : [...current, id]);
  const snapshot = () => {
    if (!snapshotName.trim()) return;
    const version: VersionItem = { id: `ver-${Date.now()}`, label: snapshotName.trim(), kind: 'snapshot', date: new Date().toLocaleString('zh-CN', { hour12: false }), summary: state.runtime.mode === 'demo' ? '用户创建的手动工作区快照（Demo）' : '用户创建的手动工作区快照', validationStatus: state.validations.some((item) => item.status === 'fail') ? 'fail' : state.validations.some((item) => item.status === 'warn') ? 'warn' : 'pass', requirements: state.requirements.length, components: state.components.reduce((sum, item) => sum + item.qty, 0), designObjects: 148 };
    dispatch({ type: 'ADD_VERSION', version }); addAudit('version', '创建手动快照', version.label, 'success'); recordChange({ source: 'user', actor: '本机用户', action: 'snapshot', objectType: 'version', objectId: version.id, summary: `创建快照：${version.label}`, after: version, reason: '用户手动建立回滚点', relations: { versionId: version.id } }); notify('快照已创建', `${version.label} 已加入版本时间线。`, 'success'); setSnapshotOpen(false); setSnapshotName('手动工程快照');
  };
  const rollback = () => {
    if (!rollbackTarget) return;
    const version: VersionItem = { ...rollbackTarget, id: `rollback-${Date.now()}`, label: `回滚至 ${rollbackTarget.label}`, kind: 'rollback', date: new Date().toLocaleString('zh-CN', { hour12: false }), summary: `从 ${rollbackTarget.id} 创建的新回滚事件（Demo状态）` };
    dispatch({ type: 'ADD_VERSION', version }); addAudit('version', '执行Demo回滚', version.label, 'warning'); recordChange({ source: 'user', actor: '本机用户', action: 'rollback', objectType: 'version', objectId: version.id, summary: version.label, before: rollbackTarget.id, after: version.id, reason: '用户确认回滚', relations: { versionId: rollbackTarget.id } }); notify('Demo 回滚已记录', '历史版本未被覆盖，已创建新的回滚事件。', 'warning'); setRollbackTarget(null);
  };
  const download = () => {
    if (!downloadType) return;
    const filename = downloadType === 'diagnostic' ? 'CircuitPilot-diagnostics-DEMO.txt' : 'CircuitPilot-review-DEMO.txt';
    const safeTrace = { generatedAt: new Date().toISOString(), boundary: 'DEMO ONLY', runtime: { mode: state.runtime.mode, reachable: state.runtime.reachable, lastError: state.runtime.lastError }, eda: state.eda, validations: state.validations, issues: state.issues, changes: state.changes, audit: state.audit };
    const content = downloadType === 'diagnostic' ? JSON.stringify(safeTrace, null, 2) : JSON.stringify({ ...safeTrace, project: state.projects.find((item) => item.id === state.activeProjectId), requirements: state.requirements, bom: state.components, versions: state.versions }, null, 2);
    downloadDemoFile(filename, content); addAudit('version', '下载安全诊断资料包', filename, 'warning'); notify('资料包已生成', '包含修改与问题记录，不包含API Key、Token或模型思维链。', 'warning'); setDownloadType(null);
  };
  // D4：把问题一键转成只读修复任务草稿（不直接写板、不跳过批准），再跳 AI 任务页。
  const createFixTask = (issue: IssueRecord) => {
    const task = buildFixTaskDraft(issue);
    dispatch({ type: 'SET_TASK', task });
    addAudit('validation', '从问题创建修复任务', `${issue.code} → ${task.id}`, 'info');
    recordChange({ source: 'user', actor: '本机用户', action: 'create', objectType: 'ai-task', objectId: task.id, summary: `从问题 ${issue.code} 创建只读修复任务草稿`, after: { goal: task.goal, mode: task.mode }, reason: '问题中心 → 修复任务打通；写板仍需重新计划与人工批准' });
    notify('已创建修复任务草稿', 'AI 任务页已载入只读修复目标；请审阅后生成计划，写板仍需人工批准。', 'success');
    setIssueDetail(null);
    navigate('ai');
  };

  const handleIssue = () => {
    if (!issueAction || !actionNote.trim()) return;
    updateIssue(issueAction.issue.id, issueAction.status, actionNote.trim()); addAudit('validation', `问题状态更新为${issueAction.status}`, `${issueAction.issue.code} · ${actionNote.trim()}`, 'info'); recordChange({ source: 'user', actor: '本机用户', action: 'handle', objectType: 'issue', objectId: issueAction.issue.id, summary: `问题状态：${issueAction.issue.status} → ${issueAction.status}`, before: issueAction.issue.status, after: issueAction.status, reason: actionNote.trim() }); notify('问题状态已更新', `${issueAction.issue.code} · ${issueAction.status}`, 'success'); setIssueDetail(null); setIssueAction(null); setActionNote('');
  };
  const openSource = (issue: IssueRecord) => navigate(issue.source === 'eda' ? 'eda' : issue.source === 'provider' || issue.source === 'runtime' || issue.source === 'persistence' ? 'settings' : issue.source === 'ai' ? 'ai' : 'validation');
  const resetFilters = () => { setQuery(''); setSourceFilter('all'); setStatusFilter('all'); };

  return <>
    <div className="stats-grid stats-grid--4"><Stat label="版本节点" value={state.versions.length} hint="快照、里程碑与回滚" /><Stat label="结构化修改" value={state.changes.length} hint="最多保留500条" tone="info" /><Stat label="未解决问题" value={openIssues.length} hint={openIssues.some((item) => item.severity === 'critical' || item.severity === 'error') ? '存在高优先级错误' : '警告与待处理项'} tone={openIssues.length ? 'danger' : 'success'} /><Stat label="审计事件" value={state.audit.length} hint="最多保留200条" /></div>
    <Panel eyebrow="TRACEABILITY" title="版本、日志与问题" actions={<>{tab === 'versions' ? <Button variant="primary" icon={<Plus size={15} />} onClick={() => setSnapshotOpen(true)}>创建手动快照</Button> : <><Button icon={<Download size={15} />} onClick={() => setDownloadType('diagnostic')}>诊断包</Button><Button variant="primary" icon={<Download size={15} />} onClick={() => setDownloadType('review')}>工程评审包</Button></>}</>}>
      <div className="toolbar"><SegmentedTabs label="追溯视图" value={tab} onChange={(value) => { setTab(value as TraceTab); resetFilters(); }} items={[{ value: 'versions', label: '版本时间线', count: state.versions.length }, { value: 'changes', label: '修改日志', count: state.changes.length }, { value: 'issues', label: '问题中心', count: openIssues.length }, { value: 'audit', label: '审计日志', count: state.audit.length }, { value: 'events', label: '系统事件', count: runtimeEvents.length }]} /></div>

      {tab === 'versions' && <div className="version-layout"><div className="timeline">{state.versions.map((version) => <article className={`timeline-item timeline-item--${version.kind}`} key={version.id}><label className="compare-check" title="加入版本比较"><input type="checkbox" checked={selectedVersions.includes(version.id)} onChange={() => toggleVersion(version.id)} /><span /></label><div className="timeline-rail"><i /></div><button type="button" className="timeline-main" onClick={() => setDetail(version)}><div><Badge tone={version.kind === 'milestone' ? 'info' : version.kind === 'rollback' ? 'warning' : 'neutral'}>{version.kind === 'milestone' ? '里程碑' : version.kind === 'rollback' ? '回滚事件' : '快照'}</Badge><h3>{version.label}</h3><p>{version.summary}</p><small><Clock3 size={12} /> {version.date}</small></div><div className="timeline-counts"><span><strong>{version.requirements}</strong>约束</span><span><strong>{version.components}</strong>元件</span><span><strong>{version.designObjects}</strong>对象</span><Badge tone={version.validationStatus === 'pass' ? 'success' : version.validationStatus === 'fail' ? 'danger' : 'warning'}>{version.validationStatus.toUpperCase()}</Badge></div></button><div className="timeline-actions"><Button size="sm" onClick={() => setDetail(version)}>详情</Button><Button size="sm" icon={<RotateCcw size={13} />} onClick={() => setRollbackTarget(version)}>回滚</Button></div></article>)}</div><aside className="compare-panel"><div className="compare-panel__head"><GitCompare size={18} /><div><strong>结构化版本比较</strong><small>选择两个版本查看数量差异</small></div></div>{compared.length === 2 ? <div className="compare-table"><div><span>字段</span><strong>{compared[1].label}</strong><strong>{compared[0].label}</strong><em>差异</em></div>{([['需求约束', 'requirements'], ['BOM元件', 'components'], ['设计对象', 'designObjects']] as const).map(([label, key]) => <div key={key}><span>{label}</span><strong>{compared[1][key]}</strong><strong>{compared[0][key]}</strong><em>{compared[0][key] - compared[1][key] >= 0 ? '+' : ''}{compared[0][key] - compared[1][key]}</em></div>)}</div> : <div className="compare-empty">请在时间线上选择两个版本。</div>}</aside></div>}

      {tab !== 'versions' && tab !== 'events' && <div className="toolbar toolbar--wrap"><label className="search-box"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`搜索${tab === 'changes' ? '修改' : tab === 'issues' ? '问题' : '审计'}记录`} aria-label="搜索追溯记录" /></label><select className="compact-select compact-select--plain" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} aria-label="筛选来源"><option value="all">全部来源</option><option value="user">用户</option><option value="ai">AI</option><option value="eda">EDA</option><option value="runtime">Runtime</option><option value="provider">Provider</option><option value="validation">验证</option><option value="settings">设置</option><option value="version">版本</option></select>{tab === 'issues' && <select className="compact-select compact-select--plain" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="筛选问题状态"><option value="all">全部状态</option><option value="open">待处理</option><option value="investigating">处理中</option><option value="resolved">已解决</option><option value="ignored">已忽略</option></select>}<div className="toolbar__spacer" /><select className="compact-select compact-select--plain" value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="结果数量"><option value={10}>显示10条</option><option value={25}>显示25条</option><option value={50}>显示50条</option></select><Button size="sm" onClick={resetFilters}>清除筛选</Button></div>}

      {tab === 'changes' && <div className="trace-list">{changes.map((entry) => <article key={entry.id}><span className="trace-icon"><GitCompare size={16} /></span><time>{entry.time}</time><Badge tone="info">{entry.source}</Badge><div><strong>{entry.summary}</strong><p>{entry.objectType} · {entry.objectId} · {entry.actor}</p></div><Button size="sm" onClick={() => setChangeDetail(entry)}>查看差异</Button></article>)}{!changes.length && <div className="empty-inline">没有匹配的修改记录。</div>}</div>}
      {tab === 'issues' && <div className="trace-list">{issues.map((issue) => <article key={issue.id}><span className="trace-icon"><ShieldAlert size={16} /></span><time>{issue.lastOccurredAt}</time><Badge tone={issue.severity === 'critical' || issue.severity === 'error' ? 'danger' : issue.severity === 'warning' ? 'warning' : 'info'}>{issue.severity}</Badge><div><strong>{issue.summary}</strong><p><code>{issue.code}</code> · {issue.source} · 发生{issue.occurrences}次</p></div><Badge tone={issue.status === 'resolved' ? 'success' : issue.status === 'ignored' ? 'neutral' : 'warning'}>{issue.status}</Badge><Button size="sm" onClick={() => setIssueDetail(issue)}>处理</Button></article>)}{!issues.length && <div className="empty-inline"><CheckCircle2 size={20} /> 没有匹配的问题。</div>}</div>}
      {tab === 'audit' && <div className="audit-list">{audit.map((event) => <article key={event.id}><span className={`audit-dot audit-dot--${event.status}`} /><time>{event.time}</time><Badge tone="neutral">{event.type.toUpperCase()}</Badge><div><strong>{event.title}</strong><p>{event.detail}</p></div><Badge tone={event.status === 'error' ? 'danger' : event.status === 'warning' ? 'warning' : event.status === 'success' ? 'success' : 'info'}>{event.status}</Badge></article>)}{!audit.length && <div className="empty-inline">没有匹配的审计事件。</div>}</div>}

      {tab === 'events' && (
        <div className="detail-stack">
          <div className="inline-alert inline-alert--info"><Clock3 size={16} /><span>Runtime 日志事件是<strong>进程内存</strong>里的运行轨迹（重启清空），不是持久审计证据。持久证据请看：批准哈希链（验证页）、执行历史（EDA 页）、DRC/DFM/签核文件（artifacts/evidence）。</span></div>
          <div className="detail-block">
            <span>C3 统一证据时间线（执行 journal + 批准账本 + 证据索引，只读）</span>
            <div className="row-actions">
              <input className="input compact-input" style={{ maxWidth: 260 }} placeholder="按 runId 过滤（可留空）" value={timelineRunId} onChange={(event) => setTimelineRunId(event.target.value)} aria-label="时间线 runId 过滤" />
              <input className="input compact-input" style={{ maxWidth: 300 }} placeholder="显式关联：证据 digest（64 位 sha256）" value={linkDigest} onChange={(event) => setLinkDigest(event.target.value)} aria-label="证据 digest" />
              <Button size="sm" variant="secondary" loading={linkBusy} disabled={!timelineRunId.trim() || !linkDigest.trim()} onClick={() => void linkEvidenceToRun()}>关联到该运行</Button>
              <Button size="sm" icon={<RefreshCw size={14} />} loading={timelineBusy} onClick={() => void loadTimeline()}>加载时间线</Button>
              {timeline ? <Badge tone={timeline.complete ? 'success' : 'warning'}>{timeline.complete ? '来源完整' : '部分来源不可用/有坏行'}</Badge> : null}
              {timeline?.truncated ? <Badge tone="neutral">已截断 {timeline.entries.length}/{timeline.total}</Badge> : null}
            </div>
            {timelineError ? <div className="inline-alert inline-alert--warning"><ShieldAlert size={16} /><span>时间线读取失败：{timelineError}</span></div> : null}
            {timeline ? (
              <>
                <div className="stats-grid stats-grid--4">
                  <Stat label="run 步骤" value={timeline.counts.run ?? 0} hint={`来源文件 ${timeline.sources.journal.files ?? '—'}`} tone="info" />
                  <Stat label="批准事件" value={timeline.counts.approval ?? 0} hint={timeline.sources.approvals.available ? `账本 ${timeline.sources.approvals.entries ?? 0} 条` : (timeline.sources.approvals.reason || '不可用')} />
                  <Stat label="证据文件" value={timeline.counts.evidence ?? 0} hint={timeline.sources.evidence.available ? '来自证据索引' : (timeline.sources.evidence.reason || '不可用')} />
                  <Stat label="坏行/坏文件" value={timeline.invalid.length} hint="如实列出，不静默跳过" tone={timeline.invalid.length ? 'danger' : 'success'} />
                </div>
                {timeline.invalid.length ? <div className="inline-alert inline-alert--warning"><ShieldAlert size={16} /><span>时间线里有 {timeline.invalid.length} 条坏行/坏文件：{timeline.invalid.slice(0, 3).map((item) => `${item.file}${item.line ? `:${item.line}` : ''}`).join('；')}</span></div> : null}
                {timeline.entries.length ? <div className="audit-list">{timeline.entries.slice(0, 30).map((entry, index) => <article key={`${entry.kind}-${entry.at}-${index}`}><span className={`audit-dot audit-dot--${entry.kind === 'run' ? 'info' : entry.kind === 'approval' ? 'warning' : 'success'}`} /><time>{entry.at ? new Date(entry.at).toLocaleString('zh-CN') : '时间未知'}</time><Badge tone={entry.kind === 'run' ? 'info' : entry.kind === 'approval' ? 'warning' : 'success'}>{entry.kind}</Badge><div><strong>{entry.summary}</strong>{entry.runId ? <p><small>runId {entry.runId}{entry.digest ? ` · ${entry.digest.slice(0, 12)}` : ''}</small></p> : null}</div></article>)}</div> : <div className="empty-inline"><Clock3 size={22} /><strong>暂无时间线条目</strong><span>执行、批准、证据都会归集到这里；来源不可用时上方会写明原因。</span></div>}
              </>
            ) : null}
          </div>
          <div className="toolbar toolbar--wrap">
            <select className="compact-select compact-select--plain" value={eventLevel} onChange={(event) => setEventLevel(event.target.value)} aria-label="筛选事件级别"><option value="all">全部级别</option><option value="error">ERROR</option><option value="warn">WARN</option><option value="info">INFO</option></select>
            <div className="toolbar__spacer" />
            <Button size="sm" icon={<RefreshCw size={14} />} loading={eventsBusy} onClick={() => void loadRuntimeEvents()}>刷新事件</Button>
            <Button size="sm" icon={<Download size={14} />} onClick={exportRuntimeEvents} disabled={!runtimeEvents.length}>导出运行事件 JSON</Button>
          </div>
          {eventsError ? <div className="inline-alert inline-alert--warning"><ShieldAlert size={16} /><span>读取失败：{eventsError}（Runtime 未连接时这是预期结果，不是静默通过）</span></div> : null}
          {(() => {
            const filtered = runtimeEvents.filter((item) => eventLevel === 'all' || item.level === eventLevel);
            if (!filtered.length) return <div className="empty-inline"><Clock3 size={22} /><strong>暂无运行事件</strong><span>Runtime 产生日志后会出现在这里；审计结论请看批准账本与执行历史。</span></div>;
            return <div className="audit-list">{filtered.slice().reverse().map((event, index) => <article key={`${event.timestamp}-${index}`}><span className={`audit-dot audit-dot--${event.level === 'error' ? 'error' : event.level === 'warn' ? 'warning' : 'info'}`} /><time>{event.timestamp}</time><Badge tone={event.level === 'error' ? 'danger' : event.level === 'warn' ? 'warning' : 'neutral'}>{(event.level || 'info').toUpperCase()}</Badge><div><strong>{event.module}</strong><p>{event.message}</p></div></article>)}</div>;
          })()}
          <div className="detail-block">
            <span>C5 证据索引（持久证据文件汇总，只读）</span>
            <div className="row-actions">
              <Button size="sm" icon={<RefreshCw size={14} />} loading={evidenceBusy} onClick={() => void loadEvidenceIndex()}>读取证据索引</Button>
              <Button size="sm" icon={<ShieldAlert size={14} />} loading={retentionBusy} onClick={() => void planRetention()}>生成保留计划（dry-run）</Button>
              <input className="input compact-input" style={{ maxWidth: 220 }} placeholder="按 digest 查证据" value={evidenceDigest} onChange={(event) => setEvidenceDigest(event.target.value)} aria-label="证据 digest" />
              <Button size="sm" loading={evidenceBusy} onClick={() => void findEvidenceByDigest()}>查找证据</Button>
              {evidenceIndex ? <Badge tone={evidenceIndex.complete ? 'success' : 'warning'}>{evidenceIndex.complete ? '索引完整' : '索引不完整'}</Badge> : null}
            </div>
            {evidenceError ? <div className="inline-alert inline-alert--warning"><ShieldAlert size={16} /><span>{evidenceError}</span></div> : null}
            {evidenceHit ? <div className="inline-alert inline-alert--info"><CheckCircle2 size={16} /><span>命中证据：<strong>{evidenceHit.kind}</strong> · {evidenceHit.savedAt || '时间未知'} · {evidenceHit.path}</span></div> : null}
            {evidenceIndex ? (
              <>
                <div className="stats-grid stats-grid--4">
                  <Stat label="证据条目" value={evidenceIndex.summary.entries} hint={`目录 ${Object.keys(evidenceIndex.summary.kinds).length} 类`} />
                  <Stat label="索引时间" value={<small>{new Date(evidenceIndex.generatedAt).toLocaleString('zh-CN')}</small>} hint={evidenceIndex.truncated ? '已截断（按上限）' : '未截断'} />
                  <Stat label="损坏文件" value={evidenceIndex.invalid.length} hint="坏文件单独列出，不当成没有证据" tone={evidenceIndex.invalid.length ? 'danger' : 'success'} />
                  <Stat label="重复副本" value={evidenceIndex.summary.duplicates} hint="同 kind+digest 的旧副本（索引保留一份）" />
                </div>
                <table>
                  <thead><tr><th>Kind</th><th>Digest</th><th>保存时间</th><th>指纹</th><th>路径</th></tr></thead>
                  <tbody>{evidenceIndex.entries.slice(0, 20).map((entry) => <tr key={`${entry.kind}-${entry.digest || entry.path}`}><td>{entry.kind}</td><td>{entry.digest ? <CopyValue value={entry.digest} label="证据 digest" display={`${entry.digest.slice(0, 12)}…`} /> : <code>—</code>}</td><td>{entry.savedAt ? new Date(entry.savedAt).toLocaleString('zh-CN') : '—'}</td><td><small>{JSON.stringify(entry.fingerprint).slice(0, 60)}</small></td><td><CopyValue value={entry.path} label="证据路径" /></td></tr>)}</tbody>
                </table>
              </>
            ) : null}
            {(retentionPlan || artifactPlan) ? (
              <div className="detail-block">
                <span>保留计划（dry-run，未删除任何文件）</span>
                {retentionPlan ? <p><strong>证据：</strong>保留 {retentionPlan.keep.length} · 清理候选 {retentionPlan.prune.length} · safeToApply {String(retentionPlan.safeToApply)}{retentionPlan.blockedReasons.length ? ` · 阻断原因：${retentionPlan.blockedReasons.join('；')}` : ''}</p> : null}
                {artifactPlan ? <p><strong>制造物：</strong>{JSON.stringify(artifactPlan.summary)}（targets {artifactPlan.targets.length}）</p> : null}
              </div>
            ) : null}
          </div>
          <div className="detail-block">
            <span>B8 不可变发布版本（只读；创建后没有更新/删除接口，证据文件逐个重校验）</span>
            <div className="row-actions">
              <Button size="sm" icon={<RefreshCw size={14} />} loading={releaseBusy} onClick={() => void loadReleaseArchives()}>读取发布版本</Button>
              {releaseArchives ? <Badge tone="success">{releaseArchives.length} 个归档</Badge> : null}
              {releaseArchivesCorrupt.length ? <Badge tone="danger">{releaseArchivesCorrupt.length} 个文件损坏</Badge> : null}
            </div>
            {releaseError ? <div className="inline-alert inline-alert--warning"><ShieldAlert size={16} /><span>发布版本读取失败：{releaseError}（Runtime 未连接时这是预期结果，不是静默通过）</span></div> : null}
            {releaseArchivesCorrupt.length ? <div className="inline-alert inline-alert--warning"><ShieldAlert size={16} /><span>目录里有 {releaseArchivesCorrupt.length} 个无法解析的发布版本文件：{releaseArchivesCorrupt.slice(0, 3).map((item) => `${item.file}（${item.error}）`).join('；')}</span></div> : null}
            {releaseArchives === null ? <small>尚未读取；归档只在放行真正 ready（本地门禁 + 人工 DFM/签核）后才允许创建。</small> : releaseArchives.length ? (
              <table>
                <thead><tr><th>发布版本</th><th>时间</th><th>结论</th><th>planHash</th><th>manifestHash</th><th>证据</th><th>重校验</th></tr></thead>
                <tbody>
                  {releaseArchives.map((release) => (
                    <tr key={release.releaseId}>
                      <td><CopyValue value={release.releaseId} label="发布版本号" /></td>
                      <td><small>{new Date(release.createdAt).toLocaleString('zh-CN')}</small></td>
                      <td><Badge tone={release.verdict === 'ready-to-order' ? 'success' : 'warning'}>{release.verdict || '未知'}</Badge></td>
                      <td>{release.binding.planHash ? <CopyValue value={release.binding.planHash} label="planHash" display={`${release.binding.planHash.slice(0, 12)}…`} /> : <code>—</code>}</td>
                      <td>{release.binding.manifestHash ? <CopyValue value={release.binding.manifestHash} label="manifestHash" display={`${release.binding.manifestHash.slice(0, 12)}…`} /> : <code>—</code>}</td>
                      <td>{release.files} 个文件</td>
                      <td>{release.verification.verified ? <Badge tone="success">证据一致</Badge> : <span title={release.verification.problems.join('；')}><Badge tone="danger">校验失败</Badge></span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="empty-inline"><ShieldAlert size={22} /><strong>还没有发布版本</strong><span>放行 ready 后在验证页点「归档为发布版本」会生成不可变记录；这里不提供编辑/删除。</span></div>}
          </div>
        </div>
      )}
    </Panel>

    <Drawer open={Boolean(detail)} onClose={() => setDetail(null)} title={detail?.label || '版本详情'} eyebrow="VERSION INSPECTOR" footer={<>{detail && <Button onClick={() => toggleVersion(detail.id)}>{selectedVersions.includes(detail.id) ? '移出比较' : '加入比较'}</Button>}<Button variant="primary" icon={<RotateCcw size={15} />} onClick={() => { if (detail) { setRollbackTarget(detail); setDetail(null); } }}>回滚到此版本</Button></>}><>{detail && <div className="detail-stack"><div className="detail-block"><span>版本标识</span><code>{detail.id}</code></div><div className="detail-block"><span>创建时间</span><strong>{detail.date}</strong></div><div className="detail-block"><span>摘要</span><p>{detail.summary}</p></div></div>}</></Drawer>
    <Drawer open={Boolean(changeDetail)} onClose={() => setChangeDetail(null)} title={changeDetail?.summary || '修改详情'} eyebrow="STRUCTURED CHANGE"><>{changeDetail && <div className="detail-stack"><div className="detail-block"><span>对象</span><strong>{changeDetail.objectType} · {changeDetail.objectId}</strong></div><div className="detail-block"><span>操作者 / 原因</span><p>{changeDetail.actor} · {changeDetail.reason || '未填写'}</p></div><div className="diff-grid"><div><span>修改前</span><pre>{JSON.stringify(changeDetail.before ?? null, null, 2)}</pre></div><div><span>修改后</span><pre>{JSON.stringify(changeDetail.after ?? null, null, 2)}</pre></div></div></div>}</></Drawer>
    <Drawer open={Boolean(issueDetail)} onClose={() => setIssueDetail(null)} title={issueDetail?.summary || '问题详情'} eyebrow="ISSUE CENTER" footer={<>{issueDetail && <><Button icon={<Copy size={14} />} onClick={() => { navigator.clipboard?.writeText(JSON.stringify({ code: issueDetail.code, summary: issueDetail.summary, detail: issueDetail.detail, context: issueDetail.context }, null, 2)); notify('诊断信息已复制', '敏感字段不会进入问题记录。', 'success'); }}>复制诊断</Button><Button icon={<Sparkles size={14} />} onClick={() => createFixTask(issueDetail)}>建修复任务</Button>{issueDetail.context?.repairPage ? <Button variant="primary" icon={<ShieldAlert size={14} />} onClick={() => { navigate(issueDetail.context!.repairPage as PageId); setIssueDetail(null); }}>{issueDetail.context.repairLabel || '去修复'}</Button> : null}<Button onClick={() => openSource(issueDetail)}>前往来源</Button>{issueDetail.status !== 'investigating' && <Button onClick={() => { setIssueAction({ issue: issueDetail, status: 'investigating' }); setActionNote('开始排查'); }}>标记处理中</Button>}{issueDetail.status !== 'resolved' ? <Button variant="primary" onClick={() => { setIssueAction({ issue: issueDetail, status: 'resolved' }); setActionNote(''); }}>解决</Button> : <Button onClick={() => { setIssueAction({ issue: issueDetail, status: 'open' }); setActionNote('问题复发'); }}>重新打开</Button>}{issueDetail.status !== 'ignored' && <Button variant="danger" onClick={() => { setIssueAction({ issue: issueDetail, status: 'ignored' }); setActionNote(''); }}>忽略</Button>}</>}</>}><>{issueDetail && <div className="detail-stack"><div className="validation-summary"><Badge tone={issueDetail.severity === 'error' || issueDetail.severity === 'critical' ? 'danger' : 'warning'}>{issueDetail.severity}</Badge><div><strong>{issueDetail.code}</strong><p>{issueDetail.detail}</p></div><span>{issueDetail.occurrences}次</span></div><div className="detail-block"><span>建议处理</span><p>{issueDetail.suggestedAction || '请人工审阅上下文。'}</p></div><div className="detail-block"><span>安全上下文</span><pre>{JSON.stringify(issueDetail.context || {}, null, 2)}</pre></div>{issueDetail.handling.map((event) => <div className="handling-row" key={event.id}><time>{event.time}</time><strong>{event.action}</strong><span>{event.note}</span></div>)}</div>}</></Drawer>
    <Modal open={snapshotOpen} onClose={() => setSnapshotOpen(false)} title="创建手动快照" eyebrow="NEW SNAPSHOT" footer={<><Button onClick={() => setSnapshotOpen(false)}>取消</Button><Button variant="primary" onClick={snapshot} disabled={!snapshotName.trim()} title={!snapshotName.trim() ? '请填写快照名称' : undefined}>创建快照</Button></>}><Field label="快照名称" required><input className="input" value={snapshotName} onChange={(e) => setSnapshotName(e.target.value)} /></Field></Modal>
    <Modal open={Boolean(issueAction)} onClose={() => { setIssueAction(null); setActionNote(''); }} title={issueAction?.status === 'ignored' ? '带原因忽略问题' : issueAction?.status === 'resolved' ? '记录解决结果' : '更新问题状态'} eyebrow="ISSUE HANDLING" footer={<><Button onClick={() => { setIssueAction(null); setActionNote(''); }}>取消</Button><Button variant="primary" onClick={handleIssue} disabled={!actionNote.trim()} title={!actionNote.trim() ? '必须填写处理说明' : undefined}>确认更新</Button></>}><Field label="处理说明" required hint="说明会永久保留在问题处理历史中"><textarea className="input textarea" value={actionNote} onChange={(e) => setActionNote(e.target.value)} /></Field></Modal>
    <ConfirmDialog open={Boolean(rollbackTarget)} onClose={() => setRollbackTarget(null)} onConfirm={rollback} title={`回滚到“${rollbackTarget?.label || ''}”？`} description="当前仅回滚Demo工作区状态并新增事件；不会覆盖真实嘉立创EDA工程。" confirmLabel="确认模拟回滚" danger />
    <ConfirmDialog open={Boolean(downloadType)} onClose={() => setDownloadType(null)} onConfirm={download} title={downloadType === 'diagnostic' ? '下载安全诊断包？' : '下载工程评审包？'} description="包含安全化问题与修改日志，明确标注DEMO ONLY，不包含API Key、Token或思维链。" confirmLabel="确认下载" />
  </>;
}
