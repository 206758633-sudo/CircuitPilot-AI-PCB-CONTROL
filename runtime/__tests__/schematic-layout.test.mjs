import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LABEL_ROTATION,
  SCHEMATIC_LAYOUT_CODES,
  auditSchematicReadability,
  compareRef,
  estimateLabelRect,
  estimateSymbolSize,
  layoutSchematicComponents,
  outwardDirection,
  overlapArea,
  planNetPortLabels,
} from '../schematic-layout.mjs';

const boxOf = (placement) => ({
  xMin: placement.x - placement.width / 2,
  yMin: placement.y - placement.height / 2,
  xMax: placement.x + placement.width / 2,
  yMax: placement.y + placement.height / 2,
});
const overlapOfPlacements = (a, b) => overlapArea(boxOf(a), boxOf(b));

test('符号尺寸估计：按类别/引脚数保守估计、对齐 10 格点、同输入同输出', () => {
  assert.deepEqual(estimateSymbolSize({ ref: 'R1', pinCount: 2 }), { width: 80, height: 50 });
  assert.deepEqual(estimateSymbolSize({ ref: 'U1', pinCount: 32 }), estimateSymbolSize({ ref: 'U1', pinCount: 32 }), '必须确定性');
  const smallIc = estimateSymbolSize({ ref: 'U1', pinCount: 4 });
  const bigIc = estimateSymbolSize({ ref: 'U1', pinCount: 32 });
  assert.ok(bigIc.height > smallIc.height, '32 脚 IC 必须比 4 脚高，不能"大小器件同格"');
  const connector = estimateSymbolSize({ ref: 'J1', pinCount: 16 });
  assert.ok(connector.width >= smallIc.width, '连接器比小 IC 宽');
  for (const size of [smallIc, bigIc, connector, estimateSymbolSize({ ref: 'X1', pinCount: 0 })]) {
    assert.equal(size.width % 10, 0, '尺寸必须对齐 10 格点');
    assert.equal(size.height % 10, 0, '尺寸必须对齐 10 格点');
    assert.ok(size.width > 0 && size.height > 0);
  }
});

test('元件落位：按连通簇分带、带内引脚数降序、格点对齐、任意两个包围盒不重叠，且完全确定', () => {
  const components = ['U1', 'R1', 'R2', 'C1', 'C2', 'D1', 'J1'].map((ref) => ({ ref, value: ref.startsWith('U') ? 'MCU' : 'x' }));
  const nets = [
    { name: 'VCC', endpoints: [{ ref: 'U1', pin: '1' }, { ref: 'R1', pin: '1' }] },
    { name: 'GND', endpoints: [{ ref: 'U1', pin: '2' }, { ref: 'C1', pin: '1' }, { ref: 'C2', pin: '1' }, { ref: 'D1', pin: '1' }] },
    { name: 'LED', endpoints: [{ ref: 'J1', pin: '1' }, { ref: 'R2', pin: '1' }] },
  ];
  const first = layoutSchematicComponents({ components, nets });
  const second = layoutSchematicComponents({ components, nets });
  assert.deepEqual(first, second, '布局必须确定性（同输入 → 同落位/同分块）');
  assert.equal(first.placements.length, components.length);
  assert.equal(first.blocks.length, 2, '两个连通簇 → 两条带/两个分块');

  // 连通关系：U1/R1/C1/C2/D1 同一块；J1/R2 同一块
  const blockOf = new Map();
  for (const block of first.blocks) for (const ref of block.refs) blockOf.set(ref, block.id);
  assert.equal(blockOf.get('U1'), blockOf.get('R1'));
  assert.equal(blockOf.get('U1'), blockOf.get('C1'));
  assert.notEqual(blockOf.get('U1'), blockOf.get('J1'));
  assert.equal(blockOf.get('J1'), blockOf.get('R2'));
  assert.equal(first.blocks[0].representativeNet, 'GND', '代表网络取成员最多的网络，平局取字典序');
  assert.deepEqual(first.blocks[0].refs, ['U1', 'C1', 'C2', 'D1', 'R1'], '带内按(引脚数降序, 位号自然序)排布');

  // 硬约束：任意两个元件包围盒不重叠（R2）
  for (let i = 0; i < first.placements.length; i += 1) {
    const placement = first.placements[i];
    assert.equal(placement.x % 10, 0, `${placement.ref} 的 x 必须对齐格点`);
    assert.equal(placement.y % 10, 0, `${placement.ref} 的 y 必须对齐格点`);
    assert.ok(placement.width % 10 === 0 && placement.height % 10 === 0);
    for (let j = i + 1; j < first.placements.length; j += 1) {
      assert.equal(overlapOfPlacements(placement, first.placements[j]), 0, `${placement.ref} 与 ${first.placements[j].ref} 的包围盒不得重叠`);
    }
  }

  // 未知位号只报 warning，不参与落位
  const withUnknown = layoutSchematicComponents({ components, nets: [...nets, { name: 'X', endpoints: [{ ref: 'U1', pin: '9' }, { ref: 'U99', pin: '1' }] }] });
  assert.equal(withUnknown.placements.length, components.length);
  assert.ok(withUnknown.findings.some((item) => item.code === SCHEMATIC_LAYOUT_CODES.NET_ENDPOINT_UNKNOWN && item.ref === 'U99'));
  assert.ok(withUnknown.findings.every((item) => item.severity !== 'blocking'), '布局 findings 只能是非阻断级');
});

test('标签朝向：左/右/上/下引脚分别朝外（180/0/90/270），不是一律朝右', () => {
  const components = [{ primitiveId: 'p-u1', designator: 'U1', x: 500, y: 500 }];
  const pinsByComponent = { 'p-u1': [
    { pinNumber: 'L', x: 400, y: 500 },
    { pinNumber: 'R', x: 600, y: 500 },
    { pinNumber: 'T', x: 500, y: 400 },
    { pinNumber: 'B', x: 500, y: 600 },
  ] };
  const pins = ['L', 'R', 'T', 'B'];
  const operations = pins.map((pinNumber) => ({ type: 'netPort.create', net: `N_${pinNumber}`, args: { portType: 'BI', net: `N_${pinNumber}`, x: null, y: null }, componentPrimitiveId: 'p-u1', pinNumber }));
  const planned = planNetPortLabels({ operations, components, pinsByComponent });
  assert.deepEqual(planned.labels.map((item) => [item.net, item.rotation]), [['N_L', 180], ['N_R', 0], ['N_T', 90], ['N_B', 270]]);
  assert.deepEqual(planned.operations.map((item) => item.args.rotation), [180, 0, 90, 270], 'rotation 必须写进操作 args，执行阶段才能用');
  assert.ok(planned.labels.every((item) => item.source === 'outward'), '没有碰撞时一律朝外');
  assert.deepEqual(planned.findings.filter((item) => item.severity === 'warning'), []);
  // 四个方向的标签框彼此不重叠（各自朝外）
  for (let i = 0; i < planned.labels.length; i += 1) {
    for (let j = i + 1; j < planned.labels.length; j += 1) {
      assert.equal(overlapArea(planned.labels[i].rect, planned.labels[j].rect), 0, `${planned.labels[i].net} 与 ${planned.labels[j].net} 不应互叠`);
    }
  }
  // 操作数量、顺序、其它字段一律保留（不改执行语义）
  assert.deepEqual(planned.operations.map((item) => item.pinNumber), pins);
  assert.equal(planned.operations[0].type, 'netPort.create');
  assert.deepEqual(planned.summary, {
    planned: 4, outward: 4, adjusted: 0, fallback: 0, remainingOverlap: 0, labelLabelOverlaps: 0, warnings: 0, warningCodes: [],
  }, '可读性摘要必须如实统计（供 dry-run/审批展示）');
  // 确定性
  assert.deepEqual(planNetPortLabels({ operations, components, pinsByComponent }), planned);
});

test('标签碰撞：同锚点第二个标签必须换方向（而不是叠字），且平局/调整都有确定性依据', () => {
  const components = [{ primitiveId: 'p-u1', designator: 'U1', x: 500, y: 500 }];
  const pinsByComponent = { 'p-u1': [{ pinNumber: 'P1', x: 400, y: 500 }] };
  const build = (net, anchor) => ({ type: 'netPort.create', net, args: { portType: 'BI', net, x: anchor.x, y: anchor.y }, componentPrimitiveId: 'p-u1', pinNumber: 'P1' });
  const planned = planNetPortLabels({
    operations: [build('GND', { x: 400, y: 500 }), build('3V3', { x: 400, y: 500 })],
    components,
    pinsByComponent,
  });
  const [first, second] = planned.labels;
  assert.equal(first.rotation, 180, '第一个标签朝外（左）');
  assert.notEqual(second.rotation, 180, '第二个标签不能也朝左，否则必然叠字');
  assert.equal(second.source, 'collision');
  assert.equal(overlapArea(first.rect, second.rect), 0, '换方向后两个标签不互叠');
  assert.equal(planned.findings.filter((item) => item.code === SCHEMATIC_LAYOUT_CODES.LABEL_LABEL_OVERLAP).length, 0);
  assert.ok(planned.findings.some((item) => item.code === SCHEMATIC_LAYOUT_CODES.LABEL_ROTATION_ADJUSTED && item.severity === 'info'));
  assert.equal(planned.summary.adjusted, 1, '摘要要数出"为避免碰撞而换向"的标签');
  assert.equal(planned.summary.outward + planned.summary.adjusted + planned.summary.fallback, planned.summary.planned);

  // 反过来验证："两个都朝右"确实会叠（说明上面的换向不是空谈）
  const naiveFirst = estimateLabelRect({ x: 400, y: 500, rotation: 0, net: 'GND' });
  const naiveSecond = estimateLabelRect({ x: 400, y: 500, rotation: 0, net: '3V3' });
  assert.ok(overlapArea(naiveFirst, naiveSecond) > 0);
});

test('标签碰撞：读不到锚点时保持原 rotation 并标 warning，绝不猜坐标', () => {
  const planned = planNetPortLabels({ operations: [{ type: 'netPort.create', net: 'SDA', args: { portType: 'BI', net: 'SDA', rotation: 0 } }] });
  assert.equal(planned.operations.length, 1);
  assert.equal(planned.operations[0].args.rotation, 0);
  assert.equal(planned.labels[0].x, null, '读不到锚点就不许编造坐标');
  assert.ok(planned.findings.some((item) => item.code === SCHEMATIC_LAYOUT_CODES.LABEL_ANCHOR_UNRESOLVED && item.severity === 'warning'));
  assert.ok(planned.findings.every((item) => item.severity !== 'blocking'), '可读性 findings 不能阻断写入');
});

test('朝外方向：按引脚相对主体中心的主轴计算（画布 y 向下）', () => {
  assert.equal(outwardDirection({ x: 90, y: 100 }, { x: 100, y: 100 }), 'left');
  assert.equal(outwardDirection({ x: 110, y: 100 }, { x: 100, y: 100 }), 'right');
  assert.equal(outwardDirection({ x: 100, y: 90 }, { x: 100, y: 100 }), 'up');
  assert.equal(outwardDirection({ x: 100, y: 110 }, { x: 100, y: 100 }), 'down');
  assert.equal(outwardDirection({ x: 100, y: 100 }, { x: 100, y: 100 }), 'right', '完全重合时按水平向右兜底');
  assert.equal(outwardDirection(null, { x: 0, y: 0 }), null);
  assert.equal(LABEL_ROTATION.RIGHT, 0);
  assert.equal(LABEL_ROTATION.UP, 90);
  assert.equal(LABEL_ROTATION.LEFT, 180);
  assert.equal(LABEL_ROTATION.DOWN, 270);
});

test('审计：能抓出标签压元件、标签互叠、元件包围盒重叠；干净布局 ok=true', () => {
  const crowded = auditSchematicReadability({
    components: [
      { ref: 'U1', x: 500, y: 500 },
      { ref: 'R1', x: 520, y: 510 },
      { ref: 'R2', x: 900, y: 500 },
    ],
    labels: [
      { net: 'GND', x: 500, y: 500, rotation: 0 },
      { net: '3V3', x: 520, y: 510, rotation: 0 },
    ],
  });
  assert.equal(crowded.ok, false);
  assert.ok(crowded.summary.componentOverlaps >= 1, 'U1 与 R1 包围盒重叠必须被抓到');
  assert.ok(crowded.summary.labelOnComponent >= 1, '标签压在元件上必须被抓到');
  assert.ok(crowded.summary.labelLabelOverlaps >= 1, '标签互叠必须被抓到');
  assert.ok(crowded.findings.every((item) => item.severity === 'warning'), '审计只出 warning，不阻断写盘');
  assert.ok(crowded.findings.some((item) => item.code === SCHEMATIC_LAYOUT_CODES.COMPONENT_OVERLAP));
  assert.ok(crowded.findings.some((item) => item.code === SCHEMATIC_LAYOUT_CODES.LABEL_ON_COMPONENT));
  assert.ok(crowded.findings.some((item) => item.code === SCHEMATIC_LAYOUT_CODES.LABEL_LABEL_OVERLAP));
  assert.ok(crowded.summary.overlapCount >= 3);

  const clean = auditSchematicReadability({
    components: [{ ref: 'U1', x: 120, y: 120 }, { ref: 'R1', x: 400, y: 120 }],
    labels: [{ net: 'GND', x: 400, y: 400, rotation: 0 }, { net: '3V3', x: 400, y: 600, rotation: 180 }],
  });
  assert.equal(clean.ok, true, JSON.stringify(clean.findings));
  assert.deepEqual(clean.findings, []);
  assert.equal(clean.summary.componentOverlaps, 0);
  assert.equal(clean.summary.labelOnComponent, 0);
  assert.equal(clean.summary.labelLabelOverlaps, 0);
  // 确定性：同输入同输出
  assert.deepEqual(auditSchematicReadability({ components: [{ ref: 'U1', x: 120, y: 120 }], labels: [] }), auditSchematicReadability({ components: [{ ref: 'U1', x: 120, y: 120 }], labels: [] }));
});

test('审计：布局产出的混合尺寸元件互不重叠 → layoutAudit.ok 为真（供 netlist 挂载）', () => {
  const components = ['U1', 'U2', 'R1', 'R2', 'R3', 'R4', 'J1'].map((ref) => ({ ref }));
  const nets = [
    { name: 'VCC', endpoints: [{ ref: 'U1', pin: '1' }, { ref: 'R1', pin: '1' }, { ref: 'R2', pin: '1' }] },
    { name: 'GND', endpoints: [{ ref: 'U2', pin: '2' }, { ref: 'R3', pin: '1' }, { ref: 'R4', pin: '1' }, { ref: 'J1', pin: '1' }] },
  ];
  const layout = layoutSchematicComponents({ components, nets });
  const audit = auditSchematicReadability({ components: layout.placements.map((item) => ({ ref: item.ref, x: item.x, y: item.y, width: item.width, height: item.height })) });
  assert.equal(audit.ok, true, JSON.stringify(audit.findings));
  assert.equal(audit.summary.componentOverlaps, 0);
  assert.equal(layout.blocks.length, 2);
});

test('位号自然序：U1 < U2 < U10（不能用字符串序把 U10 排到 U2 前面）', () => {
  const refs = ['U10', 'R2', 'U2', 'R10', 'J1', 'C1'];
  assert.deepEqual([...refs].sort(compareRef), ['C1', 'J1', 'R2', 'R10', 'U2', 'U10']);
});

test('既有 netport 标签是障碍：新标签不能叠在上一轮已画好的标签上', () => {
  const components = [{ primitiveId: 'p-u1', designator: 'U1', x: 500, y: 500 }];
  const pinsByComponent = { 'p-u1': [{ pinNumber: 'R', x: 600, y: 500 }] };
  const operation = { type: 'netPort.create', net: 'SDA', args: { portType: 'BI', net: 'SDA', x: 600, y: 500 }, componentPrimitiveId: 'p-u1', pinNumber: 'R' };
  // 没有既有标签：右侧朝外可用（rotation=0）。
  const clean = planNetPortLabels({ operations: [operation], components, pinsByComponent });
  assert.equal(clean.labels[0].rotation, LABEL_ROTATION.RIGHT);

  // 右侧已有一个同长度标签：新标签必须换向，否则必然叠字。
  const existing = [{ net: 'OLD_NET', x: 610, y: 500, rotation: LABEL_ROTATION.RIGHT }];
  const occupied = planNetPortLabels({ operations: [operation], components, pinsByComponent, existingLabels: existing });
  assert.notEqual(occupied.labels[0].rotation, LABEL_ROTATION.RIGHT, '右侧被既有标签占住时必须换向');
  assert.equal(occupied.labels[0].source, 'collision');
  // 换向后新标签与既有标签不重叠
  assert.equal(overlapArea(occupied.labels[0].rect, estimateLabelRect({ x: 610, y: 500, rotation: LABEL_ROTATION.RIGHT, net: 'OLD_NET' })), 0);
  // 纯函数仍然确定性
  assert.deepEqual(planNetPortLabels({ operations: [operation], components, pinsByComponent, existingLabels: existing }), occupied);
});

test('netport/netflag 图元只按“标签”占位，不重复算成元件主体（否则新标签被无谓挤走）', () => {
  const components = [
    { primitiveId: 'p-u1', designator: 'U1', componentType: 'part', x: 500, y: 500 },
    { primitiveId: 'p-port', designator: '', componentType: 'netport', x: 620, y: 500 },
  ];
  const pinsByComponent = { 'p-u1': [{ pinNumber: 'R', x: 600, y: 500 }] };
  const operation = { type: 'netPort.create', net: 'SDA', args: { portType: 'BI', net: 'SDA', x: 600, y: 500 }, componentPrimitiveId: 'p-u1', pinNumber: 'R' };
  const planned = planNetPortLabels({ operations: [operation], components, pinsByComponent });
  assert.equal(planned.labels[0].rotation, LABEL_ROTATION.RIGHT, 'netport 不是元件主体，右侧朝外仍可用');
  // 但真实既有标签（existingLabels）必须仍然有效：传进去后必须换向。
  const blocked = planNetPortLabels({ operations: [operation], components, pinsByComponent, existingLabels: [{ net: 'OLD', x: 620, y: 500, rotation: LABEL_ROTATION.RIGHT }] });
  assert.notEqual(blocked.labels[0].rotation, LABEL_ROTATION.RIGHT);
});
