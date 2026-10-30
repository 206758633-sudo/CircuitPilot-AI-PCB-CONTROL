import { attachPlanLineage, digest } from './design.mjs';
import { auditSchematicReadability, layoutSchematicComponents } from './schematic-layout.mjs';

const str = (v, n = 160) => String(v ?? '').trim().slice(0, n);
const list = (v, n) => Array.isArray(v) ? v.slice(0, n) : [];

export function normalizeReviewedNetlist(input = {}) {
  const components = list(input.components, 250).map((item) => ({
    ref: str(item.ref, 80).toUpperCase(), value: str(item.value, 120),
    libraryUuid: str(item.libraryUuid), uuid: str(item.uuid),
  }));
  const nets = list(input.nets, 500).map((item) => ({
    name: str(item.name, 120), endpoints: list(item.endpoints, 64).map((endpoint) => ({ ref: str(endpoint.ref, 80).toUpperCase(), pin: str(endpoint.pin, 30) })),
  }));
  const normalized = { kind: 'reviewed-netlist', title: str(input.title, 200) || '已审核项目网络表', components, nets, assumptions: list(input.assumptions, 30).map((v) => str(v, 400)) };
  const missing = [];
  const refs = new Set();
  components.forEach((item, index) => {
    if (!item.ref || refs.has(item.ref)) missing.push(`components.${index}:位号缺失或重复`);
    refs.add(item.ref);
    if (!item.libraryUuid || !item.uuid) missing.push(`${item.ref || index}:嘉立创EDA器件身份`);
  });
  nets.forEach((net, index) => {
    if (!net.name || net.endpoints.length < 2) missing.push(`nets.${index}:至少两个端点`);
    net.endpoints.forEach((endpoint) => {
      if (!refs.has(endpoint.ref)) missing.push(`${net.name}:未知位号${endpoint.ref}`);
      if (!endpoint.pin) missing.push(`${net.name}:${endpoint.ref}缺少引脚号`);
    });
  });
  if (!components.length) missing.push('components');
  if (!nets.length) missing.push('nets');
  return { netlist: normalized, missing: [...new Set(missing)], ready: missing.length === 0, netlistHash: digest(normalized) };
}

/**
 * 编译已审核网表 → 受控原理图操作。
 *
 * 落位从"固定 4 列 220×170 网格"改成 `schematic-layout.layoutSchematicComponents`（R2）：
 *  · 按连通簇分带（有共同网络的器件落在一起）+ 带内按(引脚数降序, 位号)排布；
 *  · 符号尺寸按类别/引脚数保守估计，格点对齐，任意两元件包围盒不重叠；
 *  · 操作顺序保持"先全部 component.create，再 net.connect"，端点→操作下标映射不变。
 *
 * planHash 会随落位坐标变化（它本来就是 plan 内容的摘要，语义边界不变：同输入 → 同 hash）。
 * 布局/可读性审计挂在返回值的 layoutAudit 上，**不进入 plan**，避免审计备注混进计划哈希。
 */
export function compileReviewedNetlist(input = {}) {
  const checked = normalizeReviewedNetlist(input);
  if (!checked.ready) return { ...checked, plan: null, planHash: null, layoutAudit: null };
  const layout = layoutSchematicComponents({ components: checked.netlist.components, nets: checked.netlist.nets });
  const placementByRef = new Map(layout.placements.map((item) => [item.ref, item]));
  const operationIndex = new Map();
  const operations = [];
  checked.netlist.components.forEach((item) => {
    // 布局对每个位号都有落位（同一位号在 normalize 里已保证唯一）；拿不到就退回原点，绝不静默重叠
    const placement = placementByRef.get(item.ref) || { x: 120, y: 120, width: 80, height: 60 };
    operationIndex.set(item.ref, operations.length);
    operations.push({ type: 'component.create', args: { component: { libraryUuid: item.libraryUuid, uuid: item.uuid }, x: placement.x, y: placement.y, addIntoBom: true, addIntoPcb: true } });
  });
  checked.netlist.nets.forEach((net) => operations.push({ type: 'net.connect', args: { net: net.name, endpoints: net.endpoints.map((endpoint) => ({ componentOperationIndex: operationIndex.get(endpoint.ref), pinNumber: endpoint.pin })) } }));
  // P0-8：AI 语义计划 → 编译计划时把来源双哈希带进 plan（参与 planHash）。
  // 缺省/undefined 不绑定；显式非法值由 attachPlanLineage 抛 APPROVAL_LINEAGE_INVALID(400)，
  // 不再静默丢弃。netlistHash 保持"网表内容摘要"语义，不因血缘变化（血缘只在计划里）。
  const plan = attachPlanLineage({ apiVersion: 1, kind: 'reviewed-netlist', title: checked.netlist.title, nets: checked.netlist.nets.map((item) => item.name), operations, assumptions: checked.netlist.assumptions }, input);
  // 审计：落位后的元件包围盒是否互叠（R2 硬约束）；标签由后续 net-connect/repair 通道负责，这里不伪造
  const audit = auditSchematicReadability({ components: layout.placements.map((placement) => ({ ref: placement.ref, x: placement.x, y: placement.y, width: placement.width, height: placement.height })) });
  const layoutAudit = {
    ok: audit.ok,
    findings: [...layout.findings, ...audit.findings],
    summary: { ...audit.summary, blocks: layout.blocks.length, placements: layout.placements.length },
    placements: layout.placements,
    blocks: layout.blocks,
  };
  return { ...checked, plan, planHash: digest(plan), layoutAudit };
}
