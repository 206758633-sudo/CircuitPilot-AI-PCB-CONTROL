/**
 * 证据目录保留策略：证据是发布链的审计依据，但只增不删会无限膨胀（真机每跑一次验收/DRC/仿真都落一份）。
 *
 * 原则：
 *   - 默认保守：只清理**同时**满足"超过保留时长"或"超出保留条数"的旧条目，且永远保留最近 N 条；
 *   - 计划与执行分离：`planRetention()` 纯函数（可测试），`pruneEvidenceStore()` 只按计划删文件；
 *   - 清理不是"删证据"而是"归档"：被删条目的路径/摘要/落盘时间写进返回报告，便于追溯。
 */
import { existsSync, unlinkSync } from 'node:fs';

export const DEFAULT_RETENTION = Object.freeze({
  maxAgeMs: 90 * 24 * 60 * 60 * 1000,
  maxCount: 500,
  minKeep: 20,
});

const savedAtMs = (entry) => {
  const value = Date.parse(String(entry?.savedAt || ''));
  return Number.isFinite(value) ? value : null;
};

/**
 * @param {Array<object>} entries evidence-store 条目
 * @returns {{keep: object[], prune: Array<{entry:object, reason:string}>}}
 */
export function planRetention(entries, { maxAgeMs = DEFAULT_RETENTION.maxAgeMs, maxCount = DEFAULT_RETENTION.maxCount, minKeep = DEFAULT_RETENTION.minKeep, now = Date.now() } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .sort((left, right) => (savedAtMs(right) ?? 0) - (savedAtMs(left) ?? 0));
  const keep = [];
  const prune = [];
  list.forEach((entry, index) => {
    const saved = savedAtMs(entry);
    const tooMany = index >= maxCount;
    const tooOld = saved !== null && now - saved > maxAgeMs;
    const protectedNewest = index < Math.max(0, Number(minKeep) || 0);
    if (protectedNewest) { keep.push(entry); return; }
    if (tooMany || tooOld) {
      prune.push({ entry, reason: tooMany ? `超出保留条数（>${maxCount}）` : '超过保留时长' });
      return;
    }
    keep.push(entry);
  });
  return { keep, prune };
}

/** 按计划清理某类证据文件；返回可审计的清理报告（不吞错误，单个失败记入 errors）。 */
export function pruneEvidenceStore({ store, kind, dryRun = false, ...options } = {}) {
  if (!store || typeof store.list !== 'function') throw Object.assign(new Error('缺少证据存储'), { code: 'EVIDENCE_STORE_REQUIRED' });
  const entries = store.list(kind);
  const { keep, prune } = planRetention(entries, options);
  const removed = [];
  const errors = [];
  for (const { entry, reason } of prune) {
    const record = { path: entry.path ?? null, digest: entry.digest ?? null, savedAt: entry.savedAt ?? null, reason };
    if (dryRun) { removed.push(record); continue; }
    try {
      if (entry.path && existsSync(entry.path)) unlinkSync(entry.path);
      removed.push(record);
    } catch (error) {
      errors.push({ path: entry.path ?? null, message: String(error?.message || error).slice(0, 200) });
    }
  }
  return { kind, dryRun, scanned: entries.length, kept: keep.length, pruned: removed.length, removed, errors };
}
