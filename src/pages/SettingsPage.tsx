import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Bot, CheckCircle2, Database, Download, ExternalLink, KeyRound, Plus, RefreshCw, Save, Shield, TestTube2, Trash2, TriangleAlert } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { demoAdapter } from '../services/demoAdapter';
import { RuntimeApiError, runtimeClient } from '../services/runtimeClient';
import type { ProviderId, SettingsState } from '../types';
import { Badge, Button, Field, Panel, SegmentedTabs, SelectField, Stat, Toggle } from '../components/ui';
import { ConfirmDialog } from '../components/overlays';
import { CustomProviderEditor } from '../components/CustomProviderEditor';
import { AgentAccessPanel } from '../components/AgentAccessPanel';
import { PROVIDER_CATALOG, customModelOptions, groupedProviderOptions, isAccountProvider, isApiProvider, modelOptions, providerEntry, providerLabel } from '../data/providerCatalog';

/** 「02 · AI PROVIDER」的两个页签；默认留在平台 Provider，保持既有交互与 e2e 行为。 */
type ProviderTab = 'platform' | 'custom';

/**
 * Provider 下拉里的「新增自定义 Provider」伪选项值：用户不必先找到页签，
 * 在下拉里就能看到入口；选中它只切页签，绝不写入 settings.provider。
 */
const MANAGE_CUSTOM_PROVIDER_VALUE = '__manage_custom_provider__';

export function SettingsPage() {
  const { state, dispatch, notify, addAudit, recordChange, reportIssue, resetDemo } = useApp();
  const [draft, setDraft] = useState<SettingsState>(state.settings);
  const [apiKey, setApiKey] = useState('');
  const [providerTab, setProviderTab] = useState<ProviderTab>('platform');
  // 页签条件渲染会卸载编辑器；记住上次编辑的自定义 Provider，切回来时恢复选中项。
  const [customEditId, setCustomEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // G4：数据外发清单 + 脱敏预览（只告知/预览，不改变发送行为）。
  const [egress, setEgress] = useState<Awaited<ReturnType<typeof runtimeClient.providerEgress>>['egress'] | null>(null);
  const [egressBusy, setEgressBusy] = useState(false);
  const [egressPreview, setEgressPreview] = useState<Awaited<ReturnType<typeof runtimeClient.previewProviderEgress>> | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  // S1 联网检索：默认关闭；这里只负责“用户显式开启 + 连通性测试”，真正的请求仍由 allowResearch 放行。
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchResult, setResearchResult] = useState<string | null>(null);
  /**
   * P1-15（复审 2026-10-29）：联网开关是 Runtime 权威配置，不再只写 localStorage draft。
   * 单独成 state：避免"一改开关就 dirty"（它不经保存按钮，而是点一下即由 Runtime 落盘）。
   * researchSource 标明显示值来源：runtime=Runtime 已确认；local=Runtime 不可达/失败（未确认）。
   */
  const [researchEnabled, setResearchEnabled] = useState<boolean>(Boolean(state.settings.researchEnabled));
  const [researchSource, setResearchSource] = useState<'unknown' | 'runtime' | 'local'>('unknown');
  const [researchError, setResearchError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const loginGeneration = useRef(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);
  const providerStatus = state.runtime.providers.find((item) => item.id === draft.provider);
  // 注册表自定义 Provider（editable）与内置「自定义 API」快捷槽（custom 但没有 editable）是两种东西：
  // 前者由「自定义模型 API」页签维护协议/地址/模型目录，后者仍在平台页签里手填 URL 与 Key。
  const editableProvider = providerStatus?.editable === true;
  const customApi = !editableProvider && (draft.provider === 'custom_api' || Boolean(providerStatus?.custom));
  const customBaseUrl = (editableProvider ? providerStatus?.baseUrl || '' : draft.baseUrl || '').trim();
  const editableProviders = state.runtime.providers.filter((item) => item.editable === true);
  // 自定义 API 的就绪 = 钥匙串有 Key + 用户填了合法可用的 URL 才有意义；注册表 Provider 的地址由 Runtime 解析。
  const selectedReady = draft.provider === 'demo' || (Boolean(providerStatus?.ready) && (editableProvider || !customApi || Boolean(customBaseUrl)));
  // 显示名以 Runtime 上报为准（可能比前端目录新），目录名作为离线兜底。
  const displayLabel = providerStatus?.label || providerLabel(draft.provider);
  const providerInfo = providerEntry(draft.provider);
  const providerGroups = groupedProviderOptions(state.runtime.providers);
  // 类型优先信 Runtime 上报（可能比前端目录新），目录只作为离线兜底。
  const providerKind = providerStatus?.kind ?? providerInfo?.kind;
  const apiProvider = providerKind ? providerKind === 'api' : isApiProvider(draft.provider);
  const accountProvider = providerKind ? providerKind === 'cli' : isAccountProvider(draft.provider);
  const registryModelLabels = new Map((providerStatus?.models || []).map((model) => [model.id, model.label || model.id]));
  const availableModels = editableProvider
    ? customModelOptions(providerStatus, draft.model)
    : customApi
      ? ['deepseek-chat', 'deepseek-reasoner', ...(draft.model && draft.model !== 'auto' && !['deepseek-chat', 'deepseek-reasoner'].includes(draft.model) ? [draft.model] : [])]
      : modelOptions(draft.provider, draft.model);
  const consoleUrl = providerStatus?.keyUrl || providerInfo?.keyUrl;
  const realPathCount = PROVIDER_CATALOG.filter((entry) => entry.kind !== 'demo').length;
  useEffect(() => { setDraft(state.settings); return () => { loginGeneration.current += 1; }; }, [state.settings]);

  // P1-15：启动时向 Runtime 读联网开关；读不到就把面板标成"本地缓存未确认"，不冒充已生效。
  useEffect(() => {
    if (!state.runtime.reachable) { setResearchSource((current) => (current === 'runtime' ? current : 'local')); return; }
    let cancelled = false;
    void (async () => {
      try {
        const { config } = await runtimeClient.researchConfig();
        if (cancelled) return;
        setResearchEnabled(config.enabled === true);
        setResearchSource('runtime');
        setResearchError(config.loadError ? `Runtime 配置读取告警：${config.loadError}` : null);
      } catch (error) {
        if (cancelled) return;
        const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
        setResearchSource('local');
        setResearchError(detail);
      }
    })();
    return () => { cancelled = true; };
  // 只在 Runtime 可达性变化时读一次；之后以用户保存结果为准。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runtime.reachable]);

  /**
   * P1-15：保存联网开关 —— 先乐观显示，再以 Runtime 返回为准；失败回滚并报错（不假装成功）。
   * 修复前 Toggle 只改本地 draft：刷新后仍显示"已允许"，而 Runtime/脚本侧可能仍是关闭的。
   */
  const saveResearchEnabled = async (next: boolean) => {
    if (!state.runtime.reachable) return notify('联网检索开关需 Runtime 确认', '本机 Runtime 不可达：该配置由 Runtime 权威保存，离线时不能只改本地。', 'danger');
    const previous = researchEnabled;
    setResearchEnabled(next);
    setResearchResult(null);
    setResearchError(null);
    try {
      const { config } = await runtimeClient.setResearchConfig({ enabled: next, actor: '设置页联网检索开关' });
      const enabled = config.enabled === true;
      setResearchEnabled(enabled);
      setResearchSource('runtime');
      addAudit('settings', enabled ? '开启联网检索' : '关闭联网检索', `Runtime 已确认 · v${config.version ?? '—'}`, enabled ? 'warning' : 'info');
      notify(enabled ? '联网检索已开启' : '联网检索已关闭', 'Runtime 已保存该配置；每次检索仍由客户端显式 allowResearch 放行。', 'success');
    } catch (error) {
      const detail = error instanceof RuntimeApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : '未知错误';
      setResearchEnabled(previous);
      setResearchSource('local');
      setResearchError(detail);
      addAudit('settings', '联网检索开关保存失败', detail, 'error');
      notify('联网检索开关未保存', `${detail}；已回滚为原值，不会把本地改动当成 Runtime 配置。`, 'danger');
    }
  };
  const explain = (error: unknown) => error instanceof RuntimeApiError ? `${error.code} · ${error.message}` : error instanceof Error ? error.message : '未知错误';

  const selectProvider = (event: ChangeEvent<HTMLSelectElement>) => {
    // 下拉里的自定义入口只是导航，不改变当前 Provider（受控 value 会立刻把它恢复回去）。
    if (event.target.value === MANAGE_CUSTOM_PROVIDER_VALUE) { setProviderTab('custom'); setTestResult(null); return; }
    const provider = event.target.value as ProviderId;
    const summary = state.runtime.providers.find((item) => item.id === provider);
    const providerReady = provider === 'demo' || Boolean(summary?.ready);
    // 换平台后旧模型 ID 通常不属于新平台。只有 'auto' 或仍在新平台建议列表里的值才保留，
    // 否则回落到 auto，避免把 OpenAI 的模型名发送给其它平台。
    const keepModel = provider === draft.provider || draft.model === 'auto' || modelOptions(provider, '').includes(draft.model);
    // 自定义 API 没有平台默认模型，'auto' 会拿不到模型名；选中时给一个可用的 DeepSeek 默认值。
    const nextModel = provider === 'custom_api'
      ? (draft.model && draft.model !== 'auto' ? draft.model : 'deepseek-chat')
      // 注册表 Provider 只接受模型目录内的模型，切换时直接取目录首项。
      : (summary?.editable === true
        ? summary.models?.[0]?.id || 'auto'
        : (keepModel ? draft.model : 'auto'));
    // 注册表 Provider 的地址由 Runtime 解析，settings.baseUrl 必须置空（契约 §4.4）。
    setDraft({ ...draft, provider, model: nextModel, baseUrl: '', providerReady, onboardingComplete: true });
    // State 会通过 useEffect 回灌 draft，因此这里必须把模型/URL 一并写回，否则刚设置的自定义默认值会被覆盖。
    dispatch({ type: 'SET_SETTINGS', settings: { ...state.settings, provider, model: nextModel, baseUrl: '', providerReady, onboardingComplete: true } });
    setTestResult(null); setApiKey('');
  };

  /** 「自定义模型 API」页签点「设为当前 Provider」：baseUrl 置空，模型取目录首项。 */
  const setCurrentProvider = (id: string, model: string) => {
    const provider = id as ProviderId;
    const providerReady = Boolean(state.runtime.providers.find((item) => item.id === id)?.ready);
    const next = { ...draft, provider, model, baseUrl: '', providerReady, onboardingComplete: true };
    setDraft(next);
    dispatch({ type: 'SET_SETTINGS', settings: { ...state.settings, provider, model, baseUrl: '', providerReady, onboardingComplete: true } });
    setTestResult(null);
  };

  /** 删除自定义 Provider 后，若它正是当前 Provider，回退到安全的 Demo，避免指向不存在的 id。 */
  const handleCustomProviderRemoved = (id: string) => {
    if (String(draft.provider) !== id) return;
    const next = { ...draft, provider: 'demo' as ProviderId, model: 'auto', baseUrl: '', providerReady: true };
    setDraft(next);
    dispatch({ type: 'SET_SETTINGS', settings: { ...state.settings, provider: 'demo', model: 'auto', baseUrl: '', providerReady: true } });
    notify('当前 Provider 已删除', '设置已回退到 Demo 本地模拟，请在「平台 Provider」页签重新选择。', 'warning');
  };

  const refresh = async () => {
    setBusy('refresh');
    try {
      const health = await runtimeClient.health();
      const [providers, diagnostics] = await Promise.all([runtimeClient.providers(), runtimeClient.diagnostics()]);
      const nextReady = draft.provider === 'demo' || Boolean(providers.find((item) => item.id === draft.provider)?.ready);
      dispatch({ type: 'PATCH_RUNTIME', patch: { reachable: true, serviceVersion: health.version, providers, diagnostics, checkedAt: new Date().toISOString(), mode: state.eda.connected && !state.eda.activeWindowId?.startsWith('EDA-DEMO') ? 'real_read_only' : 'demo', lastError: null } });
      setDraft((current) => ({ ...current, providerReady: current.provider === 'demo' || Boolean(providers.find((item) => item.id === current.provider)?.ready) }));
      addAudit('settings', '刷新本机运行诊断', `Runtime ${health.version} · ${providers.filter((item) => item.ready).length}个Provider就绪`, 'success');
      notify('本机诊断已刷新', '已重新检查账号、CLI、Keychain与桌面工具链。', 'success');
    } catch (error) {
      const detail = explain(error);
      dispatch({ type: 'PATCH_RUNTIME', patch: { reachable: false, mode: 'demo', lastError: { code: error instanceof RuntimeApiError ? error.code : 'RUNTIME_ERROR', message: detail } } });
      addAudit('settings', 'Runtime诊断失败', detail, 'error'); reportIssue({ fingerprint: `runtime:${error instanceof RuntimeApiError ? error.code : 'RUNTIME_ERROR'}:local`, source: 'runtime', severity: 'error', status: 'open', code: error instanceof RuntimeApiError ? error.code : 'RUNTIME_ERROR', summary: '本机Runtime诊断失败', detail, suggestedAction: '确认Runtime已启动并检查4178端口。' }); notify('Runtime不可用', detail, 'danger');
    } finally { setBusy(null); }
  };

  /**
   * 「自定义模型 API」页签保存/删除后的静默刷新：只更新 Provider 列表与就绪状态，
   * 不弹"诊断已刷新"的 toast，避免每次保存都盖住真正的结果提示。
   */
  const refreshProviders = async () => {
    try {
      const providers = await runtimeClient.providers();
      dispatch({ type: 'PATCH_RUNTIME', patch: { providers, checkedAt: new Date().toISOString(), lastError: null } });
      setDraft((current) => ({ ...current, providerReady: current.provider === 'demo' || Boolean(providers.find((item) => item.id === current.provider)?.ready) }));
    } catch (error) {
      notify('Provider 列表刷新失败', explain(error), 'warning');
    }
  };

  /** H5：导出脱敏诊断包（浏览器下载，不落服务端文件），用于定位一次失败。 */
  const exportDiagnosticBundle = async () => {
    setBusy('bundle');
    try {
      const bundle = await runtimeClient.diagnosticBundle();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `circuitpilot-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      link.click();
      URL.revokeObjectURL(url);
      const hash = String((bundle as { bundleHash?: string }).bundleHash || '');
      addAudit('settings', '导出诊断包', `bundleHash ${hash.slice(0, 12)} · 已脱敏/有界`, 'success');
      notify('诊断包已生成', '已脱敏（token/Key/邮箱/用户目录路径）并下载；只含版本、证据索引摘要、追溯计数、journal 哈希链状态与最近错误。', 'success');
    } catch (error) {
      const detail = explain(error);
      addAudit('settings', '诊断包生成失败', detail, 'error');
      notify('诊断包生成失败', detail, 'danger');
    } finally { setBusy(null); }
  };

  const login = async () => {
    setBusy('login'); const generation=++loginGeneration.current; const provider=draft.provider;
    try {
      const response=await runtimeClient.startLogin(provider);
      if (!response.login.state) throw new RuntimeApiError('RUNTIME_LOGIN_CONTRACT_STALE','当前连接的是旧版Runtime，请完全退出CircuitPilot后重新打开新版应用。');
      if (response.login.state==='already_authenticated') {
        const providers=await runtimeClient.providers(); dispatch({type:'PATCH_RUNTIME',patch:{providers,checkedAt:new Date().toISOString(),lastError:null}}); setDraft((current)=>({...current,providerReady:true})); addAudit('settings','账号已认证',providerLabel(provider),'success'); notify('账号已经登录',response.login.status||'Codex账号认证有效。','success'); return;
      }
      addAudit('settings','启动官方账号登录',providerLabel(provider),'info'); notify('已启动官方登录','请在系统浏览器完成授权，认证状态会自动刷新。','info');
      for(let attempt=0;attempt<40 && generation===loginGeneration.current;attempt+=1){
        await new Promise((resolve)=>window.setTimeout(resolve,1500)); const providers=await runtimeClient.providers(); const current=providers.find((item)=>item.id===provider);
        dispatch({type:'PATCH_RUNTIME',patch:{providers,checkedAt:new Date().toISOString(),lastError:null}});
        if(current?.ready){setDraft((value)=>({...value,providerReady:true})); addAudit('settings','官方账号登录完成',providerLabel(provider),'success'); notify('登录成功',current.status||`${providerLabel(provider)}已就绪。`,'success'); return;}
      }
      if(generation===loginGeneration.current) notify('等待认证超时','登录进程仍可能在浏览器中等待；完成授权后可点击“刷新本机状态”。','warning');
    }
    catch (error) { const detail = explain(error); addAudit('settings', '账号登录启动失败', detail, 'error'); reportIssue({ fingerprint: `provider:LOGIN:${draft.provider}`, source: 'provider', severity: 'error', status: 'open', code: 'PROVIDER_LOGIN_FAILED', summary: `${displayLabel}登录启动失败`, detail, context: { provider: draft.provider }, suggestedAction: '检查CLI安装和账号状态后重试。' }); notify('无法启动登录', detail, 'danger'); }
    finally { setBusy(null); }
  };

  const storeKey = async () => {
    if (!apiKey.trim()) return notify('请输入 API Key', '密钥只会发送到本机Runtime并写入macOS钥匙串。', 'warning');
    setBusy('key');
    try { const result = await runtimeClient.storeKey(draft.provider, apiKey); setApiKey(''); addAudit('settings', '保存Provider凭据', `${displayLabel} · ${result.credential.hint}`, 'success'); notify('凭据已安全保存', `已写入macOS钥匙串 ${result.credential.hint}，网页状态中未保存完整Key。`, 'success'); await refresh(); }
    catch (error) { setApiKey(''); const detail = explain(error); addAudit('settings', 'Provider凭据保存失败', detail, 'error'); reportIssue({ fingerprint: `provider:KEYCHAIN:${draft.provider}`, source: 'provider', severity: 'error', status: 'open', code: 'PROVIDER_CREDENTIAL_FAILED', summary: `${displayLabel}凭据保存失败`, detail, context: { provider: draft.provider }, suggestedAction: '检查macOS钥匙串权限与Key格式。' }); notify('保存失败', detail, 'danger'); }
    finally { setBusy(null); }
  };

  const openConsole = async () => {
    if (!consoleUrl) return;
    // 桌面壳层不会为 target="_blank" 创建新窗口，所以优先请本机 Runtime 调起系统浏览器；
    // Runtime 不可达时（例如只在浏览器里跑前端）再退回 window.open。
    if (state.runtime.reachable) {
      setBusy('console');
      try { await runtimeClient.openProviderConsole(draft.provider); addAudit('settings', '打开平台Key控制台', `${displayLabel} · ${consoleUrl}`, 'info'); notify('已打开平台控制台', `已用系统浏览器打开 ${displayLabel} 的 Key 管理页。`, 'info'); return; }
      catch (error) { notify('无法自动打开浏览器', `${explain(error)}。请手动访问 ${consoleUrl}`, 'warning'); return; }
      finally { setBusy(null); }
    }
    window.open(consoleUrl, '_blank', 'noreferrer');
  };

  const removeKey = async () => {
    setBusy('remove');
    try { await runtimeClient.removeKey(draft.provider); addAudit('settings', '撤销Provider凭据', displayLabel, 'warning'); notify('凭据已撤销', '对应密钥已从macOS钥匙串删除。', 'warning'); await refresh(); }
    catch (error) { const detail = explain(error); addAudit('settings', '撤销凭据失败', detail, 'error'); notify('撤销失败', detail, 'danger'); }
    finally { setBusy(null); }
  };

  const test = async () => {
    if (customApi && !customBaseUrl) { setTestResult('请先填写 API URL，再测试连接'); notify('缺少 API URL', '自定义 API 需要完整的 OpenAI 兼容地址，例如 https://api.deepseek.com/v1。', 'warning'); return; }
    setBusy('test'); setTestResult(null);
    try {
      if (draft.provider === 'demo') { const result = await demoAdapter.testProvider(providerLabel('demo')); setTestResult(`${result.provider} · ${result.latency} ms`); }
      else { const result = await runtimeClient.testProvider(draft.provider, draft.baseUrl || undefined); if(result.ready===false || result.ok===false) throw new RuntimeApiError('PROVIDER_UNAUTHENTICATED',result.status||'Provider尚未认证'); setTestResult(result.models?.length ? `连接成功 · 可见 ${result.models.length} 个模型` : result.status || '认证状态有效'); }
      setDraft((current) => ({ ...current, providerReady: true })); addAudit('settings', '测试AI Provider', displayLabel, 'success'); notify('Provider连接通过', displayLabel, 'success');
    } catch (error) { const detail = explain(error); setTestResult(detail); setDraft((current) => ({ ...current, providerReady: false })); addAudit('settings', 'Provider连接失败', detail, 'error'); reportIssue({ fingerprint: `provider:TEST:${draft.provider}`, source: 'provider', severity: 'error', status: 'open', code: error instanceof RuntimeApiError ? error.code : 'PROVIDER_TEST_FAILED', summary: `${displayLabel}连接测试失败`, detail, context: { provider: draft.provider }, suggestedAction: '检查认证、配额和网络后重试。' }); notify('Provider连接失败', detail, 'danger'); }
    finally { setBusy(null); }
  };

  const loadEgress = async () => {
    setEgressBusy(true);
    try {
      const result = await runtimeClient.providerEgress();
      setEgress(result.egress);
      addAudit('settings', '读取数据外发清单', `${result.egress.endpoints.length} 个外发点 · ${result.egress.policyVersion}`, 'info');
    } catch (error) {
      const detail = explain(error);
      notify('外发清单读取失败', detail, 'warning');
    } finally {
      setEgressBusy(false);
    }
  };

  const previewEgress = async () => {
    setEgressBusy(true);
    try {
      const requirements = state.requirements.map((item) => `${item.name} ${item.value}${item.unit}`).join('；');
      const result = await runtimeClient.previewProviderEgress({
        requirements: requirements || '（当前没有已确认需求）',
        provider: draft.provider,
        model: draft.model,
        note: '示例：本机路径 /Users/demo/board 与 token 会被擦除',
      });
      setEgressPreview(result);
      notify('脱敏预览已生成', result.changed ? '检测到可脱敏内容，已擦除后再外发（预览不代表已发送）' : '当前示例没有可脱敏内容', 'info');
    } catch (error) {
      const detail = explain(error);
      notify('脱敏预览失败', detail, 'warning');
    } finally {
      setEgressBusy(false);
    }
  };

  const testResearch = async () => {
    setResearchBusy(true);
    setResearchResult(null);
    try {
      const provider = !draft.researchProvider || draft.researchProvider === 'auto' ? undefined : draft.researchProvider;
      const result = await runtimeClient.researchSearch({ query: 'WS2812B datasheet', provider, allowResearch: true });
      const first = result.research.results[0];
      const summary = `${result.research.provider} 返回 ${result.research.results.length} 条${first ? `；首条：${first.title}（${first.url.slice(0, 72)}）` : ''}`;
      setResearchResult(`通过：${summary}`);
      addAudit('settings', '联网检索连通性测试', summary, 'success');
      notify('联网检索可用', summary, 'success');
    } catch (error) {
      const detail = explain(error);
      setResearchResult(`失败：${detail}`);
      addAudit('settings', '联网检索连通性测试失败', detail, 'error');
      notify('联网检索失败', detail, 'danger');
    } finally {
      setResearchBusy(false);
    }
  };

  const save = async () => {
    // 注册表 Provider 的地址由 Runtime 解析，这里只允许置空；内置自定义槽仍要求用户填 URL。
    const baseUrl = editableProvider ? '' : (draft.baseUrl || '').trim();
    if (customApi && !baseUrl) return notify('请填写 API URL', '自定义 API 需要完整的 OpenAI 兼容地址，例如 https://api.deepseek.com/v1。', 'warning');
    if (customApi && (!draft.model || draft.model === 'auto')) return notify('请填写模型名称', '例如 deepseek-chat 或 deepseek-reasoner。', 'warning');
    // 注册表 Provider 只接受模型目录内的模型：'auto' 或空值回落到目录首项，而不是把 auto 发给 Runtime。
    const model = editableProvider && (!draft.model || draft.model === 'auto')
      ? providerStatus?.models?.[0]?.id || ''
      : draft.model;
    if (editableProvider && !model) return notify('该 Provider 还没有模型', '请到「自定义模型 API」页签的模型目录里添加至少 1 个模型并保存配置。', 'warning');
    /**
     * P0-8：写暂停的权威在 Runtime。
     * 修复前这里只 dispatch + localStorage：设置页写着"阻断所有 EDA 写命令"，脚本/curl 照样能写。
     * 现在必须先让 Runtime 落盘，成功后才更新本地镜像；Runtime 不可达/拒绝时绝不允许"只改本地"。
     */
    if (draft.writePaused !== state.settings.writePaused) {
      if (!state.runtime.reachable) {
        addAudit('settings', '写暂停变更未生效', 'Runtime 未连接，写暂停只能由 Runtime 执行', 'error');
        return notify('写暂停未生效', 'Runtime 未连接：写暂停是 Runtime 级门禁，不能只改本地开关。请先启动 Runtime 后重试。', 'danger');
      }
      try {
        await runtimeClient.setWriteGate({ paused: draft.writePaused, reason: draft.writePaused ? '用户在设置页暂停所有写入' : null, actor: '设置页' });
      } catch (error) {
        const detail = explain(error);
        addAudit('settings', '写暂停变更未生效', detail, 'error');
        return notify('写暂停未生效', `Runtime 拒绝了写门禁变更：${detail}`, 'danger');
      }
    }
    const ready = draft.provider === 'demo' || Boolean(state.runtime.providers.find((item) => item.id === draft.provider)?.ready);
    // researchEnabled 以 Runtime 权威值为准（它不在保存按钮里改），避免本地镜像被 draft 旧值覆盖。
    dispatch({ type: 'SET_SETTINGS', settings: { ...draft, baseUrl, model, researchEnabled, providerReady: ready, onboardingComplete: true } });
    addAudit('settings', '保存系统设置', `${displayLabel} · ${model}`, 'success'); recordChange({ source: 'user', actor: '本机用户', action: 'update', objectType: 'settings', objectId: 'system-settings', summary: '更新AI Provider与安全策略', before: { provider: state.settings.provider, model: state.settings.model, writePaused: state.settings.writePaused }, after: { provider: draft.provider, model, writePaused: draft.writePaused }, reason: '用户保存系统设置' }); notify('设置已保存', '仅非敏感配置写入浏览器；账号和API Key不在LocalStorage中。', 'success');
  };

  return <>
    <div className="stats-grid stats-grid--4"><Stat label="本机Runtime" value={state.runtime.reachable ? '在线' : '未连接'} hint={state.runtime.serviceVersion ? `v${state.runtime.serviceVersion}` : runtimeClient.baseUrl} tone={state.runtime.reachable ? 'success' : 'danger'} /><Stat label="AI Provider" value={selectedReady ? '就绪' : '待配置'} hint={displayLabel} tone={selectedReady ? 'success' : 'warning'} /><Stat label="运行模式" value={state.runtime.mode === 'real_read_only' ? '真实只读' : 'Demo 降级'} hint="真实写入仍默认关闭" tone={state.runtime.mode === 'real_read_only' ? 'info' : 'warning'} /><Stat label="安全存储" value="macOS钥匙串" hint="Schema v2 · 不保存密钥" tone="success" /></div>
    <div className="settings-layout">
      <Panel eyebrow="01 · LOCAL RUNTIME" title="本机能力检查" meta="安装后自动探测，不自动更改账号">
        <div className="setup-progress"><div className={state.runtime.reachable ? 'is-done' : ''}><span>1</span><strong>Runtime</strong><small>{state.runtime.reachable ? '已连接' : '请运行 npm run dev:full'}</small></div><div className={selectedReady ? 'is-done' : ''}><span>2</span><strong>AI Provider</strong><small>{selectedReady ? '已就绪' : '等待登录或Key'}</small></div><div className={state.eda.connected && state.runtime.mode !== 'demo' ? 'is-done' : ''}><span>3</span><strong>嘉立创EDA</strong><small>{state.eda.connected && state.runtime.mode !== 'demo' ? 'Bridge已连接' : '前往EDA控制检查'}</small></div></div>
        <div className="diagnostic-list runtime-diagnostics">{state.runtime.diagnostics.length ? state.runtime.diagnostics.map((item) => <div className={`diagnostic diagnostic--${item.available ? 'pass' : 'fail'}`} key={item.id}>{item.available ? <CheckCircle2 size={17} /> : <TriangleAlert size={17} />}<span><strong>{item.name}</strong><small>{item.detail}</small></span><Badge tone={item.available ? 'success' : item.id === 'cargo' ? 'warning' : 'danger'}>{item.available ? '通过' : item.id === 'cargo' ? '桌面构建待安装' : '缺失'}</Badge></div>) : <div className="empty-inline">尚未获得真实诊断结果。</div>}</div>
        {state.runtime.lastError && <div className="inline-alert inline-alert--warning"><TriangleAlert size={16} /><span>{state.runtime.lastError.code} · {state.runtime.lastError.message}</span></div>}
        <div className="row-actions">
          <Button icon={<RefreshCw size={15} />} loading={busy === 'refresh'} onClick={refresh}>刷新本机状态</Button>
          <Button icon={<Download size={15} />} loading={busy === 'bundle'} disabled={!state.runtime.reachable} onClick={() => void exportDiagnosticBundle()} title="生成脱敏诊断包并下载；用于失败定位，不含工程文件内容">导出诊断包</Button>
        </div>
      </Panel>

      <Panel eyebrow="02 · AI PROVIDER" title="账号与API配置" className={providerTab === 'custom' ? 'panel--provider-wide' : ''} meta={`${realPathCount} 条真实路径（官方账号 + 第三方平台API） + 明确Demo降级`} actions={providerTab === 'platform' ? <Button size="sm" icon={<Plus size={15} />} onClick={() => setProviderTab('custom')} title="注册自己的模型网关：API 地址、协议、密钥与模型上下文都可自己配置">自定义模型 API</Button> : undefined}>
        {/* 两个页签条件渲染：非激活页签不渲染，避免同名字段重复出现（getByLabel 唯一性）。
            tablist 的 aria-label 刻意不含 "Provider"：它会被 getByLabel('Provider') 当作第二个匹配，
            让既有设置页用例/无障碍定位出现歧义。 */}
        <div className="provider-tabs">
          <SegmentedTabs
            label="AI 接入方式"
            value={providerTab}
            onChange={(value) => setProviderTab(value === 'custom' ? 'custom' : 'platform')}
            items={[{ value: 'platform', label: '平台 Provider' }, { value: 'custom', label: '自定义模型 API' }]}
          />
        </div>
        {providerTab === 'custom' ? (
          <CustomProviderEditor
            providers={editableProviders}
            currentProvider={String(draft.provider)}
            initialProviderId={customEditId}
            onEditChange={setCustomEditId}
            onRefresh={refreshProviders}
            onSetProvider={setCurrentProvider}
            onRemoved={handleCustomProviderRemoved}
          />
        ) : <>
        <div className="settings-section-icon"><Bot size={21} /><div><strong>{displayLabel}</strong><small>{editableProvider ? '注册表自定义 Provider：协议、地址与模型目录在「自定义模型 API」页签维护。' : (providerInfo?.summary || '认证由本机Runtime处理，前端只保存状态摘要。')}</small></div><Badge tone={selectedReady ? 'success' : 'warning'}>{selectedReady ? 'READY' : 'SETUP'}</Badge></div>
        <div className="form-grid"><SelectField label="Provider" value={draft.provider} onChange={selectProvider} hint="官方账号走本机CLI登录；第三方平台走各自平台的密钥，凭据只落macOS钥匙串；自定义模型 API（地址/密钥/模型目录）在上方第二个页签维护">
          {providerGroups.map((group) => <optgroup key={group.group} label={group.group}>{group.entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</optgroup>)}
          <optgroup label="自定义"><option value={MANAGE_CUSTOM_PROVIDER_VALUE}>＋ 新增自定义 Provider（地址/密钥/目录）…</option></optgroup>
        </SelectField>
          {editableProvider ? <SelectField label="模型" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} hint="只列该 Provider 模型目录里的模型；Runtime 会拒绝目录外的模型 ID">
            {availableModels.map((item) => <option key={item} value={item}>{registryModelLabels.get(item) || item}</option>)}
          </SelectField> : <Field label="模型" hint={customApi ? '必填。填写供应商文档里的模型名称，例如 deepseek-chat、deepseek-reasoner' : '可从建议值中挑选，也可直接粘贴平台文档里的模型ID；auto 表示交由Runtime决定'}><input className="input" list="provider-model-options" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder={customApi ? 'deepseek-chat' : 'auto'} /><datalist id="provider-model-options">{availableModels.map((item) => <option key={item} value={item}>{item === 'auto' ? '自动选择（推荐）' : item}</option>)}</datalist></Field>}
          {apiProvider && !editableProvider && <Field label={customApi ? 'API URL *' : '第三方供应商 Base URL（可选）'} hint={customApi ? '必填。填写 OpenAI 兼容地址，Runtime 会请求 {API URL}/chat/completions 与 {API URL}/models；只接受 HTTPS，本机回环地址可用 HTTP' : `留空使用平台默认地址${providerInfo?.defaultBaseUrl ? `（${providerInfo.defaultBaseUrl}）` : ''}。可填第三方供应商或企业自建的 OpenAI 兼容网关；只接受 HTTPS，本机回环地址可用 HTTP`}><input className="input" value={draft.baseUrl || ''} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder={customApi ? 'https://api.deepseek.com/v1' : (providerInfo?.defaultBaseUrl || 'https://your-gateway.example.com/v1')} spellCheck={false} /></Field>}
          <Field label="单任务 Token 预算" hint="用于任务成本与中止门槛，不会改变账号权限"><input className="input" type="number" min={1000} max={50000} step={1000} value={draft.budget} onChange={(e) => setDraft({ ...draft, budget: Number(e.target.value) })} /></Field>
          {apiProvider && !editableProvider && <Field label="API Key" hint={`只写入macOS钥匙串中「${displayLabel}」的独立条目；输入框立即清空，不进入日志或LocalStorage`}><input className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="粘贴Key后点击安全保存" /></Field>}
          {editableProvider && <div className="provider-status provider-status--registry"><span><strong>API 协议</strong><small>{providerStatus.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions'}</small></span><span><strong>API 地址</strong><small>{customBaseUrl || '尚未配置（由 Runtime 注册表提供）'}</small></span><span><strong>模型目录</strong><small>{providerStatus.models?.length || 0} 个模型{providerStatus.models?.length ? ` · 首项 ${providerStatus.models[0].id}` : ''}</small></span><span><strong>凭据管理</strong><small>到「自定义模型 API」页签保存或撤销该 Provider 的 API 密钥</small></span></div>}
          {providerStatus && !editableProvider && <div className="provider-status"><span><strong>安装 / 配置</strong><small>{providerStatus.kind === 'cli' ? (providerStatus.installed ? providerStatus.version || 'CLI已安装' : 'CLI未安装') : (providerStatus.configured ? '钥匙串中已配置' : '尚未配置')}</small></span><span><strong>认证状态</strong><small>{providerStatus.ready ? providerStatus.status || '有效' : '未就绪'}</small></span></div>}
          {!providerStatus && draft.provider !== 'demo' && <div className="inline-alert inline-alert--warning"><TriangleAlert size={16} />当前Runtime未上报该Provider（可能仍在运行旧版本）。请完全退出后重新打开应用，再刷新本机状态。</div>}
          <div className="provider-actions">{accountProvider && <Button icon={<ExternalLink size={15} />} loading={busy === 'login'} disabled={!state.runtime.reachable} title={!state.runtime.reachable ? '请先启动本机Runtime' : undefined} onClick={login}>启动官方登录</Button>}{apiProvider && !editableProvider && <Button icon={<KeyRound size={15} />} loading={busy === 'key'} disabled={!state.runtime.reachable || !apiKey.trim()} title={!state.runtime.reachable ? '请先启动本机Runtime' : !apiKey.trim() ? '请先输入API Key' : undefined} onClick={storeKey}>安全保存</Button>}{apiProvider && consoleUrl && <Button icon={<ExternalLink size={15} />} loading={busy === 'console'} onClick={openConsole}>去平台申请Key</Button>}<Button icon={<TestTube2 size={15} />} loading={busy === 'test'} disabled={draft.provider !== 'demo' && !state.runtime.reachable} title={draft.provider !== 'demo' && !state.runtime.reachable ? '请先启动本机Runtime' : undefined} onClick={test}>测试连接</Button>{apiProvider && providerStatus?.configured && !editableProvider && <Button variant="danger" icon={<Trash2 size={15} />} loading={busy === 'remove'} onClick={removeKey}>撤销Key</Button>}</div>
          {testResult && <div className="provider-test"><CheckCircle2 size={15} /><span>{testResult}</span></div>}{draft.provider === 'claude_account' && <div className="inline-alert inline-alert--warning"><TriangleAlert size={16} />Claude Code账号路径仅用于本机个人工作流；产品分发应使用Anthropic API。</div>}
        </div>
        </>}
      </Panel>

      <Panel
        eyebrow="02c · WEB RESEARCH"
        title="联网检索（让 AI 查 datasheet / 器件资料）"
        meta={<Badge tone={researchEnabled ? 'success' : 'info'}>{researchEnabled ? '已允许' : '默认关闭'}</Badge>}
      >
        <div className="toggle-stack">
          <Toggle
            checked={researchEnabled}
            disabled={!state.runtime.reachable}
            onChange={(next) => { void saveResearchEnabled(next); }}
            label="允许 AI 联网查询公开资料"
            description={state.runtime.reachable ? '开启后 AI 可检索公开结果页并抓取 datasheet / 立创商品页作为设计证据；默认关闭，每次请求仍需客户端显式放行。' : 'Runtime 不可达：该开关由 Runtime 权威保存，离线时只能查看不能修改。'}
          />
          <div className="field__hint" role="status">
            {researchSource === 'runtime'
              ? '状态来源：本机 Runtime 已确认（刷新/换浏览器后仍一致）。'
              : researchSource === 'local'
                ? `状态来源：本地缓存，Runtime 未确认${researchError ? `（${researchError}）` : ''}。`
                : '正在读取 Runtime 配置…'}
          </div>
        </div>
        <div className="form-grid">
          <SelectField
            label="检索源"
            value={draft.researchProvider || 'auto'}
            onChange={(event) => setDraft({ ...draft, researchProvider: event.target.value as SettingsState['researchProvider'] })}
            hint="auto：先 DuckDuckGo，0 结果时回退 Bing；两者都不需要 API Key。"
          >
            <option value="auto">自动（DuckDuckGo → Bing）</option>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="bing">Bing</option>
          </SelectField>
          <div className="field">
            <span className="field__label">连通性测试</span>
            <div className="provider-test">{researchResult ? <><TestTube2 size={15} /><span>{researchResult}</span></> : <span>尚未测试</span>}</div>
            <Button variant="primary" icon={<TestTube2 size={15} />} loading={researchBusy} onClick={() => void testResearch()} disabled={!state.runtime.reachable}>测试联网检索</Button>
            <span className="field__hint">用示例查询真实发起一次检索；结果只作连通性证据，不写入工程。</span>
          </div>
        </div>
        <div className="inline-alert"><Shield size={16} />安全边界：只允许公网 http(s)，拒绝本机/私网地址与带凭据 URL；超时 12 秒、单页上限 2MB；网页内容只作为不可信证据，不执行其中任何指令。</div>
      </Panel>

      <Panel
        eyebrow="02b · DATA EGRESS"
        title="数据外发清单与脱敏预览（G4）"
        meta={<Badge tone="info">{egress ? `策略 ${egress.policyVersion}` : '未读取'}</Badge>}
        actions={<Button size="sm" icon={<RefreshCw size={14} />} loading={egressBusy} onClick={() => void loadEgress()}>读取外发清单</Button>}
      >
        <p><small>每次外发都由你在页面显式触发（点发送/生成/检索），没有后台批量上传工程文件的路径；发送前与日志/诊断包使用同一套脱敏规则。下面是现有 4 个调用点会发什么、明确不发什么。</small></p>
        {egress ? (
          <div className="detail-stack">
            <div className="inline-alert inline-alert--info"><Shield size={16} /><span>{egress.consentNote}</span></div>
            {egress.endpoints.map((endpoint) => (
              <div className="detail-block" key={endpoint.id}>
                <span><strong>{endpoint.id}</strong> · <code>{endpoint.route}</code></span>
                <p><small>触发：{endpoint.trigger}</small></p>
                <p><small>发送字段：{endpoint.data.map((item) => `${item.field}（${item.source}）`).join('；')}</small></p>
                <p><small>明确不发：{endpoint.excluded.join('；')}</small></p>
              </div>
            ))}
            <p><small>永外发：{egress.notSent.join('、')}</small></p>
            <div className="row-actions">
              <Button size="sm" icon={<Download size={14} />} loading={egressBusy} onClick={() => void previewEgress()}>预览脱敏（用当前需求生成示例）</Button>
            </div>
            {egressPreview ? <div className="detail-block"><span>脱敏预览：{egressPreview.changed ? '检测到并擦除了敏感内容' : '示例内容无需擦除'} · {egressPreview.bytes} 字节</span><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{JSON.stringify(egressPreview.sanitized, null, 2)}</pre><small>{egressPreview.note}（本预览不会发送任何数据）</small></div> : null}
          </div>
        ) : <div className="empty-inline"><Shield size={22} /><strong>尚未读取</strong><span>连接 Runtime 后点「读取外发清单」；清单是接口契约，不是营销文案。</span></div>}
      </Panel>

      <Panel eyebrow="03 · SAFETY POLICIES" title="安全门禁" meta="策略优先于任务审批"><div className="toggle-stack"><Toggle checked={draft.readOnlyDefault} onChange={(readOnlyDefault) => setDraft({ ...draft, readOnlyDefault })} label="新任务默认只读" description="每个新任务先从分析开始，避免默认获取写权限。" /><Toggle checked={draft.autoSnapshot} onChange={(autoSnapshot) => setDraft({ ...draft, autoSnapshot })} label="写入前自动快照" description="执行受控写入前创建可回滚的版本节点。" /><Toggle checked={draft.autoSave} onChange={(autoSave) => setDraft({ ...draft, autoSave })} label="验证通过后自动保存" description="当前真实运行时尚未开放保存命令。" /><Toggle checked={draft.confirmExport} onChange={(confirmExport) => setDraft({ ...draft, confirmExport })} label="导出前二次确认" description="BOM、诊断包和评审包下载前显示用途边界。" /><Toggle checked={draft.writePaused} onChange={(writePaused) => setDraft({ ...draft, writePaused })} label="全局暂停所有写入" description="最高优先级门禁，阻断所有 EDA 写命令。" /></div></Panel>
      <AgentAccessPanel />
      <Panel eyebrow="LOCAL DATA" title="本地状态管理" meta="只有非敏感状态保存在当前浏览器"><div className="data-card"><div className="data-card__icon"><Database size={22} /></div><div><strong>本地工作区状态</strong><p>项目、任务和审计保存在浏览器；不包含API Key与登录Token。</p><code>circuitpilot-state-v2</code></div><Button variant="danger" icon={<RefreshCw size={15} />} onClick={() => setResetOpen(true)}>重置本地数据</Button></div><div className="demo-boundaries"><div><Shield size={18} /><span><strong>密钥隔离</strong><small>API Key只存macOS钥匙串，Runtime响应与错误统一脱敏。</small></span></div><div><TriangleAlert size={18} /><span><strong>写入仍未开放</strong><small>真实能力仅限诊断、窗口选择、工程与文档只读回读。</small></span></div></div></Panel>
    </div>
    <div className={`sticky-save ${dirty ? "is-dirty" : "is-synced"}`}><div>{dirty ? <><span className="status-light status-light--warn" /><strong>有未保存的设置</strong></> : <><span className="status-light status-light--on" /><strong>设置已同步</strong></>}<small>{dirty ? '保存后更新Provider选择和全局写入门禁。' : '当前非敏感配置已写入本地持久化。'}</small></div><Button onClick={() => setDraft(state.settings)} disabled={!dirty} title={!dirty ? '没有需要放弃的更改' : undefined}>放弃更改</Button><Button variant="primary" icon={<Save size={15} />} onClick={save} disabled={!dirty} title={!dirty ? '没有需要保存的更改' : undefined}>保存设置</Button></div>
    <ConfirmDialog open={resetOpen} onClose={() => setResetOpen(false)} onConfirm={() => { resetDemo(); notify('本地数据已重置', '钥匙串凭据未被删除。', 'success'); }} title="重置本地工作区数据？" description="清除浏览器中的项目、任务和审计状态，但不会删除macOS钥匙串凭据或操作嘉立创EDA工程。" confirmLabel="确认重置" danger />
  </>;
}
