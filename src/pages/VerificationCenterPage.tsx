import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { runtimeClient, RuntimeApiError } from '../services/runtimeClient';
import type { ApprovalLedgerView, GateEvidenceRef, PcbGateReport, GateSignoffRecord } from '../types';
import { Badge, Button, Field, Panel, Stat } from '../components/ui';

/** 多板工作流（W6-02）：绑定过的板子存在本机，切换板即切换整页证据/门禁上下文。 */
export interface BoardBinding { id: string; name: string; pcbUuid: string; projectUuid?: string | null }
const BOARDS_KEY = 'circuitpilot.boards.v1';

const loadBoards = (fallback: BoardBinding | null): BoardBinding[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(BOARDS_KEY) || '[]') as BoardBinding[];
    if (Array.isArray(parsed) && parsed.length) return parsed.filter((item) => item && item.pcbUuid);
  } catch { /* 坏数据按空处理，不阻塞页面 */ }
  return fallback ? [fallback] : [];
};

const verdictTone = (verdict: PcbGateReport['verdict']) => verdict === 'pass' ? 'success' : verdict === 'blocked' ? 'danger' : 'warning';
const verdictLabel = (verdict: PcbGateReport['verdict']) => verdict === 'pass' ? '通过' : verdict === 'blocked' ? '阻断' : '证据不足';

export function VerificationCenterPage() {
  const { state, notify } = useApp();
  const project = state.projects.find((item) => item.id === state.activeProjectId) ?? null;
  const fallback: BoardBinding | null = project?.edaWorkspace?.pcbUuid
    ? { id: project.edaWorkspace.pcbUuid, name: project.name || '当前工程', pcbUuid: project.edaWorkspace.pcbUuid, projectUuid: project.edaWorkspace.projectUuid ?? null }
    : null;
  const [boards, setBoards] = useState<BoardBinding[]>(() => loadBoards(fallback));
  const [selectedId, setSelectedId] = useState<string | null>(() => (loadBoards(fallback)[0]?.id ?? null));
  const [newName, setNewName] = useState('');
  const [newPcbUuid, setNewPcbUuid] = useState('');
  const [report, setReport] = useState<PcbGateReport | null>(null);
  const [refs, setRefs] = useState<GateEvidenceRef[]>([]);
  const [busy, setBusy] = useState<'status' | 'evaluate' | 'signoff' | 'ledger' | null>(null);
  const [error, setError] = useState('');
  const [signedBy, setSignedBy] = useState('lead');
  const [note, setNote] = useState('');
  const [signoff, setSignoff] = useState<GateSignoffRecord | null>(null);
  const [ledger, setLedger] = useState<ApprovalLedgerView | null>(null);
  const selected = useMemo(() => boards.find((item) => item.id === selectedId) ?? null, [boards, selectedId]);

  const persist = (next: BoardBinding[]) => {
    setBoards(next);
    try { window.localStorage.setItem(BOARDS_KEY, JSON.stringify(next)); } catch { /* 忽略存储失败：内存态仍可用 */ }
  };
  const fail = (caught: unknown, action: string) => {
    const detail = caught instanceof RuntimeApiError ? `[${caught.code}] ${caught.message}` : caught instanceof Error ? caught.message : '未知错误';
    setError(`${action}失败：${detail}`);
    notify(`${action}失败`, detail, 'danger');
  };
  const load = useCallback(async (action: 'status' | 'evaluate') => {
    if (!selected) { setError('请先选择或添加一块板（需要 PCB uuid）'); return; }
    setBusy(action); setError('');
    try {
      const result = action === 'evaluate' ? await runtimeClient.gatesEvaluate(selected.pcbUuid) : await runtimeClient.gatesStatus(selected.pcbUuid);
      setReport(result.report); setRefs(result.evidenceRefs ?? []); setSignoff(null);
    } catch (caught) { fail(caught, action === 'evaluate' ? '门禁评估' : '读取门禁状态'); } finally { setBusy(null); }
  }, [selected, notify]);
  useEffect(() => {
    if (!selected) return;
    (async () => {
      setBusy('status'); setError(''); setSignoff(null);
      try {
        const result = await runtimeClient.gatesStatus(selected.pcbUuid);
        setReport(result.report); setRefs(result.evidenceRefs ?? []);
      } catch (caught) { fail(caught, '读取门禁状态'); } finally { setBusy(null); }
    })();
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const addBoard = () => {
    const pcbUuid = newPcbUuid.trim();
    if (!pcbUuid) { setError('新增板需要 PCB uuid（不是板名占位）'); return; }
    if (boards.some((item) => item.pcbUuid === pcbUuid)) { setError('这块板已绑定'); return; }
    const board: BoardBinding = { id: pcbUuid, name: newName.trim() || pcbUuid.slice(0, 12), pcbUuid };
    persist([...boards, board]); setSelectedId(board.id); setNewName(''); setNewPcbUuid('');
  };
  const removeBoard = (id: string) => {
    const next = boards.filter((item) => item.id !== id);
    persist(next);
    if (selectedId === id) { setSelectedId(next[0]?.id ?? null); setReport(null); setRefs([]); setSignoff(null); }
  };
  const doSignoff = async (decision: 'approve' | 'reject') => {
    if (!selected) return;
    if (!signedBy.trim()) { setError('签字必须填写签字人'); return; }
    setBusy('signoff'); setError('');
    try {
      const result = await runtimeClient.gatesSignoff({ pcbUuid: selected.pcbUuid, signedBy: signedBy.trim(), decision, note: note.trim() });
      setSignoff(result.record); setReport(result.report);
      notify(decision === 'approve' ? '已签字放行' : '已驳回', `签字人：${result.record.signedBy}；门禁结论：${result.record.gateVerdict}`, decision === 'approve' ? 'success' : 'warning');
    } catch (caught) { fail(caught, decision === 'approve' ? '签字放行' : '驳回'); } finally { setBusy(null); }
  };
  const loadLedger = async () => {
    setBusy('ledger'); setError('');
    try { setLedger(await runtimeClient.gatesApprovals(50)); } catch (caught) { fail(caught, '读取批准账本'); } finally { setBusy(null); }
  };

  return (
    <div className="page-grid">
      <Panel title="多板工作流" eyebrow="BOARD SWITCH" meta="绑定过的板子会记住；切换后门禁/证据上下文随之切换">
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          {boards.map((board) => (
            <button type="button" key={board.id} className={`chip ${selectedId === board.id ? 'is-active' : ''}`} onClick={() => setSelectedId(board.id)} title={board.pcbUuid}>
              {selectedId === board.id ? '● ' : ''}{board.name}
              <span style={{ marginLeft: 6, opacity: 0.65 }}>{board.pcbUuid.slice(0, 8)}</span>
            </button>
          ))}
          {!boards.length && <span className="muted">还没有绑定板。可添加 PCB uuid，或先在「项目与资料」绑定 EDA 工程。</span>}
        </div>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <Field label="板名（可选）"><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="主控板 / 按键板" /></Field>
          <Field label="PCB uuid"><input value={newPcbUuid} onChange={(event) => setNewPcbUuid(event.target.value)} placeholder="EDA 里 PCB 文档 uuid" /></Field>
        </div>
        <div className="row-actions" style={{ marginTop: 8 }}>
          <Button onClick={addBoard} icon={<ShieldCheck size={14} />}>绑定这块板</Button>
          {selected && <Button variant="ghost" onClick={() => removeBoard(selected.id)}>移除当前板</Button>}
          <Button variant="ghost" loading={busy === 'ledger'} onClick={loadLedger}>批准账本</Button>
        </div>
      </Panel>

      <Panel title="门禁 G1~G6" eyebrow="RELEASE GATES" meta="缺证据=unknown，绝不默认通过；blocked 不得签字放行">
        {error && <div className="banner banner-danger"><AlertTriangle size={14} /> {error}</div>}
        {!report && <p className="muted">选择板子后自动读取门禁状态。<code>unknown</code> 表示证据不足，不是通过。</p>}
        {report && (
          <>
            <div className="stat-grid">
              <Stat label="全局结论" value={<Badge tone={verdictTone(report.verdict)}>{verdictLabel(report.verdict)}</Badge>} hint={report.targetPcbUuid ?? '未绑定 PCB'} />
              <Stat label="阻断门" value={report.blockedGates.length} tone={report.blockedGates.length ? 'danger' : 'neutral'} hint={report.blockedGates.join('、') || '—'} />
              <Stat label="证据不足门" value={report.unknownGates.length} tone={report.unknownGates.length ? 'warning' : 'neutral'} hint={report.unknownGates.join('、') || '—'} />
              <Stat label="证据条数" value={refs.length} hint="按 kind 取每类最新证据" />
            </div>
            <div className="gate-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginTop: 12 }}>
              {report.gates.map((gate) => (
                <div key={gate.id} className="panel" style={{ padding: 12 }} data-testid={`gate-${gate.id}`}>
                  <div className="row-actions" style={{ justifyContent: 'space-between' }}>
                    <strong>{gate.id} {gate.name}</strong>
                    <Badge tone={verdictTone(gate.verdict)}>{verdictLabel(gate.verdict)}</Badge>
                  </div>
                  <p className="muted" style={{ margin: '6px 0' }}>{gate.purpose}</p>
                  <small>需要证据：{gate.requiredKinds.join('、')}{gate.missing.length ? `（缺 ${gate.missing.join('、')}）` : ''}</small>
                  <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                    {gate.reasons.slice(0, 4).map((reason, index) => (
                      <li key={`${reason.code}-${index}`} style={{ marginBottom: 2 }}>
                        {reason.severity === 'blocking' ? <XCircle size={12} color="var(--red)" /> : reason.severity === 'unknown' ? <CircleDashed size={12} color="var(--yellow)" /> : <CheckCircle2 size={12} color="var(--green)" />}{' '}
                        {reason.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="row-actions" style={{ marginTop: 12 }}>
              <Button loading={busy === 'status'} icon={<RefreshCw size={14} />} onClick={() => load('status')}>重新读取</Button>
              <Button loading={busy === 'evaluate'} onClick={() => load('evaluate')}>评估并归档报告</Button>
            </div>
            <div className="form-grid" style={{ marginTop: 12 }}>
              <Field label="签字人"><input value={signedBy} onChange={(event) => setSignedBy(event.target.value)} placeholder="必须有名字" /></Field>
              <Field label="备注"><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="驳回/放行理由（可留空）" /></Field>
            </div>
            <div className="row-actions" style={{ marginTop: 8 }}>
              <Button loading={busy === 'signoff'} onClick={() => doSignoff('approve')} disabled={report.verdict !== 'pass'}>签字放行（仅 pass 可用）</Button>
              <Button variant="ghost" loading={busy === 'signoff'} onClick={() => doSignoff('reject')}>驳回并记录</Button>
            </div>
            {signoff && <div className="banner" style={{ marginTop: 10 }}><ShieldCheck size={14} /> 签字记录：{signoff.decision === 'approve' ? '放行' : '驳回'} · {signoff.signedBy} · {signoff.signedAt} · 报告摘要 {signoff.reportDigest.slice(0, 12)}…</div>}
            <div style={{ marginTop: 10 }}>
              <small>本次评估使用的证据：</small>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {refs.map((ref) => <li key={`${ref.kind}-${ref.digest}`}><code>{ref.kind}</code> · {ref.digest.slice(0, 12)}… · {ref.path}</li>)}
                {!refs.length && <li className="muted">没有证据（所以门禁不可能 pass）</li>}
              </ul>
            </div>
          </>
        )}
      </Panel>

      {ledger && (
        <Panel title="批准账本" eyebrow="APPROVAL LEDGER" meta="只追加哈希链；链校验失败即视为不可信">
          <p>链状态：<Badge tone={ledger.chain.ok ? 'success' : 'danger'}>{ledger.chain.ok ? '完整' : `断在 #${ledger.chain.brokenAt}`}</Badge> · 记录 {ledger.summary.total} 条</p>
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
            {ledger.entries.slice(-8).reverse().map((entry) => <li key={entry.index}>#{entry.index} {entry.at} {entry.scope}/{entry.action} {entry.note || ''}</li>)}
          </ul>
        </Panel>
      )}
    </div>
  );
}
