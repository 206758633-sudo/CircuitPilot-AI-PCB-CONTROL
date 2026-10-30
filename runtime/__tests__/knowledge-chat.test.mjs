import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { buildKnowledgeChatContext } from '../knowledge-chat.mjs';
import { createKnowledgeStore } from '../knowledge.mjs';
import { createRagStore } from '../rag/store.mjs';

/**
 * WP4 P1-10：知识进对话——只引用 approved + 未过期条目，citations 必须回指真实条目，
 * candidate/unverified/过期不得被当成对话依据（更不能伪造引用）。
 */

const NOW = new Date('2026-10-26T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const root = mkdtempSync(join(tmpdir(), 'cp-chat-knowledge-'));
const store = createKnowledgeStore({ root: join(root, 'knowledge'), now: () => NOW });

const saveAndReview = ({ kind = 'rule', title, payload, trust = 'reference', ttlDays, approve = true }) => {
  const entry = store.save({ kind, title, payload, trust, provenance: { source: 'test' }, ...(ttlDays === undefined ? {} : { ttlDays }) }).entry;
  return approve ? store.review(entry.id, { state: 'approved', reviewedBy: 'lead' }) : entry;
};

const approved = saveAndReview({ title: '去耦电容摆放规则', payload: { ruleId: 'DECOUPLING', value: '去耦电容尽量靠近电源引脚，回路面积最小' } });
const candidate = saveAndReview({ title: '去耦电容摆放候选经验', payload: { ruleId: 'DECOUPLING', value: '候选内容不得直接引用' }, approve: false });
const unverified = saveAndReview({ title: '去耦电容未核验说法', payload: { ruleId: 'DECOUPLING', value: '未核验内容' }, trust: 'unverified' });
const expired = saveAndReview({ title: '去耦电容过期规则', payload: { ruleId: 'DECOUPLING', value: '过期内容' }, ttlDays: 1 });

const laterStore = createKnowledgeStore({ root: join(root, 'knowledge'), now: () => new Date(NOW.getTime() + 10 * DAY) });

const fakeRag = (knowledgeIds) => ({
  query: () => ({
    query: '去耦电容',
    results: knowledgeIds.map((knowledgeId, index) => ({ meta: { knowledgeId }, score: 1 - index * 0.1 })),
  }),
});

test('WP4 P1-10：只返回 approved+未过期条目，candidate/unverified/过期/缺失全部过滤', () => {
  const ragStore = fakeRag([approved.id, candidate.id, unverified.id, expired.id, 'kn-rule-missing', null]);
  const context = buildKnowledgeChatContext({ ragStore, knowledgeStore: laterStore, query: '去耦电容怎么摆？', topK: 3 });
  assert.equal(context.contexts.length, 1, '只有 approved+未过期可以进上下文');
  assert.equal(context.contexts[0].knowledgeId, approved.id);
  assert.equal(context.contexts[0].review, 'approved');
  assert.equal(context.contexts[0].trust, 'reference');
  assert.match(context.contexts[0].excerpt, /去耦电容|回路面积/);
  assert.equal(context.citations.length, 1);
  assert.deepEqual(context.citations[0], {
    id: approved.id,
    title: approved.title,
    trust: 'reference',
    review: 'approved',
    citation: `knowledge:${approved.id}`,
  });
  const reasons = Object.fromEntries(context.skipped.map((item) => [item.knowledgeId, item.reason]));
  assert.equal(reasons[candidate.id], 'unreviewed');
  assert.equal(reasons[unverified.id], 'unverified');
  assert.equal(reasons[expired.id], 'expired');
  assert.equal(reasons['kn-rule-missing'], 'not_found');
  assert.match(String(context.note), /已过滤/);
  // 不得伪造引用：所有 citation 都能回查到真实条目。
  for (const citation of context.citations) {
    const entry = laterStore.get(citation.id);
    assert.ok(entry, `citation 指向的条目必须真实存在：${citation.id}`);
  }
});

test('WP4 P1-10：没有任何 approved 知识 → 空上下文 + 明确说明（不塞候选）', () => {
  const ragStore = fakeRag([candidate.id, unverified.id]);
  const context = buildKnowledgeChatContext({ ragStore, knowledgeStore: laterStore, query: '去耦电容' });
  assert.deepEqual(context.contexts, []);
  assert.deepEqual(context.citations, []);
  assert.match(String(context.note), /approved/);
  assert.ok(context.skipped.length >= 2);
});

test('WP4 P1-10：topK 限制生效且不重复引用同一条知识', () => {
  const ragStore = fakeRag([approved.id, approved.id, approved.id]);
  const context = buildKnowledgeChatContext({ ragStore, knowledgeStore: laterStore, query: '去耦电容', topK: 3 });
  assert.equal(context.contexts.length, 1);
  assert.equal(context.citations.length, 1);
});

test('WP4 P1-10：真实 RAG store 命中 approved 知识时给出可回查引用', () => {
  const rag = createRagStore({ knowledgeStore: store, indexFile: join(root, 'rag', 'index.json'), baseDir: root, now: () => NOW });
  const context = buildKnowledgeChatContext({ ragStore: rag, knowledgeStore: store, query: '去耦电容', topK: 3 });
  assert.ok(context.contexts.length >= 1, 'approved 知识必须能被检索进对话上下文');
  assert.ok(context.contexts.some((item) => item.knowledgeId === approved.id));
  assert.ok(context.citations.every((citation) => store.get(citation.id)), 'citations 必须真实存在');
  assert.ok(!context.contexts.some((item) => item.knowledgeId === candidate.id), 'candidate 不得进入对话依据');
});

test('WP4 P1-10：RAG 检索异常 → 空上下文 + 原因，不编造引用、不抛崩', () => {
  const context = buildKnowledgeChatContext({
    ragStore: { query: () => { throw new Error('rag down'); } },
    knowledgeStore: store,
    query: '去耦电容',
  });
  assert.deepEqual(context.contexts, []);
  assert.deepEqual(context.citations, []);
  assert.match(String(context.note), /知识检索不可用/);
});

test('WP4 P1-10：非法入参抛 KNOWLEDGE_CHAT_INVALID', () => {
  assert.throws(() => buildKnowledgeChatContext({ knowledgeStore: store, query: 'x' }), (error) => error.code === 'KNOWLEDGE_CHAT_INVALID');
  assert.throws(() => buildKnowledgeChatContext({ ragStore: fakeRag([]), query: 'x' }), (error) => error.code === 'KNOWLEDGE_CHAT_INVALID');
  assert.throws(() => buildKnowledgeChatContext({ ragStore: fakeRag([]), knowledgeStore: store, query: '  ' }), (error) => error.code === 'KNOWLEDGE_CHAT_INVALID');
});

after(() => rmSync(root, { recursive: true, force: true }));
