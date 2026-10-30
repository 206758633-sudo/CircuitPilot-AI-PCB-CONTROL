import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildKnowledgePack, verifyKnowledgePack } from '../../scripts/knowledge-pack.mjs';

function dataset() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-knowledge-pack-'));
  const write = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value), 'utf8');
  write('rules.json', { entries: [{ kind: 'rule', ruleId: 'R1', title: '规则' }] });
  write('modules.json', { entries: [{ kind: 'module', moduleId: 'M1', title: '模块' }] });
  write('parts.json', { entries: [{ kind: 'part', lcscId: 'C1', title: '器件' }] });
  write('failures.json', { entries: [{ kind: 'failure', failureId: 'F1', title: '失效' }] });
  write('sources.json', { sources: [{ id: 'S1' }] });
  write('taxonomy.json', { domains: ['power'] });
  return dir;
}

test('buildKnowledgePack：必带四类数据、计数正确、内容哈希稳定、unsigned 明确', () => {
  const dir = dataset();
  try {
    const pack = buildKnowledgePack({ datasetDir: dir, packVersion: '2026.11.1', appMinVersion: '0.3.0', createdAt: () => '2026-11-01T00:00:00.000Z' });
    assert.equal(pack.kind, 'circuitpilot-knowledge-pack');
    assert.equal(pack.packVersion, '2026.11.1');
    assert.deepEqual(pack.counts, { rule: 1, module: 1, part: 1, failure: 1 });
    assert.match(pack.contentSha256, /^[a-f0-9]{64}$/);
    assert.equal(pack.signature, null);
    const verified = verifyKnowledgePack(pack);
    assert.equal(verified.ok, true, JSON.stringify(verified.problems));
    assert.equal(verified.signature, 'unsigned');
    // 同一数据集重复构建 → 同一 contentSha256（内容确定）
    const again = buildKnowledgePack({ datasetDir: dir, packVersion: '2026.11.1', appMinVersion: '0.3.0', createdAt: () => '2026-11-01T00:00:00.000Z' });
    assert.equal(again.contentSha256, pack.contentSha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyKnowledgePack：内容被改动 → CONTENT_HASH_MISMATCH（不静默通过）', () => {
  const dir = dataset();
  try {
    const pack = buildKnowledgePack({ datasetDir: dir, packVersion: '2026.11.1' });
    pack.files['rules.json'].entries[0].title = '被篡改的规则';
    const verified = verifyKnowledgePack(pack);
    assert.equal(verified.ok, false);
    assert.ok(verified.problems.some((item) => item.code === 'CONTENT_HASH_MISMATCH'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ed25519 签名：正确公钥 verified、无公钥 unverified-no-key、错误公钥 invalid', () => {
  const dir = dataset();
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const pack = buildKnowledgePack({ datasetDir: dir, packVersion: '2026.11.1', keyPem: privatePem, keyId: 'pack-test' });
    assert.equal(pack.signature.alg, 'ed25519');
    assert.equal(verifyKnowledgePack(pack, { publicKeyPem: publicPem }).signature, 'verified');
    assert.equal(verifyKnowledgePack(pack).signature, 'unverified-no-key');
    const other = generateKeyPairSync('ed25519');
    const wrongPem = other.publicKey.export({ type: 'spki', format: 'pem' });
    const wrong = verifyKnowledgePack(pack, { publicKeyPem: wrongPem });
    assert.equal(wrong.signature, 'invalid');
    assert.equal(wrong.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildKnowledgePack：版本号非法 / 数据集缺文件 → fail closed', () => {
  const dir = dataset();
  try {
    assert.throws(() => buildKnowledgePack({ datasetDir: dir, packVersion: 'v1' }), /PACK_VERSION_INVALID|packVersion/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const empty = mkdtempSync(join(tmpdir(), 'cp-knowledge-pack-empty-'));
  try {
    assert.throws(() => buildKnowledgePack({ datasetDir: empty, packVersion: '2026.11.1' }), /PACK_DATASET_INCOMPLETE|缺少必需文件/);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
