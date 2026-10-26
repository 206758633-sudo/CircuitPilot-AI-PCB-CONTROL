import assert from 'node:assert/strict';
import test from 'node:test';
import { NET_CONNECT_CODES, applyNetConnect, diffPinNets, indexNetlist, planNetConnect, rollbackNetConnect as rollbackNetConnect2, verifyNetConnect } from '../net-connect.mjs';

const netlist = () => ({
  components: {
    gge1: {
      props: { Designator: 'U1', 'Unique ID': 'gge1' },
      pinInfoMap: { A4: { net: '' }, A5: { net: 'GND' }, B1: { net: '3V3' } },
    },
    gge2: {
      props: { Designator: 'R1', 'Unique ID': 'gge2' },
      pinInfoMap: { 1: { net: '' }, 2: { net: '3V3' } },
    },
  },
  designRule: { netRule: { GND: { net: 'GND' } } },
});

const components = () => ([{ primitiveId: 'p-u1', designator: 'U1', uniqueId: 'gge1', componentType: 'part' }]);
const pins = () => ({ 'p-u1': [
  { pinNumber: 'A4', x: 100, y: 200 },
  { pinNumber: 'A5', x: 110, y: 200 },
  { pinNumber: 'B1', x: 120, y: 210 },
] });

test('计划：解析既有元件引脚坐标；已在目标网络算满足；已属其它网络必须拒绝', () => {
  const plan = planNetConnect({ connections: [{ net: 'SDA', pins: [{ componentPrimitiveId: 'p-u1', pinNumber: 'A4' }] }], components: components(), pins: pins(), netlist: netlist() });
  assert.equal(plan.ok, true);
  assert.equal(plan.operations.length, 1);
  assert.deepEqual(plan.operations[0].args, { portType: 'BI', net: 'SDA', x: 100, y: 200 });
  assert.equal(plan.planHash.length, 64);

  const satisfied = planNetConnect({ connections: [{ net: 'GND', pins: [{ componentPrimitiveId: 'p-u1', pinNumber: 'A5' }] }], components: components(), pins: pins(), netlist: netlist() });
  assert.equal(satisfied.ok, true);
  assert.equal(satisfied.operations.length, 0);
  assert.equal(satisfied.satisfied.length, 1);

  const refuse = planNetConnect({ connections: [{ net: 'SDA', pins: [{ componentPrimitiveId: 'p-u1', pinNumber: 'A5' }] }], components: components(), pins: pins(), netlist: netlist() });
  assert.equal(refuse.ok, false);
  assert.equal(refuse.findings[0].code, NET_CONNECT_CODES.PIN_ALREADY_ON_OTHER_NET);
  assert.equal(refuse.operations.length, 0);
});

test('计划：不存在的图元/引脚/网表身份一律 fail-closed，不产生写入操作', () => {
  const missingComponent = planNetConnect({ connections: [{ net: 'SDA', pins: [{ componentPrimitiveId: 'nope', pinNumber: 'A4' }] }], components: components(), pins: pins(), netlist: netlist() });
  assert.equal(missingComponent.ok, false);
  assert.equal(missingComponent.findings[0].code, NET_CONNECT_CODES.PIN_NOT_FOUND);

  const missingPin = planNetConnect({ connections: [{ net: 'SDA', pins: [{ componentPrimitiveId: 'p-u1', pinNumber: 'ZZ' }] }], components: components(), pins: pins(), netlist: netlist() });
  assert.equal(missingPin.ok, false);
  assert.equal(missingPin.findings[0].code, NET_CONNECT_CODES.PIN_NOT_FOUND);

  const unknownIdentity = planNetConnect({
    connections: [{ net: 'SDA', pins: [{ componentPrimitiveId: 'p-u1', pinNumber: 'A4' }] }],
    components: [{ primitiveId: 'p-u1', designator: 'U9', uniqueId: 'gge9' }], pins: pins(), netlist: netlist(),
  });
  assert.equal(unknownIdentity.ok, false);
  assert.equal(unknownIdentity.findings[0].code, NET_CONNECT_CODES.PIN_IDENTITY_UNRESOLVED);
});

test('执行：写端口→保存→读回目标引脚网络正确才通过；任何失败都不重试写入', async () => {
  const baseline = netlist();
  let pending = [];
  const calls = [];
  const execute = async (commandId, args, options) => {
    calls.push({ commandId, args, options });
    if (commandId === 'schematic.netPort.create') { pending.push({ uniqueId: 'gge1', pinNumber: 'A4', net: args.net }); return { result: { primitiveId: `port-${pending.length}` } }; }
    if (commandId === 'schematic.save') return { result: true };
    if (commandId === 'schematic.component.delete') { pending = []; return { result: true }; }
    throw Object.assign(new Error(`未知命令 ${commandId}`), { code: 'UNKNOWN_COMMAND' });
  };
  const readNetlist = async () => {
    const copy = JSON.parse(JSON.stringify(baseline));
    for (const port of pending) copy.components[port.uniqueId].pinInfoMap[port.pinNumber].net = port.net;
    return copy;
  };
  const plan = planNetConnect({ connections: [{ net: 'SDA', pins: [{ componentPrimitiveId: 'p-u1', pinNumber: 'A4' }] }], components: components(), pins: pins(), netlist: baseline });
  const applied = await applyNetConnect({ execute, plan, beforeNetlist: baseline, readNetlist });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.createdPrimitiveIds, ['port-1']);
  assert.equal(applied.verification.ok, true);
  assert.equal(calls.filter((item) => item.commandId === 'schematic.netPort.create').length, 1);
  assert.equal(calls.find((item) => item.commandId === 'schematic.netPort.create').options.allowWrite, true);
});

test('执行：写入"静默无效"（读回没变）必须回滚删端口+保存+再核对，并以失败收场', async () => {
  const baseline = netlist();
  let deleted = null;
  const calls = [];
  const execute = async (commandId, args) => {
    calls.push({ commandId, args });
    if (commandId === 'schematic.netPort.create') return { result: { primitiveId: 'port-1' } };
    if (commandId === 'schematic.save') return { result: true };
    if (commandId === 'schematic.component.delete') { deleted = args.primitiveIds; return { result: true }; }
    throw Object.assign(new Error(`未知命令 ${commandId}`), { code: 'UNKNOWN_COMMAND' });
  };
  const plan = planNetConnect({ connections: [{ net: 'SDA', pins: [{ componentPrimitiveId: 'p-u1', pinNumber: 'A4' }] }], components: components(), pins: pins(), netlist: baseline });
  await assert.rejects(
    () => applyNetConnect({ execute, plan, beforeNetlist: baseline, readNetlist: async () => baseline }),
    (error) => {
      assert.equal(error.code, NET_CONNECT_CODES.VERIFY_FAILED);
      assert.equal(error.details.rolledBack, true);
      assert.equal(error.details.verification.missing.length, 1);
      return true;
    },
  );
  assert.deepEqual(deleted, ['port-1']);
  assert.equal(calls.filter((item) => item.commandId === 'schematic.save').length, 2, '保存一次用于写入，一次用于回滚');
});

test('核对：计划外引脚被赋网（潜在短路）与既有网络丢引脚都必须判失败', () => {
  const before = new Map([['gge1.B1', '3V3'], ['gge1.A5', 'GND']]);
  const clean = verifyNetConnect({ beforePins: before, afterPins: new Map([...before, ['gge1.A4', 'SDA']]), operations: [{ uniqueId: 'gge1', pinNumber: 'A4', net: 'SDA' }] });
  assert.equal(clean.ok, true);
  const stray = verifyNetConnect({ beforePins: before, afterPins: new Map([...before, ['gge1.A4', 'SDA'], ['gge2.1', '3V3']]), operations: [{ uniqueId: 'gge1', pinNumber: 'A4', net: 'SDA' }] });
  assert.equal(stray.ok, false);
  assert.match(stray.unexpected[0].why, /计划外引脚/);
  const lost = verifyNetConnect({ beforePins: before, afterPins: new Map([['gge1.B1', '3V3'], ['gge1.A4', 'SDA']]), operations: [{ uniqueId: 'gge1', pinNumber: 'A4', net: 'SDA' }] });
  assert.equal(lost.ok, false);
  assert.match(lost.unexpected[0].why, /既有网络引脚/);
  assert.equal(diffPinNets(before, before).ok, true);
  assert.equal(indexNetlist(netlist()).pinNets.get('gge1.A5'), 'GND');
});

test('悬空引脚候选：只挑网表里无网的已标注器件引脚，排序确定；测试网络按每 2 脚一组', async () => {
  const { collectDanglingPins, buildTestConnections } = await import('../net-connect.mjs');
  const rollbackNetConnect = rollbackNetConnect2;
  const candidates = collectDanglingPins({ components: [...components(), { primitiveId: 'p-r1', designator: 'R1', uniqueId: 'gge2', componentType: 'part' }, { primitiveId: 'p-nf', componentType: 'netflag' }], pins: { ...pins(), 'p-r1': [{ pinNumber: '1', x: 5, y: 6 }, { pinNumber: '2', x: 7, y: 8, noConnected: true }] }, netlist: netlist(), limit: 10 });
  assert.deepEqual(candidates.map((item) => `${item.designator}.${item.pinNumber}`), ['R1.1', 'U1.A4']);
  const connections = buildTestConnections(candidates, { prefix: 'CP_T', perNet: 2, maxNets: 2 });
  assert.equal(connections.length, 1);
  assert.equal(connections[0].net, 'CP_T_1');
  assert.equal(connections[0].pins.length, 2);

  const calls = [];
  let present = [{ primitiveId: 'keep' }, { primitiveId: 'port-1' }];
  const execute = async (commandId, args) => {
    calls.push({ commandId, args });
    if (commandId === 'schematic.component.delete') { present = present.filter((item) => !args.primitiveIds.includes(item.primitiveId)); return { result: true }; }
    if (commandId === 'schematic.save') return { result: true };
    throw Object.assign(new Error(`未知命令 ${commandId}`), { code: 'UNKNOWN_COMMAND' });
  };
  const rollback = await rollbackNetConnect({
    execute,
    loadComponents: async () => ({ components: present }),
    readNetlist: async () => netlist(),
    primitiveIds: ['port-1', 'port-2'],
    targets: [{ uniqueId: 'gge1', pinNumber: 'A4' }],
  });
  assert.equal(rollback.ok, true);
  assert.deepEqual(rollback.remaining, []);
  assert.equal(rollback.targetsRestored, true);
  assert.deepEqual(calls.map((item) => item.commandId), ['schematic.component.delete', 'schematic.save']);
});

test('执行：写入中止但端口其实已建出来 → 读回按网络名+坐标识别，不重复写、不误判失败', async () => {
  const baseline = netlist();
  let createdPort = null;
  let attempts = 0;
  const execute = async (commandId, args) => {
    if (commandId === 'schematic.netPort.create') {
      attempts += 1;
      if (attempts === 1) {
        // 真机现象：请求已派发、端口已创建，但调用方拿到 AbortError
        createdPort = { primitiveId: 'port-aborted', componentType: 'netport', net: args.net, x: args.x, y: args.y };
        throw Object.assign(new Error('This operation was aborted'), { code: 20 });
      }
      return { result: { primitiveId: 'port-duplicate' } };
    }
    if (commandId === 'schematic.save') return { result: true };
    throw Object.assign(new Error(`未知命令 ${commandId}`), { code: 'UNKNOWN_COMMAND' });
  };
  const plan = planNetConnect({ connections: [{ net: 'SDA', pins: [{ componentPrimitiveId: 'p-u1', pinNumber: 'A4' }] }], components: components(), pins: pins(), netlist: baseline });
  const applied = await applyNetConnect({
    execute, plan, beforeNetlist: baseline,
    loadComponents: async () => ({ components: createdPort ? [createdPort] : [] }),
    readNetlist: async () => {
      const copy = JSON.parse(JSON.stringify(baseline));
      if (createdPort) copy.components.gge1.pinInfoMap.A4.net = createdPort.net;
      return copy;
    },
  });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.createdPrimitiveIds, ['port-aborted']);
  assert.equal(attempts, 1, '读回已证实端口存在，绝不能再写第二个');
});

test('回滚幂等：图元已被上一次回滚删掉时，不能再调 delete/save，也不能把"已复原"误报成失败', async () => {
  const calls = [];
  const execute = async (commandId) => { calls.push(commandId); return { result: true }; };
  const rollback = await rollbackNetConnect2({
    execute,
    loadComponents: async () => ({ components: [{ primitiveId: 'keep' }] }),
    readNetlist: async () => netlist(),
    primitiveIds: ['port-gone'],
    targets: [{ uniqueId: 'gge1', pinNumber: 'A4' }],
  });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.deleted, true);
  assert.deepEqual(calls, [], '已不存在就不该再写盘');
});
