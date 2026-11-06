/**
 * 闭环编排：Plan → Verify → Repair → 再验证（Design-as-Code + Rule-as-Code + 求解器 的合流点）。
 *
 * 定位：在**不写 EDA**的前提下，把板级 IR 迭代到"规则层不再有阻断项"，输出：
 *   - 每轮 IR digest / 修复动作 / 阻断项（可审计、可回放）；
 *   - 最终 IR 与编译出的 EDA 写操作（作为审批后的执行候选）；
 *   - 统一证据对象（供门禁/评估台/知识库引用）。
 *
 * 边界（fail-closed）：
 *   - 只做确定性修复（补叠层、重排布局）；不能修的问题（网表短路、尺寸未知）升级 blocked；
 *   - 有 REVIEW 未消除时状态是 needs-review，**不是 passed**；
 *   - 不自动写 EDA、不自动签核、不把"求解器成功"当成"板子通过"。
 */
import { boardModelDigest, createBoardModel, summarizeBoardModel, toPcbOperations } from './board-model.mjs';
import { evaluateRuleDeck } from './rule-deck.mjs';
import { solvePlacement } from './solvers/placement.mjs';
import { solveStackup } from './solvers/stackup.mjs';
import { checkNetlist } from './solvers/netlist.mjs';
import { REPAIR_STRATEGIES, classifyBlocking, isBlockingFinding } from './repair-strategies.mjs';

export const DESIGN_LOOP_SCHEMA_VERSION = 1;

export const DESIGN_LOOP_STATUS = Object.freeze({
  PASSED: 'passed',
  NEEDS_REVIEW: 'needs-review',
  BLOCKED: 'blocked',
});

export const DESIGN_LOOP_CODES = Object.freeze({
  INPUT_INVALID: 'DESIGN_LOOP_INPUT_INVALID',
  NO_PROGRESS: 'DESIGN_LOOP_NO_PROGRESS',
  ITERATION_LIMIT: 'DESIGN_LOOP_ITERATION_LIMIT',
  NETLIST_BLOCKING: 'DESIGN_LOOP_NETLIST_BLOCKING',
});

const digestOf = (value) => boardModelDigest(value);

/** 从 IR 重新构建模型（保持不可变语义：每轮修复产生新模型）。 */
function rebuild(model, patch = {}) {
  return createBoardModel({
    meta: model.meta,
    board: { ...model.board, ...(patch.board ?? {}) },
    stackup: patch.stackup !== undefined ? patch.stackup : model.stackup,
    components: patch.components ?? model.components,
    nets: patch.nets ?? model.nets,
    rules: model.rules,
  });
}

/** 把求解器返回的叠层写回 IR（层数同步到 board.layers，保持模型自洽）。 */
export function applyStackupSolution(model, solution) {
  if (!solution || solution.ok !== true || !solution.stackup) return null;
  const layers = Number(solution.layers ?? solution.stackup.layers?.length);
  if (!Number.isInteger(layers) || layers <= 0) return null;
  return rebuild(model, { board: { layers }, stackup: { ...solution.stackup, layers: [...solution.stackup.layers] } });
}

/** 把求解器返回的坐标写回 IR。 */
export function applyPlacementSolution(model, solution) {
  if (!solution || solution.ok !== true || !Array.isArray(solution.placements)) return null;
  const byRef = new Map(solution.placements.map((placement) => [String(placement.ref).toUpperCase(), placement]));
  if (byRef.size === 0) return null;
  const components = model.components.map((component) => {
    const placement = byRef.get(component.ref);
    if (!placement) return component;
    return { ...component, xMm: placement.xMm, yMm: placement.yMm, ...(placement.rotationDeg === undefined ? {} : { rotationDeg: placement.rotationDeg }) };
  });
  return rebuild(model, { components });
}

/* ------------------------------------------------------------------ */
/* 几何检查（只读当前 IR，不复用求解器分支——"我算的"和"我验的"必须分开）  */
/* ------------------------------------------------------------------ */

function expandedBox(component) {
  const quarterTurn = Math.abs(Math.round(component.rotationDeg / 90)) % 2 === 1;
  const width = (quarterTurn ? component.heightMm : component.widthMm) ?? 0;
  const height = (quarterTurn ? component.widthMm : component.heightMm) ?? 0;
  const courtyard = Number.isFinite(component.courtyardMm) ? component.courtyardMm : 0;
  const clearance = Number.isFinite(component.clearanceMm) ? component.clearanceMm : 0;
  const halfW = width / 2 + courtyard / 2 + clearance / 2;
  const halfH = height / 2 + courtyard / 2 + clearance / 2;
  return { x0: component.xMm - halfW, x1: component.xMm + halfW, y0: component.yMm - halfH, y1: component.yMm + halfH };
}

const boxesOverlap = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const boxHitsRect = (box, rect) => box.x0 < rect.x1 && box.x1 > rect.x0 && box.y0 < rect.y1 && box.y1 > rect.y0;

/** 当前 IR 的布局硬约束违反项（尺寸未知/出板/压 keepout/器件重叠）。 */
export function inspectPlacement(model) {
  const violations = [];
  const edge = Number.isFinite(model.rules.minEdgeClearanceMm) ? model.rules.minEdgeClearanceMm : 0;
  const boxes = [];
  for (const component of model.components) {
    if (component.sizeUnknown) {
      violations.push({ code: 'PLACEMENT_SIZE_UNKNOWN', ref: component.ref, message: `${component.ref} 尺寸未知，不能自动布局/校验` });
      continue;
    }
    const box = expandedBox(component);
    boxes.push({ ref: component.ref, box });
    if (box.x0 < edge || box.y0 < edge || box.x1 > model.board.widthMm - edge || box.y1 > model.board.heightMm - edge) {
      violations.push({ code: 'PLACEMENT_OUTSIDE_BOARD', ref: component.ref, message: `${component.ref} 超出板框或板边距不足` });
    }
    for (const keepout of model.board.keepouts) {
      if (boxHitsRect(box, keepout)) violations.push({ code: 'PLACEMENT_KEEPOUT', ref: component.ref, message: `${component.ref} 落在禁布区 ${keepout.id}` });
    }
  }
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      if (boxesOverlap(boxes[left].box, boxes[right].box)) {
        violations.push({ code: 'PLACEMENT_OVERLAP', ref: boxes[left].ref, ref2: boxes[right].ref, message: `${boxes[left].ref} 与 ${boxes[right].ref} 重叠（含间距/禁布外扩）` });
      }
    }
  }
  return violations;
}

/**
 * 单轮验证：网表 + 叠层 + 当前几何 + 规则。只读，不做求解。
 * @returns {{blocking:Array, reviewCount:number, rules:object, netlist:object, placement:Array, stackupNeeded:boolean}}
 */
export function verifyModel(model, options = {}) {
  const blocking = [];
  const netlist = checkNetlist(model, { intent: options.intent ?? null });
  for (const finding of netlist.findings ?? []) {
    if (finding.severity === 'error') blocking.push({ source: 'netlist', code: finding.code, message: finding.message });
  }
  const stackupNeeded = model.stackup === null && (model.board.layers > 2 || Number.isFinite(model.rules.targetImpedanceOhm));
  if (stackupNeeded) blocking.push({ source: 'stackup', code: 'STACKUP_MISSING', message: '叠层缺失（>2 层或有阻抗目标），需要求解或人工确认' });
  const placement = inspectPlacement(model);
  for (const violation of placement) blocking.push({ source: 'placement', code: violation.code, ref: violation.ref, message: violation.message });
  const rules = evaluateRuleDeck(model, { fabProfile: options.fabProfile ?? model.rules.fabProfile });
  for (const finding of rules.findings ?? []) {
    if (isBlockingFinding(finding)) blocking.push({ source: 'rule', code: finding.ruleId, group: finding.group, message: finding.message });
  }
  const reviewCount = Number(rules.summary?.review ?? 0) + (netlist.findings ?? []).filter((finding) => finding.severity !== 'error').length;
  return { blocking, reviewCount, rules, netlist, placement, stackupNeeded };
}

/** 一轮修复：按"补叠层 → 重排布局"顺序，返回 {model, repairs} 或 null（无可执行修复）。 */
function repairOnce(model, verification, options) {
  const repairs = [];
  const groups = classifyBlocking(verification.blocking);
  let current = model;
  if (groups.needsStackup) {
    const solution = solveStackup(current, options.stackup ?? {});
    const repaired = applyStackupSolution(current, solution);
    if (repaired) {
      repairs.push({ strategy: REPAIR_STRATEGIES.solve_stackup.id, riskLevel: REPAIR_STRATEGIES.solve_stackup.riskLevel, detail: `layers=${repaired.board.layers}`, fromDigest: boardModelDigest(current), toDigest: boardModelDigest(repaired) });
      current = repaired;
    }
  }
  if (groups.needsPlacement) {
    const solution = solvePlacement(current, options.placement ?? {});
    const repaired = applyPlacementSolution(current, solution);
    if (repaired) {
      repairs.push({ strategy: REPAIR_STRATEGIES.solve_placement.id, riskLevel: REPAIR_STRATEGIES.solve_placement.riskLevel, detail: `placed=${solution.placements?.length ?? 0}/${current.components.length}`, fromDigest: boardModelDigest(current), toDigest: boardModelDigest(repaired) });
      current = repaired;
    }
  }
  if (repairs.length === 0 && groups.manual.length > 0) {
    return { model: current, repairs, manual: groups.manual };
  }
  return repairs.length > 0 ? { model: current, repairs, manual: groups.manual } : null;
}

/**
 * 运行 Plan-Verify-Repair 闭环。
 * @param {object} input 板级 IR（或可被 createBoardModel 接受的原始对象）
 * @param {{maxIterations?:number, fabProfile?:string, intent?:Array, placement?:object, stackup?:object}} [options]
 * @returns {object} 闭环结果（含状态/每轮记录/修复/最终 IR/证据/编译操作）
 */
export function runDesignLoop(input, options = {}) {
  const maxIterations = Number.isInteger(options.maxIterations) && options.maxIterations > 0 ? Math.min(12, options.maxIterations) : 4;
  let model = createBoardModel(input);
  const initialDigest = boardModelDigest(model);
  const iterations = [];
  const repairs = [];
  let verification = null;
  let status = DESIGN_LOOP_STATUS.BLOCKED;

  for (let index = 1; index <= maxIterations; index += 1) {
    verification = verifyModel(model, options);
    iterations.push({
      iteration: index,
      modelDigest: boardModelDigest(model),
      blocking: verification.blocking.map((item) => ({ source: item.source, code: item.code, ref: item.ref ?? null, group: item.group ?? null })),
      reviewCount: verification.reviewCount,
      ruleSummary: verification.rules.summary,
    });
    if (verification.blocking.length === 0) {
      status = verification.reviewCount > 0 ? DESIGN_LOOP_STATUS.NEEDS_REVIEW : DESIGN_LOOP_STATUS.PASSED;
      break;
    }
    const repaired = repairOnce(model, verification, options);
    if (!repaired || repaired.repairs.length === 0) {
      status = DESIGN_LOOP_STATUS.BLOCKED;
      break;
    }
    repairs.push(...repaired.repairs.map((repair) => ({ iteration: index, ...repair })));
    model = repaired.model;
  }

  // 停止后做最后一次验证，保证返回的状态与最终 IR 一致（迭代上限/无可修复时也要如实）。
  const finalVerification = verification && iterations.at(-1)?.modelDigest === boardModelDigest(model)
    ? verification
    : verifyModel(model, options);
  if (finalVerification.blocking.length === 0) {
    status = finalVerification.reviewCount > 0 ? DESIGN_LOOP_STATUS.NEEDS_REVIEW : DESIGN_LOOP_STATUS.PASSED;
  } else {
    status = DESIGN_LOOP_STATUS.BLOCKED;
  }

  const finalDigest = boardModelDigest(model);
  const plan = toPcbOperations(model);
  const evidence = {
    kind: 'design-loop-evidence',
    schemaVersion: DESIGN_LOOP_SCHEMA_VERSION,
    status,
    initialDigest,
    finalDigest,
    iterations: iterations.length,
    repairs: repairs.map((repair) => ({ iteration: repair.iteration, strategy: repair.strategy, riskLevel: repair.riskLevel, fromDigest: repair.fromDigest, toDigest: repair.toDigest })),
    finalBlocking: finalVerification.blocking.map((item) => ({ source: item.source, code: item.code, ref: item.ref ?? null, group: item.group ?? null })),
    finalReviewCount: finalVerification.reviewCount,
    ruleSummary: finalVerification.rules.summary,
    planOperationCount: plan.operations.length,
  };
  return {
    ok: status !== DESIGN_LOOP_STATUS.BLOCKED,
    status,
    iterations,
    repairs,
    manual: finalVerification.blocking.filter((item) => item.source === 'netlist' || item.source === 'rule' || item.source === 'placement'),
    model,
    summary: {
      initialDigest,
      finalDigest,
      iterations: iterations.length,
      repairs: repairs.length,
      blocking: finalVerification.blocking.length,
      review: finalVerification.reviewCount,
      ruleCoverage: finalVerification.rules.summary?.coverageRatio ?? null,
      releaseReady: status === DESIGN_LOOP_STATUS.PASSED,
      model: summarizeBoardModel(model),
    },
    rules: finalVerification.rules.summary,
    netlist: finalVerification.netlist.summary,
    plan,
    evidence,
    digest: digestOf({ initialDigest, finalDigest, status, iterations, repairs: repairs.map((repair) => ({ strategy: repair.strategy, fromDigest: repair.fromDigest, toDigest: repair.toDigest })), finalBlocking: evidence.finalBlocking, ruleSummary: evidence.ruleSummary }),
  };
}
