import { useRef, useState } from 'react';
import { AlertTriangle, KeyRound, Layers3, Route, ShieldCheck, Undo2 } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { runtimeClient, RuntimeApiError } from '../services/runtimeClient';
import { Badge, Button, Field, Panel, TableFrame } from '../components/ui';
import type { PcbPourInfo } from '../types';
import { createSingleCallTask, type LongTaskSnapshot, type SingleCallController } from '../services/longTask';
import { LongTaskPanel } from './LongTaskPanel';

type RouteEntry = { ok: boolean; net: string; reason?: string; segments?: Array<{ layer: number; x1: number; y1: number; x2: number; y2: number }>; vias?: unknown[] };
type WrittenEntry = { kind: string; net: string; id: string };

/**
 * R5 自动布线受控面板（E2）：
 *   规划（只读）→ 预演（dryRun，只算不写）→ 真实写入（先签 write 批准，一次一用）
 *   → 读回复核不通过时自动回滚；成功也只写内存不保存，可一键按图元 id 回滚。
 * 界面不隐藏"尚未保存"和"未连通网络"，失败一律显示原因，绝不显示成通过。
 */
export function RoutingWritePanel() {
  const { state, notify, addAudit, reportIssue } = useApp();
  // P1-1（复审 2026-10-29）：布线写入/收尾/回滚同样是 EDA 写命令，必须跟随 Runtime 写门禁
  // （全局暂停或本会话暂停）。修复前按钮只看 busy/数量，点了才被服务端 409 拒绝。
  const writeGateClosed = state.settings.writePaused || state.settings.sessionPaused === true;
  const pauseReason = state.settings.writePaused ? 'Runtime 全局写入已暂停：请先在设置页恢复' : '本会话写入已暂停：请关闭 EDA 页「暂停本会话写入」';
  const [netFilter, setNetFilter] = useState('');
  const [routes, setRoutes] = useState<RouteEntry[] | null>(null);
  const [copper, setCopper] = useState<{ pads: number; lines: number; vias: number } | null>(null);
  const [verification, setVerification] = useState<unknown>(null);
  const [written, setWritten] = useState<WrittenEntry[] | null>(null);
  const [lastDry, setLastDry] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<null | 'plan' | 'dry' | 'apply' | 'rollback' | 'finish'>(null);
  const [error, setError] = useState<string | null>(null);
  // D8：规划/写入是 300s 级长调用，统一走单调用长任务控制器（可停止等待、超时/失败如实区分）。
  const [planSnapshot, setPlanSnapshot] = useState<LongTaskSnapshot<Awaited<ReturnType<typeof runtimeClient.routingPlan>>> | null>(null);
  const [applySnapshot, setApplySnapshot] = useState<LongTaskSnapshot<Awaited<ReturnType<typeof runtimeClient.routingApply>>> | null>(null);
  const planTaskRef = useRef<SingleCallController<Awaited<ReturnType<typeof runtimeClient.routingPlan>>> | null>(null);
  const applyTaskRef = useRef<SingleCallController<Awaited<ReturnType<typeof runtimeClient.routingApply>>> | null>(null);
  // D8：回滚也是 120s 级写路径长调用；与规划/写入一样走统一控制器（取消只停本页等待）。
  const [rollbackSnapshot, setRollbackSnapshot] = useState<LongTaskSnapshot<Awaited<ReturnType<typeof runtimeClient.routingRollback>>> | null>(null);
  const rollbackTaskRef = useRef<SingleCallController<Awaited<ReturnType<typeof runtimeClient.routingRollback>>> | null>(null);
  // 布线收尾（重建铺铜 + 保存）是写动作长调用；成功后回读覆铜详情，证明铺铜真的重建过。
  const [finishSnapshot, setFinishSnapshot] = useState<LongTaskSnapshot<Awaited<ReturnType<typeof runtimeClient.routingFinish>>> | null>(null);
  const finishTaskRef = useRef<SingleCallController<Awaited<ReturnType<typeof runtimeClient.routingFinish>>> | null>(null);
  const [pours, setPours] = useState<PcbPourInfo[] | null>(null);

  const fail = (caught: unknown, action: string) => {
    const detail = caught instanceof RuntimeApiError ? `[${caught.code}] ${caught.message}` : caught instanceof Error ? caught.message : '未知错误';
    setError(detail);
    reportIssue({ fingerprint: `routing:${action}`, source: 'validation', severity: 'error', status: 'open', code: caught instanceof RuntimeApiError ? caught.code : 'ROUTING_UI_FAILED', summary: `布线${action}失败`, detail, suggestedAction: '确认 EDA 打开的是目标 PCB、桥接可用；写入失败不会保存，重新规划后再试。' });
    addAudit('validation', `布线${action}失败`, detail, 'error');
    notify(`布线${action}失败`, detail, 'danger');
  };

  const plan = async () => {
    setBusy('plan'); setError(null); setWritten(null); setLastDry(null); setPlanSnapshot(null);
    const task = createSingleCallTask({
      call: (signal) => runtimeClient.routingPlan({ ...(netFilter.trim() ? { nets: netFilter.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean) } : {}), maxConnections: 24 }, { signal }),
      timeoutMs: 300_000,
      onUpdate: setPlanSnapshot,
    });
    planTaskRef.current = task;
    const snapshot = await task.startTask();
    setBusy(null);
    if (snapshot.status === 'done' && snapshot.result) {
      const result = snapshot.result;
      setRoutes(result.routes);
      setCopper(result.copper);
      setVerification(result.verification);
      addAudit('validation', '生成自动布线方案', `${result.requested} 个断网请求 · 读回 ${result.copper?.pads ?? 0} 焊盘/${result.copper?.lines ?? 0} 走线`, 'info');
      notify('已生成布线方案', `请求 ${result.requested} 条；只读规划，没有写 EDA。`, 'info');
    } else if (snapshot.status === 'failed') {
      fail(new Error(snapshot.error || '布线规划失败'), '规划');
    } else {
      notify('已停止等待布线规划', snapshot.note || '本页已停止等待；服务端规划可能仍在进行，稍后可重试。', 'warning');
    }
  };

  const okRoutes = (routes ?? []).filter((route) => route.ok);
  const applyPlan = { routes: okRoutes };

  const preview = async () => {
    setBusy('dry'); setError(null);
    try {
      const result = await runtimeClient.routingApply({ plan: applyPlan, dryRun: true });
      setVerification(result.verification);
      setLastDry(true);
      setWritten(result.written ?? null);
      notify('预演完成', `将写入 ${result.executed} 个图元；没有写 EDA。`, 'info');
    } catch (caught) { fail(caught, '预演'); } finally { setBusy(null); }
  };

  const requestApproval = async (note: string) => {
    const approval = await runtimeClient.issueAutomationApproval({ scope: 'write', note });
    return approval.approvalId;
  };

  const apply = async () => {
    if (writeGateClosed) return notify('写入已暂停', `${pauseReason}，再签发批准并写入。`, 'warning');
    setBusy('apply'); setError(null); setApplySnapshot(null);
    const task = createSingleCallTask({
      call: async (signal) => {
        const approvalId = await requestApproval('R5 布线写入（自动布线面板）');
        return runtimeClient.routingApply({ plan: applyPlan, dryRun: false, save: false, approvalIds: [approvalId] }, { signal });
      },
      timeoutMs: 300_000,
      onUpdate: setApplySnapshot,
    });
    applyTaskRef.current = task;
    const snapshot = await task.startTask();
    setBusy(null);
    if (snapshot.status === 'done' && snapshot.result) {
      const result = snapshot.result;
      setVerification(result.verification);
      setWritten(result.written ?? null);
      setLastDry(false);
      addAudit('validation', '布线写入（未保存）', `写入 ${result.executed} 个图元 · 复核见详情`, result.ok ? 'success' : 'warning');
      notify('布线已写入（尚未保存）', `写入 ${result.executed} 个图元；运行时未自动保存，请核对后回滚或到 EDA 手动保存。`, result.ok ? 'success' : 'warning');
    } else if (snapshot.status === 'failed') {
      fail(new Error(snapshot.error || '布线写入失败'), '写入');
    } else {
      notify('已停止等待布线写入', snapshot.note || '本页已停止等待；写入可能已在服务端执行/落盘，以审计与铜读回为准。', 'warning');
    }
  };

  const rollback = async () => {
    if (writeGateClosed) return notify('写入已暂停', `${pauseReason}，再回滚本批图元。`, 'warning');
    if (!written?.length) return;
    setBusy('rollback'); setError(null);
    const task = createSingleCallTask<Awaited<ReturnType<typeof runtimeClient.routingRollback>>>({
      timeoutMs: 140_000,
      onUpdate: setRollbackSnapshot,
      call: async (signal) => {
        const approvalId = await requestApproval('R5 布线回滚（删除本批写入图元）');
        const result = await runtimeClient.routingRollback({ items: written, approvalIds: [approvalId] }, { signal });
        addAudit('validation', '布线回滚', `删除 ${result.removed} 个图元 · 残留 ${result.residual.length}`, result.residual.length ? 'error' : 'success');
        notify(result.residual.length ? '回滚有残留' : '回滚完成', result.residual.length ? `仍有 ${result.residual.length} 个图元未删除：${result.residual.join('、')}` : `已删除 ${result.removed} 个图元并读回确认。`, result.residual.length ? 'danger' : 'success');
        if (!result.residual.length) setWritten(null);
        return result;
      },
    });
    rollbackTaskRef.current = task;
    const snapshot = await task.startTask();
    setBusy(null);
    if (snapshot.status === 'failed') fail(new Error(snapshot.error || '布线回滚失败'), '回滚');
    else if (snapshot.status !== 'done') notify('已停止等待布线回滚', snapshot.note || '本页已停止等待；回滚可能已部分生效，以铜读回/审计为准。', 'warning');
  };

  /**
   * 布线收尾：新铜会切平面 → 重建已有覆铜 + 保存（都写板，必须消费 write 批准）。
   * 不调这一步就只是"写在内存里"：铺铜未重建、未保存，后续 DRC/交付读到的板态与全流程脚本不一致。
   */
  const finish = async () => {
    if (writeGateClosed) return notify('写入已暂停', `${pauseReason}，再执行覆铜收尾。`, 'warning');
    setBusy('finish');
    setError(null);
    setFinishSnapshot(null);
    const task = createSingleCallTask({
      timeoutMs: 300_000,
      onUpdate: setFinishSnapshot,
      call: async (signal) => {
        const approvalId = await requestApproval('R5 布线收尾（重建铺铜并保存）');
        return runtimeClient.routingFinish({ approvalIds: [approvalId], rebuildPours: true, save: true }, { signal });
      },
    });
    finishTaskRef.current = task;
    const snapshot = await task.startTask();
    setBusy(null);
    if (snapshot.status === 'done' && snapshot.result) {
      const result = snapshot.result;
      const rebuilt = result.pours?.rebuilt ?? 0;
      /**
       * P0-4 fail-closed：服务端已保证 `ok:false` 时一定没保存（填充读不到 / 覆铜没填充）。
       * UI 必须按失败呈现并点名原因，不能再用"未保存"这种软提示把失败糊过去。
       */
      if (result.ok === false) {
        const code = result.error?.code || 'ROUTING_FINISH_FAILED';
        const detail = result.error?.message || '覆铜收尾复核未通过';
        const unfilled = (result.unfilledPours ?? []).map((pour) => `${pour.net ?? '?'}@${pour.layer ?? '?'}`).join('、');
        setError(`[${code}] ${detail}${unfilled ? ` · 未填充覆铜：${unfilled}` : ''}`);
        reportIssue({ fingerprint: `routing:finish:${code}`, source: 'validation', severity: 'error', status: 'open', code, summary: '布线收尾未通过复核，未保存', detail: `${detail}${unfilled ? `；未填充覆铜：${unfilled}` : ''}`, suggestedAction: '本次没有保存。请在嘉立创EDA 手动重建覆铜并确认填充片数>0，或修正后重新收尾；必要时回滚本批走线。' });
        addAudit('validation', '布线收尾失败（未保存）', `${code} · ${detail}`, 'error');
        notify('布线收尾未通过', `${detail}${unfilled ? `（未填充：${unfilled}）` : ''}；本次没有保存。`, 'danger');
        try {
          const detailPours = await runtimeClient.pcbPours();
          setPours(detailPours.pours ?? []);
        } catch { /* 覆铜详情读不到不改变失败事实 */ }
      } else {
        addAudit('validation', '布线收尾', `重建覆铜 ${rebuilt} 块 · ${result.saved ? '已保存' : '未保存'} · 填充复核${result.poursFilled === true ? '通过' : result.poursFilled === null ? '（当前板无覆铜）' : '未通过'}`, result.saved ? 'success' : 'warning');
        notify('布线收尾完成', `已重建覆铜 ${rebuilt} 块，填充复核${result.poursFilled === true ? '通过' : result.poursFilled === null ? '（当前板无覆铜）' : '未通过'}${result.saved ? '，并已保存' : '（未保存）'}。`, result.saved ? 'success' : 'warning');
        try {
          const detail = await runtimeClient.pcbPours();
          setPours(detail.pours ?? []);
        } catch { /* 覆铜详情读不到不改变收尾成功事实，只不显示明细 */ }
      }
    } else if (snapshot.status === 'failed') {
      fail(new Error(snapshot.error || '布线收尾失败'), '收尾');
    } else {
      notify('已停止等待布线收尾', snapshot.note || '本页已停止等待；服务端可能已重建铺铜/保存，请以覆铜读回与审计为准。', 'warning');
    }
  };

  return (
    <Panel
      eyebrow="ROUTING / CONTROLLED WRITE"
      title="自动布线（R5，受控写入）"
      meta={<Badge tone={lastDry === null ? 'neutral' : lastDry ? 'info' : 'warning'}>{lastDry === null ? '尚未运行' : lastDry ? '最近一次是预演' : '最近一次是真实写入（未保存）'}</Badge>}
      actions={(
        <div className="row-actions">
          <Button icon={<Route size={15} />} loading={busy === 'plan'} disabled={Boolean(busy)} onClick={() => void plan()}>读取断网并规划</Button>
          <Button icon={<ShieldCheck size={15} />} loading={busy === 'dry'} disabled={Boolean(busy) || !okRoutes.length} onClick={() => void preview()}>预演写入</Button>
          <Button variant="primary" icon={<KeyRound size={15} />} loading={busy === 'apply'} disabled={Boolean(busy) || !okRoutes.length || writeGateClosed} title={writeGateClosed ? pauseReason : !okRoutes.length ? '先规划出可写走线' : undefined} onClick={() => void apply()}>签发批准并写入</Button>
          <Button icon={<Layers3 size={15} />} loading={busy === 'finish'} disabled={Boolean(busy) || !written?.length || writeGateClosed} title={writeGateClosed ? pauseReason : !written?.length ? '先写入本批走线，再收尾' : '重建铺铜并保存'} onClick={() => void finish()}>收尾：重建铺铜并保存</Button>
          <Button variant="ghost" icon={<Undo2 size={15} />} loading={rollbackSnapshot?.status === 'running'} disabled={Boolean(busy) || !written?.length || writeGateClosed} title={writeGateClosed ? pauseReason : undefined} onClick={() => void rollback()}>回滚本批图元</Button>
        </div>
      )}
    >
      <div className="form-grid">
        <Field label="指定网络（可选）" hint="逗号分隔；留空则按默认上限读取前 24 个断网。指定时会在全部断网中查找目标网络。">
          <input className="input" value={netFilter} onChange={(event) => setNetFilter(event.target.value)} placeholder="例如 WS2812_D1, U0TXD" />
        </Field>
      </div>
      {error && <div className="inline-alert inline-alert--danger"><AlertTriangle size={16} /><span>{error}</span></div>}
      <LongTaskPanel title="布线规划（只读）" snapshot={planSnapshot} onCancel={() => { planTaskRef.current?.cancelTask(); }} onRetry={() => void plan()} cancelLabel="停止等待规划" retryLabel="重新规划" />
      <LongTaskPanel title="布线回滚（R5，删除本批图元）" snapshot={rollbackSnapshot} onCancel={() => { rollbackTaskRef.current?.cancelTask(); }} onRetry={() => void rollback()} cancelLabel="停止等待回滚" retryLabel="重新回滚" />
      <LongTaskPanel title="布线写入（R5）" snapshot={applySnapshot} onCancel={() => { applyTaskRef.current?.cancelTask(); }} onRetry={() => void apply()} cancelLabel="停止等待写入" retryLabel="重新写入" />
      <LongTaskPanel title="布线收尾（重建铺铜 + 保存）" snapshot={finishSnapshot} onCancel={() => { finishTaskRef.current?.cancelTask(); }} onRetry={() => void finish()} cancelLabel="停止等待收尾" retryLabel="重新收尾" />
      {copper && <p><small>读回铜几何：焊盘 {copper.pads} · 走线 {copper.lines} · 过孔 {copper.vias}</small></p>}
      {routes && (
        <TableFrame label="自动布线方案">
          <table className="table">
            <thead><tr><th>网络</th><th>结果</th><th>说明</th></tr></thead>
            <tbody>
              {routes.map((route, index) => (
                <tr key={`${route.net}-${index}`}>
                  <td><strong>{route.net}</strong></td>
                  <td>{route.ok ? <Badge tone="success">可写</Badge> : <Badge tone="danger">不可写</Badge>}</td>
                  <td>{route.ok ? `${route.segments?.length ?? 0} 段 · ${route.vias?.length ?? 0} 个过孔` : route.reason || '—'}</td>
                </tr>
              ))}
              {!routes.length && <tr><td colSpan={3}>没有可规划的路由（可能当前板没有断网，或指定网络不在断网列表里）。</td></tr>}
            </tbody>
          </table>
        </TableFrame>
      )}
      {verification !== null && <p><small>独立复核：{JSON.stringify(verification).slice(0, 400)}</small></p>}
      {written?.length ? <p><small>本批写入 {written.length} 个图元（未保存）：{written.map((item) => item.id).slice(0, 8).join('、')}{written.length > 8 ? '…' : ''}</small></p> : null}
      {pours ? <p><small>覆铜读回：{pours.length} 块{pours.length ? `（${pours.map((item) => `${item.net}@L${item.layer}`).join('、')}）` : ''}</small></p> : null}
      <p><small>写入不会自动保存；核对无误后点「收尾：重建铺铜并保存」完成布线收尾（新铜会切平面，必须重建铺铜），或点「回滚本批图元」撤销本批写入。收尾与回滚都必须消费一次性 write 批准。</small></p>
    </Panel>
  );
}
