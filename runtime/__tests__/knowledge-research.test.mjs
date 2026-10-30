import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadDataset } from '../../scripts/seed-knowledge-pcb.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const dataset = loadDataset();
const registry = readJson(join(ROOT, 'knowledge/pcb/dataset/sources.json'));

test('研究来源登记：ID 唯一、HTTPS、抓取时间/哈希可校验', () => {
  assert.ok(Array.isArray(registry.sources) && registry.sources.length >= 10, '来源登记不足 10 条');
  const ids = new Set();
  for (const source of registry.sources) {
    assert.match(source.id, /^SRC-[A-Z0-9-]+$/, `来源 ID 非法：${source.id}`);
    assert.ok(!ids.has(source.id), `来源 ID 重复：${source.id}`);
    ids.add(source.id);
    assert.ok(source.publisher && source.title, `来源 ${source.id} 缺少 publisher/title`);
    assert.match(source.url, /^https:\/\//, `来源 ${source.id} 不是 HTTPS`);
    assert.ok(Number.isFinite(Date.parse(source.fetchedAt)), `来源 ${source.id} fetchedAt 非法`);
    assert.match(source.snapshotSha256, /^[a-f0-9]{64}$/, `来源 ${source.id} 快照哈希非法`);
    assert.ok(Number.isFinite(Date.parse(source.reviewBy)), `来源 ${source.id} reviewBy 非法`);
    assert.ok(Date.parse(source.reviewBy) > Date.parse(source.fetchedAt), `来源 ${source.id} reviewBy 必须晚于 fetchedAt`);
    assert.ok(['A', 'A/B', 'B/C', 'B', 'C'].includes(source.evidenceLevel), `来源 ${source.id} 证据等级非法`);
  }
  const referenced = new Set(dataset.entries.flatMap((entry) => entry.payload?.sources ?? []));
  const unused = registry.sources.filter((source) => !referenced.has(source.id)).map((source) => source.id);
  assert.deepEqual(unused, [], `来源登记存在未被任何条目引用的来源：${unused.join(', ')}`);
});

test('研究条目：sources 必须能解析到来源登记，且新文档有结构化条目', () => {
  const ids = new Set(registry.sources.map((source) => source.id));
  const researchDoc = 'docs/knowledge/pcb/20-researched-layout-constraints.md';
  assert.ok(existsSync(join(ROOT, researchDoc)), '研究文档不存在');
  const covered = dataset.entries.filter((entry) => entry.doc === researchDoc);
  assert.ok(covered.length >= 20, `研究文档结构化条目不足：${covered.length}`);
  for (const entry of dataset.entries) {
    const sources = entry.payload?.sources;
    if (sources === undefined) continue;
    assert.ok(Array.isArray(sources) && sources.length > 0, `${entry.title} 的 sources 必须是非空数组`);
    for (const id of sources) assert.ok(ids.has(id), `${entry.title} 引用了未登记来源 ${id}`);
    assert.ok(entry.payload.evidenceLevel, `${entry.title} 缺少 evidenceLevel`);
  }
});

test('2026-10-23 研究批次：关键规则/案例/故障模式已落库', () => {
  const ids = dataset.entries.map((entry) => entry.payload.ruleId ?? entry.payload.moduleId ?? entry.payload.failureId);
  const expected = [
    'PCB-RULE-SRC-001', 'PCB-RULE-RF-MODULE-001', 'PCB-RULE-RF-TRACE-002', 'PCB-RULE-RF-PWR-001',
    'PCB-RULE-RF-SDIO-001', 'PCB-RULE-USB-HS-001', 'PCB-RULE-HS-REF-001', 'PCB-RULE-USB-ESD-001',
    'PCB-RULE-ESD-GND-001', 'PCB-RULE-PWR-SW-001', 'PCB-RULE-THERM-QFN-001', 'PCB-RULE-MFG-CAP-001',
    'PCB-RULE-MFG-PANEL-002', 'PCB-RULE-SILK-LEGIBLE-002', 'PCB-RULE-SAFE-CREEP-002', 'PCB-RULE-SAFE-CTI-001',
    'PCB-RULE-MFG-STENCIL-001', 'PCB-RULE-COURTYARD-002', 'PCB-RULE-IMPEDANCE-002', 'PCB-RULE-DFT-002',
    'PCB-CASE-ESP32-RF-RESEARCH', 'PCB-CASE-TI-QFN-THERMAL', 'PCB-CASE-TI-USB-LAYOUT', 'PCB-CASE-MFG-CAPABILITY',
    'PCB-FAIL-RF-RIPPLE', 'PCB-FAIL-RF-RX-COUPLING', 'PCB-FAIL-USB-ESD', 'PCB-FAIL-QFN-VOID', 'PCB-FAIL-CREEP-MIXUP'
  ];
  for (const id of expected) assert.ok(ids.includes(id), `缺少研究条目 ${id}`);
});
