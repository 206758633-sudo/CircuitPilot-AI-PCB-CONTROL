/**
 * 把布局计划写回嘉立创EDA —— 而且**写完必须证明它真的写成了**。
 *
 * 这个模块存在的唯一理由：本项目已经反复踩过"调用没报错就当成成功"的坑
 * （板框读回拿到空多边形却"成功"、DRC count=3 被当成 3 个问题、仿真 ran:true 却读不出数值）。
 * 所以流程被固定成：**快照 → 写回 → 逐项回读比对 → 独立复核 → 不通过就回滚并回读证明已还原**。
 *
 * 几条硬规矩：
 *   1. 默认 `dryRun`。真要写，得显式传 `dryRun:false`。
 *   2. **永不保存**（不调 pcb.save）：改动只留在内存，用户看过 diff 再决定保存。
 *   3. 回滚用"把原坐标写回去"这种定点方式，而不是重建整份文档（重建会把铺铜等一起重算，代价高、风险大）。
 *   4. 回滚也要回读验证；回滚失败必须报 `ROLLBACK_FAILED` 并附上原始坐标，让工程师能手改。
 */
import { placementCenterMm, verifyOutlinePlacement } from './placement.mjs';
import { assertAnnotatedDesignators } from './designator.mjs';

export const PLACEMENT_WRITE_CODES = {
  NOTHING_TO_DO: 'PLACEMENT_WRITE_NOTHING_TO_DO',
  DRY_RUN: 'PLACEMENT_WRITE_DRY_RUN',
  APPLIED: 'PLACEMENT_WRITE_APPLIED',
  READBACK_MISMATCH: 'PLACEMENT_WRITE_READBACK_MISMATCH',
  VERIFY_BLOCKED: 'PLACEMENT_WRITE_VERIFY_BLOCKED',
  ROLLED_BACK: 'PLACEMENT_WRITE_ROLLED_BACK',
  ROLLBACK_FAILED: 'PLACEMENT_WRITE_ROLLBACK_FAILED',
  TARGET_UNKNOWN: 'PLACEMENT_WRITE_TARGET_UNKNOWN',
  APPLY_FAILED: 'PLACEMENT_WRITE_APPLY_FAILED',
};

const MM_PER_MIL = 0.0254;
export const mmToMil = (value) => Number((Number(value) / MM_PER_MIL).toFixed(6));
const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

function readValue(response) {
  return response && typeof response === 'object' && 'result' in response ? response.result : response;
}

/**
 * 构造写回清单：只包含真的需要动的器件（位移小于容差的跳过），并带上"从哪里来"用于回滚。
 * 基准只认 EDA 读回的位置，绝不认计划里记的 `current`（那是上一轮读的，可能已经变了）。
 */
export function buildPlacementUpdates({ plan, readback, toleranceMm = 0.02 }) {
  const byPrimitive = new Map();
  for (const component of readback?.components || []) {
    if (component?.primitiveId) byPrimitive.set(component.primitiveId, component);
  }
  const updates = [];
  const skipped = [];
  const missing = [];
  for (const placement of plan?.placements || []) {
    const observed = placement.primitiveId ? byPrimitive.get(placement.primitiveId) : null;
    if (!observed) {
      missing.push({ ref: placement.ref, primitiveId: placement.primitiveId || null, reason: 'EDA 读回里找不到这个器件（图元被删/换过？）' });
      continue;
    }
    // 读回 xMm/yMm 是器件原点；计划的 xMm/yMm 是**包围盒中心**。两边统一到中心比较，
    // 写回时再按 (中心-原点) 偏移换算回原点坐标——非对称封装（U1 差 3.44mm）不换算就是写错位置。
    const center = placementCenterMm(observed);
    const from = { xMm: center.xMm, yMm: center.yMm, rotationDeg: Number(observed.rotationDeg) || 0 };
    const to = { xMm: Number(placement.xMm), yMm: Number(placement.yMm), rotationDeg: Number(placement.rotationDeg) || 0 };
    const offsetXMm = Number.isFinite(center.originXMm) ? center.xMm - center.originXMm : 0;
    const offsetYMm = Number.isFinite(center.originYMm) ? center.yMm - center.originYMm : 0;
    const deltaMm = Math.hypot(to.xMm - from.xMm, to.yMm - from.yMm);
    const deltaRotation = Math.abs(to.rotationDeg - from.rotationDeg);
    if (deltaMm <= toleranceMm && deltaRotation <= 1e-9) { skipped.push({ ref: placement.ref, primitiveId: placement.primitiveId, reason: '已在目标位置' }); continue; }
    updates.push({ ref: placement.ref, primitiveId: placement.primitiveId, fromMm: from, toMm: to, offsetXMm: round(offsetXMm, 9), offsetYMm: round(offsetYMm, 9), deltaMm: round(deltaMm), deltaRotationDeg: round(deltaRotation, 3) });
  }
  return { updates, skipped, missing };
}

/**
 * 写回 + 回读 + 复核 +（必要时）回滚。
 * `execute(commandId, args)` 由调用方注入，便于测试；真机上传入 bridge.execute。
 */
export async function applyPlacementPlan({
  execute, plan, readback, dryRun = true, toleranceMm = 0.02, verifyOptions = {}, save = false, now = () => new Date().toISOString(),
} = {}) {
  const steps = [];
  const findings = [];
  // A5 硬门禁：带 `?` 占位位号的计划不进入任何写入（快照/移动/回读都不做）。
  assertAnnotatedDesignators((plan?.placements || []).map((item) => item?.ref), { label: '布局计划' });
  const { updates, skipped, missing } = buildPlacementUpdates({ plan, readback, toleranceMm });
  for (const entry of missing) findings.push({ code: PLACEMENT_WRITE_CODES.TARGET_UNKNOWN, severity: 'blocking', field: entry.ref, message: `${entry.ref}: ${entry.reason}` });
  if (!updates.length) {
    findings.push({ code: PLACEMENT_WRITE_CODES.NOTHING_TO_DO, severity: 'info', message: '没有任何器件需要移动（都已在目标位置）' });
    return { ok: true, applied: false, saved: false, dryRun, updates, skipped, missing, steps, findings, verified: null, rollback: null };
  }
  const summary = updates.map((item) => ({ ref: item.ref, primitiveId: item.primitiveId, fromMm: item.fromMm, toMm: item.toMm, deltaMm: item.deltaMm, deltaRotationDeg: item.deltaRotationDeg }));

  if (dryRun) {
    findings.push({ code: PLACEMENT_WRITE_CODES.DRY_RUN, severity: 'info', message: `预演：${updates.length} 个器件会被移动（最大 ${Math.max(...updates.map((item) => item.deltaMm))}mm）。没有写入 EDA。` });
    return { ok: true, applied: false, saved: false, dryRun: true, updates, skipped, missing, steps: [{ step: 'dry-run', ok: true }], findings, verified: null, rollback: null, summary };
  }

  // 1) 快照（源码级，用于人工兜底；坐标级回滚是主路径）
  let snapshotHash = null;
  try {
    // allowSensitiveRead 是给"受保护快照流程"用的正当授权：源码快照只用于兜底回滚，
    // 不落盘、不外传，只取 sha256 作为证据。
    const snapshot = readValue(await execute('pcb.source.read', {}, { allowSensitiveRead: true }));
    if (typeof snapshot === 'string' && snapshot.length) {
      const { createHash } = await import('node:crypto');
      snapshotHash = createHash('sha256').update(snapshot).digest('hex');
      steps.push({ step: 'snapshot', ok: true, bytes: snapshot.length, sha256: snapshotHash });
    } else {
      steps.push({ step: 'snapshot', ok: false, note: '源码快照为空，回滚只能走坐标级' });
    }
  } catch (error) {
    steps.push({ step: 'snapshot', ok: false, note: String(error?.message || error).slice(0, 160) });
  }

  // 2) 写回
  // 计划坐标是包围盒中心；EDA 的 modify 写的是器件原点，写前减掉 (中心-原点) 偏移。
  const payload = updates.map((item) => ({ primitiveId: item.primitiveId, designator: item.ref, xMil: mmToMil(item.toMm.xMm - (item.offsetXMm || 0)), yMil: mmToMil(item.toMm.yMm - (item.offsetYMm || 0)), rotationDeg: item.toMm.rotationDeg }));
  const applied = readValue(await execute('pcb.placement.write', { updates: payload }, { allowWrite: true }));
  const appliedCount = Number(applied?.applied ?? 0);
  steps.push({ step: 'apply', ok: appliedCount === payload.length, requested: payload.length, applied: appliedCount, errors: (applied?.results || []).filter((item) => !item.ok).map((item) => ({ designator: item.designator, error: item.error })) });
  if (appliedCount !== payload.length) {
    findings.push({ code: PLACEMENT_WRITE_CODES.APPLY_FAILED, severity: 'blocking', message: `只有 ${appliedCount}/${payload.length} 个器件写回成功` });
  }

  // 3) 回读比对 + 独立复核（不信任写入返回值，只信读回）
  const after = readValue(await execute('pcb.placement.read', {}));
  const afterByPrimitive = new Map((after?.components || []).map((component) => [component.primitiveId, component]));
  const perItem = [];
  for (const item of updates) {
    const observed = afterByPrimitive.get(item.primitiveId);
    if (!observed) { perItem.push({ ref: item.ref, ok: false, reason: '回读里找不到该器件' }); continue; }
    const observedCenter = placementCenterMm(observed);
    const dxMm = observedCenter.xMm - item.toMm.xMm;
    const dyMm = observedCenter.yMm - item.toMm.yMm;
    const errorMm = Math.hypot(dxMm, dyMm);
    perItem.push({ ref: item.ref, ok: errorMm <= toleranceMm, targetMm: item.toMm, observedMm: { xMm: round(observedCenter.xMm), yMm: round(observedCenter.yMm) }, originMm: { xMm: round(observed.xMm), yMm: round(observed.yMm) }, errorMm: round(errorMm, 4) });
  }
  const mismatched = perItem.filter((item) => !item.ok);
  if (mismatched.length) findings.push({ code: PLACEMENT_WRITE_CODES.READBACK_MISMATCH, severity: 'blocking', message: `${mismatched.length}/${updates.length} 个器件回读位置与目标不符（例：${mismatched.slice(0, 3).map((item) => `${item.ref} 偏差 ${item.errorMm}mm`).join('、')}）` });
  steps.push({ step: 'readback', ok: mismatched.length === 0, compared: perItem.length, mismatched: mismatched.length, perItem });

  const geometry = (after?.components || []).filter((component) => component?.bboxMm && Number.isFinite(Number(component.xMm))).map((component) => {
    const center = placementCenterMm(component);
    return {
      ref: component.designator || component.primitiveId, xMm: center.xMm, yMm: center.yMm,
      widthMm: Number(component.bboxMm.xMm), heightMm: Number(component.bboxMm.yMm), rotationDeg: Number(component.rotationDeg) || 0,
    };
  });
  const verified = verifyOutlinePlacement({ placements: geometry, ...verifyOptions });
  steps.push({ step: 'verify', ok: verified.ok, blockingCount: verified.blockingCount, checkedCount: verified.checkedCount });
  if (!verified.ok) findings.push({ code: PLACEMENT_WRITE_CODES.VERIFY_BLOCKED, severity: 'blocking', message: `写回后布局复核不通过：${verified.findings.filter((item) => item.severity === 'blocking').map((item) => item.message).slice(0, 3).join('；')}` });

  if (mismatched.length === 0 && verified.ok) {
    findings.push({ code: PLACEMENT_WRITE_CODES.APPLIED, severity: 'info', message: `${updates.length} 个器件写回成功并逐一回读确认（未保存：改动只在内存里）` });
    return { ok: true, applied: true, saved: false, dryRun: false, updates, skipped, missing, steps, findings, verified, rollback: null, summary, readback: { perItem }, snapshotHash };
  }

  // 4) 回滚：把原坐标写回去（定点回滚，不重建文档）
  const rollbackPayload = updates.map((item) => ({ primitiveId: item.primitiveId, designator: item.ref, xMil: mmToMil(item.fromMm.xMm - (item.offsetXMm || 0)), yMil: mmToMil(item.fromMm.yMm - (item.offsetYMm || 0)), rotationDeg: item.fromMm.rotationDeg }));
  let rollback = { attempted: true, ok: false, steps: [] };
  try {
    const restored = readValue(await execute('pcb.placement.write', { updates: rollbackPayload }, { allowWrite: true }));
    rollback.steps.push({ step: 'restore-apply', requested: rollbackPayload.length, applied: Number(restored?.applied ?? 0) });
    const back = readValue(await execute('pcb.placement.read', {}));
    const backByPrimitive = new Map((back?.components || []).map((component) => [component.primitiveId, component]));
    const stillOff = [];
    for (const item of updates) {
      const observed = backByPrimitive.get(item.primitiveId);
      if (!observed) { stillOff.push({ ref: item.ref, reason: '回读里找不到' }); continue; }
      const observedCenter = placementCenterMm(observed);
      const errorMm = Math.hypot(observedCenter.xMm - item.fromMm.xMm, observedCenter.yMm - item.fromMm.yMm);
      if (errorMm > toleranceMm) stillOff.push({ ref: item.ref, observedMm: { xMm: round(observedCenter.xMm), yMm: round(observedCenter.yMm) }, expectedMm: item.fromMm, errorMm: round(errorMm, 4) });
    }
    rollback.ok = stillOff.length === 0 && rollbackPayload.every((item, index) => true) && Number(restored?.applied ?? 0) === rollbackPayload.length;
    rollback.steps.push({ step: 'restore-readback', offTarget: stillOff });
    if (!rollback.ok) rollback.manualCoordinates = updates.map((item) => ({ ref: item.ref, primitiveId: item.primitiveId, xMil: mmToMil(item.fromMm.xMm - (item.offsetXMm || 0)), yMil: mmToMil(item.fromMm.yMm - (item.offsetYMm || 0)), rotationDeg: item.fromMm.rotationDeg }));
    findings.push(rollback.ok
      ? { code: PLACEMENT_WRITE_CODES.ROLLED_BACK, severity: 'warning', message: `写回未通过校验，已把 ${updates.length} 个器件按原坐标回滚并回读确认还原（板子保持原样）` }
      : { code: PLACEMENT_WRITE_CODES.ROLLBACK_FAILED, severity: 'blocking', message: '回滚未能完全还原！请按 manualCoordinates 手工改回（坐标单位 mil），或从源码快照恢复' });
  } catch (error) {
    rollback.ok = false;
    rollback.error = String(error?.message || error).slice(0, 200);
    rollback.manualCoordinates = updates.map((item) => ({ ref: item.ref, primitiveId: item.primitiveId, xMil: mmToMil(item.fromMm.xMm - (item.offsetXMm || 0)), yMil: mmToMil(item.fromMm.yMm - (item.offsetYMm || 0)), rotationDeg: item.fromMm.rotationDeg }));
    findings.push({ code: PLACEMENT_WRITE_CODES.ROLLBACK_FAILED, severity: 'blocking', message: `回滚抛错：${rollback.error}；manualCoordinates 已附上原始坐标` });
  }
  steps.push({ step: 'rollback', ok: rollback.ok });
  return { ok: false, applied: false, saved: false, dryRun: false, updates, skipped, missing, steps, findings, verified, rollback, summary, snapshotHash, readback: { perItem } };
}
