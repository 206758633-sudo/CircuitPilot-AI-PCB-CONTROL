import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeStore } from '../knowledge.mjs';
import { KNOWLEDGE_API_CODES, createKnowledgeApi } from '../knowledge-api.mjs';

function makeApi() {
  const root = mkdtempSync(join(tmpdir(), 'kb-api-'));
  const store = createKnowledgeStore({ root });
  return { root, store, api: createKnowledgeApi({ store }) };
}
const part = () => ({
  kind: 'part',
  title: 'WS2812B-2020',
  payload: { lcscId: 'C114586', footprint: 'LED-SMD_4P', pins: { 1: 'VDD', 2: 'DOUT', 3: 'GND', 4: 'DIN' } },
  provenance: { source: 'lcsc', url: 'https://www.lcsc.com/product-detail/C114586.html' },
  trust: 'reference',
});

test('save：API 写入永远是 candidate（trust=reference 也不能自动 approved）', () => {
  const { root, api } = makeApi();
  try {
    const { entry, created } = api.save(part());
    assert.equal(created, true);
    assert.equal(entry.review.state, 'candidate');
    assert.equal(entry.trust, 'reference');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('save：authoritative 必须走 review，直接写入被拒绝', () => {
  const { root, api } = makeApi();
  try {
    assert.throws(() => api.save({ ...part(), trust: 'authoritative' }), (error) => error.code === KNOWLEDGE_API_CODES.REVIEWER_REQUIRED);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('review：必须有 reviewedBy 且状态只能是 approved/rejected', () => {
  const { root, api } = makeApi();
  try {
    const { entry } = api.save(part());
    assert.throws(() => api.review({ id: entry.id, state: 'approved' }), (error) => error.code === KNOWLEDGE_API_CODES.REVIEWER_REQUIRED);
    assert.throws(() => api.review({ id: entry.id, state: 'candidate', reviewedBy: 'lead' }), (error) => error.code === KNOWLEDGE_API_CODES.REVIEW_STATE_INVALID);
    const reviewed = api.review({ id: entry.id, state: 'approved', reviewedBy: 'lead' });
    assert.equal(reviewed.entry.review.state, 'approved');
    assert.equal(reviewed.entry.review.reviewedBy, 'lead');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('list：支持 kind/trust/text/entityKey 过滤，并返回门禁可用数量', () => {
  const { root, api } = makeApi();
  try {
    const a = api.save(part());
    api.save({ ...part(), title: '另一个零件', payload: { lcscId: 'C999', footprint: 'X' } });
    const all = api.list({ kind: 'part' });
    assert.equal(all.total, 2);
    assert.equal(all.gateUsable, 0);
    const byText = api.list({ text: 'WS2812B' });
    assert.equal(byText.total, 1);
    const byKey = api.list({ entityKey: 'C114586' });
    assert.equal(byKey.total, 1);
    api.review({ id: a.entry.id, state: 'approved', reviewedBy: 'lead' });
    assert.equal(api.list({ kind: 'part' }).gateUsable, 1);
    assert.throws(() => api.list({ kind: 'nope' }), (error) => error.code === KNOWLEDGE_API_CODES.INVALID);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conflicts/usage：冲突检测与使用记录可读写', () => {
  const { root, api } = makeApi();
  try {
    const a = api.save(part());
    const b = api.save({ ...part(), title: '冲突候选', payload: { lcscId: 'C114586', footprint: 'LED-SMD-WRONG' } });
    api.review({ id: a.entry.id, state: 'approved', reviewedBy: 'lead' });
    api.review({ id: b.entry.id, state: 'approved', reviewedBy: 'lead' });
    assert.equal(api.conflicts({ entityKey: 'C114586' }).conflicts.length, 1);
    api.recordUsage({ id: a.entry.id, agent: 'librarian', outcome: 'used', note: '选型引用' });
    const usage = api.usage({ id: a.entry.id });
    assert.equal(usage.usages.length, 1);
    assert.equal(usage.usages[0].agent, 'librarian');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
