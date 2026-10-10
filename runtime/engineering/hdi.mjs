import { finding } from './stackup.mjs';

/** 板层数硬上限：既覆盖现实中的最高层数，又避免 nodes 数组被客户端撑爆。 */
const MAX_LAYERS = 64;

export function validateViaCapabilities(input = {}) {
  const findings = []; const types = Array.isArray(input.viaTypes) ? input.viaTypes : [];
  const steps = Array.isArray(input.laminationSteps) ? input.laminationSteps : [];
  if (types.some((v) => ['blind','buried','microvia'].includes(v.type)) && (!steps.length || !input.fabricatorEvidence)) findings.push(finding('SEQUENTIAL_LAMINATION_EVIDENCE_REQUIRED', '盲埋孔或微孔必须绑定板厂顺序压合能力与步骤', 'laminationSteps'));
  for (const [i,v] of types.entries()) {
    if (!['through','blind','buried','microvia'].includes(v.type)) findings.push(finding('VIA_TYPE_INVALID', '过孔类型无效', `viaTypes.${i}`));
    if (!(Number(v.drillMm) > 0) || !(Number(v.diameterMm) > Number(v.drillMm))) findings.push(finding('VIA_GEOMETRY_INVALID', '孔径与焊盘直径无效', `viaTypes.${i}`));
    if (v.type === 'microvia' && Math.abs(Number(v.toLayer) - Number(v.fromLayer)) !== 1) findings.push(finding('MICROVIA_SPAN_INVALID', '微孔只能连接相邻铜层', `viaTypes.${i}`));
  }
  for (const [i,step] of steps.entries()) if (!Array.isArray(step.layers) || step.layers.length < 2 || !step.id) findings.push(finding('LAMINATION_STEP_INVALID', '顺序压合步骤必须包含ID和至少两个层号', `laminationSteps.${i}`));
  return { ready: findings.length === 0 && types.length > 0, findings, viaTypes: types, laminationSteps: steps, fabricatorEvidence: input.fabricatorEvidence || null };
}

export function planLayerTransition({ fromLayer, toLayer, layerCount, viaTypes = [], maxStackedMicrovias = 1 }) {
  const findings = [];
  const count = Number(layerCount); const from = Number(fromLayer); const to = Number(toLayer);
  const inRange = (layer) => Number.isInteger(layer) && layer >= 1 && layer <= count;
  // layerCount 直接决定 nodes 数组长度；这里必须先夹紧，否则 1e9 会直接 OOM 崩溃。
  if (!Number.isInteger(count) || count < 1 || count > MAX_LAYERS) return { passed: false, findings: [finding('LAYER_COUNT_INVALID', `层数必须是1到${MAX_LAYERS}之间的整数`, 'layerCount')], transitions: [], cost: null, stitchingViaRequired: false, stitchingPlan: [] };
  if (!inRange(from) || !inRange(to)) return { passed: false, findings: [finding('LAYER_ENDPOINT_INVALID', `起点层与终点层必须是1到${count}之间的整数`, 'fromLayer')], transitions: [], cost: null, stitchingViaRequired: false, stitchingPlan: [] };
  const requestedStack = Number(maxStackedMicrovias); const stackLimit = Number.isInteger(requestedStack) && requestedStack >= 0 ? requestedStack : 1;
  const nodes = Array.from({ length: count }, (_,i) => i + 1); const edges = [];
  for (const via of viaTypes) {
    const viaFrom = Number(via.fromLayer); const viaTo = Number(via.toLayer);
    const cost = Number(via.cost ?? (via.type === 'through' ? 5 : via.type === 'microvia' ? 2 : 3));
    // 负代价会让 Dijkstra 的 prev 指针成环，第 22 行的重建循环将永不终止。
    if (!Number.isFinite(cost) || cost < 0 || !inRange(viaFrom) || !inRange(viaTo)) { findings.push(finding('VIA_COST_INVALID', '过孔代价必须是非负有限数字，且层号必须落在板层范围内', 'viaTypes')); continue; }
    edges.push({ from: viaFrom, to: viaTo, via, cost });
  }
  const dist = new Map(nodes.map((n) => [n, Infinity])); const prev = new Map(); dist.set(from,0); const open = new Set(nodes);
  while (open.size) { const current = [...open].sort((a,b) => dist.get(a) - dist.get(b))[0]; open.delete(current); if (current === to || !Number.isFinite(dist.get(current))) break; for (const edge of edges.filter((e) => e.from === current || e.to === current)) { const next = edge.from === current ? edge.to : edge.from; const nextCost = dist.get(current) + edge.cost; if (nextCost < dist.get(next)) { dist.set(next,nextCost); prev.set(next,{ node: current, via: edge.via }); } } }
  if (!prev.has(to) && from !== to) findings.push(finding('LAYER_TRANSITION_UNREACHABLE', `无法从L${from}到L${to}`, 'viaTypes'));
  const transitions = []; let cursor = to; while (prev.has(cursor)) { const step = prev.get(cursor); transitions.unshift({ fromLayer: step.node, toLayer: cursor, via: step.via }); cursor = step.node; }
  let stack = 0; for (const step of transitions) { stack = step.via.type === 'microvia' ? stack + 1 : 0; if (stack > stackLimit) findings.push(finding('MICROVIA_STACK_LIMIT', '连续叠孔超过板厂能力', 'transitions')); }
  return { passed: findings.length === 0, findings, transitions, cost: dist.get(to), stitchingViaRequired: from !== to, stitchingPlan: from === to ? [] : [{ purpose:'return-path-continuity', nearTransition:true, maxDistanceMm:2 }] };
}

export function planBgaEscape({ rows, columns, pitchMm, padDiameterMm, minClearanceMm, availableLayers }) {
  const findings = [];
  if (![rows,columns,pitchMm,padDiameterMm,minClearanceMm,availableLayers].every((v) => Number(v) > 0)) findings.push(finding('BGA_INPUT_INVALID', 'BGA扇出参数不完整', 'bga'));
  const channelMm = pitchMm - padDiameterMm;
  if (channelMm < minClearanceMm * 2) findings.push(finding('BGA_CHANNEL_TOO_NARROW', '焊盘间通道不足，需微孔或更高层数', 'bga'));
  const requiredSignalLayers = Math.ceil(Math.min(rows,columns) / 2);
  if (requiredSignalLayers > availableLayers) findings.push(finding('BGA_LAYER_CAPACITY', `预计需要${requiredSignalLayers}个信号层`, 'bga.availableLayers'));
  return { passed: findings.length === 0, findings, channelMm, requiredSignalLayers, strategy: channelMm >= minClearanceMm * 2 ? 'dogbone-or-channel' : 'via-in-pad-microvia' };
}
