/**
 * 布线层选择：把 EDA 的 `pcb.layers.read` 结果折算成"这块板真实可用的铜层集合"。
 *
 * 为什么必须单独成模块：真机第 58 轮踩过——4 层板的层列表返回的是**全部理论层**
 * （46 层都列出来，type=SIGNAL、id 1..44 之类），而布线器默认只认 `[1,2,17,18]`
 * 并把内层默认成 17。于是计划里出现 layer 17（板上不存在的层）→ 应用到 EDA 必然 Bridge 500；
 * 换一种过滤方式又把 Inner15(29) 当成可用内层。
 *
 * 判据：只有 `layerStatus === 1` 的层是**本板启用**的层，其余是未使用的理论层。
 * 顶层/底层固定是 1/2；内层 id 15..44。读不到/不足两层就返回 null，让调用方保留默认值，
 * 由后续独立复核拦截——绝不"猜一个层号继续跑"。
 */
export function selectRoutableLayers(layerReadback) {
  const items = Array.isArray(layerReadback)
    ? layerReadback
    : Array.isArray(layerReadback?.layers) ? layerReadback.layers : [];
  const isCopper = (item) => {
    const type = String(item?.type || '').toUpperCase();
    const id = Number(item?.id);
    if (!Number.isInteger(id)) return false;
    // 桥层现在归一化出 enabled（layerStatus===1）；兼容未升级的旧读回仍用 layerStatus。
    if (item?.enabled === false) return false;
    const enabled = item?.enabled === true || item?.layerStatus === 1;
    if (!enabled) return false;
    if (type === 'SIGNAL') return true;
    if (/COPPER|铜箔|顶层|底层|内层/i.test(String(item?.name || ''))) return true;
    return id === 1 || id === 2 || (id >= 15 && id <= 44);
  };
  const layers = items
    .filter(isCopper)
    .map((item) => Number(item.id))
    .filter((id) => Number.isInteger(id) && (id === 1 || id === 2 || (id >= 15 && id <= 44)))
    .sort((a, b) => a - b);
  if (layers.length < 2) return null;
  const innerIds = layers.filter((id) => id >= 15);
  return { layers, innerLayer: innerIds.length ? innerIds[0] : null };
}
