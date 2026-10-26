import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { providerEgressManifest, previewProviderEgress } from '../provider-egress.mjs';
import { createRuntimeServer } from '../server.mjs';

test('G4 外发清单：覆盖现有 provider 调用点，明确同意模式与不发送内容', () => {
  const manifest = providerEgressManifest();
  assert.equal(manifest.consentMode, 'per-action');
  assert.equal(manifest.orderEnabled, false);
  assert.match(manifest.consentNote, /没有后台自动上传路径/);
  assert.deepEqual(manifest.endpoints.map((item) => item.id), ['chat.turn', 'plan.ai', 'netlist.ai', 'part.proposal']);
  for (const endpoint of manifest.endpoints) {
    assert.ok(endpoint.route.startsWith('POST /api/'), `${endpoint.id} 缺路由`);
    assert.ok(endpoint.trigger.length > 0);
    assert.ok(endpoint.data.length >= 1);
    assert.ok(endpoint.excluded.length >= 1);
  }
  assert.ok(manifest.notSent.some((item) => item.includes('API Key')));
  assert.ok(manifest.notSent.some((item) => item.includes('工程文件字节')));
  assert.ok(manifest.boundaries.some((item) => item.includes('人工维护')));
});

test('G4 脱敏预览：Bearer/APIKey/本机路径/邮箱/钥匙串字段都被擦除，不改原载荷', () => {
  const payload = {
    requirement: '给 /Users/example/circuitpilot 这块板加 USB，联系 a@b.com',
    headers: { authorization: 'Bearer example-bearer-token-123' },
    apiKey: 'example-provider-key-value',
    notes: 'token=example-token-value',
    nested: { path: 'C:\\Users\\alice\\project\\board.kicad_pcb' },
  };
  const before = JSON.stringify(payload);
  const preview = previewProviderEgress(payload);
  assert.equal(preview.ok, true);
  assert.equal(preview.changed, true);
  assert.equal(JSON.stringify(payload), before, '脱敏不能修改调用方原对象');
  const serialized = JSON.stringify(preview.sanitized);
  assert.ok(!serialized.includes('example-provider-key'));
  assert.ok(!serialized.includes('example-bearer-token'));
  assert.ok(!serialized.includes('/Users/example'));
  assert.ok(!serialized.includes('a@b.com'));
  assert.ok(serialized.includes('[REDACTED]'));
  assert.match(preview.note, /changed=true/);
});

test('G4 脱敏预览 fail-closed：无 payload / 不可序列化 → 400 明确错误', () => {
  assert.throws(() => previewProviderEgress(undefined), (error) => error.code === 'PROVIDER_EGRESS_PREVIEW_INVALID' && error.status === 400);
  const circular = {};
  circular.self = circular;
  const preview = previewProviderEgress(circular);
  assert.equal(preview.ok, true);
  assert.equal(preview.sanitized.self, '[Circular]');
});

test('G4 HTTP：清单 200、预览脱敏后不含密钥、缺 payload 400', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-egress-'));
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

  const manifestResponse = await fetch(`${base}/api/provider/egress`, { headers });
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.egress.endpoints.length, 4);

  const previewResponse = await fetch(`${base}/api/provider/egress/preview`, { method: 'POST', headers, body: JSON.stringify({ payload: { key: 'sk-very-secret-123456', note: 'Bearer abc.def.ghi' } }) });
  assert.equal(previewResponse.status, 200);
  const previewText = await previewResponse.text();
  assert.ok(!previewText.includes('sk-very-secret'));
  const preview = JSON.parse(previewText);
  assert.equal(preview.changed, true);

  const missing = await fetch(`${base}/api/provider/egress/preview`, { method: 'POST', headers, body: JSON.stringify({}) });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'PROVIDER_EGRESS_PREVIEW_INVALID');
});
