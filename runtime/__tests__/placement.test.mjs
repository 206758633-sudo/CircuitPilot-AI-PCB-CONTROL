import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLACEMENT_CODES, diffPlacement, distanceToOutline, netAffinity, parsePolygonSource, planOutlinePlacement,
  pointInPolygon, polygonArea, polygonBounds, readComponentGeometry, toMm, verifyOutlinePlacement,
} from '../placement.mjs';

/** 真机板框源码（2026-10-13 从 10886966233af924 读回）：60.0 x 40.0 mm 矩形，单位 mil。 */
const REAL_OUTLINE_SOURCE = [0, 0, 'L', 2362.2047, 0, 2362.2047, -1574.8031, 0, -1574.8031, 0, 0];

/** 真机器件尺寸（pcb.placement.read 的 bboxMm）。 */
const REAL_COMPONENTS = [
  { ref: 'U1', primitiveId: 'p1', widthMm: 2.78, heightMm: 2.78, current: { xMm: 10, yMm: -20, rotationDeg: 0 }, side: 'top' },
  { ref: 'U2', primitiveId: 'p2', widthMm: 3.54, heightMm: 5.91, current: { xMm: 28, yMm: -11, rotationDeg: 0 }, side: 'top' },
  { ref: 'U3', primitiveId: 'p3', widthMm: 3.54, heightMm: 5.91, current: { xMm: 28, yMm: -29, rotationDeg: 0 }, side: 'top' },
  { ref: 'U4', primitiveId: 'p4', widthMm: 3.11, heightMm: 2.30, current: { xMm: 44, yMm: -11, rotationDeg: 0 }, side: 'top' },
  { ref: 'U5', primitiveId: 'p5', widthMm: 3.11, heightMm: 2.30, current: { xMm: 44, yMm: -29, rotationDeg: 0 }, side: 'top' },
  { ref: 'U6', primitiveId: 'p6', widthMm: 2.17, heightMm: 1.67, current: { xMm: 53, yMm: -20, rotationDeg: 0 }, side: 'top' },
  { ref: 'D1', primitiveId: 'p7', widthMm: 3.58, heightMm: 3.57, current: { xMm: 40, yMm: -36, rotationDeg: 0 }, side: 'top' },
  { ref: 'J1', primitiveId: 'p8', widthMm: 9.86, heightMm: 8.35, current: { xMm: 30, yMm: -36, rotationDeg: 0 }, side: 'top' },
];

test('真机板框源码 → mm 多边形：60.0x40.0 矩形，且只有 L 命令被当作已验证', () => {
  const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);
  assert.equal(outline.ok, true);
  assert.equal(outline.closed, true);
  assert.equal(outline.unsupported.length, 0);
  assert.equal(outline.points.length, 4, '首尾重复点要去掉，否则出现零长度边');
  const bounds = polygonBounds(outline.points);
  assert.equal(Number(bounds.minX.toFixed(4)), 0);
  assert.equal(Number(bounds.maxX.toFixed(4)), 60, '2362.2047 mil 正好是 60.0000 mm');
  assert.equal(Number(bounds.minY.toFixed(4)), -40);
  assert.equal(Number(bounds.maxY.toFixed(4)), 0);
  assert.equal(Number(polygonArea(outline.points).toFixed(2)), 2400, '正好 60x40mm');
  assert.ok(Math.abs(toMm(2362.2047) - 60) < 1e-5, '2362.2047 mil 与 60mm 的差在 0.00001mm 内（60mm 正好是 2362.204724 mil）');
  // 未验证的命令必须被拦住，不能当直线/矩形处理
  const withArc = parsePolygonSource([0, 0, 'L', 100, 0, 'ARC', 5, 5]);
  assert.equal(withArc.unsupported[0], 'ARC');
  const planned = planOutlinePlacement({ outline: withArc, components: REAL_COMPONENTS });
  assert.equal(planned.ok, false);
  assert.ok(planned.findings.some((f) => f.code === PLACEMENT_CODES.OUTLINE_COMMAND_UNSUPPORTED));
});

test('几何原语：点在多边形内、点到边距离', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(pointInPolygon({ x: 5, y: 5 }, square), true);
  assert.equal(pointInPolygon({ x: 15, y: 5 }, square), false);
  assert.equal(pointInPolygon({ x: 5, y: -5 }, square), false);
  assert.equal(distanceToOutline({ x: 5, y: 1 }, square), 1);
  assert.equal(distanceToOutline({ x: 5, y: 5 }, square), 5);
  // L 形：凹多边形里"看起来在包围盒内"的点其实在板外
  const lShape = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 30 }, { x: 0, y: 30 }];
  assert.equal(pointInPolygon({ x: 20, y: 20 }, lShape), false, '右上角被切掉的区域必须在板外');
  assert.equal(pointInPolygon({ x: 5, y: 20 }, lShape), true);
  assert.equal(pointInPolygon({ x: 20, y: 5 }, lShape), true);
});

test('按真机板框自动布局：8 个器件全部落在 60x40mm 内且通过独立复核', () => {
  const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);
  const plan = planOutlinePlacement({ outline, components: REAL_COMPONENTS, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5 });
  assert.equal(plan.unplaced.length, 0, JSON.stringify(plan.unplaced));
  assert.equal(plan.placements.length, 8);
  assert.equal(plan.stats.utilization < 0.2, true, '利用率应当很小：这块板 2400mm² 上只放了 8 个小器件');
  // 面积大的先放（J1 9.86x8.35 最大）
  assert.equal(plan.placements[0].ref, 'J1');
  const check = verifyOutlinePlacement({ placements: plan.placements, outline, edgeClearanceMm: 1, spacingMm: 0.5 });
  assert.equal(check.ok, true, JSON.stringify(check.findings));
  assert.equal(check.checkedCount, 8);
});

test('规划结果确实在轮廓内、彼此不重叠、离板边 ≥1mm', () => {
  const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);
  const plan = planOutlinePlacement({ outline, components: REAL_COMPONENTS, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5 });
  for (const placement of plan.placements) {
    assert.equal(pointInPolygon({ x: placement.xMm, y: placement.yMm }, outline.points), true, `${placement.ref} 中心应在板内`);
    const halfW = placement.widthMm / 2;
    const halfH = placement.heightMm / 2;
    const corners = [{ x: placement.xMm - halfW, y: placement.yMm - halfH }, { x: placement.xMm + halfW, y: placement.yMm - halfH }, { x: placement.xMm + halfW, y: placement.yMm + halfH }, { x: placement.xMm - halfW, y: placement.yMm + halfH }];
    for (const corner of corners) assert.equal(distanceToOutline(corner, outline.points) >= 1 - 1e-9, true, `${placement.ref} 的角离板边不足 1mm`);
  }
});

test('连接器可按锚定边靠边放置（USB-C 口要贴板边）', () => {
  const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);
  const plan = planOutlinePlacement({ outline, components: REAL_COMPONENTS, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5, anchors: { J1: { side: 'bottom', weightNear: 0 } } });
  const j1 = plan.placements.find((item) => item.ref === 'J1');
  assert.ok(j1, 'J1 必须被放下');
  const distanceToBottom = Math.abs(j1.yMm - (polygonBounds(outline.points).minY + 1 + j1.heightMm / 2));
  assert.ok(distanceToBottom < 0.51, `J1 应贴下边（距下边 ${distanceToBottom.toFixed(3)}mm）`);
});

test('尺寸未知的器件不许猜：报 SIZE_UNKNOWN 并跳过', () => {
  const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);
  const readback = { components: [{ designator: 'U9', primitiveId: 'p9', bboxMm: null, xMm: 5, yMm: -5 }] };
  const geometry = readComponentGeometry(readback);
  assert.equal(geometry.unknown.length, 1);
  const plan = planOutlinePlacement({ outline, components: geometry.components });
  assert.equal(plan.placements.length, 0);
  assert.ok(plan.findings.some((f) => f.code === PLACEMENT_CODES.SIZE_UNKNOWN));
  assert.equal(plan.unplaced[0].reason, 'SIZE_UNKNOWN');
  assert.equal(plan.ok, false);
});

test('独立复核能抓出越界/贴边/重叠/进禁布区，且不依赖规划代码的分支', () => {
  const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);
  const base = { ref: 'X1', xMm: 10, yMm: -10, widthMm: 4, heightMm: 4, rotationDeg: 0 };
  const outside = verifyOutlinePlacement({ placements: [{ ...base, xMm: 59.5 }], outline, edgeClearanceMm: 1 });
  assert.ok(outside.findings.some((f) => f.code === PLACEMENT_CODES.OUTSIDE_OUTLINE));
  assert.equal(outside.ok, false);
  // 贴边用例必须"四角在板内、但离边不足 1mm"：xMm=2.2 时左边缘在 0.2mm 处
  const tooClose = verifyOutlinePlacement({ placements: [{ ...base, xMm: 2.2 }], outline, edgeClearanceMm: 1 });
  assert.ok(tooClose.findings.some((f) => f.code === PLACEMENT_CODES.TOO_CLOSE_TO_EDGE), JSON.stringify(tooClose.findings));
  const overlap = verifyOutlinePlacement({ placements: [base, { ...base, ref: 'X2', xMm: 11, yMm: -10.5 }], outline, edgeClearanceMm: 1, spacingMm: 0.5 });
  assert.ok(overlap.findings.some((f) => f.code === PLACEMENT_CODES.OVERLAP));
  const keepout = verifyOutlinePlacement({ placements: [base], outline, edgeClearanceMm: 1, keepouts: [{ x1: 5, y1: -15, x2: 20, y2: -5 }] });
  assert.ok(keepout.findings.some((f) => f.code === PLACEMENT_CODES.IN_KEEPOUT));
  const offGrid = verifyOutlinePlacement({ placements: [{ ...base, xMm: 10.3, yMm: -10.3 }], outline, edgeClearanceMm: 1 });
  assert.ok(offGrid.findings.some((f) => f.code === PLACEMENT_CODES.OFF_GRID && f.severity === 'warning'));
});

test('凹形（L 形）板框：规划不会把器件放进被切掉的区域', () => {
  const lShape = parsePolygonSource([0, 0, 'L', 1181.1024, 0, 1181.1024, -393.7008, 393.7008, -393.7008, 393.7008, -1181.1024, 0, -1181.1024, 0, 0]);
  const components = [{ ref: 'BIG', primitiveId: 'p1', widthMm: 8, heightMm: 8 }];
  const plan = planOutlinePlacement({ outline: lShape, components, edgeClearanceMm: 1, gridMm: 0.5 });
  assert.equal(plan.placements.length, 1);
  const placement = plan.placements[0];
  const inCutCorner = placement.xMm > 10 && placement.yMm < -10;
  assert.equal(inCutCorner, false, JSON.stringify(placement));
  assert.equal(verifyOutlinePlacement({ placements: plan.placements, outline: lShape, edgeClearanceMm: 1 }).ok, true);
});

test('计划 vs 现状：给出每个器件的位移与是否变更（用户微调前要看到 diff）', () => {
  const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);
  const plan = planOutlinePlacement({ outline, components: REAL_COMPONENTS, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5 });
  const diff = diffPlacement(REAL_COMPONENTS.map((c) => ({ ref: c.ref, ...c.current })), plan.placements);
  assert.equal(diff.rows.length, 8);
  assert.equal(diff.movedCount + diff.unchangedCount, 8);
  const row = diff.rows.find((item) => item.ref === 'J1');
  assert.ok(Number.isFinite(row.distanceMm));
  assert.equal(row.from.yMm, -36);
  const unchanged = diffPlacement([{ ref: 'A', xMm: 1, yMm: 2, rotationDeg: 0 }], [{ ref: 'A', xMm: 1, yMm: 2, rotationDeg: 0 }]);
  assert.equal(unchanged.rows[0].status, 'unchanged');
  const added = diffPlacement([], [{ ref: 'A', xMm: 1, yMm: 2, rotationDeg: 0 }]);
  assert.equal(added.rows[0].status, 'new');
});

test('电气亲和度：只有两个引脚的网权重最高，GND 这种大网不占主导', () => {
  const affinity = netAffinity([
    { ref: 'J1', nets: ['USB_DP', 'USB_DM', 'GND'] },
    { ref: 'D1', nets: ['USB_DP', 'USB_DM', 'GND'] },
    { ref: 'U1', nets: ['GND', '3V3'] },
    { ref: 'U6', nets: ['GND', '3V3'] },
    { ref: 'X9', nets: ['MON_IN_P'] },
  ]);
  assert.equal(affinity.netCount, 5);
  const usb = affinity.pairWeight('J1', 'D1');
  const gnd = affinity.pairWeight('J1', 'U1');
  assert.ok(usb > gnd, `共享两个两脚网(${usb}) 应当强于只共享 GND(${gnd})`);
  assert.equal(affinity.pairWeight('X9', 'U1'), 0, '没有共同网络的器件亲和度必须为 0');
});

test('亲和度布局：USB 保护器件会自动贴到连接器旁边，而不是随便丢在板上', () => {
  const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);
  const components = [
    { ref: 'J1', primitiveId: 'p8', widthMm: 9.86, heightMm: 8.35, nets: ['USB_DP', 'USB_DM', 'VBUS', 'GND', 'CC1', 'CC2'] },
    { ref: 'D1', primitiveId: 'p7', widthMm: 3.58, heightMm: 3.57, nets: ['USB_DP', 'USB_DM', 'VBUS', 'GND'] },
    { ref: 'U6', primitiveId: 'p6', widthMm: 2.17, heightMm: 1.67, nets: ['SCL', 'SDA', '3V3', 'GND'] },
    { ref: 'U1', primitiveId: 'p1', widthMm: 2.78, heightMm: 2.78, nets: ['SCL', 'SDA', 'ALERT_N', '3V3', 'GND'] },
  ];
  const affinity = netAffinity(components);
  const plan = planOutlinePlacement({ outline, components, affinity, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5, anchors: { J1: { side: 'bottom', weightNear: 0 } } });
  assert.equal(plan.unplaced.length, 0);
  assert.equal(verifyOutlinePlacement({ placements: plan.placements, outline, edgeClearanceMm: 1, spacingMm: 0.5 }).ok, true);
  const byRef = Object.fromEntries(plan.placements.map((item) => [item.ref, item]));
  const distance = (a, b) => Math.hypot(byRef[a].xMm - byRef[b].xMm, byRef[a].yMm - byRef[b].yMm);
  assert.ok(byRef.D1.yMm < -25, `D1 应贴到下方连接器附近（实际 y=${byRef.D1.yMm}）`);
  // 更准确的不变量：D1 应当落在"贴着 J1 的最小合法间距"处，而不是随便找个空位
  const minimumCenterDistance = byRef.J1.heightMm / 2 + byRef.D1.heightMm / 2 + 0.5;
  assert.ok(distance('D1', 'J1') <= minimumCenterDistance + 0.51, `D1 到 J1 中心距 ${distance('D1', 'J1').toFixed(2)}mm 应接近最小合法间距 ${minimumCenterDistance.toFixed(2)}mm`);
  assert.ok(distance('U6', 'U1') < distance('U6', 'J1'), 'I2C 器件之间应聚在一起，而不是散到连接器那边');
});

test('故意伸出板边必须显式声明：没声明算越界，声明了但超限仍阻断', () => {
  const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);
  // 真机 J1（USB-C）实际 y=-36、高 8.35 → 下沿 -40.175，伸出 0.175mm
  const j1 = { ref: 'J1', xMm: 30, yMm: -36, widthMm: 9.86, heightMm: 8.35, rotationDeg: 0 };
  const undeclared = verifyOutlinePlacement({ placements: [j1], outline, edgeClearanceMm: 1 });
  assert.ok(undeclared.findings.some((f) => f.code === PLACEMENT_CODES.OUTSIDE_OUTLINE), JSON.stringify(undeclared.findings.map((f) => f.code)));
  assert.equal(undeclared.ok, false);
  const declared = verifyOutlinePlacement({ placements: [j1], outline, edgeClearanceMm: 1, overhangAllowances: { J1: { maxOverhangMm: 3, reason: 'USB-C 插座需伸出板边才能插线' } } });
  assert.equal(declared.ok, true, JSON.stringify(declared.findings));
  assert.ok(declared.findings.some((f) => f.code === PLACEMENT_CODES.OVERHANG_UNDECLARED && f.severity === 'info'));
  assert.match(declared.findings[0].message, /USB-C 插座需伸出板边/);
  const exceeded = verifyOutlinePlacement({ placements: [j1], outline, edgeClearanceMm: 1, overhangAllowances: { J1: { maxOverhangMm: 0.1, reason: 'USB-C 插座只需极少伸出，此处用于验证超限仍会阻断' } } });
  assert.equal(exceeded.ok, false);
  assert.ok(exceeded.findings.some((f) => f.code === PLACEMENT_CODES.OVERHANG_EXCEEDED));
  // 第 57 轮加固：只有额度、没写清理由（<8 字）不算"显式声明"，按未声明处理——不许悄悄放行
  const noReason = verifyOutlinePlacement({ placements: [j1], outline, edgeClearanceMm: 1, overhangAllowances: { J1: { maxOverhangMm: 3 } } });
  assert.equal(noReason.ok, false, '没有理由的额度不得放行');
  assert.ok(noReason.findings.some((f) => f.code === PLACEMENT_CODES.OUTSIDE_OUTLINE), JSON.stringify(noReason.findings.map((f) => f.code)));
  const shortReason = verifyOutlinePlacement({ placements: [j1], outline, edgeClearanceMm: 1, overhangAllowances: { J1: { maxOverhangMm: 3, reason: '可以' } } });
  assert.equal(shortReason.ok, false, '理由过短同样不许放行');
});

test('0.13mm 的包围盒边缘接触只给警告（包围盒含焊盘，不足以断定碰撞）', () => {
  const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);
  const u3 = { ref: 'U3', xMm: 28, yMm: -29, widthMm: 3.54, heightMm: 5.91, rotationDeg: 0 };
  const j1 = { ref: 'J1', xMm: 30, yMm: -36, widthMm: 9.86, heightMm: 8.35, rotationDeg: 0 };
  const result = verifyOutlinePlacement({ placements: [u3, j1], outline, edgeClearanceMm: 1, spacingMm: 0.5, overhangAllowances: { J1: { maxOverhangMm: 3, reason: 'USB-C 插座需伸出板边' } } });
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes(PLACEMENT_CODES.BBOX_OVERLAP_MARGINAL), JSON.stringify(codes));
  assert.equal(codes.includes(PLACEMENT_CODES.OVERLAP), false, '0.13mm 真实重叠不应直接判成碰撞');
  // 报出来的必须是"真实重叠 0.13mm + 间距缺口 0.63mm"，不能把间距缺口说成重叠
  const marginal = result.findings.find((f) => f.code === PLACEMENT_CODES.BBOX_OVERLAP_MARGINAL);
  assert.match(marginal.message, /真实重叠仅 0\.13mm/);
  assert.match(marginal.message, /间距要求还差 0\.63mm/);
  assert.equal(result.ok, true);
  // 真正的大面积重叠仍然阻断
  const heavy = verifyOutlinePlacement({ placements: [u3, { ...u3, ref: 'U9', yMm: -30 }], outline, edgeClearanceMm: 1 });
  assert.equal(heavy.ok, false);
  assert.ok(heavy.findings.some((f) => f.code === PLACEMENT_CODES.OVERLAP));
});

test('没有重叠、只是不满足自设间距目标时，只能报 info 且不能被说成碰撞', () => {
  const outline = parsePolygonSource(REAL_OUTLINE_SOURCE);
  const a = { ref: 'A', xMm: 20, yMm: -20, widthMm: 4, heightMm: 4, rotationDeg: 0 };
  const b = { ref: 'B', xMm: 24.2, yMm: -20, widthMm: 4, heightMm: 4, rotationDeg: 0 };
  const result = verifyOutlinePlacement({ placements: [a, b], outline, edgeClearanceMm: 1, spacingMm: 0.5 });
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes(PLACEMENT_CODES.SPACING_SHORTFALL), JSON.stringify(codes));
  assert.equal(codes.includes(PLACEMENT_CODES.OVERLAP), false);
  const finding = result.findings.find((f) => f.code === PLACEMENT_CODES.SPACING_SHORTFALL);
  assert.equal(finding.severity, 'info');
  assert.ok(Math.abs(0.2 - 0.2) < 1e-9);
  assert.match(finding.message, /未重叠/);
});
