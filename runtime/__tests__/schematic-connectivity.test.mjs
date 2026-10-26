import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSchematicConnectivity, parseSchematicSource, SCH_CONNECTIVITY_CODES } from '../schematic-connectivity.mjs';

/**
 * 构造一份最小原理图源码：每行 `{head}||{body}|`，格式与真机 `getDocumentSource()` 一致。
 * 注意：源码里的 y 与 API 世界坐标**符号相反**（真机口径），所以这里按源码写、按世界坐标断言。
 */
const makeSource = ({ components = [], wires = [], labels = [] }) => {
  const lines = [];
  for (const component of components) {
    lines.push(`${JSON.stringify({ type: 'COMPONENT', id: component.id })}||${JSON.stringify({ x: component.x, y: component.y, rotation: component.rotation ?? 0, isMirror: false })}|`);
  }
  for (const wire of wires) {
    lines.push(`${JSON.stringify({ type: 'WIRE', id: wire.id })}||${JSON.stringify({ zIndex: 1 })}|`);
    lines.push(`${JSON.stringify({ type: 'LINE', id: `${wire.id}-line` })}||${JSON.stringify({ startX: wire.x1, startY: wire.sourceY1 ?? wire.y1, endX: wire.x2, endY: wire.sourceY2 ?? wire.y2, lineGroup: wire.id })}|`);
  }
  for (const label of labels) {
    lines.push(`${JSON.stringify({ type: 'ATTR', id: label.id })}||${JSON.stringify({ key: 'NET', value: label.value, x: label.x, y: label.y, parentId: label.wireId })}|`);
  }
  return lines.join('\n');
};

const pin = (designator, number, x, y, name = '') => ({ designator, number, name, x, y });

test('健康原理图：两个引脚各接一段同名网络标签的导线 → 合并成一个网络且 ready', () => {
  const sourceText = makeSource({
    components: [{ id: 'c1', x: 0, y: 0 }, { id: 'c2', x: 20, y: 0 }],
    wires: [
      { id: 'w1', x1: 0, y1: 0, x2: 8, y2: 0 },
      { id: 'w2', x1: 20, y1: 0, x2: 28, y2: 0 },
    ],
    labels: [
      { id: 'l1', wireId: 'w1', value: 'GND', x: 4, y: 0 },
      { id: 'l2', wireId: 'w2', value: 'GND', x: 24, y: 0 },
    ],
  });
  const report = auditSchematicConnectivity({
    sourceText,
    pins: [pin('U1', '1', 0, 0, 'GND'), pin('U2', '2', 20, 0, 'GND')],
  });
  assert.equal(report.ready, true);
  assert.equal(report.counts.connectedPins, 2);
  assert.equal(report.counts.floatingPins, 0);
  assert.equal(report.counts.nets, 1);
  assert.deepEqual(report.nets[0].names, ['GND']);
  assert.equal(report.findings.filter((item) => item.severity === 'blocking').length, 0);
});

test('源码 Y 轴与 API 世界坐标相反：源码 y=-100 必须能对上世界坐标 y=100 的引脚', () => {
  const sourceText = makeSource({
    wires: [{ id: 'w1', x1: 100, y1: -100, x2: 108, y2: -100 }],
    labels: [{ id: 'l1', wireId: 'w1', value: '+3V3', x: 104, y: -100 }],
  });
  const report = auditSchematicConnectivity({ sourceText, pins: [pin('U1', '1', 100, 100, 'VDD')] });
  assert.equal(report.counts.connectedPins, 1);
  assert.equal(report.counts.floatingPins, 0);
  assert.equal(report.ready, true);
});

test('未连接引脚超过 5% → blocking（这是真机 171/266 的形态）', () => {
  const sourceText = makeSource({
    wires: [{ id: 'w1', x1: 0, y1: 0, x2: 8, y2: 0 }],
    labels: [{ id: 'l1', wireId: 'w1', value: 'GND', x: 4, y: 0 }],
  });
  const pins = [pin('U1', '1', 0, 0, 'GND')];
  for (let index = 0; index < 9; index += 1) pins.push(pin('U1', String(index + 2), 100 + index, 0, `IO${index}`));
  const report = auditSchematicConnectivity({ sourceText, pins });
  assert.equal(report.ready, false);
  const item = report.findings.find((entry) => entry.code === SCH_CONNECTIVITY_CODES.FLOATING_PINS);
  assert.equal(item.severity, 'blocking');
  assert.match(item.message, /9\/10 个（应连）引脚没有连到任何导线/);
});

test('少量未连接引脚（<=5%）只 warning，不阻断', () => {
  const sourceText = makeSource({
    wires: [{ id: 'w1', x1: 0, y1: 0, x2: 8, y2: 0 }],
    labels: [{ id: 'l1', wireId: 'w1', value: 'GND', x: 4, y: 0 }],
  });
  const pins = [];
  for (let index = 0; index < 30; index += 1) pins.push(pin('U1', String(index + 1), 0, 0, 'GND'));
  pins.push(pin('U1', '31', 500, 0, 'NC'));
  const report = auditSchematicConnectivity({ sourceText, pins });
  const item = report.findings.find((entry) => entry.code === SCH_CONNECTIVITY_CODES.FLOATING_PINS);
  assert.equal(item.severity, 'warning');
  assert.equal(report.ready, true);
});

test('同一根导线挂两个不同网络标签 → blocking（GND 被并进 +3V3 的真机短路形态）', () => {
  const sourceText = makeSource({
    wires: [{ id: 'w1', x1: 100, y1: -135, x2: 108, y2: -135 }],
    labels: [
      { id: 'l1', wireId: 'w1', value: 'GND', x: 104, y: -135 },
      { id: 'l2', wireId: 'w1', value: '+3V3', x: 104, y: -135 },
    ],
  });
  const report = auditSchematicConnectivity({ sourceText, pins: [pin('U2', '9', 100, 135, 'EP')] });
  assert.equal(report.ready, false);
  const item = report.findings.find((entry) => entry.code === SCH_CONNECTIVITY_CODES.MULTI_LABEL_WIRE);
  assert.ok(item, '必须报出多标签导线');
  assert.match(item.message, /GND \/ \+3V3/);
  assert.equal(report.multiLabelWires.length, 1);
});

test('同名标签即使不在同一段导线上也属于同一网络（EasyEDA 标签语义）', () => {
  const sourceText = makeSource({
    wires: [
      { id: 'w1', x1: 0, y1: 0, x2: 8, y2: 0 },
      { id: 'w2', x1: 200, y1: 0, x2: 208, y2: 0 },
      { id: 'w3', x1: 400, y1: 0, x2: 408, y2: 0 },
    ],
    labels: [
      { id: 'l1', wireId: 'w1', value: 'I2S_BCLK', x: 4, y: 0 },
      { id: 'l2', wireId: 'w2', value: 'I2S_BCLK', x: 204, y: 0 },
      { id: 'l3', wireId: 'w3', value: 'I2S_BCLK', x: 404, y: 0 },
    ],
  });
  const report = auditSchematicConnectivity({ sourceText, pins: [pin('U1', '1', 0, 0), pin('U5', '2', 200, 0), pin('U5', '3', 400, 0)] });
  assert.equal(report.counts.nets, 1);
  assert.equal(report.nets[0].pins.length, 3);
});

test('源码读不到 → blocking（"没有证据"不等于"没有问题"）', () => {
  const report = auditSchematicConnectivity({ sourceText: '', pins: [pin('U1', '1', 0, 0)] });
  assert.equal(report.ready, false);
  assert.ok(report.findings.some((item) => item.code === SCH_CONNECTIVITY_CODES.SOURCE_UNAVAILABLE && item.severity === 'blocking'));
});

test('引脚坐标拿不到 → blocking', () => {
  const sourceText = makeSource({ wires: [{ id: 'w1', x1: 0, y1: 0, x2: 8, y2: 0 }] });
  const report = auditSchematicConnectivity({ sourceText, pins: [] });
  assert.equal(report.ready, false);
  assert.ok(report.findings.some((item) => item.code === SCH_CONNECTIVITY_CODES.PINS_UNAVAILABLE && item.severity === 'blocking'));
});

test('悬空网络标签 → warning（导出网表会把这个网络丢掉）', () => {
  const sourceText = makeSource({
    wires: [
      { id: 'w1', x1: 0, y1: 0, x2: 8, y2: 0 },
      { id: 'w2', x1: 500, y1: 0, x2: 508, y2: 0 },
    ],
    labels: [
      { id: 'l1', wireId: 'w1', value: 'GND', x: 4, y: 0 },
      { id: 'l2', wireId: 'w2', value: 'MIC_VDD', x: 504, y: 0 },
    ],
  });
  const report = auditSchematicConnectivity({ sourceText, pins: [pin('U1', '1', 0, 0)] });
  const item = report.findings.find((entry) => entry.code === SCH_CONNECTIVITY_CODES.DANGLING_LABEL);
  assert.ok(item);
  assert.equal(item.severity, 'warning');
  assert.match(item.message, /MIC_VDD/);
});

test('解析器只认 ATTR key=NET 的标签，并把 body 尾部的 | 剥掉', () => {
  const sourceText = makeSource({
    wires: [{ id: 'w1', x1: 0, y1: 0, x2: 8, y2: 0 }],
    labels: [{ id: 'l1', wireId: 'w1', value: 'GND', x: 4, y: 0 }],
  }) + '\n' + JSON.stringify({ type: 'ATTR', id: 'other' }) + '||' + JSON.stringify({ key: 'Value', value: '10k', parentId: 'w1' }) + '|';
  const parsed = parseSchematicSource(sourceText);
  assert.equal(parsed.wires.length, 1);
  assert.equal(parsed.labels.length, 1);
  assert.equal(parsed.labels[0].value, 'GND');
  assert.equal(Math.abs(parsed.wires[0].y1), 0); // -0 是 Y 轴翻转的必然产物，按值断言
});

test('显式 No-Connect 引脚不计入"未连接"（预留/未用脚不是断路）', () => {
  const sourceText = makeSource({
    wires: [
      { id: 'w1', x1: 0, y1: 0, x2: 8, y2: 0 },
      { id: 'w2', x1: 200, y1: 0, x2: 208, y2: 0 },
    ],
    labels: [
      { id: 'l1', wireId: 'w1', value: 'GND', x: 4, y: 0 },
      { id: 'l2', wireId: 'w2', value: 'GND', x: 204, y: 0 },
    ],
  });
  const report = auditSchematicConnectivity({
    sourceText,
    pins: [
      pin('U1', '1', 0, 0),
      pin('U1', '2', 200, 0),
      { ...pin('U1', '27', 500, 500), noConnected: true },
      { ...pin('U1', '29', 520, 520), noConnected: true },
    ],
  });
  assert.equal(report.counts.noConnectPins, 2);
  assert.equal(report.counts.floatingPins, 0);
  assert.equal(report.counts.connectedPins, 2);
  assert.equal(report.ready, true);
});

test('No-Connect 引脚却接在导线上 → warning（标注与连线矛盾）', () => {
  const sourceText = makeSource({
    wires: [{ id: 'w1', x1: 0, y1: 0, x2: 8, y2: 0 }],
    labels: [{ id: 'l1', wireId: 'w1', value: 'GND', x: 4, y: 0 }],
  });
  const report = auditSchematicConnectivity({
    sourceText,
    pins: [{ ...pin('U1', '27', 0, 0), noConnected: true }],
  });
  const item = report.findings.find((entry) => entry.code === SCH_CONNECTIVITY_CODES.NO_CONNECT_BUT_WIRED);
  assert.ok(item);
  assert.equal(item.severity, 'warning');
  assert.equal(report.counts.noConnectPins, 1);
  assert.equal(report.counts.floatingPins, 0);
});
