/**
 * CircuitPilot Runtime HTTP 客户端（host-independent，不依赖 DSH 包）。
 *
 * 契约见 docs/agent/agent-contract.md §1：
 *  - Agent token 文件：CIRCUITPILOT_AGENT_TOKEN_FILE，默认
 *    ~/Library/Application Support/CircuitPilot/agent-token.json；
 *  - 请求头：x-circuitpilot-agent-token；
 *  - 非 2xx 一律映射成 { ok:false, code, message, nextActions }，不把原始响应体
 *    （可能含敏感内容）整个带回模型；
 *  - token 绝不进入错误 message / nextActions / 日志。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, win32 } from 'node:path';

export const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:4178';
export const AGENT_TOKEN_HEADER = 'x-circuitpilot-agent-token';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Runtime 默认生成的 agent token 文件；按平台与 Runtime 的 appDataDir 保持一致。 */
export function defaultAgentTokenFile({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'CircuitPilot', 'agent-token.json');
  if (platform === 'win32') {
    const winJoin = win32.join;
    const base = typeof env?.APPDATA === 'string' && env.APPDATA.trim() ? env.APPDATA.trim() : winJoin(home, 'AppData', 'Roaming');
    return winJoin(base, 'CircuitPilot', 'agent-token.json');
  }
  const base = typeof env?.XDG_STATE_HOME === 'string' && env.XDG_STATE_HOME.trim() ? env.XDG_STATE_HOME.trim() : join(home, '.local', 'state');
  return join(base, 'circuitpilot', 'agent-token.json');
}

/** 显式配置 > 环境变量 > 默认路径。 */
export function resolveAgentTokenFile(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return resolve(explicit.trim());
  const fromEnv = process.env.CIRCUITPILOT_AGENT_TOKEN_FILE;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return resolve(fromEnv.trim());
  return defaultAgentTokenFile();
}

function tokenError(code, message, nextActions) {
  return Object.assign(new Error(message), { code, nextActions });
}

/** 常见错误码对应的可执行下一步（不泄露 token）。 */
function nextActionsFor(code, status) {
  if (code === 'AGENT_TOKEN_MISSING') {
    return [
      '启动 CircuitPilot（Runtime 启动时会生成 agent token 文件）',
      '确认 CIRCUITPILOT_AGENT_TOKEN_FILE 指向正确的 token 文件（默认 ~/Library/Application Support/CircuitPilot/agent-token.json）',
    ];
  }
  if (code === 'AGENT_TOKEN_INVALID') {
    return [
      'agent token 文件损坏或已被轮换：重启 CircuitPilot 让 Runtime 重新签发',
      '不要手工编辑 token 文件；不要在对话里粘贴 token 内容',
    ];
  }
  if (code === 'RUNTIME_TOKEN_INVALID') {
    return [
      'Runtime 认为 agent token 无效或已轮换：重启 CircuitPilot 重新签发，并确认插件与 Runtime 指向同一个 token 文件',
      '不要手工修改或粘贴 token；不要把 token 发到对话里',
    ];
  }
  if (code === 'AGENT_ROUTE_FORBIDDEN') {
    return [
      'Runtime 的 agent denylist 拒绝了这个路由（签核/订单/设置/写恢复等必须由用户在 UI 操作）',
      '不要绕过或尝试其它路由；请让用户改用 CircuitPilot UI',
    ];
  }
  if (code === 'RUNTIME_TIMEOUT') {
    return [
      '确认 CircuitPilot Runtime 是否卡住（长任务请在 UI 或 cp_job 查看）',
      '超时不代表写操作没生效：不要自动重试写操作，先用 cp_status / cp_job 核对',
    ];
  }
  if (code === 'RUNTIME_UNREACHABLE' || code === 'RUNTIME_NETWORK_ERROR') {
    return [
      '启动 CircuitPilot 应用并确认 Runtime 监听在配置的 runtimeUrl（默认 http://127.0.0.1:4178）',
      '检查插件配置 runtimeUrl 与 agent token 文件是否存在',
    ];
  }
  if (status === 409) {
    return [
      'Runtime 冲突：常见于写暂停、目标漂移、已有写任务占用、审批过期',
      '先用 cp_status 读取写暂停/EDA 状态，不要自动重试写操作',
    ];
  }
  if (status === 403) {
    return [
      '当前 agent token 的 scope 不允许该动作，或 Runtime 拒绝该 agent 路由',
      '请让用户在 CircuitPilot UI 完成该动作；不要尝试提权或换 token',
    ];
  }
  if (status === 404) {
    return ['当前 Runtime 版本没有该路由：升级 CircuitPilot 或改用只读工具核对状态'];
  }
  if (status >= 500) {
    return ['CircuitPilot Runtime 内部错误：查看 CircuitPilot 日志', '写操作不要自动重试；先用 cp_status / cp_job 确认是否已生效'];
  }
  return [];
}

function extractErrorEnvelope(data, status) {
  let code = '';
  let message = '';
  if (data && typeof data === 'object') {
    const source = data.error && typeof data.error === 'object'
      ? data.error
      : (data.ok === false ? data : null);
    if (source) {
      if (typeof source.code === 'string') code = source.code;
      if (typeof source.message === 'string') message = source.message;
      else if (typeof source.error === 'string') message = source.error;
    }
    if (!message && typeof data.message === 'string') message = data.message;
  }
  if (!code) {
    code = status === 400 || status === 422
      ? 'RUNTIME_BAD_REQUEST'
      : status === 401
        ? 'AGENT_TOKEN_INVALID'
        : status === 403
          ? 'AGENT_ROUTE_FORBIDDEN'
          : status === 404
            ? 'ROUTE_NOT_FOUND'
            : status === 409
              ? 'RUNTIME_CONFLICT'
              : status >= 500
                ? 'RUNTIME_ERROR'
                : status >= 400
                  ? `HTTP_${status}`
                  : 'RUNTIME_REJECTED';
  }
  if (!message) message = status >= 400 ? `CircuitPilot Runtime 返回 HTTP ${status}` : 'CircuitPilot Runtime 拒绝了请求';
  return { code, message: message.slice(0, 800), nextActions: nextActionsFor(code, status) };
}

export class RuntimeClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl] Runtime base URL
   * @param {string} [options.tokenFile] agent token 文件（默认按契约解析）
   * @param {string} [options.token] 显式 token（测试/受控场景；优先于文件）
   * @param {number} [options.timeoutMs] 单请求超时，默认 30s
   * @param {number} [options.maxResponseBytes] 响应体上限，默认 4MB，防上下文/内存爆炸
   * @param {Function} [options.fetchImpl] 注入 fetch（测试用）
   */
  constructor({
    baseUrl = DEFAULT_RUNTIME_URL,
    tokenFile,
    token,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('RuntimeClient 需要可用的 fetch 实现');
    this.baseUrl = String(baseUrl || DEFAULT_RUNTIME_URL).trim().replace(/\/+$/, '');
    this.origin = new URL(this.baseUrl).origin;
    this.explicitToken = typeof token === 'string' && token.trim() ? token.trim() : undefined;
    this.tokenFile = this.explicitToken ? null : resolveAgentTokenFile(tokenFile);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes = Number.isFinite(maxResponseBytes) && maxResponseBytes > 0
      ? Math.floor(maxResponseBytes)
      : DEFAULT_MAX_RESPONSE_BYTES;
    this.fetchImpl = fetchImpl;
    this._tokenValue = null;
  }

  /** 读取 token；文件缺失/损坏抛带 code 的错误（不会包含 token 原文）。 */
  async readToken() {
    if (this.explicitToken) {
      this._tokenValue = this.explicitToken;
      return this.explicitToken;
    }
    // 每次都读文件（约 200B）：支持 Runtime 轮换 token，避免 mtime 缓存导致继续使用旧 token。
    let raw;
    try {
      raw = await readFile(this.tokenFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw tokenError(
          'AGENT_TOKEN_MISSING',
          `未找到 CircuitPilot agent token 文件：${this.tokenFile}`,
          nextActionsFor('AGENT_TOKEN_MISSING', 0),
        );
      }
      throw tokenError(
        'AGENT_TOKEN_INVALID',
        `无法读取 CircuitPilot agent token 文件（${error?.code || 'READ_FAILED'}）：${this.tokenFile}`,
        nextActionsFor('AGENT_TOKEN_INVALID', 0),
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw tokenError(
        'AGENT_TOKEN_INVALID',
        `CircuitPilot agent token 文件不是合法 JSON：${this.tokenFile}`,
        nextActionsFor('AGENT_TOKEN_INVALID', 0),
      );
    }
    const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
    if (!token || /\s/.test(token) || token.length < 8 || token.length > 512) {
      throw tokenError(
        'AGENT_TOKEN_INVALID',
        `CircuitPilot agent token 文件缺少合法 token 字段：${this.tokenFile}`,
        nextActionsFor('AGENT_TOKEN_INVALID', 0),
      );
    }
    this._tokenValue = token;
    return token;
  }

  /**
   * 发一个 Runtime 请求。永不 throw（参数错误除外），统一返回 envelope：
   *   { ok:true, status, data, truncated }
   *   { ok:false, status, code, message, nextActions }
   */
  async request(method, path, { body, query, signal, timeoutMs } = {}) {
    const httpMethod = String(method || 'GET').toUpperCase();
    if (typeof path !== 'string' || !path.startsWith('/')) {
      return this._error('INVALID_PATH', `Runtime 请求路径必须是绝对路径（以 / 开头），收到：${String(path).slice(0, 80)}`, [], 0);
    }
    let url;
    try {
      url = new URL(path, `${this.baseUrl}/`);
    } catch {
      return this._error('INVALID_PATH', `Runtime 请求路径非法：${String(path).slice(0, 80)}`, [], 0);
    }
    if (url.origin !== this.origin) {
      return this._error('INVALID_PATH', 'Runtime 请求路径不允许跨 origin（插件只调用配置的 CircuitPilot Runtime）', [], 0);
    }
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
        else url.searchParams.set(key, String(value));
      }
    }

    let token;
    try {
      token = await this.readToken();
    } catch (error) {
      return this._error(error?.code || 'AGENT_TOKEN_INVALID', error?.message || 'agent token 不可用', error?.nextActions || [], 0);
    }

    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : this.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const headers = {
      accept: 'application/json',
      [AGENT_TOKEN_HEADER]: token,
    };
    const init = { method: httpMethod, headers, signal: combinedSignal };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      try {
        init.body = JSON.stringify(body);
      } catch {
        return this._error('INVALID_BODY', 'Runtime 请求体无法序列化为 JSON', [], 0);
      }
    }

    let response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      if (signal?.aborted) {
        return this._error('CALL_CANCELLED', '调用已被取消（会话/工具中止）', [], 0);
      }
      if (error?.name === 'TimeoutError' || timeoutSignal.aborted) {
        return this._error(
          'RUNTIME_TIMEOUT',
          `CircuitPilot Runtime 请求超时（>${effectiveTimeout}ms）：${httpMethod} ${url.pathname}`,
          nextActionsFor('RUNTIME_TIMEOUT', 0),
          0,
        );
      }
      const cause = error?.cause?.code || error?.code || '';
      if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause)) {
        return this._error(
          'RUNTIME_UNREACHABLE',
          `无法连接 CircuitPilot Runtime（${this.baseUrl}）：${cause}`,
          nextActionsFor('RUNTIME_UNREACHABLE', 0),
          0,
        );
      }
      return this._error(
        'RUNTIME_NETWORK_ERROR',
        `请求 CircuitPilot Runtime 失败：${error?.message || String(error)}`,
        nextActionsFor('RUNTIME_NETWORK_ERROR', 0),
        0,
      );
    }

    let text;
    try {
      text = await response.text();
    } catch {
      return this._error('RUNTIME_READ_FAILED', '读取 CircuitPilot Runtime 响应失败', nextActionsFor('RUNTIME_NETWORK_ERROR', 0), response.status);
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.maxResponseBytes) {
      return this._error(
        'RESPONSE_TOO_LARGE',
        `CircuitPilot Runtime 响应 ${bytes} 字节，超过插件上限 ${this.maxResponseBytes}；请缩小查询范围（kind/digest/limit）后再试`,
        ['结果过大：用 cp_evidence 指定 kind/digest，或 cp_issues/cp_knowledge 缩小过滤条件', '不要要求模型读取完整 DRC/ERC 原始 JSON'],
        response.status,
      );
    }

    let data;
    if (!text.trim()) data = {};
    else {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 4096), rawBytes: bytes };
      }
    }

    if (response.ok && !(data && typeof data === 'object' && data.ok === false)) {
      return {
        ok: true,
        status: response.status,
        data,
        truncated: Boolean(data && typeof data === 'object' && data.truncated),
      };
    }

    const envelope = extractErrorEnvelope(data, response.status);
    return this._error(envelope.code, envelope.message, envelope.nextActions, response.status);
  }

  get(path, options = {}) {
    return this.request('GET', path, options);
  }

  post(path, body, options = {}) {
    return this.request('POST', path, { ...options, body });
  }

  _error(code, message, nextActions, status) {
    return {
      ok: false,
      status: Number.isFinite(status) ? status : 0,
      code: String(code || 'RUNTIME_ERROR'),
      message: this._redact(message),
      nextActions: (Array.isArray(nextActions) ? nextActions : []).map((item) => this._redact(item)),
    };
  }

  _redact(value) {
    const text = String(value ?? '');
    const token = this.explicitToken || this._tokenValue;
    if (!token) return text;
    return text.split(token).join('[REDACTED]');
  }
}
