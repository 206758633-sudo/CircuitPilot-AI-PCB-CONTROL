import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalStore, attachPlanLineage, digest, documentSourceDigest } from './design.mjs';
import { LAYER_IDS, countCopperLayers, isPlanCopperLayerCount, validateLayerReferences } from './engineering/layers.mjs';
import { validateStackup } from './engineering/stackup.mjs';
import { BOARD_OUTLINE_HELP, mmToMil } from './engineering/eda-primitives.mjs';
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
/**
 * 只做文档生命周期、不创建板框/走线/铺铜几何的操作集合。
 * 这类计划若唯一的"写入"是 `pcb.importChanges` 而整份源码回读前后完全一致，
 * 就是真机踩过的"importChanges 返回 success 但一个器件都没落"的形态（P0-2）。
 */
const SYNC_ONLY_OPERATION_TYPES = new Set(['pcb.importChanges','pcb.component.modify','pcb.save','pcb.drc']);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * 高层 PCB 计划统一使用 mm，而嘉立创EDA 的 PCB 数据单位是 mil
 * （官方 `SYS_Unit` 类型注释：“PCB 数据单位跨度等效为 mil”；真机 COMPONENT
 * x=393.7008 也正是 10mm）。计划哈希、批准令牌和 UI 编辑器都必须绑定 mm，
 * 只在真正下发 EDA 前做一次换算，否则“板框 45mm、走线 0.2”会被 EDA 当成
 * 45mil/0.2mil，整块板缩小 25.4 倍而 DRC 仍可能通过。
 *
 * 注意：`pcb.outline.create` 的 `widthMm/heightMm` 本来就由桥内部换算，不能再转；
 * 但它的 `lineWidth` 是 EDA 原生 mil，需要转换。`complexPolygon` 是已经按
 * EDA 原生 mil 构造的对象，不转换。`pcb.pour.create.lineWidth` 是覆铜边框线宽，
 * 真机既有覆铜读回为 `0.2`（mm），与坐标/走线/过孔的 mil 不同，不能跟着换算。
 */
export const PCB_PLAN_GEOMETRY_UNIT = 'mm';
const planMmToMil = (value) => Number(mmToMil(value).toFixed(6));

/** 把一份 mm 单位的高层 PCB 操作转换为桥接层需要的 EDA 原生单位（mil）。 */
export function toEdaOperationArgs(operation = {}) {
  const args = operation.args && typeof operation.args === 'object' ? operation.args : {};
  const convert = (source, keys) => {
    const copy = { ...source };
    for (const key of keys) if (finite(copy[key])) copy[key] = planMmToMil(copy[key]);
    return copy;
  };
  switch (operation.type) {
    case 'pcb.component.modify': {
      if (!args.property || typeof args.property !== 'object') return args;
      const property = convert(args.property, ['x', 'y']);
      return { ...args, property };
    }
    case 'pcb.line.create':
      return convert(args, ['startX', 'startY', 'endX', 'endY', 'lineWidth']);
    case 'pcb.via.create':
      return convert(args, ['x', 'y', 'holeDiameter', 'diameter']);
    case 'pcb.outline.create':
      return convert(args, ['lineWidth']);
    case 'pcb.pour.create': {
      const copy = { ...args };
      if (Array.isArray(args.outline)) {
        copy.outline = args.outline.map((point) => Array.isArray(point) ? point.map((value, index) => index < 2 && finite(value) ? planMmToMil(value) : value) : point);
      }
      // lineWidth 是 mm（真机既有覆铜读回 0.2），保持原值；只有轮廓坐标需要转 mil。
      return copy;
    }
    default:
      return args;
  }
}
const MAX_OPERATIONS = 2_000;
const BATCH_SIZE = 50;
const OPERATION_TIMEOUT_MS = 30_000;
const operationStage = (operation) => operation.stage || ({ 'pcb.importChanges': 'sync', 'pcb.component.modify': 'placement', 'pcb.line.create': 'routing', 'pcb.outline.create': 'outline', 'pcb.via.create': 'routing', 'pcb.pour.create': 'copper', 'pcb.save': 'save', 'pcb.drc': 'validation' }[operation.type] || 'mutation');
const withTimeout = (promise, timeoutMs, code) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Object.assign(new Error(`PCB操作超过${timeoutMs}ms`), { code })), timeoutMs); Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }); });

/**
 * P1-16 持久写锁：锁文件落在 stateDir（默认 artifacts/state，可用 CIRCUITPILOT_STATE_DIR 覆盖）。
 * 为什么必须落盘：`this.running` 只能防同一进程内的并发；两个 Runtime 实例、或崩溃后重启的实例
 * 都能写同一块板，而“崩溃时正好写了一半”是 PCBA 场景里代价最高的事故形态。
 * 锁文件只是**互斥租约**，不是安全锁：崩溃遗留锁超过 15 分钟或 pid 已不存在时允许接管并记录痕迹；
 * 回滚失败的安全锁（writeLocked）走执行记录持久化，不会被 stale 规则自动解除。
 */
const PCB_WRITE_LOCK_FILE = 'pcb-write-lock.json';
const PCB_WRITE_LOCK_STALE_MS = 15 * 60 * 1000;
const defaultStateDir = () => (String(process.env.CIRCUITPILOT_STATE_DIR || '').trim() || join(process.cwd(), 'artifacts', 'state'));
const defaultPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};
const documentUuidOf = (context) => { const uuid = context?.pcb?.document?.uuid; return typeof uuid === 'string' && uuid.trim() ? uuid.trim() : null; };
const primitiveIdOf = (value) => {
  if (typeof value === 'string') return value;
  const unwrapped = unwrap(value);
  if (typeof unwrapped === 'string') return unwrapped;
  const id = unwrapped?.primitiveId ?? unwrapped?.id ?? null;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
};
/** 板面摘要：兼容 `pcb.outline.read` 的 {count,items} 信封，也兼容 lines/vias/pours 的 primitiveId 数组。 */
const surfaceSnapshot = (pcb = {}) => {
  const outline = pcb?.outline;
  const outlineItems = Number.isFinite(outline?.count) ? (Array.isArray(outline?.items) ? outline.items : []) : (Array.isArray(outline) ? outline : []);
  const idsOf = (value) => new Set((Array.isArray(value) ? value : []).map((item) => (typeof item === 'string' ? item : String(item?.primitiveId ?? item?.id ?? ''))).filter(Boolean));
  const outlineIds = new Set(outlineItems.map((item) => (typeof item === 'string' ? item : String(item?.primitiveId ?? item?.id ?? ''))).filter(Boolean));
  return {
    // envelope=true 表示真实桥的 `pcb.outline.read` 信封（{count,items,...}）可用；
    // 老桥/测试桩只回裸数组时无法判定“真的读到了板面”，按类型断言必须降级为 unverifiable（见 verifyWriteEffects）。
    outline: { envelope: Number.isFinite(outline?.count), count: Number.isFinite(outline?.count) ? Number(outline.count) : (Array.isArray(outline) ? outline.length : null), ids: outlineIds },
    line: { count: Array.isArray(pcb?.lines) ? pcb.lines.length : null, ids: idsOf(pcb?.lines) },
    via: { count: Array.isArray(pcb?.vias) ? pcb.vias.length : null, ids: idsOf(pcb?.vias) },
    pour: { count: Array.isArray(pcb?.pours) ? pcb.pours.length : null, ids: idsOf(pcb?.pours) },
  };
};
const componentRefSetOf = (components) => {
  const set = new Set();
  for (const item of Array.isArray(components) ? components : []) {
    if (typeof item === 'string') { set.add(item); continue; }
    for (const key of ['primitiveId', 'id', 'designator', 'ref']) {
      const value = item?.[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      set.add(key === 'designator' || key === 'ref' ? value.trim().toUpperCase() : value.trim());
    }
  }
  return set;
};

/**
 * P0（2026-10-29 真机回滚失败）：整档 `document.source.restore` 不能当成唯一恢复手段。
 * 真机实测它会返回 true 却留下摘要不一致/线段被拆分的板子；因此在整档恢复之前，
 * 先按本次创建返回的 primitive id 做一次**定向删除**，尽量把新增铜箔清掉。
 * 定向删除失败不阻断后续整档恢复，但必须进入事件与执行记录，不能静默。
 */
const CREATED_PRIMITIVE_DELETE = {
  'pcb.line.create': { command: 'pcb.lines.delete', batch: true, kind: 'line' },
  'pcb.via.create': { command: 'pcb.vias.delete', batch: true, kind: 'via' },
  'pcb.pour.create': { command: 'pcb.pour.delete', batch: false, kind: 'pour' },
};
async function compensateCreatedPrimitives(bridge, createdIds, event) {
  const attempted = [];
  const deleted = [];
  const failed = [];
  const skipped = [];
  for (const [operation, ids] of Object.entries(createdIds || {})) {
    if (!Array.isArray(ids) || ids.length === 0) continue;
    const spec = CREATED_PRIMITIVE_DELETE[operation];
    if (!spec) {
      skipped.push({ operation, ids, reason: 'no-delete-command' });
      continue;
    }
    if (spec.batch) {
      attempted.push(...ids.map((primitiveId) => ({ operation, primitiveId, command: spec.command })));
      try {
        const result = unwrap(await bridge.execute(spec.command, { primitiveIds: ids }, { allowWrite: true }));
        if (result === false) failed.push({ operation, ids, command: spec.command, error: 'delete-returned-false' });
        else deleted.push(...ids);
      } catch (error) {
        failed.push({ operation, ids, command: spec.command, error: String(error?.message || error) });
      }
    } else {
      for (const primitiveId of ids) {
        attempted.push({ operation, primitiveId, command: spec.command });
        try {
          const result = unwrap(await bridge.execute(spec.command, { primitiveId }, { allowWrite: true }));
          if (result === false || result?.deleted === false) failed.push({ operation, primitiveId, command: spec.command, error: 'delete-returned-false' });
          else deleted.push(primitiveId);
        } catch (error) {
          failed.push({ operation, primitiveId, command: spec.command, error: String(error?.message || error) });
        }
      }
    }
  }
  const summary = { attempted: attempted.length, deleted, failed, skipped };
  if (attempted.length || skipped.length) event('rollback-compensation', failed.length ? 'partial' : 'passed', summary);
  return summary;
}

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
  /**
   * P0-2：同步期望（可选）。
   *
   * 真机教训：`pcb.importChanges` 会返回 success 却一个器件都不落板。只凭"执行器 completed"
   * 就提示同步成功，等于把空转当成写板。调用方（同步按钮）必须声明"同步后 PCB 上应有的位号"，
   * 执行器在回读后逐项核对，缺一个就失败并回滚。
   *
   * 只在调用方显式提供时才写进计划：保持旧计划哈希稳定（账本/批准令牌不因升级失效）。
   */
  const rawExpected = Array.isArray(input.expectations?.designators)
    ? input.expectations.designators
    : (Array.isArray(input.expectedDesignators) ? input.expectedDesignators : null);
  const missing = [];
  let expectations = null;
  if (rawExpected) {
    const designators = [];
    const seen = new Set();
    for (const value of rawExpected.slice(0, 2000)) {
      const designator = String(value ?? '').trim().toUpperCase();
      if (!designator) continue;
      if (designator.includes('?')) { missing.push(`expectations-unannotated:${designator.slice(0, 16)}`); continue; }
      if (seen.has(designator)) continue;
      seen.add(designator);
      designators.push(designator);
    }
    if (!designators.length) missing.push('expectations-empty');
    if (rawExpected.length > 2000) missing.push(`expectations-limit:${rawExpected.length}`);
    expectations = { designators };
  }
  // P0-1：保留来源页面的语义/编译双哈希（参与 planHash、批准令牌与账本绑定）。
  const plan = attachPlanLineage({ apiVersion: PCB_API_VERSION, kind: 'pcb-production-plan', title: String(input.title || 'PCB production plan'), board, constraints: input.constraints || {}, operations, ...(input.stackup ? { stackup: input.stackup } : {}), ...(expectations ? { expectations } : {}) }, input);
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
  const lifecycleOnlyOperations = SYNC_ONLY_OPERATION_TYPES;
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
/**
 * PCB 受控执行管理器。
 *
 * 执行记录字段契约（server/UI 可依赖；新增字段全部可选，不破坏既有字段）：
 * - `documentUuid`：执行绑定的目标 PCB 文档 uuid。每次写批次、回读、回滚前都用 document.current 复核；
 *   漂移抛 `PCB_TARGET_DRIFT`（status 409，details.phase = 'write'|'readback'|'rollback'|'binding'，含 expected/actual）。
 * - `writeLock`：本次执行持有的跨进程写锁 `{owner,pid,startedAt,path,takeover}`；stale 接管痕迹记录在 takeover。
 * - `verify`：按写入类型的回读结果 `{ok, enforced, planned, actual, missing, unverifiable}`；不匹配抛
 *   `PCB_WRITE_VERIFY_INCOMPLETE`（status 409），并尽力回滚。`enforced=false` 仅出现在桥不返回
 *   `pcb.outline.read` 官方信封（老桥/测试桩）时：此时如实记 unverifiable，不伪造“已验证”。
 * - `rollbackScope: 'all'|'stage'|null` 与 `snapshotRestored: boolean|null`：
 *   - `all`：恢复到执行前整份快照（`snapshotRestored=true` 表示摘要已核对）；
 *   - `stage`：只恢复到**失败阶段开始前**的快照；此前阶段已逐阶段保存并保留（见 `rollback.retainedStages`），
 *     所以不能声称“已恢复执行前快照”，UI 应展示 `rollback.message`；
 *   - `rollbackFailed=true` + `rollbackError`：文档漂移/恢复校验失败，无法安全回滚；同时置安全写锁（重启后仍生效）。
 * - `syncCheck`/`error`/`readback`/`drc`/`saved` 等既有字段保持原语义。
 */
export class PcbManager {
  /**
   * @param drcMode 'job'（默认）把 DRC 放到 EDA 渲染进程后台跑，客户端轮询取结果；
   *   'blocking' 走单次阻塞调用（只适合小板，且受桥接传输预算限制）。
   * @param drcDeadlineMs DRC 后台任务的墙钟上限：真实规模的板子要跑几分钟，
   *   这个值必须远大于任何单次 HTTP 预算，否则又会回到"超时=没结果"的老路上。
   * @param stateDir 持久状态目录（写锁文件所在）；默认 CIRCUITPILOT_STATE_DIR 或 artifacts/state。
   * @param writeLockPath 显式指定锁文件路径（测试用）；默认 `${stateDir}/pcb-write-lock.json`。
   * @param lockStaleMs 遗留锁接管阈值，默认 15 分钟。
   * @param now / pidAlive 时间与存活探测注入点（测试可复现 stale 接管，不依赖真实等待）。
   */
  constructor({ bridge, approvals = null, operationTimeoutMs = OPERATION_TIMEOUT_MS, batchSize = BATCH_SIZE, drcMode = 'job', drcDeadlineMs = 15 * 60 * 1000, drcPollIntervalMs = 5_000, store = null, ledger = null, stateDir = null, writeLockPath = null, lockStaleMs = PCB_WRITE_LOCK_STALE_MS, now = () => new Date(), pidAlive = defaultPidAlive }) {
    this.bridge = bridge; this.approvals = approvals || new ApprovalStore({ ledger }); this.operationTimeoutMs = operationTimeoutMs; this.batchSize = batchSize; this.drcMode = drcMode; this.drcDeadlineMs = drcDeadlineMs; this.drcPollIntervalMs = drcPollIntervalMs;
    this.store = store; this.executions = new Map(); this.running = false; this.writeLocked = false; this.persistenceError = null;
    this.stateDir = typeof stateDir === 'string' && stateDir.trim() ? stateDir.trim() : defaultStateDir();
    this.writeLockPath = typeof writeLockPath === 'string' && writeLockPath.trim() ? writeLockPath.trim() : join(this.stateDir, PCB_WRITE_LOCK_FILE);
    this.lockStaleMs = Number.isFinite(lockStaleMs) && lockStaleMs >= 0 ? lockStaleMs : PCB_WRITE_LOCK_STALE_MS;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.pidAlive = typeof pidAlive === 'function' ? pidAlive : defaultPidAlive;
    this.owner = `pcb-manager-${process.pid}-${crypto.randomUUID()}`;
    this.writeLease = null;
    this.safetyLock = null;
    // 同原理图执行：重启后 PCB 写入历史仍在；损坏则抛错由 server 降级为内存（不伪造历史）。
    if (store) {
      const state = store.load();
      for (const item of Array.isArray(state?.data?.executions) ? state.data.executions : []) {
        if (item && typeof item.id === 'string') this.executions.set(item.id, item);
      }
      // 回滚失败的安全锁必须跨重启生效（P1-E）：优先读显式 writeLock 段，旧数据回退到 rollback_failed 记录。
      const persistedLock = state?.data?.writeLock;
      if (persistedLock && typeof persistedLock.locked === 'boolean') {
        this.writeLocked = persistedLock.locked;
        this.safetyLock = persistedLock.locked ? { lockedAt: persistedLock.lockedAt ?? null, executionId: persistedLock.executionId ?? null, code: persistedLock.code ?? null, message: persistedLock.message ?? null } : null;
      } else {
        const failed = [...this.executions.values()].find((item) => item?.state === 'rollback_failed');
        if (failed) {
          this.writeLocked = true;
          this.safetyLock = { lockedAt: failed.events?.at?.(-1)?.at ?? null, executionId: failed.id, code: failed.error?.code ?? 'PCB_ROLLBACK_FAILED', message: failed.error?.message ?? '历史回滚失败（重启后恢复写锁）' };
        }
      }
    }
  }
  persist() {
    if (!this.store) return;
    try {
      // writeLock 段与执行记录同文件：重启后“回滚失败”的安全锁不会丢（P1-E）。
      this.store.save({
        executions: [...this.executions.values()],
        writeLock: {
          locked: this.writeLocked,
          lockedAt: this.safetyLock?.lockedAt ?? null,
          executionId: this.safetyLock?.executionId ?? null,
          code: this.safetyLock?.code ?? null,
          message: this.safetyLock?.message ?? null,
        },
      });
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
        // WP2 新增（可选字段，旧 UI 忽略即可）：目标文档/写锁/回读核对/回滚口径。
        documentUuid: item.documentUuid ?? null,
        writeLock: item.writeLock || null,
        verify: item.verify ? { ok: Boolean(item.verify.ok), missing: item.verify.missing || [] } : null,
        rollbackScope: item.rollbackScope ?? null,
        snapshotRestored: item.snapshotRestored ?? null,
        rollbackFailed: Boolean(item.rollbackFailed),
      }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
  capabilities() { return { apiVersion: PCB_API_VERSION, edaVersion: '3.2.175', items: PCB_CAPABILITIES }; }

  /** 读取锁文件；损坏/不可解析返回 {corrupt:true}（调用方 fail-closed，绝不自动删除）。 */
  readWriteLease() {
    try { if (!existsSync(this.writeLockPath)) return null; } catch { return null; }
    let parsed;
    try { parsed = JSON.parse(readFileSync(this.writeLockPath, 'utf8')); }
    catch (error) { return { corrupt: true, message: String(error?.message || error).slice(0, 200) }; }
    if (!parsed || typeof parsed !== 'object') return { corrupt: true, message: 'lock file is not a JSON object' };
    return parsed;
  }
  /** 可接管判据：超过 staleMs 或 pid 已不存在；两者都记录下来作为接管原因。 */
  staleReasonOf(lease) {
    if (!lease || lease.corrupt) return null;
    const startedAtMs = Date.parse(String(lease.startedAt ?? ''));
    if (!Number.isFinite(startedAtMs)) return 'invalid-startedAt';
    if (this.now().getTime() - startedAtMs > this.lockStaleMs) return 'stale-age';
    const pid = Number(lease.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !this.pidAlive(pid)) return 'stale-pid';
    return null;
  }
  /**
   * 获取跨进程写锁（原子写：临时文件 + rename，避免读到半截 JSON）。
   * 冲突抛 PCB_WRITE_LOCKED(409)；文件损坏同样 fail-closed 拒绝执行；接管时返回 takeover 供执行记录留痕。
   */
  acquireWriteLease({ operation = 'pcb.execute', planHash = null } = {}) {
    const existing = this.readWriteLease();
    let takeover = null;
    if (existing) {
      if (existing.corrupt) throw Object.assign(new Error(`PCB写锁文件损坏：${this.writeLockPath}（${existing.message}）。为避免并发写板已拒绝执行，请人工确认后删除该文件`), { code: 'PCB_WRITE_LOCKED', status: 409, details: { path: this.writeLockPath, reason: 'lock-file-corrupt' } });
      const staleReason = this.staleReasonOf(existing);
      if (!staleReason) throw Object.assign(new Error(`PCB写锁被占用：owner=${String(existing.owner ?? 'unknown')} pid=${String(existing.pid ?? 'unknown')} since=${String(existing.startedAt ?? 'unknown')}（${this.writeLockPath}）。另一个Runtime实例正在写板，拒绝并发写入`), { code: 'PCB_WRITE_LOCKED', status: 409, details: { path: this.writeLockPath, reason: 'held', owner: existing.owner ?? null, pid: existing.pid ?? null, startedAt: existing.startedAt ?? null, operation: existing.operation ?? null } });
      takeover = { reason: staleReason, previous: existing };
    }
    const lease = { schemaVersion: 1, owner: this.owner, pid: process.pid, startedAt: this.now().toISOString(), operation: String(operation || 'pcb.execute'), planHash };
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const temp = `${this.writeLockPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(temp, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
      renameSync(temp, this.writeLockPath);
    } catch (error) {
      throw Object.assign(new Error(`PCB写锁无法写入（${this.writeLockPath}）：${String(error?.message || error)}`), { code: 'PCB_WRITE_LOCK_FAILED', status: 503, details: { path: this.writeLockPath } });
    }
    this.writeLease = lease;
    return takeover;
  }
  /** 正常结束释放：只删除自己持有的锁，不误删别人接管后的锁。 */
  releaseWriteLease() {
    const lease = this.writeLease;
    if (!lease) return { released: false };
    this.writeLease = null;
    try {
      const current = this.readWriteLease();
      if (current && !current.corrupt && current.owner === lease.owner) unlinkSync(this.writeLockPath);
    } catch { /* 释放失败不改变执行结论；残留锁由 stale 规则接管 */ }
    return { released: true };
  }
  writeLockStatus() { return { safetyLocked: this.writeLocked, safetyLock: this.safetyLock, lease: this.writeLease, path: this.writeLockPath, file: this.readWriteLease() }; }
  /** 人工解除安全写锁（回滚失败后）。必须显式调用，不会因重启/stale 规则自动解除。 */
  releaseSafetyLock({ operator = 'unknown', note = '' } = {}) {
    if (!this.writeLocked) return { released: false, reason: 'not-locked' };
    const previous = this.safetyLock;
    this.writeLocked = false;
    this.safetyLock = null;
    this.persist();
    return { released: true, operator, note, previous };
  }
  /**
   * P0-4：目标文档绑定校验。每次写批次 / 回读 / 回滚前读一次 document.current，
   * 与执行开始时绑定的 uuid 比对；不一致抛 PCB_TARGET_DRIFT(409)，错误体带 phase 与 expected/actual。
   * 读不到 uuid（老桥/测试桩）时不强行拦截，但执行记录会留一条 unverified 事件。
   */
  async assertDocumentBinding(execution, phase, event = null) {
    if (!execution?.documentUuid) return null;
    const current = unwrap(await this.bridge.execute('document.current'));
    const actual = typeof current?.uuid === 'string' && current.uuid.trim() ? current.uuid.trim() : null;
    if (actual === execution.documentUuid) return actual;
    const labels = { write: '写入批次前', readback: '回读前', rollback: '回滚前', binding: '执行开始时' };
    const error = Object.assign(new Error(`PCB目标文档在执行中发生变化（${labels[phase] || phase}）：预期 ${execution.documentUuid}，实际 ${actual || '读取失败'}。已停止写入，避免把改动落到另一块板`), {
      code: 'PCB_TARGET_DRIFT', status: 409, phase, expected: execution.documentUuid, actual,
      details: { phase, expected: execution.documentUuid, actual },
    });
    if (event) event('target-drift', 'failed', error.details);
    throw error;
  }
  /**
   * P1-4：按写入类型的回读断言。
   * 输入写前快照（context() 已读 lines/vias/pours/outline/components）与创建操作返回的 primitiveId，
   * 逐类核对：新增 outline/line/via/pour 是否真的出现在板上；component.modify 的目标 ref 是否存在。
   * 判定口径：创建返回的 id 全部能在回读里找到 → 通过；否则退化为“数量差 ≥ 计划数”（兼容 EDA 合并图元）。
   * 不通过返回 missing 明细，由调用方抛 PCB_WRITE_VERIFY_INCOMPLETE 并走回滚。
   */
  verifyWriteEffects({ plan, beforeSurface, afterPcb, createdIds = {} }) {
    const verifyTypes = { 'pcb.outline.create': 'outline', 'pcb.line.create': 'line', 'pcb.via.create': 'via', 'pcb.pour.create': 'pour' };
    const typeOfKind = { outline: 'pcb.outline.create', line: 'pcb.line.create', via: 'pcb.via.create', pour: 'pcb.pour.create' };
    const readOfKind = { outline: 'outline', line: 'lines', via: 'vias', pour: 'pours' };
    const labelOfKind = { outline: '板框', line: '走线', via: '过孔', pour: '覆铜' };
    const planned = { outline: 0, line: 0, via: 0, pour: 0, componentModify: 0 };
    const componentRefs = [];
    for (const operation of Array.isArray(plan?.operations) ? plan.operations : []) {
      const kind = verifyTypes[operation?.type];
      if (kind) planned[kind] += 1;
      if (operation?.type === 'pcb.component.modify') {
        planned.componentModify += 1;
        const args = operation.args || {};
        const ref = args.primitiveId ?? args.ref ?? args.designator ?? args.property?.designator ?? null;
        componentRefs.push(ref === null || ref === undefined ? null : String(ref).trim());
      }
    }
    const afterSurface = surfaceSnapshot(afterPcb);
    const readFailed = new Set((Array.isArray(afterPcb?.readErrors) ? afterPcb.readErrors : []).map((item) => String(item?.name ?? '')));
    const missing = [];
    const unverifiable = [];
    const actual = {};
    /**
     * 读回能力闸门：只有写前/写后都拿到 `pcb.outline.read` 的官方信封（{count,items}），
     * 才能断言“回读真的反映了板面”。老桥/测试桩只回裸数组时，无法区分“板上真没有”和“读回没实现”，
     * 此时如实标 `enforced:false` + unverifiable，而不是伪造通过或误杀执行。
     * 真实桥（bridge.mjs `pcb.outline.read`）永远返回信封，因此生产路径上的按类型断言始终生效。
     */
    const readbackAvailable = beforeSurface?.outline?.envelope === true && afterSurface.outline.envelope === true;
    if (!readbackAvailable) unverifiable.push('板面读回不可用（pcb.outline.read 未返回 count/items 信封）：跳过按写入类型核对，不能视为“已验证”');
    for (const kind of ['outline', 'line', 'via', 'pour']) {
      const plannedCount = planned[kind];
      const created = Array.isArray(createdIds[typeOfKind[kind]]) ? createdIds[typeOfKind[kind]] : [];
      const afterCount = afterSurface[kind].count;
      const beforeCount = beforeSurface?.[kind]?.count ?? null;
      const delta = beforeCount === null || afterCount === null ? null : afterCount - beforeCount;
      const createdFound = created.filter((id) => afterSurface[kind].ids.has(String(id))).length;
      let ok;
      if (plannedCount === 0) ok = true;
      else if (readFailed.has(readOfKind[kind]) || afterCount === null) ok = false;
      else if (created.length && createdFound === created.length) ok = true;
      else ok = delta !== null && delta >= plannedCount;
      actual[kind] = { before: beforeCount, after: afterCount, delta, planned: plannedCount, created: created.length, createdFound };
      if (!readbackAvailable) continue;
      if (!ok) {
        missing.push(readFailed.has(readOfKind[kind]) || afterCount === null
          ? `${labelOfKind[kind]}：计划新增 ${plannedCount} 个，但 ${readOfKind[kind]} 回读不可用，无法证明写入生效`
          : `${labelOfKind[kind]}：计划新增 ${plannedCount} 个，回读实际 ${delta !== null && delta >= 0 ? '+' : ''}${delta ?? '未知'}（创建返回 ${created.length} 个 id，其中 ${createdFound} 个在板上找到）`);
      }
    }
    const componentRefSet = componentRefSetOf(afterPcb?.components);
    const missingRefs = [];
    let checkedRefs = 0;
    for (const ref of componentRefs) {
      if (!ref) { unverifiable.push('component.modify 未提供 primitiveId/ref/designator，无法做目标存在性核对'); continue; }
      checkedRefs += 1;
      if (readbackAvailable && !componentRefSet.has(ref) && !componentRefSet.has(ref.toUpperCase())) missingRefs.push(ref);
    }
    actual.componentModify = { planned: planned.componentModify, checked: checkedRefs, missingRefs };
    if (planned.componentModify > 0 && readbackAvailable) {
      if (readFailed.has('components')) missing.push(`器件修改：计划 ${planned.componentModify} 个，但 components 回读不可用，无法证明目标器件存在`);
      else if (missingRefs.length) missing.push(`器件修改：回读中找不到目标器件 ${missingRefs.slice(0, 6).join('、')}${missingRefs.length > 6 ? '…' : ''}（共 ${missingRefs.length} 个）`);
    }
    return { ok: missing.length === 0, enforced: readbackAvailable, planned, actual, missing, unverifiable };
  }
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
    if (operation.type !== 'pcb.drc' || this.drcMode === 'blocking') {
      const args = toEdaOperationArgs(operation);
      return withTimeout(this.bridge.execute(operation.type, args, { allowWrite: true }), this.operationTimeoutMs, 'PCB_OPERATION_TIMEOUT');
    }
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
    return this.approvals.issue({
      planHash: normalized.planHash, targetFingerprint, windowId, steps: stages,
      semanticPlanHash: normalized.plan.semanticPlanHash ?? null, compiledPlanHash: normalized.plan.compiledPlanHash ?? null,
    });
  }
  async execute({ plan, approvalToken, targetFingerprint, windowId }) {
    if (this.writeLocked) throw Object.assign(new Error('PCB安全写锁生效中（上次回滚失败或人工锁定）：请人工核实工程并显式解除写锁后再写入'), { code: 'PCB_WRITE_LOCKED', status: 409, details: { path: this.writeLockPath, safetyLock: this.safetyLock } });
    if (this.running) throw Object.assign(new Error('已有PCB写任务正在执行'), { code: 'PCB_EXECUTION_BUSY', status: 409 });
    const normalized = normalizePcbPlan(plan);
    if (!normalized.ready) throw Object.assign(new Error('PCB计划无效'), { code: 'PCB_PLAN_INCOMPLETE' });
    /**
     * P1-16 持久写锁：跨进程/跨实例的互斥必须先于“一次性批准”获取——
     * 锁冲突就直接拒绝，不能把用户刚签发的批准令牌烧掉（否则重试还要再批准一次）。
     * 正常结束、失败、抛异常都在 finally 释放；进程崩溃留下的锁文件由 stale 规则（>15min 或 pid 不存在）接管。
     */
    const takeover = this.acquireWriteLease({ operation: 'pcb.execute', planHash: normalized.planHash });
    try {
      this.approvals.consume(approvalToken, {
        planHash: normalized.planHash, targetFingerprint, windowId,
        semanticPlanHash: normalized.plan.semanticPlanHash ?? null, compiledPlanHash: normalized.plan.compiledPlanHash ?? null,
      });
      const before = await this.context();
      if (before.targetFingerprint !== targetFingerprint || before.windowId !== windowId) throw Object.assign(new Error('PCB目标已变化，请重新读取并批准'), { code: 'PCB_TARGET_DRIFT', status: 409, phase: 'binding', details: { phase: 'binding', expected: targetFingerprint, actual: before.targetFingerprint, expectedWindowId: windowId, actualWindowId: before.windowId } });
      if (!before.complete) throw Object.assign(new Error(`PCB上下文读取不完整: ${(before.pcb?.readErrors || []).map((item) => item.name).join(', ')}`), { code: 'PCB_CONTEXT_INCOMPLETE', readErrors: before.pcb?.readErrors || [] });
      // 写入前用文档实际层列表核对：缺层必须在这里失败，而不是等内层操作静默不生效。
      const layerCheck = this.verifyDocumentLayers(normalized.plan, before);
      const source = unwrap(await this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true }));
      if (typeof source !== 'string' || !source.length) throw Object.assign(new Error('无法建立非空PCB源码快照'), { code: 'PCB_SNAPSHOT_EMPTY' });
      // P0-4：目标文档绑定。document.current 在 context() 里已经读过，这里固化成本次执行的 uuid。
      const documentUuid = documentUuidOf(before);
      const execution = {
        id: crypto.randomUUID(), state: 'snapshotting', planHash: normalized.planHash,
        semanticPlanHash: normalized.plan.semanticPlanHash ?? null, compiledPlanHash: normalized.plan.compiledPlanHash ?? null,
        targetFingerprint, documentUuid,
        writeLock: { owner: this.owner, pid: process.pid, startedAt: this.writeLease?.startedAt ?? null, path: this.writeLockPath, takeover: takeover ? { reason: takeover.reason, previous: takeover.previous } : null },
        events: [], snapshot: { digest: documentSourceDigest(source), size: source.length }, stageSnapshots: [],
        progress: { completed: 0, total: normalized.plan.operations.length }, layerCheck,
        readback: null, drc: null, verify: null,
        rollbackScope: null, snapshotRestored: null, rollbackFailed: false, rollback: null, rollbackError: null,
      };
      this.executions.set(execution.id, execution);
      this.running = true;
      const event = (stage, status, detail = {}) => execution.events.push({ at: new Date().toISOString(), stage, status, detail });
      event('write-lock', takeover ? 'takeover' : 'acquired', {
        owner: this.owner, pid: process.pid, startedAt: execution.writeLock.startedAt, path: this.writeLockPath,
        takeover: takeover ? { reason: takeover.reason, previousOwner: takeover.previous?.owner ?? null, previousPid: takeover.previous?.pid ?? null, previousStartedAt: takeover.previous?.startedAt ?? null } : null,
      });
      if (!documentUuid) event('document-binding', 'unverified', { reason: 'document.current 未返回 uuid，无法做文档漂移校验' });
      event('snapshot', 'passed', execution.snapshot);
      // P1-4：写前板面快照（lines/vias/pours/outline/components 已由 context() 一次性读取，不额外增加读命令）。
      const beforeSurface = surfaceSnapshot(before.pcb);
      const createdIds = { 'pcb.outline.create': [], 'pcb.line.create': [], 'pcb.via.create': [], 'pcb.pour.create': [] };
      try {
        execution.state = 'executing';
        // 写前基线：计划里既有写入又有官方 DRC 时，先跑一次基线 DRC。
        // 拿不到基线就退回严格模式，并把“没有基线”写进执行记录——绝不假装有基线。
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
          // P0-4：每个阶段开始、每批写入前都确认还停在同一份文档上。
          await this.assertDocumentBinding(execution, 'write', event);
          const stageSource = unwrap(await this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true }));
          if (typeof stageSource !== 'string' || !stageSource.length) throw Object.assign(new Error(`${group.stage}阶段无法建立快照`), { code: 'PCB_STAGE_SNAPSHOT_EMPTY' });
          const stageSnapshot = { stage: group.stage, source: stageSource, digest: documentSourceDigest(stageSource), operationOffset: execution.progress.completed };
          execution.stageSnapshots.push({ stage: group.stage, digest: stageSnapshot.digest, operationOffset: stageSnapshot.operationOffset });
          event(group.stage, 'started', { operationCount: group.operations.length, digest: stageSnapshot.digest });
          try {
            for (let offset = 0; offset < group.operations.length; offset += this.batchSize) {
              await this.assertDocumentBinding(execution, 'write', event);
              const batch = group.operations.slice(offset, offset + this.batchSize);
              for (const operation of batch) {
                const result = await this.runOperation(operation, event);
                const detail = unwrap(result);
                if (operation.type === 'pcb.save' && detail !== true) throw Object.assign(new Error('嘉立创EDA未确认PCB保存成功'), { code: 'PCB_SAVE_FAILED' });
                if (Object.prototype.hasOwnProperty.call(createdIds, operation.type)) {
                  const primitiveId = primitiveIdOf(detail);
                  if (primitiveId) createdIds[operation.type].push(primitiveId);
                }
                const drcMeta = operation.type === 'pcb.drc' && result && typeof result === 'object' && result.jobId ? { jobId: result.jobId, count: result.count, truncated: result.truncated, polls: result.polls, elapsedMs: result.elapsedMs } : null;
                execution.progress.completed += 1;
                event(operation.type, 'passed', { result: detail, ...(drcMeta ? { drc: drcMeta } : {}), progress: { ...execution.progress } });
              }
              event(group.stage, 'heartbeat', { completedInStage: Math.min(offset + batch.length, group.operations.length), operationCount: group.operations.length, progress: { ...execution.progress } });
            }
            if (!group.operations.some((operation) => operation.type === 'pcb.save')) {
              await this.assertDocumentBinding(execution, 'write', event);
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
        // P0-4：回读前再确认一次文档身份；读回来的数据必须属于同一块板。
        await this.assertDocumentBinding(execution, 'readback', event);
        const after = await this.context();
        if (after.windowId !== windowId) throw Object.assign(new Error('PCB执行后目标窗口发生变化'), { code: 'PCB_TARGET_DRIFT', status: 409, phase: 'readback', details: { phase: 'readback', expectedWindowId: windowId, actualWindowId: after.windowId } });
        const afterDocumentUuid = documentUuidOf(after);
        if (documentUuid && afterDocumentUuid !== documentUuid) throw Object.assign(new Error(`PCB执行后目标文档发生变化：预期 ${documentUuid}，实际 ${afterDocumentUuid || '读取失败'}`), { code: 'PCB_TARGET_DRIFT', status: 409, phase: 'readback', details: { phase: 'readback', expected: documentUuid, actual: afterDocumentUuid } });
        const afterSource = unwrap(await this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true }));
        if (typeof afterSource !== 'string' || !afterSource.length) throw Object.assign(new Error('PCB执行后源码回读为空'), { code: 'PCB_READBACK_EMPTY' });
        const outlineValue = after.pcb?.outline;
        execution.readback = { sourceDigest: documentSourceDigest(afterSource), targetFingerprint: after.targetFingerprint, componentCount: after.pcb?.components?.length ?? null, lineCount: after.pcb?.lines?.length ?? null, viaCount: after.pcb?.vias?.length ?? null, pourCount: after.pcb?.pours?.length ?? null, outlineCount: outlineValue?.count ?? null, outlineBoundsMm: outlineValue?.boundsMm ?? null, zoomToBoardOutline: outlineValue?.zoomToBoardOutline ?? null };
        event('readback', 'passed', execution.readback);
        /**
         * P1-4 fail-closed：写入返回 success 不等于真的写进去了（真机见过的静默空转形态）。
         * 按操作类型逐类核对回读 delta；不匹配抛 PCB_WRITE_VERIFY_INCOMPLETE 并走回滚。
         */
        execution.verify = this.verifyWriteEffects({ plan: normalized.plan, beforeSurface, afterPcb: after.pcb, createdIds });
        event('write-verify', execution.verify.enforced ? (execution.verify.ok ? 'passed' : 'failed') : 'unverifiable', { planned: execution.verify.planned, actual: execution.verify.actual, missing: execution.verify.missing, unverifiable: execution.verify.unverifiable });
        if (execution.verify.enforced && !execution.verify.ok) {
          throw Object.assign(new Error(`写后按类型回读核对未通过：${execution.verify.missing.join('；')}`), { code: 'PCB_WRITE_VERIFY_INCOMPLETE', status: 409, details: execution.verify });
        }
        /**
         * P0-2 fail-closed：同步必须“真的把器件落到 PCB”。
         *
         * 真机已知：`pcb.importChanges` 会返回 success 但一个器件都不落板（8→8）。因此：
         *   1) 调用方声明了期望位号（`plan.expectations.designators`）→ 回读必须全部出现，缺一个就失败并回滚；
         *   2) 没声明期望、但计划唯一的写入就是 importChanges，且整份源码/器件数前后完全一致
         *      → 判为 `PCB_SYNC_NO_EFFECT`，绝不把空转当成功。
         * 两种情况都发生在 DRC 之前且抛出异常，走既有回滚路径。
         */
        const expectedDesignators = normalized.plan.expectations?.designators ?? null;
        if (Array.isArray(expectedDesignators) && expectedDesignators.length) {
          const actual = [...new Set((after.pcb?.components || [])
            .map((item) => String(item?.designator ?? item?.ref ?? '').trim().toUpperCase())
            .filter(Boolean))];
          const actualSet = new Set(actual);
          const missingDesignators = expectedDesignators.filter((item) => !actualSet.has(item));
          execution.syncCheck = { expected: expectedDesignators.length, actual: actual.length, missing: missingDesignators, passed: missingDesignators.length === 0 };
          event('sync-check', missingDesignators.length ? 'failed' : 'passed', execution.syncCheck);
          if (missingDesignators.length) {
            throw Object.assign(new Error(`原理图→PCB 同步未生效：PCB 回读仍缺 ${missingDesignators.length} 个器件（${missingDesignators.slice(0, 8).join('、')}${missingDesignators.length > 8 ? '…' : ''}）。拒绝把空转的变更导入当成写板成功`), { code: 'PCB_SYNC_INCOMPLETE', missing: missingDesignators, expected: expectedDesignators.length, actual: actual.length });
          }
        } else if (normalized.plan.operations.some((operation) => operation.type === 'pcb.importChanges')
          && normalized.plan.operations.every((operation) => SYNC_ONLY_OPERATION_TYPES.has(operation.type))
          && execution.readback.sourceDigest === execution.snapshot.digest
          && (before.pcb?.components?.length ?? 0) === (after.pcb?.components?.length ?? 0)) {
          execution.syncCheck = { expected: null, actual: after.pcb?.components?.length ?? 0, missing: null, passed: false, reason: 'no-effect' };
          event('sync-check', 'failed', execution.syncCheck);
          throw Object.assign(new Error('pcb.importChanges 没有改变 PCB 源码或器件数：这是一次空转的"变更导入"，不能当作同步成功'), { code: 'PCB_SYNC_NO_EFFECT' });
        }
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
        event('execution', 'failed', { code: error.code || 'PCB_EXECUTION_FAILED', message: error.message, ...(error.phase ? { phase: error.phase } : {}) });
        execution.state = 'rollback_required';
        // 同步缺件明细/漂移阶段要能传到 UI，而不是只给一句“失败”。
        execution.error = {
          code: error.code || 'PCB_EXECUTION_FAILED',
          message: error.message,
          ...(Array.isArray(error.missing) ? { missing: error.missing } : {}),
          ...(error.expected !== undefined ? { expected: error.expected } : {}),
          ...(error.actual !== undefined ? { actual: error.actual } : {}),
          ...(error.phase ? { phase: error.phase } : {}),
          ...(error.details ? { details: error.details } : {}),
        };
        // P1-6 回滚口径：有阶段快照 → 只恢复到失败阶段开始前（stage），不做“执行前整份快照”的承诺。
        execution.rollbackScope = error.stageSnapshot ? 'stage' : 'all';
        execution.snapshotRestored = false;
        execution.rollbackFailed = false;
        try {
          // P0-4：回滚写的是“当前活动文档”，漂移时写下去就是毁掉另一块板——必须先确认目标未变。
          await this.assertDocumentBinding(execution, 'rollback', event);
          // P0（2026-10-29 真机）：整档恢复前先定向删除本次创建返回的图元；它不能替代整档恢复，
          // 但可以在整档恢复不诚实时尽量把新增铜箔清掉，避免把测试线留在板上。
          execution.rollbackCompensation = await compensateCreatedPrimitives(this.bridge, createdIds, event);
          if (execution.rollbackCompensation.deleted.length) {
            try {
              const cleanupSaved = unwrap(await this.bridge.execute('pcb.save', {}, { allowWrite: true })) === true;
              if (!cleanupSaved) event('rollback-compensation', 'failed', { ...execution.rollbackCompensation, save: false });
            } catch (cleanupError) {
              event('rollback-compensation', 'failed', { ...execution.rollbackCompensation, save: false, error: String(cleanupError?.message || cleanupError) });
            }
          }
          /**
           * P0（2026-10-29 真机回滚失败）：如果本次真正落板的操作全部是“创建图元”，
           * 定向删除 + 板面计数核对本身就是完整回滚，不应该再去赌整档源码恢复。
           * 真机已证明整档 restore 会返回 true 却留下摘要不一致/线段拆分的板子。
           * 只要出现 component.modify/importChanges 等非创建变更，仍必须走整档恢复。
           */
          let targetedRolledBack = false;
          const completedOperations = normalized.plan.operations.slice(0, execution.progress.completed);
          // pcb.save/pcb.drc 不算“改变了图元的写”；只有创建类操作才适合定向删除回滚。
          const completedMutations = completedOperations.filter((operation) => mutatingOperationTypes.has(operation.type) && !['pcb.save', 'pcb.drc'].includes(operation.type));
          const compensation = execution.rollbackCompensation;
          const targetedEligible = completedMutations.length > 0
            && completedMutations.every((operation) => CREATED_PRIMITIVE_DELETE[operation.type])
            && compensation.deleted.length > 0
            && compensation.failed.length === 0
            && compensation.skipped.length === 0;
          if (targetedEligible) {
            try {
              await this.assertDocumentBinding(execution, 'rollback', event);
              const afterRollback = await this.context();
              const afterSurface = surfaceSnapshot(afterRollback.pcb);
              const createdStillPresent = [];
              const kindOfOperation = { 'pcb.line.create': 'line', 'pcb.via.create': 'via', 'pcb.pour.create': 'pour', 'pcb.outline.create': 'outline' };
              for (const [operation, ids] of Object.entries(createdIds)) {
                const kind = kindOfOperation[operation];
                if (!kind) continue;
                for (const id of ids) if (afterSurface[kind]?.ids?.has(String(id))) createdStillPresent.push(String(id));
              }
              const countsMatch = ['line', 'via', 'pour', 'outline'].every((kind) => {
                const beforeCount = beforeSurface?.[kind]?.count ?? null;
                const afterCount = afterSurface?.[kind]?.count ?? null;
                return beforeCount !== null && afterCount !== null && beforeCount === afterCount;
              });
              if (countsMatch && createdStillPresent.length === 0) {
                const retainedStages = error.stageSnapshot ? execution.stageSnapshots.slice(0, -1).map((item) => item.stage) : [];
                execution.state = 'rolled_back';
                execution.snapshotRestored = false;
                execution.rollback = {
                  scope: 'targeted',
                  stage: error.stageSnapshot?.stage || null,
                  retainedStages,
                  digest: null,
                  snapshotRestored: false,
                  compensation,
                  createdStillPresent,
                  // 诚实口径：没有做整档源码恢复；只证明本次创建的图元已删除且板面计数回到写前。
                  message: '已定向删除本次创建图元并核对板面计数；未做整档源码恢复（create-only回滚）',
                };
                event('rollback', 'passed', execution.rollback);
                targetedRolledBack = true;
              } else {
                event('rollback-compensation', 'partial', { ...compensation, targeted: false, createdStillPresent, countsMatch });
              }
            } catch (targetedError) {
              event('rollback-compensation', 'failed', { ...compensation, targeted: false, error: String(targetedError?.message || targetedError) });
            }
          }
          if (!targetedRolledBack) {
          const rollbackSource = error.stageSnapshot?.source || source;
          const rollbackDigest = error.stageSnapshot?.digest || execution.snapshot.digest;
          const restoredResult = unwrap(await this.bridge.execute('document.source.restore', { source: rollbackSource, ...(documentUuid ? { expectedDocumentUuid: documentUuid } : {}) }, { allowWrite: true }));
          if (restoredResult !== true) throw Object.assign(new Error('PCB恢复接口未确认恢复成功（返回非 true）'), { code: 'PCB_ROLLBACK_VERIFY_FAILED' });
          // restore 重建整份文档需要时间：保存前再确认一次文档没被切走，否则会把别人的板保存了。
          await this.assertDocumentBinding(execution, 'rollback', event);
          const saved = unwrap(await this.bridge.execute('pcb.save', {}, { allowWrite: true })) === true;
          const restored = saved ? unwrap(await this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true })) : '';
          if (!saved || typeof restored !== 'string' || documentSourceDigest(restored) !== rollbackDigest) throw Object.assign(new Error('PCB恢复后的源码摘要不匹配'), { code: 'PCB_ROLLBACK_VERIFY_FAILED' });
          const retainedStages = error.stageSnapshot ? execution.stageSnapshots.slice(0, -1).map((item) => item.stage) : [];
          execution.state = 'rolled_back';
          execution.snapshotRestored = true;
          execution.rollback = {
            scope: execution.rollbackScope,
            stage: error.stageSnapshot?.stage || null,
            retainedStages,
            digest: rollbackDigest,
            snapshotRestored: true,
            compensation: execution.rollbackCompensation,
            // 口径：stage 回滚只恢复到该阶段开始前；此前阶段已逐阶段保存并保留，不能声称“已恢复执行前快照”。
            message: error.stageSnapshot
              ? `已回滚到「${error.stageSnapshot.stage}」阶段开始前快照；此前已落盘阶段保留：${retainedStages.length ? retainedStages.join('、') : '无'}`
              : '已恢复执行前快照',
          };
          event('rollback', 'passed', execution.rollback);
          }
        } catch (rollbackError) {
          execution.state = 'rollback_failed';
          execution.snapshotRestored = false;
          execution.rollbackFailed = true;
          execution.rollbackError = { code: rollbackError.code || 'PCB_ROLLBACK_FAILED', message: rollbackError.message, ...(error.stageSnapshot ? { stage: error.stageSnapshot.stage } : {}), compensation: execution.rollbackCompensation ?? null, ...(rollbackError.phase ? { phase: rollbackError.phase } : {}) };
          this.writeLocked = true;
          this.safetyLock = { lockedAt: new Date().toISOString(), executionId: execution.id, code: execution.rollbackError.code, message: execution.rollbackError.message, scope: execution.rollbackScope };
          event('rollback', 'failed', { code: execution.rollbackError.code, message: rollbackError.message, scope: execution.rollbackScope, phase: rollbackError.phase ?? null, snapshotRestored: false, compensation: execution.rollbackCompensation ?? null });
        }
      }
      return execution;
    } finally {
      this.running = false;
      this.releaseWriteLease();
      this.persist();
    }
  }
  get(id) { return this.executions.get(id) || null; }
  evidence(id) { return this.get(id); }
}
