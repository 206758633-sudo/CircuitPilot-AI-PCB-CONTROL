/**
 * D5 阶段机：项目阶段的确定性推进 + 证据门禁。
 *
 * 设计原则（fail-closed）：
 * - 纯函数：不读 localStorage、不写 EDA、不改全局状态，只根据入参返回判断结果；
 * - 只认显式证据：证据缺失、false、undefined、未知字段一律视为"没有证据"，宁可阻断也不放行；
 * - 只允许相邻正向推进：跳级、回退、原地推进全部阻断（回退/标脏必须走受控变更并留审计，
 *   不能靠直接改阶段字段掩盖真实进度）；
 * - reason / blocking 全部中文，可直接展示给用户；
 *
 * 重要边界：前端（ProjectsPage）只是**提前提示**。一次推进是否真的成立，
 * 真正权威的是 Runtime 侧落盘的审批令牌、执行回读结果、DRC 报告与证据摘要；
 * UI 状态被篡改或 localStorage 过期时，Runtime 证据才是最终闸门。
 */
import type { ProjectStage } from '../types';

/** D5 的 8 个 canonical 阶段（只允许按此顺序相邻推进）。 */
export const STAGE_ORDER = ['概念', '需求', '选型', '原理图', 'PCB', '验证', '生产', '归档'] as const;

export type Stage = (typeof STAGE_ORDER)[number];

/**
 * P0-3：工程进度由阶段派生，而不是另存一个会与阶段脱节的 `project.progress`。
 * 旧实现里 progress 只在 seed/新建项目时写一次，阶段推进后仍显示旧百分比（例如已到「验证」还显示 68%）。
 */
export const stageProgress = (stage: string | null | undefined): number => {
  const index = STAGE_ORDER.indexOf((stage ?? '概念') as Stage);
  if (index < 0) return 0;
  return Math.round((index / (STAGE_ORDER.length - 1)) * 100);
};

/** 阶段证据字段：缺证据必须阻断。 */
export const STAGE_EVIDENCE_KEYS = [
  'requirementsConfirmed',
  'bomApproved',
  'netlistApproved',
  'schematicGenerated',
  'pcbPlaced',
  'drcPassed',
] as const;

export type StageEvidenceKey = (typeof STAGE_EVIDENCE_KEYS)[number];

/** 证据显式布尔值；undefined/false 都按"缺失"处理（fail-closed）。 */
export type StageEvidence = Partial<Record<StageEvidenceKey, boolean>>;

export interface StageEvidenceDefinition {
  key: StageEvidenceKey;
  /** 中文短名，用于阻断提示。 */
  label: string;
  /** 证据从哪来、怎么补，避免只告诉用户"缺证据"却不说怎么办。 */
  hint: string;
}

export const STAGE_EVIDENCE_DEFINITIONS: readonly StageEvidenceDefinition[] = Object.freeze([
  {
    key: 'requirementsConfirmed',
    label: '需求已确认',
    hint: '需求页：全部受控需求置为“已确认”；存在待确认/冲突需求即视为缺失。',
  },
  {
    key: 'bomApproved',
    label: 'BOM/选型已批准',
    hint: 'BOM/选型页：当前项目全部器件状态为 approved；risk/pending 即视为缺失。',
  },
  {
    key: 'netlistApproved',
    label: '网表已人工批准',
    hint: 'Runtime 网表审批：人工批准的一次性令牌 + 计划哈希；前端读不到该证据时按缺失处理。',
  },
  {
    key: 'schematicGenerated',
    label: '原理图已生成',
    hint: 'EDA 页：受控执行 completed 且回读通过后，edaWorkspace.schematicStatus = generated。',
  },
  {
    key: 'pcbPlaced',
    label: 'PCB 布局已完成',
    hint: '布局页/Runtime：真实写回并回读确认器件位置；AppContext 未持久化的字段不得臆测为已完成。',
  },
  {
    key: 'drcPassed',
    label: 'DRC 已通过',
    hint: '验证页：EDA 原生 DRC 报告（source=official）结论 pass；Demo/本地模拟结果不算证据。',
  },
]);

const EVIDENCE_DEFINITION_BY_KEY = new Map<StageEvidenceKey, StageEvidenceDefinition>(
  STAGE_EVIDENCE_DEFINITIONS.map((definition) => [definition.key, definition]),
);

/**
 * 每个相邻推进所需的证据（键为 `${from}->${to}`）。
 * 生产→归档是显式终止动作，不声明新的工程进度，因此不额外要求证据；
 * 归档是否允许仍由项目页现有的归档流程（确认框 + 审计）负责。
 */
const TRANSITION_EVIDENCE: Readonly<Record<string, readonly StageEvidenceKey[]>> = Object.freeze({
  '概念->需求': ['requirementsConfirmed'],
  '需求->选型': ['requirementsConfirmed'],
  '选型->原理图': ['bomApproved'],
  '原理图->PCB': ['netlistApproved', 'schematicGenerated'],
  'PCB->验证': ['pcbPlaced'],
  '验证->生产': ['drcPassed'],
  '生产->归档': [],
});

export interface StageAdvanceInput {
  from: string;
  to: string;
  /** 证据只认 true；undefined/false 均按缺失处理。 */
  evidence?: StageEvidence;
}

export interface StageAdvanceResult {
  allowed: boolean;
  /** 解析成功后的 canonical 阶段；未知阶段为 null。 */
  from: Stage | null;
  to: Stage | null;
  /** 中文结论，可直接展示或写入审计。 */
  reason: string;
  /** 逐条中文阻断原因。 */
  blocking: string[];
  requiredEvidence: StageEvidenceKey[];
  missingEvidence: StageEvidenceKey[];
}

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGE_ORDER as readonly string[]).includes(value);
}

/** 下一阶段；已是终态或未知阶段返回 null（调用方必须自行做阻断提示）。 */
export function nextStage(stage: Stage): Stage | null {
  const index = STAGE_ORDER.indexOf(stage);
  if (index < 0 || index >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[index + 1];
}

/**
 * 每个相邻推进要求哪些证据；非相邻推进返回空数组（由 evaluateStageAdvance 阻断）。
 * 暴露给页面做"下一阶段需要什么"的提示。
 */
export function requiredEvidenceFor(from: Stage, to: Stage): readonly StageEvidenceKey[] {
  return TRANSITION_EVIDENCE[`${from}->${to}`] ?? [];
}

export function evidenceLabel(key: StageEvidenceKey): string {
  return EVIDENCE_DEFINITION_BY_KEY.get(key)?.label ?? key;
}

export function evidenceHint(key: StageEvidenceKey): string {
  return EVIDENCE_DEFINITION_BY_KEY.get(key)?.hint ?? '';
}

const deny = (
  from: Stage | null,
  to: Stage | null,
  reason: string,
  blocking: string[],
  requiredEvidence: StageEvidenceKey[] = [],
  missingEvidence: StageEvidenceKey[] = [],
): StageAdvanceResult => ({ allowed: false, from, to, reason, blocking, requiredEvidence, missingEvidence });

/**
 * 判定一次阶段推进是否允许。
 *
 * 检查顺序：未知当前阶段 → 未知目标阶段 → 原地 → 回退 → 跳级 → 证据要求定义 → 证据缺失。
 * 任何一步不成立都返回 allowed:false，并给出中文 blocking 列表。
 */
export function evaluateStageAdvance(input: StageAdvanceInput): StageAdvanceResult {
  const rawFrom = String(input.from ?? '');
  const rawTo = String(input.to ?? '');
  const evidence: StageEvidence = input.evidence ?? {};

  if (!isStage(rawFrom)) {
    return deny(null, isStage(rawTo) ? rawTo : null,
      `阻断：未知的当前阶段「${rawFrom}」，阶段机只接受：${STAGE_ORDER.join('、')}。`,
      [`未知当前阶段「${rawFrom}」，无法判断阶段顺序与证据门禁。`]);
  }
  const from = rawFrom;

  if (!isStage(rawTo)) {
    return deny(from, null,
      `阻断：未知的目标阶段「${rawTo}」，阶段机只接受：${STAGE_ORDER.join('、')}。`,
      [`未知目标阶段「${rawTo}」，不能据此改变项目阶段。`]);
  }
  const to = rawTo;

  const fromIndex = STAGE_ORDER.indexOf(from);
  const toIndex = STAGE_ORDER.indexOf(to);

  if (fromIndex === toIndex) {
    return deny(from, to,
      `阻断：目标阶段与当前阶段相同（${from}），无需推进。`,
      [`原地推进不产生任何进度，已拒绝（${from}）。`]);
  }

  if (toIndex < fromIndex) {
    return deny(from, to,
      `阻断：阶段机不允许回退（${from} → ${to}）。`,
      [`不允许从「${from}」回退到「${to}」；如需回退/标脏，请走受控变更并写入审计，不允许直接改阶段掩盖进度。`]);
  }

  if (toIndex - fromIndex > 1) {
    const next = STAGE_ORDER[fromIndex + 1];
    return deny(from, to,
      `阻断：阶段机不允许跳级（${from} → ${to}），必须先完成「${next}」。`,
      [`不允许跳级：不能从「${from}」跳过「${next}」直接推进到「${to}」。`]);
  }

  const transitionKey = `${from}->${to}`;
  if (!Object.prototype.hasOwnProperty.call(TRANSITION_EVIDENCE, transitionKey)) {
    return deny(from, to,
      `阻断：阶段机缺少「${from} → ${to}」的证据要求定义，按 fail-closed 拒绝推进。`,
      [`未定义「${from} → ${to}」的证据要求；无法证明推进成立，拒绝放行。`]);
  }

  const requiredEvidence = [...requiredEvidenceFor(from, to)];
  const missingEvidence = requiredEvidence.filter((key) => evidence[key] !== true);
  if (missingEvidence.length > 0) {
    const labels = missingEvidence.map(evidenceLabel);
    return deny(from, to,
      `阻断：从「${from}」推进到「${to}」缺少 ${missingEvidence.length} 项证据（${labels.join('、')}）。`,
      missingEvidence.map((key) => `缺少证据「${evidenceLabel(key)}」：${evidenceHint(key)}`),
      requiredEvidence,
      missingEvidence);
  }

  const evidenceSummary = requiredEvidence.length > 0
    ? `证据齐备（${requiredEvidence.map(evidenceLabel).join('、')}）`
    : '该推进为显式终止，不要求新增工程证据';
  return {
    allowed: true,
    from,
    to,
    reason: `允许从「${from}」推进到「${to}」：${evidenceSummary}。`,
    blocking: [],
    requiredEvidence,
    missingEvidence: [],
  };
}

/** 旧 5 值 ProjectStage → canonical 8 阶段（只用于读取历史项目记录）。 */
const LEGACY_PROJECT_STAGE_TO_CANONICAL: Readonly<Record<string, Stage>> = Object.freeze({
  概念: '概念',
  原理图: '原理图',
  PCB布局: 'PCB',
  验证: '验证',
  归档: '归档',
});

/**
 * 读取项目记录的阶段：D5 canonical 值直接返回；旧 5 值做映射；未知值返回 null（不猜测）。
 */
export function stageOfProjectStage(projectStage: string): Stage | null {
  if (isStage(projectStage)) return projectStage;
  return LEGACY_PROJECT_STAGE_TO_CANONICAL[projectStage as ProjectStage] ?? null;
}

/**
 * canonical 阶段 → ProjectStage（已与 types.ts 的 8 阶段联合类型同构，不再需要断言）。
 * 保留函数只为让页面调用点统一走阶段机、避免别处再手写阶段字符串。
 */
export function projectStageValue(stage: Stage): ProjectStage {
  return stage;
}
