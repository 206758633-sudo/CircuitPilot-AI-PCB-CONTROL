/**
 * 已验证设计规则包（Verified Design Rules Pack）。
 *
 * 目的：把"经过真实 EDA 读回 / 回归测试验证"的经验固定成**可执行参数**，直接驱动
 * 布局、计划门禁与执行回读门禁；不再依赖"知识库里还是 candidate"的条目。
 *
 * 设计原则：
 *  - 只有 verification.status === "verified" 且有 evidence 的规则才能进入本包；
 *  - 参数只允许已知白名单键（防止候选知识随意改门禁）；
 *  - pack 损坏/缺规则 → 启动时 fail-closed（抛错），不允许静默退回"没有规则"；
 *  - 候选知识不自动进包：promotion 必须显式、可审计（见 rule-promotion.mjs）。
 */
import { readFileSync } from 'node:fs';

export const SCHEMATIC_RULE_PACK_ID = 'schematic-design-rules';
export const SCHEMATIC_RULE_IDS = Object.freeze([
  'SCH-RULE-FRAME-A4',
  'SCH-RULE-GRID-10',
  'SCH-RULE-SYMBOL-SIZE',
  'SCH-RULE-COMPONENT-SPACING',
  'SCH-RULE-LABEL-READABILITY',
  'SCH-RULE-WIRE-INSIDE-FRAME',
]);

const PACK_URL = new URL('./schematic-design-rules.json', import.meta.url);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 校验 pack 形状与"已验证"约束；失败返回 errors，不抛（便于脚本报告）。 */
export function validateSchematicRulePack(pack) {
  const errors = [];
  if (!isPlainObject(pack)) return { ok: false, errors: ['pack 必须是对象'] };
  if (pack.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  if (pack.packId !== SCHEMATIC_RULE_PACK_ID) errors.push(`packId 必须为 ${SCHEMATIC_RULE_PACK_ID}`);
  if (typeof pack.version !== 'string' || !pack.version.trim()) errors.push('version 不能为空');
  const rules = Array.isArray(pack.rules) ? pack.rules : [];
  if (!rules.length) errors.push('rules 不能为空');
  const seen = new Set();
  for (const [index, rule] of rules.entries()) {
    const where = `rules[${index}]`;
    if (!isPlainObject(rule)) { errors.push(`${where} 必须是对象`); continue; }
    if (typeof rule.id !== 'string' || !/^SCH-RULE-[A-Z0-9-]+$/.test(rule.id)) errors.push(`${where}.id 非法`);
    if (seen.has(rule.id)) errors.push(`重复规则 id：${rule.id}`);
    seen.add(rule.id);
    if (!['error', 'warning', 'info'].includes(rule.severity)) errors.push(`${where}.severity 非法`);
    if (!['hard', 'audit'].includes(rule.enforcement)) errors.push(`${where}.enforcement 必须是 hard/audit`);
    if (!Array.isArray(rule.appliesTo) || !rule.appliesTo.length) errors.push(`${where}.appliesTo 不能为空`);
    if (!isPlainObject(rule.parameters)) errors.push(`${where}.parameters 必须是对象`);
    const verification = rule.verification;
    if (!isPlainObject(verification) || verification.status !== 'verified') errors.push(`${where} 未验证规则不得进入硬约束包`);
    if (!Array.isArray(verification?.evidence) || !verification.evidence.length) errors.push(`${where}.verification.evidence 不能为空`);
  }
  for (const required of SCHEMATIC_RULE_IDS) if (!seen.has(required)) errors.push(`缺少必需规则：${required}`);
  return { ok: errors.length === 0, errors };
}

export function loadSchematicRulePack({ url = PACK_URL, readFile = readFileSync } = {}) {
  let parsed;
  try { parsed = JSON.parse(readFile(url, 'utf8')); } catch (error) {
    throw Object.assign(new Error(`读取已验证设计规则包失败：${String(error?.message || error).slice(0, 160)}`), { code: 'DESIGN_RULES_PACK_UNREADABLE' });
  }
  const validation = validateSchematicRulePack(parsed);
  if (!validation.ok) throw Object.assign(new Error(`已验证设计规则包非法：${validation.errors.slice(0, 5).join('；')}`), { code: 'DESIGN_RULES_PACK_INVALID', details: validation.errors });
  return Object.freeze(parsed);
}

const PACK = loadSchematicRulePack();

/** 浅层合并参数（rules 顺序确定；后出现的覆盖同键）。 */
export function resolveSchematicRuleParams(pack = PACK) {
  const params = {};
  for (const rule of pack.rules) {
    for (const [key, value] of Object.entries(rule.parameters || {})) {
      if (isPlainObject(value) && isPlainObject(params[key])) params[key] = { ...params[key], ...value };
      else params[key] = value;
    }
  }
  return params;
}

export const SCHEMATIC_RULE_PACK = PACK;
export const SCHEMATIC_RULE_PARAMS = Object.freeze(resolveSchematicRuleParams(PACK));

/** 规则包状态（给 doctor/API/测试用；不返回整份 pack）。 */
export function getSchematicRulePackStatus() {
  return {
    packId: PACK.packId,
    version: PACK.version,
    ruleCount: PACK.rules.length,
    ruleIds: PACK.rules.map((rule) => rule.id),
    verified: PACK.rules.every((rule) => rule.verification?.status === 'verified'),
    enforced: PACK.rules.filter((rule) => rule.enforcement === 'hard').map((rule) => rule.id),
  };
}
