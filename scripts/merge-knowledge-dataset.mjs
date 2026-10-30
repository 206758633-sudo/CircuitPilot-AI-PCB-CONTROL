#!/usr/bin/env node
/**
 * 合并 teammates 产出的数据集 fragment（knowledge/pcb/dataset/fragments/*.json）到四类核心数据集。
 *
 * 规则：
 *  - fragment 顶层 {"entries":[...]}，每条必须有 kind/title/doc/payload；
 *  - 与现有 entityKey 重复的条目不合并（打印冲突，人工决定改 ID 或弃用）；
 *  - 先全量校验（validateDataset），通过后才写文件；失败不落盘；
 *  - 合并成功后把 fragment 移到 fragments/_merged/ 归档，避免重复合并。
 *
 * 用法：node scripts/merge-knowledge-dataset.mjs [--check] [--keep-fragments]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASET_DIR, validateDataset } from './seed-knowledge-pcb.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRAG_DIR = join(ROOT, 'knowledge/pcb/dataset/fragments');
const KINDS = ['rule', 'module', 'part', 'failure'];
const CORE = {
  rule: 'rules.json',
  module: 'modules.json',
  part: 'parts.json',
  failure: 'failures.json',
};

const entityKeyOf = (entry) => {
  const p = entry?.payload ?? {};
  if (entry.kind === 'part') return p.lcscId || p.mpn || p.url || null;
  if (entry.kind === 'module') return p.moduleId || null;
  if (entry.kind === 'rule') return p.ruleId || null;
  if (entry.kind === 'failure') return p.failureId || null;
  return null;
};

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const check = process.argv.includes('--check');
const keepFragments = process.argv.includes('--keep-fragments');

if (!existsSync(FRAG_DIR)) {
  console.log(JSON.stringify({ ok: true, merged: 0, note: 'fragments 目录不存在，无需合并' }));
  process.exit(0);
}

const fragments = readdirSync(FRAG_DIR).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
const mergedEntries = [];
const sources = [];
for (const name of fragments) {
  const file = join(FRAG_DIR, name);
  const data = readJson(file);
  const list = Array.isArray(data?.entries) ? data.entries : [];
  if (!list.length) throw new Error(`fragment 为空：${name}`);
  for (const entry of list) mergedEntries.push({ ...entry, __fragment: name });
  sources.push({ file: name, count: list.length });
}

const core = {};
for (const kind of KINDS) {
  const file = join(DATASET_DIR, CORE[kind]);
  core[kind] = readJson(file);
}
const existingKeys = new Set();
for (const kind of KINDS) {
  for (const entry of core[kind].entries) existingKeys.add(`${kind}\u0000${entityKeyOf(entry)}`);
}

const accepted = [];
const duplicates = [];
const invalid = [];
for (const entry of mergedEntries) {
  if (!KINDS.includes(entry.kind)) { invalid.push({ title: entry.title, reason: `未知 kind ${entry.kind}` }); continue; }
  const key = entityKeyOf(entry);
  if (!key) { invalid.push({ title: entry.title, reason: '缺 entityKey' }); continue; }
  const composite = `${entry.kind}\u0000${key}`;
  if (existingKeys.has(composite)) { duplicates.push({ kind: entry.kind, key, title: entry.title, source: entry.__fragment }); continue; }
  existingKeys.add(composite);
  accepted.push(entry);
}

const next = {};
for (const kind of KINDS) {
  next[kind] = {
    ...core[kind],
    version: '1.3.0',
    generatedAt: new Date().toISOString(),
    entries: [...core[kind].entries, ...accepted.filter((e) => e.kind === kind).map(({ __fragment, ...rest }) => rest)],
  };
}
const all = KINDS.flatMap((kind) => next[kind].entries.map((entry) => ({ ...entry, kind })));
const problems = invalid.length
  ? invalid.map((item) => ({ code: 'FRAGMENT_INVALID', label: item.title, message: item.reason }))
  : validateDataset(all);

const report = {
  ok: problems.length === 0,
  check,
  fragments: sources,
  accepted: accepted.length,
  byKind: Object.fromEntries(KINDS.map((kind) => [kind, accepted.filter((e) => e.kind === kind).length])),
  duplicates,
  invalid,
  problems,
  before: Object.fromEntries(KINDS.map((kind) => [kind, core[kind].entries.length])),
  after: Object.fromEntries(KINDS.map((kind) => [kind, next[kind].entries.length])),
};

if (problems.length) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
if (!check) {
  for (const kind of KINDS) writeFileSync(join(DATASET_DIR, CORE[kind]), `${JSON.stringify(next[kind], null, 2)}\n`);
  if (!keepFragments) {
    const done = join(FRAG_DIR, '_merged', new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(done, { recursive: true });
    for (const name of fragments) renameSync(join(FRAG_DIR, name), join(done, name));
    report.archivedTo = done;
  }
}
console.log(JSON.stringify(report, null, 2));
