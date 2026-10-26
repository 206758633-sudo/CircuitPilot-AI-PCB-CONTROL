import { describe, expect, it } from 'vitest';
import type { PlacementItem, PlacementWritebackResult, ProductionOutputDecision, ReleaseGateReport } from '../../types';
import {
  buildFineTunePlan, buildRestorePlan, formatMm, gateStatusLabel, groupBlockers, planHighlights, summarizeGate, summarizeOutputDecision, summarizeWriteback, verificationRows,
} from '../placementViewModel';

const item = (over: Partial<PlacementItem> = {}): PlacementItem => ({
  ref: 'U1', primitiveId: 'p1', xMm: 10, yMm: -20, rotationDeg: 0, side: 'top', widthMm: 2.8, heightMm: 2.8,
  current: { xMm: 10, yMm: -20, rotationDeg: 0 }, partnerCount: 3, ...over,
});

const writeback = (over: Partial<PlacementWritebackResult> = {}): PlacementWritebackResult => ({
  ok: true, applied: true, saved: false, dryRun: false, updates: [], skipped: [], missing: [], steps: [], findings: [], verified: null, rollback: null, ...over,
});

describe('布局微调：写回计划只包含 primitiveId 与 mm', () => {
  it('只把用户真的改过的器件放进计划', () => {
    const plan = buildFineTunePlan([item(), item({ ref: 'U2', primitiveId: 'p2' })], [{ ref: 'U2', xMm: 3, yMm: -36, rotationDeg: 90 }]);
    expect(plan.placements).toHaveLength(1);
    expect(plan.placements[0]).toMatchObject({ ref: 'U2', primitiveId: 'p2', xMm: 3, yMm: -36, rotationDeg: 90 });
  });

  it('没有 primitiveId 的器件不能进计划（不知道改谁，宁可不改）', () => {
    const plan = buildFineTunePlan([item({ primitiveId: null })], [{ ref: 'U1', xMm: 1, yMm: 1, rotationDeg: 0 }]);
    expect(plan.placements).toHaveLength(0);
  });

  it('还原计划用的是"当前实际位置"，不是计划目标位置', () => {
    const plan = buildRestorePlan([item({ xMm: 40, yMm: -30, current: { xMm: 10, yMm: -20, rotationDeg: 0 } })]);
    expect(plan.placements[0]).toMatchObject({ xMm: 10, yMm: -20 });
  });
});

describe('写回结果必须说清"板子到底变了没有"', () => {
  it('预演：明确说未写入 EDA', () => {
    const s = summarizeWriteback(writeback({ dryRun: true, applied: false, updates: [{ ref: 'U1', primitiveId: 'p1', fromMm: { xMm: 0, yMm: 0, rotationDeg: 0 }, toMm: { xMm: 1, yMm: 1, rotationDeg: 0 }, deltaMm: 1.41, deltaRotationDeg: 0 }] }));
    expect(s.tone).toBe('info');
    expect(s.headline).toContain('未写入 EDA');
  });

  it('写回成功但未保存：必须提醒去 EDA 手动保存，不能让人以为已经落盘', () => {
    const s = summarizeWriteback(writeback({ updates: [{ ref: 'U1', primitiveId: 'p1', fromMm: { xMm: 0, yMm: 0, rotationDeg: 0 }, toMm: { xMm: 1, yMm: 1, rotationDeg: 0 }, deltaMm: 1.41, deltaRotationDeg: 0 }] }));
    expect(s.tone).toBe('success');
    expect(s.detail).toContain('尚未保存');
  });

  it('回滚与回滚失败必须分别说清（回滚失败要指到手工坐标）', () => {
    const rolledBack = summarizeWriteback(writeback({ ok: false, applied: false, findings: [{ code: 'PLACEMENT_WRITE_ROLLED_BACK', severity: 'warning', message: 'x' }] }));
    expect(rolledBack.tone).toBe('warning');
    expect(rolledBack.headline).toContain('回滚');
    const failed = summarizeWriteback(writeback({ ok: false, applied: false, findings: [{ code: 'PLACEMENT_WRITE_ROLLBACK_FAILED', severity: 'blocking', message: 'x' }] }));
    expect(failed.tone).toBe('danger');
    expect(failed.detail).toContain('manualCoordinates');
  });
});

describe('复核发现：没有结果时绝不能显示成通过', () => {
  it('没有复核结果 → neutral 行，不是 success', () => {
    const rows = verificationRows(null, '写回后');
    expect(rows).toHaveLength(1);
    expect(rows[0].tone).toBe('neutral');
  });

  it('blocking → danger；全部通过且有计数 → success', () => {
    const blocking = verificationRows({ ok: false, blockingCount: 1, checkedCount: 2, findings: [{ code: 'PLACEMENT_OUTSIDE_OUTLINE', severity: 'blocking', message: 'J1 伸出板边' }] }, '现状');
    expect(blocking[0].tone).toBe('danger');
    const ok = verificationRows({ ok: true, blockingCount: 0, checkedCount: 8, findings: [] }, '写回后');
    expect(ok[0].tone).toBe('success');
    expect(ok[0].message).toContain('8 个器件');
  });
});

describe('方案摘要与门禁文案', () => {
  it('器件尺寸未知时必须显式警告（否则会以为已经全自动放好了）', () => {
    const lines = planHighlights({
      ok: true, outline: { points: [{ x: 0, y: 0 }], source: [], closed: true }, componentCount: 2, unknownSize: ['J1'],
      affinity: { netCount: 3, topPairs: [['U1|U2', 1.5]] },
      plan: { ok: true, placements: [], unplaced: [], findings: [], stats: { placedCount: 1, unplacedCount: 1, gridMm: 0.5, edgeClearanceMm: 1, spacingMm: 0.5, utilization: 0.07 } },
      verification: { ok: true, blockingCount: 0, checkedCount: 1, findings: [] },
      currentVerification: { ok: false, blockingCount: 1, checkedCount: 2, findings: [] },
      diff: { rows: [], movedCount: 1, newCount: 0, unchangedCount: 1 },
    });
    expect(lines.some((line) => line.includes('尺寸未知'))).toBe(true);
    expect(lines.some((line) => line.includes('利用率'))).toBe(true);
  });

  it('门禁三方口径一致：blocked 就是不能下单，且阻断按"要修什么"分组', () => {
    const report: ReleaseGateReport = {
      kind: 'fabrication-release-gate', schemaVersion: 1, generatedAt: 'now', ready: false, verdict: 'blocked',
      blockers: [
        { code: 'RELEASE_SCHEMATIC_NOT_READY', message: 'CC1 悬空' },
        { code: 'RELEASE_DRC_UNEXPLAINED', message: '156 条未处理' },
        { code: 'RELEASE_DRC_EXEMPTION_INVALID', message: '57 条豁免无效' },
      ],
      warnings: [], gates: [], fingerprint: { sha256: 'a'.repeat(64), parts: {} }, humanSignoffRequired: true,
    };
    const summary = summarizeGate(report);
    expect(summary.tone).toBe('danger');
    expect(summary.headline).toContain('不能下单');
    const groups = groupBlockers(report);
    expect(groups.map((group) => group.title)).toEqual(['原理图问题（要改设计）', 'DRC 未处理项（要布线或登记豁免）', '豁免无效（理由/风险没写清）']);
    expect(groups[1].items[0].message).toContain('156');
    expect(summarizeGate(null).tone).toBe('neutral');
    expect(gateStatusLabel('unknown')).toBe('证据缺失');
    expect(gateStatusLabel('pass')).toBe('通过');
  });

  it('未知数值显示为 —（不能用 0 冒充）', () => {
    expect(formatMm(null)).toBe('—');
    expect(formatMm(undefined)).toBe('—');
    expect(formatMm(Number.NaN)).toBe('—');
    expect(formatMm(10.456)).toBe('10.46');
  });
});

describe('产出裁决：界面只显示运行时的结论，绝不自己判断一遍', () => {
  const decision = (over: Partial<ProductionOutputDecision> = {}): ProductionOutputDecision => ({
    kind: 'production-output-decision', requested: 'final', allowed: false, outputClass: null,
    blockers: ['RELEASE_DRC_UNEXPLAINED'], humanSignoffRequired: true,
    gate: { verdict: 'blocked', ready: false, fingerprint: 'f'.repeat(64), blockerCodes: ['RELEASE_DRC_UNEXPLAINED'] }, ...over,
  });

  it('没有裁决时显示"还没有"，不许默认成通过', () => {
    const summary = summarizeOutputDecision(undefined);
    expect(summary.tone).toBe('neutral');
    expect(summary.headline).toContain('还没有');
  });

  it('被拒时显示 danger + 拒绝原因 + 修复建议 + 草稿命名', () => {
    const summary = summarizeOutputDecision(decision({ code: 'PRODUCTION_OUTPUT_BLOCKED', message: '门禁未通过（1 类阻断）：现在只能产出草稿文件', fix: ['先修 DRC'], draftNaming: '{名称}-DRAFT-NOT-FOR-ORDER.{扩展名}' }));
    expect(summary.tone).toBe('danger');
    expect(summary.headline).toContain('拒绝');
    expect(summary.detail).toContain('只能产出草稿');
    expect(summary.fix).toEqual(['先修 DRC']);
    expect(summary.naming).toContain('DRAFT-NOT-FOR-ORDER');
  });

  it('允许正式产出时给绿色的成功结论，并带出放行凭据', () => {
    const summary = summarizeOutputDecision(decision({ allowed: true, outputClass: 'final', exampleNames: ['BOM_CircuitPilot-bom.csv'], ticket: 'abc123', message: '门禁通过' }));
    expect(summary.tone).toBe('success');
    expect(summary.headline).toContain('正式命名');
    expect(summary.naming).toBe('BOM_CircuitPilot-bom.csv');
    expect(summary.ticket).toBe('abc123');
  });

  it('只允许草稿时是 warning，不是 success（草稿不能下单这件事必须一直显眼）', () => {
    const summary = summarizeOutputDecision(decision({ allowed: true, outputClass: 'draft', warning: '草稿文件不得用于下单', draftNaming: '{名称}-DRAFT-NOT-FOR-ORDER.{扩展名}' }));
    expect(summary.tone).toBe('warning');
    expect(summary.headline).toContain('草稿');
  });
});
