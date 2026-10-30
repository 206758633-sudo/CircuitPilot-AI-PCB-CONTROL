#!/usr/bin/env node
/**
 * 只读 stdio 代理：把 MCP 客户端与 agent/mcp-server.mjs 之间的每一行 JSON-RPC
 * 追加写入 MCP_WIRE_LOG（JSONL），用于独立取证「server/discover → -32601 →
 * initialize 回退」和「notifications/cancelled 后无响应」。
 *
 * 用法：node wire-proxy.mjs <server.mjs 路径> [...server 参数]
 * 环境：MCP_WIRE_LOG=<日志文件路径>
 *
 * 注意：只有代理进程会读该 env；官方 SDK auto 协商的 sibling probe 进程会以
 * 相同 command/args/env 启动，因此 probe 与正式 session 的流量都会落盘，
 * 通过 pid 区分两条连接。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const wireLog = process.env.MCP_WIRE_LOG || '';
const [serverPath, ...serverArgs] = process.argv.slice(2);

if (!serverPath) {
  process.stderr.write('[wire-proxy] missing server path\n');
  process.exit(2);
}

function record(direction, line) {
  if (!wireLog) return;
  try {
    appendFileSync(wireLog, `${JSON.stringify({ pid: process.pid, t: Date.now(), dir: direction, line })}\n`);
  } catch {
    /* 日志失败不影响协议转发 */
  }
}

const child = spawn(process.execPath, [serverPath, ...serverArgs], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
child.on('error', (error) => {
  process.stderr.write(`[wire-proxy] spawn failed: ${error.message}\n`);
  process.exit(1);
});

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  record('in', line);
  try {
    child.stdin.write(`${line}\n`);
  } catch {
    /* server 已退出 */
  }
});
process.stdin.on('end', () => {
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
});

createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  record('out', line);
  process.stdout.write(`${line}\n`);
});

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
  try {
    process.stdout.end();
  } catch {
    /* ignore */
  }
});

let terminating = false;
const terminate = () => {
  if (terminating) return;
  terminating = true;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 1000).unref?.();
};
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
