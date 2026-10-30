import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRoutableLayers } from '../engineering/route-layers.mjs';

const layer = (id, name, layerStatus, type = 'SIGNAL') => ({ id, name, layerStatus, type });

test('4 层板：只选 layerStatus===1 的启用铜层，内层默认 15（不是 17/29）', () => {
  // 真机 `pcb.layers.read` 返回**全部理论层**（46 层每层都有 id/name/type），只有 layerStatus=1 才是本板启用层。
  const readback = [
    layer(1, 'TopLayer', 1), layer(2, 'BottomLayer', 1), layer(15, 'InnerLayer1', 1), layer(16, 'InnerLayer2', 1),
    ...Array.from({ length: 42 }, (_, index) => layer(17 + index, `InnerLayer${index + 3}`, 0)),
  ];
  const selected = selectRoutableLayers(readback);
  assert.deepEqual(selected.layers, [1, 2, 15, 16]);
  assert.equal(selected.innerLayer, 15);
});

test('2 层板：只有 [1,2] 可用，内层不瞎猜（innerLayer=null）', () => {
  const selected = selectRoutableLayers([layer(1, 'TopLayer', 1), layer(2, 'BottomLayer', 1), layer(15, 'InnerLayer1', 0)]);
  assert.deepEqual(selected.layers, [1, 2]);
  assert.equal(selected.innerLayer, null);
});

test('读回不可用/不足两层 → 返回 null，让调用方保留默认并由独立复核拦截', () => {
  assert.equal(selectRoutableLayers(null), null);
  assert.equal(selectRoutableLayers(undefined), null);
  assert.equal(selectRoutableLayers([]), null);
  assert.equal(selectRoutableLayers([layer(1, 'TopLayer', 1)]), null);
});

test('兼容 {layers:[...]} 包装与字符串 id：孔化读回格式漂移不应导致层选择失效', () => {
  const selected = selectRoutableLayers({ layers: [{ id: '1', layerStatus: 1, name: 'TopLayer' }, { id: '2', layerStatus: 1, name: 'BottomLayer' }] });
  assert.deepEqual(selected.layers, [1, 2]);
});

test('按名称兜底：无 type 但名称是铜层语义时仍可识别（不同 EDA 版本字段差异）', () => {
  const selected = selectRoutableLayers([
    { id: 1, layerStatus: 1, name: '顶层' },
    { id: 2, layerStatus: 1, name: '底层' },
    { id: 15, layerStatus: 1, name: '内层1' },
  ]);
  assert.deepEqual(selected.layers, [1, 2, 15]);
  assert.equal(selected.innerLayer, 15);
});
