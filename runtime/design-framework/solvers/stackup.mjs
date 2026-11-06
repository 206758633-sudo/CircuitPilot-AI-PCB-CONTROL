/**
 * 叠层 / 层数 / 单端阻抗求解：纯 JS（impedance.mjs 二分反解 + fab-rules.mjs 工艺能力校验）。
 *
 * 定位：OR-Tools / Z3 不参与这里的决策，本模块把"选几层、每层什么类型、目标阻抗需要多宽的线"
 * 变成一次**确定性枚举 + 可行性判定**；判不了的（缺证据）一律 REVIEW，绝不假装 PASS。
 *
 * 简化假设（IR 的 stackup 不含介质层，所以只能给出工程上足够用的近似，全部写在这里）：
 *   1. 层数分配：2L = 2 个 signal（底层按"铺地参考面"假设）；
 *      4L/6L 及更多偶数层 = top/bottom 为 signal，其余内层为 plane。
 *   2. 板厚 thicknessMm 均分到 (层数-1) 个介质间隔；介质介电常数优先取 IR 里已有的 er，否则 FR-4 取 4.2。
 *   3. 外层 signal 用微带模型（参考相邻内层/底层铺铜）；内层 signal 若上下相邻都是 plane 用对称带状线模型，
 *      只有一侧是 plane 时退化为"单侧参考微带近似"（如实标注 kind）；两侧都没有 plane 则跳过该层。
 *   4. 铜厚 = 1 oz ≈ 0.035mm（按 copperOz 线性换算），用 impedance.mjs 的正向模型做二分反解，
 *      线宽可行域取 [0.05, 20]mm。
 *   5. 层数候选过滤：≥ board.layers（下限）、≤ rules.maxLayers（上限）、且为 ≥2 的偶数。
 *
 * 返回约定：ok/feasible 为 true 时才给出 stackup/线宽；否则 findings 里是明确的 fail-closed 原因，
 * stackup:null，不返回"看起来可用"的叠层。同输入必得同 digest（无时间/随机）。
 */
import { createHash } from 'node:crypto';
import { MAX_LAYERS, canonicalJson, createBoardModel } from '../board-model.mjs';
import { solveMicrostripWidth, solveStriplineWidth } from '../../engineering/impedance.mjs';
import { evaluateFabRules } from '../../engineering/fab-rules.mjs';

export const STACKUP_CODES = Object.freeze({
  MODEL_INVALID: 'STACKUP_MODEL_INVALID',
  LAYER_COUNT_UNSUPPORTED: 'STACKUP_LAYER_COUNT_UNSUPPORTED',
  TARGET_INFEASIBLE: 'STACKUP_TARGET_INFEASIBLE',
  NO_FEASIBLE_CANDIDATE: 'STACKUP_NO_FEASIBLE_CANDIDATE',
  WIDTH_OUT_OF_BOUNDS: 'STACKUP_WIDTH_OUT_OF_BOUNDS',
  FAB_FAIL: 'STACKUP_FAB_FAIL',
  FAB_REVIEW: 'STACKUP_FAB_REVIEW',
  FAB_PROFILE_UNKNOWN: 'STACKUP_FAB_PROFILE_UNKNOWN',
  THICKNESS_INVALID: 'STACKUP_THICKNESS_INVALID',
  IR_INVALID: 'STACKUP_IR_INVALID',
});

/** 线宽可行域（mm）——与任务约定一致，超出即判不可行，不夹紧。 */
export const WIDTH_DOMAIN_MM = Object.freeze({ minWidthMm: 0.05, maxWidthMm: 20 });
export const DEFAULT_DIELECTRIC_ER = 4.2;
/** 1 oz 铜厚（mm）。 */
export const COPPER_MM_PER_OZ = 0.035;

export const STACKUP_ASSUMPTIONS = Object.freeze({
  layerAssignment: '2L=2 signal；4L/6L…=top/bottom signal + 内层 plane',
  dielectric: '板厚均分到 (层数-1) 个介质间隔；er 优先取 IR，否则 FR-4 4.2',
  lineModels: '外层=微带；内层上下皆 plane=对称带状线；仅一侧 plane=单侧参考微带近似',
  copperThicknessMmPerOz: COPPER_MM_PER_OZ,
  widthDomainMm: WIDTH_DOMAIN_MM,
});

const EPS = 1e-9;
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const modelError = (message, details) => Object.assign(new Error(message), { code: STACKUP_CODES.MODEL_INVALID, details });
const finding = (code, message, extra = {}) => ({ code, severity: 'error', message, ...extra });

/** IR 层类型分配（简化规则，见文件头假设 1）。 */
export function layerAssignmentFor(layerCount) {
  const layers = Number(layerCount);
  if (!Number.isInteger(layers) || layers < 2 || layers % 2 !== 0) {
    throw modelError(`层数必须是 ≥2 的偶数，收到 ${layerCount}`);
  }
  if (layers === 2) return ['signal', 'signal'];
  return ['signal', ...Array(layers - 2).fill('plane'), 'signal'];
}

/**
 * 由层数/板厚生成可被 board-model.mjs 接受的 stackup（含介质层描述）。
 * @returns {{layers:Array, totalThicknessMm:number, dielectrics:Array}}
 */
export function buildStackupPlan({ layerCount, thicknessMm, copperOz = 1, er = DEFAULT_DIELECTRIC_ER } = {}) {
  const types = layerAssignmentFor(layerCount);
  const copperThicknessMm = round6(Number(copperOz) * COPPER_MM_PER_OZ);
  const gapCount = Math.max(1, types.length - 1);
  const gapMm = round6(Number(thicknessMm) / gapCount);
  const layers = types.map((type, index) => ({ name: `L${index + 1}`, type, thicknessMm: copperThicknessMm }));
  const dielectrics = [];
  for (let index = 0; index < types.length - 1; index += 1) {
    dielectrics.push({ between: [`L${index + 1}`, `L${index + 2}`], thicknessMm: gapMm, er });
  }
  return { layers, totalThicknessMm: Number(thicknessMm), dielectrics };
}

/** 解析 fabProfile（"JLCPCB:4L-1oz" 或 "JLCPCB"），返回板厂名（变体按候选层数自行派生）。 */
function parseFabProfile(model) {
  const raw = model?.rules?.fabProfile;
  if (typeof raw === 'string' && raw.trim()) {
    const [fab, variant] = raw.split(':');
    return { fab: (fab ?? '').trim() || 'JLCPCB', variantHint: (variant ?? '').trim() || null };
  }
  return { fab: 'JLCPCB', variantHint: null };
}

function fabVariantName(layerCount, copperOz) {
  const oz = Number(copperOz);
  const ozText = Number.isInteger(oz) ? String(oz) : String(round6(oz));
  return `${layerCount}L-${ozText}oz`;
}

/** 用 fab-rules.mjs 的工艺能力做基本校验；缺证据的规则会是 REVIEW（不是 PASS）。 */
function checkFabForCandidate({ model, layerCount, copperOz, fabInfo }) {
  const variant = fabVariantName(layerCount, copperOz);
  const design = {
    layers: layerCount,
    copperOz,
    ...(Number(model?.rules?.minTraceWidthMm) > 0
      ? { minTraceWidthMm: { outer: Number(model.rules.minTraceWidthMm), inner: Number(model.rules.minTraceWidthMm) } }
      : {}),
  };
  try {
    const audit = evaluateFabRules({ fab: fabInfo.fab, variant, design });
    const status = audit.summary.FAIL > 0 ? 'FAIL' : audit.summary.REVIEW > 0 ? 'REVIEW' : 'PASS';
    const idsByStatus = (target) => audit.rules.filter((rule) => rule.status === target).map((rule) => rule.id);
    return {
      status,
      fab: audit.fab,
      variant: audit.variant,
      packHash: audit.pack?.hash ?? null,
      summary: audit.summary,
      failedRules: idsByStatus('FAIL'),
      reviewedRules: idsByStatus('REVIEW'),
      notes: audit.rules.filter((rule) => rule.status === 'REVIEW').map((rule) => `${rule.id} ${rule.name}`),
    };
  } catch (error) {
    // 板厂/变体不在能力包内、或能力包缺证据：REVIEW 而不是 PASS，更不是 FAIL 冒充放行。
    return {
      status: 'REVIEW',
      fab: fabInfo.fab,
      variant,
      packHash: null,
      summary: null,
      failedRules: [],
      reviewedRules: [],
      notes: [`能力包无法覆盖 ${fabInfo.fab} / ${variant}：${error?.code ?? error?.message ?? error}`],
      profileError: error?.code ?? 'FAB_PROFILE_UNAVAILABLE',
    };
  }
}

/**
 * 对给定 stackup 反解单端阻抗线宽（微带优先，内层带参考平面时用带状线）。
 * 独立导出便于直接校验"微带/带状线"两条路径；solveStackup 内部也走它。
 *
 * @param {object} params
 * @param {{layers:Array, dielectrics:Array}} params.stackup 由 buildStackupPlan 产出（或等价结构）
 * @param {number} params.targetOhm 目标单端阻抗（Ω）
 * @param {number} [params.toleranceOhm=0.5]
 * @param {number} [params.copperOz=1]
 * @returns {{ok:boolean, kind:string|null, layer:string|null, widthMm:number|null, impedanceOhm:number|null, reason:string|null, attempts:Array}}
 */
export function solveStackupImpedance({ stackup, targetOhm, toleranceOhm = 0.5, copperOz = 1, minWidthMm = WIDTH_DOMAIN_MM.minWidthMm, maxWidthMm = WIDTH_DOMAIN_MM.maxWidthMm } = {}) {
  const target = Number(targetOhm);
  if (!Number.isFinite(target) || target <= 0) throw modelError(`targetOhm 必须是正数，收到 ${targetOhm}`);
  if (!stackup || !Array.isArray(stackup.layers) || !Array.isArray(stackup.dielectrics)) {
    throw modelError('solveStackupImpedance 需要 buildStackupPlan 产出的 stackup（含 layers/dielectrics）');
  }
  const copperThicknessMm = round6(Number(copperOz) * COPPER_MM_PER_OZ);
  const attempts = [];
  for (let index = 0; index < stackup.layers.length; index += 1) {
    const layer = stackup.layers[index];
    if (layer.type !== 'signal') continue;
    const above = index > 0 ? stackup.dielectrics[index - 1] : null;
    const below = index < stackup.layers.length - 1 ? stackup.dielectrics[index] : null;
    const aboveType = index > 0 ? stackup.layers[index - 1].type : null;
    const belowType = index < stackup.layers.length - 1 ? stackup.layers[index + 1].type : null;
    const attemptBase = { layer: layer.name, kind: null, reference: null };
    if (index === 0 && below) {
      // 外层微带：参考相邻层（2L 时即底层铺地假设）。
      attempts.push({
        ...attemptBase,
        kind: 'microstrip',
        reference: belowType === 'plane' ? `${stackup.layers[1].name}(plane)` : `${stackup.layers[1].name}(ground-pour)`,
        heightMm: below.thicknessMm,
        ...solveMicrostripWidth({ targetOhm: target, copperThicknessMm, heightMm: below.thicknessMm, er: below.er, toleranceOhm, minWidthMm, maxWidthMm }),
      });
      continue;
    }
    if (index === stackup.layers.length - 1 && above) {
      attempts.push({
        ...attemptBase,
        kind: 'microstrip',
        reference: aboveType === 'plane' ? `${stackup.layers[index - 1].name}(plane)` : `${stackup.layers[index - 1].name}(ground-pour)`,
        heightMm: above.thicknessMm,
        ...solveMicrostripWidth({ targetOhm: target, copperThicknessMm, heightMm: above.thicknessMm, er: above.er, toleranceOhm, minWidthMm, maxWidthMm }),
      });
      continue;
    }
    if (above && below && aboveType === 'plane' && belowType === 'plane') {
      // 内层对称带状线：上下都是平面层。
      const planeSpacingMm = above.thicknessMm + below.thicknessMm;
      attempts.push({
        ...attemptBase,
        kind: 'stripline',
        reference: `${stackup.layers[index - 1].name}(plane)+${stackup.layers[index + 1].name}(plane)`,
        planeSpacingMm,
        ...solveStriplineWidth({ targetOhm: target, copperThicknessMm, planeSpacingMm, er: below.er, toleranceOhm, minWidthMm, maxWidthMm }),
      });
      continue;
    }
    if (above && below && (aboveType === 'plane' || belowType === 'plane')) {
      // 只有一侧参考平面：退化为单侧参考微带近似（如实标注）。
      const referenceSide = aboveType === 'plane' ? above : below;
      attempts.push({
        ...attemptBase,
        kind: 'microstrip-approx',
        reference: `${(aboveType === 'plane' ? stackup.layers[index - 1] : stackup.layers[index + 1]).name}(plane)`,
        heightMm: referenceSide.thicknessMm,
        ...solveMicrostripWidth({ targetOhm: target, copperThicknessMm, heightMm: referenceSide.thicknessMm, er: referenceSide.er, toleranceOhm, minWidthMm, maxWidthMm }),
      });
      continue;
    }
    attempts.push({ ...attemptBase, kind: 'unsupported', reason: 'NO_REFERENCE_PLANE' });
  }
  const first = attempts.find((attempt) => attempt.achievable === true);
  if (!first) {
    const diagnosed = attempts.find((attempt) => attempt.reason && attempt.reason !== 'NO_REFERENCE_PLANE')
      ?? attempts.find((attempt) => attempt.reason)
      ?? null;
    return {
      ok: false,
      kind: null,
      layer: null,
      widthMm: null,
      impedanceOhm: null,
      reason: diagnosed?.reason ?? 'NO_SIGNAL_LAYER',
      detail: diagnosed?.kind === 'unsupported' ? diagnosed.reason : null,
      achievableOhm: diagnosed?.achievableOhm ?? null,
      attempts,
    };
  }
  const withinDomain = first.widthMm >= minWidthMm - EPS && first.widthMm <= maxWidthMm + EPS;
  if (!withinDomain) {
    return {
      ok: false,
      kind: first.kind,
      layer: first.layer,
      widthMm: first.widthMm,
      impedanceOhm: first.impedanceOhm ?? null,
      reason: STACKUP_CODES.WIDTH_OUT_OF_BOUNDS,
      bounds: { minWidthMm, maxWidthMm },
      attempts,
    };
  }
  return {
    ok: true,
    kind: first.kind,
    layer: first.layer,
    widthMm: first.widthMm,
    impedanceOhm: first.impedanceOhm ?? null,
    toleranceOhm,
    reference: first.reference,
    attempts,
  };
}

/** 把一个候选层数评估成"可行/不可行 + 原因"，供 alternatives 与 fail-closed 说明使用。 */
function evaluateCandidate({ model, layerCount, thicknessMm, copperOz, er, targetOhm, toleranceOhm, fabInfo }) {
  const stackup = buildStackupPlan({ layerCount, thicknessMm, copperOz, er });
  try {
    createBoardModel({
      board: { widthMm: model.board.widthMm, heightMm: model.board.heightMm, layers: layerCount },
      stackup: { layers: stackup.layers, totalThicknessMm: stackup.totalThicknessMm },
    });
  } catch (error) {
    return { layers: layerCount, feasible: false, reasonCode: STACKUP_CODES.IR_INVALID, reason: `生成的叠层不被板级 IR 接受：${error?.code ?? error?.message ?? error}`, fabStatus: null, stackup };
  }
  const fab = checkFabForCandidate({ model, layerCount, copperOz, fabInfo });
  if (fab.status === 'FAIL') {
    return { layers: layerCount, feasible: false, reasonCode: STACKUP_CODES.FAB_FAIL, reason: `板厂工艺不满足：${fab.failedRules.join(', ') || fab.variant}`, fabStatus: fab.status, fab, stackup };
  }
  if (targetOhm === null) {
    return { layers: layerCount, feasible: true, reasonCode: null, reason: null, fabStatus: fab.status, fab, stackup, widthMm: null, impedance: null };
  }
  const impedance = solveStackupImpedance({ stackup, targetOhm, toleranceOhm, copperOz });
  if (!impedance.ok) {
    const reasonCode = impedance.reason === STACKUP_CODES.WIDTH_OUT_OF_BOUNDS ? STACKUP_CODES.WIDTH_OUT_OF_BOUNDS : STACKUP_CODES.TARGET_INFEASIBLE;
    return {
      layers: layerCount,
      feasible: false,
      reasonCode,
      reason: `目标 ${targetOhm}Ω ±${toleranceOhm}Ω 不可行（${impedance.reason}${impedance.achievableOhm ? `，可达 ${round6(impedance.achievableOhm.min)}–${round6(impedance.achievableOhm.max)}Ω` : ''}）`,
      fabStatus: fab.status,
      fab,
      stackup,
      widthMm: impedance.widthMm,
      impedance,
    };
  }
  return {
    layers: layerCount,
    feasible: true,
    reasonCode: null,
    reason: null,
    fabStatus: fab.status,
    fab,
    stackup,
    widthMm: impedance.widthMm,
    impedanceOhm: impedance.impedanceOhm,
    impedance,
  };
}

/**
 * 叠层求解：枚举候选层数，按"最小层数优先"选第一个可行解。
 *
 * @param {object} model board-model.mjs 的板级 IR
 * @param {object} [options]
 * @param {number[]} [options.candidateLayerCounts=[2,4,6]] 候选层数
 * @param {number} [options.thicknessMm=1.6] 板厚（未显式传时优先用 IR 的 board.thicknessMm）
 * @param {number} [options.copperOz=1] 铜厚（未显式传时优先用 IR 的 board.copperOz）
 * @param {number|null} [options.targetImpedanceOhm=null] 单端目标阻抗（未传时用 rules.targetImpedanceOhm）
 * @param {number} [options.toleranceOhm=0.5] 阻抗容差
 * @returns {{ok:boolean, layers:number|null, stackup:object|null, feasible:boolean, findings:Array, alternatives:Array, stats:object, digest:string}}
 */
export function solveStackup(model, options = {}) {
  if (!model || typeof model !== 'object') throw modelError('solveStackup 需要 board-model IR 对象');
  const widthMm = Number(model.board?.widthMm);
  const heightMm = Number(model.board?.heightMm);
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw modelError('board.widthMm/board.heightMm 必须是正数', { widthMm: model.board?.widthMm, heightMm: model.board?.heightMm });
  }
  const opts = {
    candidateLayerCounts: [2, 4, 6],
    thicknessMm: 1.6,
    copperOz: 1,
    targetImpedanceOhm: null,
    toleranceOhm: 0.5,
    ...(options ?? {}),
  };
  const hasOwn = (key) => options !== undefined && options !== null && Object.prototype.hasOwnProperty.call(options, key);
  const boardThickness = Number(model.board?.thicknessMm);
  const thicknessMm = hasOwn('thicknessMm')
    ? Number(opts.thicknessMm)
    : (boardThickness > 0 ? boardThickness : Number(opts.thicknessMm));
  const boardCopperOz = Number(model.board?.copperOz);
  const copperOz = hasOwn('copperOz') ? Number(opts.copperOz) : (boardCopperOz > 0 ? boardCopperOz : Number(opts.copperOz));
  const targetOhm = hasOwn('targetImpedanceOhm')
    ? (opts.targetImpedanceOhm === null ? null : Number(opts.targetImpedanceOhm))
    : (Number(model.rules?.targetImpedanceOhm) > 0 ? Number(model.rules.targetImpedanceOhm) : null);
  const toleranceOhm = Math.max(0, Number(opts.toleranceOhm) || 0.5);
  const erFromModel = Array.isArray(model.stackup?.layers)
    ? model.stackup.layers.map((layer) => Number(layer?.er)).find((value) => Number.isFinite(value) && value > 1)
    : null;
  const er = erFromModel ?? DEFAULT_DIELECTRIC_ER;
  const fabInfo = parseFabProfile(model);

  const boardLayers = Math.max(2, Number(model.board?.layers) || 2);
  const maxLayers = Math.min(MAX_LAYERS, Math.max(2, Number(model.rules?.maxLayers) || MAX_LAYERS));
  const findings = [];

  if (!(thicknessMm >= 0.2 && thicknessMm <= 10)) {
    findings.push(finding(STACKUP_CODES.THICKNESS_INVALID, `板厚 ${thicknessMm}mm 不在可制造范围 [0.2,10]mm，fail-closed 不给出叠层`, { thicknessMm }));
  }

  const rawCandidateCounts = Array.isArray(opts.candidateLayerCounts) ? opts.candidateLayerCounts : [];
  const candidateLayerCounts = [...new Set(rawCandidateCounts
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 2 && value % 2 === 0)
    .filter((value) => value >= boardLayers && value <= maxLayers))]
    .sort((a, b) => a - b);

  if (candidateLayerCounts.length === 0) {
    findings.push(finding(
      STACKUP_CODES.LAYER_COUNT_UNSUPPORTED,
      `没有可用层数候选：候选 ${JSON.stringify(rawCandidateCounts)} 需为 ≥2 偶数、≥ board.layers(${boardLayers})、≤ rules.maxLayers(${maxLayers})`,
      { candidateLayerCounts: rawCandidateCounts, boardLayers, maxLayers },
    ));
  }
  if (!(copperOz >= 0.25 && copperOz <= 20)) {
    findings.push(finding(STACKUP_CODES.MODEL_INVALID, `copperOz ${copperOz} 不在 [0.25,20] 范围，fail-closed`, { copperOz }));
  }

  const alternatives = [];
  let chosen = null;
  const thicknessValid = thicknessMm >= 0.2 && thicknessMm <= 10;
  if (thicknessValid && copperOz >= 0.25 && copperOz <= 20) {
    for (const layerCount of candidateLayerCounts) {
      const candidate = evaluateCandidate({ model, layerCount, thicknessMm, copperOz, er, targetOhm, toleranceOhm, fabInfo });
      alternatives.push({
        layers: layerCount,
        feasible: candidate.feasible,
        widthMm: candidate.widthMm ?? null,
        impedanceOhm: candidate.impedanceOhm ?? null,
        fabStatus: candidate.fabStatus ?? null,
        reasonCode: candidate.reasonCode ?? null,
        reason: candidate.reason ?? null,
        layerPlan: candidate.stackup ? candidate.stackup.layers.map((layer) => `${layer.name}:${layer.type}`) : [],
        dielectrics: candidate.stackup?.dielectrics ?? [],
        impedanceKind: candidate.impedance?.kind ?? null,
        impedanceAttempts: candidate.impedance?.attempts ?? [],
      });
      if (!chosen && candidate.feasible) chosen = candidate;
    }
  }

  if (chosen) {
    if (chosen.fabStatus === 'REVIEW') {
      findings.push({
        code: STACKUP_CODES.FAB_REVIEW,
        severity: 'warning',
        message: `板厂工艺能力校验为 REVIEW（不是 PASS）：${chosen.fab?.notes?.slice(0, 6).join('；') ?? chosen.fab?.variant ?? ''}`,
        fab: { fab: chosen.fab?.fab ?? null, variant: chosen.fab?.variant ?? null, summary: chosen.fab?.summary ?? null },
      });
    }
    for (const alternative of alternatives) {
      if (alternative.feasible) continue;
      findings.push({
        code: alternative.reasonCode ?? STACKUP_CODES.NO_FEASIBLE_CANDIDATE,
        severity: 'warning',
        message: `${alternative.layers}L 候选不可行：${alternative.reason ?? alternative.reasonCode}`,
        layers: alternative.layers,
      });
    }
  } else {
    // fail-closed：没有可行候选，逐条说明原因。
    if (candidateLayerCounts.length > 0 && thicknessValid) {
      for (const alternative of alternatives) {
        findings.push({
          code: alternative.reasonCode ?? (targetOhm !== null ? STACKUP_CODES.TARGET_INFEASIBLE : STACKUP_CODES.NO_FEASIBLE_CANDIDATE),
          message: `${alternative.layers}L 候选不可行：${alternative.reason ?? alternative.reasonCode}`,
          layers: alternative.layers,
        });
      }
      findings.push(finding(
        targetOhm !== null ? STACKUP_CODES.TARGET_INFEASIBLE : STACKUP_CODES.NO_FEASIBLE_CANDIDATE,
        targetOhm !== null
          ? `没有候选层数能在 ${toleranceOhm}Ω 容差内实现 ${targetOhm}Ω 单端阻抗（fail-closed，不给出"看起来可用"的叠层）`
          : '没有候选层数通过几何/工艺可行性检查（fail-closed，不给出"看起来可用"的叠层）',
        { targetImpedanceOhm: targetOhm, alternatives: alternatives.map((item) => ({ layers: item.layers, reason: item.reason })) },
      ));
    }
  }

  const feasible = Boolean(chosen);
  const publishedStackup = chosen
    ? { layers: chosen.stackup.layers, totalThicknessMm: chosen.stackup.totalThicknessMm, dielectrics: chosen.stackup.dielectrics }
    : null;
  const stats = {
    candidateLayerCounts,
    evaluated: alternatives.length,
    chosenLayers: chosen?.layers ?? null,
    totalThicknessMm: thicknessMm,
    copperOz,
    dielectricEr: er,
    widthDomainMm: WIDTH_DOMAIN_MM,
    targetImpedanceOhm: targetOhm,
    toleranceOhm,
    boardLayers,
    maxLayers,
    fab: chosen ? { fab: chosen.fab?.fab ?? null, variant: chosen.fab?.variant ?? null, status: chosen.fabStatus } : (fabInfo.variantHint ? { fab: fabInfo.fab, variant: fabInfo.variantHint, status: null } : { fab: fabInfo.fab, variant: null, status: null }),
    assumptions: STACKUP_ASSUMPTIONS,
  };
  const payload = {
    ok: feasible,
    layers: chosen?.layers ?? null,
    stackup: publishedStackup,
    feasible,
    findings,
    alternatives,
  };
  const result = {
    ...payload,
    impedance: chosen
      ? (chosen.impedance ? { kind: chosen.impedance.kind, widthMm: chosen.impedance.widthMm, impedanceOhm: chosen.impedance.impedanceOhm ?? null, toleranceOhm } : null)
      : null,
    stats,
    digest: sha256(payload),
  };
  return result;
}
