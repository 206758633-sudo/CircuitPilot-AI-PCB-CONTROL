/**
 * 板级规范模型（Board Model IR）—— 复合设计框架的"唯一事实来源"。
 *
 * 定位：在 Design-as-Code（atopile/tscircuit/SKiDL）、Rule-as-Code（IPC/JLC + KiCad DRC）、
 * 求解器（布局/叠层/网表）、闭环编排之间传递同一份**可校验、可哈希、可离线迭代**的板级模型，
 * 让 EDA 从"每一步迭代的必经之路"变成"编译器目标 + 最终验证 oracle"。
 *
 * 设计原则（与仓库其它模块一致）：
 *   - 纯函数：不读文件、不联网、不取当前时间；同输入必得同输出（digest 可复现）；
 *   - fail-closed：结构不合法直接抛带 code 的错误，不返回"看起来还行"的模型；
 *   - 可缺省但如实：尺寸/叠层/网表缺失时保留 null 并标记，规则层会判 REVIEW，绝不猜；
 *   - 单位统一 mm / 度 / A / Ω；坐标原点 = 板框左下角 (0,0)。
 *
 * IR 结构（schemaVersion=1）：
 * {
 *   schemaVersion, meta:{ title?, source? },
 *   board: { widthMm, heightMm, layers, thicknessMm, copperOz,
 *            outline: [[x,y],...] | null, keepouts:[{id,x0,y0,x1,y1,reason?}],
 *            mountingHoles:[{x,y,diaMm}], fiducials:[{x,y,diaMm}] },
 *   stackup: { layers:[{name,type:'signal'|'plane'|'mixed',thicknessMm,er?}], totalThicknessMm? } | null,
 *   components: [{ ref, mpn?, footprint?, xMm, yMm, widthMm?, heightMm?, rotationDeg,
 *                  side:'top'|'bottom', fixed:boolean, clearanceMm?, courtyardMm?, heightMm3d?,
 *                  powerW?, currentMaxA?, tags?:[] }],
 *   nets: [{ name, pins:[{ref,pin}], currentA?, impedanceOhm?, kind?:'signal'|'power'|'gnd' }],
 *   rules: { fabProfile?:string, minClearanceMm?, minTraceWidthMm?, minEdgeClearanceMm?,
 *            targetImpedanceOhm?, maxLayers?, boardThicknessMm? }
 * }
 */
import { createHash } from 'node:crypto';

export const BOARD_MODEL_SCHEMA_VERSION = 1;

export const BOARD_MODEL_CODES = Object.freeze({
  INVALID: 'BOARD_MODEL_INVALID',
  BOARD_INVALID: 'BOARD_MODEL_BOARD_INVALID',
  OUTLINE_INVALID: 'BOARD_MODEL_OUTLINE_INVALID',
  COMPONENT_INVALID: 'BOARD_MODEL_COMPONENT_INVALID',
  DUPLICATE_REF: 'BOARD_MODEL_DUPLICATE_REF',
  NET_INVALID: 'BOARD_MODEL_NET_INVALID',
  KEEPOUT_INVALID: 'BOARD_MODEL_KEEPOUT_INVALID',
  STACKUP_INVALID: 'BOARD_MODEL_STACKUP_INVALID',
  RULES_INVALID: 'BOARD_MODEL_RULES_INVALID',
});

export const MAX_LAYERS = 32;
export const MAX_COMPONENTS = 2000;
const MIN_BOARD_MM = 0.5;
const MAX_BOARD_MM = 2000;

const code = (message, errorCode, details) => Object.assign(new Error(message), { code: errorCode, details });
const fail = (message, errorCode, details) => { throw code(message, errorCode, details); };
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 确定性序列化：对象键排序（digest 可复现，不受字段插入顺序影响）。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function boardModelDigest(model) {
  return createHash('sha256').update(canonicalJson(model)).digest('hex');
}

const num = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const requireNumber = (value, path, errorCode, { min = null, max = null, integer = false } = {}) => {
  const parsed = num(value);
  if (parsed === null) fail(`${path} 必须是有限数值`, errorCode, { path, actual: value ?? null });
  if (integer && !Number.isInteger(parsed)) fail(`${path} 必须是整数`, errorCode, { path, actual: parsed });
  if (min !== null && parsed < min) fail(`${path} 不能小于 ${min}`, errorCode, { path, actual: parsed, min });
  if (max !== null && parsed > max) fail(`${path} 不能大于 ${max}`, errorCode, { path, actual: parsed, max });
  return parsed;
};
const optionalNumber = (value, path, errorCode, options) => {
  if (value === undefined || value === null || value === '') return null;
  return requireNumber(value, path, errorCode, options);
};
const text = (value, max = 120) => String(value ?? '').trim().slice(0, max);
const refOf = (value) => text(value, 32).toUpperCase();

/* ------------------------------------------------------------------ */
/* 子结构归一化                                                        */
/* ------------------------------------------------------------------ */

function normalizePoint(point, path) {
  let x;
  let y;
  if (Array.isArray(point) && point.length >= 2) [x, y] = point;
  else if (isPlainObject(point)) ({ x, y } = point);
  else fail(`${path} 必须是 [x,y] 或 {x,y}`, BOARD_MODEL_CODES.OUTLINE_INVALID, { path, actual: point ?? null });
  return [requireNumber(x, `${path}.x`, BOARD_MODEL_CODES.OUTLINE_INVALID), requireNumber(y, `${path}.y`, BOARD_MODEL_CODES.OUTLINE_INVALID)];
}

function normalizeBoard(raw = {}) {
  if (!isPlainObject(raw)) fail('board 必须是对象', BOARD_MODEL_CODES.BOARD_INVALID);
  const outline = Array.isArray(raw.outline) ? raw.outline.map((point, index) => normalizePoint(point, `board.outline[${index}]`)) : null;
  let widthMm = optionalNumber(raw.widthMm, 'board.widthMm', BOARD_MODEL_CODES.BOARD_INVALID, { min: MIN_BOARD_MM, max: MAX_BOARD_MM });
  let heightMm = optionalNumber(raw.heightMm, 'board.heightMm', BOARD_MODEL_CODES.BOARD_INVALID, { min: MIN_BOARD_MM, max: MAX_BOARD_MM });
  if (outline && outline.length >= 3) {
    const xs = outline.map(([x]) => x);
    const ys = outline.map(([, y]) => y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    if (widthMm === null && spanX > 0) widthMm = spanX;
    if (heightMm === null && spanY > 0) heightMm = spanY;
  }
  if (widthMm === null || heightMm === null) {
    fail('board 需要 widthMm/heightMm 或 ≥3 点 outline', BOARD_MODEL_CODES.BOARD_INVALID, { widthMm, heightMm, outlinePoints: outline?.length ?? 0 });
  }
  const layers = requireNumber(raw.layers ?? 2, 'board.layers', BOARD_MODEL_CODES.BOARD_INVALID, { min: 1, max: MAX_LAYERS, integer: true });
  const keepouts = (Array.isArray(raw.keepouts) ? raw.keepouts : []).map((item, index) => {
    const path = `board.keepouts[${index}]`;
    if (!isPlainObject(item)) fail(`${path} 必须是对象`, BOARD_MODEL_CODES.KEEPOUT_INVALID, { path });
    const rect = {
      id: text(item.id, 40) || `keepout-${index + 1}`,
      x0: requireNumber(item.x0, `${path}.x0`, BOARD_MODEL_CODES.KEEPOUT_INVALID),
      y0: requireNumber(item.y0, `${path}.y0`, BOARD_MODEL_CODES.KEEPOUT_INVALID),
      x1: requireNumber(item.x1, `${path}.x1`, BOARD_MODEL_CODES.KEEPOUT_INVALID),
      y1: requireNumber(item.y1, `${path}.y1`, BOARD_MODEL_CODES.KEEPOUT_INVALID),
      ...(item.reason === undefined ? {} : { reason: text(item.reason, 160) }),
    };
    if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) fail(`${path} 需要 x1>x0 且 y1>y0`, BOARD_MODEL_CODES.KEEPOUT_INVALID, { path, rect });
    return rect;
  });
  const holes = (Array.isArray(raw.mountingHoles) ? raw.mountingHoles : []).map((item, index) => ({
    x: requireNumber(item?.x, `board.mountingHoles[${index}].x`, BOARD_MODEL_CODES.BOARD_INVALID),
    y: requireNumber(item?.y, `board.mountingHoles[${index}].y`, BOARD_MODEL_CODES.BOARD_INVALID),
    diaMm: requireNumber(item?.diaMm, `board.mountingHoles[${index}].diaMm`, BOARD_MODEL_CODES.BOARD_INVALID, { min: 0.1 }),
  }));
  const fiducials = (Array.isArray(raw.fiducials) ? raw.fiducials : []).map((item, index) => ({
    x: requireNumber(item?.x, `board.fiducials[${index}].x`, BOARD_MODEL_CODES.BOARD_INVALID),
    y: requireNumber(item?.y, `board.fiducials[${index}].y`, BOARD_MODEL_CODES.BOARD_INVALID),
    diaMm: requireNumber(item?.diaMm, `board.fiducials[${index}].diaMm`, BOARD_MODEL_CODES.BOARD_INVALID, { min: 0.1 }),
  }));
  return {
    widthMm,
    heightMm,
    layers,
    thicknessMm: optionalNumber(raw.thicknessMm, 'board.thicknessMm', BOARD_MODEL_CODES.BOARD_INVALID, { min: 0.2, max: 10 }),
    copperOz: optionalNumber(raw.copperOz, 'board.copperOz', BOARD_MODEL_CODES.BOARD_INVALID, { min: 0.25, max: 20 }),
    outline: outline && outline.length >= 3 ? outline : null,
    keepouts,
    mountingHoles: holes,
    fiducials,
  };
}

function normalizeStackup(raw, { layers = null } = {}) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) fail('stackup 必须是对象或 null', BOARD_MODEL_CODES.STACKUP_INVALID);
  const rawLayers = Array.isArray(raw.layers) ? raw.layers : null;
  if (!rawLayers || rawLayers.length === 0) fail('stackup.layers 必须是非空数组', BOARD_MODEL_CODES.STACKUP_INVALID);
  const normalized = rawLayers.map((item, index) => {
    const path = `stackup.layers[${index}]`;
    if (!isPlainObject(item)) fail(`${path} 必须是对象`, BOARD_MODEL_CODES.STACKUP_INVALID, { path });
    const type = item.type ?? 'signal';
    if (!['signal', 'plane', 'mixed'].includes(type)) fail(`${path}.type 必须是 signal/plane/mixed`, BOARD_MODEL_CODES.STACKUP_INVALID, { path, type });
    return {
      name: text(item.name, 40) || `L${index + 1}`,
      type,
      thicknessMm: optionalNumber(item.thicknessMm, `${path}.thicknessMm`, BOARD_MODEL_CODES.STACKUP_INVALID, { min: 0 }),
      er: optionalNumber(item.er, `${path}.er`, BOARD_MODEL_CODES.STACKUP_INVALID, { min: 1, max: 12 }),
    };
  });
  if (layers !== null && normalized.length !== layers) {
    fail(`stackup 层数 ${normalized.length} 与 board.layers ${layers} 不一致`, BOARD_MODEL_CODES.STACKUP_INVALID, { stackupLayers: normalized.length, boardLayers: layers });
  }
  return { layers: normalized, totalThicknessMm: optionalNumber(raw.totalThicknessMm, 'stackup.totalThicknessMm', BOARD_MODEL_CODES.STACKUP_INVALID, { min: 0.2, max: 10 }) };
}

function normalizeComponent(raw, index) {
  const path = `components[${index}]`;
  if (!isPlainObject(raw)) fail(`${path} 必须是对象`, BOARD_MODEL_CODES.COMPONENT_INVALID, { path });
  const ref = refOf(raw.ref);
  if (!ref) fail(`${path}.ref 不能为空`, BOARD_MODEL_CODES.COMPONENT_INVALID, { path: `${path}.ref` });
  const sizeUnknown = raw.sizeUnknown === true;
  const widthMm = optionalNumber(raw.widthMm, `${path}.widthMm`, BOARD_MODEL_CODES.COMPONENT_INVALID, { min: 0.01 });
  const heightMm = optionalNumber(raw.heightMm, `${path}.heightMm`, BOARD_MODEL_CODES.COMPONENT_INVALID, { min: 0.01 });
  if (!sizeUnknown && (widthMm === null || heightMm === null)) {
    fail(`${path} 缺少 widthMm/heightMm（未知尺寸必须显式 sizeUnknown:true，不许猜）`, BOARD_MODEL_CODES.COMPONENT_INVALID, { path, ref });
  }
  const side = raw.side === 'bottom' ? 'bottom' : 'top';
  return {
    ref,
    ...(raw.mpn === undefined ? {} : { mpn: text(raw.mpn, 80) }),
    ...(raw.footprint === undefined ? {} : { footprint: text(raw.footprint, 80) }),
    xMm: requireNumber(raw.xMm ?? 0, `${path}.xMm`, BOARD_MODEL_CODES.COMPONENT_INVALID),
    yMm: requireNumber(raw.yMm ?? 0, `${path}.yMm`, BOARD_MODEL_CODES.COMPONENT_INVALID),
    widthMm,
    heightMm,
    rotationDeg: optionalNumber(raw.rotationDeg ?? 0, `${path}.rotationDeg`, BOARD_MODEL_CODES.COMPONENT_INVALID) ?? 0,
    side,
    fixed: raw.fixed === true,
    sizeUnknown,
    clearanceMm: optionalNumber(raw.clearanceMm, `${path}.clearanceMm`, BOARD_MODEL_CODES.COMPONENT_INVALID, { min: 0 }),
    courtyardMm: optionalNumber(raw.courtyardMm, `${path}.courtyardMm`, BOARD_MODEL_CODES.COMPONENT_INVALID, { min: 0 }),
    heightMm3d: optionalNumber(raw.heightMm3d, `${path}.heightMm3d`, BOARD_MODEL_CODES.COMPONENT_INVALID, { min: 0 }),
    powerW: optionalNumber(raw.powerW, `${path}.powerW`, BOARD_MODEL_CODES.COMPONENT_INVALID, { min: 0 }),
    currentMaxA: optionalNumber(raw.currentMaxA, `${path}.currentMaxA`, BOARD_MODEL_CODES.COMPONENT_INVALID, { min: 0 }),
    ...(Array.isArray(raw.tags) ? { tags: raw.tags.map((tag) => text(tag, 32)).filter(Boolean) } : {}),
    ...(raw.placementId === undefined ? {} : { placementId: text(raw.placementId, 80) }),
  };
}

function normalizeNet(raw, index, refs) {
  const path = `nets[${index}]`;
  if (!isPlainObject(raw)) fail(`${path} 必须是对象`, BOARD_MODEL_CODES.NET_INVALID, { path });
  const name = text(raw.name ?? raw.net, 120);
  if (!name) fail(`${path}.name 不能为空`, BOARD_MODEL_CODES.NET_INVALID, { path: `${path}.name` });
  if (!Array.isArray(raw.pins) || raw.pins.length === 0) fail(`${path}.pins 必须是非空数组`, BOARD_MODEL_CODES.NET_INVALID, { path: `${path}.pins` });
  const pins = raw.pins.map((pin, pinIndex) => {
    const pinPath = `${path}.pins[${pinIndex}]`;
    let ref;
    let pinName;
    if (typeof pin === 'string' && pin.includes('.')) {
      const separator = pin.lastIndexOf('.');
      ref = refOf(pin.slice(0, separator));
      pinName = text(pin.slice(separator + 1), 40);
    } else if (isPlainObject(pin)) {
      ref = refOf(pin.ref);
      pinName = text(pin.pin, 40);
    }
    if (!ref || !pinName) fail(`${pinPath} 必须是 "REF.PIN" 或 {ref,pin}`, BOARD_MODEL_CODES.NET_INVALID, { path: pinPath });
    if (!refs.has(ref)) fail(`${pinPath} 引用了不存在的器件 ${ref}`, BOARD_MODEL_CODES.NET_INVALID, { path: pinPath, ref });
    return { ref, pin: pinName };
  });
  const kind = raw.kind === 'power' || raw.kind === 'gnd' ? raw.kind : 'signal';
  return {
    name,
    pins,
    ...(raw.currentA === undefined ? {} : { currentA: optionalNumber(raw.currentA, `${path}.currentA`, BOARD_MODEL_CODES.NET_INVALID, { min: 0 }) }),
    ...(raw.impedanceOhm === undefined ? {} : { impedanceOhm: optionalNumber(raw.impedanceOhm, `${path}.impedanceOhm`, BOARD_MODEL_CODES.NET_INVALID, { min: 1 }) }),
    kind,
  };
}

function normalizeRules(raw = {}) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) fail('rules 必须是对象', BOARD_MODEL_CODES.RULES_INVALID);
  const rules = {};
  if (raw.fabProfile !== undefined) rules.fabProfile = text(raw.fabProfile, 80);
  for (const key of ['minClearanceMm', 'minTraceWidthMm', 'minEdgeClearanceMm', 'targetImpedanceOhm', 'boardThicknessMm']) {
    if (raw[key] !== undefined && raw[key] !== null) {
      rules[key] = optionalNumber(raw[key], `rules.${key}`, BOARD_MODEL_CODES.RULES_INVALID, { min: key === 'targetImpedanceOhm' ? 5 : 0.001 });
    }
  }
  if (raw.maxLayers !== undefined && raw.maxLayers !== null) {
    rules.maxLayers = requireNumber(raw.maxLayers, 'rules.maxLayers', BOARD_MODEL_CODES.RULES_INVALID, { min: 1, max: MAX_LAYERS, integer: true });
  }
  return rules;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 创建/归一化板级模型。输入可以只给部分字段；缺失字段保留 null/空数组并由规则层判 REVIEW。
 * @param {object} input 原始模型
 * @returns {object} 冻结前的规范模型（普通对象，可 JSON 序列化）
 */
export function createBoardModel(input = {}) {
  if (!isPlainObject(input)) fail('board model 输入必须是对象', BOARD_MODEL_CODES.INVALID);
  const board = normalizeBoard(input.board ?? {});
  const stackup = normalizeStackup(input.stackup, { layers: board.layers });
  const rawComponents = input.components ?? [];
  if (!Array.isArray(rawComponents)) fail('components 必须是数组', BOARD_MODEL_CODES.COMPONENT_INVALID);
  if (rawComponents.length > MAX_COMPONENTS) fail(`components 超过上限 ${MAX_COMPONENTS}`, BOARD_MODEL_CODES.COMPONENT_INVALID, { count: rawComponents.length });
  const components = rawComponents.map((item, index) => normalizeComponent(item, index));
  const refs = new Set(components.map((component) => component.ref));
  if (refs.size !== components.length) {
    const seen = new Set();
    const duplicates = components.map((component) => component.ref).filter((ref) => (seen.has(ref) ? true : (seen.add(ref), false)));
    fail(`器件位号重复：${[...new Set(duplicates)].join(',')}`, BOARD_MODEL_CODES.DUPLICATE_REF, { duplicates: [...new Set(duplicates)] });
  }
  const rawNets = input.nets ?? [];
  if (!Array.isArray(rawNets)) fail('nets 必须是数组', BOARD_MODEL_CODES.NET_INVALID);
  const nets = rawNets.map((item, index) => normalizeNet(item, index, refs));
  const netNames = new Set(nets.map((net) => net.name));
  if (netNames.size !== nets.length) fail('网络名重复', BOARD_MODEL_CODES.NET_INVALID);
  const meta = isPlainObject(input.meta) ? { ...input.meta } : {};
  const model = {
    schemaVersion: BOARD_MODEL_SCHEMA_VERSION,
    meta: { ...(meta.title === undefined ? {} : { title: text(meta.title, 200) }), ...(meta.source === undefined ? {} : { source: text(meta.source, 80) }) },
    board,
    stackup,
    components,
    nets,
    rules: normalizeRules(input.rules),
  };
  return model;
}

/** 校验（不抛异常，返回结构化问题清单；供 eval/UI 展示）。 */
export function validateBoardModel(model) {
  const issues = [];
  try {
    createBoardModel(model);
  } catch (error) {
    issues.push({ code: error?.code ?? BOARD_MODEL_CODES.INVALID, message: String(error?.message ?? error), details: error?.details ?? null });
  }
  return { ok: issues.length === 0, issues };
}

export function summarizeBoardModel(model) {
  const refs = model.components.map((component) => component.ref);
  const unknownSize = model.components.filter((component) => component.sizeUnknown).map((component) => component.ref);
  return {
    board: { widthMm: model.board.widthMm, heightMm: model.board.heightMm, layers: model.board.layers },
    stackupLayers: model.stackup?.layers.length ?? 0,
    componentCount: refs.length,
    netCount: model.nets.length,
    unknownSizeRefs: unknownSize,
    keepouts: model.board.keepouts.length,
    digest: boardModelDigest(model),
  };
}

/** 板框是否闭合（首尾点相同或在容差内）——IR 的 outline 允许开点集，这里只做提示性判断。 */
export function outlineClosed(model, toleranceMm = 1e-6) {
  const points = model?.board?.outline;
  if (!Array.isArray(points) || points.length < 3) return null;
  const [first] = points;
  const last = points[points.length - 1];
  return Math.abs(first[0] - last[0]) <= toleranceMm && Math.abs(first[1] - last[1]) <= toleranceMm;
}

/* ------------------------------------------------------------------ */
/* 适配器：从既有契约构建 IR                                            */
/* ------------------------------------------------------------------ */

/** 从 design-spec（runtime/design-spec.mjs 产物）构建 IR。尺寸未知的器件用 sizeUnknown 标记。 */
export function boardModelFromDesignSpec(spec, { title } = {}) {
  if (!isPlainObject(spec)) fail('design-spec 必须是对象', BOARD_MODEL_CODES.INVALID);
  const boardSpec = Array.isArray(spec.boards) ? spec.boards[0] : null;
  if (!boardSpec) fail('design-spec 没有 boards', BOARD_MODEL_CODES.BOARD_INVALID);
  const outline = Array.isArray(boardSpec.outline?.points) ? boardSpec.outline.points : null;
  const components = [];
  const seen = new Set();
  for (const net of Array.isArray(spec.netIntent) ? spec.netIntent : []) {
    for (const endpoint of Array.isArray(net.endpoints) ? net.endpoints : []) {
      const separator = String(endpoint).lastIndexOf('.');
      const ref = refOf(String(endpoint).slice(0, separator));
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      components.push({ ref, xMm: 0, yMm: 0, sizeUnknown: true });
    }
  }
  const nets = (Array.isArray(spec.netIntent) ? spec.netIntent : []).map((net) => ({ name: net.net, pins: net.endpoints.map((endpoint) => String(endpoint)) }));
  return createBoardModel({
    meta: { title: title ?? spec.title ?? 'design-spec', source: 'design-spec' },
    board: {
      widthMm: boardSpec.outline?.widthMm,
      heightMm: boardSpec.outline?.heightMm,
      layers: boardSpec.layers,
      outline,
    },
    components,
    nets,
    rules: { maxLayers: boardSpec.layers },
  });
}

/**
 * 从 PCB 生产计划（runtime/pcb.mjs 产物）构建 IR。
 * 计划里的 operations 只保证"要写什么"，不保证器件几何；调用方可显式传 placements 补齐。
 * @param {object} plan pcb plan
 * @param {{placements?:Array, components?:Array, title?:string}} [options]
 */
export function boardModelFromPcbPlan(plan, { placements = [], components = [], title } = {}) {
  if (!isPlainObject(plan)) fail('pcb plan 必须是对象', BOARD_MODEL_CODES.INVALID);
  const board = plan.board ?? {};
  const byRef = new Map(components.map((component) => [refOf(component.ref), component]));
  for (const placement of placements) {
    const ref = refOf(placement?.ref);
    if (!ref) continue;
    byRef.set(ref, { ...(byRef.get(ref) ?? {}), ...placement, ref });
  }
  return createBoardModel({
    meta: { title: title ?? plan.title ?? 'pcb-plan', source: 'pcb-plan' },
    board: {
      widthMm: board.widthMm,
      heightMm: board.heightMm,
      layers: board.layers,
      thicknessMm: board.thicknessMm,
      copperOz: board.copperOz,
    },
    stackup: plan.stackup ?? null,
    components: [...byRef.values()],
    nets: [],
    rules: {
      ...(plan.constraints?.fabProfile === undefined ? {} : { fabProfile: plan.constraints.fabProfile }),
      ...(plan.constraints?.minClearanceMm === undefined ? {} : { minClearanceMm: plan.constraints.minClearanceMm }),
      ...(plan.constraints?.minTraceWidthMm === undefined ? {} : { minTraceWidthMm: plan.constraints.minTraceWidthMm }),
    },
  });
}

/**
 * 把 IR 编译成 EDA 写操作（仅布局/板框，不含布线/铺铜）。
 * 没有 placementId 的器件不生成 modify（避免按 ref 猜 primitiveId 写错器件）。
 * @returns {{operations:Array, skipped:Array}}
 */
export function toPcbOperations(model) {
  const operations = [];
  const skipped = [];
  if (model.board.outline && model.board.outline.length >= 3) {
    operations.push({
      type: 'pcb.outline.create',
      args: {
        widthMm: model.board.widthMm,
        heightMm: model.board.heightMm,
        points: model.board.outline.map(([x, y]) => [x, y]),
      },
    });
  } else {
    operations.push({ type: 'pcb.outline.create', args: { widthMm: model.board.widthMm, heightMm: model.board.heightMm } });
  }
  for (const component of model.components) {
    if (!component.placementId) {
      skipped.push({ ref: component.ref, reason: 'placementId-missing' });
      continue;
    }
    operations.push({
      type: 'pcb.component.modify',
      args: {
        primitiveId: component.placementId,
        property: { x: component.xMm, y: component.yMm, rotation: component.rotationDeg, layer: component.side === 'bottom' ? 2 : 1, primitiveLock: component.fixed === true },
      },
    });
  }
  return { operations, skipped };
}
