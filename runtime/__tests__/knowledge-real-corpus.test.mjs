import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createKnowledgeStore } from '../knowledge.mjs';
import { createEvidenceStore } from '../evidence-store.mjs';
import { createGateService } from '../gates-service.mjs';
import { buildGateKnowledgeAdvice } from '../knowledge-gate-advice.mjs';
import { loadDataset, seedLocal } from '../../scripts/seed-knowledge-pcb.mjs';

/**
 * P0-6 真实语料回归：不是"塞一条 approved 假数据"就断言建议非空，
 * 而是用仓库内人工策划的 rules 数据集（docs 指针 + sources 校验通过）灌库、
 * 按委托审核流程标记 approved，再让真实 gate-engine 报告触发建议。
 */
test('P0-6：真实 curated 语料审核后，门禁建议覆盖六门并写 usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-knowledge-real-'));
  try {
    const dataset = loadDataset();
    const rules = dataset.entries.filter((entry) => entry.kind === 'rule');
    assert.ok(rules.length >= 100, 'curated rules 数据集应有一定规模');
    const seeded = seedLocal({ root, entries: rules });
    assert.equal(seeded.ok, true);
    assert.equal(seeded.created, rules.length);

    const store = createKnowledgeStore({ root });
    assert.equal(store.list({ reviewState: 'approved' }).length, 0, '灌库后一律 candidate，脚本/采集器不得自证');
    for (const entry of store.list({ reviewState: 'candidate' })) {
      store.review(entry.id, { state: 'approved', reviewedBy: '维护者（委托审核：来源清单核对）' });
    }
    assert.equal(store.list({ reviewState: 'approved' }).length, rules.length);

    const evidenceStore = createEvidenceStore({ root: join(root, 'evidence') });
    const report = createGateService({ evidenceStore }).status({ pcbUuid: 'pcb-real-corpus-test' }).report;
    assert.equal(report.verdict, 'unknown', '没有证据时门禁不得 pass');

    const advice = buildGateKnowledgeAdvice({ store, report, record: true });
    assert.ok(advice.suggested.length >= 6, `六门都应有可引用建议，实际 ${advice.suggested.length}`);
    assert.deepEqual([...new Set(advice.suggested.map((item) => item.gateId))].sort(), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']);
    for (const item of advice.suggested) {
      assert.equal(item.review, 'approved');
      assert.notEqual(item.trust, 'unverified');
      assert.match(item.citation, /^knowledge:kn-rule-/);
      const entry = store.list({ reviewState: 'approved' }).find((candidate) => candidate.id === item.knowledgeId);
      assert.ok(entry, '建议必须回查到真实知识条目');
      assert.ok((entry.review?.reviewedBy || '').length > 0, 'approved 必须记录审核人');
    }
    assert.equal(advice.usageRecorded, advice.suggested.length, '每条被采用的知识都要写 usage');
    assert.equal(advice.usageFailures.length, 0);
    const usages = store.listUsages({});
    assert.ok(Array.isArray(usages) && usages.length >= advice.suggested.length, 'usage 必须可追溯');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
