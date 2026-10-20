/**
 * 嘉立创EDA(专业版) pro-api 的**图元/图层/多边形语义**，真机核实版。
 *
 * 依据：2026-10-13 在 EDA Pro v3.2.186（pro-api 0.3.18.0bc12bb0）上逐条实测，原始记录见
 * deliverables/cp-multilayer-monitor-20261013/README.md §5 与 evidence.json。
 *
 * 本模块存在的唯一理由——官方 API 有两处**会静默毁板或必然失败**的坑：
 *
 *   1) `PCB_PrimitiveLine.create` / `PCB_PrimitiveArc.create` 只接受 `type === "SIGNAL"` 的铜层。
 *      丝印(3/4)、阻焊(5/6)、**板框(11)**、机械(14) 一律抛
 *      `错误：无法创建直线图元，可能是传入的参数不正确。`
 *      —— 报错把"层不支持"说成"参数不对"，让人白白去调 net/宽度/坐标/锁定。
 *      而官方 api-types.d.ts 的 `TPCB_LayersOfLine` 明明把 BOARD_OUTLINE 列为合法层，
 *      属**类型契约与实现自相矛盾**。所以板框必须走 `PCB_PrimitivePolyline.create`。
 *
 *   2) 多边形源码数组的编码**没有任何文档**。实测只有两种"token 开头"形式合法：
 *      `["R",x1,y1,x2,y2,rx,ry]` 与 `["CIRCLE",cx,cy,r]`；其余组合一律返回 undefined。
 *      而真正能画出任意轮廓的形式是**坐标开头**的
 *      `[x0,y0,"L",x1,y1,x2,y2,…]`——该形式是从文档源码 POUR 记录的 `path` 字段反推出来的：
 *          "path":[[11.811,-11.811,"L",2350.3937,-11.811,…]]
 *      另外 `Polyline.create` 接受 CIRCLE、**拒绝 R（连铜层也拒绝）**，
 *      所以矩形只能用坐标开头的 "L" 路径写法。
 */

import { LAYER_IDS } from './layers.mjs';

/** 实测得到的图层类型（`PCB_Layer.getAllLayers()` 的 `type` 字段）。 */
export const EDA_LAYER_TYPE = Object.freeze({
  SIGNAL: 'SIGNAL',
  SILKSCREEN: 'SILKSCREEN',
  SOLDER_MASK: 'SOLDER_MASK',
  PASTE_MASK: 'PASTE_MASK',
  ASSEMBLY: 'ASSEMBLY',
  OUTLINE: 'OUTLINE',
  MULTI: 'MULTI',
  DOCUMENT: 'DOCUMENT',
  MECHANICAL: 'MECHANICAL',
  DRILL_DRAWING: 'DRILL_DRAWING',
});

/**
 * 每种写图元的 API 到底能落在哪些层类型上。
 * `measured` 字段是真机实测结论，不是从类型定义抄来的——两者不一致时以 `measured` 为准。
 */
export const EDA_PRIMITIVE_LAYER_SUPPORT = Object.freeze({
  line: Object.freeze({ api: 'PCB_PrimitiveLine.create', accepts: Object.freeze([EDA_LAYER_TYPE.SIGNAL]), measured: '铜层(1/2/15..44)成功；丝印(3)、板框(11)、机械(14) 全部失败', alternative: 'polyline' }),
  arc: Object.freeze({ api: 'PCB_PrimitiveArc.create', accepts: Object.freeze([EDA_LAYER_TYPE.SIGNAL]), measured: '铜层成功；板框(11)失败', alternative: 'polyline' }),
  polyline: Object.freeze({ api: 'PCB_PrimitivePolyline.create', accepts: Object.freeze([EDA_LAYER_TYPE.SIGNAL, EDA_LAYER_TYPE.SILKSCREEN, EDA_LAYER_TYPE.SOLDER_MASK, EDA_LAYER_TYPE.PASTE_MASK, EDA_LAYER_TYPE.ASSEMBLY, EDA_LAYER_TYPE.OUTLINE, EDA_LAYER_TYPE.DOCUMENT, EDA_LAYER_TYPE.MECHANICAL, EDA_LAYER_TYPE.DRILL_DRAWING]), measured: '铜层与板框层(11)均成功', alternative: null }),
  region: Object.freeze({ api: 'PCB_PrimitiveRegion.create', accepts: Object.freeze([EDA_LAYER_TYPE.SIGNAL, EDA_LAYER_TYPE.MULTI]), measured: '类型定义 TPCB_LayersOfRegion 仅铜层+MULTI，不含板框', alternative: null }),
  fill: Object.freeze({ api: 'PCB_PrimitiveFill.create', accepts: Object.freeze([EDA_LAYER_TYPE.SIGNAL, EDA_LAYER_TYPE.SILKSCREEN, EDA_LAYER_TYPE.SOLDER_MASK, EDA_LAYER_TYPE.PASTE_MASK, EDA_LAYER_TYPE.ASSEMBLY, EDA_LAYER_TYPE.DOCUMENT, EDA_LAYER_TYPE.MECHANICAL, EDA_LAYER_TYPE.MULTI]), measured: '类型定义 TPCB_LayersOfFill 不含板框', alternative: 'polyline' }),
});

/** 非铜层的层号 → 类型。用于在写入前给出可执行的错误提示。 */
export const NON_COPPER_LAYER_TYPES = Object.freeze({
  [LAYER_IDS.TOP_SILKSCREEN]: EDA_LAYER_TYPE.SILKSCREEN,
  [LAYER_IDS.BOTTOM_SILKSCREEN]: EDA_LAYER_TYPE.SILKSCREEN,
  [LAYER_IDS.TOP_SOLDER_MASK]: EDA_LAYER_TYPE.SOLDER_MASK,
  [LAYER_IDS.BOTTOM_SOLDER_MASK]: EDA_LAYER_TYPE.SOLDER_MASK,
  [LAYER_IDS.TOP_PASTE_MASK]: EDA_LAYER_TYPE.PASTE_MASK,
  [LAYER_IDS.BOTTOM_PASTE_MASK]: EDA_LAYER_TYPE.PASTE_MASK,
  [LAYER_IDS.TOP_ASSEMBLY]: EDA_LAYER_TYPE.ASSEMBLY,
  [LAYER_IDS.BOTTOM_ASSEMBLY]: EDA_LAYER_TYPE.ASSEMBLY,
  [LAYER_IDS.BOARD_OUTLINE]: EDA_LAYER_TYPE.OUTLINE,
  [LAYER_IDS.MULTI]: EDA_LAYER_TYPE.MULTI,
  [LAYER_IDS.DOCUMENT]: EDA_LAYER_TYPE.DOCUMENT,
  [LAYER_IDS.MECHANICAL]: EDA_LAYER_TYPE.MECHANICAL,
});

/** 板框线宽：10mil = 0.254mm，与嘉立创默认板框线一致。 */
export const OUTLINE_LINE_WIDTH_MIL = 10;

/** 给调用方的可执行建议：错误信息与命令描述共用同一句话，避免两处说法不一致。 */
export const BOARD_OUTLINE_HELP = '板框必须用 PCB_PrimitivePolyline.create + 坐标开头的多边形编码 [x0,y0,"L",…]（Polyline 接受板框层）；PCB_PrimitiveLine/Arc 实测只接受 SIGNAL 铜层，写板框层必然失败且报错会误导成"参数不正确"';

export const mmToMil = (mm) => Number(mm) * 1000 / 25.4;
export const milToMm = (mil) => Number(mil) * 25.4 / 1000;

/** 层号 → 实测层类型（非铜层查表；铜层按 layers.mjs 的层模型判定）。 */
export function layerTypeOf(layerId, layerCount = 32) {
  const id = Number(layerId);
  if (NON_COPPER_LAYER_TYPES[id]) return NON_COPPER_LAYER_TYPES[id];
  const isCopper = id === LAYER_IDS.TOP || id === LAYER_IDS.BOTTOM || (id >= LAYER_IDS.INNER_1 && id <= LAYER_IDS.LAST_INNER);
  void layerCount;
  return isCopper ? EDA_LAYER_TYPE.SIGNAL : null;
}

/**
 * 写入前拦截"层与图元不匹配"——否则会拿到一条骗人的"参数不正确"，或者更糟：静默不生效。
 * 抛出的错误带 `code` 与可直接照做的 `hint`。
 */
export function assertPrimitiveLayerSupports(primitive, layerId) {
  const support = EDA_PRIMITIVE_LAYER_SUPPORT[primitive];
  if (!support) throw Object.assign(new Error(`未知图元类型: ${primitive}`), { code: 'EDA_PRIMITIVE_UNKNOWN' });
  const type = layerTypeOf(layerId);
  if (type && support.accepts.includes(type)) return { primitive, layerId: Number(layerId), layerType: type };
  const layerName = Object.entries(LAYER_IDS).find(([, value]) => value === Number(layerId))?.[0] || 'unknown';
  const hint = support.alternative ? `板框/非铜层请改用 ${EDA_PRIMITIVE_LAYER_SUPPORT[support.alternative].api} + 坐标开头的多边形编码 [x0,y0,"L",…]` : '该层不支持此图元';
  throw Object.assign(new Error(`${support.api} 不接受 layer=${layerId}（${layerName}，实测类型 ${type || '未知'}）；实测只接受 ${support.accepts.join('/')}。${hint}`), { code: 'EDA_LAYER_NOT_SUPPORTED', primitive, layerId: Number(layerId), layerType: type, accepts: support.accepts, hint });
}

/**
 * 多边形的合法源码形式（实测）：
 *   - `[x0,y0,"L",x1,y1,…]`：坐标开头 + 段类型 token + 后续点（**画任意轮廓用这个**）
 *   - `["R",x1,y1,x2,y2,rx,ry]`：仅被 PCB_MathPolygon.createPolygon 接受，图元创建器拒绝
 *   - `["CIRCLE",cx,cy,r]`：创建器接受
 */
export function classifyPolygonSource(source) {
  if (!Array.isArray(source) || source.length < 3) return { form: 'invalid', valid: false, reason: '多边形源码必须是非空数组' };
  const head = source[0];
  if (head === 'R') {
    const numbers = source.slice(1);
    const valid = numbers.length === 6 && numbers.every(Number.isFinite);
    return { form: 'rect-token', valid, reason: valid ? null : '["R",…] 必须紧跟 6 个数字（x1,y1,x2,y2,rx,ry）；实测 4 个数字会被 createPolygon 拒绝' };
  }
  if (head === 'CIRCLE') {
    const numbers = source.slice(1);
    const valid = numbers.length === 3 && numbers.every(Number.isFinite);
    return { form: 'circle-token', valid, reason: valid ? null : '["CIRCLE",cx,cy,r] 必须紧跟 3 个数字' };
  }
  if (typeof head === 'number') {
    const tokenIndex = 2;
    const token = source[tokenIndex];
    if (!['L', 'ARC', 'CARC'].includes(token)) return { form: 'path', valid: false, reason: '坐标开头的多边形必须在索引 2 给出段类型 token（"L" / "ARC" / "CARC"）' };
    const points = source.slice(3);
    if (!Number.isFinite(head) || !Number.isFinite(source[1])) return { form: 'path', valid: false, reason: '起点坐标必须是有限数字' };
    if (points.length < 2 || points.length % 2 || !points.every(Number.isFinite)) return { form: 'path', valid: false, reason: 'token 之后的点坐标必须成对出现且至少 1 个点' };
    return { form: 'path', valid: true, reason: null };
  }
  return { form: 'invalid', valid: false, reason: `不支持的多边形首元素: ${JSON.stringify(head)}` };
}

export function assertPolygonSource(source) {
  const verdict = classifyPolygonSource(source);
  if (!verdict.valid) throw Object.assign(new Error(`多边形源码不合法（${verdict.form}）：${verdict.reason}`), { code: 'EDA_POLYGON_INVALID', ...verdict });
  return source;
}

/** 闭合矩形路径：`[x0,y0,"L",x1,y1,x2,y2,x3,y3,x0,y0]`（实测可创建）。 */
export function rectPolygonSource({ originXMm = 0, originYMm = 0, widthMm, heightMm, unit = 'mm' }) {
  const convert = unit === 'mil' ? (value) => Number(value) : mmToMil;
  const x0 = convert(originXMm);
  const y0 = convert(originYMm);
  const x1 = convert(originXMm + widthMm);
  const y1 = convert(originYMm + heightMm);
  const round = (value) => Math.round(value * 10000) / 10000;
  const source = [round(x0), round(y0), 'L', round(x1), round(y0), round(x1), round(y1), round(x0), round(y1), round(x0), round(y0)];
  return assertPolygonSource(source);
}

/** 任意折线/多边形路径（坐标由调用方给出，单位 mil）。 */
export function pathPolygonSource(points) {
  const flat = Array.isArray(points) ? points.flat(Infinity) : [];
  if (flat.length < 4 || flat.length % 2 || !flat.every(Number.isFinite)) throw Object.assign(new Error('路径点必须是成对的有限数字，且至少两个点'), { code: 'EDA_POLYGON_INVALID' });
  return assertPolygonSource([flat[0], flat[1], 'L', ...flat.slice(2)]);
}

export function circlePolygonSource({ centerXMm, centerYMm, radiusMm, unit = 'mm' }) {
  const convert = unit === 'mil' ? (value) => Number(value) : mmToMil;
  return assertPolygonSource(['CIRCLE', convert(centerXMm), convert(centerYMm), convert(radiusMm)]);
}

/**
 * 板框语义检查：必须是**闭合**轮廓，否则 EDA 不会把它当作板框
 * （实测闭合矩形创建后 `PCB_Document.zoomToBoardOutline()` 返回 true）。
 */
export function assertClosedOutlineSource(source) {
  assertPolygonSource(source);
  const flat = source.filter((item) => typeof item === 'number');
  const first = [flat[0], flat[1]];
  const last = [flat[flat.length - 2], flat[flat.length - 1]];
  const closed = Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6;
  if (!closed) throw Object.assign(new Error('板框轮廓必须闭合（首尾点相同），否则 EDA 不会识别为板框'), { code: 'EDA_OUTLINE_NOT_CLOSED', first, last });
  return source;
}

/** 供文档/UI 展示的能力事实（与 README §5 同源）。 */
export const EDA_PRIMITIVE_FACTS = Object.freeze({
  lineRejectsNonCopper: true,
  misleadingErrorText: '错误：无法创建直线图元，可能是传入的参数不正确。',
  boardOutlineLayerId: LAYER_IDS.BOARD_OUTLINE,
  boardOutlineApi: 'PCB_PrimitivePolyline.create + PCB_MathPolygon.createPolygon',
  polygonEncodingSource: 'PCB 文档源码 POUR 记录的 path 字段（无官方文档）',
  runtimeLayerEnumExported: false,
  polylineAcceptsCircleButRejectsRect: true,
});
