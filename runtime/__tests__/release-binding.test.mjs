import assert from 'node:assert/strict';
import test from 'node:test';
import { RELEASE_BINDING_CODES, verifyExportManifestBinding } from '../release-binding.mjs';

test('B1/B4：草稿不要求 manifest 绑定', () => {
  const result = verifyExportManifestBinding({ requested: 'draft', recomputedManifestHash: 'aaa', signoffManifestHash: 'bbb' });
  assert.equal(result.ok, true);
  assert.equal(result.manifestHash, 'aaa');
  assert.equal(result.checks.requested, 'draft');
});

test('B1/B4：正式导出有签核但没给 manifestHash → 明确阻断（不猜）', () => {
  const result = verifyExportManifestBinding({ requested: 'final', recomputedManifestHash: 'current-hash', signoffManifestHash: 'signed-hash' });
  assert.equal(result.ok, false);
  assert.equal(result.code, RELEASE_BINDING_CODES.REQUIRED);
  assert.match(result.message, /manifestHash/);
  assert.equal(result.checks.hasSignoff, true);
  assert.equal(result.manifestHash, 'current-hash');
});

test('B1/B4：给的 manifestHash 与当前产物重算不一致 → 拒绝（旧签核不能复用）', () => {
  const result = verifyExportManifestBinding({ requested: 'final', providedManifestHash: 'old-hash', recomputedManifestHash: 'new-hash', signoffManifestHash: 'old-hash' });
  assert.equal(result.ok, false);
  assert.equal(result.code, RELEASE_BINDING_CODES.MISMATCH);
  assert.match(result.message, /old-hash/);
  assert.ok(result.message.includes('new-hash'));
});

test('B1/B4：正式导出无签核时允许继续（由统一裁决报告缺签核），返回以重算哈希为准', () => {
  const withoutSignoff = verifyExportManifestBinding({ requested: 'final', recomputedManifestHash: 'current-hash' });
  assert.equal(withoutSignoff.ok, true);
  assert.equal(withoutSignoff.manifestHash, 'current-hash');
  const withMatching = verifyExportManifestBinding({ requested: 'final', providedManifestHash: 'h1', recomputedManifestHash: 'h1', signoffManifestHash: 'h1' });
  assert.equal(withMatching.ok, true);
  assert.equal(withMatching.checks.signoffMatchesRecomputed, true);
});
