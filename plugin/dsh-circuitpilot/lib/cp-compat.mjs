/**
 * CircuitPilot Runtime 兼容层（host-independent，不静态 import 任何 DSH 包）。
 *
 * 解决的真实问题（2026-10-29 诊断）：
 *  - 本机 4178 端口可能跑着一个**不兼容**的旧 CircuitPilot 构建（/api/health 报 0.8.15，
 *    而插件需要的 /api/project-state、/api/evidence/index、/api/agent/* 全部 404）。
 *    旧实现让 12 个 cp_* 工具直接返回一串无上下文的 ROUTE_NOT_FOUND，用户只看到“插件坏了”。
 *  - 所以运行期必须有两层判定：
 *      1) 版本门禁：/api/health.version 必须落在 compat.json 的 supportedRuntime 区间内
 *         （唯一真实验证过的 Runtime 是 0.2.0，本仓库/已安装 App）；
 *      2) 能力探测：版本号相同不代表能力相同（开源 CircuitPilot 0.2.1 没有 /api/agent/*）。
 *         版本门禁只在“明确越界”时 fail-closed；能力缺失用于 cp_status 诊断与可操作错误，
 *         不粗暴拦截只读工具。
 *
 * 设计约束：
 *  - 探测本身**永不抛异常**拖垮工具（所有 request 都兜底成 {ok:false, code, message}）；
 *  - 判定规则与 RuntimeClient 的 envelope 对齐：ROUTE_NOT_FOUND / HTTP 404 = 能力缺失；
 *    EDA_WINDOW_NOT_FOUND / 409 / 其它业务错误 = 路由存在（只是当前状态不可用）；
 *    网络错误 / token 不可用 = unknown（无法判定，不能谎称缺失）；
 *  - 健康检查成功结果缓存 30s（每个工具少打一次 health）；失败不缓存（用户修好立刻恢复）；
 *  - 单测可注入 clock / ttlMs / client，便于验证 TTL 与缓存行为。
 */

import { readFileSync } from 'node:fs';

import {
  CP_REQUIRED_CAPABILITIES,
  CP_SUPPORTED_RUNTIME_RANGE,
  CP_VERIFIED_RUNTIME_VERSIONS,
  DSH_SUPPORTED_RANGE,
  DSH_VERIFIED_VERSIONS,
  evaluateCpRuntime,
  evaluateDshHost,
} from './compat.mjs';

/** 兼容层默认 TTL：health 结果 / 能力探测结果的缓存时长。 */
export const COMPAT_CACHE_TTL_MS = 30_000;

/** 插件自身元数据（version 用于 cp_status 诊断；读取失败时优雅降级）。 */
function readPluginMetadata() {
  try {
    const url = new URL('../package.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(url, 'utf8'));
    return {
      name: typeof parsed?.name === 'string' ? parsed.name : 'dsh-circuitpilot',
      version: typeof parsed?.version === 'string' ? parsed.version : null,
    };
  } catch {
    return { name: 'dsh-circuitpilot', version: null };
  }
}

export const CP_PLUGIN_METADATA = Object.freeze(readPluginMetadata());

/**
 * 能力矩阵：插件依赖的 Runtime 只读路由（全部 GET，绝不发写请求）。
 * requiredBy 是“该能力被哪些工具使用”的静态声明（诊断用，不用于硬拦截所有工具）：
 *  - agent-api 只被“计划级 UI 审批队列/审批控制台”相关工具使用，不是所有工具的硬依赖；
 *  - 其余能力与 cp_status/cp_project_context 等只读工具直接对应。
 */
export const CP_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'agent-api',
    label: 'Agent 接入 / UI 审批队列（/api/agent/*）',
    method: 'GET',
    path: '/api/agent/status',
    requiredBy: Object.freeze(['cp_design_plan', 'cp_pcb_plan', 'cp_approve']),
  }),
  Object.freeze({
    id: 'project-state',
    label: '项目状态（/api/project-state）',
    method: 'GET',
    path: '/api/project-state',
    requiredBy: Object.freeze(['cp_status', 'cp_project_context']),
  }),
  Object.freeze({
    id: 'issue-state',
    label: '未收口问题状态（/api/issue-state）',
    method: 'GET',
    path: '/api/issue-state',
    requiredBy: Object.freeze(['cp_status', 'cp_project_context', 'cp_issues']),
  }),
  Object.freeze({
    id: 'evidence-index',
    label: '证据索引（/api/evidence/index）',
    method: 'GET',
    path: '/api/evidence/index',
    requiredBy: Object.freeze(['cp_status', 'cp_evidence']),
  }),
  Object.freeze({
    id: 'write-gate',
    label: '写暂停门禁（/api/write-gate）',
    method: 'GET',
    path: '/api/write-gate',
    requiredBy: Object.freeze(['cp_status']),
  }),
  Object.freeze({
    id: 'eda-workspace',
    label: 'EDA 工作区绑定（/api/eda/workspaces/current）',
    method: 'GET',
    path: '/api/eda/workspaces/current',
    requiredBy: Object.freeze(['cp_status', 'cp_project_context']),
  }),
]);

/** 能力探测判定结果。 */
export const CP_CAPABILITY_STATUS = Object.freeze({
  AVAILABLE: 'available',
  MISSING: 'missing',
  UNKNOWN: 'unknown',
});

/** 这些错误码代表“没连上 Runtime”，而不是“Runtime 说路由不存在”。 */
const UNREACHABLE_CODES = Object.freeze(['RUNTIME_UNREACHABLE', 'RUNTIME_NETWORK_ERROR', 'RUNTIME_TIMEOUT']);

/** 这些错误码代表“无法判定路由是否存在”（传输层 / 鉴权层提前失败）。 */
const INDETERMINATE_CODES = Object.freeze([
  ...UNREACHABLE_CODES,
  'CALL_CANCELLED',
  'RUNTIME_READ_FAILED',
  'AGENT_TOKEN_MISSING',
  'AGENT_TOKEN_INVALID',
  'RUNTIME_TOKEN_INVALID',
  'INVALID_PATH',
]);

/** 404 / ROUTE_NOT_FOUND：Runtime 明确表示该路由不存在。 */
export function isRouteMissingEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.ok === true) return false;
  if (envelope.code === 'ROUTE_NOT_FOUND') return true;
  return Number(envelope.status) === 404;
}

/**
 * 把一条 Runtime 响应归类为能力状态：
 *  - available：成功，或“路由存在但当前状态不可用”（409/EDA 未连/业务错误/403 denylist）；
 *  - missing：ROUTE_NOT_FOUND / HTTP 404；
 *  - unknown：网络/超时/取消/token 不可用，无法判定路由是否存在。
 * @param {object|null} envelope RuntimeClient 返回的 envelope
 * @returns {'available'|'missing'|'unknown'}
 */
export function classifyCapabilityOutcome(envelope) {
  const env = envelope && typeof envelope === 'object' ? envelope : null;
  if (!env) return CP_CAPABILITY_STATUS.UNKNOWN;
  if (env.ok === true) return CP_CAPABILITY_STATUS.AVAILABLE;
  if (isRouteMissingEnvelope(env)) return CP_CAPABILITY_STATUS.MISSING;
  const code = typeof env.code === 'string' ? env.code : '';
  if (INDETERMINATE_CODES.includes(code)) return CP_CAPABILITY_STATUS.UNKNOWN;
  return CP_CAPABILITY_STATUS.AVAILABLE;
}

function toTruncatedText(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function nowDefault() {
  return Date.now();
}

/**
 * 评估 /api/health 的版本兼容性。
 * @param {object|null} healthData GET /api/health 的 data
 * @returns {{version:string|null,service:string|null,versionCompat:object,usable:boolean,reason:string|null}}
 */
export function evaluateHealthCompat(healthData) {
  const source = healthData && typeof healthData === 'object' ? healthData : {};
  const rawVersion = typeof source.version === 'string' ? source.version.trim() : '';
  const versionCompat = evaluateCpRuntime(rawVersion || null);
  return {
    version: rawVersion || null,
    service: typeof source.service === 'string' ? source.service : null,
    versionCompat,
    // 版本缺失/非法时放行（unknown），避免测试/开发版 Runtime 被硬拦；
    // 明确可解析且越界的版本才是 fail-closed（由 ensureRuntimeCompatible 决定）。
    usable: versionCompat.supported || versionCompat.unknown,
    reason: versionCompat.reason ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 能力探测（带 TTL 缓存）                                             */
/* ------------------------------------------------------------------ */

// 每个 RuntimeClient 一套缓存：不同 baseUrl/实例互不污染（测试并发也安全）。
const capabilityCache = new WeakMap();
// 同一个 client 上的 health 门禁缓存。
const healthCache = new WeakMap();

function readCache(store, client, clock, ttlMs) {
  if (!client || typeof client !== 'object') return null;
  const entry = store.get(client);
  if (!entry) return null;
  if (!(ttlMs > 0)) return null;
  const age = clock() - entry.at;
  if (!Number.isFinite(age) || age < 0 || age >= ttlMs) return null;
  return entry.value;
}

function writeCache(store, client, clock, value) {
  if (!client || typeof client !== 'object') return;
  store.set(client, { at: clock(), value });
}

/** 清掉某个 client 的兼容性缓存（测试/诊断用；不传 client 时无操作）。 */
export function clearCompatCache(client) {
  if (!client || typeof client !== 'object') return;
  capabilityCache.delete(client);
  healthCache.delete(client);
}

/**
 * 探测 Runtime 能力矩阵（全部 GET，只读）。
 *
 * 永不抛异常：单个能力探测失败只归类为 missing/unknown。
 * 结果按 client 缓存 ttlMs（默认 30s）；缓存命中返回 `cached:true`。
 *
 * @param {object} [options]
 * @param {{request:Function}} [options.client] RuntimeClient（或同形 stub）
 * @param {AbortSignal} [options.signal]
 * @param {Array} [options.capabilities] 能力矩阵，默认 CP_CAPABILITIES
 * @param {number} [options.ttlMs] 缓存 TTL，默认 COMPAT_CACHE_TTL_MS
 * @param {Function} [options.clock] 时钟（毫秒），默认 Date.now
 * @param {boolean} [options.force] 跳过缓存
 * @returns {Promise<{checked:string[],missing:object[],unknown:object[],complete:boolean,checkedAt:string,cached:boolean}>}
 */
export async function probeCapabilities({
  client,
  signal,
  capabilities = CP_CAPABILITIES,
  ttlMs = COMPAT_CACHE_TTL_MS,
  clock = nowDefault,
  force = false,
} = {}) {
  const caps = Array.isArray(capabilities) && capabilities.length ? capabilities : CP_CAPABILITIES;
  const checkedAt = new Date(clock()).toISOString();
  const empty = {
    checked: [],
    missing: [],
    unknown: [],
    complete: false,
    checkedAt,
    cached: false,
  };
  if (!client || typeof client.request !== 'function') {
    return { ...empty, error: '没有可用的 Runtime client，跳过能力探测' };
  }
  if (!force) {
    const cached = readCache(capabilityCache, client, clock, ttlMs);
    if (cached) return { ...cached, cached: true };
  }

  const missing = [];
  const unknown = [];
  const checked = [];
  for (const capability of caps) {
    if (signal?.aborted) break;
    const method = typeof capability?.method === 'string' ? capability.method : 'GET';
    const path = typeof capability?.path === 'string' ? capability.path : '';
    const id = typeof capability?.id === 'string' ? capability.id : path;
    const label = typeof capability?.label === 'string' ? capability.label : id;
    if (!path) {
      unknown.push({ id, label, path, code: 'CAPABILITY_PATH_MISSING', message: '能力矩阵缺少 path' });
      checked.push(id);
      continue;
    }
    let envelope;
    try {
      envelope = await client.request(method, path, { signal });
    } catch (error) {
      envelope = {
        ok: false,
        code: error?.code ?? 'RUNTIME_NETWORK_ERROR',
        message: error?.message ?? String(error),
      };
    }
    checked.push(id);
    const outcome = classifyCapabilityOutcome(envelope);
    if (outcome === CP_CAPABILITY_STATUS.AVAILABLE) continue;
    const entry = {
      id,
      label,
      path,
      code: typeof envelope?.code === 'string' ? envelope.code : null,
      message: toTruncatedText(envelope?.message ?? ''),
    };
    if (outcome === CP_CAPABILITY_STATUS.MISSING) missing.push(entry);
    else unknown.push(entry);
  }

  const result = {
    checked,
    missing,
    unknown,
    complete: checked.length === caps.length && missing.length === 0 && unknown.length === 0,
    checkedAt: new Date(clock()).toISOString(),
    cached: false,
  };
  // 只有完整探测才缓存：被取消/提前中断的探测不能污染后续诊断。
  if (result.checked.length === caps.length) writeCache(capabilityCache, client, clock, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* 版本门禁                                                            */
/* ------------------------------------------------------------------ */

/**
 * 生成“Runtime 不兼容”的可操作中文提示（升级/回退/更新插件三条路径）。
 * @param {{missing?:Array<string|object>}} [context] 可选：缺失能力 id 列表
 * @returns {string[]}
 */
export function compatNextActions(context = {}) {
  const range = CP_SUPPORTED_RUNTIME_RANGE;
  const verified = CP_VERIFIED_RUNTIME_VERSIONS.length ? CP_VERIFIED_RUNTIME_VERSIONS.join(' / ') : '无';
  const actions = [
    `确认 CircuitPilot Runtime 版本：/api/health 的 version 必须落在 ${range} 内（已验证 ${verified}）；用 cp_status 查看 data.runtime.versionCompat`,
    '升级/切换到兼容的 CircuitPilot Runtime：本仓库 `node runtime/server.mjs`（0.2.x）或已安装的 CircuitPilot App；不要连到开源旧版/其它构建（例如 0.8.15）',
    '如果必须继续用旧 Runtime：把 dsh-circuitpilot 插件回退到与该 Runtime 匹配的版本；不要用新版插件连旧 Runtime',
    '如果 Runtime 已是 0.2.x 但仍缺路由：说明路由被改名/移除，升级插件或按 docs/agent/agent-contract.md 核对路由名',
  ];
  const missingIds = (Array.isArray(context?.missing) ? context.missing : [])
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((id) => typeof id === 'string' && id);
  if (missingIds.length) {
    actions.unshift(`Runtime 缺少能力 ${[...new Set(missingIds)].join(' / ')}：确认安装的是带 agent 路由的 CircuitPilot 0.2.x（开源 0.2.1 没有 /api/agent/*）`);
  }
  return actions;
}

const RUNTIME_DOWN_FALLBACK_ACTIONS = Object.freeze([
  '启动 CircuitPilot 应用并确认 Runtime 在配置的 runtimeUrl 上运行（默认 http://127.0.0.1:4178）',
  '确认 agent token 文件存在（默认按平台落在 CircuitPilot 用户数据目录，可用 CIRCUITPILOT_AGENT_TOKEN_FILE 覆盖）',
]);

function unreachableResult(envelope) {
  return {
    ok: false,
    code: 'RUNTIME_UNREACHABLE',
    message: envelope?.message || '无法连接 CircuitPilot Runtime',
    nextActions: Array.isArray(envelope?.nextActions) && envelope.nextActions.length
      ? [...envelope.nextActions]
      : [...RUNTIME_DOWN_FALLBACK_ACTIONS],
    data: {
      runtimeVersion: null,
      supportedRange: CP_SUPPORTED_RUNTIME_RANGE,
      verified: [...CP_VERIFIED_RUNTIME_VERSIONS],
      originalCode: typeof envelope?.code === 'string' ? envelope.code : null,
    },
  };
}

/**
 * Runtime 兼容门禁：在工具真正干活之前判定“这个 Runtime 能不能用”。
 *
 * 返回（全部不会抛异常）：
 *  - 兼容：{ ok:true, version, service, versionCompat, health, capabilities:null, warning:null, cached }
 *  - 明确越界（可解析版本）：{ ok:false, code:'RUNTIME_VERSION_UNSUPPORTED', message, nextActions, data }
 *  - 连不上：{ ok:false, code:'RUNTIME_UNREACHABLE', message, nextActions, data }
 *  - 其它无法判定的 health 失败 / 版本缺失或非法：{ ok:true, warning, ... }（放行，交给具体工具报真实错误）
 *
 * @param {object} [options]
 * @param {{request:Function}} [options.client]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.ttlMs] 成功结果缓存 TTL，默认 30s
 * @param {Function} [options.clock]
 * @param {boolean} [options.force] 跳过缓存（诊断用）
 * @returns {Promise<object>}
 */
export async function ensureRuntimeCompatible({
  client,
  signal,
  ttlMs = COMPAT_CACHE_TTL_MS,
  clock = nowDefault,
  force = false,
} = {}) {
  if (!client || typeof client.request !== 'function') {
    return {
      ok: true,
      warning: '没有可用的 Runtime client，跳过版本兼容门禁（后续请求会各自报错）',
      version: null,
      service: null,
      versionCompat: evaluateCpRuntime(null),
      health: null,
      cached: false,
    };
  }
  if (!force) {
    const cached = readCache(healthCache, client, clock, ttlMs);
    if (cached) return { ...cached, cached: true };
  }

  let health;
  try {
    health = await client.request('GET', '/api/health', { signal });
  } catch (error) {
    // RuntimeClient 正常不抛异常；能抛到这里的基本都是传输层错误（stub/自定义实现），按不可达处理。
    health = { ok: false, code: 'RUNTIME_NETWORK_ERROR', message: error?.message ?? String(error) };
  }
  if (!health || typeof health !== 'object') {
    health = { ok: false, code: 'RUNTIME_NETWORK_ERROR', message: 'Runtime /api/health 没有返回可解析的响应' };
  }

  if (health.ok !== true) {
    const code = typeof health.code === 'string' ? health.code : '';
    if (UNREACHABLE_CODES.includes(code) || !code) return unreachableResult(health);
    // health 本身是公开路由：非网络/非版本错误（409/403/500/token 异常等）无法判定兼容性，
    // 放行让具体工具返回真实错误，避免把“审批 409”“token 缺失”误报成版本不兼容。
    return {
      ok: true,
      warning: `无法判定 Runtime 版本兼容性（/api/health 失败：${code || 'UNKNOWN'}）：已放行，后续错误以具体工具返回为准`,
      version: null,
      service: null,
      versionCompat: evaluateCpRuntime(null),
      health: null,
      cached: false,
    };
  }

  const healthCompat = evaluateHealthCompat(health.data);
  const { versionCompat } = healthCompat;
  if (!versionCompat.unknown && !versionCompat.supported) {
    const verifiedText = versionCompat.verified.length ? versionCompat.verified.join(' / ') : '无';
    return {
      ok: false,
      code: 'RUNTIME_VERSION_UNSUPPORTED',
      message: `CircuitPilot Runtime 版本不兼容：检测到 ${versionCompat.version ?? '(未知)'}，插件只支持 ${versionCompat.range}（已验证 ${verifiedText}）；已阻止后续请求，避免返回一串无上下文 404`,
      nextActions: compatNextActions(),
      data: {
        runtimeVersion: versionCompat.version,
        supportedRange: versionCompat.range,
        verified: [...versionCompat.verified],
      },
      version: healthCompat.version,
      service: healthCompat.service,
      versionCompat,
      health: health.data,
      cached: false,
    };
  }

  const result = {
    ok: true,
    warning: versionCompat.unknown
      ? `无法判定 Runtime 版本兼容性（${versionCompat.reason ?? '版本缺失或非法'}）：已放行；如遇路由缺失请查看 cp_status 的 capabilities`
      : null,
    version: healthCompat.version,
    service: healthCompat.service,
    versionCompat,
    health: health.data,
    cached: false,
  };
  writeCache(healthCache, client, clock, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* 汇总（给工具结果 data.compat / data.plugin 用）                      */
/* ------------------------------------------------------------------ */

/**
 * 汇总 DSH 宿主 + 插件自身信息（cp_status 的 data.plugin；host 可能为 undefined）。
 * @param {object|undefined|null} host index.mjs 传入的宿主信息
 * @param {{plugin?:{name?:string,version?:string|null}}} [options]
 * @returns {{version:string|null,host:{dshVersion:string|null,supported:boolean|null,supportedRange:string,verified:string[],registration:unknown}}}
 */
export function summarizePluginHost(host, { plugin = CP_PLUGIN_METADATA } = {}) {
  const source = host && typeof host === 'object' ? host : {};
  const hostCompat = source.compat && typeof source.compat === 'object' ? source.compat : null;
  const rawVersion = typeof source.version === 'string' && source.version.trim()
    ? source.version.trim()
    : (typeof source.dshVersion === 'string' && source.dshVersion.trim() ? source.dshVersion.trim() : '');
  const dshVersion = rawVersion || null;
  const evaluated = dshVersion ? evaluateDshHost(dshVersion) : null;
  const supported = typeof source.compatible === 'boolean'
    ? source.compatible
    : (typeof hostCompat?.supported === 'boolean' ? hostCompat.supported : (evaluated ? evaluated.supported : null));
  const supportedRange = typeof source.supportedRange === 'string' && source.supportedRange
    ? source.supportedRange
    : (typeof hostCompat?.range === 'string' && hostCompat.range ? hostCompat.range : DSH_SUPPORTED_RANGE);
  const verified = Array.isArray(source.verified) && source.verified.length
    ? [...source.verified]
    : (Array.isArray(hostCompat?.verified) && hostCompat.verified.length ? [...hostCompat.verified] : [...DSH_VERIFIED_VERSIONS]);
  return {
    version: typeof plugin?.version === 'string' ? plugin.version : null,
    host: {
      dshVersion,
      supported,
      supportedRange,
      verified,
      registration: source.registration ?? null,
    },
  };
}

/**
 * 把门禁/探测状态压成稳定的 `data.compat` 结构。
 * 兼容多种入参：ensureRuntimeCompatible() 的返回值、{versionCompat, capabilities}、
 * 或失败结果的 {data:{runtimeVersion,supportedRange,verified}}。
 *
 * @param {object} [compat]
 * @param {{capabilities?:object,plugin?:object,host?:object}} [options]
 * @returns {{runtimeVersion:string|null,supported:boolean|null,supportedRange:string,verified:string[],capabilities:{missing:string[],unknown:string[],complete:boolean|null},plugin:object,warning:string|null}}
 */
export function summarizeCompat(compat, options = {}) {
  const source = compat && typeof compat === 'object' ? compat : {};
  const versionCompat = source.versionCompat && typeof source.versionCompat === 'object'
    ? source.versionCompat
    : null;
  const failureData = source.data && typeof source.data === 'object' ? source.data : null;
  const caps = options.capabilities && typeof options.capabilities === 'object'
    ? options.capabilities
    : (source.capabilities && typeof source.capabilities === 'object' ? source.capabilities : null);

  const runtimeVersion = typeof source.version === 'string' && source.version
    ? source.version
    : (typeof failureData?.runtimeVersion === 'string' && failureData.runtimeVersion
      ? failureData.runtimeVersion
      : (typeof versionCompat?.version === 'string' && versionCompat.version ? versionCompat.version : null));
  const supported = typeof versionCompat?.supported === 'boolean'
    ? versionCompat.supported
    : (typeof source.supported === 'boolean' ? source.supported : null);
  const supportedRange = typeof versionCompat?.range === 'string' && versionCompat.range
    ? versionCompat.range
    : (typeof failureData?.supportedRange === 'string' && failureData.supportedRange
      ? failureData.supportedRange
      : CP_SUPPORTED_RUNTIME_RANGE);
  const verified = Array.isArray(versionCompat?.verified) && versionCompat.verified.length
    ? [...versionCompat.verified]
    : (Array.isArray(failureData?.verified) && failureData.verified.length
      ? [...failureData.verified]
      : [...CP_VERIFIED_RUNTIME_VERSIONS]);
  const missing = (Array.isArray(caps?.missing) ? caps.missing : [])
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((id) => typeof id === 'string' && id);
  const unknown = (Array.isArray(caps?.unknown) ? caps.unknown : [])
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((id) => typeof id === 'string' && id);
  const pluginInfo = options.plugin ?? summarizePluginHost(options.host, {
    plugin: options.pluginMeta ?? CP_PLUGIN_METADATA,
  });
  return {
    runtimeVersion,
    supported,
    supportedRange,
    verified,
    capabilities: {
      missing: [...new Set(missing)],
      unknown: [...new Set(unknown)],
      complete: typeof caps?.complete === 'boolean' ? caps.complete : null,
    },
    plugin: {
      name: pluginInfo?.name ?? CP_PLUGIN_METADATA.name,
      version: pluginInfo?.version ?? CP_PLUGIN_METADATA.version ?? null,
      host: pluginInfo?.host ?? null,
    },
    warning: typeof source.warning === 'string' && source.warning ? source.warning : null,
  };
}

/** 能力矩阵与 compat.json 声明的一致性（供测试/自检使用，不抛异常）。 */
export function listMissingCapabilityDeclarations() {
  const declared = CP_CAPABILITIES.map((item) => item.id);
  return CP_REQUIRED_CAPABILITIES.filter((id) => !declared.includes(id));
}
