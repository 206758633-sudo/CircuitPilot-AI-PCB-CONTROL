import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeHighSpeed, HIGH_SPEED_PROFILES } from '../engineering/highspeed.mjs';
import { impedanceRange, solveCpwgWidth, solveDifferentialWidth, solveMicrostripWidth, solveStriplineWidth } from '../engineering/impedance.mjs';
import { cpwgImpedance, differentialFromSingleEnded, microstripImpedance, striplineImpedance } from '../engineering/stackup.mjs';

/** 四层板 L1 到 L2 的常见几何：0.2mm prepreg、1oz 铜。 */
const outer = { copperThicknessMm: 0.035, heightMm: 0.2, er: 4.3 };
/** 内层到两侧平面的对称带状线：core 1.0mm 时单侧间距 0.5mm。 */
const inner = { copperThicknessMm: 0.035, planeSpacingMm: 0.5, er: 4.3 };

test('微带反解出的线宽用同一个正向模型回算必须命中目标（round-trip）', () => {
  for (const targetOhm of [40, 50, 60, 75]) {
    const solved = solveMicrostripWidth({ targetOhm, ...outer });
    assert.equal(solved.achievable, true, `${targetOhm}Ω 应可解: ${JSON.stringify(solved)}`);
    assert.ok(solved.widthMm > 0 && solved.widthMm < 2, `线宽应落在合理范围: ${solved.widthMm}`);
    // 关键断言：反解必须与正向模型自洽，否则“算出来的线宽”在分析阶段会被判超差。
    const forward = microstripImpedance({ widthMm: solved.widthMm, ...outer }).impedanceOhm;
    assert.ok(Math.abs(forward - targetOhm) <= 0.5, `回算偏差过大: 目标${targetOhm}Ω 回算${forward.toFixed(3)}Ω`);
  }
});

test('线宽随目标阻抗单调：目标越高线越窄', () => {
  const wide = solveMicrostripWidth({ targetOhm: 40, ...outer });
  const narrow = solveMicrostripWidth({ targetOhm: 75, ...outer });
  assert.ok(narrow.widthMm < wide.widthMm, `75Ω(${narrow.widthMm}) 应比 40Ω(${wide.widthMm}) 窄`);
});

test('目标超出可达范围时如实报告区间，而不是给一个假线宽', () => {
  const tooLow = solveMicrostripWidth({ targetOhm: 0.5, ...outer });
  assert.equal(tooLow.achievable, false);
  assert.equal(tooLow.reason, 'TARGET_BELOW_ACHIEVABLE_RANGE');
  assert.equal(tooLow.widthMm, undefined, '不可达时不得返回线宽');
  // 目标低于可达区间时，区间**下界仍高于目标**（最宽 20mm 也只能到 ~1.75Ω）。
  assert.ok(tooLow.achievableOhm.min > 0.5, `区间下界应高于目标: ${JSON.stringify(tooLow.achievableOhm)}`);

  const tooHigh = solveMicrostripWidth({ targetOhm: 400, ...outer });
  assert.equal(tooHigh.achievable, false);
  assert.equal(tooHigh.reason, 'TARGET_ABOVE_ACHIEVABLE_RANGE');
  assert.ok(tooHigh.achievableOhm.max < 400);
});

test('带状线（内层）反解 round-trip', () => {
  const solved = solveStriplineWidth({ targetOhm: 50, ...inner });
  assert.equal(solved.achievable, true, JSON.stringify(solved));
  const forward = striplineImpedance({ widthMm: solved.widthMm, ...inner }).impedanceOhm;
  assert.ok(Math.abs(forward - 50) <= 0.5, `回算 ${forward.toFixed(3)}Ω`);
  // 内层有两侧参考平面，同样线宽下阻抗明显低于外层微带：这正是四层板能收窄线宽的原因。
  const outerWidth = solveMicrostripWidth({ targetOhm: 50, ...outer }).widthMm;
  assert.ok(solved.widthMm < outerWidth, `带状线线宽(${solved.widthMm}) 应窄于微带(${outerWidth})`);
});

test('CPWG 反解 round-trip', () => {
  const cpwg = { gapMm: 0.2, heightMm: 0.2, er: 4.3 };
  const solved = solveCpwgWidth({ targetOhm: 50, ...cpwg });
  assert.equal(solved.achievable, true, JSON.stringify(solved));
  const forward = cpwgImpedance({ widthMm: solved.widthMm, ...cpwg }).impedanceOhm;
  assert.ok(Math.abs(forward - 50) <= 0.5, `回算 ${forward.toFixed(3)}Ω`);
});

test('差分反解：USB2 90Ω 差分对，且能与高速分析器对齐（跨模块一致性）', () => {
  const pairGapMm = 0.15;
  const solved = solveDifferentialWidth({ targetDifferentialOhm: HIGH_SPEED_PROFILES.usb2.differentialOhm, pairGapMm, ...outer });
  assert.equal(solved.achievable, true, JSON.stringify(solved));
  // 用共享的差分公式回算（不是本模块自己再算一遍）。
  const forward = differentialFromSingleEnded({ singleEndedOhm: solved.singleEndedOhm, pairGapMm, heightMm: outer.heightMm }).differentialOhm;
  assert.ok(Math.abs(forward - 90) <= 1, `差分回算 ${forward.toFixed(3)}Ω`);
  assert.ok(Math.abs(solved.differentialOhm - 90) <= 1);

  // 把反解结果喂回既有的高速分析器：不应再报差分阻抗超差。
  const analysis = analyzeHighSpeed({
    profileId: 'usb2',
    pairGapMm,
    geometry: { widthMm: solved.widthMm, ...outer },
    segments: [{ lengthMm: 20, widthMm: solved.widthMm, neighborSpacingMm: solved.widthMm * 4, referenceContinuous: true }],
  });
  assert.ok(!analysis.findings.some((finding) => finding.code === 'DIFFERENTIAL_IMPEDANCE'),
    `反解结果仍被判超差，说明正反两个方向不一致: ${JSON.stringify(analysis.findings)}`);
});

test('结合板厂最小线宽：目标在该工艺下不可实现时应拒绝而不是给出超工艺线宽', () => {
  // 实测该几何在 0.2mm 线宽时阻抗约 62Ω，因此 85Ω 在 0.2mm 工艺下限下不可达。
  // 嘉立创低成本档位的最小线宽正是 0.2mm。
  const impossible = solveMicrostripWidth({ targetOhm: 85, ...outer, minWidthMm: 0.2 });
  assert.equal(impossible.achievable, false);
  assert.equal(impossible.reason, 'TARGET_ABOVE_ACHIEVABLE_RANGE');
  assert.equal(impossible.widthMm, undefined, '不可实现时不得返回线宽让调用方误用');
  assert.ok(impossible.achievableOhm.max < 85, `可达上限应低于目标: ${JSON.stringify(impossible.achievableOhm)}`);

  // 同一个目标，只把工艺下限放宽到 0.02mm 就能解出来；解出的线宽确实细于 0.2mm，
  // 证明上一条失败确实来自工艺下限，而不是模型算不出来。
  const solvedBelowProfile = solveMicrostripWidth({ targetOhm: 85, ...outer, minWidthMm: 0.02 });
  assert.equal(solvedBelowProfile.achievable, true, JSON.stringify(solvedBelowProfile));
  assert.ok(solvedBelowProfile.widthMm < 0.2, `应为 0.2mm 以下的细线: ${solvedBelowProfile.widthMm}`);
});

test('impedanceRange 报告可达区间，且与反解失败时的区间一致', () => {
  const range = impedanceRange({ kind: 'microstrip', ...outer });
  assert.ok(range.achievableOhm.max > range.achievableOhm.min);
  const failed = solveMicrostripWidth({ targetOhm: 400, ...outer });
  assert.ok(Math.abs(failed.achievableOhm.max - range.achievableOhm.max) < 1e-9);
  assert.throws(() => impedanceRange({ kind: 'waveguide', ...outer }), /IMPEDANCE_KIND_UNSUPPORTED/);
});

test('反解确定性：同样输入必须给出同样线宽', () => {
  const first = solveMicrostripWidth({ targetOhm: 50, ...outer });
  const second = solveMicrostripWidth({ targetOhm: 50, ...outer });
  assert.deepEqual(first, second);
});

test('非法几何与非法边界必须抛错，不允许静默按默认值处理', () => {
  assert.throws(() => solveMicrostripWidth({ targetOhm: 50, ...outer, minWidthMm: -1 }), /IMPEDANCE_BOUNDS_INVALID/);
  assert.throws(() => solveMicrostripWidth({ targetOhm: 50, ...outer, minWidthMm: 1, maxWidthMm: 0.5 }), /IMPEDANCE_BOUNDS_INVALID/);
  assert.throws(() => solveMicrostripWidth({ targetOhm: 50, copperThicknessMm: 0.035, heightMm: 0, er: 4.3 }), /IMPEDANCE_INPUT_INVALID/);
  assert.throws(() => solveStriplineWidth({ targetOhm: 50, copperThicknessMm: 0.035, planeSpacingMm: 0, er: 4.3 }), /IMPEDANCE_INPUT_INVALID/);
});
