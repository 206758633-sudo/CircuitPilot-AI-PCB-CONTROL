/**
 * 复合设计框架端到端：IR → Rule-as-Code → 求解器 → 闭环 → 金板评估。
 * 依赖全部模块就绪（rule-deck / solvers / loop / eval）。
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DESIGN_FRAMEWORK_LAYERS,
  boardModelDigest,
  createBoardModel,
  formatEvaluationReport,
  frameworkStatus,
  loadGoldenCases,
  runDesignLoop,
  runGoldenEvaluation,
  toPcbOperations,
} from '../design-framework/index.mjs';

const GOLDEN_DIR = fileURLToPath(new URL('../../eval/golden/', import.meta.url));
const cases = loadGoldenCases(GOLDEN_DIR);
const caseById = (id) => cases.find((caseDef) => caseDef.id === id);

test('框架分层元数据：6 层且模块路径存在声明', () => {
  assert.deepEqual(DESIGN_FRAMEWORK_LAYERS.map((layer) => layer.id), [
    'design-as-code', 'rule-as-code', 'external-drc', 'solvers', 'plan-verify-repair', 'golden-eval',
  ]);
  for (const layer of DESIGN_FRAMEWORK_LAYERS) {
    assert.ok(Array.isArray(layer.modules) && layer.modules.length > 0);
    assert.ok(typeof layer.description === 'string' && layer.description.length > 10);
  }
});

test('frameworkStatus：本机无 kicad-cli / 外部求解器时如实报告不可用', () => {
  const status = frameworkStatus();
  assert.equal(status.schemaVersion, 1);
  assert.equal(typeof status.kicad.available, 'boolean');
  assert.equal(status.externalSolvers.ortools.available, false);
});

test('端到端 fixable-overlap：闭环重排布局后无阻断，digest 稳定，编译出 EDA 操作', () => {
  const caseDef = caseById('fixable-overlap');
  const result = runDesignLoop(caseDef.model, { maxIterations: 3 });
  assert.ok(['passed', 'needs-review'].includes(result.status), `status=${result.status}`);
  assert.equal(result.summary.blocking, 0);
  assert.ok(result.repairs.some((repair) => repair.strategy === 'solve_placement'));
  assert.ok(result.plan.operations.length >= 1);
  assert.equal(result.plan.operations[0].type, 'pcb.outline.create');
  assert.equal(result.digest.length, 64);

  // 同输入两次结果一致（确定性）
  const again = runDesignLoop(caseDef.model, { maxIterations: 3 });
  assert.equal(again.digest, result.digest);
  assert.equal(boardModelDigest(again.model), boardModelDigest(result.model));
});

test('端到端 already-good：不产生修复，blocking=0', () => {
  const caseDef = caseById('already-good');
  const result = runDesignLoop(caseDef.model, { maxIterations: 2 });
  assert.ok(['passed', 'needs-review'].includes(result.status));
  assert.equal(result.summary.blocking, 0);
  assert.equal(result.repairs.length, 0);
});

test('端到端 stackup-needed：自动求解叠层并写回 IR', () => {
  const caseDef = caseById('stackup-needed');
  const result = runDesignLoop(caseDef.model, { maxIterations: 3 });
  assert.ok(['passed', 'needs-review'].includes(result.status));
  assert.equal(result.summary.blocking, 0);
  assert.ok(result.repairs.some((repair) => repair.strategy === 'solve_stackup'));
  assert.ok(result.model.stackup && result.model.stackup.layers.length === result.model.board.layers);
});

test('端到端 blocked-size-unknown / blocked-netlist-short：fail-closed 且不返回假通过', () => {
  const unknown = runDesignLoop(caseById('blocked-size-unknown').model, { maxIterations: 2 });
  assert.equal(unknown.status, 'blocked');
  assert.ok(unknown.summary.blocking >= 1);
  assert.equal(unknown.ok, false);

  const shorted = runDesignLoop(caseById('blocked-netlist-short').model, { maxIterations: 2 });
  assert.equal(shorted.status, 'blocked');
  assert.ok(shorted.summary.blocking >= 1);
});

test('金板评估台：全部用例通过，指标完整', () => {
  const report = runGoldenEvaluation({ dir: GOLDEN_DIR, runLoop: runDesignLoop });
  assert.equal(report.ok, true, `失败用例：${JSON.stringify(report.metrics.failures, null, 2)}`);
  assert.equal(report.metrics.failed, 0);
  assert.ok(report.metrics.total >= 4);
  assert.equal(report.metrics.passRate, 1);
  assert.ok(Number.isFinite(report.metrics.avgIterations));
  assert.ok(report.metrics.ruleCoverageAvg === null || Number.isFinite(report.metrics.ruleCoverageAvg));
  assert.ok(formatEvaluationReport(report).includes('金板评估'));
});

test('toPcbOperations：无 placementId 的器件如实 skipped，不按 ref 猜', () => {
  const model = createBoardModel({
    board: { widthMm: 60, heightMm: 40 },
    components: [{ ref: 'U1', xMm: 20, yMm: 20, widthMm: 5, heightMm: 5 }],
  });
  const { operations, skipped } = toPcbOperations(model);
  assert.equal(operations.filter((operation) => operation.type === 'pcb.component.modify').length, 0);
  assert.deepEqual(skipped.map((item) => item.ref), ['U1']);
});
