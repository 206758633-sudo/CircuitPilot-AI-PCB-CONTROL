#!/usr/bin/env node
/**
 * 把"已人工批准 + 已验证"的知识规则晋升进已验证设计规则包。
 *
 * 用法：
 *   node scripts/promote-schematic-rules.mjs --check \
 *     --state-dir "$HOME/Library/Application Support/com.circuitpilot.desktop/state"
 *   node scripts/promote-schematic-rules.mjs --write --confirm \
 *     --state-dir ".../state" --pack runtime/design-rules/schematic-design-rules.json
 *
 * 没有 --write --confirm 只做检查，不修改任何文件；候选知识永远不会自动晋升。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadSchematicRulePack, validateSchematicRulePack } from '../runtime/design-rules/verified-rules.mjs';
import { promoteVerifiedKnowledgeRules } from '../runtime/design-rules/rule-promotion.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const defaultStateDir = join(homedir(), 'Library/Application Support/com.circuitpilot.desktop/state');
const stateDir = resolve(valueOf('--state-dir', process.env.CIRCUITPILOT_STATE_DIR || defaultStateDir));
const packPath = resolve(valueOf('--pack', 'runtime/design-rules/schematic-design-rules.json'));
const write = flag('--write');
const confirmed = flag('--confirm');

if (!existsSync(stateDir)) {
  console.error(`[promote] state dir 不存在：${stateDir}`);
  process.exit(2);
}
if (write && !confirmed) {
  console.error('[promote] --write 必须同时给 --confirm（人工确认后才能改规则包）');
  process.exit(2);
}

const entries = [];
const ruleDir = join(stateDir, 'knowledge', 'rule');
if (existsSync(ruleDir)) {
  for (const file of readdirSync(ruleDir)) {
    if (!file.endsWith('.json')) continue;
    try { entries.push(JSON.parse(readFileSync(join(ruleDir, file), 'utf8'))); } catch { /* 单条损坏不影响其它候选 */ }
  }
}

const pack = loadSchematicRulePack({ readFile: (url) => readFileSync(packPath, 'utf8') });
const result = promoteVerifiedKnowledgeRules({ entries, pack });
console.log(JSON.stringify({
  stateDir,
  packPath,
  entries: entries.length,
  promotable: result.promoted.length,
  promoted: result.promoted,
  rejected: result.rejected.slice(0, 20),
  rejectedCount: result.rejected.length,
  ok: result.ok,
  errors: result.errors ?? null,
  wrote: false,
}, null, 2));

if (!result.ok) process.exit(1);
if (!write) process.exit(0);
const validation = validateSchematicRulePack(result.pack);
if (!validation.ok) { console.error('[promote] 结果包非法，拒绝写入', validation.errors); process.exit(1); }
const temp = `${packPath}.tmp-${process.pid}`;
writeFileSync(temp, `${JSON.stringify(result.pack, null, 2)}\n`, 'utf8');
renameSync(temp, packPath);
console.log(`[promote] 已写入 ${packPath}（promoted=${result.promoted.length}）`);
