import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  appDataDir, edaAppCandidates, platformId, resolveEdaExecutable, runtimeBinaryName, isSupportedPlatform,
} from '../platform.mjs';

test('platformId/isSupportedPlatform 只声明真实支持的平台', () => {
  assert.equal(platformId('darwin'), 'macos');
  assert.equal(platformId('win32'), 'windows');
  assert.equal(platformId('linux'), 'linux');
  assert.equal(platformId('aix'), 'unknown');
  assert.equal(isSupportedPlatform('win32'), true);
  assert.equal(isSupportedPlatform('aix'), false);
});

test('appDataDir：macOS/Windows/Linux 各自落用户数据目录，可用环境变量覆盖', () => {
  const home = '/home/tester';
  assert.equal(appDataDir({ platform: 'darwin', env: {}, home }), path.join(home, 'Library', 'Application Support', 'CircuitPilot'));
  assert.equal(appDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }, home }), path.join('C:\\Users\\tester\\AppData\\Roaming', 'CircuitPilot'));
  assert.equal(appDataDir({ platform: 'linux', env: {}, home }), path.join(home, '.local', 'state', 'circuitpilot'));
  assert.equal(appDataDir({ platform: 'linux', env: { XDG_STATE_HOME: '/var/state' }, home }), '/var/state/circuitpilot');
  assert.equal(appDataDir({ platform: 'linux', env: { CIRCUITPILOT_APP_DATA_DIR: '/custom' }, home }), '/custom');
});

test('edaAppCandidates：显式路径优先；Windows/Linux 给出平台候选而不是 macOS 路径', () => {
  assert.deepEqual(edaAppCandidates({ platform: 'darwin', env: { CIRCUITPILOT_EDA_APP_PATH: '/custom/EDA.app' } }), ['/custom/EDA.app']);
  const win = edaAppCandidates({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' } });
  assert.ok(win.some((item) => item.endsWith('嘉立创EDA专业版.exe')));
  assert.ok(win.every((item) => !item.startsWith('/Applications')));
  const linux = edaAppCandidates({ platform: 'linux', env: {} });
  assert.ok(linux.includes('/usr/bin/lceda-pro'));
  assert.ok(linux.includes('/opt/easyeda-pro/easyeda-pro'));
});

test('resolveEdaExecutable：macOS 解 .app、Windows 解 .exe、Linux 解目录', () => {
  assert.equal(resolveEdaExecutable('/Applications/嘉立创EDA专业版.app', { platform: 'darwin' }), '/Applications/嘉立创EDA专业版.app/Contents/MacOS/LCEDA-Pro');
  assert.equal(resolveEdaExecutable('C:\\Program Files\\嘉立创EDA专业版\\嘉立创EDA专业版.exe', { platform: 'win32' }), 'C:\\Program Files\\嘉立创EDA专业版\\嘉立创EDA专业版.exe');
  assert.equal(resolveEdaExecutable('/opt/嘉立创EDA专业版', { platform: 'linux' }), '/opt/嘉立创EDA专业版/lceda-pro');
  assert.equal(resolveEdaExecutable('/opt/easyeda-pro/easyeda-pro', { platform: 'linux' }), '/opt/easyeda-pro/easyeda-pro');
  assert.equal(resolveEdaExecutable('', { platform: 'darwin' }), null);
});

test('runtimeBinaryName：Windows 必须带 .exe，其他平台不带', () => {
  assert.equal(runtimeBinaryName('win32'), 'node.exe');
  assert.equal(runtimeBinaryName('darwin'), 'node');
  assert.equal(runtimeBinaryName('linux'), 'node');
});
