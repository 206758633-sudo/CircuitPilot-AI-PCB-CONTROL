/**
 * P0-9 / WP4 P0-6：知识库 → 门禁建议（第一个真实消费者）。
 *
 * 修复前 `isUsableForGate` 只被知识库列表的计数使用，approved 与否对产品行为零影响。
 * 复审计又发现：真实语料里没有任何条目包含 `GATE_*` 原因码，按 code 纯文本检索恒为空，
 * 审核通过 → 建议面板仍然永远是“暂无可用知识”。这里改为：
 *   - 每个门禁原因码映射到语义标签（`GATE_EVIDENCE_MISSING → drc/erc/evidence/report/...`）；
 *   - 先按原因码、再按标签/entityKey 检索知识库；标签覆盖 gate-engine 全部 `GATE_*`；
 *   - 只有 `store.isUsableForGate(entry)` 为 true 的条目进入 `suggested`（trust 非 unverified、
 *     review=approved、未过期）；主题匹配但未审核的单独进 `candidates`，并明确“需审核后才可作为依据”；
 *   - 每条被采用的知识都写 usage（agent / outcome=used / 对应门与原因码），写失败不再静默吞掉，
 *     记入 `usageFailures` 并在返回值里给出 `usageRecorded` 数量。
 *
 * 注意：这里只产"建议/依据"，不改变门禁裁决；门禁通过仍只由证据决定。
 */

export const GATE_ADVICE_CODES = Object.freeze({
  INVALID: 'GATE_ADVICE_INVALID',
});

/**
 * 门禁原因码 → 检索标签（覆盖 `runtime/gate-engine.mjs` 的全部 GATE_*）。
 * 真实知识条目的 payload 通常写 rule/drc/erc/process 等主题词，而不是内部原因码，
 * 所以必须用语义标签检索，否则“审核通过”对产品行为没有任何影响（P0-C）。
 */
export const GATE_REASON_TAGS = Object.freeze({
  GATE_EVIDENCE_MISSING: ['drc', 'erc', 'evidence', 'report', 'missing', '证据', '规则'],
  GATE_EVIDENCE_INVALID: ['drc', 'erc', 'invalid', 'report', 'stale', '无效', '过期'],
  GATE_EVIDENCE_UNBOUND: ['binding', 'document', 'uuid', 'evidence', '绑定', '文档'],
  GATE_EVIDENCE_BLOCKED: ['drc', 'erc', 'blocking', 'violation', 'blocked', '违规', '阻塞'],
  GATE_UNKNOWN: ['readiness', 'verification', 'unknown', '未验证', '未知'],
  GATE_PASSED: ['readiness', 'verification', 'passed', '通过'],
  GATE_NOT_IMPLEMENTED: ['manual', 'checklist', 'process', '人工', '清单', '流程'],
});

const coded = (code, message, details = null) => Object.assign(new Error(message), { code, details });

const excerptOf = (entry) => {
  try {
    const payload = entry?.payload && typeof entry.payload === 'object' ? entry.payload : {};
    const text = Object.values(payload).filter((value) => typeof value === 'string').join(' · ');
    return (text || entry?.title || '').slice(0, 200);
  } catch { return ''; }
};

const candidateReasonOf = (entry) => {
  if (entry?.expired === true) return 'expired';
  if (entry?.review?.state !== 'approved') return 'unreviewed';
  if (entry?.trust === 'unverified') return 'unverified';
  return 'unusable';
};

/**
 * @param {{ store: object, report: object, agent?: string, limit?: number, record?: boolean }} options
 */
export function buildGateKnowledgeAdvice({ store, report, agent = 'gate-engine', limit = 8, record = true } = {}) {
  if (!store || typeof store.query !== 'function' || typeof store.isUsableForGate !== 'function') {
    throw coded(GATE_ADVICE_CODES.INVALID, '门禁知识建议需要注入 knowledge store');
  }
  if (!report || !Array.isArray(report.gates)) throw coded(GATE_ADVICE_CODES.INVALID, '门禁知识建议需要门禁报告');
  const maxLimit = Math.max(1, Math.min(20, Number(limit) || 8));
  // 多个门同时缺证据时，不能让第一个门把建议名额吃光：按门数均分（至少 1 条/门）。
  const gateCount = Math.max(1, Array.isArray(report.gates) ? report.gates.length : 1);
  const perGateLimit = Math.max(1, Math.floor(maxLimit / gateCount));
  const suggested = [];
  const candidates = [];
  const considered = [];
  const usageFailures = [];
  const seenSuggested = new Set();
  const seenCandidates = new Set();
  let unusableSkipped = 0;
  let usageRecorded = 0;

  const collect = (code, gate) => {
    const tags = GATE_REASON_TAGS[code] || [];
    const queries = [code, ...tags];
    const entries = [];
    for (const text of queries) {
      let found = [];
      try { found = store.query({ text }); } catch { found = []; }
      for (const entry of found) {
        if (!entry?.id || entries.some((item) => item.id === entry.id)) continue;
        entries.push(entry);
      }
    }
    let gateSuggested = 0;
    for (const entry of entries) {
      if (suggested.length < maxLimit && gateSuggested < perGateLimit && !seenSuggested.has(entry.id) && store.isUsableForGate(entry)) {
        const advice = {
          knowledgeId: entry.id,
          title: entry.title ?? entry.id,
          kind: entry.kind ?? null,
          trust: entry.trust ?? null,
          review: entry.review?.state ?? 'candidate',
          entityKey: entry.entityKey ?? null,
          gateId: gate.id,
          gateName: gate.name ?? null,
          reasonCode: code,
          matchedTags: tags,
          excerpt: excerptOf(entry),
          citation: `knowledge:${entry.id}`,
        };
        if (record) {
          try {
            store.recordUsage({ id: entry.id, agent, outcome: 'used', note: `门禁建议：${gate.id}/${code}` });
            usageRecorded += 1;
          } catch (error) {
            // 不静默吞掉：建议仍然有效（只是不可追溯），但失败必须在返回值里可见。
            usageFailures.push({ knowledgeId: entry.id, gateId: gate.id, reasonCode: code, message: String(error?.message || error).slice(0, 240) });
          }
        }
        seenSuggested.add(entry.id);
        gateSuggested += 1;
        suggested.push(advice);
      } else if (seenSuggested.has(entry.id)) {
        continue;
      } else if (!store.isUsableForGate(entry)) {
        unusableSkipped += 1;
        // 主题匹配但未审核/未核验：只在 candidate 列表里给出，并注明不可作为依据。
        // 已过期条目既不进建议也不进候选（它不是“待审核”，而是已经失效）。
        const reasonOfCandidate = candidateReasonOf(entry);
        if (reasonOfCandidate !== 'expired' && !seenCandidates.has(entry.id)) {
          seenCandidates.add(entry.id);
          candidates.push({
            knowledgeId: entry.id,
            title: entry.title ?? entry.id,
            kind: entry.kind ?? null,
            trust: entry.trust ?? null,
            review: entry.review?.state ?? 'candidate',
            entityKey: entry.entityKey ?? null,
            reason: reasonOfCandidate,
            reasonCode: code,
            gateId: gate.id,
            note: '需人工审核并标记 approved（且 trust 非 unverified）后才可作为门禁依据',
            citation: `knowledge:${entry.id}`,
          });
        }
      }
    }
  };

  for (const gate of report.gates) {
    if (suggested.length >= maxLimit) break;
    for (const reason of Array.isArray(gate.reasons) ? gate.reasons : []) {
      const severity = reason?.severity;
      if (!['blocking', 'unknown'].includes(severity)) continue;
      const code = typeof reason.code === 'string' ? reason.code : null;
      if (!code) continue;
      considered.push({ gateId: gate.id, code, tags: GATE_REASON_TAGS[code] || [] });
      collect(code, gate);
      if (suggested.length >= maxLimit) break;
    }
  }

  const noteParts = [];
  if (!suggested.length) {
    noteParts.push('没有 approved + 未过期的相关知识；未审核/未核验条目不会进入门禁建议');
  }
  if (candidates.length) {
    noteParts.push(`发现 ${candidates.length} 条同主题但未审核/未核验的知识，需审核后才可作为依据`);
  }
  if (usageFailures.length) {
    noteParts.push(`${usageFailures.length} 条 usage 记录写入失败（建议仍返回，但不可追溯）`);
  }
  return {
    suggested,
    candidates,
    considered,
    used: suggested.length,
    unusableSkipped,
    usageRecorded,
    usageSkipped: record !== true,
    usageFailures,
    note: noteParts.length ? noteParts.join('；') : null,
  };
}
