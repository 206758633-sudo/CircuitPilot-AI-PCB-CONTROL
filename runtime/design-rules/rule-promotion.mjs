/**
 * 已验证经验 → 设计规则包 的晋升流水线（显式、可审计，不自动批准）。
 *
 * 只有同时满足以下条件的知识条目才可晋升：
 *  - kind === 'rule'
 *  - review.state === 'approved'（人工审核通过）
 *  - trust !== 'unverified'
 *  - payload.verification.status === 'verified' 且 evidence 非空
 *  - payload.designRule 给出白名单内的参数/范围
 *
 * 晋升结果只修改规则包；是否落盘由调用方显式 --write --confirm 决定。
 * 候选知识永远不会被自动提升为硬约束。
 */
import { SCHEMATIC_RULE_IDS, validateSchematicRulePack } from './verified-rules.mjs';

export const ALLOWED_PARAMETER_ROOTS = Object.freeze(['frame', 'grid', 'symbolBase', 'pinPitch', 'pinPadding', 'layout', 'label', 'enforcement']);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function reject(reason, entry) {
  return { id: entry?.payload?.designRule?.id ?? entry?.payload?.ruleId ?? entry?.id ?? null, title: entry?.title ?? null, reason };
}

/**
 * @param {{entries?: Array<object>, pack: object, now?: () => Date}} input
 * @returns {{ok: boolean, pack: object, promoted: Array<object>, rejected: Array<object>, errors?: string[]}}
 */
export function promoteVerifiedKnowledgeRules({ entries = [], pack, now = () => new Date() } = {}) {
  if (!isPlainObject(pack)) return { ok: false, pack, promoted: [], rejected: [], errors: ['缺少基础规则包'] };
  const promoted = [];
  const rejected = [];
  const rules = pack.rules.map((rule) => ({ ...rule, parameters: { ...(rule.parameters || {}) } }));
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== 'rule') { rejected.push(reject('not-a-rule-entry', entry)); continue; }
    if (entry?.review?.state !== 'approved') { rejected.push(reject('not-approved', entry)); continue; }
    if (!entry?.trust || entry.trust === 'unverified') { rejected.push(reject('untrusted', entry)); continue; }
    const verification = entry?.payload?.verification;
    if (!isPlainObject(verification) || verification.status !== 'verified' || !Array.isArray(verification.evidence) || !verification.evidence.length) {
      rejected.push(reject('verification-missing', entry)); continue;
    }
    const designRule = entry?.payload?.designRule;
    if (!isPlainObject(designRule)) { rejected.push(reject('designRule-missing', entry)); continue; }
    if (typeof designRule.id !== 'string' || !/^SCH-RULE-[A-Z0-9-]+$/.test(designRule.id)) { rejected.push(reject('designRule.id-invalid', entry)); continue; }
    if (!isPlainObject(designRule.parameters)) { rejected.push(reject('designRule.parameters-invalid', entry)); continue; }
    const unknownRoots = Object.keys(designRule.parameters).filter((key) => !ALLOWED_PARAMETER_ROOTS.includes(key));
    if (unknownRoots.length) { rejected.push(reject(`unknown-parameter:${unknownRoots.join(',')}`, entry)); continue; }
    if (!['error', 'warning', 'info'].includes(designRule.severity)) { rejected.push(reject('severity-invalid', entry)); continue; }
    if (!['hard', 'audit'].includes(designRule.enforcement)) { rejected.push(reject('enforcement-invalid', entry)); continue; }
    if (!Array.isArray(designRule.appliesTo) || !designRule.appliesTo.length) { rejected.push(reject('appliesTo-invalid', entry)); continue; }
    const rule = {
      id: designRule.id,
      title: String(designRule.title ?? entry.title ?? designRule.id).slice(0, 200),
      category: String(designRule.category ?? 'schematic/verified'),
      severity: designRule.severity,
      enforcement: designRule.enforcement,
      appliesTo: [...new Set(designRule.appliesTo.map(String))],
      parameters: designRule.parameters,
      verification: {
        status: 'verified',
        verifiedAt: verification.verifiedAt ?? now().toISOString(),
        method: String(verification.method ?? 'approved knowledge rule with verification evidence').slice(0, 500),
        evidence: verification.evidence.map(String),
      },
      provenance: { knowledgeId: entry.id ?? null, title: entry.title ?? null, trust: entry.trust, source: entry.provenance?.source ?? null },
    };
    const existingIndex = rules.findIndex((item) => item.id === rule.id);
    if (existingIndex >= 0) rules[existingIndex] = rule;
    else rules.push(rule);
    promoted.push({ id: rule.id, title: rule.title, knowledgeId: entry.id ?? null });
  }
  const next = { ...pack, rules };
  const validation = validateSchematicRulePack(next);
  if (!validation.ok) return { ok: false, pack, promoted: [], rejected, errors: validation.errors };
  for (const required of SCHEMATIC_RULE_IDS) if (!next.rules.some((rule) => rule.id === required)) return { ok: false, pack, promoted: [], rejected, errors: [`promotion removed required rule: ${required}`] };
  return { ok: true, pack: next, promoted, rejected };
}
