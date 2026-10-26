import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyErcExemptions,
  buildErcExemptionTemplate,
  loadErcExemptionFile,
  normalizeErcReport,
  repairFor,
  saveErcExemptionFile,
  summarizeErcConvergence,
} from '../erc.mjs';

test('ERC 聚合报告：只计数时不伪装成逐条明细，错误/警告数如实汇总', () => {
  const raw = [
    { type: 'error', count: 1, message: 'Pin is floating' },
    { type: 'warn', count: 19, message: 'PWR_FLAG missing on net +5V' },
    { type: 'info', count: 138, message: 'Naming convention difference' },
  ];
  const normalized = normalizeErcReport(raw);
  assert.equal(normalized.ran, true);
  assert.equal(normalized.counts.fatal, 0);
  assert.equal(normalized.counts.error, 1);
  assert.equal(normalized.counts.warning, 19);
  assert.equal(normalized.counts.info, 138);
  assert.equal(normalized.counts.total, 158);
  assert.equal(normalized.aggregateOnly, true);
  assert.equal(normalized.detailAvailable, false);
  assert.equal(normalized.findings.length, 3, '聚合条目按组生成 finding，不伪造对象');
  assert.ok(normalized.findings.every((finding) => finding.aggregate === true));
  assert.equal(normalized.findings[0].code, 'ERC_PIN_FLOATING');
  assert.match(normalized.findings[0].suggestion, /noConnect/);
  assert.match(normalized.findings[1].suggestion, /PWR_FLAG/);
  assert.match(normalized.digest, /^[a-f0-9]{64}$/);
});

test('ERC 明细报告：逐条归一化、严重级排序计数、建议确定且幂等', () => {
  const raw = {
    result: [
      { type: 'error', items: [{ message: 'Pin U1.A3 is floating', objects: ['U1.A3'] }, { message: 'duplicate net GND', objects: [{ name: 'GND' }] }] },
      { type: 'warn', items: [{ message: 'no connect marker on U2.B1', ref: 'U2.B1' }] },
    ],
  };
  const normalized = normalizeErcReport(raw);
  assert.equal(normalized.aggregateOnly, false);
  assert.equal(normalized.detailAvailable, true);
  assert.equal(normalized.findings.filter((finding) => finding.aggregate).length, 0);
  assert.equal(normalized.counts.error, 2);
  assert.equal(normalized.counts.warning, 1);
  assert.equal(normalized.counts.total, 3);
  const floating = normalized.findings.find((finding) => /floating/i.test(finding.detail));
  assert.equal(floating.object, 'U1.A3');
  assert.match(floating.suggestion, /应接则补线/);
  const again = normalizeErcReport(structuredClone(raw));
  assert.equal(again.digest, normalized.digest, '同输入必须得到同 digest');
  assert.deepEqual(again.findings.map((finding) => finding.id), normalized.findings.map((finding) => finding.id));
});

test('ERC 空/畸形报告：ran=false 且明确报警，不返回"通过"', () => {
  for (const raw of [undefined, null, {}, 'nonsense', []]) {
    const normalized = normalizeErcReport(raw);
    assert.equal(normalized.ran, false);
    assert.equal(normalized.counts.total, 0);
    assert.equal(summarizeErcConvergence(normalized).errorsOpen, 0);
    assert.match(normalized.digest, /^[a-f0-9]{64}$/);
  }
});

test('ERC 豁免：必须写理由；无效豁免退回未处理；模板按 code 聚合且理由留空', () => {
  const normalized = normalizeErcReport([
    { type: 'error', count: 1, message: 'Pin is floating' },
    { type: 'warn', count: 19, message: 'PWR_FLAG missing on net +5V' },
  ]);
  const invalid = applyErcExemptions(normalized, [{ code: 'ERC_PIN_FLOATING', reason: '' }]);
  assert.equal(invalid.invalidExemptions.length, 1);
  assert.equal(invalid.invalidExemptions[0].index, 0);
  assert.equal(invalid.openCounts.error, 1, '理由缺失的豁免不能把错误藏起来');
  assert.equal(invalid.openCounts.warning, 19);

  const applied = applyErcExemptions(normalized, [
    { code: 'ERC_PIN_FLOATING', reason: 'Rev.A 仅功能样机，引脚按 datasheet 保持悬空。' },
    { code: 'ERC_POWER_FLAG', reason: '+5V 由电源适配器输入，PWR_FLAG 已由板边输入连接器声明。', object: 'unknown' },
  ]);
  assert.equal(applied.invalidExemptions.length, 0);
  assert.equal(applied.findings.filter((finding) => finding.exempted).length, 2);
  assert.equal(applied.openCounts.total, 0);
  assert.equal(summarizeErcConvergence(applied).exempted, 2);

  const template = buildErcExemptionTemplate(normalized);
  assert.equal(template.length, 2);
  assert.ok(template.every((entry) => entry.reason === ''));
  assert.deepEqual(template.map((entry) => entry.code).sort(), ['ERC_PIN_FLOATING', 'ERC_POWER_FLAG']);
});

test('ERC 豁免文件：原子写、读回、无效条目拒绝落盘', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-erc-'));
  try {
    const file = join(root, 'erc-exemptions.json');
    assert.equal(loadErcExemptionFile(file).exists, false);
    assert.throws(() => saveErcExemptionFile([{ code: 'ERC_PIN_FLOATING', reason: '' }], file), { code: 'ERC_EXEMPTION_INVALID' });
    const saved = saveErcExemptionFile([{ code: 'ERC_PIN_FLOATING', object: 'U1.A3', reason: '仅 Rev.A 样机接受。' }], file);
    assert.equal(saved.count, 1);
    const loaded = loadErcExemptionFile(file);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.invalid.length, 0);
    assert.equal(loaded.exemptions[0].reason, '仅 Rev.A 样机接受。');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.exemptions[0].code, 'ERC_PIN_FLOATING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A13：逐条结构化修复建议——悬空→noConnect、PWR_FLAG、聚合→先取明细；一律 autoFixable=false', () => {
  const floating = repairFor('ERC_PIN_FLOATING', 'Pin U1.7 is floating');
  assert.equal(floating.kind, 'no-connect');
  assert.equal(floating.autoFixable, false);
  assert.equal(floating.requiresHumanConfirm, true);
  assert.equal(floating.suggestedCommand.command, 'schematic.pin.noConnect');
  assert.ok(floating.verify.includes('重跑 ERC'));
  const pwr = repairFor('ERC_POWER_FLAG', 'Missing PWR_FLAG on VCC');
  assert.equal(pwr.kind, 'pwr-flag');
  assert.match(pwr.steps.join(' '), /PWR_FLAG/);
  const aggregate = repairFor('ERC_WARNING', '', { aggregate: true });
  assert.equal(aggregate.kind, 'manual');
  assert.match(aggregate.blockedReason, /聚合计数/);
  const unknown = repairFor('ERC_CUSTOM', 'unrecognized rule');
  assert.equal(unknown.kind, 'manual');
  assert.equal(unknown.autoFixable, false);
});

test('A13：归一化报告带上 repair/repairSummary，且豁免不会丢掉修复建议', () => {
  const report = normalizeErcReport([
    { type: 'warn', count: 6 },
    { type: 'error', items: [{ level: 'error', message: 'Pin U1.7 is floating', object: 'U1.7' }, { level: 'warning', message: 'Missing PWR_FLAG on VCC', object: 'VCC' }] },
  ]);
  assert.equal(report.findings.length, 3);
  const aggregate = report.findings.find((finding) => finding.aggregate);
  assert.equal(aggregate.repair.kind, 'manual');
  assert.equal(aggregate.repair.autoFixable, false);
  assert.equal(report.repairSummary.total, 3);
  assert.equal(report.repairSummary.autoFixable, 0);
  assert.equal(report.repairSummary.requiresHuman, 3);
  assert.equal(report.repairSummary.kinds['no-connect'], 1);
  assert.equal(report.repairSummary.kinds['pwr-flag'], 1);
  const applied = applyErcExemptions(report, [{ code: 'ERC_PIN_FLOATING', object: 'U1.7', reason: '样机允许悬空并已验证' }]);
  const exempted = applied.findings.find((finding) => finding.exempted);
  assert.equal(exempted.repair.kind, 'no-connect');
});
