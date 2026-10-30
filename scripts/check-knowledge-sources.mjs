#!/usr/bin/env node
/**
 * 知识来源登记复核（离线）。
 *
 * 目的：sources.json 是“可追溯到公开资料”的根，不能只写一次就永久有效。
 * 本脚本检查：ID 唯一、HTTPS、证据等级、fetchedAt/reviewBy 有效期、SHA-256 形状、
 * 以及“登记来源必须被至少一条结构化条目引用 / 条目引用必须已登记”。
 *
 * 用法：
 *   node scripts/check-knowledge-sources.mjs
 *   node scripts/check-knowledge-sources.mjs --max-age-days 180
 *
 * 退出码：0 = 通过；1 = 有阻断问题（SOURCE_* 代码见输出）。
 * 它不会联网重抓，也不会自动改 reviewBy；到期后由人重新抓取、更新哈希并顺延 reviewBy。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from './seed-knowledge-pcb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REGISTRY_PATH = join(ROOT, 'knowledge/pcb/dataset/sources.json');
const EVIDENCE_LEVELS = new Set(['A', 'A/B', 'B/C', 'B', 'C']);

function parseArgs(argv) {
  const options = { maxAgeDays: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--max-age-days') {
      const value = Number.parseInt(argv[index + 1], 10);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--max-age-days 需要正整数');
      options.maxAgeDays = value;
      index += 1;
    }
  }
  return options;
}

function validate(registry, entries, { now = new Date(), maxAgeDays = null } = {}) {
  const problems = [];
  const warnings = [];
  const push = (code, message, sourceId = null) => problems.push({ code, message, ...(sourceId ? { sourceId } : {}) });
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.sources)) {
    return { problems: [{ code: 'SOURCE_REGISTRY_INVALID', message: 'sources.json 缺少 sources 数组' }], warnings, sourceIds: [] };
  }
  if (!registry.sources.length) push('SOURCE_REGISTRY_EMPTY', 'sources.json 没有任何来源');
  const ids = new Set();
  for (const source of registry.sources) {
    const id = source?.id;
    if (typeof id !== 'string' || !/^SRC-[A-Z0-9-]+$/.test(id)) { push('SOURCE_ID_INVALID', `来源 ID 非法：${JSON.stringify(id)}`, id); continue; }
    if (ids.has(id)) push('SOURCE_ID_DUPLICATE', `来源 ID 重复：${id}`, id);
    ids.add(id);
    if (!source.publisher || !source.title || !source.type || !source.revision) push('SOURCE_METADATA_MISSING', `来源 ${id} 缺少 publisher/title/type/revision`, id);
    if (typeof source.url !== 'string' || !/^https:\/\//.test(source.url)) push('SOURCE_URL_INVALID', `来源 ${id} 不是 HTTPS URL`, id);
    if (!EVIDENCE_LEVELS.has(source.evidenceLevel)) push('SOURCE_EVIDENCE_LEVEL_INVALID', `来源 ${id} evidenceLevel 非法：${JSON.stringify(source.evidenceLevel)}`, id);
    const fetchedAt = Date.parse(source.fetchedAt);
    if (!Number.isFinite(fetchedAt)) push('SOURCE_FETCHED_AT_INVALID', `来源 ${id} fetchedAt 非法`, id);
    else {
      if (fetchedAt > now.getTime() + 24 * 60 * 60 * 1000) push('SOURCE_FETCHED_AT_FUTURE', `来源 ${id} fetchedAt 在未来`, id);
      if (maxAgeDays && now.getTime() - fetchedAt > maxAgeDays * 86_400_000) push('SOURCE_FETCHED_AT_STALE', `来源 ${id} 已超过 ${maxAgeDays} 天未重抓`, id);
    }
    const reviewBy = Date.parse(source.reviewBy);
    if (!Number.isFinite(reviewBy)) push('SOURCE_REVIEW_BY_INVALID', `来源 ${id} 缺少/非法 reviewBy`, id);
    else {
      if (reviewBy <= fetchedAt) push('SOURCE_REVIEW_BY_NOT_AFTER_FETCH', `来源 ${id} reviewBy 必须晚于 fetchedAt`, id);
      if (reviewBy < now.getTime()) push('SOURCE_REVIEW_OVERDUE', `来源 ${id} 已过复核期限 ${source.reviewBy}，必须重抓/复核后顺延`, id);
    }
    if (typeof source.snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.snapshotSha256)) push('SOURCE_HASH_INVALID', `来源 ${id} snapshotSha256 非法`, id);
    if (!Array.isArray(source.topics) || source.topics.length === 0) warnings.push({ code: 'SOURCE_TOPICS_MISSING', message: `来源 ${id} 未登记 topics`, sourceId: id });
  }
  const referenced = new Set(entries.flatMap((entry) => entry?.payload?.sources ?? []));
  for (const id of referenced) if (!ids.has(id)) push('SOURCE_UNKNOWN_REFERENCE', `条目引用了未登记来源 ${id}`, id);
  const unused = [...ids].filter((id) => !referenced.has(id));
  for (const id of unused) push('SOURCE_UNUSED', `来源 ${id} 没有被任何结构化条目引用`, id);
  return { problems, warnings, sourceIds: [...ids] };
}

const options = parseArgs(process.argv.slice(2));
const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const dataset = loadDataset();
const result = validate(registry, dataset.entries, options);
const report = {
  ok: result.problems.length === 0,
  registryPath: REGISTRY_PATH,
  registryVersion: registry.version ?? null,
  sourceCount: registry.sources?.length ?? 0,
  referencedCount: new Set(dataset.entries.flatMap((entry) => entry?.payload?.sources ?? [])).size,
  problems: result.problems,
  warnings: result.warnings,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
