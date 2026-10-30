import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, STORAGE_KEY } from '../../state/AppContext';
import { SettingsPage } from '../SettingsPage';
import { isAllowedProviderBaseUrl, validateCustomProviderForm } from '../../components/CustomProviderEditor';

/**
 * 自定义模型 API 页签（契约 §4.4）的真实点击链路：jsdom + 假 fetch。
 * 断言的是用户可见结果 + 实际发出去的 HTTP 路由与请求体，不 mock 页面/客户端逻辑。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const token = 'test-token-1234567890';
let container: HTMLDivElement;
let root: Root;

interface RecordedCall { method: string; url: string; body: Record<string, unknown> | null }
let calls: RecordedCall[] = [];
let providers: Array<Record<string, unknown>> = [];

const MODEL = { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 256000, maxOutputTokens: 32000, input: ['text', 'image'], reasoning: false };

const registryProvider = (patch: Record<string, unknown> = {}) => ({
  id: 'acme-gateway',
  label: 'Acme 网关',
  kind: 'api',
  custom: true,
  editable: true,
  protocol: 'openai',
  baseUrl: 'https://gateway.example/v1',
  models: [MODEL],
  configured: false,
  ready: false,
  ...patch,
});

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const installFetch = () => {
  calls = [];
  providers = [registryProvider()];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ method, url, body });
    if (url.endsWith('/api/health')) return json({ ok: true, service: 'circuitpilot-runtime', version: 'test', sessionProof: token });
    if (url.endsWith('/api/diagnostics')) return json({ ok: true, diagnostics: {} });
    if (url.endsWith('/api/providers')) return json({ ok: true, providers });
    if (url.endsWith('/api/project-state')) return json({ ok: true, state: null, savedAt: null });
    if (url.endsWith('/api/trace-state')) return json({ ok: true, state: { versions: [], changes: [], audit: [] }, savedAt: null });
    if (url.endsWith('/api/issue-state')) return json({ ok: true, state: { issues: [] }, savedAt: null });
    const custom = url.match(/\/api\/custom-providers\/([^/]+)(\/models)?$/);
    if (custom) {
      const id = decodeURIComponent(custom[1]);
      if (custom[2] === '/models' && method === 'POST') {
        return json({ ok: true, models: [{ id: 'probe-a', label: 'Probe A', contextWindow: 64000 }, { id: 'probe-b' }] });
      }
      if (method === 'PUT') {
        const saved = { id, label: body?.label, protocol: body?.protocol, baseUrl: body?.baseUrl, models: body?.models, configured: true, ready: true };
        providers = [...providers.filter((item) => item.id !== id), registryProvider(saved)];
        return json({ ok: true, customProvider: saved });
      }
      if (method === 'DELETE') {
        providers = providers.filter((item) => item.id !== id);
        return json({ ok: true, removed: true, credential: { configured: false } });
      }
    }
    const providerRoute = url.match(/\/api\/providers\/([^/]+)\/(test|key)$/);
    if (providerRoute) {
      if (providerRoute[2] === 'test') return json({ ok: true, test: { ready: true, ok: true, models: ['gpt-5.6-sol'], status: 'openai:ok' } });
      return json({ ok: true, credential: { configured: true, hint: '••••1234' } });
    }
    return json({ ok: false, error: { code: 'NOT_MOCKED', message: `unmocked ${method} ${url}` } }, 404);
  }));
};

const flush = async (rounds = 14) => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
};

const buttonByText = (text: string) => Array.from(document.querySelectorAll('button')).find((item) => (item.textContent || '').trim() === text);
const fieldByLabel = (text: string): HTMLInputElement | HTMLSelectElement | null => {
  const labels = Array.from(document.querySelectorAll('label.field'));
  const label = labels.find((item) => (item.querySelector('.field__label')?.textContent || '').replace('*', '').trim() === text);
  return (label?.querySelector('input, select, textarea') as HTMLInputElement | HTMLSelectElement | undefined) || null;
};
const inputByAria = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | null;

/** 受控输入：必须走原生 setter + 原生事件，React 的 onChange 才会收到。 */
const setValue = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};

const click = async (element: Element | undefined | null) => {
  expect(element, '找不到可点击元素').toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
};

const clickCheckbox = async (element: HTMLInputElement | null) => {
  expect(element).toBeTruthy();
  await act(async () => { element?.click(); });
};

const callsTo = (method: string, suffix: string) => calls.filter((item) => item.method === method && item.url.endsWith(suffix));

beforeEach(() => {
  window.localStorage.clear();
  installFetch();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const openCustomTab = async () => {
  await act(async () => { root.render(<AppProvider><SettingsPage /></AppProvider>); });
  await flush();
  await click(buttonByText('自定义模型 API'));
};

describe('设置页 · 自定义模型 API 页签', () => {
  it('默认页签仍是平台 Provider；保存 → 获取模型 → 测试连接 → 设为当前 → 删除 全程走契约路由', async () => {
    await act(async () => { root.render(<AppProvider><SettingsPage /></AppProvider>); });
    await flush();
    // 既有交互不回归：默认页签是平台 Provider，既有 Provider 下拉与字段在场。
    expect(buttonByText('平台 Provider')).toBeTruthy();
    expect(fieldByLabel('Provider')).toBeTruthy();
    expect(fieldByLabel('Provider ID')).toBeFalsy();
    expect(buttonByText('保存设置')).toBeTruthy();

    await click(buttonByText('自定义模型 API'));
    // 编辑器字段与动作都在场（中文 label 与契约一致，便于用户与测试定位）。
    for (const label of ['Provider ID', '显示名称', 'API 地址', 'API 协议', 'API 密钥']) expect(fieldByLabel(label), `${label} 缺失`).toBeTruthy();
    for (const text of ['模型目录', '添加模型', '获取可用模型', '保存配置', '测试连接', '删除该自定义模型', '设为当前 Provider']) expect(buttonByText(text) || container.textContent?.includes(text), `${text} 缺失`).toBeTruthy();
    for (const column of ['模型 ID', '显示名称', '上下文窗口', '最大输出 token 数', '输入类型', '推理等级']) expect(container.textContent).toContain(column);
    expect(container.textContent).toContain('Acme 网关');

    await setValue(fieldByLabel('Provider ID')!, 'acme-gateway');
    await setValue(fieldByLabel('显示名称')!, 'Acme 网关');
    await setValue(fieldByLabel('API 地址')!, 'https://gateway.example/v1');
    await setValue(inputByAria('模型 1 模型 ID')!, 'gpt-5.6-sol');
    await setValue(inputByAria('模型 1 显示名称')!, 'GPT-5.6 Sol');
    await setValue(inputByAria('模型 1 上下文窗口')!, '64000');
    await setValue(inputByAria('模型 1 最大输出 token 数')!, '20000');
    await clickCheckbox(inputByAria('模型 1 输入类型 图片'));

    await click(buttonByText('保存配置'));
    const puts = callsTo('PUT', '/api/custom-providers/acme-gateway');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toMatchObject({ label: 'Acme 网关', protocol: 'openai', baseUrl: 'https://gateway.example/v1' });
    expect((puts[0].body?.models as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 64000, maxOutputTokens: 20000, input: ['text', 'image'], reasoning: false });
    // 密钥字段留空时不得被塞进配置体（Key 只走钥匙串路由）。
    expect(JSON.stringify(puts[0].body)).not.toContain('sk-');

    await click(buttonByText('获取可用模型'));
    const probes = callsTo('POST', '/api/custom-providers/acme-gateway/models');
    expect(probes).toHaveLength(1);
    // 探测结果增量合并进模型目录：已存在的不覆盖，新模型用缺省窗口。
    expect(inputByAria('模型 2 模型 ID')?.value).toBe('probe-a');
    expect(inputByAria('模型 2 上下文窗口')?.value).toBe('64000');
    expect(inputByAria('模型 3 模型 ID')?.value).toBe('probe-b');
    expect(inputByAria('模型 3 上下文窗口')?.value).toBe('128000');
    expect(inputByAria('模型 1 上下文窗口')?.value).toBe('64000');

    await click(buttonByText('测试连接'));
    expect(callsTo('POST', '/api/providers/acme-gateway/test')).toHaveLength(1);
    expect(container.textContent).toContain('连接成功');

    await click(buttonByText('设为当前 Provider'));
    // 切换注册表 Provider：baseUrl 必须置空，模型取目录首项（契约 §4.4）。
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as { settings?: Record<string, unknown> };
    expect(persisted.settings?.provider).toBe('acme-gateway');
    expect(persisted.settings?.baseUrl).toBe('');
    expect(persisted.settings?.model).toBe('gpt-5.6-sol');

    await click(buttonByText('平台 Provider'));
    expect((fieldByLabel('Provider') as HTMLSelectElement).value).toBe('acme-gateway');
    expect((fieldByLabel('模型') as HTMLSelectElement).value).toBe('gpt-5.6-sol');
    // 注册表 Provider 在平台页签隐藏可编辑 Base URL 与 API Key，只在摘要里展示协议/地址/模型数。
    expect(fieldByLabel('API Key')).toBeFalsy();
    expect(fieldByLabel('第三方供应商 Base URL（可选）')).toBeFalsy();
    expect(container.textContent).toContain('OpenAI Chat Completions');
    expect(container.textContent).toContain('3 个模型');

    await click(buttonByText('自定义模型 API'));
    // 切回页签后恢复上次编辑的 Provider（页签条件渲染会卸载编辑器）。
    expect((fieldByLabel('Provider ID') as HTMLInputElement).value).toBe('acme-gateway');
    const listItem = Array.from(document.querySelectorAll('button.custom-provider-item')).find((item) => (item.textContent || '').includes('Acme 网关'));
    await click(listItem);
    await click(buttonByText('删除该自定义模型'));
    expect(buttonByText('确认删除')).toBeTruthy();
    await click(buttonByText('确认删除'));
    const deletes = callsTo('DELETE', '/api/custom-providers/acme-gateway');
    expect(deletes).toHaveLength(1);

    // 删掉的是当前 Provider：设置必须回退到安全默认值，不能继续指向不存在的 id。
    await click(buttonByText('平台 Provider'));
    expect((fieldByLabel('Provider') as HTMLSelectElement).value).toBe('demo');
    const afterDelete = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as { settings?: Record<string, unknown> };
    expect(afterDelete.settings?.provider).toBe('demo');
  });

  it('表单校验就地显示错误（不静默失败），修正后本机回环 HTTP 与 Anthropic 协议可用', async () => {
    await openCustomTab();

    await setValue(fieldByLabel('Provider ID')!, 'Bad ID');
    await setValue(fieldByLabel('API 地址')!, 'ftp://gateway.example/v1');
    await setValue(inputByAria('模型 1 上下文窗口')!, '500');
    await click(buttonByText('保存配置'));

    expect(callsTo('PUT', '/api/custom-providers/acme-gateway')).toHaveLength(0);
    expect(container.textContent).toContain('Provider ID 需 2~40 位');
    // 校验失败不再只弹一句“失败”：字段下方 + 汇总清单都要说清哪里不对。
    expect(container.textContent).toContain('项需要修正');
    expect(container.textContent).toContain('API 地址只接受 HTTPS');
    expect(container.textContent).toContain('模型 ID 必填');
    expect(container.textContent).toContain('上下文窗口需为 1000~10000000 的整数');

    await setValue(fieldByLabel('Provider ID')!, 'acme-gateway');
    await setValue(fieldByLabel('显示名称')!, 'Acme 网关');
    await setValue(fieldByLabel('API 地址')!, 'http://127.0.0.1:8080/v1');
    await setValue(fieldByLabel('API 协议')!, 'anthropic');
    await setValue(inputByAria('模型 1 模型 ID')!, 'local-model');
    await setValue(inputByAria('模型 1 上下文窗口')!, '32000');
    await setValue(inputByAria('模型 1 最大输出 token 数')!, '8000');

    await click(buttonByText('保存配置'));
    const puts = callsTo('PUT', '/api/custom-providers/acme-gateway');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toMatchObject({ protocol: 'anthropic', baseUrl: 'http://127.0.0.1:8080/v1' });
    expect((puts[0].body?.models as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'local-model', contextWindow: 32000, maxOutputTokens: 8000 });
  });

  it('显示名称留空时用 Provider ID 兜底，保存仍然成功（不让必填项挡住建档）', async () => {
    await openCustomTab();
    await setValue(fieldByLabel('Provider ID')!, 'acme-gateway');
    await setValue(fieldByLabel('API 地址')!, 'https://gateway.example.com/v1');
    await setValue(inputByAria('模型 1 模型 ID')!, 'gpt-5.6-sol');
    await click(buttonByText('保存配置'));
    const puts = callsTo('PUT', '/api/custom-providers/acme-gateway');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toMatchObject({ label: 'acme-gateway' });
  });

  it('Runtime 不可达时给出可操作提示，表单仍可填写（不静默失败）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed to fetch'); }));
    await openCustomTab();
    expect(container.textContent).toContain('本机 Runtime 不可达');
    await setValue(fieldByLabel('Provider ID')!, 'acme-gateway');
    await setValue(fieldByLabel('显示名称')!, 'Acme 网关');
    await setValue(fieldByLabel('API 地址')!, 'https://gateway.example/v1');
    await setValue(inputByAria('模型 1 模型 ID')!, 'gpt-5.6-sol');
    // 表单状态保留在界面上，用户不会因为一次失败丢掉刚填的内容。
    expect((fieldByLabel('Provider ID') as HTMLInputElement).value).toBe('acme-gateway');
    await click(buttonByText('保存配置'));
    // 失败必须是可读的错误，而不是静默：toast 走 portal，所以在 document.body 上断言。
    expect(document.body.textContent).toContain('RUNTIME_UNREACHABLE');
    expect((fieldByLabel('Provider ID') as HTMLInputElement).value).toBe('acme-gateway');
  });

  it('校验镜像规则：HTTPS / 本机回环 HTTP / 内嵌凭据与内置 id 冲突', () => {
    expect(isAllowedProviderBaseUrl('https://gateway.example/v1')).toBe(true);
    expect(isAllowedProviderBaseUrl('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isAllowedProviderBaseUrl('http://localhost:8080')).toBe(true);
    expect(isAllowedProviderBaseUrl('http://gateway.example/v1')).toBe(false);
    expect(isAllowedProviderBaseUrl('https://user:pass@gateway.example/v1')).toBe(false);
    expect(isAllowedProviderBaseUrl('ftp://gateway.example/v1')).toBe(false);

    const errors = validateCustomProviderForm({
      id: 'custom_api',
      label: ' x ',
      protocol: 'openai',
      baseUrl: 'https://gateway.example/v1',
      models: [{ id: 'm1', contextWindow: 1000, maxOutputTokens: 2000, input: ['text'] as Array<'text' | 'image'>, reasoning: false }],
    });
    expect(errors.id).toContain('内置 Provider');
    expect(errors.rows['0.maxOutputTokens']).toBe('最大输出 token 数不能超过上下文窗口');
    expect(errors.models).toBeUndefined();
  });
});
