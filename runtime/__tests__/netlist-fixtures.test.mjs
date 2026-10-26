import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditNetlist } from '../agents/netlist-auditor.mjs';

const dir = join(import.meta.dirname, 'fixtures', 'netlist');
const files = readdirSync(dir).filter((name) => name.endsWith('.json'));

test('通用 fixture 集：每个场景都能复现期望 verdict 与 finding code', () => {
  assert.ok(files.length >= 3, '至少 3 个通用场景');
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const result = auditNetlist({ intent: fixture.intent, actual: fixture.actual, pcbUuid: 'fixture-board' });
    assert.equal(result.verdict, fixture.expect.verdict, `${file} verdict`);
    for (const code of fixture.expect.codes) {
      assert.ok(result.findings.some((finding) => finding.code === code), `${file} 缺少 ${code}`);
    }
  }
});
