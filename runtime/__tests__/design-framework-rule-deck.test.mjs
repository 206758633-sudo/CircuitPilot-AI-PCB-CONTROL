/**
 * Rule-as-Code 层测试：IPC 近似公式 / 151 条规则判定器 / KiCad DRC 适配器。
 *
 * 覆盖原则（与交付要求一致）：
 *   - IPC：单调性、内外层差异、非法输入 fail-closed、量级合理性（范围断言，不抄外部数值）；
 *   - rule deck：151 条全部出现、状态合法、digest 稳定、可以 FAIL 的硬判据真能 FAIL、
 *     缺事实必须 REVIEW 而不是 PASS、coverage 与 summary 自洽；
 *   - kicad：缺失/输入缺失/伪 CLI 成功/报告非法/超时 → 各错误码，绝不假装 0 违规。
 *
 * 全程离线：伪 kicad-cli 是临时目录里的 node 脚本，不连真实 KiCad。
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createBoardModel } from '../design-framework/board-model.mjs';
import {
  IPC_CLEARANCE_TABLE,
  IPC_CODES,
  TABLE,
  copperCrossSectionMm2,
  currentCapacityA,
  currentDensityAPerMm2,
  minClearanceMm,
  viaCurrentCapacityA,
  widthForCurrent,
} from '../design-framework/ipc-rules.mjs';
import {
  RULE_CHECKERS,
  RULE_PACK,
  RULE_STATUS,
  evaluateRuleDeck,
  isHardGateLevel,
  ruleDeckCoverage,
} from '../design-framework/rule-deck.mjs';
import {
  KICAD_DRC_CODES,
  detectKicadCli,
  parseKicadDrcReport,
  runKicadDrc,
} from '../design-framework/kicad-drc.mjs';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/** 一块"证据基本齐全"的板：60×40、2 层、QFN+0402、Mark/安装孔/高度/ courtyard 都有。 */
const goodInput = () => ({
  board: {
    widthMm: 60,
    heightMm: 40,
    layers: 2,
    thicknessMm: 1.6,
    copperOz: 1,
    outline: [[0, 0], [60, 0], [60, 40], [0, 40], [0, 0]],
    mountingHoles: [{ x: 3, y: 3, diaMm: 2.2 }, { x: 57, y: 37, diaMm: 2.2 }],
    fiducials: [{ x: 5, y: 5, diaMm: 1 }, { x: 55, y: 5, diaMm: 1 }, { x: 55, y: 35, diaMm: 1 }],
  },
  components: [
    { ref: 'U1', footprint: 'QFN-32', xMm: 20, yMm: 20, widthMm: 5, heightMm: 5, courtyardMm: 0.25, heightMm3d: 1.0, rotationDeg: 0 },
    { ref: 'C1', footprint: '0402', xMm: 28, yMm: 20, widthMm: 1, heightMm: 0.5, courtyardMm: 0.25, heightMm3d: 0.5 },
  ],
  nets: [{ name: '3V3', pins: ['U1.1', 'C1.1'], kind: 'power', currentA: 0.3 }],
  rules: { fabProfile: 'JLCPCB:2L-1oz', minTraceWidthMm: 0.15, targetImpedanceOhm: 50 },
});

const drcEvidence = () => ({ ok: true, exitCode: 0, findings: [], counts: { violations: 0, errors: 0, warnings: 0, total: 0 }, reportDigest: 'f'.repeat(64) });
const fabAuditEvidence = () => ({ summary: { PASS: 10, FAIL: 0, REVIEW: 0, NA: 6 }, fab: 'JLCPCB', variant: '2L-1oz', auditHash: 'audit-hash' });

const findingOf = (result, ruleId) => {
  const finding = result.findings.find((item) => item.ruleId === ruleId);
  assert.ok(finding, `findings 里缺少规则 ${ruleId}`);
  return finding;
};

const evaluateGood = (options = {}) => evaluateRuleDeck(createBoardModel(goodInput()), {
  traceWidths: { '3V3': { widthMm: 0.5, layer: 'outer', thicknessOz: 1 } },
  drc: drcEvidence(),
  fabAudit: fabAuditEvidence(),
  ...options,
});

/* ------------------------------------------------------------------ */
/* IPC 公式                                                            */
/* ------------------------------------------------------------------ */

test('IPC currentCapacityA：宽度/铜厚/温升单调，外层 > 内层，量级合理', () => {
  const narrow = currentCapacityA({ widthMm: 0.2, thicknessOz: 1, layer: 'outer', tempRiseC: 10 });
  const medium = currentCapacityA({ widthMm: 0.5, thicknessOz: 1, layer: 'outer', tempRiseC: 10 });
  const wide = currentCapacityA({ widthMm: 1.0, thicknessOz: 1, layer: 'outer', tempRiseC: 10 });
  assert.equal(narrow.ok, true);
  assert.equal(medium.ok, true);
  assert.equal(wide.ok, true);
  assert.ok(narrow.ampacityA < medium.ampacityA && medium.ampacityA < wide.ampacityA, '宽度越大载流越大');
  assert.ok(narrow.ampacityA > 0.1 && narrow.ampacityA < 3, `0.2mm/1oz/10℃ 量级异常：${narrow.ampacityA}`);
  assert.ok(wide.ampacityA > 1 && wide.ampacityA < 12, `1.0mm/1oz/10℃ 量级异常：${wide.ampacityA}`);

  const thick = currentCapacityA({ widthMm: 1, thicknessOz: 2, layer: 'outer', tempRiseC: 10 });
  assert.ok(thick.ampacityA > wide.ampacityA, '2 oz 同宽度载流应更大');

  const hot = currentCapacityA({ widthMm: 1, thicknessOz: 1, layer: 'outer', tempRiseC: 30 });
  assert.ok(hot.ampacityA > wide.ampacityA, '允许温升越大载流越大');

  const inner = currentCapacityA({ widthMm: 1, thicknessOz: 1, layer: 'inner', tempRiseC: 10 });
  assert.ok(inner.ampacityA < wide.ampacityA, '内层散热差，同截面载流应更小');
  assert.ok(Math.abs(inner.k - 0.024) < 1e-12 && Math.abs(wide.k - 0.048) < 1e-12);
  assert.match(wide.formula, /ΔT\^0\.44/);
  assert.ok(Array.isArray(wide.assumptions) && wide.assumptions.length >= 2);
  assert.equal(wide.source.includes('IPC-2221'), true);

  // 截面积与手算一致：widthMm × 1.378 / 0.0254
  assert.ok(Math.abs(wide.crossSectionMil2 - (1 / 0.0254) * 1.378) < 1e-9);
});

test('IPC currentCapacityA：非法参数 fail-closed（IPC_INVALID_INPUT）', () => {
  const invalidInputs = [
    { widthMm: 0 },
    { widthMm: -1 },
    { widthMm: Number.NaN },
    { widthMm: 1, thicknessOz: 0 },
    { widthMm: 1, thicknessOz: -0.5 },
    { widthMm: 1, layer: 'mid' },
    { widthMm: 1, tempRiseC: 0 },
    { widthMm: 1, tempRiseC: 500 },
    { widthMm: '1' },
  ];
  for (const input of invalidInputs) {
    const result = currentCapacityA(input);
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(input)}`);
    assert.equal(result.code, IPC_CODES.INVALID_INPUT);
    assert.equal(typeof result.field, 'string');
    assert.equal(typeof result.message, 'string');
    assert.equal(result.ampacityA, undefined);
  }
});

test('IPC widthForCurrent：反解自洽、minWidth 夹紧、maxWidth 不可行、非法输入 fail-closed', () => {
  for (const currentA of [0.2, 1, 3]) {
    const solved = widthForCurrent({ currentA, thicknessOz: 1, layer: 'outer', tempRiseC: 10 });
    assert.equal(solved.ok, true);
    assert.ok(solved.widthMm > 0 && solved.widthMm < 20);
    assert.ok(solved.ampacityA + 1e-9 >= currentA, '反解宽度回算载流应 ≥ 目标电流');
    assert.ok(solved.marginA >= -1e-9);
    assert.equal(solved.feasible, true);
  }
  // 微安级电流 → 夹紧到工艺最小线宽
  const clamped = widthForCurrent({ currentA: 1e-6, minWidthMm: 0.05 });
  assert.equal(clamped.ok, true);
  assert.ok(Math.abs(clamped.widthMm - 0.05) < 1e-12);
  assert.ok(clamped.marginA > 0);
  // 要求远超工艺上限 → feasible:false，如实返回超窗口宽度
  const infeasible = widthForCurrent({ currentA: 20, maxWidthMm: 0.5 });
  assert.equal(infeasible.ok, true);
  assert.equal(infeasible.feasible, false);
  assert.ok(infeasible.widthMm > 0.5);

  assert.equal(widthForCurrent({ currentA: 0 }).code, IPC_CODES.INVALID_INPUT);
  assert.equal(widthForCurrent({ currentA: 1, minWidthMm: 0 }).ok, false);
  assert.equal(widthForCurrent({ currentA: 1, minWidthMm: 0.2, maxWidthMm: 0.1 }).ok, false);
  assert.equal(widthForCurrent({ currentA: 1, layer: 'buried' }).ok, false);
});

test('IPC viaCurrentCapacityA：正数结果、镀层/孔径单调、非法输入 fail-closed', () => {
  const base = viaCurrentCapacityA({ diameterMm: 0.5, holeMm: 0.3, platingUm: 25, tempRiseC: 10 });
  assert.equal(base.ok, true);
  assert.ok(base.ampacityA > 0 && base.ampacityA < 5, `过孔载流量级异常：${base.ampacityA}`);
  const thickPlating = viaCurrentCapacityA({ diameterMm: 0.5, holeMm: 0.3, platingUm: 50 });
  assert.ok(thickPlating.ampacityA > base.ampacityA);
  const bigger = viaCurrentCapacityA({ diameterMm: 0.7, holeMm: 0.3, platingUm: 25 });
  assert.ok(bigger.ampacityA > base.ampacityA);
  assert.equal(base.k, 0.024);
  assert.match(base.formula, /π/);

  assert.equal(viaCurrentCapacityA({ diameterMm: 0.3, holeMm: 0.3 }).code, IPC_CODES.INVALID_INPUT, '外径必须大于孔径');
  assert.equal(viaCurrentCapacityA({ diameterMm: 0.5, holeMm: 0 }).code, IPC_CODES.INVALID_INPUT);
  assert.equal(viaCurrentCapacityA({ diameterMm: 0.5, holeMm: 0.3, platingUm: 0 }).code, IPC_CODES.INVALID_INPUT);
});

test('IPC minClearanceMm：档位单调、涂覆/内外层关系、外推警告、非法输入 fail-closed', () => {
  assert.ok(IPC_CLEARANCE_TABLE.length >= 5);
  assert.equal(TABLE, IPC_CLEARANCE_TABLE, 'TABLE 是 IPC_CLEARANCE_TABLE 的导出别名');

  const low = minClearanceMm({ voltageV: 5, coated: false, external: true });
  const mid = minClearanceMm({ voltageV: 120, coated: false, external: true });
  const high = minClearanceMm({ voltageV: 400, coated: false, external: true });
  assert.equal(low.ok, true);
  assert.ok(low.clearanceMm <= mid.clearanceMm && mid.clearanceMm <= high.clearanceMm, '电压档位越高间距要求越大');
  assert.ok(low.clearanceMm > 0);

  assert.ok(minClearanceMm({ voltageV: 100, coated: true }).clearanceMm <= minClearanceMm({ voltageV: 100, coated: false }).clearanceMm, '涂覆后间距要求不应更高');
  assert.ok(minClearanceMm({ voltageV: 300, external: false }).clearanceMm <= minClearanceMm({ voltageV: 300, external: true }).clearanceMm, '内层间距要求不应高于外层（同表）');

  const extrapolated = minClearanceMm({ voltageV: 700, coated: false, external: true });
  assert.equal(extrapolated.ok, true);
  assert.ok(extrapolated.clearanceMm > high.clearanceMm);
  assert.equal(typeof extrapolated.warn, 'string');

  assert.equal(minClearanceMm({ voltageV: -1 }).code, IPC_CODES.INVALID_INPUT);
  assert.equal(minClearanceMm({ voltageV: Number.NaN }).code, IPC_CODES.INVALID_INPUT);
  assert.equal(minClearanceMm({ voltageV: 12, coated: 'yes' }).code, IPC_CODES.INVALID_INPUT);
  assert.equal(minClearanceMm({ voltageV: 12, external: 1 }).code, IPC_CODES.INVALID_INPUT);
});

test('IPC 辅助函数：铜截面/电流密度与输入校验', () => {
  const section = copperCrossSectionMm2({ widthMm: 1, thicknessOz: 1 });
  assert.equal(section.ok, true);
  assert.ok(Math.abs(section.crossSectionMm2 - 0.03479) < 1e-9);
  const density = currentDensityAPerMm2({ currentA: 1, widthMm: 1, thicknessOz: 1 });
  assert.equal(density.ok, true);
  assert.ok(density.currentDensityAPerMm2 > 20 && density.currentDensityAPerMm2 < 40);
  assert.equal(copperCrossSectionMm2({ widthMm: 0 }).code, IPC_CODES.INVALID_INPUT);
});

/* ------------------------------------------------------------------ */
/* Rule deck                                                           */
/* ------------------------------------------------------------------ */

test('RULE_PACK：151 条规则、字段/等级/分组计数自洽、digest 稳定', () => {
  assert.equal(RULE_PACK.total, 151);
  assert.equal(RULE_PACK.rules.length, 151);
  assert.equal(new Set(RULE_PACK.rules.map((rule) => rule.id)).size, 151);
  assert.equal(RULE_PACK.digest.length, 64);
  const levelTotal = Object.values(RULE_PACK.levelCounts).reduce((sum, count) => sum + count, 0);
  assert.equal(levelTotal, 151);
  assert.equal(Object.keys(RULE_PACK.levelCounts).includes('硬门禁'), true);
  assert.equal(isHardGateLevel('硬门禁'), true);
  assert.equal(isHardGateLevel('推荐'), false);
  assert.equal(isHardGateLevel('blocking'), true);
  assert.equal(isHardGateLevel(undefined), true, '等级缺失按最严处理');
});

test('RULE_CHECKERS：≥30 条机器判据、全部对应规则包、覆盖 ≥8 个 group', () => {
  const checkerIds = Object.keys(RULE_CHECKERS);
  assert.ok(checkerIds.length >= 30, `机器判据只有 ${checkerIds.length} 条`);
  const packIds = new Set(RULE_PACK.rules.map((rule) => rule.id));
  for (const ruleId of checkerIds) {
    assert.ok(packIds.has(ruleId), `checker ${ruleId} 不在规则包内`);
    assert.equal(typeof RULE_CHECKERS[ruleId], 'function');
  }
  const groups = new Set(RULE_PACK.rules.filter((rule) => checkerIds.includes(rule.id)).map((rule) => rule.group));
  assert.ok(groups.size >= 8, `覆盖 group 只有 ${groups.size} 个：${[...groups].join(',')}`);
});

test('evaluateRuleDeck：151 条全出现、状态合法、摘要自洽、两次 digest 一致', () => {
  const model = createBoardModel(goodInput());
  const first = evaluateRuleDeck(model);
  const second = evaluateRuleDeck(createBoardModel(goodInput()));
  assert.equal(first.ok, true);
  assert.equal(first.findings.length, 151);
  assert.equal(new Set(first.findings.map((finding) => finding.ruleId)).size, 151);
  const legal = new Set(Object.values(RULE_STATUS));
  for (const finding of first.findings) {
    assert.ok(legal.has(finding.status), `${finding.ruleId} 状态非法：${finding.status}`);
    assert.equal(typeof finding.message, 'string');
    assert.equal(typeof finding.group, 'string');
    assert.equal(typeof finding.level, 'string');
  }
  const { summary } = first;
  assert.equal(summary.total, 151);
  assert.equal(summary.pass + summary.fail + summary.review + summary.na, 151);
  assert.equal(summary.machineCheckable, Object.keys(RULE_CHECKERS).length);
  assert.ok(Math.abs(summary.coverageRatio - summary.machineCheckable / 151) < 1e-12);
  assert.equal(first.digest, second.digest, '同 model 两次判定 digest 必须一致');
  assert.equal(first.modelDigest, second.modelDigest);
  assert.equal(first.digest.length, 64);
  assert.equal(summary.releaseReady, summary.blocking === 0 && summary.review === 0);

  // 改一个器件坐标 → findings digest 变
  const moved = goodInput();
  moved.components[1].xMm = 30;
  assert.notEqual(evaluateRuleDeck(createBoardModel(moved)).digest, first.digest);
});

test('evaluateRuleDeck：无机器判据的规则判 REVIEW（NO_MACHINE_CHECKER），不给 PASS', () => {
  const result = evaluateRuleDeck(createBoardModel(goodInput()));
  const noCheckerRule = result.findings.find((finding) => finding.ruleId === 'MECH-03');
  assert.equal(noCheckerRule.status, RULE_STATUS.REVIEW);
  assert.equal(noCheckerRule.evidence.reason, 'NO_MACHINE_CHECKER');
  assert.equal(noCheckerRule.machineCheckable, false);
  const silk = result.findings.find((finding) => finding.ruleId === 'SILK-05');
  assert.equal(silk.status, RULE_STATUS.REVIEW);
});

test('evaluateRuleDeck：缺事实字段 → REVIEW 而非 PASS（板框/证据/走线/DRC）', () => {
  const bare = evaluateRuleDeck(createBoardModel({ board: { widthMm: 40, heightMm: 30 } }));
  for (const ruleId of ['MECH-01', 'MECH-02', 'DFM-15', 'PWR-05', 'GATE-02', 'ZCLR-05']) {
    const finding = findingOf(bare, ruleId);
    assert.equal(finding.status, RULE_STATUS.REVIEW, `${ruleId} 缺事实时应 REVIEW，实际 ${finding.status}`);
    assert.equal(finding.evidence.reason, 'FACT_MISSING', `${ruleId} 应带 FACT_MISSING`);
  }
  // 缺 3D 高度是"缺证据"而不是设计违规：ZCLR-01 必须 REVIEW，绝不能 FAIL（金板闭环 blocked 回归）
  const noHeight = evaluateRuleDeck(createBoardModel({ board: { widthMm: 40, heightMm: 30 }, components: [{ ref: 'U1', xMm: 20, yMm: 15, widthMm: 5, heightMm: 5 }] }));
  const zclr01 = findingOf(noHeight, 'ZCLR-01');
  assert.equal(zclr01.status, RULE_STATUS.REVIEW, '缺 heightMm3d 应 REVIEW 而非 FAIL');
  assert.equal(zclr01.evidence.reason, 'FACT_MISSING');
  assert.deepEqual(zclr01.evidence.missingRefs, ['U1']);
  assert.equal(zclr01.evidence.missingFields.includes('heightMm3d'), true);
  // 有器件但没有任何 antenna 标注：RF-12 仍不能给 PASS
  const untagged = evaluateRuleDeck(createBoardModel(goodInput()));
  assert.equal(findingOf(untagged, 'RF-12').status, RULE_STATUS.REVIEW);
  // 完全没给 traceWidths 的 PWR-05 也不能给 PASS
  assert.notEqual(findingOf(evaluateRuleDeck(createBoardModel(goodInput())), 'PWR-05').status, RULE_STATUS.PASS);
});

test('evaluateRuleDeck：证据齐全时关键规则真能给 PASS（good fixture）', () => {
  const result = evaluateGood();
  const expectPass = ['MECH-01', 'MECH-02', 'MECH-05', 'MECH-14', 'SPACE-01', 'SPACE-02', 'SPACE-07', 'SPACE-14', 'SPACE-16',
    'ZCLR-01', 'ZCLR-02', 'CONN-05', 'PWR-05', 'DFM-01', 'DFM-11', 'DFM-15', 'DFA-01', 'GATE-02', 'GATE-03', 'PRJ-02'];
  for (const ruleId of expectPass) {
    assert.equal(findingOf(result, ruleId).status, RULE_STATUS.PASS, `${ruleId} 应 PASS，实际信息：${findingOf(result, ruleId).message}`);
  }
  assert.equal(result.summary.fail, 0, `good fixture 不应有 FAIL：${result.findings.filter((finding) => finding.status === 'FAIL').map((finding) => `${finding.ruleId}:${finding.message}`).join(' | ')}`);
  assert.equal(result.summary.blocking, 0);
  assert.ok(result.summary.review > 0);
  assert.equal(result.summary.releaseReady, false, '仍有 REVIEW，不得 releaseReady');
});

test('evaluateRuleDeck：同面器件本体重叠 → SPACE-02/ZCLR-02 FAIL 且计入 blocking', () => {
  const input = goodInput();
  input.components[1] = { ...input.components[1], xMm: 21, yMm: 20 };
  const result = evaluateRuleDeck(createBoardModel(input));
  const space = findingOf(result, 'SPACE-02');
  const zclr = findingOf(result, 'ZCLR-02');
  assert.equal(space.status, RULE_STATUS.FAIL);
  assert.equal(zclr.status, RULE_STATUS.FAIL);
  assert.ok(result.summary.blocking >= 1);
  assert.ok(result.summary.fail >= 2);
  assert.equal(result.summary.releaseReady, false);
  assert.ok(space.evidence.violations.length >= 1);
});

test('evaluateRuleDeck：器件出板/贴边 → MECH-05 FAIL', () => {
  const input = goodInput();
  input.components[0] = { ...input.components[0], xMm: 1, yMm: 20 };
  const result = evaluateRuleDeck(createBoardModel(input));
  const finding = findingOf(result, 'MECH-05');
  assert.equal(finding.status, RULE_STATUS.FAIL);
  assert.ok(finding.evidence.violations.some((item) => item.ref === 'U1'));
  assert.ok(finding.message.includes('U1'));
});

test('evaluateRuleDeck：高件落入 keepout/禁布区 → ZCLR-05 FAIL', () => {
  const input = goodInput();
  input.components[0] = { ...input.components[0], heightMm3d: 6.0 }; // 高件 >5 mm
  input.board.keepouts = [{ id: 'CABLE-KO', x0: 17, y0: 17, x1: 23, y1: 23, reason: '线缆禁布' }];
  const result = evaluateRuleDeck(createBoardModel(input));
  const finding = findingOf(result, 'ZCLR-05');
  assert.equal(finding.status, RULE_STATUS.FAIL);
  assert.equal(finding.evidence.violations[0].ref, 'U1');
  assert.equal(finding.evidence.violations[0].keepoutId, 'CABLE-KO');
});

test('evaluateRuleDeck：电流超过走线宽度 → PWR-05 FAIL；窗口不够 → REVIEW', () => {
  const input = goodInput();
  input.nets = [{ name: 'VBUS', pins: ['U1.1', 'C1.1'], kind: 'power', currentA: 3 }];
  input.rules = { ...input.rules };
  const model = createBoardModel(input);
  const failed = evaluateRuleDeck(model, { traceWidths: { VBUS: { widthMm: 0.2, layer: 'outer', thicknessOz: 1 } } });
  const failFinding = findingOf(failed, 'PWR-05');
  assert.equal(failFinding.status, RULE_STATUS.FAIL);
  assert.ok(failFinding.evidence.violations[0].requiredWidthMm > 0.2);
  assert.ok(failFinding.message.includes('VBUS'));

  const reviewed = evaluateRuleDeck(model, { traceWidths: { OTHER: 0.5 } });
  assert.equal(findingOf(reviewed, 'PWR-05').status, RULE_STATUS.REVIEW);
  // 没注入 traceWidths 时同样 REVIEW（IR 不含走线几何）
  assert.equal(findingOf(evaluateRuleDeck(model), 'PWR-05').status, RULE_STATUS.REVIEW);

  // 加宽到满足要求后 PASS
  const wide = evaluateRuleDeck(model, { traceWidths: { VBUS: { widthMm: 3.0, layer: 'outer', thicknessOz: 1 } } });
  assert.equal(findingOf(wide, 'PWR-05').status, RULE_STATUS.PASS);
});

test('evaluateRuleDeck：includeNa=false 只影响 findings，不影响 summary 统计', () => {
  const model = createBoardModel(goodInput());
  const full = evaluateRuleDeck(model);
  const filtered = evaluateRuleDeck(model, { includeNa: false });
  assert.ok(full.findings.some((finding) => finding.status === RULE_STATUS.NA));
  assert.equal(filtered.findings.some((finding) => finding.status === RULE_STATUS.NA), false);
  assert.equal(filtered.findings.length, full.findings.length - full.summary.na);
  assert.deepEqual(filtered.summary, full.summary);
  assert.equal(filtered.digest, full.digest, 'digest 基于全部 findings，不受 includeNa 影响');
});

test('evaluateRuleDeck：间距/AOI/连接器净距/阻抗/噪声源等机器判据能真判 FAIL', () => {
  // QFN 与 0402 贴得过近 → SPACE-07（要求 ≥0.5 mm）
  const tight = goodInput();
  tight.components[1] = { ...tight.components[1], xMm: 23 };
  assert.equal(findingOf(evaluateRuleDeck(createBoardModel(tight)), 'SPACE-07').status, RULE_STATUS.FAIL);

  // 同板边两个连接器净距 1 mm → CONN-04（要求 ≥3 mm）
  const connectors = goodInput();
  connectors.components = [
    { ref: 'J1', footprint: 'USB-C', xMm: 20, yMm: 10, widthMm: 10, heightMm: 6, courtyardMm: 0.25, heightMm3d: 3 },
    { ref: 'J2', footprint: 'USB-A', xMm: 31, yMm: 10, widthMm: 10, heightMm: 6, courtyardMm: 0.25, heightMm3d: 3 },
  ];
  connectors.nets = [];
  const connResult = evaluateRuleDeck(createBoardModel(connectors));
  assert.equal(findingOf(connResult, 'CONN-04').status, RULE_STATUS.FAIL);
  assert.ok(findingOf(connResult, 'CONN-04').message.includes('J1'));

  // 功率电感距天线 1.5 mm → RF-12（要求 ≥15 mm）
  const rf = goodInput();
  rf.components = [
    { ref: 'ANT1', tags: ['antenna'], xMm: 10, yMm: 10, widthMm: 5, heightMm: 5, courtyardMm: 0.25, heightMm3d: 1 },
    { ref: 'L1', tags: ['inductor'], xMm: 16, yMm: 10, widthMm: 4, heightMm: 4, courtyardMm: 0.25, heightMm3d: 1 },
  ];
  rf.nets = [];
  assert.equal(findingOf(evaluateRuleDeck(createBoardModel(rf)), 'RF-12').status, RULE_STATUS.FAIL);

  // 受控阻抗 40Ω vs 目标 50Ω → DFM-09 FAIL（±10% 窗口）
  const impedance = goodInput();
  impedance.nets = [{ name: 'USB_DP', pins: ['U1.1', 'C1.1'], impedanceOhm: 40 }];
  const impedanceResult = evaluateRuleDeck(createBoardModel(impedance));
  assert.equal(findingOf(impedanceResult, 'DFM-09').status, RULE_STATUS.FAIL);
  assert.ok(findingOf(impedanceResult, 'DFM-09').message.includes('USB_DP'));

  // 8 mm 高件与 1 mm 外低件：高差 7 mm > 水平距离 3 mm → DFA-10 FAIL（45° 视线）
  const occlusion = goodInput();
  occlusion.components[0] = { ...occlusion.components[0], heightMm3d: 8 };
  occlusion.components[1] = { ...occlusion.components[1], xMm: 26 };
  assert.equal(findingOf(evaluateRuleDeck(createBoardModel(occlusion)), 'DFA-10').status, RULE_STATUS.FAIL);

  // GATE-02：DRC 有违规 → FAIL；GATE-03：DFM 审计仍有 REVIEW → REVIEW
  const model = createBoardModel(goodInput());
  const drcFail = evaluateRuleDeck(model, { drc: { ok: true, exitCode: 1, counts: { violations: 2, errors: 2 }, findings: [] } });
  assert.equal(findingOf(drcFail, 'GATE-02').status, RULE_STATUS.FAIL);
  const fabReview = evaluateRuleDeck(model, { fabAudit: { summary: { PASS: 1, FAIL: 0, REVIEW: 3, NA: 0 } } });
  assert.equal(findingOf(fabReview, 'GATE-03').status, RULE_STATUS.REVIEW);
  const drcMissing = evaluateRuleDeck(model);
  assert.equal(findingOf(drcMissing, 'GATE-02').status, RULE_STATUS.REVIEW, '没有 DRC 证据不能判 PASS');
});

test('evaluateRuleDeck：非法板级 IR 不抛异常、返回 RULE_DECK_MODEL_INVALID', () => {
  const result = evaluateRuleDeck({ board: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RULE_DECK_MODEL_INVALID');
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary, null);
  assert.equal(result.digest, null);
});

test('ruleDeckCoverage：总数/分组/coverage 与 checker 一致', () => {
  const coverage = ruleDeckCoverage();
  assert.equal(coverage.total, 151);
  assert.equal(coverage.machineCheckable, Object.keys(RULE_CHECKERS).length);
  assert.ok(Math.abs(coverage.coverageRatio - coverage.machineCheckable / 151) < 1e-12);
  assert.equal(coverage.groups.reduce((sum, group) => sum + group.total, 0), 151);
  assert.equal(coverage.groups.reduce((sum, group) => sum + group.machineCheckable, 0), coverage.machineCheckable);
  assert.equal(coverage.implementedRuleIds.length, coverage.machineCheckable);
  assert.equal(coverage.implementedRuleIds.length + coverage.unimplementedRuleIds.length, 151);
  const mech = coverage.groups.find((group) => group.group === 'MECH');
  assert.ok(mech.machineCheckable >= 4);
  assert.ok(mech.coverageRatio > 0 && mech.coverageRatio < 1);
  assert.deepEqual([...mech.implementedRuleIds].sort(), ['MECH-01', 'MECH-02', 'MECH-05', 'MECH-14']);
});

/* ------------------------------------------------------------------ */
/* KiCad DRC 适配器（伪 CLI，不连真实 KiCad）                           */
/* ------------------------------------------------------------------ */

let tempRoot;
before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'rule-deck-kicad-'));
});
after(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

/** 造一个可执行的伪 kicad-cli（node 脚本）。 */
function makeFakeCli(name, { report = null, exitCode = 0, stdoutOnly = false, invalidJson = false, rawReport = null, sleepMs = null } = {}) {
  const cliPath = join(tempRoot, name);
  const payload = rawReport ?? JSON.stringify(report ?? { violations: [] });
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('8.0.1'); process.exit(0); }
${sleepMs === null ? '' : `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${Number(sleepMs)});`}
if (args[0] === 'pcb' && args[1] === 'drc') {
  const outIndex = args.indexOf('--output');
  const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
  const payload = ${JSON.stringify(payload)};
  if (outPath && !${stdoutOnly ? 'true' : 'false'}) fs.writeFileSync(outPath, payload);
  else process.stdout.write(payload);
  process.exit(${Number(exitCode) || 0});
}
process.exit(7);
`;
  writeFileSync(cliPath, script, 'utf8');
  chmodSync(cliPath, 0o755);
  const pcbFile = join(tempRoot, `${name}.kicad_pcb`);
  writeFileSync(pcbFile, '(kicad_pcb (version 20240101))', 'utf8');
  return { cliPath, pcbFile };
}

test('detectKicadCli：伪 CLI 可用并报版本；不存在命令如实 available:false', () => {
  const { cliPath } = makeFakeCli('kicad-cli-version', { report: { violations: [] } });
  const found = detectKicadCli({ candidates: [cliPath] });
  assert.equal(found.available, true);
  assert.equal(found.command, cliPath);
  assert.equal(found.version, '8.0.1');

  const envFound = detectKicadCli({ env: { ...process.env, KICAD_CLI_PATH: cliPath }, candidates: ['kicad-cli'] });
  assert.equal(envFound.available, true);
  assert.equal(envFound.command, cliPath);

  const missing = detectKicadCli({ candidates: ['/nonexistent/kicad-cli-should-not-exist'] });
  assert.equal(missing.available, false);
  assert.equal(missing.command, null);
  assert.ok(missing.searched.includes('/nonexistent/kicad-cli-should-not-exist'));
});

test('runKicadDrc：缺命令/不可执行/缺输入都 fail-closed', () => {
  const missingCommand = runKicadDrc({ pcbFile: '/tmp/x.kicad_pcb' });
  assert.equal(missingCommand.ok, false);
  assert.equal(missingCommand.code, KICAD_DRC_CODES.CLI_MISSING);

  const badCommand = runKicadDrc({ pcbFile: '/tmp/x.kicad_pcb', command: '/nonexistent/kicad-cli-should-not-exist' });
  assert.equal(badCommand.ok, false);
  assert.equal(badCommand.code, KICAD_DRC_CODES.CLI_MISSING);

  const { cliPath } = makeFakeCli('kicad-cli-input', { report: { violations: [] } });
  const noInput = runKicadDrc({ command: cliPath });
  assert.equal(noInput.ok, false);
  assert.equal(noInput.code, KICAD_DRC_CODES.INPUT_MISSING);

  const missingFile = runKicadDrc({ command: cliPath, pcbFile: join(tempRoot, 'does-not-exist.kicad_pcb') });
  assert.equal(missingFile.ok, false);
  assert.equal(missingFile.code, KICAD_DRC_CODES.INPUT_MISSING);
});

test('runKicadDrc：伪 CLI 成功 → 解析 findings/counts/reportDigest', () => {
  const report = {
    violations: [
      { type: 'clearance', severity: 'error', description: 'Clearance violation (net 1 vs net 2)', items: [{ description: 'Pad 1' }] },
      { type: 'silk_over_copper', severity: 'warning', description: 'Silk over copper' },
    ],
    unconnected_items: [{ description: 'unconnected pin U1.1' }],
  };
  const { cliPath, pcbFile } = makeFakeCli('kicad-cli-ok', { report });
  const result = runKicadDrc({ command: cliPath, pcbFile, timeoutMs: 30_000 });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.counts.violations, 2);
  assert.equal(result.counts.unconnectedItems, 1);
  assert.equal(result.counts.total, 3);
  assert.equal(result.counts.errors, 2);
  assert.equal(result.counts.warnings, 1);
  assert.equal(result.findings.length, 3);
  assert.equal(result.findings[0].type, 'clearance');
  assert.equal(result.findings[0].severity, 'error');
  assert.equal(result.findings[2].type, 'unconnected');
  assert.equal(result.reportDigest.length, 64);
  assert.equal(result.reportSource, 'file');
  assert.ok(result.durationMs >= 0);
});

test('runKicadDrc：非零退出但有合法报告 → ok:true 且如实记录 exitCode', () => {
  const { cliPath, pcbFile } = makeFakeCli('kicad-cli-nonzero', { report: { violations: [{ description: 'violation' }] }, exitCode: 3 });
  const result = runKicadDrc({ command: cliPath, pcbFile });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 3);
  assert.equal(result.counts.total, 1);
});

test('runKicadDrc：报告非法/为空/无已知字段 → KICAD_DRC_REPORT_INVALID（绝不返回 0 违规）', () => {
  const invalidJson = makeFakeCli('kicad-cli-invalid-json', { rawReport: '{not valid json' });
  const invalid = runKicadDrc({ command: invalidJson.cliPath, pcbFile: invalidJson.pcbFile });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, KICAD_DRC_CODES.REPORT_INVALID);
  assert.deepEqual(invalid.findings, []);

  const empty = makeFakeCli('kicad-cli-empty', { rawReport: '' });
  assert.equal(runKicadDrc({ command: empty.cliPath, pcbFile: empty.pcbFile }).code, KICAD_DRC_CODES.REPORT_INVALID);

  const unknownShape = makeFakeCli('kicad-cli-unknown-shape', { rawReport: JSON.stringify({ foo: 1 }) });
  const shape = runKicadDrc({ command: unknownShape.cliPath, pcbFile: unknownShape.pcbFile });
  assert.equal(shape.ok, false);
  assert.equal(shape.code, KICAD_DRC_CODES.REPORT_INVALID);
  assert.ok(shape.message.includes('0 违规'), '错误信息必须点明"不能当作 0 违规"');

  // 只有 stdout 输出报告也能解析（部分封装形态）
  const stdoutOnly = makeFakeCli('kicad-cli-stdout', { report: { violations: [{ description: 'v' }] }, stdoutOnly: true });
  const stdoutResult = runKicadDrc({ command: stdoutOnly.cliPath, pcbFile: stdoutOnly.pcbFile });
  assert.equal(stdoutResult.ok, true);
  assert.equal(stdoutResult.reportSource, 'stdout');
  assert.equal(stdoutResult.counts.total, 1);
});

test('runKicadDrc：超时 → KICAD_DRC_TIMEOUT', () => {
  const slow = makeFakeCli('kicad-cli-slow', { report: { violations: [] }, sleepMs: 10_000 });
  const result = runKicadDrc({ command: slow.cliPath, pcbFile: slow.pcbFile, timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.code, KICAD_DRC_CODES.TIMEOUT);
  assert.ok(result.durationMs < 5_000, `超时应在预算附近返回，实际 ${result.durationMs}ms`);
});

test('parseKicadDrcReport：纯解析函数——合法/非法/空/顶层非对象各错误码', () => {
  const ok = parseKicadDrcReport(JSON.stringify({ violations: [], unconnected_items: [] }));
  assert.equal(ok.ok, true);
  assert.equal(ok.counts.total, 0);
  assert.equal(ok.counts.violations, 0);

  const itemsShape = parseKicadDrcReport(JSON.stringify({ items: [{ description: 'x' }] }));
  assert.equal(itemsShape.ok, true);
  assert.equal(itemsShape.counts.items, 1);

  assert.equal(parseKicadDrcReport('').code, KICAD_DRC_CODES.REPORT_INVALID);
  assert.equal(parseKicadDrcReport('[]').code, KICAD_DRC_CODES.REPORT_INVALID);
  assert.equal(parseKicadDrcReport('{"a":1}').code, KICAD_DRC_CODES.REPORT_INVALID);
  assert.equal(parseKicadDrcReport('{"violations":"nope"}').code, KICAD_DRC_CODES.REPORT_INVALID);
  const emptyObject = parseKicadDrcReport('{}');
  assert.equal(emptyObject.ok, false, '空对象没有已知字段，不能当成 0 违规');
  assert.equal(emptyObject.code, KICAD_DRC_CODES.REPORT_INVALID);
});
