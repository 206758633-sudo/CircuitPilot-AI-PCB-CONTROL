/**
 * task-28 独立复验公共工具：真实 Runtime 临时实例（createRuntimeServer）、
 * 临时 token/audit/key、JSON-RPC/HTTP 调用、审计链构造与篡改、独立 HMAC 复算。
 *
 * 只写 verification/agent/console/**；不连 4178/EDA，不重启服务，不做 git。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createRuntimeServer } from '../../../runtime/server.mjs';
import { ensureAgentTokenFile, readAgentToken } from '../../../runtime/agent-token.mjs';
import { appendAgentAudit, readAgentAudit } from '../../../runtime/agent-console.mjs';

export const UI_TOKEN = 'ui-verify-token-0123456789abcdef';
export const AGENT_TOKEN_HEADER = 'x-circuitpilot-agent-token';
export const UI_TOKEN_HEADER = 'x-circuitpilot-token';
export const TOKEN_LIKE = /cpa_[0-9a-fA-F]{48}/;

export const ENV_KEYS = Object.freeze([
  'CIRCUITPILOT_STATE_DIR',
  'CIRCUITPILOT_EVIDENCE_DIR',
  'CIRCUITPILOT_AUTOMATION_DIR',
  'CIRCUITPILOT_DOWNLOAD_ROOTS',
  // 这些 env 会覆盖 audit/key/head 的默认路径；测试中强制走临时目录默认规则。
  'CIRCUITPILOT_AGENT_AUDIT_KEY_FILE',
  'CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE',
]);

export const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${String(key).slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};

export const fakeDesign = {
  approve(body) {
    return {
      approvalId: 'approval-verify-1',
      planHash: body?.planHash || 'plan-hash-verify-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      windowId: body?.windowId || 'window-verify',
    };
  },
};

/**
 * 启动真实 Runtime（临时 state 目录 / 临时 token / 临时 audit/key），监听随机回环端口。
 * 默认静默 logger 输出并把控制台输出收集到 session.logs，供泄漏断言。
 */
export async function startConsoleServer(t, { withToken = true, fakeDesign: designImpl = null, downloadRoots = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-agent-console-verify-'));
  const stateDir = join(root, 'state');
  const evidenceDir = join(root, 'evidence');
  const automationDir = join(root, 'automation');
  for (const dir of [stateDir, evidenceDir, automationDir]) mkdirSync(dir, { recursive: true });

  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.CIRCUITPILOT_STATE_DIR = stateDir;
  process.env.CIRCUITPILOT_EVIDENCE_DIR = evidenceDir;
  process.env.CIRCUITPILOT_AUTOMATION_DIR = automationDir;
  delete process.env.CIRCUITPILOT_AGENT_AUDIT_KEY_FILE;
  delete process.env.CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE;
  if (downloadRoots) process.env.CIRCUITPILOT_DOWNLOAD_ROOTS = downloadRoots;

  const logs = [];
  const originalConsole = { info: console.info, warn: console.warn, error: console.error };
  const capture = (level) => (...args) => {
    logs.push(`${level} ${args.map((item) => (typeof item === 'string' ? item : safeStringify(item))).join(' ')}`);
  };
  console.info = capture('info');
  console.warn = capture('warn');
  console.error = capture('error');

  const tokenPath = join(root, 'agent-token.json');
  const auditPath = join(stateDir, 'agent-audit.jsonl');
  const keyFile = join(stateDir, 'agent-audit.key.json');
  const headFile = join(stateDir, 'agent-audit.head.json');

  let issued = null;
  if (withToken) issued = await ensureAgentTokenFile({ file: tokenPath });

  const { server } = createRuntimeServer({
    keychain: fakeKeychain,
    runtimeToken: UI_TOKEN,
    agentTokenPath: tokenPath,
    agentAuditFile: auditPath,
    ...(designImpl ? { design: designImpl } : {}),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  t.after(async () => {
    try {
      server.closeAllConnections?.();
    } catch { /* ignore */ }
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      server.close(done);
      setTimeout(done, 1500).unref?.();
    });
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  const session = {
    root,
    stateDir,
    evidenceDir,
    automationDir,
    tokenPath,
    auditPath,
    keyFile,
    headFile,
    token: issued?.token ?? null,
    base: `http://127.0.0.1:${server.address().port}`,
    logs,
    server,
    uiHeaders: { 'content-type': 'application/json', [UI_TOKEN_HEADER]: UI_TOKEN },
    agentHeaders(extra = {}) {
      return { 'content-type': 'application/json', [AGENT_TOKEN_HEADER]: session.token, ...extra };
    },
    async readToken() {
      return readAgentToken(tokenPath);
    },
    close: async () => {
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return session;
}

export function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** HTTP 调用（Node 原生 fetch；不带 Origin，避免触发浏览器 CORS 分支）。 */
export async function call(session, pathname, { method = 'GET', headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const response = await fetch(`${session.base}${pathname}`, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: response.status, text, json, headers: response.headers };
}

export const ui = (session) => session.uiHeaders;
export const agent = (session, extra = {}) => session.agentHeaders(extra);

/** 等待条件成立（轮询）。 */
export async function waitFor(check, { timeoutMs = 3000, intervalMs = 20, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor 超时：${label}`);
}

/** 审计事件基线条目（append 时会被 sanitize/补 at/kind/actor）。 */
export function auditEvent(overrides = {}) {
  return {
    kind: 'request',
    actor: 'agent',
    agent: 'dsh-plugin',
    method: 'GET',
    path: '/api/project-state',
    outcome: 'accepted',
    status: 200,
    ...overrides,
  };
}

/** 用生产 append 写一条合法链（默认 3 条），返回文件大小与密钥 hex。 */
export async function seedChain(auditPath, keyFile, count = 3, overrides = {}) {
  for (let index = 0; index < count; index += 1) {
    const result = await appendAgentAudit({
      auditFile: auditPath,
      keyFile,
      event: auditEvent({ path: `/api/verify/event-${index}`, ...overrides }),
    });
    if (!result.ok) throw new Error(`seedChain append 失败：${result.code} ${result.message}`);
  }
  return { size: fileSize(auditPath), keyHex: readKeyHex(keyFile) };
}

export function fileSize(file) {
  return existsSync(file) ? statSync(file).size : -1;
}

/** 默认 head 锚点路径（与生产 agentAuditHeadFile 的默认规则一致）。 */
export function headFileFor(auditFile) {
  return join(dirname(auditFile), 'agent-audit.head.json');
}

export function readHeadFile(headFile) {
  return JSON.parse(readFileSync(headFile, 'utf8'));
}

export function writeHeadFile(headFile, head) {
  writeFileSync(headFile, `${JSON.stringify(head)}\n`, { mode: 0o600 });
  chmodSync(headFile, 0o600);
}

export function readKeyHex(keyFile) {
  return JSON.parse(readFileSync(keyFile, 'utf8')).key;
}

export function rawLines(file) {
  const text = readFileSync(file, 'utf8');
  return text.split('\n').filter((line) => line.length > 0);
}

export function writeRawLines(file, lines) {
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

export function parseRawLines(file) {
  return rawLines(file).map((line) => JSON.parse(line));
}

export function writeRawText(file, text) {
  writeFileSync(file, text, 'utf8');
}

export function readRawText(file) {
  return readFileSync(file, 'utf8');
}

export function chmod(file, mode) {
  chmodSync(file, mode);
}

export function fileMode(file) {
  return statSync(file).mode & 0o777;
}

export function fileExists(file) {
  return existsSync(file);
}

/** 独立实现的 canonical JSON（稳定 key 排序；用于独立复算链哈希）。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      if (value[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 独立复算 HMAC-SHA256(key, `${seq}\n${prevHash}\n${canonicalEventJson}`)。 */
export function ownAuditHash(keyHex, seq, prevHash, event) {
  const key = Buffer.from(keyHex, 'hex');
  return createHmac('sha256', key).update(`${seq}\n${prevHash}\n${canonicalJson(event)}`, 'utf8').digest('hex');
}

/** 读取审计文件并做一轮独立结构校验（不依赖生产 readAgentAudit 的结论）。 */
export function inspectChain(auditFile, keyHex) {
  const records = parseRawLines(auditFile);
  const chained = records.filter((record) => record.seq !== undefined || record.hash !== undefined || record.prevHash !== undefined);
  const legacy = records.length - chained.length;
  let expectedSeq = 1;
  let expectedPrev = '0'.repeat(64);
  const issues = [];
  for (const record of chained) {
    if (record.seq !== expectedSeq) issues.push(`seq ${record.seq} != ${expectedSeq}`);
    if (record.prevHash !== expectedPrev) issues.push(`prevHash mismatch at seq ${record.seq}`);
    const event = sanitizeLikeRead(record);
    if (ownAuditHash(keyHex, record.seq, record.prevHash, event) !== record.hash) issues.push(`hash mismatch at seq ${record.seq}`);
    expectedSeq = record.seq + 1;
    expectedPrev = record.hash;
  }
  return { records, chained, legacy, issues };
}

/** 与生产 read 模式字段白名单一致的本地副本（仅用于独立校验）。 */
const READ_FIELDS = ['at', 'kind', 'actor', 'agent', 'method', 'path', 'outcome', 'planHash', 'tool', 'target', 'executionId', 'requestId', 'approvalId', 'note'];

function sanitizeLikeRead(record) {
  const out = {};
  for (const key of READ_FIELDS) if (typeof record[key] === 'string') out[key] = record[key];
  if (Number.isFinite(record.status)) out.status = Math.trunc(record.status);
  return out;
}
