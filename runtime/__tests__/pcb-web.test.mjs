import assert from 'node:assert/strict';
import test from 'node:test';
import { createPcbWebCollector } from '../collectors/pcb-web.mjs';

const topic = { id: 'drc', query: 'PCB DRC 设计规则', kind: 'rule' };

test('pcb-web：白名单域名过滤 + 摘要入库（unverified）', async () => {
  const collector = createPcbWebCollector({
    topic,
    domains: ['example.com'],
    searchImpl: async () => ({ ok: true, provider: 'fake', results: [
      { url: 'https://example.com/drc', title: 'DRC 规则' },
      { url: 'https://evil.com/x', title: '不在白名单' },
      { url: 'https://example.com/file.pdf', title: 'PDF 跳过' },
    ] }),
    fetchImpl: async ({ url }) => ({ ok: url.includes('drc'), text: '  间距   0.2mm  \n 线宽 0.25mm ' }),
  });
  const result = await collector.run({});
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.kind, 'rule');
  assert.equal(item.trust, 'unverified');
  assert.equal(item.payload.ruleId, 'WEB-drc-https://example.com/drc');
  assert.ok(item.payload.excerpt.includes('0.2mm'));
  assert.equal(result.evidence.pages.length, 1);
});

test('pcb-web：搜索失败返回原因码且不产条目', async () => {
  const collector = createPcbWebCollector({ topic, searchImpl: async () => ({ ok: false, code: 'RESEARCH_NETWORK_ERROR' }) });
  const result = await collector.run({});
  assert.equal(result.items.length, 0);
  assert.equal(result.evidence.search.ok, false);
  assert.equal(result.evidence.search.code, 'RESEARCH_NETWORK_ERROR');
});

test('pcb-web：sources 模式直接抓权威页，不走搜索；白名单外源被丢弃', async () => {
  const calls = [];
  const collector = createPcbWebCollector({
    topic: { id: 'drc', kind: 'rule', sources: [{ url: 'https://example.com/drc', title: 'DRC 指南' }, { url: 'https://outside.com/x', title: '站外' }] },
    domains: ['example.com'],
    fetchImpl: async ({ url }) => { calls.push(url); return { ok: true, text: 'clearance 0.2mm' }; },
    searchImpl: async () => { throw new Error('不应走搜索'); },
  });
  const result = await collector.run({});
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://example.com/drc');
  assert.equal(result.items.length, 1);
  assert.equal(result.evidence.search.mode, 'curated');
  assert.equal(result.items[0].payload.ruleId, 'WEB-drc-https://example.com/drc');
});

test('pcb-web：抽摘要会跳过导航噪声，保留主题相关句子', async () => {
  const { extractRelevantExcerpt } = await import('../collectors/pcb-web.mjs');
  const excerpt = extractRelevantExcerpt('Jump to content Main menu hide Navigation Main page Contents random article. Design rule checking verifies that a PCB layout satisfies manufacturing constraints such as clearance and trace width. It is performed before fabrication. Get coupon here.', { topicId: 'drc', maxChars: 300 });
  assert.ok(excerpt.includes('clearance'));
  assert.ok(excerpt.includes('fabrication'));
  assert.ok(!excerpt.startsWith('Jump to content'));
});
