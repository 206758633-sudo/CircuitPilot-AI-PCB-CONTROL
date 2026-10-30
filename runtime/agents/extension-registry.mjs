import { defineAgent } from './agent-contract.mjs';
import { dedupeInstalled, normalizeInstalledRecord, buildCapabilityBoard, computeRevision } from '../extension-market/capability-board.mjs';
import { deriveTags } from '../extension-market/tags.mjs';
import { marketItemToCapability } from '../extension-market/providers/market-api.mjs';

/**
 * 扩展能力注册 Agent（v0，只读）。
 *
 * 定位：**registrar / 只读层**，不是“带写权限的 manager”。
 *   - agent-contract 强制 readOnly=true（`agent-contract.mjs:23`），本模块不碰 EDA、不装扩展、不写设计；
 *   - 职责：跑 provider → 归一化能力卡 → 打分/裁剪 → 产出能力公告板与 prompt 片段；
 *   - 写动作（安装/升级/回滚）不在本模块：见 docs/design/extension-market/integration.md §5，
 *     必须走一次性人工审批 + 隔离工程 + 回滚，且首版恒 501。
 *
 * 失败语义：单个 provider 挂掉只 degraded，不让“本机已装清单”跟着消失；
 * 全部 provider 失败时返回 ok:false + 结构化原因，**绝不返回空清单冒充“没有扩展”**。
 */
export const EXTENSION_REGISTRY_VERSION = '0.1.0';
export const EXTENSION_REGISTRY_CODES = Object.freeze({
  NO_PROVIDER: 'EXT_NO_PROVIDER',
  ALL_SOURCES_FAILED: 'EXT_ALL_SOURCES_FAILED',
  SOURCE_TIMEOUT: 'EXT_SOURCE_TIMEOUT',
});

const coded = (code, message) => Object.assign(new Error(message), { code });

/** 给单个 provider 加超时；超时只影响该源，不影响整体。 */
async function runProvider(provider, { timeoutMs, now }) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : provider?.timeoutMs ?? 5_000;
  const startedAt = Date.now();
  let timer = null;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => provider.run({ now })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(coded(EXTENSION_REGISTRY_CODES.SOURCE_TIMEOUT, `provider ${provider?.id ?? 'unknown'} 超时（>${limit}ms）`)), limit);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    const items = Array.isArray(value?.items) ? value.items : null;
    if (!items) throw coded('EXT_SOURCE_PARSE_FAILED', 'provider 未返回 items 数组');
    return { ok: true, providerId: provider.id ?? 'unknown', kind: provider.kind ?? 'unknown', source: provider.source ?? null, items, degraded: value.degraded ?? null, meta: value.meta ?? null, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, providerId: provider?.id ?? 'unknown', kind: provider?.kind ?? 'unknown', source: provider?.source ?? null, code: error?.code ?? 'EXT_SOURCE_UNAVAILABLE', message: String(error?.message || error).slice(0, 240), elapsedMs: Date.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 把 provider 结果归一化成能力卡；已装与市场按 uuid 合并（已装优先，市场补最新版本号）。 */
export function mergeCapabilities({ installed = [], market = [], now = () => new Date(), edaVersion = null } = {}) {
  const installedCards = dedupeInstalled(installed).map((record) => normalizeInstalledRecord(record, { now, edaVersion }));
  const installedByUuid = new Map(installedCards.filter((card) => card.uuid).map((card) => [card.uuid, card]));
  const marketCards = (Array.isArray(market) ? market : []).map((item) => {
    const card = marketItemToCapability(item, { now, edaVersion });
    card.tags = deriveTags({ name: card.name, extensionId: card.extensionId, summary: card.summary });
    const installedCard = card.uuid ? installedByUuid.get(card.uuid) : null;
    if (installedCard) {
      // 已装版本才是“这台机器现在能用的版本”；市场版本只用于提示“有更新”。
      return {
        ...installedCard,
        market: { ...(card.market ?? {}), latestVersion: card.version ?? null, updatedAt: card.lastVerifiedAt ?? null },
        updateAvailable: card.version && installedCard.version ? String(card.version) !== String(installedCard.version) : null,
      };
    }
    return card;
  });
  const marketByUuid = new Map(marketCards.filter((card) => card.uuid).map((card) => [card.uuid, card]));
  const merged = [];
  for (const card of installedCards) merged.push(marketByUuid.get(card.uuid) ?? card);
  for (const card of marketCards) if (!card.uuid || !installedByUuid.has(card.uuid)) merged.push(card);
  return merged;
}

/**
 * 创建注册 agent 与可复用的 collect/board 方法。
 *
 * @param {object} options
 * @param {Array} options.providers  provider 列表（见 runtime/extension-market/providers/*.mjs）
 * @param {string|null} options.edaVersion 当前 EDA 版本（用于 engines.eda 兼容性判定；null=unknown）
 */
export function createExtensionRegistryAgent({ providers = [], edaVersion = null, now = () => new Date() } = {}) {
  if (!Array.isArray(providers) || providers.length === 0) throw coded(EXTENSION_REGISTRY_CODES.NO_PROVIDER, '扩展注册 agent 至少需要一个只读 provider');

  async function collect({ tags = [], budgetTokens = 900, includeUnverified = false } = {}) {
    const results = await Promise.all(providers.map((provider) => runProvider(provider, { timeoutMs: provider?.timeoutMs ?? 8_000, now })));
    const installed = results.filter((result) => result.ok && result.kind === 'local-fs').flatMap((result) => result.items);
    const market = results.filter((result) => result.ok && result.kind === 'market-api').flatMap((result) => result.items);
    const capabilities = mergeCapabilities({ installed, market, now, edaVersion });
    const board = buildCapabilityBoard(capabilities, { tags, budgetTokens, includeUnverified, now });
    board.revision = computeRevision(capabilities);
    const okCount = results.filter((result) => result.ok).length;
    return {
      ok: okCount > 0,
      generatedAt: (typeof now === 'function' ? now() : now instanceof Date ? now : new Date()).toISOString(),
      edaVersion,
      sources: results.map(({ items, ...rest }) => ({ ...rest, itemCount: items?.length ?? 0 })),
      inventory: {
        total: capabilities.length,
        installed: capabilities.filter((card) => card.provenance?.source === 'local-snapshot' || card.market?.latestVersion !== undefined).length,
        marketOnly: capabilities.filter((card) => card.provenance?.source === 'market-api').length,
        updateAvailable: capabilities.filter((card) => card.updateAvailable === true).length,
        incompatible: capabilities.filter((card) => card.status === 'incompatible').length,
        unverified: capabilities.filter((card) => card.status === 'unverified').length,
        degraded: results.filter((result) => !result.ok || result.degraded).map((result) => ({ providerId: result.providerId, code: result.code ?? result.degraded ?? null })),
      },
      capabilities,
      board,
      prompt: board.prompt,
    };
  }

  const agent = defineAgent({
    id: 'extension-registry',
    version: EXTENSION_REGISTRY_VERSION,
    readOnly: true,
    timeoutMs: 30_000,
    run: async ({ tags = [], budgetTokens = 900, includeUnverified = false } = {}) => {
      const value = await collect({ tags, budgetTokens, includeUnverified });
      // fail-closed：所有源都不可用时必须显式失败，不能返回空清单让上层以为“没有扩展”。
      if (!value.ok) throw coded(EXTENSION_REGISTRY_CODES.ALL_SOURCES_FAILED, `扩展数据源全部不可用：${value.sources.map((source) => `${source.providerId}=${source.code}`).join(', ')}`);
      return value;
    },
  });

  return { agent, collect, providers };
}
