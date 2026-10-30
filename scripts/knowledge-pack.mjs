#!/usr/bin/env node
/**
 * 知识包构建/校验（P0-03）。
 *
 * 背景：`knowledge/pcb/dataset` 与 `docs/knowledge` 没有打进安装包（见 ota-and-experience-loop.md §3.1），
 * 所以"知识更新"必须走独立通道。本脚本把数据集打成**单个 JSON 包**（不依赖 zip 工具、可静态托管），
 * 并支持 ed25519 签名，供客户端"先验签再合并"。
 *
 * 用法：
 *   node scripts/knowledge-pack.mjs build --pack-version 2026.11.1 [--app-min 0.3.0]
 *        [--dataset <dir>] [--out <file>] [--key <ed25519-private.pem>] [--key-id pack-2026] [--validate]
 *   node scripts/knowledge-pack.mjs verify <pack.json> [--pubkey <ed25519-public.pem>]
 *
 * 设计约束：
 *   - 包体是纯 JSON，内容确定（同一数据集 + 参数 → 同一 contentSha256）；
 *   - 签名覆盖 `contentSha256`，客户端先算哈希再验签，避免"只验签不看内容"；
 *   - 未提供私钥时生成无签名包（`signature=null`），verify 会明确标 `unsigned`，不冒充已签名；
 *   - 只读数据集，不写 knowledge/ 源文件。
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATASET = 'knowledge/pcb/dataset';

export const KNOWLEDGE_PACK_SCHEMA = 1;
export const PACK_KIND = 'circuitpilot-knowledge-pack';
/** 必带文件：四类核心数据集；其余（sources/taxonomy/cases/conflicts）存在就带上。 */
export const REQUIRED_DATASET_FILES = Object.freeze(['rules.json', 'modules.json', 'parts.json', 'failures.json']);
export const OPTIONAL_DATASET_FILES = Object.freeze(['sources.json', 'taxonomy.json', 'cases.json', 'conflicts.json']);
export const ENTRY_KINDS = Object.freeze({ 'rules.json': 'rule', 'modules.json': 'module', 'parts.json': 'part', 'failures.json': 'failure' });

/** 键排序后序列化：同一内容永远得到同一哈希。 */
export function canonicalJson(value) {
  return JSON.stringify(value, (_, item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item
  ));
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 读取数据集目录：必带文件缺失直接失败，不生成残缺包。 */
export function loadDatasetFiles(datasetDir) {
  const files = {};
  for (const name of REQUIRED_DATASET_FILES) {
    const absolute = join(datasetDir, name);
    if (!existsSync(absolute)) throw Object.assign(new Error(`数据集中缺少必需文件：${name}`), { code: 'PACK_DATASET_INCOMPLETE' });
    files[name] = JSON.parse(readFileSync(absolute, 'utf8'));
    if (!Array.isArray(files[name]?.entries)) throw Object.assign(new Error(`${name} 缺少 entries 数组`), { code: 'PACK_DATASET_INVALID' });
  }
  for (const name of OPTIONAL_DATASET_FILES) {
    const absolute = join(datasetDir, name);
    if (existsSync(absolute)) files[name] = JSON.parse(readFileSync(absolute, 'utf8'));
  }
  return files;
}

export function countEntries(files) {
  const counts = {};
  for (const [name, kind] of Object.entries(ENTRY_KINDS)) counts[kind] = Array.isArray(files[name]?.entries) ? files[name].entries.length : 0;
  return counts;
}

export function buildKnowledgePack({
  datasetDir = join(ROOT, DEFAULT_DATASET), packVersion, appMinVersion = null,
  createdAt = () => new Date().toISOString(), keyPem = null, keyId = null, validate = false,
} = {}) {
  if (!packVersion || !/^\d{4}\.\d{2}\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(packVersion)) {
    throw Object.assign(new Error(`packVersion 需形如 2026.11.1，收到：${packVersion ?? '(空)'}`), { code: 'PACK_VERSION_INVALID' });
  }
  const files = loadDatasetFiles(datasetDir);
  if (validate) {
    const entries = Object.values(ENTRY_KINDS).flatMap((kind) => {
      const file = kind === 'rule' ? files['rules.json'] : kind === 'module' ? files['modules.json'] : kind === 'part' ? files['parts.json'] : files['failures.json'];
      return Array.isArray(file?.entries) ? file.entries : [];
    });
    // 延迟 require 避免脚本互相 import 产生循环；validateDataset 需要真实 doc 指针存在。
    const problems = validateDatasetEntries(entries);
    if (problems.length) throw Object.assign(new Error(`数据集校验未通过：${problems.slice(0, 3).map((item) => `${item.code} ${item.label ?? ''}`).join('; ')}`), { code: 'PACK_DATASET_INVALID', details: problems.slice(0, 20) });
  }
  const payload = {
    schemaVersion: KNOWLEDGE_PACK_SCHEMA,
    kind: PACK_KIND,
    packVersion,
    appMinVersion,
    createdAt: createdAt(),
    counts: countEntries(files),
    files,
  };
  // 哈希覆盖"内容字段"（不含 contentSha256/signature 本身），否则赋值会把哈希算进自己要覆盖的内容里。
  const contentSha256 = sha256Text(canonicalJson(payload));
  const signedPayload = { ...payload, contentSha256 };
  let signature = null;
  if (keyPem) {
    const privateKey = createPrivateKey(keyPem);
    signature = {
      alg: 'ed25519',
      keyId: keyId ?? 'pack-key',
      value: sign(null, Buffer.from(canonicalJson(signedPayload), 'utf8'), privateKey).toString('base64'),
    };
  }
  return { ...signedPayload, signature };
}

/** 可选严格校验：复用现有数据集校验（doc 指针必须存在）。独立导出便于测试。 */
export function validateDatasetEntries(entries) {
  const problems = [];
  for (const [index, entry] of entries.entries()) {
    const label = `#${index + 1} ${entry?.kind ?? '?'}:${entry?.title ?? '(无标题)'}`;
    if (!['part', 'module', 'rule', 'failure'].includes(entry?.kind)) problems.push({ code: 'KIND_INVALID', label });
    if (typeof entry?.title !== 'string' || !entry.title.trim()) problems.push({ code: 'TITLE_MISSING', label });
    if (!entry?.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) problems.push({ code: 'PAYLOAD_INVALID', label });
    if (typeof entry?.doc !== 'string' || !entry.doc.trim()) problems.push({ code: 'DOC_MISSING', label });
    else if (!existsSync(join(ROOT, entry.doc))) problems.push({ code: 'DOC_NOT_FOUND', label, message: entry.doc });
  }
  return problems;
}

/** 校验包：结构 → 内容哈希 → （可选）签名。返回 ok/problems/signature 状态。 */
export function verifyKnowledgePack(pack, { publicKeyPem = null } = {}) {
  const problems = [];
  if (!pack || typeof pack !== 'object') return { ok: false, signature: 'none', problems: [{ code: 'PACK_INVALID' }] };
  if (pack.schemaVersion !== KNOWLEDGE_PACK_SCHEMA) problems.push({ code: 'SCHEMA_UNSUPPORTED', expected: KNOWLEDGE_PACK_SCHEMA, actual: pack.schemaVersion });
  if (pack.kind !== PACK_KIND) problems.push({ code: 'KIND_INVALID', actual: pack.kind });
  if (!/^\d{4}\.\d{2}\.\d+/.test(String(pack.packVersion ?? ''))) problems.push({ code: 'PACK_VERSION_INVALID' });
  for (const name of REQUIRED_DATASET_FILES) if (!pack.files?.[name]?.entries) problems.push({ code: 'FILE_MISSING', file: name });
  const base = { ...pack };
  delete base.signature;
  delete base.contentSha256;
  if (pack.contentSha256 !== sha256Text(canonicalJson(base))) problems.push({ code: 'CONTENT_HASH_MISMATCH' });
  let signatureStatus = 'unsigned';
  if (pack.signature) {
    if (pack.signature.alg !== 'ed25519' || typeof pack.signature.value !== 'string') {
      problems.push({ code: 'SIGNATURE_INVALID', message: '签名结构不支持' });
      signatureStatus = 'invalid';
    } else if (!publicKeyPem) {
      signatureStatus = 'unverified-no-key';
    } else {
      try {
        const signedPayload = { ...base, contentSha256: pack.contentSha256 };
        const ok = verify(null, Buffer.from(canonicalJson(signedPayload), 'utf8'), createPublicKey(publicKeyPem), Buffer.from(pack.signature.value, 'base64'));
        signatureStatus = ok ? 'verified' : 'invalid';
        if (!ok) problems.push({ code: 'SIGNATURE_INVALID' });
      } catch (error) {
        signatureStatus = 'invalid';
        problems.push({ code: 'SIGNATURE_INVALID', message: String(error?.message ?? error) });
      }
    }
  }
  return { ok: problems.length === 0, signature: signatureStatus, problems, packVersion: pack.packVersion ?? null, counts: pack.counts ?? null };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === 'verify') {
    const file = argv[1];
    const pubIndex = argv.indexOf('--pubkey');
    if (!file) { console.error('用法：verify <pack.json> [--pubkey <ed25519-public.pem>]'); return 2; }
    try {
      const pack = JSON.parse(readFileSync(resolve(file), 'utf8'));
      const publicKeyPem = pubIndex >= 0 ? readFileSync(resolve(argv[pubIndex + 1]), 'utf8') : null;
      const result = verifyKnowledgePack(pack, { publicKeyPem });
      console.log(JSON.stringify({ ok: result.ok, packVersion: result.packVersion, counts: result.counts, signature: result.signature, problems: result.problems }, null, 2));
      return result.ok ? 0 : 1;
    } catch (error) {
      console.error(JSON.stringify({ ok: false, code: error?.code ?? 'PACK_READ_FAILED', message: String(error?.message ?? error) }, null, 2));
      return 2;
    }
  }
  if (command === 'build') {
    const arg = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; };
    const packVersion = arg('--pack-version');
    const out = arg('--out') ?? join(ROOT, 'artifacts/release', `knowledge-pack-${packVersion ?? 'unknown'}.json`);
    const keyFile = arg('--key');
    try {
      const pack = buildKnowledgePack({
        datasetDir: arg('--dataset') ? resolve(arg('--dataset')) : undefined,
        packVersion,
        appMinVersion: arg('--app-min'),
        keyPem: keyFile ? readFileSync(resolve(keyFile), 'utf8') : null,
        keyId: arg('--key-id'),
        validate: argv.includes('--validate'),
      });
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
      const verified = verifyKnowledgePack(pack);
      console.log(JSON.stringify({
        ok: verified.ok, out, packVersion: pack.packVersion, counts: pack.counts,
        bytes: Buffer.byteLength(JSON.stringify(pack)), contentSha256: pack.contentSha256,
        signature: pack.signature ? 'signed' : 'unsigned',
      }, null, 2));
      return verified.ok ? 0 : 1;
    } catch (error) {
      console.error(JSON.stringify({ ok: false, code: error?.code ?? 'PACK_BUILD_FAILED', message: String(error?.message ?? error) }, null, 2));
      return 1;
    }
  }
  console.error('用法：node scripts/knowledge-pack.mjs build --pack-version <v> [--key <pem>] | verify <pack.json> [--pubkey <pem>]');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main();
}
