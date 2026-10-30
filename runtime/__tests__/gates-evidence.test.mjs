import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GATES_EVIDENCE_CODES, collectGateEvidence } from '../gates-evidence.mjs';
import { createEvidenceStore } from '../evidence-store.mjs';
import { assertEvidenceEnvelope } from '../evidence-contract.mjs';
import { createGateService } from '../gates-service.mjs';

/**
 * P0-2 / task-16：六道门的证据生产者。
 *
 * 修复前 G1/G5/G6 没有生产者（门禁标"未实现"），G2/G3/G4 才有。本测试锁：
 *   1. 六类输入齐备时六类证据真的落盘，且都带 pcbUuid（否则门禁按 pcbUuid 查不到）；
 *   2. 输入缺失只进 missing，输入不完整落 blocked/unknown，绝不伪造 pass；
 *   3. 落盘后 gates-service 能从证据推导出六门结论（不再 unknown / not-implemented）。
 */

const cleanErc = { schemaVersion: 1, findings: [], digest: 'e'.repeat(64) };
const cleanDrc = { items: [], itemCount: 0 };
const matchingNetlist = {
  intent: { netIntent: [{ net: 'VCC', endpoints: [{ ref: 'U1', pin: '1' }, { ref: 'C1', pin: '1' }] }] },
  actual: { nets: [{ name: 'VCC', endpoints: [{ ref: 'U1', pin: '1' }, { ref: 'C1', pin: '1' }] }] },
};
const verifiedComponent = () => ({
  refdes: 'U1',
  lcscId: 'C100000',
  eda: { lcscId: 'C100000', footprint: 'SMD', model3D: 'U1.step' },
  supply: { lcscId: 'C100000', package: 'SMD-2', checkedAt: '2026-10-29T00:00:00.000Z' },
  datasheet: { ok: true },
});

/** G1 的合法输入：`buildDesignSpec` 生成器输入（不是已校验 spec，覆盖"由模块生成"路径）。 */
const completeSpec = () => ({
  project: { id: 'proj-1', name: '测试工程' },
  boards: [{ id: 'board-1', name: '主控板', layers: 2, outline: { widthMm: 20, heightMm: 15 } }],
  netIntent: [{ net: 'VCC', endpoints: ['U1.1', 'C1.1'] }],
  bomLock: [{ ref: 'U1', lcscId: 'C100000', value: 'MCU', footprint: 'SMD', locked: true }],
  requirements: [{ id: 'REQ-1', category: 'power', requirement: '3.3V 供电' }],
});

/** G5 的合法输入：verifyOutlinePlacement 的结果形状。 */
const passedPlacement = () => ({ ok: true, blockingCount: 0, checkedCount: 3, findings: [] });

/** G6 的合法输入：gateFabricationRelease 报告形状。 */
const readyFabricationRelease = () => ({
  kind: 'fabrication-release-gate',
  ready: true,
  verdict: 'ready-to-order',
  blockers: [],
  warnings: [],
  gates: [{ id: 'artifacts', verdict: 'pass' }],
  outputDecision: { outputClass: 'final' },
  fingerprint: { sha256: 'f'.repeat(64) },
});

const fullInputs = () => ({
  erc: cleanErc,
  drc: cleanDrc,
  intentNetlist: matchingNetlist.intent,
  actualNetlist: matchingNetlist.actual,
  components: [verifiedComponent()],
  spec: completeSpec(),
  placement: passedPlacement(),
  fabricationRelease: readyFabricationRelease(),
});

/** 内存证据库：只实现 collectGateEvidence 需要的 save（并记录 fingerprint，供断言）。 */
function memoryStore() {
  const entries = [];
  return {
    entries,
    save({ kind, payload, fingerprint = {}, note = null }) {
      const entry = { kind, payload, fingerprint, note, digest: `${kind}-digest-${entries.length + 1}`, path: `/mem/${kind}/${entries.length + 1}.json`, savedAt: new Date().toISOString() };
      entries.push(entry);
      return entry;
    },
  };
}

test('P0-2：六类输入齐备 → design-spec/lib-evidence/netlist-diff/rules/placement/fabrication-release 全部落盘，指纹绑定 pcbUuid，信封过统一契约', () => {
  const store = memoryStore();
  const result = collectGateEvidence({
    evidenceStore: store,
    pcbUuid: 'pcb-1',
    projectId: 'proj-1',
    ...fullInputs(),
  });

  const sixKinds = ['design-spec', 'fabrication-release', 'lib-evidence', 'netlist-diff', 'placement', 'rules'];
  assert.deepEqual(result.saved.map((item) => item.kind).sort(), sixKinds);
  assert.equal(result.missing.length, 0, `输入齐备不应有 missing：${JSON.stringify(result.missing)}`);
  assert.equal(result.report.complete, true);
  assert.deepEqual(result.report.producedKinds.sort(), sixKinds);

  for (const entry of store.entries) {
    assert.equal(entry.fingerprint.pcbUuid, 'pcb-1', `${entry.kind} 的门禁查询指纹必须带 pcbUuid`);
    assert.equal(entry.fingerprint.projectId, 'proj-1');
    assert.equal(entry.payload.fingerprint?.pcbUuid, 'pcb-1', `${entry.kind} 证据内容本身也必须绑定 pcbUuid`);
    // 落盘内容必须过统一证据契约（fail-closed），否则门禁只会给“证据无效”。
    assert.doesNotThrow(() => assertEvidenceEnvelope(entry.payload), `${entry.kind} 证据必须符合统一契约`);
    assert.equal(entry.payload.source?.readOnly, true);
  }
  // 每一条的 verdict 是真实判定，不是硬编码 pass。
  for (const entry of store.entries) assert.equal(entry.payload.verdict, 'pass', `${entry.kind} 在输入齐备时应如实判 pass`);
  const spec = store.entries.find((entry) => entry.kind === 'design-spec').payload;
  assert.equal(spec.counts.boards, 1);
  assert.equal(spec.counts.requirements, 1);
  assert.match(spec.fingerprint.specDigest, /^[0-9a-f]{64}$/);
});

test('P0-2：输入缺失只记 missing，不产生任何“通过”证据（绝不伪造）', () => {
  const store = memoryStore();
  const result = collectGateEvidence({ evidenceStore: store, pcbUuid: 'pcb-1' });
  assert.equal(result.saved.length, 0);
  assert.deepEqual(result.missing.map((item) => item.kind).sort(), ['design-spec', 'fabrication-release', 'lib-evidence', 'netlist-diff', 'placement', 'rules']);
  assert.equal(result.report.complete, false);
  assert.equal(result.report.blockedKinds.length, 0);
  for (const item of result.missing) assert.ok(item.reason.length > 8, `missing 必须说明缺什么：${JSON.stringify(item)}`);
});

test('P0-2：部分输入缺失 → 只落“不通过”的证据，missing 如实登记（半份报告不能当通过）', () => {
  const store = memoryStore();
  const result = collectGateEvidence({
    evidenceStore: store,
    pcbUuid: 'pcb-1',
    erc: cleanErc, // 只有 ERC、没有 DRC
    components: [{ refdes: 'U2' }], // 没有 LCSC 料号
  });
  const rules = store.entries.find((entry) => entry.kind === 'rules');
  assert.ok(rules, '有 ERC 就应该落一条规则证据（但只能是 unknown，不是 pass）');
  assert.notEqual(rules.payload.verdict, 'pass');
  assert.ok(result.missing.some((item) => item.kind === 'rules' && /DRC/.test(item.reason)));
  assert.ok(result.missing.some((item) => item.kind === 'lib-evidence' && /U2/.test(item.reason)));
  assert.ok(result.missing.some((item) => item.kind === 'netlist-diff'));
  assert.ok(result.missing.some((item) => item.kind === 'design-spec'));
  assert.ok(result.missing.some((item) => item.kind === 'placement'));
  assert.ok(result.missing.some((item) => item.kind === 'fabrication-release'));
  assert.equal(store.entries.filter((entry) => entry.kind === 'lib-evidence').length, 0, '缺料号不许编造 lib-evidence');
});

test('P0-2：多器件时 blocked 的放最后写 —— 即使有调用方按 latest 读，也不能被 pass 盖住', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-gates-evidence-'));
  try {
    const evidenceStore = createEvidenceStore({ root });
    const blockedComponent = { refdes: 'U2', lcscId: 'C200000' }; // 没有 EDA/供应商数据 → librarian 判 blocked
    const result = collectGateEvidence({
      evidenceStore,
      pcbUuid: 'pcb-9',
      erc: cleanErc,
      drc: cleanDrc,
      components: [blockedComponent, verifiedComponent()], // 故意把 blocked 放前面，靠生产者的排序兜底
    });
    const libSaved = result.saved.filter((item) => item.kind === 'lib-evidence');
    assert.equal(libSaved.length, 2);
    assert.equal(libSaved[libSaved.length - 1].verdict, 'blocked', '最后写入的必须是 blocked，latest 才 fail-closed');
    const latest = evidenceStore.latest('lib-evidence', { fingerprint: { pcbUuid: 'pcb-9' } });
    assert.equal(latest.payload.verdict, 'blocked');
    assert.ok(result.report.blockedKinds.includes('lib-evidence'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-2：六类证据落盘后 gates-service 六门全部可推导（G1~G6，不再 unknown / not-implemented）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-gates-service-'));
  try {
    const evidenceStore = createEvidenceStore({ root });
    collectGateEvidence({
      evidenceStore,
      pcbUuid: 'pcb-live',
      projectId: 'proj-live',
      ...fullInputs(),
    });
    const service = createGateService({ evidenceStore });
    const { report, evidenceRefs } = service.status({ pcbUuid: 'pcb-live' });
    const byId = Object.fromEntries(report.gates.map((gate) => [gate.id, gate]));
    for (const id of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
      assert.equal(byId[id].implemented, true, `${id} 应已接入生产者`);
      assert.equal(byId[id].missing.length, 0, `${id} 不应再缺证据：${byId[id].missing.join('/')}`);
      assert.equal(byId[id].verdict, 'pass', `${id} 在输入齐备时应可推导为 pass，实际 ${byId[id].verdict}`);
    }
    assert.deepEqual(report.notImplementedGates, []);
    assert.equal(report.verdict, 'pass', '六门齐备时整体裁决应为 pass');
    for (const kind of ['design-spec', 'lib-evidence', 'netlist-diff', 'rules', 'placement', 'fabrication-release']) {
      assert.ok(evidenceRefs.some((ref) => ref.kind === kind), `evidenceRefs 应保留 ${kind}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-2：G1 缺 spec → missing（门禁 unknown）；给了但不完整 → 落 blocked，不许当作未知以外的通过', () => {
  const absent = collectGateEvidence({ evidenceStore: memoryStore(), pcbUuid: 'pcb-1' });
  assert.ok(absent.missing.some((item) => item.kind === 'design-spec'));
  assert.equal(absent.saved.some((item) => item.kind === 'design-spec'), false, '没输入就不落 design-spec 证据');

  const store = memoryStore();
  const invalid = collectGateEvidence({
    evidenceStore: store,
    pcbUuid: 'pcb-1',
    spec: { project: { name: '只有名字' } }, // 缺 boards → validateDesignSpec 必抛
  });
  const saved = store.entries.find((entry) => entry.kind === 'design-spec');
  assert.ok(saved, '给了 spec 就应该落一条设计规格证据（哪怕它不完整）');
  assert.equal(saved.payload.verdict, 'blocked', '不完整 spec 必须 blocked，不能 pass');
  assert.ok(saved.payload.findings.some((finding) => finding.severity === 'error'));
  assert.equal(invalid.report.complete, false);
});

test('P0-2：G5 布局复核通过 → pass；有越界 blocking → blocked；未人工确认 → blocked；无结论 → unknown', () => {
  const pass = collectGateEvidence({ evidenceStore: memoryStore(), pcbUuid: 'pcb-1', placement: passedPlacement() });
  assert.equal(pass.saved.find((item) => item.kind === 'placement').verdict, 'pass');

  const blockedStore = memoryStore();
  collectGateEvidence({
    evidenceStore: blockedStore,
    pcbUuid: 'pcb-1',
    placement: { ok: false, blockingCount: 1, checkedCount: 2, findings: [{ code: 'PLACEMENT_OUTSIDE_OUTLINE', severity: 'blocking', field: 'U1', message: 'U1 有角落在板框外' }] },
  });
  const blocked = blockedStore.entries.find((entry) => entry.kind === 'placement').payload;
  assert.equal(blocked.verdict, 'blocked');
  assert.ok(blocked.findings.some((finding) => finding.severity === 'error' && finding.code === 'PLACEMENT_OUTSIDE_OUTLINE'));

  const unconfirmedStore = memoryStore();
  collectGateEvidence({ evidenceStore: unconfirmedStore, pcbUuid: 'pcb-1', placement: { verification: passedPlacement(), userConfirmed: false } });
  assert.equal(unconfirmedStore.entries.find((entry) => entry.kind === 'placement').payload.verdict, 'blocked');

  const unknownStore = memoryStore();
  collectGateEvidence({ evidenceStore: unknownStore, pcbUuid: 'pcb-1', placement: { findings: [], checkedCount: 2 } });
  assert.equal(unknownStore.entries.find((entry) => entry.kind === 'placement').payload.verdict, 'unknown');
});

test('P0-2：G6 制造放行报告 ready → pass；blocked → blocked（blockers 逐条落成 error finding）', () => {
  const pass = collectGateEvidence({ evidenceStore: memoryStore(), pcbUuid: 'pcb-1', fabricationRelease: readyFabricationRelease() });
  assert.equal(pass.saved.find((item) => item.kind === 'fabrication-release').verdict, 'pass');

  const blockedStore = memoryStore();
  collectGateEvidence({
    evidenceStore: blockedStore,
    pcbUuid: 'pcb-1',
    fabricationRelease: { ready: false, verdict: 'blocked', blockers: [{ code: 'RELEASE_DRC_UNEXPLAINED', message: 'DRC 还有未处理项' }], warnings: [] },
  });
  const blocked = blockedStore.entries.find((entry) => entry.kind === 'fabrication-release').payload;
  assert.equal(blocked.verdict, 'blocked');
  assert.ok(blocked.findings.some((finding) => finding.severity === 'error' && finding.code === 'RELEASE_DRC_UNEXPLAINED'));

  // 无法识别的输入必须 blocked（不能因为"有个对象"就当成报告通过）。
  const invalidStore = memoryStore();
  collectGateEvidence({ evidenceStore: invalidStore, pcbUuid: 'pcb-1', fabricationRelease: { something: 'else' } });
  assert.equal(invalidStore.entries.find((entry) => entry.kind === 'fabrication-release').payload.verdict, 'blocked');
});

test('P0-2：证据必须绑定 PCB —— 缺 pcbUuid / 缺证据库直接拒绝，不落“谁都对不上”的证据', () => {
  assert.throws(() => collectGateEvidence({ evidenceStore: memoryStore() }), (error) => error.code === GATES_EVIDENCE_CODES.PCB_REQUIRED);
  assert.throws(() => collectGateEvidence({ pcbUuid: 'pcb-1' }), (error) => error.code === GATES_EVIDENCE_CODES.STORE_REQUIRED);
});
