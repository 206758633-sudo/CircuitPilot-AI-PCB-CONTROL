/**
 * 配方执行器。
 *
 * 执行语义（fail-closed）：
 *   1. 参数预检：必填参数缺失 → `needs_params`，一步都不执行；
 *   2. 批准预检：缺批准 → `needs_approval`，一步都不执行；
 *   3. 每步动作后**必须**用只读通道读回并跑断言；读回失败/路径缺失/断言不符都算失败；
 *   4. API 优先、GUI 兜底：主通道失败或读回不符时，按配方的 fallback 动作序列兜底，再读回断言；
 *   5. 失败按 onFail 处理：focus 恢复 + 有限重试 → 仍失败则 abort / rollback / needs_human；
 *   6. 只有所有步骤都有读回证据且断言通过才返回 `completed`；
 *   7. 每一步（含失败尝试、兜底、恢复、回退）都写审计日志；日志写失败 → 整个 run 失败。
 *
 * 重试语义：
 *   - 动作报错 → 可重试（recover:['focus'] 会先拉回 EDA 窗口再重放）；
 *   - 读回不符 → 只重新读回，**不重放动作**（GUI 点击/输入不是幂等的）。
 */
import { randomUUID } from 'node:crypto';
import { validateRecipe } from './recipes.mjs';
import { evaluateAssertions, unwrapReadback } from './verify.mjs';
import { assertGuiActionAllowed, assertNotCheckoutTarget, assertSafeText, assertShortcutAllowed, collectRequiredApprovals } from './safety.mjs';
import { sha256Of } from './journal.mjs';

export const RUN_STATES = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  NEEDS_APPROVAL: 'needs_approval',
  NEEDS_PARAMS: 'needs_params',
  NEEDS_HUMAN: 'needs_human',
  ROLLBACK_FAILED: 'rollback_failed',
  ABORTED: 'aborted',
});

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 读回失败时记录"到底收到了什么形状"，避免只报"路径不存在"而无法定位桥/页面状态。 */
function describeState(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `object{${Object.keys(value).slice(0, 8).join(',')}}`;
  return typeof value;
}
const code = (message, name, extra = {}) => Object.assign(new Error(message), { code: name, ...extra });

function requireExecutor(executors, kind) {
  const executor = executors?.[kind];
  if (typeof executor !== 'function') throw code(`配方需要 ${kind} 执行器，但运行时没有注入`, 'AUTOMATION_EXECUTOR_MISSING', { kind });
  return executor;
}

/**
 * 解析 `{$param:'name'}`（配方参数）与 `{$result:'stepId.a.b'}`（本 run 中某步骤动作结果，
 * 目前只允许出现在回退动作里，用于"半写收敛"：例如删除本步骤刚创建的图元）。
 * 两类引用缺失都直接失败，不静默当 undefined。
 */
export function resolveParams(value, params = {}, trail = 'value', extras = {}) {
  if (Array.isArray(value)) return value.map((item, index) => resolveParams(item, params, `${trail}[${index}]`, extras));
  if (value && typeof value === 'object') {
    if (typeof value.$param === 'string') {
      const name = value.$param;
      if (!(name in params)) throw code(`缺少配方参数：${name}`, 'AUTOMATION_PARAM_REQUIRED', { param: name, trail });
      return params[name];
    }
    if (typeof value.$result === 'string') {
      const [stepId, ...segments] = value.$result.split('.');
      const results = extras.results || {};
      if (!(stepId in results)) throw code(`回退引用了没有结果的步骤：${stepId}`, 'AUTOMATION_ROLLBACK_RESULT_MISSING', { trail, stepId });
      let current = results[stepId];
      for (const segment of segments) {
        if (current === null || current === undefined || typeof current !== 'object' || !(segment in current)) {
          throw code(`回退结果路径不存在：${value.$result}`, 'AUTOMATION_ROLLBACK_RESULT_MISSING', { trail, path: value.$result });
        }
        current = current[segment];
      }
      return current;
    }
    const resolved = {};
    for (const [key, item] of Object.entries(value)) resolved[key] = resolveParams(item, params, `${trail}.${key}`, extras);
    return resolved;
  }
  return value;
}

function preflightGui(action, params = {}) {
  assertGuiActionAllowed(action);
  if (action === 'clickText') assertSafeText(params.text);
  if (params.target !== undefined) assertNotCheckoutTarget(params.target);
  if (action === 'shortcut' || action === 'key') assertShortcutAllowed({ key: params.key, modifiers: params.modifiers });
}

async function readbackStep(executors, readback, params) {
  if (readback.kind === 'compose') {
    const state = {};
    for (const [name, read] of Object.entries(readback.reads)) state[name] = await readbackStep(executors, read, params);
    return state;
  }
  const resolved = resolveParams(readback.params || {}, params, 'readback.params');
  if (readback.kind === 'api') {
    const result = await requireExecutor(executors, 'api')({ command: readback.command, params: resolved, allowWrite: false, readOnly: true });
    return unwrapReadback(result);
  }
  preflightGui(readback.action, resolved);
  const result = await requireExecutor(executors, 'gui')({ action: readback.action, params: resolved });
  return unwrapReadback(result);
}

async function executeAction(executors, action) {
  if (action.kind === 'api') {
    return requireExecutor(executors, 'api')({
      command: action.command,
      params: action.params || {},
      allowWrite: action.allowWrite === true,
      readOnly: action.allowWrite !== true,
    });
  }
  if (action.kind === 'gui') {
    preflightGui(action.action, action.params);
    return requireExecutor(executors, 'gui')({ action: action.action, params: action.params || {} });
  }
  throw code(`runRecipe 不支持直接执行 ${action.kind} 动作`, 'AUTOMATION_STEP_KIND_UNSUPPORTED', { kind: action.kind });
}

/**
 * 跑一个配方。
 * @param {object} options
 * @param {object} options.recipe 配方定义
 * @param {{api?:Function, gui?:Function, human?:Function}} options.executors
 * @param {object} [options.params] 运行参数（必填项来自 recipe.params）
 * @param {object} [options.approvals] { plan:true, write:true, release:true }
 * @param {object|null} [options.journal]
 * @param {string} [options.runId]
 * @param {Function|null} [options.assertWritesOpen] WP4 P1-11：写步骤执行前的写门禁回调；
 *   无参调用（可异步），抛错即视为“写入已暂停/被锁”，run 进入 aborted，不执行该步骤。
 */
export async function runRecipe({ recipe, executors = {}, params = {}, approvals = {}, approvalIds = [], approvalFingerprint = null, journal = null, runId = randomUUID(), signal = null, assertWritesOpen = null, now = () => new Date().toISOString(), sleep = defaultSleep } = {}) {
  const normalized = validateRecipe(recipe);
  const record = (payload) => {
    if (!journal) return null;
    try {
      return journal.append(runId, { at: now(), ...payload });
    } catch (error) {
      throw code(`审计日志写入失败：${error?.message || error}`, 'AUTOMATION_JOURNAL_FAILED', { cause: error?.code });
    }
  };
  // 中止语义（fail-closed）：
  //   - 只在“步骤边界”生效：进行中的动作/读回会完成，已完成的步骤保留并已读回；
  //   - 若中止请求发生在一个动作已发出、但还没读回验证时，返回 aborted 并显式标记
  //     `mayHaveTakenEffect`（写动作可能已落盘），不把它当成"什么都没发生"；
  //   - 回退（rollback）动作不受中止影响：失败收敛优先，避免半写状态被放弃。
  const abortRequested = () => Boolean(signal?.aborted);
  const abortResult = (where, extra = {}) => {
    const reason = typeof signal?.reason === 'string' ? signal.reason : (signal?.reason?.message ? String(signal.reason.message) : 'operator_requested');
    record({ ...base, ...where, phase: 'run.abort', reason, completedSteps: stepResults.length, ...extra });
    return { ok: false, state: RUN_STATES.ABORTED, runId, recipeId: normalized.id, aborted: { reason, stepId: where.stepId ?? null, stepIndex: where.stepIndex ?? null, completedSteps: stepResults.length, ...extra }, steps: stepResults };
  };

  // WP4 P1-11：在途暂停——每到一个**写步骤**（api allowWrite / GUI 写动作 / 声明了 write|release 批准）
  // 执行前回调 Runtime 写门禁。抛错 → run 进入 aborted（不是 failed/假成功），journal 记
  // `run.aborted_by_write_gate`；只读步骤不会被拦。
  // mayHaveTakenEffect 语义：本次 run 在之前是否已经**发出过**写动作（一旦动作发出就按“可能已落盘”
  // 保守处理，动作报错也不回收该标记），供恢复/半写收敛判断使用。
  const stepIsWrite = (step) => (
    step?.action?.allowWrite === true
    || step?.action?.write === true
    || step?.write === true
    || step?.approval === 'write'
    || step?.approval === 'release'
  );
  let writeMayHaveTakenEffect = false;
  const writeGateAbortResult = (where, error) => {
    const gateCode = error?.code || 'EDA_WRITE_PAUSED';
    const message = String(error?.message || error).slice(0, 400);
    const aborted = {
      reason: 'write_gate_paused',
      abortedByWriteGate: true,
      code: gateCode,
      message,
      stepId: where.stepId ?? null,
      stepIndex: where.stepIndex ?? null,
      completedSteps: stepResults.length,
      mayHaveTakenEffect: writeMayHaveTakenEffect,
      details: error?.details ?? null,
    };
    record({ ...base, ...where, phase: 'run.aborted_by_write_gate', ...aborted });
    return { ok: false, state: RUN_STATES.ABORTED, runId, recipeId: normalized.id, aborted, steps: stepResults };
  };

  const safeParams = params && typeof params === 'object' ? params : {};
  const base = { runId, recipeId: normalized.id, recipeVersion: normalized.version };
  const requiredParams = Object.entries(normalized.params || {})
    .filter(([name, spec]) => spec.required && (safeParams[name] === undefined || safeParams[name] === null || safeParams[name] === ''))
    .map(([name]) => name);
  record({ ...base, phase: 'run.start', paramsDigest: sha256Of(requiredParams.length ? {} : safeParams), requiredParams });
  if (requiredParams.length) {
    record({ ...base, phase: 'run.paused', reason: 'needs_params', missingParams: requiredParams });
    return { ok: false, state: RUN_STATES.NEEDS_PARAMS, runId, recipeId: normalized.id, missingParams: requiredParams, steps: [] };
  }
  // 参数格式校验（例如 UUID）
  for (const [name, spec] of Object.entries(normalized.params || {})) {
    if (spec.pattern && safeParams[name] !== undefined && safeParams[name] !== '') {
      const pattern = new RegExp(spec.pattern);
      if (!pattern.test(String(safeParams[name]))) {
        record({ ...base, phase: 'run.paused', reason: 'invalid_params', param: name });
        return { ok: false, state: RUN_STATES.NEEDS_PARAMS, runId, recipeId: normalized.id, invalidParams: [{ name, pattern: spec.pattern }], steps: [] };
      }
    }
  }
  const required = [...new Set([...(normalized.requiredApprovals || []), ...collectRequiredApprovals(normalized.steps)])];
  // E11：把本次运行使用的批准 id 与目标指纹写进审计链（批准 id 不是令牌原文，可安全记录）；
  // 这样"哪个批准放行了这次写"可被事后再核对，而不是只记 boolean。
  const safeApprovalIds = Array.isArray(approvalIds)
    ? approvalIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim().slice(0, 80)).slice(0, 20)
    : [];
  record({
    ...base,
    phase: 'run.start.approvals',
    requiredApprovals: required,
    approvals: Object.fromEntries(required.map((scope) => [scope, approvals[scope] === true])),
    approvalIds: safeApprovalIds,
    approvalFingerprint: typeof approvalFingerprint === 'string' && approvalFingerprint ? approvalFingerprint.slice(0, 80) : null,
  });
  const missingApprovals = required.filter((scope) => approvals[scope] !== true);
  if (missingApprovals.length) {
    record({ ...base, phase: 'run.paused', reason: 'needs_approval', missingApprovals });
    return { ok: false, state: RUN_STATES.NEEDS_APPROVAL, runId, recipeId: normalized.id, requiredApprovals: required, missingApprovals, steps: [] };
  }

  const stepResults = [];
  // 每步动作结果（供回退动作用 $result 引用做半写收敛）；只存内存，不落 journal 原文。
  const actionResults = {};
  if (abortRequested()) return abortResult({}, { phaseNote: 'before_first_step' });
  for (let index = 0; index < normalized.steps.length; index += 1) {
    const step = normalized.steps[index];
    const where = { stepId: step.id, stepIndex: index, title: step.title };
    if (abortRequested()) return abortResult(where, { phaseNote: 'at_step_boundary' });

    // WP4 P1-11：写步骤执行前的在途暂停检查（只读步骤不受影响）。
    if (stepIsWrite(step) && typeof assertWritesOpen === 'function') {
      try {
        await assertWritesOpen({
          runId,
          recipeId: normalized.id,
          stepId: step.id,
          stepIndex: index,
          kind: step.action.kind,
          command: step.action.kind === 'api' ? step.action.command : step.action.action,
          title: step.title,
        });
      } catch (error) {
        return writeGateAbortResult(where, error);
      }
    }

    // —— 人工步骤
    if (step.action.kind === 'human') {
      record({ ...base, ...where, phase: 'step.start', kind: 'human', action: step.action.action, instructions: step.action.instructions });
      if (typeof executors.human !== 'function') {
        record({ ...base, ...where, phase: 'step.paused', reason: 'needs_human' });
        return { ok: false, state: RUN_STATES.NEEDS_HUMAN, runId, recipeId: normalized.id, pausedStep: where, steps: stepResults };
      }
      let humanResult;
      try {
        humanResult = await executors.human({ step, action: step.action });
      } catch (error) {
        record({ ...base, ...where, phase: 'step.failed', reason: 'human_rejected', error: error?.message || String(error) });
        return { ok: false, state: RUN_STATES.FAILED, runId, recipeId: normalized.id, failedStep: { ...where, error: error?.message || String(error) }, steps: stepResults };
      }
      const verified = humanResult?.done === true;
      record({ ...base, ...where, phase: verified ? 'step.verified' : 'step.failed', kind: 'human', evidence: humanResult?.evidence ?? null });
      if (!verified) return { ok: false, state: RUN_STATES.FAILED, runId, recipeId: normalized.id, failedStep: where, steps: stepResults };
      stepResults.push({ stepId: step.id, ok: true, verified: true, kind: 'human' });
      continue;
    }

    record({ ...base, ...where, phase: 'step.start', kind: step.action.kind, action: step.action.kind === 'api' ? step.action.command : step.action.action, approval: step.approval, fallbackActions: step.fallback ? step.fallback.actions.length : 0 });
    // 写动作一旦要发出就按“可能已落盘”标记（动作报错也不回收），供后续 in-flight 暂停/恢复判断。
    if (stepIsWrite(step)) writeMayHaveTakenEffect = true;
    const maxAttempts = 1 + (step.onFail?.retries || 0);
    // 读回重试与动作重试分离：写动作绝不重放，读回可以只重读（配方可选 expect.readRetries）。
    const readAttempts = Math.max(1, step.expect?.readRetries ?? ((step.onFail?.retries || 0) + 1));
    let lastError = null;
    let lastFailures = null;
    let verified = false;
    let evidence = null;
    let attemptUsed = 0;
    // E11：写步骤的 before 截图在动作发出**之前**取，after 在验证通过后取；
    // 取不到就如实记 ok:false + 原因（不阻断执行，但证据缺口在 journal/报告里可见）。
    let beforeScreenshot = null;
    if (step.evidence?.screenshot) {
      try {
        const shot = await requireExecutor(executors, 'gui')({ action: 'screenshot', params: {} });
        const base64 = shot?.base64 || '';
        beforeScreenshot = {
          ok: true,
          bytes: shot?.bytes ?? null,
          sha256: base64 ? sha256Of(base64) : (shot?.sha256 ?? null),
          kind: shot?.kind ?? 'cdp',
          path: shot?.path ?? null,
          fallbackFrom: shot?.fallbackFrom ?? null,
        };
      } catch (error) {
        beforeScreenshot = { ok: false, error: error?.code || error?.message || String(error) };
      }
      record({ ...base, ...where, phase: 'step.evidence.before', ...beforeScreenshot });
    }

    const verifyOnce = async (strategy, readAttempt = 1) => {
      const state = await readbackStep(executors, step.expect.readback, safeParams);
      const assertions = resolveParams(step.expect.assertions, safeParams, 'expect.assertions');
      const evaluation = evaluateAssertions(assertions, state);
      if (evaluation.ok) {
        evidence = { strategy, stateDigest: sha256Of(state), checks: evaluation.checks.length };
        record({ ...base, ...where, phase: 'readback', attempt: readAttempt, strategy, ok: true, stateDigest: evidence.stateDigest });
        return true;
      }
      lastFailures = evaluation.checks.filter((check) => !check.ok);
      record({ ...base, ...where, phase: 'readback', attempt: readAttempt, strategy, ok: false, reason: 'readback_mismatch', stateDigest: sha256Of(state), stateShape: describeState(state), failures: lastFailures.map((check) => check.message) });
      return false;
    };

    // 阶段 A：主通道动作（API）
    let primaryActionOk = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptUsed = attempt;
      try {
        const action = { ...step.action, params: resolveParams(step.action.params || {}, safeParams, 'action.params') };
        const actionResult = await executeAction(executors, action);
        record({ ...base, ...where, phase: 'attempt', attempt, strategy: 'primary', ok: true, resultDigest: actionResult === undefined ? null : sha256Of(actionResult) });
        if (actionResult !== undefined) actionResults[step.id] = actionResult;
        primaryActionOk = true;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        record({ ...base, ...where, phase: 'attempt', attempt, strategy: 'primary', ok: false, error: { code: error?.code || null, message: String(error?.message || error).slice(0, 400) } });
        if (attempt >= maxAttempts) break;
        if (step.onFail?.recover?.includes('focus')) {
          try {
            await requireExecutor(executors, 'gui')({ action: 'focus', params: {} });
            record({ ...base, ...where, phase: 'recover', attempt, action: 'focus' });
          } catch (recoverError) {
            record({ ...base, ...where, phase: 'recover', attempt, action: 'focus', ok: false, error: String(recoverError?.message || recoverError).slice(0, 200) });
          }
        }
        await sleep(250 * attempt);
      }
    }

    // 动作已发出但中止请求到达：写动作可能已生效，标记后返回 aborted（不读回、不重放）。
    if (abortRequested() && primaryActionOk) {
      return abortResult(where, { mayHaveTakenEffect: writeMayHaveTakenEffect, phaseNote: 'after_action_before_readback' });
    }

    // 阶段 B：主通道读回（只重读，不重放动作）
    if (primaryActionOk) {
      for (let readAttempt = 1; readAttempt <= readAttempts; readAttempt += 1) {
        try {
          if (await verifyOnce('primary', readAttempt)) { verified = true; break; }
        } catch (error) {
          lastError = error;
          record({ ...base, ...where, phase: 'readback', attempt: readAttempt, strategy: 'primary', ok: false, error: { code: error?.code || null, message: String(error?.message || error).slice(0, 400) } });
        }
        if (!verified && readAttempt < readAttempts) await sleep(200 * readAttempt);
      }
    }

    // 阶段 C：API 优先 / GUI 兜底——主通道失败或读回不符时，执行 fallback 动作序列后重新读回
    if (!verified && step.fallback) {
      try {
        record({ ...base, ...where, phase: 'fallback.start', actions: step.fallback.actions.length });
        for (let fallbackIndex = 0; fallbackIndex < step.fallback.actions.length; fallbackIndex += 1) {
          if (abortRequested()) return abortResult(where, { mayHaveTakenEffect: writeMayHaveTakenEffect, phaseNote: 'during_fallback' });
          const fallbackAction = resolveParams(step.fallback.actions[fallbackIndex], safeParams, `fallback[${fallbackIndex}]`);
          const fallbackResult = await executeAction(executors, fallbackAction);
          if (fallbackResult !== undefined) actionResults[step.id] = fallbackResult;
          record({ ...base, ...where, phase: 'fallback.action', index: fallbackIndex, action: fallbackAction.kind === 'api' ? fallbackAction.command : fallbackAction.action, ok: true });
        }
        lastError = null;
        for (let readAttempt = 1; readAttempt <= readAttempts; readAttempt += 1) {
          if (await verifyOnce('fallback', readAttempt)) { verified = true; break; }
          if (readAttempt < readAttempts) await sleep(250 * readAttempt);
        }
      } catch (error) {
        lastError = error;
        record({ ...base, ...where, phase: 'fallback.failed', error: { code: error?.code || null, message: String(error?.message || error).slice(0, 400) } });
      }
    }

    if (beforeScreenshot && evidence) evidence.before = beforeScreenshot;
    if (verified && step.evidence?.screenshot) {
      try {
        const shot = await requireExecutor(executors, 'gui')({ action: 'screenshot', params: {} });
        const base64 = shot?.base64 || '';
        const after = {
          ok: true,
          bytes: shot?.bytes ?? null,
          sha256: base64 ? sha256Of(base64) : (shot?.sha256 ?? null),
          kind: shot?.kind ?? 'cdp',
          path: shot?.path ?? null,
          fallbackFrom: shot?.fallbackFrom ?? null,
        };
        evidence.after = after;
        evidence.screenshot = { bytes: after.bytes, sha256: after.sha256 }; // 兼容旧窗口字段
      } catch (error) {
        evidence.after = { ok: false, error: error?.code || error?.message || String(error) };
        evidence.screenshot = evidence.after;
      }
      record({ ...base, ...where, phase: 'step.evidence.after', ...evidence.after });
    }

    if (verified) {
      record({ ...base, ...where, phase: 'step.verified', attempts: attemptUsed, evidence });
      stepResults.push({ stepId: step.id, ok: true, verified: true, attempts: attemptUsed, strategy: evidence.strategy, evidence });
      continue;
    }

    // —— 失败策略
    const policy = step.onFail?.then || 'abort';
    const failures = lastFailures?.length ? lastFailures.map((check) => check.message) : [lastError?.message || '动作未产生符合条件的读回'];
    record({ ...base, ...where, phase: 'step.failed', attempts: attemptUsed, policy, error: lastError ? { code: lastError.code || null, message: String(lastError.message).slice(0, 400) } : null, failures });
    const failedStep = { ...where, policy, failures };

    if (policy === 'rollback') {
      const rollbackResult = await runRollback({ executors, steps: normalized.rollback, record, base, sleep, params: safeParams, results: actionResults });
      record({ ...base, phase: 'run.rollback', ok: rollbackResult.ok, failures: rollbackResult.failures });
      return { ok: false, state: rollbackResult.ok ? RUN_STATES.FAILED : RUN_STATES.ROLLBACK_FAILED, runId, recipeId: normalized.id, failedStep, rollback: rollbackResult, steps: stepResults };
    }
    if (policy === 'human') {
      record({ ...base, phase: 'run.paused', reason: 'needs_human', stepId: step.id });
      return { ok: false, state: RUN_STATES.NEEDS_HUMAN, runId, recipeId: normalized.id, pausedStep: failedStep, steps: stepResults };
    }
    return { ok: false, state: RUN_STATES.FAILED, runId, recipeId: normalized.id, failedStep, steps: stepResults };
  }

  record({ ...base, phase: 'run.end', ok: true, state: RUN_STATES.COMPLETED, steps: stepResults.length });
  return { ok: true, state: RUN_STATES.COMPLETED, runId, recipeId: normalized.id, steps: stepResults, journalPath: journal ? journal.pathFor(runId) : null };
}

async function runRollback({ executors, steps = [], record, base, sleep, params, results = {} }) {
  const executed = [];
  const failures = [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const action = steps[index];
    try {
      const resolved = resolveParams(action, params, `rollback[${index}]`, { results });
      if (resolved.kind === 'human') {
        if (typeof executors.human !== 'function') throw code('回退需要人工执行器', 'AUTOMATION_EXECUTOR_MISSING');
        const result = await executors.human({ action: { ...resolved, instructions: resolved.instructions || '按回退说明恢复现场' }, rollback: true });
        if (result?.done !== true) throw code('人工回退未完成', 'AUTOMATION_ROLLBACK_HUMAN_INCOMPLETE');
      } else {
        await executeAction(executors, resolved);
      }
      executed.push({ index, ok: true });
      record({ ...base, phase: 'rollback.step', index, ok: true });
    } catch (error) {
      failures.push({ index, error: String(error?.message || error).slice(0, 300) });
      record({ ...base, phase: 'rollback.step', index, ok: false, error: String(error?.message || error).slice(0, 300) });
      await sleep(100);
    }
  }
  return { ok: failures.length === 0, executed, failures };
}
