import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { digest } from './design.mjs';
import { countCopperLayers, isCopperLayerId, planCopperRoles, resolveLayerReference } from './engineering/layers.mjs';
import { validateStackup } from './engineering/stackup.mjs';

export const PRODUCTION_SCHEMA_VERSION = 1;

/** 包围盒两两比较是 O(n²)，这里给器件数量设上限，避免语义计划把校验拖成 CPU 炸弹。 */
const MAX_COMPONENTS = 1_000;
/** 已登记的语义/编译计划数量上限，防止长期运行的Runtime无界增长。 */
const MAX_STORED_PLANS = 200;

/**
 * 与层数无关的保守工艺下界。
 *
 * 来源：项目原有的本地保守配置。**这不是**对嘉立创当前能力的声明：
 * 我们无法在离线环境核实板厂的多层工艺表（嘉立创EDA 内置的
 * 'JLCPCB Capability(...)' 规则配置由云端下发，应用包内没有明文），
 * 所以刻意只沿用这套“比板厂能力更严”的值 —— 保守值只会让设计更容易制造，
 * 不会放宽约束。投产前必须用 pcb.rules.read 读到的规则配置或在线 DFM 复核。
 */
const CONSERVATIVE_LIMITS = Object.freeze({
  minTrackMm: 0.2, minClearanceMm: 0.2,
  minViaDiameterMm: 0.6, minViaDrillMm: 0.3, minCopperToEdgeMm: 0.3,
  minSilkHeightMm: 1, minSilkStrokeMm: 0.15, thermalReliefSpokes: 4,
});

const SINGLE_LAYER_NOTE = '这是本地保守规则配置，不替代嘉立创当前工艺能力或在线DFM。';
const MULTI_LAYER_NOTE = '四层以上档位的工艺下界沿用本地保守值（比板厂能力更严，不会更松），不构成对嘉立创多层板实际能力的声明；投产前必须以 pcb.rules.read 读到的规则配置或在线 DFM 复核，并提供叠层证据。';

export const RULE_PROFILES = Object.freeze({
  'jlc-low-cost-2l': Object.freeze({
    id: 'jlc-low-cost-2l', label: '嘉立创低成本双层板（保守规则）', layers: 2,
    thicknessMm: 1.6, copperOz: 1, ...CONSERVATIVE_LIMITS,
    stackupRequired: false, impedanceControlled: false, requiresFabricatorEvidence: false,
    note: SINGLE_LAYER_NOTE,
  }),
  'jlc-4l': Object.freeze({
    id: 'jlc-4l', label: '嘉立创四层板（保守规则）', layers: 4,
    thicknessMm: 1.6, copperOz: 1, ...CONSERVATIVE_LIMITS,
    stackupRequired: true, impedanceControlled: true, requiresFabricatorEvidence: true,
    note: MULTI_LAYER_NOTE,
  }),
  'jlc-6l': Object.freeze({
    id: 'jlc-6l', label: '嘉立创六层板（保守规则）', layers: 6,
    thicknessMm: 1.6, copperOz: 1, ...CONSERVATIVE_LIMITS,
    stackupRequired: true, impedanceControlled: true, requiresFabricatorEvidence: true,
    note: MULTI_LAYER_NOTE,
  }),
  'jlc-8l': Object.freeze({
    id: 'jlc-8l', label: '嘉立创八层板（保守规则）', layers: 8,
    thicknessMm: 1.6, copperOz: 1, ...CONSERVATIVE_LIMITS,
    stackupRequired: true, impedanceControlled: true, requiresFabricatorEvidence: true,
    note: MULTI_LAYER_NOTE,
  }),
});

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const positive = (value) => finite(value) && value > 0;
const text = (value) => typeof value === 'string' ? value.trim() : '';
const array = (value) => Array.isArray(value) ? value : [];
const issue = (code, message, path, severity = 'blocking') => ({ code, message, path, severity });

/**
 * 多层计划的叠层证据校验。
 *
 * 刻意要求**叠层数据**（constraints.stackup）而不是只给一个来源字符串：
 * 执行阶段（pcb.mjs）会用同一套 validateStackup 再校验一次，只有字符串时
 * 编译结果根本进不了执行 —— 语义阶段放行、执行阶段必拒，等于骗用户。
 * 两个阶段共用同一个证据模型，才不会出现“到执行时才发现缺数据”。
 */
function multilayerStackupIssue(plan) {
  const stackup = plan.constraints?.stackup;
  const layerCount = plan.board?.layers;
  if (!stackup) return issue('MULTILAYER_STACKUP_EVIDENCE_REQUIRED', `${layerCount}层计划必须提供叠层数据（constraints.stackup：铜层厚度、介质厚度与介电常数、板厂来源）`, 'constraints.stackup');
  const check = validateStackup(stackup);
  if (!check.ready) return issue('MULTILAYER_STACKUP_EVIDENCE_REQUIRED', `叠层证据不足: ${[...new Set(check.findings.map((item) => item.code))].join('|')}`, 'constraints.stackup');
  const copperCount = countCopperLayers(stackup);
  if (copperCount !== layerCount) return issue('STACKUP_LAYER_COUNT_MISMATCH', `叠层铜层数${copperCount}与board.layers声明的${layerCount}不一致`, 'constraints.stackup');
  return null;
}

function normalizePoint(input = {}) {
  return { xMm: Number(input.xMm), yMm: Number(input.yMm) };
}

export function normalizeSemanticPlan(input = {}) {
  const boardInput = input.board || {};
  const board = {
    widthMm: Number(boardInput.widthMm), heightMm: Number(boardInput.heightMm),
    layers: Number(boardInput.layers), thicknessMm: Number(boardInput.thicknessMm),
    copperOz: Number(boardInput.copperOz), mountingHoles: Number(boardInput.mountingHoles ?? 0),
  };
  const components = array(input.components).map((item) => ({
    ref: text(item.ref), primitiveId: text(item.primitiveId), role: text(item.role) || 'general',
    footprint: text(item.footprint), lcscId: text(item.lcscId), side: item.side === 'bottom' ? 'bottom' : 'top',
    placement: item.placement ? { ...normalizePoint(item.placement), rotation: Number(item.placement.rotation ?? 0), locked: Boolean(item.placement.locked) } : null,
    sizeMm: item.sizeMm ? { width: Number(item.sizeMm.width), height: Number(item.sizeMm.height) } : null,
  }));
  const nets = array(input.nets).map((item) => ({
    name: text(item.name), class: text(item.class) || 'signal',
    endpoints: array(item.endpoints).map((endpoint) => ({ ref: text(endpoint.ref), pin: text(endpoint.pin), ...normalizePoint(endpoint) })),
    differentialPair: item.differentialPair ? { mate: text(item.differentialPair.mate), impedanceOhm: Number(item.differentialPair.impedanceOhm), toleranceOhm: Number(item.differentialPair.toleranceOhm), lengthToleranceMm: Number(item.differentialPair.lengthToleranceMm) } : null,
    // 目标布线层：保留原始声明（可能是 'L2'/15/1），解析结果在 layerId。
    // 解析失败时 layerId 为 null，由 validateSemanticPlan 报错，绝不猜测层号。
    layer: item.layer === undefined || item.layer === null ? null : item.layer,
    layerId: item.layer === undefined || item.layer === null ? null : resolveLayerReference(item.layer, Number(boardInput.layers)),
  }));
  // 先解析档位再取默认值：改造前无论选了哪个档位，minClearance/minCopperToEdge 的
  // 默认值都硬取自双层档位，导致指定四层档位时静默套用了双层的数值。
  const requestedProfileId = text(input.constraints?.profileId) || 'jlc-low-cost-2l';
  const baseProfile = RULE_PROFILES[requestedProfileId] || RULE_PROFILES['jlc-low-cost-2l'];
  const constraints = {
    profileId: requestedProfileId,
    minClearanceMm: Number(input.constraints?.minClearanceMm ?? baseProfile.minClearanceMm),
    minCopperToEdgeMm: Number(input.constraints?.minCopperToEdgeMm ?? baseProfile.minCopperToEdgeMm),
    safety: input.constraints?.safety || null,
    thermal: input.constraints?.thermal || null,
    impedance: input.constraints?.impedance || null,
    // 叠层声明（可选）：用于推导每层角色（信号/地平面/电源平面）。进入 constraints 即进入计划哈希。
    stackup: input.constraints?.stackup ? { ...input.constraints.stackup, layers: array(input.constraints.stackup.layers) } : null,
    // 显式平面铺铜：多层板不指定时按叠层角色自动推导（内层地/电源平面）。
    planes: array(input.constraints?.planes).map((plane) => ({
      net: text(plane.net), layer: plane.layer, layerId: resolveLayerReference(plane.layer, board.layers),
    })),
    // 地平面缝合孔默认开启（多层板有地平面时）；显式传 false 可关闭。
    groundStitching: input.constraints?.groundStitching !== false,
    keepouts: array(input.constraints?.keepouts).map((zone) => ({ xMm: Number(zone.xMm), yMm: Number(zone.yMm), widthMm: Number(zone.widthMm), heightMm: Number(zone.heightMm), layers: array(zone.layers) })),
  };
  const plan = { schemaVersion: PRODUCTION_SCHEMA_VERSION, kind: 'pcba-semantic-plan', projectId: text(input.projectId), title: text(input.title) || 'PCBA production plan', board, constraints, components, nets, silkscreen: array(input.silkscreen), evidence: array(input.evidence), decisions: array(input.decisions), createdBy: 'codex-structured-output' };
  const issues = validateSemanticPlan(plan);
  return { plan, issues, blocking: issues.filter((item) => item.severity === 'blocking'), ready: issues.every((item) => item.severity !== 'blocking'), planHash: digest(plan) };
}

export function validateSemanticPlan(plan) {
  const issues = [];
  const board = plan.board || {};
  if (!positive(board.widthMm) || !positive(board.heightMm)) issues.push(issue('BOARD_DIMENSIONS_REQUIRED', '必须提供有限且大于零的板框尺寸', 'board'));
  if (![2,4,6,8].includes(board.layers)) issues.push(issue('BOARD_LAYER_UNSUPPORTED', '层数必须为已支持的2/4/6/8层', 'board.layers'));
  if (!positive(board.thicknessMm) || !positive(board.copperOz)) issues.push(issue('STACKUP_REQUIRED', '必须确认板厚和铜厚', 'board'));
  const profile = RULE_PROFILES[plan.constraints?.profileId];
  if (!profile) issues.push(issue('RULE_PROFILE_UNKNOWN', '制造规则配置不存在', 'constraints.profileId'));
  // 档位与层数必须匹配：改造前只检查档位存在，四层板套用双层档位也能通过校验。
  else if (profile.layers !== board.layers) issues.push(issue('RULE_PROFILE_LAYER_MISMATCH', `规则档位 ${profile.id} 适用于 ${profile.layers} 层，但计划声明 ${board.layers} 层`, 'constraints.profileId'));
  // 多层板必须绑定叠层证据：没有叠层就无从判定内层角色、参考平面与阻抗。
  else if (profile.stackupRequired) { const stackupIssue = multilayerStackupIssue(plan); if (stackupIssue) issues.push(stackupIssue); }
  if (!plan.evidence?.length) issues.push(issue('EVIDENCE_REQUIRED', '必须绑定至少一项工程或器件证据', 'evidence'));
  if (array(plan.components).length > MAX_COMPONENTS) issues.push(issue('COMPONENT_LIMIT_EXCEEDED', `器件数量超过上限${MAX_COMPONENTS}`, 'components'));
  const refs = new Set();
  for (const [index, component] of array(plan.components).entries()) {
    if (!component.ref || refs.has(component.ref)) issues.push(issue('COMPONENT_REF_INVALID', '位号缺失或重复', `components.${index}.ref`));
    refs.add(component.ref);
    if (!component.primitiveId || !component.footprint) issues.push(issue('COMPONENT_IDENTITY_REQUIRED', `${component.ref || index} 缺少EDA对象或封装身份`, `components.${index}`));
    if (!component.placement || !finite(component.placement.xMm) || !finite(component.placement.yMm)) issues.push(issue('PLACEMENT_REQUIRED', `${component.ref || index} 缺少确定坐标`, `components.${index}.placement`));
    if (component.placement && (component.placement.xMm < 0 || component.placement.yMm < 0 || component.placement.xMm > board.widthMm || component.placement.yMm > board.heightMm)) issues.push(issue('PLACEMENT_OUTSIDE_BOARD', `${component.ref || index} 坐标位于板框外`, `components.${index}.placement`));
  }
  for (const [index, net] of array(plan.nets).entries()) {
    if (!net.name || net.endpoints.length < 2) issues.push(issue('NET_ENDPOINTS_REQUIRED', `网络${net.name || index}至少需要两个端点`, `nets.${index}`));
    if (net.differentialPair && (!positive(net.differentialPair.impedanceOhm) || !text(net.differentialPair.mate))) issues.push(issue('DIFF_PAIR_INCOMPLETE', `差分网络${net.name}缺少配对或阻抗`, `nets.${index}.differentialPair`));
    // 声明了布线层但解析不出铜层编号：宁可阻断，也不能退回默认层悄悄画错层。
    if (net.layer !== null && net.layer !== undefined && net.layerId === null) issues.push(issue('NET_LAYER_INVALID', `网络${net.name}声明的布线层${JSON.stringify(net.layer)}不是${board.layers}层板的铜层`, `nets.${index}.layer`));
  }
  for (const [index, plane] of array(plan.constraints?.planes).entries()) {
    if (!plane.net) issues.push(issue('PLANE_NET_REQUIRED', '平面铺铜必须指定网络', `constraints.planes.${index}.net`));
    if (plane.layerId === null) issues.push(issue('PLANE_LAYER_INVALID', `平面层${JSON.stringify(plane.layer)}不是${board.layers}层板的铜层`, `constraints.planes.${index}.layer`));
  }
  const voltage = Number(plan.constraints?.safety?.workingVoltageV);
  if (finite(voltage) && voltage >= 60 && (!positive(Number(plan.constraints.safety.clearanceMm)) || !positive(Number(plan.constraints.safety.creepageMm)))) issues.push(issue('SAFETY_CLEARANCE_REQUIRED', '高于或等于60V时必须由工程师确认电气间隙和爬电距离', 'constraints.safety'));
  const thermal = plan.constraints?.thermal;
  if (thermal && (!positive(Number(thermal.maxAmbientC)) || !positive(Number(thermal.maxJunctionC)) || !positive(Number(thermal.powerW)))) issues.push(issue('THERMAL_INPUT_INCOMPLETE', '热设计需要环境温度、结温上限和功耗', 'constraints.thermal'));
  return issues;
}

function placementBox(component) {
  const width = positive(component.sizeMm?.width) ? component.sizeMm.width : 1;
  const height = positive(component.sizeMm?.height) ? component.sizeMm.height : 1;
  return { left: component.placement.xMm - width / 2, right: component.placement.xMm + width / 2, top: component.placement.yMm - height / 2, bottom: component.placement.yMm + height / 2 };
}

export function compileSemanticPlan(input = {}) {
  const normalized = normalizeSemanticPlan(input);
  if (!normalized.ready) return { ...normalized, compiled: null };
  const profile = { ...RULE_PROFILES[normalized.plan.constraints.profileId], ...normalized.plan.constraints };
  const operations = [];
  const [width, height] = [normalized.plan.board.widthMm, normalized.plan.board.heightMm];
  for (const [startX,startY,endX,endY] of [[0,0,width,0],[width,0,width,height],[width,height,0,height],[0,height,0,0]]) operations.push({ type: 'pcb.line.create', stage: 'outline', args: { net: '', layer: 11, startX, startY, endX, endY, lineWidth: 0.2, primitiveLock: true } });
  for (const component of [...normalized.plan.components].sort((a,b) => a.ref.localeCompare(b.ref))) operations.push({ type: 'pcb.component.modify', stage: 'placement', ref: component.ref, args: { primitiveId: component.primitiveId, property: { x: component.placement.xMm, y: component.placement.yMm, rotation: component.placement.rotation, layer: component.side === 'bottom' ? 2 : 1, primitiveLock: component.placement.locked } } });
  // 目标布线层：显式声明优先（已在校验阶段解析为合法铜层编号）；
  // 未声明时，若该网络的焊盘全在底面就布到底层，否则布到顶层 —— 与两层板行为一致。
  const componentByRef = new Map(normalized.plan.components.map((component) => [component.ref, component]));
  const padLayerOf = (ref) => (componentByRef.get(ref)?.side === 'bottom' ? 2 : 1);
  const sortedNets = [...normalized.plan.nets].sort((a,b) => a.name.localeCompare(b.name));
  const routeLayerOf = (net) => {
    if (net.layerId !== null) return net.layerId;
    const padLayers = new Set(net.endpoints.map((endpoint) => padLayerOf(endpoint.ref)));
    return padLayers.size === 1 && padLayers.has(2) ? 2 : 1;
  };
  const routes = [];
  for (const net of sortedNets) {
    const widthMm = net.class === 'power' ? Math.max(0.5, profile.minTrackMm) : Math.max(0.2, profile.minTrackMm);
    const layer = routeLayerOf(net);
    for (let index = 1; index < net.endpoints.length; index += 1) {
      const start = net.endpoints[index - 1]; const end = net.endpoints[index];
      const bend = { xMm: end.xMm, yMm: start.yMm };
      for (const [a,b] of [[start,bend],[bend,end]]) if (a.xMm !== b.xMm || a.yMm !== b.yMm) routes.push({ net: net.name, layer, start: a, end: b, widthMm, strategy: 'deterministic-manhattan' });
    }
  }
  for (const route of routes) operations.push({ type: 'pcb.line.create', stage: 'routing', args: { net: route.net, layer: route.layer, startX: route.start.xMm, startY: route.start.yMm, endX: route.end.xMm, endY: route.end.yMm, lineWidth: route.widthMm, primitiveLock: false } });

  // 层间转换（通孔）：焊盘所在层与走线层不同时，物理上必须打过孔。
  // 通孔是官方签名里 viaType 的默认行为，因此这里刻意不传 viaType ——
  // 该参数的取值编码尚无法离线核实，不在关键路径上冒险。
  const vias = [];
  const viaKeys = new Set();
  const pushVia = (net, xMm, yMm, reason) => {
    const key = `${net}:${xMm}:${yMm}:${reason}`;
    if (viaKeys.has(key)) return;
    viaKeys.add(key);
    vias.push({ net, xMm, yMm, reason });
  };
  for (const net of sortedNets) {
    const layer = routeLayerOf(net);
    for (const endpoint of net.endpoints) if (padLayerOf(endpoint.ref) !== layer) pushVia(net.name, endpoint.xMm, endpoint.yMm, 'pad-to-route-layer-transition');
  }

  // 覆铜：顶层地铺铜保持不变（与两层板一致），多层板再按叠层角色铺内层平面。
  // 平面按层号升序输出，便于人工按叠层顺序复核；显式声明优先于自动推导。
  const planeByLayer = new Map();
  if (normalized.plan.board.layers > 2) {
    const roles = planCopperRoles(normalized.plan.constraints.stackup, normalized.plan.board.layers);
    const powerNet = sortedNets.find((net) => net.class === 'power')?.name;
    for (const plane of roles.groundPlaneLayers) planeByLayer.set(plane.layerId, { net: 'GND', layer: plane.layerId, role: 'ground-plane' });
    // 没有电源网络就不铺电源平面：不凭空发明网络名。
    if (powerNet) for (const plane of roles.powerPlaneLayers) planeByLayer.set(plane.layerId, { net: powerNet, layer: plane.layerId, role: 'power-plane' });
  }
  for (const plane of normalized.plan.constraints.planes) planeByLayer.set(plane.layerId, { net: plane.net, layer: plane.layerId, role: 'explicit-plane' });
  const topPour = planeByLayer.get(1) ?? { net: 'GND', layer: 1, role: 'top-ground-pour' };
  const pours = [topPour, ...[...planeByLayer.values()].filter((pour) => pour.layer !== 1).sort((a, b) => a.layer - b.layer)];
  for (const pour of pours) operations.push({ type: 'pcb.pour.create', stage: 'copper', args: { net: pour.net, layer: pour.layer, clearance: profile.minClearanceMm, outline: [[0,0],[width,0],[width,height],[0,height]], removeIslands: true, thermalReliefSpokes: profile.thermalReliefSpokes } });

  // 地平面缝合孔：把顶层地铺铜与内层地平面连起来，避免平面悬空。
  if (normalized.plan.board.layers > 2 && profile.groundStitching !== false && pours.some((pour) => pour.net === 'GND' && pour.layer !== 1)) {
    for (const [xMm, yMm] of [[1, 1], [width - 1, 1], [width - 1, height - 1], [1, height - 1]]) pushVia('GND', xMm, yMm, 'ground-plane-stitching');
  }
  for (const via of vias) operations.push({ type: 'pcb.via.create', stage: 'routing', args: { net: via.net, x: via.xMm, y: via.yMm, holeDiameter: profile.minViaDrillMm, diameter: profile.minViaDiameterMm } });

  operations.push({ type: 'pcb.save', stage: 'save', args: {} }, { type: 'pcb.drc', stage: 'validation', args: {} });
  const quality = evaluateCompiledPlan(normalized.plan, profile, routes, operations);
  const compiledPlan = { apiVersion: 1, kind: 'pcb-production-plan', semanticPlanHash: normalized.planHash, title: normalized.plan.title, board: normalized.plan.board, constraints: { profileId: profile.id, minClearanceMm: profile.minClearanceMm, minCopperToEdgeMm: profile.minCopperToEdgeMm }, ...(normalized.plan.constraints.stackup ? { stackup: normalized.plan.constraints.stackup } : {}), operations };
  return { ...normalized, compiled: compiledPlan, compiledPlanHash: digest(compiledPlan), quality };
}

export function evaluateCompiledPlan(plan, profile, routes = [], operations = []) {
  const findings = [];
  const boxes = plan.components.map((component) => ({ ref: component.ref, ...placementBox(component) }));
  for (const box of boxes) if (box.left < profile.minCopperToEdgeMm || box.top < profile.minCopperToEdgeMm || box.right > plan.board.widthMm - profile.minCopperToEdgeMm || box.bottom > plan.board.heightMm - profile.minCopperToEdgeMm) findings.push(issue('COMPONENT_EDGE_CLEARANCE', `${box.ref}未满足板边净空`, `components.${box.ref}`));
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) if (boxes[i].left < boxes[j].right && boxes[i].right > boxes[j].left && boxes[i].top < boxes[j].bottom && boxes[i].bottom > boxes[j].top) findings.push(issue('COMPONENT_COLLISION', `${boxes[i].ref}与${boxes[j].ref}包围盒重叠`, `components`));
  for (const net of plan.nets.filter((item) => item.differentialPair)) if (!plan.constraints.impedance?.stackupSource) findings.push(issue('IMPEDANCE_STACKUP_REQUIRED', `${net.name}需要板厂叠层证据后才能计算阻抗`, `constraints.impedance`));
  const routedNets = new Set(routes.map((route) => route.net));
  for (const net of plan.nets) if (!routedNets.has(net.name)) findings.push(issue('UNROUTED_NET', `${net.name}没有生成确定性路径`, `nets.${net.name}`));
  // 指标从真实操作序列统计，而不是写死：改造前 viaCount 恒为 0、pourCount 恒为 1，
  // 多层板会因此报出与实际不符的统计。usedLayers 只统计铜层 ——
  // 板框画在非铜的板框层(11)上，混进来会让人误以为铜层被用到了 11 层。
  const hasOperations = operations.length > 0;
  const viaCount = hasOperations ? operations.filter((operation) => operation.type === 'pcb.via.create').length : 0;
  const pourCount = hasOperations ? operations.filter((operation) => operation.type === 'pcb.pour.create').length : 1;
  const usedLayers = hasOperations
    ? [...new Set(operations.filter((operation) => ['pcb.line.create', 'pcb.pour.create'].includes(operation.type)).map((operation) => operation.args.layer).filter((layer) => isCopperLayerId(layer, plan.board?.layers)))].sort((a, b) => a - b)
    : [];
  return { passed: findings.length === 0, findings, metrics: { componentCount: plan.components.length, netCount: plan.nets.length, routedNetCount: routedNets.size, trackSegmentCount: routes.length, viaCount, pourCount, usedLayers }, humanReviewRequired: true };
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => ({ name: entry.name, path: path.join(root, entry.name) }));
}

function parseDelimited(filePath) {
  let source = fs.readFileSync(filePath);
  if (source[0] === 0xff && source[1] === 0xfe) source = Buffer.from(source.subarray(2).toString('utf16le'));
  const content = source.toString('utf8').replace(/^\uFEFF/, '').trim();
  const lines = content.split(/\r?\n/).filter(Boolean);
  const delimiter = (lines[0]?.match(/\t/g)?.length || 0) > (lines[0]?.match(/,/g)?.length || 0) ? '\t' : ',';
  const split = (line) => line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ''));
  const headers = split(lines.shift() || '');
  return { headers, rows: lines.map((line) => Object.fromEntries(split(line).map((value, index) => [headers[index], value]))) };
}

function artifactContentChecks(files, root) {
  const findings = [];
  const choose = (kind) => files.find((file) => file.kind === kind && /utf8/i.test(file.name)) || files.find((file) => file.kind === kind);
  const bom = choose('bom'); const cpl = choose('cpl'); const gerber = choose('gerber');
  let bomRefs = new Set(); let cplRefs = new Set();
  if (bom) {
    const parsed = parseDelimited(path.join(root, bom.name));
    for (const required of ['Quantity','Designator','Footprint','Manufacturer Part','Supplier Part']) if (!parsed.headers.includes(required)) findings.push(issue('BOM_FIELD_MISSING', `BOM缺少字段${required}`, bom.name));
    bomRefs = new Set(parsed.rows.flatMap((row) => (row.Designator || '').split(',').map((ref) => ref.trim()).filter(Boolean)));
    if (!bomRefs.size) findings.push(issue('BOM_EMPTY', 'BOM没有有效位号', bom.name));
  }
  if (cpl) {
    const parsed = parseDelimited(path.join(root, cpl.name));
    for (const required of ['Designator','Mid X','Mid Y','Layer','Rotation']) if (!parsed.headers.includes(required)) findings.push(issue('CPL_FIELD_MISSING', `CPL缺少字段${required}`, cpl.name));
    cplRefs = new Set(parsed.rows.filter((row) => String(row.SMD || '').toLowerCase() !== 'no').map((row) => row.Designator).filter(Boolean));
    for (const row of parsed.rows) {
      if (row.Layer && !['T','B','Top','Bottom'].includes(row.Layer)) findings.push(issue('CPL_SIDE_INVALID', `${row.Designator}面别无效`, cpl.name));
      if (row.Rotation && !finite(Number(row.Rotation))) findings.push(issue('CPL_ROTATION_INVALID', `${row.Designator}旋转角无效`, cpl.name));
    }
  }
  for (const ref of cplRefs) if (!bomRefs.has(ref)) findings.push(issue('CPL_REF_NOT_IN_BOM', `${ref}存在于CPL但不在BOM`, 'reference-designators'));
  if (gerber && /\.zip$/i.test(gerber.name)) {
    try {
      const entries = execFileSync('/usr/bin/unzip', ['-Z1', path.join(root, gerber.name)], { encoding: 'utf8', timeout: 5000 }).split(/\r?\n/).filter(Boolean);
      const required = [/\.gtl$/i,/\.gbl$/i,/\.gts$/i,/\.gbs$/i,/\.gko$|outline/i,/\.drl$|\.xln$/i];
      for (const pattern of required) if (!entries.some((entry) => pattern.test(entry))) findings.push(issue('GERBER_LAYER_MISSING', `Gerber压缩包缺少${pattern}对应文件`, gerber.name));
    } catch (error) { findings.push(issue('GERBER_ARCHIVE_UNREADABLE', `无法展开Gerber压缩包目录: ${error.message}`, gerber.name)); }
  }
  return { findings, bomRefCount: bomRefs.size, cplRefCount: cplRefs.size };
}

export function inspectProductionArtifacts(root, binding = {}) {
  const files = listFiles(root).map((file) => ({ name: file.name, size: fs.statSync(file.path).size, sha256: sha256(file.path), kind: classifyArtifact(file.name) })).sort((a,b) => a.name.localeCompare(b.name));
  const kinds = new Set(files.map((file) => file.kind));
  const content = artifactContentChecks(files, root);
  const checks = [
    { id: 'bom', passed: kinds.has('bom'), message: 'BOM文件' },
    { id: 'cpl', passed: kinds.has('cpl'), message: 'CPL坐标文件' },
    { id: 'gerber', passed: kinds.has('gerber'), message: 'Gerber压缩包或图层文件' },
    { id: 'drill', passed: kinds.has('drill') || kinds.has('gerber'), message: '钻孔文件（压缩Gerber需人工展开复核）', manualReview: !kinds.has('drill') },
    { id: 'step', passed: kinds.has('step'), message: 'STEP三维文件' },
  ];
  // manifestHash 必须只由“内容”决定：如果把 generatedAt（或任何时间戳）算进去，
  // 哈希每次巡检都会变，人工终审就永远无法绑定到一批确定的物料上。
  const manifestCore = { schemaVersion: 1, kind: 'pcba-production-manifest', projectId: text(binding.projectId), projectName: text(binding.projectName), documentId: text(binding.documentId), sourceDigest: text(binding.sourceDigest), semanticPlanHash: text(binding.semanticPlanHash), compiledPlanHash: text(binding.compiledPlanHash), executionId: text(binding.executionId), files, checks, contentValidation: { passed: content.findings.length === 0, findings: content.findings, bomRefCount: content.bomRefCount, cplRefCount: content.cplRefCount }, procurement: { status: 'manual-review', reason: '未连接官方实时库存、价格和可贴装证据' }, dfm: { status: 'manual-review', portalUrl: 'https://www.jlc-dfm.com', uploadFiles: files.filter((file) => ['gerber','bom','cpl'].includes(file.kind)).map((file) => file.name), reason: '在线DFM需要登录态、上传和用户确认；本地检查不能冒充在线DFM' }, order: { status: 'disabled', reason: '系统永久禁止自动下单和支付' } };
  const completeBinding = ['projectId','documentId','sourceDigest','semanticPlanHash','compiledPlanHash','executionId'].every((key) => Boolean(manifestCore[key]));
  return { manifest: { ...manifestCore, generatedAt: new Date().toISOString(), manifestHash: digest(manifestCore) }, readyForHumanReview: checks.every((check) => check.passed) && content.findings.length === 0 && completeBinding, productionReleased: false, blockers: [...checks.filter((check) => !check.passed).map((check) => check.message), ...content.findings.map((item) => item.message), ...(!completeBinding ? ['缺少设计版本、执行或文档绑定'] : []), '等待人工终审', '等待嘉立创在线DFM'] };
}

export function classifyArtifact(name) {
  const lower = name.toLowerCase();
  if (/\.step$|\.stp$/.test(lower)) return 'step';
  if (/bom/.test(lower) && /\.csv$|\.xlsx$|\.xls$/.test(lower)) return 'bom';
  if (/cpl|pick.?and.?place|position/.test(lower) && /\.csv$|\.xlsx$|\.xls$/.test(lower)) return 'cpl';
  if (/\.drl$|\.xln$/.test(lower)) return 'drill';
  if (/gerber|\.gbr$|\.gtl$|\.gbl$|\.gts$|\.gbs$|\.gto$|\.gbo$/.test(lower) || (/\.zip$/.test(lower) && /gerber|fabrication|production/.test(lower))) return 'gerber';
  return 'review';
}

export class ProductionManager {
  constructor({ artifactsRoot, pcb = null, maxStoredPlans = MAX_STORED_PLANS }) { this.artifactsRoot = artifactsRoot; this.pcb = pcb; this.maxStoredPlans = maxStoredPlans; this.plans = new Map(); this.reviews = new Map(); }
  prune() { while (this.plans.size > this.maxStoredPlans) this.plans.delete(this.plans.keys().next().value); }
  normalize(plan) { const result = normalizeSemanticPlan(plan); this.plans.set(result.planHash, result); this.prune(); return result; }
  compile(plan) { const result = compileSemanticPlan(plan); this.plans.set(result.planHash, result); this.prune(); return result; }
  artifacts(binding) { return inspectProductionArtifacts(this.artifactsRoot, binding); }
  /**
   * 人工终审必须由服务端登记，并绑定到具体的语义计划、编译计划、PCB执行记录和物料清单哈希。
   * 这样终审既不能被客户端伪造，也不能在物料变化后被复用。
   */
  finalReview({ semanticPlanHash, compiledPlanHash, pcbExecutionId, manifestHash, reviewer = '' } = {}) {
    const entry = this.plans.get(text(semanticPlanHash));
    if (!entry) throw Object.assign(new Error('语义计划未在本Runtime会话中登记，请先校验或编译'), { code: 'PRODUCTION_PLAN_UNKNOWN', status: 404 });
    const execution = this.pcb?.get?.(text(pcbExecutionId));
    if (!execution) throw Object.assign(new Error('PCB执行记录不存在，无法绑定人工终审'), { code: 'PRODUCTION_EXECUTION_UNKNOWN', status: 404 });
    const recomputed = compileSemanticPlan(entry.plan);
    if (!recomputed.compiled || recomputed.compiledPlanHash !== text(compiledPlanHash)) throw Object.assign(new Error('编译计划哈希与已登记的语义计划不一致'), { code: 'PRODUCTION_COMPILED_PLAN_MISMATCH', status: 409 });
    if (!text(manifestHash)) throw Object.assign(new Error('人工终审必须绑定物料清单哈希'), { code: 'PRODUCTION_MANIFEST_REQUIRED', status: 400 });
    const record = { schemaVersion: 1, kind: 'pcba-final-review', semanticPlanHash: entry.planHash, compiledPlanHash: recomputed.compiledPlanHash, pcbExecutionId: execution.id, manifestHash: text(manifestHash), reviewer: text(reviewer) || 'human', reviewedAt: new Date().toISOString() };
    record.reviewHash = digest(record);
    this.reviews.set(record.reviewHash, record);
    return record;
  }
  /**
   * 门禁结论全部在服务端重算。入参只允许是“引用”（哈希/ID），不接受任何“已通过”的判定，
   * 否则客户端只要 POST { officialDrc:{passed:true}, finalReviewApproved:true } 就能自我放行。
   */
  readiness({ semanticPlanHash, compiledPlanHash, pcbExecutionId, reviewHash, binding = {} } = {}) {
    const entry = this.plans.get(text(semanticPlanHash));
    if (!entry) throw Object.assign(new Error('语义计划未在本Runtime会话中登记，请先校验或编译'), { code: 'PRODUCTION_PLAN_UNKNOWN', status: 404 });
    const recomputed = compileSemanticPlan(entry.plan);
    const artifacts = this.artifacts(binding);
    const execution = this.pcb?.get?.(text(pcbExecutionId)) || null;
    const manifestHash = artifacts.manifest.manifestHash;
    const review = this.reviews.get(text(reviewHash)) || null;
    const compiledMatches = Boolean(recomputed.compiled) && recomputed.compiledPlanHash === text(compiledPlanHash);
    const reviewMatches = Boolean(review) && review.semanticPlanHash === entry.planHash && review.compiledPlanHash === recomputed.compiledPlanHash && review.pcbExecutionId === (execution?.id || '') && review.manifestHash === manifestHash;
    const gates = [
      { id: 'semantic-plan', passed: recomputed.ready, source: 'local-validator' },
      { id: 'compiled-quality', passed: compiledMatches && Boolean(recomputed.quality?.passed), source: 'local-validator' },
      { id: 'official-pcb-drc', passed: execution?.drc?.passed === true, source: 'EasyEDA' },
      { id: 'artifacts', passed: artifacts.readyForHumanReview === true, source: 'artifact-validator' },
      { id: 'online-dfm', passed: false, source: '嘉立创在线DFM', reason: '需要登录态、上传和用户确认，本地检查不能冒充在线DFM' },
      { id: 'human-final-review', passed: reviewMatches, source: 'user' },
    ];
    return { ready: gates.every((gate) => gate.passed), gates, orderEnabled: false, referenced: { semanticPlanHash: entry.planHash, compiledPlanHash: recomputed.compiledPlanHash, pcbExecutionId: execution?.id || null, manifestHash, reviewHash: review?.reviewHash || null }, reason: gates.every((gate) => gate.passed) ? '生产资料已通过全部门禁，但自动下单仍永久禁用' : '仍有生产门禁未通过' };
  }
}
