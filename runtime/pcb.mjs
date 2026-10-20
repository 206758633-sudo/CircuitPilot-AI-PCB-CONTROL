import crypto from 'node:crypto';
import { ApprovalStore, digest, documentSourceDigest } from './design.mjs';
import { LAYER_IDS, countCopperLayers, isPlanCopperLayerCount, validateLayerReferences } from './engineering/layers.mjs';
import { validateStackup } from './engineering/stackup.mjs';
import { BOARD_OUTLINE_HELP } from './engineering/eda-primitives.mjs';
import { waitForEdaJob } from './engineering/eda-jobs.mjs';

export const PCB_API_VERSION = 1;
export const PCB_CAPABILITIES = Object.freeze([
  { id: 'context', status: 'supported', api: 'PCB primitive getAll APIs', production: true },
  { id: 'schematic-sync', status: 'supported', api: 'PCB_Document.importChanges', production: true },
  { id: 'save', status: 'supported', api: 'PCB_Document.save', production: true },
  { id: 'official-drc', status: 'supported', api: 'PCB_Drc.check', production: true },
  { id: 'board-outline', status: 'supported', api: 'PCB_PrimitivePolyline.create + PCB_MathPolygon.createPolygon', production: false, reason: `已在真机创建并回读校验（含板框层GKO导出）。原实现写 PCB_PrimitiveLine.create 是错的——Line/Arc 实测只接受 SIGNAL 铜层。${BOARD_OUTLINE_HELP}` },
  { id: 'component-placement', status: 'experimental', api: 'PCB_PrimitiveComponent.modify', production: false, reason: '官方标记为Beta，需要界面回读和人工复核' },
  { id: 'manual-routing', status: 'experimental', api: 'PCB_PrimitiveLine/PCB_PrimitiveVia', production: false, reason: '官方图元写API为Beta' },
  { id: 'autorouting', status: 'user-assisted', api: 'PCB_Document.autoRouting', production: false, reason: '官方明确禁止在生产环境使用Beta自动布线API' },
  { id: 'copper-pour', status: 'experimental', api: 'PCB_PrimitivePour.create', production: false, reason: '官方图元写API为Beta' },
  { id: 'multi-layer', status: 'experimental', api: 'PCB_Layer.setTheNumberOfCopperLayers', production: false, reason: '官方标记为Beta；执行路径放行 2,4,6,…,32 层（2 层以上必须有可验证叠层证据），变更层数后必须人工复核叠层与设计规则' },
  { id: 'inner-layer-routing', status: 'experimental', api: 'PCB_PrimitiveLine/PrimitivePour + 内层铜层编号', production: false, reason: '内层铜层编号自 15 起（3/4 是丝印），必须经 engineering/layers.mjs 换算，禁止裸写层号' },
  { id: 'blind-buried-via', status: 'experimental', api: 'PCB_PrimitiveVia.create(...,designRuleBlindViaName)', production: false, reason: '盲埋孔跨度由板内已存在的设计规则项名定义，不是层号；且 viaType 取值编码（官方类型为 0/1/2 枚举，运行时 JS 已混淆）未经真机核实' },
  { id: '3d-check', status: 'supported', api: 'PCB_ManufactureData.get3DFile', production: false, reason: '只能证明文件可生成，不等同DFM通过' },
  { id: 'bom-export', status: 'experimental', api: 'PCB_ManufactureData.getBomFile', production: false, reason: '官方标记为Beta，导出后必须复核' },
  { id: 'cpl-export', status: 'experimental', api: 'PCB_ManufactureData.getPickAndPlaceFile', production: false, reason: '官方标记为Beta，导出后必须复核' },
  { id: 'gerber-export', status: 'user-assisted', api: 'PCB_ManufactureData.getGerberFile', production: false, reason: '官方明确禁止在生产环境使用该Beta API' },
  { id: 'order-payment', status: 'unavailable', api: null, production: false, reason: '安全策略永久禁止下单和支付' },
]);

const allowedOperationTypes = new Set(['pcb.importChanges','pcb.line.create','pcb.outline.create','pcb.component.modify','pcb.via.create','pcb.pour.create','pcb.save','pcb.drc']);
/** 会改变板子状态的操作；官方DRC必须排在这些操作之后才有放行意义。 */
const mutatingOperationTypes = new Set(['pcb.importChanges','pcb.line.create','pcb.outline.create','pcb.component.modify','pcb.via.create','pcb.pour.create','pcb.save']);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const MAX_OPERATIONS = 2_000;
const BATCH_SIZE = 50;
const OPERATION_TIMEOUT_MS = 30_000;
const operationStage = (operation) => operation.stage || ({ 'pcb.importChanges': 'sync', 'pcb.component.modify': 'placement', 'pcb.line.create': 'routing', 'pcb.outline.create': 'outline', 'pcb.via.create': 'routing', 'pcb.pour.create': 'copper', 'pcb.save': 'save', 'pcb.drc': 'validation' }[operation.type] || 'mutation');
const withTimeout = (promise, timeoutMs, code) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Object.assign(new Error(`PCB操作超过${timeoutMs}ms`), { code })), timeoutMs); Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }); });

/** 官方 DRC 返回的是分组信封（`{name, list:[...]}`），也可能给扁平项；两者都要能聚合。 */
const drcGroupKey = (item) => String(item?.name ?? item?.code ?? item?.title ?? item?.rule ?? 'unknown');
const drcGroupCount = (item) => (Array.isArray(item?.list) ? item.list.length : 1);
export const drcGroups = (items) => {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = drcGroupKey(item);
    groups.set(key, (groups.get(key) || 0) + drcGroupCount(item));
  }
  return groups;
};

/**
 * DRC 裁决：有基线就**只对本次改动新增/加重的类别负责**，没基线才是"一条都不许有"的严格模式。
 *
 * 为什么必须有基线：真机实测（第 16 轮）——这块 6 层板**不做任何改动**跑官方 DRC 也报 4 项
 * `Clearance Error`（既有违规）。若"有违规就回滚"，那么任何写入都会被既有违规永远回滚，
 * 等于把工程锁死，这不是安全而是失效。有基线之后，回滚只会发生在"你这次真的弄坏了什么"的时候。
 */
export const drcVerdict = ({ baseline, findings } = {}) => {
  const groups = drcGroups(findings);
  const baselineGroups = Array.isArray(baseline) ? drcGroups(baseline) : null;
  const regressions = baselineGroups
    ? [...groups.entries()]
      .filter(([key, count]) => count > (baselineGroups.get(key) || 0))
      .map(([key, count]) => ({ group: key, before: baselineGroups.get(key) || 0, after: count }))
    : [];
  const passed = baselineGroups ? regressions.length === 0 : groups.size === 0;
  return { passed, groups, baselineGroups, regressions, strict: !baselineGroups };
};

/**
 * 同步差异检测：原理图已确认要上板的器件 vs PCB 现况。
 *
 * 为什么需要它（第 20–23 轮真机结论，后续轮次校正过边界）：
 *   - 嘉立创EDA 3.2.186 上 `pcb.importChanges` 是 **no-op**（返回 true 但器件数不变）；
 *   - `pcb_PrimitiveComponent.create` 用"直接传库引用"的 5 种形状真机全部 500（EDA 内部还要
 *     先解析一层库项，公开 API 拿不到那层对象）；
 *   - 所以"用 importChanges 从原理图批量落板"走不通。
 * 【已废弃结论】"公开 API 不能新增 PCB 器件"——后续已登记 `pcb.component.create` 生产命令
 * （单件 Beta，创建后回读确认；受库解析/版本能力限制，不能据此认为批量落板已打通）。
 * 批量落板仍以原理图侧创建 + EDA 原生同步为准，CircuitPilot 负责"出方案 + 回读验收"。
 * 这里只做**判定**，不假装能写：差异没清零就绝不放行后续自动布局。
 *
 * 位号规范化：大小写/空白容忍；`R?`/`U?` 这类**未完成标注**的位号单独计入 `unannotated`，
 * 绝不静默当作已匹配（EDA 的位号标注是异步的，这是真机教训）。
 */
export const diffPcbAgainstNetlist = ({ schematicParts = [], pcbDesignators = [] } = {}) => {
  const norm = (value) => String(value ?? '').trim().toUpperCase();
  const clean = (list) => [...new Set(list.map(norm).filter(Boolean))];
  const schematic = clean(schematicParts);
  const pcb = clean(pcbDesignators);
  const unannotated = schematic.filter((item) => item.includes('?'));
  const annotated = schematic.filter((item) => !item.includes('?'));
  const pcbSet = new Set(pcb);
  const matched = annotated.filter((item) => pcbSet.has(item)).sort();
  const missing = annotated.filter((item) => !pcbSet.has(item)).sort();
  const extra = pcb.filter((item) => !annotated.includes(item)).sort();
  const ready = missing.length === 0 && extra.length === 0 && unannotated.length === 0;
  return {
    schematicCount: annotated.length, pcbCount: pcb.length, matched, missing, extra, unannotated, ready,
    guide: ready
      ? '原理图与 PCB 已一致，可以继续自动布局与 DRC。'
      : `PCB 还差 ${missing.length} 个器件${extra.length ? `、多 ${extra.length} 个` : ''}${unannotated.length ? `、另有 ${unannotated.length} 个位号未标注` : ''}。请在嘉立创EDA 打开原理图 → 菜单"设计 → 更新/转换原理图到 PCB"（确认变更后应用）→ 回到这里点"回读验收"。`,
  };
};

export function normalizePcbPlan(input = {}) {
  const board = {
    widthMm: Number(input.board?.widthMm), heightMm: Number(input.board?.heightMm), layers: Number(input.board?.layers),
    thicknessMm: Number(input.board?.thicknessMm), copperOz: Number(input.board?.copperOz), mountingHoles: Number(input.board?.mountingHoles ?? 0),
  };
  const operations = Array.isArray(input.operations) ? input.operations : [];
  const plan = { apiVersion: PCB_API_VERSION, kind: 'pcb-production-plan', title: String(input.title || 'PCB production plan'), board, constraints: input.constraints || {}, operations, ...(input.stackup ? { stackup: input.stackup } : {}) };
  const missing = [];
  // A5：计划/操作里引用未标注位号（`C?`）直接判不完整，避免带着占位位号进入执行。
  const unannotatedRefs = operations
    .map((operation, index) => ({ index, designator: operation?.args?.designator ?? operation?.args?.ref }))
    .filter((item) => item.designator !== undefined && String(item.designator).includes('?'));
  for (const item of unannotatedRefs) missing.push(`designator-unannotated:operation-${item.index}:${String(item.designator).slice(0, 16)}`);
  if (![board.widthMm,board.heightMm,board.layers,board.thicknessMm,board.copperOz,board.mountingHoles].every(finite)) missing.push('board');
  // 层数不再写死 2：放行 validateStackup 有校验能力的 2,4,6,…,32 层。
  // EDA 本身支持到 32 层，但 10 层以上没有叠层证据模型，放行等于让无校验的层数进入生产。
  if (board.widthMm <= 0 || board.heightMm <= 0 || !isPlanCopperLayerCount(board.layers) || board.thicknessMm <= 0 || board.copperOz <= 0 || board.mountingHoles < 0) missing.push('board-rules');
  // 四层以上、且**这次真的在宣称叠层或动内层铜**时，必须有可验证叠层证据。
  // 没有叠层证据就无法判定内层角色、参考平面与阻抗，所以那两种情形一律拦下。
  //
  // 为什么不是"层数 > 2 就一律要叠层"：本计划模型的全部合法操作里**没有**任何一个能改变铜层数
  // （`pcb.layers.setCount` 不在计划操作表里）。只做文档生命周期动作的计划里，`board.layers`
  // 是"我读到的这块板实测几层"，执行前 `verifyDocumentLayers()` 还会拿它跟文档实测层列表逐一核对；
  // 对它索要板厂叠层单，会把"把已确认的原理图变更同步进现成 6 层板并跑 DRC"这类日常动作直接堵死——
  // 真机实测过：`{operations:[pcb.importChanges, pcb.save]}` 因为要叠层而永远 `ready:false`。
  // 而只要计划开始创建板框/走线/铺铜这类多层几何，或显式声明叠层/内层，就必须有可验证叠层证据。
  const layerIdsOf = (operation) => {
    const args = operation?.args || {};
    const list = [];
    if (args.layer !== undefined) list.push(Number(args.layer));
    if (Array.isArray(args.layers)) list.push(...args.layers.map(Number));
    return list.filter(Number.isFinite);
  };
  const innerCopperIds = new Set(Array.from({ length: 30 }, (_, index) => LAYER_IDS.INNER_1 + index));
  const touchesInnerCopper = operations.some((operation) => layerIdsOf(operation).some((layer) => innerCopperIds.has(layer)));
  // 只做"把已确认的原理图变更同步进现成板子"这类**文档生命周期**动作（导入变更/放置/保存/DRC），
  // 不宣称也不创建任何多层几何——此时 board.layers 只是"这块板实测几层"，执行前 verifyDocumentLayers() 还会核对。
  const lifecycleOnlyOperations = new Set(['pcb.importChanges', 'pcb.component.modify', 'pcb.save', 'pcb.drc']);
  const claimsMultilayerGeometry = operations.some((operation) => !lifecycleOnlyOperations.has(operation?.type));
  const assertsStackup = Boolean(input.stackup || input.constraints?.stackup || input.constraints?.profileId)
    || claimsMultilayerGeometry || touchesInnerCopper;
  if (isPlanCopperLayerCount(board.layers) && board.layers > 2 && assertsStackup) {
    const stackupCheck = validateStackup(input.stackup);
    if (!stackupCheck.ready) missing.push(`stackup:${[...new Set(stackupCheck.findings.map((finding) => finding.code))].join('|')}`);
    else if (countCopperLayers(input.stackup) !== board.layers) missing.push(`stackup-layer-count-mismatch:${countCopperLayers(input.stackup)}!=${board.layers}`);
  }
  // 层号换算陷阱：内层铜层编号从 15 起（3/4 是丝印）。叠层序号绝不能直接当 layer 用。
  for (const violation of validateLayerReferences(board, operations)) {
    missing.push(`${violation.index >= 0 ? `operation-${violation.index}` : 'board'}:${violation.reason}:${violation.layer}`);
  }
  for (const [index, operation] of operations.entries()) {
    if (!allowedOperationTypes.has(operation?.type)) { missing.push(`operation-${index}:${operation?.type || 'missing'}`); continue; }
    // 板框只能在板框层用 Polyline 通道创建；层号写错或尺寸非正，一律在编译期拦下。
    if (operation?.type === 'pcb.outline.create') {
      const args = operation.args || {};
      if (args.layer !== undefined && Number(args.layer) !== LAYER_IDS.BOARD_OUTLINE) missing.push(`operation-${index}:outline-layer-must-be-${LAYER_IDS.BOARD_OUTLINE}`);
      if (!(Number(args.widthMm) > 0) || !(Number(args.heightMm) > 0)) missing.push(`operation-${index}:outline-dimensions-required`);
    }
    // 旧写法（Line + 板框层）已实测必然失败，直接判为无效计划，避免再发出 4 条注定失败的写操作。
    if (operation?.type === 'pcb.line.create' && Number(operation.args?.layer) === LAYER_IDS.BOARD_OUTLINE) missing.push(`operation-${index}:board-outline-needs-pcb.outline.create`);
  }
  if (!operations.length) missing.push('operations');
  if (operations.length > MAX_OPERATIONS) missing.push(`operations-limit:${operations.length}`);
  // 官方DRC必须存在且排在最后：否则可以先跑一次“干净”的DRC拿到放行，再用后续写入改板。
  const drcIndexes = operations.map((operation, index) => (operation?.type === 'pcb.drc' ? index : -1)).filter((index) => index >= 0);
  if (!drcIndexes.length) missing.push('official-drc-required');
  else if (drcIndexes.at(-1) !== operations.length - 1) missing.push('official-drc-must-be-last-operation');
  return { plan, missing, ready: missing.length === 0, planHash: digest(plan) };
}

export function compileCh32v003Fixture(input = {}) {
  const placements = input.placements || {};
  const outline = [{ type: 'pcb.outline.create', stage: 'outline', args: { layer: LAYER_IDS.BOARD_OUTLINE, originXMm: 0, originYMm: 0, widthMm: 45, heightMm: 30 } }];
  const componentOperations = Object.entries(placements).sort(([a],[b]) => a.localeCompare(b)).map(([primitiveId, property]) => ({ type: 'pcb.component.modify', args: { primitiveId, property } }));
  return normalizePcbPlan({
    title: 'CH32V003 45x30mm controlled PCB',
    board: { widthMm: 45, heightMm: 30, layers: 2, thicknessMm: 1.6, copperOz: 1, mountingHoles: 0 },
    constraints: { usbC: 'short-edge-centered-flush', button: 'opposite-edge', led: 'near-button', swio: 'long-edge-accessible' },
    operations: [{ type: 'pcb.importChanges', args: {} }, ...outline, ...componentOperations, { type: 'pcb.save', args: {} }, { type: 'pcb.drc', args: {} }],
  });
}

function unwrap(result) { return result?.result ?? result?.data ?? result; }
export class PcbManager {
  /**
   * @param drcMode 'job'（默认）把 DRC 放到 EDA 渲染进程后台跑，客户端轮询取结果；
   *   'blocking' 走单次阻塞调用（只适合小板，且受桥接传输预算限制）。
   * @param drcDeadlineMs DRC 后台任务的墙钟上限：真实规模的板子要跑几分钟，
   *   这个值必须远大于任何单次 HTTP 预算，否则又会回到"超时=没结果"的老路上。
   */
  constructor({ bridge, approvals = null, operationTimeoutMs = OPERATION_TIMEOUT_MS, batchSize = BATCH_SIZE, drcMode = 'job', drcDeadlineMs = 15 * 60 * 1000, drcPollIntervalMs = 5_000, store = null, ledger = null }) {
    this.bridge = bridge; this.approvals = approvals || new ApprovalStore({ ledger }); this.operationTimeoutMs = operationTimeoutMs; this.batchSize = batchSize; this.drcMode = drcMode; this.drcDeadlineMs = drcDeadlineMs; this.drcPollIntervalMs = drcPollIntervalMs;
    this.store = store; this.executions = new Map(); this.running = false; this.writeLocked = false; this.persistenceError = null;
    // 同原理图执行：重启后 PCB 写入历史仍在；损坏则抛错由 server 降级为内存（不伪造历史）。
    if (store) {
      const state = store.load();
      for (const item of Array.isArray(state?.data?.executions) ? state.data.executions : []) {
        if (item && typeof item.id === 'string') this.executions.set(item.id, item);
      }
    }
  }
  persist() {
    if (!this.store) return;
    try {
      this.store.save({ executions: [...this.executions.values()] });
      this.persistenceError = null;
    } catch (error) {
      this.persistenceError = { code: 'EXECUTION_PERSIST_FAILED', message: String(error?.message || error).slice(0, 300), at: new Date().toISOString() };
    }
  }
  list() {
    return [...this.executions.values()]
      .map((item) => ({
        kind: 'pcb', id: item.id, state: item.state, planHash: item.planHash,
        createdAt: item.events?.[0]?.at || null,
        eventCount: item.events?.length ?? 0,
        progress: item.progress || null,
        error: item.error || null,
        drc: item.drc ? { passed: Boolean(item.drc.passed), findings: Array.isArray(item.drc.findings) ? item.drc.findings.length : null } : null,
      }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
  capabilities() { return { apiVersion: PCB_API_VERSION, edaVersion: '3.2.175', items: PCB_CAPABILITIES }; }
  async context() {
    const document = await this.bridge.execute('document.current');
    const documentValue = unwrap(document);
    if (Number(documentValue?.documentType) !== 3) throw Object.assign(new Error(`当前活动文档不是PCB编辑器（documentType=${documentValue?.documentType ?? 'unknown'}），请先打开PCB文档`), { code: 'PCB_DOCUMENT_REQUIRED', documentType: documentValue?.documentType ?? null });
    const [project, rules, source] = await Promise.all([
      this.bridge.execute('project.current'), this.bridge.execute('pcb.rules.read'), this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true }),
    ]);
    const reads = { layers: 'pcb.layers.read', nets: 'pcb.nets.read', components: 'pcb.components.read', lines: 'pcb.lines.read', vias: 'pcb.vias.read', pours: 'pcb.pours.read', regions: 'pcb.regions.read', texts: 'pcb.texts.read', outline: 'pcb.outline.read' };
    const entries = await Promise.all(Object.entries(reads).map(async ([name, command]) => {
      try { return [name, { ok: true, value: unwrap(await this.bridge.execute(command)) }]; }
      catch (error) { return [name, { ok: false, error: error.message || String(error) }]; }
    }));
    const settled = Object.fromEntries(entries);
    const readErrors = entries.filter(([, item]) => !item.ok).map(([name, item]) => ({ name, error: item.error }));
    const sourceValue = unwrap(source);
    const pcbValue = { document: documentValue, ...Object.fromEntries(Object.keys(reads).map((name) => [name, settled[name].value || []])), readErrors };
    const context = { apiVersion: PCB_API_VERSION, windowId: this.bridge.selectedWindowId, capturedAt: new Date().toISOString(), project: unwrap(project), pcb: pcbValue, rules: unwrap(rules), sourceDigest: typeof sourceValue === 'string' ? documentSourceDigest(sourceValue) : null, complete: readErrors.length === 0 };
    context.targetFingerprint = digest({ windowId: context.windowId, project: context.project, document: context.pcb?.document, sourceDigest: context.sourceDigest });
    return context;
  }
  /**
   * 用 EDA **实际发现**的层列表核对计划要写入的每一层都真实存在。
   *
   * pcb.layers.read 返回的 id 就是官方 EPCB_LayerId，与本项目 layers.mjs 换算出的
   * 层号同源，因此可以直接比对。文档缺层时必须**在任何写入之前**拒绝：否则内层操作
   * 会失败，或者更糟——静默不生效，让计划显示“已执行”而板子根本没改。
   */
  verifyDocumentLayers(plan, context) {
    const layers = context?.pcb?.layers;
    // 读不到层列表时不在这里阻断：上下文完整性已由 before.complete 兜底。
    if (!Array.isArray(layers) || !layers.length) return null;
    const available = new Set(layers.map((layer) => Number(layer?.id)));
    const requested = [...new Set(plan.operations.map((operation) => operation.args?.layer).filter((layer) => Number.isInteger(layer)))].sort((a, b) => a - b);
    const missingLayers = requested.filter((layer) => !available.has(layer));
    if (missingLayers.length) throw Object.assign(new Error(`嘉立创EDA当前文档缺少计划所需的层: ${missingLayers.join(', ')}；请先设置铜箔层数并确认叠层`), { code: 'PCB_LAYER_NOT_IN_DOCUMENT', missingLayers });
    // 铜层编号：1/2 是外层，15..44 是内层（3/4 是丝印、5/6 是阻焊，不能算进来）。
    const copperLayerIds = [...available].filter((id) => id === 1 || id === 2 || (id >= 15 && id <= 44)).sort((a, b) => a - b);
    return { requestedLayers: requested, availableLayers: [...available].sort((a, b) => a - b), documentCopperLayerIds: copperLayerIds, documentCopperLayerCount: copperLayerIds.length, declaredLayerCount: Number(plan.board?.layers) };
  }

  /**
   * 执行单条计划操作。
   *
   * DRC 单列出来：真实规模的板子上 `PCB_Drc.check` 要跑几分钟，远超任何单次 HTTP 预算。
   * 这里把 DRC 变成 EDA 渲染进程里的后台任务，客户端轮询——超时抛 `EDA_JOB_TIMEOUT`，
   * **绝不返回空数组**（本项目历史上出现过"超时假 0 项"的假阳性）。
   */
  /**
   * 派发长任务前的**健康前置门**。
   *
   * 为什么需要它：历史上最贵的失败是"发了一个 110s 的调用，等满 118.0s 也不知道渲染进程到底在干嘛"。
   * 现在先用 3s 探一次会话：答不上来就直接判 `EDA_RENDERER_UNHEALTHY`，不去发那个长调用。
   * 同时把 epoch 交给运行时任务表——渲染进程换会话时，在途任务会被如实收口为 interrupted。
   */
  async assertRendererHealthy() {
    let session;
    try {
      session = unwrap(await this.bridge.execute('eda.session'));
    } catch (error) {
      // 测试替身/旧桥接不认这条命令时放行；能确认"渲染进程不回应"的才拦。
      if (error?.code === 'EDA_COMMAND_NOT_ALLOWED') return null;
      throw Object.assign(new Error(`EDA渲染进程未在健康探针内应答，已拒绝派发长任务：${error?.message || error}`), { code: 'EDA_RENDERER_UNHEALTHY', probeCode: error?.code ?? null });
    }
    if (session && typeof session.epoch === 'string') this.bridge.jobs?.observeEpoch(session.epoch);
    return session || null;
  }

  /**
   * DRC 单列出来：真实规模的板子上 `PCB_Drc.check` 可能要跑很久，远超任何单次 HTTP 预算。
   * 这里把 DRC 变成 EDA 渲染进程里的后台任务，客户端轮询——超时抛 `EDA_JOB_TIMEOUT`，
   * 渲染进程换会话抛 `EDA_JOB_INTERRUPTED`，**绝不返回空数组**（历史上出现过"超时假 0 项"）。
   *
   * 渲染进程换会话属于**可恢复**情形（DRC 只读、幂等），所以刻意重派一次；
   * 但只重派一次，且重派也要重新过健康门——不搞无限重试。
   */
  async runOperation(operation, event = null) {
    if (operation.type !== 'pcb.drc' || this.drcMode === 'blocking') return withTimeout(this.bridge.execute(operation.type, operation.args || {}, { allowWrite: true }), this.operationTimeoutMs, 'PCB_OPERATION_TIMEOUT');
    await this.assertRendererHealthy();
    const attempt = async (round) => {
      const jobId = crypto.randomUUID();
      const started = unwrap(await this.bridge.execute('pcb.drc.job.start', { jobId, userInterface: Boolean(operation.args?.userInterface) }, { allowWrite: true }));
      if (!started?.accepted) throw Object.assign(new Error('嘉立创EDA未接受DRC后台任务'), { code: 'PCB_DRC_JOB_REJECTED', jobId });
      event?.('pcb.drc', 'started', { jobId, mode: 'job', round, deadlineMs: this.drcDeadlineMs });
      const finished = await waitForEdaJob({
        execute: (commandId, args) => this.bridge.execute(commandId, args),
        jobId, store: this.bridge.jobs || null, deadlineMs: this.drcDeadlineMs, pollIntervalMs: this.drcPollIntervalMs,
        onHeartbeat: (beat) => event?.('pcb.drc', 'heartbeat', { jobId, ...beat }),
      });
      const payload = finished.result;
      if (!payload || payload.kind !== 'array') throw Object.assign(new Error('DRC后台任务未返回问题清单'), { code: 'PCB_DRC_UNKNOWN_RESULT', jobId, kind: payload?.kind ?? null });
      if (payload.truncated) event?.('pcb.drc', 'truncated', { jobId, count: payload.count, returned: payload.items.length });
      return { result: payload.items, jobId, count: payload.count, truncated: Boolean(payload.truncated), polls: finished.polls, elapsedMs: finished.elapsedMs, round };
    };
    try {
      return await attempt(1);
    } catch (error) {
      if (error?.code !== 'EDA_JOB_INTERRUPTED' && error?.code !== 'EDA_JOB_LOST') throw error;
      event?.('pcb.drc', 'redispatch', { code: error.code, jobId: error.jobId ?? null });
      await this.assertRendererHealthy();
      const retried = await attempt(2);
      return { ...retried, dispatchedAfter: error.code };
    }
  }

  approve({ plan, targetFingerprint, windowId, stages = ['sync','outline','placement','save','drc','rollback'] }) {
    const normalized = normalizePcbPlan(plan);
    if (!normalized.ready) throw Object.assign(new Error(`PCB计划信息不完整: ${normalized.missing.join(', ')}`), { code: 'PCB_PLAN_INCOMPLETE' });
    return this.approvals.issue({ planHash: normalized.planHash, targetFingerprint, windowId, steps: stages });
  }
  async execute({ plan, approvalToken, targetFingerprint, windowId }) {
    if (this.writeLocked) throw Object.assign(new Error('PCB恢复校验失败，真实写入已锁定；请人工检查工程并重启Runtime'), { code: 'PCB_WRITE_LOCKED' });
    if (this.running) throw Object.assign(new Error('已有PCB写任务正在执行'), { code: 'PCB_EXECUTION_BUSY' });
    const normalized = normalizePcbPlan(plan);
    if (!normalized.ready) throw Object.assign(new Error('PCB计划无效'), { code: 'PCB_PLAN_INCOMPLETE' });
    this.approvals.consume(approvalToken, { planHash: normalized.planHash, targetFingerprint, windowId });
    const before = await this.context();
    if (before.targetFingerprint !== targetFingerprint || before.windowId !== windowId) throw Object.assign(new Error('PCB目标已变化，请重新读取并批准'), { code: 'PCB_TARGET_DRIFT' });
    if (!before.complete) throw Object.assign(new Error(`PCB上下文读取不完整: ${(before.pcb?.readErrors || []).map((item) => item.name).join(', ')}`), { code: 'PCB_CONTEXT_INCOMPLETE', readErrors: before.pcb?.readErrors || [] });
    // 写入前用文档实际层列表核对：缺层必须在这里失败，而不是等内层操作静默不生效。
    const layerCheck = this.verifyDocumentLayers(normalized.plan, before);
    const source = unwrap(await this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true }));
    if (typeof source !== 'string' || !source.length) throw Object.assign(new Error('无法建立非空PCB源码快照'), { code: 'PCB_SNAPSHOT_EMPTY' });
    const execution = { id: crypto.randomUUID(), state: 'snapshotting', planHash: normalized.planHash, targetFingerprint, events: [], snapshot: { digest: documentSourceDigest(source), size: source.length }, stageSnapshots: [], progress: { completed: 0, total: normalized.plan.operations.length }, layerCheck, readback: null, drc: null };
    this.executions.set(execution.id, execution);
    this.running = true;
    const event = (stage, status, detail = {}) => execution.events.push({ at: new Date().toISOString(), stage, status, detail });
    event('snapshot', 'passed', execution.snapshot);
    try {
      execution.state = 'executing';
      // 写前基线：计划里既有写入又有官方 DRC 时，先跑一次基线 DRC。
      // 拿不到基线就退回严格模式，并把"没有基线"这件事写进执行记录——绝不假装有基线。
      const hasMutation = normalized.plan.operations.some((operation) => mutatingOperationTypes.has(operation.type));
      const hasDrc = normalized.plan.operations.some((operation) => operation.type === 'pcb.drc');
      if (hasMutation && hasDrc) {
        try {
          const baseline = unwrap(await this.runOperation({ type: 'pcb.drc', args: {} }, (stage, status, detail) => event('pcb.drc.baseline', status, detail)));
          execution.baselineDrc = Array.isArray(baseline) ? baseline : null;
          event('pcb.drc.baseline', 'passed', { count: execution.baselineDrc?.length ?? null, mode: 'before-mutation' });
        } catch (error) {
          execution.baselineDrc = null;
          event('pcb.drc.baseline', 'failed', { code: error?.code || 'PCB_DRC_BASELINE_FAILED', message: String(error?.message || error) });
        }
      }
      const grouped = [];
      for (const operation of normalized.plan.operations) {
        const stage = operationStage(operation); const last = grouped[grouped.length - 1];
        if (last?.stage === stage) last.operations.push(operation); else grouped.push({ stage, operations: [operation] });
      }
      for (const group of grouped) {
        const stageSource = unwrap(await this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true }));
        if (typeof stageSource !== 'string' || !stageSource.length) throw Object.assign(new Error(`${group.stage}阶段无法建立快照`), { code: 'PCB_STAGE_SNAPSHOT_EMPTY' });
        const stageSnapshot = { stage: group.stage, source: stageSource, digest: documentSourceDigest(stageSource), operationOffset: execution.progress.completed };
        execution.stageSnapshots.push({ stage: group.stage, digest: stageSnapshot.digest, operationOffset: stageSnapshot.operationOffset });
        event(group.stage, 'started', { operationCount: group.operations.length, digest: stageSnapshot.digest });
        try {
          for (let offset = 0; offset < group.operations.length; offset += this.batchSize) {
            const batch = group.operations.slice(offset, offset + this.batchSize);
            for (const operation of batch) {
              const result = await this.runOperation(operation, event);
              const detail = unwrap(result);
              if (operation.type === 'pcb.save' && detail !== true) throw Object.assign(new Error('嘉立创EDA未确认PCB保存成功'), { code: 'PCB_SAVE_FAILED' });
              const drcMeta = operation.type === 'pcb.drc' && result && typeof result === 'object' && result.jobId ? { jobId: result.jobId, count: result.count, truncated: result.truncated, polls: result.polls, elapsedMs: result.elapsedMs } : null;
              execution.progress.completed += 1;
              event(operation.type, 'passed', { result: detail, ...(drcMeta ? { drc: drcMeta } : {}), progress: { ...execution.progress } });
            }
            event(group.stage, 'heartbeat', { completedInStage: Math.min(offset + batch.length, group.operations.length), operationCount: group.operations.length, progress: { ...execution.progress } });
          }
          if (!group.operations.some((operation) => operation.type === 'pcb.save')) {
            const saved = unwrap(await withTimeout(this.bridge.execute('pcb.save', {}, { allowWrite: true }), this.operationTimeoutMs, 'PCB_OPERATION_TIMEOUT'));
            if (saved !== true) throw Object.assign(new Error(`${group.stage}阶段保存失败`), { code: 'PCB_SAVE_FAILED' });
          }
          const stageReadback = unwrap(await this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true }));
          if (typeof stageReadback !== 'string' || !stageReadback.length) throw Object.assign(new Error(`${group.stage}阶段回读为空`), { code: 'PCB_STAGE_READBACK_EMPTY' });
          event(group.stage, 'passed', { sourceDigest: documentSourceDigest(stageReadback), operationCount: group.operations.length });
        } catch (stageError) {
          stageError.stageSnapshot = stageSnapshot;
          throw stageError;
        }
      }
      execution.state = 'reading';
      const after = await this.context();
      if (after.windowId !== windowId) throw Object.assign(new Error('PCB执行后目标窗口发生变化'), { code: 'PCB_TARGET_DRIFT' });
      const afterSource = unwrap(await this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true }));
      if (typeof afterSource !== 'string' || !afterSource.length) throw Object.assign(new Error('PCB执行后源码回读为空'), { code: 'PCB_READBACK_EMPTY' });
      const outlineValue = after.pcb?.outline;
      execution.readback = { sourceDigest: documentSourceDigest(afterSource), targetFingerprint: after.targetFingerprint, componentCount: after.pcb?.components?.length ?? null, lineCount: after.pcb?.lines?.length ?? null, viaCount: after.pcb?.vias?.length ?? null, pourCount: after.pcb?.pours?.length ?? null, outlineCount: outlineValue?.count ?? null, outlineBoundsMm: outlineValue?.boundsMm ?? null, zoomToBoardOutline: outlineValue?.zoomToBoardOutline ?? null };
      event('readback', 'passed', execution.readback);
      execution.state = 'verifying';
      const drcIndex = execution.events.map((item) => item.stage).lastIndexOf('pcb.drc');
      const lastMutationIndex = execution.events.reduce((latest, item, index) => (mutatingOperationTypes.has(item.stage) ? index : latest), -1);
      if (drcIndex < 0) throw Object.assign(new Error('计划未返回有效的官方PCB DRC结果'), { code: 'PCB_DRC_UNKNOWN_RESULT' });
      // 只接受“晚于全部写入”的DRC事件；早于写入的DRC只是历史快照，不能作为放行依据。
      if (drcIndex < lastMutationIndex) throw Object.assign(new Error('官方PCB DRC结果早于最后一次写入，不能作为放行依据'), { code: 'PCB_DRC_STALE' });
      const drcEvent = execution.events[drcIndex];
      const drcResult = drcEvent?.detail?.result ?? drcEvent?.detail;
      if (!Array.isArray(drcResult)) throw Object.assign(new Error('计划未返回有效的官方PCB DRC结果'), { code: 'PCB_DRC_UNKNOWN_RESULT' });
      const findings = drcResult;
      const verdict = drcVerdict({ baseline: execution.baselineDrc, findings });
      execution.drc = {
        passed: verdict.passed, findings, strict: verdict.strict,
        groups: Object.fromEntries(verdict.groups), baselineGroups: verdict.baselineGroups ? Object.fromEntries(verdict.baselineGroups) : null,
        regressions: verdict.regressions, job: drcEvent?.detail?.drc ?? null,
      };
      if (!execution.drc.passed) {
        const detail = verdict.regressions.length
          ? `本次改动新增/加重：${verdict.regressions.map((item) => `${item.group} ${item.before}→${item.after}`).join('、')}`
          : `严格模式（没有可用基线）下不允许任何违规`;
        throw Object.assign(new Error(`PCB DRC存在${findings.length}项问题（${detail}）`), { code: 'PCB_DRC_FAILED', regressions: verdict.regressions });
      }
      execution.state = 'completed';
    } catch (error) {
      event('execution', 'failed', { code: error.code || 'PCB_EXECUTION_FAILED', message: error.message });
      execution.state = 'rollback_required'; execution.error = { code: error.code || 'PCB_EXECUTION_FAILED', message: error.message };
      try {
        const rollbackSource = error.stageSnapshot?.source || source;
        const rollbackDigest = error.stageSnapshot?.digest || execution.snapshot.digest;
        const restoredResult = unwrap(await this.bridge.execute('document.source.restore', { source: rollbackSource }, { allowWrite: true }));
        const saved = restoredResult === true && unwrap(await this.bridge.execute('pcb.save', {}, { allowWrite: true })) === true;
        const restored = saved ? unwrap(await this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true })) : '';
        if (!saved || typeof restored !== 'string' || documentSourceDigest(restored) !== rollbackDigest) throw Object.assign(new Error('PCB恢复后的源码摘要不匹配'), { code: 'PCB_ROLLBACK_VERIFY_FAILED' });
        execution.state = 'rolled_back'; event('rollback', 'passed', { digest: rollbackDigest, stage: error.stageSnapshot?.stage || 'full-execution' });
      } catch (rollbackError) {
        execution.state = 'rollback_failed'; this.writeLocked = true;
        event('rollback', 'failed', { code: rollbackError.code || 'PCB_ROLLBACK_FAILED', message: rollbackError.message });
      }
    } finally {
      this.running = false;
      this.persist();
    }
    return execution;
  }
  get(id) { return this.executions.get(id) || null; }
  evidence(id) { return this.get(id); }
}
