#!/usr/bin/env node
/**
 * CircuitPilot Agent MCP Server（stdio 默认；可选 Streamable HTTP 传输）。
 *
 * 目标：把 plugin/dsh-circuitpilot 的 12 个 CircuitPilot 工具以标准 MCP（Model
 * Context Protocol）server 的形式暴露给任意 MCP 宿主（首选 DSH 的
 * @deepseek-ai/dsh-mcp-client）。工具实现、审批语义、JobManager、结果投影全部
 * 直接复用 `plugin/dsh-circuitpilot/lib/*`，本文件只做三件事：
 *
 *   1. 把 plugin 的 12 个工具投影成 MCP `tools/list`（name/description/inputSchema）；
 *   2. 处理 MCP 的 JSON-RPC 生命周期（initialize / tools/list / tools/call /
 *      ping / notifications/initialized / notifications/cancelled），传输层默认 stdio，
 *      `--http` 时改用 Streamable HTTP（POST /mcp）；
 *   3. 把工具返回值包装成 MCP `CallToolResult`
 *      （content:[{type:'text',text:JSON}] + structuredContent，不暴露审批 token）。
 *
 * 协议兼容边界（重要，见 docs/agent/agent-contract.md 与本目录 README.md）：
 *   - 只实现 MCP **legacy（2025-era）** 的 stdio 子集，协商版本固定为
 *     `2025-11-25`（客户端请求的版本若在支持列表内则回显，否则回落到该版本）。
 *   - 对现代（2026-07-28+）协议探测方法 `server/discover` 一律返回 JSON-RPC
 *     `-32601 Method not found`：这是官方 SDK auto 协商的“明确的 legacy 信号”，
 *     DSH 会据此回退到 initialize 握手（不会改走 2026 现代协议）。
 *   - 不实现 resources / prompts / sampling / logging / tasks / completion 等
 *     能力；客户端若请求这些方法会收到 `-32601`。
 *   - 传输层默认是 MCP 官方 stdio 约定：stdin/stdout 上按行（`\n`）分帧的 JSON-RPC 2.0
 *     消息，stdout 只写合法 JSON 行，所有日志只写 stderr。
 *   - `--http` 时提供 Streamable HTTP（legacy 2025-era 语义）：`POST /mcp` 单响应
 *     `application/json`（通知 202），initialize 响应带 `Mcp-Session-Id`（UUID，非认证）；
 *     `GET /health` 健康检查，`GET /mcp` 405（不实现 SSE），`DELETE /mcp` 204。
 *   - HTTP 传输**可选令牌认证**（task-38）：`--http-token-file`（推荐；文件必须 0600
 *     且 trim 后非空）或仅测试用的 `--http-token`；设置后 `/mcp` 的 POST/GET/DELETE
 *     必须带 `Authorization: Bearer <token>` 或 `x-circuitpilot-mcp-token: <token>`，
 *     失败 401 `MCP_HTTP_UNAUTHORIZED`，不执行 JSON-RPC、不泄工具细节；`GET /health`
 *     公开、未知路径仍 404（都不参与认证）。不配置时保持原行为（仅 loopback）。
 *
 * 零第三方依赖：@modelcontextprotocol/sdk 未安装、也不允许在本 MVP 的根
 * package.json 中新增依赖，因此这里手写最小 JSON-RPC 实现；协议行为由
 * agent/__tests__/ 下的真实子进程测试保证。
 *
 * 安全约束：
 *   - 只调用配置的 CircuitPilot Runtime（RuntimeClient 强制同 origin）；
 *   - agent token 只从文件或显式参数读取，从不写日志、不写入 MCP 响应；
 *   - HTTP 认证 token 只从 0600 文件或显式测试参数读取，常量时间比较，
 *     从不写日志/不写入任何响应（--print-config 也不打印）；
 *   - cp_approve 必须 confirm=true + 已知 planHash；cp_execute 必须有对话批准；
 *     审批 token 只在 MCP server 进程内存中，不返回给模型；
 *   - 写操作幂等键 requestId 由调用方提供，重复 requestId 返回同一 job。
 *
 * 用法：
 *   node agent/mcp-server.mjs [--runtime-url URL] [--token-file PATH] [--token TOKEN]
 *                                  [--approval-mode chat|off] [--max-result-bytes N]
 *                                  [--request-timeout-ms N] [--job-timeout-ms N]
 *                                  [--plan-ttl-ms N] [--approval-ttl-ms N]
 *                                  [--drc-poll-interval-ms N] [--drc-poll-timeout-ms N]
 *                                  [--http] [--http-port N] [--http-host H]
 *                                  [--http-token-file PATH] [--http-token TOKEN]
 *                                  [--help] [--version] [--print-config]
 *
 * 环境变量（flag 优先于 env）：
 *   CIRCUITPILOT_RUNTIME_URL / CIRCUITPILOT_AGENT_TOKEN_FILE / CIRCUITPILOT_AGENT_TOKEN /
 *   CIRCUITPILOT_APPROVAL_MODE / CIRCUITPILOT_MAX_RESULT_BYTES /
 *   CIRCUITPILOT_REQUEST_TIMEOUT_MS / CIRCUITPILOT_JOB_TIMEOUT_MS /
 *   CIRCUITPILOT_MCP_HTTP_PORT / CIRCUITPILOT_MCP_HTTP_HOST /
 *   CIRCUITPILOT_MCP_HTTP_TOKEN_FILE
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { JobManager } from '../plugin/dsh-circuitpilot/lib/jobs.mjs';
import { RuntimeClient } from '../plugin/dsh-circuitpilot/lib/runtime.mjs';
import {
  DEFAULT_TOOL_CONFIG,
  TOOL_NAMES,
  createCircuitPilotTools,
  normalizeToolConfig,
} from '../plugin/dsh-circuitpilot/lib/tools.mjs';
import { DEFAULT_MAX_RESULT_BYTES, failResult } from '../plugin/dsh-circuitpilot/lib/projection.mjs';

/* ------------------------------------------------------------------ */
/* 常量 / 协议元数据                                                   */
/* ------------------------------------------------------------------ */

/** MCP server 身份（wire 上的 serverInfo.name；DSH 的 namespace 由 profile 的 serverName 决定，不用这个值）。 */
export const MCP_SERVER_NAME = 'circuitpilot-agent';
export const MCP_SERVER_VERSION = '0.1.0';

/**
 * 本实现支持的 legacy（2025-era）协议版本，按优先级排列。
 * 与官方 SDK `SUPPORTED_PROTOCOL_VERSIONS` 的 legacy 子集一致；首个元素为默认协商结果。
 */
export const MCP_LEGACY_PROTOCOL_VERSIONS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
]);

/** 默认协商版本（DSH 官方 SDK 的 legacy 握手会 offer 这个版本）。 */
export const MCP_DEFAULT_PROTOCOL_VERSION = MCP_LEGACY_PROTOCOL_VERSIONS[0];

/** JSON-RPC 2.0 错误码。 */
export const MCP_ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/** 现代协议（2026-07-28+）的探测方法；legacy server 必须对它返回 -32601。 */
export const MCP_MODERN_PROBE_METHOD = 'server/discover';

/** 本 server 的协议能力边界（README / 验收对照用，也便于测试断言）。 */
export const MCP_PROTOCOL_SUPPORT = Object.freeze({
  era: 'legacy',
  defaultProtocolVersion: MCP_DEFAULT_PROTOCOL_VERSION,
  legacyProtocolVersions: MCP_LEGACY_PROTOCOL_VERSIONS,
  modernProbeMethod: MCP_MODERN_PROBE_METHOD,
  modernProbeErrorCode: MCP_ERROR_CODES.METHOD_NOT_FOUND,
  transports: Object.freeze(['stdio', 'streamable-http']),
  requests: Object.freeze(['initialize', 'ping', 'tools/list', 'tools/call']),
  notifications: Object.freeze(['notifications/initialized', 'notifications/cancelled']),
  unsupportedCapabilities: Object.freeze(['resources', 'prompts', 'sampling', 'logging', 'tasks', 'completion']),
});

/** Streamable HTTP 传输默认值（与 stdio 共享同一套工具/审批/JobManager 语义）。 */
export const MCP_HTTP_DEFAULT_PORT = 4180;
export const MCP_HTTP_DEFAULT_HOST = '127.0.0.1';
export const MCP_HTTP_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const MCP_HTTP_SESSION_HEADER = 'mcp-session-id';
export const MCP_HTTP_SERVICE = 'circuitpilot-mcp';
/** 可选 HTTP 认证（task-38）：请求头 / 错误码 / token 文件 env 与权限。 */
export const MCP_HTTP_AUTH_HEADER = 'authorization';
export const MCP_HTTP_TOKEN_HEADER = 'x-circuitpilot-mcp-token';
export const MCP_HTTP_AUTH_ERROR = 'MCP_HTTP_UNAUTHORIZED';
export const MCP_HTTP_TOKEN_FILE_ENV = 'CIRCUITPILOT_MCP_HTTP_TOKEN_FILE';
export const MCP_HTTP_TOKEN_FILE_MODE = 0o600;

/** DSH 会把它作为字面文本拼进系统提示词（maxInstructionBytes 默认 32KB，这里刻意保持精简）。 */
export const MCP_INSTRUCTIONS = [
  'CircuitPilot（嘉立创 EDA 电路设计）工具集。契约见 docs/agent/agent-contract.md。',
  '规则：',
  '1) 任何任务先调用 cp_status 读取 Runtime/项目/EDA/写门禁/问题/证据状态；Runtime 离线时不要臆测项目内容。',
  '2) 只读优先：cp_project_context / cp_issues / cp_evidence / cp_knowledge 用于收集事实，引用必须带 evidence（kind/ref/digest），禁止编造。',
  '3) 计划（cp_design_plan / cp_pcb_plan）只生成计划，返回 planHash；必须把目标/操作数/风险/假设/missing 完整展示给用户。',
  '4) 批准（cp_approve）只能在用户于对话中明确批准后调用，且必须 confirm=true；禁止自行批准或猜测用户意图。approvalMode=off 时批准/执行不可用。',
  '5) 执行（cp_execute）必须使用已批准计划 + 唯一 requestId；同一 requestId 幂等，绝不换 key 重放写操作。',
  '6) 长任务（cp_execute/cp_validation/cp_export）用 cp_job wait/status 跟进；超时/取消/失败不代表没生效，先 cp_status/cp_evidence 核对再决定，禁止自动重试写。',
  '7) 写门禁暂停（writeGate.paused）时不要执行任何写操作；让用户在 CircuitPilot 中解除。',
  '8) 结果统一为 {ok, summary, data, evidence, nextActions, truncated}；ok=false 时把 code/message/nextActions 如实报告给用户。',
].join('\n');

/** CLI 帮助文本（写 stderr，保持 stdout 只有 JSON-RPC）。 */
export const MCP_USAGE = `用法: node agent/mcp-server.mjs [options]

MCP stdio server（默认；--http 时改用 Streamable HTTP）（legacy 2025-era 协议子集），
暴露 CircuitPilot 的 12 个工具。
stdio 模式 stdout 只输出 JSON-RPC 行，日志与帮助都写 stderr；
--http 模式监听 POST /mcp（GET /health 健康检查），日志仍只写 stderr。

选项:
  --runtime-url <url>             CircuitPilot Runtime 地址（默认 ${DEFAULT_TOOL_CONFIG.runtimeUrl}）
  --token-file <path>             agent token 文件（默认 ~/Library/Application Support/CircuitPilot/agent-token.json）
  --token <token>                 显式 agent token（测试/受控场景；与 --token-file 互斥）
  --approval-mode <chat|off>      对话审批模式（默认 chat；off 时 cp_approve/cp_execute 拒绝）
  --max-result-bytes <n>          单工具结果上限（默认 ${DEFAULT_MAX_RESULT_BYTES}，范围 1024..262144）
  --request-timeout-ms <n>        Runtime 单请求超时（默认 ${DEFAULT_TOOL_CONFIG.requestTimeoutMs}）
  --job-timeout-ms <n>            长任务超时（默认 ${DEFAULT_TOOL_CONFIG.jobTimeoutMs}）
  --plan-ttl-ms <n>               计划缓存 TTL（默认 ${DEFAULT_TOOL_CONFIG.planTtlMs}）
  --approval-ttl-ms <n>           对话批准 TTL（默认 ${DEFAULT_TOOL_CONFIG.approvalTtlMs}）
  --drc-poll-interval-ms <n>      DRC 轮询间隔（默认 ${DEFAULT_TOOL_CONFIG.drcPollIntervalMs}）
  --drc-poll-timeout-ms <n>       DRC 轮询超时（默认 ${DEFAULT_TOOL_CONFIG.drcPollTimeoutMs}）
  --http                          使用 Streamable HTTP 传输（默认关闭 = stdio）
  --http-port <n>                 HTTP 监听端口（默认 ${MCP_HTTP_DEFAULT_PORT}，范围 1..65535）
  --http-host <host>              HTTP 监听地址（默认 ${MCP_HTTP_DEFAULT_HOST}）
  --http-token-file <path>        HTTP 认证 token 文件（推荐；必须 0600 且非空；
                                  未设置时 --http 无认证，仅 loopback，不推荐）
  --http-token <token>            HTTP 认证 token（仅测试用；会出现在进程列表，不推荐）
  --print-config                  把脱敏后的有效配置（含 transport/httpPort/httpHost/httpAuth）打印到 stderr 后退出
  --version                       打印版本到 stderr 后退出
  --help                          打印本帮助到 stderr 后退出

环境变量（flag 优先）:
  CIRCUITPILOT_RUNTIME_URL / CIRCUITPILOT_AGENT_TOKEN_FILE / CIRCUITPILOT_AGENT_TOKEN /
  CIRCUITPILOT_APPROVAL_MODE / CIRCUITPILOT_MAX_RESULT_BYTES /
  CIRCUITPILOT_REQUEST_TIMEOUT_MS / CIRCUITPILOT_JOB_TIMEOUT_MS /
  CIRCUITPILOT_MCP_HTTP_PORT / CIRCUITPILOT_MCP_HTTP_HOST /
  CIRCUITPILOT_MCP_HTTP_TOKEN_FILE（HTTP 认证 token 文件；文件权限必须 0600）

HTTP 安全边界：
  设置 --http-token-file 后，/mcp 的 POST/GET/DELETE 必须带
  "Authorization: Bearer <token>" 或 "x-circuitpilot-mcp-token: <token>"，
  否则 401 {ok:false,error:"MCP_HTTP_UNAUTHORIZED"}（不执行 JSON-RPC）。
  GET /health 公开；未知路径仍 404。不设置 token 时保持旧行为（仅建议本机使用）。
`;

/* ------------------------------------------------------------------ */
/* 配置解析 / 校验                                                     */
/* ------------------------------------------------------------------ */

/** 配置错误（启动即失败，退出码 2，不要带 token 原文）。 */
export class McpConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'McpConfigError';
    this.code = 'MCP_CONFIG_INVALID';
  }
}

const NUMERIC_FLAGS = Object.freeze({
  '--http-port': 'httpPort',
  '--max-result-bytes': 'maxResultBytes',
  '--request-timeout-ms': 'requestTimeoutMs',
  '--job-timeout-ms': 'jobTimeoutMs',
  '--plan-ttl-ms': 'planTtlMs',
  '--approval-ttl-ms': 'approvalTtlMs',
  '--drc-poll-interval-ms': 'drcPollIntervalMs',
  '--drc-poll-timeout-ms': 'drcPollTimeoutMs',
});

const STRING_FLAGS = Object.freeze({
  '--runtime-url': 'runtimeUrl',
  '--http-host': 'httpHost',
  '--http-token-file': 'httpTokenFile',
  '--http-token': 'httpToken',
  '--token-file': 'tokenFile',
  '--token': 'token',
  '--approval-mode': 'approvalMode',
});

const BOOLEAN_FLAGS = Object.freeze({
  '--http': 'http',
  '--help': 'help',
  '--version': 'version',
  '--print-config': 'printConfig',
});

const ENV_KEYS = Object.freeze({
  runtimeUrl: 'CIRCUITPILOT_RUNTIME_URL',
  httpPort: 'CIRCUITPILOT_MCP_HTTP_PORT',
  httpHost: 'CIRCUITPILOT_MCP_HTTP_HOST',
  httpTokenFile: MCP_HTTP_TOKEN_FILE_ENV,
  tokenFile: 'CIRCUITPILOT_AGENT_TOKEN_FILE',
  token: 'CIRCUITPILOT_AGENT_TOKEN',
  approvalMode: 'CIRCUITPILOT_APPROVAL_MODE',
  maxResultBytes: 'CIRCUITPILOT_MAX_RESULT_BYTES',
  requestTimeoutMs: 'CIRCUITPILOT_REQUEST_TIMEOUT_MS',
  jobTimeoutMs: 'CIRCUITPILOT_JOB_TIMEOUT_MS',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveInt(raw, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) throw new McpConfigError(`${label} 必须是正整数，收到：${text.slice(0, 40) || '(空)'}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new McpConfigError(`${label} 必须在 ${min}..${max} 之间，收到：${text}`);
  }
  return value;
}

/** 解析 argv 的 --flag value / --flag=value 形式；未知 flag 直接报错（不静默忽略）。 */
export function parseMcpArgs(argv = []) {
  const values = {};
  const booleans = {};
  const list = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index]);
    if (!token.startsWith('--')) throw new McpConfigError(`无法识别的参数（应为 --flag）：${token.slice(0, 60)}`);
    const eq = token.indexOf('=');
    const flag = eq >= 0 ? token.slice(0, eq) : token;
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
    if (Object.hasOwn(BOOLEAN_FLAGS, flag)) {
      if (inlineValue !== undefined) throw new McpConfigError(`${flag} 不接受值`);
      booleans[BOOLEAN_FLAGS[flag]] = true;
      continue;
    }
    const numericKey = NUMERIC_FLAGS[flag];
    const stringKey = STRING_FLAGS[flag];
    if (!numericKey && !stringKey) throw new McpConfigError(`未知参数：${flag.slice(0, 60)}`);
    let value = inlineValue;
    if (value === undefined) {
      index += 1;
      value = list[index];
      if (value === undefined) throw new McpConfigError(`${flag} 缺少值`);
    }
    if (numericKey) values[numericKey] = value;
    else values[stringKey] = value;
  }
  return { values, ...booleans };
}

function normalizeRuntimeUrl(raw) {
  const text = String(raw ?? '').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new McpConfigError(`--runtime-url / CIRCUITPILOT_RUNTIME_URL 不是合法 URL：${text.slice(0, 120)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new McpConfigError(`CircuitPilot Runtime 只支持 http/https，收到：${url.protocol}`);
  }
  if (url.username || url.password) throw new McpConfigError('Runtime URL 不允许携带用户名/密码');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function normalizeAgentToken(raw) {
  const token = String(raw ?? '').trim();
  if (!token) return '';
  if (/\s/.test(token)) throw new McpConfigError('agent token 不允许包含空白字符');
  if (token.length < 8 || token.length > 512) throw new McpConfigError('agent token 长度必须在 8..512 之间');
  return token;
}

/** HTTP 认证 token 归一化：trim 后不能为空、不能含空白；长度上限防误配置。 */
function normalizeHttpToken(raw, label = 'HTTP 认证 token') {
  const token = String(raw ?? '').trim();
  if (!token) return '';
  if (/\s/.test(token)) throw new McpConfigError(`${label} 不允许包含空白字符`);
  if (token.length > 512) throw new McpConfigError(`${label} 长度不能超过 512`);
  return token;
}

/**
 * 读取 `--http-token-file`：必须是普通文件、PATH 解析后读取；POSIX 下权限必须恰为 0600
 * （缺失/空/权限过宽都抛 McpConfigError → CLI exit 2）。返回值只给配置内部用，绝不打印。
 */
function readHttpTokenFile(rawPath) {
  const file = path.resolve(String(rawPath ?? '').trim());
  if (!file) throw new McpConfigError('--http-token-file 缺少路径');
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    throw new McpConfigError(`--http-token-file 文件不存在或不可读：${file}（${error?.code || error?.message || error}）`);
  }
  if (!stat.isFile()) throw new McpConfigError(`--http-token-file 必须是普通文件：${file}`);
  if (process.platform !== 'win32') {
    const mode = stat.mode & 0o777;
    if (mode !== MCP_HTTP_TOKEN_FILE_MODE) {
      throw new McpConfigError(`--http-token-file 权限必须是 0600（当前 ${mode.toString(8).padStart(4, '0')}），拒绝过宽权限：${file}`);
    }
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new McpConfigError(`--http-token-file 读取失败：${file}（${error?.code || error?.message || error}）`);
  }
  const token = normalizeHttpToken(raw, '--http-token-file 内容');
  if (!token) throw new McpConfigError(`--http-token-file 内容为空（trim 后）：${file}`);
  return { file, token };
}

/**
 * 把 flags + env + 默认值合并成最终配置；非法输入抛 McpConfigError。
 * help/version/printConfig 也在这里返回，调用方据此决定是否进入 stdio 循环。
 */
export function resolveMcpConfig({ argv = [], env = {} } = {}) {
  const parsedArgs = parseMcpArgs(argv);
  const source = isPlainObject(env) ? env : {};
  const pick = (key, fallback) => {
    if (Object.hasOwn(parsedArgs.values, key)) return parsedArgs.values[key];
    const envKey = ENV_KEYS[key];
    if (envKey && typeof source[envKey] === 'string' && source[envKey].trim()) return source[envKey];
    return fallback;
  };

  const runtimeUrl = normalizeRuntimeUrl(pick('runtimeUrl', DEFAULT_TOOL_CONFIG.runtimeUrl));

  const rawToken = pick('token', '');
  const rawTokenFile = pick('tokenFile', '');
  const token = normalizeAgentToken(rawToken);
  const tokenFile = String(rawTokenFile ?? '').trim();
  if (token && tokenFile) {
    throw new McpConfigError('--token 与 --token-file（或对应环境变量）不能同时设置：请二选一');
  }

  // HTTP 认证（可选）：文件优先读取并校验 0600；--http-token 仅测试用，二者互斥。
  const explicitHttpToken = normalizeHttpToken(pick('httpToken', ''));
  const requestedHttpTokenFile = String(pick('httpTokenFile', '') ?? '').trim();
  if (explicitHttpToken && requestedHttpTokenFile) {
    throw new McpConfigError('--http-token 与 --http-token-file（或 CIRCUITPILOT_MCP_HTTP_TOKEN_FILE）不能同时设置：请二选一');
  }
  let httpToken = '';
  let httpTokenFile = '';
  if (requestedHttpTokenFile) {
    const loaded = readHttpTokenFile(requestedHttpTokenFile);
    httpToken = loaded.token;
    httpTokenFile = loaded.file;
  } else {
    httpToken = explicitHttpToken;
  }
  const httpAuth = httpToken.length > 0;

  const rawApprovalMode = String(pick('approvalMode', DEFAULT_TOOL_CONFIG.approvalMode)).trim();
  const approvalMode = rawApprovalMode === 'off' ? 'off' : rawApprovalMode === 'chat' ? 'chat' : null;
  if (approvalMode === null) {
    throw new McpConfigError(`approvalMode 只能是 "chat" 或 "off"，收到：${rawApprovalMode.slice(0, 40)}`);
  }

  const maxResultBytesRaw = parsePositiveInt(pick('maxResultBytes', String(DEFAULT_TOOL_CONFIG.maxResultBytes)), '--max-result-bytes', { min: 1024, max: 262_144 });
  const maxResultBytes = Math.min(262_144, Math.max(1024, maxResultBytesRaw));
  const requestTimeoutMs = parsePositiveInt(pick('requestTimeoutMs', String(DEFAULT_TOOL_CONFIG.requestTimeoutMs)), '--request-timeout-ms');
  const jobTimeoutMs = parsePositiveInt(pick('jobTimeoutMs', String(DEFAULT_TOOL_CONFIG.jobTimeoutMs)), '--job-timeout-ms');
  const planTtlMs = parsePositiveInt(pick('planTtlMs', String(DEFAULT_TOOL_CONFIG.planTtlMs)), '--plan-ttl-ms');
  const approvalTtlMs = parsePositiveInt(pick('approvalTtlMs', String(DEFAULT_TOOL_CONFIG.approvalTtlMs)), '--approval-ttl-ms');
  const drcPollIntervalMs = parsePositiveInt(pick('drcPollIntervalMs', String(DEFAULT_TOOL_CONFIG.drcPollIntervalMs)), '--drc-poll-interval-ms');
  const drcPollTimeoutMs = parsePositiveInt(pick('drcPollTimeoutMs', String(DEFAULT_TOOL_CONFIG.drcPollTimeoutMs)), '--drc-poll-timeout-ms');

  const httpEnabled = parsedArgs.http === true;
  const httpPort = parsePositiveInt(pick('httpPort', String(MCP_HTTP_DEFAULT_PORT)), '--http-port', { min: 1, max: 65_535 });
  const rawHttpHost = String(pick('httpHost', MCP_HTTP_DEFAULT_HOST) ?? '').trim();
  if (!rawHttpHost || /[\s/]/.test(rawHttpHost) || rawHttpHost.includes('://')) {
    throw new McpConfigError(`--http-host / CIRCUITPILOT_MCP_HTTP_HOST 不是合法主机名/IP：${String(rawHttpHost).slice(0, 80) || '(空)'}`);
  }

  return {
    http: httpEnabled,
    config: {
      transport: httpEnabled ? 'streamable-http' : 'stdio',
      httpPort,
      httpHost: rawHttpHost,
      httpAuth,
      httpTokenFile: httpTokenFile || '',
      // 内部字段，仅用于 runHttpServer 校验；redactConfig 永不输出。
      httpToken: httpToken || '',
      runtimeUrl,
      token,
      tokenFile: tokenFile ? path.resolve(tokenFile) : '',
      approvalMode,
      maxResultBytes,
      requestTimeoutMs,
      jobTimeoutMs,
      planTtlMs,
      approvalTtlMs,
      drcPollIntervalMs,
      drcPollTimeoutMs,
    },
    help: parsedArgs.help === true,
    version: parsedArgs.version === true,
    printConfig: parsedArgs.printConfig === true,
  };
}

/** 便捷包装：只要 config（非法输入直接抛错）。 */
export function parseMcpConfig(options = {}) {
  return resolveMcpConfig(options).config;
}

/** 脱敏后的配置（用于 --print-config / 启动日志）；token 永远不落日志。 */
export function redactConfig(config = {}) {
  return {
    transport: config.transport ?? 'stdio',
    httpPort: config.httpPort ?? null,
    httpHost: config.httpHost ?? null,
    runtimeUrl: config.runtimeUrl ?? null,
    approvalMode: config.approvalMode ?? null,
    tokenSource: config.token ? 'explicit-token' : config.tokenFile ? 'token-file' : 'default-token-file',
    tokenFile: config.tokenFile || null,
    httpAuth: config.httpAuth === true,
    httpTokenFile: config.httpTokenFile || null,
    maxResultBytes: config.maxResultBytes ?? null,
    requestTimeoutMs: config.requestTimeoutMs ?? null,
    jobTimeoutMs: config.jobTimeoutMs ?? null,
    planTtlMs: config.planTtlMs ?? null,
    approvalTtlMs: config.approvalTtlMs ?? null,
  };
}

/** 用 MCP 配置构造 RuntimeClient（token 优先显式值，否则按文件解析）。 */
export function createRuntimeClient(config = {}) {
  return new RuntimeClient({
    baseUrl: config.runtimeUrl,
    timeoutMs: config.requestTimeoutMs,
    ...(config.token ? { token: config.token } : {}),
    ...(!config.token && config.tokenFile ? { tokenFile: config.tokenFile } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* JSON-RPC / MCP 工具                                                   */
/* ------------------------------------------------------------------ */

/**
 * 构造 JSON-RPC 错误响应。id 为 undefined 时省略 id 字段：
 * 官方 MCP schema（JSONRPCErrorResponseSchema）只允许 string|number 类型 id，
 * 不允许 null；无法确定请求 id（解析失败/批量/非法消息）时省略 id 才能被
 * DSH 的官方客户端接受。
 */
function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  const response = { jsonrpc: '2.0', error };
  if (id !== undefined) response.id = id;
  return response;
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

/** 协商版本：客户端请求的版本在 legacy 支持列表内就回显，否则回落到默认 legacy 版本。 */
export function resolveProtocolVersion(requested) {
  return MCP_LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_DEFAULT_PROTOCOL_VERSION;
}

/** 把 plugin 工具定义投影成 MCP tools/list 的 tool 对象（去掉内部 type/execute）。 */
export function buildMcpToolList(tools = []) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: tool.type === 'read',
      destructiveHint: tool.type === 'execute' || tool.type === 'export',
      openWorldHint: false,
    },
  }));
}

/** 统一把工具返回值包装成 MCP CallToolResult；不设置 isError（错误语义在 envelope 的 ok/code 里）。 */
export function toCallToolResult(value) {
  const structured = isPlainObject(value)
    ? value
    : {
      ok: true,
      summary: typeof value === 'string' ? value : '工具返回了非对象结果',
      data: value === undefined ? null : value,
      evidence: [],
      nextActions: [],
      truncated: false,
    };
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * 创建一个 MCP server 实例（不绑定具体 stdin/stdout，便于进程内单元测试与 spawn 测试共用）。
 *
 * @param {object} options
 * @param {object} [options.config] 经 resolveMcpConfig 归一化后的配置
 * @param {object} [options.client] RuntimeClient 兼容对象（测试注入）
 * @param {object} [options.jobs] JobManager 兼容对象（测试注入）
 * @param {(line: string) => void} [options.write] 写一行 JSON-RPC 响应
 * @param {(message: string) => void} [options.log] stderr 日志回调
 * @param {string} [options.serverName] serverInfo.name
 * @param {string} [options.serverVersion] serverInfo.version
 * @param {string} [options.instructions] initialize 返回的 instructions
 * @returns {object} MCP server 句柄
 */
export function createMcpServer({
  config = {},
  client,
  jobs,
  write = () => {},
  log = () => {},
  serverName = MCP_SERVER_NAME,
  serverVersion = MCP_SERVER_VERSION,
  instructions = MCP_INSTRUCTIONS,
} = {}) {
  const cfg = normalizeToolConfig({
    runtimeUrl: config.runtimeUrl ?? DEFAULT_TOOL_CONFIG.runtimeUrl,
    approvalMode: config.approvalMode ?? DEFAULT_TOOL_CONFIG.approvalMode,
    agentTokenFile: config.tokenFile ?? DEFAULT_TOOL_CONFIG.agentTokenFile,
    maxResultBytes: config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_TOOL_CONFIG.requestTimeoutMs,
    jobTimeoutMs: config.jobTimeoutMs ?? DEFAULT_TOOL_CONFIG.jobTimeoutMs,
    planTtlMs: config.planTtlMs ?? DEFAULT_TOOL_CONFIG.planTtlMs,
    approvalTtlMs: config.approvalTtlMs ?? DEFAULT_TOOL_CONFIG.approvalTtlMs,
    drcPollIntervalMs: config.drcPollIntervalMs ?? DEFAULT_TOOL_CONFIG.drcPollIntervalMs,
    drcPollTimeoutMs: config.drcPollTimeoutMs ?? DEFAULT_TOOL_CONFIG.drcPollTimeoutMs,
  });
  const runtime = client ?? createRuntimeClient(cfg);
  const manager = jobs ?? new JobManager({ defaultTimeoutMs: cfg.jobTimeoutMs });
  const tools = createCircuitPilotTools({ config: cfg, client: runtime, jobs: manager });
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const toolList = buildMcpToolList(tools);
  const instructionsText = typeof instructions === 'string' ? instructions : '';

  if (typeof serverName !== 'string' || !serverName.trim()) throw new McpConfigError('serverName 不能为空');
  if (typeof serverVersion !== 'string' || !serverVersion.trim()) throw new McpConfigError('serverVersion 不能为空');
  if (Buffer.byteLength(instructionsText, 'utf8') > 32_768) {
    throw new McpConfigError('instructions 超过 DSH maxInstructionBytes 默认上限 32768 字节');
  }

  const state = {
    initialized: false,
    negotiatedProtocolVersion: null,
    clientInfo: null,
    inFlight: new Map(), // idKey -> AbortController
    cancelled: new Set(), // idKey
    closed: false,
    stats: { requests: 0, toolCalls: 0, toolErrors: 0, cancelled: 0, errors: 0, notified: 0 },
  };

  function sendMessage(message) {
    if (!message) return;
    let line;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      log(`无法序列化 JSON-RPC 响应：${error?.message || error}`);
      return;
    }
    try {
      write(line);
    } catch (error) {
      log(`写 stdout 失败（客户端可能已退出）：${error?.message || error}`);
      state.closed = true;
    }
  }

  async function handleInitialize(id, params) {
    if (state.initialized) {
      return rpcError(id, MCP_ERROR_CODES.INVALID_REQUEST, 'initialize 只能发送一次');
    }
    if (!isPlainObject(params)) {
      return rpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, 'initialize.params 必须是对象');
    }
    if (typeof params.protocolVersion !== 'string' || !params.protocolVersion) {
      return rpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, 'initialize.params.protocolVersion 必须是非空字符串');
    }
    const negotiated = resolveProtocolVersion(params.protocolVersion);
    state.initialized = true;
    state.negotiatedProtocolVersion = negotiated;
    state.clientInfo = isPlainObject(params.clientInfo)
      ? {
        name: typeof params.clientInfo.name === 'string' ? params.clientInfo.name : null,
        version: typeof params.clientInfo.version === 'string' ? params.clientInfo.version : null,
      }
      : null;
    log(`initialize: client=${state.clientInfo?.name ?? 'unknown'} requested=${params.protocolVersion} negotiated=${negotiated}`);
    const result = {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: serverName, version: serverVersion },
    };
    if (instructionsText) result.instructions = instructionsText;
    return rpcResult(id, result);
  }

  async function handleToolsList(id) {
    state.stats.requests += 1;
    return rpcResult(id, { tools: toolList });
  }

  async function handleToolsCall(id, params) {
    if (!isPlainObject(params)) {
      state.stats.errors += 1;
      return rpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, 'tools/call.params 必须是对象');
    }
    const name = params.name;
    if (typeof name !== 'string' || !name.trim()) {
      state.stats.errors += 1;
      return rpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, 'tools/call.params.name 必须是非空字符串');
    }
    const tool = toolsByName.get(name);
    if (!tool) {
      state.stats.errors += 1;
      return rpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, `未知工具：${name.slice(0, 80)}（可用：${TOOL_NAMES.join(', ')}）`);
    }
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isPlainObject(args)) {
      state.stats.errors += 1;
      return rpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, 'tools/call.params.arguments 必须是对象');
    }

    const key = idKey(id);
    const controller = new AbortController();
    state.inFlight.set(key, controller);
    state.stats.toolCalls += 1;
    try {
      const value = await tool.execute(args, { signal: controller.signal });
      if (controller.signal.aborted || state.cancelled.has(key) || state.closed) return null;
      if (value && value.ok === false) state.stats.toolErrors += 1;
      return rpcResult(id, toCallToolResult(value));
    } catch (error) {
      if (controller.signal.aborted || state.closed) return null;
      state.stats.toolErrors += 1;
      log(`tool ${name} 执行异常：${error?.stack || error?.message || error}`);
      return rpcResult(id, toCallToolResult(failResult('MCP_TOOL_EXCEPTION', '工具执行异常（详情已写入 MCP server stderr）', {
        nextActions: ['检查 CircuitPilot Runtime 是否在线；必要时重启 MCP server 或改用插件原生工具', '不要自动重试写操作'],
      })));
    } finally {
      state.inFlight.delete(key);
      state.cancelled.delete(key);
    }
  }

  async function handleRequest(id, method, params) {
    if (method === MCP_MODERN_PROBE_METHOD) {
      // 关键：对现代协议探测返回 -32601 = 官方客户端 auto 协商的“明确 legacy 信号”。
      return rpcError(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, 'server/discover 不支持：本 server 实现 legacy（2025-era）协议，请用 initialize 协商');
    }
    if (method === 'initialize') return handleInitialize(id, params);
    if (method === 'ping') return rpcResult(id, {});
    if (!state.initialized) {
      return rpcError(id, MCP_ERROR_CODES.INVALID_REQUEST, 'server 尚未初始化：请先发送 initialize');
    }
    state.stats.requests += 1;
    switch (method) {
      case 'tools/list':
        return handleToolsList(id);
      case 'tools/call':
        return handleToolsCall(id, params);
      default:
        state.stats.errors += 1;
        return rpcError(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, `不支持的方法：${String(method).slice(0, 80)}`);
    }
  }

  function handleNotification(message) {
    state.stats.notified += 1;
    if (message.method === 'notifications/initialized') {
      return;
    }
    if (message.method === 'notifications/cancelled') {
      const params = isPlainObject(message.params) ? message.params : {};
      const target = params.requestId;
      if (target === undefined) return;
      const key = idKey(target);
      state.cancelled.add(key);
      state.stats.cancelled += 1;
      const controller = state.inFlight.get(key);
      log(`收到取消通知：requestId=${String(target).slice(0, 80)}${controller ? '（已中止执行）' : '（该请求不在执行中）'}`);
      controller?.abort();
    }
    // 其他通知（progress/logging 等）按规范静默忽略。
  }

  /** 处理一条已解析的 JSON-RPC 消息；请求返回响应对象，通知返回 null。 */
  async function handleMessage(message) {
    if (state.closed) return null;
    if (Array.isArray(message)) {
      return rpcError(undefined, MCP_ERROR_CODES.INVALID_REQUEST, '不支持 JSON-RPC 批量请求（MCP 2025-06-18 起已移除）');
    }
    if (!isPlainObject(message)) return rpcError(undefined, MCP_ERROR_CODES.INVALID_REQUEST, 'JSON-RPC 消息必须是对象');
    const hasId = Object.hasOwn(message, 'id') && message.id !== null && message.id !== undefined;
    const id = hasId ? message.id : null;
    if (message.jsonrpc !== '2.0') {
      return hasId ? rpcError(id, MCP_ERROR_CODES.INVALID_REQUEST, 'jsonrpc 必须是 "2.0"') : null;
    }
    if (typeof message.method !== 'string' || !message.method) {
      return hasId ? rpcError(id, MCP_ERROR_CODES.INVALID_REQUEST, 'method 必须是非空字符串') : null;
    }
    if (!hasId) {
      handleNotification(message);
      return null;
    }
    if (typeof id !== 'string' && typeof id !== 'number') {
      return rpcError(undefined, MCP_ERROR_CODES.INVALID_REQUEST, 'id 必须是字符串或数字');
    }
    return handleRequest(id, message.method, message.params);
  }

  /** 处理 stdin 的一行：解析 JSON、分发、写响应；解析失败写 -32700。 */
  async function handleLine(line) {
    if (typeof line !== 'string') return;
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      state.stats.errors += 1;
      sendMessage(rpcError(undefined, MCP_ERROR_CODES.PARSE_ERROR, `JSON 解析失败：${String(error?.message || error).slice(0, 160)}`));
      return;
    }
    const response = await handleMessage(message);
    if (response) sendMessage(response);
  }

  /** 关闭：中止所有执行中的请求，之后的输入与输出都被忽略。 */
  function close() {
    if (state.closed) return;
    state.closed = true;
    for (const controller of state.inFlight.values()) controller.abort();
    state.inFlight.clear();
  }

  return {
    serverName,
    serverVersion,
    instructions: instructionsText,
    config: cfg,
    tools,
    toolList,
    protocol: MCP_PROTOCOL_SUPPORT,
    get state() {
      return {
        initialized: state.initialized,
        negotiatedProtocolVersion: state.negotiatedProtocolVersion,
        clientInfo: state.clientInfo ? { ...state.clientInfo } : null,
        inFlight: state.inFlight.size,
        closed: state.closed,
      };
    },
    stats() {
      return { ...state.stats, inFlight: state.inFlight.size };
    },
    handleMessage,
    handleLine,
    close,
  };
}

/* ------------------------------------------------------------------ */
/* stdin/stdout 主循环                                                  */
/* ------------------------------------------------------------------ */

/**
 * 在给定 stdin/stdout 上运行 MCP stdio server，直到 stdin 关闭或收到终止信号。
 *
 * @param {object} options
 * @param {NodeJS.ReadableStream} [options.stdin]
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {NodeJS.WritableStream} [options.stderr]
 * @param {object} [options.config]
 * @param {object} [options.client]
 * @param {object} [options.jobs]
 * @param {number} [options.shutdownGraceMs] stdin 关闭后等待执行中请求的宽限时间
 * @returns {Promise<{stats: object}>}
 */
export async function runStdioServer({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  config = {},
  client,
  jobs,
  shutdownGraceMs = 5_000,
} = {}) {
  let closed = false;
  const pending = new Set();
  const logLine = (message) => {
    try {
      stderr.write(`[circuitpilot-mcp] ${message}\n`);
    } catch {
      // stderr 写失败不影响协议通道。
    }
  };
  const server = createMcpServer({
    config,
    client,
    jobs,
    write: (line) => {
      if (closed) return;
      try {
        stdout.write(line);
      } catch (error) {
        logLine(`写 stdout 失败（客户端可能已退出）：${error?.message || error}`);
        closed = true;
      }
    },
    log: logLine,
  });

  const reader = createInterface({ input: stdin, crlfDelay: Infinity });
  let onSignal;
  const finished = new Promise((resolve) => {
    reader.once('close', resolve);
    reader.on('line', (line) => {
      if (closed) return;
      const task = server.handleLine(line)
        .catch((error) => {
          logLine(`处理输入行失败：${error?.message || error}`);
        });
      pending.add(task);
      task.finally(() => pending.delete(task));
    });
    if (typeof stdout.on === 'function') {
      stdout.on('error', () => {
        closed = true;
        resolve();
      });
    }
    onSignal = () => {
      closed = true;
      resolve();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });

  await finished;
  closed = true;
  reader.close();
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  // stdin 关闭后仍可能有执行中的请求：给一个有限宽限期，超时就中止并退出。
  if (pending.size > 0) {
    const grace = Number.isFinite(shutdownGraceMs) && shutdownGraceMs > 0 ? shutdownGraceMs : 5_000;
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, grace);
        timer.unref?.();
      }),
    ]);
  }
  server.close();
  return { stats: server.stats() };
}

/* ------------------------------------------------------------------ */
/* Streamable HTTP 传输                                                */
/* ------------------------------------------------------------------ */

/** 写一个 JSON 响应（不打印 token/body 到日志）。 */
function writeHttpJson(response, status, payload, headers = {}) {
  const hasBody = payload !== undefined;
  response.writeHead(status, {
    ...(hasBody ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(hasBody ? JSON.stringify(payload) : '');
}

/** 读取 POST body；超过上限返回 MCP_HTTP_BODY_TOO_LARGE（HTTP 413）。 */
function readHttpBody(request, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        // 不再缓存，但继续 drain：让 413 响应能正常写回客户端（直接 destroy 会变成 ECONNRESET）。
        request.removeAllListeners('data');
        request.resume();
        finish(Object.assign(new Error(`请求体超过上限 ${limitBytes} 字节`), { code: 'MCP_HTTP_BODY_TOO_LARGE', status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    request.on('error', (error) => finish(Object.assign(new Error('读取请求体失败'), { cause: error })));
    request.on('close', () => finish(Object.assign(new Error('客户端在请求体传输完成前断开'), { code: 'MCP_HTTP_ABORTED' })));
  });
}

function httpLogger(log) {
  if (typeof log === 'function') {
    return (message) => { try { log(message); } catch { /* 日志失败不影响协议 */ } };
  }
  return (message) => {
    try { process.stderr.write(`[circuitpilot-mcp-http] ${message}\n`); } catch { /* stderr 已关闭 */ }
  };
}

/** 取单个请求头值（Node 对重复 header 可能给数组）。 */
function headerText(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : '';
  return typeof value === 'string' ? value : '';
}

/**
 * 从请求提取候选 token：优先 `Authorization: Bearer <token>`，其次
 * `x-circuitpilot-mcp-token: <token>`。只返回值，不写日志。
 */
function requestAuthToken(request) {
  const authorization = headerText(request?.headers, MCP_HTTP_AUTH_HEADER).trim();
  const bearer = /^Bearer[ \t]+(.+)$/i.exec(authorization);
  if (bearer) {
    const token = bearer[1].trim();
    if (token) return token;
  }
  return headerText(request?.headers, MCP_HTTP_TOKEN_HEADER).trim();
}

/**
 * 常量时间比较：先对两侧做 SHA-256，再 timingSafeEqual（固定 32 字节），
 * 避免长度差异/前缀匹配泄漏。token 只参与哈希，不落日志/响应。
 */
function httpTokenMatches(provided, expected) {
  if (typeof provided !== 'string' || !provided) return false;
  if (typeof expected !== 'string' || !expected) return false;
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

/** 401 响应：固定 JSON（无工具细节、无 token），不执行任何 JSON-RPC。 */
function writeHttpUnauthorized(response) {
  writeHttpJson(response, 401, { ok: false, error: MCP_HTTP_AUTH_ERROR }, { 'www-authenticate': 'Bearer' });
}

/**
 * 启动 MCP Streamable HTTP 传输（legacy 2025-era 语义；默认 stdio 仍保留）。
 *
 * 端点：
 *   POST   /mcp    JSON-RPC（单响应 200 application/json；通知 202；畸形 JSON 400/-32700；
 *                  8MB body 上限 → 413）。initialize 成功响应带 Mcp-Session-Id（UUID），
 *                  后续请求带/不带该 header 都接受（仅会话标识，不作认证）。
 *   GET    /mcp    405（本实现不提供 SSE 长连接/服务器推送）
 *   DELETE /mcp    204（结束当前 MCP 会话；下一个 initialize 重新开始）
 *   GET    /health 200 {ok:true,service:'circuitpilot-mcp',transport:'streamable-http'}
 *   其他路径       404
 *
 * @param {object} [options]
 * @param {number} [options.port] 监听端口；0 表示随机空闲端口（测试用）
 * @param {string} [options.host] 监听地址（默认 127.0.0.1）
 * @param {object} [options.config] 经 resolveMcpConfig 归一化后的配置
 * @param {object} [options.client] RuntimeClient 兼容对象（测试注入）
 * @param {object} [options.jobs] JobManager 兼容对象（测试注入）
 * @param {string} [options.authToken] 可选 HTTP 认证 token；设置后 /mcp 强制 Bearer/x header
 * @param {(message: string) => void} [options.log] 日志回调；默认写 stderr，绝不写 stdout/token
 * @returns {Promise<{server: import('node:http').Server, port: number, close: () => Promise<void>}>}
 */
export async function runHttpServer({
  port = MCP_HTTP_DEFAULT_PORT,
  host = MCP_HTTP_DEFAULT_HOST,
  config = {},
  client,
  jobs,
  authToken = '',
  log,
} = {}) {
  const writeLog = httpLogger(log);
  // 显式 authToken 优先；否则沿用 config.httpToken（resolveMcpConfig 已从 0600 文件读出）。
  const expectedAuthToken = typeof authToken === 'string' && authToken.trim()
    ? authToken.trim()
    : typeof config?.httpToken === 'string' ? config.httpToken.trim() : '';
  const authEnabled = expectedAuthToken.length > 0;
  const runtimeClient = client ?? createRuntimeClient(config);
  const jobManager = jobs ?? new JobManager({ defaultTimeoutMs: config.jobTimeoutMs ?? DEFAULT_TOOL_CONFIG.jobTimeoutMs });
  const createSession = () => createMcpServer({ config, client: runtimeClient, jobs: jobManager, log: writeLog });
  let mcp = createSession();
  let sessionId = randomUUID();

  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${host}`);
    const method = request.method || 'GET';
    try {
      if (url.pathname === '/health') {
        if (method !== 'GET') {
          response.setHeader('allow', 'GET');
          return writeHttpJson(response, 405, { ok: false, error: { code: 'MCP_HTTP_METHOD_NOT_ALLOWED', message: '/health 只支持 GET' } });
        }
        return writeHttpJson(response, 200, { ok: true, service: MCP_HTTP_SERVICE, transport: 'streamable-http' });
      }

      if (url.pathname !== '/mcp') {
        return writeHttpJson(response, 404, { ok: false, error: { code: 'MCP_HTTP_NOT_FOUND', message: '未知路径（MCP 端点为 POST /mcp，健康检查为 GET /health）' } });
      }

      // 可选认证：只拦 /mcp（health 已公开、未知路径已 404）；失败不执行 JSON-RPC。
      if (authEnabled) {
        const providedToken = requestAuthToken(request);
        if (!httpTokenMatches(providedToken, expectedAuthToken)) {
          writeLog(`拒绝 ${method} /mcp：HTTP 认证失败（401）`);
          return writeHttpUnauthorized(response);
        }
      }

      if (method === 'GET') {
        // legacy Streamable HTTP 的 GET 用于 SSE 服务器推送；本实现明确不支持（405，不静默挂起）。
        response.setHeader('allow', 'POST, DELETE');
        return writeHttpJson(response, 405, { ok: false, error: { code: 'MCP_HTTP_GET_UNSUPPORTED', message: 'GET /mcp 不支持 SSE；请使用 POST /mcp 发送 JSON-RPC' } });
      }

      if (method === 'DELETE') {
        mcp.close();
        mcp = createSession();
        sessionId = randomUUID();
        response.writeHead(204, { [MCP_HTTP_SESSION_HEADER]: sessionId });
        return response.end();
      }

      if (method !== 'POST') {
        response.setHeader('allow', 'POST, DELETE');
        return writeHttpJson(response, 405, { ok: false, error: { code: 'MCP_HTTP_METHOD_NOT_ALLOWED', message: `/mcp 不支持 ${method}` } });
      }

      let text;
      try {
        text = await readHttpBody(request, MCP_HTTP_BODY_LIMIT_BYTES);
      } catch (error) {
        if (error?.status === 413) {
          response.setHeader('connection', 'close');
          return writeHttpJson(response, 413, rpcError(undefined, MCP_ERROR_CODES.INVALID_REQUEST, error.message));
        }
        return writeHttpJson(response, 400, rpcError(undefined, MCP_ERROR_CODES.INVALID_REQUEST, '读取请求体失败'));
      }

      let message;
      try {
        message = JSON.parse(text);
      } catch (error) {
        return writeHttpJson(response, 400, rpcError(
          undefined,
          MCP_ERROR_CODES.PARSE_ERROR,
          `JSON 解析失败：${String(error?.message || error).slice(0, 160)}`,
        ));
      }

      let reply;
      try {
        reply = await mcp.handleMessage(message);
      } catch (error) {
        writeLog(`处理 JSON-RPC 消息异常：${error?.message || error}`);
        return writeHttpJson(response, 500, rpcError(undefined, MCP_ERROR_CODES.INTERNAL_ERROR, 'MCP server 内部错误'));
      }

      // 通知（无 id，或取消后不返回响应）→ 202 空 body，符合 Streamable HTTP 语义。
      if (reply === null) {
        response.writeHead(202, { 'cache-control': 'no-store' });
        return response.end();
      }

      const headers = {};
      if (isPlainObject(message) && message.method === 'initialize' && reply && reply.result !== undefined) {
        headers[MCP_HTTP_SESSION_HEADER] = sessionId;
      }
      return writeHttpJson(response, 200, reply, headers);
    } catch (error) {
      writeLog(`HTTP 请求处理异常：${error?.message || error}`);
      if (!response.headersSent) {
        return writeHttpJson(response, 500, rpcError(undefined, MCP_ERROR_CODES.INTERNAL_ERROR, 'MCP HTTP 传输内部错误'));
      }
      try { response.end(); } catch { /* 已结束 */ }
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('error', (error) => writeLog(`HTTP server 错误：${error?.code || error?.message || error}`));

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  const actualPort = server.address().port;
  writeLog(`Streamable HTTP listening on http://${host}:${actualPort}/mcp`);
  if (authEnabled) {
    writeLog('HTTP 认证已启用（要求 Authorization: Bearer <token> 或 x-circuitpilot-mcp-token）');
  } else {
    writeLog('WARNING: HTTP 未配置认证（本机任意进程均可调用工具），建议 --http-token-file；仅应监听 127.0.0.1');
  }

  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolve) => {
      mcp.close();
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* 已关闭 */ }
      }
    });
    return closePromise;
  };

  return { server, port: actualPort, close };
}

/* ------------------------------------------------------------------ */
/* CLI 入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * CLI 主函数。返回值即退出码：0 正常、1 运行时错误、2 配置错误。
 * 注意：--help/--version/--print-config 全部写 stderr，保证 stdout 只有 JSON-RPC。
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let resolved;
  try {
    resolved = resolveMcpConfig({ argv, env });
  } catch (error) {
    stderr.write(`[circuitpilot-mcp] 配置错误：${error?.message || error}\n\n${MCP_USAGE}`);
    return 2;
  }
  if (resolved.help) {
    stderr.write(MCP_USAGE);
    return 0;
  }
  if (resolved.version) {
    stderr.write(`${MCP_SERVER_NAME} ${MCP_SERVER_VERSION} (MCP ${MCP_DEFAULT_PROTOCOL_VERSION})\n`);
    return 0;
  }
  if (resolved.printConfig) {
    stderr.write(`${JSON.stringify(redactConfig(resolved.config), null, 2)}\n`);
    return 0;
  }

  const config = resolved.config;

  if (resolved.http) {
    const logLine = (message) => {
      try { stderr.write(`[circuitpilot-mcp-http] ${message}\n`); } catch { /* stderr 已关闭 */ }
    };
    const started = await runHttpServer({
      port: config.httpPort,
      host: config.httpHost,
      config,
      client: createRuntimeClient(config),
      jobs: new JobManager({ defaultTimeoutMs: config.jobTimeoutMs }),
      authToken: config.httpAuth ? config.httpToken : '',
      log: logLine,
    });
    stderr.write(
      `[circuitpilot-mcp] ${MCP_SERVER_NAME} ${MCP_SERVER_VERSION} 启动（streamable-http）：`
      + `http://${config.httpHost}:${started.port}/mcp runtime=${config.runtimeUrl} `
      + `approvalMode=${config.approvalMode} httpAuth=${config.httpAuth ? 'on' : 'off'} `
      + `tokenSource=${config.token ? 'explicit-token' : config.tokenFile ? 'token-file' : 'default-token-file'}\n`,
    );
    await new Promise((resolve) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await started.close();
    return 0;
  }

  stderr.write(
    `[circuitpilot-mcp] ${MCP_SERVER_NAME} ${MCP_SERVER_VERSION} 启动：runtime=${config.runtimeUrl} `
    + `approvalMode=${config.approvalMode} tokenSource=${config.token ? 'explicit-token' : config.tokenFile ? 'token-file' : 'default-token-file'}\n`,
  );
  await runStdioServer({
    stdin,
    stdout,
    stderr,
    config,
    client: createRuntimeClient(config),
    jobs: new JobManager({ defaultTimeoutMs: config.jobTimeoutMs }),
  });
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath && invokedPath === import.meta.url) {
  main()
    .then((code) => {
      process.exitCode = Number.isInteger(code) ? code : 0;
    })
    .catch((error) => {
      process.stderr.write(`[circuitpilot-mcp] 致命错误：${error?.stack || error?.message || error}\n`);
      process.exitCode = 1;
    });
}
