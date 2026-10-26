import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS } from '../bridge.mjs';
import { ApprovalStore } from '../design.mjs';
import { normalizePcbPlan, PcbManager } from '../pcb.mjs';
import { compileSemanticPlan, RULE_PROFILES } from '../production.mjs';

/** 本地记录的板厂叠层数据（4/6/8 层通用）。没有这份数据，多层板不允许执行。 */
const stackupOf = (copperLayers) => ({
  id: `local-${copperLayers}l`, source: '本地记录的板厂叠层',
  layers: Array.from({ length: copperLayers * 2 - 1 }, (_, index) => (index % 2 === 0
    ? { name: `L${index / 2 + 1}`, type: 'copper', thicknessUm: 35 }
    : { name: `d${index}`, type: 'dielectric', thicknessMm: 0.2, er: 4.3 })),
});

/** 四层高速板基准输入：一块 MCU + 连接器，一条电源网、一条明确要求走内层 L2 的信号网。 */
function fourLayerInput(overrides = {}) {
  return {
    projectId: 'multi-4l', title: '四层高速板', board: { widthMm: 60, heightMm: 40, layers: 4, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 },
    components: [
      { ref: 'J1', primitiveId: 'c-j1', footprint: 'USB-C', side: 'top', placement: { xMm: 4, yMm: 20, rotation: 0 }, sizeMm: { width: 2, height: 8 } },
      { ref: 'U1', primitiveId: 'c-u1', footprint: 'TSSOP-20', side: 'top', placement: { xMm: 30, yMm: 20, rotation: 0 }, sizeMm: { width: 7, height: 7 } },
    ],
    nets: [
      { name: 'VBUS', class: 'power', endpoints: [{ ref: 'J1', pin: 'A4', xMm: 5, yMm: 20 }, { ref: 'U1', pin: 'VDD', xMm: 27, yMm: 20 }] },
      { name: 'USB_DP', class: 'signal', layer: 'L2', endpoints: [{ ref: 'J1', pin: 'A6', xMm: 5, yMm: 18 }, { ref: 'U1', pin: 'D1', xMm: 27, yMm: 18 }] },
    ],
    silkscreen: [], decisions: [], evidence: [{ kind: 'stackup', id: 'stack-4l' }],
    constraints: { profileId: 'jlc-4l', minClearanceMm: 0.2, minCopperToEdgeMm: 0.3, impedance: { stackupSource: '嘉立创四层板 1.6mm' }, stackup: stackupOf(4) },
    ...overrides,
  };
}
const opsOf = (result, type) => result.compiled.operations.filter((operation) => operation.type === type);

test('内层走线落在正确的铜层编号上：四层板的 L2 是 15，不是 2 也不是 3', () => {
  const result = compileSemanticPlan(fourLayerInput());
  assert.equal(result.ready, true, JSON.stringify(result.issues));

  const inner = opsOf(result, 'pcb.line.create').filter((operation) => operation.args.net === 'USB_DP');
  assert.ok(inner.length > 0, '内层网络必须生成走线');
  assert.ok(inner.every((operation) => operation.args.layer === 15), `L2 应映射为 15: ${JSON.stringify(inner.map((o) => o.args.layer))}`);
  // 这两条是防“叠层序号当层号用”的核心断言：2 是底铜、3 是顶层丝印。
  assert.ok(!inner.some((operation) => operation.args.layer === 3), '绝不允许把走线画到丝印层(3)');
  assert.ok(!inner.some((operation) => operation.args.layer === 2), '绝不允许把 L2 误当地铜(2)');
});

test('多层板按叠层角色铺内层平面：L2 地平面、L3 电源平面，并保留顶层地铺铜', () => {
  const result = compileSemanticPlan(fourLayerInput());
  const pours = opsOf(result, 'pcb.pour.create').map((operation) => ({ net: operation.args.net, layer: operation.args.layer }));
  assert.deepEqual(pours, [
    { net: 'GND', layer: 1 },      // 顶层地铺铜（与双层板一致）
    { net: 'GND', layer: 15 },     // L2 地平面
    { net: 'VBUS', layer: 16 },    // L3 电源平面
  ]);
  // 走线在 15 层，铺铜在 15/16 层 —— 内层确实被使用，而不是只写在计划里。
  assert.deepEqual(result.quality.metrics.usedLayers, [1, 15, 16]);
});

test('层间转换：焊盘在外层、走线在内层时必须生成通孔', () => {
  const result = compileSemanticPlan(fourLayerInput());
  const vias = opsOf(result, 'pcb.via.create').map((operation) => operation.args);
  // USB_DP 的两个焊盘都在顶层，走线在 L2(15) → 两个端点各需要一个通孔。
  const transition = vias.filter((via) => via.net === 'USB_DP');
  assert.equal(transition.length, 2, `层间转换过孔数量不对: ${JSON.stringify(vias)}`);
  assert.deepEqual(transition.map((via) => [via.x, via.y]).sort((a, b) => a[0] - b[0]), [[5, 18], [27, 18]]);
  // 过孔几何取自档位下限，且不传 viaType（用官方默认通孔行为，避开未核实的枚举编码）。
  for (const via of transition) {
    assert.equal(via.holeDiameter, RULE_PROFILES['jlc-4l'].minViaDrillMm);
    assert.equal(via.diameter, RULE_PROFILES['jlc-4l'].minViaDiameterMm);
    assert.equal('viaType' in via, false);
  }
  // VBUS 走顶层，焊盘也在顶层 → 不产生多余过孔。
  assert.equal(vias.filter((via) => via.net === 'VBUS').length, 0);
});

test('地平面缝合孔：把顶层地铺铜连到内层地平面', () => {
  const result = compileSemanticPlan(fourLayerInput());
  const stitching = opsOf(result, 'pcb.via.create').filter((operation) => operation.args.net === 'GND');
  assert.equal(stitching.length, 4, '四角应各有一个缝合孔');
  const corners = stitching.map((operation) => [operation.args.x, operation.args.y]);
  assert.deepEqual(corners.sort((a, b) => a[0] - b[0] || a[1] - b[1]), [[1, 1], [1, 39], [59, 1], [59, 39]]);
  assert.deepEqual(result.quality.metrics, { ...result.quality.metrics, viaCount: 6, pourCount: 3 });

  // 显式关闭缝合孔后不再生成。
  const disabled = compileSemanticPlan(fourLayerInput({ constraints: { ...fourLayerInput().constraints, groundStitching: false } }));
  assert.equal(opsOf(disabled, 'pcb.via.create').filter((operation) => operation.args.net === 'GND').length, 0);
});

test('显式平面声明优先于自动推导，且同层不会重复铺铜', () => {
  const constraints = { ...fourLayerInput().constraints, planes: [{ net: 'GND', layer: 'L3' }] };
  const result = compileSemanticPlan(fourLayerInput({ constraints }));
  const pours = opsOf(result, 'pcb.pour.create').map((operation) => ({ net: operation.args.net, layer: operation.args.layer }));
  // L3=16 被显式改判为地平面，覆盖自动推导的电源平面；16 层只出现一次。
  assert.deepEqual(pours, [{ net: 'GND', layer: 1 }, { net: 'GND', layer: 15 }, { net: 'GND', layer: 16 }]);
  assert.equal(pours.filter((pour) => pour.layer === 16).length, 1, '同一层不得重复铺铜');
});

test('没有电源网络时不凭空发明电源平面网络名', () => {
  const input = fourLayerInput();
  input.nets = input.nets.filter((net) => net.class !== 'power');
  input.nets[0].layer = undefined;
  const result = compileSemanticPlan(input);
  const pours = opsOf(result, 'pcb.pour.create').map((operation) => operation.args);
  assert.ok(!pours.some((pour) => pour.net === 'VCC' || pour.net === 'VBUS'), `不该出现未声明的电源网络: ${JSON.stringify(pours.map((p) => [p.net, p.layer]))}`);
  assert.deepEqual(pours.map((pour) => pour.layer), [1, 15], '只应有顶层铺铜与地平面');
});

test('非铜层声明必须阻断：layer=3（丝印）、L5（超出层数）、平面层非法', () => {
  const silkscreen = compileSemanticPlan(fourLayerInput({ nets: [{ name: 'USB_DP', class: 'signal', layer: 3, endpoints: [{ ref: 'J1', pin: 'A6', xMm: 5, yMm: 18 }, { ref: 'U1', pin: 'D1', xMm: 27, yMm: 18 }] }] }));
  assert.equal(silkscreen.ready, false);
  assert.ok(silkscreen.blocking.some((item) => item.code === 'NET_LAYER_INVALID'), JSON.stringify(silkscreen.blocking.map((i) => i.code)));
  assert.equal(silkscreen.compiled, null, '校验未通过时不得产出编译结果');

  for (const bad of ['L5', 'L0', 'inner', 11]) {
    const result = compileSemanticPlan(fourLayerInput({ nets: [{ name: 'USB_DP', class: 'signal', layer: bad, endpoints: [{ ref: 'J1', pin: 'A6', xMm: 5, yMm: 18 }, { ref: 'U1', pin: 'D1', xMm: 27, yMm: 18 }] }] }));
    assert.equal(result.ready, false, `layer=${bad} 应被阻断`);
    assert.ok(result.blocking.some((item) => item.code === 'NET_LAYER_INVALID'), `layer=${bad} 未报 NET_LAYER_INVALID`);
  }

  const badPlane = compileSemanticPlan(fourLayerInput({ constraints: { ...fourLayerInput().constraints, planes: [{ net: 'GND', layer: 3 }] } }));
  assert.equal(badPlane.ready, false);
  assert.ok(badPlane.blocking.some((item) => item.code === 'PLANE_LAYER_INVALID'));
});

test('焊盘全在底面的网络自动布到底层，不产生多余过孔', () => {
  const input = fourLayerInput({
    components: [
      { ref: 'J1', primitiveId: 'c-j1', footprint: 'USB-C', side: 'bottom', placement: { xMm: 4, yMm: 20, rotation: 0 }, sizeMm: { width: 2, height: 8 } },
      { ref: 'U1', primitiveId: 'c-u1', footprint: 'TSSOP-20', side: 'bottom', placement: { xMm: 30, yMm: 20, rotation: 0 }, sizeMm: { width: 7, height: 7 } },
    ],
    nets: [{ name: 'USB_DP', class: 'signal', endpoints: [{ ref: 'J1', pin: 'A6', xMm: 5, yMm: 18 }, { ref: 'U1', pin: 'D1', xMm: 27, yMm: 18 }] }],
  });
  const result = compileSemanticPlan(input);
  assert.ok(opsOf(result, 'pcb.line.create').filter((operation) => operation.stage === 'routing').every((operation) => operation.args.layer === 2), '全底面焊盘的网络应布到底层');
  assert.equal(opsOf(result, 'pcb.via.create').filter((operation) => operation.args.net === 'USB_DP').length, 0);
  // 元件也要落在底层。
  assert.ok(opsOf(result, 'pcb.component.modify').every((operation) => operation.args.property.layer === 2));
});

test('双层板执行路径完全不变：单层走线、单次铺铜、无过孔', () => {
  const input = fourLayerInput({
    board: { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 },
    nets: [{ name: 'VBUS', class: 'power', endpoints: [{ ref: 'J1', pin: 'A4', xMm: 5, yMm: 20 }, { ref: 'U1', pin: 'VDD', xMm: 27, yMm: 20 }] }],
    constraints: { profileId: 'jlc-low-cost-2l', minClearanceMm: 0.2, minCopperToEdgeMm: 0.3 },
  });
  const result = compileSemanticPlan(input);
  assert.equal(result.ready, true, JSON.stringify(result.issues));
  assert.ok(opsOf(result, 'pcb.line.create').filter((operation) => operation.stage === 'routing').every((operation) => operation.args.layer === 1));
  assert.equal(opsOf(result, 'pcb.pour.create').length, 1);
  assert.equal(opsOf(result, 'pcb.pour.create')[0].args.layer, 1);
  assert.equal(opsOf(result, 'pcb.via.create').length, 0);
  assert.deepEqual(result.quality.metrics.usedLayers, [1]);
});

test('六层/八层：平面交替分配，且官方 DRC 仍在最后一位', () => {
  for (const [layers, profileId, expectedPlanes] of [[6, 'jlc-6l', [15, 16, 17, 18]], [8, 'jlc-8l', [15, 16, 17, 18, 19, 20]]]) {
    const input = fourLayerInput({
      board: { widthMm: 60, heightMm: 40, layers, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 },
      constraints: { profileId, minClearanceMm: 0.2, minCopperToEdgeMm: 0.3, impedance: { stackupSource: 'x' }, stackup: stackupOf(layers) },
      nets: [
        { name: 'VBUS', class: 'power', endpoints: [{ ref: 'J1', pin: 'A4', xMm: 5, yMm: 20 }, { ref: 'U1', pin: 'VDD', xMm: 27, yMm: 20 }] },
        { name: 'USB_DP', class: 'signal', endpoints: [{ ref: 'J1', pin: 'A6', xMm: 5, yMm: 18 }, { ref: 'U1', pin: 'D1', xMm: 27, yMm: 18 }] },
      ],
    });
    const result = compileSemanticPlan(input);
    assert.equal(result.ready, true, `${layers}层: ${JSON.stringify(result.issues)}`);
    const planeLayers = opsOf(result, 'pcb.pour.create').map((operation) => operation.args.layer).filter((layer) => layer !== 1);
    assert.deepEqual(planeLayers, expectedPlanes, `${layers}层平面层分配不对`);
    assert.ok(result.compiled.operations.filter((operation) => operation.args?.layer !== undefined || operation.type === 'pcb.line.create' || operation.type === 'pcb.pour.create').length > 0);
    assert.equal(result.compiled.operations.at(-1).type, 'pcb.drc', '官方 DRC 必须是最后一个操作');
    assert.equal(result.compiled.operations.at(-2).type, 'pcb.save', '保存必须在 DRC 之前');
  }
});

test('多层编译保持确定性且不引入脚本', () => {
  const first = compileSemanticPlan(fourLayerInput());
  const second = compileSemanticPlan(fourLayerInput());
  assert.equal(first.compiledPlanHash, second.compiledPlanHash);
  assert.equal(JSON.stringify(first.compiled).includes('script'), false);
  assert.equal(first.quality.humanReviewRequired, true, '多层板同样必须人工复核');
});

test('四层计划端到端可执行：语义编译 -> 执行计划 -> 管理器落板，官方 DRC 通过', async () => {
  const compiled = compileSemanticPlan(fourLayerInput());
  assert.equal(compiled.ready, true, JSON.stringify(compiled.issues));
  // 语义计划必须先能转成执行计划，否则“多层执行能力”只是纸面能力。
  const execPlan = normalizePcbPlan(compiled.compiled);
  assert.equal(execPlan.ready, true, `执行计划应可用: ${JSON.stringify(execPlan.missing)}`);

  const commands = [];
  let source = '{"board":"before"}';
  const bridge = {
    selectedWindowId: 'W1',
    async execute(id, args = {}) {
      commands.push({ id, args });
      if (id === 'project.current') return { result: { uuid: 'P1' } };
      if (id === 'document.current') return { result: { uuid: 'D1', documentType: 3 } };
      if (/^pcb\.(layers|nets|components|lines|vias|pours|regions|texts|outline)\.read$/.test(id)) return { result: [] };
      if (id === 'pcb.rules.read') return { result: {} };
      if (id === 'pcb.source.read') return { result: source };
      if (id === 'document.source.restore') { source = args.source; return { result: true }; }
      if (id === 'pcb.save') return { result: true };
      // DRC 走 EDA 渲染进程后台任务：start 只回 jobId，poll 回结果信封。
      // 改造前这里是单次阻塞调用，真实板子上永远装不进一次 HTTP 预算。
      if (id === 'pcb.drc.job.start') return { result: { jobId: args.jobId, accepted: true, state: 'running' } };
      if (id === 'pcb.job.poll') return { result: { jobId: args.jobId, state: 'done', result: { kind: 'array', count: 0, items: [], truncated: false } } };
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

  // 内层走线确实下发到 EDA，且层号是 15；绝不允许落到丝印层(3)。
  const lineLayers = commands.filter((command) => command.id === 'pcb.line.create').map((command) => command.args.layer);
  assert.ok(lineLayers.includes(15), `内层走线未下发: ${JSON.stringify([...new Set(lineLayers)])}`);
  assert.ok(!lineLayers.includes(3), '走线不得落到丝印层');
  // 内层平面铺铜下发：1=顶层地，15=L2 地平面，16=L3 电源平面(VBUS)。
  const pourLayers = [...new Set(commands.filter((command) => command.id === 'pcb.pour.create').map((command) => command.args.layer))].sort((a, b) => a - b);
  assert.deepEqual(pourLayers, [1, 15, 16]);
  // 层间转换过孔与缝合孔下发。
  assert.equal(commands.filter((command) => command.id === 'pcb.via.create').length, 6);
  // 受控执行没有被削弱：官方 DRC 必须是最后执行的一条命令，且严格晚于所有写入 ——
  // 否则可以先跑一次“干净”的 DRC 拿到放行、再继续改板。
  const ids = commands.map((command) => command.id);
  // 第 16 轮起，"发布级官方 DRC"之外还会先跑一次**改前基线 DRC**（用来判定本次改动有没有让板子变差）。
  // 这里要守住的不变量没有变：**发布级那一份** DRC 必须唯一、且晚于全部改板写入、之后不得再有写入。
  // 用 lastIndexOf 取发布级 DRC，并显式核对"写入之后只有一次 DRC"。
  const drcIndex = ids.lastIndexOf('pcb.drc.job.start');
  assert.ok(drcIndex > 0, '必须执行官方 DRC');
  const lastGeometryIndex = Math.max(...['pcb.line.create', 'pcb.pour.create', 'pcb.via.create', 'pcb.component.modify', 'pcb.importChanges'].map((id) => ids.lastIndexOf(id)));
  assert.equal(ids.slice(lastGeometryIndex + 1).filter((id) => id === 'pcb.drc.job.start').length, 1, '改板写入之后只允许有一次发布级官方 DRC');
  assert.ok(ids.filter((id) => id === 'pcb.save').length >= 1, '每个阶段结束后都应保存');
  for (const mutation of ['pcb.line.create', 'pcb.pour.create', 'pcb.via.create', 'pcb.component.modify']) {
    assert.ok(ids.lastIndexOf(mutation) < drcIndex, `官方 DRC 必须晚于 ${mutation}`);
  }
  // DRC 之后不得再有任何改板写入。判据直接用桥的权限表，而不是手写正则 ——
  // 这样将来新增任何写命令，只要它出现在 DRC 之后，这条断言就会立刻失败。
  const geometryMutations = ['pcb.line.create', 'pcb.pour.create', 'pcb.via.create', 'pcb.component.modify', 'pcb.importChanges'];
  for (const id of ids.slice(drcIndex + 1)) {
    assert.ok(!geometryMutations.includes(id), `官方 DRC 之后出现了改板写入: ${id}`);
    const permission = COMMANDS[id]?.permission ?? 'read';
    if (['write', 'write-beta', 'export-beta'].includes(permission)) {
      // pcb.save 是管理器的每阶段持久化，写的是 DRC 刚校验过的同一份状态，允许。
      assert.equal(id, 'pcb.save', `官方 DRC 之后出现了写命令: ${id}`);
    }
  }
  // 管理器自身也会拒绝“早于最后一次写入的 DRC”（PCB_DRC_STALE）；这里确认它没有触发。
  assert.equal(result.state, 'completed');
  assert.ok(result.events.some((event) => event.stage === 'snapshot'), '分阶段快照必须仍然存在');
  assert.equal(typeof result.readback.sourceDigest, 'string');
  assert.ok(result.events.some((event) => event.stage === 'readback'));
});

test('用 EDA 实际发现的层列表核对：文档是两层板时四层计划必须在写入前被拒', async () => {
  const execPlan = normalizePcbPlan(compileSemanticPlan(fourLayerInput()).compiled);
  assert.equal(execPlan.ready, true);

  const run = async (layers) => {
    const commands = [];
    let source = '{"board":"before"}';
    const bridge = {
      selectedWindowId: 'W1',
      async execute(id, args = {}) {
        commands.push({ id, args });
        if (id === 'project.current') return { result: { uuid: 'P1' } };
        if (id === 'document.current') return { result: { uuid: 'D1', documentType: 3 } };
        if (id === 'pcb.layers.read') return { result: layers };
        if (/^pcb\.(nets|components|lines|vias|pours|regions|texts|outline)\.read$/.test(id)) return { result: [] };
        if (id === 'pcb.rules.read') return { result: {} };
        if (id === 'pcb.source.read') return { result: source };
        if (id === 'document.source.restore') { source = args.source; return { result: true }; }
        if (id === 'pcb.save') return { result: true };
        // DRC 走 EDA 渲染进程后台任务：start 只回 jobId，poll 回结果信封。
      // 改造前这里是单次阻塞调用，真实板子上永远装不进一次 HTTP 预算。
      if (id === 'pcb.drc.job.start') return { result: { jobId: args.jobId, accepted: true, state: 'running' } };
      if (id === 'pcb.job.poll') return { result: { jobId: args.jobId, state: 'done', result: { kind: 'array', count: 0, items: [], truncated: false } } };
        source = '{"board":"mutated"}';
        return { result: { primitiveId: `${id}-1` } };
      },
    };
    const manager = new PcbManager({ bridge, approvals: new ApprovalStore() });
    const context = await manager.context();
    const approval = manager.approve({ plan: execPlan.plan, targetFingerprint: context.targetFingerprint, windowId: context.windowId });
    return manager.execute({ plan: execPlan.plan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: context.windowId })
      .then((result) => ({ ok: true, result, commands }), (error) => ({ ok: false, error, commands }));
  };

  // 文档实际只有外层与板框层（两层板的层列表）→ 必须拒绝。
  const rejected = await run([{ id: 1, name: 'Top' }, { id: 2, name: 'Bottom' }, { id: 11, name: 'BoardOutline' }]);
  assert.equal(rejected.ok, false, '两层文档不应接受四层计划');
  assert.equal(rejected.error.code, 'PCB_LAYER_NOT_IN_DOCUMENT');
  assert.deepEqual(rejected.error.missingLayers, [15, 16]);
  const writes = rejected.commands.filter((command) => ['pcb.line.create', 'pcb.pour.create', 'pcb.via.create', 'pcb.component.modify'].includes(command.id));
  assert.equal(writes.length, 0, `拒绝必须发生在任何写入之前: ${JSON.stringify(writes)}`);

  // 文档确实有四层铜（含内层 15/16）→ 通过，并记录层核对证据供人工复核。
  const accepted = await run([{ id: 1, name: 'Top' }, { id: 11, name: 'BoardOutline' }, { id: 15, name: 'Inner1' }, { id: 16, name: 'Inner2' }, { id: 2, name: 'Bottom' }]);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error ?? {}));
  assert.deepEqual(accepted.result.layerCheck.documentCopperLayerIds, [1, 2, 15, 16]);
  assert.equal(accepted.result.layerCheck.documentCopperLayerCount, 4);
  assert.equal(accepted.result.layerCheck.declaredLayerCount, 4);
  assert.ok(accepted.result.layerCheck.requestedLayers.includes(15));
  // 丝印(3)/阻焊(5) 之类非铜层不得被算作铜层。
  const withDecoys = await run([{ id: 1 }, { id: 3 }, { id: 5 }, { id: 11 }, { id: 15 }, { id: 16 }, { id: 2 }]);
  assert.deepEqual(withDecoys.result.layerCheck.documentCopperLayerIds, [1, 2, 15, 16], '丝印/阻焊层不得混入铜层统计');
});
