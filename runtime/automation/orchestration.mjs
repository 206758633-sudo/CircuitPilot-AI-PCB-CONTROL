/**
 * E10：AI 决策层编排（确定性、可解释、人审）。
 *
 * 边界先说清楚：
 *   - 这里不是"让模型自由点界面"。目标 → 配方序列是**确定性映射**：目标关键词 → 预定义 profile →
 *     已登记配方 + 显式 gate 节点（DRC/导出/人审等不在自动化配方里的步骤如实标成 gate）；
 *   - 任何写步骤都需要 write 批准，编排只出计划，**不代替批准、不自动执行**；
 *   - 失败恢复决策只给建议：读步骤可重试；写步骤一旦可能已发出，一律 needs_human_inspection，
 *     **永不自动重放写动作**（与 E7/E1 的安全纪律一致）；
 *   - 预算按"配方数/写配方数/预计秒数"控制；token 预算不在此层做（没有可信的 token 计量），
 *     计划里显式注明 tokenBudget: 'not-accounted'，不假装有 token 控制。
 */
import crypto from 'node:crypto';
import { inferRecipeParams } from './params-inference.mjs';

export const ORCHESTRATION_CODES = Object.freeze({
  GOAL_INVALID: 'E10_GOAL_INVALID',
  GOAL_UNSUPPORTED: 'E10_GOAL_UNSUPPORTED',
  BUDGET_INVALID: 'E10_BUDGET_INVALID',
  BUDGET_EXCEEDED: 'E10_BUDGET_EXCEEDED',
  STAGE_INVALID: 'E10_STAGE_INVALID',
});

export const DEFAULT_BUDGET = Object.freeze({ maxRecipes: 8, maxWriteRecipes: 2, maxEstimatedSeconds: 600 });

const text = (value) => String(value ?? '').trim();
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** 每个配方按阶段估算秒数（粗粒度、显式声明是估算，不作为 SLA）。 */
const RECIPE_SECONDS = Object.freeze({
  'eda-read-state': 5,
  'eda-read-project': 5,
  'eda-read-document': 5,
  'eda-screenshot-evidence': 8,
  'eda-open-project': 20,
  'pcb-sync-from-schematic': 45,
  'pcb-rebuild-pours': 60,
  'pcb-create-pour': 60,
});

/**
 * 目标 profile 表。新增目标必须同时补 gate 与安全说明，不允许"猜一个配方就算编排"。
 */
const GOAL_PROFILES = Object.freeze([
  {
    id: 'netlist-to-drc',
    label: '网表 → PCB 同步 → 读回 → 官方 DRC 人审',
    matches: [/网表/, /drc/i, /同步.*pcb/i, /pcb.*同步/i],
    nodes: [
      { id: 'read-project', recipeId: 'eda-read-project', stage: 'read', reason: '先确认 EDA 当前工程，防止在错误工程上写' },
      { id: 'read-document', recipeId: 'eda-read-document', stage: 'read', dependsOn: ['read-project'], reason: '确认活动文档是目标 PCB 页' },
      { id: 'write-sync', recipeId: 'pcb-sync-from-schematic', stage: 'write', dependsOn: ['read-document'], reason: '把原理图变更同步到 PCB（需要一次性写板批准）' },
      { id: 'readback', recipeId: 'eda-screenshot-evidence', stage: 'verify', dependsOn: ['write-sync'], reason: '写后采集截图证据；具体状态以 Runtime 读回为准' },
      { id: 'gate-drc', kind: 'gate', gateId: 'official-drc', stage: 'verify', dependsOn: ['readback'], reason: 'DRC 在验证页用官方报告取证，不是配方；计划不替代 DRC 证据' },
      { id: 'gate-human-review', kind: 'gate', gateId: 'human-review', stage: 'gate', dependsOn: ['gate-drc'], reason: '人审通过后才考虑导出/收工；编排不做放行决定' },
    ],
  },
  {
    id: 'pour-rebuild',
    label: '重建铺铜 → 读回 → 人审',
    matches: [/重建.*铺铜/, /铺铜.*重建/, /rebuild.*pour/i, /重新铺铜/],
    nodes: [
      { id: 'read-document', recipeId: 'eda-read-document', stage: 'read', reason: '确认目标 PCB 文档' },
      { id: 'write-rebuild', recipeId: 'pcb-rebuild-pours', stage: 'write', dependsOn: ['read-document'], reason: '重建全部铺铜（需要一次性写板批准）' },
      { id: 'readback', recipeId: 'eda-screenshot-evidence', stage: 'verify', dependsOn: ['write-rebuild'], reason: '写后截图证据；铺铜数量/属性以读回断言为准' },
      { id: 'gate-human-review', kind: 'gate', gateId: 'human-review', stage: 'gate', dependsOn: ['readback'], reason: '铺铜属写操作，人审确认后再继续' },
    ],
  },
  {
    id: 'pour-create',
    label: '新建覆铜 → 读回 → 人审',
    matches: [/新建.*覆铜/, /新建.*铺铜/, /create.*pour/i],
    nodes: [
      { id: 'read-document', recipeId: 'eda-read-document', stage: 'read', reason: '确认目标 PCB 文档' },
      { id: 'write-create', recipeId: 'pcb-create-pour', stage: 'write', dependsOn: ['read-document'], reason: '按板框新建覆铜（需要一次性写板批准）' },
      { id: 'readback', recipeId: 'eda-screenshot-evidence', stage: 'verify', dependsOn: ['write-create'], reason: '写后截图证据；铺铜数量/属性以读回断言为准' },
      { id: 'gate-human-review', kind: 'gate', gateId: 'human-review', stage: 'gate', dependsOn: ['readback'], reason: '写操作后必须人审' },
    ],
  },
  {
    id: 'read-only-evidence',
    label: '只读现状 + 截图证据',
    matches: [/只读/, /读取/, /证据/, /截图/, /现状/],
    nodes: [
      { id: 'read-project', recipeId: 'eda-read-project', stage: 'read', reason: '读取工程' },
      { id: 'read-document', recipeId: 'eda-read-document', stage: 'read', dependsOn: ['read-project'], reason: '读取活动文档' },
      { id: 'read-state', recipeId: 'eda-read-state', stage: 'read', dependsOn: ['read-document'], reason: '读取页面状态' },
      { id: 'evidence', recipeId: 'eda-screenshot-evidence', stage: 'verify', dependsOn: ['read-state'], reason: '采集截图证据（只读）' },
    ],
  },
]);

function normalizeBudget(input) {
  if (input === undefined || input === null) return { ...DEFAULT_BUDGET };
  if (typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('budget 必须是对象'), { code: ORCHESTRATION_CODES.BUDGET_INVALID });
  const budget = { ...DEFAULT_BUDGET };
  const minimums = { maxRecipes: 1, maxWriteRecipes: 0, maxEstimatedSeconds: 1 };
  for (const key of ['maxRecipes', 'maxWriteRecipes', 'maxEstimatedSeconds']) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < minimums[key] || value > 10_000) {
      throw Object.assign(new Error(`budget.${key} 必须是 ${minimums[key]}-10000 的整数`), { code: ORCHESTRATION_CODES.BUDGET_INVALID });
    }
    budget[key] = value;
  }
  return budget;
}

/**
 * 目标 → 配方序列计划。未知目标 fail-closed：不猜、不返回伪计划。
 */
export function planOrchestration({ goal, budget, recipes = [], evidence = null } = {}) {
  const goalText = text(goal);
  if (!goalText) throw Object.assign(new Error('goal 不能为空：请描述要达成的目标（例如"把这块板从网表同步到 PCB 并跑 DRC"）'), { code: ORCHESTRATION_CODES.GOAL_INVALID });
  if (goalText.length > 500) throw Object.assign(new Error('goal 太长（上限 500 字）'), { code: ORCHESTRATION_CODES.GOAL_INVALID });
  const normalizedBudget = normalizeBudget(budget);
  const available = new Set((Array.isArray(recipes) ? recipes : []).map((recipe) => recipe?.id).filter(Boolean));
  const profile = GOAL_PROFILES.find((item) => item.matches.some((pattern) => pattern.test(goalText)));
  if (!profile) {
    throw Object.assign(new Error(`无法把目标映射到已登记配方（没有匹配的 profile）：${goalText}`), {
      code: ORCHESTRATION_CODES.GOAL_UNSUPPORTED,
      details: { supported: GOAL_PROFILES.map((item) => ({ id: item.id, label: item.label })), hint: '目标必须能对应到已登记配方 + 显式 gate；未覆盖的目标应人工编排并补充配方' },
    });
  }
  const nodes = profile.nodes.map((node) => {
    // E10.2：参数推断只在调用方提供只读证据时进行；没证据就保持空参数并显式标记，
    // 绝不填"大概值"；证据不全时写步骤计划会被阻断（params blockers），不返回可执行假象。
    const inference = node.recipeId && evidence ? inferRecipeParams({ recipeId: node.recipeId, evidence }) : null;
    return {
      id: node.id,
      kind: node.kind === 'gate' ? 'gate' : 'recipe',
      gateId: node.kind === 'gate' ? node.gateId : null,
      recipeId: node.recipeId || null,
      stage: node.stage,
      dependsOn: Array.isArray(node.dependsOn) ? [...node.dependsOn] : [],
      approvalRequired: node.stage === 'write',
      params: inference?.ok ? inference.params : {},
      paramsInference: inference
        ? { ok: inference.ok, code: inference.code, message: inference.message, sources: inference.sources, missing: inference.missing, notes: inference.notes }
        : { ok: null, status: 'not-provided', message: '未提供只读证据：参数为空，运行前必须人工补齐；编排不猜参数' },
      expectedEvidence: node.stage === 'write'
      ? '写后读回断言 + before/after 截图摘要（见 E11 审计包）'
      : node.kind === 'gate'
        ? 'gate 证据由对应页面产生（官方 DRC/人审），本编排不替代'
        : '只读状态/截图证据',
      reason: node.reason,
    };
  });
  // 依赖的配方必须在当前注册表里（失败即拒绝，不返回不可执行的计划）。
  const missingRecipes = nodes.filter((node) => node.kind === 'recipe' && !available.has(node.recipeId)).map((node) => node.recipeId);
  const usage = {
    recipes: nodes.filter((node) => node.kind === 'recipe').length,
    writeRecipes: nodes.filter((node) => node.kind === 'recipe' && node.stage === 'write').length,
    estimatedSeconds: nodes.reduce((sum, node) => sum + (node.kind === 'gate' ? 30 : (RECIPE_SECONDS[node.recipeId] ?? 30)), 0),
  };
  const blockers = [];
  if (missingRecipes.length) blockers.push({ code: 'ORCHESTRATION_RECIPE_MISSING', message: `计划引用了未登记配方：${[...new Set(missingRecipes)].join('、')}` });
  // E10.2：提供了证据但参数推断不全 → 写步骤计划阻断（read/verify 节点允许继续只读，但计划整体不可执行）。
  const paramsMissing = nodes.filter((node) => node.kind === 'recipe' && node.paramsInference?.ok === false);
  if (paramsMissing.length) {
    blockers.push({
      code: 'E10_PARAMS_EVIDENCE_MISSING',
      message: `参数证据不足，计划不可执行：${paramsMissing.map((node) => `${node.recipeId}[${node.paramsInference.missing.join('、')}]`).join('；')}`,
      nodes: paramsMissing.map((node) => node.id),
    });
  }
  if (usage.recipes > normalizedBudget.maxRecipes) blockers.push({ code: ORCHESTRATION_CODES.BUDGET_EXCEEDED, message: `配方数 ${usage.recipes} 超过预算 ${normalizedBudget.maxRecipes}` });
  if (usage.writeRecipes > normalizedBudget.maxWriteRecipes) blockers.push({ code: ORCHESTRATION_CODES.BUDGET_EXCEEDED, message: `写配方数 ${usage.writeRecipes} 超过预算 ${normalizedBudget.maxWriteRecipes}` });
  if (usage.estimatedSeconds > normalizedBudget.maxEstimatedSeconds) blockers.push({ code: ORCHESTRATION_CODES.BUDGET_EXCEEDED, message: `预计 ${usage.estimatedSeconds}s 超过预算 ${normalizedBudget.maxEstimatedSeconds}s` });
  const plan = {
    ok: blockers.length === 0,
    planId: sha256(JSON.stringify({ goal: goalText, profile: profile.id, nodes: nodes.map((node) => [node.id, node.recipeId, node.dependsOn]), budget: normalizedBudget })),
    goal: goalText,
    profile: { id: profile.id, label: profile.label },
    nodes,
    budget: {
      limits: normalizedBudget,
      usage,
      ok: blockers.length === 0,
      blockers,
      estimateBasis: '按配方步骤数的粗粒度估算（read≈5s、write≈45-60s、gate≈30s），不是 SLA',
      tokenBudget: 'not-accounted',
      note: '本层不做 token 计量：没有可信的 token 计数来源，不假装有 token 预算控制',
    },
    decisionLog: [
      { at: new Date().toISOString(), step: 'profile.match', detail: `命中 profile「${profile.label}」，共 ${nodes.length} 个节点（${usage.writeRecipes} 个写步骤）` },
      { at: new Date().toISOString(), step: 'budget.check', detail: blockers.length ? `预算/完整性未通过：${blockers.map((item) => item.message).join('；')}` : '预算与配方完整性检查通过' },
      { at: new Date().toISOString(), step: 'approval.policy', detail: '计划只供人审；写步骤必须另行签发一次性写板批准（本编排不会自动批准/执行）' },
    ],
    warnings: [
      '计划不自动执行：每个写步骤都需要人工签发一次性写板批准，批准绑定当前 EDA 窗口/工程/文档指纹',
      ...(nodes.some((node) => node.kind === 'gate') ? ['计划包含 gate 节点：官方 DRC/导出/人审由对应页面与证据链负责，编排不替代'] : []),
    ],
  };
  return plan;
}

/**
 * 失败分类 → 恢复决策（人审）。写步骤永不自动重放。
 */
export function decideFailureRecovery({ errorCode, stage, attempt = 1, planId = null, nodeId = null } = {}) {
  const codeText = text(errorCode);
  if (!codeText) throw Object.assign(new Error('errorCode 不能为空'), { code: ORCHESTRATION_CODES.STAGE_INVALID });
  const stageText = text(stage);
  if (!['read', 'write', 'verify', 'gate'].includes(stageText)) {
    throw Object.assign(new Error(`stage 必须是 read/write/verify/gate 之一：${stageText || '空'}`), { code: ORCHESTRATION_CODES.STAGE_INVALID });
  }
  const transient = new Set(['EDA_JOB_BUSY', 'BRIDGE_HTTP_ERROR', 'RUNTIME_TIMEOUT', 'EDA_GUI_CDP_TIMEOUT', 'EDA_REQUEST_ABANDONED']);
  const approvalRelated = new Set(['AUTOMATION_APPROVAL_INVALID', 'APPROVAL_EXPIRED', 'APPROVAL_MISMATCH', 'TARGET_DRIFT', 'APPROVAL_REPLAYED']);
  let decision;
  const explanation = [];
  if (stageText === 'gate') {
    decision = { action: 'needs_human', retryNodeId: null, requiresReapproval: false, autoReplayAllowed: false };
    explanation.push('gate 节点不是可自动恢复的执行：请到对应页面（DRC/导出/人审）补齐证据或做人工决定。');
  } else if (transient.has(codeText) && stageText !== 'write') {
    decision = { action: 'retry_same_node', retryNodeId: nodeId, requiresReapproval: false, autoReplayAllowed: false, maxAttempts: 2 };
    explanation.push(`错误码 ${codeText} 属于暂时性/资源类失败，只读阶段可重试（建议退避后重试 1-2 次）。`);
  } else if (approvalRelated.has(codeText)) {
    decision = { action: 'needs_reapproval', retryNodeId: null, requiresReapproval: true, autoReplayAllowed: false };
    explanation.push(`错误码 ${codeText} 说明批准/目标指纹已失效：重新读回现场后重新签发一次性写板批准，不能复用旧批准。`);
  } else if (stageText === 'write') {
    decision = { action: 'needs_human_inspection', retryNodeId: null, requiresReapproval: true, autoReplayAllowed: false };
    explanation.push('写阶段失败：动作可能已部分或全部生效。必须先读回现场（PCB 状态/位号/铺铜）确认，再决定重试或回滚；写动作永不自动重放。');
  } else if (transient.has(codeText)) {
    decision = { action: 'retry_same_node', retryNodeId: nodeId, requiresReapproval: false, autoReplayAllowed: false, maxAttempts: 2 };
    explanation.push(`错误码 ${codeText} 属于暂时性失败，可重试（最多 ${decision.maxAttempts} 次）。`);
  } else {
    decision = { action: 'needs_human_inspection', retryNodeId: null, requiresReapproval: false, autoReplayAllowed: false };
    explanation.push(`错误码 ${codeText} 未归类为可自动恢复：先看失败诊断的建议与证据，再人工决定。`);
  }
  if (Number(attempt) > 2) {
    decision = { ...decision, action: 'needs_human_inspection', autoReplayAllowed: false };
    explanation.push(`已尝试 ${attempt} 次：重复失败优先升级人工排查，避免循环重试掩盖真实问题。`);
  }
  return {
    ok: true,
    errorCode: codeText,
    stage: stageText,
    planId: planId ? text(planId) : null,
    nodeId: nodeId ? text(nodeId) : null,
    decision,
    explanation,
    policy: '写动作永不自动重放；任何自动重试都只允许发生在只读/校验阶段',
    humanReviewRequired: decision.action !== 'retry_same_node',
  };
}

export function listGoalProfiles() {
  return GOAL_PROFILES.map((profile) => ({ id: profile.id, label: profile.label }));
}
