import { describe, expect, it } from 'vitest';
import { createSeedState } from '../../data/seed';
import type { ValidationCheck } from '../../types';
import { buildOfficialValidationRecord, drcItemsToValidationFindings, edaWorkspaceIdentity, ercFindingsToValidationFindings, mergeDemoValidationRun, mergeValidationRecord, officialValidationsForProject, validationKpis } from '../validationEvidence';

describe('P0-3 验证结果单一来源：官方记录 + 项目域 + KPI', () => {
  it('seed 预置记录不是真实覆盖：全新安装显示 0%，不会出现"已验证 75%"', () => {
    const state = createSeedState();
    const kpis = validationKpis(state.validations, state.projects[0]?.id);
    expect(kpis.ran).toBe(0);
    expect(kpis.coverage).toBe(0);
    expect(kpis.passed).toBe(0);
    expect(kpis.missing).toEqual(['ERC', 'DRC']);
    expect(kpis.demoOrSeed).toBe(state.validations.length);
  });

  it('官方 DRC 通过后覆盖率上升，findings 计入未收口；项目之间不串证据', () => {
    const state = createSeedState();
    const projectId = state.projects[0].id;
    const record = buildOfficialValidationRecord({
      engine: 'DRC',
      projectId,
      description: '嘉立创EDA 原生 DRC',
      status: 'pass',
      count: 0,
      findings: [],
      evidence: { engine: 'DRC', digest: 'digest-drc', path: '/tmp/drc.json', jobId: 'job-1' },
    });
    const validations = mergeValidationRecord(state.validations, record);
    const kpis = validationKpis(validations, projectId);
    expect(kpis.ran).toBe(1);
    expect(kpis.coverage).toBe(50);
    expect(kpis.passed).toBe(1);
    expect(kpis.openFindings).toBe(0);
    // 另一个项目看不到这条官方记录
    expect(officialValidationsForProject(validations, 'another-project')).toEqual([]);
    expect(validationKpis(validations, 'another-project').coverage).toBe(0);

    const failed = buildOfficialValidationRecord({
      engine: 'ERC', projectId, description: 'ERC', status: 'fail', count: 2,
      findings: ercFindingsToValidationFindings([{ code: 'ERC-PWR-003', severity: 'error', title: '电源输入未标记 PWR_FLAG', object: 'VBUS_5V' }, { code: 'ERC-001', severity: 'warning', title: '未连接引脚', object: 'U1' }]),
      evidence: { engine: 'ERC', digest: 'digest-erc' },
    });
    const withErc = mergeValidationRecord(validations, failed);
    const full = validationKpis(withErc, projectId);
    expect(full.ran).toBe(2);
    expect(full.coverage).toBe(100);
    expect(full.failedOrWarn).toBe(1);
    expect(full.openFindings).toBe(2);
    expect(full.missing).toEqual([]);
  });

  it('同名种子行被官方结论替换（保留 id 以稳定选中态），不同项目各自一行', () => {
    const state = createSeedState();
    const seedDrc = state.validations.find((item) => item.name === 'DRC')!;
    const record = buildOfficialValidationRecord({
      engine: 'DRC', projectId: 'p1', description: '官方', status: 'fail', count: 1,
      findings: [], evidence: { engine: 'DRC', digest: 'd' },
    });
    const merged = mergeValidationRecord(state.validations, record);
    const drcRows = merged.filter((item) => item.name === 'DRC');
    expect(drcRows).toHaveLength(1);
    expect(drcRows[0].id).toBe(seedDrc.id);
    expect(drcRows[0].source).toBe('official');
    expect(drcRows[0].projectId).toBe('p1');

    const second = mergeValidationRecord(merged, { ...record, projectId: 'p2', id: 'official-drc-p2' } satisfies ValidationCheck);
    expect(second.filter((item) => item.name === 'DRC')).toHaveLength(2);
  });

  it('DRC 原生条目转 Finding：字段缺失时也不丢条目，规则/对象尽量可读', () => {
    const findings = drcItemsToValidationFindings([
      { errorType: 'Clearance', instanceKey: 'D1-P1', message: '间距不足' },
      {},
    ]);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ rule: 'Clearance', object: 'D1-P1', title: '间距不足', severity: 'error', status: 'open' });
    expect(findings[1].rule).toBe('DRC');
    expect(findings[1].object).toBe('—');
  });
});

describe('UI 复审：Demo 全量运行不得抹掉官方验证记录', () => {
  it('模拟结果覆盖非官方行，官方 ERC/DRC 原样保留且计数不变', () => {
    const official = buildOfficialValidationRecord({
      engine: 'DRC', projectId: 'p1', description: '官方 DRC', status: 'pass', count: 0, findings: [],
      evidence: { engine: 'DRC', digest: 'd'.repeat(64), path: '/tmp/drc.json', jobId: 'job-1' },
    });
    const seed = createSeedState().validations.filter((item) => item.name !== 'DRC');
    const simulated = [...seed, official].map((item) => ({ ...item, status: 'pass' as const, count: 0, findings: [] }));
    const merged = mergeDemoValidationRun([...seed, official], simulated);
    const drc = merged.filter((item) => item.name === 'DRC');
    expect(drc).toHaveLength(1);
    expect(drc[0].source).toBe('official');
    expect(drc[0].evidence?.digest).toBe('d'.repeat(64));
    expect(merged.filter((item) => item.source === 'official')).toHaveLength(1);
    expect(merged.filter((item) => item.name !== 'DRC').every((item) => item.source === 'demo')).toBe(true);
  });
});

describe('P1-1 复审 2026-10-29：官方取证前的 EDA 工程身份判定（fail-closed）', () => {
  it('两边都读到且相等才允许取证', () => {
    expect(edaWorkspaceIdentity('proj-1', 'proj-1')).toEqual({ ok: true, projectUuid: 'proj-1' });
    expect(edaWorkspaceIdentity(' proj-1 ', 'proj-1')).toEqual({ ok: true, projectUuid: 'proj-1' });
  });

  it('项目未绑定工程 → no-binding（不允许取证）', () => {
    const result = edaWorkspaceIdentity(null, 'proj-1');
    expect(result).toMatchObject({ ok: false, reason: 'no-binding' });
  });

  it('读不到当前工程身份 → unknown（不允许取证）', () => {
    const result = edaWorkspaceIdentity('proj-1', '   ');
    expect(result).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('跨工程 → mismatch，并带回两边 uuid 供定位', () => {
    const result = edaWorkspaceIdentity('proj-1', 'proj-2');
    expect(result).toMatchObject({ ok: false, reason: 'mismatch', boundProjectUuid: 'proj-1', currentProjectUuid: 'proj-2' });
  });
});
