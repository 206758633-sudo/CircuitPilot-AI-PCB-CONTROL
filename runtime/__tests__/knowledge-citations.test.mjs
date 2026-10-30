import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceEnvelope } from '../evidence-contract.mjs';
import { createKnowledgeStore } from '../knowledge.mjs';
import { CITATION_CODES, attachKnowledgeCitations, resolveCitations } from '../agents/knowledge-citations.mjs';

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'cite-'));
  return { root, store: createKnowledgeStore({ root }) };
}
const savePart = (store) => store.save({ kind: 'part', title: 'WS2812B', payload: { lcscId: 'C114586', footprint: 'LED-SMD_4P' }, provenance: { source: 'lcsc' }, trust: 'reference', ttlDays: 30 });
const envelope = () => createEvidenceEnvelope({ kind: 'lib-evidence', subject: { type: 'part', id: 'C114586' }, fingerprint: { lcscId: 'C114586' }, source: { agent: 'librarian', readOnly: true }, verdict: 'pass', findings: [] });

test('resolveCitations：未审核条目不可引用；approved 后才可引用', () => {
  const { root, store } = makeStore();
  try {
    const saved = savePart(store);
    const before = resolveCitations({ store, citations: [{ knowledgeId: saved.entry.id, usedFor: '封装选型' }] });
    assert.equal(before.ok, false);
    assert.equal(before.invalid[0].code, CITATION_CODES.UNUSABLE);
    store.review(saved.entry.id, { state: 'approved', reviewedBy: 'lead' });
    const after = resolveCitations({ store, citations: [{ knowledgeId: saved.entry.id, usedFor: '封装选型' }] });
    assert.equal(after.ok, true);
    assert.equal(after.resolved[0].knowledgeId, saved.entry.id);
    assert.match(after.resolved[0].digest, /^[a-f0-9]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('attachKnowledgeCitations：引用无效拒绝；有效则附加且仍符合证据契约', () => {
  const { root, store } = makeStore();
  try {
    const saved = savePart(store);
    assert.throws(() => attachKnowledgeCitations(envelope(), { store, citations: [{ knowledgeId: saved.entry.id }] }), (error) => error.code === CITATION_CODES.UNUSABLE);
    store.review(saved.entry.id, { state: 'approved', reviewedBy: 'lead' });
    const attached = attachKnowledgeCitations(envelope(), { store, citations: [{ knowledgeId: saved.entry.id, usedFor: '封装选型' }] });
    assert.equal(attached.citations.length, 1);
    assert.equal(attached.kind, 'lib-evidence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
