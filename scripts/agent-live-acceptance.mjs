#!/usr/bin/env node
/**
 * Agent 控制面 Live Runtime 端到端验收（task-34）。
 *
 * 默认模式：在随机空闲回环端口拉起一个**真实子进程** `node runtime/server.mjs`，
 * 所有状态目录（state/token/audit/key/head/evidence/job journal）都指向 mkdtemp 临时目录，
 * 不连 4178、不连 EDA、不写用户状态；跑完 kill 子进程并删除临时目录。
 *
 * 可选 `--base-url http://127.0.0.1:4178`：不 spawn，直接对现有 Runtime 跑同一矩阵。
 * 若目标是旧 Runtime（没有 Agent 控制面路由，`/api/agent/status` 返回 404），
 * 明确打印“旧 Runtime，需重启/重建”并以 exit 2 退出（给出操作步骤）。
 *
 * 用法：
 *   npm run verify:agent-live
 *   node scripts/agent-live-acceptance.mjs --base-url http://127.0.0.1:4178
 *
 * 退出码：0 = 全部 PASS；1 = 有 FAIL/运行错误；2 = 目标 Runtime 过旧（仅 --base-url）。
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const HEALTH_TIMEOUT_MS = 10_000;
const MATRIX_TIMEOUT_MS = 5_000;
const TOKEN_PATTERN = /^cpa_[0-9a-fA-F]{48}$/;
const TOKEN_LIKE_PATTERN = /cpa_[0-9a-fA-F]{48}/;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

function parseArgs(argv) {
  const options = { baseUrl: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--base-url') {
      const value = argv[index + 1];
      if (!value) throw new Error('--base-url 缺少参数值');
      options.baseUrl = value;
      index += 1;
    } else if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.slice('--base-url='.length);
    } else {
      throw new Error(`未知参数：${arg}（支持 --base-url <url> / --help）`);
    }
  }
  return options;
}

function printUsage() {
  log('用法：');
  log('  npm run verify:agent-live                                  # 临时端口拉起真实 Runtime 子进程验收');
  log('  node scripts/agent-live-acceptance.mjs --base-url <url>    # 对现有 Runtime 跑同一矩阵（旧版 exit 2）');
}

/** 取一个随机空闲回环端口（listen 0 后立即关闭，由 Runtime 子进程复用）。 */
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

async function waitForAgentToken(file, timeoutMs = 5_000) {
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

async function callRuntime(base, pathname, { method = 'GET', uiToken, agentToken, body } = {}) {
  const headers = { origin: TRUSTED_ORIGIN };
  if (uiToken) headers['x-circuitpilot-token'] = uiToken;
  if (agentToken) headers['x-circuitpilot-agent-token'] = agentToken;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应保留 text 作为证据 */ }
  return { status: response.status, json, text };
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

async function waitForHealth(base, childState, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (childState?.exited) {
      throw new Error(`Runtime 子进程提前退出（code=${childState.code}）\n${childState.stderrTail}`);
    }
    try {
      const response = await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } });
      const body = await response.json().catch(() => null);
      if (response.status === 200 && body?.ok === true) return body;
      lastError = new Error(`/api/health status=${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`等待 ${base}/api/health 就绪超时（${timeoutMs}ms）${lastError ? `：${lastError?.code || lastError?.message}` : ''}`);
}

/**
 * 验收矩阵（spawn 模式与 --base-url 模式共用）。
 * @returns {Promise<{passed: number, total: number, failures: string[]}>}
 */
async function runMatrix({ base, uiToken, uiTokenSource, agentTokenFile, env, rotateNote }) {
  const agentToken = await waitForAgentToken(agentTokenFile);
  const keyMaterial = collectKeyMaterial(env);
  const secrets = [uiToken, agentToken, ...keyMaterial].filter(Boolean);
  const results = [];

  const assertOk = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const assertNoLeak = (payload, label) => {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const secret of secrets) {
      if (secret && serialized.includes(secret)) throw new Error(`${label} 泄漏敏感值`);
    }
    assertOk(!TOKEN_LIKE_PATTERN.test(serialized), `${label} 出现 cpa_ 样式令牌字符串`);
    return serialized.length;
  };

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

  // 1) 健康检查 + UI 会话令牌来源
  await check('Runtime /api/health 就绪且可取得 UI 会话令牌', async () => {
    const health = await callRuntime(base, '/api/health');
    assertOk(health.status === 200, `status=${health.status}`);
    assertOk(health.json?.ok === true, 'body.ok !== true');
    assertOk(typeof uiToken === 'string' && uiToken.length >= 16, '没有可用的 UI 会话令牌');
    assertOk(uiTokenSource === 'health.sessionProof' || Boolean(health.json?.version), 'health 响应缺少 version');
    return `service=${health.json?.service} version=${health.json?.version} token=${uiTokenSource}`;
  });

  // 2) UI 可读 status 且 token available
  await check('UI GET /api/agent/status：200 且 agent.available=true', async () => {
    const result = await callRuntime(base, '/api/agent/status', { uiToken });
    assertOk(result.status === 200, `status=${result.status} body=${scrubEvidence(result.text, secrets).slice(0, 200)}`);
    assertOk(result.json?.ok === true, 'body.ok !== true');
    const agent = result.json?.agent;
    assertOk(agent?.available === true, `agent.available=${agent?.available} reason=${agent?.reason ?? 'n/a'}`);
    assertOk(Array.isArray(agent?.scopes) && agent.scopes.length > 0, 'agent.scopes 为空');
    return `available=true name=${agent.name} scopes=${agent.scopes.join('|')}`;
  });

  // 3) UI status 响应绝不泄漏 token/key
  await check('UI status 响应不包含 agent token / 审计密钥', async () => {
    const result = await callRuntime(base, '/api/agent/status', { uiToken });
    assertOk(result.status === 200, `status=${result.status}`);
    const bytes = assertNoLeak(result.json, 'status 响应');
    return `payload=${bytes}B 无 token/key`;
  });

  // 4) Agent 可读 status
  await check('Agent GET /api/agent/status：200（agent 可读）', async () => {
    const result = await callRuntime(base, '/api/agent/status', { agentToken });
    assertOk(result.status === 200, `status=${result.status} body=${scrubEvidence(result.text, secrets).slice(0, 200)}`);
    assertOk(result.json?.agent?.available === true, `agent.available=${result.json?.agent?.available}`);
    return 'agent 通道可读 status';
  });

  // 5) Agent 越权：audit / rotate 均 403
  await check('Agent GET /api/agent/audit 与 POST /api/agent/token/rotate：均 403', async () => {
    const audit = await callRuntime(base, '/api/agent/audit', { agentToken });
    assertOk(audit.status === 403, `audit status=${audit.status}`);
    assertOk(audit.json?.error?.code === 'AGENT_ROUTE_FORBIDDEN', `audit code=${audit.json?.error?.code}`);
    const rotate = await callRuntime(base, '/api/agent/token/rotate', { method: 'POST', agentToken, body: {} });
    assertOk(rotate.status === 403, `rotate status=${rotate.status}`);
    assertOk(rotate.json?.error?.code === 'AGENT_ROUTE_FORBIDDEN', `rotate code=${rotate.json?.error?.code}`);
    return 'audit/rotate 403 AGENT_ROUTE_FORBIDDEN';
  });

  // 6) Agent approve 缺 confirm/approvalMode → 403（审批边界）
  await check('Agent POST /api/design/approve 缺 confirm/approvalMode：403 审批边界', async () => {
    const result = await callRuntime(base, '/api/design/approve', {
      method: 'POST',
      agentToken,
      body: { planHash: 'live-acceptance-plan' },
    });
    assertOk(result.status === 403, `status=${result.status} body=${scrubEvidence(result.text, secrets).slice(0, 200)}`);
    assertOk(
      result.json?.error?.code === 'AGENT_APPROVAL_CONFIRMATION_REQUIRED',
      `error.code=${result.json?.error?.code}`,
    );
    return '403 AGENT_APPROVAL_CONFIRMATION_REQUIRED';
  });

  // 7) 越权/审批尝试写入审计（denied + approve 路径的 request 审计）
  await check('Agent 越权/审批尝试产生审计事件（denied / approve 请求）', async () => {
    const audit = await waitFor(async () => {
      const result = await callRuntime(base, '/api/agent/audit?limit=50', { uiToken });
      if (result.status !== 200 || !Array.isArray(result.json?.events)) return null;
      const events = result.json.events;
      const hasDenied = events.some((event) => event.kind === 'denied');
      const hasApproveAttempt = events.some((event) => event.path === '/api/design/approve');
      return hasDenied && hasApproveAttempt ? result.json : null;
    }, MATRIX_TIMEOUT_MS);
    assertOk(audit, '等待审计事件写入超时（denied / approve 未出现）');
    const kinds = [...new Set(audit.events.map((event) => event.kind))].sort().join('|');
    return `events=${audit.events.length} kinds=${kinds}`;
  });

  // 8) UI 审计完整性：anchored=true 且链 ok，内容无 token/key
  await check('UI GET /api/agent/audit：200、integrity ok/anchored=true、无 token/key', async () => {
    const result = await waitFor(async () => {
      const response = await callRuntime(base, '/api/agent/audit?limit=50', { uiToken });
      if (response.status !== 200) return null;
      const integrity = response.json?.integrity;
      const ready = integrity?.ok === true && integrity?.chain === 'ok' && integrity?.anchored === true;
      return ready ? response : null;
    }, MATRIX_TIMEOUT_MS);
    assertOk(result, '等待 integrity={ok,chain:ok,anchored:true} 超时（可能有并发 append 的瞬态 head 窗口）');
    const events = result.json.events;
    assertOk(Array.isArray(events) && events.length >= 1, '审计事件为空');
    assertOk(events.every((event) => !('hash' in event) && !('prevHash' in event)), '审计事件返回了 hash/prevHash');
    const bytes = assertNoLeak(result.json, 'audit 响应');
    return `events=${events.length} verified=${result.json.integrity.verified} anchored=true payload=${bytes}B`;
  });

  // 9) UI 轮换：旧 agent token 立即 401，新 token 200
  await check('UI POST /api/agent/token/rotate：200；旧 agent token 401 / 新 token 200', async () => {
    const oldToken = readAgentTokenFile(agentTokenFile);
    const rotated = await callRuntime(base, '/api/agent/token/rotate', { method: 'POST', uiToken, body: {} });
    assertOk(rotated.status === 200, `rotate status=${rotated.status} body=${scrubEvidence(rotated.text, secrets).slice(0, 200)}`);
    assertOk(rotated.json?.ok === true, 'rotate body.ok !== true');
    assertNoLeak(rotated.json, 'rotate 响应');

    const nextToken = await waitFor(() => {
      try {
        const token = readAgentTokenFile(agentTokenFile);
        return token !== oldToken ? token : null;
      } catch {
        return null;
      }
    }, MATRIX_TIMEOUT_MS);
    assertOk(nextToken, '轮换后 token 文件未更新');
    secrets.push(nextToken);

    const oldStatus = await callRuntime(base, '/api/agent/status', { agentToken: oldToken });
    assertOk(oldStatus.status === 401, `旧 token status=${oldStatus.status}（应立即失效）`);
    const newStatus = await callRuntime(base, '/api/agent/status', { agentToken: nextToken });
    assertOk(newStatus.status === 200, `新 token status=${newStatus.status}`);
    return `rotate=200 旧=401 新=200${rotateNote ? `（${rotateNote}）` : ''}`;
  });

  const passed = results.filter((entry) => entry.ok).length;
  const failures = results.filter((entry) => !entry.ok);
  return { passed, total: results.length, failures: failures.map((entry) => entry.name) };
}

/** 旧 Runtime 引导：exit 2（版本问题，不是验收失败）。 */
function printOldRuntime(base) {
  log('');
  log('✖ 旧 Runtime，需重启/重建：目标 Runtime 没有 Agent 控制面路由（/api/agent/status → 404）。');
  log('  1) 结束正在运行的旧 CircuitPilot/Runtime 进程（或释放 4178 端口）');
  log('  2) 重新构建并启动：npm run build && 重启 CircuitPilot；开发模式用 npm run dev:full');
  log('  3) 确认新 Runtime 已生效后重跑：');
  log(`     npm run verify:agent-live -- --base-url ${base}`);
  log('  exit 2：目标 Runtime 过旧（不代表新代码验收失败）');
}

function printSummary(passed, total) {
  const ok = passed === total;
  log('');
  log(`${ok ? 'PASS' : 'FAIL'} ${passed}/${total}`);
  return ok ? 0 : 1;
}

function printChildDiagnostics(childState, secrets) {
  const stderrTail = scrubEvidence(childState?.stderrTail ?? '', secrets);
  if (stderrTail.trim()) {
    log('');
    log('▶ Runtime 子进程 stderr（尾部 2000 字符，已脱敏）：');
    log(stderrTail.slice(-2000));
  }
}

async function stopChild(child, childState) {
  if (!child || childState.exited) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve();
    }, 3_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
}

/** 默认模式：随机端口 + 临时目录 + 真实 Runtime 子进程。 */
async function runSpawned() {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-agent-live-'));
  const stateDir = path.join(tempRoot, 'state');
  const evidenceDir = path.join(tempRoot, 'evidence');
  const automationDir = path.join(tempRoot, 'automation');
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(automationDir, { recursive: true, mode: 0o700 }),
  ]);

  const env = {
    ...process.env,
    CIRCUITPILOT_RUNTIME_PORT: String(port),
    CIRCUITPILOT_STATE_DIR: stateDir,
    CIRCUITPILOT_AGENT_TOKEN_FILE: path.join(tempRoot, 'agent-token.json'),
    CIRCUITPILOT_AGENT_AUDIT_FILE: path.join(tempRoot, 'agent-audit.jsonl'),
    CIRCUITPILOT_AGENT_AUDIT_KEY_FILE: path.join(tempRoot, 'agent-audit.key.json'),
    CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE: path.join(tempRoot, 'agent-audit.head.json'),
    CIRCUITPILOT_EVIDENCE_DIR: evidenceDir,
    CIRCUITPILOT_AUTOMATION_DIR: automationDir,
    CIRCUITPILOT_JOB_JOURNAL: path.join(tempRoot, 'eda-jobs.jsonl'),
    CIRCUITPILOT_KNOWLEDGE_WEB: 'off',
    FORCE_COLOR: '0',
  };
  // 子进程必须走“HTTP 发放 sessionProof”路径；不能让父进程的令牌注入把发放关掉。
  delete env.CIRCUITPILOT_RUNTIME_TOKEN;
  delete env.CIRCUITPILOT_TOKEN_STDIN;

  const childState = { exited: false, code: null, stderrTail: '', stdoutTail: '' };
  const appendTail = (current, chunk) => `${current}${chunk.toString('utf8')}`.slice(-64 * 1024);
  const child = spawn(process.execPath, ['runtime/server.mjs'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { childState.stdoutTail = appendTail(childState.stdoutTail, chunk); });
  child.stderr.on('data', (chunk) => { childState.stderrTail = appendTail(childState.stderrTail, chunk); });
  child.once('exit', (code) => { childState.exited = true; childState.code = code; });

  log(`▶ Live Runtime 子进程：${base}（临时目录 ${tempRoot}）`);
  let secrets = [];
  let exitCode = 1;
  try {
    const health = await waitForHealth(base, childState);
    const uiToken = typeof health.sessionProof === 'string' ? health.sessionProof : '';
    if (!uiToken) {
      throw new Error('Runtime 未发放 sessionProof（子进程不应注入 CIRCUITPILOT_RUNTIME_TOKEN）');
    }
    secrets = [uiToken];
    log(`▶ health ok version=${health.version}；UI token 取自 health.sessionProof`);

    const matrix = await runMatrix({
      base,
      uiToken,
      uiTokenSource: 'health.sessionProof',
      agentTokenFile: env.CIRCUITPILOT_AGENT_TOKEN_FILE,
      env,
    });
    try {
      secrets.push(readAgentTokenFile(env.CIRCUITPILOT_AGENT_TOKEN_FILE));
    } catch {
      // 诊断脱敏用；读失败不影响验收结论。
    }
    exitCode = printSummary(matrix.passed, matrix.total);
    if (exitCode !== 0) printChildDiagnostics(childState, secrets);

    // 临时隔离自检：token/audit/key/head 都必须落在临时目录内。
    const expected = ['agent-token.json', 'agent-audit.jsonl', 'agent-audit.key.json', 'agent-audit.head.json'];
    const missing = expected.filter((name) => !existsSync(path.join(tempRoot, name)));
    if (missing.length) {
      log(`[WARN] 临时目录缺少预期文件：${missing.join(', ')}`);
    } else {
      log(`▶ 隔离检查：${expected.join(' / ')} 均写入临时目录`);
    }
  } catch (error) {
    log('[FAIL] Live Runtime 启动/验收异常');
    log(`       ${scrubEvidence(error?.message || error, secrets)}`);
    printChildDiagnostics(childState, secrets);
    exitCode = 1;
  } finally {
    await stopChild(child, childState);
    await fs.rm(tempRoot, { recursive: true, force: true });
    const leftover = existsSync(tempRoot);
    log(`▶ 已停止 Runtime 子进程并清理临时目录${leftover ? '（清理失败，请手动删除）' : ''}`);
    if (leftover) exitCode = 1;
  }
  return exitCode;
}

/** --base-url 模式：对现有 Runtime 跑同一矩阵；旧 Runtime 返回 exit 2。 */
async function runAgainstExisting(rawBaseUrl) {
  const base = rawBaseUrl.replace(/\/+$/, '');
  log(`▶ 对现有 Runtime 验收：${base}`);

  let health;
  try {
    health = await waitForHealth(base, null);
  } catch (error) {
    log('[FAIL] 无法连接现有 Runtime /api/health');
    log(`       ${error?.message || error}`);
    log('  请确认 CircuitPilot Runtime 正在运行，或先重启/重建 Runtime 再验收。');
    return 1;
  }

  const envToken = typeof process.env.CIRCUITPILOT_RUNTIME_TOKEN === 'string'
    ? process.env.CIRCUITPILOT_RUNTIME_TOKEN.trim()
    : '';
  const uiToken = typeof health.sessionProof === 'string' && health.sessionProof.length >= 16
    ? health.sessionProof
    : envToken.length >= 16 ? envToken : '';
  const uiTokenSource = health.sessionProof ? 'health.sessionProof' : 'CIRCUITPILOT_RUNTIME_TOKEN';

  if (!uiToken) {
    log('');
    log('✖ 无法取得 UI 会话令牌：/api/health 未发放 sessionProof（桌面版注入了令牌），且未设置 CIRCUITPILOT_RUNTIME_TOKEN。');
    log('  1) 优先直接对临时 Runtime 验收：npm run verify:agent-live');
    log('  2) 或在启动 Runtime 的终端导出 CIRCUITPILOT_RUNTIME_TOKEN 后重跑本命令');
    return 2;
  }
  const probe = await callRuntime(base, '/api/agent/status', { uiToken }).catch(() => null);
  if (!probe || probe.status === 404) {
    printOldRuntime(base);
    return 2;
  }
  if (probe.status === 401 || probe.status === 403) {
    log('');
    log(`✖ 取得 UI 令牌但 /api/agent/status 返回 ${probe.status}：令牌不匹配或权限不足。`);
    log('  请重启 Runtime 后用 health.sessionProof 重试，或改用 npm run verify:agent-live。');
    return 1;
  }

  const agentTokenFile = typeof process.env.CIRCUITPILOT_AGENT_TOKEN_FILE === 'string'
    && process.env.CIRCUITPILOT_AGENT_TOKEN_FILE.trim()
    ? process.env.CIRCUITPILOT_AGENT_TOKEN_FILE.trim()
    : path.join(os.homedir(), 'Library', 'Application Support', 'CircuitPilot', 'agent-token.json');
  if (!existsSync(agentTokenFile)) {
    log('');
    log(`✖ 找不到 agent token 文件：${agentTokenFile}`);
    log('  Runtime 需先启动一次以签发令牌（或设置 CIRCUITPILOT_AGENT_TOKEN_FILE 指向正确文件）。');
    return 1;
  }

  log('  ⚠ 该模式会轮换现有 Runtime 的 agent token（插件下次请求会自动读取新值）');
  const matrix = await runMatrix({
    base,
    uiToken,
    uiTokenSource,
    agentTokenFile,
    env: process.env,
    rotateNote: '已轮换现有 Runtime token，插件下次请求自动读取',
  });
  return printSummary(matrix.passed, matrix.total);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printUsage();
  process.exitCode = 0;
} else {
  const run = options.baseUrl ? runAgainstExisting(options.baseUrl) : runSpawned();
  run
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      log(`[FAIL] 验收脚本异常：${scrubEvidence(error?.message || error, [])}`);
      process.exitCode = 1;
    });
}
