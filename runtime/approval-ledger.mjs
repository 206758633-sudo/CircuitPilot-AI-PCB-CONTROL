/**
 * 批准账本（C2 统一审计）。
 *
 * 为什么要有它：自动化批准原先写自己的哈希链 journal，而设计/PCB 的计划批准是内存 token，
 * 签发/消费/撤销没有任何审计痕迹——同是"人工批准"，一个可追溯、一个不可追溯。
 * 这里给三类批准一个统一的**只追加哈希链账本**：每条记录带 prevHash + entryHash，
 * 任何一条被改都会在 verify() 里暴露；落盘后重启仍能核对历史。
 *
 * 账本只记录"批准生命周期事实"（scope/action/绑定哈希/时间），**绝不记录令牌原文**。
 * W5-04 起新增 signed/rejected 两个人工终审动作（放行签字/驳回），同样进哈希链。
 * 令牌依然只存在于内存、一次性、30 分钟过期。放行批准当前以人工签核证据表达（见 B1），
 * scope=release 预留但尚无签发点。
 *
 * P2-9（2026-11-05 运行时/运维审计）：账本文件损坏时旧实现"降级内存 + 从 GENESIS 重记"，
 * 但只有 `loadError` 一个字符串——审计/UI 无法区分"这是一条新链"和"旧链本来就是这样"。
 * 现在给降级状态显式标记：
 *   - 降级期间 `record()` 写入的条目带 `degraded:true`（进 payload，因此也进 entryHash，
 *     事后改不掉）；`snapshot()` 返回 `degraded` 与 `degradedSince`；
 *   - **不改变验链行为**：verify() 仍然按 prevHash+payload 重算，新链自身首尾相接即 ok；
 *     历史链丢失这一事实由 `loadError + degraded` 表达，而不是伪造旧记录。
 */
import crypto from 'node:crypto';

export const APPROVAL_LEDGER_VERSION = 1;
export const APPROVAL_LEDGER_SCOPES = ['plan', 'write', 'release'];
export const APPROVAL_LEDGER_ACTIONS = ['issued', 'consumed', 'revoked', 'expired', 'replayed', 'mismatch', 'signed', 'rejected'];

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const digestOf = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export function createApprovalLedger({ store = null, now = () => new Date().toISOString(), maxEntries = 500 } = {}) {
  let entries = [];
  let loadError = null;
  // 降级起点：只有"文件读坏/读失败"才算降级；纯内存账本（store=null）不是降级。
  let degradedSince = null;
  if (store) {
    try {
      const loaded = store.load();
      entries = Array.isArray(loaded?.data?.entries) ? loaded.data.entries : [];
    } catch (error) {
      // 损坏的账本不能静默重置：保留错误码上报，同时以空账本继续（后续写入从 GENESIS 起链）。
      // 从这一刻起新写入的条目带 degraded:true，让审计能看出"这之后是新链、旧历史丢了"。
      loadError = error?.code || 'APPROVAL_LEDGER_LOAD_FAILED';
      degradedSince = now();
      entries = [];
    }
  }
  const persist = () => { if (store) store.save({ entries }); };

  const record = ({ scope, action, approvalId = null, bindings = {}, note = '' } = {}) => {
    if (!APPROVAL_LEDGER_SCOPES.includes(scope)) throw Object.assign(new Error(`未知批准作用域：${scope}`), { code: 'APPROVAL_LEDGER_SCOPE_INVALID' });
    if (!APPROVAL_LEDGER_ACTIONS.includes(action)) throw Object.assign(new Error(`未知批准动作：${action}`), { code: 'APPROVAL_LEDGER_ACTION_INVALID' });
    const at = now();
    const index = entries.length;
    const prevHash = index > 0 ? entries[index - 1].entryHash : 'GENESIS';
    // degraded 必须在算 entryHash 之前进入 payload：这样它既能在快照里被看到，也改不掉。
    const payload = { index, at, scope, action, approvalId: approvalId ? String(approvalId).slice(0, 64) : null, bindings: bindings || {}, note: String(note || '').slice(0, 200), ...(degradedSince ? { degraded: true } : {}) };
    const entryHash = digestOf(`${prevHash}|${stableStringify(payload)}`);
    const entry = { ...payload, prevHash, entryHash };
    entries.push(entry);
    if (entries.length > maxEntries) entries = entries.slice(entries.length - maxEntries);
    persist();
    return entry;
  };

  const verify = () => {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || typeof entry.entryHash !== 'string' || typeof entry.prevHash !== 'string') return { ok: false, brokenAt: index, reason: '记录结构缺失' };
      const { prevHash, entryHash, ...payload } = entry;
      const expected = digestOf(`${prevHash}|${stableStringify(payload)}`);
      if (expected !== entryHash) return { ok: false, brokenAt: index, reason: 'entryHash 与内容不匹配（账本被改动过）' };
      // 裁剪后的第一条允许以任意 prevHash 起锚；其余必须首尾相接。
      if (index > 0 && entry.prevHash !== entries[index - 1].entryHash) return { ok: false, brokenAt: index, reason: '与上一条的哈希链断开' };
    }
    return { ok: true, brokenAt: null, reason: '' };
  };

  return {
    record,
    verify,
    get loadError() { return loadError; },
    /** 账本是否处于"文件读坏、从 GENESIS 重记"的降级态；供 HTTP 快照/审计直接读。 */
    get degraded() { return Boolean(degradedSince); },
    get degradedSince() { return degradedSince; },
    snapshot({ limit = 100 } = {}) {
      // 返回深拷贝：调用方（HTTP 序列化/UI）改动快照不能污染账本本身。
      const tail = entries.slice(Math.max(0, entries.length - Math.max(1, limit))).map((entry) => JSON.parse(JSON.stringify(entry)));
      const summary = { total: entries.length, byScope: {}, byAction: {} };
      for (const entry of entries) {
        summary.byScope[entry.scope] = (summary.byScope[entry.scope] || 0) + 1;
        summary.byAction[entry.action] = (summary.byAction[entry.action] || 0) + 1;
      }
      // degraded/degradedSince 是新增的附加字段（不删旧字段）：UI/审计据此区分"新链"与"历史链丢失"。
      return { entries: tail, summary, chain: verify(), loadError, degraded: Boolean(degradedSince), degradedSince };
    },
  };
}
