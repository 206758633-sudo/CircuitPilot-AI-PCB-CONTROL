import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import { appendTimelineLink, loadTimelineLinks, validateTimelineLink } from '../timeline-links.mjs';
import { buildTimeline } from '../timeline.mjs';

const DIGEST = 'a'.repeat(64);
const RUN_ID = 'run-abc12345';
const EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-timeline-links-evidence-'));
const AUTOMATION_DIR = mkdtempSync(join(tmpdir(), 'cp-timeline-links-auto-'));
const STATE_DIR = mkdtempSync(join(tmpdir(), 'cp-timeline-links-state-'));
process.env.CIRCUITPILOT_STATE_DIR = STATE_DIR;
process.env.CIRCUITPILOT_EVIDENCE_DIR = EVIDENCE_DIR;
process.env.CIRCUITPILOT_AUTOMATION_DIR = AUTOMATION_DIR;
const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const LINKS_FILE = join(STATE_DIR, 'timeline-links.jsonl');

mkdirSync(join(EVIDENCE_DIR, 'export'), { recursive: true });
writeFileSync(join(EVIDENCE_DIR, 'export', 'export-1.json'), JSON.stringify({ kind: 'export', digest: DIGEST, savedAt: '2026-10-20T05:00:00.000Z', fingerprint: { planHash: 'p'.repeat(64) }, note: '生产导出证据' }));
mkdirSync(AUTOMATION_DIR, { recursive: true });
writeFileSync(join(AUTOMATION_DIR, `${RUN_ID}.jsonl`), `${JSON.stringify({ at: '2026-10-20T05:00:01.000Z', phase: 'run.start', runId: RUN_ID, detail: { recipeId: 'eda-read-project' } })}\n`);

async function start(context) {
  const { server } = createRuntimeServer({ bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  return { base, headers };
}

test('C3 链接：形状校验 + 坏行如实进 invalid + append/load 往返', () => {
  assert.throws(() => validateTimelineLink({ runId: 'bad id!', digest: DIGEST }), (error) => error.code === 'TIMELINE_LINK_INVALID');
  assert.throws(() => validateTimelineLink({ runId: RUN_ID, digest: 'xyz' }), (error) => error.code === 'TIMELINE_LINK_INVALID');
  const file = join(mkdtempSync(join(tmpdir(), 'cp-links-')), 'links.jsonl');
  assert.deepEqual(loadTimelineLinks({ file }).links, []);
  appendTimelineLink({ file, runId: RUN_ID, digest: DIGEST, note: '手工关联' });
  const loaded = loadTimelineLinks({ file });
  assert.equal(loaded.count, 1);
  assert.equal(loaded.links[0].runId, RUN_ID);
  assert.equal(loaded.links[0].digest, DIGEST);
  writeFileSync(file, `${JSON.stringify({ runId: RUN_ID, digest: DIGEST })}\nnot-json\n`);
  const corrupt = loadTimelineLinks({ file });
  assert.equal(corrupt.count, 1);
  assert.equal(corrupt.invalid.length, 1);
});

test('C3 时间线：显式关联的证据按 digest 标注 runId，runId 过滤可命中', () => {
  const linksFile = join(mkdtempSync(join(tmpdir(), 'cp-links-timeline-')), 'links.jsonl');
  appendTimelineLink({ file: linksFile, runId: RUN_ID, digest: DIGEST });
  const timeline = buildTimeline({ journalDir: AUTOMATION_DIR, evidenceDir: EVIDENCE_DIR, linksFile, runId: RUN_ID, limit: 50 });
  assert.equal(timeline.sources.links.count, 1);
  const evidence = timeline.entries.find((entry) => entry.kind === 'evidence');
  assert.ok(evidence, '关联证据应出现在按 runId 过滤的时间线里');
  assert.equal(evidence.runId, RUN_ID);
  assert.equal(evidence.linkedBy, 'explicit');
  // 反例：链接到另一个 run 时不命中
  const other = buildTimeline({ journalDir: AUTOMATION_DIR, evidenceDir: EVIDENCE_DIR, linksFile, runId: 'run-other-999', limit: 50 });
  assert.equal(other.entries.some((entry) => entry.kind === 'evidence'), false);
});

test('C3 HTTP：关联 run/证据不存在 404、重复 409、成功后可读回', async (context) => {
  const { base, headers } = await start(context);
  const post = (body) => fetch(`${base}/api/timeline/link`, { method: 'POST', headers, body: JSON.stringify(body) });
  const missingRun = await post({ runId: 'run-missing-1', digest: DIGEST });
  assert.equal(missingRun.status, 404);
  assert.equal((await missingRun.json()).error.code, 'TIMELINE_LINK_RUN_NOT_FOUND');

  const missingEvidence = await post({ runId: RUN_ID, digest: 'b'.repeat(64) });
  assert.equal(missingEvidence.status, 404);
  assert.equal((await missingEvidence.json()).error.code, 'TIMELINE_LINK_EVIDENCE_NOT_FOUND');

  const created = await post({ runId: RUN_ID, digest: DIGEST, note: 'HTTP 关联' });
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.link.runId, RUN_ID);
  const duplicate = await post({ runId: RUN_ID, digest: DIGEST });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'TIMELINE_LINK_DUPLICATE');

  const timeline = await (await fetch(`${base}/api/timeline?runId=${RUN_ID}`, { headers })).json();
  assert.equal(timeline.sources.links.count, 1);
  assert.equal(timeline.entries.some((entry) => entry.kind === 'evidence' && entry.linkedBy === 'explicit'), true);
});
