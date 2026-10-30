import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createReleaseArchiveStore } from '../release-archive.mjs';
import { createRuntimeServer } from '../server.mjs';
import { inspectProductionArtifacts } from '../production.mjs';

const readyGate = () => ({
  ready: true,
  verdict: 'ready-to-order',
  fingerprint: { sha256: 'a'.repeat(64) },
  blockers: [],
  warnings: [],
  gates: [{ id: 'drc', status: 'pass', blockingCount: 0 }, { id: 'schematic', status: 'pass', blockingCount: 0 }],
});
const readyDecision = () => ({
  ready: true,
  verdict: 'ready',
  blockedBy: [],
  fingerprint: 'b'.repeat(64),
  gates: [{ id: 'local:drc', scope: 'local', status: 'pass', passed: true }, { id: 'manual:signoff', scope: 'manual', status: 'pass', passed: true }],
  evidence: { gateFingerprint: { sha256: 'a'.repeat(64) }, binding: { planHash: 'p'.repeat(64), manifestHash: 'm'.repeat(64) } },
});
const binding = () => ({ planHash: 'p'.repeat(64), compiledPlanHash: 'c'.repeat(64), pcbUuid: 'pcb-1', pcbExecutionId: 'exec-1', reviewHash: 'r'.repeat(64), manifestHash: 'f'.repeat(64) });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cp-release-archive-'));
  const evidenceDir = join(root, 'deliverables');
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, 'GERBER_board.zip'), 'gerber-bytes');
  writeFileSync(join(evidenceDir, 'BOM_board.csv'), 'ref,supplier\nU1,C1\n');
  return { root, evidenceDir, store: createReleaseArchiveStore({ dir: join(root, 'releases') }) };
}

test('B8：ready 放行 → 归档记录不可变、绑定完整、证据逐个 sha256；list/get 可追溯', () => {
  const { root, evidenceDir, store } = fixture();
  try {
    const release = store.archive({
      gate: readyGate(), releaseDecision: readyDecision(), binding: binding(), artifactsDir: evidenceDir,
      files: [{ path: join(evidenceDir, 'GERBER_board.zip'), role: 'gerber' }, { path: join(evidenceDir, 'BOM_board.csv'), role: 'bom' }],
      notes: '首版发布',
    });
    assert.equal(release.immutable, true);
    assert.match(release.releaseId, /^rel-/);
    assert.equal(release.binding.manifestHash, 'f'.repeat(64));
    assert.equal(release.binding.reviewHash, 'r'.repeat(64));
    assert.equal(release.gate.verdict, 'ready-to-order');
    assert.equal(release.releaseDecision.ready, true);
    assert.equal(release.evidence.files.length, 2);
    assert.ok(release.evidence.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
    assert.equal(release.verification.verified, true);

    const listed = store.list();
    assert.equal(listed.releases.length, 1);
    assert.equal(listed.releases[0].verification.verified, true);
    assert.equal(listed.corrupt.length, 0);

    const fetched = store.get(release.releaseId);
    assert.equal(fetched.archiveHash, release.archiveHash);
    assert.equal(fetched.verification.verified, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B8 fail-closed：门禁/裁决未 ready、绑定缺失、证据不可读 → 全部拒绝归档', () => {
  const { root, evidenceDir, store } = fixture();
  try {
    assert.throws(() => store.archive({ gate: { ready: false, blockers: [{ code: 'RELEASE_DRC_BLOCKED', message: 'DRC 未过' }] }, releaseDecision: readyDecision(), binding: binding() }), (error) => {
      assert.equal(error.code, 'RELEASE_ARCHIVE_NOT_ALLOWED');
      assert.equal(error.status, 409);
      assert.equal(error.details.blockers[0].code, 'RELEASE_DRC_BLOCKED');
      return true;
    });
    assert.throws(() => store.archive({ gate: readyGate(), releaseDecision: { ready: false, blockedBy: ['manual:signoff'] }, binding: binding() }), (error) => {
      assert.equal(error.code, 'RELEASE_ARCHIVE_NOT_ALLOWED');
      assert.deepEqual(error.details.blockedBy, ['manual:signoff']);
      return true;
    });
    assert.throws(() => store.archive({ gate: readyGate(), releaseDecision: readyDecision(), binding: { ...binding(), planHash: null } }), (error) => error.code === 'RELEASE_ARCHIVE_BINDING_INVALID');
    assert.throws(() => store.archive({ gate: readyGate(), releaseDecision: readyDecision(), binding: { ...binding(), manifestHash: 'not-a-sha' } }), (error) => error.code === 'RELEASE_ARCHIVE_BINDING_INVALID');
    assert.throws(() => store.archive({ gate: readyGate(), releaseDecision: readyDecision(), binding: { ...binding(), reviewHash: null } }), (error) => error.code === 'RELEASE_ARCHIVE_BINDING_INVALID');
    assert.throws(() => store.archive({ gate: readyGate(), releaseDecision: readyDecision(), binding: binding(), files: [{ path: join(root, 'does-not-exist.bin') }] }), (error) => error.code === 'RELEASE_ARCHIVE_EVIDENCE_UNREADABLE');
    assert.equal(store.list().releases.length, 0, '被拒绝的归档不能留下半条记录');
    assert.equal(existsSync(join(root, 'releases')) ? readdirSync(join(root, 'releases')).length : 0, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B8：证据文件被改/记录被改 → verify 明确 false + problems，不把"文件还在"当可信', () => {
  const { root, evidenceDir, store } = fixture();
  try {
    const release = store.archive({ gate: readyGate(), releaseDecision: readyDecision(), binding: binding(), files: [{ path: join(evidenceDir, 'GERBER_board.zip'), role: 'gerber' }] });
    assert.equal(store.get(release.releaseId).verification.verified, true);
    writeFileSync(join(evidenceDir, 'GERBER_board.zip'), 'tampered-bytes');
    const tampered = store.get(release.releaseId);
    assert.equal(tampered.verification.verified, false);
    assert.ok(tampered.verification.problems.some((problem) => problem.includes('证据文件被改动')));
    assert.ok(tampered.verification.problems.some((problem) => problem.includes('证据文件长度变化')));
    assert.throws(() => store.get('../etc/passwd'), (error) => error.code === 'RELEASE_ARCHIVE_INVALID_ID');
    assert.throws(() => store.get('rel-does-not-exist-123'), (error) => error.code === 'RELEASE_ARCHIVE_NOT_FOUND');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B8 HTTP：未 ready 归档 409、发布版本列表可读、未知 id 404', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-release-http-'));
  const keys = ['CIRCUITPILOT_STATE_DIR', 'CIRCUITPILOT_AUTOMATION_DIR', 'CIRCUITPILOT_EVIDENCE_DIR', 'CIRCUITPILOT_RELEASES_DIR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const dir of ['state', 'automation', 'evidence', 'releases']) mkdirSync(join(root, dir), { recursive: true });
  process.env.CIRCUITPILOT_STATE_DIR = join(root, 'state');
  process.env.CIRCUITPILOT_AUTOMATION_DIR = join(root, 'automation');
  process.env.CIRCUITPILOT_EVIDENCE_DIR = join(root, 'evidence');
  process.env.CIRCUITPILOT_RELEASES_DIR = join(root, 'releases');
  const { server } = createRuntimeServer({ keychain: { async configured() { return false; }, async read() { throw new Error('unused'); } }, bridge: null, gui: null });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const headers = { 'x-circuitpilot-token': health.sessionProof, 'content-type': 'application/json' };

  const empty = await (await fetch(`${base}/api/production/releases`, { headers })).json();
  assert.deepEqual(empty.releases, []);
  assert.deepEqual(empty.corrupt, []);

  const refused = await fetch(`${base}/api/production/releases/archive`, { method: 'POST', headers, body: JSON.stringify({ acceptance: null, design: null, placementVerification: null }) });
  assert.equal(refused.status, 409);
  const refusedPayload = await refused.json();
  assert.equal(refusedPayload.error.code, 'RELEASE_ARCHIVE_NOT_ALLOWED');
  assert.ok(refusedPayload.error.details.blockers.length >= 1);

  const missing = await fetch(`${base}/api/production/releases/rel-does-not-exist-123`, { headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'RELEASE_ARCHIVE_NOT_FOUND');
});

/**
 * P1-6：归档 manifestHash 必须由服务端用**与导出/签核相同的完整 binding**对 artifactsDir 重算。
 * 旧实现用稀疏 binding（只有 planHash/pcbUuid/…）重算，与导出/签核的完整 binding 哈希必然不等，
 * B8 归档结构性 400/409；另一方面 planHash 硬要求又和 UI"语义计划哈希可留空"矛盾。
 */

const fullBinding = () => ({
  projectId: 'proj-1',
  projectName: '测试工程',
  documentId: 'doc-1',
  sourceDigest: 'd'.repeat(64),
  semanticPlanHash: 'p'.repeat(64),
  compiledPlanHash: 'c'.repeat(64),
  executionId: 'exec-1',
  pcbUuid: 'pcb-1',
  pcbExecutionId: 'exec-1',
  reviewHash: 'r'.repeat(64),
});
const fullReadyBinding = (manifestHash) => ({ ...fullBinding(), manifestHash });

test('P1-6：完整 binding + 正确 manifestHash → 服务端重算一致、归档成功并记录完整绑定', () => {
  const { root, evidenceDir, store } = fixture();
  try {
    const bindingBase = fullBinding();
    const recomputed = inspectProductionArtifacts(evidenceDir, bindingBase).manifest.manifestHash;
    const release = store.archive({
      gate: readyGate(), releaseDecision: readyDecision(), artifactsDir: evidenceDir,
      binding: fullReadyBinding(recomputed),
      files: [{ path: join(evidenceDir, 'GERBER_board.zip'), role: 'gerber' }],
    });
    assert.equal(release.binding.manifestHash, recomputed);
    assert.equal(release.binding.manifestRecomputed, recomputed, '必须记下"服务端重算过"的事实');
    assert.equal(release.binding.semanticPlanHash, 'p'.repeat(64));
    assert.equal(release.binding.executionId, 'exec-1');
    assert.equal(release.binding.projectId, 'proj-1');
    assert.equal(release.binding.documentId, 'doc-1');
    assert.equal(release.verification.verified, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1-6：稀疏 binding 显式要求重算 → RELEASE_ARCHIVE_BINDING_INCOMPLETE（明确 400，不再产假哈希）', () => {
  const { root, evidenceDir, store } = fixture();
  try {
    assert.throws(
      () => store.archive({ gate: readyGate(), releaseDecision: readyDecision(), artifactsDir: evidenceDir, binding: binding(), recomputeManifest: true }),
      (error) => {
        assert.equal(error.code, 'RELEASE_ARCHIVE_BINDING_INCOMPLETE');
        assert.equal(error.status, 400);
        assert.ok(error.details.missing.includes('projectId'));
        return true;
      },
    );
    assert.equal(store.list().releases.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1-6：完整 binding 但 manifestHash 与 artifactsDir 重算不一致 → MANIFEST_DRIFT 409，不落记录', () => {
  const { root, evidenceDir, store } = fixture();
  try {
    const recomputed = inspectProductionArtifacts(evidenceDir, fullBinding()).manifest.manifestHash;
    const stale = '0'.repeat(64);
    assert.throws(
      () => store.archive({ gate: readyGate(), releaseDecision: readyDecision(), artifactsDir: evidenceDir, binding: fullReadyBinding(stale) }),
      (error) => {
        assert.equal(error.code, 'RELEASE_ARCHIVE_MANIFEST_DRIFT');
        assert.equal(error.status, 409);
        assert.equal(error.details.provided, stale);
        assert.equal(error.details.recomputed, recomputed);
        return true;
      },
    );
    assert.equal(store.list().releases.length, 0);
    assert.equal(existsSync(join(root, 'releases')) ? readdirSync(join(root, 'releases')).length : 0, 0, '漂移时连半条记录都不许留');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1-6：完整 binding 但缺 artifactsDir → BINDING_INCOMPLETE（不能拿调用方自报哈希当依据）', () => {
  const { root, store } = fixture();
  try {
    assert.throws(
      () => store.archive({ gate: readyGate(), releaseDecision: readyDecision(), binding: fullReadyBinding('f'.repeat(64)) }),
      (error) => {
        assert.equal(error.code, 'RELEASE_ARCHIVE_BINDING_INCOMPLETE');
        assert.ok(error.details.missing.includes('artifactsDir'));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1-6：semanticPlanHash 与 planHash 任一存在即可（与 UI“语义计划哈希可留空”口径一致）', () => {
  const { root, evidenceDir, store } = fixture();
  try {
    const legacy = { ...binding(), planHash: null, semanticPlanHash: 's'.repeat(64) };
    const release = store.archive({ gate: readyGate(), releaseDecision: readyDecision(), binding: legacy, files: [{ path: join(evidenceDir, 'GERBER_board.zip'), role: 'gerber' }] });
    assert.equal(release.binding.planHash, 's'.repeat(64), '缺 planHash 时应回落到 semanticPlanHash');
    assert.equal(release.binding.semanticPlanHash, 's'.repeat(64));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
