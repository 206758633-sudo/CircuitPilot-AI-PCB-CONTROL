import assert from 'node:assert/strict';
import test from 'node:test';

import { NET_CONNECTIVITY_CODES, auditNetConnectivity, parseEasyEdaNetlist } from '../net-connectivity.mjs';

const codes = (result) => result.findings.map((item) => item.code);
const netlistOf = (components) => JSON.stringify({ version: '2.0.0', components });

/** 一个"健康"的小网表：GND / +3V3 / MIC_OUT 三个网络，全部引脚都有网络。 */
const healthyNetlist = netlistOf({
  gge1: {
    props: { Designator: 'R1', Name: '10k' },
    pinInfoMap: {
      1: { name: '1', number: '1', net: '+3V3' },
      2: { name: '2', number: '2', net: 'MIC_OUT' },
    },
  },
  gge2: {
    props: { Designator: 'C1', Name: '100nF' },
    pinInfoMap: {
      1: { name: '1', number: '1', net: '+3V3' },
      2: { name: '2', number: '2', net: 'GND' },
    },
  },
  gge3: {
    props: { Designator: 'MK1', Name: 'MIC' },
    pinInfoMap: {
      1: { name: 'VDD', number: '1', net: '+3V3' },
      2: { name: 'OUT', number: '2', net: 'MIC_OUT' },
      3: { name: 'GND', number: '3', net: 'GND' },
    },
  },
});

const healthyPcb = [
  { designator: 'R1', pads: [{ padNumber: '1', net: '+3V3' }, { padNumber: '2', net: 'MIC_OUT' }] },
  { designator: 'C1', pads: [{ padNumber: '1', net: '+3V3' }, { padNumber: '2', net: 'GND' }] },
  // 真机 MEMS 麦克风封装：4 个焊盘只有 3 个编号（两个 "3" 焊盘并联到 GND）
  { designator: 'MK1', pads: [{ padNumber: '3', net: 'GND' }, { padNumber: '3', net: 'GND' }, { padNumber: '2', net: 'MIC_OUT' }, { padNumber: '1', net: '+3V3' }] },
];

test('网表网络齐全、焊盘网络一致 → ready', () => {
  const result = auditNetConnectivity({ netlistText: healthyNetlist, components: healthyPcb });
  assert.equal(result.ready, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.counts.pads, 8);
  assert.equal(result.counts.padsWithoutNet, 0);
  assert.equal(result.counts.netlistPins, 7);
  assert.equal(result.counts.mismatchedPins, 0);
  assert.deepEqual(result.nets, ['+3V3', 'GND', 'MIC_OUT']);
});

test('没有网表 → NETLIST_UNAVAILABLE blocking（没网表不等于没问题）', () => {
  const result = auditNetConnectivity({ netlistText: null, components: healthyPcb });
  assert.equal(result.ready, false);
  assert.deepEqual(codes(result), [NET_CONNECTIVITY_CODES.NETLIST_UNAVAILABLE]);
});

test('网表不是 JSON → NETLIST_INVALID blocking', () => {
  const result = auditNetConnectivity({ netlistText: '<html>oops</html>', components: healthyPcb });
  assert.equal(result.ready, false);
  assert.deepEqual(codes(result), [NET_CONNECTIVITY_CODES.NETLIST_INVALID]);
  assert.equal(parseEasyEdaNetlist('null').ok, false);
  assert.equal(parseEasyEdaNetlist('{"version":"2.0.0"}').reason, 'NO_COMPONENTS_SECTION');
});

test('网表引脚大面积没有网络 → PIN_WITHOUT_NET blocking（真机 171/226）', () => {
  const netlist = netlistOf({
    gge1: {
      props: { Designator: 'U1' },
      pinInfoMap: {
        1: { name: '1', number: '1', net: '+3V3' },
        2: { name: '2', number: '2', net: '' },
        3: { name: '3', number: '3', net: '' },
      },
    },
  });
  const result = auditNetConnectivity({ netlistText: netlist, components: [{ designator: 'U1', pads: [{ padNumber: '1', net: '+3V3' }, { padNumber: '2', net: '' }, { padNumber: '3', net: '' }] }] });
  assert.equal(result.ready, false);
  assert.ok(codes(result).includes(NET_CONNECTIVITY_CODES.PIN_WITHOUT_NET));
  const finding = result.findings.find((item) => item.code === NET_CONNECTIVITY_CODES.PIN_WITHOUT_NET);
  assert.equal(finding.severity, 'blocking');
  assert.match(finding.message, /2\/3 个引脚没有网络/);
  assert.equal(result.counts.netlistPinsWithoutNet, 2);
});

test('少量引脚没有网络（≤5%）只告警，不阻断', () => {
  const netlist = netlistOf({
    gge1: {
      props: { Designator: 'U1' },
      pinInfoMap: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [String(index + 1), { name: String(index + 1), number: String(index + 1), net: index === 0 ? '' : (index % 2 ? 'GND' : '+3V3') }])),
    },
  });
  const pads = Array.from({ length: 40 }, (_, index) => ({ padNumber: String(index + 1), net: index === 0 ? '' : (index % 2 ? 'GND' : '+3V3') }));
  const result = auditNetConnectivity({ netlistText: netlist, components: [{ designator: 'U1', pads }] });
  const finding = result.findings.find((item) => item.code === NET_CONNECTIVITY_CODES.PIN_WITHOUT_NET);
  assert.equal(finding.severity, 'warning');
  assert.equal(result.ready, true);
});

test('焊盘没有网络 → PAD_WITHOUT_NET blocking（真机 171/278）', () => {
  const pcb = [
    { designator: 'R1', pads: [{ padNumber: '1', net: '+3V3' }, { padNumber: '2', net: '' }] },
  ];
  const netlist = netlistOf({
    gge1: {
      props: { Designator: 'R1' },
      pinInfoMap: { 1: { name: '1', number: '1', net: '+3V3' }, 2: { name: '2', number: '2', net: '' } },
    },
  });
  const result = auditNetConnectivity({ netlistText: netlist, components: pcb });
  assert.equal(result.ready, false);
  const finding = result.findings.find((item) => item.code === NET_CONNECTIVITY_CODES.PAD_WITHOUT_NET);
  assert.equal(finding.severity, 'blocking');
  assert.match(finding.message, /1\/2 个焊盘没有网络/);
  assert.match(finding.message, /R1\.2/);
});

test('网表里没有地网络（GND 被并进 +3V3）→ MISSING_GROUND_NET blocking', () => {
  const netlist = netlistOf({
    gge1: {
      props: { Designator: 'USB1' },
      pinInfoMap: {
        A1B12: { name: 'GND', number: 'A1B12', net: '+3V3' },
        B1A12: { name: 'GND', number: 'B1A12', net: '+3V3' },
        A4B9: { name: 'VBUS', number: 'A4B9', net: 'VBUS' },
      },
    },
  });
  const result = auditNetConnectivity({ netlistText: netlist, components: [{ designator: 'USB1', pads: [{ padNumber: 'A1B12', net: '+3V3' }, { padNumber: 'B1A12', net: '+3V3' }, { padNumber: 'A4B9', net: 'VBUS' }] }] });
  assert.equal(result.ready, false);
  const finding = result.findings.find((item) => item.code === NET_CONNECTIVITY_CODES.MISSING_GROUND_NET);
  assert.equal(finding.severity, 'blocking');
  assert.match(finding.message, /没有.*地网络|地网络/);
});

test('同引脚号的网络不一致 → PIN_PAD_NET_MISMATCH blocking（真机 MK1 GND→+3V3）', () => {
  const netlist = netlistOf({
    gge1: {
      props: { Designator: 'MK1' },
      pinInfoMap: {
        1: { name: 'VDD', number: '1', net: '+3V3' },
        2: { name: 'OUT', number: '2', net: 'MIC_OUT' },
        3: { name: 'GND', number: '3', net: 'GND' },
      },
    },
  });
  const pcb = [
    { designator: 'MK1', pads: [{ padNumber: '3', net: '+3V3' }, { padNumber: '3', net: '+3V3' }, { padNumber: '2', net: 'MIC_OUT' }, { padNumber: '1', net: '+3V3' }] },
  ];
  const result = auditNetConnectivity({ netlistText: netlist, components: pcb });
  assert.equal(result.ready, false);
  const finding = result.findings.find((item) => item.code === NET_CONNECTIVITY_CODES.PIN_PAD_NET_MISMATCH);
  assert.equal(finding.severity, 'blocking');
  assert.match(finding.message, /MK1\.3/);
  assert.equal(result.counts.mismatchedPins, 1);
});

test('焊盘网络不在网表网络集合里 → 只告警（网表会省略匿名网络）', () => {
  const netlist = netlistOf({
    gge1: { props: { Designator: 'R1' }, pinInfoMap: { 1: { name: '1', number: '1', net: '+3V3' }, 2: { name: '2', number: '2', net: 'GND' } } },
  });
  const pcb = [{ designator: 'R1', pads: [{ padNumber: '1', net: '+3V3' }, { padNumber: '2', net: 'GND' }, { padNumber: '3', net: 'N$12' }] }];
  const result = auditNetConnectivity({ netlistText: netlist, components: pcb });
  const finding = result.findings.find((item) => item.code === NET_CONNECTIVITY_CODES.PAD_NET_NOT_IN_NETLIST);
  assert.equal(finding.severity, 'warning');
  assert.equal(result.ready, true);
});

test('引脚在 PCB 上找不到对应焊盘时不由本模块判定（交给 footprint-integrity）', () => {
  const netlist = netlistOf({
    gge1: { props: { Designator: 'MK1' }, pinInfoMap: { 1: { name: 'VDD', number: '1', net: '+3V3' } } },
  });
  const result = auditNetConnectivity({ netlistText: netlist, components: [{ designator: 'MK1', pads: [] }] });
  assert.equal(result.ready, false);
  assert.ok(!codes(result).includes(NET_CONNECTIVITY_CODES.PIN_PAD_NET_MISMATCH));
  assert.deepEqual(codes(result).filter((code) => code === NET_CONNECTIVITY_CODES.PAD_WITHOUT_NET), []);
});

test('显式 No-Connect 引脚/焊盘不计入"缺网"阻塞（真机 33 个 NC 引脚被误判的回归）', () => {
  const netlist = netlistOf({
    gge1: { props: { Designator: 'U1' }, pinInfoMap: {
      1: { name: 'A', number: '1', net: 'GND' },
      2: { name: 'B', number: '2', net: 'SIG' },
      3: { name: 'C', number: '3', net: '' }, // 显式 NC
    } },
    gge2: { props: { Designator: 'J1' }, pinInfoMap: {
      1: { name: 'P', number: '1', net: 'SIG' },
      2: { name: 'N', number: '2', net: '' }, // 显式 NC
    } },
  });
  const pcb = [
    { designator: 'U1', pads: [{ padNumber: '1', net: 'GND' }, { padNumber: '2', net: 'SIG' }, { padNumber: '3', net: '' }] },
    { designator: 'J1', pads: [{ padNumber: '1', net: 'SIG' }, { padNumber: '2', net: '' }] },
  ];
  const withoutMapping = auditNetConnectivity({ netlistText: netlist, components: pcb });
  assert.equal(withoutMapping.ready, false);
  assert.ok(codes(withoutMapping).includes(NET_CONNECTIVITY_CODES.PIN_WITHOUT_NET));
  assert.ok(codes(withoutMapping).includes(NET_CONNECTIVITY_CODES.PAD_WITHOUT_NET));

  const withMapping = auditNetConnectivity({
    netlistText: netlist,
    components: pcb,
    noConnectPins: [{ designator: 'U1', pin: '3' }, { designator: 'J1', pin: '2' }],
  });
  assert.equal(withMapping.ready, true, JSON.stringify(withMapping.findings));
  assert.equal(withMapping.counts.netlistPinsWithoutNet, 0);
  assert.equal(withMapping.counts.netlistPinsNoConnectExplained, 2);
  assert.equal(withMapping.counts.padsWithoutNet, 0);
  assert.equal(withMapping.counts.padsNoConnectExplained, 2);
  assert.ok(!codes(withMapping).includes(NET_CONNECTIVITY_CODES.PIN_WITHOUT_NET));
  assert.ok(!codes(withMapping).includes(NET_CONNECTIVITY_CODES.PAD_WITHOUT_NET));
});
