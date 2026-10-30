#!/usr/bin/env node
// 把当前 Node 运行时作为「受控 sidecar」放进 Tauri 应用包。
//
// 为什么要做这件事：修复前发布的 .app 里虽然有 runtime/server.mjs，但 Node 本身依赖用户机器
// 上恰好装了 node（lib.rs 里去 /usr/local/bin 等固定路径找）。用户没装 Node 时应用直接起不来。
// 打包 Node 后应用自包含，不再依赖宿主机环境。
//
// Tauri 的 externalBin 约定：文件名必须带目标 triple 后缀（node-aarch64-apple-darwin），
// 打包时会被复制到 CircuitPilot.app/Contents/MacOS/node，并由 Tauri 一并签名。
//
// 另外：官方的 macOS node 是 x86_64+arm64 的 universal 二进制（约 240MB），
// 对单一架构的构建用 lipo -thin 减半（约 119MB），避免白白翻倍包体。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const outDir = path.join(root, 'src-tauri', 'binaries');
const manifestPath = path.join(outDir, '.sidecar-manifest.json');

function fail(message) {
  console.error(`[sidecar] ${message}`);
  process.exit(1);
}

function hostTriple() {
  try {
    const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
    const match = /^host:\s*(\S+)$/m.exec(output);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const triple = hostTriple();
if (!triple) fail('无法确定 Rust 目标平台，请先安装 Rust/Cargo 并运行 npm run desktop:check');

// Rust 的目标架构名和 Mach-O 的架构名不完全一致。
const CARGO_ARCH_TO_MACHO = { aarch64: 'arm64', x86_64: 'x86_64' };
const arch = triple.split('-')[0];
const machoArch = CARGO_ARCH_TO_MACHO[arch] ?? arch;
const source = process.execPath;
const target = path.join(outDir, `node-${triple}${process.platform === 'win32' ? '.exe' : ''}`);

const sourceStat = fs.statSync(source);
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
const upToDate = Boolean(manifest)
  && manifest.source === source
  && manifest.sourceSize === sourceStat.size
  && manifest.sourceMtimeMs === Math.trunc(sourceStat.mtimeMs)
  && manifest.triple === triple
  && fs.existsSync(target)
  && fs.statSync(target).size === manifest.targetSize;

if (upToDate && !process.env.CIRCUITPILOT_FORCE_SIDECAR) {
  console.log(`[sidecar] 已是最新：${path.relative(root, target)}（${(manifest.targetSize / 1024 / 1024).toFixed(0)} MB）`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

let method = 'copy';
if (process.platform === 'darwin') {
  let archs = [machoArch];
  try {
    // lipo -info 形如：
    // "Architectures in the fat file: /usr/local/bin/node are: x86_64 arm64"
    // 路径里可能含冒号，所以取最后一个冒号之后的部分。
    const info = execFileSync('lipo', ['-info', source], { encoding: 'utf8' });
    archs = info.split(':').pop().trim().split(/\s+/).filter(Boolean);
  } catch {
    // 非 Mach-O（理论上不会发生）时按原样复制。
  }
  if (archs.length > 1) {
    if (!archs.includes(machoArch)) fail(`当前 Node 是 ${archs.join('+')} 通用二进制，不含目标架构 ${machoArch}`);
    fs.rmSync(target, { force: true });
    execFileSync('lipo', ['-thin', machoArch, '-output', target, source], { stdio: ['ignore', 'ignore', 'inherit'] });
    method = `lipo -thin ${machoArch}`;
  } else {
    fs.copyFileSync(source, target);
  }
} else {
  fs.copyFileSync(source, target);
}
fs.chmodSync(target, 0o755);

// 自检：瘦身后的二进制必须真的能跑，否则问题会拖到用户打开应用时才暴露。
try {
  execFileSync(target, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'ignore', 'inherit'] });
} catch {
  fail(`打包的 Runtime 无法执行：${target}`);
}

const targetSize = fs.statSync(target).size;
fs.writeFileSync(manifestPath, `${JSON.stringify({
  source,
  sourceSize: sourceStat.size,
  sourceMtimeMs: Math.trunc(sourceStat.mtimeMs),
  triple,
  method,
  target: path.relative(root, target),
  targetSize,
  stagedAt: new Date().toISOString(),
}, null, 2)}\n`);

console.log(`[sidecar] ${method} → ${path.relative(root, target)}`);
console.log(`[sidecar] 源 ${(sourceStat.size / 1024 / 1024).toFixed(0)} MB → 打包 ${(targetSize / 1024 / 1024).toFixed(0)} MB（应用安装包会相应增大）`);
