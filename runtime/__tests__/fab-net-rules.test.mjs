import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeServer } from '../server.mjs';
import {
  FAB_RULE_FIXTURES,
  FAB_RULE_STATUS,
  evaluateFabRules,
  fabProfilePack,
  fabProfileSummary,
  parseMm,
  resolveFabProfile,
} from '../engineering/fab-rules.mjs';
import {
  NET_RULE_FIXTURES,
  NET_RULE_STATUS,
  classifyNets,
  differentialImpedance,
  evaluateNetRules,
  microstripImpedance,
  traceWidthForCurrent,
  viaCurrentCapacity,
} from '../engineering/net-rules.mjs';

process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-fab-net-state-'));

const byId = (audit, id) => audit.rules.find((rule) => rule.id === id);

test('板厂能力数据包：来源/许可/哈希/变体完整，限值按 fab 区分', () => {
  const pack = fabProfilePack();
  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.kind, 'fab-capability-profiles');
  assert.equal(pack.source.license, 'MIT');
  assert.match(pack.source.url, /Cimos\/kicad-druid/);
  assert.equal(pack.hash.length, 64);
  assert.deepEqual(Object.keys(pack.variants).sort(), ['Generic', 'JLCPCB', 'PCBWay']);
  for (const variants of Object.values(pack.variants)) assert.deepEqual(Object.keys(variants), ['2L-1oz', '4L-1oz (default)', '4L-2oz', '6L-1oz']);
  assert.equal(Object.keys(pack.fixedLimits).length, 30);

  const jlc = resolveFabProfile('JLCPCB', '4L-1oz');
  assert.equal(jlc.variant, '4L-1oz (default)');
  assert.equal(jlc.minTraceWidthOuterMm, 0.09);
  assert.equal(jlc.minSpacingInnerMm, 0.09);
  assert.equal(jlc.minViaHoleMm, 0.15);
  assert.equal(jlc.minViaAnnularMm, 0.05);
  assert.equal(jlc.minPthHoleMm, 0.15);
  assert.equal(jlc.minSmdPadMm, 0.125);
  assert.equal(jlc.minSilkTextHeightMm, 1.0);
  assert.equal(jlc.minTraceToEdgeMm, 0.2);
  assert.equal(jlc.layers, 4);
  assert.equal(jlc.copperOz, 1);
  assert.equal(jlc.blindBuriedAllowed, false);

  const pcbway = resolveFabProfile('PCBWay', '4L-1oz');
  assert.equal(pcbway.minViaAnnularMm, 0.15);
  assert.equal(pcbway.minViaHoleMm, 0.2);
  assert.equal(pcbway.minTraceToEdgeMm, 0.3);
  assert.equal(pcbway.blindBuriedAllowed, true);

  assert.equal(parseMm('—'), null);
  assert.equal(parseMm('n/a'), null);
  assert.equal(parseMm('0.15mm'), 0.15);
  assert.equal(parseMm('10mil'), 0.254);
});

test('板厂能力审计：合规样板 releaseReady，缺陷样板逐条命中硬门禁', () => {
  const pass = evaluateFabRules(FAB_RULE_FIXTURES['JLC-4L-PASS']());
  assert.equal(pass.kind, 'fab-rule-audit');
  assert.equal(pass.summary.FAIL, 0);
  assert.equal(pass.summary.REVIEW, 0);
  assert.equal(pass.passed, true);
  assert.equal(pass.releaseReady, true);
  assert.equal(pass.humanReviewRequired, true);
  assert.equal(pass.auditHash.length, 64);
  assert.ok(pass.rules.every((rule) => [FAB_RULE_STATUS.PASS, FAB_RULE_STATUS.NA].includes(rule.status)));

  const bad = evaluateFabRules(FAB_RULE_FIXTURES['JLC-4L-FAIL']());
  const expected = ['FAB-01', 'FAB-02', 'FAB-03', 'FAB-04', 'FAB-05', 'FAB-06', 'FAB-07', 'FAB-08', 'FAB-10', 'FAB-11', 'FAB-12', 'FAB-13', 'FAB-14'];
  for (const id of expected) assert.equal(byId(bad, id).status, FAB_RULE_STATUS.FAIL, `${id} 必须 FAIL`);
  assert.equal(bad.releaseReady, false);
  assert.ok(bad.summary.blockingFailures >= 10);
  assert.ok(bad.findings.some((findingItem) => findingItem.code === 'FAB_RULE_FAB-03'));
  assert.ok(bad.findings.every((findingItem) => findingItem.path.startsWith('fabRules.')));
});

test('板厂能力审计：缺数据一律 REVIEW，不得静默放行', () => {
  const audit = evaluateFabRules({ fab: 'JLCPCB', variant: '4L-1oz' });
  assert.ok(audit.summary.REVIEW >= 10);
  assert.equal(audit.releaseReady, false);
  assert.equal(audit.passed, true, 'REVIEW 不是 FAIL，passed 只表示没有硬门禁失败');
  assert.ok(audit.rules.filter((rule) => rule.status === FAB_RULE_STATUS.REVIEW).every((rule) => rule.message.length > 0));

  const partial = evaluateFabRules({ fab: 'JLCPCB', variant: '4L-1oz', design: { minTraceWidthMm: { outer: 0.05 } } });
  assert.equal(byId(partial, 'FAB-01').status, FAB_RULE_STATUS.FAIL);
  assert.equal(byId(partial, 'FAB-02').status, FAB_RULE_STATUS.REVIEW);
});

test('板厂能力：变体/层数/铜厚不一致与非法参数 fail closed', () => {
  const input = FAB_RULE_FIXTURES['JLC-4L-PASS']();
  input.design.layers = 6;
  const mismatch = evaluateFabRules(input);
  assert.equal(byId(mismatch, 'FAB-16').status, FAB_RULE_STATUS.FAIL);

  assert.throws(() => resolveFabProfile('NotAFab', '4L-1oz'), (error) => error.code === 'FAB_PROFILE_UNKNOWN_FAB');
  assert.throws(() => resolveFabProfile('JLCPCB', '9L-4oz'), (error) => error.code === 'FAB_PROFILE_UNKNOWN_VARIANT');
  const summary = fabProfileSummary();
  assert.equal(summary.fixedLimitCount, 30);
  assert.equal(summary.rules.length, 16);
  assert.deepEqual(summary.fabs.sort(), ['Generic', 'JLCPCB', 'PCBWay']);
});

test('网络分类按 EasyEDA 官方命名约定，孤立差分后缀只给 warning', () => {
  const classified = classifyNets(['GND', 'AGND', 'DGND', '+3V3', 'VBUS', 'USB0_DP', 'USB0_DM', 'PCIE_TX_P', 'PCIE_TX_N', 'CLK_Z50', 'GPIO12', 'ORPHAN_P']);
  const get = (net) => classified.find((entry) => entry.net === net);
  assert.equal(get('GND').category, 'ground');
  assert.equal(get('AGND').category, 'ground');
  assert.equal(get('+3V3').category, 'power');
  assert.equal(get('VBUS').category, 'power');
  assert.equal(get('USB0_DP').category, 'differential');
  assert.equal(get('USB0_DP').targetOhms, 90);
  assert.equal(get('USB0_DM').mate, 'USB0_DP');
  assert.equal(get('PCIE_TX_P').targetOhms, 85);
  assert.equal(get('CLK_Z50').category, 'impedance');
  assert.equal(get('CLK_Z50').targetOhms, 50);
  assert.equal(get('GPIO12').category, 'signal');
  assert.equal(get('ORPHAN_P').category, 'signal');
  assert.equal(get('ORPHAN_P').warnings.length, 1);
});

test('IPC-2221 载流与过孔载流公式：外层/内层/温升方向正确', () => {
  const outer = traceWidthForCurrent({ currentA: 1, copperThicknessUm: 35, external: true, tempRiseC: 10 });
  const inner = traceWidthForCurrent({ currentA: 1, copperThicknessUm: 35, external: false, tempRiseC: 10 });
  assert.ok(outer.widthMm > 0.28 && outer.widthMm < 0.32, `1A/35µm/ΔT10 外层应约 0.30mm，实际 ${outer.widthMm}`);
  assert.ok(inner.widthMm > outer.widthMm, '内层散热差，线宽必须更宽');
  const wider = traceWidthForCurrent({ currentA: 2, copperThicknessUm: 35, external: true, tempRiseC: 10 });
  assert.ok(wider.widthMm > outer.widthMm * 2.2, '电流翻倍时线宽必须显著增加');
  const thicker = traceWidthForCurrent({ currentA: 1, copperThicknessUm: 70, external: true, tempRiseC: 10 });
  assert.ok(Math.abs(thicker.widthMm - outer.widthMm / 2) < 1e-6, '铜厚翻倍，所需线宽减半');
  assert.equal(traceWidthForCurrent({ currentA: 0 }), null);

  const smallVia = viaCurrentCapacity({ apertureDiameterMm: 0.2, copperThicknessUm: 25, temperatureRiseC: 10 });
  const largeVia = viaCurrentCapacity({ apertureDiameterMm: 0.4, copperThicknessUm: 25, temperatureRiseC: 10 });
  assert.ok(smallVia.maxCurrentA > 0.5 && smallVia.maxCurrentA < 0.65, `0.2mm/25µm 过孔载流约 0.56A，实际 ${smallVia.maxCurrentA}`);
  assert.ok(largeVia.maxCurrentA > smallVia.maxCurrentA);
});

test('微带/差分阻抗：线宽变大阻抗下降，差分阻抗低于 2×单端', () => {
  const narrow = microstripImpedance({ widthMm: 0.15, heightMm: 0.18, er: 4.1 });
  const wide = microstripImpedance({ widthMm: 0.4, heightMm: 0.18, er: 4.1 });
  assert.ok(narrow.impedanceOhm > wide.impedanceOhm);
  const differential = differentialImpedance({ widthMm: 0.2, gapMm: 0.13, heightMm: 0.18, er: 4.1 });
  assert.ok(differential.impedanceOhm > 0 && differential.impedanceOhm < 2 * differential.singleEndedOhm);
});

test('网络规则审计：合规样板 releaseReady，缺陷样板命中载流/差分/阻抗/过孔', () => {
  const pass = evaluateNetRules(NET_RULE_FIXTURES['NET-USB3-PASS']());
  assert.equal(pass.kind, 'net-rule-audit');
  assert.equal(pass.summary.FAIL, 0);
  assert.equal(pass.summary.REVIEW, 0);
  assert.equal(pass.releaseReady, true);
  assert.equal(pass.auditHash.length, 64);
  assert.equal(pass.classified.find((entry) => entry.net === 'USB3_SSTX_P').pairName, 'USB3_SSTX');

  const bad = evaluateNetRules(NET_RULE_FIXTURES['NET-USB3-FAIL']());
  for (const id of ['NET-02', 'NET-03', 'NET-04', 'NET-05']) assert.equal(byId(bad, id).status, NET_RULE_STATUS.FAIL, `${id} 必须 FAIL`);
  assert.equal(bad.releaseReady, false);
  assert.ok(bad.findings.some((findingItem) => findingItem.code === 'NET_RULE_NET-02'));

  const review = evaluateNetRules(NET_RULE_FIXTURES['NET-REVIEW']());
  assert.equal(byId(review, 'NET-04').status, NET_RULE_STATUS.REVIEW);
  assert.equal(review.releaseReady, false);
});

test('网络规则审计：缺网表/缺叠层/无数据边界行为可解释', () => {
  const empty = evaluateNetRules({});
  assert.equal(byId(empty, 'NET-01').status, NET_RULE_STATUS.REVIEW);
  assert.equal(byId(empty, 'NET-04').status, NET_RULE_STATUS.REVIEW);
  assert.equal(empty.releaseReady, false);

  const noStackup = evaluateNetRules({
    nets: ['CLK_Z50'],
    impedance: [{ net: 'CLK_Z50', targetOhms: 50, actualWidthMm: 0.2 }],
  });
  assert.equal(byId(noStackup, 'NET-04').status, NET_RULE_STATUS.REVIEW);
  assert.match(byId(noStackup, 'NET-04').message, /叠层/);

  const noVias = evaluateNetRules({ nets: ['GND'], vias: [] });
  assert.equal(byId(noVias, 'NET-05').status, NET_RULE_STATUS.NA);
});

test('两个规则审计都是确定性的（同一输入同一 auditHash）', () => {
  const fabA = evaluateFabRules(FAB_RULE_FIXTURES['JLC-4L-FAIL']());
  const fabB = evaluateFabRules(FAB_RULE_FIXTURES['JLC-4L-FAIL']());
  assert.equal(fabA.auditHash, fabB.auditHash);
  assert.notEqual(fabA.auditHash, evaluateFabRules(FAB_RULE_FIXTURES['JLC-4L-PASS']()).auditHash);
  const netA = evaluateNetRules(NET_RULE_FIXTURES['NET-USB3-FAIL']());
  const netB = evaluateNetRules(NET_RULE_FIXTURES['NET-USB3-FAIL']());
  assert.equal(netA.auditHash, netB.auditHash);
});

test('工程 API：板厂能力与网络规则元信息、样板审计、404', async (context) => {
  const keychain = { async configured() { return false; }, async read() { throw new Error('unused'); } };
  const { server } = createRuntimeServer({ keychain });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const headers = { 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const fabPackResponse = await fetch(`${base}/api/engineering/fab-rules`, { headers });
  const fabPack = await fabPackResponse.json();
  assert.equal(fabPackResponse.status, 200);
  assert.equal(fabPack.pack.fixedLimitCount, 30);
  assert.equal(fabPack.pack.hash.length, 64);
  assert.deepEqual(fabPack.fixtures, ['JLC-4L-PASS', 'JLC-4L-FAIL', 'PCBWAY-4L-PASS']);
  assert.equal(fabPack.pack.fixedLimits, undefined, '元信息路由不能把 30 条限值塞进响应');

  const fabAudit = await (await post('/api/engineering/fab-rules/audit', { fixtureId: 'JLC-4L-FAIL' })).json();
  assert.equal(fabAudit.audit.kind, 'fab-rule-audit');
  assert.equal(fabAudit.audit.releaseReady, false);
  assert.equal(fabAudit.audit.summary.blockingFailures >= 10, true);

  const fabMissing = await post('/api/engineering/fab-rules/audit', { fixtureId: 'NOPE' });
  assert.equal(fabMissing.status, 404);

  const netMetaResponse = await fetch(`${base}/api/engineering/net-rules`, { headers });
  const netMeta = await netMetaResponse.json();
  assert.equal(netMetaResponse.status, 200);
  assert.deepEqual(netMeta.fixtures, ['NET-USB3-PASS', 'NET-USB3-FAIL', 'NET-REVIEW']);
  assert.equal(netMeta.rules.length, 5);

  const netAudit = await (await post('/api/engineering/net-rules/audit', { fixtureId: 'NET-USB3-PASS' })).json();
  assert.equal(netAudit.audit.kind, 'net-rule-audit');
  assert.equal(netAudit.audit.releaseReady, true);

  const netMissing = await post('/api/engineering/net-rules/audit', { fixtureId: 'NOPE' });
  assert.equal(netMissing.status, 404);

  // 内联输入同样可用，且不依赖 UI 才能消费。
  const inline = await (await post('/api/engineering/fab-rules/audit', { input: FAB_RULE_FIXTURES['PCBWAY-4L-PASS']() })).json();
  assert.equal(inline.audit.fab, 'PCBWay');
});
