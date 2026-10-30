#!/usr/bin/env node
/**
 * MCP Streamable HTTP + Live Runtime 端到端验收（task-36）。
 *
 * 自包含默认模式：
 *   1) 在随机空闲回环端口 spawn 真实子进程 `node runtime/server.mjs`（临时
 *      state/token/audit/key/head/evidence/job-journal；不连 4178、不连 EDA）；
 *   2) 再 spawn 真实子进程 `node agent/mcp-server.mjs --http --http-port <free>
 *      --runtime-url <base> --token-file <temp token>`，等 GET /health 返回
 *      `transport=streamable-http`；
 *   3) 通过真实 HTTP 跑 MCP 矩阵：initialize(2025-11-25)/session、通知 202、
 *      tools/list 12 工具名集合、tools/call cp_status（真实 Runtime + agent token）、
 *      响应无 token/key 泄漏、MCP 子进程 stdout 0 字节、端点边界；
 *   4) SIGTERM 两个子进程、删除临时目录，检查端口无残留；PASS x/y，exit 0/1。
 *
 * 用法：
 *   npm run verify:agent-mcp-live
 *   node scripts/agent-mcp-live-acceptance.mjs
 *
 * 退出码：0 = 全部 PASS；1 = 有 FAIL/运行错误/清理异常。
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { TOOL_NAMES } from '../plugin/dsh-circuitpilot/lib/tools.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER_SCRIPT = 'agent/mcp-server.mjs';
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const RUNTIME_HEALTH_TIMEOUT_MS = 12_000;
const MCP_HEALTH_TIMEOUT_MS = 15_000;
const MATRIX_TIMEOUT_MS = 10_000;
const TOKEN_PATTERN = /^cpa_[0-9a-fA-F]{48}$/;
const TOKEN_LIKE_PATTERN = /cpa_[0-9a-fA-F]{48}/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

function parseArgs(argv) {
  const options = { help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}（支持 --help）`);
  }
  return options;
}

function printUsage() {
  log('用法：');
  log('  npm run verify:agent-mcp-live   # 自包含：真实 Runtime 子进程 + 真实 MCP Streamable HTTP 子进程');
  log('  node scripts/agent-mcp-live-acceptance.mjs');
}

/** 取一个随机空闲回环端口（listen 0 后立即关闭，由子进程复用）。 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** 子进程退出后端口可再次 listen = 无端口残留。 */
function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function readAgentTokenFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw Object.assign(new Error(`读取 agent token 文件失败：${file}（${error?.code || 'PARSE_ERROR'}）`), { cause: error });
  }
  const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
  if (!TOKEN_PATTERN.test(token)) {
    throw Object.assign(new Error(`agent token 文件内容非法（token 形状不符）：${file}`), { code: 'AGENT_TOKEN_INVALID' });
  }
  return token;
}

async function waitForAgentToken(file, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return readAgentTokenFile(file);
    } catch (error) {
      if (error?.cause?.code !== 'ENOENT' && error?.code !== 'ENOENT') throw error;
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`等待 agent token 文件超时（${timeoutMs}ms）：${file}${lastError ? `；${lastError.message}` : ''}`);
}

/** 读取可能存在的审计密钥文件（仅用于“绝不泄漏”检查；不会打印内容）。 */
function collectKeyMaterial(env = process.env) {
  const candidates = [];
  const explicit = typeof env.CIRCUITPILOT_AGENT_AUDIT_KEY_FILE === 'string' ? env.CIRCUITPILOT_AGENT_AUDIT_KEY_FILE.trim() : '';
  if (explicit) candidates.push(explicit);
  const audit = typeof env.CIRCUITPILOT_AGENT_AUDIT_FILE === 'string' ? env.CIRCUITPILOT_AGENT_AUDIT_FILE.trim() : '';
  if (audit) candidates.push(path.join(path.dirname(audit), 'agent-audit.key.json'));
  const stateDir = typeof env.CIRCUITPILOT_STATE_DIR === 'string' ? env.CIRCUITPILOT_STATE_DIR.trim() : '';
  if (stateDir) candidates.push(path.join(stateDir, 'agent-audit.key.json'));
  candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'CircuitPilot', 'agent-audit.key.json'));

  const keys = new Set();
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed?.key === 'string' && /^[0-9a-f]{64}$/i.test(parsed.key)) keys.add(parsed.key);
    } catch {
      // 密钥文件不存在/不可读：跳过（不是本检查的失败条件）。
    }
  }
  return [...keys];
}

function scrubEvidence(text, secrets) {
  let output = String(text ?? '');
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[redacted]');
  }
  return output.replace(TOKEN_LIKE_PATTERN, '[redacted]');
}

async function waitFor(fn, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  if (lastError) throw lastError;
  return null;
}

function appendTail(current, chunk) {
  return `${current}${chunk.toString('utf8')}`.slice(-64 * 1024);
}

function spawnNode(args, { cwd = REPO_ROOT, env, label }) {
  const state = {
    label,
    exited: false,
    code: null,
    signal: null,
    stdoutBytes: 0,
    stdoutTail: '',
    stderrTail: '',
    spawnError: null,
  };
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.once('error', (error) => { state.spawnError = error; });
  child.stdout.on('data', (chunk) => {
    state.stdoutBytes += chunk.length;
    state.stdoutTail = appendTail(state.stdoutTail, chunk);
  });
  child.stderr.on('data', (chunk) => { state.stderrTail = appendTail(state.stderrTail, chunk); });
  child.once('exit', (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
  });
  return { child, state };
}

async function stopChild(spawned) {
  if (!spawned?.child || spawned.state.exited) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { spawned.child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve();
    }, 5_000);
    spawned.child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { spawned.child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
}

async function callRuntimeHealth(base) {
  const response = await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应保留 text */ }
  return { status: response.status, headers: response.headers, json, text };
}

async function callRuntime(base, pathname, { method = 'GET', agentToken, body } = {}) {
  const headers = { origin: TRUSTED_ORIGIN };
  if (agentToken) headers['x-circuitpilot-agent-token'] = agentToken;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留 text 作为证据 */ }
  return { status: response.status, headers: response.headers, json, text };
}

async function waitForRuntimeHealth(base, state, timeoutMs = RUNTIME_HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (state?.spawnError) throw state.spawnError;
    if (state?.exited) throw new Error(`Runtime 子进程提前退出（code=${state.code} signal=${state.signal}）\n${state.stderrTail}`);
    try {
      const health = await callRuntimeHealth(base);
      if (health.status === 200 && health.json?.ok === true) return health;
      lastError = new Error(`/api/health status=${health.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`等待 Runtime ${base}/api/health 就绪超时（${timeoutMs}ms）${lastError ? `：${lastError?.code || lastError?.message}` : ''}`);
}

async function callMcp(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留 text 作为证据 */ }
  return { status: response.status, headers: response.headers, json, text };
}

async function waitForMcpHealth(base, state, timeoutMs = MCP_HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (state?.spawnError) throw state.spawnError;
    if (state?.exited) throw new Error(`MCP 子进程提前退出（code=${state.code} signal=${state.signal}）\n${state.stderrTail}`);
    try {
      const health = await callMcp(base, '/health');
      const body = health.json;
      if (health.status === 200 && body?.ok === true && body?.transport === 'streamable-http') return health;
      lastError = new Error(`/health status=${health.status} transport=${body?.transport ?? 'n/a'}`);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`等待 MCP ${base}/health transport=streamable-http 超时（${timeoutMs}ms）${lastError ? `：${lastError?.code || lastError?.message}` : ''}`);
}

/**
 * 验收矩阵（真实 Runtime + 真实 MCP HTTP 子进程）。
 * @returns {Promise<{passed: number, total: number, failures: string[]}>}
 */
async function runMatrix({ runtimeBase, mcpBase, agentToken, env, mcpState }) {
  const results = [];
  const secrets = [agentToken].filter(Boolean);
  let sessionId = '';

  const assertOk = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const assertNoLeak = (payload, label) => {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const secret of secrets) {
      if (secret && serialized.includes(secret)) throw new Error(`${label} 泄漏 agent token`);
    }
    assertOk(!TOKEN_LIKE_PATTERN.test(serialized), `${label} 出现 cpa_ 样式令牌字符串`);
    return serialized.length;
  };
  const rpc = (payload, headers = {}) => callMcp(mcpBase, '/mcp', {
    method: 'POST',
    headers: {
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...headers,
    },
    body: payload,
  });

  let index = 0;
  const check = async (name, fn) => {
    index += 1;
    try {
      const evidence = await fn();
      results.push({ ok: true, name, evidence });
      log(`[PASS] ${index}. ${name}${evidence ? ` — ${evidence}` : ''}`);
    } catch (error) {
      results.push({ ok: false, name, evidence: error?.message || String(error) });
      log(`[FAIL] ${index}. ${name} — ${scrubEvidence(error?.message || error, secrets)}`);
    }
  };

  // 1) 真实 Runtime 健康（证明不是 fake/未连 4178）
  await check('真实 Runtime 子进程 /api/health：200 ok', async () => {
    const health = await waitForRuntimeHealth(runtimeBase, null, 2_000);
    assertOk(health.status === 200, `status=${health.status}`);
    assertOk(health.json?.ok === true, 'body.ok !== true');
    assertOk(typeof health.json?.version === 'string' && health.json.version, 'health.version 缺失');
    secrets.push(...collectKeyMaterial(env));
    return `service=${health.json?.service} version=${health.json.version}`;
  });

  // 2) 真实 MCP HTTP 子进程健康
  await check('MCP 子进程 GET /health：200 + transport=streamable-http', async () => {
    const health = await waitForMcpHealth(mcpBase, mcpState, 2_000);
    assertOk(health.status === 200, `status=${health.status}`);
    assertOk(health.json?.ok === true, 'body.ok !== true');
    assertOk(health.json?.service === 'circuitpilot-mcp', `service=${health.json?.service}`);
    assertOk(health.json?.transport === 'streamable-http', `transport=${health.json?.transport}`);
    return `service=${health.json.service} transport=${health.json.transport} port=${new URL(mcpBase).port}`;
  });

  // 3) initialize + Mcp-Session-Id
  await check('POST /mcp initialize：200 application/json + Mcp-Session-Id UUID + 2025-11-25', async () => {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'agent-mcp-live-acceptance', version: '0.1.0' },
      },
    });
    assertOk(init.status === 200, `status=${init.status} body=${scrubEvidence(init.text, secrets).slice(0, 200)}`);
    assertOk((init.headers.get('content-type') || '').includes('application/json'), `content-type=${init.headers.get('content-type')}`);
    const session = init.headers.get('mcp-session-id') || '';
    assertOk(UUID_PATTERN.test(session), `Mcp-Session-Id 非 UUID：${session || '(空)'}`);
    assertOk(init.json?.result?.protocolVersion === '2025-11-25', `protocolVersion=${init.json?.result?.protocolVersion}`);
    assertOk(init.json?.result?.serverInfo?.name === 'circuitpilot-agent', `serverInfo.name=${init.json?.result?.serverInfo?.name}`);
    assertOk(init.json?.result?.serverInfo?.version === '0.1.0', `serverInfo.version=${init.json?.result?.serverInfo?.version}`);
    assertNoLeak(init.json, 'initialize 响应');
    sessionId = session;
    return `protocolVersion=2025-11-25 session=${session.slice(0, 8)}… serverInfo=circuitpilot-agent/0.1.0`;
  });

  // 4) 通知 → 202 空 body
  await check('POST /mcp notifications/initialized：202 空 body', async () => {
    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assertOk(note.status === 202, `status=${note.status}`);
    assertOk(note.text === '', `body 非空：${note.text.slice(0, 120)}`);
    return '202 空 body';
  });

  // 5) tools/list 12 工具名集合
  await check('POST /mcp tools/list：12 个工具且名称集合与 TOOL_NAMES 一致', async () => {
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assertOk(list.status === 200, `status=${list.status} body=${scrubEvidence(list.text, secrets).slice(0, 200)}`);
    const tools = list.json?.result?.tools;
    assertOk(Array.isArray(tools), 'result.tools 不是数组');
    assertOk(tools.length === 12, `tools.length=${tools.length}`);
    const names = tools.map((tool) => tool?.name).sort();
    const expected = [...TOOL_NAMES].sort();
    assertOk(JSON.stringify(names) === JSON.stringify(expected), `工具集合不符：${names.join(',')}`);
    const unique = new Set(names);
    assertOk(unique.size === 12, `工具名重复：${names.join(',')}`);
    assertOk(tools.every((tool) => tool?.inputSchema?.type === 'object'), '存在 inputSchema.type !== object 的工具');
    assertNoLeak(list.json, 'tools/list 响应');
    return `12 tools 名称集合一致 unique=${unique.size}`;
  });

  // 6) tools/call cp_status：真实 Runtime + agent token 链路
  await check('POST /mcp tools/call cp_status：200 CallToolResult + data.runtime/eda', async () => {
    const call = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'cp_status', arguments: {} },
    });
    assertOk(call.status === 200, `status=${call.status} body=${scrubEvidence(call.text, secrets).slice(0, 300)}`);
    const result = call.json?.result;
    assertOk(result && typeof result === 'object', 'result 缺失');
    assertOk(Array.isArray(result.content) && result.content.length >= 1, 'result.content 不是非空数组');
    assertOk(result.content[0]?.type === 'text', `content[0].type=${result.content[0]?.type}`);
    let envelope;
    try {
      envelope = JSON.parse(result.content[0].text);
    } catch {
      throw new Error('content[0].text 不是 JSON');
    }
    assertOk(envelope?.ok === true, `envelope.ok=${envelope?.ok} code=${envelope?.code ?? 'n/a'} message=${envelope?.message ?? ''}`);
    assertOk(result.structuredContent && typeof result.structuredContent === 'object', 'structuredContent 缺失');
    assertOk(result.structuredContent.ok === true, `structuredContent.ok=${result.structuredContent.ok}`);
    const data = result.structuredContent.data;
    assertOk(data?.runtime?.reachable === true, `data.runtime.reachable=${data?.runtime?.reachable}`);
    assertOk(typeof data?.runtime?.version === 'string' && data.runtime.version, 'data.runtime.version 缺失（未走真实 Runtime？）');
    assertOk(data?.eda && typeof data.eda === 'object' && 'online' in data.eda, 'data.eda.online 缺失');
    assertOk(Array.isArray(result.structuredContent.evidence), 'structuredContent.evidence 不是数组');
    assertNoLeak(call.json, 'cp_status 响应');
    return `ok=true runtime.version=${data.runtime.version} eda.online=${data.eda.online} evidence=${result.structuredContent.evidence.length}`;
  });

  // 7) cp_status 响应无 agent token / cpa_ / 审计 key
  await check('cp_status 响应无 agent token / cpa_ / 审计密钥', async () => {
    // 先用 agent 通道触发一次 403（Runtime 会写 denied 审计并生成 HMAC 密钥），
    // 确保“无审计 key”检查有真实密钥可比对，而不是空集合。
    const denied = await callRuntime(runtimeBase, '/api/agent/audit', { agentToken });
    assertOk(denied.status === 403, `agent 访问 /api/agent/audit status=${denied.status}`);
    assertOk(denied.json?.error?.code === 'AGENT_ROUTE_FORBIDDEN', `error.code=${denied.json?.error?.code}`);
    const keyFile = env.CIRCUITPILOT_AGENT_AUDIT_KEY_FILE;
    const keysReady = await waitFor(() => {
      if (keyFile && !existsSync(keyFile)) return null;
      const keys = collectKeyMaterial(env);
      return keys.length ? keys : null;
    }, 3_000);
    assertOk(Array.isArray(keysReady) && keysReady.length > 0, `审计密钥未生成（denied 请求未写审计？）：${keyFile}`);

    const call = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'cp_status', arguments: {} },
    });
    assertOk(call.status === 200, `status=${call.status}`);
    for (const key of keysReady) {
      assertOk(!call.text.includes(key), 'cp_status 响应泄漏审计密钥');
    }
    assertOk(!/"?key"?\s*:\s*"[0-9a-f]{64}"/i.test(call.text), 'cp_status 响应出现审计密钥样式字段');
    const bytes = assertNoLeak(call.json, 'cp_status 响应');
    return `payload=${bytes}B 无 token/key（已比对 ${keysReady.length} 个真实审计密钥）`;
  });

  // 8) MCP 子进程 stdout 0 字节；日志只在 stderr 且不泄 token
  await check('MCP 子进程 stdout 0 字节；stderr 仅日志且无 token', async () => {
    assertOk(mcpState.stdoutBytes === 0, `stdout=${mcpState.stdoutBytes}B（应为 0）`);
    assertOk(mcpState.stdoutTail === '', 'stdout 出现内容');
    const stderr = mcpState.stderrTail;
    assertOk(stderr.includes('Streamable HTTP listening'), 'stderr 缺少 HTTP 启动日志');
    for (const secret of secrets) {
      assertOk(!stderr.includes(secret), 'stderr 泄漏 agent token');
    }
    assertOk(!TOKEN_LIKE_PATTERN.test(stderr), 'stderr 出现 cpa_ 样式令牌');
    return `stdout=0B stderr=${stderr.length}B（仅日志）`;
  });

  // 9) MCP HTTP 端点边界
  await check('MCP HTTP 端点边界：GET /mcp 405、未知路径 404', async () => {
    const getMcp = await callMcp(mcpBase, '/mcp');
    assertOk(getMcp.status === 405, `GET /mcp status=${getMcp.status}`);
    assertOk((getMcp.headers.get('content-type') || '').includes('application/json'), 'GET /mcp 非 JSON 错误');
    const missing = await callMcp(mcpBase, '/not-a-real-endpoint');
    assertOk(missing.status === 404, `未知路径 status=${missing.status}`);
    assertOk((missing.headers.get('content-type') || '').includes('application/json'), '未知路径非 JSON 错误');
    return 'GET /mcp=405 未知=404';
  });

  const passed = results.filter((entry) => entry.ok).length;
  const failures = results.filter((entry) => !entry.ok);
  return { passed, total: results.length, failures: failures.map((entry) => entry.name) };
}

function printSummary(passed, total) {
  const ok = passed === total;
  log('');
  log(`${ok ? 'PASS' : 'FAIL'} ${passed}/${total}`);
  return ok ? 0 : 1;
}

function printDiagnostics({ runtimeState, mcpState, secrets }) {
  for (const state of [mcpState, runtimeState]) {
    if (!state) continue;
    const stderrTail = scrubEvidence(state.stderrTail ?? '', secrets);
    if (stderrTail.trim()) {
      log('');
      log(`▶ ${state.label} stderr（尾部 2000 字符，已脱敏）：`);
      log(stderrTail.slice(-2000));
    }
    if (state.stdoutTail) {
      log('');
      log(`▶ ${state.label} stdout（尾部 500 字符）：`);
      log(scrubEvidence(state.stdoutTail.slice(-500), secrets));
    }
  }
}

/** 默认模式：随机端口 + 临时目录 + 真实 Runtime + 真实 MCP Streamable HTTP 子进程。 */
async function runSpawned() {
  const runtimePort = await getFreePort();
  let mcpPort = await getFreePort();
  while (mcpPort === runtimePort) mcpPort = await getFreePort();
  const runtimeBase = `http://127.0.0.1:${runtimePort}`;
  const mcpBase = `http://127.0.0.1:${mcpPort}`;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-mcp-live-'));
  const stateDir = path.join(tempRoot, 'state');
  const evidenceDir = path.join(tempRoot, 'evidence');
  const automationDir = path.join(tempRoot, 'automation');
  const tokenFile = path.join(tempRoot, 'agent-token.json');
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(automationDir, { recursive: true, mode: 0o700 }),
  ]);

  const runtimeEnv = {
    ...process.env,
    CIRCUITPILOT_RUNTIME_PORT: String(runtimePort),
    CIRCUITPILOT_STATE_DIR: stateDir,
    CIRCUITPILOT_AGENT_TOKEN_FILE: tokenFile,
    CIRCUITPILOT_AGENT_AUDIT_FILE: path.join(tempRoot, 'agent-audit.jsonl'),
    CIRCUITPILOT_AGENT_AUDIT_KEY_FILE: path.join(tempRoot, 'agent-audit.key.json'),
    CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE: path.join(tempRoot, 'agent-audit.head.json'),
    CIRCUITPILOT_EVIDENCE_DIR: evidenceDir,
    CIRCUITPILOT_AUTOMATION_DIR: automationDir,
    CIRCUITPILOT_JOB_JOURNAL: path.join(tempRoot, 'eda-jobs.jsonl'),
    CIRCUITPILOT_KNOWLEDGE_WEB: 'off',
    FORCE_COLOR: '0',
  };
  // 子进程必须走“HTTP 发放 sessionProof/签令牌”路径；不能让父进程令牌注入干扰。
  delete runtimeEnv.CIRCUITPILOT_RUNTIME_TOKEN;
  delete runtimeEnv.CIRCUITPILOT_TOKEN_STDIN;

  const mcpEnv = { ...process.env, FORCE_COLOR: '0' };
  // 避免父进程环境里的 token 与 --token-file 冲突/串用；MCP 只读临时 token 文件。
  delete mcpEnv.CIRCUITPILOT_AGENT_TOKEN;
  delete mcpEnv.CIRCUITPILOT_RUNTIME_TOKEN;
  delete mcpEnv.CIRCUITPILOT_TOKEN_STDIN;

  log(`▶ Live Runtime 子进程：${runtimeBase}（临时目录 ${tempRoot}）`);
  const runtime = spawnNode(['runtime/server.mjs'], { env: runtimeEnv, label: 'Runtime 子进程' });

  let agentToken = '';
  let mcp = null;
  let matrix = null;
  let failure = null;
  let secrets = [];
  let cleanupResidual = false;

  try {
    const health = await waitForRuntimeHealth(runtimeBase, runtime.state);
    log(`▶ Runtime health ok version=${health.json?.version}；等待 agent token 文件`);
    agentToken = await waitForAgentToken(tokenFile);
    secrets = [agentToken];

    mcp = spawnNode([
      MCP_SERVER_SCRIPT,
      '--http',
      '--http-port', String(mcpPort),
      '--runtime-url', runtimeBase,
      '--token-file', tokenFile,
      '--approval-mode', 'chat',
    ], { env: mcpEnv, label: 'MCP 子进程' });
    log(`▶ MCP Streamable HTTP 子进程：${mcpBase}（真实 node ${MCP_SERVER_SCRIPT} --http）`);
    await waitForMcpHealth(mcpBase, mcp.state);
    log('▶ MCP /health transport=streamable-http 就绪');

    matrix = await runMatrix({
      runtimeBase,
      mcpBase,
      agentToken,
      env: runtimeEnv,
      mcpState: mcp.state,
    });
  } catch (error) {
    failure = error;
  } finally {
    secrets.push(...collectKeyMaterial(runtimeEnv));
    // 临时隔离自检：token/audit/key/head 都应写入临时目录（删除前检查；缺失只告警）。
    const expectedFiles = ['agent-token.json', 'agent-audit.jsonl', 'agent-audit.key.json', 'agent-audit.head.json'];
    const missingFiles = expectedFiles.filter((name) => !existsSync(path.join(tempRoot, name)));
    if (missingFiles.length) log(`▶ [WARN] 临时目录缺少预期文件：${missingFiles.join(', ')}`);
    else log(`▶ 隔离检查：${expectedFiles.join(' / ')} 均写入临时目录`);

    await stopChild(mcp);
    await stopChild(runtime);
    await fs.rm(tempRoot, { recursive: true, force: true });

    if (mcp) {
      const mcpPortFree = await waitFor(() => canListen(mcpPort), 3_000);
      const runtimePortFree = await waitFor(() => canListen(runtimePort), 3_000);
      const tempGone = !existsSync(tempRoot);
      const mcpExited = mcp.state.exited;
      const runtimeExited = runtime.state.exited;
      cleanupResidual = !(mcpPortFree && runtimePortFree && tempGone && mcpExited && runtimeExited);
      if (cleanupResidual) {
        log('[FAIL] 清理异常：存在残留（临时目录/端口/子进程未退出）');
        log(`       mcpPortFree=${mcpPortFree} runtimePortFree=${runtimePortFree} tempGone=${tempGone} `
          + `mcpExited=${mcpExited} runtimeExited=${runtimeExited}`);
      } else {
        log('▶ 已 SIGTERM 两个子进程并清理临时目录；端口已释放（无残留）');
      }
    } else {
      cleanupResidual = !(runtime.state.exited && !existsSync(tempRoot));
      if (cleanupResidual) log('[FAIL] 清理异常：Runtime 子进程或临时目录残留');
      else log('▶ 已 SIGTERM Runtime 子进程并清理临时目录（MCP 未启动）');
    }
  }

  // 隔离自检（删除前已无法检查，只能报告预期文件路径；失败不影响 PASS 判定）。
  if (failure) {
    log('[FAIL] MCP HTTP + Live Runtime 验收异常');
    log(`       ${scrubEvidence(failure?.message || failure, secrets)}`);
    printDiagnostics({ runtimeState: runtime.state, mcpState: mcp?.state, secrets });
    return 1;
  }
  const exitCode = printSummary(matrix.passed, matrix.total);
  if (exitCode !== 0) printDiagnostics({ runtimeState: runtime.state, mcpState: mcp?.state, secrets });
  return cleanupResidual ? 1 : exitCode;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printUsage();
  process.exitCode = 0;
} else {
  runSpawned()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      log(`[FAIL] 验收脚本异常：${scrubEvidence(error?.message || error, [])}`);
      process.exitCode = 1;
    });
}
