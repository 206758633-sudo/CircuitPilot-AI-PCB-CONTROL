import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_KINDS, KIND_SPECS, PRODUCTION_EXPORT_CODES, planProductionExport, runProductionExport, sanitizeArtifactVerification } from '../production-export.mjs';
import { DRAFT_MARKER } from '../production-release.mjs';

/**
 * 导出这条链的三条不可让步：**没裁决不写盘、命名由裁决决定、写完立刻复核**。
 */

const greenDecision = { allowed: true, outputClass: 'final', ticket: 'ticket-final', gate: { fingerprint: 'f'.repeat(64) } };
const draftDecision = { allowed: true, outputClass: 'draft', ticket: 'ticket-draft', gate: { fingerprint: 'f'.repeat(64) } };
const refusedDecision = { allowed: false, outputClass: null, code: 'PRODUCTION_OUTPUT_BLOCKED', blockers: ['RELEASE_DRC_UNEXPLAINED'] };

/** 模拟桥：导出命令返回元数据，分片命令按 base64 回传真字节（走真实的落盘/哈希/校验代码）。 */
function fakeBridge(payloads) {
  const calls = [];
  const execute = async (commandId, args, options) => {
    calls.push({ commandId, args, options });
    if (commandId === 'pcb.manufacture.export' || commandId === 'pcb.3d.export') {
      const body = payloads[args.kind ?? 'step'];
      if (!body) return { result: null };
      const size = body.length;
      const chunkSize = 262144;
      return { result: { exportId: `exp-${(args.kind ?? 'step')}123456`, kind: args.kind ?? 'step', name: `${args.fileName}.bin`, size, chunkSize, chunks: Math.max(1, Math.ceil(size / chunkSize)) } };
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

const tmp = (name) => mkdtempSync(join(tmpdir(), `cp-export-${name}-`));

test('没有裁决 / 裁决拒绝时：连目标文件名都不给，绝不先写盘', async () => {
  assert.throws(() => planProductionExport({ decision: refusedDecision, outDir: '/tmp/x' }), (error) => error.code === PRODUCTION_EXPORT_CODES.NOT_ALLOWED);
  assert.throws(() => planProductionExport({ decision: null, outDir: '/tmp/x' }), (error) => error.code === PRODUCTION_EXPORT_CODES.NOT_ALLOWED);
  const dir = join(tmp('refuse'), 'release');
  const bridge = fakeBridge({});
  await assert.rejects(() => runProductionExport({ decision: refusedDecision, outDir: dir, execute: bridge.execute }), (error) => error.code === PRODUCTION_EXPORT_CODES.NOT_ALLOWED);
  assert.equal(existsSync(dir), false, '被拒时连目录都不许建');
});

test('导出种类必须白名单：不许随手传个没实现的格式', () => {
  assert.throws(() => planProductionExport({ decision: greenDecision, outDir: '/tmp/x', kinds: ['gerber', 'pdf'] }), (error) => error.code === PRODUCTION_EXPORT_CODES.KINDS_INVALID);
  assert.throws(() => planProductionExport({ decision: greenDecision, outDir: '/tmp/x', kinds: [] }), (error) => error.code === PRODUCTION_EXPORT_CODES.KINDS_INVALID);
  assert.deepEqual(planProductionExport({ decision: greenDecision, outDir: '/tmp/x' }).targets.map((item) => item.kind), DEFAULT_KINDS);
});

test('命名由裁决决定：草稿带标记、正式不带，两者都落在同一目录前缀下', () => {
  const draft = planProductionExport({ decision: draftDecision, outDir: '/out' });
  const final = planProductionExport({ decision: greenDecision, outDir: '/out' });
  assert.deepEqual(draft.targets.map((item) => item.name), [
    `GERBER_CircuitPilot-gerber${DRAFT_MARKER}.zip`,
    `BOM_CircuitPilot-bom${DRAFT_MARKER}.csv`,
    `CPL_CircuitPilot-cpl${DRAFT_MARKER}.csv`,
  ]);
  assert.deepEqual(final.targets.map((item) => item.name), ['GERBER_CircuitPilot-gerber.zip', 'BOM_CircuitPilot-bom.csv', 'CPL_CircuitPilot-cpl.csv']);
  assert.ok(final.targets.every((item) => item.path.startsWith('/out/')));
});

test('真导出（模拟桥回传真字节）：文件字节与哈希对得上，清单落盘且可复核', async () => {
  const dir = tmp('draft-write');
  const bridge = fakeBridge({ gerber: Buffer.from('PK\x03\x04gerber-zip-bytes'), bom: Buffer.from('Designator,Supplier Part\nU1,C529344\n'), cpl: Buffer.from('Designator,Mid X,Mid Y\nU1,10mm,-20mm\n') });
  const result = await runProductionExport({ decision: draftDecision, outDir: dir, execute: bridge.execute, date: '2026-10-13T00:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.equal(result.exported.length, 3);
  for (const item of result.exported) {
    const bytes = readFileSync(item.path);
    assert.equal(bytes.length, item.bytes);
    assert.equal(readFileSync(item.path, 'utf8').length > 0, true);
  }
  const gerber = result.exported.find((item) => item.kind === 'gerber');
  assert.match(gerber.name, new RegExp(`${DRAFT_MARKER}\\.zip$`));
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, [...result.exported.map((item) => item.name).sort(), 'manifest.json'].sort());
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.outputClass, 'draft');
  assert.equal(manifest.decisionTicket, 'ticket-draft');
  assert.equal(manifest.released, false, '草稿永远不算"已放行"');
  assert.equal(manifest.humanSignoffRequired, true);
  assert.equal(result.manifest.manifestSha256.length, 64);
  rmSync(dir, { recursive: true, force: true });
});

test('正式产出 + 复核通过 → released=true；复核不通过 → 明确失败且不写清单', async () => {
  const bridge = fakeBridge({ gerber: Buffer.from('PK'), bom: Buffer.from('a'), cpl: Buffer.from('b') });
  const dirOk = tmp('final-ok');
  const ok = await runProductionExport({ decision: greenDecision, outDir: dirOk, execute: bridge.execute, verify: () => ({ status: 'pass', blockingCount: 0, findings: [] }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.manifest.released, true);
  assert.equal(ok.manifest.outputClass, 'final');
  rmSync(dirOk, { recursive: true, force: true });

  const dirBad = tmp('final-bad');
  const bad = await runProductionExport({ decision: greenDecision, outDir: dirBad, execute: bridge.execute, verify: () => ({ status: 'fail', blockingCount: 2, findings: [{ code: 'ARTIFACT_BOM_MISMATCH' }] }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, PRODUCTION_EXPORT_CODES.VERIFY_FAILED);
  assert.match(bad.message, /不能当交付物/);
  assert.equal(existsSync(join(dirBad, 'manifest.json')), false, '复核没过的产物不许有清单（清单=可交付的凭据）');
  rmSync(dirBad, { recursive: true, force: true });
});

test('字节数对不上：失败并删掉半截文件（"文件存在"绝不能被当成"导出成功"）', async () => {
  const dir = tmp('mismatch');
  const execute = async (commandId) => {
    if (commandId === 'pcb.manufacture.export') return { result: { exportId: 'exp-bom123456', kind: 'bom', name: 'BOM.csv', size: 999, chunkSize: 262144, chunks: 1 } };
    if (commandId === 'pcb.export.chunk') return { result: { index: 0, total: 1, bytes: 3, size: 3, base64: Buffer.from('abc').toString('base64') } };
    throw new Error(commandId);
  };
  await assert.rejects(() => runProductionExport({ decision: draftDecision, outDir: dir, kinds: ['bom'], execute }), (error) => error.code === 'EXPORT_SIZE_MISMATCH');
  assert.equal(readdirSync(dir).length, 0, '不许留半截文件');
  rmSync(dir, { recursive: true, force: true });
});

test('STEP 体积大：不在默认种类里，必须显式要', () => {
  assert.equal(DEFAULT_KINDS.includes('step'), false);
  const plan = planProductionExport({ decision: draftDecision, outDir: '/out', kinds: ['step'] });
  assert.equal(plan.targets[0].name, `STEP_CircuitPilot-step${DRAFT_MARKER}.step`);
  assert.equal(KIND_SPECS.step.edaFileName, 'CircuitPilot-Assembled-3D');
});

test('复核分两把尺子：草稿豁免"命名放行"检查、未申请的种类豁免"缺失"，且豁免必须写明原因', () => {
  const report = {
    id: 'artifacts', title: '生产文件', status: 'unknown', blockingCount: 4,
    findings: [
      { code: 'RELEASE_ARTIFACT_DRAFT_MARKER', severity: 'blocking', message: 'gerber 产物文件名自带草稿标记' },
      { code: 'RELEASE_ARTIFACT_MISSING', severity: 'unknown', message: '缺少 step 产物' },
      { code: 'RELEASE_GATE_PASSED', severity: 'info', message: 'CPL 坐标与实机读回一致' },
    ],
    evidence: {},
  };
  const draft = sanitizeArtifactVerification({ report, outputClass: 'draft', kinds: DEFAULT_KINDS });
  assert.equal(draft.status, 'pass');
  assert.equal(draft.blockingCount, 0);
  assert.equal(draft.findings.length, 1);
  assert.equal(draft.waived.length, 2);
  assert.ok(draft.waived.every((item) => item.why.length > 8), '豁免必须解释原因，否则就是隐瞒');

  // 正式产出：草稿标记不再豁免，必须挡住
  const final = sanitizeArtifactVerification({ report, outputClass: 'final', kinds: DEFAULT_KINDS });
  assert.equal(final.status, 'fail');
  assert.equal(final.blockingCount, 1);
  assert.equal(final.waived.length, 1, '正式产出只豁免"没申请 step"这一条');

  // 申请了 step 却没导出：缺失必须留下
  const withStep = sanitizeArtifactVerification({ report, outputClass: 'draft', kinds: [...DEFAULT_KINDS, 'step'] });
  assert.equal(withStep.status, 'fail');
  assert.ok(withStep.findings.some((item) => item.code === 'RELEASE_ARTIFACT_MISSING'));

  // 内容问题（跟类别无关）绝不被豁免
  const contentFail = sanitizeArtifactVerification({ report: { findings: [{ code: 'RELEASE_ARCHIVE_INCONSISTENT', severity: 'blocking', message: '压缩包被截断' }] }, outputClass: 'draft', kinds: DEFAULT_KINDS });
  assert.equal(contentFail.status, 'fail');
  assert.equal(contentFail.waived.length, 0);
});

test('导出是受控写入：只有裁决放行之后，导出命令才带 allowWrite 授权发出', async () => {
  const dir = tmp('authorized');
  const bridge = fakeBridge({ gerber: Buffer.from('PK'), bom: Buffer.from('a'), cpl: Buffer.from('b') });
  // 被拒时连一条命令都不该发出去
  await assert.rejects(() => runProductionExport({ decision: refusedDecision, outDir: dir, execute: bridge.execute }));
  assert.equal(bridge.calls.filter((call) => call.commandId === 'pcb.manufacture.export').length, 0, '没获准就不许向 EDA 发导出命令');

  const ok = await runProductionExport({ decision: draftDecision, outDir: dir, execute: bridge.execute });
  assert.equal(ok.ok, true);
  const exportCalls = bridge.calls.filter((call) => call.commandId === 'pcb.manufacture.export');
  assert.equal(exportCalls.length, 3);
  assert.ok(exportCalls.every((call) => call.options?.allowWrite === true), '导出必须显式受控授权');
  // 读取分片不需要写授权：授权面越小越好
  const chunkCalls = bridge.calls.filter((call) => call.commandId === 'pcb.export.chunk');
  assert.ok(chunkCalls.every((call) => call.options?.allowWrite !== true));
  rmSync(dir, { recursive: true, force: true });
});
