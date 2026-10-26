import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEasyEdaNetlist, summarizeErc, verifySchematic } from '../schematic.mjs';

/** 造一份与真机 EasyEDA 网表同形状的 JSON（v2.0.0：components{id:{props,pinInfoMap}} + nets{}）。 */
function netlist({ nets = {}, pinNets = {}, netRule = null } = {}) {
  const component = (designator, part, lcsc, pins) => ({
    props: { Designator: designator, Name: part, Manufacturer: 'ST', 'Manufacturer Part': part, Supplier: 'LCSC', 'Supplier Part': lcsc, Footprint: 'F1', Device: 'D1', Symbol: 'S1', 'Add into BOM': 'yes', 'Convert to PCB': 'yes' },
    pinInfoMap: Object.fromEntries(pins.map(([number, name]) => [number, { name, number, net: pinNets[`${designator}.${number}`] || '' }])),
  });
  return JSON.stringify({
    version: '2.0.0',
    components: {
      gge1: component('U1', 'STM32G071EBY6TR', 'C529344', [['A4', 'PB7'], ['A5', 'PB6']]),
      gge2: component('U2', 'INA226AIDGSR', 'C49851', [['1', 'A1'], ['4', 'SDA']]),
    },
    ...(netRule ? { designRule: { trackPhysics: {}, netRule: Object.fromEntries(netRule.map((name) => [name, { net: name, ruleMap: {} }])) } } : {}),
    ...(nets && Object.keys(nets).length ? { nets } : {}),
  });
}

test('网表解析：元件身份、引脚网名、网络条目、摘录哈希都要能拿到', () => {
  const parsed = parseEasyEdaNetlist(netlist({ nets: { SDA: { pins: ['gge1.A4', 'gge2.4'] } }, pinNets: { 'U1.A4': 'SDA', 'U2.4': 'SDA' } }));
  assert.equal(parsed.componentCount, 2);
  assert.equal(parsed.netCount, 1);
  assert.equal(parsed.components[0].designator, 'U1');
  assert.equal(parsed.components[0].supplierPart, 'C529344');
  assert.equal(parsed.components[0].manufacturerPart, 'STM32G071EBY6TR');
  assert.equal(parsed.components[1].pins.find((pin) => pin.number === '4').net, 'SDA');
  assert.match(parsed.digest, /^[a-f0-9]{64}$/);
});

test('假阳性回归：EasyEDA v2.0.0 网表**没有 nets 键**，网络在 designRule.netRule 与引脚网名里，绝不能因此判"0条网络"', () => {
  // 真机真实形状：components 里带 pinInfoMap.net，designRule.netRule 的键就是网络名，顶层没有 nets 键。
  const real = netlist({ pinNets: { 'U1.A4': 'SDA', 'U2.4': 'SDA', 'U1.A5': 'GND', 'U2.1': 'GND' }, netRule: ['SDA', 'GND', '3V3'] });
  assert.equal(JSON.parse(real).nets, undefined, '夹具必须真的没有 nets 键，否则测不到这个坑');
  const parsed = parseEasyEdaNetlist(real);
  assert.equal(parsed.netCount, 3, '三个来源合并后必须拿到 SDA/GND/3V3');
  assert.deepEqual(parsed.nets.map((net) => net.name).sort(), ['3V3', 'GND', 'SDA']);
  assert.equal(parsed.netsSource, 'designRule.netRule+pinInfoMap');
  assert.equal(parsed.nets.find((net) => net.name === 'SDA').pins.length, 2, '引脚要到网络里去');
  const result = verifySchematic({ netlistText: real });
  assert.equal(result.findings.some((item) => item.code === 'SCHEMATIC_NETLIST_NO_NETS'), false, '绝不能把正常网表判成没有网络');
  assert.equal(result.ready, true, '正常网表必须放行');
  // 3V3 只在规则表里声明、没有引脚使用 → 只算警告，不该阻断。
  assert.ok(result.findings.some((item) => item.code === 'SCHEMATIC_NET_NO_PINS' && item.severity === 'warning'));
});

test('三个来源都为空才判"没有网络"，且错误信息要带来源、不凭空归因', () => {
  const result = verifySchematic({ netlistText: netlist({ pinNets: {} }) });
  assert.equal(result.ready, false);
  const finding = result.findings.find((item) => item.code === 'SCHEMATIC_NETLIST_NO_NETS');
  assert.ok(finding, '必须报 SCHEMATIC_NETLIST_NO_NETS');
  assert.match(finding.message, /2个元件但0条网络（来源=none）/);
});

test('单引脚网络＝悬空网络（真机 CC1/CC2 各只有1脚，正是缺 5.1kΩ Rd 的机器化证据）', () => {
  const result = verifySchematic({ netlistText: netlist({ pinNets: { 'U1.A4': 'SDA', 'U2.4': 'SDA', 'U2.1': 'CC1' } }) });
  const finding = result.findings.find((item) => item.code === 'SCHEMATIC_NET_SINGLE_PIN');
  assert.ok(finding, '必须报 SCHEMATIC_NET_SINGLE_PIN');
  assert.match(finding.message, /CC1\(U2\.1\)/);
  assert.equal(result.ready, false);
});

test('与语义计划比对：元件缺失、立创料号不符、计划网络未落地，都要分别报出', () => {
  const plan = {
    components: [{ ref: 'U1', lcscId: 'C999999' }, { ref: 'U9', lcscId: 'C1' }],
    nets: [{ name: 'SDA' }, { name: '3V3' }],
  };
  const result = verifySchematic({ netlistText: netlist({ pinNets: { 'U1.A4': 'SDA' } }), plan });
  const codes = result.findings.map((item) => item.code);
  assert.ok(codes.includes('SCHEMATIC_COMPONENT_MISSING'), 'U9 缺失要报');
  assert.ok(codes.includes('SCHEMATIC_LCSC_MISMATCH'), '计划C999999≠原理图C529344 要报');
  assert.ok(codes.includes('SCHEMATIC_NET_MISSING'), '计划里的3V3在原理图网表里没有，要报');
  assert.equal(result.ready, false);
});

test('计划料号为空时不算"身份不符"（不制造假阳性）', () => {
  const result = verifySchematic({ netlistText: netlist({ pinNets: { 'U1.A4': 'SDA', 'U2.4': 'SDA' } }), plan: { components: [{ ref: 'U1' }], nets: [{ name: 'SDA' }] } });
  assert.equal(result.findings.some((item) => item.code === 'SCHEMATIC_LCSC_MISMATCH'), false);
  assert.deepEqual(result.findings.filter((item) => item.severity === 'blocking'), []);
  assert.equal(result.ready, true);
});

test('ERC：真机只有聚合计数时必须明说"不能当逐条修复依据"；有错误必须阻断', () => {
  const aggregate = summarizeErc([{ type: 'warn', count: 3 }]);
  assert.deepEqual({ ran: aggregate.ran, errors: aggregate.errors, warnings: aggregate.warnings, detailAvailable: aggregate.detailAvailable }, { ran: true, errors: 0, warnings: 3, detailAvailable: false });
  const withWarning = verifySchematic({ netlistText: netlist({ pinNets: { 'U1.A4': 'SDA', 'U2.4': 'SDA' } }), erc: [{ type: 'warn', count: 3 }] });
  assert.ok(withWarning.findings.some((item) => item.code === 'SCHEMATIC_ERC_WARNING' && item.severity === 'warning'));
  assert.ok(withWarning.findings.some((item) => item.code === 'SCHEMATIC_ERC_AGGREGATE_ONLY'));
  assert.equal(withWarning.ready, true, '警告不该阻断，但必须显示');
  const withError = verifySchematic({ netlistText: netlist({ pinNets: { 'U1.A4': 'SDA', 'U2.4': 'SDA' } }), erc: [{ type: 'error', count: 2 }] });
  assert.equal(withError.ready, false);
  assert.ok(withError.findings.some((item) => item.code === 'SCHEMATIC_ERC_ERROR' && item.severity === 'blocking'));
  const notRun = verifySchematic({ netlistText: netlist({ pinNets: { 'U1.A4': 'SDA', 'U2.4': 'SDA' } }) });
  assert.ok(notRun.findings.some((item) => item.code === 'SCHEMATIC_ERC_NOT_RUN' && item.severity === 'warning'));
});

test('网表无法解析时明确报错，绝不"当作空网表混过去"', () => {
  const result = verifySchematic({ netlistText: 'not-json' });
  assert.equal(result.parsed, null);
  assert.equal(result.ready, false);
  assert.equal(result.findings[0].code, 'NETLIST_UNPARSEABLE');
});

test('未连接引脚与匿名网络都要报出来（NC 与漏连在网表上无法区分，必须交给人判断）', () => {
  const text = netlist({ pinNets: { 'U1.A4': 'SDA', 'U2.4': 'SDA', 'U2.1': 'N$12' }, netRule: ['N$12'] });
  const parsed = parseEasyEdaNetlist(text);
  const result = verifySchematic({ netlistText: text });
  // U1.A5 没有网名；U2.1 挂在自动命名网络上
  const noPin = result.findings.find((item) => item.code === 'SCH_PIN_NO_NET');
  assert.ok(noPin, '必须报未连接引脚');
  assert.equal(noPin.severity, 'warning', '不能因为 NC 引脚就把整份原理图判死');
  assert.match(noPin.message, /U1\(1脚:A5\)/);
  const unnamed = result.findings.find((item) => item.code === 'SCH_NET_UNNAMED');
  assert.ok(unnamed, '必须报匿名网络');
  assert.match(unnamed.message, /N\$12/);
  assert.equal(parsed.netsSource, 'designRule.netRule+pinInfoMap');
});
