import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COLLECTOR_CODES, runCollector } from '../collectors/collect.mjs';
import { createSupplyCollector } from '../collectors/supply.mjs';
import { createEngineeringCollector } from '../collectors/engineering.mjs';
import { COMPLIANCE_CODES, annotateProvenance, assertCompliance } from '../collectors/compliance.mjs';

test('供应链采集器：料号→参考级候选（价格/库存未知不写成 0）', async () => {
  const collector = createSupplyCollector({
    lcscIds: ['C114586'],
    lookupImpl: async () => ({ source: 'lcsc', checkedAt: '2026-10-21T12:00:00.000Z', parts: { C114586: { lcscId: 'C114586', model: 'WS2812B-2020', package: 'LED-SMD_4P', price: 0.12, currency: 'USD', stock: null, minQty: 10, url: 'https://www.lcsc.com/product-detail/C114586.html', stockUnknownReason: 'SUPPLY_STOCK_MISSING' } }, unknown: [] }),
    now: () => new Date('2026-10-21T12:00:00.000Z'),
  });
  const result = await runCollector(collector);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].payload.lcscId, 'C114586');
  assert.equal(result.items[0].payload.stock, null);
  assert.equal(result.items[0].payload.stockUnknownReason, 'SUPPLY_STOCK_MISSING');
  assert.equal(result.items[0].ttlDays, 30);
  assert.equal(result.items[0].trust, 'unverified');
});

test('供应链采集器：空料号列表直接拒绝', () => {
  assert.throws(() => createSupplyCollector({ lcscIds: [] }), (error) => error.code === COLLECTOR_CODES.INVALID);
});

test('工程知识采集器：需求/BOM/历史规则 → module/part/rule 条目，坏文件不崩', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eng-'));
  try {
    const requirements = join(root, 'requirements.json');
    const bom = join(root, 'bom.json');
    const history = join(root, 'erc.json');
    const broken = join(root, 'broken.json');
    writeFileSync(requirements, JSON.stringify([{ id: 'REQ-1', name: '供电' }, { id: 'REQ-2', name: '灯效' }]));
    writeFileSync(bom, JSON.stringify({ components: [{ designator: 'D1', lcscId: 'C114586', value: 'WS2812B', footprint: 'LED-SMD_4P' }, { designator: 'R1', mpn: 'RC0402' }] }));
    writeFileSync(history, JSON.stringify({ findings: [{ code: 'ERC_PIN_FLOATING', severity: 'error' }, { code: 'ERC_PIN_FLOATING', severity: 'error' }, { code: 'ERC_WARNING', severity: 'warning' }] }));
    writeFileSync(broken, '{not json');
    const result = await runCollector(createEngineeringCollector({ artifacts: { requirements, bom, history: [history, broken] } }));
    assert.equal(result.ok, true);
    const kinds = result.items.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ['module', 'module', 'part', 'part', 'rule', 'rule']);
    const rule = result.items.find((item) => item.payload.ruleId === 'ERC_PIN_FLOATING');
    assert.equal(rule.payload.occurrences, 2);
    assert.equal(result.evidence.files.filter((file) => file.ok === false).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('来源合规：参考工程不得作为设计输入；可信等级受控', () => {
  const provenance = annotateProvenance({ source: 'reference-epro2', referenceProject: true, trust: 'reference' });
  assert.equal(provenance.allowedAsDesignInput, false);
  assert.equal(assertCompliance(provenance), true);
  assert.throws(() => assertCompliance({ ...provenance, allowedAsDesignInput: true }), (error) => error.code === COMPLIANCE_CODES.REFERENCE_AS_INPUT);
  assert.throws(() => annotateProvenance({ source: 'x', trust: 'trusted' }), (error) => error.code === COMPLIANCE_CODES.INVALID);
});
