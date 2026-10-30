import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCapabilityBoard,
  buildPromptSnippet,
  compareVersions,
  computeRevision,
  dedupeInstalled,
  estimateTokens,
  evaluateCompat,
  normalizeInstalledRecord,
  parseVersion,
  renderCard,
  selectCapabilities,
} from '../extension-market/capability-board.mjs';
import { deriveTags } from '../extension-market/tags.mjs';
import { createInstalledSnapshotProvider } from '../extension-market/providers/installed-snapshot.mjs';
import { createMarketApiProvider } from '../extension-market/providers/market-api.mjs';
import { createExtensionRegistryAgent, mergeCapabilities } from '../agents/extension-registry.mjs';
import { invokeAgent } from '../agents/agent-contract.mjs';

const NOW = () => new Date('2026-10-23T08:00:00.000Z');

function installedRecord(overrides = {}) {
  return {
    uuid: 'a'.repeat(32),
    id: 'demo-extension',
    displayName: '示例扩展',
    version: '1.2.3',
    publisher: 'demo-publisher',
    engines: { eda: '^3.2.0' },
    installationTimeISO: '2026-10-23T07:00:00.000Z',
    ...overrides,
  };
}

function capability(overrides = {}) {
  return normalizeInstalledRecord(installedRecord(overrides), { now: NOW, edaVersion: '3.2.186' });
}

test('parseVersion：合法 semver 解析、非法版本保留原文且不与其它版本比较', () => {
  assert.deepEqual(parseVersion('1.2.3'), { version: '1.2.3', versionParsed: true, major: 1, minor: 2, patch: 3 });
  assert.equal(parseVersion('1.2').versionParsed, false);
  assert.equal(parseVersion('').versionParsed, false);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('3.2.186', '3.2.186'), 0);
  assert.equal(compareVersions('10.0.0', '9.9.9'), 1);
  assert.equal(compareVersions('abc', '1.0.0'), 0, '不可比版本不能假装能比');
});

test('evaluateCompat：^ / ~ / >= / 区间 / 未知写法', () => {
  assert.equal(evaluateCompat('^3.2.0', '3.2.186').status, 'tested');
  assert.equal(evaluateCompat('~3.2.0', '3.2.186').status, 'tested');
  assert.equal(evaluateCompat('>=3.0.0', '3.2.186').status, 'tested');
  assert.equal(evaluateCompat('>=3.2.170 <3.3.0', '3.2.186').status, 'tested');
  assert.equal(evaluateCompat('>=3.3.0', '3.2.186').status, 'untested');
  assert.equal(evaluateCompat('^2.0.0', '3.2.186').status, 'untested');
  assert.equal(evaluateCompat('', '3.2.186').status, 'unknown');
  assert.equal(evaluateCompat('^3.2.0', null).status, 'unknown');
  assert.equal(evaluateCompat('workspace:*', '3.2.186').status, 'unknown', '不认识的 range 不能猜');
});

test('deriveTags：按名称/关键词推导，输出顺序稳定且不重复', () => {
  assert.deepEqual(deriveTags({ name: 'PCBTrans CSV 绕组导入' }), ['绕组', '格式转换']);
  assert.deepEqual(deriveTags({ name: '电源地就近打孔' }), ['电源打孔']);
  assert.deepEqual(deriveTags({ name: '设计规则生成器' }), ['规则生成']);
  assert.deepEqual(deriveTags({ name: '未知插件' }), []);
  const once = deriveTags({ name: 'AI 彩色丝印生成器' });
  const twice = deriveTags({ name: 'AI 彩色丝印生成器' });
  assert.deepEqual(once, twice);
  assert.ok(once.includes('AI 辅助') && once.includes('彩色丝印'));
});

test('normalizeInstalledRecord：config 嵌套与扁平记录都接受，未知字段不臆造', () => {
  const nested = normalizeInstalledRecord({
    uuid: 'b'.repeat(32),
    config: { name: 'nested-ext', displayName: '嵌套扩展', version: '2.0.0', engines: { eda: '^3.2.0' }, keywords: ['BOM'] },
    installationTimeISO: '2026-10-22T00:00:00.000Z',
  }, { now: NOW, edaVersion: '3.2.186' });
  assert.equal(nested.extensionId, 'nested-ext');
  assert.equal(nested.version, '2.0.0');
  assert.equal(nested.status, 'probed');
  assert.equal(nested.sideEffects, 'unknown');
  assert.equal(nested.trust, 'unverified');
  assert.equal(nested.uuid, 'b'.repeat(32));

  const unknown = normalizeInstalledRecord({ uuid: 'c'.repeat(32), displayName: '无版本扩展' }, { now: NOW, edaVersion: null });
  assert.equal(unknown.version, null);
  assert.equal(unknown.versionParsed, false);
  assert.equal(unknown.compat.status, 'unknown');
  assert.equal(unknown.status, 'unverified');
});

test('dedupeInstalled：同一 uuid 取 installationTime 最新的一条，无 uuid 的记录保留', () => {
  const deduped = dedupeInstalled([
    installedRecord({ uuid: 'd'.repeat(32), version: '1.0.0', installationTimeISO: '2026-10-01T00:00:00.000Z' }),
    installedRecord({ uuid: 'd'.repeat(32), version: '1.1.0', installationTimeISO: '2026-10-20T00:00:00.000Z' }),
    installedRecord({ uuid: '', id: 'anonymous' }),
  ]);
  assert.equal(deduped.length, 2);
  const kept = deduped.find((record) => record.uuid === 'd'.repeat(32));
  assert.equal(kept.version, '1.1.0');
});

test('mergeCapabilities：已装版本优先，市场版本只标记“有更新”', () => {
  const uuid = 'e'.repeat(32);
  const merged = mergeCapabilities({
    installed: [installedRecord({ uuid, version: '1.0.0' })],
    market: [{ uuid, name: 'demo-extension', display_name: '示例扩展', version: '1.4.0', publisher: 'demo-publisher', file_path: 'https://image.lceda.cn/extensions/files/x.eext' }],
    now: NOW,
    edaVersion: '3.2.186',
  });
  const card = merged.find((item) => item.uuid === uuid);
  assert.ok(card, '合并后必须保留该扩展');
  assert.equal(card.version, '1.0.0', '机器上能用的版本是已装版本');
  assert.equal(card.market.latestVersion, '1.4.0');
  assert.equal(card.updateAvailable, true);
  assert.equal(card.provenance.source, 'local-snapshot');
});

test('selectCapabilities：硬过滤、标签匹配、确定性排序', () => {
  const cards = [
    capability({ uuid: 'f'.repeat(32), id: 'a', displayName: '绕组扩展', version: '1.0.0' }),
    capability({ uuid: '1'.repeat(32), id: 'b', displayName: '打孔扩展', version: '1.0.0' }),
    capability({ uuid: '2'.repeat(32), id: 'c', displayName: '不兼容扩展', version: '1.0.0', engines: { eda: '^2.0.0' } }),
    capability({ uuid: '3'.repeat(32), id: 'd', displayName: '未知版本扩展', version: '1.0.0', engines: {} }),
  ];
  const once = selectCapabilities(cards, { tags: ['绕组'], includeUnverified: true, now: NOW, budgetTokens: 900 });
  const twice = selectCapabilities(cards, { tags: ['绕组'], includeUnverified: true, now: NOW, budgetTokens: 900 });
  assert.deepEqual(once.selected.map((card) => card.extensionId), twice.selected.map((card) => card.extensionId), '同一输入必须同序');
  assert.equal(once.selected[0].extensionId, 'a');
  const allIds = once.selected.map((card) => card.extensionId);
  assert.ok(!allIds.includes('c'), '不兼容扩展必须被硬过滤');
  const reasons = new Map(once.dropped.map((entry) => [entry.extensionId, entry.reason]));
  assert.equal(reasons.get('c'), 'STATUS_INCOMPATIBLE');
});

test('selectCapabilities：token 预算触发降档与丢弃，但绝不超过预算', () => {
  const cards = Array.from({ length: 30 }, (_, index) => capability({
    uuid: String(index).padStart(32, '0'),
    id: `ext-${index}`,
    displayName: `扩展 ${index}`,
    version: '1.0.0',
    description: '这是一个用于测试 token 预算裁剪的扩展，简介故意写得比较长，以便触发降档与丢弃逻辑。'.repeat(2),
  }));
  const result = selectCapabilities(cards, { tags: [], includeUnverified: true, now: NOW, budgetTokens: 260 });
  assert.ok(result.selected.length > 0);
  assert.ok(result.selected.length < cards.length, '预算不足时必须丢弃');
  assert.ok(result.tokenBudget.used <= 260, `used=${result.tokenBudget.used} 不应超过预算`);
  assert.ok(result.selected.some((card) => card.detail !== 'full'), '预算不足时至少有一项降档');
  assert.ok(result.dropped.some((entry) => entry.reason === 'BUDGET'));
});

test('buildPromptSnippet：带免责句、无 uuid/URL、可截断', () => {
  const board = buildCapabilityBoard([capability()], { tags: [], includeUnverified: true, now: NOW });
  const text = buildPromptSnippet(board).text;
  assert.match(text, /不代表已调用/);
  assert.match(text, /不得声称已经调用/);
  assert.doesNotMatch(text, /[0-9a-f]{32}/, 'prompt 片段不能泄露 uuid');
  assert.doesNotMatch(text, /https?:\/\//, 'prompt 片段不能带下载 URL');
  const multiple = buildCapabilityBoard(Array.from({ length: 8 }, (_, index) => capability({
    uuid: String(index + 10).padStart(32, '0'),
    id: `many-${index}`,
    displayName: `扩展 ${index}`,
    description: '用于触发提示词预算裁剪的较长简介。'.repeat(4),
  })), { tags: [], includeUnverified: true, now: NOW });
  const truncated = buildPromptSnippet(multiple, { maxChars: 220 });
  assert.ok(truncated.text.length <= 260);
  assert.ok(truncated.items < multiple.selected.length);
});

test('computeRevision：同内容稳定，版本变化必变', () => {
  const base = [capability({ uuid: '9'.repeat(32), id: 'stable', version: '1.0.0' })];
  assert.equal(computeRevision(base), computeRevision([capability({ uuid: '9'.repeat(32), id: 'stable', version: '1.0.0' })]));
  assert.notEqual(computeRevision(base), computeRevision([capability({ uuid: '9'.repeat(32), id: 'stable', version: '1.0.1' })]));
});

test('renderCard：名称自带版本时不重复拼接', () => {
  const card = capability({ displayName: '原理图PCBAI-Agent v0.22.9', version: '0.22.9' });
  assert.equal(renderCard(card, 'id-only'), '原理图PCBAI-Agent v0.22.9');
});

test('installed-snapshot provider：文件缺失/损坏必须显式失败，不能返回空清单', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ext-snapshot-'));
  const missing = createInstalledSnapshotProvider({ file: join(dir, 'missing.json') });
  await assert.rejects(() => missing.run(), (error) => error.code === 'EXT_SOURCE_UNAVAILABLE');

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, 'not json');
  await assert.rejects(() => createInstalledSnapshotProvider({ file: bad }).run(), (error) => error.code === 'EXT_SOURCE_PARSE_FAILED');

  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ probedAt: 'x', recordCount: 2, sourceDir: '/tmp', extensions: [installedRecord()] }));
  const result = await createInstalledSnapshotProvider({ file: good }).run();
  assert.equal(result.items.length, 1);
  assert.equal(result.degraded, 'SNAPSHOT_MAY_CONTAIN_HISTORY');
});

test('market-api provider：匿名 GET 解析、HTTP 错误、策略关闭', async () => {
  let seenUrl = null;
  const provider = createMarketApiProvider({
    enabled: true,
    pageSize: 100,
    fetchImpl: async (url) => {
      seenUrl = String(url);
      return { ok: true, status: 200, async json() { return { success: true, code: 0, result: { total: 1, page: 1, pageSize: 100, lists: [{ uuid: '7'.repeat(32), name: 'market-ext', display_name: '市场扩展', version: '2.0.0', publisher: 'pub' }] } }; } };
    },
  });
  const result = await provider.run();
  assert.ok(seenUrl.includes('/api/extensions/editor/search'));
  assert.ok(seenUrl.includes('pageSize=100'));
  assert.equal(result.items.length, 1);
  assert.equal(result.meta.total, 1);

  const httpError = createMarketApiProvider({ fetchImpl: async () => ({ ok: false, status: 429, async json() { return {}; } }) });
  await assert.rejects(() => httpError.run(), (error) => error.code === 'EXT_SOURCE_HTTP_ERROR');

  const disabled = createMarketApiProvider({ enabled: false });
  await assert.rejects(() => disabled.run(), (error) => error.code === 'EXT_MARKET_DISABLED');
});

test('extension-registry agent：单源失败被隔离，全部失败则 fail-closed', async () => {
  const inflated = {
    id: 'ok-source', kind: 'local-fs', source: 'test', readOnly: true, timeoutMs: 1_000,
    async run() { return { items: [installedRecord()], degraded: null }; },
  };
  const broken = {
    id: 'broken-source', kind: 'market-api', source: 'test', readOnly: true, timeoutMs: 1_000,
    async run() { throw Object.assign(new Error('offline'), { code: 'EXT_SOURCE_UNAVAILABLE' }); },
  };
  const registry = createExtensionRegistryAgent({ providers: [inflated, broken], edaVersion: '3.2.186', now: NOW });
  const result = await invokeAgent(registry.agent, { tags: ['绕组'], includeUnverified: true });
  assert.equal(result.ok, true);
  assert.equal(result.value.sources.find((source) => source.providerId === 'broken-source').ok, false);
  assert.ok(result.value.inventory.total >= 1);
  assert.equal(result.agent, 'extension-registry');

  const allBroken = createExtensionRegistryAgent({ providers: [broken], now: NOW });
  const failed = await invokeAgent(allBroken.agent, {});
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'EXT_ALL_SOURCES_FAILED');
});

test('extension-registry：agent-contract 只读约束不可协商', () => {
  const registry = createExtensionRegistryAgent({ providers: [{ id: 'p', kind: 'local-fs', readOnly: true, run: async () => ({ items: [] }) }] });
  assert.equal(registry.agent.readOnly, true);
  assert.equal(registry.agent.id, 'extension-registry');
  assert.equal(registry.agent.timeoutMs, 30_000);
  assert.equal(estimateTokens('abcd'), 2);
});
