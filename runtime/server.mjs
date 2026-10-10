import crypto from 'node:crypto';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ALLOWED_ORIGINS, BODY_LIMIT, EDA_APP_CANDIDATES, RUNTIME_HOST, RUNTIME_PORT } from './config.mjs';
import { BridgeClient } from './bridge.mjs';
import { ChatManager } from './chat.mjs';
import { DesignManager, normalizePlan } from './design.mjs';
import { systemDiagnostics } from './diagnostics.mjs';
import { MacKeychain } from './keychain.mjs';
import { listEvents, logger, redact } from './logger.mjs';
import { providerStatuses, startProviderLogin, testProvider } from './providers.mjs';
import { compileCh32v003Fixture, normalizePcbPlan, PcbManager } from './pcb.mjs';
import { ProductionManager } from './production.mjs';
import { engineeringProfiles, runEngineeringAnalysis } from './engineering/engine.mjs';
import { engineeringFixtures } from './engineering/fixtures.mjs';
import { startDetached } from './process.mjs';

const runtimeParentPid = process.ppid;
const parentWatchdog = setInterval(() => {
  if (process.ppid === 1 || process.ppid !== runtimeParentPid) process.exit(0);
}, 2_000);
parentWatchdog.unref();

function runtimeError(error) {
  return {
    ok: false,
    error: {
      code: error?.code || 'RUNTIME_ERROR',
      message: redact(error?.message || '本机Runtime发生未知错误'),
    },
  };
}

function sendJson(response, status, body, origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.writeHead(status);
  const safeBody = redact(body);
  // Approval proofs are intentionally returned to the authenticated local client.
  // They remain redacted from logger events and every other response field.
  if (typeof body?.approval?.token === 'string' && safeBody?.approval) safeBody.approval.token = body.approval.token;
  response.end(JSON.stringify(safeBody));
}

function normalizeLibraryPart(value) {
  if (!value || typeof value !== 'object') return undefined;
  const name = String(value.name || '').slice(0, 200);
  const uuid = String(value.uuid || '').slice(0, 160);
  const libraryUuid = String(value.libraryUuid || '').slice(0, 160);
  return name && uuid && libraryUuid ? { name, uuid, libraryUuid } : undefined;
}

function normalizeDeviceCandidates(raw) {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return items.slice(0, 20).map((item) => ({
    name: String(item?.name || '').slice(0, 200),
    uuid: String(item?.uuid || '').slice(0, 160),
    libraryUuid: String(item?.libraryUuid || '').slice(0, 160),
    description: String(item?.description || '').slice(0, 500),
    symbol: normalizeLibraryPart(item?.symbol),
    footprint: normalizeLibraryPart(item?.footprint),
    model3D: normalizeLibraryPart(item?.model3D),
    otherProperty: item?.otherProperty && typeof item.otherProperty === 'object' ? Object.fromEntries(Object.entries(item.otherProperty).slice(0, 30).map(([key, value]) => [String(key).slice(0, 80), ['string','number','boolean'].includes(typeof value) ? value : String(value).slice(0, 200)])) : {},
  })).filter((item) => item.name && item.uuid && item.libraryUuid);
}

async function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE', status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求JSON格式无效'), { code: 'INVALID_JSON', status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function isLoopbackHost(hostHeader) {
  return /^(127\.0\.0\.1|localhost|\[::1\]|tauri\.localhost)(:\d+)?$/i.test(String(hostHeader || ''));
}

export function createRuntimeServer({ keychain = new MacKeychain(), bridge = new BridgeClient(), diagnostics = systemDiagnostics, chat = null, design = null, pcb = null, production = null, runtimeToken = process.env.CIRCUITPILOT_RUNTIME_TOKEN } = {}) {
  // Tauri 壳层可以通过环境变量注入令牌，使令牌完全不经由 HTTP 分发；
  // 独立开发模式（npm run dev:full）才回退到随机令牌 + 受信 Origin 引导。
  const sessionToken = typeof runtimeToken === 'string' && runtimeToken.length >= 16 ? runtimeToken : crypto.randomBytes(24).toString('base64url');
  const chatManager = chat || new ChatManager({ keychain, bridge });
  const designManager = design || new DesignManager({ bridge });
  const pcbManager = pcb || new PcbManager({ bridge });
  const productionManager = production || new ProductionManager({ artifactsRoot: new URL('../manufacturing/', import.meta.url).pathname, pcb: pcbManager });
  const server = http.createServer(async (request, response) => {
    const startedAt = performance.now();
    const origin = request.headers.origin;
    const url = new URL(request.url || '/', `http://${RUNTIME_HOST}`);
    const method = request.method || 'GET';
    const requestId = crypto.randomUUID();

    // DNS rebinding / 伪造 Host：只接受回环主机名。
    if (!isLoopbackHost(request.headers.host)) {
      logger.warn('Http', 'Rejected non-loopback Host header', { host: request.headers.host, path: url.pathname });
      return sendJson(response, 403, runtimeError(Object.assign(new Error('Host未获授权'), { code: 'HOST_FORBIDDEN' })), null);
    }
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      logger.warn('Http', 'Rejected untrusted origin', { origin, path: url.pathname });
      return sendJson(response, 403, runtimeError(Object.assign(new Error('Origin未获授权'), { code: 'ORIGIN_FORBIDDEN' })), null);
    }
    if (method === 'OPTIONS') {
      if (origin) response.setHeader('access-control-allow-origin', origin);
      response.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
      response.setHeader('access-control-allow-headers', 'content-type,x-circuitpilot-token');
      response.writeHead(204);
      return response.end();
    }
    // 唯一公开路由是 GET /api/health，它本身也不会向未受信任的来源泄漏令牌。
    // 其余路由（含只读 GET）一律要求会话令牌，避免本机任意进程读取设计数据、日志和工具链路径。
    const isPublicRoute = method === 'GET' && url.pathname === '/api/health';
    if (!isPublicRoute && request.headers['x-circuitpilot-token'] !== sessionToken) {
      return sendJson(response, 401, runtimeError(Object.assign(new Error('Runtime会话令牌无效'), { code: 'RUNTIME_TOKEN_INVALID' })), origin);
    }

    try {
      let result;
      if (method === 'GET' && url.pathname === '/api/health') {
        // 令牌只发给受信任的浏览器来源（开发端口或 Tauri WebView）。
        // 不带 Origin 的本机进程（curl / 脚本 / 其它 App）不再能领取写权限凭据。
        const trustedOrigin = typeof origin === 'string' && ALLOWED_ORIGINS.has(origin);
        result = { ok: true, service: 'circuitpilot-runtime', version: '0.6.1', host: RUNTIME_HOST, ...(trustedOrigin ? { sessionProof: sessionToken } : {}) };
      } else if (method === 'GET' && url.pathname === '/api/diagnostics') {
        result = { ok: true, diagnostics: await diagnostics() };
      } else if (method === 'GET' && url.pathname === '/api/providers') {
        result = { ok: true, providers: await providerStatuses(keychain) };
      } else if (method === 'POST' && /^\/api\/providers\/[^/]+\/login$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        result = { ok: true, login: await startProviderLogin(id) };
        logger.info('Provider', 'Started official provider login', { provider: id });
      } else if (method === 'POST' && /^\/api\/providers\/[^/]+\/key$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        const body = await readBody(request);
        result = { ok: true, credential: await keychain.store(id, body.key) };
        if (body && typeof body === 'object') body.key = undefined;
        logger.info('Credential', 'Stored provider credential in Keychain', { provider: id });
      } else if (method === 'DELETE' && /^\/api\/providers\/[^/]+\/key$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        result = { ok: true, credential: await keychain.remove(id) };
        logger.warn('Credential', 'Removed provider credential from Keychain', { provider: id });
      } else if (method === 'POST' && /^\/api\/providers\/[^/]+\/test$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        result = { ok: true, test: await testProvider(id, keychain) };
        logger.info('Provider', 'Provider connection test completed', { provider: id });
      } else if (method === 'GET' && url.pathname === '/api/eda/discover') {
        const match = await bridge.discover();
        result = { ok: true, bridge: match };
        logger.info('EasyEDA', match ? 'Discovered EasyEDA Bridge' : 'EasyEDA Bridge not found', { port: match?.port });
      } else if (method === 'GET' && url.pathname === '/api/eda/windows') {
        result = { ok: true, ...(await bridge.windows()) };
      } else if (method === 'POST' && url.pathname === '/api/eda/windows/select') {
        const body = await readBody(request);
        result = { ok: true, ...(await bridge.selectWindow(body.windowId)) };
        logger.info('EasyEDA', 'Selected active EDA window', { windowId: body.windowId });
      } else if (method === 'GET' && url.pathname === '/api/eda/commands') {
        result = { ok: true, commands: bridge.listCommands() };
      } else if (method === 'POST' && /^\/api\/eda\/commands\/[^/]+$/.test(url.pathname)) {
        const commandId = decodeURIComponent(url.pathname.split('/')[4]);
        const body = await readBody(request);
        const commandStarted = performance.now();
        const metadata = bridge.listCommands().find((item) => item.id === commandId);
        const commandResult = await bridge.execute(commandId, body);
        result = { ok: true, command: { id: commandId, permission: metadata?.permission || 'read', duration: Math.round(performance.now() - commandStarted), result: commandResult } };
        logger.info('EasyEDA', 'Executed registered non-write command', { commandId, permission: result.command.permission, duration: result.command.duration });
      } else if (method === 'POST' && url.pathname === '/api/eda/library/devices/search') {
        const body = await readBody(request);
        if (!bridge.port) await bridge.discover();
        const mode = /^C\d+$/i.test(String(body.query || '').trim()) ? 'lcsc' : body.mode || 'keyword';
        const raw = await bridge.execute('library.device.search', { query: String(body.query || '').trim(), mode, limit: 20, page: Number(body.page || 1) });
        result = { ok: true, search: { query: String(body.query || '').trim(), mode, beta: true, readOnly: true, candidates: normalizeDeviceCandidates(raw) } };
        logger.info('EasyEDA', 'Device library search completed', { mode, resultCount: result.search.candidates.length });
      } else if (method === 'GET' && url.pathname === '/api/design/context') {
        result = { ok: true, context: await designManager.context() };
      } else if (method === 'POST' && url.pathname === '/api/eda/schematic/open-current') {
        const body = await readBody(request);
        const raw = await bridge.execute('schematic.catalog');
        const catalog = raw?.result ?? raw?.data ?? raw;
        const pages = Array.isArray(catalog?.pages) ? catalog.pages : Array.isArray(catalog) ? catalog : [];
        const requestedUuid = String(body.documentUuid || '');
        const page = requestedUuid ? pages.find((item) => String(item?.uuid || item?.documentUuid || '') === requestedUuid) : pages.find((item) => /^[a-f0-9]{16,64}$/i.test(String(item?.uuid || item?.documentUuid || '')));
        const documentUuid = String(page?.uuid || page?.documentUuid || '');
        if (!documentUuid) throw Object.assign(new Error('当前嘉立创EDA工程中没有可打开的原理图页面'), { code: 'SCHEMATIC_PAGE_NOT_FOUND', status: 404 });
        result = { ok: true, schematic: { documentUuid, page, navigation: await bridge.execute('schematic.open', { documentUuid }) } };
      } else if (method === 'POST' && url.pathname === '/api/design/plan') {
        const body = await readBody(request);
        result = { ok: true, planning: normalizePlan(body.plan || {}) };
        logger.info('Design', 'Normalized simple-board plan', { ready: result.planning.ready, planHash: result.planning.planHash, missingCount: result.planning.missing.length });
      } else if (method === 'POST' && url.pathname === '/api/design/plan/ai') {
        const body = await readBody(request);
        const candidate = await chatManager.plan(body);
        result = { ok: true, candidate, planning: normalizePlan(candidate) };
        logger.info('Design', 'Codex generated structured simple-board plan candidate', { ready: result.planning.ready, planHash: result.planning.planHash, missingCount: result.planning.missing.length });
      } else if (method === 'POST' && url.pathname === '/api/design/netlist/ai') {
        const body = await readBody(request);
        result = { ok: true, netlist: await chatManager.netlist(body) };
      } else if (method === 'POST' && url.pathname === '/api/design/approve') {
        const body = await readBody(request);
        result = { ok: true, approval: designManager.approve(body) };
        logger.info('Design', 'Issued bound design approval', { planHash: result.approval.planHash, windowId: body.windowId, expiresAt: result.approval.expiresAt });
      } else if (method === 'POST' && url.pathname === '/api/design/cancel') {
        const body = await readBody(request);
        result = { ok: true, cancellation: designManager.cancel(body) };
      } else if (method === 'POST' && url.pathname === '/api/design/capabilities/probe') {
        result = { ok: true, capabilities: await designManager.probe() };
      } else if (method === 'POST' && url.pathname === '/api/design/execute') {
        const body = await readBody(request);
        result = { ok: true, execution: await designManager.execute(body) };
        logger.info('Design', 'Controlled schematic execution finished', { executionId: result.execution.id, state: result.execution.state, planHash: result.execution.planHash });
      } else if (method === 'GET' && /^\/api\/design\/executions\/[^/]+\/evidence$/.test(url.pathname)) {
        const executionId = decodeURIComponent(url.pathname.split('/')[4]);
        const evidence = designManager.evidence(executionId);
        if (!evidence) throw Object.assign(new Error('执行恢复证据不存在'), { code: 'EXECUTION_NOT_FOUND', status: 404 });
        result = { ok: true, evidence };
      } else if (method === 'GET' && /^\/api\/design\/executions\/[^/]+$/.test(url.pathname)) {
        const executionId = decodeURIComponent(url.pathname.split('/')[4]);
        const execution = designManager.get(executionId);
        if (!execution) throw Object.assign(new Error('执行记录不存在'), { code: 'EXECUTION_NOT_FOUND', status: 404 });
        result = { ok: true, execution };
      } else if (method === 'GET' && url.pathname === '/api/pcb/capabilities') {
        result = { ok: true, capabilities: pcbManager.capabilities() };
      } else if (method === 'GET' && url.pathname === '/api/pcb/context') {
        result = { ok: true, context: await pcbManager.context() };
      } else if (method === 'POST' && url.pathname === '/api/eda/app/focus') {
        const appPath = EDA_APP_CANDIDATES.find((candidate) => existsSync(candidate));
        if (!appPath) throw Object.assign(new Error('未在受支持路径发现嘉立创EDA专业版'), { code: 'EASYEDA_NOT_FOUND', status: 404 });
        startDetached('/usr/bin/open', ['-a', appPath]);
        result = { ok: true, application: { path: appPath, focused: true } };
        logger.info('EDA', 'EasyEDA application focused', { path: appPath });
      } else if (method === 'POST' && url.pathname === '/api/app/focus') {
        const appPath = '/Applications/CircuitPilot.app';
        if (!existsSync(appPath)) throw Object.assign(new Error('未发现已安装的CircuitPilot应用'), { code: 'CIRCUITPILOT_APP_NOT_FOUND', status: 404 });
        startDetached('/usr/bin/open', ['-a', appPath]);
        result = { ok: true, application: { path: appPath, focused: true } };
      } else if (method === 'POST' && url.pathname === '/api/eda/workspaces') {
        const body = await readBody(request);
        const friendlyName = String(body.friendlyName || '').trim();
        const projectName = String(body.projectName || friendlyName).trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `CircuitPilot-${Date.now()}`;
        const appPath = EDA_APP_CANDIDATES.find((candidate) => existsSync(candidate));
        if (!appPath) throw Object.assign(new Error('未在受支持路径发现嘉立创EDA专业版'), { code: 'EASYEDA_NOT_FOUND', status: 404 });
        startDetached('/usr/bin/open', ['-a', appPath]);
        let discovered = await bridge.discover();
        for (let attempt = 0; !discovered && attempt < 30; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 500)); discovered = await bridge.discover(); }
        if (!discovered) throw Object.assign(new Error('已打开嘉立创EDA，但Bridge未在15秒内就绪；请确认Run API Gateway扩展已启用'), { code: 'BRIDGE_START_TIMEOUT', status: 504 });
        const windows = await bridge.windows();
        if (windows.selectionRequired) throw Object.assign(new Error('检测到多个嘉立创EDA窗口，请先在高级控制中选择创建目标窗口'), { code: 'EDA_WINDOW_SELECTION_REQUIRED', status: 409 });
        const created = await bridge.execute('workspace.create', { friendlyName, projectName, description: String(body.description || '').slice(0, 500) }, { allowWrite: true });
        result = { ok: true, workspace: created?.result || created?.data || created };
        logger.info('EDA', 'Created EasyEDA project workspace', { friendlyName, projectName, windowId: bridge.selectedWindowId });
      } else if (method === 'GET' && url.pathname === '/api/eda/workspaces/current') {
        const unwrapValue = (value) => value?.result ?? value?.data ?? value;
        if (!bridge.port) await bridge.discover();
        if (!bridge.port) throw Object.assign(new Error('未发现EasyEDA Bridge'), { code: 'BRIDGE_NOT_FOUND', status: 503 });
        const windowState = await bridge.windows();
        if (!windowState.windows.length) throw Object.assign(new Error('Bridge在线，但没有嘉立创EDA窗口连接'), { code: 'EDA_WINDOW_NOT_FOUND', status: 409 });
        if (windowState.selectionRequired) throw Object.assign(new Error('检测到多个嘉立创EDA窗口，请先在高级控制中选择目标窗口'), { code: 'EDA_WINDOW_SELECTION_REQUIRED', status: 409 });
        const [projectRaw, documentRaw, catalogRaw] = await Promise.all([bridge.execute('project.current'), bridge.execute('document.current'), bridge.execute('schematic.catalog')]);
        const project = unwrapValue(projectRaw); const document = unwrapValue(documentRaw); const catalog = unwrapValue(catalogRaw);
        if (Number(document?.documentType) !== 3) throw Object.assign(new Error('请先在嘉立创EDA中选中要绑定的PCB文档'), { code: 'PCB_DOCUMENT_REQUIRED', status: 409 });
        const boards = Array.isArray(project?.data) ? project.data.filter((item) => item?.itemType === 'Board') : [];
        const board = boards.find((item) => String(item?.pcb?.uuid || '') === String(document?.uuid || ''));
        if (!board?.schematic?.uuid || !board?.pcb?.uuid) throw Object.assign(new Error('当前PCB没有找到同Board关联的原理图'), { code: 'EDA_BOARD_BINDING_NOT_FOUND', status: 404 });
        const page = (Array.isArray(catalog?.pages) ? catalog.pages : []).find((item) => String(item?.parentSchematicUuid || '') === String(board.schematic.uuid));
        if (!page?.uuid) throw Object.assign(new Error('当前Board没有可写入的原理图页面'), { code: 'SCHEMATIC_PAGE_NOT_FOUND', status: 404 });
        result = { ok: true, workspace: { projectUuid: String(project.uuid), boardName: String(board.name || board.parentBoardName || ''), schematicUuid: String(board.schematic.uuid), schematicPageUuid: String(page.uuid), pcbUuid: String(board.pcb.uuid) } };
      } else if (method === 'POST' && url.pathname === '/api/pcb/plan') {
        const body = await readBody(request);
        result = { ok: true, planning: normalizePcbPlan(body.plan || {}) };
      } else if (method === 'POST' && url.pathname === '/api/pcb/fixtures/ch32v003/compile') {
        const body = await readBody(request);
        result = { ok: true, planning: compileCh32v003Fixture(body || {}) };
      } else if (method === 'POST' && url.pathname === '/api/pcb/approve') {
        const body = await readBody(request);
        result = { ok: true, approval: pcbManager.approve(body) };
      } else if (method === 'POST' && url.pathname === '/api/pcb/execute') {
        const body = await readBody(request);
        result = { ok: true, execution: await pcbManager.execute(body) };
      } else if (method === 'POST' && url.pathname === '/api/production/plans/normalize') {
        const body = await readBody(request);
        result = { ok: true, planning: productionManager.normalize(body.plan || {}) };
      } else if (method === 'POST' && url.pathname === '/api/production/plans/compile') {
        const body = await readBody(request);
        result = { ok: true, planning: productionManager.compile(body.plan || {}) };
      } else if (method === 'POST' && url.pathname === '/api/production/plans/ai') {
        const body = await readBody(request);
        const candidate = await chatManager.productionPlan(body);
        result = { ok: true, candidate, planning: candidate.plan ? productionManager.normalize(candidate.plan) : null };
      } else if (method === 'POST' && url.pathname === '/api/production/artifacts/inspect') {
        const body = await readBody(request);
        result = { ok: true, inspection: productionManager.artifacts(body.binding || {}) };
      } else if (method === 'POST' && url.pathname === '/api/production/readiness') {
        const body = await readBody(request);
        result = { ok: true, readiness: productionManager.readiness(body) };
      } else if (method === 'POST' && url.pathname === '/api/production/reviews/final') {
        const body = await readBody(request);
        result = { ok: true, review: productionManager.finalReview(body) };
        logger.warn('Production', 'Recorded human final review', { reviewedBy: result.review.reviewer, semanticPlanHash: result.review.semanticPlanHash, manifestHash: result.review.manifestHash });
      } else if (method === 'GET' && url.pathname === '/api/engineering/profiles') {
        result = { ok: true, profiles: engineeringProfiles(), fixtures: Object.keys(engineeringFixtures) };
      } else if (method === 'POST' && url.pathname === '/api/engineering/analyze') {
        const body = await readBody(request);
        const fixture = body.fixtureId ? engineeringFixtures[body.fixtureId] : null;
        if (body.fixtureId && !fixture) throw Object.assign(new Error('工程样板不存在'), { code: 'ENGINEERING_FIXTURE_NOT_FOUND', status: 404 });
        result = { ok: true, analysis: runEngineeringAnalysis(fixture ? fixture() : body.input || {}) };
        logger.info('Engineering', 'Advanced PCB engineering analysis completed', { fixtureId: body.fixtureId || null, passed: result.analysis.passed, reportHash: result.analysis.reportHash, findingCount: result.analysis.findings.length });
      } else if (method === 'GET' && url.pathname === '/api/chat/status') {
        result = { ok: true, chat: await chatManager.status() };
      } else if (method === 'POST' && /^\/api\/chat\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
        const sessionId = decodeURIComponent(url.pathname.split('/')[4]);
        const body = await readBody(request);
        result = { ok: true, chat: await chatManager.send(sessionId, body) };
        logger.info('Chat', 'Codex PCBA chat turn completed', { sessionId, suggestions: result.chat.requirementSuggestions.length, edaStatus: result.chat.eda.status });
      } else if (method === 'DELETE' && /^\/api\/chat\/sessions\/[^/]+$/.test(url.pathname)) {
        const sessionId = decodeURIComponent(url.pathname.split('/')[4]);
        result = { ok: true, chat: chatManager.reset(sessionId) };
        logger.info('Chat', 'Chat session reset', { sessionId });
      } else if (method === 'GET' && url.pathname === '/api/events') {
        result = { ok: true, events: listEvents() };
      } else {
        throw Object.assign(new Error('Runtime端点不存在'), { code: 'ROUTE_NOT_FOUND', status: 404 });
      }
      logger.info('Http', 'Request completed', { requestId, method, path: url.pathname, duration: Math.round(performance.now() - startedAt) });
      return sendJson(response, 200, result, origin);
    } catch (error) {
      logger.error('Http', 'Request failed', { requestId, method, path: url.pathname, code: error.code, message: error.message });
      return sendJson(response, error.status || 400, runtimeError(error), origin);
    }
  });
  // 没有 error 监听器时，EADDRINUSE / EACCES 会变成未捕获异常直接击穿进程；
  // 这里统一记录，便于定位“端口被占用”和“权限不足”。
  server.on('error', (error) => logger.error('Http', 'Runtime server error', { code: error.code, message: error.message, host: RUNTIME_HOST }));
  server.on('close', () => chatManager.close?.());
  return { server, sessionToken };
}

export function startRuntime({ port = RUNTIME_PORT } = {}) {
  const { server } = createRuntimeServer();
  // 端口被占用时不要假装启动成功：细节已由上面的 error 监听器记录，这里只负责非零退出。
  server.once('error', () => process.exit(1));
  server.listen(port, RUNTIME_HOST, () => logger.info('Runtime', 'CircuitPilot Runtime started', { host: RUNTIME_HOST, port }));
  const shutdown = (signal) => {
    logger.warn('Runtime', 'CircuitPilot Runtime stopping', { signal });
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startRuntime();
