import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  EVIDENCE_INDEX_CODES,
  buildEvidenceIndex,
  findEvidence,
  planEvidenceRetention,
} from '../evidence-index.mjs';

const NOW = new Date('2026-10-20T12:00:00.000Z');

function evidenceDoc({ kind = 'drc-report', digest, savedAt, fingerprint = { jobId: 'job-1', pcbUuid: null }, note = null } = {}) {
  return { schemaVersion: 1, kind, savedAt, digest, fingerprint, note, payload: { report: { ok: true } }, path: '/ignored/inside-file.json' };
}

function writeEvidence(root, kind, name, document) {
  const dir = join(root, kind);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(document, null, 2), 'utf8');
  return path;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cp-evidence-index-'));
  const newest = writeEvidence(root, 'drc-report', 'drc-newest.json', evidenceDoc({ digest: 'a'.repeat(64), savedAt: '2026-10-20T10:00:00.000Z' }));
  writeEvidence(root, 'drc-report', 'drc-older.json', evidenceDoc({ digest: 'b'.repeat(64), savedAt: '2026-10-19T10:00:00.000Z' }));
  const dfm = writeEvidence(root, 'dfm-evidence', 'dfm.json', evidenceDoc({ kind: 'dfm-evidence', digest: 'c'.repeat(64), savedAt: '2026-10-18T10:00:00.000Z', fingerprint: { planHash: 'p1' }, note: 'dfm 回填' }));
  return { root, newest, dfm };
}

function injected({ root }) {
  const calls = { readFile: 0, readdir: 0 };
  const readFile = (path) => { calls.readFile += 1; return readFileSync(path, 'utf8'); };
  const readdir = (dir) => { calls.readdir += 1; return readdirSync(dir, { withFileTypes: true }); };
  return { calls, readFile, readdir };
}

test('C5：扫描证据目录生成索引（注入 readFile/readdir，索引只保留头字段，按时间倒序）', () => {
  const { root, newest } = fixture();
  try {
    const { calls, readFile, readdir } = injected({ root });
    const index = buildEvidenceIndex({ dirs: [root], now: () => NOW, readFile, readdir });
    assert.equal(index.kind, 'evidence-index');
    assert.equal(index.schemaVersion, 1);
    assert.equal(index.generatedAt, NOW.toISOString());
    assert.equal(index.complete, true);
    assert.equal(index.truncated, false);
    assert.deepEqual(index.errors, []);
    assert.deepEqual(index.invalid, []);
    assert.equal(index.entries.length, 3);
    assert.deepEqual(index.summary.kinds, { 'drc-report': 2, 'dfm-evidence': 1 });
    assert.equal(index.summary.newestSavedAt, '2026-10-20T10:00:00.000Z');
    assert.equal(index.summary.oldestSavedAt, '2026-10-18T10:00:00.000Z');
    assert.ok(calls.readFile >= 3 && calls.readdir >= 1, '必须真的走了注入的读写函数');

    const [first, second, third] = index.entries;
    assert.equal(first.savedAtMs, Date.parse('2026-10-20T10:00:00.000Z'));
    assert.ok(first.savedAtMs > second.savedAtMs && second.savedAtMs > third.savedAtMs, '必须按 savedAt 倒序');
    assert.equal(index.entries[0].path, newest);
    assert.equal(first.kind, 'drc-report');
    assert.equal(first.digest, 'a'.repeat(64));
    assert.deepEqual(first.fingerprint, { jobId: 'job-1', pcbUuid: null });
    // 索引只保留头字段：payload 绝不进入索引（真实 DRC payload 可达几十 MB）
    assert.equal(Object.hasOwn(first, 'payload'), false);
    assert.equal(index.entries.find((entry) => entry.kind === 'dfm-evidence').note, 'dfm 回填');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C5：损坏/缺字段/指纹非法的证据进 invalid（不静默跳过，也不参与删除候选）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-evidence-index-bad-'));
  try {
    const dir = join(root, 'drc-report');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{not-json', 'utf8');
    writeFileSync(join(dir, 'missing-digest.json'), JSON.stringify({ kind: 'drc-report', savedAt: '2026-10-19T00:00:00.000Z', fingerprint: {} }), 'utf8');
    writeFileSync(join(dir, 'bad-fingerprint.json'), JSON.stringify({ kind: 'drc-report', savedAt: '2026-10-19T00:00:00.000Z', digest: 'd'.repeat(64), fingerprint: 'not-an-object' }), 'utf8');
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(evidenceDoc({ digest: 'e'.repeat(64), savedAt: '2026-10-20T00:00:00.000Z' })), 'utf8');

    const index = buildEvidenceIndex({ dirs: [root], now: () => NOW });
    assert.equal(index.entries.length, 1);
    assert.equal(index.invalid.length, 3);
    assert.deepEqual(index.invalid.map((item) => item.reason).sort(), ['FINGERPRINT_INVALID', 'MISSING_FIELDS', 'PARSE_ERROR']);
    for (const item of index.invalid) assert.equal(item.code, EVIDENCE_INDEX_CODES.CORRUPT);

    const plan = planEvidenceRetention({ index, now: () => NOW, keepPerKind: 1, keepDays: 1 });
    assert.equal(plan.safeToApply, false, '有被隔离文件时计划不得被当成可执行结论');
    assert.ok(plan.blockedReasons.includes('UNINDEXED_EVIDENCE_PRESENT'));
    assert.equal(plan.unindexed.length, 3);
    // 损坏文件不进 prune：不知道年龄就不删
    assert.equal(plan.prune.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C5：目录不存在 ⇒ errors + complete:false；单个 .json 文件也能直接索引', () => {
  const { root, newest } = fixture();
  try {
    const missing = join(root, 'does-not-exist');
    const index = buildEvidenceIndex({ dirs: [missing], now: () => NOW });
    assert.equal(index.entries.length, 0);
    assert.equal(index.errors.length, 1);
    assert.equal(index.errors[0].reason, 'NOT_FOUND');
    assert.equal(index.complete, false);

    const plan = planEvidenceRetention({ index, now: () => NOW });
    assert.equal(plan.safeToApply, false);
    assert.deepEqual(plan.blockedReasons, ['INDEX_INCOMPLETE']);
    assert.equal(plan.prune.length, 0);

    // dirs 里直接给文件路径：只索引这一个文件（用于"已知 digest 想核对"的场景）
    const single = buildEvidenceIndex({ dirs: [newest], now: () => NOW });
    assert.equal(single.entries.length, 1);
    assert.equal(single.entries[0].digest, 'a'.repeat(64));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C5：同一 kind+digest 的重复文件只索引最新一份，旧副本进 duplicates 不自动清理', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-evidence-index-dup-'));
  try {
    const digest = 'f'.repeat(64);
    const older = writeEvidence(root, 'signoff', 'signoff-old.json', evidenceDoc({ kind: 'signoff', digest, savedAt: '2026-10-01T00:00:00.000Z' }));
    const newer = writeEvidence(root, 'signoff', 'signoff-new.json', evidenceDoc({ kind: 'signoff', digest, savedAt: '2026-10-10T00:00:00.000Z' }));
    const index = buildEvidenceIndex({ dirs: [root], now: () => NOW });
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].path, newer);
    assert.equal(index.duplicates.length, 1);
    assert.equal(index.duplicates[0].reason, 'DUPLICATE_DIGEST');
    assert.equal(index.duplicates[0].path, older);
    // 重复副本仍在磁盘上：索引只负责"看见"，不负责"清理"
    assert.equal(existsSync(older), true);
    assert.equal(existsSync(newer), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C5：findEvidence 精确按 kind/digest 找回；找不到返回 null；非法查询抛带 code 的错误', () => {
  const { root } = fixture();
  try {
    const index = buildEvidenceIndex({ dirs: [root], now: () => NOW });
    const byDigest = findEvidence(index, { kind: 'drc-report', digest: 'A'.repeat(64) });
    assert.equal(byDigest.digest, 'a'.repeat(64), 'digest 比较应忽略大小写');
    assert.equal(byDigest.kind, 'drc-report');

    const newestOfKind = findEvidence(index, { kind: 'drc-report' });
    assert.equal(newestOfKind.savedAt, '2026-10-20T10:00:00.000Z');

    assert.equal(findEvidence(index, { kind: 'drc-report', digest: '0'.repeat(64) }), null);
    assert.equal(findEvidence(index, { kind: 'schematic-erc' }), null);
    assert.throws(() => findEvidence(index, {}), (error) => error.code === EVIDENCE_INDEX_CODES.QUERY_INVALID);
    assert.throws(() => findEvidence({ wrong: true }, { kind: 'drc-report' }), (error) => error.code === EVIDENCE_INDEX_CODES.INDEX_INVALID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C5：保留计划 dry-run —— 同时超出"每类条数"和"保留天数"才进 prune，且绝不删文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-evidence-index-plan-'));
  try {
    const stamped = ['2026-10-20', '2026-10-19', '2026-10-15', '2026-10-01', '2026-09-01'];
    const paths = stamped.map((day, position) => writeEvidence(root, 'drc-report', `drc-${position}.json`, evidenceDoc({
      digest: `${position}`.repeat(64).slice(0, 64),
      savedAt: `${day}T00:00:00.000Z`,
    })));
    writeEvidence(root, 'dfm-evidence', 'dfm.json', evidenceDoc({ kind: 'dfm-evidence', digest: '9'.repeat(64), savedAt: '2026-08-01T00:00:00.000Z' }));

    const index = buildEvidenceIndex({ dirs: [root], now: () => NOW });
    const plan = planEvidenceRetention({ index, now: () => NOW, keepPerKind: 2, keepDays: 10 });
    assert.equal(plan.kind, 'evidence-retention-plan');
    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.policy, { keepPerKind: 2, keepDays: 10 });
    assert.equal(plan.safeToApply, true);
    // drc：前 2 条按条数保留；10-15 未超 10 天保留；10-01/09-01 才可删
    assert.deepEqual(plan.prune.map((item) => item.savedAt).sort(), ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
    assert.ok(plan.prune.every((item) => item.reason === 'PRUNE_EXPIRED'));
    // dfm 虽然很旧，但它是该 kind 唯一一条（在条数窗口内）⇒ 必须保留
    const dfmKeep = plan.keep.find((item) => item.kind === 'dfm-evidence');
    assert.equal(dfmKeep.reason, 'KEPT_RECENT_COUNT');
    assert.equal(plan.reasons.PRUNE_EXPIRED, 2);
    assert.equal(plan.summary.indexed, 6);
    assert.equal(plan.summary.keep, 4);
    assert.equal(plan.summary.prune, 2);

    // dry-run 语义：计划生成后所有文件都还在（本模块没有任何删除能力）
    for (const path of paths) assert.equal(existsSync(path), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C5：fail-closed —— 未来时间戳/未知年龄保留；非法策略抛带 code 的错误', () => {
  const base = {
    complete: true,
    entries: [
      { kind: 'drc-report', digest: '1'.repeat(64), savedAt: '2026-10-21T00:00:00.000Z', savedAtMs: Date.parse('2026-10-21T00:00:00.000Z'), path: '/future.json', fingerprint: {} },
      { kind: 'drc-report', digest: '2'.repeat(64), savedAt: null, savedAtMs: null, path: '/unknown.json', fingerprint: {} },
    ],
    invalid: [],
    duplicates: [],
  };
  const plan = planEvidenceRetention({ index: base, now: () => NOW, keepPerKind: 1, keepDays: 1 });
  assert.equal(plan.prune.length, 0, '未来/未知年龄的证据一律保留');
  assert.ok(plan.keep.some((item) => item.reason === 'KEPT_FUTURE_SAVED_AT'));
  assert.ok(plan.keep.some((item) => item.reason === 'UNKNOWN_SAVED_AT'));

  assert.throws(() => planEvidenceRetention({ index: base, now: () => NOW, keepPerKind: 0 }), (error) => error.code === EVIDENCE_INDEX_CODES.POLICY_INVALID);
  assert.throws(() => planEvidenceRetention({ index: base, now: () => NOW, keepDays: -1 }), (error) => error.code === EVIDENCE_INDEX_CODES.POLICY_INVALID);
  assert.throws(() => planEvidenceRetention({ index: base, now: 'not-a-date' }), (error) => error.code === EVIDENCE_INDEX_CODES.POLICY_INVALID);
  assert.throws(() => planEvidenceRetention({ index: { entries: 'nope' } }), (error) => error.code === EVIDENCE_INDEX_CODES.INDEX_INVALID);
});
