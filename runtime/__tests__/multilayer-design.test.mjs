import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS } from '../bridge.mjs';
import { ApprovalStore } from '../design.mjs';
import { mmToMil } from '../engineering/eda-primitives.mjs';
import { solveDifferentialWidth, solveMicrostripWidth } from '../engineering/impedance.mjs';
import { differentialFromSingleEnded } from '../engineering/stackup.mjs';
import { normalizePcbPlan, PcbManager } from '../pcb.mjs';
import { compileSemanticPlan } from '../production.mjs';

/**
 * 真实验证目标：一块四层高速数字板走通全流程。
 * USB（90Ω 差分，外层微带）+ SPI 时钟（内层走线）+ 内层地/电源平面 + 层间转换过孔。
 * 线宽不是拍脑袋填的，而是由阻抗反解算出来的，再写进计划、真正下发给 EDA。
 */
const stackup = {
  id: 'local-4l-1.6', source: '本地记录的板厂四层叠层：0.2mm prepreg / 1.0mm core, er 4.3',
  layers: [
    { name: 'L1', type: 'copper', thicknessUm: 35, role: 'signal' },
    { name: 'pp1', type: 'dielectric', thicknessMm: 0.2, er: 4.3 },
    { name: 'L2', type: 'copper', thicknessUm: 35, role: 'ground' },
    { name: 'core', type: 'dielectric', thicknessMm: 1.0, er: 4.3 },
    { name: 'L3', type: 'copper', thicknessUm: 35, role: 'power' },
    { name: 'pp2', type: 'dielectric', thicknessMm: 0.2, er: 4.3 },
    { name: 'L4', type: 'copper', thicknessUm: 35, role: 'signal' },
  ],
};
const USB_TARGET_OHM = 90;
const USB_PAIR_GAP_MM = 0.15;
/** 外层微带几何：L1 铜厚 35µm、下方 prepreg 0.2mm、er 4.3。 */
const usbGeometry = { copperThicknessMm: 0.035, heightMm: 0.2, er: 4.3 };

function highSpeedBoardInput(overrides = {}) {
  return {
    projectId: 'multilayer-hs', title: '四层高速数字板（USB + SPI）',
    board: { widthMm: 60, heightMm: 40, layers: 4, thicknessMm: 1.6, copperOz: 1, mountingHoles: 4 },
    components: [
      { ref: 'J1', primitiveId: 'c-j1', footprint: 'USB-C-16P', lcscId: 'C165948', side: 'top', placement: { xMm: 4, yMm: 20, rotation: 0 }, sizeMm: { width: 2, height: 8 } },
      { ref: 'U1', primitiveId: 'c-u1', footprint: 'TSSOP-20', lcscId: 'C720477', side: 'top', placement: { xMm: 30, yMm: 20, rotation: 0 }, sizeMm: { width: 7, height: 7 } },
      { ref: 'Y1', primitiveId: 'c-y1', footprint: 'SMD-3225', side: 'top', placement: { xMm: 50, yMm: 30, rotation: 0 }, sizeMm: { width: 3.2, height: 2.5 } },
    ],
    nets: [
      { name: 'VBUS', class: 'power', endpoints: [{ ref: 'J1', pin: 'A4', xMm: 5, yMm: 20 }, { ref: 'U1', pin: 'VDD', xMm: 27, yMm: 20 }] },
      // 差分对的线宽来自阻抗反解，而不是填一个差不多的数。
      { name: 'USB_DP', class: 'signal', widthMm: null, differentialPair: { mate: 'USB_DM', impedanceOhm: USB_TARGET_OHM, toleranceOhm: 10, lengthToleranceMm: 0.5 }, endpoints: [{ ref: 'J1', pin: 'A6', xMm: 5, yMm: 18 }, { ref: 'U1', pin: 'D1', xMm: 27, yMm: 18 }] },
      { name: 'USB_DM', class: 'signal', widthMm: null, differentialPair: { mate: 'USB_DP', impedanceOhm: USB_TARGET_OHM, toleranceOhm: 10, lengthToleranceMm: 0.5 }, endpoints: [{ ref: 'J1', pin: 'A7', xMm: 5, yMm: 22 }, { ref: 'U1', pin: 'D2', xMm: 27, yMm: 22 }] },
      // SPI 时钟明确走内层 L2，验证内层走线与层间转换。
      { name: 'SPI_CLK', class: 'signal', layer: 'L2', endpoints: [{ ref: 'U1', pin: 'SCLK', xMm: 30, yMm: 24 }, { ref: 'Y1', pin: '1', xMm: 49, yMm: 30 }] },
    ],
    silkscreen: [], decisions: [],
    evidence: [{ kind: 'stackup', id: 'stack-4l' }, { kind: 'schematic', id: 'sch-1' }],
    constraints: {
      profileId: 'jlc-4l', minClearanceMm: 0.2, minCopperToEdgeMm: 0.3,
      impedance: { stackupSource: stackup.source }, stackup,
    },
    ...overrides,
  };
}

/** 用反解算出 90Ω 差分对所需线宽，然后写回计划。 */
function withSolvedUsbWidth(input) {
  const solved = solveDifferentialWidth({ targetDifferentialOhm: USB_TARGET_OHM, pairGapMm: USB_PAIR_GAP_MM, ...usbGeometry });
  assert.equal(solved.achievable, true, `90Ω 应可解: ${JSON.stringify(solved)}`);
  for (const net of input.nets) if (net.differentialPair) net.widthMm = Number(solved.widthMm.toFixed(3));
  return { input, solved };
}

test('阻抗反解驱动真实设计：90Ω 差分对线宽经正向模型回算命中目标', () => {
  const solved = solveDifferentialWidth({ targetDifferentialOhm: USB_TARGET_OHM, pairGapMm: USB_PAIR_GAP_MM, ...usbGeometry });
  assert.equal(solved.achievable, true);
  const forward = differentialFromSingleEnded({ singleEndedOhm: solved.singleEndedOhm, pairGapMm: USB_PAIR_GAP_MM, heightMm: usbGeometry.heightMm }).differentialOhm;
  assert.ok(Math.abs(forward - USB_TARGET_OHM) <= 1, `回算 ${forward.toFixed(3)}Ω 偏离目标`);
  // 该线宽还必须满足板厂档位的最小线宽，否则设计不可制造。
  assert.ok(solved.widthMm >= 0.2, `反解线宽 ${solved.widthMm} 低于档位最小线宽 0.2mm`);
});

test('四层高速板走通全流程：编译 -> 执行计划 -> 落板，线宽/层号/平面/过孔全部正确', async () => {
  const { input, solved } = withSolvedUsbWidth(highSpeedBoardInput());
  const compiled = compileSemanticPlan(input);
  assert.equal(compiled.ready, true, JSON.stringify(compiled.issues));
  assert.equal(compiled.quality.passed, true, `编译期质量检查不应有问题: ${JSON.stringify(compiled.quality.findings)}`);

  // 1) 差分对走线使用反解出来的线宽，而不是默认值 —— 这是反解真正影响执行的证据。
  const diffRoutes = compiled.compiled.operations.filter((operation) => operation.type === 'pcb.line.create' && ['USB_DP', 'USB_DM'].includes(operation.args.net));
  assert.ok(diffRoutes.length > 0);
  const expectedWidth = Number(solved.widthMm.toFixed(3));
  assert.ok(diffRoutes.every((operation) => operation.args.lineWidth === expectedWidth), `差分对线宽应等于反解值 ${expectedWidth}: ${JSON.stringify([...new Set(diffRoutes.map((o) => o.args.lineWidth))])}`);

  // 2) 层号正确：差分对在外层 1，SPI 时钟在内层 15（L2），绝不出现丝印层 3。
  const layersOf = (net) => [...new Set(compiled.compiled.operations.filter((operation) => operation.type === 'pcb.line.create' && operation.args.net === net).map((operation) => operation.args.layer))];
  assert.deepEqual(layersOf('USB_DP'), [1]);
  assert.deepEqual(layersOf('USB_DM'), [1]);
  assert.deepEqual(layersOf('SPI_CLK'), [15], 'SPI_CLK 应布在 L2 对应的 15 层');
  assert.ok(!JSON.stringify(compiled.compiled.operations).match(/"layer":3[^0-9]/), '不得出现丝印层 3');

  // 3) 平面：顶层地 + L2 地平面 + L3 电源平面(叠层已显式声明 role)。
  const pours = compiled.compiled.operations.filter((operation) => operation.type === 'pcb.pour.create').map((operation) => `${operation.args.net}@${operation.args.layer}`);
  assert.deepEqual(pours, ['GND@1', 'GND@15', 'VBUS@16']);
  assert.deepEqual(compiled.quality.metrics.usedLayers, [1, 15, 16]);

  // 4) 执行阶段必须接受同一份计划（语义阶段与执行阶段共用叠层证据模型）。
  const execPlan = normalizePcbPlan(compiled.compiled);
  assert.equal(execPlan.ready, true, `执行计划应可用: ${JSON.stringify(execPlan.missing)}`);

  // 5) 真正下发到 EDA：假 bridge 忠实记录每条命令。
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
  assert.equal(result.drc.passed, true, '官方 DRC 必须无报错才放行');

  const lineCommands = commands.filter((command) => command.id === 'pcb.line.create');
  assert.ok(lineCommands.some((command) => command.args.layer === 15 && command.args.net === 'SPI_CLK'), '内层走线必须真正下发');
  assert.ok(lineCommands.filter((command) => command.args.net === 'USB_DP').every((command) => command.args.lineWidth === Number(mmToMil(expectedWidth).toFixed(6))), '下发的差分线宽必须等于反解值换算成 EDA 原生 mil');
  const viaCount = commands.filter((command) => command.id === 'pcb.via.create').length;
  // SPI_CLK 两个顶层焊盘转到内层 L2 = 2 个过渡孔；四角地缝合 = 4 个。
  assert.equal(viaCount, 6, `过孔数量应为 6（2 个层间转换 + 4 个缝合）: ${JSON.stringify(commands.filter((c) => c.id === 'pcb.via.create').map((c) => c.args))}`);

  // 6) 受控执行未被削弱：官方 DRC 晚于所有改板写入，之后不得再有任何改板命令。
  const ids = commands.map((command) => command.id);
  // 第 16 轮起，"发布级官方 DRC"之外还会先跑一次**改前基线 DRC**（用来判定本次改动有没有让板子变差）。
  // 这里要守住的不变量没有变：**发布级那一份** DRC 必须唯一、且晚于全部改板写入、之后不得再有写入。
  // 用 lastIndexOf 取发布级 DRC，并显式核对"写入之后只有一次 DRC"。
  const drcIndex = ids.lastIndexOf('pcb.drc.job.start');
  assert.ok(drcIndex > 0);
  const lastGeometryIndex = Math.max(...['pcb.line.create', 'pcb.pour.create', 'pcb.via.create', 'pcb.component.modify', 'pcb.importChanges'].map((id) => ids.lastIndexOf(id)));
  assert.equal(ids.slice(lastGeometryIndex + 1).filter((id) => id === 'pcb.drc.job.start').length, 1, '改板写入之后只允许有一次发布级官方 DRC');
  for (const mutation of ['pcb.line.create', 'pcb.pour.create', 'pcb.via.create', 'pcb.component.modify']) {
    assert.ok(ids.lastIndexOf(mutation) < drcIndex, `官方 DRC 必须晚于 ${mutation}`);
  }
  for (const id of ids.slice(drcIndex + 1)) {
    assert.ok(!['pcb.line.create', 'pcb.pour.create', 'pcb.via.create', 'pcb.component.modify'].includes(id), `DRC 之后出现了改板写入: ${id}`);
    const permission = COMMANDS[id]?.permission ?? 'read';
    if (['write', 'write-beta', 'export-beta'].includes(permission)) assert.equal(id, 'pcb.save', `DRC 之后出现了写命令: ${id}`);
  }
  assert.ok(result.events.some((event) => event.stage === 'snapshot'), '分阶段快照仍然存在');
});

test('设计不可制造时必须阻断：反解线宽低于档位下限不能进入执行', () => {
  const { input } = withSolvedUsbWidth(highSpeedBoardInput());
  // 人为把线宽压到档位最小线宽以下（模拟“为了打到目标阻抗而用了板厂做不出的细线”）。
  for (const net of input.nets) if (net.differentialPair) net.widthMm = 0.1;
  const compiled = compileSemanticPlan(input);
  assert.equal(compiled.ready, false);
  assert.ok(compiled.blocking.some((item) => item.code === 'TRACK_WIDTH_BELOW_PROFILE'), JSON.stringify(compiled.blocking.map((i) => i.code)));
  assert.equal(compiled.compiled, null, '不可制造的设计不得产出执行计划');

  // 对照：同样的目标在合理叠层下能解出满足工艺的线宽 —— 证明上面确实是被工艺下限拦下的。
  const thicker = solveMicrostripWidth({ targetOhm: 50, copperThicknessMm: 0.035, heightMm: 0.2, er: 4.3 });
  assert.equal(thicker.achievable, true);
  assert.ok(thicker.widthMm >= 0.2);
});

test('同一块板两次编译结果完全一致（可复现的批准对象）', () => {
  const first = compileSemanticPlan(withSolvedUsbWidth(highSpeedBoardInput()).input);
  const second = compileSemanticPlan(withSolvedUsbWidth(highSpeedBoardInput()).input);
  assert.equal(first.compiledPlanHash, second.compiledPlanHash);
  assert.equal(first.quality.metrics.viaCount, second.quality.metrics.viaCount);
});
