import { assertEvidenceEnvelope } from '../evidence-contract.mjs';

/**
 * Agent 共性契约（W4-06）：四个 verifier agent 共用的外壳。
 *
 * 三条硬约束：
 *   1. **只读**：agent 不得写 EDA/设计（readOnly 必须为 true），否则拒绝执行；
 *   2. **不伪造/不自证**：抛出错误 → 结构化失败，不产出“通过”证据；产出证据必须过统一契约；
 *   3. **超时隔离**：agent 超时 → TIMEOUT，由 Orchestrator/门禁按 unknown 处理。
 */
export const AGENT_CONTRACT_CODES = Object.freeze({
  INVALID: 'AGENT_CONTRACT_INVALID',
  NOT_READONLY: 'AGENT_NOT_READONLY',
  TIMEOUT: 'AGENT_TIMEOUT',
  EVIDENCE_INVALID: 'AGENT_EVIDENCE_INVALID',
});

const coded = (code, message, details = null) => Object.assign(new Error(message), { code, details });

export function defineAgent({ id, version = '1.0.0', readOnly = true, timeoutMs = 15_000, run } = {}) {
  if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) throw coded(AGENT_CONTRACT_CODES.INVALID, 'agent id 必须是小写连字符标识');
  if (typeof run !== 'function') throw coded(AGENT_CONTRACT_CODES.INVALID, 'agent run 必须是函数');
  if (readOnly !== true) throw coded(AGENT_CONTRACT_CODES.NOT_READONLY, 'verifier agent 不允许写设计（readOnly 必须为 true）');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw coded(AGENT_CONTRACT_CODES.INVALID, 'timeoutMs 必须是正数');
  return Object.freeze({ id, version, readOnly: true, timeoutMs, run });
}

/** 执行 agent：只读检查 → 超时隔离 → 错误结构化 → 证据契约校验。 */
export async function invokeAgent(agent, input, { timeoutMs = null } = {}) {
  if (!agent || agent.readOnly !== true || typeof agent.run !== 'function') throw coded(AGENT_CONTRACT_CODES.NOT_READONLY, '不是合法的只读 agent');
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : agent.timeoutMs;
  const startedAt = Date.now();
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(coded(AGENT_CONTRACT_CODES.TIMEOUT, `agent ${agent.id} 超时（>${limit}ms）`)), limit);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => agent.run(input)), timeout]);
    const envelope = value && value.schemaVersion === 1 ? value : null;
    if (envelope) {
      try { assertEvidenceEnvelope(envelope); } catch (error) { return { ok: false, agent: agent.id, code: AGENT_CONTRACT_CODES.EVIDENCE_INVALID, message: String(error?.message || error).slice(0, 240), elapsedMs: Date.now() - startedAt }; }
      return { ok: true, agent: agent.id, envelope, verdict: envelope.verdict, elapsedMs: Date.now() - startedAt };
    }
    return { ok: true, agent: agent.id, value, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, agent: agent.id, code: error?.code || 'AGENT_FAILED', message: String(error?.message || error).slice(0, 240), elapsedMs: Date.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
