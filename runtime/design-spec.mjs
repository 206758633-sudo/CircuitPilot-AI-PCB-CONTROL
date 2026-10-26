import { EVIDENCE_KINDS } from './evidence-store.mjs';

/**
 * design-spec 契约与生成器（W2-01）。
 *
 * 为什么需要它：CircuitPilot 以前的输入只有"文本需求 + DXF"，网表靠猜、板框靠手填，
 * 同一块板在不同环节（设计 / 验证 / 放行）各说各话。design-spec 把这些事实收敛成
 * **唯一事实来源**：
 *   - boards[]     板卡清单（层数、板框；板框既接受 DXF 点集，也接受宽高）
 *   - interfaces[] 跨板接口契约（from/to 的位号与引脚，引脚不能为空）
 *   - netIntent[]  意图网表（"REF.PIN" 端点），供后续与 EDA 实际网表比对
 *   - bomLock[]    选型锁（lcscId 或 mpn + value + footprint，locked 必须为 true）
 *   - acceptance[] 需求→验收证据矩阵（每条需求至少一条证据）
 *
 * 设计约束：
 *   - 所有导出函数都是**纯函数**：不读文件、不发网络、不取当前时间，同样输入必得同样输出；
 *   - 校验一律 fail-closed：结构不对就抛带 code 的错误，绝不静默返回"看起来还行"的 spec；
 *   - 错误统一用 Object.assign(new Error(msg), { code, details })，与runtime 其它模块保持一致；
 *   - 板框只做几何转换，不写死任何具体板子的坐标/尺寸。
 *
 * 错误码：
 *   SPEC_INVALID           spec 结构/字段非法（schemaVersion、project、boards、netIntent、需求重复等）
 *   OUTLINE_INVALID        板框非法（点数<3、尺寸<=0、面积<=minAreaMm2、坐标非数值等）
 *   INTERFACE_INVALID      接口非法（board 未声明、位号缺失、pins 为空、接口 id 重复等）
 *   BOM_LOCK_INVALID       选型锁非法（缺 lcscId/mpn、缺 value/footprint、locked !== true、ref 重复）
 *   REQUIREMENT_UNMAPPED   需求无法映射到验收证据（缺证据/证据类型不支持/分类无法推断）
 */

// schema 版本：结构发生不兼容变更时必须递增；旧版本一律拒绝（fail-closed）。
export const DESIGN_SPEC_SCHEMA_VERSION = 1;

export const DESIGN_SPEC_CODES = Object.freeze({
  SPEC_INVALID: 'SPEC_INVALID',
  OUTLINE_INVALID: 'OUTLINE_INVALID',
  INTERFACE_INVALID: 'INTERFACE_INVALID',
  BOM_LOCK_INVALID: 'BOM_LOCK_INVALID',
  REQUIREMENT_UNMAPPED: 'REQUIREMENT_UNMAPPED',
});

// 证据类型沿用 evidence-store 的注册表（同一份真相，避免两处漂移）。
export const DESIGN_SPEC_EVIDENCE_KINDS = Object.freeze([...EVIDENCE_KINDS]);

const str = (value, n = 160) => String(value ?? '').trim().slice(0, n);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// 统一错误工厂：code 供调用方分支，details 保留现场（path 指向出错字段）。
const code = (message, errorCode, details) => Object.assign(new Error(message), { code: errorCode, details });
const fail = (message, errorCode, details) => { throw code(message, errorCode, details); };

// 数值宽松化：接受 number 或数字字符串（DXF/表格导入常见），其它一律视为非法。
const toFiniteNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

// 派生量保留 6 位小数，避免浮点噪声让同一块板生成不同的 spec/哈希。
const round6 = (value) => Math.round(value * 1e6) / 1e6;

/* ------------------------------------------------------------------ *
 * 板框：DXF 点集 / 宽高 → 通用 outline
 * ------------------------------------------------------------------ */

const readPoint = (point, path) => {
  let x;
  let y;
  if (Array.isArray(point)) {
    if (point.length !== 2) fail(`${path} 必须是 [x, y] 两个数值`, DESIGN_SPEC_CODES.OUTLINE_INVALID, { path, actual: point });
    [x, y] = point;
  } else if (isPlainObject(point)) {
    ({ x, y } = point);
  } else {
    fail(`${path} 必须是 [x, y] 或 {x, y}`, DESIGN_SPEC_CODES.OUTLINE_INVALID, { path, actual: point ?? null });
  }
  const px = toFiniteNumber(x);
  const py = toFiniteNumber(y);
  if (px === null || py === null) fail(`${path} 坐标必须是有限数值`, DESIGN_SPEC_CODES.OUTLINE_INVALID, { path, actual: point ?? null });
  return [px, py];
};

/**
 * 归一化板框点：逐点校验 → 去掉相邻重复点 → 去掉首尾重复（输入已自带闭合点时）。
 * 注意：这里不补闭合点；闭合由 boardOutlineFromPoints 负责（输出 closed:true）。
 */
export function normalizePoints(points) {
  if (!Array.isArray(points)) fail('板框 points 必须是数组', DESIGN_SPEC_CODES.OUTLINE_INVALID, { path: 'points' });
  const normalized = [];
  points.forEach((point, index) => {
    const [x, y] = readPoint(point, `points[${index}]`);
    const last = normalized[normalized.length - 1];
    if (last && last[0] === x && last[1] === y) return; // 相邻重复点：DXF 导出里很常见，直接吞掉
    normalized.push([x, y]);
  });
  if (normalized.length > 1) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) normalized.pop();
  }
  return normalized;
}

const polygonAreaMm2 = (points) => {
  // shoelace；顺时针/逆时针都取绝对值，不做方向假设。
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
};

const polygonPerimeterMm = (points) => {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  return total;
};

/**
 * DXF 多边形点（mm）→ 通用板框。
 * @param {Array<[number, number]>} points 多边形角点；相邻重复点会被去重，自动闭合
 * @param {{ minAreaMm2?: number }} [options] 最小面积门槛（默认 0，即只要求面积>0）
 * @returns {{ points: Array<[number, number]>, bounds: {width:number,height:number}, areaMm2:number, perimeterMm:number, closed:true }}
 */
export function boardOutlineFromPoints(points, { minAreaMm2 = 0 } = {}) {
  const minArea = toFiniteNumber(minAreaMm2);
  if (minArea === null || minArea < 0) fail('minAreaMm2 必须是 >=0 的数值', DESIGN_SPEC_CODES.OUTLINE_INVALID, { path: 'minAreaMm2', actual: minAreaMm2 ?? null });
  const normalized = normalizePoints(points);
  if (normalized.length < 3) {
    fail(`板框至少需要 3 个不重复角点（当前 ${normalized.length} 个）`, DESIGN_SPEC_CODES.OUTLINE_INVALID, { path: 'points', count: normalized.length });
  }
  const areaMm2 = polygonAreaMm2(normalized);
  if (!(areaMm2 > 0)) {
    fail('板框面积必须大于 0（点可能共线或退化）', DESIGN_SPEC_CODES.OUTLINE_INVALID, { path: 'points', areaMm2: round6(areaMm2) });
  }
  if (areaMm2 <= minArea) {
    fail(`板框面积 ${round6(areaMm2)} mm² 未超过 minAreaMm2=${minArea}`, DESIGN_SPEC_CODES.OUTLINE_INVALID, { path: 'points', areaMm2: round6(areaMm2), minAreaMm2: minArea });
  }
  const xs = normalized.map(([x]) => x);
  const ys = normalized.map(([, y]) => y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return {
    points: [...normalized, [...normalized[0]]], // 显式闭合：首尾同点
    bounds: { width: round6(width), height: round6(height) },
    areaMm2: round6(areaMm2),
    perimeterMm: round6(polygonPerimeterMm(normalized)),
    closed: true,
  };
}

/**
 * 宽高 → 通用矩形板框（左下角在原点），不写死任何具体板坐标。
 * 返回结构与 boardOutlineFromPoints 一致；矩形角点见 `points`。
 */
export function outlineFromBoardSizes({ widthMm, heightMm } = {}) {
  const width = toFiniteNumber(widthMm);
  const height = toFiniteNumber(heightMm);
  if (width === null || width <= 0) fail('widthMm 必须是正数', DESIGN_SPEC_CODES.OUTLINE_INVALID, { path: 'widthMm', actual: widthMm ?? null });
  if (height === null || height <= 0) fail('heightMm 必须是正数', DESIGN_SPEC_CODES.OUTLINE_INVALID, { path: 'heightMm', actual: heightMm ?? null });
  return boardOutlineFromPoints([[0, 0], [width, 0], [width, height], [0, height]]);
}

/* ------------------------------------------------------------------ *
 * 需求 → 验收证据映射
 * ------------------------------------------------------------------ */

// 分类关键词 → 默认证据类型。命中顺序即优先级：越具体的放越前。
const REQUIREMENT_EVIDENCE_RULES = Object.freeze([
  Object.freeze({ evidenceKind: 'pcb-layer-stack', keywords: Object.freeze(['layer', 'stackup', 'stack-up', '叠层', '板框', 'outline', 'mechanical', '结构', '机械', 'interface', '接口']) }),
  Object.freeze({ evidenceKind: 'drc-report', keywords: Object.freeze(['drc', 'pcb', 'layout', 'clearance', '布局', '布线', '间距', '电气规则']) }),
  Object.freeze({ evidenceKind: 'dfm-evidence', keywords: Object.freeze(['dfm', 'fabrication', 'manufactur', 'process', 'assembly', '工艺', '制造', '可制造', '拼板', '贴片']) }),
  Object.freeze({ evidenceKind: 'schematic-erc', keywords: Object.freeze(['erc', 'schematic', '原理图', '电气连接', '网表', 'netlist']) }),
  Object.freeze({ evidenceKind: 'spice-simulation', keywords: Object.freeze(['spice', 'simulation', '仿真', '完整性', 'integrity', 'thermal', '热', '电源', 'power', '信号']) }),
  Object.freeze({ evidenceKind: 'order-confirmation', keywords: Object.freeze(['order', 'bom', 'lcsc', '采购', '下单', '供应链', '选型', '立创']) }),
  Object.freeze({ evidenceKind: 'signoff', keywords: Object.freeze(['review', 'signoff', '审核', '验收', '放行', 'release', '评审']) }),
]);

/** 需求分类 → 默认证据类型；返回 null 表示无法映射（调用方必须显式提供 acceptance）。 */
export function evidenceKindForCategory(category) {
  const text = str(category, 120).toLowerCase();
  if (!text) return null;
  for (const rule of REQUIREMENT_EVIDENCE_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) return rule.evidenceKind;
  }
  return null;
}

/**
 * 单条需求 → acceptance[]（至少一条）。
 * - 缺 acceptance：给默认 criterion，证据类型按分类推断，needsReview:true（需人工确认）；
 * - acceptance 显式给出：证据类型必须在注册表内，否则 REQUIREMENT_UNMAPPED；
 * - 分类无法映射且没有显式证据类型：REQUIREMENT_UNMAPPED（不静默降级成 signoff）。
 */
const acceptanceForRequirement = (requirement, path) => {
  const inferKind = () => {
    const kind = evidenceKindForCategory(requirement.category);
    if (!kind) {
      fail(`需求 ${requirement.id} 无法映射证据类型（category=${requirement.category}），请在 acceptance 中显式提供 evidenceKind`, DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, { path: `${path}.acceptance`, requirementId: requirement.id, category: requirement.category, allowedEvidenceKinds: DESIGN_SPEC_EVIDENCE_KINDS });
    }
    return kind;
  };
  const explicit = Object.prototype.hasOwnProperty.call(requirement, 'acceptance') ? requirement.acceptance : undefined;
  const defaultCriterion = `满足需求：${str(requirement.requirement, 200)}`;
  if (explicit === undefined || explicit === null || (Array.isArray(explicit) && explicit.length === 0)) {
    return [{ requirementId: requirement.id, criterion: defaultCriterion, evidenceKind: inferKind(), needsReview: true }];
  }
  const items = Array.isArray(explicit) ? explicit : [explicit];
  return items.map((item, index) => {
    const itemPath = Array.isArray(explicit) ? `${path}.acceptance[${index}]` : `${path}.acceptance`;
    if (typeof item === 'string') {
      const criterion = str(item, 400);
      if (!criterion) fail(`${itemPath} 的 criterion 不能为空`, DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, { path: itemPath, requirementId: requirement.id });
      return { requirementId: requirement.id, criterion, evidenceKind: inferKind(), needsReview: true };
    }
    if (!isPlainObject(item)) fail(`${itemPath} 必须是字符串或对象`, DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, { path: itemPath, requirementId: requirement.id });
    const criterion = str(item.criterion, 400);
    if (!criterion) fail(`${itemPath}.criterion 不能为空`, DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, { path: `${itemPath}.criterion`, requirementId: requirement.id });
    const evidenceKind = str(item.evidenceKind, 120);
    if (evidenceKind) {
      if (!DESIGN_SPEC_EVIDENCE_KINDS.includes(evidenceKind)) {
        fail(`需求 ${requirement.id} 的证据类型不受支持：${evidenceKind}`, DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, { path: `${itemPath}.evidenceKind`, requirementId: requirement.id, evidenceKind, allowedEvidenceKinds: DESIGN_SPEC_EVIDENCE_KINDS });
      }
      return { requirementId: requirement.id, criterion, evidenceKind, needsReview: Boolean(item.needsReview) };
    }
    // 显式给了 criterion 但没给证据类型：按分类推断，并标记需人工复核。
    return { requirementId: requirement.id, criterion, evidenceKind: inferKind(), needsReview: item.needsReview === undefined ? true : Boolean(item.needsReview) };
  });
};

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

const positiveDimension = (value, path) => {
  const parsed = toFiniteNumber(value);
  if (parsed === null || parsed <= 0) fail(`${path} 必须是正数`, DESIGN_SPEC_CODES.OUTLINE_INVALID, { path, actual: value ?? null });
  return parsed;
};

/**
 * board.outline 归一化：
 *   - 有点集 → 以点集为准（points 优先于声明宽高），输出开点集 + 由点集算出的 bounds；
 *   - 只有宽高 → 用 outlineFromBoardSizes 生成矩形；
 *   - 两者都有时仍以点集为准，但声明宽高必须为正数（避免"写了 0 却没人发现"）。
 * 输出统一为 { points(开点集), widthMm, heightMm }，便于 JSON 存盘与二次校验的幂等。
 */
const normalizeBoardOutline = (raw, basePath) => {
  const path = `${basePath}.outline`;
  if (!isPlainObject(raw)) fail(`${path} 必须是对象`, DESIGN_SPEC_CODES.OUTLINE_INVALID, { path });
  const hasPoints = raw.points !== undefined && raw.points !== null;
  const declaresSize = raw.widthMm !== undefined || raw.heightMm !== undefined;
  if (declaresSize) {
    positiveDimension(raw.widthMm, `${path}.widthMm`);
    positiveDimension(raw.heightMm, `${path}.heightMm`);
  }
  if (hasPoints) {
    if (!Array.isArray(raw.points)) fail(`${path}.points 必须是数组`, DESIGN_SPEC_CODES.OUTLINE_INVALID, { path: `${path}.points` });
    const computed = boardOutlineFromPoints(raw.points);
    return {
      points: computed.points.slice(0, -1).map(([x, y]) => [x, y]),
      widthMm: computed.bounds.width,
      heightMm: computed.bounds.height,
    };
  }
  if (declaresSize) {
    const computed = outlineFromBoardSizes({ widthMm: raw.widthMm, heightMm: raw.heightMm });
    return {
      points: computed.points.slice(0, -1).map(([x, y]) => [x, y]),
      widthMm: computed.bounds.width,
      heightMm: computed.bounds.height,
    };
  }
  fail(`${path} 需要 points 或 widthMm/heightMm`, DESIGN_SPEC_CODES.OUTLINE_INVALID, { path });
};

const normalizeInterfaceEndpoint = (raw, path, boardIds) => {
  if (!isPlainObject(raw)) fail(`${path} 必须是对象`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path });
  const board = str(raw.board, 80);
  if (!board) fail(`${path}.board 不能为空`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: `${path}.board` });
  if (!boardIds.has(board)) fail(`${path}.board 未在 boards 中声明：${board}`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: `${path}.board`, board });
  const ref = str(raw.ref, 80).toUpperCase();
  if (!ref) fail(`${path}.ref 不能为空`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: `${path}.ref` });
  if (!Array.isArray(raw.pins)) fail(`${path}.pins 必须是数组`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: `${path}.pins` });
  const pins = raw.pins.map((pin, index) => {
    const value = str(pin, 30);
    if (!value) fail(`${path}.pins[${index}] 不能为空`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: `${path}.pins[${index}]` });
    return value;
  });
  if (!pins.length) fail(`${path}.pins 至少需要一个引脚`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: `${path}.pins` });
  if (new Set(pins).size !== pins.length) fail(`${path}.pins 存在重复引脚`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: `${path}.pins`, pins });
  return { board, ref, pins };
};

/**
 * 校验 design-spec。成功返回 { ok:true, spec }（spec 为归一化后的副本），失败抛带 code 的错误。
 * 归一化只做"去冗余/补标准形态"，不会把非法内容改写成合法内容（校验先于归一化）。
 */
export function validateDesignSpec(spec) {
  if (!isPlainObject(spec)) fail('design-spec 必须是对象', DESIGN_SPEC_CODES.SPEC_INVALID, { path: '' });
  if (spec.schemaVersion !== DESIGN_SPEC_SCHEMA_VERSION) {
    fail(`schemaVersion 不支持：${String(spec.schemaVersion ?? '空')}`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: 'schemaVersion', expected: DESIGN_SPEC_SCHEMA_VERSION, actual: spec.schemaVersion ?? null });
  }

  if (!isPlainObject(spec.project)) fail('project 必须是对象', DESIGN_SPEC_CODES.SPEC_INVALID, { path: 'project' });
  const projectName = str(spec.project.name, 200);
  if (!projectName) fail('project.name 不能为空', DESIGN_SPEC_CODES.SPEC_INVALID, { path: 'project.name' });
  const project = { ...spec.project, name: projectName };

  // boards：至少一块板；id 唯一；layers >= 2；outline 必须可解析出正面积。
  if (!Array.isArray(spec.boards) || !spec.boards.length) fail('boards 至少需要一块板', DESIGN_SPEC_CODES.SPEC_INVALID, { path: 'boards' });
  const boardIds = new Set();
  const boards = spec.boards.map((board, index) => {
    const path = `boards[${index}]`;
    if (!isPlainObject(board)) fail(`${path} 必须是对象`, DESIGN_SPEC_CODES.SPEC_INVALID, { path });
    const id = str(board.id, 80);
    if (!id) fail(`${path}.id 不能为空`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.id` });
    if (boardIds.has(id)) fail(`板卡 id 重复：${id}`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.id`, id });
    boardIds.add(id);
    const name = str(board.name, 160);
    if (!name) fail(`${path}.name 不能为空`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.name` });
    if (!Number.isInteger(board.layers) || board.layers < 2) {
      fail(`${path}.layers 必须是 >=2 的整数`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.layers`, actual: board.layers ?? null, min: 2 });
    }
    return { ...board, id, name, layers: board.layers, outline: normalizeBoardOutline(board.outline, path) };
  });

  // interfaces：可空；一旦出现就必须能落到已声明的板上，且引脚非空。
  if (spec.interfaces !== undefined && spec.interfaces !== null && !Array.isArray(spec.interfaces)) {
    fail('interfaces 必须是数组', DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: 'interfaces' });
  }
  const interfaceIds = new Set();
  const interfaces = (spec.interfaces ?? []).map((item, index) => {
    const path = `interfaces[${index}]`;
    if (!isPlainObject(item)) fail(`${path} 必须是对象`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path });
    const id = str(item.id, 80);
    if (!id) fail(`${path}.id 不能为空`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: `${path}.id` });
    if (interfaceIds.has(id)) fail(`接口 id 重复：${id}`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: `${path}.id`, id });
    interfaceIds.add(id);
    const from = normalizeInterfaceEndpoint(item.from, `${path}.from`, boardIds);
    const to = normalizeInterfaceEndpoint(item.to, `${path}.to`, boardIds);
    if (!Array.isArray(item.nets) || !item.nets.length) fail(`${path}.nets 至少需要一个网络名`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: `${path}.nets` });
    const nets = item.nets.map((net, netIndex) => {
      const value = str(net, 120);
      if (!value) fail(`${path}.nets[${netIndex}] 不能为空`, DESIGN_SPEC_CODES.INTERFACE_INVALID, { path: `${path}.nets[${netIndex}]` });
      return value;
    });
    return { ...item, id, from, to, nets };
  });

  // netIntent：意图网表是"设计要做什么"的声明，端点必须是 REF.PIN，且一个网络至少两个端点。
  if (spec.netIntent !== undefined && spec.netIntent !== null && !Array.isArray(spec.netIntent)) {
    fail('netIntent 必须是数组', DESIGN_SPEC_CODES.SPEC_INVALID, { path: 'netIntent' });
  }
  const netNames = new Set();
  const netIntent = (spec.netIntent ?? []).map((item, index) => {
    const path = `netIntent[${index}]`;
    if (!isPlainObject(item)) fail(`${path} 必须是对象`, DESIGN_SPEC_CODES.SPEC_INVALID, { path });
    const net = str(item.net, 120);
    if (!net) fail(`${path}.net 不能为空`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.net` });
    if (netNames.has(net)) fail(`意图网络重复定义：${net}`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.net`, net });
    netNames.add(net);
    if (!Array.isArray(item.endpoints)) fail(`${path}.endpoints 必须是数组`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.endpoints` });
    const endpoints = item.endpoints.map((endpoint, endpointIndex) => {
      const value = str(endpoint, 120);
      const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
      if (!match) {
        fail(`${path}.endpoints[${endpointIndex}] 必须是 "REF.PIN" 形式：${value || '空'}`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.endpoints[${endpointIndex}]`, value: value || null });
      }
      return `${match[1].toUpperCase()}.${match[2]}`;
    });
    if (endpoints.length < 2) fail(`${path}.endpoints 至少需要两个端点`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.endpoints`, count: endpoints.length });
    return { ...item, net, endpoints };
  });

  // bomLock：选型锁。locked 必须严格为 true——"锁没锁"是后续放行判断的依据，不能默认放行。
  if (spec.bomLock !== undefined && spec.bomLock !== null && !Array.isArray(spec.bomLock)) {
    fail('bomLock 必须是数组', DESIGN_SPEC_CODES.BOM_LOCK_INVALID, { path: 'bomLock' });
  }
  const lockedRefs = new Set();
  const bomLock = (spec.bomLock ?? []).map((item, index) => {
    const path = `bomLock[${index}]`;
    if (!isPlainObject(item)) fail(`${path} 必须是对象`, DESIGN_SPEC_CODES.BOM_LOCK_INVALID, { path });
    const ref = str(item.ref, 80).toUpperCase();
    if (!ref) fail(`${path}.ref 不能为空`, DESIGN_SPEC_CODES.BOM_LOCK_INVALID, { path: `${path}.ref` });
    if (lockedRefs.has(ref)) fail(`BOM 锁位号重复：${ref}`, DESIGN_SPEC_CODES.BOM_LOCK_INVALID, { path: `${path}.ref`, ref });
    lockedRefs.add(ref);
    const lcscId = str(item.lcscId, 60);
    const mpn = str(item.mpn, 120);
    if (!lcscId && !mpn) fail(`${path} 需要 lcscId 或 mpn 才能锁料`, DESIGN_SPEC_CODES.BOM_LOCK_INVALID, { path, ref });
    const value = str(item.value, 160);
    if (!value) fail(`${path}.value 不能为空`, DESIGN_SPEC_CODES.BOM_LOCK_INVALID, { path: `${path}.value`, ref });
    const footprint = str(item.footprint, 160);
    if (!footprint) fail(`${path}.footprint 不能为空`, DESIGN_SPEC_CODES.BOM_LOCK_INVALID, { path: `${path}.footprint`, ref });
    if (item.locked !== true) fail(`${path}.locked 必须为 true（BOM 必须锁定）`, DESIGN_SPEC_CODES.BOM_LOCK_INVALID, { path: `${path}.locked`, ref, actual: item.locked ?? null });
    return { ...item, ref, lcscId: lcscId || null, mpn: mpn || null, value, footprint, locked: true };
  });

  // requirements / acceptance：需求 id 唯一；每条需求至少一条验收证据（缺证据 → REQUIREMENT_UNMAPPED）。
  if (spec.requirements !== undefined && spec.requirements !== null && !Array.isArray(spec.requirements)) {
    fail('requirements 必须是数组', DESIGN_SPEC_CODES.SPEC_INVALID, { path: 'requirements' });
  }
  const requirementIds = new Set();
  const requirements = (spec.requirements ?? []).map((item, index) => {
    const path = `requirements[${index}]`;
    if (!isPlainObject(item)) fail(`${path} 必须是对象`, DESIGN_SPEC_CODES.SPEC_INVALID, { path });
    const id = str(item.id, 120);
    if (!id) fail(`${path}.id 不能为空`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.id` });
    if (requirementIds.has(id)) fail(`需求 id 重复：${id}`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.id`, id });
    requirementIds.add(id);
    const requirementText = str(item.requirement, 500);
    if (!requirementText) fail(`${path}.requirement 不能为空`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.requirement` });
    const category = str(item.category, 120) || 'general';
    // acceptance 只认顶层 acceptance[]（单一事实来源），需求对象里的 acceptance 不参与校验。
    const { acceptance: _nested, ...rest } = item;
    return { ...rest, id, category, requirement: requirementText };
  });

  if (spec.acceptance !== undefined && spec.acceptance !== null && !Array.isArray(spec.acceptance)) {
    fail('acceptance 必须是数组', DESIGN_SPEC_CODES.SPEC_INVALID, { path: 'acceptance' });
  }
  const acceptance = (spec.acceptance ?? []).map((item, index) => {
    const path = `acceptance[${index}]`;
    if (!isPlainObject(item)) fail(`${path} 必须是对象`, DESIGN_SPEC_CODES.SPEC_INVALID, { path });
    const requirementId = str(item.requirementId, 120);
    if (!requirementId) fail(`${path}.requirementId 不能为空`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.requirementId` });
    if (!requirementIds.has(requirementId)) {
      fail(`${path}.requirementId 引用了未声明的需求：${requirementId}`, DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, { path: `${path}.requirementId`, requirementId });
    }
    const criterion = str(item.criterion, 500);
    if (!criterion) fail(`${path}.criterion 不能为空`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.criterion`, requirementId });
    const evidenceKind = str(item.evidenceKind, 120);
    if (!evidenceKind) fail(`${path}.evidenceKind 不能为空`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.evidenceKind`, requirementId });
    if (!DESIGN_SPEC_EVIDENCE_KINDS.includes(evidenceKind)) {
      fail(`${path}.evidenceKind 不受支持：${evidenceKind}`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.evidenceKind`, evidenceKind, allowedEvidenceKinds: DESIGN_SPEC_EVIDENCE_KINDS });
    }
    return { ...item, requirementId, criterion, evidenceKind, needsReview: item.needsReview === undefined ? false : Boolean(item.needsReview) };
  });

  if (requirements.length) {
    const covered = new Set(acceptance.map((item) => item.requirementId));
    const missing = requirements.filter((item) => !covered.has(item.id)).map((item) => item.id);
    if (missing.length) {
      fail(`需求缺少验收证据：${missing.join('、')}`, DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, { missingRequirements: missing });
    }
  }

  const {
    schemaVersion: _schemaVersion,
    project: _project,
    boards: _boards,
    interfaces: _interfaces,
    netIntent: _netIntent,
    bomLock: _bomLock,
    requirements: _requirements,
    acceptance: _acceptance,
    ...rest
  } = spec;
  return {
    ok: true,
    spec: {
      ...rest,
      schemaVersion: DESIGN_SPEC_SCHEMA_VERSION,
      project,
      boards,
      interfaces,
      netIntent,
      bomLock,
      requirements,
      acceptance,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 生成器
 * ------------------------------------------------------------------ */

/**
 * 由"需求 + 板卡 + 接口 + 意图网表 + BOM 锁"生成 design-spec。
 *
 * requirements 形如 [{ id, category, requirement, acceptance? }]：
 *   - 每个需求至少映射一条 acceptance；缺 acceptance 时给默认 criterion 并标 needsReview:true；
 *   - acceptance 可为字符串、对象或对象数组；显式证据类型必须在 DESIGN_SPEC_EVIDENCE_KINDS 内；
 *   - 证据类型无法确定时抛 REQUIREMENT_UNMAPPED（不做"猜一个证据类型"的降级）。
 *
 * 返回校验通过后的归一化 spec（失败直接抛错，不返回半成品）。
 */
export function buildDesignSpec(input = {}) {
  if (!isPlainObject(input)) fail('buildDesignSpec 的入参必须是对象', DESIGN_SPEC_CODES.SPEC_INVALID, { path: '' });
  const { project, requirements = [], boards = [], interfaces = [], netIntent = [], bomLock = [] } = input;
  if (!Array.isArray(requirements)) fail('requirements 必须是数组', DESIGN_SPEC_CODES.SPEC_INVALID, { path: 'requirements' });

  const seenIds = new Set();
  const normalizedRequirements = [];
  const acceptance = [];
  requirements.forEach((item, index) => {
    const path = `requirements[${index}]`;
    if (!isPlainObject(item)) fail(`${path} 必须是对象`, DESIGN_SPEC_CODES.SPEC_INVALID, { path });
    const id = str(item.id, 120);
    if (!id) fail(`${path}.id 不能为空`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.id` });
    if (seenIds.has(id)) fail(`需求 id 重复：${id}`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.id`, id });
    seenIds.add(id);
    const requirementText = str(item.requirement, 500);
    if (!requirementText) fail(`${path}.requirement 不能为空`, DESIGN_SPEC_CODES.SPEC_INVALID, { path: `${path}.requirement` });
    const category = str(item.category, 120) || 'general';
    const requirement = { id, category, requirement: requirementText };
    normalizedRequirements.push(requirement);
    acceptance.push(...acceptanceForRequirement({ ...requirement, acceptance: item.acceptance }, path));
  });

  const spec = {
    schemaVersion: DESIGN_SPEC_SCHEMA_VERSION,
    project: project ?? {},
    boards,
    interfaces,
    netIntent,
    bomLock,
    requirements: normalizedRequirements,
    acceptance,
  };
  return validateDesignSpec(spec).spec;
}
