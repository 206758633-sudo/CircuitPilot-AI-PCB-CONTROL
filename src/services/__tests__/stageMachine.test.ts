import { describe, expect, it } from 'vitest';
import {
  STAGE_EVIDENCE_DEFINITIONS,
  STAGE_EVIDENCE_KEYS,
  STAGE_ORDER,
  evaluateStageAdvance,
  evidenceLabel,
  isStage,
  nextStage,
  projectStageValue,
  requiredEvidenceFor,
  stageOfProjectStage,
  stageProgress,
  type Stage,
  type StageEvidence,
} from '../stageMachine';

/** 六项证据全部显式 true。 */
const fullEvidence: StageEvidence = {
  requirementsConfirmed: true,
  bomApproved: true,
  netlistApproved: true,
  schematicGenerated: true,
  pcbPlaced: true,
  drcPassed: true,
};

const advance = (from: Stage, to: Stage, evidence: StageEvidence = fullEvidence) => evaluateStageAdvance({ from, to, evidence });

describe('D5 阶段机：阶段顺序是确定性常量', () => {
  it('8 个 canonical 阶段按固定顺序排列，nextStage 只返回相邻下一阶段', () => {
    expect(STAGE_ORDER).toEqual(['概念', '需求', '选型', '原理图', 'PCB', '验证', '生产', '归档']);
    for (let index = 0; index < STAGE_ORDER.length - 1; index += 1) {
      expect(nextStage(STAGE_ORDER[index])).toBe(STAGE_ORDER[index + 1]);
    }
    expect(nextStage('归档')).toBeNull();
    expect(isStage('PCB')).toBe(true);
    expect(isStage('PCB布局')).toBe(false);
  });

  it('每个相邻推进都有证据要求定义：证据齐备时全部允许', () => {
    for (let index = 0; index < STAGE_ORDER.length - 1; index += 1) {
      const from = STAGE_ORDER[index];
      const to = STAGE_ORDER[index + 1];
      const result = advance(from, to);
      expect(result.allowed, `${from} → ${to}: ${result.reason}`).toBe(true);
      expect(result.blocking).toEqual([]);
      // 生产→归档是显式终止，不要求新证据；其余相邻推进必须至少要求一项证据。
      if (to !== '归档') expect(requiredEvidenceFor(from, to).length).toBeGreaterThan(0);
    }
  });
});

describe('D5 阶段机：顺序推进', () => {
  it('概念 → 需求：需求确认证据齐备时允许，并给出中文理由', () => {
    const result = advance('概念', '需求');
    expect(result).toMatchObject({ allowed: true, from: '概念', to: '需求' });
    expect(result.missingEvidence).toEqual([]);
    expect(result.reason).toContain('允许从「概念」推进到「需求」');
    expect(result.reason).toContain('需求已确认');
  });

  it('原理图 → PCB：网表批准 + 原理图生成两项证据都必需', () => {
    const result = advance('原理图', 'PCB');
    expect(result.allowed).toBe(true);
    expect(result.requiredEvidence).toEqual(['netlistApproved', 'schematicGenerated']);
  });
});

describe('D5 阶段机：跳级 / 回退 / 原地推进都拒绝', () => {
  it('跳级拒绝，并提示必须先完成哪一阶段', () => {
    const result = advance('概念', '原理图');
    expect(result.allowed).toBe(false);
    expect(result.blocking.join(' ')).toContain('跳级');
    expect(result.blocking.join(' ')).toContain('需求');
    expect(result.reason).toContain('不允许跳级');
  });

  it('回退拒绝（即使证据齐全），要求走受控变更', () => {
    const result = advance('验证', '原理图');
    expect(result.allowed).toBe(false);
    expect(result.blocking.join(' ')).toContain('回退');
    expect(result.blocking.join(' ')).toContain('受控变更');
  });

  it('原地推进拒绝', () => {
    const result = advance('PCB', 'PCB');
    expect(result.allowed).toBe(false);
    expect(result.blocking.join(' ')).toContain('原地');
  });
});

describe('D5 阶段机：证据门禁 fail-closed', () => {
  it('缺证据必须阻断，blocking 逐项给出中文补证方法', () => {
    const result = advance('概念', '需求', {});
    expect(result.allowed).toBe(false);
    expect(result.missingEvidence).toEqual(['requirementsConfirmed']);
    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]).toContain('缺少证据「需求已确认」');
    expect(result.blocking[0]).toContain('需求页');
    expect(result.reason).toContain('缺少 1 项证据');
  });

  it('证据为 false / undefined 都按缺失处理，绝不因字段存在就放行', () => {
    expect(advance('选型', '原理图', { bomApproved: false }).allowed).toBe(false);
    expect(advance('选型', '原理图', { bomApproved: undefined }).allowed).toBe(false);
    expect(advance('选型', '原理图', {}).allowed).toBe(false);
    expect(advance('选型', '原理图', { bomApproved: true }).allowed).toBe(true);
  });

  it('多项证据只满足一部分时，只列出真正缺失的项', () => {
    const result = advance('原理图', 'PCB', { netlistApproved: true, schematicGenerated: false });
    expect(result.allowed).toBe(false);
    expect(result.missingEvidence).toEqual(['schematicGenerated']);
    expect(result.blocking.join(' ')).toContain('原理图已生成');
    expect(result.blocking.join(' ')).not.toContain('网表已人工批准');
  });
});

describe('D5 阶段机：未知阶段与证据字段契约', () => {
  it('未知当前阶段/未知目标阶段都拒绝，不猜测', () => {
    const unknownFrom = evaluateStageAdvance({ from: '需求评审中', to: '需求', evidence: fullEvidence });
    expect(unknownFrom.allowed).toBe(false);
    expect(unknownFrom.from).toBeNull();
    expect(unknownFrom.blocking.join(' ')).toContain('未知当前阶段');

    const unknownTo = evaluateStageAdvance({ from: '概念', to: '直接投产', evidence: fullEvidence });
    expect(unknownTo.allowed).toBe(false);
    expect(unknownTo.to).toBeNull();
    expect(unknownTo.blocking.join(' ')).toContain('未知目标阶段');
  });

  it('证据字段固定为六项，每项都有中文名与补证说明', () => {
    expect(STAGE_EVIDENCE_KEYS).toEqual([
      'requirementsConfirmed', 'bomApproved', 'netlistApproved', 'schematicGenerated', 'pcbPlaced', 'drcPassed',
    ]);
    expect(STAGE_EVIDENCE_DEFINITIONS.map((item) => item.key)).toEqual(STAGE_EVIDENCE_KEYS);
    for (const definition of STAGE_EVIDENCE_DEFINITIONS) {
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.hint.length).toBeGreaterThan(0);
      expect(evidenceLabel(definition.key)).toBe(definition.label);
    }
  });

  it('evaluateStageAdvance 是纯函数：不改入参、不改动 STAGE_ORDER', () => {
    const evidence = Object.freeze({ ...fullEvidence });
    const before = JSON.stringify(evidence);
    const snapshot = [...STAGE_ORDER];
    advance('概念', '原理图', evidence);
    advance('概念', '需求', evidence);
    expect(JSON.stringify(evidence)).toBe(before);
    expect([...STAGE_ORDER]).toEqual(snapshot);
  });
});

describe('D5 阶段机：与旧 5 值 ProjectStage 的兼容映射', () => {
  it('旧阶段读取时映射到 canonical：PCB布局→PCB，其余同名直通', () => {
    expect(stageOfProjectStage('概念')).toBe('概念');
    expect(stageOfProjectStage('原理图')).toBe('原理图');
    expect(stageOfProjectStage('PCB布局')).toBe('PCB');
    expect(stageOfProjectStage('验证')).toBe('验证');
    expect(stageOfProjectStage('归档')).toBe('归档');
  });

  it('canonical 8 阶段值可直接读回；未知值返回 null（不猜测）', () => {
    for (const stage of STAGE_ORDER) expect(stageOfProjectStage(stage)).toBe(stage);
    expect(stageOfProjectStage('随便写的阶段')).toBeNull();
    expect(stageOfProjectStage('')).toBeNull();
  });

  it('P0-3：工程进度由阶段派生（不再依赖会脱节的 project.progress）', () => {
    expect(stageProgress('概念')).toBe(0);
    expect(stageProgress('选型')).toBe(29);
    expect(stageProgress('PCB')).toBe(57);
    expect(stageProgress('归档')).toBe(100);
    expect(stageProgress('未知阶段')).toBe(0);
  });

  it('兼容桥能把 canonical 值写回项目记录（等 types.ts 扩展后删除该桥）', () => {
    expect(String(projectStageValue('需求'))).toBe('需求');
    expect(String(projectStageValue('PCB'))).toBe('PCB');
    expect(stageOfProjectStage(projectStageValue('生产'))).toBe('生产');
  });
});
