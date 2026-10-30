import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDITOR_CODES,
  NETLIST_FINDINGS,
  auditNetlist,
  parseActualNetlist,
  parseIntentNetlist,
} from '../agents/netlist-auditor.mjs';

/** 构造 EasyEDA 导出形态的实际网表（真机格式：components[uid].pinInfoMap[pin].net）。 */
const edaExport = (components) => JSON.stringify({
  version: '2.0.0',
  components: Object.fromEntries(Object.entries(components).map(([ref, pins], index) => [
    `uid${index + 1}`,
    {
      props: { Designator: ref },
      pinInfoMap: Object.fromEntries(Object.entries(pins).map(([pin, net]) => [pin, { name: pin, number: pin, net }])),
    },
  ])),
});

const intentOf = (nets) => ({ nets: nets.map(([name, endpoints]) => ({ name, endpoints: endpoints.map((key) => ({ ref: key.split('.')[0], pin: key.split('.')[1] })) })) });

test('parseActualNetlist：解析 EasyEDA 导出（含悬空引脚）与规范化结构', () => {
  const actual = parseActualNetlist(edaExport({ U1: { 1: 'GND', 2: '+3V3', 3: '' } }));
  assert.equal(actual.format, 'easyeda-export');
  assert.equal(actual.componentCount, 1);
  assert.equal(actual.pinCount, 3);
  assert.deepEqual([...actual.nets.get('GND')], ['U1.1']);
  const normalized = parseActualNetlist({ nets: [{ name: 'GND', endpoints: [{ ref: 'U1', pin: '1' }] }] });
  assert.equal(normalized.format, 'normalized');
  assert.deepEqual([...normalized.nets.get('GND')], ['U1.1']);
});

test('parseActualNetlist / parseIntentNetlist：非法输入 fail-closed', () => {
  assert.throws(() => parseActualNetlist('not json'), (error) => error.code === AUDITOR_CODES.ACTUAL_INVALID);
  assert.throws(() => parseActualNetlist({ foo: 1 }), (error) => error.code === AUDITOR_CODES.ACTUAL_INVALID);
  assert.throws(() => parseIntentNetlist(null), (error) => error.code === AUDITOR_CODES.INTENT_INVALID);
  assert.throws(() => parseIntentNetlist({ netIntent: [{ net: 'GND', endpoints: [] }] }), (error) => error.code === AUDITOR_CODES.INTENT_INVALID);
  assert.throws(() => parseIntentNetlist({ netIntent: [] }), (error) => error.code === AUDITOR_CODES.INTENT_INVALID, '空 netIntent 应视为非法');
});

test('parseIntentNetlist：兼容裸网表数组 [{net, endpoints}]', () => {
  const parsed = parseIntentNetlist([{ net: 'GND', endpoints: [{ ref: 'U1', pin: '1' }, { ref: 'R1', pin: '2' }] }]);
  assert.equal(parsed.format, 'reviewed-netlist');
  assert.deepEqual([...parsed.nets.get('GND')], ['U1.1', 'R1.2']);
});

test('happy path：意图与实际完全一致 → pass、findings 为空', () => {
  const result = auditNetlist({
    intent: intentOf([['GND', ['U1.1', 'R1.2']], ['+3V3', ['U1.2', 'R1.1']]]),
    actual: edaExport({ U1: { 1: 'GND', 2: '+3V3' }, R1: { 1: '+3V3', 2: 'GND' } }),
    pcbUuid: 'pcb-a',
    boardId: 'main',
    now: () => new Date('2026-10-21T12:00:00.000Z'),
  });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.findings.length, 0);
  assert.equal(result.counts.intentNets, 2);
  assert.equal(result.counts.actualPins, 4);
  assert.equal(result.fingerprint.pcbUuid, 'pcb-a');
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.generatedAt, '2026-10-21T12:00:00.000Z');
});

test('GND 空网：意图有 GND 但实际没有任何地引脚 → NETLIST_GND_EMPTY（不是普通 NET_MISSING）', () => {
  const result = auditNetlist({
    intent: intentOf([['GND', ['U1.1', 'C1.2']], ['+3V3', ['U1.2', 'C1.1']]]),
    actual: edaExport({ U1: { 1: '', 2: '+3V3' }, C1: { 1: '+3V3', 2: '' } }),
  });
  assert.equal(result.verdict, 'blocked');
  const codes = result.findings.map((finding) => finding.code);
  assert.ok(codes.includes(NETLIST_FINDINGS.GND_EMPTY));
  assert.ok(!codes.includes(NETLIST_FINDINGS.NET_MISSING));
});

test('悬空引脚：期望接网络但实际 net 为空 → PIN_FLOATING；allowedFloating 可显式豁免 NC 引脚', () => {
  const blocked = auditNetlist({
    intent: intentOf([['LED_DIN', ['U1.3', 'D1.4']]]),
    actual: edaExport({ U1: { 3: '' }, D1: { 4: 'LED_DIN' } }),
  });
  assert.equal(blocked.verdict, 'blocked');
  assert.ok(blocked.findings.some((finding) => finding.code === NETLIST_FINDINGS.PIN_FLOATING && finding.ref === 'U1' && finding.pin === '3'));

  const allowed = auditNetlist({
    intent: intentOf([['LED_DIN', ['U1.3', 'D1.4']]]),
    actual: edaExport({ U1: { 3: '' }, D1: { 4: 'LED_DIN' } }),
    allowedFloating: ['u1.3'],
  });
  assert.equal(allowed.verdict, 'pass');
  assert.equal(allowed.findings.length, 0);
});

test('电源混网：意图 +3V3 的引脚实际接到 GND → POWER_MIXED（区别于普通 PIN_MISMATCH）', () => {
  const result = auditNetlist({
    intent: intentOf([['+3V3', ['U1.2', 'R1.1']], ['GND', ['U1.1', 'R1.2']]]),
    actual: edaExport({ U1: { 1: 'GND', 2: 'GND' }, R1: { 1: '+3V3', 2: 'GND' } }),
  });
  assert.equal(result.verdict, 'blocked');
  const mixed = result.findings.find((finding) => finding.code === NETLIST_FINDINGS.POWER_MIXED);
  assert.ok(mixed);
  assert.equal(mixed.expectedNet, '+3V3');
  assert.equal(mixed.actualNet, 'GND');
});

test('普通网络错接 → PIN_MISMATCH；缺失网络 → NET_MISSING', () => {
  const mismatch = auditNetlist({
    intent: intentOf([['SPI_MOSI', ['U1.1', 'U2.1']]]),
    actual: edaExport({ U1: { 1: 'SPI_MISO' }, U2: { 1: 'SPI_MISO' } }),
  });
  assert.ok(mismatch.findings.some((finding) => finding.code === NETLIST_FINDINGS.PIN_MISMATCH));
  const missing = auditNetlist({
    intent: intentOf([['I2C_SCL', ['U1.1', 'U2.1']]]),
    actual: edaExport({ U1: { 1: 'I2C_SDA' }, U2: { 1: 'I2C_SDA' } }),
  });
  assert.ok(missing.findings.some((finding) => finding.code === NETLIST_FINDINGS.NET_MISSING && finding.net === 'I2C_SCL'));
});

test('额外网络/额外引脚：默认警告不阻断，strictExtraNets 时升级为错误', () => {
  const intent = intentOf([['GND', ['U1.1', 'R1.2']]]);
  const actual = edaExport({ U1: { 1: 'GND', 9: 'DEBUG_TX' }, R1: { 2: 'GND', 3: 'GND' } });
  const relaxed = auditNetlist({ intent, actual });
  assert.equal(relaxed.verdict, 'pass');
  assert.ok(relaxed.findings.some((finding) => finding.code === NETLIST_FINDINGS.NET_EXTRA && finding.severity === 'warning'));
  assert.ok(relaxed.findings.some((finding) => finding.code === NETLIST_FINDINGS.PIN_EXTRA));
  const strict = auditNetlist({ intent, actual, strictExtraNets: true });
  assert.equal(strict.verdict, 'blocked');
});

test('allowedMissingNets：人工批准后缺失网络不阻断', () => {
  const result = auditNetlist({
    intent: intentOf([['GND', ['U1.1', 'R1.2']], ['USB_DP', ['U2.1', 'J1.1']]]),
    actual: edaExport({ U1: { 1: 'GND' }, R1: { 2: 'GND' }, U2: { 1: '' }, J1: { 1: '' } }),
    allowedFloating: ['U2.1', 'J1.1'],
    allowedMissingNets: ['USB_DP'],
  });
  assert.equal(result.verdict, 'pass');
});

test('确定性：同输入两次审计 digest 相同（时间注入除外）', () => {
  const options = {
    intent: intentOf([['GND', ['U1.1', 'R1.2']]]),
    actual: edaExport({ U1: { 1: 'GND' }, R1: { 2: 'GND' } }),
    now: () => new Date('2026-10-21T12:00:00.000Z'),
  };
  assert.equal(auditNetlist(options).digest, auditNetlist(options).digest);
});

test('输入缺失：缺少意图或实际网表 → INPUT_MISSING', () => {
  assert.throws(() => auditNetlist({ actual: edaExport({ U1: { 1: 'GND' } }) }), (error) => error.code === AUDITOR_CODES.INPUT_MISSING);
  assert.throws(() => auditNetlist({ intent: intentOf([['GND', ['U1.1', 'R1.2']]]) }), (error) => error.code === AUDITOR_CODES.INPUT_MISSING);
});
