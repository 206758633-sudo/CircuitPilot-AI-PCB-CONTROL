/**
 * 焊盘间距几何：把 EDA 焊盘 shape（如 ["RECT", 长, 宽, 旋转]）折算成"间距校验用的等效半径"。
 *
 * 为什么单独成模块：这个半径同时决定①布线器 A* 的障碍模型、②写入前复核的最小间距，
 * 一旦和 EDA 的真实 DRC 不一致，规划永远"自认为通过"、真机 DRC 却报错（真机第 58 轮踩过）。
 *
 * 关键取舍（矩形/椭圆焊盘）：
 * - 旧实现 `Math.max(...sizes)/2` 把**长边**当直径，0.4mm 间距的细间距器件（RECT 0.6×0.2mm）
 *   会被算成半径 0.3mm 的圆 → 相邻焊盘"互相重叠" → 所有 A* 路线判间距不足、计划无法通过复核；
 * - 现在取**内切半径**（最短边/2）：矩形焊盘的内切圆不会超出焊盘本体，对间距是保守（偏小）估计，
 *   配合规划端额外的安全余量，方向正确；圆焊盘长短边相等，取 min/max 结果相同。
 *
 * 这是"间距模型的近似"，不是 EDA 精确几何；精确校验以写入后的 EDA DRC 为准。
 */
export const DEFAULT_PAD_RADIUS_MIL = 5;

export function padClearanceRadiusMil(sizes) {
  // 只取**正数尺寸**：EDA 的 pad shape 形如 ["RECT", 长, 宽, 旋转角]，
  // 第三个数常是 0°（旋转）——若把 0 当尺寸，min 会得 0，半径变 0，间距校验就永远"通过"（真机踩过）。
  const list = (Array.isArray(sizes) ? sizes : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  // 注意：默认值必须写成函数内部的字面量。这个函数会被 `toString()` 注入 EDA 执行上下文
  // （bridge 的 pcb.copper.read 就是这么做的），引用模块级常量会让 EDA 侧抛
  // `DEFAULT_PAD_RADIUS_MIL is not defined` → Bridge HTTP 500（真机第 30 轮踩过）。
  const FALLBACK_RADIUS_MIL = 5;
  if (!list.length) return FALLBACK_RADIUS_MIL;
  return Math.min.apply(null, list) / 2;
}

/**
 * 焊盘"保守半径"（间距校验用）：矩形焊盘按**外接圆**半径（半对角线）算，
 * 保证任何方向的间距都不小于真实几何——真机踩过：内切半径把 0.5×0.54mm 矩形焊盘
 * 当成 r=0.25mm 的圆，斜穿焊盘角落的走线在规划里"合规"、真机 DRC 却报 SMD Pad to Track。
 * 连通性/接触判定仍用内切半径（padClearanceRadiusMil），两者不能混用。
 */
export function padConservativeRadiusMil(sizes) {
  const list = (Array.isArray(sizes) ? sizes : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!list.length) return 5;
  if (list.length === 1) return list[0] / 2;
  return Math.sqrt(list.reduce((total, value) => total + value * value, 0)) / 2;
}
