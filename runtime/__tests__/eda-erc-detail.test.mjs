import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeErcReport } from '../erc.mjs';
import { ERC_DETAIL_SOURCE, extractErcDetail, mergeErcDetail } from '../eda-erc-detail.mjs';

const aggregate = () => normalizeErcReport([
  { type: 'error', count: 1 },
  { type: 'warn', count: 34 },
  { type: 'info', count: 2 },
]);

const warningItems = (count) => Array.from({ length: count }, (_, index) => ({ level: 'warning', message: `发现元件引脚悬空：R${index + 1}.1` }));

test('聚合 ERC + 面板明细 → 逐条 finding：错误落到可定位对象，不再只是"有 1 个错误"', () => {
  const report = mergeErcDetail(aggregate(), {
    ok: true,
    items: [
      { level: 'error', message: '网络 GND 与 +3V3 短路（对象 U1.2）', object: 'U1.2' },
      ...warningItems(34),
      { level: 'info', message: '信息一' },
      { level: 'info', message: '信息二' },
    ],
  });
  assert.equal(report.aggregateOnly, false);
  assert.equal(report.detailAvailable, true);
  assert.equal(report.detailSource, ERC_DETAIL_SOURCE);
  assert.equal(report.counts.error, 1);
  assert.equal(report.counts.warning, 34);
  const blocking = report.findings.filter((finding) => !finding.aggregate && finding.severity === 'error');
  assert.equal(blocking.length, 1);
  assert.match(blocking[0].detail, /GND 与 \+3V3/);
  assert.ok(!report.findings.some((finding) => finding.aggregate && finding.severity === 'error'), '错误计数已由逐条明细覆盖，不得同时保留聚合条目');
});

test('明细覆盖不全时保留聚合余量：宁肯"部分明细+部分聚合"，也不把 34 条警告只当 5 条', () => {
  const report = mergeErcDetail(aggregate(), {
    ok: true,
    items: [{ level: 'error', message: 'E1' }, ...warningItems(5)],
  });
  assert.equal(report.aggregateOnly, false);
  assert.equal(report.counts.warning, 34, '总数必须仍是 34（5 条逐条 + 29 条聚合余量）');
  assert.ok(report.findings.some((finding) => finding.aggregate && finding.severity === 'warning'), '未覆盖的 29 条必须保留为聚合条目');
  assert.equal(report.detailCounts.partial.warning.detailed, 5);
});

test('明细不可用/为空 → 原样返回聚合报告（不得把"抓不到"包装成"已逐条核对"）', () => {
  const agg = aggregate();
  assert.equal(mergeErcDetail(agg, { ok: false, reason: 'ERC_PANEL_NOT_FOUND' }), agg);
  assert.equal(mergeErcDetail(agg, { ok: true, items: [] }), agg);
  assert.equal(mergeErcDetail(agg, null), agg);
});

test('extractErcDetail：GUI 抓取失败如实返回 reason，不编造条目', async () => {
  const failed = await extractErcDetail({ gui: { execute: async () => ({ ok: false, reason: 'ERC_PANEL_NOT_FOUND' }) } });
  assert.equal(failed.ok, false);
  assert.match(String(failed.reason), /ERC_PANEL_NOT_FOUND/);
  const noGui = await extractErcDetail({ gui: null });
  assert.deepEqual(noGui, { ok: false, reason: 'NO_GUI' });
});

test('extractErcDetail：成功时把级别词归一化（warn→warning）并截断超长消息', async () => {
  const detail = await extractErcDetail({
    gui: { execute: async () => ({ ok: true, counts: { error: 0, warning: 1 }, items: [{ level: 'warn', message: '  引脚悬空 U1.4  ' }, { level: '错误', message: 'x'.repeat(900) }] }) },
  });
  assert.equal(detail.ok, true);
  assert.equal(detail.source, ERC_DETAIL_SOURCE);
  assert.equal(detail.items[0].level, 'warning');
  assert.equal(detail.items[0].message, '引脚悬空 U1.4');
  assert.equal(detail.items[1].level, 'error');
  assert.ok(detail.items[1].message.length <= 400);
});
