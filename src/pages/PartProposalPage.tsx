import { useMemo, useState, useRef } from 'react';
import { AlertTriangle, CheckCircle2, ListChecks, Search, ShieldCheck } from 'lucide-react';
import { runtimeClient, type PartProposal, type PartProposalPlanResult, type SchematicBatchItem, type SchematicBatchResult } from '../services/runtimeClient';
import { createSingleCallTask, type LongTaskSnapshot } from '../services/longTask';
import { LongTaskPanel } from '../components/LongTaskPanel';
import { saveSchematicPlanDraft } from '../services/draftStore';
import { useApp } from '../state/AppContext';
import { Badge, Button, Field, Panel, Stat, TableFrame } from '../components/ui';

const splitList = (value: string) => value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);

const priceText = (price: PartProposal['candidates'][number]['price']) => {
  if (price.status !== 'priced') return '无证据';
  const unit = Number.isFinite(Number(price.unitPrice)) ? `$${Number(price.unitPrice).toFixed(4)}` : '—';
  const stock = Number.isFinite(Number(price.stock)) ? `库存 ${Number(price.stock).toLocaleString('en-US')}` : '库存未知';
  return `${unit} · ${stock}`;
};

/**
 * 元件选型：需求 → AI/库检索候选（真实料号 + 真实价格库存）→ **用户勾选** → 落 plan。
 * 本页只做只读提案与计划的生成：真正落板仍必须走审批（planHash 绑定）与执行，页面不会替你写工程。
 */
export function PartProposalPage() {
  const { state, navigate, notify, addAudit } = useApp();
  // P1-1（复审 2026-10-29）：批量落件是真实写板（服务端逐件 create + 保存），必须跟随 Runtime 写门禁。
  // 修复前按钮只看任务状态，暂停时点了才被服务端 409 EDA_WRITE_PAUSED 拒绝。
  const writeGateClosed = state.settings.writePaused || state.settings.sessionPaused === true;
  const pauseReason = state.settings.writePaused ? 'Runtime 全局写入已暂停：请先在设置页恢复' : '本会话写入已暂停：请关闭 EDA 页「暂停本会话写入」';
  const [requirement, setRequirement] = useState('真板补光：板上 5 颗可编程 RGB（WS2812B-2020）+ 数据线串阻 + 每颗去耦；+5V 供电');
  const [queries, setQueries] = useState('WS2812B-2020, 0402WGF1000TCE, 0402B104K500NT');
  const [nets, setNets] = useState('+5V, GND, LED_DATA');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState<PartProposal | null>(null);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [planned, setPlanned] = useState<PartProposalPlanResult | null>(null);
  // A6/R3：原理图批量落件（先 dry-run 计划，再显式签发写板批准后逐件写入；失败可续跑）。
  const [batchItemsText, setBatchItemsText] = useState('[]');
  // D8：批量落件是服务端一次长调用（有真实写入），用统一单调用控制器接管取消/超时措辞。
  const [batchTask, setBatchTask] = useState<LongTaskSnapshot<SchematicBatchResult> | null>(null);
  // D8：dry-run 计划同样是 600s 级服务端调用；与执行分开两个控制器，避免共用 busy 掩盖各自状态。
  const [batchPlanTask, setBatchPlanTask] = useState<LongTaskSnapshot<SchematicBatchResult> | null>(null);
  const batchPlanTaskRef = useRef<ReturnType<typeof createSingleCallTask<SchematicBatchResult>> | null>(null);
  const batchTaskRef = useRef<ReturnType<typeof createSingleCallTask<SchematicBatchResult>> | null>(null);
  const [batchPlan, setBatchPlan] = useState<SchematicBatchResult | null>(null);
  const [batchError, setBatchError] = useState('');
  // D8：AI 候选提案是 180s 级只读长调用，用统一单调用控制器接管取消/超时/重试措辞。
  const [searchTask, setSearchTask] = useState<LongTaskSnapshot<PartProposal> | null>(null);
  const searchTaskRef = useRef<ReturnType<typeof createSingleCallTask<PartProposal>> | null>(null);

  const pickedIds = useMemo(() => Object.entries(picked).flatMap(([id, qty]) => Array.from({ length: qty }, () => id)), [picked]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const search = () => {
    setPlanned(null);
    setError('');
    const task = createSingleCallTask<PartProposal>({
      call: async (signal) => {
        const { proposal: result } = await runtimeClient.partProposal({
          requirement,
          queries: splitList(queries),
          nets: splitList(nets),
          title: '候选提案落地计划',
        }, { signal });
        setProposal(result);
        setPicked({});
        return result;
      },
      timeoutMs: 170_000,
      onUpdate: setSearchTask,
    });
    searchTaskRef.current = task;
    void task.startTask();
  };

  const toggle = (candidateId: string) => setPicked((prev) => {
    const next = { ...prev };
    if (next[candidateId]) delete next[candidateId];
    else next[candidateId] = 1;
    return next;
  });

  const setQuantity = (candidateId: string, quantity: number) => setPicked((prev) => ({
    ...prev,
    [candidateId]: Math.max(1, Math.min(40, Math.floor(quantity) || 1)),
  }));

  const plan = () => run(async () => {
    if (!proposal || !pickedIds.length) return;
    setPlanned(await runtimeClient.partProposalPlan({
      proposal,
      selectedIds: pickedIds,
      nets: splitList(nets),
      title: '候选提案落地计划',
    }));
  });

  /**
   * 把"已就绪的计划"送到 EDA 页的计划编辑器（而不是只显示在本页）。
   * 交接的是 normalizePlan 产出的结构化计划 + 同一 planHash：EDA 页再校验/批准时
   * 批准的就是这一份哈希，不会因为换页面而重新生成出另一份。
   */
  const sendToDesignApproval = () => {
    if (!planned?.planning.ready) return;
    const draft = saveSchematicPlanDraft({
      plan: planned.plan as unknown as Record<string, unknown>,
      planHash: planned.planHash,
      sourceLabel: `选型提案 ${planned.proposalId?.slice(0, 12) || planned.planHash.slice(0, 12)}`,
      source: 'part-proposal',
    });
    addAudit('ai', '选型计划交接至EDA页', `${draft.planHash?.slice(0, 12)} · ${planned.selection.totalParts} 条`, 'info');
    notify('计划已送入 EDA 设计批准', 'EDA 页已载入计划编辑器：请依次点“3. 校验计划”→"4. 人工批准"，批准绑定同一 planHash。', 'success');
    navigate('eda');
  };

  const parseBatchItems = (): SchematicBatchItem[] => {
    let parsed: unknown;
    try { parsed = JSON.parse(batchItemsText); } catch { throw new Error('批量落件 JSON 无法解析：请检查括号/引号（数组元素形如 {"component":{"libraryUuid":"...","uuid":"..."},"x":10,"y":20}）'); }
    if (!Array.isArray(parsed)) throw new Error('批量落件输入必须是数组');
    return parsed as SchematicBatchItem[];
  };

  const planBatch = async () => {
    setBatchError('');
    let items: SchematicBatchItem[];
    try { items = parseBatchItems(); } catch (caught) { setBatchError(caught instanceof Error ? caught.message : String(caught)); return; }
    const task = createSingleCallTask<SchematicBatchResult>({
      timeoutMs: 600_000,
      onUpdate: setBatchPlanTask,
      call: async (signal) => {
        const result = await runtimeClient.schematicComponentBatchPlan({ items, dryRun: true }, { signal });
        setBatchPlan(result);
        addAudit('validation', 'A6 批量落件计划', `${result.plan.counts.create ?? 0} 新建 / ${result.plan.counts.skipExisting ?? 0} 已存在 · ${result.plan.planHash.slice(0, 12)}`, 'info');
        notify('批量落件计划已生成', `新建 ${result.plan.counts.create ?? 0} 项，已存在 ${result.plan.counts.skipExisting ?? 0} 项；尚未写入任何器件。`, 'info');
        return result;
      },
    });
    batchPlanTaskRef.current = task;
    const settled = await task.startTask();
    if (settled.status === 'failed') { setBatchError(settled.error || '批量落件计划生成失败'); setBatchPlan(null); }
    else if (settled.status !== 'done') { setBatchPlan(null); setBatchError(settled.note || '已停止等待计划生成（本页已停止等待，服务端可能仍在计算，未写入任何器件）。'); }
  };

  const applyBatch = async () => {
    if (writeGateClosed) return notify('写入已暂停', `${pauseReason}，再签发写板批准并执行批量落件。`, 'warning');
    setBatchError('');
    let items: SchematicBatchItem[];
    try { items = parseBatchItems(); } catch (caught) { setBatchError(caught instanceof Error ? caught.message : String(caught)); return; }
    const task = createSingleCallTask<SchematicBatchResult>({
      timeoutMs: 600_000,
      onUpdate: setBatchTask,
      call: async (signal) => {
        // 写板批准由服务端绑定当前 EDA 窗口+工程+文档指纹；本页只发起签发，不绕过校验。
        const approval = await runtimeClient.issueAutomationApproval({ scope: 'write', note: 'A6/R3 原理图批量落件（UI 签发）' });
        if (signal.aborted) throw new Error('已停止等待');
        return runtimeClient.schematicComponentBatchApply({ items, dryRun: false, save: true, approvalIds: [approval.approvalId] }, { signal });
      },
    });
    batchTaskRef.current = task;
    const settled = await task.startTask();
    if (settled.status === 'done' && settled.result) {
      const result = settled.result;
      setBatchPlan(result);
      addAudit('validation', 'A6 批量落件执行', `planHash ${result.plan.planHash.slice(0, 12)} · 新建/跳过见结果`, 'success');
      notify('批量落件已执行', `新建 ${result.applied?.created ?? '?'} 项，跳过 ${result.applied?.skipped ?? '?'} 项；失败会停在失败项，可用同一 planHash 续跑。`, 'success');
    } else if (settled.status === 'failed') {
      setBatchError(settled.error || '批量落件失败');
    }
  };

  const cancelBatch = () => { batchTaskRef.current?.cancelTask(); };

  return (
    <>
      <div className="stats-grid stats-grid--4">
        <Stat label="候选型号" value={proposal ? proposal.summary.candidates : '—'} hint="全部来自真实库检索" />
        <Stat label="有 LCSC 料号" value={proposal ? proposal.summary.withLcscId : '—'} hint="料号是器件身份锚点" tone={proposal && proposal.summary.withLcscId === proposal.summary.candidates ? 'success' : 'warning'} />
        <Stat label="有价格/库存证据" value={proposal ? proposal.summary.priced : '—'} hint="无证据一律 unknown，不猜" tone={proposal && proposal.summary.unknownPrice === 0 ? 'success' : 'warning'} />
        <Stat label="已勾选用量" value={pickedIds.length} hint="同一型号可重复勾选表示数量" tone={pickedIds.length ? 'info' : 'neutral'} />
      </div>

      <Panel eyebrow="REQUIREMENT → CANDIDATES" title="① 用需求换候选型号" actions={<Button variant="primary" icon={<Search size={15} />} loading={searchTask?.status === 'running'} onClick={search}>生成候选提案</Button>}>
        <div className="form-grid">
          <Field label="需求描述" hint="写清用途、数量、供电轨；它是可追溯的选型依据">
            <textarea className="input" rows={2} value={requirement} onChange={(event) => setRequirement(event.target.value)} />
          </Field>
          <div className="form-row">
            <Field label="检索关键词 / LCSC 料号" hint="逗号分隔；C 开头按料号精确查，其余按关键词查">
              <input className="input" value={queries} onChange={(event) => setQueries(event.target.value)} />
            </Field>
            <Field label="本条需求涉及的网络" hint="只声明你认可的网络名，系统不替你发明网络">
              <input className="input" value={nets} onChange={(event) => setNets(event.target.value)} />
            </Field>
          </div>
          {error && <div className="inline-alert"><AlertTriangle size={16} /><span>{error}</span></div>}
          {proposal && (
            <div className="inline-alert">
              <ShieldCheck size={16} />
              <span>提案 <code>{proposal.proposalId.slice(0, 12)}</code>：{proposal.summary.priced} 条有价格证据、{proposal.summary.unknownPrice} 条无证据、{proposal.summary.stockWarnings} 条备料告警（无证据 ≠ 无价格）。</span>
            </div>
          )}
        </div>
        <LongTaskPanel title="候选提案长任务（D8：取消只停止本页等待，服务端可能仍在检索）" snapshot={searchTask} onCancel={searchTask?.status === 'running' ? () => searchTaskRef.current?.cancelTask() : undefined} onRetry={search} cancelLabel="停止等待" retryLabel="重新生成" />
      </Panel>

      {proposal && (
        <Panel eyebrow="HUMAN PICK" title="② 勾选你要用的型号与数量" meta={`已选 ${pickedIds.length} 颗 / 共 ${proposal.candidates.length} 个候选`} actions={<Button variant="primary" icon={<ListChecks size={15} />} loading={busy} disabled={!pickedIds.length} onClick={plan}>落入计划</Button>}>
          <TableFrame label="候选型号与证据">
            <table>
              <thead>
                <tr><th className="table-actions">选用</th><th>型号 / 料号</th><th>封装</th><th>价格 · 库存</th><th>证据</th><th className="table-actions">用量</th></tr>
              </thead>
              <tbody>
                {proposal.candidates.map((candidate) => (
                  <tr key={candidate.candidateId}>
                    <td className="table-actions">
                      <input type="checkbox" aria-label={`选用 ${candidate.name}`} checked={Boolean(picked[candidate.candidateId])} onChange={() => toggle(candidate.candidateId)} />
                    </td>
                    <td>
                      <strong>{candidate.name}</strong>
                      <div className="muted">{candidate.lcscId || '无 LCSC 料号'}{candidate.manufacturerPart ? ` · ${candidate.manufacturerPart}` : ''}</div>
                    </td>
                    <td className="muted">{candidate.footprintName || '—'}</td>
                    <td>
                      {priceText(candidate.price)}
                      {candidate.price.status !== 'priced' && <div className="muted">{candidate.price.reason}</div>}
                      {candidate.stockNote && <div><Badge tone="warning">{candidate.stockNote}</Badge></div>}
                    </td>
                    <td>
                      <Badge tone={candidate.evidence.lcscId ? 'success' : 'neutral'}>{candidate.evidence.lcscId ? '库身份+料号' : '仅库身份'}</Badge>
                      <Badge tone={candidate.evidence.price ? 'success' : 'warning'}>{candidate.evidence.price ? '有价格证据' : '价格无证据'}</Badge>
                    </td>
                    <td className="table-actions">
                      <input
                        className="input"
                        type="number"
                        min={1}
                        max={40}
                        style={{ width: 72 }}
                        disabled={!picked[candidate.candidateId]}
                        value={picked[candidate.candidateId] || 1}
                        onChange={(event) => setQuantity(candidate.candidateId, Number(event.target.value))}
                        aria-label={`${candidate.name} 用量`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
          {!proposal.candidates.length && <div className="inline-alert"><AlertTriangle size={16} /><span>没有检索到候选：换关键词，或直接用 LCSC 料号精确查。</span></div>}
        </Panel>
      )}

      {planned && (
        <Panel eyebrow="PLAN DRAFT" title="③ 落 plan 结果（尚未写入工程）" meta={planned.planning.ready ? `操作 ${planned.selection.totalParts} 条 · ${planned.planHash.slice(0, 12)}` : '未就绪'}>
          <div className="form-grid">
            {planned.planning.ready
              ? <><div className="inline-alert"><CheckCircle2 size={16} /><span>计划已就绪：{planned.selection.totalParts} 条 <code>component.create</code>，网络 {planned.plan.nets.join(' / ')}。下一步把它送到 EDA 页：校验计划 → 人工批准 → 受控执行，全程绑定同一 planHash。</span></div><div className="row-actions"><Button variant="primary" icon={<ListChecks size={15} />} onClick={sendToDesignApproval}>送到设计批准（EDA 页）</Button><code>{planned.planHash}</code></div></>
              : <div className="inline-alert"><AlertTriangle size={16} /><span>还差条件，未生成可执行计划：</span><ul>{planned.planning.missing.map((item) => <li key={item}><code>{item}</code></li>)}</ul></div>}
            <div className="muted">勾选清单：{planned.selection.selected.map((item) => `${item.lcscId || item.name}×${item.quantity}`).join(' ，')}</div>
            {planned.notes.map((note) => <div className="muted" key={note}>· {note}</div>)}
            <details>
              <summary>查看计划 JSON</summary>
              <pre style={{ maxHeight: 280, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(planned.plan, null, 2)}</pre>
            </details>
          </div>
        </Panel>
      )}
      <Panel
        eyebrow="A6 · R3 BATCH LANDING"
        title="原理图批量落件（A6/R3）"
        meta={<Badge tone={batchPlan ? 'info' : 'neutral'}>{batchPlan ? `planHash ${batchPlan.plan.planHash.slice(0, 12)}` : '未生成计划'}</Badge>}
        actions={<Button icon={<ListChecks size={15} />} loading={batchPlanTask?.status === 'running'} onClick={() => void planBatch()}>生成计划（dry-run）</Button>}
      >
        <div className="inline-alert inline-alert--warning">
          <AlertTriangle size={16} />
          <span>批量落件会**真实写入原理图**：服务端逐件创建、每件原子落进度、失败即停，可用同一 planHash 续跑；重复执行按“身份+坐标”幂等跳过。执行前必须先 dry-run 确认“新建/已存在”计数，再显式签发一次性写板批准。</span>
        </div>
        {batchError ? <div className="inline-alert inline-alert--danger"><AlertTriangle size={16} /><span>{batchError}</span></div> : null}
        <Field label="落件项 JSON（数组；每项需要 component.libraryUuid + component.uuid + x + y）">
          <textarea className="input" rows={7} value={batchItemsText} onChange={(event) => setBatchItemsText(event.target.value)} spellCheck={false} style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12 }} />
        </Field>
        <div className="row-actions">
          <Button icon={<ListChecks size={15} />} loading={batchPlanTask?.status === 'running'} onClick={() => void planBatch()} disabled={batchPlanTask?.status === 'running' || batchTask?.status === 'running'}>生成计划（dry-run，不写）</Button>
          <Button variant="primary" icon={<ShieldCheck size={15} />} loading={batchTask?.status === 'running'} onClick={() => void applyBatch()} disabled={batchPlanTask?.status === 'running' || batchTask?.status === 'running' || !batchPlan?.plan.planHash || writeGateClosed} title={writeGateClosed ? pauseReason : !batchPlan?.plan.planHash ? '先生成 dry-run 计划（需要 planHash）' : undefined}>签发写板批准并执行</Button>
          <LongTaskPanel title="批量落件长任务（D8：取消只停止本页等待）" snapshot={batchTask} onCancel={batchTask?.status === 'running' ? cancelBatch : undefined} onRetry={() => void applyBatch()} cancelLabel="停止等待写入" retryLabel="重新执行" />
          <LongTaskPanel title="批量落件计划长任务（D8：取消只停止本页等待，dry-run 不写板）" snapshot={batchPlanTask} onCancel={batchPlanTask?.status === 'running' ? () => batchPlanTaskRef.current?.cancelTask() : undefined} onRetry={() => void planBatch()} cancelLabel="停止等待计划" retryLabel="重新生成计划" />
        </div>
        <p><small>执行按钮只应在 dry-run 计划确认后进行；批准一次性、30 分钟、绑定当前 EDA 窗口+工程+文档指纹，切换文档后失效。</small></p>
        {batchPlan ? (
          <div className="detail-stack">
            <div className="stats-grid stats-grid--4">
              <Stat label="总项数" value={batchPlan.plan.counts.total ?? batchPlan.plan.items.length} />
              <Stat label="将新建" value={batchPlan.plan.counts.create ?? 0} tone={(batchPlan.plan.counts.create ?? 0) > 0 ? 'info' : 'neutral'} />
              <Stat label="已存在（跳过）" value={batchPlan.plan.counts.skipExisting ?? 0} tone="success" />
              <Stat label="身份未证明" value={batchPlan.plan.identityUnproven.length} tone={batchPlan.plan.identityUnproven.length ? 'warning' : 'success'} />
            </div>
            {batchPlan.plan.findings.length ? <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>{batchPlan.plan.findings.map((finding) => finding.message ?? finding.code ?? '发现项').join('；')}</span></div> : null}
            <TableFrame label="批量落件逐项计划">
              <table className="table">
                <thead><tr><th>动作</th><th>坐标</th><th>匹配方式</th><th>身份 key</th></tr></thead>
                <tbody>
                  {batchPlan.plan.items.map((item) => (
                    <tr key={`${item.key}-${item.coordinate}`}>
                      <td>{item.action === 'skip-existing' ? <Badge tone="success">已存在</Badge> : <Badge tone="info">新建</Badge>}</td>
                      <td><code>{item.coordinate}</code></td>
                      <td>{item.matchedBy ?? '—'}</td>
                      <td><small><code>{item.key.slice(0, 40)}</code></small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
            {batchPlan.applied ? <div className="detail-block"><span>执行结果</span><p>新建 <strong>{String(batchPlan.applied.created ?? '—')}</strong> · 跳过 <strong>{String(batchPlan.applied.skipped ?? '—')}</strong> · 保存 <strong>{String(batchPlan.applied.saved ?? '—')}</strong> · 读回验证 <strong>{String(batchPlan.applied.verified ?? '—')}</strong></p></div> : null}
          </div>
        ) : null}
      </Panel>
    </>
  );
}
