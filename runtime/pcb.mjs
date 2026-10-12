import crypto from 'node:crypto';
import { ApprovalStore, digest, documentSourceDigest } from './design.mjs';
import { countCopperLayers, isPlanCopperLayerCount, validateLayerReferences } from './engineering/layers.mjs';
import { validateStackup } from './engineering/stackup.mjs';

export const PCB_API_VERSION = 1;
export const PCB_CAPABILITIES = Object.freeze([
  { id: 'context', status: 'supported', api: 'PCB primitive getAll APIs', production: true },
  { id: 'schematic-sync', status: 'supported', api: 'PCB_Document.importChanges', production: true },
  { id: 'save', status: 'supported', api: 'PCB_Document.save', production: true },
  { id: 'official-drc', status: 'supported', api: 'PCB_Drc.check', production: true },
  { id: 'board-outline', status: 'experimental', api: 'PCB_PrimitiveLine.create', production: false, reason: '官方标记为Beta，不应直接作为生产放行依据' },
  { id: 'component-placement', status: 'experimental', api: 'PCB_PrimitiveComponent.modify', production: false, reason: '官方标记为Beta，需要界面回读和人工复核' },
  { id: 'manual-routing', status: 'experimental', api: 'PCB_PrimitiveLine/PCB_PrimitiveVia', production: false, reason: '官方图元写API为Beta' },
  { id: 'autorouting', status: 'user-assisted', api: 'PCB_Document.autoRouting', production: false, reason: '官方明确禁止在生产环境使用Beta自动布线API' },
  { id: 'copper-pour', status: 'experimental', api: 'PCB_PrimitivePour.create', production: false, reason: '官方图元写API为Beta' },
  { id: 'multi-layer', status: 'experimental', api: 'PCB_Layer.setTheNumberOfCopperLayers', production: false, reason: '官方标记为Beta；执行路径目前只放行 2/4/6/8 层（4 层以上必须有可验证叠层），变更层数后必须人工复核叠层与设计规则' },
  { id: 'inner-layer-routing', status: 'experimental', api: 'PCB_PrimitiveLine/PrimitivePour + 内层铜层编号', production: false, reason: '内层铜层编号自 15 起（3/4 是丝印），必须经 engineering/layers.mjs 换算，禁止裸写层号' },
  { id: 'blind-buried-via', status: 'experimental', api: 'PCB_PrimitiveVia.create(...,designRuleBlindViaName)', production: false, reason: '盲埋孔跨度由板内已存在的设计规则项名定义，不是层号；且 viaType 取值编码（官方类型为 0/1/2 枚举，运行时 JS 已混淆）未经真机核实' },
  { id: '3d-check', status: 'supported', api: 'PCB_ManufactureData.get3DFile', production: false, reason: '只能证明文件可生成，不等同DFM通过' },
  { id: 'bom-export', status: 'experimental', api: 'PCB_ManufactureData.getBomFile', production: false, reason: '官方标记为Beta，导出后必须复核' },
  { id: 'cpl-export', status: 'experimental', api: 'PCB_ManufactureData.getPickAndPlaceFile', production: false, reason: '官方标记为Beta，导出后必须复核' },
  { id: 'gerber-export', status: 'user-assisted', api: 'PCB_ManufactureData.getGerberFile', production: false, reason: '官方明确禁止在生产环境使用该Beta API' },
  { id: 'order-payment', status: 'unavailable', api: null, production: false, reason: '安全策略永久禁止下单和支付' },
]);

const allowedOperationTypes = new Set(['pcb.importChanges','pcb.line.create','pcb.component.modify','pcb.via.create','pcb.pour.create','pcb.save','pcb.drc']);
/** 会改变板子状态的操作；官方DRC必须排在这些操作之后才有放行意义。 */
const mutatingOperationTypes = new Set(['pcb.importChanges','pcb.line.create','pcb.component.modify','pcb.via.create','pcb.pour.create','pcb.save']);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const MAX_OPERATIONS = 2_000;
const BATCH_SIZE = 50;
const OPERATION_TIMEOUT_MS = 30_000;
const operationStage = (operation) => operation.stage || ({ 'pcb.importChanges': 'sync', 'pcb.component.modify': 'placement', 'pcb.line.create': operation.args?.layer === 11 ? 'outline' : 'routing', 'pcb.via.create': 'routing', 'pcb.pour.create': 'copper', 'pcb.save': 'save', 'pcb.drc': 'validation' }[operation.type] || 'mutation');
const withTimeout = (promise, timeoutMs, code) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Object.assign(new Error(`PCB操作超过${timeoutMs}ms`), { code })), timeoutMs); Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }); });

export function normalizePcbPlan(input = {}) {
  const board = {
    widthMm: Number(input.board?.widthMm), heightMm: Number(input.board?.heightMm), layers: Number(input.board?.layers),
    thicknessMm: Number(input.board?.thicknessMm), copperOz: Number(input.board?.copperOz), mountingHoles: Number(input.board?.mountingHoles ?? 0),
  };
  const operations = Array.isArray(input.operations) ? input.operations : [];
  const plan = { apiVersion: PCB_API_VERSION, kind: 'pcb-production-plan', title: String(input.title || 'PCB production plan'), board, constraints: input.constraints || {}, operations, ...(input.stackup ? { stackup: input.stackup } : {}) };
  const missing = [];
  if (![board.widthMm,board.heightMm,board.layers,board.thicknessMm,board.copperOz,board.mountingHoles].every(finite)) missing.push('board');
  // 层数不再写死 2：改为放行 validateStackup 有校验能力的 2/4/6/8。
  // EDA 本身支持到 32 层，但 10 层以上没有叠层证据模型，放行等于让无校验的层数进入生产。
  if (board.widthMm <= 0 || board.heightMm <= 0 || !isPlanCopperLayerCount(board.layers) || board.thicknessMm <= 0 || board.copperOz <= 0 || board.mountingHoles < 0) missing.push('board-rules');
  // 四层以上必须带可验证叠层：没有叠层证据，就无法判定内层角色、参考平面与阻抗，也无法核对铜层编号。
  if (isPlanCopperLayerCount(board.layers) && board.layers > 2) {
    const stackupCheck = validateStackup(input.stackup);
    if (!stackupCheck.ready) missing.push(`stackup:${[...new Set(stackupCheck.findings.map((finding) => finding.code))].join('|')}`);
    else if (countCopperLayers(input.stackup) !== board.layers) missing.push(`stackup-layer-count-mismatch:${countCopperLayers(input.stackup)}!=${board.layers}`);
  }
  // 层号换算陷阱：内层铜层编号从 15 起（3/4 是丝印）。叠层序号绝不能直接当 layer 用。
  for (const violation of validateLayerReferences(board, operations)) {
    missing.push(`${violation.index >= 0 ? `operation-${violation.index}` : 'board'}:${violation.reason}:${violation.layer}`);
  }
  for (const [index, operation] of operations.entries()) if (!allowedOperationTypes.has(operation?.type)) missing.push(`operation-${index}:${operation?.type || 'missing'}`);
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
  const outline = [[0,0,45,0],[45,0,45,30],[45,30,0,30],[0,30,0,0]].map(([startX,startY,endX,endY]) => ({ type: 'pcb.line.create', args: { net: '', layer: 11, startX,startY,endX,endY,lineWidth: 0.2,primitiveLock: true } }));
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
  constructor({ bridge, approvals = new ApprovalStore(), operationTimeoutMs = OPERATION_TIMEOUT_MS, batchSize = BATCH_SIZE }) { this.bridge = bridge; this.approvals = approvals; this.operationTimeoutMs = operationTimeoutMs; this.batchSize = batchSize; this.executions = new Map(); this.running = false; this.writeLocked = false; }
  capabilities() { return { apiVersion: PCB_API_VERSION, edaVersion: '3.2.175', items: PCB_CAPABILITIES }; }
  async context() {
    const document = await this.bridge.execute('document.current');
    const documentValue = unwrap(document);
    if (Number(documentValue?.documentType) !== 3) throw Object.assign(new Error(`当前活动文档不是PCB编辑器（documentType=${documentValue?.documentType ?? 'unknown'}），请先打开PCB文档`), { code: 'PCB_DOCUMENT_REQUIRED', documentType: documentValue?.documentType ?? null });
    const [project, rules, source] = await Promise.all([
      this.bridge.execute('project.current'), this.bridge.execute('pcb.rules.read'), this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true }),
    ]);
    const reads = { layers: 'pcb.layers.read', nets: 'pcb.nets.read', components: 'pcb.components.read', lines: 'pcb.lines.read', vias: 'pcb.vias.read', pours: 'pcb.pours.read', regions: 'pcb.regions.read', texts: 'pcb.texts.read' };
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
    const source = unwrap(await this.bridge.execute('pcb.source.read', {}, { allowSensitiveRead: true }));
    if (typeof source !== 'string' || !source.length) throw Object.assign(new Error('无法建立非空PCB源码快照'), { code: 'PCB_SNAPSHOT_EMPTY' });
    const execution = { id: crypto.randomUUID(), state: 'snapshotting', planHash: normalized.planHash, targetFingerprint, events: [], snapshot: { digest: documentSourceDigest(source), size: source.length }, stageSnapshots: [], progress: { completed: 0, total: normalized.plan.operations.length }, readback: null, drc: null };
    this.executions.set(execution.id, execution);
    this.running = true;
    const event = (stage, status, detail = {}) => execution.events.push({ at: new Date().toISOString(), stage, status, detail });
    event('snapshot', 'passed', execution.snapshot);
    try {
      execution.state = 'executing';
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
              const result = await withTimeout(this.bridge.execute(operation.type, operation.args || {}, { allowWrite: true }), this.operationTimeoutMs, 'PCB_OPERATION_TIMEOUT');
              const detail = unwrap(result);
              if (operation.type === 'pcb.save' && detail !== true) throw Object.assign(new Error('嘉立创EDA未确认PCB保存成功'), { code: 'PCB_SAVE_FAILED' });
              execution.progress.completed += 1;
              event(operation.type, 'passed', { result: detail, progress: { ...execution.progress } });
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
      execution.readback = { sourceDigest: documentSourceDigest(afterSource), targetFingerprint: after.targetFingerprint, componentCount: after.pcb?.components?.length ?? null, lineCount: after.pcb?.lines?.length ?? null, viaCount: after.pcb?.vias?.length ?? null, pourCount: after.pcb?.pours?.length ?? null };
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
      execution.drc = { passed: findings.length === 0, findings };
      if (!execution.drc.passed) throw Object.assign(new Error(`PCB DRC存在${findings.length}项问题`), { code: 'PCB_DRC_FAILED' });
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
    }
    return execution;
  }
  get(id) { return this.executions.get(id) || null; }
  evidence(id) { return this.get(id); }
}
