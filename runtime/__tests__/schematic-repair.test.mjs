import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PULLUP_REPAIRS, REPAIR_CODES, applySchematicRepair, diffRepairNetlist, findExistingBridge, layoutFreeRow, netlistToNets, ohmLabel, partMatchesRepair, planSchematicRepair } from '../schematic-repair.mjs';

const netlist = (nets) => ({
  components: Object.fromEntries(Object.entries(nets).flatMap(([designator, pins]) => Object.entries(pins).map(([number, net]) => [`${designator}-${number}`, { props: { Designator: designator }, pinInfoMap: { [number]: { number, net } } }]))),
});

const BEFORE = netlist({ J1: { A5: 'CC1', B5: 'CC2', A1B12: 'GND' }, U1: { A4: 'SDA', B3: 'SCL', C5: '3V3', D5: 'GND' } });
const DEVICE = { libraryUuid: 'lib-0603', uuid: 'dev-5k1' };

test('网表解析：只认 pinInfoMap 的 net，空网络不入表', () => {
  const nets = netlistToNets(netlist({ U1: { A1: '', A2: 'SDA' } }));
  assert.deepEqual([...nets.keys()], ['SDA']);
  assert.deepEqual([...nets.get('SDA')], ['U1.A2']);
});

test('计划：每个修复 = 1 个元件 + 2 个网络端口，并给出预期的网络增量和"当前悬空"证据', () => {
  const plan = planSchematicRepair({
    netlist: BEFORE,
    repairs: [
      { id: 'Rd1', net: 'CC1', otherNet: 'GND', valueOhm: 5100, device: DEVICE, position: { x: 400, y: 620 } },
      { id: 'Rp1', net: 'SDA', otherNet: '3V3', valueOhm: 4700, device: DEVICE, position: { x: 700, y: 620 } },
    ],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.operations.filter((item) => item.type === 'component.create').length, 2);
  assert.equal(plan.operations.filter((item) => item.type === 'netPort.create').length, 4);
  assert.deepEqual(plan.expectedGain, { CC1: 1, GND: 1, SDA: 1, '3V3': 1 });
  assert.match(plan.findings.find((item) => item.message.includes('Rd1')).message, /当前 CC1 有 1 个引脚/);
  // 目标网络不存在 → 阻断（不能凭空造一个同名网络）
  const bad = planSchematicRepair({ netlist: BEFORE, repairs: [{ id: 'Rx', net: 'NOPE', otherNet: 'GND', valueOhm: 1, device: DEVICE, position: { x: 1, y: 1 } }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.findings.some((item) => item.code === REPAIR_CODES.TARGET_NET_MISSING));
});

test('未标注元件（位号都是 R?）不能因为去重被误判：两个 R? 各挂一个脚到 GND，必须算 +2', () => {
  const after = {
    components: {
      'orig-1': { props: { Designator: 'U1' }, pinInfoMap: { D5: { number: 'D5', net: 'GND' }, A5: { number: 'A5', net: 'CC1' } } },
      'orig-2': { props: { Designator: 'J1' }, pinInfoMap: { B5: { number: 'B5', net: 'CC2' } } },
      'new-1': { props: { Designator: 'R?' }, pinInfoMap: { 1: { number: '1', net: 'GND' }, 2: { number: '2', net: 'CC1' } } },
      'new-2': { props: { Designator: 'R?' }, pinInfoMap: { 1: { number: '1', net: 'GND' }, 2: { number: '2', net: 'CC2' } } },
    },
  };
  const before = { components: { 'orig-1': { props: { Designator: 'U1' }, pinInfoMap: { D5: { number: 'D5', net: 'GND' }, A5: { number: 'A5', net: 'CC1' } } }, 'orig-2': { props: { Designator: 'J1' }, pinInfoMap: { B5: { number: 'B5', net: 'CC2' } } } } };
  const diff = diffRepairNetlist({ before, after, expectedGain: { GND: 2, CC1: 1, CC2: 1 }, createdPins: [], identityComplete: false });
  assert.equal(diff.ok, true, JSON.stringify(diff.unexpected));
  assert.deepEqual(diff.gained.GND, ['R?.1', 'R?.1'], '同一个 R? 的两个引脚必须按计数算 2 个，不能去重成 1 个');
});

test('复核：只多出该多出的引脚才算过', () => {
  const good = diffRepairNetlist({
    before: BEFORE,
    after: netlist({ J1: { A5: 'CC1', B5: 'CC2', A1B12: 'GND' }, U1: { A4: 'SDA', B3: 'SCL', C5: '3V3', D5: 'GND' }, R1: { 1: 'CC1', 2: 'GND' } }),
    expectedGain: { CC1: 1, GND: 1 },
    createdPins: ['R1.1', 'R1.2'],
  });
  assert.equal(good.ok, true);
  assert.equal(good.summary.lostPins, 0);

  // 事故 1：电阻两个脚都落在同一个网络上 → 等于短路，必须判不合格
  const shorted = diffRepairNetlist({
    before: BEFORE,
    after: netlist({ J1: { A5: 'CC1', B5: 'CC2', A1B12: 'GND' }, U1: { A4: 'SDA', B3: 'SCL', C5: '3V3', D5: 'GND' }, R1: { 1: 'CC1', 2: 'CC1' } }),
    expectedGain: { CC1: 1, GND: 1 },
    createdPins: ['R1.1', 'R1.2'],
  });
  assert.equal(shorted.ok, false);
  assert.ok(shorted.unexpected.length >= 1);

  // 事故 2：新引脚出现在计划外的网络里（挂错了）
  const misplaced = diffRepairNetlist({
    before: BEFORE,
    after: netlist({ J1: { A5: 'CC1', B5: 'CC2', A1B12: 'GND' }, U1: { A4: 'SDA', B3: 'SCL', C5: '3V3', D5: 'GND' }, R1: { 1: 'CC1', 2: 'VBUS' } }),
    expectedGain: { CC1: 1, GND: 1 },
    createdPins: ['R1.1', 'R1.2'],
  });
  assert.equal(misplaced.ok, false);

  // 事故 3：原有引脚丢了（把已有连接改坏了）
  const broken = diffRepairNetlist({
    before: BEFORE,
    after: netlist({ J1: { A5: 'CC1', B5: 'CC2', A1B12: 'GND' }, U1: { B3: 'SCL', C5: '3V3', D5: 'GND' }, R1: { 1: 'CC1', 2: 'GND' } }),
    expectedGain: { CC1: 1, GND: 1 },
    createdPins: ['R1.1', 'R1.2'],
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.summary.lostPins, 1);
});

/** 记录全部桥命令的假桥；netlistSequence 决定第 1/2/3 次 readNetlist 返回什么。 */
function fakeBridge({ netlistSequence, createFails = false, deleteEffective = true }) {
  const calls = [];
  let readIndex = 0;
  let deleted = false;
  let createdOk = 0;
  const execute = async (commandId, args = {}, options = {}) => {
    calls.push({ commandId, args, options });
    if (commandId === 'document.source.read') return { result: 'source-v1' };
    if (commandId === 'document.source.restore') return { result: true };
    if (commandId === 'schematic.component.create') {
      if (createFails) return { result: null };
      createdOk += 1;
      return { result: { primitiveId: `new-${createdOk}` } };
    }
    if (commandId === 'schematic.netPort.create') return { result: { primitiveId: `port-${calls.filter((c) => c.commandId === 'schematic.netPort.create').length}` } };
    if (commandId === 'schematic.save') return { result: true };
    if (commandId === 'schematic.component.delete') { deleted = true; return { result: true }; }
    if (commandId === 'schematic.components') {
      // 第一次读（修复前）看到的是原设计；创建后能看到新元件；删除后又回到原设计——用于核实回滚是否真的生效
      // deleteEffective=false 用来模拟"删除没生效"（真机 document.source.restore 就是这个下场）
      const alive = deleted && deleteEffective ? 0 : createdOk;
      const created = Array.from({ length: alive }, (_, index) => ({ primitiveId: `new-${index + 1}`, designator: `R${index + 1}` }));
      const pins = Object.fromEntries(created.map((component, index) => [component.primitiveId, [{ pinNumber: '1', x: 100 + index * 200, y: 200 }, { pinNumber: '2', x: 140 + index * 200, y: 200 }]]));
      return { result: { components: [{ primitiveId: 'orig-1', designator: 'U1' }, ...created], pins } };
    }
    throw Object.assign(new Error(`离线：不应触发 ${commandId}`), { code: 'EDA_OFFLINE' });
  };
  return { execute, calls, readNetlist: async () => netlistSequence[Math.min(readIndex++, netlistSequence.length - 1)] };
}

const planTwo = () => planSchematicRepair({
  netlist: BEFORE,
  repairs: [
    { id: 'Rd1', net: 'CC1', otherNet: 'GND', valueOhm: 5100, device: DEVICE, position: { x: 400, y: 620 } },
    { id: 'Rd2', net: 'CC2', otherNet: 'GND', valueOhm: 5100, device: DEVICE, position: { x: 560, y: 620 } },
  ],
});

test('执行：先建元件→统一读回引脚→端口落在引脚坐标上→保存；全程受控授权', async () => {
  const after = netlist({ J1: { A5: 'CC1', B5: 'CC2', A1B12: 'GND' }, U1: { A4: 'SDA', B3: 'SCL', C5: '3V3', D5: 'GND' }, R1: { 1: 'CC1', 2: 'GND' }, R2: { 1: 'CC2', 2: 'GND' } });
  const bridge = fakeBridge({ netlistSequence: [BEFORE, after, after] });
  const result = await applySchematicRepair({ execute: bridge.execute, plan: planTwo(), readNetlist: bridge.readNetlist });
  assert.equal(result.ok, true);
  const ids = bridge.calls.map((call) => call.commandId);
  assert.equal(ids.includes('document.source.read'), true);
  assert.equal(ids.filter((id) => id === 'schematic.component.create').length, 2);
  assert.equal(ids.filter((id) => id === 'schematic.netPort.create').length, 4);
  assert.ok(ids.includes('schematic.save'));
  // 端口坐标必须等于读回的引脚坐标，且写命令都带授权、快照读取带敏感读授权
  const ports = bridge.calls.filter((call) => call.commandId === 'schematic.netPort.create');
  assert.deepEqual(ports.map((call) => [call.args.net, call.args.x, call.args.y]), [['CC1', 100, 200], ['GND', 140, 200], ['CC2', 300, 200], ['GND', 340, 200]]);
  // 真机事实：addIntoPcb=false 的元件不进 EasyEDA 网表，所以计划默认必须为 true
  assert.ok(bridge.calls.filter((call) => call.commandId === 'schematic.component.create').every((call) => call.args.addIntoPcb === true));
  assert.ok(ports.every((call) => call.options.allowWrite === true));
  assert.equal(bridge.calls.find((call) => call.commandId === 'document.source.read').options.allowSensitiveRead, true);
  assert.deepEqual(result.diff.gained, { CC1: ['R1.1'], CC2: ['R2.1'], GND: ['R1.2', 'R2.2'] });
});

test('复核不过 → 必须回滚到快照，并且报出"改坏了什么"', async () => {
  // 第 2 次网表：R2 的两只脚都落在 CC2（等于把 CC2 短到自己），与计划不符
  const broken = netlist({ J1: { A5: 'CC1', B5: 'CC2', A1B12: 'GND' }, U1: { A4: 'SDA', B3: 'SCL', C5: '3V3', D5: 'GND' }, R1: { 1: 'CC1', 2: 'GND' }, R2: { 1: 'CC2', 2: 'CC2' } });
  const bridge = fakeBridge({ netlistSequence: [BEFORE, broken, BEFORE] });
  await assert.rejects(
    () => applySchematicRepair({ execute: bridge.execute, plan: planTwo(), readNetlist: bridge.readNetlist }),
    (error) => {
      assert.equal(error.code, REPAIR_CODES.NETLIST_UNEXPECTED_CHANGE);
      assert.equal(error.rolledBack, true);
      assert.equal(error.rollbackClean, true, '回滚后图元集合必须与修复前一致');
      return true;
    },
  );
  const ids = bridge.calls.map((call) => call.commandId);
  assert.ok(ids.includes('schematic.component.delete'), '验证不过必须按图元 ID 删除回滚');
  assert.equal(ids.filter((id) => id === 'schematic.save').length, 2, '先保存才能复核；回滚后再保存一次');
});

test('放不上元件 / 空快照 / 空计划 → 明确报错，绝不"当作成功"', async () => {
  const emptyPlan = { operations: [], expectedGain: {} };
  await assert.rejects(() => applySchematicRepair({ execute: fakeBridge({ netlistSequence: [BEFORE] }).execute, plan: emptyPlan, readNetlist: async () => BEFORE }), (error) => error.code === REPAIR_CODES.NO_OPERATIONS);

  const bridge = fakeBridge({ netlistSequence: [BEFORE], createFails: true });
  await assert.rejects(() => applySchematicRepair({ execute: bridge.execute, plan: planTwo(), readNetlist: bridge.readNetlist }), (error) => {
    assert.equal(error.code, REPAIR_CODES.COMPONENT_CREATE_FAILED);
    assert.equal(error.rolledBack, true);
    return true;
  });

  const noSnapshot = async (commandId, args, options) => (commandId === 'document.source.read' ? { result: '' } : { result: true });
  await assert.rejects(() => applySchematicRepair({ execute: noSnapshot, plan: planTwo(), readNetlist: async () => BEFORE }), (error) => error.code === REPAIR_CODES.SNAPSHOT_EMPTY);
});

test('回滚没清干净 → 必须报 ROLLBACK_INCOMPLETE，绝不许谎称已回滚', async () => {
  const broken = netlist({ J1: { A5: 'CC1', B5: 'CC2', A1B12: 'GND' }, R2: { 1: 'CC2', 2: 'CC2' } });
  // 组件读回永远带着"多出来的图元"：模拟删除没生效（真机 document.source.restore 就是这个下场）
  const bridge = fakeBridge({ netlistSequence: [BEFORE, broken, BEFORE], deleteEffective: false });
  await assert.rejects(() => applySchematicRepair({ execute: bridge.execute, plan: planTwo(), readNetlist: bridge.readNetlist }), (error) => {
    assert.equal(error.code, REPAIR_CODES.ROLLBACK_INCOMPLETE);
    assert.equal(error.rollbackClean, false);
    return true;
  });
});

test('dry-run 只出计划不写任何东西', async () => {
  const bridge = fakeBridge({ netlistSequence: [BEFORE] });
  const result = await applySchematicRepair({ execute: bridge.execute, plan: planTwo(), readNetlist: bridge.readNetlist, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(bridge.calls.length, 0, 'dry-run 不许发出任何桥命令');
});

test('落位：按现有图元包围盒下缘排开，间距固定——重叠会造成引脚重合（短路）', () => {
  const row = layoutFreeRow({ components: [{ x: 310, y: 360 }, { x: 1500, y: 470 }, { x: 490, y: 255 }], count: 4, spacingMm: 240, startX: 400, marginMm: 80 });
  assert.deepEqual(row, [{ x: 400, y: 550 }, { x: 640, y: 550 }, { x: 880, y: 550 }, { x: 1120, y: 550 }]);
  assert.equal(layoutFreeRow({ components: [], count: 1 })[0].y, 80);
});

test('默认修复清单与真机验收发现的设计缺陷一一对应（CC1/CC2 → GND 5.1k；SDA/SCL → 3V3 4.7k）', () => {
  assert.deepEqual(DEFAULT_PULLUP_REPAIRS.map((r) => [r.net, r.otherNet, r.valueOhm]), [['CC1', 'GND', 5100], ['CC2', 'GND', 5100], ['SDA', '3V3', 4700], ['SCL', '3V3', 4700]]);
});

test('阻值工程写法：5100 → 5.1K、4700 → 4.7K、非法值为 null', () => {
  assert.equal(ohmLabel(5100), '5.1K');
  assert.equal(ohmLabel(4700), '4.7K');
  assert.equal(ohmLabel(1_000_000), '1M');
  assert.equal(ohmLabel(0), null);
  assert.equal(ohmLabel(''), null);
});

test('用真机网表属性认器件：Value=5.1kΩ / Manufacturer Part=0603WAF5101T5E 都能认出 5.1k 修复项', () => {
  const real = { Value: '5.1kΩ', 'Manufacturer Part': '0603WAF5101T5E', 'Supplier Part': 'C23186', DeviceName: '0603WAF5101T5E', Description: '电阻类型:厚膜电阻;阻值:5.1kΩ' };
  assert.equal(partMatchesRepair(real, { valueOhm: 5100, mpnKeyword: '5101' }), true);
  assert.equal(partMatchesRepair(real, { valueOhm: 4700, mpnKeyword: '4701' }), false);
  assert.equal(partMatchesRepair({}, { valueOhm: 5100 }), false);
});

test('幂等：已经跨着合格电阻的网络不再重复新增（并联会把 CC 电压从 0.417V 拉到 0.2V）', () => {
  const netlist = {
    components: {
      'c-j1': { props: { Designator: 'J1' }, pinInfoMap: { A5: { number: 'A5', net: 'CC1' }, B5: { number: 'B5', net: 'CC2' } } },
      'c-r1': { props: { Designator: 'R1', Value: '5.1kΩ', 'Manufacturer Part': '0603WAF5101T5E' }, pinInfoMap: { 1: { number: '1', net: 'GND' }, 2: { number: '2', net: 'CC1' } } },
      'c-r2': { props: { Designator: 'R2', Value: '5.1kΩ', 'Manufacturer Part': '0603WAF5101T5E' }, pinInfoMap: { 1: { number: '1', net: 'GND' }, 2: { number: '2', net: 'CC2' } } },
    },
  };
  const bridge = findExistingBridge(netlist, 'CC1', 'GND');
  assert.deepEqual(bridge.map((item) => item.designator), ['R1']);
  const plan = planSchematicRepair({
    netlist,
    repairs: DEFAULT_PULLUP_REPAIRS.slice(0, 2).map((repair, index) => ({ ...repair, device: { libraryUuid: 'lib', uuid: 'dev' }, position: { x: 400 + index * 240, y: 550 } })),
  });
  assert.equal(plan.operations.length, 0, '已经修好的两个 CC 网络不许再写任何东西');
  assert.equal(plan.satisfied.length, 2);
  assert.deepEqual(plan.satisfied.map((item) => item.designator), ['R1', 'R2']);
  assert.ok(plan.findings.some((finding) => finding.code === 'REPAIR_ALREADY_SATISFIED'));
  assert.equal(plan.ok, true, '“已经修好”是合格结论，不能报成失败');
});

test('跨接但阻值不明的器件：不自动并联，给出警告并交给人工（宁可不动，不可改坏）', () => {
  const netlist = {
    components: {
      'c-j1': { props: { Designator: 'J1' }, pinInfoMap: { A5: { number: 'A5', net: 'CC1' } } },
      'c-d1': { props: { Designator: 'D1', Value: '' }, pinInfoMap: { 1: { number: '1', net: 'GND' }, 2: { number: '2', net: 'CC1' } } },
    },
  };
  const plan = planSchematicRepair({ netlist, repairs: [{ ...DEFAULT_PULLUP_REPAIRS[0], device: { libraryUuid: 'lib', uuid: 'dev' }, position: { x: 400, y: 550 } }] });
  assert.equal(plan.operations.length, 0);
  assert.ok(plan.findings.some((finding) => finding.code === 'REPAIR_EXISTING_BRIDGE_UNKNOWN' && finding.severity === 'warning'));
});

test('多脚 IC 跨着两个网络不算"已有上拉"：否则该加的上拉会被幂等跳过，设计永远修不好', () => {
  const netlist = {
    components: {
      'c-u1': { props: { Designator: 'U1' }, pinInfoMap: { 1: { number: '1', net: 'SDA' }, 2: { number: '2', net: '3V3' }, 3: { number: '3', net: 'GND' }, 4: { number: '4', net: 'SCL' } } },
    },
  };
  assert.deepEqual(findExistingBridge(netlist, 'SDA', '3V3'), []);
  const plan = planSchematicRepair({ netlist, repairs: [{ ...DEFAULT_PULLUP_REPAIRS[2], device: { libraryUuid: 'lib', uuid: 'dev' }, position: { x: 400, y: 550 } }] });
  assert.equal(plan.operations.length, 3, '两脚器件才算跨接，多脚 IC 不算');
  assert.equal(plan.satisfied.length, 0);
});

test('幂等命中时不需要器件身份：已经修好的项不能因为“没查库”就被判成阻断', () => {
  const netlist = {
    components: {
      'c-j1': { props: { Designator: 'J1' }, pinInfoMap: { A5: { number: 'A5', net: 'CC1' } } },
      'c-r1': { props: { Designator: 'R1', Value: '5.1kΩ', 'Manufacturer Part': '0603WAF5101T5E' }, pinInfoMap: { 1: { number: '1', net: 'GND' }, 2: { number: '2', net: 'CC1' } } },
    },
  };
  const plan = planSchematicRepair({ netlist, repairs: [{ ...DEFAULT_PULLUP_REPAIRS[0], device: null, position: { x: 400, y: 550 } }] });
  assert.equal(plan.ok, true, JSON.stringify(plan.findings));
  assert.equal(plan.satisfied.length, 1);
  assert.equal(plan.operations.length, 0);
  assert.ok(!plan.findings.some((finding) => finding.severity === 'blocking'), '幂等命中不该报阻断');
});

test('执行阶段：netPort 的 rotation 必须按读回引脚朝外方向算（计划阶段可先留 0），而不是一律 0', async () => {
  const after = netlist({ J1: { A5: 'CC1', B5: 'CC2', A1B12: 'GND' }, U1: { A4: 'SDA', B3: 'SCL', C5: '3V3', D5: 'GND' }, R1: { 1: 'CC1', 2: 'GND' }, R2: { 1: 'CC2', 2: 'GND' } });
  const bridge = fakeBridge({ netlistSequence: [BEFORE, after, after] });
  const plan = planTwo();
  // 计划阶段还不知道引脚坐标，rotation 先留 0 是允许的；执行阶段必须换成算出来的值
  assert.ok(plan.operations.filter((item) => item.type === 'netPort.create').every((item) => item.args.rotation === 0));
  const result = await applySchematicRepair({ execute: bridge.execute, plan, readNetlist: bridge.readNetlist });
  assert.equal(result.ok, true);
  const ports = bridge.calls.filter((call) => call.commandId === 'schematic.netPort.create');
  // 假桥里 R1 的引脚在 100/140、质心 120：1 脚在左侧 → 180，2 脚在右侧 → 0
  assert.deepEqual(ports.map((call) => [call.args.net, call.args.rotation]), [['CC1', 180], ['GND', 0], ['CC2', 180], ['GND', 0]]);
  assert.ok(ports.every((call) => [0, 90, 180, 270].includes(call.args.rotation)), 'rotation 只许是四方向之一');
  assert.ok(ports.some((call) => call.args.rotation !== 0), '读回引脚在左侧时必须朝左，不能一律 0');
  // 朝向只是可读性，不改变坐标/写入授权/网表复核结果
  assert.deepEqual(ports.map((call) => [call.args.net, call.args.x, call.args.y]), [['CC1', 100, 200], ['GND', 140, 200], ['CC2', 300, 200], ['GND', 340, 200]]);
  assert.ok(ports.every((call) => call.options.allowWrite === true));
  assert.deepEqual(result.portLabels.map((item) => item.rotation), [180, 0, 180, 0]);
  assert.equal(result.diff.ok, true);
});
