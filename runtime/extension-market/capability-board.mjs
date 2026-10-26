import { createHash } from 'node:crypto';
import { deriveTags } from './tags.mjs';

/**
 * 扩展能力公告板（v0，纯函数，无 IO）。
 *
 * 目标：把“已装/市场里有哪些扩展”归一化成一张**可审计、可复现**的能力卡片列表，
 * 再按需求标签打分、按 token 预算裁剪，供 chat / 计划生成器 / 未来 orchestrator 消费。
 *
 * 三条硬约束（与 runtime/agents/agent-contract.mjs 的只读纪律一致）：
 *   1. 不猜：读不到的字段留 null / unknown，不编 uuid、不编版本、不编入口；
 *   2. 稳定：同一输入的 revision 必须相同（prompt 不抖动）；排序有确定的兜底键；
 *   3. 不越权：公告板只描述“有什么能力”，不声明“已经调用成功”，也不提供任何写操作。
 *
 * 注意：扩展的 capabilities 绝大多数是 GUI 菜单，不是可编程 API。因此 entryPoints 里
 * 只有显式登记了 bridgeCommand 的才算“可编程调用”；其它统一标注 menu/unknown，
 * prompt 片段必须带免责句，防止其它 AI 幻想自己“调用了扩展”。
 */

export const CAPABILITY_BOARD_VERSION = 1;
export const DEFAULT_BUDGET_TOKENS = 900;
export const MAX_BUDGET_TOKENS = 1500;

export const CAPABILITY_STATUSES = Object.freeze(['verified', 'probed', 'unverified', 'stale', 'incompatible', 'disabled']);
export const SIDE_EFFECTS = Object.freeze(['read-only', 'writes-board', 'unknown']);
export const COMPAT_STATUSES = Object.freeze(['tested', 'patch-drift', 'untested', 'unknown']);

const nowMs = (now) => (typeof now === 'function' ? now() : now instanceof Date ? now : new Date()).getTime();

/** 粗略 token 估算：中英混排按 2.2 字符/token；只用于预算裁剪，不用于计费。 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 2.2);
}

/** 稳定序列化：对象键排序，保证同一内容得到同一 digest。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

/** 简单 semver 解析；解析失败保留原文并标 versionParsed=false，绝不假装能比较。 */
export function parseVersion(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) return { version: text, versionParsed: false, major: null, minor: null, patch: null };
  return { version: text, versionParsed: true, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** 比较 a>b 时返回 1，a<b 返回 -1，相等/不可比返回 0（不可比时调用方必须按 unknown 处理）。 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left.versionParsed || !right.versionParsed) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return 0;
}

/**
 * 判断 `engines.eda` 与当前 EDA 版本是否兼容。
 * 只支持扩展生态里实际出现的几种写法：`^3.2.0` / `~3.2.0` / `>=3.0.0` / `>=3.2.170 <3.3.0` / 精确版本 / `*`。
 * 拿不准就返回 unknown —— 公告板宁可少推荐，也不把不兼容的扩展推给用户。
 */
export function evaluateCompat(enginesEdarange, currentEdaVersion) {
  const range = String(enginesEdarange ?? '').trim();
  const current = parseVersion(currentEdaVersion);
  if (!range) return { status: 'unknown', reason: 'NO_ENGINE_RANGE' };
  if (!current.versionParsed) return { status: 'unknown', reason: 'EDA_VERSION_UNKNOWN' };
  if (range === '*') return { status: 'tested', reason: 'ANY_VERSION' };

  const comparators = [];
  for (const part of range.split(/\s+/).filter(Boolean)) {
    let match;
    if ((match = /^\^(\d+\.\d+\.\d+)$/.exec(part))) comparators.push({ op: '^', version: match[1] });
    else if ((match = /^~(\d+\.\d+\.\d+)$/.exec(part))) comparators.push({ op: '~', version: match[1] });
    else if ((match = /^(>=|<=|>|<|=)(\d+\.\d+\.\d+)$/.exec(part))) comparators.push({ op: match[1], version: match[2] });
    else if (/^\d+\.\d+\.\d+$/.test(part)) comparators.push({ op: '=', version: part });
    else return { status: 'unknown', reason: `UNSUPPORTED_RANGE:${part.slice(0, 24)}` };
  }
  if (!comparators.length) return { status: 'unknown', reason: 'NO_ENGINE_RANGE' };

  const currentText = `${current.major}.${current.minor}.${current.patch}`;
  const cmp = (a, b) => {
    const left = parseVersion(a); const right = parseVersion(b);
    for (const key of ['major', 'minor', 'patch']) {
      if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
    }
    return 0;
  };
  for (const { op, version } of comparators) {
    const target = parseVersion(version);
    const currentCmpTarget = cmp(currentText, version);
    let ok = false;
    if (op === '=') ok = currentCmpTarget === 0;
    else if (op === '>') ok = currentCmpTarget > 0;
    else if (op === '>=') ok = currentCmpTarget >= 0;
    else if (op === '<') ok = currentCmpTarget < 0;
    else if (op === '<=') ok = currentCmpTarget <= 0;
    else if (op === '^') ok = target.major === current.major && currentCmpTarget >= 0;
    else if (op === '~') ok = target.major === current.major && target.minor === current.minor && currentCmpTarget >= 0;
    if (!ok) return { status: 'untested', reason: `RANGE_MISS:${range}` };
  }
  return { status: 'tested', reason: 'SATISFIES_RANGE' };
}

/**
 * 归一化一条“已装扩展”记录（来自 IndexedDB 快照或未来 provider）。
 * 输入字段可能是已提取的扁平结构，也可能是 extension.json 的 config 嵌套结构；两种都接受。
 */
export function normalizeInstalledRecord(record = {}, { now = () => new Date(), edaVersion = null } = {}) {
  const config = record.config && typeof record.config === 'object' ? record.config : record;
  const uuid = String(record.uuid ?? config.uuid ?? '').trim() || null;
  const extensionId = String(config.name ?? record.id ?? uuid ?? '').trim() || (uuid ? `ext-${uuid.slice(0, 8)}` : 'unknown-extension');
  const name = String(config.displayName ?? config.name ?? record.displayName ?? extensionId).trim();
  const version = String(config.version ?? record.version ?? '').trim() || null;
  const publisher = String(config.publisher ?? record.publisher ?? '').trim() || null;
  const summary = String(config.description ?? record.description ?? '').trim().slice(0, 240);
  const tags = deriveTags({ name, extensionId, keywords: config.keywords ?? [], categories: config.categories ?? [], summary });
  const engines = config.engines && typeof config.engines === 'object' ? config.engines : (record.engines ?? {});
  const edaRange = String(engines.eda ?? '').trim() || null;
  const compat = evaluateCompat(edaRange, edaVersion);
  const versionParsed = parseVersion(version).versionParsed;
  const notBefore = Number(config.activationEvents?.onStartupFinished ? 0 : 0); // 占位：不把激活事件当能力
  void notBefore;

  // 已装记录只能证明“它当时被装上了”，不能证明“入口能调用、版本兼容”。
  // 因此默认 probed；兼容性未知或明显不满足时降为 incompatible（硬过滤，不进推荐）。
  const status = compat.status === 'tested' || compat.status === 'patch-drift'
    ? 'probed'
    : compat.status === 'untested'
      ? 'incompatible'
      : 'unverified';

  return {
    schemaVersion: CAPABILITY_BOARD_VERSION,
    extensionId,
    uuid,
    name,
    version,
    versionParsed,
    publisher: publisher ? { name: publisher, verified: false } : null,
    summary,
    tags,
    entryPoints: [{ kind: 'menu', label: name, bridgeCommand: null }],
    preconditions: [{ id: 'eda-running', label: '需在嘉立创EDA中已启用', checkable: true }],
    sideEffects: 'unknown', // 不猜：没探测过就不能声称只读
    installPolicy: 'manual-only',
    compat: { edaVersionRange: edaRange, testedEdaVersions: [], status: compat.status, reason: compat.reason },
    status,
    lastVerifiedAt: record.installationTimeISO ?? record.installationTime ?? null,
    lastVerifiedBy: 'extension-registry@0.1.0',
    trust: 'unverified',
    provenance: { source: 'local-snapshot', path: null, url: null, fetchedAt: String(record.installationTimeISO ?? record.installationTime ?? '') || null, digest: null },
  };
}

/** 按 uuid 去重，保留 installationTime 最新的一条（IndexedDB 快照可能含历史记录）。 */
export function dedupeInstalled(records = []) {
  const byUuid = new Map();
  const anonymous = [];
  for (const record of Array.isArray(records) ? records : []) {
    const uuid = String(record?.uuid ?? record?.config?.uuid ?? '').trim();
    if (!uuid) { anonymous.push(record); continue; }
    const time = Date.parse(record?.installationTimeISO ?? record?.installationTime ?? '') || 0;
    const previous = byUuid.get(uuid);
    if (!previous || time >= previous.time) byUuid.set(uuid, { record, time });
  }
  return [...anonymous, ...[...byUuid.values()].map((entry) => entry.record)];
}

/** 打分 + 硬过滤。返回 { selected, dropped, scores }；纯函数，可单测。 */
export function selectCapabilities(capabilities = [], { tags = [], budgetTokens = DEFAULT_BUDGET_TOKENS, includeUnverified = false, now = () => new Date(), staleAfterMs = 24 * 3600_000 } = {}) {
  const requested = [...new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag).trim()).filter(Boolean))];
  const current = nowMs(now);
  const hardFiltered = [];
  const scored = [];

  for (const capability of Array.isArray(capabilities) ? capabilities : []) {
    if (!capability || typeof capability !== 'object') continue;
    if (capability.status === 'incompatible' || capability.status === 'disabled') { hardFiltered.push({ extensionId: capability.extensionId ?? null, reason: `STATUS_${String(capability.status).toUpperCase()}` }); continue; }
    if (capability.installPolicy === 'blocked') { hardFiltered.push({ extensionId: capability.extensionId ?? null, reason: 'INSTALL_POLICY_BLOCKED' }); continue; }
    if (!includeUnverified && capability.status === 'unverified') { hardFiltered.push({ extensionId: capability.extensionId ?? null, reason: 'UNVERIFIED' }); continue; }
    if (requested.length) {
      const overlap = (capability.tags ?? []).filter((tag) => requested.includes(tag));
      if (!overlap.length) { hardFiltered.push({ extensionId: capability.extensionId ?? null, reason: 'NO_TAG_MATCH' }); continue; }
    }
    const ages = capability.lastVerifiedAt ? current - Date.parse(capability.lastVerifiedAt) : Number.POSITIVE_INFINITY;
    const stale = !Number.isFinite(ages) || ages > staleAfterMs;
    const tagScore = requested.length ? (capability.tags ?? []).filter((tag) => requested.includes(tag)).length / requested.length : 1;
    const statusScore = capability.status === 'verified' ? 1 : capability.status === 'probed' ? 0.7 : capability.status === 'stale' || stale ? 0.4 : 0.3;
    const compatScore = capability.compat?.status === 'tested' ? 1 : capability.compat?.status === 'patch-drift' ? 0.6 : 0;
    const freshnessScore = Number.isFinite(ages) ? Math.max(0, 1 - ages / staleAfterMs) : 0;
    const sideEffectScore = capability.sideEffects === 'read-only' ? 1 : capability.sideEffects === 'unknown' ? 0.3 : 0.5;
    const score = 0.50 * tagScore + 0.20 * statusScore + 0.15 * compatScore + 0.10 * freshnessScore + 0.05 * sideEffectScore;
    scored.push({ capability, score: Number(score.toFixed(6)), stale });
  }

  // 同分按 extensionId 字典序兜底：保证渲染稳定 → digest 稳定 → prompt 不抖动。
  scored.sort((a, b) => (b.score - a.score) || String(a.capability.extensionId).localeCompare(String(b.capability.extensionId)));

  const selected = [];
  const dropped = [];
  let usedTokens = 0;
  const budget = Math.max(120, Math.min(Number(budgetTokens) || DEFAULT_BUDGET_TOKENS, MAX_BUDGET_TOKENS));
  for (const entry of scored) {
    const card = { ...entry.capability, stale: entry.stale };
    let tokens = estimateTokens(renderCard(card, 'full'));
    let detail = 'full';
    if (usedTokens + tokens > budget) { tokens = estimateTokens(renderCard(card, 'compact')); detail = 'compact'; }
    if (usedTokens + tokens > budget) { tokens = estimateTokens(renderCard(card, 'id-only')); detail = 'id-only'; }
    if (usedTokens + tokens > budget) { dropped.push({ extensionId: card.extensionId, reason: 'BUDGET' }); continue; }
    selected.push({ ...card, detail });
    usedTokens += tokens;
  }
  return { selected, dropped: [...hardFiltered, ...dropped], scores: scored.map((entry) => ({ extensionId: entry.capability.extensionId, score: entry.score })), tokenBudget: { budget, used: usedTokens, requestedTags: requested } };
}

/** 渲染单项；detail 三档由 selectCapabilities 决策，共享给 prompt 与 UI。 */
export function renderCard(capability, detail = 'full') {
  const name = String(capability?.name ?? capability?.extensionId ?? '未知扩展');
  const versionText = capability?.version ? `v${capability.version}` : null;
  // 扩展显示名里常自带版本号（如“原理图PCBAI-Agent v0.22.9”），避免重复拼接。
  const version = versionText && !name.includes(String(capability.version)) ? versionText : '';
  const tags = Array.isArray(capability?.tags) && capability.tags.length ? capability.tags.slice(0, 2).join('/') : '无标签';
  const compat = capability?.compat?.edaVersionRange ? `EDA ${capability.compat.edaVersionRange}` : '兼容性未知';
  if (detail === 'id-only') return `${name}${version ? ` ${version}` : ''}`;
  if (detail === 'compact') return `${name}${version ? ` ${version}` : ''}：${String(capability?.summary ?? '').slice(0, 30)}（${tags}；${compat}）`;
  return `${name}${version ? ` ${version}` : ''}：${String(capability?.summary ?? '').slice(0, 60) || '无简介'}（标签：${tags}；${compat}；入口：${capability?.entryPoints?.[0]?.kind ?? 'unknown'}；副作用：${capability?.sideEffects ?? 'unknown'}）`;
}

/**
 * 生成可注入其它 agent 的 prompt 片段。
 * 安全约束：不带 uuid / 本机路径 / 下载 URL / 版本下载参数；固定免责句；
 * 明确“菜单入口≠可编程调用”，防止模型声称已经调用。
 */
export function buildPromptSnippet(board, { maxChars = 1800 } = {}) {
  const selected = Array.isArray(board?.selected) ? board.selected : [];
  if (!selected.length) return { text: '', items: 0, truncated: false };
  const header = '【可参考的本机 EDA 扩展能力（只读清单，未经验证；仅供人工确认后使用，不代表已调用，也不能由你直接调用）】';
  const lines = selected.map((capability, index) => `${index + 1}. ${renderCard(capability, capability.detail ?? 'compact')}`);
  const footer = '使用规则：只能把这些当作“用户可以手动使用的工具线索”；不得声称已经调用、不得编造参数或结果；需要使用时先向用户确认入口。';
  const budget = Math.max(200, Math.min(Number(maxChars) || 1800, 4000));
  const kept = [];
  let used = header.length + footer.length;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line); used += line.length + 1;
  }
  const text = [header, ...kept, footer].join('\n');
  return { text, items: kept.length, truncated: kept.length < lines.length };
}

/** 公告板内容摘要（16 hex），用于“未变则零成本轮询”。 */
export function computeRevision(capabilities = []) {
  const normalized = (Array.isArray(capabilities) ? capabilities : []).map((capability) => ({
    extensionId: capability?.extensionId ?? null,
    uuid: capability?.uuid ?? null,
    version: capability?.version ?? null,
    status: capability?.status ?? null,
    tags: Array.isArray(capability?.tags) ? [...capability.tags].sort() : [],
    compat: capability?.compat?.status ?? null,
  })).sort((a, b) => String(a.extensionId).localeCompare(String(b.extensionId)));
  return sha256(normalized).slice(0, 16);
}

/** 汇总公告板：输入归一化后的能力卡，输出可直接落盘/返回的 board 对象。 */
export function buildCapabilityBoard(capabilities = [], { tags = [], budgetTokens = DEFAULT_BUDGET_TOKENS, includeUnverified = false, now = () => new Date() } = {}) {
  const selection = selectCapabilities(capabilities, { tags, budgetTokens, includeUnverified, now });
  const prompt = buildPromptSnippet(selection);
  return {
    schemaVersion: CAPABILITY_BOARD_VERSION,
    generatedAt: (typeof now === 'function' ? now() : now instanceof Date ? now : new Date()).toISOString(),
    revision: computeRevision(capabilities),
    query: { tags: selection.tokenBudget.requestedTags, budgetTokens: selection.tokenBudget.budget, includeUnverified: Boolean(includeUnverified) },
    counts: { total: (Array.isArray(capabilities) ? capabilities : []).length, selected: selection.selected.length, dropped: selection.dropped.length },
    tokenBudget: selection.tokenBudget,
    selected: selection.selected,
    dropped: selection.dropped,
    prompt,
  };
}
