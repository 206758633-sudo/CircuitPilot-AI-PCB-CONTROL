#!/usr/bin/env node
/**
 * K1：PCB 设计 / 原理图 / 元件知识灌库（人工策划的通用工程知识）。
 *
 * 数据源：knowledge/pcb/dataset/{rules,modules,parts,failures}.json
 *   - 每条都带 doc 指针，provenance.url 指向 docs/knowledge/ 下的人类可读文档；
 *   - 入库一律 trust=reference、reviewState=candidate（AI/脚本不得自证，人工审核后才可被门禁引用）；
 *   - 同一 entityKey+payload 重复灌入只更新元数据（幂等），不会重复建条目。
 *
 * 两种落地方式：
 *   1) 本地知识库（默认）：node scripts/seed-knowledge-pcb.mjs [root]
 *      root 默认 artifacts/knowledge；运行时状态目录可用 CIRCUITPILOT_STATE_DIR 覆盖，root 传 <state>/knowledge。
 *   2) 正在运行的 CircuitPilot（候选条目经 HTTP API 写入，界面立即可见）：
 *      node scripts/seed-knowledge-pcb.mjs --api http://127.0.0.1:4178
 *      token 取 CP_TOKEN 或 /tmp/cp_app_token.txt；缺 token 时从 /api/health 的 sessionProof 刷新。
 *
 * 其它参数：--check（只校验不写库）、--quiet。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnowledgeStore, KNOWLEDGE_KINDS } from '../runtime/knowledge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
export const DATASET_DIR = join(ROOT, 'knowledge/pcb/dataset');
export const DATASET_FILES = Object.freeze({
  rule: ['rules.json'],
  module: ['modules.json', 'cases.json'],
  part: ['parts.json'],
  failure: ['failures.json'],
});
export const KNOWLEDGE_SOURCE = 'curated-pcb-engineering';
export const KNOWLEDGE_VERSION = '1.3.0';
export const COLLECTOR = 'seed-pcb-k9';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** 载入数据集文件（module 含 modules.json + cases.json），展开 entries 并补齐 kind。 */
export function loadDataset({ dir = DATASET_DIR } = {}) {
  const entries = [];
  const files = [];
  for (const [kind, names] of Object.entries(DATASET_FILES)) {
    for (const name of names) {
      const file = join(dir, name);
      if (!existsSync(file)) throw Object.assign(new Error(`知识数据集缺失：${file}`), { code: 'DATASET_FILE_MISSING' });
      const data = readJson(file);
      const list = Array.isArray(data?.entries) ? data.entries : [];
      if (!list.length) throw Object.assign(new Error(`知识数据集为空：${file}`), { code: 'DATASET_EMPTY' });
      for (const entry of list) {
        if (entry.kind !== undefined && entry.kind !== kind) {
          throw Object.assign(new Error(`数据集 ${name} 中出现 kind=${entry.kind}，期望 ${kind}`), { code: 'DATASET_KIND_MISMATCH' });
        }
        entries.push({ ...entry, kind, datasetFile: name });
      }
      files.push({ kind, file, count: list.length, version: data?.version ?? null });
    }
  }
  return { entries, files, dir };
}

const entityKeyOf = (entry) => {
  const payload = entry?.payload ?? {};
  if (entry.kind === 'part') return payload.lcscId || payload.mpn || payload.url || null;
  if (entry.kind === 'module') return payload.moduleId || null;
  if (entry.kind === 'rule') return payload.ruleId || null;
  if (entry.kind === 'failure') return payload.failureId || null;
  return null;
};

/** 数据集自检：字段/唯一性/文档指针。返回 problems 数组（空=通过）。 */
export function validateDataset(entries) {
  const problems = [];
  if (!Array.isArray(entries) || !entries.length) return [{ code: 'DATASET_EMPTY', message: '数据集没有任何条目' }];
  const seenKeys = new Map();
  for (const [index, entry] of entries.entries()) {
    const label = `#${index + 1} ${entry?.kind ?? '?'}:${entry?.title ?? '(无标题)'}`;
    if (!KNOWLEDGE_KINDS.includes(entry?.kind)) problems.push({ code: 'KIND_INVALID', label, message: `未知 kind：${entry?.kind}` });
    if (typeof entry?.title !== 'string' || !entry.title.trim()) problems.push({ code: 'TITLE_MISSING', label, message: 'title 为空' });
    if (!entry?.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) problems.push({ code: 'PAYLOAD_INVALID', label, message: 'payload 必须是对象' });
    if (typeof entry?.doc !== 'string' || !entry.doc.trim()) problems.push({ code: 'DOC_MISSING', label, message: '缺少 doc 指针' });
    else if (!existsSync(join(ROOT, entry.doc))) problems.push({ code: 'DOC_NOT_FOUND', label, message: `doc 不存在：${entry.doc}` });
    const key = entityKeyOf(entry);
    if (!key) problems.push({ code: 'ENTITY_KEY_MISSING', label, message: '无法推导 entityKey（part 需 lcscId/mpn/url，其它需 moduleId/ruleId/failureId）' });
    else {
      const composite = `${entry.kind}\u0000${key}`;
      if (seenKeys.has(composite)) problems.push({ code: 'ENTITY_KEY_DUPLICATE', label, message: `entityKey 重复：${key}（与 ${seenKeys.get(composite)} 冲突）` });
      else seenKeys.set(composite, label);
    }
    if (entry?.ttlDays !== undefined && !(typeof entry.ttlDays === 'number' && entry.ttlDays >= 0)) problems.push({ code: 'TTL_INVALID', label, message: 'ttlDays 必须 >= 0 的数字' });
  }
  return problems;
}

const provenanceFor = (entry, fetchedAt) => ({
  source: KNOWLEDGE_SOURCE,
  url: entry.doc,
  version: KNOWLEDGE_VERSION,
  fetchedAt,
  collector: COLLECTOR,
});

/** 写入本地 knowledge store（默认 artifacts/knowledge），返回逐条结果。 */
export function seedLocal({ root = join(ROOT, 'artifacts/knowledge'), entries, now = () => new Date(), dryRun = false } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw Object.assign(new Error('没有可灌入的条目'), { code: 'DATASET_EMPTY' });
  const problems = validateDataset(entries);
  if (problems.length) return { ok: false, problems, created: 0, updated: 0, errors: [], root };
  const store = createKnowledgeStore({ root, now });
  const fetchedAt = now().toISOString();
  const results = [];
  let created = 0;
  let updated = 0;
  const errors = [];
  for (const entry of entries) {
    try {
      if (dryRun) { results.push({ kind: entry.kind, title: entry.title, entityKey: entityKeyOf(entry), dryRun: true }); continue; }
      const saved = store.save({
        kind: entry.kind,
        title: entry.title,
        payload: entry.payload,
        provenance: provenanceFor(entry, fetchedAt),
        trust: 'reference',
        ttlDays: entry.ttlDays ?? null,
        reviewState: 'candidate',
      });
      if (saved.created) created += 1; else updated += 1;
      results.push({ id: saved.entry.id, kind: entry.kind, title: entry.title, entityKey: saved.entry.entityKey ?? entityKeyOf(entry), created: saved.created });
    } catch (error) {
      errors.push({ kind: entry.kind, title: entry.title, code: error?.code ?? 'SEED_FAILED', message: String(error?.message || error).slice(0, 240) });
    }
  }
  return { ok: errors.length === 0, root, created, updated, total: entries.length, errors, results };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function apiRequest({ baseUrl, path, method = 'GET', body = null, token = '' }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: 'tauri://localhost', ...(token ? { 'x-circuitpilot-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json };
}

async function resolveToken(baseUrl, token) {
  if (token) return { token, source: 'env' };
  try {
    const fromFile = readFileSync('/tmp/cp_app_token.txt', 'utf8').trim();
    if (fromFile) return { token: fromFile, source: '/tmp/cp_app_token.txt' };
  } catch { /* 没有该文件就继续尝试 health */ }
  const health = await apiRequest({ baseUrl, path: '/api/health' });
  const proof = health?.json?.sessionProof;
  if (typeof proof === 'string' && proof) return { token: proof, source: 'health.sessionProof' };
  return { token: '', source: 'none' };
}

/** 通过 Runtime HTTP API 写候选条目（界面立即可见，仍为 candidate）。 */
export async function seedViaApi({ baseUrl, entries, token = '', now = () => new Date(), limiterMs = 0 } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw Object.assign(new Error('没有可灌入的条目'), { code: 'DATASET_EMPTY' });
  if (typeof fetch !== 'function') throw Object.assign(new Error('当前 Node 不支持 fetch'), { code: 'FETCH_UNAVAILABLE' });
  const resolved = validateDataset(entries);
  if (resolved.length) return { ok: false, problems: resolved, created: 0, duplicates: 0, errors: [], baseUrl };
  const auth = await resolveToken(baseUrl, token);
  if (!auth.token) return { ok: false, code: 'RUNTIME_TOKEN_MISSING', message: '拿不到 Runtime 会话令牌：设置 CP_TOKEN 或先让应用写入 /tmp/cp_app_token.txt', created: 0, duplicates: 0, errors: [] };
  const usedToken = auth.token;
  let created = 0;
  let duplicates = 0;
  const errors = [];
  const results = [];
  for (const entry of entries) {
    const fetchedAt = now().toISOString();
    try {
      const result = await apiRequest({
        baseUrl,
        path: '/api/knowledge/entries',
        method: 'POST',
        token: usedToken,
        body: {
          kind: entry.kind,
          title: entry.title,
          payload: entry.payload,
          provenance: provenanceFor(entry, fetchedAt),
          trust: 'reference',
          ttlDays: entry.ttlDays ?? null,
        },
      });
      if (result.status === 401) throw Object.assign(new Error('Runtime 会话令牌无效'), { code: 'RUNTIME_TOKEN_INVALID' });
      if (result.status >= 400 || result?.json?.ok === false) throw Object.assign(new Error(result?.json?.error?.message || `HTTP ${result.status}`), { code: result?.json?.error?.code ?? 'HTTP_ERROR' });
      if (result.json?.created) created += 1; else duplicates += 1;
      results.push({ id: result.json?.entry?.id ?? null, kind: entry.kind, title: entry.title, created: result.json?.created === true });
    } catch (error) {
      errors.push({ kind: entry.kind, title: entry.title, code: error?.code ?? 'SEED_API_FAILED', message: String(error?.message || error).slice(0, 240) });
    }
    if (limiterMs > 0) await sleep(limiterMs);
  }
  return { ok: errors.length === 0, baseUrl, tokenSource: auth.source, created, duplicates, total: entries.length, errors, results };
}

const parseArgs = (argv) => {
  const options = { root: join(ROOT, 'artifacts/knowledge'), api: null, check: false, quiet: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--check') { options.check = true; continue; }
    if (value === '--quiet') { options.quiet = true; continue; }
    if (value === '--api') { options.api = argv[index + 1] ?? null; index += 1; continue; }
    if (value === '--root') { options.root = argv[index + 1] ? resolve(argv[index + 1]) : options.root; index += 1; continue; }
    positional.push(value);
  }
  if (positional.length) options.root = resolve(positional[0]);
  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const dataset = loadDataset();
  const problems = validateDataset(dataset.entries);
  const summary = { datasetDir: dataset.dir, files: dataset.files, entries: dataset.entries.length, problems: problems.length };
  if (problems.length) {
    console.error(JSON.stringify({ ok: false, ...summary, problems: problems.slice(0, 50) }, null, 2));
    process.exit(1);
  }
  if (options.check) {
    console.log(JSON.stringify({ ok: true, mode: 'check', ...summary }, null, 2));
    return;
  }
  const result = options.api
    ? await seedViaApi({ baseUrl: options.api, entries: dataset.entries, token: process.env.CP_TOKEN ?? '' })
    : seedLocal({ root: options.root, entries: dataset.entries });
  const report = {
    ok: result.ok === true,
    mode: options.api ? 'api' : 'local',
    ...summary,
    created: result.created ?? 0,
    updatedOrDuplicate: result.updated ?? result.duplicates ?? 0,
    errors: (result.errors ?? []).slice(0, 20),
    note: '全部条目仍为 candidate + reference；需在「知识库 → 审核队列」人工审核后才可被门禁引用。',
  };
  if (!options.quiet) console.log(JSON.stringify(report, null, 2));
  if (!result.ok) process.exit(1);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error?.code ?? 'SEED_FAILED', message: String(error?.message || error) }, null, 2));
    process.exit(1);
  });
}
