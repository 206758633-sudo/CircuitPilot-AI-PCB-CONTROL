#!/usr/bin/env node
/**
 * 发布产物清单（P0-02）：给 `tauri build` 之后的交付物做一次"可核对"的盘点。
 *
 * 为什么需要：现在发版靠 `npm run desktop:release` 手工执行，事后无法回答
 * "这次发出去的 DMG 到底是哪个 commit、sha256 多少、有没有更新包 / 签名"。
 * 本脚本把产物信息固化成 JSON，并在发布前/后各校验一次 hash，避免上传错文件。
 *
 * 用法：
 *   node scripts/release-manifest.mjs --build [--out <file>]
 *   node scripts/release-manifest.mjs --verify <manifest.json>
 *
 * 约束：
 *   - 只读产物目录，不移动/不删除文件；
 *   - 没有产物时 `--build` 返回 1（fail closed），不生成"看起来成功"的空清单；
 *   - 签名信息是 best-effort 探测（macOS `codesign`/`spctl`）；探测不到就写 `unknown`，不猜。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIR = 'src-tauri/target/release/bundle';
const PRODUCT = 'CircuitPilot';

export const RELEASE_MANIFEST_SCHEMA = 1;

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function safeSpawn(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch {
    return { ok: false, stdout: '', stderr: '' };
  }
}

/** 探测签名状态：只报告事实，不把"没探测到"写成"已签名"。 */
export function probeSigning(appPath, platform = process.platform) {
  if (platform !== 'darwin' || !appPath || !existsSync(appPath)) return { status: 'unknown', detail: '非 macOS 或无 .app 产物' };
  const codesign = safeSpawn('codesign', ['-dv', '--verbose=2', appPath]);
  const detail = `${codesign.stdout}${codesign.stderr}`;
  const adhoc = /Signature=adhoc/.test(detail);
  const identity = /Authority=Developer ID Application/.test(detail);
  const spctl = safeSpawn('spctl', ['--assess', '--type', 'exec', '--verbose=2', appPath]);
  return {
    status: identity ? 'developer-id' : adhoc ? 'ad-hoc' : codesign.ok ? 'signed' : 'unsigned',
    gatekeeperAccepted: spctl.ok && /accepted/i.test(`${spctl.stdout}${spctl.stderr}`),
    detail: detail.split('\n').filter((line) => /Signature|Authority|TeamIdentifier/.test(line)).join(' | '),
  };
}

const ARTIFACT_KINDS = [
  { kind: 'app', match: (name) => name.endsWith('.app') },
  { kind: 'dmg', match: (name) => name.endsWith('.dmg') },
  // 顺序有意义：`.app.tar.gz.sig` 必须先命中 signature，不能被 updater 包吞掉。
  { kind: 'signature', match: (name) => name.endsWith('.sig') },
  { kind: 'updater-package', match: (name) => name.endsWith('.app.tar.gz') },
];

function walk(dir, acc) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const absolute = join(dir, name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (name.endsWith('.app')) acc.push({ kind: 'app', path: absolute, bytes: null });
      else walk(absolute, acc);
    } else {
      acc.push({ kind: 'file', path: absolute, bytes: stat.size });
    }
  }
  return acc;
}

/** 扫描 bundle 目录，返回产物列表（排序保证清单稳定）。 */
export function collectArtifacts(bundleDir = join(ROOT, BUNDLE_DIR)) {
  const found = walk(bundleDir, []);
  return found
    .map((item) => {
      // 只收交付物；Tauri 打包目录里还有 bundle_dmg.sh / create-dmg 支持文件，不属于发布资产。
      const kind = item.kind === 'app' ? 'app' : ARTIFACT_KINDS.find((entry) => entry.match(basename(item.path)))?.kind ?? null;
      if (!kind) return null;
      if (item.kind === 'app') {
        // .app 是目录：对整个 bundle 做哈希会非常慢且随文件系统变化，这里只记录主二进制。
        const binary = join(item.path, 'Contents', 'MacOS', PRODUCT);
        return {
          kind,
          path: item.path,
          bytes: item.bytes,
          mainBinary: existsSync(binary) ? binary : null,
          sha256: existsSync(binary) ? sha256File(binary) : null,
        };
      }
      return { kind, path: item.path, bytes: item.bytes, sha256: sha256File(item.path) };
    })
    .filter(Boolean)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** 构建清单（纯函数 + 磁盘读取，便于测试）。 */
export function buildReleaseManifest({ root = ROOT, out = null, now = () => new Date(), commit = null } = {}) {
  const bundleDir = join(root, BUNDLE_DIR);
  const artifacts = collectArtifacts(bundleDir);
  if (!artifacts.length) throw Object.assign(new Error(`没有找到发布产物：${bundleDir}（先跑 npm run desktop:release）`), { code: 'ARTIFACTS_MISSING' });
  const tauriConfig = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const versionModule = readFileSync(join(root, 'runtime/version.mjs'), 'utf8');
  const runtimeVersion = /RUNTIME_VERSION\s*=\s*'([^']+)'/.exec(versionModule)?.[1] ?? null;
  const git = commit ?? (safeSpawn('git', ['rev-parse', 'HEAD']).stdout.trim() || null);
  const app = artifacts.find((item) => item.kind === 'app');
  const manifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA,
    product: tauriConfig.productName ?? PRODUCT,
    version: tauriConfig.version ?? null,
    runtimeVersion,
    gitCommit: git,
    createdAt: now().toISOString(),
    platform: process.platform,
    signing: probeSigning(app?.path ?? null),
    artifacts: artifacts.map(({ path, ...rest }) => ({ ...rest, path: path.startsWith(root) ? path.slice(root.length + 1) : path })),
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, serialized, 'utf8');
  }
  return { manifest, serialized, out };
}

/** 校验清单：逐文件核对存在性、大小、sha256；任何不一致都返回 ok=false。 */
export function verifyReleaseManifest(manifestFile, root = ROOT) {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const problems = [];
  for (const artifact of manifest.artifacts ?? []) {
    const absolute = resolve(root, artifact.path);
    if (!existsSync(absolute)) { problems.push({ path: artifact.path, problem: 'MISSING' }); continue; }
    const target = artifact.mainBinary ? resolve(root, artifact.mainBinary.startsWith(root) ? artifact.mainBinary.slice(root.length + 1) : artifact.mainBinary) : absolute;
    if (!existsSync(target)) { problems.push({ path: artifact.path, problem: 'MAIN_BINARY_MISSING' }); continue; }
    if (artifact.bytes !== null && statSync(absolute).isFile() && statSync(absolute).size !== artifact.bytes) {
      problems.push({ path: artifact.path, problem: 'SIZE_MISMATCH', expected: artifact.bytes, actual: statSync(absolute).size });
    }
    if (artifact.sha256) {
      const actual = sha256File(target);
      if (actual !== artifact.sha256) problems.push({ path: artifact.path, problem: 'SHA256_MISMATCH', expected: artifact.sha256, actual });
    }
  }
  return { ok: problems.length === 0, version: manifest.version, artifacts: (manifest.artifacts ?? []).length, problems };
}

function main(argv = process.argv.slice(2)) {
  const verifyIndex = argv.indexOf('--verify');
  if (verifyIndex >= 0) {
    const file = argv[verifyIndex + 1];
    if (!file) { console.error('用法：--verify <manifest.json>'); return 2; }
    try {
      const result = verifyReleaseManifest(resolve(file));
      if (result.ok) {
        console.log(`清单校验通过：${result.artifacts} 个产物，版本 ${result.version}`);
        return 0;
      }
      console.error(`清单校验失败（${result.problems.length} 项）：`);
      for (const problem of result.problems) console.error(`  - ${problem.path}: ${problem.problem}`);
      return 1;
    } catch (error) {
      console.error(`清单读取失败：${error?.message ?? error}`);
      return 2;
    }
  }
  if (argv.includes('--build')) {
    const outIndex = argv.indexOf('--out');
    const out = outIndex >= 0 ? resolve(argv[outIndex + 1]) : join(ROOT, 'artifacts/release/release-manifest.json');
    try {
      const { manifest } = buildReleaseManifest({ out });
      console.log(`清单已生成：${out}`);
      console.log(`  版本 ${manifest.version} · commit ${manifest.gitCommit ?? 'unknown'} · 产物 ${manifest.artifacts.length} 个 · 签名 ${manifest.signing.status}`);
      for (const artifact of manifest.artifacts) console.log(`  - [${artifact.kind}] ${artifact.path}`);
      return 0;
    } catch (error) {
      console.error(`生成清单失败：${error?.code ?? ''} ${error?.message ?? error}`);
      return 1;
    }
  }
  console.error('用法：node scripts/release-manifest.mjs --build [--out <file>] | --verify <manifest.json>');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main();
}
