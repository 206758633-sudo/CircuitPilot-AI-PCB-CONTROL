import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DRC_CODES, buildExemptionTemplate, classifyDrcItems, dispositionFor, loadExemptionFile, normalizeDrcReport,
  renderExplanation, saveExemptionFile, validateExemption,
} from '../drc.mjs';

/** 真机报告的真实形状：三层嵌套，顶层 count 是"分组数"而不是违规条数。 */
function realShapedReport({ leaves = 6, truncated = false, count = 2, connection = true } = {}) {
  const clearanceLeaves = Array.from({ length: leaves }, (_, i) => ({
    visible: true,
    errorType: 'Clearance Error',
    errorObjType: 'Track to Via',
    ruleName: 'copperThickness1oz',
    ruleTypeName: 'Safe Spacing',
    layer: 'Top Layer',
    obj1: { typeName: 'Track', suffix: `(MON_IN_P): e${i}` },
    obj2: { typeName: 'Via', suffix: '(MON_IN_N): e1' },
    explanation: { str: '{obj1} to {obj2} distance is {minDistance}, should be {shouldBe}', param: { minDistance: '4mil', shouldBe: '>= 6mil' }, errData: { globalIndex: `err${i}`, position: { x: 100 + i, y: -30 }, obj1Type: 'Track', obj2Type: 'Via', obj1Suffix: `(MON_IN_P): e${i}`, obj2Suffix: '(MON_IN_N): e1', clearance: 0.59843 } },
  }));
  const connectionLeaves = connection === false ? [] : [{
    visible: true, errorType: 'Connection Error', errorObjType: 'SMD Pad', ruleName: 'Common',
    obj1: { typeName: 'SMD Pad', suffix: '(3V3): U6_5' },
    explanation: { str: '{obj1} is disconnected from other objects of the same network', param: {}, errData: { globalIndex: 'err93', errorType: 'No Connection', name: 'Common', net: '3V3', obj1Type: 'SMD Pad', obj1Suffix: '(3V3): U6_5' } },
    pos: { x: 106.3, y: -51.6 },
  }];
  return {
    result: {
      kind: 'array', count, truncated,
      items: [
        { name: 'Clearance Error', list: [{ name: 'Track to Via', list: clearanceLeaves }] },
        ...(connectionLeaves.length ? [{ name: 'Connection Error', list: [{ name: '3V3', list: connectionLeaves }] }] : []),
      ],
    },
  };
}

test('归一化：自己数叶子，并揭穿"报告 count 是分组数"这个坑', () => {
  const normalized = normalizeDrcReport(realShapedReport({ leaves: 6, count: 2 }));
  assert.equal(normalized.ok, true);
  assert.equal(normalized.itemCount, 7, '叶子必须全部数到');
  assert.equal(normalized.reportedCount, 2);
  assert.equal(normalized.countsConsistent, false, 'count=2 与 7 条不一致必须暴露');
  assert.equal(normalized.byErrorType['Clearance Error'], 6);
  assert.equal(normalized.byErrorType['Connection Error'], 1);
  assert.deepEqual(normalized.groups.map((g) => g.path).sort(), ['Clearance Error / Track to Via', 'Connection Error / 3V3']);
  const first = normalized.items[0];
  assert.equal(first.net, 'MON_IN_P', '网络维度要从 "(NET): ref" 后缀里取出来');
  assert.equal(first.position.x, 100);
  assert.match(first.explanation, /distance is 4mil, should be >= 6mil/);
  assert.equal(normalized.items.every((item) => item.signature.split('|').length === 5), true, '签名要含网络维度');
  assert.ok(normalizeDrcReport(null).code === DRC_CODES.REPORT_INVALID);
  assert.ok(normalizeDrcReport({ result: { kind: 'array', count: 0 } }).code === DRC_CODES.REPORT_INVALID);
});

test('分组路径不能被未命名叶子污染（真机叶子 name 为空）', () => {
  const normalized = normalizeDrcReport(realShapedReport({ leaves: 1, count: 1 }));
  assert.equal(normalized.groups.some((group) => /未命名/.test(group.path)), false, JSON.stringify(normalized.groups));
  assert.equal(renderExplanation({ str: '{a} 与 {b}', param: { a: 'X' } }), 'X 与 ');
});

test('不许静默放行：未登记豁免的违规一律进"未处理"并阻断', () => {
  const normalized = normalizeDrcReport(realShapedReport({ leaves: 6, count: 2 }));
  const result = classifyDrcItems(normalized);
  assert.equal(result.ready, false);
  assert.equal(result.summary.unexplained, 7);
  assert.equal(result.summary.exempted, 0);
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes(DRC_CODES.UNEXPLAINED));
  assert.ok(codes.includes(DRC_CODES.COUNT_MISMATCH), 'count 与条数不一致要单独警告');
});

test('缺理由或缺残留风险的豁免＝无效，被它"覆盖"的问题退回未处理', () => {
  const normalized = normalizeDrcReport(realShapedReport({ leaves: 2, count: 1 }));
  const template = buildExemptionTemplate(normalized.items);
  assert.equal(validateExemption(template[0]).length >= 2, true, '模板必须因为空理由/空风险而不合格');
  const half = template.map((entry) => ({ ...entry, reason: '已人工核对，属于规则解析差异', risk: '' }));
  const result = classifyDrcItems({ ...normalized, exemptions: half });
  assert.equal(result.ready, false);
  assert.ok(result.findings.some((f) => f.code === DRC_CODES.EXEMPTION_INCOMPLETE), JSON.stringify(result.findings.map((f) => f.code)));
  assert.equal(result.summary.exempted, 0, '无效豁免不能计入"已处理"');
  assert.equal(result.summary.unexplained, normalized.itemCount);
});

test('kind 级豁免必须带配额；超出配额的问题不豁免', () => {
  const normalized = normalizeDrcReport(realShapedReport({ leaves: 5, count: 1 }));
  const noCap = { scope: 'kind', match: { errorType: 'Clearance Error' }, reason: '内层间距属于规则解析差异', risk: '板厂按更严规则可能拒收' };
  assert.ok(validateExemption(noCap).some((problem) => /maxCount/.test(problem)), '无限豁免必须被判不合格');
  const capped = { ...noCap, id: 'exempt-clearance', maxCount: 2 };
  const result = classifyDrcItems({ ...normalized, exemptions: [capped] });
  assert.equal(result.summary.exempted, 2);
  assert.equal(result.summary.unexplained, normalized.itemCount - 2);
  assert.equal(result.ready, false);
  assert.ok(result.findings.some((f) => f.code === DRC_CODES.UNEXPLAINED));
});

test('instance 级豁免精确到具体对象与坐标，不会顺手放过同类新问题', () => {
  const normalized = normalizeDrcReport(realShapedReport({ leaves: 3, count: 1 }));
  const target = normalized.items[0];
  const instance = {
    id: 'exempt-one', scope: 'instance', match: { instanceKey: target.instanceKey },
    reason: '该处过孔已实测避开，属于丝印标注误差', risk: '若后续移动器件该豁免失效',
  };
  assert.deepEqual(validateExemption(instance), []);
  const result = classifyDrcItems({ ...normalized, exemptions: [instance] });
  assert.equal(result.summary.exempted, 1);
  assert.equal(result.summary.unexplained, normalized.itemCount - 1, '只放过它自己，同类其它问题不跟着过关');
  const unrelated = classifyDrcItems({ ...normalized, exemptions: [{ ...instance, match: { instanceKey: 'other' } }] });
  assert.equal(unrelated.summary.exempted, 0);
  assert.ok(unrelated.findings.some((f) => f.code === DRC_CODES.EXEMPTION_UNUSED), '没匹配上的豁免要提醒清理');
});

test('报告被截断时不许宣布"已看完全部问题"；全部豁免要留一句自嘲的提醒', () => {
  const truncated = classifyDrcItems({ items: normalizeDrcReport(realShapedReport()).items, truncated: true, reportedCount: 1 });
  assert.equal(truncated.ready, false);
  assert.ok(truncated.findings.some((f) => f.code === DRC_CODES.REPORT_TRUNCATED));
  const normalized = normalizeDrcReport(realShapedReport({ leaves: 2, count: 1, connection: false }));
  const all = buildExemptionTemplate(normalized.items).map((entry) => ({ ...entry, reason: '已人工核对每一条的具体位置与影响', risk: '板厂规则若变化需要重新评估这一批豁免' }));
  const result = classifyDrcItems({ ...normalized, exemptions: all });
  assert.equal(result.ready, true, JSON.stringify(result.findings));
  assert.ok(result.findings.some((f) => f.code === DRC_CODES.ALL_EXEMPTED && f.severity === 'warning'));
  const clean = classifyDrcItems({ items: [], reportedCount: 0 });
  assert.equal(clean.ready, true);
  assert.ok(clean.findings.some((f) => f.code === DRC_CODES.CLEAN));
});

test('豁免清单落盘要校验：绝不允许把缺理由/风险的条目静默写进去', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-drc-exempt-'));
  const file = join(dir, 'drc-exemptions.json');
  try {
    assert.throws(() => saveExemptionFile(file, [{ id: 'x', scope: 'kind', match: { errorType: 'Clearance Error' }, maxCount: 1, reason: '', risk: '' }]), (error) => error.code === 'DRC_EXEMPTION_INVALID');
    const good = [{ id: 'exempt-1', scope: 'kind', match: { errorType: 'Clearance Error', ruleName: 'copperThickness1oz' }, maxCount: 20, reason: '内层过孔与走线间距按嘉立创1oz规则核对无误', risk: '若板厂采用更严间距规则需重新评审', approvedBy: 'user', approvedAt: '2026-10-13' }];
    assert.deepEqual(saveExemptionFile(file, good), { path: file, count: 1 });
    const loaded = loadExemptionFile(file);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.exemptions.length, 1);
    assert.equal(loaded.invalid.length, 0);
    assert.equal(loadExemptionFile(join(dir, 'nope.json')).exists, false);
    writeFileSync(file, JSON.stringify({ kind: 'drc-exemption-list', exemptions: [{ scope: 'kind', match: { errorType: 'X' }, maxCount: 1, reason: '', risk: '' }] }), 'utf8');
    assert.equal(loadExemptionFile(file).invalid.length, 1, '读盘时也要标出无效条目');
    assert.ok(readFileSync(file, 'utf8').includes('exemptions'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('"未连接"类问题一律 must-fix，不许进豁免清单（本板 63 处未连接正是没布线）', () => {
  assert.equal(dispositionFor({ errorType: 'Connection Error' }).disposition, 'must-fix');
  assert.equal(dispositionFor({ errorType: 'Clearance Error' }).disposition, 'fix-or-exempt');
  assert.equal(dispositionFor({ errorType: 'Something Else' }).disposition, 'review');
  const normalized = normalizeDrcReport(realShapedReport({ leaves: 2, count: 1 }));
  const template = buildExemptionTemplate(normalized.items);
  const connection = template.find((entry) => entry.match.errorType === 'Connection Error');
  assert.equal(connection.disposition, 'must-fix');
  const filled = template.map((entry) => ({ ...entry, reason: '已人工核对过该处几何与网络', risk: '若后续改板需重新确认这一批问题' }));
  const result = classifyDrcItems({ ...normalized, exemptions: filled });
  assert.equal(result.ready, false);
  const forbidden = result.findings.find((f) => f.code === DRC_CODES.EXEMPTION_FORBIDDEN);
  assert.ok(forbidden, '必须报 DRC_EXEMPTION_FORBIDDEN');
  assert.match(forbidden.message, /未连接的网络必须布线或从设计中移除/);
  // 被禁止豁免的那条必须回到"未处理"，而不是被算成"已处理"
  assert.equal(result.summary.exempted, 2, '两条间距问题可以豁免，数目按"条"算');
  assert.equal(result.summary.unexplained, 1, '未连接那一条必须留在未处理');
  assert.equal(result.forbiddenExemptions.length >= 1, true);
});
