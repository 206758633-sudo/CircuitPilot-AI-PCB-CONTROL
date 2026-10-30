import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 原理图 ERC 收敛（A13）。
 *
 * 现实里 EDA 的 ERC 返回值有两副面孔：
 *   - 聚合式：`[{ type: 'error', count: 1 }, { type: 'warn', count: 19 }, ...]`，
 *     只有计数、没有对象与规则——它只能当"有没有错误"的粗门禁；
 *   - 明细式：带 message/description/objects/detail 的条目，才能当逐条修复依据。
 *
 * 本模块把两种都归一化成**同一条 finding 结构**，并明确标注 `aggregateOnly`：
 * 聚合式结论绝不能被 UI 或放行门禁伪装成"逐条已核对"。
 *
 * 另外提供：
 *   - 确定性的修复建议（引脚悬空 → noConnect/netFlag/上拉；缺 PWR_FLAG → 补 netFlag；
 *     命名/重复 → 人工确认），只是**建议**，不自动写图；
 *   - 豁免：必须写明理由，匹配按 code/对象；无效豁免退还"未处理"，不静默吞掉；
 *   - 证据落盘：由 server 调用 evidence-store（kind=schematic-erc），本模块只产出可哈希内容。
 */

export const ERC_SCHEMA_VERSION = 1;
export const ERC_SEVERITIES = Object.freeze(['fatal', 'error', 'warning', 'info']);
export const ERC_EXEMPTION_FILE_ENV = 'CIRCUITPILOT_ERC_EXEMPTIONS';
export const ERC_EXEMPTION_DIR_ENV = 'CIRCUITPILOT_ERC_EXEMPTION_DIR';
export const ERC_LEGACY_FILE_ENV = 'CIRCUITPILOT_ERC_LEGACY_EXEMPTIONS';
const legacyErcExemptionFile = (env = process.env) => String(env[ERC_LEGACY_FILE_ENV] || '').trim() || join(homedir(), '.circuitpilot', 'erc-exemptions.json');
/** 原理图豁免按工程隔离（同 DRC：全局单文件会把 A 板豁免套到 B 板）。 */
export function ercExemptionScopePath(projectUuid = null, env = process.env) {
  const dir = String(env[ERC_EXEMPTION_DIR_ENV] || '').trim() || join(homedir(), '.circuitpilot', 'erc-exemptions');
  const scope = String(projectUuid || '').trim();
  if (/^[A-Za-z0-9_-]{6,64}$/.test(scope)) return join(dir, `project-${scope}.json`);
  return join(dir, 'global.json');
}
/** 读"当前工程"的 ERC 豁免；工程级文件不存在时回退旧版全局文件并带 warning。 */
export function loadScopedErcExemptionFile(projectUuid = null, env = process.env) {
  const explicit = String(env[ERC_EXEMPTION_FILE_ENV] || '').trim();
  if (explicit) return { ...loadErcExemptionFile(explicit), scope: { kind: 'explicit', projectUuid, scopedPath: explicit } };
  const scopedPath = ercExemptionScopePath(projectUuid, env);
  const scoped = loadErcExemptionFile(scopedPath);
  if (scoped.exists) return { ...scoped, scope: { kind: projectUuid ? 'project' : 'global', projectUuid, scopedPath } };
  const legacyPath = legacyErcExemptionFile(env);
  if (existsSync(legacyPath)) {
    const legacy = loadErcExemptionFile(legacyPath);
    return { ...legacy, scope: { kind: 'legacy', projectUuid, scopedPath }, warning: `正在使用旧版全局 ERC 豁免文件 ${legacyPath}（未按工程隔离，已弃用）；建议迁移到 ${scopedPath}` };
  }
  return { ...scoped, scope: { kind: projectUuid ? 'project' : 'global', projectUuid, scopedPath } };
}

const text = (value, limit = 240) => String(value ?? '').trim().slice(0, limit);
const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};
const digestOf = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');

const severityOf = (value) => {
  const level = text(value, 40).toLowerCase();
  if (level === 'fatal' || level === 'critical') return 'fatal';
  if (level === 'error' || level === 'err') return 'error';
  if (level === 'warn' || level === 'warning') return 'warning';
  return 'info';
};

/** 从原始条目里尽量捞出"对象/网络/引脚"等可定位信息；捞不到就明确写 unknown。 */
const objectOf = (item) => {
  const candidates = [item?.object, item?.objects, item?.ref, item?.refs, item?.designator, item?.device, item?.net, item?.pin];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate.map((entry) => text(typeof entry === 'object' ? (entry.name ?? entry.ref ?? entry.designator ?? entry.id) : entry, 120)).filter(Boolean).join(', ');
    if (typeof candidate === 'string' && candidate.trim()) return text(candidate, 120);
  }
  return '';
};

const codeOf = (item, severity, message) => {
  const explicit = text(item?.code ?? item?.rule ?? item?.ruleName ?? item?.type, 80);
  // type/level 字段常常是 'error'/'warn' 这类级别词，不能当规则号；只有真正的规则/错误码才直接采用。
  const severityWords = /^(fatal|critical|error|err|warn|warning|info|information)$/i;
  if (explicit && !severityWords.test(explicit)) return explicit;
  // 没有规则号时用消息里的稳定关键词生成一个可读 code（同一类问题能聚合）。
  const patterns = [
    [/pwr[_ ]?flag/i, 'ERC_POWER_FLAG'],
    [/floating|悬空|未连接|unconnected|not connected/i, 'ERC_PIN_FLOATING'],
    [/no ?connect/i, 'ERC_NO_CONNECT'],
    [/duplicate|重复/i, 'ERC_DUPLICATE'],
    [/name|命名/i, 'ERC_NAMING'],
    [/net ?flag/i, 'ERC_NET_FLAG'],
    [/driver|驱动/i, 'ERC_DRIVER'],
  ];
  const found = patterns.find(([pattern]) => pattern.test(message));
  return found ? found[1] : `ERC_${severity.toUpperCase()}`;
};

const suggestionFor = (code, message) => {
  if (code === 'ERC_POWER_FLAG' || /pwr[_ ]?flag/i.test(message)) return '补 PWR_FLAG（电源网络需要显式驱动声明），不要用连线掩盖。';
  if (/floating|悬空|未连接|unconnected|not connected/i.test(message) || code === 'ERC_PIN_FLOATING') return '确认是否应接：应接则补线；设计上不接则加 noConnect 标记（或按器件要求加上拉/下拉）。';
  if (code === 'ERC_NO_CONNECT' || /no ?connect/i.test(message)) return '确认 noConnect 是否放在正确引脚上；误放的标记要移除。';
  if (code === 'ERC_DUPLICATE' || /duplicate|重复/i.test(message)) return '同一网络/对象被重复声明：合并或删除重复项，保留唯一命名。';
  if (code === 'ERC_NAMING' || /name|命名/i.test(message)) return '统一命名规则（网络名/位号），避免仅大小写或下划线差异的重复网络。';
  if (code === 'ERC_DRIVER' || /driver|驱动/i.test(message)) return '检查驱动源数量与方向：多驱动/无驱动都要人工确认电气意图。';
  return '需要人工确认电气意图后修复；系统不自动改图。';
};

/**
 * A13：把"建议文案"升级成**逐条可执行的结构化修复建议**（不自动改图）。
 *
 * 纪律：
 *   - `autoFixable` 恒为 false——电气意图（该接还是该 noConnect）必须人确认后
 *     才允许调写命令；这里只给命令、所需参数与验证方式；
 *   - 聚合式条目（EDA 只给计数）没有对象/引脚，修复建议只能是"先要明细"，不猜；
 *   - 每条都要求 `verify`：修完必须重跑 ERC 用同一条 code/object 复核，不能凭感觉收工。
 */
export function repairFor(code, message = '', { aggregate = false } = {}) {
  if (aggregate) {
    return {
      kind: 'manual', label: '先取逐条明细再修复', risk: 'high', autoFixable: false, requiresHumanConfirm: true,
      steps: ['让 EDA 返回逐条 ERC 明细（或截图定位到具体对象）', '确认对象/引脚与电气意图后再决定修复或豁免'],
      verify: '重跑 ERC，确认该条聚合计数下降或清零（不能凭计数变化当修复证据）',
      blockedReason: '聚合计数没有对象/引脚，系统不猜修复动作',
    };
  }
  if (code === 'ERC_POWER_FLAG' || /pwr[_ ]?flag/i.test(message)) {
    return {
      kind: 'pwr-flag', label: '补 PWR_FLAG 电源驱动声明', risk: 'low', autoFixable: false, requiresHumanConfirm: true,
      steps: ['在原理图打开 ERC 定位该电源网络', '确认该网络确实由连接器/稳压器供电（不是漏驱动）', '给对应网络加 PWR_FLAG（不要用连线掩盖）'],
      verify: '重跑 ERC，确认该网络不再报 PWR_FLAG',
    };
  }
  if (code === 'ERC_PIN_FLOATING' || /floating|悬空|未连接|unconnected|not connected/i.test(message)) {
    return {
      kind: 'no-connect', label: '确认悬空引脚：补线或加 noConnect', risk: 'medium', autoFixable: false, requiresHumanConfirm: true,
      steps: ['在原理图定位该引脚，查器件手册确认是否允许悬空', '应接则补线/加上拉下拉；设计上不接才加 noConnect', '不要为了消警把两个不相关网络连在一起'],
      suggestedCommand: { command: 'schematic.pin.noConnect', needs: ['componentPrimitiveId', 'pinNumbers'], note: '参数必须来自真实引脚读回，且需人工确认电气意图' },
      verify: '重跑 ERC，确认该引脚具体条消失（不是整体计数归零）',
    };
  }
  if (code === 'ERC_NO_CONNECT' || /no ?connect/i.test(message)) {
    return {
      kind: 'no-connect-review', label: '核对 noConnect 放置位置', risk: 'medium', autoFixable: false, requiresHumanConfirm: true,
      steps: ['确认 noConnect 是否放在正确引脚（误放等于掩盖真实悬空）', '误放的标记移除；该接的引脚补线'],
      verify: '重跑 ERC，确认无新增悬空告警',
    };
  }
  if (code === 'ERC_NET_FLAG' || /net ?flag/i.test(message)) {
    return {
      kind: 'net-flag', label: '核对网络标识/驱动声明', risk: 'medium', autoFixable: false, requiresHumanConfirm: true,
      steps: ['确认该网络是否被误标为电源/特殊网络', '按真实电气意图修正网络标识或补驱动'],
      verify: '重跑 ERC，确认该网络标识相关条目消失',
    };
  }
  return {
    kind: 'manual', label: '人工确认电气意图后修复', risk: 'high', autoFixable: false, requiresHumanConfirm: true,
    steps: ['根据 ERC 对象与规则人工确认根因', '修正后重跑 ERC 复核'],
    verify: '重跑 ERC，确认同 code/object 条目消失或转为有理由的豁免',
  };
}

const summarizeRepairs = (findings) => {
  const kinds = {};
  for (const finding of findings) {
    const kind = finding.repair?.kind || 'manual';
    kinds[kind] = (kinds[kind] || 0) + 1;
  }
  return { kinds, autoFixable: 0, requiresHuman: findings.length, total: findings.length };
};

/**
 * 归一化 ERC 报告。接受数组、单个对象、或包着 `result` 的命令信封。
 * @returns {{
 *   schemaVersion: number, ran: boolean, digest: string, aggregateOnly: boolean,
 *   counts: {fatal:number,error:number,warning:number,info:number,total:number},
 *   findings: Array<{id:string,severity:string,code:string,title:string,object:string,detail:string,suggestion:string,aggregate:boolean,count:number}>,
 *   groups: Array<{type:string,count:number,detailAvailable:boolean}>
 * }}
 */
export function normalizeErcReport(raw) {
  const source = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw;
  const rawGroups = Array.isArray(source) ? source : source && typeof source === 'object' ? [source] : [];
  // 只接受"像 ERC 条目"的组：空对象/随机对象不能被当成"已运行 ERC 且 0 项"。
  const groups = rawGroups.filter((group) => group && typeof group === 'object' && (
    group.type !== undefined || group.level !== undefined || group.severity !== undefined
    || group.count !== undefined || Array.isArray(group.items) || Array.isArray(group.findings)
    || group.message !== undefined || group.description !== undefined || group.detail !== undefined
  ));
  const findings = [];
  const groupSummary = [];
  const counts = { fatal: 0, error: 0, warning: 0, info: 0, total: 0 };

  for (const group of groups) {
    const groupSeverity = severityOf(group.type ?? group.level ?? group.severity);
    const items = Array.isArray(group.items) ? group.items : Array.isArray(group.findings) ? group.findings : [];
    if (items.length) {
      for (const item of items) {
        const severity = severityOf(item.level ?? item.type ?? item.severity ?? groupSeverity);
        const message = text(item.message ?? item.description ?? item.detail ?? item.title ?? group.message, 400);
        const code = codeOf(item, severity, message);
        const finding = {
          id: `erc-${digestOf({ severity, code, object: objectOf(item), message }).slice(0, 12)}`,
          severity,
          code,
          title: text(item.title ?? item.name ?? item.ruleName ?? `${severity.toUpperCase()} · ${code}`, 160),
          object: objectOf(item) || 'unknown',
          detail: message,
          suggestion: suggestionFor(code, message),
          repair: repairFor(code, message),
          aggregate: false,
          count: 1,
        };
        findings.push(finding);
        counts[severity] += 1;
      }
      groupSummary.push({ type: groupSeverity, count: items.length, detailAvailable: true });
      continue;
    }
    // 聚合式条目：没有对象/明细，只保留计数与说明；**不得**伪装成逐条 finding。
    const count = Math.max(0, Math.floor(Number(group.count ?? 0) || 0));
    const message = text(group.message ?? group.description ?? group.detail ?? '', 400);
    const code = codeOf(group, groupSeverity, message || text(group.type, 80));
    const finding = {
      id: `erc-${digestOf({ severity: groupSeverity, code, message, aggregate: true }).slice(0, 12)}`,
      severity: groupSeverity,
      code,
      title: text(group.name ?? message ?? `${groupSeverity.toUpperCase()}（${count} 项）`, 160),
      object: objectOf(group) || 'unknown',
      detail: message || `EDA 只返回聚合计数（${count} 项），没有逐条对象/规则明细。`,
      suggestion: message ? suggestionFor(code, message) : '先让 EDA 返回明细（或截图定位）再决定修复；聚合计数不能当逐条依据。',
      repair: repairFor(code, message, { aggregate: true }),
      aggregate: true,
      count,
    };
    findings.push(finding);
    counts[groupSeverity] += count;
    groupSummary.push({ type: groupSeverity, count, detailAvailable: false });
  }
  counts.total = counts.fatal + counts.error + counts.warning + counts.info;
  // aggregateOnly 说的是"结论里有没有逐条依据"：只要存在任何一条明细 finding 就不是聚合式。
  const aggregateOnly = !findings.some((finding) => !finding.aggregate);
  const normalized = {
    schemaVersion: ERC_SCHEMA_VERSION,
    ran: groups.length > 0,
    aggregateOnly,
    counts,
    findings,
    groups: groupSummary,
    detailAvailable: findings.some((finding) => !finding.aggregate),
    repairSummary: summarizeRepairs(findings),
  };
  normalized.digest = digestOf({
    schemaVersion: ERC_SCHEMA_VERSION,
    counts: normalized.counts,
    findings: normalized.findings.map(({ id, severity, code, object, detail, count, aggregate }) => ({ id, severity, code, object, detail, count, aggregate })),
  });
  return normalized;
}

const validateExemption = (entry) => {
  const problems = [];
  if (!entry || typeof entry !== 'object') return ['豁免必须是对象'];
  if (!text(entry.code, 80)) problems.push('缺 code');
  if (!text(entry.reason, 300)) problems.push('缺理由（必须写清风险接受依据）');
  if (entry.object !== undefined && entry.object !== null && typeof entry.object !== 'string') problems.push('object 必须是字符串或 null');
  return problems;
};

/**
 * 应用豁免：按 code（可选 object 精确匹配）把 finding 标成 exempted。
 * 无效豁免不会被静默丢弃——它们进入 `invalid`，并且被它们"声称覆盖"的问题保持未处理。
 */
export function applyErcExemptions(normalized, exemptions = []) {
  const list = Array.isArray(exemptions) ? exemptions : Array.isArray(exemptions?.exemptions) ? exemptions.exemptions : [];
  const invalid = [];
  const valid = [];
  list.forEach((entry, index) => {
    const problems = validateExemption(entry);
    if (problems.length) invalid.push({ index, code: text(entry?.code, 80) || null, problems });
    else valid.push({ code: text(entry.code, 80), object: text(entry.object, 120) || null, reason: text(entry.reason, 300) });
  });
  const findings = (normalized.findings || []).map((finding) => {
    const exemption = valid.find((entry) => entry.code === finding.code && (!entry.object || entry.object === finding.object));
    return exemption ? { ...finding, exempted: true, exemptionReason: exemption.reason } : { ...finding, exempted: false };
  });
  const openCounts = { fatal: 0, error: 0, warning: 0, info: 0, total: 0 };
  for (const finding of findings) {
    if (finding.exempted) continue;
    openCounts[finding.severity] += finding.aggregate ? finding.count : 1;
    openCounts.total += finding.aggregate ? finding.count : 1;
  }
  return { ...normalized, findings, exemptions: valid, invalidExemptions: invalid, openCounts };
}

/** 生成豁免模板：每个 code 一条，理由留空强制人工填写。 */
export function buildErcExemptionTemplate(normalized) {
  const byCode = new Map();
  for (const finding of normalized.findings || []) {
    if (!byCode.has(finding.code)) {
      byCode.set(finding.code, {
        code: finding.code,
        object: finding.object === 'unknown' ? '' : finding.object,
        reason: '',
        severity: finding.severity,
        sample: finding.title,
        count: finding.aggregate ? finding.count : 1,
      });
    } else {
      const entry = byCode.get(finding.code);
      entry.count += finding.aggregate ? finding.count : 1;
    }
  }
  return [...byCode.values()].sort((left, right) => right.count - left.count);
}

export function defaultErcExemptionPath(env = process.env, projectUuid = null) {
  const explicit = String(env[ERC_EXEMPTION_FILE_ENV] || '').trim();
  if (explicit) return explicit;
  return ercExemptionScopePath(projectUuid, env);
}

export function loadErcExemptionFile(filePath = defaultErcExemptionPath()) {
  if (!filePath || !existsSync(filePath)) return { path: filePath, exists: false, exemptions: [], invalid: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const exemptions = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.exemptions) ? parsed.exemptions : [];
    const invalid = exemptions.map((entry, index) => ({ index, problems: validateExemption(entry) })).filter((entry) => entry.problems.length);
    return { path: filePath, exists: true, exemptions, invalid };
  } catch (error) {
    return { path: filePath, exists: true, exemptions: [], invalid: [], error: String(error?.message || error).slice(0, 200) };
  }
}

/** 原子写豁免文件（临时文件 + rename），并返回校验结果；有无效条目时拒绝落盘。 */
export function saveErcExemptionFile(exemptions, filePath = defaultErcExemptionPath()) {
  const list = Array.isArray(exemptions) ? exemptions : [];
  const invalid = list.map((entry, index) => ({ index, code: text(entry?.code, 80) || null, problems: validateExemption(entry) })).filter((entry) => entry.problems.length);
  if (invalid.length) {
    const error = new Error(`拒绝保存：${invalid.length} 条豁免不完整（${invalid.map((item) => `#${item.index}[${item.problems.join('；')}]`).join(' ')}）`);
    error.code = 'ERC_EXEMPTION_INVALID';
    error.details = { invalid };
    throw error;
  }
  const normalized = list.map((entry) => ({ code: text(entry.code, 80), object: text(entry.object, 120) || null, reason: text(entry.reason, 300), at: text(entry.at, 40) || new Date().toISOString() }));
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), exemptions: normalized }, null, 2)}\n`, 'utf8');
    renameSync(tempPath, filePath);
  } catch (error) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* 清理失败不掩盖原始错误 */ }
    throw Object.assign(new Error(`豁免文件写入失败：${String(error?.message || error).slice(0, 160)}`), { code: 'ERC_EXEMPTION_WRITE_FAILED' });
  }
  return { path: filePath, count: normalized.length };
}

/** 可读摘要（UI/日志用）：错误是否清零、哪些项还开着。 */
export function summarizeErcConvergence(normalized) {
  const counts = normalized.openCounts || normalized.counts;
  return {
    ran: Boolean(normalized.ran),
    aggregateOnly: Boolean(normalized.aggregateOnly),
    detailAvailable: Boolean(normalized.detailAvailable),
    counts,
    errorsOpen: (counts.fatal || 0) + (counts.error || 0),
    warningsOpen: counts.warning || 0,
    exempted: (normalized.findings || []).filter((finding) => finding.exempted).length,
    invalidExemptions: (normalized.invalidExemptions || []).length,
    digest: normalized.digest,
  };
}
