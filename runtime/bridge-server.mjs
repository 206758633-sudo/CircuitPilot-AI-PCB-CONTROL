import { randomUUID } from 'node:crypto';
import { createServer, get as httpGet } from 'node:http';
import { createConnection } from 'node:net';
import wsPackage from './vendor/ws/index.js';
import { BRIDGE_PORTS } from './config.mjs';

const { WebSocketServer } = wsPackage;
import { startRegistrationHandshake } from './bridge-handshake.mjs';
import { readBridgeBody as readBody, DEFAULT_BODY_LIMIT, AUTHENTICATED_EXECUTE_LIMIT } from './bridge-body.mjs';

const HOST = '127.0.0.1';
const PORTS = BRIDGE_PORTS;
const SERVICE = 'easyeda-bridge';
const REQUEST_TIMEOUT_MS = 120_000;
const BRIDGE_TOKEN = process.env.CIRCUITPILOT_BRIDGE_TOKEN || '';
const RUNTIME_PROCESS_ID = Number(process.env.CIRCUITPILOT_RUNTIME_PID || 0);
const edaClients = new Map();
const pendingRequests = new Map();
let activeWindowId = null;

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  return !BRIDGE_TOKEN || request.headers['x-circuitpilot-bridge-token'] === BRIDGE_TOKEN;
}

function executeOnEda(code, requestedWindowId) {
  return new Promise((resolve, reject) => {
    const windowId = requestedWindowId || activeWindowId;
    const client = windowId ? edaClients.get(windowId) : null;
    if (!client || client.readyState !== 1) {
      reject(Object.assign(new Error('No connected EasyEDA window'), { status: 503 }));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(Object.assign(new Error('EasyEDA execution timed out'), { status: 504 }));
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timer, windowId });
    client.send(JSON.stringify({ type: 'execute', id, code, windowId, timestamp: Date.now() }));
  });
}

function handleEdaMessage(message, windowId) {
  if (message.type === 'ping') {
    const client = edaClients.get(windowId);
    if (client?.readyState === 1) client.send(JSON.stringify({ type: 'pong', id: message.id, timestamp: Date.now() }));
    return;
  }
  if (message.type !== 'result' && message.type !== 'error') return;
  const pending = pendingRequests.get(message.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRequests.delete(message.id);
  if (message.type === 'result') pending.resolve(message.result);
  else pending.reject(new Error(message.error || 'Unknown EasyEDA error'));
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    json(response, 200, { service: SERVICE, status: 'ok', managedBy: 'circuitpilot-runtime', maxExecuteBytes: BRIDGE_TOKEN ? AUTHENTICATED_EXECUTE_LIMIT : DEFAULT_BODY_LIMIT, processId: process.pid, runtimeProcessId: RUNTIME_PROCESS_ID || null, edaConnected: edaClients.size > 0, edaWindowCount: edaClients.size, activeWindowId, pendingRequests: pendingRequests.size, timestamp: Date.now() });
    return;
  }
  if (request.method === 'GET' && request.url === '/eda-windows') {
    json(response, 200, { windows: [...edaClients.entries()].map(([windowId, client]) => ({ windowId, connected: client.readyState === 1, active: windowId === activeWindowId })), activeWindowId, count: edaClients.size });
    return;
  }
  if (!authorized(request)) {
    json(response, 401, { error: 'Bridge token invalid' });
    return;
  }
  try {
    if (request.method === 'POST' && request.url === '/eda-windows/select') {
      const body = await readBody(request);
      if (!edaClients.has(body.windowId)) return json(response, 404, { error: 'EasyEDA window not found' });
      activeWindowId = body.windowId;
      json(response, 200, { success: true, activeWindowId });
      return;
    }
    if (request.method === 'POST' && request.url === '/execute') {
      const body = await readBody(request, BRIDGE_TOKEN ? AUTHENTICATED_EXECUTE_LIMIT : DEFAULT_BODY_LIMIT);
      if (typeof body.code !== 'string' || !body.code) return json(response, 400, { error: 'Missing code' });
      const result = await executeOnEda(body.code, body.windowId);
      json(response, 200, { success: true, result, windowId: body.windowId || activeWindowId });
      return;
    }
    json(response, 404, { error: 'Not found' });
  } catch (error) {
    json(response, error.status || 500, { success: false, error: error.message || 'Bridge error', code: error.code, dispatched: error.dispatched });
  }
});

const wss = new WebSocketServer({ server });
wss.on('error', (error) => {
  console.error(`EasyEDA Bridge WebSocket error: ${error.message}`);
});
wss.on('connection', (client, request) => {
  // Run API Gateway v1.x has used /eda, /ws and the root path across releases.
  // Treat all known gateway paths as EDA clients; keep unknown paths closed.
  const isEda = ['/eda', '/ws', '/'].includes(request.url || '/');
  if (!isEda) {
    client.send(JSON.stringify({ type: 'handshake', service: SERVICE, clientType: 'agent', timestamp: Date.now() }));
    client.close(1008, 'HTTP Runtime is the only supported agent');
    return;
  }
  let registeredWindowId = null;
  // EasyEDA's sys_WebSocket callback can miss a frame sent immediately after
  // the socket opens. Repeat the idempotent handshake until the gateway
  // registers its window, then stop immediately.
  const handshake = startRegistrationHandshake({ client, service: SERVICE, isRegistered: () => Boolean(registeredWindowId) });
  client.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'register' && message.windowId) {
        registeredWindowId = String(message.windowId);
        handshake.stop();
        edaClients.set(registeredWindowId, client);
        // The gateway is invoked from the document the user is currently viewing.
        // Prefer that newest context so a stale start-page gateway cannot retain control.
        activeWindowId = registeredWindowId;
        return;
      }
      handleEdaMessage(message, registeredWindowId || 'unregistered');
    } catch { /* malformed extension messages are ignored */ }
  });
  client.on('close', () => {
    handshake.stop();
    if (!registeredWindowId) return;
    edaClients.delete(registeredWindowId);
    if (activeWindowId === registeredWindowId) activeWindowId = edaClients.keys().next().value || null;
    for (const [id, pending] of pendingRequests) {
      if (pending.windowId !== registeredWindowId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('EasyEDA window disconnected'));
      pendingRequests.delete(id);
    }
  });
});

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: HOST, port });
    socket.setTimeout(250);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

function getExistingBridge(port) {
  return new Promise((resolve) => {
    const request = httpGet(`http://${HOST}:${port}/health`, { timeout: 500 }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { const value = JSON.parse(body); resolve(value.service === SERVICE ? value : null); }
        catch { resolve(null); }
      });
    });
    request.once('timeout', () => { request.destroy(); resolve(null); });
    request.once('error', () => resolve(null));
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitForPortRelease(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await portInUse(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function start() {
  for (const port of PORTS) {
    const existing = await getExistingBridge(port);
    if (!existing) continue;
    const staleManagedBridge = existing.managedBy === 'circuitpilot-runtime'
      && existing.runtimeProcessId !== RUNTIME_PROCESS_ID
      && !processAlive(Number(existing.runtimeProcessId));
    if (!staleManagedBridge || !Number.isInteger(Number(existing.processId))) return process.exit(0);
    try { process.kill(Number(existing.processId), 'SIGTERM'); }
    catch { /* it may have already exited */ }
    await waitForPortRelease(port);
  }
  const port = await (async () => {
    for (const candidate of PORTS) if (!(await portInUse(candidate))) return candidate;
    throw new Error('No free EasyEDA Bridge port');
  })();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('EasyEDA Bridge is shutting down'));
    pendingRequests.delete(id);
  }
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close(() => process.exit(0));
  const forcedExit = setTimeout(() => process.exit(0), 1_000);
  forcedExit.unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
if (RUNTIME_PROCESS_ID) {
  const parentWatchdog = setInterval(() => {
    if (!processAlive(RUNTIME_PROCESS_ID)) shutdown();
  }, 1_000);
  parentWatchdog.unref();
}
start().catch((error) => { console.error(error.message); process.exit(1); });
