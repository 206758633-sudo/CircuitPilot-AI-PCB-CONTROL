import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeStore } from '../knowledge.mjs';
import { COLLECTOR_CODES, collectAll, defineCollector, ingestCollectorItems, runCollector } from '../collectors/collect.mjs';
import { createResearchCollector } from '../collectors/research.mjs';

test('defineCollector/runCollector：成功采集返回 items+evidence+耗时', async () => {
  const collector = defineCollector({ id: 'fake-source', kind: 'part', source: 'fixture', run: async () => ({ items: [{ kind: 'part', title: 'x', payload: { a: 1 }, provenance: { source: 'fixture' } }], evidence: { ok: true } }) });
  const result = await runCollector(collector);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.evidence, { ok: true });
  assert.ok(result.elapsedMs >= 0);
});

test('runCollector：失败与超时都结构化返回，不抛栈', async () => {
  const boom = defineCollector({ id: 'boom', kind: 'rule', source: 'fixture', run: async () => { throw new Error('源不可用'); } });
  const failed = await runCollector(boom);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, COLLECTOR_CODES.FAILED);
  const slow = defineCollector({ id: 'slow', kind: 'rule', source: 'fixture', run: () => new Promise((resolve) => setTimeout(() => resolve({ items: [] }), 200)) });
  const timedOut = await runCollector(slow, { timeoutMs: 10 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, COLLECTOR_CODES.TIMEOUT);
});

test('collectAll：单源失败隔离，汇总 total/ok/failed/itemCount', async () => {
  const ok = defineCollector({ id: 'ok', kind: 'part', source: 'fixture', run: async () => ({ items: [{ kind: 'part', title: 'a', payload: {}, provenance: { source: 'fixture' } }] }) });
  const bad = defineCollector({ id: 'bad', kind: 'part', source: 'fixture', run: async () => { throw new Error('x'); } });
  const summary = await collectAll({ collectors: [ok, bad] });
  assert.equal(summary.total, 2);
  assert.equal(summary.ok, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.itemCount, 1);
});

test('资料采集器：检索→抓取→参考级候选条目（注入 fake，不联网）', async () => {
  const collector = createResearchCollector({
    query: 'WS2812B datasheet',
    searchImpl: async () => ({ ok: true, provider: 'duckduckgo', results: [{ title: 'WS2812B', url: 'https://example.com/ws2812b', snippet: 'LED' }, { title: 'PDF', url: 'https://example.com/a.pdf' }] }),
    fetchImpl: async ({ url }) => ({ ok: url === 'https://example.com/ws2812b', text: 'WS2812B 是一颗 RGB LED，单线级联。', code: null }),
    now: () => new Date('2026-10-21T12:00:00.000Z'),
  });
  const result = await runCollector(collector);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].trust, 'unverified');
  assert.equal(result.items[0].provenance.url, 'https://example.com/ws2812b');
  assert.equal(result.items[0].provenance.fetchedAt, '2026-10-21T12:00:00.000Z');
});

test('ingestCollectorItems：写入知识库必须为 candidate，且可检索', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-ingest-'));
  try {
    const store = createKnowledgeStore({ root });
    const collector = createResearchCollector({
      query: 'ESP32-S3 datasheet',
      searchImpl: async () => ({ ok: true, provider: 'bing', results: [{ title: 'ESP32-S3', url: 'https://example.com/esp32s3', snippet: 'MCU' }] }),
      fetchImpl: async () => ({ ok: true, text: 'ESP32-S3 双核 LX7。', code: null }),
    });
    const result = await runCollector(collector);
    const ingested = ingestCollectorItems({ store, result });
    assert.equal(ingested.count, 1);
    const entries = store.query({ text: 'ESP32-S3' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].review.state, 'candidate');
    assert.equal(store.isUsableForGate(entries[0]), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
