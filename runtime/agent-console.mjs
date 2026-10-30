import { createHmac, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  AGENT_TOKEN_CODES,
  AGENT_TOKEN_NAME,
  AGENT_TOKEN_SCOPES,
  agentTokenFile,
  generateAgentToken,
  readAgentToken,
  verifyAgentToken,
} from './agent-token.mjs';

/**
 * Runtime 侧「Agent 接入控制台」模块（设置页用）：令牌状态 / 轮换 / 审计（含 HMAC 哈希链）。
 *
 * 定位：这是 UI 与 Runtime 之间的只读/受控写模块，**不碰 server.mjs**（路由由 Lead 接）。
 * 安全口径：
 *   - 任何返回值都**不含 token / 审计密钥**（令牌、approvalToken、Authorization、HMAC key 一律不出现）；
 *   - status 对「文件缺失/损坏/权限过宽」不抛 500，返回 available:false + reason code；
 *   - rotate 复用 agent-token.mjs 的 generateAgentToken / 记录格式 / 原子写入语义；
 *   - audit 为 JSONL 追加；写入失败只返回 {ok:false,code}，绝不拖垮请求；
 *   - audit 防篡改（task-26）：每条记录带 `seq/prevHash/hash` 的 HMAC-SHA256 哈希链，
 *     篡改/删行/换序在读取时判为 integrity.broken，但不抛 500，事件仍尽量返回。
 *
 * 审计记录形状（新链）：
 *   { seq: 1..N, prevHash: '<64 hex，首条为 64 个 0>', at, kind, actor, agent?, method?,
 *     path?, outcome?, status?, planHash?, tool?, target?, executionId?, ...,
 *     hash: HMAC-SHA256(key, `${seq}\n${prevHash}\n${canonicalEventJson}`) }
 * 旧格式（legacy）没有 seq/prevHash/hash，按兼容处理：允许作为链前缀，新链仍从 seq=1 开始。
 */

/** 审计事件类型（允许扩展，但 UI/路由按这些值着色）。 */
export const AGENT_AUDIT_KINDS = Object.freeze(['request', 'denied', 'approve', 'rotate']);

/** 哈希链首条记录的 prevHash（64 个 0）。 */
export const AGENT_AUDIT_ZERO_HASH = '0'.repeat(64);
/** 哈希算法/摘要长度（hex）。 */
export const AGENT_AUDIT_HASH_ALGORITHM = 'sha256';
export const AGENT_AUDIT_HASH_HEX_LENGTH = 64;
/** head 锚点文件版本。 */
export const AGENT_AUDIT_HEAD_VERSION = 1;

/** 控制台模块错误码（返回给 UI/路由，不含 token/key）。 */
export const AGENT_CONSOLE_CODES = Object.freeze({
  /** token 文件不存在（尚未签发/被删除）。 */
  TOKEN_MISSING: 'AGENT_TOKEN_MISSING',
  /** token 文件存在但格式/权限非法。 */
  TOKEN_INVALID: AGENT_TOKEN_CODES.INVALID,
  /** token 文件存在但读取失败（非格式问题，如 IO 错误）。 */
  TOKEN_READ_FAILED: 'AGENT_TOKEN_READ_FAILED',
  /** 轮换写盘/回读失败。 */
  ROTATE_FAILED: 'AGENT_TOKEN_ROTATE_FAILED',
  /** 审计追加失败（写盘/参数问题；调用方应忽略并继续处理业务请求）。 */
  AUDIT_APPEND_FAILED: 'AGENT_AUDIT_APPEND_FAILED',
  /** 审计链已断（最后一行损坏 / HMAC 不匹配 / 密钥不可用）：拒绝追加，不写半条。 */
  CHAIN_BROKEN: 'AGENT_AUDIT_CHAIN_BROKEN',
  /** 审计读取失败（返回空列表，不抛）。 */
  AUDIT_READ_FAILED: 'AGENT_AUDIT_READ_FAILED',
  /** 参数非法（如 now 不是合法时间、路径为空）。 */
  INVALID_ARGUMENT: 'AGENT_CONSOLE_INVALID',
});

/** 单次读取的审计事件条数上限（防止一次请求拉爆 UI/内存）。 */
export const MAX_AUDIT_EVENTS = 1000;
/** 默认读取条数。 */
export const DEFAULT_AUDIT_LIMIT = 20;
/** 审计文件读取上限：超过时只读末尾窗口，并标记 truncated（integrity 无法完整校验）。 */
export const MAX_AUDIT_FILE_BYTES = 8 * 1024 * 1024;
/** append 续链时只读文件尾部（避免每个审计请求都整文件读取）。 */
export const AUDIT_TAIL_READ_BYTES = 256 * 1024;
/** path 字段的字节上限（契约要求字符串截断）。 */
export const MAX_AUDIT_PATH_BYTES = 512;

const TOKEN_VERSION = 1;
const KEY_FILE_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const POSIX_PERMISSIONS = process.platform !== 'win32';
/** 形如令牌的字符串：审计里出现也必须脱敏（例如被误写进 path 查询参数）。 */
const TOKEN_LIKE_PATTERN = /cpa_[0-9a-fA-F]{48}/g;
const REDACTED = 'cpa_[redacted]';
/** 链字段形状。 */
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/** 已知审计字段的字节上限；未列出的字段一律丢弃。 */
const AUDIT_FIELD_LIMITS = Object.freeze({
  at: 40,
  kind: 40,
  actor: 40,
  agent: 80,
  method: 16,
  path: MAX_AUDIT_PATH_BYTES,
  outcome: 64,
  planHash: 128,
  tool: 80,
  target: 256,
  executionId: 128,
  requestId: 200,
  approvalId: 128,
  note: 240,
});

/** 同进程内按 auditFile 串行化 append，避免并发请求读到同一 seq 后写出分叉链。 */
const appendQueues = new Map();

function enqueueAppend(file, task) {
  const previous = appendQueues.get(file) ?? Promise.resolve();
  const run = previous.then(
    () => task(),
    () => task(),
  );
  const tail = run.then(() => undefined, () => undefined);
  appendQueues.set(file, tail);
  tail.then(() => {
    if (appendQueues.get(file) === tail) appendQueues.delete(file);
  });
  return run;
}

function consoleError(message, code = AGENT_CONSOLE_CODES.INVALID_ARGUMENT, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 稳定 key 排序的 canonical JSON（哈希链计算唯一依赖它）。 */
export function canonicalAuditJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalAuditJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      if (value[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalAuditJson(value[key])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** HMAC-SHA256(key, `${seq}\n${prevHash}\n${canonicalEventJson}`) → 64 hex。 */
export function computeAuditHash(key, seq, prevHash, event) {
  const payload = `${seq}\n${prevHash}\n${canonicalAuditJson(event)}`;
  return createHmac(AGENT_AUDIT_HASH_ALGORITHM, key).update(payload, 'utf8').digest('hex');
}

/** 把字符串中的令牌样式内容脱敏（防止审计/错误信息回显凭据）。 */
function scrubSecrets(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.replace(TOKEN_LIKE_PATTERN, REDACTED);
}

/** 按 UTF-8 字节安全截断（不会截出半个多字节字符）。 */
function truncateBytes(value, maxBytes) {
  if (typeof value !== 'string') return value;
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  // 若切点落在续字节上，回退到该字符的起始字节，整字符丢弃。
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function cleanString(value, key) {
  if (typeof value !== 'string') return undefined;
  const text = scrubSecrets(value).trim();
  if (!text) return undefined;
  const limit = AUDIT_FIELD_LIMITS[key];
  return Number.isFinite(limit) ? truncateBytes(text, limit) : truncateBytes(text, 240);
}

/** 兼容 now 为函数/Date/时间字符串；非法时间必须报错，不能悄悄换成当前时间。 */
function toIsoTimestamp(now) {
  let value;
  try {
    value = typeof now === 'function' ? now() : now;
  } catch (error) {
    throw consoleError('agent-console 的 now() 取值失败', AGENT_CONSOLE_CODES.INVALID_ARGUMENT, error);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw consoleError('agent-console 的 now 必须是 Date 或可解析的时间字符串', AGENT_CONSOLE_CODES.INVALID_ARGUMENT);
  }
  return date.toISOString();
}

/** 尝试把任意时间值归一化为 ISO；非法时返回 null（审计写入必须尽量成功，不能因 at 脏值失败）。 */
function tryIsoTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 默认审计文件路径：
 *   CIRCUITPILOT_AGENT_AUDIT_FILE 优先；
 *   否则 <CIRCUITPILOT_STATE_DIR || process.cwd()/artifacts/state>/agent-audit.jsonl。
 */
export function agentAuditFile(env = process.env) {
  const source = isPlainObject(env) ? env : {};
  const configured = typeof source.CIRCUITPILOT_AGENT_AUDIT_FILE === 'string'
    ? source.CIRCUITPILOT_AGENT_AUDIT_FILE.trim()
    : '';
  if (configured) return configured;
  const stateDir = typeof source.CIRCUITPILOT_STATE_DIR === 'string' && source.CIRCUITPILOT_STATE_DIR.trim()
    ? source.CIRCUITPILOT_STATE_DIR.trim()
    : join(process.cwd(), 'artifacts/state');
  return join(stateDir, 'agent-audit.jsonl');
}

/**
 * 默认审计密钥文件路径：
 *   CIRCUITPILOT_AGENT_AUDIT_KEY_FILE 优先，否则 dirname(auditFile)/agent-audit.key.json。
 */
export function agentAuditKeyFile(auditFile = agentAuditFile(), env = process.env) {
  const source = isPlainObject(env) ? env : {};
  const configured = typeof source.CIRCUITPILOT_AGENT_AUDIT_KEY_FILE === 'string'
    ? source.CIRCUITPILOT_AGENT_AUDIT_KEY_FILE.trim()
    : '';
  if (configured) return configured;
  return join(dirname(auditFile), 'agent-audit.key.json');
}

/**
 * 默认链头锚点文件路径：
 *   CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE 优先，否则 dirname(auditFile)/agent-audit.head.json。
 * head 记录“最后一条已写链记录”的 seq/hash，用于检测尾部删除（纯前缀链检测不到）。
 */
export function agentAuditHeadFile(auditFile = agentAuditFile(), env = process.env) {
  const source = isPlainObject(env) ? env : {};
  const configured = typeof source.CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE === 'string'
    ? source.CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE.trim()
    : '';
  if (configured) return configured;
  return join(dirname(auditFile), 'agent-audit.head.json');
}

function normalizeLimit(limit) {
  if (Number.isFinite(limit) && limit > 0) return Math.min(MAX_AUDIT_EVENTS, Math.floor(limit));
  return DEFAULT_AUDIT_LIMIT;
}

/**
 * 审计事件归一化：只保留已知字段，字符串脱敏+截断，拒绝嵌套对象/数组。
 *
 * @param {unknown} event 原始事件
 * @param {{mode?: 'append'|'read', now?: (() => Date) | Date | string}} [options]
 *   append 模式补 at/kind/actor 缺省值；read 模式只原样保留已有字段。
 * @returns {object|null} 归一化事件；非对象返回 null
 */
export function sanitizeAgentAuditEvent(event, { mode = 'read', now } = {}) {
  if (!isPlainObject(event)) return null;
  const out = {};
  if (mode === 'append') {
    out.at = tryIsoTimestamp(event.at) ?? tryIsoTimestamp(now ?? new Date()) ?? new Date().toISOString();
    out.kind = cleanString(event.kind, 'kind') ?? 'request';
    out.actor = cleanString(event.actor, 'actor') ?? 'unknown';
  }
  for (const key of Object.keys(AUDIT_FIELD_LIMITS)) {
    if (mode === 'append' && (key === 'at' || key === 'kind' || key === 'actor')) continue;
    const text = cleanString(event[key], key);
    if (text !== undefined) out[key] = text;
  }
  if (Number.isFinite(event.status)) out.status = Math.trunc(event.status);
  return out;
}

// ---------------------------------------------------------------------------
// 审计密钥（0600，自动生成 32B，绝不进入返回值/日志）
// ---------------------------------------------------------------------------

function keyError(reason, message) {
  return { ok: false, reason, message: truncateBytes(scrubSecrets(message), 240) };
}

async function readAuditKeyFile(file) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return keyError('missing', '审计密钥文件不存在');
    return keyError('invalid', `无法读取审计密钥文件：${file}`);
  }
  if (!stat.isFile()) return keyError('invalid', `审计密钥路径不是普通文件：${file}`);
  if (POSIX_PERMISSIONS && (stat.mode & 0o077) !== 0) {
    return keyError('permissions', `审计密钥文件权限过宽（${(stat.mode & 0o777).toString(8)}），必须为 0600`);
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return keyError('invalid', `审计密钥文件不是合法 JSON：${file}`);
  }
  if (!isPlainObject(parsed) || parsed.version !== KEY_FILE_VERSION || typeof parsed.key !== 'string' || !KEY_HEX_PATTERN.test(parsed.key)) {
    return keyError('invalid', `审计密钥文件格式非法：${file}`);
  }
  return { ok: true, key: Buffer.from(parsed.key, 'hex'), keyFile: file };
}

async function createAuditKeyFile(file) {
  const directory = dirname(file);
  try {
    let stat = null;
    try {
      stat = await fs.stat(directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') return keyError('create-failed', `无法访问审计密钥目录：${directory}`);
    }
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    // 只对新建目录收紧到 0700；已存在目录不动（可能与其他状态文件共享）。
    if (!stat && POSIX_PERMISSIONS) await fs.chmod(directory, PRIVATE_DIRECTORY_MODE).catch(() => {});
  } catch (error) {
    return keyError('create-failed', `无法创建审计密钥目录：${directory}`);
  }
  const record = { version: KEY_FILE_VERSION, key: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
  const temp = join(directory, `.${basename(file)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  let handle = null;
  try {
    handle = await fs.open(temp, 'wx', PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (POSIX_PERMISSIONS) await fs.chmod(temp, PRIVATE_FILE_MODE);
    await fs.rename(temp, file);
    if (POSIX_PERMISSIONS) await fs.chmod(file, PRIVATE_FILE_MODE);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    // 并发创建：别人已创建则读回。
    if (error?.code === 'EEXIST') return readAuditKeyFile(file);
    return keyError('create-failed', `审计密钥文件写入失败：${file}`);
  }
  return { ok: true, key: Buffer.from(record.key, 'hex'), keyFile: file };
}

/** 读取审计密钥；create=false 时缺失返回 reason=missing（不自动生成，避免误用新密钥校验旧链）。 */
async function loadAuditKey({ keyFile, create = false }) {
  const existing = await readAuditKeyFile(keyFile);
  if (existing.ok) return existing;
  if (existing.reason === 'missing' && create) return createAuditKeyFile(keyFile);
  return existing;
}

// ---------------------------------------------------------------------------
// 链头锚点（head anchor）：检测尾部删除/截断
// ---------------------------------------------------------------------------

/** 读取 head 锚点文件：不存在 reason=missing；损坏/格式非法 reason=invalid；不抛。 */
async function readAuditHeadFile(file) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'invalid', message: '无法读取审计头锚点文件' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'invalid', message: '审计头锚点路径不是普通文件' };
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return { ok: false, reason: 'invalid', message: '审计头锚点文件不是合法 JSON' };
  }
  if (!isPlainObject(parsed)
    || parsed.version !== AGENT_AUDIT_HEAD_VERSION
    || !Number.isInteger(parsed.seq) || parsed.seq < 1
    || typeof parsed.hash !== 'string' || !HASH_PATTERN.test(parsed.hash)
    || typeof parsed.updatedAt !== 'string' || Number.isNaN(Date.parse(parsed.updatedAt))) {
    return { ok: false, reason: 'invalid', message: '审计头锚点文件格式非法' };
  }
  return { ok: true, head: { version: parsed.version, seq: parsed.seq, hash: parsed.hash, updatedAt: parsed.updatedAt }, file };
}

/** 原子写 head 锚点（0600，临时 + fsync + rename）；失败返回 {ok:false} 且不抛。 */
async function writeAuditHeadFile(file, head) {
  const directory = dirname(file);
  const temp = join(directory, `.${basename(file)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  let handle = null;
  try {
    let stat = null;
    try {
      stat = await fs.stat(directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, message: '无法访问审计头锚点目录' };
    }
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (!stat && POSIX_PERMISSIONS) await fs.chmod(directory, PRIVATE_DIRECTORY_MODE).catch(() => {});
    handle = await fs.open(temp, 'wx', PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(head)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (POSIX_PERMISSIONS) await fs.chmod(temp, PRIVATE_FILE_MODE);
    await fs.rename(temp, file);
    if (POSIX_PERMISSIONS) await fs.chmod(file, PRIVATE_FILE_MODE);
    return { ok: true };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    return { ok: false, message: truncateBytes(scrubSecrets(error?.message || error), 200) };
  }
}

/** 比较 head 锚点与最后一条链记录：一致 → null；否则 head-ahead/head-behind/head-hash-mismatch。 */
function compareHeadToLast(head, lastChained) {
  if (!lastChained) return 'head-ahead';
  if (head.seq > lastChained.seq) return 'head-ahead';
  if (head.seq < lastChained.seq) return 'head-behind';
  if (head.hash !== lastChained.hash) return 'head-hash-mismatch';
  return null;
}

// ---------------------------------------------------------------------------
// 令牌：状态 / 轮换（task-23，行为保持）
// ---------------------------------------------------------------------------

async function ensurePrivateDirectory(directory) {
  let stat = null;
  try {
    stat = await fs.stat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw consoleError(`无法访问 agent token 目录：${directory}`, AGENT_CONSOLE_CODES.ROTATE_FAILED, error);
  }
  if (stat) {
    if (!stat.isDirectory()) throw consoleError(`agent token 目录路径不是目录：${directory}`, AGENT_CONSOLE_CODES.ROTATE_FAILED);
    return;
  }
  try {
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    // mkdir 的 mode 会被 umask 修正；令牌目录必须稳定为 0700。
    if (POSIX_PERMISSIONS) await fs.chmod(directory, PRIVATE_DIRECTORY_MODE).catch(() => {});
  } catch (error) {
    throw consoleError(`无法创建 agent token 目录：${directory}`, AGENT_CONSOLE_CODES.ROTATE_FAILED, error);
  }
}

/** 原子写入（与 agent-token.mjs 的 ensure 语义一致）：临时文件 0600 + fsync + rename。 */
async function writeTokenAtomically(file, record) {
  const directory = dirname(file);
  const temp = join(directory, `.${basename(file)}.rotate-${process.pid}-${randomBytes(6).toString('hex')}`);
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  let handle = null;
  try {
    handle = await fs.open(temp, 'wx', PRIVATE_FILE_MODE);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (POSIX_PERMISSIONS) await fs.chmod(temp, PRIVATE_FILE_MODE);
    await fs.rename(temp, file);
    if (POSIX_PERMISSIONS) await fs.chmod(file, PRIVATE_FILE_MODE);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw consoleError(`agent token 轮换写盘失败：${file}`, AGENT_CONSOLE_CODES.ROTATE_FAILED, error);
  }
}

/**
 * 轮换 agent 令牌：生成新令牌并原子替换文件（旧令牌立即失效）。
 *
 * 复用 agent-token.mjs 的 generateAgentToken/记录格式/0600+rename 语义；
 * 返回值刻意不含 token（契约 §1「不写日志、不回显完整 token」）。
 *
 * @param {{tokenFile?: string, now?: (() => Date) | Date | string}} [options]
 * @returns {Promise<{file: string, name: string, scopes: string[], createdAt: string, rotated: true}>}
 * @throws {Error} code=AGENT_TOKEN_ROTATE_FAILED / AGENT_CONSOLE_INVALID
 */
export async function rotateAgentToken({ tokenFile = agentTokenFile(), now = () => new Date() } = {}) {
  if (typeof tokenFile !== 'string' || !tokenFile.trim()) {
    throw consoleError('tokenFile 不能为空', AGENT_CONSOLE_CODES.INVALID_ARGUMENT);
  }
  const file = tokenFile;
  const createdAt = toIsoTimestamp(now);
  const record = {
    version: TOKEN_VERSION,
    name: AGENT_TOKEN_NAME,
    token: generateAgentToken(),
    scopes: [...AGENT_TOKEN_SCOPES],
    createdAt,
  };
  await ensurePrivateDirectory(dirname(file));
  await writeTokenAtomically(file, record);

  // 落盘后回读自证：确认写进去的就是刚签发的令牌，且能被正常校验（防止并发覆盖）。
  let written;
  try {
    written = await readAgentToken(file);
  } catch (error) {
    throw consoleError(`agent token 轮换后回读失败：${file}`, AGENT_CONSOLE_CODES.ROTATE_FAILED, error);
  }
  const matched = written ? verifyAgentToken(record.token, written) : null;
  if (!written || !matched || matched.name !== AGENT_TOKEN_NAME) {
    throw consoleError(`agent token 轮换后回读校验失败：${file}`, AGENT_CONSOLE_CODES.ROTATE_FAILED);
  }
  return { file, name: written.name, scopes: [...written.scopes], createdAt: written.createdAt ?? createdAt, rotated: true };
}

// ---------------------------------------------------------------------------
// 审计解析 / 追加 / 读取（HMAC 哈希链）
// ---------------------------------------------------------------------------

/**
 * 解析一行审计记录。
 * @returns {{valid:false, raw:string, invalidChain?:boolean} | {valid:true, legacy:boolean, event:object, seq?:number, prevHash?:string, hash?:string}}
 */
function parseAuditLine(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { valid: false, raw: text };
  }
  if (!isPlainObject(parsed)) return { valid: false, raw: text };
  const event = sanitizeAgentAuditEvent(parsed, { mode: 'read' });
  if (!event) return { valid: false, raw: text };

  const seq = Number.isInteger(parsed.seq) && parsed.seq > 0 ? parsed.seq : null;
  const prevHash = typeof parsed.prevHash === 'string' && HASH_PATTERN.test(parsed.prevHash) ? parsed.prevHash : null;
  const hash = typeof parsed.hash === 'string' && HASH_PATTERN.test(parsed.hash) ? parsed.hash : null;
  const hasAnyChainField = parsed.seq !== undefined || parsed.prevHash !== undefined || parsed.hash !== undefined;
  if (!hasAnyChainField) return { valid: true, legacy: true, event };
  if (seq === null || prevHash === null || hash === null) {
    return { valid: false, raw: text, invalidChain: true };
  }
  return { valid: true, legacy: false, event, seq, prevHash, hash };
}

/**
 * 读取审计文件尾部若干行（append 续链用）。文件不存在/为空返回空列表。
 * records 按文件顺序包含每一行（含解析失败的行，valid:false）。
 */
async function readAuditTail(file) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, records: [], trailingNewline: true };
    throw error;
  }
  if (!stat.isFile()) {
    throw consoleError(`审计路径不是普通文件：${file}`, AGENT_CONSOLE_CODES.AUDIT_APPEND_FAILED);
  }
  if (stat.size === 0) return { exists: true, records: [], trailingNewline: true };
  const readBytes = Math.min(stat.size, AUDIT_TAIL_READ_BYTES);
  const buffer = Buffer.alloc(readBytes);
  const handle = await fs.open(file, 'r');
  try {
    await handle.read(buffer, 0, readBytes, stat.size - readBytes);
  } finally {
    await handle.close();
  }
  const text = buffer.toString('utf8');
  const prefixTruncated = readBytes < stat.size;
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) lines.pop();
  if (prefixTruncated) lines.shift(); // 丢弃可能被截断的首行
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    records.push(parseAuditLine(line.trim()));
  }
  return { exists: true, records, trailingNewline };
}

/** 校验最后一条链记录：自哈希 + 与前一条（若可见）的 prevHash 链接。 */
function verifyTailRecord(last, previous, key) {
  const computed = computeAuditHash(key, last.seq, last.prevHash, last.event);
  if (computed !== last.hash) return `审计最后一条 HMAC 校验失败（seq=${last.seq}）`;
  if (last.seq === 1) {
    if (last.prevHash !== AGENT_AUDIT_ZERO_HASH) return '审计首条记录 prevHash 必须为 64 个 0';
    return null;
  }
  if (previous && previous.valid) {
    if (previous.legacy) return '审计链记录之后出现 legacy 行（顺序异常）';
    if (last.prevHash !== previous.hash) return `审计最后一条 prevHash 与前一条不匹配（seq=${last.seq}）`;
  }
  return null;
}

/**
 * 追加一条 agent 审计事件（JSONL，一行）。永不抛出：写盘失败返回 {ok:false,code}，
 * 调用方（路由）不应让审计失败拖垮业务请求。
 *
 * 每次追加都会读取文件尾部最后一条有效记录续链：最后一行损坏/链断/密钥不可用时
 * 返回 {ok:false,code:'AGENT_AUDIT_CHAIN_BROKEN'} 且不写入任何字节。
 *
 * 链头锚点：写入成功后原子更新 head 文件；写前若已有 head 且与最后一条链记录不一致
 * （head 领先/落后/hash 不符）则拒绝追加，避免静默接受被截断的审计。
 *
 * @param {{auditFile?: string, keyFile?: string, headFile?: string, event?: object}} [options]
 * @returns {Promise<{ok: true, file: string, headUpdated?: false, warning?: string} | {ok: false, code: string, message: string}>}
 */
export async function appendAgentAudit({ auditFile = agentAuditFile(), keyFile, headFile, event } = {}) {
  try {
    if (typeof auditFile !== 'string' || !auditFile.trim()) {
      return { ok: false, code: AGENT_CONSOLE_CODES.INVALID_ARGUMENT, message: 'auditFile 不能为空' };
    }
    const normalized = sanitizeAgentAuditEvent(event, { mode: 'append' });
    if (!normalized) {
      return { ok: false, code: AGENT_CONSOLE_CODES.INVALID_ARGUMENT, message: 'event 必须是对象' };
    }
    const file = auditFile;
    const resolvedKeyFile = typeof keyFile === 'string' && keyFile.trim() ? keyFile.trim() : agentAuditKeyFile(file);
    const resolvedHeadFile = typeof headFile === 'string' && headFile.trim() ? headFile.trim() : agentAuditHeadFile(file);

    return await enqueueAppend(file, async () => {
      let tail;
      try {
        tail = await readAuditTail(file);
      } catch (error) {
        return {
          ok: false,
          code: AGENT_CONSOLE_CODES.AUDIT_APPEND_FAILED,
          message: truncateBytes(scrubSecrets(error?.message || error), 240),
        };
      }

      const last = tail.records.length ? tail.records[tail.records.length - 1] : null;
      // 1) 最后一行损坏 → 拒绝追加（绝不写半条）。
      if (last && !last.valid) {
        return {
          ok: false,
          code: AGENT_CONSOLE_CODES.CHAIN_BROKEN,
          message: last.invalidChain ? '审计最后一行链字段不完整/非法' : '审计最后一行损坏（不是合法 JSON 记录）',
        };
      }

      // 2) 链头锚点校验：已有 head 时必须与最后一条链记录一致，否则拒绝（尾部删除/截断/崩溃窗口）。
      const lastChained = [...tail.records].reverse().find((record) => record.valid && record.legacy === false) ?? null;
      const headState = await readAuditHeadFile(resolvedHeadFile);
      if (headState.reason === 'invalid') {
        return { ok: false, code: AGENT_CONSOLE_CODES.CHAIN_BROKEN, message: '审计头锚点文件损坏或格式非法' };
      }
      if (headState.ok) {
        const headProblem = compareHeadToLast(headState.head, lastChained);
        if (headProblem) {
          return { ok: false, code: AGENT_CONSOLE_CODES.CHAIN_BROKEN, message: `审计头锚点与最后一条记录不一致（${headProblem}）` };
        }
      }

      let seq;
      let prevHash;
      let key;
      if (last && last.legacy) {
        // 链未开始时允许 legacy 前缀；链一旦开始就不允许再出现 legacy 行（换序/注入）。
        const chainedBefore = tail.records.some((record) => record.valid && record.legacy === false);
        if (chainedBefore) {
          return { ok: false, code: AGENT_CONSOLE_CODES.CHAIN_BROKEN, message: '审计存在链记录之后又出现 legacy 行（顺序异常）' };
        }
        seq = 1;
        prevHash = AGENT_AUDIT_ZERO_HASH;
        const keyResult = await loadAuditKey({ keyFile: resolvedKeyFile, create: true });
        if (!keyResult.ok) {
          return { ok: false, code: AGENT_CONSOLE_CODES.AUDIT_APPEND_FAILED, message: `审计密钥不可用：${keyResult.reason}` };
        }
        key = keyResult.key;
      } else if (last) {
        // 2) 已存在链记录：校验最后一条的自哈希与（可见的）前向链接，再续链。
        const keyResult = await loadAuditKey({ keyFile: resolvedKeyFile, create: false });
        if (!keyResult.ok) {
          return { ok: false, code: AGENT_CONSOLE_CODES.CHAIN_BROKEN, message: `审计链密钥不可用：${keyResult.reason}` };
        }
        key = keyResult.key;
        const problem = verifyTailRecord(last, tail.records[tail.records.length - 2] ?? null, key);
        if (problem) {
          return { ok: false, code: AGENT_CONSOLE_CODES.CHAIN_BROKEN, message: problem };
        }
        seq = last.seq + 1;
        prevHash = last.hash;
      } else {
        // 3) 空文件：从 seq=1 / prevHash=64 个 0 开始。
        seq = 1;
        prevHash = AGENT_AUDIT_ZERO_HASH;
        const keyResult = await loadAuditKey({ keyFile: resolvedKeyFile, create: true });
        if (!keyResult.ok) {
          return { ok: false, code: AGENT_CONSOLE_CODES.AUDIT_APPEND_FAILED, message: `审计密钥不可用：${keyResult.reason}` };
        }
        key = keyResult.key;
      }

      const hash = computeAuditHash(key, seq, prevHash, normalized);
      const record = { seq, prevHash, ...normalized, hash };
      const line = `${JSON.stringify(record)}\n`;
      // 最后一行没有换行（手工编辑/旧文件）时补一个分隔符，保证新记录独立成行。
      const separator = tail.exists && tail.trailingNewline === false ? '\n' : '';
      try {
        await fs.mkdir(dirname(file), { recursive: true });
        await fs.appendFile(file, `${separator}${line}`, 'utf8');
      } catch (error) {
        return {
          ok: false,
          code: AGENT_CONSOLE_CODES.AUDIT_APPEND_FAILED,
          message: truncateBytes(scrubSecrets(error?.message || error), 240),
        };
      }

      // 3) 审计行已落盘后更新 head 锚点；head 写失败不回滚、不抛，仅提示调用方。
      const headWritten = await writeAuditHeadFile(resolvedHeadFile, {
        version: AGENT_AUDIT_HEAD_VERSION,
        seq,
        hash,
        updatedAt: new Date().toISOString(),
      });
      if (!headWritten.ok) {
        return {
          ok: true,
          file,
          headUpdated: false,
          warning: truncateBytes(scrubSecrets(headWritten.message || '审计头锚点更新失败'), 240),
        };
      }
      return { ok: true, file };
    });
  } catch (error) {
    return {
      ok: false,
      code: AGENT_CONSOLE_CODES.AUDIT_APPEND_FAILED,
      message: truncateBytes(scrubSecrets(error?.message || error), 240),
    };
  }
}

/**
 * 读取审计事件（从文件尾部取最近 limit 条，最新在前），并校验 HMAC 哈希链。
 *
 * - 逐条校验 hash 与 prevHash：篡改/删行/换序 → integrity.ok=false、chain='broken'，
 *   给出 firstBadSeq/reason，但**不抛 500**，events 仍尽量返回供 UI 展示；
 * - legacy（无 hash）行兼容：可作为链前缀，全部为 legacy 时 chain='legacy'；
 * - 返回的 events 不包含 hash/prevHash（UI 不需要），链记录保留 seq；
 * - 返回字段原样保留（at/kind/actor/agent/method/path/outcome/status/planHash 等），
 *   但会脱敏令牌样式字符串并截断超长字段，绝不回显 token/key。
 *
 * @param {{auditFile?: string, keyFile?: string, headFile?: string, limit?: number}} [options]
 * @returns {Promise<{events: object[], total: number, truncated: boolean, badLines: number, file: string,
 *   integrity: {ok: boolean, chain: 'empty'|'ok'|'broken'|'legacy', verified: number, legacy: number,
 *     badLines: number, anchored: boolean, headSeq: number|null, headHash: string|null,
 *     firstBadSeq?: number, reason?: string}, error?: {code: string, message: string}}>}
 */
export async function readAgentAudit({ auditFile = agentAuditFile(), keyFile, headFile, limit = DEFAULT_AUDIT_LIMIT } = {}) {
  const file = typeof auditFile === 'string' ? auditFile : String(auditFile ?? '');
  const max = normalizeLimit(limit);
  const emptyIntegrity = { ok: true, chain: 'empty', verified: 0, legacy: 0, badLines: 0, anchored: false, headSeq: null, headHash: null };
  const empty = { events: [], total: 0, truncated: false, badLines: 0, file, integrity: emptyIntegrity };
  if (!file.trim()) {
    return {
      ...empty,
      integrity: { ...emptyIntegrity, ok: false, chain: 'broken', reason: 'invalid-file' },
      error: { code: AGENT_CONSOLE_CODES.AUDIT_READ_FAILED, message: 'auditFile 不能为空' },
    };
  }
  const resolvedKeyFile = typeof keyFile === 'string' && keyFile.trim() ? keyFile.trim() : agentAuditKeyFile(file);
  const resolvedHeadFile = typeof headFile === 'string' && headFile.trim() ? headFile.trim() : agentAuditHeadFile(file);

  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // 审计文件整体被删但 head 还在：说明尾部（甚至全部）记录被删除，必须 broken。
      const headState = await readAuditHeadFile(resolvedHeadFile);
      if (headState.ok) {
        return {
          ...empty,
          integrity: {
            ...emptyIntegrity,
            ok: false,
            chain: 'broken',
            headSeq: headState.head.seq,
            headHash: headState.head.hash,
            reason: 'head-ahead',
          },
        };
      }
      return empty;
    }
    return {
      ...empty,
      integrity: { ...emptyIntegrity, ok: false, chain: 'broken', reason: 'read-failed' },
      error: {
        code: AGENT_CONSOLE_CODES.AUDIT_READ_FAILED,
        message: truncateBytes(scrubSecrets(error?.message || error), 240),
      },
    };
  }

  // 超大文件只读末尾窗口；截断到第一个换行之后，避免把半行当坏行。
  let prefixTruncated = false;
  if (Buffer.byteLength(raw, 'utf8') > MAX_AUDIT_FILE_BYTES) {
    const buffer = Buffer.from(raw, 'utf8');
    const tailBuffer = buffer.subarray(buffer.length - MAX_AUDIT_FILE_BYTES);
    const newlineIndex = tailBuffer.indexOf(0x0a);
    raw = newlineIndex >= 0 ? tailBuffer.subarray(newlineIndex + 1).toString('utf8') : '';
    prefixTruncated = true;
  }

  const records = [];
  let badLines = 0;
  let badChainLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const parsed = parseAuditLine(text);
    if (!parsed.valid) {
      badLines += 1;
      if (parsed.invalidChain) badChainLines += 1;
      continue;
    }
    records.push(parsed);
  }

  const chained = records.filter((record) => !record.legacy);
  let keyState = null;
  if (chained.length) keyState = await loadAuditKey({ keyFile: resolvedKeyFile, create: false });

  let verified = 0;
  let legacy = 0;
  let expectedSeq = 1;
  let expectedPrev = AGENT_AUDIT_ZERO_HASH;
  let chainedSeen = false;
  let firstBadSeq;
  let firstBadIndex;
  let chainReason;
  const markBroken = (why, seq, index) => {
    if (chainReason) return;
    chainReason = why;
    if (Number.isInteger(seq)) firstBadSeq = seq;
    if (Number.isInteger(index)) firstBadIndex = index;
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.legacy) {
      legacy += 1;
      if (chainedSeen) markBroken('legacy-after-chain', expectedSeq, index);
      continue;
    }
    chainedSeen = true;
    if (!keyState || !keyState.ok) {
      markBroken(keyState?.reason === 'missing' ? 'key-missing' : 'key-invalid', record.seq, index);
    } else if (record.seq !== expectedSeq) {
      markBroken('seq-mismatch', expectedSeq, index);
    } else if (record.prevHash !== expectedPrev) {
      markBroken('prev-hash-mismatch', record.seq, index);
    } else if (computeAuditHash(keyState.key, record.seq, record.prevHash, record.event) !== record.hash) {
      markBroken('hash-mismatch', record.seq, index);
    } else {
      verified += 1;
    }
    expectedSeq = record.seq + 1;
    expectedPrev = record.hash;
  }

  if (badLines > 0) markBroken(badChainLines > 0 ? 'invalid-chain-fields' : 'bad-line', undefined, undefined);
  if (prefixTruncated) markBroken('read-window-truncated', undefined, undefined);

  // 链头锚点：head 存在时与最后一条链记录比对；head 缺失（旧审计）不判 broken。
  const headState = await readAuditHeadFile(resolvedHeadFile);
  const lastChained = [...records].reverse().find((record) => !record.legacy) ?? null;
  const headReason = headState.reason === 'invalid'
    ? 'head-invalid'
    : headState.ok
      ? compareHeadToLast(headState.head, lastChained)
      : null;
  // 链自身失败优先；若失败就发生在最后一条（典型尾部篡改）且 head 也不一致，则报 head 原因更精确。
  let reason = chainReason;
  if (headReason && (!reason || firstBadIndex === records.length - 1)) reason = headReason;
  const anchored = headState.ok && headReason === null;
  if (firstBadSeq === undefined && headReason && headState.ok) {
    firstBadSeq = headReason === 'head-behind' ? headState.head.seq + 1 : headState.head.seq;
  }

  const chain = reason ? 'broken' : chained.length > 0 ? 'ok' : legacy > 0 ? 'legacy' : 'empty';
  const integrity = {
    ok: !reason,
    chain,
    verified,
    legacy,
    badLines,
    anchored,
    headSeq: headState.ok ? headState.head.seq : null,
    headHash: headState.ok ? headState.head.hash : null,
    ...(reason ? { reason } : {}),
    ...(firstBadSeq !== undefined ? { firstBadSeq } : {}),
  };

  // 事件仍尽量返回；链字段（hash/prevHash）不返回，seq 保留给 UI。
  const events = records.map((record) => (record.legacy ? record.event : { seq: record.seq, ...record.event }));
  const total = events.length;
  const tail = events.slice(Math.max(0, total - max)).reverse(); // 最新在前
  return {
    events: tail,
    total,
    truncated: prefixTruncated || total > tail.length,
    badLines,
    file,
    integrity,
  };
}

/**
 * 设置页「Agent 接入」状态：令牌元信息 + 最近审计 + 审计链完整性。**绝不返回 token/key**。
 *
 * token 文件缺失/损坏/权限过宽时不抛 500：返回 available:false + reason code。
 *
 * @param {{tokenFile?: string, auditFile?: string, keyFile?: string, headFile?: string, limit?: number}} [options]
 * @returns {Promise<object>} 见模块头注释的数据形状（含 auditIntegrity）
 */
export async function agentConsoleStatus({ tokenFile = agentTokenFile(), auditFile = agentAuditFile(), keyFile, headFile, limit = DEFAULT_AUDIT_LIMIT } = {}) {
  const file = typeof tokenFile === 'string' ? tokenFile : String(tokenFile ?? '');
  const audit = await readAgentAudit({ auditFile, keyFile, headFile, limit });

  let available = false;
  let name = null;
  let scopes = [];
  let createdAt = null;
  let reason;
  let reasonDetail;

  try {
    const record = await readAgentToken(file);
    if (!record) {
      reason = AGENT_CONSOLE_CODES.TOKEN_MISSING;
      reasonDetail = 'agent token 文件不存在（尚未签发）';
    } else {
      available = true;
      name = record.name;
      scopes = [...record.scopes];
      // readAgentToken 只回传 {token,name,scopes}；createdAt 从已校验的文件里补读。
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        const iso = tryIsoTimestamp(parsed?.createdAt);
        createdAt = iso ?? (typeof parsed?.createdAt === 'string' ? parsed.createdAt : null);
      } catch {
        // 读取期间文件被轮换/删除：保留 available，createdAt 置空（下次刷新即可）。
        createdAt = null;
      }
    }
  } catch (error) {
    const code = error?.code === AGENT_TOKEN_CODES.INVALID ? AGENT_CONSOLE_CODES.TOKEN_INVALID : AGENT_CONSOLE_CODES.TOKEN_READ_FAILED;
    reason = code;
    reasonDetail = truncateBytes(scrubSecrets(error?.message || error), 240);
  }

  const status = {
    available,
    file,
    name,
    scopes,
    createdAt,
    ...(reason ? { reason } : {}),
    ...(reasonDetail ? { reasonDetail } : {}),
    audit: audit.events,
    auditFile: audit.file,
    auditTotal: audit.total,
    auditTruncated: audit.truncated,
    auditBadLines: audit.badLines,
    auditIntegrity: audit.integrity,
    ...(audit.error ? { auditError: audit.error } : {}),
  };
  return status;
}
