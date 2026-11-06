/**
 * 复合设计框架的 Runtime 服务层（给 HTTP 路由 / Agent / 未来 UI 用的纯函数包装）。
 *
 * 边界：
 *   - 只读离线：不写 EDA、不签核、不触发任何写操作；输出只是"执行候选计划 + 证据"；
 *   - fail-closed：模型非法 / 过大 / 闭环内部错误一律抛结构化错误，绝不返回"看起来通过"；
 *   - 稳定裁剪：HTTP 层返回摘要（不是整个 IR/全部 findings），避免把响应撑爆。
 */
import { fileURLToPath } from 'node:url';
import {
  frameworkStatus,
  runDesignLoop,
  runGoldenEvaluation,
} from './design-framework/index.mjs';

export const DESIGN_FRAMEWORK_SERVICE_CODES = Object.freeze({
  INVALID_MODEL: 'DESIGN_FRAMEWORK_INVALID_MODEL',
  MODEL_TOO_LARGE: 'DESIGN_FRAMEWORK_MODEL_TOO_LARGE',
  RUN_FAILED: 'DESIGN_FRAMEWORK_RUN_FAILED',
  GOLDEN_FAILED: 'DESIGN_FRAMEWORK_GOLDEN_FAILED',
});

/** 与插件侧 `cp_design_loop` 约定一致：模型 JSON 上限 200KB、迭代上限 8。 */
export const DESIGN_FRAMEWORK_MODEL_MAX_BYTES = 200_000;
export const DESIGN_FRAMEWORK_MAX_ITERATIONS = 8;
export const DEFAULT_GOLDEN_DIR = fileURLToPath(new URL('../eval/golden/', import.meta.url));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const coded = (code, message, status, details = null) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });

function clampIterations(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.INVALID_MODEL, 'options.maxIterations 必须是数字', 400, { value });
  return Math.min(DESIGN_FRAMEWORK_MAX_ITERATIONS, Math.max(1, Math.floor(parsed)));
}

function summarizeIterations(iterations) {
  return (Array.isArray(iterations) ? iterations : []).map((entry) => ({
    iteration: entry.iteration,
    modelDigest: entry.modelDigest,
    blocking: Array.isArray(entry.blocking) ? entry.blocking.map((item) => ({ source: item.source, code: item.code, ref: item.ref ?? null, group: item.group ?? null })) : [],
    reviewCount: entry.reviewCount,
  }));
}

/** 把闭环结果裁剪成 HTTP/Agent 用的稳定摘要。 */
export function summarizeLoopResult(result) {
  const summary = result?.summary ?? {};
  return {
    ok: result?.ok === true,
    status: result?.status ?? 'blocked',
    iterations: summarizeIterations(result?.iterations),
    repairCount: Array.isArray(result?.repairs) ? result.repairs.length : 0,
    repairs: (Array.isArray(result?.repairs) ? result.repairs : []).map((repair) => ({ iteration: repair.iteration, strategy: repair.strategy, riskLevel: repair.riskLevel, fromDigest: repair.fromDigest, toDigest: repair.toDigest, detail: repair.detail ?? null })),
    summary: {
      initialDigest: summary.initialDigest ?? null,
      finalDigest: summary.finalDigest ?? null,
      iterations: summary.iterations ?? 0,
      repairs: summary.repairs ?? 0,
      blocking: summary.blocking ?? null,
      review: summary.review ?? null,
      ruleCoverage: summary.ruleCoverage ?? null,
      releaseReady: summary.releaseReady === true,
      model: summary.model ?? null,
    },
    rules: result?.rules ?? null,
    netlist: result?.netlist ?? null,
    plan: {
      operations: Array.isArray(result?.plan?.operations) ? result.plan.operations.length : 0,
      skipped: Array.isArray(result?.plan?.skipped) ? result.plan.skipped.slice(0, 50) : [],
    },
    evidence: result?.evidence ?? null,
    digest: result?.digest ?? null,
  };
}

/**
 * 运行一次离线设计闭环（只读）。
 * @param {{model:object, options?:{maxIterations?:number, fabProfile?:string}}} input
 * @returns {object} 裁剪后的闭环摘要
 */
export function runFrameworkLoop({ model, options } = {}) {
  if (!isPlainObject(model)) throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.INVALID_MODEL, 'model 必须是板级 IR 对象（board/components/nets）', 400);
  const normalizedOptions = isPlainObject(options) ? options : {};
  let serialized;
  try {
    serialized = JSON.stringify(model);
  } catch (error) {
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.INVALID_MODEL, `model 不是合法 JSON：${String(error?.message ?? error).slice(0, 160)}`, 400);
  }
  const bytes = Buffer.byteLength(serialized ?? '', 'utf8');
  if (bytes > DESIGN_FRAMEWORK_MODEL_MAX_BYTES) {
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.MODEL_TOO_LARGE, `model JSON 超过上限 ${DESIGN_FRAMEWORK_MODEL_MAX_BYTES} 字节（实际 ${bytes}）`, 413, { bytes, maxBytes: DESIGN_FRAMEWORK_MODEL_MAX_BYTES });
  }
  const maxIterations = clampIterations(normalizedOptions.maxIterations);
  const fabProfile = typeof normalizedOptions.fabProfile === 'string' && normalizedOptions.fabProfile.trim() ? normalizedOptions.fabProfile.trim() : undefined;
  let result;
  try {
    result = runDesignLoop(model, {
      ...(maxIterations === undefined ? {} : { maxIterations }),
      ...(fabProfile === undefined ? {} : { fabProfile }),
    });
  } catch (error) {
    // 模型结构错误（板框/位号/网络等）挂 400；其它内部错误挂 500，但都不伪装成功。
    const status = Number.isInteger(error?.status) ? error.status : /BOARD_MODEL_/.test(String(error?.code ?? '')) ? 400 : 500;
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.RUN_FAILED, String(error?.message ?? error), status, { causeCode: error?.code ?? null });
  }
  return summarizeLoopResult(result);
}

/** 框架状态（KiCad CLI / 外部求解器探测 + 分层元数据），只读。 */
export function frameworkStatusView() {
  return frameworkStatus();
}

/** 金板评估（5 个离线用例），只读；失败不抛异常，返回 ok:false + metrics。 */
export function goldenReport({ dir = DEFAULT_GOLDEN_DIR } = {}) {
  try {
    const report = runGoldenEvaluation({ dir, runLoop: runDesignLoop });
    return {
      ok: report.ok === true,
      metrics: report.metrics,
      results: report.results.map((result) => ({
        id: result.id,
        ok: result.ok,
        status: result.status,
        iterations: result.iterations,
        repairCount: result.repairCount,
        blockingAfter: result.blockingAfter,
        reviewAfter: result.reviewAfter,
        ruleCoverage: result.ruleCoverage,
        violations: result.violations,
      })),
    };
  } catch (error) {
    throw coded(DESIGN_FRAMEWORK_SERVICE_CODES.GOLDEN_FAILED, String(error?.message ?? error), 500, { causeCode: error?.code ?? null });
  }
}
