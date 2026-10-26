import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceStore } from '../evidence-store.mjs';
import { planRetention, pruneEvidenceStore } from '../evidence-retention.mjs';

const makeEntry = (savedAt) => ({ savedAt, path: `/tmp/x-${savedAt}.json` });
const now = Date.parse('2026-10-21T00:00:00.000Z');

test('保留计划：超出条数只清理最旧的，并永远保留最近 minKeep 条', () => {
  const entries = Array.from({ length: 5 }, (_, index) => makeEntry(`2026-10-2${index}T00:00:00.000Z`));
  const plan = planRetention(entries, { maxCount: 3, minKeep: 2, now });
  assert.equal(plan.keep.length, 3);
  assert.equal(plan.prune.length, 2);
  assert.match(plan.prune[0].reason, /超出保留条数/);
  // 计划之外的条目即使超龄，若在 minKeep 内也保留
  const old = Array.from({ length: 3 }, (_, index) => makeEntry(`2025-01-0${index + 1}T00:00:00.000Z`));
  const plan2 = planRetention(old, { maxAgeMs: 30 * 86_400_000, maxCount: 100, minKeep: 2, now });
  assert.equal(plan2.keep.length, 2);
  assert.equal(plan2.prune.length, 1);
});

test('清理：dryRun 只报告不删文件；真实清理会删掉计划内文件并保留其余', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-evidence-retention-'));
  try {
    const store = createEvidenceStore({ root });
    const saved = ['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z', '2026-10-04T00:00:00.000Z']
      .map((savedAt) => store.save({ kind: 'drc-report', payload: { n: savedAt }, fingerprint: { pcbUuid: 'u1' } }));
    const dry = pruneEvidenceStore({ store, kind: 'drc-report', maxCount: 2, minKeep: 1, dryRun: true });
    assert.equal(dry.pruned, 2);
    assert.equal(readdirSync(store.dirFor('drc-report')).filter((name) => name.endsWith('.json')).length, 4);
    const real = pruneEvidenceStore({ store, kind: 'drc-report', maxCount: 2, minKeep: 1 });
    assert.equal(real.pruned, 2);
    assert.equal(real.kept, 2);
    const remaining = readdirSync(store.dirFor('drc-report')).filter((name) => name.endsWith('.json'));
    assert.equal(remaining.length, 2);
    for (const file of remaining) assert.ok(existsSync(join(store.dirFor('drc-report'), file)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
