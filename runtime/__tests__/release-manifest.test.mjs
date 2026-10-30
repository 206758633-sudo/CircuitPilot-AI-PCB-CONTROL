import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildReleaseManifest, collectArtifacts, verifyReleaseManifest } from '../../scripts/release-manifest.mjs';

function makeBundle() {
  const root = mkdtempSync(join(tmpdir(), 'cp-release-manifest-'));
  mkdirSync(join(root, 'runtime'), { recursive: true });
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  writeFileSync(join(root, 'runtime/version.mjs'), "export const RUNTIME_VERSION = '0.2.0';\n", 'utf8');
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ productName: 'CircuitPilot', version: '0.2.0' }), 'utf8');
  const app = join(root, 'src-tauri/target/release/bundle/macos/CircuitPilot.app/Contents/MacOS');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'CircuitPilot'), 'fake-binary-content', 'utf8');
  const dmgDir = join(root, 'src-tauri/target/release/bundle/dmg');
  mkdirSync(dmgDir, { recursive: true });
  writeFileSync(join(dmgDir, 'CircuitPilot_0.2.0_aarch64.dmg'), 'fake-dmg-bytes', 'utf8');
  const macosDir = join(root, 'src-tauri/target/release/bundle/macos');
  writeFileSync(join(macosDir, 'CircuitPilot.app.tar.gz'), 'fake-updater-package', 'utf8');
  writeFileSync(join(macosDir, 'CircuitPilot.app.tar.gz.sig'), 'fake-signature', 'utf8');
  return root;
}

test('collectArtifacts：识别 app/dmg/updater 包/sig，并只对 app 主二进制哈希', () => {
  const root = makeBundle();
  try {
    const artifacts = collectArtifacts(join(root, 'src-tauri/target/release/bundle'));
    const kinds = artifacts.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ['app', 'dmg', 'signature', 'updater-package']);
    const app = artifacts.find((item) => item.kind === 'app');
    assert.match(app.sha256, /^[a-f0-9]{64}$/);
    assert.ok(app.mainBinary.endsWith('Contents/MacOS/CircuitPilot'));
    for (const item of artifacts.filter((entry) => entry.kind !== 'app')) assert.match(item.sha256, /^[a-f0-9]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildReleaseManifest：写清单含版本/commit/产物；verify 通过', () => {
  const root = makeBundle();
  try {
    const out = join(root, 'artifacts/release/release-manifest.json');
    const { manifest } = buildReleaseManifest({ root, out, commit: 'abc1234', now: () => new Date('2026-11-01T00:00:00.000Z') });
    assert.equal(manifest.version, '0.2.0');
    assert.equal(manifest.runtimeVersion, '0.2.0');
    assert.equal(manifest.gitCommit, 'abc1234');
    assert.equal(manifest.artifacts.length, 4);
    assert.equal(manifest.createdAt, '2026-11-01T00:00:00.000Z');
    assert.ok(!manifest.artifacts.some((item) => item.path.includes(root)), '清单里应是相对路径');
    const verified = verifyReleaseManifest(out, root);
    assert.equal(verified.ok, true, JSON.stringify(verified.problems));
    assert.equal(verified.artifacts, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verifyReleaseManifest：篡改/缺失产物会被抓出来（不静默通过）', () => {
  const root = makeBundle();
  try {
    const out = join(root, 'artifacts/release/release-manifest.json');
    buildReleaseManifest({ root, out, commit: 'abc1234' });
    const dmg = join(root, 'src-tauri/target/release/bundle/dmg/CircuitPilot_0.2.0_aarch64.dmg');
    writeFileSync(dmg, 'tampered-dmg-bytes', 'utf8');
    const tampered = verifyReleaseManifest(out, root);
    assert.equal(tampered.ok, false);
    assert.ok(tampered.problems.some((problem) => problem.problem === 'SHA256_MISMATCH'));
    rmSync(dmg);
    const missing = verifyReleaseManifest(out, root);
    assert.equal(missing.ok, false);
    assert.ok(missing.problems.some((problem) => problem.problem === 'MISSING'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildReleaseManifest：没有产物时失败（不生成空清单）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-release-empty-'));
  try {
    mkdirSync(join(root, 'src-tauri'), { recursive: true });
    writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ productName: 'CircuitPilot', version: '0.2.0' }), 'utf8');
    assert.throws(() => buildReleaseManifest({ root, out: join(root, 'x.json') }), /ARTIFACTS_MISSING|没有找到发布产物/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
