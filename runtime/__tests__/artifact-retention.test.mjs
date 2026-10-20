import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARTIFACT_RETENTION_CODES,
  applyRetention,
  evaluateRetention,
  planRetention,
} from '../artifact-retention.mjs';

const NOW = new Date('2026-10-20T12:00:00.000Z');

test('B10：kind 白名单 + 保留天数裁决，keep/prune/disabled 完整分区', () => {
  const entries = [
    { kind: 'gerber', path: '/release/new.zip', createdAt: '2026-10-20T00:00:00.000Z', bytes: 100 },
    { kind: 'bom', path: '/release/new-bom.csv', createdAt: '2026-10-20T00:00:00.000Z', bytes: 10 },
    { kind: 'gerber', path: '/release/old.zip', savedAt: '2026-09-01T00:00:00.000Z', bytes: 100 },
    { kind: 'bom', path: '/release/old-bom.csv', savedAt: '2026-09-01T00:00:00.000Z', bytes: 10 },
    { kind: 'step', path: '/release/assembled.step', savedAt: '2026-09-01T00:00:00.000Z', bytes: 1000 },
    { kind: 'cpl', path: '/release/no-time.csv', bytes: 10 },
  ];
  const result = evaluateRetention({ entries, now: () => NOW, policy: { kinds: ['gerber', 'bom', 'cpl'], maxAgeDays: 15 } });
  assert.equal(result.kind, 'artifact-retention-evaluation');
  assert.equal(result.evaluatedAt, NOW.toISOString());
  assert.equal(result.keep.length, 2);
  assert.deepEqual(result.prune.map((item) => item.path).sort(), ['/release/old-bom.csv', '/release/old.zip']);
  assert.ok(result.prune.every((item) => item.reason === 'PRUNE_EXPIRED'));
  assert.equal(result.disabled.length, 2, '白名单外的 kind / 无时间戳的条目必须进 disabled 而不是被删');
  assert.equal(result.disabled.find((item) => item.kind === 'step').reason, 'KIND_NOT_IN_POLICY');
  assert.equal(result.disabled.find((item) => item.kind === 'cpl').reason, 'UNKNOWN_TIMESTAMP');
  assert.equal(result.reasons.PRUNE_EXPIRED, 2);
  assert.equal(result.reasons.KIND_NOT_IN_POLICY, 1);
  assert.equal(result.summary.bytesToFree, 110);
  assert.equal(result.summary.entries, 6);
});

test('B10：没有策略 / enabled:false ⇒ 全部 disabled（保留），绝不默认删除', () => {
  const entries = [{ kind: 'gerber', path: '/a.zip', savedAt: '2020-01-01T00:00:00.000Z', bytes: 1 }];
  for (const policy of [null, undefined, { enabled: false }]) {
    const result = evaluateRetention({ entries, now: () => NOW, policy });
    assert.equal(result.prune.length, 0);
    assert.equal(result.keep.length, 0);
    assert.equal(result.disabled.length, 1);
    assert.equal(result.disabled[0].reason, 'RETENTION_DISABLED');
    assert.equal(result.policy.enabled, false);
  }
});

test('B10：总大小预算按"从新到旧"保留，超出预算的旧制造物才进 prune', () => {
  const entries = [
    { kind: 'gerber', path: '/release/a.zip', savedAt: '2026-10-20T00:00:00.000Z', bytes: 400 },
    { kind: 'gerber', path: '/release/b.zip', savedAt: '2026-10-19T00:00:00.000Z', bytes: 400 },
    { kind: 'gerber', path: '/release/c.zip', savedAt: '2026-10-18T00:00:00.000Z', bytes: 400 },
  ];
  const result = evaluateRetention({ entries, now: () => NOW, policy: { maxTotalBytes: 900 } });
  assert.deepEqual(result.keep.map((item) => item.path), ['/release/a.zip', '/release/b.zip']);
  assert.ok(result.keep.every((item) => item.reason === 'KEPT_WITHIN_SIZE_QUOTA'));
  assert.deepEqual(result.prune.map((item) => item.path), ['/release/c.zip']);
  assert.equal(result.prune[0].reason, 'PRUNE_OVER_SIZE_QUOTA');
  assert.equal(result.summary.bytesToFree, 400);

  // 边界：预算恰好等于保留总量时不删
  const exact = evaluateRetention({ entries, now: () => NOW, policy: { maxTotalBytes: 800 } });
  assert.equal(exact.prune.length, 1);
  assert.deepEqual(exact.keep.map((item) => item.path), ['/release/a.zip', '/release/b.zip']);
});

test('B10：有大小预算但存在未知 bytes ⇒ 无法证明删除安全，整批保留（fail-closed）', () => {
  const entries = [
    { kind: 'gerber', path: '/release/a.zip', savedAt: '2026-10-20T00:00:00.000Z', bytes: 800 },
    { kind: 'gerber', path: '/release/unknown.zip', savedAt: '2026-10-19T00:00:00.000Z' },
  ];
  const result = evaluateRetention({ entries, now: () => NOW, policy: { maxTotalBytes: 100 } });
  assert.equal(result.prune.length, 0);
  assert.equal(result.keep.length, 2);
  assert.ok(result.keep.every((item) => item.reason === 'KEPT_SIZE_QUOTA_UNVERIFIABLE'));
  assert.equal(result.reasons.SIZE_QUOTA_UNVERIFIABLE, 1);
});

test('B10：结构噪音与异常时间一律 fail-closed 保留；非法策略/入参抛带 code 的错误', () => {
  const entries = [
    null,
    { path: '/no-kind.zip', savedAt: '2026-10-20T00:00:00.000Z' },
    { kind: 'gerber', path: '/future.zip', savedAt: '2026-10-22T00:00:00.000Z', bytes: 1 },
    { kind: 'gerber', savedAt: '2020-01-01T00:00:00.000Z', bytes: 1 },
  ];
  const result = evaluateRetention({ entries, now: () => NOW, policy: { maxAgeDays: 1 } });
  assert.equal(result.prune.length, 0, '缺 path 的过期条目删不掉，必须退回 disabled');
  assert.equal(result.disabled.filter((item) => item.reason === 'ENTRY_INVALID').length, 2);
  assert.equal(result.disabled.filter((item) => item.reason === 'PATH_MISSING').length, 1);
  assert.equal(result.keep.filter((item) => item.reason === 'KEPT_FUTURE_TIMESTAMP').length, 1);

  assert.throws(() => evaluateRetention({ entries: 'nope', now: () => NOW, policy: {} }), (error) => error.code === ARTIFACT_RETENTION_CODES.ENTRIES_INVALID);
  assert.throws(() => evaluateRetention({ entries: [], now: 'bad-date', policy: {} }), (error) => error.code === ARTIFACT_RETENTION_CODES.NOW_INVALID);
  for (const policy of [{ kinds: 'gerber' }, { kinds: [1] }, { maxAgeDays: 0 }, { maxAgeDays: -3 }, { maxTotalBytes: 1.5 }, { maxTotalBytes: 0 }, { enabled: 'yes' }, 'nope']) {
    assert.throws(() => evaluateRetention({ entries: [], now: () => NOW, policy }), (error) => error.code === ARTIFACT_RETENTION_CODES.POLICY_INVALID, JSON.stringify(policy));
  }
});

test('B10：planRetention 是 dry-run —— 只给 targets，不改动任何条目', () => {
  const entries = [
    { kind: 'gerber', path: '/release/old.zip', savedAt: '2026-09-01T00:00:00.000Z', bytes: 42 },
    { kind: 'gerber', path: '/release/new.zip', savedAt: '2026-10-20T00:00:00.000Z', bytes: 7 },
  ];
  const snapshot = JSON.parse(JSON.stringify(entries));
  const plan = planRetention({ entries, now: () => NOW, policy: { maxAgeDays: 15 } });
  assert.equal(plan.kind, 'artifact-retention-plan');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.safeToApply, true);
  assert.deepEqual(plan.targets, [{ kind: 'gerber', path: '/release/old.zip', bytes: 42, savedAt: '2026-09-01T00:00:00.000Z', reason: 'PRUNE_EXPIRED' }]);
  assert.equal(plan.summary.targets, 1);
  assert.equal(plan.summary.bytesToFree, 42);
  assert.equal(plan.keep.length, 1);
  assert.deepEqual(entries, snapshot, 'planRetention 不得修改入参');
});

test('B10：applyRetention 默认 dry-run；真正删除要显式 dryRun:false + 注入 remove', async () => {
  const plan = planRetention({
    entries: [
      { kind: 'gerber', path: '/release/old.zip', savedAt: '2026-09-01T00:00:00.000Z', bytes: 42 },
      { kind: 'gerber', path: '/release/new.zip', savedAt: '2026-10-20T00:00:00.000Z', bytes: 7 },
    ],
    now: () => NOW,
    policy: { maxAgeDays: 15 },
  });

  const removed = [];
  const dry = await applyRetention({ plan, remove: (path) => removed.push(path) });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.applied.length, 0);
  assert.deepEqual(dry.skipped, [{ path: '/release/old.zip', reason: 'DRY_RUN' }]);
  assert.deepEqual(removed, [], '默认 dry-run 绝不能调用删除');

  const dryByDefault = await applyRetention({ plan });
  assert.equal(dryByDefault.dryRun, true);

  await assert.rejects(applyRetention({ plan, dryRun: false }), (error) => error.code === ARTIFACT_RETENTION_CODES.OPS_REQUIRED);
  await assert.rejects(applyRetention({ plan: { nope: true } }), (error) => error.code === ARTIFACT_RETENTION_CODES.PLAN_INVALID);

  const real = await applyRetention({ plan, dryRun: false, remove: (path) => removed.push(path) });
  assert.equal(real.dryRun, false);
  assert.deepEqual(removed, ['/release/old.zip']);
  assert.deepEqual(real.applied, [{ path: '/release/old.zip', kind: 'gerber', bytes: 42, reason: 'PRUNE_EXPIRED' }]);
  assert.equal(real.removedBytes, 42);
  assert.deepEqual(real.failed, []);
});

test('B10：applyRetention 单点失败不中断整批；重复/缺路径目标跳过而不是误删', async () => {
  const plan = {
    prune: [
      { kind: 'gerber', path: '/release/a.zip', bytes: 1, reason: 'PRUNE_EXPIRED' },
      { kind: 'gerber', path: '/release/broken.zip', bytes: 2, reason: 'PRUNE_EXPIRED' },
      { kind: 'bom', path: '/release/a.zip', bytes: 3, reason: 'PRUNE_OVER_SIZE_QUOTA' },
      { kind: 'cpl', path: null, bytes: 4, reason: 'PRUNE_EXPIRED' },
    ],
  };
  const calls = [];
  const result = await applyRetention({
    plan,
    dryRun: false,
    remove: async (path) => {
      calls.push(path);
      if (path.includes('broken')) throw Object.assign(new Error('磁盘只读'), { code: 'EROFS' });
    },
  });
  assert.deepEqual(calls, ['/release/a.zip', '/release/broken.zip']);
  assert.deepEqual(result.applied.map((item) => item.path), ['/release/a.zip']);
  assert.equal(result.applied[0].bytes, 1, '同一路径只删一次，保留第一次出现的字节数');
  assert.equal(result.failed.length, 2, '一个删除失败 + 一个缺路径，都不能伪装成成功');
  assert.equal(result.failed.filter((item) => item.reason === 'REMOVE_FAILED').length, 1);
  assert.equal(result.failed[0].reason, 'REMOVE_FAILED');
  assert.equal(result.failed[0].code, 'EROFS');
  assert.deepEqual(result.skipped, [{ path: '/release/a.zip', reason: 'DUPLICATE_TARGET' }]);
  assert.equal(result.failed.some((item) => item.reason === 'PATH_MISSING'), true);
});
