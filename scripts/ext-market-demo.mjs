#!/usr/bin/env node
/**
 * 扩展能力注册 agent 的离线演示（只读）。
 *
 * 用法：
 *   node scripts/ext-market-demo.mjs --tags "彩色丝印,绕组,电源打孔,规则生成" --budget 900
 *   node scripts/ext-market-demo.mjs --market            # 额外尝试公开市场 API（匿名 GET，失败自动降级）
 *
 * 默认数据源：artifacts/ext-market/installed-extensions.json
 *   —— 由只读提取器 artifacts/ext-market/probe/extract-registry-v1.mjs 从 Electron IndexedDB 快照得到。
 *   ⚠️ 该快照 v1 未按 LevelDB sequence 合并，可能含历史记录；本演示只用于验证“能力公告板”链路，
 *      不代表最终可信的“当前已装集合”。这一点会写进输出。
 *
 * 输出：artifacts/ext-market/capability-board.json + prompt-snippet.txt（默认输出到 stdout 摘要）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeAgent } from '../runtime/agents/agent-contract.mjs';
import { createExtensionRegistryAgent } from '../runtime/agents/extension-registry.mjs';
import { createInstalledSnapshotProvider } from '../runtime/extension-market/providers/installed-snapshot.mjs';
import { createMarketApiProvider } from '../runtime/extension-market/providers/market-api.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

const snapshotFile = arg('snapshot', join(root, 'artifacts/ext-market/installed-extensions.json'));
const tags = String(arg('tags', '彩色丝印,绕组,电源打孔,规则生成,AI 辅助')).split(',').map((tag) => tag.trim()).filter(Boolean);
const budgetTokens = Number(arg('budget', 900)) || 900;
const withMarket = process.argv.includes('--market');
const edaVersion = String(arg('eda', '3.2.186'));

const providers = [
  createInstalledSnapshotProvider({ file: snapshotFile }),
];
if (withMarket) providers.push(createMarketApiProvider({ enabled: true, pageSize: 100 }));

const registry = createExtensionRegistryAgent({ providers, edaVersion });
const result = await invokeAgent(registry.agent, { tags, budgetTokens, includeUnverified: true }, { timeoutMs: 45_000 });
if (!result.ok) {
  console.error(`[ext-market-demo] agent 失败：${result.code} ${result.message}`);
  console.error('提示：先运行只读提取器生成快照，或检查快照路径：', snapshotFile);
  process.exit(1);
}

const value = result.value;
const outDir = join(root, 'artifacts/ext-market');
mkdirSync(outDir, { recursive: true });
const boardFile = join(outDir, withMarket ? 'capability-board-with-market.json' : 'capability-board.json');
writeFileSync(boardFile, `${JSON.stringify(value.board, null, 2)}\n`);
writeFileSync(join(outDir, withMarket ? 'prompt-snippet-with-market.txt' : 'prompt-snippet.txt'), `${value.prompt.text}\n`);

console.log(`[ext-market-demo] provider: ${value.sources.map((source) => `${source.providerId}=${source.ok ? 'ok' : source.code}`).join(', ')}`);
console.log(`[ext-market-demo] 能力卡 ${value.inventory.total} 张；选中 ${value.board.counts.selected} 张；revision=${value.board.revision}`);
console.log(`[ext-market-demo] 预算 ${value.board.tokenBudget.used}/${value.board.tokenBudget.budget} tokens；提示词 ${value.prompt.items} 条${value.prompt.truncated ? '（已截断）' : ''}`);
console.log(`[ext-market-demo] 写入：${boardFile}`);
console.log('--- prompt 片段 ---');
console.log(value.prompt.text);
console.log('--- 排名前 8 ---');
for (const [index, card] of value.board.selected.slice(0, 8).entries()) {
  const versionLabel = card.version && !card.name.includes(String(card.version)) ? ` v${card.version}` : '';
  console.log(`${index + 1}. ${card.name}${versionLabel} [${card.status}] tags=${card.tags.join('/')} compat=${card.compat.status}${card.updateAvailable ? ' ↑有更新' : ''}`);
}
