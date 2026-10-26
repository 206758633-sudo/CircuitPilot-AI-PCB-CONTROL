import { KNOWLEDGE_KINDS, KNOWLEDGE_TRUST_LEVELS } from './knowledge.mjs';

/**
 * 知识库 HTTP 边界（W3-03 的纯函数层）：server.mjs 的路由只是薄壳，校验/准入都在这里。
 *
 * 两条硬规矩：
 *   1. 通过 API 新建的条目**只能是 candidate**——AI/采集器只能“提候选”，权威级必须走 review；
 *   2. review 必须带 `reviewedBy`，且只允许 approved/rejected；没有审核人 → 拒绝。
 */

export const KNOWLEDGE_API_CODES = Object.freeze({
  INVALID: 'KNOWLEDGE_API_INVALID',
  REVIEWER_REQUIRED: 'KNOWLEDGE_API_REVIEWER_REQUIRED',
  REVIEW_STATE_INVALID: 'KNOWLEDGE_API_REVIEW_STATE_INVALID',
  ENTRY_NOT_FOUND: 'KNOWLEDGE_API_ENTRY_NOT_FOUND',
});

const invalid = (message, details = null) => Object.assign(new Error(message), { code: KNOWLEDGE_API_CODES.INVALID, details });
const coded = (code, message, details = null) => Object.assign(new Error(message), { code, details });

export function createKnowledgeApi({ store, maxEntries = 200 } = {}) {
  if (!store || typeof store.save !== 'function' || typeof store.query !== 'function') throw invalid('需要注入 knowledge store');

  const list = ({ kind = null, trust = null, reviewState = null, includeExpired = false, entityKey = null, text = null } = {}) => {
    if (kind !== null && !KNOWLEDGE_KINDS.includes(kind)) throw invalid(`未知知识类型：${kind}`);
    if (trust !== null && !KNOWLEDGE_TRUST_LEVELS.includes(trust)) throw invalid(`未知可信等级：${trust}`);
    // store 层把 null 视为非法值；API 层允许“不传”，这里只把非空过滤条件传下去。
    const filters = {};
    if (kind) filters.kind = kind;
    if (trust) filters.trust = trust;
    if (reviewState) filters.reviewState = reviewState;
    let entries;
    if (text || entityKey) {
      const queryFilters = { ...filters };
      if (text) queryFilters.text = text;
      if (entityKey) queryFilters.entityKey = entityKey;
      entries = store.query(queryFilters);
    } else {
      entries = store.list({ ...filters, includeExpired });
    }
    const limited = entries.slice(0, Math.max(1, Math.min(1000, Number(maxEntries) || 200)));
    return {
      total: entries.length,
      returned: limited.length,
      entries: limited,
      gateUsable: limited.filter((entry) => store.isUsableForGate(entry)).length,
      expired: limited.filter((entry) => entry.expired === true).length,
    };
  };

  const save = ({ kind, title, payload, provenance, trust = 'unverified', ttlDays = null } = {}) => {
    if (!KNOWLEDGE_KINDS.includes(kind)) throw invalid(`未知知识类型：${kind}`);
    if (!KNOWLEDGE_TRUST_LEVELS.includes(trust)) throw invalid(`未知可信等级：${trust}`);
    if (!title || !String(title).trim()) throw invalid('title 不能为空');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('payload 必须是对象');
    if (!provenance || typeof provenance !== 'object' || !provenance.source) throw invalid('provenance.source 必填');
    if (trust === 'authoritative') throw coded(KNOWLEDGE_API_CODES.REVIEWER_REQUIRED, '权威级条目不能直接写入：请先以 reference/unverified 提交，再走 review 审核');
    // 关键：API 写入永远是候选，防止“采集器/前端直接把自己标成 approved”。
    const saved = store.save({ kind, title, payload, provenance, trust, ttlDays, reviewState: 'candidate' });
    return { entry: saved.entry, created: saved.created };
  };

  const review = ({ id, state, reviewedBy } = {}) => {
    if (!['approved', 'rejected'].includes(state)) throw coded(KNOWLEDGE_API_CODES.REVIEW_STATE_INVALID, '审核状态只能是 approved 或 rejected');
    if (!reviewedBy || !String(reviewedBy).trim()) throw coded(KNOWLEDGE_API_CODES.REVIEWER_REQUIRED, '审核必须提供 reviewedBy（审核人）');
    const entry = store.get(id);
    if (!entry) throw coded(KNOWLEDGE_API_CODES.ENTRY_NOT_FOUND, `知识条目不存在：${id}`);
    return { entry: store.review(id, { state, reviewedBy: String(reviewedBy).trim() }) };
  };

  const conflicts = ({ entityKey } = {}) => {
    if (!entityKey || !String(entityKey).trim()) throw invalid('conflicts 需要 entityKey');
    return store.detectConflicts({ entityKey: String(entityKey).trim() });
  };

  const usage = ({ id } = {}) => {
    if (!id || !String(id).trim()) throw invalid('usage 需要条目 id');
    return { usages: store.listUsages({ id: String(id).trim() }) };
  };

  const recordUsage = ({ id, agent, outcome = 'used', note = null } = {}) => {
    if (!id || !String(id).trim()) throw invalid('recordUsage 需要条目 id');
    if (!agent || !String(agent).trim()) throw invalid('recordUsage 需要 agent');
    if (!['used', 'overturned'].includes(outcome)) throw invalid('outcome 只能是 used 或 overturned');
    return store.recordUsage({ id: String(id).trim(), agent: String(agent).trim(), outcome, note });
  };

  return { list, save, review, conflicts, usage, recordUsage };
}
