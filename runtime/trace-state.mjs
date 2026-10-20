/**
 * C1（剩余部分）：前端"追溯三件套"（版本快照 / 修改日志 / 界面审计）的服务端权威副本。
 *
 * 背景：项目/需求/器件已由 `project-state.mjs` 落 Runtime，但 versions/changes/audit
 * 仍只活在浏览器 localStorage——换机器、清缓存就没有了，"工程记录"不成立。
 *
 * 设计原则：
 *  - fail-closed 校验：形状不对、条目缺 id、id 重复 → `TRACE_STATE_INVALID`（400），不静默修正；
 *  - 有上限：按时间倒序保留最近 N 条（版本 500 / 修改 2000 / 审计 2000），超出部分如实截断并回报；
 *  - 原子写（tmp+rename）由 `store.mjs` 保证；损坏/版本不匹配抛 `STORE_*`，不假装读成功；
 *  - 只是用户工作记录，不是 EDA 写板，不需要写板批准，但仍要求 Runtime 会话令牌。
 */
import { createJsonStore } from './store.mjs';

export const TRACE_STATE_CODES = {
  INVALID: 'TRACE_STATE_INVALID',
};

export const TRACE_LIMITS = Object.freeze({ versions: 500, changes: 2000, audit: 2000 });

const text = (value) => String(value ?? '').trim();
const asArray = (value, field) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Object.assign(new Error(`${field} 必须是数组`), { code: TRACE_STATE_CODES.INVALID, details: { field } });
  return value;
};

function normalizeList(items, field, limit) {
  const seen = new Set();
  const output = [];
  const truncated = Math.max(0, items.length - limit);
  for (const item of items.slice(0, limit)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error(`${field} 的条目必须是对象`), { code: TRACE_STATE_CODES.INVALID, details: { field } });
    }
    const id = text(item.id);
    if (!id) throw Object.assign(new Error(`${field} 的条目缺少 id`), { code: TRACE_STATE_CODES.INVALID, details: { field: `${field}[].id` } });
    if (seen.has(id)) throw Object.assign(new Error(`${field} 的 id 重复：${id}`), { code: TRACE_STATE_CODES.INVALID, details: { field: `${field}[].id`, id } });
    seen.add(id);
    output.push(item);
  }
  return { items: output, truncated };
}

/** 校验并归一化追溯状态；失败抛 TRACE_STATE_INVALID。 */
export function normalizeTraceState(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('追溯状态必须是对象'), { code: TRACE_STATE_CODES.INVALID, details: { field: 'state' } });
  }
  const versions = normalizeList(asArray(input.versions, 'versions'), 'versions', TRACE_LIMITS.versions);
  const changes = normalizeList(asArray(input.changes, 'changes'), 'changes', TRACE_LIMITS.changes);
  const audit = normalizeList(asArray(input.audit, 'audit'), 'audit', TRACE_LIMITS.audit);
  return {
    state: { versions: versions.items, changes: changes.items, audit: audit.items },
    truncated: {
      versions: versions.truncated,
      changes: changes.truncated,
      audit: audit.truncated,
    },
    total: { versions: versions.items.length, changes: changes.items.length, audit: audit.items.length },
  };
}

/**
 * 创建追溯状态存储（原子写 + 重启读回）。损坏时抛 STORE_*，由 server 大声降级，不伪造历史。
 */
export function createTraceStateStore({ file, now = () => new Date() } = {}) {
  const store = createJsonStore({ file, schemaVersion: 1, now });
  return {
    /** 读回 `{ state, savedAt, truncated? }`；文件不存在时返回空状态（savedAt:null）。 */
    load() {
      const loaded = store.load();
      const data = loaded.data && typeof loaded.data === 'object' ? loaded.data : {};
      const normalized = normalizeTraceState({ versions: data.versions, changes: data.changes, audit: data.audit });
      return { ...normalized, savedAt: loaded.savedAt, migratedFrom: loaded.migratedFrom };
    },
    save(input) {
      const normalized = normalizeTraceState(input);
      const payload = store.save(normalized.state);
      return { ...normalized, savedAt: payload.savedAt };
    },
  };
}
