/**
 * 独立验证用的 fake CircuitPilot Runtime（task-19）。
 *
 * 目标：不启动真实 CircuitPilot Runtime / EDA / DSH，用本地随机端口的 Node http
 * 服务模拟 docs/agent/agent-contract.md §2 的关键路由，让插件 lib 通过真实 HTTP 走一遍。
 *
 * 与 plugin/dsh-circuitpilot/test/helpers.mjs 的区别（独立验证故意不共享实现）：
 *  - 认证/授权直接复用**真实** runtime/agent-token.mjs 与 runtime/agent-auth.mjs 的纯函数，
 *    因此 HTTP 层的 401/403 行为验证的是生产代码，而不是测试里另写一套判断；
 *  - 默认对所有非公开路由校验 x-circuitpilot-agent-token（契约 §1），GET /api/health 公开；
 *  - approve 返回真实 Runtime 形态 { approvalId, token, bindings:{planHash,targetFingerprint,windowId} }
 *    （design 额外平铺 planHash，pcb 不平铺 —— 与 dsh-plugin-dev 的接口注记一致）；
 *  - execute 执行 approvalToken 一次性语义：复用 → 409 APPROVAL_CONSUMED；
 *  - 支持按路由注入失败：401/409/500/延迟（超时）/超大 JSON/直接断连，并记录全部请求；
 *  - 只监听 127.0.0.1:0（随机端口），不读写用户主目录（token 用临时目录）。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAgentToken } from '../../runtime/agent-token.mjs';
import { assertAgentRouteAllowed } from '../../runtime/agent-auth.mjs';
import { RuntimeClient } from '../../plugin/dsh-circuitpilot/lib/runtime.mjs';
import { JobManager } from '../../plugin/dsh-circuitpilot/lib/jobs.mjs';
import { createCircuitPilotTools, normalizeToolConfig } from '../../plugin/dsh-circuitpilot/lib/tools.mjs';

/** 合法 agent token 形状（cpa_ + 48 hex），测试专用、非真实凭证。 */
export const TEST_TOKEN = `cpa_${'1'.repeat(48)}`;
export const BAD_TOKEN = `cpa_${'2'.repeat(48)}`;
export const DESIGN_PLAN_HASH = 'a'.repeat(64);
export const PCB_PLAN_HASH = 'b'.repeat(64);
export const NOW_ISO = '2026-10-29T00:00:00.000Z';
export const AGENT_TOKEN_HEADER = 'x-circuitpilot-agent-token';

/** 结果体积断言常量（契约 §4：maxResultBytes 默认 16KB）。 */
export const MAX_RESULT_BYTES = 16384;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function jsonResponse(res, status, payload, headers = {}) {
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
    /* 客户端已断开（超时用例）：忽略写失败 */
  }
}

function sendRaw(res, status, text) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      connection: 'close',
    });
    res.end(text);
  } catch {
    /* 客户端已断开 */
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
    digest: `verify-digest-${String(index).padStart(3, '0')}`,
    savedAt: NOW_ISO,
    fingerprint: { projectUuid: 'proj-v1' },
    note: `验证证据 #${index}${notePad ? ' ' + 'n'.repeat(notePad) : ''}`,
    path: `artifacts/evidence/${index % 2 === 0 ? 'drc-report' : 'schematic-erc'}/evidence-${index}.json${pathPad ? '?pad=' + 'p'.repeat(pathPad) : ''}`,
  }));
}

/**
 * 启动 fake Runtime。
 *
 * @param {{token?:string, name?:string, scopes?:string[]}} [options]
 */
export async function startFakeRuntime({ token = TEST_TOKEN, name = 'dsh-plugin', scopes = ['read', 'plan', 'execute'] } = {}) {
  const tokenRecord = { token, name, scopes };
  const requests = [];
  const behaviors = new Map(); // 'METHOD /path' -> Behavior[]
  const approvals = new Map(); // approvalToken -> record
  const counters = {
    approvals: 0,
    designExecutes: 0,
    pcbExecutes: 0,
    exports: 0,
    ercRuns: 0,
    gates: 0,
    drcStarts: 0,
    drcPolls: 0,
    health: 0,
  };
  const state = {
    project: {
      id: 'p-verify-1',
      name: '独立验证板',
      code: 'CP-VERIFY',
      stage: 'PCB',
      progress: 0.55,
      archived: false,
      updatedAt: NOW_ISO,
      edaWorkspace: {
        projectUuid: 'proj-v1',
        boardName: '独立验证板',
        schematicUuid: 'sch-v1',
        schematicPageUuid: 'page-v1',
        pcbUuid: 'pcb-v1',
      },
    },
    workspace: {
      projectUuid: 'proj-v1',
      boardName: '独立验证板',
      schematicUuid: 'sch-v1',
      schematicPageUuid: 'page-v1',
      pcbUuid: 'pcb-v1',
    },
    issues: [
      { id: 'iss-warn', severity: 'warning', status: 'investigating', code: 'ERC_WARN', summary: '上拉缺失', occurrences: 1, lastOccurredAt: NOW_ISO },
      { id: 'iss-error', severity: 'error', status: 'open', code: 'DRC_CLEARANCE', summary: '间距不足', occurrences: 3, lastOccurredAt: NOW_ISO, context: { projectId: 'p-verify-1' } },
      { id: 'iss-done', severity: 'critical', status: 'resolved', code: 'X', summary: '已解决', occurrences: 9, lastOccurredAt: NOW_ISO },
    ],
    evidenceEntries: buildEvidenceEntries(2),
    gate: { paused: false, sessionPaused: false, reason: null, actor: null },
    designContext: {
      windowId: 'win-verify-1',
      targetFingerprint: 'tf-design-verify',
      project: { uuid: 'proj-v1' },
      document: { uuid: 'doc-sch-v1', documentType: 2 },
    },
    pcbContext: {
      windowId: 'win-verify-1',
      targetFingerprint: 'tf-pcb-verify',
      project: { uuid: 'proj-v1' },
      pcb: { document: { uuid: 'doc-pcb-v1', documentType: 3 } },
      complete: true,
    },
    drcRunning: false,
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
    state,
    counters,
    /** 注入一次性行为；behavior: {status, body, jsonBytes, raw, delayMs, destroy} */
    enqueue(key, behavior) {
      const queue = behaviors.get(key) ?? [];
      queue.push(behavior);
      behaviors.set(key, queue);
      return runtime;
    },
    enqueueMany(key, list) {
      list.forEach((behavior) => runtime.enqueue(key, behavior));
      return runtime;
    },
    calls(key) {
      return requests.filter((item) => `${item.method} ${item.path}` === key);
    },
    count(key) {
      return runtime.calls(key).length;
    },
    handledCount(key) {
      return runtime.calls(key).filter((item) => item.handled).length;
    },
    deniedCount(key) {
      return runtime.calls(key).filter((item) => item.denied).length;
    },
    setEvidenceEntries(entries) {
      state.evidenceEntries = entries;
      return runtime;
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
        // 防御：残留 keep-alive 连接不应该让 close 永久挂起
        setTimeout(done, 2000).unref?.();
      });
    },
  };

  const dispatch = (method, pathname, query, body) => {
    const key = `${method} ${pathname}`;
    switch (key) {
      case 'GET /api/health':
        counters.health += 1;
        return [200, { ok: true, service: 'circuitpilot-runtime', version: '0.1.0-verify', host: '127.0.0.1' }];
      case 'GET /api/project-state':
        return [200, {
          ok: true,
          state: {
            schemaVersion: 4,
            activeProjectId: state.project.id,
            projects: [state.project],
            requirements: [{ id: 'req-1' }, { id: 'req-2' }, { id: 'req-3' }],
            components: [{ id: 'cmp-1' }, { id: 'cmp-2' }],
            assets: [],
            issues: [],
            validations: [],
          },
          savedAt: NOW_ISO,
        }];
      case 'GET /api/write-gate':
        return [200, { ok: true, gate: state.gate }];
      case 'GET /api/eda/workspaces/current':
        return [200, { ok: true, workspace: state.workspace }];
      case 'GET /api/issue-state':
        return [200, { ok: true, state: { issues: state.issues }, savedAt: NOW_ISO, total: state.issues.length }];
      case 'GET /api/evidence/index':
        return [200, {
          ok: true,
          index: {
            schemaVersion: 1,
            kind: 'evidence-index',
            generatedAt: NOW_ISO,
            complete: true,
            truncated: false,
            entries: state.evidenceEntries,
            invalid: [],
            duplicates: [],
            errors: [],
            summary: {
              entries: state.evidenceEntries.length,
              kinds: { 'drc-report': state.evidenceEntries.filter((item) => item.kind === 'drc-report').length, 'schematic-erc': state.evidenceEntries.filter((item) => item.kind === 'schematic-erc').length },
              invalid: 0,
              duplicates: 0,
              errors: 0,
              oldestSavedAt: NOW_ISO,
              newestSavedAt: NOW_ISO,
            },
          },
        }];
      case 'GET /api/evidence/find': {
        const kind = query.kind;
        const digest = query.digest;
        const entry = state.evidenceEntries.find((item) => (!kind || item.kind === kind) && (!digest || item.digest === digest)) ?? null;
        if (!entry) return [404, { ok: false, error: { code: 'EVIDENCE_NOT_FOUND', message: '证据索引里没有匹配项' } }];
        return [200, { ok: true, evidence: entry, index: { generatedAt: NOW_ISO, complete: true, summary: { entries: state.evidenceEntries.length } } }];
      }
      case 'GET /api/design/context':
        return [200, { ok: true, context: state.designContext }];
      case 'GET /api/pcb/context':
        return [200, { ok: true, context: state.pcbContext }];
      case 'POST /api/design/plan': {
        const plan = body?.plan && typeof body.plan === 'object' ? body.plan : {
          apiVersion: 1,
          kind: 'simple-control-board',
          title: '验证原理图计划',
          blocks: { mcu: { uuid: 'u-mcu', value: 'CH32V003' } },
          nets: ['VCC', 'GND', 'SWDIO'],
          operations: [{ type: 'component.create' }, { type: 'wire.create' }, { type: 'net.label' }],
          placements: [],
          assumptions: ['使用当前原理图页'],
          risks: [{ code: 'MCU_AVAILABILITY', severity: 'medium', summary: 'MCU 交期风险' }],
        };
        return [200, { ok: true, planning: { ready: true, missing: [], planHash: DESIGN_PLAN_HASH, plan } }];
      }
      case 'POST /api/design/plan/ai':
        return [200, {
          ok: true,
          planning: {
            ready: false,
            missing: ['mcu:uuid', 'nets'],
            planHash: DESIGN_PLAN_HASH,
            plan: { kind: 'simple-control-board', blocks: {}, nets: [], operations: [], assumptions: ['AI 候选计划'] },
          },
        }];
      case 'POST /api/pcb/plan': {
        const plan = body?.plan && typeof body.plan === 'object' ? body.plan : {
          apiVersion: 1,
          kind: 'pcb-production-plan',
          title: '验证 PCB 计划',
          board: { widthMm: 42, heightMm: 32, layers: 4, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 },
          operations: [{ type: 'line.create' }, { type: 'via.create' }, { type: 'zone.create' }],
          expectations: { designators: ['U1', 'R1'] },
        };
        return [200, { ok: true, planning: { ready: true, missing: [], planHash: PCB_PLAN_HASH, plan } }];
      }
      case 'POST /api/design/approve':
      case 'POST /api/pcb/approve': {
        const scope = pathname.includes('/design/') ? 'design' : 'pcb';
        const planHash = typeof body?.planHash === 'string' && body.planHash
          ? body.planHash
          : (scope === 'design' ? DESIGN_PLAN_HASH : PCB_PLAN_HASH);
        const context = scope === 'design' ? state.designContext : state.pcbContext;
        const targetFingerprint = typeof body?.targetFingerprint === 'string' && body.targetFingerprint
          ? body.targetFingerprint
          : context.targetFingerprint;
        const windowId = typeof body?.windowId === 'string' && body.windowId ? body.windowId : context.windowId;
        counters.approvals += 1;
        const approvalToken = `rt-approval-${randomUUID()}`;
        const approvalId = `approval-${scope}-${counters.approvals}`;
        approvals.set(approvalToken, {
          scope,
          planHash,
          targetFingerprint,
          windowId,
          approvalId,
          used: false,
          confirm: body?.confirm === true,
        });
        const approval = {
          approvalId,
          scope,
          token: approvalToken,
          bindings: { planHash, targetFingerprint, windowId, steps: ['snapshot', 'write'] },
          issuedAt: NOW_ISO,
          expiresAt: Date.now() + 10 * 60 * 1000,
          ...(scope === 'design' ? { planHash } : {}),
        };
        return [200, { ok: true, approval }];
      }
      case 'POST /api/design/execute':
      case 'POST /api/pcb/execute': {
        const scope = pathname.includes('/design/') ? 'design' : 'pcb';
        if (state.gate.paused || state.gate.sessionPaused) {
          return [409, { ok: false, error: { code: 'WRITE_PAUSED', message: `写入已暂停：${state.gate.reason ?? 'write gate paused'}` } }];
        }
        const approvalToken = typeof body?.approvalToken === 'string' ? body.approvalToken : '';
        const approval = approvals.get(approvalToken);
        if (!approval) {
          return [409, { ok: false, error: { code: 'APPROVAL_REQUIRED', message: '缺少有效 approvalToken，拒绝执行' } }];
        }
        if (approval.used) {
          return [409, { ok: false, error: { code: 'APPROVAL_CONSUMED', message: 'approvalToken 已被使用（一次性），拒绝重放' } }];
        }
        if (approval.scope !== scope) {
          return [409, { ok: false, error: { code: 'APPROVAL_SCOPE_MISMATCH', message: `approvalToken scope=${approval.scope} 不能用于 ${scope} 执行` } }];
        }
        if (typeof body?.targetFingerprint === 'string' && body.targetFingerprint && body.targetFingerprint !== approval.targetFingerprint) {
          return [409, { ok: false, error: { code: 'TARGET_MISMATCH', message: '目标指纹与批准绑定不一致' } }];
        }
        approval.used = true;
        approval.usedAt = Date.now();
        if (scope === 'design') counters.designExecutes += 1;
        else counters.pcbExecutes += 1;
        const executionId = `${scope}-exec-${scope === 'design' ? counters.designExecutes : counters.pcbExecutes}`;
        return [200, {
          ok: true,
          execution: {
            id: executionId,
            state: 'completed',
            planHash: approval.planHash,
            projectId: 'proj-v1',
            documentUuid: scope === 'design' ? 'doc-sch-v1' : 'doc-pcb-v1',
            steps: [{ id: 'snapshot', status: 'done' }, { id: 'write', status: 'done' }],
            verified: true,
          },
        }];
      }
      case 'POST /api/eda/schematic/erc/run':
        counters.ercRuns += 1;
        return [200, {
          ok: true,
          erc: { counts: { error: 0, warning: 1, fatal: 0 }, aggregateOnly: false, documentUuid: 'sch-v1' },
          ercDetail: { ok: true, reason: null },
          saved: { path: 'artifacts/evidence/schematic-erc/erc-verify.json', digest: 'erc-verify-digest', savedAt: NOW_ISO },
        }];
      case 'POST /api/eda/pcb/drc/start':
        counters.drcStarts += 1;
        state.drcRunning = true;
        state.drcPolls = 0;
        return [200, { ok: true, jobId: 'drc-job-verify', state: 'running', startedAt: NOW_ISO }];
      case 'POST /api/eda/pcb/drc/report': {
        counters.drcPolls += 1;
        state.drcPolls = (state.drcPolls ?? 0) + 1;
        if (state.drcPolls < 2) return [200, { ok: true, state: 'running', jobId: 'drc-job-verify' }];
        state.drcRunning = false;
        return [200, {
          ok: true,
          state: 'done',
          jobId: 'drc-job-verify',
          report: { counts: { error: 0, warning: 2 }, itemCount: 0, items: [], truncated: false },
          classification: { ready: true, summary: { total: 0, exempted: 0, unexplained: 0 }, findings: [] },
          saved: { path: 'artifacts/evidence/drc-report/drc-verify.json', digest: 'drc-verify-digest', savedAt: NOW_ISO },
        }];
      }
      case 'POST /api/eda/gates/evaluate':
        counters.gates += 1;
        return [200, {
          ok: true,
          report: { verdict: 'pass', ready: true, gates: [{ id: 'G1', status: 'pass' }, { id: 'G2', status: 'pass' }] },
          knowledgeAdvice: { suggested: [], candidates: [] },
        }];
      case 'POST /api/production/export':
        counters.exports += 1;
        return [200, {
          ok: true,
          exported: true,
          final: true,
          outDir: '/tmp/cp-verify-export',
          files: [{ path: 'board.gbr' }, { path: 'bom.csv' }, { path: 'drill.drl' }],
          manifestHash: 'manifest-verify-1',
          decision: { allowed: true, outputClass: 'final', blockers: [] },
        }];
      case 'GET /api/knowledge/entries': {
        // 模拟真实 Runtime：按 reviewState/kind/text 过滤后再返回（candidate 不能当依据）。
        const all = [
          { id: 'k-1', kind: 'rule', title: 'DRC 间距规则', trust: 'high', review: { state: 'approved' }, digest: 'k-digest-1', updatedAt: NOW_ISO },
          { id: 'k-2', kind: 'rule', title: '未审核候选', trust: 'low', review: { state: 'candidate' }, digest: 'k-digest-2', updatedAt: NOW_ISO },
        ];
        const knowledge = all.filter((entry) => {
          if (query.reviewState && entry.review.state !== query.reviewState) return false;
          if (query.kind && entry.kind !== query.kind) return false;
          if (query.trust && entry.trust !== query.trust) return false;
          if (query.text && !entry.title.includes(query.text)) return false;
          return true;
        });
        return [200, { ok: true, knowledge }];
      }
      case 'POST /api/rag/query':
        return [200, {
          ok: true,
          rag: {
            query: body?.query ?? '',
            results: [{ id: 'k-1', title: 'DRC 间距规则', kind: 'rule', score: 0.91, reviewState: 'approved' }],
            total: 1,
          },
        }];
      default:
        if (method === 'GET' && /^\/api\/design\/executions\/[^/]+\/evidence$/.test(pathname)) {
          return [200, { ok: true, evidence: { id: decodeURIComponent(pathname.split('/')[4]), planHash: DESIGN_PLAN_HASH, steps: [], files: [] }, digest: 'exec-evidence-digest' }];
        }
        return [404, { ok: false, error: { code: 'ROUTE_NOT_FOUND', message: `fake runtime 未实现 ${key}` } }];
    }
  };

  const server = http.createServer(async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      return jsonResponse(res, 400, { ok: false, error: { code: 'BAD_PATH', message: 'bad url' } });
    }
    const pathname = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    let body = null;
    try {
      body = await readJsonBody(req);
    } catch {
      body = null;
    }
    const key = `${method} ${pathname}`;
    const record = {
      method,
      path: pathname,
      query,
      headers: { ...req.headers },
      body,
      at: Date.now(),
      status: 0,
      authorized: false,
      denied: false,
      handled: false,
      agent: null,
    };
    requests.push(record);

    // 1) 公开路由：GET /api/health（契约 §2；Runtime 不要求 token）。
    if (method === 'GET' && pathname === '/api/health') {
      const agent = verifyAgentToken(req.headers[AGENT_TOKEN_HEADER], tokenRecord);
      record.agent = agent?.name ?? null;
      record.authorized = Boolean(agent);
      const behavior = takeBehavior(key);
      if (behavior) return applyBehavior(record, res, behavior);
      record.handled = true;
      record.status = 200;
      return jsonResponse(res, 200, { ok: true, service: 'circuitpilot-runtime', version: '0.1.0-verify', host: '127.0.0.1' });
    }

    // 2) 认证：真实 runtime/agent-token.mjs 的常量时间比较。
    const agent = verifyAgentToken(req.headers[AGENT_TOKEN_HEADER], tokenRecord);
    if (!agent) {
      record.status = 401;
      return jsonResponse(res, 401, { ok: false, error: { code: 'AGENT_TOKEN_INVALID', message: 'Runtime会话令牌无效' } });
    }
    record.authorized = true;
    record.agent = agent.name ?? null;

    // 3) 授权：真实 runtime/agent-auth.mjs 的 denylist/审批豁免。
    try {
      assertAgentRouteAllowed(method, pathname);
    } catch (error) {
      record.denied = true;
      record.status = 403;
      return jsonResponse(res, 403, { ok: false, error: { code: error.code ?? 'AGENT_ROUTE_FORBIDDEN', message: error.message } });
    }

    // 4) 失败注入（认证/授权通过后，模拟 Runtime 内部错误/超时/大响应）。
    const behavior = takeBehavior(key);
    if (behavior) return applyBehavior(record, res, behavior);

    record.handled = true;
    try {
      const [status, payload] = dispatch(method, pathname, query, body);
      record.status = status;
      return jsonResponse(res, status, payload);
    } catch (error) {
      record.status = 500;
      return jsonResponse(res, 500, { ok: false, error: { code: 'FAKE_HANDLER_ERROR', message: String(error?.message ?? error) } });
    }
  });

  async function applyBehavior(record, res, behavior) {
    if (behavior.delayMs) await sleep(behavior.delayMs);
    if (behavior.destroy) {
      record.status = 0;
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    const status = Number.isInteger(behavior.status) ? behavior.status : 200;
    record.status = status;
    if (Number.isFinite(behavior.jsonBytes) && behavior.jsonBytes > 0) {
      return sendRaw(res, status, JSON.stringify({ ok: true, blob: 'x'.repeat(Math.floor(behavior.jsonBytes)) }));
    }
    if (typeof behavior.raw === 'string') return sendRaw(res, status, behavior.raw);
    return jsonResponse(res, status, behavior.body ?? { ok: true });
  }

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

/**
 * 构造插件工具 harness（默认 fake runtime + RuntimeClient + JobManager）。
 * 显式传 token（不读主目录 token 文件）；token 文件用例见 createTempAgentTokenFile。
 */
export async function createToolHarness({ runtime, approvalMode = 'chat', config = {}, clientOptions = {} } = {}) {
  const rt = runtime ?? await startFakeRuntime();
  const normalized = normalizeToolConfig({
    runtimeUrl: rt.url,
    approvalMode,
    requestTimeoutMs: 3000,
    jobTimeoutMs: 3000,
    drcPollIntervalMs: 5,
    drcPollTimeoutMs: 2000,
    approvalTtlMs: 60_000,
    planTtlMs: 60_000,
    maxResultBytes: MAX_RESULT_BYTES,
    ...config,
  });
  const client = new RuntimeClient({
    baseUrl: rt.url,
    token: rt.token,
    timeoutMs: normalized.requestTimeoutMs,
    ...clientOptions,
  });
  const jobs = new JobManager({ defaultTimeoutMs: normalized.jobTimeoutMs });
  const tools = createCircuitPilotTools({ config: normalized, client, jobs });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return {
    runtime: rt,
    client,
    jobs,
    tools,
    byName,
    config: normalized,
    callTool: (name, args = {}, exec = {}) => byName[name].execute(args, exec),
    close: async () => {
      jobs.cancelAll();
      await rt.close();
    },
  };
}

/** 用真实 runtime/agent-token.mjs 的原子写入签发临时 token 文件（mkdtemp，0600）。 */
export async function createTempAgentTokenFile({ token = TEST_TOKEN, name = 'dsh-plugin' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cp-verify-token-'));
  const file = join(dir, 'agent-token.json');
  await writeFile(file, `${JSON.stringify({
    version: 1,
    name,
    token,
    scopes: ['read', 'plan', 'execute'],
    createdAt: NOW_ISO,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { dir, file, token, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 对任意值取 JSON 字节数（用于"结果 ≤ maxResultBytes"断言）。 */
export function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** 等待 job 到终态（工具层辅助）。 */
export async function waitJob(harness, jobId, timeoutMs = 3000) {
  return harness.callTool('cp_job', { action: 'wait', jobId, timeoutMs });
}
