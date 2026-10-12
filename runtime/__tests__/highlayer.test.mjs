import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS } from '../bridge.mjs';
import { ApprovalStore } from '../design.mjs';
import { engineeringProfiles } from '../engineering/engine.mjs';
import { LAYER_IDS, PLAN_COPPER_LAYER_COUNTS, copperLayerIds, planCopperRoles, resolveLayerReference } from '../engineering/layers.mjs';
import { validateStackup } from '../engineering/stackup.mjs';
import { PCB_CAPABILITIES, normalizePcbPlan, PcbManager } from '../pcb.mjs';
import { compileSemanticPlan, RULE_PROFILES } from '../production.mjs';

/** 本地记录的板厂叠层；roleAt(index) 可显式声明每层角色。 */
const stackupOf = (copperLayers, roleAt) => ({
  id: `local-${copperLayers}l`, source: '本地记录的板厂叠层',
  layers: Array.from({ length: copperLayers * 2 - 1 }, (_, index) => (index % 2 === 0
    ? { name: `L${index / 2 + 1}`, type: 'copper', thicknessUm: 35, ...(roleAt?.(index / 2) ? { role: roleAt(index / 2) } : {}) }
    : { name: `d${index}`, type: 'dielectric', thicknessMm: 0.2, er: 4.3 })),
});

function highLayerPlan(layers, overrides = {}) {
  const name = `L${Math.min(4, layers)}`;
  return {
    projectId: `multi-${layers}l`, title: `${layers} 层板`,
    board: { widthMm: 80, heightMm: 60, layers, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 },
    components: [
      { ref: 'U1', primitiveId: 'c-u1', footprint: 'BGA-256', side: 'top', placement: { xMm: 20, yMm: 20, rotation: 0 }, sizeMm: { width: 10, height: 10 } },
      { ref: 'U2', primitiveId: 'c-u2', footprint: 'QFN-48', side: 'top', placement: { xMm: 55, yMm: 40, rotation: 0 }, sizeMm: { width: 7, height: 7 } },
    ],
    nets: [
      { name: 'VBUS', class: 'power', endpoints: [{ ref: 'U1', pin: 'A1', xMm: 20, yMm: 20 }, { ref: 'U2', pin: 'VDD', xMm: 55, yMm: 40 }] },
      { name: 'DDR_DQ0', class: 'signal', layer: name, endpoints: [{ ref: 'U1', pin: 'B1', xMm: 20, yMm: 25 }, { ref: 'U2', pin: 'D0', xMm: 55, yMm: 45 }] },
    ],
    silkscreen: [], decisions: [], evidence: [{ kind: 'stackup', id: `stack-${layers}l` }],
    constraints: { profileId: `jlc-${layers}l`, minClearanceMm: 0.2, minCopperToEdgeMm: 0.3, impedance: { stackupSource: '板厂叠层单' }, stackup: stackupOf(layers) },
    ...overrides,
  };
}
const poursOf = (compiled) => compiled.compiled.operations.filter((operation) => operation.type === 'pcb.pour.create').map((operation) => `${operation.args.net}@${operation.args.layer}`);

test('层编号换算覆盖到官方上限 32 层', () => {
  for (const layers of [10, 12, 16, 24, 32]) {
    const ids = copperLayerIds(layers);
    assert.equal(ids.length, layers, `${layers} 层应有 ${layers} 个铜层编号`);
    assert.equal(ids[0], LAYER_IDS.TOP);
    assert.equal(ids.at(-1), LAYER_IDS.BOTTOM);
    // 内层必须连续落在 15..44，且末尾不能越过官方 INNER_30=44。
    const inner = ids.slice(1, -1);
    assert.deepEqual(inner, Array.from({ length: layers - 2 }, (_, index) => LAYER_IDS.INNER_1 + index));
    assert.equal(inner.length, layers - 2);
    if (layers === 32) assert.equal(inner.at(-1), LAYER_IDS.LAST_INNER, '32 层板最后一内层应为 INNER_30=44');
  }
  // 符号解析在高层数下依然正确：12 层板的 L4 是 17，L12 是底铜 2。
  assert.equal(resolveLayerReference('L4', 12), 17);
  assert.equal(resolveLayerReference('L12', 12), LAYER_IDS.BOTTOM);
  assert.equal(resolveLayerReference('L12', 32), 25);
  assert.equal(resolveLayerReference('L32', 32), LAYER_IDS.BOTTOM);
  assert.equal(resolveLayerReference('L33', 32), null, '超出层数的符号必须解析失败而不是夹紧');
});

test('叠层校验接受 2..32 的全部偶数层，拒绝奇数与超范围', () => {
  for (const layers of [2, 4, 10, 12, 16, 24, 32]) {
    assert.equal(validateStackup(stackupOf(layers)).ready, true, `${layers} 层叠层应通过`);
  }
  for (const bad of [3, 5, 34, 0]) {
    const check = validateStackup({ id: 'x', source: 'y', layers: Array.from({ length: bad }, (_, index) => ({ name: `L${index}`, type: 'copper', thicknessUm: 35 })) });
    assert.ok(check.findings.some((item) => item.code === 'STACKUP_LAYER_COUNT_UNSUPPORTED'), `${bad} 层应被拒绝`);
  }
});

test('12 层计划可编译并进入执行：平面按推导角色分配，DRC 仍在最后', () => {
  const compiled = compileSemanticPlan(highLayerPlan(12));
  assert.equal(compiled.ready, true, JSON.stringify(compiled.issues));
  assert.equal(compiled.compiled.operations.at(-1).type, 'pcb.drc');
  // 推导角色：外层信号，内层交替地/电源 → 5 个地平面 + 5 个电源平面 + 顶层地铺铜。
  const pours = poursOf(compiled);
  assert.deepEqual(pours, [
    'GND@1',
    'GND@15', 'VBUS@16', 'GND@17', 'VBUS@18', 'GND@19', 'VBUS@20', 'GND@21', 'VBUS@22', 'GND@23', 'VBUS@24',
  ]);
  // 12 层板的 L4 = 17，走线必须落在 17 层。
  const routes = compiled.compiled.operations.filter((operation) => operation.type === 'pcb.line.create' && operation.args.net === 'DDR_DQ0');
  assert.ok(routes.length > 0 && routes.every((operation) => operation.args.layer === 17), 'L4 应映射为 17');
  // 执行阶段必须接受同一份计划。
  assert.equal(normalizePcbPlan(compiled.compiled).ready, true);
});

test('显式声明层角色后，只有声明的平面层被铺铜（高层数下由设计者控制）', () => {
  // L1 信号 / L2 地 / L3 电源 / 其余内层为信号 —— 真实高层数叠层的常见做法。
  const roleAt = (index) => (index === 0 || index === 11 ? 'signal' : index === 1 ? 'ground' : index === 2 ? 'power' : 'signal');
  const compiled = compileSemanticPlan(highLayerPlan(12, {
    constraints: { profileId: 'jlc-12l', minClearanceMm: 0.2, minCopperToEdgeMm: 0.3, impedance: { stackupSource: 'x' }, stackup: stackupOf(12, roleAt) },
  }));
  assert.equal(compiled.ready, true, JSON.stringify(compiled.issues));
  // 只有 L2(15) 地平面与 L3(16) 电源平面被铺铜，其余内层保持信号，不盲目铺满。
  assert.deepEqual(poursOf(compiled), ['GND@1', 'GND@15', 'VBUS@16']);
  // 角色来源必须标注清楚，人工复核时能区分“叠层声明的”与“推导的”。
  const roles = planCopperRoles(stackupOf(12, roleAt), 12);
  assert.equal(roles.layers[1].source, 'stackup-declared');
  assert.equal(roles.groundPlaneLayers.length, 1);
  assert.equal(roles.powerPlaneLayers.length, 1);
  assert.equal(roles.signalLayers.length, 10);
  // 缝合孔只针对真正存在的地平面。
  const vias = compiled.compiled.operations.filter((operation) => operation.type === 'pcb.via.create' && operation.args.net === 'GND');
  assert.equal(vias.length, 4, '只有一个地平面时应只有四角缝合孔');
});

test('32 层计划（官方上限）可编译，且每层编号都合法', () => {
  const compiled = compileSemanticPlan(highLayerPlan(32));
  assert.equal(compiled.ready, true, JSON.stringify(compiled.issues));
  const pours = poursOf(compiled);
  assert.equal(pours[0], 'GND@1');
  // 30 个内层全部铺铜 + 顶层。
  assert.equal(pours.length, 31);
  assert.equal(pours.at(-1).endsWith('@44'), true, `最后一内层应为 44: ${pours.at(-1)}`);
  // 所有下发的层号都是该层数的合法铜层，且绝不出现丝印/阻焊层。
  const layersUsed = new Set(compiled.compiled.operations.flatMap((operation) => (Number.isInteger(operation.args?.layer) ? [operation.args.layer] : [])));
  const valid = new Set([...copperLayerIds(32), LAYER_IDS.BOARD_OUTLINE]);
  for (const layer of layersUsed) assert.ok(valid.has(layer), `非法层号 ${layer}`);
  for (const forbidden of [3, 4, 5, 6, 12, 13, 14]) assert.ok(!layersUsed.has(forbidden), `不得使用非铜层 ${forbidden}`);
  assert.equal(normalizePcbPlan(compiled.compiled).ready, true);
});

test('所有受支持层数都有档位，且档位层数必须与计划一致', () => {
  for (const layers of [4, 10, 16, 32]) {
    assert.ok(RULE_PROFILES[`jlc-${layers}l`], `缺少 ${layers} 层档位`);
    assert.equal(RULE_PROFILES[`jlc-${layers}l`].layers, layers);
  }
  // 用错档位（层数不匹配）必须阻断：给 10/16/32 层套四层档位。
  // 注意 4 层套 jlc-4l 是**正确**的，不能拿来当反例。
  for (const layers of [10, 16, 32]) {
    const wrong = compileSemanticPlan(highLayerPlan(layers, {
      constraints: { profileId: 'jlc-4l', minClearanceMm: 0.2, minCopperToEdgeMm: 0.3, impedance: { stackupSource: 'x' }, stackup: stackupOf(layers) },
    }));
    assert.equal(wrong.ready, false);
    assert.ok(wrong.blocking.some((item) => item.code === 'RULE_PROFILE_LAYER_MISMATCH'), `${layers} 层套用四层档位应被拦下`);
  }
});

test('12 层板端到端执行：内层走线下发，DRC 晚于全部写入', async () => {
  const compiled = compileSemanticPlan(highLayerPlan(12));
  const execPlan = normalizePcbPlan(compiled.compiled);
  assert.equal(execPlan.ready, true);

  const commands = [];
  let source = '{"board":"before"}';
  const documentLayers = [...copperLayerIds(12), LAYER_IDS.BOARD_OUTLINE].map((id) => ({ id }));
  const bridge = {
    selectedWindowId: 'W1',
    async execute(id, args = {}) {
      commands.push({ id, args });
      if (id === 'project.current') return { result: { uuid: 'P1' } };
      if (id === 'document.current') return { result: { uuid: 'D1', documentType: 3 } };
      if (id === 'pcb.layers.read') return { result: documentLayers };
      if (/^pcb\.(nets|components|lines|vias|pours|regions|texts)\.read$/.test(id)) return { result: [] };
      if (id === 'pcb.rules.read') return { result: {} };
      if (id === 'pcb.source.read') return { result: source };
      if (id === 'document.source.restore') { source = args.source; return { result: true }; }
      if (id === 'pcb.save') return { result: true };
      if (id === 'pcb.drc') return { result: [] };
      source = '{"board":"mutated"}';
      return { result: { primitiveId: `${id}-1` } };
    },
  };
  const manager = new PcbManager({ bridge, approvals: new ApprovalStore() });
  const context = await manager.context();
  const approval = manager.approve({ plan: execPlan.plan, targetFingerprint: context.targetFingerprint, windowId: context.windowId });
  const result = await manager.execute({ plan: execPlan.plan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: context.windowId });
  assert.equal(result.state, 'completed', JSON.stringify(result.error ?? {}));
  assert.equal(result.drc.passed, true);
  // 文档层核对：12 层文档的铜层编号被正确识别（不含丝印/阻焊）。
  assert.deepEqual(result.layerCheck.documentCopperLayerIds, [1, 2, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  assert.equal(result.layerCheck.declaredLayerCount, 12);
  // 内层走线以 17 层下发。
  assert.ok(commands.some((command) => command.id === 'pcb.line.create' && command.args.net === 'DDR_DQ0' && command.args.layer === 17));
  // 受控执行不变：DRC 晚于全部改板写入，之后不得再有写命令。
  const ids = commands.map((command) => command.id);
  const drcIndex = ids.indexOf('pcb.drc');
  for (const mutation of ['pcb.line.create', 'pcb.pour.create', 'pcb.via.create', 'pcb.component.modify']) {
    assert.ok(ids.lastIndexOf(mutation) < drcIndex, `官方 DRC 必须晚于 ${mutation}`);
  }
  for (const id of ids.slice(drcIndex + 1)) {
    assert.ok(!['pcb.line.create', 'pcb.pour.create', 'pcb.via.create', 'pcb.component.modify'].includes(id), `DRC 之后出现了改板写入: ${id}`);
    const permission = COMMANDS[id]?.permission ?? 'read';
    if (['write', 'write-beta', 'export-beta'].includes(permission)) assert.equal(id, 'pcb.save', `DRC 之后出现了写命令: ${id}`);
  }
});

test('4/6/8 层行为不受本次扩容影响（回归）', () => {
  for (const [layers, expected] of [[4, ['GND@1', 'GND@15', 'VBUS@16']], [6, ['GND@1', 'GND@15', 'VBUS@16', 'GND@17', 'VBUS@18']], [8, ['GND@1', 'GND@15', 'VBUS@16', 'GND@17', 'VBUS@18', 'GND@19', 'VBUS@20']]]) {
    const compiled = compileSemanticPlan(highLayerPlan(layers));
    assert.equal(compiled.ready, true, `${layers} 层: ${JSON.stringify(compiled.issues)}`);
    assert.deepEqual(poursOf(compiled), expected, `${layers} 层平面分配发生变化`);
  }
});

test('对外能力清单必须由真实实现推导（防止再次失真）', () => {
  const profiles = engineeringProfiles();
  assert.deepEqual(profiles.layers, [...PLAN_COPPER_LAYER_COUNTS], '能力清单层数必须等于执行放行范围');
  assert.equal(profiles.maxCopperLayers, 32, '官方 setTheNumberOfCopperLayers 上限为 32');
  assert.deepEqual(profiles.layerProfiles, Object.keys(RULE_PROFILES), '能力清单档位必须等于实际档位');
  assert.ok(profiles.layers.includes(10) && profiles.layers.includes(32), '扩容后 10/32 层必须出现在能力清单里');
  // PCB_CAPABILITIES 的说明也不得再声称只放行 2/4/6/8。
  const multi = PCB_CAPABILITIES.find((item) => item.id === 'multi-layer');
  assert.ok(multi, '缺少 multi-layer 能力项');
  assert.match(multi.reason, /32/, 'multi-layer 能力说明应写明现行层数范围');
});
