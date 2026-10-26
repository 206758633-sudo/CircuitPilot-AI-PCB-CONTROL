import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueryVariants, collectSelectionEvidence } from '../chat.mjs';

test('A2：检索回退链只做关键词变形，不伪造型号身份', () => {
  const variants = buildQueryVariants('TI BQ24074RGTR (SOT-23-5)');
  assert.equal(variants[0], 'TI BQ24074RGTR (SOT-23-5)', '原查询必须排第一');
  assert.ok(variants.includes('BQ24074RGTR'), '必须能去掉品牌前缀与括号封装说明');
  assert.ok(new Set(variants.map((item) => item.toLowerCase())).size === variants.length, '变形链不能重复');
  assert.ok(buildQueryVariants('').length === 0);
  const speaker = buildQueryVariants('4Ω 3W 喇叭');
  assert.equal(speaker[0], '4Ω 3W 喇叭');
  assert.ok(speaker.includes('4Ω'), '无型号/无品牌时退到第一段关键词');
});

test('A2：原查询 0 命中时逐级回退，记录 attempts 与命中来源', async () => {
  const searched = [];
  const bridge = {
    async execute(id, args) {
      searched.push(args.query);
      const devices = args.query === 'BQ24074RGTR' ? [{ name: 'BQ24074RGTR', lcscId: 'C12345', uuid: 'u1', libraryUuid: 'lib1' }] : [];
      return { result: { devices } };
    },
  };
  const generate = async () => ({ text: JSON.stringify({ queries: [{ block: 'power', query: 'TI BQ24074RGTR (SOT-23-5)' }] }) });
  const evidence = await collectSelectionEvidence({ bridge, requirement: '需要锂电池充电管理', generate });
  assert.equal(evidence.skipped, false);
  const item = evidence.candidates[0];
  assert.equal(item.found, 1);
  assert.equal(item.usedQuery, 'BQ24074RGTR');
  assert.equal(item.fallback, true);
  assert.ok(item.attempts.length >= 2, '至少要记录原始查询与命中变体两次尝试');
  assert.equal(item.attempts[0].found, 0);
  assert.equal(item.candidates[0].name, 'BQ24074RGTR');
  assert.equal(item.candidates[0].lcscId, 'C12345');
  assert.deepEqual(searched[0], 'TI BQ24074RGTR (SOT-23-5)');
});

test('A2：全部回退都 0 命中时给出 NO_RESULT 与尝试证据，不产生候选', async () => {
  const bridge = { async execute() { return { result: { devices: [] } }; } };
  const generate = async () => ({ text: JSON.stringify({ queries: [{ block: 'mcu', query: '不存在的型号 XYZ-999 (QFN)' }] }) });
  const evidence = await collectSelectionEvidence({ bridge, requirement: '测试', generate });
  const item = evidence.candidates[0];
  assert.equal(item.found, 0);
  assert.equal(item.candidates.length, 0);
  assert.equal(item.error, 'NO_RESULT');
  assert.ok(item.attempts.length >= 2);
  assert.equal(item.fallback, false);
  assert.ok(item.attempts.every((attempt) => attempt.found === 0));
});
