/**
 * 原理图 ERC 明细提取（产品级缺陷修复）。
 *
 * 问题（真机第 58/59 轮）：EDA 的 `schematic.drc` 扩展 API 只返回**聚合计数**
 * （如 `[{type:'error',count:1},{type:'warn',count:34}]`），CircuitPilot 的 ERC 取证与
 * 发布门禁因此只能得出"有 1 个错误"这种不可执行的结论——用户知道错了，但不知道错在哪，
 * 工程就卡在 `RELEASE_SCHEMATIC_NOT_READY` 上。而 EDA 的**检查面板 UI 里是逐条明细**。
 *
 * 本模块把"从界面面板抓逐条明细"产品化为可复用能力：
 *   1. `extractErcDetail({ gui })` —— 通过 EDA GUI 通道（CDP）打开/读取检查面板，返回逐条 items；
 *      DOM 抓取失败时如实返回 `{ok:false, reason}`，绝不编造条目；
 *   2. `mergeErcDetail(report, detail)` —— 把明细合并进 `erc.mjs` 归一化报告：
 *      某级别明细条数 >= 聚合计数时用逐条 finding 替换聚合 finding，覆盖不全的级别保留聚合条目
 *      （宁可"部分明细 + 部分聚合"，也不把 34 条警告只写 5 条就当全量）。
 */
import { normalizeErcReport } from './erc.mjs';

export const ERC_DETAIL_SOURCE = 'ui-dom';

const severityOf = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'fatal' || text === 'critical' || text.includes('致命')) return 'fatal';
  if (text === 'error' || text === 'err' || text.includes('错误')) return 'error';
  if (text === 'warn' || text === 'warning' || text.includes('警告')) return 'warning';
  return 'info';
};

/**
 * 从 EDA 界面抓 ERC 明细。
 * @param {{gui?: {execute: Function}, timeoutMs?: number}} options
 * @returns {Promise<{ok:boolean, source?:string, counts?:object|null, items?:Array<{level:string,message:string,object?:string}>, reason?:string}>}
 */
export async function extractErcDetail({ gui = null, timeoutMs = 25_000, expectedCounts = null } = {}) {
  if (!gui || typeof gui.execute !== 'function') return { ok: false, reason: 'NO_GUI' };
  // 硬超时保护：GUI 通道可能卡在 CDP 连接/上下文探测上（页面不是编辑器、EDA 半启动等），
  // 不能让一次 ERC 取证无限挂起——超时就如实降级为"明细不可用"，聚合结论照常可出。
  const budget = Math.max(1_000, Math.min(Number(timeoutMs) || 25_000, 120_000));
  let timer = null;
  const hardTimeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'ERC_DETAIL_TIMEOUT' }), budget + 8_000);
    timer.unref?.();
  });
  try {
    const detail = await Promise.race([
      Promise.resolve().then(() => gui.execute('ercDetail', { timeoutMs: budget, expectedCounts: expectedCounts && typeof expectedCounts === 'object' ? expectedCounts : null })).catch((error) => ({ ok: false, reason: String(error?.code || error?.message || error).slice(0, 200) })),
      hardTimeout,
    ]);
    if (!detail || detail.ok !== true) return { ok: false, reason: String(detail?.reason || 'ERC_DETAIL_EXTRACT_FAILED').slice(0, 200), counts: detail?.counts ?? null };
    const items = Array.isArray(detail.items)
      ? detail.items.map((item) => ({ ...item, message: typeof item?.message === 'string' ? item.message.trim() : '' })).filter((item) => item.message)
      : [];
    if (!items.length) return { ok: false, reason: 'ERC_DETAIL_NO_ITEMS', counts: detail.counts ?? null };
    return {
      ok: true,
      source: ERC_DETAIL_SOURCE,
      counts: detail.counts ?? null,
      items: items.map((item) => ({ level: severityOf(item.level), message: String(item.message).slice(0, 400), ...(item.object ? { object: String(item.object).slice(0, 120) } : {}) })),
    };
  } catch (error) {
    return { ok: false, reason: String(error?.code || error?.message || error).slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把逐条明细合并进归一化 ERC 报告。返回值仍是 `normalizeErcReport` 的完整结构，
 * 额外带 `detailSource` 与 `detailCounts`，供证据/门禁区分"逐条结论"与"聚合结论"。
 */
export function mergeErcDetail(normalized, detail) {
  if (!normalized || !detail?.ok || !Array.isArray(detail.items) || !detail.items.length) return normalized;
  const counts = normalized.counts || {};
  const bySeverity = new Map();
  for (const item of detail.items) {
    const severity = severityOf(item.level);
    if (!bySeverity.has(severity)) bySeverity.set(severity, []);
    bySeverity.get(severity).push({ level: severity, message: item.message, ...(item.object ? { object: item.object } : {}) });
  }
  // 只有"明细条数 >= 聚合计数"的级别才整体替换；覆盖不全的级别保留原聚合条目（并如实报告剩余数量）。
  const groups = [];
  const covered = new Set();
  const partial = {};
  for (const [severity, items] of bySeverity) {
    const expected = Number(counts[severity]) || 0;
    if (items.length && items.length >= expected) {
      groups.push({ type: severity, items });
      covered.add(severity);
    } else if (items.length) {
      covered.add(severity);
      groups.push({ type: severity, items });
      const remaining = expected - items.length;
      if (remaining > 0) groups.push({ type: severity, count: remaining, message: `还有 ${remaining} 条未从界面取到明细（面板滚动/虚拟列表限制），按聚合计数保留` });
      partial[severity] = { detailed: items.length, expected };
    }
  }
  if (!covered.size) return normalized;
  // 未覆盖的级别继续用原聚合组（info 等），保证总数不丢。
  for (const group of normalized.groups || []) {
    const severity = severityOf(group.type);
    if (covered.has(severity)) continue;
    groups.push({ type: severity, count: Number(group.count) || 0 });
  }
  const merged = normalizeErcReport(groups);
  merged.detailSource = ERC_DETAIL_SOURCE;
  merged.detailCounts = { ...(detail.counts || {}), partial };
  // 逐条明细里可能有聚合计数漏掉的级别信息：保留、但不重复累计（normalizeErcReport 已重算 counts）。
  return merged;
}
