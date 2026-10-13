import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Bot, CheckCircle2, Database, ExternalLink, KeyRound, RefreshCw, Save, Shield, TestTube2, Trash2, TriangleAlert } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { demoAdapter } from '../services/demoAdapter';
import { RuntimeApiError, runtimeClient } from '../services/runtimeClient';
import type { ProviderId, SettingsState } from '../types';
import { Badge, Button, Field, Panel, SelectField, Stat, Toggle } from '../components/ui';
import { ConfirmDialog } from '../components/overlays';
import { PROVIDER_CATALOG, groupedProviderOptions, isAccountProvider, isApiProvider, modelOptions, providerEntry, providerLabel } from '../data/providerCatalog';

export function SettingsPage() {
  const { state, dispatch, notify, addAudit, recordChange, reportIssue, resetDemo } = useApp();
  const [draft, setDraft] = useState<SettingsState>(state.settings);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const loginGeneration = useRef(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);
  const providerStatus = state.runtime.providers.find((item) => item.id === draft.provider);
  const selectedReady = draft.provider === 'demo' || Boolean(providerStatus?.ready);
  // 显示名以 Runtime 上报为准（可能比前端目录新），目录名作为离线兜底。
  const displayLabel = providerStatus?.label || providerLabel(draft.provider);
  const providerInfo = providerEntry(draft.provider);
  const providerGroups = groupedProviderOptions(state.runtime.providers);
  // 类型优先信 Runtime 上报（可能比前端目录新），目录只作为离线兜底。
  const providerKind = providerStatus?.kind ?? providerInfo?.kind;
  const apiProvider = providerKind ? providerKind === 'api' : isApiProvider(draft.provider);
  const accountProvider = providerKind ? providerKind === 'cli' : isAccountProvider(draft.provider);
  const availableModels = modelOptions(draft.provider, draft.model);
  const consoleUrl = providerStatus?.keyUrl || providerInfo?.keyUrl;
  const realPathCount = PROVIDER_CATALOG.filter((entry) => entry.kind !== 'demo').length;
  useEffect(() => { setDraft(state.settings); return () => { loginGeneration.current += 1; }; }, [state.settings]);
  const explain = (error: unknown) => error instanceof RuntimeApiError ? `${error.code} · ${error.message}` : error instanceof Error ? error.message : '未知错误';

  const selectProvider = (event: ChangeEvent<HTMLSelectElement>) => {
    const provider = event.target.value as ProviderId;
    const providerReady = provider === 'demo' || Boolean(state.runtime.providers.find((item) => item.id === provider)?.ready);
    // 换平台后旧模型 ID 通常不属于新平台。只有 'auto' 或仍在新平台建议列表里的值才保留，
    // 否则回落到 auto，避免把 OpenAI 的模型名发送给其它平台。
    const keepModel = provider === draft.provider || draft.model === 'auto' || modelOptions(provider, '').includes(draft.model);
    setDraft({ ...draft, provider, model: keepModel ? draft.model : 'auto', providerReady, onboardingComplete: true });
    dispatch({ type: 'SET_SETTINGS', settings: { ...state.settings, provider, providerReady, onboardingComplete: true } });
    setTestResult(null); setApiKey('');
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
    setBusy('test'); setTestResult(null);
    try {
      if (draft.provider === 'demo') { const result = await demoAdapter.testProvider(providerLabel('demo')); setTestResult(`${result.provider} · ${result.latency} ms`); }
      else { const result = await runtimeClient.testProvider(draft.provider); if(result.ready===false || result.ok===false) throw new RuntimeApiError('PROVIDER_UNAUTHENTICATED',result.status||'Provider尚未认证'); setTestResult(result.models?.length ? `连接成功 · 可见 ${result.models.length} 个模型` : result.status || '认证状态有效'); }
      setDraft((current) => ({ ...current, providerReady: true })); addAudit('settings', '测试AI Provider', displayLabel, 'success'); notify('Provider连接通过', displayLabel, 'success');
    } catch (error) { const detail = explain(error); setTestResult(detail); setDraft((current) => ({ ...current, providerReady: false })); addAudit('settings', 'Provider连接失败', detail, 'error'); reportIssue({ fingerprint: `provider:TEST:${draft.provider}`, source: 'provider', severity: 'error', status: 'open', code: error instanceof RuntimeApiError ? error.code : 'PROVIDER_TEST_FAILED', summary: `${displayLabel}连接测试失败`, detail, context: { provider: draft.provider }, suggestedAction: '检查认证、配额和网络后重试。' }); notify('Provider连接失败', detail, 'danger'); }
    finally { setBusy(null); }
  };

  const save = () => {
    const ready = draft.provider === 'demo' || Boolean(state.runtime.providers.find((item) => item.id === draft.provider)?.ready);
    dispatch({ type: 'SET_SETTINGS', settings: { ...draft, providerReady: ready, onboardingComplete: true } });
    addAudit('settings', '保存系统设置', `${displayLabel} · ${draft.model}`, 'success'); recordChange({ source: 'user', actor: '本机用户', action: 'update', objectType: 'settings', objectId: 'system-settings', summary: '更新AI Provider与安全策略', before: { provider: state.settings.provider, model: state.settings.model, writePaused: state.settings.writePaused }, after: { provider: draft.provider, model: draft.model, writePaused: draft.writePaused }, reason: '用户保存系统设置' }); notify('设置已保存', '仅非敏感配置写入浏览器；账号和API Key不在LocalStorage中。', 'success');
  };

  return <>
    <div className="stats-grid stats-grid--4"><Stat label="本机Runtime" value={state.runtime.reachable ? '在线' : '未连接'} hint={state.runtime.serviceVersion ? `v${state.runtime.serviceVersion}` : runtimeClient.baseUrl} tone={state.runtime.reachable ? 'success' : 'danger'} /><Stat label="AI Provider" value={selectedReady ? '就绪' : '待配置'} hint={displayLabel} tone={selectedReady ? 'success' : 'warning'} /><Stat label="运行模式" value={state.runtime.mode === 'real_read_only' ? '真实只读' : 'Demo 降级'} hint="真实写入仍默认关闭" tone={state.runtime.mode === 'real_read_only' ? 'info' : 'warning'} /><Stat label="安全存储" value="macOS钥匙串" hint="Schema v2 · 不保存密钥" tone="success" /></div>
    <div className="settings-layout">
      <Panel eyebrow="01 · LOCAL RUNTIME" title="本机能力检查" meta="安装后自动探测，不自动更改账号">
        <div className="setup-progress"><div className={state.runtime.reachable ? 'is-done' : ''}><span>1</span><strong>Runtime</strong><small>{state.runtime.reachable ? '已连接' : '请运行 npm run dev:full'}</small></div><div className={selectedReady ? 'is-done' : ''}><span>2</span><strong>AI Provider</strong><small>{selectedReady ? '已就绪' : '等待登录或Key'}</small></div><div className={state.eda.connected && state.runtime.mode !== 'demo' ? 'is-done' : ''}><span>3</span><strong>嘉立创EDA</strong><small>{state.eda.connected && state.runtime.mode !== 'demo' ? 'Bridge已连接' : '前往EDA控制检查'}</small></div></div>
        <div className="diagnostic-list runtime-diagnostics">{state.runtime.diagnostics.length ? state.runtime.diagnostics.map((item) => <div className={`diagnostic diagnostic--${item.available ? 'pass' : 'fail'}`} key={item.id}>{item.available ? <CheckCircle2 size={17} /> : <TriangleAlert size={17} />}<span><strong>{item.name}</strong><small>{item.detail}</small></span><Badge tone={item.available ? 'success' : item.id === 'cargo' ? 'warning' : 'danger'}>{item.available ? '通过' : item.id === 'cargo' ? '桌面构建待安装' : '缺失'}</Badge></div>) : <div className="empty-inline">尚未获得真实诊断结果。</div>}</div>
        {state.runtime.lastError && <div className="inline-alert inline-alert--warning"><TriangleAlert size={16} /><span>{state.runtime.lastError.code} · {state.runtime.lastError.message}</span></div>}
        <Button icon={<RefreshCw size={15} />} loading={busy === 'refresh'} onClick={refresh}>刷新本机状态</Button>
      </Panel>

      <Panel eyebrow="02 · AI PROVIDER" title="账号与API配置" meta={`${realPathCount} 条真实路径（官方账号 + 第三方平台API） + 明确Demo降级`}>
        <div className="settings-section-icon"><Bot size={21} /><div><strong>{displayLabel}</strong><small>{providerInfo?.summary || '认证由本机Runtime处理，前端只保存状态摘要。'}</small></div><Badge tone={selectedReady ? 'success' : 'warning'}>{selectedReady ? 'READY' : 'SETUP'}</Badge></div>
        <div className="form-grid"><SelectField label="Provider" value={draft.provider} onChange={selectProvider} hint="官方账号走本机CLI登录；第三方平台走各自平台的密钥，凭据只落macOS钥匙串">
          {providerGroups.map((group) => <optgroup key={group.group} label={group.group}>{group.entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</optgroup>)}
        </SelectField>
          <Field label="模型" hint="可从建议值中挑选，也可直接粘贴平台文档里的模型ID；auto 表示交由Runtime决定"><input className="input" list="provider-model-options" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="auto" /><datalist id="provider-model-options">{availableModels.map((item) => <option key={item} value={item}>{item === 'auto' ? '自动选择（推荐）' : item}</option>)}</datalist></Field>
          <Field label="单任务 Token 预算" hint="用于任务成本与中止门槛，不会改变账号权限"><input className="input" type="number" min={1000} max={50000} step={1000} value={draft.budget} onChange={(e) => setDraft({ ...draft, budget: Number(e.target.value) })} /></Field>
          {apiProvider && <Field label="API Key" hint={`只写入macOS钥匙串中「${displayLabel}」的独立条目；输入框立即清空，不进入日志或LocalStorage`}><input className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="粘贴Key后点击安全保存" /></Field>}
          {providerStatus && <div className="provider-status"><span><strong>安装 / 配置</strong><small>{providerStatus.kind === 'cli' ? (providerStatus.installed ? providerStatus.version || 'CLI已安装' : 'CLI未安装') : (providerStatus.configured ? '钥匙串中已配置' : '尚未配置')}</small></span><span><strong>认证状态</strong><small>{providerStatus.ready ? providerStatus.status || '有效' : '未就绪'}</small></span></div>}
          {!providerStatus && draft.provider !== 'demo' && <div className="inline-alert inline-alert--warning"><TriangleAlert size={16} />当前Runtime未上报该Provider（可能仍在运行旧版本）。请完全退出后重新打开应用，再刷新本机状态。</div>}
          <div className="provider-actions">{accountProvider && <Button icon={<ExternalLink size={15} />} loading={busy === 'login'} disabled={!state.runtime.reachable} title={!state.runtime.reachable ? '请先启动本机Runtime' : undefined} onClick={login}>启动官方登录</Button>}{apiProvider && <Button icon={<KeyRound size={15} />} loading={busy === 'key'} disabled={!state.runtime.reachable || !apiKey.trim()} title={!state.runtime.reachable ? '请先启动本机Runtime' : !apiKey.trim() ? '请先输入API Key' : undefined} onClick={storeKey}>安全保存</Button>}{apiProvider && consoleUrl && <Button icon={<ExternalLink size={15} />} loading={busy === 'console'} onClick={openConsole}>去平台申请Key</Button>}<Button icon={<TestTube2 size={15} />} loading={busy === 'test'} disabled={draft.provider !== 'demo' && !state.runtime.reachable} title={draft.provider !== 'demo' && !state.runtime.reachable ? '请先启动本机Runtime' : undefined} onClick={test}>测试连接</Button>{apiProvider && providerStatus?.configured && <Button variant="danger" icon={<Trash2 size={15} />} loading={busy === 'remove'} onClick={removeKey}>撤销Key</Button>}</div>
          {testResult && <div className="provider-test"><CheckCircle2 size={15} /><span>{testResult}</span></div>}{draft.provider === 'claude_account' && <div className="inline-alert inline-alert--warning"><TriangleAlert size={16} />Claude Code账号路径仅用于本机个人工作流；产品分发应使用Anthropic API。</div>}
        </div>
      </Panel>

      <Panel eyebrow="03 · SAFETY POLICIES" title="安全门禁" meta="策略优先于任务审批"><div className="toggle-stack"><Toggle checked={draft.readOnlyDefault} onChange={(readOnlyDefault) => setDraft({ ...draft, readOnlyDefault })} label="新任务默认只读" description="每个新任务先从分析开始，避免默认获取写权限。" /><Toggle checked={draft.autoSnapshot} onChange={(autoSnapshot) => setDraft({ ...draft, autoSnapshot })} label="写入前自动快照" description="执行受控写入前创建可回滚的版本节点。" /><Toggle checked={draft.autoSave} onChange={(autoSave) => setDraft({ ...draft, autoSave })} label="验证通过后自动保存" description="当前真实运行时尚未开放保存命令。" /><Toggle checked={draft.confirmExport} onChange={(confirmExport) => setDraft({ ...draft, confirmExport })} label="导出前二次确认" description="BOM、诊断包和评审包下载前显示用途边界。" /><Toggle checked={draft.writePaused} onChange={(writePaused) => setDraft({ ...draft, writePaused })} label="全局暂停所有写入" description="最高优先级门禁，阻断所有 EDA 写命令。" /></div></Panel>
      <Panel eyebrow="LOCAL DATA" title="本地状态管理" meta="只有非敏感状态保存在当前浏览器"><div className="data-card"><div className="data-card__icon"><Database size={22} /></div><div><strong>本地工作区状态</strong><p>项目、任务和审计保存在浏览器；不包含API Key与登录Token。</p><code>circuitpilot-state-v2</code></div><Button variant="danger" icon={<RefreshCw size={15} />} onClick={() => setResetOpen(true)}>重置本地数据</Button></div><div className="demo-boundaries"><div><Shield size={18} /><span><strong>密钥隔离</strong><small>API Key只存macOS钥匙串，Runtime响应与错误统一脱敏。</small></span></div><div><TriangleAlert size={18} /><span><strong>写入仍未开放</strong><small>真实能力仅限诊断、窗口选择、工程与文档只读回读。</small></span></div></div></Panel>
    </div>
    <div className="sticky-save"><div>{dirty ? <><span className="status-light status-light--warn" /><strong>有未保存的设置</strong></> : <><span className="status-light status-light--on" /><strong>设置已同步</strong></>}<small>{dirty ? '保存后更新Provider选择和全局写入门禁。' : '当前非敏感配置已写入本地持久化。'}</small></div><Button onClick={() => setDraft(state.settings)} disabled={!dirty} title={!dirty ? '没有需要放弃的更改' : undefined}>放弃更改</Button><Button variant="primary" icon={<Save size={15} />} onClick={save} disabled={!dirty} title={!dirty ? '没有需要保存的更改' : undefined}>保存设置</Button></div>
    <ConfirmDialog open={resetOpen} onClose={() => setResetOpen(false)} onConfirm={() => { resetDemo(); notify('本地数据已重置', '钥匙串凭据未被删除。', 'success'); }} title="重置本地工作区数据？" description="清除浏览器中的项目、任务和审计状态，但不会删除macOS钥匙串凭据或操作嘉立创EDA工程。" confirmLabel="确认重置" danger />
  </>;
}
