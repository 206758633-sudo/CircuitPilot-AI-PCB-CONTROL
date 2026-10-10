import { useEffect, useMemo, useState } from 'react';
import { Bot, Cable, CheckCircle2, ChevronDown, CircleStop, Code2, Copy, DatabaseBackup, ExternalLink, Layers3, MonitorCog, Play, RefreshCw, Search, Send, ShieldCheck, Unplug, XCircle } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { demoAdapter } from '../services/demoAdapter';
import { RuntimeApiError, runtimeClient } from '../services/runtimeClient';
import type { CommandLog, DesignApproval, DesignExecution, EdaDesignContext, PcbCapabilities, PcbContext, PcbExecution, SemanticPlanResult, SimpleBoardPlanResult } from '../types';
import { Badge, Button, Panel, SegmentedTabs, Stat, Toggle } from '../components/ui';
import { ConfirmDialog } from '../components/overlays';

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

export function EdaPage() {
  const { state, activeProject, dispatch, notify, addAudit, recordChange, reportIssue } = useApp();
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
  const [pcbContext, setPcbContext] = useState<PcbContext | null>(null);
  const [pcbPlanText, setPcbPlanText] = useState(pcbPlanTemplate);
  const [pcbPlanning, setPcbPlanning] = useState<SimpleBoardPlanResult | null>(null);
  const [pcbApproval, setPcbApproval] = useState<DesignApproval | null>(null);
  const [pcbExecution, setPcbExecution] = useState<PcbExecution | null>(null);
  const [pcbBusy, setPcbBusy] = useState<string | null>(null);
  const [pcbDocumentUuid, setPcbDocumentUuid] = useState('de4911bced17666d');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [designInstruction, setDesignInstruction] = useState('');
  const [conversationBusy, setConversationBusy] = useState(false);
  const [conversationCandidate, setConversationCandidate] = useState<{ status: 'ready' | 'blocked'; explanation: string; blockingInformation: Array<{ code: string; question: string; reason: string }>; plan: Record<string, unknown> | null } | null>(null);
  const [compiledCandidate, setCompiledCandidate] = useState<SemanticPlanResult | null>(null);
  const realSession = state.runtime.reachable && state.runtime.mode !== 'demo';
  const canWrite = realSession && !state.eda.writePaused && !state.settings.writePaused && state.eda.connected;
  const visibleCommands = useMemo(() => commands.filter((item) => (permissionFilter === 'all' || item.permission === permissionFilter) && `${item.label} ${item.command}`.toLowerCase().includes(commandQuery.toLowerCase())), [permissionFilter, commandQuery]);
  const explain = (error: unknown) => error instanceof RuntimeApiError ? `${error.code} · ${error.message}` : error instanceof Error ? error.message : '未知错误';
  const projectRequirements = state.requirements;
  const projectComponents = state.components.filter((item) => item.projectId === state.activeProjectId);
  const projectAssets = state.assets;

  useEffect(() => { setReviewedNetlist(null); setPlanning(null); setApproval(null); setExecution(null); setDesignContext(null); setPlanText(planTemplate); setCreatedWorkspace(activeProject?.edaWorkspace || null); if (activeProject?.edaWorkspace?.pcbUuid) setPcbDocumentUuid(activeProject.edaWorkspace.pcbUuid); }, [state.activeProjectId]);

  const focusEasyEda = async () => {
    try { await runtimeClient.focusEasyEda(); addAudit('eda', '聚焦嘉立创EDA', '从对话驱动工作台打开本机设计窗口', 'success'); notify('已打开嘉立创EDA', '可在原生编辑器中查看完整图纸。', 'success'); }
    catch (error) { notify('无法打开嘉立创EDA', explain(error), 'danger'); }
  };

  const createEasyEdaWorkspace = async () => {
    setCreateWorkspaceOpen(false); setCreatingWorkspace(true);
    try {
      const suffix = Date.now().toString().slice(-8);
      const result = await runtimeClient.createEasyEdaWorkspace({ friendlyName: activeProject?.name || `CircuitPilot-${suffix}`, projectName: `${activeProject?.code || 'CircuitPilot'}-${suffix}`, description: activeProject?.description || '由CircuitPilot根据已确认需求创建' });
      const workspace = { ...result.workspace, schematicStatus: 'empty' as const };
      setCreatedWorkspace(workspace); setPcbDocumentUuid(workspace.pcbUuid);
      if (activeProject) dispatch({ type: 'UPDATE_PROJECT', project: { ...activeProject, edaWorkspace: workspace, updatedAt: new Date().toISOString() } });
      const context = await runtimeClient.pcbContext(); setPcbContext(context); setPcbApproval(null); setPcbExecution(null);
      dispatch({ type: 'PATCH_EDA', patch: { connected: true, bridgeStatus: 'running', activeWindowId: context.windowId } });
      recordChange({ source: 'runtime', actor: 'CircuitPilot Runtime', action: 'create', objectType: 'easyeda-workspace', objectId: result.workspace.projectUuid, summary: '自动创建嘉立创EDA工程、原理图和PCB文档', after: result.workspace, reason: '用户选择新建PCB设计并确认后由后台启动嘉立创EDA执行固定创建链' });
      notify('嘉立创EDA设计文件已创建', `工程、原理图和PCB已建立，PCB ${result.workspace.pcbUuid.slice(0, 12)}已打开并同步。`, 'success');
    } catch (error) { notify('新建PCB设计失败', explain(error), 'danger'); }
    finally { setCreatingWorkspace(false); }
  };

  const bindCurrentEasyEdaWorkspace = async () => {
    setCreatingWorkspace(true);
    try {
      const current = await runtimeClient.currentEasyEdaWorkspace();
      const workspace = { ...current, schematicStatus: 'empty' as const };
      setCreatedWorkspace(workspace); setPcbDocumentUuid(workspace.pcbUuid);
      if (activeProject) dispatch({ type: 'UPDATE_PROJECT', project: { ...activeProject, edaWorkspace: workspace, edaProjectPath: `easyeda://${workspace.projectUuid}/${workspace.boardName}`, updatedAt: new Date().toISOString() } });
      notify('当前EDA设计已绑定', `${workspace.boardName} · 原理图和PCB文档身份已保存到当前项目。`, 'success');
    } catch (error) { notify('绑定失败', explain(error), 'danger'); }
    finally { setCreatingWorkspace(false); }
  };

  const generateConversationPlan = async () => {
    const instruction = designInstruction.trim();
    if (!instruction) return notify('请输入设计要求', '例如：把 USB-C 放在短边中心，并缩短差分线。', 'warning');
    setConversationBusy(true); setConversationCandidate(null); setCompiledCandidate(null);
    try {
      const result = await runtimeClient.generateProductionPlan({ project: activeProject, requirements: projectRequirements, components: projectComponents, assets: projectAssets }, state.settings.model === 'auto' ? null : state.settings.model, instruction);
      setConversationCandidate(result.candidate); setCompiledCandidate(result.planning);
      addAudit('ai', '生成PCB对话设计方案', `${activeProject?.code || state.activeProjectId} · ${result.candidate.status}`, result.candidate.status === 'ready' ? 'success' : 'warning');
      notify(result.candidate.status === 'ready' ? '设计方案已生成' : '需先补充关键信息', result.candidate.explanation, result.candidate.status === 'ready' ? 'success' : 'warning');
    } catch (error) { notify('AI设计失败', explain(error), 'danger'); }
    finally { setConversationBusy(false); }
  };

  const prepareCandidateForExecution = async () => {
    if (!conversationCandidate?.plan) return;
    setConversationBusy(true);
    try {
      const compiled = await runtimeClient.compileProductionPlan(conversationCandidate.plan);
      setCompiledCandidate(compiled);
      if (!compiled.ready || !compiled.compiled) return notify('方案未通过确定性校验', compiled.blocking.map((item) => item.message).join('、') || '请补全工程证据。', 'danger');
      const executable = await runtimeClient.normalizePcbPlan(compiled.compiled);
      setPcbPlanText(JSON.stringify(compiled.compiled, null, 2)); setPcbPlanning(executable); setPcbApproval(null); setAdvancedOpen(true);
      recordChange({ source: 'user', actor: '本机用户', action: 'approve', objectType: 'ai-pcb-candidate', objectId: compiled.planHash, summary: '确认AI PCB设计方案并准备受控执行', after: { compiledPlanHash: compiled.compiledPlanHash, quality: compiled.quality }, reason: '用户查看差异后显式确认；尚未写入嘉立创EDA' });
      notify('已准备受控执行', '此步未写入嘉立创EDA；请在已展开的高级控制中读取真实PCB、审批并执行。', 'success');
    } catch (error) { notify('方案编译失败', explain(error), 'danger'); }
    finally { setConversationBusy(false); }
  };

  const requestConversationExecution = async () => {
    if (!activeProject?.edaWorkspace) return notify('尚未绑定EDA文件', '请先在嘉立创EDA中选中本项目PCB，然后点击“绑定当前EDA设计”。', 'warning');
    if (activeProject.edaWorkspace.schematicStatus !== 'generated') return notify('原理图尚未生成', '请先生成并审核网络表，在“项目网络表 → 原理图受控执行”中完成原理图写入。', 'warning');
    if (!canWrite) return notify('写入门禁未就绪', state.eda.writePaused || state.settings.writePaused ? '顶部 WRITE GATE 处于 PAUSED；请关闭“暂停本会话写入”。' : '请确认 Runtime、Bridge 和嘉立创EDA窗口已连接。', 'danger');
    if (!/^[a-f0-9]{16,64}$/i.test(pcbDocumentUuid.trim())) return notify('缺少目标PCB', '请先新建PCB设计，或在高级控制中填写当前PCB文档UUID。', 'warning');
    setConversationBusy(true); setPcbBusy('context');
    try {
      await runtimeClient.openPcb(pcbDocumentUuid.trim());
      const liveContext = await runtimeClient.pcbContext();
      if (!liveContext.complete) throw new RuntimeApiError('PCB_CONTEXT_INCOMPLETE', '目标PCB实时读取不完整，已停止执行');
      const baseBoard = (pcbPlanning?.plan as { board?: Record<string, unknown> } | undefined)?.board || { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 };
      const syncPlan = await runtimeClient.normalizePcbPlan({ title: `${activeProject?.name || '当前项目'} · 从已确认原理图同步到PCB`, board: baseBoard, constraints: {}, operations: [{ type: 'pcb.importChanges', args: {} }, { type: 'pcb.save', args: {} }, { type: 'pcb.drc', args: {} }] });
      if (!syncPlan.ready) throw new RuntimeApiError('PCB_SYNC_PLAN_INVALID', syncPlan.missing.join('、'));
      setPcbContext(liveContext); setPcbPlanning(syncPlan); setPcbPlanText(JSON.stringify(syncPlan.plan, null, 2)); setPcbApproval(null); setPcbExecution(null);
      setExecuteConfirmOpen(true);
      await runtimeClient.focusCircuitPilot();
    } catch (error) { notify('执行前检查未通过', explain(error), 'danger'); }
    finally { setConversationBusy(false); setPcbBusy(null); }
  };

  const executeConversationDesign = async () => {
    setExecuteConfirmOpen(false);
    if (!pcbPlanning?.ready || !pcbContext?.complete) return;
    setConversationBusy(true); setPcbBusy('execute');
    try {
      const boundApproval = await runtimeClient.approvePcb({ plan: pcbPlanning.plan, targetFingerprint: pcbContext.targetFingerprint, windowId: pcbContext.windowId });
      setPcbApproval(boundApproval);
      const value = await runtimeClient.executePcb({ plan: pcbPlanning.plan, approvalToken: boundApproval.token, targetFingerprint: pcbContext.targetFingerprint, windowId: pcbContext.windowId });
      setPcbExecution(value); setPcbApproval(null);
      const ok = value.state === 'completed';
      recordChange({ source: 'runtime', actor: 'CircuitPilot Runtime', action: 'execute', objectType: 'pcb-execution', objectId: value.id, summary: `对话驱动PCB执行状态：${value.state}`, after: { events: value.events, readback: value.readback, drc: value.drc, error: value.error }, reason: '用户在主工作台最终确认后，自动完成目标绑定、一次性审批、写入、回读与DRC' });
      if (!ok) reportIssue({ fingerprint: `eda:CONVERSATION_EXECUTION:${value.error?.code || value.state}`, source: 'eda', severity: value.state === 'rollback_failed' ? 'critical' : 'error', status: 'open', code: value.error?.code || value.state, summary: '对话驱动PCB执行未成功', detail: value.error?.message || value.state, context: { executionId: value.id }, suggestedAction: value.state === 'rolled_back' ? '已恢复执行前快照，请修正方案后重试。' : '请停止写入并人工检查嘉立创EDA工程。' });
      notify(ok ? 'EDA设计执行完成' : 'EDA设计执行已停止', ok ? '写入、保存、回读和官方PCB DRC均已完成。' : `${value.state} · ${value.error?.message || ''}`, ok ? 'success' : 'danger');
    } catch (error) { notify('EDA执行请求失败', explain(error), 'danger'); }
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
    catch (error) { const detail = explain(error); addAudit('eda', '选择EDA窗口失败', detail, 'error'); notify('窗口选择失败', detail, 'danger'); }
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
    } catch (error) { notify('打开原理图失败', explain(error), 'danger'); }
    finally { setDesignBusy(null); }
  };

  const validatePlan = async () => {
    setDesignBusy('plan');
    try { const parsed = JSON.parse(planText); const value = await runtimeClient.normalizeDesignPlan(parsed); setPlanning(value); setApproval(null); setExecution(null); recordChange({ source: 'ai', actor: 'CircuitPilot Runtime', action: 'plan', objectType: 'schematic-plan', objectId: value.planHash, summary: value.ready ? '简单控制板计划可审批' : `计划仍缺少${value.missing.length}项`, after: { planHash: value.planHash, missing: value.missing }, reason: '固定Schema校验与稳定哈希' }); notify(value.ready ? '计划校验通过' : '计划尚不能批准', value.ready ? `哈希 ${value.planHash.slice(0, 12)}` : value.missing.join('、'), value.ready ? 'success' : 'warning'); }
    catch (error) { notify('计划格式错误', explain(error), 'danger'); }
    finally { setDesignBusy(null); }
  };

  const generateAiPlan = async () => {
    setDesignBusy('ai-plan');
    try { const result = await runtimeClient.generateReviewedNetlist({ project: activeProject, requirements: projectRequirements, components: projectComponents, assets: projectAssets }, state.settings.model === 'auto' ? null : state.settings.model); setReviewedNetlist(result.netlist); setPlanning(result.compilation); if (result.compilation?.plan) setPlanText(JSON.stringify(result.compilation.plan, null, 2)); setApproval(null); setExecution(null); setAdvancedOpen(true); addAudit('ai', 'AI生成项目网络表草案', `${activeProject?.code || state.activeProjectId} · ${result.status}`, result.status === 'ready' ? 'success' : 'warning'); notify(result.status === 'ready' ? '网络表草案已生成' : '网络表仍缺少关键信息', result.status === 'ready' ? '请检查网络与引脚，随后打开原理图并批准。' : result.blockers.join('、'), result.status === 'ready' ? 'success' : 'warning'); }
    catch (error) { notify('AI计划生成失败', explain(error), 'danger'); }
    finally { setDesignBusy(null); }
  };

  const approvePlan = async () => {
    if (!planning?.ready || !designContext) return notify('无法批准', '请先读取真实上下文并补全计划。', 'warning');
    setDesignBusy('approve');
    try { const value = await runtimeClient.approveDesign({ plan: planning.plan, targetFingerprint: designContext.targetFingerprint, windowId: designContext.windowId }); setApproval(value); addAudit('eda', '人工批准受控原理图计划', `${value.planHash.slice(0, 12)} · 令牌5分钟内一次有效`, 'success'); recordChange({ source: 'user', actor: '本机用户', action: 'approve', objectType: 'schematic-plan', objectId: value.planHash, summary: '批准绑定目标和步骤的不可变计划', after: { windowId: value.windowId, expiresAt: value.expiresAt }, reason: '真实写入前人工确认' }); notify('计划已批准', '一次性令牌已绑定当前窗口、文档指纹和计划哈希。', 'success'); }
    catch (error) { notify('批准失败', explain(error), 'danger'); }
    finally { setDesignBusy(null); }
  };

  const executePlan = async () => {
    if (!approval || !planning || !designContext) return notify('无法执行', '缺少有效批准或目标上下文。', 'warning');
    if (state.eda.writePaused || state.settings.writePaused) return notify('写入已暂停', '请先关闭写入暂停开关。', 'warning');
    setDesignBusy('execute');
    try { const value = await runtimeClient.executeDesign({ plan: planning.plan, approvalToken: approval.token, targetFingerprint: designContext.targetFingerprint, windowId: designContext.windowId }); setExecution(value); setApproval(null); const ok = value.state === 'completed'; if (ok && activeProject?.edaWorkspace) dispatch({ type: 'UPDATE_PROJECT', project: { ...activeProject, edaWorkspace: { ...activeProject.edaWorkspace, schematicStatus: 'generated' }, stage: '原理图', updatedAt: new Date().toISOString() } }); addAudit('eda', ok ? '受控原理图执行完成' : '受控原理图执行未完成', `${value.id} · ${value.state}`, ok ? 'success' : 'error'); recordChange({ source: 'runtime', actor: 'CircuitPilot Runtime', action: 'execute', objectType: 'schematic-execution', objectId: value.id, summary: `执行状态：${value.state}`, after: { events: value.events, snapshot: value.snapshot, drc: value.drc, error: value.error }, reason: '快照→写入→保存→回读→DRC→必要时恢复' }); if (!ok) reportIssue({ fingerprint: `eda:EXECUTION:${value.error?.code || value.state}`, source: 'eda', severity: value.state === 'rollback_failed' ? 'critical' : 'error', status: 'open', code: value.error?.code || value.state, summary: '受控原理图执行未成功', detail: value.error?.message || value.state, context: { executionId: value.id, recoveryState: value.state }, suggestedAction: value.state === 'rolled_back' ? '已验证恢复，可修正计划后重新审批。' : '停止写入并按快照证据人工检查工程。' }); notify(ok ? '原理图执行完成' : '执行已停止', ok ? '保存、回读和官方原理图DRC均通过。' : `${value.state} · ${value.error?.message || ''}`, ok ? 'success' : 'danger'); }
    catch (error) { notify('执行请求失败', explain(error), 'danger'); }
    finally { setDesignBusy(null); }
  };

  const readPcbContext = async () => {
    setPcbBusy('context');
    try {
      const value = await runtimeClient.pcbContext();
      setPcbContext(value); setPcbApproval(null); setPcbExecution(null);
      addAudit('eda', '读取真实PCB上下文', `${value.windowId} · ${value.targetFingerprint.slice(0, 12)}`, 'success');
      if (!value.complete) reportIssue({ fingerprint: 'eda:PCB_CONTEXT_INCOMPLETE', source: 'eda', severity: 'error', status: 'open', code: 'PCB_CONTEXT_INCOMPLETE', summary: 'PCB上下文读取不完整', detail: (value.pcb?.readErrors || []).map((item) => `${item.name}: ${item.error}`).join('；'), suggestedAction: '确认当前为PCB文档，并检查嘉立创EDA版本/API兼容性；读取完整前禁止批准。' });
      notify(value.complete ? 'PCB上下文已锁定' : 'PCB上下文读取不完整', value.complete ? `器件 ${value.pcb?.components?.length ?? 0} · 走线 ${value.pcb?.lines?.length ?? 0} · 过孔 ${value.pcb?.vias?.length ?? 0}` : (value.pcb?.readErrors || []).map((item) => item.name).join('、'), value.complete ? 'success' : 'danger');
    } catch (error) { notify('PCB读取失败', explain(error), 'danger'); }
    finally { setPcbBusy(null); }
  };

  const openPcbDocument = async () => {
    setPcbBusy('open');
    try {
      await runtimeClient.openPcb(pcbDocumentUuid.trim());
      setPcbContext(null); setPcbApproval(null); setPcbExecution(null);
      notify('PCB文档已打开', '嘉立创EDA已切换到PCB编辑器，请继续读取真实PCB。', 'success');
    } catch (error) { notify('打开PCB失败', explain(error), 'danger'); }
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
    if (state.eda.writePaused || state.settings.writePaused) return notify('写入已暂停', '请先关闭全局及会话写入暂停。', 'warning');
    setPcbBusy('execute');
    try {
      const value = await runtimeClient.executePcb({ plan: pcbPlanning.plan, approvalToken: pcbApproval.token, targetFingerprint: pcbContext.targetFingerprint, windowId: pcbContext.windowId });
      setPcbExecution(value); setPcbApproval(null);
      const ok = value.state === 'completed';
      recordChange({ source: 'runtime', actor: 'CircuitPilot Runtime', action: 'execute', objectType: 'pcb-execution', objectId: value.id, summary: `PCB执行状态：${value.state}`, after: { events: value.events, readback: value.readback, drc: value.drc, error: value.error }, reason: '快照→受控写入→保存→完整回读→官方DRC→必要时恢复' });
      if (!ok) reportIssue({ fingerprint: `eda:PCB_EXECUTION:${value.error?.code || value.state}`, source: 'eda', severity: value.state === 'rollback_failed' ? 'critical' : 'error', status: 'open', code: value.error?.code || value.state, summary: 'PCB受控执行未成功', detail: value.error?.message || value.state, context: { executionId: value.id, recoveryState: value.state }, suggestedAction: value.state === 'rolled_back' ? '快照已恢复，可修正计划后重新审批。' : '写入已锁定，请人工检查嘉立创EDA工程并重启Runtime。' });
      notify(ok ? 'PCB执行完成' : 'PCB执行已停止', ok ? '保存、回读和官方PCB DRC均通过。' : `${value.state} · ${value.error?.message || ''}`, ok ? 'success' : 'danger');
    } catch (error) { notify('PCB执行请求失败', explain(error), 'danger'); }
    finally { setPcbBusy(null); }
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
      <header className="eda-copilot__header"><div><span className="eyebrow">CONVERSATION-DRIVEN PCB DESIGN</span><h2>AI 直接协助当前项目设计</h2><p>当前项目：<strong>{activeProject?.name || '未选择'}</strong>。先绑定本项目的嘉立创EDA Board，再按“网络表→原理图→PCB”执行。</p></div><div className="toolbar toolbar--wrap"><Button variant="primary" icon={<Layers3 size={15} />} loading={creatingWorkspace} onClick={() => setCreateWorkspaceOpen(true)}>新建EDA文件</Button><Button icon={<Cable size={15} />} loading={creatingWorkspace} onClick={bindCurrentEasyEdaWorkspace}>绑定当前EDA设计</Button><Button icon={<RefreshCw size={15} />} loading={pcbBusy === 'context'} onClick={readPcbContext}>读取当前PCB</Button><Button icon={<ExternalLink size={15} />} onClick={focusEasyEda}>在嘉立创EDA中查看</Button></div></header>
      <div className="eda-copilot__grid">
        <div className="eda-preview">
          <div className="eda-preview__bar"><span><Layers3 size={15} /> PCB 同步预览</span><Badge tone={pcbContext?.complete ? 'success' : pcbContext ? 'warning' : 'neutral'}>{pcbContext?.complete ? '上次读取证据' : pcbContext ? '读取不完整' : '待同步'}</Badge></div>
          <div className="eda-preview__canvas">
            <svg viewBox="0 0 600 360" role="img" aria-label="当前PCB图元摘要"><defs><pattern id="pcb-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(111,219,181,.10)" strokeWidth="1" /></pattern></defs><rect x="14" y="14" width="572" height="332" rx="8" fill="url(#pcb-grid)" stroke="#46b98a" strokeWidth="2" />{previewLines.map((line) => <line key={line.id} x1={20 + Math.abs(line.x1) % 560} y1={20 + Math.abs(line.y1) % 320} x2={20 + Math.abs(line.x2) % 560} y2={20 + Math.abs(line.y2) % 320} stroke="#d88933" strokeWidth="2" opacity=".75" />)}{previewComponents.map((component) => <g key={component.id} transform={`translate(${24 + Math.abs(component.x) % 540} ${24 + Math.abs(component.y) % 300})`}><rect x="-12" y="-8" width="24" height="16" rx="2" fill="#173e35" stroke="#7be0ba" /><text y="-12" textAnchor="middle" fill="#c8f7e5" fontSize="8">{component.ref}</text></g>)}</svg>
            {!pcbContext && <div className="eda-preview__empty"><MonitorCog size={30} /><strong>新项目点击“新建PCB设计”</strong><span>后台会打开嘉立创EDA并创建工程、原理图和PCB；已有设计则点击“读取当前EDA设计”。</span></div>}
          </div>
          <div className="eda-preview__metrics"><span>元件 <strong>{pcbContext?.pcb.components?.length ?? '—'}</strong></span><span>走线 <strong>{pcbContext?.pcb.lines?.length ?? '—'}</strong></span><span>过孔 <strong>{pcbContext?.pcb.vias?.length ?? '—'}</strong></span><span>铺铜 <strong>{pcbContext?.pcb.pours?.length ?? '—'}</strong></span></div>
        </div>
        <div className="eda-conversation"><div><span className="eyebrow">DESIGN INSTRUCTION</span><h3>告诉 AI 如何设计或微调</h3><p>例如：“把 USB-C 放在短边中心，天线净空区不铺铜，优先缩短电源回路。”</p></div><textarea aria-label="PCB设计指令" value={designInstruction} onChange={(event) => setDesignInstruction(event.target.value)} rows={5} placeholder="输入本轮PCB设计或微调需求…" /><Button variant="primary" icon={<Send size={15} />} loading={conversationBusy} onClick={generateConversationPlan}>生成可审核设计方案</Button>
          {conversationCandidate && <div className={`eda-candidate eda-candidate--${conversationCandidate.status}`}><div className="eda-candidate__title"><Badge tone={conversationCandidate.status === 'ready' ? 'success' : 'warning'}>{conversationCandidate.status === 'ready' ? '可审核' : '需补充信息'}</Badge><strong>{conversationCandidate.explanation}</strong></div>{conversationCandidate.blockingInformation.length > 0 && <ol>{conversationCandidate.blockingInformation.map((item) => <li key={item.code}><strong>{item.question}</strong><span>{item.reason}</span></li>)}</ol>}{compiledCandidate?.quality && <div className="eda-candidate__diff"><span>元件 {compiledCandidate.quality.metrics.componentCount ?? 0}</span><span>网络 {compiledCandidate.quality.metrics.netCount ?? 0}</span><span>走线段 {compiledCandidate.quality.metrics.trackSegmentCount ?? 0}</span><span>{compiledCandidate.quality.passed ? '本地质量门通过' : '需处理质量问题'}</span></div>}{conversationCandidate.status === 'ready' && <Button icon={<ShieldCheck size={15} />} loading={conversationBusy} onClick={prepareCandidateForExecution}>确认方案并准备执行</Button>}</div>}
          {createdWorkspace && <div className="eda-created-workspace"><Badge tone="success">EDA已绑定</Badge><span>{createdWorkspace.boardName} · 工程 {createdWorkspace.projectUuid.slice(0, 8)} · 原理图 {createdWorkspace.schematicUuid.slice(0, 8)} · PCB {createdWorkspace.pcbUuid.slice(0, 8)}</span></div>}
          <div className="eda-execute-control">{!activeProject?.edaWorkspace ? <Button variant="primary" icon={<Cable size={16} />} loading={creatingWorkspace} onClick={bindCurrentEasyEdaWorkspace}>1. 绑定当前EDA设计</Button> : activeProject.edaWorkspace.schematicStatus !== 'generated' ? <Button variant="primary" icon={<Bot size={16} />} loading={designBusy === 'ai-plan'} onClick={generateAiPlan}>2. 生成并审核原理图</Button> : <Button variant="primary" icon={<Play size={16} />} loading={conversationBusy || pcbBusy === 'execute' || pcbBusy === 'context'} onClick={requestConversationExecution}>3. 同步原理图到PCB</Button>}<span>{!activeProject?.edaWorkspace ? '当前阻断：尚未保存当前项目对应的EDA文档身份。' : activeProject.edaWorkspace.schematicStatus !== 'generated' ? '当前阶段：原理图文档为空，必须先生成网络表并完成原理图受控写入。' : '原理图已生成；点击后重新读取目标PCB并进行最终确认。'}</span></div>
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
      <Panel eyebrow="WINDOW & WRITE GATE" title="会话控制" meta="多窗口必须人工选定目标"><div className="detail-stack"><Toggle checked={state.eda.writePaused || state.settings.writePaused} disabled={state.settings.writePaused} onChange={(checked) => { dispatch({ type: 'PATCH_EDA', patch: { writePaused: checked } }); addAudit('eda', checked ? '暂停EDA写入' : '恢复EDA受控写入', '会话级开关', 'warning'); }} label="暂停本会话写入" description={state.settings.writePaused ? '全局“暂停所有写入”正在生效并覆盖此开关；请在系统设置中解除后再单独控制本会话。' : '立即阻断所有写命令，不影响只读诊断。'} />{state.eda.windows.length > 0 && <div className="window-picker">{state.eda.windows.map((windowItem) => <button type="button" key={windowItem.windowId} className={state.eda.activeWindowId === windowItem.windowId ? 'is-selected' : ''} onClick={() => selectWindow(windowItem.windowId)}><span className="window-thumb"><MonitorCog size={20} /></span><span><strong>{windowItem.title || windowItem.projectName || '嘉立创EDA窗口'}</strong><small>{windowItem.windowId}</small></span></button>)}</div>}<div className="permission-matrix"><div><span>固定只读命令</span><strong className="text-success">连接后允许</strong></div><div><span>真实写命令</span><strong className="text-warning">计划校验与一次性批准后允许</strong></div><div><span>任意脚本</span><strong className="text-danger">永不允许</strong></div></div></div></Panel>
    </div>
    <Panel eyebrow="PCB PRODUCTION CAPABILITIES" title="真实 PCB 能力矩阵" meta={pcbCapabilities ? `嘉立创EDA ${pcbCapabilities.edaVersion} · API v${pcbCapabilities.apiVersion}` : '运行环境检查后读取'}><div className="permission-matrix">{(pcbCapabilities?.items || []).map((item) => <div key={item.id}><span>{item.id}</span><strong className={item.production ? 'text-success' : item.status === 'unavailable' ? 'text-danger' : 'text-warning'}>{item.status}{item.production ? ' · 可作为生产链路' : ' · 需人工复核'}</strong><small>{item.reason || item.api}</small></div>)}</div></Panel>
    <Panel eyebrow="CONTROLLED PCB PIPELINE" title="PCB真实读取、审批与执行" meta="所有写入均绑定一次性批准；Beta图元必须回读、DRC和人工复核"><div className="detail-stack"><div className="toolbar toolbar--wrap"><label className="search-box"><input aria-label="PCB文档UUID" value={pcbDocumentUuid} onChange={(event) => setPcbDocumentUuid(event.target.value)} placeholder="PCB文档UUID" /></label><Button icon={<MonitorCog size={14} />} loading={pcbBusy === 'open'} disabled={!/^[a-f0-9]{16,64}$/i.test(pcbDocumentUuid.trim())} onClick={openPcbDocument}>打开PCB编辑器</Button><Button icon={<RefreshCw size={14} />} loading={pcbBusy === 'context'} onClick={readPcbContext}>1. 读取真实PCB</Button><Button icon={<Bot size={14} />} loading={pcbBusy === 'compile'} onClick={compilePcbPlan}>2. 编译CH32V003计划</Button><Button icon={<Code2 size={14} />} loading={pcbBusy === 'validate'} onClick={validatePcbPlan}>3. 校验PCB计划</Button><Button icon={<ShieldCheck size={14} />} loading={pcbBusy === 'approve'} disabled={!pcbPlanning?.ready || !pcbContext?.complete} onClick={approvePcbPlan}>4. 人工批准PCB</Button><Button variant="primary" icon={<Play size={14} />} loading={pcbBusy === 'execute'} disabled={!pcbApproval} onClick={executePcbPlan}>5. 执行PCB写入</Button></div><textarea className="design-plan-editor" aria-label="结构化PCB生产计划" value={pcbPlanText} onChange={(event) => setPcbPlanText(event.target.value)} rows={14} spellCheck={false} /><div className="permission-matrix"><div><span>PCB目标证据</span><strong className={pcbContext && !pcbContext.complete ? 'text-danger' : ''}>{pcbContext ? `${pcbContext.windowId} · ${pcbContext.complete ? '完整' : '读取不完整'} · ${pcbContext.targetFingerprint.slice(0, 12)}` : '未读取'}</strong></div><div><span>PCB计划门禁</span><strong className={pcbPlanning?.ready ? 'text-warning' : ''}>{pcbPlanning ? pcbPlanning.ready ? `结构有效 · ${pcbPlanning.planHash.slice(0, 12)}` : `缺少 ${pcbPlanning.missing.length} 项` : '待校验'}</strong></div><div><span>PCB回读</span><strong>{pcbExecution?.readback ? `器件 ${pcbExecution.readback.componentCount} · 走线 ${pcbExecution.readback.lineCount} · 过孔 ${pcbExecution.readback.viaCount}` : '执行后强制回读'}</strong></div><div><span>官方PCB DRC</span><strong className={pcbExecution?.drc?.passed ? 'text-success' : 'text-warning'}>{pcbExecution?.drc ? pcbExecution.drc.passed ? '通过' : `${pcbExecution.drc.findings.length}项问题` : '尚未执行'}</strong></div><div><span>恢复/锁定状态</span><strong className={pcbExecution?.state === 'rollback_failed' ? 'text-danger' : pcbExecution?.state === 'rolled_back' ? 'text-success' : ''}>{pcbExecution?.state || '无执行记录'}</strong></div></div>{pcbPlanning && !pcbPlanning.ready && <div className="empty-inline"><strong>PCB计划阻断：</strong><span>{pcbPlanning.missing.join('、')}</span></div>}{pcbExecution && <div className="console"><header><div><DatabaseBackup size={14} /> PCB EXECUTION AUDIT</div></header><div className="console__body">{pcbExecution.events.map((item, index) => <div className={`console-line console-line--${item.status === 'passed' ? 'success' : 'error'}`} key={`${item.at}-${index}`}><span>{new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })}</span><Badge tone={item.status === 'passed' ? 'success' : 'danger'}>{item.status}</Badge><code>{item.stage}</code><pre>{JSON.stringify(item.detail)}</pre></div>)}</div></div>}</div></Panel>
    <Panel eyebrow="REVIEWED NETLIST PIPELINE" title="项目网络表 → 原理图受控执行" meta="AI只使用当前项目数据；真实写入前必须人工批准"><div className="detail-stack"><div className="toolbar toolbar--wrap"><Button icon={<Bot size={14} />} loading={designBusy === 'ai-plan'} onClick={generateAiPlan}>1. AI生成网络表草案</Button><Button icon={<ExternalLink size={14} />} loading={designBusy === 'open-schematic'} onClick={openProjectSchematic}>2. 打开关联原理图</Button><Button icon={<RefreshCw size={14} />} loading={designBusy === 'context'} onClick={readDesignContext}>读取当前原理图</Button><Button icon={<Code2 size={14} />} loading={designBusy === 'plan'} onClick={validatePlan}>3. 校验计划</Button><Button icon={<ShieldCheck size={14} />} loading={designBusy === 'approve'} disabled={!planning?.ready || !designContext} onClick={approvePlan}>4. 人工批准</Button><Button variant="primary" icon={<Play size={14} />} loading={designBusy === 'execute'} disabled={!approval} onClick={executePlan}>5. 生成原理图</Button></div>{reviewedNetlist && <div className="empty-inline"><strong>待审核网络表：</strong><span>{JSON.stringify(reviewedNetlist)}</span></div>}<textarea className="design-plan-editor" aria-label="结构化设计计划" value={planText} onChange={(event) => setPlanText(event.target.value)} rows={16} spellCheck={false} /><div className="permission-matrix"><div><span>目标证据</span><strong>{designContext ? `${designContext.windowId} · ${designContext.targetFingerprint.slice(0, 12)}` : '未读取'}</strong></div><div><span>计划门禁</span><strong className={planning?.ready ? 'text-success' : 'text-warning'}>{planning ? planning.ready ? `可批准 · ${planning.planHash.slice(0, 12)}` : `缺少 ${planning.missing.length} 项` : '待校验'}</strong></div><div><span>真实快照</span><strong>{execution?.snapshot ? `${execution.snapshot.digest.slice(0, 12)} · ${execution.snapshot.size} bytes` : '执行前硬门禁'}</strong></div><div><span>原理图 DRC（ERC等效）</span><strong className={execution?.drc?.passed ? 'text-success' : 'text-warning'}>{execution?.drc ? execution.drc.passed ? '官方检查通过' : `${execution.drc.findings.length}项问题` : '尚未执行'}</strong></div><div><span>恢复状态</span><strong className={execution?.state === 'rollback_failed' ? 'text-danger' : execution?.state === 'rolled_back' ? 'text-success' : ''}>{execution?.state || '无执行记录'}</strong></div></div>{planning && !planning.ready && <div className="empty-inline"><strong>仍需补全：</strong><span>{planning.missing.join('、')}</span></div>}{execution && <div className="console"><header><div><DatabaseBackup size={14} /> EXECUTION AUDIT</div></header><div className="console__body">{execution.events.map((item, index) => <div className={`console-line console-line--${item.status === 'passed' ? 'success' : 'error'}`} key={`${item.at}-${index}`}><span>{new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })}</span><Badge tone={item.status === 'passed' ? 'success' : 'danger'}>{item.status}</Badge><code>{item.stage}</code><pre>{JSON.stringify(item.detail)}</pre></div>)}</div></div>}</div></Panel>
    <Panel eyebrow="TYPED COMMAND CATALOG" title="命令控制台" meta="仅允许Runtime内登记的固定命令，不接收任意代码"><div className="toolbar toolbar--wrap"><SegmentedTabs label="命令权限" value={permissionFilter} onChange={setPermissionFilter} items={[{ value: 'all', label: '全部' }, { value: 'read', label: '只读' }, { value: 'write', label: '写入' }]} /><div className="toolbar__spacer" /><label className="search-box"><Search size={15} /><input value={commandQuery} onChange={(e) => setCommandQuery(e.target.value)} placeholder="搜索类型化命令" aria-label="搜索命令" /></label></div><div className="command-catalog">{visibleCommands.map((item) => <article className="command-card" key={item.command}><div className="command-card__icon"><Code2 size={18} /></div><div><code>{item.command}</code><strong>{item.label}</strong><small>{item.description}</small></div><Badge tone={item.permission === 'read' ? 'info' : 'warning'}>{item.permission === 'read' ? 'READ' : 'WRITE'}</Badge><Button size="sm" loading={runningCommand === item.command} icon={<Play size={13} />} onClick={() => execute(item)}>运行</Button></article>)}</div><div className="console"><header><div><span className="signal-dot" /> STRUCTURED RESPONSE LOG</div><Button variant="ghost" size="sm" icon={<Copy size={13} />} onClick={() => { navigator.clipboard?.writeText(state.eda.commandLogs.map((log) => `${log.time} ${log.command} ${log.result}`).join('\n')); notify('已复制', '结构化日志已复制到剪贴板。', 'success'); }}>复制日志</Button></header><div className="console__body">{state.eda.commandLogs.map((log) => <div className={`console-line console-line--${log.status}`} key={log.id}><span>{log.time}</span><Badge tone={log.permission === 'read' ? 'info' : 'warning'}>{log.permission}</Badge><code>{log.command}</code><span>{log.duration} ms</span><pre>{log.result}</pre></div>)}</div></div></Panel>
    </>}
    <ConfirmDialog open={createWorkspaceOpen} onClose={() => setCreateWorkspaceOpen(false)} onConfirm={createEasyEdaWorkspace} title="新建嘉立创EDA设计文件？" description={`将由后台打开嘉立创EDA，为项目“${activeProject?.name || '当前项目'}”创建一个新工程、关联原理图、原理图页和PCB文档，然后自动打开PCB。这不会覆盖现有工程。`} confirmLabel="确认新建并打开" />
    <ConfirmDialog open={executeConfirmOpen} onClose={() => setExecuteConfirmOpen(false)} onConfirm={executeConversationDesign} title="开始执行EDA设计？" description="将把已确认的AI PCB计划写入当前嘉立创EDA窗口。Runtime会先绑定目标和快照，执行后强制回读与DRC；失败时尝试恢复。" confirmLabel="确认并开始执行" />
    <ConfirmDialog open={disconnectOpen} onClose={() => setDisconnectOpen(false)} onConfirm={disconnect} title="断开本地桥接会话？" description="仅清除CircuitPilot中的会话状态，不关闭嘉立创EDA，也不修改工程。" confirmLabel="确认断开" danger />
  </>;
}
