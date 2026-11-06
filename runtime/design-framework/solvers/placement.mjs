/**
 * 约束布局求解器：纯 JS 确定性**回溯搜索**（OR-Tools CP-SAT 的离线兜底）。
 *
 * 为什么不是纯贪心：贪心"每个器件取第一个可行候选点、永不回退"在窄板上会
 * 因为先放的器件占住唯一可行位置而整体失败（见测试里的 U1/U2 陷阱用例）。
 * 这里用深度优先 + 回退：某个器件放不下时退回上一个器件的下一个候选点。
 *
 * 输入是 board-model.mjs 的板级 IR（只读，不修改）。求解假设（IR 未显式规定，统一在此说明）：
 *   1. 器件 (xMm, yMm) 是器件**中心**；旋转只做 0/90/180/270 归一化，90/270 交换宽高；
 *      搜索**不**自由旋转（rotationDeg 是设计给定值，旋转策略见返回值 rotation）。
 *   2. 器件矩形按自身 (courtyardMm + clearanceMm) 向四周膨胀后参与冲突判定：
 *      两个器件的膨胀矩形**相交**即冲突（因此一对器件的中心距 ≥ 两者膨胀半宽之和）。
 *   2b. 在膨胀矩形之外再加一圈**默认制造间距** partGapMm/2（默认 0.30mm，对应规则包 SPACE-14
 *      "元件本体四周 ≥0.30mm" 的吸嘴/返修空间）：因此默认输出任意两器件本体间隙 ≥ partGapMm，
 *      保证结果能被 rule-deck 的 SPACE-14 判 PASS，而不是"求解成功、规则层却失败"。
 *      注意：这是**求解器默认加上的制造间距**，不是求解器天然就有 SPACE-14 能力——
 *      显式 `partGapMm: 0` 可关闭它（关闭后只保证本体/膨胀矩形不重叠，可能 <0.30mm，供纯几何求解用）。
 *      该间距只加在器件之间，不额外加到板边距上（板边距只由 minEdgeClearanceMm 决定）。
 *   3. 边距 minEdgeClearanceMm 作用于 (courtyard+clearance) 膨胀后的矩形（比只卡器件本体更保守）。
 *   4. fixed 器件坐标是**锚点**：只报告违规（出界/压 keepout/互相重叠），绝不悄悄移动。
 *   5. 候选点 = 已放置器件锚点邻域（先试，便于贴靠/紧凑）+ 板内网格（按到板中心距离排序）。
 *   6. keepout 对所有层/面生效（IR 的 keepout 没有层面信息，按整块禁止区处理）。
 *
 * 失败语义（fail-closed）：
 *   - 预算超限（maxIterations / timeBudgetMs）→ ok:false、placements:[]、code=PLACEMENT_BUDGET_EXCEEDED；
 *     不返回"放到一半"的布局当成功。
 *   - 搜索在候选空间内找不到完整解 → ok:false、placements:[]、code=PLACEMENT_UNPLACED。
 *   - 只是个别器件缺少证据（sizeUnknown）或尺寸放不进板 → 返回已确定的放置 + unplaced 清单 + ok:false，
 *     绝不猜尺寸、绝不假装成功。
 *
 * 确定性：无随机数、无时间参与决策；timeBudgetMs 只决定"是否 fail-closed"，
 * 同输入（且预算充足时）必得同 placements + 同 digest。stats.elapsedMs 不参与 digest。
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../board-model.mjs';

export const PLACEMENT_CODES = Object.freeze({
  MODEL_INVALID: 'PLACEMENT_MODEL_INVALID',
  SIZE_UNKNOWN: 'PLACEMENT_SIZE_UNKNOWN',
  OUTSIDE_BOARD: 'PLACEMENT_OUTSIDE_BOARD',
  KEEPOUT: 'PLACEMENT_KEEPOUT',
  OVERLAP: 'PLACEMENT_OVERLAP',
  UNPLACED: 'PLACEMENT_UNPLACED',
  BUDGET_EXCEEDED: 'PLACEMENT_BUDGET_EXCEEDED',
});

const EPS = 1e-9;
/** 每根轴上最多枚举的网格点数；超出时按固定步长抽稀（只为控制规模，不改变确定性）。 */
const MAX_GRID_POINTS_PER_AXIS = 64;

const round6 = (value) => Math.round(value * 1e6) / 1e6;
const finiteOr = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const modelError = (message, details) => Object.assign(new Error(message), { code: PLACEMENT_CODES.MODEL_INVALID, details });
const finding = (code, message, extra = {}) => ({ code, severity: 'error', message, ...extra });

function normalizeRotation(rotationDeg) {
  const value = Number(rotationDeg);
  if (!Number.isFinite(value)) return 0;
  const mod = ((value % 360) + 360) % 360;
  return mod === 360 ? 0 : mod;
}

function rectsOverlap(a, b) {
  return a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
}

/**
 * 器件矩形。collision=false：本体+courtyard+clearance（板内/keepout 判定）；
 * collision=true：再外扩 partGapMm/2（器件间冲突判定，含吸嘴间距）。
 */
function rectOf(part, xMm, yMm, collision = false) {
  const halfW = collision ? part.conflictHalfW : part.halfW;
  const halfH = collision ? part.conflictHalfH : part.halfH;
  return {
    ref: part.ref,
    cx: xMm,
    cy: yMm,
    halfW,
    halfH,
    x0: xMm - halfW,
    x1: xMm + halfW,
    y0: yMm - halfH,
    y1: yMm + halfH,
  };
}

/** 板级参数与 keepout（一致的、可重复的归一化）。 */
function prepareBoard(model) {
  if (!model || typeof model !== 'object') throw modelError('placement 求解需要 board-model IR 对象');
  const widthMm = Number(model.board?.widthMm);
  const heightMm = Number(model.board?.heightMm);
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw modelError('board.widthMm/board.heightMm 必须是正数', { widthMm: model.board?.widthMm, heightMm: model.board?.heightMm });
  }
  const edgeMm = Math.max(0, finiteOr(model.rules?.minEdgeClearanceMm, 0));
  const keepouts = (Array.isArray(model.board?.keepouts) ? model.board.keepouts : []).map((item, index) => ({
    id: String(item?.id ?? `keepout-${index + 1}`),
    x0: Number(item.x0),
    y0: Number(item.y0),
    x1: Number(item.x1),
    y1: Number(item.y1),
  })).filter((item) => [item.x0, item.y0, item.x1, item.y1].every((value) => Number.isFinite(value)));
  return { widthMm, heightMm, edgeMm, keepouts };
}

function buildPart(component, gapMm) {
  const ref = String(component.ref ?? '').trim().toUpperCase();
  const rotationDeg = normalizeRotation(component.rotationDeg);
  const swap = rotationDeg === 90 || rotationDeg === 270;
  const bodyWidthMm = swap ? Number(component.heightMm) : Number(component.widthMm);
  const bodyHeightMm = swap ? Number(component.widthMm) : Number(component.heightMm);
  const padMm = Math.max(0, finiteOr(component.courtyardMm, 0)) + Math.max(0, finiteOr(component.clearanceMm, 0));
  // halfW/halfH：板内 & keepout 判定（本体 + courtyard + clearance）
  // conflictHalfW/conflictHalfH：器件间冲突判定（再加 partGapMm/2，保证本体间隙 ≥ partGapMm）
  const gapHalfMm = Math.max(0, gapMm) / 2;
  const halfW = bodyWidthMm / 2 + padMm;
  const halfH = bodyHeightMm / 2 + padMm;
  return {
    ref,
    rotationDeg,
    bodyWidthMm,
    bodyHeightMm,
    padMm,
    halfW,
    halfH,
    conflictHalfW: halfW + gapHalfMm,
    conflictHalfH: halfH + gapHalfMm,
    areaMm2: bodyWidthMm * bodyHeightMm,
    fixed: component.fixed === true,
    declaredX: finiteOr(Number(component.xMm), 0),
    declaredY: finiteOr(Number(component.yMm), 0),
    gridCandidates: null,
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0,
  };
}

/** 轴上的候选值：从下界出发按 grid 步进，保证上界可达；数量超限时等步长抽稀。 */
function axisValues(min, max, gridMm) {
  const step = gridMm > 0 ? gridMm : 0.5;
  const span = max - min;
  const count = Math.floor(span / step + EPS) + 1;
  const raw = [];
  for (let index = 0; index < count; index += 1) {
    const value = round6(min + index * step);
    if (value <= max + EPS) raw.push(Math.min(value, round6(max)));
  }
  if (raw.length === 0 || raw[raw.length - 1] < max - EPS) raw.push(round6(max));
  let values = [...new Set(raw)];
  if (values.length > MAX_GRID_POINTS_PER_AXIS) {
    const stride = Math.ceil(values.length / MAX_GRID_POINTS_PER_AXIS);
    const sampled = values.filter((_, index) => index % stride === 0);
    const last = values[values.length - 1];
    if (sampled[sampled.length - 1] !== last) sampled.push(last);
    values = sampled;
  }
  return values;
}

/** 预计算器件的静态候选空间（与已放置器件无关的部分），返回 null 表示器件尺寸根本放不进板。 */
function prepareCandidateSpace(part, board) {
  const minX = board.edgeMm + part.halfW;
  const maxX = board.widthMm - board.edgeMm - part.halfW;
  const minY = board.edgeMm + part.halfH;
  const maxY = board.heightMm - board.edgeMm - part.halfH;
  if (minX > maxX + EPS || minY > maxY + EPS) return null;
  part.minX = minX;
  part.maxX = maxX;
  part.minY = minY;
  part.maxY = maxY;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const outOfBoard = (xMm, yMm) => xMm < minX - EPS || xMm > maxX + EPS || yMm < minY - EPS || yMm > maxY + EPS;
  const keys = new Map();
  const push = (xMm, yMm) => {
    if (outOfBoard(xMm, yMm)) return;
    const x = round6(xMm);
    const y = round6(yMm);
    const key = `${x},${y}`;
    if (!keys.has(key)) keys.set(key, { xMm: x, yMm: y });
  };
  const xs = axisValues(minX, maxX, part.gridMm);
  const ys = axisValues(minY, maxY, part.gridMm);
  // 候选点整体按"到板中心距离 → y → x"排序：确定性，且优先把器件放在板中央附近。
  const grid = [];
  for (const y of ys) {
    for (const x of xs) {
      if (outOfBoard(x, y)) continue;
      grid.push({ xMm: round6(x), yMm: round6(y), distance: Math.hypot(x - centerX, y - centerY) });
    }
  }
  grid.sort((a, b) => a.distance - b.distance || a.yMm - b.yMm || a.xMm - b.xMm);
  part.gridCandidates = grid.map(({ xMm, yMm }) => ({ xMm, yMm }));
  part.centerX = centerX;
  part.centerY = centerY;
  return part;
}

/** 当前搜索状态下的候选点：锚点邻域优先，其次按板中心距离排序的网格；总数受 maxCandidatesPerPart 限制。 */
function orderedCandidates(part, placedRects, maxCandidatesPerPart) {
  const result = [];
  const seen = new Set();
  const push = (xMm, yMm) => {
    if (result.length >= maxCandidatesPerPart) return;
    if (xMm < part.minX - EPS || xMm > part.maxX + EPS || yMm < part.minY - EPS || yMm > part.maxY + EPS) return;
    const x = round6(xMm);
    const y = round6(yMm);
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ xMm: x, yMm: y });
  };
  // 1) 已放置器件（含 fixed 锚点）邻域：四条边 + 四个角，顺序由放置顺序决定，因此确定性。
  //    placedRects 存的是"冲突矩形"（半宽已含 partGapMm/2），再叠加本器件的冲突半宽即可贴靠且保间距。
  for (const rect of placedRects) {
    const dx = rect.halfW + part.conflictHalfW;
    const dy = rect.halfH + part.conflictHalfH;
    push(rect.cx + dx, rect.cy);
    push(rect.cx - dx, rect.cy);
    push(rect.cx, rect.cy + dy);
    push(rect.cx, rect.cy - dy);
    push(rect.cx + dx, rect.cy + dy);
    push(rect.cx + dx, rect.cy - dy);
    push(rect.cx - dx, rect.cy + dy);
    push(rect.cx - dx, rect.cy - dy);
  }
  // 2) 网格候选（已按到板中心距离排序）。
  for (const candidate of part.gridCandidates) push(candidate.xMm, candidate.yMm);
  return result;
}

function conflictCode(padRect, collisionRect, placedRects, board) {
  for (const keepout of board.keepouts) {
    if (rectsOverlap(padRect, keepout)) return PLACEMENT_CODES.KEEPOUT;
  }
  for (const other of placedRects) {
    if (rectsOverlap(collisionRect, other)) return PLACEMENT_CODES.OVERLAP;
  }
  return null;
}

function isInsideBoard(rect, board) {
  return rect.x0 >= board.edgeMm - EPS
    && rect.y0 >= board.edgeMm - EPS
    && rect.x1 <= board.widthMm - board.edgeMm + EPS
    && rect.y1 <= board.heightMm - board.edgeMm + EPS;
}

/**
 * 约束布局求解。
 * @param {object} model board-model.mjs 产出的板级 IR
 * @param {object} [options]
 * @param {number} [options.gridMm=0.5] 候选网格步长（mm）
 * @param {number} [options.maxIterations=200000] 候选点评估次数上限
 * @param {number} [options.maxCandidatesPerPart=500] 单器件候选点上限
 * @param {number} [options.partGapMm=0.3] 器件间最小本体间距（对应规则包 SPACE-14 的吸嘴空间）
 * @param {number} [options.timeBudgetMs=5000] 时间预算（只影响 fail-closed）
 * @param {() => number} [options.now=() => Date.now()] 时钟注入（测试可给固定时钟）
 * @returns {{ok:boolean, placements:Array, rotation:object, unplaced:Array, findings:Array, stats:object, digest:string}}
 */
export function solvePlacement(model, options = {}) {
  const opts = {
    gridMm: 0.5,
    maxIterations: 200000,
    maxCandidatesPerPart: 500,
    partGapMm: 0.3,
    timeBudgetMs: 5000,
    now: () => Date.now(),
    ...(options ?? {}),
  };
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const startMs = now();
  const gridMm = Number(opts.gridMm) > 0 ? Number(opts.gridMm) : 0.5;
  const maxIterations = Math.max(1, Math.floor(finiteOr(Number(opts.maxIterations), 200000)));
  const maxCandidatesPerPart = Math.max(1, Math.floor(finiteOr(Number(opts.maxCandidatesPerPart), 500)));
  const partGapMm = Math.max(0, finiteOr(Number(opts.partGapMm), 0.3));
  const timeBudgetMs = Math.max(0, finiteOr(Number(opts.timeBudgetMs), 5000));
  const board = prepareBoard(model);
  const rotation = {
    policy: 'declared-only',
    allowRotations: false,
    note: 'rotationDeg 取自 IR（按 90° 归一化，90/270 交换宽高）；求解器不自由旋转器件，避免改变设计意图。',
  };

  const components = Array.isArray(model.components) ? model.components : [];
  const parts = [];
  const unplaced = [];
  const findings = [];

  for (const component of components) {
    const ref = String(component?.ref ?? '').trim().toUpperCase();
    if (!ref) continue;
    const sizeUnknown = component?.sizeUnknown === true
      || !(Number(component?.widthMm) > 0)
      || !(Number(component?.heightMm) > 0);
    if (sizeUnknown) {
      unplaced.push({ ref, code: PLACEMENT_CODES.SIZE_UNKNOWN, message: `器件 ${ref} 尺寸未知（sizeUnknown），跳过布局且不猜尺寸` });
      continue;
    }
    const part = buildPart(component, partGapMm);
    part.gridMm = gridMm;
    parts.push(part);
  }

  // 排序：fixed 优先（锚点必须先就位），其余按面积降序，最后位号字典序兜底 → 完全确定。
  const compareRef = (a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  parts.sort((a, b) => (Number(b.fixed) - Number(a.fixed)) || (b.areaMm2 - a.areaMm2) || compareRef(a, b));

  const placedRects = [];
  const assignment = new Map();

  // fixed 器件：保留声明坐标，违规只报告不移动。
  for (const part of parts) {
    if (!part.fixed) continue;
    const padRect = rectOf(part, part.declaredX, part.declaredY);
    const collisionRect = rectOf(part, part.declaredX, part.declaredY, true);
    if (!isInsideBoard(padRect, board)) {
      findings.push(finding(PLACEMENT_CODES.OUTSIDE_BOARD, `fixed 器件 ${part.ref} 的声明坐标 (${part.declaredX}, ${part.declaredY}) 越出板框/边距；求解器不移动 fixed 器件`, { ref: part.ref }));
    }
    for (const keepout of board.keepouts) {
      if (rectsOverlap(padRect, keepout)) {
        findings.push(finding(PLACEMENT_CODES.KEEPOUT, `fixed 器件 ${part.ref} 与禁止区 ${keepout.id} 相交；求解器不移动 fixed 器件`, { ref: part.ref, keepout: keepout.id }));
      }
    }
    for (const other of placedRects) {
      if (rectsOverlap(collisionRect, other)) {
        findings.push(finding(PLACEMENT_CODES.OVERLAP, `fixed 器件 ${part.ref} 与 fixed 器件 ${other.ref} 重叠（含 ${partGapMm}mm 制造间距）；求解器不移动 fixed 器件`, { ref: part.ref, otherRef: other.ref }));
      }
    }
    placedRects.push(collisionRect);
    assignment.set(part.ref, { xMm: part.declaredX, yMm: part.declaredY, rotationDeg: part.rotationDeg });
  }

  // 非 fixed 器件：先判断尺寸是否根本放不进板（几何不可能，不必搜索）。
  const searchParts = [];
  for (const part of parts) {
    if (part.fixed) continue;
    if (prepareCandidateSpace(part, board) === null) {
      unplaced.push({
        ref: part.ref,
        code: PLACEMENT_CODES.OUTSIDE_BOARD,
        message: `器件 ${part.ref} 的尺寸（含 courtyard/clearance）在 ${board.widthMm}×${board.heightMm}mm 板上放不下`,
      });
      continue;
    }
    searchParts.push(part);
  }

  let iterations = 0;
  let candidatesTried = 0;
  let backtracks = 0;
  let aborted = null;

  const overBudget = () => {
    if (iterations > maxIterations) {
      aborted = 'iterations';
      return true;
    }
    if (iterations === 1 || iterations % 256 === 0) {
      if (now() - startMs >= timeBudgetMs) {
        aborted = 'time';
        return true;
      }
    }
    return false;
  };

  const search = (index) => {
    if (index >= searchParts.length) return true;
    const part = searchParts[index];
    const candidates = orderedCandidates(part, placedRects, maxCandidatesPerPart);
    for (const candidate of candidates) {
      iterations += 1;
      candidatesTried += 1;
      if (overBudget()) return false;
      const padRect = rectOf(part, candidate.xMm, candidate.yMm);
      const collisionRect = rectOf(part, candidate.xMm, candidate.yMm, true);
      if (conflictCode(padRect, collisionRect, placedRects, board) !== null) continue;
      placedRects.push(collisionRect);
      assignment.set(part.ref, { xMm: candidate.xMm, yMm: candidate.yMm, rotationDeg: part.rotationDeg });
      if (search(index + 1)) return true;
      assignment.delete(part.ref);
      placedRects.pop();
      backtracks += 1;
      if (aborted) return false;
    }
    return false;
  };

  const searchSucceeded = search(0);

  const toPlacement = (ref) => {
    const assigned = assignment.get(ref);
    return { ref, xMm: assigned.xMm, yMm: assigned.yMm, rotationDeg: assigned.rotationDeg };
  };

  let placements = [];
  if (aborted) {
    // fail-closed：预算超限不返回任何放置结果。
    for (const part of searchParts) {
      unplaced.push({
        ref: part.ref,
        code: PLACEMENT_CODES.BUDGET_EXCEEDED,
        message: `布局在预算内未完成（${aborted === 'time' ? 'timeBudgetMs' : 'maxIterations'} 超限），fail-closed 不返回半成品`,
      });
    }
    findings.push(finding(PLACEMENT_CODES.BUDGET_EXCEEDED, `布局预算超限（${aborted}），未产出可用结果`, { reason: aborted }));
  } else if (!searchSucceeded) {
    // 候选空间内无完整解：同样不返回半成品。
    for (const part of searchParts) {
      unplaced.push({
        ref: part.ref,
        code: PLACEMENT_CODES.UNPLACED,
        message: `无法在满足边距/keepout/不重叠约束下放下器件 ${part.ref}`,
      });
    }
    findings.push(finding(PLACEMENT_CODES.UNPLACED, '布局在候选空间内找不到完整解（fail-closed，不返回半成品）'));
  } else {
    placements = searchParts.map((part) => toPlacement(part.ref));
    for (const part of parts) {
      if (part.fixed) placements.push(toPlacement(part.ref));
    }
    placements.sort(compareRef);
  }

  for (const item of unplaced) {
    findings.push(finding(item.code, item.message, { ref: item.ref }));
  }
  findings.sort((a, b) => String(a.code).localeCompare(String(b.code)) || String(a.ref ?? '').localeCompare(String(b.ref ?? '')));

  const budgetExceeded = Boolean(aborted);
  const ok = !budgetExceeded && unplaced.length === 0 && findings.every((item) => item.severity !== 'error');
  const payload = { ok, placements, unplaced, findings, rotation };
  const budgetReason = aborted === 'time' ? 'timeBudgetMs' : aborted === 'iterations' ? 'maxIterations' : null;
  const stats = {
    placed: placements.length,
    total: components.length,
    candidatesTried,
    backtracks,
    iterations,
    elapsedMs: Math.max(0, now() - startMs),
    budgetExceeded,
    budgetReason,
  };
  return { ok, placements, rotation, unplaced, findings, stats, digest: sha256(payload) };
}
