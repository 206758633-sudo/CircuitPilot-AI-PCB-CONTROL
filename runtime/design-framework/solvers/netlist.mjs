/**
 * 网表 / 连接性校验：纯 JS 图算法（无依赖、无外部求解器）。
 *
 * 定位：Z3/图求解器不可用时的确定性兜底，覆盖三类最容易"看起来对、实际短/断"的问题：
 *   1. 短路：同一 `REF.PIN` 端点被多个网络引用（包括同一个网络里重复引用 → 提示）；
 *   2. 单端网络：一个 net 只有 1 个 pin（即使显式声明 kind:'gnd'/'power' 也仍是 warning——
 *      单点网络在物理上不构成连接，必须由人工/后续步骤确认）；
 *   3. 意图对比（design-spec 的 netIntent 形态）：missing/extra 的网络与端点，按 net 分组。
 *
 * 输入是 board-model.mjs 的板级 IR（nets[].pins 已被归一化为 `{ref,pin}`，这里同时兼容
 * 原始 `"REF.PIN"` 字符串，方便直接对 design-spec 的 netIntent 做 diff）。
 *
 * 判定语义：error 表示连接性被破坏（短路/引用不存在/意图缺失）；warning 表示可疑但未定论。
 * ok = 没有 error（warning 不阻塞，但与仓库其它模块一致：warning 不等于 PASS）。
 * 确定性：findings 顺序由输入顺序决定，digest 只依赖输入与判定结果。
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../board-model.mjs';

export const NETLIST_CODES = Object.freeze({
  SHORT: 'NETLIST_SHORT',
  DUPLICATE_PIN: 'NETLIST_DUPLICATE_PIN',
  SINGLE_PIN: 'NETLIST_SINGLE_PIN',
  DUPLICATE_NET: 'NETLIST_DUPLICATE_NET',
  UNKNOWN_REF: 'NETLIST_UNKNOWN_REF',
  PIN_INVALID: 'NETLIST_PIN_INVALID',
  INTENT_MISSING_NET: 'NETLIST_INTENT_MISSING_NET',
  INTENT_EXTRA_NET: 'NETLIST_INTENT_EXTRA_NET',
  INTENT_MISSING_ENDPOINT: 'NETLIST_INTENT_MISSING_ENDPOINT',
  INTENT_EXTRA_ENDPOINT: 'NETLIST_INTENT_EXTRA_ENDPOINT',
});

const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const finding = (code, severity, message, extra = {}) => ({ code, severity, message, ...extra });
const refOf = (value) => String(value ?? '').trim().toUpperCase();

/** 把 "REF.PIN" 或 {ref,pin} 归一化成 { ref, pin }（无法解析时返回 null）。 */
export function parseEndpoint(endpoint) {
  if (typeof endpoint === 'string') {
    const separator = endpoint.lastIndexOf('.');
    if (separator <= 0 || separator === endpoint.length - 1) return null;
    const ref = refOf(endpoint.slice(0, separator));
    const pin = endpoint.slice(separator + 1).trim();
    return ref && pin ? { ref, pin } : null;
  }
  if (endpoint && typeof endpoint === 'object') {
    const ref = refOf(endpoint.ref);
    const pin = String(endpoint.pin ?? '').trim();
    return ref && pin ? { ref, pin } : null;
  }
  return null;
}

const endpointKey = (endpoint) => `${endpoint.ref}.${endpoint.pin}`;

/** 归一化 IR 的 nets（兼容 name/net、pins 的字符串/对象两种形态）。 */
function normalizeModelNets(model) {
  const components = Array.isArray(model?.components) ? model.components : [];
  const knownRefs = new Set(components.map((component) => refOf(component?.ref)).filter(Boolean));
  const rawNets = Array.isArray(model?.nets) ? model.nets : [];
  return rawNets.map((net, index) => {
    const name = String(net?.name ?? net?.net ?? '').trim() || `net-${index + 1}`;
    const rawPins = Array.isArray(net?.pins) ? net.pins : Array.isArray(net?.endpoints) ? net.endpoints : [];
    const pins = rawPins.map(parseEndpoint);
    return {
      name,
      kind: net?.kind === 'power' || net?.kind === 'gnd' ? net.kind : 'signal',
      rawPins,
      pins,
      invalid: pins.filter((pin) => pin === null).length,
    };
  });
}

function normalizeIntentEntries(intent) {
  const entries = Array.isArray(intent)
    ? intent
    : (Array.isArray(intent?.netIntent) ? intent.netIntent : (Array.isArray(intent?.nets) ? intent.nets : []));
  return entries.map((entry, index) => {
    const name = String(entry?.net ?? entry?.name ?? entry?.id ?? '').trim() || `net-${index + 1}`;
    const rawPins = Array.isArray(entry?.endpoints) ? entry.endpoints : Array.isArray(entry?.pins) ? entry.pins : [];
    const pins = rawPins.map(parseEndpoint).filter(Boolean);
    return { name, pins };
  });
}

/** 把模型网表摊平成 `REF.PIN -> 网络名列表`，用于短路/重复引用检测。 */
function endpointIndex(nets) {
  const index = new Map();
  for (const net of nets) {
    for (const pin of net.pins) {
      if (!pin) continue;
      const key = endpointKey(pin);
      if (!index.has(key)) index.set(key, { ref: pin.ref, pin: pin.pin, nets: [] });
      index.get(key).nets.push(net.name);
    }
  }
  return index;
}

/**
 * 网表 vs 意图的差异（missing/extra 按 net 分组，不重复报端点级噪音）。
 * @param {object} model 板级 IR
 * @param {Array|object} intent design-spec 的 netIntent（数组或 {netIntent:[...]}）
 * @returns {{ok:boolean, missingNets:string[], extraNets:string[], missingEndpoints:Array, extraEndpoints:Array, summary:object}}
 */
export function netlistDiff(model, intent) {
  const modelNets = normalizeModelNets(model);
  const intentNets = normalizeIntentEntries(intent);
  const modelByName = new Map(modelNets.map((net) => [net.name, new Set(net.pins.filter(Boolean).map(endpointKey))]));
  const intentByName = new Map(intentNets.map((net) => [net.name, new Set(net.pins.map(endpointKey))]));

  const missingNets = intentNets.map((net) => net.name).filter((name) => !modelByName.has(name));
  const extraNets = modelNets.map((net) => net.name).filter((name) => !intentByName.has(name));

  const missingEndpoints = [];
  const extraEndpoints = [];
  for (const intentNet of intentNets) {
    const modelEndpoints = modelByName.get(intentNet.name);
    if (!modelEndpoints) continue;
    const missing = [...intentNet.pins.map(endpointKey)].filter((endpoint) => !modelEndpoints.has(endpoint));
    if (missing.length) missingEndpoints.push({ net: intentNet.name, endpoints: missing });
  }
  for (const modelNet of modelNets) {
    const intentEndpoints = intentByName.get(modelNet.name);
    if (!intentEndpoints) continue;
    const extra = [...new Set(modelNet.pins.filter(Boolean).map(endpointKey))].filter((endpoint) => !intentEndpoints.has(endpoint));
    if (extra.length) extraEndpoints.push({ net: modelNet.name, endpoints: extra });
  }

  const summary = {
    missingNets: missingNets.length,
    extraNets: extraNets.length,
    missingEndpoints: missingEndpoints.reduce((total, item) => total + item.endpoints.length, 0),
    extraEndpoints: extraEndpoints.reduce((total, item) => total + item.endpoints.length, 0),
  };
  // 意图的"缺失"是硬问题（spec 要求的连接没做）；"多余"是可疑但不阻塞。
  const ok = summary.missingNets === 0 && summary.missingEndpoints === 0;
  return { ok, missingNets, extraNets, missingEndpoints, extraEndpoints, summary };
}

/**
 * 网表/连接性校验。
 * @param {object} model 板级 IR
 * @param {{intent?: Array|object|null}} [options] intent = design-spec 的 netIntent
 * @returns {{ok:boolean, findings:Array, summary:object, intent:object|null, digest:string}}
 */
export function checkNetlist(model, options = {}) {
  const intent = options?.intent ?? null;
  const nets = normalizeModelNets(model);
  const findings = [];

  // 1) 网络名唯一（IR 已保证，这里对原始输入再兜一层）。
  const seenNames = new Set();
  for (const net of nets) {
    if (seenNames.has(net.name)) {
      findings.push(finding(NETLIST_CODES.DUPLICATE_NET, 'error', `网络名重复：${net.name}`, { net: net.name }));
    }
    seenNames.add(net.name);
  }

  // 2) 端点解析 + 器件存在性。
  for (const net of nets) {
    if (net.invalid > 0) {
      findings.push(finding(NETLIST_CODES.PIN_INVALID, 'error', `网络 ${net.name} 有 ${net.invalid} 个无法解析的端点（需要 "REF.PIN" 或 {ref,pin}）`, { net: net.name }));
    }
  }
  const knownRefs = new Set((Array.isArray(model?.components) ? model.components : []).map((component) => refOf(component?.ref)).filter(Boolean));
  if (knownRefs.size > 0) {
    for (const net of nets) {
      for (const pin of net.pins) {
        if (pin && !knownRefs.has(pin.ref)) {
          findings.push(finding(NETLIST_CODES.UNKNOWN_REF, 'error', `网络 ${net.name} 引用了不存在的器件 ${pin.ref}`, { net: net.name, ref: pin.ref }));
        }
      }
    }
  }

  // 3) 重复端点：同一网络里同一个 REF.PIN 出现多次。
  for (const net of nets) {
    const counts = new Map();
    for (const pin of net.pins) {
      if (!pin) continue;
      const key = endpointKey(pin);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count > 1) {
        findings.push(finding(NETLIST_CODES.DUPLICATE_PIN, 'warning', `网络 ${net.name} 重复列出端点 ${key}（${count} 次）`, { net: net.name, ref: key.split('.')[0] }));
      }
    }
  }

  // 4) 短路：同一 REF.PIN 被多个网络引用。
  const index = endpointIndex(nets);
  for (const [key, entry] of index) {
    const uniqueNets = [...new Set(entry.nets)];
    if (uniqueNets.length > 1) {
      findings.push(finding(NETLIST_CODES.SHORT, 'error', `端点 ${key} 同时属于多个网络（${uniqueNets.join('、')}），存在短路`, { ref: entry.ref, net: uniqueNets.join('、') }));
    }
  }

  // 5) 单端网络：只有 1 个 pin（gnd/power 也仍然是 warning，不因"电源/地"就放行）。
  for (const net of nets) {
    const pinCount = net.pins.filter(Boolean).length;
    if (pinCount < 2) {
      findings.push(finding(
        NETLIST_CODES.SINGLE_PIN,
        'warning',
        `网络 ${net.name} 只有 ${pinCount} 个引脚（kind=${net.kind}），单端网络不构成物理连接，需要确认`,
        { net: net.name },
      ));
    }
  }

  // 6) 可选：与意图网表对比。
  let intentDiff = null;
  if (intent !== null) {
    intentDiff = netlistDiff(model, intent);
    for (const name of intentDiff.missingNets) {
      findings.push(finding(NETLIST_CODES.INTENT_MISSING_NET, 'error', `意图网络 ${name} 在模型网表中不存在`, { net: name }));
    }
    for (const name of intentDiff.extraNets) {
      findings.push(finding(NETLIST_CODES.INTENT_EXTRA_NET, 'warning', `模型网络 ${name} 不在意图网表中（多出的连接需要确认）`, { net: name }));
    }
    for (const item of intentDiff.missingEndpoints) {
      findings.push(finding(NETLIST_CODES.INTENT_MISSING_ENDPOINT, 'error', `网络 ${item.net} 缺少意图端点：${item.endpoints.join('、')}`, { net: item.net }));
    }
    for (const item of intentDiff.extraEndpoints) {
      findings.push(finding(NETLIST_CODES.INTENT_EXTRA_ENDPOINT, 'warning', `网络 ${item.net} 存在意图之外的端点：${item.endpoints.join('、')}`, { net: item.net }));
    }
  }

  const errors = findings.filter((item) => item.severity === 'error').length;
  const warnings = findings.filter((item) => item.severity === 'warning').length;
  const summary = {
    nets: nets.length,
    pins: nets.reduce((total, net) => total + net.pins.filter(Boolean).length, 0),
    errors,
    warnings,
  };
  const payload = { findings, summary, intent: intentDiff };
  return { ok: errors === 0, findings, summary, intent: intentDiff, digest: sha256(payload) };
}
