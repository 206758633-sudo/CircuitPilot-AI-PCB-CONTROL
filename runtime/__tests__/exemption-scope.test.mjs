import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultExemptionPath, exemptionScopePath, loadScopedExemptionFile } from '../drc.mjs';
import { ercExemptionScopePath, loadScopedErcExemptionFile } from '../erc.mjs';

test('豁免文件按工程隔离：不同工程落到不同文件', () => {
  const env = { CIRCUITPILOT_DRC_EXEMPTION_DIR: '/tmp/cp-exempt' };
  const a = exemptionScopePath('aaaaaaaaaaaa', env);
  const b = exemptionScopePath('bbbbbbbbbbbb', env);
  assert.notEqual(a, b);
  assert.match(a, /project-aaaaaaaaaaaa\.json$/);
  assert.equal(exemptionScopePath(null, env), '/tmp/cp-exempt/global.json');
});

test('显式 CIRCUITPILOT_DRC_EXEMPTIONS 仍然最优先（兼容旧部署/测试）', () => {
  const env = { CIRCUITPILOT_DRC_EXEMPTIONS: '/tmp/legacy.json', CIRCUITPILOT_DRC_EXEMPTION_DIR: '/tmp/cp-exempt' };
  assert.equal(defaultExemptionPath(env, 'aaaaaaaaaaaa'), '/tmp/legacy.json');
});

test('loadScopedExemptionFile：工程级文件存在时只读工程级（不混入全局）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-exempt-'));
  try {
    const env = { CIRCUITPILOT_DRC_EXEMPTION_DIR: dir, CIRCUITPILOT_DRC_LEGACY_EXEMPTIONS: join(dir, 'legacy-none.json') };
    const projectFile = exemptionScopePath('proj123456', env);
    writeFileSync(projectFile, JSON.stringify({ exemptions: [{ id: 'e1', reason: 'r', risk: 'x', matches: { errorType: 'Clearance Error' } }] }));
    const scoped = loadScopedExemptionFile('proj123456', env);
    assert.equal(scoped.exists, true);
    assert.equal(scoped.exemptions.length, 1);
    assert.equal(scoped.scope.kind, 'project');
    assert.equal(scoped.scope.projectUuid, 'proj123456');
    // 另一个工程读不到这条豁免（跨项目污染被隔离）
    const other = loadScopedExemptionFile('proj999999', env);
    assert.equal(other.exists, false);
    assert.equal(other.exemptions.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ERC 豁免同样按工程隔离：工程级文件只对该工程生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-erc-exempt-'));
  try {
    const env = { CIRCUITPILOT_ERC_EXEMPTION_DIR: dir, CIRCUITPILOT_ERC_LEGACY_EXEMPTIONS: join(dir, 'legacy-none.json') };
    assert.equal(ercExemptionScopePath(null, env), join(dir, 'global.json'));
    const projectFile = ercExemptionScopePath('ercproj1234', env);
    writeFileSync(projectFile, JSON.stringify({ exemptions: [{ code: 'ERC_PIN_FLOATING', object: 'U1.4', reason: '机械结构预留', at: '2026-10-21' }] }));
    const scoped = loadScopedErcExemptionFile('ercproj1234', env);
    assert.equal(scoped.exists, true);
    assert.equal(scoped.exemptions.length, 1);
    assert.equal(scoped.scope.kind, 'project');
    const other = loadScopedErcExemptionFile('ercproj9999', env);
    assert.equal(other.exists, false, '别的工程不得套用本工程豁免');
    assert.equal(other.exemptions.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
