/**
 * 原理图自动修复：把"仿真验收发现的设计缺陷"变成"原理图上真实的元件与网络连接"。
 *
 * 为什么需要它：验收环节已经证明本板 CC1/CC2 悬空（Rd 缺失）、I2C 无上拉，
 * 但"知道错"和"改对"之间隔着一次真机写入。这类写入最容易出两种事故：
 *  1. 改完没生效（EDA 没保存/图元没落上）→ 网表不变，用户以为修好了；
 *  2. 改出**短路**（导线穿过密集引脚列把不该连的网络连上）→ 比原来更糟。
 * 所以本模块的两条硬规矩：**不许有无法验证的写入**、**验证不过必须回滚到快照**。
 *
 * 连接方式的选择：本板原理图的网络名由 `netport` 图元承载，且这些图元正好落在引脚坐标上
 * （实机读回 60 个 `componentType: 'netport'` 图元，name = SCL/SDA/GND…）。
 * 因此新增元件的引脚直接放一个同名 netport 即可"按网络名挂接"，
 * 不必在密集引脚区拉长导线——长导线穿过引脚列会短接，这正是最容易炸的地方。
 */

import { createHash } from 'node:crypto';

export const REPAIR_CODES = {
  SNAPSHOT_EMPTY: 'REPAIR_SNAPSHOT_EMPTY',
  TARGET_NET_MISSING: 'REPAIR_TARGET_NET_MISSING',
  NO_OPERATIONS: 'REPAIR_NO_OPERATIONS',
  NETLIST_UNCHANGED: 'REPAIR_NETLIST_UNCHANGED',
  NETLIST_UNEXPECTED_CHANGE: 'REPAIR_NETLIST_UNEXPECTED_CHANGE',
  PIN_UNRESOLVED: 'REPAIR_PIN_UNRESOLVED',
  COMPONENT_CREATE_FAILED: 'REPAIR_COMPONENT_CREATE_FAILED',
  PORT_CREATE_FAILED: 'REPAIR_PORT_CREATE_FAILED',
  ROLLBACK_INCOMPLETE: 'REPAIR_ROLLBACK_INCOMPLETE',
};

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const round = (value) => Number(Number(value).toFixed(3));

/**
 * 网表 → `{ 网络名: Map('U1.A4' → 引脚个数) }`。
 *
 * 为什么必须带计数而不是集合：元件标注是 EDA 异步做的，刚放上去的元件位号都是 `R?`。
 * 两个未标注电阻同时挂到 GND 时，集合里只会留下一个 `R?.1`，于是"新增 2 个引脚"被去重成 1 个，
 * 复核就会误判成"改坏了"并把正确的修复回滚掉。计数比对不受位号重名影响。
 */
export function netlistPinCounts(netlist) {
  const nets = new Map();
  for (const [key, component] of Object.entries(netlist?.components || {})) {
    const designator = component?.props?.Designator || key;
    for (const [number, pin] of Object.entries(component?.pinInfoMap || {})) {
      const net = String(pin?.net ?? '').trim();
      if (!net) continue;
      if (!nets.has(net)) nets.set(net, new Map());
      const pinKey = `${designator}.${number}`;
      nets.get(net).set(pinKey, (nets.get(net).get(pinKey) || 0) + 1);
    }
  }
  return nets;
}

/** 网表 → `{ 网络名: Set('U1.A4', ...) }`，只认官方网表的 `pinInfoMap[].net`。 */
export function netlistToNets(netlist) {
  const nets = new Map();
  const components = netlist?.components || {};
  for (const [key, component] of Object.entries(components)) {
    const designator = component?.props?.Designator || key;
    for (const [number, pin] of Object.entries(component?.pinInfoMap || {})) {
      const net = String(pin?.net ?? '').trim();
      if (!net) continue;
      if (!nets.has(net)) nets.set(net, new Set());
      nets.get(net).add(`${designator}.${number}`);
    }
  }
  return nets;
}

/**
 * 给新增元件挑一排空闲落位坐标。
 *
 * 为什么不能"随便找个坐标放"：原理图里已有 68 个图元、引脚间距只有 10 个单位，
 * 元件放重叠会导致引脚坐标重合——那就是**短路**。所以按现有图元的包围盒下缘往下让开一段，
 * 再按固定间距排开。坐标只是工程可读性，真正的安全靠写入后的网表复核。
 */
export function layoutFreeRow({ components = [], count = 1, spacingMm = 240, startX = 400, marginMm = 80 } = {}) {
  const ys = components.map((item) => Number(item?.y)).filter(Number.isFinite);
  const maxY = ys.length ? Math.max(...ys) : 0;
  const y = Math.round(maxY + marginMm);
  return Array.from({ length: Math.max(1, count) }, (_, index) => ({ x: Math.round(startX + index * spacingMm), y }));
}

/** 默认修复清单：USB-C 灌端 Rd（5.1k→GND）与 I2C 上拉（4.7k→3V3），元件按 MPN 关键字从真机库检索。 */
export const DEFAULT_PULLUP_REPAIRS = [
  { id: 'Rd_CC1', net: 'CC1', otherNet: 'GND', valueOhm: 5100, mpnKeyword: '5101', title: 'USB-C CC1 下拉电阻 Rd 5.1kΩ' },
  { id: 'Rd_CC2', net: 'CC2', otherNet: 'GND', valueOhm: 5100, mpnKeyword: '5101', title: 'USB-C CC2 下拉电阻 Rd 5.1kΩ' },
  { id: 'Rp_SDA', net: 'SDA', otherNet: '3V3', valueOhm: 4700, mpnKeyword: '4701', title: 'I2C SDA 上拉电阻 4.7kΩ' },
  { id: 'Rp_SCL', net: 'SCL', otherNet: '3V3', valueOhm: 4700, mpnKeyword: '4701', title: 'I2C SCL 上拉电阻 4.7kΩ' },
];

/**
 * 计划：每个修复项 = 一个电阻 + 两个网络端口（目标网络 + 另一端网络，例如 GND / 3V3）。
 *
 * @param {object} options
 * @param {object} options.netlist 修复前的官方网表
 * @param {Array<{id:string,net:string,otherNet:string,valueOhm:number,device:{libraryUuid:string,uuid:string},position:{x:number,y:number},refdesPrefix?:string}>} options.repairs
 * @param {boolean} [options.allowDangling=true] 是否允许目标网络当前只有 1 个引脚（悬空）——这正是要修的
 */
/** 归一化阻值/型号字符串，便于比对（`5.1kΩ` → `5.1K`，`0603WAF5101T5E` 原样）。 */
const normalize = (value) => String(value ?? '').toUpperCase().replace(/\s|Ω|OHM|欧|姆/g, '');

/** 阻值数字 → 工程写法（5100 → `5.1K`），用于在网表属性里认出"就是这个阻值"。 */
export function ohmLabel(valueOhm) {
  const ohm = Number(valueOhm);
  if (!Number.isFinite(ohm) || ohm <= 0) return null;
  if (ohm >= 1_000_000) return `${Number((ohm / 1_000_000).toFixed(3))}M`;
  if (ohm >= 1000) return `${Number((ohm / 1000).toFixed(3))}K`;
  return `${ohm}R`;
}

/** 某元件的网表属性是否就是这项修复要的器件（真机属性含 Value / Manufacturer Part / Supplier Part / DeviceName）。 */
export function partMatchesRepair(props = {}, repair = {}) {
  const haystack = normalize([props.Value, props.Name, props.DeviceName, props['Manufacturer Part'], props['LCSC Part Name'], props['Supplier Part'], props.Description].filter(Boolean).join(' '));
  if (!haystack) return false;
  const label = ohmLabel(repair.valueOhm);
  if (label && haystack.includes(label)) return true;
  const keyword = repair.mpnKeyword ? normalize(repair.mpnKeyword) : null;
  return Boolean(keyword && haystack.includes(keyword));
}

/**
 * 幂等判断：这两个网络之间**已经**跨着一个器件了吗？
 *
 * 为什么必须有这一步：修复计划是从"目标网络缺电阻"出发的，它并不知道设计已经被修好了——
 * 再跑一次就会**并联**上第二组上拉/下拉，把 CC 电压从 0.417V 拉到 0.2V，把一个正确的设计改坏。
 * 真机网表属性齐全（Value / Manufacturer Part / LCSC 料号），所以这里能精确判断，不靠猜。
 */
export function findExistingBridge(netlist, net, otherNet) {
  const found = [];
  for (const [key, component] of Object.entries(netlist?.components || {})) {
    const props = component?.props || {};
    const pins = Object.values(component?.pinInfoMap || {});
    // 只有**两脚器件**才可能是上拉/下拉（电阻/电容/二极管）。
    // 不能把"同时有 SDA 和 3V3 引脚的多脚 IC"当成跨接器件——真机上这会把 U1 误判成上拉电阻，
    // 于是该加的上拉被"幂等"跳过，设计就永远修不好。
    if (pins.length !== 2) continue;
    const nets = new Set(pins.map((pin) => String(pin?.net ?? '').trim()));
    if (nets.has(net) && nets.has(otherNet)) found.push({ key, designator: props.Designator || key, props, pinCount: pins.length });
  }
  return found;
}

export function planSchematicRepair({ netlist, repairs = [] } = {}) {
  const nets = netlistToNets(netlist);
  const findings = [];
  const operations = [];
  const satisfied = [];
  const expectedGain = {};
  for (const repair of repairs) {
    const members = nets.get(repair.net);
    if (!members) { findings.push({ severity: 'blocking', code: REPAIR_CODES.TARGET_NET_MISSING, message: `网表里没有网络 ${repair.net}，不能凭空新增一个同名网络` }); continue; }
    // 幂等：这两个网络之间已经跨着合格器件，就别再加一个（并联会把正确的设计改坏）
    const bridges = findExistingBridge(netlist, repair.net, repair.otherNet);
    const matched = bridges.find((item) => partMatchesRepair(item.props, repair));
    if (matched) {
      satisfied.push({ id: repair.id, designator: matched.designator, value: matched.props.Value ?? null, part: matched.props['Manufacturer Part'] ?? null, why: '该网络与目标网络之间已有合格器件' });
      findings.push({ severity: 'info', code: 'REPAIR_ALREADY_SATISFIED', message: `${repair.id}：${repair.net} 与 ${repair.otherNet} 之间已有 ${matched.designator}（${matched.props.Value ?? matched.props['Manufacturer Part'] ?? '阻值未知'}），不再重复新增` });
      continue;
    }
    if (bridges.length) {
      satisfied.push({ id: repair.id, designator: bridges.map((item) => item.designator).join('/'), value: bridges[0].props.Value ?? null, part: bridges[0].props['Manufacturer Part'] ?? null, why: '已有元件跨接这两个网络，但属性里看不出阻值是否合格' });
      findings.push({ severity: 'warning', code: 'REPAIR_EXISTING_BRIDGE_UNKNOWN', message: `${repair.id}：${repair.net} 与 ${repair.otherNet} 之间已有 ${bridges.map((item) => item.designator).join('/')}，但无法确认阻值是否合格；为避免并联出错，本次不自动新增，请人工确认` });
      continue;
    }
    // 器件身份检查放在幂等判断**之后**：已经修好的项不需要器件，也就不会为它白等一次在线库检索
    if (!repair.device?.libraryUuid || !repair.device?.uuid) { findings.push({ severity: 'blocking', code: REPAIR_CODES.COMPONENT_CREATE_FAILED, message: `${repair.id} 缺少已确认的库身份（libraryUuid/uuid）` }); continue; }
    if (!Number.isFinite(Number(repair.position?.x)) || !Number.isFinite(Number(repair.position?.y))) { findings.push({ severity: 'blocking', code: REPAIR_CODES.NO_OPERATIONS, message: `${repair.id} 缺少落位坐标` }); continue; }
    operations.push({
      type: 'component.create', repairId: repair.id, expectedNet: repair.net,
      args: { component: { libraryUuid: repair.device.libraryUuid, uuid: repair.device.uuid }, x: round(repair.position.x), y: round(repair.position.y), rotation: 0, mirror: false, addIntoBom: true, addIntoPcb: repair.addIntoPcb !== false },
    });
    // pinIndex 是显式约定：目标网络接 1 脚（index 0），另一端接 2 脚（index 1）。
    // 不靠"net 名和 expectedNet 相不相等"去猜脚位——那种判断在"另一端"上必错。
    operations.push({ type: 'netPort.create', repairId: repair.id, expectedNet: repair.net, pinIndex: 0, args: { portType: 'BI', net: repair.net, x: null, y: null, rotation: 0, mirror: false } });
    operations.push({ type: 'netPort.create', repairId: repair.id, expectedNet: repair.otherNet, pinIndex: 1, args: { portType: 'BI', net: repair.otherNet, x: null, y: null, rotation: 0, mirror: false } });
    expectedGain[repair.net] = (expectedGain[repair.net] || 0) + 1;
    expectedGain[repair.otherNet] = (expectedGain[repair.otherNet] || 0) + 1;
    findings.push({ severity: 'info', code: 'REPAIR_PLANNED', message: `${repair.id}: ${repair.valueOhm}Ω 从 ${repair.net} 到 ${repair.otherNet}（当前 ${repair.net} 有 ${members.size} 个引脚）` });
    if (repair.addIntoPcb === false) findings.push({ severity: 'warning', code: 'REPAIR_NOT_IN_PCB', message: `${repair.id} 指定 addIntoPcb=false：真机实测这种元件**不出现在 EasyEDA 网表**里（原网表每个元件都是 Convert to PCB=yes），因此本次网表复核对它无效` });
  }
  return {
    ok: findings.every((item) => item.severity !== 'blocking') && (operations.length > 0 || satisfied.length > 0),
    operations,
    satisfied,
    expectedGain,
    findings,
  };
}

/**
 * 复核：修复后的网表必须"只多出该多出的引脚，别的什么都不许变"。
 * 只要有任何一条网络丢了引脚、或多出计划外引脚、或冒出计划外的新网络，就判不合格。
 */
export function diffRepairNetlist({ before, after, expectedGain = {}, createdPins = [], identityComplete = true } = {}) {
  const beforeNets = netlistPinCounts(before);
  const afterNets = netlistPinCounts(after);
  const created = new Set(createdPins);
  const missing = [];
  const gained = {};
  const unexpected = [];
  for (const [net, pins] of beforeNets) {
    const now = afterNets.get(net) || new Map();
    const lost = [...pins.entries()].filter(([pin, count]) => (now.get(pin) || 0) < count).map(([pin]) => pin);
    if (lost.length) missing.push({ net, pins: lost });
  }
  for (const [net, pins] of afterNets) {
    const previous = beforeNets.get(net) || new Map();
    const added = [];
    for (const [pin, count] of pins) {
      const delta = count - (previous.get(pin) || 0);
      for (let i = 0; i < delta; i += 1) added.push(pin);
    }
    if (!added.length) continue;
    gained[net] = added;
    const wanted = expectedGain[net] || 0;
    if (added.length !== wanted) unexpected.push({ net, added, expected: wanted, why: '引脚数与该网络计划新增数不一致' });
    // 元件标注（R1/R2…）由 EDA 异步完成：还没标注时位号是 `R?`，此时只保留计数校验并显式记录，绝不假装做了身份校验
    if (identityComplete && created.size && added.some((pin) => !created.has(pin))) unexpected.push({ net, added: added.filter((pin) => !created.has(pin)), why: '新增引脚不属于本次新建元件（可能短接到别处）' });
  }
  for (const [net, wanted] of Object.entries(expectedGain)) {
    if (!wanted) continue;
    const actual = (gained[net] || []).length;
    if (actual !== wanted) unexpected.push({ net, added: gained[net] || [], expected: wanted, why: '计划新增的引脚没有出现在该网络里' });
  }
  const lostPins = missing.reduce((sum, item) => sum + item.pins.length, 0);
  return { ok: unexpected.length === 0 && lostPins === 0, gained, missing, unexpected, identityComplete, summary: { gainedNets: Object.keys(gained).length, lostPins, unexpected: unexpected.length, identityComplete } };
}

export const documentSourceDigest = (source) => createHash('sha256').update(String(source ?? '')).digest('hex');

/**
 * 执行修复。顺序固定，任何一步失败都回滚到已建立的源码快照。
 *
 * @param {object} options
 * @param {(commandId:string, args:object, options?:object)=>Promise<any>} options.execute 受控执行入口
 * @param {(result:any)=>any} [options.unwrap] 去壳（桥的 `{result}` 包装）
 * @param {object} options.plan `planSchematicRepair` 的结果
 * @param {() => Promise<object>} options.readNetlist 导出官方网表并解析为对象
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.save=true] 验证通过后是否保存
 */
/**
 * 执行修复。顺序固定：快照 → 建元件 → 读回引脚 → 挂网络端口 → 保存 → 导网表复核。
 *
 * 两个真机教训直接写进了实现：
 *  1. **保存之前导出的网表不反映新图元**（实测：加了元件+端口、未保存就导出，网表毫无变化），
 *     所以复核必须放在保存之后——否则"没报错"会被误读成"已生效"。
 *  2. **`document.source.restore` 不可信**（实测返回 false 且没有回滚，原理图残留 5 个电阻+10 个端口）。
 *     撤销一律用"按图元 ID 精确删除 + 保存 + 逐项核实图元集合"，全量源码恢复只作兜底且仍要核实。
 *
 * @param {object} options
 * @param {(commandId:string, args:object, options?:object)=>Promise<any>} options.execute 受控执行入口
 * @param {(value:any)=>any} [options.unwrap] 去壳（桥的 `{result}` 包装）
 * @param {object} options.plan `planSchematicRepair` 的结果
 * @param {() => Promise<object>} options.readNetlist 导出官方网表并解析为对象
 * @param {() => Promise<{components:Array<object>}>} [options.readComponents] 读回图元（默认走 schematic.components）
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.save=true] 验证通过后是否保存
 */
export async function applySchematicRepair({ execute, unwrap = (value) => value?.result ?? value, plan, readNetlist, readComponents = null, dryRun = false, save = true } = {}) {
  if (!plan?.operations?.length) throw fail(REPAIR_CODES.NO_OPERATIONS, '修复计划为空：没有任何写入动作');
  const events = [];
  const event = (step, status, detail = {}) => events.push({ step, status, ...detail });
  if (dryRun) { event('dry-run', 'passed', { operations: plan.operations.length }); return { ok: true, dryRun: true, plan, events }; }

  const idOf = (item) => item?.primitiveId || item?.id || null;
  const loadComponents = readComponents || (async () => unwrap(await execute('schematic.components')) || {});
  const beforeComponents = (await loadComponents()).components || [];
  const beforeIds = new Set(beforeComponents.map(idOf).filter(Boolean));
  const before = await readNetlist();
  const source = unwrap(await execute('document.source.read', {}, { allowSensitiveRead: true }));
  if (typeof source !== 'string' || !source.length) throw fail(REPAIR_CODES.SNAPSHOT_EMPTY, '无法建立非空文档源码快照，拒绝写入');
  const snapshot = { digest: documentSourceDigest(source), size: source.length, source };
  event('snapshot', 'passed', { digest: snapshot.digest.slice(0, 12), size: snapshot.size, primitives: beforeIds.size });

  const createdPrimitives = [];
  const createdPortIds = [];
  const createdPins = [];
  /** 核实"是否真的回到修复前"：图元 ID 集合必须与修复前完全一致。 */
  const restoredClean = async () => {
    try {
      const now = (await loadComponents()).components || [];
      const nowIds = new Set(now.map(idOf).filter(Boolean));
      const extra = [...nowIds].filter((id) => !beforeIds.has(id));
      const missing = [...beforeIds].filter((id) => !nowIds.has(id));
      return { clean: extra.length === 0 && missing.length === 0, extra, missing, total: nowIds.size };
    } catch (error) { return { clean: false, extra: [], missing: [], total: null, error: String(error?.message || error).slice(0, 120) }; }
  };
  const rollback = async (code, message, extra = {}) => {
    const ids = [...createdPrimitives.map((item) => item.primitiveId), ...createdPortIds].filter(Boolean);
    let strategy = 'delete+save';
    let deleted = false;
    try {
      deleted = ids.length ? unwrap(await execute('schematic.component.delete', { primitiveIds: ids }, { allowWrite: true })) === true : true;
      if (deleted) unwrap(await execute('schematic.save', {}, { allowWrite: true }));
    } catch (error) { event('rollback.delete', 'failed', { error: String(error?.message || error).slice(0, 160) }); }
    let check = await restoredClean();
    if (!check.clean) {
      // 第二道：保存可能让旧 ID 失效（真机实测），所以改成"重新读回 → 把比修复前多出来的图元删掉"
      try {
        const now = (await loadComponents()).components || [];
        const extras = now.map(idOf).filter(Boolean).filter((id) => !beforeIds.has(id));
        if (extras.length) {
          strategy = 'delete-extras';
          unwrap(await execute('schematic.component.delete', { primitiveIds: extras }, { allowWrite: true }));
          unwrap(await execute('schematic.save', {}, { allowWrite: true }));
          check = await restoredClean();
        }
      } catch (error) { event('rollback.extras', 'failed', { error: String(error?.message || error).slice(0, 160) }); }
    }
    if (!check.clean) {
      strategy = 'source-restore';
      try {
        unwrap(await execute('document.source.restore', { source: snapshot.source }, { allowWrite: true }));
        unwrap(await execute('schematic.save', {}, { allowWrite: true }));
      } catch (error) { event('rollback.restore', 'failed', { error: String(error?.message || error).slice(0, 160) }); }
      check = await restoredClean();
    }
    event('rollback', check.clean ? 'passed' : 'failed', { reason: code, strategy, extra: check.extra?.length ?? null, missing: check.missing?.length ?? null });
    const finalCode = check.clean ? code : REPAIR_CODES.ROLLBACK_INCOMPLETE;
    const finalMessage = check.clean ? message : `回滚未能回到修复前状态（多出 ${check.extra?.length ?? '?'} 个图元）：${message}`;
    throw fail(finalCode, finalMessage, { ...extra, rolledBack: true, rollbackClean: check.clean, rollbackStrategy: strategy, events });
  };

  try {
    // 阶段 A：先把元件全部放上去，只收集图元 ID（不在这里按位号匹配，避免"刚建完读不到"的竞态）
    for (const operation of plan.operations.filter((item) => item.type === 'component.create')) {
      const result = unwrap(await execute('schematic.component.create', operation.args, { allowWrite: true }));
      const primitiveId = result?.primitiveId || result?.id;
      if (!primitiveId) await rollback(REPAIR_CODES.COMPONENT_CREATE_FAILED, `${operation.repairId} 放置元件后未返回图元 ID`);
      createdPrimitives.push({ repairId: operation.repairId, primitiveId });
      event('component.create', 'passed', { repairId: operation.repairId, primitiveId });
    }

    // 阶段 B：统一读回元件与引脚坐标。位号与引脚坐标都以此为准，坐标同时用于端口落点。
    const data = await loadComponents();
    const componentById = new Map((data.components || []).map((item) => [idOf(item), item]));
    const pinsByRepair = new Map();
    for (const created of createdPrimitives) {
      const component = componentById.get(created.primitiveId);
      if (!component) await rollback(REPAIR_CODES.COMPONENT_CREATE_FAILED, `${created.repairId} 放置后读不回该元件（图元 ID ${created.primitiveId}）`);
      const pins = data.pins?.[created.primitiveId] || [];
      if (pins.length < 2) await rollback(REPAIR_CODES.PIN_UNRESOLVED, `${created.repairId} 新建元件只有 ${pins.length} 个引脚，无法挂接两个网络`);
      const resolved = pins.map((pin) => {
        const x = Number(pin?.x ?? pin?.position?.x ?? (pin?.getState_X ? pin.getState_X() : NaN));
        const y = Number(pin?.y ?? pin?.position?.y ?? (pin?.getState_Y ? pin.getState_Y() : NaN));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { pinNumber: String(pin.pinNumber ?? pin.number ?? ''), x, y };
      });
      if (resolved.some((pin) => !pin)) await rollback(REPAIR_CODES.PIN_UNRESOLVED, `${created.repairId} 引脚坐标不可解析`);
      for (const pin of resolved) createdPins.push(`${component.designator}.${pin.pinNumber}`);
      pinsByRepair.set(created.repairId, resolved);
      event('component.pins', 'passed', { repairId: created.repairId, designator: component.designator, pins: resolved.length });
    }

    // 阶段 C：端口落在刚读回的引脚坐标上——端口即网络名，不需要导线
    for (const operation of plan.operations.filter((item) => item.type === 'netPort.create')) {
      const pins = pinsByRepair.get(operation.repairId) || [];
      const pin = pins[operation.pinIndex ?? 0];
      if (!pin) await rollback(REPAIR_CODES.PORT_CREATE_FAILED, `${operation.repairId} 找不到可挂接 ${operation.args.net} 的引脚`);
      const result = unwrap(await execute('schematic.netPort.create', { ...operation.args, x: pin.x, y: pin.y }, { allowWrite: true }));
      const primitiveId = result?.primitiveId || result?.id;
      if (!primitiveId) await rollback(REPAIR_CODES.PORT_CREATE_FAILED, `${operation.repairId} 创建网络端口 ${operation.args.net} 失败`);
      createdPortIds.push(primitiveId);
      event('netPort.create', 'passed', { repairId: operation.repairId, net: operation.args.net, x: pin.x, y: pin.y, primitiveId });
    }

    // 阶段 D：先保存再复核——保存前的网表看不到新图元（真机实测）
    if (save) {
      const saved = unwrap(await execute('schematic.save', {}, { allowWrite: true }));
      if (saved !== true) await rollback(REPAIR_CODES.NETLIST_UNCHANGED, '嘉立创EDA 未确认保存成功');
      event('save', 'passed');
    }
    // 保存后位号通常已落定（真机：保存前读回是 `R?`，网表里已是 R1/R2…）。等一小会儿再读，尽量拿到真位号。
    let identityPins = createdPins;
    let identityComplete = createdPins.length > 0 && createdPins.every((pin) => !pin.includes('?'));
    if (save) {
      let post = (await loadComponents()).components || [];
      // 标注是异步的：最多等 3 秒，等到位号不再是 `R?`（拿不到就只做计数校验，并在事件里写明）
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const mine = post.filter((item) => createdPrimitives.some((created) => created.primitiveId === idOf(item)));
        if (mine.length === createdPrimitives.length && mine.every((item) => item.designator && !String(item.designator).includes('?'))) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
        post = (await loadComponents()).components || [];
      }
      const byId = new Map(post.map((item) => [idOf(item), item]));
      const refreshed = createdPrimitives.map((item) => byId.get(item.primitiveId)).filter(Boolean);
      if (refreshed.length === createdPrimitives.length && refreshed.every((item) => item.designator && !String(item.designator).includes('?'))) {
        identityPins = refreshed.flatMap((item) => (data.pins?.[idOf(item)] || []).map((pin) => `${item.designator}.${String(pin.pinNumber ?? pin.number ?? '')}`));
        identityComplete = true;
      } else {
        identityComplete = false;
        event('identity.check', 'skipped', { why: '元件位号尚未标注（R?），本次只做"每个网络新增引脚数"的计数校验' });
      }
    }
    const after = await readNetlist();
    const diff = diffRepairNetlist({ before, after, expectedGain: plan.expectedGain, createdPins: identityPins, identityComplete });
    if (!diff.ok) await rollback(REPAIR_CODES.NETLIST_UNEXPECTED_CHANGE, `修复后网表不符合预期：${JSON.stringify(diff.unexpected).slice(0, 240)}`, { diff });
    event('netlist.verify', 'passed', { gained: Object.keys(diff.gained), identityComplete });
    const persistedDiff = save ? diffRepairNetlist({ before, after: await readNetlist(), expectedGain: plan.expectedGain, createdPins: identityPins, identityComplete }) : null;
    if (persistedDiff) event('netlist.persisted', persistedDiff.ok ? 'passed' : 'failed', persistedDiff.ok ? {} : { unexpected: persistedDiff.unexpected });
    return { ok: true, dryRun: false, saved: save, snapshot: { digest: snapshot.digest, size: snapshot.size }, createdPins, createdPrimitives, createdPortIds, diff, persisted: persistedDiff, events };
  } catch (error) {
    if (error?.rolledBack) throw error;
    event('failed', 'error', { message: String(error?.message || error).slice(0, 200) });
    const ids = [...createdPrimitives.map((item) => item.primitiveId), ...createdPortIds].filter(Boolean);
    try {
      if (ids.length) unwrap(await execute('schematic.component.delete', { primitiveIds: ids }, { allowWrite: true }));
      unwrap(await execute('schematic.save', {}, { allowWrite: true }));
    } catch { /* 下面的核实会如实报出没清干净 */ }
    const check = await restoredClean();
    event('rollback', check.clean ? 'passed' : 'failed', { reason: 'unexpected-error' });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { rolledBack: true, rollbackClean: check.clean, events });
  }
}
