/**
 * 测试辅助：模拟 CircuitPilot Runtime（node:http）与 agent token 文件。
 * 只被 agent/__tests__/*.test.mjs 使用，不属于 MCP server 运行时依赖。
 */

import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 测试用 agent token（与 runtime/agent-token.mjs 的 cpa_ 前缀一致）。 */
export const TEST_TOKEN = 'cpa_test_token_0123456789abcdef';

/** 测试用 design planHash（cp_approve 要求 >=8 字符）。 */
export const DESIGN_PLAN_HASH = 'design-plan-hash-000001';

/** 测试用 PCB planHash。 */
export const PCB_PLAN_HASH = 'pcb-plan-hash-000001';

/** 测试用审批 token（Runtime 返回，MCP server 绝不能把它回传给模型）。 */
export const APPROVAL_TOKEN_SECRET = 'approval-token-secret-0001';

/** 创建测试临时目录（调用方负责 rm）。 */
export async function makeTempDir(prefix = 'circuitpilot-mcp-test-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 在临时目录里写一个合法的 agent token 文件，返回文件路径。 */
export async function writeTokenFile(dir, { token = TEST_TOKEN, name = 'dsh-plugin', scopes = ['read', 'plan', 'execute'] } = {}) {
  const file = path.join(dir, 'agent-token.json');
  await writeFile(file, `${JSON.stringify({ token, name, scopes }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** 删除临时目录（忽略不存在）。 */
export async function removeDir(dir) {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true });
}

const DEFAULT_ROUTES = Object.freeze({
  'GET /api/health': () => ({
    body: { ok: true, service: 'circuitpilot-runtime', version: '0.9.0-test', host: '127.0.0.1' },
  }),
  'GET /api/project-state': () => ({
    body: {
      ok: true,
      state: {
        activeProjectId: 'proj-1',
        projects: [{ id: 'proj-1', name: 'PCBA Demo', stage: 'schematic', progress: 0.4 }],
        requirements: [],
        components: [],
        assets: [],
      },
    },
  }),
  'GET /api/write-gate': () => ({ body: { ok: true, gate: { paused: false } } }),
  'GET /api/eda/workspaces/current': () => ({ body: { ok: true, workspace: { windowId: 'win-1' } } }),
  'GET /api/issue-state': () => ({ body: { ok: true, state: { issues: [] } } }),
  'GET /api/evidence/index': () => ({
    body: { ok: true, index: { summary: { entries: 1, kinds: { erc: 1 } }, entries: [], complete: true } },
  }),
  'POST /api/design/plan': () => ({
    body: {
      ok: true,
      planning: {
        plan: { title: 'demo design', blocks: {}, nets: [], operations: [] },
        planHash: DESIGN_PLAN_HASH,
        ready: true,
        missing: [],
      },
    },
  }),
  'POST /api/pcb/plan': () => ({
    body: {
      ok: true,
      planning: {
        plan: { board: { width: 50, height: 40 }, operations: [] },
        planHash: PCB_PLAN_HASH,
        ready: true,
        missing: [],
      },
    },
  }),
  'GET /api/design/context': () => ({
    body: {
      ok: true,
      context: {
        windowId: 'win-1',
        targetFingerprint: 'fp-1',
        project: { uuid: 'proj-1' },
        document: { uuid: 'doc-1' },
      },
    },
  }),
  'POST /api/design/approve': () => ({
    body: {
      ok: true,
      approval: {
        approvalId: 'apv-1',
        token: APPROVAL_TOKEN_SECRET,
        planHash: DESIGN_PLAN_HASH,
        expiresAt: Date.now() + 60_000,
        bindings: { planHash: DESIGN_PLAN_HASH, targetFingerprint: 'fp-1', windowId: 'win-1' },
      },
    },
  }),
  'POST /api/design/execute': () => ({
    body: { ok: true, execution: { id: 'exe-1', state: 'completed', planHash: DESIGN_PLAN_HASH } },
  }),
});

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * 启动 fake Runtime。
 *
 * @param {object} [options]
 * @param {string} [options.token] 期望的 agent token（默认 TEST_TOKEN）
 * @param {object} [options.routes] 覆盖默认路由：`'METHOD /path' -> (req, { body, url }) => ({status?, body?, delayMs?})`
 * @returns {Promise<{url: string, requests: Array, route: Function, close: Function, port: number}>}
 */
export async function startFakeRuntime({ token = TEST_TOKEN, routes = {} } = {}) {
  const requests = [];
  const registered = { ...DEFAULT_ROUTES, ...routes };

  const server = http.createServer(async (req, res) => {
    const rawBody = await readRequestBody(req);
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const routeKey = `${req.method} ${url.pathname}`;
    const entry = {
      method: req.method,
      pathname: url.pathname,
      url: req.url,
      search: url.search,
      headers: req.headers,
      body,
      rawBody,
      aborted: false,
      status: null,
    };
    requests.push(entry);

    const headerToken = req.headers['x-circuitpilot-agent-token'];
    if (headerToken !== token) {
      entry.status = 401;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'AGENT_TOKEN_INVALID', message: 'agent token 无效或缺失' }));
      return;
    }

    const handler = registered[routeKey];
    if (!handler) {
      entry.status = 404;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'ROUTE_NOT_FOUND', message: `fake runtime 没有未注册路由：${routeKey}` }));
      return;
    }

    let reply;
    try {
      reply = await handler(req, { body, url, entry });
    } catch (error) {
      entry.status = 500;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'FAKE_RUNTIME_ERROR', message: String(error?.message || error) }));
      return;
    }
    const status = reply?.status ?? 200;
    const delayMs = reply?.delayMs ?? 0;
    const finish = () => {
      if (res.writableEnded || res.destroyed) return;
      entry.status = status;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply?.body ?? { ok: true }));
    };
    // 客户端中途取消（abort）时记录，用于断言 cancellation 真的中止了 HTTP 请求。
    res.on('close', () => {
      if (!res.writableEnded) entry.aborted = true;
    });
    if (delayMs > 0) {
      const timer = setTimeout(finish, delayMs);
      timer.unref?.();
    } else {
      finish();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    /** 运行中动态覆盖/新增路由。 */
    route(key, handler) {
      registered[key] = handler;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
