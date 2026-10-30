/**
 * 功能分区（R3–R6）单测：blocks 校验、区域推导、保持相对位置、分区图、以及
 * “componentRegions 真的把器件约束在约定区域内”这条端到端不变量。
 *
 * 这里同时跑一个真实 HTTP 服务（假桥）验证 placement/plan 路由：
 *   - 响应必须带 blockMap，没有 blocks 时是空数组而不是 undefined；
 *   - 设计意图里的 blocks 会真的传导到布局引擎（器件中心落在区域里）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_BLOCK_MARGIN_MM, DEFAULT_RELATIVE_ANCHOR_WEIGHT, FUNCTIONAL_BLOCK_CODES, normalizeFunctionalBlocks, planFunctionalBlocks } from '../engineering/functional-blocks.mjs';
import { PLACEMENT_CODES, normalizeComponentRegionMm, planOutlinePlacement, verifyOutlinePlacement } from '../placement.mjs';
import { createRuntimeServer } from '../server.mjs';

// 单测进程隔离：状态/证据/豁免都落到临时目录，避免读到这台机器的真实历史。
process.env.CIRCUITPILOT_STATE_DIR = process.env.CIRCUITPILOT_STATE_DIR || mkdtempSync(join(tmpdir(), 'cp-fblocks-state-'));
process.env.CIRCUITPILOT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'cp-fblocks-evidence-'));
process.env.CIRCUITPILOT_DRC_EXEMPTIONS = join(tmpdir(), `cp-fblocks-drc-${process.pid}.json`);
process.env.CIRCUITPILOT_PROJECT_MEMO = join(tmpdir(), `cp-fblocks-memo-${process.pid}.json`);

const BOARD = { minX: 0, minY: 0, maxX: 60, maxY: 40 };

const COMPONENTS = [
  { ref: 'U1', widthMm: 5, heightMm: 5, current: { xMm: 15, yMm: 25, rotationDeg: 0 }, side: 'top' },
  { ref: 'C1', widthMm: 1, heightMm: 0.5, current: { xMm: 12, yMm: 23, rotationDeg: 0 }, side: 'top' },
  { ref: 'C2', widthMm: 1, heightMm: 0.5, current: { xMm: 18, yMm: 27, rotationDeg: 0 }, side: 'top' },
  { ref: 'U2', widthMm: 6, heightMm: 6, current: { xMm: 45, yMm: 10, rotationDeg: 0 }, side: 'top' },
  { ref: 'J1', widthMm: 9, heightMm: 8, current: { xMm: 52, yMm: 32, rotationDeg: 0 }, side: 'top' },
];

const codes = (findings) => findings.map((item) => item.code);

test('blocks 校验：id 唯一、name 非空、refs 非空去重、位号不可跨块；未知位号只报告不崩', () => {
  const valid = normalizeFunctionalBlocks({
    componentRefs: COMPONENTS.map((item) => item.ref),
    board: BOARD,
    blocks: [
      { id: 'dcdc', name: 'DC-DC 电源', refs: ['U1', 'C1', 'C2'], region: { xMinMm: 5, yMinMm: 15, xMaxMm: 25, yMaxMm: 35 }, priority: 1 },
      { id: 'battery', name: '电池管理', refs: ['U2'], priority: 2 },
    ],
  });
  assert.equal(valid.ok, true, JSON.stringify(valid.findings));
  assert.equal(valid.blocks.length, 2);
  assert.deepEqual(valid.blocks[0].refs, ['U1', 'C1', 'C2']);
  assert.deepEqual(valid.blocks[0].region, { xMinMm: 5, yMinMm: 15, xMaxMm: 25, yMaxMm: 35 });
  assert.equal(valid.blocks[1].region, null, '没给 region 时保持 null，由 planFunctionalBlocks 按成员位置推导');

  // 非数组 / 重复 id / 缺 name / refs 空 / refs 重复 → 各自的 finding
  assert.equal(normalizeFunctionalBlocks({ blocks: 'nope' }).ok, false);
  assert.equal(normalizeFunctionalBlocks({ blocks: [] }).ok, true, '空数组等于没有分区');
  const dupId = normalizeFunctionalBlocks({ blocks: [{ id: 'a', name: 'A', refs: ['U1'] }, { id: 'a', name: 'B', refs: ['U2'] }] });
  assert.equal(dupId.ok, false);
  assert.ok(codes(dupId.findings).includes(FUNCTIONAL_BLOCK_CODES.BLOCK_ID_DUPLICATE));
  const noName = normalizeFunctionalBlocks({ blocks: [{ id: 'a', name: '   ', refs: ['U1'] }] });
  assert.equal(noName.ok, false);
  assert.ok(codes(noName.findings).includes(FUNCTIONAL_BLOCK_CODES.BLOCK_INVALID));
  const noRefs = normalizeFunctionalBlocks({ blocks: [{ id: 'a', name: 'A', refs: [] }] });
  assert.equal(noRefs.ok, false);
  assert.ok(codes(noRefs.findings).includes(FUNCTIONAL_BLOCK_CODES.BLOCK_INVALID));

  const dupRefs = normalizeFunctionalBlocks({ componentRefs: ['U1'], blocks: [{ id: 'a', name: 'A', refs: ['U1', 'u1'] }] });
  assert.equal(dupRefs.ok, true, '块内重复位号只去重并 warning，不丢信息');
  assert.ok(codes(dupRefs.findings).includes(FUNCTIONAL_BLOCK_CODES.REF_DUPLICATE_IN_BLOCK));
  assert.deepEqual(dupRefs.blocks[0].refs, ['U1']);

  const cross = normalizeFunctionalBlocks({
    componentRefs: ['U1', 'U2'],
    blocks: [{ id: 'a', name: 'A', refs: ['U1'] }, { id: 'b', name: 'B', refs: ['U1', 'U2'] }],
  });
  assert.equal(cross.ok, false, '同一个位号进两个功能块必须阻断');
  assert.ok(codes(cross.findings).includes(FUNCTIONAL_BLOCK_CODES.REF_CROSS_BLOCK));
  assert.deepEqual(cross.blocks[0].refs, ['U1']);
  assert.deepEqual(cross.blocks[1].refs, ['U2'], '跨块位号保留在第一个块，不重复分区');

  const unknown = normalizeFunctionalBlocks({ componentRefs: ['U1'], blocks: [{ id: 'a', name: 'A', refs: ['U1', 'X9'] }] });
  assert.equal(unknown.ok, true, '未知位号不能把整块布局搞崩');
  assert.ok(codes(unknown.findings).includes(FUNCTIONAL_BLOCK_CODES.REF_UNKNOWN));
  assert.deepEqual(unknown.blocks[0].refs, ['U1', 'X9'], '声明照实保留，方便人发现写错的位号');

  // 位号大小写按“布局数据实际位号”归一：u1 → U1
  const folded = normalizeFunctionalBlocks({ componentRefs: ['U1'], blocks: [{ id: 'a', name: 'A', refs: ['u1'] }] });
  assert.deepEqual(folded.blocks[0].refs, ['U1']);
});

test('region 校验：非法矩形阻断；越界按板框裁剪并报告，完全在板外则丢弃该区域', () => {
  const base = { id: 'a', name: 'A', refs: ['U1'], region: { xMinMm: 10, yMinMm: 10, xMaxMm: 10, yMaxMm: 20 } };
  const zeroWidth = normalizeFunctionalBlocks({ componentRefs: ['U1'], blocks: [base] });
  assert.equal(zeroWidth.ok, false);
  assert.ok(codes(zeroWidth.findings).includes(FUNCTIONAL_BLOCK_CODES.REGION_INVALID));

  const missingKey = normalizeFunctionalBlocks({ componentRefs: ['U1'], blocks: [{ ...base, region: { xMinMm: 0, yMinMm: 0, xMaxMm: 10 } }] });
  assert.equal(missingKey.ok, false);

  const clamped = normalizeFunctionalBlocks({
    componentRefs: ['U1'], board: BOARD,
    blocks: [{ id: 'a', name: 'A', refs: ['U1'], region: { xMinMm: 55, yMinMm: 30, xMaxMm: 80, yMaxMm: 50 } }],
  });
  assert.equal(clamped.ok, true);
  assert.deepEqual(clamped.blocks[0].region, { xMinMm: 55, yMinMm: 30, xMaxMm: 60, yMaxMm: 40 });
  assert.ok(codes(clamped.findings).includes(FUNCTIONAL_BLOCK_CODES.REGION_CLAMPED));

  const outside = normalizeFunctionalBlocks({
    componentRefs: ['U1'], board: BOARD,
    blocks: [{ id: 'a', name: 'A', refs: ['U1'], region: { xMinMm: 100, yMinMm: 100, xMaxMm: 120, yMaxMm: 120 } }],
  });
  assert.equal(outside.ok, true);
  assert.equal(outside.blocks[0].region, null);
  assert.ok(codes(outside.findings).includes(FUNCTIONAL_BLOCK_CODES.REGION_OUTSIDE_BOARD));
});

test('未给 region 时按成员当前包围盒 + margin 推导（clamp 到板框），并保持相对位置锚定', () => {
  const plan = planFunctionalBlocks({
    blocks: [{ id: 'dcdc', name: 'DC-DC', refs: ['U1', 'C1', 'C2'] }, { id: 'battery', name: '电池管理', refs: ['U2'] }],
    board: BOARD,
    components: COMPONENTS,
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.findings));
  assert.equal(plan.blockMap.length, 2);
  const dcdc = plan.blockMap[0];
  assert.equal(dcdc.regionDerived, true);
  assert.equal(dcdc.name, 'DC-DC');
  // 成员包围盒：x 11.5..18.5、y 22.5..27.5；外扩默认 margin 后得到区域
  const margin = DEFAULT_BLOCK_MARGIN_MM;
  assert.equal(dcdc.region.xMinMm, Number((11.5 - margin).toFixed(3)));
  assert.equal(dcdc.region.xMaxMm, Number((18.5 + margin).toFixed(3)));
  assert.equal(dcdc.region.yMinMm, Number((22.5 - margin).toFixed(3)));
  assert.equal(dcdc.region.yMaxMm, Number((27.5 + margin).toFixed(3)));
  assert.equal(dcdc.regionDerived, true);
  assert.ok(dcdc.areaMm2 > 0);
  assert.ok(dcdc.componentAreaMm2 > 25, 'U1 25mm² + 两个电容');
  assert.ok(dcdc.utilization > 0 && dcdc.utilization < 1);
  // 每个成员都拿到同一块区域；每个成员都被锚定在当前位置（高权重）
  for (const ref of ['U1', 'C1', 'C2']) {
    assert.deepEqual(plan.componentRegions[ref], dcdc.region);
    const source = COMPONENTS.find((item) => item.ref === ref);
    assert.deepEqual(plan.anchors[ref], { nearX: source.current.xMm, nearY: source.current.yMm, weightNear: DEFAULT_RELATIVE_ANCHOR_WEIGHT });
  }
  assert.equal(plan.anchors.U2.nearX, 45);
  // 只有 U2 成员 → 区域以 U2 为中心
  const battery = plan.blockMap[1];
  assert.deepEqual(battery.region, { xMinMm: 39, yMinMm: 4, xMaxMm: 51, yMaxMm: 16 });

  // 确定性：同样输入两次输出逐字节一致（便于测试/复核）
  assert.deepEqual(planFunctionalBlocks({
    blocks: [{ id: 'dcdc', name: 'DC-DC', refs: ['U1', 'C1', 'C2'] }, { id: 'battery', name: '电池管理', refs: ['U2'] }],
    board: BOARD,
    components: COMPONENTS,
  }), plan);

  // 没有 blocks → 空分区图，且没有锚定/区域（旧行为不变）
  const empty = planFunctionalBlocks({ components: COMPONENTS, board: BOARD });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.blockMap, []);
  assert.deepEqual(empty.componentRegions, {});
  assert.deepEqual(empty.anchors, {});
});

test('成员缺少当前坐标时不猜区域：报 finding，分区图保留块但 region=null', () => {
  const components = [{ ref: 'U1', widthMm: 5, heightMm: 5, current: null }];
  const plan = planFunctionalBlocks({ blocks: [{ id: 'mcu', name: 'MCU', refs: ['U1'] }], board: BOARD, components });
  assert.equal(plan.ok, true);
  assert.equal(plan.blockMap[0].region, null);
  assert.equal(plan.blockMap[0].regionDerived, false);
  assert.equal(plan.blockMap[0].knownMemberCount, 1);
  assert.equal(plan.blockMap[0].unpositionedMemberCount, 1);
  assert.ok(codes(plan.findings).includes(FUNCTIONAL_BLOCK_CODES.REGION_UNDERIVABLE));
  assert.deepEqual(plan.componentRegions, {});
  assert.deepEqual(plan.anchors, {});
});

test('布局引擎：每器件 region 生效（器件被约束在区域内），默认不传 region 行为不变', () => {
  const outline = { points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], closed: true };
  const components = [
    { ref: 'A', primitiveId: 'p1', widthMm: 4, heightMm: 4, current: { xMm: 10, yMm: 10, rotationDeg: 0 }, side: 'top' },
    { ref: 'B', primitiveId: 'p2', widthMm: 4, heightMm: 4, current: { xMm: 30, yMm: 30, rotationDeg: 0 }, side: 'top' },
  ];
  const baseline = planOutlinePlacement({ outline, components, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5 });
  // 默认不传 regions 与显式传空对象等价 → 旧调用方行为完全不变
  assert.deepEqual(planOutlinePlacement({ outline, components, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5, regions: {} }), baseline);

  const region = { xMinMm: 20, yMinMm: 0, xMaxMm: 40, yMaxMm: 15 };
  const plan = planOutlinePlacement({ outline, components, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5, regions: { A: region } });
  assert.equal(plan.unplaced.length, 0, JSON.stringify(plan.unplaced));
  const a = plan.placements.find((item) => item.ref === 'A');
  assert.ok(a.xMm >= region.xMinMm - 1e-9 && a.xMm <= region.xMaxMm + 1e-9, `A.x=${a.xMm} 应在区域内`);
  assert.ok(a.yMm >= region.yMinMm - 1e-9 && a.yMm <= region.yMaxMm + 1e-9, `A.y=${a.yMm} 应在区域内`);
  assert.deepEqual(a.regionMm, region);
  assert.equal(plan.placements.find((item) => item.ref === 'B').regionMm, null);
  // 区域只是“范围约束”，板框/间距/禁布仍独立生效
  assert.equal(verifyOutlinePlacement({ placements: plan.placements, outline, edgeClearanceMm: 1, spacingMm: 0.5 }).ok, true);

  // region 也可以挂在 component 上（服务端把 componentRegions 合并进 components 的形态）
  const merged = planOutlinePlacement({ outline, components: components.map((item) => (item.ref === 'A' ? { ...item, region } : item)), edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5 });
  const mergedA = merged.placements.find((item) => item.ref === 'A');
  assert.deepEqual([mergedA.xMm, mergedA.yMm], [a.xMm, a.yMm]);
});

test('布局引擎：区域里放不下 / 区域在板外 → 明确报 REGION_UNSATISFIED，不静默忽略约束', () => {
  const outline = { points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], closed: true };
  const components = [{ ref: 'BIG', primitiveId: 'p1', widthMm: 10, heightMm: 10 }];
  // 区域贴着板边：候选点确实在区域内，但 10x10 本体过不了 1mm 边距 → 不能被“放行”
  const edgeRegion = planOutlinePlacement({ outline, components, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5, regions: { BIG: { xMinMm: 1.2, yMinMm: 1.2, xMaxMm: 1.8, yMaxMm: 1.8 } } });
  assert.equal(edgeRegion.placements.length, 0);
  assert.equal(edgeRegion.unplaced[0].reason, 'NO_FREE_SPACE');
  assert.equal(edgeRegion.ok, false);
  assert.ok(edgeRegion.findings.some((item) => item.code === PLACEMENT_CODES.REGION_UNSATISFIED && item.severity === 'blocking'));

  // 区域完全在候选网格外（板外）→ 一个候选点都进不了区域，原因必须是 NO_SPACE_IN_REGION
  const outsideRegion = planOutlinePlacement({ outline, components, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5, regions: { BIG: { xMinMm: 50, yMinMm: 50, xMaxMm: 60, yMaxMm: 60 } } });
  assert.equal(outsideRegion.unplaced[0].reason, 'NO_SPACE_IN_REGION');
  assert.ok(outsideRegion.findings.some((item) => item.code === PLACEMENT_CODES.REGION_UNSATISFIED));

  // 非法 region 不能被当成“没约束”静默放过：忽略 + warning，落位与基线一致
  const invalidRegion = planOutlinePlacement({ outline, components, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5, regions: { BIG: { xMinMm: 20, yMinMm: 20, xMaxMm: 20, yMaxMm: 22 } } });
  assert.ok(invalidRegion.findings.some((item) => item.code === PLACEMENT_CODES.REGION_INVALID && item.severity === 'warning'));
  const noRegion = planOutlinePlacement({ outline, components, edgeClearanceMm: 1, spacingMm: 0.5, gridMm: 0.5 });
  assert.deepEqual(invalidRegion.placements, noRegion.placements);
  // 归一化函数本身
  assert.deepEqual(normalizeComponentRegionMm({ xMinMm: 0, yMinMm: 0, xMaxMm: 10, yMaxMm: 10 }), { xMinMm: 0, yMinMm: 0, xMaxMm: 10, yMaxMm: 10 });
  assert.equal(normalizeComponentRegionMm({ xMinMm: 0, yMinMm: 0, xMaxMm: 0, yMaxMm: 10 }), null);
  assert.equal(normalizeComponentRegionMm(null), null);
});

/* ---------------------------------------------------------------- 真实 HTTP 路由 */

const TRUSTED_ORIGIN = 'http://127.0.0.1:4177';
const fakeKeychain = {
  async configured() { return false; },
  async store(_id, key) { return { configured: true, hint: `••••${key.slice(-4)}` }; },
  async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); },
  async remove() { return { configured: false }; },
};

/** 假桥：只提供 placement/plan 路由需要的只读命令，其余命令返回 null（证据缺失照实 REVIEW）。 */
function createPlacementBridge() {
  const calls = [];
  return {
    calls,
    port: 49620,
    selectedWindowId: 'W1',
    async discover() { return { port: 49620 }; },
    async windows() { return { windows: [{ id: 'W1' }], selectedWindowId: 'W1', selectionRequired: false }; },
    async execute(id) {
      calls.push(id);
      if (id === 'pcb.open') return { result: { opened: true, tabId: 'T1' } };
      if (id === 'document.current') return { result: { uuid: 'PCB1', documentType: 3 } };
      if (id === 'pcb.placement.read') {
        return {
          result: {
            outline: [{ source: [0, 0, 'L', 2362.2047, 0, 2362.2047, -1574.8031, 0, -1574.8031, 0, 0] }],
            components: [
              { designator: 'U1', primitiveId: 'p-u1', xMm: 10, yMm: -20, rotationDeg: 0, layerSide: 'top', padCount: 25, bboxMm: { xMm: 3.5, yMm: 3.5 }, nets: ['GND', '3V3'] },
              { designator: 'U2', primitiveId: 'p-u2', xMm: 28, yMm: -11, rotationDeg: 0, layerSide: 'top', padCount: 10, bboxMm: { xMm: 3, yMm: 3 } },
            ],
          },
        };
      }
      if (id === 'pcb.copper.read') throw Object.assign(new Error('离线：不读铜皮'), { code: 'EDA_OFFLINE' });
      return { result: null };
    },
  };
}

async function startServer(bridge) {
  const { server } = createRuntimeServer({ keychain: fakeKeychain, bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('POST /api/eda/pcb/placement/plan：blocks 传导到布局，响应带 blockMap（无 blocks 时为空数组）', async (context) => {
  const { server, base } = await startServer(createPlacementBridge());
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const health = await (await fetch(`${base}/api/health`, { headers: { origin: TRUSTED_ORIGIN } })).json();
  const headers = { 'content-type': 'application/json', 'x-circuitpilot-token': health.sessionProof };
  const postPlan = async (payload) => {
    const response = await fetch(`${base}/api/eda/pcb/placement/plan`, { method: 'POST', headers, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  };

  // 1) 没有设计意图：blockMap 必须是空数组（不是 undefined），旧字段照旧
  const plain = await postPlan({ pcbUuid: 'PCB1' });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.deepEqual(plain.body.blockMap, []);
  assert.deepEqual(plain.body.blocks.blockMap, []);
  assert.equal(plain.body.plan.placements.length, 2);
  assert.ok(plain.body.verification, '旧响应字段不能丢');

  // 2) 设计意图里声明功能分区：分区图 + 区域约束真的传导到布局
  const withBlocks = await postPlan({
    pcbUuid: 'PCB1',
    designIntent: {
      blocks: [
        { id: 'power', name: 'DC-DC', refs: ['u1'], region: { xMinMm: 40, yMinMm: -35, xMaxMm: 58, yMaxMm: -5 } },
        { id: 'mcu', name: 'MCU', refs: ['U2'] },
      ],
    },
  });
  assert.equal(withBlocks.status, 200, JSON.stringify(withBlocks.body));
  const blockMap = withBlocks.body.blockMap;
  assert.equal(blockMap.length, 2);
  assert.deepEqual(blockMap.map((item) => item.id), ['power', 'mcu']);
  assert.equal(blockMap[0].name, 'DC-DC');
  assert.deepEqual(blockMap[0].refs, ['U1'], '位号大小写必须统一成布局数据里的实际位号');
  assert.deepEqual(blockMap[0].region, { xMinMm: 40, yMinMm: -35, xMaxMm: 58, yMaxMm: -5 });
  assert.equal(blockMap[0].regionDerived, false);
  assert.equal(blockMap[1].regionDerived, true, '未给 region 的块按成员当前位置推导');
  assert.ok(blockMap[1].region.xMinMm <= 28 && blockMap[1].region.xMaxMm >= 28);
  assert.equal(withBlocks.body.blocks.ok, true, JSON.stringify(withBlocks.body.blocks.findings));

  const placementOf = (ref) => withBlocks.body.plan.placements.find((item) => item.ref === ref);
  const u1 = placementOf('U1');
  const region = blockMap[0].region;
  assert.ok(u1, 'U1 必须被放下');
  assert.ok(u1.xMm >= region.xMinMm - 1e-9 && u1.xMm <= region.xMaxMm + 1e-9, `U1.x=${u1.xMm} 应落在约定区域内`);
  assert.ok(u1.yMm >= region.yMinMm - 1e-9 && u1.yMm <= region.yMaxMm + 1e-9, `U1.y=${u1.yMm} 应落在约定区域内`);
  const u2 = placementOf('U2');
  const derived = blockMap[1].region;
  assert.ok(u2.xMm >= derived.xMinMm - 1e-9 && u2.xMm <= derived.xMaxMm + 1e-9, `U2.x=${u2.xMm} 应在推导区域内`);
  assert.ok(u2.yMm >= derived.yMinMm - 1e-9 && u2.yMm <= derived.yMaxMm + 1e-9, `U2.y=${u2.yMm} 应在推导区域内`);
  assert.deepEqual(u1.regionMm, region, '分区约束要能被 UI 追溯到具体器件');

  // 3) 用户显式 anchors 优先于“保持相对位置”的默认锚定：把 U2 钉到下边而不是停在原位
  const anchored = await postPlan({
    pcbUuid: 'PCB1',
    designIntent: { blocks: [{ id: 'mcu', name: 'MCU', refs: ['U2'], region: { xMinMm: 1, yMinMm: -39, xMaxMm: 59, yMaxMm: -1 } }] },
    anchors: { U2: { side: 'bottom', weightNear: 0 } },
  });
  assert.equal(anchored.status, 200, JSON.stringify(anchored.body));
  const u2Anchored = anchored.body.plan.placements.find((item) => item.ref === 'U2');
  assert.ok(u2Anchored.yMm < -35, `用户 anchors 优先：U2.y=${u2Anchored.yMm} 应被钉到下边（默认锚定会停在 y≈-11）`);
  assert.ok(u2Anchored.xMm >= 1 - 1e-9 && u2Anchored.xMm <= 59 + 1e-9, '仍在约定区域内');

  // 4) 未知位号只报告不崩（200 + finding），分区图仍如实保留声明
  const unknownRef = await postPlan({
    pcbUuid: 'PCB1',
    designIntent: { blocks: [{ id: 'mcu', name: 'MCU', refs: ['U1', 'X9'] }] },
  });
  assert.equal(unknownRef.status, 200, JSON.stringify(unknownRef.body));
  assert.ok(unknownRef.body.blocks.findings.some((item) => item.code === 'FUNCTIONAL_BLOCK_REF_UNKNOWN'));
  assert.deepEqual(unknownRef.body.blockMap[0].refs, ['U1', 'X9']);
  assert.equal(unknownRef.body.blockMap[0].knownMemberCount, 1);

  // 5) 服务端把真实板框 bounds 传给分区规划：越界 region 必须被裁剪（60x40 板 → xMax=60）
  const clampedRegion = await postPlan({
    pcbUuid: 'PCB1',
    designIntent: { blocks: [{ id: 'edge', name: '板边块', refs: ['U1'], region: { xMinMm: 50, yMinMm: -35, xMaxMm: 80, yMaxMm: -5 } }] },
  });
  assert.equal(clampedRegion.status, 200, JSON.stringify(clampedRegion.body));
  assert.ok(Math.abs(clampedRegion.body.outline.bounds.maxX - 60) < 1e-3, `响应板框 bounds 应为真实 mm 包围盒：${JSON.stringify(clampedRegion.body.outline.bounds)}`);
  assert.deepEqual(clampedRegion.body.blockMap[0].region, { xMinMm: 50, yMinMm: -35, xMaxMm: 60, yMaxMm: -5 });
  assert.ok(clampedRegion.body.blocks.findings.some((item) => item.code === 'FUNCTIONAL_BLOCK_REGION_CLAMPED'), JSON.stringify(clampedRegion.body.blocks.findings));

  // 6) 非法 blocks 必须 400（设计意图校验先于读板/布局）
  const bad = await postPlan({ pcbUuid: 'PCB1', designIntent: { blocks: [{ id: 'a', name: 'A', refs: ['U1'], region: { xMinMm: 5, yMinMm: 5, xMaxMm: 5, yMaxMm: 9 } }] } });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
});
