import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureEdaWindow, parseWindowBounds } from '../eda-window-capture.mjs';

test('E9：AppleScript 窗口 bounds 解析（position+size 拍平成 4 个数）', () => {
  assert.deepEqual(parseWindowBounds('0, 33, 1710, 1019\n'), { x: 0, y: 33, width: 1710, height: 1019 });
  assert.equal(parseWindowBounds('garbage'), null);
  assert.equal(parseWindowBounds('0, 33, 0, 1019'), null);
});

test('E9：窗口区域截图成功 ⇒ 返回 sha256/字节数/仅 EDA 窗口 region', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-window-shot-'));
  const png = Buffer.from('fake-png-bytes');
  const calls = [];
  const fakeSpawn = (command, args) => {
    calls.push({ command, args });
    if (command.includes('osascript')) return { status: 0, stdout: '100, 50, 800, 600', stderr: '' };
    writeFileSync(args[args.length - 1], png);
    return { status: 0, stdout: '', stderr: '' };
  };
  const shot = captureEdaWindow({ outDir: dir, spawnSync: fakeSpawn, captureExecutable: 'screencapture', osascript: 'osascript' });
  assert.equal(shot.ok, true);
  assert.equal(shot.kind, 'os-window-capture');
  assert.deepEqual(shot.bounds, { x: 100, y: 50, width: 800, height: 600 });
  assert.equal(shot.region, '100,50,800,600');
  assert.equal(shot.sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(shot.bytes, png.length);
  assert.equal(calls.filter((item) => item.command.includes('osascript')).length, 1);
  assert.deepEqual(calls[1].args.slice(0, 3), ['-x', '-R', '100,50,800,600']);
});

test('E9：窗口位置读不到 / 截图失败 ⇒ 结构化错误（不返回空截图）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-window-shot-fail-'));
  assert.throws(() => captureEdaWindow({ outDir: dir, spawnSync: () => ({ status: 1, stderr: 'not authorized' }) }), (error) => error.code === 'EDA_WINDOW_BOUNDS_FAILED');
  const failingShot = (command) => (command.includes('osascript') ? { status: 0, stdout: '0, 0, 800, 600' } : { status: 1, stderr: 'screencapture denied' });
  assert.throws(() => captureEdaWindow({ outDir: dir, spawnSync: failingShot }), (error) => error.code === 'EDA_WINDOW_CAPTURE_FAILED');
});


test('非 macOS：窗口截图兜底必须显式失败，不能伪造截图证据', () => {
  assert.throws(() => captureEdaWindow({ outDir: '/tmp', platform: 'win32' }), (error) => {
    assert.equal(error.code, 'EDA_WINDOW_CAPTURE_UNSUPPORTED');
    assert.match(error.message, /尚未实现/);
    return true;
  });
});
