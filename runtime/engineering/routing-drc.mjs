/**
 * 布线写入后的**真实 DRC 回归校验**：计划复核通过 ≠ 真机 DRC 通过。
 *
 * 真机第 58/59 轮：规划器基于内切圆近似几何算出"最小间距 6.39 mil ≥ 6"，
 * 写入后嘉立创 EDA 的精确几何 DRC 仍报 4 处间距违规（via/track 贴近矩形焊盘）。
 * 旧流程只能靠人发现、手工回滚——产品必须自己闭环：
 *
 *   baseline DRC → 写入 → after DRC → 只比较**新增**违规
 *     · 没有新增 ⇒ 放行（把 before/after 计数记进证据）
 *     · 有新增   ⇒ 自动回滚本批写入，返回 ROUTING_DRC_REGRESSION（含新增明细）
 *     · after DRC 不可用 ⇒ 抛 ROUTING_DRC_REPORT_INVALID，**绝不**把"没校验"当"通过"
 *
 * 只对真实写入（dryRun=false）执行；dry-run 不写板，跳过。
 */
import { normalizeDrcReport } from '../drc.mjs';

export const ROUTING_DRC_CODES = Object.freeze({
  REGRESSION: 'ROUTING_DRC_REGRESSION',
  REPORT_INVALID: 'ROUTING_DRC_REPORT_INVALID',
  GUARD_APPLIED: 'ROUTING_DRC_GUARD_APPLIED',
});

const itemKey = (item) => String(item?.instanceKey || item?.signature || item?.errorType || '');

/** 比较两份归一化 DRC 报告的**新增/消失**违规（按 instanceKey/signature 集合）。 */
export function diffDrcReports(before, after) {
  const beforeKeys = new Set((before?.items || []).map(itemKey).filter(Boolean));
  const afterItems = after?.items || [];
  const newItems = afterItems.filter((item) => {
    const key = itemKey(item);
    return key && !beforeKeys.has(key);
  });
  const afterKeys = new Set(afterItems.map(itemKey).filter(Boolean));
  const resolvedItems = (before?.items || []).filter((item) => {
    const key = itemKey(item);
    return key && !afterKeys.has(key);
  });
  return {
    newItems,
    newCount: newItems.length,
    resolvedItems,
    resolvedCount: resolvedItems.length,
    beforeCount: (before?.items || []).length,
    afterCount: afterItems.length,
  };
}

/**
 * 写前 baseline、写后复核、回归即回滚的包装。`apply`/`rollback`/`runDrc` 可注入，便于离线测试。
 */
export async function applyRoutingWithDrcGuard({
  execute,
  plan,
  geometry,
  dryRun = true,
  save = false,
  options = {},
  verifyDrc = true,
  runDrc = defaultRunDrc,
  apply = defaultApply,
  rollback = defaultRollback,
  logger = null,
} = {}) {
  if (!verifyDrc || dryRun) {
    if (verifyDrc && dryRun) logger?.info?.('ROUTING_DRC_GUARD_SKIPPED_DRY_RUN');
    return await apply({ execute, plan, geometry, dryRun, save, options });
  }
  const baseline = normalizeDrcReport(await runDrc(execute));
  if (!baseline.ok) {
    throw Object.assign(new Error(`写前 DRC 报告不可用（${baseline.code || 'REPORT_INVALID'}）：无法确认"新增违规"基线，拒绝在未校验状态下写入`), {
      code: ROUTING_DRC_CODES.REPORT_INVALID,
      status: 409,
      details: { phase: 'before', code: baseline.code ?? null, message: baseline.message ?? null },
    });
  }
  // 写前铜快照（第 31 轮真机缺陷 D-31-4）：创建响应可能没有图元 ID，按 ID 回滚会漏删、残检还报 0。
  // 这里在写入前抓一份板面快照，回滚时按"当前铜 − 写前铜"的差集删干净。
  let beforeCopper = null;
  try { beforeCopper = (await execute('pcb.copper.read', {}, {}))?.result ?? null; } catch { beforeCopper = null; }
  const applied = await apply({ execute, plan, geometry, dryRun, save, options });
  const after = normalizeDrcReport(await runDrc(execute));
  if (!after.ok) {
    // 写入已发生但校验不可用：如实抛错并回滚，保住"要么验证通过、要么不留铜"。
    const rollbackResult = await rollback({ execute, items: applied?.written || [], before: beforeCopper }).catch((error) => ({ error: String(error?.message || error).slice(0, 200) }));
    throw Object.assign(new Error(`写后 DRC 报告不可用（${after.code || 'REPORT_INVALID'}）：无法确认新增违规，已回滚本批写入`), {
      code: ROUTING_DRC_CODES.REPORT_INVALID,
      status: 409,
      details: { phase: 'after', code: after.code ?? null, message: after.message ?? null, rollback: rollbackResult },
    });
  }
  const diff = diffDrcReports(baseline, after);
  if (diff.newCount > 0) {
    const rollbackResult = await rollback({ execute, items: applied?.written || [], before: beforeCopper }).catch((error) => ({ error: String(error?.message || error).slice(0, 200) }));
    throw Object.assign(new Error(`写入后真实 DRC 新增 ${diff.newCount} 条违规（写前 ${diff.beforeCount} → 写后 ${diff.afterCount}），已自动回滚本批铜：${diff.newItems.slice(0, 4).map((item) => `${item.errorType}${item.net ? `(${item.net})` : ''}`).join('、')}`), {
      code: ROUTING_DRC_CODES.REGRESSION,
      status: 409,
      details: {
        newCount: diff.newCount,
        resolvedCount: diff.resolvedCount,
        beforeCount: diff.beforeCount,
        afterCount: diff.afterCount,
        newItems: diff.newItems.slice(0, 50).map((item) => ({ errorType: item.errorType, ruleName: item.ruleName, net: item.net, layer: item.layer, group: item.group, instanceKey: item.instanceKey })),
        rollback: rollbackResult,
      },
    });
  }
  return { ...applied, drcCheck: { ok: true, beforeCount: diff.beforeCount, afterCount: diff.afterCount, resolvedCount: diff.resolvedCount, newCount: 0 } };
}

export async function defaultRunDrc(execute) {
  const raw = await execute('pcb.drc', {});
  const result = raw?.result ?? raw;
  // 真机（第 31 轮）：`PCB_Drc.check` 返回的是**分组数组** `[{name, list:[...]}]`，
  // 而 normalizeDrcReport 要求 `{items:[...]}`。此前只在单测里用 mock 报告走通门禁，
  // 真板上表现为"写前 DRC 报告不可用（缺少 items 数组）"→ 布线写入门禁永远拒写。
  // 这里把数组包装成 items，交回给同一套归一化（walk 认 list 嵌套）。
  return Array.isArray(result) ? { items: result, rawArrayShape: true } : result;
}

async function defaultApply(options) {
  const { applyRoutingPlan } = await import('./pcb-routing.mjs');
  return applyRoutingPlan(options);
}

async function defaultRollback({ execute, items }) {
  const { rollbackRouting } = await import('./pcb-routing.mjs');
  return rollbackRouting({ execute, items });
}

export { itemKey as drcItemKey };
