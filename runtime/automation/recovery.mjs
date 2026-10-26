/**
 * E7：重启后"未完成 run"的恢复分析（只读 + fail-closed）。
 *
 * 为什么不是"启动时自动重放"：自动化配方里有写动作，重放写动作可能造成重复落板/重复铺铜。
 * 所以恢复分两层：
 *   1. 发现（只读）：启动/刷新时扫描 journal，找出没有终态事件的 run，给出可诊断的结论；
 *   2. 重放（显式）：只允许"全程只读"的中断 run 一键安全重放；任何已发出写动作的 run
 *      一律标记 needs_human，必须先人工读回确认现场，绝不自动重放。
 *
 * 终态事件：run.end（完成）、run.abort（中止）、run.paused（等参数/等批准/等人工）、
 * run.rollback（失败已回退）、step.failed（失败且策略为 abort，无后续事件）、
 * run.recovered（中断 run 已被显式安全重放收敛）。
 * 注意：`step.failed` 之后如果还有 `run.rollback`，以最后一条为准。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TERMINAL_PHASES = new Set(['run.end', 'run.abort', 'run.paused', 'run.rollback', 'step.failed', 'run.recovered']);
const MAX_RUNS = 200;
const MAX_ENTRIES = 5000;

export const RECOVERY_VERDICTS = Object.freeze({
  READONLY_REPLAYABLE: 'readonly_replayable',
  NEEDS_HUMAN: 'needs_human',
  UNKNOWN_RECIPE: 'unknown_recipe',
  CORRUPT: 'corrupt',
  FINISHED: 'finished',
});

function readEntries(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** 判断一个配方是否"全程只读"（没有写动作、没有兜底 GUI 点击、没有人工步骤）。 */
function isReadonlyRecipe(recipe) {
  if (!recipe) return false;
  if ((recipe.requiredApprovals || []).some((scope) => scope === 'write' || scope === 'release')) return false;
  return (recipe.steps || []).every((step) => step.action?.kind === 'api'
    && step.action.allowWrite !== true
    && !step.fallback
    && step.action.kind !== 'human')
    && (recipe.steps || []).every((step) => !step.approval);
}

/**
 * 分析一个 run 的 journal 记录。
 * @returns {{runId,recipeId,recipeTitle,terminal,lastPhase,lastAt,entries,completedSteps,currentStep,writeStarted,verdict,reason}}
 */
export function analyzeRunEntries(entries, { registry = null, runId = null } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { runId, recipeId: null, terminal: false, lastPhase: null, entries: 0, completedSteps: [], currentStep: null, writeStarted: false, verdict: RECOVERY_VERDICTS.CORRUPT, reason: 'journal 为空或不是数组' };
  }
  const first = entries[0];
  const last = entries[entries.length - 1];
  const id = runId || String(first.runId || '').slice(0, 80) || null;
  const recipeId = String(first.recipeId || last.recipeId || '') || null;
  const recipe = registry && recipeId ? registry.get(recipeId) : null;
  const stepDefs = new Map((recipe?.steps || []).map((step) => [step.id, step]));
  const terminal = TERMINAL_PHASES.has(last.phase);
  const writeStarted = entries.some((entry) => entry.phase === 'attempt' && entry.ok === true
      && entry.stepId && stepDefs.get(entry.stepId)?.action?.allowWrite === true)
    || entries.some((entry) => entry.phase === 'fallback.action');
  const completedSteps = entries.filter((entry) => entry.phase === 'step.verified').map((entry) => entry.stepId).filter(Boolean);
  const stepStarts = entries.filter((entry) => entry.phase === 'step.start');
  const currentStep = stepStarts.length ? stepStarts[stepStarts.length - 1].stepId ?? null : null;

  let verdict = RECOVERY_VERDICTS.READONLY_REPLAYABLE;
  let reason = '中断的 run 全程只读，可安全重放';
  if (terminal) {
    verdict = RECOVERY_VERDICTS.FINISHED;
    reason = `已有终态事件：${last.phase}`;
  } else if (!recipe) {
    verdict = RECOVERY_VERDICTS.UNKNOWN_RECIPE;
    reason = `配方不在当前注册表：${recipeId ?? 'unknown'}（可能版本变更），需人工确认`;
  } else if (writeStarted) {
    verdict = RECOVERY_VERDICTS.NEEDS_HUMAN;
    reason = '中断前已发出写动作，重放可能重复落板/重复铺铜；必须先人工读回现场确认';
  } else if (!isReadonlyRecipe(recipe)) {
    verdict = RECOVERY_VERDICTS.NEEDS_HUMAN;
    reason = '配方含写/人工/GUI 兜底步骤，无法判定现场是否已改变，需人工确认';
  }

  return {
    runId: id,
    recipeId,
    recipeTitle: recipe?.title ?? null,
    terminal,
    lastPhase: last.phase ?? null,
    lastAt: last.at ?? null,
    entries: entries.length,
    completedSteps,
    currentStep,
    writeStarted,
    verdict,
    reason,
  };
}

/**
 * 扫描 journal 目录，找出未完成 run。目录不存在 → available:false + reason（不返回假空列表）。
 * 单个坏文件不拖垮整体，但会作为 corrupt 条目显式列出（不静默跳过）。
 */
export function findInterruptedRuns({ dir, registry = null, limit = 20 } = {}) {
  if (!dir || !existsSync(dir)) return { available: false, reason: `journal 目录不存在：${dir ?? '(未配置)'}`, scanned: 0, runs: [] };
  let files = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).slice(0, MAX_RUNS);
  } catch (error) {
    return { available: false, reason: `journal 目录不可读：${error?.message || error}`, scanned: 0, runs: [] };
  }
  const runs = [];
  const corrupt = [];
  for (const file of files) {
    const runId = file.replace(/\.jsonl$/, '');
    try {
      const entries = readEntries(join(dir, file)).slice(0, MAX_ENTRIES);
      // journal 目录同时存放批准账本（approval-*.jsonl）；只分析真正的 run 记录。
      if (!entries.length || entries[0].phase !== 'run.start' || !entries[0].recipeId) continue;
      const analysis = analyzeRunEntries(entries, { registry, runId });
      if (!analysis.terminal && analysis.verdict !== RECOVERY_VERDICTS.FINISHED) runs.push(analysis);
    } catch (error) {
      corrupt.push({ runId, verdict: RECOVERY_VERDICTS.CORRUPT, reason: `journal 无法解析：${String(error?.message || error).slice(0, 200)}` });
    }
  }
  runs.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  return {
    available: true,
    scanned: files.length,
    runs: [...runs.slice(0, Math.max(1, Math.min(50, limit))), ...corrupt.slice(0, 10)],
    corrupt: corrupt.length,
  };
}

/** 判定是否允许显式重放：只有 readonly_replayable 允许，其它一律拒绝并给出原因。 */
export function canReplay(analysis) {
  if (!analysis) return { ok: false, verdict: RECOVERY_VERDICTS.CORRUPT, reason: '没有可用的恢复分析' };
  if (analysis.verdict === RECOVERY_VERDICTS.READONLY_REPLAYABLE) return { ok: true };
  return { ok: false, verdict: analysis.verdict, reason: analysis.reason };
}
