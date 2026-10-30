import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { appDataDir } from './platform.mjs';

/**
 * Agent 身份令牌（契约 docs/agent/agent-contract.md §1「Agent 身份与令牌」）。
 *
 * 这是 DSH 插件/外部 Agent 调用本机 Runtime 的唯一凭据，必须与 UI 会话令牌
 * （`x-circuitpilot-token`，由 Tauri 壳层注入）完全隔离：插件拿不到 UI 令牌，只持有这份
 * 落盘的 Agent 令牌。默认路径随平台：macOS `~/Library/Application Support/CircuitPilot/agent-token.json`，
 * Windows `%APPDATA%\\CircuitPilot`，Linux `$XDG_STATE_HOME/circuitpilot`；文件 0600/目录 0700（Windows 忽略 mode），
 * 测试通过 `CIRCUITPILOT_AGENT_TOKEN_FILE` 指向临时文件。
 *
 * 安全口径（全部 fail-closed）：
 *   - 文件不存在 → 原子写入一份新令牌（同目录临时文件 0600 + rename），不拿"进程内随机数"顶替；
 *   - 文件存在但 JSON/字段非法，或权限对同组/其他用户开放 → 抛 AGENT_TOKEN_INVALID，绝不降级放行；
 *   - 认证用常量时间比较（crypto.timingSafeEqual）；长度不同直接返回 null，不抛错、不泄漏比较进度；
 *   - 本模块不写日志，错误 message 只描述"文件/权限/字段"，不包含完整 token；
 *   - 只有 24 字节随机数（48 hex）进入令牌，避免弱随机/可预测。
 */

export const AGENT_TOKEN_CODES = Object.freeze({
  INVALID: 'AGENT_TOKEN_INVALID',
});

/** 契约规定的前缀与令牌形状：cpa_ + 48 位十六进制。 */
export const AGENT_TOKEN_PREFIX = 'cpa_';
/** 契约规定的默认名称（后续多 Agent 可扩展，但签发值固定）。 */
export const AGENT_TOKEN_NAME = 'dsh-plugin';
/** MVP 的 scope 集合；执行前审批仍由对话确认（cp_approve）承担，不靠 scope 绕过。 */
export const AGENT_TOKEN_SCOPES = Object.freeze(['read', 'plan', 'execute']);
/** 请求头名（契约 §1「认证」）。 */
export const AGENT_TOKEN_HEADER = 'x-circuitpilot-agent-token';

const TOKEN_VERSION = 1;
const TOKEN_RANDOM_BYTES = 24; // 24 字节 → 48 hex
const TOKEN_PATTERN = /^cpa_[0-9a-fA-F]{48}$/;
const KNOWN_SCOPES = new Set(AGENT_TOKEN_SCOPES);
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
/** 同组/其他用户只要有读、写、执行任一权限，就说明令牌可能已经泄漏。 */
const PRIVATE_PERMISSION_MASK = 0o077;
/** Windows 的 mode 位不表达 POSIX 权限，不能据此判定"是否对他人开放"。 */
const POSIX_PERMISSIONS = process.platform !== 'win32';

function invalid(message, cause) {
  const error = new Error(message);
  error.code = AGENT_TOKEN_CODES.INVALID;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** 默认令牌文件：环境变量优先（测试用临时文件），否则 macOS 应用支持目录。 */
export function agentTokenFile(env = process.env) {
  const configured = typeof env?.CIRCUITPILOT_AGENT_TOKEN_FILE === 'string' ? env.CIRCUITPILOT_AGENT_TOKEN_FILE.trim() : '';
  if (configured) return configured;
  return join(appDataDir(), 'agent-token.json');
}

/** 生成契约规定的令牌：cpa_ + 24 字节随机数的 48 位 hex。 */
export function generateAgentToken() {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('hex')}`;
}

/** 兼容 now 为函数/Date/时间字符串；非法时间必须报错，不能悄悄换成当前时间。 */
function toIsoTimestamp(now) {
  let value;
  try {
    value = typeof now === 'function' ? now() : now;
  } catch (error) {
    throw invalid('agent token 的 now() 取值失败', error);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalid('agent token 的 createdAt 时间非法：now 必须是 Date 或可解析的时间字符串');
  }
  return date.toISOString();
}

/** 权限检查：文件允许同组/其他用户访问 = 令牌可能已被读取，直接判为损坏。 */
function assertPrivateFile(stat, file) {
  if (!POSIX_PERMISSIONS) return;
  const permissions = stat.mode & 0o777;
  if ((permissions & PRIVATE_PERMISSION_MASK) !== 0) {
    throw invalid(`agent token 文件权限过宽（${permissions.toString(8).padStart(3, '0')}），必须为 0600：${file}`);
  }
}

/** 校验文件 JSON 结构；任何字段不符合契约都按 AGENT_TOKEN_INVALID 处理。 */
function validateTokenRecord(parsed, file) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid(`agent token 文件必须是 JSON 对象：${file}`);
  }
  if (parsed.version !== TOKEN_VERSION) {
    throw invalid(`agent token.version 必须是 ${TOKEN_VERSION}：${file}`);
  }
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!name || name.length > 80) {
    throw invalid(`agent token.name 缺失或长度非法：${file}`);
  }
  if (typeof parsed.token !== 'string' || !TOKEN_PATTERN.test(parsed.token)) {
    // 注意：只描述格式，不回显 token 本身。
    throw invalid(`agent token.token 必须形如 cpa_<48 hex>：${file}`);
  }
  if (!Array.isArray(parsed.scopes) || parsed.scopes.length === 0) {
    throw invalid(`agent token.scopes 必须是非空数组：${file}`);
  }
  const scopes = [];
  for (const scope of parsed.scopes) {
    if (typeof scope !== 'string' || !KNOWN_SCOPES.has(scope)) {
      throw invalid(`agent token.scopes 含未授权 scope（只允许 ${AGENT_TOKEN_SCOPES.join('/')}）：${file}`);
    }
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) {
    throw invalid(`agent token.createdAt 缺失或不是合法时间：${file}`);
  }
  return { version: TOKEN_VERSION, name, token: parsed.token, scopes, createdAt: parsed.createdAt };
}

/**
 * 读取并校验令牌文件（完整记录）。
 * @returns {Promise<{version:number,name:string,token:string,scopes:string[],createdAt:string}|null>}
 *   文件不存在返回 null；存在但不合法抛 AGENT_TOKEN_INVALID。
 */
async function readTokenRecord(file) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw invalid(`无法读取 agent token 文件：${file}`, error);
  }
  if (!stat.isFile()) throw invalid(`agent token 路径不是普通文件：${file}`);
  assertPrivateFile(stat, file);

  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw invalid(`无法读取 agent token 文件：${file}`, error);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalid(`agent token 文件不是合法 JSON：${file}`, error);
  }
  return validateTokenRecord(parsed, file);
}

/**
 * 读取令牌：文件不存在返回 null；权限过宽/格式非法抛 AGENT_TOKEN_INVALID。
 *
 * 返回字段严格收敛为契约里的 `{ token, name, scopes }`，避免调用方把 createdAt 等
 * 内部字段误当认证依据；认证校验统一走 verifyAgentToken（常量时间比较）。
 */
export async function readAgentToken(file = agentTokenFile()) {
  const record = await readTokenRecord(file);
  if (!record) return null;
  return { token: record.token, name: record.name, scopes: record.scopes };
}

async function ensurePrivateDirectory(directory) {
  let stat = null;
  try {
    stat = await fs.stat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw invalid(`无法访问 agent token 目录：${directory}`, error);
  }
  if (stat) {
    if (!stat.isDirectory()) throw invalid(`agent token 目录路径不是目录：${directory}`);
    return;
  }
  try {
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    // mkdir 的 mode 会被 umask 修正；令牌目录必须稳定为 0700（不依赖调用方 umask）。
    if (POSIX_PERMISSIONS) await fs.chmod(directory, PRIVATE_DIRECTORY_MODE).catch(() => {});
  } catch (error) {
    throw invalid(`无法创建 agent token 目录：${directory}`, error);
  }
}

/**
 * 原子写入：先写同目录临时文件（0600、wx 独占），fsync 后 rename 覆盖。
 * 读取方要么看到完整旧文件，要么看到完整新文件，不会读到半截 JSON。
 */
async function writeTokenAtomically(file, record) {
  const directory = dirname(file);
  const temp = join(directory, `.${basename(file)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
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
    // rename 会保留临时文件的 mode，这里再显式收一次，避免平台/umask 差异。
    if (POSIX_PERMISSIONS) await fs.chmod(file, PRIVATE_FILE_MODE);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw invalid(`agent token 文件原子写入失败：${file}`, error);
  }
}

/**
 * 确保令牌文件存在：不存在则原子签发；已存在则读回校验（权限/格式不合法直接抛错）。
 *
 * @param {{file?: string, now?: (() => Date) | Date | string}} [options]
 * @returns {Promise<{created:boolean,file:string,name:string,token:string,scopes:string[],createdAt:string}>}
 *   token 仅供同进程使用；调用方禁止写日志/回显完整令牌（契约 §1「不写日志、不回显完整 token」）。
 */
export async function ensureAgentTokenFile({ file = agentTokenFile(), now = () => new Date() } = {}) {
  if (typeof file !== 'string' || !file.trim()) {
    throw invalid('agent token 文件路径不能为空');
  }
  const target = file;

  const existing = await readTokenRecord(target);
  if (existing) {
    // 已存在 = 读回校验通过；不轮换令牌（轮换需要显式的人为动作，不能在启动时悄悄换）。
    return { created: false, file: target, name: existing.name, token: existing.token, scopes: existing.scopes, createdAt: existing.createdAt };
  }

  const record = {
    version: TOKEN_VERSION,
    name: AGENT_TOKEN_NAME,
    token: generateAgentToken(),
    scopes: [...AGENT_TOKEN_SCOPES],
    createdAt: toIsoTimestamp(now),
  };
  await ensurePrivateDirectory(dirname(target));
  await writeTokenAtomically(target, record);

  // 落盘后回读自证：确认写进去的就是刚签发的令牌，且能被正常校验（防止 rename 后被并发覆盖）。
  const written = await readTokenRecord(target);
  if (!written || written.token !== record.token) {
    throw invalid(`agent token 文件写入后回读校验失败：${target}`);
  }
  return { created: true, file: target, name: written.name, token: written.token, scopes: written.scopes, createdAt: written.createdAt };
}

/**
 * 校验请求头里的 Agent 令牌（常量时间比较）。
 *
 * @param {unknown} header `x-circuitpilot-agent-token` 请求头的原始值
 * @param {{token?:string,name?:string,scopes?:string[]}|string|null|undefined} stored
 *   文件读出的记录（readAgentToken 的返回值），也允许直接传 token 字符串。
 * @returns {{ok:true,name:string|null,scopes:string[]}|null} 命中返回身份；其余一律 null，不抛错。
 */
export function verifyAgentToken(header, stored) {
  if (typeof header !== 'string' || !header.startsWith(AGENT_TOKEN_PREFIX)) return null;

  let expected = null;
  let name = null;
  let scopes = [];
  if (typeof stored === 'string') {
    expected = stored;
  } else if (stored && typeof stored === 'object') {
    expected = typeof stored.token === 'string' ? stored.token : null;
    name = typeof stored.name === 'string' ? stored.name : null;
    scopes = Array.isArray(stored.scopes) ? stored.scopes.filter((scope) => typeof scope === 'string') : [];
  }
  if (typeof expected !== 'string' || !expected.startsWith(AGENT_TOKEN_PREFIX)) return null;

  const presented = Buffer.from(header, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  // timingSafeEqual 对长度不等会抛错；"抛错 vs 返回 null"本身就是长度信息，所以先显式判长度。
  if (presented.length !== wanted.length) return null;

  let equal = false;
  try {
    equal = timingSafeEqual(presented, wanted);
  } catch {
    return null;
  }
  if (!equal) return null;
  return { ok: true, name, scopes };
}
