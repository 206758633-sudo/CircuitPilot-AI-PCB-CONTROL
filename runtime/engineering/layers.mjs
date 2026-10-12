/**
 * 嘉立创EDA(专业版) 层模型。
 *
 * 依据本机安装的官方扩展 API 类型定义：
 *   /Applications/嘉立创EDA(专业版).app/Contents/Resources/app/assets/pro-api/0.3.18.0bc12bb0/api-types.d.ts
 *   - enum EPCB_LayerId        —— 层编号
 *   - class PCB_Layer          —— setTheNumberOfCopperLayers / getTheNumberOfCopperLayers / getAllLayers
 *   - TPCB_LayersOfCopper      —— 铜层允许的层编号
 *
 * 这里存在的陷阱（本模块存在的唯一理由）：
 *   内层铜层编号是 **15 起**（INNER_1=15 … INNER_30=44），而 3/4 是丝印、5/6 是阻焊。
 *   如果把"叠层第 N 层"直接当 layer 编号传给 EDA，四层板的"第 2 层"（layer=3）
 *   会静默地画到 **顶层丝印** 上。走线落在丝印层上不一定会被 DRC 拦下，
 *   但板子已经废了。所以任何跨层引用都必须经过本模块换算，不允许裸写层号。
 */

/** 与官方 EPCB_LayerId 一一对应；只列本项目会引用到的项。 */
export const LAYER_IDS = Object.freeze({
  TOP: 1,
  BOTTOM: 2,
  TOP_SILKSCREEN: 3,
  BOTTOM_SILKSCREEN: 4,
  TOP_SOLDER_MASK: 5,
  BOTTOM_SOLDER_MASK: 6,
  TOP_PASTE_MASK: 7,
  BOTTOM_PASTE_MASK: 8,
  TOP_ASSEMBLY: 9,
  BOTTOM_ASSEMBLY: 10,
  BOARD_OUTLINE: 11,
  MULTI: 12,
  DOCUMENT: 13,
  MECHANICAL: 14,
  INNER_1: 15,
  LAST_INNER: 44,
  RATLINE: 57,
  TOP_STIFFENER: 58,
  BOTTOM_STIFFENER: 59,
  CUSTOM_1: 71,
});

/** 官方 setTheNumberOfCopperLayers 接受 2,4,6,…,32。 */
export const MAX_COPPER_LAYERS = 32;
export const MAX_INNER_LAYERS = 30;
export const EDA_COPPER_LAYER_COUNTS = Object.freeze(
  Array.from({ length: MAX_COPPER_LAYERS / 2 }, (_, index) => (index + 1) * 2),
);

/**
 * 执行路径当前放行的层数。
 *
 * 刻意小于 EDA 能力（32）：validateStackup 目前只为 4/6/8 定义铜层校验与阻抗上下文，
 * 10 层以上没有叠层证据模型，放行等于让没有校验能力的层数进入生产。
 */
export const PLAN_COPPER_LAYER_COUNTS = Object.freeze([2, 4, 6, 8]);

const ROLE_BY_LAYER_ID = new Map([
  [LAYER_IDS.TOP, 'top-copper'],
  [LAYER_IDS.BOTTOM, 'bottom-copper'],
  [LAYER_IDS.TOP_SILKSCREEN, 'top-silkscreen'],
  [LAYER_IDS.BOTTOM_SILKSCREEN, 'bottom-silkscreen'],
  [LAYER_IDS.TOP_SOLDER_MASK, 'top-solder-mask'],
  [LAYER_IDS.BOTTOM_SOLDER_MASK, 'bottom-solder-mask'],
  [LAYER_IDS.TOP_PASTE_MASK, 'top-paste-mask'],
  [LAYER_IDS.BOTTOM_PASTE_MASK, 'bottom-paste-mask'],
  [LAYER_IDS.TOP_ASSEMBLY, 'top-assembly'],
  [LAYER_IDS.BOTTOM_ASSEMBLY, 'bottom-assembly'],
  [LAYER_IDS.BOARD_OUTLINE, 'board-outline'],
  [LAYER_IDS.MULTI, 'multi'],
  [LAYER_IDS.DOCUMENT, 'document'],
  [LAYER_IDS.MECHANICAL, 'mechanical'],
  [LAYER_IDS.RATLINE, 'ratline'],
  [LAYER_IDS.TOP_STIFFENER, 'top-stiffener'],
  [LAYER_IDS.BOTTOM_STIFFENER, 'bottom-stiffener'],
]);

export function isEdaCopperLayerCount(value) {
  return Number.isInteger(value) && EDA_COPPER_LAYER_COUNTS.includes(value);
}

export function isPlanCopperLayerCount(value) {
  return Number.isInteger(value) && PLAN_COPPER_LAYER_COUNTS.includes(value);
}

export function layerRole(layerId) {
  if (ROLE_BY_LAYER_ID.has(layerId)) return ROLE_BY_LAYER_ID.get(layerId);
  if (Number.isInteger(layerId) && layerId >= LAYER_IDS.INNER_1 && layerId <= LAYER_IDS.LAST_INNER) return 'inner-copper';
  if (Number.isInteger(layerId) && layerId >= LAYER_IDS.CUSTOM_1) return 'custom';
  return 'unknown';
}

/**
 * 按叠层顺序（从上到下）返回铜层编号。
 *
 * 2 层 -> [1,2]；4 层 -> [1,15,16,2]；6 层 -> [1,15,16,17,18,2]。
 * 注意第 2 个元素在 4 层板里是 15 而不是 3。
 */
export function copperLayerIds(layerCount) {
  if (!isEdaCopperLayerCount(layerCount)) throw new Error(`COPPER_LAYER_COUNT_UNSUPPORTED: ${layerCount}`);
  if (layerCount === 2) return [LAYER_IDS.TOP, LAYER_IDS.BOTTOM];
  const ids = [LAYER_IDS.TOP];
  for (let index = 0; index < layerCount - 2; index += 1) ids.push(LAYER_IDS.INNER_1 + index);
  ids.push(LAYER_IDS.BOTTOM);
  return ids;
}

export function isCopperLayerId(layerId, layerCount) {
  if (!isEdaCopperLayerCount(layerCount)) return false;
  return copperLayerIds(layerCount).includes(layerId);
}

/** 叠层序号（0 起，从上到下）-> EDA 层编号。 */
export function stackupIndexToLayerId(layerCount, index) {
  const ids = copperLayerIds(layerCount);
  if (!Number.isInteger(index) || index < 0 || index >= ids.length) throw new Error(`STACKUP_INDEX_OUT_OF_RANGE: ${index}`);
  return ids[index];
}

/** EDA 层编号 -> 叠层序号；不是该层数的铜层则返回 -1。 */
export function layerIdToStackupIndex(layerCount, layerId) {
  return copperLayerIds(layerCount).indexOf(layerId);
}

/** 统计叠层对象里的铜层数量，用于与 board.layers 交叉核对。 */
export function countCopperLayers(stackup) {
  const layers = Array.isArray(stackup?.layers) ? stackup.layers : [];
  return layers.filter((layer) => layer?.type === 'copper').length;
}

/**
 * 校验计划里所有跨层引用都落在“声明层数的铜层集合”内。
 *
 * 板框（BOARD_OUTLINE）是合法例外：它本来就画在非铜的板框层上。
 * 返回违规列表而不是布尔值，便于把确切的操作序号报给用户。
 */
export function validateLayerReferences(board, operations = []) {
  const layerCount = Number(board?.layers);
  const violations = [];
  if (!isEdaCopperLayerCount(layerCount)) {
    violations.push({ index: -1, layer: layerCount, reason: 'BOARD_LAYER_COUNT_UNSUPPORTED' });
    return violations;
  }
  const allowed = new Set(copperLayerIds(layerCount));
  for (const [index, operation] of operations.entries()) {
    const layer = operation?.args?.layer;
    if (layer === undefined || layer === null) continue;
    if (!Number.isInteger(layer)) { violations.push({ index, layer, reason: 'LAYER_ID_NOT_INTEGER' }); continue; }
    if (layer === LAYER_IDS.BOARD_OUTLINE && operation?.type === 'pcb.line.create') continue;
    if (!allowed.has(layer)) {
      // 把最常见的误解单独标出来：用叠层序号当层号，实际落到了丝印/阻焊等非铜层。
      const role = layerRole(layer);
      violations.push({ index, layer, reason: role === 'unknown' ? 'LAYER_NOT_IN_DECLARED_STACKUP' : `LAYER_IS_NOT_COPPER:${role}` });
    }
  }
  return violations;
}
