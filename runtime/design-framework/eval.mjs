/**
 * 金板评估台：用固定用例集回归"设计框架"（IR → Rule-as-Code → 求解器 → 闭环编排）。
 *
 * 定位：自主性不能靠感觉衡量。评估台把每块金板的**输入 IR + 期望结果**固化，
 * 跑完输出通过率/迭代次数/修复次数/规则覆盖率，作为改动的回归门禁。
 *
 * 约束：确定性（同输入同输出）、离线（不连 EDA/KiCad）、零依赖。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const GOLDEN_EVAL_SCHEMA_VERSION = 1;

export const GOLDEN_EVAL_CODES = Object.freeze({
  CASE_INVALID: 'GOLDEN_EVAL_CASE_INVALID',
  DIRECTORY_INVALID: 'GOLDEN_EVAL_DIRECTORY_INVALID',
  RUN_LOOP_MISSING: 'GOLDEN_EVAL_RUN_LOOP_MISSING',
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 校验一条金板用例的结构（fail-closed）。 */
export function validateGoldenCase(raw, file = null) {
  const where = file ? `（${file}）` : '';
  if (!isPlainObject(raw)) throw Object.assign(new Error(`金板用例必须是对象${where}`), { code: GOLDEN_EVAL_CODES.CASE_INVALID });
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) throw Object.assign(new Error(`金板用例缺少 id${where}`), { code: GOLDEN_EVAL_CODES.CASE_INVALID, details: { file } });
  if (!isPlainObject(raw.model)) throw Object.assign(new Error(`金板用例 ${id} 缺少 model${where}`), { code: GOLDEN_EVAL_CODES.CASE_INVALID, details: { id } });
  const expect = raw.expect === undefined ? {} : raw.expect;
  if (!isPlainObject(expect)) throw Object.assign(new Error(`金板用例 ${id} 的 expect 必须是对象`), { code: GOLDEN_EVAL_CODES.CASE_INVALID, details: { id } });
  if (expect.statusIn !== undefined && (!Array.isArray(expect.statusIn) || expect.statusIn.length === 0)) {
    throw Object.assign(new Error(`金板用例 ${id} 的 expect.statusIn 必须是非空数组`), { code: GOLDEN_EVAL_CODES.CASE_INVALID, details: { id } });
  }
  return {
    id,
    description: typeof raw.description === 'string' ? raw.description : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string') : [],
    model: raw.model,
    options: isPlainObject(raw.options) ? raw.options : {},
    expect,
  };
}

/** 读取目录下全部 *.json 金板用例（按文件名排序，保证确定性）。 */
export function loadGoldenCases(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    throw Object.assign(new Error(`读取金板目录失败：${dir}（${error?.message ?? error}）`), { code: GOLDEN_EVAL_CODES.DIRECTORY_INVALID, details: { dir } });
  }
  if (names.length === 0) throw Object.assign(new Error(`金板目录没有 *.json 用例：${dir}`), { code: GOLDEN_EVAL_CODES.DIRECTORY_INVALID, details: { dir } });
  return names.map((name) => {
    const file = join(dir, name);
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw Object.assign(new Error(`金板用例不是合法 JSON：${file}（${error?.message ?? error}）`), { code: GOLDEN_EVAL_CODES.CASE_INVALID, details: { file } });
    }
    return validateGoldenCase(raw, file);
  });
}

/** 校验一次闭环结果是否满足用例期望。 */
export function checkExpectations(result, expect = {}) {
  const violations = [];
  const status = result?.status;
  const iterations = result?.summary?.iterations ?? 0;
  const blockingAfter = result?.summary?.blocking ?? null;
  const repairs = Array.isArray(result?.repairs) ? result.repairs : [];
  const strategies = [...new Set(repairs.map((repair) => repair.strategy))];
  if (Array.isArray(expect.statusIn) && !expect.statusIn.includes(status)) {
    violations.push({ code: 'STATUS_MISMATCH', expected: expect.statusIn, actual: status });
  }
  if (Number.isInteger(expect.maxIterations) && iterations > expect.maxIterations) {
    violations.push({ code: 'ITERATIONS_EXCEEDED', expected: `<=${expect.maxIterations}`, actual: iterations });
  }
  if (Number.isInteger(expect.minIterations) && iterations < expect.minIterations) {
    violations.push({ code: 'ITERATIONS_TOO_FEW', expected: `>=${expect.minIterations}`, actual: iterations });
  }
  if (Number.isInteger(expect.blockingAfter) && blockingAfter !== expect.blockingAfter) {
    violations.push({ code: 'BLOCKING_MISMATCH', expected: expect.blockingAfter, actual: blockingAfter });
  }
  if (Number.isInteger(expect.blockingAfterAtLeast) && !(blockingAfter >= expect.blockingAfterAtLeast)) {
    violations.push({ code: 'BLOCKING_TOO_FEW', expected: `>=${expect.blockingAfterAtLeast}`, actual: blockingAfter });
  }
  if (Array.isArray(expect.repairedIncludes)) {
    for (const strategy of expect.repairedIncludes) {
      if (!strategies.includes(strategy)) violations.push({ code: 'REPAIR_MISSING', expected: strategy, actual: strategies });
    }
  }
  if (Number.isInteger(expect.repairCountAtLeast) && repairs.length < expect.repairCountAtLeast) {
    violations.push({ code: 'REPAIR_COUNT_TOO_FEW', expected: `>=${expect.repairCountAtLeast}`, actual: repairs.length });
  }
  if (Number.isInteger(expect.maxRepairs) && repairs.length > expect.maxRepairs) {
    violations.push({ code: 'REPAIR_COUNT_EXCEEDED', expected: `<=${expect.maxRepairs}`, actual: repairs.length });
  }
  if (Number.isInteger(expect.planOperationsAtLeast)) {
    const operations = result?.plan?.operations?.length ?? 0;
    if (operations < expect.planOperationsAtLeast) violations.push({ code: 'PLAN_OPERATIONS_TOO_FEW', expected: `>=${expect.planOperationsAtLeast}`, actual: operations });
  }
  return violations;
}

/** 执行一条金板用例。 */
export function evaluateCase(caseDef, { runLoop = null } = {}) {
  if (typeof runLoop !== 'function') throw Object.assign(new Error('evaluateCase 需要注入 runLoop（闭环实现由调用方提供，评估台不反向依赖 loop）'), { code: GOLDEN_EVAL_CODES.RUN_LOOP_MISSING });
  let result = null;
  let error = null;
  try {
    result = runLoop(caseDef.model, { maxIterations: 4, ...caseDef.options });
  } catch (caught) {
    error = { code: caught?.code ?? 'GOLDEN_CASE_RUN_FAILED', message: String(caught?.message ?? caught) };
  }
  const violations = error ? [{ code: 'RUN_FAILED', message: error.message }] : checkExpectations(result, caseDef.expect);
  return {
    id: caseDef.id,
    description: caseDef.description,
    tags: caseDef.tags,
    ok: violations.length === 0,
    error,
    status: result?.status ?? null,
    iterations: result?.summary?.iterations ?? null,
    repairs: Array.isArray(result?.repairs) ? result.repairs.map((repair) => repair.strategy) : [],
    repairCount: Array.isArray(result?.repairs) ? result.repairs.length : 0,
    blockingAfter: result?.summary?.blocking ?? null,
    reviewAfter: result?.summary?.review ?? null,
    ruleCoverage: result?.summary?.ruleCoverage ?? null,
    planOperations: result?.plan?.operations?.length ?? null,
    digest: result?.digest ?? null,
    violations,
  };
}

/** 跑完一个目录的金板用例并汇总指标。 */
export function runGoldenEvaluation({ dir, runLoop = null } = {}) {
  if (typeof runLoop !== 'function') throw Object.assign(new Error('runGoldenEvaluation 需要注入 runLoop（例如 loop.mjs 的 runDesignLoop）'), { code: GOLDEN_EVAL_CODES.RUN_LOOP_MISSING });
  if (typeof dir !== 'string' || !dir.trim()) throw Object.assign(new Error('runGoldenEvaluation 需要 dir'), { code: GOLDEN_EVAL_CODES.DIRECTORY_INVALID });
  const cases = loadGoldenCases(dir);
  const results = cases.map((caseDef) => evaluateCase(caseDef, { runLoop }));
  const statusCounts = {};
  for (const result of results) {
    const key = result.status ?? 'error';
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  const passed = results.filter((result) => result.ok).length;
  const coverageValues = results.map((result) => result.ruleCoverage).filter((value) => Number.isFinite(value));
  const metrics = {
    schemaVersion: GOLDEN_EVAL_SCHEMA_VERSION,
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length ? Number((passed / results.length).toFixed(4)) : 0,
    statusCounts,
    avgIterations: results.length ? Number((results.reduce((sum, result) => sum + (result.iterations ?? 0), 0) / results.length).toFixed(2)) : 0,
    totalRepairs: results.reduce((sum, result) => sum + result.repairCount, 0),
    ruleCoverageAvg: coverageValues.length ? Number((coverageValues.reduce((sum, value) => sum + value, 0) / coverageValues.length).toFixed(4)) : null,
    failures: results.filter((result) => !result.ok).map((result) => ({ id: result.id, violations: result.violations })),
  };
  return { ok: metrics.failed === 0, cases, results, metrics };
}

/** 人类可读报告（CLI 用）。 */
export function formatEvaluationReport(report) {
  const lines = [];
  lines.push(`金板评估：${report.metrics.passed}/${report.metrics.total} 通过（passRate=${(report.metrics.passRate * 100).toFixed(1)}%）`);
  lines.push(`状态分布：${Object.entries(report.metrics.statusCounts).map(([key, value]) => `${key}=${value}`).join(' · ')}`);
  lines.push(`平均迭代：${report.metrics.avgIterations} · 修复总数：${report.metrics.totalRepairs} · 规则覆盖率均值：${report.metrics.ruleCoverageAvg === null ? 'n/a' : `${(report.metrics.ruleCoverageAvg * 100).toFixed(1)}%`}`);
  for (const result of report.results) {
    lines.push(`  ${result.ok ? '✔' : '✖'} ${result.id} · status=${result.status} · iter=${result.iterations} · repairs=${result.repairCount} · blocking=${result.blockingAfter} · review=${result.reviewAfter}`);
    for (const violation of result.violations) lines.push(`      - ${violation.code}${violation.expected === undefined ? '' : ` expected=${JSON.stringify(violation.expected)}`}${violation.actual === undefined ? '' : ` actual=${JSON.stringify(violation.actual)}`}`);
  }
  return lines.join('\n');
}
