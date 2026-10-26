/**
 * F2：live 证据归档（失败现场 → 统一目录 + 可校验 manifest）。
 *
 * 问题：真机失败时截图/JSON/trace/journal 分散在 `test-results/`、`playwright-report/`、
 * `~/.circuitpilot/automation-runs/`，事后很难证明"当时到底失败成什么样"。
 *
 * 本模块只做**复制 + 哈希 + 清单**：
 *   - 每个源目录整体归档到 outDir 下同名子目录，保留相对路径；
 *   - manifest.json 记录每个文件的 sha256/字节数 + 来源目录 + 缺失来源；
 *   - 缺失来源不静默跳过（missing 字段 + summary），脚本据此用非 0 退出码；
 *   - outDir 若落在某个来源里，跳过该来源避免自我递归复制。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

export const EVIDENCE_ARCHIVE_SCHEMA_VERSION = 1;
const MAX_FILES = 5000;

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function walk(dir, out = [], maxFiles = MAX_FILES) {
  for (const name of readdirSync(dir)) {
    if (out.length >= maxFiles) return out;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) walk(path, out, maxFiles);
    else if (info.isFile()) out.push({ path, bytes: info.size });
  }
  return out;
}

export function archiveEvidence({ sources = [], outDir, runId = null, now = () => new Date(), maxFiles = MAX_FILES } = {}) {
  if (!outDir || typeof outDir !== 'string') throw Object.assign(new Error('归档输出目录不能为空'), { code: 'EVIDENCE_ARCHIVE_OUT_DIR_REQUIRED' });
  const target = resolve(outDir);
  mkdirSync(target, { recursive: true });
  const copied = [];
  const skipped = [];
  const missing = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const sourcePath = resolve(String(source || ''));
    if (!existsSync(sourcePath)) { missing.push({ source: sourcePath, reason: 'NOT_FOUND' }); continue; }
    if (sourcePath === target || sourcePath.startsWith(`${target}${sep}`) || target.startsWith(`${sourcePath}${sep}`)) { skipped.push({ source: sourcePath, reason: 'OUT_DIR_INSIDE_SOURCE' }); continue; }
    const files = statSync(sourcePath).isDirectory() ? walk(sourcePath, [], maxFiles) : [{ path: sourcePath, bytes: statSync(sourcePath).size }];
    const bucket = basename(sourcePath) || 'source';
    for (const file of files.slice(0, maxFiles)) {
      const rel = relative(sourcePath, file.path);
      const destination = join(target, bucket, rel);
      mkdirSync(join(destination, '..'), { recursive: true });
      copyFileSync(file.path, destination);
      copied.push({ source: sourcePath, path: `${bucket}/${rel.split(sep).join('/')}`, bytes: file.bytes, sha256: sha256File(file.path) });
    }
  }
  const manifest = {
    schemaVersion: EVIDENCE_ARCHIVE_SCHEMA_VERSION,
    kind: 'live-evidence-archive',
    runId,
    createdAt: now().toISOString(),
    outDir: target,
    missing,
    skipped,
    files: copied,
    summary: { files: copied.length, missing: missing.length, skipped: skipped.length, bytes: copied.reduce((sum, item) => sum + item.bytes, 0) },
  };
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}
