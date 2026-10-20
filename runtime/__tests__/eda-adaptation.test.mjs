import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assessEdaAdaptation, KNOWN_ISSUES, parseVersion, REQUIRED_API, TESTED_VERSIONS } from '../eda-adaptation.mjs';
import { createRuntimeServer } from '../server.mjs';

const probeWith = (overrides = {}) => {
  const probe = {};
  for (const item of REQUIRED_API) probe[item.name] = { methods: ['create', 'get'], createArity: 1 };
  for (const [name, value] of Object.entries(overrides)) probe[name] = value;
  return probe;
};

test('G5 版本适配：真机验收版本 → tested；未知版本/补丁漂移 → 明确降级提示', () => {
  const tested = assessEdaAdaptation({ version: TESTED_VERSIONS[0], versionSource: 'probe', probe: probeWith() });
  assert.equal(tested.status, 'tested');
  assert.equal(tested.supported, true);
  assert.equal(tested.level, 'ok');
  assert.deepEqual(tested.warnings, []);
  assert.ok(tested.knownIssues.length >= 1, '已知坑必须随版本带出');
  assert.ok(tested.knownIssues.every((issue) => issue.fallback.length > 0), '每项已知坑必须有降级路径');

  const unknown = assessEdaAdaptation({ version: null, versionSource: 'unknown' });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.supported, false);
  assert.equal(unknown.level, 'warn');
  assert.ok(unknown.warnings.some((item) => item.includes('不能声称已适配')));
  assert.ok(unknown.guidance.includes('不要走写链路'));

  const patched = assessEdaAdaptation({ version: '3.2.190', versionSource: 'user', probe: probeWith() });
  assert.equal(patched.status, 'patch-drift');
  assert.ok(patched.warnings.some((item) => item.includes('补丁版本')));

  const untested = assessEdaAdaptation({ version: '4.1.0', versionSource: 'user' });
  assert.equal(untested.status, 'untested');
  assert.ok(untested.warnings.some((item) => item.includes('未经真机验收')));
  assert.equal(untested.supported, false);
});

test('G5 能力探测：缺关键图元 API → degraded 并指出缺哪项；探针失败不当作通过', () => {
  const missing = assessEdaAdaptation({
    version: TESTED_VERSIONS[0],
    versionSource: 'probe',
    probe: probeWith({ pcb_PrimitiveComponent: { methods: ['get'] }, pcb_PrimitiveVia: null }),
  });
  assert.equal(missing.status, 'tested');
  assert.equal(missing.level, 'warn');
  assert.ok(missing.missingApi.some((item) => item.name === 'pcb_PrimitiveComponent' && item.problem.includes('缺少 create')));
  assert.ok(missing.missingApi.some((item) => item.name === 'pcb_PrimitiveVia' && item.problem.includes('未发现')));
  assert.ok(missing.degradations.some((item) => item.includes('PCB 器件落板') && item.includes('不可用')));

  const probeFailed = assessEdaAdaptation({ version: TESTED_VERSIONS[0], probe: null, probeError: 'bridge 超时' });
  assert.ok(probeFailed.warnings.some((item) => item.includes('能力探测失败')));
  assert.equal(probeFailed.missingApi.length, 0);
  assert.equal(probeFailed.level, 'warn');

  const noProbe = assessEdaAdaptation({ version: TESTED_VERSIONS[0] });
  assert.ok(noProbe.warnings.some((item) => item.includes('未提供 eda.api.describe')));

  const unavailable = assessEdaAdaptation({ version: TESTED_VERSIONS[0], probe: probeWith(), capabilityItems: [{ id: 'pcb.3d', status: 'unavailable', reason: '渲染进程无 3D' }] });
  assert.ok(unavailable.degradations.some((item) => item.includes('pcb.3d')));
  assert.equal(unavailable.level, 'warn');
});

test('G5 工具函数：版本解析/比较边界与已知坑表结构', () => {
  assert.deepEqual(parseVersion('3.2.186'), { major: 3, minor: 2, patch: 186, build: null, raw: '3.2.186' });
  assert.equal(parseVersion('v3.2'), null);
  assert.equal(parseVersion('3.2').major, 3);
  assert.equal(parseVersion('not-a-version'), null);
  assert.ok(KNOWN_ISSUES.length >= 3);
  for (const issue of KNOWN_ISSUES) {
    assert.ok(issue.id && issue.title && issue.fallback && issue.evidence, `${issue.id} 缺字段`);
  }
});

test('G5 HTTP：默认基线版本如实标 patch-drift；显式真机版本 → tested', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-eda-adapt-'));
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
  const headers = { 'x-circuitpilot-token': health.sessionProof };

  const declared = await fetch(`${base}/api/eda/version/adaptation`, { headers });
  assert.equal(declared.status, 200);
  const declaredBody = await declared.json();
  assert.equal(declaredBody.adaptation.versionSource, 'capability-matrix');
  assert.notEqual(declaredBody.adaptation.status, 'tested', '声明基线（3.2.175）不能冒充真机验收版本');
  assert.ok(declaredBody.adaptation.warnings.length >= 1);

  const real = await fetch(`${base}/api/eda/version/adaptation?version=3.2.186`, { headers });
  assert.equal(real.status, 200);
  const realBody = await real.json();
  assert.equal(realBody.adaptation.versionSource, 'user');
  assert.equal(realBody.adaptation.status, 'tested');
  assert.ok(realBody.adaptation.knownIssues.length >= 3);
});
