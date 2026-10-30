/**
 * 知识数据集质量门禁（K7）：
 *  - schema：四类条目必填字段/类型/枚举；
 *  - 文档对偶：docs/knowledge 下每篇内容文档至少有一条结构化条目；
 *  - 分类：category 必须能在 taxonomy.json 映射到 8 个 domain；
 *  - 冲突：conflicts.json 引用的规则必须存在；
 *  - 料号：part 必须显式标注核验状态与说明，禁止无标记的“看起来已核验”。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadDataset, validateDataset, DATASET_DIR } from '../../scripts/seed-knowledge-pcb.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const READ_JSON = (path) => JSON.parse(readFileSync(path, 'utf8'));

const dataset = loadDataset();
const entries = dataset.entries;
const conflicts = READ_JSON(join(DATASET_DIR, 'conflicts.json'));
const taxonomy = READ_JSON(join(DATASET_DIR, 'taxonomy.json'));

const CASE_REQUIRED = ['moduleId', 'category', 'boardType', 'sourceType', 'evidence', 'summary', 'designPrinciples', 'keyCircuits', 'ruleBasis', 'lessons', 'reviewFocus', 'verificationNotes', 'tags'];
const REQUIRED = {
  rule: ['ruleId', 'category', 'severity', 'statement', 'limits', 'rationale', 'check', 'appliesTo', 'tags'],
  module: ['moduleId', 'category', 'purpose', 'whenToUse', 'designPoints', 'keyParameters', 'schematic', 'layout', 'pitfalls', 'tags'],
  part: ['lcscId', 'lcscIdVerified', 'lcscIdVerificationNote', 'mpn', 'manufacturer', 'footprint', 'category', 'description', 'pins', 'polarity', 'keyRatings', 'selectionNotes', 'identityVerification', 'tags'],
  failure: ['failureId', 'code', 'category', 'severity', 'symptom', 'rootCause', 'detection', 'prevention', 'refs', 'tags'],
};

const contentDocs = () => {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md') && name !== 'README.md' && name !== 'conflict-register.md' && name !== 'requirements.md') {
        found.push(relative(ROOT, full));
      }
    }
  };
  walk(join(ROOT, 'docs/knowledge'));
  return found;
};

test('数据集 schema：四类条目必填字段齐全、类型正确', () => {
  const problems = validateDataset(entries);
  assert.deepEqual(problems, [], `数据集校验失败：${JSON.stringify(problems.slice(0, 5))}`);
  for (const entry of entries) {
    const isCase = entry.kind === 'module' && String(entry.payload.moduleId ?? '').startsWith('PCB-CASE-');
    const required = isCase ? CASE_REQUIRED : REQUIRED[entry.kind];
    assert.ok(required, `未知 kind：${entry.kind}`);
    for (const field of required) {
      if (entry.kind === 'part' && field === 'lcscId') {
        assert.ok(Object.hasOwn(entry.payload, 'lcscId'), `${entry.title} 缺少 lcscId 字段（可为 null）`);
        continue;
      }
      assert.ok(entry.payload[field] !== undefined && entry.payload[field] !== null && entry.payload[field] !== '', `${entry.kind}:${entry.payload[required[0]] ?? entry.title} 缺少 ${field}`);
    }
    if (entry.kind === 'rule') {
      assert.ok(['error', 'warning', 'info'].includes(entry.payload.severity), `规则 severity 非法：${entry.payload.ruleId}`);
      assert.ok(Array.isArray(entry.payload.limits) && entry.payload.limits.length > 0, `规则 limits 为空：${entry.payload.ruleId}`);
      assert.ok(Array.isArray(entry.payload.appliesTo) && entry.payload.appliesTo.length > 0, `规则 appliesTo 为空：${entry.payload.ruleId}`);
    }
    if (entry.kind === 'module' && !isCase) {
      for (const field of ['designPoints', 'keyParameters', 'pitfalls']) {
        assert.ok(Array.isArray(entry.payload[field]) && entry.payload[field].length > 0, `模块 ${entry.payload.moduleId} 的 ${field} 为空`);
      }
    }
    if (entry.kind === 'part') {
      assert.equal(typeof entry.payload.lcscIdVerified, 'boolean', `料号 ${entry.payload.mpn ?? entry.payload.lcscId} 的 lcscIdVerified 必须是布尔值`);
      assert.ok(String(entry.payload.lcscIdVerificationNote).trim().length > 0, `料号 ${entry.payload.mpn ?? entry.payload.lcscId} 缺少核验说明`);
      assert.ok(['已核验', '待核验', '待 Librarian 三源核验（EDA 库/供应商/datasheet）'].includes(entry.payload.identityVerification) || /核验/.test(entry.payload.identityVerification), `料号 ${entry.payload.mpn ?? entry.payload.lcscId} 身份核验标记不清`);
    }
    if (entry.kind === 'failure') {
      assert.ok(Array.isArray(entry.payload.prevention) && entry.payload.prevention.length > 0, `失败 ${entry.payload.failureId} 的 prevention 为空`);
    }
  }
});

test('文档对偶：docs/knowledge 下每篇内容文档至少有一条结构化条目', () => {
  const docs = contentDocs();
  assert.ok(docs.length >= 44, `内容文档数量异常偏少：${docs.length}`);
  const covered = new Set(entries.map((entry) => entry.doc));
  const uncovered = docs.filter((doc) => !covered.has(doc));
  assert.deepEqual(uncovered, [], `以下文档没有结构化条目：${uncovered.join(', ')}`);
});

test('分类：每个 category 都能映射到 8 个 domain 之一', () => {
  const ids = new Set(taxonomy.domains.map((d) => d.id));
  assert.equal(ids.size, taxonomy.domains.length, 'domain id 重复');
  const map = taxonomy.categoryToDomain;
  assert.ok(Object.keys(map).length > 0, 'categoryToDomain 为空');
  const missing = new Set();
  for (const entry of entries) {
    const category = entry.payload.category;
    if (!map[category]) missing.add(category);
    else assert.ok(ids.has(map[category]), `category ${category} 映射到未知 domain ${map[category]}`);
  }
  assert.deepEqual([...missing], [], `未映射的 category：${[...missing].join(', ')}`);
});

test('冲突登记：引用的规则必须存在，且每条规则只归入一个冲突组', () => {
  const ruleIds = new Set(entries.filter((entry) => entry.kind === 'rule').map((entry) => entry.payload.ruleId));
  for (const group of conflicts.groups) {
    assert.ok(group.groupId && group.resolution && group.status, `冲突组字段不全：${JSON.stringify(group).slice(0, 120)}`);
    const within = new Set();
    for (const id of group.rules) {
      assert.ok(ruleIds.has(id), `冲突组 ${group.groupId} 引用了不存在的规则 ${id}`);
      assert.ok(!within.has(id), `规则 ${id} 在冲突组 ${group.groupId} 内重复`);
      within.add(id);
    }
  }
});

test('料号核验：已核验必须给 LCSC，待核验不得标 true', () => {
  const parts = entries.filter((entry) => entry.kind === 'part');
  assert.ok(parts.length >= 55, `料号数量偏少：${parts.length}（K8 目标 ≥55）`);
  for (const entry of parts) {
    const p = entry.payload;
    const label = p.mpn ?? p.lcscId ?? entry.title;
    if (p.lcscIdVerified) {
      assert.ok(p.lcscId, `${label} 标记已核验但没有 LCSC 号`);
      assert.doesNotMatch(String(p.lcscIdVerificationNote), /待核验|待 Librarian/, `${label} 标记已核验但说明仍是待核验`);
    } else {
      assert.match(String(p.lcscIdVerificationNote), /待核验|待 Librarian|未核验/, `${label} 未核验但说明没有待核验标记`);
    }
  }
});
