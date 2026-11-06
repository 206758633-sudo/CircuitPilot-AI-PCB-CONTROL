import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOARD_MODEL_CODES,
  BOARD_MODEL_SCHEMA_VERSION,
  boardModelDigest,
  boardModelFromDesignSpec,
  boardModelFromPcbPlan,
  createBoardModel,
  outlineClosed,
  summarizeBoardModel,
  toPcbOperations,
  validateBoardModel,
} from '../design-framework/board-model.mjs';

/** 一块最小可用板：60×40、2 层、两个器件、一条网络。 */
const baseInput = () => ({
  board: { widthMm: 60, heightMm: 40, layers: 2, thicknessMm: 1.6, copperOz: 1 },
  components: [
    { ref: 'U1', mpn: 'ESP32-C3', footprint: 'QFN-32', xMm: 20, yMm: 20, widthMm: 5, heightMm: 5, rotationDeg: 0 },
    { ref: 'C1', mpn: '100nF', footprint: '0603', xMm: 28, yMm: 20, widthMm: 1.6, heightMm: 0.8 },
  ],
  nets: [{ name: '3V3', pins: ['U1.1', 'C1.1'], kind: 'power', currentA: 0.3 }],
  rules: { fabProfile: 'JLCPCB:2L-1oz', minClearanceMm: 0.2 },
});

test('createBoardModel：归一化、默认值、schemaVersion 与 digest 可复现', () => {
  const model = createBoardModel(baseInput());
  assert.equal(model.schemaVersion, BOARD_MODEL_SCHEMA_VERSION);
  assert.equal(model.board.layers, 2);
  assert.equal(model.components.length, 2);
  assert.equal(model.components[0].ref, 'U1');
  assert.equal(model.components[0].side, 'top');
  assert.equal(model.components[0].fixed, false);
  assert.deepEqual(model.nets[0].pins, [{ ref: 'U1', pin: '1' }, { ref: 'C1', pin: '1' }]);
  assert.equal(model.nets[0].kind, 'power');

  const again = createBoardModel(baseInput());
  assert.equal(boardModelDigest(model), boardModelDigest(again), '同输入必须得到同 digest');

  // 字段插入顺序不影响 digest
  const reordered = { rules: baseInput().rules, nets: baseInput().nets, components: baseInput().components, board: baseInput().board };
  assert.equal(boardModelDigest(createBoardModel(reordered)), boardModelDigest(model));
});

test('createBoardModel：板框校验 fail-closed（缺尺寸/非法层数）', () => {
  assert.throws(() => createBoardModel({ board: {} }), (error) => error.code === BOARD_MODEL_CODES.BOARD_INVALID);
  assert.throws(() => createBoardModel({ board: { widthMm: 60, heightMm: 40, layers: 0 } }), (error) => error.code === BOARD_MODEL_CODES.BOARD_INVALID);
  assert.throws(() => createBoardModel({ board: { widthMm: 60, heightMm: 40, layers: 33 } }), (error) => error.code === BOARD_MODEL_CODES.BOARD_INVALID);
});

test('createBoardModel：器件位号重复 / 未知尺寸 / 网络引用未知器件都 fail-closed', () => {
  assert.throws(
    () => createBoardModel({ board: { widthMm: 60, heightMm: 40 }, components: [{ ref: 'U1', xMm: 1, yMm: 1, widthMm: 2, heightMm: 2 }, { ref: 'u1', xMm: 3, yMm: 3, widthMm: 2, heightMm: 2 }] }),
    (error) => error.code === BOARD_MODEL_CODES.DUPLICATE_REF,
  );
  assert.throws(
    () => createBoardModel({ board: { widthMm: 60, heightMm: 40 }, components: [{ ref: 'U1', xMm: 1, yMm: 1 }] }),
    (error) => error.code === BOARD_MODEL_CODES.COMPONENT_INVALID,
  );
  // 显式 sizeUnknown 允许未知尺寸（规则层会判 REVIEW，而不是猜）
  const unknown = createBoardModel({ board: { widthMm: 60, heightMm: 40 }, components: [{ ref: 'U1', xMm: 1, yMm: 1, sizeUnknown: true }] });
  assert.equal(unknown.components[0].sizeUnknown, true);
  assert.equal(unknown.components[0].widthMm, null);
  assert.throws(
    () => createBoardModel({ board: { widthMm: 60, heightMm: 40 }, components: [{ ref: 'U1', xMm: 1, yMm: 1, widthMm: 2, heightMm: 2 }], nets: [{ name: 'N1', pins: ['U1.1', 'R99.1'] }] }),
    (error) => error.code === BOARD_MODEL_CODES.NET_INVALID,
  );
});

test('createBoardModel：叠层层数与板层数不一致 / keepout 非法 fail-closed', () => {
  assert.throws(
    () => createBoardModel({ board: { widthMm: 60, heightMm: 40, layers: 4 }, stackup: { layers: [{ name: 'L1' }, { name: 'L2' }] } }),
    (error) => error.code === BOARD_MODEL_CODES.STACKUP_INVALID,
  );
  assert.throws(
    () => createBoardModel({ board: { widthMm: 60, heightMm: 40, keepouts: [{ x0: 5, y0: 5, x1: 1, y1: 1 }] } }),
    (error) => error.code === BOARD_MODEL_CODES.KEEPOUT_INVALID,
  );
  const ok = createBoardModel({ board: { widthMm: 60, heightMm: 40, layers: 4 }, stackup: { layers: [{ name: 'L1', type: 'signal' }, { name: 'L2', type: 'plane' }, { name: 'L3', type: 'plane' }, { name: 'L4', type: 'signal' }], totalThicknessMm: 1.6 } });
  assert.equal(ok.stackup.layers.length, 4);
});

test('validateBoardModel 不抛异常；summarizeBoardModel 给出摘要', () => {
  const bad = validateBoardModel({ board: {} });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues[0].code);
  const model = createBoardModel(baseInput());
  const good = validateBoardModel(model);
  assert.equal(good.ok, true);
  const summary = summarizeBoardModel(model);
  assert.equal(summary.componentCount, 2);
  assert.equal(summary.netCount, 1);
  assert.equal(summary.digest.length, 64);
});

test('outlineClosed：开点集返回 false，首尾闭合返回 true', () => {
  const open = createBoardModel({ board: { widthMm: 10, heightMm: 10, outline: [[0, 0], [10, 0], [10, 10], [0, 10]] } });
  assert.equal(outlineClosed(open), false);
  const closed = createBoardModel({ board: { widthMm: 10, heightMm: 10, outline: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]] } });
  assert.equal(outlineClosed(closed), true);
});

test('boardModelFromDesignSpec：从 boards[0] + netIntent 构建，未知尺寸显式标记', () => {
  const spec = {
    title: '测试板',
    boards: [{ id: 'B1', name: 'Main', layers: 2, outline: { points: [[0, 0], [60, 0], [60, 40], [0, 40]], widthMm: 60, heightMm: 40 } }],
    netIntent: [{ net: '3V3', endpoints: ['U1.1', 'C1.1'] }, { net: 'GND', endpoints: ['U1.2', 'C1.2'] }],
  };
  const model = boardModelFromDesignSpec(spec);
  assert.equal(model.board.widthMm, 60);
  assert.equal(model.board.layers, 2);
  assert.deepEqual(model.components.map((component) => component.ref).sort(), ['C1', 'U1']);
  assert.ok(model.components.every((component) => component.sizeUnknown === true));
  assert.equal(model.nets.length, 2);
  assert.equal(model.meta.source, 'design-spec');
  assert.equal(boardModelDigest(model), boardModelDigest(boardModelFromDesignSpec(spec)));
});

test('boardModelFromPcbPlan：board/stackup 映射，placements 补齐几何', () => {
  const plan = {
    title: 'PCB plan',
    board: { widthMm: 70, heightMm: 48, layers: 4, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 },
    stackup: { layers: [{ name: 'L1', type: 'signal' }, { name: 'L2', type: 'plane' }, { name: 'L3', type: 'plane' }, { name: 'L4', type: 'signal' }] },
    constraints: { fabProfile: 'JLCPCB:4L-1oz', minClearanceMm: 0.15 },
  };
  const model = boardModelFromPcbPlan(plan, { placements: [{ ref: 'U1', xMm: 20, yMm: 20, widthMm: 5, heightMm: 5 }] });
  assert.equal(model.board.widthMm, 70);
  assert.equal(model.board.layers, 4);
  assert.equal(model.stackup.layers.length, 4);
  assert.equal(model.components[0].ref, 'U1');
  assert.equal(model.rules.fabProfile, 'JLCPCB:4L-1oz');
});

test('toPcbOperations：有 placementId 才生成 modify，否则如实 skipped', () => {
  const model = createBoardModel({
    board: { widthMm: 60, heightMm: 40 },
    components: [
      { ref: 'U1', xMm: 20, yMm: 20, widthMm: 5, heightMm: 5, placementId: 'prim-1', fixed: true },
      { ref: 'C1', xMm: 28, yMm: 20, widthMm: 1.6, heightMm: 0.8 },
    ],
  });
  const { operations, skipped } = toPcbOperations(model);
  assert.equal(operations[0].type, 'pcb.outline.create');
  const modifies = operations.filter((operation) => operation.type === 'pcb.component.modify');
  assert.equal(modifies.length, 1);
  assert.equal(modifies[0].args.primitiveId, 'prim-1');
  assert.equal(modifies[0].args.property.primitiveLock, true);
  assert.deepEqual(skipped.map((item) => item.ref), ['C1']);
});
