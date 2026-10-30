import type { ProviderId, ProviderSummary } from '../types';

/**
 * Provider 目录（前端单一口径）。
 *
 * 这里只描述“界面上怎么呈现与分组”，真正的能力（endpoint、鉴权方式、钥匙串服务名）
 * 仍然由 runtime/providers.mjs + runtime/config.mjs 决定。两边用同一个 ProviderId 对齐，
 * 因此新增第三方平台时：runtime 加一行 + 这里加一条 + config.mjs 加一个钥匙串服务名。
 */
export type ProviderKind = 'demo' | 'cli' | 'api';

export interface ProviderCatalogEntry {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  group: ProviderGroup;
  /** 认证方式与适用边界，显示在 Provider 选择框下方。 */
  summary: string;
  /** API Key 申请入口；只有 API 型平台有值。 */
  keyUrl?: string;
  /** 模型下拉建议；'auto' 由界面统一追加，不需要写在这里。 */
  models: string[];
  /** 平台默认的 OpenAI 兼容 Base URL；用户可在设置里覆盖成第三方供应商网关。 */
  defaultBaseUrl?: string;
  /** Runtime 声明这是自定义槽（内置 custom_api 或注册表 Provider）。 */
  custom?: boolean;
  /** 注册表里的自定义 Provider：可在「自定义模型 API」页签编辑（内置 custom_api 为 false）。 */
  editable?: boolean;
}

export type ProviderGroup = '本地与官方账号' | '国内平台 API' | '国际平台 API' | '自定义 API';

export const PROVIDER_GROUP_ORDER: ProviderGroup[] = ['本地与官方账号', '国内平台 API', '国际平台 API', '自定义 API'];

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'demo',
    label: 'Demo 本地模拟',
    kind: 'demo',
    group: '本地与官方账号',
    summary: '不联网、不消耗配额，用于安全体验完整界面流程。',
    models: [],
  },
  {
    id: 'codex_account',
    label: 'Codex 账号（官方登录）',
    kind: 'cli',
    group: '本地与官方账号',
    summary: '复用本机 Codex CLI 的 ChatGPT 登录态，凭据不出本机。',
    models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
  },
  {
    id: 'claude_account',
    label: 'Claude Code 个人账号',
    kind: 'cli',
    group: '本地与官方账号',
    summary: '复用本机 Claude Code CLI 登录态，仅限个人工作流，产品分发请用 Anthropic API。',
    models: ['claude-sonnet', 'claude-opus'],
  },
  {
    id: 'deepseek_api',
    label: 'DeepSeek 开放平台',
    kind: 'api',
    group: '国内平台 API',
    summary: 'OpenAI 兼容接口，Key 写入 macOS 钥匙串。',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'moonshot_api',
    label: 'Moonshot / Kimi',
    kind: 'api',
    group: '国内平台 API',
    summary: '月之暗面开放平台，OpenAI 兼容接口。',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'moonshot-v1-32k'],
  },
  {
    id: 'zhipu_api',
    label: '智谱 AI（GLM）',
    kind: 'api',
    group: '国内平台 API',
    summary: '智谱开放平台，GLM 系列模型。',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'],
  },
  {
    id: 'dashscope_api',
    label: '阿里云百炼（通义千问）',
    kind: 'api',
    group: '国内平台 API',
    summary: '阿里云百炼兼容模式接口，通义千问 Qwen 系列。',
    keyUrl: 'https://bailian.console.aliyun.com/',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-max', 'qwen-plus', 'qwen-turbo'],
  },
  {
    id: 'siliconflow_api',
    label: '硅基流动 SiliconFlow',
    kind: 'api',
    group: '国内平台 API',
    summary: '聚合多家开源模型的 OpenAI 兼容网关。',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-32B', 'moonshotai/Kimi-K2-Instruct'],
  },
  {
    id: 'ark_api',
    label: '火山方舟（DeepSeek）',
    kind: 'api',
    group: '国内平台 API',
    summary: '字节火山方舟，托管 DeepSeek 等模型；OpenAI 兼容接口，Base URL 可替换成企业网关。',
    keyUrl: 'https://console.volcengine.com/ark',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['deepseek-v3-250324', 'deepseek-r1-250120', 'deepseek-v3-1-250821'],
  },
  {
    id: 'qianfan_api',
    label: '百度智能云千帆（DeepSeek）',
    kind: 'api',
    group: '国内平台 API',
    summary: '百度千帆托管 DeepSeek 等模型；OpenAI 兼容 v2 接口。',
    keyUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2',
    models: ['deepseek-v3', 'deepseek-r1', 'deepseek-v3.1'],
  },
  {
    id: 'openai_api',
    label: 'OpenAI API Key',
    kind: 'api',
    group: '国际平台 API',
    summary: '官方 API Key 直连 api.openai.com。',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultBaseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
  },
  {
    id: 'anthropic_api',
    label: 'Anthropic API Key',
    kind: 'api',
    group: '国际平台 API',
    summary: '官方 API Key 直连 api.anthropic.com，适合产品分发。',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet', 'claude-opus', 'claude-haiku'],
  },
  {
    id: 'gemini_api',
    label: 'Google Gemini',
    kind: 'api',
    group: '国际平台 API',
    summary: 'Google AI Studio Key，通过 x-goog-api-key 头发送。',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  {
    id: 'openrouter_api',
    label: 'OpenRouter',
    kind: 'api',
    group: '国际平台 API',
    summary: '一个 Key 聚合多家国际模型，OpenAI 兼容接口。',
    keyUrl: 'https://openrouter.ai/keys',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o', 'anthropic/claude-3.7-sonnet', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'],
  },
  {
    id: 'xai_api',
    label: 'xAI Grok',
    kind: 'api',
    group: '国际平台 API',
    summary: 'xAI 官方 Key，Grok 系列模型。',
    keyUrl: 'https://console.x.ai/',
    defaultBaseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
  },
  {
    id: 'groq_api',
    label: 'Groq',
    kind: 'api',
    group: '国际平台 API',
    summary: 'Groq Cloud 推理加速，OpenAI 兼容接口。',
    keyUrl: 'https://console.groq.com/keys',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'],
  },
  {
    id: 'mistral_api',
    label: 'Mistral AI',
    kind: 'api',
    group: '国际平台 API',
    summary: 'Mistral 官方 Key，OpenAI 兼容接口。',
    keyUrl: 'https://console.mistral.ai/api-keys',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest'],
  },
  {
    id: 'custom_api',
    label: '自定义 API（OpenAI 兼容）',
    kind: 'api',
    group: '自定义 API',
    summary: '自己填写 API URL、API Key 和模型名称，接入任意 OpenAI 兼容供应商（如企业网关或第三方 DeepSeek 代理）。URL 只接受 HTTPS，本机回环地址可用 HTTP。',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    custom: true,
  },
];

const BY_ID = new Map<string, ProviderCatalogEntry>(PROVIDER_CATALOG.map((entry) => [entry.id, entry]));

export function providerEntry(id: string): ProviderCatalogEntry | undefined {
  return BY_ID.get(id);
}

export function providerLabel(id: string): string {
  return BY_ID.get(id)?.label || id;
}

export function isApiProvider(id: string): boolean {
  return BY_ID.get(id)?.kind === 'api';
}

export function isAccountProvider(id: string): boolean {
  return BY_ID.get(id)?.kind === 'cli';
}

/**
 * 可选模型：始终包含“自动选择”，再补上该平台建议列表与当前已保存值。
 * 当前值必须保留，否则切换到列表外的模型（例如平台刚发布的新型号）会被静默改掉。
 */
export function modelOptions(id: string, current: string): string[] {
  const suggestions = BY_ID.get(id)?.models || [];
  return ['auto', ...suggestions.filter((item) => item !== 'auto'), ...(current && current !== 'auto' && !suggestions.includes(current) ? [current] : [])];
}

/**
 * 合并 runtime 返回的 Provider 与本地目录。
 * runtime 比前端新（多出一个平台）时也要能选，因此未知 id 会被合成一个条目并归到对应分组，
 * 而不是从下拉框里消失。
 */
export function providerOptions(runtimeProviders: ProviderSummary[] = []): ProviderCatalogEntry[] {
  const merged = PROVIDER_CATALOG.map((entry) => {
    const runtime = runtimeProviders.find((item) => item.id === entry.id);
    return runtime && runtime.label
      ? { ...entry, label: runtime.label, custom: entry.custom || runtime.custom === true, editable: runtime.editable === true }
      : entry;
  });
  const extra = runtimeProviders
    .filter((item) => !BY_ID.has(item.id))
    .map<ProviderCatalogEntry>((item) => ({
      id: item.id as ProviderId,
      label: item.label || item.id,
      kind: item.kind,
      // 注册表自定义 Provider 统一归到「自定义 API」，与内置 custom_api 同组，便于用户找到自己配的网关。
      group: item.custom === true ? '自定义 API' : item.kind === 'cli' ? '本地与官方账号' : '国际平台 API',
      summary: item.custom === true
        ? '由你在「自定义模型 API」页签配置：可编辑协议、地址与模型目录，凭据独立存放在 macOS 钥匙串。'
        : '由 Runtime 提供，前端目录尚未登记该平台。',
      models: (item.models || []).map((model) => model.id).filter(Boolean),
      custom: item.custom === true,
      editable: item.editable === true,
    }));
  return [...merged, ...extra];
}

/**
 * 注册表自定义 Provider 的模型选项：只列模型目录里的 id + 当前值（去重）。
 * 这类 Provider 的模型必须是目录内模型（Runtime 会拒绝目录外模型），因此不追加 'auto'；
 * 没有目录摘要（例如 Runtime 旧版本）时退回平台建议列表。
 */
export function customModelOptions(summary: ProviderSummary | undefined, current: string): string[] {
  const catalogIds = (summary?.models || []).map((model) => model.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (!catalogIds.length) return modelOptions(summary?.id ?? '', current);
  const value = (current || '').trim();
  return Array.from(new Set([...catalogIds, ...(value && value !== 'auto' && !catalogIds.includes(value) ? [value] : [])]));
}


export interface ProviderOptionGroup {
  group: ProviderGroup;
  entries: ProviderCatalogEntry[];
}

/** 按固定分组顺序输出，供 <optgroup> 渲染；空分组会被丢弃。 */
export function groupedProviderOptions(runtimeProviders: ProviderSummary[] = []): ProviderOptionGroup[] {
  const options = providerOptions(runtimeProviders);
  return PROVIDER_GROUP_ORDER
    .map((group) => ({ group, entries: options.filter((entry) => entry.group === group) }))
    .filter((item) => item.entries.length > 0);
}
