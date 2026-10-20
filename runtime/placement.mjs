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
export function planOutlinePlacement({ outline, components = [], keepouts = [], edgeClearanceMm = 1, spacingMm = 0.5, gridMm = 0.5, anchors = {}, affinity = null, maxCandidates = 20000 } = {}) {
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

  for (const component of order) {
    const anchor = anchors[component.ref] || null;
    // 已有伙伴时优先贴近伙伴（按亲和度加权），否则才按整板铺开
    const partners = affinity ? placed.filter((other) => affinity.pairWeight(component.ref, other.ref) > 0).map((other) => ({ xMm: other.xMm, yMm: other.yMm, w: affinity.pairWeight(component.ref, other.ref) })) : [];
    const candidates = [];
    for (let y = usable.minY; y <= usable.maxY + 1e-9; y += gridMm) {
      for (let x = usable.minX; x <= usable.maxX + 1e-9; x += gridMm) {
        candidates.push({ xMm: Number(x.toFixed(4)), yMm: Number(y.toFixed(4)) });
      }
    }
    if (!candidates.length) { unplaced.push({ ref: component.ref, reason: 'NO_CANDIDATE_GRID' }); continue; }
    if (candidates.length > maxCandidates) { unplaced.push({ ref: component.ref, reason: 'CANDIDATE_GRID_TOO_LARGE' }); continue; }
    const score = (candidate) => {
      const anchored = anchor ? scoreAnchor(candidate, anchor, component, usable) : 0;
      if (!partners.length) return anchored;
      // 加权到伙伴中心的距离：这就是"电气上该靠一起"的量化表达
      const weighted = partners.reduce((sum, partner) => sum + partner.w * Math.hypot(candidate.xMm - partner.xMm, candidate.yMm - partner.yMm), 0);
      const total = partners.reduce((sum, partner) => sum + partner.w, 0) || 1;
      return weighted / total + anchored;
    };
    candidates.sort((a, b) => score(a) - score(b) || a.yMm - b.yMm || a.xMm - b.xMm);

    let chosen = null;
    for (const candidate of candidates) {
      const probe = { ref: component.ref, xMm: candidate.xMm, yMm: candidate.yMm, widthMm: component.widthMm, heightMm: component.heightMm, rotationDeg: 0 };
      const corners = rectCorners(probe);
      if (!corners.every((corner) => pointInPolygon(corner, points) || distanceToOutline(corner, points) <= 1e-9)) continue; // 四角必须都在轮廓内
      if (!corners.every((corner) => distanceToOutline(corner, points) >= edgeClearanceMm - 1e-9)) continue;
      if (placed.some((other) => rectsOverlap(probe, other, spacingMm))) continue;
      if (keepouts.some((keepout) => rectRectsOverlap(probe, keepout))) continue;
      chosen = candidate;
      break;
    }
    if (!chosen) { unplaced.push({ ref: component.ref, reason: 'NO_FREE_SPACE' }); continue; }
    placed.push({ ref: component.ref, primitiveId: component.primitiveId, xMm: chosen.xMm, yMm: chosen.yMm, rotationDeg: 0, side: component.side || 'top', widthMm: component.widthMm, heightMm: component.heightMm, current: component.current || null, partnerCount: partners.length });
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
export function verifyOutlinePlacement({ placements = [], outline, keepouts = [], edgeClearanceMm = 1, spacingMm = 0, overhangAllowances = {}, marginalOverlapMm = 0.5 } = {}) {
  const findings = [];
  const points = outline?.points || [];
  if (!points.length) findings.push({ code: PLACEMENT_CODES.OUTLINE_EMPTY, severity: 'blocking', message: '没有板框多边形，无法校验布局' });
  for (const placement of placements) {
    const corners = rectCorners(placement);
    const outside = corners.filter((corner) => !pointInPolygon(corner, points) && distanceToOutline(corner, points) > 1e-9);
    if (outside.length) {
      const allowance = overhangAllowances[placement.ref];
      const overhangMm = Math.max(...outside.map((corner) => distanceToOutline(corner, points)));
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
    const margins = corners.map((corner) => distanceToOutline(corner, points));
    const minMargin = Math.min(...margins);
    if (minMargin < edgeClearanceMm - 1e-9) {
      findings.push({ code: PLACEMENT_CODES.TOO_CLOSE_TO_EDGE, severity: 'blocking', field: placement.ref, message: `${placement.ref} 距板边仅 ${round(minMargin, 3)}mm，小于要求的 ${edgeClearanceMm}mm` });
    }
    for (const keepout of keepouts) {
      if (rectRectsOverlap(placement, keepout)) findings.push({ code: PLACEMENT_CODES.IN_KEEPOUT, severity: 'blocking', field: placement.ref, message: `${placement.ref} 落在禁布/keepout 区域内` });
    }
    // 容差 1e-3mm（1 微米）：坐标是 mil 换算来的，真机上 (40,-36)mm 会算成 40.0000001，
    // 用 1e-6 会把"完全对齐"的器件误报成没对齐网格——复核器一旦误报就没人信了。
    if (Math.abs(placement.xMm - Math.round(placement.xMm / 0.5) * 0.5) > 1e-3 || Math.abs(placement.yMm - Math.round(placement.yMm / 0.5) * 0.5) > 1e-3) {
      findings.push({ code: PLACEMENT_CODES.OFF_GRID, severity: 'warning', field: placement.ref, message: `${placement.ref} 不在 0.5mm 网格上（贴装精度与后续微调都会更麻烦）` });
    }
  }
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      if (!rectsOverlap(placements[i], placements[j], spacingMm)) continue;
      const pair = `${placements[i].ref}/${placements[j].ref}`;
      // 三种量必须分开报，混在一起就会把"间距缺口"说成"重叠"：
      //   原始重叠 = 两个包围盒真实相交的深度（几何事实）
      //   间距缺口 = 还差多少才满足 spacingMm（我们的启发式要求，不是官方规则）
      const rawOverlap = Math.min(
        (placements[i].widthMm + placements[j].widthMm) / 2 - Math.abs(placements[i].xMm - placements[j].xMm),
        (placements[i].heightMm + placements[j].heightMm) / 2 - Math.abs(placements[i].yMm - placements[j].yMm),
      );
      const shortfall = Math.min(
        (placements[i].widthMm + placements[j].widthMm) / 2 + spacingMm - Math.abs(placements[i].xMm - placements[j].xMm),
        (placements[i].heightMm + placements[j].heightMm) / 2 + spacingMm - Math.abs(placements[i].yMm - placements[j].yMm),
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
