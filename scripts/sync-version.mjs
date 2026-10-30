#!/usr/bin/env node
/**
 * 版本号单一数据源同步（P0-01）。
 *
 * 现状：同一个版本号要手写四处——`runtime/version.mjs`（运行时与 /api/health 的数据源）、
 * `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。
 * 发版时漏改一处，会出现"更新到了但版本号没变 / 安装包版本和 UI 显示不一致"。
 * 本脚本把 `runtime/version.mjs` 当唯一来源，其余三处只做检查或同步。
 *
 * 用法：
 *   node scripts/sync-version.mjs --check    # 只检查，不一致退出码 1（CI 用）
 *   node scripts/sync-version.mjs --sync     # 把其余三处改写成源版本
 *
 * 设计约束：
 *   - `--check` 永不写文件；`--sync` 只在版本不同时写，且保持原文件缩进/换行风格；
 *   - 只改版本字段，不重排 JSON 字段、不碰其它配置；
 *   - 不改 `runtime/version.mjs` 本身（否则就不是单一数据源了）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION_SOURCE = 'runtime/version.mjs';
export const VERSION_TARGETS = Object.freeze([
  { file: 'package.json', kind: 'json' },
  { file: 'src-tauri/tauri.conf.json', kind: 'json' },
  { file: 'src-tauri/Cargo.toml', kind: 'cargo' },
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_PATTERN = /RUNTIME_VERSION\s*=\s*'([^']+)'/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 读取唯一数据源里的版本号；文件缺失或格式不对直接抛错（fail closed）。 */
export function readSourceVersion(root = ROOT) {
  const text = readFileSync(join(root, VERSION_SOURCE), 'utf8');
  const version = VERSION_PATTERN.exec(text)?.[1];
  if (!version) throw Object.assign(new Error(`${VERSION_SOURCE} 里找不到 RUNTIME_VERSION`), { code: 'VERSION_SOURCE_INVALID' });
  if (!SEMVER_PATTERN.test(version)) throw Object.assign(new Error(`版本号不是合法 semver：${version}`), { code: 'VERSION_SOURCE_INVALID' });
  return version;
}

/** 读取三处目标声明的当前值（只读，不写）。 */
export function readTargetVersions(root = ROOT) {
  return VERSION_TARGETS.map(({ file, kind }) => {
    const absolute = join(root, file);
    const text = readFileSync(absolute, 'utf8');
    if (kind === 'json') {
      const json = JSON.parse(text);
      return { file, version: typeof json.version === 'string' ? json.version : null };
    }
    const version = /^version\s*=\s*"([^"]*)"/m.exec(text)?.[1] ?? null;
    return { file, version };
  });
}

/** 计算"源版本 vs 目标声明"的差异（纯函数，便于测试）。 */
export function planVersionSync(root = ROOT) {
  const version = readSourceVersion(root);
  const targets = readTargetVersions(root);
  return {
    version,
    targets,
    mismatches: targets.filter((target) => target.version !== version),
    ok: targets.every((target) => target.version === version),
  };
}

/** 把三处目标改写成源版本；返回真正被改写的文件列表。 */
export function applyVersionSync(root = ROOT) {
  const plan = planVersionSync(root);
  const changed = [];
  for (const { file, kind } of VERSION_TARGETS) {
    const current = plan.targets.find((target) => target.file === file);
    if (!current || current.version === plan.version) continue;
    const absolute = join(root, file);
    const text = readFileSync(absolute, 'utf8');
    if (kind === 'json') {
      const json = JSON.parse(text);
      json.version = plan.version;
      writeFileSync(absolute, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    } else {
      writeFileSync(absolute, text.replace(/^version\s*=\s*"[^"]*"/m, `version = "${plan.version}"`), 'utf8');
    }
    changed.push(file);
  }
  return { version: plan.version, changed, ok: planVersionSync(root).ok };
}

export function main(argv = process.argv.slice(2)) {
  const sync = argv.includes('--sync');
  const check = argv.includes('--check');
  if (!sync && !check) {
    console.error('用法：node scripts/sync-version.mjs --check | --sync');
    return 2;
  }
  try {
    if (sync) {
      const result = applyVersionSync();
      console.log(result.changed.length
        ? `已同步版本 ${result.version}：${result.changed.join('、')}`
        : `版本已一致（${result.version}），无需改动`);
      return result.ok ? 0 : 1;
    }
    const plan = planVersionSync();
    if (plan.ok) {
      console.log(`版本一致：${plan.version}（${VERSION_SOURCE} / package.json / tauri.conf.json / Cargo.toml）`);
      return 0;
    }
    console.error(`版本不一致：源 ${VERSION_SOURCE} = ${plan.version}`);
    for (const target of plan.mismatches) console.error(`  - ${target.file} = ${target.version ?? '(缺失)'}`);
    console.error('修复：node scripts/sync-version.mjs --sync');
    return 1;
  } catch (error) {
    console.error(`版本检查失败：${error?.code ?? ''} ${error?.message ?? error}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main();
}
