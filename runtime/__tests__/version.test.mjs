import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RUNTIME_VERSION } from '../version.mjs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

// 修复前同一个项目里有四个互相不一致的版本声明：
// package.json 0.1.0 · tauri.conf.json 0.2.0 · Cargo.toml 0.2.0 · server.mjs 硬编码 0.6.1。
// 其中 0.6.1 还会通过 /api/health 返回给前端并显示在界面上，属于对用户可见的错误信息。
test('版本号在所有声明位置保持一致（单一数据源 runtime/version.mjs）', () => {
  const packageJson = JSON.parse(read('../../package.json'));
  const tauriConfig = JSON.parse(read('../../src-tauri/tauri.conf.json'));
  const cargoToml = read('../../src-tauri/Cargo.toml');
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];

  assert.match(RUNTIME_VERSION, /^\d+\.\d+\.\d+$/, 'runtime/version.mjs 必须是语义化版本');
  assert.equal(packageJson.version, RUNTIME_VERSION, 'package.json 版本与 runtime/version.mjs 不一致');
  assert.equal(tauriConfig.version, RUNTIME_VERSION, 'src-tauri/tauri.conf.json 版本与 runtime/version.mjs 不一致');
  assert.equal(cargoVersion, RUNTIME_VERSION, 'src-tauri/Cargo.toml 版本与 runtime/version.mjs 不一致');
});

test('Runtime 不再硬编码版本号，/api/health 使用单一数据源', () => {
  const server = read('../server.mjs');
  assert.match(server, /version: RUNTIME_VERSION/, 'server.mjs 应从 runtime/version.mjs 取版本');
  assert.doesNotMatch(server, /version: '\d+\.\d+\.\d+'/, 'server.mjs 不应再出现硬编码版本号');
});
