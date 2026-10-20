import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_KINDS, createEvidenceStore } from '../evidence-store.mjs';

const makeStore = () => createEvidenceStore({ root: mkdtempSync(join(tmpdir(), 'cp-evidence-')) });

test('证据落盘：写入后可读回同一 digest 与 payload，且文件真实存在', () => {
  const store = makeStore();
  const payload = { items: [{ code: 'Clearance', severity: 'blocking' }], reportedCount: 1, truncated: false };
  const entry = store.save({ kind: 'drc-report', payload, fingerprint: { pcbUuid: 'pcb-1' }, note: 'unit' });
  assert.equal(entry.schemaVersion, EVIDENCE_SCHEMA_VERSION);
  assert.match(entry.digest, /^[a-f0-9]{64}$/);
  assert.ok(readFileSync(entry.path, 'utf8').includes(entry.digest));
  const latest = store.latest('drc-report');
  assert.equal(latest.digest, entry.digest);
  assert.deepEqual(latest.payload, payload);
  assert.equal(latest.fingerprint.pcbUuid, 'pcb-1');
  assert.deepEqual(readdirSync(store.dirFor('drc-report')).filter((name) => name.startsWith('.tmp-')), []);
});

test('证据读取 fail-closed：文件被改动后必须抛 EVIDENCE_CORRUPT，而不是返回旧结论', () => {
  const store = makeStore();
  const entry = store.save({ kind: 'dfm-evidence', payload: { passed: true, operator: '测试员' } });
  const raw = JSON.parse(readFileSync(entry.path, 'utf8'));
  raw.payload.passed = false; // 篡改：试图把不通过改成通过
  writeFileSync(entry.path, JSON.stringify(raw), 'utf8');
  assert.throws(() => store.latest('dfm-evidence'), (error) => error.code === 'EVIDENCE_CORRUPT');
});

test('证据读取 fail-closed：未知 schemaVersion 与非法 JSON 都必须报错', () => {
  const store = makeStore();
  const dir = store.dirFor('signoff');
  mkdirSync(dir, { recursive: true });
  const badJson = join(dir, 'signoff-2026-01-01T00-00-00-000Z-aaaaaaaaaaaa.json');
  writeFileSync(badJson, '{not json', 'utf8');
  assert.throws(() => store.latest('signoff'), (error) => error.code === 'EVIDENCE_CORRUPT');
  writeFileSync(badJson, JSON.stringify({ schemaVersion: 999, kind: 'signoff', savedAt: 'x', digest: 'y', payload: {} }), 'utf8');
  assert.throws(() => store.latest('signoff'), (error) => error.code === 'EVIDENCE_CORRUPT');
});

test('latest 按 fingerprint 精确过滤：不同 PCB 的报告不会串用', () => {
  const store = makeStore();
  store.save({ kind: 'drc-report', payload: { items: [], reportedCount: 0 }, fingerprint: { pcbUuid: 'pcb-a' } });
  const wanted = store.save({ kind: 'drc-report', payload: { items: [], reportedCount: 0 }, fingerprint: { pcbUuid: 'pcb-b' } });
  const hit = store.latest('drc-report', { fingerprint: { pcbUuid: 'pcb-b' } });
  assert.equal(hit.digest, wanted.digest);
  assert.equal(store.latest('drc-report', { fingerprint: { pcbUuid: 'pcb-c' } }), null);
});

test('参数校验：未知证据类型/空 payload 一律拒绝', () => {
  const store = makeStore();
  assert.throws(() => store.save({ kind: 'nope', payload: {} }), (error) => error.code === 'EVIDENCE_KIND_INVALID');
  assert.throws(() => store.save({ kind: 'drc-report', payload: null }), (error) => error.code === 'EVIDENCE_PAYLOAD_REQUIRED');
  assert.deepEqual(EVIDENCE_KINDS, ['drc-report', 'dfm-evidence', 'signoff', 'schematic-erc', 'spice-simulation', 'order-confirmation', 'pcb-layer-stack']);
});

test('清理：测试目录可删除（确保 store 不持有句柄）', () => {
  const store = makeStore();
  store.save({ kind: 'drc-report', payload: { items: [] } });
  rmSync(store.root, { recursive: true, force: true });
  assert.equal(store.latest('drc-report'), null);
});
