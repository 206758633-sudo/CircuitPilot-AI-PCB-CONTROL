import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS } from '../bridge.mjs';
import { createRuntimeServer } from '../server.mjs';
import {
  SKILL_RULE_FIXTURES,
  SKILL_RULE_STATUS,
  SKILL_RULES,
  evaluateSkillRules,
  skillRuleSummary,
} from '../engineering/skill-rules.mjs';

process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-skill-state-'));

const byId = (audit, id) => audit.rules.find((rule) => rule.id === id);

test('SKL 规则清单：10 条，覆盖承诺的六类缺口', () => {
  const ids = SKILL_RULES.map((rule) => rule.id);
  assert.deepEqual(ids, ['SKL-01', 'SKL-02', 'SKL-03', 'SKL-04', 'SKL-05', 'SKL-06', 'SKL-07', 'SKL-08', 'SKL-09', 'SKL-10']);
  assert.equal(new Set(ids).size, ids.length);
  const names = SKILL_RULES.map((rule) => rule.name).join(' ');
  for (const keyword of ['功能分区', '九宫格', '手焊通道', '禁布区', 'keepout', '晶振', '两轮自检', '差分对', '丝印镜像', 'net-class']) {
    assert.ok(names.includes(keyword), `缺少 ${keyword} 规则`);
  }
  const summary = skillRuleSummary();
  assert.equal(summary.rules.length, 10);
  assert.deepEqual(summary.fixtures, ['SKILL-PASS', 'SKILL-FAIL', 'SKILL-REVIEW']);
});

test('合规样板 10/10 PASS 且 releaseReady', () => {
  const audit = evaluateSkillRules(SKILL_RULE_FIXTURES['SKILL-PASS']());
  assert.equal(audit.kind, 'eda-constraint-audit');
  assert.equal(audit.summary.total, 10);
  assert.equal(audit.summary.PASS, 10);
  assert.equal(audit.summary.FAIL, 0);
  assert.equal(audit.summary.REVIEW, 0);
  assert.equal(audit.releaseReady, true);
  assert.equal(audit.humanReviewRequired, true);
  assert.equal(audit.auditHash.length, 64);
});

test('缺陷样板逐条命中：zone/通道/禁布/keepout/晶振/两轮/等长/丝印/net-class', () => {
  const audit = evaluateSkillRules(SKILL_RULE_FIXTURES['SKILL-FAIL']());
  for (const id of ['SKL-02', 'SKL-03', 'SKL-04', 'SKL-05', 'SKL-06', 'SKL-07', 'SKL-08', 'SKL-09', 'SKL-10']) {
    assert.equal(byId(audit, id).status, SKILL_RULE_STATUS.FAIL, `${id} 必须 FAIL`);
  }
  assert.equal(byId(audit, 'SKL-01').status, SKILL_RULE_STATUS.REVIEW, '未归属器件应是 REVIEW（不是静默 PASS）');
  assert.equal(audit.releaseReady, false);
  assert.ok(audit.summary.blockingFailures >= 6);
  assert.ok(audit.findings.some((item) => item.code === 'SKILL_RULE_SKL-05'));
  assert.ok(audit.findings.every((item) => item.path.startsWith('engine.constraints.')));
});

test('缺数据一律 REVIEW，REVIEW 不等于 PASS', () => {
  const audit = evaluateSkillRules(SKILL_RULE_FIXTURES['SKILL-REVIEW']());
  assert.equal(audit.summary.REVIEW, 10);
  assert.equal(audit.releaseReady, false);
  assert.equal(audit.passed, true, '无硬门禁 FAIL，但绝不能因此 releaseReady');
});

test('两轮自检：缺 reload 是降级 REVIEW，reload 失败才 FAIL', () => {
  const pass = SKILL_RULE_FIXTURES['SKILL-PASS']();
  delete pass.selfCheck.rounds[1].reload;
  assert.equal(byId(evaluateSkillRules(pass), 'SKL-07').status, SKILL_RULE_STATUS.REVIEW);
  const reloadFailed = SKILL_RULE_FIXTURES['SKILL-PASS']();
  reloadFailed.selfCheck.rounds[1].reload = { attempted: true, ok: false };
  assert.equal(byId(evaluateSkillRules(reloadFailed), 'SKL-07').status, SKILL_RULE_STATUS.FAIL);
  const savedMissing = SKILL_RULE_FIXTURES['SKILL-PASS']();
  savedMissing.selfCheck.saved = false;
  assert.equal(byId(evaluateSkillRules(savedMissing), 'SKL-07').status, SKILL_RULE_STATUS.FAIL);
});

test('确定性：同一输入同一 auditHash，不同输入不同 hash', () => {
  const a = evaluateSkillRules(SKILL_RULE_FIXTURES['SKILL-FAIL']());
  const b = evaluateSkillRules(SKILL_RULE_FIXTURES['SKILL-FAIL']());
  assert.equal(a.auditHash, b.auditHash);
  assert.notEqual(a.auditHash, evaluateSkillRules(SKILL_RULE_FIXTURES['SKILL-PASS']()).auditHash);
});

test('桥新增只读详情命令与 reload：命令已注册、读命令无副作用、reload 走文档生命周期', () => {
  const regions = COMMANDS['pcb.regions.detail'];
  assert.equal(regions?.permission, 'read');
  assert.match(regions.code, /getState_/);
  assert.match(regions.code, /RuleType/);
  assert.match(regions.code, /getPrimitivesBBox/);
  assert.match(regions.code, /NO_POURS:7/);

  const texts = COMMANDS['pcb.texts.detail'];
  assert.equal(texts?.permission, 'read');
  assert.match(texts.code, /Mirror/);
  assert.match(texts.code, /Reverse/);
  assert.match(texts.code, /FontSize/);
  assert.match(texts.code, /Rotation/);

  const rules = COMMANDS['pcb.rules.detail'];
  assert.equal(rules?.permission, 'read');
  assert.match(rules.code, /getCurrentRuleConfiguration/);

  const reload = COMMANDS['pcb.reload'];
  assert.equal(reload?.permission, 'write');
  assert.equal(reload.longRunning, 'document-lifecycle');
  assert.equal(typeof reload.buildCode, 'function');
  const code = reload.buildCode({});
  assert.match(code, /closeDocument/);
  assert.match(code, /openDocument/);
  assert.match(code, /activateDocument/);
  assert.match(code, /info\.uuid/);
  assert.match(code, /info\.tabId/);
});

test('新增命令源码可解析，且用假 EDA 跑通区域/文字/规则/reload 的读回与单位换算', async () => {
  const run = async (commandId, eda, args = {}) => {
    const command = COMMANDS[commandId];
    const code = typeof command.buildCode === 'function' ? command.buildCode(args) : command.code;
    return new Function('eda', `return (async () => { ${code} })()`)(eda);
  };

  for (const id of ['pcb.regions.detail', 'pcb.texts.detail', 'pcb.rules.detail', 'pcb.reload']) {
    const command = COMMANDS[id];
    const code = typeof command.buildCode === 'function' ? command.buildCode(id === 'pcb.reload' ? { saved: true } : {}) : command.code;
    assert.doesNotThrow(() => new Function('eda', `return (async () => { ${code} })()`), `${id} 源码无法解析`);
  }

  const eda = {
    pcb_PrimitiveRegion: { async getAll() { return [{ getState_PrimitiveId: () => 'r1', getState_RuleType: () => [7], getState_Layer: () => 12, getState_RegionName: () => 'KO', getState_LineWidth: () => 10, getState_ComplexPolygon: () => ({ getSource: () => 'poly' }) }]; } },
    pcb_Primitive: { async getPrimitivesBBox() { return { minX: 0, minY: 0, maxX: 100, maxY: 200 }; } },
    pcb_PrimitiveString: { async getAll() { return [{ getState_PrimitiveId: () => 't1', getState_Layer: () => 4, getState_Text: () => 'U1', getState_Mirror: () => true, getState_Reverse: () => false, getState_Rotation: () => 0, getState_FontSize: () => 40, getState_LineWidth: () => 6, getState_X: () => 100, getState_Y: () => 200 }]; } },
    pcb_Drc: { async getCurrentRuleConfiguration() { return { clearance: 6 }; }, async getCurrentRuleConfigurationName() { return 'default'; } },
    dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'doc-uuid', tabId: 'tab-1' }; } },
    dmt_EditorControl: { async closeDocument() { return true; }, async openDocument() { return 'opened-tab'; }, async activateDocument() { return true; } },
  };

  const regions = await run('pcb.regions.detail', eda);
  assert.equal(regions.count, 1);
  assert.deepEqual(regions.regions[0].rules, [7]);
  assert.equal(regions.regions[0].layer, 12);
  assert.equal(regions.regions[0].regionName, 'KO');
  assert.equal(regions.regions[0].polygon, 'poly');
  assert.deepEqual(regions.regions[0].boundsMm, { minXMm: 0, minYMm: 0, maxXMm: 2.54, maxYMm: 5.08 });
  assert.equal(regions.ruleTypes.NO_POURS, 7);
  assert.equal(regions.multiLayer, 12);

  const texts = await run('pcb.texts.detail', eda);
  assert.equal(texts.count, 1);
  assert.equal(texts.texts[0].layer, 4);
  assert.equal(texts.texts[0].mirror, true);
  assert.equal(texts.texts[0].xMm, 2.54);
  assert.equal(texts.texts[0].yMm, 5.08);
  assert.deepEqual(texts.texts[0].boundsMm, { minXMm: 0, minYMm: 0, maxXMm: 2.54, maxYMm: 5.08 });

  const rules = await run('pcb.rules.detail', eda);
  assert.equal(rules.name, 'default');
  assert.equal(rules.configuration.clearance, 6);

  const reloaded = await run('pcb.reload', eda, { saved: true });
  assert.equal(reloaded.closed, true);
  assert.equal(reloaded.reopened, 'opened-tab');
  assert.equal(reloaded.activated, true);
  assert.equal(reloaded.documentUuid, 'doc-uuid');
  assert.equal(reloaded.previousTabId, 'tab-1');
});

test('工程 API：skill-rules 元信息、样板审计、404', async (context) => {
  const keychain = { async configured() { return false; }, async read() { throw new Error('unused'); } };
  const { server } = createRuntimeServer({ keychain });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:4177' } })).json();
  const headers = { 'x-circuitpilot-token': health.sessionProof };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const metaResponse = await fetch(`${base}/api/engineering/constraint-rules`, { headers });
  const meta = await metaResponse.json();
  assert.equal(metaResponse.status, 200);
  assert.equal(meta.rules.length, 10);
  assert.deepEqual(meta.fixtures, ['SKILL-PASS', 'SKILL-FAIL', 'SKILL-REVIEW']);

  const good = await (await post('/api/engineering/constraint-rules/audit', { fixtureId: 'SKILL-PASS' })).json();
  assert.equal(good.audit.kind, 'eda-constraint-audit');
  assert.equal(good.audit.releaseReady, true);

  const bad = await (await post('/api/engineering/constraint-rules/audit', { fixtureId: 'SKILL-FAIL' })).json();
  assert.equal(bad.audit.releaseReady, false);
  assert.equal(bad.audit.summary.blockingFailures >= 6, true);

  const missing = await post('/api/engineering/constraint-rules/audit', { fixtureId: 'NOPE' });
  assert.equal(missing.status, 404);

  const inline = await (await post('/api/engineering/constraint-rules/audit', { input: SKILL_RULE_FIXTURES['SKILL-PASS']() })).json();
  assert.equal(inline.audit.releaseReady, true);
});
