import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, KeyRound, Plus, RefreshCw, Save, Server, Star, TestTube2, Trash2, TriangleAlert } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { RuntimeApiError, runtimeClient } from '../services/runtimeClient';
import type { CustomModelConfig, CustomProviderConfig, CustomProviderProtocol, ProviderSummary } from '../types';
import { Badge, Button, Field, IconButton, SelectField, Toggle } from './ui';
import { ConfirmDialog } from './overlays';
import { PROVIDER_CATALOG } from '../data/providerCatalog';

/**
 * 自定义模型 API 编辑器（契约 §4.4）。
 *
 * 只做“编辑 + 摘要”：持久化、校验裁决、凭据隔离与协议适配都在 Runtime。
 * 这里镜像一份校验规则（id/baseUrl/模型边界），让用户就地看到错误，但最终以 Runtime 返回为准。
 */

/** 与 runtime/customProviders.mjs#validateCustomProvider 对齐的 id 规则。 */
export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{1,39}$/;
/** 内置 Provider id（含自定义槽 custom_api）不允许被注册表覆盖。 */
export const RESERVED_PROVIDER_IDS: string[] = PROVIDER_CATALOG.map((entry) => String(entry.id));

const MODEL_DEFAULTS = { contextWindow: 128000, maxOutputTokens: 8192 } as const;

interface EditorForm {
  id: string;
  label: string;
  protocol: CustomProviderProtocol;
  baseUrl: string;
  models: CustomModelConfig[];
}

export interface FormErrors {
  id?: string;
  label?: string;
  baseUrl?: string;
  protocol?: string;
  models?: string;
  /** 行内错误，键为 `${行号}.${字段}`。 */
  rows: Record<string, string>;
}

const emptyModel = (): CustomModelConfig => ({ id: '', label: '', contextWindow: MODEL_DEFAULTS.contextWindow, maxOutputTokens: MODEL_DEFAULTS.maxOutputTokens, input: ['text'], reasoning: false });

const newForm = (): EditorForm => ({ id: '', label: '', protocol: 'openai', baseUrl: '', models: [emptyModel()] });

/** PUT 的响应只带配置字段；这里补齐摘要里编辑器需要的那几项。 */
const summaryFromConfig = (config: CustomProviderConfig): ProviderSummary => ({
  id: config.id as ProviderSummary['id'],
  label: config.label,
  kind: 'api',
  ready: Boolean(config.ready),
  configured: Boolean(config.configured),
  custom: true,
  editable: true,
  protocol: config.protocol,
  baseUrl: config.baseUrl,
  models: config.models,
});

const formFromSummary = (summary: ProviderSummary): EditorForm => ({
  id: String(summary.id),
  label: summary.label || String(summary.id),
  protocol: summary.protocol === 'anthropic' ? 'anthropic' : 'openai',
  baseUrl: summary.baseUrl || '',
  models: (summary.models?.length ? summary.models : [emptyModel()]).map((model) => ({
    id: model.id || '',
    label: model.label || '',
    contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : MODEL_DEFAULTS.contextWindow,
    maxOutputTokens: Number.isFinite(model.maxOutputTokens) ? model.maxOutputTokens : MODEL_DEFAULTS.maxOutputTokens,
    input: model.input?.length ? [...model.input] : ['text'],
    reasoning: Boolean(model.reasoning),
  })),
});

/** 仅 HTTPS，或本机回环 HTTP（127.0.0.1 / ::1 / localhost），且不得内嵌凭据。 */
export function isAllowedProviderBaseUrl(raw: string): boolean {
  const value = (raw || '').trim();
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
}

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** 表单校验（镜像 Runtime；空数组=通过）。 */
export function validateCustomProviderForm(form: EditorForm): FormErrors {
  const errors: FormErrors = { rows: {} };
  const id = (form.id || '').trim();
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(id)) {
    errors.id = 'Provider ID 需 2~40 位：小写字母开头，只含小写字母、数字、点、下划线或连字符';
  } else if (RESERVED_PROVIDER_IDS.includes(id)) {
    errors.id = `Provider ID 与内置 Provider 冲突（${id}）；请换一个，例如 acme-gateway`;
  }
  const label = (form.label || '').trim();
  if (label.length < 1 || label.length > 60) errors.label = '显示名称需 1~60 个字符';
  if (form.protocol !== 'openai' && form.protocol !== 'anthropic') errors.protocol = 'API 协议只支持 OpenAI Chat Completions 或 Anthropic Messages';
  if (!isAllowedProviderBaseUrl(form.baseUrl)) errors.baseUrl = 'API 地址只接受 HTTPS；本机回环地址（http://127.0.0.1、http://localhost）可用 HTTP，且不能内嵌用户名/密码';

  if (form.models.length < 1) errors.models = '模型目录至少需要 1 个模型';
  else if (form.models.length > 20) errors.models = '模型目录最多 20 个模型，请先删掉多余的模型';

  const seen = new Set<string>();
  form.models.forEach((model, index) => {
    const prefix = `${index}`;
    const modelId = (model.id || '').trim();
    if (!modelId) errors.rows[`${prefix}.id`] = '模型 ID 必填';
    else if (/\s/.test(modelId)) errors.rows[`${prefix}.id`] = '模型 ID 不能包含空白字符';
    else if (modelId.length > 120) errors.rows[`${prefix}.id`] = '模型 ID 不能超过 120 个字符';
    else if (seen.has(modelId)) errors.rows[`${prefix}.id`] = '模型 ID 在同一 Provider 内必须唯一';
    else seen.add(modelId);
    if ((model.label || '').trim().length > 120) errors.rows[`${prefix}.label`] = '显示名称不能超过 120 个字符';
    if (!isInteger(model.contextWindow) || model.contextWindow < 1000 || model.contextWindow > 10000000) {
      errors.rows[`${prefix}.contextWindow`] = '上下文窗口需为 1000~10000000 的整数';
    }
    if (!isInteger(model.maxOutputTokens) || model.maxOutputTokens < 100 || model.maxOutputTokens > 1000000) {
      errors.rows[`${prefix}.maxOutputTokens`] = '最大输出 token 数需为 100~1000000 的整数';
    } else if (!Number.isNaN(model.contextWindow) && model.maxOutputTokens > model.contextWindow) {
      errors.rows[`${prefix}.maxOutputTokens`] = '最大输出 token 数不能超过上下文窗口';
    }
    const inputs = (model.input || []).filter((item) => item === 'text' || item === 'image');
    if (!inputs.includes('text')) errors.rows[`${prefix}.input`] = '输入类型必须包含文本';
  });

  return errors;
}

export function hasFormErrors(errors: FormErrors): boolean {
  return Boolean(errors.id || errors.label || errors.baseUrl || errors.protocol || errors.models || Object.keys(errors.rows).length);
}

/** 把校验结果整理成「哪里不对」的人话清单：一次说清，而不是只弹一句“校验失败”。 */
export function formErrorList(errors: FormErrors): string[] {
  const list: string[] = [];
  if (errors.id) list.push(`Provider ID：${errors.id}`);
  if (errors.label) list.push(`显示名称：${errors.label}`);
  if (errors.protocol) list.push(`API 协议：${errors.protocol}`);
  if (errors.baseUrl) list.push(`API 地址：${errors.baseUrl}`);
  if (errors.models) list.push(errors.models);
  for (const [key, message] of Object.entries(errors.rows)) {
    const row = Number(key.split('.')[0]);
    list.push(`第 ${row + 1} 个模型：${message}`);
  }
  return list;
}

export interface CustomProviderEditorProps {
  /** Runtime 上报的注册表 Provider 摘要（editable === true）。 */
  providers: ProviderSummary[];
  /** 当前生效的 Provider，用于在列表里标出“当前”。 */
  currentProvider: string;
  /**
   * 上次编辑的 Provider id。页签条件渲染会卸载本组件，重建时用它恢复选中项，
   * 避免用户从「平台 Provider」切回来看到空白表单。
   */
  initialProviderId?: string | null;
  /** 选中项变化时通知设置页保存下来（只用于重建恢复，不影响 Runtime）。 */
  onEditChange?: (id: string | null) => void;
  /** 重新拉取 /api/providers，让设置页与下拉框看到最新摘要。 */
  onRefresh: () => Promise<void>;
  /** 设为当前 Provider：设置页负责把 baseUrl 置空、模型取目录首项。 */
  onSetProvider: (id: string, model: string) => void;
  /** 删除后如果删的正是当前 Provider，设置页需要回退到安全默认值。 */
  onRemoved: (id: string) => void;
}

export function CustomProviderEditor({ providers, currentProvider, initialProviderId, onEditChange, onRefresh, onSetProvider, onRemoved }: CustomProviderEditorProps) {
  const { state, notify, addAudit } = useApp();
  const restored = initialProviderId ? providers.find((item) => String(item.id) === initialProviderId) : undefined;
  const [form, setForm] = useState<EditorForm>(() => restored ? formFromSummary(restored) : newForm());
  const [selectedId, setSelectedId] = useState<string | null>(() => restored ? String(restored.id) : null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<FormErrors>({ rows: {} });
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const selectedSummary = useMemo(() => providers.find((item) => String(item.id) === selectedId), [providers, selectedId]);
  const explain = (error: unknown) => error instanceof RuntimeApiError ? `${error.code} · ${error.message}` : error instanceof Error ? error.message : '未知错误';

  // Provider 被删除（或 Runtime 换成新注册表）后，编辑区不能继续指向一个不存在的 id。
  useEffect(() => {
    if (selectedId && !providers.some((item) => String(item.id) === selectedId)) setSelectedId(null);
  }, [providers, selectedId]);

  const patchForm = (patch: Partial<EditorForm>) => setForm((current) => ({ ...current, ...patch }));

  /** 校验失败时把用户带到第一个要改的输入框：否则错误提示可能在视口外，看起来就像“点了没反应”。 */
  const focusFirstError = () => {
    const run = () => {
      const element = document.querySelector<HTMLElement>('.custom-provider-form .field--error input, .custom-provider-form .field--error select, .custom-provider-form .model-row input');
      if (!element) return;
      try { element.scrollIntoView?.({ block: 'center' }); } catch { /* jsdom/老浏览器没有 scrollIntoView */ }
      element.focus?.();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else run();
  };
  const patchModel = (index: number, patch: Partial<CustomModelConfig>) => setForm((current) => ({
    ...current,
    models: current.models.map((model, position) => position === index ? { ...model, ...patch } : model),
  }));

  const startCreate = () => {
    setSelectedId(null); setForm(newForm()); setErrors({ rows: {} }); setApiKey(''); setTestResult(null); setProbeNote(null); onEditChange?.(null);
  };

  const selectSummary = (summary: ProviderSummary) => {
    setSelectedId(String(summary.id)); setForm(formFromSummary(summary)); setErrors({ rows: {} }); setApiKey(''); setTestResult(null); setProbeNote(null); onEditChange?.(String(summary.id));
  };

  const normalizeModels = (models: CustomModelConfig[]): CustomModelConfig[] => models.map((model) => ({
    id: model.id.trim(),
    ...(model.label && model.label.trim() ? { label: model.label.trim() } : {}),
    contextWindow: Number(model.contextWindow),
    maxOutputTokens: Number(model.maxOutputTokens),
    input: model.input.includes('image') ? ['text', 'image'] as Array<'text' | 'image'> : ['text'] as Array<'text' | 'image'>,
    reasoning: Boolean(model.reasoning),
  }));

  /** 保存（不通知），供保存/获取模型/设为当前复用。失败返回 null。 */
  const persist = async (): Promise<CustomProviderConfig | null> => {
    const id = form.id.trim();
    // 显示名称留空时用 Provider ID 兜底：少一个必填项，保存链路不容易因“灰字看着像已填”卡住。
    const effective = { ...form, id, label: form.label.trim() ? form.label : id };
    const nextErrors = validateCustomProviderForm(effective);
    setErrors(nextErrors);
    if (hasFormErrors(nextErrors)) {
      const list = formErrorList(nextErrors);
      notify('配置未通过校验', list[0] || '请检查必填项', 'warning');
      focusFirstError();
      return null;
    }
    setBusy('save');
    try {
      const saved = await runtimeClient.saveCustomProvider(id, { label: effective.label.trim(), protocol: form.protocol, baseUrl: form.baseUrl.trim(), models: normalizeModels(form.models) });
      setSelectedId(saved.id); onEditChange?.(saved.id);
      // Runtime 会归一化（去空白、裁剪输入类型）；用返回值覆盖表单，避免界面与落盘不一致。
      setErrors({ rows: {} });
      setForm(formFromSummary(summaryFromConfig({ ...saved, label: saved.label || effective.label.trim(), protocol: saved.protocol || form.protocol, baseUrl: saved.baseUrl || form.baseUrl.trim(), models: saved.models?.length ? saved.models : normalizeModels(form.models) })));
      addAudit('settings', '保存自定义模型 Provider', `${saved.id} · ${form.protocol} · ${form.models.length} 个模型`, 'success');
      await onRefresh();
      return saved;
    } catch (error) {
      const detail = explain(error);
      addAudit('settings', '自定义模型 Provider 保存失败', `${form.id || '(未命名)'} · ${detail}`, 'error');
      notify('保存失败', detail, 'danger');
      return null;
    } finally { setBusy(null); }
  };

  const save = async () => {
    const saved = await persist();
    if (!saved) return;
    let keyNote = '';
    const key = apiKey.trim();
    if (key) {
      setBusy('key');
      try {
        const result = await runtimeClient.storeKey(saved.id, key);
        setApiKey('');
        keyNote = ` · 凭据已写入钥匙串 ${result.credential.hint}`;
        await onRefresh();
      } catch (error) {
        const detail = explain(error);
        setApiKey('');
        addAudit('settings', '自定义模型 Provider 凭据保存失败', `${saved.id} · ${detail}`, 'error');
        notify('配置已保存，但凭据写入失败', detail, 'danger');
        return;
      } finally { setBusy(null); }
    }
    notify('自定义模型 Provider 已保存', `${saved.id}${keyNote} · 点「设为当前 Provider」即可在 AI 任务里使用。`, 'success');
  };

  /** 只写钥匙串（不重复提交配置）。 */
  const saveKeyOnly = async () => {
    const id = form.id.trim();
    if (!selectedId || selectedId !== id) return notify('请先保存配置', '先点「保存配置」把 Provider 写进 Runtime，再单独保存 API 密钥。', 'warning');
    if (!apiKey.trim()) return notify('请输入 API 密钥', '密钥只会发送到本机 Runtime 并写入 macOS 钥匙串。', 'warning');
    setBusy('key');
    try {
      const result = await runtimeClient.storeKey(selectedId, apiKey.trim());
      setApiKey('');
      addAudit('settings', '保存自定义 Provider 凭据', `${selectedId} · ${result.credential.hint}`, 'success');
      notify('凭据已安全保存', `已写入 macOS 钥匙串 ${result.credential.hint}，页面与日志中都不保存完整 Key。`, 'success');
      await onRefresh();
    } catch (error) {
      setApiKey('');
      const detail = explain(error);
      notify('保存失败', detail, 'danger');
    } finally { setBusy(null); }
  };

  const removeKey = async () => {
    if (!selectedId) return;
    setBusy('remove');
    try {
      await runtimeClient.removeKey(selectedId);
      addAudit('settings', '撤销自定义 Provider 凭据', selectedId, 'warning');
      notify('凭据已撤销', '该 Provider 的钥匙串条目已删除，其它 Provider 不受影响。', 'warning');
      await onRefresh();
    } catch (error) { notify('撤销失败', explain(error), 'danger'); }
    finally { setBusy(null); }
  };

  const probe = async () => {
    const saved = await persist();
    if (!saved) return;
    setBusy('probe');
    try {
      const probed = await runtimeClient.probeCustomProviderModels(saved.id);
      const existing = new Set(form.models.map((model) => (model.id || '').trim()).filter(Boolean));
      const additions: CustomModelConfig[] = [];
      for (const item of probed) {
        const id = (item.id || '').trim();
        if (!id || existing.has(id)) continue;
        existing.add(id);
        additions.push({ id, ...(item.label ? { label: item.label } : {}), contextWindow: typeof item.contextWindow === 'number' && item.contextWindow >= 1000 ? item.contextWindow : MODEL_DEFAULTS.contextWindow, maxOutputTokens: MODEL_DEFAULTS.maxOutputTokens, input: ['text'], reasoning: false });
      }
      // 探测到的模型只做增量合并：已存在的不覆盖用户手填的窗口/输入类型。
      const baseModels = form.models.filter((model) => (model.id || '').trim());
      const nextModels = [...baseModels, ...additions].slice(0, 20);
      setForm((current) => ({ ...current, models: nextModels.length ? nextModels : current.models }));
      setProbeNote(`可见 ${probed.length} 个模型，新增 ${additions.length} 个（已存在的不覆盖）；缺省值 contextWindow ${MODEL_DEFAULTS.contextWindow} / maxOutputTokens ${MODEL_DEFAULTS.maxOutputTokens} / 仅文本，请按需修正后再次保存`);
      addAudit('settings', '获取自定义 Provider 可用模型', `${saved.id} · 可见 ${probed.length} 个 · 新增 ${additions.length} 个`, 'success');
      notify('已获取可用模型', `可见 ${probed.length} 个模型，新增 ${additions.length} 个；确认上下文窗口后请再点「保存配置」。`, 'success');
    } catch (error) {
      const detail = explain(error);
      // 未存 Key 或网关不支持 /models 是常见情况：给可操作提示而不是空转。
      notify('获取可用模型失败', detail, 'danger');
    } finally { setBusy(null); }
  };

  const test = async () => {
    if (!selectedId || selectedId !== form.id.trim()) return notify('请先保存配置', '测试连接使用 Runtime 注册表里的配置与钥匙串凭据。', 'warning');
    setBusy('test'); setTestResult(null);
    try {
      const result = await runtimeClient.testProvider(selectedId);
      if (result.ready === false || result.ok === false) {
        setTestResult({ ok: false, text: result.status || 'Provider 尚未认证' });
        notify('Provider 连接失败', result.status || 'Runtime 报告未就绪', 'warning');
        return;
      }
      const visible = result.models?.length || 0;
      setTestResult({ ok: true, text: visible ? `连接成功 · 可见 ${visible} 个模型` : result.status || '认证状态有效' });
      addAudit('settings', '测试自定义 Provider 连接', selectedId, 'success');
      notify('Provider 连接通过', `可见 ${visible} 个模型`, 'success');
    } catch (error) {
      const detail = explain(error);
      setTestResult({ ok: false, text: detail });
      addAudit('settings', '自定义 Provider 连接失败', `${form.id} · ${detail}`, 'error');
      notify('Provider 连接失败', detail, 'danger');
    } finally { setBusy(null); }
  };

  const setAsCurrent = async () => {
    const saved = await persist();
    if (!saved) return;
    const model = saved.models?.[0]?.id || form.models[0]?.id;
    if (!model) return notify('模型目录为空', '至少保存 1 个模型才能设为当前 Provider。', 'warning');
    onSetProvider(saved.id, model);
    addAudit('settings', '设为当前 Provider', `${saved.id} · ${model}`, 'success');
    notify('已设为当前 Provider', `${saved.id} · 模型 ${model}；baseUrl 已置空，由 Runtime 按注册表解析。`, 'success');
  };

  const remove = async () => {
    if (!selectedId) return;
    setBusy('delete');
    try {
      await runtimeClient.deleteCustomProvider(selectedId);
      addAudit('settings', '删除自定义模型 Provider', selectedId, 'warning');
      notify('已删除该自定义模型', `${selectedId} 的配置与钥匙串条目都已删除。`, 'warning');
      onRemoved(selectedId);
      setSelectedId(null); setForm(newForm()); setApiKey(''); setTestResult(null); setProbeNote(null); onEditChange?.(null);
      await onRefresh();
    } catch (error) { notify('删除失败', explain(error), 'danger'); }
    finally { setBusy(null); setConfirmOpen(false); }
  };

  const rowError = (index: number, field: string) => errors.rows[`${index}.${field}`];
  const isCurrent = Boolean(selectedId) && selectedId === String(currentProvider);

  return (
    <div className="custom-provider-editor">
      {!state.runtime.reachable && <div className="inline-alert inline-alert--warning"><TriangleAlert size={16} /><span>本机 Runtime 不可达：可以先把表单填好，但保存、测试连接与获取模型都需要先运行 npm run dev:full。</span></div>}

      <div className="custom-provider-list">
        <div className="custom-provider-list__head">
          <span className="standalone-label">已定义 Provider（{providers.length}）</span>
          <Button size="sm" icon={<Plus size={14} />} onClick={startCreate}>新建</Button>
        </div>
        {providers.length ? (
          <div className="custom-provider-list__items">
            {providers.map((item) => {
              const active = String(item.id) === selectedId;
              return (
                <button type="button" key={String(item.id)} className={`custom-provider-item ${active ? 'is-active' : ''}`} aria-pressed={active} onClick={() => selectSummary(item)}>
                  <Server size={14} aria-hidden />
                  <span className="custom-provider-item__copy">
                    <strong>{item.label || String(item.id)}</strong>
                    <small>{String(item.id)} · {item.models?.length || 0} 个模型 · {item.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions'}</small>
                  </span>
                  <Badge tone={item.ready ? 'success' : 'warning'}>{item.ready ? 'READY' : 'SETUP'}</Badge>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="empty-inline"><Server size={20} /><strong>还没有自定义 Provider</strong><span>填下面的表单 → 「保存配置」，即可在「平台 Provider」页签里选中它。</span></div>
        )}
      </div>

      <div className="custom-provider-form form-grid">
        <div className="custom-provider-grid">
          <Field label="Provider ID" required error={errors.id} hint="2~40 位小写字母开头，可含数字、点、下划线或连字符；不能与内置 Provider 重名。保存后作为请求里的 provider 字段。">
            <input className="input" value={form.id} onChange={(event) => patchForm({ id: event.target.value })} placeholder="例如：acme-gateway" spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="显示名称" error={errors.label} hint="1~60 个字符，显示在 Provider 下拉与 AI 任务页；留空默认使用 Provider ID。">
            <input className="input" value={form.label} onChange={(event) => patchForm({ label: event.target.value })} placeholder="例如：Acme 网关" />
          </Field>
          <Field label="API 地址" required error={errors.baseUrl} hint="只接受 HTTPS；本机回环地址可用 HTTP。Runtime 会请求 {API 地址}/chat/completions（OpenAI）或 {API 地址}/messages（Anthropic）。">
            <input className="input" value={form.baseUrl} onChange={(event) => patchForm({ baseUrl: event.target.value })} placeholder="例如：https://gateway.example.com/v1" spellCheck={false} autoComplete="off" />
          </Field>
          <SelectField label="API 协议" value={form.protocol} onChange={(event) => patchForm({ protocol: event.target.value === 'anthropic' ? 'anthropic' : 'openai' })} hint="OpenAI Chat Completions 走 /chat/completions；Anthropic Messages 走 /messages（x-api-key + anthropic-version）。">
            <option value="openai">OpenAI Chat Completions</option>
            <option value="anthropic">Anthropic Messages</option>
          </SelectField>
          <Field label="API 密钥" hint="只写入 macOS 钥匙串中该 Provider 的独立条目（切 Key 互不影响），输入框保存后立即清空，不进入日志或 LocalStorage。">
            <input className="input" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴 Key 后点「安全保存」或「保存配置」" />
          </Field>
        </div>
        {hasFormErrors(errors) && <div className="inline-alert inline-alert--danger" role="alert"><TriangleAlert size={16} /><span>还有 {formErrorList(errors).length} 项需要修正：{formErrorList(errors).join('；')}</span></div>}
        <div className="provider-actions">
          <Button icon={<KeyRound size={15} />} loading={busy === 'key'} disabled={!apiKey.trim() || !selectedId} title={!selectedId ? '请先保存配置' : !apiKey.trim() ? '请先输入 API 密钥' : undefined} onClick={() => void saveKeyOnly()}>安全保存</Button>
          <Button variant="danger" icon={<Trash2 size={15} />} loading={busy === 'remove'} disabled={!selectedId || !selectedSummary?.configured} onClick={() => void removeKey()}>撤销 Key</Button>
        </div>

        <div className="model-catalog">
          <div className="model-catalog__head">
            <span className="standalone-label">模型目录<small>（{form.models.length}/20）</small></span>
            <div className="row-actions">
              <Button size="sm" icon={<RefreshCw size={14} />} loading={busy === 'probe'} onClick={() => void probe()}>获取可用模型</Button>
              <Button size="sm" icon={<Plus size={14} />} disabled={form.models.length >= 20} onClick={() => setForm((current) => ({ ...current, models: [...current.models, emptyModel()] }))}>添加模型</Button>
            </div>
          </div>
          {errors.models && <div className="inline-alert inline-alert--warning"><TriangleAlert size={16} /><span>{errors.models}</span></div>}
          {probeNote && <div className="inline-alert inline-alert--info"><CheckCircle2 size={16} /><span>{probeNote}</span></div>}
          <div className="model-catalog__grid" role="group" aria-label="模型目录">
            <div className="model-catalog__columns" aria-hidden>
              <span>模型 ID</span><span>显示名称</span><span>上下文窗口</span><span>最大输出 token 数</span><span>输入类型</span><span>推理等级</span><span>操作</span>
            </div>
            {form.models.map((model, index) => (
              <div className="model-row" key={index}>
                <div className="model-row__cell">
                  <input className="input" aria-label={`模型 ${index + 1} 模型 ID`} value={model.id} placeholder="例如：gpt-5.6-sol" spellCheck={false} onChange={(event) => patchModel(index, { id: event.target.value })} />
                  {rowError(index, 'id') && <small className="model-row__error">{rowError(index, 'id')}</small>}
                </div>
                <div className="model-row__cell">
                  <input className="input" aria-label={`模型 ${index + 1} 显示名称`} value={model.label || ''} placeholder="例如：GPT-5.6 Sol" onChange={(event) => patchModel(index, { label: event.target.value })} />
                  {rowError(index, 'label') && <small className="model-row__error">{rowError(index, 'label')}</small>}
                </div>
                <div className="model-row__cell">
                  <input className="input" type="number" min={1000} max={10000000} step={1000} aria-label={`模型 ${index + 1} 上下文窗口`} value={model.contextWindow} onChange={(event) => patchModel(index, { contextWindow: Number(event.target.value) })} />
                  {rowError(index, 'contextWindow') && <small className="model-row__error">{rowError(index, 'contextWindow')}</small>}
                </div>
                <div className="model-row__cell">
                  <input className="input" type="number" min={100} max={1000000} step={100} aria-label={`模型 ${index + 1} 最大输出 token 数`} value={model.maxOutputTokens} onChange={(event) => patchModel(index, { maxOutputTokens: Number(event.target.value) })} />
                  {rowError(index, 'maxOutputTokens') && <small className="model-row__error">{rowError(index, 'maxOutputTokens')}</small>}
                </div>
                <div className="model-row__cell">
                  <span className="model-row__checks">
                    <span className="model-check"><input type="checkbox" checked readOnly disabled aria-label={`模型 ${index + 1} 输入类型 文本`} /><span>文本</span></span>
                    <span className="model-check"><input type="checkbox" checked={model.input.includes('image')} aria-label={`模型 ${index + 1} 输入类型 图片`} onChange={(event) => patchModel(index, { input: event.target.checked ? ['text', 'image'] : ['text'] })} /><span>图片</span></span>
                  </span>
                  {rowError(index, 'input') && <small className="model-row__error">{rowError(index, 'input')}</small>}
                </div>
                <div className="model-row__cell model-row__cell--switch">
                  <Toggle checked={model.reasoning} onChange={(reasoning) => patchModel(index, { reasoning })} label="推理等级" description={model.id || `第 ${index + 1} 个模型`} />
                </div>
                <div className="model-row__cell model-row__cell--actions">
                  <IconButton label={`删除第 ${index + 1} 个模型`} disabled={form.models.length <= 1} onClick={() => setForm((current) => ({ ...current, models: current.models.filter((_, position) => position !== index) }))}><Trash2 size={14} /></IconButton>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="provider-actions custom-provider-actions">
          <Button variant="primary" icon={<Save size={15} />} loading={busy === 'save'} onClick={() => void save()}>保存配置</Button>
          <Button icon={<TestTube2 size={15} />} loading={busy === 'test'} disabled={!selectedId || selectedId !== form.id.trim()} title={!selectedId || selectedId !== form.id.trim() ? '请先保存配置' : undefined} onClick={() => void test()}>测试连接</Button>
          <Button icon={<Star size={15} />} disabled={!state.runtime.reachable} onClick={() => void setAsCurrent()} title={!state.runtime.reachable ? '请先启动本机Runtime' : undefined}>设为当前 Provider</Button>
          <Button variant="danger" icon={<Trash2 size={15} />} loading={busy === 'delete'} disabled={!selectedId} onClick={() => setConfirmOpen(true)}>删除该自定义模型</Button>
        </div>
        {isCurrent && <div className="inline-alert inline-alert--success"><CheckCircle2 size={16} /><span>该 Provider 当前正被 AI 任务使用；在「平台 Provider」页签里可以看到它的模型目录摘要。</span></div>}
        {testResult && <div className={`provider-test ${testResult.ok ? '' : 'provider-test--error'}`}><TriangleAlert size={15} /><span>{testResult.text}</span></div>}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void remove()}
        title="删除该自定义模型？"
        description={`将删除 ${selectedId || ''} 的配置与 macOS 钥匙串条目；已保存的 AI 任务设置如果仍指向它，需要改选其它 Provider。`}
        confirmLabel="确认删除"
        danger
      />
    </div>
  );
}
