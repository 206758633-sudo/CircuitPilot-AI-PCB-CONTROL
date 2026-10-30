import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_INLINE_SCREENSHOT_MAX_BYTES, materializeGuiScreenshot } from '../gui-artifact-transport.mjs';

test('小截图保持内联：既有调用方拿 base64 的用法不受影响', () => {
  const buffer = Buffer.from('fake-png-bytes');
  const result = materializeGuiScreenshot({ base64: buffer.toString('base64'), outDir: '/tmp/never-used' });
  assert.equal(result.ok, true);
  assert.equal(result.inline, true);
  assert.equal(result.kind, 'inline');
  assert.equal(result.base64, buffer.toString('base64'));
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test('大截图落盘 + sha256：响应体不再携带巨型 base64（真机被截断的根因）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-shot-'));
  const buffer = Buffer.alloc(DEFAULT_INLINE_SCREENSHOT_MAX_BYTES + 1, 7);
  try {
    const result = materializeGuiScreenshot({ base64: buffer.toString('base64'), outDir: dir, namePrefix: 't', now: new Date('2026-10-21T00:00:00Z') });
    assert.equal(result.ok, true);
    assert.equal(result.inline, false);
    assert.equal(result.kind, 'file');
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(result.path).length, buffer.length, '落盘内容必须与 base64 解码后完全一致');
    assert.equal('base64' in result, false, '大图不得再内联 base64');
    assert.match(String(result.path), /t-2026-10-21T00-00-00-000Z-[0-9a-f]{8}\.png$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空/坏 base64 不静默成功：明确报 reason', () => {
  assert.deepEqual(materializeGuiScreenshot({ base64: '' }), { ok: false, reason: 'EMPTY_SCREENSHOT_BASE64' });
  assert.deepEqual(materializeGuiScreenshot({ base64: '!!!!' }), { ok: false, reason: 'EMPTY_SCREENSHOT_BASE64' });
});

test('没有落盘目录时退回内联（保持旧行为，不因配置缺失丢数据）', () => {
  const buffer = Buffer.alloc(DEFAULT_INLINE_SCREENSHOT_MAX_BYTES + 1, 1);
  const result = materializeGuiScreenshot({ base64: buffer.toString('base64'), outDir: null });
  assert.equal(result.ok, true);
  assert.equal(result.inline, true);
  assert.equal(typeof result.base64, 'string');
});
