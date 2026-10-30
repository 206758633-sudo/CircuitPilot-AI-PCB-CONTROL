import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApprovalStore } from '../design.mjs';
import { mmToMil } from '../engineering/eda-primitives.mjs';
import { normalizePcbPlan, PCB_PLAN_GEOMETRY_UNIT, PcbManager, toEdaOperationArgs } from '../pcb.mjs';

const close = (actual, expected, label) => {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: 实际 ${actual}，期望 ${expected}`);
};

test('PCB 计划几何单位契约：高层计划是 mm，EDA 原生是 mil', () => {
  assert.equal(PCB_PLAN_GEOMETRY_UNIT, 'mm');

  const componentInput = { type: 'pcb.component.modify', args: { primitiveId: 'U1', property: { x: 20, y: 15, rotation: 90, layer: 1 } } };
  const component = toEdaOperationArgs(componentInput);
  close(component.property.x, mmToMil(20), 'component.x');
  close(component.property.y, mmToMil(15), 'component.y');
  assert.equal(component.property.rotation, 90);
  assert.equal(component.property.layer, 1);

  const lineInput = { type: 'pcb.line.create', args: { net: 'VBUS', layer: 1, startX: 1, startY: 2, endX: 10, endY: 2, lineWidth: 0.2 } };
  const line = toEdaOperationArgs(lineInput);
  close(line.startX, mmToMil(1), 'line.startX');
  close(line.endX, mmToMil(10), 'line.endX');
  close(line.lineWidth, mmToMil(0.2), 'line.lineWidth');

  const via = toEdaOperationArgs({ type: 'pcb.via.create', args: { net: 'VBUS', x: 20, y: 15, holeDiameter: 0.3, diameter: 0.6, viaType: 'through' } });
  close(via.x, mmToMil(20), 'via.x');
  close(via.holeDiameter, mmToMil(0.3), 'via.holeDiameter');
  close(via.diameter, mmToMil(0.6), 'via.diameter');
  assert.equal(via.viaType, 'through');

  const pourInput = { type: 'pcb.pour.create', args: { net: 'GND', layer: 1, outline: [[0, 0], [10, 0], [10, 10], [0, 10]], lineWidth: 0.2 } };
  const pour = toEdaOperationArgs(pourInput);
  close(pour.outline[1][0], mmToMil(10), 'pour.outline[1].x');
  close(pour.outline[2][1], mmToMil(10), 'pour.outline[2].y');
  assert.equal(pour.lineWidth, 0.2, '覆铜边框线宽是 mm，不能跟着坐标转 mil');

  // 板框桥接层已接收 mm 并自行换算；重复转换会把它放大 25.4 倍。
  const outline = { type: 'pcb.outline.create', args: { layer: 11, originXMm: 0, originYMm: 0, widthMm: 45, heightMm: 30, lineWidth: 0.2 } };
  const outlineConverted = toEdaOperationArgs(outline);
  assert.equal(outlineConverted.widthMm, 45);
  assert.equal(outlineConverted.heightMm, 30);
  close(outlineConverted.lineWidth, mmToMil(0.2), 'outline.lineWidth');
  // 已经按原生 mil 构造的 complexPolygon 不重复换算。
  const nativePolygon = { type: 'pcb.pour.create', args: { net: 'GND', layer: 1, complexPolygon: { polygon: [0, 0, 'L', 393.7008, 0, 393.7008, -393.7008, 0, 0] } } };
  assert.deepEqual(toEdaOperationArgs(nativePolygon), nativePolygon.args);

  // 转换必须是纯函数：审批/账本绑定的计划值仍然是 mm。
  assert.equal(componentInput.args.property.x, 20);
  assert.equal(lineInput.args.startX, 1);
  assert.equal(pourInput.args.outline[1][0], 10);
});

function unitPlan() {
  return normalizePcbPlan({
    title: 'unit boundary board',
    board: { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 },
    constraints: {},
    operations: [
      { type: 'pcb.outline.create', stage: 'outline', args: { layer: 11, originXMm: 0, originYMm: 0, widthMm: 45, heightMm: 30 } },
      { type: 'pcb.component.modify', stage: 'placement', args: { primitiveId: 'U1', property: { x: 20, y: 15, rotation: 0, layer: 1 } } },
      { type: 'pcb.line.create', stage: 'routing', args: { net: 'VBUS', layer: 1, startX: 1, startY: 2, endX: 10, endY: 2, lineWidth: 0.2 } },
      { type: 'pcb.via.create', stage: 'routing', args: { net: 'VBUS', x: 20, y: 15, holeDiameter: 0.3, diameter: 0.6 } },
      { type: 'pcb.pour.create', stage: 'copper', args: { net: 'GND', layer: 1, outline: [[0, 0], [10, 0], [10, 10], [0, 10]], lineWidth: 0.2 } },
      { type: 'pcb.save', stage: 'save', args: {} },
      { type: 'pcb.drc', stage: 'validation', args: {} },
    ],
  });
}

test('执行器下发 EDA 前把计划 mm 转为 mil（不是 25.4 倍缩板）', async () => {
  const commands = [];
  let source = '{"board":"before"}';
  const bridge = {
    selectedWindowId: 'W-UNIT',
    async execute(id, args = {}) {
      commands.push({ id, args });
      if (id === 'project.current') return { result: { uuid: 'P-UNIT' } };
      if (id === 'document.current') return { result: { uuid: 'D-UNIT', documentType: 3 } };
      if (/^pcb\.(layers|nets|components|lines|vias|pours|regions|texts|outline)\.read$/.test(id)) return { result: [] };
      if (id === 'pcb.rules.read') return { result: {} };
      if (id === 'pcb.source.read') return { result: source };
      if (id === 'document.source.restore') { source = args.source; return { result: true }; }
      if (id === 'pcb.save') return { result: true };
      if (id === 'pcb.outline.create' || id === 'pcb.line.create' || id === 'pcb.via.create' || id === 'pcb.pour.create') {
        source = '{"board":"mutated"}';
        return { result: { primitiveId: `${id}-1` } };
      }
      if (id === 'pcb.drc.job.start') return { result: { jobId: args.jobId, accepted: true, state: 'running' } };
      if (id === 'pcb.job.poll') return { result: { jobId: args.jobId, state: 'done', result: { kind: 'array', count: 0, items: [], truncated: false } } };
      return { result: true };
    },
  };
  const planning = unitPlan();
  assert.equal(planning.ready, true, JSON.stringify(planning.missing));
  const manager = new PcbManager({ stateDir: mkdtempSync(join(tmpdir(), 'cp-pcb-units-')), bridge, approvals: new ApprovalStore() });
  const context = await manager.context();
  const approval = manager.approve({ plan: planning.plan, targetFingerprint: context.targetFingerprint, windowId: context.windowId });
  const result = await manager.execute({ plan: planning.plan, approvalToken: approval.token, targetFingerprint: context.targetFingerprint, windowId: context.windowId });
  assert.equal(result.state, 'completed', JSON.stringify(result.error ?? {}));

  const outline = commands.find((command) => command.id === 'pcb.outline.create');
  assert.equal(outline.args.widthMm, 45, '板框仍按 mm 交给桥，不能二次换算');
  assert.equal(outline.args.heightMm, 30);

  const component = commands.find((command) => command.id === 'pcb.component.modify');
  close(component.args.property.x, mmToMil(20), '下发 component.x');
  close(component.args.property.y, mmToMil(15), '下发 component.y');
  assert.equal(component.args.property.rotation, 0);

  const line = commands.find((command) => command.id === 'pcb.line.create');
  close(line.args.startX, mmToMil(1), '下发 line.startX');
  close(line.args.lineWidth, mmToMil(0.2), '下发 line.lineWidth');

  const via = commands.find((command) => command.id === 'pcb.via.create');
  close(via.args.x, mmToMil(20), '下发 via.x');
  close(via.args.holeDiameter, mmToMil(0.3), '下发 via.holeDiameter');

  const pour = commands.find((command) => command.id === 'pcb.pour.create');
  close(pour.args.outline[1][0], mmToMil(10), '下发 pour.outline[1].x');
  assert.equal(pour.args.lineWidth, 0.2, '覆铜边框线宽保持 mm');
});
