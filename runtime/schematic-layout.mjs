/**
 * 原理图可读性布局（纯函数，无 IO、无依赖、确定性）。
 *
 * 为什么需要它（2026-10-28 PCB 布局评审 R1/R2）：
 *  1. 网络标签朝向恒为 0（朝右）：`schematic.netPort.create` 不传 rotation 时立创EDA 默认朝右，
 *     于是元件四周的网络名全都向右伸，直接压在元件符号上；相邻标签之间也互相叠字。
 *  2. 元件落位是固定 4 列 220×170 网格：32 脚 IC 与 0402 电阻占同样大的格位，也不按连接关系
 *     分区，原理图又挤又散——评审会上的原话是"重叠严重、特别闷"。
 *
 * 本模块只做"算"：估计符号/标签尺寸、按连通簇分带落位、给每个网络端口挑朝向、审计可读性。
 * 任何写入（create/delete/save）仍由调用方（net-connect / schematic-repair）按原有安全语义执行：
 * 这里不碰桥、不猜身份、不发写命令，也不重试。
 */

/**
 * 网络端口朝向约定（**集中在这一处**，真机若相反只改这张表）。
 *
 * 0=右、90=上、180=左、270=下，单位是度。
 * 假设：立创EDA `schematic.netPort.create` 的 rotation 与画布角度一致，0 表示端口/标签从锚点
 * 向右延伸；原理图画布 y 轴向下，因此 90 = 向上（-y）、270 = 向下（+y）。
 * 这是"标签全朝右压元件"现象下最自然的解释，但尚未在真机逐角度验证；
 * 若真机表现相反（例如 90 实际朝下），只改这张表 + 下方 OUTWARD_ROTATION 即可，
 * 其余算法（碰撞打分、审计）全部按方向语义工作，不写死角度。
 */
export const LABEL_ROTATION = Object.freeze({ RIGHT: 0, UP: 90, LEFT: 180, DOWN: 270 });

/** 方向 → 角度（与 LABEL_ROTATION 必须同步；只在这里做一次映射）。 */
const OUTWARD_ROTATION = Object.freeze({ right: LABEL_ROTATION.RIGHT, up: LABEL_ROTATION.UP, left: LABEL_ROTATION.LEFT, down: LABEL_ROTATION.DOWN });

/** 角度 → 方向（审计/回读时用；未知角度按"朝右"处理并交给上层记录）。 */
const DIRECTION_BY_ROTATION = new Map([[LABEL_ROTATION.RIGHT, 'right'], [LABEL_ROTATION.UP, 'up'], [LABEL_ROTATION.LEFT, 'left'], [LABEL_ROTATION.DOWN, 'down']]);

/** 平局时的方向顺序 = rotation 升序（0/90/180/270），保证确定性。 */
const DIRECTION_ORDER = Object.freeze(['right', 'up', 'left', 'down']);

export const SCHEMATIC_LAYOUT_CODES = {
  COMPONENTS_EMPTY: 'SCHEMATIC_LAYOUT_COMPONENTS_EMPTY',
  COMPONENT_REF_MISSING: 'SCHEMATIC_LAYOUT_COMPONENT_REF_MISSING',
  COMPONENT_REF_DUPLICATE: 'SCHEMATIC_LAYOUT_COMPONENT_REF_DUPLICATE',
  NET_ENDPOINT_UNKNOWN: 'SCHEMATIC_LAYOUT_NET_ENDPOINT_UNKNOWN',
  COMPONENT_OVERSIZE: 'SCHEMATIC_LAYOUT_COMPONENT_OVERSIZE',
  LABEL_ANCHOR_UNRESOLVED: 'SCHEMATIC_LAYOUT_LABEL_ANCHOR_UNRESOLVED',
  LABEL_DIRECTION_FALLBACK: 'SCHEMATIC_LAYOUT_LABEL_DIRECTION_FALLBACK',
  LABEL_ROTATION_ADJUSTED: 'SCHEMATIC_LAYOUT_LABEL_ROTATION_ADJUSTED',
  LABEL_OVERLAP_REMAINING: 'SCHEMATIC_LAYOUT_LABEL_OVERLAP_REMAINING',
  LABEL_LABEL_OVERLAP: 'SCHEMATIC_LAYOUT_LABEL_LABEL_OVERLAP',
  LABEL_ON_COMPONENT: 'SCHEMATIC_LAYOUT_LABEL_ON_COMPONENT',
  COMPONENT_OVERLAP: 'SCHEMATIC_LAYOUT_COMPONENT_OVERLAP',
};

/** 原理图格点：真机密集引脚列实测间距 10 个单位，落位/尺寸都对齐到它。 */
const GRID = 10;

/**
 * 符号尺寸估计用的常量（保守 = 宁可估大一点，也不要让两个元件框叠在一起）。
 * 真机原理图里 0603 电阻约 80×40、32 脚 IC 约 160×200，同数量级。
 */
const SYMBOL_BASE = Object.freeze({
  connector: Object.freeze({ width: 140, height: 100 }),
  ic: Object.freeze({ width: 120, height: 100 }),
  passive: Object.freeze({ width: 80, height: 50 }),
  other: Object.freeze({ width: 100, height: 60 }),
});
const PIN_PITCH = 10;
/** 每个尺寸至少留出相当于 4 个引脚间距的引脚区，避免"16 脚 IC 估得比 4 脚还小"。 */
const SYMBOL_PIN_PADDING = 4 * PIN_PITCH;

/** 网络标签 AABB 估计：文本宽 ≈ 字符数 × 字宽，高 ≈ 字高，另加内边距。 */
const DEFAULT_LABEL_OPTIONS = Object.freeze({ charWidth: 8, textHeight: 14, padding: 4, minLength: 20, margin: 10 });

/** 布局默认参数：原点 120/120、列间距 40、行间距 40、带间距 60、带最大宽 1200，全部是格点倍数。 */
const DEFAULT_LAYOUT_OPTIONS = Object.freeze({ originX: 120, originY: 120, grid: GRID, gapX: 40, gapY: 40, bandGap: 60, maxBandWidth: 1200 });

/** 小于这个面积（单位²）的接触算"贴边"，不算重叠——避免格点取整带来的浮点噪声。 */
const OVERLAP_EPSILON = 1;

const finiteNumber = (value) => {
  // 注意：Number(null) === 0、Number('') === 0。计划里的 x/y 就是 null（"执行时才落点"），
  // 直接 Number() 会把它当成原点 (0,0)，于是"朝外方向"和碰撞全都算错——必须先把空值挡掉。
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
const nonNegative = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
const alignUp = (value, grid) => Math.max(grid, Math.ceil(value / grid) * grid);
const roundGrid = (value, grid) => Math.round(value / grid) * grid;
const componentId = (component) => component?.primitiveId ?? component?.id ?? null;
const sortStrings = (values) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** 位号自然序比较（U1 < U2 < U10；无数字位号按字符串）。不依赖 locale，跨机器确定。 */
function splitRef(ref) {
  const text = String(ref ?? '');
  const match = /^([^0-9]*)([0-9]+)?(.*)$/.exec(text);
  return [match?.[1] ?? text, match?.[2] === undefined ? -1 : Number(match[2]), match?.[3] ?? ''];
}
export function compareRef(a, b) {
  const [prefixA, numberA, suffixA] = splitRef(a);
  const [prefixB, numberB, suffixB] = splitRef(b);
  if (prefixA !== prefixB) return prefixA < prefixB ? -1 : 1;
  if (numberA !== numberB) return numberA - numberB;
  if (suffixA !== suffixB) return suffixA < suffixB ? -1 : 1;
  return 0;
}

/** 位号前缀 → 器件类别（连接器/IC/无源/其它），用于保守估计符号尺寸。 */
function symbolCategory(ref) {
  const prefix = /^[A-Za-z]+/.exec(String(ref ?? ''))?.[0]?.toUpperCase() ?? '';
  if (/^(J|P|CN|CON|XS|USB|DC)$/.test(prefix)) return 'connector';
  if (/^(U|IC|MCU|SOC|QFN|BGA)$/.test(prefix)) return 'ic';
  if (/^(R|C|L|D|Y|X|Q|FB|LED|F|T)$/.test(prefix)) return 'passive';
  return 'other';
}

/**
 * 估计元件符号的包围盒尺寸（中心对称，单位与原理图坐标一致）。
 *
 * 目的不是画得准，而是给"落位不重叠"和"标签别压符号"一个保守的几何依据：
 * 引脚越多越高，连接器比无源宽，所有结果都对齐到 10 的格点。
 * @param {{ref?:string, pinCount?:number}} [input]
 * @returns {{width:number, height:number}}
 */
export function estimateSymbolSize({ ref, pinCount } = {}) {
  const pins = Math.max(0, Math.floor(Number(pinCount) || 0));
  const base = SYMBOL_BASE[symbolCategory(ref)] || SYMBOL_BASE.other;
  // 双侧出脚的 IC/连接器按"每边 ceil(pins/2) 个"估高度；无源件不随引脚数长高（本来就是 2 脚）。
  const category = symbolCategory(ref);
  const rows = category === 'passive' || category === 'other' ? 0 : Math.ceil(pins / 2);
  const height = Math.max(base.height, rows * PIN_PITCH + SYMBOL_PIN_PADDING);
  const width = base.width;
  return { width: alignUp(width, GRID), height: alignUp(height, GRID) };
}

/** 矩形框（xMin/yMin/xMax/yMax）→ 面积。 */
const boxArea = (box) => Math.max(0, box.xMax - box.xMin) * Math.max(0, box.yMax - box.yMin);

/** 两个矩形框的重叠面积；不重叠返回 0（严格大于，贴边不算）。 */
export function overlapArea(a, b) {
  if (!a || !b) return 0;
  const width = Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin);
  const height = Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin);
  return width > 0 && height > 0 ? width * height : 0;
}

/** 中心点 + 尺寸 → 矩形框。 */
const boxOfCenter = ({ x, y, width, height }) => ({ xMin: x - width / 2, yMin: y - height / 2, xMax: x + width / 2, yMax: y + height / 2 });

/** 点集 → 包围盒（可外扩 margin）；空集返回 null。 */
function boxOfPoints(points, margin = 0) {
  const xs = points.map((point) => point.x).filter(Number.isFinite);
  const ys = points.map((point) => point.y).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  return { xMin: Math.min(...xs) - margin, yMin: Math.min(...ys) - margin, xMax: Math.max(...xs) + margin, yMax: Math.max(...ys) + margin };
}

/** 点集质心（用于元件读回没有 x/y 时估计"主体中心"）；空集返回 null。 */
function centroidOf(points) {
  const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!valid.length) return null;
  return { x: valid.reduce((sum, point) => sum + point.x, 0) / valid.length, y: valid.reduce((sum, point) => sum + point.y, 0) / valid.length };
}

/** 规范化 rotation：只认 0/90/180/270，其余按 0（朝右）并在上层记低置信度。 */
function normalizeRotation(value) {
  const number = Number(value);
  return DIRECTION_BY_ROTATION.has(number) ? number : LABEL_ROTATION.RIGHT;
}

/**
 * 估计一个网络标签的 AABB（从锚点朝 rotation 方向伸出）。
 *
 * 模型是粗粒度 AABB：长度 = max(最短长度, 字宽 × 字符数) + 两侧内边距，
 * 厚度 = 字高 + 两侧内边距。真实渲染的字体/箭头符号更复杂，这里只为"挑一个更不挤的方向"和
 * "审计报出压叠"提供统一口径，不追求像素级准确。
 * @param {{x:number, y:number, rotation?:number, net?:string, options?:object}} input
 */
export function estimateLabelRect({ x, y, rotation = LABEL_ROTATION.RIGHT, net = '', options = {} } = {}) {
  const merged = { ...DEFAULT_LABEL_OPTIONS, ...(options?.label || options || {}) };
  const charWidth = positive(merged.charWidth, DEFAULT_LABEL_OPTIONS.charWidth);
  const textHeight = positive(merged.textHeight, DEFAULT_LABEL_OPTIONS.textHeight);
  const padding = nonNegative(merged.padding, DEFAULT_LABEL_OPTIONS.padding);
  const minLength = positive(merged.minLength, DEFAULT_LABEL_OPTIONS.minLength);
  const anchorX = finiteNumber(x) ?? 0;
  const anchorY = finiteNumber(y) ?? 0;
  const length = Math.max(minLength, String(net ?? '').length * charWidth) + padding * 2;
  const thickness = textHeight + padding * 2;
  const half = thickness / 2;
  switch (normalizeRotation(rotation)) {
    case LABEL_ROTATION.LEFT:
      return { xMin: anchorX - length, yMin: anchorY - half, xMax: anchorX, yMax: anchorY + half, length, thickness };
    case LABEL_ROTATION.UP:
      return { xMin: anchorX - half, yMin: anchorY - length, xMax: anchorX + half, yMax: anchorY, length, thickness };
    case LABEL_ROTATION.DOWN:
      return { xMin: anchorX - half, yMin: anchorY, xMax: anchorX + half, yMax: anchorY + length, length, thickness };
    case LABEL_ROTATION.RIGHT:
    default:
      return { xMin: anchorX, yMin: anchorY - half, xMax: anchorX + length, yMax: anchorY + half, length, thickness };
  }
}

/**
 * 引脚相对元件主体的"朝外方向"。
 * 取主轴（|dx| 与 |dy| 谁大）；平局按水平方向（画布 y 向下：dy > 0 = 引脚在主体下方 = 朝下）。
 */
export function outwardDirection(anchor, center) {
  if (!anchor || !center) return null;
  const dx = finiteNumber(anchor.x) - finiteNumber(center.x);
  const dy = finiteNumber(anchor.y) - finiteNumber(center.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

/** 逐点并查集（无路径压缩以外的优化，纯函数、顺序无关）。 */
function createUnionFind(keys) {
  const parent = new Map(keys.map((key) => [key, key]));
  const find = (key) => {
    let current = key;
    while (parent.get(current) !== current) current = parent.get(current);
    let cursor = key;
    while (parent.get(cursor) !== cursor) { const next = parent.get(cursor); parent.set(cursor, current); cursor = next; }
    return current;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    // 固定按字典序挂根，保证不同调用顺序得到同一棵树（结果与顺序无关）
    if (rootA < rootB) parent.set(rootB, rootA); else parent.set(rootA, rootB);
  };
  return { find, union };
}

/**
 * 元件自动落位：按连通簇分带、带内按(引脚数降序, 位号)排布、格点对齐、保证元件包围盒不重叠。
 *
 * 与旧实现（固定 4 列 220×170）的区别：
 *  · 尺寸来自 estimateSymbolSize（按类别/引脚数），不再"大 IC 和小电阻同格"；
 *  · 同一连通簇（有共同网络）的器件落在同一条带里 = 至少满足"按连接关系分区"的确定性语义；
 *  · 带宽超限就换行，因此任意两个元件框都不重叠（这是 R2 的硬约束）。
 *
 * @param {object} input
 * @param {Array<{ref:string, value?:string, pinCount?:number}>} [input.components] 归一化网表元件
 * @param {Array<{name:string, endpoints:Array<{ref:string, pin:string}>}>} [input.nets]
 * @param {object} [input.options] 布局参数（originX/originY/gapX/gapY/bandGap/maxBandWidth/grid）
 * @returns {{placements:Array<object>, blocks:Array<object>, findings:Array<object>}}
 */
export function layoutSchematicComponents({ components = [], nets = [], options = {} } = {}) {
  const config = { ...DEFAULT_LAYOUT_OPTIONS, ...(options || {}) };
  const grid = positive(config.grid, GRID);
  const findings = [];
  const add = (severity, code, message, extra = {}) => findings.push({ severity, code, message, ...extra });

  const componentList = Array.isArray(components) ? components : (components?.components || []);
  const netList = Array.isArray(nets) ? nets : [];
  const byRef = new Map();
  for (const component of componentList) {
    const ref = String(component?.ref ?? component?.designator ?? '').trim().toUpperCase();
    if (!ref) { add('warning', SCHEMATIC_LAYOUT_CODES.COMPONENT_REF_MISSING, '有一个元件没有位号，无法参与布局'); continue; }
    if (byRef.has(ref)) { add('warning', SCHEMATIC_LAYOUT_CODES.COMPONENT_REF_DUPLICATE, `位号 ${ref} 重复，布局只保留第一个（位号必须唯一才能确定落位）`, { ref }); continue; }
    const explicit = finiteNumber(component?.pinCount);
    byRef.set(ref, { ref, explicitPinCount: explicit !== null && explicit > 0 ? Math.floor(explicit) : 0 });
  }
  if (!byRef.size) {
    add('warning', SCHEMATIC_LAYOUT_CODES.COMPONENTS_EMPTY, '没有任何可布局的元件');
    return { placements: [], blocks: [], findings };
  }

  const refs = [...byRef.keys()].sort(compareRef);
  const pinsByRef = new Map(refs.map((ref) => [ref, new Set()]));
  const unionFind = createUnionFind(refs);
  const memberNets = [];
  const unknownRefs = new Set();
  for (const net of netList) {
    const name = String(net?.name ?? '');
    const endpoints = Array.isArray(net?.endpoints) ? net.endpoints : [];
    const members = new Set();
    for (const endpoint of endpoints) {
      const ref = String(endpoint?.ref ?? '').trim().toUpperCase();
      if (!byRef.has(ref)) { if (ref) unknownRefs.add(ref); continue; }
      members.add(ref);
      pinsByRef.get(ref).add(String(endpoint?.pin ?? ''));
    }
    if (!members.size) continue;
    const sortedMembers = sortStrings(members);
    const first = sortedMembers[0];
    for (const ref of sortedMembers.slice(1)) unionFind.union(first, ref);
    memberNets.push({ name, refs: sortedMembers });
  }
  for (const ref of sortStrings(unknownRefs)) add('warning', SCHEMATIC_LAYOUT_CODES.NET_ENDPOINT_UNKNOWN, `网络端点引用了不存在的位号 ${ref}，已忽略`, { ref });

  const pinCountByRef = new Map(refs.map((ref) => [ref, Math.max(pinsByRef.get(ref).size, byRef.get(ref).explicitPinCount)]));

  const clusters = new Map();
  for (const ref of refs) {
    const root = unionFind.find(ref);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(ref);
  }
  const compareWithinBlock = (a, b) => (pinCountByRef.get(b) - pinCountByRef.get(a)) || compareRef(a, b);
  const blockSpecs = [...clusters.values()].map((members) => members.sort(compareWithinBlock));
  // 带顺序：成员多的（主干簇）在前，平局按首成员（引脚最多的那个）位号自然序
  blockSpecs.sort((a, b) => (b.length - a.length) || compareRef(a[0], b[0]));

  const placements = [];
  const blocks = [];
  let cursorY = finiteNumber(config.originY) ?? DEFAULT_LAYOUT_OPTIONS.originY;
  const originX = finiteNumber(config.originX) ?? DEFAULT_LAYOUT_OPTIONS.originX;
  const gapX = nonNegative(config.gapX, DEFAULT_LAYOUT_OPTIONS.gapX);
  const gapY = nonNegative(config.gapY, DEFAULT_LAYOUT_OPTIONS.gapY);
  const bandGap = nonNegative(config.bandGap, DEFAULT_LAYOUT_OPTIONS.bandGap);
  const maxBandWidth = positive(config.maxBandWidth, DEFAULT_LAYOUT_OPTIONS.maxBandWidth);

  for (const [blockIndex, blockRefs] of blockSpecs.entries()) {
    const blockId = `block-${blockIndex + 1}`;
    const startIndex = placements.length;
    let cursorX = originX;
    let rowY = cursorY;
    let rowHeight = 0;
    for (const ref of blockRefs) {
      const { width, height } = estimateSymbolSize({ ref, pinCount: pinCountByRef.get(ref) });
      const alignedWidth = alignUp(width, grid);
      const alignedHeight = alignUp(height, grid);
      if (cursorX > originX && cursorX + alignedWidth > originX + maxBandWidth) {
        cursorX = originX;
        rowY += rowHeight + gapY;
        rowHeight = 0;
      }
      if (alignedWidth > maxBandWidth) {
        add('warning', SCHEMATIC_LAYOUT_CODES.COMPONENT_OVERSIZE, `元件 ${ref} 估计宽度 ${alignedWidth} 超过单带宽度 ${maxBandWidth}，单独占一行`, { ref, blockId });
      }
      placements.push({
        ref,
        // 落位坐标 = 元件中心，对齐到格点；尺寸由上方估计（格点倍数），包围盒因此不重叠
        x: roundGrid(cursorX + alignedWidth / 2, grid),
        y: roundGrid(rowY + alignedHeight / 2, grid),
        width: alignedWidth,
        height: alignedHeight,
        pinCount: pinCountByRef.get(ref),
        blockId,
        blockIndex,
      });
      cursorX += alignedWidth + gapX;
      rowHeight = Math.max(rowHeight, alignedHeight);
    }
    const blockPlacements = placements.slice(startIndex);
    const blockRefSet = new Set(blockRefs);
    const blockNets = memberNets.filter((net) => net.refs.some((ref) => blockRefSet.has(ref)));
    // 代表网络：成员最多的网络（平局取字典序最小），供上层给"功能块"起名/展示
    const representativeNet = blockNets
      .map((net) => ({ name: net.name, count: net.refs.length }))
      .sort((a, b) => (b.count - a.count) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0] ?? null;
    const boxes = blockPlacements.map((placement) => boxOfCenter(placement));
    const bbox = {
      xMin: Math.min(...boxes.map((box) => box.xMin)),
      yMin: Math.min(...boxes.map((box) => box.yMin)),
      xMax: Math.max(...boxes.map((box) => box.xMax)),
      yMax: Math.max(...boxes.map((box) => box.yMax)),
    };
    blocks.push({
      id: blockId,
      index: blockIndex,
      refs: [...blockRefs],
      nets: sortStrings(new Set(blockNets.map((net) => net.name))),
      representativeNet: representativeNet?.name ?? null,
      bbox,
      width: bbox.xMax - bbox.xMin,
      height: bbox.yMax - bbox.yMin,
      pinCount: blockPlacements.reduce((sum, placement) => sum + placement.pinCount, 0),
    });
    cursorY = rowY + rowHeight + bandGap;
  }

  return { placements, blocks, findings };
}

/** 元件读回落点：真机读回可能在 `x/y` 或 `position.x/y`（两种都见过），取不到就是 null。 */
function componentPoint(component) {
  const x = finiteNumber(component?.x ?? component?.position?.x);
  const y = finiteNumber(component?.y ?? component?.position?.y);
  return x !== null && y !== null ? { x, y } : null;
}

/** 元件主体中心：优先用读回坐标，否则用该元件引脚质心（不猜，拿不到就是 null）。 */
function resolveComponentCenter(component, pins) {
  return componentPoint(component) || centroidOf(pins);
}

/** 端口锚点：优先用操作里已确定的 x/y，其次按 componentPrimitiveId + pinNumber 从读回引脚里找。 */
function resolveOperationAnchor({ args, operation, pins }) {
  const x = finiteNumber(args?.x);
  const y = finiteNumber(args?.y);
  if (x !== null && y !== null) return { x, y };
  const pinX = finiteNumber(operation?.pinX);
  const pinY = finiteNumber(operation?.pinY);
  if (pinX !== null && pinY !== null) return { x: pinX, y: pinY };
  const pinNumber = String(operation?.pinNumber ?? '');
  if (!pinNumber) return null;
  const pin = pins.find((item) => String(item?.pinNumber ?? item?.number ?? '') === pinNumber);
  const px = finiteNumber(pin?.x ?? pin?.position?.x);
  const py = finiteNumber(pin?.y ?? pin?.position?.y);
  return px !== null && py !== null ? { x: px, y: py } : null;
}

/**
 * 给网络端口挑朝向（rotation），并做 4 方向碰撞打分。
 *
 * 打分口径（面积越小越好，单位²）：
 *  1) 标签框 vs 自己的元件主体框（"标签压符号"就是评审会指出的缺陷）；
 *  2) 标签框 vs 该元件全部引脚包围盒外扩 margin（标签别压住引脚/引脚名）；
 *  3) 标签框 vs 其它元件主体框（别压到隔壁器件）；
 *  4) 标签框 vs 本次已放置标签 + 既有 netport 标签（别叠字）。
 * 选择顺序：重叠面积最小 → 平局取"朝外方向" → 再按 rotation 升序（0/90/180/270），全程确定性。
 *
 * 输入 operation 形状兼容两条通道：
 *  · net-connect：`{ type:'netPort.create', net, args:{ portType, net, x, y } , componentPrimitiveId, pinNumber }`
 *  · schematic-repair：`{ type:'netPort.create', repairId, expectedNet, pinIndex, args:{...,x,y} }`（调用方补上 componentPrimitiveId/pinNumber）
 * 输出 operations 与输入同序同长，args 里写入 rotation；不丢任何原有字段。
 *
 * @param {object} input
 * @param {Array<object>} [input.operations]
 * @param {Array<object>} [input.components] 读回图元（含 primitiveId/x/y 时用于主体中心）
 * @param {Record<string, Array<object>>} [input.pinsByComponent] primitiveId → 引脚坐标
 * @param {Array<object>} [input.existingLabels] 既有标签 [{net,x,y,rotation}]
 * @param {object} [input.options] 标签尺寸参数
 * @returns {{operations:Array<object>, labels:Array<object>, findings:Array<object>, summary:object}}
 */
export function planNetPortLabels({ operations = [], components = [], pinsByComponent = {}, existingLabels = [], options = {} } = {}) {
  const findings = [];
  const add = (severity, code, message, extra = {}) => findings.push({ severity, code, message, ...extra });
  const labelOptions = options?.label || options || {};
  const merged = { ...DEFAULT_LABEL_OPTIONS, ...labelOptions };
  const margin = nonNegative(merged.margin, DEFAULT_LABEL_OPTIONS.margin);
  const componentList = Array.isArray(components) ? components : (components?.components || []);
  const pinsIndex = pinsByComponent && typeof pinsByComponent === 'object' ? pinsByComponent : {};
  const componentById = new Map();
  for (const component of componentList) {
    const id = componentId(component);
    if (id) componentById.set(String(id), component);
  }

  // 所有元件主体框（标签压到任何器件都算可读性问题）。
  // netport/netflag 是"标签"不是"器件"：它们已经通过 existingLabels 的标签矩形占位，
  // 这里再按元件尺寸估一个主体框会双重占位，把新标签不必要地挤走。
  const isLabelLike = (component) => ['netport', 'netflag', 'netlabel'].includes(String(component?.componentType || '').toLowerCase());
  const bodyBoxes = componentList.filter((component) => !isLabelLike(component)).map((component) => {
    const id = componentId(component);
    const ref = String(component?.designator ?? component?.ref ?? id ?? '');
    const pins = id ? (Array.isArray(pinsIndex[String(id)]) ? pinsIndex[String(id)] : []) : [];
    const center = resolveComponentCenter(component, pins);
    if (!center) return null;
    const size = estimateSymbolSize({ ref, pinCount: pins.length });
    return { id: id === null || id === undefined ? null : String(id), ref, box: boxOfCenter({ ...center, ...size }) };
  }).filter(Boolean);
  const bodyBoxById = new Map(bodyBoxes.filter((item) => item.id !== null).map((item) => [item.id, item]));

  // 既有标签先占位：新标签要避开它们（外部已经画好的 netport 同样会叠字）
  const occupiedRects = [];
  for (const [index, label] of (Array.isArray(existingLabels) ? existingLabels : []).entries()) {
    const x = finiteNumber(label?.x ?? label?.args?.x);
    const y = finiteNumber(label?.y ?? label?.args?.y);
    if (x === null || y === null) continue;
    occupiedRects.push({
      kind: 'existing',
      index,
      net: String(label?.net ?? label?.args?.net ?? ''),
      rect: estimateLabelRect({ x, y, rotation: normalizeRotation(label?.rotation ?? label?.args?.rotation), net: label?.net ?? label?.args?.net, options: labelOptions }),
    });
  }

  const plannedOperations = [];
  const labels = [];
  const placedRects = [];
  for (const [index, operation] of (Array.isArray(operations) ? operations : []).entries()) {
    const sourceArgs = operation?.args && typeof operation.args === 'object' ? operation.args : {};
    const args = { ...sourceArgs };
    const net = String(args.net ?? operation?.net ?? '');
    const rawId = operation?.componentPrimitiveId ?? operation?.primitiveId ?? null;
    const componentKey = rawId === null || rawId === undefined ? null : String(rawId);
    const component = componentKey ? componentById.get(componentKey) || null : null;
    const pins = componentKey && Array.isArray(pinsIndex[componentKey]) ? pinsIndex[componentKey] : [];
    const pinNumber = operation?.pinNumber == null ? null : String(operation.pinNumber);
    const anchor = resolveOperationAnchor({ args, operation, pins });

    // 拿不到锚点：绝不猜坐标，保持原 rotation（默认朝右）并如实标低置信度
    if (!anchor) {
      const rotation = normalizeRotation(args.rotation);
      args.rotation = rotation;
      labels.push({ index, net, rotation, direction: DIRECTION_BY_ROTATION.get(rotation) ?? null, x: null, y: null, outward: null, source: 'fallback', overlapArea: null, hardOverlapArea: null, componentPrimitiveId: componentKey, pinNumber, rect: null });
      add('warning', SCHEMATIC_LAYOUT_CODES.LABEL_ANCHOR_UNRESOLVED, `网络 ${net || '?'} 的端口没有可用锚点（x/y 与引脚坐标都读不到），保留原 rotation=${rotation}，请人工确认`, { index, net, componentPrimitiveId: componentKey, pinNumber });
      plannedOperations.push({ ...operation, args });
      continue;
    }

    const center = resolveComponentCenter(component, pins);
    const outward = center ? outwardDirection(anchor, center) : null;
    const ownBody = component ? bodyBoxById.get(componentKey) || null : null;
    const ownPinBox = boxOfPoints(pins.map((pin) => ({ x: finiteNumber(pin?.x ?? pin?.position?.x), y: finiteNumber(pin?.y ?? pin?.position?.y) })), margin);
    const bodyObstacles = [];
    if (ownBody) bodyObstacles.push(ownBody.box);
    for (const item of bodyBoxes) if (!componentKey || item.id !== componentKey) bodyObstacles.push(item.box);

    // 方向优先级：朝外 → rotation 升序；迭代时只在"严格更小"时替换，平局天然落在前面的方向
    const candidates = [];
    if (outward) candidates.push(outward);
    for (const direction of DIRECTION_ORDER) if (direction !== outward) candidates.push(direction);

    let best = null;
    for (const direction of candidates) {
      const rotation = OUTWARD_ROTATION[direction];
      const rect = estimateLabelRect({ x: anchor.x, y: anchor.y, rotation, net, options: labelOptions });
      const bodyArea = bodyObstacles.reduce((sum, box) => sum + overlapArea(rect, box), 0);
      const pinArea = ownPinBox ? overlapArea(rect, ownPinBox) : 0;
      const labelArea = occupiedRects.reduce((sum, item) => sum + overlapArea(rect, item.rect), 0)
        + placedRects.reduce((sum, item) => sum + overlapArea(rect, item.rect), 0);
      // score 用于选方向：引脚包围盒外扩只是"别贴着引脚"，用来让朝外方向更优先；
      // hardScore 才是可见缺陷（压元件符号/压别的标签），findings 只按它报警，避免每个端口都报一条噪声警告。
      const score = bodyArea + pinArea + labelArea;
      const hardScore = bodyArea + labelArea;
      if (!best || score < best.score) best = { direction, rotation, rect, score, hardScore };
    }

    const chosen = best;
    args.rotation = chosen.rotation;
    const source = outward && chosen.direction === outward ? 'outward' : 'collision';
    const label = {
      index,
      net,
      rotation: chosen.rotation,
      direction: chosen.direction,
      x: anchor.x,
      y: anchor.y,
      outward,
      source,
      overlapArea: Math.round(chosen.score * 1000) / 1000,
      hardOverlapArea: Math.round(chosen.hardScore * 1000) / 1000,
      componentPrimitiveId: componentKey,
      pinNumber,
      rect: chosen.rect,
    };
    labels.push(label);
    placedRects.push({ kind: 'planned', index, net, rect: chosen.rect });
    plannedOperations.push({ ...operation, args });

    if (!outward) add('warning', SCHEMATIC_LAYOUT_CODES.LABEL_DIRECTION_FALLBACK, `网络 ${net} 读不到元件主体中心（无 x/y 且无引脚），只能按碰撞打分选方向 rotation=${chosen.rotation}，低置信度`, { index, net, rotation: chosen.rotation });
    if (outward && chosen.direction !== outward) add('info', SCHEMATIC_LAYOUT_CODES.LABEL_ROTATION_ADJUSTED, `网络 ${net} 的朝外方向是 ${outward}，但该方向会压到元件/标签（估计重叠 ${label.overlapArea} 单位²），改选 ${chosen.direction}（rotation=${chosen.rotation}）`, { index, net, outward, rotation: chosen.rotation, overlapArea: label.overlapArea });
    if (chosen.hardScore > OVERLAP_EPSILON) add('warning', SCHEMATIC_LAYOUT_CODES.LABEL_OVERLAP_REMAINING, `网络 ${net} 在 4 个方向里最好的估计重叠仍有 ${label.hardOverlapArea} 单位²，可能仍压到元件或别的标签，建议人工确认`, { index, net, rotation: chosen.rotation, overlapArea: label.hardOverlapArea });
  }

  // 放置完再自查一遍标签互叠（逐个避让不保证全局最优，这里如实报出来，不假装已解决）
  let labelLabelOverlaps = 0;
  for (let i = 0; i < placedRects.length; i += 1) {
    for (let j = i + 1; j < placedRects.length; j += 1) {
      const area = overlapArea(placedRects[i].rect, placedRects[j].rect);
      if (area <= OVERLAP_EPSILON) continue;
      labelLabelOverlaps += 1;
      add('warning', SCHEMATIC_LAYOUT_CODES.LABEL_LABEL_OVERLAP, `标签 ${placedRects[i].net} 与 ${placedRects[j].net} 估计互叠 ${Math.round(area * 1000) / 1000} 单位²`, { first: placedRects[i].net, second: placedRects[j].net, overlapArea: Math.round(area * 1000) / 1000 });
    }
  }

  // 给上层（net-connect dry-run / 审批页）一个可直接展示的可读性摘要；
  // 放在返回值而不是 plan 里，避免改变 planHash 让已发出的审批失效。
  const warningCodes = [...new Set(findings.filter((item) => item.severity === 'warning').map((item) => item.code))].sort();
  const summary = {
    planned: labels.length,
    outward: labels.filter((item) => item.source === 'outward').length,
    adjusted: labels.filter((item) => item.source === 'collision').length,
    fallback: labels.filter((item) => item.source === 'fallback').length,
    remainingOverlap: labels.filter((item) => Number(item.hardOverlapArea) > OVERLAP_EPSILON).length,
    labelLabelOverlaps,
    warnings: findings.filter((item) => item.severity === 'warning').length,
    warningCodes,
  };

  return { operations: plannedOperations, labels, findings, summary };
}

/**
 * 可读性审计：标签压元件、标签互叠、元件包围盒重叠。全部是 warning（不阻断写入）。
 *
 * @param {object} input
 * @param {Array<{ref?:string, designator?:string, primitiveId?:string, x?:number, y?:number, width?:number, height?:number, pinCount?:number}>} [input.components]
 * @param {Record<string, Array<object>>} [input.pinsByComponent]
 * @param {Array<{net?:string, x?:number, y?:number, rotation?:number, name?:string}>} [input.labels]
 * @param {object} [input.options]
 * @returns {{ok:boolean, findings:Array<object>, summary:object}}
 */
export function auditSchematicReadability({ components = [], pinsByComponent = {}, labels = [], options = {} } = {}) {
  const findings = [];
  const add = (code, message, extra = {}) => findings.push({ severity: 'warning', code, message, ...extra });
  const labelOptions = options?.label || options || {};
  const componentList = Array.isArray(components) ? components : (components?.components || []);
  const pinsIndex = pinsByComponent && typeof pinsByComponent === 'object' ? pinsByComponent : {};
  const boxes = [];
  let skippedComponents = 0;
  for (const component of componentList) {
    // 标签类图元（netport/netflag）不是器件本体：它们的占位由 labels 通道单独审计，避免双重计数。
    const type = String(component?.componentType || '').toLowerCase();
    if (['netport', 'netflag', 'netlabel'].includes(type)) continue;
    const id = componentId(component);
    const ref = String(component?.designator ?? component?.ref ?? id ?? '');
    const point = componentPoint(component);
    if (!point) { skippedComponents += 1; continue; }
    const { x, y } = point;
    const pins = id && Array.isArray(pinsIndex[String(id)]) ? pinsIndex[String(id)] : [];
    const estimated = estimateSymbolSize({ ref, pinCount: finiteNumber(component?.pinCount) ?? pins.length });
    const width = positive(component?.width, estimated.width);
    const height = positive(component?.height, estimated.height);
    boxes.push({ id: id === null || id === undefined ? null : String(id), ref, box: boxOfCenter({ x, y, width, height }), width, height });
  }

  // 1) 元件包围盒互叠（R2：元件不得压叠）
  const componentPairs = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const area = overlapArea(boxes[i].box, boxes[j].box);
      if (area <= OVERLAP_EPSILON) continue;
      componentPairs.push({ first: boxes[i].ref, second: boxes[j].ref, overlapArea: Math.round(area * 1000) / 1000 });
      add(SCHEMATIC_LAYOUT_CODES.COMPONENT_OVERLAP, `元件 ${boxes[i].ref} 与 ${boxes[j].ref} 的包围盒重叠 ${Math.round(area * 1000) / 1000} 单位²`, { first: boxes[i].ref, second: boxes[j].ref, overlapArea: Math.round(area * 1000) / 1000 });
    }
  }

  // 2) 标签 vs 元件（R1：标签不得压在元件符号上）
  const labelRects = [];
  for (const [index, label] of (Array.isArray(labels) ? labels : []).entries()) {
    const x = finiteNumber(label?.x ?? label?.args?.x);
    const y = finiteNumber(label?.y ?? label?.args?.y);
    if (x === null || y === null) continue;
    const net = String(label?.net ?? label?.args?.net ?? label?.name ?? '');
    const rect = label?.rect && Number.isFinite(label.rect.xMin) ? label.rect : estimateLabelRect({ x, y, rotation: normalizeRotation(label?.rotation ?? label?.args?.rotation), net, options: labelOptions });
    labelRects.push({ index, net, rect });
  }
  const labelOnComponent = [];
  for (const label of labelRects) {
    for (const componentBox of boxes) {
      const area = overlapArea(label.rect, componentBox.box);
      if (area <= OVERLAP_EPSILON) continue;
      labelOnComponent.push({ net: label.net, ref: componentBox.ref, overlapArea: Math.round(area * 1000) / 1000 });
      add(SCHEMATIC_LAYOUT_CODES.LABEL_ON_COMPONENT, `网络标签 ${label.net || '?'} 压到元件 ${componentBox.ref} 上（估计重叠 ${Math.round(area * 1000) / 1000} 单位²）`, { net: label.net, ref: componentBox.ref, overlapArea: Math.round(area * 1000) / 1000 });
    }
  }

  // 3) 标签互叠（R1：标签之间不得互相叠字）
  const labelPairs = [];
  for (let i = 0; i < labelRects.length; i += 1) {
    for (let j = i + 1; j < labelRects.length; j += 1) {
      const area = overlapArea(labelRects[i].rect, labelRects[j].rect);
      if (area <= OVERLAP_EPSILON) continue;
      labelPairs.push({ first: labelRects[i].net, second: labelRects[j].net, overlapArea: Math.round(area * 1000) / 1000 });
      add(SCHEMATIC_LAYOUT_CODES.LABEL_LABEL_OVERLAP, `标签 ${labelRects[i].net || '?'} 与 ${labelRects[j].net || '?'} 互叠 ${Math.round(area * 1000) / 1000} 单位²`, { first: labelRects[i].net, second: labelRects[j].net, overlapArea: Math.round(area * 1000) / 1000 });
    }
  }

  const maxOverlapArea = findings.reduce((max, item) => Math.max(max, finiteNumber(item.overlapArea) ?? 0), 0);
  return {
    ok: findings.length === 0,
    findings,
    summary: {
      components: boxes.length,
      skippedComponents,
      labels: labelRects.length,
      componentOverlaps: componentPairs.length,
      labelOnComponent: labelOnComponent.length,
      labelLabelOverlaps: labelPairs.length,
      maxOverlapArea: Math.round(maxOverlapArea * 1000) / 1000,
      overlapCount: componentPairs.length + labelOnComponent.length + labelPairs.length,
      componentBoxArea: boxes.reduce((sum, item) => sum + boxArea(item.box), 0),
    },
  };
}
