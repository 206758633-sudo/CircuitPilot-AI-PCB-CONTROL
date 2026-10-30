import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeStore } from '../knowledge.mjs';
import { defineCollector } from '../collectors/collect.mjs';
import { badcaseItemsFromEvidence, createKnowledgeManager } from '../agents/knowledge-manager.mjs';

const env = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kma-'));
  return { dir, store: createKnowledgeStore({ root: join(dir, 'knowledge') }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const evidence = (kind, verdict, codes = []) => ({
  path: `/evidence/${kind}-${verdict}-${codes.join('-')}.json`,
  data: { schemaVersion: 1, kind, digest: `digest-${kind}-${codes.join('-')}`, fingerprint: { pcbUuid: 'pcb-1' }, savedAt: '2026-10-21T00:00:00.000Z', payload: { verdict, findings: codes.map((code) => ({ code, severity: 'error', message: `命中 ${code}` })) } },
});

test('badcaseItemsFromEvidence：pass 忽略；blocked/unknown 归并成 failure 候选并去重', () => {
  const files = [
    evidence('netlist-diff', 'blocked', ['NET_MISSING']),
    evidence('rules', 'unknown', ['DRC_UNEXPLAINED']),
    evidence('netlist-diff', 'pass', []),
    evidence('netlist-diff', 'blocked', ['NET_MISSING']),
  ];
  const items = badcaseItemsFromEvidence({ files, now: () => new Date('2026-10-22T00:00:00.000Z') });
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.kind === 'failure'));
  assert.ok(items.some((item) => String(item.payload.failureId).includes('NET_MISSING')));
  assert.ok(items.every((item) => item.provenance.source === 'evidence'));
});

test('ingestBadcases：写入 candidate、重复运行幂等、listBadcases 可读', () => {
  const { store, cleanup } = env();
  try {
    const manager = createKnowledgeManager({ store });
    const files = [evidence('rules', 'blocked', ['ERC_PIN_FLOATING'])];
    const first = manager.ingestBadcases({ files });
    assert.equal(first.ok, true);
    assert.equal(first.created, 1);
    const second = manager.ingestBadcases({ files });
    assert.equal(second.created, 0);
    assert.equal(second.duplicates, 1);
    const badcases = manager.listBadcases();
    assert.equal(badcases.length, 1);
    assert.equal(badcases[0].review.state, 'candidate');
    assert.equal(store.isUsableForGate(badcases[0]), false);
  } finally { cleanup(); }
});

test('ingestBadcases：无证据目录 → 结构化失败，不产条目', () => {
  const { store, cleanup } = env();
  try {
    const manager = createKnowledgeManager({ store });
    const result = manager.ingestBadcases({});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'KMA_SOURCE_UNAVAILABLE');
    assert.equal(manager.listBadcases().length, 0);
  } finally { cleanup(); }
});

test('ingestWebKnowledge：成功采集写 candidate，失败采集只报原因不伪造', async () => {
  const { store, cleanup } = env();
  try {
    const good = defineCollector({ id: 'fake-good', kind: 'rule', source: 'fake', run: async () => ({ items: [{ kind: 'rule', title: '间距规则', payload: { ruleId: 'WEB-1', value: 0.2 }, provenance: { source: 'web', url: 'https://example.com/a' }, trust: 'unverified', ttlDays: 90 }], evidence: { ok: true } }) });
    const bad = defineCollector({ id: 'fake-bad', kind: 'rule', source: 'fake', run: async () => { throw Object.assign(new Error('断网'), { code: 'RESEARCH_NETWORK_ERROR' }); } });
    const manager = createKnowledgeManager({ store, webCollectors: [good, bad] });
    const result = await manager.ingestWebKnowledge();
    assert.equal(result.ok, true);
    assert.equal(result.created, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].collector, 'fake-bad');
    assert.equal(store.list({ kind: 'rule' }).length, 1);
  } finally { cleanup(); }
});

test('maintain：输出健康度/待审/过期/冲突与建议，不改变审核状态', () => {
  const { store, cleanup } = env();
  try {
    const manager = createKnowledgeManager({ store });
    manager.ingestBadcases({ files: [evidence('rules', 'blocked', ['DRC_UNEXPLAINED'])] });
    const report = manager.maintain({ saveEvidence: false });
    assert.equal(report.ok, true);
    assert.equal(report.pendingReview, 1);
    assert.equal(report.expired.count, 0);
    assert.equal(report.conflicts.count, 0);
    assert.ok(report.recommendations.length >= 1);
    assert.equal(store.list({ kind: 'failure' })[0].review.state, 'candidate');
  } finally { cleanup(); }
});

test('ingestBadcases：证据目录不存在 → SOURCE_UNAVAILABLE（不把空扫描当成功）', () => {
  const { store, cleanup } = env();
  try {
    const manager = createKnowledgeManager({ store, evidenceRoot: '/definitely/not/exists' });
    const result = manager.ingestBadcases({});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'KMA_SOURCE_UNAVAILABLE');
  } finally { cleanup(); }
});
