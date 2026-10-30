import { createHash } from 'node:crypto';
import { chunkMarkdown } from './chunk.mjs';
import { EMBED_DIMS, cosine, decodeVector, embedTokens, encodeVector } from './embed.mjs';
import { termFrequencies, tokenize } from './tokenize.mjs';

/**
 * RAG 混合索引（W3-20）：
 *   - 词法：BM25（中文 bigram + 英文 token）；
 *   - 语义：384 维特征哈希向量余弦；
 *   - 混合分：0.65 * 归一化 BM25 + 0.35 * 余弦，标题命中/知识类条目轻微加权；
 *   - 持久化：JSON + base64 向量；加载时校验维度与 schema，坏了就报錯让上层重建，不静默用空索引冒充"没检索到"。
 * 纯本地、无网络、无模型依赖；索引只是"找依据"，结论仍需证据与人工审核。
 */

// v2（2026-10-29 复审）：语料新增 review/trust/expired/gateUsable 元数据并排除过期条目；
// 旧 v1 索引 meta 为空，升级后必须失效重建，否则 UI 会把 approved 显示成“候选未审核”。
export const RAG_INDEX_VERSION = 2;
export const RAG_CODES = Object.freeze({ INVALID: 'RAG_INVALID', QUERY_EMPTY: 'RAG_QUERY_EMPTY', INDEX_INVALID: 'RAG_INDEX_INVALID' });
const BM25_K1 = 1.2;
const BM25_B = 0.75;

export function normalizeDocument(document, { defaultKind = 'doc' } = {}) {
  if (!document || typeof document !== 'object') throw Object.assign(new Error('RAG 文档必须是对象'), { code: RAG_CODES.INVALID });
  if (!document.id || typeof document.id !== 'string') throw Object.assign(new Error('RAG 文档需要 id'), { code: RAG_CODES.INVALID });
  const text = String(document.text ?? '').trim();
  if (!text) throw Object.assign(new Error(`RAG 文档 ${document.id} 文本为空`), { code: RAG_CODES.INVALID });
  return {
    id: document.id,
    title: String(document.title ?? document.id).trim(),
    text,
    path: document.path ?? null,
    kind: document.kind ?? defaultKind,
    meta: document.meta && typeof document.meta === 'object' ? document.meta : {},
    provenance: document.provenance && typeof document.provenance === 'object' ? document.provenance : null,
  };
}

export function createRagIndex({ dims = EMBED_DIMS, maxChunksPerDocument = 80 } = {}) {
  let docs = [];
  let chunks = [];
  const postings = new Map(); // term -> Map(chunkIndex -> tf)
  const df = new Map(); // term -> document frequency (chunks containing term)
  let avgLen = 1;
  let builtAt = null;
  let corpusDigest = null;

  const docByChunk = () => chunks.map((chunk) => docs[chunk.docIndex]);

  const build = ({ documents = [], now = () => new Date() } = {}) => {
    if (!Array.isArray(documents)) throw Object.assign(new Error('documents 必须是数组'), { code: RAG_CODES.INVALID });
    docs = [];
    chunks = [];
    postings.clear();
    df.clear();
    for (const raw of documents) {
      const document = normalizeDocument(raw);
      const docIndex = docs.length;
      docs.push({ ...document, index: docIndex });
      const parts = chunkMarkdown(document.text).slice(0, maxChunksPerDocument);
      const source = parts.length ? parts : [{ heading: document.title, text: document.text.slice(0, 2000), index: 0, chars: Math.min(document.text.length, 2000) }];
      for (const part of source) {
        const chunkTokens = tokenize(`${document.title}\n${part.heading}\n${part.text}`);
        if (!chunkTokens.length) continue;
        const chunkIndex = chunks.length;
        chunks.push({
          id: `${document.id}#${part.index}`,
          docIndex,
          heading: part.heading || document.title,
          text: part.text,
          chars: part.text.length,
          tokenCount: chunkTokens.length,
          vector: embedTokens(chunkTokens, { dims }),
        });
        const frequencies = termFrequencies(chunkTokens);
        for (const [term, tf] of frequencies) {
          if (!postings.has(term)) postings.set(term, new Map());
          postings.get(term).set(chunkIndex, tf);
          df.set(term, (df.get(term) ?? 0) + 1);
        }
      }
    }
    const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
    avgLen = chunks.length ? totalTokens / chunks.length : 1;
    builtAt = now().toISOString();
    corpusDigest = digestCorpus();
    return { docs: docs.length, chunks: chunks.length, terms: postings.size, builtAt, corpusDigest };
  };

  const digestCorpus = () => {
    const hash = createHash('sha256');
    for (const doc of docs) hash.update(`${doc.id}\u0000${doc.title}\u0000${doc.text}\u0000`);
    return hash.digest('hex');
  };

  const search = ({ query, topK = 8, kinds = null, minScore = 0 } = {}) => {
    const queryText = String(query ?? '').trim();
    if (!queryText) throw Object.assign(new Error('检索 query 不能为空'), { code: RAG_CODES.QUERY_EMPTY });
    const queryTokens = tokenize(queryText);
    const limit = Math.max(1, Math.min(50, Number(topK) || 8));
    if (!queryTokens.length) return { query: queryText, results: [], total: 0, mode: 'hybrid' };
    const queryVector = embedTokens(queryTokens, { dims });
    const scores = new Map();
    const add = (chunkIndex, field, value) => {
      const current = scores.get(chunkIndex) ?? { bm25: 0, cosine: 0 };
      current[field] += value;
      scores.set(chunkIndex, current);
    };
    for (const term of new Set(queryTokens)) {
      const posting = postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (chunks.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      for (const [chunkIndex, tf] of posting) {
        const chunk = chunks[chunkIndex];
        add(chunkIndex, 'bm25', idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (chunk.tokenCount / avgLen)))));
      }
    }
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) add(chunkIndex, 'cosine', cosine(queryVector, chunks[chunkIndex].vector));
    let maxBm25 = 0;
    for (const value of scores.values()) maxBm25 = Math.max(maxBm25, value.bm25);
    const results = [];
    for (const [chunkIndex, value] of scores) {
      const chunk = chunks[chunkIndex];
      const document = docs[chunk.docIndex];
      if (kinds && !kinds.includes(document.kind)) continue;
      const bm25Norm = maxBm25 > 0 ? value.bm25 / maxBm25 : 0;
      const cos = Math.max(0, value.cosine);
      let score = 0.65 * bm25Norm + 0.35 * cos;
      const titleText = `${document.title} ${chunk.heading}`.toLowerCase();
      let titleOverlap = 0;
      for (const token of new Set(queryTokens)) if (titleText.includes(token)) titleOverlap += 1;
      if (titleOverlap) score += Math.min(0.1, 0.025 * titleOverlap);
      if (document.kind === 'knowledge') score += 0.02;
      // 知识库文档优先于实现记录/案例过程文档，避免 RAG 把“实施日志”当成工程知识答案。
      if (String(document.path ?? '').startsWith('docs/knowledge/')) score += 0.05;
      if (score < minScore) continue;
      results.push({
        chunkId: chunk.id,
        docId: document.id,
        title: document.title,
        heading: chunk.heading,
        kind: document.kind,
        path: document.path,
        knowledgeId: document.meta?.knowledgeId ?? null,
        text: chunk.text.slice(0, 1200),
        score: Number(score.toFixed(6)),
        bm25: Number(value.bm25.toFixed(4)),
        cosine: Number(cos.toFixed(4)),
        provenance: document.provenance,
        meta: document.meta ?? {},
      });
    }
    results.sort((left, right) => right.score - left.score);
    return { query: queryText, results: results.slice(0, limit), total: results.length, mode: 'hybrid' };
  };

  const stats = () => ({ docs: docs.length, chunks: chunks.length, terms: postings.size, dims, builtAt, corpusDigest });

  const toJSON = () => ({
    schemaVersion: RAG_INDEX_VERSION,
    dims,
    builtAt,
    corpusDigest,
    docs,
    chunks: chunks.map((chunk) => ({ ...chunk, vector: encodeVector(chunk.vector) })),
    postings: [...postings.entries()].map(([term, map]) => [term, [...map.entries()]]),
    df: [...df.entries()],
  });

  const fromJSON = (payload) => {
    if (!payload || typeof payload !== 'object' || payload.schemaVersion !== RAG_INDEX_VERSION) throw Object.assign(new Error('RAG 索引 schemaVersion 不符'), { code: RAG_CODES.INDEX_INVALID });
    if (Number(payload.dims) !== dims) throw Object.assign(new Error(`RAG 索引维度不符：${payload.dims} ≠ ${dims}`), { code: RAG_CODES.INDEX_INVALID });
    try {
      docs = (payload.docs ?? []).map((doc) => ({ ...doc }));
      chunks = (payload.chunks ?? []).map((chunk) => ({ ...chunk, vector: decodeVector(chunk.vector, dims) }));
      postings.clear();
      df.clear();
      for (const [term, entries] of payload.postings ?? []) postings.set(term, new Map(entries));
      for (const [term, value] of payload.df ?? []) df.set(term, value);
      builtAt = typeof payload.builtAt === 'string' ? payload.builtAt : null;
      corpusDigest = typeof payload.corpusDigest === 'string' ? payload.corpusDigest : null;
      const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
      avgLen = chunks.length ? totalTokens / chunks.length : 1;
    } catch (error) {
      throw Object.assign(new Error(`RAG 索引解析失败：${String(error?.message || error)}`), { code: RAG_CODES.INDEX_INVALID });
    }
    return stats();
  };

  const empty = () => ({ docs: 0, chunks: 0, terms: 0, dims, builtAt: null, corpusDigest: null });

  return { build, search, stats, toJSON, fromJSON, empty, get builtAt() { return builtAt; }, get corpusDigest() { return corpusDigest; } };
}
