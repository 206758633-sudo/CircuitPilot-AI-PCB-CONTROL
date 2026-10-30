/**
 * 原理图批量落件（A6）：把"逐件创建"产品化成一条可续跑、可幂等、可读回审计的链路。
 *
 * 背景（真机教训）：嘉立创EDA 单件 `schematic.component.create` 要 16–75s，连续创建第 2 件
 * 容易遇到 `code 20 aborted`；180 件级工程过去只能靠临时脚本，中断后无法知道"哪些已经落了"。
 *
 * 本模块只做确定性的编排，不猜器件身份、不跳过验证：
 *   1. 计划阶段：逐项校验身份/坐标，和当前原理图器件读回比对，得出 create/skip-existing；
 *   2. 执行阶段：逐件创建，**每件完成立即原子写进度状态**（planHash 绑定），失败即停；
 *   3. 续跑阶段：同 planHash 的状态文件恢复已完成项，只补剩下的；
 *   4. 验收阶段：保存后读回，逐项确认目标位置/身份命中，并检查重复件。
 *
 * 幂等判据（先身份、后坐标）：读回项能给出库身份就按身份比；给不出则按"目标坐标是否已有器件"
 * 比。两者都拿不到证据时**不静默认为已存在**，而是显式记 `identityUnproven` 并依赖状态文件续跑。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const BATCH_CODES = {
  ITEMS_INVALID: 'SCHEMATIC_BATCH_ITEMS_INVALID',
  PLAN_INVALID: 'SCHEMATIC_BATCH_PLAN_INVALID',
  STATE_MISMATCH: 'SCHEMATIC_BATCH_STATE_MISMATCH',
  STATE_CORRUPT: 'SCHEMATIC_BATCH_STATE_CORRUPT',
  CREATE_FAILED: 'SCHEMATIC_BATCH_CREATE_FAILED',
  SAVE_FAILED: 'SCHEMATIC_BATCH_SAVE_FAILED',
  VERIFY_FAILED: 'SCHEMATIC_BATCH_VERIFY_FAILED',
  READBACK_INVALID: 'SCHEMATIC_BATCH_READBACK_INVALID',
};

const MAX_ITEMS = 300;
const identityKey = (component) => `${String(component?.libraryUuid || '')}::${String(component?.uuid || '')}${component?.subPartName ? `::${component.subPartName}` : ''}`;
const coordinateKey = (x, y) => `${(Math.round(Number(x) * 1000) / 1000).toFixed(3)},${(Math.round(Number(y) * 1000) / 1000).toFixed(3)}`;
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, details });
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
export const digest = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');

/** 规范化一批落件项：身份（libraryUuid+uuid）与坐标是硬要求。 */
export function normalizeBatch({ items = [], limit = MAX_ITEMS } = {}) {
  if (!Array.isArray(items) || !items.length) throw fail(BATCH_CODES.ITEMS_INVALID, '批量落件至少需要 1 项', { count: 0 });
  if (items.length > limit) throw fail(BATCH_CODES.ITEMS_INVALID, `单批最多 ${limit} 项，请分批执行（失败可续跑）`, { count: items.length, limit });
  const seen = new Set();
  const normalized = items.map((item, index) => {
    const component = item?.component;
    if (!component || typeof component.libraryUuid !== 'string' || typeof component.uuid !== 'string') throw fail(BATCH_CODES.ITEMS_INVALID, `第 ${index + 1} 项缺少库身份（libraryUuid/uuid）`, { index });
    if (!Number.isFinite(Number(item?.x)) || !Number.isFinite(Number(item?.y))) throw fail(BATCH_CODES.ITEMS_INVALID, `第 ${index + 1} 项坐标无效`, { index });
    if (item.subPartName !== undefined && typeof item.subPartName !== 'string') throw fail(BATCH_CODES.ITEMS_INVALID, `第 ${index + 1} 项子部件名无效`, { index });
    const key = identityKey(component);
    const keyWithPosition = `${key}@${coordinateKey(item.x, item.y)}`;
    if (seen.has(keyWithPosition)) throw fail(BATCH_CODES.ITEMS_INVALID, `第 ${index + 1} 项与前面重复（同身份同坐标）`, { index, key: keyWithPosition });
    seen.add(keyWithPosition);
    return {
      key,
      coordinate: coordinateKey(item.x, item.y),
      component,
      x: Number(item.x),
      y: Number(item.y),
      subPartName: item.subPartName || '',
      rotation: Number(item.rotation) || 0,
      mirror: item.mirror === true,
      addIntoBom: item.addIntoBom !== false,
      addIntoPcb: item.addIntoPcb !== false,
    };
  });
  const plan = { apiVersion: 1, kind: 'schematic-component-batch', items: normalized };
  return { ok: true, items: normalized, planHash: digest(plan), plan };
}

/** 从原理图读回项里尽量取身份/坐标；取不到就是 null，绝不猜。 */
export function readPartFacts(part) {
  if (!part || typeof part !== 'object') return { identity: null, designator: null, x: null, y: null, primitiveId: null };
  const props = part.props && typeof part.props === 'object' ? part.props : {};
  const uuid = typeof part.uuid === 'string' ? part.uuid : null;
  const libraryUuid = typeof part.libraryUuid === 'string' ? part.libraryUuid : null;
  const lcscId = part.lcscId || props['Supplier Part'] || props.LCSC || null;
  const designator = part.designator || props.Designator || null;
  const x = Number.isFinite(Number(part.x)) ? Number(part.x) : (Number.isFinite(Number(part.position?.x)) ? Number(part.position.x) : null);
  const y = Number.isFinite(Number(part.y)) ? Number(part.y) : (Number.isFinite(Number(part.position?.y)) ? Number(part.position.y) : null);
  return {
    identity: uuid && libraryUuid ? identityKey({ libraryUuid, uuid }) : null,
    lcscId: lcscId ? String(lcscId) : null,
    designator: designator ? String(designator) : null,
    x, y,
    primitiveId: part.primitiveId || part.id || null,
  };
}

const samePoint = (a, b, tolerance) => a.x !== null && b.x !== null && Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;

/**
 * 计划阶段：当前读回 vs 批量项 → 每项 create | skip-existing；不合法项给 blocking finding。
 * @param {{items:Array, parts:Array, toleranceMm?:number}} input
 */
export function planSchematicBatch({ items = [], parts = [], toleranceMm = 0.05 } = {}) {
  const normalized = normalizeBatch({ items });
  const facts = Array.isArray(parts) ? parts.map(readPartFacts) : [];
  const findings = [];
  const planned = normalized.items.map((item) => {
    const target = { x: item.x, y: item.y };
    // 身份命中必须带坐标（同型号器件会在不同位置放多颗：100nF 电容等）；
    // 只有读回完全不暴露坐标时，才允许仅按身份判定，并显式标歧义。
    const identityAtPoint = facts.find((fact) => fact.identity && fact.identity === item.key && samePoint(fact, target, toleranceMm)) || null;
    const identityWithoutCoords = facts.find((fact) => fact.identity && fact.identity === item.key && fact.x === null) || null;
    const coordinateHit = facts.find((fact) => samePoint(fact, target, toleranceMm)) || null;
    const match = identityAtPoint || coordinateHit || identityWithoutCoords;
    const matchAmbiguous = !identityAtPoint && !coordinateHit && Boolean(identityWithoutCoords);
    const identityUnproven = !factFactsHaveAnyIdentity(facts);
    if (!match && identityUnproven) findings.push({ severity: 'warning', code: 'IDENTITY_UNPROVEN', message: `第 ${item.key}@${item.coordinate} 读回未暴露身份/坐标，幂等只能依赖状态文件` });
    return {
      ...item,
      action: match ? 'skip-existing' : 'create',
      matchedBy: match ? (identityAtPoint ? 'identity' : coordinateHit ? 'coordinate' : 'identity-unpositioned') : null,
      matchAmbiguous,
      existing: match ? { designator: match.designator, primitiveId: match.primitiveId, x: match.x, y: match.y } : null,
    };
  });
  // 重复件判据只看坐标（同型号多颗是正常设计，不能按身份算重复）；坐标相同才是真重复。
  const duplicates = new Map();
  for (const fact of facts) {
    if (fact.x === null) continue;
    const key = `@${coordinateKey(fact.x, fact.y)}`;
    duplicates.set(key, (duplicates.get(key) || 0) + 1);
  }
  const duplicateGroups = [...duplicates.entries()].filter(([, count]) => count > 1).map(([key, count]) => ({ key, count }));
  const counts = {
    total: planned.length,
    create: planned.filter((item) => item.action === 'create').length,
    skipExisting: planned.filter((item) => item.action === 'skip-existing').length,
  };
  return {
    ok: true,
    planHash: normalized.planHash,
    items: planned,
    counts,
    identityUnproven: !facts.some((fact) => fact.identity || fact.x !== null),
    duplicateGroups,
    findings,
  };
}

function factFactsHaveAnyIdentity(facts) { return facts.some((fact) => fact.identity !== null); }

function loadState(stateFile) {
  if (!stateFile) return null;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('状态不是对象');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fail(BATCH_CODES.STATE_CORRUPT, `批量落件进度状态损坏：${stateFile}`, { stateFile, cause: error.message });
  }
}

function saveState(stateFile, state) {
  if (!stateFile) return null;
  mkdirSync(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, stateFile);
  return stateFile;
}

const primitiveIdOf = (result) => result?.primitiveId || result?.id || result?.primitive?.primitiveId || null;

/**
 * 执行阶段：逐件创建 + 每件原子写进度 + 失败即停（不改他人）；save 必须显式且确认 `true`。
 * 续跑：同一 stateFile + 同 planHash 时跳过已完成项（并保留已完成 ID 供回读验收）。
 */
export async function applySchematicBatch({ execute, plan, stateFile = null, save = false, readParts = null, onProgress = null } = {}) {
  if (!plan || !Array.isArray(plan.items) || !plan.planHash) throw fail(BATCH_CODES.PLAN_INVALID, '批量落件计划不合法');
  if (typeof execute !== 'function') throw fail(BATCH_CODES.PLAN_INVALID, '批量落件需要 execute');
  const unwrap = (value) => (value && typeof value === 'object' && 'result' in value ? value.result : value);
  const previous = loadState(stateFile);
  if (previous && previous.planHash && previous.planHash !== plan.planHash) {
    throw fail(BATCH_CODES.STATE_MISMATCH, '续跑状态属于另一份计划（planHash 不一致），拒绝混跑', { stateFile, statePlanHash: previous.planHash, planHash: plan.planHash });
  }
  const state = previous && previous.planHash === plan.planHash
    ? previous
    : { schemaVersion: 1, kind: 'schematic-component-batch-state', planHash: plan.planHash, startedAt: new Date().toISOString(), completed: {}, createdPrimitiveIds: [], failed: null };
  const completed = state.completed && typeof state.completed === 'object' ? state.completed : {};
  const created = [];
  const skipped = [];
  let failure = null;
  for (const item of plan.items) {
    if (completed[item.key]) { skipped.push({ key: item.key, reason: 'already-completed', primitiveId: completed[item.key].primitiveId ?? null }); continue; }
    // 计划阶段已判定"当前位置已有该器件"的项直接跳过：重复执行不产生重复件（幂等）。
    if (item.action === 'skip-existing') { skipped.push({ key: item.key, reason: item.matchAmbiguous ? 'exists-identity-unpositioned' : 'exists', primitiveId: item.existing?.primitiveId ?? null }); continue; }
    try {
      const raw = unwrap(await execute('schematic.component.create', {
        component: item.component,
        x: item.x,
        y: item.y,
        subPartName: item.subPartName,
        rotation: item.rotation,
        mirror: item.mirror,
        addIntoBom: item.addIntoBom,
        addIntoPcb: item.addIntoPcb,
      }, { allowWrite: true }));
      const primitiveId = primitiveIdOf(raw);
      created.push({ key: item.key, primitiveId, result: raw ?? null });
      completed[item.key] = { primitiveId, at: new Date().toISOString() };
      state.createdPrimitiveIds = [...new Set([...(state.createdPrimitiveIds || []), ...(primitiveId ? [primitiveId] : [])])];
      saveState(stateFile, state);
      if (typeof onProgress === 'function') onProgress({ type: 'created', key: item.key, primitiveId });
    } catch (error) {
      failure = { key: item.key, code: error.code || BATCH_CODES.CREATE_FAILED, message: String(error.message || error).slice(0, 300), at: new Date().toISOString() };
      state.failed = failure;
      saveState(stateFile, state);
      if (typeof onProgress === 'function') onProgress({ type: 'failed', ...failure });
      break; // 失败即停：不把错误状态扩散到后续器件
    }
  }
  const allCompleted = plan.items.every((item) => Boolean(completed[item.key]));
  let saved = null;
  if (failure) {
    return { ok: false, planHash: plan.planHash, created, skipped, failed: failure, resumed: Boolean(previous), saved: false, statePath: stateFile, verification: null };
  }
  if (save) {
    const savedResult = unwrap(await execute('schematic.save', {}, { allowWrite: true }));
    if (savedResult !== true) {
      throw fail(BATCH_CODES.SAVE_FAILED, '批量落件后保存未确认（schematic.save 未返回 true），不能声称已落盘', { savedResult });
    }
    saved = true;
  }
  let verification = null;
  if (typeof readParts === 'function') {
    const parts = await readParts();
    verification = verifySchematicBatch({ plan, parts, createdPrimitiveIds: state.createdPrimitiveIds, skippedKeys: skipped.map((item) => item.key), toleranceMm: 0.05 });
    if (!verification.ok && save) throw fail(BATCH_CODES.VERIFY_FAILED, `批量落件读回不一致：${verification.findings.map((item) => item.message).join('；')}`, { verification });
  }
  return { ok: allCompleted && (!verification || verification.ok), planHash: plan.planHash, created, skipped, failed: null, resumed: Boolean(previous), saved, statePath: stateFile, verification };
}

/** 读回验收：每项都能在器件读回里找到（身份命中 / 坐标命中 / 本批创建 ID 命中之一），且无重复件。 */
export function verifySchematicBatch({ plan, parts = [], createdPrimitiveIds = [], toleranceMm = 0.05 } = {}) {
  const facts = Array.isArray(parts) ? parts.map(readPartFacts) : [];
  const createdIds = new Set((createdPrimitiveIds || []).map(String));
  const findings = [];
  const perItem = [];
  for (const item of plan.items) {
    const byId = facts.find((fact) => fact.primitiveId && createdIds.has(String(fact.primitiveId))) || null;
    const byIdentity = facts.find((fact) => fact.identity && fact.identity === item.key) || null;
    const byCoordinate = facts.find((fact) => fact.x !== null && Math.abs(fact.x - item.x) <= toleranceMm && Math.abs(fact.y - item.y) <= toleranceMm) || null;
    const hit = byId || byIdentity || byCoordinate;
    perItem.push({ key: item.key, coordinate: item.coordinate, found: Boolean(hit), matchedBy: hit ? (byId ? 'created-primitive-id' : byIdentity ? 'identity' : 'coordinate') : null, designator: hit?.designator ?? null });
    if (!hit) findings.push({ severity: 'blocking', code: 'BATCH_ITEM_MISSING', message: `读回缺少 ${item.key}@${item.coordinate}` });
  }
  const duplicateGroups = [];
  const seen = new Map();
  for (const fact of facts) {
    const key = fact.primitiveId ? `id:${fact.primitiveId}` : fact.identity ? `id:${fact.identity}` : fact.x !== null ? `@${coordinateKey(fact.x, fact.y)}` : null;
    if (!key) continue;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [key, count] of seen.entries()) if (count > 1) duplicateGroups.push({ key, count });
  return { ok: findings.length === 0, items: perItem, findings, duplicateGroups, partCount: facts.length };
}
