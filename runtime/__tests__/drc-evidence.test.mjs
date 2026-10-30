import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDrcEvidence, drcItems } from '../engineering/drc-evidence.mjs';

test('DRC 结果 → 带 provenance 的 GATE-02 证据：空结果才 passed，截断/有项必须 false', () => {
  const empty = buildDrcEvidence({ items: [] }, { scope: 'BOARD-A/rev-C', issuedAt: '2026-10-23T10:00:00.000Z' });
  assert.equal(empty.evidence.passed, true);
  assert.match(empty.evidence.artifactHash, /^[0-9a-f]{64}$/);
  assert.equal(empty.evidence.source, 'JLCEDA-PCB-DRC');
  assert.equal(empty.evidence.scope, 'BOARD-A/rev-C');
  assert.equal(empty.evidence.count, 0);

  const findings = buildDrcEvidence([{ name: 'Clearance' }], { scope: 'BOARD-A/rev-C' });
  assert.equal(findings.evidence.passed, false);
  assert.equal(findings.count, 1);

  const truncated = buildDrcEvidence({ items: [], truncated: true }, { scope: 'BOARD-A/rev-C' });
  assert.equal(truncated.evidence.passed, false, '截断结果不能算 0 问题');

  const failed = buildDrcEvidence({ items: [], passed: false }, { scope: 'BOARD-A/rev-C' });
  assert.equal(failed.evidence.passed, false);
});

test('DRC 结果形态无法识别时返回 ok=false，不伪造 passed', () => {
  assert.equal(drcItems({ nope: 1 }), null);
  assert.equal(drcItems(null), null);
  assert.equal(buildDrcEvidence({ nope: 1 }, { scope: 'B' }).ok, false);
  assert.throws(() => buildDrcEvidence({ items: [] }, {}), { code: 'DRC_EVIDENCE_SCOPE_REQUIRED' });
});
