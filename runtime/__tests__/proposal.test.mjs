import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPriceEvidence, buildPartProposal, candidateIdOf, normalizeRequirement, selectProposalToPlan } from '../proposal.mjs';
import { normalizePlan } from '../design.mjs';

const LIB = '0819f05c4eef4c71ace90d822a990e87';
const ws2812 = { name: 'WS2812B-2020-V6', uuid: 'a6a2da6559dc4256a7a64ffe75e7653e', libraryUuid: LIB, lcscId: 'C52917434', footprintName: 'LED-SMD_4P-L2.2-W2.0-P1.00_WS2815C-2020-4P' };
const cap = { name: 'CL05B104KO5NNNC', uuid: 'cap-uuid-0001', libraryUuid: LIB, lcscId: 'C1525', footprintName: 'C0402' };
const resistor = { name: '0402WGF1000TCE', uuid: 'res-uuid-0001', libraryUuid: LIB, lcscId: 'C25076', footprintName: 'R0402' };

const pricingOf = (entries) => ({ kind: 'supply-pricing-evidence', schemaVersion: 1, source: 'jlcpcb-smt-component-api', entries });

test('normalizeRequirement 只保留可执行输入，并过滤非法 LCSC 料号', () => {
  const result = normalizeRequirement({
    requirement: '  补光用可编程 RGB 灯  ',
    queries: ['  WS2812B-2020 ', '', '100nF 0402'],
    lcscIds: ['c52917434', 'C1525', 'not-a-code', 'C12'],
    nets: ['+5V', ' LED_DATA ', ''],
    target: 'schematic',
  });
  assert.equal(result.requirement, '补光用可编程 RGB 灯');
  assert.deepEqual(result.queries, ['WS2812B-2020', '100nF 0402']);
  assert.deepEqual(result.lcscIds, ['C52917434', 'C1525']);
  assert.deepEqual(result.nets, ['+5V', 'LED_DATA']);
  assert.equal(result.target, 'schematic');
  assert.equal(normalizeRequirement({ target: 'pcb' }).target, 'pcb');
  assert.equal(normalizeRequirement({ target: '随便' }).target, 'schematic');
});

test('candidateIdOf 以 LCSC 料号为锚点，否则退回库 uuid，绝不产生空 id 之外的猜测', () => {
  assert.equal(candidateIdOf({ lcscId: 'c52917434', uuid: 'x' }), 'lcsc:C52917434');
  assert.equal(candidateIdOf({ uuid: 'uuid-1' }), 'uuid:uuid-1');
  assert.equal(candidateIdOf({ name: '只有名字' }), '');
});

test('价格证据只来自证据文件：没有证据就是 unknown，绝不臆造价格', () => {
  const entries = pricingOf([
    { lcsc: 'C52917434', status: 'priced', currency: 'USD', price: 0.31, stock: 12000, minQty: 1, source: 'jlcpcb-smt-component-api', priceBreaks: [{ startQty: 1, endQty: 99, unitPrice: 0.31 }] },
    { lcsc: 'C1525', status: 'unknown', reason: '接口未返回该料号' },
  ]);
  const priced = attachPriceEvidence({ lcscId: 'C52917434' }, entries);
  assert.equal(priced.status, 'priced');
  assert.equal(priced.unitPrice, 0.31);
  assert.equal(priced.stock, 12000);

  const reasoned = attachPriceEvidence({ lcscId: 'C1525' }, entries);
  assert.equal(reasoned.status, 'unknown');
  assert.match(reasoned.reason, /接口未返回/);

  const noEvidence = attachPriceEvidence({ lcscId: 'C9999999999' }, entries);
  assert.equal(noEvidence.status, 'unknown');
  assert.equal(noEvidence.unitPrice, undefined);

  const notQueried = attachPriceEvidence({ lcscId: 'C52917434' }, null);
  assert.equal(notQueried.status, 'unknown');
  assert.match(notQueried.reason, /未触发价格/);

  const noLcsc = attachPriceEvidence({ uuid: 'u' }, entries);
  assert.equal(noLcsc.status, 'unknown');
  assert.match(noLcsc.reason, /没有 LCSC 料号/);
});

test('buildPartProposal 去重、丢弃无库身份的候选，并给出确定性 id', () => {
  const proposal = buildPartProposal({
    requirement: '补光：5 颗可编程 RGB + 数据串阻 + 去耦',
    queries: ['WS2812B-2020', '100nF 0402'],
    lcscIds: [],
    nets: ['+5V', 'GND', 'LED_DATA'],
    target: 'schematic',
    candidates: [ws2812, { ...ws2812 }, cap, { name: '无库身份' , uuid: 'no-lib' }, resistor],
    pricing: pricingOf([{ lcsc: 'C52917434', status: 'priced', price: 0.31, stock: 12000, currency: 'USD' }]),
    createdAt: '2026-10-16T00:00:00.000Z',
  });
  assert.equal(proposal.candidates.length, 3);
  assert.deepEqual(proposal.candidates.map((item) => item.candidateId), ['lcsc:C52917434', 'lcsc:C1525', 'lcsc:C25076']);
  assert.equal(proposal.summary.candidates, 3);
  assert.equal(proposal.summary.priced, 1);
  assert.equal(proposal.summary.unknownPrice, 2);
  assert.equal(proposal.candidates[0].evidence.price, true);
  assert.equal(proposal.candidates[0].evidence.confirmed, false); // 未经用户勾选，永远是 false

  const again = buildPartProposal({
    requirement: '补光：5 颗可编程 RGB + 数据串阻 + 去耦',
    queries: ['WS2812B-2020', '100nF 0402'],
    nets: ['+5V', 'GND', 'LED_DATA'],
    candidates: [ws2812, cap, resistor],
    pricing: pricingOf([{ lcsc: 'C52917434', status: 'priced', price: 0.31, stock: 12000, currency: 'USD' }]),
    createdAt: '2026-10-16T00:00:00.000Z',
  });
  assert.equal(again.proposalId, proposal.proposalId); // 同输入同提案 id
});

test('selectProposalToPlan：勾选后产出的计划能被产品自己的 normalizePlan 判定为可执行', () => {
  const proposal = buildPartProposal({
    requirement: '补光：1 颗可编程 RGB + 数据串阻',
    nets: ['+5V', 'GND', 'LED_DATA'],
    candidates: [ws2812, resistor],
    pricing: pricingOf([{ lcsc: 'C52917434', status: 'priced', price: 0.31, stock: 12000, currency: 'USD' }]),
    createdAt: '2026-10-16T00:00:00.000Z',
  });
  const result = selectProposalToPlan({ proposal, selectedIds: ['lcsc:C52917434', 'lcsc:C25076'], title: '补光落板' });
  assert.equal(result.planning.ready, true, JSON.stringify(result.planning.missing));
  assert.equal(result.plan.operations.length, 2);
  assert.equal(result.selection.confirmedByUser, true);
  const [first] = result.plan.operations;
  // 参数必须与桥接命令 schematic.component.create 的契约一致（执行器把 args 原样透传）。
  assert.deepEqual(Object.keys(first.args).sort(), ['addIntoBom', 'addIntoPcb', 'component', 'mirror', 'rotation', 'subPartName', 'x', 'y'].sort());
  assert.deepEqual(first.args.component, { libraryUuid: LIB, uuid: ws2812.uuid });
  assert.equal(first.args.addIntoBom, true);
  assert.equal(first.args.addIntoPcb, true);
  // 把产出的 plan 再送回产品校验器：必须被判为 ready（这就是"能落 plan"的硬证据）。
  const revalidated = normalizePlan(result.plan);
  assert.equal(revalidated.ready, true, JSON.stringify(revalidated.missing));
  assert.equal(revalidated.planHash, result.planHash);
});

test('selectProposalToPlan：未勾选 / 未知候选 / 缺网络 都必须 ready=false 并给出具体缺失', () => {
  const proposal = buildPartProposal({ requirement: 'x', nets: [], candidates: [ws2812], createdAt: '2026-10-16T00:00:00.000Z' });

  const empty = selectProposalToPlan({ proposal, selectedIds: [] });
  assert.equal(empty.planning.ready, false);
  assert.ok(empty.planning.missing.includes('selection:未勾选任何候选'));
  assert.ok(empty.planning.missing.some((item) => item.startsWith('nets:')));

  const unknown = selectProposalToPlan({ proposal, selectedIds: ['lcsc:C0000000'] });
  assert.equal(unknown.planning.ready, false);
  assert.ok(unknown.planning.missing.includes('unknown-selection:lcsc:C0000000'));

  const noProposal = selectProposalToPlan({ proposal: null, selectedIds: ['lcsc:C52917434'] });
  assert.equal(noProposal.planning.ready, false);
  assert.ok(noProposal.planning.missing.some((item) => item.startsWith('proposal:')));

  const overLimit = selectProposalToPlan({ proposal, selectedIds: Array.from({ length: 41 }, (_, index) => `lcsc:C${1000 + index}`) });
  assert.equal(overLimit.planning.ready, false);
  assert.ok(overLimit.planning.missing.some((item) => item.startsWith('selection:一次最多')));
});

test('selectProposalToPlan：网络名可以由参数覆盖，但绝不替用户发明网络', () => {
  const proposal = buildPartProposal({ requirement: 'x', nets: ['+5V'], candidates: [ws2812], createdAt: '2026-10-16T00:00:00.000Z' });
  const overridden = selectProposalToPlan({ proposal, selectedIds: ['lcsc:C52917434'], nets: ['+5V', 'GND', 'LED_DATA'] });
  assert.deepEqual(overridden.plan.nets, ['GND', '+5V', 'LED_DATA'].sort());
  assert.equal(overridden.planning.ready, true);

  const none = selectProposalToPlan({ proposal: buildPartProposal({ candidates: [ws2812] }), selectedIds: ['lcsc:C52917434'], nets: [] });
  assert.equal(none.planning.ready, false);
  assert.ok(none.planning.missing.some((item) => item.startsWith('nets:')));
});

test('selectProposalToPlan：同一型号重复勾选 = 用量（真板补光 5 颗 WS2812），且位置不重叠', () => {
  const proposal = buildPartProposal({ requirement: '补光 5 颗', nets: ['+5V', 'GND', 'LED_DATA'], candidates: [ws2812, resistor], createdAt: '2026-10-16T00:00:00.000Z' });
  const result = selectProposalToPlan({
    proposal,
    selectedIds: ['lcsc:C52917434', 'lcsc:C52917434', 'lcsc:C52917434', 'lcsc:C52917434', 'lcsc:C52917434', 'lcsc:C25076'],
  });
  assert.equal(result.planning.ready, true, JSON.stringify(result.planning.missing));
  assert.equal(result.plan.operations.length, 6);
  assert.equal(result.selection.totalParts, 6);
  assert.equal(result.selection.selected.find((item) => item.candidateId === 'lcsc:C52917434').quantity, 5);
  const positions = new Set(result.plan.operations
    .filter((operation) => operation.args.component.uuid === ws2812.uuid)
    .map((operation) => `${operation.args.x},${operation.args.y}`));
  assert.equal(positions.size, 5); // 5 颗必须落在互不相同的位置
  assert.equal(normalizePlan(result.plan).ready, true);
});

test('价格查询失败要如实说"查询失败"，不能伪装成"没查询"', () => {
  const failed = attachPriceEvidence({ lcscId: 'C52917434' }, { available: false, error: 'jlcpcb 接口超时', entries: [] });
  assert.equal(failed.status, 'unknown');
  assert.match(failed.reason, /价格\/库存查询失败：jlcpcb 接口超时/);
});
