import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Cable, CheckCircle2, ChevronDown, CircleStop, Code2, Copy, DatabaseBackup, ExternalLink, Layers3, LockKeyhole, MonitorCog, Play, RefreshCw, Search, Send, ShieldAlert, ShieldCheck, Unplug, XCircle, TriangleAlert } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { countPlanOperations, getExecutionGate } from '../state/taskMachine';
import { demoAdapter } from '../services/demoAdapter';
import { RuntimeApiError, runtimeClient } from '../services/runtimeClient';
import { clearSchematicPlanDraft, clearSemanticPlanDraft, readSchematicPlanDraft, readSemanticPlanDraft } from '../services/draftStore';
import { resolvePcbDocumentUuid, saveEdaDocumentBinding } from '../services/edaWorkspaceStore';
import { applyEvidencePatch, tryAdvanceProjectStage } from '../services/stageEvidence';
import type { CommandLog, DesignApproval, DesignExecution, EdaDesignContext, ExecutionHistoryItem, PcbCapabilities, PcbContext, PcbExecution, PcbWriteLockState, SemanticPlanResult, SimpleBoardPlanResult } from '../types';
import { Badge, Button, Panel, SegmentedTabs, Stat, TableFrame, Toggle } from '../components/ui';
import { ConfirmDialog } from '../components/overlays';
import { LongTaskPanel } from '../components/LongTaskPanel';
import { LayerStackPanel } from '../components/LayerStackPanel';
import { createSingleCallTask, type LongTaskSnapshot, type SingleCallController } from '../services/longTask';

const commands = [
  { command: 'eda.connection.health', label: '桥接健康检查', permission: 'read' as const, description: '发现并验证本地Bridge服务身份' },
  { command: 'eda.window.list', label: '列出 EDA 窗口', permission: 'read' as const, description: '读取当前连接的嘉立创EDA窗口' },
  { command: 'eda.project.readCurrent', runtimeId: 'project.current' as const, label: '读取当前工程', permission: 'read' as const, description: '固定API读取工程详细属性' },
  { command: 'eda.document.readCurrent', runtimeId: 'document.current' as const, label: '读取活动文档', permission: 'read' as const, description: '固定API读取最后获得焦点的文档' },
  { command: 'eda.schematic.readCatalog', runtimeId: 'schematic.catalog' as const, label: '读取原理图目录', permission: 'read' as const, description: '读取原理图与页面目录' },
  { command: 'eda.schematic.readComponents', runtimeId: 'schematic.components' as const, label: '读取元件与引脚', permission: 'read' as const, description: '读取当前页全部元件和引脚证据' },
  { command: 'eda.schematic.readWires', runtimeId: 'schematic.wires' as const, label: '读取导线', permission: 'read' as const, description: '读取当前页全部导线' },
  { command: 'eda.schematic.controlledWrite', label: '受控执行计划', permission: 'write' as const, description: '仅通过快照、哈希批准和回滚编排执行' },
];

const planTemplate = JSON.stringify({
  title: 'MCU + 电源 + LED + 按键简单控制板',
  blocks: {
    mcu: { libraryUuid: '', uuid: '', value: '' },
    power: { libraryUuid: '', uuid: '', value: '' },
    led: { libraryUuid: '', uuid: '', value: '' },
    button: { libraryUuid: '', uuid: '', value: '' },
  },
  nets: [], placements: [], operations: [], assumptions: [],
}, null, 2);

const pcbPlanTemplate = JSON.stringify({
  title: 'CH32V003 45×30mm 两层生产板',
  board: { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 },
  constraints: { usbC: 'short-edge-centered-flush', button: 'opposite-edge', led: 'near-button', swio: 'long-edge-accessible' },
  operations: [],
}, null, 2);

/** 门禁面板必须直接给出缺失字段名，而不是只给数量或只在toast里提示。 */
function formatMissingFields(missing: string[]): string {
  return missing.length ? `缺少 ${missing.length} 项：${missing.join('、')}` : '缺少 0 项';
}
function missingFieldsTitle(missing: string[]): string | undefined {
  return missing.length ? `缺少字段：${missing.join('、')}` : undefined;
}

export function EdaPage() {
  const { state, activeProject, dispatch, notify, addAudit, recordChange, reportIssue, reportFailure } = useApp();
  const aiProviderId = state.settings.provider === 'demo' ? 'codex_account' : state.settings.provider;
  const aiProviderBaseUrl = state.settings.baseUrl || undefined;
  const [checking, setChecking] = useState(false);
  const [runningCommand, setRunningCommand] = useState<string | null>(null);
  const [commandQuery, setCommandQuery] = useState('');
  const [permissionFilter, setPermissionFilter] = useState('all');
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [executeConfirmOpen, setExecuteConfirmOpen] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [createdWorkspace, setCreatedWorkspace] = useState<{ projectUuid: string; boardName: string; schematicUuid: string; schematicPageUuid: string; pcbUuid: string; schematicStatus?: 'empty' | 'generated' } | null>(null);
  const [designContext, setDesignContext] = useState<EdaDesignContext | null>(null);
  const [planText, setPlanText] = useState(planTemplate);
  const [planning, setPlanning] = useState<SimpleBoardPlanResult | null>(null);
  const [approval, setApproval] = useState<DesignApproval | null>(null);
  const [execution, setExecution] = useState<DesignExecution | null>(null);
  const [designBusy, setDesignBusy] = useState<string | null>(null);
  const [reviewedNetlist, setReviewedNetlist] = useState<Record<string, unknown> | null>(null);
  const [pcbCapabilities, setPcbCapabilities] = useState<PcbCapabilities | null>(null);
  // G5：版本适配诊断（未知/未验证版本必须显式告警，而不是运行到一半才神秘失败）。
  const [edaAdaptation, setEdaAdaptation] = useState<Awaited<ReturnType<typeof runtimeClient.edaAdaptation>>['adaptation'] | null>(null);
  const [pcbContext, setPcbContext] = useState<PcbContext | null>(null);
  const [pcbPlanText, setPcbPlanText] = useState(pcbPlanTemplate);
  const [pcbPlanning, setPcbPlanning] = useState<SimpleBoardPlanResult | null>(null);
  const [pcbApproval, setPcbApproval] = useState<DesignApproval | null>(null);
  const [pcbExecution, setPcbExecution] = useState<PcbExecution | null>(null);
  const [pcbBusy, setPcbBusy] = useState<string | null>(null);
  // D8：R1/R2 受控执行是 150s/180s 级长调用，用统一单调用控制器接管取消/超时/重试措辞。
  const [designAiTask, setDesignAiTask] = useState<LongTaskSnapshot<{ status: 'ready' | 'blocked'; explanation: string; blockers: string[]; netlist: Record<string, unknown> | null; compilation: SimpleBoardPlanResult | null }> | null>(null);
  const designAiTaskRef = useRef<SingleCallController<{ status: 'ready' | 'blocked'; explanation: string; blockers: string[]; netlist: Record<string, unknown> | null; compilation: SimpleBoardPlanResult | null }> | null>(null);
  const [designExecTask, setDesignExecTask] = useState<LongTaskSnapshot<DesignExecution> | null>(null);
  const designExecTaskRef = useRef<SingleCallController<DesignExecution> | null>(null);
  const [pcbExecTask, setPcbExecTask] = useState<LongTaskSnapshot<PcbExecution> | null>(null);
  const pcbExecTaskRef = useRef<SingleCallController<PcbExecution> | null>(null);

  /**
   * C4：PCB 上下文读回统一入口。除了更新本地快照，还把目标指纹写进全局状态，
   * 并在指纹变化时**立即**作废旧批准/执行结果（而不是等后端拒绝再解释）。
   */
  const syncPcbContext = (context: PcbContext | null) => {
    setPcbContext(context);
    if (!context) return;
    const previous = state.eda.targetFingerprint;
    dispatch({ type: 'PATCH_EDA', patch: { targetFingerprint: context.targetFingerprint, lastContextAt: context.capturedAt } });
    if (previous && previous !== context.targetFingerprint) {
      setPcbApproval(null); setPcbExecution(null);
      notify('EDA 目标已变化，旧批准作废', `批准时指纹 ${previous.slice(0, 12)}，当前 ${context.targetFingerprint.slice(0, 12)}：请重新读取证据并重新批准。`, 'warning');
      addAudit('eda', '检测到 EDA 目标指纹变化', `${previous.slice(0, 12)} → ${context.targetFingerprint.slice(0, 12)}`, 'warning');
    }
  };
  // D7：默认目标只能来自当前项目绑定/本机按项目记忆，不能写死某块板（刷新/切项目后曾指向错板）。
  const [pcbDocumentUuid, setPcbDocumentUuid] = useState(() => resolvePcbDocumentUuid(activeProject));
  const changePcbDocumentUuid = (next: string) => { setPcbDocumentUuid(next); saveEdaDocumentBinding(activeProject?.id, next); };
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [designInstruction, setDesignInstruction] = useState('');
  const [conversationBusy, setConversationBusy] = useState(false);
  const [conversationCandidate, setConversationCandidate] = useState<{ status: 'ready' | 'blocked'; explanation: string; blockingInformation: Array<{ code: string; question: string; reason: string }>; plan: Record<string, unknown> | null } | null>(null);
  const [compiledCandidate, setCompiledCandidate] = useState<SemanticPlanResult | null>(null);
  // 器件选型页交接过来的原理图计划草稿：标签用于提示来源与 planHash 一致性。
  const [importedSchematic, setImportedSchematic] = useState<{ sourceLabel: string; planHash: string | null } | null>(null);
  // 执行历史（落盘）：重启 Runtime 后仍能看到"某次写入改了什么、结果如何"。
  const [executionHistory, setExecutionHistory] = useState<{ design: ExecutionHistoryItem[]; pcb: ExecutionHistoryItem[]; persistenceError: string | null; busy: boolean; error: string }>({ design: [], pcb: [], persistenceError: null, busy: false, error: '' });
  /**
   * P0-4（复审 2026-10-29）：PCB 安全写锁。上次回滚失败后 Runtime 会锁死 PCB 写入（409 PCB_WRITE_LOCKED），
   * 修复前 UI 完全不读这个状态：用户只看到"写入失败"，不知道是自己点了暂停还是锁没解。
   */
  const [pcbWriteLock, setPcbWriteLock] = useState<PcbWriteLockState | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const [lockOperator, setLockOperator] = useState('lead');
  const [lockNote, setLockNote] = useState('');
  const [lockBusy, setLockBusy] = useState(false);
  const [historyDetail, setHistoryDetail] = useState<{ kind: 'schematic' | 'pcb'; execution: Record<string, unknown> } | null>(null);
  const realSession = state.runtime.reachable && state.runtime.mode !== 'demo';
  // P0-5：写门禁 = Runtime 全局暂停 OR 本会话暂停（两者都是 Runtime 权威状态），再加真实会话/连接。
  const writeGateClosed = state.settings.writePaused || state.settings.sessionPaused === true;
  // P0-4：安全写锁未解除时，PCB 批准/执行必然 409 PCB_WRITE_LOCKED；按钮直接禁用并说明原因。
  const pcbWriteLocked = pcbWriteLock?.safetyLocked === true;
  const canWrite = realSession && !writeGateClosed && !state.eda.writePaused && state.eda.connected;
  // 唯一权威写门禁：原理图与PCB的受控执行都引用同一份规则，不再各自内联 connected/writePaused/window 判断。
  const schematicExecutionGate = getExecutionGate({ planApproved: Boolean(approval), executableStepCount: countPlanOperations(planning?.plan) }, state.eda, state.settings);
  const pcbExecutionGate = getExecutionGate({ planApproved: Boolean(pcbApproval), executableStepCount: countPlanOperations(pcbPlanning?.plan) }, state.eda, state.settings);
  /** P0-2：同步计划里声明的"同步后应有位号"，用来把确认框说清楚（执行器会逐项核对）。 */
  const expectedSyncDesignators = ((pcbPlanning?.plan as { expectations?: { designators?: string[] } } | undefined)?.expectations?.designators) ?? [];
  const visibleCommands = useMemo(() => commands.filter((item) => (permissionFilter === 'all' || item.permission === permissionFilter) && `${item.label} ${item.command}`.toLowerCase().includes(commandQuery.toLowerCase())), [permissionFilter, commandQuery]);
  const explain = (error: unknown) => error instanceof RuntimeApiError ? `${error.code} · ${error.message}` : error instanceof Error ? error.message : '未知错误';
  /** D4：EDA 页失败统一入口——审计 + 提示 + Runtime 诊断（证据/修复页/运行 ID），不再只弹一条 toast。 */
  const fail = (title: string, error: unknown) => {
    const detail = explain(error);
    addAudit('eda', title, detail, 'error');
    notify(title, detail, 'danger');
    void reportFailure({ source: 'eda', error: { code: error instanceof RuntimeApiError ? error.code : 'EDA_OPERATION_FAILED', message: detail }, context: { page: 'eda', operation: title } });
  };
  /**
   * P0-5（复审 2026-10-29）：会话级写暂停改由 Runtime 执行（scope='session'），不再只是前端自觉。
   * 修复前这个 Toggle 只 PATCH_EDA 本地字段：脚本/curl 仍能签发写批准，UI 却显示"已暂停"。
   * 现在先乐观镜像、再以 Runtime 返回为准；失败回滚并如实报错（不能显示一个不存在的暂停）。
   */
  const setSessionWritePaused = async (next: boolean) => {
    const previous = { eda: state.eda.writePaused, session: state.settings.sessionPaused === true };
    dispatch({ type: 'PATCH_EDA', patch: { writePaused: next } });
    dispatch({ type: 'SET_WRITE_GATE', paused: state.settings.writePaused, sessionPaused: next });
    try {
      const { gate } = await runtimeClient.setWriteGate({ paused: next, scope: 'session', actor: 'EDA 页会话开关' });
      const sessionPaused = gate.sessionPaused === true;
      dispatch({ type: 'PATCH_EDA', patch: { writePaused: sessionPaused } });
      dispatch({ type: 'SET_WRITE_GATE', paused: gate.paused === true, sessionPaused });
      addAudit('eda', sessionPaused ? '暂停本会话写入' : '恢复本会话写入', `Runtime 已确认 · scope=session · gate v${gate.version}`, sessionPaused ? 'warning' : 'info');
      notify(sessionPaused ? '本会话写入已暂停' : '本会话写入已恢复', sessionPaused ? 'Runtime 已确认：本会话内所有 EDA 写/批准请求会返回 409 EDA_WRITE_PAUSED（全局暂停状态不变）。' : 'Runtime 已确认恢复；若设置页仍开着全局暂停，写入依旧会被拒绝。', 'success');
    } catch (error) {
      // Runtime 没确认 = 没有暂停/恢复。回滚 UI 状态，避免展示一个服务端并不存在的门禁。
      dispatch({ type: 'PATCH_EDA', patch: { writePaused: previous.eda } });
      dispatch({ type: 'SET_WRITE_GATE', paused: state.settings.writePaused, sessionPaused: previous.session });
      fail(next ? '暂停会话写入失败' : '恢复会话写入失败', error);
    }
  };
  /**
   * P1-5（WP1 契约）：原理图批准/执行带上当前设计上下文里的 projectId/documentUuid。
   * 不传时服务端无法比对"批准 A 工程却写入 B 工程"，目标绑定等于失效。
   * 取不到就传 null（服务端按"调用方未提供"处理，不猜）。
   */
  const designTargetBinding = (() => {
    const readUuid = (value: unknown): string | null => {
      if (!value || typeof value !== 'object') return null;
      const record = value as Record<string, unknown>;
      const direct = record.uuid ?? record.documentUuid ?? record.id;
      if (typeof direct === 'string' && direct.trim()) return direct.trim();
      const data = Array.isArray(record.data) ? record.data[0] : null;
      const nested = data && typeof data === 'object' ? (data as Record<string, unknown>).uuid : null;
      return typeof nested === 'string' && nested.trim() ? nested.trim() : null;
    };
    return {
      projectId: readUuid(designContext?.project),
      documentUuid: readUuid(designContext?.document),
    };
  })();
  const projectRequirements = state.requirements;
  const projectComponents = state.components.filter((item) => item.projectId === state.activeProjectId);
  const projectAssets = state.assets;

  useEffect(() => { setReviewedNetlist(null); setPlanning(null); setApproval(null); setExecution(null); setDesignContext(null); setPlanText(planTemplate); setCreatedWorkspace(activeProject?.edaWorkspace || null); setPcbDocumentUuid(resolvePcbDocumentUuid(activeProject)); }, [state.activeProjectId]);

  // 接收 AI 任务页交接过来的语义计划（sessionStorage 草稿）：挂载即载入候选，
  // 用户点“确认方案并准备执行”就会走编译→受控执行，不需要重新生成一遍。
  useEffect(() => {
    const draft = readSemanticPlanDraft();
    if (!draft) return;
    setConversationCandidate({ status: 'ready', explanation: `来自 AI 任务页的计划候选 · ${draft.planHash.slice(0, 12)} · ${draft.explanation}`, blockingInformation: [], plan: draft.plan });
    setCompiledCandidate(null);
    addAudit('eda', '接收AI计划草稿', draft.planHash, 'info');
    notify('已载入 AI 任务页的计划（PCB 写入链）', '点击“确认方案并准备执行”可编译为 PCB 受控执行计划（尚未写入 EDA）；原理图写入不在这条链上，请用 AI 网表草案生成后人工批准。', 'info');
  // 只在挂载时读一次：草稿是跨页面的单次交接，不在本页反复覆盖用户当前操作。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 执行历史加载：只读、非 Demo；失败只在本面板显示，不影响连接与审批。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadExecutionHistory(); }, []);

  // 选型提案 → 设计批准：把计划 JSON 填进计划编辑器并打开高级控制，
  // 用户点“3. 校验计划”时会重新算哈希，与提案哈希不一致会明确提示，而不是悄悄换一份。
  useEffect(() => {
    const draft = readSchematicPlanDraft();
    if (!draft) return;
    setPlanText(JSON.stringify(draft.plan, null, 2));
    setImportedSchematic({ sourceLabel: draft.sourceLabel, planHash: draft.planHash });
    setAdvancedOpen(true);
    addAudit('eda', '接收选型计划草稿', `${draft.sourceLabel} · ${draft.planHash?.slice(0, 12) || '无哈希'}`, 'info');
    notify('已载入选型提案计划', `${draft.sourceLabel}：请点“3. 校验计划”→"4. 人工批准"。`, 'info');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusEasyEda = async () => {
    try { await runtimeClient.focusEasyEda(); addAudit('eda', '聚焦嘉立创EDA', '从对话驱动工作台打开本机设计窗口', 'success'); notify('已打开嘉立创EDA', '可在原生编辑器中查看完整图纸。', 'success'); }
    catch (error) { fail('无法打开嘉立创EDA', error); }
  };

  const createEasyEdaWorkspace = async () => {
    setCreateWorkspaceOpen(false); setCreatingWorkspace(true);
    try {
      const suffix = Date.now().toString().slice(-8);
      const result = await runtimeClient.createEasyEdaWorkspace({ friendlyName: activeProject?.name || `CircuitPilot-${suffix}`, projectName: `${activeProject?.code || 'CircuitPilot'}-${suffix}`, description: activeProject?.description || '由CircuitPilot根据已确认需求创建' });
      const workspace = { ...result.workspace, schematicStatus: 'empty' as const };
      setCreatedWorkspace(workspace); changePcbDocumentUuid(workspace.pcbUuid);
      if (activeProject) dispatch({ type: 'UPDATE_PROJECT', project: { ...activeProject, edaWorkspace: workspace, updatedAt: new Date().toISOString() } });
      const context = await runtimeClient.pcbContext(); syncPcbContext(context); setPcbApproval(null); setPcbExecution(null);
      dispatch({ type: 'PATCH_EDA', patch: { connected: true, bridgeStatus: 'running', activeWindowId: context.windowId } });
      recordChange({ source: 'runtime', actor: 'CircuitPilot Runtime', action: 'create', objectType: 'easyeda-workspace', objectId: result.workspace.projectUuid, summary: '自动创建嘉立创EDA工程、原理图和PCB文档', after: result.workspace, reason: '用户选择新建PCB设计并确认后由后台启动嘉立创EDA执行固定创建链' });
      notify('嘉立创EDA设计文件已创建', `工程、原理图和PCB已建立，PCB ${result.workspace.pcbUuid.slice(0, 12)}已打开并同步。`, 'success');
    } catch (error) { fail('新建PCB设计失败', error); }
    finally { setCreatingWorkspace(false); }
  };

  const bindCurrentEasyEdaWorkspace = async () => {
    setCreatingWorkspace(true);
    try {
      const current = await runtimeClient.currentEasyEdaWorkspace();
      const workspace = { ...current, schematicStatus: 'empty' as const };
      setCreatedWorkspace(workspace); changePcbDocumentUuid(workspace.pcbUuid);
      if (activeProject) dispatch({ type: 'UPDATE_PROJECT', project: { ...activeProject, edaWorkspace: workspace, edaProjectPath: `easyeda://${workspace.projectUuid}/${workspace.boardName}`, updatedAt: new Date().toISOString() } });
      notify('当前EDA设计已绑定', `${workspace.boardName} · 原理图和PCB文档身份已保存到当前项目。`, 'success');
    } catch (error) { fail('绑定失败', error); }
    finally { setCreatingWorkspace(false); }
  };

  const generateConversationPlan = async () => {
    const instruction = designInstruction.trim();
    if (!instruction) return notify('请输入设计要求', '例如：把 USB-C 放在短边中心，并缩短差分线。', 'warning');
    setConversationBusy(true); setConversationCandidate(null); setCompiledCandidate(null);
    try {
      const result = await runtimeClient.generateProductionPlan({ project: activeProject, requirements: projectRequirements, components: projectComponents, assets: projectAssets }, state.settings.model === 'auto' ? null : state.settings.model, instruction, aiProviderId, aiProviderBaseUrl);
      setConversationCandidate(result.candidate); setCompiledCandidate(result.planning);
      addAudit('ai', '生成PCB对话设计方案', `${activeProject?.code || state.activeProjectId} · ${result.candidate.status}`, result.candidate.status === 'ready' ? 'success' : 'warning');
      notify(result.candidate.status === 'ready' ? '设计方案已生成' : '需先补充关键信息', result.candidate.explanation, result.candidate.status === 'ready' ? 'success' : 'warning');
    } catch (error) { fail('AI设计失败', error); }
    finally { setConversationBusy(false); }
  };

  const prepareCandidateForExecution = async () => {
    if (!conversationCandidate?.plan) return;
    setConversationBusy(true);
    try {
      const compiled = await runtimeClient.compileProductionPlan(conversationCandidate.plan);
      setCompiledCandidate(compiled);
      if (!compiled.ready || !compiled.compiled) return notify('方案未通过确定性校验', compiled.blocking.map((item) => item.message).join('、') || '请补全工程证据。', 'danger');
      clearSemanticPlanDraft();
      // P0-1：把来源页的两份哈希一起带进 PCB 计划——批准令牌与账本因此能证明“写的就是批准的”。
      const executable = await runtimeClient.normalizePcbPlan({
        ...compiled.compiled,
        semanticPlanHash: compiled.planHash,
        compiledPlanHash: compiled.compiledPlanHash,
      });
      setPcbPlanText(JSON.stringify(executable.plan, null, 2)); setPcbPlanning(executable); setPcbApproval(null); setAdvancedOpen(true);
      recordChange({ source: 'user', actor: '本机用户', action: 'approve', objectType: 'ai-pcb-candidate', objectId: compiled.planHash, summary: '确认AI PCB设计方案并准备受控执行', after: { compiledPlanHash: compiled.compiledPlanHash, quality: compiled.quality }, reason: '用户查看差异后显式确认；尚未写入嘉立创EDA' });
      notify('已准备受控执行', '此步未写入嘉立创EDA；请在已展开的高级控制中读取真实PCB、审批并执行。', 'success');
    } catch (error) { fail('方案编译失败', error); }
    finally { setConversationBusy(false); }
  };

  const requestConversationExecution = async () => {
    if (!activeProject?.edaWorkspace) return notify('尚未绑定EDA文件', '请先在嘉立创EDA中选中本项目PCB，然后点击“绑定当前EDA设计”。', 'warning');
    if (activeProject.edaWorkspace.schematicStatus !== 'generated') return notify('原理图尚未生成', '请先生成并审核网络表，在“项目网络表 → 原理图受控执行”中完成原理图写入。', 'warning');
    if (!canWrite) return notify('写入门禁未就绪', writeGateClosed ? (state.settings.writePaused ? 'Runtime 全局写入已暂停：请先在设置页恢复写入。' : '本会话写入已暂停：请关闭 EDA 页“暂停本会话写入”。') : '请确认 Runtime、Bridge 和嘉立创EDA窗口已连接。', 'danger');
    if (!/^[a-f0-9]{16,64}$/i.test(pcbDocumentUuid.trim())) return notify('缺少目标PCB', '请先新建PCB设计，或在高级控制中填写当前PCB文档UUID。', 'warning');
    setConversationBusy(true); setPcbBusy('context');
    try {
      /**
       * P0-2：先做只读同步验收，再决定是否要写板。
       * 真机已知 `pcb.importChanges` 会返回 success 却 0 器件落板，所以：
       *   1) 已经一致 → 不写（避免空转），直接告知；
       *   2) 有缺件 → 把"同步后应有的位号"写进计划，执行器回读缺一个就失败回滚；
       *   3) 有未标注位号 → 先让人标注，不能把 `R?` 当作期望值。
       */
      const syncState = await runtimeClient.pcbSyncVerify();
      const syncVerification = syncState.verification;
      const expectedDesignators = syncState.schematic.designators.filter((item) => !String(item).includes('?'));
      if (syncVerification.unannotated.length) {
        throw new RuntimeApiError('PCB_SYNC_UNANNOTATED', `原理图仍有 ${syncVerification.unannotated.length} 个未标注位号（${syncVerification.unannotated.slice(0, 8).join('、')}）：请先在嘉立创EDA 完成位号标注，再回来同步`);
      }
      if (!syncVerification.missing.length && !syncVerification.extra.length) {
        notify('原理图与 PCB 已一致', `回读验收：${syncVerification.matched.length} 个位号全部匹配，无需再执行导入变更（未写入任何内容）。`, 'success');
        addAudit('eda', '同步前回读验收通过', `${syncVerification.matched.length} 个位号一致 · 未写入`, 'success');
        return;
      }
      if (!syncVerification.missing.length && syncVerification.extra.length) {
        throw new RuntimeApiError('PCB_SYNC_EXTRA', `PCB 上多出 ${syncVerification.extra.length} 个原理图没有的器件（${syncVerification.extra.slice(0, 8).join('、')}）：导入变更不会删除多余器件，请先人工处理`);
      }
      await runtimeClient.openPcb(pcbDocumentUuid.trim());
      const liveContext = await runtimeClient.pcbContext();
      if (!liveContext.complete) throw new RuntimeApiError('PCB_CONTEXT_INCOMPLETE', '目标PCB实时读取不完整，已停止执行');
      const baseBoard = (pcbPlanning?.plan as { board?: Record<string, unknown> } | undefined)?.board || { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 };
      const syncPlan = await runtimeClient.normalizePcbPlan({
        title: `${activeProject?.name || '当前项目'} · 从已确认原理图同步到PCB`,
        board: baseBoard,
        constraints: {},
        operations: [{ type: 'pcb.importChanges', args: {} }, { type: 'pcb.save', args: {} }, { type: 'pcb.drc', args: {} }],
        // 执行器据此在回读后逐项核对：缺一个就失败回滚，绝不把空转的导入变更当成同步成功。
        expectations: { designators: expectedDesignators },
      });
      if (!syncPlan.ready) throw new RuntimeApiError('PCB_SYNC_PLAN_INVALID', syncPlan.missing.join('、'));
      syncPcbContext(liveContext); setPcbPlanning(syncPlan); setPcbPlanText(JSON.stringify(syncPlan.plan, null, 2)); setPcbApproval(null); setPcbExecution(null);
      setExecuteConfirmOpen(true);
      await runtimeClient.focusCircuitPilot();
    } catch (error) { fail('执行前检查未通过', error); }
    finally { setConversationBusy(false); setPcbBusy(null); }
  };

  const executeConversationDesign = async () => {
    setExecuteConfirmOpen(false);
    if (!pcbPlanning?.ready || !pcbContext?.complete) return;
    // 该流程的一次性批准令牌在下方 approvePcb 时签发；用户在最终确认框中的确认即代表“计划已被批准”。
    const conversationGate = getExecutionGate({ planApproved: Boolean(pcbPlanning.ready && pcbContext.complete), executableStepCount: countPlanOperations(pcbPlanning.plan) }, state.eda, state.settings);
    if (!conversationGate.allowed) { notify('写入门禁未通过', conversationGate.reason, 'warning'); return; }
    setConversationBusy(true); setPcbBusy('execute');
    try {
      const boundApproval = await runtimeClient.approvePcb({ plan: pcbPlanning.plan, targetFingerprint: pcbContext.targetFingerprint, windowId: pcbContext.windowId });
      setPcbApproval(boundApproval);
      const value = await runtimeClient.executePcb({ plan: pcbPlanning.plan, approvalToken: boundApproval.token, targetFingerprint: pcbContext.targetFingerprint, windowId: pcbContext.windowId });
      setPcbExecution(value); setPcbApproval(null); void loadExecutionHistory();
      const didComplete = value.state === 'completed';
      /**
       * P0-2 第二道闸：执行器已按 plan.expectations 校验过缺件；这里再用只读 sync/verify 复核一次，
       * 防止旧计划（无 expectations）或服务端升级前的路径仍把"空转的导入变更"显示成完成。
       */
      let postSync: Awaited<ReturnType<typeof runtimeClient.pcbSyncVerify>> | null = null;
      let postError: string | null = null;
      if (didComplete) {
        try { postSync = await runtimeClient.pcbSyncVerify(); } catch (error) { postError = explain(error); }
      }
      const syncMissing = postSync?.verification.missing ?? [];
      const syncExtra = postSync?.verification.extra ?? [];
      const ok = didComplete && syncMissing.length === 0;
      // P1-4（复审 2026-10-29）：同步后"复验请求本身失败"也是未证实，不能只在 toast 里 warning。
      // 修复前这种情形不落 issue：看板仍显示无问题，而"回读一致"其实从未被证明。
      if (didComplete && !postSync) {
        reportIssue({
          fingerprint: `eda:PCB_SYNC_VERIFY_FAILED:${value.id}`,
          source: 'eda',
          severity: 'warning',
          status: 'open',
          code: 'PCB_SYNC_VERIFY_FAILED',
          summary: 'PCB 同步后复核请求失败，回读一致性未被证明',
          detail: postError || '复核请求未返回结果',
          context: { executionId: value.id, state: value.state },
          suggestedAction: '重试同步复核（GET /api/pcb/sync/verify）；或人工核对 PCB 位号与 BOM 后重跑执行。',
        });
      }
      recordChange({ source: 'runtime', actor: 'CircuitPilot Runtime', action: 'execute', objectType: 'pcb-execution', objectId: value.id, summary: `对话驱动PCB执行状态：${value.state}${syncMissing.length ? ` · 回读仍缺${syncMissing.length}件` : ''}`, after: { events: value.events, readback: value.readback, drc: value.drc, error: value.error, syncCheck: value.syncCheck ?? null, postSync: postSync?.verification ?? null }, reason: '用户在主工作台最终确认后，自动完成目标绑定、一次性审批、写入、回读与DRC' });
      if (!didComplete) {
        reportIssue({ fingerprint: `eda:CONVERSATION_EXECUTION:${value.error?.code || value.state}`, source: 'eda', severity: value.state === 'rollback_failed' ? 'critical' : 'error', status: 'open', code: value.error?.code || value.state, summary: '对话驱动PCB执行未成功', detail: value.error?.message || value.state, context: { executionId: value.id }, suggestedAction: value.state === 'rolled_back' ? '已恢复执行前快照，请修正方案后重试。' : '请停止写入并人工检查嘉立创EDA工程。' });
        notify('EDA设计执行已停止', `${value.state} · ${value.error?.message || ''}`, 'danger');
      } else if (syncMissing.length) {
        // 执行记录 completed 但回读仍缺件：如实报失败，绝不显示"同步完成"。
        reportIssue({ fingerprint: `eda:CONVERSATION_SYNC_INCOMPLETE:${value.id}`, source: 'eda', severity: 'error', status: 'open', code: 'PCB_SYNC_INCOMPLETE', summary: '原理图→PCB 同步后回读仍缺件', detail: postError || `仍缺 ${syncMissing.length} 个器件：${syncMissing.slice(0, 12).join('、')}`, context: { executionId: value.id, missing: syncMissing.join(',') }, suggestedAction: '在嘉立创EDA 打开原理图 → 菜单"设计 → 更新/转换原理图到 PCB"（确认变更后应用），再回来点"回读验收"。' });
        notify('同步未生效', `执行结束但回读仍缺 ${syncMissing.length} 个器件（${syncMissing.slice(0, 8).join('、')}${syncMissing.length > 8 ? '…' : ''}），不能算同步完成。`, 'danger');
      } else {
        notify('EDA设计执行完成', `写入、保存、回读和官方PCB DRC 均已完成；同步验收 ${postSync?.verification.matched.length ?? 0} 个位号一致${syncExtra.length ? `（PCB 多出 ${syncExtra.length} 个器件，未删除，请人工核对：${syncExtra.slice(0, 6).join('、')}）` : ''}${postError ? `；回读复核失败：${postError}` : ''}。`, syncExtra.length || postError ? 'warning' : 'success');
      }
    } catch (error) { fail('EDA执行请求失败', error); }
    finally { setConversationBusy(false); setPcbBusy(null); }
  };

  const runDiagnostics = async () => {
    setChecking(true);
    if (!state.runtime.reachable) {
      const result = await demoAdapter.checkEnvironment(state.eda.diagnostics, (diagnostics) => dispatch({ type: 'PATCH_EDA', patch: { diagnostics } }));
      dispatch({ type: 'PATCH_EDA', patch: { diagnostics: result, connected: true, bridgeStatus: 'running' } });
      addAudit('eda', '完成Demo环境诊断', 'Runtime未连接，使用显式模拟结果', 'warning'); notify('Demo检查完成', '当前结果不代表真实嘉立创EDA状态。', 'warning'); setChecking(false); return;
    }
    try {
      const bridge = await runtimeClient.discoverBridge();
      if (!bridge) throw new RuntimeApiError('BRIDGE_NOT_FOUND', '49620-49629未发现easyeda-bridge服务');
      const windowState = await runtimeClient.windows();
      const capabilities = await runtimeClient.pcbCapabilities();
      setPcbCapabilities(capabilities);
      try { setEdaAdaptation((await runtimeClient.edaAdaptation()).adaptation); } catch (adaptationError) { setEdaAdaptation(null); addAudit('eda', '版本适配诊断失败', explain(adaptationError), 'warning'); }
      const diagnostics = [
        { id: 'diag-runtime', name: 'CircuitPilot Runtime', detail: runtimeClient.baseUrl, status: 'pass' as const },
        { id: 'diag-easyeda', name: '嘉立创EDA专业版', detail: '本机应用已由Runtime检测', status: 'pass' as const },
        { id: 'diag-bridge', name: 'EasyEDA Bridge', detail: `127.0.0.1:${bridge.port} · 服务身份已验证`, status: 'pass' as const },
        { id: 'diag-window', name: '活动窗口', detail: windowState.windows.length ? `${windowState.windows.length}个窗口${windowState.selectionRequired ? ' · 需要人工选择' : ''}` : 'Bridge在线但没有EDA窗口', status: windowState.windows.length ? 'pass' as const : 'fail' as const },
      ];
      dispatch({ type: 'PATCH_EDA', patch: { diagnostics, connected: windowState.windows.length > 0, bridgeStatus: 'running', port: bridge.port, windows: windowState.windows, windowCount: windowState.windows.length, activeWindowId: windowState.selectedWindowId } });
      dispatch({ type: 'PATCH_RUNTIME', patch: { mode: 'real_read_only', lastError: null } });
      addAudit('eda', '完成真实Bridge诊断', `127.0.0.1:${bridge.port} · ${windowState.windows.length}个窗口`, windowState.windows.length ? 'success' : 'warning');
      notify('真实Bridge检查完成', windowState.selectionRequired ? '检测到多个窗口，请人工选择目标。' : windowState.windows.length ? '已建立只读连接。' : '尚无EDA窗口接入Bridge。', windowState.windows.length ? 'success' : 'warning');
    } catch (error) {
      const detail = explain(error);
      dispatch({ type: 'PATCH_EDA', patch: { connected: false, bridgeStatus: 'error', windows: [], windowCount: 0, activeWindowId: null, diagnostics: [{ id: 'diag-bridge', name: 'EasyEDA Bridge', detail, status: 'fail' }] } });
      dispatch({ type: 'PATCH_RUNTIME', patch: { mode: 'demo', lastError: { code: error instanceof RuntimeApiError ? error.code : 'EDA_ERROR', message: detail } } });
      addAudit('eda', 'Bridge诊断失败', detail, 'error'); reportIssue({ fingerprint: `eda:BRIDGE:${error instanceof RuntimeApiError ? error.code : 'EDA_ERROR'}`, source: 'eda', severity: 'error', status: 'open', code: error instanceof RuntimeApiError ? error.code : 'EDA_ERROR', summary: '嘉立创EDA Bridge连接失败', detail, suggestedAction: '启动EasyEDA Bridge并确认嘉立创EDA窗口已连接。' }); notify('Bridge连接失败', detail, 'danger');
    } finally { setChecking(false); }
  };

  const selectWindow = async (windowId: string) => {
    try { await runtimeClient.selectWindow(windowId); dispatch({ type: 'PATCH_EDA', patch: { activeWindowId: windowId } }); addAudit('eda', '选择目标EDA窗口', windowId, 'success'); recordChange({ source: 'user', actor: '本机用户', action: 'select', objectType: 'eda-window', objectId: windowId, summary: '锁定嘉立创EDA目标窗口', before: state.eda.activeWindowId, after: windowId, reason: '多窗口操作必须显式选择' }); notify('目标窗口已锁定', windowId, 'success'); }
    catch (error) { fail('窗口选择失败', error); }
  };

  const disconnect = () => { dispatch({ type: 'PATCH_EDA', patch: { connected: false, bridgeStatus: 'stopped', activeWindowId: null, windows: [], windowCount: 0 } }); dispatch({ type: 'PATCH_RUNTIME', patch: { mode: 'demo' } }); addAudit('eda', '断开本地桥接会话', '仅清除CircuitPilot本地会话，不关闭嘉立创EDA', 'warning'); notify('连接已断开', '所有 EDA 命令已停止。', 'warning'); };

  const addBlockedLog = (command: string, reason: string) => {
    const log: CommandLog = { id: `cmd-${Date.now()}`, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), command, permission: 'write', duration: 0, result: `BLOCKED: ${reason}`, status: 'blocked' };
    dispatch({ type: 'ADD_COMMAND_LOG', log }); addAudit('eda', '写命令被门禁阻断', `${command} · ${reason}`, 'warning'); reportIssue({ fingerprint: `eda:WRITE_BLOCKED:${command}`, source: 'eda', severity: 'warning', status: 'open', code: 'EDA_WRITE_BLOCKED', summary: '真实写命令被安全门禁阻断', detail: reason, context: { command }, suggestedAction: '完成命令注册、快照和验证闭环后再开放。' }); notify('写命令被阻断', reason, 'danger');
  };

  const readDesignContext = async () => {
    setDesignBusy('context');
    try { const value = await runtimeClient.designContext(); setDesignContext(value); setApproval(null); setExecution(null); addAudit('eda', '读取完整设计上下文', `${value.windowId} · ${value.targetFingerprint.slice(0, 12)}`, 'success'); notify('设计上下文已锁定', '已读取工程、文档、元件、引脚、导线和源码摘要。', 'success'); }
    catch (error) { const detail = explain(error); reportIssue({ fingerprint: 'eda:DESIGN_CONTEXT', source: 'eda', severity: 'error', status: 'open', code: error instanceof RuntimeApiError ? error.code : 'DESIGN_CONTEXT_FAILED', summary: '完整设计读取失败', detail, suggestedAction: '确认已选择一个打开原理图的嘉立创EDA窗口。' }); notify('读取失败', detail, 'danger'); }
    finally { setDesignBusy(null); }
  };

  const openProjectSchematic = async () => {
    setDesignBusy('open-schematic');
    try {
      const opened = await runtimeClient.openCurrentSchematic(activeProject?.edaWorkspace?.schematicPageUuid);
      const value = await runtimeClient.designContext();
      setDesignContext(value); setApproval(null); setExecution(null);
      notify('项目原理图已打开', `${opened.documentUuid.slice(0, 12)} · 已锁定执行目标。`, 'success');
    } catch (error) { fail('打开原理图失败', error); }
    finally { setDesignBusy(null); }
  };

  const validatePlan = async () => {
    setDesignBusy('plan');
    try { const parsed = JSON.parse(planText); const withLineage = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && importedSchematic?.planHash && !(parsed as { semanticPlanHash?: string }).semanticPlanHash ? { ...parsed, semanticPlanHash: importedSchematic.planHash } : parsed; const value = await runtimeClient.normalizeDesignPlan(withLineage); setPlanning(value); setApproval(null); setExecution(null); recordChange({ source: 'ai', actor: 'CircuitPilot Runtime', action: 'plan', objectType: 'schematic-plan', objectId: value.planHash, summary: value.ready ? '简单控制板计划可审批' : `计划仍缺少${value.missing.length}项`, after: { planHash: value.planHash, missing: value.missing }, reason: '固定Schema校验与稳定哈希' }); const hashMismatch = importedSchematic?.planHash && value.planHash !== importedSchematic.planHash; notify(value.ready ? '计划校验通过' : '计划尚不能批准', hashMismatch ? `注意：本次哈希 ${value.planHash.slice(0, 12)} 与提案交接的 ${importedSchematic?.planHash?.slice(0, 12)} 不一致（计划被编辑过或校验规则变化），批准将绑定本次哈希。` : (value.ready ? `哈希 ${value.planHash.slice(0, 12)}` : value.missing.join('、')), hashMismatch ? 'warning' : value.ready ? 'success' : 'warning'); }
    catch (error) { notify('计划格式错误', explain(error), 'danger'); }
    finally { setDesignBusy(null); }
  };

  const generateAiPlan = async () => {
    setDesignAiTask(null);
    const task = createSingleCallTask<{ status: 'ready' | 'blocked'; explanation: string; blockers: string[]; netlist: Record<string, unknown> | null; compilation: SimpleBoardPlanResult | null }>({
      timeoutMs: 300_000,
      onUpdate: setDesignAiTask,
      call: async (signal) => {
        // A4：先采集真实引脚证据，再让 AI 生成网表；证据审计不通过就**不生成**（不给"猜网络"的机会）。
      // 从零设计（当前没有 PCB 文档）时没有焊盘可读：明确标注"无引脚证据"，不伪造。
      let pinEvidence: Awaited<ReturnType<typeof runtimeClient.pinEvidence>>['evidence'] | null = null;
      let pinNote = '';
      try {
        const collected = await runtimeClient.pinEvidence({ includeSchematic: true }, { signal });
        if (!collected.audit.ok) {
          // fail-closed：证据不足时不生成网表；以失败收尾，长任务面板如实显示原因。
          throw new Error(`引脚证据不足，已阻断网表生成：${collected.audit.blockers.map((item) => item.message).join('；').slice(0, 300)}`);
        }
        pinEvidence = collected.evidence;
        pinNote = `引脚证据：${collected.audit.counts.withNet}/${collected.audit.counts.pins} 焊盘有网络`;
      } catch (error) {
        if (error instanceof RuntimeApiError && (error.code === 'PCB_DOCUMENT_REQUIRED' || error.code === 'EDA_DOCUMENT_REQUIRED' || error.code === 'EDA_NOT_CONNECTED')) {
          pinNote = '从零设计（当前没有 PCB 文档）：本次网表生成没有引脚证据';
        } else {
          throw error;
        }
      }
      const result = await runtimeClient.generateReviewedNetlist({ project: activeProject, requirements: projectRequirements, components: projectComponents, assets: projectAssets }, state.settings.model === 'auto' ? null : state.settings.model, aiProviderId, aiProviderBaseUrl, { pinEvidence, requirePinEvidence: Boolean(pinEvidence), signal });
      setReviewedNetlist(result.netlist); setPlanning(result.compilation); if (result.compilation?.plan) setPlanText(JSON.stringify(result.compilation.plan, null, 2)); setApproval(null); setExecution(null); setAdvancedOpen(true); addAudit('ai', 'AI生成项目网络表草案', `${activeProject?.code || state.activeProjectId} · ${result.status}${pinNote ? ` · ${pinNote}` : ''}`, result.status === 'ready' ? 'success' : 'warning'); notify(result.status === 'ready' ? '网络表草案已生成' : '网络表仍缺少关键信息', result.status === 'ready' ? `请检查网络与引脚，随后打开原理图并批准。${pinNote ? `（${pinNote}）` : ''}` : result.blockers.join('、'), result.status === 'ready' ? 'success' : 'warning');
        return result;
      },
    });
    designAiTaskRef.current = task;
    const settled = await task.startTask();
    if (settled.status === 'failed') fail('AI计划生成失败', new Error(settled.error || '生成失败'));
    else if (settled.status !== 'done') notify('已停止等待 AI 计划生成', settled.note || '本页已停止等待；模型/服务端可能仍在生成，稍后可重试。', 'warning');
  };

  const approvePlan = async () => {
    if (!planning?.ready || !designContext) return notify('无法批准', '请先读取真实上下文并补全计划。', 'warning');
    setDesignBusy('approve');
    try { const value = await runtimeClient.approveDesign({ plan: planning.plan, targetFingerprint: designContext.targetFingerprint, windowId: designContext.windowId, ...designTargetBinding }); setApproval(value); addAudit('eda', '人工批准受控原理图计划', `${value.planHash.slice(0, 12)} · 令牌5分钟内一次有效`, 'success'); recordChange({ source: 'user', actor: '本机用户', action: 'approve', objectType: 'schematic-plan', objectId: value.planHash, summary: '批准绑定目标和步骤的不可变计划', after: { windowId: value.windowId, expiresAt: value.expiresAt }, reason: '真实写入前人工确认' }); clearSchematicPlanDraft(); setImportedSchematic(null); notify('计划已批准', '一次性令牌已绑定当前窗口、文档指纹和计划哈希。', 'success'); }
    catch (error) { fail('批准失败', error); }
    finally { setDesignBusy(null); }
  };

  const loadPcbWriteLock = async () => {
    if (state.runtime.mode === 'demo') return;
    try {
      const status = await runtimeClient.getPcbWriteLock();
      setPcbWriteLock(status);
      setLockError(null);
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      // 读不到锁状态要如实说（不能因为读失败就当"没锁"）。
      setLockError(detail);
    }
  };

  /** P0-4：人工解除写锁。必须留 operator/note；失败就把服务端原因显示出来，不假装解锁。 */
  const releaseWriteLock = async () => {
    if (!lockOperator.trim() || !lockNote.trim()) return notify('解除写锁需要留痕', '请填写操作人与现场确认说明（至少说明检查了哪些位置/为何可继续写入）。', 'warning');
    setLockBusy(true); setLockError(null);
    try {
      const result = await runtimeClient.releasePcbWriteLock({ operator: lockOperator.trim(), note: lockNote.trim() });
      if (!result.released) {
        const reason = result.reason === 'not-locked' ? '服务端当前并未锁死（可能是别处已解除/状态已变）' : result.reason || '服务端拒绝解除';
        setLockError(reason);
        notify('写锁未解除', reason, 'warning');
      } else {
        addAudit('eda', '人工解除PCB安全写锁', `${lockOperator.trim()} · ${lockNote.trim()}`, 'warning');
        notify('PCB 安全写锁已解除', '已记录操作人与说明；后续写入仍会重新走受控批准与目标绑定校验。', 'success');
        setLockNote('');
      }
      await loadPcbWriteLock();
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      setLockError(detail);
      addAudit('eda', '解除PCB安全写锁失败', detail, 'error');
      notify('解除写锁失败', detail, 'danger');
    } finally { setLockBusy(false); }
  };

  const loadExecutionHistory = async () => {
    if (state.runtime.mode === 'demo') return;
    setExecutionHistory((current) => ({ ...current, busy: true, error: '' }));
    try {
      // 刷新执行记录时顺带拉一次写锁状态（P0-4：锁可能与执行记录同时变化）。
      const [design, pcb, lock] = await Promise.all([
        runtimeClient.designExecutions(),
        runtimeClient.pcbExecutions(),
        runtimeClient.getPcbWriteLock().catch(() => null),
      ]);
      if (lock) { setPcbWriteLock(lock); setLockError(null); }
      setExecutionHistory({
        design: design.executions,
        pcb: pcb.executions,
        persistenceError: design.persistenceError?.message || pcb.persistenceError?.message || null,
        busy: false,
        error: '',
      });
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      setExecutionHistory((current) => ({ ...current, busy: false, error: detail }));
    }
  };

  const openExecutionDetail = async (item: ExecutionHistoryItem) => {
    try {
      const execution = item.kind === 'schematic' ? await runtimeClient.designExecution(item.id) : await runtimeClient.pcbExecution(item.id);
      setHistoryDetail({ kind: item.kind, execution });
    } catch (error) {
      fail('读取执行详情失败', error);
    }
  };

  const executePlan = async () => {
    if (!approval || !planning || !designContext) return notify('无法执行', '缺少有效批准或目标上下文。', 'warning');
    if (!schematicExecutionGate.allowed) return notify('写入门禁未通过', schematicExecutionGate.reason, 'warning');
    const task = createSingleCallTask<DesignExecution>({
      timeoutMs: 160_000,
      onUpdate: setDesignExecTask,
      call: async (signal) => {
        const value = await runtimeClient.executeDesign({ plan: planning.plan, approvalToken: approval.token, targetFingerprint: designContext.targetFingerprint, windowId: designContext.windowId, ...designTargetBinding }, { signal }); setExecution(value); setApproval(null); void loadExecutionHistory(); const ok = value.state === 'completed'; if (ok && activeProject?.edaWorkspace) { const executedAt = new Date().toISOString(); const patched = applyEvidencePatch(activeProject, { schematicStatus: 'generated', schematicExecutedAt: executedAt, schematicExecutionId: value.id }, executedAt); const attempt = tryAdvanceProjectStage(state, patched); dispatch({ type: 'UPDATE_PROJECT', project: attempt.project }); addAudit('project', '阶段证据写入', attempt.advanced.length ? `原理图执行回读成功，证据齐备，自动推进到 ${attempt.advanced.join('→')}。` : `原理图执行回读成功，证据已记录；阶段未推进（相邻阶段门禁未过）：${attempt.blocked.join('；')}`, attempt.advanced.length ? 'success' : 'info'); } addAudit('eda', ok ? '受控原理图执行完成' : '受控原理图执行未完成', `${value.id} · ${value.state}`, ok ? 'success' : 'error'); recordChange({ source: 'runtime', actor: 'CircuitPilot Runtime', action: 'execute', objectType: 'schematic-execution', objectId: value.id, summary: `执行状态：${value.state}`, after: { events: value.events, snapshot: value.snapshot, drc: value.drc, error: value.error }, reason: '快照→写入→保存→回读→DRC→必要时恢复' }); if (!ok) reportIssue({ fingerprint: `eda:EXECUTION:${value.error?.code || value.state}`, source: 'eda', severity: value.state === 'rollback_failed' ? 'critical' : 'error', status: 'open', code: value.error?.code || value.state, summary: '受控原理图执行未成功', detail: value.error?.message || value.state, context: { executionId: value.id, recoveryState: value.state }, suggestedAction: value.state === 'rolled_back' ? '已验证恢复，可修正计划后重新审批。' : '停止写入并按快照证据人工检查工程。' }); notify(ok ? '原理图执行完成' : '执行已停止', ok ? '保存、回读和官方原理图DRC均通过。' : `${value.state} · ${value.error?.message || ''}`, ok ? 'success' : 'danger');
        return value;
      },
    });
    designExecTaskRef.current = task;
    const settled = await task.startTask();
    if (settled.status === 'failed') fail('执行请求失败', new Error(settled.error || '执行失败'));
    else if (settled.status !== 'done') notify('已停止等待原理图执行', settled.note || '本页已停止等待；服务端可能仍在执行或已落盘，以审计与回读为准。', 'warning');
  };

  const readPcbContext = async () => {
    setPcbBusy('context');
    try {
      const value = await runtimeClient.pcbContext();
      syncPcbContext(value); setPcbApproval(null); setPcbExecution(null);
      addAudit('eda', '读取真实PCB上下文', `${value.windowId} · ${value.targetFingerprint.slice(0, 12)}`, 'success');
      if (!value.complete) reportIssue({ fingerprint: 'eda:PCB_CONTEXT_INCOMPLETE', source: 'eda', severity: 'error', status: 'open', code: 'PCB_CONTEXT_INCOMPLETE', summary: 'PCB上下文读取不完整', detail: (value.pcb?.readErrors || []).map((item) => `${item.name}: ${item.error}`).join('；'), suggestedAction: '确认当前为PCB文档，并检查嘉立创EDA版本/API兼容性；读取完整前禁止批准。' });
      notify(value.complete ? 'PCB上下文已锁定' : 'PCB上下文读取不完整', value.complete ? `器件 ${value.pcb?.components?.length ?? 0} · 走线 ${value.pcb?.lines?.length ?? 0} · 过孔 ${value.pcb?.vias?.length ?? 0}` : (value.pcb?.readErrors || []).map((item) => item.name).join('、'), value.complete ? 'success' : 'danger');
    } catch (error) { fail('PCB读取失败', error); }
    finally { setPcbBusy(null); }
  };

  const openPcbDocument = async () => {
    setPcbBusy('open');
    try {
      await runtimeClient.openPcb(pcbDocumentUuid.trim());
      setPcbContext(null); setPcbApproval(null); setPcbExecution(null);
      notify('PCB文档已打开', '嘉立创EDA已切换到PCB编辑器，请继续读取真实PCB。', 'success');
    } catch (error) { fail('打开PCB失败', error); }
    finally { setPcbBusy(null); }
  };

  const compilePcbPlan = async () => {
    setPcbBusy('compile');
    try {
      const value = await runtimeClient.compileCh32v003Pcb({});
      setPcbPlanning(value); setPcbPlanText(JSON.stringify(value.plan, null, 2)); setPcbApproval(null); setPcbExecution(null);
      notify('PCB候选计划已编译', `固定计划哈希 ${value.planHash.slice(0, 12)}；执行前请补充并复核器件、走线、过孔和覆铜操作。`, 'warning');
    } catch (error) { notify('PCB编译失败', explain(error), 'danger'); }
    finally { setPcbBusy(null); }
  };

  const validatePcbPlan = async () => {
    setPcbBusy('validate');
    try {
      const value = await runtimeClient.normalizePcbPlan(JSON.parse(pcbPlanText));
      setPcbPlanning(value); setPcbApproval(null); setPcbExecution(null);
      notify(value.ready ? 'PCB计划结构有效' : 'PCB计划仍被阻断', value.ready ? `哈希 ${value.planHash.slice(0, 12)}；仍需人工核对每项几何操作。` : value.missing.join('、'), value.ready ? 'warning' : 'danger');
    } catch (error) { notify('PCB计划格式错误', explain(error), 'danger'); }
    finally { setPcbBusy(null); }
  };

  const approvePcbPlan = async () => {
    if (!pcbPlanning?.ready || !pcbContext?.complete) return notify('无法批准PCB', '请先完整读取真实PCB并校验计划。', 'warning');
    setPcbBusy('approve');
    try {
      const value = await runtimeClient.approvePcb({ plan: pcbPlanning.plan, targetFingerprint: pcbContext.targetFingerprint, windowId: pcbContext.windowId });
      setPcbApproval(value);
      recordChange({ source: 'user', actor: '本机用户', action: 'approve', objectType: 'pcb-plan', objectId: value.planHash, summary: '批准绑定真实PCB目标的不可变计划', after: { windowId: value.windowId, expiresAt: value.expiresAt }, reason: 'PCB真实写入前人工确认' });
      notify('PCB计划已批准', '一次性令牌已绑定窗口、源码指纹和计划哈希。', 'success');
    } catch (error) { notify('PCB批准失败', explain(error), 'danger'); }
    finally { setPcbBusy(null); }
  };

  const executePcbPlan = async () => {
    if (!pcbApproval || !pcbPlanning || !pcbContext) return notify('无法执行PCB', '缺少有效批准或真实目标上下文。', 'warning');
    if (!pcbExecutionGate.allowed) return notify('写入门禁未通过', pcbExecutionGate.reason, 'warning');
    const task = createSingleCallTask<PcbExecution>({
      timeoutMs: 190_000,
      onUpdate: setPcbExecTask,
      call: async (signal) => {
        const value = await runtimeClient.executePcb({ plan: pcbPlanning.plan, approvalToken: pcbApproval.token, targetFingerprint: pcbContext.targetFingerprint, windowId: pcbContext.windowId }, { signal });
      setPcbExecution(value); setPcbApproval(null); void loadExecutionHistory();
      const ok = value.state === 'completed';
      recordChange({ source: 'runtime', actor: 'CircuitPilot Runtime', action: 'execute', objectType: 'pcb-execution', objectId: value.id, summary: `PCB执行状态：${value.state}`, after: { events: value.events, readback: value.readback, drc: value.drc, error: value.error }, reason: '快照→受控写入→保存→完整回读→官方DRC→必要时恢复' });
      if (!ok) reportIssue({ fingerprint: `eda:PCB_EXECUTION:${value.error?.code || value.state}`, source: 'eda', severity: value.state === 'rollback_failed' ? 'critical' : 'error', status: 'open', code: value.error?.code || value.state, summary: 'PCB受控执行未成功', detail: value.error?.message || value.state, context: { executionId: value.id, recoveryState: value.state }, suggestedAction: value.state === 'rolled_back' ? '快照已恢复，可修正计划后重新审批。' : '写入已锁定，请人工检查嘉立创EDA工程并重启Runtime。' });
      notify(ok ? 'PCB执行完成' : 'PCB执行已停止', ok ? '保存、回读和官方PCB DRC均通过。' : `${value.state} · ${value.error?.message || ''}`, ok ? 'success' : 'danger');
        return value;
      },
    });
    pcbExecTaskRef.current = task;
    const settled = await task.startTask();
    if (settled.status === 'failed') notify('PCB执行请求失败', settled.error || '执行失败', 'danger');
    else if (settled.status !== 'done') notify('已停止等待PCB执行', settled.note || '本页已停止等待；服务端可能仍在写入或已落盘，以审计与回读为准。', 'warning');
  };

  const execute = async (command: typeof commands[number]) => {
    if (command.permission === 'write') return addBlockedLog(command.command, '写命令不能从命令卡直接运行；请使用上方“读取→校验→批准→执行”受控流程');
    if (!state.eda.connected) return notify('命令被阻断', '请先运行环境检查并连接Bridge。', 'danger');
    setRunningCommand(command.command);
    try {
      if (!realSession) {
        const log = await demoAdapter.executeCommand(command.command, command.permission); dispatch({ type: 'ADD_COMMAND_LOG', log }); addAudit('eda', '执行Demo只读命令', command.command, 'warning'); notify('Demo命令完成', `${command.command} · ${log.duration} ms`, 'warning'); return;
      }
      if (command.command === 'eda.connection.health' || command.command === 'eda.window.list') {
        const startedAt = performance.now(); await runDiagnostics();
        const log: CommandLog = { id: `cmd-${Date.now()}`, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), command: command.command, permission: 'read', duration: Math.round(performance.now() - startedAt), result: JSON.stringify({ bridgeStatus: state.eda.bridgeStatus, windowCount: state.eda.windowCount, mode: 'real_read_only' }), status: 'success' };
        dispatch({ type: 'ADD_COMMAND_LOG', log }); return;
      }
      if (!command.runtimeId) throw new RuntimeApiError('EDA_COMMAND_NOT_ALLOWED', '命令未注册');
      const result = await runtimeClient.executeCommand(command.runtimeId);
      const log: CommandLog = { id: `cmd-${Date.now()}`, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), command: command.command, permission: 'read', duration: result.duration, result: JSON.stringify(result.result), status: 'success' };
      dispatch({ type: 'ADD_COMMAND_LOG', log });
      dispatch({ type: 'PATCH_EDA', patch: command.runtimeId === 'project.current' ? { projectInfo: result.result } : { documentInfo: result.result } });
      addAudit('eda', '执行真实只读命令', `${command.command} · ${result.duration}ms`, 'success'); recordChange({ source: 'eda', actor: 'CircuitPilot Runtime', action: 'read', objectType: command.runtimeId === 'project.current' ? 'eda-project' : 'eda-document', objectId: state.eda.activeWindowId || 'active-window', summary: command.label, after: result.result, reason: '固定只读上下文回读', relations: { command: command.command } }); notify('只读回读完成', `${command.command} · ${result.duration} ms`, 'success');
    } catch (error) {
      const detail = explain(error); const log: CommandLog = { id: `cmd-${Date.now()}`, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), command: command.command, permission: 'read', duration: 0, result: detail, status: 'error' };
      dispatch({ type: 'ADD_COMMAND_LOG', log }); addAudit('eda', 'EDA命令失败', `${command.command} · ${detail}`, 'error'); reportIssue({ fingerprint: `eda:COMMAND:${command.command}`, source: 'eda', severity: 'error', status: 'open', code: error instanceof RuntimeApiError ? error.code : 'EDA_COMMAND_FAILED', summary: `${command.label}失败`, detail, context: { command: command.command, windowId: state.eda.activeWindowId || '' }, suggestedAction: '检查Bridge、目标窗口和当前文档后重试。' }); notify('命令失败', detail, 'danger');
    } finally { setRunningCommand(null); }
  };

  const previewComponents = (pcbContext?.pcb.components || []).slice(0, 80).map((raw, index) => {
    const item = (raw || {}) as Record<string, unknown>; const position = (item.position || {}) as Record<string, unknown>;
    const numeric = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return { id: String(item.primitiveId || item.id || item.ref || index), ref: String(item.ref || item.designator || `U${index + 1}`), x: numeric(item.x ?? position.x, (index * 47) % 520), y: numeric(item.y ?? position.y, (index * 71) % 300) };
  });
  const previewLines = (pcbContext?.pcb.lines || []).slice(0, 120).map((raw, index) => {
    const item = (raw || {}) as Record<string, unknown>; const start = (item.start || {}) as Record<string, unknown>; const end = (item.end || {}) as Record<string, unknown>;
    const numeric = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return { id: String(item.primitiveId || item.id || index), x1: numeric(item.startX ?? start.x, 20), y1: numeric(item.startY ?? start.y, 20), x2: numeric(item.endX ?? end.x, 540), y2: numeric(item.endY ?? end.y, 320) };
  });

  return <>
    <section className="eda-copilot" aria-label="AI PCB设计工作台">
      <header className="eda-copilot__header"><div><span className="eyebrow">CONVERSATION-DRIVEN PCB DESIGN</span><h2>AI 直接协助当前项目设计</h2><p>当前项目：<strong>{activeProject?.name || '未选择'}</strong>。先绑定本项目的嘉立创EDA Board，再按“网络表→原理图→PCB”执行。</p></div><div className="toolbar toolbar--wrap"><Button variant="primary" icon={<Layers3 size={15} />} loading={creatingWorkspace} disabled={writeGateClosed} title={writeGateClosed ? '写入已暂停（全局或本会话）：恢复后才能创建 EDA 设计文件' : undefined} onClick={() => setCreateWorkspaceOpen(true)}>新建EDA文件</Button><Button icon={<Cable size={15} />} loading={creatingWorkspace} onClick={bindCurrentEasyEdaWorkspace}>绑定当前EDA设计</Button><Button icon={<RefreshCw size={15} />} loading={pcbBusy === 'context'} onClick={readPcbContext}>读取当前PCB</Button><Button icon={<ExternalLink size={15} />} onClick={focusEasyEda}>在嘉立创EDA中查看</Button></div></header>
      <div className="eda-copilot__grid">
        <div className="eda-preview">
          <div className="eda-preview__bar"><span><Layers3 size={15} /> PCB 同步预览</span><Badge tone={pcbContext?.complete ? 'success' : pcbContext ? 'warning' : 'neutral'}>{pcbContext?.complete ? '上次读取证据' : pcbContext ? '读取不完整' : '待同步'}</Badge></div>
          <div className="eda-preview__canvas">
            <svg viewBox="0 0 600 360" role="img" aria-label="当前PCB图元摘要"><defs><pattern id="pcb-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(20,122,90,.14)" strokeWidth="1" /></pattern></defs><rect x="14" y="14" width="572" height="332" rx="8" fill="url(#pcb-grid)" stroke="#46b98a" strokeWidth="2" />{previewLines.map((line) => <line key={line.id} x1={20 + Math.abs(line.x1) % 560} y1={20 + Math.abs(line.y1) % 320} x2={20 + Math.abs(line.x2) % 560} y2={20 + Math.abs(line.y2) % 320} stroke="#d88933" strokeWidth="2" opacity=".75" />)}{previewComponents.map((component) => <g key={component.id} transform={`translate(${24 + Math.abs(component.x) % 540} ${24 + Math.abs(component.y) % 300})`}><rect x="-12" y="-8" width="24" height="16" rx="2" fill="#173e35" stroke="#7be0ba" /><text y="-12" textAnchor="middle" fill="#c8f7e5" fontSize="8">{component.ref}</text></g>)}</svg>
            {!pcbContext && <div className="eda-preview__empty"><MonitorCog size={30} /><strong>新项目点击“新建EDA文件”</strong><span>后台会打开嘉立创EDA并创建工程、原理图和PCB；已有设计则点击“读取当前EDA设计”。</span></div>}
          </div>
          <div className="eda-preview__metrics"><span>元件 <strong>{pcbContext?.pcb.components?.length ?? '—'}</strong></span><span>走线 <strong>{pcbContext?.pcb.lines?.length ?? '—'}</strong></span><span>过孔 <strong>{pcbContext?.pcb.vias?.length ?? '—'}</strong></span><span>铺铜 <strong>{pcbContext?.pcb.pours?.length ?? '—'}</strong></span></div>
        </div>
        <div className="eda-conversation"><div><span className="eyebrow">DESIGN INSTRUCTION</span><h3>告诉 AI 如何设计或微调</h3><p>例如：“把 USB-C 放在短边中心，天线净空区不铺铜，优先缩短电源回路。”</p></div><textarea aria-label="PCB设计指令" value={designInstruction} onChange={(event) => setDesignInstruction(event.target.value)} rows={5} placeholder="输入本轮PCB设计或微调需求…" /><Button variant={activeProject?.edaWorkspace ? 'primary' : 'secondary'} icon={<Send size={15} />} loading={conversationBusy} disabled={!activeProject?.edaWorkspace} title={!activeProject?.edaWorkspace ? '请先绑定当前EDA设计，再让AI生成方案' : undefined} onClick={generateConversationPlan}>生成可审核设计方案</Button>
          {conversationCandidate && <div className={`eda-candidate eda-candidate--${conversationCandidate.status}`}><div className="eda-candidate__title"><Badge tone={conversationCandidate.status === 'ready' ? 'success' : 'warning'}>{conversationCandidate.status === 'ready' ? '可审核' : '需补充信息'}</Badge><strong>{conversationCandidate.explanation}</strong></div>{conversationCandidate.blockingInformation.length > 0 && <ol>{conversationCandidate.blockingInformation.map((item) => <li key={item.code}><strong>{item.question}</strong><span>{item.reason}</span></li>)}</ol>}{compiledCandidate?.quality && <div className="eda-candidate__diff"><span>元件 {compiledCandidate.quality.metrics.componentCount ?? 0}</span><span>网络 {compiledCandidate.quality.metrics.netCount ?? 0}</span><span>走线段 {compiledCandidate.quality.metrics.trackSegmentCount ?? 0}</span><span>{compiledCandidate.quality.passed ? '本地质量门通过' : '需处理质量问题'}</span></div>}{conversationCandidate.status === 'ready' && <Button icon={<ShieldCheck size={15} />} loading={conversationBusy} onClick={prepareCandidateForExecution}>确认方案并准备执行</Button>}</div>}
          {createdWorkspace && <div className="eda-created-workspace"><Badge tone="success">EDA已绑定</Badge><span>{createdWorkspace.boardName} · 工程 {createdWorkspace.projectUuid.slice(0, 8)} · 原理图 {createdWorkspace.schematicUuid.slice(0, 8)} · PCB {createdWorkspace.pcbUuid.slice(0, 8)}</span></div>}
          <div className="eda-execute-control">{!activeProject?.edaWorkspace ? <Button variant="primary" icon={<Cable size={16} />} loading={creatingWorkspace} onClick={bindCurrentEasyEdaWorkspace}>1. 绑定当前EDA设计</Button> : activeProject.edaWorkspace.schematicStatus !== 'generated' ? <Button variant="primary" icon={<Bot size={16} />} loading={designAiTask?.status === 'running'} onClick={generateAiPlan}>2. 生成并审核原理图</Button> : <Button variant="primary" icon={<Play size={16} />} loading={conversationBusy || pcbBusy === 'execute' || pcbBusy === 'context'} onClick={requestConversationExecution}>3. 同步原理图到PCB</Button>}<span>{!activeProject?.edaWorkspace ? '当前阻断：尚未保存当前项目对应的EDA文档身份。' : activeProject.edaWorkspace.schematicStatus !== 'generated' ? '当前阶段：原理图文档为空，必须先生成网络表并完成原理图受控写入。' : '原理图已生成；点击后重新读取目标PCB并进行最终确认。'}</span></div>
          <small className="eda-safety-note">确认方案不会立即写板；只有点击“开始执行EDA设计”并通过最终确认后才会真实写入。</small></div>
      </div>
    </section>
    <button type="button" className={`advanced-toggle ${advancedOpen ? 'is-open' : ''}`} onClick={() => setAdvancedOpen((value) => !value)} aria-expanded={advancedOpen}><span><Code2 size={17} /><strong>高级控制</strong><small>连接诊断、计划审批、写入执行与命令日志</small></span><ChevronDown size={18} /></button>
    {advancedOpen && <>
    <div className="stats-grid stats-grid--4"><Stat label="桥接状态" value={state.eda.connected ? '已连接' : '未连接'} hint={`127.0.0.1:${state.eda.port}`} tone={state.eda.connected ? 'success' : 'danger'} /><Stat label="活动窗口" value={state.eda.windowCount} hint={state.eda.activeWindowId || '未选择'} /><Stat label="命令记录" value={state.eda.commandLogs.length} hint={realSession ? '真实Runtime会话' : 'Demo会话'} /><Stat label="真实写权限" value={canWrite ? '审批后开放' : '默认拒绝'} hint="仅允许固定命令、一次性批准与可验证恢复" tone="warning" /></div>
    <div className="split-layout split-layout--eda">
      <Panel eyebrow="LOCAL BRIDGE" title="连接与环境" meta={state.runtime.reachable ? '真实扫描 127.0.0.1:49620-49629' : 'Runtime离线 · 显式Demo降级'} actions={<><Button icon={<RefreshCw size={15} />} onClick={runDiagnostics}>重连</Button>{state.eda.connected && <Button variant="danger" icon={<Unplug size={15} />} onClick={() => setDisconnectOpen(true)}>断开</Button>}</>}>
        <div className="connection-hero"><div className={`bridge-orbit ${state.eda.connected ? 'is-connected' : ''}`}><Cable size={28} /></div><div><Badge tone={state.eda.connected ? 'success' : 'danger'}>{state.eda.connected ? realSession ? 'CONNECTED · REAL READ ONLY' : 'CONNECTED · DEMO' : 'DISCONNECTED'}</Badge><h3>EasyEDA Bridge</h3><code>http://127.0.0.1:{state.eda.port}</code></div></div>
        <div className="diagnostic-list">{state.eda.diagnostics.map((item) => <div className={`diagnostic diagnostic--${item.status}`} key={item.id}>{item.status === 'pass' ? <CheckCircle2 size={17} /> : item.status === 'fail' ? <XCircle size={17} /> : item.status === 'checking' ? <RefreshCw className="spin" size={17} /> : <CircleStop size={17} />}<span><strong>{item.name}</strong><small>{item.detail}</small></span><Badge tone={item.status === 'pass' ? 'success' : item.status === 'fail' ? 'danger' : 'neutral'}>{item.status === 'pass' ? '通过' : item.status === 'fail' ? '失败' : '待检查'}</Badge></div>)}</div>
        <Button variant="primary" loading={checking} icon={<MonitorCog size={16} />} onClick={runDiagnostics}>运行全量检查</Button>
      </Panel>
      <Panel eyebrow="WINDOW & WRITE GATE" title="会话控制" meta="多窗口必须人工选定目标"><div className="detail-stack"><Toggle checked={state.settings.sessionPaused === true} disabled={state.settings.writePaused} onChange={(checked) => { void setSessionWritePaused(checked); }} label="暂停本会话写入" description={state.settings.writePaused ? '全局“暂停所有写入”正在生效并覆盖此开关；请在系统设置中解除后再单独控制本会话。' : '由 Runtime 执行（scope=session）：立即阻断本会话所有写命令，不影响只读诊断；全局暂停不受影响。'} />{state.eda.windows.length > 0 && <div className="window-picker">{state.eda.windows.map((windowItem) => <button type="button" key={windowItem.windowId} className={state.eda.activeWindowId === windowItem.windowId ? 'is-selected' : ''} onClick={() => selectWindow(windowItem.windowId)}><span className="window-thumb"><MonitorCog size={20} /></span><span><strong>{windowItem.title || windowItem.projectName || '嘉立创EDA窗口'}</strong><small>{windowItem.windowId}</small></span></button>)}</div>}<div className="permission-matrix"><div><span>固定只读命令</span><strong className="text-success">连接后允许</strong></div><div><span>真实写命令</span><strong className="text-warning">计划校验与一次性批准后允许</strong></div><div><span>任意脚本</span><strong className="text-danger">永不允许</strong></div></div></div></Panel>
    </div>
    <Panel eyebrow="PCB PRODUCTION CAPABILITIES" title="真实 PCB 能力矩阵" meta={pcbCapabilities ? `嘉立创EDA ${pcbCapabilities.edaVersion} · API v${pcbCapabilities.apiVersion}` : '运行环境检查后读取'}><div className="permission-matrix">{(pcbCapabilities?.items || []).map((item) => <div key={item.id}><span>{item.id}</span><strong className={item.production ? 'text-success' : item.status === 'unavailable' ? 'text-danger' : 'text-warning'}>{item.status}{item.production ? ' · 可作为生产链路' : ' · 需人工复核'}</strong><small>{item.reason || item.api}</small></div>)}</div>{edaAdaptation ? <div className={`inline-alert inline-alert--${edaAdaptation.level === 'ok' ? 'info' : 'warning'}`} style={{ marginTop: 10 }}>{edaAdaptation.level === 'ok' ? null : <TriangleAlert size={16} />}<span>版本适配：<strong>{edaAdaptation.status}</strong>（来源 {edaAdaptation.versionSource} · {edaAdaptation.version || '未知'}）。{edaAdaptation.warnings[0] || edaAdaptation.guidance}{edaAdaptation.degradations.length ? ` 已知降级：${edaAdaptation.degradations.slice(0, 2).join('；')}` : ''}</span></div> : null}</Panel>
    <Panel eyebrow="CONTROLLED PCB PIPELINE" title="PCB真实读取、审批与执行" meta="所有写入均绑定一次性批准；Beta图元必须回读、DRC和人工复核">
      {pcbWriteLock?.safetyLocked ? (
        <div className="inline-alert inline-alert--danger" role="alert" data-testid="pcb-write-lock-banner">
          <ShieldAlert size={16} />
          <div style={{ display: 'grid', gap: 6 }}>
            <strong>上次回滚失败，PCB 写锁仍在：后续写入会被 409 PCB_WRITE_LOCKED</strong>
            <span>回滚失败可能留下半写状态。请先在嘉立创EDA 人工核对工程（器件/走线/覆铜）确认现场，再解除写锁；重启 Runtime 不会自动解除。</span>
            <div className="row-actions" style={{ flexWrap: 'wrap' }}>
              <input className="input" value={lockOperator} onChange={(event) => setLockOperator(event.target.value)} placeholder="操作人（operator）" aria-label="解除写锁操作人" style={{ maxWidth: 160 }} />
              <input className="input" value={lockNote} onChange={(event) => setLockNote(event.target.value)} placeholder="现场确认说明（note，必填）" aria-label="解除写锁说明" style={{ minWidth: 260 }} />
              <Button variant="danger" icon={<LockKeyhole size={14} />} loading={lockBusy} disabled={!lockOperator.trim() || !lockNote.trim()} onClick={() => void releaseWriteLock()}>确认现场后解除写锁</Button>
            </div>
            {lockError ? <small>锁状态读取/解除失败：{lockError}</small> : null}
          </div>
        </div>
      ) : lockError ? (
        <div className="inline-alert inline-alert--warning"><TriangleAlert size={16} /><span>PCB 写锁状态读取失败：{lockError}（读不到不等于没锁，写入前请重试）。</span></div>
      ) : null}
      <div className="detail-stack"><div className="toolbar toolbar--wrap"><label className="search-box"><input aria-label="PCB文档UUID" value={pcbDocumentUuid} onChange={(event) => changePcbDocumentUuid(event.target.value)} placeholder="PCB文档UUID" /></label><Button icon={<MonitorCog size={14} />} loading={pcbBusy === 'open'} disabled={!/^[a-f0-9]{16,64}$/i.test(pcbDocumentUuid.trim())} onClick={openPcbDocument}>打开PCB编辑器</Button><Button icon={<RefreshCw size={14} />} loading={pcbBusy === 'context'} onClick={readPcbContext}>1. 读取真实PCB</Button><Button icon={<Bot size={14} />} loading={pcbBusy === 'compile'} onClick={compilePcbPlan}>2. 编译CH32V003计划</Button><Button icon={<Code2 size={14} />} loading={pcbBusy === 'validate'} onClick={validatePcbPlan}>3. 校验PCB计划</Button><Button icon={<ShieldCheck size={14} />} loading={pcbBusy === 'approve'} disabled={!pcbPlanning?.ready || !pcbContext?.complete || writeGateClosed || pcbWriteLocked} title={pcbWriteLocked ? 'PCB 安全写锁未解除（上次回滚失败）：先在上方横幅确认现场并解除' : writeGateClosed ? '写入已暂停（全局或本会话）：恢复后才能签发写批准' : !pcbPlanning?.ready ? 'PCB 计划未就绪' : !pcbContext?.complete ? '请先读取完整 PCB 证据' : undefined} onClick={approvePcbPlan}>4. 人工批准PCB</Button><Button variant="primary" icon={<Play size={14} />} loading={pcbExecTask?.status === 'running'} disabled={!pcbApproval || !pcbExecutionGate.allowed || writeGateClosed || pcbWriteLocked} title={pcbWriteLocked ? 'PCB 安全写锁未解除（上次回滚失败）：先在上方横幅确认现场并解除' : writeGateClosed ? '写入已暂停（全局或本会话）：恢复后才能执行 PCB 写入' : !pcbApproval ? '请先人工批准PCB计划' : !pcbExecutionGate.allowed ? pcbExecutionGate.reason : undefined} onClick={executePcbPlan}>5. 执行PCB写入</Button></div><textarea className="design-plan-editor" aria-label="结构化PCB生产计划" value={pcbPlanText} onChange={(event) => setPcbPlanText(event.target.value)} rows={14} spellCheck={false} /><div className="inline-alert inline-alert--info" role="status"><CheckCircle2 size={16} /><span><strong>单位契约：</strong>计划中的坐标、线宽、孔径统一填 <code>mm</code>；执行时由 Runtime 转成 EDA PCB 原生 <code>mil</code>。不要把 mil 直接填进计划，否则会缩板 25.4 倍。</span></div><div className="permission-matrix"><div><span>PCB目标证据</span><strong className={pcbContext && !pcbContext.complete ? 'text-danger' : ''}>{pcbContext ? `${pcbContext.windowId} · ${pcbContext.complete ? '完整' : '读取不完整'} · ${pcbContext.targetFingerprint.slice(0, 12)}` : '未读取'}</strong></div><div><span>PCB计划门禁</span><strong className={pcbPlanning?.ready ? 'text-warning' : ''} title={pcbPlanning && !pcbPlanning.ready ? missingFieldsTitle(pcbPlanning.missing) : undefined}>{pcbPlanning ? pcbPlanning.ready ? `结构有效 · ${pcbPlanning.planHash.slice(0, 12)}` : formatMissingFields(pcbPlanning.missing) : '待校验'}</strong></div><div><span>批准血缘（语义/编译）</span><strong title="批准令牌与批准账本同时绑定这两份来源哈希；任一不一致会 409">{pcbApproval ? `${pcbApproval.semanticPlanHash?.slice(0, 12) ?? '—'} / ${pcbApproval.compiledPlanHash?.slice(0, 12) ?? '—'}` : '批准后显示'}</strong></div><div><span>PCB回读</span><strong>{pcbExecution?.readback ? `器件 ${pcbExecution.readback.componentCount} · 走线 ${pcbExecution.readback.lineCount} · 过孔 ${pcbExecution.readback.viaCount}` : '执行后强制回读'}</strong></div><div><span>官方PCB DRC</span><strong className={pcbExecution?.drc?.passed ? 'text-success' : 'text-warning'}>{pcbExecution?.drc ? pcbExecution.drc.passed ? '通过' : `${pcbExecution.drc.findings.length}项问题` : '尚未执行'}</strong></div><div><span>恢复/锁定状态</span><strong className={pcbExecution?.state === 'rollback_failed' ? 'text-danger' : pcbExecution?.state === 'rolled_back' ? 'text-success' : ''}>{pcbExecution?.state || '无执行记录'}</strong></div></div>{pcbPlanning && !pcbPlanning.ready && <div className="empty-inline"><strong>PCB计划阻断：</strong><span>{pcbPlanning.missing.join('、')}</span></div>}{<LongTaskPanel title="PCB受控执行长任务（D8：取消只停止本页等待，写入可能已部分生效）" snapshot={pcbExecTask} onCancel={pcbExecTask?.status === 'running' ? () => pcbExecTaskRef.current?.cancelTask() : undefined} onRetry={() => void executePcbPlan()} cancelLabel="停止等待写入" retryLabel="重新执行" />}{pcbExecution && <div className="console"><header><div><DatabaseBackup size={14} /> PCB EXECUTION AUDIT</div></header><div className="console__body">{pcbExecution.events.map((item, index) => <div className={`console-line console-line--${item.status === 'passed' ? 'success' : 'error'}`} key={`${item.at}-${index}`}><span>{new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })}</span><Badge tone={item.status === 'passed' ? 'success' : 'danger'}>{item.status}</Badge><code>{item.stage}</code><pre>{JSON.stringify(item.detail)}</pre></div>)}</div></div>}</div></Panel>
    <LayerStackPanel />
    <Panel eyebrow="REVIEWED NETLIST PIPELINE" title="项目网络表 → 原理图受控执行" meta="AI只使用当前项目数据；真实写入前必须人工批准"><div className="detail-stack"><div className="toolbar toolbar--wrap"><Button icon={<Bot size={14} />} loading={designAiTask?.status === 'running'} onClick={generateAiPlan}>1. AI生成网络表草案</Button><Button icon={<ExternalLink size={14} />} loading={designBusy === 'open-schematic'} onClick={openProjectSchematic}>2. 打开关联原理图</Button><Button icon={<RefreshCw size={14} />} loading={designBusy === 'context'} onClick={readDesignContext}>读取当前原理图</Button><Button icon={<Code2 size={14} />} loading={designBusy === 'plan'} onClick={validatePlan}>3. 校验计划</Button><Button icon={<ShieldCheck size={14} />} loading={designBusy === 'approve'} disabled={!planning?.ready || !designContext || writeGateClosed} title={writeGateClosed ? '写入已暂停（全局或本会话）：恢复后才能签发写批准' : !planning?.ready ? '计划未就绪' : !designContext ? '请先读取当前原理图证据' : undefined} onClick={approvePlan}>4. 人工批准</Button><Button variant="primary" icon={<Play size={14} />} loading={designExecTask?.status === 'running'} disabled={!approval || !schematicExecutionGate.allowed || writeGateClosed} title={writeGateClosed ? '写入已暂停（全局或本会话）：恢复后才能执行原理图写入' : !approval ? '请先人工批准计划' : !schematicExecutionGate.allowed ? schematicExecutionGate.reason : undefined} onClick={executePlan}>5. 生成原理图</Button></div>{reviewedNetlist && <div className="empty-inline"><strong>待审核网络表：</strong><span>{JSON.stringify(reviewedNetlist)}</span></div>}<textarea className="design-plan-editor" aria-label="结构化设计计划" value={planText} onChange={(event) => setPlanText(event.target.value)} rows={16} spellCheck={false} />{importedSchematic ? <div className="inline-alert inline-alert--info" role="status"><CheckCircle2 size={16} /><span>计划草稿来自 <strong>{importedSchematic.sourceLabel}</strong>（交接哈希 <code>{importedSchematic.planHash?.slice(0, 12) || '—'}</code>）：先点“3. 校验计划”重新校验，再人工批准；批准令牌绑定校验后的哈希。</span></div> : null}<div className="permission-matrix"><div><span>目标证据</span><strong>{designContext ? `${designContext.windowId} · ${designContext.targetFingerprint.slice(0, 12)}` : '未读取'}</strong></div><div><span>计划门禁</span><strong className={planning?.ready ? 'text-success' : 'text-warning'} title={planning && !planning.ready ? missingFieldsTitle(planning.missing) : undefined}>{planning ? planning.ready ? `可批准 · ${planning.planHash.slice(0, 12)}` : formatMissingFields(planning.missing) : '待校验'}</strong></div><div><span>批准血缘（语义/编译）</span><strong title="批准令牌与批准账本同时绑定这两份来源哈希">{approval ? `${approval.semanticPlanHash?.slice(0, 12) ?? '—'} / ${approval.compiledPlanHash?.slice(0, 12) ?? '—'}` : '批准后显示'}</strong></div><div><span>真实快照</span><strong>{execution?.snapshot ? `${execution.snapshot.digest.slice(0, 12)} · ${execution.snapshot.size} bytes` : '执行前硬门禁'}</strong></div><div><span>原理图 DRC（ERC等效）</span><strong className={execution?.drc?.passed ? 'text-success' : 'text-warning'}>{execution?.drc ? execution.drc.passed ? '官方检查通过' : `${execution.drc.findings.length}项问题` : '尚未执行'}</strong></div><div><span>恢复状态</span><strong className={execution?.state === 'rollback_failed' ? 'text-danger' : execution?.state === 'rolled_back' ? 'text-success' : ''}>{execution?.state || '无执行记录'}</strong></div></div>{planning && !planning.ready && <div className="empty-inline"><strong>仍需补全：</strong><span>{planning.missing.join('、')}</span></div>}{<LongTaskPanel title="AI 网络表生成长任务（D8：取消只停止本页等待）" snapshot={designAiTask} onCancel={designAiTask?.status === 'running' ? () => designAiTaskRef.current?.cancelTask() : undefined} onRetry={() => void generateAiPlan()} cancelLabel="停止等待生成" retryLabel="重新生成" />}{<LongTaskPanel title="原理图受控执行长任务（D8：取消只停止本页等待）" snapshot={designExecTask} onCancel={designExecTask?.status === 'running' ? () => designExecTaskRef.current?.cancelTask() : undefined} onRetry={() => void executePlan()} cancelLabel="停止等待执行" retryLabel="重新执行" />}{execution && <div className="console"><header><div><DatabaseBackup size={14} /> EXECUTION AUDIT</div></header><div className="console__body">{execution.events.map((item, index) => <div className={`console-line console-line--${item.status === 'passed' ? 'success' : 'error'}`} key={`${item.at}-${index}`}><span>{new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })}</span><Badge tone={item.status === 'passed' ? 'success' : 'danger'}>{item.status}</Badge><code>{item.stage}</code><pre>{JSON.stringify(item.detail)}</pre></div>)}</div></div>}</div></Panel>
    <Panel eyebrow="EXECUTION HISTORY" title="执行历史（落盘，重启后仍在）" meta={state.runtime.mode === 'demo' ? 'DEMO 模式不读取真实执行历史' : '原理图/PCB 写入记录；点击行可展开完整事件'} actions={<Button icon={<RefreshCw size={15} />} loading={executionHistory.busy} disabled={executionHistory.busy || state.runtime.mode === 'demo'} onClick={() => void loadExecutionHistory()}>刷新历史</Button>}>
      {executionHistory.error ? <div className="inline-alert inline-alert--danger"><XCircle size={16} /><span>读取执行历史失败：{executionHistory.error}</span></div> : null}
      {executionHistory.persistenceError ? <div className="inline-alert inline-alert--warning"><XCircle size={16} /><span>执行历史未完全落盘：{executionHistory.persistenceError}（本次执行记录仍返回，但重启后可能丢失；请检查 state 目录权限）</span></div> : null}
      {(() => {
        const all = [...executionHistory.design, ...executionHistory.pcb].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        if (!all.length) return <div className="empty-inline"><DatabaseBackup size={24} /><strong>还没有落盘的执行记录</strong><span>完成一次“人工批准 → 受控执行”后，这里会出现带计划哈希与 DRC 结论的记录。</span></div>;
        return (
          <div className="detail-stack">
            <div className="stats-grid stats-grid--4">
              <Stat label="原理图执行" value={executionHistory.design.length} hint="最近在前" />
              <Stat label="PCB 执行" value={executionHistory.pcb.length} hint="最近在前" />
              <Stat label="完成" value={all.filter((item) => item.state === 'completed').length} hint="state=completed" tone="success" />
              <Stat label="回滚/失败" value={all.filter((item) => item.state !== 'completed').length} hint="需人工复核" tone={all.some((item) => item.state !== 'completed') ? 'warning' : 'neutral'} />
            </div>
            <TableFrame label="执行记录（来自落盘状态文件，不是前端内存）">
              <table>
                <thead><tr><th>类型</th><th>时间</th><th>状态</th><th>计划哈希</th><th>DRC</th><th>事件</th><th></th></tr></thead>
                <tbody>
                  {all.map((item) => (
                    <tr key={`${item.kind}-${item.id}`}>
                      <td><Badge tone={item.kind === 'schematic' ? 'info' : 'warning'}>{item.kind === 'schematic' ? '原理图' : 'PCB'}</Badge></td>
                      <td>{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '—'}</td>
                      <td><Badge tone={item.state === 'completed' ? 'success' : item.state === 'rolled_back' ? 'warning' : 'danger'}>{item.state}</Badge></td>
                      <td><code>{item.planHash?.slice(0, 12) || '—'}</code></td>
                      <td>{item.drc ? <Badge tone={item.drc.passed ? 'success' : 'danger'}>{item.drc.passed ? '通过' : `${item.drc.findings ?? '?'} 项`}</Badge> : '—'}</td>
                      <td>{item.eventCount}</td>
                      <td><Button size="sm" onClick={() => void openExecutionDetail(item)}>查看事件</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
            {historyDetail ? (
              <div className="console"><header><div><DatabaseBackup size={14} /> 执行详情 · {historyDetail.kind === 'schematic' ? '原理图' : 'PCB'}</div><Button variant="ghost" size="sm" onClick={() => setHistoryDetail(null)}>收起</Button></header><div className="console__body"><pre style={{ maxHeight: 260, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(historyDetail.execution, null, 2)}</pre></div></div>
            ) : null}
          </div>
        );
      })()}
    </Panel>

    <Panel eyebrow="TYPED COMMAND CATALOG" title="命令控制台" meta="仅允许Runtime内登记的固定命令，不接收任意代码"><div className="toolbar toolbar--wrap"><SegmentedTabs label="命令权限" value={permissionFilter} onChange={setPermissionFilter} items={[{ value: 'all', label: '全部' }, { value: 'read', label: '只读' }, { value: 'write', label: '写入' }]} /><div className="toolbar__spacer" /><label className="search-box"><Search size={15} /><input value={commandQuery} onChange={(e) => setCommandQuery(e.target.value)} placeholder="搜索类型化命令" aria-label="搜索命令" /></label></div><div className="command-catalog">{visibleCommands.map((item) => <article className="command-card" key={item.command}><div className="command-card__icon"><Code2 size={18} /></div><div><code>{item.command}</code><strong>{item.label}</strong><small>{item.description}</small></div><Badge tone={item.permission === 'read' ? 'info' : 'warning'}>{item.permission === 'read' ? 'READ' : 'WRITE'}</Badge><Button size="sm" loading={runningCommand === item.command} icon={<Play size={13} />} onClick={() => execute(item)}>运行</Button></article>)}</div><div className="console"><header><div><span className="signal-dot" /> STRUCTURED RESPONSE LOG</div><Button variant="ghost" size="sm" icon={<Copy size={13} />} onClick={() => { navigator.clipboard?.writeText(state.eda.commandLogs.map((log) => `${log.time} ${log.command} ${log.result}`).join('\n')); notify('已复制', '结构化日志已复制到剪贴板。', 'success'); }}>复制日志</Button></header><div className="console__body">{state.eda.commandLogs.map((log) => <div className={`console-line console-line--${log.status}`} key={log.id}><span>{log.time}</span><Badge tone={log.permission === 'read' ? 'info' : 'warning'}>{log.permission}</Badge><code>{log.command}</code><span>{log.duration} ms</span><pre>{log.result}</pre></div>)}</div></div></Panel>
    </>}
    <ConfirmDialog open={createWorkspaceOpen} onClose={() => setCreateWorkspaceOpen(false)} onConfirm={createEasyEdaWorkspace} title="新建嘉立创EDA设计文件？" description={`将由后台打开嘉立创EDA，为项目“${activeProject?.name || '当前项目'}”创建一个新工程、关联原理图、原理图页和PCB文档，然后自动打开PCB。这不会覆盖现有工程。`} confirmLabel="确认新建并打开" />
    <ConfirmDialog open={executeConfirmOpen} onClose={() => setExecuteConfirmOpen(false)} onConfirm={executeConversationDesign} title="开始执行EDA设计？" description={`将把已确认的AI PCB计划写入当前嘉立创EDA窗口。Runtime会先绑定目标和快照，执行后强制回读、逐项核对同步期望（${expectedSyncDesignators.length ? `${expectedSyncDesignators.length} 个位号：${expectedSyncDesignators.slice(0, 8).join('、')}${expectedSyncDesignators.length > 8 ? '…' : ''}` : '未声明期望位号'}）与官方DRC；缺件即失败并回滚，不会把空转的变更导入显示成同步完成。`} confirmLabel="确认并开始执行" />
    <ConfirmDialog open={disconnectOpen} onClose={() => setDisconnectOpen(false)} onConfirm={disconnect} title="断开本地桥接会话？" description="仅清除CircuitPilot中的会话状态，不关闭嘉立创EDA，也不修改工程。" confirmLabel="确认断开" danger />
  </>;
}
