import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardModel } from '../design-framework/board-model.mjs';
import { microstripImpedance } from '../engineering/stackup.mjs';
import {
  NETLIST_CODES,
  PLACEMENT_CODES,
  SOLVER_ADAPTERS,
  STACKUP_CODES,
  checkNetlist,
  detectExternalSolvers,
  netlistDiff,
  solvePlacement,
  solveStackup,
  solveStackupImpedance,
} from '../design-framework/solvers/index.mjs';

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const EPS = 1e-6;
const round6 = (value) => Math.round(value * 1e6) / 1e6;

/** 从 placement 结果反推膨胀后的矩形（与求解器假设一致：中心 + 本体尺寸 + courtyard/clearance）。 */
function placementRects(model, result) {
  const byRef = new Map(model.components.map((component) => [component.ref, component]));
  return result.placements.map((placement) => {
    const component = byRef.get(placement.ref);
    const rotation = ((placement.rotationDeg % 360) + 360) % 360;
    const swap = rotation === 90 || rotation === 270;
    const bodyWidth = swap ? component.heightMm : component.widthMm;
    const bodyHeight = swap ? component.widthMm : component.heightMm;
    const pad = (component.courtyardMm ?? 0) + (component.clearanceMm ?? 0);
    const halfW = bodyWidth / 2 + pad;
    const halfH = bodyHeight / 2 + pad;
    return { ref: placement.ref, x0: placement.xMm - halfW, x1: placement.xMm + halfW, y0: placement.yMm - halfH, y1: placement.yMm + halfH };
  });
}

function assertNoOverlap(rects) {
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const overlap = a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
      assert.equal(overlap, false, `${a.ref} 与 ${b.ref} 重叠`);
    }
  }
}

/** 器件本体矩形（不做 courtyard/clearance 外扩），用于核对制造间距。 */
function bodyRects(model, result) {
  const byRef = new Map(model.components.map((component) => [component.ref, component]));
  return result.placements.map((placement) => {
    const component = byRef.get(placement.ref);
    const rotation = ((placement.rotationDeg % 360) + 360) % 360;
    const swap = rotation === 90 || rotation === 270;
    const width = swap ? component.heightMm : component.widthMm;
    const height = swap ? component.widthMm : component.heightMm;
    return { ref: placement.ref, x0: placement.xMm - width / 2, x1: placement.xMm + width / 2, y0: placement.yMm - height / 2, y1: placement.yMm + height / 2 };
  });
}

/** 两个矩形的欧氏间隙（rule-deck SPACE-14 用的口径）。 */
function rectGap(a, b) {
  const dx = Math.max(0, Math.max(a.x0 - b.x1, b.x0 - a.x1));
  const dy = Math.max(0, Math.max(a.y0 - b.y1, b.y0 - a.y1));
  return Math.hypot(dx, dy);
}

function assertInsideBoard(rects, model, edgeMm = 0) {
  for (const rect of rects) {
    assert.ok(rect.x0 >= edgeMm - EPS, `${rect.ref} 左出界`);
    assert.ok(rect.y0 >= edgeMm - EPS, `${rect.ref} 下出界`);
    assert.ok(rect.x1 <= model.board.widthMm - edgeMm + EPS, `${rect.ref} 右出界`);
    assert.ok(rect.y1 <= model.board.heightMm - edgeMm + EPS, `${rect.ref} 上出界`);
  }
}

/* ------------------------------------------------------------------ */
/* placement                                                           */
/* ------------------------------------------------------------------ */

function normalBoardInput() {
  return {
    board: { widthMm: 60, heightMm: 40, layers: 2, thicknessMm: 1.6, copperOz: 1, keepouts: [{ id: 'k1', x0: 0, y0: 0, x1: 6, y1: 6, reason: 'mounting' }] },
    components: [
      { ref: 'U1', xMm: 0, yMm: 0, widthMm: 8, heightMm: 8 },
      { ref: 'U2', xMm: 0, yMm: 0, widthMm: 6, heightMm: 6 },
      { ref: 'C1', xMm: 0, yMm: 0, widthMm: 1.6, heightMm: 0.8, clearanceMm: 0.2 },
      { ref: 'C2', xMm: 0, yMm: 0, widthMm: 1.6, heightMm: 0.8 },
      { ref: 'R1', xMm: 0, yMm: 0, widthMm: 2, heightMm: 1.2, courtyardMm: 0.1 },
    ],
    rules: { minEdgeClearanceMm: 0.5 },
  };
}

test('placement：正常板全部落位，无重叠/出界/keepout；同输入 digest 相同', () => {
  const model = createBoardModel(normalBoardInput());
  const result = solvePlacement(model, { gridMm: 0.5, timeBudgetMs: 10000 });
  assert.equal(result.ok, true);
  assert.equal(result.placements.length, 5);
  assert.equal(result.unplaced.length, 0);
  assert.equal(result.stats.placed, 5);
  assert.equal(result.stats.total, 5);
  assert.equal(result.stats.budgetExceeded, false);
  assert.equal(result.rotation.allowRotations, false);

  const rects = placementRects(model, result);
  assertNoOverlap(rects);
  assertInsideBoard(rects, model, model.rules.minEdgeClearanceMm);
  for (const rect of rects) {
    assert.ok(rect.x1 <= 6 - EPS || rect.x0 >= 6 + EPS || rect.y1 <= 6 - EPS || rect.y0 >= 6 + EPS, `${rect.ref} 压到 keepout`);
  }

  const again = solvePlacement(model, { gridMm: 0.5, timeBudgetMs: 10000 });
  assert.equal(result.digest, again.digest, '同输入必须得到同 digest');
  assert.deepEqual(result.placements, again.placements, '同输入必须得到同 placements');
  assert.equal(result.digest.length, 64);
});

test('placement：fixed 器件作为锚点保留坐标，不悄悄移动', () => {
  const model = createBoardModel({
    board: { widthMm: 60, heightMm: 40 },
    components: [
      { ref: 'U1', xMm: 10, yMm: 12, widthMm: 5, heightMm: 5, fixed: true },
      { ref: 'C1', xMm: 0, yMm: 0, widthMm: 1.6, heightMm: 0.8 },
    ],
  });
  const result = solvePlacement(model);
  assert.equal(result.ok, true);
  const u1 = result.placements.find((placement) => placement.ref === 'U1');
  assert.equal(u1.xMm, 10);
  assert.equal(u1.yMm, 12);
  assertNoOverlap(placementRects(model, result));
});

test('placement：fixed 器件出界只报告不移动（fail-closed）', () => {
  const model = createBoardModel({
    board: { widthMm: 20, heightMm: 20 },
    components: [{ ref: 'U1', xMm: 18, yMm: 18, widthMm: 8, heightMm: 8, fixed: true }],
  });
  const result = solvePlacement(model);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((item) => item.code === PLACEMENT_CODES.OUTSIDE_BOARD && item.ref === 'U1'), '必须报告 fixed 越界');
  const u1 = result.placements.find((placement) => placement.ref === 'U1');
  assert.equal(u1.xMm, 18, 'fixed 器件坐标不能被悄悄移动');
  assert.equal(u1.yMm, 18);
});

test('placement：sizeUnknown 器件跳过且不猜尺寸；其余器件照常落位', () => {
  const model = createBoardModel({
    board: { widthMm: 60, heightMm: 40 },
    components: [
      { ref: 'U1', xMm: 0, yMm: 0, widthMm: 5, heightMm: 5 },
      { ref: 'X1', xMm: 0, yMm: 0, sizeUnknown: true },
    ],
  });
  const result = solvePlacement(model);
  assert.equal(result.ok, false, '存在 unplaced 时不能报成功');
  assert.equal(result.unplaced.length, 1);
  assert.equal(result.unplaced[0].ref, 'X1');
  assert.equal(result.unplaced[0].code, PLACEMENT_CODES.SIZE_UNKNOWN);
  assert.ok(result.placements.some((placement) => placement.ref === 'U1'), '已知尺寸的器件仍应落位');
});

test('placement：贪心必失败、回溯成功的窄板陷阱', () => {
  // 10×4 板、两个 4×4 器件。候选点按"到板中心距离"排序：贪心（取首个可行候选、不回退）
  // 会把 U1 放在板中心 (5,2)，此时 U2 无论放哪都重叠 → 纯贪心失败。
  // 回溯搜索退回 U1 的其它候选点，最终 U1 贴左、U2 贴右，全部落位。
  const model = createBoardModel({
    board: { widthMm: 10, heightMm: 4 },
    components: [
      { ref: 'U1', xMm: 0, yMm: 0, widthMm: 4, heightMm: 4 },
      { ref: 'U2', xMm: 0, yMm: 0, widthMm: 4, heightMm: 4 },
    ],
  });
  const result = solvePlacement(model, { gridMm: 0.5, timeBudgetMs: 10000 });
  assert.equal(result.ok, true, '回溯搜索必须找到可行解');
  assert.equal(result.placements.length, 2);
  assert.ok(result.stats.backtracks > 0, '必须发生回退（证明不是纯贪心）');
  const u1 = result.placements.find((placement) => placement.ref === 'U1');
  assert.notEqual(u1.xMm, 5, '纯贪心的首个候选点（板中心）在这里会卡死后续器件');
  assert.equal(u1.yMm, 2);
  assertNoOverlap(placementRects(model, result));
});

test('placement：预算超限 fail-closed（ok:false + 明确 code + 不返回半成品）', () => {
  const model = createBoardModel(normalBoardInput());
  const result = solvePlacement(model, { timeBudgetMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.stats.budgetExceeded, true);
  assert.deepEqual(result.placements, [], 'fail-closed 不返回任何 placements');
  assert.ok(result.findings.some((item) => item.code === PLACEMENT_CODES.BUDGET_EXCEEDED));
  assert.ok(result.unplaced.length > 0);
  assert.ok(result.unplaced.every((item) => item.code === PLACEMENT_CODES.BUDGET_EXCEEDED));
});

test('placement：默认保证器件本体间距 ≥ 0.30mm（对齐规则包 SPACE-14 吸嘴空间）', () => {
  const model = createBoardModel(normalBoardInput());
  const result = solvePlacement(model, { gridMm: 0.5, timeBudgetMs: 10000 });
  assert.equal(result.ok, true);
  const bodies = bodyRects(model, result);
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const gap = rectGap(bodies[i], bodies[j]);
      assert.ok(gap >= 0.3 - EPS, `${bodies[i].ref} ↔ ${bodies[j].ref} 本体间距 ${gap}mm < 0.30mm（rule-deck SPACE-14 会判 FAIL）`);
    }
  }
  // partGapMm 可显式关掉（例如只做纯几何求解）
  const tight = solvePlacement(model, { gridMm: 0.5, partGapMm: 0, timeBudgetMs: 10000 });
  assert.equal(tight.ok, true);
});

test('placement：partGapMm 是"求解器默认加上的制造间距"，显式关闭后不再额外加间距', () => {
  // 10×4 板 + 两个 4.9×4 器件：本体总宽 9.8mm。
  // 默认 partGapMm=0.3 时最紧凑也要 9.8+0.3 > 10 → fail-closed；
  // 显式 partGapMm=0 后只要求本体不重叠 → 可行，且本体间距会 < 0.30mm。
  const model = createBoardModel({
    board: { widthMm: 10, heightMm: 4 },
    components: [
      { ref: 'U1', xMm: 0, yMm: 0, widthMm: 4.9, heightMm: 4 },
      { ref: 'U2', xMm: 0, yMm: 0, widthMm: 4.9, heightMm: 4 },
    ],
  });
  const strict = solvePlacement(model, { gridMm: 0.5, timeBudgetMs: 10000 });
  assert.equal(strict.ok, false, '默认制造间距 0.30mm 下 9.8+0.3 > 10，应 fail-closed');
  assert.deepEqual(strict.placements, []);
  assert.ok(strict.findings.some((item) => item.code === PLACEMENT_CODES.UNPLACED));

  const relaxed = solvePlacement(model, { gridMm: 0.5, partGapMm: 0, timeBudgetMs: 10000 });
  assert.equal(relaxed.ok, true, 'partGapMm=0 时只做纯几何不重叠，应该可行');
  const bodies = bodyRects(model, relaxed);
  const gap = rectGap(bodies[0], bodies[1]);
  assert.ok(gap < 0.3 - EPS, `显式关闭 partGapMm 后不应再额外加 0.30mm（实际本体间距 ${gap}mm）`);
});

test('placement：尺寸根本放不进板 → unplaced PLACEMENT_OUTSIDE_BOARD', () => {
  const model = createBoardModel({
    board: { widthMm: 20, heightMm: 20 },
    components: [{ ref: 'U1', xMm: 0, yMm: 0, widthMm: 30, heightMm: 10 }],
  });
  const result = solvePlacement(model);
  assert.equal(result.ok, false);
  assert.equal(result.unplaced[0].ref, 'U1');
  assert.equal(result.unplaced[0].code, PLACEMENT_CODES.OUTSIDE_BOARD);
});

/* ------------------------------------------------------------------ */
/* stackup                                                             */
/* ------------------------------------------------------------------ */

test('stackup：2L 无目标阻抗 → 最小层数 2 层；digest 可复现', () => {
  const model = createBoardModel({ board: { widthMm: 60, heightMm: 40, layers: 2, thicknessMm: 1.6, copperOz: 1 } });
  const result = solveStackup(model);
  assert.equal(result.ok, true);
  assert.equal(result.feasible, true);
  assert.equal(result.layers, 2);
  assert.equal(result.stackup.layers.length, 2);
  assert.deepEqual(result.stackup.layers.map((layer) => layer.type), ['signal', 'signal']);
  assert.equal(result.impedance, null);
  assert.ok(result.alternatives.length >= 1);
  // 缺证据的工艺规则必须是 REVIEW，而不是 PASS（不允许"看起来没问题"放行）
  assert.equal(result.stats.fab.status, 'REVIEW');
  assert.ok(result.findings.some((item) => item.code === STACKUP_CODES.FAB_REVIEW && item.severity === 'warning'));
  assert.equal(result.digest, solveStackup(model).digest);
});

test('stackup：4L 板 + 50Ω 微带目标 → 4 层可行叠层 + 线宽，正向模型回算命中容差', () => {
  const model = createBoardModel({ board: { widthMm: 70, heightMm: 48, layers: 4, thicknessMm: 1.6, copperOz: 1 }, rules: { minTraceWidthMm: 0.1 } });
  const result = solveStackup(model, { targetImpedanceOhm: 50, toleranceOhm: 0.5 });
  assert.equal(result.ok, true);
  assert.equal(result.layers, 4, '最小层数优先：4L 板不会跳到 6L');
  assert.equal(result.impedance.kind, 'microstrip');
  assert.ok(result.impedance.widthMm >= 0.05 - EPS && result.impedance.widthMm <= 20 + EPS);
  assert.equal(result.stackup.layers.length, 4);
  assert.equal(result.stackup.layers.filter((layer) => layer.type === 'plane').length, 2);
  // 用同一个正向模型（engineering/stackup.mjs）回算，确认不是"解出一个看起来像答案的数"
  const dielectric = result.stackup.dielectrics[0];
  const forward = microstripImpedance({
    widthMm: result.impedance.widthMm,
    copperThicknessMm: 0.035,
    heightMm: dielectric.thicknessMm,
    er: dielectric.er,
  }).impedanceOhm;
  assert.ok(Math.abs(forward - 50) <= 0.5 + 1e-6, `回算阻抗 ${forward} 未命中 50Ω`);
  assert.ok(result.alternatives.every((item) => item.layers >= 4));
});

test('stackup：不可能目标（500Ω 单端微带）→ fail-closed，不返回"看起来可用"的叠层', () => {
  const model = createBoardModel({ board: { widthMm: 70, heightMm: 48, layers: 4, thicknessMm: 1.6, copperOz: 1 } });
  const result = solveStackup(model, { targetImpedanceOhm: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.feasible, false);
  assert.equal(result.layers, null);
  assert.equal(result.stackup, null);
  assert.ok(result.findings.some((item) => item.code === STACKUP_CODES.TARGET_INFEASIBLE));
  assert.ok(result.alternatives.length > 0 && result.alternatives.every((item) => item.feasible === false));
  // 不可行原因要如实给出可达范围
  assert.ok(result.alternatives.every((item) => typeof item.reason === 'string' && item.reason.length > 0));
});

test('stackup：层数不超过 rules.maxLayers，且不低于 board.layers', () => {
  const model = createBoardModel({
    board: { widthMm: 60, heightMm: 40, layers: 2 },
    rules: { maxLayers: 4 },
  });
  const result = solveStackup(model, { candidateLayerCounts: [2, 4, 6] });
  assert.equal(result.ok, true);
  assert.equal(result.layers, 2);
  assert.ok(result.alternatives.every((item) => item.layers <= 4), '候选层数必须被 maxLayers 截断');

  const fourLayer = createBoardModel({ board: { widthMm: 60, heightMm: 40, layers: 4 } });
  const fourLayerResult = solveStackup(fourLayer);
  assert.equal(fourLayerResult.ok, true);
  assert.equal(fourLayerResult.layers, 4, '不能低于 board.layers 下限');
});

test('stackup：无内层候选时 fail-closed（LAYER_COUNT_UNSUPPORTED）', () => {
  const model = createBoardModel({ board: { widthMm: 60, heightMm: 40, layers: 6 }, rules: { maxLayers: 4 } });
  const result = solveStackup(model, { candidateLayerCounts: [2, 4, 6] });
  assert.equal(result.ok, false);
  assert.equal(result.layers, null);
  assert.ok(result.findings.some((item) => item.code === STACKUP_CODES.LAYER_COUNT_UNSUPPORTED));
});

test('stackup：内层信号（上下皆 plane）走带状线反解（impedance.mjs 的带状线模型）', () => {
  // 自定义 stackup：plane / signal / plane —— 中间那层是典型的对称带状线几何
  const stackup = {
    layers: [
      { name: 'L1', type: 'plane' },
      { name: 'L2', type: 'signal' },
      { name: 'L3', type: 'plane' },
    ],
    dielectrics: [
      { between: ['L1', 'L2'], thicknessMm: 0.4, er: 4.2 },
      { between: ['L2', 'L3'], thicknessMm: 0.4, er: 4.2 },
    ],
  };
  const result = solveStackupImpedance({ stackup, targetOhm: 50, toleranceOhm: 0.5, copperOz: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'stripline');
  assert.equal(result.layer, 'L2');
  assert.ok(result.widthMm >= 0.05 - EPS && result.widthMm <= 20 + EPS);
});

/* ------------------------------------------------------------------ */
/* netlist                                                             */
/* ------------------------------------------------------------------ */

test('netlist：同一 REF.PIN 被多个网络引用 → 短路 error', () => {
  const model = createBoardModel({
    board: { widthMm: 60, heightMm: 40 },
    components: [
      { ref: 'U1', xMm: 0, yMm: 0, widthMm: 5, heightMm: 5 },
      { ref: 'C1', xMm: 0, yMm: 0, widthMm: 1.6, heightMm: 0.8 },
    ],
    nets: [
      { name: '3V3', pins: ['U1.1', 'C1.1'] },
      { name: 'GND', pins: ['U1.1', 'C1.2'] },
    ],
  });
  const result = checkNetlist(model);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((item) => item.code === NETLIST_CODES.SHORT && item.severity === 'error' && item.ref === 'U1'));
  assert.ok(result.summary.errors >= 1);
  assert.equal(result.digest.length, 64);
  assert.equal(result.digest, checkNetlist(model).digest, '同输入必须得到同 digest');
});

test('netlist：单端网络记 warning（gnd/power 也仍然 warning，不因此放行）', () => {
  const model = createBoardModel({
    board: { widthMm: 60, heightMm: 40 },
    components: [{ ref: 'U1', xMm: 0, yMm: 0, widthMm: 5, heightMm: 5 }],
    nets: [
      { name: '3V3', pins: ['U1.1'], kind: 'power' },
      { name: 'GND', pins: ['U1.2'], kind: 'gnd' },
    ],
  });
  const result = checkNetlist(model);
  const singlePin = result.findings.filter((item) => item.code === NETLIST_CODES.SINGLE_PIN && item.severity === 'warning');
  assert.equal(singlePin.length, 2);
  assert.equal(result.ok, true, '只有 warning 时 ok 为 true');
  assert.equal(result.summary.warnings, 2);
  assert.equal(result.summary.errors, 0);
});

test('netlist：意图网表 diff（missing/extra 网络与端点按 net 分组）', () => {
  const model = createBoardModel({
    board: { widthMm: 60, heightMm: 40 },
    components: [
      { ref: 'U1', xMm: 0, yMm: 0, widthMm: 5, heightMm: 5 },
      { ref: 'C1', xMm: 0, yMm: 0, widthMm: 1.6, heightMm: 0.8 },
    ],
    nets: [
      { name: '3V3', pins: ['U1.1', 'C1.1'] },
      { name: 'GND', pins: ['U1.2', 'C1.2'] },
      { name: 'SIG', pins: ['U1.3', 'C1.3'] },
    ],
  });

  const intent = [
    { net: '3V3', endpoints: ['U1.1', 'C1.1'] },
    { net: 'GND', endpoints: ['U1.2', 'C1.2'] },
    { net: 'EN', endpoints: ['U1.4', 'C1.4'] },
  ];
  const diff = netlistDiff(model, intent);
  assert.deepEqual(diff.missingNets, ['EN'], '意图有、模型没有的网络');
  assert.deepEqual(diff.extraNets, ['SIG'], '模型有、意图没有的网络');
  assert.equal(diff.ok, false);

  const endpointDiff = netlistDiff(model, [
    { net: '3V3', endpoints: ['U1.1', 'C1.1', 'C1.9'] },
    { net: 'GND', endpoints: ['U1.2', 'C1.2'] },
    { net: 'SIG', endpoints: ['U1.3', 'C1.3'] },
  ]);
  assert.deepEqual(endpointDiff.missingEndpoints, [{ net: '3V3', endpoints: ['C1.9'] }]);
  assert.equal(endpointDiff.ok, false);

  const checked = checkNetlist(model, { intent });
  assert.equal(checked.ok, false);
  assert.ok(checked.findings.some((item) => item.code === NETLIST_CODES.INTENT_MISSING_NET && item.net === 'EN'));
  assert.ok(checked.findings.some((item) => item.code === NETLIST_CODES.INTENT_EXTRA_NET && item.net === 'SIG'));
  assert.ok(checked.intent);
  assert.equal(checked.digest, checkNetlist(model, { intent }).digest);
});

/* ------------------------------------------------------------------ */
/* 外部求解器探测                                                       */
/* ------------------------------------------------------------------ */

test('外部求解器探测：本机无 ortools/z3/shapely → available:false，且不抛异常', () => {
  const detected = detectExternalSolvers({ timeoutMs: 5000 });
  for (const key of ['ortools', 'z3', 'shapely']) {
    assert.equal(detected[key].available, false, `${key} 在本机应不可用`);
    assert.equal(detected[key].status, 'unavailable');
    assert.equal(typeof detected[key].reason, 'string');
    assert.ok(detected[key].probed.length > 0);
  }
  assert.equal(detected.fallback.available, true);
  assert.equal(detected.fallback.implementation, 'pure-js');

  // 静态基线：外部求解器永不"自称可用"，必须显式运行时探测。
  assert.equal(SOLVER_ADAPTERS.ortools.available, false);
  assert.equal(SOLVER_ADAPTERS.z3.available, false);
  assert.equal(SOLVER_ADAPTERS.shapely.available, false);
  assert.equal(SOLVER_ADAPTERS.ortools.requiresDetection, true);

  // 指定不存在的解释器也必须 fail-closed，而不是抛异常。
  const forced = detectExternalSolvers({ env: { ...process.env, DSH_SOLVER_PYTHON: '/nonexistent/python' }, pythonBinaries: ['/nonexistent/python'] });
  assert.equal(forced.ortools.available, false);
  assert.match(forced.ortools.reason, /binary-not-found/);
});
