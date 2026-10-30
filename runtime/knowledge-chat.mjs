/**
 * WP4 P1-10：知识库进对话（只引用 approved + 未过期条目）。
 *
 * 复审发现：`runtime/chat.mjs` 对 knowledge/RAG 零引用，approved 知识只影响门禁建议面板，
 * 对话/Agent 完全不用它（“审核通过无消费者”）。这里提供**只读**的上下文构建器：
 *   - 从 RAG 命中里只取 `kind=knowledge` 且能回查知识库的条目；
 *   - 回查后仍要求 `isUsableForGate(entry)` 为 true（approved + trust 非 unverified + 未过期）；
 *   - citations 只列真实条目（id/title/trust/review），不伪造引用；
 *   - 没有可用条目 → contexts 为空 + note 明确说明，不把候选/过期内容当依据塞进对话。
 */
export const KNOWLEDGE_CHAT_CODES = Object.freeze({
  INVALID: 'KNOWLEDGE_CHAT_INVALID',
});

const coded = (message, details = null) => Object.assign(new Error(message), { code: KNOWLEDGE_CHAT_CODES.INVALID, details });

const excerptOf = (entry) => {
  try {
    const payload = entry?.payload && typeof entry.payload === 'object' ? entry.payload : {};
    const text = Object.values(payload).filter((value) => typeof value === 'string').join(' · ');
    return (text || entry?.title || '').slice(0, 400);
  } catch { return ''; }
};

const clampTopK = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(10, Math.floor(n)));
};

const skipReasonOf = (entry) => {
  if (!entry) return 'not_found';
  if (entry.review?.state !== 'approved') return 'unreviewed';
  if (entry.trust === 'unverified') return 'unverified';
  if (entry.expired === true) return 'expired';
  return 'unusable';
};

/**
 * @param {object} options
 * @param {object} options.ragStore 需要 query({query, topK}) 方法
 * @param {object} options.knowledgeStore 需要 get(id) 与 isUsableForGate(entry)
 * @param {string} options.query 用户问题
 * @param {number} [options.topK=3] 最多返回多少条依据
 * @returns {{query: string, contexts: object[], citations: object[], skipped: object[], note: string|null}}
 */
export function buildKnowledgeChatContext({ ragStore, knowledgeStore, query, topK = 3 } = {}) {
  if (!ragStore || typeof ragStore.query !== 'function') throw coded('对话知识上下文需要注入 ragStore（含 query 方法）');
  if (!knowledgeStore || typeof knowledgeStore.get !== 'function' || typeof knowledgeStore.isUsableForGate !== 'function') {
    throw coded('对话知识上下文需要注入 knowledgeStore（含 get/isUsableForGate）');
  }
  if (typeof query !== 'string' || !query.trim()) throw coded('对话知识上下文需要非空 query');
  const limit = clampTopK(topK);

  let hits = [];
  try {
    const result = ragStore.query({ query: query.trim(), topK: Math.max(limit * 4, 8) });
    hits = Array.isArray(result?.results) ? result.results : [];
  } catch (error) {
    // RAG 不可用不能让对话崩：返回空上下文并说明原因，而不是编造引用。
    return {
      query: query.trim(),
      contexts: [],
      citations: [],
      skipped: [],
      note: `知识检索不可用（${String(error?.message || error).slice(0, 120)}）：本轮对话不引用知识库`,
    };
  }

  const contexts = [];
  const citations = [];
  const skipped = [];
  const seen = new Set();
  for (const hit of hits) {
    const knowledgeId = hit?.meta?.knowledgeId ?? hit?.knowledgeId ?? null;
    if (!knowledgeId || seen.has(knowledgeId)) continue;
    seen.add(knowledgeId);
    let entry = null;
    try { entry = knowledgeStore.get(knowledgeId); } catch { entry = null; }
    if (!entry) { skipped.push({ knowledgeId, reason: 'not_found' }); continue; }
    if (!knowledgeStore.isUsableForGate(entry)) {
      skipped.push({ knowledgeId, reason: skipReasonOf(entry) });
      continue;
    }
    const context = {
      knowledgeId,
      title: entry.title ?? knowledgeId,
      kind: entry.kind ?? null,
      trust: entry.trust ?? null,
      review: entry.review?.state ?? 'approved',
      entityKey: entry.entityKey ?? null,
      excerpt: excerptOf(entry),
      score: Number.isFinite(hit?.score) ? hit.score : null,
      citation: `knowledge:${knowledgeId}`,
    };
    contexts.push(context);
    citations.push({ id: knowledgeId, title: context.title, trust: context.trust, review: context.review, citation: context.citation });
    if (contexts.length >= limit) break;
  }

  const noteParts = [];
  if (!contexts.length) noteParts.push('没有 approved + 未过期的相关知识可引用；候选/未核验/过期内容不会进入对话依据');
  if (skipped.length) noteParts.push(`已过滤 ${skipped.length} 条不可用命中（未审核/未核验/过期/非知识文档），未作为对话依据`);
  return {
    query: query.trim(),
    contexts,
    citations,
    skipped,
    note: noteParts.length ? noteParts.join('；') : null,
  };
}
