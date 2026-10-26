/**
 * 阻抗反解：给定叠层几何与目标阻抗，求所需线宽（必要时连同间距）。
 *
 * 设计原则：**只做求根，不引入第二套电磁公式**。
 * 每个反解都用 stackup.mjs 里同一个正向模型做二分搜索，因此“解出来的线宽”
 * 用正向模型回算必然命中目标——这正是测试里 round-trip 断言在守的东西。
 * 如果哪天有人为了“更准”在反解里另写一个近似式，round-trip 会立刻失败。
 */

import { cpwgImpedance, differentialFromSingleEnded, microstripImpedance, striplineImpedance } from './stackup.mjs';

/** 物理可实现的线宽搜索区间（mm）。刻意放宽，越界由 achievableOhm 如实报告，而不是悄悄夹紧。 */
export const DEFAULT_WIDTH_BOUNDS = Object.freeze({ minWidthMm: 0.02, maxWidthMm: 20 });
export const DEFAULT_TOLERANCE_OHM = 0.5;
const MAX_ITERATIONS = 100;

/**
 * 二分求根。阻抗随线宽单调下降，所以区间两端必须满足 z(min) > z(max)。
 * 任何不满足单调性、或目标落在可达区间之外的情况，都返回 achievable:false 并附上可达范围，
 * 绝不返回一个“看起来像答案”的线宽。
 */
function bisectWidth({ evaluate, targetOhm, toleranceOhm, minWidthMm, maxWidthMm }) {
  const zAtMin = evaluate(minWidthMm);
  const zAtMax = evaluate(maxWidthMm);
  const achievableOhm = { min: zAtMax, max: zAtMin };
  if (!(zAtMin > zAtMax)) return { achievable: false, reason: 'MODEL_NOT_MONOTONIC', achievableOhm };
  if (targetOhm > zAtMin) return { achievable: false, reason: 'TARGET_ABOVE_ACHIEVABLE_RANGE', achievableOhm, bounds: { minWidthMm, maxWidthMm } };
  if (targetOhm < zAtMax) return { achievable: false, reason: 'TARGET_BELOW_ACHIEVABLE_RANGE', achievableOhm, bounds: { minWidthMm, maxWidthMm } };
  let low = minWidthMm;
  let high = maxWidthMm;
  let widthMm = (low + high) / 2;
  let impedanceOhm = evaluate(widthMm);
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    widthMm = (low + high) / 2;
    impedanceOhm = evaluate(widthMm);
    if (Math.abs(impedanceOhm - targetOhm) <= toleranceOhm) return { achievable: true, widthMm, impedanceOhm, iterations: iteration, toleranceOhm };
    if (impedanceOhm > targetOhm) low = widthMm; else high = widthMm;
  }
  return { achievable: false, reason: 'TOLERANCE_NOT_REACHED', bestWidthMm: widthMm, bestImpedanceOhm: impedanceOhm, toleranceOhm };
}

function boundsOf({ minWidthMm, maxWidthMm, minWidthMmFloor }) {
  const min = Number(minWidthMm ?? minWidthMmFloor ?? DEFAULT_WIDTH_BOUNDS.minWidthMm);
  const max = Number(maxWidthMm ?? DEFAULT_WIDTH_BOUNDS.maxWidthMm);
  if (!(min > 0) || !(max > min)) throw new Error('IMPEDANCE_BOUNDS_INVALID');
  return { minWidthMm: min, maxWidthMm: max };
}

export function solveMicrostripWidth({ targetOhm, copperThicknessMm, heightMm, er, toleranceOhm = DEFAULT_TOLERANCE_OHM, minWidthMm, maxWidthMm } = {}) {
  const bounds = boundsOf({ minWidthMm, maxWidthMm });
  const result = bisectWidth({
    evaluate: (widthMm) => microstripImpedance({ widthMm, copperThicknessMm, heightMm, er }).impedanceOhm,
    targetOhm: Number(targetOhm), toleranceOhm, ...bounds,
  });
  return { kind: 'microstrip', model: 'Hammerstad-like microstrip', ...result };
}

export function solveStriplineWidth({ targetOhm, copperThicknessMm, planeSpacingMm, er, toleranceOhm = DEFAULT_TOLERANCE_OHM, minWidthMm, maxWidthMm } = {}) {
  const bounds = boundsOf({ minWidthMm, maxWidthMm });
  const result = bisectWidth({
    evaluate: (widthMm) => striplineImpedance({ widthMm, copperThicknessMm, planeSpacingMm, er }).impedanceOhm,
    targetOhm: Number(targetOhm), toleranceOhm, ...bounds,
  });
  return { kind: 'stripline', model: 'symmetric-stripline', ...result };
}

export function solveCpwgWidth({ targetOhm, gapMm, heightMm, er, toleranceOhm = DEFAULT_TOLERANCE_OHM, minWidthMm, maxWidthMm } = {}) {
  const bounds = boundsOf({ minWidthMm, maxWidthMm });
  const result = bisectWidth({
    evaluate: (widthMm) => cpwgImpedance({ widthMm, gapMm, heightMm, er }).impedanceOhm,
    targetOhm: Number(targetOhm), toleranceOhm, ...bounds,
  });
  return { kind: 'cpwg', model: 'finite-gap CPWG approximation', ...result };
}

/**
 * 差分阻抗反解（外层微带差分对，如 USB2 90Ω）。
 *
 * 耦合修正只与间距/介质厚度有关、与线宽无关，所以可以把目标差分阻抗**解析地**
 * 折算成对应的单端阻抗，再复用同一个二分求根：
 *   Zdiff = 2 * Z0 * (1 - 0.48 * coupling)  =>  Z0 = Zdiff / (2 * (1 - 0.48 * coupling))
 * 折算公式取自 stackup.mjs 的 differentialFromSingleEnded，不在此处重写。
 */
export function solveDifferentialWidth({ targetDifferentialOhm, pairGapMm, copperThicknessMm, heightMm, er, toleranceOhm = DEFAULT_TOLERANCE_OHM, minWidthMm, maxWidthMm } = {}) {
  const bounds = boundsOf({ minWidthMm, maxWidthMm });
  const gapMm = Number(pairGapMm || 0);
  // 先取一个参考单端阻抗拿 coupling（coupling 与线宽无关，取 50Ω 只是代入用）。
  const reference = differentialFromSingleEnded({ singleEndedOhm: 50, pairGapMm: gapMm, heightMm: Number(heightMm) });
  const factor = reference.differentialOhm / 50;
  if (!(factor > 0)) throw new Error('IMPEDANCE_INPUT_INVALID');
  const singleEndedTargetOhm = Number(targetDifferentialOhm) / factor;
  const singleEndedToleranceOhm = Number(toleranceOhm) / factor;
  const result = bisectWidth({
    evaluate: (widthMm) => microstripImpedance({ widthMm, copperThicknessMm, heightMm, er }).impedanceOhm,
    targetOhm: singleEndedTargetOhm,
    toleranceOhm: singleEndedToleranceOhm,
    ...bounds,
  });
  if (!result.achievable) {
    // 把可达范围换算回差分口径，便于直接和 90Ω/120Ω 这类目标对比。
    const achievableOhm = result.achievableOhm ? { min: result.achievableOhm.min * factor, max: result.achievableOhm.max * factor } : undefined;
    return { kind: 'differential-microstrip', model: 'Hammerstad-like microstrip + coupling', factor, ...result, achievableOhm };
  }
  const forward = differentialFromSingleEnded({ singleEndedOhm: result.impedanceOhm, pairGapMm: gapMm, heightMm: Number(heightMm) });
  return { kind: 'differential-microstrip', model: 'Hammerstad-like microstrip + coupling', factor, pairGapMm: gapMm, ...result, singleEndedOhm: result.impedanceOhm, differentialOhm: forward.differentialOhm };
}

/** 报告某几何下可达的阻抗区间（用于解释“为什么这个目标做不到”）。 */
export function impedanceRange({ kind, copperThicknessMm, heightMm, planeSpacingMm, gapMm, er, minWidthMm, maxWidthMm } = {}) {
  const bounds = boundsOf({ minWidthMm, maxWidthMm });
  const evaluate = {
    microstrip: (widthMm) => microstripImpedance({ widthMm, copperThicknessMm, heightMm, er }).impedanceOhm,
    stripline: (widthMm) => striplineImpedance({ widthMm, copperThicknessMm, planeSpacingMm, er }).impedanceOhm,
    cpwg: (widthMm) => cpwgImpedance({ widthMm, gapMm, heightMm, er }).impedanceOhm,
  }[kind];
  if (!evaluate) throw new Error(`IMPEDANCE_KIND_UNSUPPORTED: ${kind}`);
  const atMin = evaluate(bounds.minWidthMm);
  const atMax = evaluate(bounds.maxWidthMm);
  return { kind, achievableOhm: { min: atMax, max: atMin }, bounds };
}
