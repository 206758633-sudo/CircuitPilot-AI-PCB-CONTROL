/**
 * 合规布线（routing repair）——把"AI 自己布线"做成产品能力，而不是脚本外挂。
 *
 * 设计要点（每一条都是真机踩出来的）：
 * 1. 输入必须是**同一时刻的一致快照**（pcb.copper.read），逐条命令去读会读到互相错位的状态。
 * 2. 线宽/间距按 mil 计（EDA 内部单位就是 mil）；同层间距、过孔通孔跨层，判定必须分开。
 * 3. 细间距器件（0.4mm 间距）的**内圈焊盘无法从焊盘之间穿出**（0.15mm 空隙 < 0.152mm 规则），
 *    这时唯一可制造的出路是**盘中孔**（焊盘中心打过孔换层）。所以布线器必须同时支持
 *    "顶层直接逃逸"和"盘中孔逃逸"两种扇出，并如实标注用了哪一种。
 * 4. 写入必须**先复核后落盘**：几何复核不通过就回滚，绝不把不合规的铜留在板上。
 */

export const ROUTING_DEFAULTS = Object.freeze({
  clearanceMil: 6,
  widthMil: 8,
  // 普通换层过孔采用板上既有规格 0.6mm/0.3mm（24/12 mil），符合 EDA 的 viaSize 规则；
  // 盘中孔只能 0.2mm/0.1mm（8/4 mil）——0.25mm 焊盘里塞不下更大的孔，这是细间距器件的物理事实，必须工艺豁免。
  viaOuterDiameterMil: 24,
  viaHoleMil: 12,
  viaInPadOuterDiameterMil: 8,
  viaInPadHoleMil: 4,
  // 盘中孔的焊盘间距判据（真机实测校准，第 34 轮）：EDA 官方 DRC 对"盘中孔 vs 相邻焊盘"
  // 并不按 0.2mm/8mil 外的通用间距算——实测 0.5mm 间距器件里 8/4mil 盘中孔到相邻焊盘 9.8mil
  // 完全无违规。若继续用 clearanceMil(12) 复核，会把大量合法盘中孔方案判死（BAT_ADC 11.55mil 被拒）。
  // 这里显式降到 6mil（0.15mm，细间距工艺的常规孔到铜间距），并保留 EDA 真机 DRC 作为最终裁判。
  viaInPadPadClearanceMil: 6,
  throughHoleLayer: 12,
  gridMil: 4,
  viaCost: 40,
  writeSpacingMs: 15,
  readbackAttempts: 15,
  readbackSettleMs: 300,
  turnPenalty: 3,
  innerLayer: 17,
  maxExpansions: 3_000_000,
  contactTolMil: 1,
  maxConnections: 24,
});

/** 桥的 pcb.save 可能返回 true，也可能返回 { result: true } / { result: { saved: true } }；三种都必须认。 */
const saveConfirmed = (value) => {
  const unwrapped = value && typeof value === 'object' && 'result' in value ? value.result : value;
  return unwrapped === true || unwrapped?.saved === true;
};

const num = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

export function normalizeGeometry(input) {
  const lines = (Array.isArray(input?.lines) ? input.lines : []).map((line) => ({
    id: String(line.id ?? ''), net: String(line.net ?? '').trim(), layer: num(line.layer),
    x1: num(line.x1), y1: num(line.y1), x2: num(line.x2), y2: num(line.y2), width: num(line.width) || 10,
    // 圆弧元数据必须原样带下来：量长度时要按圆弧近似（并把"这是近似值"写进 metadata），
    // 丢掉 radius/bulge 就会把一段圆弧当成弦长，长度直接算错。
    radius: num(line.radius), bulge: num(line.bulge), curvature: num(line.curvature),
    replaceable: line.replaceable !== false,
  }));
  const vias = (Array.isArray(input?.vias) ? input.vias : []).map((via) => ({
    id: String(via.id ?? ''), net: String(via.net ?? '').trim(), x: num(via.x), y: num(via.y),
    outerDiameter: num(via.outerDiameter) || ROUTING_DEFAULTS.viaOuterDiameterMil,
    hole: num(via.hole) || ROUTING_DEFAULTS.viaHoleMil,
  }));
  const pads = (Array.isArray(input?.pads) ? input.pads : []).map((pad) => {
    const layer = num(pad.layer);
    const holes = num(pad.holes);
    return {
      designator: String(pad.designator ?? ''), pad: String(pad.pad ?? ''), net: String(pad.net ?? '').trim(),
      layer, x: num(pad.x), y: num(pad.y), radius: num(pad.radius) || 5,
      // 间距校验/障碍建模用"外接圆半径"（矩形焊盘半对角线），连通性接触判定仍用内切半径。
      // 真机 D-31-5：内切半径把矩形焊盘算小 → 斜穿角落的走线规划认为合规、真机 DRC 报 SMD Pad to Track。
      clearanceRadius: Math.max(num(pad.clearanceRadius) || num(pad.radius) || 5, num(pad.radius) || 5),
      shape: Array.isArray(pad.shape) ? pad.shape.slice(0, 6) : null,
      holes, holeDiameter: num(pad.holeDiameter),
      // 层 12 = 多层/通孔：这类焊盘在内层同样占位，必须按"所有层"处理，否则内层走线会横穿它们
      throughHole: pad.throughHole === true || layer === ROUTING_DEFAULTS.throughHoleLayer || holes > 0,
    };
  });
  return { lines, vias, pads };
}

/** 点到线段的距离（mil）。 */
export function pointSegmentDistance(px, py, segment) {
  const vx = segment.x2 - segment.x1;
  const vy = segment.y2 - segment.y1;
  const lengthSquared = vx * vx + vy * vy;
  if (!lengthSquared) return Math.hypot(px - segment.x1, py - segment.y1);
  let t = ((px - segment.x1) * vx + (py - segment.y1) * vy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - segment.x1 - t * vx, py - segment.y1 - t * vy);
}

function segmentsIntersect(a, b) {
  const cross = (ox, oy, ax, ay, bx, by) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
  const d1 = cross(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const d2 = cross(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  const d3 = cross(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const d4 = cross(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 线段到线段的距离（mil）：相交即 0，否则取四个端点到对方线段距离的最小值。 */
export function segmentSegmentDistance(a, b) {
  if (segmentsIntersect(a, b)) return 0;
  return Math.min(
    pointSegmentDistance(a.x1, a.y1, b), pointSegmentDistance(a.x2, a.y2, b),
    pointSegmentDistance(b.x1, b.y1, a), pointSegmentDistance(b.x2, b.y2, a),
  );
}

/**
 * 按网络做电气连通性分析：焊盘/走线/过孔在满足"接触容差"时视为同一导体。
 * 返回每个有网对象的所属岛，用于回答"这块板到底哪里真的断着"。
 */
export function analyzeNetConnectivity(geometryInput, { contactTolMil = ROUTING_DEFAULTS.contactTolMil } = {}) {
  const geometry = normalizeGeometry(geometryInput);
  const items = [];
  geometry.pads.forEach((pad) => { if (pad.net) items.push({ kind: 'pad', net: pad.net, ref: pad, layer: pad.layer }); });
  geometry.lines.forEach((line) => { if (line.net) items.push({ kind: 'line', net: line.net, ref: line, layer: line.layer }); });
  geometry.vias.forEach((via) => { if (via.net) items.push({ kind: 'via', net: via.net, ref: via, layer: null }); });

  const contact = (a, b) => {
    // 通孔焊盘（THT/连接器）在**所有铜层**都导电：内层走线接到它也算连通。
    // 真机第 33 轮：这里只看 pad.layer==12，会把这些焊盘判成永远孤立（内层布线复核永远"未连通"）。
    if (a.kind === 'pad' && b.kind === 'line') return (a.ref.throughHole === true || a.layer === b.layer) && pointSegmentDistance(a.ref.x, a.ref.y, b.ref) <= b.ref.width / 2 + contactTolMil;
    if (a.kind === 'line' && b.kind === 'pad') return contact(b, a);
    if (a.kind === 'pad' && b.kind === 'via') return Math.hypot(a.ref.x - b.ref.x, a.ref.y - b.ref.y) <= b.ref.outerDiameter / 2 + contactTolMil;
    if (a.kind === 'via' && b.kind === 'pad') return contact(b, a);
    if (a.kind === 'line' && b.kind === 'line') return a.layer === b.layer && segmentSegmentDistance(a.ref, b.ref) <= Math.max(a.ref.width, b.ref.width) / 2 + contactTolMil;
    if (a.kind === 'line' && b.kind === 'via') return pointSegmentDistance(b.ref.x, b.ref.y, a.ref) <= b.ref.outerDiameter / 2 + contactTolMil;
    if (a.kind === 'via' && b.kind === 'line') return contact(b, a);
    if (a.kind === 'via' && b.kind === 'via') return Math.hypot(a.ref.x - b.ref.x, a.ref.y - b.ref.y) <= Math.max(a.ref.outerDiameter, b.ref.outerDiameter) / 2 + contactTolMil;
    return false;
  };

  const byNet = new Map();
  items.forEach((item, index) => {
    if (!byNet.has(item.net)) byNet.set(item.net, []);
    byNet.get(item.net).push(index);
  });

  const nets = [];
  for (const [net, indices] of byNet.entries()) {
    const parent = new Map(indices.map((index) => [index, index]));
    const find = (index) => { let current = index; while (parent.get(current) !== current) current = parent.get(current); return current; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    for (let i = 0; i < indices.length; i += 1) {
      for (let j = i + 1; j < indices.length; j += 1) {
        if (contact(items[indices[i]], items[indices[j]])) union(indices[i], indices[j]);
      }
    }
    const groups = new Map();
    indices.forEach((index) => {
      const root = find(index);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(items[index]);
    });
    const islands = [...groups.values()].map((group) => ({
      items: group,
      pads: group.filter((entry) => entry.kind === 'pad').map((entry) => entry.ref),
    }));
    nets.push({ net, islands, connected: islands.length <= 1, itemCount: indices.length });
  }
  nets.sort((a, b) => (a.connected === b.connected ? b.itemCount - a.itemCount : Number(a.connected) - Number(b.connected)));
  return { nets, counts: { pads: geometry.pads.length, lines: geometry.lines.length, vias: geometry.vias.length } };
}

/**
 * 为"断网"生成待修连接：取每个网络的**主岛**（含对象最多的岛）为目标，
 * 其余岛各出一条连接；起点取该岛上的焊盘（没有焊盘就跳过——走线孤岛不该自动乱接）。
 */
export function buildRepairConnections(geometryInput, { contactTolMil, maxConnections = ROUTING_DEFAULTS.maxConnections } = {}) {
  const analysis = analyzeNetConnectivity(geometryInput, { contactTolMil });
  const connections = [];
  for (const entry of analysis.nets) {
    if (entry.connected) continue;
    const sorted = [...entry.islands].sort((a, b) => b.items.length - a.items.length);
    for (const island of sorted.slice(1)) {
      if (!island.pads.length) continue;
      const pad = island.pads.slice().sort((a, b) => String(a.designator + a.pad).localeCompare(String(b.designator + b.pad)))[0];
      connections.push({
        net: entry.net,
        from: { x: pad.x, y: pad.y, layer: pad.layer, designator: pad.designator, pad: pad.pad, radius: pad.radius },
        islandItemCount: island.items.length,
        mainItemCount: sorted[0].items.length,
      });
      if (connections.length >= maxConnections) return { connections, analysis };
    }
  }
  return { connections, analysis };
}

/**
 * 解析几何间距（mil）：线段 a→b 到**异网**铜（走线/焊盘/过孔/已预留对象）的最小净距离。
 * 这是规划的硬判据：不做网格采样，直接算真实距离（网格采样会"擦边"，真机 DRC 实测 5.77 < 6 mil）。
 * A* 的视线简化与差分布线（差分对补偿）必须共用这一个实现，否则"规划说合规、复核说不合规"。
 *
 * 语义：返回值**已扣掉双方半宽**，即真正的铜到铜净间距；同网对象一律跳过（同网可以贴着走）。
 */
function traceGapAgainst(a, b, layer, { geometry, width, excludeNet, viaOuterDiameter, reserved = [] }) {
  let min = Infinity;
  // 兼容两种入参风格：点对象 {x,y}（A* 视线简化用）与线段对象 {x1,y1,x2,y2}（差分对长号用）
  const ax = a.x ?? a.x1;
  const ay = a.y ?? a.y1;
  const bx = b.x ?? b.x2 ?? ax; // 只传一个点时（A* 的视线简化）退化成退化线段
  const by = b.y ?? b.y2 ?? ay;
  const bbox = { x1: Math.min(ax, bx) - 60, y1: Math.min(ay, by) - 60, x2: Math.max(ax, bx) + 60, y2: Math.max(ay, by) + 60 };
  const inBox = (x, y) => x >= bbox.x1 && x <= bbox.x2 && y >= bbox.y1 && y <= bbox.y2;
  const boxHit = (l) => !(Math.max(l.x1, l.x2) < bbox.x1 || Math.min(l.x1, l.x2) > bbox.x2 || Math.max(l.y1, l.y2) < bbox.y1 || Math.min(l.y1, l.y2) > bbox.y2);
  // excludeNet 允许传网名，也允许传 {net} 形态：传对象时旧的 `===` 比较会失效，
  // 于是"排除自己网络"变成"和自己的原线比间距" ⇒ 空板夹具也判间距不足（真实踩坑）。
  const excluded = String(excludeNet && typeof excludeNet === 'object' ? excludeNet.net ?? '' : excludeNet ?? '');
  // 距离必须拿"真实的这条线段"去算。直接把入参对象丢进 segmentSegmentDistance(a, b)：在
  // (seg, seg) 这种调用下会退化成"和自己比"，距离恒为 0 ⇒ 净距 -width，于是只要异网铜落进
  // 粗筛包围盒，长号就一律被判超距（真板 USB_DP 离 USB_DM 只有 42.9 mil，本该放得下也被误杀）；
  // 在点对象入参下又会算出 NaN（A* 视线简化因此永远不敢走直线）。统一先归一成 seg。
  const seg = { x1: ax, y1: ay, x2: bx, y2: by };
  for (const line of geometry.lines) {
    if (String(line.net ?? '') === excluded || line.layer !== layer || !boxHit(line)) continue;
    min = Math.min(min, segmentSegmentDistance(seg, line) - line.width / 2 - width / 2);
  }
  for (const pad of geometry.pads) {
    if (String(pad.net ?? '') === excluded) continue;
    if (!pad.throughHole && pad.layer !== layer) continue;
    if (!inBox(pad.x, pad.y)) continue;
    const radius = Math.max(pad.radius, (pad.holeDiameter || 0) / 2);
    min = Math.min(min, pointSegmentDistance(pad.x, pad.y, seg) - radius - width / 2);
  }
  for (const via of geometry.vias) {
    if (String(via.net ?? '') === excluded || !inBox(via.x, via.y)) continue;
    min = Math.min(min, pointSegmentDistance(via.x, via.y, seg) - via.outerDiameter / 2 - width / 2);
  }
  for (const item of reserved) {
    if (item.kind === 'via') {
      if (!inBox(item.x, item.y)) continue;
      min = Math.min(min, pointSegmentDistance(item.x, item.y, seg) - (item.outerDiameter || viaOuterDiameter) / 2 - width / 2);
      continue;
    }
    if (item.layer !== layer || !boxHit(item)) continue;
    if (item.net && String(item.net) === excluded) continue;
    min = Math.min(min, segmentSegmentDistance(seg, item) - (item.width || width) / 2 - width / 2);
  }
  return min;
}

/**
 * 诊断版间距：返回"最近的那一个异网障碍物"是谁、净距多少。
 * 规划失败时必须说清楚"撞的是谁、差多少 mil"，不能只丢一句模糊的 budget 标签。
 */
function nearestForeignGap(segment, layer, { geometry, width, excludeNet, viaOuterDiameter, reserved = [] }) {
  const seg = { x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2 };
  const excluded = String(excludeNet && typeof excludeNet === 'object' ? excludeNet.net ?? '' : excludeNet ?? '');
  let best = null;
  const consider = (gapMil, detail) => { if (!best || gapMil < best.gapMil) best = { gapMil, ...detail }; };
  for (const line of geometry.lines) {
    if (String(line.net ?? '') === excluded || line.layer !== layer) continue;
    consider(segmentSegmentDistance(seg, line) - line.width / 2 - width / 2, { kind: 'line', net: String(line.net ?? ''), x: line.x1, y: line.y1 });
  }
  for (const pad of geometry.pads) {
    if (String(pad.net ?? '') === excluded) continue;
    if (!pad.throughHole && pad.layer !== layer) continue;
    const radius = Math.max(pad.radius, (pad.holeDiameter || 0) / 2);
    consider(pointSegmentDistance(pad.x, pad.y, seg) - radius - width / 2, { kind: 'pad', net: String(pad.net ?? ''), x: pad.x, y: pad.y });
  }
  for (const via of geometry.vias) {
    if (String(via.net ?? '') === excluded) continue;
    consider(pointSegmentDistance(via.x, via.y, seg) - via.outerDiameter / 2 - width / 2, { kind: 'via', net: String(via.net ?? ''), x: via.x, y: via.y });
  }
  for (const item of reserved) {
    if (item.kind === 'via') {
      consider(pointSegmentDistance(item.x, item.y, seg) - (item.outerDiameter || viaOuterDiameter) / 2 - width / 2, { kind: 'via', net: String(item.net ?? ''), x: item.x, y: item.y });
      continue;
    }
    if (item.layer !== layer) continue;
    if (item.net && String(item.net) === excluded) continue;
    consider(segmentSegmentDistance(seg, item) - (item.width || width) / 2 - width / 2, { kind: 'line', net: String(item.net ?? ''), x: item.x1, y: item.y1 });
  }
  return best ?? { gapMil: Infinity, kind: 'none', net: '' };
}

/** 长号新铜离板框最紧的那一点，以及它离板框边的余量（负数 = 已经出界）。 */
function outlineDeficit(segments, points, margin) {
  if (!points) return null;
  let worst = null;
  for (const segment of segments) {
    for (const [x, y] of [[segment.x1, segment.y1], [segment.x2, segment.y2]]) {
      const edgeDistance = points.reduce((min, point, index) => {
        const next = points[(index + 1) % points.length];
        return Math.min(min, pointSegmentDistance(x, y, { x1: point.x, y1: point.y, x2: next.x, y2: next.y }));
      }, Infinity);
      const inside = pointInPolygon(x, y, points);
      const deficitMil = (inside ? edgeDistance : -edgeDistance) - margin;
      if (!worst || deficitMil < worst.deficitMil) worst = { x, y, edgeDistanceMil: edgeDistance, marginMil: margin, inside, deficitMil };
    }
  }
  return worst;
}

function buildGrid({ geometry, layers, cell, padRadiusForTrace, width, viaOuterDiameter, clearance, viaExtra = 0, excludeNet = null, reserved = [] }) {
  const xs = [];
  const ys = [];
  geometry.pads.forEach((pad) => { xs.push(pad.x); ys.push(pad.y); });
  geometry.lines.forEach((line) => { xs.push(line.x1, line.x2); ys.push(line.y1, line.y2); });
  geometry.vias.forEach((via) => { xs.push(via.x); ys.push(via.y); });
  if (!xs.length) return null;
  const margin = 40;
  const originX = Math.floor((Math.min(...xs) - margin) / cell) * cell;
  const originY = Math.floor((Math.min(...ys) - margin) / cell) * cell;
  const widthCells = Math.ceil((Math.max(...xs) + margin - originX) / cell) + 1;
  const heightCells = Math.ceil((Math.max(...ys) + margin - originY) / cell) + 1;
  const size = widthCells * heightCells;
  const indexOf = (x, y) => {
    const cx = Math.round((x - originX) / cell);
    const cy = Math.round((y - originY) / cell);
    if (cx < 0 || cy < 0 || cx >= widthCells || cy >= heightCells) return -1;
    return cy * widthCells + cx;
  };
  const xOf = (index) => originX + (index % widthCells) * cell;
  const yOf = (index) => originY + Math.floor(index / widthCells) * cell;
  const makeLayers = () => { const map = {}; layers.forEach((layer) => { map[layer] = new Uint8Array(size); }); return map; };
  const trace = makeLayers();
  const via = makeLayers();
  const stamp = (map, layer, x, y, radius) => {
    const target = map[layer];
    if (!target) return;
    const rc = Math.ceil(radius / cell);
    const cx = Math.round((x - originX) / cell);
    const cy = Math.round((y - originY) / cell);
    for (let dy = -rc; dy <= rc; dy += 1) {
      for (let dx = -rc; dx <= rc; dx += 1) {
        const ix = cx + dx; const iy = cy + dy;
        if (ix < 0 || iy < 0 || ix >= widthCells || iy >= heightCells) continue;
        if (Math.hypot(originX + ix * cell - x, originY + iy * cell - y) <= radius) target[iy * widthCells + ix] = 1;
      }
    }
  };
  const stampSegment = (map, layer, x1, y1, x2, y2, radius) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (cell / 2)));
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      stamp(map, layer, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, radius);
    }
  };
  const clear = (map, layer, x, y, radius) => {
    const target = map[layer];
    if (!target) return;
    const rc = Math.ceil(radius / cell);
    const cx = Math.round((x - originX) / cell);
    const cy = Math.round((y - originY) / cell);
    for (let dy = -rc; dy <= rc; dy += 1) {
      for (let dx = -rc; dx <= rc; dx += 1) {
        const ix = cx + dx; const iy = cy + dy;
        if (ix < 0 || iy < 0 || ix >= widthCells || iy >= heightCells) continue;
        if (Math.hypot(originX + ix * cell - x, originY + iy * cell - y) <= radius) target[iy * widthCells + ix] = 0;
      }
    }
  };
  const clearSegment = (map, layer, x1, y1, x2, y2, radius) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (cell / 2)));
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      clear(map, layer, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, radius);
    }
  };
  geometry.vias.forEach((item) => {
    if (item.net && item.net === excludeNet) return;
    layers.forEach((layer) => {
      stamp(trace, layer, item.x, item.y, item.outerDiameter / 2 + width / 2 + clearance);
      stamp(via, layer, item.x, item.y, item.outerDiameter / 2 + viaOuterDiameter / 2 + clearance + viaExtra);
    });
  });
  geometry.pads.forEach((pad) => {
    if (pad.net && pad.net === excludeNet) return;
    // 通孔焊盘（层 12 / 带孔）在整个板厚上都占位；槽孔按最大孔径保守取值。
    // 间距障碍用**保守半径**（矩形外接圆），否则 A* 会贴着矩形焊盘角落走、真机 DRC 报错。
    const copperRadius = Math.max(pad.clearanceRadius || pad.radius, (pad.holeDiameter || 0) / 2);
    const traceRadius = copperRadius + width / 2 + clearance;
    const viaRadius = copperRadius + viaOuterDiameter / 2 + clearance + viaExtra;
    const targets = pad.throughHole ? layers : [pad.layer];
    targets.forEach((layer) => {
      stamp(trace, layer, pad.x, pad.y, traceRadius);
      stamp(via, layer, pad.x, pad.y, viaRadius);
    });
  });
  geometry.lines.forEach((line) => {
    if (line.net && line.net === excludeNet) return;
    stampSegment(trace, line.layer, line.x1, line.y1, line.x2, line.y2, line.width / 2 + width / 2 + clearance);
    stampSegment(via, line.layer, line.x1, line.y1, line.x2, line.y2, line.width / 2 + viaOuterDiameter / 2 + clearance + viaExtra);
  });
  // 已规划路线（reserved）：与本网无关，但必须当成障碍——否则同一批计划里各条路线会互相交叉
  (Array.isArray(reserved) ? reserved : []).forEach((item) => {
    if (item.kind === 'via') {
      layers.forEach((layer) => {
        stamp(trace, layer, item.x, item.y, (item.outerDiameter || viaOuterDiameter) / 2 + width / 2 + clearance);
        stamp(via, layer, item.x, item.y, (item.outerDiameter || viaOuterDiameter) / 2 + viaOuterDiameter / 2 + clearance + viaExtra);
      });
      return;
    }
    const itemWidth = item.width || width;
    stampSegment(trace, item.layer, item.x1, item.y1, item.x2, item.y2, itemWidth / 2 + width / 2 + clearance);
    stampSegment(via, item.layer, item.x1, item.y1, item.x2, item.y2, itemWidth / 2 + viaOuterDiameter / 2 + clearance + viaExtra);
  });
  return { originX, originY, cell, widthCells, heightCells, size, indexOf, xOf, yOf, trace, via, stamp, stampSegment, clear, clearSegment, padRadiusForTrace };
}

/**
 * 规划一条修复连接。返回 { ok, fanout, segments, vias, minClearanceMil, minGapMil, expansions } 或 { ok:false, reason }。
 * fanout='top' 走顶层逃逸；fanout='via-in-pad' 表示必须盘中孔换层（细间距器件内圈焊盘的唯一出路）。
 */
export function planConnectionRoute({ geometry: geometryInput, connection, options = {}, reserved = [] }) {
  const settings = { ...ROUTING_DEFAULTS, ...options };
  const geometry = normalizeGeometry(geometryInput);
  const layers = Array.isArray(settings.layers) && settings.layers.length ? settings.layers.slice() : [1, 2, 17, 18];
  const fanoutOrder = Array.isArray(settings.fanoutOrder) && settings.fanoutOrder.length ? settings.fanoutOrder : ['top', 'via-in-pad'];
  const attempts = [];
  for (const fanout of fanoutOrder) {
    const startLayer = fanout === 'via-in-pad' ? settings.innerLayer : (connection.from.layer || 1);
    if (!layers.includes(startLayer)) { attempts.push({ fanout, ok: false, reason: '层不在可用列表中' }); continue; }
    const result = runAStar({ geometry, connection, options: settings, layers, startLayer, fanout, reserved });
    if (result.ok) return { ...result, from: connection.from, fanout, attempts };
    attempts.push({ fanout, ok: false, reason: result.reason, expansions: result.expansions });
  }
  return { ok: false, net: connection.net, attempts, reason: attempts.map((item) => `${item.fanout}:${item.reason}`).join(' / ') };
}

/** 按给定顺序规划，并把已规划成功的路线当作互斥障碍，返回 { routes, reserved }。 */
export function planRepairSequence({ geometry: geometryInput, connections, options = {} }) {
  const settings = { ...ROUTING_DEFAULTS, ...options };
  const geometry = normalizeGeometry(geometryInput);
  const reserved = [];
  const routes = [];
  for (const connection of Array.isArray(connections) ? connections : []) {
    const route = planConnectionRoute({ geometry, connection, options: settings, reserved });
    routes.push(route);
    if (!route.ok) continue;
    for (const segment of route.segments) reserved.push({ kind: 'line', net: route.net, layer: segment.layer, x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2, width: settings.widthMil });
    for (const via of route.vias) reserved.push({ kind: 'via', net: route.net, x: via.x, y: via.y, outerDiameter: via.diameter ?? settings.viaOuterDiameterMil });
    if (route.viaInPad) reserved.push({ kind: 'via', net: route.net, x: route.from.x, y: route.from.y, outerDiameter: settings.viaInPadOuterDiameterMil });
  }
  return { routes, reserved };
}

/**
 * 自主布线规划：细间距器件的逃逸通道极窄，"谁先走"会决定整批能不能都走通。
 * 因此这里按三种顺序各算一遍（原序 / 反序 / 按起点拥挤度从大到小），挑最好的结果：
 * 全部走通且复核通过 > 走通条数多 > 段数少（段数少 = 更干净、DRC 干扰更小）。
 */
export function planRepairRoutes({ geometry: geometryInput, connections, options = {} }) {
  const settings = { ...ROUTING_DEFAULTS, ...options };
  const geometry = normalizeGeometry(geometryInput);
  const list = Array.isArray(connections) ? connections : [];
  const crowding = (connection) => {
    let count = 0;
    const { x, y } = connection.from;
    for (const pad of geometry.pads) { if (pad.net === connection.net) continue; if (Math.hypot(pad.x - x, pad.y - y) <= 60) count += 1; }
    for (const via of geometry.vias) { if (via.net === connection.net) continue; if (Math.hypot(via.x - x, via.y - y) <= 60) count += 1; }
    for (const line of geometry.lines) { if (line.net === connection.net) continue; if (pointSegmentDistance(x, y, line) <= 60) count += 1; }
    return count;
  };
  const orders = [list, [...list].reverse(), [...list].sort((a, b) => crowding(b) - crowding(a))];
  let best = null;
  for (const order of orders) {
    const { routes } = planRepairSequence({ geometry, connections: order, options: settings });
    const verification = verifyRoutingPlan({ plan: { routes }, geometry, options: settings });
    const succeeded = routes.filter((route) => route.ok).length;
    const segments = routes.reduce((total, route) => total + (route.ok ? route.segments.length : 0), 0);
    const score = (verification.ok ? 10_000 : 0) + succeeded * 100 - segments;
    if (!best || score > best.score) best = { routes, verification, succeeded, segments, score };
    if (verification.ok && succeeded === list.length) break;
  }
  return best;
}

function runAStar({ geometry, connection, options, layers, startLayer, fanout, reserved = [] }) {
  const { clearanceMil: clearance, widthMil: width, viaOuterDiameterMil: viaOuterDiameter, gridMil: cell, viaCost } = options;
  const grid = buildGrid({ geometry, layers, cell, width, viaOuterDiameter, clearance, excludeNet: connection.net, reserved });
  if (!grid) return { ok: false, reason: '几何为空' };
  const { trace, via, indexOf, xOf, yOf } = grid;

  // 本网铜全部从障碍里清掉（同网可穿越），并把本网铜标成目标掩码（任一触点即可收口）
  const goal = {}; layers.forEach((layer) => { goal[layer] = new Uint8Array(grid.size); });
  const goalCopper = {}; layers.forEach((layer) => { goalCopper[layer] = new Uint8Array(grid.size); });
  const stampCopper = (layer, x, y, radius) => grid.stamp(goalCopper, layer, x, y, radius);
  const stampCopperSegment = (layer, x1, y1, x2, y2, radius) => grid.stampSegment(goalCopper, layer, x1, y1, x2, y2, radius);
  const stampGoal = (layer, x, y, radius) => grid.stamp(goal, layer, x, y, radius);
  const stampGoalSegment = (layer, x1, y1, x2, y2, radius) => grid.stampSegment(goal, layer, x1, y1, x2, y2, radius);
  geometry.lines.filter((line) => line.net === connection.net).forEach((line) => {
    stampGoalSegment(line.layer, line.x1, line.y1, line.x2, line.y2, line.width / 2 + options.contactTolMil - 1);
    stampCopperSegment(line.layer, line.x1, line.y1, line.x2, line.y2, line.width / 2 + options.contactTolMil - 1);
  });
  geometry.vias.filter((item) => item.net === connection.net).forEach((item) => {
    layers.forEach((layer) => { stampGoal(layer, item.x, item.y, item.outerDiameter / 2 + options.contactTolMil - 1); });
  });
  geometry.pads.filter((pad) => pad.net === connection.net).forEach((pad) => {
    stampGoal(pad.layer, pad.x, pad.y, width / 2 + options.contactTolMil - 1);
    stampCopper(pad.layer, pad.x, pad.y, width / 2 + options.contactTolMil - 1);
  });
  // 起点焊盘自身不能算"到达"
  layers.forEach((layer) => grid.clear(goal, layer, connection.from.x, connection.from.y, 5 + width / 2 + 6));

  const startLayerIndex = layers.indexOf(startLayer);
  const nodeCount = grid.size * layers.length;
  const distance = new Float64Array(nodeCount).fill(Infinity);
  const previous = new Int32Array(nodeCount).fill(-1);
  const nodeOf = (cellIndex, layerIndex) => cellIndex + layerIndex * grid.size;
  const startCell = indexOf(connection.from.x, connection.from.y);
  if (startCell < 0) return { ok: false, reason: '起点不在网格内' };
  // 起点本身若落在异网间距禁区里（0.4mm 间距器件的典型情形），顶层逃逸不可能合规 —— 必须盘中孔
  if (fanout === 'top' && trace[layers[startLayerIndex]][startCell]) {
    return { ok: false, reason: '源焊盘四周间距不足（细间距器件），顶层无法合规逃逸' };
  }
  distance[nodeOf(startCell, startLayerIndex)] = 0;
  const heap = [[0, nodeOf(startCell, startLayerIndex)]];
  const push = (priority, value) => {
    heap.push([priority, value]);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent][0] <= heap[index][0]) break;
      const swap = heap[parent]; heap[parent] = heap[index]; heap[index] = swap;
      index = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = 2 * index + 1; const right = left + 1; let best = index;
        if (left < heap.length && heap[left][0] < heap[best][0]) best = left;
        if (right < heap.length && heap[right][0] < heap[best][0]) best = right;
        if (best === index) break;
        const swap = heap[best]; heap[best] = heap[index]; heap[index] = swap;
        index = best;
      }
    }
    return top;
  };
  const viaAllowed = (cellIndex) => {
    for (const layer of layers) if (goalCopper[layer][cellIndex]) return false;
    // 'top' 扇出必须是**真的从顶层逃逸**：不允许在源焊盘上偷偷打过孔（那就是盘中孔，标注必须诚实）
    if (fanout === 'top' && Math.hypot(xOf(cellIndex) - connection.from.x, yOf(cellIndex) - connection.from.y) < (connection.from.radius ?? 5) + viaOuterDiameter / 2 + clearance) return false;
    const cx = cellIndex % grid.widthCells; const cy = Math.floor(cellIndex / grid.widthCells);
    if (cx <= 0 || cy <= 0 || cx >= grid.widthCells - 1 || cy >= grid.heightCells - 1) return false;
    for (const layer of layers) if (via[layer][cellIndex]) return false;
    return true;
  };
  const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  // 上一段的行进方向（用于转弯代价）：贴着障碍走的锯齿路径会让最终段数爆炸，先让它尽量走直
  const directionOf = (node) => {
    const back = previous[node];
    if (back === undefined || back === -1) return null;
    const grand = previous[back];
    if (grand === undefined || grand === -1) return null;
    const backLayer = Math.floor(back / grid.size), backCell = back % grid.size;
    const grandLayer = Math.floor(grand / grid.size), grandCell = grand % grid.size;
    if (backLayer !== grandLayer) return null;
    return [Math.sign(xOf(backCell) - xOf(grandCell)), Math.sign(yOf(backCell) - yOf(grandCell))];
  };
  let found = -1;
  let expansions = 0;
  while (heap.length && expansions < options.maxExpansions) {
    const [, current] = pop();
    expansions += 1;
    const layerIndex = Math.floor(current / grid.size);
    const cellIndex = current % grid.size;
    const x = xOf(cellIndex); const y = yOf(cellIndex);
    if (goal[layers[layerIndex]][cellIndex]) { found = current; break; }
    for (const [dx, dy] of neighbours) {
      const next = indexOf(x + dx * cell, y + dy * cell);
      if (next < 0) continue;
      if (trace[layers[layerIndex]][next]) continue;
      const nextNode = nodeOf(next, layerIndex);
      const step = (dx && dy) ? Math.SQRT2 : 1;
      const arrival = directionOf(current);
      const turn = arrival && (arrival[0] !== dx || arrival[1] !== dy) ? (options.turnPenalty ?? 3) : 0;
      const candidate = distance[current] + step + turn;
      if (candidate < distance[nextNode] - 1e-9) {
        distance[nextNode] = candidate;
        previous[nextNode] = current;
        push(candidate, nextNode);
      }
    }
    if (viaAllowed(cellIndex)) {
      for (let other = 0; other < layers.length; other += 1) {
        if (other === layerIndex) continue;
        const nextNode = nodeOf(cellIndex, other);
        const candidate = distance[current] + viaCost;
        if (candidate < distance[nextNode] - 1e-9) {
          distance[nextNode] = candidate;
          previous[nextNode] = current;
          push(candidate, nextNode);
        }
      }
    }
  }
  if (found < 0) return { ok: false, reason: expansions >= options.maxExpansions ? '搜索超限' : '无可行路径（间距约束下走不通）', expansions };

  const path = [];
  let cursor = found;
  while (cursor !== -1) {
    const layerIndex = Math.floor(cursor / grid.size);
    const cellIndex = cursor % grid.size;
    path.push({ x: xOf(cellIndex), y: yOf(cellIndex), layer: layers[layerIndex] });
    cursor = previous[cursor];
  }
  path.reverse();

  // 按层切成若干"同层连续段"，每段内做视线简化：直的能走就直走，走不通就保留拐点。
  // 关键：绝不能把折线直接连成"起点→终点"一条直线——那会把布线器刚绕开的障碍重新穿回去（实测踩过）。
  const segments = [];
  const routeVias = [];
  const runs = [];
  let runPoints = [{ ...path[0] }];
  for (let index = 1; index < path.length; index += 1) {
    const before = path[index - 1];
    const now = path[index];
    if (now.layer !== before.layer) {
      runs.push({ layer: before.layer, points: runPoints });
      routeVias.push({ x: before.x, y: before.y, fromLayer: before.layer, toLayer: now.layer, diameter: options.viaOuterDiameterMil, holeDiameter: options.viaHoleMil });
      runPoints = [{ x: before.x, y: before.y, layer: now.layer }];
    }
    runPoints.push({ ...now });
  }
  runs.push({ layer: path[path.length - 1].layer, points: runPoints });

  // 视线简化的判据必须和复核用**同一套解析距离**：只查网格采样点会"擦边"（真机 DRC 实测 5.77mil < 6mil），
  // 而简单地把网格走廊加粗又会把可走的路堵死（实测 ALERT_N 直接无解）。所以这里解析算真实间距。
  const segGapAgainst = (a, b, layer) => traceGapAgainst(a, b, layer, { geometry, width, excludeNet: connection.net, viaOuterDiameter, reserved });
  const lineClear = (a, b, layer) => {
    // 先用网格做便宜预筛（快速排除明显撞障碍的候选），再解析确认
    const map = trace[layer];
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell / 2)));
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      const cellIndex = indexOf(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      if (cellIndex < 0 || map[cellIndex]) return false;
    }
    return segGapAgainst(a, b, layer) >= clearance - 0.01;
  };

  for (const run of runs) {
    const points = run.points;
    let i = 0;
    while (i < points.length - 1) {
      let j = points.length - 1;
      while (j > i + 1 && !lineClear(points[i], points[j], run.layer)) j -= 1;
      segments.push({ layer: run.layer, x1: points[i].x, y1: points[i].y, x2: points[j].x, y2: points[j].y });
      i = j;
    }
  }
  const keptSegments = [];
  for (const segment of segments) {
    if (Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1) <= 1) continue;
    const last = keptSegments[keptSegments.length - 1];
    if (last && last.layer === segment.layer && Math.hypot(last.x2 - segment.x1, last.y2 - segment.y1) <= 1) {
      const cross = (last.x2 - last.x1) * (segment.y2 - last.y1) - (last.y2 - last.y1) * (segment.x2 - last.x1);
      if (Math.abs(cross) <= 1e-6) { last.x2 = segment.x2; last.y2 = segment.y2; continue; }
    }
    keptSegments.push({ ...segment });
  }
  return { ok: true, net: connection.net, startLayer, segments: keptSegments, vias: routeVias, expansions, viaInPad: fanout === 'via-in-pad' };
}

/**
 * 独立复核：几何间距 + 连通性。
 * 不复用规划期的网格，全部用解析几何重算——复核必须和规划走不同的实现，否则只是自我确认。
 */
export function verifyRoutingPlan({ plan, geometry: geometryInput, options = {} }) {
  const settings = { ...ROUTING_DEFAULTS, ...options };
  const geometry = normalizeGeometry(geometryInput);
  const clearance = settings.clearanceMil;
  const width = settings.widthMil;
  const violations = [];
  let minGapMil = Infinity;
  const note = (gap) => { minGapMil = Math.min(minGapMil, gap); };
  const push = (entry) => { if (entry.gapMil < clearance - 0.01) violations.push(entry); };
  const padRadius = (pad) => Math.max(pad.clearanceRadius || pad.radius, (pad.holeDiameter || 0) / 2);

  // 计划对象统一成几何项：线（带层与线宽）+ 过孔（带自己的孔径）
  const plannedLines = [];
  const plannedVias = [];
  for (const route of plan?.routes ?? []) {
    if (!route?.ok) continue;
    if (route.viaInPad) plannedVias.push({ kind: 'via', net: route.net, x: route.from.x, y: route.from.y, outerDiameter: settings.viaInPadOuterDiameterMil, hole: settings.viaInPadHoleMil, viaInPad: true });
    for (const segment of route.segments ?? []) plannedLines.push({ kind: 'line', net: route.net, layer: segment.layer, x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2, width });
    for (const via of route.vias ?? []) plannedVias.push({ kind: 'via', net: route.net, x: via.x, y: via.y, outerDiameter: via.diameter ?? settings.viaOuterDiameterMil, hole: via.holeDiameter ?? settings.viaHoleMil });
  }

  /** 计划对象 vs 板面已有对象（通孔焊盘要在所有层都算） */
  const checkExisting = (item) => {
    if (item.kind === 'line') {
      for (const line of geometry.lines) {
        if (line.net === item.net || line.layer !== item.layer) continue;
        const gap = segmentSegmentDistance(item, line) - line.width / 2 - width / 2; note(gap);
        push({ kind: 'line-to-line', net: item.net, other: line.id, gapMil: Number(gap.toFixed(2)) });
      }
      for (const pad of geometry.pads) {
        if (pad.net === item.net) continue;
        if (!pad.throughHole && pad.layer !== item.layer) continue;
        const gap = pointSegmentDistance(pad.x, pad.y, item) - padRadius(pad) - width / 2; note(gap);
        push({ kind: pad.throughHole ? 'line-to-th-pad' : 'line-to-pad', net: item.net, other: `${pad.designator}.${pad.pad}`, gapMil: Number(gap.toFixed(2)) });
      }
      for (const via of geometry.vias) {
        if (via.net === item.net) continue;
        const gap = pointSegmentDistance(via.x, via.y, item) - via.outerDiameter / 2 - width / 2; note(gap);
        push({ kind: 'line-to-via', net: item.net, other: via.id, gapMil: Number(gap.toFixed(2)) });
      }
      return;
    }
    for (const via of geometry.vias) {
      if (via.net === item.net) continue;
      const gap = Math.hypot(via.x - item.x, via.y - item.y) - via.outerDiameter / 2 - item.outerDiameter / 2; note(gap);
      push({ kind: 'via-to-via', net: item.net, other: via.id, gapMil: Number(gap.toFixed(2)) });
    }
    for (const pad of geometry.pads) {
      if (pad.net === item.net) continue;
      if (!pad.throughHole && item.viaInPad && pad.layer !== 1) continue;
      // 盘中孔用"内切半径"和更严的实测判据；普通过孔用保守外接半径。
      const effectivePadRadius = item.viaInPad ? Math.max(pad.radius, (pad.holeDiameter || 0) / 2) : padRadius(pad);
      const gap = Math.hypot(pad.x - item.x, pad.y - item.y) - effectivePadRadius - item.outerDiameter / 2; note(gap);
      const limit = item.viaInPad ? (settings.viaInPadPadClearanceMil ?? settings.clearanceMil) : clearance;
      if (gap < limit - 0.01) violations.push({ kind: item.viaInPad ? 'via-in-pad-to-pad' : 'via-to-pad', net: item.net, other: `${pad.designator}.${pad.pad}`, gapMil: Number(gap.toFixed(2)) });
    }
    for (const line of geometry.lines) {
      if (line.net === item.net) continue;
      const gap = pointSegmentDistance(item.x, item.y, line) - line.width / 2 - item.outerDiameter / 2; note(gap);
      push({ kind: 'via-to-line', net: item.net, other: line.id, gapMil: Number(gap.toFixed(2)) });
    }
  };

  plannedLines.forEach(checkExisting);
  plannedVias.forEach(checkExisting);

  // 计划对象之间也要查：同一批计划里不同网络的路线互相交叉，板上就是实打实的间距违规（真机踩过）
  for (let i = 0; i < plannedLines.length; i += 1) {
    for (let j = i + 1; j < plannedLines.length; j += 1) {
      const a = plannedLines[i]; const b = plannedLines[j];
      if (a.net === b.net || a.layer !== b.layer) continue;
      const gap = segmentSegmentDistance(a, b) - width; note(gap);
      push({ kind: 'route-to-route-line', net: a.net, other: `${b.net} 路线`, gapMil: Number(gap.toFixed(2)) });
    }
    for (const via of plannedVias) {
      const line = plannedLines[i];
      if (line.net === via.net) continue;
      const gap = pointSegmentDistance(via.x, via.y, line) - via.outerDiameter / 2 - width / 2; note(gap);
      push({ kind: 'route-to-route-via', net: line.net, other: `${via.net} 路线过孔`, gapMil: Number(gap.toFixed(2)) });
    }
  }
  for (let i = 0; i < plannedVias.length; i += 1) {
    for (let j = i + 1; j < plannedVias.length; j += 1) {
      const a = plannedVias[i]; const b = plannedVias[j];
      if (a.net === b.net) continue;
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.outerDiameter / 2 - b.outerDiameter / 2; note(gap);
      push({ kind: 'route-to-route-via-via', net: a.net, other: `${b.net} 路线过孔`, gapMil: Number(gap.toFixed(2)) });
    }
  }

  // 连通性复核：把计划中的对象并进板面，重算岛（过孔用各自真实孔径）
  const augmented = {
    lines: [...geometry.lines, ...plannedLines.map((entry) => ({ net: entry.net, layer: entry.layer, x1: entry.x1, y1: entry.y1, x2: entry.x2, y2: entry.y2, width }))],
    vias: [...geometry.vias, ...plannedVias.map((entry) => ({ net: entry.net, x: entry.x, y: entry.y, outerDiameter: entry.outerDiameter, hole: entry.hole }))],
    pads: geometry.pads,
  };
  const analysis = analyzeNetConnectivity(augmented, { contactTolMil: settings.contactTolMil });
  const targets = new Set((plan?.routes ?? []).filter((item) => item?.ok).map((item) => item.net));
  const connectivity = [];
  const disconnected = [];
  for (const net of analysis.nets) {
    if (!targets.has(net.net)) continue;
    connectivity.push({ net: net.net, connected: net.islands.length === 1, islands: net.islands.length });
    if (net.islands.length !== 1) disconnected.push(net.net);
  }
  const ok = violations.length === 0 && disconnected.length === 0;
  if (!Number.isFinite(minGapMil)) minGapMil = null;
  return { ok, minGapMil: minGapMil === null ? null : Number(minGapMil.toFixed(2)), clearanceMil: clearance, violations, connectivity, disconnected };
}


export async function applyRoutingPlan({ execute, plan, geometry: geometryInput, dryRun = true, save = false, options = {} }) {
  const settings = { ...ROUTING_DEFAULTS, ...options };
  const routes = (plan?.routes ?? []).filter((item) => item?.ok);
  if (!routes.length) throw Object.assign(new Error('计划里没有可执行的布线项'), { code: 'ROUTING_PLAN_EMPTY' });
  const verification = verifyRoutingPlan({ plan: { routes }, geometry: geometryInput, options: settings });
  if (!verification.ok) {
    throw Object.assign(new Error(`布线计划未通过独立复核（最小间距 ${verification.minGapMil} mil，违规 ${verification.violations.length} 条，未连通 ${verification.connectivity.filter((entry) => !entry.connected).length} 个网络）`), { code: 'ROUTING_PLAN_REJECTED', detail: verification });
  }
  if (dryRun) return { ok: true, dryRun: true, verification, executed: 0, saved: false };

  // 写前快照（第 31 轮真机缺陷 D-31-4）：回滚必须按"快照差集"删，不能只依赖创建返回的图元 ID——
  // 真机出现过创建响应没有 ID 的情况，那批铜回滚不掉，残留自检还报 0。
  let beforeSnapshot = null;
  try { beforeSnapshot = normalizeGeometry((await execute('pcb.copper.read', {}, {}))?.result ?? {}); } catch { beforeSnapshot = null; }
  const written = [];
  const idOf = (result) => String(result?.result?.primitiveId ?? result?.result?.id ?? result?.primitiveId ?? result?.id ?? '');
  try {
    // 写入顺序必须先过孔后走线（真机第 33 轮缺陷）：EDA 的连通图只在"新图元创建"时把新对象
    // 接到已存在的铜上，**不会回头重算先前图元**。先画走线再补过孔，走线仍被判"与同网其它对象断开"
    // （DRC Connection Error/Track），布线写回必被 DRC 守卫回滚。所以先建全部过孔，再建走线。
    for (const route of routes) {
      if (route.viaInPad) {
        // 盘中孔：0.25mm 焊盘里只能放细孔（工艺豁免项，必须在发布说明里写明树脂塞孔/电镀填平）
        const created = await execute('pcb.via.create', { net: route.net, x: route.from.x, y: route.from.y, holeDiameter: settings.viaInPadHoleMil, diameter: settings.viaInPadOuterDiameterMil }, { allowWrite: true });
        written.push({ kind: 'via', id: idOf(created), net: route.net, x: route.from.x, y: route.from.y });
        if (settings.writeSpacingMs > 0) await new Promise((resolve) => setTimeout(resolve, settings.writeSpacingMs));
      }
      for (const via of route.vias) {
        const created = await execute('pcb.via.create', { net: route.net, x: via.x, y: via.y, holeDiameter: via.holeDiameter ?? settings.viaHoleMil, diameter: via.diameter ?? settings.viaOuterDiameterMil }, { allowWrite: true });
        written.push({ kind: 'via', id: idOf(created), net: route.net, x: via.x, y: via.y });
        if (settings.writeSpacingMs > 0) await new Promise((resolve) => setTimeout(resolve, settings.writeSpacingMs));
      }
    }
    for (const route of routes) {
      for (const segment of route.segments) {
        const created = await execute('pcb.line.create', { net: route.net, layer: segment.layer, startX: segment.x1, startY: segment.y1, endX: segment.x2, endY: segment.y2, lineWidth: settings.widthMil, primitiveLock: false }, { allowWrite: true });
        if (settings.writeSpacingMs > 0) await new Promise((resolve) => setTimeout(resolve, settings.writeSpacingMs));
        written.push({ kind: 'line', id: idOf(created), net: route.net, layer: segment.layer, x: segment.x1, y: segment.y1, x2: segment.x2, y2: segment.y2 });
      }
    }
    // 回读必须"等到 EDA 真的落盘"，并且**按图元ID**核对（几何匹配会把"少写一个"吞掉）。
    let after = null;
    let missing = [];
    const attempts = Math.max(1, Number(settings.readbackAttempts) || 15);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const readback = await execute('pcb.copper.read', {}, {});
      after = normalizeGeometry(readback?.result ?? readback);
      const ids = new Set([...after.lines, ...after.vias].map((item) => String(item.id ?? '')));
      // 两种可能都要认：①ID直接命中；②EDA把新铜与原有同网铜**合并**了，创建时返回的ID会消失，
      // 但对象本身确实在板上（几何一致）。任一命中才算写入成功，两者都不命中就得如实报缺失。
      const linesLeft = after.lines.slice();
      const viasLeft = after.vias.slice();
      missing = [];
      for (const item of written) {
        if (item.id && ids.has(String(item.id))) continue;
        if (item.kind === 'line') {
          const index = linesLeft.findIndex((line) => line.layer === item.layer && Math.abs(line.x1 - item.x) <= 1 && Math.abs(line.y1 - item.y) <= 1 && Math.abs(line.x2 - item.x2) <= 1 && Math.abs(line.y2 - item.y2) <= 1);
          if (index >= 0) { linesLeft.splice(index, 1); continue; }
          // 真机实测：EDA 会把新画的短走线**合并**进相邻的同网同层走线，创建时返回的ID随即失效，
          // 坐标也不再是原样——但铜确实在板上。判据：这一段的两个端点都落在某条现存同网走线上。
          const merged = after.lines.some((line) => line.net === item.net && line.layer === item.layer
            && pointSegmentDistance(item.x, item.y, line) <= 1.5
            && pointSegmentDistance(item.x2, item.y2, line) <= 1.5);
          if (merged) continue;
        } else {
          const index = viasLeft.findIndex((via) => Math.abs(via.x - item.x) <= 1 && Math.abs(via.y - item.y) <= 1);
          if (index >= 0) { viasLeft.splice(index, 1); continue; }
        }
        missing.push(item);
      }
      if (!missing.length) break;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, Number(settings.readbackSettleMs) || 300));
    }
    if (missing.length) {
      const rollbackResult = await rollback(execute, written, { before: beforeSnapshot });
      const residual = rollbackResult.residual ?? [];
      throw Object.assign(new Error(`写入后回读比对失败：${missing.length} 个对象在板上找不到（${missing.map((item) => item.kind).join('/')}），已回滚（残留 ${residual.length}）`), {
        code: 'ROUTING_READBACK_MISMATCH',
        missing: missing.length,
        residual,
        details: { missing: missing.map((item) => ({ kind: item.kind, net: item.net, x: item.x, y: item.y, x2: item.x2, y2: item.y2, layer: item.layer })), residual },
      });
    }
    let saved = false;
    if (save) {
      const saveOutcome = await execute('pcb.save', {}, { allowWrite: true });
      // UI 复审 2026-10-29 新发现：修复前不看返回值，EDA 没确认落盘也显示“并已保存”。
      if (!saveConfirmed(saveOutcome)) {
        throw Object.assign(new Error('布线已写入但 pcb.save 未确认落盘（EDA 返回非 true）：不能报告“已保存”'), { code: 'PCB_SAVE_UNCONFIRMED' });
      }
      saved = true;
    }
    return { ok: true, dryRun: false, executed: written.length, saved, verification, written: written.map((item) => ({ kind: item.kind, net: item.net, id: item.id })) };
  } catch (error) {
    if (!error?.code || error.code === 'EDA_WRITE_BLOCKED' || error.code === 'BRIDGE_HTTP_ERROR' || error.code === 'PCB_SAVE_UNCONFIRMED') {
      try { await rollback(execute, written, { before: beforeSnapshot }); } catch { /* 回滚失败不再掩盖原始错误 */ }
    }
    throw error;
  }
}

/**
 * 布线收尾：重建铺铜 + 落盘保存。
 * 为什么必须单独一步：新铜会切开平面/铺铜（铺铜必须重建），而"保存"是不可逆动作，必须显式要求。
 * 两步都是写入，因此同样受运行时受控授权约束（allowWrite），不给脚本外挂留后门。
 */
/**
 * 回滚一批布线对象（按图元ID删除）。用途：上一批写入被真机 DRC 判为不合规时，把铜干净地撤掉再重算。
 * 删除后必须回读确认"确实没了"，否则回滚就是假的。返回 { removed, residual }。
 */
export async function rollbackRouting({ execute, items, before = null }) {
  if (typeof execute !== 'function') throw Object.assign(new Error('缺少 execute'), { code: 'ROUTING_EXECUTE_REQUIRED' });
  const list = (Array.isArray(items) ? items : []).filter((item) => item && item.id);
  const snap = before && typeof before === 'object' ? before : null;
  let lineIds = list.filter((item) => item.kind === 'line').map((item) => item.id);
  let viaIds = list.filter((item) => item.kind === 'via').map((item) => item.id);
  // 有写前快照时以"当前铜 − 写前铜"为准：创建响应缺 ID 的铜也能被找出来删掉。
  if (snap) {
    const beforeIds = new Set([...(snap.lines ?? []), ...(snap.vias ?? [])].map((item) => String(item.id ?? '')).filter(Boolean));
    try {
      const current = (await execute('pcb.copper.read', {}))?.result ?? {};
      for (const line of current.lines ?? []) {
        const id = String(line.id ?? '');
        if (id && !beforeIds.has(id)) lineIds.push(id);
      }
      for (const via of current.vias ?? []) {
        const id = String(via.id ?? '');
        if (id && !beforeIds.has(id)) viaIds.push(id);
      }
    } catch { /* 读不到当前铜就退回按 ID 回滚 */ }
  }
  lineIds = [...new Set(lineIds.filter(Boolean))];
  viaIds = [...new Set(viaIds.filter(Boolean))];
  if (!lineIds.length && !viaIds.length) throw Object.assign(new Error('缺少要回滚的对象'), { code: 'ROUTING_ROLLBACK_ARGS_INVALID' });
  if (lineIds.length) await execute('pcb.lines.delete', { primitiveIds: lineIds }, { allowWrite: true });
  if (viaIds.length) await execute('pcb.vias.delete', { primitiveIds: viaIds }, { allowWrite: true });
  const current = (await execute('pcb.copper.read', {}))?.result ?? {};
  const alive = new Set([...(current.lines ?? []), ...(current.vias ?? [])].map((item) => String(item.id ?? '')));
  const residual = [...lineIds, ...viaIds].filter((id) => alive.has(String(id)));
  return { removed: lineIds.length + viaIds.length - residual.length, residual };
}

export async function finishRouting({ execute, rebuildPours = true, save = true, maxFillAttempts = 2 }) {
  if (typeof execute !== 'function') throw Object.assign(new Error('缺少 execute'), { code: 'ROUTING_EXECUTE_REQUIRED' });
  /**
   * 第 62 轮真机缺陷 D-36-1：`rebuildCopperRegion()` 的返回值不能证明"填充真的产出"。
   * 灯板上对 GND 覆铜调用重建，返回的却是 +5V 覆铜的 Poured 对象，GND 覆铜没有任何填充，
   * 旧实现却报 `rebuilt ok` → DRC 里 18 个 GND 焊盘未连通被当成"已重建"。
   * 修法：重建后读 `pcb.poured.read`（每个覆铜边框的实际填充片数）做 fail-closed 复核；
   * 仍有覆铜没填充就重试一次，仍失败则**不保存**并如实报错——绝不产出"看似重建、实际没填充"的板。
   */
  const result = { ok: true, pours: null, fills: null, poursFilled: null, unfilledPours: [], fillAttempts: 0, saved: false };
  const readFills = async () => {
    try {
      const state = await execute('pcb.poured.read', {}, {});
      const list = Array.isArray(state?.result) ? state.result : (Array.isArray(state) ? state : []);
      return Array.isArray(list) ? list : null;
    } catch {
      return null; // 读不到填充 = 不知道，不能假装通过
    }
  };
  if (rebuildPours) {
    let fills = null;
    for (let attempt = 1; attempt <= Math.max(1, Number(maxFillAttempts) || 1); attempt += 1) {
      result.fillAttempts = attempt;
      const rebuilt = await execute('pcb.pour.rebuild', {}, { allowWrite: true });
      result.pours = rebuilt?.result ?? rebuilt;
      fills = await readFills();
      if (!fills) break;
      result.fills = fills;
      const unfilled = fills.filter((pour) => Number(pour.filledFills ?? 0) < 1);
      if (unfilled.length === 0) break;
      if (attempt >= Math.max(1, Number(maxFillAttempts) || 1)) {
        result.ok = false;
        result.poursFilled = false;
        result.unfilledPours = unfilled.map((pour) => ({ primitiveId: pour.primitiveId ?? null, net: pour.net ?? null, layer: pour.layer ?? null, filledFills: Number(pour.filledFills ?? 0) }));
        result.error = {
          code: 'PCB_POUR_FILL_INCOMPLETE',
          message: `覆铜重建后仍无填充：${result.unfilledPours.map((pour) => `${pour.net ?? '?'}@${pour.layer ?? '?'}`).join('、')}；为避免产出"看似重建、实际未填充"的板，本次不保存`,
        };
      }
    }
    if (!fills) {
      /**
       * P0-4 fail-closed：读不到填充 = 不知道有没有填充。
       * 旧实现在这里 break 后仍保持 ok:true 并照常保存，等于把"未知"当"通过"；
       * 现在明确失败且不保存，由 UI 显示原因（PCB_POUR_FILL_UNKNOWN）。
       */
      result.ok = false;
      result.poursFilled = null;
      result.error = {
        code: 'PCB_POUR_FILL_UNKNOWN',
        message: '覆铜重建后无法读取填充数据（pcb.poured.read 失败）：不能证明覆铜已填充，本次不保存',
      };
    } else {
      result.poursFilled = fills.length === 0 ? null : fills.every((pour) => Number(pour.filledFills ?? 0) > 0);
    }
  }
  if (save && result.ok) {
    const saveOutcome = await execute('pcb.save', {}, { allowWrite: true });
    // 修复前这里无条件 saved=true；save 失败时 UI 仍显示“覆铜已重建并保存”，属于假保存。
    if (saveConfirmed(saveOutcome)) {
      result.saved = true;
    } else {
      result.ok = false;
      result.saved = false;
      result.error = { code: 'PCB_SAVE_UNCONFIRMED', message: '覆铜已重建但 pcb.save 未确认落盘（EDA 返回非 true）：不能报告“已保存”' };
    }
  }
  return result;
}

async function rollback(execute, written, context = {}) {
  const before = context?.before ?? null;
  // 先读当前板面：回滚的对象集 = 当前铜 − 写前铜。这个口径不依赖创建响应是否带 ID。
  let current = null;
  try { current = normalizeGeometry((await execute('pcb.copper.read', {}, {}))?.result ?? {}); } catch { current = null; }
  const lineIds = [];
  const viaIds = [];
  const seen = new Set();
  if (before) {
    const beforeIds = new Set([...(before.lines ?? []), ...(before.vias ?? [])].map((item) => String(item.id ?? '')).filter(Boolean));
    for (const item of [...(current?.lines ?? []), ...(current?.vias ?? [])]) {
      const id = String(item.id ?? '');
      if (!id || beforeIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      const isVia = (current?.vias ?? []).includes(item);
      (isVia ? viaIds : lineIds).push(id);
    }
  }
  if (!before || (!lineIds.length && !viaIds.length)) {
    // 兜底（无写前快照）：按 written 的候选 ID / 几何匹配凑删除清单
    for (const item of written) {
      const id = String(item.id ?? '');
      if (id) { (item.kind === 'line' ? lineIds : viaIds).push(id); continue; }
      if (item.kind === 'line') {
        const match = (current?.lines ?? []).find((line) => line.layer === item.layer && Math.abs(line.x1 - item.x) <= 1 && Math.abs(line.y1 - item.y) <= 1 && Math.abs(line.x2 - item.x2) <= 1 && Math.abs(line.y2 - item.y2) <= 1 && line.id);
        if (match?.id) lineIds.push(String(match.id));
      } else {
        const match = (current?.vias ?? []).find((via) => Math.abs(via.x - item.x) <= 1 && Math.abs(via.y - item.y) <= 1 && via.id);
        if (match?.id) viaIds.push(String(match.id));
      }
    }
  }
  const aliveIds = async (ids) => {
    if (!ids.length) return [];
    try {
      const after = normalizeGeometry((await execute('pcb.copper.read', {}, {}))?.result ?? {});
      const alive = new Set([...after.lines, ...after.vias].map((item) => String(item.id ?? '')));
      return ids.filter((id) => alive.has(String(id)));
    } catch { return ids; } // 读不到就按"可能还在"报，绝不把未知当 0
  };
  if (lineIds.length) await execute('pcb.lines.delete', { primitiveIds: [...new Set(lineIds)].filter(Boolean) }, { allowWrite: true });
  if (viaIds.length) await execute('pcb.vias.delete', { primitiveIds: [...new Set(viaIds)].filter(Boolean) }, { allowWrite: true });
  // 真机：批量删除会静默失败（报告"已回滚"，板上却留着对象）→ 删完必须回读确认并逐个重试。
  let residual = await aliveIds([...lineIds, ...viaIds]);
  for (const id of residual) {
    const commandId = lineIds.includes(id) ? 'pcb.lines.delete' : 'pcb.vias.delete';
    try { await execute(commandId, { primitiveIds: [id] }, { allowWrite: true }); } catch { /* 逐个重试失败也要在 residual 里体现 */ }
  }
  if (residual.length) residual = await aliveIds(residual);
  return { lineIds, viaIds, residual };
}

/* ============================================================================================
 * 差分对等长（length matching）—— 纯规划 + 纯复核，绝不自己写 EDA
 *
 * 真机事实（本仓库实测，用来校准下面所有常数）：
 *   USB_DP / USB_DM 是一对差分对，两网各自**已经完全连通**（0 条断网），
 *   但长度差（skew）433.7 mil，而规则要求 ≤ 10 mil。板子 60×40mm，铜快照 507 线 / 46 过孔 / 94 焊盘。
 *   默认 clearance 6 mil、线宽 8 mil、栅格 4 mil —— 于是：
 *     · 每个"齿"的最小振幅 = 线宽 + 2×间距 = 8 + 12 = 20 mil（两条边条轨迹的铜边净距正好 6 mil）；
 *     · 相邻腿中心距 S 至少要到 clearance + width/2 = 10 mil，落在 4 mil 栅格上取 12 mil。
 *   433.7 mil 的补偿量只能靠"多齿 + 中等振幅"吃下来：齿数越多、每齿需要的振幅越小。
 * ========================================================================================== */

/** 差分对默认参数。skewLimitMil 就是规则里的 ≤10 mil。 */
export const DIFF_PAIR_DEFAULTS = Object.freeze({
  ...ROUTING_DEFAULTS,
  skewLimitMil: 10,
  maxMeanderTeeth: 256,
  maxMeanderAmplitudeMil: 400,
  meanderLayer: null, // null => 长号跟随宿主段所在层（真板长走线在内层，写死 1 会全被排除）
  edgeClearanceMil: null, // null → 取 clearanceMil
  netCap: 5000,
});

const toFixed6 = (value) => Number(Number(value).toFixed(6));

function nameKey(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9+_-]/g, '');
}

/**
 * 极性后缀识别：+ / - / _P / _N / .P / .N / P / N。
 * 后缀必须与前面的主体是"词界"（_ . / -）或是整体结尾的裸 P/N，且主体长度 ≥ 2，
 * 免得把 VCC / GND 这类普通网络误凑成差分对。base 去掉极性标记后的共同词干。
 */
function polarityOfName(name) {
  const key = nameKey(name);
  const at = key.indexOf('@');
  const body = at >= 0 ? key.slice(0, at) : key;
  // bare `DP`/`DM`（无分隔符）不匹配任何"带分隔符"的形式，整对会被漏掉；
  // 归一到 base 'dp'，与 `D+`/`D-`（base 'd'）刻意区分，避免两对差分对被并成一对。
  // 注意：nameKey 会大写，所以这里必须比较大写（写成小写会永远不命中 —— 我踩过这个坑）
  if (body === 'DP') return { base: 'DP', sign: 'p' };
  if (body === 'DM') return { base: 'DP', sign: 'n' };
  const forms = [
    [/\+$/, 'p'], [/-$/, 'n'],
    [/[_./]P$/, 'p'], [/[_./]N$/, 'n'],
    [/[_./]DP$/, 'p'], [/[_./]DM$/, 'n'], // 先长后短，避免 USB_DP 被当成 USB_D + P
    [/P$/, 'p'], [/N$/, 'n'],
  ];
  for (const [pattern, sign] of forms) {
    if (!pattern.test(body)) continue;
    const base = body.replace(pattern, '');
    // 真机/标准命名踩过的坑：bare `DP`/`DM`、`D+`/`D-` 匹配后主体只剩一个字母 `d`，
    // 旧守卫 `length < 2` 会把它们全否掉 —— 于是"3 对差分对只识别出 1 对"。
    // 单字母主体是合法差分命名；真正要排除的是"整个名字就是极性词"（base 为空）。
    if (!base.length) continue;
    return { base, sign };
  }
  return null;
}

/** 拼接差分对去重键：两个名字排序后用 '|' 连接，{A,B} 与 {B,A} 视为同一对。 */
function pairKey(positive, negative) {
  const parts = [nameKey(positive), nameKey(negative)].sort();
  return parts.join('|');
}

/**
 * 识别差分对：优先用 plan 里声明的差分对（impedance/pairs），没有声明再退回名字启发式。
 * 返回 [{ positive, negative, source }]，source='explicit' | 'heuristic'，去重。
 */
export function detectDifferentialPairs({ nets = [], plan = null } = {}) {
  const netList = (Array.isArray(nets) ? nets : []).map((net) => String(net ?? '').trim()).filter(Boolean);
  const known = new Map();
  for (const net of netList) if (!known.has(nameKey(net))) known.set(nameKey(net), net);
  const has = (name) => known.has(nameKey(name));
  const displayOf = (name) => known.get(nameKey(name)) ?? String(name);

  const explicit = [];
  const declared = plan?.impedance?.pairs ?? plan?.pairs ?? plan?.differentialPairs ?? [];
  for (const entry of Array.isArray(declared) ? declared : []) {
    if (!entry || typeof entry !== 'object') continue;
    const positive = entry.positive ?? entry.pos ?? entry.p ?? entry.positiveNet ?? entry.trueNet ?? '';
    const negative = entry.negative ?? entry.neg ?? entry.n ?? entry.negativeNet ?? entry.falseNet ?? '';
    if (!positive || !negative) continue;
    explicit.push({ positive: displayOf(positive), negative: displayOf(negative), source: 'explicit' });
  }

  const heuristic = [];
  const groups = new Map();
  for (const net of netList) {
    const polarity = polarityOfName(net);
    if (!polarity) continue;
    const group = groups.get(polarity.base) ?? { p: null, n: null };
    if (polarity.sign === 'p' && !group.p) group.p = net;
    if (polarity.sign === 'n' && !group.n) group.n = net;
    groups.set(polarity.base, group);
  }
  for (const group of groups.values()) {
    if (!group.p || !group.n) continue;
    heuristic.push({ positive: group.p, negative: group.n, source: 'heuristic' });
  }

  const seen = new Set();
  const pairs = [];
  for (const entry of [...explicit, ...heuristic]) {
    const key = pairKey(entry.positive, entry.negative);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(entry);
  }
  return pairs;
}

/** 把圆弧（radius / bulge）按弦向量旋转近似成折线，返回弧长、端点与中间点。 */
function arcApproximation(line) {
  const chord = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
  const radius = num(line.radius);
  if (radius > 0 && chord > 0) {
    const theta = 2 * Math.asin(Math.min(1, chord / (2 * radius)));
    const length = radius * theta;
    const sagitta = radius - Math.sqrt(Math.max(0, radius * radius - (chord / 2) * (chord / 2)));
    return { kind: 'radius', length, chord, sagitta, points: [] };
  }
  const bulge = num(line.bulge);
  if (bulge && chord > 0) {
    // 圆弧面积关系：sagitta = |bulge| × 弦长 / 2；弧长取弦长做一阶修正（圆弧近似，已在 metadata 里声明）
    const sagitta = Math.abs(bulge) * chord / 2;
    const correction = 1 + (8 / 3) * (sagitta / chord) ** 2;
    return { kind: 'bulge', length: chord * correction, chord, sagitta, points: [] };
  }
  return null;
}

/** 焊盘自身的铜：默认当直径 2×radius 的圆（无法从快照得知真实外形，metadata 里如实声明）。 */
function padStub(pad, contactTolMil) {
  const radius = Math.max(pad.radius, (pad.holeDiameter || 0) / 2);
  return { x1: pad.x, y1: pad.y, x2: pad.x, y2: pad.y, width: 2 * radius, length: 0, pad, contactTolMil };
}

/**
 * 逐层遍历铜几何，返回每个网络的有向线段集合（走线 + 圆弧近似 + 未被走线覆盖的焊盘铜）。
 * 长度按线段累加：重叠铜不会被重复计数（端点闭合的折线求和即路径长度）。
 * 注意：EDA 若把圆弧当**普通折线**回读（没有 radius/bulge 元数据），这里无法识别——见 metadata.notes。
 */
function copperEdgesByNet(geometry, { contactTolMil = ROUTING_DEFAULTS.contactTolMil } = {}) {
  const byNet = new Map();
  const ensure = (net) => {
    if (!byNet.has(net)) byNet.set(net, { net, layers: new Map(), lineCount: 0, arcCount: 0, padCount: 0, arcApproximated: false });
    return byNet.get(net);
  };
  for (const line of geometry.lines) {
    if (!line.net) continue;
    const entry = ensure(line.net);
    const length = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    if (!entry.layers.has(line.layer)) entry.layers.set(line.layer, []);
    const arc = arcApproximation(line);
    if (arc) {
      entry.arcCount += 1;
      entry.arcApproximated = true;
      entry.layers.get(line.layer).push({ x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2, length: arc.length, arc: true, arcKind: arc.kind, chord: arc.chord, line });
    } else {
      entry.lineCount += 1;
      entry.layers.get(line.layer).push({ x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2, length, arc: false, line });
    }
  }
  for (const pad of geometry.pads) {
    if (!pad.net) continue;
    const entry = ensure(pad.net);
    const stub = padStub(pad, contactTolMil);
    const covered = (entry.layers.get(pad.layer) ?? []).some((edge) => !(edge.x1 === edge.x2 && edge.y1 === edge.y2)
      && pointSegmentDistance(pad.x, pad.y, edge) <= ((edge.line?.width ?? edge.width ?? ROUTING_DEFAULTS.widthMil) / 2) + contactTolMil);
    if (covered) continue;
    if (!entry.layers.has(pad.layer)) entry.layers.set(pad.layer, []);
    entry.layers.get(pad.layer).push({ ...stub, arc: false });
    entry.padCount += 1;
  }
  return byNet;
}

/**
 * 量每条网络的铜长（mil），带逐层明细。
 * metadata 里会如实说明：①圆弧是否被近似（若有圆弧，长度是近似值）；②是否把焊盘自身铜算进去；
 * ③这一路上有没有用到板框约束。绝不假装"精确"。
 */
export function measureNetLengths(geometryInput, options = {}) {
  const settings = { ...DIFF_PAIR_DEFAULTS, ...options };
  const geometry = normalizeGeometry(geometryInput);
  const edges = copperEdgesByNet(geometry, { contactTolMil: settings.contactTolMil });
  const nets = [];
  let arcApproximated = false;
  let arcCount = 0;
  let totalPadStubs = 0;
  for (const entry of edges.values()) {
    let total = 0;
    const per = [];
    for (const [layer, list] of entry.layers.entries()) {
      const length = list.reduce((sum, item) => sum + item.length, 0);
      total += length;
      per.push({ layer, lengthMil: toFixed6(length), segments: list.length });
    }
    per.sort((a, b) => a.layer - b.layer);
    if (entry.arcCount) arcApproximated = true;
    arcCount += entry.arcCount;
    totalPadStubs += entry.padCount;
    const layerMm = {};
    per.forEach((item) => { layerMm[String(item.layer)] = item.lengthMil; });
    nets.push({ net: entry.net, totalMil: toFixed6(total), byLayer: per, layerMm, lineCount: entry.lineCount, arcCount: entry.arcCount, padCount: entry.padCount });
  }
  nets.sort((a, b) => b.totalMil - a.totalMil || String(a.net).localeCompare(String(b.net)));
  const metadata = {
    clearanceMil: settings.clearanceMil,
    widthMil: settings.widthMil,
    gridMil: settings.gridMil,
    contactTolMil: settings.contactTolMil,
    segmentCount: geometry.lines.length,
    padCount: geometry.pads.length,
    viaCount: geometry.vias.length,
    arcApproximated,
    arcCount,
    arcsApproximatedKind: arcCount ? 'radius|bulge' : null,
    padStubCount: totalPadStubs,
    padLengthApproximation: totalPadStubs ? 'pad-as-circle(2*radius)' : null,
    lengthKind: arcApproximated ? 'approximate-arcs' : 'exact-segments',
    notes: [
      arcApproximated
        ? '含圆弧：圆弧用 radius/bulge 近似成等效弧长，返回值不是逐点精确长度'
        : '按线段长度累加（含同网重叠段不会重复计长）',
      totalPadStubs ? '已把未被走线覆盖的焊盘自身铜按等径圆计入' : '所有焊盘都已被走线覆盖，未额外计焊盘铜',
      '过孔不计长度（跨层通孔长度对同层差分对没有意义）',
    ],
  };
  return { nets, metadata };
}

/** 板框多边形（可按 outline.marginMil 外扩）；没有板框信息时返回 null。 */
function outlinePolygon(outline, marginMil = 0) {
  const raw = Array.isArray(outline) ? outline : (outline?.points ?? outline?.polygon ?? outline?.vertices ?? null);
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const points = raw.map((point) => (Array.isArray(point) ? { x: num(point[0]), y: num(point[1]) } : { x: num(point?.x), y: num(point?.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 3) return null;
  return marginMil ? points.map((point) => ({ x: point.x + marginMil, y: point.y + marginMil })) : points;
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 点到板框的距离。pointInPolygon 用射线法，这里对每个角点用"绕数方向"粗判内外，边距用点线距。 */
function pointInsideBoard(x, y, points, margin) {
  if (!points) return true;
  const edgeDistance = points.reduce((min, point, index) => {
    const next = points[(index + 1) % points.length];
    return Math.min(min, pointSegmentDistance(x, y, { x1: point.x, y1: point.y, x2: next.x, y2: next.y }));
  }, Infinity);
  return pointInPolygon(x, y, points) && edgeDistance >= margin;
}

function segmentsInsideBoard(segments, points, margin) {
  if (!points) return true;
  return segments.every((segment) => pointInsideBoard(segment.x1, segment.y1, points, margin) && pointInsideBoard(segment.x2, segment.y2, points, margin));
}

/**
 * 一个"长号（trombone）"的折线，参数含义（这是等长数学的核心，别搞混）：
 *   n    齿数
 *   span 整条长号沿原线段方向占用的总跨度（≤ 线段长度）
 *   w    每个齿顶那条横腿的长度
 *   A    振幅（腿高）
 * 齿在 [0, span] 内均匀铺开：第 i 个齿的下腿在 w/2 + i×(span-w)/n，上腿再往右 w。
 * 于是：相邻齿之间两条腿的中心距恰好是 w（≥ clearance + width/2 才不挤）；
 *       每齿净增 2A（腿各 A，横腿长度互相抵消）⇒ 整条长号净增 2·A·n。
 * 端点严格等于原线段两端，所以"连通性由构造保证"：同层、端点重合、不换层、不动过孔。
 * 长度增量用**折线逐段求和**得出（delta = Σ|Pi+1 - Pi| - 线段长），解析公式 2An 只作核对。
 */
function meanderGeometry(a, b, n, span, w, amplitude, sign, strideOverride = null) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(length > 0) || !(n >= 1) || !(w > 0) || !(span > 0) || !(span <= length + 1e-9)) return null;
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const nx = -uy * sign; // 垂直方向 = 线段方向左转 90°，sign 决定往哪一侧长出去
  const ny = ux * sign;
  const at = (s, k) => ({ x: a.x + ux * s + nx * k, y: a.y + uy * s + ny * k });
  // 每个齿 = 下腿 A（横坐标 s）、横腿 w、上腿 A（横坐标 s+w）。
  //   跨度 span = 最后一个齿右腿的横坐标；相邻齿同侧腿的中心距 = w + stride。
  //   返回腿 = L − span（≥ 0），它是"长号必须落在被替换线段内"的硬约束。
  const stride = n === 1 ? 0 : (strideOverride == null ? (span - n * w) / (n - 1) : strideOverride);
  if (n > 1 && stride < -1e-9) return null;
  const points = [at(0, 0)];
  if (n === 1) {
    const s = (length - w) / 2; // 单齿居中，两端各留 (L−w)/2 返回腿
    if (s < -1e-9) return null;
    points.push(at(s, 0), at(s, amplitude), at(s + w, amplitude), at(s + w, 0));
  } else {
    for (let i = 0; i < n; i += 1) {
      const s = w / 2 + i * (w + stride);
      if (s + w > length + 1e-9) return null;
      points.push(at(s, 0), at(s, amplitude), at(s + w, amplitude), at(s + w, 0));
    }
  }
  let total = 0;
  const kept = [];
  for (let i = 1; i < points.length; i += 1) {
    const step = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    total += step;
    if (step > 1e-9) kept.push({ x1: points[i - 1].x, y1: points[i - 1].y, x2: points[i].x, y2: points[i].y });
  }
  const tail = { x: b.x, y: b.y };
  if (Math.hypot(tail.x - points[points.length - 1].x, tail.y - points[points.length - 1].y) > 1e-9) {
    total += Math.hypot(tail.x - points[points.length - 1].x, tail.y - points[points.length - 1].y);
    kept.push({ x1: points[points.length - 1].x, y1: points[points.length - 1].y, x2: tail.x, y2: tail.y });
  }
  const sn = points[points.length - 1].x === a.x + ux * 0 ? 0 : Math.hypot(points[points.length - 1].x - a.x, points[points.length - 1].y - a.y);
  return { points, gain: total - length, segments: kept, toothCount: n, span: sn, run: w, amplitude, stride, returnLeg: length - sn, expectedGain: 2 * amplitude * n };
}

/** 长号必须是"从原线段起点走到终点"的一条连续折线：端点严格重合 + 段段首尾相接（这就是连通性的构造性保证）。 */
function endpointsPreserved(segments, a, b, tolerance = 1e-6) {
  if (!segments.length) return false;
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (Math.hypot(first.x1 - a.x, first.y1 - a.y) > tolerance || Math.hypot(last.x2 - b.x, last.y2 - b.y) > tolerance) return false;
  return segments.slice(1).every((segment, index) => Math.hypot(segment.x1 - segments[index].x2, segment.y1 - segments[index].y2) <= tolerance);
}

/**
 * 在一条线段上求"恰好补 deltaMil"的长号解（等长数学全在这里）。
 *
 * 约束与推导（默认 8/6/4 mil）：
 *   · 振幅 A ≥ width + 2×clearance = 20 mil（长号两条边条与"没被替换的那段自身铜"净距 = 2×clearance）
 *   · 齿顶横腿长度 w ≥ clearance + width/2 = 10 mil（相邻齿两条竖直腿的中心距就是 w，再近就挤在一起）
 *   · 齿数 n 给出网格：span = n×w + (n−1)×minRun，净增 = 2nA − (返回腿)，返回腿 = max(0, span − L)
 *   · 需要补的长度 delta = 2·A·n ⇒ A = delta / (2n)。n 越大 A 越小、跨度越大。
 * 因为 span 一超过线段长就会出现"返回腿"，净增随 span 线性下降，所以对每个 n 都存在**闭式解**：
 *   span = (2nA − delta − (n−1)·minRun + L) / 2   （返回腿区间内）
 * 先取"刚好补够"的闭式跨度，再按 4 mil 栅格向上取整（宁可多补一点点也绝不欠补），最后用解析间距
 * （traceGapAgainst）判断它到底能不能塞进板面。返回按"振幅最小优先"排序的候选列表。
 */
function meanderSolutionsOnSegment({ a, b, layer, deltaMil, options }) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(length > 2)) return [];
  const width = options.widthMil;
  const clearance = options.clearanceMil;
  const cell = options.gridMil;
  const minAmplitude = width + 2 * clearance; // 8 + 12 = 20 mil
  const minRun = clearance + width / 2; // 6 + 4 = 10 mil
  const budget = Number(options.maxMeanderAmplitudeMil) || DIFF_PAIR_DEFAULTS.maxMeanderAmplitudeMil;
  const maxAmplitude = Math.max(minAmplitude, Math.min(budget, length / 2));
  const maxTeeth = Math.max(1, Math.min(Number(options.maxMeanderTeeth) || DIFF_PAIR_DEFAULTS.maxMeanderTeeth, Math.floor(length / (2 * minRun))));
  const snapUp = (value) => Math.ceil(value / cell - 1e-9) * cell;
  const solutions = [];
  const seen = new Set();
  // 对一组 (齿数 n, 齿顶横腿 w, 齿间距 stride)，振幅 A 从"公式解"开始按栅格往上试几档并取最优：
  //   · A 栅格化（真机坐标必须落在 gridMil 上）会带来 ±几个 mil 的净增偏差
  //   · w 是水平长度、可以取任意整数值，但这里也按栅格扫（够用且好解释）
  // 每个组合只保留"过冲到 delta 最少"的那条，最后按净增精度/振幅排序。
  const consider = (n, w, stride) => {
    const useStride = n === 1 ? 0 : stride;
    if (n > 1 && useStride < w - 1e-9) return; // 相邻齿的腿要留够间距
    const span = n === 1 ? w : n * (2 * w + useStride) - useStride;
    if (span > length + 1e-9) return;
    const tail = Math.max(0, length - span);
    const seed = Math.max(minAmplitude, (deltaMil + w - tail) / (2 * n));
    const startAmplitude = snapUp(seed);
    const amplitudeCeil = Math.min(maxAmplitude, startAmplitude + 8 * cell);
    // 净增恒等于 2·A·n（每条竖直腿各 A，水平位移之和恰好等于线段长 L），所以"恰好补够"的
    // 闭式振幅 = delta/(2n)，和 w/stride 都无关。只按 gridMil 栅格试会系统性丢档：
    // 真板 n=10 需要 ≈21.69 mil，栅格只能给 24（gain 480，残余 46 mil > 10 mil 限制，被拒），
    // 再往上只剩更大的振幅 ⇒ 小振幅档位整档不存在，最后只能选会挤到差分伙伴的大振幅。
    // 因此在栅格候选之外，贴着闭式解补一小撮细分候选（共 6 档），候选总数仍然很小；
    // 顺序仍是振幅升序，"最小可行振幅优先"的口径不变。
    const exactAmplitude = deltaMil / (2 * n);
    const refined = exactAmplitude >= minAmplitude - 1e-9 && exactAmplitude <= maxAmplitude + 1e-9
      ? [exactAmplitude, exactAmplitude * 1.002, exactAmplitude * 1.005, exactAmplitude * 1.01, exactAmplitude * 1.02, exactAmplitude * 1.05]
        .filter((value) => value >= minAmplitude - 1e-9 && value <= maxAmplitude + 1e-9)
      : [];
    const candidates = [
      ...refined,
      ...Array.from({ length: 9 }, (_, step) => startAmplitude + step * cell).filter((value) => value <= amplitudeCeil + 1e-9),
    ].sort((left, right) => left - right)
      .filter((value, index, all) => all.findIndex((other) => Math.abs(other - value) <= 1e-9) === index);
    let geometry = null;
    let amplitude = 0;
    for (const candidate of candidates) {
      const built = meanderGeometry(a, b, n, toFixed6(span), toFixed6(w), candidate, 1, useStride);
      if (!built) continue;
      if (built.gain + 1e-9 < deltaMil) continue; // 欠补不接受
      if (!geometry || built.gain < geometry.gain - 1e-9) { geometry = built; amplitude = candidate; }
      if (geometry.gain - deltaMil <= 1e-6) break; // 已经精确命中，不必再往上试
    }
    if (!geometry) return;
    const key = `${n}|${toFixed6(w)}|${toFixed6(useStride)}|${toFixed6(span)}|${amplitude}`;
    if (seen.has(key)) return;
    seen.add(key);
    solutions.push({
      toothCount: n,
      amplitudeMil: amplitude,
      segments: geometry.segments.map((segment) => ({ layer, x1: toFixed6(segment.x1), y1: toFixed6(segment.y1), x2: toFixed6(segment.x2), y2: toFixed6(segment.y2) })),
      // spanMil = 长号实际占用的走廊长度（第一个齿到最后一个齿，沿原线段方向），
      // 不是"齿距 × 齿数"那种会被高估的估算值：Lead 要拿它判断这段走廊到底放不放得下。
      spanMil: toFixed6(n === 1 ? w : (n - 1) * (w + useStride) + w),
      runMil: toFixed6(w),
      // 相邻齿同侧腿的净距（复核断言会读它；缺字段会被读成 undefined 而判失败）。
      spacingMil: toFixed6(n === 1 ? w : (span - w) / (n - 1)),
      strideMil: toFixed6(useStride),
      returnLegMil: toFixed6(Math.max(0, geometry.returnLeg)),
      gainMil: toFixed6(geometry.gain),
      achievedDeltaMil: toFixed6(geometry.gain),
      residualMil: toFixed6(geometry.gain - deltaMil),
      exact: Math.abs(geometry.gain - deltaMil) <= 1e-6,
    });
  };
  // 三个维度都在 gridMil 栅格上扫：齿数 n、齿顶横腿 w、齿间距 stride
  for (let n = 1; n <= maxTeeth; n += 1) {
    for (let w = minRun; w <= length + 1e-9; w += cell) {
      for (let stride = minRun; stride <= length + 1e-9; stride += cell) {
        const span = n === 1 ? w : n * (2 * w + stride) - stride;
        if (span > length + 1e-9) break;
        consider(n, w, stride);
      }
      if (n === 1) break; // 单齿与 stride 无关
    }
  }
  // 每个齿数保留精确解 + 最接近的一条
  const best = new Map();
  for (const entry of solutions) {
    if (entry.exact) { best.set(`exact|${entry.toothCount}`, entry); continue; }
    const current = best.get(entry.toothCount);
    if (!current) { best.set(entry.toothCount, entry); continue; }
    const score = (item) => [Math.abs(item.residualMil), item.amplitudeMil, item.runMil];
    const left = score(entry);
    const right = score(current);
    let better = 0;
    for (let i = 0; i < left.length && !better; i += 1) if (Math.abs(left[i] - right[i]) > 1e-9) better = left[i] - right[i];
    if (better < 0) best.set(entry.toothCount, entry);
  }
  solutions.length = 0;
  solutions.push(...best.values());
  solutions.sort((left, right) => (left.amplitudeMil - right.amplitudeMil)
    || (Number(right.exact) - Number(left.exact))
    || (left.toothCount - right.toothCount));
  // 双侧搜索：把每个解镜像到线段的另一侧（沿线段轴反射，沿法向取反）。
  // 差分对的"伙伴线"通常就是最近的一块异网铜，如果长号只朝一侧凸，必然撞伙伴
  // （真板 USB_DP 宿主离 USB_DM 只有 42.9 mil，而解的最小振幅约 20~44 mil）。
  // 镜像不改变折线长度（增益相同）、端点同样严格重合，只是换个方向占用空间。
  const hostLength = Math.hypot(b.x - a.x, b.y - a.y);
  let mirrored = [];
  if (hostLength > 0) {
    const ux = (b.x - a.x) / hostLength;
    const uy = (b.y - a.y) / hostLength;
    const reflect = (x, y) => {
      const dx = x - a.x;
      const dy = y - a.y;
      const along = dx * ux + dy * uy;
      const normal = dx * -uy + dy * ux;
      return { x: a.x + ux * along + uy * normal, y: a.y + uy * along - ux * normal };
    };
    mirrored = solutions.map((solution) => {
      const segments = solution.segments.map((g) => {
        const p1 = reflect(g.x1, g.y1);
        const p2 = reflect(g.x2, g.y2);
        return { ...g, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
      });
      return { ...solution, mirrored: true, segments };
    }).filter((solution) => endpointsPreserved(solution.segments, a, b));
  }
  return [...solutions, ...mirrored];
}

/** 长号的每个新段都必须离异网铜 ≥ clearance，且整条折线在板框内。 */
function meanderFits({ segments, layer, geometry, outline, settings, excludeNet }) {
  for (const segment of segments) {
    const gap = traceGapAgainst(segment, segment, layer, {
      geometry, width: settings.widthMil, excludeNet, viaOuterDiameter: settings.viaOuterDiameterMil, reserved: settings.reserved ?? [],
    });
    if (!(gap >= settings.clearanceMil - 0.01)) return false;
  }
  const margin = settings.edgeClearanceMil == null ? settings.clearanceMil : Number(settings.edgeClearanceMil);
  return segmentsInsideBoard(segments, outline, margin);
}

/**
 * 差分对等长补偿规划（纯规划，不写 EDA）。
 * 对每一对 |ΔL| > limitMil 的差分对：取**较短那一条**网络上的一段既有直线段，用一个长号
 * （trombone/meander）把它替换掉，补上恰好需要的长度；端点严格不变 ⇒ 连通性由构造保证。
 * 找不到安全长号的对，**绝不静默丢弃**，一律进 unplannable 并给出具体原因。
 */
export function planPairSkewCompensation({ geometry: geometryInput, pairs = [], options = {} }) {
  const settings = { ...DIFF_PAIR_DEFAULTS, ...options };
  const geometry = normalizeGeometry(geometryInput);
  const outline = outlinePolygon(settings.outline ?? geometryInput?.outline ?? null, Number(settings.outlineMarginMil) || 0);
  const measured = measureNetLengths(geometry, settings);
  const lengthOf = new Map(measured.nets.map((entry) => [entry.net, entry]));
  const edges = copperEdgesByNet(geometry, { contactTolMil: settings.contactTolMil });
  const allowLayers = Array.isArray(settings.meanderLayers) && settings.meanderLayers.length
    ? settings.meanderLayers
    : (settings.meanderLayer == null ? null : [settings.meanderLayer]);

  const plan = { pairs: [], unplannable: [], metadata: { ...measured.metadata, skewLimitMil: settings.skewLimitMil, outlineChecked: Boolean(outline) } };
  const list = Array.isArray(pairs) ? pairs : [];
  for (const entry of list) {
    const positive = String(entry?.positive ?? '');
    const negative = String(entry?.negative ?? '');
    const pair = { positive, negative, source: entry?.source ?? 'input' };
    const posLength = lengthOf.get(positive)?.totalMil ?? 0;
    const negLength = lengthOf.get(negative)?.totalMil ?? 0;
    if (!posLength || !negLength) {
      plan.unplannable.push({ pair, reason: `长度为 0：${!posLength ? positive : negative} 在铜快照里量不到长度（可能是空网名或不存在的网络）` });
      continue;
    }
    const skewBeforeMil = Math.abs(posLength - negLength);
    if (skewBeforeMil <= settings.skewLimitMil) {
      // 已经等长：一个字节都不改
      plan.pairs.push({ pair, skewBeforeMil: toFixed6(skewBeforeMil), neededMil: 0, matched: true, edits: [], skewAfterMil: toFixed6(skewBeforeMil) });
      continue;
    }
    const neededMil = skewBeforeMil; // 需要给较短那条补上的长度
    const shorter = posLength < negLength ? positive : negative;
    const candidates = [];
    for (const [layer, layerEdges] of edges.get(shorter)?.layers ?? new Map()) {
      if (allowLayers && !allowLayers.includes(layer)) continue;
      for (const segment of layerEdges) {
        if (segment.arc || (segment.x1 === segment.x2 && segment.y1 === segment.y2)) continue;
        if (segment.line?.replaceable === false) continue;
        candidates.push({ layer, segment, length: segment.length });
      }
    }
    // 先从最长的段试起：长号要吃掉十几到几十 mil 的锯齿，长段才有余地
    candidates.sort((left, right) => (left.layer === settings.meanderLayer ? 0 : 1) - (right.layer === settings.meanderLayer ? 0 : 1) || (right.length - left.length));

    let accepted = null;
    const reasons = [];
    const diagnostics = [];
    const evaluated = [];
    const edgeMargin = settings.edgeClearanceMil == null ? settings.clearanceMil : Number(settings.edgeClearanceMil);
    const shortName = String(shorter?.net ?? shorter?.name ?? shorter ?? '');
    for (const [candidateIndex, candidate] of candidates.slice(0, Math.max(1, Number(settings.maxCandidateSegments) || 12)).entries()) {
      const length = candidate.length;
      if (length < 4 * settings.widthMil) { if (reasons.length < 20) reasons.push(`候选段 #${candidateIndex + 1} (${toFixed6(length)} mil)：比 4×线宽还短，放不下任何长号`); continue; }
      const ratioBudget = Number(settings.maxDetourRatio) > 0 ? Number(settings.maxDetourRatio) : 10;
      if (neededMil > length * (ratioBudget - 1) + 1e-9) {
        if (reasons.length < 20) reasons.push(`候选段 #${candidateIndex + 1} (${toFixed6(length)} mil)：按绕线倍数 ${ratioBudget} 最多补 ${toFixed6(length * (ratioBudget - 1))} mil，不够 ${toFixed6(neededMil)} mil`);
        continue; // 绕线倍数预算：这条段吃不下
      }
      const solutions = meanderSolutionsOnSegment({
        a: { x: candidate.segment.x1, y: candidate.segment.y1 },
        b: { x: candidate.segment.x2, y: candidate.segment.y2 },
        layer: candidate.layer,
        deltaMil: neededMil,
        options: settings,
      });
      if (!solutions.length) {
        if (reasons.length < 20) reasons.push(`候选段 #${candidateIndex + 1} (${toFixed6(length)} mil)：在该段长度内凑不出净增 ${toFixed6(neededMil)}±${settings.skewLimitMil} mil 的长号`);
        continue;
      }
      let blocked = null;
      let blockedAmplitudeMil = Infinity;
      let blockedDiagnostic = null;
      for (const solution of solutions) {
        if (solution.residualMil > settings.skewLimitMil + 1e-9) continue; // 补出来的剩余误差必须仍在 skew 限制内
        // 判间距的"异网铜"：整张铜面里剔掉本网全部铜（含将要被替换掉的那条原线）。
        // 剔掉本网是因为长号要顶替本网的这条线（否则会跟自己比间距，空板夹具也会判"间距不足 6 mil"）；
        // 其余网（含同层其他本网铜）全部照常参与间隙计算。
        // id 必须"非空"才算数：快照里很多图元没有 id（normalizeGeometry 会把它写成 ''），
        // 用 `!= null` 判断会让 originalId = ''，随后把所有没 id 的异网铜一并删掉 ——
        // meanderFits 面对空铜面必然放行，长号就可能直接压到别的网上（实测会短路）。
        const originalId = candidate.segment.line?.id ? String(candidate.segment.line.id) : null;
        const foreign = {
          ...geometry,
          lines: geometry.lines.filter((line) => String(line.net ?? '') !== shortName
            && !(originalId != null && String(line.id ?? '') === originalId)),
          pads: geometry.pads.filter((pad) => String(pad.net ?? '') !== shortName),
        };
        if (!meanderFits({ segments: solution.segments, layer: candidate.layer, geometry: foreign, outline, settings, excludeNet: shortName })) {
          // 失败必须说清"撞的是谁、差多少 mil"：逐段找最近的异网铜，并算板框越界量。
          let worst = null;
          solution.segments.forEach((segment, segmentIndex) => {
            const near = nearestForeignGap(segment, candidate.layer, { geometry: foreign, width: settings.widthMil, excludeNet: shortName, viaOuterDiameter: settings.viaOuterDiameterMil, reserved: settings.reserved ?? [] });
            if (!worst || near.gapMil < worst.near.gapMil) worst = { segment, segmentIndex, near };
          });
          const out = outlineDeficit(solution.segments, outline, edgeMargin);
          const clearanceShortMil = Math.max(0, settings.clearanceMil - (worst?.near?.gapMil ?? Infinity));
          const outlineShortMil = out && out.deficitMil < -1e-9 ? Math.abs(out.deficitMil) : 0;
          const sideLabel = solution.mirrored ? '反向' : '正向';
          const blockingKind = outlineShortMil > 0 && outlineShortMil >= clearanceShortMil ? 'outline' : 'clearance';
          const text = blockingKind === 'outline'
            ? `候选段 #${candidateIndex + 1} (L=${toFixed6(length)} mil, 层${candidate.layer}, ${sideLabel})：${solution.toothCount} 齿/振幅 ${solution.amplitudeMil} mil 的长号超出板框 ${toFixed6(outlineShortMil)} mil（板框边距需 ${toFixed6(edgeMargin)} mil）`
            : `候选段 #${candidateIndex + 1} (L=${toFixed6(length)} mil, 层${candidate.layer}, ${sideLabel})：${solution.toothCount} 齿/振幅 ${solution.amplitudeMil} mil 的长号第 ${(worst?.segmentIndex ?? 0) + 1} 段离异网铜 ${worst?.near?.net || '(未知网)'} 只有 ${toFixed6(worst?.near?.gapMil ?? 0)} mil（需 ${settings.clearanceMil}，还差 ${toFixed6(clearanceShortMil)} mil）`;
          // 每条候选段只留"振幅最小"的那次失败当代表：振幅最小的方案最省地方，最接近可行。
          if (solution.amplitudeMil < blockedAmplitudeMil) {
            blockedAmplitudeMil = solution.amplitudeMil;
            blocked = text;
            blockedDiagnostic = {
              candidateIndex: candidateIndex + 1, layer: candidate.layer, lengthMil: toFixed6(length), mirrored: Boolean(solution.mirrored),
              toothCount: solution.toothCount, amplitudeMil: solution.amplitudeMil,
              blockingKind,
              blockingNet: worst?.near?.net ?? null, gapMil: Number.isFinite(worst?.near?.gapMil) ? toFixed6(worst.near.gapMil) : null,
              requiredMil: settings.clearanceMil, missingMil: toFixed6(Math.max(clearanceShortMil, outlineShortMil)),
            };
          }
          continue;
        }
        evaluated.push({ candidate, solution, score: [Number(solution.exact) ? 0 : 1, solution.residualMil, solution.toothCount, solution.amplitudeMil, candidate.length] });
        break;
      }
      if (blocked) {
        if (reasons.length < 20) reasons.push(blocked);
        if (blockedDiagnostic) diagnostics.push(blockedDiagnostic);
      }
    }
    // 排序口径：①"精确命中"优先（residual 是 0 或最小）②齿数/振幅更小（更干净、工艺更友好）③段本身短一点（少动板面）
    evaluated.sort((left, right) => (left.score[0] - right.score[0]) || (left.score[1] - right.score[1]) || (left.score[2] - right.score[2]) || (left.score[3] - right.score[3]) || (left.score[4] - right.score[4]));
    if (evaluated.length) accepted = evaluated[0];

    if (!accepted) {
      const nearMiss = candidates.length ? 'no segment with enough free space' : 'no replaceable straight segment on the shorter net';
      const shortfall = diagnostics.length ? Math.min(...diagnostics.map((entry) => entry.missingMil)) : null;
      const detail = reasons.length
        ? reasons.slice(0, 3).join('；')
        : (candidates.length ? `绕线倍数/长度预算内没有可用长号` : `该网在图层 ${allowLayers.join('/')} 上没有可替换的直线段`);
      plan.unplannable.push({
        pair,
        reason: `${nearMiss}（需补 ${toFixed6(neededMil)} mil；${shortfall != null ? `最接近的一条还差 ${toFixed6(shortfall)} mil 空间；` : ''}${detail}）`,
        neededMil: toFixed6(neededMil),
        candidateSegments: candidates.length,
        skewBeforeMil: toFixed6(skewBeforeMil),
        ...(shortfall != null ? { missingSpaceMil: toFixed6(shortfall) } : {}),
        details: diagnostics.slice(0, 12),
      });
      continue;
    }

    const { candidate, solution } = accepted;
    const original = candidate.segment;
    const remove = {
      id: original.line?.id ? String(original.line.id) : null,
      layer: candidate.layer,
      x1: original.x1, y1: original.y1, x2: original.x2, y2: original.y2,
      width: original.line?.width ?? settings.widthMil,
      lengthMil: toFixed6(original.length),
    };
    const applyAfter = skewBeforeMil - solution.achievedDeltaMil;
    plan.pairs.push({
      pair,
      skewBeforeMil: toFixed6(skewBeforeMil),
      neededMil: toFixed6(neededMil),
      matched: false,
      edits: [{
        net: shorter, layer: candidate.layer, remove, add: solution.segments,
        toothCount: solution.toothCount,
        amplitudeMil: solution.amplitudeMil,
        spanMil: solution.spanMil,
        runMil: solution.runMil,
        strideMil: solution.strideMil,
        returnLegMil: solution.returnLegMil,
        addedMil: solution.achievedDeltaMil,
        residualMil: solution.residualMil,
        exact: solution.exact,
        endpointsPreserved: endpointsPreserved(solution.segments, { x: original.x1, y: original.y1 }, { x: original.x2, y: original.y2 }),
      }],
      // skew 一律报绝对值（和 skewBeforeMil 同口径）：补多了只是"另一条更长"，不是负的长度差。
      skewAfterMil: toFixed6(Math.abs(applyAfter)),
    });
  }
  return plan;
}

/**
 * 独立复核：在**已应用**的几何上重算长度与间距。
 * 复核必须和规划走不同口径：这里只信量出来的铜长，绝不复用规划期的 delta。
 */
export function verifyPairMatching({ geometry: geometryInput, plan = null, options = {}, pairResults = null } = {}) {
  const settings = { ...DIFF_PAIR_DEFAULTS, ...options };
  const geometry = normalizeGeometry(geometryInput);
  const outline = outlinePolygon(settings.outline ?? geometryInput?.outline ?? null, Number(settings.outlineMarginMil) || 0);
  const results = Array.isArray(pairResults) ? pairResults : (plan?.pairs ?? []);
  const measured = measureNetLengths(geometry, settings);
  const lengthOf = new Map(measured.nets.map((entry) => [entry.net, entry]));
  const violations = [];
  let minGapMil = Infinity;
  const pairs = [];
  for (const entry of results) {
    const positive = String(entry?.pair?.positive ?? entry?.positive ?? '');
    const negative = String(entry?.pair?.negative ?? entry?.negative ?? '');
    const pair = { positive, negative };
    const posLength = lengthOf.get(positive)?.totalMil ?? 0;
    const negLength = lengthOf.get(negative)?.totalMil ?? 0;
    const skewMil = Math.abs(posLength - negLength);
    let pass = skewMil <= settings.skewLimitMil + 1e-9;
    if (!posLength || !negLength) {
      pass = false;
      violations.push({ kind: 'length-missing', net: !posLength ? positive : negative, skewMil: toFixed6(skewMil), limitMil: settings.skewLimitMil });
    }
    // 每条新增铜都要独立重算间距：这是"规划说合规、复核说不合规"的唯一防线
    for (const edit of entry?.edits ?? []) {
      const layer = edit.layer ?? settings.meanderLayer;
      for (const segment of edit.add ?? []) {
        const gap = traceGapAgainst(segment, segment, layer, {
          geometry, width: settings.widthMil, excludeNet: edit.net, viaOuterDiameter: settings.viaOuterDiameterMil, reserved: settings.reserved ?? [],
        });
        if (Number.isFinite(gap)) minGapMil = Math.min(minGapMil, gap);
        if (gap < settings.clearanceMil - 0.01) {
          pass = false;
          violations.push({ kind: 'clearance', net: edit.net, layer, x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2, gapMil: toFixed6(gap), requiredMil: settings.clearanceMil });
        }
      }
      if (!endpointsPreserved(edit.add ?? [], { x: edit.remove?.x1, y: edit.remove?.y1 }, { x: edit.remove?.x2, y: edit.remove?.y2 })) {
        pass = false;
        violations.push({ kind: 'endpoint-not-preserved', net: edit.net, layer });
      }
      if (outline) {
        const margin = settings.edgeClearanceMil == null ? settings.clearanceMil : Number(settings.edgeClearanceMil);
        if (!segmentsInsideBoard(edit.add ?? [], outline, margin)) {
          pass = false;
          violations.push({ kind: 'outline', net: edit.net, layer });
        }
      }
    }
    pairs.push({ pair, skewMil: toFixed6(skewMil), limitMil: settings.skewLimitMil, pass });
  }
  const ok = violations.length === 0 && pairs.every((entry) => entry.pass);
  return {
    ok,
    pairs,
    violations,
    minGapMil: Number.isFinite(minGapMil) ? toFixed6(minGapMil) : null,
    clearanceMil: settings.clearanceMil,
    metadata: measured.metadata,
  };
}

/** 从几何里摘掉一条计划要替换的旧走线（应用后的铜面 = 旧线删除 + 长号折线加入）。 */
function geometryWithEditApplied(geometry, edit) {
  const remove = edit.remove ?? {};
  const index = geometry.lines.findIndex((line) => (remove.id && String(line.id) === String(remove.id))
    || (line.layer === remove.layer
      && Math.abs(line.x1 - remove.x1) <= 1 && Math.abs(line.y1 - remove.y1) <= 1
      && Math.abs(line.x2 - remove.x2) <= 1 && Math.abs(line.y2 - remove.y2) <= 1));
  const lines = index >= 0 ? [...geometry.lines.slice(0, index), ...geometry.lines.slice(index + 1)] : geometry.lines.slice();
  for (const segment of edit.add ?? []) {
    lines.push({ id: null, net: edit.net, layer: edit.layer, x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2, width: edit.remove?.width ?? ROUTING_DEFAULTS.widthMil });
  }
  return normalizeGeometry({ lines, vias: geometry.vias, pads: geometry.pads });
}

/**
 * 应用差分对等长计划：与 applyRoutingPlan 同一套纪律。
 * ①先独立复核；②批量写；③回读比对（新铜按 ID 或 ≤1mil 精确几何或"合并进同网长线"三种命中之一）；
 * ④旧线删除必须回读确认"确实没了"；⑤任何缺失都触发回滚（删新铜 + 把删掉的旧线原样补回）并如实报残留。
 * dryRun 默认 true —— Lead 必须显式要求才会动真机。
 */
export async function applyPairMatchingPlan({ execute, plan, geometry: geometryInput, dryRun = true, save = false, options = {} }) {
  if (typeof execute !== 'function') throw Object.assign(new Error('缺少 execute'), { code: 'ROUTING_EXECUTE_REQUIRED' });
  const settings = { ...DIFF_PAIR_DEFAULTS, ...options };
  const edits = [];
  const pairResults = [];
  for (const entry of plan?.pairs ?? []) {
    const appliedEdits = [];
    for (const edit of entry?.edits ?? []) {
      edits.push(edit);
      appliedEdits.push(edit);
    }
    pairResults.push({ pair: entry.pair, edits: appliedEdits });
  }
  if (!edits.length) throw Object.assign(new Error('计划里没有可执行的差分对等长项'), { code: 'ROUTING_PLAN_EMPTY' });

  // 独立复核的对象是"旧线删掉 + 长号加上"之后的铜面，而不是当前铜面（否则长度是旧的，复核没有意义）
  let appliedGeometry = normalizeGeometry(geometryInput);
  for (const edit of edits) appliedGeometry = geometryWithEditApplied(appliedGeometry, edit);
  const verification = verifyPairMatching({ geometry: appliedGeometry, plan, options: settings, pairResults });
  if (!verification.ok) {
    throw Object.assign(new Error(`差分对等长计划未通过独立复核（违规 ${verification.violations.length} 条：${verification.violations.slice(0, 3).map((item) => item.kind).join('/')}）`), { code: 'ROUTING_PLAN_REJECTED', detail: verification });
  }
  if (dryRun) return { ok: true, dryRun: true, verification, executed: 0, saved: false, pairs: verification.pairs };

  const written = [];
  const removedOriginals = [];
  const idOf = (result) => String(result?.result?.primitiveId ?? result?.result?.id ?? result?.primitiveId ?? result?.id ?? '');
  const readCopper = async () => normalizeGeometry((await execute('pcb.copper.read', {}, {}))?.result ?? {});
  const writeLine = async ({ net, layer, x1, y1, x2, y2, width }) => {
    const created = await execute('pcb.line.create', { net, layer, startX: x1, startY: y1, endX: x2, endY: y2, lineWidth: width ?? settings.widthMil, primitiveLock: false }, { allowWrite: true });
    if (settings.writeSpacingMs > 0) await new Promise((resolve) => setTimeout(resolve, settings.writeSpacingMs));
    return { kind: 'line', id: idOf(created), net, layer, x: x1, y: y1, x2, y2, width: width ?? settings.widthMil };
  };
  const deleteLines = async (ids) => {
    const list = (ids ?? []).filter(Boolean);
    if (!list.length) return;
    await execute('pcb.lines.delete', { primitiveIds: list }, { allowWrite: true });
  };
  const aliveLineIds = async () => {
    const current = await readCopper();
    return new Set(current.lines.map((line) => String(line.id ?? '')).filter(Boolean));
  };
  const findOriginalId = async (edit) => {
    if (edit.remove?.id) return String(edit.remove.id);
    const current = await readCopper();
    const match = current.lines.find((line) => line.net === edit.net && line.layer === edit.layer
      && Math.abs(line.x1 - edit.remove.x1) <= 1 && Math.abs(line.y1 - edit.remove.y1) <= 1
      && Math.abs(line.x2 - edit.remove.x2) <= 1 && Math.abs(line.y2 - edit.remove.y2) <= 1);
    return match?.id ? String(match.id) : '';
  };
  const rollbackAll = async () => {
    // 回滚顺序有讲究：①先把自己写进去的新铜删掉 ②再把删过的旧线按原几何补回来
    // （真机上"批量删除静默失败"是常态，所以删完必须回读；补回旧线后如果照样没删掉，
    //   就把 L-P 这类旧线再删一遍，最后把仍存活的如实写进 residual——绝不假装回滚成功）
    const newIds = written.map((item) => item.id).filter(Boolean);
    for (const id of newIds) {
      try { await deleteLines([id]); } catch { /* 逐个删除失败也要在 residual 里体现 */ }
    }
    const restored = [];
    const aliveBeforeRestore = await aliveLineIds();
    for (const original of removedOriginals) {
      const originalAlive = aliveBeforeRestore.has(String(original.id));
      if (originalAlive) {
        // 原线其实没被删掉（真机批量删除静默失败是常态）：它还在板上，补写只会造成重复铜，
        // 所以不补写，只重试删掉它即可。
        try { await deleteLines([original.id]); } catch { /* 删不掉会在 residual 里体现 */ }
        continue;
      }
      // 原线确实已被删掉：补回的这一份**就是板上唯一的那段铜**，绝不能再删掉它。
      // （之前的实现无条件删除副本，导致"删了原线 + 回滚又把副本删掉" ⇒ 板上直接丢铜，
      //   真机事故：USB_DP 段数 116→115、失配 433.7→858.0 mil。）
      try {
        const copy = await writeLine({ ...original });
        restored.push({ ...original, id: String(copy?.id ?? copy?.result?.primitiveId ?? original.id) });
      } catch { /* 补不回来会在 residual 里体现 */ }
    }
    let residual = [];
    try {
      const alive = await aliveLineIds();
      residual = [
        ...newIds.filter((id) => alive.has(String(id))),
        ...removedOriginals.filter((original) => alive.has(String(original.id))).map((original) => String(original.id)),
      ];
    } catch { /* 回读失败不掩盖原始错误，但 residual 会为空——调用方从错误信息里仍能看到原始失败 */ }
    return { restored, residual };
  };

  try {
    for (const edit of edits) {
      const originalId = await findOriginalId(edit);
      if (originalId) {
        await deleteLines([originalId]);
        removedOriginals.push({ kind: 'line', id: originalId, net: edit.net, layer: edit.layer, x1: edit.remove.x1, y1: edit.remove.y1, x2: edit.remove.x2, y2: edit.remove.y2, width: edit.remove.width });
      }
      for (const segment of edit.add) written.push(await writeLine({ net: edit.net, layer: edit.layer, x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2 }));
    }

    // 回读必须等到 EDA 真落盘，并且按"ID → 精确几何 → 合并进同网长线"三种命中逐一核对
    let after = null;
    let missing = [];
    const attempts = Math.max(1, Number(settings.readbackAttempts) || 15);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      after = await readCopper();
      const ids = new Set([...after.lines, ...after.vias].map((item) => String(item.id ?? '')));
      const linesLeft = after.lines.slice();
      missing = [];
      for (const item of written) {
        if (item.id && ids.has(String(item.id))) continue;
        const index = linesLeft.findIndex((line) => line.layer === item.layer && Math.abs(line.x1 - item.x) <= 1 && Math.abs(line.y1 - item.y) <= 1 && Math.abs(line.x2 - item.x2) <= 1 && Math.abs(line.y2 - item.y2) <= 1);
        if (index >= 0) { linesLeft.splice(index, 1); continue; }
        // 真机实测：EDA 会把新画的短走线合并进相邻同网同层走线，创建时返回的ID随即失效——铜确实在板上
        const merged = after.lines.some((line) => line.net === item.net && line.layer === item.layer
          && pointSegmentDistance(item.x, item.y, line) <= 1.5 && pointSegmentDistance(item.x2, item.y2, line) <= 1.5);
        if (merged) continue;
        missing.push(item);
      }
      // 删除也必须核对：旧线如果还活着，等于板上多了一段铜（长度对不上、甚至短路）
      const stillThere = removedOriginals.filter((original) => ids.has(String(original.id)));
      if (!missing.length && !stillThere.length) break;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, Number(settings.readbackSettleMs) || 300));
    }
    const ids = new Set([...after.lines, ...after.vias].map((item) => String(item.id ?? '')));
    const missingDeletes = removedOriginals.filter((original) => ids.has(String(original.id)));
    // 真机实测：PCB 图元的 id 在每次回读之间是易变的（同一段未改动的线三次读回三个不同 id），
    // 因此"按 id/几何逐个确认新铜"会把其实已经写上去的铜误报为缺失，进而触发不必要的回滚。
    // 这里补一条**与 id 无关**的强证据：用同一份回读重算两条网络的铜长，
    // 只有当"目标失配确实达成"且"补长确实存在"时才认可写入（不放宽任何阈值）。
    let lengthEvidence = '';
    if (missing.length && !missingDeletes.length) {
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      const lengthOf = (source, net) => source
        .filter((line) => String(line.net ?? '') === net)
        .reduce((sum, line) => sum + Math.hypot(num(line.x2) - num(line.x1), num(line.y2) - num(line.y1)), 0);
      const planPair = plan?.pairs?.[0];
      const positive = String(planPair?.pair?.positive ?? '');
      const negative = String(planPair?.pair?.negative ?? '');
      const plannedAdded = (planPair?.edits ?? []).reduce((sum, edit) => sum + Number(edit.addedMil ?? 0), 0);
      const limit = Number(settings.skewLimitMil) || 10;
      if (positive && negative && plannedAdded > 0) {
        const afterLen = lengthOf(after.lines, positive);
        const otherLen = lengthOf(after.lines, negative);
        const skewNow = Math.abs(afterLen - otherLen);
        const grew = afterLen - lengthOf(geometryInput?.lines ?? [], positive);
        if (skewNow <= limit && Math.abs(grew - plannedAdded) <= 2) {
          lengthEvidence = `按网络铜长复核：${positive} 补长 ${grew.toFixed(3)} mil（计划 ${plannedAdded.toFixed(3)}），失配 ${skewNow.toFixed(3)} ≤ ${limit} ⇒ 铜确实已写上去（id 易变导致逐个确认失效）`;
          missing = [];
        }
      }
    }
    if (missing.length || missingDeletes.length) {
      const rollback = await rollbackAll();
      throw Object.assign(new Error(`写入后回读比对失败：新增 ${missing.length} 段找不到、旧线 ${missingDeletes.length} 段没删掉，已回滚（残留 ${rollback.residual.length}）`), {
        code: 'ROUTING_READBACK_MISMATCH',
        missing: missing.length,
        residual: rollback.residual,
        details: { missing: missing.map((item) => ({ net: item.net, layer: item.layer, x: item.x, y: item.y, x2: item.x2, y2: item.y2 })), missingDeletes: missingDeletes.map((item) => item.id), residual: rollback.residual },
      });
    }
    let saved = false;
    if (save) {
      await execute('pcb.save', {}, { allowWrite: true });
      saved = true;
    }
    return { ok: true, dryRun: false, executed: written.length, removed: removedOriginals.length, saved, verification, pairs: verification.pairs, written: written.map((item) => ({ kind: item.kind, net: item.net, id: item.id })) };
  } catch (error) {
    if (!error?.code || error.code === 'EDA_WRITE_BLOCKED' || error.code === 'BRIDGE_HTTP_ERROR') {
      try { await rollbackAll(); } catch { /* 回滚失败不再掩盖原始错误 */ }
    }
    throw error;
  }
}
