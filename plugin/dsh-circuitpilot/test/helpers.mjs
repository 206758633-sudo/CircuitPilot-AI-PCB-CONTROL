/**
 * 测试辅助：本地 fake CircuitPilot Runtime + 工具 harness。
 * 只使用 node:http / node:fs 内置模块，不依赖 DSH、不依赖真实 token/EDA。
 * token 一律用临时目录，不读取用户主目录下的凭证。
 */
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient } from '../lib/runtime.mjs';
import { JobManager } from '../lib/jobs.mjs';
import { createCircuitPilotTools, normalizeToolConfig } from '../lib/tools.mjs';

export const TEST_TOKEN = 'cpa_0123456789abcdef0123456789abcdef0123456789abcdef';
export const DESIGN_HASH = 'a'.repeat(64);
export const PCB_HASH = 'b'.repeat(64);
export const APPROVAL_TOKEN = 'rt-approval-token-do-not-expose';
export const NOW_ISO = '2026-10-29T00:00:00.000Z';

export function jsonResponse(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
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

/**
 * 启动 fake Runtime。默认对所有请求校验 x-circuitpilot-agent-token。
 * handler(call, context) 返回 payload（200）、[status, payload] 或 undefined（自行响应）。
 */
export async function startFakeRuntime({ token = TEST_TOKEN, handler, requireToken = true } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const url = new URL(req.url, 'http://127.0.0.1');
      const call = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: { ...req.headers },
        body,
        at: Date.now(),
      };
      calls.push(call);
      if (requireToken && req.headers['x-circuitpilot-agent-token'] !== token) {
        return jsonResponse(res, 401, { ok: false, error: { code: 'AGENT_TOKEN_INVALID', message: 'Runtime会话令牌无效' } });
      }
      const output = await handler(call, { calls, res });
      if (output === undefined) return undefined;
      if (Array.isArray(output) && output.length === 2 && Number.isInteger(output[0])) {
        return jsonResponse(res, output[0], output[1]);
      }
      return jsonResponse(res, 200, output ?? {});
    } catch (error) {
      return jsonResponse(res, 500, { ok: false, error: { code: 'FAKE_HANDLER_ERROR', message: String(error?.message ?? error) } });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 临时 token 文件（mkdtemp，不碰真实用户目录）。 */
export async function makeTokenFile({ token = TEST_TOKEN, name = 'agent-token.json', payload } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cp-token-'));
  const file = join(dir, name);
  await writeFile(file, JSON.stringify({
    version: 1,
    name: 'dsh-plugin',
    token,
    scopes: ['read', 'plan', 'execute'],
    createdAt: NOW_ISO,
    ...(payload ?? {}),
  }), 'utf8');
  return { dir, file, token, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 默认的路由表 + 请求记录。 */
export function createDefaultRouter() {
  const state = {
    drcPolls: 0,
    drcStarts: [],
    drcPollsByJob: {},
    planBodies: [],
    approveBodies: [],
    executeBodies: [],
    exportBodies: [],
    exportCalls: 0,
    projectListCalls: 0,
    projectStateCalls: [],
    knowledgeQueries: [],
    ragBodies: [],
    ercCalls: 0,
    ercBodies: [],
    gatesCalls: 0,
    gatesBodies: [],
  };

  const base = {
    project: {
      id: 'p-test-1',
      name: '测试控制板',
      code: 'CP-TEST',
      description: 'unit-test project',
      stage: 'PCB',
      rootPath: '/tmp/cp-test',
      edaProjectPath: '/tmp/cp-test/eda',
      edaWorkspace: {
        projectUuid: 'proj1',
        boardName: '测试板',
        schematicUuid: 'sch1',
        schematicPageUuid: 'page1',
        pcbUuid: 'pcb1',
        schematicStatus: 'generated',
      },
      archived: false,
      progress: 0.5,
      updatedAt: NOW_ISO,
    },
    workspace: {
      projectUuid: 'proj1',
      boardName: '测试板',
      schematicUuid: 'sch1',
      schematicPageUuid: 'page1',
      pcbUuid: 'pcb1',
    },
    issues: [
      { id: 'i-open-error', severity: 'error', status: 'open', code: 'DRC_CLEARANCE', summary: '间距不足', occurrences: 3, lastOccurredAt: NOW_ISO, handling: [], context: { projectId: 'p-test-1' } },
      { id: 'i-open-warning', severity: 'warning', status: 'investigating', code: 'ERC_WARN', summary: '上拉缺失', occurrences: 1, lastOccurredAt: NOW_ISO, handling: [] },
      { id: 'i-resolved', severity: 'critical', status: 'resolved', code: 'X', summary: '已解决', occurrences: 9, lastOccurredAt: NOW_ISO, handling: [] },
      { id: 'i-ignored', severity: 'warning', status: 'ignored', code: 'Y', summary: '已忽略', occurrences: 1, lastOccurredAt: NOW_ISO, handling: [] },
    ],
    evidenceEntries: [
      { kind: 'drc-report', digest: 'drc-old-digest', savedAt: NOW_ISO, fingerprint: { pcbUuid: 'pcb1' }, note: 'pcb drc job report', path: 'artifacts/evidence/drc-report/drc-report-old.json' },
      { kind: 'schematic-erc', digest: 'erc-old-digest', savedAt: NOW_ISO, fingerprint: { projectUuid: 'proj1' }, note: '原理图 ERC 取证', path: 'artifacts/evidence/schematic-erc/erc-old.json' },
    ],
  };

  // 多项目/多板只读总览夹具：两个项目用“state.data 数组（Project 包裹 Board）”的真实 EDA 形态，
  // p-2 用“state.data 对象（data + 计数）”形态验证兼容，p-many 有 25 个 Board 验证每项目 20 上限。
  const projects = [
    { id: 'p-test-1', name: '测试控制板', stage: 'PCB', archived: false, edaBound: true, savedAt: NOW_ISO, requirements: 2, components: 1, assets: 0 },
    { id: 'p-2', name: '双电池板', stage: '布线', archived: false, edaBound: false, savedAt: NOW_ISO, requirements: 3, components: 2, assets: 1 },
    { id: 'p-3', name: '衣橱板', stage: '需求澄清', archived: true, edaBound: false, savedAt: null, requirements: 1, components: 0, assets: 0 },
    { id: 'p-many', name: '多板工程', stage: 'PCB', archived: false, edaBound: true, savedAt: NOW_ISO, requirements: 0, components: 0, assets: 0 },
  ];
  const projectStates = {
    'p-test-1': {
      savedAt: NOW_ISO,
      state: {
        schemaVersion: 4,
        savedAt: NOW_ISO,
        data: [{
          itemType: 'Project',
          uuid: 'proj1',
          name: '测试控制板EDA工程',
          data: [
            { itemType: 'Board', name: '主控板', pcb: { uuid: 'pcb-main' }, schematic: { uuid: 'sch-main' } },
            { itemType: 'Board', name: '电源板', pcb: { uuid: 'pcb-power' }, schematic: { uuid: 'sch-power' } },
            { itemType: 'Component', name: 'U1', uuid: 'comp-1' },
          ],
        }],
        requirements: [{ id: 'r1' }, { id: 'r2' }],
        components: [{ id: 'c1' }],
        assets: [],
      },
    },
    'p-2': {
      savedAt: NOW_ISO,
      state: {
        schemaVersion: 4,
        savedAt: NOW_ISO,
        data: {
          data: [{ itemType: 'Board', name: '双电池主控板', pcb: { uuid: 'pcb-b2' }, schematic: { uuid: 'sch-b2' } }],
          requirements: [{ id: 'rr1' }, { id: 'rr2' }, { id: 'rr3' }],
          components: [{ id: 'cc1' }, { id: 'cc2' }],
          assets: [{ id: 'aa1' }],
        },
      },
    },
    'p-3': {
      savedAt: null,
      state: { schemaVersion: 4, data: [], requirements: [{ id: 'x1' }], components: [], assets: [] },
    },
    'p-many': {
      savedAt: NOW_ISO,
      state: {
        schemaVersion: 4,
        data: [{
          itemType: 'Project',
          uuid: 'proj-many',
          data: Array.from({ length: 25 }, (_unused, index) => ({
            itemType: 'Board',
            name: `Board-${index + 1}`,
            pcb: { uuid: `pcb-${index + 1}` },
            schematic: { uuid: `sch-${index + 1}` },
          })),
        }],
        requirements: [],
        components: [],
        assets: [],
      },
    },
  };

  const handler = async (call) => {
    const { method, path } = call;
    const key = `${method} ${path}`;
    switch (key) {
      case 'GET /api/health':
        return { ok: true, service: 'circuitpilot-runtime', version: '9.9.9-test', host: '127.0.0.1' };
      case 'GET /api/project-state':
        return {
          ok: true,
          state: {
            schemaVersion: 4,
            currentPage: 'overview',
            activeProjectId: 'p-test-1',
            projects: [base.project],
            requirements: [{ id: 'r1' }, { id: 'r2' }],
            components: [{ id: 'c1' }],
            assets: [],
            issues: [],
            validations: [],
          },
          savedAt: NOW_ISO,
        };
      case 'GET /api/write-gate':
        return { ok: true, gate: { paused: false, sessionPaused: false, reason: null, actor: null } };
      case 'GET /api/eda/workspaces/current':
        return { ok: true, workspace: base.workspace };
      case 'GET /api/issue-state':
        return { ok: true, state: { issues: base.issues }, savedAt: NOW_ISO, total: base.issues.length };
      case 'GET /api/evidence/index':
        return {
          ok: true,
          index: {
            schemaVersion: 1,
            kind: 'evidence-index',
            generatedAt: NOW_ISO,
            complete: true,
            truncated: false,
            entries: base.evidenceEntries,
            invalid: [],
            duplicates: [],
            errors: [],
            summary: {
              entries: base.evidenceEntries.length,
              kinds: { 'drc-report': 1, 'schematic-erc': 1 },
              invalid: 0,
              duplicates: 0,
              errors: 0,
              truncated: false,
              newestSavedAt: NOW_ISO,
              oldestSavedAt: NOW_ISO,
            },
          },
        };
      case 'GET /api/evidence/find': {
        const kind = call.query.kind;
        const digest = call.query.digest;
        const entry = base.evidenceEntries.find((item) => (!kind || item.kind === kind) && (!digest || item.digest === digest));
        if (!entry) return [404, { ok: false, error: { code: 'EVIDENCE_NOT_FOUND', message: '证据索引里没有匹配项' } }];
        return { ok: true, evidence: entry, index: { generatedAt: NOW_ISO, complete: true, summary: { entries: 2 } } };
      }
      case 'GET /api/design/context':
        return { ok: true, context: { windowId: 'win-1', targetFingerprint: 'tf-design-1', project: { uuid: 'proj1' }, document: { uuid: 'doc-sch-1', documentType: 2 } } };
      case 'POST /api/design/plan': {
        state.planBodies.push(call.body);
        return {
          ok: true,
          planning: {
            ready: true,
            missing: [],
            planHash: DESIGN_HASH,
            plan: {
              apiVersion: 1,
              kind: 'simple-control-board',
              title: '测试原理图计划',
              blocks: { mcu: { uuid: 'u-mcu', value: 'CH32V003' } },
              nets: ['VCC', 'GND'],
              operations: [{ type: 'component.create' }, { type: 'wire.create' }],
              placements: [],
              assumptions: ['测试假设：使用当前原理图页'],
            },
          },
        };
      }
      case 'POST /api/design/plan/ai': {
        state.planBodies.push(call.body);
        return {
          ok: true,
          candidate: { kind: 'simple-control-board' },
          planning: {
            ready: false,
            missing: ['mcu:uuid', 'nets'],
            planHash: DESIGN_HASH,
            plan: { kind: 'simple-control-board', blocks: {}, nets: [], operations: [], assumptions: ['候选计划'] },
          },
        };
      }
      case 'POST /api/design/approve': {
        state.approveBodies.push(call.body);
        return {
          ok: true,
          approval: {
            approvalId: 'approval-design-1',
            scope: 'design',
            token: APPROVAL_TOKEN,
            bindings: { planHash: DESIGN_HASH, targetFingerprint: 'tf-design-1', windowId: 'win-1', steps: ['snapshot', 'write'] },
            planHash: DESIGN_HASH,
            issuedAt: NOW_ISO,
            expiresAt: Date.now() + 10 * 60 * 1000,
          },
        };
      }
      case 'POST /api/design/execute': {
        state.executeBodies.push(call.body);
        return { ok: true, execution: { id: 'design-exec-1', state: 'completed', planHash: DESIGN_HASH, projectId: 'proj1' } };
      }
      case 'GET /api/pcb/context':
        return { ok: true, context: { windowId: 'win-1', targetFingerprint: 'tf-pcb-1', project: { uuid: 'proj1' }, pcb: { document: { uuid: 'doc-pcb-1', documentType: 3 } }, complete: true } };
      case 'POST /api/pcb/plan': {
        state.planBodies.push(call.body);
        return {
          ok: true,
          planning: {
            ready: true,
            missing: [],
            planHash: PCB_HASH,
            plan: {
              apiVersion: 1,
              kind: 'pcb-production-plan',
              title: '测试 PCB 计划',
              board: { widthMm: 40, heightMm: 30, layers: 4, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 },
              operations: [{ type: 'line.create' }, { type: 'via.create' }],
              expectations: { designators: ['U1', 'R1'] },
            },
          },
        };
      }
      case 'POST /api/pcb/approve': {
        state.approveBodies.push(call.body);
        return {
          ok: true,
          approval: {
            approvalId: 'approval-pcb-1',
            scope: 'pcb',
            token: APPROVAL_TOKEN,
            bindings: { planHash: PCB_HASH, targetFingerprint: 'tf-pcb-1', windowId: 'win-1', steps: ['sync', 'outline'] },
            issuedAt: NOW_ISO,
            expiresAt: Date.now() + 10 * 60 * 1000,
          },
        };
      }
      case 'POST /api/pcb/execute': {
        state.executeBodies.push(call.body);
        return { ok: true, execution: { id: 'pcb-exec-1', state: 'completed', planHash: PCB_HASH } };
      }
      case 'POST /api/eda/schematic/erc/run':
        state.ercCalls += 1;
        state.ercBodies.push(call.body ?? {});
        return {
          ok: true,
          erc: { counts: { error: 0, warning: 1, fatal: 0 }, aggregateOnly: false, documentUuid: call.body?.schematicUuid ?? 'sch1' },
          summary: { error: 0, warning: 1 },
          ercDetail: { ok: true, source: 'panel' },
          saved: {
            path: call.body?.schematicUuid
              ? `artifacts/evidence/schematic-erc/${call.body.schematicUuid}.json`
              : 'artifacts/evidence/schematic-erc/erc-new.json',
            digest: 'erc-new-digest',
            savedAt: NOW_ISO,
          },
        };
      case 'POST /api/eda/pcb/drc/start':
        state.drcStarts.push(call.body ?? {});
        return { ok: true, jobId: `drc-job-${state.drcStarts.length}`, state: 'running', startedAt: NOW_ISO };
      case 'POST /api/eda/pcb/drc/report': {
        const drcJobId = typeof call.body?.jobId === 'string' && call.body.jobId ? call.body.jobId : 'drc-job-1';
        const poll = (state.drcPollsByJob[drcJobId] ?? 0) + 1;
        state.drcPollsByJob[drcJobId] = poll;
        state.drcPolls += 1;
        if (poll === 1) return { ok: true, state: 'running', jobId: drcJobId };
        return {
          ok: true,
          state: 'done',
          jobId: drcJobId,
          report: { counts: { error: 0, warning: 2 }, itemCount: 0, items: [], truncated: false },
          classification: { ready: true, summary: { total: 0, exempted: 0, unexplained: 0 }, findings: [] },
          saved: { path: `artifacts/evidence/drc-report/${drcJobId}.json`, digest: `drc-${drcJobId}-digest`, savedAt: NOW_ISO },
        };
      }
      case 'POST /api/eda/gates/evaluate':
        state.gatesCalls += 1;
        state.gatesBodies.push(call.body ?? {});
        return {
          ok: true,
          report: { verdict: 'pass', ready: true, gates: [{ id: 'G1', status: 'pass' }, { id: 'G2', status: 'pass' }] },
          knowledgeAdvice: { suggested: [], candidates: [] },
        };
      case 'POST /api/production/export': {
        state.exportCalls += 1;
        state.exportBodies.push(call.body);
        return {
          ok: true,
          exported: true,
          final: true,
          outDir: '/tmp/cp-export',
          files: [{ path: 'board.gbr' }, { path: 'bom.csv' }],
          manifestHash: 'manifest-1',
          decision: { allowed: true, reason: 'gate pass' },
        };
      }
      case 'GET /api/knowledge/entries': {
        state.knowledgeQueries.push(call.query);
        return {
          ok: true,
          knowledge: [
            { id: 'k1', kind: 'rule', title: 'DRC 间距规则', trust: 'high', review: { state: 'approved' }, digest: 'kd1', updatedAt: NOW_ISO },
            { id: 'k2', kind: 'rule', title: '未审核候选', trust: 'low', review: { state: 'candidate' }, digest: 'kd2', updatedAt: NOW_ISO },
          ],
        };
      }
      case 'POST /api/rag/query': {
        state.ragBodies.push(call.body);
        return { ok: true, rag: { query: call.body?.query ?? '', results: [{ id: 'k1', title: 'DRC 间距规则', kind: 'rule', score: 0.88 }], total: 1 } };
      }
      case 'GET /api/projects':
        state.projectListCalls += 1;
        return { ok: true, projects: projects.map((project) => ({ ...project })), scopedFiles: projects.length };
      default:
        if (method === 'GET' && /^\/api\/projects\/([^/]+)\/state$/.test(path)) {
          const projectId = decodeURIComponent(path.split('/')[3]);
          state.projectStateCalls.push(projectId);
          const fixture = projectStates[projectId];
          if (!fixture) {
            return [404, { ok: false, error: { code: 'PROJECT_STATE_NOT_FOUND', message: `项目不存在或没有可读状态：${projectId}` } }];
          }
          return { ok: true, projectId, state: fixture.state, savedAt: fixture.savedAt ?? NOW_ISO, source: 'project-scoped' };
        }
        if (method === 'GET' && /^\/api\/design\/executions\/[^/]+\/evidence$/.test(path)) {
          return { ok: true, evidence: { id: 'design-exec-1', planHash: DESIGN_HASH, steps: [] }, digest: 'exec-evidence-digest' };
        }
        return [404, { ok: false, error: { code: 'ROUTE_NOT_FOUND', message: `fake runtime 没有实现 ${key}` } }];
    }
  };

  return { state, handler };
}

/** 构造工具 harness（默认路由 + 可覆盖 handler）。 */
export async function makeHarness({ approvalMode = 'chat', handler, token = TEST_TOKEN, config = {}, clientOptions = {} } = {}) {
  const runtime = await startFakeRuntime({ token, handler });
  const client = new RuntimeClient({
    baseUrl: runtime.url,
    token,
    timeoutMs: config.requestTimeoutMs ?? 2000,
    ...clientOptions,
  });
  const jobs = new JobManager({ defaultTimeoutMs: config.jobTimeoutMs ?? 5000 });
  const normalized = normalizeToolConfig({
    runtimeUrl: runtime.url,
    approvalMode,
    requestTimeoutMs: 2000,
    jobTimeoutMs: 5000,
    drcPollIntervalMs: 5,
    drcPollTimeoutMs: 3000,
    approvalTtlMs: 60_000,
    planTtlMs: 60_000,
    ...config,
  });
  const tools = createCircuitPilotTools({ config: normalized, client, jobs });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return {
    runtime,
    client,
    jobs,
    tools,
    byName,
    config: normalized,
    callTool: (name, args = {}, exec = {}) => byName[name].execute(args, exec),
    close: async () => {
      jobs.cancelAll();
      await runtime.close();
    },
  };
}

/** 等待 job 到终态（测试辅助）。 */
export async function waitJob(harness, jobId, timeoutMs = 3000) {
  return harness.callTool('cp_job', { action: 'wait', jobId, timeoutMs });
}
