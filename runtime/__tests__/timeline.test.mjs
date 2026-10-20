import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildTimeline } from '../timeline.mjs';
import { createRuntimeServer } from '../server.mjs';

const RUN = 'run-test-1';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cp-timeline-'));
  const journalDir = join(root, 'automation-runs');
  const evidenceDir = join(root, 'evidence');
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(join(evidenceDir, 'drc-report'), { recursive: true });
  // 运行 journal：正常两行 + 一行坏 JSON
  const lines = [
    { schemaVersion: 1, runId: RUN, seq: 1, at: '2026-10-20T10:00:00.000Z', phase: 'run.start', recipeId: 'pcb-create-pour' },
    { schemaVersion: 1, runId: RUN, seq: 2, at: '2026-10-20T10:00:02.000Z', phase: 'step.verified', stepId: 'create', ok: true, stateDigest: 'a'.repeat(64) },
    { schemaVersion: 1, runId: RUN, seq: 3, at: '2026-10-20T10:00:03.000Z', phase: 'run.end', ok: true, state: 'completed' },
  ];
  writeFileSync(join(journalDir, `${RUN}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n{not-json}\n`, 'utf8');
  writeFileSync(join(journalDir, `${RUN}-broken.jsonl`), '{"at":"2026-10-20T09:00:00.000Z","phase":"run.start"}\n', 'utf8');
  // 批准账本（不应当被当成 run 文件解析）
  writeFileSync(join(journalDir, 'approval-auto-1.jsonl'), '{"at":"2026-10-20T08:00:00.000Z","phase":"issued"}\n', 'utf8');
  const approvalsFile = join(root, 'approvals-ledger.json');
  writeFileSync(approvalsFile, JSON.stringify({
    schemaVersion: 1,
    data: {
      entries: [
        { index: 0, at: '2026-10-20T09:30:00.000Z', scope: 'write', action: 'issued', approvalId: 'auto-2', entryHash: 'b'.repeat(64), note: `${RUN} 写板批准` },
        { index: 1, at: '2026-10-20T09:31:00.000Z', scope: 'write', action: 'consumed', approvalId: 'auto-2', entryHash: 'c'.repeat(64), note: `${RUN} 写板批准` },
      ],
    },
  }), 'utf8');
  const evidenceDoc = { schemaVersion: 1, kind: 'drc-report', savedAt: '2026-10-20T09:45:00.000Z', digest: 'd'.repeat(64), fingerprint: { runId: RUN }, note: `${RUN} DRC 证据`, payload: {} };
  writeFileSync(join(evidenceDir, 'drc-report', 'drc.json'), JSON.stringify(evidenceDoc), 'utf8');
  writeFileSync(join(evidenceDir, 'drc-report', 'broken.json'), '{broken', 'utf8');
  return { root, journalDir, evidenceDir, approvalsFile };
}

test('C3 统一时间线：合并 run/approval/evidence 三类事实，按时间倒序，批准账本不冒充 run', () => {
  const { journalDir, evidenceDir, approvalsFile } = fixture();
  const timeline = buildTimeline({ journalDir, evidenceDir, approvalsFile, now: () => new Date('2026-10-20T12:00:00.000Z') });
  assert.equal(timeline.ok, true);
  assert.equal(timeline.sources.journal.available, true);
  assert.equal(timeline.sources.approvals.available, true);
  assert.equal(timeline.sources.evidence.available, true);
  const kinds = timeline.counts;
  assert.ok(kinds.run >= 3);
  assert.ok(kinds.approval === 2);
  assert.ok(kinds.evidence >= 1);
  // 倒序：第一条应当是 10:00:03 的 run.end
  assert.equal(timeline.entries[0].phase, 'run.end');
  const times = timeline.entries.map((entry) => entry.at).filter(Boolean);
  assert.deepEqual([...times].sort((a, b) => b.localeCompare(a)), times, '时间线必须倒序');
  // approval 账本文件不能被当成 run（没有 approval-auto-1 这个 runId）
  assert.ok(!timeline.entries.some((entry) => entry.kind === 'run' && entry.runId === 'approval-auto-1'));
  // 坏行/坏证据进 invalid，且 complete=false（不静默跳过）
  assert.ok(timeline.invalid.some((item) => item.file === `${RUN}.jsonl`));
  assert.ok(timeline.invalid.some((item) => String(item.file).includes('broken.json')));
  assert.equal(timeline.complete, false);
});

test('C3 runId 过滤：只看某次运行的步骤/批准/证据，其它运行不混入', () => {
  const { journalDir, evidenceDir, approvalsFile } = fixture();
  const other = 'run-other-9';
  writeFileSync(join(journalDir, `${other}.jsonl`), `${JSON.stringify({ schemaVersion: 1, runId: other, seq: 1, at: '2026-10-20T11:00:00.000Z', phase: 'run.start' })}\n`, 'utf8');
  const timeline = buildTimeline({ journalDir, evidenceDir, approvalsFile, runId: RUN, limit: 50 });
  assert.equal(timeline.runId, RUN);
  assert.ok(timeline.entries.every((entry) => entry.kind !== 'run' || entry.runId === RUN));
  assert.equal(timeline.entries.filter((entry) => entry.runId === other).length, 0);
  assert.ok(timeline.entries.some((entry) => entry.kind === 'approval'));
  assert.ok(timeline.entries.some((entry) => entry.kind === 'evidence'));
});

test('C3 fail-closed：目录/账本缺失写 unavailable+原因，不伪造空成功；limit 截断如实标记', () => {
  const { journalDir, evidenceDir, approvalsFile } = fixture();
  const timeline = buildTimeline({ journalDir, evidenceDir, approvalsFile, limit: 2 });
  assert.equal(timeline.total >= 6, true);
  assert.equal(timeline.entries.length, 2);
  assert.equal(timeline.truncated, true);

  const missing = buildTimeline({ journalDir: join(tmpdir(), 'cp-timeline-missing-dir'), evidenceDir: join(tmpdir(), 'cp-timeline-missing-evidence'), approvalsFile: null });
  assert.equal(missing.ok, true);
  assert.equal(missing.sources.journal.available, false);
  assert.match(String(missing.sources.journal.reason), /不存在/);
  assert.equal(missing.sources.approvals.available, false);
  assert.equal(missing.entries.length, 0);
  assert.equal(missing.complete, false);
});

test('C3 HTTP：GET /api/timeline 返回合并时间线与 sources/invalid 字段', async (context) => {
  const { root, journalDir, evidenceDir, approvalsFile } = fixture();
  const previous = {
    auto: process.env.CIRCUITPILOT_AUTOMATION_DIR,
    evidence: process.env.CIRCUITPILOT_EVIDENCE_DIR,
    state: process.env.CIRCUITPILOT_STATE_DIR,
  };
  process.env.CIRCUITPILOT_AUTOMATION_DIR = journalDir;
  process.env.CIRCUITPILOT_EVIDENCE_DIR = evidenceDir;
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  mkdirSync(join(root, 'state'), { recursive: true });
  // 批准账本在 stateDir 下，server 内部按 stateDir 读取；把 fixture 的账本复制过去
  writeFileSync(join(root, 'state', 'approvals-ledger.json'), JSON.stringify({ schemaVersion: 1, data: { entries: [] } }));
  const { server } = createRuntimeServer({ keychain: { async configured() { return false; }, async read() { throw new Error('unused'); } }, bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => {
    for (const [key, value] of Object.entries({ auto: previous.auto, evidence: previous.evidence, state: previous.state })) {
      const envKey = { auto: 'CIRCUITPILOT_AUTOMATION_DIR', evidence: 'CIRCUITPILOT_EVIDENCE_DIR', state: 'CIRCUITPILOT_STATE_DIR' }[key];
      if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const response = await fetch(`${base}/api/timeline?limit=5`, { headers: { 'x-circuitpilot-token': health.sessionProof } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.entries));
  assert.ok(payload.sources);
  assert.ok(Array.isArray(payload.invalid));
  assert.equal(payload.entries.length <= 5, true);
});
