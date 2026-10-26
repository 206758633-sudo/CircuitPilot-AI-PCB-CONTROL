#!/usr/bin/env node
/**
 * H6：备份与恢复演练（真实文件，真实校验，不碰线上数据）。
 *
 * 做什么：
 *   1. 把运行时的持久数据（state 目录、证据目录、自动化 journal 目录）**复制**到临时备份目录，
 *      每个文件记 sha256/字节数，生成 backup-manifest.json；
 *   2. 把备份目录**恢复**到另一个临时目录（恢复目标是副本，不覆盖线上数据）；
 *   3. 用运行时自己的只读加载器重新打开恢复后的数据（trace-state 存储、证据索引、journal 哈希链），
 *      与原始数据的计数/哈希比对；
 *   4. 产出 JSON + Markdown 报告到 artifacts/h6-backup/，任一必需校验失败 exit 1。
 *
 * fail-closed：
 *   - 源目录不存在 → 明确 SKIPPED（附原因），不伪装成"备份成功"；
 *   - 文件读失败/哈希不一致 → FAIL；
 *   - "恢复后能继续"用**运行时加载器**验证，而不是只看文件在不在。
 *
 * 用法：node scripts/backup-restore-drill.mjs
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createTraceStateStore } from '../runtime/trace-state.mjs';
import { buildEvidenceIndex } from '../runtime/evidence-index.mjs';
import { summarizeJournalRuns } from '../runtime/automation/journal.mjs';

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = join(process.cwd(), 'artifacts', 'h6-backup');
// 与运行时一致：默认状态目录是项目内 artifacts/state（可用 CIRCUITPILOT_STATE_DIR 覆盖）。
const STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || join(process.cwd(), 'artifacts', 'state');
const EVIDENCE_DIR = process.env.CIRCUITPILOT_EVIDENCE_DIR || join(process.cwd(), 'artifacts', 'evidence');
const AUTOMATION_DIR = process.env.CIRCUITPILOT_AUTOMATION_DIR || join(homedir(), '.circuitpilot', 'automation-runs');

// ESM 下不能用 require：改为直接 readFileSync import。
import { readFileSync } from 'node:fs';
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const rows = [];
const check = (name, status, detail) => { rows.push({ name, status, detail }); return status; };

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, base, out);
    else out.push(full);
  }
  return out;
}

function backupTree(sourceDir, targetDir) {
  const files = walk(sourceDir).map((file) => {
    const rel = relative(sourceDir, file);
    const target = join(targetDir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(file, target);
    return { path: rel, bytes: statSync(file).size, sha256: sha256(file) };
  });
  return files;
}

const backupRoot = join(tmpdir(), `cp-backup-${STAMP}`);
const restoreRoot = join(tmpdir(), `cp-restore-${STAMP}`);
mkdirSync(OUT_DIR, { recursive: true });
const report = { kind: 'backup-restore-drill', generatedAt: new Date().toISOString(), sources: {}, backup: null, restore: null, checks: rows, verdict: 'fail' };

try {
  // ---------- 1. 备份 ----------
  const plan = [
    { name: 'state', dir: STATE_DIR, required: true },
    { name: 'evidence', dir: EVIDENCE_DIR, required: false },
    { name: 'automation-runs', dir: AUTOMATION_DIR, required: false },
  ];
  const entries = [];
  for (const item of plan) {
    const exists = existsSync(item.dir);
    report.sources[item.name] = { dir: item.dir, exists, required: item.required };
    if (!exists) { check(`source:${item.name}`, item.required ? 'FAIL' : 'SKIPPED', item.required ? '必需状态目录不存在' : '目录不存在，跳过'); continue; }
    const target = join(backupRoot, item.name);
    const files = item.files
      ? item.files.filter((name) => existsSync(join(item.dir, name))).map((name) => { mkdirSync(target, { recursive: true }); copyFileSync(join(item.dir, name), join(target, name)); return { path: name, bytes: statSync(join(item.dir, name)).size, sha256: sha256(join(item.dir, name)) }; })
      : backupTree(item.dir, target);
    entries.push(...files.map((file) => ({ ...file, source: item.name })));
    check(`backup:${item.name}`, files.length ? 'PASS' : 'SKIPPED', `${files.length} 个文件`);
  }
  const manifest = { kind: 'circuitpilot-backup-manifest', schemaVersion: 1, generatedAt: new Date().toISOString(), files: entries };
  mkdirSync(backupRoot, { recursive: true });
  writeFileSync(join(backupRoot, 'backup-manifest.json'), JSON.stringify(manifest, null, 2));
  report.backup = { root: backupRoot, files: entries.length, bytes: entries.reduce((sum, file) => sum + file.bytes, 0), manifestSha256: sha256(join(backupRoot, 'backup-manifest.json')) };

  // ---------- 2. 恢复 ----------
  let restored = 0;
  for (const file of entries) {
    const target = join(restoreRoot, file.source, file.path);
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(join(backupRoot, file.source, file.path), target);
    if (sha256(target) !== file.sha256) throw new Error(`恢复后哈希不一致：${file.source}/${file.path}`);
    restored += 1;
  }
  check('restore:files', restored === entries.length ? 'PASS' : 'FAIL', `恢复 ${restored}/${entries.length}`);

  // ---------- 3. 用运行时加载器验证"恢复后能继续" ----------
  const restoredState = join(restoreRoot, 'state');
  if (existsSync(join(restoredState, 'trace-state.json'))) {
    const store = createTraceStateStore({ file: join(restoredState, 'trace-state.json') });
    const restoredTrace = store.load();
    const originalTrace = createTraceStateStore({ file: join(STATE_DIR, 'trace-state.json') }).load();
    check('rt:load:trace', restoredTrace.state.versions.length === originalTrace.state.versions.length && restoredTrace.state.changes.length === originalTrace.state.changes.length ? 'PASS' : 'FAIL', `恢复后 versions=${restoredTrace.state.versions.length}/changes=${restoredTrace.state.changes.length}，原始 versions=${originalTrace.state.versions.length}`);
  } else {
    check('rt:load:trace', 'SKIPPED', '恢复副本里没有 trace-state.json');
  }

  const restoredEvidence = join(restoreRoot, 'evidence');
  if (existsSync(restoredEvidence)) {
    const restoredIndex = buildEvidenceIndex({ dirs: [restoredEvidence] });
    const originalIndex = buildEvidenceIndex({ dirs: [EVIDENCE_DIR] });
    const same = restoredIndex.entries.length === originalIndex.entries.length && restoredIndex.complete === originalIndex.complete;
    check('rt:load:evidence', same ? 'PASS' : 'FAIL', `恢复后证据 ${restoredIndex.entries.length} 条（原始 ${originalIndex.entries.length}），complete=${String(restoredIndex.complete)}`);
  } else {
    check('rt:load:evidence', 'SKIPPED', '恢复副本里没有证据目录');
  }

  const restoredAutomation = join(restoreRoot, 'automation-runs');
  if (existsSync(restoredAutomation)) {
    const restoredJournal = summarizeJournalRuns({ dir: restoredAutomation });
    const originalJournal = summarizeJournalRuns({ dir: AUTOMATION_DIR });
    const same = restoredJournal.runs.length === originalJournal.runs.length && (restoredJournal.chainOk?.ok ?? null) === (originalJournal.chainOk?.ok ?? null);
    check('rt:load:journal', same ? 'PASS' : 'FAIL', `恢复后 run ${restoredJournal.runs.length} 个，链校验=${JSON.stringify(restoredJournal.chainOk?.ok ?? null)}`);
  } else {
    check('rt:load:journal', 'SKIPPED', '恢复副本里没有 journal 目录');
  }

  report.restore = { root: restoreRoot, files: restored };
  report.verdict = rows.some((row) => row.status === 'FAIL') ? 'fail' : 'pass';
} catch (error) {
  report.error = { message: String(error?.message || error) };
  report.verdict = 'fail';
} finally {
  rmSync(backupRoot, { recursive: true, force: true });
  rmSync(restoreRoot, { recursive: true, force: true });
}

writeFileSync(join(OUT_DIR, `backup-restore-${STAMP}.json`), JSON.stringify(report, null, 2));
const md = ['# H6 备份/恢复演练报告', '', `- 时间：${report.generatedAt}`, `- 结论：**${report.verdict.toUpperCase()}**`, `- 备份：${report.backup ? `${report.backup.files} 个文件 / ${report.backup.bytes} 字节，manifest ${report.backup.manifestSha256.slice(0, 12)}…` : '未执行'}`, `- 恢复：${report.restore ? `${report.restore.files} 个文件哈希一致` : '未执行'}`, '', '| 检查项 | 结果 | 说明 |', '|---|---|---|', ...rows.map((row) => `| ${row.name} | ${row.status} | ${row.detail} |`), '', '说明：恢复目标是临时副本，演练不会覆盖线上数据；"恢复后能继续"由运行时自己的只读加载器验证。'];
writeFileSync(join(OUT_DIR, `backup-restore-${STAMP}.md`), md.join('\n'));
console.log(JSON.stringify({ ok: report.verdict === 'pass', verdict: report.verdict, report: join(OUT_DIR, `backup-restore-${STAMP}.json`) }, null, 2));
process.exit(report.verdict === 'pass' ? 0 : 1);
