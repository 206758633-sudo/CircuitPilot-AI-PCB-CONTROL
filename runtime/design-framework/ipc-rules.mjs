/**
 * IPC-2221 / IPC-2152 近似公式集（Rule-as-Code 的"数值判据"层）。
 *
 * 定位：规则包（board-layout-rules.json）里大量判定依赖"载流宽度 / 过孔载流 / 电气间距"
 * 这类**可计算**的量。本文件只提供纯函数公式与阈值表，不做规则判定（判定在 rule-deck.mjs），
 * 也不读文件、不联网、不取当前时间——同输入必得同输出。
 *
 * 重要：这是**近似公式**，不是 IPC 标准的完整实现，更不能替代板厂确认单 / EDA DRC。
 * 所有返回值把 formula / assumptions / source 一并带出，让评审能复核"这个数是怎么来的"。
 *
 * 公式来源：
 *   - 载流能力：IPC-2221B §6.2 经验式 I = k · ΔT^0.44 · A^0.725
 *       I  = 允许电流 (A)
 *       ΔT = 允许温升 (°C，常见取 10)
 *       A  = 导体截面积 (mil²)
 *       k  = 外层 0.048 / 内层 0.024（外层散热好，同样截面积可多载一倍左右）
 *     该式在 ΔT ≤ 100 ℃、A 为常规 PCB 铜厚范围内是工程近似；不适用于 e.g. 埋铜块/厚铜特殊工艺。
 *   - 铜厚换算：1 oz = 1.378 mil（= 34.79 µm，业界常用 1.37–1.38 mil，这里显式固定为 1.378）。
 *   - 过孔载流：把过孔孔壁铜展开成"周长 × 镀层厚"的等效截面，代入同一经验式；
 *     因为孔壁被基材包围、散热比外层走线差，k 取**内层系数 0.024**（保守，不冒充外层）。
 *   - 电气间距：IPC-2221B Table 6-1（电压档位表，见下方 IPC_CLEARANCE_TABLE）。
 *     表按 4 个常用列近似：内层/外层 × 涂覆/未涂覆；>500 V 按标准注记 0.0025 mm/V 线性外推。
 *
 * fail-closed 约定：任何参数非法都返回 { ok:false, code:'IPC_INVALID_INPUT', field, message }，
 * **绝不**返回一个"看起来还行"的数值；调用方必须显式处理 ok:false。
 */

/** 错误码：所有输入非法统一走 IPC_INVALID_INPUT（细节在 field/details 里，便于测试与 UI 展示）。 */
export const IPC_CODES = Object.freeze({
  INVALID_INPUT: 'IPC_INVALID_INPUT',
});

export const IPC_SOURCES = Object.freeze({
  currentCapacity: 'IPC-2221B §6.2 经验式 I = k·ΔT^0.44·A^0.725',
  clearance: 'IPC-2221B Table 6-1 电气间距（近似取值表）',
  via: 'IPC-2221B §6.2 经验式用于过孔孔壁等效截面（k 取内层 0.024，保守）',
});

/* ------------------------------------------------------------------ */
/* 单位与系数                                                          */
/* ------------------------------------------------------------------ */

const MIL_PER_MM = 1 / 0.0254; // 39.37007874015748
const MM2_PER_MIL2 = 0.0254 * 0.0254;
/** 1 oz 铜厚对应的 mil 数（固定值，可复核；1 oz = 34.79 µm ≈ 1.378 mil）。 */
const OZ_TO_MIL = 1.378;
const K_OUTER = 0.048;
const K_INNER = 0.024;
const K_LAYER = Object.freeze({ outer: K_OUTER, inner: K_INNER });
/** 经验式适用上限：ΔT 超过 100 ℃ 时曲线外推不可信，直接拒算而不是硬给数。 */
const MAX_TEMP_RISE_C = 100;
const MAX_THICKNESS_OZ = 20;
const MAX_WIDTH_MM = 1000;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 6) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : value);

function invalid(field, message, details = {}) {
  return { ok: false, code: IPC_CODES.INVALID_INPUT, field, message, details };
}

/** 通用数值校验：返回数字或 null（null 表示非法，调用方负责构造 invalid 结果）。 */
function readNumber(raw, field, { min = -Infinity, max = Infinity, exclusiveMin = false } = {}) {
  if (!isFiniteNumber(raw)) return { value: null, message: `${field} 必须是有限数值（收到 ${JSON.stringify(raw ?? null)}）` };
  if (exclusiveMin ? raw <= min : raw < min) return { value: null, message: `${field} 必须${exclusiveMin ? '大于' : '不小于'} ${min}（收到 ${raw}）` };
  if (raw > max) return { value: null, message: `${field} 不能大于 ${max}（收到 ${raw}）` };
  return { value: raw, message: null };
}

function readLayer(layer) {
  if (layer === 'outer' || layer === 'inner') return { value: layer, message: null };
  return { value: null, message: `layer 必须是 'outer' 或 'inner'（收到 ${JSON.stringify(layer ?? null)}）` };
}

/** 截面积（mil²）→ 载流（A）。内部实现，供 widthForCurrent 反解后回算。 */
function capacityFromArea(areaMil2, tempRiseC, k) {
  return k * tempRiseC ** 0.44 * areaMil2 ** 0.725;
}

/* ------------------------------------------------------------------ */
/* 载流：走线                                                          */
/* ------------------------------------------------------------------ */

/**
 * 走线载流能力（IPC-2221 近似式）。
 *
 * @param {{widthMm?: number, thicknessOz?: number, layer?: 'outer'|'inner', tempRiseC?: number}} [input]
 * @returns {{ok:true, ampacityA:number, crossSectionMil2:number, crossSectionMm2:number,
 *            k:number, layer:string, tempRiseC:number, formula:string, assumptions:string[], source:string}
 *          | {ok:false, code:string, field:string, message:string, details:object}}
 */
export function currentCapacityA({ widthMm, thicknessOz = 1, layer = 'outer', tempRiseC = 10 } = {}) {
  const width = readNumber(widthMm, 'widthMm', { min: 0, exclusiveMin: true, max: MAX_WIDTH_MM });
  if (width.value === null) return invalid('widthMm', width.message);
  const thickness = readNumber(thicknessOz, 'thicknessOz', { min: 0, exclusiveMin: true, max: MAX_THICKNESS_OZ });
  if (thickness.value === null) return invalid('thicknessOz', thickness.message);
  const layerValue = readLayer(layer);
  if (layerValue.value === null) return invalid('layer', layerValue.message);
  const temp = readNumber(tempRiseC, 'tempRiseC', { min: 0, exclusiveMin: true, max: MAX_TEMP_RISE_C });
  if (temp.value === null) return invalid('tempRiseC', temp.message);

  const widthMil = width.value * MIL_PER_MM;
  const thicknessMil = thickness.value * OZ_TO_MIL;
  const crossSectionMil2 = widthMil * thicknessMil;
  const k = K_LAYER[layerValue.value];
  const ampacityA = capacityFromArea(crossSectionMil2, temp.value, k);
  return {
    ok: true,
    ampacityA,
    crossSectionMil2,
    crossSectionMm2: crossSectionMil2 * MM2_PER_MIL2,
    k,
    layer: layerValue.value,
    tempRiseC: temp.value,
    thicknessOz: thickness.value,
    widthMm: width.value,
    formula: 'I = k · ΔT^0.44 · A^0.725，其中 A(mil²) = (widthMm / 0.0254) × (thicknessOz × 1.378)，k_outer = 0.048 / k_inner = 0.024',
    assumptions: [
      '外层 k=0.048、内层 k=0.024（IPC-2221 经验式）；内层/被基材包围的导体散热差，同截面载流约为外层一半',
      '1 oz = 1.378 mil 固定换算；实际铜厚以板厂叠层确认单为准',
      '经验式适用于 ΔT ≤ 100 ℃、常规 PCB 铜厚；厚铜/埋铜块/铜排不在适用范围内',
      '结果不含焊盘/过孔/铺铜的散热增益，也不含邻近导体热耦合',
    ],
    source: IPC_SOURCES.currentCapacity,
  };
}

/**
 * 反解：给定电流求最小走线宽度（IPC-2221 近似式反解，不做 0.05 mm 网格取整）。
 *
 * 语义：
 *   - widthMm = max(requiredWidthMm, minWidthMm)：受工艺最小线宽夹紧；
 *   - feasible = requiredWidthMm ≤ maxWidthMm：工艺窗口能不能容纳所需宽度；
 *   - ampacityA / marginA 都是对**返回的 widthMm** 回算，保证自洽。
 *
 * @param {{currentA?: number, thicknessOz?: number, layer?: 'outer'|'inner', tempRiseC?: number,
 *          minWidthMm?: number, maxWidthMm?: number}} [input]
 */
export function widthForCurrent({
  currentA, thicknessOz = 1, layer = 'outer', tempRiseC = 10, minWidthMm = 0.05, maxWidthMm = 20,
} = {}) {
  const current = readNumber(currentA, 'currentA', { min: 0, exclusiveMin: true });
  if (current.value === null) return invalid('currentA', current.message);
  const thickness = readNumber(thicknessOz, 'thicknessOz', { min: 0, exclusiveMin: true, max: MAX_THICKNESS_OZ });
  if (thickness.value === null) return invalid('thicknessOz', thickness.message);
  const layerValue = readLayer(layer);
  if (layerValue.value === null) return invalid('layer', layerValue.message);
  const temp = readNumber(tempRiseC, 'tempRiseC', { min: 0, exclusiveMin: true, max: MAX_TEMP_RISE_C });
  if (temp.value === null) return invalid('tempRiseC', temp.message);
  const minWidth = readNumber(minWidthMm, 'minWidthMm', { min: 0, exclusiveMin: true, max: MAX_WIDTH_MM });
  if (minWidth.value === null) return invalid('minWidthMm', minWidth.message);
  const maxWidth = readNumber(maxWidthMm, 'maxWidthMm', { min: 0, exclusiveMin: true, max: MAX_WIDTH_MM });
  if (maxWidth.value === null) return invalid('maxWidthMm', maxWidth.message);
  if (maxWidth.value < minWidth.value) return invalid('maxWidthMm', `maxWidthMm (${maxWidth.value}) 不能小于 minWidthMm (${minWidth.value})`);

  const k = K_LAYER[layerValue.value];
  const thicknessMil = thickness.value * OZ_TO_MIL;
  const requiredAreaMil2 = (current.value / (k * temp.value ** 0.44)) ** (1 / 0.725);
  const requiredWidthMm = requiredAreaMil2 / thicknessMil / MIL_PER_MM;
  const widthMm = Math.max(requiredWidthMm, minWidth.value);
  const ampacityA = capacityFromArea(widthMm * MIL_PER_MM * thicknessMil, temp.value, k);
  const feasible = requiredWidthMm <= maxWidth.value;
  return {
    ok: true,
    currentA: current.value,
    widthMm,
    requiredWidthMm,
    minWidthMm: minWidth.value,
    maxWidthMm: maxWidth.value,
    ampacityA,
    marginA: ampacityA - current.value,
    feasible,
    formula: 'width = (I / (k·ΔT^0.44))^(1/0.725) / (thicknessOz × 1.378) / 39.37，再按 minWidthMm 夹紧；反解不加取整网格',
    assumptions: [
      '按 IPC-2221 经验式反解，未做 0.05 mm 工艺网格取整（整定由调用方/规则层完成）',
      'requiredWidthMm > maxWidthMm 时 feasible=false，widthMm 如实返回超窗口的理论值',
      '未考虑铺铜/过孔/焊盘散热，也未考虑压降与阻抗约束',
    ],
    source: IPC_SOURCES.currentCapacity,
  };
}

/* ------------------------------------------------------------------ */
/* 载流：过孔                                                          */
/* ------------------------------------------------------------------ */

/**
 * 过孔（孔壁镀铜）载流能力。把孔壁铜展开成等效截面积：
 *   A_mil² = π × ((holeMm + diameterMm) / 2) × (platingUm / 1000) × 39.37²
 * 再代入 IPC-2221 经验式；k 取内层 0.024（孔壁被基材包围，散热差，保守取值）。
 *
 * @param {{diameterMm?: number, holeMm?: number, platingUm?: number, tempRiseC?: number}} [input]
 */
export function viaCurrentCapacityA({ diameterMm, holeMm, platingUm = 25, tempRiseC = 10 } = {}) {
  const diameter = readNumber(diameterMm, 'diameterMm', { min: 0, exclusiveMin: true, max: 100 });
  if (diameter.value === null) return invalid('diameterMm', diameter.message);
  const hole = readNumber(holeMm, 'holeMm', { min: 0, exclusiveMin: true, max: 100 });
  if (hole.value === null) return invalid('holeMm', hole.message);
  if (diameter.value <= hole.value) return invalid('diameterMm', `过孔外径 (${diameter.value}) 必须大于孔径 (${hole.value})`);
  const plating = readNumber(platingUm, 'platingUm', { min: 0, exclusiveMin: true, max: 200 });
  if (plating.value === null) return invalid('platingUm', plating.message);
  const temp = readNumber(tempRiseC, 'tempRiseC', { min: 0, exclusiveMin: true, max: MAX_TEMP_RISE_C });
  if (temp.value === null) return invalid('tempRiseC', temp.message);

  const meanDiameterMm = (hole.value + diameter.value) / 2;
  const barrelCopperAreaMm2 = Math.PI * meanDiameterMm * (plating.value / 1000);
  const barrelCopperAreaMil2 = barrelCopperAreaMm2 / MM2_PER_MIL2;
  const ampacityA = capacityFromArea(barrelCopperAreaMil2, temp.value, K_INNER);
  return {
    ok: true,
    ampacityA,
    barrelCopperAreaMil2,
    barrelCopperAreaMm2,
    meanDiameterMm,
    k: K_INNER,
    tempRiseC: temp.value,
    formula: 'A_mil² = π × meanDia(mm) × plating(mm) / 0.0254²；I = 0.024 · ΔT^0.44 · A^0.725（孔壁保守按内层 k）',
    assumptions: [
      '假设孔壁镀铜均匀、镀层厚度 = platingUm；实际以板厂孔铜切片/工艺单为准',
      'k 取内层 0.024（孔壁散热差，不用外层 0.048，避免高估）',
      '未考虑孔内填充/塞孔导热、多个过孔并联时的互热与电流分配不均',
    ],
    source: IPC_SOURCES.via,
  };
}

/* ------------------------------------------------------------------ */
/* 电气间距（IPC-2221 Table 6-1 近似表）                                */
/* ------------------------------------------------------------------ */

/**
 * IPC-2221B Table 6-1 电气间距近似表（单位 mm）。
 *
 * 说明：
 *   - 列为 内层未涂覆 / 内层涂覆 / 外层未涂覆 / 外层涂覆；
 *   - 档位取常用电压节点；>500 V 时按标准注记 "每超过 500 V 加 0.0025 mm/V" 线性外推；
 *   - 这是**近似表**：真实设计应按 IPC-2221 完整表 + 板厂能力 + 安规要求复核，
 *     高湿/高海拔/污染等级场景需额外降额。
 */
export const IPC_CLEARANCE_TABLE = Object.freeze([
  Object.freeze({ maxVoltageV: 15, internalUncoated: 0.05, internalCoated: 0.05, externalUncoated: 0.10, externalCoated: 0.05 }),
  Object.freeze({ maxVoltageV: 30, internalUncoated: 0.05, internalCoated: 0.05, externalUncoated: 0.10, externalCoated: 0.05 }),
  Object.freeze({ maxVoltageV: 50, internalUncoated: 0.10, internalCoated: 0.10, externalUncoated: 0.60, externalCoated: 0.13 }),
  Object.freeze({ maxVoltageV: 100, internalUncoated: 0.10, internalCoated: 0.10, externalUncoated: 0.60, externalCoated: 0.13 }),
  Object.freeze({ maxVoltageV: 150, internalUncoated: 0.20, internalCoated: 0.20, externalUncoated: 0.60, externalCoated: 0.40 }),
  Object.freeze({ maxVoltageV: 170, internalUncoated: 0.20, internalCoated: 0.20, externalUncoated: 1.25, externalCoated: 0.40 }),
  Object.freeze({ maxVoltageV: 250, internalUncoated: 0.20, internalCoated: 0.20, externalUncoated: 1.25, externalCoated: 0.40 }),
  Object.freeze({ maxVoltageV: 300, internalUncoated: 0.20, internalCoated: 0.20, externalUncoated: 1.25, externalCoated: 0.40 }),
  Object.freeze({ maxVoltageV: 500, internalUncoated: 0.25, internalCoated: 0.25, externalUncoated: 2.50, externalCoated: 0.80 }),
]);
/** 表别名（任务/评审常写作 TABLE）。 */
export const TABLE = IPC_CLEARANCE_TABLE;
/** >500 V 外推系数（标准注记：超过 500 V 每伏加 0.0025 mm）。 */
export const CLEARANCE_EXTRAPOLATION_MM_PER_V = 0.0025;

/**
 * 电气间距最小要求（IPC-2221 近似）。
 * @param {{voltageV?: number, coated?: boolean, external?: boolean}} [input]
 * @returns {{ok:true, clearanceMm:number, column:string, row:object, voltageV:number,
 *            formula:string, assumptions:string[], source:string, warn?:string}
 *          | {ok:false, code:string, field:string, message:string, details:object}}
 */
export function minClearanceMm({ voltageV, coated = true, external = true } = {}) {
  if (!isFiniteNumber(voltageV)) return invalid('voltageV', `voltageV 必须是有限数值（收到 ${JSON.stringify(voltageV ?? null)}）`);
  if (voltageV < 0) return invalid('voltageV', `voltageV 不能为负（收到 ${voltageV}）`);
  if (typeof coated !== 'boolean') return invalid('coated', `coated 必须是布尔值（收到 ${JSON.stringify(coated ?? null)}）`);
  if (typeof external !== 'boolean') return invalid('external', `external 必须是布尔值（收到 ${JSON.stringify(external ?? null)}）`);

  const column = external ? (coated ? 'externalCoated' : 'externalUncoated') : (coated ? 'internalCoated' : 'internalUncoated');
  const lastRow = IPC_CLEARANCE_TABLE[IPC_CLEARANCE_TABLE.length - 1];
  const row = IPC_CLEARANCE_TABLE.find((entry) => voltageV <= entry.maxVoltageV) ?? lastRow;
  const overVoltage = Math.max(0, voltageV - lastRow.maxVoltageV);
  const clearanceMm = row[column] + overVoltage * CLEARANCE_EXTRAPOLATION_MM_PER_V;
  const result = {
    ok: true,
    clearanceMm: round(clearanceMm, 6),
    column,
    row,
    voltageV,
    coated,
    external,
    formula: `clearance = Table[档位 ${row.maxVoltageV} V].${column}${overVoltage > 0 ? ' + (V-500)×0.0025' : ''}`,
    assumptions: [
      '按 IPC-2221B Table 6-1 的常用列近似（内层/外层 × 涂覆/未涂覆），未细分海拔/湿度/污染等级',
      '>500 V 按标准注记 0.0025 mm/V 线性外推；超高电压/安规场景必须按完整标准与认证要求复核',
      '涂覆质量、阻焊厚度、板面污染都会影响实际耐受电压，本值只是几何下限',
    ],
    source: IPC_SOURCES.clearance,
  };
  if (voltageV > lastRow.maxVoltageV) {
    result.warn = `voltageV ${voltageV} V 超过表内最大档位 ${lastRow.maxVoltageV} V，已按 0.0025 mm/V 外推，结果需人工复核`;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 辅助（可选）                                                        */
/* ------------------------------------------------------------------ */

/** 铜截面（mm²）：widthMm × thicknessOz × 0.03479（1 oz ≈ 34.79 µm）。 */
export function copperCrossSectionMm2({ widthMm, thicknessOz = 1 } = {}) {
  const width = readNumber(widthMm, 'widthMm', { min: 0, exclusiveMin: true, max: MAX_WIDTH_MM });
  if (width.value === null) return invalid('widthMm', width.message);
  const thickness = readNumber(thicknessOz, 'thicknessOz', { min: 0, exclusiveMin: true, max: MAX_THICKNESS_OZ });
  if (thickness.value === null) return invalid('thicknessOz', thickness.message);
  return { ok: true, crossSectionMm2: width.value * thickness.value * 0.03479, formula: 'A(mm²) = widthMm × thicknessOz × 0.03479' };
}

/** 电流密度（A/mm²）：currentA / 截面积，用于粗略热评估（不是 IPC 判定本身）。 */
export function currentDensityAPerMm2({ currentA, widthMm, thicknessOz = 1 } = {}) {
  const current = readNumber(currentA, 'currentA', { min: 0, max: 1000 });
  if (current.value === null) return invalid('currentA', current.message);
  const section = copperCrossSectionMm2({ widthMm, thicknessOz });
  if (!section.ok) return section;
  return {
    ok: true,
    currentDensityAPerMm2: section.crossSectionMm2 > 0 ? current.value / section.crossSectionMm2 : null,
    crossSectionMm2: section.crossSectionMm2,
    formula: 'J = I / (widthMm × thicknessOz × 0.03479)',
  };
}
