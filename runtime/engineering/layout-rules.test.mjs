import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LAYOUT_RULE_STATUS, evaluateLayoutRules, layoutRulePack, layoutRulePackSummary,
  requiredTraceWidthMm, validateRulePack,
} from './layout-rules.mjs';
import { sampleBoardWithDefects, sampleBoardRectified } from './rules/fixtures.mjs';

const statusOf = (audit, id) => audit.rules.find((rule) => rule.id === id)?.status;
const ids = (audit, status) => audit.rules.filter((rule) => rule.status === status).map((rule) => rule.id);

test('规则包：128 条、9 组、编号连续、等级计数与声明一致', () => {
  const pack = layoutRulePack();
  assert.equal(pack.total, 128);
  assert.equal(pack.rules.length, 128);
  assert.deepEqual(pack.groupIdOrder, ['MECH', 'SPACE', 'CONN', 'RF', 'PWR', 'SILK', 'DFM', 'DFA', 'GATE']);
  assert.deepEqual(pack.counts, { MECH: 15, SPACE: 18, CONN: 17, RF: 13, PWR: 13, SILK: 16, DFM: 16, DFA: 13, GATE: 7 });
  assert.deepEqual(pack.levels, { 硬门禁: 110, 推荐: 18 });
  assert.match(pack.hash, /^[0-9a-f]{64}$/);
  assert.equal(new Set(pack.rules.map((rule) => rule.id)).size, 128);
  for (const rule of pack.rules) {
    assert.match(rule.id, /^[A-Z]{2,5}-\d{2}$/);
    assert.ok(rule.name && rule.value && rule.check, `${rule.id} 缺少 name/value/check`);
    assert.ok(['硬门禁', '推荐'].includes(rule.level));
  }
  // 文档指针必须存在，避免"规则出处"丢失
  assert.ok(pack.documents?.diagnosis && pack.documents?.rulesA && pack.documents?.rulesB);
});

test('规则包校验器：能拦住重复编号/非法等级/计数不符', () => {
  const pack = layoutRulePack();
  const clone = () => JSON.parse(JSON.stringify({ ...pack, rules: pack.rules.map((rule) => ({ ...rule })) }));
  const clean = clone();
  assert.deepEqual(validateRulePack(clean), []);

  const duplicate = clone();
  duplicate.rules[1].id = duplicate.rules[0].id;
  assert.ok(validateRulePack(duplicate).some((problem) => problem.includes('重复')));

  const badLevel = clone();
  badLevel.rules[0].level = '必须';
  assert.ok(validateRulePack(badLevel).some((problem) => problem.includes('等级非法')));

  const badTotal = clone();
  badTotal.rules.pop();
  assert.ok(validateRulePack(badTotal).some((problem) => problem.includes('total')));

  const gap = clone();
  gap.rules = gap.rules.filter((rule) => rule.id !== 'SPACE-07');
  assert.ok(validateRulePack(gap).some((problem) => problem.includes('不连续')));
});

test('空输入：REVIEW 不等于 PASS，任何几何/电气结论都不能凭空成立', () => {
  const audit = evaluateLayoutRules({ board: { widthMm: 70, heightMm: 48, thicknessMm: 1.6 } });
  // 没有任何阻断项（因为没数据），但绝不能声称可以投产
  assert.equal(audit.passed, true);
  assert.equal(audit.releaseReady, false);
  assert.equal(audit.summary.FAIL, 0);
  assert.ok(audit.summary.REVIEW > 100, `expected most rules REVIEW, got ${audit.summary.REVIEW}`);
  assert.equal(audit.uncoveredReviews, audit.summary.REVIEW);
  for (const id of ['SPACE-02', 'CONN-01', 'CONN-10', 'RF-01', 'PWR-01', 'SILK-05', 'DFA-05', 'MECH-11', 'MECH-12', 'DFM-08']) {
    assert.equal(statusOf(audit, id), LAYOUT_RULE_STATUS.REVIEW, `${id} 缺数据时必须 REVIEW`);
  }
  assert.deepEqual(Object.values(audit.gatesSummary), Array(7).fill(LAYOUT_RULE_STATUS.REVIEW));
  for (const rule of audit.rules) if (rule.status === LAYOUT_RULE_STATUS.REVIEW) assert.ok(rule.message.length > 0);
});

test('现状板：已知缺陷全部被判出，且判据可复现（含证据）', () => {
  const audit = evaluateLayoutRules(sampleBoardWithDefects());
  assert.equal(audit.passed, false);
  assert.equal(audit.releaseReady, false);
  assert.ok(audit.summary.blockingFailures >= 45, `blocking=${audit.summary.blockingFailures}`);
  assert.equal(audit.summary.FAIL, audit.findings.length);
  assert.ok(audit.findings.every((finding) => ['blocking', 'warning'].includes(finding.severity)));
  assert.ok(audit.findings.every((finding) => finding.code.startsWith('LAYOUT_RULE_')));
  assert.ok(audit.findings.every((finding) => finding.path.startsWith('layoutRules.')));

  // 01 号文档已确认的 13 处缺陷对应的规则必须命中（不是抽查，是逐条锚定）
  const mustFail = [
    'SPACE-02', // A-01/A-02/A-06 courtyard 相交
    'SPACE-07', 'SPACE-08', 'SPACE-09', // 模组三面邻件
    'CONN-01', 'CONN-04', 'CONN-06', // USB1 斜置 / 两个 FFC 相对 / USB 后方紧贴
    'CONN-10', 'CONN-11', 'CONN-13', // 4 类方向且相邻边反向
    'RF-01', 'RF-03', 'RF-04', 'RF-07', // 天线朝板内 + 禁布区被占 + 天线区有铜
    'PWR-01', 'PWR-05', // 去耦超距 / 载流线宽不足
    'MECH-10', 'MECH-11', 'MECH-12', 'MECH-14', // 无拼板/无 Mark/无定位孔/无安装孔
    'SILK-01', 'SILK-05', 'SILK-13', // 字高不足 / 丝印压焊盘 / 丝印越板边
    'DFA-04', 'DFA-05', 'DFA-06', // 按键遮挡 / 无测试点 / 测试点覆盖不足
    'DFM-08', // 未拼板
  ];
  const missing = mustFail.filter((id) => statusOf(audit, id) !== LAYOUT_RULE_STATUS.FAIL);
  assert.deepEqual(missing, [], `这些规则应判 FAIL 却没有：${missing.join(',')}`);

  // 天线端虽朝上板边，但整颗模组都在板内（伸出 0 mm），且正前方被 Type-C 顶住 → RF-01 必须给量值
  const rf01 = audit.rules.find((rule) => rule.id === 'RF-01');
  assert.match(rf01.message, /伸出板边 0 mm/);
  assert.equal(rf01.evidence.edge, 'top');
  assert.equal(rf01.evidence.outward, '+y');

  assert.equal(audit.gatesSummary['GATE-01'], LAYOUT_RULE_STATUS.FAIL);
  assert.equal(audit.gatesSummary['GATE-07'], LAYOUT_RULE_STATUS.FAIL);
  const redHits = audit.redLines.filter((line) => line.hit === true).map((line) => line.key);
  assert.ok(redHits.includes('3D 干涉未清零'));
  assert.ok(redHits.includes('丝印压焊盘未清零'));
  assert.ok(redHits.includes('RF 天线禁布区被金属侵占'));
  assert.match(audit.auditHash, /^[0-9a-f]{64}$/);
});

test('整改骨架：同一套规则可以被满足（证明规则可执行，不是只说不做）', () => {
  const audit = evaluateLayoutRules(sampleBoardRectified());
  assert.deepEqual(ids(audit, LAYOUT_RULE_STATUS.FAIL), []);
  assert.equal(audit.passed, true);
  assert.equal(audit.releaseReady, true);
  assert.deepEqual(Object.values(audit.gatesSummary), Array(7).fill(LAYOUT_RULE_STATUS.PASS));
  assert.equal(audit.uncoveredReviews, 0);
  assert.equal(statusOf(audit, 'CONN-10'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(audit, 'MECH-13'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(audit, 'RF-01'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(audit, 'MECH-05'), LAYOUT_RULE_STATUS.PASS);
  // 天线模组越边被 MECH-05 记入 rfGoverned 而不是判违规
  const mech05 = audit.rules.find((rule) => rule.id === 'MECH-05');
  assert.deepEqual(mech05.evidence.rfGoverned, ['U4']);
  // 3 类方向必须带 ECO 降级记录才放行
  const conn10 = audit.rules.find((rule) => rule.id === 'CONN-10');
  assert.equal(conn10.evidence.classCount, 3);
  assert.equal(conn10.evidence.degraded, true);
});

test('方向类别降级必须有 ECO 记录：去掉审批后 CONN-10/DFA-11 同时翻脸', () => {
  const input = sampleBoardRectified();
  delete input.directionClassDegradationApproved;
  const audit = evaluateLayoutRules(input);
  assert.equal(audit.passed, false);
  assert.equal(statusOf(audit, 'CONN-10'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(statusOf(audit, 'DFA-11'), LAYOUT_RULE_STATUS.FAIL);
  assert.match(audit.rules.find((rule) => rule.id === 'CONN-10').message, /ECO/);
});

test('门禁与规则联动：门禁证据缺失时 releaseReady 必须为 false', () => {
  const noEvidence = sampleBoardRectified();
  delete noEvidence.evidence.step3d;
  const audit = evaluateLayoutRules(noEvidence);
  assert.equal(audit.summary.FAIL, 0);
  assert.equal(audit.passed, true);
  assert.equal(audit.gatesSummary['GATE-01'], LAYOUT_RULE_STATUS.REVIEW);
  assert.equal(audit.releaseReady, false);

  // 官方 DRC 未通过 → GATE-02 FAIL，且不能因为规则全过就放行
  const drcFailed = sampleBoardRectified();
  drcFailed.evidence.officialDrc = { passed: false, reportId: 'DRC-1' };
  const audit2 = evaluateLayoutRules(drcFailed);
  assert.equal(audit2.gatesSummary['GATE-02'], LAYOUT_RULE_STATUS.FAIL);
  assert.equal(audit2.releaseReady, false);
});

test('判定确定性：同输入逐字节一致，异输入哈希不同', () => {
  const input = sampleBoardWithDefects();
  const a = evaluateLayoutRules(input);
  const b = evaluateLayoutRules(input);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.auditHash, b.auditHash);

  const changed = sampleBoardRectified();
  const c = evaluateLayoutRules(changed);
  assert.notEqual(a.auditHash, c.auditHash);
  // 规则顺序必须与规则包一致，方便差分对比
  assert.deepEqual(a.rules.map((rule) => rule.id), layoutRulePack().rules.map((rule) => rule.id));
});

test('载流线宽按 IPC-2221B 计算（外层 1 A ≈0.30 mm / 内层 ≈0.79 mm）', () => {
  const outer1 = requiredTraceWidthMm(1, 'outer');
  const inner1 = requiredTraceWidthMm(1, 'inner');
  const outer2 = requiredTraceWidthMm(2, 'outer');
  const outer3 = requiredTraceWidthMm(3, 'outer');
  assert.ok(Math.abs(outer1 - 0.302) < 0.01, `1A outer=${outer1}`);
  assert.ok(Math.abs(inner1 - 0.785) < 0.02, `1A inner=${inner1}`);
  assert.ok(Math.abs(outer2 - 0.79) < 0.02, `2A outer=${outer2}`);
  assert.ok(Math.abs(outer3 - 1.377) < 0.03, `3A outer=${outer3}`);
  assert.ok(inner1 > outer1 && outer3 > outer2);
});

test('规则包摘要：不吐 128 条正文，但交付 UI 需要的元信息', () => {
  const summary = layoutRulePackSummary();
  assert.equal(summary.total, 128);
  assert.equal(summary.groups.length, 9);
  assert.equal(summary.groups.reduce((sum, group) => sum + group.count, 0), 128);
  assert.equal(summary.hash, layoutRulePack().hash);
  assert.equal(summary.policy.reviewIsNotPass, true);
  assert.equal(summary.rules, undefined);
});

test('PWR-05 载流：给定 3 A 只用 0.4 mm 宽必须判 FAIL 并报出所需宽度', () => {
  const input = sampleBoardWithDefects();
  const audit = evaluateLayoutRules(input);
  const rule = audit.rules.find((item) => item.id === 'PWR-05');
  assert.equal(rule.status, LAYOUT_RULE_STATUS.FAIL);
  assert.ok(rule.evidence.checked.some((net) => net.net === 'VBUS' && net.requiredWithMarginMm >= 1.6));
});

test('P0：上下层不判 courtyard 叠放/吸嘴间距，同层仍判', () => {
  const make = (sideA, sideB) => ({
    board: { widthMm: 30, heightMm: 30, outlineClosed: true },
    components: [
      { ref: 'U1', x: 15, y: 15, widthMm: 10, heightMm: 10, rotationDeg: 0, courtyardMm: 0.25, side: sideA, heightMm3d: 2 },
      { ref: 'U2', x: 15, y: 15, widthMm: 10, heightMm: 10, rotationDeg: 0, courtyardMm: 0.25, side: sideB, heightMm3d: 2 },
    ],
  });
  const opposite = evaluateLayoutRules(make('bottom', 'top'));
  assert.notEqual(statusOf(opposite, 'SPACE-02'), LAYOUT_RULE_STATUS.FAIL);
  assert.notEqual(statusOf(opposite, 'SPACE-14'), LAYOUT_RULE_STATUS.FAIL);
  const same = evaluateLayoutRules(make('top', 'top'));
  assert.equal(statusOf(same, 'SPACE-02'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(statusOf(same, 'SPACE-14'), LAYOUT_RULE_STATUS.FAIL);
});

test('P0：MECH-05 按本体判板边，不把 courtyard 外扩算成本体', () => {
  const audit = evaluateLayoutRules({
    board: { widthMm: 30, heightMm: 30, outlineClosed: true },
    components: [{ ref: 'U1', x: 5.6, y: 15, widthMm: 10, heightMm: 10, rotationDeg: 0, courtyardMm: 0.25 }],
  });
  assert.equal(statusOf(audit, 'MECH-05'), LAYOUT_RULE_STATUS.PASS);
});

test('P0：courtyard 未声明时必须 REVIEW，不能按默认 0.25 mm 判 PASS/FAIL', () => {
  const audit = evaluateLayoutRules({
    board: { widthMm: 30, heightMm: 30, outlineClosed: true },
    components: [{ ref: 'U1', x: 15, y: 15, widthMm: 10, heightMm: 10, rotationDeg: 0 }],
  });
  assert.equal(statusOf(audit, 'SPACE-01'), LAYOUT_RULE_STATUS.REVIEW);
  assert.equal(statusOf(audit, 'SPACE-02'), LAYOUT_RULE_STATUS.REVIEW);
  assert.equal(statusOf(audit, 'SPACE-03'), LAYOUT_RULE_STATUS.REVIEW);
});

test('P0：门禁证据没有 provenance 时不得 PASS', () => {
  const input = sampleBoardRectified();
  input.evidence.officialDrc = { passed: true };
  const audit = evaluateLayoutRules(input);
  assert.equal(audit.gatesSummary['GATE-02'], LAYOUT_RULE_STATUS.REVIEW);
  assert.equal(audit.releaseReady, false);
  assert.match(audit.gates.find((gate) => gate.id === 'GATE-02').message, /provenance/);
});

test('P1：SILK 规则用真实字高/线宽/包围盒判定，缺数据保持 REVIEW', () => {
  const board = { widthMm: 20, heightMm: 20, outlineClosed: true };
  const base = {
    board,
    components: [{ ref: 'U1', x: 10, y: 10, widthMm: 4, heightMm: 4, rotationDeg: 0, side: 'top', courtyardMm: 0.25 }],
    silk: {
      textCount: 1,
      textHeights: [1.0],
      lineWidthsMm: [0.1524],
      designators: [{ ref: 'U1', rotationDeg: 0, mirror: false, gapToBodyMm: 0.4, placementRelative: true, sideMismatch: false }],
      items: [{ ref: 'U1', boundsMm: { minXMm: 9.5, minYMm: 12.4, maxXMm: 10.5, maxYMm: 13.4 }, outsideBoard: false, edgeDistanceMm: 6.6, gapToPadMm: 0.2, onPadRefs: [], courtyardOverlapRefs: [], courtyardKnown: true }],
      overlappingPadCount: 0,
      runsOffBoard: false,
    },
  };
  const good = evaluateLayoutRules(base);
  assert.equal(statusOf(good, 'SILK-01'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(good, 'SILK-02'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(good, 'SILK-04'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(good, 'SILK-05'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(good, 'SILK-06'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(good, 'SILK-07'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(good, 'SILK-13'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(good, 'SILK-16'), LAYOUT_RULE_STATUS.PASS);

  const bad = evaluateLayoutRules({ ...base, silk: {
    ...base.silk,
    lineWidthsMm: [0.10],
    items: [{ ...base.silk.items[0], outsideBoard: true, edgeDistanceMm: -0.2, onPadRefs: ['U1'] }],
    overlappingPadCount: 1,
    runsOffBoard: true,
  } });
  assert.equal(statusOf(bad, 'SILK-02'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(statusOf(bad, 'SILK-05'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(statusOf(bad, 'SILK-13'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(statusOf(bad, 'SILK-16'), LAYOUT_RULE_STATUS.FAIL);

  const unknown = evaluateLayoutRules({ board, components: base.components, silk: { textCount: 0, items: [], lineWidthsMm: [], designators: [] } });
  assert.equal(statusOf(unknown, 'SILK-02'), LAYOUT_RULE_STATUS.REVIEW);
  assert.equal(statusOf(unknown, 'SILK-06'), LAYOUT_RULE_STATUS.REVIEW);
});

test('P1：PWR-01 有真实配对距离才判定；封装类别未知不得猜阈值', () => {
  const board = { widthMm: 20, heightMm: 20, outlineClosed: true };
  const components = [{ ref: 'C1', x: 5, y: 5, widthMm: 1, heightMm: 0.5, rotationDeg: 0, side: 'top' }, { ref: 'U1', x: 8, y: 5, widthMm: 4, heightMm: 4, rotationDeg: 0, side: 'top' }];
  const good = evaluateLayoutRules({ board, components, power: { decoupling: [{ capRef: 'C1', icRef: 'U1', distanceMm: 0.8, icClass: 'QFN', icClassKnown: true }] } });
  assert.equal(statusOf(good, 'PWR-01'), LAYOUT_RULE_STATUS.PASS);
  const bad = evaluateLayoutRules({ board, components, power: { decoupling: [{ capRef: 'C1', icRef: 'U1', distanceMm: 3, icClass: 'QFN', icClassKnown: true }] } });
  assert.equal(statusOf(bad, 'PWR-01'), LAYOUT_RULE_STATUS.FAIL);
  const unknown = evaluateLayoutRules({ board, components, power: { decoupling: [{ capRef: 'C1', icRef: 'U1', distanceMm: 0.8, icClass: 'OTHER', icClassKnown: false }] } });
  assert.equal(statusOf(unknown, 'PWR-01'), LAYOUT_RULE_STATUS.REVIEW);
});

test('P1：DFA-09 ESD 位置可由意图声明判定；缺量测保持 REVIEW', () => {
  const board = { widthMm: 20, heightMm: 20, outlineClosed: true };
  const components = [{ ref: 'D1', x: 5, y: 5, widthMm: 2, heightMm: 1, rotationDeg: 0, side: 'top' }];
  const good = evaluateLayoutRules({ board, components, esd: { devices: [{ ref: 'D1', distanceMm: 3, gndViaDistanceMm: 1.2, orderBeforeBranch: true }] } });
  assert.equal(statusOf(good, 'DFA-09'), LAYOUT_RULE_STATUS.PASS);
  const bad = evaluateLayoutRules({ board, components, esd: { devices: [{ ref: 'D1', distanceMm: 6, gndViaDistanceMm: 1.2, orderBeforeBranch: true }] } });
  assert.equal(statusOf(bad, 'DFA-09'), LAYOUT_RULE_STATUS.FAIL);
  const unknown = evaluateLayoutRules({ board, components, esd: { devices: [{ ref: 'D1' }] } });
  assert.equal(statusOf(unknown, 'DFA-09'), LAYOUT_RULE_STATUS.REVIEW);
});

test('SPACE-14：bbox 含焊盘时疑似吸嘴间距不足只能 REVIEW，真实本体才 FAIL', () => {
  const board = { widthMm: 20, heightMm: 20, outlineClosed: true };
  const components = [
    { ref: 'U1', x: 8, y: 10, widthMm: 4, heightMm: 4, rotationDeg: 0, side: 'top', bboxIncludesPads: true },
    { ref: 'U2', x: 12, y: 10, widthMm: 4, heightMm: 4, rotationDeg: 0, side: 'top', bboxIncludesPads: true },
  ];
  const uncertain = evaluateLayoutRules({ board, components });
  assert.equal(statusOf(uncertain, 'SPACE-14'), LAYOUT_RULE_STATUS.REVIEW);
  const real = evaluateLayoutRules({ board, components: components.map((item) => ({ ...item, bboxIncludesPads: false })) });
  assert.equal(statusOf(real, 'SPACE-14'), LAYOUT_RULE_STATUS.FAIL);
});
