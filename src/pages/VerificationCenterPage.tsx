import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { runtimeClient, RuntimeApiError } from '../services/runtimeClient';
import type { ApprovalLedgerView, GateEvidenceRef, GatesCollectResult, KnowledgeGateAdviceResult, PcbGateReport, PcbGateResult, GateSignoffRecord, SupplyPricingEvidence } from '../types';
import { Badge, Button, Field, Panel, Stat } from '../components/ui';
import { buildBoardSpec, buildGateComponents, formatIntentNetlistText, parseIntentNetlistText, readReviewedNetlistHandoff, summarizeGateComponentSources } from '../services/gateEvidenceInputs';

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

const verdictTone = (verdict: PcbGateResult['verdict']) => verdict === 'pass' ? 'success' : verdict === 'blocked' ? 'danger' : verdict === 'not-implemented' ? 'neutral' : 'warning';
const verdictLabel = (verdict: PcbGateResult['verdict']) => verdict === 'pass' ? '通过' : verdict === 'blocked' ? '阻断' : verdict === 'not-implemented' ? '未实现' : '证据不足';

/**
 * P0-1（2026-11-05 全链审计）：每道门"缺什么、在产品内去哪儿补"的人话解释。
 * 门禁 reason 是给机器的 code；只显示 code 用户无法闭环，所以逐门给出可执行的补输入路径。
 */
const GATE_INPUT_HINTS: Record<string, string> = {
  G1: '补输入：上方「取证输入」填板卡层数/宽/高，并确认需求状态为“已确认”——Runtime 才会 buildDesignSpec。',
  G2: '补输入：先在「项目与资料」为器件绑定 EDA 库；取证时自动查供应商价格/库存；缺源器件会如实报错。',
  G3: '补输入：上方「意图网表」粘贴 JSON，或先在 EDA 页生成已审核网表（会自动载入）。',
  G4: '补输入：先在验证页跑官方 ERC/DRC 取证；没有报告不能当规则通过。',
  G5: '补输入：在布局页完成真实写回（确认框 + 一次性写批准），服务端据此落 G5 证据。',
  G6: '补输入：先产出制造放行报告（Gerber/BOM/CPL/DRC 一致）再回来评估。',
};
const MISSING_KIND_HINTS: Record<string, string> = {
  'design-spec': 'G1 规格门：在「取证输入」补齐板卡层数/宽/高后重新取证',
  'lib-evidence': 'G2 器件身份门：缺 EDA 库绑定或供应商定价/库存（本次已自动查询，缺的照实报）',
  'netlist-diff': 'G3 网表门：在「意图网表」粘贴 JSON，或先在 EDA 页生成已审核网表',
  rules: 'G4 规则门：先跑官方 ERC/DRC 取证',
  placement: 'G5 布局门：在布局页完成真实写回（带人工确认）',
  'fabrication-release': 'G6 制造门：先产出制造放行证据',
};

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
  const [advice, setAdvice] = useState<KnowledgeGateAdviceResult | null>(null);
  const [busy, setBusy] = useState<'status' | 'evaluate' | 'collect' | 'signoff' | 'ledger' | null>(null);
  const [collected, setCollected] = useState<GatesCollectResult | null>(null);
  const [error, setError] = useState('');
  const [signedBy, setSignedBy] = useState('lead');
  const [note, setNote] = useState('');
  const [signoff, setSignoff] = useState<GateSignoffRecord | null>(null);
  const [ledger, setLedger] = useState<ApprovalLedgerView | null>(null);
  const selected = useMemo(() => boards.find((item) => item.id === selectedId) ?? null, [boards, selectedId]);
  // P0-1：G1 板卡规格 / G3 意图网表的产品输入通道。
  // 修复前这里只传 requirements（specInput 没有 boards）且从不传 intentNetlist，G1/G3 永远 blocked。
  const [boardLayers, setBoardLayers] = useState('');
  const [boardWidthMm, setBoardWidthMm] = useState('');
  const [boardHeightMm, setBoardHeightMm] = useState('');
  const [intentText, setIntentText] = useState('');
  const [intentError, setIntentError] = useState('');
  const [intentSourceAt, setIntentSourceAt] = useState('');
  const [supplyNote, setSupplyNote] = useState('');
  const boardSpec = useMemo(
    () => buildBoardSpec({ id: selected?.pcbUuid, name: selected?.name, layers: boardLayers, widthMm: boardWidthMm, heightMm: boardHeightMm }),
    [selected, boardLayers, boardWidthMm, boardHeightMm],
  );

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
      setReport(result.report); setRefs(result.evidenceRefs ?? []); setAdvice(result.knowledgeAdvice ?? null); setSignoff(null);
    } catch (caught) { fail(caught, action === 'evaluate' ? '门禁评估' : '读取门禁状态'); } finally { setBusy(null); }
  }, [selected, notify]);
  useEffect(() => {
    if (!selected) return;
    (async () => {
      setBusy('status'); setError(''); setSignoff(null);
      try {
        const result = await runtimeClient.gatesStatus(selected.pcbUuid);
        setReport(result.report); setRefs(result.evidenceRefs ?? []); setAdvice(result.knowledgeAdvice ?? null);
      } catch (caught) { fail(caught, '读取门禁状态'); } finally { setBusy(null); }
    })();
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // G3 交接：EDA 页生成/校验成功后会写 sessionStorage；这里只在挂载时补默认值，
  // 用 `current || ...` 保证不覆盖用户已经填过的意图网表。
  useEffect(() => {
    const handoff = readReviewedNetlistHandoff();
    if (!handoff) return;
    setIntentText((current) => current || formatIntentNetlistText(handoff));
    setIntentSourceAt(handoff.createdAt);
  }, []);

  /**
   * P0-2（复审 2026-10-29）：六门取证入口。
   * 修复前 G2–G4 有证据生产者（ERC/DRC/网表/器件/规格），但产品入口没有按钮调用它们：
   * 用户只能看到"证据不足"，无法在 UI 里补齐。这里只采集真实证据并如实回报 saved/missing。
   */
  const collectEvidence = async () => {
    if (!selected) { setError('请先选择或添加一块板（需要 PCB uuid）'); return; }
    const intent = parseIntentNetlistText(intentText);
    if (intent.error) {
      // 坏 JSON 直接阻断本次取证：不能把解析失败的空内容当成"没有意图网表"悄悄继续。
      setIntentError(intent.error);
      setError('意图网表不是合法 JSON：请先修好再取证');
      return;
    }
    setIntentError('');
    setBusy('collect'); setError(''); setCollected(null); setSupplyNote('');
    try {
      const confirmedRequirements = state.requirements.filter((item) => item.status === 'confirmed');
      // G2：供应商证据必须来自真实查询。查询失败只在页面记 warning；器件仍照实传 eda，
      // 没查到 supply 的器件会让 G2 报缺供应商来源，而不是被前端补一个假对象骗成 pass。
      const lcscIds = [...new Set(state.components.map((item) => item.lcscId.trim()).filter(Boolean))];
      let pricing: SupplyPricingEvidence | null = null;
      let pricingError = '';
      if (lcscIds.length) {
        try { pricing = await runtimeClient.supplyPricing({ lcscIds }); }
        catch (caught) {
          pricingError = caught instanceof RuntimeApiError ? `[${caught.code}] ${caught.message}` : caught instanceof Error ? caught.message : '未知错误';
        }
      }
      const components = buildGateComponents(state.components, pricing);
      const sourceSummary = summarizeGateComponentSources(components);
      setSupplyNote(pricingError
        ? `供应商证据查询失败：${pricingError}。本次不伪造 supply——没查到的器件会让 G2 报缺供应商来源。`
        : pricing
          ? `供应商证据：${sourceSummary.withSupply}/${sourceSummary.total} 件有定价/库存；EDA 库绑定 ${sourceSummary.withEda}/${sourceSummary.total} 件。缺的源由 G2 的 missing 如实说明。`
          : '没有可查询的 LCSC 料号：G2 拿不到供应商证据。');
      const result = await runtimeClient.gatesCollect({
        pcbUuid: selected.pcbUuid,
        projectId: selected.projectUuid ?? project?.edaWorkspace?.projectUuid ?? null,
        components,
        // G1：已确认需求 + 板卡规格交给 Runtime buildDesignSpec 生成规格证据；
        // 板卡规格没填完整时**不传 boards**，让 missing 如实报缺什么（不拿默认板框冒充实测规格）。
        ...((confirmedRequirements.length || boardSpec.board) ? {
          specInput: {
            project: { id: project?.id, name: project?.name, code: project?.code, stage: project?.stage },
            requirements: confirmedRequirements.map((item) => ({
              id: item.id,
              category: item.category,
              requirement: `${item.category} · ${item.name}：${item.value}${item.unit}`.trim(),
            })),
            ...(boardSpec.board ? { boards: [boardSpec.board] } : {}),
          },
        } : {}),
        // G3：只传用户/EDA 页真实提供的意图网表；没有就不传，让 missing 说明。
        ...(intent.netlist ? { intentNetlist: intent.netlist } : {}),
      });
      setCollected(result);
      if (result.report) setReport(result.report);
      if (result.evidenceRefs) setRefs(result.evidenceRefs);
      const saved = result.saved?.length ?? 0;
      const missing = result.missing?.length ?? 0;
      notify(saved ? '六门取证完成' : '六门取证没有产出证据', saved
        ? `落盘 ${saved} 条证据${missing ? `，仍有 ${missing} 类输入缺失` : '；缺口已全部补齐'}`
        : `仍缺 ${missing} 类输入：${(result.missing ?? []).slice(0, 3).map((item) => item.kind).join('、') || '未知'}；没有任何证据被写成通过`,
        missing ? 'warning' : 'success');
    } catch (caught) { fail(caught, '六门取证'); } finally { setBusy(null); }
  };

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
      notify(decision === 'approve' ? '六门签字已记录' : '已驳回', `签字人：${result.record.signedBy}；门禁结论：${result.record.gateVerdict}（仅看板留痕，正式放行以交付签核为准）`, decision === 'approve' ? 'success' : 'warning');
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
              <Stat label="证据不足门" value={report.unknownGates.length - (report.notImplementedGates?.length ?? 0)} tone={report.unknownGates.length ? 'warning' : 'neutral'} hint={report.unknownGates.filter((id) => !report.notImplementedGates?.includes(id)).join('、') || '—'} />
              <Stat label="未实现门" value={report.notImplementedGates?.length ?? 0} tone={report.notImplementedGates?.length ? 'neutral' : 'success'} hint={report.notImplementedGates?.join('、') || '—'} />
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
                  <small>{gate.verdict === 'not-implemented' ? `本门未实现（无证据生产者）：${gate.requiredKinds.join('、')}` : `需要证据：${gate.requiredKinds.join('、')}${gate.missing.length ? `（缺 ${gate.missing.join('、')}）` : ''}`}</small>
                  {GATE_INPUT_HINTS[gate.id] ? <small className="muted" style={{ display: 'block', marginTop: 4 }}>{GATE_INPUT_HINTS[gate.id]}</small> : null}
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
            {advice && (
              <div className="inline-alert inline-alert--info" role="status" style={{ marginTop: 12 }}>
                <ShieldCheck size={16} />
                <span>
                  <strong>知识库放行建议</strong>（只取 approved + 未过期条目；评估时记录 usage）：{' '}
                  <Badge tone="neutral">已采用 {advice.used} 条</Badge> <Badge tone={advice.unusableSkipped ? 'warning' : 'neutral'}>跳过不可用 {advice.unusableSkipped} 条</Badge>{' '}
                  <small className="muted">候选 {advice.considered.length} 个（门/原因码）{advice.note ? ` · ${advice.note}` : ''}</small>
                  {advice.suggested.length === 0
                    ? ` 暂无可用知识——${advice.note ?? '未审核条目不会进入门禁建议'}`
                    : advice.suggested.map((item) => (
                      <span key={item.knowledgeId} style={{ display: 'block', marginTop: 4 }}>
                        <Badge tone="success">{item.review}</Badge> <Badge tone="neutral">{item.trust ?? '—'}</Badge>{' '}
                        <strong>{item.title}</strong> <small className="muted">· {item.gateId}/{item.reasonCode} · {item.citation}</small>
                        {item.excerpt ? <small className="muted"> · {item.excerpt}</small> : null}
                      </span>
                    ))}
                </span>
              </div>
            )}
            <div className="inline-alert inline-alert--info" role="note" style={{ marginTop: 12 }} data-testid="six-gate-scope-note">
              <ShieldCheck size={16} />
              <span>
                <strong>六门签字的边界：</strong>此处签字只记录门禁看板结论（证据齐不齐、每门 pass/blocked/unknown），
                <strong>不驱动正式放行/导出/归档</strong>；正式放行永远以交付页的 readiness + 本地门禁 + 在线 DFM + 三方签核为准。
              </span>
            </div>
            <div className="detail-stack" style={{ marginTop: 12 }} data-testid="gates-inputs">
              <small><strong>取证输入</strong>（G1 板卡规格 / G3 意图网表；留空或不完整的输入不会上传，缺口会如实显示）</small>
              <div className="form-grid">
                <Field label="板卡层数"><input aria-label="板卡层数" value={boardLayers} onChange={(event) => setBoardLayers(event.target.value)} placeholder="如 2" inputMode="numeric" /></Field>
                <Field label="板宽 widthMm"><input aria-label="板宽" value={boardWidthMm} onChange={(event) => setBoardWidthMm(event.target.value)} placeholder="如 45" inputMode="decimal" /></Field>
                <Field label="板高 heightMm"><input aria-label="板高" value={boardHeightMm} onChange={(event) => setBoardHeightMm(event.target.value)} placeholder="如 30" inputMode="decimal" /></Field>
              </div>
              {boardSpec.board
                ? <small className="muted">G1 将带 boards：[{boardSpec.board.name}] · {boardSpec.board.layers} 层 · {boardSpec.board.outline.widthMm}×{boardSpec.board.outline.heightMm}mm（取自本页手填，不是实测回读）</small>
                : <small className="muted">板卡规格未填完整：{boardSpec.missing.join('、')}（本次不传 boards，G1 会报缺 design-spec）</small>}
              <Field label="意图网表 JSON" hint="可留空：已审核网表 { nets: [...] } 或 design-spec 的 netIntent；坏 JSON 会阻断本次取证">
                <textarea aria-label="意图网表" className="input" rows={6} value={intentText} onChange={(event) => { setIntentText(event.target.value); setIntentError(''); }} placeholder={'{\n  "nets": [{ "name": "GND", "endpoints": [{ "ref": "U1", "pin": "1" }, { "ref": "J1", "pin": "1" }] }]\n}'} spellCheck={false} />
              </Field>
              {intentSourceAt ? <small className="muted">已从 EDA 页载入已审核网表（生成于 {intentSourceAt}）；可直接改，取证按改后内容解析。</small> : null}
              {intentError ? <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>{intentError}：本次取证已取消。</span></div> : null}
              {supplyNote ? <div className="inline-alert inline-alert--info" role="status"><CheckCircle2 size={16} /><span>{supplyNote}</span></div> : null}
            </div>
            <div className="row-actions" style={{ marginTop: 12 }}>
              <Button loading={busy === 'status'} icon={<RefreshCw size={14} />} onClick={() => load('status')}>重新读取</Button>
              <Button loading={busy === 'collect'} icon={<ShieldCheck size={14} />} onClick={() => void collectEvidence()}>运行门禁取证 G1–G6</Button>
              <Button loading={busy === 'evaluate'} onClick={() => load('evaluate')}>评估并归档报告</Button>
            </div>
            {collected ? (
              <div className="detail-stack" style={{ marginTop: 12 }} data-testid="gates-collected">
                <div className="inline-alert inline-alert--info" role="status">
                  <ShieldCheck size={16} />
                  <span>
                    <strong>本次取证：落盘 {collected.saved?.length ?? 0} 条。</strong>
                    缺口 {collected.missing?.length ?? 0} 类；缺的输入只记 missing，<strong>不会伪造成通过</strong>。
                  </span>
                </div>
                <small>已落盘证据：</small>
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {(collected.saved ?? []).map((item) => <li key={`${item.kind}-${item.digest}`}><code>{item.kind}</code> · {item.verdict ?? 'unknown'} · {item.digest.slice(0, 12)}… · {item.path}</li>)}
                  {!(collected.saved ?? []).length && <li className="muted">没有证据落盘（缺输入时这是如实结果）</li>}
                </ul>
                {(collected.missing ?? []).length ? (
                  <>
                    <small>仍缺输入：</small>
                    <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                      {(collected.missing ?? []).map((item, index) => (
                        <li key={`${item.kind}-${index}`}>
                          <code>{item.kind}</code> · {item.reason}
                          {MISSING_KIND_HINTS[item.kind] ? <><br /><small className="muted">→ {MISSING_KIND_HINTS[item.kind]}</small></> : null}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : null}
            {/* P0-1：把"当前能不能签、为什么不能"直接写在签字区上方，而不是只藏在禁用按钮的 title 里。 */}
            {report.verdict !== 'pass' ? (
              <div className="inline-alert inline-alert--warning" role="status" data-testid="signoff-blocked-reason" style={{ marginTop: 12 }}>
                <AlertTriangle size={16} />
                <span>
                  当前不可签：全局结论 <strong>{verdictLabel(report.verdict)}</strong>
                  {report.blockedGates.length ? `；阻断门 ${report.blockedGates.join('、')}` : ''}
                  {report.unknownGates.length ? `；证据不足门 ${report.unknownGates.join('、')}` : ''}
                  。缺的输入按上面每门提示补齐后重新取证；<strong>blocked/unknown 一律不能签字放行</strong>。
                </span>
              </div>
            ) : null}
            <div className="form-grid" style={{ marginTop: 12 }}>
              <Field label="签字人"><input value={signedBy} onChange={(event) => setSignedBy(event.target.value)} placeholder="必须有名字" /></Field>
              <Field label="备注"><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="驳回/放行理由（可留空）" /></Field>
            </div>
            <div className="row-actions" style={{ marginTop: 8 }}>
              <Button loading={busy === 'signoff'} onClick={() => doSignoff('approve')} disabled={report.verdict !== 'pass'} title={report.verdict === 'pass' ? '门禁全部 pass' : `不能签字：${report.verdict}${report.notImplementedGates?.length ? `（未实现 ${report.notImplementedGates.join('、')}）` : ''}`}>六门签字（仅 pass 可用）</Button>
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
