import { evaluateGate } from '../evidence-contract.mjs';
import { attachKnowledgeCitations } from './knowledge-citations.mjs';
import { assertEvidenceEnvelope } from '../evidence-contract.mjs';

/**
 * Orchestrator（W4-05）：按“规格→器件→设计→网表审计→规则→门禁”编排 agent，但**不掌握放行权**。
 * 任一 agent 抛错/超时，不伪造证据：记录失败并把门禁判为 unknown（fail-closed）。
 */
export const PIPELINE_STEPS = Object.freeze(['librarian', 'netlist-auditor', 'rule-runner']);

export function planPipeline({ requiredKinds = ['netlist-diff', 'rules'] } = {}) {
  return { steps: [...PIPELINE_STEPS], requiredKinds, note: 'librarian 可选；缺证据时门禁 unknown，不放行' };
}

export async function runDesignPipeline({ spec = null, steps = [], requiredKinds = ['netlist-diff', 'rules'], knowledgeStore = null, rag = null, now = () => new Date() } = {}) {
  if (!spec || typeof spec !== 'object') throw Object.assign(new Error('编排需要 design-spec'), { code: 'ORCHESTRATOR_INVALID' });
  const results = [];
  const envelopes = [];
  for (const step of steps) {
    const id = step?.id || 'unknown-step';
    try {
      let envelope = await step.run({ spec, now, knowledgeStore });
      // W3-20：步骤声明 ragQuery 时，用本地混合索引检索依据并附到证据里；检索不可用/失败 → 该步失败，
      // 不用“没有检索”冒充“没有依据”。
      const ragQuery = typeof step.ragQuery === 'string' ? step.ragQuery.trim() : '';
      if (ragQuery) {
        if (!rag || typeof rag.search !== 'function') throw Object.assign(new Error('步骤声明了 RAG 检索但未注入检索器'), { code: 'RAG_INVALID' });
        try {
          const retrieval = rag.search({ query: ragQuery, topK: Number(step.ragTopK) || 3 });
          envelope = {
            ...envelope,
            retrieval: {
              query: ragQuery,
              mode: retrieval.mode ?? 'hybrid',
              results: (retrieval.results ?? []).map((hit) => ({ chunkId: hit.chunkId, docId: hit.docId, title: hit.title, heading: hit.heading ?? null, kind: hit.kind ?? null, path: hit.path ?? null, knowledgeId: hit.knowledgeId ?? null, score: hit.score })),
            },
          };
          assertEvidenceEnvelope(envelope);
        } catch (error) {
          throw Object.assign(new Error(`RAG 检索失败：${String(error?.message || error)}`), { code: 'RAG_RETRIEVAL_FAILED', cause: error });
        }
      }
      // W3-16：步骤声明的知识引用必须在证据落地前逐条核验；引用无效时整份证据作废（fail-closed），
      // 不允许把未审核/过期/不存在的条目当成门禁依据。
      const citations = step.citations ?? envelope?.citations ?? [];
      if (citations.length) {
        if (!knowledgeStore || typeof knowledgeStore.get !== 'function') throw Object.assign(new Error('步骤声明了知识引用但未注入知识库'), { code: 'CITATION_INVALID' });
        envelope = attachKnowledgeCitations(envelope, { store: knowledgeStore, citations });
        if (typeof knowledgeStore.recordUsage === 'function') {
          for (const citation of envelope.citations) knowledgeStore.recordUsage({ id: citation.knowledgeId, agent: id, outcome: 'used', note: `usedFor=${citation.usedFor ?? 'unspecified'}` });
        }
      }
      envelopes.push(envelope);
      results.push({ id, ok: true, kind: envelope?.kind ?? null, digest: envelope?.digest ?? null, citations: envelope?.citations?.length ?? 0 });
    } catch (error) {
      results.push({ id, ok: false, code: error?.code || 'AGENT_FAILED', message: String(error?.message || error).slice(0, 240) });
    }
  }
  let gate;
  try {
    gate = evaluateGate({ envelopes, requiredKinds });
  } catch (error) {
    gate = { verdict: 'unknown', missing: requiredKinds, blockedBy: [], unknownBy: [{ reason: `证据契约校验失败：${String(error?.message || error).slice(0, 160)}` }] };
  }
  const failedSteps = results.filter((result) => !result.ok);
  const verdict = gate.verdict === 'pass' && failedSteps.length ? 'unknown' : (failedSteps.length && gate.verdict !== 'blocked' ? 'unknown' : gate.verdict);
  return { ok: verdict === 'pass', verdict, gate, results, failedSteps, evidence: envelopes };
}
