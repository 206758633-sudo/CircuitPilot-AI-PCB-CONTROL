/**
 * 自动化运行单写锁（E7）。
 *
 * 为什么需要：EDA 是单实例 GUI，两个自动化 run 并发时即使各自"读回正确"，
 * 交错写入也会让第二个 run 的读回证据失效。这里分两层：
 *   - 进程内占位（不传 file）：同一线程内快速互斥，向后兼容旧调用方；
 *   - **文件锁（传 file）**：跨进程互斥（多开 runtime / 并行脚本）。用 `open(...,'wx')`
 *     原子创建，锁文件记录 pid/host/token/心跳；崩溃后按"心跳超时 **或** 同机进程已死"
 *     判定陈旧，并**原子接管**（rename 旧锁→临时名，只有成功者获得接管权），接管事件如实暴露；
 *   - 只锁"执行"，读配方/读批准等准备动作不受影响。
 *
 * fail-closed 纪律：
 *   - 锁文件存在但内容读不出来 → 一律视为 busy（不猜"大概可以接管"），返回 unreadable 原因；
 *   - 陈旧接管必须能读到旧持有者信息才允许（接管事件要能追责）；
 *   - 非持有者不能 release/heartbeat，避免旧 run 误放新 run 的锁。
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

const BUSY_CODE = 'EXECUTION_BUSY';

/** 进程是否还活着。跨主机不猜（返回 true，交给 TTL 判定），同机 ESRCH = 已死。 */
function isProcessAlive(pid, host) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (host && host !== hostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM'; // 存在但无权限 → 视为活着
  }
}

function readLockFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.token !== 'string') return { state: null, corrupt: true };
    return { state: parsed, corrupt: false };
  } catch (error) {
    // 文件不存在 = 没有锁（不是"损坏"）；其它读取/解析错误才算损坏。
    if (error?.code === 'ENOENT') return { state: null, corrupt: false };
    return { state: null, corrupt: true, reason: String(error?.message || error).slice(0, 200) };
  }
}

function atomicWrite(file, payload) {
  const temp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(temp, JSON.stringify(payload), 'utf8');
  renameSync(temp, file);
}

function fileLock({ file, now, ttlMs, idFactory, pid, host }) {
  const isStale = (state) => now() - Number(state.heartbeatAt || 0) > ttlMs || !isProcessAlive(Number(state.pid), state.host);

  return {
    tryAcquire({ runId = null, recipeId = null } = {}) {
      mkdirSync(dirname(file), { recursive: true });
      const token = idFactory();
      const record = { token, pid, host, runId, recipeId, acquiredAt: now(), heartbeatAt: now() };
      try {
        const fd = openSync(file, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify(record), 'utf8'); } finally { closeSync(fd); }
        return { ok: true, token, status: { ...record } };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      // 已存在：只有"可读且陈旧"才允许接管，否则一律 busy。
      const first = readLockFile(file);
      if (first.corrupt) return { ok: false, code: BUSY_CODE, status: { unreadable: true, reason: first.reason || '锁文件无法解析，拒绝接管（需人工确认后清理）' } };
      if (!isStale(first.state)) {
        return { ok: false, code: BUSY_CODE, status: { ...first.state, ageMs: now() - Number(first.state.acquiredAt || 0), stale: false, lockFile: file } };
      }
      // 原子接管：把旧锁 rename 走，只有一个进程能成功；成功后写入自己的锁。
      const claim = `${file}.stale.${token}`;
      try {
        renameSync(file, claim);
      } catch {
        return { ok: false, code: BUSY_CODE, status: { unreadable: true, reason: '陈旧锁接管竞争失败（可能被其它进程刚接管），稍后重试', lockFile: file } };
      }
      let staleState = first.state;
      try { staleState = JSON.parse(readFileSync(claim, 'utf8')); } catch { /* 用 first.state */ }
      try { unlinkSync(claim); } catch { /* 清理失败不影响主流程，claim 文件残留会在下一次接管时被覆盖/人工清理 */ }
      atomicWrite(file, record);
      return { ok: true, token, status: { ...record }, staleTakeover: { ...staleState, stale: true } };
    },
    release(token) {
      const current = readLockFile(file);
      if (current.corrupt || !current.state || current.state.token !== token) return { ok: false, reason: current.corrupt ? 'LOCK_UNREADABLE' : 'NOT_OWNER' };
      try { unlinkSync(file); } catch (error) { return { ok: false, reason: String(error?.message || error) }; }
      return { ok: true };
    },
    heartbeat(token) {
      const current = readLockFile(file);
      if (current.corrupt || !current.state || current.state.token !== token) return { ok: false, reason: current.corrupt ? 'LOCK_UNREADABLE' : 'NOT_OWNER' };
      atomicWrite(file, { ...current.state, heartbeatAt: now() });
      return { ok: true, heartbeatAt: now() };
    },
    status() {
      const current = readLockFile(file);
      if (current.corrupt) return { unreadable: true, reason: current.reason || '锁文件无法解析' };
      if (!current.state) return null;
      return { ...current.state, ageMs: now() - Number(current.state.acquiredAt || 0), stale: isStale(current.state), lockFile: file };
    },
  };
}

export function createRunLock({ file = null, now = () => Date.now(), ttlMs = 30 * 60 * 1000, idFactory = () => Math.random().toString(36).slice(2, 10), pid = process.pid, host = hostname() } = {}) {
  if (file) return fileLock({ file, now, ttlMs, idFactory, pid, host });

  let current = null;
  const isStale = () => current !== null && now() - current.heartbeatAt > ttlMs;

  return {
    /** 尝试获取锁：ok:false 时给出当前持锁者信息，绝不排队等待。 */
    tryAcquire({ runId = null, recipeId = null } = {}) {
      if (current && !isStale()) {
        return { ok: false, code: BUSY_CODE, status: { ...current, ageMs: now() - current.acquiredAt, stale: false } };
      }
      if (current && isStale()) {
        // 崩溃恢复：陈旧锁可被接管，但如实记录接管事件（不许悄悄覆盖掩埋异常）。
        const stale = { ...current, stale: true };
        current = null;
        const token = idFactory();
        current = { token, runId, recipeId, acquiredAt: now(), heartbeatAt: now(), staleTakeoverFrom: stale };
        return { ok: true, token, status: { ...current }, staleTakeover: stale };
      }
      const token = idFactory();
      current = { token, runId, recipeId, acquiredAt: now(), heartbeatAt: now() };
      return { ok: true, token, status: { ...current } };
    },
    release(token) {
      if (!current || current.token !== token) return { ok: false, reason: 'NOT_OWNER' };
      current = null;
      return { ok: true };
    },
    heartbeat(token) {
      if (!current || current.token !== token) return { ok: false, reason: 'NOT_OWNER' };
      current.heartbeatAt = now();
      return { ok: true };
    },
    status() { return current ? { ...current, ageMs: now() - current.acquiredAt, stale: isStale() } : null; },
  };
}
