import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, ListChecks, Play, RefreshCw, ShieldCheck, Square, XCircle } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { runtimeClient, RuntimeApiError } from '../services/runtimeClient';
import { parseRecipeParams } from '../services/automationParams';
import type { AutomationApproval, AutomationAuditBundle, AutomationJournalEntry, AutomationRecipeSummary, AutomationRecoveryRun, AutomationRunResult, OrchestrationPlan, OrchestrationRecovery } from '../services/runtimeClient';
import { Badge, Button, Panel, Stat, TableFrame } from '../components/ui';
import { LongTaskPanel } from '../components/LongTaskPanel';
import { createSingleCallTask, type LongTaskSnapshot, type SingleCallController } from '../services/longTask';

/**
 * 自动化执行中心（Phase 1）。
 *
 * 产品纪律（和内核语义一一对应）：
 *   1. 配方是确定性的；AI 只负责选配方/填参数/读失败诊断，不自由点鼠标；
 *   2. 写入配方必须先在**服务端**签发"写板批准"（绑定当前 EDA 窗口+工程+文档指纹，一次性、30 分钟）；
 *   3. 运行结果只认 `completed`；`needs_approval / needs_params / failed` 都显著展示，不伪装成成功；
 *   4. 每一步展示策略（primary / fallback）与读回摘要；可展开哈希链审计，链断裂会明确标红。
 */
const stateTone = (state: AutomationRunResult['state'] | null) => (
  state === 'completed' ? 'success' : state === 'failed' || state === 'rollback_failed' ? 'danger' : 'warning'
);
const stateLabel: Record<string, string> = {
  completed: '已完成（全部读回通过）',
  failed: '失败（未放行）',
  needs_approval: '待批准（未执行任何步骤）',
  needs_params: '待填写参数（未执行任何步骤）',
  needs_human: '需要人工处理',
  rollback_failed: '回退失败，需人工介入',
};

export function AutomationPage() {
  const { state, notify, addAudit, reportFailure } = useApp();
  const realRuntime = state.runtime.reachable && state.runtime.mode !== 'demo';
  const [recipes, setRecipes] = useState<AutomationRecipeSummary[]>([]);
  const [approvals, setApprovals] = useState<AutomationApproval[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<AutomationRunResult | null>(null);
  const [journal, setJournal] = useState<{ runId: string; entries: AutomationJournalEntry[]; chainOk: boolean; brokenAt: number | null } | null>(null);
  type GuiProbeRow = { viewport: string; available: number; missing: string[]; capabilities: Awaited<ReturnType<typeof runtimeClient.guiCapabilityProbe>>['capabilities']; screenshot: Awaited<ReturnType<typeof runtimeClient.guiCapabilityProbe>>['screenshot'] };
  const [guiProbe, setGuiProbe] = useState<GuiProbeRow[] | null>(null);
  // D8：GUI 探测（120s）与安全重放（600s）也是长调用，用统一单调用控制器接管取消/超时/重试措辞。
  const [guiProbeTask, setGuiProbeTask] = useState<LongTaskSnapshot<GuiProbeRow[]> | null>(null);
  const guiProbeTaskRef = useRef<SingleCallController<GuiProbeRow[]> | null>(null);
  const [replayTask, setReplayTask] = useState<LongTaskSnapshot<AutomationRunResult> | null>(null);
  const replayTaskRef = useRef<SingleCallController<AutomationRunResult> | null>(null);
  const [recovery, setRecovery] = useState<{ available: boolean; reason?: string; scanned: number; corrupt?: number; runs: AutomationRecoveryRun[] } | null>(null);
  // E11：写步骤安全审计包（before/after 截图摘要 + 读回 + 批准 id/目标指纹 + 链校验）。
  const [auditBundle, setAuditBundle] = useState<AutomationAuditBundle | null>(null);
  // E10：目标编排（确定性映射）+ 失败恢复建议；只出计划/建议，不执行、不代批准。
  const [orchestrationGoal, setOrchestrationGoal] = useState('把这块板从网表同步到 PCB，并跑 DRC');
  const [orchestrationBudget, setOrchestrationBudget] = useState({ maxRecipes: 8, maxWriteRecipes: 2, maxEstimatedSeconds: 600 });
  const [orchestrationPlan, setOrchestrationPlan] = useState<OrchestrationPlan | null>(null);
  const [failureInput, setFailureInput] = useState<{ errorCode: string; stage: 'read' | 'write' | 'verify' | 'gate'; attempt: number }>({ errorCode: 'EDA_JOB_BUSY', stage: 'read', attempt: 1 });
  const [recoveryDecision, setRecoveryDecision] = useState<OrchestrationRecovery | null>(null);

  const selected = useMemo(() => recipes.find((recipe) => recipe.id === selectedId) || recipes[0] || null, [recipes, selectedId]);
  const requiredApprovals = selected?.requiredApprovals ?? [];

  const fail = (caught: unknown, action: string) => {
    const detail = caught instanceof RuntimeApiError ? `[${caught.code}] ${caught.message}` : caught instanceof Error ? caught.message : '未知错误';
    setError(detail);
    // D4：统一失败诊断入口——证据/修复入口由 Runtime 生成，而不是各页面各写一段 notify。
    void reportFailure({
      source: caught instanceof RuntimeApiError ? 'runtime' : 'validation',
      error: caught instanceof RuntimeApiError ? { code: caught.code, message: caught.message } : { code: 'AUTOMATION_UI_FAILED', message: detail },
      context: { operation: `automation:${action}`, ...(selected ? { recipeId: selected.id } : {}), ...(lastRun?.runId ? { runId: lastRun.runId } : {}) },
    });
    notify(`自动化${action}失败`, detail, 'danger');
  };

  const refresh = async (silent = false) => {
    if (!realRuntime) return;
    setBusy(silent ? 'refresh' : 'load');
    setError(null);
    try {
      const [loadedRecipes, activeApprovals] = await Promise.all([runtimeClient.automationRecipes(), runtimeClient.automationApprovals()]);
      setRecipes(loadedRecipes);
      setApprovals(activeApprovals);
      if (!selectedId && loadedRecipes.length) setSelectedId(loadedRecipes[0].id);
    } catch (caught) {
      fail(caught, '加载配方');
    } finally {
      setBusy(null);
    }
  };

  const loadAuditBundle = async () => {
    if (!lastRun?.runId) return;
    setBusy('audit-bundle');
    setError(null);
    try {
      const result = await runtimeClient.automationAuditBundle(lastRun.runId);
      setAuditBundle(result.bundle);
    } catch (caught) {
      fail(caught, '读取写步骤审计包');
    } finally {
      setBusy(null);
    }
  };

  const generateOrchestrationPlan = async () => {
    setBusy('e10-plan');
    setError(null);
    try {
      const result = await runtimeClient.planOrchestration({ goal: orchestrationGoal, budget: orchestrationBudget });
      setOrchestrationPlan(result.plan);
    } catch (caught) {
      setOrchestrationPlan(null);
      fail(caught, '生成目标编排计划');
    } finally {
      setBusy(null);
    }
  };

  const requestFailureRecovery = async () => {
    setBusy('e10-recovery');
    setError(null);
    try {
      const result = await runtimeClient.orchestrationFailure({ errorCode: failureInput.errorCode, stage: failureInput.stage, attempt: failureInput.attempt, ...(orchestrationPlan ? { planId: orchestrationPlan.planId } : {}) });
      setRecoveryDecision(result.recovery);
    } catch (caught) {
      setRecoveryDecision(null);
      fail(caught, '获取失败恢复建议');
    } finally {
      setBusy(null);
    }
  };

  const loadRecovery = async () => {
    if (!realRuntime) return;
    setBusy('recovery');
    try {
      setRecovery(await runtimeClient.automationRecovery());
    } catch (caught) {
      fail(caught, '读取中断运行');
    } finally {
      setBusy(null);
    }
  };

  const replayRun = async (run: AutomationRecoveryRun) => {
    setError(null);
    const task = createSingleCallTask<AutomationRunResult>({
      timeoutMs: 620_000,
      onUpdate: setReplayTask,
      call: async (signal) => {
        const result = await runtimeClient.replayAutomationRun(run.runId, { signal });
        setLastRun(result.run);
        addAudit('validation', '安全重放中断 run', `${result.recoveredFrom} → ${result.runId} · ${result.run.state}`, result.run.ok ? 'success' : 'warning');
        notify('安全重放完成', `${result.recoveredFrom} → ${result.runId}：${result.run.state}`, result.run.ok ? 'success' : 'warning');
        return result.run;
      },
    });
    replayTaskRef.current = task;
    const settled = await task.startTask();
    if (settled.status === 'failed') fail(new Error(settled.error || '安全重放失败'), '安全重放');
    else if (settled.status !== 'done') notify('已停止等待安全重放', settled.note || '本页已停止等待；服务端可能仍在重放，以审计为准。', 'warning');
    else await loadRecovery();
  };

  useEffect(() => { void refresh(true); }, [realRuntime]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (realRuntime) void loadRecovery(); }, [realRuntime]); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async () => {
    if (!selected) return;
    setBusy('approve');
    setError(null);
    try {
      const approval = await runtimeClient.issueAutomationApproval({ scope: requiredApprovals[0] === 'release' ? 'release' : 'write', recipeId: selected.id, note: `自动化配方 ${selected.id}` });
      setApprovals((current) => [approval, ...current]);
      addAudit('validation', '签发自动化批准', `${selected.id} · ${approval.scope} · 指纹 ${approval.fingerprint?.slice(0, 12) ?? '—'} · 到期 ${new Date(approval.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}`, 'success');
      notify('已签发写板批准', `一次性有效，绑定当前 EDA 目标；到期 ${new Date(approval.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}。`, 'success');
    } catch (caught) {
      fail(caught, '签发批准');
    } finally {
      setBusy(null);
    }
  };

  const abortRun = async () => {
    if (!activeRunId) return;
    setAborting(true);
    try {
      const result = await runtimeClient.abortAutomationRun(activeRunId);
      addAudit('validation', '请求中止自动化运行', `${activeRunId} · 将在下一个步骤边界生效`, 'warning');
      notify('已请求中止', result.note ?? '进行中的动作会完成并读回，之后不再继续后续步骤。', 'warning');
    } catch (caught) {
      fail(caught, '中止运行');
    } finally {
      setAborting(false);
    }
  };

  const run = async () => {
    if (!selected) return;
    // runId 由前端先生成：这样“运行中”按钮可以立刻拿到 id 去请求中止。
    const runId = `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setBusy('run');
    setActiveRunId(runId);
    setError(null);
    setJournal(null);
    try {
      // 结构化参数（如 pcb-create-pour 的 outline）以 JSON 输入；解析失败在发请求前就报错。
      const runParams = parseRecipeParams(params);
      const useApprovals = approvals.filter((item) => item.recipeId === selected.id || item.recipeId === null).map((item) => item.approvalId);
      const result = await runtimeClient.runAutomation({ recipeId: selected.id, params: runParams, approvalIds: useApprovals, runId });
      setLastRun(result);
      addAudit('validation', '运行自动化配方', `${selected.id} · ${result.state} · ${result.steps.length} 步`, result.ok ? 'success' : 'warning');
      if (result.ok) notify('自动化执行完成', `${selected.id}：全部步骤读回通过。`, 'success');
      else if (result.state === 'needs_approval') notify('需要写板批准', `缺少：${result.missingApprovals?.join('、')}。未执行任何步骤。`, 'warning');
      else if (result.state === 'needs_params') notify('需要填写参数', `缺少：${result.missingParams?.join('、')}。未执行任何步骤。`, 'warning');
      else notify('自动化执行未通过', `${result.failedStep?.failures?.[0] ?? '见失败详情'}`, 'danger');
      if (useApprovals.length) addAudit('validation', '批准已消费', `${selected.id} · ${useApprovals.length} 个一次性批准（服务端记为已使用，复用会被拒）`, 'info');
      setApprovals((current) => current.filter((item) => !useApprovals.includes(item.approvalId)));
      if (result.journalPath) {
        const audit = await runtimeClient.automationRun(result.runId);
        setJournal({ runId: audit.runId, entries: audit.entries, chainOk: audit.chain.ok, brokenAt: audit.chain.brokenAt });
      }
    } catch (caught) {
      fail(caught, '运行配方');
    } finally {
      setBusy(null);
      setActiveRunId(null);
      setAborting(false);
    }
  };

  const probeGuiCapabilities = async () => {
    const task = createSingleCallTask<GuiProbeRow[]>({
      timeoutMs: 150_000,
      onUpdate: setGuiProbeTask,
      call: async (signal) => {
        const sizes = [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }];
        const results: GuiProbeRow[] = [];
        for (const viewport of sizes) {
          const result = await runtimeClient.guiCapabilityProbe({ viewport, captureScreenshot: true }, { signal });
          results.push({ viewport: `${viewport.width}×${viewport.height}`, available: result.availableCount, missing: result.missingTexts, capabilities: result.capabilities, screenshot: result.screenshot });
        }
        setGuiProbe(results);
        addAudit('eda', '探测 GUI 兜底能力', `两种尺寸可用动作 ${results.map((item) => `${item.viewport}:${item.available}`).join(' / ')}`, 'info');
        notify('GUI 兜底能力已探测', `两种窗口尺寸各得到 ${results[0]?.available ?? 0} 个可用动作；缺失文案见下方（不点击、不写板）。`, 'success');
        return results;
      },
    });
    guiProbeTaskRef.current = task;
    const settled = await task.startTask();
    if (settled.status === 'failed') notify('GUI 能力探测失败', settled.error || '未知错误', 'danger');
    else if (settled.status !== 'done') notify('已停止等待 GUI 探测', settled.note || '本页已停止等待；探测不写板，可稍后重试。', 'warning');
  };

  const loadJournal = async () => {
    if (!lastRun) return;
    setBusy('journal');
    try {
      const audit = await runtimeClient.automationRun(lastRun.runId);
      setJournal({ runId: audit.runId, entries: audit.entries, chainOk: audit.chain.ok, brokenAt: audit.chain.brokenAt });
    } catch (caught) {
      fail(caught, '读取审计链');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Panel
        eyebrow="AI DECISION · DETERMINISTIC RECIPES · DESKTOP CONTROL"
        title="自动化执行中心"
        meta="AI 选配方/填参数 → API 优先、GUI 兜底 → 每步读回验证 → 写板批准一次一用"
        actions={<Button icon={<RefreshCw size={15} />} loading={busy === 'refresh' || busy === 'load'} onClick={() => void refresh()} disabled={!realRuntime || Boolean(busy)}>刷新配方</Button>}
      >
        {!realRuntime && (
          <div className="inline-alert inline-alert--warning">
            <AlertTriangle size={16} />
            <span>当前是 DEMO 模式或 Runtime 未连接：自动化中心只展示配方元信息，不能签发批准或执行。请先启动本机 Runtime 并连接嘉立创EDA。</span>
          </div>
        )}
        {error && <div className="inline-alert inline-alert--danger"><XCircle size={16} /><span>{error}</span></div>}
        <div className="stats-grid stats-grid--4">
          <Stat label="已登记配方" value={recipes.length} hint="确定性步骤序列" />
          <Stat label="可执行写入" value={recipes.filter((recipe) => recipe.requiredApprovals.length > 0).length} hint="需服务端批准" tone="info" />
          <Stat label="可用批准" value={approvals.length} hint="一次性 · 绑定当前 EDA 目标" tone={approvals.length ? 'success' : 'warning'} />
          <Stat label="最近运行" value={lastRun ? (lastRun.ok ? '通过' : '未通过') : '—'} hint={lastRun ? lastRun.recipeId : '尚未运行'} tone={lastRun ? (lastRun.ok ? 'success' : 'danger') : 'neutral'} />
        </div>
      </Panel>

      <div className="split-layout">
        <Panel eyebrow="RECIPES" title="配方" meta="写入配方要求写板批准；只读配方可直接运行">
          <TableFrame label="自动化配方列表">
            <table className="table">
              <thead><tr><th>配方</th><th>步骤</th><th>批准</th><th>说明</th></tr></thead>
              <tbody>
                {recipes.map((recipe) => (
                  <tr key={recipe.id} className={selected?.id === recipe.id ? 'row-selected' : ''} onClick={() => { setSelectedId(recipe.id); setLastRun(null); setJournal(null); }}>
                    <td><strong>{recipe.title}</strong><br /><code>{recipe.id}</code></td>
                    <td>{recipe.stepCount}</td>
                    <td>{recipe.requiredApprovals.length ? recipe.requiredApprovals.map((scope) => <Badge key={scope} tone="warning">{scope}</Badge>) : <Badge tone="success">只读</Badge>}</td>
                    <td>{recipe.summary}</td>
                  </tr>
                ))}
                {!recipes.length && <tr><td colSpan={4}>暂无配方（Real Runtime 连接后自动加载）</td></tr>}
              </tbody>
            </table>
          </TableFrame>
        </Panel>

        <Panel
          eyebrow="EXECUTE"
          title={selected ? selected.title : '选择配方'}
          meta={selected ? selected.summary : '从左侧选择一条配方'}
          actions={selected && (
            <div className="row-actions">
              {requiredApprovals.length > 0 && <Button icon={<KeyRound size={15} />} loading={busy === 'approve'} disabled={Boolean(busy) || !realRuntime} onClick={() => void approve()}>{requiredApprovals.includes('release') ? '签发放行批准' : '签发写板批准'}</Button>}
              <Button variant="primary" icon={<Play size={15} />} loading={busy === 'run'} disabled={Boolean(busy) || !realRuntime || !selected} onClick={() => void run()}>运行配方</Button>
              {busy === 'run' && activeRunId && <Button icon={<Square size={15} />} loading={aborting} onClick={() => void abortRun()}>中止运行</Button>}
            </div>
          )}
        >
          {selected && (
            <>
              <div className="detail-block">
                <span>步骤</span>
                <ol>
                  {selected.steps.map((step) => (
                    <li key={step.id}>
                      <strong>{step.title}</strong> · <code>{step.kind}</code> · <code>{step.action}</code>
                      {step.fallback ? <Badge tone="info">可兜底</Badge> : null}
                      {step.approval ? <Badge tone="warning">{step.approval}</Badge> : null}
                    </li>
                  ))}
                </ol>
              </div>
              {Object.keys(selected.params).length > 0 && (
                <div className="detail-block">
                  <span>运行参数</span>
                  {Object.entries(selected.params).map(([name, spec]) => (
                    <label key={name} className="field">
                      <span>{name}{spec.required ? '（必填）' : '（可选）'}</span>
                      <input className="input" value={params[name] ?? ''} placeholder={spec.description || name} onChange={(event) => setParams((current) => ({ ...current, [name]: event.target.value }))} />
                    </label>
                  ))}
                </div>
              )}
              {requiredApprovals.length > 0 && (
                <div className="inline-alert inline-alert--warning">
                  <ShieldCheck size={16} />
                  <span>这是写入配方：需要先在服务端签发写板批准（绑定当前窗口+工程+文档指纹，一次性、30 分钟）。批准后立即运行；切换文档后批准自动失效。</span>
                </div>
              )}
            </>
          )}
        </Panel>
      </div>

      <Panel
        eyebrow="RECOVERY · RESTART-SAFE"
        title="中断运行恢复（E7）"
        meta={recovery ? <Badge tone={recovery.runs.length ? 'warning' : 'success'}>{recovery.available ? `${recovery.runs.length} 个待处理` : '不可用'}</Badge> : <Badge tone="neutral">未扫描</Badge>}
        actions={<Button icon={<RefreshCw size={15} />} loading={busy === 'recovery'} disabled={!realRuntime || Boolean(busy)} onClick={() => void loadRecovery()}>扫描中断运行</Button>}
      >
        <p><small>只读扫描自动化 journal，找出没有终态事件的 run。只有"全程只读"的中断 run 可以一键安全重放；一旦中断前发出过写动作（落板/铺铜/保存），一律标记 <code>needs_human</code>，必须先人工读回现场确认，绝不自动重放写动作。重放成功会在原 run 的审计链里记 <code>run.recovered</code>。</small></p>
        {recovery && !recovery.available && <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>恢复扫描不可用：{recovery.reason}</span></div>}
        {recovery?.available && (
          <TableFrame label="中断运行列表">
            <table className="table">
              <thead><tr><th>Run</th><th>配方</th><th>最后阶段</th><th>已完成步骤</th><th>结论</th><th>操作</th></tr></thead>
              <tbody>
                {recovery.runs.map((run) => (
                  <tr key={run.runId}>
                    <td><code>{run.runId}</code><br /><small>{run.lastAt ? new Date(run.lastAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</small></td>
                    <td>{run.recipeTitle ?? run.recipeId ?? '—'}</td>
                    <td><code>{run.lastPhase ?? '—'}</code>{run.currentStep ? <><br /><small>当前步骤：{run.currentStep}</small></> : null}</td>
                    <td>{run.completedSteps.length ? run.completedSteps.join('、') : '无'}</td>
                    <td>
                      {run.verdict === 'readonly_replayable' ? <Badge tone="success">可安全重放</Badge> : run.verdict === 'needs_human' ? <Badge tone="danger">需人工确认</Badge> : <Badge tone="warning">{run.verdict}</Badge>}
                      <br /><small>{run.reason}</small>
                    </td>
                    <td>
                      {run.verdict === 'readonly_replayable'
                        ? <Button icon={<Play size={14} />} loading={replayTask?.status === 'running'} disabled={Boolean(busy)} onClick={() => void replayRun(run)}>安全重放</Button>
                        : <small>需人工读回现场后再决定（不提供一键重放）</small>}
                    </td>
                  </tr>
                ))}
                {!recovery.runs.length && <tr><td colSpan={6}>没有中断的 run（所有 run 都有终态事件）。</td></tr>}
              </tbody>
            </table>
          </TableFrame>
        )}
        <LongTaskPanel title="安全重放长任务（D8：取消只停止本页等待，重放可能已在服务端开始）" snapshot={replayTask} onCancel={replayTask?.status === 'running' ? () => replayTaskRef.current?.cancelTask() : undefined} onRetry={() => void loadRecovery()} cancelLabel="停止等待重放" retryLabel="重新扫描中断运行" />
      </Panel>

      <Panel eyebrow="APPROVALS · ONE-TIME · BOUND" title="可用写板批准" meta={<Badge tone={approvals.length ? 'success' : 'neutral'}>{approvals.length} 个</Badge>}>
        <p><small>批准由服务端签发并绑定当前 EDA 窗口+工程+文档指纹，一次性有效、30 分钟过期；运行时按指纹校验，复用/跨文档会被 409 拒绝。界面只展示，不能绕过。</small></p>
        <TableFrame label="可用批准列表">
          <table className="table">
            <thead><tr><th>作用域</th><th>目标指纹</th><th>绑定配方</th><th>签发 / 到期</th></tr></thead>
            <tbody>
              {approvals.map((approval) => (
                <tr key={approval.approvalId}>
                  <td><Badge tone="warning">{approval.scope}</Badge></td>
                  <td><code>{approval.fingerprint?.slice(0, 16) ?? '—'}</code></td>
                  <td>{approval.recipeId ?? '任意写入'}</td>
                  <td>{new Date(approval.issuedAt).toLocaleTimeString('zh-CN', { hour12: false })} → {new Date(approval.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}</td>
                </tr>
              ))}
              {!approvals.length && <tr><td colSpan={4}>没有可用批准；真实写入会返回 needs_approval 且不执行任何步骤。</td></tr>}
            </tbody>
          </table>
        </TableFrame>
      </Panel>

      <Panel
        eyebrow="GUI FALLBACK CAPABILITIES"
        title="GUI 兜底能力探测（E9，只读）"
        meta={guiProbe ? <Badge tone="success">2 种尺寸已探测</Badge> : <Badge tone="neutral">未探测</Badge>}
        actions={<Button icon={<RefreshCw size={15} />} loading={guiProbeTask?.status === 'running'} disabled={!realRuntime || busy !== null} onClick={() => void probeGuiCapabilities()}>探测两种窗口尺寸</Button>}
      >
        <p><small>只调用 findTexts（不点击、不输入、不写板）：检查本机 EDA 上兜底动作的菜单/按钮文案是否还在，并在 1280×800 与 1920×1080 两种布局下各探测一次。缺失文案意味着 GUI 兜底会失败——需要先补文案映射或改用 API，不把"没找到"当成功。</small></p>
        {guiProbe ? (
          <div className="detail-stack">
            <div className="stats-grid stats-grid--4">
              {guiProbe.map((item) => <Stat key={item.viewport} label={`可用动作 @${item.viewport}`} value={item.available} hint={`缺失文案 ${item.missing.length} 个`} tone={item.missing.length ? 'warning' : 'success'} />)}
              <Stat label="截图证据" value={guiProbe[0]?.screenshot?.kind === 'os-window-capture' ? '窗口截图' : guiProbe[0]?.screenshot?.path ? 'CDP 截图' : '无'} hint={guiProbe[0]?.screenshot?.sha256?.slice(0, 12) ?? guiProbe[0]?.screenshot?.error ?? '—'} tone={guiProbe[0]?.screenshot?.path ? 'success' : 'warning'} />
            </div>
            {guiProbe[0] ? (
              <TableFrame label="兜底动作清单（首种尺寸）">
                <table className="table">
                  <thead><tr><th>动作</th><th>绑定配方</th><th>可用</th><th>缺失文案</th></tr></thead>
                  <tbody>
                    {guiProbe[0].capabilities.map((item) => (
                      <tr key={item.id}>
                        <td>{item.blocked ? <Badge tone="danger">政策禁止</Badge> : item.available ? <Badge tone="success">可用</Badge> : <Badge tone="warning">不可用</Badge>} {item.label}<br /><small><code>{item.id}</code></small></td>
                        <td><small>{item.recipeIds.length ? item.recipeIds.join('、') : '候选（未绑定配方）'}</small></td>
                        <td>{item.blocked ? '—' : item.complete ? '完整' : '部分'}</td>
                        <td><small>{item.blocked ? item.reason : item.missingTexts.join('、') || '—'}</small></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            ) : null}
            {guiProbe[0]?.screenshot?.path ? <div className="detail-block"><span>截图证据（仅 EDA 窗口）</span><p><code>{guiProbe[0].screenshot.path}</code> · sha256 {guiProbe[0].screenshot.sha256?.slice(0, 16)}…</p>{guiProbe[0].screenshot.cdpError ? <small>CDP 截图失败已降级为 macOS 窗口截图：{guiProbe[0].screenshot.cdpError}</small> : null}</div> : null}
          </div>
        ) : <div className="empty-inline"><RefreshCw size={24} /><strong>还没有探测结果</strong><span>连接真实 EDA 后点击"探测两种窗口尺寸"；探测是只读的，不会改动板子。</span></div>}
        <LongTaskPanel title="GUI 兜底能力探测长任务（D8：取消只停止本页等待）" snapshot={guiProbeTask} onCancel={guiProbeTask?.status === 'running' ? () => guiProbeTaskRef.current?.cancelTask() : undefined} onRetry={() => void probeGuiCapabilities()} cancelLabel="停止等待探测" retryLabel="重新探测" />
      </Panel>

      <Panel
        eyebrow="AI ORCHESTRATION · DETERMINISTIC · HUMAN-REVIEW"
        title="目标编排与失败恢复（E10）"
        meta={<Badge tone={orchestrationPlan ? (orchestrationPlan.ok ? 'success' : 'warning') : 'neutral'}>{orchestrationPlan ? (orchestrationPlan.ok ? '计划可用（需人审）' : '有阻断') : '未生成'}</Badge>}
        actions={<Button icon={<ListChecks size={15} />} loading={busy === 'e10-plan'} disabled={busy !== null} onClick={() => void generateOrchestrationPlan()}>生成配方序列</Button>}
      >
        <p><small>目标 → 配方序列是**确定性映射**，不是让模型自由点界面：只出计划、不执行、不代批准。计划里的写步骤必须另行签发一次性写板批准；DRC/导出/人审是 gate 节点，由对应页面与证据链负责。预算只控配方数/写配方数/预计秒数，token 预算明确不在此层（不假装有 token 控制）。</small></p>
        <div className="row-actions">
          <input className="input" style={{ flex: 1, minWidth: 280 }} value={orchestrationGoal} onChange={(event) => setOrchestrationGoal(event.target.value)} placeholder="例如：把这块板从网表同步到 PCB，并跑 DRC" />
          <input className="input" type="number" min={1} max={20} value={orchestrationBudget.maxRecipes} onChange={(event) => setOrchestrationBudget({ ...orchestrationBudget, maxRecipes: Number(event.target.value) })} title="最多配方数" style={{ width: 90 }} />
          <input className="input" type="number" min={0} max={10} value={orchestrationBudget.maxWriteRecipes} onChange={(event) => setOrchestrationBudget({ ...orchestrationBudget, maxWriteRecipes: Number(event.target.value) })} title="最多写配方数" style={{ width: 90 }} />
          <input className="input" type="number" min={1} max={3600} value={orchestrationBudget.maxEstimatedSeconds} onChange={(event) => setOrchestrationBudget({ ...orchestrationBudget, maxEstimatedSeconds: Number(event.target.value) })} title="预计秒数上限" style={{ width: 110 }} />
        </div>
        {orchestrationPlan && (
          <div className="detail-stack">
            <p><Badge tone={orchestrationPlan.budget.ok ? 'success' : 'warning'}>{orchestrationPlan.profile.label}</Badge> · 配方 {orchestrationPlan.budget.usage.recipes}（写 {orchestrationPlan.budget.usage.writeRecipes}）· 预计 {orchestrationPlan.budget.usage.estimatedSeconds}s · 预算上限 {orchestrationPlan.budget.limits.maxRecipes} 配方 / {orchestrationPlan.budget.limits.maxWriteRecipes} 写 / {orchestrationPlan.budget.limits.maxEstimatedSeconds}s</p>
            {orchestrationPlan.budget.blockers.length ? <div className="inline-alert inline-alert--danger"><XCircle size={16} /><span>{orchestrationPlan.budget.blockers.map((blocker) => `[${blocker.code}] ${blocker.message}`).join('；')}</span></div> : null}
            <TableFrame label="配方序列（依赖顺序）">
              <table className="table">
                <thead><tr><th>#</th><th>节点</th><th>阶段</th><th>配方 / gate</th><th>参数推断</th><th>依赖</th><th>批准</th><th>原因 / 期望证据</th></tr></thead>
                <tbody>
                  {orchestrationPlan.nodes.map((node, index) => (
                    <tr key={node.id}>
                      <td>{index + 1}</td>
                      <td><code>{node.id}</code></td>
                      <td><Badge tone={node.stage === 'write' ? 'warning' : node.stage === 'gate' ? 'neutral' : 'success'}>{node.stage}</Badge></td>
                      <td>{node.kind === 'gate' ? <Badge tone="neutral">gate · {node.gateId}</Badge> : <code>{node.recipeId}</code>}</td>
                      <td><small>{node.kind === 'gate' ? '—' : node.paramsInference?.ok === true ? `已推断 ${Object.keys(node.params).length} 项` : node.paramsInference?.ok === false ? <span style={{ color: 'var(--danger, #b42318)' }}>证据不足：{node.paramsInference.missing?.join('、')}</span> : '未推断（未提供证据）'}</small></td>
                      <td><small>{node.dependsOn.join('、') || '—'}</small></td>
                      <td>{node.approvalRequired ? <Badge tone="warning">需写板批准</Badge> : '无'}</td>
                      <td><small>{node.reason}<br />{node.expectedEvidence}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
            <small>决策日志：{orchestrationPlan.decisionLog.map((entry) => entry.detail).join('；')}</small>
            {orchestrationPlan.warnings.length ? <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>{orchestrationPlan.warnings.join('；')}</span></div> : null}
          </div>
        )}
        <div className="detail-block">
          <span>失败恢复建议（人审；写动作永不自动重放）</span>
          <div className="row-actions">
            <input className="input" value={failureInput.errorCode} onChange={(event) => setFailureInput({ ...failureInput, errorCode: event.target.value })} placeholder="错误码，例如 READBACK_MISMATCH" style={{ minWidth: 240 }} />
            <select className="input" value={failureInput.stage} onChange={(event) => setFailureInput({ ...failureInput, stage: event.target.value as 'read' | 'write' | 'verify' | 'gate' })}>
              <option value="read">read（只读）</option>
              <option value="write">write（写步骤）</option>
              <option value="verify">verify（校验）</option>
              <option value="gate">gate（DRC/导出/人审）</option>
            </select>
            <input className="input" type="number" min={1} max={10} value={failureInput.attempt} onChange={(event) => setFailureInput({ ...failureInput, attempt: Number(event.target.value) })} title="第几次尝试" style={{ width: 90 }} />
            <Button icon={<ShieldCheck size={15} />} loading={busy === 'e10-recovery'} disabled={busy !== null} onClick={() => void requestFailureRecovery()}>获取恢复建议</Button>
          </div>
          {recoveryDecision && (
            <div className="detail-stack">
              <span>决策 <Badge tone={recoveryDecision.decision.action === 'retry_same_node' ? 'warning' : 'danger'}>{recoveryDecision.decision.action}</Badge> · 需重新批准 {recoveryDecision.decision.requiresReapproval ? '是' : '否'} · 自动重放 {recoveryDecision.decision.autoReplayAllowed ? '允许（不应出现）' : '禁止'} · 人审 {recoveryDecision.humanReviewRequired ? '必需' : '不需要'}</span>
              <ul>{recoveryDecision.explanation.map((line) => <li key={line}>{line}</li>)}</ul>
              <small>{recoveryDecision.policy}</small>
            </div>
          )}
        </div>
      </Panel>

      {lastRun && (
        <Panel
          eyebrow="RUN RESULT"
          title="最近一次运行"
          meta={`${lastRun.recipeId} · ${lastRun.runId.slice(0, 8)}`}
          actions={<Badge tone={stateTone(lastRun.state)}>{stateLabel[lastRun.state] || lastRun.state}</Badge>}
        >
          {lastRun.failedStep && (
            <div className="inline-alert inline-alert--danger">
              <XCircle size={16} />
              <span><strong>失败步骤：{lastRun.failedStep.stepId}</strong> · {lastRun.failedStep.failures.join('；')}</span>
            </div>
          )}
          {lastRun.missingApprovals?.length ? <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>缺少批准：{lastRun.missingApprovals.join('、')}（未执行任何步骤）</span></div> : null}
          {lastRun.missingParams?.length ? <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>缺少参数：{lastRun.missingParams.join('、')}（未执行任何步骤）</span></div> : null}
          <TableFrame label="运行步骤结果">
            <table className="table">
              <thead><tr><th>步骤</th><th>结果</th><th>策略</th><th>读回</th></tr></thead>
              <tbody>
                {lastRun.steps.map((step) => (
                  <tr key={step.stepId}>
                    <td><code>{step.stepId}</code></td>
                    <td>{step.verified ? <Badge tone="success">读回通过</Badge> : <Badge tone="danger">未通过</Badge>}</td>
                    <td>{step.strategy ? <Badge tone={step.strategy === 'fallback' ? 'info' : 'neutral'}>{step.strategy === 'fallback' ? 'GUI 兜底' : 'API 主通道'}</Badge> : '—'}</td>
                    <td><small>{step.evidence?.checks ? `${step.evidence.checks} 条断言` : '—'} · {step.evidence?.stateDigest?.slice(0, 12) ?? '—'}</small></td>
                  </tr>
                ))}
                {!lastRun.steps.length && <tr><td colSpan={4}>该次运行未执行任何步骤（见上方原因）。</td></tr>}
              </tbody>
            </table>
          </TableFrame>
          <div className="row-actions">
            <Button icon={<ListChecks size={15} />} loading={busy === 'journal'} disabled={!lastRun.runId} onClick={() => void loadJournal()}>查看哈希链审计</Button>
            <Button icon={<ShieldCheck size={15} />} loading={busy === 'audit-bundle'} disabled={!lastRun.runId} onClick={() => void loadAuditBundle()}>写步骤审计包（E11）</Button>
          </div>
          {journal && (
            <div className="detail-block">
              <span>审计链 {journal.chainOk ? <Badge tone="success">完整</Badge> : <Badge tone="danger">断裂 @{journal.brokenAt}</Badge>} · {journal.entries.length} 条</span>
              <TableFrame label="自动化审计链">
                <table className="table">
                  <thead><tr><th>#</th><th>阶段</th><th>步骤</th><th>结果</th></tr></thead>
                  <tbody>
                    {journal.entries.map((entry) => (
                      <tr key={entry.seq}>
                        <td>{entry.seq}</td>
                        <td><code>{entry.phase}</code></td>
                        <td>{typeof entry.stepId === 'string' ? entry.stepId : '—'}</td>
                        <td>{entry.ok === undefined ? '—' : entry.ok ? <CheckCircle2 size={14} color="#1f9d55" /> : <XCircle size={14} color="#d64545" />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
              <small>链校验：hash = sha256(prevHash + core)，任何篡改/插入/删除都会在 brokenAt 处失败。</small>
            </div>
          )}
          {auditBundle && (
            <div className="detail-block">
              <span>
                写步骤安全审计包（E11）·
                链 {auditBundle.chain.ok ? <Badge tone="success">完整</Badge> : <Badge tone="danger">断裂 @{auditBundle.chain.brokenAt}</Badge>} ·
                证据 {auditBundle.summary.evidenceComplete ? <Badge tone="success">齐备</Badge> : <Badge tone="warning">有缺口</Badge>}
              </span>
              <p>
                批准 id：{auditBundle.approvals.approvalIds.length ? auditBundle.approvals.approvalIds.map((id) => <code key={id}>{id}</code>) : '无'} ·
                目标指纹 <code>{auditBundle.approvals.operatorBinding.fingerprint || '—'}</code>
              </p>
              <small>{auditBundle.approvals.operatorBinding.note}</small>
              {auditBundle.warnings.length ? (
                <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>{auditBundle.warnings.map((warning) => `[${warning.code}] ${warning.message}`).join('；')}</span></div>
              ) : null}
              {auditBundle.writeSteps.length ? (
                <TableFrame label="写步骤证据（before/after 截图摘要 + 读回）">
                  <table className="table">
                    <thead><tr><th>步骤</th><th>before sha256</th><th>after sha256</th><th>读回</th></tr></thead>
                    <tbody>
                      {auditBundle.writeSteps.map((step) => (
                        <tr key={step.stepId}>
                          <td><code>{step.stepId}</code></td>
                          <td><code>{(step.evidence.before?.sha256 || '—').slice(0, 12)}</code><small>{step.evidence.before?.kind || (step.evidence.before?.error ? '失败' : '')}</small></td>
                          <td><code>{(step.evidence.after?.sha256 || '—').slice(0, 12)}</code><small>{step.evidence.after?.kind || (step.evidence.after?.error ? '失败' : '')}</small></td>
                          <td>{step.readbacks.some((item) => item.ok) ? <Badge tone="success">已读回</Badge> : <Badge tone="warning">缺失</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              ) : <p>本次运行没有写步骤（只读配方不产生写步骤证据）。</p>}
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
