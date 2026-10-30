import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeStore } from '../knowledge.mjs';
import { defineCollector } from '../collectors/collect.mjs';
import { KNOWLEDGE_PIPELINE_CODES, buildReviewQueue, healthMetrics, processCollectors } from '../knowledge-pipeline.mjs';

const partItem = (lcscId, extra = {}) => ({ kind: 'part', title: `part-${lcscId}`, payload: { lcscId, footprint: 'LED-SMD_4P' }, provenance: { source: 'lcsc', url: `https://lcsc.com/${lcscId}` }, trust: 'unverified', ttlDays: 30, ...extra });
const collector = (id, items, { fail = false } = {}) => defineCollector({ id, kind: 'part', source: 'fixture', run: async () => { if (fail) throw new Error('源失败'); return { items }; } });

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'kb-pipe-'));
  return { root, store: createKnowledgeStore({ root }) };
}

test('processCollectors：采集→合规标注→入库；重复条目计 duplicate；失败采集器隔离', async () => {
  const { root, store } = makeStore();
  try {
    const summary = await processCollectors({
      store,
      collectors: [collector('ok-a', [partItem('C1'), partItem('C2')]), collector('dup', [partItem('C1')]), collector('bad', [], { fail: true })],
      now: () => new Date('2026-10-21T12:00:00.000Z'),
    });
    assert.equal(summary.created, 2);
    assert.equal(summary.duplicates, 1);
    assert.equal(summary.failedCollectors.length, 1);
    assert.equal(summary.okCollectors, 2);
    assert.equal(summary.dedupeRate, 0.3333);
    const entries = store.list({ kind: 'part' });
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.review.state === 'candidate'));
    assert.ok(entries.every((entry) => entry.provenance.allowedAsDesignInput === true));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildReviewQueue：候选/冲突/过期分开列出', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-pipe-'));
  let clock = new Date('2026-10-21T12:00:00.000Z');
  const store = createKnowledgeStore({ root, now: () => clock });
  try {
    store.save({ kind: 'part', title: 'p1', payload: { lcscId: 'C1', footprint: 'A' }, provenance: { source: 'x' }, trust: 'reference', ttlDays: 1 });
    clock = new Date('2026-10-23T12:00:00.000Z');
    const b = store.save({ kind: 'part', title: 'p2', payload: { lcscId: 'C1', footprint: 'B' }, provenance: { source: 'y' }, trust: 'reference' });
    const c = store.save({ kind: 'part', title: 'p3', payload: { lcscId: 'C2', footprint: 'C' }, provenance: { source: 'z' }, trust: 'reference' });
    // 冲突检测只看 approved 条目：先审核再入队（AI 产物未审核前不算“权威矛盾”）
    for (const entry of [b.entry, c.entry]) store.review(entry.id, { state: 'approved', reviewedBy: 'lead' });
    const first = store.list({ includeExpired: true }).find((entry) => entry.title === 'p1');
    store.review(first.id, { state: 'approved', reviewedBy: 'lead' });
    const pending = store.save({ kind: 'part', title: 'p4', payload: { lcscId: 'C3', footprint: 'D' }, provenance: { source: 'w' }, trust: 'reference' });
    const queue = buildReviewQueue({ store });
    assert.equal(queue.candidateCount, 1);
    assert.deepEqual(queue.candidates.map((entry) => entry.title), ['p4']);
    assert.ok(queue.conflictCount >= 1);
    assert.equal(queue.expiredCount, 1);
    assert.ok(queue.conflicts.some((conflict) => conflict.entityKey === 'C1'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('healthMetrics：覆盖率/过期率/冲突率/命中率/待审数', () => {
  const { root, store } = makeStore();
  try {
    const a = store.save({ kind: 'part', title: 'a', payload: { lcscId: 'C1', footprint: 'A' }, provenance: { source: 'x' }, trust: 'reference' });
    store.save({ kind: 'rule', title: 'r', payload: { ruleId: 'R1' }, provenance: { source: 'y' }, trust: 'reference' });
    store.review(a.entry.id, { state: 'approved', reviewedBy: 'lead' });
    store.recordUsage({ id: a.entry.id, agent: 'librarian', outcome: 'used' });
    const metrics = healthMetrics({ store });
    assert.equal(metrics.total, 2);
    assert.equal(metrics.byKind.part, 1);
    assert.equal(metrics.byKind.rule, 1);
    assert.equal(metrics.coverage, 0.5);
    assert.equal(metrics.approved, 1);
    assert.equal(metrics.candidates, 1);
    assert.equal(metrics.hitRate, 0.5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('processCollectors：无采集器/无 store 直接拒绝', async () => {
  await assert.rejects(() => processCollectors({ collectors: [], store: null }), (error) => error.code === KNOWLEDGE_PIPELINE_CODES.INVALID);
});
