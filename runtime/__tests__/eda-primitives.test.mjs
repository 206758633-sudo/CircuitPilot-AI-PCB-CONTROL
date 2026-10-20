import assert from 'node:assert/strict';
import test from 'node:test';
import { LAYER_IDS } from '../engineering/layers.mjs';
import {
  BOARD_OUTLINE_HELP,
  EDA_PRIMITIVE_FACTS,
  OUTLINE_LINE_WIDTH_MIL,
  assertClosedOutlineSource,
  assertPolygonSource,
  assertPrimitiveLayerSupports,
  circlePolygonSource,
  classifyPolygonSource,
  layerTypeOf,
  milToMm,
  mmToMil,
  pathPolygonSource,
  rectPolygonSource,
} from '../engineering/eda-primitives.mjs';

test('mm/mil 换算与真机导出的 GKO 坐标一致（60mm 板框 = 2362.2047mil）', () => {
  assert.equal(mmToMil(60), 2362.2047244094486);
  // 浮点比较用容差：mil->mm 反解不会正好落回整数微米。
  assert.ok(Math.abs(milToMm(2362.2047) - 59.99999938) < 1e-6);
  // 板框默认线宽 10mil = 0.254mm
  assert.equal(OUTLINE_LINE_WIDTH_MIL, 10);
  assert.equal(Number(milToMm(10).toFixed(4)), 0.254);
});

test('矩形板框源码必须是实测可用的「坐标开头 + "L"」编码，且闭合', () => {
  // 复刻真机成功创建的那一段（板框落在 y 负半轴，因为器件在负 y 侧）：
  //   [0,0,"L",2362.2047,0,2362.2047,-1574.8031,0,-1574.8031,0,0]  = 60x40mm
  const source = rectPolygonSource({ widthMm: 60, heightMm: -40, originXMm: 0, originYMm: 0 });
  assert.deepEqual(source, [0, 0, 'L', 2362.2047, 0, 2362.2047, -1574.8031, 0, -1574.8031, 0, 0]);
  assert.equal(classifyPolygonSource(source).form, 'path');
  assert.doesNotThrow(() => assertClosedOutlineSource(source));
  // 正尺寸 + 有符号原点同样可行（生产计划用的就是这个形状：原点决定板子在坐标系里的位置）。
  const shifted = rectPolygonSource({ widthMm: 60, heightMm: 40, originXMm: 10, originYMm: -40 });
  assert.deepEqual(shifted, [393.7008, -1574.8031, 'L', 2755.9055, -1574.8031, 2755.9055, 0, 393.7008, 0, 393.7008, -1574.8031]);
  assert.doesNotThrow(() => assertClosedOutlineSource(shifted));
});

test('token 开头的多边形只接受 R(6个数) 与 CIRCLE(3个数)，坐标开头必须给段类型', () => {
  assert.equal(classifyPolygonSource(['R', 0, 0, 10, 10, 0, 0]).valid, true);
  // 真机实测：["R",x1,y1,x2,y2] 会被 createPolygon 拒绝（返回 undefined）。
  assert.equal(classifyPolygonSource(['R', 0, 0, 10, 10]).valid, false);
  assert.equal(classifyPolygonSource(['CIRCLE', 0, 0, 5]).valid, true);
  assert.equal(classifyPolygonSource(['CIRCLE', 0, 0]).valid, false);
  // 坐标开头但索引 2 不是段类型：无效。
  assert.equal(classifyPolygonSource([0, 0, 1, 1]).valid, false);
  // 点数不成对：无效。
  assert.equal(classifyPolygonSource([0, 0, 'L', 1, 1, 2]).valid, false);
  assert.throws(() => assertPolygonSource(['R', 0, 0, 10, 10]), { code: 'EDA_POLYGON_INVALID' });
});

test('未闭合的板框被拒：EDA 不会把开口轮廓当板框', () => {
  const open = pathPolygonSource([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.throws(() => assertClosedOutlineSource(open), { code: 'EDA_OUTLINE_NOT_CLOSED' });
  const closed = pathPolygonSource([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  assert.doesNotThrow(() => assertClosedOutlineSource(closed));
  assert.deepEqual(circlePolygonSource({ centerXMm: 0, centerYMm: 0, radiusMm: 5, unit: 'mil' }), ['CIRCLE', 0, 0, 5]);
});

test('层支持守卫：Line/Arc 只能落 SIGNAL 铜层，板框层必须换 Polyline 通道', () => {
  // 铜层放行
  assert.equal(assertPrimitiveLayerSupports('line', LAYER_IDS.TOP).layerType, 'SIGNAL');
  assert.equal(assertPrimitiveLayerSupports('line', LAYER_IDS.INNER_1).layerType, 'SIGNAL');
  assert.equal(assertPrimitiveLayerSupports('arc', 44).layerType, 'SIGNAL');
  // 非铜层拒绝，并且错误里要给出可执行的替代方案（不能只说“参数不正确”）
  for (const layer of [LAYER_IDS.TOP_SILKSCREEN, LAYER_IDS.BOTTOM_SILKSCREEN, LAYER_IDS.TOP_SOLDER_MASK, LAYER_IDS.BOARD_OUTLINE, LAYER_IDS.MECHANICAL]) {
    assert.throws(() => assertPrimitiveLayerSupports('line', layer), (error) => error.code === 'EDA_LAYER_NOT_SUPPORTED' && error.layerId === layer && /PCB_PrimitivePolyline/.test(error.message),
      `layer=${layer} 必须被 Line 拒绝`);
  }
  // Polyline 可以落在板框层、丝印层、铜层
  for (const layer of [LAYER_IDS.TOP, LAYER_IDS.TOP_SILKSCREEN, LAYER_IDS.BOARD_OUTLINE, LAYER_IDS.MECHANICAL]) {
    assert.doesNotThrow(() => assertPrimitiveLayerSupports('polyline', layer));
  }
  // Region/Fill 不支持板框层
  assert.throws(() => assertPrimitiveLayerSupports('region', LAYER_IDS.BOARD_OUTLINE), { code: 'EDA_LAYER_NOT_SUPPORTED' });
  assert.throws(() => assertPrimitiveLayerSupports('fill', LAYER_IDS.BOARD_OUTLINE), { code: 'EDA_LAYER_NOT_SUPPORTED' });
  assert.throws(() => assertPrimitiveLayerSupports('unknown-primitive', 1), { code: 'EDA_PRIMITIVE_UNKNOWN' });
});

test('层类型表与说明文本固化真机事实（防止后人再把板框写回 Line）', () => {
  assert.equal(layerTypeOf(LAYER_IDS.BOARD_OUTLINE), 'OUTLINE');
  assert.equal(layerTypeOf(LAYER_IDS.TOP), 'SIGNAL');
  assert.equal(layerTypeOf(LAYER_IDS.INNER_1), 'SIGNAL');
  assert.match(BOARD_OUTLINE_HELP, /PCB_PrimitivePolyline\.create/);
  assert.equal(EDA_PRIMITIVE_FACTS.boardOutlineApi, 'PCB_PrimitivePolyline.create + PCB_MathPolygon.createPolygon');
  assert.match(EDA_PRIMITIVE_FACTS.misleadingErrorText, /参数不正确/);
});
