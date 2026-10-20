/**
 * 原理图网表校验——回答"原理图到底实现没实现网络"这个问题。
 *
 * 为什么单独做这件事：真机实测真实工程的原理图有 **68 个图元、59 条导线、ERC 0 错误 3 警告**，
 * 看起来"画好了"；但导出的网表里 `components=8, nets=0`——**一条电气网络都没有**。
 * 根因是那 59 条导线的 `net` 字段全部为空字符串（纯图形线），
 * 而引脚上却写着 `SDA/GND/3V3`。只看"图元数量 + ERC 无错误"永远发现不了这件事，
 * 而且它会让「把原理图同步到 PCB」拿到一张空网表。
 *
 * 因此本模块的第一职责是：**把"网表里有没有网络"变成阻断级判据**，
 * 并明确区分"ERC 无错误"与"真的有网络"两件事。
 */
import { createHash } from 'node:crypto';

const fail = (code, message, path, severity = 'blocking') => ({ code, message, path, severity });
const text = (value) => (value === undefined || value === null ? '' : String(value));

/**
 * 解析 EasyEDA/JLCEDA 网表 JSON（v2.0.0 形状：components{id:{props,pinInfoMap}} + nets{}）。
 * nets 缺失或为 {} 都是合法输入——**必须解析成功并如实报告 0 条网络**，绝不抛错掩盖。
 */
export function parseEasyEdaNetlist(source) {
  const holder = typeof source === 'string' ? { text: source } : (source || {});
  if (holder.parsed && !holder.text) return holder.parsed;
  if (typeof holder.text !== 'string' || !holder.text.trim()) return null;
  let raw;
  try { raw = JSON.parse(holder.text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const components = Object.entries(raw.components || {}).map(([instanceId, entry]) => {
    const props = entry?.props || {};
    const pinInfoMap = entry?.pinInfoMap || {};
    const pins = Object.entries(pinInfoMap).map(([key, pin]) => ({
      key: text(key),
      name: text(pin?.name),
      number: text(pin?.number ?? key),
      net: text(pin?.net),
    }));
    return {
      instanceId,
      designator: text(props.Designator),
      part: text(props.Name),
      manufacturer: text(props.Manufacturer),
      manufacturerPart: text(props['Manufacturer Part']),
      supplier: text(props.Supplier),
      supplierPart: text(props['Supplier Part']),
      footprint: text(props.Footprint),
      device: text(props.Device),
      symbol: text(props.Symbol),
      addIntoBom: text(props['Add into BOM']).toLowerCase() === 'yes',
      convertToPcb: text(props['Convert to PCB']).toLowerCase() === 'yes',
      pins,
    };
  });
  // 网络从哪里来 —— 这里有个**必须记住的教训**：EasyEDA v2.0.0 网表**没有 `nets` 键**
  // （顶层只有 version/components/designRule/differentialPair/netClass/equalLengthNetGroup）。
  // 第一版实现只读 `raw.nets`，于是在一份**正常**的网表上得出"0 条网络"，
  // 差点把一个完好的原理图判成"没有任何电气连接"。真实网络来源有三个，必须合并：
  //   1) 引脚上的网名 `components[*].pinInfoMap[*].net`
  //   2) 设计规则表 `designRule.netRule` 的键（就是网络名）
  //   3) 少数格式/版本里真的存在 `nets` 对象
  const pinsWithNets = components.flatMap((component) => component.pins.filter((pin) => pin.net).map((pin) => ({ designator: component.designator, pin: pin.number, net: pin.net })));
  const explicitNets = Object.entries(raw.nets || {}).map(([name, entry]) => ({ name, pins: Array.isArray(entry?.pins) ? entry.pins.map((pin) => text(pin)) : [] }));
  const ruleNetNames = Object.keys(raw.designRule?.netRule || {});
  const pinNetNames = [...new Set(pinsWithNets.map((pin) => pin.net))];
  const names = [...new Set([...explicitNets.map((net) => net.name), ...ruleNetNames, ...pinNetNames])];
  const nets = names.map((name) => {
    const explicit = explicitNets.find((net) => net.name === name);
    const pins = explicit?.pins?.length ? explicit.pins : pinsWithNets.filter((pin) => pin.net === name).map((pin) => `${pin.designator}.${pin.pin}`);
    return {
      name, net: name, pins,
      sources: [explicit ? 'nets' : null, ruleNetNames.includes(name) ? 'designRule.netRule' : null, pinNetNames.includes(name) ? 'pinInfoMap' : null].filter(Boolean),
    };
  });
  const netsSource = explicitNets.length ? 'nets' : (ruleNetNames.length ? 'designRule.netRule+pinInfoMap' : (pinNetNames.length ? 'pinInfoMap' : 'none'));
  return {
    version: text(raw.version),
    topLevelKeys: Object.keys(raw),
    components,
    nets,
    componentCount: components.length,
    netCount: nets.length,
    netsSource,
    pinCount: components.reduce((sum, component) => sum + component.pins.length, 0),
    namedPinCount: components.reduce((sum, component) => sum + component.pins.filter((pin) => pin.net).length, 0),
    digest: createHash('sha256').update(holder.text).digest('hex'),
  };
}

/** ERC 原始返回（真机是 `[{type:'warn',count:3}]` 这类聚合项）→ 计数与"是否有明细"的诚实描述。 */
export function summarizeErc(erc) {
  const groups = Array.isArray(erc) ? erc : (erc ? [erc] : []);
  let errors = 0; let warnings = 0; let infos = 0; let detailed = 0;
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const count = Number(group.count ?? 0) || 0;
    const type = text(group.type).toLowerCase();
    if (group.message || group.description) detailed += 1;
    if (type === 'error' || type === 'err') errors += count;
    else if (type === 'warn' || type === 'warning') warnings += count;
    else infos += count;
  }
  return {
    ran: groups.length > 0,
    errors, warnings, infos,
    detailAvailable: detailed > 0,
    groups: groups.map((group) => ({ type: text(group?.type), count: Number(group?.count ?? 0) || 0 })),
  };
}

/**
 * 原理图 vs 语义计划 的硬校验。
 * @param {{netlist?: object, netlistText?: string, plan?: object, erc?: any}} input
 */
export function verifySchematic({ netlist = null, netlistText = null, plan = null, erc = null } = {}) {
  const findings = [];
  const parsed = netlist || parseEasyEdaNetlist(netlistText ?? '');
  if (!parsed) {
    return { parsed: null, erc: summarizeErc(erc), findings: [fail('NETLIST_UNPARSEABLE', '网表无法解析（不是合法 JSON 或为空）', 'netlist')], ready: false };
  }
  if (!parsed.components.length) findings.push(fail('SCHEMATIC_NO_COMPONENTS', '网表里没有任何元件：原理图没有可同步到PCB的内容', 'netlist.components'));

  // 第一判据：有元件却一条网络都没有 —— 这会让「原理图同步到PCB」拿到空网表。
  if (parsed.components.length && parsed.netCount === 0) {
    // 三个来源（nets / designRule.netRule / 引脚网名）都为空，才算"真的没有网络"。
    const evidence = parsed.namedPinCount ? `；有${parsed.namedPinCount}/${parsed.pinCount}个引脚带网名但未被识别为网络，请检查网表格式` : '；引脚也没有网名';
    findings.push(fail('SCHEMATIC_NETLIST_NO_NETS', `网表有${parsed.components.length}个元件但0条网络（来源=${parsed.netsSource}）${evidence}`, 'netlist.nets'));
  }

  // 只有 1 个引脚的网络 = 悬空网络：真机实测本工程 CC1/CC2 各只有 1 脚，
  // 正是"USB-C 缺 5.1kΩ Rd 下拉"这个设计缺口在网表层的可判定证据。
  if (parsed.netCount > 0) {
    const singlePin = parsed.nets.filter((net) => net.pins.length === 1).map((net) => `${net.name}(${net.pins[0]})`);
    if (singlePin.length) findings.push(fail('SCHEMATIC_NET_SINGLE_PIN', `有${singlePin.length}条网络只有1个引脚（悬空网络）：${singlePin.slice(0, 8).join(' ')}`, 'netlist.nets'));
    // 只在规则表里声明、没有任何引脚使用的网络：算警告（可能是预留/待接，也可能是取消失败留下的孤网）。
    const noPin = parsed.nets.filter((net) => net.pins.length === 0).map((net) => net.name);
    if (noPin.length) findings.push(fail('SCHEMATIC_NET_NO_PINS', `有${noPin.length}条网络只被声明、没有任何引脚使用：${noPin.slice(0, 8).join(',')}`, 'netlist.nets', 'warning'));
  }

  // 未连接引脚：网表里没有任何网名的引脚。不算错误（NC 引脚本来就该空着），但必须报出来——
  // 因为"忘了连"和"故意不连"在网表上长得一模一样，只有人能判断。真机：本工程 86 脚里 27 脚无网名。
  const unconnected = parsed.components
    .map((component) => ({ designator: component.designator, pins: component.pins.filter((pin) => !pin.net).map((pin) => pin.number) }))
    .filter((entry) => entry.pins.length);
  if (unconnected.length) {
    const total = unconnected.reduce((sum, entry) => sum + entry.pins.length, 0);
    const detail = unconnected.slice(0, 6).map((entry) => `${entry.designator}(${entry.pins.length}脚:${entry.pins.slice(0, 6).join(',')}${entry.pins.length > 6 ? '…' : ''})`).join(' ');
    findings.push(fail('SCH_PIN_NO_NET', `${total}个引脚没有网名（NC 与漏连在网表上无法区分，需人工确认）：${detail}`, 'netlist.components', 'warning'));
  }
  // 匿名网络（N$123 / net1 之类自动名）：说明有人画了连接但没命名，PCB 阶段很难排查。
  const unnamed = parsed.nets.filter((net) => /^(?:n\$|\$n|net)\d+$/i.test(net.name) || /^N\d+$/i.test(net.name)).map((net) => net.name);
  if (unnamed.length) findings.push(fail('SCH_NET_UNNAMED', `有${unnamed.length}条网络没有名字（自动命名）：${unnamed.slice(0, 8).join(',')}`, 'netlist.nets', 'warning'));

  // 注：这里曾有一条"引脚网名在网表网络列表里找不到"的判据。引脚网名现在本身就是网络来源，
  // 该判据在结构上永不可能触发——**不可达的判据就是误导**，所以删掉而不是留着凑数。

  // 与语义计划比对：元件缺失 / 身份不符 / 计划网络缺失。
  if (plan) {
    const byDesignator = new Map(parsed.components.filter((component) => component.designator).map((component) => [component.designator, component]));
    const missingRefs = (plan.components || []).map((component) => text(component.ref)).filter((ref) => ref && !byDesignator.has(ref));
    if (missingRefs.length) findings.push(fail('SCHEMATIC_COMPONENT_MISSING', `计划里的元件在原理图网表中不存在：${missingRefs.join(',')}`, 'netlist.components'));
    const identityMismatch = [];
    for (const component of plan.components || []) {
      const found = byDesignator.get(text(component.ref));
      if (!found) continue;
      const wanted = text(component.lcscId).toUpperCase();
      const actual = text(found.supplierPart).toUpperCase();
      // 空值不算"不一致"（计划可以不写LCSC号），但两边都写了就**必须一致**：
      // 这是"器件身份是否被编造"的第一道交叉校验。
      if (wanted && actual && wanted !== actual) identityMismatch.push(`${component.ref}: 计划${wanted}≠原理图${actual}`);
    }
    if (identityMismatch.length) findings.push(fail('SCHEMATIC_LCSC_MISMATCH', `元件立创料号与计划不一致：${identityMismatch.join(' ')}`, 'netlist.components'));
    const planNets = (plan.nets || []).map((net) => text(net.name)).filter(Boolean);
    if (planNets.length && parsed.netCount > 0) {
      const missingNets = planNets.filter((name) => !parsed.nets.some((net) => net.name === name));
      if (missingNets.length) findings.push(fail('SCHEMATIC_NET_MISSING', `计划里的网络在原理图网表中不存在：${missingNets.slice(0, 8).join(',')}`, 'netlist.nets'));
    } else if (planNets.length && parsed.netCount === 0) {
      findings.push(fail('SCHEMATIC_PLAN_NETS_UNREALIZED', `计划声明了${planNets.length}条网络（${planNets.slice(0, 6).join(',')}…），而原理图网表0条网络：计划没有被画成真实连接`, 'netlist.nets'));
    }
  }

  // ERC：只有"有错误"才阻断；并且必须如实说明它是否只有聚合计数。
  const ercSummary = summarizeErc(erc);
  if (!ercSummary.ran) findings.push(fail('SCHEMATIC_ERC_NOT_RUN', '没有ERC结果：不能声称原理图已通过电气规则检查', 'erc', 'warning'));
  else {
    if (ercSummary.errors > 0) findings.push(fail('SCHEMATIC_ERC_ERROR', `ERC报告${ercSummary.errors}个错误`, 'erc'));
    if (ercSummary.warnings > 0) findings.push(fail('SCHEMATIC_ERC_WARNING', `ERC报告${ercSummary.warnings}个警告`, 'erc', 'warning'));
    if (!ercSummary.detailAvailable) findings.push(fail('SCHEMATIC_ERC_AGGREGATE_ONLY', 'ERC只返回按类型聚合的计数、没有明细：它只能当"有无错误"的粗门禁，不能当逐条修复依据', 'erc', 'info'));
  }

  return {
    parsed,
    erc: ercSummary,
    findings,
    // ready 只由阻断项决定；info/warning 不影响放行但必须显示。
    ready: findings.every((finding) => finding.severity !== 'blocking'),
    identity: parsed.components.map((component) => ({
      designator: component.designator, part: component.part, manufacturer: component.manufacturer,
      manufacturerPart: component.manufacturerPart, supplier: component.supplier, supplierPart: component.supplierPart,
      footprint: component.footprint, pins: component.pins.length, namedPins: component.pins.filter((pin) => pin.net).length,
    })),
  };
}
