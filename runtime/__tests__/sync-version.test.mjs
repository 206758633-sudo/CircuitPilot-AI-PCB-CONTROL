import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyVersionSync, planVersionSync, readSourceVersion } from '../../scripts/sync-version.mjs';

function makeRepo(version = '0.2.0', overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-sync-version-'));
  mkdirSync(join(root, 'runtime'), { recursive: true });
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  writeFileSync(join(root, 'runtime/version.mjs'), `export const RUNTIME_VERSION = '${version}';\n`, 'utf8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: overrides.packageJson ?? version, scripts: { build: 'vite build' } }, null, 2) + '\n', 'utf8');
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ productName: 'CircuitPilot', version: overrides.tauri ?? version }, null, 2) + '\n', 'utf8');
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), `[package]\nname = "circuitpilot"\nversion = "${overrides.cargo ?? version}"\nedition = "2021"\n\n[dependencies]\ntauri = { version = "2", features = [] }\n`, 'utf8');
  return root;
}

test('真实仓库：版本号四处一致（CI 前置门禁）', () => {
  const plan = planVersionSync();
  assert.equal(plan.ok, true, `不一致：${JSON.stringify(plan.mismatches)}`);
  assert.equal(plan.version, readSourceVersion());
});

test('planVersionSync：只读、能列出全部不一致的目标', () => {
  const root = makeRepo('0.3.0', { packageJson: '0.2.0', cargo: '0.1.0' });
  try {
    const plan = planVersionSync(root);
    assert.equal(plan.version, '0.3.0');
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.mismatches.map((item) => item.file), ['package.json', 'src-tauri/Cargo.toml']);
    // 只读：文件内容不变
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.2.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyVersionSync：同步三处且不破坏其它字段/依赖行', () => {
  const root = makeRepo('0.3.0', { packageJson: '0.2.0', tauri: '0.2.1', cargo: '0.1.0' });
  try {
    const result = applyVersionSync(root);
    assert.equal(result.version, '0.3.0');
    assert.deepEqual(result.changed.sort(), ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json']);
    assert.equal(result.ok, true);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '0.3.0');
    assert.deepEqual(pkg.scripts, { build: 'vite build' });
    const tauri = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(tauri.version, '0.3.0');
    assert.equal(tauri.productName, 'CircuitPilot');
    const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
    assert.match(cargo, /^version = "0\.3\.0"$/m);
    assert.ok(cargo.includes('tauri = { version = "2", features = [] }'), '依赖行不能被改写');
    // 幂等：第二次没有变化
    assert.deepEqual(applyVersionSync(root).changed, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('缺少/非法源版本号 → VERSION_SOURCE_INVALID（fail closed）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-sync-version-bad-'));
  try {
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(join(root, 'runtime/version.mjs'), 'export const RUNTIME_VERSION = "";\n', 'utf8');
    assert.throws(() => readSourceVersion(root), /VERSION_SOURCE_INVALID|找不到/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
