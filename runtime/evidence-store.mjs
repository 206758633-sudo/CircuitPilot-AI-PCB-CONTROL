import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 证据落盘（DRC 报告 / 在线 DFM 回填 / 人工终审）。
 *
 * 为什么需要它：这些证据以前只存在于某个 HTTP 响应或某个页面 state 里——
 * 刷新、重启、换人接手就没了；而"放行"恰恰必须能被第三人复核。
 * 这里把它们变成**带哈希的文件**：
 *   - 每条证据落盘时算 digest（内容 sha256），文件内写全量 payload；
 *   - 写入用 "临时文件 + rename" 原子替换，中途崩溃不留半文件；
 *   - 读取时校验 schemaVersion 与 digest：损坏就抛错（fail-closed），不静默返回空结论。
 *
 * 目录约定（root 下）：
 *   drc-report/  dfm-evidence/  signoff/
 */

export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_KINDS = Object.freeze(['drc-report', 'dfm-evidence', 'signoff', 'schematic-erc', 'spice-simulation', 'order-confirmation', 'pcb-layer-stack']);

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

const digestOf = (value) => createHash('sha256').update(canonical(value)).digest('hex');

const safeName = (kind) => kind.replace(/[^a-z0-9-]/gi, '-');

const code = (message, errorCode, details) => Object.assign(new Error(message), { code: errorCode, details });

/**
 * @param {{ root: string, now?: () => Date }} options
 */
export function createEvidenceStore({ root, now = () => new Date() } = {}) {
  if (!root || typeof root !== 'string') throw code('证据目录不能为空', 'EVIDENCE_ROOT_REQUIRED');

  const dirFor = (kind) => join(root, safeName(kind));

  const ensureDir = (kind) => {
    const dir = dirFor(kind);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  };

  const stamp = (date) => date.toISOString().replace(/[:.]/g, '-');

  /**
   * 落盘一条证据。payload 必须可 JSON 序列化。
   * fingerprint 用于把证据绑定到具体对象（pcbUuid / planHash / manifestHash 等）。
   */
  const save = ({ kind, payload, fingerprint = {}, note = null } = {}) => {
    if (!EVIDENCE_KINDS.includes(kind)) throw code(`未知证据类型：${String(kind)}`, 'EVIDENCE_KIND_INVALID', { allowed: EVIDENCE_KINDS });
    if (payload === undefined || payload === null) throw code('证据内容不能为空', 'EVIDENCE_PAYLOAD_REQUIRED');
    const dir = ensureDir(kind);
    const savedAt = now().toISOString();
    const digest = digestOf({ schemaVersion: EVIDENCE_SCHEMA_VERSION, kind, savedAt, fingerprint, note, payload });
    const entry = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      kind,
      savedAt,
      digest,
      fingerprint: fingerprint && typeof fingerprint === 'object' ? fingerprint : {},
      note: note ?? null,
      payload,
      path: join(dir, `${safeName(kind)}-${stamp(new Date(savedAt))}-${digest.slice(0, 12)}.json`),
    };
    const tempPath = join(dir, `.tmp-${process.pid}-${randomBytes(4).toString('hex')}.json`);
    try {
      writeFileSync(tempPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
      renameSync(tempPath, entry.path);
    } catch (error) {
      try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* 清理失败不掩盖原始错误 */ }
      throw code(`证据写入失败：${String(error?.message || error).slice(0, 160)}`, 'EVIDENCE_WRITE_FAILED', { kind, path: entry.path });
    }
    return entry;
  };

  const verifyEntry = (file, raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw code(`证据文件不是合法 JSON：${file}`, 'EVIDENCE_CORRUPT', { file });
    }
    if (parsed?.schemaVersion !== EVIDENCE_SCHEMA_VERSION) throw code(`证据 schemaVersion 不支持：${file}`, 'EVIDENCE_CORRUPT', { file, schemaVersion: parsed?.schemaVersion ?? null });
    if (!parsed.kind || !parsed.savedAt || !parsed.digest) throw code(`证据文件缺字段：${file}`, 'EVIDENCE_CORRUPT', { file });
    const recomputed = digestOf({ schemaVersion: parsed.schemaVersion, kind: parsed.kind, savedAt: parsed.savedAt, fingerprint: parsed.fingerprint ?? {}, note: parsed.note ?? null, payload: parsed.payload });
    if (recomputed !== parsed.digest) throw code(`证据文件哈希不匹配（可能被改动）：${file}`, 'EVIDENCE_CORRUPT', { file, expected: parsed.digest, actual: recomputed });
    return { ...parsed, path: file };
  };

  /** 列出某类证据（按落盘时间倒序），损坏文件一律抛错而不是跳过。 */
  const list = (kind) => {
    if (!EVIDENCE_KINDS.includes(kind)) throw code(`未知证据类型：${String(kind)}`, 'EVIDENCE_KIND_INVALID', { allowed: EVIDENCE_KINDS });
    const dir = dirFor(kind);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((name) => name.startsWith(`${safeName(kind)}-`) && name.endsWith('.json'))
      .map((name) => join(dir, name))
      .sort((left, right) => (statSync(right).mtimeMs - statSync(left).mtimeMs) || right.localeCompare(left));
    return files.map((file) => verifyEntry(file, readFileSync(file, 'utf8')));
  };

  /**
   * 最近一条证据；可用 fingerprint 精确过滤（例如 pcbUuid 必须一致）。
   * 注意：无证据返回 null，损坏抛 EVIDENCE_CORRUPT——"没有"与"坏了"必须分开。
   */
  const latest = (kind, { fingerprint = null } = {}) => {
    const entries = list(kind);
    if (!fingerprint) return entries[0] ?? null;
    return entries.find((entry) => Object.entries(fingerprint).every(([key, value]) => (entry.fingerprint?.[key] ?? null) === value)) ?? null;
  };

  return { root, save, list, latest, dirFor };
}
