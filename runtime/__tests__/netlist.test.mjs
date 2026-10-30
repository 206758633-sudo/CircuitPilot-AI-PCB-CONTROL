import test from 'node:test';
import assert from 'node:assert/strict';
import { compileReviewedNetlist, normalizeReviewedNetlist } from '../netlist.mjs';
import { ApprovalStore, normalizePlan } from '../design.mjs';

const fixture = {
  title: 'AI测试板',
  components: [
    { ref: 'U1', value: 'CH32V003', libraryUuid: 'lib-u1', uuid: 'dev-u1' },
    { ref: 'R1', value: '1k', libraryUuid: 'lib-r1', uuid: 'dev-r1' },
  ],
  nets: [{ name: 'LED', endpoints: [{ ref: 'U1', pin: '1' }, { ref: 'R1', pin: '1' }] }],
};

test('reviewed netlist compiles deterministically to allowlisted schematic operations', () => {
  const first = compileReviewedNetlist(fixture);
  const second = compileReviewedNetlist(fixture);
  assert.equal(first.ready, true);
  assert.equal(first.planHash, second.planHash);
  assert.deepEqual(first.plan.operations.map((item) => item.type), ['component.create', 'component.create', 'net.connect']);
  assert.deepEqual(first.plan.operations[2].args.endpoints, [{ componentOperationIndex: 0, pinNumber: '1' }, { componentOperationIndex: 1, pinNumber: '1' }]);
});

test('reviewed netlist blocks unknown references and missing exact library identities', () => {
  const result = normalizeReviewedNetlist({ components: [{ ref: 'U1' }], nets: [{ name: 'VCC', endpoints: [{ ref: 'U1', pin: '1' }, { ref: 'X1', pin: '' }] }] });
  assert.equal(result.ready, false);
  assert.ok(result.missing.some((item) => item.includes('嘉立创EDA器件身份')));
  assert.ok(result.missing.some((item) => item.includes('未知位号X1')));
  assert.ok(result.missing.some((item) => item.includes('缺少引脚号')));
});

const twoClusterFixture = {
  title: '双簇布局',
  components: [
    { ref: 'U1', value: 'MCU', libraryUuid: 'lib-u1', uuid: 'dev-u1' },
    { ref: 'R1', value: '1k', libraryUuid: 'lib-r1', uuid: 'dev-r1' },
    { ref: 'C1', value: '100n', libraryUuid: 'lib-c1', uuid: 'dev-c1' },
    { ref: 'U2', value: 'LDO', libraryUuid: 'lib-u2', uuid: 'dev-u2' },
    { ref: 'R2', value: '10k', libraryUuid: 'lib-r2', uuid: 'dev-r2' },
  ],
  nets: [
    { name: 'VCC', endpoints: [{ ref: 'U1', pin: '1' }, { ref: 'R1', pin: '1' }] },
    { name: 'GND', endpoints: [{ ref: 'U1', pin: '2' }, { ref: 'C1', pin: '1' }] },
    { name: '3V3', endpoints: [{ ref: 'U2', pin: '1' }, { ref: 'R2', pin: '1' }] },
  ],
};

test('落位：按连通簇分带（不再固定 4 列 220×170），格点对齐、包围盒不重叠，操作顺序与端点映射不变', () => {
  const result = compileReviewedNetlist(twoClusterFixture);
  assert.equal(result.ready, true);
  // 操作顺序不变：先全部 component.create，再 net.connect
  assert.deepEqual(result.plan.operations.map((item) => item.type), ['component.create', 'component.create', 'component.create', 'component.create', 'component.create', 'net.connect', 'net.connect', 'net.connect']);
  assert.deepEqual(result.plan.operations[5].args.endpoints, [{ componentOperationIndex: 0, pinNumber: '1' }, { componentOperationIndex: 1, pinNumber: '1' }]);
  assert.deepEqual(result.plan.operations[6].args.endpoints, [{ componentOperationIndex: 0, pinNumber: '2' }, { componentOperationIndex: 2, pinNumber: '1' }]);
  assert.deepEqual(result.plan.operations[7].args.endpoints, [{ componentOperationIndex: 3, pinNumber: '1' }, { componentOperationIndex: 4, pinNumber: '1' }]);
  // 落位与布局纯函数一致（不是旧固定网格），且对齐 10 格点
  const placements = result.layoutAudit.placements;
  assert.equal(placements.length, 5);
  const placementByRef = new Map(placements.map((item) => [item.ref, item]));
  twoClusterFixture.components.forEach((component, index) => {
    const placement = placementByRef.get(component.ref);
    const operation = result.plan.operations[index];
    assert.deepEqual([operation.args.x, operation.args.y], [placement.x, placement.y], `${component.ref} 的落位必须来自布局结果`);
    assert.equal(placement.x % 10, 0);
    assert.equal(placement.y % 10, 0);
  });
  // 两个连通簇 → 两个分块，且不同簇在不同带（y 区间不重叠）
  assert.equal(result.layoutAudit.blocks.length, 2);
  assert.equal(result.layoutAudit.ok, true, JSON.stringify(result.layoutAudit.findings));
  assert.equal(result.layoutAudit.summary.componentOverlaps, 0);
  const [firstBlock, secondBlock] = result.layoutAudit.blocks;
  assert.ok(firstBlock.bbox.yMax <= secondBlock.bbox.yMin || secondBlock.bbox.yMax <= firstBlock.bbox.yMin, '不同连通簇必须落在不同带，不能混排');
  // planHash 仍是"计划内容的摘要"：确定性，且审计备注不混进 plan
  assert.equal(result.planHash, compileReviewedNetlist(twoClusterFixture).planHash);
  assert.equal('layoutAudit' in result.plan, false);
  assert.equal(result.netlistHash, normalizeReviewedNetlist(twoClusterFixture).netlistHash);
});

test('落位：混合尺寸不重叠（大 IC 与小无源不在同一格），且审计 ok', () => {
  const components = ['U1', 'U2', 'U3', 'R1', 'R2', 'C1', 'C2', 'D1', 'J1'].map((ref) => ({ ref, libraryUuid: `lib-${ref}`, uuid: `dev-${ref}` }));
  const nets = [
    { name: 'VCC', endpoints: components.slice(0, 5).map((item) => ({ ref: item.ref, pin: '1' })) },
    { name: 'GND', endpoints: components.slice(4).map((item) => ({ ref: item.ref, pin: '2' })) },
  ];
  const result = compileReviewedNetlist({ components, nets });
  assert.equal(result.ready, true);
  assert.equal(result.layoutAudit.ok, true, JSON.stringify(result.layoutAudit.findings));
  assert.equal(result.layoutAudit.summary.componentOverlaps, 0);
  // 至少有一个 IC 的估计高度明显大于无源件（说明不再"所有器件同格"）
  const byRef = new Map(result.layoutAudit.placements.map((item) => [item.ref, item]));
  assert.ok(byRef.get('U1').height > byRef.get('R1').height);
  // 任何两个落位包围盒都不重叠
  const boxes = result.layoutAudit.placements.map((item) => ({ xMin: item.x - item.width / 2, yMin: item.y - item.height / 2, xMax: item.x + item.width / 2, yMax: item.y + item.height / 2 }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const width = Math.min(boxes[i].xMax, boxes[j].xMax) - Math.max(boxes[i].xMin, boxes[j].xMin);
      const height = Math.min(boxes[i].yMax, boxes[j].yMax) - Math.max(boxes[i].yMin, boxes[j].yMin);
      assert.ok(!(width > 0 && height > 0), `${result.layoutAudit.placements[i].ref} 与 ${result.layoutAudit.placements[j].ref} 的包围盒不得重叠`);
    }
  }
});

test('P0-8：编译计划保留语义/编译双哈希并参与 planHash，进入服务端计划/批准绑定', () => {
  const semanticPlanHash = 'a'.repeat(64);
  const compiledPlanHash = 'b'.repeat(64);
  const withLineage = compileReviewedNetlist({ ...fixture, semanticPlanHash, compiledPlanHash });
  const withoutLineage = compileReviewedNetlist(fixture);
  assert.equal(withLineage.ready, true);
  assert.equal(withLineage.plan.semanticPlanHash, semanticPlanHash);
  assert.equal(withLineage.plan.compiledPlanHash, compiledPlanHash);
  assert.notEqual(withLineage.planHash, withoutLineage.planHash);
  // 血缘属于"计划"，不属于"网表内容"：netlistHash 保持内容摘要语义。
  assert.equal(withLineage.netlistHash, withoutLineage.netlistHash);
  // 编译计划进入服务端 normalizePlan 后双哈希仍在，后续 approval/execution 记录可绑定。
  const normalized = normalizePlan(withLineage.plan);
  assert.equal(normalized.ready, true);
  assert.equal(normalized.plan.semanticPlanHash, semanticPlanHash);
  assert.equal(normalized.plan.compiledPlanHash, compiledPlanHash);
  assert.equal(normalized.planHash, withLineage.planHash);
  const issued = new ApprovalStore().issue({
    planHash: normalized.planHash, targetFingerprint: 'target', windowId: 'window', steps: [],
    semanticPlanHash: normalized.plan.semanticPlanHash, compiledPlanHash: normalized.plan.compiledPlanHash,
  });
  assert.equal(issued.semanticPlanHash, semanticPlanHash);
  assert.equal(issued.compiledPlanHash, compiledPlanHash);
  // P1-2：显式非法血缘 fail-closed，不再静默丢弃。
  assert.throws(() => compileReviewedNetlist({ ...fixture, semanticPlanHash: 'not-a-hash' }), { code: 'APPROVAL_LINEAGE_INVALID', status: 400 });
});
