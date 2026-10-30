/**
 * MCP 独立复验的会话工具：
 *  - createTokenFile：临时 token 文件（0600，cpa_ 随机 token），不写仓库；
 *  - startMcpClient：DSH 官方 Client（@modelcontextprotocol/client@2.2.0）+
 *    StdioClientTransport 直连 agent/mcp-server.mjs；auto 版本协商；可选 wire 代理取证；
 *  - startRawSession：不经 SDK 的裸 JSON-RPC 会话，用于逐字节校验协议/schema；
 *  - waitFor / parseWireLog 等小工具。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const AGENT_DIR = fileURLToPath(new URL('../../../agent/', import.meta.url));
export const SERVER_PATH = join(AGENT_DIR, 'mcp-server.mjs');
export const WIRE_PROXY_PATH = join(HERE, 'wire-proxy.mjs');

/** 期望的 12 个工具（独立硬编码，避免直接复用作者测试/生产常量）。 */
export const EXPECTED_TOOL_NAMES = Object.freeze([
  'cp_status',
  'cp_project_context',
  'cp_issues',
  'cp_evidence',
  'cp_knowledge',
  'cp_design_plan',
  'cp_pcb_plan',
  'cp_approve',
  'cp_execute',
  'cp_validation',
  'cp_export',
  'cp_job',
]);

/** 会出现在 12 个工具 inputSchema 里的基础字段（协议层要求 object schema）。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 15, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor 超时：${label}（${timeoutMs}ms）`);
}

/**
 * 创建临时 token 文件（模拟真实安装的 ~/Library/Application Support/
 * CircuitPilot/agent-token.json，但落在系统临时目录）。
 */
export function createTokenFile({ token = `cpa_${randomBytes(24).toString('hex')}` } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-mcp-token-'));
  const file = join(dir, 'agent-token.json');
  writeFileSync(file, `${JSON.stringify({
    version: 1,
    name: 'dsh-plugin',
    token,
    scopes: ['read', 'plan', 'execute'],
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  return {
    dir,
    file,
    token,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...extra,
  };
}

/**
 * 用官方 SDK 建立 MCP 会话（auto 协商，会先发 server/discover，再回退 initialize）。
 */
export async function startMcpClient({
  sdk,
  runtime = null,
  tokenFile,
  serverArgs = [],
  env = {},
  clientOptions = {},
  wireLogPath = null,
  clientName = 'dsh-independent-verifier',
  clientVersion = '0.1.0',
  connectTimeoutMs = 20000,
} = {}) {
  if (!sdk) throw new Error('startMcpClient 需要先 loadDshSdk()');
  if (!tokenFile) throw new Error('startMcpClient 需要 tokenFile');
  const serverArgv = [SERVER_PATH, '--token-file', tokenFile];
  if (runtime?.url) serverArgv.push('--runtime-url', runtime.url);
  serverArgv.push(...serverArgs);

  let command = process.execPath;
  let args = serverArgv;
  const transportEnv = {
    ...(runtime?.url ? { CIRCUITPILOT_RUNTIME_URL: runtime.url } : {}),
    ...env,
  };
  if (wireLogPath) {
    transportEnv.MCP_WIRE_LOG = wireLogPath;
    command = process.execPath;
    args = [WIRE_PROXY_PATH, ...serverArgv];
  }

  const transport = new sdk.stdio.StdioClientTransport({
    command,
    args,
    env: transportEnv,
    stderr: 'pipe',
  });
  let stderr = '';
  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
  }
  const client = new sdk.client.Client(
    { name: clientName, version: clientVersion },
    { versionNegotiation: { mode: 'auto' }, ...clientOptions },
  );

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.close();
    } catch {
      /* 已关闭 */
    }
  };

  try {
    await client.connect(transport, { timeout: connectTimeoutMs });
  } catch (error) {
    await close();
    throw error;
  }

  return {
    client,
    transport,
    stderrText: () => stderr,
    async waitForStderr(pattern, timeoutMs = 4000) {
      return waitFor(() => pattern.test(stderr), { timeoutMs, label: `stderr ${pattern}` });
    },
    close,
  };
}

/**
 * 裸 JSON-RPC stdio 会话：直接 spawn agent/mcp-server.mjs，保留每条 stdout 原始行，
 * 用于对照官方 schema 校验与错误码断言。
 */
export async function startRawSession({
  runtime = null,
  tokenFile,
  serverArgs = [],
  env = {},
  defaultTimeoutMs = 5000,
} = {}) {
  if (!tokenFile) throw new Error('startRawSession 需要 tokenFile');
  const args = [SERVER_PATH, '--token-file', tokenFile];
  if (runtime?.url) args.push('--runtime-url', runtime.url);
  args.push(...serverArgs);
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: baseEnv(env),
  });

  const messages = [];
  const nonJsonLines = [];
  const waiters = new Set();
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;
  let exited = false;
  let exitInfo = null;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        nonJsonLines.push(line);
      }
      const entry = { raw: line, message, at: Date.now() };
      messages.push(entry);
      for (const waiter of [...waiters]) {
        if (waiter.match(entry)) {
          waiters.delete(waiter);
          waiter.resolve(entry);
        }
      }
    }
  });
  child.on('error', () => {
    /* spawn 错误由 exit/失败断言暴露 */
  });

  const writeLine = (text) => {
    if (exited) throw new Error('raw session 已退出，无法写入');
    child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
  };

  const request = (method, params, { timeoutMs = defaultTimeoutMs } = {}) => {
    const id = nextId;
    nextId += 1;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`raw request 超时：${method} (id=${id})`));
      }, timeoutMs);
      timer.unref?.();
      const waiter = {
        match: (entry) => entry.message && typeof entry.message === 'object' && entry.message.id === id,
        resolve: (entry) => {
          clearTimeout(timer);
          resolve(entry.message);
        },
      };
      waiters.add(waiter);
      writeLine(JSON.stringify(payload));
    });
  };

  const notify = (method, params) => {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    writeLine(JSON.stringify(payload));
  };

  const waitForMessage = (predicate, { timeoutMs = 4000 } = {}) => {
    const existing = messages.find((entry) => predicate(entry));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error('waitForMessage 超时'));
      }, timeoutMs);
      timer.unref?.();
      const waiter = {
        match: (entry) => predicate(entry),
        resolve: (entry) => {
          clearTimeout(timer);
          resolve(entry);
        },
      };
      waiters.add(waiter);
    });
  };

  const waitForExit = (timeoutMs = 3000) => Promise.race([
    exitPromise,
    sleep(timeoutMs).then(() => { throw new Error('等待 server 退出超时'); }),
  ]);

  const close = async () => {
    if (exited) return exitInfo;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      await waitForExit(2000);
    } catch {
      child.kill('SIGTERM');
      try {
        await waitForExit(1000);
      } catch {
        child.kill('SIGKILL');
      }
    }
    return exitInfo;
  };

  return {
    child,
    request,
    notify,
    sendRaw: writeLine,
    waitForMessage,
    waitForExit,
    messages,
    nonJsonLines,
    stderrText: () => stderr,
    async waitForStderr(pattern, timeoutMs = 4000) {
      return waitFor(() => pattern.test(stderr), { timeoutMs, label: `stderr ${pattern}` });
    },
    close,
  };
}

/** 读取 wire-proxy 写下的 JSONL 取证日志。 */
export function parseWireLog(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      continue;
    }
    let message;
    try {
      message = JSON.parse(envelope.line);
    } catch {
      message = null;
    }
    entries.push({ ...envelope, message });
  }
  return entries;
}

export function readWireLog(filePath) {
  return parseWireLog(readFileSync(filePath, 'utf8'));
}

/** 官方 schema 的 safeParse 断言辅助。 */
export function assertSchema(schema, value, label) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error?.issues?.map((item) => `${item.path?.join('.')}: ${item.message}`).join('; ');
    throw new Error(`${label} 未通过官方 schema 校验：${issue || parsed.error}`);
  }
  return parsed.data;
}
