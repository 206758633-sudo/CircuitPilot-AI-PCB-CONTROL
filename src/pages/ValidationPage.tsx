import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Circle, Crosshair, Download, Factory, Link2, ListChecks, Play, Plus, RefreshCw, Search, ShieldAlert, ShieldCheck, Sparkles, Trash2, XCircle } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { demoAdapter } from '../services/demoAdapter';
import { runtimeClient, RuntimeApiError } from '../services/runtimeClient';
import { buildFixTaskFromFailure } from '../services/fixTask';
import { buildDesignFacts, EMPTY_DESIGN_FACTS, type DesignFactsDraft } from '../services/designFacts';
import { createLongTask, createSingleCallTask, type LongTaskSnapshot, type SingleCallController } from '../services/longTask';
import { LongTaskPanel } from '../components/LongTaskPanel';
import type { EdaWindow, ErcConvergenceSummary, ErcDetailMeta, ErcEvidenceEntry, ErcFinding, ErcReport, ApprovalLedgerSnapshot, DfmEvidenceEntry, DrcEvidenceEntry, DrcReport, EngineeringAnalysis, FabricationOrderCard, Finding, ProductionExportResult, ReleaseGateReport, PcbSyncVerification, SchematicRepairReport, SignoffEvidenceEntry, SupplyPricingEvidence, OrderConfirmationPayload, ValidationCheck } from '../types';
import { gateStatusLabel, gateStatusTone, groupBlockers, summarizeGate, summarizeOutputDecision } from '../services/placementViewModel';
import { Badge, Button, CopyValue, Field, Panel, Progress, Stat, TableFrame } from '../components/ui';
import { Drawer, Modal } from '../components/overlays';

/** DRC 豁免行（与 runtime/drc.mjs 的 validateExemption 对齐：必须有理由/风险/配额）。 */
interface ExemptionRow {
  id?: string;
  scope?: 'kind' | 'instance';
  match?: { errorType?: string; instanceKey?: string; ruleName?: string | null; layer?: string | null; net?: string | null; objTypes?: string[] };
  maxCount?: number;
  disposition?: string;
  dispositionReason?: string;
  reason?: string;
  risk?: string;
  approvedBy?: string;
  occurrences?: number;
  sample?: unknown;
}

const exemptionProblems = (row: ExemptionRow): string[] => {
  const problems: string[] = [];
  const scope = row.scope === 'instance' ? 'instance' : 'kind';
  if (scope === 'instance' && !String(row.match?.instanceKey || '').trim()) problems.push('instance 级必须给 instanceKey');
  if (scope === 'kind' && !String(row.match?.errorType || '').trim()) problems.push('kind 级必须给 errorType');
  if (scope === 'kind' && (!Number.isInteger(Number(row.maxCount)) || Number(row.maxCount) <= 0)) problems.push('必须给正整数 maxCount');
  if (String(row.reason || '').trim().length < 8) problems.push('理由需 ≥8 字');
  if (String(row.risk || '').trim().length < 8) problems.push('残留风险需 ≥8 字');
  return problems;
};

const checkTone = (status: ValidationCheck['status']) => status === 'pass' ? 'success' : status === 'warn' ? 'warning' : status === 'fail' ? 'danger' : status === 'running' ? 'info' : 'neutral';
const checkLabel = (status: ValidationCheck['status']) => ({ pass: '通过', warn: '警告', fail: '失败', running: '运行中', idle: '未运行' })[status];

/** 第 61 轮：桥连接状态（重连/重发现后如实展示最近一次探测结果，不假装已连接）。 */
interface BridgeStatusState {
  busy: boolean;
  checkedAt: string | null;
  port: number | null;
  windows: EdaWindow[];
  selectedWindowId: string | null;
  selectionRequired: boolean;
  error: string | null;
}
const EMPTY_BRIDGE_STATUS: BridgeStatusState = { busy: false, checkedAt: null, port: null, windows: [], selectedWindowId: null, selectionRequired: false, error: null };

const ercFindingTone = (severity: ErcFinding['severity']) => severity === 'fatal' || severity === 'error' ? 'danger' : severity === 'warning' ? 'warning' : 'neutral';

/** 运行时 `ercDetail.reason` 是稳定 code；这里只把它翻译成人话，事实仍以 code 为准。 */
const ERC_DETAIL_REASON_LABELS: Record<string, string> = {
  NO_GUI: 'EDA GUI/CDP 通道不可用',
  ERC_DETAIL_TIMEOUT: '从 EDA 检查面板抓取明细超时',
  ERC_DETAIL_NO_ITEMS: 'EDA 检查面板没有抓到逐条条目',
  ERC_DETAIL_EXTRACT_FAILED: '从 EDA 检查面板抓取明细失败',
  EDA_TARGET_CHANGED_DURING_DETAIL: '抓取期间 EDA 目标文档发生变化，明细被丢弃（不张冠李戴）',
  DETAIL_UNAVAILABLE: '运行时没有取到逐条明细',
};

/**
 * 第 61 轮：ERC 明细证据块（纯展示，便于单测 DOM 文案）。
 * 红线：`detailSource=aggregate` 或没有逐条 findings 时，只展示“聚合计数”并说明原因，
 * 绝不把聚合计数渲染成逐条条目冒充明细。
 */
export function ErcDetailEvidence({ report, ercDetail = null, onCreateFixTask }: { report: ErcReport; ercDetail?: ErcDetailMeta | null; onCreateFixTask?: (finding: ErcFinding) => void }) {
  const documentUuid = report.documentUuid ?? null;
  const detailed = report.findings.filter((finding) => !finding.aggregate);
  const aggregates = report.findings.filter((finding) => finding.aggregate);
  const hasDetails = detailed.length > 0;
  const source = report.detailSource ?? (ercDetail?.ok ? ercDetail.source ?? null : null);
  const sourceLabel = source === 'ui-dom'
    ? '明细来源：ui-dom（EDA 检查面板逐条）'
    : source === 'aggregate'
      ? '明细来源：aggregate（仅聚合计数）'
      : hasDetails
        ? '明细来源：未标注（但含逐条条目）'
        : '明细来源：未标注（无逐条明细）';
  const reason = ercDetail && ercDetail.ok === false ? String(ercDetail.reason || 'DETAIL_UNAVAILABLE') : null;
  const partial = report.detailCounts?.partial && Object.keys(report.detailCounts.partial).length
    ? Object.entries(report.detailCounts.partial).map(([severity, item]) => `${severity} ${item.detailed}/${item.expected}`).join('，')
    : '';
  return (
    <div className="erc-evidence" data-testid="erc-detail-evidence">
      <div className="detail-block" data-testid="erc-document-target">
        <span>本次 ERC 检查的原理图文档（documentUuid）</span>
        {documentUuid ? (
          <p><code data-testid="erc-document-uuid">{documentUuid}</code><small>多板工程里用它确认这次 ERC 检查的是哪一页原理图；换页后结论不能沿用，需要重新取证。</small></p>
        ) : (
          <p><strong>未记录 documentUuid</strong><small>：旧版证据或运行时没有返回；不能拿别的页面/板子的结论代替，请重新运行一次 ERC 取证。</small></p>
        )}
      </div>
      <div className="row-actions">
        <Badge tone={hasDetails ? 'success' : 'warning'}>{sourceLabel}</Badge>
        {hasDetails ? <Badge tone="success">逐条 {detailed.length} 条</Badge> : <Badge tone={aggregates.length ? 'warning' : 'neutral'}>聚合组 {aggregates.length} 个</Badge>}
        {partial ? <Badge tone="warning">部分明细：{partial}</Badge> : null}
      </div>
      {hasDetails ? (
        <TableFrame label={`ERC 逐条明细（${detailed.length} 条）`}>
          <div className="erc-findings-scroll">
            <table>
              <thead><tr><th>级别</th><th>规则 / Code</th><th>对象</th><th>说明</th><th>修复建议</th><th>结论</th></tr></thead>
              <tbody>
                {detailed.map((finding) => (
                  <tr key={finding.id}>
                    <td><Badge tone={ercFindingTone(finding.severity)}>{finding.severity}</Badge></td>
                    <td><code>{finding.code}</code><small>{finding.title}</small></td>
                    <td>{finding.object}</td>
                    <td>{finding.detail}</td>
                    <td>
                      <div>{finding.suggestion}</div>
                      {finding.repair ? (
                        <details>
                          <summary><Badge tone={finding.repair.risk === 'high' ? 'danger' : finding.repair.risk === 'medium' ? 'warning' : 'neutral'}>{finding.repair.label}</Badge> <small>{finding.repair.autoFixable ? '可自动' : '需人工确认'}</small></summary>
                          <ol>{finding.repair.steps.map((step, stepIndex) => <li key={`${finding.id}-step-${stepIndex}`}>{step}</li>)}</ol>
                          {finding.repair.suggestedCommand ? <small>建议命令：<code>{finding.repair.suggestedCommand.command}</code>（需要 {finding.repair.suggestedCommand.needs.join('、')}）</small> : null}
                          {finding.repair.blockedReason ? <small>{finding.repair.blockedReason}</small> : null}
                          <div><small>验证：{finding.repair.verify}</small></div>
                          {onCreateFixTask ? <Button size="sm" variant="ghost" onClick={() => onCreateFixTask(finding)}>建修复任务</Button> : null}
                        </details>
                      ) : null}
                    </td>
                    <td>{finding.exempted ? <span title={finding.exemptionReason}><Badge tone="warning">已豁免</Badge></span> : <Badge tone="neutral">未处理</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TableFrame>
      ) : (
        <div className="inline-alert inline-alert--warning" data-testid="erc-detail-unavailable">
          <AlertTriangle size={16} />
          <span>
            <strong>本次没有逐条明细，只有聚合计数。</strong>
            {reason ? <>运行时原因：<code>{reason}</code>{ERC_DETAIL_REASON_LABELS[reason] ? `（${ERC_DETAIL_REASON_LABELS[reason]}）` : ''}。</> : null}
            {' '}聚合计数只能说明“有几条问题”，不能当逐条修复依据，这里也不会把聚合计数伪装成逐条条目。
            请到嘉立创 EDA 里<strong>手动点一次“设计检查 / ERC”</strong>，让检查面板跑出结果后回到本页点“运行 ERC 取证”重试。
          </span>
        </div>
      )}
      {aggregates.length ? (
        <TableFrame label="ERC 聚合计数（仅计数，不是逐条明细）">
          <table className="table">
            <thead><tr><th>级别</th><th>聚合计数</th><th>说明</th></tr></thead>
            <tbody>
              {aggregates.map((finding) => (
                <tr key={finding.id}><td><Badge tone={ercFindingTone(finding.severity)}>{finding.severity}</Badge></td><td>×{finding.count}</td><td>{finding.detail}</td></tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      ) : null}
    </div>
  );
}

export function ValidationPage() {
  const { state, dispatch, notify, addAudit, reportIssue, reportFailure, navigate } = useApp();
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<ValidationCheck | null>(null);
  const [waive, setWaive] = useState<{ check: ValidationCheck; finding: Finding } | null>(null);
  const [waiverReason, setWaiverReason] = useState('');
  const [engineeringRunning, setEngineeringRunning] = useState<string | null>(null);
  const [engineeringResult, setEngineeringResult] = useState<EngineeringAnalysis | null>(null);
  // 下单前闸门：真实本机Runtime取证（原理图/仿真/DRC/布局/产物/供应链），不是 Demo。
  const [gate, setGate] = useState<ReleaseGateReport | null>(null);
  const [gateRunning, setGateRunning] = useState(false);
  const [gatePcb, setGatePcb] = useState('');
  const [gatePage, setGatePage] = useState('');
  // 不再预填任何"演示板"路径：证据必须来自本工程/本次取证，否则用户会把旧板结论当成本板结论。
  const [gateDir, setGateDir] = useState('');
  const [gateDrcPath, setGateDrcPath] = useState('');
  // A1：把已确认需求变成机器可校验约束；设计事实由用户/读回填写，空着就按 unknown 阻断（不猜）。
  const [designFactsDraft, setDesignFactsDraft] = useState<DesignFactsDraft>(EMPTY_DESIGN_FACTS);
  // DRC 一键取证（A12）：启动→轮询→落盘→自动填进闸门。
  const [drcRunning, setDrcRunning] = useState(false);
  const [drcJob, setDrcJob] = useState<{ jobId: string; state: string } | null>(null);
  // D8：统一长任务状态（轮询/取消/超时/重试由 createLongTask 管，页面只负责展示与结果处理）。
  const [drcTask, setDrcTask] = useState<LongTaskSnapshot<Awaited<ReturnType<typeof runtimeClient.pcbDrcReport>>> | null>(null);
  const drcTaskRef = useRef<{ cancelTask: () => Promise<unknown> } | null>(null);
  const [drcLatest, setDrcLatest] = useState<DrcEvidenceEntry | null>(null);
  const [drcResult, setDrcResult] = useState<{ report?: DrcReport; classification?: Record<string, unknown>; saved?: { path: string; digest: string; savedAt: string }; template?: unknown } | null>(null);
  const [drcError, setDrcError] = useState<string | null>(null);
  // 人工放行证据：在线 DFM 只能人工回填；终审签核必须绑定物料清单哈希，二者都落盘成文件。
  const [dfmEvidence, setDfmEvidence] = useState<DfmEvidenceEntry | null>(null);
  const [signoffEvidence, setSignoffEvidence] = useState<SignoffEvidenceEntry | null>(null);
  const [manualBusy, setManualBusy] = useState<'dfm' | 'signoff' | 'order' | null>(null);
  const [dfmPassed, setDfmPassed] = useState<'pass' | 'fail'>('pass');
  const [dfmOperator, setDfmOperator] = useState('');
  const [dfmConclusion, setDfmConclusion] = useState('');
  const [dfmPlanHash, setDfmPlanHash] = useState('');
  // E3/R10：下单参数卡人工确认（只落证据；系统不代下单、不代付）。
  const [orderConfirmation, setOrderConfirmation] = useState<{ path: string; digest: string; savedAt: string; payload: OrderConfirmationPayload } | null>(null);
  const [ocOperator, setOcOperator] = useState('');
  const [ocNote, setOcNote] = useState('');
  const [ocAck, setOcAck] = useState(false);
  const [signoffManifest, setSignoffManifest] = useState('');
  const [signoffPlanHash, setSignoffPlanHash] = useState('');
  const [signoffNames, setSignoffNames] = useState<[string, string, string]>(['', '', '']);
  const [model3d, setModel3d] = useState<{ path: string; bytes: number; sha256: string; format: string; chunks: number; elements: number | null } | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  // D8：ERC 取证（120s）、3D 导出（320s）、发布归档（120s）也用统一单调用控制器。
  const [ercTask, setErcTask] = useState<LongTaskSnapshot<Awaited<ReturnType<typeof runtimeClient.ercRun>>> | null>(null);
  const ercTaskRef = useRef<SingleCallController<Awaited<ReturnType<typeof runtimeClient.ercRun>>> | null>(null);
  const [model3dTask, setModel3dTask] = useState<LongTaskSnapshot<Awaited<ReturnType<typeof runtimeClient.pcb3dExport>>['model']> | null>(null);
  const model3dTaskRef = useRef<SingleCallController<Awaited<ReturnType<typeof runtimeClient.pcb3dExport>>['model']> | null>(null);
  const [archiveTask, setArchiveTask] = useState<LongTaskSnapshot<Awaited<ReturnType<typeof runtimeClient.archiveRelease>>['release']> | null>(null);
  const archiveTaskRef = useRef<SingleCallController<Awaited<ReturnType<typeof runtimeClient.archiveRelease>>['release']> | null>(null);
  const [modelFormat, setModelFormat] = useState<'step' | 'glb'>('step');
  // 供应链证据：价格/库存只能"查询时刻"有效，必须由用户显式刷新后随闸门/导出提交；不猜价格。
  const [pricingEvidence, setPricingEvidence] = useState<SupplyPricingEvidence | null>(null);
  // 统一批准账本（计划/写板/放行共链）：只展示审计事实与链校验，不展示令牌。
  const [ledger, setLedger] = useState<ApprovalLedgerSnapshot | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [ledgerError, setLedgerError] = useState('');
  const [pricingBusy, setPricingBusy] = useState(false);
  // B9：缺料替代候选（真实关键词检索；候选等价性未验证，必须人工确认）
  const [alternatives, setAlternatives] = useState<Awaited<ReturnType<typeof runtimeClient.supplyAlternatives>> | null>(null);
  const [alternativesBusy, setAlternativesBusy] = useState(false);
  const [alternativesError, setAlternativesError] = useState('');
  // A2：选型回退检索诊断（只读）——某型号 0 命中时看清每级变形尝试与命中来源。
  const [fallbackQuery, setFallbackQuery] = useState('');
  const [fallbackResult, setFallbackResult] = useState<Awaited<ReturnType<typeof runtimeClient.probeSelectionFallback>> | null>(null);
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const [fallbackError, setFallbackError] = useState('');
  const [pricingError, setPricingError] = useState('');
  // DRC 豁免编辑器：豁免不是"通过"，是把人工接受的风险写清楚并绑定配额；服务端会拒绝缺理由/风险的条目。
  const [exemptions, setExemptions] = useState<ExemptionRow[]>([]);
  const [exemptionInfo, setExemptionInfo] = useState<{ path?: string; exists?: boolean; count?: number; invalid?: Array<{ index: number; problems: string[] }> } | null>(null);
  const [exemptionBusy, setExemptionBusy] = useState(false);
  const [exemptionDirty, setExemptionDirty] = useState(false);
  // 原理图 ERC 收敛（A13）：取证只读；豁免必须写理由；聚合式报告要明确标"没有逐条明细"。
  const [ercRunning, setErcRunning] = useState(false);
  const [ercResult, setErcResult] = useState<{ report: ErcReport; summary: ErcConvergenceSummary; saved?: { path: string; digest: string; savedAt: string }; ercDetail?: ErcDetailMeta | null } | null>(null);
  const [ercLatest, setErcLatest] = useState<ErcEvidenceEntry | null>(null);
  const [ercError, setErcError] = useState<string | null>(null);
  // 第 61 轮：桥连接状态（断线后可重新发现/重连；失败如实报错，不假装已连接）。
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatusState>(EMPTY_BRIDGE_STATUS);
  const [ercExemptions, setErcExemptions] = useState<Array<{ code: string; object: string; reason: string }>>([]);
  const [ercExemptionInfo, setErcExemptionInfo] = useState<{ path?: string; exists?: boolean; invalid?: Array<{ index: number; problems: string[] }> } | null>(null);
  // A14：SPICE 仿真证据（真实求解器产出；缺网表/求解器时显示结构化失败，绝不显示成"通过"）。
  const [simBusy, setSimBusy] = useState(false);
  const [simResult, setSimResult] = useState<Awaited<ReturnType<typeof runtimeClient.simulationRun>> | null>(null);
  const [simLatest, setSimLatest] = useState<Awaited<ReturnType<typeof runtimeClient.simulationLatest>>['evidence']>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [acceptanceBusy, setAcceptanceBusy] = useState(false);
  // A4：引脚证据（只读）。缺网络且无 assumption 的焊盘会被审计阻断，界面如实展示。
  const [pinBusy, setPinBusy] = useState(false);
  const [pinResult, setPinResult] = useState<Awaited<ReturnType<typeof runtimeClient.pinEvidence>> | null>(null);
  // A4：两阶段计划（先落板→读引脚→审计→生成网表；只出计划，不执行）。
  const [pinFlowPlan, setPinFlowPlan] = useState<Awaited<ReturnType<typeof runtimeClient.pinFirstFlowPlan>>['plan'] | null>(null);
  const [pinFlowBusy, setPinFlowBusy] = useState(false);
  const [acceptanceResult, setAcceptanceResult] = useState<Awaited<ReturnType<typeof runtimeClient.schematicAcceptance>> | null>(null);
  const [ercExemptionBusy, setErcExemptionBusy] = useState(false);
  const [gateConfirmed, setGateConfirmed] = useState(false);
  const [exporting, setExporting] = useState<'draft' | 'final' | null>(null);
  const [exportResult, setExportResult] = useState<ProductionExportResult | null>(null);
  // D8：生产导出是"一次长调用、无服务端 job 可轮询"的场景，用单调用长任务控制器统一 状态/取消/超时/重试。
  const [exportTask, setExportTask] = useState<LongTaskSnapshot<ProductionExportResult> | null>(null);
  // B8：不可变发布版本（放行 ready 后归档；无编辑/删除入口）。
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveResult, setArchiveResult] = useState<Awaited<ReturnType<typeof runtimeClient.archiveRelease>>['release'] | null>(null);
  const exportTaskRef = useRef<{ cancelTask: () => LongTaskSnapshot<ProductionExportResult> } | null>(null);
  const lastExportRequestedRef = useRef<'draft' | 'final'>('draft');
  // 自动修复原理图：预演不写盘；执行是受控写入（写完必须过网表复核 + 重跑验收）
  const [repair, setRepair] = useState<SchematicRepairReport | null>(null);
  const [repairRunning, setRepairRunning] = useState<'dry' | 'apply' | null>(null);
  // D8：原理图验收（300s）、原理图修复（240s）、放行门禁（180s）都是长调用。
  const [acceptanceSnapshot, setAcceptanceSnapshot] = useState<LongTaskSnapshot<Awaited<ReturnType<typeof runtimeClient.schematicAcceptance>>> | null>(null);
  const acceptanceTaskRef = useRef<{ cancelTask: () => unknown } | null>(null);
  const [repairSnapshot, setRepairSnapshot] = useState<LongTaskSnapshot<SchematicRepairReport> | null>(null);
  const repairTaskRef = useRef<{ cancelTask: () => unknown } | null>(null);
  const [gateSnapshot, setGateSnapshot] = useState<LongTaskSnapshot<Awaited<ReturnType<typeof runtimeClient.releaseGate>>> | null>(null);
  const gateTaskRef = useRef<{ cancelTask: () => unknown } | null>(null);
  const [syncVerify, setSyncVerify] = useState<PcbSyncVerification | null>(null);
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [orderCard, setOrderCard] = useState<FabricationOrderCard | null>(null);
  const [orderRunning, setOrderRunning] = useState(false);
  const [orderLayers, setOrderLayers] = useState('');
  const [orderQuantity, setOrderQuantity] = useState('5');
  const [orderImpedance, setOrderImpedance] = useState(false);
  const [orderFinish, setOrderFinish] = useState('HASL-LF');
  const totalOpen = useMemo(() => state.validations.reduce((sum, item) => sum + item.findings.filter((finding) => finding.status === 'open').length, 0), [state.validations]);
  const passCount = state.validations.filter((item) => item.status === 'pass').length;
  const coverage = Math.round((state.validations.filter((item) => item.status !== 'idle').length / state.validations.length) * 100);

  const runAll = async () => {
    setRunning(true);
    try {
      const result = await demoAdapter.runValidations(state.validations, (validations) => dispatch({ type: 'SET_VALIDATIONS', validations }));
      // 每条结果显式打来源：Demo 的 pass 不能冒充真实检查（假通过红线）。
      dispatch({ type: 'SET_VALIDATIONS', validations: result.map((item) => ({ ...item, source: 'demo' as const })) });
      addAudit('validation', '完成全量验证', `${result.length}项检查 · Demo`, result.some((item) => item.status === 'fail') ? 'error' : result.some((item) => item.status === 'warn') ? 'warning' : 'success');
      notify('验证已完成', '结果来自模拟适配器，不代表真实嘉立创EDA检查结果。', 'success');
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      reportIssue({ fingerprint: 'validation:DEMO_RUN_ALL', source: 'validation', severity: 'error', status: 'open', code: 'VALIDATION_RUN_FAILED', summary: '全量工程验证运行失败', detail, suggestedAction: '确认本机Runtime可用后重试“运行全部检查”；页面不会因此锁死。' });
      addAudit('validation', '全量验证失败', detail, 'error');
      notify('验证失败', `${detail}；页面已恢复可用，可重新运行全部检查。`, 'danger');
    } finally { setRunning(false); }
  };
  const runOne = async (check: ValidationCheck) => {
    const start = { ...check, status: 'running' as const };
    dispatch({ type: 'UPDATE_VALIDATION', validation: start }); setSelected(start);
    try {
      const result = await demoAdapter.runValidations([check], () => undefined);
      const withSource = { ...result[0], source: 'demo' as const };
      dispatch({ type: 'UPDATE_VALIDATION', validation: withSource }); setSelected(withSource); addAudit('validation', `运行${check.name}`, `${check.description} · Demo`, 'info'); notify(`${check.name} 已完成`, `状态：${checkLabel(result[0].status)}（Demo）`, result[0].status === 'pass' ? 'success' : 'warning');
    } catch (error) {
      const restored: ValidationCheck = { ...check, status: check.status === 'running' ? 'idle' : check.status };
      dispatch({ type: 'UPDATE_VALIDATION', validation: restored }); setSelected(restored);
      const detail = error instanceof Error ? error.message : '未知错误';
      reportIssue({ fingerprint: `validation:DEMO_RUN_ONE:${check.id}`, source: 'validation', severity: 'error', status: 'open', code: 'VALIDATION_RUN_FAILED', summary: `${check.name}验证检查运行失败`, detail, context: { checkId: check.id }, suggestedAction: '确认本机Runtime可用后重新运行该检查；检查状态已恢复为可重试。' });
      addAudit('validation', `运行${check.name}失败`, detail, 'error');
      notify(`${check.name} 运行失败`, `${detail}；状态已恢复为${checkLabel(restored.status)}，可重新运行。`, 'danger');
    }
  };
  const locate = (finding: Finding) => { navigate('eda'); notify('已发送定位请求', `Demo 将定位到 ${finding.object}；真实定位需要Bridge连接。`, 'info'); addAudit('validation', '定位验证问题', `${finding.object} · ${finding.rule}`, 'info'); };
  const createFix = (finding: Finding) => {
    dispatch({ type: 'PATCH_TASK', patch: { goal: `修复验证问题：${finding.title}（对象 ${finding.object}，规则 ${finding.rule}）。建议：${finding.suggestion}`, status: 'draft', steps: [], progress: 0, planHash: `fix-${Date.now().toString(36)}` } }); navigate('ai'); notify('已创建修复任务草稿', '请审阅任务目标并生成计划。', 'success'); addAudit('ai', '从验证问题创建任务', finding.title, 'info');
  };
  /**
   * 载入最近一次落盘的 DRC 取证。找到就把路径自动填进放行闸门——
   * 这样"取证"和"闸门吃证据"是同一条链，不再靠人手抄路径。
   */
  const loadLatestDrc = async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      const evidence = await runtimeClient.latestPcbDrc();
      if (!evidence) {
        if (!silent) notify('没有已落盘的 DRC 取证', '先在真机运行一次 DRC，或确认证据目录/PCBUUID 是否正确。', 'warning');
        return null;
      }
      setDrcLatest(evidence);
      setGateDrcPath(evidence.path);
      if (!silent) notify('已载入最新 DRC 取证', `${evidence.payload?.report?.items?.length ?? 0} 条条目 · ${evidence.digest.slice(0, 12)}`, 'success');
      if (!silent) addAudit('validation', '载入 DRC 取证', `${evidence.path} · ${evidence.digest.slice(0, 12)}`, 'info');
      return evidence;
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      if (!silent) { setDrcError(detail); notify('载入 DRC 取证失败', detail, 'danger'); }
      return null;
    }
  };

  /**
   * 真机 DRC：start 受理 → 轮询 report → done 才落盘。
   * 这是渲染进程长任务，不能塞进一个同步请求里等；轮询期间允许取消。
   */
  const runPcbDrc = async () => {
    setDrcRunning(true);
    setDrcError(null);
    setDrcResult(null);
    setDrcTask(null);
    const task = createLongTask<Awaited<ReturnType<typeof runtimeClient.startPcbDrc>>, Awaited<ReturnType<typeof runtimeClient.pcbDrcReport>>>({
      start: async () => {
        const started = await runtimeClient.startPcbDrc();
        setDrcJob({ jobId: started.jobId, state: started.state });
        return started;
      },
      poll: async (started) => {
        const polled = await runtimeClient.pcbDrcReport(started.jobId, gatePcb.trim() || undefined);
        setDrcJob({ jobId: started.jobId, state: polled.state });
        const status = polled.state === 'done' ? 'done' as const
          : polled.state === 'failed' ? 'failed' as const
            : polled.state === 'cancelled' ? 'cancelled' as const
              : 'running' as const;
        return { status, result: polled };
      },
      cancel: async (started) => { await runtimeClient.pcbDrcCancel(started.jobId); },
      pollIntervalMs: 2_000,
      timeoutMs: 180_000,
      onUpdate: (snapshot) => setDrcTask(snapshot),
    });
    drcTaskRef.current = task;
    try {
      const snapshot = await task.startTask();
      setDrcTask(snapshot);
      if (snapshot.status !== 'done' || !snapshot.result) {
        const reason = snapshot.status === 'cancelled' ? 'DRC 已停止等待（服务端任务状态以审计为准）'
          : snapshot.status === 'failed' ? `DRC 执行失败：${snapshot.error ?? '未知原因'}`
            : snapshot.status === 'timeout' ? 'DRC 超时：本页停止轮询，后台任务可能仍在执行'
              : 'DRC 未完成';
        setDrcError(reason);
        addAudit('validation', 'PCB DRC 未完成', `${reason} · job ${drcJob?.jobId ?? 'unknown'}`, 'error');
        notify('PCB DRC 未完成', reason, 'danger');
        return;
      }
      const last = snapshot.result;
      setDrcResult(last);
      if (last.saved?.path) setGateDrcPath(last.saved.path);
      const itemCount = last.report?.items?.length ?? 0;
      addAudit('validation', 'PCB DRC 取证完成', `${itemCount} 条 · ${last.saved?.digest?.slice(0, 12) || '未落盘'}`, 'info');
      notify('PCB DRC 取证完成', `${itemCount} 条条目${last.saved?.path ? '，报告已落盘并自动填入闸门' : ''}`, 'success');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      setDrcError(detail);
      addAudit('validation', 'PCB DRC 启动失败', detail, 'error');
      notify('PCB DRC 启动失败', detail, 'danger');
    } finally {
      setDrcRunning(false);
      drcTaskRef.current = null;
    }
  };

  const cancelPcbDrc = async () => {
    try {
      await drcTaskRef.current?.cancelTask();
      notify('已请求取消 DRC', '运行时已标记取消；EDA 侧已在跑的任务会如实回报状态。', 'warning');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : '未知错误';
      notify('取消 DRC 失败', detail, 'danger');
    }
  };

  const export3d = async () => {
    setModel3d(null);
    const task = createSingleCallTask<Awaited<ReturnType<typeof runtimeClient.pcb3dExport>>['model']>({
      timeoutMs: 340_000,
      onUpdate: setModel3dTask,
      call: async (signal) => {
        const result = await runtimeClient.pcb3dExport({ pcbUuid: gatePcb.trim() || undefined, format: modelFormat }, { signal });
        setModel3d(result.model);
        addAudit('version', '导出3D模型', `${result.model.format.toUpperCase()} · ${result.model.bytes} bytes · ${result.model.sha256.slice(0, 12)}`, 'success');
        notify('3D 模型已导出', `${result.model.path}`, 'success');
        return result.model;
      },
    });
    model3dTaskRef.current = task;
    const settled = await task.startTask();
    if (settled.status === 'failed') notify('3D 模型导出失败', `${settled.error || '未知错误'}（GLB 依赖 EDA 官方 API；不可得时请用 STEP）`, 'danger');
    else if (settled.status !== 'done') notify('已停止等待 3D 导出', settled.note || '本页已停止等待；服务端可能仍在导出，产物目录为准。', 'warning');
  };

  const loadExemptions = async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      const result = await runtimeClient.pcbDrcExemptions();
      setExemptions(Array.isArray(result.exemptions) ? (result.exemptions as ExemptionRow[]) : []);
      setExemptionInfo({ path: result.path, exists: result.exists, count: result.count, invalid: result.invalid as Array<{ index: number; problems: string[] }> | undefined });
      setExemptionDirty(false);
      if (!silent) notify('已载入 DRC 豁免清单', `${result.count ?? 0} 条 · ${result.path || '未配置路径'}`, 'info');
    } catch (error) {
      if (!silent) {
        const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : '未知错误';
        notify('载入豁免清单失败', detail, 'danger');
      }
    }
  };

  /** 用本次 DRC 报告的模板生成草稿：已有 maxCount/errorType，用户只需补理由与风险。 */
  const seedExemptionsFromReport = () => {
    const template = drcResult?.template;
    const rows = Array.isArray(template) ? (template as ExemptionRow[]) : [];
    if (!rows.length) {
      const source = drcResult?.report?.items ?? drcLatest?.payload?.report?.items ?? [];
      if (!source.length) return notify('没有可生成豁免的报告', '先运行一次 PCB DRC 取证，再按报告生成豁免草稿。', 'warning');
      notify('报告里没有豁免模板', '本次报告未返回模板；可手动新增一条 kind 级豁免并填写 errorType/maxCount。', 'warning');
      return;
    }
    setExemptions(rows.map((row) => ({ ...row, reason: row.reason || '', risk: row.risk || '', approvedBy: row.approvedBy || '' })));
    setExemptionDirty(true);
    notify('已按本次报告生成豁免草稿', `${rows.length} 组签名；逐条补理由与残留风险后才能保存。`, 'info');
  };

  const patchExemption = (index: number, patch: Partial<ExemptionRow>) => {
    setExemptions((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
    setExemptionDirty(true);
  };

  const removeExemption = (index: number) => {
    setExemptions((current) => current.filter((_, rowIndex) => rowIndex !== index));
    setExemptionDirty(true);
  };

  const saveExemptions = async () => {
    const invalid = exemptions.map((row, index) => ({ index, problems: exemptionProblems(row) })).filter((item) => item.problems.length);
    if (invalid.length) return notify('豁免清单还不完整', invalid.map((item) => `#${item.index} ${item.problems.join('；')}`).join(' | ').slice(0, 300), 'warning');
    setExemptionBusy(true);
    try {
      const result = await runtimeClient.savePcbDrcExemptions(exemptions as unknown as Array<Record<string, unknown>>);
      addAudit('validation', '保存DRC豁免清单', `${result.count ?? exemptions.length} 条 · ${result.path || ''}`, 'warning');
      notify('豁免清单已保存', `${result.count ?? exemptions.length} 条，已写入 ${result.path || '豁免文件'}；下次放行闸门会按配额/理由/风险校验。`, 'success');
      await loadExemptions({ silent: true });
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      notify('保存豁免清单失败', detail, 'danger');
    } finally { setExemptionBusy(false); }
  };

  /** 第 61 轮：重新发现桥并读取窗口列表；失败把运行时错误码原样展示（不吞掉、不假装连接成功）。 */
  const refreshBridgeStatus = async ({ silent = false }: { silent?: boolean } = {}) => {
    setBridgeStatus((current) => ({ ...current, busy: true, error: null }));
    let port: number | null = null;
    try {
      const discovered = await runtimeClient.discoverBridge();
      port = discovered?.port ?? null;
      const data = await runtimeClient.windows();
      setBridgeStatus({ busy: false, checkedAt: new Date().toISOString(), port, windows: data.windows, selectedWindowId: data.selectedWindowId, selectionRequired: data.selectionRequired, error: null });
      if (!silent) {
        notify(
          '桥连接状态已刷新',
          data.windows.length
            ? `发现 ${data.windows.length} 个 EDA 窗口${data.selectionRequired ? '（多个窗口需选择目标）' : ''}${port ? ` · 桥端口 ${port}` : ''}`
            : '桥可达，但当前没有 EDA 窗口：请先打开嘉立创 EDA 再重试。',
          data.windows.length ? 'success' : 'warning',
        );
      }
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      setBridgeStatus({ busy: false, checkedAt: new Date().toISOString(), port, windows: [], selectedWindowId: null, selectionRequired: false, error: detail });
      if (!silent) notify('重新连接 EDA 桥失败', detail, 'danger');
    }
  };

  const runErc = async () => {
    setErcError(null);
    const task = createSingleCallTask<Awaited<ReturnType<typeof runtimeClient.ercRun>>>({
      timeoutMs: 140_000,
      onUpdate: setErcTask,
      call: async (signal) => {
        const result = await runtimeClient.ercRun({ signal });
        setErcResult({ report: result.erc, summary: result.summary, saved: result.saved, ercDetail: result.ercDetail ?? null });
        setErcLatest(null);
        const summary = result.summary;
        const detailLabel = result.erc?.detailSource === 'ui-dom' ? '（逐条明细 ui-dom）' : summary.aggregateOnly ? '（仅聚合计数）' : '（含明细）';
        addAudit('validation', '原理图 ERC 取证', `${summary.errorsOpen} 错误 / ${summary.warningsOpen} 警告 ${detailLabel}`, summary.errorsOpen ? 'warning' : 'info');
        notify('ERC 取证完成', summary.aggregateOnly ? 'EDA 只返回聚合计数：不能当逐条修复依据。' : `错误 ${summary.errorsOpen} · 警告 ${summary.warningsOpen}${result.saved ? ` · 已落盘 ${result.saved.digest.slice(0, 12)}` : ''}`, summary.errorsOpen ? 'warning' : 'success');
        return result;
      },
    });
    ercTaskRef.current = task;
    const settled = await task.startTask();
    if (settled.status === 'failed') { setErcError(settled.error || 'ERC 取证失败'); notify('ERC 取证失败', settled.error || '未知错误', 'danger'); }
    else if (settled.status !== 'done') notify('已停止等待 ERC 取证', settled.note || '本页已停止等待；服务端可能仍在运行 ERC，证据目录为准。', 'warning');
  };

  const loadLatestErc = async () => {
    try {
      const latest = await runtimeClient.ercLatest();
      setErcLatest(latest.evidence);
      notify(latest.evidence ? '已载入最新 ERC 证据' : '还没有 ERC 证据', latest.evidence ? `${latest.evidence.digest.slice(0, 12)} · ${latest.evidence.path}` : '先运行一次 ERC 取证。', latest.evidence ? 'success' : 'warning');
    } catch (error) {
      notify('载入 ERC 证据失败', error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : '未知错误', 'danger');
    }
  };

  const loadErcExemptions = async ({ silent = false }: { silent?: boolean } = {}) => {
    setErcExemptionBusy(true);
    try {
      const result = await runtimeClient.ercExemptions();
      setErcExemptions((result.exemptions || []).map((entry) => ({ code: entry.code, object: entry.object || '', reason: entry.reason || '' })));
      setErcExemptionInfo({ path: result.path, exists: result.exists, invalid: result.invalid });
      if (!silent) notify('已载入 ERC 豁免', `${result.exemptions?.length ?? 0} 条 · ${result.path || '未配置路径'}`, 'info');
    } catch (error) {
      notify('载入 ERC 豁免失败', error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : '未知错误', 'danger');
    } finally { setErcExemptionBusy(false); }
  };

  const saveErcExemptions = async () => {
    const invalidRows = ercExemptions.map((row, index) => ({ index, problems: [row.code.trim() ? '' : '缺 code', row.reason.trim() ? '' : '缺理由'].filter(Boolean) })).filter((item) => item.problems.length);
    if (invalidRows.length) return notify('ERC 豁免还不完整', invalidRows.map((item) => `#${item.index} ${item.problems.join('；')}`).join(' | ').slice(0, 300), 'warning');
    setErcExemptionBusy(true);
    try {
      const result = await runtimeClient.saveErcExemptions(ercExemptions.map((row) => ({ code: row.code.trim(), object: row.object.trim() || null, reason: row.reason.trim() })));
      addAudit('validation', '保存ERC豁免', `${result.saved.count} 条 · ${result.saved.path}`, 'warning');
      notify('ERC 豁免已保存', `${result.saved.count} 条，已写入 ${result.saved.path}；下次 ERC 取证会按 code/对象匹配。`, 'success');
      await loadErcExemptions({ silent: true });
    } catch (error) {
      notify('保存 ERC 豁免失败', error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : '未知错误', 'danger');
    } finally { setErcExemptionBusy(false); }
  };

  // A13：ERC 逐条结构化建议 → 只读修复任务草稿（电气意图仍需人确认，写图必须重新计划/批准）。
  const createErcFixTask = (finding: ErcFinding) => {
    const repair = finding.repair;
    const task = buildFixTaskFromFailure({
      code: finding.code,
      summary: `${finding.title}（对象 ${finding.object}）`,
      detail: finding.detail,
      suggestedAction: repair ? `${repair.label}：${repair.steps.join(' → ')}；验证：${repair.verify}` : finding.suggestion,
      source: 'validation',
      evidence: [`erc:${finding.id}`, `erc-digest:${ercResult?.report?.digest ?? ercLatest?.digest ?? 'unknown'}`],
    });
    dispatch({ type: 'SET_TASK', task });
    addAudit('validation', '从 ERC 建议创建修复任务', `${finding.code} → ${task.id}`, 'info');
    notify('已创建 ERC 修复任务草稿', 'AI 任务页已载入只读目标；修复电气连接必须重新生成计划并人工批准。', 'success');
    navigate('ai');
  };

  const seedErcExemptionTemplate = () => {
    const report = ercResult?.report || ercLatest?.payload?.report;
    if (!report) return notify('没有可用的 ERC 报告', '先运行 ERC 取证或载入最新证据。', 'warning');
    const seen = new Set<string>();
    const rows: Array<{ code: string; object: string; reason: string }> = [];
    for (const finding of report.findings) {
      if (seen.has(finding.code)) continue;
      seen.add(finding.code);
      rows.push({ code: finding.code, object: finding.object === 'unknown' ? '' : finding.object, reason: '' });
    }
    setErcExemptions(rows);
    notify('已生成豁免草稿', `${rows.length} 条；理由必须手工写清，空理由会被服务端拒绝。`, 'info');
  };

  const runSimulation = async () => {
    setSimBusy(true); setSimError(null);
    try {
      const result = await runtimeClient.simulationRun({});
      setSimResult(result);
      setSimLatest(null);
      const hash = result.evidence?.evidenceHash?.slice(0, 12) ?? '—';
      addAudit('validation', 'SPICE 仿真取证', `真实求解器产出 · 证据 ${hash}`, result.ok ? 'success' : 'warning');
      notify(result.ok ? '仿真证据已产出' : '仿真跑完但有阻断项', result.ok ? `证据 ${hash}${result.saved ? ` · 已落盘 ${result.saved.digest.slice(0, 12)}` : ''}` : `存在 ${result.findings.filter((item) => (item as { severity?: string }).severity === 'blocking').length} 条阻断发现，见下方。`, result.ok ? 'success' : 'warning');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      setSimError(detail);
      notify('仿真取证失败', detail, 'danger');
    } finally { setSimBusy(false); }
  };

  const loadLatestSimulation = async () => {
    try {
      const latest = await runtimeClient.simulationLatest();
      setSimLatest(latest.evidence);
      notify(latest.evidence ? '已载入最新仿真证据' : '还没有仿真证据', latest.evidence ? `${latest.evidence.digest.slice(0, 12)} · ${latest.evidence.path}` : '先运行一次仿真取证（需要本机 SPICE 求解器 + 可导出的仿真网表）。', latest.evidence ? 'success' : 'warning');
    } catch (error) {
      notify('载入仿真证据失败', error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : '未知错误', 'danger');
    }
  };

  const runPinEvidence = async () => {
    setPinBusy(true);
    try {
      const result = await runtimeClient.pinEvidence({ includeSchematic: true });
      setPinResult(result);
      addAudit('validation', '采集引脚证据', `${result.audit.counts.components} 器件 / ${result.audit.counts.pins} 焊盘 · 未知网络 ${result.audit.counts.unknown} · 审计${result.audit.ok ? '通过' : '未通过'}`, result.audit.ok ? 'success' : 'warning');
      notify(result.audit.ok ? '引脚证据已采集' : '引脚证据有阻断', result.audit.ok ? `网络覆盖 ${result.audit.counts.withNet}/${result.audit.counts.pins}；只读，未改板。` : result.audit.blockers.map((item) => item.message).join('；').slice(0, 300), result.audit.ok ? 'success' : 'warning');
    } catch (error) {
      notify('引脚证据采集失败', error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : '未知错误', 'danger');
    } finally { setPinBusy(false); }
  };

  const runPinFirstFlow = async () => {
    setPinFlowBusy(true);
    try {
      const plan = (await runtimeClient.pinFirstFlowPlan({ pinEvidence: pinResult?.evidence ?? null, pinAudit: pinResult?.audit ?? null, assumptions: [] })).plan;
      setPinFlowPlan(plan);
      addAudit('validation', 'A4 两阶段计划', `executable=${plan.executable} · 阶段 ${plan.stages.length} · 阻断 ${plan.blockers.length}`, plan.executable ? 'info' : 'warning');
      notify(plan.executable ? '两阶段计划可执行' : '两阶段计划被阻断', plan.executable ? '阶段：先落板（需写板批准）→ 采引脚证据 → 审计 → 生成网表。本页只出计划，不自动执行。' : plan.blockers.map((item) => item.message).join('；').slice(0, 320), plan.executable ? 'info' : 'warning');
    } catch (error) {
      notify('两阶段计划生成失败', error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : '未知错误', 'danger');
    } finally { setPinFlowBusy(false); }
  };

  const runAcceptance = async () => {
    setAcceptanceBusy(true);
    setAcceptanceSnapshot(null);
    const task = createSingleCallTask({
      call: (signal) => runtimeClient.schematicAcceptance({}, { signal }),
      timeoutMs: 300_000,
      onUpdate: setAcceptanceSnapshot,
    });
    acceptanceTaskRef.current = task;
    const snapshot = await task.startTask();
    setAcceptanceBusy(false);
    if (snapshot.status !== 'done' || !snapshot.result) {
      notify(snapshot.status === 'failed' ? '原理图验收失败' : '已停止等待原理图验收', snapshot.status === 'failed' ? (snapshot.error || '未知错误') : (snapshot.note || '本页已停止等待；服务端验收可能仍在执行，稍后看审计/产物目录。'), snapshot.status === 'failed' ? 'danger' : 'warning');
      return;
    }
    {
      const result = snapshot.result;
      setAcceptanceResult(result);
      const checks = result.acceptance?.designChecks?.summary;
      addAudit('validation', '原理图验收（含仿真/设计检查点）', `ready=${result.acceptance?.ready} · 仿真 ${checks?.simulated ? '已跑' : '未跑'} · 证据 ${result.savedSimulation?.digest.slice(0, 12) ?? '未落盘'}`, result.acceptance?.ready ? 'success' : 'warning');
      notify(result.acceptance?.ready ? '原理图验收完成' : '原理图验收未通过', checks?.simulated ? `设计检查点 ${checks.passed}/${checks.total} 通过；仿真证据已落盘。` : '本次没有可执行的仿真（不会当成"仿真通过"）。', result.acceptance?.ready ? 'success' : 'warning');
    }
  };

  const loadManualEvidence = async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      const [dfm, signoff, confirmation] = await Promise.all([runtimeClient.latestDfmEvidence(), runtimeClient.latestSignoff(), runtimeClient.latestOrderConfirmation()]);
      setDfmEvidence(dfm);
      setSignoffEvidence(signoff);
      setOrderConfirmation(confirmation);
      if (!silent) notify('已刷新人工证据', `DFM ${dfm ? dfm.digest.slice(0, 12) : '无'} · 签核 ${signoff ? signoff.digest.slice(0, 12) : '无'}`, 'info');
    } catch (error) {
      if (!silent) {
        const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : '未知错误';
        notify('刷新人工证据失败', detail, 'danger');
      }
    }
  };

  const submitDfm = async () => {
    if (!dfmOperator.trim()) return notify('缺少操作人', '在线 DFM 是人工行为，必须留下操作人。', 'warning');
    setManualBusy('dfm');
    try {
      const entry = await runtimeClient.saveDfmEvidence({
        passed: dfmPassed === 'pass',
        operator: dfmOperator.trim(),
        conclusion: dfmConclusion.trim() || (dfmPassed === 'pass' ? '在线 DFM 无阻断' : '在线 DFM 存在阻断问题'),
        source: '嘉立创在线DFM',
        planHash: dfmPlanHash.trim() || undefined,
        pcbUuid: gatePcb.trim() || undefined,
      });
      setDfmEvidence(entry);
      addAudit('validation', '登记在线DFM证据', `${dfmPassed === 'pass' ? '通过' : '不通过'} · ${entry.digest.slice(0, 12)}`, dfmPassed === 'pass' ? 'success' : 'warning');
      notify('DFM 证据已落盘', `${entry.digest.slice(0, 12)} · 重新运行闸门后，统一裁决会把这份证据算进去。`, 'success');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      notify('DFM 证据保存失败', detail, 'danger');
    } finally { setManualBusy(null); }
  };

  const submitOrderConfirmation = async () => {
    if (!orderCard) return notify('还没有下单参数卡', '先生成参数卡并核对到无阻断，再记录人工确认。', 'warning');
    if (orderCard.readyToOrder !== true) return notify('参数卡还不可下单', `当前 ${orderCard.counts.blocking} 条阻断 / ${orderCard.counts.unknown} 条未确认；先修参数卡。`, 'warning');
    if (!ocOperator.trim()) return notify('缺少确认人', '下单确认是人工行为，必须留确认人。', 'warning');
    if (!ocAck) return notify('缺少人工声明', '必须勾选"下单/支付由本人完成、系统不代下单不代付"。', 'warning');
    setManualBusy('order');
    try {
      const entry = await runtimeClient.saveOrderConfirmation({ card: orderCard, operator: ocOperator.trim(), note: ocNote.trim(), paymentManual: true });
      setOrderConfirmation(entry);
      addAudit('version', '记录下单参数卡人工确认', `操作人 ${entry.payload.operator} · 证据 ${entry.digest.slice(0, 12)}`, 'warning');
      notify('人工确认已留痕', `证据 ${entry.digest.slice(0, 12)} 已落盘；本系统仍不会下单、不会支付——请到板厂页面由本人完成下单与付款。`, 'success');
      setOcAck(false);
    } catch (error) {
      notify('记录下单确认失败', error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : '未知错误', 'danger');
    } finally {
      setManualBusy(null);
    }
  };

  const submitSignoff = async () => {
    const names = signoffNames.map((name) => name.trim());
    if (!signoffManifest.trim()) return notify('缺少物料清单哈希', '签核必须绑定确定的物料版本，否则无法防止被复用到别的批次。', 'warning');
    if (names.some((name) => !name)) return notify('三方签核未填全', '硬件设计 / 制造工艺 / 项目负责人 三方姓名都必须填写。', 'warning');
    setManualBusy('signoff');
    try {
      const entry = await runtimeClient.recordSignoff({
        passed: true,
        roles: names.map((name, index) => ({ role: ['硬件设计', '制造工艺', '项目负责人'][index], name, conclusion: '通过' })),
        manifestHash: signoffManifest.trim(),
        planHash: signoffPlanHash.trim() || undefined,
        pcbUuid: gatePcb.trim() || undefined,
        operator: names[0],
        conclusion: '人工终审通过',
      });
      setSignoffEvidence(entry);
      addAudit('validation', '登记人工终审签核', `manifest ${entry.payload.manifestHash.slice(0, 12)} · ${entry.digest.slice(0, 12)}`, 'success');
      notify('终审签核已落盘', '重新运行闸门后，统一裁决会把三方签核算进去；下单/支付仍永久禁用。', 'success');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      notify('终审签核保存失败', detail, 'danger');
    } finally { setManualBusy(null); }
  };

  useEffect(() => {
    if (state.runtime.mode === 'demo') return;
    void loadLatestDrc({ silent: true });
    void loadManualEvidence({ silent: true });
    void loadExemptions({ silent: true });
    // 第 61 轮：进入页面即探测一次桥连接状态（失败静默，避免启动时刷屏；用户可手动重连）。
    void refreshBridgeStatus({ silent: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runtime.mode]);

  const confirmWaiver = () => {
    if (!waive || !waiverReason.trim()) return;
    const updated: ValidationCheck = { ...waive.check, findings: waive.check.findings.map((item) => item.id === waive.finding.id ? { ...item, status: 'waived', waiverReason: waiverReason.trim() } : item), count: Math.max(0, waive.check.count - 1) };
    updated.status = updated.findings.some((item) => item.status === 'open') ? 'warn' : 'pass';
    dispatch({ type: 'UPDATE_VALIDATION', validation: updated }); setSelected(updated); addAudit('validation', '人工豁免验证问题', `${waive.finding.rule} · ${waiverReason}`, 'warning'); notify('豁免已记录', '原因已写入审计，问题没有被删除。', 'warning'); setWaive(null); setWaiverReason('');
  };
  const runEngineering = async (fixtureId: string) => {
    setEngineeringRunning(fixtureId);
    try {
      const result = await runtimeClient.analyzeEngineering({ fixtureId });
      setEngineeringResult(result);
      addAudit('validation', `运行${fixtureId}三阶段工程分析`, `${result.findings.length}项门禁 · ${result.reportHash.slice(0,12)}`, result.passed ? 'success' : 'warning');
      notify('真实工程分析已完成', result.passed ? '解析门禁通过，仍须官方DRC、在线DFM和人工审批。' : `发现 ${result.findings.length} 项阻断或警告。`, result.passed ? 'success' : 'warning');
    } catch (error) {
      const detail=error instanceof RuntimeApiError ? `${error.code} · ${error.message}` : '未知Runtime错误';
      notify('工程分析失败', detail, 'danger'); addAudit('validation', `运行${fixtureId}失败`, detail, 'error');
    } finally { setEngineeringRunning(null); }
  };

  /**
   * 导出生产文件。**草稿可以导，正式必须门禁过**——这条判断在运行时，界面不重复判断，
   * 只负责把"能不能"如实告诉用户，并显示落盘文件与复核结论。
   */
  const lcscIdsFromBom = () => Array.from(new Set(state.components.map((item) => String(item.lcscId || '').trim().toUpperCase()).filter((id) => /^C\d{4,}$/.test(id))));

  const refreshPricing = async () => {
    const lcscIds = lcscIdsFromBom();
    if (!lcscIds.length) return notify('没有可查询的 LCSC 料号', 'BOM 里没有 C 编号料号：先完成选型/绑定料号，再刷新价格库存。', 'warning');
    setPricingBusy(true);
    setPricingError('');
    try {
      const pricing = await runtimeClient.supplyPricing({ lcscIds });
      setPricingEvidence(pricing);
      addAudit('validation', '刷新在线价格/库存', `${pricing.summary.priced}/${pricing.summary.requested} 有价格证据 · ${pricing.checkedAt || '无时间戳'}`, pricing.summary.unknown ? 'warning' : 'success');
      notify(pricing.summary.unknown ? '价格证据不完整' : '价格/库存证据已刷新', `已定价 ${pricing.summary.priced} 颗，未知 ${pricing.summary.unknown} 颗（unknown=没有证据，不是 0 元）；查询时间 ${pricing.checkedAt || '未知'}。`, pricing.summary.unknown ? 'warning' : 'success');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      setPricingError(detail);
      notify('价格/库存查询失败', detail, 'danger');
    } finally { setPricingBusy(false); }
  };

  /** B9：对缺料/库存未知的料号查真实替代候选。候选不是等价替代：界面必须展示 unverified。 */
  const probeFallback = async () => {
    const queries = fallbackQuery.split(/[、,，\n]+/).map((item) => item.trim()).filter(Boolean);
    if (!queries.length) return notify('请填写要检索的型号/关键词', '会按“原始→去括号→去品牌→首段→去斜杠后缀”逐级尝试；全空会明确给 NO_RESULT，不猜身份。', 'warning');
    setFallbackBusy(true); setFallbackError(''); setFallbackResult(null);
    try {
      const result = await runtimeClient.probeSelectionFallback(queries);
      setFallbackResult(result);
      addAudit('validation', '选型回退检索诊断', `${result.hit}/${result.queries} 命中 · ${result.fallbackHits} 条靠回退命中 · ${result.empty} 条无结果`, 'info');
      notify('回退检索完成', `命中 ${result.hit}/${result.queries}，其中 ${result.fallbackHits} 条靠变形检索命中；无结果 ${result.empty} 条（不会伪造器件身份）。`, result.empty ? 'warning' : 'success');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      setFallbackError(detail);
      notify('回退检索失败', detail, 'danger');
    } finally { setFallbackBusy(false); }
  };

  const queryAlternatives = async () => {
    const components = state.components.filter((item) => item.projectId === state.activeProjectId && /^C\d{4,}$/i.test(String(item.lcscId || '').trim()));
    const outOfStock = new Set((orderCard?.supplySummary?.outOfStock ?? []).map((item) => String(item.lcsc).toUpperCase()));
    const ordered = [...components].sort((a, b) => Number(outOfStock.has(String(b.lcscId).toUpperCase())) - Number(outOfStock.has(String(a.lcscId).toUpperCase())));
    const items = ordered.slice(0, 10).map((item) => ({ lcscId: item.lcscId, mpn: item.mpn, value: item.value, package: item.package }));
    if (!items.length) return notify('没有可查询的料号', 'BOM 里没有 C 编号料号：先完成选型/绑定料号，再查替代候选。', 'warning');
    setAlternativesBusy(true);
    setAlternativesError('');
    try {
      const result = await runtimeClient.supplyAlternatives({ items, maxCandidates: 3 });
      setAlternatives(result);
      addAudit('validation', '查询替代候选', `${result.summary.found}/${result.summary.requested} 条有候选 · 共 ${result.summary.candidates} 个（等价性未验证）`, result.summary.failed ? 'warning' : 'info');
      notify('替代候选已查询', `有候选 ${result.summary.found} 条、无候选 ${result.summary.empty} 条、失败 ${result.summary.failed} 条；关键词命中≠等价替代，必须人工确认封装/参数后再改用。`, result.summary.failed ? 'warning' : 'success');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      setAlternativesError(detail);
      notify('替代候选查询失败', detail, 'danger');
    } finally { setAlternativesBusy(false); }
  };

  const loadLedger = async () => {
    if (state.runtime.mode === 'demo') return;
    setLedgerBusy(true);
    try {
      const snapshot = await runtimeClient.approvalLedger();
      setLedger(snapshot);
      setLedgerError(snapshot.loadError ? `历史账本读取失败（${snapshot.loadError}），本次从空链起锚——不伪造旧记录` : '');
    } catch (error) {
      setLedgerError(error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误');
    } finally { setLedgerBusy(false); }
  };
  useEffect(() => { void loadLedger(); }, [state.runtime.mode]);

  /** B1/B4：读取 AssetsPage readiness 交接的「当前物料清单哈希 + binding」（仅提示；Runtime 会重算校验）。 */
  const readReleaseBindingHandoff = (): { manifestHash: string | null; binding: Record<string, string> | null } => {
    try {
      const raw = sessionStorage.getItem('circuitpilot:release-binding');
      if (!raw) return { manifestHash: null, binding: null };
      const parsed = JSON.parse(raw) as { manifestHash?: string | null; binding?: Record<string, string> };
      return { manifestHash: typeof parsed.manifestHash === 'string' && parsed.manifestHash ? parsed.manifestHash : null, binding: parsed.binding && typeof parsed.binding === 'object' ? parsed.binding : null };
    } catch { return { manifestHash: null, binding: null }; }
  };

  useEffect(() => {
    const handoff = readReleaseBindingHandoff();
    if (handoff.manifestHash) setSignoffManifest((current) => current || handoff.manifestHash!);
    if (handoff.binding?.semanticPlanHash) setSignoffPlanHash((current) => current || handoff.binding!.semanticPlanHash);
  }, []);

  const archiveReleaseVersion = async () => {
    const task = createSingleCallTask<Awaited<ReturnType<typeof runtimeClient.archiveRelease>>['release']>({
      timeoutMs: 140_000,
      onUpdate: setArchiveTask,
      call: async (signal) => {
        const result = await runtimeClient.archiveRelease({
          pcbUuid: gatePcb.trim() || undefined,
          artifactsDir: gateDir.trim() || undefined,
          drcReportPath: gateDrcPath.trim() || undefined,
          userConfirmed: gateConfirmed,
          pricing: pricingEvidence,
          constraints: state.requirements,
          designFacts: buildDesignFacts(designFactsDraft),
          ...(engineeringResult ? { engineering: engineeringResult } : {}),
        }, { signal });
        setArchiveResult(result.release);
        addAudit('version', '归档不可变发布版本', `${result.release.releaseId} · 指纹 ${result.release.binding.gateFingerprint?.slice(0, 12) ?? '—'}`, 'success');
        notify('发布版本已归档', `${result.release.releaseId}：记录绑定门禁/裁决/人工证据，不可编辑；证据文件重校验 ${result.release.verification.verified ? '通过' : '失败（见追溯页）'}。`, result.release.verification.verified ? 'success' : 'warning');
        return result.release;
      },
    });
    archiveTaskRef.current = task;
    const settled = await task.startTask();
    if (settled.status === 'failed') { addAudit('version', '归档发布版本被拒绝', settled.error || '未知错误', 'error'); notify('归档被拒绝', settled.error || '未知错误', 'danger'); }
    else if (settled.status !== 'done') notify('已停止等待归档', settled.note || '本页已停止等待；服务端可能仍在归档，以发布记录/证据目录为准。', 'warning');
  };

  const runExport = async (requested: 'draft' | 'final') => {
    lastExportRequestedRef.current = requested;
    setExporting(requested);
    setExportResult(null);
    const task = createSingleCallTask<ProductionExportResult>({
      call: (signal) => {
        const handoff = readReleaseBindingHandoff();
        return runtimeClient.productionExport({
          requested,
          pcbUuid: gatePcb.trim() || undefined,
          pageUuid: gatePage.trim() || undefined,
          artifactsDir: gateDir.trim() || undefined,
          drcReportPath: gateDrcPath.trim() || undefined,
          userConfirmed: gateConfirmed,
          pricing: pricingEvidence,
          constraints: state.requirements,
          designFacts: buildDesignFacts(designFactsDraft),
          ...(engineeringResult ? { engineering: engineeringResult } : {}),
          // 正式导出必须证明签核物料 = 本次物料：带上 readiness 交接的 manifestHash/binding，
          // 服务端会用同一 binding 重算当前产物并比对（旧签核复用会被 RELEASE_MANIFEST_MISMATCH 挡住）。
          ...(requested === 'final' && handoff.manifestHash ? { manifestHash: handoff.manifestHash, ...(handoff.binding ? { binding: handoff.binding } : {}) } : {}),
        }, { signal });
      },
      timeoutMs: 240_000,
      now: () => Date.now(),
      onUpdate: setExportTask,
    });
    exportTaskRef.current = task;
    const snapshot = await task.startTask();
    exportTaskRef.current = null;
    setExporting(null);
    if (snapshot.status !== 'done' || !snapshot.result) {
      const detail = snapshot.error || snapshot.note || '导出未返回结果';
      if (snapshot.status === 'cancelled' || snapshot.status === 'timeout') {
        // 取消/超时只代表"本页停止等待"，不写"导出失败"，也不冒充已经终止服务端。
        addAudit('version', '生产文件导出已停止等待', `${detail}（可能已落盘，以产物目录/审计为准）`, 'warning');
        notify('已停止等待导出', detail, 'warning');
        return;
      }
      reportIssue({ fingerprint: 'production:EXPORT_FAILED', source: 'validation', severity: 'error', status: 'open', code: 'PRODUCTION_EXPORT_FAILED', summary: '生产文件导出失败', detail, suggestedAction: '确认嘉立创EDA 已打开本板 PCB 文档后重试；导出失败不会留下半截文件。' });
      addAudit('version', '生产文件导出失败', detail, 'error');
      notify('导出失败', detail, 'danger');
      return;
    }
    const result = snapshot.result;
    setExportResult(result);
    const fileCount = result.files?.length ?? 0;
    addAudit('version', requested === 'final' ? '导出正式生产文件' : '导出草稿生产文件', result.exported ? `${fileCount} 个文件已落盘` : `未产出（${result.code || '被拒'}）`, result.exported ? (requested === 'final' ? 'success' : 'warning') : 'error');
    notify(result.exported ? '生产文件已产出' : '生产文件未产出', result.message || (result.exported ? `${fileCount} 个文件已落盘` : '运行时拒绝了本次导出。'), result.exported ? (requested === 'final' ? 'success' : 'warning') : 'danger');
  };

  const cancelExport = () => {
    void exportTaskRef.current?.cancelTask();
  };

  /** 下载单个放行产物：字节流来自 Runtime（白名单路径），前端只触发保存。 */
  const downloadArtifact = async (path: string, label: string) => {
    try {
      const { blob, name } = await runtimeClient.downloadProductionArtifact(path);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      addAudit('version', '下载生产产物', `${label} · ${name}`, 'info');
      notify('已开始下载', `${name}（${(blob.size / 1024).toFixed(1)} KB）`, 'success');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      notify('产物下载失败', detail, 'danger');
    }
  };

  /** 生产文件清单 CSV：把文件哈希与放行结论一起带走，便于离线复核/归档（不下载实际 Gerber 大文件）。 */
  const downloadExportManifest = () => {
    if (!exportResult) return;
    const meta = [
      ['outDir', exportResult.outDir || ''],
      ['manifestSha256', exportResult.manifest?.manifestSha256 || ''],
      ['released', String(exportResult.manifest?.released ?? false)],
      ['decisionTicket', exportResult.manifest?.decisionTicket || ''],
      ['releaseDecision', exportResult.releaseDecision ? (exportResult.releaseDecision.ready ? 'ready' : `blocked:${exportResult.releaseDecision.blockedBy.join('|')}`) : 'none'],
    ];
    const header = ['kind', 'name', 'bytes', 'sha256', 'path'];
    const rows = (exportResult.files || []).map((file) => [file.kind, file.name, String(file.bytes), file.sha256, file.path]);
    const csv = [header, ...rows].map((row) => row.map((cell) => JSON.stringify(cell)).join(',')).join('\n');
    const footer = ['', '# metadata', ...meta.map((row) => row.map((cell) => JSON.stringify(cell)).join(','))].join('\n');
    const blob = new Blob([`\ufeff${csv}\n${footer}\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `production-manifest-${exportResult.manifest?.manifestSha256?.slice(0, 12) || 'unknown'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    addAudit('version', '下载生产清单CSV', `${rows.length} 个文件 · ${exportResult.manifest?.manifestSha256?.slice(0, 12) || '无 manifest'}`, 'info');
    notify('生产清单已导出', 'CSV 含文件 SHA-256 与放行裁决；实际 Gerber/BOM 文件仍在落盘目录。', 'success');
  };

  /**
   * 生成板厂下单参数卡：实测板事实 vs 下单参数。只读，不写 EDA，也不猜价格。
   * 用户改了参数就重新生成——参数与板子不一致时必须以阻断的形式出现，而不是"看着差不多"。
   */
  const runOrderCard = async () => {
    setOrderRunning(true);
    try {
      const card = await runtimeClient.orderCard({
        requested: {
          ...(orderLayers.trim() ? { layers: Number(orderLayers) } : {}),
          ...(Number.isFinite(Number(orderQuantity)) ? { quantity: Number(orderQuantity) } : {}),
          impedanceControl: orderImpedance,
          surfaceFinish: orderFinish,
        },
        pcbUuid: gatePcb.trim() || undefined,
        artifactsDir: gateDir.trim() || undefined,
        drcReportPath: gateDrcPath.trim() || undefined,
        // B3：把"查询时刻"的价格/库存证据随卡带过去，卡上才能显示已知单价合计/缺货项。
        pricingEvidence: pricingEvidence ?? undefined,
      });
      setOrderCard(card);
      addAudit('version', '生成板厂下单参数卡', `${card.readyToOrder ? '参数自洽' : `${card.counts.blocking} 条阻断 / ${card.counts.unknown} 条未确认`}`, card.readyToOrder ? 'success' : 'warning');
      notify(card.readyToOrder ? '下单参数已自洽' : '下单参数还不能用', card.readyToOrder ? '可按参数交板厂；金额与交期以板厂报价为准，仍需人工签字。' : card.nextStep, card.readyToOrder ? 'success' : 'warning');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      reportIssue({ fingerprint: 'production:ORDER_CARD_FAILED', source: 'validation', severity: 'error', status: 'open', code: 'ORDER_CARD_FAILED', summary: '生成下单参数卡失败', detail, suggestedAction: '确认嘉立创EDA 已打开该 PCB（或填 PCB UUID）后重试。' });
      notify('生成下单参数卡失败', detail, 'danger');
    } finally {
      setOrderRunning(false);
    }
  };

  /**
   * 自动修复原理图：缺 Rd / 缺 I2C 上拉这类"验收已经指出来的缺陷"直接落到原理图上。
   * 预演与真写走同一条代码路径，区别只在 dryRun —— 用户先看清要动什么再决定写。
   */
  /** 只读验收：读真机数据判定"原理图要上板 vs PCB 现况"，差异没清零就不解锁自动布局。 */
  const runPcbSyncVerify = async () => {
    setSyncRunning(true);
    setSyncError(null);
    try {
      const result = await runtimeClient.pcbSyncVerify();
      setSyncVerify(result.verification);
    } catch (error) {
      setSyncVerify(null);
      setSyncError(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncRunning(false);
    }
  };

  const runSchematicRepair = async (dryRun: boolean) => {
    setRepairRunning(dryRun ? 'dry' : 'apply');
    setRepairSnapshot(null);
    const task = createSingleCallTask({
      call: (signal) => runtimeClient.repairSchematic({ pageUuid: gatePage.trim() || undefined, dryRun }, { signal }),
      timeoutMs: 240_000,
      onUpdate: setRepairSnapshot,
    });
    repairTaskRef.current = task;
    const snapshot = await task.startTask();
    setRepairRunning(null);
    if (snapshot.status !== 'done' || !snapshot.result) {
      if (snapshot.status === 'failed') {
        const detail = snapshot.error || '未知错误';
        reportIssue({ fingerprint: 'validation:SCHEMATIC_REPAIR', source: 'validation', severity: 'error', status: 'open', code: 'SCHEMATIC_REPAIR_FAILED', summary: '原理图自动修复失败', detail, suggestedAction: '确认嘉立创EDA 已打开目标原理图（或填页面 UUID）后重试；复核不过时系统会自行回滚并报告回滚是否干净。' });
        notify('原理图自动修复失败', detail, 'danger');
      } else {
        notify('已停止等待原理图修复', snapshot.note || '本页已停止等待；修复可能已写入部分内容，请核对快照/审计后再重试。', 'warning');
      }
      return;
    }
    {
      const report = snapshot.result;
      setRepair(report);
      if (dryRun) {
        const ops = report.plan?.operations.length ?? 0;
        addAudit('version', '预演原理图自动修复', `${ops} 步 · 未写盘`, 'info');
        notify('修复预演完成', `将新增 ${report.devices?.length ?? 0} 个元件、${ops} 步操作；确认无误后再点“执行修复并验收”。`, 'success');
      } else {
        const ready = report.acceptance?.ready === true;
        addAudit('version', '执行原理图自动修复', `${report.applied?.createdPins.length ?? 0} 个引脚落位 · 验收${ready ? '通过' : '未通过'}`, ready ? 'success' : 'warning');
        notify(ready ? '原理图已修复且验收通过' : '原理图已写入但验收未通过', ready ? '仿真数值已核对通过；接着同步到 PCB 并重新布局/DRC。' : '请看下方验收发现，必要时用快照回退。', ready ? 'success' : 'warning');
      }
    }
  };

  /** 已确认 + 硬性需求（服务端会再做一次归一化；这里只用于提示条数）。 */
  const hardConfirmedRequirements = state.requirements.filter((item) => item.status === 'confirmed' && item.kind !== 'soft');

  const runReleaseGate = async () => {
    setGateRunning(true);
    setGateSnapshot(null);
    const task = createSingleCallTask({
      call: (signal) => runtimeClient.releaseGate({
        pcbUuid: gatePcb.trim() || undefined,
        pageUuid: gatePage.trim() || undefined,
        artifactsDir: gateDir.trim() || undefined,
        drcReportPath: gateDrcPath.trim() || undefined,
        userConfirmed: gateConfirmed,
        pricing: pricingEvidence,
        constraints: state.requirements,
        designFacts: buildDesignFacts(designFactsDraft),
        ...(engineeringResult ? { engineering: engineeringResult } : {}),
      }, { signal }),
      timeoutMs: 180_000,
      onUpdate: setGateSnapshot,
    });
    gateTaskRef.current = task;
    const snapshot = await task.startTask();
    setGateRunning(false);
    if (snapshot.status !== 'done' || !snapshot.result) {
      const detail = snapshot.status === 'failed' ? (snapshot.error || '未知错误') : (snapshot.note || '本页已停止等待；闸门可能仍在服务端运行，稍后重试。');
      if (snapshot.status === 'failed') {
        void reportFailure({ source: 'validation', error: { code: 'RELEASE_GATE_FAILED', message: detail }, context: { operation: 'release-gate', ...(gatePcb.trim() ? { pcbUuid: gatePcb.trim() } : {}), ...(gateDrcPath.trim() ? { evidencePath: gateDrcPath.trim() } : {}) } });
        addAudit('validation', '下单前闸门失败', detail, 'error');
      }
      notify(snapshot.status === 'failed' ? '闸门运行失败' : '已停止等待闸门', detail, snapshot.status === 'failed' ? 'danger' : 'warning');
      return;
    }
    {
      const report = snapshot.result;
      setGate(report);
      const summary = summarizeGate(report);
      addAudit('validation', '运行下单前闸门', `${summary.headline} · 指纹 ${report.fingerprint.sha256.slice(0, 12)}`, report.ready ? 'success' : 'error');
      notify(summary.headline, summary.detail, summary.tone);
    }
  };

  // 分类结论（runtime/drc.mjs classifyDrcItems）：把"多少条已解释/未解释"直接摊开，
  // 而不是只给一个条目数——没解释的条目才是放行前的真问题。
  const drcClassification = drcResult?.classification as {
    ready?: boolean;
    summary?: { total?: number; exempted?: number; unexplained?: number; reportedCount?: number | null; truncated?: boolean };
    findings?: Array<{ code: string; severity: string; message: string }>;
    unexplained?: Array<{ index: number }>;
    exempted?: Array<{ itemIndexes: number[]; reason?: string; risk?: string; approvedBy?: string | null }>;
  } | undefined;
  // 逐条违规明细：把"哪一条被豁免/哪一条还没解释"直接标在行上，避免只看一个总数。
  const drcItemStatus = new Map<number, { label: string; detail: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }>();
  for (const entry of drcClassification?.exempted || []) {
    for (const index of entry.itemIndexes || []) {
      drcItemStatus.set(index, { label: `已豁免${entry.approvedBy ? `（${entry.approvedBy}）` : ''}`, detail: entry.reason || '', tone: 'warning' });
    }
  }
  for (const item of drcClassification?.unexplained || []) {
    if (!drcItemStatus.has(item.index)) drcItemStatus.set(item.index, { label: '未解释', detail: '既未修复也未登记豁免，放行前必须处理', tone: 'danger' });
  }

  return (
    <>
      <div className="stats-grid stats-grid--4"><Stat label="验证覆盖率" value={`${coverage}%`} hint={`${state.validations.length} 个检查域`} tone={coverage === 100 ? 'success' : 'warning'} /><Stat label="通过" value={passCount} hint="当前无开放问题" tone="success" /><Stat label="警告 / 失败" value={state.validations.filter((item) => item.status === 'warn' || item.status === 'fail').length} hint="需要工程审阅" tone="warning" /><Stat label="未收口发现" value={totalOpen} hint="ERC/DRC 发现；豁免不计入" tone={totalOpen ? 'danger' : 'success'} /></div>
      {state.runtime.mode === 'demo' ? (
        <div className="inline-alert inline-alert--warning" role="status">
          <AlertTriangle size={16} />
          <span><strong>当前为 DEMO：</strong>验证矩阵与布局为模拟数据，只能用于走查界面，<strong>不能作为放行证据</strong>。真实验证 / DRC 取证 / 放行闸门需要本机 Runtime + 嘉立创EDA（Bridge / CDP）。</span>
        </div>
      ) : null}
      <LongTaskPanel title="原理图验收（长任务）" snapshot={acceptanceSnapshot} onCancel={() => { acceptanceTaskRef.current?.cancelTask(); }} onRetry={() => void runAcceptance()} cancelLabel="停止等待验收" retryLabel="重新验收" />
      <LongTaskPanel title="原理图自动修复（长任务）" snapshot={repairSnapshot} onCancel={() => { repairTaskRef.current?.cancelTask(); }} onRetry={() => void runSchematicRepair(false)} cancelLabel="停止等待修复" retryLabel="重新执行修复" />
      <LongTaskPanel title="下单前闸门（长任务）" snapshot={gateSnapshot} onCancel={() => { gateTaskRef.current?.cancelTask(); }} onRetry={() => void runReleaseGate()} cancelLabel="停止等待闸门" retryLabel="重新运行闸门" />

      <Panel
        eyebrow="DRC EVIDENCE"
        title="PCB DRC 一键取证（真机）"
        meta={drcRunning ? <Badge tone="info">运行中 · {drcJob?.state ?? 'starting'}</Badge> : drcResult?.saved ? <Badge tone="success">已落盘 {drcResult.saved.digest.slice(0, 12)}</Badge> : drcLatest ? <Badge tone="success">已有取证 {drcLatest.digest.slice(0, 12)}</Badge> : <Badge tone="neutral">未取证</Badge>}
        actions={<>
          <Button variant="primary" icon={<Activity size={15} />} loading={drcRunning} disabled={drcRunning || state.runtime.mode === 'demo'} title={state.runtime.mode === 'demo' ? 'DEMO 模式无法连真机：请先启动 Runtime + 嘉立创EDA' : '真机取证：启动→轮询→落盘'} onClick={runPcbDrc}>运行 PCB DRC</Button>
          <Button icon={<RefreshCw size={15} />} disabled={drcRunning} onClick={() => void loadLatestDrc()}>载入最新取证</Button>
          {drcRunning && drcJob ? <Button variant="ghost" onClick={() => void cancelPcbDrc()}>取消</Button> : null}
        </>}
      >
        <div className="inline-alert inline-alert--info"><span>DRC 是渲染进程长任务：运行时先受理 job，再轮询报告，完成后落盘为证据并把路径自动填进下方闸门。没有跑过 DRC 时，闸门会按“证据缺失”阻断，绝不会默认通过。</span></div>
        {drcJob ? <div className="detail-block"><span>Job <CopyValue value={drcJob.jobId} label="DRC Job ID" display={drcJob.jobId} /></span><p>状态：<strong>{drcJob.state}</strong>{drcRunning ? ' · 每 2 秒轮询一次，最长 3 分钟' : ''}</p></div> : null}
        <LongTaskPanel
          title="长任务状态（D8：轮询/取消/超时/重试）"
          snapshot={drcTask}
          onCancel={drcRunning ? () => void cancelPcbDrc() : undefined}
          onRetry={() => void runPcbDrc()}
          retryLabel="重新运行 DRC"
        />
        {drcError ? <div className="inline-alert inline-alert--danger"><XCircle size={16} /><span>{drcError}</span></div> : null}
        {drcResult?.report ? (
          <div className="detail-stack">
            <div className="stats-grid stats-grid--4">
              <Stat label="条目数" value={drcResult.report.items?.length ?? 0} hint={drcResult.report.truncated ? '原始报告被截断' : '完整报告'} tone={(drcResult.report.items?.length ?? 0) ? 'warning' : 'success'} />
              <Stat label="EDA 报告数" value={drcResult.report.reportedCount ?? '未知'} hint={drcResult.report.countsConsistent === false ? '与条目数不一致' : '一致性已核对'} tone={drcResult.report.countsConsistent === false ? 'warning' : 'success'} />
              <Stat label="证据摘要" value={<code>{drcResult.saved?.digest?.slice(0, 12) || '—'}</code>} hint={drcResult.saved?.savedAt ? new Date(drcResult.saved.savedAt).toLocaleString('zh-CN') : '未落盘'} />
              <Stat label="落盘路径" value={<small title={drcResult.saved?.path || undefined}>{drcResult.saved?.path ? drcResult.saved.path.split('/').pop() : '—'}</small>} hint="已自动填入闸门" />
            </div>
            {drcClassification ? (
              <div className="detail-stack">
                <div className="row-actions">
                  <Badge tone={drcClassification.ready ? 'success' : 'danger'}>{drcClassification.ready ? '分类结论：无阻断项' : '分类结论：仍有阻断项'}</Badge>
                  <Badge tone="neutral">总 {drcClassification.summary?.total ?? 0}</Badge>
                  <Badge tone={drcClassification.summary?.exempted ? 'warning' : 'neutral'}>已豁免 {drcClassification.summary?.exempted ?? 0}</Badge>
                  <Badge tone={drcClassification.summary?.unexplained ? 'danger' : 'success'}>未解释 {drcClassification.summary?.unexplained ?? 0}</Badge>
                  {drcClassification.summary?.truncated ? <Badge tone="danger">报告被截断</Badge> : null}
                </div>
                {drcClassification.findings?.length ? (
                  <div className="stack">
                    {drcClassification.findings.map((finding) => (
                      <div key={finding.code} className="row">
                        <Badge tone={finding.severity === 'blocking' ? 'danger' : finding.severity === 'warning' ? 'warning' : 'neutral'}>{finding.code}</Badge>
                        <span>{finding.message}</span>
                      </div>
                    ))}
                  </div>
                ) : <div className="muted">没有分类发现（报告完整且每条违规都有处理结论）。</div>}
              </div>
            ) : null}
            {(() => {
              const items = drcResult.report.items || [];
              if (!items.length) return null;
              const shown = items.slice(0, 300);
              return (
                <TableFrame label={`违规明细（${items.length} 条${items.length > shown.length ? `，仅显示前 ${shown.length} 条` : ''}；结论来自本次豁免清单匹配）`}>
                  <table>
                    <thead><tr><th>#</th><th>类型 / 规则</th><th>对象</th><th>网络 / 层</th><th>说明</th><th>结论</th></tr></thead>
                    <tbody>
                      {shown.map((item, index) => {
                        const itemIndex = Number((item as { index?: number }).index ?? index);
                        const status = drcItemStatus.get(itemIndex);
                        const objects = (item.objects || []).map((obj) => obj?.type).filter(Boolean).join('、');
                        return (
                          <tr key={`${item.signature || 'sig'}-${itemIndex}`}>
                            <td>{itemIndex + 1}</td>
                            <td><code>{String(item.errorType ?? '未知')}</code>{(item as { ruleName?: string }).ruleName ? <small>{String((item as { ruleName?: string }).ruleName)}</small> : null}</td>
                            <td>{objects || '—'}</td>
                            <td>{(item as { net?: string }).net || '—'} / {(item as { layer?: string }).layer || '—'}</td>
                            <td>{String((item as { explanation?: { text?: string } }).explanation?.text || (item as { explanation?: string }).explanation || '—')}</td>
                            <td>{status ? <span title={status.detail}><Badge tone={status.tone}>{status.label}</Badge></span> : <Badge tone="neutral">无结论</Badge>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableFrame>
              );
            })()}
            {drcResult.saved?.path ? <div className="row-actions"><Button icon={<Link2 size={15} />} onClick={() => setGateDrcPath(drcResult.saved!.path)}>填入下方闸门</Button><CopyValue value={drcResult.saved.path} label="DRC 证据路径" /></div> : null}
          </div>
        ) : drcLatest ? (
          <div className="detail-stack">
            <div className="stats-grid stats-grid--4">
              <Stat label="最近取证条目" value={drcLatest.payload?.report?.items?.length ?? 0} hint={drcLatest.payload?.report?.truncated ? '原始报告被截断' : '完整报告'} tone={(drcLatest.payload?.report?.items?.length ?? 0) ? 'warning' : 'success'} />
              <Stat label="证据摘要" value={<code>{drcLatest.digest.slice(0, 12)}</code>} hint={new Date(drcLatest.savedAt).toLocaleString('zh-CN')} />
              <Stat label="指纹" value={<small className="fingerprint-value">{Object.keys(drcLatest.fingerprint).length ? Object.entries(drcLatest.fingerprint).map(([key, value]) => <span key={key}>{key}=<code>{value ?? '—'}</code></span>) : '—'}</small>} hint="绑定本次 job / PCB" />
              <Stat label="落盘路径" value={<small title={drcLatest.path}>{drcLatest.path.split('/').pop()}</small>} hint="已自动填入闸门" />
            </div>
            <div className="row-actions"><Button icon={<Link2 size={15} />} onClick={() => setGateDrcPath(drcLatest.path)}>填入下方闸门</Button><CopyValue value={drcLatest.path} label="最近 DRC 证据路径" /></div>
          </div>
        ) : null}
        <LongTaskPanel title="ERC 取证长任务（D8：取消只停止本页等待）" snapshot={ercTask} onCancel={ercTask?.status === 'running' ? () => ercTaskRef.current?.cancelTask() : undefined} onRetry={() => void runErc()} cancelLabel="停止等待取证" retryLabel="重新取证" />
      </Panel>
      <Panel
        eyebrow="DRC EXEMPTIONS"
        title="DRC 豁免清单（人工接受风险，不是通过）"
        meta={exemptionInfo ? `${exemptionInfo.count ?? exemptions.length} 条 · ${exemptionInfo.exists ? '文件存在' : '文件不存在'}` : '尚未载入'}
        actions={<>
          <Button icon={<RefreshCw size={15} />} disabled={exemptionBusy} onClick={() => void loadExemptions()}>载入豁免</Button>
          <Button icon={<Sparkles size={15} />} disabled={exemptionBusy} onClick={seedExemptionsFromReport}>按本次报告生成草稿</Button>
          <Button variant="primary" icon={<ShieldCheck size={15} />} loading={exemptionBusy} disabled={exemptionBusy || !exemptionDirty} onClick={() => void saveExemptions()}>保存豁免清单</Button>
        </>}
      >
        <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>豁免不会删除 DRC 问题：它把“人工接受该风险”绑定到 errorType/配额/理由/残留风险上，放行闸门会把命中项算作“已豁免”而不是“未处理”。<strong>缺理由、缺残留风险、缺正整数配额的一律拒绝写入</strong>；别的板/别的缺陷签名不会被这条豁免覆盖。</span></div>
        <div className="row-actions">
          <Badge tone={exemptions.length ? 'warning' : 'neutral'}>{exemptions.length} 条待保存</Badge>
          {exemptionInfo?.path ? <CopyValue value={exemptionInfo.path} label="DRC 豁免清单路径" /> : null}
          <Button size="sm" icon={<Plus size={13} />} disabled={exemptionBusy} onClick={() => { setExemptions((current) => [...current, { scope: 'kind', match: { errorType: '' }, maxCount: 1, reason: '', risk: '', approvedBy: '' }]); setExemptionDirty(true); }}>手动新增一条</Button>
        </div>
        {exemptionInfo?.invalid?.length ? <div className="inline-alert inline-alert--danger"><XCircle size={16} /><span>文件里已有 {exemptionInfo.invalid.length} 条无效豁免（放行闸门会把它当成未处理）：{exemptionInfo.invalid.slice(0, 3).map((item) => `#${item.index} ${item.problems.join('；')}`).join(' | ')}</span></div> : null}
        {exemptions.length ? (
          <TableFrame label="豁免项（逐条补全理由与残留风险）">
            <table>
              <thead><tr><th>#</th><th>范围 / 匹配</th><th>配额</th><th>理由（≥8 字）</th><th>残留风险（≥8 字）</th><th>批准人</th><th></th></tr></thead>
              <tbody>
                {exemptions.map((row, index) => {
                  const problems = exemptionProblems(row);
                  return (
                    <tr key={row.id || `row-${index}`}>
                      <td>{index + 1}{row.occurrences ? <small>命中 {row.occurrences}</small> : null}</td>
                      <td>
                        <select className="input" value={row.scope === 'instance' ? 'instance' : 'kind'} onChange={(event) => patchExemption(index, { scope: event.target.value === 'instance' ? 'instance' : 'kind' })} aria-label={`第${index + 1}条豁免范围`}>
                          <option value="kind">kind（按缺陷类型）</option>
                          <option value="instance">instance（按实例）</option>
                        </select>
                        {row.scope === 'instance'
                          ? <input className="input" value={row.match?.instanceKey || ''} onChange={(event) => patchExemption(index, { match: { ...row.match, instanceKey: event.target.value } })} placeholder="match.instanceKey" aria-label={`第${index + 1}条实例键`} />
                          : <input className="input" value={row.match?.errorType || ''} onChange={(event) => patchExemption(index, { match: { ...row.match, errorType: event.target.value } })} placeholder="match.errorType（如 Clearance）" aria-label={`第${index + 1}条缺陷类型`} />}
                        {row.match?.ruleName || row.match?.layer ? <small>{[row.match?.ruleName, row.match?.layer].filter(Boolean).join(' · ')}</small> : null}
                      </td>
                      <td><input className="input" type="number" min={1} max={9999} style={{ width: 84 }} value={Number(row.maxCount) || 1} onChange={(event) => patchExemption(index, { maxCount: Math.max(1, Math.floor(Number(event.target.value) || 1)) })} aria-label={`第${index + 1}条配额`} /></td>
                      <td><textarea className="input" rows={2} value={row.reason || ''} onChange={(event) => patchExemption(index, { reason: event.target.value })} placeholder="为什么可以放过（工艺能力/样机用途…）" aria-label={`第${index + 1}条理由`} /></td>
                      <td><textarea className="input" rows={2} value={row.risk || ''} onChange={(event) => patchExemption(index, { risk: event.target.value })} placeholder="放过之后可能出什么事" aria-label={`第${index + 1}条残留风险`} /></td>
                      <td><input className="input" value={row.approvedBy || ''} onChange={(event) => patchExemption(index, { approvedBy: event.target.value })} placeholder="批准人" aria-label={`第${index + 1}条批准人`} /></td>
                      <td>{problems.length ? <Badge tone="danger">{problems.join('；')}</Badge> : <Badge tone="success">已完整</Badge>}<Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => removeExemption(index)}>删除</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableFrame>
        ) : <div className="empty-inline"><ShieldCheck size={24} /><strong>当前没有 DRC 豁免</strong><span>先跑一次 DRC 取证，用“按本次报告生成草稿”得到带配额/签名的豁免骨架，再补理由与风险。</span></div>}
      </Panel>

      <Panel
        eyebrow="PIN EVIDENCE"
        title="引脚证据链（A4，只读）"
        meta={pinResult ? <Badge tone={pinResult.audit.ok ? 'success' : 'warning'}>{pinResult.audit.ok ? '证据完整' : `阻断 ${pinResult.audit.blockers.length}`}</Badge> : <Badge tone="neutral">未采集</Badge>}
        actions={<><Button icon={<Link2 size={15} />} loading={pinBusy} disabled={pinBusy || state.runtime.mode === 'demo'} title="读 PCB 焊盘（位号/脚号/网络/层）并核对原理图位号覆盖；只读" onClick={() => void runPinEvidence()}>采集引脚证据</Button><Button icon={<ShieldCheck size={15} />} loading={pinFlowBusy} onClick={() => void runPinFirstFlow()} title="只生成两阶段计划（落板→引脚证据→审计→网表），不执行、不代批准">生成两阶段计划</Button></>}
      >
        <div className="inline-alert inline-alert--info"><span>以 PCB 焊盘为权威来源采集"位号↔脚号↔网络"；<strong>没有网络且没有显式 assumption 的焊盘会阻断网表/执行计划</strong>，不会把"没读到/没网络"当成通过。</span></div>
        {pinResult ? (
          <>
            <div className="stats-grid stats-grid--4">
              <Stat label="器件" value={pinResult.audit.counts.components} hint={`读回焊盘 ${pinResult.readback.pads} 个`} />
              <Stat label="焊盘" value={pinResult.audit.counts.pins} hint={`有网络 ${pinResult.audit.counts.withNet}`} tone={pinResult.audit.counts.withNet === pinResult.audit.counts.pins ? 'success' : 'warning'} />
              <Stat label="未知网络" value={pinResult.audit.counts.unknown} hint={`已写 assumption ${pinResult.audit.counts.assumed}`} tone={pinResult.audit.counts.unknown ? 'danger' : 'success'} />
              <Stat label="原理图覆盖" value={pinResult.readback.schematicParts === null ? '未读到' : `${pinResult.readback.schematicParts} 器件`} hint={pinResult.evidence.schematic.onlySchematic.length || pinResult.evidence.schematic.onlyPcb.length ? `仅原理图 ${pinResult.evidence.schematic.onlySchematic.length} / 仅 PCB ${pinResult.evidence.schematic.onlyPcb.length}` : '位号覆盖一致'} />
            </div>
            {(pinResult.audit.blockers.length || pinResult.audit.warnings.length) ? (
              <TableFrame label="引脚证据审计">
                <table className="table"><thead><tr><th>级别</th><th>代码</th><th>说明</th></tr></thead>
                  <tbody>
                    {pinResult.audit.blockers.map((item, index) => <tr key={`b-${index}`}><td><Badge tone="danger">阻断</Badge></td><td><code>{item.code}</code></td><td>{item.message}</td></tr>)}
                    {pinResult.audit.warnings.map((item, index) => <tr key={`w-${index}`}><td><Badge tone="warning">提示</Badge></td><td><code>{item.code}</code></td><td>{item.message}</td></tr>)}
                  </tbody>
                </table>
              </TableFrame>
            ) : <p><small>没有阻断/警告：所有焊盘都有网络或显式 assumption，位号覆盖一致。</small></p>}
          </>
        ) : <p><small>点击"采集引脚证据"读取当前 PCB 焊盘并（可选）切到原理图核对位号；它不会写板。</small></p>}
        {pinFlowPlan ? (
          <div className="detail-block">
            <span>两阶段计划（A4）：{pinFlowPlan.executable ? '可执行' : '被阻断'} · 计划 <code>{pinFlowPlan.planId.slice(0, 12)}</code></span>
            {pinFlowPlan.blockers.length ? <div className="inline-alert inline-alert--warning"><span>阻断：{pinFlowPlan.blockers.map((item) => `${item.code} ${item.message}`).join('；')}</span></div> : null}
            <table className="table"><thead><tr><th>#</th><th>阶段</th><th>类型</th><th>依赖</th><th>需批准</th><th>预期证据</th></tr></thead>
              <tbody>{pinFlowPlan.stages.map((stage) => <tr key={stage.id}><td>{stage.order}</td><td><strong>{stage.title}</strong><small>{stage.reason}</small></td><td>{stage.type}</td><td>{stage.dependsOn.join(' → ') || '—'}</td><td>{stage.requiresApproval ? '是（一次性写板批准）' : '否'}</td><td><small>{stage.expectedEvidence.join('；')}</small></td></tr>)}</tbody>
            </table>
            <small>本页只生成计划：不会自动落板、不会自动批准、不会自动生成网表。</small>
          </div>
        ) : null}
      </Panel>

      <Panel
        eyebrow="SPICE SIMULATION"
        title="SPICE 仿真证据（真实求解器）"
        meta={simResult ? <Badge tone={simResult.ok ? 'success' : 'warning'}>{simResult.ok ? '证据已产出' : '有阻断项'}</Badge> : simLatest ? <Badge tone="success">已有证据 {simLatest.digest.slice(0, 12)}</Badge> : <Badge tone="neutral">未取证</Badge>}
        actions={<>
          <Button variant="primary" icon={<Activity size={15} />} loading={simBusy} disabled={simBusy || state.runtime.mode === 'demo'} title={state.runtime.mode === 'demo' ? 'DEMO 模式无法连真机' : '从 EDA 导出 SPICE 网表 → 真实 NGspice 求解 → 校验证据哈希 → 落盘'} onClick={() => void runSimulation()}>运行仿真取证</Button>
          <Button icon={<RefreshCw size={15} />} disabled={simBusy} onClick={() => void loadLatestSimulation()}>载入最新仿真</Button>
          <Button icon={<ListChecks size={15} />} loading={acceptanceBusy} disabled={acceptanceBusy || state.runtime.mode === 'demo'} title="导出网表/ERC/结构比对；EDA 导不出仿真网表时用真实求解器跑设计检查点" onClick={() => void runAcceptance()}>运行原理图验收</Button>
        </>}
      >
        <div className="inline-alert inline-alert--info"><span>仿真证据只能由<strong>真实求解器</strong>产出：本机没有 ngspice/spice3/xyce 或 EDA 导不出仿真网表时，这里会显示结构化失败（缺什么、试过哪些路径），<strong>不会显示成"仿真通过"</strong>；证据绑定网表 sha256，换原理图即失效。</span></div>
        {simError ? <div className="inline-alert inline-alert--danger"><XCircle size={16} /><span>{simError}</span></div> : null}
        {simResult ? (
          <>
            <div className="stats-grid stats-grid--4">
              <Stat label="结论" value={simResult.ok ? '通过' : '有阻断'} hint={simResult.evidence?.solver?.path ? `求解器 ${simResult.evidence.solver.path}` : '见错误详情'} tone={simResult.ok ? 'success' : 'danger'} />
              <Stat label="证据哈希" value={<code>{simResult.evidence?.evidenceHash?.slice(0, 12) ?? '—'}</code>} hint={simResult.saved ? `已落盘 ${simResult.saved.digest.slice(0, 12)}` : '未落盘（persist:false）'} />
              <Stat label="网表" value={`${simResult.netlist.bytes} B`} hint={simResult.evidence?.netlist?.sha256?.slice(0, 16) ?? '—'} />
              <Stat label="工作点节点" value={Object.keys(simResult.evidence?.operatingPoint ?? {}).length} hint="v(node) 实测值" />
            </div>
            {simResult.findings.length ? (
              <TableFrame label="仿真发现">
                <table className="table"><thead><tr><th>级别</th><th>代码</th><th>说明</th></tr></thead>
                  <tbody>{simResult.findings.slice(0, 20).map((finding, index) => {
                    const item = finding as { code?: string; message?: string; severity?: string };
                    return <tr key={`${item.code}-${index}`}><td><Badge tone={item.severity === 'blocking' ? 'danger' : 'warning'}>{item.severity || 'info'}</Badge></td><td><code>{item.code || '—'}</code></td><td>{item.message || '—'}</td></tr>;
                  })}</tbody>
                </table>
              </TableFrame>
            ) : <p><small>没有发现项：求解器真实跑过，证据校验通过。</small></p>}
          </>
        ) : null}
        {acceptanceResult ? (
          <div className="detail-block">
            <span>原理图验收（{acceptanceResult.schematic?.schematicUuid ?? '当前页'}）</span>
            <p><Badge tone={acceptanceResult.acceptance?.ready ? 'success' : 'warning'}>{acceptanceResult.acceptance?.ready ? 'ready' : '未通过'}</Badge>{' '}
              仿真：{acceptanceResult.acceptance?.designChecks?.summary?.simulated ? `已跑设计检查点 ${acceptanceResult.acceptance.designChecks.summary.passed}/${acceptanceResult.acceptance.designChecks.summary.total}` : (acceptanceResult.acceptance?.simulation ? '真实求解器全电路仿真' : '未跑（不可执行 ≠ 通过）')}
              {acceptanceResult.savedSimulation ? <> · 证据已落盘 <code>{acceptanceResult.savedSimulation.digest.slice(0, 12)}</code></> : null}</p>
            {acceptanceResult.acceptance?.designChecks?.results?.length ? (
              <ul>{acceptanceResult.acceptance.designChecks.results.map((item) => <li key={item.id}>{item.title}：<strong>{item.status}</strong></li>)}</ul>
            ) : null}
          </div>
        ) : simLatest ? (
          <div className="detail-block"><span>最新落盘证据</span><p>摘要 <CopyValue value={simLatest.digest} label="仿真证据摘要" display={`${simLatest.digest.slice(0, 16)}…`} /> · <CopyValue value={simLatest.path} label="仿真证据路径" /> · {new Date(simLatest.savedAt).toLocaleString('zh-CN')}</p></div>
        ) : <div className="empty-inline"><Activity size={24} /><strong>还没有仿真证据</strong><span>需要本机 SPICE 求解器且 EDA 能导出仿真网表；缺任何一项都会明确报不可执行。</span></div>}
      </Panel>

      <Panel
        eyebrow="EDA BRIDGE"
        title="桥连接状态（ERC 逐条明细依赖 EDA 检查面板）"
        meta={bridgeStatus.busy ? <Badge tone="info">探测中</Badge> : !bridgeStatus.checkedAt ? <Badge tone="neutral">尚未探测</Badge> : bridgeStatus.error ? <Badge tone="danger">未连接</Badge> : bridgeStatus.windows.length ? <Badge tone="success">{bridgeStatus.windows.length} 个 EDA 窗口</Badge> : <Badge tone="warning">未发现 EDA 窗口</Badge>}
        actions={<Button icon={<RefreshCw size={15} />} loading={bridgeStatus.busy} disabled={bridgeStatus.busy || state.runtime.mode === 'demo'} title={state.runtime.mode === 'demo' ? 'DEMO 模式无法连真机' : '重新调用 /api/eda/discover + /api/eda/windows；断线恢复后重新发现桥。失败会如实报运行时错误码'} onClick={() => void refreshBridgeStatus()}>重新连接 / 重新发现桥</Button>}
      >
        <div className="inline-alert inline-alert--info"><span>桥断线后，运行时的 <code>/api/eda/windows</code>、<code>/api/eda/session</code> 会做一次惰性重新发现；这里展示的是<strong>最近一次探测</strong>的事实。失败只显示错误码，不会假装已连接，也不影响已完成证据的只读查看。</span></div>
        {bridgeStatus.error ? <div className="inline-alert inline-alert--danger" data-testid="bridge-error"><XCircle size={16} /><span>重新发现桥失败：<code>{bridgeStatus.error}</code>。请确认嘉立创 EDA 已启动、Bridge 扩展已加载，再点“重新连接 / 重新发现桥”。</span></div> : null}
        <div className="stats-grid stats-grid--4">
          <Stat label="桥端口" value={bridgeStatus.port ?? '—'} hint={bridgeStatus.port ? '已发现本机 EDA Bridge' : '尚无已发现端口'} tone={bridgeStatus.port ? 'success' : 'warning'} />
          <Stat label="EDA 窗口" value={bridgeStatus.windows.length} hint={bridgeStatus.selectionRequired ? '多个窗口：需先选择目标窗口' : bridgeStatus.windows.length ? '已自动绑定唯一窗口' : 'EDA 未启动或桥未就绪'} tone={bridgeStatus.windows.length ? 'success' : 'warning'} />
          <Stat label="目标窗口" value={bridgeStatus.windows.find((item) => item.windowId === bridgeStatus.selectedWindowId)?.title || bridgeStatus.selectedWindowId?.slice(0, 12) || '未选择'} hint={bridgeStatus.selectionRequired ? '多个 EDA 窗口，需在「EDA 控制」页选择' : 'ERC 明细只从当前活动窗口抓取'} />
          <Stat label="最近探测" value={bridgeStatus.checkedAt ? new Date(bridgeStatus.checkedAt).toLocaleTimeString('zh-CN') : '未探测'} hint="点击右侧按钮会重新 discover + windows" />
        </div>
        {bridgeStatus.windows.length ? (
          <ul>{bridgeStatus.windows.map((item) => <li key={item.windowId}><code>{item.windowId.slice(0, 12)}</code> · {item.title || item.documentName || item.projectName || '未命名窗口'}{item.windowId === bridgeStatus.selectedWindowId ? '（当前目标）' : ''}</li>)}</ul>
        ) : null}
      </Panel>

      <Panel
        eyebrow="SCHEMATIC ERC"
        title="原理图 ERC 收敛（只读取证）"
        meta={ercRunning ? <Badge tone="info">运行中</Badge> : ercResult ? <Badge tone={ercResult.summary.errorsOpen ? 'danger' : 'success'}>{ercResult.summary.errorsOpen ? `仍有 ${ercResult.summary.errorsOpen} 个错误` : '无错误'}</Badge> : ercLatest ? <Badge tone="success">已有证据 {ercLatest.digest.slice(0, 12)}</Badge> : <Badge tone="neutral">未取证</Badge>}
        actions={<>
          <Button variant="primary" icon={<Activity size={15} />} loading={ercTask?.status === 'running'} disabled={ercRunning || state.runtime.mode === 'demo'} title={state.runtime.mode === 'demo' ? 'DEMO 模式无法连真机' : '只读：执行 EDA ERC → 归一化 → 套用豁免 → 落盘'} onClick={runErc}>运行 ERC 取证</Button>
          <Button icon={<RefreshCw size={15} />} disabled={ercRunning} onClick={() => void loadLatestErc()}>载入最新 ERC</Button>
        </>}
      >
        <div className="inline-alert inline-alert--info"><span>ERC 是<strong>只读</strong>取证：不连线、不写图。EDA 只返回聚合计数时会明确标"无逐条明细"，不能当逐条修复依据；豁免必须写理由，缺理由会被服务端拒绝。</span></div>
        {ercError ? <div className="inline-alert inline-alert--danger"><XCircle size={16} /><span>{ercError}</span></div> : null}
        {(() => {
          const report = ercResult?.report || ercLatest?.payload?.report || null;
          if (!report) {
            return <div className="empty-inline"><Activity size={24} /><strong>还没有 ERC 证据</strong><span>真机运行后会把归一化报告落盘；放行前至少要有一次"错误=0 或逐条豁免"的结论。</span></div>;
          }
          const summary = ercResult?.summary;
          const open = report.openCounts || report.counts;
          return (
            <div className="detail-stack">
              <div className="row-actions">
                <Badge tone={report.ran ? 'success' : 'danger'}>{report.ran ? '已运行' : '未运行'}</Badge>
                <Badge tone={report.aggregateOnly ? 'warning' : 'neutral'}>{report.aggregateOnly ? '仅聚合计数（无逐条明细）' : '含逐条明细'}</Badge>
                {summary?.invalidExemptions ? <Badge tone="danger">{summary.invalidExemptions} 条豁免无效</Badge> : null}
              </div>
              <div className="stats-grid stats-grid--4">
                <Stat label="错误（未豁免）" value={open.error + open.fatal} hint={`fatal ${open.fatal} / error ${open.error}；ERC 错误不为 0 不能声明收敛`} tone={open.error + open.fatal ? 'danger' : 'success'} />
                <Stat label="警告（未豁免）" value={open.warning} hint="警告要逐条有结论（修复或豁免）" tone={open.warning ? 'warning' : 'success'} />
                <Stat label="信息（未豁免）" value={open.info} hint="信息级也要确认不是真实缺陷" />
                <Stat label="证据摘要" value={<code>{report.digest.slice(0, 12)}</code>} hint={ercResult?.saved ? new Date(ercResult.saved.savedAt).toLocaleString('zh-CN') : ercLatest ? new Date(ercLatest.savedAt).toLocaleString('zh-CN') : '未落盘'} />
              </div>
              <ErcDetailEvidence report={report} ercDetail={ercResult?.ercDetail ?? ercLatest?.payload?.ercDetail ?? null} onCreateFixTask={createErcFixTask} />
              <div className="row-actions">
                <Badge tone={ercExemptions.length ? 'warning' : 'neutral'}>{ercExemptions.length} 条待保存豁免</Badge>
                {ercExemptionInfo?.path ? <CopyValue value={ercExemptionInfo.path} label="ERC 豁免清单路径" /> : null}
                <Button size="sm" icon={<Sparkles size={13} />} disabled={ercExemptionBusy} onClick={seedErcExemptionTemplate}>按报告生成豁免草稿</Button>
                <Button size="sm" icon={<RefreshCw size={13} />} loading={ercExemptionBusy} disabled={ercExemptionBusy} onClick={() => void loadErcExemptions()}>载入已存豁免</Button>
                <Button size="sm" variant="primary" icon={<ShieldCheck size={13} />} loading={ercExemptionBusy} disabled={ercExemptionBusy || !ercExemptions.length} onClick={() => void saveErcExemptions()}>保存 ERC 豁免</Button>
              </div>
              {ercExemptionInfo?.invalid?.length ? <div className="inline-alert inline-alert--danger"><XCircle size={16} /><span>文件里已有 {ercExemptionInfo.invalid.length} 条无效豁免（理由/字段不全，服务端不会应用它们）。</span></div> : null}
              {ercExemptions.length ? (
                <TableFrame label="ERC 豁免（理由必须手工写清；保存后下次取证生效）">
                  <table>
                    <thead><tr><th>#</th><th>Code</th><th>对象（空=该 code 全部）</th><th>理由</th><th></th></tr></thead>
                    <tbody>
                      {ercExemptions.map((row, index) => (
                        <tr key={`${row.code}-${index}`}>
                          <td>{index + 1}</td>
                          <td><input className="input" value={row.code} onChange={(event) => setErcExemptions((current) => current.map((item, i) => i === index ? { ...item, code: event.target.value } : item))} aria-label={`ERC豁免${index + 1}代码`} /></td>
                          <td><input className="input" value={row.object} onChange={(event) => setErcExemptions((current) => current.map((item, i) => i === index ? { ...item, object: event.target.value } : item))} aria-label={`ERC豁免${index + 1}对象`} /></td>
                          <td><textarea className="input" rows={2} value={row.reason} onChange={(event) => setErcExemptions((current) => current.map((item, i) => i === index ? { ...item, reason: event.target.value } : item))} placeholder="为什么可以接受这个风险（样机用途/器件要求…）" aria-label={`ERC豁免${index + 1}理由`} /></td>
                          <td><Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setErcExemptions((current) => current.filter((_, i) => i !== index))}>删除</Button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              ) : null}
            </div>
          );
        })()}
      </Panel>
      <Panel
        eyebrow="SUPPLY EVIDENCE"
        title="价格与库存证据（查询时刻快照）"
        meta={pricingEvidence ? `${pricingEvidence.summary.priced}/${pricingEvidence.summary.requested} 有价格 · ${pricingEvidence.checkedAt || '无时间戳'}` : '未刷新'}
        actions={<Button variant="primary" icon={<RefreshCw size={15} />} loading={pricingBusy} disabled={pricingBusy || state.runtime.mode === 'demo'} title={state.runtime.mode === 'demo' ? 'DEMO 模式不联网询价' : '按当前 BOM 的 LCSC 料号在线查询'} onClick={() => void refreshPricing()}>刷新价格/库存</Button>}
      >
        <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>价格/库存是<strong>查询时刻</strong>的证据：查不到就是 unknown（不是 0 元、不是"免费"）。刷新后请<strong>重新运行下方闸门</strong>，供应链警告才会按这份证据重算；下单仍然由人工完成，系统不代下单、不支付。</span></div>
        {pricingError ? <div className="inline-alert inline-alert--danger"><XCircle size={16} /><span>{pricingError}</span></div> : null}
        {pricingEvidence ? (
          <div className="detail-stack">
            <div className="stats-grid stats-grid--4">
              <Stat label="查询料号" value={pricingEvidence.summary.requested} hint="仅精确 C 编号" />
              <Stat label="有价格证据" value={pricingEvidence.summary.priced} hint={`币种 ${[...new Set(pricingEvidence.entries.map((item) => item.currency).filter(Boolean))].join('/') || '—'}`} tone="success" />
              <Stat label="无证据" value={pricingEvidence.summary.unknown} hint="unknown ≠ 0 元" tone={pricingEvidence.summary.unknown ? 'warning' : 'neutral'} />
              <Stat label="查询时间" value={<small>{pricingEvidence.checkedAt ? new Date(pricingEvidence.checkedAt).toLocaleString('zh-CN') : '未知'}</small>} hint={pricingEvidence.freshnessKnown ? '全部条目带时间' : '部分条目缺时间'} tone={pricingEvidence.freshnessKnown ? 'success' : 'warning'} />
            </div>
            {pricingEvidence.entries.length ? (
              <TableFrame label="有价格的料号">
                <table><thead><tr><th>LCSC</th><th>单价</th><th>库存</th><th>时间</th></tr></thead><tbody>
                  {pricingEvidence.entries.map((entry) => <tr key={entry.lcsc}><td><code>{entry.lcsc}</code></td><td>{entry.price ?? '—'} {entry.currency || ''}</td><td>{entry.stock ?? '未知'}</td><td><small>{entry.checkedAt ? new Date(entry.checkedAt).toLocaleString('zh-CN') : '—'}</small></td></tr>)}
                </tbody></table>
              </TableFrame>
            ) : null}
            {pricingEvidence.unknownEntries.length ? (
              <div className="risk-box"><strong>没有价格证据的料号（下单前需人工核实）</strong>{pricingEvidence.unknownEntries.slice(0, 20).map((entry, index) => <p key={`${entry.lcsc || 'unknown'}-${index}`}>• {entry.lcsc || '未知料号'} — {entry.reason || '未知原因'}{entry.detail ? `：${entry.detail}` : ''}</p>)}</div>
            ) : null}
          </div>
        ) : <div className="empty-inline"><RefreshCw size={24} /><strong>尚未查询价格/库存</strong><span>点击“刷新价格/库存”按当前 BOM 的 C 编号在线查询；无证据时闸门只会给 warning，不会伪造价格。</span></div>}
      </Panel>

      <Panel
        eyebrow="FABRICATION RELEASE GATE"
        title="下单前闸门（真实证据）"
        meta={gate ? <Badge tone={summarizeGate(gate).tone}>{summarizeGate(gate).headline}</Badge> : <Badge tone="neutral">尚未运行</Badge>}
        actions={<Button variant="primary" icon={<ShieldCheck size={15} />} loading={gateRunning} disabled={gateRunning || state.runtime.mode === 'demo'} title={state.runtime.mode === 'demo' ? 'DEMO 模式没有真实证据：闸门只会给出“证据缺失/阻断”' : '用真实运行时的证据跑放行闸门'} onClick={runReleaseGate}>运行下单前闸门</Button>}
      >
        <div className="form-grid">
          <Field label="PCB UUID" hint="留空 = 当前打开的 PCB"><input className="input" value={gatePcb} onChange={(event) => setGatePcb(event.target.value)} placeholder="留空 = 当前打开的 PCB" /></Field>
          <Field label="原理图页面 UUID" hint="留空 = 当前打开的原理图；给了就由运行时打开它"><input className="input" value={gatePage} onChange={(event) => setGatePage(event.target.value)} placeholder="留空 = 当前打开的原理图" /></Field>
          <Field label="产物目录" hint="Gerber/BOM/CPL/STEP 所在目录"><input className="input" value={gateDir} onChange={(event) => setGateDir(event.target.value)} /></Field>
          <Field label="DRC 报告路径" hint="可先用上方“PCB DRC 一键取证”自动填入；留空则按没有证据阻断"><input className="input" value={gateDrcPath} onChange={(event) => setGateDrcPath(event.target.value)} /></Field>
        </div>
        <details className="detail-block">
          <summary><strong>A1 需求硬约束</strong>：{hardConfirmedRequirements.length} 条已确认硬需求将参与闸门；设计事实 {[designFactsDraft.widthMm, designFactsDraft.heightMm, designFactsDraft.powerTotalMa, designFactsDraft.gpioAvailable, designFactsDraft.interfaces, designFactsDraft.maxTemperatureC].filter((item) => item.trim()).length}/6 已填</summary>
          <p><small>空着的设计事实 = 拿不到事实 ≠ 通过：对应约束会以 <code>unknown</code> 阻断放行。数值要来自实测/读回，不要填目标值。</small></p>
          <div className="form-grid">
            <Field label="板框宽 mm" hint="实测/读回值"><input className="input" value={designFactsDraft.widthMm} onChange={(event) => setDesignFactsDraft({ ...designFactsDraft, widthMm: event.target.value })} placeholder="例如 60" /></Field>
            <Field label="板框高 mm" hint="实测/读回值"><input className="input" value={designFactsDraft.heightMm} onChange={(event) => setDesignFactsDraft({ ...designFactsDraft, heightMm: event.target.value })} placeholder="例如 40" /></Field>
            <Field label="总电流 mA" hint="预算比对用实测/估算合计"><input className="input" value={designFactsDraft.powerTotalMa} onChange={(event) => setDesignFactsDraft({ ...designFactsDraft, powerTotalMa: event.target.value })} placeholder="例如 800" /></Field>
            <Field label="可用 GPIO 数" hint="来自 MCU 读回/数据手册"><input className="input" value={designFactsDraft.gpioAvailable} onChange={(event) => setDesignFactsDraft({ ...designFactsDraft, gpioAvailable: event.target.value })} placeholder="例如 12" /></Field>
            <Field label="接口清单" hint="逗号/顿号分隔，例如 USB、I2C、UART"><input className="input" value={designFactsDraft.interfaces} onChange={(event) => setDesignFactsDraft({ ...designFactsDraft, interfaces: event.target.value })} placeholder="USB、I2C" /></Field>
            <Field label="最高工作温度 °C" hint="环境/器件上限实测"><input className="input" value={designFactsDraft.maxTemperatureC} onChange={(event) => setDesignFactsDraft({ ...designFactsDraft, maxTemperatureC: event.target.value })} placeholder="例如 60" /></Field>
          </div>
          {hardConfirmedRequirements.length ? <p><small>将参与比对的需求：{hardConfirmedRequirements.slice(0, 8).map((item) => `${item.name}${item.value ? `=${item.value}${item.unit || ''}` : ''}`).join('；')}{hardConfirmedRequirements.length > 8 ? ` 等 ${hardConfirmedRequirements.length} 条` : ''}</small></p> : <p><small>当前没有已确认的硬需求：闸门会记录“未提供结构化硬约束”，不代表约束已满足。</small></p>}
        </details>
        <div className="toggle-row"><input type="checkbox" checked={gateConfirmed} onChange={(event) => setGateConfirmed(event.target.checked)} /><span>我已在嘉立创EDA 中人工确认过布局与器件位置</span></div>
        <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>闸门只负责把证据摆全：任何一项证据缺失都会显示为"证据缺失/阻断"，不会因为没报错就算通过。下单永远需要人签字。若原理图闸门报"证据缺失/网表 0 个器件"，说明 EDA 里没打开原理图——请先去"EDA 控制"打开原理图，或在这里填入原理图页面 UUID 让运行时替你打开。</span></div>
        {gate ? (
          <div className="detail-stack">
            <div className="stats-grid stats-grid--4">
              <Stat label="裁决" value={gate.verdict === 'blocked' ? '不能下单' : gate.verdict === 'ready-with-warnings' ? '可下单(有警告)' : '可以下单'} hint={`ready=${String(gate.ready)}`} tone={summarizeGate(gate).tone} />
              <Stat label="阻断" value={gate.blockers.length} hint="必须修或按规则处理" tone={gate.blockers.length ? 'danger' : 'success'} />
              <Stat label="警告" value={gate.warnings.length} hint="可带警告放行" tone={gate.warnings.length ? 'warning' : 'neutral'} />
              <Stat label="设计指纹" value={<code>{gate.fingerprint.sha256.slice(0, 12)}</code>} hint={new Date(gate.generatedAt).toLocaleString('zh-CN')} />
            </div>
            {gate.releaseDecision ? (
              <div className={gate.releaseDecision.ready ? 'validation-summary' : 'inline-alert inline-alert--warning'}>
                <Badge tone={gate.releaseDecision.ready ? 'success' : 'danger'}>{gate.releaseDecision.ready ? '统一裁决：可放行' : '统一裁决：不可放行'}</Badge>
                <div>
                  <strong>{gate.releaseDecision.reason}</strong>
                  {gate.releaseDecision.blockedBy.length ? <p>阻断项：{gate.releaseDecision.blockedBy.join('、')}</p> : null}
                  <p><small>此裁决已合并本地门禁与人工证据（在线 DFM / 终审签核）；<strong>自动下单 / 支付永久禁用</strong>，正式放行仍需人工签发。</small></p>
                  <details>
                    <summary>查看统一裁决明细（本地 {gate.releaseDecision.gates.filter((item) => item.scope === 'local').length} 项 / 人工 {gate.releaseDecision.gates.filter((item) => item.scope === 'manual').length} 项）</summary>
                    <ul>
                      {gate.releaseDecision.gates.map((item) => (
                        <li key={item.id}><strong>{item.title}</strong>：{item.passed ? '通过' : (item.reason || '未通过')}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              </div>
            ) : null}
            <TableFrame label="闸门状态">
              <table>
                <thead><tr><th>闸门</th><th>状态</th><th>阻断项</th><th>证据摘要</th></tr></thead>
                <tbody>
                  {gate.gates.map((section) => (
                    <tr key={section.id}>
                      <td><strong>{section.title}</strong><small>{section.id}</small></td>
                      <td><Badge tone={gateStatusTone(section.status)}>{gateStatusLabel(section.status)}</Badge></td>
                      <td>{section.blockingCount}</td>
                      <td><small>{section.findings.slice(0, 2).map((finding) => finding.message).join('；') || '—'}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
            {(() => {
              // A1：逐条展示需求约束结论（pass/fail/unknown/unclassified），unknown 也是阻断，不给“默认通过”。
              const constraintsGate = gate.gates.find((section) => section.id === 'constraints');
              const rows = Array.isArray(constraintsGate?.evidence?.report) ? constraintsGate.evidence.report as Array<Record<string, unknown>> : [];
              if (!rows.length) return null;
              return (
                <TableFrame label="A1 需求硬约束逐条结论">
                  <table>
                    <thead><tr><th>约束</th><th>结论</th><th>说明</th></tr></thead>
                    <tbody>
                      {rows.map((row, index) => {
                        const status = String(row.status || 'unknown');
                        return (
                          <tr key={`${String(row.id || row.name || index)}-${index}`}>
                            <td><strong>{String(row.name || row.id || '约束')}</strong><small>{String(row.raw || row.type || '')}</small></td>
                            <td><Badge tone={status === 'pass' ? 'success' : status === 'fail' ? 'danger' : status === 'unknown' ? 'warning' : 'neutral'}>{status}</Badge></td>
                            <td><small>{String(row.message || '')}</small></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableFrame>
              );
            })()}
            {(() => {
              const decision = summarizeOutputDecision(gate.outputDecision);
              return (
                <div className={decision.tone === 'success' ? 'validation-summary' : 'inline-alert inline-alert--warning'}>
                  <Badge tone={decision.tone}>{decision.tone === 'danger' ? '禁止正式导出' : decision.tone === 'success' ? '允许正式导出' : decision.tone === 'warning' ? '仅限草稿' : '未裁决'}</Badge>
                  <div>
                    <strong>{decision.headline}</strong>
                    <p>{decision.detail}</p>
                    {decision.naming ? <p><code>{decision.naming}</code></p> : null}
                    {decision.fix.length ? <ul>{decision.fix.map((line) => <li key={line}>{line}</li>)}</ul> : null}
                    <div className="row-actions">
                      <Button variant="primary" icon={<Download size={15} />} loading={exporting === 'draft'} disabled={exporting !== null} onClick={() => runExport('draft')}>导出草稿文件（不得下单）</Button>
                      {(() => {
                        // 正式命名需要两把钥匙：本地门禁通过 + 统一裁决（含人工 DFM/签核）ready。
                        const localAllowed = gate.outputDecision?.allowed === true && gate.outputDecision.outputClass === 'final';
                        const formalAllowed = localAllowed && gate.releaseDecision?.ready === true;
                        const reason = formalAllowed
                          ? '门禁与人工证据齐备：可以按正式命名产出生产文件'
                          : localAllowed
                            ? `本地门禁已过，但人工放行证据未齐（${gate.releaseDecision?.blockedBy?.join('、') || '统一裁决缺失'}）：请先在“人工放行证据”登记在线 DFM 与三方签核，再重新运行闸门。`
                            : `门禁未通过，正式命名一律拒绝；修复后重跑闸门即可解锁。当前阻断：${(gate.outputDecision?.blockers?.length ? gate.outputDecision.blockers : ['RELEASE_BLOCKED']).join('、')}`;
                        return <Button icon={<ShieldAlert size={15} />} disabled={exporting !== null || !formalAllowed} title={reason} onClick={() => runExport('final')}>导出正式生产文件</Button>;
                      })()}
                    </div>
                    <LongTaskPanel
                      title="导出长任务（D8：取消只停止本页等待）"
                      snapshot={exportTask}
                      onCancel={exporting ? cancelExport : undefined}
                      onRetry={() => void runExport(lastExportRequestedRef.current)}
                      cancelLabel="停止等待导出"
                      retryLabel="重新导出"
                    />
                    <div className="row-actions">
                      <Button icon={<ShieldCheck size={15} />} loading={archiveTask?.status === 'running'} disabled={exporting !== null || !gate.ready || gate.releaseDecision?.ready !== true} title={gate.ready && gate.releaseDecision?.ready === true ? '记录将绑定门禁/裁决/人工证据与证据文件 sha256，创建后不可编辑' : '只有放行真正 ready（本地门禁 + 人工 DFM/签核）才能归档发布版本'} onClick={() => void archiveReleaseVersion()}>归档为发布版本（B8）</Button>
                      {archiveResult ? <small>已归档 <code>{archiveResult.releaseId}</code> · 证据重校验 {archiveResult.verification.verified ? '通过' : '失败'}（追溯页可查看）</small> : null}
                    </div>
                  </div>
                </div>
              );
            })()}
            {exportResult ? (
              <div className="finding-detail">
                <div className="finding-detail__head">
                  <Badge tone={exportResult.exported ? (exportResult.manifest?.released ? 'success' : 'warning') : 'danger'}>
                    {exportResult.exported ? (exportResult.manifest?.released ? '已放行' : '草稿已落盘') : '未产出'}
                  </Badge>
                  <code>{exportResult.code || exportResult.manifest?.decisionTicket || 'PRODUCTION_EXPORT'}</code>
                  <Button size="sm" icon={<Download size={13} />} onClick={downloadExportManifest}>导出清单 CSV</Button>
                </div>
                <h3>生产文件产出结果</h3>
                <div className="detail-block"><span>{exportResult.outDir || '未写盘'}</span><p>{exportResult.message}</p></div>
                {exportResult.releaseDecision ? (
                  <div className="detail-block"><span>放行统一裁决</span><p><Badge tone={exportResult.releaseDecision.ready ? 'success' : 'danger'}>{exportResult.releaseDecision.ready ? '可放行' : '不可放行'}</Badge> {exportResult.releaseDecision.reason}{exportResult.releaseDecision.blockedBy.length ? ` · 阻断：${exportResult.releaseDecision.blockedBy.join('、')}` : ''}</p></div>
                ) : null}
                {exportResult.files?.length ? (
                  <TableFrame label="生产文件清单">
                    <table>
                      <thead><tr><th>种类</th><th>文件</th><th>大小</th><th>SHA-256</th><th></th></tr></thead>
                      <tbody>
                        {exportResult.files.map((file) => (
                          <tr key={file.path}><td>{file.kind}</td><td><code>{file.name}</code></td><td>{file.bytes} B</td><td><CopyValue value={file.sha256} label={`${file.name} 的 SHA-256`} display={`${file.sha256.slice(0, 16)}…`} /></td><td><Button size="sm" icon={<Download size={13} />} onClick={() => void downloadArtifact(file.path, file.name)}>下载</Button></td></tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                ) : null}
                {exportResult.manifest?.verification ? (
                  <div className="detail-block">
                    <span>落盘后复核：{exportResult.manifest.verification.status === 'pass' ? '通过' : '未通过'}（{exportResult.manifest.verification.blockingCount ?? 0} 条阻断）</span>
                    <p>{(exportResult.manifest.verification.findings || []).map((finding) => finding.message).join('；') || '内容与实机读回一致'}</p>
                    {exportResult.manifest.verification.waived?.length ? <p>按产出类别豁免 {exportResult.manifest.verification.waived.length} 条：{exportResult.manifest.verification.waived.map((item) => `${item.code}（${item.why}）`).join('；')}</p> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {groupBlockers(gate).map((group) => (
              <div className="finding-detail" key={group.title}>
                <div className="finding-detail__head"><Badge tone="danger">阻断</Badge><code>{group.items[0].code}</code></div>
                <h3>{group.title}</h3>
                <div className="detail-block"><span>共 {group.items.length} 条</span><p>{group.items.slice(0, 2).map((item) => item.message).join('；')}</p></div>
              </div>
            ))}
            {gate.warnings.length ? (
              <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>警告：{gate.warnings.map((warning) => warning.message).join('；')}</span></div>
            ) : null}
            <div className="row-actions"><Button onClick={() => { window.location.hash = 'validation/placement'; }} icon={<Crosshair size={14} />}>去布局微调</Button><Button variant="ghost" onClick={() => navigate('eda')}>打开 EDA 控制页</Button></div>
          </div>
        ) : <div className="empty-inline"><ShieldCheck size={25} /><strong>尚未运行门禁</strong><span>运行后这里会列出六道闸门、阻断原因与设计指纹。</span></div>}
        <LongTaskPanel title="发布归档长任务（D8：取消只停止本页等待）" snapshot={archiveTask} onCancel={archiveTask?.status === 'running' ? () => archiveTaskRef.current?.cancelTask() : undefined} onRetry={() => void archiveReleaseVersion()} cancelLabel="停止等待归档" retryLabel="重新归档" />
      </Panel>

      <Panel
        eyebrow="MANUAL EVIDENCE"
        title="人工放行证据（在线 DFM / 终审签核）"
        meta="只登记人工结论并落盘；不能替代本地门禁"
        actions={<Button icon={<RefreshCw size={15} />} disabled={manualBusy !== null} onClick={() => void loadManualEvidence()}>刷新人工证据</Button>}
      >
        <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>本地 DRC / 仿真<strong>不能冒充在线 DFM</strong>；签核必须绑定物料清单哈希。保存后请重新运行上方闸门，统一裁决才会把新证据算进去。自动下单 / 支付永久禁用。</span></div>
        <div className="form-grid">
          <div className="detail-block">
            <span>① 在线 DFM 回填（人工登录嘉立创完成 DFM 后登记）</span>
            <Field label="结论"><select className="input" value={dfmPassed} onChange={(event) => setDfmPassed(event.target.value === 'fail' ? 'fail' : 'pass')} aria-label="DFM 结论"><option value="pass">通过（无阻断）</option><option value="fail">不通过（有阻断）</option></select></Field>
            <Field label="操作人" required hint="人工行为必须留名"><input className="input" value={dfmOperator} onChange={(event) => setDfmOperator(event.target.value)} placeholder="例如：王工" /></Field>
            <Field label="结论说明"><input className="input" value={dfmConclusion} onChange={(event) => setDfmConclusion(event.target.value)} placeholder="例如：线宽/间距/孔环均通过，无阻断" /></Field>
            <Field label="语义计划哈希" hint="可留空；若走生产放行 readiness，必须填与语义计划一致的哈希；PCB UUID 取上方闸门里的值用于绑定"><input className="input" value={dfmPlanHash} onChange={(event) => setDfmPlanHash(event.target.value)} placeholder="留空 = 不绑定计划" /></Field>
            <div className="row-actions"><Button variant="primary" loading={manualBusy === 'dfm'} disabled={manualBusy !== null || state.runtime.mode === 'demo'} onClick={() => void submitDfm()}>保存 DFM 证据</Button>{dfmEvidence ? <Badge tone={dfmEvidence.payload.passed ? 'success' : 'warning'}>已登记 {dfmEvidence.digest.slice(0, 12)}</Badge> : <Badge tone="neutral">未登记</Badge>}</div>
          </div>
          <div className="detail-block">
            <span>② 人工终审签核（三方签字，绑定物料清单）</span>
            <Field label="物料清单哈希" required hint="来自产物清单 manifestHash"><input className="input" value={signoffManifest} onChange={(event) => setSignoffManifest(event.target.value)} placeholder="manifestHash" /></Field>
            <Field label="语义计划哈希" hint="可留空；填写时 readiness 会校验绑定"><input className="input" value={signoffPlanHash} onChange={(event) => setSignoffPlanHash(event.target.value)} placeholder="留空 = 不绑定计划" /></Field>
            <div className="form-grid">
              <Field label="硬件设计" required><input className="input" value={signoffNames[0]} onChange={(event) => setSignoffNames([event.target.value, signoffNames[1], signoffNames[2]])} placeholder="姓名" /></Field>
              <Field label="制造工艺" required><input className="input" value={signoffNames[1]} onChange={(event) => setSignoffNames([signoffNames[0], event.target.value, signoffNames[2]])} placeholder="姓名" /></Field>
              <Field label="项目负责人" required><input className="input" value={signoffNames[2]} onChange={(event) => setSignoffNames([signoffNames[0], signoffNames[1], event.target.value])} placeholder="姓名" /></Field>
            </div>
            <div className="row-actions"><Button variant="primary" loading={manualBusy === 'signoff'} disabled={manualBusy !== null || state.runtime.mode === 'demo'} onClick={() => void submitSignoff()}>记录三方签核</Button>{signoffEvidence ? <Badge tone="success">已签核 {signoffEvidence.digest.slice(0, 12)}</Badge> : <Badge tone="neutral">未签核</Badge>}</div>
          </div>
        </div>
        <div className="row-actions">
          <Badge tone={dfmEvidence?.payload.passed ? 'success' : dfmEvidence ? 'danger' : 'neutral'}>在线 DFM：{dfmEvidence ? (dfmEvidence.payload.passed ? '通过' : '不通过') : '无证据'}</Badge>
          <Badge tone={signoffEvidence?.payload.passed ? 'success' : 'neutral'}>终审签核：{signoffEvidence ? `${signoffEvidence.payload.roles?.length ?? 0} 方` : '无证据'}</Badge>
          <small>证据文件由运行时写入证据目录（默认 artifacts/evidence/），可脱离本页面复核。</small>
        </div>
      </Panel>

      <Panel
        eyebrow="3D MODEL"
        title="3D 模型导出（STEP / GLB）"
        meta="落盘自证：字节数、sha256、分片数；GLB 不可得时明确报错"
        actions={<Button variant="primary" icon={<Download size={15} />} loading={model3dTask?.status === 'running'} disabled={modelBusy || state.runtime.mode === 'demo'} onClick={() => void export3d()}>导出 3D 模型</Button>}
      >
        <div className="form-grid">
          <Field label="格式" hint="STEP 是装配体；GLB 依赖 EDA 官方 API，可能不可得（不可得会明确失败，不伪造）">
            <select className="input" value={modelFormat} onChange={(event) => setModelFormat(event.target.value === 'glb' ? 'glb' : 'step')} aria-label="3D 模型格式"><option value="step">STEP（装配体）</option><option value="glb">GLB（官方 API 可用时）</option></select>
          </Field>
          <Field label="PCB UUID" hint="留空 = 当前打开的 PCB"><input className="input" value={gatePcb} onChange={(event) => setGatePcb(event.target.value)} placeholder="留空 = 当前打开的 PCB" /></Field>
        </div>
        {model3d ? (
          <div className="detail-stack">
            <div className="stats-grid stats-grid--4">
              <Stat label="格式" value={model3d.format.toUpperCase()} hint={`分片 ${model3d.chunks}`} tone="success" />
              <Stat label="大小" value={`${(model3d.bytes / 1024 / 1024).toFixed(2)} MB`} hint={model3d.elements ? `${model3d.elements} 个元素` : '元素数未知'} />
              <Stat label="sha256" value={<code>{model3d.sha256.slice(0, 12)}</code>} hint="落盘后自证" />
              <Stat label="路径" value={<small>{model3d.path.split('/').pop()}</small>} hint={model3d.path} />
            </div>
            <div className="row-actions"><Button icon={<Download size={15} />} onClick={() => void downloadArtifact(model3d.path, model3d.path.split('/').pop() || '3d-model')}>下载 3D 模型</Button></div>
            <div className="detail-block"><span>产物路径</span><code>{model3d.path}</code></div>
          </div>
        ) : <div className="empty-inline"><Download size={24} /><strong>尚未导出 3D 模型</strong><span>导出后这里会显示真实字节数与 sha256；失败会给出明确错误码。</span></div>}
        <LongTaskPanel title="3D 导出长任务（D8：取消只停止本页等待）" snapshot={model3dTask} onCancel={model3dTask?.status === 'running' ? () => model3dTaskRef.current?.cancelTask() : undefined} onRetry={() => void export3d()} cancelLabel="停止等待导出" retryLabel="重新导出" />
      </Panel>

      <Panel
        eyebrow="PCB SYNC VERIFY"
        title="原理图 → PCB 同步验收"
        meta="只读判定：原理图要上板的器件 vs PCB 现况；差异没清零就不解锁自动布局"
        actions={
          <div className="row">
            <Button variant="primary" icon={<ShieldAlert size={15} />} loading={syncRunning} disabled={syncRunning} onClick={runPcbSyncVerify} title="回读嘉立创EDA 真机数据做判定：全程只读，不写任何东西">回读验收</Button>
          </div>
        }
      >
        <p className="muted">
          真机边界（第 20–23 轮共 9 次实验）：嘉立创EDA 的公开 API <strong>不能新增 PCB 器件</strong>
          （变更导入空转返回成功、图元 create 内部依赖不可达、源码通道只能改写不能新增），
          所以落板必须由 EDA 原生能力完成。这一步只做两件事：如实判定差异，并给出可照做的下一步。
        </p>
        {syncError ? <div className="inline-alert inline-alert--warning">{syncError}</div> : null}
        {syncVerify ? (
          <>
            <div className={syncVerify.ready ? 'inline-alert inline-alert--success' : 'inline-alert inline-alert--warning'}>
              {syncVerify.ready
                ? `已一致：原理图 ${syncVerify.schematicCount} 个器件，PCB ${syncVerify.pcbCount} 个，可以继续自动布局。`
                : `未通过：原理图要上板 ${syncVerify.schematicCount} 个，PCB 只有 ${syncVerify.pcbCount} 个。`}
            </div>
            <p className="muted">
              {syncVerify.missing.length ? `缺：${syncVerify.missing.join('、')}；` : ''}
              {syncVerify.extra.length ? `多：${syncVerify.extra.join('、')}；` : ''}
              {syncVerify.unannotated.length ? `未标注位号：${syncVerify.unannotated.join('、')}；` : ''}
              {syncVerify.guide}
            </p>
            {syncVerify.ready ? null : <p className="muted">自动布局：<strong>已锁定</strong>（差异清零后自动解锁）。</p>}
          </>
        ) : (
          <p className="muted">还没做验收：点"回读验收"读取真机数据。</p>
        )}
      </Panel>

      <Panel
        eyebrow="SCHEMATIC AUTO-REPAIR"
        title="自动修复原理图（缺 Rd / 缺 I2C 上拉）"
        meta="预演不写盘；执行是受控写入：写入 → 保存 → 网表复核 → 立刻重跑验收"
        actions={
          <div className="row">
            <Button variant="secondary" icon={<Sparkles size={15} />} loading={repairRunning === 'dry'} disabled={Boolean(repairRunning)} onClick={() => runSchematicRepair(true)} title="只读预演：检索真机库器件、算出要新增的元件与引脚，一条写命令都不发">预演修复计划</Button>
            <Button variant="primary" icon={<ShieldAlert size={15} />} loading={repairRunning === 'apply'} disabled={Boolean(repairRunning)} onClick={() => runSchematicRepair(false)} title="受控写入：会真的修改原理图并保存；复核不过会自动回滚">执行修复并验收</Button>
          </div>
        }
      >
        <p className="muted">
          这一步修的是<strong>验收已经指出来的设计缺陷</strong>：USB-C 灌端缺 Rd、I2C 总线缺上拉。
          元件来自嘉立创真机元件库（按阻值编码 5101/4701 检索），落位在现有图元包围盒下方的一排空位，避免压到别的元件造成引脚重合。
          两项都必须在原理图页面 UUID 已填或 EDA 已打开该原理图时才能执行。
        </p>
        <Field label="原理图页面 UUID（与下单前闸门共用）" hint="留空则用嘉立创EDA 当前活动文档；不是原理图会被拒绝">
          <input className="input" value={gatePage} onChange={(event) => setGatePage(event.target.value)} placeholder="d0787ce602b31e26" />
        </Field>
        {repair ? (
          <>
            <div className={repair.dryRun ? 'inline-alert inline-alert--info' : repair.acceptance?.ready ? 'inline-alert inline-alert--success' : 'inline-alert inline-alert--warning'}>
              {repair.dryRun
                ? repair.plan?.operations.length
                  ? `预演：将新增 ${repair.devices?.length ?? 0} 个元件 / ${repair.plan.operations.length} 步操作，尚未写盘。`
                  : `预演：不需要新增任何元件（${repair.skippedReason === 'ALREADY_SATISFIED' ? '这些网络已经跨着合格器件' : '没有可执行的修复项'}），尚未写盘。`
                : repair.skipped
                  ? `设计已经合格（${repair.plan?.satisfied?.length ?? 0} 项判定为已满足）：本次一个字节都没有写入。`
                  : repair.acceptance?.ready
                    ? '已写入并保存，网表复核通过，重跑验收通过。'
                    : '已写入并保存，但重跑验收未通过——请按下方发现处理，必要时回退。'}
            </div>
            {repair.plan?.satisfied?.length ? (
              <TableFrame label="幂等判定：这些网络已经有合适的器件，不再重复新增">
                <table>
                  <thead><tr><th>修复项</th><th>已有器件</th><th>阻值 / 型号</th><th>判定依据</th></tr></thead>
                  <tbody>
                    {repair.plan.satisfied.map((item) => (
                      <tr key={item.id}>
                        <td>{item.id}</td>
                        <td>{item.designator}</td>
                        <td>{[item.value, item.part].filter(Boolean).join(' / ') || '—'}</td>
                        <td>{item.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            ) : null}
            {repair.plan?.findings?.length && repair.dryRun ? (
              <div className="stack">
                {repair.plan.findings.map((finding, index) => (
                  <div key={`${finding.code}-${index}`} className="row">
                    <Badge tone={finding.severity === 'blocking' ? 'danger' : finding.severity === 'warning' ? 'warning' : 'neutral'}>{finding.code}</Badge>
                    <span>{finding.message}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {repair.devices?.length ? (
              <TableFrame label="修复清单（器件来自真机库）">
                <table>
                  <thead><tr><th>修复项</th><th>元件</th><th>连接</th><th>落位</th></tr></thead>
                  <tbody>
                    {repair.devices.map((device, index) => (
                      <tr key={`${device.id ?? index}`}>
                        <td>{device.id ?? `#${index + 1}`}</td>
                        <td>{device.mpn ?? '—'}</td>
                        <td>{device.net} → {device.otherNet}{device.valueOhm ? ` · ${device.valueOhm}Ω` : ''}</td>
                        <td>{device.position ? `${device.position.x}, ${device.position.y}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            ) : null}
            {repair.plan ? (
              <div className="stats-grid stats-grid--4">
                <Stat label="计划操作" value={String(repair.plan.operations.length)} />
                <Stat label="预期新增引脚" value={String(Object.values(repair.plan.expectedGain).reduce((sum, item) => sum + item, 0))} />
                {repair.plan.satisfied?.length ? <Stat label="已满足（不重复加）" value={String(repair.plan.satisfied.length)} /> : null}
                {repair.applied ? <Stat label="网表复核" value={repair.applied.diff.ok ? '通过' : '不通过'} /> : null}
                {repair.applied ? <Stat label="身份校验" value={repair.applied.diff.identityComplete ? '逐引脚核对' : '仅计数（位号未标注）'} /> : null}
                {repair.acceptance?.netlist ? <Stat label="修复后网表" value={`${repair.acceptance.netlist.components} 元件 / ${repair.acceptance.netlist.nets} 网络`} /> : null}
                {repair.acceptance ? <Stat label="验收" value={repair.acceptance.ready ? '通过' : '未通过'} /> : null}
              </div>
            ) : null}
            {repair.applied?.diff.gained ? (
              <TableFrame label="网表复核：每个网络新增了哪些引脚">
                <table>
                  <thead><tr><th>网络</th><th>新增引脚</th></tr></thead>
                  <tbody>
                    {Object.entries(repair.applied.diff.gained).map(([net, pins]) => (
                      <tr key={net}><td>{net}</td><td>{pins.join(', ')}</td></tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            ) : null}
            {repair.acceptance?.designChecks?.results.length ? (
              <TableFrame label="重跑验收：设计检查点与实测值">
                <table>
                  <thead><tr><th>设计检查点</th><th>判定</th><th>实测</th></tr></thead>
                  <tbody>
                    {repair.acceptance.designChecks.results.map((result) => (
                      <tr key={result.id}>
                        <td>{result.title}</td>
                        <td><Badge tone={result.status === 'pass' ? 'success' : result.status === 'fail' ? 'danger' : 'neutral'}>{result.status === 'pass' ? '通过' : result.status === 'fail' ? '不通过' : '未跑'}</Badge></td>
                        <td>{result.measured ? JSON.stringify(result.measured) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            ) : null}
            {repair.acceptance?.findings.length ? (
              <div className="stack">
                {repair.acceptance.findings.slice(0, 8).map((finding, index) => (
                  <div key={`${finding.code}-${index}`} className="row">
                    <Badge tone={finding.severity === 'blocking' ? 'danger' : finding.severity === 'warning' ? 'warning' : 'neutral'}>{finding.code}</Badge>
                    <span>{finding.message}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : <p className="muted">先点“预演修复计划”看清要动什么，再决定是否执行。</p>}
      </Panel>
      <Panel eyebrow="FABRICATION ORDER CARD" title="板厂下单参数卡（实测事实 vs 下单参数）" meta="只读核对；不下单、不支付、不猜价格" actions={<Button variant="primary" icon={<Factory size={15} />} loading={orderRunning} onClick={runOrderCard}>生成下单参数卡</Button>}>
        <div className="form-grid">
          <Field label="下单层数" hint="留空 = 用实测层数；填了就必须与实测一致"><input className="input" value={orderLayers} onChange={(event) => setOrderLayers(event.target.value)} placeholder="留空 = 实测" inputMode="numeric" /></Field>
          <Field label="数量" hint="用于报价与拼板参考"><input className="input" value={orderQuantity} onChange={(event) => setOrderQuantity(event.target.value)} inputMode="numeric" /></Field>
          <Field label="表面处理" hint="能力档之外的值会被阻断"><input className="input" value={orderFinish} onChange={(event) => setOrderFinish(event.target.value)} /></Field>
          <Field label="阻抗控制" hint="要求阻抗控制就需要板上有阻抗受控网络与叠层证据"><label className="checkbox-line"><input type="checkbox" checked={orderImpedance} onChange={(event) => setOrderImpedance(event.target.checked)} />需要板厂做阻抗控制</label></Field>
        </div>
        {orderCard ? (
          <div>
            <div className={orderCard.readyToOrder ? 'inline-alert inline-alert--success' : 'inline-alert inline-alert--warning'}>
              {orderCard.readyToOrder ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              <span><strong>{orderCard.readyToOrder ? '参数与文件已自洽' : `还不能下单（${orderCard.counts.blocking} 条阻断 / ${orderCard.counts.unknown} 条未确认）`}</strong> · {orderCard.nextStep}</span>
            </div>
            <div className="stats-grid stats-grid--4">
              <Stat label="实测尺寸" value={orderCard.derived.sizeMm ? `${orderCard.derived.sizeMm.x}×${orderCard.derived.sizeMm.y} mm` : '未读到'} hint="由板框多边形实算" tone={orderCard.derived.sizeMm ? undefined : 'warning'} />
              <Stat label="实测铜层" value={orderCard.derived.copperLayerCount ?? '未读到'} hint="来自 EDA 读回" tone={orderCard.derived.copperLayerCount ? undefined : 'warning'} />
              <Stat label="位号 / 网络" value={`${orderCard.derived.componentCount ?? '—'} / ${orderCard.derived.netCount ?? '—'}`} hint="放置读回 / 网表" />
              <Stat label="DRC 必须修" value={orderCard.derived.drcMustFixCount ?? '未读到'} hint={orderCard.derived.drcItemCount !== null ? `共 ${orderCard.derived.drcItemCount} 条` : '没有 DRC 报告'} tone={orderCard.derived.drcMustFixCount ? 'warning' : undefined} />
            </div>
            {orderCard.supplySummary ? (
              <div>
                <div className="stats-grid stats-grid--4">
                  <Stat label="已知单价合计" value={orderCard.supplySummary.known ? `${orderCard.supplySummary.totalKnownAmount} ${orderCard.supplySummary.currency ?? ''}` : '无法合计'} hint={`已定价 ${orderCard.supplySummary.pricedCount} · 缺价 ${orderCard.supplySummary.unknownCount}（不是整单报价）`} tone={orderCard.supplySummary.known ? 'success' : 'warning'} />
                  <Stat label="缺货料号" value={orderCard.supplySummary.outOfStock.length} hint={orderCard.supplySummary.outOfStock.length ? orderCard.supplySummary.outOfStock.slice(0, 4).map((item) => item.lcsc).join('、') : '没有已定价料号库存为 0'} tone={orderCard.supplySummary.outOfStock.length ? 'danger' : 'success'} />
                  <Stat label="库存未知" value={orderCard.supplySummary.stockUnknown.length} hint="未知 ≠ 有货" tone={orderCard.supplySummary.stockUnknown.length ? 'warning' : 'neutral'} />
                  <Stat label="证据时效" value={orderCard.supplySummary.stale === null ? '无时间戳' : orderCard.supplySummary.stale ? `已过期 ${orderCard.supplySummary.ageHours}h` : `${orderCard.supplySummary.ageHours}h 内`} hint={`阈值 ${orderCard.supplySummary.staleAfterHours ?? 24}h；下单前重查`} tone={orderCard.supplySummary.stale ? 'danger' : orderCard.supplySummary.stale === null ? 'warning' : 'success'} />
                </div>
                {orderCard.supplySummary.findings.length ? (
                  <div className="finding-list">
                    {orderCard.supplySummary.findings.map((item) => (
                      <div className="finding-row" key={item.code}>
                        <span className={`badge badge--${item.severity === 'warning' ? 'warning' : 'info'}`}>{item.severity}</span>
                        <code>{item.code}</code>
                        <span>{item.message}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="row-actions">
              <Button icon={<Search size={15} />} loading={alternativesBusy} disabled={alternativesBusy} onClick={() => void queryAlternatives()} title="对 BOM 料号做真实关键词检索，列出替代候选；候选等价性未验证，不自动替换">查询缺料替代候选</Button>
            </div>
            {alternativesError ? <div className="inline-alert inline-alert--danger"><AlertTriangle size={16} /><span>{alternativesError}</span></div> : null}
            {alternatives ? (
              <div className="detail-block">
                <span>替代候选（关键词检索 @{alternatives.checkedAt}；<strong>等价性未验证</strong>，不得直接下单）</span>
                <p><small>有候选 {alternatives.summary.found} · 无候选 {alternatives.summary.empty} · 失败 {alternatives.summary.failed} · 候选 {alternatives.summary.candidates} 个。库存/价格来自 {alternatives.source}；语义等价需工程确认。</small></p>
                <TableFrame label="缺料替代候选">
                  <table>
                    <thead><tr><th>原料号</th><th>关键词</th><th>候选</th><th>价格/库存</th><th>结论</th></tr></thead>
                    <tbody>
                      {alternatives.results.map((item) => (
                        <tr key={`${item.lcscId ?? 'raw'}-${item.query ?? 'q'}`}>
                          <td><code>{item.lcscId || '—'}</code></td>
                          <td><small>{item.query || '—'}</small></td>
                          <td>{item.candidates.length ? item.candidates.map((candidate) => <div key={candidate.lcscId}><code>{candidate.lcscId}</code> · {candidate.model || '型号未知'} · {candidate.package || '封装未知'} {candidate.inStock ? <Badge tone="success">有货 {candidate.stock}</Badge> : candidate.stockUnknown ? <Badge tone="warning">库存未知</Badge> : <Badge tone="danger">库存 0</Badge>}</div>) : <small>{item.status === 'failed' ? `失败：${item.code} ${item.message || ''}` : item.status === 'invalid' ? '没有可检索的型号/封装' : '无候选'}</small>}</td>
                          <td>{item.candidates.map((candidate) => <div key={`${candidate.lcscId}-p`}>{candidate.price !== null ? `${candidate.price} ${candidate.currency ?? ''}` : '价格未知'} · {candidate.stock ?? '未知'}</div>)}</td>
                          <td><Badge tone="warning">{item.status === 'found' ? '等价性未验证' : item.status}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              </div>
            ) : null}
            <div className="detail-block">
              <span>A2 选型回退检索（只读诊断：0 命中时看清每一级尝试）</span>
              <div className="row-actions">
                <input className="input" style={{ maxWidth: 320 }} placeholder="型号/关键词，可用、或换行分隔多个" value={fallbackQuery} onChange={(event) => setFallbackQuery(event.target.value)} aria-label="回退检索关键词" />
                <Button size="sm" icon={<Search size={14} />} loading={fallbackBusy} disabled={fallbackBusy || state.runtime.mode === 'demo'} onClick={() => void probeFallback()}>回退检索</Button>
              </div>
              {fallbackError ? <div className="inline-alert inline-alert--danger"><AlertTriangle size={16} /><span>{fallbackError}</span></div> : null}
              {fallbackResult ? (
                <>
                  <p><small>命中 {fallbackResult.hit}/{fallbackResult.queries} · 回退命中 {fallbackResult.fallbackHits} · 无结果 {fallbackResult.empty}。关键词命中 ≠ 等价替代，器件身份需人工确认。</small></p>
                  <TableFrame label="回退检索结果">
                    <table>
                      <thead><tr><th>原始查询</th><th>结果</th><th>命中来源</th><th>尝试记录</th></tr></thead>
                      <tbody>
                        {fallbackResult.results.map((item) => (
                          <tr key={item.query}>
                            <td><code>{item.query}</code></td>
                            <td>{item.found ? <>{item.found} 个候选<div>{item.candidates.map((candidate) => <div key={`${candidate.lcscId || candidate.uuid || candidate.name}`}><small>{candidate.name || '名称未知'} · <code>{candidate.lcscId || '无 LCSC'}</code></small></div>)}</div></> : <Badge tone="warning">{item.error || 'NO_RESULT'}</Badge>}</td>
                            <td>{item.fallback ? <><Badge tone="info">回退命中</Badge><div><code>{item.usedQuery}</code></div></> : item.found ? <Badge tone="success">原始查询命中</Badge> : <small>—</small>}</td>
                            <td><small>{item.attempts.map((attempt) => `${attempt.query} → ${attempt.found}${attempt.error ? `(${attempt.error})` : ''}`).join('；')}</small></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                </>
              ) : <p><small>输入历史 0 命中的型号（如 BQ24074RGTR）可看到确定性的逐级变形尝试；全空会明确显示 NO_RESULT。</small></p>}
            </div>
            <TableFrame label="下单参数（声明 vs 实测）">
              <table>
                <thead><tr><th>参数</th><th>下单声明</th><th>实测/来源</th></tr></thead>
                <tbody>
                  <tr><td>层数</td><td>{orderCard.parameters.layers ?? '—'}</td><td>{orderCard.derived.copperLayerCount ?? '未读到'}（实测铜层）</td></tr>
                  <tr><td>尺寸</td><td>{orderCard.parameters.sizeMm ? `${orderCard.parameters.sizeMm.x}×${orderCard.parameters.sizeMm.y} mm` : '—'}</td><td>板框多边形</td></tr>
                  <tr><td>板厚 / 铜厚</td><td>{orderCard.parameters.thicknessMm} mm / {orderCard.parameters.copperWeightOz} oz</td><td>能力档（示例值，需核对）</td></tr>
                  <tr><td>表面处理</td><td>{orderCard.parameters.surfaceFinish}</td><td>能力档（示例值，需核对）</td></tr>
                  <tr><td>阻抗控制</td><td>{orderCard.parameters.impedanceControl ? '需要' : '不需要'}</td><td>{orderCard.derived.impedanceNets.length ? `${orderCard.derived.impedanceNets.length} 条阻抗网络` : '无阻抗网络证据'}</td></tr>
                  <tr><td>数量</td><td>{orderCard.parameters.quantity}</td><td>人工输入</td></tr>
                  <tr><td>交期</td><td>{orderCard.parameters.leadTimeDays !== null ? `${orderCard.parameters.leadTimeDays} 天` : '未提供'}</td><td>示例能力档，<strong>不是供应商实时承诺</strong>；下单前人工确认，系统不猜交期</td></tr>
                  <tr><td>板厂能力档</td><td>{orderCard.capability.note || orderCard.capability.provenance}</td><td>{orderCard.capability.provenance}{orderCard.capability.maxSizeMm ? ` · 最大 ${orderCard.capability.maxSizeMm.x}×${orderCard.capability.maxSizeMm.y} mm` : ''}</td></tr>
                  <tr><td>价格</td><td>{orderCard.price.status === 'known' ? `${orderCard.price.amount} ${orderCard.price.currency ?? ''}` : '未知'}</td><td>{orderCard.price.reason ?? orderCard.price.source}</td></tr>
                </tbody>
              </table>
            </TableFrame>
            {orderCard.price.status === 'known' && !(pricingEvidence?.summary?.priced) ? <div className="inline-alert inline-alert--danger"><AlertTriangle size={16} /><span><strong>一致性告警：</strong>卡内价格显示为已知，但本次没有对应的供应链价格证据（可能是示例/过期数据）。<strong>不得据此下单</strong>，先刷新价格与库存证据再核对。</span></div> : null}
            {orderCard.assumptions.length ? (
              <div className="detail-block">
                <span>假设与来源（逐项核对，未确认项不得当事实）</span>
                {orderCard.assumptions.map((item, index) => <p key={`${item.field}-${index}`}><code>{item.field}</code> = {String(item.value ?? '—')} <small>· {item.why}</small></p>)}
              </div>
            ) : null}
            <div className="detail-block"><span>供应链证据（与卡片同时核对）</span></div>
            {pricingEvidence ? (
              <div className="stats-grid stats-grid--4">
                <Stat label="有价格证据" value={`${pricingEvidence.summary.priced}/${pricingEvidence.summary.requested}`} hint={`查询时间 ${pricingEvidence.checkedAt ? new Date(pricingEvidence.checkedAt).toLocaleString('zh-CN') : '未知'}`} tone={pricingEvidence.summary.unknown ? 'warning' : 'success'} />
                <Stat label="无价格证据" value={pricingEvidence.summary.unknown} hint="unknown ≠ 0 元；下单前需人工核实" tone={pricingEvidence.summary.unknown ? 'warning' : 'neutral'} />
                <Stat label="库存不足料号" value={pricingEvidence.entries.filter((entry) => entry.stock !== null && entry.stock < (Number(orderCard.parameters.quantity) || 0)).length} hint={`按本次下单数量 ${orderCard.parameters.quantity || 0} 估算，仅参考`} tone={pricingEvidence.entries.some((entry) => entry.stock !== null && entry.stock < (Number(orderCard.parameters.quantity) || 0)) ? 'warning' : 'neutral'} />
                <Stat label="证据新鲜度" value={pricingEvidence.freshnessKnown ? '带时间戳' : '缺时间'} hint="查询时刻快照；下单前重查" tone={pricingEvidence.freshnessKnown ? 'success' : 'warning'} />
              </div>
            ) : (
              <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>本次还没有价格/库存证据：上方「价格与库存证据」面板刷新后再看这里。卡内价格未知<strong>不是 0 元</strong>，也不会被系统猜出来。</span></div>
            )}
            {orderCard.findings.length ? (
              <div className="finding-list">
                {orderCard.findings.map((item) => (
                  <div className="finding-row" key={`${item.code}-${item.field ?? ''}`}>
                    <Badge tone={item.severity === 'blocking' ? 'danger' : item.severity === 'unknown' ? 'neutral' : 'warning'}>{item.severity === 'blocking' ? '阻断' : item.severity === 'unknown' ? '未确认' : '警告'}</Badge>
                    <div className="finding-detail"><div className="finding-detail__head"><code>{item.code}</code></div><p>{item.message}</p></div>
                  </div>
                ))}
              </div>
            ) : null}
            {orderCard.files.length ? (
              <TableFrame label="准备交付的生产文件">
                <table>
                  <thead><tr><th>种类</th><th>文件</th><th>大小</th><th>状态</th></tr></thead>
                  <tbody>
                    {orderCard.files.map((file) => (
                      <tr key={file.path ?? file.name}><td>{file.kind}</td><td><code>{file.name}</code></td><td>{file.bytes ?? '—'} B</td><td>{file.draft ? <Badge tone="danger">草稿·不得下单</Badge> : <Badge tone="success">正式命名</Badge>}</td></tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            ) : null}
            {orderCard.assumptions.length ? (
              <div className="detail-block">
                <span>本卡的假设（必须显式看着，不能藏在默认值里）</span>
                <ul>{orderCard.assumptions.map((item) => <li key={item.field}>{item.field} = {String(item.value)}：{item.why}</li>)}</ul>
              </div>
            ) : null}
          </div>
        ) : <div className="empty-inline"><Factory size={25} /><strong>尚未生成下单参数卡</strong><span>生成后会列出实测板事实、下单参数一致性与待交付文件状态。</span></div>}
      </Panel>

      <Panel
        eyebrow="HUMAN EXECUTOR · R9 / R10"
        title="人工执行器：在线 DFM 回填 + 下单参数确认（系统不代下单、不代付）"
        meta={orderConfirmation ? <Badge tone="success">已确认 {orderConfirmation.payload.operator}</Badge> : <Badge tone="neutral">未确认</Badge>}
        actions={<Button icon={<RefreshCw size={15} />} disabled={manualBusy !== null} onClick={() => void loadManualEvidence()}>刷新人工证据</Button>}
      >
        <div className="inline-alert inline-alert--danger"><ShieldAlert size={16} /><span><strong>政策红线：</strong>本系统没有任何"下单/支付"能力可调用。R9 在线 DFM 与 R10 下单/付款都必须由人完成；这里只记录"谁在什么参数卡上确认了什么"，不代替你下单，也不代替你付款。</span></div>
        <div className="detail-stack">
          <div className="detail-block"><span>R9 在线 DFM（回填证据）</span><p>{dfmEvidence ? <>已回填 <code>{dfmEvidence.digest.slice(0, 12)}</code> · {dfmEvidence.payload?.passed ? '通过' : '有阻断'} · 操作人 {dfmEvidence.payload?.operator || '未填'}（在上方"人工证据"面板可重填）</> : <>还没有在线 DFM 证据；请到嘉立创在线 DFM 跑完后在上方面板回填，<strong>本系统不把本地 DRC 当在线 DFM</strong>。</>}</p></div>
          <div className="detail-block"><span>R10-1 下单参数卡确认</span>
            <p>{orderCard ? <>当前卡片：{orderCard.readyToOrder ? <Badge tone="success">readyToOrder</Badge> : <Badge tone="warning">不可下单（{orderCard.counts.blocking} 阻断 / {orderCard.counts.unknown} 未确认）</Badge>} · 生成于 {orderCard.generatedAt ? new Date(orderCard.generatedAt).toLocaleString('zh-CN') : '—'}</> : '先生成上方"板厂下单参数卡"。'}</p>
            <div className="form-grid">
              <Field label="确认人（必填）" hint="真实操作人姓名/工号，写入证据"><input className="input" value={ocOperator} onChange={(event) => setOcOperator(event.target.value)} placeholder="例如：张三" /></Field>
              <Field label="备注" hint="如：已核对层数/尺寸/表面处理/文件命名"><input className="input" value={ocNote} onChange={(event) => setOcNote(event.target.value)} placeholder="选填" /></Field>
            </div>
            <label className="checkbox-line"><input type="checkbox" checked={ocAck} onChange={(event) => setOcAck(event.target.checked)} />我已核对参数卡，并确认<strong>下单与支付均由我本人完成，系统不代下单、不代付</strong></label>
            <div className="row-actions">
              <Button variant="primary" icon={<ShieldCheck size={15} />} loading={manualBusy === 'order'} disabled={manualBusy !== null || !orderCard || orderCard.readyToOrder !== true || !ocAck || !ocOperator.trim()} onClick={() => void submitOrderConfirmation()}>记录下单参数确认（不执行下单/支付）</Button>
              {orderConfirmation ? <Badge tone="success">已留痕 <code>{orderConfirmation.digest.slice(0, 12)}</code></Badge> : null}
            </div>
          </div>
          <div className="detail-block"><span>R10-2 人工支付（无系统入口）</span>
            <p>本系统不提供支付页面/接口，也不会保存支付凭据。请你在板厂/商城页面由本人完成付款；付款结果如有需要，在"资料/问题"里作为人工证据留存，系统不会自动读取也未接入任何支付渠道。</p>
            {orderConfirmation ? <p><small>最近一次人工确认：{orderConfirmation.payload.operator} · {new Date(orderConfirmation.savedAt).toLocaleString('zh-CN')} · {orderConfirmation.payload.note || '无备注'}</small></p> : null}
          </div>
        </div>
      </Panel>

      <Panel eyebrow="ADVANCED PCB ENGINEERING" title="三阶段工程引擎" meta="真实本机Runtime计算 · 高速数字 / HDI / 2.4GHz RF">
        <div className="validation-grid">{[
          ['HS-USB2-4L','阶段1 · 高速数字','USB2差分、阻抗、时延、串扰和回流路径'],
          ['HDI-BGA-6L','阶段2 · 多层HDI','6层叠层、微孔能力、层切换与BGA逃逸'],
          ['RF-24G-4L','阶段3 · 2.4GHz RF','CPWG、天线禁布、过孔围栏与openEMS交接'],
        ].map(([id,title,description],index)=><button type="button" className="validation-card validation-card--idle" key={id} disabled={Boolean(engineeringRunning)} onClick={()=>runEngineering(id)}><div className="validation-card__index">{String(index+1).padStart(2,'0')}</div><div className="validation-card__icon">{engineeringRunning===id?<Circle/>:<Play/>}</div><div><strong>{title}</strong><small>{description}</small></div><div className="validation-card__state"><Badge tone="info">{engineeringRunning===id?'计算中':'运行样板'}</Badge><span>{id}</span></div></button>)}</div>
        {engineeringResult && <div className="detail-stack"><div className="validation-summary"><Badge tone={engineeringResult.passed?'success':'warning'}>{engineeringResult.passed?'解析门禁通过':'存在阻断项'}</Badge><div><strong>不可变工程报告</strong><p><code>{engineeringResult.reportHash}</code></p></div><span>{engineeringResult.findings.length} 项</span></div><div className="stats-grid stats-grid--4"><Stat label="高速网络" value={engineeringResult.highSpeed.length} hint="解析阻抗与回流检查" tone="info"/><Stat label="HDI转换" value={engineeringResult.hdi.transitions.length} hint="微孔堆叠与层图" tone="info"/><Stat label="RF网络" value={engineeringResult.rf.length} hint="外部仿真证据门禁" tone="info"/><Stat label="受控EDA操作" value={engineeringResult.operations.length} hint="尚未执行，需独立审批" tone="warning"/></div><div className="inline-alert inline-alert--warning"><AlertTriangle size={16}/><span>结果不会自动写入嘉立创EDA。正式生产仍强制要求官方DRC、嘉立创在线DFM和人工审批。</span></div>{engineeringResult.findings.slice(0,8).map((finding)=><div className="finding-detail" key={`${finding.code}-${finding.path}`}><div className="finding-detail__head"><Badge tone="danger">{finding.severity}</Badge><code>{finding.code}</code></div><h3>{finding.message}</h3><div className="detail-block"><span>数据路径</span><strong>{finding.path}</strong></div></div>)}</div>}
      </Panel>
      <Panel
        eyebrow="APPROVAL LEDGER"
        title="统一批准账本（哈希链审计）"
        meta={ledger ? `${ledger.summary.total} 条记录 · 计划 ${ledger.summary.byScope.plan || 0} / 写板 ${ledger.summary.byScope.write || 0} / 放行 ${ledger.summary.byScope.release || 0}` : '未加载'}
        actions={<Button icon={<RefreshCw size={15} />} loading={ledgerBusy} disabled={ledgerBusy || state.runtime.mode === 'demo'} title={state.runtime.mode === 'demo' ? 'DEMO 模式无真实账本' : '重新读取账本'} onClick={() => void loadLedger()}>刷新账本</Button>}
      >
        <div className="inline-alert inline-alert--info"><Link2 size={16} /><span>计划批准与写板批准共用一条只追加哈希链：签发/消费/复用拒绝/过期都会留痕；账本<strong>只存批准ID与绑定哈希，不存令牌原文</strong>。改任何一条都会在链校验里暴露。</span></div>
        {ledgerError ? <div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>{ledgerError}</span></div> : null}
        {ledger ? (
          <div className="detail-stack">
            <div className="validation-summary">
              <Badge tone={ledger.chain.ok ? 'success' : 'danger'}>{ledger.chain.ok ? '哈希链完整' : `哈希链断裂 @${ledger.chain.brokenAt}`}</Badge>
              <div><strong>{ledger.chain.ok ? '所有批准记录可追溯' : '账本被改动过'}</strong><p>{ledger.chain.ok ? '按时间顺序首尾相接；消费一次性生效' : ledger.chain.reason}</p></div>
              <span>{ledger.entries.length} 条</span>
            </div>
            {ledger.entries.length ? (
              <TableFrame label="批准账本（最近 100 条）">
                <table><thead><tr><th>时间</th><th>作用域</th><th>动作</th><th>批准ID</th><th>绑定</th></tr></thead><tbody>
                  {ledger.entries.slice().reverse().map((entry) => (
                    <tr key={`${entry.index}-${entry.entryHash.slice(0, 8)}`}>
                      <td><small>{entry.at ? new Date(entry.at).toLocaleString('zh-CN') : '—'}</small></td>
                      <td><Badge tone={entry.scope === 'write' ? 'warning' : entry.scope === 'release' ? 'success' : 'info'}>{entry.scope === 'write' ? '写板' : entry.scope === 'release' ? '放行' : '计划'}</Badge></td>
                      <td><Badge tone={entry.action === 'consumed' ? 'success' : entry.action === 'issued' ? 'info' : 'danger'}>{entry.action === 'consumed' ? '已消费' : entry.action === 'issued' ? '已签发' : entry.action === 'revoked' ? '已撤销' : entry.action === 'expired' ? '已过期' : entry.action === 'replayed' ? '复用拒绝' : '绑定不匹配'}</Badge></td>
                      <td><code>{entry.approvalId || '—'}</code></td>
                      <td><small><code>{String(entry.bindings.planHash || entry.bindings.recipeId || entry.bindings.fingerprint || '—').slice(0, 20)}</code></small></td>
                    </tr>
                  ))}
                </tbody></table>
              </TableFrame>
            ) : <div className="empty-inline"><ShieldCheck size={24} /><strong>暂无批准记录</strong><span>批准签发/消费后会自动写入账本；当前为空说明还没有真实计划/写板批准。</span></div>}
          </div>
        ) : null}
      </Panel>

      <Panel eyebrow="VALIDATION PIPELINE" title="工程验证矩阵" meta="Demo 模拟检查，不替代EDA原生报告" actions={<Button variant="primary" icon={<Play size={15} />} loading={running} onClick={runAll}>运行全部检查</Button>}>
        <Progress value={running ? Math.max(8, state.validations.filter((item) => item.status !== 'idle' && item.status !== 'running').length / state.validations.length * 100) : coverage} label={running ? '验证任务进行中' : '本轮检查覆盖'} />
        <div className="validation-grid">{state.validations.map((check, index) => <button type="button" className={`validation-card validation-card--${check.status}`} key={check.id} onClick={() => setSelected(check)}><div className="validation-card__index">{String(index + 1).padStart(2, '0')}</div><div className="validation-card__icon">{check.status === 'pass' ? <CheckCircle2 /> : check.status === 'fail' ? <XCircle /> : check.status === 'warn' ? <AlertTriangle /> : <Circle />}</div><div><strong>{check.name}</strong><small>{check.description}</small></div><div className="validation-card__state"><Badge tone={checkTone(check.status)}>{checkLabel(check.status)}</Badge><span>{check.count} 项</span>{check.source ? <Badge tone={check.source === 'demo' ? 'neutral' : 'success'}>{check.source === 'demo' ? 'DEMO 模拟' : check.source === 'official' ? 'EDA 原生' : check.source === 'manual' ? '人工登记' : '真实运行时'}</Badge> : null}</div></button>)}</div>
      </Panel>

      <Panel eyebrow="OPEN FINDINGS" title="问题清单" meta="点击问题查看定位、建议与豁免路径">
        <div className="finding-list">{state.validations.flatMap((check) => check.findings.map((finding) => ({ check, finding }))).map(({ check, finding }) => <article className={`finding-row finding-row--${finding.status}`} key={finding.id}><div className="finding-severity"><ShieldAlert size={18} /></div><button type="button" className="finding-row__main" onClick={() => setSelected(check)}><strong>{finding.title}</strong><small><code>{finding.rule}</code> · 对象 {finding.object} · {check.name}</small></button><Badge tone={finding.status === 'waived' ? 'neutral' : finding.severity === 'error' ? 'danger' : 'warning'}>{finding.status === 'waived' ? '已豁免' : finding.severity === 'error' ? '错误' : '警告'}</Badge><Button size="sm" onClick={() => setSelected(check)}>处理</Button></article>)}</div>
      </Panel>

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.name || '检查详情'} eyebrow="VALIDATION INSPECTOR" footer={selected && <Button variant="primary" icon={<Play size={15} />} onClick={() => runOne(selected)} disabled={selected.status === 'running'}>{selected.status === 'running' ? '运行中' : `重新运行 ${selected.name}`}</Button>}>
        {selected && <div className="detail-stack"><div className="validation-summary"><Badge tone={checkTone(selected.status)}>{checkLabel(selected.status)}</Badge>{selected.source ? <Badge tone={selected.source === 'demo' ? 'neutral' : 'success'}>{selected.source === 'demo' ? 'DEMO 模拟数据' : '真实来源'}</Badge> : null}<div><strong>{selected.name}</strong><p>{selected.description}</p></div><span>{selected.count} 项</span></div>{selected.findings.length ? selected.findings.map((finding) => <div className={`finding-detail finding-detail--${finding.status}`} key={finding.id}><div className="finding-detail__head"><Badge tone={finding.status === 'waived' ? 'neutral' : finding.severity === 'error' ? 'danger' : 'warning'}>{finding.status === 'waived' ? '已豁免' : finding.severity}</Badge><code>{finding.rule}</code></div><h3>{finding.title}</h3><div className="detail-block"><span>设计对象</span><strong>{finding.object}</strong></div><div className="detail-block"><span>修复建议</span><p>{finding.suggestion}</p></div>{finding.waiverReason && <div className="waiver-note"><strong>豁免原因</strong><p>{finding.waiverReason}</p></div>}<div className="row-actions"><Button size="sm" icon={<Crosshair size={14} />} onClick={() => locate(finding)}>在EDA中定位</Button><Button size="sm" variant="primary" icon={<Sparkles size={14} />} onClick={() => createFix(finding)}>创建AI修复任务</Button>{finding.status === 'open' && <Button size="sm" variant="ghost" onClick={() => { setWaive({ check: selected, finding }); setWaiverReason(''); }}>申请豁免</Button>}</div></div>) : <div className="empty-inline"><CheckCircle2 size={25} /><strong>当前没有问题</strong><span>本检查域处于通过状态。</span></div>}</div>}
      </Drawer>
      <Modal open={Boolean(waive)} onClose={() => setWaive(null)} title="记录验证豁免" eyebrow="ENGINEERING EXCEPTION" footer={<><Button onClick={() => setWaive(null)}>取消</Button><Button variant="primary" onClick={confirmWaiver} disabled={!waiverReason.trim()}>确认豁免并留痕</Button></>}><div className="form-grid"><div className="inline-alert inline-alert--warning"><AlertTriangle size={16} /><span>豁免不会删除问题，只会记录人工接受风险的原因。</span></div><Field label="豁免原因" required hint="至少说明风险接受依据与后续措施"><textarea className="input textarea textarea--large" value={waiverReason} onChange={(e) => setWaiverReason(e.target.value)} placeholder="例如：当前样机仅用于功能验证，Rev.B 将补充保护器件…" /></Field></div></Modal>
    </>
  );
}
