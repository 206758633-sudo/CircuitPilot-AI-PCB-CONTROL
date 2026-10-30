import { assertEvidenceEnvelope } from '../evidence-contract.mjs';

/**
 * W3-16：Agent 引用知识验证。
 * Agent 在证据里引用 knowledgeId 时，必须同时满足：条目存在、已审核通过、未过期（isUsableForGate）。
 * 任何一条不满足 → 引用无效；把 citations 附加到证据后整体仍要过统一证据契约。
 */
export const CITATION_CODES = Object.freeze({ INVALID: 'CITATION_INVALID', UNUSABLE: 'CITATION_UNUSABLE', EVIDENCE_INVALID: 'CITATION_EVIDENCE_INVALID' });

export function resolveCitations({ store, citations = [] } = {}) {
  if (!store || typeof store.get !== 'function') throw Object.assign(new Error('引用解析需要知识库 store'), { code: CITATION_CODES.INVALID });
  if (!Array.isArray(citations)) throw Object.assign(new Error('citations 必须是数组'), { code: CITATION_CODES.INVALID });
  const resolved = [];
  const invalid = [];
  for (const citation of citations) {
    const knowledgeId = String(citation?.knowledgeId ?? '').trim();
    if (!knowledgeId) { invalid.push({ citation, code: CITATION_CODES.INVALID, message: '缺少 knowledgeId' }); continue; }
    const entry = store.get(knowledgeId);
    if (!entry) { invalid.push({ knowledgeId, code: CITATION_CODES.INVALID, message: '知识条目不存在' }); continue; }
    if (!store.isUsableForGate(entry)) { invalid.push({ knowledgeId, code: CITATION_CODES.UNUSABLE, message: `条目不可用于门禁（trust=${entry.trust}，review=${entry.review?.state}，expired=${entry.expired === true}）` }); continue; }
    resolved.push({ knowledgeId, kind: entry.kind, entityKey: entry.entityKey ?? null, digest: entry.digest, trust: entry.trust, usedFor: citation.usedFor ?? null });
  }
  return { ok: invalid.length === 0, resolved, invalid };
}

/** 把已验证的知识引用附加到证据信封（不改 verdict；但引用无效时拒绝生成证据）。 */
export function attachKnowledgeCitations(envelope, { store, citations = [] } = {}) {
  const checked = resolveCitations({ store, citations });
  if (!checked.ok) throw Object.assign(new Error(`知识引用无效：${checked.invalid.map((item) => item.knowledgeId ?? '?').join(',')}`), { code: CITATION_CODES.UNUSABLE, details: checked.invalid });
  const next = { ...envelope, citations: checked.resolved };
  assertEvidenceEnvelope(next);
  return next;
}
