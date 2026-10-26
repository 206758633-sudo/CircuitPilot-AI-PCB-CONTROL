import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAcceptanceMatrix, mapRequirement, toDesignSpecInput } from '../acceptance-mapper.mjs';
import { buildDesignSpec } from '../design-spec.mjs';

test('模板化：任意 PRD 的需求按领域语义映射证据类型（不绑定具体板子）', () => {
  const matrix = buildAcceptanceMatrix([
    '12V 输入转 5V/3.3V，至少 2A',
    'USB-C 接口用于烧录与供电',
    'MCU 使用 ESP32-S3 并保留 UART 调试口',
    '板子尺寸不超过 80×60mm，四角安装孔 M2.5',
  ]);
  assert.equal(matrix.total, 4);
  assert.equal(matrix.mapped, 4);
  assert.equal(matrix.coverage, 1);
  assert.deepEqual(matrix.requirements.map((row) => row.templateId), ['power', 'interface', 'mcu', 'mechanical']);
  assert.deepEqual(matrix.requirements.map((row) => row.acceptance.evidenceKind), ['spice-simulation', 'pcb-layer-stack', 'schematic-erc', 'pcb-layer-stack']);
});

test('未命中模板：不静默通过，默认 signoff + needsReview，并进入 unmapped', () => {
  const matrix = buildAcceptanceMatrix(['整体风格要好看，符合品牌调性']);
  assert.equal(matrix.mapped, 0);
  assert.deepEqual(matrix.unmapped, ['REQ-1']);
  assert.equal(matrix.requirements[0].acceptance.evidenceKind, 'signoff');
  assert.equal(matrix.requirements[0].acceptance.needsReview, true);
});

test('确定性：同样输入两次输出完全一致；ids 稳定', () => {
  const input = [{ id: 'R1', requirement: '支持 3.3V 电源' }, { id: 'R2', requirement: 'WS2812B 灯环' }];
  assert.deepEqual(buildAcceptanceMatrix(input), buildAcceptanceMatrix(input));
  assert.deepEqual(buildAcceptanceMatrix(input).requirements.map((row) => row.id), ['R1', 'R2']);
});

test('重复 id → 明确拒绝', () => {
  assert.throws(() => buildAcceptanceMatrix([{ id: 'R1', requirement: 'a' }, { id: 'R1', requirement: 'b' }]), /重复/);
});

test('空需求文本 → 拒绝（不能凭空生成验收项）', () => {
  assert.throws(() => mapRequirement('   '), /不能为空/);
});

test('输出可直接构建 design-spec（含显式 acceptance evidenceKind）', () => {
  const matrix = buildAcceptanceMatrix(['12V 转 5V 电源', 'USB-C 接口', 'ESP32-S3 主控', '尺寸 80×60mm']);
  const input = toDesignSpecInput(matrix);
  const spec = buildDesignSpec({ project: { name: 'blind-board' }, boards: [{ id: 'b1', name: 'blind-board', layers: 2, outline: { widthMm: 80, heightMm: 60 } }], requirements: input.requirements });
  assert.equal(spec.requirements.length, 4);
  assert.equal(spec.acceptance.length, 4);
  assert.equal(spec.acceptance.every((row) => row.evidenceKind && row.criterion), true);
});
