import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type Dispatch, type ReactNode } from 'react';
import { createSeedState } from '../data/seed';
import type { AppAction, AppState, AuditEvent, ChangeLogEntry, ChatState, IssueRecord, IssueStatus, PageId, ToastMessage, Tone } from '../types';
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
    case 'ADD_REQUIREMENT': return { ...state, requirements: [action.requirement, ...state.requirements] };
    case 'UPDATE_REQUIREMENT': return { ...state, requirements: state.requirements.map((item) => item.id === action.requirement.id ? action.requirement : item) };
    case 'ADD_ASSETS': return { ...state, assets: [...action.assets, ...state.assets] };
    case 'UPDATE_ASSET': return { ...state, assets: state.assets.map((item) => item.id === action.asset.id ? action.asset : item) };
    case 'REMOVE_ASSET': return { ...state, assets: state.assets.filter((item) => item.id !== action.id) };
    case 'UPDATE_COMPONENT': return { ...state, components: state.components.map((item) => item.id === action.component.id ? action.component : item) };
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
      return updateActiveChat({ ...state, components }, (chat) => ({ ...chat, messages: chat.messages.map((message) => message.id === action.messageId && message.bomDraft ? { ...message, bomDraft: { ...message.bomDraft, status: 'applied', appliedAt: action.appliedAt } } : message) }));
    }
    case 'SET_TASK': return { ...state, task: action.task };
    case 'PATCH_TASK': return { ...state, task: { ...state.task, ...action.patch } };
    case 'SET_TASK_STEP': return { ...state, task: { ...state.task, steps: state.task.steps.map((item) => item.id === action.step.id ? action.step : item) } };
    case 'ADD_CHAT_MESSAGE': return updateActiveChat(state, (chat) => ({ ...chat, messages: [...chat.messages, action.message] }));
    case 'UPDATE_CHAT_MESSAGE': return updateActiveChat(state, (chat) => ({ ...chat, messages: chat.messages.map((item) => item.id === action.id ? { ...item, ...action.patch } : item) }));
    case 'PATCH_CHAT': return updateActiveChat(state, (chat) => ({ ...chat, ...action.patch }));
    case 'DECIDE_CHAT_SUGGESTION': return updateActiveChat(state, (chat) => ({ ...chat, messages: chat.messages.map((message) => message.id === action.messageId ? { ...message, suggestions: message.suggestions?.map((suggestion) => suggestion.id === action.suggestionId ? { ...suggestion, status: action.status } : suggestion) } : message) }));
    case 'RESET_CHAT': return updateActiveChat(state, () => ({ sessionId: action.sessionId, messages: [], status: 'idle', lastError: null, lastEdaEvidence: null }));
    case 'SET_EDA': return { ...state, eda: action.eda };
    case 'PATCH_EDA': return { ...state, eda: { ...state.eda, ...action.patch } };
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
    case 'PATCH_RUNTIME': return { ...state, runtime: { ...state.runtime, ...action.patch } };
    case 'BOOTSTRAP_RUNTIME': {
      const canAutoSelect = !state.settings.onboardingComplete && state.settings.provider === 'demo' && action.preferredProvider?.ready;
      return { ...state, runtime: { ...state.runtime, ...action.patch }, settings: canAutoSelect ? { ...state.settings, provider: action.preferredProvider!.id, providerReady: true, model: state.settings.model || 'auto' } : state.settings };
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
  navigate: (page: PageId) => void;
  notify: (title: string, message: string, tone?: Tone) => void;
  addAudit: (type: AuditEvent['type'], title: string, detail: string, status?: AuditEvent['status']) => void;
  recordChange: (entry: Omit<ChangeLogEntry, 'id' | 'time'>) => void;
  reportIssue: (issue: Omit<IssueRecord, 'id' | 'firstOccurredAt' | 'lastOccurredAt' | 'occurrences' | 'handling'>) => void;
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

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      logger.error('Persistence', 'Failed to persist demo state', safeError(error));
    }
  }, [state]);

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

  const notify = useCallback((title: string, message: string, tone: Tone = 'info') => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    logger.info('Notification', title, { tone });
    setToasts((current) => [...current, { id, title, message, tone }].slice(-4));
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200);
  }, []);

  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((item) => item.id !== id)), []);

  const navigate = useCallback((page: PageId) => {
    logger.info('Navigation', `Navigating to ${page}`);
    dispatch({ type: 'NAVIGATE', page });
    window.location.hash = page;
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

  const updateIssue = useCallback((id: string, status: IssueStatus, note: string) => dispatch({ type: 'UPDATE_ISSUE', id, status, note }), []);

  const resetDemo = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PREVIOUS_STORAGE_KEY);
    localStorage.removeItem('circuitpilot-state-v2');
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    dispatch({ type: 'RESET_DEMO', state: createSeedState() });
    window.location.hash = 'projects';
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
