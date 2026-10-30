import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DRAFT_MARKER, PRODUCTION_OUTPUT_CODES, artifactName, decideProductionOutput } from '../production-release.mjs';
import { PRODUCTION_EXPORT_CODES, runProductionExport } from '../production-export.mjs';
import { inspectProductionArtifacts } from '../production.mjs';

/**
 * "门禁没通过就只能出草稿"这条规则的可测形态。
 * 它拦的不是技术错误，而是**人会犯的错**：忘了改文件名、以为"能导出就能下单"。
 */

const greenGate = { ready: true, verdict: 'ready-to-order', blockers: [], fingerprint: { sha256: 'a'.repeat(64) } };
const redGate = {
  ready: false,
  verdict: 'blocked',
  blockers: [
    { code: 'RELEASE_SCHEMATIC_NOT_READY', message: 'CC1 悬空' },
    { code: 'RELEASE_DRC_UNEXPLAINED', message: '156 条未处理' },
    { code: 'RELEASE_SCHEMATIC_NOT_READY', message: '重复的码应当去重' },
  ],
  fingerprint: { sha256: 'b'.repeat(64) },
};

test('草稿永远允许出，但必须带草稿标记并给出"不得下单"的警告', () => {
  const decision = decideProductionOutput({ gate: redGate, requested: 'draft' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.outputClass, 'draft');
  assert.equal(decision.naming.suffix, DRAFT_MARKER);
  assert.match(decision.warning, /不得用于下单/);
  assert.equal(decision.humanSignoffRequired, true);
});

test('门禁没通过时申请正式产出：拒绝，并给出阻断码与"先出草稿"的替代路径', () => {
  const decision = decideProductionOutput({ gate: redGate, requested: 'final' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, PRODUCTION_OUTPUT_CODES.BLOCKED);
  assert.equal(decision.outputClass, null);
  assert.deepEqual(decision.blockers, ['RELEASE_SCHEMATIC_NOT_READY', 'RELEASE_DRC_UNEXPLAINED'], '阻断码必须去重');
  assert.ok(decision.fix.some((line) => line.includes(DRAFT_MARKER)));
});

test('默认申请就是正式（默认最严）：不显式说 draft 就等于要求正式产出', () => {
  assert.equal(decideProductionOutput({ gate: redGate }).allowed, false);
  assert.equal(decideProductionOutput({ gate: redGate }).requested, 'final');
});

test('没有设计指纹时一律拒绝：放行必须绑定到具体这一版设计', () => {
  const decision = decideProductionOutput({ gate: { ready: true, verdict: 'ready-to-order', blockers: [] }, requested: 'final' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, PRODUCTION_OUTPUT_CODES.FINGERPRINT_REQUIRED);
});

test('门禁通过且产物命名正确：允许正式产出，并给出一组正式文件名示例', () => {
  const decision = decideProductionOutput({ gate: greenGate, requested: 'final', artifacts: [{ path: 'BOM_x.csv' }] });
  assert.equal(decision.allowed, true);
  assert.equal(decision.outputClass, 'final');
  assert.equal(decision.naming.suffix, '');
  assert.ok(decision.exampleNames.every((name) => !/DRAFT/i.test(name)));
  assert.equal(decision.ticket, decideProductionOutput({ gate: greenGate, requested: 'final' }).ticket, '同一版设计+同一类别 → 同一个凭据');
  assert.notEqual(decision.ticket, decideProductionOutput({ gate: redGate, requested: 'draft' }).ticket, '不同指纹/类别不得同凭据');
});

test('门禁通过但目录里还是草稿文件名：同样拒绝，指名道姓列出要重导的文件', () => {
  const decision = decideProductionOutput({ gate: greenGate, requested: 'final', artifacts: [{ path: '/x/BOM_CircuitPilot-bom-DRAFT-NOT-FOR-ORDER.csv.csv' }, { path: '/x/CPL_cpl.csv' }] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, PRODUCTION_OUTPUT_CODES.STALE_DRAFT_MARKER);
  assert.equal(decision.staleArtifacts.length, 1);
  assert.match(decision.staleArtifacts[0], /DRAFT-NOT-FOR-ORDER/);
});

test('产物命名：草稿带标记、正式无标记，且重复调用不叠加标记（幂等）', () => {
  assert.equal(artifactName({ base: 'BOM_CircuitPilot-bom', ext: 'csv', outputClass: 'draft' }).name, `BOM_CircuitPilot-bom${DRAFT_MARKER}.csv`);
  assert.equal(artifactName({ base: 'BOM_CircuitPilot-bom', ext: 'csv', outputClass: 'final' }).name, 'BOM_CircuitPilot-bom.csv');
  const twice = artifactName({ base: `BOM_CircuitPilot-bom${DRAFT_MARKER}`, ext: 'csv', outputClass: 'draft' }).name;
  assert.equal(twice, `BOM_CircuitPilot-bom${DRAFT_MARKER}.csv`);
  const promoted = artifactName({ base: `BOM_CircuitPilot-bom${DRAFT_MARKER}`, ext: 'csv', outputClass: 'final' }).name;
  assert.equal(promoted, 'BOM_CircuitPilot-bom.csv', '从草稿改名转正式时必须把标记去掉');
});

test('入参非法直接拒绝：类别、名称、扩展名都不许糊过去', () => {
  assert.throws(() => decideProductionOutput({ gate: greenGate, requested: 'official' }), (error) => error.code === PRODUCTION_OUTPUT_CODES.REQUEST_INVALID);
  assert.throws(() => artifactName({ base: '  ', ext: 'csv' }), (error) => error.code === PRODUCTION_OUTPUT_CODES.REQUEST_INVALID);
  assert.throws(() => artifactName({ base: 'ok', ext: 'a b' }), (error) => error.code === PRODUCTION_OUTPUT_CODES.REQUEST_INVALID);
  assert.throws(() => artifactName({ base: 'ok', ext: 'csv', outputClass: 'draft2' }), (error) => error.code === PRODUCTION_OUTPUT_CODES.REQUEST_INVALID);
});

test('正式产出裁决：本次将要覆盖的自产草稿不算"陈旧草稿"（否则正式导出永远出不来）', () => {
  const gate = { ready: true, verdict: 'ready', fingerprint: { sha256: 'a'.repeat(64) }, blockers: [] };
  const draft = '/tmp/pack/GERBER_x-DRAFT-NOT-FOR-ORDER.zip';
  // 1) 没声明 → 照旧阻断（守卫本身不能被削弱）
  const blocked = decideProductionOutput({ gate, requested: 'final', artifacts: [{ kind: 'gerber', path: draft }] });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'PRODUCTION_OUTPUT_DRAFT_MARKER_PRESENT');
  // 2) 显式声明"这就是本次要覆盖的" → 放行，且把被覆盖的草稿如实列出
  const allowed = decideProductionOutput({ gate, requested: 'final', artifacts: [{ kind: 'gerber', path: draft }], draftPathsReplaced: [draft] });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.outputClass, 'final');
  assert.deepEqual(allowed.replacedDrafts, [draft]);
  assert.deepEqual(allowed.naming, { suffix: '' });
  // 3) 目录**外**的草稿不在声明里 → 仍然阻断（不能靠声明绕过没声明的文件）
  const mixed = decideProductionOutput({ gate, requested: 'final', artifacts: [{ kind: 'gerber', path: draft }, { kind: 'bom', path: '/tmp/other/BOM_x-DRAFT.csv' }], draftPathsReplaced: [draft] });
  assert.equal(mixed.allowed, false);
  assert.deepEqual(mixed.staleArtifacts, ['/tmp/other/BOM_x-DRAFT.csv']);
});

/**
 * P0-A：导出锚点。正式导出必须用**与签核相同的完整 binding**对产出重算 manifestHash，
 * 与签核值一致才允许按正式命名落盘；签核后文件被改过 ⇒ 拒绝并保留草稿。
 */

const fullBinding = () => ({
  projectId: 'proj-1',
  projectName: '测试工程',
  documentId: 'doc-1',
  sourceDigest: 'd'.repeat(64),
  semanticPlanHash: 'p'.repeat(64),
  compiledPlanHash: 'c'.repeat(64),
  executionId: 'exec-1',
});

const EXPORT_PAYLOADS = () => ({
  gerber: Buffer.from('PK\x03\x04gerber-zip-bytes'),
  bom: Buffer.from('Designator,Supplier Part\nU1,C100000\n'),
  cpl: Buffer.from('Designator,Mid X,Mid Y,Layer,Rotation\nU1,10mm,-20mm,T,0\n'),
});

/** 模拟桥：导出命令返回元数据，分片命令回传真字节（走真实落盘/哈希代码）。 */
function fakeBridge(payloads) {
  const calls = [];
  const execute = async (commandId, args, options) => {
    calls.push({ commandId, args, options });
    if (commandId === 'pcb.manufacture.export' || commandId === 'pcb.3d.export') {
      const body = payloads[args.kind ?? 'step'];
      if (!body) return { result: null };
      const size = body.length;
      const chunkSize = 262144;
      return { result: { exportId: `exp-${args.kind ?? 'step'}123456`, kind: args.kind ?? 'step', name: `${args.fileName}.bin`, size, chunkSize, chunks: Math.max(1, Math.ceil(size / chunkSize)) } };
    }
    if (commandId === 'pcb.export.chunk' || commandId === 'pcb.3d.chunk') {
      const kind = String(args.exportId).replace(/^exp-/, '').replace(/123456$/, '');
      const body = payloads[kind];
      const chunkSize = 262144;
      const total = Math.max(1, Math.ceil(body.length / chunkSize));
      const start = args.index * chunkSize;
      const slice = body.subarray(start, Math.min(start + chunkSize, body.length));
      return { result: { index: args.index, total, bytes: slice.length, size: body.length, base64: Buffer.from(slice).toString('base64') } };
    }
    throw new Error(`未预期的命令 ${commandId}`);
  };
  return { execute, calls };
}

/** 在目标目录里预置"已签核"的产物文件（默认用草稿名，模拟用户先出草稿再签核）。 */
function seedArtifacts(dir, payloads, { outputClass = 'draft' } = {}) {
  writeFileSync(join(dir, artifactName({ base: 'GERBER_CircuitPilot-gerber', ext: 'zip', outputClass }).name), payloads.gerber);
  writeFileSync(join(dir, artifactName({ base: 'BOM_CircuitPilot-bom', ext: 'csv', outputClass }).name), payloads.bom);
  writeFileSync(join(dir, artifactName({ base: 'CPL_CircuitPilot-cpl', ext: 'csv', outputClass }).name), payloads.cpl);
}

const finalExportDecision = () => ({ allowed: true, outputClass: 'final', ticket: 'ticket-final', gate: { fingerprint: { sha256: 'a'.repeat(64) } } });

test('P0-A：默认输出根改为产物根（artifactsRoot），不再默认写 release/<日期>', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-anchor-default-'));
  try {
    const payloads = EXPORT_PAYLOADS();
    const result = await runProductionExport({ decision: { allowed: true, outputClass: 'draft', ticket: 't' }, artifactsRoot: dir, execute: fakeBridge(payloads).execute });
    assert.equal(result.outputDir, dir);
    assert.equal(result.final, false);
    assert.ok(result.files.gerber.startsWith(dir), '不传 outDir 时必须落在 artifactsRoot');
    assert.deepEqual(readdirSync(dir).sort(), [...result.exported.map((item) => item.name).sort(), 'manifest.json'].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-A：导出产物与签核锚点一致 → 按正式命名落盘、final=true、清单 released', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-anchor-match-'));
  try {
    const binding = fullBinding();
    const payloads = EXPORT_PAYLOADS();
    seedArtifacts(dir, payloads, { outputClass: 'draft' });
    const signed = inspectProductionArtifacts(dir, binding).manifest.manifestHash;
    const verified = [];
    const result = await runProductionExport({
      decision: finalExportDecision(),
      artifactsRoot: dir,
      binding,
      signoffManifestHash: signed,
      execute: fakeBridge(payloads).execute,
      verify: ({ files, outputClass }) => { verified.push({ files, outputClass }); return { status: 'pass', blockingCount: 0, findings: [] }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.final, true);
    assert.equal(result.manifestHash, signed, '返回的锚点哈希必须就是签核哈希');
    assert.equal(result.outputDir, dir);
    const names = readdirSync(dir).sort();
    assert.ok(names.every((name) => !/DRAFT-NOT-FOR-ORDER/.test(name)), `正式导出不得留草稿名：${names.join('、')}`);
    assert.ok(names.includes('GERBER_CircuitPilot-gerber.zip'));
    assert.ok(names.includes('BOM_CircuitPilot-bom.csv'));
    assert.ok(names.includes('CPL_CircuitPilot-cpl.csv'));
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.outputClass, 'final');
    assert.equal(manifest.released, true);
    assert.equal(manifest.signoffAnchor.matched, true);
    assert.equal(verified[0].outputClass, 'draft', '锚点模式先按草稿名导出/复核，比较通过后才转正');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-A：签核后文件被改过（导出内容≠签核物料）→ MANIFEST_DRIFT 409，且不留下正式命名产物', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-anchor-drift-'));
  try {
    const binding = fullBinding();
    const original = EXPORT_PAYLOADS();
    seedArtifacts(dir, original, { outputClass: 'final' }); // 已签核的是正式名文件
    const signed = inspectProductionArtifacts(dir, binding).manifest.manifestHash;
    const changed = EXPORT_PAYLOADS();
    changed.bom = Buffer.from('Designator,Supplier Part\nU1,C999999\n'); // 签核后物料被改
    await assert.rejects(
      () => runProductionExport({ decision: finalExportDecision(), artifactsRoot: dir, binding, signoffManifestHash: signed, execute: fakeBridge(changed).execute }),
      (error) => {
        assert.equal(error.code, PRODUCTION_EXPORT_CODES.MANIFEST_DRIFT);
        assert.equal(error.status, 409);
        assert.equal(error.details.signoffManifestHash, signed);
        assert.ok(error.details.manifestHash && error.details.manifestHash !== signed);
        assert.equal(error.details.outputDir, dir);
        return true;
      },
    );
    const names = readdirSync(dir).sort();
    assert.ok(!names.includes('manifest.json'), '漂移时不许写清单（清单=可交付凭据）');
    assert.ok(names.every((name) => /DRAFT-NOT-FOR-ORDER/.test(name)), `漂移时必须保留草稿标记，实际：${names.join('、')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-A：锚点模式复核不通过 → 不转正、不写清单（沿用"复核没过不算交付物"）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-anchor-verify-fail-'));
  try {
    const binding = fullBinding();
    const payloads = EXPORT_PAYLOADS();
    seedArtifacts(dir, payloads, { outputClass: 'draft' });
    const signed = inspectProductionArtifacts(dir, binding).manifest.manifestHash;
    const result = await runProductionExport({
      decision: finalExportDecision(), artifactsRoot: dir, binding, signoffManifestHash: signed,
      execute: fakeBridge(payloads).execute,
      verify: () => ({ status: 'fail', blockingCount: 1, findings: [{ code: 'BOM_FIELD_MISSING' }] }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PRODUCTION_EXPORT_CODES.VERIFY_FAILED);
    assert.equal(result.final, false);
    assert.equal(readdirSync(dir).some((name) => name === 'manifest.json'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
