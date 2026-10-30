/**
 * 官方 DRC 结果 → 规则引擎门禁证据（GATE-02 / DFM）。
 *
 * 关键边界：DRC 结果本身是 EDA 的机器输出，把它哈希成 artifactHash 是“可追溯”，
 * 不是“人工签字”。因此这里只证明“这份 DRC 结果确实被跑过、内容未被改动”，
 * 不把 `{passed:true}` 当成放行：releaseReady 仍要求其它门禁（DFM/DFA/FAI/ECO）齐全。
 */
import { createHash } from 'node:crypto';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** 兼容 `pcb.drc` 的数组 / {items} / {errors} 三种真实形态；认不出就返回 null。 */
export function drcItems(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.errors)) return result.errors;
  if (Array.isArray(result.violations)) return result.violations;
  return null;
}

/**
 * @param {unknown} result `pcb.drc` / `pcb.job.poll` 的 result
 * @param {{scope:string, source?:string, issuedAt?:string, reportId?:string}} options
 */
export function buildDrcEvidence(result, { scope, source = 'JLCEDA-PCB-DRC', issuedAt = new Date().toISOString(), reportId = null } = {}) {
  if (!scope || typeof scope !== 'string') throw Object.assign(new Error('buildDrcEvidence 需要 scope（板/版本/规则范围）'), { code: 'DRC_EVIDENCE_SCOPE_REQUIRED' });
  const items = drcItems(result);
  if (items === null) return { ok: false, reason: 'DRC_RESULT_UNRECOGNIZED', evidence: null };
  const digest = sha256(JSON.stringify(result));
  const truncated = Boolean(result?.truncated);
  const passed = items.length === 0 && !truncated && result?.passed !== false;
  const evidence = {
    passed,
    source,
    artifactHash: digest,
    issuedAt,
    scope,
    reportId: reportId || `DRC-${digest.slice(0, 12)}`,
    count: items.length,
    truncated,
  };
  return { ok: true, evidence, digest, count: items.length, truncated };
}
