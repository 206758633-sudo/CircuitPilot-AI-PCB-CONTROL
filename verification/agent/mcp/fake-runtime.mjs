/**
 * MCP 协议/安全独立复验用的 fake CircuitPilot Runtime（task-22）。
 *
 * 只实现 agent/mcp-server.mjs 通过 plugin lib 会调用到的关键路由，用于：
 *  - 让 MCP server 子进程完成 cp_status 等真实工具调用；
 *  - 注入 500/409/超时/大结果，验证业务错误 envelope 与 16KB 裁剪；
 *  - 记录请求，并检测「客户端取消后底层 HTTP 请求确实被 abort」。
 *
 * 不启动真实 Runtime / EDA，不连 4178；只监听 127.0.0.1 随机端口。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { verifyAgentToken } from '../../../runtime/agent-token.mjs';

/** 测试专用 token（cpa_ + 48 hex），非真实凭证。 */
export const TEST_TOKEN = `cpa_${'1'.repeat(48)}`;
export const DESIGN_PLAN_HASH = 'a'.repeat(64);
export const PCB_PLAN_HASH = 'b'.repeat(64);
export const NOW_ISO = '2026-10-29T00:00:00.000Z';
export const AGENT_TOKEN_HEADER = 'x-circuitpilot-agent-token';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  try {
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      connection: 'close',
      ...headers,
    });
    res.end(body);
  } catch {
    /* 客户端已断开（取消用例），忽略 */
  }
}

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildEvidenceEntries(count, { pathPad = 0, notePad = 0 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    kind: index % 2 === 0 ? 'drc-report' : 'schematic-erc',
    digest: `mcp-verify-digest-${String(index).padStart(3, '0')}`,
    savedAt: NOW_ISO,
    fingerprint: { projectUuid: 'proj-mcp-verify' },
    note: `MCP 验证证据 #${index}${notePad ? ' ' + 'n'.repeat(notePad) : ''}`,
    path: `artifacts/evidence/mcp/evidence-${index}.json${pathPad ? '?pad=' + 'p'.repeat(pathPad) : ''}`,
  }));
}

/**
 * 启动 fake Runtime。
 * @param {{token?:string}} [options]
 */
export async function startFakeRuntime({ token = TEST_TOKEN } = {}) {
  const tokenRecord = { token, name: 'dsh-plugin', scopes: ['read', 'plan', 'execute'] };
  const requests = [];
  const abortedPaths = [];
  const behaviors = new Map(); // 'METHOD /path' -> Behavior[]
  const approvals = new Map(); // approvalToken -> record
  const counters = {
    designApprovals: 0,
    pcbApprovals: 0,
    designExecutes: 0,
    pcbExecutes: 0,
    approvals: 0,
  };
  const state = {
    gate: { paused: false, sessionPaused: false, reason: null, actor: null },
    evidenceEntries: buildEvidenceEntries(2),
    designContext: {
      windowId: 'win-mcp-verify',
      targetFingerprint: 'tf-design-mcp-verify',
      project: { uuid: 'proj-mcp-verify' },
      document: { uuid: 'doc-sch-mcp-verify', documentType: 2 },
    },
    pcbContext: {
      windowId: 'win-mcp-verify',
      targetFingerprint: 'tf-pcb-mcp-verify',
      project: { uuid: 'proj-mcp-verify' },
      pcb: { document: { uuid: 'doc-pcb-mcp-verify', documentType: 3 } },
      complete: true,
    },
  };

  const takeBehavior = (key) => {
    const queue = behaviors.get(key);
    if (!Array.isArray(queue) || queue.length === 0) return null;
    const behavior = queue.shift();
    if (queue.length === 0) behaviors.delete(key);
    return behavior;
  };

  const runtime = {
    url: '',
    port: 0,
    token,
    requests,
    abortedPaths,
    counters,
    state,
    enqueue(key, behavior) {
      const queue = behaviors.get(key) ?? [];
      queue.push(behavior);
      behaviors.set(key, queue);
      return runtime;
    },
    calls(key) {
      return requests.filter((item) => `${item.method} ${item.path}` === key);
    },
    count(key) {
      return runtime.calls(key).length;
    },
    setLargeEvidence(count = 50, padding = 1200) {
      state.evidenceEntries = buildEvidenceEntries(count, { pathPad: padding, notePad: padding });
      return runtime;
    },
    setGate(gate) {
      state.gate = { paused: false, sessionPaused: false, reason: null, actor: null, ...gate };
      return runtime;
    },
    approvalRecords() {
      return [...approvals.entries()].map(([approvalToken, record]) => ({ approvalToken, ...record }));
    },
    async waitForRequest(predicate, timeoutMs = 3000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (requests.some(predicate)) return true;
        await sleep(10);
      }
      return false;
    },
    async waitForAbort(pathname, timeoutMs = 3000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (abortedPaths.includes(pathname)) return true;
        await sleep(10);
      }
      return false;
    },
    close: async () => {
      try {
        server.closeAllConnections?.();
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        server.close(done);
        setTimeout(done, 2000).unref?.();
      });
    },
  };

  function dispatch(method, pathname, query, body) {
    const key = `${method} ${pathname}`;
    switch (key) {
      case 'GET /api/health':
        return [200, { ok: true, service: 'circuitpilot-runtime', version: '0.1.0-mcp-fake', host: '127.0.0.1' }];
      case 'GET /api/project-state':
        return [200, {
          ok: true,
          state: {
            schemaVersion: 4,
            activeProjectId: 'p-mcp-verify',
            projects: [{
              id: 'p-mcp-verify',
              name: 'MCP独立验证板',
              code: 'CP-MCP-VERIFY',
              stage: 'PCB',
              progress: 0.6,
              archived: false,
              updatedAt: NOW_ISO,
              edaWorkspace: { projectUuid: 'proj-mcp-verify', boardName: 'MCP独立验证板', schematicUuid: 'sch-v1', pcbUuid: 'pcb-v1' },
            }],
            requirements: [{ id: 'req-1' }, { id: 'req-2' }],
            components: [{ id: 'cmp-1' }],
            assets: [],
            issues: [],
          },
          savedAt: NOW_ISO,
        }];
      case 'GET /api/write-gate':
        return [200, { ok: true, gate: state.gate }];
      case 'GET /api/eda/workspaces/current':
        return [200, { ok: true, workspace: { projectUuid: 'proj-mcp-verify', boardName: 'MCP独立验证板', schematicUuid: 'sch-v1', pcbUuid: 'pcb-v1' } }];
      case 'GET /api/issue-state':
        return [200, { ok: true, state: { issues: [
          { id: 'iss-1', severity: 'warning', status: 'open', code: 'ERC_WARN', summary: '上拉缺失', occurrences: 1, lastOccurredAt: NOW_ISO },
        ] }, savedAt: NOW_ISO }];
      case 'GET /api/evidence/index':
        return [200, {
          ok: true,
          index: {
            schemaVersion: 1,
            generatedAt: NOW_ISO,
            complete: true,
            truncated: false,
            entries: state.evidenceEntries,
            invalid: [],
            duplicates: [],
            errors: [],
            summary: { entries: state.evidenceEntries.length },
          },
        }];
      case 'GET /api/evidence/find': {
        const entry = state.evidenceEntries.find((item) => (!query.kind || item.kind === query.kind) && (!query.digest || item.digest === query.digest)) ?? null;
        if (!entry) return [404, { ok: false, error: { code: 'EVIDENCE_NOT_FOUND', message: '没有匹配证据' } }];
        return [200, { ok: true, evidence: entry, index: { generatedAt: NOW_ISO, complete: true, summary: { entries: state.evidenceEntries.length } } }];
      }
      case 'GET /api/design/context':
        return [200, { ok: true, context: state.designContext }];
      case 'GET /api/pcb/context':
        return [200, { ok: true, context: state.pcbContext }];
      case 'POST /api/design/plan': {
        const plan = body?.plan && typeof body.plan === 'object' ? body.plan : { kind: 'simple-control-board', operations: [{ type: 'wire.create' }] };
        return [200, { ok: true, planning: { ready: true, missing: [], planHash: DESIGN_PLAN_HASH, plan } }];
      }
      case 'POST /api/pcb/plan': {
        const plan = body?.plan && typeof body.plan === 'object' ? body.plan : { board: { layers: 4 }, operations: [{ type: 'line.create' }] };
        return [200, { ok: true, planning: { ready: true, missing: [], planHash: PCB_PLAN_HASH, plan } }];
      }
      case 'POST /api/design/approve':
      case 'POST /api/pcb/approve': {
        const scope = pathname.includes('/design/') ? 'design' : 'pcb';
        const context = scope === 'design' ? state.designContext : state.pcbContext;
        const planHash = typeof body?.planHash === 'string' && body.planHash
          ? body.planHash
          : (scope === 'design' ? DESIGN_PLAN_HASH : PCB_PLAN_HASH);
        const targetFingerprint = typeof body?.targetFingerprint === 'string' && body.targetFingerprint
          ? body.targetFingerprint
          : context.targetFingerprint;
        const windowId = typeof body?.windowId === 'string' && body.windowId ? body.windowId : context.windowId;
        counters.approvals += 1;
        if (scope === 'design') counters.designApprovals += 1;
        else counters.pcbApprovals += 1;
        const approvalToken = `rt-approval-mcp-${randomUUID()}`;
        const approvalId = `approval-${scope}-${counters.approvals}`;
        approvals.set(approvalToken, { scope, planHash, targetFingerprint, windowId, approvalId, used: false });
        return [200, {
          ok: true,
          approval: {
            approvalId,
            scope,
            token: approvalToken,
            bindings: { planHash, targetFingerprint, windowId, steps: ['snapshot', 'write'] },
            issuedAt: NOW_ISO,
            expiresAt: Date.now() + 10 * 60 * 1000,
            ...(scope === 'design' ? { planHash } : {}),
          },
        }];
      }
      case 'POST /api/design/execute':
      case 'POST /api/pcb/execute': {
        const scope = pathname.includes('/design/') ? 'design' : 'pcb';
        if (state.gate.paused || state.gate.sessionPaused) {
          return [409, { ok: false, error: { code: 'WRITE_PAUSED', message: `写入已暂停：${state.gate.reason ?? 'gate paused'}` } }];
        }
        const approvalToken = typeof body?.approvalToken === 'string' ? body.approvalToken : '';
        const approval = approvals.get(approvalToken);
        if (!approval) return [409, { ok: false, error: { code: 'APPROVAL_REQUIRED', message: '缺少有效 approvalToken' } }];
        if (approval.used) return [409, { ok: false, error: { code: 'APPROVAL_CONSUMED', message: 'approvalToken 已被使用' } }];
        if (approval.scope !== scope) return [409, { ok: false, error: { code: 'APPROVAL_SCOPE_MISMATCH', message: 'approval scope 不匹配' } }];
        approval.used = true;
        if (scope === 'design') counters.designExecutes += 1;
        else counters.pcbExecutes += 1;
        return [200, {
          ok: true,
          execution: {
            id: `${scope}-exec-${counters.approvals}`,
            state: 'completed',
            planHash: approval.planHash,
            projectId: 'proj-mcp-verify',
            steps: [{ id: 'write', status: 'done' }],
            verified: true,
          },
        }];
      }
      case 'GET /api/knowledge/entries': {
        const knowledge = [
          { id: 'k-1', kind: 'rule', title: 'DRC 间距规则', trust: 'high', review: { state: 'approved' }, digest: 'mcp-k-digest-1', updatedAt: NOW_ISO },
          { id: 'k-2', kind: 'rule', title: '未审核候选', trust: 'low', review: { state: 'candidate' }, digest: 'mcp-k-digest-2', updatedAt: NOW_ISO },
        ].filter((entry) => (!query.reviewState || entry.review.state === query.reviewState) && (!query.kind || entry.kind === query.kind));
        return [200, { ok: true, knowledge }];
      }
      case 'POST /api/rag/query':
        return [200, { ok: true, rag: { query: body?.query ?? '', results: [{ id: 'k-1', title: 'DRC 间距规则', score: 0.9, reviewState: 'approved' }], total: 1 } }];
      case 'POST /api/production/export':
        return [200, { ok: true, exported: true, final: true, outDir: '/tmp/mcp-verify-export', files: [{ path: 'board.gbr' }], manifestHash: 'manifest-mcp-verify' }];
      default:
        if (method === 'GET' && /^\/api\/design\/executions\/[^/]+\/evidence$/.test(pathname)) {
          return [200, { ok: true, evidence: { id: pathname.split('/')[4], planHash: DESIGN_PLAN_HASH, steps: [], files: [] }, digest: 'mcp-exec-evidence-digest' }];
        }
        return [404, { ok: false, error: { code: 'ROUTE_NOT_FOUND', message: `fake runtime 未实现 ${key}` } }];
    }
  }

  async function applyBehavior(record, res, behavior) {
    if (behavior.delayMs) await sleep(behavior.delayMs);
    const status = Number.isInteger(behavior.status) ? behavior.status : 200;
    record.status = status;
    if (Number.isFinite(behavior.jsonBytes) && behavior.jsonBytes > 0) {
      const text = JSON.stringify({ ok: true, blob: 'x'.repeat(Math.floor(behavior.jsonBytes)) });
      if (res.writableEnded || res.destroyed) return;
      try {
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), connection: 'close' });
        res.end(text);
      } catch {
        /* ignore */
      }
      return;
    }
    sendJson(res, status, behavior.body ?? { ok: true });
  }

  const server = http.createServer(async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: 'BAD_PATH', message: 'bad url' } });
    }
    const pathname = url.pathname;
    const key = `${method} ${pathname}`;
    let body = null;
    try {
      body = await readJsonBody(req);
    } catch {
      body = null;
    }
    const record = {
      method,
      path: pathname,
      key,
      query: Object.fromEntries(url.searchParams),
      headers: { ...req.headers },
      body,
      at: Date.now(),
      status: 0,
      handled: false,
      aborted: false,
    };
    requests.push(record);
    // 取消/超时用例：客户端提前断开 → 记录 abort，证明取消穿透到了 HTTP 层。
    res.on('close', () => {
      if (!res.writableEnded && !record.aborted) {
        record.aborted = true;
        abortedPaths.push(pathname);
      }
    });

    // 公开路由（与真实 Runtime 一致：health 不要求 token）
    if (method === 'GET' && pathname === '/api/health') {
      const behavior = takeBehavior(key);
      if (behavior) return applyBehavior(record, res, behavior);
      record.handled = true;
      record.status = 200;
      return sendJson(res, 200, { ok: true, service: 'circuitpilot-runtime', version: '0.1.0-mcp-fake', host: '127.0.0.1' });
    }

    const agent = verifyAgentToken(req.headers[AGENT_TOKEN_HEADER], tokenRecord);
    if (!agent) {
      record.status = 401;
      return sendJson(res, 401, { ok: false, error: { code: 'AGENT_TOKEN_INVALID', message: 'Runtime会话令牌无效' } });
    }

    const behavior = takeBehavior(key);
    if (behavior) {
      record.handled = true;
      return applyBehavior(record, res, behavior);
    }

    record.handled = true;
    const [status, payload] = dispatch(method, pathname, record.query, body);
    record.status = status;
    return sendJson(res, status, payload);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  runtime.port = address.port;
  runtime.url = `http://127.0.0.1:${address.port}`;
  runtime.server = server;
  return runtime;
}
