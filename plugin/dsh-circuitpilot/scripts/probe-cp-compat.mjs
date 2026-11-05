#!/usr/bin/env node
/**
 * probe-cp-compat.mjs — CircuitPilot Runtime 兼容性只读探针。
 *
 * 用途：回答「当前这台机器上跑着的 CircuitPilot，插件到底能不能用？」——
 *   1. GET /api/health 取 version，用 lib/compat.mjs 的 evaluateCpRuntime() 判定版本门禁；
 *   2. 逐项 GET 探测插件所需的能力路由（project-state / issue-state / evidence-index /
 *      write-gate / eda-workspaces-current / agent-status），输出能力矩阵；
 *   3. 给出可操作结论与下一步（缺什么、该升级/回退什么、token 怎么配）。
 *
 * 安全边界（硬约束）：
 *  - 只发 GET，不构造任何 POST/写路由请求；不启动、不杀死任何 Runtime；
 *  - 不联网（只打 --base-url 指向的本机地址）；
 *  - agent token 只从本机文件读取并放进请求头，**永远不打印/不写日志**。
 *
 * 判定规则（与 lib/cp-compat.mjs 的运行期探测保持一致）：
 *  - HTTP 404 或 body.error.code === 'ROUTE_NOT_FOUND' → 能力缺失；
 *  - HTTP 200 → 存在；
 *  - 409 / 其它业务错误（body.ok === false 且非 ROUTE_NOT_FOUND）→ 路由存在（只是当前 EDA 未连接等）；
 *  - HTTP 401 → 鉴权发生在路由分发之前，无法判断路由是否存在（需要 agent token）；
 *  - HTTP 403 → 路由存在但被 agent denylist 拒绝；
 *  - 网络错误/超时 → unknown。
 *
 * 退出码：0 = 版本兼容且核心能力齐全（或 token 缺失无法判定能力时仅告警）；
 *         1 = 版本不兼容 / 核心能力缺失 / Runtime 不可达；2 = 用法/内部错误。
 *
 * @module scripts/probe-cp-compat
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

import {
  CP_REQUIRED_CAPABILITIES,
  CP_SUPPORTED_RUNTIME_RANGE,
  CP_VERIFIED_RUNTIME_VERSIONS,
  evaluateCpRuntime,
} from '../lib/compat.mjs';

export const EXIT = Object.freeze({ OK: 0, INCOMPATIBLE: 1, USAGE: 2 });

export const DEFAULT_BASE_URL = 'http://127.0.0.1:4178';
export const AGENT_TOKEN_HEADER = 'x-circuitpilot-agent-token';
export const DEFAULT_TIMEOUT_MS = 4000;

/** 能力 → 只读探测路由。core 由 compat.json 的 requiredCapabilities 决定。 */
export const ROUTE_PROBES = Object.freeze([
  { id: 'project-state', capability: 'project-state', label: '项目状态', method: 'GET', path: '/api/project-state' },
  { id: 'issue-state', capability: 'issue-state', label: '问题状态', method: 'GET', path: '/api/issue-state' },
  { id: 'evidence-index', capability: 'evidence-index', label: '证据索引', method: 'GET', path: '/api/evidence/index' },
  { id: 'write-gate', capability: 'write-gate', label: '写入门禁', method: 'GET', path: '/api/write-gate' },
  { id: 'eda-workspaces-current', capability: 'eda-workspace', label: 'EDA 当前工作区', method: 'GET', path: '/api/eda/workspaces/current' },
  { id: 'agent-status', capability: 'agent-api', label: 'Agent 队列状态', method: 'GET', path: '/api/agent/status' },
]);

export const USAGE = `用法：node scripts/probe-cp-compat.mjs [选项]

只读探测 CircuitPilot Runtime 的版本兼容性与能力路由（只发 GET，不启动/不杀 Runtime）。

选项：
  --base-url <url>      Runtime 地址（默认 ${DEFAULT_BASE_URL}，或环境变量 CIRCUITPILOT_RUNTIME_URL）
  --token-file <file>   agent token 文件；默认依次取环境变量 CIRCUITPILOT_AGENT_TOKEN_FILE，
                        再取平台默认路径（macOS: ~/Library/Application Support/CircuitPilot/agent-token.json）
  --timeout-ms <ms>     单请求超时（默认 ${DEFAULT_TIMEOUT_MS}）
  --json                stdout 只输出结构化 JSON
  -h, --help            显示本帮助

退出码：0 = 兼容且核心能力齐全；1 = 版本不兼容 / 核心能力缺失 / Runtime 不可达；2 = 用法错误。
`;

/* ------------------------------------------------------------------ */
/* 参数与 token                                                        */
/* ------------------------------------------------------------------ */

function takeValue(argv, flag) {
  const next = argv.shift();
  if (next === undefined || next.startsWith('--')) throw new Error(`参数 ${flag} 需要一个值`);
  return next;
}

/** 解析 CLI 参数；不合法抛错（main 映射为 exit 2）。 */
export function parseArgs(argv) {
  const options = {
    baseUrl: null,
    tokenFile: null,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    let flag = token;
    let inlineValue = null;
    if (token.startsWith('--') && token.includes('=')) {
      const index = token.indexOf('=');
      flag = token.slice(0, index);
      inlineValue = token.slice(index + 1);
    }
    const value = () => (inlineValue !== null ? inlineValue : takeValue(args, flag));
    switch (flag) {
      case '--base-url':
        options.baseUrl = value();
        break;
      case '--token-file':
        options.tokenFile = value();
        break;
      case '--timeout-ms': {
        const raw = value();
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--timeout-ms "${raw}" 不是正数`);
        options.timeoutMs = Math.floor(parsed);
        break;
      }
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(token.startsWith('-') ? `未知参数：${token}` : `无法识别的参数：${token}`);
    }
  }
  return options;
}

/** 平台默认 agent token 文件（与 lib/runtime.mjs 的 defaultAgentTokenFile 保持一致）。 */
export function defaultTokenFile({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'CircuitPilot', 'agent-token.json');
  if (platform === 'win32') {
    const base = typeof env.APPDATA === 'string' && env.APPDATA.trim() ? env.APPDATA.trim() : join(home, 'AppData', 'Roaming');
    return join(base, 'CircuitPilot', 'agent-token.json');
  }
  const base =
    typeof env.XDG_STATE_HOME === 'string' && env.XDG_STATE_HOME.trim() ? env.XDG_STATE_HOME.trim() : join(home, '.local', 'state');
  return join(base, 'circuitpilot', 'agent-token.json');
}

/**
 * 解析 agent token 文件路径：显式参数 > 环境变量 > 平台默认。
 * @returns {{file:string, explicit:boolean}}
 */
export function resolveTokenFile({ tokenFile = null, env = process.env } = {}) {
  if (typeof tokenFile === 'string' && tokenFile.trim()) return { file: resolve(tokenFile.trim()), explicit: true };
  const fromEnv = typeof env.CIRCUITPILOT_AGENT_TOKEN_FILE === 'string' ? env.CIRCUITPILOT_AGENT_TOKEN_FILE.trim() : '';
  if (fromEnv) return { file: resolve(fromEnv), explicit: true };
  return { file: defaultTokenFile({ env }), explicit: false };
}

/**
 * 只读加载 agent token；文件缺失/损坏返回 {available:false, reason}，不抛、不泄漏内容。
 * @returns {{available:boolean, file:string, token:string|null, reason:string|null}}
 */
export function loadAgentToken({ file, readFileImpl = readFileSync } = {}) {
  const base = { available: false, file: file ?? null, token: null, reason: null };
  if (!file) return { ...base, reason: '未解析到 token 文件路径' };
  try {
    if (!existsSync(file)) return { ...base, reason: 'token 文件不存在' };
    const raw = readFileImpl(file, 'utf8');
    const parsed = JSON.parse(raw);
    const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
    if (!token || /\s/.test(token) || token.length < 8 || token.length > 512) {
      return { ...base, reason: 'token 文件缺少合法 token 字段' };
    }
    return { available: true, file, token, reason: null };
  } catch (error) {
    return { ...base, reason: `无法读取/解析 token 文件（${error?.code || 'READ_FAILED'}）` };
  }
}

/* ------------------------------------------------------------------ */
/* 探测                                                                */
/* ------------------------------------------------------------------ */

async function requestJson(fetchImpl, url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { reachable: true, status: response.status, ok: Boolean(response.ok), body };
  } catch (error) {
    return { reachable: false, status: null, ok: false, body: null, error: error?.code || error?.name || 'FETCH_FAILED' };
  }
}

/**
 * 把一次路由探测结果归类为能力状态。纯函数，便于离线单测。
 * @returns {{state:'present'|'missing'|'unauthorized'|'unknown', code:string|null, message:string}}
 */
export function classifyProbe({ status = null, body = null, networkError = null } = {}) {
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const code = typeof error?.code === 'string' ? error.code : null;
  const message = typeof error?.message === 'string' ? error.message : null;
  if (networkError) return { state: 'unknown', code: networkError, message: '网络错误/超时，无法判定' };
  if (status === 404 || code === 'ROUTE_NOT_FOUND') {
    return { state: 'missing', code: code ?? 'HTTP_404', message: message ?? '路由不存在（Runtime 版本可能不匹配）' };
  }
  if (status === 401) {
    return { state: 'unauthorized', code: code ?? 'HTTP_401', message: '鉴权失败（鉴权先于路由分发，需 agent token 才能探测能力）' };
  }
  if (status === 403) {
    return { state: 'present', code: code ?? 'HTTP_403', message: `路由存在，但被 agent denylist 拒绝${message ? `：${message}` : ''}` };
  }
  if (status !== null && status >= 200 && status < 300) {
    return { state: 'present', code: null, message: 'ok' };
  }
  if (body && typeof body === 'object' && body.ok === false) {
    return { state: 'present', code: code ?? `HTTP_${status}`, message: `业务错误（路由存在）：${message ?? '未知原因'}` };
  }
  return { state: 'unknown', code: code ?? (status !== null ? `HTTP_${status}` : null), message: '无法判定' };
}

/**
 * 只读探测一个 Runtime（health + 能力路由 + 版本判定）。
 * @returns {Promise<object>} 完整探测报告（不含 token 原文）
 */
export async function probeRuntime({
  baseUrl = DEFAULT_BASE_URL,
  tokenFile = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  routeProbes = ROUTE_PROBES,
  requiredCapabilities = CP_REQUIRED_CAPABILITIES,
  env = process.env,
} = {}) {
  const base = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const tokenInfo = resolveTokenFile({ tokenFile, env });
  const token = loadAgentToken({ file: tokenInfo.file });
  const headers = token.available ? { [AGENT_TOKEN_HEADER]: token.token } : {};
  const startedAt = new Date().toISOString();

  const healthResponse = await requestJson(fetchImpl, `${base}/api/health`, { timeoutMs });
  const healthBody = healthResponse.body;
  const version = typeof healthBody?.version === 'string' ? healthBody.version.trim() : null;
  const health = {
    reachable: healthResponse.reachable,
    status: healthResponse.status,
    version,
    service: typeof healthBody?.service === 'string' ? healthBody.service : null,
    error: healthResponse.error ?? null,
  };
  const versionCompat = evaluateCpRuntime(version);

  const capabilities = [];
  for (const probe of routeProbes) {
    const response = await requestJson(fetchImpl, `${base}${probe.path}`, { headers, timeoutMs });
    const classified = classifyProbe({ status: response.status, body: response.body, networkError: response.error ?? null });
    capabilities.push({
      id: probe.id,
      capability: probe.capability,
      label: probe.label,
      method: probe.method,
      path: probe.path,
      core: Array.isArray(requiredCapabilities) ? requiredCapabilities.includes(probe.capability) : true,
      state: classified.state,
      httpStatus: response.status,
      code: classified.code,
      message: classified.message,
    });
  }

  const summary = summarizeCapabilities({ capabilities, versionCompat, tokenAvailable: token.available, health });
  return {
    tool: 'probe-cp-compat',
    schemaVersion: 1,
    baseUrl: base,
    checkedAt: startedAt,
    token: { available: token.available, file: token.file, reason: token.reason, header: AGENT_TOKEN_HEADER },
    health,
    versionCompat: {
      supported: versionCompat.supported,
      unknown: versionCompat.unknown,
      version: versionCompat.version,
      range: versionCompat.range,
      verified: versionCompat.verified,
      reason: versionCompat.reason,
    },
    capabilities,
    summary,
  };
}

/** 汇总能力矩阵（纯函数，便于单测）。 */
export function summarizeCapabilities({ capabilities = [], versionCompat, tokenAvailable = false, health = {} } = {}) {
  const byState = (state) => capabilities.filter((item) => item.state === state);
  const missing = byState('missing');
  const unauthorized = byState('unauthorized');
  const unknown = byState('unknown');
  const present = byState('present');
  const core = capabilities.filter((item) => item.core);
  const coreMissing = core.filter((item) => item.state === 'missing');
  const healthOk = Boolean(health?.reachable && health?.status === 200 && versionCompat?.supported);
  return {
    total: capabilities.length,
    present: present.length,
    missing: missing.map((item) => item.id),
    unauthorized: unauthorized.map((item) => item.id),
    unknown: unknown.map((item) => item.id),
    coreMissing: coreMissing.map((item) => item.id),
    coreTotal: core.length,
    tokenAvailable,
    healthOk,
    compatible: Boolean(versionCompat?.supported),
    /** 版本兼容 + 核心能力齐全 + Runtime 可达（能力判定需要 token；无 token 时为「未验证」） */
    usable: Boolean(versionCompat?.supported && healthOk),
    capabilitiesVerified: tokenAvailable && unauthorized.length === 0,
    ok: Boolean(versionCompat?.supported && healthOk && coreMissing.length === 0),
  };
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */

function padCell(text, width) {
  const value = String(text ?? '');
  const displayWidth = [...value].reduce((total, char) => total + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return value + ' '.repeat(Math.max(0, width - displayWidth));
}

const STATE_LABEL = Object.freeze({
  present: '✓ 存在',
  missing: '✗ 缺失',
  unauthorized: '? 需 token',
  unknown: '? 未知',
});

/** 生成人类可读报告。 */
export function formatHumanReport(report) {
  const lines = [];
  const { versionCompat, health, summary } = report;
  lines.push('CircuitPilot Runtime 兼容性探针（只读 GET）');
  lines.push(`地址：${report.baseUrl}`);
  lines.push('');
  lines.push('[Runtime]');
  lines.push(`  /api/health：${health.reachable ? `HTTP ${health.status}` : '不可达'}${health.version ? ` · version=${health.version}` : ''}${health.service ? ` · service=${health.service}` : ''}`);
  if (!health.reachable) lines.push(`  ✗ 无法连接 Runtime（${health.error ?? 'unknown'}）：不启动/不杀 Runtime，请先启动 CircuitPilot 或检查 --base-url`);
  else if (!versionCompat.supported) lines.push(`  ✗ 版本不兼容：${versionCompat.reason ?? `${health.version} 不在 ${versionCompat.range} 内`}`);
  else lines.push(`  ✓ 版本兼容：${health.version} ∈ ${versionCompat.range}`);
  lines.push(`  支持区间：${versionCompat.range} · 已验证：${(versionCompat.verified ?? []).join(', ') || '（空）'}`);
  lines.push(`  agent token：${report.token.available ? `已加载（${report.token.file}，内容不显示）` : `未找到（${report.token.reason ?? report.token.file ?? '未配置'}）`}`);
  lines.push('');
  lines.push('[能力矩阵]');
  const idWidth = Math.max(14, ...report.capabilities.map((item) => item.id.length + 2));
  const routeText = (item) => `${item.method} ${item.path}`;
  const pathWidth = Math.max(28, ...report.capabilities.map((item) => routeText(item).length + 2));
  lines.push(`  ${padCell('能力', idWidth)}${padCell('路由', pathWidth)}${padCell('状态', 10)}说明`);
  for (const item of report.capabilities) {
    const mark = item.core ? '*' : ' ';
    lines.push(
      `  ${padCell(`${item.id}${mark}`, idWidth)}${padCell(routeText(item), pathWidth)}${padCell(STATE_LABEL[item.state] ?? item.state, 10)}${item.message ?? ''}`,
    );
  }
  lines.push('  （* = compat.json requiredCapabilities 里的核心能力）');
  lines.push('');
  lines.push('[结论]');
  if (report.summary.ok) lines.push('  ✓ 兼容：Runtime 版本在支持区间内，且核心能力路由齐全。');
  else if (!health.reachable) lines.push('  ✗ 不兼容：Runtime 不可达。');
  else if (!versionCompat.supported) lines.push(`  ✗ 不兼容：Runtime 版本 ${health.version ?? '(缺失)'} 不在 ${versionCompat.range} 内。`);
  else lines.push(`  ✗ 不兼容：缺少核心能力路由：${summary.coreMissing.join(', ') || '（见上）'}。`);
  if (!report.token.available) lines.push('  ⚠ 未找到 agent token：能力路由的「存在性」判定需要它（401 会先于路由分发），当前结果可能为「需 token」/未验证。');
  const missingAll = report.capabilities.filter((item) => item.state === 'missing').map((item) => item.id);
  if (missingAll.length > 0) lines.push(`  ✗ 缺失路由：${missingAll.join(', ')}（Runtime 构建不匹配或路由改名）。`);
  for (const warning of report.warnings ?? []) lines.push(`  ⚠ ${warning}`);
  if ((report.nextActions ?? []).length > 0) {
    lines.push('');
    lines.push('[下一步]');
    for (const action of report.nextActions) lines.push(`  · ${action}`);
  }
  return lines.join('\n');
}

/** 生成可执行的下一步建议（中文、面向用户）。 */
export function buildNextActions(report) {
  const actions = [];
  const { health, versionCompat, summary, token } = report;
  if (!health.reachable) {
    actions.push(`启动 CircuitPilot（本脚本不会启动/杀进程），或确认 --base-url 指向正确端口（当前 ${report.baseUrl}）。`);
    actions.push('启动后重新执行：npm run plugin:cp:probe（或 node plugin/dsh-circuitpilot/scripts/probe-cp-compat.mjs）。');
    return actions;
  }
  if (!versionCompat.supported) {
    actions.push(
      `把 CircuitPilot 升级/回退到支持区间 ${versionCompat.range}（当前 ${health.version ?? '未返回版本'}）。` +
        '本机若 4178 跑的是旧构建，请换用已安装的 CircuitPilot App / 本仓库 Runtime 0.2.x。',
    );
    actions.push('升级完成后执行：node plugin/dsh-circuitpilot/scripts/sync-compat.mjs（重新验证并按规则放宽区间）。');
    actions.push('不要直接手工调大 compat.json 的 supportedRuntime；先跑 sync 让测试兜底。');
  }
  if (summary.coreMissing.length > 0) {
    actions.push(`当前 Runtime 缺少核心路由（${summary.coreMissing.join(', ')}）：开源版 CircuitPilot 可能没有 agent-* 路由，请换用带 agent 通道的 CircuitPilot App/workspace Runtime。`);
    actions.push('能力判定见 docs/agent/plugin-compat.md；插件运行期也会用同样规则 fail-closed 给出提示。');
  }
  if (!token.available) {
    actions.push('配置 agent token：启动 CircuitPilot 会自动生成 token 文件，或用 CIRCUITPILOT_AGENT_TOKEN_FILE 指向正确文件；不要粘贴 token 内容。');
  }
  if (report.summary.ok) actions.push('无需动作：Runtime 版本与核心能力都兼容。');
  return actions;
}

function buildWarnings(report) {
  const warnings = [];
  const { health, versionCompat, summary, token } = report;
  if (!health.reachable) warnings.push(`Runtime 不可达（${health.error ?? 'unknown'}）`);
  if (health.reachable && !versionCompat.supported) warnings.push(`版本越界：${versionCompat.reason ?? `${health.version} ∉ ${versionCompat.range}`}`);
  if (!token.available) warnings.push(`未找到 agent token（${token.reason ?? '未配置'}）：能力路由存在性可能无法判定`);
  if (summary.unauthorized.length > 0) warnings.push(`以下路由因鉴权未通过而无法判定是否存在：${summary.unauthorized.join(', ')}`);
  if (summary.unknown.length > 0) warnings.push(`以下路由探测结果未知（网络/超时）：${summary.unknown.join(', ')}`);
  for (const item of report.capabilities) {
    if (item.state === 'present' && item.httpStatus === 403) warnings.push(`${item.id} 存在但被 denylist 拒绝（${item.code}）`);
  }
  return warnings;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

export async function run(options, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = options.baseUrl || (typeof env.CIRCUITPILOT_RUNTIME_URL === 'string' && env.CIRCUITPILOT_RUNTIME_URL.trim()) || DEFAULT_BASE_URL;
  const report = await probeRuntime({
    baseUrl,
    tokenFile: options.tokenFile,
    timeoutMs: options.timeoutMs,
    fetchImpl,
    env,
  });
  report.warnings = buildWarnings(report);
  report.nextActions = buildNextActions(report);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHumanReport(report)}\n`);
  }

  if (!report.health.reachable) return EXIT.INCOMPATIBLE;
  if (!report.versionCompat.supported) return EXIT.INCOMPATIBLE;
  // token 缺失时无法判定「缺失」，退化为只校验版本 + 健康；缺失只在能判定时算失败。
  if (report.summary.capabilitiesVerified && report.summary.coreMissing.length > 0) return EXIT.INCOMPATIBLE;
  const missingWhenTokenless = report.capabilities.filter((item) => item.core && item.state === 'missing');
  if (!report.summary.capabilitiesVerified && missingWhenTokenless.length > 0) return EXIT.INCOMPATIBLE;
  return EXIT.OK;
}

async function main(argv = process.argv.slice(2), io = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`参数错误：${error.message}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  try {
    return await run(options, io);
  } catch (error) {
    process.stderr.write(`内部错误：${error?.stack || error}\n`);
    return EXIT.USAGE;
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = await main();
}
