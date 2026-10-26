import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAD_RADIUS_MIL, padClearanceRadiusMil } from '../pad-geometry.mjs';

test('矩形焊盘按内切半径建模：0.4mm 间距的 RECT 焊盘不会被算成互相重叠', () => {
  // 真机 U5(ES7210, QFN 0.4mm pitch) 焊盘实测 23.6 × 7.9 mil：内切半径 = 7.9/2
  assert.equal(padClearanceRadiusMil([23.6, 7.9, 0]), 7.9 / 2);
  // 旧实现是 Math.max(...)/2 = 11.8：比实际大 3 倍，相邻焊盘被判"重叠"→ 所有 A* 布线失败
  assert.ok(padClearanceRadiusMil([23.6, 7.9, 0]) < 23.6 / 2);
});

test('圆形焊盘长短边相等：取 min 与取 max 结果相同', () => {
  assert.equal(padClearanceRadiusMil([40, 40, 0]), 20);
  assert.equal(padClearanceRadiusMil([40, 40]), 20);
});

test('坏数据不抛异常、不瞎猜：回退默认半径（5 mil）', () => {
  assert.equal(padClearanceRadiusMil([]), DEFAULT_PAD_RADIUS_MIL);
  assert.equal(padClearanceRadiusMil(null), DEFAULT_PAD_RADIUS_MIL);
  assert.equal(padClearanceRadiusMil(undefined), DEFAULT_PAD_RADIUS_MIL);
  assert.equal(padClearanceRadiusMil(['x', null]), DEFAULT_PAD_RADIUS_MIL);
  assert.equal(padClearanceRadiusMil([Number.NaN, 12]), 6);
});

test('toString() 自包含：注入 EDA 上下文执行不依赖模块级常量（bridge 真机踩过 DEFAULT_PAD_RADIUS_MIL 未定义）', () => {
  const isolated = new Function(`${padClearanceRadiusMil.toString()}; return padClearanceRadiusMil([19.7, 21.3, 0]);`);
  assert.equal(isolated(), Math.min(19.7, 21.3) / 2);
  const fallback = new Function(`${padClearanceRadiusMil.toString()}; return padClearanceRadiusMil([]);`);
  assert.equal(fallback(), 5);
});
