/**
 * 测试辅助：以真实子进程方式启动 `agent/mcp-server.mjs`，按 MCP stdio 约定
 * （换行分隔 JSON-RPC）收发消息。测试要验证的是“真实协议”，因此不走进程内直调。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVER_PATH = fileURLToPath(new URL('../../mcp-server.mjs', import.meta.url));

/** 被测 MCP server 的绝对路径。 */
export function serverPath() {
  return SERVER_PATH;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 打开一个 MCP server 会话。
 *
 * @param {object} [options]
 * @param {string[]} [options.args] 传给 server 的命令行参数
 * @param {Record<string, string>} [options.env] 追加/覆盖的环境变量
 * @param {string} [options.cwd] 子进程工作目录（默认仓库根）
 * @returns {Promise<object>} 会话对象
 */
export async function openMcpSession({ args = [], env = {}, cwd } = {}) {
  const child = spawn(process.execPath, [SERVER_PATH, ...args], {
    cwd: cwd ?? fileURLToPath(new URL('../../..', import.meta.url)),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  /** 所有成功解析的 stdout 消息。 */
  const messages = [];
  /** 所有原始 stdout 行（用于断言 stdout 只包含 JSON 行）。 */
  const rawLines = [];
  /** 无法解析为 JSON 的 stdout 行（出现即视为严重协议违规）。 */
  const invalidJsonLines = [];
  /** 服务端主动发来的、没有对应 pending 请求的消息（理论上不应出现）。 */
  const unsolicited = [];
  let stderrText = '';
  let exitInfo = null;
  let closed = false;
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject, timer }
  const seenIds = new Set();

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      for (const [id, item] of pending) {
        clearTimeout(item.timer);
        item.reject(new Error(`MCP server 在等待响应时退出（id=${id}, code=${code}, signal=${signal}）\nstderr:\n${stderrText}`));
      }
      pending.clear();
      resolve(exitInfo);
    });
  });
  child.once('error', (error) => {
    stderrText += `\n[spawn error] ${error?.message || error}`;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrText += chunk;
  });

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    rawLines.push(line);
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      invalidJsonLines.push(line);
      return;
    }
    messages.push(message);
    if (Object.hasOwn(message, 'id') && message.id !== null && message.id !== undefined) {
      const key = String(message.id);
      const item = pending.get(key);
      if (item) {
        pending.delete(key);
        clearTimeout(item.timer);
        item.resolve(message);
      } else if (message.method === undefined) {
        unsolicited.push(message);
      }
    }
  });

  function sendRaw(raw) {
    if (closed) throw new Error('MCP 会话已关闭');
    child.stdin.write(raw.endsWith('\n') ? raw : `${raw}\n`);
  }

  function send(message) {
    sendRaw(JSON.stringify(message));
  }

  function sendLine(text) {
    sendRaw(`${text}\n`);
  }

  /** 发送请求并等待同 id 响应（返回完整 JSON-RPC 消息，含 error 字段时由测试断言）。 */
  function request(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS, id } = {}) {
    const requestId = id ?? (nextId += 1);
    const key = String(requestId);
    if (seenIds.has(key)) throw new Error(`测试内部错误：重复的请求 id ${key}`);
    seenIds.add(key);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`等待 ${method} 响应超时（id=${key}, ${timeoutMs}ms）\nstderr:\n${stderrText}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(key, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** 发送通知（无响应）。 */
  function notify(method, params) {
    send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** 断言某个 id 在给定时间内没有收到响应（用于 cancellation）。 */
  async function expectNoResponse(id, { timeoutMs = 400 } = {}) {
    const key = String(id);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (!pending.has(key)) {
        throw new Error(`请求 id=${key} 收到了响应，但 cancellation 语义要求不响应`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!pending.has(key)) {
      throw new Error(`请求 id=${key} 收到了响应，但 cancellation 语义要求不响应`);
    }
  }

  /** 等待 stderr 出现匹配内容。 */
  async function waitForStderr(predicate, { timeoutMs = 5_000 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate(stderrText)) return stderrText;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待 stderr 条件超时（${timeoutMs}ms）\n当前 stderr:\n${stderrText}`);
  }

  /** 完整握手：initialize + notifications/initialized。返回 initialize 结果消息。 */
  async function handshake({ protocolVersion = '2025-11-25', clientName = 'dsh-mcp-client-test', clientVersion = '0.0.0-test' } = {}) {
    const init = await request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: clientName, version: clientVersion },
    });
    notify('notifications/initialized');
    return init;
  }

  /** 关闭 stdin 并等待子进程退出；超时则 SIGKILL。 */
  async function close({ timeoutMs = 5_000 } = {}) {
    if (closed) return exitInfo;
    closed = true;
    try {
      child.stdin.end();
    } catch {
      // 忽略：进程可能已退出。
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    const info = await exitPromise;
    clearTimeout(timer);
    return info;
  }

  /** 立即 SIGKILL（测试失败清理用）。 */
  function kill() {
    closed = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出。
    }
    return exitPromise;
  }

  return {
    child,
    pid: child.pid,
    request,
    send,
    sendLine,
    notify,
    handshake,
    expectNoResponse,
    waitForStderr,
    close,
    kill,
    get exit() {
      return exitInfo;
    },
    get messages() {
      return messages;
    },
    get rawLines() {
      return rawLines;
    },
    get invalidJsonLines() {
      return invalidJsonLines;
    },
    get unsolicited() {
      return unsolicited;
    },
    get stderr() {
      return stderrText;
    },
    get exitPromise() {
      return exitPromise;
    },
  };
}
