#!/usr/bin/env node
/**
 * Experimental bridge adapter: expose the local easyeda-agent CLI as an
 * `easyeda-bridge`-compatible service on 49620.
 *
 * Why this exists: EasyEDA 3.2.x on this machine ships `easyeda-agent` v1.x
 * (typed actions, daemon on 60832), while CircuitPilot's Runtime bridge client
 * speaks the older `easyeda-bridge` HTTP/WS protocol (49620). This adapter does
 * NOT change the Runtime protocol; it maps `/execute` (raw eda.* JavaScript) to
 * `easyeda debug exec`, which is the CLI's own raw-JS escape hatch.
 *
 * Safety:
 * - Binds 127.0.0.1 only; optional shared token via CIRCUITPILOT_BRIDGE_TOKEN.
 * - Executes only a single code argument via execFile (no shell interpolation).
 * - Serializes calls; the EasyEDA connector is single-threaded.
 * - Never logs the code, only length/outcome.
 * - This is an explicitly experimental compatibility shim, not the production
 *   bridge; `--skip-version-check` is required when CLI/connector versions differ
 *   and is surfaced in stderr by the CLI itself.
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOST = '127.0.0.1';
const PORT = Number(process.env.CIRCUITPILOT_AGENT_BRIDGE_PORT || process.argv[2] || 49620);
const CLI = process.env.EASYEDA_CLI || join(homedir(), '.local/bin/easyeda');
const BRIDGE_TOKEN = process.env.CIRCUITPILOT_BRIDGE_TOKEN || '';
// 2026-10-29：document.source.restore 需要携带整份源码；旧 1MB 上限过于贴近真实源码体量。
// 放宽到 8MB，但仍保留硬上限，避免把桥变成任意大请求的入口。
const BODY_LIMIT = Math.min(8 * 1024 * 1024, Math.max(64 * 1024, Number(process.env.CIRCUITPILOT_BRIDGE_BODY_LIMIT || 8 * 1024 * 1024)));
const EXEC_TIMEOUT_MS = Number(process.env.EASYEDA_EXEC_TIMEOUT_MS || 100_000);
const CLI_TIMEOUT_SECONDS = Math.max(1, Math.floor(EXEC_TIMEOUT_MS / 1000) - 5);
let activeWindowId = null;
let pending = 0;
let queue = Promise.resolve();

if (!existsSync(CLI)) {
  console.error(`[agent-bridge] easyeda CLI not found: ${CLI}`);
  process.exit(1);
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function authorized(request) {
  if (!BRIDGE_TOKEN) return true;
  const provided = Buffer.from(String(request.headers['x-circuitpilot-bridge-token'] || ''), 'utf8');
  const expected = Buffer.from(BRIDGE_TOKEN, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function daemonHealth() {
  const { stdout } = await execFileAsync(CLI, ['daemon', 'health'], { timeout: 5_000, maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  const windows = Array.isArray(parsed?.found?.raw?.windows) ? parsed.found.raw.windows : [];
  return { port: parsed?.found?.port ?? null, windows, service: parsed?.found?.raw?.service ?? parsed?.found?.service ?? null };
}

async function runExec(code) {
  if (typeof code !== 'string' || !code) throw Object.assign(new Error('Missing code'), { status: 400, code: 'EDA_COMMAND_INVALID' });
  if (Buffer.byteLength(code, 'utf8') > BODY_LIMIT) throw Object.assign(new Error('code 过大'), { status: 413, code: 'EDA_COMMAND_INVALID' });
  const started = Date.now();
  let stdout;
  try {
    const result = await execFileAsync(CLI, [
      '--skip-version-check',
      'debug', 'exec',
      '--timeout', String(CLI_TIMEOUT_SECONDS),
      '--code', code,
    ], { timeout: EXEC_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    const timedOut = error?.killed === true || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT';
    throw Object.assign(new Error(timedOut ? 'EDA 执行超时' : `EDA 执行失败：${String(error?.stderr || error?.message || error).slice(0, 300)}`), {
      status: timedOut ? 504 : 500,
      code: timedOut ? 'EDA_TIMEOUT' : 'EDA_EXEC_FAILED',
      dispatched: true,
    });
  }
  let envelope;
  try { envelope = JSON.parse(stdout); }
  catch { throw Object.assign(new Error('EDA 返回了非 JSON 结果'), { status: 502, code: 'EDA_INVALID_RESPONSE' }); }
  if (envelope?.ok !== true) {
    const message = envelope?.error?.message || envelope?.error || 'EDA 返回 ok=false';
    throw Object.assign(new Error(String(message).slice(0, 400)), { status: 500, code: 'EDA_EXEC_FAILED' });
  }
  return { value: envelope.result?.value ?? null, ms: Date.now() - started };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      let windows = [];
      let error = null;
      try { windows = (await daemonHealth()).windows; } catch (caught) { error = String(caught?.message || caught); }
      if (windows.length && !windows.some((item) => item.windowId === activeWindowId)) activeWindowId = windows[0].windowId;
      json(response, 200, {
        service: 'easyeda-bridge', status: 'ok', managedBy: 'easyeda-agent-adapter',
        version: 'adapter-1', processId: process.pid, runtimeProcessId: null,
        edaConnected: windows.length > 0, edaWindowCount: windows.length,
        activeWindowId, pendingRequests: pending, timestamp: Date.now(),
        limits: { bodyBytes: BODY_LIMIT, execTimeoutMs: EXEC_TIMEOUT_MS },
        ...(error ? { adapterError: error } : {}),
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/eda-windows') {
      let windows = [];
      try { windows = (await daemonHealth()).windows; } catch (error) { return json(response, 503, { error: String(error?.message || error) }); }
      const list = windows.map((item) => ({ windowId: item.windowId, connected: true, active: item.windowId === activeWindowId }));
      json(response, 200, { windows: list, activeWindowId, count: list.length });
      return;
    }
    if (!authorized(request)) return json(response, 401, { error: 'Bridge token invalid' });
    if (request.method === 'POST' && url.pathname === '/eda-windows/select') {
      const body = JSON.parse(await readBody(request) || '{}');
      let windows = [];
      try { windows = (await daemonHealth()).windows; } catch (error) { return json(response, 503, { error: String(error?.message || error) }); }
      if (!windows.some((item) => item.windowId === body.windowId)) return json(response, 404, { error: 'EasyEDA window not found' });
      activeWindowId = body.windowId;
      json(response, 200, { success: true, activeWindowId });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/execute') {
      const body = JSON.parse(await readBody(request) || '{}');
      pending += 1;
      const run = queue.then(() => runExec(body.code));
      queue = run.catch(() => undefined);
      try {
        const result = await run;
        json(response, 200, { success: true, result: result.value, windowId: activeWindowId, adapterMs: result.ms });
      } catch (error) {
        json(response, error.status || 500, { success: false, error: error.message || 'EDA error', code: error.code, dispatched: error.dispatched === true });
      } finally {
        pending -= 1;
      }
      return;
    }
    json(response, 404, { error: 'Not found' });
  } catch (error) {
    json(response, error.status || 500, { error: String(error?.message || error), code: error.code });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[agent-bridge] listening on http://${HOST}:${PORT} (cli=${CLI}${BRIDGE_TOKEN ? ', token required' : ''})`);
});
const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1_000).unref(); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
