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
  openai_api: { id: 'openai_api', label: 'OpenAI API', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.openai.com/v1/models', keyUrl: 'https://platform.openai.com/api-keys' },
  anthropic_api: { id: 'anthropic_api', label: 'Anthropic API', kind: 'api', auth: 'x-api-key', modelsUrl: 'https://api.anthropic.com/v1/models', headers: { 'anthropic-version': '2023-06-01' }, keyUrl: 'https://console.anthropic.com/settings/keys' },
  deepseek_api: { id: 'deepseek_api', label: 'DeepSeek 开放平台', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.deepseek.com/v1/models', keyUrl: 'https://platform.deepseek.com/api_keys' },
  moonshot_api: { id: 'moonshot_api', label: 'Moonshot / Kimi', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.moonshot.cn/v1/models', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  zhipu_api: { id: 'zhipu_api', label: '智谱 AI（GLM）', kind: 'api', auth: 'bearer', modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  dashscope_api: { id: 'dashscope_api', label: '阿里云百炼（通义千问）', kind: 'api', auth: 'bearer', modelsUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models', keyUrl: 'https://bailian.console.aliyun.com/' },
  siliconflow_api: { id: 'siliconflow_api', label: '硅基流动 SiliconFlow', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.siliconflow.cn/v1/models', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  openrouter_api: { id: 'openrouter_api', label: 'OpenRouter', kind: 'api', auth: 'bearer', modelsUrl: 'https://openrouter.ai/api/v1/models', keyUrl: 'https://openrouter.ai/keys' },
  gemini_api: { id: 'gemini_api', label: 'Google Gemini', kind: 'api', auth: 'x-goog-api-key', modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models', keyUrl: 'https://aistudio.google.com/apikey' },
  xai_api: { id: 'xai_api', label: 'xAI Grok', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.x.ai/v1/models', keyUrl: 'https://console.x.ai/' },
  groq_api: { id: 'groq_api', label: 'Groq', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.groq.com/openai/v1/models', keyUrl: 'https://console.groq.com/keys' },
  mistral_api: { id: 'mistral_api', label: 'Mistral AI', kind: 'api', auth: 'bearer', modelsUrl: 'https://api.mistral.ai/v1/models', keyUrl: 'https://console.mistral.ai/api-keys' },
};

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
  return { id, label: provider.label, kind: provider.kind, configured, ready: configured, ...(provider.keyUrl ? { keyUrl: provider.keyUrl } : {}) };
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

export async function testProvider(id, keychain) {
  const provider = PROVIDERS[id];
  if (!provider) throw Object.assign(new Error('未知Provider'), { code: 'PROVIDER_UNKNOWN' });
  if (provider.kind === 'cli') return cliStatus(id);
  const key = await keychain.read(id);
  return requestModels(provider.modelsUrl, authHeaders(provider, key));
}
