import assert from 'node:assert/strict';
import test from 'node:test';
import { DRAFT_MARKER, PRODUCTION_OUTPUT_CODES, artifactName, decideProductionOutput } from '../production-release.mjs';

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
