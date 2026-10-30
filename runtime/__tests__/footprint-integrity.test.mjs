import assert from 'node:assert/strict';
import test from 'node:test';

import { FOOTPRINT_INTEGRITY_CODES, evaluateFootprintIntegrity, normalizeNumbers } from '../footprint-integrity.mjs';

const codes = (result) => result.findings.map((item) => item.code);

test('全部器件都有封装、引脚与焊盘一一对应 → ready', () => {
  const result = evaluateFootprintIntegrity({
    schematicParts: [
      { designator: 'R1', footprint: { uuid: 'fp-r1', name: 'R0402' }, pinNumbers: ['1', '2'] },
      { designator: 'U1', footprint: { uuid: 'fp-u1', name: 'SOT-23-3' }, pinNumbers: [1, 2, 3] },
    ],
    pcbComponents: [{ designator: 'R1' }, { designator: 'U1' }],
    padsByDesignator: { R1: ['1', '2'], U1: ['1', '2', '3'] },
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.checked, 2);
  assert.equal(result.summary.blocking, 0);
});

test('没绑定封装 → MISSING_FOOTPRINT blocking（真机 ERC 报错的根因）', () => {
  const result = evaluateFootprintIntegrity({
    schematicParts: [{ designator: 'MK1', footprint: null, pinNumbers: ['1', '2', '3'] }],
    pcbComponents: [{ designator: 'MK1' }],
    padsByDesignator: {},
  });
  assert.equal(result.ready, false);
  assert.deepEqual(codes(result), [FOOTPRINT_INTEGRITY_CODES.MISSING_FOOTPRINT]);
  assert.match(result.findings[0].message, /MK1/);
  assert.equal(result.findings[0].severity, 'blocking');
});

test('有封装但 PCB 上 0 个焊盘 → PADS_MISSING blocking', () => {
  const result = evaluateFootprintIntegrity({
    schematicParts: [{ designator: 'MK1', footprint: { uuid: 'df3cd8468b55cfde', name: 'MIC-SMD_3P' }, pinNumbers: ['1', '2', '3'] }],
    pcbComponents: [{ designator: 'MK1' }],
    padsByDesignator: { MK1: [] },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(codes(result), [FOOTPRINT_INTEGRITY_CODES.PADS_MISSING]);
  assert.match(result.findings[0].message, /0 个焊盘/);
  assert.match(result.findings[0].message, /MIC-SMD_3P/);
});

test('引脚号与焊盘号不一致 → PIN_UNMAPPED blocking，并列出缺哪几个', () => {
  const result = evaluateFootprintIntegrity({
    schematicParts: [{ designator: 'MK1', footprint: { uuid: 'fp', name: 'MIC' }, pinNumbers: ['1', '2', '3'] }],
    pcbComponents: [{ designator: 'MK1' }],
    padsByDesignator: { MK1: ['1', '2', '2'] },
  });
  assert.equal(result.ready, false);
  assert.ok(codes(result).includes(FOOTPRINT_INTEGRITY_CODES.PIN_UNMAPPED));
  const finding = result.findings.find((item) => item.code === FOOTPRINT_INTEGRITY_CODES.PIN_UNMAPPED);
  assert.match(finding.message, /引脚 3/);
  assert.match(finding.message, /封装焊盘 1、2/); // 重复焊盘号归一化时已去重
});

test('多出的焊盘只算 warning，不阻断', () => {
  const result = evaluateFootprintIntegrity({
    schematicParts: [{ designator: 'U1', footprint: { uuid: 'fp' }, pinNumbers: ['1', '2'] }],
    pcbComponents: [{ designator: 'U1' }],
    padsByDesignator: { U1: ['1', '2', 'EP'] },
  });
  assert.equal(result.ready, true);
  assert.deepEqual(codes(result), [FOOTPRINT_INTEGRITY_CODES.PAD_UNUSED]);
  assert.equal(result.summary.warnings, 1);
  assert.equal(result.summary.blocking, 0);
});

test('原理图有、PCB 没有 → warning（提示未同步，不单独阻断）', () => {
  const result = evaluateFootprintIntegrity({
    schematicParts: [{ designator: 'TP1', footprint: { uuid: 'fp' }, pinNumbers: ['1'] }],
    pcbComponents: [],
    padsByDesignator: {},
  });
  assert.equal(result.ready, true);
  assert.deepEqual(codes(result), [FOOTPRINT_INTEGRITY_CODES.COMPONENT_MISSING_IN_PCB]);
});

test('读不到任何原理图器件 → fail-closed blocking，不能当成没问题', () => {
  const result = evaluateFootprintIntegrity({ schematicParts: [], pcbComponents: [], padsByDesignator: {} });
  assert.equal(result.ready, false);
  assert.deepEqual(codes(result), [FOOTPRINT_INTEGRITY_CODES.NO_PART_READBACK]);
});

test('引脚号读不到时给 warning，但沿用 ERC 兜底（不宣布一致）', () => {
  const result = evaluateFootprintIntegrity({
    schematicParts: [{ designator: 'U2', footprint: { uuid: 'fp' }, pinNumbers: [] }],
    pcbComponents: [{ designator: 'U2' }],
    padsByDesignator: { U2: ['1', '2'] },
  });
  assert.equal(result.ready, true);
  assert.deepEqual(codes(result), [FOOTPRINT_INTEGRITY_CODES.NO_PART_READBACK]);
  assert.equal(result.findings[0].severity, 'warning');
});

test('号码归一化：数字/字符串混用、空值、重复都能处理', () => {
  assert.deepEqual(normalizeNumbers([1, '1', ' 2 ', null, undefined, '', 'NaN']), { list: ['1', '2'], invalid: 4 });
  assert.deepEqual(normalizeNumbers(null), { list: [], invalid: 0 });
});
