/**
 * 原理图"真实连通性"审计：直接读文档源码 + 引脚世界坐标，算出网络到底连了哪些引脚。
 *
 * 为什么需要它（2026-10-22 某真实项目案例 真机教训）：
 *   现有验收链读网络只能靠"导出网表"（`sch_Net` 在原理图上下文返回 0 条，见审计文档）。
 *   但网表只是**结果**，它会把两类设计缺陷一并吞掉：
 *     · 引脚根本没连（171/266 个引脚 ±net 为空）——网表里看起来只是"空网络"；
 *     · 同一根导线上挂了两个不同网络标签（例如 GND 和 +3V3）——网表会把两个网络**合并**，
 *       看起来只是"+3V3 有 24 个引脚"，实际上 GND 被短路进了 +3V3。
 *   真机就是在这个状态下拿到 `ready=true` 的。本模块补的是"从源码算连通性"这一层：
 *   不依赖导出、不依赖编辑器内存，任何一次原理图改动都能算出引脚级连接关系。
 *
 * 数据来源（都是可从公共 API 拿到的原始数据）：
 *   · 原理图源码：`sys_FileManager.getDocumentSource()`（文本，行内 `{head}||{body}`）；
 *   · 引脚世界坐标：`sch_PrimitiveComponent.getAll()` + `getAllPinsByPrimitiveId(id)`。
 *
 * 两个真机口径（写死在这，避免以后又踩）：
 *   1. **坐标 Y 轴相反**：源码里元件/导线的 y 与 API 返回的世界坐标 y 符号相反
 *      （真机 67/67 个器件 `sourceY === -apiY`）；导线几何必须取 `-y` 才能与引脚对上。
 *   2. **网络名按标签合并**：同名网络标签即使不在同一段导线上也属于同一个网络。
 *
 * 判定口径（blocking = 不能出制造文件）：
 *   1. 源码/引脚拿不到、解析不了 → blocking（没法核对，不等于没问题）；
 *   2. 同一根导线上出现 ≥2 个不同网络标签 → blocking（网络被合并 = 短路风险）；
 *   3. 未连接引脚占比 > 5% → blocking；> 0 且 ≤ 5% → warning；
 *   4. 有网络标签但没有任何引脚落在其连通域上 → warning（标签悬空，网表会丢这个网络）；
 *   5. 显式标了 No-Connect（`pin.noConnected === true`）的引脚不算"未连接"，单独计数；
 *      但它若同时接在导线上 → warning（标注与连线自相矛盾）。
 *
 * 真机教训：**"未连接"和"故意不连接"必须分开**。否则设计者把预留脚、未用模拟输入标注 NC 后，
 * 审计仍会把它当成断路（真机 91→71 个空引脚里有 33 个是数据手册明确的 NC 脚）。
 * 反过来，NC 标注也不能当"已连接"用——它只表示"有意悬空"，所以本文单独统计。
 */

export const SCH_CONNECTIVITY_CODES = {
  SOURCE_UNAVAILABLE: 'SCH_CONNECTIVITY_SOURCE_UNAVAILABLE',
  SOURCE_INVALID: 'SCH_CONNECTIVITY_SOURCE_INVALID',
  PINS_UNAVAILABLE: 'SCH_CONNECTIVITY_PINS_UNAVAILABLE',
  MULTI_LABEL_WIRE: 'SCH_CONNECTIVITY_MULTI_LABEL_WIRE',
  FLOATING_PINS: 'SCH_CONNECTIVITY_FLOATING_PINS',
  NO_NETS: 'SCH_CONNECTIVITY_NO_NETS',
  DANGLING_LABEL: 'SCH_CONNECTIVITY_DANGLING_LABEL',
  NO_CONNECT_BUT_WIRED: 'SCH_CONNECTIVITY_NO_CONNECT_BUT_WIRED',
};

/** 未连接引脚占比超过它就判 blocking。低于阈值只记录（真机允许极少量保留引脚）。 */
const FLOATING_BLOCKING_RATIO = 0.05;
/** 判断"引脚落在导线上"的容差（mil，原理图坐标单位）。 */
const TOUCH_TOLERANCE = 0.8;

const finding = (code, message, field, severity = 'blocking') => ({ code, message, field, severity });

/**
 * 解析原理图源码文本。
 *
 * 源码格式：每行 `{"type":...,"id":...}||{...body...}|`（body 结尾可能带一个 `|`）。
 * 返回 `{ components, wires, labels }`：
 *   · components: [{ id, x, y, rotation, mirror }]
 *   · wires:      [{ id, x1, y1, x2, y2 }]（坐标已转成 API 世界坐标：y = -sourceY）
 *   · labels:     [{ id, wireId, value, x, y }]（网络标签，x/y 同样取 -y）
 */
export function parseSchematicSource(text) {
  if (typeof text !== 'string' || !text.trim()) return { components: [], wires: [], labels: [] };
  const components = [];
  const wires = new Map();
  const labels = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const split = line.indexOf('||');
    if (split < 0) continue;
    let head;
    let body;
    try {
      head = JSON.parse(line.slice(0, split));
      body = JSON.parse(line.slice(split + 2).replace(/\|\s*$/, ''));
    } catch {
      continue;
    }
    if (!head || typeof head.type !== 'string') continue;
    if (head.type === 'COMPONENT') {
      components.push({ id: head.id, x: Number(body.x), y: Number(body.y), rotation: Number(body.rotation) || 0, mirror: body.isMirror === true });
    } else if (head.type === 'WIRE') {
      wires.set(head.id, { id: head.id, x1: null, y1: null, x2: null, y2: null });
    } else if (head.type === 'LINE') {
      const wire = wires.get(body.lineGroup);
      if (!wire) continue;
      // 真机口径：源码 Y 与 API 世界坐标相反，这里统一翻成世界坐标。
      wire.x1 = Number(body.startX);
      wire.y1 = -Number(body.startY);
      wire.x2 = Number(body.endX);
      wire.y2 = -Number(body.endY);
    } else if (head.type === 'ATTR' && body.key === 'NET') {
      labels.push({ id: head.id, wireId: body.parentId, value: String(body.value ?? ''), x: Number(body.x), y: -Number(body.y) });
    }
  }
  return { components, wires: [...wires.values()].filter((wire) => Number.isFinite(wire.x1) && Number.isFinite(wire.x2)), labels };
}

const distanceToSegment = (px, py, wire) => {
  const vx = wire.x2 - wire.x1;
  const vy = wire.y2 - wire.y1;
  const wx = px - wire.x1;
  const wy = py - wire.y1;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (wire.x1 + t * vx), py - (wire.y1 + t * vy));
};

/**
 * 从源码 + 引脚世界坐标算出真实连通性。
 *
 * @param {object} input
 * @param {string} input.sourceText 原理图源码文本
 * @param {Array<{designator:string, number:string, name?:string, x:number, y:number}>} input.pins 引脚世界坐标
 * @returns {{ready:boolean, findings:Array, counts:object, nets:Array, floating:Array, multiLabelWires:Array}}
 */
export function auditSchematicConnectivity({ sourceText, pins, maxListed = 12 } = {}) {
  const findings = [];
  const parsed = parseSchematicSource(sourceText);
  const pinList = Array.isArray(pins) ? pins.filter((pin) => pin && Number.isFinite(Number(pin.x)) && Number.isFinite(Number(pin.y))) : [];

  if (!parsed.wires.length) {
    findings.push(finding(SCH_CONNECTIVITY_CODES.SOURCE_UNAVAILABLE, '原理图源码里没有导线（或源码读不到）：无法核对引脚连通性。这不是"没有问题"，是"没有证据"。', 'schematic'));
  }
  if (!pinList.length) {
    findings.push(finding(SCH_CONNECTIVITY_CODES.PINS_UNAVAILABLE, '没有拿到任何引脚的世界坐标：无法核对引脚连通性（缺引脚证据不等于连通性合格）。', 'schematic'));
  }
  const counts = { pins: pinList.length, connectedPins: 0, floatingPins: 0, noConnectPins: 0, wires: parsed.wires.length, labels: parsed.labels.length, nets: 0 };

  if (!parsed.wires.length || !pinList.length) {
    return { ready: false, findings, counts, nets: [], floating: [], multiLabelWires: [] };
  }

  // 并查集：几何相接的导线 + 同名标签的导线都属于同一个网络。
  const parent = new Map(parsed.wires.map((wire) => [wire.id, wire.id]));
  const find = (id) => {
    let current = id;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };
  for (let i = 0; i < parsed.wires.length; i += 1) {
    for (let j = i + 1; j < parsed.wires.length; j += 1) {
      const a = parsed.wires[i];
      const b = parsed.wires[j];
      const aEnds = [[a.x1, a.y1], [a.x2, a.y2]];
      const bEnds = [[b.x1, b.y1], [b.x2, b.y2]];
      if (aEnds.some(([x, y]) => bEnds.some(([u, v]) => Math.hypot(x - u, y - v) <= TOUCH_TOLERANCE))) union(a.id, b.id);
    }
  }
  const labelsByWire = new Map();
  for (const label of parsed.labels) {
    if (!labelsByWire.has(label.wireId)) labelsByWire.set(label.wireId, []);
    labelsByWire.get(label.wireId).push(label);
  }
  const wiresByLabel = new Map();
  for (const label of parsed.labels) {
    if (!wireIdsHas(parent, label.wireId)) continue;
    if (!wiresByLabel.has(label.value)) wiresByLabel.set(label.value, []);
    wiresByLabel.get(label.value).push(label.wireId);
  }
  for (const [, ids] of wiresByLabel) for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i]);

  // 同一根导线上出现多个不同网络标签 = 多个网络被合并，这是真实的短路风险。
  const multiLabelWires = [];
  for (const [wireId, wireLabels] of labelsByWire) {
    const distinct = [...new Set(wireLabels.map((label) => label.value))].filter(Boolean);
    if (distinct.length > 1) multiLabelWires.push({ wireId, labels: distinct });
  }
  for (const item of multiLabelWires.slice(0, maxListed)) {
    findings.push(finding(
      SCH_CONNECTIVITY_CODES.MULTI_LABEL_WIRE,
      `同一根导线（${item.wireId.slice(0, 8)}）上挂了 ${item.labels.length} 个不同网络标签：${item.labels.join(' / ')}——这两个网络在网表里会被合并（等于短路）。`,
      'schematic',
    ));
  }

  // 引脚 → 导线 → 网络
  const pinsByRoot = new Map();
  const floating = [];
  for (const pin of pinList) {
    const label = `${pin.designator}.${pin.number}${pin.name ? `(${pin.name})` : ''}`;
    const hit = parsed.wires.find((wire) => distanceToSegment(Number(pin.x), Number(pin.y), wire) <= TOUCH_TOLERANCE);
    // 显式 No-Connect：表示"有意悬空"，不是断路。若同时有线，才是矛盾。
    if (pin.noConnected === true) {
      counts.noConnectPins += 1;
      if (hit) {
        findings.push(finding(
          SCH_CONNECTIVITY_CODES.NO_CONNECT_BUT_WIRED,
          `引脚 ${label} 标了 No-Connect，却接在导线上：标注与连线矛盾，导出网表时行为不确定。`,
          'schematic',
          'warning',
        ));
      }
      continue;
    }
    if (!hit) {
      floating.push({ pin: label, x: Number(pin.x), y: Number(pin.y) });
      continue;
    }
    const root = find(hit.id);
    if (!pinsByRoot.has(root)) pinsByRoot.set(root, []);
    pinsByRoot.get(root).push(label);
  }
  counts.connectedPins = pinList.length - floating.length - counts.noConnectPins;
  counts.floatingPins = floating.length;

  const namesByRoot = new Map();
  for (const [wireId, wireLabels] of labelsByWire) {
    const root = find(wireId);
    if (!namesByRoot.has(root)) namesByRoot.set(root, new Set());
    for (const item of wireLabels) if (item.value) namesByRoot.get(root).add(item.value);
  }
  const nets = [...pinsByRoot.entries()].map(([root, netPins]) => ({ names: [...(namesByRoot.get(root) || [])], pins: netPins }))
    .sort((a, b) => b.pins.length - a.pins.length);
  counts.nets = nets.length;

  const namedRoots = new Set([...namesByRoot.keys()]);
  const pinnedRoots = new Set([...pinsByRoot.keys()]);
  const danglingNetNames = [];
  for (const root of namedRoots) {
    if (pinnedRoots.has(root)) continue;
    for (const name of namesByRoot.get(root) || []) danglingNetNames.push(name);
  }
  if (danglingNetNames.length) {
    findings.push(finding(
      SCH_CONNECTIVITY_CODES.DANGLING_LABEL,
      `有 ${danglingNetNames.length} 个网络标签没有连到任何引脚（${[...new Set(danglingNetNames)].slice(0, maxListed).join('、')}）：导出网表时这些网络会消失。`,
      'schematic',
      'warning',
    ));
  }

  if (!nets.length) {
    findings.push(finding(SCH_CONNECTIVITY_CODES.NO_NETS, '源码里没有任何"导线 + 引脚"组成的网络：原理图等于没有连线。', 'schematic'));
  }

  const connectable = Math.max(0, pinList.length - counts.noConnectPins);
  const floatingRatio = connectable ? floating.length / connectable : 0;
  if (floating.length) {
    const sample = floating.slice(0, maxListed).map((item) => item.pin).join('；');
    const more = floating.length > maxListed ? `；…另 ${floating.length - maxListed} 项` : '';
    findings.push(finding(
      SCH_CONNECTIVITY_CODES.FLOATING_PINS,
      `原理图有 ${floating.length}/${connectable} 个（应连）引脚没有连到任何导线（${(floatingRatio * 100).toFixed(1)}%），另有 ${counts.noConnectPins} 个引脚显式标了 No-Connect：样例 ${sample}${more}。这些引脚在网络表里会是空网络，板子做出来是断路。`,
      'schematic',
      floatingRatio > FLOATING_BLOCKING_RATIO ? 'blocking' : 'warning',
    ));
  }

  return {
    ready: findings.every((item) => item.severity !== 'blocking'),
    findings,
    counts,
    nets,
    floating,
    multiLabelWires,
  };
}

const wireIdsHas = (parent, wireId) => parent.has(wireId);
