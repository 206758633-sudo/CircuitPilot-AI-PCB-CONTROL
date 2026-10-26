/**
 * 网络连通性审计：判断"原理图网表 ↔ PCB 焊盘网络"是否真的一致。
 *
 * 为什么需要它（2026-10-22 某真实项目案例 真机教训）：
 *   原理图验收链（schematic-acceptance）只看三件事：网表能导出、ERC 无 error、器件数对得上。
 *   这三条全部通过时 ready=true —— 但真机读回来却是：
 *     · 网表里 226 个引脚有 171 个 `net` 为空（EasyEDA 导出对未命名网络/未解析连接不给名字）；
 *     · 网表里根本没有 GND 网络，USB1 的 GND 引脚全挂在 +3V3 上，MK1 的 GND 焊盘也挂在 +3V3 上；
 *     · PCB 侧 278 个焊盘有 171 个没有网络（旧版板子遗留的空网络，靠"写焊盘网络"补出来的）。
 *   于是"验收通过"和"板子能造"之间没有任何东西把关：一条空网络、一条把 GND 并进 +3V3 的
 *   错误映射，都不会让任何现有门禁变红。这个模块补的就是这道门禁。
 *
 * 数据来源（都不依赖任何"编辑器内存状态"）：
 *   · 网表：`sch_ManufactureData.getNetlistFile(fileName, 'EasyEDA')` 的 JSON 文本（唯一权威网络读回；
 *     `sch_Net` 在原理图上下文返回 0 条网络，见审计文档）。
 *   · 焊盘：`pcb_PrimitiveComponent.getAll()` 每个器件的 `pads[]`（padNumber / net）。
 *
 * 判定口径（blocking = 不能出制造文件；warning = 记录但不阻断）：
 *   1. 网表拿不到 / 解析不了 / 没有任何器件 → blocking；
 *   2. 网表引脚没有网络：比例 > 5% → blocking（说明网络没解析出来，下游"网络比对"全是空转）；
 *      比例 ≤ 5% → warning（允许少量未命名网络）；
 *   3. PCB 焊盘没有网络 → blocking（焊盘无网络 = 制造出来是断路/短路随机数）；
 *   4. 网表里不存在任何地网络（GND/AGND/DGND/PGND/VSS…） → blocking；
 *   5. 同一位号同一引脚号：网表网络与焊盘网络不一致 → blocking；
 *   6. 焊盘网络不在网表网络集合里 → warning（网表会省略匿名网络，单凭它不能断言错误）。
 */

export const NET_CONNECTIVITY_CODES = {
  NETLIST_UNAVAILABLE: 'NET_CONNECTIVITY_NETLIST_UNAVAILABLE',
  NETLIST_INVALID: 'NET_CONNECTIVITY_NETLIST_INVALID',
  NETLIST_INCOMPLETE: 'NET_CONNECTIVITY_NETLIST_INCOMPLETE',
  PIN_WITHOUT_NET: 'NET_CONNECTIVITY_PIN_WITHOUT_NET',
  PAD_WITHOUT_NET: 'NET_CONNECTIVITY_PAD_WITHOUT_NET',
  MISSING_GROUND_NET: 'NET_CONNECTIVITY_MISSING_GROUND_NET',
  PIN_PAD_NET_MISMATCH: 'NET_CONNECTIVITY_PIN_PAD_NET_MISMATCH',
  PAD_NET_NOT_IN_NETLIST: 'NET_CONNECTIVITY_PAD_NET_NOT_IN_NETLIST',
};

/** 引脚无网络占比超过它就判 blocking（留 5% 余量给"匿名网络"这类合法情况）。 */
const PIN_NET_GAP_BLOCKING_RATIO = 0.05;
const GROUND_NET_PATTERN = /^(?:GND|AGND|DGND|PGND|GNDA|GNDD|SGND|VSS|0V?)(?:\d+)?$/i;

const finding = (code, severity, field, message, extra = {}) => ({ code, severity, field, message, ...extra });

/**
 * 解析 EasyEDA 网表 JSON 文本。
 * @param {string|null|undefined} netlistText
 * @returns {{ok: boolean, reason?: string, error?: string, components?: Array, netNames?: Set<string>, netCount?: number}}
 */
export function parseEasyEdaNetlist(netlistText) {
  if (typeof netlistText !== 'string' || !netlistText.trim()) return { ok: false, reason: 'EMPTY' };
  let data = null;
  try {
    data = JSON.parse(netlistText);
  } catch (error) {
    return { ok: false, reason: 'JSON_PARSE_FAILED', error: String(error?.message || error).slice(0, 200) };
  }
  const rawComponents = data?.components;
  if (!rawComponents || typeof rawComponents !== 'object') return { ok: false, reason: 'NO_COMPONENTS_SECTION' };
  const components = [];
  const netNames = new Set();
  for (const [uid, raw] of Object.entries(rawComponents)) {
    const props = raw?.props || {};
    const designator = String(props.Designator ?? props.designator ?? raw?.designator ?? uid);
    const pins = [];
    const pinInfoMap = raw?.pinInfoMap || {};
    for (const [pinKey, pinValue] of Object.entries(pinInfoMap)) {
      const number = String(pinValue?.number ?? pinValue?.props?.['Pin Number'] ?? pinKey);
      const net = String(pinValue?.net ?? '');
      if (net) netNames.add(net);
      pins.push({ number, name: String(pinValue?.name ?? ''), net });
    }
    components.push({ uid, designator, pins });
  }
  return { ok: true, data, components, netNames, netCount: netNames.size };
}

/**
 * 把 PCB 侧器件（含 pads）归一化成 {designator, pads:[{number, net}]}。
 * 兼容 `pads[].padNumber`（EDA 原始读回）与 `pads[].number`（测试/证据文件）。
 */
export function normalizePcbComponents(components) {
  const list = [];
  for (const comp of Array.isArray(components) ? components : []) {
    const designator = String(comp?.designator ?? comp?.ref ?? comp?.refdes ?? '');
    const pads = [];
    for (const pad of Array.isArray(comp?.pads) ? comp.pads : []) {
      pads.push({
        number: String(pad?.padNumber ?? pad?.number ?? pad?.num ?? ''),
        net: String(pad?.net ?? ''),
      });
    }
    list.push({ designator, footprint: comp?.footprint?.name ?? comp?.footprint ?? null, pads });
  }
  return list;
}

const summarize = (values, max = 8) => values.slice(0, max).join('；') + (values.length > max ? `；…另 ${values.length - max} 项` : '');

/**
 * 审计网络连通性。
 * @param {{netlistText?: string|null, components?: Array, groundNets?: string[]|null, maxListed?: number, noConnectPins?: Array<{designator:string,pin:string}>}} input
 * @returns {{ready: boolean, findings: Array, counts: object, nets: string[], details: object}}
 */
export function auditNetConnectivity({ netlistText = null, components = [], groundNets = null, maxListed = 8, noConnectPins = [] } = {}) {
  const findings = [];
  const pcb = normalizePcbComponents(components);
  // 显式 No-Connect（真机 `pin.setState_NoConnected(true)`）的引脚/焊盘不算"没有网络"：
  // 网表导出不携带 NC 标记，缺了这份映射就会把 33 个有意悬空的引脚报成 13.9% 无网络（
  // 2026-10-22 真机：原理图侧已逐个标 NC、PCB 侧焊盘因此没有网络，闸门却判"网络没解析出来"）。
  const noConnectKey = (designator, pin) => `${String(designator || '').trim()}.${String(pin ?? '').trim()}`;
  const noConnectSet = new Set((Array.isArray(noConnectPins) ? noConnectPins : [])
    .filter((entry) => entry && entry.designator && entry.pin !== undefined && entry.pin !== null)
    .map((entry) => noConnectKey(entry.designator, entry.pin)));
  const counts = {
    pcbComponents: pcb.length,
    pads: 0,
    padsWithNet: 0,
    padsWithoutNet: 0,
    netlistPins: 0,
    netlistPinsWithNet: 0,
    netlistPinsWithoutNet: 0,
    netlistPinsNoConnectExplained: 0,
    padsNoConnectExplained: 0,
    netlistComponents: 0,
    matchedComponents: 0,
    mismatchedPins: 0,
    nets: 0,
  };
  const padsWithoutNet = [];
  const padNetByDesignator = new Map();
  for (const comp of pcb) {
    const entries = padNetByDesignator.get(comp.designator) || [];
    for (const pad of comp.pads) {
      counts.pads += 1;
      if (pad.net) counts.padsWithNet += 1;
      else if (noConnectSet.has(noConnectKey(comp.designator, pad.number))) { counts.padsNoConnectExplained += 1; }
      else { counts.padsWithoutNet += 1; padsWithoutNet.push(`${comp.designator}.${pad.number || '?'}`); }
      entries.push(pad);
    }
    padNetByDesignator.set(comp.designator, entries);
  }

  const parsed = parseEasyEdaNetlist(netlistText);
  const netlistComponentByDesignator = new Map();
  const pinGaps = [];
  if (!netlistText) {
    findings.push(finding(NET_CONNECTIVITY_CODES.NETLIST_UNAVAILABLE, 'blocking', 'netlist',
      '没有拿到原理图网表：无法判定网络连通性（"没网表"不等于"没问题"）'));
  } else if (!parsed.ok) {
    findings.push(finding(NET_CONNECTIVITY_CODES.NETLIST_INVALID, 'blocking', 'netlist',
      `网表不可用（${parsed.reason}${parsed.error ? `：${parsed.error}` : ''}）：无法判定网络连通性`));
  } else if (!parsed.components.length) {
    findings.push(finding(NET_CONNECTIVITY_CODES.NETLIST_INVALID, 'blocking', 'netlist',
      '网表里一个器件都没有：导出结果不是有效网表（或导出的是空文档）'));
  } else {
    counts.netlistComponents = parsed.components.length;
    for (const comp of parsed.components) {
      netlistComponentByDesignator.set(comp.designator, comp);
      for (const pin of comp.pins) {
        counts.netlistPins += 1;
        if (pin.net) counts.netlistPinsWithNet += 1;
        else if (noConnectSet.has(noConnectKey(comp.designator, pin.number))) { counts.netlistPinsNoConnectExplained += 1; }
        else { counts.netlistPinsWithoutNet += 1; pinGaps.push(pin.number); }
      }
    }
    counts.nets = parsed.netCount;
    const gapRatio = counts.netlistPins ? counts.netlistPinsWithoutNet / counts.netlistPins : 0;
    if (counts.netlistPinsWithoutNet > 0) {
      const list = [];
      for (const comp of parsed.components) for (const pin of comp.pins) if (!pin.net && !noConnectSet.has(noConnectKey(comp.designator, pin.number))) list.push(`${comp.designator}.${pin.number || '?'}`);
      const message = `网表有 ${counts.netlistPinsWithoutNet}/${counts.netlistPins} 个引脚没有网络（${Math.round(gapRatio * 1000) / 10}%）：`
        + `下游"网络比对"对这些引脚全是空转。样例：${summarize(list, maxListed)}`
        + (counts.netlistPinsNoConnectExplained ? `（另有 ${counts.netlistPinsNoConnectExplained} 个引脚已显式标记 No-Connect，已单独归因，不计入缺网）` : '');
      findings.push(finding(NET_CONNECTIVITY_CODES.PIN_WITHOUT_NET, gapRatio > PIN_NET_GAP_BLOCKING_RATIO ? 'blocking' : 'warning', 'netlist', message,
        { pinGapRatio: Math.round(gapRatio * 1000) / 1000 }));
    }
    const groundNames = Array.isArray(groundNets) && groundNets.length ? groundNets.map(String) : null;
    const groundNetsFound = [...parsed.netNames].filter((name) => (groundNames ? groundNames.includes(name) : GROUND_NET_PATTERN.test(name)));
    if (!groundNetsFound.length) {
      findings.push(finding(NET_CONNECTIVITY_CODES.MISSING_GROUND_NET, 'blocking', 'netlist',
        `网表里没有任何地网络（期望 ${groundNames ? groundNames.join('/') : 'GND/AGND/DGND/PGND/VSS'} 之一）：`
        + `通常是地引脚被误并到电源网络，或网络解析没建立起来。本网表网络：${summarize([...parsed.netNames], 12) || '（空）'}`));
    }
  }

  if (counts.padsWithoutNet > 0) {
    const padGapRatio = counts.pads ? counts.padsWithoutNet / counts.pads : 0;
    findings.push(finding(NET_CONNECTIVITY_CODES.PAD_WITHOUT_NET, padGapRatio > PIN_NET_GAP_BLOCKING_RATIO ? 'blocking' : 'warning', 'pcb',
      `PCB 有 ${counts.padsWithoutNet}/${counts.pads} 个焊盘没有网络（${Math.round(padGapRatio * 1000) / 10}%）：这样的焊盘制造出来连接关系是随机的。样例：${summarize(padsWithoutNet, maxListed)}`
      + (counts.padsNoConnectExplained ? `（另有 ${counts.padsNoConnectExplained} 个焊盘对应原理图 No-Connect 引脚，已按"有意不接"归因）` : '')));
  }

  const mismatches = [];
  if (parsed.ok && parsed.components.length) {
    for (const [designator, comp] of netlistComponentByDesignator) {
      const pads = padNetByDesignator.get(designator);
      if (!pads) continue;
      counts.matchedComponents += 1;
      const padsByNumber = new Map();
      for (const pad of pads) {
        const list = padsByNumber.get(pad.number) || [];
        list.push(pad.net);
        padsByNumber.set(pad.number, list);
      }
      for (const pin of comp.pins) {
        const padNets = padsByNumber.get(pin.number);
        if (!padNets) continue; // 引脚没有焊盘属于 footprint-integrity 的判定范围
        const uniquePadNets = [...new Set(padNets.map((net) => net || ''))];
        const wrong = uniquePadNets.filter((net) => (net || '') !== pin.net);
        if (wrong.length) {
          counts.mismatchedPins += 1;
          mismatches.push(`${designator}.${pin.number}：网表=${pin.net || '（空）'} / 焊盘=${uniquePadNets.map((n) => n || '（空）').join(',')}`);
        }
      }
    }
    if (mismatches.length) {
      findings.push(finding(NET_CONNECTIVITY_CODES.PIN_PAD_NET_MISMATCH, 'blocking', 'pcb',
        `${mismatches.length} 个引脚号的网络在"原理图网表"和"PCB 焊盘"之间不一致（说明 PCB 网络不是从原理图导入的，或导入后被手写过）：${summarize(mismatches, maxListed)}`));
    }
    const netlistNets = parsed.netNames;
    const padNetsOutside = [];
    for (const comp of pcb) for (const pad of comp.pads) if (pad.net && !netlistNets.has(pad.net)) padNetsOutside.push(`${comp.designator}.${pad.number || '?'}=${pad.net}`);
    if (padNetsOutside.length) {
      const unique = [...new Set(padNetsOutside)];
      findings.push(finding(NET_CONNECTIVITY_CODES.PAD_NET_NOT_IN_NETLIST, 'warning', 'pcb',
        `${unique.length} 类焊盘网络在原理图网表里找不到（网表会省略匿名网络，此项只作告警）：${summarize(unique, maxListed)}`));
    }
  }

  const blocking = findings.filter((entry) => entry.severity === 'blocking');
  return {
    ready: blocking.length === 0,
    findings,
    counts,
    nets: parsed.ok ? [...parsed.netNames].sort() : [],
    details: {
      pinGaps: pinGaps.slice(0, 50),
      padsWithoutNet: padsWithoutNet.slice(0, 50),
      mismatches: mismatches.slice(0, 50),
      groundNets: parsed.ok ? [...parsed.netNames].filter((name) => GROUND_NET_PATTERN.test(name)) : [],
    },
  };
}
