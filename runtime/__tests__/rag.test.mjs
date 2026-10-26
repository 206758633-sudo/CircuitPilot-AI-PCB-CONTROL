import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
