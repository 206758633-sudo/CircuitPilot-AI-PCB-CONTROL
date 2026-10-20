import crypto from 'node:crypto';
import { validateStackup } from './stackup.mjs';
import { analyzeHighSpeed } from './highspeed.mjs';
import { planBgaEscape, planLayerTransition, validateViaCapabilities } from './hdi.mjs';
import { analyzeRf, createSimulationHandoff } from './rf.mjs';
import { placeSilkscreen, solveLayout } from './layout.mjs';
import { evaluateLayoutRules } from './layout-rules.mjs';
import { MAX_COPPER_LAYERS, PLAN_COPPER_LAYER_COUNTS } from './layers.mjs';
import { RULE_PROFILES } from '../production.mjs';
import { discoverSolver } from '../simulation.mjs';
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function runEngineeringAnalysis(input = {}) {
  const stackup = validateStackup(input.stackup); const layout = solveLayout(input.layout || {}); const silkscreen = placeSilkscreen({ placements: layout.placements, forbidden: input.layout?.forbidden || [] });
  const highSpeed = (input.highSpeed || []).map(analyzeHighSpeed);
  const viaCapabilities = validateViaCapabilities(input.hdi || {});
  const transitions = (input.hdi?.transitions || []).map((t) => planLayerTransition({ ...t, layerCount: input.hdi.layerCount, viaTypes: input.hdi.viaTypes, maxStackedMicrovias: input.hdi.maxStackedMicrovias }));
  const bga = (input.hdi?.bga || []).map(planBgaEscape); const rf = (input.rf || []).map(analyzeRf);
  const simulationJobs = (input.rf || []).map((item) => createSimulationHandoff({ ...item.simulationJob, stackupHash: hash(stackup.stackup) }));
  // 布局规则审计是可选段：传入 input.layoutRules 才执行，避免改变既有工程样板报告的形状与哈希。
  // 传入后它的 FAIL 会并入 findings（硬门禁 → blocking），review/evidence 段随报告一起被哈希绑定。
  const layoutRules = input.layoutRules && typeof input.layoutRules === 'object' ? evaluateLayoutRules(input.layoutRules) : null;
  const layoutRuleFindings = layoutRules ? layoutRules.findings : [];
  const findings = [...stackup.findings,...layout.findings,...silkscreen.findings,...highSpeed.flatMap((r)=>r.findings),...viaCapabilities.findings,...transitions.flatMap((r)=>r.findings),...bga.flatMap((r)=>r.findings),...rf.flatMap((r)=>r.findings),...layoutRuleFindings];
  const components = input.layout?.components || [];
  const placementOperations = layout.placements.map((p)=>({ type:'pcb.component.modify',stage:'placement',args:{ primitiveId:String((components.find((c)=>c.ref===p.ref)||{}).primitiveId||''),property:{x:p.x,y:p.y,rotation:p.rotation,layer:1,primitiveLock:false}} })).filter((o)=>o.args.primitiveId);
  const routeOperations = (input.highSpeed || []).flatMap((network) => (network.routeGeometry || []).map((segment) => ({ type:'pcb.line.create', stage:'routing', args:{ net:String(network.net || ''), layer:segment.layer, startX:Number(segment.startX), startY:Number(segment.startY), endX:Number(segment.endX), endY:Number(segment.endY), lineWidth:Number(segment.lineWidth) } })));
  const viaOperations = (input.hdi?.placedVias || []).map((via) => ({ type:'pcb.via.create', stage:'vias', args:{ net:String(via.net || ''), x:Number(via.x), y:Number(via.y), holeDiameter:Number(via.holeDiameter), diameter:Number(via.diameter), ...(via.viaType === undefined ? {} : { viaType:via.viaType }) } }));
  const operations = [...placementOperations,...routeOperations,...viaOperations];
  // 没有 layoutRules 输入时不新增任何键：既有报告的 reportHash 保持逐字节不变。
  const report = { schemaVersion:1, kind:'advanced-pcb-engineering-report', stackup, highSpeed, hdi:{viaCapabilities,transitions,bga}, rf, layout, silkscreen, simulationJobs, findings, operations, passed: findings.every((item)=>item.severity!=='blocking'), humanReviewRequired:true, officialDrcRequired:true, onlineDfmRequired:true, ...(layoutRules ? { layoutRules, releaseReady: layoutRules.releaseReady } : {}) };
  return { ...report, reportHash: hash(report) };
}

// 能力清单必须由真实实现推导，不能另抄一份常量：曾经这里硬写 layers:[4,6,8]，
// 执行路径扩到 2..32 后它就变成了对外撒谎的过期能力声明。
export function engineeringProfiles() { return { highSpeed:['usb2','can','rs485','spi','clock200'], layers:[...PLAN_COPPER_LAYER_COUNTS], maxCopperLayers:MAX_COPPER_LAYERS, layerProfiles:Object.keys(RULE_PROFILES), rfMaxGHz:2.4, transmissionLines:['microstrip','stripline','cpwg'], solvers:{analytical:'implemented',external:'handoff-only',spice:(discoverSolver().path?'available':'solver-not-installed'),spiceEvidence:'run-and-hash-bound'}, productionBoundary:'official-drc-dfm-human-review' }; }
