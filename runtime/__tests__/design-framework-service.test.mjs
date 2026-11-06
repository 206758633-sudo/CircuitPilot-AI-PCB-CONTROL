import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DESIGN_FRAMEWORK_MAX_ITERATIONS,
  DESIGN_FRAMEWORK_MODEL_MAX_BYTES,
  DESIGN_FRAMEWORK_SERVICE_CODES,
  buildModelFromProject,
  frameworkStatusView,
  goldenReport,
  runFrameworkForProject,
  runFrameworkLoop,
  summarizeLoopResult,
} from '../design-framework-service.mjs';
import { loadGoldenCases } from '../design-framework/eval.mjs';

const ROOT = new URL('../..', import.meta.url);
const GOLDEN_DIR = fileURLToPath(new URL('eval/golden/', ROOT));
const SERVER_SOURCE = readFileSync(fileURLToPath(new URL('runtime/server.mjs', ROOT)), 'utf8');

const cases = loadGoldenCases(GOLDEN_DIR);
const caseById = (id) => cases.find((caseDef) => caseDef.id === id);

/**
 * 该文件同时是「路由消费者」证据（route-contract.test.mjs 规则 2）：
 * 这里显式断言 Runtime 已注册复合设计框架的 3 条路由。
 */
test('Runtime 路由已注册：GET /api/design/framework/status|golden、POST /api/design/framework/run', () => {
  for (const route of ['/api/design/framework/status', '/api/design/framework/golden', '/api/design/framework/run']) {
    assert.ok(SERVER_SOURCE.includes(route), `server.mjs 缺少路由 ${route}`);
  }
  assert.match(SERVER_SOURCE, /design-framework-service\.mjs/);
});

test('runFrameworkLoop：可修金板闭环返回 needs-review + 修复记录，digest 稳定', () => {
  const caseDef = caseById('fixable-overlap');
  const summary = runFrameworkLoop({ model: caseDef.model, options: { maxIterations: 3 } });
  assert.equal(summary.status, 'needs-review');
  assert.equal(summary.ok, true);
  assert.ok(summary.repairCount >= 1);
  assert.ok(summary.repairs.some((repair) => repair.strategy === 'solve_placement'));
  assert.equal(summary.summary.blocking, 0);
  assert.ok(summary.plan.operations >= 1);
  assert.equal(summary.digest.length, 64);

  const again = runFrameworkLoop({ model: caseDef.model, options: { maxIterations: 3 } });
  assert.equal(again.digest, summary.digest);
});

test('runFrameworkLoop：不可修金板返回 blocked（ok:false，但服务调用本身成功）', () => {
  const summary = runFrameworkLoop({ model: caseById('blocked-netlist-short').model });
  assert.equal(summary.status, 'blocked');
  assert.equal(summary.ok, false);
  assert.ok(summary.summary.blocking >= 1);
  assert.equal(summary.repairCount, 0);
});

test('runFrameworkLoop：非法/超大模型 fail-closed（400/413 + 明确 code）', () => {
  assert.throws(() => runFrameworkLoop({ model: null }), (error) => error.code === DESIGN_FRAMEWORK_SERVICE_CODES.INVALID_MODEL && error.status === 400);
  assert.throws(() => runFrameworkLoop({ model: [] }), (error) => error.code === DESIGN_FRAMEWORK_SERVICE_CODES.INVALID_MODEL && error.status === 400);
  const big = { board: { widthMm: 60, heightMm: 40 }, components: [], nets: [], meta: { note: 'x'.repeat(DESIGN_FRAMEWORK_MODEL_MAX_BYTES) } };
  assert.throws(() => runFrameworkLoop({ model: big }), (error) => error.code === DESIGN_FRAMEWORK_SERVICE_CODES.MODEL_TOO_LARGE && error.status === 413);
});

test('runFrameworkLoop：模型结构错误映射 400（不是 500），maxIterations 被夹到 1–8', () => {
  assert.throws(() => runFrameworkLoop({ model: { board: {} } }), (error) => error.code === DESIGN_FRAMEWORK_SERVICE_CODES.RUN_FAILED && error.status === 400);
  const summary = runFrameworkLoop({ model: caseById('already-good').model, options: { maxIterations: 99 } });
  assert.ok(summary.summary.iterations <= DESIGN_FRAMEWORK_MAX_ITERATIONS);
  const zero = runFrameworkLoop({ model: caseById('already-good').model, options: { maxIterations: 0 } });
  assert.ok(zero.summary.iterations >= 1);
});

test('frameworkStatusView：分层元数据 + 外部工具探测字段齐全（缺失如实 unavailable）', () => {
  const status = frameworkStatusView();
  assert.equal(status.schemaVersion, 1);
  assert.deepEqual(status.layers, ['design-as-code', 'rule-as-code', 'external-drc', 'solvers', 'plan-verify-repair', 'golden-eval']);
  assert.equal(typeof status.kicad.available, 'boolean');
  assert.equal(status.externalSolvers.ortools.available, false);
  assert.equal(status.externalSolvers.z3.available, false);
  assert.equal(status.externalSolvers.shapely.available, false);
});

test('goldenReport：5 个金板用例全过，指标完整且与 CLI 一致', () => {
  const report = goldenReport();
  assert.equal(report.ok, true);
  assert.ok(report.metrics.total >= 5);
  assert.equal(report.metrics.failed, 0);
  assert.equal(report.metrics.passRate, 1);
  assert.ok(report.results.some((result) => result.id === 'fixable-overlap'));
  assert.ok(Number.isFinite(report.metrics.ruleCoverageAvg));
});

test('buildModelFromProject：项目 + EDA 读回构建 IR（板框/层数/器件几何；未读到的尺寸显式 sizeUnknown）', () => {
  const projectState = { activeProjectId: 'p1', projects: [{ id: 'p1', name: 'Demo 板' }] };
  const edaSnapshot = {
    widthMm: 60, heightMm: 40, layers: 2,
    placementRead: {
      unit: 'mm',
      components: [
        { designator: 'U1', xMm: 20, yMm: 20, rotationDeg: 0, layer: 1, bboxMm: { xMm: 6, yMm: 6, centerXMm: 20, centerYMm: 20 } },
        { designator: 'C1', xMm: 30, yMm: 20, rotationDeg: 0, layer: 1, bboxMm: { xMm: 2, yMm: 1, centerXMm: 30, centerYMm: 20 } },
        { designator: 'R1', xMm: 40, yMm: 20, rotationDeg: 0, layer: 1 },
      ],
    },
  };
  const model = buildModelFromProject({ projectState, edaSnapshot });
  assert.equal(model.board.widthMm, 60);
  assert.equal(model.board.layers, 2);
  assert.deepEqual(model.components.map((component) => component.ref).sort(), ['C1', 'R1', 'U1']);
  const byRef = new Map(model.components.map((component) => [component.ref, component]));
  assert.equal(byRef.get('U1').widthMm, 6);
  assert.equal(byRef.get('U1').sizeUnknown, false);
  assert.equal(byRef.get('R1').sizeUnknown, true);
  assert.equal(model.meta.source, 'project+eda-readback');
});

test('buildModelFromProject：EDS 离线 / 无活动项目 → 409 fail-closed（不编造尺寸）', () => {
  const projectState = { activeProjectId: 'p1', projects: [{ id: 'p1', name: 'Demo' }] };
  assert.throws(() => buildModelFromProject({ projectState, edaSnapshot: null }), (error) => error.code === DESIGN_FRAMEWORK_SERVICE_CODES.EDA_OFFLINE && error.status === 409);
  assert.throws(() => buildModelFromProject({ projectState, edaSnapshot: { widthMm: 0, heightMm: 40, layers: 2 } }), (error) => error.code === DESIGN_FRAMEWORK_SERVICE_CODES.EDA_OFFLINE && error.status === 409);
  assert.throws(() => buildModelFromProject({ projectState: { projects: [] }, edaSnapshot: { widthMm: 60, heightMm: 40, layers: 2 } }), (error) => error.code === DESIGN_FRAMEWORK_SERVICE_CODES.NO_ACTIVE_PROJECT && error.status === 409);
  assert.throws(() => buildModelFromProject({ projectState: null }), (error) => error.code === DESIGN_FRAMEWORK_SERVICE_CODES.NO_ACTIVE_PROJECT);
});

test('runFrameworkForProject：构建 IR 后跑闭环，返回 source=project 与模型摘要；尺寸未知器件 → blocked 不硬排', () => {
  const projectState = { activeProjectId: 'p1', projects: [{ id: 'p1', name: 'Demo' }] };
  const edaSnapshot = {
    widthMm: 60, heightMm: 40, layers: 2,
    placementRead: { unit: 'mm', components: [{ designator: 'U1', xMm: 20, yMm: 20, rotationDeg: 0, bboxMm: { xMm: 6, yMm: 6, centerXMm: 20, centerYMm: 20 } }] },
  };
  const summary = runFrameworkForProject({ projectState, edaSnapshot, options: { maxIterations: 2 } });
  assert.equal(summary.source, 'project');
  assert.equal(summary.status, 'needs-review');
  assert.ok(summary.modelSummary.componentCount >= 1);

  const noSize = runFrameworkForProject({
    projectState,
    edaSnapshot: { widthMm: 60, heightMm: 40, layers: 2, placementRead: { unit: 'mm', components: [{ designator: 'U1', xMm: 20, yMm: 20 }] } },
    options: { maxIterations: 2 },
  });
  assert.equal(noSize.status, 'blocked');
  assert.equal(noSize.ok, false);
});

test('summarizeLoopResult：稳定摘要（不含整份 IR/findings，plan 只给数量）', () => {
  const raw = {
    ok: true,
    status: 'needs-review',
    iterations: [{ iteration: 1, modelDigest: 'a'.repeat(64), blocking: [{ source: 'rule', code: 'ZCLR-01', group: 'ZCLR' }], reviewCount: 3 }],
    repairs: [{ iteration: 1, strategy: 'solve_placement', riskLevel: 'medium', fromDigest: 'a'.repeat(64), toDigest: 'b'.repeat(64) }],
    summary: { initialDigest: 'a'.repeat(64), finalDigest: 'b'.repeat(64), iterations: 1, repairs: 1, blocking: 0, review: 3, ruleCoverage: 0.21, releaseReady: false, model: { componentCount: 2 } },
    rules: { total: 151 },
    netlist: { nets: 1 },
    plan: { operations: [{ type: 'pcb.outline.create' }], skipped: [{ ref: 'U1', reason: 'placementId-missing' }] },
    evidence: { kind: 'design-loop-evidence' },
    digest: 'c'.repeat(64),
  };
  const summary = summarizeLoopResult(raw);
  assert.equal(summary.status, 'needs-review');
  assert.equal(summary.plan.operations, 1);
  assert.equal(summary.plan.skipped.length, 1);
  assert.equal(summary.iterations[0].blocking[0].code, 'ZCLR-01');
  assert.equal(JSON.stringify(summary).includes('pcb.outline.create'), false, '摘要不应内联整份操作');
});
