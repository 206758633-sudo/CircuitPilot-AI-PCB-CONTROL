import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { archiveEvidence } from '../evidence-archive.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cp-archive-'));
  const screenshots = join(root, 'screenshots');
  const traces = join(root, 'traces');
  mkdirSync(join(screenshots, 'nested'), { recursive: true });
  mkdirSync(traces, { recursive: true });
  writeFileSync(join(screenshots, 'fail.png'), 'png-bytes');
  writeFileSync(join(screenshots, 'nested', 'page.html'), '<html>fail</html>');
  writeFileSync(join(traces, 'trace.zip'), 'zip-bytes');
  return { root, screenshots, traces, out: join(root, 'archived') };
}

test('F2：完整归档并给每个文件记 sha256/字节数；manifest 可读回', () => {
  const { screenshots, traces, out } = fixture();
  const manifest = archiveEvidence({ sources: [screenshots, traces], outDir: out, runId: 'run-1', now: () => new Date('2026-10-19T12:00:00Z') });
  assert.equal(manifest.kind, 'live-evidence-archive');
  assert.equal(manifest.runId, 'run-1');
  assert.equal(manifest.summary.files, 3);
  assert.equal(manifest.summary.missing, 0);
  const png = manifest.files.find((item) => item.path === 'screenshots/fail.png');
  assert.equal(png.sha256, sha('png-bytes'));
  assert.equal(png.bytes, 9);
  assert.deepEqual(manifest.files.map((item) => item.path).sort(), ['screenshots/fail.png', 'screenshots/nested/page.html', 'traces/trace.zip']);
  const reloaded = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(reloaded, manifest);
});

test('F2：缺失来源不静默跳过（missing + summary 计数）', () => {
  const { screenshots, root, out } = fixture();
  const manifest = archiveEvidence({ sources: [screenshots, join(root, 'nope')], outDir: out });
  assert.equal(manifest.summary.missing, 1);
  assert.equal(manifest.missing[0].reason, 'NOT_FOUND');
  assert.equal(manifest.summary.files, 2);
});

test('F2：outDir 在来源目录里时跳过该来源（不自我递归复制）', () => {
  const { root, screenshots } = fixture();
  const out = join(screenshots, 'archive-out');
  const manifest = archiveEvidence({ sources: [screenshots], outDir: out });
  assert.equal(manifest.summary.files, 0);
  assert.equal(manifest.skipped[0].reason, 'OUT_DIR_INSIDE_SOURCE');
});

test('F2：空来源 ⇒ 0 文件 + manifest 仍写成（由脚本负责非 0 退出，不冒充成功）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-archive-empty-'));
  const manifest = archiveEvidence({ sources: [join(root, 'nothing')], outDir: join(root, 'out') });
  assert.equal(manifest.summary.files, 0);
  assert.equal(manifest.summary.missing, 1);
});

test('F2：脚本在无文件可归档时退出码非 0（CI 不会把空归档当成功）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-archive-script-'));
  const result = spawnSync(process.execPath, ['scripts/archive-live-evidence.mjs', '--out', join(root, 'out'), '--source', join(root, 'missing-source')], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /没有任何文件可归档/);
});
