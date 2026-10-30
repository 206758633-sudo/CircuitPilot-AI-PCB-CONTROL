#!/usr/bin/env node
/**
 * W3-15：K0 知识灌入（真实工程证据 → 知识库候选条目）。
 *
 * 来源（全部本地已记录证据，不联网、不读设计意图之外的东西）：
 *   - artifacts/wardrobe-case/bom/ai-bom-merged.json           → part 条目（两块板 BOM 器件身份）
 *   - artifacts/wardrobe-case/pcb-requirements.json            → module 条目（需求→验收映射）
 *   - artifacts/evidence/netlist-diff/*.json                   → failure 条目（真实网表缺陷）
 *   - artifacts/evidence/rules/*.json                          → rule 条目（真实 ERC/DRC 规则）
 *   - 通用缺陷目录（GND 空网/悬空/电源混网/网络缺失/引脚错接/封装不符/未解释 DRC/料号缺失/参考工程当输入）
 *
 * 输出：知识库根目录（默认 artifacts/knowledge），条目一律 candidate + provenance，交人工审核。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createKnowledgeStore } from '../runtime/knowledge.mjs';
import { healthMetrics } from '../runtime/knowledge-pipeline.mjs';

const root = process.argv[2] || 'artifacts/knowledge';
const store = createKnowledgeStore({ root });
const base = 'artifacts/wardrobe-case';
const evidenceRoot = 'artifacts/evidence';

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const latest = (kind) => {
  const dir = join(evidenceRoot, kind);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  if (!files.length) return null;
  return { path: join(dir, files.at(-1)), data: JSON.parse(readFileSync(join(dir, files.at(-1)), 'utf8')) };
};
const save = (entry) => { try { return store.save(entry); } catch (error) { return { error: error.message, code: error.code }; } };

const summary = { parts: 0, modules: 0, failures: 0, rules: 0, skipped: 0 };

// 1) 器件身份（两块板 BOM）
const bom = readJson(join(base, 'bom/ai-bom-merged.json'));
for (const item of bom?.items ?? []) {
  const lcscId = String(item.lcscId ?? '').trim();
  const mpn = String(item.mpn ?? '').trim();
  if (!lcscId && !mpn) { summary.skipped += 1; continue; }
  const saved = save({
    kind: 'part', title: mpn || lcscId,
    payload: { lcscId: lcscId || null, mpn: mpn || null, value: item.value ?? null, footprint: item.package || null, designators: item.refdes ? [item.refdes] : [], board: item.board ?? null },
    provenance: { source: 'engineering-bom', url: join(base, 'bom/ai-bom-merged.json'), version: bom?.generatedAt ?? null, fetchedAt: new Date().toISOString(), collector: 'seed-k0' },
    trust: 'reference', ttlDays: null, reviewState: 'candidate',
  });
  if (saved.error) summary.skipped += 1; else summary.parts += 1;
}

// 2) 需求 → 验收（module）
const requirements = readJson(join(base, 'pcb-requirements.json')) ?? readJson(join(base, 'requirements.json'));
for (const requirement of requirements?.requirements ?? []) {
  const saved = save({
    kind: 'module', title: `${requirement.id} ${String(requirement.requirement ?? '').slice(0, 40)}`,
    payload: { moduleId: requirement.id, category: requirement.category ?? null, priority: requirement.priority ?? null, requirement: requirement.requirement ?? null, acceptance: requirement.acceptance ?? null },
    provenance: { source: 'engineering-requirements', url: requirements.source ?? null, version: requirements.version ?? null, fetchedAt: new Date().toISOString(), collector: 'seed-k0' },
    trust: 'reference', ttlDays: null, reviewState: 'candidate',
  });
  if (saved.error) summary.skipped += 1; else summary.modules += 1;
}

// 3) 真实网表缺陷 → failure
const netlist = latest('netlist-diff');
for (const [index, finding] of (netlist?.data?.payload?.findings ?? []).entries()) {
  if (finding.severity !== 'error') continue;
  const saved = save({
    kind: 'failure', title: `${finding.code}：${String(finding.message ?? '').slice(0, 60)}`,
    payload: { failureId: `NETLIST-${finding.code}-${finding.net ?? index}`, code: finding.code, message: finding.message ?? null, net: finding.net ?? null, ref: finding.ref ?? null, pin: finding.pin ?? null, expectedNet: finding.expectedNet ?? null, actualNet: finding.actualNet ?? null },
    provenance: { source: 'evidence-netlist-diff', url: netlist.path, version: netlist.data.savedAt ?? null, fetchedAt: new Date().toISOString(), collector: 'seed-k0' },
    trust: 'reference', ttlDays: null, reviewState: 'candidate',
  });
  if (saved.error) summary.skipped += 1; else summary.failures += 1;
}

// 4) 真实规则发现 → rule（按 code 聚合）
const rules = latest('rules');
const byCode = new Map();
for (const finding of rules?.data?.payload?.findings ?? []) {
  const code = String(finding.code ?? 'UNKNOWN');
  const entry = byCode.get(code) ?? { code, occurrences: 0, severities: new Set() };
  entry.occurrences += 1; entry.severities.add(String(finding.severity ?? 'unknown'));
  byCode.set(code, entry);
}
for (const entry of byCode.values()) {
  const saved = save({
    kind: 'rule', title: `${entry.code}（真实证据 ${entry.occurrences} 次）`,
    payload: { ruleId: entry.code, occurrences: entry.occurrences, severities: [...entry.severities] },
    provenance: { source: 'evidence-rules', url: rules.path, version: rules.data.savedAt ?? null, fetchedAt: new Date().toISOString(), collector: 'seed-k0' },
    trust: 'reference', ttlDays: 180, reviewState: 'candidate',
  });
  if (saved.error) summary.skipped += 1; else summary.rules += 1;
}

// 5) 通用缺陷目录（跨板可复用，避免知识库只覆盖本板）
const catalog = [
  ['GND_EMPTY', '地网络没有任何引脚：整板没有参考地', '网络表中 GND 为空 → 检查地符号/网络名/布线'],
  ['PIN_FLOATING', '意图要求连接的引脚实际悬空', '逐 pin diff 发现 net 为空 → 补连接或确认 NC'],
  ['POWER_MIXED', '电源网络混接（如 +3V3 引脚接到 GND）', '电源网络短路风险 → 检查网络名与引脚映射'],
  ['NET_MISSING', '意图中的网络在实际网表缺失', '网络未创建或未命名 → 建网并布线'],
  ['PIN_MISMATCH', '引脚接到错误网络', '引脚映射错误 → 对照 datasheet/封装修正'],
  ['ERC_PIN_PAD_MISMATCH', '元件引脚与焊盘未对应', '封装/符号引脚数不一致 → 换正确封装或修符号'],
  ['DRC_UNEXPLAINED', 'DRC 违规未处理（未修复也未登记豁免）', '必须修复或带理由豁免，禁止静默忽略'],
  ['BOM_IDENTITY_MISSING', 'BOM 器件缺料号/封装，无法采购与核验', '补 LCSC 料号/MPN/封装，交 Librarian 核验'],
  ['LIB_FOOTPRINT_MISMATCH', '符号/封装/3D 引脚不一致', '三源核验（EDA 库/供应商/datasheet）'],
  ['REFERENCE_AS_DESIGN_INPUT', '把参考工程当设计输入照抄', '参考工程只作验收基准，不得进入生成路径'],
];
for (const [code, symptom, rootCause] of catalog) {
  const saved = save({
    kind: 'failure', title: `失败模式：${code}`,
    payload: { failureId: `CATALOG-${code}`, code, symptom, rootCause, expectedCodes: [code] },
    provenance: { source: 'failure-catalog', url: null, version: '1.0.0', fetchedAt: new Date().toISOString(), collector: 'seed-k0' },
    trust: 'reference', ttlDays: null, reviewState: 'candidate',
  });
  if (saved.error) summary.skipped += 1; else summary.failures += 1;
}

const metrics = healthMetrics({ store });
console.log(JSON.stringify({ root, summary, metrics }, null, 2));
const rulesPlusFailures = summary.failures + summary.rules;
if (rulesPlusFailures < 10) { console.error(`K0 未达标：失败/规则条目 ${rulesPlusFailures} < 10`); process.exit(1); }
