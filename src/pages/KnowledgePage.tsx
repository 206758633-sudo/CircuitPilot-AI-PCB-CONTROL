import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, Bot, CheckCircle2, CloudDownload, Database, FileSearch, RefreshCw, Search, ShieldQuestion, Wrench } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { runtimeClient, RuntimeApiError } from '../services/runtimeClient';
import type { KnowledgeAgentCycle, KnowledgeAgentManagerStatus, KnowledgeAgentSchedulerStatus, KnowledgeEntryView, KnowledgeHealth, KnowledgeReviewQueueView, RagHit, RagStatus } from '../types';
import { Badge, Button, Field, Panel, SegmentedTabs, Stat } from '../components/ui';

const stateTone = (state: string) => state === 'approved' ? 'success' : state === 'rejected' ? 'danger' : 'warning';
const trustLabel: Record<string, string> = { authoritative: '权威', reference: '参考', unverified: '未核验' };

/** 知识库（W3-17）：查询/审核/冲突/过期/健康度；AI/采集器只能产候选，人工审核后才可用于门禁。 */
export type KnowledgeTab = 'overview' | 'rag' | 'review' | 'entries' | 'badcases' | 'contribute';

export function KnowledgePage({ initialTab = 'overview' }: { initialTab?: KnowledgeTab } = {}) {
  const { notify } = useApp();
  const [health, setHealth] = useState<KnowledgeHealth | null>(null);
  const [queue, setQueue] = useState<KnowledgeReviewQueueView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reviewer, setReviewer] = useState('lead');
  const [kind, setKind] = useState('');
  const [text, setText] = useState('');
  const [entries, setEntries] = useState<KnowledgeEntryView[]>([]);
  const [total, setTotal] = useState(0);
  const [conflictKey, setConflictKey] = useState('');
  const [conflicts, setConflicts] = useState<Array<{ field: string; values: Array<{ id: string; value: unknown }> }>>([]);
  const [newKind, setNewKind] = useState<'part' | 'module' | 'rule' | 'failure'>('part');
  const [newTitle, setNewTitle] = useState('');
  const [newPayload, setNewPayload] = useState('{}');
  const [newSource, setNewSource] = useState('manual');
  const [agentScheduler, setAgentScheduler] = useState<KnowledgeAgentSchedulerStatus | null>(null);
  const [agentManager, setAgentManager] = useState<KnowledgeAgentManagerStatus | null>(null);
  const [agentCycle, setAgentCycle] = useState<KnowledgeAgentCycle | null>(null);
  const [badcases, setBadcases] = useState<KnowledgeEntryView[]>([]);
  const [rag, setRag] = useState<RagStatus | null>(null);
  const [ragQueryText, setRagQueryText] = useState('');
  const [ragHits, setRagHits] = useState<RagHit[]>([]);
  const [ragMeta, setRagMeta] = useState<{ total: number; mode: string; query: string } | null>(null);
  const [tab, setTab] = useState<KnowledgeTab>(initialTab);
  const [reviewFilter, setReviewFilter] = useState<'' | 'candidate' | 'approved' | 'rejected'>('');
  const [trustFilter, setTrustFilter] = useState('');
  const [includeExpired, setIncludeExpired] = useState(true);

  const fail = (caught: unknown, action: string) => {
    const detail = caught instanceof RuntimeApiError ? `[${caught.code}] ${caught.message}` : caught instanceof Error ? caught.message : '未知错误';
    setError(`${action}失败：${detail}`);
    notify(`${action}失败`, detail, 'danger');
  };
  const refresh = useCallback(async () => {
    setBusy('refresh'); setError('');
    try {
      const [healthResult, queueResult, agentResult] = await Promise.all([
        runtimeClient.knowledgeHealth(),
        runtimeClient.knowledgeReviewQueue(),
        runtimeClient.knowledgeAgentStatus().catch(() => null),
      ]);
      setHealth(healthResult.metrics); setQueue(queueResult);
      if (agentResult) { setAgentScheduler(agentResult.scheduler); setAgentManager(agentResult.manager); }
      const ragResult = await runtimeClient.ragStatus().catch(() => null);
      if (ragResult) setRag(ragResult.rag);
    } catch (caught) { fail(caught, '读取知识库状态'); } finally { setBusy(null); }
  }, [notify]);
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async () => {
    setBusy('search'); setError('');
    try {
      const result = await runtimeClient.knowledgeList({ kind: kind || undefined, trust: trustFilter || undefined, reviewState: reviewFilter || undefined, text: text.trim() || undefined, includeExpired });
      setEntries(result.knowledge.entries); setTotal(result.knowledge.total);
    } catch (caught) { fail(caught, '检索知识'); } finally { setBusy(null); }
  };
  const review = async (id: string, state: 'approved' | 'rejected') => {
    if (!reviewer.trim()) { setError('审核必须填写审核人'); return; }
    setBusy(`review:${id}`); setError('');
    try {
      await runtimeClient.knowledgeReview(id, { state, reviewedBy: reviewer.trim() });
      notify(state === 'approved' ? '已通过审核' : '已驳回', `审核人：${reviewer}`, state === 'approved' ? 'success' : 'warning');
      await refresh();
      if (entries.length) await search();
    } catch (caught) { fail(caught, '审核知识'); } finally { setBusy(null); }
  };
  const rebuildRag = async () => {
    setBusy('rag:reindex'); setError('');
    try {
      const result = await runtimeClient.ragReindex();
      notify('RAG 索引已重建', `${result.rag.docs} 文档 / ${result.rag.chunks} 块 / ${result.rag.terms} 词项`, 'success');
      setRag(await runtimeClient.ragStatus().then((status) => status.rag).catch(() => null));
    } catch (caught) { fail(caught, '重建 RAG 索引'); } finally { setBusy(null); }
  };
  const runRagQuery = async () => {
    if (!ragQueryText.trim()) { setError('请输入 RAG 检索问题'); return; }
    setBusy('rag:query'); setError('');
    try {
      const result = await runtimeClient.ragQuery({ query: ragQueryText.trim(), topK: 8 });
      setRagHits(result.rag.results); setRagMeta({ total: result.rag.total, mode: result.rag.mode, query: result.rag.query });
    } catch (caught) { fail(caught, 'RAG 检索'); } finally { setBusy(null); }
  };
  const runAgent = async (task: 'all' | 'badcases' | 'web' | 'maintain') => {
    setBusy(`agent:${task}`); setError('');
    try {
      const result = await runtimeClient.knowledgeAgentRun(task);
      setAgentCycle(result.cycle);
      const created = (result.cycle.badcases?.created ?? 0) + (result.cycle.web?.created ?? 0);
      notify(result.ok ? 'KMA 运行完成' : 'KMA 部分任务失败', `新增候选 ${created} 条；仍需人工审核`, result.ok ? 'success' : 'warning');
      await refresh();
      if (badcases.length) await loadBadcases();
    } catch (caught) { fail(caught, '运行知识管理 Agent'); } finally { setBusy(null); }
  };
  const loadBadcases = async () => {
    setBusy('badcases'); setError('');
    try {
      const result = await runtimeClient.knowledgeBadcases(30);
      setBadcases(result.badcases);
    } catch (caught) { fail(caught, '读取 badcase'); } finally { setBusy(null); }
  };
  const createEntry = async () => {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(newPayload); } catch (caught) { setError(`payload JSON 解析失败：${(caught as Error).message}`); return; }
    if (!newTitle.trim()) { setError('标题不能为空'); return; }
    setBusy('create'); setError('');
    try {
      const result = await runtimeClient.knowledgeSave({ kind: newKind, title: newTitle.trim(), payload, provenance: { source: newSource.trim() || 'manual' }, trust: 'unverified' });
      notify(result.created ? '已新增候选条目' : '同内容条目已存在（已更新元数据）', `${newKind} · ${newTitle} · 仍是 candidate，需人工审核`, 'info');
      setNewTitle(''); setNewPayload('{}');
      await refresh();
    } catch (caught) { fail(caught, '新增知识条目'); } finally { setBusy(null); }
  };
  const checkConflicts = async () => {
    if (!conflictKey.trim()) { setError('请输入 entityKey（料号/模块号/规则号）'); return; }
    setBusy('conflicts'); setError('');
    try {
      const result = await runtimeClient.knowledgeConflicts(conflictKey.trim());
      setConflicts(result.conflicts);
    } catch (caught) { fail(caught, '冲突检测'); } finally { setBusy(null); }
  };

  const tabs = [
    { value: 'overview', label: '概览' },
    { value: 'rag', label: 'RAG 检索' },
    { value: 'review', label: '审核队列', count: queue?.candidateCount },
    { value: 'entries', label: '知识条目', count: total || undefined },
    { value: 'badcases', label: 'badcase', count: agentManager?.badcases.pendingReview || undefined },
    { value: 'contribute', label: '贡献' },
  ];

  return (
    <div className="page-grid">
      <Panel
        title="知识库功能区"
        eyebrow="KNOWLEDGE WORKBENCH"
        meta="知识 = 可追溯、可审核、可失效的工程依据；AI/采集器只产 candidate，approved 才能进门禁引用"
        actions={<Button loading={busy === 'refresh'} icon={<RefreshCw size={14} />} onClick={refresh}>刷新</Button>}
      >
        <div className="stat-grid">
          <Stat label="条目总数" value={health?.total ?? '—'} hint={health ? `part ${health.byKind.part ?? 0} · module ${health.byKind.module ?? 0} · rule ${health.byKind.rule ?? 0} · failure ${health.byKind.failure ?? 0}` : '读取中'} />
          <Stat label="待审候选" value={queue?.candidateCount ?? '—'} tone={queue?.candidateCount ? 'warning' : 'neutral'} hint="审核通过前不可用于门禁" />
          <Stat label="门禁可用" value={health?.approved ?? '—'} tone={health?.approved ? 'success' : 'warning'} hint="approved 且未过期" />
          <Stat label="过期属性" value={health?.expired ?? '—'} tone={health?.expired ? 'warning' : 'neutral'} hint={health ? `过期率 ${(health.expiredRate * 100).toFixed(1)}%` : ''} />
          <Stat label="冲突" value={health?.conflictKeys ?? '—'} tone={health?.conflictKeys ? 'danger' : 'neutral'} hint={health ? `冲突率 ${(health.conflictRate * 100).toFixed(1)}%` : ''} />
          <Stat label="RAG 索引" value={rag?.built ? `${rag.docs} 文档` : '未构建'} tone={rag?.built ? 'success' : 'warning'} hint={rag?.built ? `${rag.chunks} 块 · ${rag.terms} 词项` : '到「RAG 检索」一键构建'} />
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <SegmentedTabs items={tabs} value={tab} onChange={(value) => setTab(value as typeof tab)} label="知识库功能分区" />
          <span className="muted" style={{ marginLeft: 'auto' }}>审核人：</span><input value={reviewer} onChange={(event) => setReviewer(event.target.value)} style={{ width: 130 }} placeholder="审核人" aria-label="审核人" />
        </div>
        {error && <div className="banner banner-danger" style={{ marginTop: 8 }}><AlertTriangle size={14} /> {error}</div>}
      </Panel>

      {tab === 'overview' && (
        <>
          <Panel title="知识库健康度" eyebrow="KNOWLEDGE HEALTH" meta="覆盖率/过期率/冲突率/命中率；候选不等于可用">
            {health && (
              <div className="stat-grid">
                <Stat label="条目总数" value={health.total} hint={`part ${health.byKind.part ?? 0} · module ${health.byKind.module ?? 0} · rule ${health.byKind.rule ?? 0} · failure ${health.byKind.failure ?? 0}`} />
                <Stat label="门禁可用（approved）" value={health.approved} tone={health.approved ? 'success' : 'warning'} hint={`待审 ${health.candidates}`} />
                <Stat label="过期条目" value={health.expired} tone={health.expired ? 'warning' : 'neutral'} hint={`过期率 ${(health.expiredRate * 100).toFixed(1)}%`} />
                <Stat label="冲突 entityKey" value={health.conflictKeys} tone={health.conflictKeys ? 'danger' : 'neutral'} hint={`冲突率 ${(health.conflictRate * 100).toFixed(1)}%`} />
                <Stat label="命中率" value={`${(health.hitRate * 100).toFixed(1)}%`} hint="被 agent 引用过的条目占比" />
                <Stat label="类型覆盖" value={`${(health.coverage * 100).toFixed(0)}%`} hint="四类知识的覆盖程度" />
              </div>
            )}
            <p className="muted" style={{ marginTop: 8 }}>健康度是“知识是否可用”的体检；具体条目请在「知识条目 / 审核队列」处理。</p>
          </Panel>

          <Panel title="知识管理 Agent（KMA）" eyebrow="KNOWLEDGE MANAGER" meta="badcase 采集 / 定时网页抓取 / 定期维护；只产 candidate，不自动放行">
            <div className="row-actions" style={{ marginBottom: 8 }}>
              <Button loading={busy === 'agent:badcases'} icon={<Wrench size={14} />} onClick={() => runAgent('badcases')}>采集 badcase</Button>
              <Button loading={busy === 'agent:web'} icon={<CloudDownload size={14} />} onClick={() => runAgent('web')}>抓取网页知识</Button>
              <Button loading={busy === 'agent:maintain'} icon={<RefreshCw size={14} />} onClick={() => runAgent('maintain')}>立即维护</Button>
              <Button loading={busy === 'agent:all'} icon={<Bot size={14} />} onClick={() => runAgent('all')}>全部运行</Button>
            </div>
            <div className="stat-grid">
              <Stat label="调度" value={agentScheduler ? (agentScheduler.enabled ? '已启用' : '已停止') : '—'} tone={agentScheduler?.enabled ? 'success' : 'neutral'} hint={agentScheduler ? `间隔 ${Math.round(agentScheduler.intervalMs / 3600000)} 小时${agentScheduler.running ? ' · 运行中' : ''}` : '读取中'} />
              <Stat label="上次运行" value={agentScheduler?.lastRunAt ? new Date(agentScheduler.lastRunAt).toLocaleString() : '尚未运行'} hint={agentScheduler?.lastResult ? `新增 badcase ${agentScheduler.lastResult.badcases?.created ?? 0} · 网页 ${agentScheduler.lastResult.web?.created ?? 0}` : '等待首轮'} />
              <Stat label="下次运行" value={agentScheduler?.nextRunAt ? new Date(agentScheduler.nextRunAt).toLocaleString() : '—'} hint="可在设置关闭自动维护" />
              <Stat label="badcase 候选" value={agentManager?.badcases.count ?? 0} tone={agentManager?.badcases.pendingReview ? 'warning' : 'neutral'} hint={`待审 ${agentManager?.badcases.pendingReview ?? 0} 条`} />
              <Stat label="网页采集主题" value={agentManager?.webCollectors ?? 0} hint="白名单域名 + 每轮配额" />
              <Stat label="证据源" value={agentManager?.evidenceRoot ? '已配置' : '未配置'} tone={agentManager?.evidenceRoot ? 'neutral' : 'warning'} hint={agentManager?.evidenceRoot ?? '无证据目录时不产 badcase'} />
            </div>
            {agentCycle && (
              <div className={`banner ${agentCycle.ok ? 'banner-info' : 'banner-warning'}`} style={{ marginTop: 8 }}>
                <Bot size={14} /> 本轮结果：badcase 新增 {agentCycle.badcases?.created ?? 0} 条（重复 {agentCycle.badcases?.duplicates ?? 0}）；
                网页新增 {agentCycle.web?.created ?? 0} 条（失败源 {agentCycle.web?.failed?.length ?? 0} 个）；待审 {agentCycle.maintenance?.pendingReview ?? '—'} 条。
              </div>
            )}
            <p className="muted" style={{ marginTop: 8 }}>badcase 明细在「badcase」分区；采集与维护只写 candidate，不会自动成为门禁依据。</p>
          </Panel>
        </>
      )}

      {tab === 'rag' && (
        <Panel title="RAG 检索（本地混合索引）" eyebrow="RETRIEVAL-AUGMENTED" meta="知识库 + 工程文档；BM25 词法 + 特征哈希向量语义；只提供依据，不构成放行">
          <div className="stat-grid">
            <Stat label="索引状态" value={rag?.built ? '已构建' : rag?.loadError ? '损坏待重建' : '未构建'} tone={rag?.built ? 'success' : 'warning'} hint={rag?.builtAt ? `构建于 ${new Date(rag.builtAt).toLocaleString()}` : '首次检索/重建时生成'} />
            <Stat label="文档 / 块" value={rag ? `${rag.docs} / ${rag.chunks}` : '—'} hint={rag?.corpus ? `知识 ${rag.corpus.knowledge} · 文档 ${rag.corpus.docs}` : '语料来源'} />
            <Stat label="词项 / 维度" value={rag ? `${rag.terms} / ${rag.dims}` : '—'} hint="中文 bigram + 英文 token；向量 384 维" />
            <Stat label="上次检索" value={rag?.lastQueryAt ? new Date(rag.lastQueryAt).toLocaleTimeString() : '—'} hint={rag?.file ? rag.file.split('/').slice(-2).join('/') : '索引文件'} />
          </div>
          {rag?.loadError && <div className="banner banner-warning"><AlertTriangle size={14} /> 索引载入失败（{rag.loadError.code}），下次检索会自动重建：{rag.loadError.message}</div>}
          <div className="row-actions" style={{ marginTop: 8 }}>
            <Button loading={busy === 'rag:reindex'} icon={<Database size={14} />} onClick={rebuildRag}>重建索引</Button>
            <input value={ragQueryText} onChange={(event) => setRagQueryText(event.target.value)} placeholder="例如：阻抗控制 叠层 怎么算 / 立创封装 不匹配 怎么处理" style={{ minWidth: 320 }} onKeyDown={(event) => { if (event.key === 'Enter') runRagQuery(); }} aria-label="RAG 检索问题" />
            <Button loading={busy === 'rag:query'} icon={<FileSearch size={14} />} onClick={runRagQuery}>检索</Button>
          </div>
          {ragMeta && <p className="muted">检索「{ragMeta.query}」：命中 {ragMeta.total} 块（{ragMeta.mode} 混合排序）。</p>}
          {ragHits.length > 0 && (
            <table className="table" style={{ marginTop: 8 }}>
              <thead><tr><th>分数</th><th>标题 / 片段</th><th>类型</th><th>来源</th></tr></thead>
              <tbody>
                {ragHits.map((hit) => (
                  <tr key={hit.chunkId}>
                    <td><Badge tone="info">{hit.score.toFixed(3)}</Badge></td>
                    <td><strong>{hit.title}</strong>{hit.heading && hit.heading !== hit.title ? ` · ${hit.heading}` : ''}<br /><small className="muted">{hit.text.slice(0, 160)}…</small></td>
                    <td>{hit.kind === 'knowledge' ? <Badge tone="warning">知识库</Badge> : <Badge tone="neutral">文档</Badge>}</td>
                    <td><small className="muted">{hit.knowledgeId ?? hit.path ?? '—'}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      {tab === 'review' && (
        <Panel title="审核队列" eyebrow="REVIEW QUEUE" meta="AI/采集器只能产 candidate；approved 才能进门禁引用">
          {queue && queue.candidateCount === 0 && <p className="muted">没有待审条目。{queue.conflictCount ? `另有 ${queue.conflictCount} 个 entityKey 存在多源冲突。` : ''}</p>}
          {queue && queue.candidateCount > 0 && (
            <table className="table">
              <thead><tr><th>类型</th><th>标题</th><th>可信等级</th><th>entityKey</th><th>操作</th></tr></thead>
              <tbody>
                {queue.candidates.slice(0, 50).map((entry) => (
                  <tr key={entry.id}>
                    <td><Badge tone="info">{entry.kind}</Badge></td>
                    <td>{entry.title}<br /><small className="muted"><code>{entry.id}</code></small></td>
                    <td><Badge tone="warning">{trustLabel[entry.trust] ?? entry.trust}</Badge></td>
                    <td><code>{entry.entityKey ?? '—'}</code></td>
                    <td className="row-actions">
                      <Button size="sm" loading={busy === `review:${entry.id}`} onClick={() => review(entry.id, 'approved')}>通过</Button>
                      <Button size="sm" variant="ghost" onClick={() => review(entry.id, 'rejected')}>驳回</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {queue && queue.expiredCount > 0 && <p className="muted">另有 {queue.expiredCount} 条已过期（不会进入门禁/引用）。</p>}
          <p className="muted" style={{ marginTop: 8 }}>审核前请核对来源与证据；批量审核请走委托审核流程并记录 reviewedBy。</p>
        </Panel>
      )}

      {tab === 'entries' && (
        <Panel title="检索与冲突" eyebrow="ENTRIES & CONFLICT" meta="结构化/全文检索；同 entityKey 多源矛盾需人工裁决">
          <div className="form-grid">
            <Field label="类型"><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">全部</option><option value="part">part</option><option value="module">module</option><option value="rule">rule</option><option value="failure">failure</option></select></Field>
            <Field label="审核状态"><select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as typeof reviewFilter)}><option value="">全部</option><option value="candidate">candidate（待审）</option><option value="approved">approved（可用）</option><option value="rejected">rejected（驳回）</option></select></Field>
            <Field label="可信等级"><select value={trustFilter} onChange={(event) => setTrustFilter(event.target.value)}><option value="">全部</option><option value="authoritative">authoritative</option><option value="reference">reference</option><option value="unverified">unverified</option></select></Field>
            <Field label="全文关键词"><input value={text} onChange={(event) => setText(event.target.value)} placeholder="料号/封装/网络/规则名" /></Field>
          </div>
          <div className="row-actions" style={{ marginTop: 8 }}>
            <Button loading={busy === 'search'} icon={<Search size={14} />} onClick={search}>检索</Button>
            <label className="muted" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={includeExpired} onChange={(event) => setIncludeExpired(event.target.checked)} /> 包含过期</label>
            <span className="muted">命中 {total} 条</span>
          </div>
          {entries.length > 0 && (
            <table className="table" style={{ marginTop: 8 }}>
              <thead><tr><th>类型</th><th>标题</th><th>可信</th><th>审核</th><th>entityKey</th><th>操作</th></tr></thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.kind}</td>
                    <td>{entry.title}<br /><small className="muted"><code>{entry.id}</code></small></td>
                    <td>{trustLabel[entry.trust] ?? entry.trust}</td>
                    <td><Badge tone={stateTone(entry.review.state)}>{entry.review.state}</Badge>{entry.expired ? ' 已过期' : ''}</td>
                    <td><code>{entry.entityKey ?? '—'}</code></td>
                    <td className="row-actions">
                      {entry.review.state === 'candidate' ? (
                        <>
                          <Button size="sm" loading={busy === `review:${entry.id}`} onClick={() => review(entry.id, 'approved')}>通过</Button>
                          <Button size="sm" variant="ghost" onClick={() => review(entry.id, 'rejected')}>驳回</Button>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!entries.length && <p className="muted" style={{ marginTop: 8 }}>尚未检索。可按类型/审核状态/可信等级筛选后检索。</p>}
          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field label="entityKey（冲突检测）"><input value={conflictKey} onChange={(event) => setConflictKey(event.target.value)} placeholder="C114586 / REQ-1 / ERC_PIN_FLOATING" /></Field>
          </div>
          <div className="row-actions" style={{ marginTop: 8 }}>
            <Button loading={busy === 'conflicts'} icon={<ShieldQuestion size={14} />} onClick={checkConflicts}>检测冲突</Button>
          </div>
          {conflicts.length > 0 && (
            <div className="banner banner-warning" style={{ marginTop: 8 }}>
              <BookOpen size={14} /> 发现 {conflicts.length} 个字段多源矛盾：
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {conflicts.map((conflict) => (
                  <li key={conflict.field}><strong>{conflict.field}</strong>：{conflict.values.map((item) => `${item.id} = ${JSON.stringify(item.value)}`).join(' / ')}</li>
                ))}
              </ul>
            </div>
          )}
          {!conflicts.length && <p className="muted" style={{ marginTop: 8 }}><CheckCircle2 size={12} /> 未检测或暂无冲突（只比较 approved 条目；未审核条目不算权威矛盾）。</p>}
        </Panel>
      )}

      {tab === 'badcases' && (
        <>
          <Panel title="badcase 候选" eyebrow="BADCASES" meta="来自真实证据的 blocked/unknown 缺陷归并；仍是 candidate，需人工审核">
            <div className="row-actions" style={{ marginBottom: 8 }}>
              <Button loading={busy === 'agent:badcases'} icon={<Wrench size={14} />} onClick={() => runAgent('badcases')}>采集 badcase</Button>
              <Button variant="ghost" loading={busy === 'badcases'} icon={<Search size={14} />} onClick={loadBadcases}>刷新列表</Button>
            </div>
            {agentCycle && (
              <div className={`banner ${agentCycle.ok ? 'banner-info' : 'banner-warning'}`} style={{ marginTop: 8 }}>
                <Bot size={14} /> 本轮：badcase 新增 {agentCycle.badcases?.created ?? 0} 条（重复 {agentCycle.badcases?.duplicates ?? 0}）。
                {agentCycle.maintenance?.evidencePath ? <> 维护报告：<code>{agentCycle.maintenance.evidencePath}</code></> : null}
              </div>
            )}
            {badcases.length > 0 ? (
              <table className="table" style={{ marginTop: 8 }}>
                <thead><tr><th>badcase</th><th>来源证据</th><th>审核</th><th>操作</th></tr></thead>
                <tbody>
                  {badcases.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.title}<br /><small className="muted"><code>{entry.id}</code></small></td>
                      <td><small className="muted">{String(entry.provenance?.url ?? entry.provenance?.source ?? '—')}</small></td>
                      <td><Badge tone={stateTone(entry.review.state)}>{entry.review.state}</Badge></td>
                      <td className="row-actions">
                        {entry.review.state === 'candidate' ? (
                          <>
                            <Button size="sm" loading={busy === `review:${entry.id}`} onClick={() => review(entry.id, 'approved')}>通过</Button>
                            <Button size="sm" variant="ghost" onClick={() => review(entry.id, 'rejected')}>驳回</Button>
                          </>
                        ) : <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted" style={{ marginTop: 8 }}>暂无 badcase 候选（点击“采集 badcase”，或等 KMA 定时扫描证据目录）。</p>}
          </Panel>
        </>
      )}

      {tab === 'contribute' && (
        <Panel title="新增候选条目" eyebrow="CONTRIBUTE" meta="任何写入都是 candidate；审核通过前不可用于门禁">
          <div className="form-grid">
            <Field label="类型">
              <select value={newKind} onChange={(event) => setNewKind(event.target.value as typeof newKind)}>
                <option value="part">part</option><option value="module">module</option><option value="rule">rule</option><option value="failure">failure</option>
              </select>
            </Field>
            <Field label="标题"><input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="例如 WS2812B-2020" /></Field>
            <Field label="来源"><input value={newSource} onChange={(event) => setNewSource(event.target.value)} placeholder="manual / lcsc / web" /></Field>
          </div>
          <Field label="payload（JSON）" hint="part 需 lcscId/mpn/url 或 value+footprint；module/rule/failure 需 moduleId/ruleId/failureId">
            <textarea value={newPayload} onChange={(event) => setNewPayload(event.target.value)} rows={5} spellCheck={false} />
          </Field>
          <div className="row-actions" style={{ marginTop: 8 }}>
            <Button loading={busy === 'create'} onClick={createEntry}>提交候选</Button>
            <span className="muted">提交后进入审核队列，不会自动变成 approved。</span>
          </div>
        </Panel>
      )}
    </div>
  );
}
