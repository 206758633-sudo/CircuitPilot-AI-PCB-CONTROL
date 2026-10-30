import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactNode } from 'react';
import { createSeedState } from '../data/seed';
import type { AiTask, AppAction, AppState, AuditEvent, ChangeLogEntry, ChatState, FailureDiagnosis, IssueRecord, IssueStatus, PageId, ToastMessage, Tone } from '../types';
import { invalidateTaskApproval } from './taskMachine';
import { logger, safeError } from '../utils/logger';
import { RuntimeApiError, runtimeClient } from '../services/runtimeClient';

export const STORAGE_KEY = 'circuitpilot-state-v4';
// 仅在本文件内用于旧版本状态迁移，不对外导出（此前多余的 export 会让人误以为它们是公共 API）。
const PREVIOUS_STORAGE_KEY = 'circuitpilot-state-v3';
const LEGACY_STORAGE_KEY = 'circuitpilot-demo-state-v1';

const createProjectChat = (projectId: string): ChatState => ({
  sessionId: `chat-${projectId}-${Date.now()}`,
  messages: [],
  status: 'idle',
  lastError: null,
  lastEdaEvidence: null,
});

function updateActiveChat(state: AppState, update: (chat: ChatState) => ChatState): AppState {
  if (!state.activeProjectId) return state;
  const current = state.projectChats[state.activeProjectId] || createProjectChat(state.activeProjectId);
  return { ...state, projectChats: { ...state.projectChats, [state.activeProjectId]: update(current) } };
}

/**
 * C4：需求/器件/资料一变化，绑定旧输入的批准就不再可信。
 * reducer 级自动标废（而不是靠页面记得调），并把触发原因写进 task.invalidation，
 * 让 UI 能明确告诉用户"旧批准失效了，需要重新生成/批准"，而不是继续显示已批准。
 */
const invalidateOnInputChange = (
  task: AiTask,
  trigger: 'requirement' | 'component' | 'asset' | 'project' | 'eda' | 'code',
  reason: string,
): AiTask => {
  if (!task || (task.status !== 'approved' && task.status !== 'planned')) return task;
  return invalidateTaskApproval(task, {}, Date.now(), { trigger, reason });
};

const shortFingerprint = (value: string | null | undefined) => value ? value.slice(0, 12) : '未读回';

/**
 * C4：EDA 目标指纹/Runtime 版本漂移时，批准时绑定的环境已不可信。
 * 这里只做"前端提前标 stale"（后端仍有指纹校验兜底，不会因前端漏判而放行写图）。
 */
const driftReason = (kind: 'eda' | 'code', bound: string | null, current: string | null) => kind === 'eda'
  ? `EDA 目标指纹已变化（批准时 ${shortFingerprint(bound)}，当前 ${shortFingerprint(current)}）：旧计划/批准作废，需重新读取证据并批准`
  : `Runtime 版本已变化（批准时 ${bound ?? '未知'}，当前 ${current ?? '未知'}）：旧计划/批准作废，需重新验证后批准`;

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'NAVIGATE': return { ...state, currentPage: action.page };
    case 'ADD_PROJECT': return { ...state, projects: [action.project, ...state.projects], activeProjectId: action.project.id, projectChats: { ...state.projectChats, [action.project.id]: createProjectChat(action.project.id) } };
    case 'UPDATE_PROJECT': return { ...state, projects: state.projects.map((item) => item.id === action.project.id ? action.project : item) };
    case 'SET_ACTIVE_PROJECT': return { ...state, activeProjectId: action.id };
    case 'ARCHIVE_PROJECT': return {
      ...state,
      projects: state.projects.map((item) => {
        if (item.id !== action.id) return item;
        // 归档时把真实工作流阶段寄存在 stageBeforeArchive，取消归档时原样恢复，避免每次都退回“概念”。
        if (action.archived) return { ...item, archived: true, stage: '归档', stageBeforeArchive: item.stage === '归档' ? item.stageBeforeArchive : item.stage };
        const { stageBeforeArchive, ...rest } = item;
        return { ...rest, archived: false, stage: stageBeforeArchive ?? '概念' };
      }),
    };
    case 'DELETE_PROJECT': {
      const projects = state.projects.filter((item) => item.id !== action.id);
      const projectChats = { ...state.projectChats };
      delete projectChats[action.id];
      const activeProjectId = state.activeProjectId === action.id
        ? (projects.find((item) => !item.archived)?.id || projects[0]?.id || '')
        : state.activeProjectId;
      return { ...state, projects, projectChats, activeProjectId };
    }
    case 'ADD_REQUIREMENT': return { ...state, requirements: [action.requirement, ...state.requirements], task: invalidateOnInputChange(state.task, 'requirement', '新增需求后，旧计划/批准已失效，需重新生成并批准') };
    case 'UPDATE_REQUIREMENT': return { ...state, requirements: state.requirements.map((item) => item.id === action.requirement.id ? action.requirement : item), task: invalidateOnInputChange(state.task, 'requirement', '需求内容变化后，旧计划/批准已失效，需重新生成并批准') };
    case 'ADD_ASSETS': return { ...state, assets: [...action.assets, ...state.assets], task: invalidateOnInputChange(state.task, 'asset', '设计资料变化后，旧计划/批准已失效，需重新生成并批准') };
    case 'UPDATE_ASSET': return { ...state, assets: state.assets.map((item) => item.id === action.asset.id ? action.asset : item), task: invalidateOnInputChange(state.task, 'asset', '设计资料变化后，旧计划/批准已失效，需重新生成并批准') };
    case 'REMOVE_ASSET': return { ...state, assets: state.assets.filter((item) => item.id !== action.id), task: invalidateOnInputChange(state.task, 'asset', '设计资料被移除后，旧计划/批准已失效，需重新生成并批准') };
    case 'UPDATE_COMPONENT': return { ...state, components: state.components.map((item) => item.id === action.component.id ? action.component : item), task: invalidateOnInputChange(state.task, 'component', '器件身份/参数变化后，旧计划/批准已失效，需重新生成并批准') };
    case 'APPLY_BOM_DRAFT': {
      // 纵深防御：即便调用方漏检，reducer 也拒绝把草案写入非当前项目。
      // 这里同时校验“草案所属项目”“草案所在会话所属项目”和“来料器件的projectId”，
      // 因为这三者中的任意一个错位都会把BOM写进错误项目。
      let messageProjectId: string | undefined;
      let draftProjectId: string | undefined;
      for (const [projectId, chat] of Object.entries(state.projectChats)) {
        const message = chat.messages.find((item) => item.id === action.messageId);
        if (!message) continue;
        messageProjectId = projectId;
        draftProjectId = message.bomDraft?.projectId;
        break;
      }
      const foreignMessage = messageProjectId !== undefined && messageProjectId !== state.activeProjectId;
      const foreignDraft = Boolean(draftProjectId && draftProjectId !== state.activeProjectId);
      const foreignComponent = action.components.some((item) => Boolean(item.projectId && item.projectId !== state.activeProjectId));
      if (foreignMessage || foreignDraft || foreignComponent) return state;
      const incomingRefs = new Set(action.components.map((item) => item.refdes.trim().toUpperCase()));
      const components = [
        ...state.components.filter((item) => item.projectId !== state.activeProjectId || !incomingRefs.has(item.refdes.trim().toUpperCase())),
        ...action.components,
      ];
      const applied = updateActiveChat({ ...state, components }, (chat) => ({ ...chat, messages: chat.messages.map((message) => message.id === action.messageId && message.bomDraft ? { ...message, bomDraft: { ...message.bomDraft, status: 'applied', appliedAt: action.appliedAt } } : message) }));
      // BOM 草案落地改变了器件清单 → 旧批准自动失效（与 C4 一致，不靠页面记得清）。
      return { ...applied, task: invalidateOnInputChange(applied.task, 'component', 'BOM 草案写入后器件清单变化，旧计划/批准已失效，需重新生成并批准') };
    }
    case 'SET_TASK': return { ...state, task: action.task };
    case 'PATCH_TASK': {
      // C4：任务变为已批准时，绑定当时的 EDA 目标指纹与 Runtime 版本；之后任一漂移都会自动标废。
      const boundEnv = action.patch.status === 'approved'
        ? { edaFingerprint: state.eda.targetFingerprint ?? null, runtimeVersion: state.runtime.serviceVersion ?? null, at: new Date().toISOString() }
        : undefined;
      return { ...state, task: { ...state.task, ...action.patch, ...(boundEnv ? { boundEnv } : {}) } };
    }
    case 'SET_TASK_STEP': return { ...state, task: { ...state.task, steps: state.task.steps.map((item) => item.id === action.step.id ? action.step : item) } };
    case 'ADD_CHAT_MESSAGE': return updateActiveChat(state, (chat) => ({ ...chat, messages: [...chat.messages, action.message] }));
    case 'UPDATE_CHAT_MESSAGE': return updateActiveChat(state, (chat) => ({ ...chat, messages: chat.messages.map((item) => item.id === action.id ? { ...item, ...action.patch } : item) }));
    case 'PATCH_CHAT': return updateActiveChat(state, (chat) => ({ ...chat, ...action.patch }));
    case 'DECIDE_CHAT_SUGGESTION': return updateActiveChat(state, (chat) => ({ ...chat, messages: chat.messages.map((message) => message.id === action.messageId ? { ...message, suggestions: message.suggestions?.map((suggestion) => suggestion.id === action.suggestionId ? { ...suggestion, status: action.status } : suggestion) } : message) }));
    case 'RESET_CHAT': return updateActiveChat(state, () => ({ sessionId: action.sessionId, messages: [], status: 'idle', lastError: null, lastEdaEvidence: null }));
    case 'SET_EDA': return { ...state, eda: action.eda };
    case 'PATCH_EDA': return { ...state, eda: { ...state.eda, ...action.patch } };
    case 'CHECK_ENV_DRIFT': {
      const task = state.task;
      if (!task || (task.status !== 'approved' && task.status !== 'planned') || !task.boundEnv) return state;
      const edaFingerprint = action.edaFingerprint ?? null;
      const runtimeVersion = action.runtimeVersion ?? null;
      if (task.boundEnv.edaFingerprint && edaFingerprint && task.boundEnv.edaFingerprint !== edaFingerprint) {
        return { ...state, task: invalidateOnInputChange(task, 'eda', driftReason('eda', task.boundEnv.edaFingerprint, edaFingerprint)) };
      }
      if (task.boundEnv.runtimeVersion && runtimeVersion && task.boundEnv.runtimeVersion !== runtimeVersion) {
        return { ...state, task: invalidateOnInputChange(task, 'code', driftReason('code', task.boundEnv.runtimeVersion, runtimeVersion)) };
      }
      return state;
    }
    case 'ADD_COMMAND_LOG': return { ...state, eda: { ...state.eda, commandLogs: [action.log, ...state.eda.commandLogs] } };
    case 'SET_VALIDATIONS': return { ...state, validations: action.validations };
    case 'UPDATE_VALIDATION': return { ...state, validations: state.validations.map((item) => item.id === action.validation.id ? action.validation : item) };
    case 'ADD_VERSION': return { ...state, versions: [action.version, ...state.versions] };
    case 'ADD_AUDIT': return { ...state, audit: [action.event, ...state.audit].slice(0, 200) };
    case 'ADD_CHANGE': return { ...state, changes: [action.entry, ...state.changes].slice(0, 500) };
    case 'REPORT_ISSUE': {
      const existing = state.issues.find((item) => item.fingerprint === action.issue.fingerprint && (item.status === 'open' || item.status === 'investigating'));
      if (!existing) return { ...state, issues: [action.issue, ...state.issues].slice(0, 300) };
      return { ...state, issues: state.issues.map((item) => item.id === existing.id ? { ...item, severity: action.issue.severity, summary: action.issue.summary, detail: action.issue.detail, lastOccurredAt: action.issue.lastOccurredAt, occurrences: item.occurrences + 1, context: { ...item.context, ...action.issue.context } } : item) };
    }
    case 'UPDATE_ISSUE': return { ...state, issues: state.issues.map((item) => item.id === action.id ? { ...item, status: action.status, handling: [{ id: `handling-${Date.now()}`, time: new Date().toLocaleString('zh-CN', { hour12: false }), action: item.status === 'resolved' && action.status === 'open' ? 'reopened' : action.status, note: action.note, actor: '本机用户' }, ...item.handling] } : item) };
    // settings.writePaused（全局门禁）与 eda.writePaused（会话门禁）互相独立：
    // 保存设置不能顺带把会话开关重置掉，否则“全局暂停”关掉时会静默解除会话暂停。
    case 'SET_SETTINGS': return { ...state, settings: action.settings };
    // P0-8：Runtime 写暂停状态的 UI 镜像（只改这一个字段，不覆盖其它设置）。
    case 'SET_WRITE_PAUSED': return { ...state, settings: { ...state.settings, writePaused: action.paused } };
    // P0-5：Runtime 写门禁镜像（全局 + 会话）。两个来源互相独立，但都必须来自 Runtime 返回，
    // 不能因为"本地开关关了"就认为写可以放开——真实拦截仍在服务端。
    case 'SET_WRITE_GATE': return { ...state, settings: { ...state.settings, writePaused: action.paused, sessionPaused: action.sessionPaused } };
    case 'PATCH_RUNTIME': return { ...state, runtime: { ...state.runtime, ...action.patch } };
    case 'BOOTSTRAP_RUNTIME': {
      const canAutoSelect = !state.settings.onboardingComplete && state.settings.provider === 'demo' && action.preferredProvider?.ready;
      return { ...state, runtime: { ...state.runtime, ...action.patch }, settings: canAutoSelect ? { ...state.settings, provider: action.preferredProvider!.id, providerReady: true, model: state.settings.model || 'auto' } : state.settings };
    }
    case 'HYDRATE_BUSINESS_STATE': {
      // 服务端有权威业务状态时以服务端为准（换机器/清缓存后恢复）；空状态不覆盖本地种子，
      // 否则首次启动会把用户本地正在编辑的项目清空。
      const projects = action.state.projects;
      if (!projects.length) return state;
      const activeProjectId = projects.some((item) => item.id === action.state.activeProjectId)
        ? action.state.activeProjectId
        : projects[0]?.id || state.activeProjectId;
      return { ...state, projects, requirements: action.state.requirements, components: action.state.components, assets: action.state.assets, activeProjectId };
    }
    case 'HYDRATE_ISSUES': {
      // 服务端有权威副本时才覆盖本地；服务端为空而本地有内容时保持本地，交给写回效应推上去。
      if (!action.issues.length) return state;
      return { ...state, issues: action.issues };
    }
    case 'HYDRATE_TRACE_STATE': {
      // 服务端有权威副本时才覆盖本地；服务端为空而本地有内容时保持本地，交给写回效应推上去。
      const hasServerTrace = action.versions.length > 0 || action.changes.length > 0 || action.audit.length > 0;
      if (!hasServerTrace) return state;
      return { ...state, versions: action.versions, changes: action.changes, audit: action.audit };
    }
    /**
     * P0-1（复审 2026-10-29）：验证结果的 Runtime 权威副本。
     * 服务端为空（首次启动/从未保存）时保留本地（种子/Demo 行仍可走查），由写回效应推上去；
     * 服务端有内容时以服务端为准——这正是"清缓存后官方 ERC/DRC 证据仍在"的实现点。
     */
    case 'HYDRATE_VALIDATIONS': {
      if (!action.validations.length) return state;
      return { ...state, validations: action.validations };
    }
    case 'RESET_DEMO': return action.state;
    default: return state;
  }
}

export function loadStoredState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(PREVIOUS_STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return createSeedState();
    const parsed = JSON.parse(raw) as Omit<Partial<AppState>, 'schemaVersion'> & { schemaVersion?: number; settings?: Record<string, unknown>; chat?: ChatState };
    if (!Array.isArray(parsed.projects) || !parsed.settings) throw new Error('Invalid state schema');
    if (parsed.schemaVersion === 4 && parsed.runtime && parsed.projectChats) {
      const seed = createSeedState();
      const projects = parsed.projects;
      const activeProjectId = parsed.activeProjectId && projects.some((item) => item.id === parsed.activeProjectId) ? parsed.activeProjectId : projects[0]?.id || '';
      const projectChats = Object.fromEntries(projects.map((project) => [project.id, { ...createProjectChat(project.id), ...(parsed.projectChats?.[project.id] || {}) }]));
      const components = (parsed.components || []).map((item) => ({ ...item, projectId: item.projectId || activeProjectId }));
      return { ...seed, ...parsed, projects, activeProjectId, components, projectChats, settings: { ...seed.settings, ...(parsed.settings as Partial<AppState['settings']>) }, eda: { ...seed.eda, ...(parsed.eda || {}) }, runtime: { ...seed.runtime, ...parsed.runtime }, changes: parsed.changes || [], issues: parsed.issues || [] } as AppState;
    }
    if (parsed.schemaVersion === 3 && parsed.runtime && parsed.chat) {
      const seed = createSeedState();
      const projects = parsed.projects;
      const activeProjectId = parsed.activeProjectId && projects.some((item) => item.id === parsed.activeProjectId) ? parsed.activeProjectId : projects[0]?.id || '';
      const projectChats = Object.fromEntries(projects.map((project) => [project.id, project.id === activeProjectId ? { ...parsed.chat! } : createProjectChat(project.id)]));
      return { ...seed, ...parsed, schemaVersion: 4, projects, activeProjectId, projectChats, settings: { ...seed.settings, ...(parsed.settings as Partial<AppState['settings']>) }, eda: { ...seed.eda, ...(parsed.eda || {}) }, runtime: { ...seed.runtime, ...parsed.runtime }, changes: parsed.changes || [], issues: parsed.issues || [] } as AppState;
    }
    const seed = createSeedState();
    const legacyProvider = String(parsed.settings.provider || '');
    return {
      ...seed,
      ...(parsed as Omit<AppState, 'schemaVersion' | 'settings' | 'runtime' | 'eda'>),
      schemaVersion: 4,
      settings: {
        ...seed.settings,
        ...(parsed.settings as Partial<AppState['settings']>),
        provider: legacyProvider.includes('OpenAI') ? 'openai_api' : 'demo',
        providerReady: legacyProvider.includes('模拟'),
      },
      eda: { ...seed.eda, ...(parsed.eda || {}) },
      runtime: seed.runtime,
      projectChats: seed.projectChats,
      changes: [],
      issues: seed.issues,
    };
  } catch (error) {
    logger.warn('Persistence', 'Stored state invalid; loading seed data', safeError(error));
    return createSeedState();
  }
}

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  activeProject: AppState['projects'][number] | undefined;
  requirementCompleteness: number;
  openRiskCount: number;
  /** D6：navigate 可带页签（如 design/req），统一走 hash 路由，避免各页面自己改 location.hash。 */
  navigate: (page: PageId, tab?: string) => void;
  notify: (title: string, message: string, tone?: Tone) => void;
  addAudit: (type: AuditEvent['type'], title: string, detail: string, status?: AuditEvent['status']) => void;
  recordChange: (entry: Omit<ChangeLogEntry, 'id' | 'time'>) => void;
  reportIssue: (issue: Omit<IssueRecord, 'id' | 'firstOccurredAt' | 'lastOccurredAt' | 'occurrences' | 'handling'>) => void;
  /** 统一失败入口（D4）：优先调用 Runtime 诊断拿证据/修复入口；Runtime 不可达时退回本地记录。 */
  reportFailure: (failure: { source?: IssueRecord['source']; error?: { code?: string; message?: string; details?: unknown }; context?: Record<string, unknown> }) => Promise<FailureDiagnosis | null>;
  updateIssue: (id: string, status: IssueStatus, note: string) => void;
  openIssueCount: number;
  toasts: ToastMessage[];
  dismissToast: (id: string) => void;
  resetDemo: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, undefined, loadStoredState);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  // C6：项目级切面（runtime 每个项目一个状态文件）。scopedProjectRef 记录"当前内存工作集来自哪个项目的切面"；
  // 没建立切面指纹时不写项目文件，避免把上一个项目的内存数据写进新项目。
  const scopedProjectRef = useRef<string | null>(null);
  const initialHydratedRef = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      logger.error('Persistence', 'Failed to persist demo state', safeError(error));
    }
  }, [state]);

  // C1：项目/需求/器件/资料的服务端权威副本。
  // 启动时若 Runtime 上已有业务状态，以它为准恢复（localStorage 只作离线缓存）；
  // 之后业务状态变化防抖写回 Runtime（Runtime 不可达时保持纯本地，不阻塞编辑）。
  // C6：先取聚合状态拿到项目列表，再按当前项目取**项目级切面**（每项目一个文件，互不串数据）；
  // 切面不存在（老版本数据）时由 Runtime 从聚合状态迁移出只读切片，首次写入才落项目文件。
  useEffect(() => {
    if (!state.runtime.reachable) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await runtimeClient.getProjectState();
        if (cancelled) return;
        if (loaded.state.projects.length) {
          dispatch({
            type: 'HYDRATE_BUSINESS_STATE',
            state: {
              projects: loaded.state.projects,
              activeProjectId: loaded.state.activeProjectId || '',
              requirements: loaded.state.requirements,
              components: loaded.state.components,
              assets: loaded.state.assets,
            },
          });
        }
        const projectId = loaded.state.activeProjectId || loaded.state.projects[0]?.id || '';
        if (projectId) {
          try {
            const scoped = await runtimeClient.getProjectStateScoped(projectId);
            if (cancelled) return;
            scopedProjectRef.current = projectId;
            dispatch({
              type: 'HYDRATE_BUSINESS_STATE',
              state: {
                projects: loaded.state.projects,
                activeProjectId: projectId,
                requirements: scoped.state.requirements ?? [],
                components: scoped.state.components ?? [],
                assets: scoped.state.assets ?? [],
              },
            });
          } catch (error) {
            if (cancelled) return;
            scopedProjectRef.current = null;
            logger.warn('Persistence', '项目级状态切面读取失败，暂用聚合状态（不会跨项目写项目文件）', safeError(error));
          }
        }
      } catch (error) {
        logger.warn('Persistence', 'Runtime 项目状态读取失败，继续使用本地缓存', safeError(error));
      } finally {
        if (!cancelled) initialHydratedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  // 只在 Runtime 首次可达时做一次恢复；之后以本地编辑为准写回。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runtime.reachable]);

  // P0-8：写暂停权威在 Runtime。启动/窗口重新聚焦时同步一次到 UI 镜像，
  // 让"顶部徽标 / 写入门禁"显示的是 Runtime 真实状态，而不是可能过期的 localStorage。
  // P0-5：同时镜像会话级暂停（scope='session'），两种暂停在 UI 上必须可区分。
  useEffect(() => {
    if (!state.runtime.reachable) return undefined;
    let cancelled = false;
    const sync = () => {
      void runtimeClient.writeGate().then(({ gate }) => {
        if (cancelled) return;
        dispatch({ type: 'SET_WRITE_GATE', paused: gate.paused === true, sessionPaused: gate.sessionPaused === true });
      }).catch(() => undefined);
    };
    sync();
    window.addEventListener('focus', sync);
    return () => { cancelled = true; window.removeEventListener('focus', sync); };
  // 只在 Runtime 可达性变化时重建监听；聚焦回调读取的是 Runtime 最新值。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runtime.reachable]);

  /**
   * P0-1（复审 2026-10-29）：验证结果的 Runtime 权威副本。
   * 启动时读回，变化后防抖写回；写回失败不假装成功（记问题中心，UI 仍保留本地缓存）。
   * hydration 完成前不写回，避免用种子/旧 localStorage 覆盖服务端已有的官方 ERC/DRC 证据。
   */
  const validationReadyRef = useRef(false);
  useEffect(() => {
    if (!state.runtime.reachable) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await runtimeClient.getValidationState();
        if (cancelled) return;
        dispatch({ type: 'HYDRATE_VALIDATIONS', validations: loaded.state.validations });
      } catch (error) {
        logger.warn('Persistence', 'Runtime 验证状态读取失败，继续使用本地缓存', safeError(error));
      } finally {
        if (!cancelled) validationReadyRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runtime.reachable]);

  useEffect(() => {
    if (!state.runtime.reachable || !validationReadyRef.current) return undefined;
    const timer = window.setTimeout(() => {
      void runtimeClient.saveValidationState(state.validations)
        .catch((error) => {
          const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : safeError(error).message;
          logger.error('Persistence', 'Runtime 验证结果写回失败（本地缓存仍然保留）', safeError(error));
          dispatch({
            type: 'REPORT_ISSUE',
            issue: {
              id: `issue-validation-state-${Date.now()}`,
              fingerprint: 'persistence:validation-state',
              source: 'runtime',
              severity: 'warning',
              status: 'open',
              code: error instanceof RuntimeApiError ? error.code : 'VALIDATION_STATE_SAVE_FAILED',
              summary: '验证结果未能写入 Runtime 权威副本',
              detail: `${detail}；本页仍显示本地缓存，但刷新/换机后官方验证证据可能丢失。`,
              firstOccurredAt: new Date().toLocaleString('zh-CN', { hour12: false }),
              lastOccurredAt: new Date().toLocaleString('zh-CN', { hour12: false }),
              occurrences: 1,
              context: { count: String(state.validations.length) },
              suggestedAction: '确认本机 Runtime（4178）可用后重试；必要时在验证页重跑官方 ERC/DRC 重新取证。',
              handling: [],
            },
          });
        });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [state.runtime.reachable, state.validations]);

  // C6：切换项目时加载该项目自己的切面（两项目并行不串数据）。
  // 切换前先把上一个项目当前内存里的最后编辑落盘（800ms 防抖可能还没触发）。
  useEffect(() => {
    if (!state.runtime.reachable || !initialHydratedRef.current) return undefined;
    const projectId = state.activeProjectId;
    if (!projectId || scopedProjectRef.current === projectId) return undefined;
    const previousProjectId = scopedProjectRef.current;
    let cancelled = false;
    if (previousProjectId && previousProjectId !== projectId) {
      void runtimeClient.saveProjectState({
        projects: state.projects,
        activeProjectId: previousProjectId,
        requirements: state.requirements,
        components: state.components,
        assets: state.assets,
      }).catch((error) => logger.warn('Persistence', '切换项目前写回聚合状态失败', safeError(error)));
      // 切面写入被服务端拒绝（例如实体跨项目）时保持安静：拒绝本身就是隔离生效的证据，不能绕过。
      void runtimeClient.saveProjectStateScoped(previousProjectId, {
        projects: state.projects.filter((item) => item.id === previousProjectId),
        activeProjectId: previousProjectId,
        requirements: state.requirements,
        components: state.components,
        assets: state.assets,
      }).catch(() => undefined);
    }
    scopedProjectRef.current = null;
    void (async () => {
      try {
        const scoped = await runtimeClient.getProjectStateScoped(projectId);
        if (cancelled) return;
        scopedProjectRef.current = projectId;
        dispatch({
          type: 'HYDRATE_BUSINESS_STATE',
          state: {
            projects: state.projects,
            activeProjectId: projectId,
            requirements: scoped.state.requirements ?? [],
            components: scoped.state.components ?? [],
            assets: scoped.state.assets ?? [],
          },
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof RuntimeApiError && error.code === 'PROJECT_STATE_NOT_FOUND') {
          // 新项目还没有项目文件：工作集清空，首次编辑保存时建立该项目文件；
          // 旧项目数据在切换前已写回聚合/旧项目切面，不会丢也不会串。
          scopedProjectRef.current = projectId;
          dispatch({
            type: 'HYDRATE_BUSINESS_STATE',
            state: { projects: state.projects, activeProjectId: projectId, requirements: [], components: [], assets: [] },
          });
          return;
        }
        logger.warn('Persistence', '项目级状态切面读取失败，保留当前工作集', safeError(error));
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runtime.reachable, state.activeProjectId]);

  useEffect(() => {
    if (!state.runtime.reachable) return undefined;
    const projectId = state.activeProjectId;
    const timer = window.setTimeout(() => {
      void runtimeClient.saveProjectState({
        projects: state.projects,
        activeProjectId: state.activeProjectId,
        requirements: state.requirements,
        components: state.components,
        assets: state.assets,
      }).catch((error) => logger.warn('Persistence', 'Runtime 项目状态写回失败（本地缓存仍然保留）', safeError(error)));
      // C6：只有"当前内存工作集确实来自该项目切面"时才写项目文件；否则宁可等切面加载完再写。
      if (projectId && scopedProjectRef.current === projectId) {
        void runtimeClient.saveProjectStateScoped(projectId, {
          projects: state.projects.filter((item) => item.id === projectId),
          activeProjectId: projectId,
          requirements: state.requirements,
          components: state.components,
          assets: state.assets,
        }).catch((error) => logger.warn('Persistence', '项目级状态写回失败（聚合缓存仍保留）', safeError(error)));
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [state.runtime.reachable, state.projects, state.requirements, state.components, state.assets, state.activeProjectId]);

  // C1（扩展）：版本/修改/审计的 Runtime 权威副本。读回时以服务端为准（本地 localStorage 只是缓存）；
  // 变化后防抖写回。Runtime 不可达时纯本地，不阻塞操作。
  useEffect(() => {
    if (!state.runtime.reachable) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await runtimeClient.getTraceState();
        if (cancelled) return;
        dispatch({ type: 'HYDRATE_TRACE_STATE', versions: loaded.state.versions, changes: loaded.state.changes, audit: loaded.state.audit });
      } catch (error) {
        logger.warn('Persistence', 'Runtime 追溯状态读取失败，继续使用本地缓存', safeError(error));
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runtime.reachable]);

  useEffect(() => {
    if (!state.runtime.reachable) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await runtimeClient.getIssueState();
        if (cancelled) return;
        dispatch({ type: 'HYDRATE_ISSUES', issues: loaded.state.issues });
      } catch (error) {
        logger.warn('Persistence', 'Runtime 问题记录读取失败，继续使用本地缓存', safeError(error));
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runtime.reachable]);

  useEffect(() => {
    if (!state.runtime.reachable) return undefined;
    const timer = window.setTimeout(() => {
      void runtimeClient.saveIssueState({ issues: state.issues })
        .catch((error) => logger.warn('Persistence', 'Runtime 问题记录写回失败（本地缓存仍然保留）', safeError(error)));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [state.runtime.reachable, state.issues]);

  useEffect(() => {
    if (!state.runtime.reachable) return undefined;
    const timer = window.setTimeout(() => {
      void runtimeClient.saveTraceState({ versions: state.versions, changes: state.changes, audit: state.audit })
        .catch((error) => logger.warn('Persistence', 'Runtime 追溯状态写回失败（本地缓存仍然保留）', safeError(error)));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [state.runtime.reachable, state.versions, state.changes, state.audit]);

  useEffect(() => {
    let cancelled = false;
    const probeRuntime = async () => {
      try {
        const health = await runtimeClient.health();
        const [providers, diagnostics] = await Promise.all([runtimeClient.providers(), runtimeClient.diagnostics()]);
        if (cancelled) return;
        const preferred = providers.find((item) => item.ready);
        dispatch({ type: 'BOOTSTRAP_RUNTIME', patch: { reachable: true, serviceVersion: health.version, providers, diagnostics, checkedAt: new Date().toISOString(), mode: preferred ? 'real_read_only' : 'demo', lastError: null }, preferredProvider: preferred });
      } catch (error) {
        if (cancelled) return;
        const runtimeError = error instanceof RuntimeApiError ? error : new RuntimeApiError('RUNTIME_UNREACHABLE', safeError(error).message);
        dispatch({ type: 'PATCH_RUNTIME', patch: { reachable: false, mode: 'demo', checkedAt: new Date().toISOString(), lastError: { code: runtimeError.code, message: runtimeError.message } } });
        const time = new Date().toLocaleString('zh-CN', { hour12: false });
        dispatch({ type: 'REPORT_ISSUE', issue: { id: `issue-runtime-${Date.now()}`, fingerprint: `runtime:${runtimeError.code}:startup`, source: 'runtime', severity: 'warning', status: 'open', code: runtimeError.code, summary: '启动时未连接本机Runtime', detail: runtimeError.message, firstOccurredAt: time, lastOccurredAt: time, occurrences: 1, suggestedAction: '运行 npm run dev:full 后在系统设置刷新状态。', handling: [] } });
      }
    };
    void probeRuntime();
    return () => { cancelled = true; };
  // Startup probe intentionally runs once; page actions perform explicit refreshes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // C4：环境漂移监听——EDA 目标或 Runtime 版本一旦变化，已批准/已计划任务立即标废并说明原因。
  useEffect(() => {
    dispatch({ type: 'CHECK_ENV_DRIFT', edaFingerprint: state.eda.targetFingerprint, runtimeVersion: state.runtime.serviceVersion });
  }, [state.eda.targetFingerprint, state.runtime.serviceVersion]);

  const notify = useCallback((title: string, message: string, tone: Tone = 'info') => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    logger.info('Notification', title, { tone });
    setToasts((current) => [...current, { id, title, message, tone }].slice(-4));
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200);
  }, []);

  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((item) => item.id !== id)), []);

  const navigate = useCallback((page: PageId, tab?: string) => {
    logger.info('Navigation', `Navigating to ${page}${tab ? `/${tab}` : ''}`);
    dispatch({ type: 'NAVIGATE', page });
    window.location.hash = tab ? `${page}/${tab}` : page;
  }, []);

  const addAudit = useCallback((type: AuditEvent['type'], title: string, detail: string, status: AuditEvent['status'] = 'info') => {
    dispatch({
      type: 'ADD_AUDIT',
      event: {
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        type,
        title,
        detail,
        status,
      },
    });
  }, []);

  const recordChange = useCallback((entry: Omit<ChangeLogEntry, 'id' | 'time'>) => {
    dispatch({ type: 'ADD_CHANGE', entry: { ...entry, id: `change-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, time: new Date().toLocaleString('zh-CN', { hour12: false }) } });
  }, []);

  const reportIssue = useCallback((issue: Omit<IssueRecord, 'id' | 'firstOccurredAt' | 'lastOccurredAt' | 'occurrences' | 'handling'>) => {
    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    dispatch({ type: 'REPORT_ISSUE', issue: { ...issue, id: `issue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, firstOccurredAt: time, lastOccurredAt: time, occurrences: 1, handling: [] } });
  }, []);

  const reportFailure = useCallback(async (failure: { source?: IssueRecord['source']; error?: { code?: string; message?: string; details?: unknown }; context?: Record<string, unknown> }) => {
    let diagnosis: FailureDiagnosis | null = null;
    try {
      diagnosis = (await runtimeClient.diagnoseFailure(failure)).diagnosis;
    } catch (error) {
      // 诊断服务本身不可达 = 也是一次失败；不能因此丢掉问题记录，退回本地结构化记录。
      logger.warn('Diagnostics', '统一失败诊断不可达，退回本地问题记录', safeError(error));
    }
    const code = diagnosis?.code || failure.error?.code || 'UI_FAILURE_UNREPORTED';
    const detail = diagnosis?.detail || failure.error?.message || '失败但未提供错误信息';
    reportIssue(diagnosis ? {
      fingerprint: diagnosis.fingerprint,
      source: diagnosis.source,
      severity: diagnosis.severity,
      status: 'open',
      code,
      summary: diagnosis.summary,
      detail,
      context: { ...diagnosis.context, ...(diagnosis.repair ? { repairPage: diagnosis.repair.page, repairLabel: diagnosis.repair.label } : {}) },
      suggestedAction: diagnosis.suggestedAction,
    } : {
      fingerprint: `ui:${failure.source || 'runtime'}:${code}`,
      source: failure.source || 'runtime',
      severity: 'error',
      status: 'open',
      code,
      summary: `未上报失败（${code}）`,
      detail,
      context: Object.fromEntries(Object.entries(failure.context || {}).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => [key, String(value).slice(0, 200)])),
      suggestedAction: 'Runtime 不可达，无法生成统一诊断；保留现场（错误码/证据路径）后重启 Runtime 重试。',
    });
    return diagnosis;
  }, [reportIssue]);

  const updateIssue = useCallback((id: string, status: IssueStatus, note: string) => dispatch({ type: 'UPDATE_ISSUE', id, status, note }), []);

  const resetDemo = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PREVIOUS_STORAGE_KEY);
    localStorage.removeItem('circuitpilot-state-v2');
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    dispatch({ type: 'RESET_DEMO', state: createSeedState() });
    window.location.hash = 'overview';
    logger.warn('Persistence', 'Demo state reset by user');
  }, []);

  const value = useMemo<AppContextValue>(() => {
    const confirmed = state.requirements.filter((item) => item.status === 'confirmed').length;
    return {
      state,
      dispatch,
      activeProject: state.projects.find((item) => item.id === state.activeProjectId),
      requirementCompleteness: Math.round((confirmed / Math.max(state.requirements.length, 1)) * 100),
      openRiskCount: state.requirements.filter((item) => item.status === 'conflict' || item.status === 'missing').length + state.components.filter((item) => item.status === 'risk' || item.status === 'pending').length,
      navigate,
      notify,
      addAudit,
      recordChange,
      reportIssue,
      reportFailure,
      updateIssue,
      openIssueCount: state.issues.filter((item) => item.status === 'open' || item.status === 'investigating').length,
      toasts,
      dismissToast,
      resetDemo,
    };
  }, [state, navigate, notify, addAudit, recordChange, reportIssue, updateIssue, toasts, dismissToast, resetDemo]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}
