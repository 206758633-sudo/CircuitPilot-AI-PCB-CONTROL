import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * WP4 P1-11：统一 EDA 写锁（跨进程文件互斥）。
 *
 * 复审发现“写互斥”只覆盖自动化 run 的单实例锁；HTTP 写路由、导出、自动化之间仍可并发，
 * 两个写动作同时打到桥就可能半写/串板。这里提供与 run 无关的通用文件锁：
 *   - `withEdaWriteLock({dir,key}, fn, {staleMs})` 原子抢锁（`wx` 创建），owner 记 pid/ts/token；
 *   - 冲突抛 `EDA_WRITE_LOCKED`（HTTP 由 server 映射 409），不执行 fn；
 *   - 超过 staleMs 的陈旧锁（进程崩溃/断电留下的）可被接管，避免一次崩溃永久锁死写入口；
 *   - 释放时校验 token，不误删别人（接管者）的锁。
 */
export const EDA_WRITE_LOCK_CODES = Object.freeze({
  LOCKED: 'EDA_WRITE_LOCKED',
  INVALID: 'EDA_WRITE_LOCK_INVALID',
  IO: 'EDA_WRITE_LOCK_IO',
});

const DEFAULT_STALE_MS = 15 * 60 * 1000;

const safeKey = (key) => String(key ?? '')
  .replace(/[^a-zA-Z0-9._-]/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 120) || 'default';

export function edaWriteLockFile({ dir, key } = {}) {
  return join(String(dir ?? ''), `${safeKey(key)}.lock`);
}

const readLockFile = async (file) => {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const lockConflict = (file, existing) => Object.assign(new Error('EDA 写入被另一操作占用（写锁未释放）：请等待当前写操作完成或核对是否卡死'), {
  code: EDA_WRITE_LOCK_CODES.LOCKED,
  status: 409,
  details: {
    lockFile: file,
    owner: {
      pid: existing?.pid ?? null,
      host: existing?.host ?? null,
      at: existing?.at ?? null,
      key: existing?.key ?? null,
      owner: existing?.owner ?? null,
    },
  },
});

/** 只读检查当前锁（给诊断/状态用，不抢锁）。 */
export async function inspectEdaWriteLock({ dir, key, staleMs = DEFAULT_STALE_MS, now = Date.now } = {}) {
  const file = edaWriteLockFile({ dir, key });
  const existing = await readLockFile(file);
  if (!existing) return { locked: false, file, owner: null, stale: false };
  const ts = Number(existing?.ts);
  const ageMs = Number.isFinite(ts) ? Math.max(0, now() - ts) : null;
  return {
    locked: true,
    file,
    owner: existing,
    ageMs,
    stale: ageMs === null || ageMs > staleMs,
  };
}

/**
 * @param {{dir: string, key: string}} target 锁目录 + 资源 key（如 'eda-write' / 'automation-run'）
 * @param {Function} fn 持锁执行体（可异步）
 * @param {{staleMs?: number, now?: () => number, owner?: string}} [options]
 */
export async function withEdaWriteLock({ dir, key } = {}, fn, { staleMs = DEFAULT_STALE_MS, now = Date.now, owner = null } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) {
    throw Object.assign(new Error('EDA 写锁需要 dir'), { code: EDA_WRITE_LOCK_CODES.INVALID, status: 400, details: { dir } });
  }
  if (typeof fn !== 'function') {
    throw Object.assign(new Error('EDA 写锁需要持锁函数'), { code: EDA_WRITE_LOCK_CODES.INVALID, status: 400 });
  }
  const effectiveStaleMs = Number.isFinite(Number(staleMs)) && Number(staleMs) >= 0 ? Number(staleMs) : DEFAULT_STALE_MS;
  const file = edaWriteLockFile({ dir, key });
  const token = randomUUID();
  const meta = {
    pid: process.pid,
    host: process.env.HOSTNAME ?? null,
    token,
    key: safeKey(key),
    owner: owner === null ? null : String(owner).slice(0, 80),
    at: new Date(now()).toISOString(),
    ts: now(),
  };
  await fs.mkdir(dir, { recursive: true });

  let takeoverTried = false;
  for (;;) {
    try {
      await fs.writeFile(file, `${JSON.stringify(meta)}\n`, { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw Object.assign(new Error(`EDA 写锁获取失败：${String(error?.message || error)}`), {
          code: EDA_WRITE_LOCK_CODES.IO,
          status: 500,
          details: { lockFile: file },
        });
      }
      const existing = await readLockFile(file);
      const ts = Number(existing?.ts);
      const ageMs = Number.isFinite(ts) ? now() - ts : null;
      const stale = ageMs === null || ageMs > effectiveStaleMs;
      if (stale && !takeoverTried) {
        // 陈旧锁接管：只删“刚才读到的那把锁”，再重试 wx；并发接管只有一个能成功。
        takeoverTried = true;
        try {
          const current = await readLockFile(file);
          const sameLock = current === null || current?.token === existing?.token;
          if (sameLock) await fs.unlink(file);
        } catch { /* 已被别人接管/删除：直接重试 */ }
        continue;
      }
      throw lockConflict(file, existing);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const current = await readLockFile(file);
      if (current?.token === token) await fs.unlink(file);
    } catch { /* 释放失败不能掩盖 fn 的结果；陈旧锁会由 staleMs 兜底接管 */ }
  }
}
