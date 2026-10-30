import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Crosshair, Move, ShieldCheck, Undo2 } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { runtimeClient, RuntimeApiError } from '../services/runtimeClient';
import {
  buildFineTunePlan, buildRestorePlan, formatMm, planHighlights, summarizeWriteback, verificationRows,
} from '../services/placementViewModel';
import type { PlacementEdit } from '../services/placementViewModel';
import type { PlacementPlanResult, PlacementWritebackResult } from '../types';
import { Badge, Button, Field, Panel, Stat, TableFrame } from '../components/ui';
import { RoutingWritePanel } from '../components/RoutingWritePanel';
import { Modal } from '../components/overlays';
import { LongTaskPanel } from '../components/LongTaskPanel';
import { createSingleCallTask, type LongTaskSnapshot, type SingleCallController } from '../services/longTask';
import { applyEvidencePatch, tryAdvanceProjectStage } from '../services/stageEvidence';
import { LAYOUT_INTENT_TEMPLATE_TEXT } from '../services/layoutIntentTemplate';

/**
 * 布局微调页：按板框自动布局 + 数值微调 + 预演/写回/还原。
 *
 * 三条不妥协的界面纪律：
 *   1. 写回默认**预演**：不点"执行写回"就绝不碰用户板子；
 *   2. 写回成功后明确告诉用户"**尚未保存**"（运行时不代保存，必须在 EDA 里确认后手动保存）；
 *   3. 复核没结果、证据缺失一律显示为"未确认"，绝不显示成"通过"。
 */
export function PlacementPage() {
  const { state, activeProject, dispatch, notify, addAudit, reportIssue } = useApp();
  const [pcbUuid, setPcbUuid] = useState('');
  const [plan, setPlan] = useState<PlacementPlanResult | null>(null);
  const [edits, setEdits] = useState<Record<string, PlacementEdit>>({});
  const [writeback, setWriteback] = useState<PlacementWritebackResult | null>(null);
  const [busy, setBusy] = useState<null | 'plan' | 'dry' | 'apply' | 'restore'>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // D8：R2 写回是 110s 级长调用（逐器件写+回读），统一走单调用长任务控制器。
  const [applySnapshot, setApplySnapshot] = useState<LongTaskSnapshot<PlacementWritebackResult> | null>(null);
  const applyTaskRef = useRef<SingleCallController<PlacementWritebackResult> | null>(null);
  const [restoreSnapshot, setRestoreSnapshot] = useState<LongTaskSnapshot<PlacementWritebackResult> | null>(null);
  const restoreTaskRef = useRef<SingleCallController<PlacementWritebackResult> | null>(null);
  const [allowRef, setAllowRef] = useState('J1');
  const [allowMm, setAllowMm] = useState('3');
  const [allowReason, setAllowReason] = useState('USB-C 插座需伸出板边才能插线');
  const [allowances, setAllowances] = useState<Record<string, { maxOverhangMm: number; reason: string }>>({});
  const [intentText, setIntentText] = useState('');
  const [intentError, setIntentError] = useState<string | null>(null);
  const [autoDrc, setAutoDrc] = useState(true);

  const fail = (error: unknown, action: string) => {
    const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
    reportIssue({ fingerprint: `placement:${action}`, source: 'validation', severity: 'error', status: 'open', code: error instanceof RuntimeApiError ? error.code : 'PLACEMENT_FAILED', summary: `布局${action}失败`, detail, suggestedAction: '确认嘉立创EDA已打开目标PCB、Runtime与桥接可用后重试；界面不会因为失败而伪造成功。' });
    addAudit('validation', `布局${action}失败`, detail, 'error');
    notify(`布局${action}失败`, detail, 'danger');
  };

  // E2：真实写回必须消费服务端签发的一次性 write 批准（绑定当前窗口+工程+文档指纹），
  // 页面按钮本身不是权限；没有批准时运行时直接 409，绝不放宽成"UI 点了就算批准"。
  const requestWriteApproval = async (note: string) => {
    const approval = await runtimeClient.issueAutomationApproval({ scope: 'write', note });
    return approval.approvalId;
  };

  // 设计意图只作为“声明输入”，不写板；JSON 解析失败直接阻断本次动作，不静默忽略。
  const readDesignIntent = () => {
    const text = intentText.trim();
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      setIntentError(null);
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知解析错误';
      setIntentError(message);
      notify('设计意图 JSON 解析失败', `${message}。本次动作已取消，未读取/写入板子。`, 'danger');
      throw error;
    }
  };

  const loadPlan = async () => {
    setBusy('plan'); setWriteback(null);
    try {
      const result = await runtimeClient.placementPlan({ pcbUuid: pcbUuid.trim() || undefined, overhangAllowances: allowances, designIntent: readDesignIntent(), autoDrc });
      setPlan(result);
      setEdits(Object.fromEntries(result.plan.placements.map((item) => [item.ref, { ref: item.ref, xMm: item.xMm, yMm: item.yMm, rotationDeg: item.rotationDeg }])));
      const drcNote = result.drcAuto?.requested ? (result.drcAuto.used ? ' · 官方 DRC 已自动复核' : ' · 官方 DRC 自动运行失败，GATE-02 仍 REVIEW') : '';
      addAudit('validation', '生成自动布局方案', `${result.componentCount}个器件 · 移动${result.diff?.movedCount ?? 0}个 · 方案复核${result.verification?.ok ? '通过' : '未通过'}${drcNote}`, 'info');
      notify('已生成布局方案', `器件 ${result.componentCount} 个，方案复核${result.verification?.ok ? '通过' : '未通过（见下方红色项）'}。${drcNote}`, result.verification?.ok ? 'success' : 'warning');
    } catch (error) { fail(error, '方案生成'); } finally { setBusy(null); }
  };

  const editedPlan = useMemo(() => (plan ? buildFineTunePlan(plan.plan.placements, Object.values(edits)) : null), [plan, edits]);

  const preview = async () => {
    if (!editedPlan) return;
    setBusy('dry');
    try {
      const result = await runtimeClient.applyPlacement({ pcbUuid: pcbUuid.trim() || undefined, plan: editedPlan, dryRun: true, overhangAllowances: allowances, designIntent: readDesignIntent(), autoDrc });
      setWriteback(result);
      notify('预演完成', `将移动 ${result.updates.length} 个器件；没有写入嘉立创EDA。`, 'info');
    } catch (error) { fail(error, '预演'); } finally { setBusy(null); }
  };

  const apply = async () => {
    setConfirmOpen(false);
    if (!editedPlan) return;
    // P0-8：Runtime 全局写暂停时不在 UI 侧发起（服务端仍会 409 兜底，脚本无法绕过）。
    if (state.settings.writePaused) return notify('写入已暂停', 'Runtime 全局写入已暂停：请先在设置页恢复写入，再执行布局写回。', 'warning');
    setBusy('apply');
    setApplySnapshot(null);
    let approvalIdUsed = '';
    const task = createSingleCallTask({
      call: async (signal) => {
        approvalIdUsed = await requestWriteApproval('R4 布局微调写回');
        return runtimeClient.applyPlacement({ pcbUuid: pcbUuid.trim() || undefined, plan: editedPlan, dryRun: false, overhangAllowances: allowances, approvalIds: [approvalIdUsed], designIntent: readDesignIntent(), autoDrc }, { signal });
      },
      timeoutMs: 180_000,
      onUpdate: setApplySnapshot,
    });
    applyTaskRef.current = task;
    const snapshot = await task.startTask();
    setBusy(null);
    if (snapshot.status !== 'done' || !snapshot.result) {
      if (snapshot.status === 'failed') fail(new Error(snapshot.error || '布局写回失败'), '写回');
      else notify('已停止等待布局写回', snapshot.note || '本页已停止等待；写回可能已在服务端执行或部分写入，以审计与回读为准。', 'warning');
      return;
    }
    const result = snapshot.result;
    setWriteback(result);
    const summary = summarizeWriteback(result);
    addAudit('validation', '布局写回', summary.headline, result.ok ? 'success' : 'error');
    // D5：写回成功且 A9 复核通过才记录 pcbPlaced 证据；阶段推进仍要过相邻阶段门禁（不直接改 stage）。
    if (result.ok && result.applied && result.verified?.ok && activeProject) {
      const executedAt = new Date().toISOString();
      const patched = applyEvidencePatch(activeProject, { pcbPlacementExecutedAt: executedAt, pcbPlacementApprovalId: approvalIdUsed }, executedAt);
      const attempt = tryAdvanceProjectStage(state, patched);
      dispatch({ type: 'UPDATE_PROJECT', project: attempt.project });
      addAudit('project', '阶段证据写入', attempt.advanced.length ? `布局写回回读复核通过，自动推进到 ${attempt.advanced.join('→')}。` : `布局写回证据已记录；阶段未推进：${attempt.blocked.join('；')}`, attempt.advanced.length ? 'success' : 'info');
    }
    notify(summary.headline, summary.detail, summary.tone);
  };

  const restore = async () => {
    if (!plan) return;
    setBusy('restore');
    setRestoreSnapshot(null);
    const task = createSingleCallTask({
      call: async (signal) => {
        const approvalId = await requestWriteApproval('R4 布局还原到原位置');
        return runtimeClient.applyPlacement({ pcbUuid: pcbUuid.trim() || undefined, plan: buildRestorePlan(plan.plan.placements), dryRun: false, approvalIds: [approvalId], designIntent: readDesignIntent(), autoDrc }, { signal });
      },
      timeoutMs: 180_000,
      onUpdate: setRestoreSnapshot,
    });
    restoreTaskRef.current = task;
    const snapshot = await task.startTask();
    setBusy(null);
    if (snapshot.status !== 'done' || !snapshot.result) {
      if (snapshot.status === 'failed') fail(new Error(snapshot.error || '布局还原失败'), '还原');
      else notify('已停止等待布局还原', snapshot.note || '本页已停止等待；还原可能已在服务端执行或部分写入，以审计与回读为准。', 'warning');
      return;
    }
    setWriteback(snapshot.result);
    const summary = summarizeWriteback(snapshot.result);
    addAudit('validation', '布局还原', summary.headline, snapshot.result.ok ? 'success' : 'error');
    notify(summary.headline, summary.detail, summary.tone);
  };

  const setEdit = (ref: string, patch: Partial<PlacementEdit>) => setEdits((current) => {
    const base = current[ref];
    return base ? { ...current, [ref]: { ...base, ...patch } } : current;
  });

  const verification = plan ? [...verificationRows(plan.currentVerification, '现状'), ...verificationRows(plan.verification, '方案')] : [];
  const blockingNow = plan ? plan.currentVerification.findings.filter((finding) => finding.severity === 'blocking').length : 0;
  const writebackSummary = writeback ? summarizeWriteback(writeback) : null;
  const readbackRows = (writeback?.steps.find((step) => step.step === 'readback') as { perItem?: Array<{ ref: string; errorMm: number; ok: boolean }> } | undefined)?.perItem ?? [];

  return (
    <>
      <Panel
        eyebrow="LAYOUT / BOARD OUTLINE"
        title="按板框自动布局与微调"
        meta={plan ? <Badge tone={plan.verification.ok ? 'success' : 'warning'}>{plan.verification.ok ? '方案复核通过' : '方案复核有阻断'}</Badge> : <Badge tone="neutral">尚未读取</Badge>}
        actions={<Button variant="primary" icon={<Crosshair size={15} />} loading={busy === 'plan'} onClick={loadPlan}>读取板框并自动布局</Button>}
      >
        <div className="form-grid">
          <Field label="PCB 文档 UUID" hint="留空则使用嘉立创EDA 中当前打开的 PCB；填了则由运行时负责打开它（需要时请先在 EDA 控制页选择窗口）。">
            <input className="input" value={pcbUuid} onChange={(event) => setPcbUuid(event.target.value)} placeholder="留空 = 当前打开的 PCB" />
          </Field>
        </div>
        <div className="detail-block">
          <Field label="设计意图 JSON（可选）" hint="声明 courtyard/3D 高度、连接器开口、天线端、去耦配对、测试点、热/PDN/高速/爬电/间隙/外壳/EMC 等事实；缺字段的规则保持 REVIEW，不由运行时猜。">
            <textarea className="input" rows={8} value={intentText} onChange={(event) => setIntentText(event.target.value)} placeholder={'{\n  "schemaVersion": 1,\n  "components": { "J1": { "conn": { "openingDir": "-y", "plugClearanceMm": 12 } } }\n}'} spellCheck={false} />
          </Field>
          <div className="row-actions">
            <Button variant="ghost" onClick={() => { setIntentText(LAYOUT_INTENT_TEMPLATE_TEXT); setIntentError(null); }}>插入模板</Button>
            <Button variant="ghost" onClick={() => { setIntentText(''); setIntentError(null); }}>清空</Button>
            <label className="checkbox-line"><input type="checkbox" checked={autoDrc} onChange={(event) => setAutoDrc(event.target.checked)} />读取/预演时自动跑官方 DRC（只读）</label>
          </div>
          {intentError ? <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>JSON 解析失败：{intentError}。本次动作已取消。</span></div> : null}
          <small>只作为审计声明使用，不会写回 EDA；非法方向/负距离会被运行时拒绝（400）。</small>
        </div>
        <p><small>自动布局以板框轮廓为准：先按锚点放连接器，再按网络关联把器件聚到相关伙伴旁，最后按网格 / 间距 / 边距独立复核。复核不通过不会写回。</small></p>
      </Panel>

      {plan ? (
        <>
          <div className="stats-grid stats-grid--4">
            <Stat label="器件" value={plan.componentCount} hint={`已放置 ${plan.plan.stats.placedCount} · 未放置 ${plan.plan.stats.unplacedCount}`} />
            <Stat label="与现状差异" value={`${plan.diff.movedCount} 个移动`} hint={`不变 ${plan.diff.unchangedCount} · 新增 ${plan.diff.newCount}`} tone={plan.diff.movedCount ? 'info' : 'neutral'} />
            <Stat label="板面利用率" value={`${(plan.plan.stats.utilization * 100).toFixed(1)}%`} hint={`网格 ${plan.plan.stats.gridMm}mm · 边距 ${plan.plan.stats.edgeClearanceMm}mm`} />
            <Stat label="现状阻断" value={blockingNow} hint={blockingNow ? '当前板子上就有越界或重叠' : '当前板子无阻断项'} tone={blockingNow ? 'danger' : 'success'} />
          </div>

          <Panel title="方案摘要" eyebrow="SUMMARY">
            <ul>{planHighlights(plan).map((line) => <li key={line}>{line}</li>)}</ul>
          </Panel>

          <Panel
            title="数值微调"
            eyebrow="FINE TUNE"
            meta={<small>先"预演写回"看差异，再"执行写回"；运行时写后会逐项回读核对</small>}
            actions={(
              <div className="row-actions">
                <Button icon={<Move size={15} />} loading={busy === 'dry'} disabled={!editedPlan} title={editedPlan ? '预演：只算不写，不改动嘉立创EDA' : '先点"读取板框并自动布局"生成方案'} onClick={preview}>预演写回</Button>
                <Button variant="primary" icon={<ShieldCheck size={15} />} disabled={!editedPlan || busy !== null || state.settings.writePaused} title={state.settings.writePaused ? 'Runtime 全局写入已暂停：恢复后才能写回' : !editedPlan ? '先读取板框并生成方案' : busy !== null ? '正在执行上一个动作，请稍候' : '把微调后的坐标写回PCB（不会自动保存）'} onClick={() => setConfirmOpen(true)}>执行写回</Button>
                <Button variant="ghost" icon={<Undo2 size={15} />} loading={busy === 'restore'} disabled={!plan} title={plan ? '把器件坐标写回读取方案时的原始位置' : '先读取板框并生成方案'} onClick={restore}>还原到原位置</Button>
              </div>
            )}
          >
            <TableFrame label="布局微调表">
              <table>
                <thead>
                  <tr><th>位号</th><th>现位置 X/Y (mm)</th><th>目标 X (mm)</th><th>目标 Y (mm)</th><th>旋转 (°)</th><th>位移 (mm)</th><th>尺寸</th></tr>
                </thead>
                <tbody>
                  {plan.plan.placements.map((item) => {
                    const edit = edits[item.ref];
                    const current = item.current;
                    const distance = current && edit ? Math.hypot(edit.xMm - current.xMm, edit.yMm - current.yMm) : null;
                    return (
                      <tr key={item.ref}>
                        <td><strong>{item.ref}</strong><small>{item.side === 'top' ? '正面' : '背面'}</small></td>
                        <td>{formatMm(current?.xMm)} / {formatMm(current?.yMm)}</td>
                        <td><input className="input" type="number" step="0.1" value={edit?.xMm ?? ''} onChange={(event) => setEdit(item.ref, { xMm: Number(event.target.value) })} /></td>
                        <td><input className="input" type="number" step="0.1" value={edit?.yMm ?? ''} onChange={(event) => setEdit(item.ref, { yMm: Number(event.target.value) })} /></td>
                        <td><input className="input" type="number" step="1" value={edit?.rotationDeg ?? 0} onChange={(event) => setEdit(item.ref, { rotationDeg: Number(event.target.value) })} /></td>
                        <td>{distance === null ? '—' : formatMm(distance)}</td>
                        <td>{formatMm(item.widthMm)} × {formatMm(item.heightMm)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableFrame>
            {plan.plan.unplaced.length ? (
              <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>{plan.plan.unplaced.length} 个器件未能自动放置（尺寸未知或放不下），需要手工处理。</span></div>
            ) : null}
          </Panel>

          <Panel title="器件伸出板边的显式声明" eyebrow="DECLARED EXCEPTION" meta={<small>连接器故意伸出板边必须显式声明并写清理由，否则复核会阻断</small>}>
            <div className="form-grid">
              <Field label="位号"><input className="input" value={allowRef} onChange={(event) => setAllowRef(event.target.value)} /></Field>
              <Field label="允许伸出 (mm)"><input className="input" type="number" step="0.1" value={allowMm} onChange={(event) => setAllowMm(event.target.value)} /></Field>
              <Field label="理由（≥8 字）" hint="说明为什么这个器件必须伸出板边"><input className="input" value={allowReason} onChange={(event) => setAllowReason(event.target.value)} /></Field>
            </div>
            <div className="row-actions">
              <Button
                onClick={() => {
                  if (allowReason.trim().length < 8) { notify('理由太短', '理由至少 8 个字：说明为什么这个器件必须伸出板边。', 'warning'); return; }
                  setAllowances((current) => ({ ...current, [allowRef.trim()]: { maxOverhangMm: Number(allowMm), reason: allowReason.trim() } }));
                  notify('已登记声明', `${allowRef} 允许伸出 ${allowMm}mm：${allowReason}`, 'info');
                }}
              >登记声明</Button>
              <span><small>{Object.keys(allowances).length ? `已声明：${Object.entries(allowances).map(([ref, item]) => `${ref}≤${item.maxOverhangMm}mm`).join('、')}` : '尚未声明任何例外'}</small></span>
            </div>
            <p><small>登记后需要重新点"读取板框并自动布局"，新声明才会参与复核。</small></p>
          </Panel>

          <Panel title="复核发现" eyebrow="VERIFY">
            {verification.length ? (
              <div className="finding-list">
                {verification.map((row, index) => (
                  <article className="finding-row" key={`${row.phase}-${index}`}>
                    <div className="finding-severity"><AlertTriangle size={18} /></div>
                    <div className="finding-row__main"><strong>{row.title}</strong><small>{row.message}</small></div>
                    <Badge tone={row.tone}>{row.phase}</Badge>
                  </article>
                ))}
              </div>
            ) : <div className="empty-inline"><ShieldCheck size={25} /><strong>没有复核发现</strong><span>方案与现状都没有越界或重叠。</span></div>}
          </Panel>

          {(() => {
            // R6：先出“块 → 区域 → 成员”的分区布局图，人工确认后再写回。
            // 没有 blocks 时明确说“未声明分区”，而不是拿电气亲和度的结果冒充功能分区。
            const blockRows = plan.blockMap ?? plan.blocks?.blockMap ?? [];
            const blockFindings = plan.blocks?.findings ?? [];
            const blocked = blockFindings.filter((item) => item.severity === 'blocking');
            const coveredRefs = new Set(blockRows.flatMap((block) => block.refs)).size;
            const utilRows = blockRows.filter((block) => typeof block.utilization === 'number');
            const avgUtil = utilRows.length ? utilRows.reduce((sum, block) => sum + (block.utilization ?? 0), 0) / utilRows.length : null;
            const derivedCount = blockRows.filter((block) => block.regionDerived).length;
            const unpositioned = blockRows.reduce((sum, block) => sum + (block.unpositionedMemberCount ?? 0), 0);
            return (
              <Panel
                title="分区布局图"
                eyebrow="R6 BLOCK MAP"
                meta={<Badge tone={blockRows.length ? (blocked.length ? 'danger' : blockFindings.length ? 'warning' : 'success') : 'neutral'}>{blockRows.length ? `${blockRows.length} 个功能块` : '未声明分区'}</Badge>}
              >
                {blockRows.length ? (
                  <div className="detail-stack">
                    <div className="stats-grid stats-grid--4">
                      <Stat label="功能块" value={blockRows.length} hint={`声明 ${blockRows.length - derivedCount} · 推导 ${derivedCount}`} tone={derivedCount ? 'warning' : 'neutral'} />
                      <Stat label="覆盖器件" value={coveredRefs} hint={`块内成员合计 ${blockRows.reduce((sum, block) => sum + block.refs.length, 0)} 条`} />
                      <Stat label="平均利用率" value={avgUtil === null ? '—' : `${(avgUtil * 100).toFixed(1)}%`} hint="器件面积 / 块面积；过低说明区域划大了" tone={avgUtil !== null && avgUtil < 0.1 ? 'warning' : 'neutral'} />
                      <Stat label="定位不完整" value={unpositioned} hint="缺当前坐标的成员：无法保证保持相对位置" tone={unpositioned ? 'warning' : 'success'} />
                    </div>
                    <p><small>“块 → 区域 → 成员”是<b>调整范围</b>，不是绝对位置锁：区域内仍会优先保持原相对位置；写回前照样要过板框/间距/禁布与人工复核。</small></p>
                    <TableFrame label="功能分区">
                      <table>
                        <thead><tr><th>功能块</th><th>成员</th><th>区域 (mm)</th><th>块面积</th><th>器件面积</th><th>利用率</th><th>来源</th></tr></thead>
                        <tbody>
                          {blockRows.map((block) => (
                            <tr key={block.id}>
                              <td><strong>{block.name}</strong><br /><small>{block.id}</small></td>
                              <td>{block.refs.join('、') || '—'}</td>
                              <td>{block.region ? `x ${formatMm(block.region.xMinMm)}–${formatMm(block.region.xMaxMm)}<br />y ${formatMm(block.region.yMinMm)}–${formatMm(block.region.yMaxMm)}` : '—'}</td>
                              <td>{block.areaMm2 === null ? '—' : `${formatMm(block.areaMm2)} mm²`}</td>
                              <td>{formatMm(block.componentAreaMm2)} mm²</td>
                              <td>{block.utilization === null ? '—' : `${(block.utilization * 100).toFixed(1)}%`}</td>
                              <td>{block.regionDerived ? <Badge tone="warning">推导</Badge> : <Badge tone="neutral">声明</Badge>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableFrame>
                    {unpositioned ? (
                      <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>有 <b>{unpositioned}</b> 个块成员没有当前坐标：这些器件只能按区域重新摆放，<strong>“保持原相对位置”对它们不成立</strong>，请人工确认。</span></div>
                    ) : null}
                  </div>
                ) : (
                  <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>设计意图里没有 <code>blocks</code>：本次仍按电气亲和度自动布局，但<strong>没有功能分区</strong>。可在上方“设计意图”模板里补 blocks 后重新生成；未声明 ≠ 分区通过。</span></div>
                )}
                {blockFindings.length ? (
                  <div className="detail-block">
                    <span>分区发现项（{blockFindings.length}）</span>
                    {blockFindings.slice(0, 12).map((item, index) => (
                      <p key={`block-finding-${index}`}>• <Badge tone={item.severity === 'blocking' ? 'danger' : 'warning'}>{item.severity}</Badge> <code>{item.code}</code> {item.message}</p>
                    ))}
                  </div>
                ) : null}
              </Panel>
            );
          })()}

          {(() => {
            // A9：把 128 条规则的布局结论摆在写回按钮旁边；证据不足 ≠ 通过，阻断项要能直接看到。
            const audit = plan.layoutAudit;
            if (!audit) return (
              <Panel title="布局规则审计" eyebrow="A9 RULE AUDIT">
                <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>本次运行时没有返回规则审计（旧版本或被跳过）：<strong>没有审计 ≠ 规则通过</strong>，请先升级运行时再写回。</span></div>
              </Panel>
            );
            return (
              <Panel
                title="布局规则审计"
                eyebrow="A9 RULE AUDIT"
                meta={<Badge tone={audit.ok ? (audit.evidenceGapFailures ? 'warning' : 'success') : 'danger'}>{audit.ok ? (audit.evidenceGapFailures ? '可写回 · 有证据缺口' : '无硬门禁违规') : '存在硬门禁违规'}</Badge>}
              >
                <div className="detail-stack">
                  <div className="stats-grid stats-grid--4">
                    <Stat label="硬门禁阻断" value={audit.blockingFailures} hint="真的量到违规的项" tone={audit.blockingFailures ? 'danger' : 'success'} />
                    <Stat label="证据缺口" value={audit.evidenceGapFailures} hint="缺 courtyard/3D 等证据 → REVIEW，不冒充通过" tone={audit.evidenceGapFailures ? 'warning' : 'neutral'} />
                    <Stat label="警告失败/复查" value={`${audit.warningFailures}/${audit.review}`} hint={`通过 ${audit.summary?.PASS ?? '—'} 条`} tone={audit.warningFailures ? 'warning' : 'neutral'} />
                    <Stat label="审计哈希" value={<code>{String(audit.auditHash || '').slice(0, 10)}</code>} hint={`器件 ${audit.inputSummary?.components ?? 0} 个已纳入几何；板框 ${audit.inputSummary?.board?.widthMm ?? '未知'}×${audit.inputSummary?.board?.heightMm ?? '未知'}mm`} />
                  </div>
                  <p><small>放行就绪 = {String(audit.releaseReady)}（布局只是放行门禁的一部分：本页不给"可下单"结论）。没有几何尺寸的器件不会被编造尺寸，按"证据不足"计入复查。</small></p>
                  {audit.blocking.length ? (
                    <div className="risk-box"><strong>硬门禁违规（写回会被拒绝）</strong>{audit.blocking.map((item) => <p key={`block-${item.ruleId}`}>• <code>{item.ruleId}</code> {item.title}：{item.message}</p>)}</div>
                  ) : null}
                  {audit.evidenceGaps.length ? (
                    <div className="detail-block"><span>证据缺口（需补读回/证据后再判断）</span>{audit.evidenceGaps.slice(0, 12).map((item) => <p key={`gap-${item.ruleId}`}>• <code>{item.ruleId}</code> {item.title}：{item.message}</p>)}</div>
                  ) : null}
                  {audit.supplements ? (
                    <div className="detail-block">
                      <span>补充规则（P2：热/PDN/高速/爬电/外壳/EMC）</span>
                      <p><small>PASS {audit.supplements.summary.PASS} · FAIL {audit.supplements.summary.FAIL} · REVIEW {audit.supplements.summary.REVIEW}；缺设计事实时保持 REVIEW，不按默认值放行。</small></p>
                      {audit.supplements.rules.filter((rule) => rule.status !== 'PASS' && rule.status !== 'NA').map((rule) => (
                        <p key={`sup-${rule.id}`}>• <code>{rule.id}</code> <Badge tone={rule.status === 'FAIL' ? 'danger' : 'warning'}>{rule.status}</Badge> {rule.title}：{rule.message}</p>
                      ))}
                    </div>
                  ) : null}
                </div>
              </Panel>
            );
          })()}
        </>
      ) : null}

      <LongTaskPanel
        title="布局还原（R4，长任务）"
        snapshot={restoreSnapshot}
        onCancel={() => { restoreTaskRef.current?.cancelTask(); }}
        onRetry={() => void restore()}
        cancelLabel="停止等待还原"
        retryLabel="重新还原"
      />

      <LongTaskPanel
        title="布局写回（R2，长任务）"
        snapshot={applySnapshot}
        onCancel={() => { applyTaskRef.current?.cancelTask(); }}
        onRetry={() => void apply()}
        cancelLabel="停止等待写回"
        retryLabel="重新写回"
      />

      {writeback && writebackSummary ? (
        <Panel
          title="写回结果"
          eyebrow="WRITE BACK"
          meta={<Badge tone={writebackSummary.tone}>{writeback.dryRun ? '预演' : writeback.ok ? (writeback.saved ? '已写回并保存' : '已写回 · 未保存') : '未通过'}</Badge>}
        >
          <div className="evidence-strip">
            <div><span>动作</span><strong>{writeback.dryRun ? '预演（未写 EDA）' : writeback.applied ? '已写入并回读确认' : '未写入'}</strong></div>
            <div><span>器件数</span><strong>{writeback.updates.length}</strong></div>
            <div><span>是否保存</span><strong>{writeback.saved ? '已保存' : '未保存'}</strong></div>
            <div><span>回滚</span><strong>{writeback.rollback ? (writeback.rollback.ok ? '已确认还原' : '未确认还原') : '未触发'}</strong></div>
          </div>
          <p><strong>{writebackSummary.headline}</strong></p>
          <p><small>{writebackSummary.detail}</small></p>
          <TableFrame label="写回明细">
            <table>
              <thead><tr><th>位号</th><th>从 (mm)</th><th>到 (mm)</th><th>位移</th><th>回读偏差</th></tr></thead>
              <tbody>
                {writeback.updates.map((update) => {
                  const readback = readbackRows.find((entry) => entry.ref === update.ref);
                  return (
                    <tr key={update.ref}>
                      <td><strong>{update.ref}</strong></td>
                      <td>{formatMm(update.fromMm.xMm)} / {formatMm(update.fromMm.yMm)}</td>
                      <td>{formatMm(update.toMm.xMm)} / {formatMm(update.toMm.yMm)}</td>
                      <td>{formatMm(update.deltaMm)}{update.deltaRotationDeg ? ` · ${update.deltaRotationDeg}°` : ''}</td>
                      <td>{readback ? `${formatMm(readback.errorMm)} ${readback.ok ? '✓' : '✗'}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableFrame>
          {writeback.rollback?.manualCoordinates?.length ? (
            <p className="blocking-note"><AlertTriangle size={14} /> 回滚未确认：请手工改回
              {writeback.rollback.manualCoordinates.map((item) => ` ${item.ref}(${item.xMil}, ${item.yMil} mil)`).join('；')}，或从源码快照恢复。
            </p>
          ) : null}
          <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>运行时不会替你在 EDA 里保存：请在嘉立创EDA 中确认外观后手动保存，否则关闭文档即丢失。</span></div>
        </Panel>
      ) : null}

      <RoutingWritePanel />

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`确认写回 ${editedPlan?.placements.length ?? 0} 个器件的位置？`}
        eyebrow="IRREVERSIBLE UNTIL ROLLBACK"
        footer={<><Button onClick={() => setConfirmOpen(false)}>取消</Button><Button variant="primary" loading={busy === 'apply'} onClick={apply}>确认写回</Button></>}
      >
        <div className="dialog-copy">
          <p>写回会直接修改当前 PCB 文档里的器件坐标（<strong>不会自动保存</strong>）。运行时会在写入后逐项回读并独立复核；不通过会自动回滚到原坐标。</p>
          <p><small>想先看会动什么，请用"预演写回"。</small></p>
        </div>
      </Modal>
    </>
  );
}
