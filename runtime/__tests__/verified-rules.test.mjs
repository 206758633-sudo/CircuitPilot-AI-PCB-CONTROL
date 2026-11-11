import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCHEMATIC_RULE_PACK,
  SCHEMATIC_RULE_PARAMS,
  getSchematicRulePackStatus,
  resolveSchematicRuleParams,
  validateSchematicRulePack,
} from '../design-rules/verified-rules.mjs';
import { promoteVerifiedKnowledgeRules } from '../design-rules/rule-promotion.mjs';
import { SCHEMATIC_PLAN_MARGIN, SCHEMATIC_SHEET_FRAME, estimateSymbolSize } from '../schematic-layout.mjs';

const approvedVerifiedEntry = (designRule) => ({
  id: 'kn-rule-verified-1',
  kind: 'rule',
  title: 'verified test rule',
  trust: 'reference',
  review: { state: 'approved' },
  provenance: { source: 'unit-test' },
  payload: {
    ruleId: designRule.id,
    designRule,
    verification: { status: 'verified', verifiedAt: '2026-11-11', method: 'unit test fixture', evidence: ['runtime/__tests__/verified-rules.test.mjs'] },
  },
});

test('已验证规则包：合法、全部 verified、必需规则齐全', () => {
  const validation = validateSchematicRulePack(SCHEMATIC_RULE_PACK);
  assert.equal(validation.ok, true, validation.errors.join('; '));
  const status = getSchematicRulePackStatus();
  assert.equal(status.verified, true);
  assert.equal(status.ruleCount, status.ruleIds.length);
  for (const id of ['SCH-RULE-FRAME-A4', 'SCH-RULE-COMPONENT-SPACING', 'SCH-RULE-LABEL-READABILITY', 'SCH-RULE-WIRE-INSIDE-FRAME']) {
    assert.ok(status.ruleIds.includes(id), `missing ${id}`);
  }
});

test('布局/计划/门禁参数直接来自规则包（规则不是文档摆设）', () => {
  assert.equal(SCHEMATIC_SHEET_FRAME.width, SCHEMATIC_RULE_PARAMS.frame.width);
  assert.equal(SCHEMATIC_SHEET_FRAME.height, SCHEMATIC_RULE_PARAMS.frame.height);
  assert.equal(SCHEMATIC_SHEET_FRAME.margin, SCHEMATIC_RULE_PARAMS.frame.margin);
  assert.equal(SCHEMATIC_PLAN_MARGIN, SCHEMATIC_RULE_PARAMS.frame.planMargin);
  const passive = estimateSymbolSize({ ref: 'R1', pinCount: 2 });
  assert.equal(passive.width, SCHEMATIC_RULE_PARAMS.symbolBase.passive.width);
  assert.equal(passive.height, SCHEMATIC_RULE_PARAMS.symbolBase.passive.height);
  assert.equal(SCHEMATIC_RULE_PARAMS.layout.gapX, 40);
  assert.equal(SCHEMATIC_RULE_PARAMS.enforcement.blockNewViolationsAfterWrite, true);
});

test('晋升：approved + trust 非 unverified + verified 证据 + 白名单参数 → 进入规则包', () => {
  const entry = approvedVerifiedEntry({
    id: 'SCH-RULE-TEST-SPACING',
    title: '更大间距（验证测试）',
    category: 'schematic/spacing',
    severity: 'error',
    enforcement: 'hard',
    appliesTo: ['layout'],
    parameters: { layout: { gapX: 55 } },
  });
  const result = promoteVerifiedKnowledgeRules({ entries: [entry], pack: SCHEMATIC_RULE_PACK });
  assert.equal(result.ok, true, (result.errors ?? []).join('; '));
  assert.equal(result.promoted.length, 1);
  assert.equal(result.promoted[0].id, 'SCH-RULE-TEST-SPACING');
  const params = resolveSchematicRuleParams(result.pack);
  assert.equal(params.layout.gapX, 55);
  assert.equal(params.frame.width, SCHEMATIC_RULE_PARAMS.frame.width, '晋升不得丢掉既有规则参数');
});

test('晋升拒绝：candidate / unverified / 缺证据 / 未知参数 / 非法 severity 一律不进入规则包', () => {
  const base = approvedVerifiedEntry({ id: 'SCH-RULE-TEST-BAD', title: 'bad', category: 'schematic/test', severity: 'error', enforcement: 'hard', appliesTo: ['layout'], parameters: { layout: { gapX: 50 } } });
  const cases = [
    { ...base, review: { state: 'candidate' }, payload: { ...base.payload } },
    { ...base, trust: 'unverified', payload: { ...base.payload } },
    { ...base, payload: { ...base.payload, verification: { status: 'verified', evidence: [] } } },
    { ...base, payload: { ...base.payload, designRule: { ...base.payload.designRule, parameters: { arbitraryRoot: { x: 1 } } } } },
    { ...base, payload: { ...base.payload, designRule: { ...base.payload.designRule, severity: 'fatal' } } },
  ];
  for (const entry of cases) {
    const result = promoteVerifiedKnowledgeRules({ entries: [entry], pack: SCHEMATIC_RULE_PACK });
    assert.equal(result.ok, true, '拒绝单条不应破坏规则包');
    assert.equal(result.promoted.length, 0, JSON.stringify(entry.payload?.designRule));
    assert.ok(result.rejected.length >= 1);
  }
});
