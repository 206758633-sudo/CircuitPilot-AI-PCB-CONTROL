import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  GOLDEN_EVAL_CODES,
  checkExpectations,
  evaluateCase,
  formatEvaluationReport,
  loadGoldenCases,
  runGoldenEvaluation,
  validateGoldenCase,
} from '../design-framework/eval.mjs';

const ROOT = new URL('../..', import.meta.url);
const GOLDEN_DIR = fileURLToPath(new URL('eval/golden/', ROOT));

/** 伪造闭环结果（评估台不依赖求解器实现，便于先测度量语义）。 */
const fakeResult = ({ status = 'needs-review', iterations = 2, blocking = 0, review = 3, repairs = [], operations = 2 } = {}) => ({
  ok: status !== 'blocked',
  status,
  iterations: [],
  repairs,
  summary: { iterations, blocking, review, ruleCoverage: 0.2, finalDigest: 'f'.repeat(64) },
  plan: { operations: Array.from({ length: operations }, () => ({ type: 'pcb.outline.create' })), skipped: [] },
  digest: 'd'.repeat(64),
});

test('loadGoldenCases：读取 eval/golden 全部用例并校验结构', () => {
  const cases = loadGoldenCases(GOLDEN_DIR);
  assert.ok(cases.length >= 4, `金板用例过少：${cases.length}`);
  assert.deepEqual(cases.map((item) => item.id).includes('fixable-overlap'), true);
  for (const caseDef of cases) {
    assert.equal(typeof caseDef.id, 'string');
    assert.ok(caseDef.model && typeof caseDef.model === 'object');
    assert.ok(Array.isArray(caseDef.expect.statusIn));
  }
});

test('validateGoldenCase：缺 id / model / statusIn 非法都 fail-closed', () => {
  assert.throws(() => validateGoldenCase({ model: {} }), (error) => error.code === GOLDEN_EVAL_CODES.CASE_INVALID);
  assert.throws(() => validateGoldenCase({ id: 'x' }), (error) => error.code === GOLDEN_EVAL_CODES.CASE_INVALID);
  assert.throws(() => validateGoldenCase({ id: 'x', model: {}, expect: { statusIn: [] } }), (error) => error.code === GOLDEN_EVAL_CODES.CASE_INVALID);
});

test('loadGoldenCases：目录不存在 / 空目录 / 非法 JSON 都给出明确错误码', () => {
  assert.throws(() => loadGoldenCases(join(tmpdir(), 'no-such-golden-dir')), (error) => error.code === GOLDEN_EVAL_CODES.DIRECTORY_INVALID);
  const empty = mkdtempSync(join(tmpdir(), 'golden-empty-'));
  assert.throws(() => loadGoldenCases(empty), (error) => error.code === GOLDEN_EVAL_CODES.DIRECTORY_INVALID);
  const broken = mkdtempSync(join(tmpdir(), 'golden-broken-'));
  writeFileSync(join(broken, 'bad.json'), '{not json');
  assert.throws(() => loadGoldenCases(broken), (error) => error.code === GOLDEN_EVAL_CODES.CASE_INVALID);
});

test('checkExpectations：状态/迭代/阻断/修复/计划操作逐项校验', () => {
  const result = fakeResult({ status: 'needs-review', iterations: 2, blocking: 0, repairs: [{ strategy: 'solve_placement' }], operations: 3 });
  assert.deepEqual(checkExpectations(result, { statusIn: ['passed', 'needs-review'], blockingAfter: 0, repairedIncludes: ['solve_placement'], planOperationsAtLeast: 1 }), []);
  const violations = checkExpectations(result, { statusIn: ['passed'], maxIterations: 1, blockingAfter: 2, repairedIncludes: ['solve_stackup'], planOperationsAtLeast: 5 });
  const codes = violations.map((item) => item.code);
  assert.ok(codes.includes('STATUS_MISMATCH'));
  assert.ok(codes.includes('ITERATIONS_EXCEEDED'));
  assert.ok(codes.includes('BLOCKING_MISMATCH'));
  assert.ok(codes.includes('REPAIR_MISSING'));
  assert.ok(codes.includes('PLAN_OPERATIONS_TOO_FEW'));
});

test('evaluateCase：runLoop 可注入（评估台与求解器解耦），异常记 RUN_FAILED', () => {
  const caseDef = { id: 'x', description: '', tags: [], model: {}, options: {}, expect: { statusIn: ['passed'], blockingAfter: 0 } };
  const ok = evaluateCase(caseDef, { runLoop: () => fakeResult({ status: 'passed', blocking: 0 }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'passed');

  const failed = evaluateCase(caseDef, { runLoop: () => { throw new Error('boom'); } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'GOLDEN_CASE_RUN_FAILED');
  assert.deepEqual(failed.violations.map((item) => item.code), ['RUN_FAILED']);
});

test('runGoldenEvaluation：汇总通过率/状态分布/迭代/修复/覆盖率，失败用例带 violations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'golden-eval-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ id: 'a', model: {}, expect: { statusIn: ['passed'] } }));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ id: 'b', model: {}, expect: { statusIn: ['blocked'] } }));
  const fakeRunLoop = (model, options) => (model === null ? null : fakeResult({ status: options?.marker === 'blocked' ? 'blocked' : 'passed' }));
  // 用 id 区分：a 通过、b 期望 blocked 但返回 passed → 失败
  const report = runGoldenEvaluation({ dir, runLoop: (model) => fakeRunLoop(model) });
  assert.equal(report.metrics.total, 2);
  assert.equal(report.metrics.passed, 1);
  assert.equal(report.metrics.failed, 1);
  assert.equal(report.metrics.passRate, 0.5);
  assert.equal(report.metrics.failures[0].id, 'b');
  assert.ok(Array.isArray(report.metrics.failures[0].violations));
  assert.ok(formatEvaluationReport(report).includes('金板评估'));
});
