import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LAYOUT_RULE_STATUS, evaluateLayoutRules, layoutRulePack, layoutRulePackSummary,
  requiredTraceWidthMm, validateRulePack,
} from './layout-rules.mjs';
import {
  dbtsDeliveryAfter, dbtsDeliveryBefore, dbtsModuleBoardAfter, dbtsModuleBoardBefore, defectiveTestBoard, rectifiedTestBoard,
} from './rules/fixtures.mjs';

const statusOf = (audit, id) => audit.rules.find((rule) => rule.id === id)?.status;
const ids = (audit, status) => audit.rules.filter((rule) => rule.status === status).map((rule) => rule.id);

test('规则包：151 条、12 组、编号连续、等级计数与声明一致', () => {
  const pack = layoutRulePack();
  assert.equal(pack.total, 151);
  assert.equal(pack.rules.length, 151);
  assert.deepEqual(pack.groupIdOrder, ['MECH', 'SPACE', 'ZCLR', 'CONN', 'RF', 'PWR', 'MOVE', 'SILK', 'DFM', 'DFA', 'PRJ', 'GATE']);
  assert.deepEqual(pack.counts, { MECH: 15, SPACE: 18, ZCLR: 9, CONN: 17, RF: 13, PWR: 13, MOVE: 5, SILK: 16, DFM: 16, DFA: 13, PRJ: 6, GATE: 10 });
  assert.deepEqual(pack.levels, { 硬门禁: 126, 推荐: 25 });
  assert.match(pack.hash, /^[0-9a-f]{64}$/);
  assert.equal(new Set(pack.rules.map((rule) => rule.id)).size, 151);
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
  assert.deepEqual(Object.values(audit.gatesSummary), Array(10).fill(LAYOUT_RULE_STATUS.REVIEW));
  for (const rule of audit.rules) if (rule.status === LAYOUT_RULE_STATUS.REVIEW) assert.ok(rule.message.length > 0);
});

test('现状板：已知缺陷全部被判出，且判据可复现（含证据）', () => {
  const audit = evaluateLayoutRules(defectiveTestBoard());
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
  assert.ok(redHits.some((key) => key.includes('3D 干涉')));
  assert.ok(redHits.includes('丝印压焊盘未清零'));
  assert.ok(redHits.includes('RF 天线禁布区被金属侵占'));
  assert.match(audit.auditHash, /^[0-9a-f]{64}$/);
});

test('整改骨架：同一套规则可以被满足（证明规则可执行，不是只说不做）', () => {
  const audit = evaluateLayoutRules(rectifiedTestBoard());
  assert.deepEqual(ids(audit, LAYOUT_RULE_STATUS.FAIL), []);
  assert.equal(audit.passed, true);
  assert.equal(audit.releaseReady, true);
  assert.deepEqual(Object.values(audit.gatesSummary), Array(10).fill(LAYOUT_RULE_STATUS.PASS));
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

test('ZCLR：装配区插合高度 + 3D 实体干涉（DBTS-A01 真机返工案例）', () => {
  const before = evaluateLayoutRules(dbtsModuleBoardBefore());
  assert.equal(statusOf(before, 'ZCLR-02'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(statusOf(before, 'ZCLR-03'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(statusOf(before, 'ZCLR-05'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(statusOf(before, 'ZCLR-07'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(before.gatesSummary['GATE-08'], LAYOUT_RULE_STATUS.FAIL);
  assert.ok(before.redLines.some((line) => line.key.includes('装配净空') && line.hit === true));

  const zclr03 = before.rules.find((rule) => rule.id === 'ZCLR-03');
  assert.match(zclr03.message, /C39 高 25 mm/);
  assert.match(zclr03.message, /上限 8\.5 mm/);
  const zclr02 = before.rules.find((rule) => rule.id === 'ZCLR-02');
  assert.match(zclr02.message, /C39\(25 mm\)×L2\(8\.1 mm\)/);

  // 返工后：硬门禁清零（C39/L2 迁出），只剩「推荐」级警告（C40 7.7 mm、L1 6.0 mm 仍在模块投影边缘）
  const after = evaluateLayoutRules(dbtsModuleBoardAfter());
  assert.equal(statusOf(after, 'ZCLR-02'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(after, 'ZCLR-03'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(after, 'ZCLR-06'), LAYOUT_RULE_STATUS.NA);
  assert.equal(statusOf(after, 'ZCLR-05'), LAYOUT_RULE_STATUS.FAIL);
  assert.ok(after.summary.warningFailures >= 1, '推荐级失败必须计入 warningFailures 而不是阻断');
  assert.equal(after.gatesSummary['GATE-08'], LAYOUT_RULE_STATUS.REVIEW);
  assert.ok(!after.redLines.some((line) => line.key.includes('装配净空') && line.hit === true));
  // 高度未知必须 REVIEW，不许蒙混成 PASS
  const noHeight = dbtsModuleBoardAfter();
  delete noHeight.components[0].heightMm3d;
  assert.equal(statusOf(evaluateLayoutRules(noHeight), 'ZCLR-01'), LAYOUT_RULE_STATUS.REVIEW);
  // 没声明装配区的板：ZCLR-03/04/07/08 一律 NA，不臆造结论
  const noZone = dbtsModuleBoardAfter();
  delete noZone.assemblyZones;
  for (const id of ['ZCLR-03', 'ZCLR-04', 'ZCLR-07', 'ZCLR-08']) {
    assert.equal(statusOf(evaluateLayoutRules(noZone), id), LAYOUT_RULE_STATUS.NA, `${id} 未声明装配区必须 NA`);
  }
});

test('MOVE：搬迁必须登记、网络长度/环路面积暴涨必须具名接受、ECO 编号必须一致', () => {
  const audit = evaluateLayoutRules(dbtsModuleBoardAfter());
  assert.equal(statusOf(audit, 'MOVE-01'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(audit, 'MOVE-04'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(audit, 'MOVE-05'), LAYOUT_RULE_STATUS.PASS);
  // SW_NODE 3.6→48.5 mm、环路 ×38：已在 fixture 里具名接受 → REVIEW（不是 PASS）
  assert.equal(statusOf(audit, 'MOVE-02'), LAYOUT_RULE_STATUS.REVIEW);
  assert.equal(statusOf(audit, 'MOVE-03'), LAYOUT_RULE_STATUS.REVIEW);
  assert.match(audit.rules.find((rule) => rule.id === 'MOVE-02').message, /具名接受/);

  // 去掉具名接受 → 直接 FAIL（GATE-09 阻断）
  const unsigned = dbtsModuleBoardAfter();
  unsigned.nets = unsigned.nets.map((net) => ({ ...net, approvedBy: '' }));
  const unsignedAudit = evaluateLayoutRules(unsigned);
  assert.equal(statusOf(unsignedAudit, 'MOVE-02'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(statusOf(unsignedAudit, 'MOVE-03'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(unsignedAudit.gatesSummary['GATE-09'], LAYOUT_RULE_STATUS.FAIL);

  // 偷偷挪件不登记：用 previousPositions 反查出来
  const silent = dbtsModuleBoardAfter();
  silent.changes = [];
  const silentAudit = evaluateLayoutRules(silent);
  assert.equal(statusOf(silentAudit, 'MOVE-01'), LAYOUT_RULE_STATUS.FAIL);
  assert.match(silentAudit.rules.find((rule) => rule.id === 'MOVE-01').message, /C39/);

  // ECO 编号对不上 → FAIL
  const wrongEco = dbtsModuleBoardAfter();
  wrongEco.changes = wrongEco.changes.map((change) => ({ ...change, ecoId: 'ECO-FAKE-0001' }));
  assert.equal(statusOf(evaluateLayoutRules(wrongEco), 'MOVE-05'), LAYOUT_RULE_STATUS.FAIL);

  // 阈值可通过 input.limits 显式放宽（会进 auditHash，不是偷偷改常量）
  const relaxedInput = dbtsModuleBoardAfter();
  relaxedInput.limits = { swMaxLengthMm: 60, swLoopGrowthFactor: 50, pwrLoopGrowthFactor: 500, moveGrowthPercent: 5000 };
  relaxedInput.nets = relaxedInput.nets.map((net) => ({ loopAreaBeforeMm2: 1, loopAreaAfterMm2: 1.2, ...net }));
  const relaxed = evaluateLayoutRules(relaxedInput);
  assert.equal(statusOf(relaxed, 'MOVE-02'), LAYOUT_RULE_STATUS.PASS);
  assert.equal(statusOf(relaxed, 'MOVE-03'), LAYOUT_RULE_STATUS.PASS);
});

test('PRJ：工程对象唯一、规则同源、交付物完整、门禁证据闭合、记录一致、推断项兜底', () => {
  const before = evaluateLayoutRules(dbtsDeliveryBefore());
  assert.equal(statusOf(before, 'PRJ-01'), LAYOUT_RULE_STATUS.FAIL, '重复旧图纸 + 两块投板 PCB 必须 FAIL');
  assert.match(before.rules.find((rule) => rule.id === 'PRJ-01').message, /重复|投板/);
  assert.equal(statusOf(before, 'PRJ-02'), LAYOUT_RULE_STATUS.FAIL, '文档哈希不符 = 规则包与文档分叉');
  assert.equal(statusOf(before, 'PRJ-03'), LAYOUT_RULE_STATUS.FAIL, '缺 Gerber / 网表必须 FAIL');
  assert.match(before.rules.find((rule) => rule.id === 'PRJ-03').message, /GERBER/);
  assert.equal(statusOf(before, 'PRJ-04'), LAYOUT_RULE_STATUS.REVIEW, 'post_route_checked 未置位只能 REVIEW（等效证据需签核）');
  assert.equal(statusOf(before, 'PRJ-05'), LAYOUT_RULE_STATUS.FAIL, '记录数字过期必须 FAIL（推荐级 → GATE-10 REVIEW/FAIL）');
  assert.equal(statusOf(before, 'PRJ-06'), LAYOUT_RULE_STATUS.REVIEW, '推断项缺安全默认/核对步骤必须 REVIEW');
  assert.equal(before.gatesSummary['GATE-10'], LAYOUT_RULE_STATUS.FAIL);

  const after = evaluateLayoutRules(dbtsDeliveryAfter());
  for (const id of ['PRJ-01', 'PRJ-02', 'PRJ-03', 'PRJ-04', 'PRJ-05', 'PRJ-06']) {
    assert.equal(statusOf(after, id), LAYOUT_RULE_STATUS.PASS, `${id} 整改后必须 PASS`);
  }
  assert.equal(after.gatesSummary['GATE-10'], LAYOUT_RULE_STATUS.PASS);

  // 只缺一类交付物（Gerber）也必须是 FAIL，不能"差不多就行"
  const noGerber = dbtsDeliveryAfter();
  noGerber.deliverables = noGerber.deliverables.filter((item) => item.kind !== 'GERBER');
  assert.equal(statusOf(evaluateLayoutRules(noGerber), 'PRJ-03'), LAYOUT_RULE_STATUS.FAIL);

  // post_route_checked 置位是唯一能 PASS 的路径；只有部分等效证据 → REVIEW
  const partial = dbtsDeliveryAfter();
  partial.stageGates = { postRouteChecked: false, equivalentEvidence: ['DRC', 'DFM'] };
  assert.equal(statusOf(evaluateLayoutRules(partial), 'PRJ-04'), LAYOUT_RULE_STATUS.REVIEW);

  // 规则包被手改（文档哈希不符）→ PRJ-02 FAIL，而不是静默通过
  const drifted = dbtsDeliveryAfter();
  drifted.docs = { ...drifted.docs, docHashes: {} };
  assert.equal(statusOf(evaluateLayoutRules(drifted), 'PRJ-02'), LAYOUT_RULE_STATUS.FAIL);

  // 没有推断项 = NA（不适用），有推断项但兜底完整 = PASS
  const noInferred = dbtsDeliveryAfter();
  delete noInferred.inferredParts;
  assert.equal(statusOf(evaluateLayoutRules(noInferred), 'PRJ-06'), LAYOUT_RULE_STATUS.NA);
});

test('方向类别降级必须有 ECO 记录：去掉审批后 CONN-10/DFA-11 同时翻脸', () => {
  const input = rectifiedTestBoard();
  delete input.directionClassDegradationApproved;
  const audit = evaluateLayoutRules(input);
  assert.equal(audit.passed, false);
  assert.equal(statusOf(audit, 'CONN-10'), LAYOUT_RULE_STATUS.FAIL);
  assert.equal(statusOf(audit, 'DFA-11'), LAYOUT_RULE_STATUS.FAIL);
  assert.match(audit.rules.find((rule) => rule.id === 'CONN-10').message, /ECO/);
});

test('门禁与规则联动：门禁证据缺失时 releaseReady 必须为 false', () => {
  const noEvidence = rectifiedTestBoard();
  delete noEvidence.evidence.step3d;
  const audit = evaluateLayoutRules(noEvidence);
  assert.equal(audit.summary.FAIL, 0);
  assert.equal(audit.passed, true);
  assert.equal(audit.gatesSummary['GATE-01'], LAYOUT_RULE_STATUS.REVIEW);
  assert.equal(audit.releaseReady, false);

  // 官方 DRC 未通过 → GATE-02 FAIL，且不能因为规则全过就放行
  const drcFailed = rectifiedTestBoard();
  drcFailed.evidence.officialDrc = { passed: false, reportId: 'DRC-1' };
  const audit2 = evaluateLayoutRules(drcFailed);
  assert.equal(audit2.gatesSummary['GATE-02'], LAYOUT_RULE_STATUS.FAIL);
  assert.equal(audit2.releaseReady, false);
});

test('判定确定性：同输入逐字节一致，异输入哈希不同', () => {
  const input = defectiveTestBoard();
  const a = evaluateLayoutRules(input);
  const b = evaluateLayoutRules(input);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.auditHash, b.auditHash);

  const changed = rectifiedTestBoard();
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

test('规则包摘要：不吐 151 条正文，但交付 UI 需要的元信息', () => {
  const summary = layoutRulePackSummary();
  assert.equal(summary.total, 151);
  assert.equal(summary.groups.length, 12);
  assert.equal(summary.groups.reduce((sum, group) => sum + group.count, 0), 151);
  assert.equal(summary.hash, layoutRulePack().hash);
  assert.equal(summary.policy.reviewIsNotPass, true);
  assert.equal(summary.rules, undefined);
});

test('PWR-05 载流：给定 3 A 只用 0.4 mm 宽必须判 FAIL 并报出所需宽度', () => {
  const input = defectiveTestBoard();
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
  const input = rectifiedTestBoard();
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
