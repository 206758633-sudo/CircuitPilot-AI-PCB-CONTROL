import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createKnowledgeStore } from '../knowledge.mjs';
import { createRagStore } from '../rag/store.mjs';

/**
 * 平台 P1-2：RAG 索引失效判定补"语料摘要"闭环。
 *
 * 修复前的漏洞：索引只记内存 `revision`（重启归零）。重启后新进程 revision 可能恰好等于落盘值，
 * 于是"进程停机期间新增/审核的知识"永远不重建（真实 state 漏了 9 条）。现在索引落盘同时记
 * `knowledgeCorpusDigest`，启动后第一次 status/query 重算摘要，不一致就自动 rebuild 并给出 reason。
 *
 * 这些测试全部用 mkdtemp + 注入 store，不写真实 artifacts/rag 或 artifacts/state。
 */

const NOW = new Date('2026-10-26T12:00:00.000Z');

const saveApproved = (store, { ruleId, title, value }) => {
  const entry = store.save({
    kind: 'rule',
    title,
    payload: { ruleId, value },
    provenance: { source: 'test' },
    trust: 'reference',
  }).entry;
  return store.review(entry.id, { state: 'approved', reviewedBy: 'test' });
};

/** 模拟"进程停机期间离线写入"：另起一个 store 实例写盘，写完即弃（原进程内存 revision 不会变）。 */
const writeOffline = (root, count) => {
  const offline = createKnowledgeStore({ root, now: () => NOW });
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    entries.push(saveApproved(offline, { ruleId: `R-OFF-${index}`, title: `离线规则 ${index}`, value: `离线语料 ${index}` }));
  }
  return entries;
};

test('P1-2：停机期间新增 9 条 approved → 重启后 status() 靠语料摘要自动重建（reason=corpus_digest）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-rag-digest-'));
  try {
    const root = join(dir, 'knowledge');
    const indexFile = join(dir, 'rag', 'index.json');
    const storeA = createKnowledgeStore({ root, now: () => NOW });
    saveApproved(storeA, { ruleId: 'R-A', title: '初始规则', value: '初始语料' });
    const ragA = createRagStore({ knowledgeStore: storeA, indexFile, dirs: [], baseDir: dir, now: () => NOW });
    ragA.reindex();
    const digestA = storeA.corpusDigest();
    const persistedA = JSON.parse(readFileSync(indexFile, 'utf8'));
    assert.equal(persistedA.knowledgeCorpusDigest, digestA, '索引落盘必须带语料摘要');
    assert.equal(persistedA.corpusRevision, storeA.revision);

    writeOffline(root, 9);
    // 关键回归：重启后新进程 revision 从 0 起算，可能与落盘值相等（原实现就漏在这里）。
    // 把落盘 corpusRevision 对齐到新进程的 0，强制证明“只有摘要能抓住这次漏更新”。
    const patched = JSON.parse(readFileSync(indexFile, 'utf8'));
    patched.corpusRevision = 0;
    writeFileSync(indexFile, JSON.stringify(patched), 'utf8');

    const storeB = createKnowledgeStore({ root, now: () => NOW });
    assert.equal(storeB.revision, 0, '重启后内存 revision 归零');
    const digestB = storeB.corpusDigest();
    assert.notEqual(digestB, digestA, '离线条目必须改变语料摘要');

    const ragB = createRagStore({ knowledgeStore: storeB, indexFile, dirs: [], baseDir: dir, now: () => NOW });
    // status() 也要触发重建（原来只有 query 才会走 ensure 的失效逻辑）。
    const status = ragB.status();
    assert.equal(status.lastRebuildReason, 'corpus_digest', 'revision 恰好相等时也必须靠摘要判失效');
    assert.equal(status.corpus.knowledge, 10, '重建后语料必须包含离线索引期间的 9 条新知识');
    assert.equal(status.knowledgeCorpusDigest, digestB);
    assert.equal(ragB.knowledgeCorpusDigest, digestB);
    const rewritten = JSON.parse(readFileSync(indexFile, 'utf8'));
    assert.equal(rewritten.knowledgeCorpusDigest, digestB, '重建后必须把新摘要落盘');
    assert.equal(rewritten.corpusRevision, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-2：query() 同样靠摘要发现失效，返回 invalidation.reason=corpus_digest 且能检索到离线新增知识', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-rag-digest-query-'));
  try {
    const root = join(dir, 'knowledge');
    const indexFile = join(dir, 'rag', 'index.json');
    const storeA = createKnowledgeStore({ root, now: () => NOW });
    saveApproved(storeA, { ruleId: 'R-A', title: '初始规则', value: '初始语料' });
    createRagStore({ knowledgeStore: storeA, indexFile, dirs: [], baseDir: dir, now: () => NOW }).reindex();

    const offlineEntries = writeOffline(root, 9);
    const patched = JSON.parse(readFileSync(indexFile, 'utf8'));
    patched.corpusRevision = 0;
    writeFileSync(indexFile, JSON.stringify(patched), 'utf8');

    const storeB = createKnowledgeStore({ root, now: () => NOW });
    const ragB = createRagStore({ knowledgeStore: storeB, indexFile, dirs: [], baseDir: dir, now: () => NOW });
    const result = ragB.query({ query: '离线语料 3', topK: 3 });
    assert.equal(result.invalidation.rebuilt, true);
    assert.equal(result.invalidation.reason, 'corpus_digest');
    const hit = result.results.find((item) => item.meta?.knowledgeId === offlineEntries[3].id);
    assert.ok(hit, '重建后的索引必须能检索到离线新增的知识');
    assert.equal(hit.meta.review, 'approved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-2：内容未变的重启不重建（摘要稳定，避免每次启动全量重建）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-rag-digest-stable-'));
  try {
    const root = join(dir, 'knowledge');
    const indexFile = join(dir, 'rag', 'index.json');
    const storeA = createKnowledgeStore({ root, now: () => NOW });
    saveApproved(storeA, { ruleId: 'R-A', title: '初始规则', value: '初始语料' });
    createRagStore({ knowledgeStore: storeA, indexFile, dirs: [], baseDir: dir, now: () => NOW }).reindex();
    // 模拟"上一进程在 revision=0 时重建过索引"：重启后 revision 也是 0。
    const patched = JSON.parse(readFileSync(indexFile, 'utf8'));
    patched.corpusRevision = 0;
    writeFileSync(indexFile, JSON.stringify(patched), 'utf8');

    const storeB = createKnowledgeStore({ root, now: () => NOW });
    const ragB = createRagStore({ knowledgeStore: storeB, indexFile, dirs: [], baseDir: dir, now: () => NOW });
    assert.equal(storeB.corpusDigest(), storeA.corpusDigest(), '相同磁盘内容的语料摘要必须稳定');
    const status = ragB.status();
    assert.equal(status.lastRebuildReason, null, '内容未变化时不得无谓重建');
    assert.equal(status.corpus, null, '未重建时无新语料统计');
    assert.equal(status.built, true);
    assert.equal(status.chunks, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-2：同进程保存/审核仍走 revision 快速失效（原闭环不回归），invalidation.reason=corpus_revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-rag-digest-rev-'));
  try {
    const root = join(dir, 'knowledge');
    const indexFile = join(dir, 'rag', 'index.json');
    const store = createKnowledgeStore({ root, now: () => NOW });
    saveApproved(store, { ruleId: 'R-A', title: '初始规则', value: '初始语料' });
    const rag = createRagStore({ knowledgeStore: store, indexFile, dirs: [], baseDir: dir, now: () => NOW });
    rag.reindex();

    const added = saveApproved(store, { ruleId: 'R-NEW', title: '新审核规则', value: '新审核语料' });
    const result = rag.query({ query: '新审核语料', topK: 3 });
    assert.equal(result.invalidation.rebuilt, true);
    assert.equal(result.invalidation.reason, 'corpus_revision', '同进程写入优先用便宜的 revision 判定');
    assert.ok(result.results.some((item) => item.meta?.knowledgeId === added.id));
    const status = rag.status();
    assert.equal(status.knowledgeCorpusDigest, store.corpusDigest());
    assert.equal(status.corpusRevision, store.revision);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-2：索引文件损坏仍 fail-closed（status 报 RAG_INDEX_INVALID，query 懒构建后恢复）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-rag-digest-broken-'));
  try {
    const root = join(dir, 'knowledge');
    const indexFile = join(dir, 'rag', 'index.json');
    const store = createKnowledgeStore({ root, now: () => NOW });
    saveApproved(store, { ruleId: 'R-A', title: '初始规则', value: '初始语料' });
    mkdirSync(join(dir, 'rag'), { recursive: true });
    writeFileSync(indexFile, '{ this is not json', 'utf8');

    const rag = createRagStore({ knowledgeStore: store, indexFile, dirs: [], baseDir: dir, now: () => NOW });
    const status = rag.status();
    assert.equal(status.built, false);
    assert.equal(status.loadError.code, 'RAG_INDEX_INVALID', '损坏索引必须如实报错，不能伪装成空语料');
    const result = rag.query({ query: '初始规则', topK: 3 });
    assert.equal(result.invalidation.reason, 'lazy');
    assert.ok(result.results.length >= 1, '懒构建必须能从知识库恢复可用索引');
    assert.equal(rag.status().loadError, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-2：知识库文件损坏时摘要算不出来，status 不抛崩并记录 RAG_CORPUS_DIGEST_FAILED', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-rag-digest-corrupt-'));
  try {
    const root = join(dir, 'knowledge');
    const indexFile = join(dir, 'rag', 'index.json');
    const storeA = createKnowledgeStore({ root, now: () => NOW });
    saveApproved(storeA, { ruleId: 'R-A', title: '初始规则', value: '初始语料' });
    createRagStore({ knowledgeStore: storeA, indexFile, dirs: [], baseDir: dir, now: () => NOW }).reindex();
    const patched = JSON.parse(readFileSync(indexFile, 'utf8'));
    patched.corpusRevision = 0;
    writeFileSync(indexFile, JSON.stringify(patched), 'utf8');
    // 破坏一个知识条目文件，但保持索引文件本身可读。
    writeFileSync(join(root, 'rule', `${storeA.list()[0].id}.json`), '{ broken', 'utf8');
    const storeB = createKnowledgeStore({ root, now: () => NOW });
    const rag = createRagStore({ knowledgeStore: storeB, indexFile, dirs: [], baseDir: dir, now: () => NOW });
    const status = rag.status();
    assert.equal(status.loadError.code, 'RAG_CORPUS_DIGEST_FAILED', '摘要失败必须可观测，不能静默沿用旧索引');
    assert.equal(status.built, true, '旧索引仍可供只读检索（fail-closed 但不中断服务）');
    assert.equal(status.lastRebuildReason, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
