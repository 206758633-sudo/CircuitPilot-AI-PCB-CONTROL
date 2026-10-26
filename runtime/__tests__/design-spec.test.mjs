import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DESIGN_SPEC_CODES,
  DESIGN_SPEC_EVIDENCE_KINDS,
  DESIGN_SPEC_SCHEMA_VERSION,
  boardOutlineFromPoints,
  buildDesignSpec,
  evidenceKindForCategory,
  normalizePoints,
  outlineFromBoardSizes,
  validateDesignSpec,
} from '../design-spec.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));

// 合法 spec 模板：覆盖两块板、一条跨板接口、意图网表、BOM 锁、需求→验收矩阵。
const validSpec = () => ({
  schemaVersion: DESIGN_SPEC_SCHEMA_VERSION,
  project: { name: '通用双板测试项目' },
  boards: [
    { id: 'main', name: '主板', layers: 4, outline: { widthMm: 40, heightMm: 30 } },
    { id: 'aux', name: '接口板', layers: 2, outline: { points: [[0, 0], [10, 0], [10, 10], [0, 10]] } },
  ],
  interfaces: [
    {
      id: 'if-power',
      from: { board: 'main', ref: 'U1', pins: ['1', '2'] },
      to: { board: 'aux', ref: 'J1', pins: ['1', '2'] },
      nets: ['VBUS', 'GND'],
    },
  ],
  netIntent: [
    { net: 'VBUS', endpoints: ['U1.1', 'J1.1'] },
    { net: 'GND', endpoints: ['U1.2', 'J1.2'] },
  ],
  bomLock: [{ ref: 'U1', lcscId: 'C11111', value: 'MCU', footprint: 'QFN-32', locked: true }],
  requirements: [{ id: 'R1', category: 'schematic', requirement: '原理图网表与意图一致' }],
  acceptance: [{ requirementId: 'R1', criterion: 'ERC 报告 0 悬空', evidenceKind: 'schematic-erc' }],
});

const assertCode = (fn, expectedCode, label = '') => {
  assert.throws(fn, (error) => {
    assert.equal(error.code, expectedCode, `${label} 期望 ${expectedCode}，实际 ${error.code}：${error.message}`);
    assert.ok(error instanceof Error);
    assert.ok(error.message.length > 0);
    return true;
  }, label);
};

test('design spec: 合法 spec 通过校验并归一化板框', () => {
  const result = validateDesignSpec(validSpec());
  assert.equal(result.ok, true);
  assert.equal(result.spec.schemaVersion, DESIGN_SPEC_SCHEMA_VERSION);
  assert.equal(result.spec.boards.length, 2);
  // 宽高板框被展开成矩形点集 + 由点集算出的 bounds
  assert.deepEqual(result.spec.boards[0].outline.points, [[0, 0], [40, 0], [40, 30], [0, 30]]);
  assert.deepEqual({ width: result.spec.boards[0].outline.widthMm, height: result.spec.boards[0].outline.heightMm }, { width: 40, height: 30 });
  // 点集板框保留原始坐标，只做归一化
  assert.equal(result.spec.boards[1].outline.widthMm, 10);
  assert.equal(result.spec.boards[1].outline.heightMm, 10);
  // 接口/意图网表/BOM 锁保持契约形态
  assert.deepEqual(result.spec.interfaces[0].from, { board: 'main', ref: 'U1', pins: ['1', '2'] });
  assert.deepEqual(result.spec.netIntent[0].endpoints, ['U1.1', 'J1.1']);
  assert.equal(result.spec.bomLock[0].locked, true);
  // 二次校验幂等：归一化后的 spec 仍然通过。
  assert.equal(validateDesignSpec(result.spec).ok, true);
});

test('design spec: schemaVersion / project / boards 缺省一律 SPEC_INVALID', () => {
  assertCode(() => validateDesignSpec(null), DESIGN_SPEC_CODES.SPEC_INVALID, '非对象');
  assertCode(() => validateDesignSpec({ ...validSpec(), schemaVersion: 99 }), DESIGN_SPEC_CODES.SPEC_INVALID, 'schemaVersion');
  assertCode(() => validateDesignSpec((({ project, ...rest }) => rest)(validSpec())), DESIGN_SPEC_CODES.SPEC_INVALID, '缺 project');
  assertCode(() => validateDesignSpec({ ...validSpec(), project: { name: '   ' } }), DESIGN_SPEC_CODES.SPEC_INVALID, '空 project.name');
  assertCode(() => validateDesignSpec((({ boards, ...rest }) => rest)(validSpec())), DESIGN_SPEC_CODES.SPEC_INVALID, '缺 boards');
  assertCode(() => validateDesignSpec({ ...validSpec(), boards: [] }), DESIGN_SPEC_CODES.SPEC_INVALID, '空 boards');
  assertCode(() => validateDesignSpec({ ...validSpec(), boards: [{ id: 'main', name: 'A', layers: 1, outline: { widthMm: 10, heightMm: 10 } }] }), DESIGN_SPEC_CODES.SPEC_INVALID, 'layers<2');
  assertCode(() => validateDesignSpec({ ...validSpec(), boards: [{ id: 'main', name: 'A', layers: 4 }] }), DESIGN_SPEC_CODES.OUTLINE_INVALID, '缺 outline');
});

test('design spec: 板框尺寸 <= 0 / 点集退化抛 OUTLINE_INVALID', () => {
  assertCode(() => validateDesignSpec({ ...validSpec(), boards: [{ id: 'main', name: 'A', layers: 2, outline: { widthMm: 0, heightMm: 10 } }] }), DESIGN_SPEC_CODES.OUTLINE_INVALID, 'width=0');
  assertCode(() => validateDesignSpec({ ...validSpec(), boards: [{ id: 'main', name: 'A', layers: 2, outline: { widthMm: 10, heightMm: -1 } }] }), DESIGN_SPEC_CODES.OUTLINE_INVALID, 'height<0');
  assertCode(() => validateDesignSpec({ ...validSpec(), boards: [{ id: 'main', name: 'A', layers: 2, outline: { points: [[0, 0], [10, 0]] } }] }), DESIGN_SPEC_CODES.OUTLINE_INVALID, '点数<3');
  assertCode(() => validateDesignSpec({ ...validSpec(), boards: [{ id: 'main', name: 'A', layers: 2, outline: { points: [[0, 0], [10, 0], [10, 0], [10, 0]] } }] }), DESIGN_SPEC_CODES.OUTLINE_INVALID, '去重后点数<3');
});

test('design spec: 接口引脚为空 / 未知板 / id 重复抛 INTERFACE_INVALID', () => {
  const withInterfaces = (interfaces) => ({ ...validSpec(), interfaces });

  const emptyPins = clone(validSpec());
  emptyPins.interfaces[0].from.pins = [];
  assertCode(() => validateDesignSpec(emptyPins), DESIGN_SPEC_CODES.INTERFACE_INVALID, 'from.pins 为空');

  const blankPin = clone(validSpec());
  blankPin.interfaces[0].to.pins = ['1', '  '];
  assertCode(() => validateDesignSpec(blankPin), DESIGN_SPEC_CODES.INTERFACE_INVALID, 'to.pins 含空值');

  assertCode(() => validateDesignSpec(withInterfaces([{ id: 'x', from: { board: 'ghost', ref: 'U1', pins: ['1'] }, to: { board: 'main', ref: 'U2', pins: ['1'] }, nets: ['N'] }])), DESIGN_SPEC_CODES.INTERFACE_INVALID, '未知板');

  const duplicateId = clone(validSpec());
  duplicateId.interfaces.push(clone(duplicateId.interfaces[0]));
  assertCode(() => validateDesignSpec(duplicateId), DESIGN_SPEC_CODES.INTERFACE_INVALID, '接口 id 重复');
});

test('design spec: BOM 锁未锁 / 缺料号 / 缺 footprint 抛 BOM_LOCK_INVALID', () => {
  const withLock = (bomLock) => ({ ...validSpec(), bomLock });

  assertCode(() => validateDesignSpec(withLock([{ ref: 'U1', lcscId: 'C11111', value: 'MCU', footprint: 'QFN-32', locked: false }])), DESIGN_SPEC_CODES.BOM_LOCK_INVALID, 'locked=false');
  assertCode(() => validateDesignSpec(withLock([{ ref: 'U1', lcscId: 'C11111', value: 'MCU', footprint: 'QFN-32' }])), DESIGN_SPEC_CODES.BOM_LOCK_INVALID, '缺 locked');
  assertCode(() => validateDesignSpec(withLock([{ ref: 'U1', value: 'MCU', footprint: 'QFN-32', locked: true }])), DESIGN_SPEC_CODES.BOM_LOCK_INVALID, '缺 lcscId/mpn');
  assertCode(() => validateDesignSpec(withLock([{ ref: 'U1', lcscId: 'C11111', value: 'MCU', footprint: '  ', locked: true }])), DESIGN_SPEC_CODES.BOM_LOCK_INVALID, '空 footprint');

  // mpn 与 lcscId 二选一即可
  const mpnOnly = validateDesignSpec(withLock([{ ref: 'Q1', mpn: 'AO3400', value: 'NMOS', footprint: 'SOT-23', locked: true }]));
  assert.equal(mpnOnly.spec.bomLock[0].lcscId, null);
  assert.equal(mpnOnly.spec.bomLock[0].mpn, 'AO3400');
});

test('design spec: 意图网表端点必须是 REF.PIN 且至少两个', () => {
  assertCode(() => validateDesignSpec({ ...validSpec(), netIntent: [{ net: 'BAD', endpoints: ['U1'] }] }), DESIGN_SPEC_CODES.SPEC_INVALID, '端点格式');
  assertCode(() => validateDesignSpec({ ...validSpec(), netIntent: [{ net: 'ONE', endpoints: ['U1.1'] }] }), DESIGN_SPEC_CODES.SPEC_INVALID, '端点不足两个');
  assertCode(() => validateDesignSpec({ ...validSpec(), netIntent: [{ net: 'DUP', endpoints: ['U1.1', 'U2.1'] }, { net: 'DUP', endpoints: ['U1.2', 'U2.2'] }] }), DESIGN_SPEC_CODES.SPEC_INVALID, '网络重复');
});

test('design spec: 需求重复 id 抛 SPEC_INVALID，需求缺证据抛 REQUIREMENT_UNMAPPED', () => {
  const duplicate = clone(validSpec());
  duplicate.requirements.push({ id: 'R1', category: 'drc', requirement: '重复需求' });
  assertCode(() => validateDesignSpec(duplicate), DESIGN_SPEC_CODES.SPEC_INVALID, '需求 id 重复');

  // 有需求但验收矩阵为空 → 需求没被证据覆盖
  assertCode(() => validateDesignSpec({ ...validSpec(), acceptance: [] }), DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, '需求缺证据');

  // 验收项引用未声明需求
  assertCode(() => validateDesignSpec({ ...validSpec(), acceptance: [{ requirementId: 'R404', criterion: 'x', evidenceKind: 'signoff' }] }), DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, '未知需求');

  // 证据类型不在注册表内
  assertCode(() => validateDesignSpec({ ...validSpec(), acceptance: [{ requirementId: 'R1', criterion: 'x', evidenceKind: 'email' }] }), DESIGN_SPEC_CODES.SPEC_INVALID, '未知证据类型');
});

test('DXF 板框: 10×10 正方形面积 100、bounds 10×10、自动闭合', () => {
  const outline = boardOutlineFromPoints([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.equal(outline.areaMm2, 100);
  assert.deepEqual(outline.bounds, { width: 10, height: 10 });
  assert.equal(outline.perimeterMm, 40);
  assert.equal(outline.closed, true);
  assert.equal(outline.points.length, 5);
  assert.deepEqual(outline.points[0], [0, 0]);
  assert.deepEqual(outline.points.at(-1), [0, 0]);

  // 顺时针/逆时针不影响面积
  assert.equal(boardOutlineFromPoints([[0, 0], [0, 10], [10, 10], [10, 0]]).areaMm2, 100);
});

test('DXF 板框: 相邻重复点去重、首尾重复去重', () => {
  const points = [[0, 0], [0, 0], [10, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const normalized = normalizePoints(points);
  assert.deepEqual(normalized, [[0, 0], [10, 0], [10, 10], [0, 10]]);
  // normalizePoints 不补闭合点；boardOutlineFromPoints 才闭合
  const outline = boardOutlineFromPoints(points);
  assert.equal(outline.points.length, 5);
  assert.equal(outline.areaMm2, 100);
});

test('DXF 板框: 接受 {x,y} 点对象与数字字符串', () => {
  const outline = boardOutlineFromPoints([{ x: '0', y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }]);
  assert.equal(outline.areaMm2, 40);
  assert.deepEqual(outline.bounds, { width: 8, height: 5 });
});

test('DXF 板框: 点数<3、面积<=minAreaMm2 抛 OUTLINE_INVALID', () => {
  assertCode(() => boardOutlineFromPoints([[0, 0], [10, 0]]), DESIGN_SPEC_CODES.OUTLINE_INVALID, '点数不足');
  assertCode(() => boardOutlineFromPoints([[0, 0], [10, 0], [10, 0], [0, 0]]), DESIGN_SPEC_CODES.OUTLINE_INVALID, '去重后点数不足');
  assertCode(() => boardOutlineFromPoints([[0, 0], [5, 0], [10, 0]]), DESIGN_SPEC_CODES.OUTLINE_INVALID, '共线面积为 0');
  assertCode(() => boardOutlineFromPoints([[0, 0], [10, 0], [10, 10], [0, 10]], { minAreaMm2: 100 }), DESIGN_SPEC_CODES.OUTLINE_INVALID, '面积未超过门槛');
  assertCode(() => boardOutlineFromPoints([[0, 0], [10, 0], [10, 10], [0, 10]], { minAreaMm2: -1 }), DESIGN_SPEC_CODES.OUTLINE_INVALID, '负门槛');
  assertCode(() => boardOutlineFromPoints('not-points'), DESIGN_SPEC_CODES.OUTLINE_INVALID, '非数组');
});

test('矩形 outline: 由宽高生成通用矩形，不写死坐标', () => {
  const outline = outlineFromBoardSizes({ widthMm: 12.5, heightMm: 8 });
  assert.deepEqual(outline.points, [[0, 0], [12.5, 0], [12.5, 8], [0, 8], [0, 0]]);
  assert.deepEqual(outline.bounds, { width: 12.5, height: 8 });
  assert.equal(outline.areaMm2, 100);
  assert.equal(outline.perimeterMm, 41);
  assert.equal(outline.closed, true);

  assertCode(() => outlineFromBoardSizes({ widthMm: 10, heightMm: 0 }), DESIGN_SPEC_CODES.OUTLINE_INVALID, 'height=0');
  assertCode(() => outlineFromBoardSizes({}), DESIGN_SPEC_CODES.OUTLINE_INVALID, '缺尺寸');
});

test('buildDesignSpec: 需求映射为验收证据，缺 acceptance 时给默认 criterion 并标 needsReview', () => {
  const spec = buildDesignSpec({
    project: { name: '通用需求映射测试' },
    boards: [
      { id: 'main', name: '主板', layers: 4, outline: { widthMm: 30, heightMm: 20 } },
      { id: 'aux', name: '副板', layers: 2, outline: { points: [[0, 0], [10, 0], [10, 10], [0, 10]] } },
    ],
    interfaces: [{ id: 'if-1', from: { board: 'main', ref: 'U1', pins: ['1', '2'] }, to: { board: 'aux', ref: 'J1', pins: ['1', '2'] }, nets: ['VBUS', 'GND'] }],
    netIntent: [{ net: 'VBUS', endpoints: ['U1.1', 'J1.1'] }, { net: 'GND', endpoints: ['U1.2', 'J1.2'] }],
    bomLock: [{ ref: 'U1', lcscId: 'C11111', value: 'MCU', footprint: 'QFN-32', locked: true }],
    requirements: [
      { id: 'R1', category: 'schematic', requirement: '原理图网表与意图一致' },
      { id: 'R2', category: 'pcb-layout', requirement: '关键信号满足间距规则' },
      { id: 'R3', category: 'custom-firmware', requirement: '固件版本与 BOM 一致', acceptance: [{ criterion: '版本号逐项核对', evidenceKind: 'signoff' }] },
    ],
  });

  assert.equal(validateDesignSpec(spec).ok, true);
  assert.equal(spec.requirements.length, 3);
  assert.equal(spec.acceptance.length, 3);
  // R1 缺 acceptance → 默认 criterion + 分类推断证据 + needsReview:true
  const r1 = spec.acceptance.find((item) => item.requirementId === 'R1');
  assert.equal(r1.evidenceKind, 'schematic-erc');
  assert.match(r1.criterion, /满足需求：原理图网表与意图一致/);
  assert.equal(r1.needsReview, true);
  // R2 分类 → drc-report，同样需要人工复核
  const r2 = spec.acceptance.find((item) => item.requirementId === 'R2');
  assert.equal(r2.evidenceKind, 'drc-report');
  assert.equal(r2.needsReview, true);
  // R3 显式证据 → 不标 needsReview
  const r3 = spec.acceptance.find((item) => item.requirementId === 'R3');
  assert.equal(r3.evidenceKind, 'signoff');
  assert.equal(r3.needsReview, false);
  assert.equal(r3.criterion, '版本号逐项核对');

  // 同样输入两次，输出完全一致（无时间戳/随机数，可哈希）
  const rebuilt = buildDesignSpec({
    project: { name: '通用需求映射测试' },
    boards: spec.boards,
    interfaces: spec.interfaces,
    netIntent: spec.netIntent,
    bomLock: spec.bomLock,
    requirements: [
      { id: 'R1', category: 'schematic', requirement: '原理图网表与意图一致' },
      { id: 'R2', category: 'pcb-layout', requirement: '关键信号满足间距规则' },
      { id: 'R3', category: 'custom-firmware', requirement: '固件版本与 BOM 一致', acceptance: [{ criterion: '版本号逐项核对', evidenceKind: 'signoff' }] },
    ],
  });
  assert.deepEqual(rebuilt, spec);
});

test('buildDesignSpec: 需求重复 id 抛 SPEC_INVALID', () => {
  const build = (requirements) => buildDesignSpec({
    project: { name: '重复需求' },
    boards: [{ id: 'main', name: '主板', layers: 2, outline: { widthMm: 10, heightMm: 10 } }],
    requirements,
  });
  assertCode(() => build([{ id: 'R1', category: 'drc', requirement: 'a' }, { id: 'R1', category: 'drc', requirement: 'b' }]), DESIGN_SPEC_CODES.SPEC_INVALID, '需求 id 重复');
  assertCode(() => build([{ id: '', category: 'drc', requirement: 'a' }]), DESIGN_SPEC_CODES.SPEC_INVALID, '需求 id 为空');
});

test('buildDesignSpec: 无法映射证据类型时抛 REQUIREMENT_UNMAPPED', () => {
  const base = {
    project: { name: '证据映射失败' },
    boards: [{ id: 'main', name: '主板', layers: 2, outline: { widthMm: 10, heightMm: 10 } }],
  };
  // 分类无法推断且没给显式 acceptance
  assertCode(() => buildDesignSpec({ ...base, requirements: [{ id: 'R1', category: 'magic-category', requirement: '神秘需求' }] }), DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, '分类不可映射');
  // 显式证据类型不受支持
  assertCode(() => buildDesignSpec({ ...base, requirements: [{ id: 'R1', category: 'drc', requirement: '间距', acceptance: [{ criterion: 'x', evidenceKind: 'email' }] }] }), DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, '证据类型非法');
  // acceptance 显式给 criterion 但证据类型无法推断
  assertCode(() => buildDesignSpec({ ...base, requirements: [{ id: 'R1', category: 'magic-category', requirement: '神秘需求', acceptance: [{ criterion: '人工确认' }] }] }), DESIGN_SPEC_CODES.REQUIREMENT_UNMAPPED, '缺证据类型');
  // 证据类型目录可供调用方查询
  assert.ok(DESIGN_SPEC_EVIDENCE_KINDS.includes(evidenceKindForCategory('pcb-layout')));
});

test('buildDesignSpec: 生成的 spec 缺板/尺寸非法时仍然 fail-closed', () => {
  assertCode(() => buildDesignSpec({ project: { name: '无板' }, requirements: [] }), DESIGN_SPEC_CODES.SPEC_INVALID, '缺 boards');
  assertCode(() => buildDesignSpec({ project: { name: '坏板框' }, boards: [{ id: 'main', name: '主板', layers: 2, outline: { widthMm: 0, heightMm: 10 } }] }), DESIGN_SPEC_CODES.OUTLINE_INVALID, '尺寸非法');
});
