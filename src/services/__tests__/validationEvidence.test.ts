import { describe, expect, it } from 'vitest';
import { createSeedState } from '../../data/seed';
import type { IssueRecord, ValidationCheck } from '../../types';
import { autoResolvableOfficialIssueIds, buildOfficialValidationRecord, drcItemsToValidationFindings, edaProjectUuidFromCommandResult, edaWorkspaceIdentity, ercFindingsToValidationFindings, mergeDemoValidationRun, mergeValidationRecord, officialValidationsForProject, validationKpis } from '../validationEvidence';

describe('EDA 工程身份：只读 project.current 的多种返回形状', () => {
  it('真机嵌套 Board 结果从 parentProjectUuid 读工程 UUID，不拿 PCB/Schematic UUID 冒充', () => {
    const actual = {
      id: 'project.current',
      permission: 'read',
      result: {
        success: true,
        result: {
          data: [{
            itemType: 'Board',
            name: 'Board1',
            parentProjectUuid: '8e652031ec18479898e77d5a9b5ef7a9',
            pcb: { uuid: '9ab008aa6dfb92c2' },
            schematic: { uuid: '738a71eb6fa3da56' },
          }],
        },
      },
    };
    expect(edaProjectUuidFromCommandResult(actual)).toBe('8e652031ec18479898e77d5a9b5ef7a9');
  });

  it('兼容旧版 {uuid}/{id}/{data:[{uuid}]}，且不把命令名 project.current 当 UUID', () => {
    expect(edaProjectUuidFromCommandResult({ id: 'project.current', permission: 'read', result: { uuid: 'P1' } })).toBe('P1');
    expect(edaProjectUuidFromCommandResult({ id: 'project.current', permission: 'read', result: { id: 'P2' } })).toBe('P2');
    expect(edaProjectUuidFromCommandResult({ id: 'project.current', permission: 'read', result: { data: [{ uuid: 'P3' }] } })).toBe('P3');
    expect(edaProjectUuidFromCommandResult({ id: 'project.current', permission: 'read', result: { data: [] } })).toBeNull();
  });
});

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


describe('源修复自动收口：官方通过后只关闭同一 checkId / 同项目的旧问题', () => {
  const issue = (overrides: Partial<IssueRecord>): IssueRecord => ({
    id: 'issue-1',
    fingerprint: 'fp-1',
    source: 'validation',
    severity: 'error',
    status: 'open',
    code: 'Netlist Error',
    summary: 'DRC：Netlist Error',
    detail: 'detail',
    firstOccurredAt: '2026-11-02 10:38',
    lastOccurredAt: '2026-11-02 10:38',
    occurrences: 1,
    context: { checkId: 'official-drc-p1', projectId: 'p1' },
    handling: [],
    ...overrides,
  });
  const pass = (overrides: Partial<ValidationCheck> = {}): ValidationCheck => ({
    ...buildOfficialValidationRecord({ engine: 'DRC', projectId: 'p1', description: '官方 DRC', status: 'pass', count: 0, findings: [], evidence: { engine: 'DRC', digest: 'd'.repeat(64), path: '/tmp/drc.json' } }),
    ...overrides,
  });

  it('通过时收口同 checkId 同项目的 open validation 问题', () => {
    const record = pass();
    const issues = [
      issue({ id: 'old-drc' }),
      issue({ id: 'other-check', context: { checkId: 'official-drc-p2', projectId: 'p1' } }),
      issue({ id: 'other-project', context: { checkId: 'official-drc-p1', projectId: 'p2' } }),
      issue({ id: 'already-resolved', status: 'resolved' }),
      issue({ id: 'not-validation', source: 'runtime' }),
    ];
    expect(autoResolvableOfficialIssueIds(issues, record)).toEqual(['old-drc']);
  });

  it('失败/非零/非官方/无项目都不自动收口，避免误关', () => {
    expect(autoResolvableOfficialIssueIds([issue({})], pass({ status: 'fail', count: 1 }))).toEqual([]);
    expect(autoResolvableOfficialIssueIds([issue({})], pass({ source: 'demo' }))).toEqual([]);
    expect(autoResolvableOfficialIssueIds([issue({})], pass({ projectId: undefined }))).toEqual([]);
  });
});
