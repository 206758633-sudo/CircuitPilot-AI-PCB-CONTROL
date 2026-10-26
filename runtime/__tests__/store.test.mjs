import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJsonStore } from '../store.mjs';
import { ProductionManager } from '../production.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'cp-store-'));

test('JSON 状态：写入后可读回 data/schemaVersion/savedAt，且不留临时文件', () => {
  const root = tempDir();
  const store = createJsonStore({ file: join(root, 'state.json'), schemaVersion: 2, initial: () => ({ empty: true }) });
  assert.deepEqual(store.load().data, { empty: true });
  const saved = store.save({ plans: [['h', { planHash: 'h' }]] });
  assert.equal(saved.schemaVersion, 2);
  assert.ok(saved.savedAt);
  const loaded = store.load();
  assert.equal(loaded.schemaVersion, 2);
  assert.deepEqual(loaded.data.plans, [['h', { planHash: 'h' }]]);
  assert.deepEqual(readdirSync(root).filter((name) => name.includes('.tmp-')), []);
});

test('JSON 状态损坏 → STORE_CORRUPT；schema 不匹配 → STORE_SCHEMA_MISMATCH（fail-closed）', () => {
  const root = tempDir();
  const file = join(root, 'state.json');
  const store = createJsonStore({ file, schemaVersion: 1 });
  writeFileSync(file, '{oops', 'utf8');
  assert.throws(() => store.load(), (error) => error.code === 'STORE_CORRUPT');

  writeFileSync(file, JSON.stringify({ schemaVersion: 99, data: {} }), 'utf8');
  assert.throws(() => store.load(), (error) => error.code === 'STORE_SCHEMA_MISMATCH');

  writeFileSync(file, JSON.stringify({ schemaVersion: 1 }), 'utf8');
  assert.throws(() => store.load(), (error) => error.code === 'STORE_CORRUPT');
});

test('生产管理持久化：重启（新实例）后已登记计划与终审仍在', () => {
  const root = tempDir();
  const file = join(root, 'production.json');
  const store = createJsonStore({ file, schemaVersion: 1, initial: () => ({ plans: [], reviews: [] }) });
  const seeded = store.save({
    plans: [['plan-hash-1', { planHash: 'plan-hash-1', plan: { title: 'x' } }]],
    reviews: [['review-hash-1', { reviewHash: 'review-hash-1', semanticPlanHash: 'plan-hash-1' }]],
  });
  assert.ok(savedFileContains(file, 'plan-hash-1'));

  const manager = new ProductionManager({ artifactsRoot: '/missing', store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ plans: [], reviews: [] }) }) });
  assert.equal(manager.plans.get('plan-hash-1').planHash, 'plan-hash-1');
  assert.equal(manager.reviews.get('review-hash-1').semanticPlanHash, 'plan-hash-1');
});

test('生产管理持久化：normalize 后立即落盘，不是只留在内存', () => {
  const root = tempDir();
  const file = join(root, 'production.json');
  const manager = new ProductionManager({ artifactsRoot: '/missing', store: createJsonStore({ file, schemaVersion: 1, initial: () => ({ plans: [], reviews: [] }) }) });
  const result = manager.normalize({});
  assert.ok(result.planHash);
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.data.plans.length, 1);
  assert.equal(onDisk.data.plans[0][0], result.planHash);
});

const savedFileContains = (file, needle) => readFileSync(file, 'utf8').includes(needle);

test('schema 迁移：旧版本按 migrations 逐级升级，返回 migratedFrom 且不偷偷写盘', () => {
  const root = tempDir();
  const file = join(root, 'state.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, savedAt: '2026-01-01T00:00:00.000Z', data: { items: [{ id: 'a' }] } }), 'utf8');
  const store = createJsonStore({
    file,
    schemaVersion: 3,
    initial: () => ({ items: [], migrated: false }),
    migrations: {
      1: (data) => ({ ...data, items: data.items.map((item) => ({ ...item, qty: item.qty ?? 1 })) }),
      2: (data) => ({ ...data, migrated: true }),
    },
  });
  const loaded = store.load();
  assert.equal(loaded.schemaVersion, 3);
  assert.equal(loaded.migratedFrom, 1);
  assert.equal(loaded.data.migrated, true);
  assert.equal(loaded.data.items[0].qty, 1);
  // load 不应产生副作用：文件仍然是旧版本
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 1);
  // 迁移后 save 写入新版本，再次 load 走正常路径（不再迁移）
  store.save(loaded.data);
  const reloaded = createJsonStore({ file, schemaVersion: 3, migrations: { 1: () => { throw new Error('不应再迁移'); }, 2: () => { throw new Error('不应再迁移'); } } }).load();
  assert.equal(reloaded.schemaVersion, 3);
  assert.equal(reloaded.migratedFrom, undefined);
  assert.equal(reloaded.data.migrated, true);
});

test('schema 迁移：缺迁移函数 → STORE_MIGRATION_MISSING；迁移抛错 → STORE_MIGRATION_FAILED（fail-closed）', () => {
  const root = tempDir();
  const file = join(root, 'state.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, data: {} }), 'utf8');
  assert.throws(
    () => createJsonStore({ file, schemaVersion: 2 }).load(),
    (error) => error.code === 'STORE_MIGRATION_MISSING' && error.details.from === 1 && error.details.to === 2,
  );
  assert.throws(
    () => createJsonStore({ file, schemaVersion: 2, migrations: { 1: () => { throw new Error('bad row'); } } }).load(),
    (error) => error.code === 'STORE_MIGRATION_FAILED' && error.details.cause.includes('bad row'),
  );
  writeFileSync(file, JSON.stringify({ schemaVersion: 5, data: {} }), 'utf8');
  assert.throws(
    () => createJsonStore({ file, schemaVersion: 2 }).load(),
    (error) => error.code === 'STORE_SCHEMA_MISMATCH' && error.details.direction === 'future',
  );
});
