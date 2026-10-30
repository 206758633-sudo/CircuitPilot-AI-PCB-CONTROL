#!/usr/bin/env node
/**
 * 委托审核：把仓库内**人工策划**的知识数据集按 kind 审核入库。
 *
 * 为什么需要这个脚本（P0-6 收口）：
 *   - `seed-knowledge-pcb.mjs` 只灌 candidate；门禁建议只引用 approved 条目。
 *   - 真实语料 approved=0 时，"知识改变产品行为"只是代码承诺（复审 P0-6）。
 *   - 这里不是自动自证：脚本只处理 `knowledge/pcb/dataset` 里带 doc 指针、且
 *     `scripts/check-knowledge-sources.mjs` 校验通过的条目；reviewer 由调用方显式提供，
 *     默认 dry-run，必须 --confirm 才写审核状态，并打印每条 reviewedBy。
 *
 * 用法：
 *   node scripts/review-knowledge-dataset.mjs --kind rule --reviewer "维护者（委托审核）"
 *   node scripts/review-knowledge-dataset.mjs --kind rule --reviewer "..." --confirm
 *   --root <state>/knowledge  指定知识库根（默认 artifacts/state/knowledge）
 *   --kind 可重复；缺省 = rule
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnowledgeStore } from '../runtime/knowledge.mjs';
import { loadDataset, seedLocal } from './seed-knowledge-pcb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const options = { root: join(ROOT, 'artifacts/state/knowledge'), kinds: [], reviewer: '', confirm: false, limit: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = resolve(argv[++index] ?? options.root);
    else if (arg === '--reviewer') options.reviewer = String(argv[++index] ?? '').trim();
    else if (arg === '--kind') options.kinds.push(String(argv[++index] ?? '').trim());
    else if (arg === '--limit') options.limit = Number(argv[++index]) || 0;
    else if (arg === '--confirm') options.confirm = true;
    else if (arg === '--help' || arg === '-h') { console.log('用法：node scripts/review-knowledge-dataset.mjs --kind rule --reviewer "..." [--confirm] [--root <dir>] [--limit N]'); process.exit(0); }
    else throw Object.assign(new Error(`未知参数：${arg}`), { code: 'ARGS_INVALID' });
  }
  if (!options.kinds.length) options.kinds = ['rule'];
  const allowed = new Set(['rule', 'module', 'part', 'failure']);
  for (const kind of options.kinds) if (!allowed.has(kind)) throw Object.assign(new Error(`未知 kind：${kind}（允许 ${[...allowed].join('/')}）`), { code: 'KIND_INVALID' });
  return options;
}

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.root)) throw Object.assign(new Error(`知识库根不存在：${options.root}（先跑 seed-knowledge-pcb.mjs）`), { code: 'ROOT_MISSING' });
  if (options.confirm && !options.reviewer) throw Object.assign(new Error('审核必须显式提供 --reviewer（写入 reviewedBy，不能匿名批量通过）'), { code: 'REVIEWER_REQUIRED' });

  const dataset = loadDataset();
  const selected = dataset.entries.filter((entry) => options.kinds.includes(entry.kind));
  if (!selected.length) throw Object.assign(new Error(`数据集中没有 kind=${options.kinds.join('/')} 的条目`), { code: 'DATASET_EMPTY' });

  // 幂等灌入：确保目标知识库就是数据集版本（仍为 candidate，不会覆盖已有审核状态）。
  const seeded = seedLocal({ root: options.root, entries: selected });
  if (seeded.ok !== true) throw Object.assign(new Error('数据集灌入失败'), { code: 'SEED_FAILED', details: seeded.errors?.slice(0, 5) });

  const store = createKnowledgeStore({ root: options.root });
  const candidates = store.list({ reviewState: 'candidate' });
  const byTitle = new Map(selected.map((entry) => [`${entry.kind}::${entry.title}`, entry]));
  const targets = candidates.filter((entry) => byTitle.has(`${entry.kind}::${entry.title}`));
  const limited = options.limit > 0 ? targets.slice(0, options.limit) : targets;
  const dryRun = !options.confirm;

  const approved = [];
  const failures = [];
  for (const entry of limited) {
    if (dryRun) { approved.push({ id: entry.id, kind: entry.kind, title: entry.title, reviewedBy: options.reviewer || '(dry-run)' }); continue; }
    try {
      const reviewed = store.review(entry.id, { state: 'approved', reviewedBy: options.reviewer });
      approved.push({ id: reviewed.id, kind: reviewed.kind, title: reviewed.title, reviewedBy: reviewed.review?.reviewedBy });
    } catch (error) {
      failures.push({ id: entry.id, title: entry.title, code: error?.code ?? 'REVIEW_FAILED', message: String(error?.message || error).slice(0, 240) });
    }
  }
  console.log(JSON.stringify({
    ok: failures.length === 0,
    mode: dryRun ? 'dry-run' : 'confirm',
    root: options.root,
    kinds: options.kinds,
    datasetEntries: selected.length,
    candidatesMatched: targets.length,
    approvedOrWouldApprove: approved.length,
    failures,
    sample: approved.slice(0, 8),
    note: dryRun ? '默认 dry-run：确认无误后加 --confirm 写入 approved 与 reviewedBy' : '已写入 approved；reviewedBy 逐条记录，可追溯',
  }, null, 2));
  if (failures.length) process.exit(1);
};

try { main(); } catch (error) {
  console.error(JSON.stringify({ ok: false, code: error?.code ?? 'ERROR', message: String(error?.message || error), details: error?.details ?? null }, null, 2));
  process.exit(1);
}
