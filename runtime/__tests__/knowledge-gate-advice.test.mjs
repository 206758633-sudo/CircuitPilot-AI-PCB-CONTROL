import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GATE_REASON_TAGS, buildGateKnowledgeAdvice } from '../knowledge-gate-advice.mjs';
import { createKnowledgeStore } from '../knowledge.mjs';
import { buildCorpus, knowledgeDocumentsFromStore } from '../rag/corpus.mjs';

/**
 * P0-9：approved 必须真的改变产品行为。
 *   - candidate / unverified / 过期条目不得进入门禁建议；
 *   - approved 条目进入建议并写 usage（可回溯是哪次门禁、哪条原因用到了它）；
 *   - RAG 语料排除过期条目，且命中结果带 review/trust/gateUsable，UI 才能如实标注“候选未审核”。
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-26T12:00:00.000Z');

const report = {
  verdict: 'blocked',
  gates: [
    {
      id: 'G4', name: '规则门', verdict: 'blocked', requiredKinds: ['rules'],
      reasons: [{ code: 'GATE_EVIDENCE_MISSING', severity: 'blocking', message: '缺少 rules 证据' }],
    },
  ],
};

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'cp-p09-'));
  return { root, store: createKnowledgeStore({ root, now: () => NOW }) };
}

test('P0-9：candidate / unverified 不进门禁建议；approved 进入并写 usage', () => {
  const { root, store } = makeStore();
  try {
    const candidate = store.save({
      kind: 'rule', title: '缺规则证据时的补救步骤', trust: 'reference',
      payload: { ruleId: 'GATE_EVIDENCE_MISSING', value: '先跑官方 ERC/DRC 并落盘 rules 证据' },
      provenance: { source: 'test' }, reviewState: 'candidate',
    }).entry;
    const unverified = store.save({
      kind: 'rule', title: '未核验的规则建议', trust: 'unverified',
      payload: { ruleId: 'GATE_EVIDENCE_MISSING', value: '未核验内容不能当依据' },
      provenance: { source: 'test' }, reviewState: 'approved',
    }).entry;
    const first = buildGateKnowledgeAdvice({ store, report });
    assert.equal(first.suggested.length, 0, 'candidate/unverified 一个都不能进建议');
    assert.ok(first.unusableSkipped >= 2);
    assert.ok(first.note && first.note.includes('approved'));

    store.review(candidate.id, { state: 'approved', reviewedBy: 'lead' });
    const second = buildGateKnowledgeAdvice({ store, report });
    assert.equal(second.suggested.length, 1);
    const advice = second.suggested[0];
    assert.equal(advice.knowledgeId, candidate.id);
    assert.equal(advice.review, 'approved');
    assert.equal(advice.trust, 'reference');
    assert.equal(advice.gateId, 'G4');
    assert.equal(advice.reasonCode, 'GATE_EVIDENCE_MISSING');
    assert.match(advice.citation, /^knowledge:kn-rule-/);
    const usages = store.listUsages({ id: candidate.id });
    assert.equal(usages.length, 1, '被采用的知识必须写 usage');
    assert.equal(usages[0].agent, 'gate-engine');
    assert.equal(usages[0].outcome, 'used');
    assert.match(usages[0].note, /G4\/GATE_EVIDENCE_MISSING/);
    // unverified 即便 approved 也不能被采用。
    assert.ok(!second.suggested.some((item) => item.knowledgeId === unverified.id));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P0-9：approved 但已过期 → 不进门禁建议', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-p09-exp-'));
  try {
    const store = createKnowledgeStore({ root, now: () => NOW });
    const entry = store.save({
      kind: 'rule', title: '短期有效的临时规则', trust: 'reference', ttlDays: 1,
      payload: { ruleId: 'GATE_EVIDENCE_MISSING', value: '一天后过期' },
      provenance: { source: 'test' },
    }).entry;
    store.review(entry.id, { state: 'approved', reviewedBy: 'lead' });
    const later = createKnowledgeStore({ root, now: () => new Date(NOW.getTime() + 10 * DAY) });
    assert.equal(later.list({ includeExpired: true }).find((item) => item.id === entry.id)?.expired, true);
    const advice = buildGateKnowledgeAdvice({ store: later, report });
    assert.equal(advice.suggested.length, 0);
    assert.deepEqual(later.listUsages({ id: entry.id }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P0-9：RAG 语料排除过期、保留 candidate 但显式标记 review/trust/gateUsable', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-p09-rag-'));
  try {
    const store = createKnowledgeStore({ root, now: () => NOW });
    const candidate = store.save({
      kind: 'rule', title: '去耦电容摆放', trust: 'reference',
      payload: { ruleId: 'DECOUPLING', value: '靠近电源引脚' }, provenance: { source: 'test' },
    }).entry;
    const expired = store.save({
      kind: 'rule', title: '过期规则', trust: 'reference', ttlDays: 1,
      payload: { ruleId: 'OLD_RULE', value: '过期内容' }, provenance: { source: 'test' },
    }).entry;
    store.review(expired.id, { state: 'approved', reviewedBy: 'lead' });
    // 把“现在”推后使 ttlDays=1 的条目过期。
    const later = createKnowledgeStore({ root, now: () => new Date(NOW.getTime() + 5 * DAY) });
    const documents = knowledgeDocumentsFromStore(later);
    assert.ok(!documents.some((document) => document.meta.knowledgeId === expired.id), '过期条目不得进入 RAG 语料');
    const candidateDoc = documents.find((document) => document.meta.knowledgeId === candidate.id);
    assert.ok(candidateDoc, 'candidate 可被检索但必须标注');
    assert.equal(candidateDoc.meta.review, 'candidate');
    assert.equal(candidateDoc.meta.trust, 'reference');
    assert.equal(candidateDoc.meta.gateUsable, false);
    const corpus = buildCorpus({ store: later, dirs: [], baseDir: root });
    assert.equal(corpus.stats.knowledge, documents.length);
    assert.equal(corpus.stats.expiredExcluded, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('WP4 P0-6：真实语料形态（无 GATE_ 原因码、只有 drc/erc 主题词）也能命中 approved 建议', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-p06-tags-'));
  try {
    const store = createKnowledgeStore({ root, now: () => NOW });
    const approved = store.save({
      kind: 'rule', title: 'PCB DRC 间距规则', trust: 'reference',
      payload: { ruleId: 'DRC-CLEARANCE', value: '信号线间距 ≥ 0.2mm，铺铜间距 ≥ 0.25mm' },
      provenance: { source: 'test' }, reviewState: 'approved',
    }).entry;
    const candidate = store.save({
      kind: 'rule', title: 'DRC 间距候选经验', trust: 'reference',
      payload: { ruleId: 'DRC-CANDIDATE', value: '候选内容需审核后才可作为依据' },
      provenance: { source: 'test' },
    }).entry;
    const advice = buildGateKnowledgeAdvice({ store, report });
    assert.ok(advice.suggested.length >= 1, '标签映射必须让真实主题词命中的 approved 知识进入建议');
    assert.ok(advice.suggested.some((item) => item.knowledgeId === approved.id));
    assert.ok(advice.suggested.every((item) => item.review === 'approved'));
    assert.ok(advice.candidates.some((item) => item.knowledgeId === candidate.id), '同主题 candidate 必须出现在 candidates');
    const candidateAdvice = advice.candidates.find((item) => item.knowledgeId === candidate.id);
    assert.equal(candidateAdvice.reason, 'unreviewed');
    assert.match(candidateAdvice.note, /需人工审核/);
    assert.ok(advice.candidates.every((item) => item.knowledgeId !== approved.id), 'approved 不得混进 candidates');
    assert.equal(advice.usageRecorded, advice.suggested.length, '每条建议的 usage 成功写入数必须可见');
    assert.deepEqual(advice.usageFailures, []);
    const usages = store.listUsages({ id: approved.id });
    assert.equal(usages.length, 1);
    assert.match(usages[0].note, /G4\/GATE_EVIDENCE_MISSING/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('WP4 P0-6：usage 写失败不再静默吞掉（建议仍返回，failures/note 可见）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-p06-usagefail-'));
  try {
    const store = createKnowledgeStore({ root, now: () => NOW });
    const approved = store.save({
      kind: 'rule', title: 'ERC 悬空引脚处理规则', trust: 'reference',
      payload: { ruleId: 'ERC-DANGLING', value: '未使用引脚必须标记 no-connect' },
      provenance: { source: 'test' }, reviewState: 'approved',
    }).entry;
    const failing = Object.assign(Object.create(store), {
      recordUsage: () => { throw new Error('disk full'); },
    });
    const advice = buildGateKnowledgeAdvice({ store: failing, report });
    assert.ok(advice.suggested.some((item) => item.knowledgeId === approved.id));
    assert.equal(advice.usageRecorded, 0);
    assert.equal(advice.usageFailures.length, advice.suggested.length);
    assert.equal(advice.usageFailures[0].knowledgeId, approved.id);
    assert.match(String(advice.note), /usage 记录写入失败/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('WP4 P0-6：语义标签覆盖 gate-engine 全部 7 个 GATE_* 原因码', () => {
  for (const code of [
    'GATE_EVIDENCE_MISSING', 'GATE_EVIDENCE_INVALID', 'GATE_EVIDENCE_UNBOUND', 'GATE_EVIDENCE_BLOCKED',
    'GATE_UNKNOWN', 'GATE_PASSED', 'GATE_NOT_IMPLEMENTED',
  ]) {
    assert.ok(Array.isArray(GATE_REASON_TAGS[code]) && GATE_REASON_TAGS[code].length > 0, `${code} 必须有语义标签`);
  }
  assert.equal(GATE_REASON_TAGS.GATE_EVIDENCE_MISSING.includes('drc'), true);
});
