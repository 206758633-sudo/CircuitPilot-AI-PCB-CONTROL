/**
 * Agent 审计归档/回放（MVP）。
 *
 * 目标：把当前 HMAC 哈希链审计（audit JSONL + head 锚点）冻结为一个只读快照，
 * 并在回放时用原审计密钥重算整条链，检测快照被改写/换序/重排。
 *
 * 安全口径：
 *   - 归档只复制 audit + head 原始文件；**绝不复制 agent-audit.key.json**；
 *   - create 先完整校验当前链（含 head 锚点）再落快照，链断/密钥不可用则拒绝；
 *   - verify 先校验 manifest 的 SHA-256，再用外部提供的 key 重算链；
 *   - 归档不是“远端不可篡改锚点”：同用户仍可同时重写快照和 manifest；
 *     它提供的是可复核的时点冻结与篡改检测，不是硬件/远端 WORM。
 */
import { createHash, createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';

import {
  AGENT_AUDIT_HEAD_VERSION,
  AGENT_AUDIT_ZERO_HASH,
  agentAuditHeadFile,
  agentAuditKeyFile,
  canonicalAuditJson,
  computeAuditHash,
} from './agent-console.mjs';

export const AGENT_AUDIT_ARCHIVE_VERSION = 1;
export const AGENT_AUDIT_ARCHIVE_CODES = Object.freeze({
  AUDIT_NOT_FOUND: 'AGENT_AUDIT_ARCHIVE_AUDIT_NOT_FOUND',
  AUDIT_TOO_LARGE: 'AGENT_AUDIT_ARCHIVE_AUDIT_TOO_LARGE',
  KEY_UNAVAILABLE: 'AGENT_AUDIT_ARCHIVE_KEY_UNAVAILABLE',
  CHAIN_BROKEN: 'AGENT_AUDIT_ARCHIVE_CHAIN_BROKEN',
  INVALID_ARGUMENT: 'AGENT_AUDIT_ARCHIVE_INVALID_ARGUMENT',
  CREATE_FAILED: 'AGENT_AUDIT_ARCHIVE_CREATE_FAILED',
  VERIFY_FAILED: 'AGENT_AUDIT_ARCHIVE_VERIFY_FAILED',
});
export const MAX_ARCHIVE_AUDIT_BYTES = 64 * 1024 * 1024;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const POSIX_PERMISSIONS = process.platform !== 'win32';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function signManifest(manifest, key) {
  const unsigned = { ...manifest };
  delete unsigned.signature;
  return createHmac('sha256', key).update(canonicalAuditJson(unsigned)).digest('hex');
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

async function readKey(keyFile) {
  if (typeof keyFile !== 'string' || !keyFile.trim()) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.KEY_UNAVAILABLE, '缺少审计密钥文件路径');
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(keyFile, 'utf8'));
  } catch {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.KEY_UNAVAILABLE, '审计密钥文件缺失或不是合法 JSON');
  }
  if (!isPlainObject(parsed) || parsed.version !== 1 || typeof parsed.key !== 'string' || !KEY_HEX_PATTERN.test(parsed.key)) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.KEY_UNAVAILABLE, '审计密钥文件格式非法');
  }
  return { ok: true, key: Buffer.from(parsed.key, 'hex') };
}

/**
 * 完整校验一条审计文件的 HMAC 链（不依赖 readAgentAudit 的尾部窗口）。
 * @param {{auditFile:string, keyFile:string, headFile?:string}} options
 */
export async function verifyAuditChain({ auditFile, keyFile, headFile } = {}) {
  if (typeof auditFile !== 'string' || !auditFile.trim()) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT, 'auditFile 不能为空');
  }
  const keyResult = await readKey(keyFile);
  if (!keyResult.ok) return keyResult;
  let stat;
  try {
    stat = await fs.stat(auditFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return fail(AGENT_AUDIT_ARCHIVE_CODES.AUDIT_NOT_FOUND, '审计文件不存在');
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, '审计文件不可读');
  }
  if (!stat.isFile()) return fail(AGENT_AUDIT_ARCHIVE_CODES.AUDIT_NOT_FOUND, '审计路径不是普通文件');
  if (stat.size > MAX_ARCHIVE_AUDIT_BYTES) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.AUDIT_TOO_LARGE, `审计文件超过 ${MAX_ARCHIVE_AUDIT_BYTES} 字节上限`);
  }

  let raw;
  try {
    raw = await fs.readFile(auditFile);
  } catch {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, '审计文件读取失败');
  }
  const lines = raw.toString('utf8').split('\n');
  let total = 0;
  let verified = 0;
  let legacy = 0;
  let last = null;
  let sawChain = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    total += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, `审计第 ${i + 1} 行不是合法 JSON`, { total, verified, legacy, lastSeq: last?.seq ?? null });
    }
    if (!isPlainObject(record)) {
      return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, `审计第 ${i + 1} 行不是对象`, { total, verified, legacy, lastSeq: last?.seq ?? null });
    }
    const hasChainFields = record.seq !== undefined || record.prevHash !== undefined || record.hash !== undefined;
    if (!hasChainFields) {
      if (sawChain) {
        return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, `审计第 ${i + 1} 行：链记录之后出现 legacy 行`, { total, verified, legacy, lastSeq: last?.seq ?? null });
      }
      legacy += 1;
      continue;
    }
    sawChain = true;
    if (!Number.isInteger(record.seq) || record.seq < 1
      || typeof record.prevHash !== 'string' || !HASH_PATTERN.test(record.prevHash)
      || typeof record.hash !== 'string' || !HASH_PATTERN.test(record.hash)) {
      return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, `审计第 ${i + 1} 行链字段非法`, { total, verified, legacy, lastSeq: last?.seq ?? null });
    }
    if (record.seq !== verified + 1) {
      return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, `审计第 ${i + 1} 行 seq 不连续`, { total, verified, legacy, lastSeq: last?.seq ?? null });
    }
    const expectedPrev = last ? last.hash : AGENT_AUDIT_ZERO_HASH;
    if (record.prevHash !== expectedPrev) {
      return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, `审计第 ${i + 1} 行 prevHash 不匹配`, { total, verified, legacy, lastSeq: last?.seq ?? null });
    }
    const { seq: _seq, prevHash: _prevHash, hash: _hash, ...event } = record;
    const expectedHash = computeAuditHash(keyResult.key, record.seq, record.prevHash, event);
    if (expectedHash !== record.hash) {
      return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, `审计第 ${i + 1} 行 HMAC 不匹配`, { total, verified, legacy, lastSeq: last?.seq ?? null });
    }
    verified += 1;
    last = record;
  }

  let anchored = false;
  if (headFile) {
    let head;
    try {
      head = JSON.parse(await fs.readFile(headFile, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        if (last) return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, '审计有链记录但 head 锚点文件缺失', { total, verified, legacy, lastSeq: last.seq });
      } else {
        return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, '审计 head 锚点文件不可读', { total, verified, legacy, lastSeq: last?.seq ?? null });
      }
    }
    if (head) {
      if (!isPlainObject(head) || head.version !== AGENT_AUDIT_HEAD_VERSION
        || !Number.isInteger(head.seq) || head.seq < 1
        || typeof head.hash !== 'string' || !HASH_PATTERN.test(head.hash)
        || typeof head.updatedAt !== 'string' || Number.isNaN(Date.parse(head.updatedAt))) {
        return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, '审计 head 锚点格式非法', { total, verified, legacy, lastSeq: last?.seq ?? null });
      }
      if (!last || head.seq !== last.seq || head.hash !== last.hash) {
        return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, '审计 head 锚点与最后一条链记录不一致', { total, verified, legacy, lastSeq: last?.seq ?? null });
      }
      anchored = true;
    } else if (last) {
      return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, '审计有链记录但 head 锚点缺失', { total, verified, legacy, lastSeq: last.seq });
    }
  }

  return {
    ok: true,
    total,
    verified,
    legacy,
    anchored,
    lastSeq: last?.seq ?? null,
    lastHash: last?.hash ?? null,
    sha256: sha256(raw),
    bytes: raw.length,
  };
}

async function writePrivateFile(file, bytes) {
  await fs.writeFile(file, bytes, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
  if (POSIX_PERMISSIONS) await fs.chmod(file, PRIVATE_FILE_MODE);
}

/**
 * 冻结当前审计链为快照。outDir 必须不存在或为空，避免覆盖已有归档。
 * @param {{auditFile:string, keyFile?:string, headFile?:string, outDir:string, now?:()=>Date}} options
 */
export async function createAgentAuditArchive({ auditFile, keyFile, headFile, outDir, now = () => new Date() } = {}) {
  if (typeof auditFile !== 'string' || !auditFile.trim()) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT, 'auditFile 不能为空');
  }
  if (typeof outDir !== 'string' || !outDir.trim()) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT, 'outDir 不能为空');
  }
  const resolvedKeyFile = typeof keyFile === 'string' && keyFile.trim() ? keyFile.trim() : agentAuditKeyFile(auditFile);
  const resolvedHeadFile = typeof headFile === 'string' && headFile.trim() ? headFile.trim() : agentAuditHeadFile(auditFile);
  const chain = await verifyAuditChain({ auditFile, keyFile: resolvedKeyFile, headFile: resolvedHeadFile });
  if (!chain.ok) return chain;

  let auditBytes;
  let headBytes = null;
  try {
    auditBytes = await fs.readFile(auditFile);
    try {
      headBytes = await fs.readFile(resolvedHeadFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } catch {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.CREATE_FAILED, '读取审计/head 失败');
  }

  try {
    await fs.mkdir(outDir, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
    if (POSIX_PERMISSIONS) await fs.chmod(outDir, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    if (error?.code === 'EEXIST') return fail(AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT, 'outDir 已存在，拒绝覆盖归档');
    return fail(AGENT_AUDIT_ARCHIVE_CODES.CREATE_FAILED, '创建归档目录失败');
  }

  const keyResult = await readKey(resolvedKeyFile);
  if (!keyResult.ok) return keyResult;
  const auditName = 'agent-audit.jsonl';
  const headName = 'agent-audit.head.json';
  const manifestName = 'manifest.json';
  try {
    await writePrivateFile(join(outDir, auditName), auditBytes);
    if (headBytes) await writePrivateFile(join(outDir, headName), headBytes);
    const manifest = {
      version: AGENT_AUDIT_ARCHIVE_VERSION,
      createdAt: now().toISOString(),
      source: { audit: basename(auditFile), head: headBytes ? basename(resolvedHeadFile) : null },
      audit: { file: auditName, bytes: auditBytes.length, sha256: sha256(auditBytes) },
      head: headBytes ? { file: headName, bytes: headBytes.length, sha256: sha256(headBytes), seq: chain.lastSeq, hash: chain.lastHash } : null,
      chain: { total: chain.total, verified: chain.verified, legacy: chain.legacy, anchored: chain.anchored, lastSeq: chain.lastSeq, lastHash: chain.lastHash },
      key: { included: false, note: '审计密钥不进入归档；回放时由外部提供 key 文件' },
    };
    manifest.signature = signManifest(manifest, keyResult.key);
    await writePrivateFile(join(outDir, manifestName), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
    return { ok: true, dir: outDir, manifest, auditFile: join(outDir, auditName), headFile: headBytes ? join(outDir, headName) : null };
  } catch {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.CREATE_FAILED, '写入归档失败');
  }
}

/**
 * 回放/校验归档：先验 manifest 摘要，再用外部 key 重算链。
 * @param {{dir:string, keyFile:string, now?:()=>Date}} options
 */
export async function verifyAgentAuditArchive({ dir, keyFile } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT, 'dir 不能为空');
  }
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, 'manifest 缺失或不是合法 JSON');
  }
  if (!isPlainObject(manifest) || manifest.version !== AGENT_AUDIT_ARCHIVE_VERSION
    || !isPlainObject(manifest.audit) || typeof manifest.audit.file !== 'string'
    || !isPlainObject(manifest.chain)) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, 'manifest 格式非法');
  }
  if (basename(manifest.audit.file) !== manifest.audit.file) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, 'manifest audit.file 不能包含路径');
  }
  if (manifest.head !== null && manifest.head !== undefined
    && (!isPlainObject(manifest.head) || typeof manifest.head.file !== 'string' || basename(manifest.head.file) !== manifest.head.file)) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, 'manifest head.file 非法');
  }
  if (typeof manifest.signature !== 'string' || !HASH_PATTERN.test(manifest.signature)) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, 'manifest 缺少合法签名');
  }
  const keyResult = await readKey(keyFile);
  if (!keyResult.ok) return keyResult;
  if (signManifest(manifest, keyResult.key) !== manifest.signature) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, 'manifest HMAC 签名不匹配（清单被改写）');
  }
  const auditPath = join(dir, manifest.audit.file);
  const headPath = manifest.head && typeof manifest.head.file === 'string' ? join(dir, manifest.head.file) : null;
  let auditBytes;
  try {
    auditBytes = await fs.readFile(auditPath);
  } catch {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, '归档审计文件缺失');
  }
  if (sha256(auditBytes) !== manifest.audit.sha256) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, '归档审计文件 SHA-256 不匹配（快照被改写）');
  }
  if (headPath) {
    let headBytes;
    try {
      headBytes = await fs.readFile(headPath);
    } catch {
      return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, '归档 head 文件缺失');
    }
    if (sha256(headBytes) !== manifest.head.sha256) {
      return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, '归档 head SHA-256 不匹配（快照被改写）');
    }
  }
  const chain = await verifyAuditChain({ auditFile: auditPath, keyFile, headFile: headPath });
  if (!chain.ok) return chain;
  if (chain.total !== manifest.chain.total || chain.lastSeq !== manifest.chain.lastSeq || chain.lastHash !== manifest.chain.lastHash) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.CHAIN_BROKEN, '归档链计数/lastSeq/lastHash 与 manifest 不一致', { total: chain.total, verified: chain.verified, legacy: chain.legacy, lastSeq: chain.lastSeq });
  }
  return { ok: true, manifest, chain };
}


/**
 * 外部锚点（MVP）：把当前链头冻结成一条**独立目录**里的签名收据。
 *
 * 它解决的是“审计目录和 head 一起被改”时，至少外部副本还能做交叉核对；
 * **不是远端 WORM**：同一用户仍可重写外部目录。生产若要抗同用户篡改，
 * 需要把收据写到对象存储 WORM / 时间戳服务 / 独立主机。
 */
export async function createExternalAuditAnchor({ auditFile, keyFile, headFile, anchorDir, now = () => new Date() } = {}) {
  if (typeof auditFile !== 'string' || !auditFile.trim()) return fail(AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT, 'auditFile 不能为空');
  if (typeof anchorDir !== 'string' || !anchorDir.trim()) return fail(AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT, 'anchorDir 不能为空');
  const resolvedKeyFile = typeof keyFile === 'string' && keyFile.trim() ? keyFile.trim() : agentAuditKeyFile(auditFile);
  const resolvedHeadFile = typeof headFile === 'string' && headFile.trim() ? headFile.trim() : agentAuditHeadFile(auditFile);
  const chain = await verifyAuditChain({ auditFile, keyFile: resolvedKeyFile, headFile: resolvedHeadFile });
  if (!chain.ok) return chain;
  if (!chain.lastSeq || !chain.lastHash) return fail(AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT, '空审计链不生成外部锚点');
  const keyResult = await readKey(resolvedKeyFile);
  if (!keyResult.ok) return keyResult;
  const anchor = {
    version: 1,
    kind: 'external-audit-anchor',
    createdAt: now().toISOString(),
    source: { audit: basename(auditFile), head: basename(resolvedHeadFile) },
    chain: {
      total: chain.total,
      verified: chain.verified,
      legacy: chain.legacy,
      anchored: chain.anchored,
      lastSeq: chain.lastSeq,
      lastHash: chain.lastHash,
      auditSha256: chain.sha256,
      auditBytes: chain.bytes,
    },
    note: '独立目录副本；不是远端WORM。验证时需提供原审计key。',
  };
  anchor.signature = signManifest(anchor, keyResult.key);
  try {
    await fs.mkdir(anchorDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (POSIX_PERMISSIONS) await fs.chmod(anchorDir, PRIVATE_DIRECTORY_MODE);
  } catch {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.CREATE_FAILED, '创建外部锚点目录失败');
  }
  const fileName = `anchor-${chain.lastSeq}-${chain.lastHash.slice(0, 16)}.json`;
  const anchorFile = join(anchorDir, fileName);
  try {
    await writePrivateFile(anchorFile, Buffer.from(`${JSON.stringify(anchor, null, 2)}\n`, 'utf8'));
  } catch (error) {
    if (error?.code === 'EEXIST') return fail(AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT, '同一链头的外部锚点已存在，拒绝覆盖');
    return fail(AGENT_AUDIT_ARCHIVE_CODES.CREATE_FAILED, '写入外部锚点失败');
  }
  return { ok: true, anchorFile, anchor };
}

/**
 * 校验外部锚点：先验锚点签名，再用外部 key 重算当前链。
 * 返回 currentMatches：当前链头是否仍等于锚点；当前链已推进不等于锚点失效。
 */
export async function verifyExternalAuditAnchor({ anchorFile, auditFile, keyFile, headFile } = {}) {
  if (typeof anchorFile !== 'string' || !anchorFile.trim()) return fail(AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT, 'anchorFile 不能为空');
  let anchor;
  try {
    anchor = JSON.parse(await fs.readFile(anchorFile, 'utf8'));
  } catch {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, '外部锚点缺失或不是合法 JSON');
  }
  if (!isPlainObject(anchor) || anchor.version !== 1 || anchor.kind !== 'external-audit-anchor'
    || !isPlainObject(anchor.chain) || !Number.isInteger(anchor.chain.lastSeq) || anchor.chain.lastSeq < 1
    || typeof anchor.chain.lastHash !== 'string' || !HASH_PATTERN.test(anchor.chain.lastHash)
    || typeof anchor.signature !== 'string' || !HASH_PATTERN.test(anchor.signature)) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, '外部锚点格式非法');
  }
  const keyResult = await readKey(keyFile);
  if (!keyResult.ok) return keyResult;
  if (signManifest(anchor, keyResult.key) !== anchor.signature) {
    return fail(AGENT_AUDIT_ARCHIVE_CODES.VERIFY_FAILED, '外部锚点 HMAC 签名不匹配（收据被改写）');
  }
  if (typeof auditFile !== 'string' || !auditFile.trim()) return fail(AGENT_AUDIT_ARCHIVE_CODES.INVALID_ARGUMENT, 'auditFile 不能为空');
  const chain = await verifyAuditChain({ auditFile, keyFile, headFile });
  if (!chain.ok) return chain;
  const currentMatches = chain.lastSeq === anchor.chain.lastSeq && chain.lastHash === anchor.chain.lastHash;
  return {
    ok: true,
    anchor,
    chain,
    currentMatches,
    anchorSeq: anchor.chain.lastSeq,
    currentSeq: chain.lastSeq,
    message: currentMatches ? '当前链头与外部锚点一致' : '外部锚点签名有效，但当前链头已推进/不同',
  };
}
