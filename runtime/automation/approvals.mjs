/**
 * 人工批准存储（Phase 1）——统一批准服务的自动化适配器。
 *
 * 核心生命周期（签发/TTL/一次性/绑定校验/审计事件）已收敛到 `runtime/approval-service.mjs`；
 * 本文件只负责：
 *   1. 把"配方/指纹"这层绑定语义翻译成 service 的 bindings + match；
 *   2. 把生命周期事件写成原有格式的 journal 记录与统一哈希链账本；
 *   3. 保持对外 API（issue/list/resolve）与错误码不变。
 *
 * 为什么不能由调用方传 `{write:true}`：那等于自己给自己发许可证。批准必须满足：
 *   - 由**服务端**在真实 EDA 会话上签发（绑定当前窗口 + 工程 + 文档指纹）；
 *   - 有作用域（plan / write / release）与目标配方；
 *   - 有有效期、一次性使用；
 *   - 签发/消费都写进哈希链审计。
 *
 * 内存态只在进程内有效：运行时重启后旧批准自动失效，需要重新批——这是有意的安全行为。
 */
import crypto from 'node:crypto';
import { APPROVAL_SCOPES } from './safety.mjs';
import { createApprovalService } from '../approval-service.mjs';

export const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000;
export const MAX_ACTIVE_APPROVALS = 200;

const code = (message, name, extra = {}) => Object.assign(new Error(message), { code: name, ...extra });

/** 当前 EDA 目标指纹：窗口 + 工程 + 文档；批准绑它，防止"批完换块板再执行"。 */
export function fingerprintOf({ windowId, projectUuid, documentUuid } = {}) {
  return crypto.createHash('sha256').update(`${windowId || ''}|${projectUuid || ''}|${documentUuid || ''}`).digest('hex').slice(0, 32);
}

export function createApprovalStore({ journal = null, ledger = null, now = () => new Date().toISOString(), ttlMs = DEFAULT_APPROVAL_TTL_MS, maxEntries = MAX_ACTIVE_APPROVALS } = {}) {
  const clockMs = () => {
    const value = now();
    const milliseconds = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(milliseconds)) throw code('批准时钟返回了非法时间', 'APPROVAL_CLOCK_INVALID');
    return milliseconds;
  };
  const isoOf = (milliseconds) => new Date(milliseconds).toISOString();

  const record = (approvalId, payload) => {
    let journalEntry = null;
    if (journal) {
      try {
        journalEntry = journal.append(`approval-${approvalId}`, { at: now(), ...payload });
      } catch (error) {
        throw code(`批准审计写入失败：${error?.message || error}`, 'AUTOMATION_JOURNAL_FAILED', { cause: error?.code });
      }
    }
    // 统一批准账本（C2）：与 journal 同源事实，但跨三类批准共用一条哈希链，便于统一核对。
    if (ledger) {
      try {
        ledger.record({
          scope: payload.scope,
          action: payload.phase === 'approval.consumed' ? 'consumed' : 'issued',
          approvalId,
          bindings: { recipeId: payload.recipeId ?? null, fingerprint: payload.fingerprint ?? null, planHash: payload.planHash ?? null },
          note: payload.phase,
        });
      } catch (error) {
        throw code(`批准账本写入失败：${error?.message || error}`, 'APPROVAL_LEDGER_FAILED', { cause: error?.code });
      }
    }
    return journalEntry;
  };

  const service = createApprovalService({
    now: clockMs,
    defaultTtlMs: ttlMs,
    maxEntries,
    allowedScopes: APPROVAL_SCOPES,
    onEvent: (event) => {
      // 与旧实现保持同构：只有签发/消费写 journal+账本；重放/过期/不匹配由 service 直接拒绝。
      if (event.action !== 'issued' && event.action !== 'consumed') return;
      const item = event.record;
      record(item.approvalId, {
        phase: event.action === 'consumed' ? 'approval.consumed' : 'approval.issued',
        scope: item.scope,
        recipeId: item.bindings.recipeId ?? null,
        fingerprint: item.bindings.fingerprint ?? null,
        planHash: item.bindings.planHash ?? null,
        expiresAt: isoOf(item.expiresAt),
      });
    },
  });

  return {
    /** 签发批准：scope 必填，recipeId 为 null 表示"任意配方"，fingerprint 由调用方在真实 EDA 会话上读取。 */
    issue({ scope, recipeId = null, fingerprint = null, planHash = null, note = '' } = {}) {
      if (!APPROVAL_SCOPES.includes(scope)) throw code(`批准作用域必须是 ${APPROVAL_SCOPES.join('/')}`, 'AUTOMATION_APPROVAL_SCOPE_INVALID', { scope });
      if (recipeId !== null && (typeof recipeId !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(recipeId))) {
        throw code(`批准目标配方不合法：${String(recipeId)}`, 'AUTOMATION_APPROVAL_RECIPE_INVALID');
      }
      const issued = service.issue({ scope, bindings: { recipeId, fingerprint, planHash }, ttlMs, note });
      return {
        approvalId: issued.approvalId,
        scope: issued.scope,
        recipeId,
        fingerprint,
        planHash,
        issuedAt: isoOf(issued.issuedAt),
        expiresAt: isoOf(issued.expiresAt),
      };
    },
    /** 列出仍可用的批准（不含已用/已过期）。 */
    list() {
      return service.list().map((item) => ({
        approvalId: item.approvalId,
        scope: item.scope,
        recipeId: item.bindings.recipeId ?? null,
        fingerprint: item.bindings.fingerprint ?? null,
        issuedAt: isoOf(item.issuedAt),
        expiresAt: isoOf(item.expiresAt),
      }));
    },
    /**
     * 校验并消费批准：requiredScopes 全部满足才一次性标记使用（原子：先全查再全消费）。
     * fingerprint 传入当前指纹时，批准里的指纹必须一致；否则视为"批的不是这块板"。
     */
    resolve({ approvalIds = [], requiredScopes = [], recipeId = null, fingerprint = null } = {}) {
      const matched = service.resolve({
        approvalIds,
        requiredScopes,
        match: (item) => {
          const boundRecipe = item.bindings.recipeId ?? null;
          const boundFingerprint = item.bindings.fingerprint ?? null;
          if (boundRecipe !== null && recipeId !== null && boundRecipe !== recipeId) return false;
          if (boundFingerprint !== null && fingerprint !== null && boundFingerprint !== fingerprint) return false;
          return true;
        },
      });
      if (!matched.ok) return { ok: false, missing: matched.missing, approvals: {}, used: [] };
      return {
        ok: true,
        missing: [],
        approvals: matched.approvals,
        used: matched.used.map((item) => ({
          approvalId: item.approvalId,
          scope: item.scope,
          recipeId: item.bindings.recipeId ?? null,
          fingerprint: item.bindings.fingerprint ?? null,
          usedAt: isoOf(item.usedAt),
        })),
      };
    },
  };
}
