import { findExecutable, runProcess, startObserved } from './process.mjs';

/**
 * Provider 目录：官方账号（CLI 登录）与第三方平台 API Key 共用一张声明式表。
 * API 型只需要声明模型列表地址与鉴权方式，新增平台不必改 server.mjs、不改前端路由逻辑，
 * 也不再需要为每个平台写一段 if 分支。鉴权值只有三种，全部由 authHeaders 统一生成，
 * 保证 Key 只出现在请求头里，不会进入 URL、日志或错误信息。
 */
export const PROVIDERS = {
  codex_account: { id: 'codex_account', label: 'Codex账号', kind: 'cli', cli: 'codex' },
  claude_account: { id: 'claude_account', label: 'Claude Code（个人本机）', kind: 'cli', cli: 'claude', personalOnly: true },
  openai_api: { id: 'openai_api', label: 'OpenAI API', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.openai.com/v1/models', chatBaseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  anthropic_api: { id: 'anthropic_api', label: 'Anthropic API', kind: 'api', auth: 'x-api-key', modelsUrl: 'https://api.anthropic.com/v1/models', headers: { 'anthropic-version': '2023-06-01' }, keyUrl: 'https://console.anthropic.com/settings/keys' },
  deepseek_api: { id: 'deepseek_api', label: 'DeepSeek 开放平台', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.deepseek.com/v1/models', chatBaseUrl: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys', chatModel: 'deepseek-chat' },
  moonshot_api: { id: 'moonshot_api', label: 'Moonshot / Kimi', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.moonshot.cn/v1/models', chatBaseUrl: 'https://api.moonshot.cn/v1', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  zhipu_api: { id: 'zhipu_api', label: '智谱 AI（GLM）', kind: 'api', auth: 'bearer', modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models', chatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  dashscope_api: { id: 'dashscope_api', label: '阿里云百炼（通义千问）', kind: 'api', auth: 'bearer', modelsUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models', chatBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://bailian.console.aliyun.com/', chatModel: 'deepseek-v3' },
  siliconflow_api: { id: 'siliconflow_api', label: '硅基流动 SiliconFlow', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.siliconflow.cn/v1/models', chatBaseUrl: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak', chatModel: 'deepseek-ai/DeepSeek-V3' },
  openrouter_api: { id: 'openrouter_api', label: 'OpenRouter', kind: 'api', auth: 'bearer', modelsUrl: 'https://openrouter.ai/api/v1/models', chatBaseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', chatModel: 'deepseek/deepseek-chat' },
  gemini_api: { id: 'gemini_api', label: 'Google Gemini', kind: 'api', auth: 'x-goog-api-key', modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models', chatBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey' },
  xai_api: { id: 'xai_api', label: 'xAI Grok', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.x.ai/v1/models', chatBaseUrl: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai/' },
  groq_api: { id: 'groq_api', label: 'Groq', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.groq.com/openai/v1/models', chatBaseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  mistral_api: { id: 'mistral_api', label: 'Mistral AI', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.mistral.ai/v1/models', chatBaseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  ark_api: { id: 'ark_api', label: '火山方舟（DeepSeek）', kind: 'api', auth: 'bearer', modelsUrl: 'https://ark.cn-beijing.volces.com/api/v3/models', chatBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', keyUrl: 'https://console.volcengine.com/ark', chatModel: 'deepseek-v3-250324' },
  qianfan_api: { id: 'qianfan_api', label: '百度智能云千帆（DeepSeek）', kind: 'api', auth: 'bearer', modelsUrl: 'https://qianfan.baidubce.com/v2/models', chatBaseUrl: 'https://qianfan.baidubce.com/v2', keyUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application', chatModel: 'deepseek-v3' },
  // 自定义 API：URL 由用户在设置里填写（请求级覆盖），没有固定 endpoint，也没有平台控制台。
  custom_api: { id: 'custom_api', label: '自定义 API（OpenAI 兼容）', kind: 'api', auth: 'bearer', custom: true },
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * 解析并校验“第三方供应商平台”的 OpenAI 兼容 Base URL。
 * 允许用户把 DeepSeek 模型指向任意厂商网关（火山方舟、千帆、企业自建代理等），
 * 但只接受 HTTPS，或本机回环地址上的 HTTP（本地网关/代理）；不允许 URL 内嵌凭据。
 */
export function normalizeBaseUrl(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw Object.assign(new Error('Base URL 不是合法地址'), { code: 'PROVIDER_BASE_URL_INVALID' }); }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.username || url.password) throw Object.assign(new Error('Base URL 不能内嵌用户名或密码'), { code: 'PROVIDER_BASE_URL_INVALID' });
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw Object.assign(new Error('第三方平台 Base URL 必须是 HTTPS（本机回环地址可用 HTTP）'), { code: 'PROVIDER_BASE_URL_INVALID' });
  return url.toString().replace(/\/+$/, '');
}

/** 实际使用的 OpenAI 兼容根地址：请求里的覆盖值优先，否则用声明表默认值。 */
export function resolveChatBaseUrl(provider, override) {
  const base = normalizeBaseUrl(override) || provider?.chatBaseUrl || null;
  if (base) return base;
  if (provider?.custom) throw Object.assign(new Error('请先在系统设置填写自定义 API 的 URL（例如 https://api.deepseek.com/v1）'), { code: 'PROVIDER_BASE_URL_REQUIRED' });
  throw Object.assign(new Error('该Provider不支持API对话或未配置Base URL'), { code: 'PROVIDER_CHAT_UNSUPPORTED' });
}

/** 声明顺序即 /api/providers 的返回顺序：官方账号在前，然后是各第三方平台。 */
export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const API_PROVIDER_IDS = PROVIDER_IDS.filter((id) => PROVIDERS[id].kind === 'api');

function summarizeOutput(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

export function authHeaders(provider, key) {
  const headers = { ...(provider.headers || {}) };
  if (provider.auth === 'x-api-key') headers['x-api-key'] = key;
  else if (provider.auth === 'x-goog-api-key') headers['x-goog-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  return headers;
}

export async function cliStatus(id) {
  const provider = PROVIDERS[id];
  const executable = await findExecutable(provider.cli);
  if (!executable) return { id, label: provider.label, kind: provider.kind, installed: false, authenticated: false, ready: false, code: 'CLI_NOT_FOUND' };
  const version = await runProcess(executable, ['--version'], { timeoutMs: 4_000 });
  const args = id === 'codex_account' ? ['login', 'status'] : ['auth', 'status', '--json'];
  const status = await runProcess(executable, args, { timeoutMs: 6_000 });
  const authenticated = status.ok && !/not logged|unauthenticated|logged out/i.test(`${status.stdout} ${status.stderr}`);
  return {
    id,
    label: provider.label,
    kind: provider.kind,
    installed: true,
    authenticated,
    ready: authenticated,
    version: summarizeOutput(version.stdout || version.stderr),
    status: summarizeOutput(status.stdout || status.stderr),
    ...(provider.personalOnly ? { personalOnly: true } : {}),
  };
}

/** API 平台的“已配置”只反映钥匙串里是否存在凭据，不读取、不回传明文。 */
export async function apiStatus(id, keychain) {
  const provider = PROVIDERS[id];
  const configured = await keychain.configured(id);
  return { id, label: provider.label, kind: provider.kind, configured, ready: configured, ...(provider.keyUrl ? { keyUrl: provider.keyUrl } : {}), ...(provider.custom ? { custom: true } : {}) };
}

/**
 * 在系统默认浏览器打开该平台的 Key 管理页。
 *
 * 打包后的 Tauri WebView 不会创建 target="_blank" 新窗口（wry 默认拒绝 new-window 请求），
 * 所以“去平台申请Key”必须走本机 Runtime；Runtime 侧只接受 Provider id，
 * 真正的 URL 来自上面的声明表，调用方无法传入任意地址，因而没有“任意 URL 打开”的滥用面。
 */
export async function openProviderConsole(id, dependencies = {}) {
  const provider = PROVIDERS[id];
  if (!provider || provider.kind !== 'api') throw Object.assign(new Error('该Provider没有平台控制台'), { code: 'CONSOLE_UNSUPPORTED' });
  if (!provider.keyUrl) throw Object.assign(new Error('该Provider未声明控制台地址'), { code: 'CONSOLE_UNKNOWN' });
  const openFn = dependencies.open || ((target) => runProcess('/usr/bin/open', [target], { timeoutMs: 8_000 }));
  const result = await openFn(provider.keyUrl);
  if (result && result.ok === false) throw Object.assign(new Error('无法打开系统浏览器，请手动访问该平台控制台'), { code: 'CONSOLE_OPEN_FAILED' });
  return { provider: id, url: provider.keyUrl, opened: true };
}

export async function providerStatuses(keychain, ids = PROVIDER_IDS) {
  // 允许只查询子集：查“Codex 是否已登录”不需要顺带探测全部第三方平台的钥匙串条目。
  return Promise.all(ids.filter((id) => PROVIDERS[id]).map((id) => (PROVIDERS[id].kind === 'cli' ? cliStatus(id) : apiStatus(id, keychain))));
}

export async function startProviderLogin(id, dependencies = {}) {
  const provider = PROVIDERS[id];
  if (!provider || provider.kind !== 'cli') throw Object.assign(new Error('该Provider不支持账号登录'), { code: 'LOGIN_UNSUPPORTED' });
  const findExecutableFn = dependencies.findExecutable || findExecutable;
  const cliStatusFn = dependencies.cliStatus || cliStatus;
  const startObservedFn = dependencies.startObserved || startObserved;
  const executable = await findExecutableFn(provider.cli);
  if (!executable) throw Object.assign(new Error(`${provider.label} CLI未安装`), { code: 'CLI_NOT_FOUND' });
  const current = await cliStatusFn(id);
  if (current.authenticated) return { state:'already_authenticated', started:false, authenticated:true, status:current.status };
  const args = id === 'codex_account' ? ['login'] : ['auth', 'login'];
  const login = await startObservedFn(executable,args);
  if (login.state === 'failed' || login.state === 'exited') throw Object.assign(new Error(login.detail || '登录进程提前退出'), { code:'LOGIN_PROCESS_EXITED' });
  return { ...login, authenticated:false };
}

/**
 * 模型列表的字段名各平台不同：OpenAI 兼容风格是 data[].id，Google 是 models[].name
 * 且带 models/ 前缀。这里统一归一化，未知结构退化为空数组而不是抛错。
 */
export function modelIds(body, limit = 24) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return list
    .map((item) => (typeof item === 'string' ? item : item?.id || item?.name))
    .filter(Boolean)
    .map((id) => String(id).replace(/^models\//, ''))
    .slice(0, limit);
}

async function requestModels(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'API Key无效或已撤销' : response.status === 429 ? 'API配额或速率受限' : `Provider返回HTTP ${response.status}`);
      error.code = response.status === 401 ? 'PROVIDER_UNAUTHORIZED' : response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR';
      throw error;
    }
    return { ok: true, models: modelIds(body) };
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('Provider连接测试超时'), { code: 'PROVIDER_TIMEOUT' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function testProvider(id, keychain, options = {}) {
  const provider = PROVIDERS[id];
  if (!provider) throw Object.assign(new Error('未知Provider'), { code: 'PROVIDER_UNKNOWN' });
  if (provider.kind === 'cli') return cliStatus(id);
  const key = await keychain.read(id);
  // 允许用户用自己的第三方供应商网关做连接测试；模型列表地址 = Base URL + /models。
  const base = normalizeBaseUrl(options.baseUrl);
  const modelsUrl = base ? `${base}/models` : provider.modelsUrl;
  if (!modelsUrl && provider.custom) throw Object.assign(new Error('请先填写自定义 API 的 URL，再测试连接'), { code: 'PROVIDER_BASE_URL_REQUIRED' });
  if (!modelsUrl) throw Object.assign(new Error('该Provider未声明模型列表地址'), { code: 'PROVIDER_MODELS_UNSUPPORTED' });
  return requestModels(modelsUrl, authHeaders(provider, key));
}
