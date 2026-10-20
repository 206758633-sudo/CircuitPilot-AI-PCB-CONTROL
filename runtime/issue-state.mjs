/**
 * C1（最后一块）：问题中心（issues）的 Runtime 权威副本。
 *
 * 背景：项目/需求/器件/证据/追溯三件套已由 Runtime 落盘，issues 仍只在前端内存/localStorage——
 * 换机器、清缓存后"问题处理历史"就丢了，C1 不算完成。
 *
 * 口径：
 *  - fail-closed 校验：形状不对、条目缺 id、id 重复 → `ISSUE_STATE_INVALID`(400)，不静默修正；
 *  - 上限 300 条（与前端 reducer 的 `slice(0,300)` 一致），超出如实截断并回报；
 *  - 原子写由 store.mjs 保证；损坏/版本不匹配抛 STORE_*，不假装空状态；
 *  - 只是用户工作记录，不写 EDA，不需要写板批准，但仍要求 Runtime 会话令牌。
 */
import { createJsonStore } from './store.mjs';

export const ISSUE_STATE_CODES = { INVALID: 'ISSUE_STATE_INVALID' };
export const ISSUE_LIMIT = 300;
const text = (value) => String(value ?? '').trim();

export function normalizeIssueState(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('问题状态必须是对象'), { code: ISSUE_STATE_CODES.INVALID, details: { field: 'state' } });
  }
  if (input.issues !== undefined && !Array.isArray(input.issues)) {
    throw Object.assign(new Error('issues 必须是数组'), { code: ISSUE_STATE_CODES.INVALID, details: { field: 'issues' } });
  }
  const seen = new Set();
  const issues = [];
  for (const item of (input.issues || []).slice(0, ISSUE_LIMIT)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error('issues 的条目必须是对象'), { code: ISSUE_STATE_CODES.INVALID, details: { field: 'issues[]' } });
    }
    const id = text(item.id);
    if (!id) throw Object.assign(new Error('issues 的条目缺少 id'), { code: ISSUE_STATE_CODES.INVALID, details: { field: 'issues[].id' } });
    if (seen.has(id)) throw Object.assign(new Error(`issues 的 id 重复：${id}`), { code: ISSUE_STATE_CODES.INVALID, details: { field: 'issues[].id', id } });
    seen.add(id);
    issues.push(item);
  }
  return {
    state: { issues },
    truncated: Math.max(0, (input.issues || []).length - ISSUE_LIMIT),
    total: issues.length,
  };
}

export function createIssueStateStore({ file, now = () => new Date() } = {}) {
  const store = createJsonStore({ file, schemaVersion: 1, now });
  return {
    load() {
      const loaded = store.load();
      const data = loaded.data && typeof loaded.data === 'object' ? loaded.data : {};
      const normalized = normalizeIssueState({ issues: data.issues });
      return { ...normalized, savedAt: loaded.savedAt, migratedFrom: loaded.migratedFrom };
    },
    save(input) {
      const normalized = normalizeIssueState(input);
      const payload = store.save(normalized.state);
      return { ...normalized, savedAt: payload.savedAt };
    },
  };
}
