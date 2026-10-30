/**
 * 按板框轮廓做自动布局，并把"布局结果是否真的合规"验出来。
 *
 * 为什么要有这个模块：目标里的"按板框轮廓自动布局"以前只有矩形假设 + 手填尺寸，
 * 而真机板框是一个**多边形源码数组**（`[0,0,"L",2362.2047,0,...]`，单位 mil），
 * 器件尺寸也只有真机读回才有。所以这里的输入全部来自 `pcb.placement.read`。
 *
 * 三条不许含糊的规矩：
 *   1. 器件尺寸未知时**不许猜**：直接报 `PLACEMENT_SIZE_UNKNOWN` 并跳过，不按"大概 2mm"糊。
 *   2. 板框里出现没验证过的命令（ARC/CIRCLE/R/C/CARC）**不许当直线处理**：报
 *      `OUTLINE_COMMAND_UNSUPPORTED` 并阻断。真机板框只有 `L`，其余命令是没验证过的。
 *   3. 布局结果必须能被**独立复核**（`verifyOutlinePlacement` 不复用规划时的判定分支），
 *      否则"我算的"和"我验的"是同一份代码，等于没验。
 */

export const PLACEMENT_CODES = {
  OUTLINE_EMPTY: 'PLACEMENT_OUTLINE_EMPTY',
  OUTLINE_COMMAND_UNSUPPORTED: 'PLACEMENT_OUTLINE_COMMAND_UNSUPPORTED',
  OUTLINE_OPEN: 'PLACEMENT_OUTLINE_OPEN',
  SIZE_UNKNOWN: 'PLACEMENT_SIZE_UNKNOWN',
  UNPLACED: 'PLACEMENT_UNPLACED',
  OUTSIDE_OUTLINE: 'PLACEMENT_OUTSIDE_OUTLINE',
  TOO_CLOSE_TO_EDGE: 'PLACEMENT_TOO_CLOSE_TO_EDGE',
  OVERLAP: 'PLACEMENT_OVERLAP',
  IN_KEEPOUT: 'PLACEMENT_IN_KEEPOUT',
  OFF_GRID: 'PLACEMENT_OFF_GRID',
  NO_COMPONENTS: 'PLACEMENT_NO_COMPONENTS',
  OVERHANG_UNDECLARED: 'PLACEMENT_OVERHANG_UNDECLARED',
  OVERHANG_EXCEEDED: 'PLACEMENT_OVERHANG_EXCEEDED',
  BBOX_OVERLAP_MARGINAL: 'PLACEMENT_BBOX_OVERLAP_MARGINAL',
  SPACING_SHORTFALL: 'PLACEMENT_SPACING_SHORTFALL',
  /** R5：用户约定了功能分区区域，但器件在该区域内放不下（区域太小/被板框与间距挤掉）。 */
  REGION_UNSATISFIED: 'PLACEMENT_REGION_UNSATISFIED',
  /** R5：给了 region 但不是合法矩形——忽略并明确报告，不静默当成没约束。 */
  REGION_INVALID: 'PLACEMENT_REGION_INVALID',
  /**
   * 候选网格点超过 `maxCandidates` 时不再直接判布局失败，而是均匀抽样降精度；
   * 这是 warning（结果仍经独立复核），但必须如实告诉用户"用的不是原网格"。
   */
  CANDIDATE_GRID_COARSENED: 'PLACEMENT_CANDIDATE_GRID_COARSENED',
};

const MIL_TO_MM = 25.4 / 1000;
export const toMm = (value) => (Number.isFinite(Number(value)) ? Number(value) * MIL_TO_MM : null);
const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

/** 支持的命令：只有 `L`（真机唯一出现过的形态，已实测）。其余命令会显式报"未验证"。 */
const SUPPORTED_COMMANDS = new Set(['L']);

/**
 * 解析真机板框源码数组：`[startX, startY, "L", x1,y1, x2,y2, ...]`（单位 mil）。
 * 返回 mm 单位的多边形点列，并明确列出不支持的段命令。
 */
export function parsePolygonSource(source, { unit = 'mil' } = {}) {
  const scale = unit === 'mil' ? MIL_TO_MM : 1;
  if (!Array.isArray(source) || source.length < 2) {
    return { ok: false, code: PLACEMENT_CODES.OUTLINE_EMPTY, points: [], unsupported: [], closed: null, segments: 0 };
  }
  const startX = Number(source[0]);
  const startY = Number(source[1]);
  if (!Number.isFinite(startX) || !Number.isFinite(startY)) {
    return { ok: false, code: PLACEMENT_CODES.OUTLINE_EMPTY, points: [], unsupported: [], closed: null, segments: 0 };
  }
  const points = [{ x: startX * scale, y: startY * scale }];
  const unsupported = [];
  let index = 2;
  while (index < source.length) {
    const token = source[index];
    if (typeof token === 'number') { // 容错：缺少命令字时按 L 继续读
      points.push({ x: token * scale, y: Number(source[index + 1]) * scale });
      index += 2;
      continue;
    }
    if (!SUPPORTED_COMMANDS.has(token)) { unsupported.push(String(token)); break; }
    index += 1;
    while (index < source.length && typeof source[index] === 'number') {
      const x = Number(source[index]);
      const y = Number(source[index + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) break;
      points.push({ x: x * scale, y: y * scale });
      index += 2;
    }
  }
  const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const first = clean[0];
  const last = clean[clean.length - 1];
  const closed = clean.length > 2 && first && last && Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6;
  // 首尾重复点不参与几何计算，避免出现零长度边
  const ring = closed ? clean.slice(0, -1) : clean;
  return { ok: ring.length >= 3, code: ring.length >= 3 ? null : PLACEMENT_CODES.OUTLINE_EMPTY, points: ring, unsupported, closed, segments: ring.length };
}

export function polygonBounds(points = []) {
  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** 面积（鞋带公式，绝对值）；用于判断多边形方向与做面积对账。 */
export function polygonArea(points = []) {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

export function pointInPolygon(point, points = []) {
  if (!point || points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    const intersects = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-12) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distancePointToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** 点到多边形边界的最短距离（正数）。用于"离板边太近"的判定。 */
export function distanceToOutline(point, points = []) {
  if (points.length < 2) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const distance = distancePointToSegment(point, points[i], points[(i + 1) % points.length]);
    if (distance < best) best = distance;
  }
  return best;
}

const rectCorners = (placement) => {
  const halfWidth = placement.widthMm / 2;
  const halfHeight = placement.heightMm / 2;
  return [
    { x: placement.xMm - halfWidth, y: placement.yMm - halfHeight },
    { x: placement.xMm + halfWidth, y: placement.yMm - halfHeight },
    { x: placement.xMm + halfWidth, y: placement.yMm + halfHeight },
    { x: placement.xMm - halfWidth, y: placement.yMm + halfHeight },
  ];
};
const rectsOverlap = (a, b, gapMm) => {
  const ax = a.widthMm / 2 + gapMm; const ay = a.heightMm / 2 + gapMm;
  const bx = b.widthMm / 2; const by = b.heightMm / 2;
  return Math.abs(a.xMm - b.xMm) < ax + bx && Math.abs(a.yMm - b.yMm) < ay + by;
};

/**
 * 读回里的 `xMm/yMm` 是器件**原点**位置，而不是包围盒中心。
 * 几何判定（板边距/重叠）必须用包围盒中心：非对称封装（例如模组天线区、连接器本体）
 * 原点与中心差几毫米，用原点当中心会把"实际体块"算错位置——真机 U1 的差是 3.44mm。
 */
export function placementCenterMm(component) {
  const originX = Number(component?.xMm);
  const originY = Number(component?.yMm);
  const centerX = Number(component?.bboxMm?.centerXMm);
  const centerY = Number(component?.bboxMm?.centerYMm);
  return {
    xMm: Number.isFinite(centerX) ? centerX : originX,
    yMm: Number.isFinite(centerY) ? centerY : originY,
    originXMm: Number.isFinite(originX) ? originX : null,
    originYMm: Number.isFinite(originY) ? originY : null,
  };
}

/** 从 `pcb.placement.read` 的读回结果里取出"可规划"的器件（尺寸未知的单独列出，绝不猜）。 */
export function readComponentGeometry(readback) {
  const components = [];
  const unknown = [];
  for (const component of readback?.components || []) {
    const width = Number(component?.bboxMm?.xMm);
    const height = Number(component?.bboxMm?.yMm);
    const entry = {
      ref: component.designator || component.primitiveId,
      primitiveId: component.primitiveId,
      widthMm: Number.isFinite(width) ? width : null,
      heightMm: Number.isFinite(height) ? height : null,
      current: Number.isFinite(Number(component.xMm)) && Number.isFinite(Number(component.yMm)) ? { ...placementCenterMm(component), rotationDeg: Number(component.rotationDeg) || 0 } : null,
      side: component.layerSide || 'top',
      padCount: component.padCount ?? null,
      nets: Array.isArray(component.nets) ? component.nets.filter((net) => typeof net === 'string' && net.length) : [],
      netPadCount: component.netPads ?? null,
      rotateAllowed: component.rotateAllowed !== false,
    };
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) { unknown.push(entry); components.push(entry); continue; }
    components.push(entry);
  }
  return { components, unknown };
}

/**
 * 电气亲和度：两个器件共享的"小网络"权重更高。
 *
 * 为什么不能只数共享网络个数：GND 有 13 个引脚、几乎连到所有器件，只数个数会让
 * 整块板被 GND 拉成一团。所以按 `1/(网络引脚数-1)` 加权：只有两个引脚的网
 * （ALERT_N、USB_DP 的局部段等）权重最大，GND 权重最小。
 */
export function netAffinity(components = []) {
  const netMembers = new Map();
  for (const component of components) {
    for (const net of component.nets || []) {
      if (!netMembers.has(net)) netMembers.set(net, new Set());
      netMembers.get(net).add(component.ref);
    }
  }
  const pairs = new Map();
  const weightOf = new Map();
  for (const [, members] of netMembers) {
    if (members.size < 2) continue;
    const weight = 1 / (members.size - 1);
    const list = [...members].sort();
    for (let i = 0; i < list.length; i += 1) {
      weightOf.set(list[i], (weightOf.get(list[i]) || 0) + weight);
      for (let j = i + 1; j < list.length; j += 1) {
        const key = `${list[i]}|${list[j]}`;
        pairs.set(key, (pairs.get(key) || 0) + weight);
      }
    }
  }
  const pairWeight = (a, b) => pairs.get(a < b ? `${a}|${b}` : `${b}|${a}`) || 0;
  return { pairs, weightOf, pairWeight, netCount: netMembers.size };
}

/** 锚定打分：连接器贴边（到指定边的距离）+ 可选的"靠近某点"。 */
function scoreAnchor(candidate, anchor, component, usable) {
  const distanceToSide = (() => {
    switch (anchor.side) {
      case 'left': return Math.abs(candidate.xMm - (usable.minX + component.widthMm / 2));
      case 'right': return Math.abs(candidate.xMm - (usable.maxX - component.widthMm / 2));
      case 'top': return Math.abs(candidate.yMm - (usable.maxY - component.heightMm / 2));
      case 'bottom': return Math.abs(candidate.yMm - (usable.minY + component.heightMm / 2));
      default: return 0;
    }
  })();
  const distanceToTarget = Number.isFinite(anchor.nearX) && Number.isFinite(anchor.nearY)
    ? Math.hypot(candidate.xMm - anchor.nearX, candidate.yMm - anchor.nearY) : 0;
  return distanceToSide + distanceToTarget * (anchor.weightNear ?? 1);
}

/**
 * 贪心网格布局：先放"锚定器件"（连接器靠边），其余按**与已放器件的电气亲和度**依次落位，
 * 候选点按"到伙伴的加权距离 + 到锚定边的距离"打分。输入输出全部 mm；纯函数，可测。
 */
/**
 * 矩形是否完整落在板框内并留足 edgeClearanceMm。
 * 有采样场时按**矩形边采样**判（曲边切边也能拦住）；没有时退回四角判定（旧行为）。
 */
function rectFitsInsideOutline(rect, points, edgeClearanceMm, outlineField) {
  if (outlineField) {
    const samples = envelopePerimeterSamples(rect, Math.min(0.25, outlineField.cellMm));
    for (const sample of samples) {
      const cell = outlineField.at(sample.x, sample.y);
      if (!cell.inside) return false;
      if (cell.distance < edgeClearanceMm - 1e-6) return false;
    }
    return true;
  }
  const corners = rectCorners(rect);
  return corners.every((corner) => pointInPolygon(corner, points) || distanceToOutline(corner, points) <= 1e-9)
    && corners.every((corner) => distanceToOutline(corner, points) >= edgeClearanceMm - 1e-9);
}

/**
 * 每器件功能分区 region（R5）的归一化：`{xMinMm,yMinMm,xMaxMm,yMaxMm}`，全部 mm。
 * 非法（缺字段/非有限值/xMax≤xMin）返回 null —— 由调用方报 finding，**不静默忽略也不猜**。
 */
export function normalizeComponentRegionMm(region) {
  if (!region || typeof region !== 'object' || Array.isArray(region)) return null;
  const xMinMm = Number(region.xMinMm);
  const yMinMm = Number(region.yMinMm);
  const xMaxMm = Number(region.xMaxMm);
  const yMaxMm = Number(region.yMaxMm);
  if (![xMinMm, yMinMm, xMaxMm, yMaxMm].every(Number.isFinite)) return null;
  if (xMaxMm <= xMinMm || yMaxMm <= yMinMm) return null;
  return { xMinMm, yMinMm, xMaxMm, yMaxMm };
}

/** 某条轴上按 gridMm 递增的候选点数（与下方累加循环同口径；不实际生成数组）。 */
function gridPointCount(min, max, step) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0 || max < min - 1e-9) return 0;
  return Math.floor((max - min) / step + 1e-9) + 1;
}

/**
 * 生成候选网格点。`stride > 1` 时按 `gridMm × stride` 抽样，用于把超大候选集控制在上限内。
 * 坐标转换口径与旧实现完全一致（累加 + toFixed(4)），保证默认路径逐值不变。
 */
function candidateGrid({ minX, minY, maxX, maxY, gridMm, stride = 1 }) {
  const step = gridMm * Math.max(1, Math.floor(stride));
  const candidates = [];
  for (let y = minY; y <= maxY + 1e-9; y += step) {
    for (let x = minX; x <= maxX + 1e-9; x += step) {
      candidates.push({ xMm: Number(x.toFixed(4)), yMm: Number(y.toFixed(4)) });
    }
  }
  return candidates;
}

/** 把区域起点对齐到"可用板框网格"上的第一个点（区域约束是新增路径，对齐后再累加，避免半格漂移）。 */
function alignUpToGrid(origin, target, gridMm) {
  if (target <= origin + 1e-9) return origin;
  return origin + Math.ceil((target - origin) / gridMm - 1e-9) * gridMm;
}

/**
 * 候选上限与抽样倍率：候选数超过 maxCandidates 时不再直接判"网格过大、布局失败"，
 * 而是按 √(count/maxCandidates) 均匀抽样。大板（≥300×200mm、0.5mm 网格）以前会
 * 因为 240k 个候选点全部 unplaced；抽样后仍能给出可复核的布局结果（精度换可用性，
 * 并在 findings 里如实报 CANDIDATE_GRID_COARSENED，不假装还是原网格）。
 */
function candidateStride(count, maxCandidates) {
  const limit = Number.isFinite(Number(maxCandidates)) && Number(maxCandidates) > 0 ? Math.floor(Number(maxCandidates)) : 20000;
  return count > limit ? Math.max(2, Math.ceil(Math.sqrt(count / limit))) : 1;
}

export function planOutlinePlacement({ outline, components = [], keepouts = [], edgeClearanceMm = 1, spacingMm = 0.5, gridMm = 0.5, anchors = {}, affinity = null, maxCandidates = 20000, padEnvelopes = {}, outlineField = null, regions = {} } = {}) {
  const findings = [];
  if (outline?.code) findings.push({ code: outline.code, severity: 'blocking', message: outline.code === PLACEMENT_CODES.OUTLINE_EMPTY ? '板框为空或点数不足以构成多边形' : '板框不可用' });
  if (outline?.unsupported?.length) findings.push({ code: PLACEMENT_CODES.OUTLINE_COMMAND_UNSUPPORTED, severity: 'blocking', message: `板框里出现未验证的段命令 ${outline.unsupported.join('/')}（真机只验证过 "L"），不能按直线当矩形处理` });
  if (outline?.closed === false) findings.push({ code: PLACEMENT_CODES.OUTLINE_OPEN, severity: 'warning', message: '板框首尾未闭合，按隐式闭合处理' });
  const points = outline?.points || [];
  const bounds = polygonBounds(points);
  if (!points.length || !bounds) {
    return { ok: false, placements: [], unplaced: components.map((c) => ({ ref: c.ref, reason: 'NO_OUTLINE' })), findings, outline: null, stats: null };
  }

  const sized = components.filter((c) => Number.isFinite(c.widthMm) && Number.isFinite(c.heightMm) && c.widthMm > 0 && c.heightMm > 0);
  const unsized = components.filter((c) => !sized.includes(c));
  for (const component of unsized) findings.push({ code: PLACEMENT_CODES.SIZE_UNKNOWN, severity: 'blocking', field: component.ref, message: `${component.ref} 没有可用的封装包围盒尺寸，拒绝凭经验猜尺寸` });
  if (!sized.length) findings.push({ code: PLACEMENT_CODES.NO_COMPONENTS, severity: 'blocking', message: '没有任何带尺寸的器件可布局' });

  // 功能分区（R5）：region 既可挂在 component 上（componentRegions 合并后的形态），
  // 也可用 `regions: {位号: region}` 单独传；component.region 优先。默认都没有 → 行为与旧版完全一致。
  const regionByRef = new Map();
  for (const component of sized) {
    const rawRegion = component.region !== undefined && component.region !== null ? component.region : (regions?.[component.ref]);
    if (rawRegion === undefined || rawRegion === null) continue;
    const normalized = normalizeComponentRegionMm(rawRegion);
    if (normalized) regionByRef.set(component.ref, normalized);
    else findings.push({ code: PLACEMENT_CODES.REGION_INVALID, severity: 'warning', field: component.ref, message: `${component.ref} 的功能分区 region 不是 {xMinMm,yMinMm,xMaxMm,yMaxMm} 的有效矩形（需有限且 xMax>xMin、yMax>yMin），已忽略该区域约束` });
  }

  const usable = { minX: bounds.minX + edgeClearanceMm, minY: bounds.minY + edgeClearanceMm, maxX: bounds.maxX - edgeClearanceMm, maxY: bounds.maxY - edgeClearanceMm };
  const placed = [];
  const unplaced = unsized.map((component) => ({ ref: component.ref, reason: 'SIZE_UNKNOWN' }));

  // 落位顺序：有锚定要求的先放（连接器决定接口位置），其余按"与已放器件亲和度"贪心生长。
  const order = [...sized.filter((component) => anchors[component.ref]).sort((a, b) => b.widthMm * b.heightMm - a.widthMm * a.heightMm)];
  const pending = sized.filter((component) => !anchors[component.ref]);
  while (pending.length) {
    let bestIndex = 0; let bestScore = -Infinity;
    for (let index = 0; index < pending.length; index += 1) {
      const connect = placed.reduce((sum, other) => sum + (affinity ? affinity.pairWeight(pending[index].ref, other.ref) : 0), 0);
      const isolated = affinity ? (affinity.weightOf.get(pending[index].ref) || 0) : 0;
      const score = connect * 100 + isolated + (pending[index].widthMm * pending[index].heightMm) / 1000;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    order.push(pending.splice(bestIndex, 1)[0]);
  }

  // 无 region 的器件共用同一套整板候选点：基准数组只生成一次，逐器件 slice 后独立排序。
  let baseCandidates = null;
  for (const component of order) {
    const anchor = anchors[component.ref] || null;
    // 已有伙伴时优先贴近伙伴（按亲和度加权），否则才按整板铺开
    const partners = affinity ? placed.filter((other) => affinity.pairWeight(component.ref, other.ref) > 0).map((other) => ({ xMm: other.xMm, yMm: other.yMm, w: affinity.pairWeight(component.ref, other.ref) })) : [];
    const region = regionByRef.get(component.ref) || null;
    let candidates;
    if (region) {
      // 只在 region ∩ 可用板框内生成候选点：避免"先铺满整板、再逐点过滤"的浪费，
      // 也让大板上的小分区不再因为整板候选数超过 maxCandidates 而整块布局失败。
      const minX = Math.max(usable.minX, region.xMinMm);
      const minY = Math.max(usable.minY, region.yMinMm);
      const maxX = Math.min(usable.maxX, region.xMaxMm);
      const maxY = Math.min(usable.maxY, region.yMaxMm);
      if (maxX < minX - 1e-9 || maxY < minY - 1e-9) {
        unplaced.push({ ref: component.ref, reason: 'NO_SPACE_IN_REGION' });
        findings.push({
          code: PLACEMENT_CODES.REGION_UNSATISFIED, severity: 'blocking', field: component.ref,
          message: `${component.ref} 的候选网格点全部落在功能分区 region 之外（region x=${round(region.xMinMm, 3)}..${round(region.xMaxMm, 3)}mm, y=${round(region.yMinMm, 3)}..${round(region.yMaxMm, 3)}mm）——需要扩大 region 或把该器件移出这个块`,
        });
        continue;
      }
      const startX = alignUpToGrid(usable.minX, minX, gridMm);
      const startY = alignUpToGrid(usable.minY, minY, gridMm);
      const count = gridPointCount(startX, maxX, gridMm) * gridPointCount(startY, maxY, gridMm);
      const stride = candidateStride(count, maxCandidates);
      candidates = candidateGrid({ minX: startX, minY: startY, maxX, maxY, gridMm, stride });
      if (stride > 1) {
        findings.push({
          code: PLACEMENT_CODES.CANDIDATE_GRID_COARSENED, severity: 'warning', field: component.ref,
          message: `${component.ref} 的 region 在 ${gridMm}mm 网格上有 ${count} 个候选点，超过上限 ${maxCandidates}；已按 ${(gridMm * stride).toFixed(2)}mm 网格抽样（落位仍经独立复核，但精度下降）`,
        });
      }
    } else {
      if (!baseCandidates) {
        const count = gridPointCount(usable.minX, usable.maxX, gridMm) * gridPointCount(usable.minY, usable.maxY, gridMm);
        const stride = candidateStride(count, maxCandidates);
        baseCandidates = candidateGrid({ minX: usable.minX, minY: usable.minY, maxX: usable.maxX, maxY: usable.maxY, gridMm, stride });
        if (stride > 1) {
          findings.push({
            code: PLACEMENT_CODES.CANDIDATE_GRID_COARSENED, severity: 'warning',
            message: `整板候选点 ${count} 个超过上限 ${maxCandidates}，已按 ${(gridMm * stride).toFixed(2)}mm 网格抽样（落位仍经独立复核，但精度下降）`,
          });
        }
      }
      // 每个器件都要独立排序，故用 slice 保护共享基准数组（不复刻 240k 点 × N 次的生成开销）。
      candidates = baseCandidates.slice();
    }
    if (!candidates.length) {
      unplaced.push({ ref: component.ref, reason: region ? 'NO_SPACE_IN_REGION' : 'NO_CANDIDATE_GRID' });
      if (region) {
        findings.push({
          code: PLACEMENT_CODES.REGION_UNSATISFIED, severity: 'blocking', field: component.ref,
          message: `${component.ref} 的 region 在 ${gridMm}mm 网格上没有可用候选点（区域小于一个网格或与可用板框没有交集）——需要扩大 region`,
        });
      }
      continue;
    }
    const score = (candidate) => {
      const anchored = anchor ? scoreAnchor(candidate, anchor, component, usable) : 0;
      if (!partners.length) return anchored;
      // 加权到伙伴中心的距离：这就是"电气上该靠一起"的量化表达
      const weighted = partners.reduce((sum, partner) => sum + partner.w * Math.hypot(candidate.xMm - partner.xMm, candidate.yMm - partner.yMm), 0);
      const total = partners.reduce((sum, partner) => sum + partner.w, 0) || 1;
      return weighted / total + anchored;
    };
    // 每个候选只算一次分（Schwartzian transform）：旧实现让排序比较器反复算分，
    // 2 万点级别的候选集会因此多算一个数量级，是布局慢的主因。
    const scored = candidates.map((candidate) => ({ candidate, value: score(candidate) }));
    scored.sort((a, b) => a.value - b.value || a.candidate.yMm - b.candidate.yMm || a.candidate.xMm - b.candidate.xMm);

    let chosen = null;
    const padEnvelope = padEnvelopes[component.ref] || null;
    const rotationDeg = Number(component.current?.rotationDeg ?? component.rotationDeg ?? 0) || 0;
    const side = component.side === 'bottom' ? 'bottom' : 'top';
    for (const { candidate } of scored) {
      const probeBody = { ref: component.ref, xMm: candidate.xMm, yMm: candidate.yMm, widthMm: component.widthMm, heightMm: component.heightMm, rotationDeg, side, padEnvelope };
      // 占位一律用"本体 ∪ 焊盘包络"：焊盘伸出本体时，本体四角合规不代表焊盘不压板框（D-33-1）
      const probe = placementEnvelopeRect(probeBody);
      if (!rectFitsInsideOutline(probe, points, edgeClearanceMm, outlineField)) continue;
      // 上下层器件各自贴装，投影重叠不是碰撞；同面才比较间距。
      if (placed.some((other) => (other.side || 'top') === side && rectsOverlap(probe, placementEnvelopeRect(other), spacingMm))) continue;
      if (keepouts.some((keepout) => rectRectsOverlap(probe, keepout))) continue;
      chosen = candidate;
      break;
    }
    if (!chosen) {
      unplaced.push({ ref: component.ref, reason: 'NO_FREE_SPACE' });
      if (region) {
        findings.push({
          code: PLACEMENT_CODES.REGION_UNSATISFIED, severity: 'blocking', field: component.ref,
          message: `${component.ref} 在功能分区 region 内没有能同时满足板框/边距/间距/禁布的位置（region 太小或已被占满）——需要扩大 region 或调整块内成员`,
        });
      }
      continue;
    }
    placed.push({ ref: component.ref, primitiveId: component.primitiveId, xMm: chosen.xMm, yMm: chosen.yMm, rotationDeg, side, widthMm: component.widthMm, heightMm: component.heightMm, padEnvelope, current: component.current || null, partnerCount: partners.length, regionMm: region ? { ...region } : null });
  }

  const usableAreaMm2 = (usable.maxX - usable.minX) * (usable.maxY - usable.minY);
  const componentAreaMm2 = placed.reduce((sum, item) => sum + item.widthMm * item.heightMm, 0);
  return {
    ok: unplaced.length === 0 && !findings.some((finding) => finding.severity === 'blocking'),
    placements: placed,
    unplaced,
    findings,
    outline: { points, bounds, areaMm2: round(polygonArea(points), 3), closed: outline.closed },
    stats: {
      placedCount: placed.length, unplacedCount: unplaced.length, gridMm, edgeClearanceMm, spacingMm,
      utilization: usableAreaMm2 > 0 ? round(componentAreaMm2 / usableAreaMm2, 4) : null,
      /** 布局用到的网格与边距要跟着计划一起走，否则"计划"没法被复核 */
      usableBounds: { minXMm: round(usable.minX), minYMm: round(usable.minY), maxXMm: round(usable.maxX), maxYMm: round(usable.maxY) },
    },
  };
}

function rectRectsOverlap(a, b) {
  if (!a || !b) return false;
  const ax = a.widthMm ?? (a.x2 - a.x1); const ay = a.heightMm ?? (a.y2 - a.y1);
  const bx = b.widthMm ?? (b.x2 - b.x1); const by = b.heightMm ?? (b.y2 - b.y1);
  const acx = a.xMm ?? (a.x1 + ax / 2); const acy = a.yMm ?? (a.y1 + ay / 2);
  const bcx = b.xMm ?? (b.x1 + bx / 2); const bcy = b.yMm ?? (b.y1 + by / 2);
  return Math.abs(acx - bcx) < ax / 2 + bx / 2 && Math.abs(acy - bcy) < ay / 2 + by / 2;
}

/**
 * 独立复核：不复用规划时的分支，重新按"四角在轮廓内 / 离边距离 / 两两不重叠 / 不进禁布区"判一遍。
 * 真机上用它验证规划结果，也用它验证**已有布局**（找出当前板子哪里不合规）。
 */
/**
 * @param overhangAllowances 显式声明的"故意伸出板边"（如 USB-C 口必须伸出才能插线）：
 *   `{ J1: { maxOverhangMm: 3, reason: 'USB-C 插座需要伸出板边' } }`。
 *   没有声明就一律算越界——**故意伸出也必须写下来**，不能靠"大家都知道"静默放过；
 *   声明之外还要超限就继续阻断。
 * @param marginalOverlapMm 包围盒包含焊盘/本体，0.13mm 这种边缘接触**不足以判定实物碰撞**，
 *   只给警告并要求用真实封装轮廓复核；超过这个阈值才算阻断。
 */
const MM_PER_MIL = 0.0254;

/**
 * 板框采样场（D-33-1 深水区）。
 *
 * 只用"矩形四角"判板框会漏掉**圆弧/斜边从矩形边中间切进来**的情况：真机 U1 的本体底边贴着
 * 板框圆弧，四角都在板内、边中间却越出板框 17mil，于是规划/复核全部误判通过。
 * 这里把板框栅格化成"内/外 + 到边距离"场（默认 0.25mm 栅格），规划与复核按矩形**边采样**查表，
 * 既避免逐点算多边形距离的性能灾难，也把曲边切边这类问题量出来。
 */
export function buildOutlineField(outline, { cellMm = 0.25 } = {}) {
  const points = outline?.points || [];
  const bounds = polygonBounds(points);
  if (!bounds) return null;
  const margin = cellMm * 2;
  const minX = bounds.minX - margin;
  const minY = bounds.minY - margin;
  const nx = Math.ceil((bounds.maxX - bounds.minX + margin * 2) / cellMm) + 1;
  const ny = Math.ceil((bounds.maxY - bounds.minY + margin * 2) / cellMm) + 1;
  const inside = new Uint8Array(nx * ny);
  const distance = new Float32Array(nx * ny);
  for (let iy = 0; iy < ny; iy += 1) {
    const y = minY + iy * cellMm;
    for (let ix = 0; ix < nx; ix += 1) {
      const x = minX + ix * cellMm;
      const index = iy * nx + ix;
      const point = { x, y };
      inside[index] = pointInPolygon(point, points) ? 1 : 0;
      distance[index] = distanceToOutline(point, points);
    }
  }
  const at = (x, y) => {
    const ix = Math.round((x - minX) / cellMm);
    const iy = Math.round((y - minY) / cellMm);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return { inside: false, distance: 0 };
    const index = iy * nx + ix;
    return { inside: inside[index] === 1, distance: distance[index] };
  };
  return { at, cellMm, nx, ny, bounds };
}

/** 矩形边采样点（含四角），step 默认 0.25mm：用于板框曲边切边的判定。 */
export function envelopePerimeterSamples(rect, stepMm = 0.25) {
  const { xMm, yMm, widthMm, heightMm } = rect;
  if (!(widthMm > 0) || !(heightMm > 0)) return [];
  const halfW = widthMm / 2;
  const halfH = heightMm / 2;
  const xs = Math.max(1, Math.ceil(widthMm / stepMm));
  const ys = Math.max(1, Math.ceil(heightMm / stepMm));
  const samples = [];
  for (let i = 0; i <= xs; i += 1) {
    const x = xMm - halfW + (widthMm * i) / xs;
    samples.push({ x, y: yMm - halfH }, { x, y: yMm + halfH });
  }
  for (let i = 1; i < ys; i += 1) {
    const y = yMm - halfH + (heightMm * i) / ys;
    samples.push({ x: xMm - halfW, y }, { x: xMm + halfW, y });
  }
  return samples;
}


/**
 * 焊盘包络（D-33-1 的根因修复）。
 *
 * 布局规划/复核一直用**器件本体包围盒**当占位，但连接器/模组的焊盘常伸出本体；
 * 结果本体合规、焊盘越界（真机 U1 顶排 12 个焊盘压/越板框，EDA DRC ≥11.8mil 全不满足）。
 * 这里从 PCB 铜皮读回（pads，单位 mil）按位号汇总出"相对包围盒中心的焊盘包络"，
 * 供规划与复核把焊盘也算进去：padEnvelope = { widthMm, heightMm, offsetXMm, offsetYMm }。
 */
export function buildPadEnvelopes(pads = [], components = []) {
  const byRef = new Map();
  const componentByRef = new Map();
  for (const component of components) {
    if (!component?.ref) continue;
    componentByRef.set(component.ref, component);
    const centerX = Number(component.current?.xMm);
    const centerY = Number(component.current?.yMm);
    byRef.set(component.ref, { centerX, centerY, min: null });
  }
  for (const pad of pads) {
    const ref = pad.designator;
    const entry = byRef.get(ref);
    if (!entry) continue;
    const centerX = Number(pad.x) * MM_PER_MIL;
    const centerY = Number(pad.y) * MM_PER_MIL;
    const [shape, widthMil, heightMil] = Array.isArray(pad.shape) ? pad.shape : [null, null, null];
    const w = Number(widthMil) || Number(pad.radius) * 2 || 0;
    const h = Number(heightMil) || Number(pad.radius) * 2 || 0;
    if (!(w > 0) || !(h > 0) || !Number.isFinite(centerX) || !Number.isFinite(centerY)) continue;
    const dx = centerX - entry.centerX;
    const dy = centerY - entry.centerY;
    const halfW = (w * MM_PER_MIL) / 2;
    const halfH = (h * MM_PER_MIL) / 2;
    const box = { minX: dx - halfW, maxX: dx + halfW, minY: dy - halfH, maxY: dy + halfH };
    if (!entry.min) entry.min = box;
    else entry.min = { minX: Math.min(entry.min.minX, box.minX), maxX: Math.max(entry.min.maxX, box.maxX), minY: Math.min(entry.min.minY, box.minY), maxY: Math.max(entry.min.maxY, box.maxY) };
  }
  const envelopes = {};
  for (const [ref, entry] of byRef.entries()) {
    // 占位必须是"本体 ∪ 焊盘"：焊盘全部在本体内时（U1 的焊盘就是收在本体里的），
    // 只算焊盘包络会反过来把占位缩小 → 规划出来器件本体互相重叠（真机审计 SPACE-02 84 处）。
    const component = componentByRef.get(ref);
    const bodyHalfW = Number(component?.widthMm) > 0 ? Number(component.widthMm) / 2 : 0;
    const bodyHalfH = Number(component?.heightMm) > 0 ? Number(component.heightMm) / 2 : 0;
    const minBox = entry.min || { minX: -bodyHalfW, maxX: bodyHalfW, minY: -bodyHalfH, maxY: bodyHalfH };
    entry.min = {
      minX: Math.min(minBox.minX, -bodyHalfW),
      maxX: Math.max(minBox.maxX, bodyHalfW),
      minY: Math.min(minBox.minY, -bodyHalfH),
      maxY: Math.max(minBox.maxY, bodyHalfH),
    };
    envelopes[ref] = {
      widthMm: Number((entry.min.maxX - entry.min.minX).toFixed(4)),
      heightMm: Number((entry.min.maxY - entry.min.minY).toFixed(4)),
      offsetXMm: Number(((entry.min.minX + entry.min.maxX) / 2).toFixed(4)),
      offsetYMm: Number(((entry.min.minY + entry.min.maxY) / 2).toFixed(4)),
    };
  }
  return envelopes;
}

/** 占位矩形：有焊盘包络时取包络（中心带偏移），否则退回本体包围盒。 */
export function placementEnvelopeRect(placement = {}) {
  const envelope = placement.padEnvelope;
  if (envelope && Number(envelope.widthMm) > 0 && Number(envelope.heightMm) > 0) {
    return {
      xMm: Number(placement.xMm) + (Number(envelope.offsetXMm) || 0),
      yMm: Number(placement.yMm) + (Number(envelope.offsetYMm) || 0),
      widthMm: Number(envelope.widthMm),
      heightMm: Number(envelope.heightMm),
    };
  }
  return { xMm: Number(placement.xMm), yMm: Number(placement.yMm), widthMm: Number(placement.widthMm), heightMm: Number(placement.heightMm) };
}


/**
 * 焊盘级板框间距校验（D-33-1）。
 *
 * 为什么需要：布局规划/复核用的是**器件本体包围盒**做板边距判定，但连接器的焊盘经常伸出本体。
 * 真机结果：U1 本体包围盒离板框合规，可它顶排 4 个焊盘与板框间距 0mil（EDA DRC：应 ≥11.8mil），
 * 直接导致 TOUCH 等网络无法合法布线，而且布局 plan/apply 全都报"通过"。
 *
 * 入参焊盘来自 `pcb.copper.read`（单位 mil，shape=RECT/OVAL/CIRCLE + 宽高），板框点来自
 * `parsePolygonSource`（单位 mm）。这里把焊盘换算成 mm，用矩形采样点到板框的最小距离判定，
 * 同时检查焊盘是否落在板框外（那属于更严重的越界）。
 */
export function checkPadOutlineClearance({ pads = [], outline, clearanceMil = 11.8 } = {}) {
  const points = (outline?.points || []).map((point) => ({ x: Number(point.x), y: Number(point.y) })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const clearanceMm = Number(clearanceMil) * MM_PER_MIL;
  if (points.length < 3) return { ok: false, checked: 0, clearanceMil, findings: [{ code: PLACEMENT_CODES.OUTLINE_EMPTY, severity: 'blocking', message: '没有板框多边形，无法校验焊盘-板框间距' }], violations: [] };
  const violations = [];
  let checked = 0;
  for (const pad of pads) {
    const [shape, widthMil, heightMil] = Array.isArray(pad.shape) ? pad.shape : [null, null, null];
    const w = Number(widthMil) || (Number(pad.radius) * 2) || 0;
    const h = Number(heightMil) || (Number(pad.radius) * 2) || 0;
    const cx = Number(pad.x) * MM_PER_MIL;
    const cy = Number(pad.y) * MM_PER_MIL;
    if (!(w > 0) || !(h > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    checked += 1;
    const halfW = w / 2 * MM_PER_MIL;
    const halfH = h / 2 * MM_PER_MIL;
    let min = Number.POSITIVE_INFINITY;
    let outsideCount = 0;
    const steps = 8;
    for (let u = 0; u <= steps; u += 1) {
      for (let v = 0; v <= steps; v += 1) {
        const point = { x: cx - halfW + (2 * halfW * u) / steps, y: cy - halfH + (2 * halfH * v) / steps };
        if (!pointInPolygon(point, points)) outsideCount += 1;
        const distance = distanceToOutline(point, points);
        if (distance < min) min = distance;
      }
    }
    const padOutside = outsideCount > 0;
    if (padOutside || min < clearanceMm - 1e-6) {
      violations.push({
        designator: pad.designator || null,
        pad: pad.pad ?? null,
        net: pad.net || null,
        distanceMm: Number(min.toFixed(4)),
        distanceMil: Number((min / MM_PER_MIL).toFixed(2)),
        outside: padOutside,
        centerMil: { x: Number(pad.x), y: Number(pad.y) },
        shape: shape || null,
        widthMil: w, heightMil: h,
      });
    }
  }
  violations.sort((a, b) => a.distanceMil - b.distanceMil);
  const findings = violations.slice(0, 50).map((item) => ({
    code: 'PLACEMENT_PAD_OUTLINE_CLEARANCE',
    severity: 'blocking',
    field: item.designator ? `${item.designator}.${item.pad}` : 'pad',
    message: `${item.designator || '?'}.${item.pad ?? '?'}（${item.net || '无网络'}）焊盘到板框 ${item.distanceMil}mil < ${clearanceMil}mil（${item.outside ? '焊盘已越出板框' : '间距不足'}）——布局本体包围盒合规不代表焊盘合规，必须调整位置或声明豁免`,
  }));
  return { ok: violations.length === 0, checked, clearanceMil, violationCount: violations.length, violations: violations.slice(0, 50), findings };
}

export function verifyOutlinePlacement({ placements = [], outline, keepouts = [], edgeClearanceMm = 1, spacingMm = 0, overhangAllowances = {}, marginalOverlapMm = 0.5, outlineField = null, regions = {} } = {}) {
  const findings = [];
  const points = outline?.points || [];
  if (!points.length) findings.push({ code: PLACEMENT_CODES.OUTLINE_EMPTY, severity: 'blocking', message: '没有板框多边形，无法校验布局' });
  for (const placement of placements) {
    // R5 独立复核：区域约束不能只在规划器里判，否则"我算的"和"我验的"又是同一份代码。
    // 优先级：placement.regionMm（规划结果自带）→ 调用方传入的 regions。
    const region = normalizeComponentRegionMm(placement.regionMm) || normalizeComponentRegionMm(regions?.[placement.ref]);
    if (region && !(placement.xMm >= region.xMinMm - 1e-9 && placement.xMm <= region.xMaxMm + 1e-9
      && placement.yMm >= region.yMinMm - 1e-9 && placement.yMm <= region.yMaxMm + 1e-9)) {
      findings.push({ code: PLACEMENT_CODES.REGION_UNSATISFIED, severity: 'blocking', field: placement.ref, message: `${placement.ref} 的中心 (${round(placement.xMm, 3)}, ${round(placement.yMm, 3)})mm 不在约定 region x=${round(region.xMinMm, 3)}..${round(region.xMaxMm, 3)} / y=${round(region.yMinMm, 3)}..${round(region.yMaxMm, 3)}mm 内` });
    }
    // 焊盘包络优先（D-33-1）：本体合规 ≠ 焊盘合规
    const effective = placementEnvelopeRect(placement);
    // 有采样场时按矩形边采样（曲边从边中间切进来也能发现）；没有时退回四角
    const corners = outlineField ? envelopePerimeterSamples(effective, Math.min(0.25, outlineField.cellMm)) : rectCorners(effective);
    const outside = corners.filter((corner) => (outlineField ? !outlineField.at(corner.x, corner.y).inside : (!pointInPolygon(corner, points) && distanceToOutline(corner, points) > 1e-9)));
    if (outside.length) {
      const allowance = overhangAllowances[placement.ref];
      const overhangMm = Math.max(...outside.map((corner) => (outlineField ? Math.max(0, outlineField.at(corner.x, corner.y).distance) : distanceToOutline(corner, points))));
      // 「显式声明」必须包含**写清楚的理由**（≥8 字）：只有额度没有理由等于悄悄放行，
      // 与"声明"的本意相反（第 57 轮加固）。理由缺失时按"未声明"处理，照样阻断。
      const allowanceReason = String(allowance?.reason || '').trim();
      if (!allowance || allowanceReason.length < 8) {
        findings.push({ code: PLACEMENT_CODES.OUTSIDE_OUTLINE, severity: 'blocking', field: placement.ref, message: `${placement.ref} 有 ${outside.length} 个角落在板框外（最大伸出 ${round(overhangMm, 3)}mm）——若是连接器故意伸出，必须显式声明 overhangAllowances 并写清理由（≥8 字${allowance ? '，当前理由缺失或过短' : ''}）` });
        continue;
      }
      if (overhangMm > Number(allowance.maxOverhangMm || 0) + 1e-9) {
        findings.push({ code: PLACEMENT_CODES.OVERHANG_EXCEEDED, severity: 'blocking', field: placement.ref, message: `${placement.ref} 伸出板边 ${round(overhangMm, 3)}mm，超过已声明的 ${allowance.maxOverhangMm}mm 上限（声明理由：${allowance.reason || '(未写)'}）` });
        continue;
      }
      findings.push({ code: PLACEMENT_CODES.OVERHANG_UNDECLARED, severity: 'info', field: placement.ref, message: `${placement.ref} 按声明伸出板边 ${round(overhangMm, 3)}mm（≤${allowance.maxOverhangMm}mm）：${allowance.reason || '(未写理由)'}` });
      continue;
    }
    const margins = corners.map((corner) => (outlineField ? outlineField.at(corner.x, corner.y).distance : distanceToOutline(corner, points)));
    const minMargin = Math.min(...margins);
    if (minMargin < edgeClearanceMm - 1e-9) {
      findings.push({ code: PLACEMENT_CODES.TOO_CLOSE_TO_EDGE, severity: 'blocking', field: placement.ref, message: `${placement.ref} 距板边仅 ${round(minMargin, 3)}mm，小于要求的 ${edgeClearanceMm}mm` });
    }
    for (const keepout of keepouts) {
      if (rectRectsOverlap(effective, keepout)) findings.push({ code: PLACEMENT_CODES.IN_KEEPOUT, severity: 'blocking', field: placement.ref, message: `${placement.ref} 落在禁布/keepout 区域内` });
    }
    // 容差 1e-3mm（1 微米）：坐标是 mil 换算来的，真机上 (40,-36)mm 会算成 40.0000001，
    // 用 1e-6 会把"完全对齐"的器件误报成没对齐网格——复核器一旦误报就没人信了。
    if (Math.abs(placement.xMm - Math.round(placement.xMm / 0.5) * 0.5) > 1e-3 || Math.abs(placement.yMm - Math.round(placement.yMm / 0.5) * 0.5) > 1e-3) {
      findings.push({ code: PLACEMENT_CODES.OFF_GRID, severity: 'warning', field: placement.ref, message: `${placement.ref} 不在 0.5mm 网格上（贴装精度与后续微调都会更麻烦）` });
    }
  }
  const effective = placements.map((placement) => ({ ...placementEnvelopeRect(placement), ref: placement.ref, side: placement.side || 'top' }));
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      // 双面贴装：正反面的器件互不干涉（D-62）。旧实现不分面，于是"ESP32 放底层"永远被
      // 顶层器件判成重叠——双面板在这条规则下根本无法通过复核，属于把"面"当成"位置"的缺陷。
      if ((effective[i].side || 'top') !== (effective[j].side || 'top')) continue;
      if (!rectsOverlap(effective[i], effective[j], spacingMm)) continue;
      const pair = `${placements[i].ref}/${placements[j].ref}`;
      // 三种量必须分开报，混在一起就会把"间距缺口"说成"重叠"：
      //   原始重叠 = 两个包围盒真实相交的深度（几何事实）
      //   间距缺口 = 还差多少才满足 spacingMm（我们的启发式要求，不是官方规则）
      const rawOverlap = Math.min(
        (effective[i].widthMm + effective[j].widthMm) / 2 - Math.abs(effective[i].xMm - effective[j].xMm),
        (effective[i].heightMm + effective[j].heightMm) / 2 - Math.abs(effective[i].yMm - effective[j].yMm),
      );
      const shortfall = Math.min(
        (effective[i].widthMm + effective[j].widthMm) / 2 + spacingMm - Math.abs(effective[i].xMm - effective[j].xMm),
        (effective[i].heightMm + effective[j].heightMm) / 2 + spacingMm - Math.abs(effective[i].yMm - effective[j].yMm),
      );
      if (rawOverlap > marginalOverlapMm) {
        findings.push({ code: PLACEMENT_CODES.OVERLAP, severity: 'blocking', field: pair, message: `${placements[i].ref} 与 ${placements[j].ref} 的包围盒真实重叠 ${round(rawOverlap, 3)}mm（超过 ${marginalOverlapMm}mm 判定阈值）` });
      } else if (rawOverlap > 1e-9) {
        findings.push({ code: PLACEMENT_CODES.BBOX_OVERLAP_MARGINAL, severity: 'warning', field: pair, message: `${placements[i].ref} 与 ${placements[j].ref} 的包围盒真实重叠仅 ${round(rawOverlap, 3)}mm，同时离 ${spacingMm}mm 间距要求还差 ${round(shortfall, 3)}mm——包围盒含焊盘/本体，这点接触**不足以判定实物碰撞**，需用真实封装轮廓(courtyard)复核` });
      } else {
        findings.push({ code: PLACEMENT_CODES.SPACING_SHORTFALL, severity: 'info', field: pair, message: `${placements[i].ref} 与 ${placements[j].ref} 未重叠，但离自行设定的 ${spacingMm}mm 间距目标差 ${round(shortfall, 3)}mm（该目标是启发式，不是官方规则）` });
      }
    }
  }
  const blocking = findings.filter((finding) => finding.severity === 'blocking').length;
  return { ok: blocking === 0, blockingCount: blocking, findings, checkedCount: placements.length };
}

/** 计划 vs 现状：用户微调要看到"改了什么"，写入前的 diff 就是这份数据。 */
export function diffPlacement(current = [], planned = []) {
  const byRef = new Map(current.map((item) => [item.ref, item]));
  const rows = [];
  for (const target of planned) {
    const now = byRef.get(target.ref);
    if (!now) { rows.push({ ref: target.ref, status: 'new', to: { xMm: round(target.xMm), yMm: round(target.yMm), rotationDeg: target.rotationDeg } }); continue; }
    const deltaXMm = round(target.xMm - now.xMm, 3);
    const deltaYMm = round(target.yMm - now.yMm, 3);
    const deltaRotationDeg = round((target.rotationDeg || 0) - (now.rotationDeg || 0), 3);
    const unchanged = Math.abs(deltaXMm) < 1e-6 && Math.abs(deltaYMm) < 1e-6 && Math.abs(deltaRotationDeg) < 1e-6;
    rows.push({ ref: target.ref, status: unchanged ? 'unchanged' : 'moved', from: { xMm: round(now.xMm), yMm: round(now.yMm), rotationDeg: now.rotationDeg || 0 }, to: { xMm: round(target.xMm), yMm: round(target.yMm), rotationDeg: target.rotationDeg || 0 }, deltaXMm, deltaYMm, deltaRotationDeg, distanceMm: round(Math.hypot(deltaXMm, deltaYMm), 3) });
  }
  return { rows, movedCount: rows.filter((row) => row.status === 'moved').length, newCount: rows.filter((row) => row.status === 'new').length, unchangedCount: rows.filter((row) => row.status === 'unchanged').length };
}
