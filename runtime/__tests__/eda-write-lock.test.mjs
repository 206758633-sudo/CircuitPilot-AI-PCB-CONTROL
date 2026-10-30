import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EDA_WRITE_LOCK_CODES, edaWriteLockFile, inspectEdaWriteLock, withEdaWriteLock } from '../eda-write-lock.mjs';

/** WP4 P1-11：统一 EDA 写锁——并发只有一把成功、陈旧锁可接管、释放不误删别人的锁。 */

const makeDir = () => mkdtempSync(join(tmpdir(), 'cp-eda-lock-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('WP4 P1-11：单实例抢锁/释放，lock 文件不残留', async () => {
  const dir = makeDir();
  try {
    const events = [];
    const result = await withEdaWriteLock({ dir, key: 'eda-write' }, async () => {
      events.push('running');
      const lockFile = edaWriteLockFile({ dir, key: 'eda-write' });
      assert.ok(existsSync(lockFile), '持有期间必须有锁文件');
      const owner = JSON.parse(readFileSync(lockFile, 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.equal(typeof owner.token, 'string');
      assert.equal(owner.key, 'eda-write');
      return 'done';
    }, { owner: 'test-owner' });
    assert.equal(result, 'done');
    assert.deepEqual(events, ['running']);
    assert.equal(existsSync(edaWriteLockFile({ dir, key: 'eda-write' })), false, '释放后不得残留锁');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P1-11：并发两把锁只有一把成功，另一把 409 EDA_WRITE_LOCKED', async () => {
  const dir = makeDir();
  try {
    const order = [];
    const first = withEdaWriteLock({ dir, key: 'apply' }, async () => {
      order.push('first-in');
      await sleep(120);
      order.push('first-out');
      return 'first';
    });
    await sleep(20);
    const second = withEdaWriteLock({ dir, key: 'apply' }, async () => {
      order.push('second-in');
      return 'second';
    });
    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[0].value, 'first');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, EDA_WRITE_LOCK_CODES.LOCKED);
    assert.equal(results[1].reason.status, 409);
    assert.equal(results[1].reason.details.owner.pid, process.pid);
    assert.deepEqual(order, ['first-in', 'first-out'], '第二把锁不得执行 fn');
    // 锁释放后可再次获取。
    assert.equal(await withEdaWriteLock({ dir, key: 'apply' }, async () => 'again'), 'again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P1-11：陈旧锁（进程崩溃残留）超过 staleMs 可被接管', async () => {
  const dir = makeDir();
  try {
    const file = edaWriteLockFile({ dir, key: 'stale-key' });
    writeFileSync(file, JSON.stringify({ pid: 999999, host: 'ghost', token: 'dead-token', key: 'stale-key', at: '2026-10-01T00:00:00.000Z', ts: Date.now() - 60 * 60 * 1000, owner: 'ghost' }), 'utf8');
    const before = await inspectEdaWriteLock({ dir, key: 'stale-key', staleMs: 60 * 1000 });
    assert.equal(before.locked, true);
    assert.equal(before.stale, true, '1 小时前的锁必须判定为陈旧');
    const result = await withEdaWriteLock({ dir, key: 'stale-key' }, async () => 'taken-over', { staleMs: 60 * 1000 });
    assert.equal(result, 'taken-over');
    assert.equal(existsSync(file), false, '接管方释放后不残留旧锁');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P1-11：释放校验 token，不误删接管者的锁', async () => {
  const dir = makeDir();
  try {
    const file = edaWriteLockFile({ dir, key: 'token-check' });
    await withEdaWriteLock({ dir, key: 'token-check' }, async () => {
      // 模拟运行中锁被陈旧接管/别人重建：token 已不同。
      writeFileSync(file, JSON.stringify({ pid: 123, token: 'someone-else', key: 'token-check', ts: Date.now() }), 'utf8');
    });
    assert.ok(existsSync(file), 'token 不匹配时不得删除别人的锁');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'someone-else');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P1-11：参数校验（dir/fn 缺失）抛 EDA_WRITE_LOCK_INVALID', async () => {
  await assert.rejects(() => withEdaWriteLock({ dir: '', key: 'x' }, async () => {}), (error) => error.code === EDA_WRITE_LOCK_CODES.INVALID && error.status === 400);
  const dir = makeDir();
  try {
    await assert.rejects(() => withEdaWriteLock({ dir, key: 'x' }, 'not-a-function'), (error) => error.code === EDA_WRITE_LOCK_CODES.INVALID && error.status === 400);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
