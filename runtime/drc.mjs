/**
 * 官方 PCB DRC 报告的归一化与"豁免清单"门禁。
 *
 * 为什么不能直接读原始报告：
 *   真机返回的结构是 `{kind:'array', count:3, items:[3个分组], truncated:false}`，
 *   其中 **156 条违例全部藏在嵌套的 `list` 里，而 `count` 是"分组数 3"**。
 *   任何直接读 `count` 的代码都会把"156 个问题"显示成"3 个问题"——这又是本项目
 *   反复出现的那类错误：**计数与实际内容脱钩**。所以这里自己数叶子，并把
 *   "报告声称 N / 实际 M"的不一致显式报出来。
 *
 * 另一条硬规矩（用户 2026-10-13 决定）：**不许静默放行**。每个违规项必须被恰好归类一次：
 *   - 要么进入 `unexplained`（阻断，必须有人处理）；
 *   - 要么被一条**填写了 reason + risk** 的豁免覆盖（exempted）。
 * 缺 reason/risk 的豁免视为无效，被它"覆盖"的项目自动退回 `unexplained`。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DRC_CODES = {
  EXEMPTION_FORBIDDEN: 'DRC_EXEMPTION_FORBIDDEN',
  REPORT_INVALID: 'DRC_REPORT_INVALID',
  REPORT_TRUNCATED: 'DRC_REPORT_TRUNCATED',
  COUNT_MISMATCH: 'DRC_COUNT_MISMATCH',
  UNEXPLAINED: 'DRC_UNEXPLAINED_ITEMS',
  EXEMPTION_INCOMPLETE: 'DRC_EXEMPTION_INCOMPLETE',
  EXEMPTION_UNBOUNDED: 'DRC_EXEMPTION_UNBOUNDED',
  EXEMPTION_CAP_EXCEEDED: 'DRC_EXEMPTION_CAP_EXCEEDED',
  EXEMPTION_UNUSED: 'DRC_EXEMPTION_UNUSED',
  ALL_EXEMPTED: 'DRC_ALL_EXEMPTED',
  CLEAN: 'DRC_CLEAN',
};

/**
 * 处置建议：真机实测本板只有 18 段走线、却有 63 处"Connection Error"（未连接焊盘），
 * 说明这块板基本还没布线。因此**"未连接"类问题一律 must-fix，不允许豁免**——
 * 把"这个焊盘没连上"写进豁免清单，就是本项目最要防的那种静默放行。
 */
export function dispositionFor(item) {
  if (/^connection error/i.test(String(item?.errorType || ''))) {
    return { disposition: 'must-fix', dispositionReason: '未连接的焊盘/网络必须布线或从设计中移除，不能豁免' };
  }
  if (/clearance/i.test(String(item?.errorType || ''))) {
    return { disposition: 'fix-or-exempt', dispositionReason: '间距问题：优先调整几何或规则；确认实物可接受后登记豁免（必须写理由与风险）' };
  }
  return { disposition: 'review', dispositionReason: '需要人工判断这是设计缺陷还是规则差异' };
}

export const DRC_EXEMPTION_FILE_ENV = 'CIRCUITPILOT_DRC_EXEMPTIONS';
export function defaultExemptionPath(env = process.env) {
  return String(env[DRC_EXEMPTION_FILE_ENV] || '').trim() || join(homedir(), '.circuitpilot', 'drc-exemptions.json');
}

const text = (value, limit = 200) => String(value ?? '').trim().slice(0, limit);
const round1 = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null);
/** 渲染官方解释模板：`{obj1} to {obj2} distance is {minDistance}, should be {shouldBe}` */
export function renderExplanation(explanation) {
  const template = text(explanation?.str, 300);
  const params = explanation?.param || {};
  return template.replace(/\{(\w+)\}/g, (_, key) => text(params[key], 80));
}

/** 把嵌套 DRC 报告压平成违规项列表，并自己数叶子。 */
export function normalizeDrcReport(raw) {
  const result = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw;
  if (!result || typeof result !== 'object' || !Array.isArray(result.items)) {
    return { ok: false, code: DRC_CODES.REPORT_INVALID, message: 'DRC 报告结构不可识别（缺少 items 数组）', items: [], reportedCount: null, itemCount: 0, truncated: false, groups: [], byErrorType: {}, byRule: {}, byLayer: {}, countsConsistent: null };
  }
  // 幂等（第 57 轮修复）：本函数可能被喂"已经归一化过的报告"（例如把之前产出的报告再传进来）。
  // 那种条目的形状是 {errorType, objects:[{type}], signature, instanceKey, ...}，没有 EDA 原始的
  // node.list / explanation.errData 结构；再走一遍 walk 会把 objects 冲成空数组，
  // 导致豁免 matches() 里的 objTypes 比对永远失败（表现为 exempted 恒为 0）。
  const alreadyNormalized = Array.isArray(result.items) && result.items.length > 0
    && result.items[0] && typeof result.items[0] === 'object'
    && result.items[0].errorType !== undefined
    && Array.isArray(result.items[0].objects);
  if (alreadyNormalized) {
    return {
      ok: true,
      items: result.items,
      reportedCount: result.reportedCount ?? result.counts?.total ?? result.items.length,
      itemCount: result.items.length,
      truncated: Boolean(result.truncated),
      groups: Array.isArray(result.groups) ? result.groups : [],
      byErrorType: result.byErrorType || {},
      byRule: result.byRule || {},
      byLayer: result.byLayer || {},
      countsConsistent: result.countsConsistent ?? null,
      normalization: 'passthrough-already-normalized',
    };
  }
  const items = [];
  const groups = [];
  const walk = (nodes, path) => {
    for (const node of nodes || []) {
      const name = text(node?.name, 160);
      // 未命名节点不改写路径：真机叶子的 name 是空串，直接拼进去会得到
      // "Connection Error / GND / (未命名分组)" 这种把噪音写进证据的分组名。
      const next = name ? [...path, name] : path;
      if (Array.isArray(node?.list)) { walk(node.list, next); continue; }
      const data = node?.explanation?.errData || {};
      const position = data.position && Number.isFinite(Number(data.position.x)) && Number.isFinite(Number(data.position.y)) ? { x: data.position.x, y: data.position.y } : null;
      const objTypes = [text(data.obj1Type || node?.obj1?.typeName, 60), text(data.obj2Type || node?.obj2?.typeName, 60)].filter(Boolean);
      const errorType = text(node?.errorType || data.errorType || next[0], 80);
      const ruleName = text(node?.ruleName || data.name, 80);
      const layer = text(node?.layer, 60) || null;
      const obj1Suffix = text(data.obj1Suffix || node?.obj1?.suffix, 120);
      const obj2Suffix = text(data.obj2Suffix || node?.obj2?.suffix, 120);
      // 网络维度：Connection Error 一类的违规，其本质是"某个网络的某个焊盘没连上"
      // （真机叶子自带 net:'GND'，其它规则从 "(NET): ref" 后缀里取）。没有它，
      // 豁免就只能按"49 个 SMD Pad 连接错误"整体放过，粒度粗到没有意义。
      const netOf = (suffix) => { const matched = /\(([^)]+)\)/.exec(suffix || ''); return matched ? text(matched[1], 80) : ''; };
      const net = text(data.net, 80) || netOf(obj1Suffix) || null;
      const signature = [errorType, ruleName, layer || '-', objTypes.join('->') || '-', net || '-'].join('|');
      const globalIndex = text(node?.globalIndex || node?.pos || data.globalIndex, 40) || null;
      const instanceKey = [signature, position ? `${round1(position.x)},${round1(position.y)}` : '-', globalIndex || '-'].join('@');
      items.push({
        index: items.length,
        ...dispositionFor({ errorType }),
        globalIndex,
        group: next.join(' / '),
        errorType,
        errorObjType: text(node?.errorObjType, 80) || null,
        ruleName,
        ruleTypeName: text(node?.ruleTypeName, 80) || null,
        layer,
        net,
        position,
        objects: objTypes.map((type, i) => ({ type, suffix: i === 0 ? obj1Suffix : obj2Suffix })),
        signature,
        instanceKey,
        explanation: renderExplanation(node?.explanation) || text(node?.name, 200),
        visible: node?.visible !== false,
        severity: 'error',
      });
    }
  };
  walk(result.items, []);
  const tally = (key) => items.reduce((acc, item) => { const value = item[key] || '(未标注)'; acc[value] = (acc[value] || 0) + 1; return acc; }, {});
  const reportedCount = Number.isFinite(Number(result.count)) ? Number(result.count) : null;
  const groupTally = {};
  for (const item of items) groupTally[item.group] = (groupTally[item.group] || 0) + 1;
  groups.push(...Object.entries(groupTally).map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count));
  return {
    ok: true, kind: text(result.kind, 40) || null, reportedCount, itemCount: items.length,
    truncated: result.truncated === true,
    // 真机实测：reportedCount=3（分组数）而 itemCount=156 → 必须显式暴露，不能悄悄选一个当真。
    countsConsistent: reportedCount === null ? null : reportedCount === items.length,
    items, groups, byErrorType: tally('errorType'), byRule: tally('ruleName'), byLayer: tally('layer'),
    digest: createHash('sha256').update(JSON.stringify(items.map((item) => [item.signature, item.instanceKey]))).digest('hex'),
  };
}

export function validateExemption(entry) {
  const problems = [];
  if (!entry || typeof entry !== 'object') return ['豁免项必须是对象'];
  const scope = entry.scope === 'instance' ? 'instance' : 'kind';
  if (scope === 'instance' && !text(entry.match?.instanceKey, 300)) problems.push('instance 级豁免必须给出 match.instanceKey');
  if (scope === 'kind') {
    if (!text(entry.match?.errorType, 80)) problems.push('kind 级豁免必须给出 match.errorType');
    if (!Number.isInteger(entry.maxCount) || entry.maxCount <= 0) problems.push('kind 级豁免必须给出正整数 maxCount（否则等于无限豁免）');
  }
  if (text(entry.reason, 400).length < 8) problems.push('必须填写 ≥8 字的豁免理由（说明为什么可以放过）');
  if (text(entry.risk, 400).length < 8) problems.push('必须填写 ≥8 字的残留风险（说明放过之后可能出什么事）');
  return problems;
}

function matches(item, entry) {
  const match = entry.match || {};
  if (entry.scope === 'instance') return text(match.instanceKey, 300) === item.instanceKey;
  if (text(match.errorType, 80) !== item.errorType) return false;
  if (match.ruleName && text(match.ruleName, 80) !== item.ruleName) return false;
  if (match.layer && text(match.layer, 60) !== item.layer) return false;
  if (match.net && text(match.net, 80) !== item.net) return false;
  if (Array.isArray(match.objTypes) && match.objTypes.length) {
    const wanted = match.objTypes.map((v) => text(v, 60)).join('->');
    const actual = item.objects.map((o) => o.type).join('->');
    if (wanted !== actual) return false;
  }
  return true;
}

/**
 * 归类门禁：每个违规项恰好进一个桶；`ready` 只在"全部有交代且报告完整"时为 true。
 */
export function classifyDrcItems({ items = [], exemptions = [], truncated = false, reportedCount = null } = {}) {
  const findings = [];
  const invalidExemptions = [];
  const validExemptions = [];
  exemptions.forEach((entry, index) => {
    const problems = validateExemption(entry);
    if (problems.length) invalidExemptions.push({ index, id: entry?.id ?? null, problems });
    else validExemptions.push({ ...entry, scope: entry.scope === 'instance' ? 'instance' : 'kind' });
  });
  if (invalidExemptions.length) {
    findings.push({ code: DRC_CODES.EXEMPTION_INCOMPLETE, severity: 'blocking', field: 'exemptions', message: `${invalidExemptions.length} 条豁免无效（缺理由/风险或约束不完整），被它们覆盖的问题已退回"未处理"：${invalidExemptions.map((e) => `#${e.index}[${e.problems.join('；')}]`).join(' ').slice(0, 400)}` });
  }

  const forbidden = [];
  const buckets = new Map(validExemptions.map((entry, index) => [index, []]));
  const unexplained = [];
  for (const item of items) {
    let matched = false;
    for (let index = 0; index < validExemptions.length; index += 1) {
      const entry = validExemptions[index];
      if (!matches(item, entry)) continue;
      // must-fix 类（未连接）不允许被豁免：豁免它等于把"没连上"合法化。
      if (item.disposition === 'must-fix') {
        forbidden.push({ itemIndex: item.index, exemptionId: entry.id ?? null, errorType: item.errorType, net: item.net, dispositionReason: item.dispositionReason });
        continue;
      }
      const bucket = buckets.get(index);
      if (entry.scope === 'kind' && bucket.length >= entry.maxCount) continue; // 超出配额 → 不豁免
      bucket.push(item);
      matched = true;
      break;
    }
    if (!matched) unexplained.push(item);
  }

  const exempted = [];
  const unusedExemptions = [];
  validExemptions.forEach((entry, index) => {
    const bucket = buckets.get(index) || [];
    if (!bucket.length) { unusedExemptions.push({ index, id: entry.id ?? null, scope: entry.scope }); return; }
    exempted.push({
      id: entry.id ?? null, scope: entry.scope, reason: text(entry.reason, 400), risk: text(entry.risk, 400),
      approvedBy: text(entry.approvedBy, 120) || null, approvedAt: text(entry.approvedAt, 40) || null,
      maxCount: entry.scope === 'kind' ? entry.maxCount : null, count: bucket.length,
      itemIndexes: bucket.map((item) => item.index),
    });
    if (entry.scope === 'kind' && entry.maxCount !== undefined && bucket.length >= entry.maxCount && items.filter((item) => matches(item, entry)).length > bucket.length) {
      findings.push({ code: DRC_CODES.EXEMPTION_CAP_EXCEEDED, severity: 'blocking', field: 'exemptions', message: `豁免「${text(entry.id, 60) || entry.match.errorType}」配额 ${entry.maxCount} 已用满，仍有同类问题未被覆盖（已退回"未处理"）` });
    }
  });
  if (unusedExemptions.length) findings.push({ code: DRC_CODES.EXEMPTION_UNUSED, severity: 'warning', field: 'exemptions', message: `${unusedExemptions.length} 条豁免当前没有匹配到任何问题（可能已被修复，建议清理，避免它下次悄悄盖住新问题）` });
  if (forbidden.length) {
    const sample = forbidden.slice(0, 5).map((entry) => `${entry.errorType}${entry.net ? `(${entry.net})` : ''}`).join('、');
    findings.push({ code: DRC_CODES.EXEMPTION_FORBIDDEN, severity: 'blocking', field: 'exemptions', message: `有 ${forbidden.length} 条"必须修复"类问题被尝试豁免（例：${sample}）——未连接的网络必须布线或从设计中移除，豁免它等于把缺陷合法化` });
  }
  if (unexplained.length) findings.push({ code: DRC_CODES.UNEXPLAINED, severity: 'blocking', field: 'items', message: `${unexplained.length}/${items.length} 条 DRC 违规没有任何处理结论（既未修复也未登记豁免）` });
  if (reportedCount !== null && Number(reportedCount) !== items.length) {
    findings.push({
      code: DRC_CODES.COUNT_MISMATCH, severity: 'warning', field: 'report',
      message: `DRC 报告的 count=${reportedCount} 与实际违规条数 ${items.length} 不一致（真机上 count 是"分组数"）——本报告按实际条数 ${items.length} 统计，避免把 156 个问题看成 3 个`,
    });
  }
  if (truncated) findings.push({ code: DRC_CODES.REPORT_TRUNCATED, severity: 'blocking', field: 'report', message: 'DRC 报告被截断，无法断言"已看完全部问题"' });
  if (items.length && exempted.reduce((sum, entry) => sum + entry.count, 0) === items.length) {
    findings.push({ code: DRC_CODES.ALL_EXEMPTED, severity: 'warning', field: 'exemptions', message: '全部 DRC 问题都被豁免覆盖了——一份"全都放过"的清单等于没有检查，请确认这不是在自我安慰' });
  }
  if (!items.length && !truncated) findings.push({ code: DRC_CODES.CLEAN, severity: 'info', field: 'report', message: '没有 DRC 违规项（注意：只有在报告完整且非截断时才成立）' });

  return {
    ready: findings.every((item) => item.severity !== 'blocking'),
    findings,
    unexplained,
    exempted,
    invalidExemptions,
    unusedExemptions,
    forbiddenExemptions: forbidden,
    summary: {
      total: items.length, exempted: exempted.reduce((sum, entry) => sum + entry.count, 0), unexplained: unexplained.length,
      reportedCount, truncated,
    },
  };
}

/** 生成"待填的豁免清单"：只给结构，理由和风险留空——留空就无效，正是我们想要的。 */
export function buildExemptionTemplate(items = []) {
  const bySignature = new Map();
  for (const item of items) {
    const current = bySignature.get(item.signature) || { errorType: item.errorType, ruleName: item.ruleName || null, layer: item.layer || null, net: item.net || null, objTypes: item.objects.map((o) => o.type), disposition: item.disposition, dispositionReason: item.dispositionReason, count: 0, sample: null };
    current.count += 1;
    if (!current.sample) current.sample = { group: item.group, explanation: item.explanation, position: item.position, globalIndex: item.globalIndex, instanceKey: item.instanceKey };
    bySignature.set(item.signature, current);
  }
  return [...bySignature.entries()].map(([signature, entry]) => {
    const match = { errorType: entry.errorType, ruleName: entry.ruleName, layer: entry.layer, net: entry.net, objTypes: entry.objTypes };
    // 配额必须按 matches() 的**真实命中数**给：matches() 只在 match.net 为真值时才比网络，
    // 因此 match.net = null 的条目会跨网络多命中。若按签名数给配额，用户即便把
    // reason/risk/maxCount 都填对，仍会吃到 EXEMPTION_CAP_EXCEEDED（第 57 轮真机遇到的死结）。
    const matchedCount = items.filter((item) => matches(item, { scope: 'kind', match })).length;
    return {
      id: `exempt-${createHash('sha256').update(signature).digest('hex').slice(0, 8)}`,
      scope: 'kind',
      match,
      maxCount: Math.max(matchedCount, entry.count),
      disposition: entry.disposition,
      dispositionReason: entry.dispositionReason,
      reason: '',
      risk: '',
      approvedBy: '',
      sample: entry.sample,
      occurrences: matchedCount || entry.count,
    };
  }).sort((a, b) => b.occurrences - a.occurrences);
}

export function loadExemptionFile(filePath = defaultExemptionPath()) {
  if (!filePath || !existsSync(filePath)) return { path: filePath, exists: false, exemptions: [], invalid: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const exemptions = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.exemptions) ? parsed.exemptions : [];
    const invalid = exemptions.map((entry, index) => ({ index, problems: validateExemption(entry) })).filter((entry) => entry.problems.length);
    return { path: filePath, exists: true, exemptions, invalid };
  } catch (error) {
    return { path: filePath, exists: true, exemptions: [], invalid: [], error: String(error.message).slice(0, 200) };
  }
}

/** 写盘前先校验：绝不允许把"缺理由/风险"的豁免静默写进清单。 */
export function saveExemptionFile(filePath, exemptions = []) {
  const invalid = exemptions.map((entry, index) => ({ index, problems: validateExemption(entry) })).filter((entry) => entry.problems.length);
  if (invalid.length) {
    throw Object.assign(new Error(`拒绝写入 ${invalid.length} 条无效豁免（必须填写理由与残留风险）：${invalid.map((entry) => `#${entry.index} ${entry.problems.join('；')}`).join(' | ').slice(0, 300)}`), { code: 'DRC_EXEMPTION_INVALID' });
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ kind: 'drc-exemption-list', schemaVersion: 1, updatedAt: new Date().toISOString(), exemptions }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { path: filePath, count: exemptions.length };
}
