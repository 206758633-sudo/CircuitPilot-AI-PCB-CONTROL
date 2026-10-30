import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELEASE_CODES, classifyGerberEntries, decodeText, designFingerprint, gateArtifacts, gateDrc, gateFabricationRelease,
  gateEngineering, gatePlacement, gateSchematic, gateSimulation, gateSupply, isDraftArtifact, parseTable, readZipEntries,
} from '../release-gate.mjs';
import { PRODUCTION_OUTPUT_CODES } from '../production-release.mjs';

const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

/** 手搓一个只有中央目录的 zip：用来验证"条目数与 EOCD 声明是否一致"。 */
function fakeZip(names) {
  const records = names.map((name) => {
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(46);
    header.write('PK\x01\x02', 0, 'latin1');
    header.writeUInt32LE(100, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    return Buffer.concat([header, nameBytes]);
  });
  const eocd = Buffer.alloc(22);
  eocd.write('PK\x05\x06', 0, 'latin1');
  eocd.writeUInt16LE(names.length, 10);
  return Buffer.concat([...records, eocd]);
}

const goodAcceptance = () => ({
  ready: true,
  netlist: { components: 8, nets: 13, namedPins: 59 },
  findings: [],
  designChecks: {
    summary: { total: 2, passed: 2, failed: 0, notRun: 0, notApplicable: 0, simulated: true },
    results: [{ id: 'cc-rd', title: 'CC Rd', status: 'pass', spec: '0.25~0.61V', measured: { cc1: 0.4173 } }],
  },
});

const goodBomRows = (designators = ['U1', 'U2']) => designators.map((ref, index) => ({ No: String(index + 1), Quantity: '1', Designator: ref, Value: '', 'Supplier Part': `C${100000 + index}`, Supplier: 'LCSC' }));
const goodCplRows = (placement) => placement.map((item) => ({ Designator: item.ref, 'Mid X': `${item.xMm}mm`, 'Mid Y': `${item.yMm}mm`, Layer: 'T', Rotation: String(item.rotationDeg ?? 0) }));

function goodArtifacts({ placement = [{ ref: 'U1', xMm: 10, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }], boardLayerCount = 6, draft = false } = {}) {
  const names = ['Gerber_TopLayer.GTL', 'Gerber_BottomLayer.GBL', 'Gerber_InnerLayer1.G1', 'Gerber_InnerLayer2.G2', 'Gerber_InnerLayer3.G3', 'Gerber_InnerLayer4.G4', 'Gerber_BoardOutlineLayer.GKO', 'Drill_PTH_Through.DRL'];
  const suffix = draft ? '-DRAFT-NOT-FOR-ORDER' : '';
  return [
    { kind: 'gerber', path: `/x/GERBER${suffix}.zip`, bytes: 4000, entries: readZipEntries(fakeZip(names)).entries, archive: { declaredCount: names.length, consistent: true }, gerber: classifyGerberEntries(names) },
    { kind: 'bom', path: `/x/BOM${suffix}.csv`, bytes: 900, headers: ['No', 'Quantity', 'Designator', 'Value', 'Supplier Part', 'Supplier'], rows: goodBomRows(placement.map((item) => item.ref)), delimiter: '\t' },
    { kind: 'cpl', path: `/x/CPL${suffix}.csv`, bytes: 1200, headers: ['Designator', 'Device', 'Footprint', 'Mid X', 'Mid Y', 'Layer', 'Rotation'], rows: goodCplRows(placement), delimiter: '\t' },
    { kind: 'step', path: `/x/STEP${suffix}.step`, bytes: 10500000, head: 'ISO-10303-21;\nHEADER;' },
    { kind: '_boardLayerCount', path: null, bytes: 0 },
  ].filter((item) => item.kind !== '_boardLayerCount').map((item) => ({ ...item, boardLayerCount }));
}

const goodDesign = (placement = [{ ref: 'U1', xMm: 10, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }]) => ({
  designators: placement.map((item) => item.ref), placement, boardLayerCount: 6, coordinateToleranceMm: 0.05,
});

test('读取层：UTF-16LE/Tab 的"CSV"必须能读出来（真机产物就是这样）', () => {
  const buffer = utf16('No\tDesignator\tSupplier Part\r\n1\tU1\tC529344\r\n');
  const table = parseTable(decodeText(buffer));
  assert.equal(table.delimiter, '\t');
  assert.deepEqual(table.headers, ['No', 'Designator', 'Supplier Part']);
  assert.equal(table.rows[0].Designator, 'U1');
  assert.equal(table.rows[0]['Supplier Part'], 'C529344');
  // UTF-8 + 逗号也必须能读
  const csv = parseTable('a,b\n1,2\n');
  assert.equal(csv.delimiter, ',');
  assert.equal(csv.rows[0].b, '2');
});

test('压缩包：条目数与 EOCD 声明不符时必须报出来（截断的 zip 不能当完整产物）', () => {
  const zip = fakeZip(['a.GTL', 'b.GBL', 'c.GKO']);
  const parsed = readZipEntries(zip);
  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.declaredCount, 3);
  assert.equal(parsed.consistent, true);
  const broken = Buffer.from(zip);
  broken.writeUInt16LE(9, broken.length - 12); // EOCD 声明 9 个，实际 3 个
  assert.equal(readZipEntries(broken).consistent, false);
});

test('草稿标记：产物自己写着 DRAFT/NOT-FOR-ORDER 就必须拦住', () => {
  assert.equal(isDraftArtifact('BOM_CircuitPilot-bom-DRAFT-NOT-FOR-ORDER.csv.csv'), true);
  assert.equal(isDraftArtifact('GERBER_final.zip'), false);
  const gate = gateArtifacts({ artifacts: goodArtifacts({ draft: true }), design: goodDesign() });
  assert.equal(gate.status, 'blocked');
  assert.ok(gate.findings.some((item) => item.code === RELEASE_CODES.ARTIFACT_DRAFT_MARKER));
});

test('Gerber：6 层板少一层内层铜必须拦住；缺板框/钻孔也必须拦住', () => {
  const names = ['Gerber_TopLayer.GTL', 'Gerber_BottomLayer.GBL', 'Gerber_InnerLayer1.G1', 'Gerber_BoardOutlineLayer.GKO', 'Drill_PTH_Through.DRL'];
  const artifacts = goodArtifacts();
  artifacts[0] = { ...artifacts[0], entries: readZipEntries(fakeZip(names)).entries, gerber: classifyGerberEntries(names) };
  const gate = gateArtifacts({ artifacts, design: goodDesign() });
  const blocking = gate.findings.find((item) => item.code === RELEASE_CODES.GERBER_COPPER_MISSING);
  assert.ok(blocking, JSON.stringify(gate.findings.map((item) => item.code)));
  assert.match(blocking.message, /铜层数\(3\)与 PCB 铜箔层数\(6\)不符/);
  const noOutline = classifyGerberEntries(['Gerber_TopLayer.GTL', 'Gerber_BottomLayer.GBL']);
  assert.equal(noOutline.outline.length, 0);
  assert.equal(noOutline.copper.inner.length, 0);
});

test('BOM/CPL 位号必须与网表对齐；CPL 坐标必须与实机读回对齐', () => {
  const design = goodDesign();
  const artifacts = goodArtifacts();
  assert.equal(gateArtifacts({ artifacts, design }).status, 'pass', JSON.stringify(gateArtifacts({ artifacts, design }).findings));
  // BOM 少一颗 → 阻断
  artifacts[1] = { ...artifacts[1], rows: goodBomRows(['U1']) };
  let gate = gateArtifacts({ artifacts, design });
  assert.ok(gate.findings.some((item) => item.code === RELEASE_CODES.BOM_DESIGNATOR_MISMATCH && /缺 U2/.test(item.message)));
  assert.equal(gate.status, 'blocked');
  // CPL 坐标对不上（板子被移动过但 CPL 没重导）→ 阻断
  const artifacts2 = goodArtifacts();
  artifacts2[2] = { ...artifacts2[2], rows: goodCplRows([{ ref: 'U1', xMm: 20, yMm: -30 }, { ref: 'U2', xMm: 28, yMm: -11 }]) };
  gate = gateArtifacts({ artifacts: artifacts2, design });
  const mismatch = gate.findings.find((item) => item.code === RELEASE_CODES.CPL_COORD_MISMATCH);
  assert.ok(mismatch, JSON.stringify(gate.findings.map((item) => item.code)));
  assert.match(mismatch.message, /U1\(偏差 14\.142mm\)/);
  // 阻容感没有 Value → 阻断（芯片允许 Value 为空）
  const artifacts3 = goodArtifacts();
  artifacts3[1] = { ...artifacts3[1], rows: [...goodBomRows(['U1']), { No: '2', Quantity: '2', Designator: 'R1, R2', Value: '', 'Supplier Part': 'C1', Supplier: 'LCSC' }] };
  gate = gateArtifacts({ artifacts: artifacts3, design: { ...design, designators: ['U1'] } });
  assert.ok(gate.findings.some((item) => item.code === RELEASE_CODES.BOM_VALUE_MISSING));
});

test('DRC：未解释项阻断、豁免项只是警告、报告缺失算"不知道"', () => {
  const items = [
    { errorType: 'Clearance Error', ruleName: '间距', layer: 'Top', obj1Type: 'track', obj2Type: 'pad', position: { x: 1, y: 2 }, data: { net: 'GND' } },
    { errorType: 'Connection Error', ruleName: '连接', layer: '', obj1Type: 'pad', obj2Type: 'pad', position: { x: 3, y: 4 }, data: { net: '3V3' } },
  ];
  const report = { ok: true, items, reportedCount: 2, truncated: false, digest: 'd'.repeat(64) };
  const noExemptions = gateDrc({ report, exemptions: [] });
  assert.equal(noExemptions.status, 'blocked');
  assert.ok(noExemptions.findings.some((item) => item.code === RELEASE_CODES.DRC_UNEXPLAINED));
  // 清空间距类（可豁免）后，仍需面对 Connection Error（不可豁免）
  // 豁免的真实结构：kind 级必须给 match.errorType + 正整数 maxCount，且 reason/risk ≥8 字
  const exemptions = [{ id: 'clr-top', scope: 'kind', match: { errorType: 'Clearance Error' }, maxCount: 5, reason: '丝印区允许贴边显示', risk: '不影响电气功能与装配' }];
  const partial = gateDrc({ report: { ...report, items: [items[0]] }, exemptions });
  assert.equal(partial.status, 'warn');
  assert.ok(partial.findings.some((item) => item.code === RELEASE_CODES.DRC_EXEMPTED && item.severity === 'warning'));
  const stillBlocked = gateDrc({ report, exemptions });
  assert.equal(stillBlocked.status, 'blocked', '连接错误不可豁免，仍有未解释项');
  assert.equal(gateDrc({ report: null }).status, 'unknown');
  // 报告被截断＝没看全＝不许通过（这里唯一的问题是"没看全"，所以是 unknown 而不是 blocked）
  const truncated = gateDrc({ report: { ...report, items: [items[0]], truncated: true }, exemptions });
  assert.equal(truncated.status, 'unknown');
  assert.ok(truncated.findings.some((item) => RELEASE_CODES.DRC_EVIDENCE_MISSING === item.code && /截断/.test(item.message)));
  // 豁免理由不足 8 个字 → 豁免无效 → 那条问题退回"未处理"
  const weakExemption = gateDrc({ report: { ...report, items: [items[0]] }, exemptions: [{ id: 'x', scope: 'kind', match: { errorType: 'Clearance Error' }, maxCount: 5, reason: '允许', risk: '没事' }] });
  assert.equal(weakExemption.status, 'blocked');
  assert.ok(weakExemption.findings.some((item) => item.code === RELEASE_CODES.DRC_EXEMPTION_INVALID));
});

test('布局：复核不通过、没人确认过 → 都必须阻断', () => {
  const verified = { ok: true, checkedCount: 8, findings: [] };
  assert.equal(gatePlacement({ placementVerification: verified, userConfirmed: false }).status, 'blocked');
  assert.equal(gatePlacement({ placementVerification: verified, userConfirmed: true }).status, 'pass');
  const notVerified = { ok: false, findings: [{ severity: 'blocking', message: 'U1 在板框外' }] };
  const gate = gatePlacement({ placementVerification: notVerified, userConfirmed: true });
  assert.ok(gate.findings.some((item) => item.code === RELEASE_CODES.PLACEMENT_NOT_VERIFIED));
  assert.equal(gatePlacement({}).status, 'unknown', '没有布局证据＝不知道，不是通过');
  const rolledBack = gatePlacement({ placementVerification: verified, userConfirmed: true, writeback: { ok: false, rollback: { ok: true } } });
  assert.equal(rolledBack.status, 'warn');
});

test('原理图与仿真：证据缺失算"不知道"；仿真没跑成不算通过', () => {
  assert.equal(gateSchematic({}).status, 'unknown');
  assert.equal(gateSchematic({ acceptance: { ready: true, netlist: { components: 0, namedPins: 0 } } }).status, 'unknown');
  assert.equal(gateSchematic({ acceptance: goodAcceptance() }).status, 'pass');
  assert.equal(gateSchematic({ acceptance: { ...goodAcceptance(), ready: false, findings: [{ severity: 'blocking', message: 'CC1 悬空' }] } }).status, 'blocked');

  assert.equal(gateSimulation({}).status, 'unknown');
  assert.equal(gateSimulation({ acceptance: { designChecks: { summary: { simulated: false }, results: [] } } }).status, 'unknown');
  const failed = gateSimulation({ acceptance: { designChecks: { summary: { simulated: true, total: 2, passed: 0, failed: 2 }, results: [{ id: 'cc-rd', title: 'CC Rd', status: 'fail', spec: '0.25~0.61V', measured: { cc1: 5 }, defect: '缺 Rd' }] } } });
  assert.equal(failed.status, 'blocked');
  assert.match(failed.findings[0].message, /实测 \{"cc1":5\}/);
  assert.equal(gateSimulation({ acceptance: goodAcceptance() }).status, 'pass');
});

test('供应链：料号不是 Cxxxxx 阻断；价格库存缺失只警告（绝不用 0 冒充）', () => {
  const bom = { headers: ['Designator', 'Supplier Part'], rows: [{ Designator: 'U1', 'Supplier Part': 'C529344' }] };
  assert.equal(gateSupply({ bom, pricing: { entries: [{ lcsc: 'C529344', price: 1.2 }] } }).status, 'pass');
  const stale = gateSupply({ bom, pricing: { entries: [{ lcsc: 'C529344', price: 1.2 }], checkedAt: '2020-01-01T00:00:00Z', freshnessKnown: true } });
  assert.equal(stale.findings.some((item) => item.code === 'RELEASE_FRESHNESS_STALE'), true);
  assert.match(stale.findings.find((item) => item.code === 'RELEASE_FRESHNESS_STALE').message, /重新查价/);
  assert.equal(gateSupply({ bom, pricing: null }).status, 'warn');
  assert.match(gateSupply({ bom, pricing: null }).findings[0].message, /不猜价格/);
  const bad = gateSupply({ bom: { ...bom, rows: [{ Designator: 'U1', 'Supplier Part': 'UNKNOWN' }] }, pricing: null });
  assert.equal(bad.status, 'blocked');
});

test('合成裁决：证据齐全 → ready-to-order；缺一环 → blocked；指纹可复现', () => {
  const placement = [{ ref: 'U1', xMm: 10, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }];
  const base = {
    acceptance: goodAcceptance(),
    drcReport: { ok: true, items: [], reportedCount: 0, truncated: false, digest: 'd'.repeat(64) },
    placementVerification: { ok: true, checkedCount: 2, findings: [] },
    userConfirmed: true,
    artifacts: goodArtifacts({ placement }),
    design: goodDesign(placement),
    pricing: { entries: [{ lcsc: 'C100000' }, { lcsc: 'C100001' }], freshnessKnown: true },
  };
  const ready = gateFabricationRelease(base);
  assert.equal(ready.ready, true, JSON.stringify(ready.blockers));
  assert.equal(ready.verdict, 'ready-to-order');
  assert.equal(ready.humanSignoffRequired, true, '机器只能摆证据，下单永远要人签字');
  assert.equal(ready.fingerprint.sha256.length, 64);

  const blocked = gateFabricationRelease({ ...base, userConfirmed: false });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.verdict, 'blocked');
  assert.ok(blocked.blockers.some((item) => item.code === RELEASE_CODES.PLACEMENT_NOT_CONFIRMED));

  // 指纹随设计变化：布局动一颗器件，指纹必须变
  const moved = gateFabricationRelease({ ...base, design: goodDesign([{ ref: 'U1', xMm: 11, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }]) });
  assert.notEqual(moved.fingerprint.sha256, ready.fingerprint.sha256);

  // 全空输入 → 一条都不能放行
  const empty = gateFabricationRelease({});
  assert.equal(empty.ready, false);
  assert.ok(empty.blockers.length >= 5);
  assert.equal(empty.verdict, 'blocked');
});

test('P0-6：门禁报告把「本次将覆盖的自产草稿」传给 outputDecision，正式导出按钮才可能解锁', () => {
  const placement = [{ ref: 'U1', xMm: 10, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }];
  const base = {
    acceptance: goodAcceptance(),
    drcReport: { ok: true, items: [], reportedCount: 0, truncated: false, digest: 'd'.repeat(64) },
    placementVerification: { ok: true, checkedCount: 2, findings: [] },
    userConfirmed: true,
    design: goodDesign(placement),
    pricing: { entries: [{ lcsc: 'C100000' }, { lcsc: 'C100001' }], freshnessKnown: true },
  };
  const draftArtifacts = goodArtifacts({ placement, draft: true });
  const draftPaths = draftArtifacts.map((artifact) => artifact.path);
  // 不传替换清单（修复前的实际行为）：门禁仍可见草稿，outputDecision 明确拒绝。
  const withoutReplacement = gateFabricationRelease({ ...base, artifacts: draftArtifacts });
  assert.equal(withoutReplacement.ready, false);
  assert.ok(withoutReplacement.blockers.some((item) => item.code === RELEASE_CODES.ARTIFACT_DRAFT_MARKER));
  assert.equal(withoutReplacement.outputDecision.allowed, false);
  assert.equal(withoutReplacement.outputDecision.code, PRODUCTION_OUTPUT_CODES.BLOCKED);
  // 传了替换清单：门禁与 outputDecision 必须给出一致结论（单一事实来源）。
  const withReplacement = gateFabricationRelease({ ...base, artifacts: draftArtifacts, draftPathsReplaced: draftPaths });
  assert.equal(withReplacement.ready, true);
  assert.equal(withReplacement.outputDecision.allowed, true);
  assert.equal(withReplacement.outputDecision.outputClass, 'final');
  assert.deepEqual(withReplacement.outputDecision.replacedDrafts.sort(), [...draftPaths].sort());
});

test('指纹包含网络表哈希、板框与 DRC 摘要（产物对不上设计时才有依据）', () => {
  const a = designFingerprint({ netlistSha256: 'a'.repeat(64), outlineSource: [0, 0, 1, 0], placement: [{ ref: 'U1', xMm: 1, yMm: 2 }], drcDigest: 'x' });
  const b = designFingerprint({ netlistSha256: 'b'.repeat(64), outlineSource: [0, 0, 1, 0], placement: [{ ref: 'U1', xMm: 1, yMm: 2 }], drcDigest: 'x' });
  assert.notEqual(a.sha256, b.sha256);
  assert.equal(a.parts.netlistSha256, 'a'.repeat(64));
  assert.deepEqual(a.parts.placement, ['U1@1/2/0']);
});

test('A16：未提供工程分析 → 显式 skipped（不冒充通过、也不阻断旧调用）', () => {
  const skipped = gateEngineering({});
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.blockingCount, 0);
  assert.match(skipped.findings[0].message, /未纳入本次放行/);

  const placement = [{ ref: 'U1', xMm: 10, yMm: -20 }, { ref: 'U2', xMm: 28, yMm: -11 }];
  const base = {
    acceptance: goodAcceptance(),
    drcReport: { ok: true, items: [], reportedCount: 0, truncated: false, digest: 'd'.repeat(64) },
    placementVerification: { ok: true, checkedCount: 2, findings: [] },
    userConfirmed: true,
    artifacts: goodArtifacts({ placement }),
    design: goodDesign(placement),
    pricing: { entries: [{ lcsc: 'C100000' }, { lcsc: 'C100001' }], freshnessKnown: true },
  };
  const report = gateFabricationRelease(base);
  assert.equal(report.ready, true);
  const engineeringGate = report.gates.find((item) => item.id === 'engineering');
  assert.equal(engineeringGate.status, 'skipped');
});

test('A16：工程分析 blocking → 阻断放行；warning → 只告警；布局审计未通过 → 阻断', () => {
  const blockingAnalysis = { reportHash: 'h1', passed: false, findings: [{ code: 'RF_SIM_EVIDENCE_MISSING', severity: 'blocking', message: 'RF 网络缺外部仿真证据', path: '/rf' }, { code: 'SILK_OVERLAP', severity: 'warning', message: '丝印重叠' }] };
  const gateResult = gateEngineering({ analysis: blockingAnalysis });
  assert.equal(gateResult.status, 'blocked');
  assert.ok(gateResult.findings.some((item) => item.code === RELEASE_CODES.ENGINEERING_BLOCKED));
  assert.ok(gateResult.findings.some((item) => item.code === RELEASE_CODES.ENGINEERING_WARNING));

  const available = { acceptance: goodAcceptance(), userConfirmed: true, drcReport: { ok: true, items: [], digest: 'd'.repeat(64) }, placementVerification: { ok: true, checkedCount: 1, findings: [] } };
  const blocked = gateFabricationRelease({ ...available, engineering: blockingAnalysis });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.some((item) => item.code === RELEASE_CODES.ENGINEERING_BLOCKED));

  const warningOnly = gateEngineering({ analysis: { passed: true, findings: [{ code: 'SILK_OVERLAP', severity: 'warning', message: '丝印重叠' }] } });
  assert.equal(warningOnly.status, 'warn');

  const layoutBlocked = gateEngineering({ layoutAudit: { auditHash: 'a1', passed: false, releaseReady: false, summary: { blockingFailures: 2 }, findings: [] } });
  assert.equal(layoutBlocked.status, 'blocked');
  assert.ok(layoutBlocked.findings.some((item) => item.code === RELEASE_CODES.LAYOUT_RULES_BLOCKED));

  const notReady = gateEngineering({ analysis: { reportHash: 'h2', passed: true, releaseReady: false, findings: [] } });
  assert.equal(notReady.status, 'blocked');
  assert.ok(notReady.findings.some((item) => item.code === RELEASE_CODES.ENGINEERING_NOT_READY));
});

test('A16：豁免必须带理由/能匹配；未匹配单独告警，不静默忽略', () => {
  const analysis = { passed: false, findings: [{ code: 'RF_SIM_EVIDENCE_MISSING', severity: 'blocking', message: 'RF 缺外部仿真证据' }, { code: 'IMPEDANCE_UNSOLVED', severity: 'blocking', message: '阻抗未求解' }] };
  const exempted = gateEngineering({ analysis, exemptions: [{ code: 'RF_SIM_EVIDENCE_MISSING', reason: '本板 RF 频段低，已人工评估' }] });
  assert.equal(exempted.status, 'blocked', '只豁免一项，另一项仍阻断');
  assert.equal(exempted.evidence.exempted.length, 1);
  assert.ok(exempted.findings.some((item) => item.code === RELEASE_CODES.ENGINEERING_WARNING && item.message.includes('已人工评估')));
  assert.ok(exempted.findings.some((item) => item.code === RELEASE_CODES.ENGINEERING_EXEMPTION_INVALID === false));

  const missingReason = gateEngineering({ analysis, exemptions: [{ code: 'RF_SIM_EVIDENCE_MISSING' }] });
  assert.ok(missingReason.findings.some((item) => item.code === RELEASE_CODES.ENGINEERING_EXEMPTION_INVALID));
  assert.equal(missingReason.status, 'blocked', '无效豁免不能把阻断洗掉');

  const unused = gateEngineering({ layoutAudit: { passed: true, findings: [] }, exemptions: [{ code: 'NOT_A_REAL_CODE', reason: '写错了' }] });
  assert.equal(unused.status, 'warn');
  assert.ok(unused.findings.some((item) => item.code === RELEASE_CODES.ENGINEERING_EXEMPTION_UNUSED));

  const fullyExempted = gateEngineering({ analysis, exemptions: [{ code: 'RF_SIM_EVIDENCE_MISSING', reason: '人工评估通过' }, { code: 'IMPEDANCE_UNSOLVED', reason: '改用外置匹配' }] });
  assert.equal(fullyExempted.status, 'warn');
  assert.ok(fullyExempted.findings.every((item) => item.severity !== 'blocking'));
});

test('CPL 坐标：非对称封装允许用"器件原点"基准核对（EDA CPL 的 Mid X/Y 就是原点）', () => {
  // 真机 U1(USB-C) 包围盒中心与器件原点差 1.5mm：只看中心会稳定误报，导致"CPL 坐标不一致"永久阻断。
  const placement = [{ ref: 'U1', xMm: 10, yMm: -20, originXMm: 8.5, originYMm: -21.5 }];
  const cplRows = [{ Designator: 'U1', 'Mid X': '8.5mm', 'Mid Y': '-21.5mm', Layer: 'T', Rotation: '0' }];
  const artifacts = [{ kind: 'cpl', path: '/x/CPL.csv', bytes: 100, headers: ['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'], rows: cplRows }];
  const gate = gateArtifacts({ artifacts, design: { placement, coordinateToleranceMm: 0.05 } });
  assert.equal(gate.findings.filter((item) => item.code === RELEASE_CODES.CPL_COORD_MISMATCH && item.severity === 'blocking').length, 0, JSON.stringify(gate.findings));
  const passed = gate.findings.find((item) => item.code === RELEASE_CODES.GATE_PASSED && /基准/.test(item.message));
  assert.ok(passed, '通过证据里必须写清用的是哪套基准');
  assert.match(passed.message, /origin/);

  // 对照：只有中心坐标（旧数据结构）时仍按中心比对 → 说明修复不是"永远放行"。
  const centerOnly = gateArtifacts({ artifacts, design: { placement: [{ ref: 'U1', xMm: 10, yMm: -20 }], coordinateToleranceMm: 0.05 } });
  assert.ok(centerOnly.findings.some((item) => item.code === RELEASE_CODES.CPL_COORD_MISMATCH && item.severity === 'blocking'));
});

test('仿真门禁：引用已落盘的仿真证据时，必须写明来源与覆盖范围，不能伪装成全电路仿真', () => {
  const gate = gateSimulation({ acceptance: { simulation: { evidenceHash: 'a'.repeat(64), source: 'solver-run', scopeNote: '外部网表 SPICE 仿真（覆盖关键电路而非全板）' } } });
  assert.equal(gate.status, 'pass');
  const passed = gate.findings.find((item) => item.code === RELEASE_CODES.GATE_PASSED);
  assert.match(passed.message, /solver-run/);
  assert.match(passed.message, /覆盖范围/);
  assert.equal(gate.evidence.source, 'solver-run');
});

// ---------------------------------------------------------------------------
// 第 61 轮：DRC 证据必须绑定当前 PCB；仿真证据"已消费 ≠ 通过"
// ---------------------------------------------------------------------------

const cleanDrcReport = (binding = {}) => ({ ok: true, items: [], reportedCount: 0, truncated: false, digest: 'd'.repeat(64), binding });

test('DRC 绑定：pcbUuid 与当前目标一致才认；不一致必须 blocking；缺 pcbUuid 必须 unknown', () => {
  const target = '5595e77cead09682';
  // 一致：在原有分类结论之外多一条"已绑定"的 info，状态仍 pass。
  const matched = gateDrc({ report: cleanDrcReport({ pcbUuid: target }), exemptions: [], targetPcbUuid: target });
  assert.equal(matched.status, 'pass', JSON.stringify(matched.findings));
  assert.equal(matched.evidence.binding.matched, true);
  assert.ok(matched.findings.some((item) => item.code === RELEASE_CODES.GATE_PASSED && /已绑定当前 PCB/.test(item.message)));

  // 不一致：这是"另一块板 DRC 干净"，绝不能当当前板结论 → blocking。
  const mismatch = gateDrc({ report: cleanDrcReport({ pcbUuid: '5d632dde4548e1a0' }), exemptions: [], targetPcbUuid: target });
  assert.equal(mismatch.status, 'blocked');
  const mismatchFinding = mismatch.findings.find((item) => item.code === RELEASE_CODES.DRC_EVIDENCE_PCB_MISMATCH);
  assert.ok(mismatchFinding, JSON.stringify(mismatch.findings.map((item) => item.code)));
  assert.match(mismatchFinding.message, /5d632dde4548e1a0/);
  assert.match(mismatchFinding.message, new RegExp(target));
  assert.equal(mismatch.evidence.binding.matched, false);

  // 证据缺 pcbUuid：无法归属 → unknown（不是通过，也不是"确定失败"）。
  const unbound = gateDrc({ report: cleanDrcReport({}), exemptions: [], targetPcbUuid: target });
  assert.equal(unbound.status, 'unknown');
  assert.ok(unbound.findings.some((item) => item.code === RELEASE_CODES.DRC_EVIDENCE_UNBOUND));

  // 没给当前目标（直接调用/离线报告）→ 保持旧行为，能判则判、不宣称绑定。
  const legacy = gateDrc({ report: cleanDrcReport({}), exemptions: [] });
  assert.equal(legacy.status, 'pass');
  assert.equal(legacy.evidence.binding.matched, null);
});

test('仿真证据：已消费但只有子电路 → unknown（不是通过）；校验不过 → 报具体原因而不是 NOT_RUN', () => {
  const partial = gateSimulation({
    acceptance: {
      simulation: {
        evidenceHash: 'a'.repeat(64), source: 'T3 外部网表 + ngspice 求解器', partial: true,
        scopeNote: 'USB-C VBUS→IP2312→VBAT；不是整板/全功能仿真',
        netlist: { sha256: 'a'.repeat(64), componentCount: 64, netCount: 34 },
        binding: { netlistSha256MatchedLive: true },
      },
    },
  });
  assert.equal(partial.status, 'unknown', '子电路仿真不能把整板放行');
  const coverage = partial.findings.find((item) => item.code === RELEASE_CODES.SIMULATION_COVERAGE_PARTIAL);
  assert.ok(coverage, JSON.stringify(partial.findings.map((item) => item.code)));
  assert.match(coverage.message, /整板 SPICE 模型仍缺失/);
  assert.equal(partial.evidence.partial, true);
  assert.equal(partial.evidence.binding.netlistSha256MatchedLive, true);

  // 服务端 fail-closed 校验没通过：把具体原因（绑定不符/缺失字段…）带进闸门。
  const invalid = gateSimulation({ acceptance: { simulation: { invalid: true, code: RELEASE_CODES.SIMULATION_EVIDENCE_UNBOUND, reason: '仿真证据属于工程 A，当前工程是 B', evidencePath: '/x.json' } } });
  assert.equal(invalid.status, 'unknown');
  assert.ok(invalid.findings.some((item) => item.code === RELEASE_CODES.SIMULATION_EVIDENCE_UNBOUND && /属于工程 A/.test(item.message)));
  // 没有 invalid 原因时兜底为"证据无效"，仍不是 NOT_RUN。
  const generic = gateSimulation({ acceptance: { simulation: { invalid: true } } });
  assert.ok(generic.findings.some((item) => item.code === RELEASE_CODES.SIMULATION_EVIDENCE_INVALID));

  // 完全没有仿真输入 → 仍是 NOT_RUN（"没提供"和"不可用"必须区分）。
  const notRun = gateSimulation({ acceptance: { ready: true, netlist: { components: 1, namedPins: 1 } } });
  assert.ok(notRun.findings.some((item) => item.code === RELEASE_CODES.SIMULATION_NOT_RUN));
});
