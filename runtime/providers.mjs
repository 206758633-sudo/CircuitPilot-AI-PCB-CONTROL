import { findExecutable, runProcess, startObserved } from './process.mjs';

export const PROVIDERS = {
  codex_account: { id: 'codex_account', label: 'Codex账号', kind: 'cli', cli: 'codex' },
  openai_api: { id: 'openai_api', label: 'OpenAI API', kind: 'api' },
  claude_account: { id: 'claude_account', label: 'Claude Code（个人本机）', kind: 'cli', cli: 'claude', personalOnly: true },
  anthropic_api: { id: 'anthropic_api', label: 'Anthropic API', kind: 'api' },
};

function summarizeOutput(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
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

export async function providerStatuses(keychain) {
  const [codex, claude, openaiConfigured, anthropicConfigured] = await Promise.all([
    cliStatus('codex_account'),
    cliStatus('claude_account'),
    keychain.configured('openai_api'),
    keychain.configured('anthropic_api'),
  ]);
  return [
    codex,
    { id: 'openai_api', label: PROVIDERS.openai_api.label, kind: 'api', configured: openaiConfigured, ready: openaiConfigured },
    claude,
    { id: 'anthropic_api', label: PROVIDERS.anthropic_api.label, kind: 'api', configured: anthropicConfigured, ready: anthropicConfigured },
  ];
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
    return { ok: true, models: Array.isArray(body.data) ? body.data.slice(0, 12).map((item) => item.id).filter(Boolean) : [] };
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('Provider连接测试超时'), { code: 'PROVIDER_TIMEOUT' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function testProvider(id, keychain) {
  if (id === 'codex_account' || id === 'claude_account') return cliStatus(id);
  if (id === 'openai_api') {
    const key = await keychain.read(id);
    return requestModels('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` });
  }
  if (id === 'anthropic_api') {
    const key = await keychain.read(id);
    return requestModels('https://api.anthropic.com/v1/models', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
  }
  throw Object.assign(new Error('未知Provider'), { code: 'PROVIDER_UNKNOWN' });
}
