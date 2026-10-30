#!/usr/bin/env node
/**
 * F2：真机/live 失败现场一键归档。
 *
 * 用法：
 *   node scripts/archive-live-evidence.mjs
 *   node scripts/archive-live-evidence.mjs --run-id 2026-10-19T12-00-00Z --out artifacts/live-evidence/run-1
 *   node scripts/archive-live-evidence.mjs --source test-results --source ~/.circuitpilot/automation-runs
 *
 * 默认来源：playwright-report/、test-results/、自动化 journal 目录（~/.circuitpilot/automation-runs 或
 * CIRCUITPILOT_AUTOMATION_DIR）、artifacts/acceptance/。都归档到 artifacts/live-evidence/<runId>/，
 * 并生成 manifest.json（每个文件 sha256 + 缺失来源）。一条文件都没归档时退出码 2——
 * "归档成功"必须真的有文件，不能空目录报 success。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultAutomationDir } from '../runtime/automation/journal.mjs';
import { archiveEvidence } from '../runtime/evidence-archive.mjs';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const readFlag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};
const sources = [];
for (let index = 0; index < argv.length; index += 1) if (argv[index] === '--source') sources.push(argv[index + 1]);
const runId = readFlag('--run-id') || new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(readFlag('--out') || join(ROOT, 'artifacts/live-evidence', runId));
const defaultSources = [
  join(ROOT, 'playwright-report'),
  join(ROOT, 'test-results'),
  defaultAutomationDir(),
  join(ROOT, 'artifacts/acceptance'),
];
const finalSources = sources.length ? sources.map((item) => item.replace(/^~(?=$|\/)/, homedir())) : defaultSources;
if (!existsSync(outDir)) {
  // archiveEvidence 自己会 mkdir；这里只做可读提示
}
const manifest = archiveEvidence({ sources: finalSources, outDir, runId });
console.log(`[archive] manifest: ${join(manifest.outDir, 'manifest.json')}`);
console.log(`[archive] files=${manifest.summary.files} bytes=${manifest.summary.bytes} missing=${manifest.summary.missing} skipped=${manifest.summary.skipped}`);
for (const item of manifest.missing) console.log(`[archive][missing] ${item.source} (${item.reason})`);
for (const item of manifest.skipped) console.log(`[archive][skipped] ${item.source} (${item.reason})`);
if (manifest.summary.files === 0) {
  console.error('[archive] 没有任何文件可归档：live 失败现场不存在或路径都不对（不把空归档当成功）');
  process.exit(2);
}
