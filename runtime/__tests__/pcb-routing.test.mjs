import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeNetConnectivity, applyPairMatchingPlan, applyRoutingPlan, buildRepairConnections, detectDifferentialPairs, finishRouting,
  measureNetLengths, planConnectionRoute, planPairSkewCompensation, planRepairRoutes, pointSegmentDistance, rollbackRouting,
  segmentSegmentDistance, verifyPairMatching, verifyRoutingPlan,
} from '../engineering/pcb-routing.mjs';

/** 造一块"两个焊盘 + 一条走线"的最小板，焊盘按需摆放。 */
function boardWith(farPad) {
  return {
    pads: [
      { designator: 'U1', pad: '1', net: 'N1', layer: 1, x: 0, y: 0, radius: 5 },
      { designator: 'U2', pad: '1', net: 'N1', layer: 1, x: farPad.x, y: farPad.y, radius: 5 },
    ],
    lines: [],
    vias: [],
  };
}

test('连通性分析：孤立焊盘会被判成独立岛，接上走线后合并', () => {
  const broken = analyzeNetConnectivity(boardWith({ x: 200, y: 0 }));
  assert.equal(broken.nets.length, 1);
  assert.equal(broken.nets[0].connected, false);
  assert.equal(broken.nets[0].islands.length, 2);

  const connected = analyzeNetConnectivity({ ...boardWith({ x: 100, y: 0 }), lines: [{ net: 'N1', layer: 1, x1: 0, y1: 0, x2: 100, y2: 0, width: 10 }] });
  assert.equal(connected.nets[0].connected, true);
  assert.equal(connected.nets[0].islands.length, 1);
});

test('断网自动转成待修连接：起点取孤立岛上的焊盘', () => {
  const { connections } = buildRepairConnections(boardWith({ x: 200, y: 0 }));
  assert.equal(connections.length, 1);
  assert.equal(connections[0].net, 'N1');
  assert.equal(connections[0].from.designator, 'U2');
});

test('自由空间里能规划出线，且独立复核判定"间距合规 + 已连通"', () => {
  const geometry = boardWith({ x: 200, y: 0 });
  const { connections } = buildRepairConnections(geometry);
  const route = planConnectionRoute({ geometry, connection: connections[0] });
  assert.equal(route.ok, true);
  assert.equal(route.fanout, 'top');
  assert.ok(route.segments.length >= 1);
  const verification = verifyRoutingPlan({ plan: { routes: [route] }, geometry });
  assert.equal(verification.ok, true);
  assert.equal(verification.violations.length, 0);
  assert.deepEqual(verification.connectivity, [{ net: 'N1', connected: true, islands: 1 }]);
});

test('0.4mm 间距被围死的内圈焊盘：顶层逃逸失败，必须盘中孔换层', () => {
  // U1 焊盘在 (0,0)，四周 15.8mil 处是三个无网焊盘 + 一个异网焊盘 —— 真机上就是这么被围死的
  const geometry = {
    pads: [
      { designator: 'U1', pad: 'B3', net: 'SCL', layer: 1, x: 0, y: 0, radius: 5 },
      { designator: 'U1', pad: 'A3', net: '', layer: 1, x: 0, y: 15.8, radius: 5 },
      { designator: 'U1', pad: 'C3', net: '', layer: 1, x: 0, y: -15.8, radius: 5 },
      { designator: 'U1', pad: 'B2', net: '', layer: 1, x: -15.8, y: 0, radius: 5 },
      { designator: 'U1', pad: 'B4', net: '', layer: 1, x: 15.8, y: 0, radius: 5 },
      { designator: 'U2', pad: '5', net: 'SCL', layer: 1, x: 300, y: 0, radius: 5 },
    ],
    lines: [],
    vias: [],
  };
  const route = planConnectionRoute({ geometry, connection: { net: 'SCL', from: { x: 0, y: 0, layer: 1, designator: 'U1', pad: 'B3' } } });
  assert.equal(route.ok, true);
  assert.equal(route.fanout, 'via-in-pad');
  assert.equal(route.viaInPad, true);
  const verification = verifyRoutingPlan({ plan: { routes: [route] }, geometry });
  assert.equal(verification.connectivity[0].connected, true, '盘中孔路线必须真的把网络接通');
  assert.equal(verification.violations.length, 0, `不应有间距违规：${JSON.stringify(verification.violations)}`);
});

test('独立复核能挡住间距不足的计划（贴着异网走线走）', () => {
  const geometry = {
    pads: [
      { designator: 'U1', pad: '1', net: 'N1', layer: 1, x: 0, y: 0, radius: 5 },
      { designator: 'U2', pad: '1', net: 'N1', layer: 1, x: 200, y: 0, radius: 5 },
    ],
    lines: [{ id: 'x1', net: 'N2', layer: 1, x1: 100, y1: -1, x2: 100, y2: -60, width: 10 }],
    vias: [],
  };
  const bad = { ok: true, net: 'N1', viaInPad: false, from: { x: 0, y: 0 }, segments: [{ layer: 1, x1: 0, y1: 0, x2: 200, y2: 0 }], vias: [] };
  const verification = verifyRoutingPlan({ plan: { routes: [bad] }, geometry });
  assert.equal(verification.ok, false);
  assert.ok(verification.violations.some((entry) => entry.kind === 'line-to-line'));
  assert.ok(verification.minGapMil < 6);
});

test('写入默认 dryRun：不落任何铜；正式写入后回读比对通过', async () => {
  const geometry = boardWith({ x: 200, y: 0 });
  const { connections } = buildRepairConnections(geometry);
  const route = planConnectionRoute({ geometry, connection: connections[0] });
  const calls = [];
  const written = { lines: [], vias: [] };
  const execute = async (commandId, args) => {
    calls.push(commandId);
    if (commandId === 'pcb.line.create') {
      written.lines.push({ id: `L${written.lines.length}`, net: args.net, layer: args.layer, x1: args.startX, y1: args.startY, x2: args.endX, y2: args.endY, width: args.lineWidth });
      return { result: { primitiveId: `L${written.lines.length - 1}` } };
    }
    if (commandId === 'pcb.via.create') {
      written.vias.push({ id: `V${written.vias.length}`, net: args.net, x: args.x, y: args.y, outerDiameter: args.diameter, hole: args.holeDiameter });
      return { result: { primitiveId: `V${written.vias.length - 1}` } };
    }
    if (commandId === 'pcb.copper.read') return { result: { lines: [...geometry.lines, ...written.lines], vias: [...geometry.vias, ...written.vias], pads: geometry.pads } };
    if (commandId === 'pcb.save') return { result: { saved: true } };
    throw new Error(`未预期的命令 ${commandId}`);
  };

  const dry = await applyRoutingPlan({ execute, plan: { routes: [route] }, geometry });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.executed, 0);
  assert.deepEqual(calls, [], 'dryRun 不应触发任何 EDA 写入');

  const real = await applyRoutingPlan({ execute, plan: { routes: [route] }, geometry, dryRun: false });
  assert.equal(real.dryRun, false);
  assert.ok(real.executed >= 1);
  assert.ok(calls.includes('pcb.line.create'));
  assert.ok(calls.includes('pcb.copper.read'), '写入后必须回读比对');
  assert.equal(real.saved, false, '保存必须显式要求，默认不保存');
});

test('回读比对失败会回滚：把刚写的铜删掉，并抛出可识别错误', async () => {
  const geometry = boardWith({ x: 200, y: 0 });
  const { connections } = buildRepairConnections(geometry);
  const route = planConnectionRoute({ geometry, connection: connections[0] });
  const calls = [];
  const deleted = [];
  const execute = async (commandId, args) => {
    calls.push(commandId);
    if (commandId === 'pcb.line.create') return { result: { primitiveId: 'L-new' } };
    if (commandId === 'pcb.via.create') return { result: { primitiveId: 'V-new' } };
    if (commandId === 'pcb.copper.read') return { result: { lines: geometry.lines, vias: geometry.vias, pads: geometry.pads } };
    if (commandId === 'pcb.lines.delete' || commandId === 'pcb.vias.delete') { deleted.push(...(args.primitiveIds ?? [])); return { result: { ok: true } }; }
    throw new Error(`未预期的命令 ${commandId}`);
  };
  await assert.rejects(
    () => applyRoutingPlan({ execute, plan: { routes: [route] }, geometry, dryRun: false }),
    (error) => error.code === 'ROUTING_READBACK_MISMATCH',
  );
  assert.ok(deleted.includes('L-new'), `回滚必须删掉刚写的线：${JSON.stringify(deleted)}`);
});

test('复核不通过的计划直接拒写（不落铜）', async () => {
  const geometry = boardWith({ x: 200, y: 0 });
  const calls = [];
  const execute = async (commandId) => { calls.push(commandId); return { result: {} }; };
  const badPlan = { routes: [{ ok: true, net: 'N1', viaInPad: false, from: { x: 0, y: 0 }, segments: [{ layer: 1, x1: 0, y1: 0, x2: 20, y2: 0 }], vias: [] }] };
  await assert.rejects(
    () => applyRoutingPlan({ execute, plan: badPlan, geometry, dryRun: false }),
    (error) => error.code === 'ROUTING_PLAN_REJECTED',
  );
  assert.deepEqual(calls, [], '拒写的计划不应触发任何写入命令');
});

test('收尾：重建铺铜 + 显式保存，且两笔写入都必须走受控授权', async () => {
  const calls = [];
  const execute = async (commandId, args, options) => {
    calls.push({ commandId, allowWrite: options?.allowWrite === true });
    if (commandId === 'pcb.poured.read') return { result: [{ primitiveId: 'p1', net: 'GND', layer: 1, filledFills: 4 }] };
    return { result: { ok: true } };
  };
  const done = await finishRouting({ execute });
  assert.deepEqual(calls.map((entry) => entry.commandId), ['pcb.pour.rebuild', 'pcb.poured.read', 'pcb.save']);
  const writes = calls.filter((entry) => entry.commandId !== 'pcb.poured.read');
  assert.ok(writes.every((entry) => entry.allowWrite), '写入必须带受控授权，不能绕过运行时');
  assert.equal(done.saved, true);
  assert.equal(done.poursFilled, true);

  calls.length = 0;
  const light = await finishRouting({ execute, rebuildPours: false, save: false });
  assert.deepEqual(calls, [], '显式关闭时不应写任何东西');
  assert.equal(light.saved, false);
  assert.equal(light.pours, null);
});

test('收尾复核（D-36-1）：覆铜重建后没有任何填充 → 重试一次仍失败则不保存并如实报错', async () => {
  const calls = [];
  const execute = async (commandId, args, options) => {
    calls.push({ commandId, allowWrite: options?.allowWrite === true });
    if (commandId === 'pcb.poured.read') {
      // 真机现象：覆铜边框在，但一个填充都没产出
      return { result: [{ primitiveId: 'gnd', net: 'GND', layer: 1, filledFills: 0 }, { primitiveId: 'p5v', net: '+5V', layer: 1, filledFills: 3 }] };
    }
    return { result: { ok: true } };
  };
  const done = await finishRouting({ execute });
  assert.equal(done.ok, false);
  assert.equal(done.saved, false, '没填充的板不能被保存成"已完成"');
  assert.equal(done.poursFilled, false);
  assert.equal(done.error.code, 'PCB_POUR_FILL_INCOMPLETE');
  assert.deepEqual(done.unfilledPours.map((item) => item.net), ['GND']);
  assert.equal(calls.filter((entry) => entry.commandId === 'pcb.pour.rebuild').length, 2, '必须重试一次');
  assert.equal(calls.filter((entry) => entry.commandId === 'pcb.save').length, 0, '失败时不得保存');
});

test('通孔焊盘（层12/带孔）在内层同样占位：内层路线不得横穿它', () => {
  const geometry = {
    pads: [
      { designator: 'U1', pad: '1', net: 'N1', layer: 1, x: 0, y: 0, radius: 5 },
      { designator: 'J1', pad: '4', net: 'GND', layer: 12, x: 200, y: 100, radius: 30, holes: 1, holeDiameter: 8, throughHole: true },
      { designator: 'U2', pad: '1', net: 'N1', layer: 1, x: 400, y: 200, radius: 5 },
    ],
    lines: [], vias: [],
  };
  const route = planConnectionRoute({ geometry, connection: { net: 'N1', from: { x: 0, y: 0, layer: 1, radius: 5 } } });
  assert.equal(route.ok, true);
  const verification = verifyRoutingPlan({ plan: { routes: [route] }, geometry });
  assert.equal(verification.violations.filter((entry) => entry.kind === 'line-to-th-pad').length, 0, `不得横穿通孔焊盘：${JSON.stringify(verification.violations)}`);
  assert.equal(verification.ok, true);
});

test('复核能挡住同批计划里两条路线互交叉（真机 DRC 报过 distance 0mil）', () => {
  const geometry = { pads: [], lines: [], vias: [] };
  const netA = { ok: true, net: 'N1', viaInPad: false, from: { x: 0, y: 0 }, segments: [{ layer: 1, x1: 0, y1: 0, x2: 100, y2: 100 }], vias: [] };
  const netB = { ok: true, net: 'N2', viaInPad: false, from: { x: 0, y: 100 }, segments: [{ layer: 1, x1: 0, y1: 100, x2: 100, y2: 0 }], vias: [] };
  const verification = verifyRoutingPlan({ plan: { routes: [netA, netB] }, geometry });
  assert.ok(verification.violations.some((entry) => entry.kind === 'route-to-route-line'), JSON.stringify(verification.violations));
  assert.equal(verification.ok, false);
});

test('回滚：按ID删除并回读确认，残留必须如实报出来', async () => {
  const calls = [];
  const execute = async (commandId, args) => {
    calls.push(commandId);
    if (commandId === 'pcb.copper.read') return { result: { lines: [{ id: 'keep' }], vias: [{ id: 'v-stuck' }] } };
    return { result: { ok: true } };
  };
  const outcome = await rollbackRouting({ execute, items: [{ kind: 'line', id: 'l1' }, { kind: 'via', id: 'v-stuck' }] });
  assert.deepEqual(calls.slice(0, 2), ['pcb.lines.delete', 'pcb.vias.delete']);
  assert.equal(outcome.removed, 1);
  assert.deepEqual(outcome.residual, ['v-stuck'], '没删掉的必须报出来，不能假装回滚成功');
});

test('顺序规划互斥占位：两条本来会交叉的路线，后规划的那条必须绕开', () => {
  const geometry = {
    pads: [
      { designator: 'U1', pad: '1', net: 'N1', layer: 1, x: 0, y: 0, radius: 5 },
      { designator: 'U2', pad: '1', net: 'N1', layer: 1, x: 300, y: 300, radius: 5 },
      { designator: 'U3', pad: '1', net: 'N2', layer: 1, x: 0, y: 300, radius: 5 },
      { designator: 'U4', pad: '1', net: 'N2', layer: 1, x: 300, y: 0, radius: 5 },
    ],
    lines: [], vias: [],
  };
  const connections = [
    { net: 'N1', from: { x: 0, y: 0, layer: 1, radius: 5 } },
    { net: 'N2', from: { x: 0, y: 300, layer: 1, radius: 5 } },
  ];
  const planned = planRepairRoutes({ geometry, connections });
  assert.equal(planned.succeeded, 2, JSON.stringify(planned.routes.map((route) => route.reason)));
  assert.equal(planned.verification.ok, true, JSON.stringify(planned.verification.violations));
  assert.equal(planned.verification.violations.filter((entry) => String(entry.kind).startsWith('route-to-route')).length, 0);
});

test('写入后短走线被EDA合并进长走线：铜确实在板上，不得误报缺失', async () => {
  const geometry = {
    pads: [
      { designator: 'U1', pad: '1', net: 'N1', layer: 1, x: 0, y: 0, radius: 5 },
      { designator: 'U2', pad: '1', net: 'N1', layer: 1, x: 200, y: 0, radius: 5 },
    ],
    lines: [], vias: [],
  };
  const connection = { net: 'N1', from: { x: 0, y: 0, layer: 1, radius: 5 } };
  const route = planConnectionRoute({ geometry, connection });
  assert.equal(route.ok, true);
  const execute = async (commandId, args) => {
    if (commandId === 'pcb.line.create') return { result: { primitiveId: 'L-merged-away' } };
    if (commandId === 'pcb.copper.read') {
      // 模拟 EDA 行为：新画的短线段被合并成一条更长的走线，原ID不复存在
      return { result: { lines: [{ id: 'L-merged', net: 'N1', layer: 1, x1: -20, y1: 0, x2: 220, y2: 0, width: 8 }], vias: [], pads: geometry.pads } };
    }
    if (commandId === 'pcb.save') return { result: { saved: true } };
    throw new Error(`未预期的命令 ${commandId}`);
  };
  const result = await applyRoutingPlan({ execute, plan: { routes: [route] }, geometry, dryRun: false, options: { readbackAttempts: 2, readbackSettleMs: 1 } });
  assert.equal(result.ok, true, '被合并的走线必须判为"已在板上"');
  assert.equal(result.executed, route.segments.length);
});

/**
 * 差分对测试夹具：两条同层水平走线 P/N，N 比 P 长 `skewMil`。
 * 用栅格友好的整数坐标，让"补上的长度"能被 4 mil 栅格精确表达，从而验证"恰好补够"。
 */
function diffPairBoard({ skewMil = 240, layer = 1, pLength = 600, nExtra = null, outline = null, extraLines = [] }) {
  const extra = nExtra == null ? skewMil : nExtra;
  return {
    lines: [
      { id: 'L-P', net: 'USB_DP', layer, x1: 0, y1: 0, x2: pLength, y2: 0, width: 8 },
      { id: 'L-N', net: 'USB_DM', layer, x1: 0, y1: -100, x2: pLength + extra, y2: -100, width: 8 },
      ...extraLines,
    ],
    pads: [], vias: [],
    ...(outline ? { outline } : {}),
  };
}

function pathsMatch(segments, path, tolerance = 1e-6) {
  if (segments.length !== path.length) return false;
  return segments.every((segment, index) => Math.abs(segment.x1 - path[index][0]) <= tolerance
    && Math.abs(segment.y1 - path[index][1]) <= tolerance
    && Math.abs(segment.x2 - path[index + 1][0]) <= tolerance
    && Math.abs(segment.y2 - path[index + 1][1]) <= tolerance);
}

/**
 * 测试侧独立复算间距：不复用被测实现里的任何判据，直接用导出的解析距离重算"新铜到异网铜的净距"。
 * 差分对等长最危险的失效模式就是"规划说合规、其实压到别的网上"，所以这条必须由测试自己算。
 */
function minForeignGap(segment, layer, geometry, excludeNet, width = 8) {
  const seg = { x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2 };
  let min = Infinity;
  for (const line of geometry.lines ?? []) {
    if (String(line.net ?? '') === excludeNet || line.layer !== layer) continue;
    min = Math.min(min, segmentSegmentDistance(seg, line) - line.width / 2 - width / 2);
  }
  for (const pad of geometry.pads ?? []) {
    if (String(pad.net ?? '') === excludeNet) continue;
    if (!pad.throughHole && pad.layer !== layer) continue;
    const radius = Math.max(pad.radius ?? 0, (pad.holeDiameter ?? 0) / 2);
    min = Math.min(min, pointSegmentDistance(pad.x, pad.y, seg) - radius - width / 2);
  }
  for (const via of geometry.vias ?? []) {
    if (String(via.net ?? '') === excludeNet) continue;
    min = Math.min(min, pointSegmentDistance(via.x, via.y, seg) - (via.outerDiameter ?? 24) / 2 - width / 2);
  }
  return min;
}

test('差分对识别：声明优先，名字启发式兜底并去重', () => {
  const pairs = detectDifferentialPairs({
    nets: ['USB_DP', 'USB_DM', 'CLK+', 'CLK-', 'HDMI0_P', 'HDMI0_N', 'VCC', 'GND'],
  });
  assert.deepEqual(pairs, [
    { positive: 'USB_DP', negative: 'USB_DM', source: 'heuristic' },
    { positive: 'CLK+', negative: 'CLK-', source: 'heuristic' },
    { positive: 'HDMI0_P', negative: 'HDMI0_N', source: 'heuristic' },
  ]);

  // plan 里显式声明的差分对优先，且与启发式结果去重（显式用不同大小写也认同一对）
  const declared = detectDifferentialPairs({
    nets: ['AAA_P', 'AAA_N', 'DP', 'DM', 'D+', 'D-'],
    plan: { impedance: { pairs: [{ positive: 'aaa_p', negative: 'aaa_n', z0: 90 }] } },
  });
  assert.equal(declared[0].source, 'explicit');
  assert.deepEqual(declared[0], { positive: 'AAA_P', negative: 'AAA_N', source: 'explicit' });
  assert.equal(declared.length, 3, JSON.stringify(declared));
  assert.deepEqual(declared[1], { positive: 'DP', negative: 'DM', source: 'heuristic' });
  assert.deepEqual(declared[2], { positive: 'D+', negative: 'D-', source: 'heuristic' });

  // 只看得到一半的"差分对"不算一对；字母数量不足的主体也不误判
  assert.equal(detectDifferentialPairs({ nets: ['USB_DP', 'USB_DM', 'CLK_N'] }).length, 1);
  assert.deepEqual(detectDifferentialPairs({ nets: ['P', 'N'] }), []);
});

test('量网络长度：逐层明细；圆弧近似必须如实标注', () => {
  const geometry = {
    lines: [
      { id: 'a', net: 'N1', layer: 1, x1: 0, y1: 0, x2: 100, y2: 0, width: 8 },
      { id: 'b', net: 'N1', layer: 1, x1: 100, y1: 0, x2: 100, y2: 50, width: 8 },
      { id: 'c', net: 'N1', layer: 17, x1: 0, y1: 0, x2: 10, y2: 0, width: 8 },
    ],
    pads: [
      { designator: 'U1', pad: '1', net: 'N1', layer: 1, x: 0, y: 0, radius: 5 },
      { designator: 'U2', pad: '1', net: 'N1', layer: 1, x: 100, y: 50, radius: 5 },
    ],
    vias: [],
  };
  const measured = measureNetLengths(geometry);
  const entry = measured.nets.find((item) => item.net === 'N1');
  assert.equal(entry.totalMil, 160); // 100 + 50 + 10，两端焊盘都已被走线覆盖，不额外计
  assert.deepEqual(entry.byLayer, [{ layer: 1, lengthMil: 150, segments: 2 }, { layer: 17, lengthMil: 10, segments: 1 }]);
  assert.equal(measured.metadata.arcApproximated, false);
  assert.equal(measured.metadata.lengthKind, 'exact-segments');

  // 圆弧：rad 100 的 90° 圆弧 = π×100/2 = 157.08 mil，必须如实标注为"近似"
  const arc = measureNetLengths({ lines: [{ id: 'a1', net: 'A1', layer: 1, x1: 0, y1: 0, x2: 100, y2: 100, width: 8, radius: 100 }], pads: [], vias: [] });
  assert.equal(arc.metadata.arcApproximated, true);
  assert.equal(arc.metadata.lengthKind, 'approximate-arcs');
  assert.ok(arc.metadata.notes.some((note) => note.includes('圆弧')), JSON.stringify(arc.metadata.notes));
  assert.ok(Math.abs(arc.nets[0].totalMil - Math.PI * 100 / 2) < 0.01, `弧长近似：${arc.nets[0].totalMil}`);
});

test('差分对等长：恰好补足所需长度，端点严格不变（连通性由构造保证）', () => {
  // P=600，N=840 ⇒ skew 240；n=3 齿、振幅 40 mil ⇒ 每齿净增 2×40，正好 240
  const geometry = diffPairBoard({ skewMil: 240 });
  const plan = planPairSkewCompensation({
    geometry,
    pairs: [{ positive: 'USB_DP', negative: 'USB_DM' }],
    options: { outline: [{ x: -50, y: -300 }, { x: 900, y: -300 }, { x: 900, y: 200 }, { x: -50, y: 200 }] },
  });
  assert.equal(plan.unplannable.length, 0, JSON.stringify(plan.unplannable));
  assert.equal(plan.pairs.length, 1);
  const entry = plan.pairs[0];
  assert.equal(entry.neededMil, 240);
  assert.equal(entry.skewBeforeMil, 240);
  assert.equal(entry.edits.length, 1);
  const edit = entry.edits[0];
  assert.equal(edit.net, 'USB_DP', '必须补较短的那条');
  assert.equal(edit.remove.id, 'L-P');
  assert.equal(edit.addedMil, 240, '必须恰好补足所需长度');
  assert.equal(edit.residualMil, 0);
  assert.equal(edit.exact, true);
  assert.ok(edit.toothCount >= 1, `齿数必须是真数出来的：${edit.toothCount}`);
  assert.ok(edit.amplitudeMil >= 8 + 2 * 6, `振幅必须 ≥ width + 2×clearance：${edit.amplitudeMil}`);
  assert.ok(Math.min(edit.runMil, edit.strideMil) >= 6 + 8 / 2, `横腿/齿间距必须 ≥ clearance + width/2：${JSON.stringify([edit.runMil, edit.strideMil])}`);
  assert.equal(edit.endpointsPreserved, true);
  assert.equal(entry.skewAfterMil, 0, 'skew 不能被四舍五入抹掉，也不能悄悄丢弃');

  // 端点严格等于被替换线段的端点 ⇒ 长短两条铜都由构造保持连通
  assert.deepEqual(edit.add[0], { layer: 1, x1: 0, y1: 0, x2: edit.add[0].x2, y2: edit.add[0].y2 }, '起点必须落在被替换线段的起点上');
  assert.deepEqual(edit.add[edit.add.length - 1].x2, 600, '终点必须回到被替换线段的终点');
  assert.deepEqual(edit.add[edit.add.length - 1].y2, 0);
  for (let index = 1; index < edit.add.length; index += 1) {
    assert.equal(edit.add[index].x1, edit.add[index - 1].x2);
    assert.equal(edit.add[index].y1, edit.add[index - 1].y2);
  }
  // 长号的所有新段必须整条都在原线段的一侧（不会自己穿过原线段）
  const offAxis = edit.add.filter((segment) => Math.abs(segment.y1) > 1e-9 || Math.abs(segment.y2) > 1e-9);
  const sideSign = Math.sign(offAxis[0].y1) || Math.sign(offAxis[0].y2);
  const onesided = edit.add.every((segment) => segment.y1 * sideSign >= -1e-9 && segment.y2 * sideSign >= -1e-9);
  assert.equal(onesided, true, `长号只能往外侧凸，不能跨过原线段（side=${sideSign}）`);

  // 独立复核：在"旧线删掉 + 长号加上"之后的铜面上重算，必须判 pass
  const appliedLines = [
    geometry.lines[1],
    ...edit.add.filter((segment) => Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1) > 1e-9)
      .map((segment, index) => ({ id: `NEW-${index}`, net: edit.net, layer: edit.layer, ...segment, width: 8 })),
  ];
  const after = measureNetLengths({ lines: appliedLines, pads: [], vias: [] }).nets;
  assert.equal(after.find((item) => item.net === 'USB_DP').totalMil, 840);
  // 复核接收的是"已经改完的铜面"，所以这里必须真的把长号加进去
  const verified = verifyPairMatching({ geometry: { lines: appliedLines, pads: [], vias: [] }, plan });
  assert.equal(verified.pairs[0].pass, true, JSON.stringify(verified.violations));
  assert.equal(verified.pairs[0].skewMil, 0);
});

test('差分对等长：自由空间不足时进 unplannable，并给出具体原因（绝不静默丢弃）', () => {
  // 异网铜紧贴在走线正上方，把长号要伸出去的一侧堵死（长号至少要有 width + 2×clearance = 20 mil 的振幅）
  const crowded = diffPairBoard({
    skewMil: 240,
    // 双侧都堵：长号现在会尝试往线段两侧凸出，只堵一侧不足以构成"空间不足"，
    // 那样测的就变成"能不能换侧"而不是本条要验证的"空间不足必须如实进 unplannable"。
    extraLines: [
      { id: 'X1', net: 'GND', layer: 1, x1: -20, y1: 14, x2: 620, y2: 14, width: 8 },
      { id: 'X2', net: 'GND', layer: 1, x1: -20, y1: -14, x2: 620, y2: -14, width: 8 },
    ],
  });
  const blocked = planPairSkewCompensation({ geometry: crowded, pairs: [{ positive: 'USB_DP', negative: 'USB_DM' }] });
  assert.equal(blocked.pairs.length, 0, JSON.stringify(blocked.pairs));
  assert.equal(blocked.unplannable.length, 1, JSON.stringify(blocked));
  assert.match(blocked.unplannable[0].reason, /free space|异网铜|板框/);
  assert.equal(blocked.unplannable[0].neededMil, 240);
  assert.equal(blocked.unplannable[0].candidateSegments, 1);
  // 失败原因必须具体到"撞的是谁、差多少 mil"，不能只是一句模糊的 budget 标签
  assert.equal(blocked.unplannable[0].details[0].candidateIndex, 1);
  assert.equal(blocked.unplannable[0].details[0].amplitudeMil, 20, '代表解必须是振幅最小、最省地方的那条');
  assert.equal(blocked.unplannable[0].details[0].blockingKind, 'clearance');
  assert.equal(blocked.unplannable[0].details[0].blockingNet, 'GND');
  assert.ok(blocked.unplannable[0].missingSpaceMil > 0, `必须给出还差多少 mil 空间：${JSON.stringify(blocked.unplannable[0])}`);
  assert.match(blocked.unplannable[0].reason, /GND|板框/);
});

test('差分对等长：间距逐段真算——邻近但合规的异网铜不误杀，堵住的一侧要换边', () => {
  // GND 在走线正上方 40 mil：振幅 20 mil 的长号铜边离 GND 还有 40 − 20 − 8 = 12 mil ≥ 6，必须能补。
  // （旧的实现拿"线段和自己"算距离，任何进粗筛盒的异网铜都会被判超距 ⇒ 这种合规场景被误杀。）
  const near = diffPairBoard({ skewMil: 240, extraLines: [{ id: 'X1', net: 'GND', layer: 1, x1: -20, y1: 40, x2: 620, y2: 40, width: 8 }] });
  const planned = planPairSkewCompensation({ geometry: near, pairs: [{ positive: 'USB_DP', negative: 'USB_DM' }] });
  assert.equal(planned.unplannable.length, 0, JSON.stringify(planned.unplannable));
  const edit = planned.pairs[0].edits[0];
  const gaps = edit.add.map((segment) => minForeignGap(segment, 1, near, 'USB_DP'));
  const measured = Math.min(...gaps);
  assert.ok(measured >= 6 - 1e-9, `新铜离异网铜必须 ≥ clearance：${measured}`);
  assert.ok(Math.abs(measured - 12) <= 1e-6, `这里真实净距应当是 40 − 20 − 8 = 12 mil，实测 ${measured}`);

  // 同一根 GND 压到 30 mil：上方 30 − 20 − 8 = 2 < 6 放不下 ⇒ 必须换到另一侧（下方 100 mil 无遮挡）。
  const bottomBlockedUp = diffPairBoard({ skewMil: 240, extraLines: [{ id: 'X1', net: 'GND', layer: 1, x1: -20, y1: 30, x2: 620, y2: 30, width: 8 }] });
  const flipped = planPairSkewCompensation({ geometry: bottomBlockedUp, pairs: [{ positive: 'USB_DP', negative: 'USB_DM' }] });
  assert.equal(flipped.unplannable.length, 0, JSON.stringify(flipped.unplannable));
  const add = flipped.pairs[0].edits[0].add;
  assert.ok(add.every((segment) => segment.y1 <= 1e-9 && segment.y2 <= 1e-9), '上方被堵死时长号必须整条换到线段下方');
  assert.ok(Math.min(...add.flatMap((segment) => [segment.y1, segment.y2])) < -1e-9);
  assert.ok(Math.min(...add.map((segment) => minForeignGap(segment, 1, bottomBlockedUp, 'USB_DP'))) >= 6 - 1e-9);
});

test('差分对等长：图元没有 id 的快照也必须逐段算间距（不得把异网铜整个丢掉）', () => {
  // 真机快照不一定给每条线 id。旧实现用 `id != null` 取 originalId，'' 也算数，
  // 于是"排除原线"顺手把所有没 id 的线全删掉 ⇒ 间距判定面对空铜面必然放行 ⇒ 长号可能直接压到 GND 上。
  const geometry = {
    lines: [
      { net: 'USB_DP', layer: 1, x1: 0, y1: 0, x2: 600, y2: 0, width: 8 },
      { net: 'USB_DM', layer: 1, x1: 0, y1: -100, x2: 840, y2: -100, width: 8 },
      { net: 'GND', layer: 1, x1: -20, y1: 14, x2: 620, y2: 14, width: 8 },
      { net: 'GND', layer: 1, x1: -20, y1: -14, x2: 620, y2: -14, width: 8 },
    ],
    pads: [], vias: [],
  };
  const plan = planPairSkewCompensation({ geometry, pairs: [{ positive: 'USB_DP', negative: 'USB_DM' }] });
  assert.equal(plan.pairs.length, 0, '双侧都被 GND 堵死时绝不允许写出会短路的长号');
  assert.equal(plan.unplannable.length, 1);
  assert.equal(plan.unplannable[0].details[0].blockingNet, 'GND');
  assert.ok(plan.unplannable[0].missingSpaceMil >= 6, JSON.stringify(plan.unplannable[0]));
});

test('差分对等长：真板量级 433.7 mil（11.02mm）能补到 ≤10 mil 并给出走廊尺寸', () => {
  // 真板事实：USB_DP 2096.9 mil vs USB_DM 2530.6 mil ⇒ 短的那条要补 433.7 mil（11.02mm），规则 ≤10 mil。
  // 没有 EDA 快照可比时，用同量级合成板验证可行性口径：齿数/振幅/走廊长度，以及独立复核是否通过。
  const geometry = {
    lines: [
      { id: 'R-P', net: 'USB_DP', layer: 1, x1: 0, y1: 0, x2: 2096.9, y2: 0, width: 8 },
      { id: 'R-N', net: 'USB_DM', layer: 1, x1: 0, y1: -120, x2: 2530.6, y2: -120, width: 8 },
    ],
    pads: [], vias: [],
    outline: [{ x: -100, y: -200 }, { x: 2700, y: -200 }, { x: 2700, y: 200 }, { x: -100, y: 200 }],
  };
  const plan = planPairSkewCompensation({ geometry, pairs: [{ positive: 'USB_DP', negative: 'USB_DM' }], options: { outline: geometry.outline } });
  assert.equal(plan.unplannable.length, 0, JSON.stringify(plan.unplannable));
  const entry = plan.pairs[0];
  assert.equal(entry.neededMil, 433.7);
  const edit = entry.edits[0];
  assert.ok(edit.addedMil >= 433.7 - 1e-9 && edit.addedMil - 433.7 <= 10 + 1e-9, `补出的长度必须落在 [433.7, 443.7] mil：${edit.addedMil}`);
  assert.equal(edit.endpointsPreserved, true);
  assert.ok(edit.amplitudeMil >= 20, `振幅必须 ≥ width + 2×clearance：${edit.amplitudeMil}`);
  assert.ok(edit.toothCount >= 1);
  // 走廊长度 = 实际齿区跨度（不是"齿距×齿数"那种会被高估的估算）
  const toothXs = edit.add.filter((segment) => Math.abs(segment.y1) > 1e-9 || Math.abs(segment.y2) > 1e-9).flatMap((segment) => [segment.x1, segment.x2]);
  const corridorMil = Math.max(...toothXs) - Math.min(...toothXs);
  assert.ok(Math.abs(edit.spanMil - corridorMil) <= 1e-6, `spanMil 必须等于实际走廊跨度 ${corridorMil}，实际 ${edit.spanMil}`);
  assert.ok(corridorMil <= 2096.9);
  const measuredMinGap = Math.min(...edit.add.map((segment) => minForeignGap(segment, 1, geometry, 'USB_DP')));
  assert.ok(measuredMinGap >= 6 - 1e-9, `新铜离异网铜必须 ≥ 6 mil：${measuredMinGap}`);
  // 独立复核：把旧线删掉 + 长号加上之后的铜面重算长度与间距
  const applied = [
    geometry.lines[1],
    ...edit.add.filter((segment) => Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1) > 1e-9)
      .map((segment, index) => ({ id: `NEW-${index}`, net: 'USB_DP', layer: 1, ...segment, width: 8 })),
  ];
  const verified = verifyPairMatching({ geometry: { lines: applied, pads: [], vias: [] }, plan });
  assert.equal(verified.ok, true, JSON.stringify(verified.violations));
  assert.ok(verified.pairs[0].skewMil <= 10, `复核 skew 必须 ≤10 mil：${verified.pairs[0].skewMil}`);
});

test('差分对复核：抓住人为做坏的等长（补多了导致又超差）和间距违规', () => {
  // ①直接给一个"补多了"的铜面：P 补 300 而只需要 240 ⇒ skew 60 > 10，必须判 fail
  const geometry = {
    lines: [
      { net: 'USB_DP', layer: 1, x1: 0, y1: 0, x2: 900, y2: 0, width: 8 },
      { net: 'USB_DM', layer: 1, x1: 0, y1: -100, x2: 840, y2: -100, width: 8 },
    ],
    pads: [], vias: [],
  };
  const verified = verifyPairMatching({ geometry, plan: { pairs: [{ pair: { positive: 'USB_DP', negative: 'USB_DM' } }] } });
  assert.equal(verified.ok, false);
  assert.equal(verified.pairs[0].skewMil, 60);
  assert.equal(verified.pairs[0].limitMil, 10);
  assert.equal(verified.pairs[0].pass, false);

  // ②长度看着对，但长号贴到异网铜上 ⇒ 必须报 clearance 违规
  const badEdit = {
    net: 'USB_DP', layer: 1,
    remove: { x1: 0, y1: 0, x2: 600, y2: 0 },
    add: [{ layer: 1, x1: 0, y1: 0, x2: 0, y2: -40 }, { layer: 1, x1: 0, y1: -40, x2: 600, y2: -40 }, { layer: 1, x1: 600, y1: -40, x2: 600, y2: 0 }],
  };
  const crowding = {
    lines: [
      { net: 'USB_DP', layer: 1, x1: 0, y1: 0, x2: 600, y2: 0, width: 8 },
      { net: 'USB_DM', layer: 1, x1: 0, y1: -100, x2: 840, y2: -100, width: 8 },
      { net: 'GND', layer: 1, x1: 0, y1: -45, x2: 600, y2: -45, width: 8 },
    ],
    pads: [], vias: [],
  };
  const clearanceCheck = verifyPairMatching({
    geometry: crowding,
    plan: { pairs: [{ pair: { positive: 'USB_DP', negative: 'USB_DM' }, edits: [badEdit] }] },
  });
  assert.equal(clearanceCheck.ok, false);
  assert.ok(clearanceCheck.violations.some((entry) => entry.kind === 'clearance'), JSON.stringify(clearanceCheck.violations));
  assert.ok(clearanceCheck.minGapMil < 6, `复核必须自己重算间距：${clearanceCheck.minGapMil}`);
});

test('已经等长的差分对：一个字节都不改', () => {
  const geometry = diffPairBoard({ skewMil: 0, nExtra: 0 });
  const plan = planPairSkewCompensation({ geometry, pairs: [{ positive: 'USB_DP', negative: 'USB_DM' }] });
  assert.equal(plan.unplannable.length, 0);
  assert.equal(plan.pairs.length, 1);
  assert.equal(plan.pairs[0].neededMil, 0);
  assert.equal(plan.pairs[0].matched, true);
  assert.deepEqual(plan.pairs[0].edits, []);
  assert.equal(plan.pairs[0].skewAfterMil, plan.pairs[0].skewBeforeMil);
});

test('差分对等长写入：默认 dryRun 不落铜；正式写入先删旧线再写长号，回读通过', async () => {
  const geometry = diffPairBoard({ skewMil: 240 });
  const plan = planPairSkewCompensation({ geometry, pairs: [{ positive: 'USB_DP', negative: 'USB_DM' }] });
  const calls = [];
  const board = { lines: [...geometry.lines.map((line) => ({ ...line }))], vias: [] };
  const execute = async (commandId, args) => {
    calls.push({ commandId, args });
    if (commandId === 'pcb.lines.delete') {
      board.lines = board.lines.filter((line) => !(args.primitiveIds ?? []).includes(line.id));
      return { result: { ok: true } };
    }
    if (commandId === 'pcb.line.create') {
      const record = { id: `L-NEW-${board.lines.length}`, net: args.net, layer: args.layer, x1: args.startX, y1: args.startY, x2: args.endX, y2: args.endY, width: args.lineWidth };
      board.lines.push(record);
      return { result: { primitiveId: record.id } };
    }
    if (commandId === 'pcb.copper.read') return { result: { lines: board.lines, vias: board.vias, pads: [] } };
    if (commandId === 'pcb.save') return { result: { saved: true } };
    throw new Error(`未预期的命令 ${commandId}`);
  };

  const dry = await applyPairMatchingPlan({ execute, plan, geometry, options: { writeSpacingMs: 0 } });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.executed, 0);
  assert.deepEqual(calls, [], 'dryRun 不应触发任何 EDA 写入');

  const real = await applyPairMatchingPlan({ execute, plan, geometry, dryRun: false, options: { writeSpacingMs: 0, readbackAttempts: 2, readbackSettleMs: 1 } });
  assert.equal(real.ok, true);
  assert.equal(real.executed, plan.pairs[0].edits[0].add.length);
  assert.equal(real.removed, 1, '被替换的旧线段必须真的从板上删掉');
  assert.equal(real.saved, false, '保存必须显式要求');
  const kinds = calls.map((entry) => entry.commandId);
  assert.equal(kinds[0], 'pcb.lines.delete', '必须先撤旧线再写新铜，否则同网重铜会算进长度');
  assert.ok(kinds.includes('pcb.line.create'));
  assert.ok(kinds.includes('pcb.copper.read'), '写入后必须回读比对');
  assert.equal(board.lines.filter((line) => line.id === 'L-P' || String(line.id).startsWith('L-NEW')).length, plan.pairs[0].edits[0].add.length, '板上应只剩长号折线');
});

test('差分对等长写入：回读发现旧线没删掉 ⇒ 回滚（删新铜 + 补回旧线）并抛出可识别错误', async () => {
  const geometry = diffPairBoard({ skewMil: 240 });
  const plan = planPairSkewCompensation({ geometry, pairs: [{ positive: 'USB_DP', negative: 'USB_DM' }] });
  const written = [];
  const deleted = [];
  const created = [];
  const execute = async (commandId, args) => {
    if (commandId === 'pcb.lines.delete') { deleted.push(...(args.primitiveIds ?? [])); return { result: { ok: true } }; }
    if (commandId === 'pcb.line.create') {
      const record = { id: `L-NEW-${created.length}`, net: args.net, layer: args.layer, x1: args.startX, y1: args.startY, x2: args.endX, y2: args.endY, width: args.lineWidth };
      created.push(record);
      return { result: { primitiveId: record.id } };
    }
    if (commandId === 'pcb.copper.read') {
      // 模拟真机：批量删除静默失败，L-P 还活着；新写的铜则在板上
      return { result: { lines: [...geometry.lines.map((line) => ({ ...line })), ...created.filter((line) => !deleted.includes(line.id))], vias: [], pads: [] } };
    }
    if (commandId === 'pcb.save') return { result: { saved: true } };
    throw new Error(`未预期的命令 ${commandId}`);
  };
  await assert.rejects(
    () => applyPairMatchingPlan({ execute, plan, geometry, dryRun: false, options: { writeSpacingMs: 0, readbackAttempts: 2, readbackSettleMs: 1 } }),
    (error) => error.code === 'ROUTING_READBACK_MISMATCH',
  );
  assert.ok(created.length, '必须真的写过新铜才能验证回滚');
  const rollbackDeletes = created.map((line) => line.id).filter((id) => deleted.includes(id));
  assert.equal(rollbackDeletes.length, created.length, `回滚必须删干净新铜：${JSON.stringify(deleted)}`);
  assert.ok(deleted.includes('L-P'), '回滚也要重新尝试删掉没删成功的旧线');
});

test('写入顺序：先过孔后走线（真机第 33 轮：先线后孔 → DRC 判 Connection Error/Track，布线写回必被回滚）', async () => {
  const geometry = {
    pads: [
      { designator: 'U1', pad: '1', net: 'N1', layer: 1, x: 0, y: 0, radius: 5 },
      { designator: 'U2', pad: '1', net: 'N1', layer: 12, x: 100, y: 0, radius: 5, throughHole: true },
    ],
    lines: [], vias: [],
  };
  const route = { ok: true, net: 'N1', viaInPad: true, from: { x: 0, y: 0, layer: 1 }, segments: [{ layer: 17, x1: 0, y1: 0, x2: 100, y2: 0 }], vias: [] };
  const calls = [];
  const written = { lines: [], vias: [] };
  const execute = async (commandId, args) => {
    calls.push(commandId);
    if (commandId === 'pcb.line.create') { written.lines.push({ id: `L${written.lines.length}`, net: args.net, layer: args.layer, x1: args.startX, y1: args.startY, x2: args.endX, y2: args.endY, width: args.lineWidth }); return { result: { primitiveId: `L${written.lines.length - 1}` } }; }
    if (commandId === 'pcb.via.create') { written.vias.push({ id: `V${written.vias.length}`, net: args.net, x: args.x, y: args.y, outerDiameter: args.diameter, hole: args.holeDiameter }); return { result: { primitiveId: `V${written.vias.length - 1}` } }; }
    if (commandId === 'pcb.copper.read') return { result: { lines: [...geometry.lines, ...written.lines], vias: [...geometry.vias, ...written.vias], pads: geometry.pads } };
    if (commandId === 'pcb.save') return { result: { saved: true } };
    throw new Error(`未预期的命令 ${commandId}`);
  };
  const result = await applyRoutingPlan({ execute, plan: { routes: [route] }, geometry, dryRun: false });
  assert.equal(result.dryRun, false);
  const viaAt = calls.indexOf('pcb.via.create');
  const lineAt = calls.indexOf('pcb.line.create');
  assert.ok(viaAt >= 0 && lineAt >= 0, `应同时写入过孔与走线：${calls.join(',')}`);
  assert.ok(viaAt < lineAt, `过孔必须先于走线创建：${calls.join(',')}`);
});

test('盘中孔间距判据按真机实测校准：0.5mm 间距器件 8/4mil 盘中孔到相邻焊盘 9.8mil 不算违规（第 34 轮）', () => {
  const geometry = {
    pads: [
      { designator: 'U1', pad: '1', net: 'N1', layer: 1, x: 0, y: 0, radius: 5, clearanceRadius: 34.4 },
      { designator: 'U1', pad: '2', net: 'N2', layer: 1, x: 19.7, y: 0, radius: 5.9, clearanceRadius: 26.27, shape: ['RECT', 11.8, 51.2, 0] },
      { designator: 'U1', pad: '9', net: 'N1', layer: 12, x: 100, y: 0, radius: 5, throughHole: true },
    ],
    lines: [], vias: [],
  };
  const route = { ok: true, net: 'N1', viaInPad: true, from: { x: 0, y: 0, layer: 1 }, segments: [{ layer: 17, x1: 0, y1: 0, x2: 100, y2: 0 }], vias: [] };
  const ok = verifyRoutingPlan({ plan: { routes: [route] }, geometry });
  assert.equal(ok.ok, true, `盘中孔到相邻焊盘 9.8mil 应放行：${JSON.stringify(ok.violations)}`);
  // 真贴上去（间距 1.1mil）仍然要拦
  const crowded = { ...geometry, pads: geometry.pads.map((pad) => (pad.pad === '2' ? { ...pad, x: 11 } : pad)) };
  const bad = verifyRoutingPlan({ plan: { routes: [route] }, geometry: crowded });
  assert.equal(bad.ok, false);
  assert.ok(bad.violations.some((entry) => entry.kind === 'via-in-pad-to-pad'));
});
