import { createHash } from 'node:crypto';

/**
 * Netlist Auditor（W4-01）：把“设计意图网表”与“EDA 实际网表”逐引脚比对。
 *
 * ## 为什么是独立 agent
 *
 * 生成方（AI/设计流程）不能给自己发合格证。审计只读两样输入：
 *   1. 意图网表（design-spec 的 `netIntent`，或已审核网表 `{nets:[{name,endpoints}]}`）；
 *   2. EDA 导出的实际网表（嘉立创 EDA `schematic.netlist.export` 的 EasyEDA JSON；
 *      也兼容 `{nets:[...]}` 这类规范化结构，便于测试与离线回放）。
 * 输出是**逐条可定位**的 diff 证据：哪根网络、哪个位号、哪个引脚、期望什么、实际什么。
 *
 * ## 实际网表格式（真机验证 2026-10-21）
 *
 * EasyEDA 导出是 `{components: {uniqueId: {props:{Designator}, pinInfoMap:{pin: {net}}}}}`，
 * 其中 `pinInfoMap[pin].net` 直接是网络名，空串表示该引脚悬空（未连接）。
 * **注意**：这个导出里没有独立网络表，所以“悬空引脚”必须从 pin 反推——
 * 这正是本审计器的一项关键检查（此前真机发现 171 个未连接引脚）。
 *
 * ## fail-closed
 *
 * 输入缺失/格式不认识 → 抛带错误码的异常，绝不返回“通过”；
 * 只有“错误级 findings 为 0”才判 `pass`，警告不阻断但必须落盘。
 */

export const NETLIST_AUDITOR_VERSION = '1.0.0';

export const AUDITOR_CODES = Object.freeze({
  INTENT_INVALID: 'NETLIST_INTENT_INVALID',
  ACTUAL_INVALID: 'NETLIST_ACTUAL_INVALID',
  INPUT_MISSING: 'NETLIST_INPUT_MISSING',
});

export const NETLIST_FINDINGS = Object.freeze({
  NET_MISSING: 'NETLIST_NET_MISSING',
  NET_EXTRA: 'NETLIST_NET_EXTRA',
  PIN_MISSING: 'NETLIST_PIN_MISSING',
  PIN_EXTRA: 'NETLIST_PIN_EXTRA',
  PIN_MISMATCH: 'NETLIST_PIN_MISMATCH',
  PIN_FLOATING: 'NETLIST_PIN_FLOATING',
  GND_EMPTY: 'NETLIST_GND_EMPTY',
  POWER_MIXED: 'NETLIST_POWER_MIXED',
});

const GROUND_NET = /^(GND|VSS|AGND|DGND|PGND|GNDA|GNDD)$/i;
const POWER_NET = /^(GND|VSS|AGND|DGND|PGND|GNDA|GNDD|VCC|VDD|VBUS|VBAT|VIN|VOUT|VREF|AVDD|DVDD|VCCIO|\+?\d+(?:\.\d+)?V\d*)$/i;

const digestOf = (value) => createHash('sha256').update(canonical(value)).digest('hex');

/** 稳定序列化：对象键排序，保证同一模型两次哈希一致。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const codedError = (code, message, details = null) => Object.assign(new Error(message), { code, details });

const refOf = (value) => String(value ?? '').trim().toUpperCase();
const pinOf = (value) => String(value ?? '').trim();
const netOf = (value) => String(value ?? '').trim();

/** 把任意“意图输入”归一化成 `{nets: Map<name, Set<'REF.PIN'>>}`。 */
export function parseIntentNetlist(intent) {
  if (!intent || typeof intent !== 'object') throw codedError(AUDITOR_CODES.INTENT_INVALID, '意图网表不能为空');

  // design-spec 形态
  if (Array.isArray(intent.netIntent)) {
    if (!intent.netIntent.length) throw codedError(AUDITOR_CODES.INTENT_INVALID, '意图网表 netIntent 为空');
    const nets = new Map();
    for (const net of intent.netIntent) {
      const name = netOf(net?.net ?? net?.name);
      if (!name) throw codedError(AUDITOR_CODES.INTENT_INVALID, '意图网表存在空网络名');
      const endpoints = Array.isArray(net.endpoints) ? net.endpoints : [];
      if (endpoints.length < 1) throw codedError(AUDITOR_CODES.INTENT_INVALID, `意图网络 ${name} 没有端点`);
      const set = new Set();
      for (const endpoint of endpoints) {
        const ref = refOf(endpoint?.ref);
        const pin = pinOf(endpoint?.pin);
        if (!ref || !pin) throw codedError(AUDITOR_CODES.INTENT_INVALID, `意图网络 ${name} 存在缺少位号/引脚的端点`);
        set.add(`${ref}.${pin}`);
      }
      nets.set(name, set);
    }
    return { format: 'design-spec', nets, endpoints: [...nets.values()].reduce((sum, set) => sum + set.size, 0) };
  }

  // 已审核网表形态（也接受裸网表数组，即 [{net|name, endpoints:[...]}]）
  if (Array.isArray(intent.nets) || Array.isArray(intent)) {
    const nets = new Map();
    for (const net of (Array.isArray(intent) ? intent : intent.nets)) {
      const name = netOf(net?.name ?? net?.net);
      if (!name) throw codedError(AUDITOR_CODES.INTENT_INVALID, '意图网表存在空网络名');
      const endpoints = Array.isArray(net.endpoints) ? net.endpoints : [];
      const set = new Set(endpoints.map((endpoint) => `${refOf(endpoint?.ref)}.${pinOf(endpoint?.pin)}`));
      if (!set.size) throw codedError(AUDITOR_CODES.INTENT_INVALID, `意图网络 ${name} 没有端点`);
      nets.set(name, set);
    }
    return { format: 'reviewed-netlist', nets, endpoints: [...nets.values()].reduce((sum, set) => sum + set.size, 0) };
  }

  throw codedError(AUDITOR_CODES.INTENT_INVALID, '意图网表既不是 design-spec(netIntent) 也不是 reviewed-netlist(nets)');
}

/**
 * 解析 EDA 实际网表文本（EasyEDA JSON）为
 * `{refs:Set, pins:[{ref,pin,net}], nets:Map<name, Set<'REF.PIN'>>, componentCount, pinCount}`。
 */
export function parseActualNetlist(text) {
  let value;
  try {
    value = typeof text === 'string' ? JSON.parse(text) : text;
  }
  catch (error) {
    throw codedError(AUDITOR_CODES.ACTUAL_INVALID, `实际网表不是合法 JSON：${String(error?.message || error).slice(0, 120)}`);
  }
  if (!value || typeof value !== 'object') throw codedError(AUDITOR_CODES.ACTUAL_INVALID, '实际网表必须是对象');

  // EasyEDA 导出：components 是 uniqueId -> {props:{Designator}, pinInfoMap}
  if (value.components && typeof value.components === 'object' && !Array.isArray(value.components)) {
    const refs = new Set();
    const pins = [];
    const nets = new Map();
    for (const [uniqueId, component] of Object.entries(value.components)) {
      const ref = refOf(component?.props?.Designator ?? component?.props?.designator ?? uniqueId);
      if (!ref) continue;
      refs.add(ref);
      const pinMap = component?.pinInfoMap ?? component?.pins ?? {};
      for (const [pinKey, pinInfo] of Object.entries(pinMap)) {
        const pin = pinOf(pinInfo?.number ?? pinInfo?.props?.['Pin Number'] ?? pinKey);
        const net = netOf(pinInfo?.net);
        pins.push({ ref, pin, net });
        if (net) {
          if (!nets.has(net)) nets.set(net, new Set());
          nets.get(net).add(`${ref}.${pin}`);
        }
      }
    }
    return { format: 'easyeda-export', refs, pins, nets, componentCount: refs.size, pinCount: pins.length };
  }

  // 规范化形态：{nets:[{name, endpoints:[{ref,pin}]}]} 或 [{net, pins:['REF.PIN']}]
  const list = Array.isArray(value) ? value : (Array.isArray(value.nets) ? value.nets : null);
  if (list) {
    const nets = new Map();
    const pinNet = new Map();
    for (const net of list) {
      const name = netOf(net?.name ?? net?.net);
      if (!name) throw codedError(AUDITOR_CODES.ACTUAL_INVALID, '实际网表存在空网络名');
      const endpoints = Array.isArray(net?.endpoints) ? net.endpoints : (Array.isArray(net?.pins) ? net.pins.map((pin) => ({ ref: String(pin).split('.')[0], pin: String(pin).split('.').slice(1).join('.') })) : []);
      const set = new Set();
      for (const endpoint of endpoints) {
        const ref = refOf(endpoint?.ref);
        const pin = pinOf(endpoint?.pin);
        if (!ref || !pin) throw codedError(AUDITOR_CODES.ACTUAL_INVALID, `实际网络 ${name} 存在缺少位号/引脚的端点`);
        set.add(`${ref}.${pin}`);
        if (!pinNet.has(`${ref}.${pin}`)) pinNet.set(`${ref}.${pin}`, name);
      }
      nets.set(name, set);
    }
    const pins = [...pinNet.entries()].map(([key, net]) => ({ ref: key.split('.')[0], pin: key.split('.').slice(1).join('.'), net }));
    return { format: 'normalized', refs: new Set(pins.map((pin) => pin.ref)), pins, nets, componentCount: new Set(pins.map((pin) => pin.ref)).size, pinCount: pins.length };
  }

  throw codedError(AUDITOR_CODES.ACTUAL_INVALID, '实际网表既不是 EasyEDA 导出（components[].pinInfoMap）也不是 {nets:[...]} 结构');
}

/**
 * 执行逐引脚审计。
 *
 * @param {object} options
 * @param {object} options.intent design-spec 或 reviewed-netlist
 * @param {string|object} options.actual EDA 实际网表（导出文本或对象）
 * @param {string|null} [options.pcbUuid]
 * @param {string|null} [options.boardId]
 * @param {string[]} [options.allowedFloating] 允许悬空的引脚（"REF.PIN"），如明确标注 NC 的引脚
 * @param {string[]} [options.allowedMissingNets] 允许缺失的网络（需人工批准，默认空）
 * @param {boolean} [options.strictExtraNets] 额外网络是否算错误（默认 false=警告）
 * @param {Date} [options.now]
 * @returns {object} `netlist-diff` 证据（含 verdict/findings/counts/fingerprint/digest）
 */
export function auditNetlist({
  intent,
  actual,
  pcbUuid = null,
  boardId = null,
  allowedFloating = [],
  allowedMissingNets = [],
  strictExtraNets = false,
  now = () => new Date(),
} = {}) {
  if (intent === undefined || intent === null) throw codedError(AUDITOR_CODES.INPUT_MISSING, '缺少意图网表');
  if (actual === undefined || actual === null || actual === '') throw codedError(AUDITOR_CODES.INPUT_MISSING, '缺少实际网表');

  const intentModel = parseIntentNetlist(intent);
  const actualModel = parseActualNetlist(actual);
  const allowedFloatingSet = new Set(allowedFloating.map((key) => key.trim().toUpperCase()));
  const allowedMissingSet = new Set(allowedMissingNets.map((name) => netOf(name)));
  const actualPinNet = new Map(actualModel.pins.map((pin) => [`${pin.ref}.${pin.pin}`, pin.net]));

  const findings = [];
  const push = (code, severity, message, extra = {}) => findings.push({ code, severity, message, ...extra });

  // 1) 逐网络 / 逐引脚比对意图
  for (const [net, expected] of intentModel.nets) {
    const actualPins = actualModel.nets.get(net);
    const allowedMissing = allowedMissingSet.has(net);
    const isGround = GROUND_NET.test(net);
    if (!actualPins || actualPins.size === 0) {
      if (allowedMissing) continue;
      if (isGround) {
        push(NETLIST_FINDINGS.GND_EMPTY, 'error', `地网络 ${net} 在实际网表里没有任何引脚（期望 ${expected.size} 个端点）`, { net, expectedPins: [...expected] });
        continue;
      }
      push(NETLIST_FINDINGS.NET_MISSING, 'error', `网络 ${net} 在实际网表中缺失或为空`, { net });
      // 网络整体缺失时，仍逐引脚说明“接错到哪”或“悬空”，否则只有一句“网络缺失”无法修。
      for (const key of expected) {
        const actualNet = actualPinNet.get(key);
        const [ref, pin] = [key.split('.')[0], key.split('.').slice(1).join('.')];
        if (!actualNet) {
          if (!allowedFloatingSet.has(key)) push(NETLIST_FINDINGS.PIN_FLOATING, 'error', `${key} 期望接 ${net}，实际悬空`, { net, ref, pin, expectedNet: net });
          continue;
        }
        const bothPower = POWER_NET.test(net) && POWER_NET.test(actualNet);
        push(bothPower ? NETLIST_FINDINGS.POWER_MIXED : NETLIST_FINDINGS.PIN_MISMATCH, 'error',
          `${key} 期望接 ${net}，实际接在 ${actualNet}${bothPower ? '（电源网络串接）' : ''}`,
          { net, ref, pin, expectedNet: net, actualNet });
      }
      continue;
    }
    for (const key of expected) {
      const actualNet = actualPinNet.get(key);
      if (!actualNet) {
        if (allowedFloatingSet.has(key)) continue;
        push(NETLIST_FINDINGS.PIN_FLOATING, 'error', `${key} 期望接 ${net}，实际悬空`, { net, ref: key.split('.')[0], pin: key.split('.')[1], expectedNet: net });
        continue;
      }
      if (actualNet !== net) {
        const [ref, pin] = [key.split('.')[0], key.split('.').slice(1).join('.')];
        const bothPower = POWER_NET.test(net) && POWER_NET.test(actualNet);
        push(bothPower ? NETLIST_FINDINGS.POWER_MIXED : NETLIST_FINDINGS.PIN_MISMATCH, 'error',
          `${key} 期望接 ${net}，实际接在 ${actualNet}${bothPower ? '（电源网络串接）' : ''}`,
          { net, ref, pin, expectedNet: net, actualNet });
      }
    }
    for (const key of actualPins) {
      if (expected.has(key)) continue;
      push(NETLIST_FINDINGS.PIN_EXTRA, 'warning', `${key} 在实际网络 ${net} 中，但意图网表没有声明`, { net, ref: key.split('.')[0], pin: key.split('.')[1] });
    }
  }

  // 2) 意图之外的实际网络
  for (const [net, actualPins] of actualModel.nets) {
    if (intentModel.nets.has(net) || actualPins.size === 0) continue;
    push(NETLIST_FINDINGS.NET_EXTRA, strictExtraNets ? 'error' : 'warning', `实际网表存在意图未声明的网络 ${net}（${actualPins.size} 个引脚）`, { net, pins: [...actualPins].slice(0, 20) });
  }

  const unique = dedupeFindings(findings);
  const errors = unique.filter((finding) => finding.severity === 'error');
  const warnings = unique.filter((finding) => finding.severity !== 'error');
  const fingerprint = {
    pcbUuid,
    boardId,
    intentDigest: digestOf({ format: intentModel.format, nets: [...intentModel.nets].map(([name, set]) => [name, [...set].sort()]) }),
    actualDigest: digestOf({ format: actualModel.format, pins: actualModel.pins.map((pin) => [pin.ref, pin.pin, pin.net]).sort() }),
  };
  const generatedAt = now().toISOString();
  const envelope = {
    schemaVersion: 1,
    kind: 'netlist-diff',
    version: NETLIST_AUDITOR_VERSION,
    // 统一证据契约（evidence-contract）字段：subject 绑定对象、source 声明只读 agent。
    subject: { type: 'pcb', id: pcbUuid || boardId || 'unknown' },
    source: { agent: 'netlist-auditor', version: NETLIST_AUDITOR_VERSION, readOnly: true },
    generatedAt,
    fingerprint,
    verdict: errors.length ? 'blocked' : 'pass',
    counts: {
      intentNets: intentModel.nets.size,
      actualNets: actualModel.nets.size,
      intentEndpoints: intentModel.endpoints,
      actualPins: actualModel.pinCount,
      actualFloating: actualModel.pins.filter((pin) => !pin.net).length,
      errors: errors.length,
      warnings: warnings.length,
      findings: unique.length,
    },
    findings: unique,
    allowedFloating: [...allowedFloatingSet].sort(),
    allowedMissingNets: [...allowedMissingSet].sort(),
  };
  return { ...envelope, digest: digestOf(envelope) };
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.code}|${finding.net ?? ''}|${finding.ref ?? ''}|${finding.pin ?? ''}|${finding.actualNet ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
