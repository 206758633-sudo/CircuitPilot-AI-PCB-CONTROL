/**
 * R3 原理图网表连线（受控写入）：把"已存在但未连网的引脚"挂到指定网络。
 *
 * 为什么是"网络端口落在引脚坐标上"而不是拉导线：
 *  真机验证过的修复通道（schematic-repair）就是用 `createNetPort(portType, net, x, y)`
 *  把网络名直接压在新引脚坐标上；而 `schematic.wire.create` 在密集引脚区拉长导线会
 *  穿过别的引脚、把不该连的网络短接。这里沿用唯一被真机证实有效的机制，并把
 *  "写前网表 → 写后网表"的逐引脚比对做成硬门禁：任何既有网络丢引脚、任何未计划引脚
 *  被赋网，都判失败并回滚（删端口 + 保存 + 再读回核对）。
 *
 * 这里只做确定性配方：网络名、引脚身份、坐标全部来自读回；不猜、不试、不重试写入。
 */
import { createHash } from 'node:crypto';

export const NET_CONNECT_CODES = {
  EXECUTE_REQUIRED: 'NET_CONNECT_EXECUTE_REQUIRED',
  CONNECTIONS_INVALID: 'NET_CONNECT_CONNECTIONS_INVALID',
  PIN_NOT_FOUND: 'NET_CONNECT_PIN_NOT_FOUND',
  PIN_IDENTITY_UNRESOLVED: 'NET_CONNECT_PIN_IDENTITY_UNRESOLVED',
  PIN_ALREADY_ON_OTHER_NET: 'NET_CONNECT_PIN_ALREADY_ON_OTHER_NET',
  WRITE_FAILED: 'NET_CONNECT_WRITE_FAILED',
  SAVE_FAILED: 'NET_CONNECT_SAVE_FAILED',
  VERIFY_FAILED: 'NET_CONNECT_VERIFY_FAILED',
  ROLLBACK_INCOMPLETE: 'NET_CONNECT_ROLLBACK_INCOMPLETE',
  READBACK_REQUIRED: 'NET_CONNECT_READBACK_REQUIRED',
};

const unwrap = (value) => (value && typeof value === 'object' && 'result' in value ? value.result : value);
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, details });
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const roundCoord = (value) => Math.round(Number(value) * 1000) / 1000;
const componentId = (component) => component?.primitiveId || component?.id || null;

/** 网表 → `{ uniqueId: { designator, pins: { pinNumber: net } } }`（只认官方网表的 pinInfoMap）。 */
export function indexNetlist(netlist) {
  const components = netlist?.components && typeof netlist.components === 'object' ? netlist.components : {};
  const byUniqueId = new Map();
  const byDesignator = new Map();
  const pinNets = new Map();
  for (const [key, component] of Object.entries(components)) {
    const props = component?.props || {};
    const uniqueId = String(props['Unique ID'] || key);
    const designator = String(props.Designator || '').trim();
    const pins = {};
    for (const [pinNumber, pin] of Object.entries(component?.pinInfoMap || {})) {
      const net = String(pin?.net ?? '').trim();
      pins[String(pinNumber)] = net;
      if (net) pinNets.set(`${uniqueId}.${String(pinNumber)}`, net);
    }
    const entry = { key, uniqueId, designator, pins };
    byUniqueId.set(uniqueId, entry);
    if (designator) byDesignator.set(designator, entry);
  }
  return { byUniqueId, byDesignator, pinNets };
}

/** 计划：校验连接、解析引脚坐标与"当前网络"，产出待写入的网络端口操作。 */
export function planNetConnect({ connections, components, pins, netlist } = {}) {
  const findings = [];
  const add = (severity, code, message, extra = {}) => findings.push({ severity, code, message, ...extra });
  if (!Array.isArray(connections) || !connections.length) {
    add('blocking', NET_CONNECT_CODES.CONNECTIONS_INVALID, 'connections 必须是非空数组');
    return { ok: false, operations: [], satisfied: [], findings };
  }
  const componentList = Array.isArray(components) ? components : (components?.components || []);
  const componentByPrimitiveId = new Map(componentList.map((item) => [componentId(item), item]));
  const pinsByPrimitiveId = pins && typeof pins === 'object' ? pins : {};
  const index = indexNetlist(netlist);
  const operations = [];
  const satisfied = [];
  const seen = new Set();
  for (const [connectionIndex, connection] of connections.entries()) {
    const net = typeof connection?.net === 'string' ? connection.net.trim() : '';
    if (!net || /\s/.test(net)) {
      add('blocking', NET_CONNECT_CODES.CONNECTIONS_INVALID, `connections[${connectionIndex}].net 必须是非空且不含空白的网络名`, { connectionIndex });
      continue;
    }
    const targets = Array.isArray(connection?.pins) ? connection.pins : [];
    if (!targets.length) {
      add('blocking', NET_CONNECT_CODES.CONNECTIONS_INVALID, `网络 ${net} 没有任何目标引脚`, { connectionIndex });
      continue;
    }
    for (const [pinIndex, target] of targets.entries()) {
      const primitiveId = String(target?.componentPrimitiveId || target?.primitiveId || '');
      const pinNumber = target?.pinNumber == null ? '' : String(target.pinNumber);
      const label = `${primitiveId || '?'}.${pinNumber || '?'}`;
      if (!primitiveId || !pinNumber) {
        add('blocking', NET_CONNECT_CODES.PIN_NOT_FOUND, `connections[${connectionIndex}].pins[${pinIndex}] 缺少 componentPrimitiveId 或 pinNumber`, { net, primitiveId, pinNumber });
        continue;
      }
      if (seen.has(label)) {
        add('blocking', NET_CONNECT_CODES.CONNECTIONS_INVALID, `引脚 ${label} 在本次连接计划里出现了多次`, { net, primitiveId, pinNumber });
        continue;
      }
      seen.add(label);
      const component = componentByPrimitiveId.get(primitiveId);
      if (!component) {
        add('blocking', NET_CONNECT_CODES.PIN_NOT_FOUND, `原理图里没有图元 ${primitiveId}（${label}）`, { net, primitiveId, pinNumber });
        continue;
      }
      const readbackPins = Array.isArray(pinsByPrimitiveId[primitiveId]) ? pinsByPrimitiveId[primitiveId] : [];
      const pin = readbackPins.find((item) => String(item?.pinNumber ?? item?.number ?? '') === pinNumber);
      const x = Number(pin?.x ?? pin?.position?.x);
      const y = Number(pin?.y ?? pin?.position?.y);
      if (!pin || !Number.isFinite(x) || !Number.isFinite(y)) {
        add('blocking', NET_CONNECT_CODES.PIN_NOT_FOUND, `图元 ${component.designator || primitiveId} 的引脚 ${pinNumber} 读不回坐标`, { net, primitiveId, pinNumber });
        continue;
      }
      const uniqueId = String(component.uniqueId || '').trim();
      const designator = String(component.designator || '').trim();
      const entry = (uniqueId && index.byUniqueId.get(uniqueId)) || (designator && index.byDesignator.get(designator)) || null;
      if (!entry) {
        add('blocking', NET_CONNECT_CODES.PIN_IDENTITY_UNRESOLVED, `图元 ${designator || primitiveId} 在网表里找不到身份（uniqueId/位号都对不上），不能在看不到网络的前提下改设计`, { net, primitiveId, pinNumber, uniqueId, designator });
        continue;
      }
      const currentNet = String(entry.pins[pinNumber] ?? '').trim();
      const identity = { net, primitiveId, pinNumber, designator: entry.designator || designator || null, uniqueId: entry.uniqueId };
      if (currentNet === net) { satisfied.push({ ...identity, why: '该引脚已经在目标网络上' }); continue; }
      if (currentNet) {
        add('blocking', NET_CONNECT_CODES.PIN_ALREADY_ON_OTHER_NET, `引脚 ${entry.designator || uniqueId}.${pinNumber} 已属于网络 ${currentNet}，拒绝把它改到 ${net}（改网必须人工确认）`, { ...identity, currentNet });
        continue;
      }
      operations.push({
        type: 'netPort.create',
        net,
        args: { portType: 'BI', net, x: roundCoord(x), y: roundCoord(y) },
        componentPrimitiveId: primitiveId,
        pinNumber,
        uniqueId: entry.uniqueId,
        designator: entry.designator || designator || null,
      });
    }
  }
  const blocking = findings.filter((item) => item.severity === 'blocking');
  if (!operations.length && !satisfied.length && !blocking.length) add('blocking', NET_CONNECT_CODES.CONNECTIONS_INVALID, '连接计划没有任何可写入的引脚');
  const plan = {
    apiVersion: 1,
    kind: 'schematic-net-connect',
    operations,
    satisfied,
    findings,
    nets: [...new Set(operations.map((item) => item.net))].sort(),
  };
  return { ok: blocking.length === 0 && operations.length + satisfied.length > 0, operations, satisfied, findings, plan, planHash: digest(plan) };
}

export function digest(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * 执行：建网络端口 → 保存 → 读回网表逐引脚核对；不符就删端口 + 保存 + 再核对。
 * 任何写入失败都不重试（重试可能在 EDA 里留下第二个端口）。
 */
export async function applyNetConnect({ execute, plan, beforeNetlist, readNetlist, loadComponents = null, save = true } = {}) {
  if (typeof execute !== 'function') throw fail(NET_CONNECT_CODES.EXECUTE_REQUIRED, '网表连线需要桥接 execute');
  if (typeof readNetlist !== 'function') throw fail(NET_CONNECT_CODES.READBACK_REQUIRED, '网表连线必须有保存后的网表读回函数');
  if (!plan || !Array.isArray(plan.operations) || !plan.operations.length) throw fail(NET_CONNECT_CODES.CONNECTIONS_INVALID, '没有可执行的网络端口操作');
  const events = [];
  const created = [];
  const event = (stage, status, detail = {}) => events.push({ at: new Date().toISOString(), stage, status, detail });
  const beforeIndex = indexNetlist(beforeNetlist);
  const beforePins = new Map(beforeIndex.pinNets);
  const readComponentSnapshot = async () => (typeof loadComponents === 'function' ? ((await loadComponents())?.components || []) : null);
  const beforeComponents = await readComponentSnapshot().catch(() => null);
  const beforeComponentIds = new Set((beforeComponents || []).map(componentId).filter(Boolean));
  const isTransient = (error) => error?.code === 20 || error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'BRIDGE_HTTP_ERROR';

  /**
   * 写一个端口。**中止不等于没写**：真机上 15s 预算被渲染进程打满时，请求已派发但调用方拿到 AbortError，
   * 端口可能已经建出来了。所以中止后先读回按"网络名 + 坐标"核实；确认不存在才允许再试一次。
   * 这样既不把"其实写成功"误判成失败，也不会因盲目重试留下两个重复端口。
   */
  const createPort = async (operation) => {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return { result: unwrap(await execute('schematic.netPort.create', operation.args, { allowWrite: true })), recovered: false };
      } catch (error) {
        lastError = error;
        if (!isTransient(error)) throw error;
        event('netPort.aborted', 'warn', { net: operation.net, attempt, code: error?.code ?? null });
        await new Promise((resolve) => setTimeout(resolve, 600));
        const components = await readComponentSnapshot().catch(() => null);
        const hit = (components || []).find((item) => item?.componentType === 'netport'
          && String(item.net || '').trim() === operation.net
          && Math.abs(Number(item.x) - operation.args.x) <= 0.5
          && Math.abs(Number(item.y) - operation.args.y) <= 0.5);
        const primitiveId = hit ? componentId(hit) : null;
        if (primitiveId) {
          event('netPort.recovered', 'passed', { net: operation.net, primitiveId, attempt });
          return { result: { primitiveId }, recovered: true };
        }
      }
    }
    throw lastError;
  };

  /** 回滚：删 + 保存 + 再读回核实"新图元一个不剩"；删除失败/中止时按"新图元集合"二次清理，绝不假设已删。 */
  const deleteCreated = async (reasonCode) => {
    const ids = [...new Set(created.map((item) => item.primitiveId).filter(Boolean))];
    let deleted = ids.length === 0;
    let saved = ids.length === 0;
    if (ids.length) {
      try {
        deleted = unwrap(await execute('schematic.component.delete', { primitiveIds: ids }, { allowWrite: true })) === true;
        saved = unwrap(await execute('schematic.save', {}, { allowWrite: true })) === true;
      } catch (error) {
        event('rollback.delete', 'failed', { reasonCode, code: error?.code ?? null, message: String(error?.message || error).slice(0, 160) });
      }
    }
    let extras = [];
    const afterDelete = await readComponentSnapshot().catch(() => null);
    if (afterDelete) {
      extras = afterDelete.map(componentId).filter((id) => id && !beforeComponentIds.has(id));
      if (extras.length) {
        try {
          event('rollback.extras', 'started', { count: extras.length });
          unwrap(await execute('schematic.component.delete', { primitiveIds: extras }, { allowWrite: true }));
          saved = unwrap(await execute('schematic.save', {}, { allowWrite: true })) === true || saved;
          deleted = true;
        } catch (error) {
          event('rollback.extras', 'failed', { code: error?.code ?? null, message: String(error?.message || error).slice(0, 160) });
        }
      }
    }
    const finalComponents = await readComponentSnapshot().catch(() => null);
    const remaining = finalComponents ? finalComponents.map(componentId).filter((id) => id && ids.includes(id)) : null;
    return { deleted, saved, ids, extras, remaining };
  };

  const rollback = async (reasonCode, message, details = {}) => {
    event('rollback', 'started', { reasonCode });
    const cleanup = await deleteCreated(reasonCode);
    event('rollback.cleanup', cleanup.remaining?.length === 0 ? 'passed' : 'failed', { deleted: cleanup.deleted, saved: cleanup.saved, extras: cleanup.extras.length, remaining: cleanup.remaining });
    let restored = null;
    try {
      const after = await readNetlist();
      restored = diffPinNets(beforePins, new Map(indexNetlist(after).pinNets));
    } catch (error) {
      restored = { ok: false, error: String(error?.message || error).slice(0, 200) };
    }
    event('rollback', restored?.ok ? 'passed' : 'failed', { cleanup, restored });
    const componentsChecked = cleanup.remaining !== null;
    const clean = restored?.ok === true && (!componentsChecked || cleanup.remaining.length === 0);
    const code = clean ? reasonCode : NET_CONNECT_CODES.ROLLBACK_INCOMPLETE;
    const suffix = clean ? '' : '；回滚后网表/图元未能回到写入前状态（需人工处理）';
    throw fail(code, `${message}${suffix}`, { ...details, rolledBack: clean, cleanup, restored, events });
  };

  try {
    for (const [index, operation] of plan.operations.entries()) {
      const { result, recovered } = await createPort(operation);
      const primitiveId = result?.primitiveId || result?.id;
      if (!primitiveId) await rollback(NET_CONNECT_CODES.WRITE_FAILED, `创建网络端口 ${operation.net}（${operation.uniqueId}.${operation.pinNumber}）后没有返回图元 ID`);
      created.push({ primitiveId, operation });
      event('netPort.create', 'passed', { net: operation.net, uniqueId: operation.uniqueId, pinNumber: operation.pinNumber, primitiveId, recovered, index });
    }
    if (save) {
      const saved = unwrap(await execute('schematic.save', {}, { allowWrite: true }));
      if (saved !== true) await rollback(NET_CONNECT_CODES.SAVE_FAILED, '嘉立创EDA 未确认保存成功，读回不会反映新图元');
      event('save', 'passed');
    }
    const afterNetlist = await readNetlist();
    const afterMap = new Map(indexNetlist(afterNetlist).pinNets);
    const verification = verifyNetConnect({ beforePins, afterPins: afterMap, operations: plan.operations });
    event('verify', verification.ok ? 'passed' : 'failed', verification.summary);
    if (!verification.ok) {
      await rollback(NET_CONNECT_CODES.VERIFY_FAILED, `写入后网表核对不通过：${JSON.stringify(verification.unexpected || []).slice(0, 240)}`, { verification });
    }
    return { ok: true, saved: save, createdPrimitiveIds: created.map((item) => item.primitiveId), verification, afterNetlist, events };
  } catch (error) {
    if (error?.details?.rolledBack !== undefined) throw error;
    if (created.length) {
      const cleanup = await deleteCreated(error?.code || 'WRITE_FAILED');
      throw fail(NET_CONNECT_CODES.ROLLBACK_INCOMPLETE, `写入过程失败且回滚未确认：${error?.message || error}`, { cleanup, events, cause: { code: error?.code || null, message: String(error?.message || error).slice(0, 300) } });
    }
    throw error;
  }
}

/** 逐引脚比对：目标引脚必须落到目标网络；既有命名引脚一个都不许丢/改；未计划引脚不许被赋网。 */
export function verifyNetConnect({ beforePins, afterPins, operations = [] } = {}) {
  const targets = new Map(operations.map((item) => [`${item.uniqueId}.${item.pinNumber}`, item.net]));
  const unexpected = [];
  const missing = [];
  const gained = [];
  for (const [key, net] of targets) {
    if (afterPins.get(key) === net) continue;
    const actual = afterPins.get(key) ?? '';
    if (!actual) missing.push({ pin: key, expected: net, actual: null });
    else unexpected.push({ pin: key, expected: net, actual, why: '目标引脚被写到了别的网络' });
  }
  for (const [key, net] of beforePins) {
    const actual = afterPins.get(key);
    if (actual !== net) unexpected.push({ pin: key, expected: net, actual: actual ?? null, why: '既有网络引脚丢失或被改动' });
  }
  for (const [key, net] of afterPins) {
    if (beforePins.has(key) || targets.has(key)) continue;
    unexpected.push({ pin: key, expected: null, actual: net, why: '计划外引脚被赋网（可能短接到别的引脚）' });
    gained.push({ pin: key, net });
  }
  return { ok: unexpected.length === 0 && missing.length === 0, missing, unexpected, gained, summary: { targets: targets.size, missing: missing.length, unexpected: unexpected.length } };
}

/** 列出"网表里还没有网络"的既有器件引脚（确定性排序：位号 → 引脚号）。 */
export function collectDanglingPins({ components, pins, netlist, limit = 20 } = {}) {
  const index = indexNetlist(netlist);
  const componentList = Array.isArray(components) ? components : (components?.components || []);
  const list = [];
  for (const component of componentList) {
    if (component?.componentType !== 'part') continue;
    const primitiveId = componentId(component);
    if (!primitiveId) continue;
    const uniqueId = String(component.uniqueId || '').trim();
    const designator = String(component.designator || '').trim();
    const entry = (uniqueId && index.byUniqueId.get(uniqueId)) || (designator && index.byDesignator.get(designator)) || null;
    if (!entry) continue;
    for (const pin of (pins?.[primitiveId] || [])) {
      const pinNumber = String(pin?.pinNumber ?? pin?.number ?? '').trim();
      if (!pinNumber || pin?.noConnected === true) continue;
      if (String(entry.pins[pinNumber] ?? '').trim()) continue;
      const x = Number(pin?.x ?? pin?.position?.x);
      const y = Number(pin?.y ?? pin?.position?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      list.push({ componentPrimitiveId: primitiveId, uniqueId: entry.uniqueId, designator: entry.designator || designator || null, pinNumber, x: roundCoord(x), y: roundCoord(y) });
    }
  }
  list.sort((a, b) => String(a.designator || '').localeCompare(String(b.designator || '')) || String(a.pinNumber).localeCompare(String(b.pinNumber)));
  return Number.isInteger(limit) && limit > 0 ? list.slice(0, limit) : list;
}

/**
 * 把候选悬空引脚组织成"验证用网络"：每 2 个引脚一组挂同一个网络名，最多 maxNets 组。
 * 用途是验证"按网络名挂接 + 保存后网表读回"这条通道本身，写入后必须删除复原；
 * 这不是在替用户决定真实网络归属（那需要设计意图，不能猜）。
 */
export function buildTestConnections(candidates, { prefix = 'CP_R3_TEST', perNet = 2, maxNets = 3 } = {}) {
  const pins = Array.isArray(candidates) ? candidates.slice(0, Math.max(1, perNet) * Math.max(1, maxNets)) : [];
  const groups = [];
  for (let index = 0; index < pins.length; index += perNet) {
    groups.push({ net: `${prefix}_${groups.length + 1}`, pins: pins.slice(index, index + perNet).map((pin) => ({ componentPrimitiveId: pin.componentPrimitiveId, pinNumber: pin.pinNumber })) });
    if (groups.length >= maxNets) break;
  }
  return groups;
}

/** 删除本次写入的网络端口并保存，核对"图元不在了 + 目标引脚回到无网状态"。 */
export async function rollbackNetConnect({ execute, loadComponents, readNetlist, primitiveIds = [], targets = [] } = {}) {
  if (typeof execute !== 'function') throw fail(NET_CONNECT_CODES.EXECUTE_REQUIRED, '回滚需要桥接 execute');
  if (!Array.isArray(primitiveIds) || !primitiveIds.length) throw fail(NET_CONNECT_CODES.CONNECTIONS_INVALID, '回滚需要至少一个网络端口图元 ID');
  const events = [];
  const event = (stage, status, detail = {}) => events.push({ at: new Date().toISOString(), stage, status, detail });
  // 幂等：图元可能已经被上一次回滚删掉了（例如删除成功但后续读回失败）。
  // 这时再调 delete 会返回 false，不能因此把"已经复原"误报成失败。
  const beforeComponents = typeof loadComponents === 'function' ? ((await loadComponents())?.components || []) : null;
  const beforeIds = beforeComponents ? new Set(beforeComponents.map(componentId)) : null;
  const alreadyAbsent = beforeIds ? primitiveIds.every((id) => !beforeIds.has(id)) : false;
  let deleted = alreadyAbsent;
  let saved = false;
  if (!alreadyAbsent) {
    deleted = unwrap(await execute('schematic.component.delete', { primitiveIds: [...primitiveIds] }, { allowWrite: true })) === true;
    saved = unwrap(await execute('schematic.save', {}, { allowWrite: true })) === true;
  }
  event('delete', deleted ? 'passed' : 'failed', { count: primitiveIds.length, alreadyAbsent });
  event('save', alreadyAbsent ? 'skipped' : (saved ? 'passed' : 'failed'), { alreadyAbsent });
  let remaining = null;
  if (typeof loadComponents === 'function') {
    const components = (await loadComponents())?.components || [];
    const ids = new Set(components.map(componentId));
    remaining = primitiveIds.filter((id) => ids.has(id));
  }
  let targetNets = null;
  let targetsRestored = null;
  if (typeof readNetlist === 'function' && targets.length) {
    const index = indexNetlist(await readNetlist());
    targetNets = targets.map((target) => {
      const entry = index.byUniqueId.get(String(target.uniqueId)) || index.byDesignator.get(String(target.designator || ''));
      const net = entry ? String(entry.pins[String(target.pinNumber)] ?? '').trim() : null;
      return { pin: `${target.uniqueId || target.designator}.${target.pinNumber}`, net };
    });
    targetsRestored = targetNets.every((item) => !item.net);
    event('verify', targetsRestored ? 'passed' : 'failed', { targetNets });
  }
  return {
    ok: deleted === true && (alreadyAbsent || saved === true) && remaining?.length === 0 && targetsRestored !== false,
    deleted: deleted === true, saved: saved === true, remaining, targetNets, targetsRestored, events,
  };
}

/** 比较两次引脚网络快照是否一致（回滚核对用）。 */
export function diffPinNets(beforePins, afterPins) {
  const changes = [];
  for (const [key, net] of beforePins) if (afterPins.get(key) !== net) changes.push({ pin: key, expected: net, actual: afterPins.get(key) ?? null });
  for (const [key, net] of afterPins) if (!beforePins.has(key)) changes.push({ pin: key, expected: null, actual: net });
  return { ok: changes.length === 0, changes };
}
