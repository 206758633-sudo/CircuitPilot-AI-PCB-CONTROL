import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenize } from '../rag/tokenize.mjs';
import { chunkMarkdown } from '../rag/chunk.mjs';
import { cosine, decodeVector, embedTokens, encodeVector } from '../rag/embed.mjs';
import { createRagIndex } from '../rag/index.mjs';
import { buildCorpus, knowledgeDocumentsFromStore } from '../rag/corpus.mjs';
import { createRagStore } from '../rag/store.mjs';
import { createKnowledgeStore } from '../knowledge.mjs';

test('tokenize：英文词 + 中文单字/二元组，停用词被过滤', () => {
  const tokens = tokenize('PCB DRC 间距 0.2mm，the and 的');
  assert.ok(tokens.includes('pcb'));
  assert.ok(tokens.includes('drc'));
  assert.ok(tokens.includes('间距'));
  assert.ok(tokens.includes('间') && tokens.includes('距'));
  assert.ok(tokens.includes('0.2mm'));
  assert.ok(!tokens.includes('the'));
  assert.ok(!tokens.includes('的'));
});

test('chunkMarkdown：保留标题路径、块大小受限、有重叠', () => {
  const text = '# 规则\n\n## DRC\n\n' + '间距 0.2mm 线宽 0.25mm。'.repeat(40) + '\n\n## ERC\n\n' + '悬空引脚必须处理。'.repeat(20);
  const chunks = chunkMarkdown(text, { maxChars: 300, minChars: 30, overlapChars: 40 });
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.some((chunk) => chunk.heading.includes('DRC')));
  assert.ok(chunks.every((chunk) => chunk.chars <= 300 + 40 + 1));
  assert.ok(chunks.slice(1).some((chunk) => chunk.text.length > 0));
});

test('embed：确定性、归一化、相似文本余弦更高', () => {
  const a = embedTokens(tokenize('PCB 阻抗控制 走线 50 欧姆'));
  const b = embedTokens(tokenize('PCB 阻抗控制 走线 50 欧姆'));
  const c = embedTokens(tokenize('焊接缺陷 立碑 原因'));
  assert.deepEqual([...a], [...b]);
  assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-5);
  assert.ok(cosine(a, b) > cosine(a, c));
  assert.deepEqual([...decodeVector(encodeVector(a))], [...a]);
});

test('RAG 索引：中文查询命中正确文档，过滤与持久化往返可用', () => {
  const index = createRagIndex();
  index.build({ documents: [
    { id: 'd1', title: 'DRC 规则', kind: 'doc', text: '# DRC\n\n设计规则检查：间距 0.2mm，线宽 0.25mm，阻焊桥最小 0.1mm。' },
    { id: 'd2', title: '阻抗控制', kind: 'doc', text: '# 阻抗\n\n50 欧姆阻抗控制需要计算走线宽度与叠层介质厚度。' },
    { id: 'kn:1', title: 'WS2812B 封装', kind: 'knowledge', text: '料号 C114586，封装 5050，3D 与焊盘需核验。', meta: { knowledgeId: 'kn-1' } },
  ] });
  const hit = index.search({ query: '阻抗 走线 宽度', topK: 2 });
  assert.equal(hit.results[0].docId, 'd2');
  assert.ok(hit.results[0].score > 0);
  const filtered = index.search({ query: 'DRC', kinds: ['knowledge'] });
  assert.ok(filtered.results.every((result) => result.kind === 'knowledge'));
  const restored = createRagIndex();
  restored.fromJSON(JSON.parse(JSON.stringify(index.toJSON())));
  const again = restored.search({ query: '阻抗 走线 宽度', topK: 1 });
  assert.equal(again.results[0].docId, 'd2');
  assert.throws(() => index.search({ query: '   ' }), /不能为空/);
});

test('RAG store：知识库条目入语料，首次检索自动建索引，reindex 幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-'));
  try {
    const knowledge = createKnowledgeStore({ root: join(dir, 'knowledge') });
    knowledge.save({ kind: 'rule', title: 'ERC 悬空引脚规则', payload: { ruleId: 'ERC_PIN_FLOATING', value: '悬空引脚必须加 no-connect 或上拉' }, provenance: { source: 'test' }, trust: 'reference' });
    const rag = createRagStore({ knowledgeStore: knowledge, indexFile: join(dir, 'rag', 'index.json'), baseDir: dir });
    assert.equal(rag.status().built, false);
    const result = rag.query({ query: '悬空引脚 怎么处理', topK: 3 });
    assert.ok(result.results.length >= 1);
    assert.equal(result.results[0].kind, 'knowledge');
    assert.equal(result.results[0].knowledgeId.startsWith('kn-'), true);
    assert.equal(rag.status().built, true);
    const rebuilt = rag.reindex();
    assert.ok(rebuilt.chunks >= 1);
    assert.equal(rag.status().file.endsWith('index.json'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('RAG corpus：Markdown 目录上限/跳过非 md，知识条目文本包含 payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ragc-'));
  try {
    const knowledge = createKnowledgeStore({ root: join(dir, 'knowledge') });
    knowledge.save({ kind: 'module', title: '电源模块', payload: { moduleId: 'PWR-1', value: '5V 转 3.3V LDO' }, provenance: { source: 'test' }, trust: 'reference' });
    const docs = knowledgeDocumentsFromStore(knowledge);
    assert.equal(docs.length, 1);
    assert.ok(docs[0].text.includes('5V 转 3.3V'));
    const corpus = buildCorpus({ store: knowledge, dirs: [], baseDir: dir });
    assert.equal(corpus.stats.knowledge, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('复审 P1-1：旧版本索引文件（schemaVersion=1）在查询前自动失效重建，不再沿用无审核元数据的旧语料', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-rag-version-'));
  try {
    const knowledge = createKnowledgeStore({ root: join(dir, 'knowledge') });
    const indexFile = join(dir, 'rag', 'index.json');
    // 手工放一份 v1 旧索引（真实安装版 2026-10-22 构建的形态）。
    mkdirSync(join(dir, 'rag'), { recursive: true });
    writeFileSync(indexFile, JSON.stringify({ schemaVersion: 1, dims: 256, docs: [], chunks: [], postings: [], df: [] }), 'utf8');
    const rag = createRagStore({ knowledgeStore: knowledge, indexFile, baseDir: dir });
    rag.query({ query: 'PCB 工艺' });
    const rebuilt = JSON.parse(readFileSync(indexFile, 'utf8'));
    assert.notEqual(rebuilt.schemaVersion, 1, 'v1 索引必须被判定失效并重建');
    assert.ok(Array.isArray(rebuilt.docs), '重建后的索引必须真正落盘（不是空转）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WP4 P1-9：保存/审核知识后不手动 reindex，检索自动失效重建且 meta 随审核更新', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-rag-revision-'));
  try {
    const knowledge = createKnowledgeStore({ root: join(dir, 'knowledge') });
    const indexFile = join(dir, 'rag', 'index.json');
    const rag = createRagStore({ knowledgeStore: knowledge, indexFile, dirs: [], baseDir: dir });
    // 先有一条已审核知识并完成一次真实构建（索引里有内容，才能区分“修订号失效”与“空索引懒构建”）。
    const first = knowledge.save({
      kind: 'rule', title: '去耦电容摆放规则', trust: 'reference',
      payload: { ruleId: 'DECOUPLING', value: '靠近电源引脚' }, provenance: { source: 'test' },
    }).entry;
    knowledge.review(first.id, { state: 'approved', reviewedBy: 'lead' });
    const before = rag.query({ query: '去耦电容' });
    assert.ok(before.results.length >= 1, '首次检索应命中刚审核的规则');
    const statusBefore = rag.status();
    assert.ok(statusBefore.chunks > 0);
    assert.equal(statusBefore.corpusRevision, knowledge.revision, '索引必须记录构建时的知识库修订号');

    // 再保存并审核一条新知识：不调用 reindex，下一次检索必须自动重建并命中。
    const second = knowledge.save({
      kind: 'rule', title: '镀锡厚度规则', trust: 'reference',
      payload: { ruleId: 'TIN_THICKNESS', value: '喷锡厚度按工艺卡执行' }, provenance: { source: 'test' },
    }).entry;
    knowledge.review(second.id, { state: 'approved', reviewedBy: 'lead' });
    assert.ok(knowledge.revision > statusBefore.corpusRevision, '保存/审核必须递增 revision');

    const after = rag.query({ query: '镀锡厚度' });
    assert.ok(after.results.some((hit) => hit.meta?.knowledgeId === second.id), '新审核的知识无需手动 reindex 就能检索到');
    const hit = after.results.find((item) => item.meta?.knowledgeId === second.id);
    assert.equal(hit.meta.review, 'approved', 'meta 必须随审核状态更新');
    assert.equal(hit.meta.trust, 'reference');
    assert.equal(hit.meta.gateUsable, true);
    const statusAfter = rag.status();
    assert.equal(statusAfter.corpusRevision, knowledge.revision);
    assert.ok(statusAfter.corpusRevision > statusBefore.corpusRevision);
    // 重建必须落盘（带上 corpusRevision），否则重启后无法判断索引是否过期。
    const payload = JSON.parse(readFileSync(indexFile, 'utf8'));
    assert.equal(payload.corpusRevision, knowledge.revision);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WP4 P1-9：v2 索引缺少 corpusRevision（旧构建）→ 首次 status/query 自动重建一次', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-rag-norev-'));
  try {
    const knowledge = createKnowledgeStore({ root: join(dir, 'knowledge') });
    const entry = knowledge.save({
      kind: 'rule', title: '回流焊温度曲线', trust: 'reference',
      payload: { ruleId: 'REFLOW', value: '峰值温度按器件规格' }, provenance: { source: 'test' },
    }).entry;
    knowledge.review(entry.id, { state: 'approved', reviewedBy: 'lead' });
    const indexFile = join(dir, 'rag', 'index.json');
    const warm = createRagStore({ knowledgeStore: knowledge, indexFile, dirs: [], baseDir: dir, now: () => new Date('2026-10-26T12:00:00.000Z') });
    warm.reindex();
    // 模拟“这次修复之前构建的 v2 索引”：schema 对，但没有 corpusRevision 字段。
    const payload = JSON.parse(readFileSync(indexFile, 'utf8'));
    delete payload.corpusRevision;
    writeFileSync(indexFile, JSON.stringify(payload), 'utf8');

    const rag = createRagStore({ knowledgeStore: knowledge, indexFile, dirs: [], baseDir: dir });
    const status = rag.status();
    assert.equal(status.chunks > 0, true);
    assert.equal(rag.corpusRevision, knowledge.revision, '缺少修订号的旧索引必须自动重建并补上 corpusRevision');
    const rewritten = JSON.parse(readFileSync(indexFile, 'utf8'));
    assert.equal(rewritten.corpusRevision, knowledge.revision);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
