import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bot, Check, ClipboardCheck, Cpu, FileImage, FileText, FolderOpen, ListChecks, MessageSquarePlus, Mic, Paperclip, RefreshCw, RotateCcw, Send, ShieldCheck, Sparkles, UserRound, X } from 'lucide-react';
import { Badge, Button, Panel, Stat } from '../components/ui';
import { ConfirmDialog } from '../components/overlays';
import { LongTaskPanel } from '../components/LongTaskPanel';
import { createSingleCallTask, type LongTaskSnapshot, type SingleCallController } from '../services/longTask';
import { useApp } from '../state/AppContext';
import { RuntimeApiError, runtimeClient } from '../services/runtimeClient';
import { saveSemanticPlanDraft } from '../services/draftStore';
import { invalidateTaskApproval } from '../state/taskMachine';
import { IMAGE_MIME_TYPES, verifyImageSignature } from '../utils/imageSignature';
import { mergeSpeechTranscript, useVoiceInput } from '../utils/useVoiceInput';
import { providerLabel } from '../data/providerCatalog';
import type { BomDraft, ChatMessage, ChatState, ComponentItem, Requirement, RequirementSuggestion } from '../types';

const quickPrompts = [
  '请检查目前从零设计这块PCBA还缺少哪些关键信息，并按优先级向我提问。',
  '请根据当前BOM检查电源、接口、封装和替代料方面的风险。',
  '请根据当前项目已确认的需求和资料生成一份BOM草案；缺少关键参数时先向我提问。',
  '请只针对PCB尺寸、接口位置、安装孔和结构净空向我提问。',
];
const now = () => new Date().toLocaleString('zh-CN', { hour12: false });
const unavailableChat: ChatState = { sessionId: '', messages: [], status: 'idle', lastError: null, lastEdaEvidence: null };
type PendingAttachment = { id: string; name: string; mime: string; size: number; kind: 'image' | 'text'; payload: string };
const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|log|ini|cfg|conf|net|netlist|bom|cpl|kicad_sch|kicad_pcb)$/i;

function BomDraftCard({ draft, onConfirm }: { draft: BomDraft; onConfirm: () => void }) {
  const blocked = draft.status === 'blocked';
  return <section className={`bom-draft bom-draft--${draft.status}`} aria-label={draft.title}>
    <header><div><span>AI BOM DRAFT</span><strong>{draft.title}</strong></div><Badge tone={blocked ? 'warning' : draft.status === 'applied' ? 'success' : 'info'}>{blocked ? '信息不足' : draft.status === 'applied' ? '已写入BOM' : '等待确认'}</Badge></header>
    {draft.summary && <p className="bom-draft__summary">{draft.summary}</p>}
    {!!draft.blockingQuestions.length && <div className="bom-draft__blockers"><strong>生成BOM前必须确认</strong>{draft.blockingQuestions.map((question, index) => <p key={`${question}-${index}`}>{index + 1}. {question}</p>)}</div>}
    {!!draft.assumptions.length && <div className="bom-draft__assumptions"><strong>假设与待确认项</strong>{draft.assumptions.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}</div>}
    {!!draft.items.length && <div className="bom-draft__table"><table><thead><tr><th>位号 / 数量</th><th>建议型号</th><th>封装 / LCSC</th><th>证据</th><th>状态</th></tr></thead><tbody>{draft.items.map((item) => <tr key={item.id}><td><strong>{item.refdes}</strong><small>数量 {item.qty}</small></td><td><strong>{item.mpn || '待确认'}</strong><small>{item.manufacturer || item.value}</small></td><td><span>{item.package || '待确认'}</span><code>{item.lcscId || '—'}</code>{item.candidates[0] && <small>嘉立创候选：{item.candidates[0].name}</small>}</td><td><small>{item.evidence.join(' · ') || '无明确证据'}</small></td><td><Badge tone={item.status === 'ready' ? 'success' : item.status === 'risk' ? 'danger' : 'warning'}>{item.status === 'ready' ? '可确认' : item.status === 'risk' ? '风险' : '待确认'}</Badge><small>{item.confidence === 'high' ? '高置信' : item.confidence === 'medium' ? '中置信' : '低置信'}</small></td></tr>)}</tbody></table></div>}
    {draft.status === 'draft' && <footer><span>确认只写入当前项目资料库，不会绑定器件或修改嘉立创EDA。</span><Button variant="primary" icon={<ClipboardCheck size={14} />} onClick={onConfirm}>确认写入当前项目BOM</Button></footer>}
    {draft.status === 'applied' && <footer><span>已于 {draft.appliedAt} 写入当前项目，可到“资料与 BOM”继续核对并绑定器件。</span></footer>}
  </section>;
}

export function AiTasksPage() {
  const { state, dispatch, activeProject, notify, addAudit, recordChange, reportIssue, navigate } = useApp();
  const [input, setInput] = useState('');
  // 语音输入（Web Speech API）。小白的自然语言需求就是从这里进来的，因此：
  // 识别结果只**追加**到用户已经打的字后面，绝不覆盖；临时结果单独回显，不写进输入框；
  // 浏览器不支持或麦克风被拒绝时给一句中文人话说明，输入框照常可用。
  const voice = useVoiceInput({ lang: 'zh-CN' });
  const { finalText: voiceFinalText, clearFinalText: clearVoiceFinalText } = voice;
  useEffect(() => {
    if (!voiceFinalText) return;
    setInput((current) => mergeSpeechTranscript(current, voiceFinalText));
    clearVoiceFinalText();
  }, [voiceFinalText, clearVoiceFinalText]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [draftToApply, setDraftToApply] = useState<ChatMessage | null>(null);
  const [codexReady, setCodexReady] = useState<boolean | null>(null);
  // 历史会话：Runtime 落盘的对话（含 API/自动化创建的会话）都能在这里重新打开，避免"脚本跑的 AI 对话在 UI 里看不到"。
  const [runtimeSessions, setRuntimeSessions] = useState<Array<{ sessionId: string; updatedAt: string | null; messageCount: number; preview: string }>>([]);
  const [historySessionId, setHistorySessionId] = useState<string>('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const aiProviderId = state.settings.provider === 'demo' ? 'codex_account' : state.settings.provider;
  // 注册表自定义 Provider 不在前端目录里；显示名以 Runtime 上报为准，目录 id 只作为离线兜底。
  const aiProviderLabel = state.runtime.providers.find((item) => item.id === aiProviderId)?.label || providerLabel(aiProviderId);
  const apiBackend = aiProviderId !== 'codex_account';
  const [checking, setChecking] = useState(false);
  const [productionPlanning, setProductionPlanning] = useState(false);
  // D8：AI 生产计划生成是 180s 级长调用，统一走单调用长任务控制器。
  const [planSnapshot, setPlanSnapshot] = useState<LongTaskSnapshot<Awaited<ReturnType<typeof runtimeClient.generateProductionPlan>>> | null>(null);
  const planTaskRef = useRef<SingleCallController<Awaited<ReturnType<typeof runtimeClient.generateProductionPlan>>> | null>(null);
  const [productionCandidate, setProductionCandidate] = useState<{ status: 'ready' | 'blocked'; explanation: string; blockingInformation: Array<{ code: string; question: string; reason: string }>; plan: Record<string, unknown> | null; planHash?: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // D8：需求对话发送是 150s 级长调用；用统一单调用控制器接管取消/超时/重试措辞，
  // 消息状态机仍由既有 dispatch 维护（"停止等待"≠服务端任务终止）。
  type ChatTurn = Awaited<ReturnType<typeof runtimeClient.sendChat>>;
  const [sendTask, setSendTask] = useState<LongTaskSnapshot<ChatTurn> | null>(null);
  const sendTaskRef = useRef<SingleCallController<ChatTurn> | null>(null);
  const sendFailureRef = useRef<RuntimeApiError | null>(null);
  const chat = state.projectChats[state.activeProjectId] || unavailableChat;
  const missing = useMemo(() => state.requirements.filter((item) => item.status === 'missing' || item.status === 'conflict'), [state.requirements]);
  const pendingSuggestions = chat.messages.reduce((sum, message) => sum + (message.suggestions?.filter((item) => item.status === 'pending').length || 0), 0);
  // 从验证页"创建修复任务"带过来的目标：只有 planHash 以 fix- 开头才认，
  // 避免把普通任务目标误当修复指令塞进计划生成。
  const validationFixGoal = useMemo(() => (state.task.goal && state.task.planHash?.startsWith('fix-') ? state.task.goal : null), [state.task.goal, state.task.planHash]);
  useEffect(() => {
    if (!validationFixGoal) return;
    setInput((current) => (current.trim() ? current : validationFixGoal));
  }, [validationFixGoal]);
  const projectComponents = useMemo(() => state.components.filter((item) => item.projectId === state.activeProjectId), [state.components, state.activeProjectId]);
  const bomCount = projectComponents.reduce((sum, item) => sum + item.qty, 0);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [chat.messages, chat.status]);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      setChecking(true);
      try { const result = await runtimeClient.chatStatus(aiProviderId); if (!cancelled) setCodexReady(result.ready); }
      catch { if (!cancelled) setCodexReady(false); }
      finally { if (!cancelled) setChecking(false); }
    };
    void check();
    return () => { cancelled = true; };
  }, [aiProviderId]);

  const context = () => ({ project: activeProject, requirements: state.requirements, components: projectComponents, assets: state.assets, recentConversation: chat.messages.slice(-12).filter((item) => item.status === 'complete').map((item) => ({ role: item.role, content: item.content })) });

  // C1：从 Runtime transcript 恢复对话。localStorage 只作为 UI 缓存；换浏览器/清缓存后，
  // 以 runtime 落盘记录为准重建消息列表（线程本身 ephemeral，靠 transcript 重建上下文）。
  const hydratedSession = useRef<string | null>(null);
  useEffect(() => {
    if (!activeProject || state.runtime.mode === 'demo' || !state.runtime.reachable) return;
    if (chat.messages.length || !chat.sessionId || hydratedSession.current === chat.sessionId) return;
    hydratedSession.current = chat.sessionId;
    let cancelled = false;
    void (async () => {
      try {
        const { transcript } = await runtimeClient.chatTranscript(chat.sessionId);
        if (cancelled || !transcript.messages?.length) return;
        transcript.messages.forEach((entry, index) => {
          dispatch({ type: 'ADD_CHAT_MESSAGE', message: { id: `transcript-${chat.sessionId}-${index}`, role: entry.role, content: entry.content, createdAt: entry.at ? new Date(entry.at).toLocaleString('zh-CN', { hour12: false }) : now(), status: 'complete' } });
        });
        addAudit('ai', '从 Runtime 恢复聊天记录', `${transcript.messages.length} 条 · ${chat.sessionId}`, 'info');
      } catch (error) {
        // 恢复失败不阻塞对话；下一次发送成功仍会继续落盘。明确提示而不是静默。
        notify('恢复聊天记录失败', error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : 'Runtime 不可达或记录损坏，本次先以新会话继续。', 'warning');
      }
    })();
    return () => { cancelled = true; };
  }, [activeProject, addAudit, chat.messages.length, chat.sessionId, dispatch, notify, state.runtime.mode, state.runtime.reachable]);

  const refreshRuntimeSessions = async () => {
    if (state.runtime.mode === 'demo' || !state.runtime.reachable) return;
    try { setRuntimeSessions(await runtimeClient.chatSessions()); } catch { /* 历史列表不是关键路径，失败时保持现状 */ }
  };
  useEffect(() => { void refreshRuntimeSessions(); }, [state.runtime.mode, state.runtime.reachable]);
  const openHistorySession = async (sessionId: string) => {
    if (!sessionId) return;
    setLoadingHistory(true);
    try {
      const { transcript } = await runtimeClient.chatTranscript(sessionId);
      if (!transcript.messages?.length) { notify('该会话没有记录', sessionId, 'warning'); return; }
      dispatch({ type: 'RESET_CHAT', sessionId });
      transcript.messages.forEach((entry, index) => {
        dispatch({ type: 'ADD_CHAT_MESSAGE', message: { id: `history-${sessionId}-${index}`, role: entry.role, content: entry.content, createdAt: entry.at ? new Date(entry.at).toLocaleString('zh-CN', { hour12: false }) : now(), status: 'complete' } });
      });
      setHistorySessionId(sessionId);
      addAudit('ai', '打开 Runtime 历史会话', `${transcript.messages.length} 条 · ${sessionId}`, 'info');
      notify('已载入历史会话', `${transcript.messages.length} 条消息，后续对话会继续记录到该会话。`, 'success');
    } catch (error) {
      notify('载入历史会话失败', error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : 'Runtime 不可达或记录损坏。', 'danger');
    } finally { setLoadingHistory(false); }
  };

  const chooseAttachments = async (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files).slice(0, Math.max(0, 4 - attachments.length));
    const accepted: PendingAttachment[] = [];
    for (const file of selected) {
      const image = (IMAGE_MIME_TYPES as readonly string[]).includes(file.type);
      const textFile = file.type.startsWith('text/') || TEXT_FILE.test(file.name);
      if (!image && !textFile) { notify('附件格式暂不支持', `${file.name}：对话目前支持PNG/JPG/WebP/GIF和文本、CSV、JSON、XML、YAML、网表等文本类文件。`, 'warning'); continue; }
      if (image && file.size > 5 * 1024 * 1024) { notify('图片过大', `${file.name}超过5MB。`, 'warning'); continue; }
      if (textFile && file.size > 1024 * 1024) { notify('文件过大', `${file.name}超过1MB。`, 'warning'); continue; }
      if (image) {
        // 客户端失败关闭：File.type 可被伪造，必须用真实文件签名复核后才接受图片。
        let bytes: Uint8Array;
        try { bytes = new Uint8Array(await file.arrayBuffer()); }
        catch { notify('图片读取失败', `${file.name}：无法读取文件字节，已拒绝该附件。`, 'danger'); continue; }
        const verdict = verifyImageSignature(bytes, file.type);
        if (!verdict.ok) { notify('图片签名校验未通过', `${file.name}：${verdict.reason}。为避免伪造载荷，已拒绝该附件。`, 'danger'); continue; }
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
        accepted.push({ id: `attachment-${Date.now()}-${accepted.length}`, name: file.name, mime: verdict.detected, size: file.size, kind: 'image', payload: dataUrl.split(',')[1] || '' });
      }
      else accepted.push({ id: `attachment-${Date.now()}-${accepted.length}`, name: file.name, mime: file.type || 'text/plain', size: file.size, kind: 'text', payload: (await file.text()).slice(0, 200_000) });
    }
    setAttachments((current) => [...current, ...accepted].slice(0, 4));
    if (attachmentRef.current) attachmentRef.current.value = '';
  };

  const selectProject = (projectId: string) => {
    if (chat.status === 'sending' || projectId === state.activeProjectId) return;
    const project = state.projects.find((item) => item.id === projectId);
    dispatch({ type: 'SET_ACTIVE_PROJECT', id: projectId });
    setInput('');
    setAttachments([]);
    setProductionCandidate(null);
    addAudit('ai', '切换AI对话项目', project?.name || projectId, 'info');
    notify('已恢复项目对话', `${project?.name || '所选项目'} 的独立会话上下文已加载。`, 'success');
  };

  const generateProductionPlan = async () => {
    setProductionPlanning(true);
    setPlanSnapshot(null);
    const task = createSingleCallTask({
      call: (signal) => runtimeClient.generateProductionPlan(context(), state.settings.model === 'auto' ? null : state.settings.model, validationFixGoal || undefined, aiProviderId, state.settings.baseUrl || undefined, { signal }),
      timeoutMs: 180_000,
      onUpdate: setPlanSnapshot,
    });
    planTaskRef.current = task;
    const snapshot = await task.startTask();
    setProductionPlanning(false);
    if (snapshot.status !== 'done' || !snapshot.result) {
      if (snapshot.status === 'failed') notify('PCBA计划生成失败', snapshot.error || '未知错误', 'danger');
      else notify('已停止等待计划生成', snapshot.note || '本页已停止等待；模型可能仍在服务端生成，稍后可重试（重试会重新生成并替换旧批准）。', 'warning');
      return;
    }
    const result = snapshot.result;
    const candidate = { ...result.candidate, planHash: result.planning?.planHash };
    setProductionCandidate(candidate);
    if (candidate.status === 'ready' && result.planning?.ready) {
      // 新生成的计划会替换旧批准：显式让原批准失效，避免旧批准被静默复用到新的计划哈希上。
      dispatch({ type: 'SET_TASK', task: invalidateTaskApproval(state.task, { planHash: result.planning.planHash, unknowns: [], evidence: ['Codex结构化PCBA计划', '实时嘉立创EDA PCB证据'] }) });
      addAudit('ai', '生成可验证PCBA语义计划', result.planning.planHash, 'success');
      notify('PCBA计划已通过Schema校验', '请进入EDA页继续编译、审查和批准，当前尚未写入。', 'success');
    } else {
      addAudit('ai', 'PCBA计划被阻断', `${candidate.blockingInformation.length}项关键信息缺失`, 'warning');
      notify('暂不能生成写入计划', `Codex识别出${candidate.blockingInformation.length}项阻断信息。`, 'warning');
    }
  };

  /**
   * 计划交接：把**结构化计划对象**存进会话级草稿，再跳 EDA 页。
   * 之前这里只有 navigate('eda')，EDA 页对候选计划一无所知，等于断了链。
   */
  const handoffPlanToEda = () => {
    if (!productionCandidate?.plan || !productionCandidate.planHash) return notify('计划尚未就绪', '请先生成可验证的语义计划，再进入 EDA 编译与审批。', 'warning');
    saveSemanticPlanDraft({ plan: productionCandidate.plan, planHash: productionCandidate.planHash, explanation: productionCandidate.explanation, source: 'ai-page' });
    addAudit('ai', '计划草稿交接至EDA页（PCB写入链）', productionCandidate.planHash, 'info');
    // P0-8：说清这条链只写 PCB；原理图写入是另一条 AI 网表草案链，血缘互不代用（避免“批准了AI计划却写原理图”的错觉）。
    notify('计划已带入 EDA 页（PCB 写入链）', '该语义计划只用于 PCB 高级编译与受控执行；原理图写入请在 EDA 页单独生成 AI 网表草案并人工批准，两条链血缘独立、不能互相顶替。', 'success');
    navigate('eda');
  };

  const dismissValidationFix = () => {
    dispatch({ type: 'PATCH_TASK', patch: { goal: '', planHash: '', status: 'draft', steps: [], progress: 0 } });
    setInput((current) => (current.trim() === validationFixGoal ? '' : current));
    notify('已忽略修复目标', '验证页的问题仍保留，可随时重新创建修复任务。', 'info');
  };

  const send = async (content = input, retryMessageId?: string) => {
    const currentAttachments = retryMessageId ? [] : attachments;
    const message = content.trim() || (currentAttachments.length ? '请分析我上传的附件，提取与当前PCBA设计相关的需求、参数、风险和待确认项。' : '');
    if (!activeProject || !message || chat.status === 'sending') return;
    const ownerProjectId = activeProject.id;
    const userMessageId = retryMessageId || `chat-user-${Date.now()}`;
    if (retryMessageId) dispatch({ type: 'UPDATE_CHAT_MESSAGE', id: retryMessageId, patch: { status: 'sending', errorCode: undefined } });
    else dispatch({ type: 'ADD_CHAT_MESSAGE', message: { id: userMessageId, role: 'user', content: message, createdAt: now(), status: 'sending', attachments: currentAttachments.map(({ id, name, mime, size, kind }) => ({ id, name, mime, size, kind })) } });
    dispatch({ type: 'PATCH_CHAT', patch: { status: 'sending', lastError: null } });
    setInput(''); setAttachments([]);
    sendFailureRef.current = null;
    const task = createSingleCallTask<ChatTurn>({
      timeoutMs: 160_000,
      onUpdate: setSendTask,
      call: async (signal) => {
        try {
          const result = await runtimeClient.sendChat(chat.sessionId, { message, model: state.settings.model === 'auto' ? null : state.settings.model, provider: aiProviderId, baseUrl: state.settings.baseUrl || undefined, context: context(), attachments: currentAttachments.map((item) => item.kind === 'image' ? { kind: 'image' as const, name: item.name, mime: item.mime, dataBase64: item.payload } : { kind: 'text' as const, name: item.name, mime: item.mime, text: item.payload }) }, { signal });
          dispatch({ type: 'UPDATE_CHAT_MESSAGE', id: userMessageId, patch: { status: 'complete' } });
          const assistant: ChatMessage = { id: `chat-assistant-${Date.now()}`, role: 'assistant', content: result.reply, createdAt: now(), status: 'complete', questions: result.questions, suggestions: result.requirementSuggestions, bomDraft: result.bomDraft ? { ...result.bomDraft, projectId: ownerProjectId } : undefined, citations: result.knowledgeCitations, knowledgeNote: result.knowledgeNote ?? null };
          dispatch({ type: 'ADD_CHAT_MESSAGE', message: assistant });
          dispatch({ type: 'PATCH_CHAT', patch: { status: 'idle', lastError: null, lastEdaEvidence: { status: result.eda.status, reason: result.eda.reason, windowCount: result.eda.windowCount } } });
          dispatch({ type: 'PATCH_EDA', patch: { connected: result.eda.status === 'available', windowCount: result.eda.windowCount || 0, bridgeStatus: result.eda.status === 'available' ? 'running' : state.eda.bridgeStatus } });
          setCodexReady(true);
          addAudit('ai', 'Codex需求对话完成', `${message.slice(0, 80)} · ${result.requirementSuggestions.length} 项待确认建议`, 'success');
          recordChange({ source: 'ai', actor: 'Codex账号', action: 'chat', objectType: 'chat-session', objectId: chat.sessionId, summary: `完成一轮PCBA需求澄清，产生${result.requirementSuggestions.length}项建议`, reason: '通过对话完善设计输入' });
          return result;
        } catch (error) {
          const runtimeError = error instanceof RuntimeApiError ? error : new RuntimeApiError('CHAT_FAILED', error instanceof Error ? error.message : 'AI对话失败');
          sendFailureRef.current = runtimeError;
          throw runtimeError;
        }
      },
    });
    sendTaskRef.current = task;
    const settled = await task.startTask();
    if (settled.status === 'failed') {
      const runtimeError = sendFailureRef.current ?? new RuntimeApiError('CHAT_FAILED', settled.error || 'AI对话失败');
      dispatch({ type: 'UPDATE_CHAT_MESSAGE', id: userMessageId, patch: { status: 'error', errorCode: runtimeError.code } });
      dispatch({ type: 'PATCH_CHAT', patch: { status: 'error', lastError: { code: runtimeError.code, message: runtimeError.message } } });
      if (runtimeError.code === 'CODEX_ACCOUNT_NOT_READY' || runtimeError.code === 'PROVIDER_CREDENTIAL_MISSING' || runtimeError.code === 'PROVIDER_UNAUTHORIZED') setCodexReady(false);
      reportIssue({ fingerprint: `chat:${runtimeError.code}:${chat.sessionId}`, source: 'ai', severity: 'error', status: 'open', code: runtimeError.code, summary: 'Codex需求对话失败', detail: runtimeError.message, suggestedAction: runtimeError.code === 'CODEX_ACCOUNT_NOT_READY' ? '进入系统设置完成Codex账号登录和连接测试。' : '保持Runtime运行后重试本条消息。' });
      notify('AI对话失败', runtimeError.message, 'danger');
    } else if (settled.status !== 'done') {
      const code = settled.status === 'timeout' ? 'CHAT_TIMEOUT' : 'CHAT_STOPPED_WAITING';
      const detail = settled.note || (settled.status === 'timeout'
        ? '本页等待超时：模型可能仍在生成，稍后重试或刷新会话。'
        : '本页已停止等待：服务端可能仍在生成，回复稍后可能出现在会话里。');
      dispatch({ type: 'UPDATE_CHAT_MESSAGE', id: userMessageId, patch: { status: 'error', errorCode: code } });
      dispatch({ type: 'PATCH_CHAT', patch: { status: 'error', lastError: { code, message: detail } } });
      notify(settled.status === 'timeout' ? 'AI对话等待超时' : '已停止等待AI回复', detail, 'warning');
    }
  };

  const decideSuggestion = (messageId: string, suggestion: RequirementSuggestion, accepted: boolean) => {
    if (!accepted) { dispatch({ type: 'DECIDE_CHAT_SUGGESTION', messageId, suggestionId: suggestion.id, status: 'rejected' }); addAudit('ai', '拒绝AI需求建议', `${suggestion.category} · ${suggestion.name}`, 'warning'); return; }
    const existing = suggestion.action === 'update' ? state.requirements.find((item) => item.id === suggestion.targetRequirementId) : undefined;
    const requirement: Requirement = existing ? { ...existing, category: suggestion.category, name: suggestion.name, value: suggestion.value, unit: suggestion.unit, kind: suggestion.kind, blocking: suggestion.blocking, note: suggestion.note, source: 'AI需求对话 · 用户已接受', status: 'suggested', updatedAt: now() } : { id: `req-ai-${Date.now()}`, category: suggestion.category, name: suggestion.name, value: suggestion.value, unit: suggestion.unit, kind: suggestion.kind, blocking: suggestion.blocking, note: suggestion.note, source: 'AI需求对话 · 用户已接受', status: 'suggested', updatedAt: now() };
    dispatch(existing ? { type: 'UPDATE_REQUIREMENT', requirement } : { type: 'ADD_REQUIREMENT', requirement });
    dispatch({ type: 'DECIDE_CHAT_SUGGESTION', messageId, suggestionId: suggestion.id, status: 'accepted' });
    recordChange({ source: 'user', actor: '本机用户', action: existing ? 'update' : 'create', objectType: 'requirement', objectId: requirement.id, summary: `接受AI建议：${requirement.name}`, before: existing, after: requirement, reason: '用户在AI需求对话中明确接受' });
    addAudit('requirement', '接受AI需求建议', `${requirement.category} · ${requirement.name} = ${requirement.value}${requirement.unit}`, 'success');
    notify('已写入需求库', `${requirement.name}仍标记为“建议”，可在需求页继续确认。`, 'success');
  };

  const applyBomDraft = () => {
    const message = draftToApply;
    const draft = message?.bomDraft;
    if (!message || !draft || draft.status !== 'draft' || !activeProject) return;
    if (draft.projectId && draft.projectId !== activeProject.id) {
      const owner = state.projects.find((item) => item.id === draft.projectId);
      const detail = `草案属于“${owner?.name || draft.projectId}”，当前项目是“${activeProject.name}”`;
      addAudit('project', '拒绝跨项目写入AI BOM草案', detail, 'warning');
      notify('BOM草案属于其他项目', `${detail}，本次没有写入任何BOM。请先切换回原项目再确认。`, 'warning');
      setDraftToApply(null);
      return;
    }
    const appliedAt = now();
    const components: ComponentItem[] = draft.items.map((item, index) => ({ id: `cmp-ai-${Date.now()}-${index}`, projectId: activeProject.id, refdes: item.refdes, mpn: item.mpn, manufacturer: item.manufacturer, package: item.package, lcscId: item.lcscId, qty: item.qty, value: item.value, status: item.status === 'risk' ? 'risk' : 'pending', risk: item.risk || (item.status === 'pending' ? 'AI草案仍有待确认字段' : undefined) }));
    dispatch({ type: 'APPLY_BOM_DRAFT', messageId: message.id, components, appliedAt });
    recordChange({ source: 'user', actor: '本机用户', action: 'create', objectType: 'bom', objectId: draft.id, summary: `确认AI BOM草案：${components.length}行`, after: components, reason: '用户在AI对话中明确确认写入当前项目BOM' });
    addAudit('project', '确认AI BOM草案', `${activeProject.name} · ${components.length}行`, 'success');
    notify('BOM草案已写入', `已更新当前项目${components.length}行BOM；嘉立创器件身份仍需逐项确认绑定。`, 'success');
    setDraftToApply(null);
  };

  const reset = async () => {
    try { await runtimeClient.resetChat(chat.sessionId); } catch { /* Local reset remains available if Runtime restarted. */ }
    dispatch({ type: 'RESET_CHAT', sessionId: `chat-${Date.now()}` });
    setAttachments([]);
    addAudit('ai', '新建需求对话', `旧会话 ${chat.sessionId} 已结束`, 'info');
    notify('已新建对话', '已接受的项目需求不会被清除。', 'success');
  };
  const evidence = chat.lastEdaEvidence;
  const edaLabel = evidence?.status === 'available' ? '已读取' : evidence?.status === 'selection_required' ? '待选窗口' : evidence ? '不可用' : state.eda.connected ? '待本轮读取' : '未连接';
  const draftOwner = draftToApply?.bomDraft?.projectId ? state.projects.find((item) => item.id === draftToApply?.bomDraft?.projectId) : undefined;
  const draftTargetProject = draftOwner || activeProject;
  const draftCrossProject = Boolean(draftOwner && activeProject && draftOwner.id !== activeProject.id);

  return <>
    <div className="ai-project-switcher"><div className="ai-project-switcher__label"><FolderOpen size={17} /><span><strong>AI对话项目</strong><small>每个项目独立保存会话历史与上下文</small></span></div><label><span className="visually-hidden">选择AI对话项目</span><select value={state.activeProjectId} onChange={(event) => selectProject(event.target.value)} disabled={chat.status === 'sending' || !state.projects.length} aria-label="选择AI对话项目"><option value="" disabled>选择项目</option>{state.projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.code}{project.archived ? ' · 已归档' : ''}</option>)}</select></label><label><span className="visually-hidden">历史会话</span><select value={historySessionId} onChange={(event) => { const id = event.target.value; setHistorySessionId(id); void openHistorySession(id); }} disabled={loadingHistory || chat.status === 'sending' || !runtimeSessions.length} aria-label="历史会话"><option value="">{runtimeSessions.length ? `历史会话（${runtimeSessions.length}）` : '暂无历史会话'}</option>{runtimeSessions.map((item) => <option key={item.sessionId} value={item.sessionId}>{`${item.sessionId.slice(0, 34)} · ${item.messageCount}条 · ${item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间'}`}</option>)}</select></label><div className="ai-project-switcher__memory"><span>{chat.messages.length} 条消息</span><code>{chat.sessionId || '未创建会话'}</code></div></div>
    {validationFixGoal ? (
      <div className="inline-alert inline-alert--info" role="status">
        <ClipboardCheck size={16} />
        <span><strong>已从验证页带入修复目标：</strong>{validationFixGoal}</span>
        <Button size="sm" onClick={dismissValidationFix}>忽略</Button>
      </div>
    ) : null}
    {state.task.invalidation ? (
      <div className="inline-alert inline-alert--warning" role="status">
        <AlertTriangle size={16} />
        <span><strong>旧计划/批准已自动失效：</strong>{state.task.invalidation.reason}（触发：{state.task.invalidation.trigger === 'requirement' ? '需求变化' : state.task.invalidation.trigger === 'component' ? '器件清单变化' : state.task.invalidation.trigger === 'asset' ? '设计资料变化' : '项目变化'} · {new Date(state.task.invalidation.at).toLocaleString('zh-CN')}）。请重新生成计划并重新批准，旧 planHash 已作废。</span>
      </div>
    ) : null}
    <div className="stats-grid stats-grid--4"><Stat label="AI 后端" value={checking ? '检查中' : codexReady ? '真实连接' : '未就绪'} hint={apiBackend ? `${aiProviderLabel} · ${state.settings.model === 'auto' ? '自动模型' : state.settings.model}` : (codexReady ? '复用本机ChatGPT登录态' : '请到系统设置完成连接')} tone={codexReady ? 'success' : 'warning'} /><Stat label="需求完整度" value={`${Math.round((state.requirements.filter((item) => item.status === 'confirmed').length / Math.max(state.requirements.length, 1)) * 100)}%`} hint={`${missing.length}项缺失或冲突`} tone={missing.length ? 'warning' : 'success'} /><Stat label="BOM上下文" value={`${state.components.length}种 / ${bomCount}件`} hint="仅发送结构化字段" /><Stat label="EDA证据" value={edaLabel} hint="只允许工程/文档固定读取" tone={evidence?.status === 'available' ? 'success' : 'neutral'} /></div>
    <div className="ai-chat-layout">
      <Panel eyebrow="REAL CODEX CHAT" title="PCBA需求对话" meta="通过追问完善信息；不会直接修改嘉立创EDA" actions={<Button icon={<MessageSquarePlus size={15} />} onClick={() => setResetOpen(true)} disabled={chat.status === 'sending' || !activeProject}>新建对话</Button>}>
        <div className="chat-workspace"><div className="chat-safety"><ShieldCheck size={16} /><span><strong>当前为真实AI · 只读澄清</strong><small>Codex可分析应用提供的项目资料；需求建议需你确认，EDA写入始终关闭。</small></span></div><div className="chat-messages" aria-live="polite">
          {!chat.messages.length && <div className="chat-empty"><Bot size={38} /><h3>先告诉我你准备设计什么板</h3><p>我会结合当前项目、BOM、需求和嘉立创EDA只读状态，逐项找出缺少的信息。</p><div className="chat-quick-list">{quickPrompts.map((prompt) => <button type="button" key={prompt} onClick={() => setInput(prompt)}>{prompt}</button>)}</div></div>}
          {chat.messages.map((message) => <article className={`chat-message chat-message--${message.role}`} key={message.id}><div className="chat-avatar">{message.role === 'assistant' ? <Bot size={17} /> : <UserRound size={17} />}</div><div className="chat-bubble"><header><strong>{message.role === 'assistant' ? 'Codex · PCBA工程助手' : '你'}</strong><span>{message.createdAt}</span></header><div className="chat-copy">{message.content}</div>
            {!!message.attachments?.length && <div className="chat-attachments chat-attachments--message">{message.attachments.map((item) => <span key={item.id}>{item.kind === 'image' ? <FileImage size={13} /> : <FileText size={13} />}<strong>{item.name}</strong><small>{Math.max(1, Math.round(item.size / 1024))} KB</small></span>)}</div>}
            {message.status === 'sending' && <div className="chat-turn-state"><RefreshCw className="spin" size={13} /> 正在读取项目上下文和附件并分析…</div>}
            {message.status === 'error' && <div className="chat-error"><AlertTriangle size={15} /><span>{chat.lastError?.message || '本条消息发送失败'}</span><Button size="sm" icon={<RotateCcw size={13} />} onClick={() => send(message.content, message.id)}>重试</Button></div>}
            {!!message.questions?.length && <div className="chat-questions"><strong>还需要你确认</strong>{message.questions.map((question, index) => <p key={`${question}-${index}`}>{index + 1}. {question}</p>)}</div>}
            {!!message.citations?.length && <div className="chat-citations"><strong>知识库引用（仅已审核、未过期）</strong>{message.citations.map((citation) => <p key={citation.id}><Badge tone={citation.review === 'approved' ? 'success' : 'neutral'}>{citation.trust || 'unknown'}</Badge> <span>{citation.title || citation.id}</span>{citation.citation && <small> · {citation.citation}</small>}</p>)}</div>}
            {message.knowledgeNote && !message.citations?.length && <div className="chat-citations chat-citations--empty"><small>{message.knowledgeNote}</small></div>}
            {!!message.suggestions?.length && <div className="suggestion-list"><div className="suggestion-list__title"><ListChecks size={15} /><strong>可写入需求库的建议</strong><span>需逐条确认</span></div>{message.suggestions.map((suggestion) => <div className={`suggestion-card suggestion-card--${suggestion.status}`} key={suggestion.id}><div><div className="suggestion-card__meta"><Badge tone={suggestion.kind === 'hard' ? 'warning' : 'info'}>{suggestion.kind === 'hard' ? '硬约束' : '软约束'}</Badge><span>{suggestion.action === 'update' ? '更新现有需求' : '新增需求'}</span></div><strong>{suggestion.category} · {suggestion.name}</strong><p>{suggestion.value}{suggestion.unit} {suggestion.note && `· ${suggestion.note}`}</p></div>{suggestion.status === 'pending' ? <div className="suggestion-actions"><Button size="sm" icon={<X size={13} />} onClick={() => decideSuggestion(message.id, suggestion, false)}>拒绝</Button><Button size="sm" variant="primary" icon={<Check size={13} />} onClick={() => decideSuggestion(message.id, suggestion, true)}>接受并写入</Button></div> : <Badge tone={suggestion.status === 'accepted' ? 'success' : 'neutral'}>{suggestion.status === 'accepted' ? '已接受' : '已拒绝'}</Badge>}</div>)}</div>}
            {message.bomDraft && <BomDraftCard draft={message.bomDraft} onConfirm={() => setDraftToApply(message)} />}
          </div></article>)}<div ref={endRef} /></div>
          <div className="chat-composer">{!!attachments.length && <div className="chat-attachments">{attachments.map((item) => <span key={item.id}>{item.kind === 'image' ? <FileImage size={14} /> : <FileText size={14} />}<strong>{item.name}</strong><small>{Math.max(1, Math.round(item.size / 1024))} KB</small><button type="button" aria-label={`移除附件 ${item.name}`} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}><X size={12} /></button></span>)}</div>}<textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={!activeProject ? '请先选择或创建项目…' : codexReady === false ? `${aiProviderLabel}未就绪，请先检查系统设置…` : '输入板卡功能、接口、电源、尺寸、环境或制造要求…'} disabled={chat.status === 'sending' || !activeProject} maxLength={4000} aria-label="发送给Codex的PCBA需求" />{voice.listening && <div className="chat-voice-interim" aria-live="polite" aria-label="语音识别临时结果"><Mic size={13} /><span>{voice.interimText || '正在听…'}</span></div>}<div className="chat-composer__footer"><span>Enter 发送 · 最多4个附件 · {input.length}/4000{voice.message ? ` · ${voice.message}` : ''}</span><div className="chat-composer__actions"><input ref={attachmentRef} className="visually-hidden" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,text/*,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.log,.net,.netlist,.bom,.cpl,.kicad_sch,.kicad_pcb" onChange={(event) => void chooseAttachments(event.target.files)} aria-label="选择AI对话附件" /><Button icon={<Mic size={15} />} aria-label={voice.listening ? '停止语音输入' : '语音输入（中文）'} aria-pressed={voice.listening} className={voice.listening ? 'button--recording' : ''} onClick={voice.toggle} disabled={!activeProject || chat.status === 'sending'} title={voice.supported ? '语音输入（中文，识别结果会追加到已输入内容后面，可再手改）' : '当前浏览器不支持语音输入，可改用 Chrome/Edge 或直接手动输入'}>{voice.listening ? '停止语音' : '语音输入'}</Button><Button icon={<Paperclip size={15} />} onClick={() => attachmentRef.current?.click()} disabled={!activeProject || chat.status === 'sending' || attachments.length >= 4}>上传文件/图片</Button><Button variant="primary" icon={<Send size={15} />} loading={chat.status === 'sending'} onClick={() => send()} disabled={!activeProject || (!input.trim() && !attachments.length) || chat.status === 'sending' || codexReady === false} title={!activeProject ? '请先选择或创建项目' : (!input.trim() && !attachments.length) ? '请输入消息或添加附件' : chat.status === 'sending' ? '上一条消息仍在处理中' : codexReady === false ? `请先连接 ${aiProviderLabel}` : undefined}>发送</Button>{sendTask?.status === 'running' && <Button icon={<X size={15} />} onClick={() => sendTaskRef.current?.cancelTask()}>停止等待</Button>}</div></div></div></div>
        <LongTaskPanel title="需求对话长任务（D8：取消只停止本页等待，服务端可能仍在生成）" snapshot={sendTask} onCancel={sendTask?.status === 'running' ? () => sendTaskRef.current?.cancelTask() : undefined} onRetry={() => void send()} cancelLabel="停止等待回复" retryLabel="重新发送上一条" />
      </Panel>
      <div className="chat-context-rail"><Panel eyebrow="ACTIVE CONTEXT" title="本轮提供给AI的信息" meta="不包含API密钥或任意文件正文"><div className="context-list"><div><Cpu size={16} /><span><strong>{activeProject?.name || '未选择项目'}</strong><small>{activeProject?.code || '请先选择项目'} · {activeProject?.stage || '未知阶段'}</small></span></div><button type="button" onClick={() => navigate('requirements')}><ListChecks size={16} /><span><strong>{state.requirements.length} 项需求</strong><small>{missing.length}项需要继续澄清</small></span></button><button type="button" onClick={() => navigate('assets')}><FileText size={16} /><span><strong>{state.assets.length} 份资料</strong><small>仅名称、版本、状态与关联对象</small></span></button><div><Sparkles size={16} /><span><strong>{pendingSuggestions} 项待确认建议</strong><small>接受后才写入需求库</small></span></div></div></Panel>
        <Panel eyebrow="READ-ONLY EVIDENCE" title="嘉立创EDA边界" meta="每轮由Runtime固定读取"><div className={`eda-evidence eda-evidence--${evidence?.status || 'idle'}`}><ShieldCheck size={18} /><div><strong>{edaLabel}</strong><p>{evidence?.reason || '发送消息后将读取当前工程与当前文档；不开放任意命令。'}</p></div></div></Panel>
        <Panel eyebrow="SEMANTIC PLAN" title="AI 生产计划" meta={`${aiProviderLabel} · 结构化输出 · 禁止模型脚本`} actions={<Button size="sm" variant="primary" icon={<Sparkles size={14} />} onClick={generateProductionPlan} loading={productionPlanning} disabled={!codexReady || productionPlanning}>生成可验证计划</Button>}>
          {!productionCandidate ? <div className="empty-inline"><ShieldCheck size={24} /><strong>尚未生成PCBA语义计划</strong><span>Codex只会使用已确认需求、器件身份和实时EDA证据；缺失信息会明确阻断。</span></div> : <div className="detail-stack"><div className={`inline-alert ${productionCandidate.status === 'ready' ? 'inline-alert--success' : 'inline-alert--warning'}`}><ShieldCheck size={16} /><span><strong>{productionCandidate.status === 'ready' ? '计划候选已生成' : '计划被阻断'}</strong> · {productionCandidate.explanation}</span></div>{productionCandidate.planHash && <div className="detail-block"><span>语义计划哈希</span><code>{productionCandidate.planHash}</code></div>}{productionCandidate.blockingInformation.map((item) => <div className="risk-box" key={item.code}><strong>{item.code}</strong><p>{item.question}</p><small>{item.reason}</small></div>)}{productionCandidate.status === 'ready' && <Button onClick={handoffPlanToEda}>进入EDA编译（PCB 写入链）</Button>}</div>}
          <LongTaskPanel title="AI 生产计划生成（长任务）" snapshot={planSnapshot} onCancel={() => { planTaskRef.current?.cancelTask(); }} onRetry={() => void generateProductionPlan()} cancelLabel="停止等待生成" retryLabel="重新生成计划" />
        </Panel>
        {!codexReady && <div className="chat-setup-warning"><AlertTriangle size={17} /><div><strong>真实聊天尚未就绪</strong><p>请确认本机Runtime正在运行，并在系统设置中测试Codex账号。</p><Button size="sm" onClick={() => navigate('settings')}>打开系统设置</Button></div></div>}
      </div>
    </div>
    <ConfirmDialog open={Boolean(draftToApply)} onClose={() => setDraftToApply(null)} onConfirm={applyBomDraft} title="确认写入当前项目BOM？" description={draftCrossProject && draftOwner ? <>该草案属于项目 <strong>{draftOwner.name}</strong>，当前项目为 <strong>{activeProject?.name}</strong>。<strong>跨项目写入已被阻止</strong>：请先切换回 {draftOwner.name} 再确认，本次不会修改任何BOM。</> : <>将把 <strong>{draftToApply?.bomDraft?.items.length || 0} 行</strong> AI草案写入项目 <strong>{draftTargetProject?.name}</strong>。同位号条目会被本次草案替换；不会绑定嘉立创器件，也不会修改原理图或PCB。</>} confirmLabel="确认写入BOM" />
    <ConfirmDialog open={resetOpen} onClose={() => setResetOpen(false)} onConfirm={reset} title="为当前项目新建对话？" description={<>只会清除项目 <strong>{activeProject?.name}</strong> 的聊天记录并结束它的Runtime会话；其他项目的对话、已接受需求、资料和已确认BOM都会保留。</>} confirmLabel="新建对话" />
  </>;
}
