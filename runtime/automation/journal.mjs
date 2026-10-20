/**
 * 自动化审计日志（Phase 0 内核）。
 *
 * 为什么不是普通日志：自动化是"AI 决定、机器执行"的写入链路，出问题时要能回答
 * "第几步、动作是什么、读回到了什么、谁批准的"。所以每步写一条**哈希链**记录：
 *
 *   hash = sha256(prevHash + JSON.stringify(core))
 *
 * 任何一条被改动/插入/删除，后续 hash 全部对不上。文件是 JSONL，一行一条，
 * 便于 grep 与外部归档；截图只存 sha256（避免把 base64 塞进日志把文件撑爆）。
 *
 * 默认目录：`~/.circuitpilot/automation-runs`（安装后的 App 也可写），
 * 可用 `CIRCUITPILOT_AUTOMATION_DIR` 覆盖；测试用临时目录。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const JOURNAL_SCHEMA_VERSION = 1;

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;

/** runId 会拼进文件名：必须拒绝路径穿越，否则一个 URL 参数就能读写任意文件。 */
function assertRunId(runId) {
  if (!RUN_ID_PATTERN.test(String(runId || ''))) {
    throw Object.assign(new Error(`runId 不合法：${String(runId).slice(0, 80)}`), { code: 'AUTOMATION_JOURNAL_RUN_ID_INVALID' });
  }
  return String(runId);
}

export function sha256Of(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function defaultAutomationDir(env = process.env) {
  return env.CIRCUITPILOT_AUTOMATION_DIR && String(env.CIRCUITPILOT_AUTOMATION_DIR).trim()
    ? String(env.CIRCUITPILOT_AUTOMATION_DIR).trim()
    : join(homedir(), '.circuitpilot', 'automation-runs');
}

/** 创建/打开一个 run 的 JSONL 审计文件。 */
export function createAutomationJournal({ dir = defaultAutomationDir() } = {}) {
  const root = dir;
  const append = (runId, record) => {
    assertRunId(runId);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    const file = join(root, `${runId}.jsonl`);
    const previous = existsSync(file) ? readEntries(file) : [];
    const prevHash = previous.length ? previous[previous.length - 1].hash : '';
    const core = { schemaVersion: JOURNAL_SCHEMA_VERSION, runId, seq: previous.length + 1, ...record };
    const hash = sha256Of(`${prevHash}\n${JSON.stringify(core)}`);
    const entry = { ...core, prevHash, hash };
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  };
  return {
    dir: root,
    pathFor: (runId) => join(root, `${assertRunId(runId)}.jsonl`),
    append,
    read: (runId) => {
      const file = join(root, `${assertRunId(runId)}.jsonl`);
      if (!existsSync(file)) return [];
      return readEntries(file);
    },
    verify: (entries) => verifyChain(entries),
  };
}

function readEntries(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** 校验哈希链；返回第一个断点的序号（便于定位被篡改位置）。 */
export function verifyChain(entries) {
  if (!Array.isArray(entries)) return { ok: false, brokenAt: null, message: '记录不是数组' };
  let prevHash = '';
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const { hash, prevHash: recordedPrev, ...core } = entry;
    if (recordedPrev !== prevHash) return { ok: false, brokenAt: index, message: `第 ${index + 1} 条 prevHash 不匹配（记录被插入/删除）` };
    const expected = sha256Of(`${prevHash}\n${JSON.stringify(core)}`);
    if (hash !== expected) return { ok: false, brokenAt: index, message: `第 ${index + 1} 条 hash 不匹配（内容被改动）` };
    prevHash = hash;
  }
  return { ok: true, brokenAt: null, entries: entries.length, lastHash: prevHash };
}

/**
 * H5：把 journal 目录汇总成诊断包用的有界摘要（只读；目录不存在就明确 unavailable）。
 * 不解析全部历史：只取最近 `limit` 个 run 的尾部记录，避免诊断包变成日志导出。
 */
export function summarizeJournalRuns({ dir = defaultAutomationDir(), limit = 10, lastEntries = 20 } = {}) {
  if (!existsSync(dir)) return { available: false, reason: `journal 目录不存在：${dir}`, runs: [], chainOk: null, lastEntries: [] };
  let files = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch (error) {
    return { available: false, reason: `journal 目录不可读：${error?.message || error}`, runs: [], chainOk: null, lastEntries: [] };
  }
  const runs = [];
  for (const file of files) {
    try {
      const entries = readEntries(join(dir, file));
      if (!entries.length) continue;
      const last = entries[entries.length - 1];
      runs.push({
        runId: String(last.runId || file.replace(/\.jsonl$/, '')).slice(0, 80),
        status: String(last.status ?? last.phase ?? '').slice(0, 40) || 'unknown',
        at: String(last.at ?? last.timestamp ?? '').slice(0, 40) || null,
        entries: entries.length,
        modifiedMs: last.at ? Date.parse(last.at) || 0 : 0,
        _entries: entries,
      });
    } catch { /* 单个坏文件不影响其它 run 的摘要，诊断包不因一份坏文件而失败 */ }
  }
  runs.sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0));
  const picked = runs.slice(0, limit);
  const newest = picked[0];
  let chainOk = null;
  if (newest) {
    const check = verifyChain(newest._entries);
    chainOk = { ok: check.ok, brokenAt: check.brokenAt ?? null, entries: newest._entries.length, lastHash: check.lastHash ?? null };
  }
  return {
    available: true,
    runs: picked.map(({ _entries, modifiedMs, ...run }) => run),
    chainOk,
    lastEntries: newest ? newest._entries.slice(-lastEntries).map((entry) => ({ at: String(entry.at ?? entry.timestamp ?? '').slice(0, 40) || null, step: String(entry.step ?? entry.action ?? '').slice(0, 80) || null, status: String(entry.status ?? '').slice(0, 40) || null, hash: String(entry.hash ?? '').slice(0, 64) || null })) : [],
  };
}
