import crypto from 'node:crypto';

export const DESIGN_API_VERSION = 1;
const REQUIRED_BLOCKS = ['mcu', 'power', 'led', 'button'];

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex'); }

export function canonicalDocumentSource(source) {
  if (typeof source !== 'string') return source;
  return source
    .replace(/"client":"[^"]*"/, '"client":"__VOLATILE__"')
    .replace(/"updateTime":\d+/, '"updateTime":0')
    .replace(/"version":"[^"]*"/, '"version":"__VOLATILE__"');
}

export function documentSourceDigest(source) { return digest(canonicalDocumentSource(source)); }

export function normalizePlan(input = {}) {
  if (input.kind === 'reviewed-netlist') {
    const plan = { apiVersion: DESIGN_API_VERSION, kind: 'reviewed-netlist', title: String(input.title || '已审核项目网络表'), nets: Array.isArray(input.nets) ? input.nets.map(String) : [], operations: Array.isArray(input.operations) ? input.operations : [], assumptions: Array.isArray(input.assumptions) ? input.assumptions.map(String) : [] };
    const missing = [];
    if (!plan.nets.length) missing.push('nets');
    if (!plan.operations.length) missing.push('operations');
    for (const [index, operation] of plan.operations.entries()) {
      if (!['component.create','net.connect'].includes(operation?.type)) missing.push(`unsupported-operation:${operation?.type}`);
      if (operation?.type === 'net.connect' && (!operation.args?.net || !Array.isArray(operation.args?.endpoints) || operation.args.endpoints.length < 2)) missing.push(`net.connect.${index}`);
    }
    return { plan, missing, ready: missing.length === 0, planHash: digest(plan) };
  }
  const blocks = Object.fromEntries(REQUIRED_BLOCKS.map((id) => [id, input.blocks?.[id] || null]));
  const plan = {
    apiVersion: DESIGN_API_VERSION,
    kind: 'simple-control-board',
    title: String(input.title || 'MCU + 电源 + LED + 按键简单控制板'),
    blocks,
    nets: Array.isArray(input.nets) ? [...input.nets].map(String).sort() : [],
    placements: Array.isArray(input.placements) ? input.placements : [],
    operations: Array.isArray(input.operations) ? input.operations : [],
    assumptions: Array.isArray(input.assumptions) ? input.assumptions.map(String) : [],
  };
  const missing = [];
  for (const id of REQUIRED_BLOCKS) {
    const block = blocks[id];
    if (!block) missing.push(`${id}:未提供`);
    else {
      if (!block.libraryUuid) missing.push(`${id}:libraryUuid`);
      if (!block.uuid) missing.push(`${id}:uuid`);
      if (!block.value) missing.push(`${id}:value`);
    }
  }
  if (!plan.nets.length) missing.push('nets');
  if (!plan.operations.length) missing.push('operations');
  const forbidden = plan.operations.find((item) => !['component.create', 'pin.noConnect', 'netFlag.create', 'wire.create'].includes(item?.type));
  if (forbidden) missing.push(`unsupported-operation:${forbidden.type}`);
  return { plan, missing, ready: missing.length === 0, planHash: digest(plan) };
}

export class ApprovalStore {
  constructor({ ttlMs = 5 * 60_000, now = () => Date.now() } = {}) { this.ttlMs = ttlMs; this.now = now; this.tokens = new Map(); }
  issue({ planHash, targetFingerprint, windowId, steps }) {
    if (![planHash, targetFingerprint, windowId].every((item) => typeof item === 'string' && item.length)) throw Object.assign(new Error('审批绑定信息不完整'), { code: 'APPROVAL_INVALID' });
    const token = crypto.randomBytes(32).toString('base64url');
    const record = { planHash, targetFingerprint, windowId, steps: [...steps].sort(), expiresAt: this.now() + this.ttlMs, used: false };
    this.tokens.set(digest(token), record);
    return { token, ...record };
  }
  consume(token, expected) {
    const key = digest(String(token || ''));
    const record = this.tokens.get(key);
    if (!record) throw Object.assign(new Error('批准令牌无效'), { code: 'APPROVAL_INVALID' });
    if (record.used) throw Object.assign(new Error('批准令牌已使用'), { code: 'APPROVAL_REPLAYED' });
    if (record.expiresAt <= this.now()) throw Object.assign(new Error('批准令牌已过期'), { code: 'APPROVAL_EXPIRED' });
    for (const field of ['planHash', 'targetFingerprint', 'windowId']) if (record[field] !== expected[field]) throw Object.assign(new Error(`批准绑定不匹配:${field}`), { code: 'APPROVAL_MISMATCH' });
    record.used = true;
    return { ...record };
  }
  revoke(token) {
    const key = digest(String(token || ''));
    const record = this.tokens.get(key);
    if (!record || record.used) throw Object.assign(new Error('批准令牌无效或已使用'), { code: 'APPROVAL_INVALID' });
    record.used = true; record.cancelled = true;
    return { cancelled: true, planHash: record.planHash, windowId: record.windowId };
  }
}

function unwrap(result) { return result?.result ?? result?.data ?? result; }
function containsPrimitiveId(value, id) {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((item) => containsPrimitiveId(item, id));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsPrimitiveId(item, id));
  return false;
}

function lineSegments(line) {
  const paths = Array.isArray(line?.[0]) ? line : [line];
  const segments = [];
  for (const path of paths) {
    if (!Array.isArray(path)) continue;
    for (let index = 0; index + 3 < path.length; index += 2) {
      const a = `${path[index]},${path[index + 1]}`;
      const b = `${path[index + 2]},${path[index + 3]}`;
      segments.push(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
  }
  return segments;
}

function decodeSegment(segment) {
  const [a, b] = segment.split('|').map((point) => point.split(',').map(Number));
  return { x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
}

function segmentCovered(expectedSegment, actualSegments) {
  const expected = decodeSegment(expectedSegment);
  const horizontal = expected.y1 === expected.y2;
  const vertical = expected.x1 === expected.x2;
  if (!horizontal && !vertical) return actualSegments.has(expectedSegment);
  const start = horizontal ? Math.min(expected.x1, expected.x2) : Math.min(expected.y1, expected.y2);
  const end = horizontal ? Math.max(expected.x1, expected.x2) : Math.max(expected.y1, expected.y2);
  const intervals = [...actualSegments].map(decodeSegment).filter((segment) => horizontal
    ? segment.y1 === expected.y1 && segment.y2 === expected.y1
    : segment.x1 === expected.x1 && segment.x2 === expected.x1)
    .map((segment) => horizontal ? [Math.min(segment.x1, segment.x2), Math.max(segment.x1, segment.x2)] : [Math.min(segment.y1, segment.y2), Math.max(segment.y1, segment.y2)])
    .sort((a, b) => a[0] - b[0]);
  let coveredTo = start;
  for (const [from, to] of intervals) {
    if (to < coveredTo || from > coveredTo) continue;
    coveredTo = Math.max(coveredTo, to);
    if (coveredTo >= end) return true;
  }
  return start === end;
}

export function wireOperationMatches(operation, wires) {
  const expected = lineSegments(operation?.args?.line);
  const actual = new Set((Array.isArray(wires) ? wires : [])
    .filter((wire) => String(wire?.net || '') === String(operation?.args?.net || ''))
    .flatMap((wire) => lineSegments(wire.line)));
  return expected.length > 0 && expected.every((segment) => segmentCovered(segment, actual));
}

export class DesignManager {
  constructor({ bridge, approvals = new ApprovalStore() }) { this.bridge = bridge; this.approvals = approvals; this.executions = new Map(); this.running = false; }
  async context() {
    const [project, document, catalog, componentData, wires, source] = await Promise.all([
      this.bridge.execute('project.current'), this.bridge.execute('document.current'), this.bridge.execute('schematic.catalog'), this.bridge.execute('schematic.components'), this.bridge.execute('schematic.wires'),
      this.bridge.execute('document.source.read', {}, { allowSensitiveRead: true }),
    ]);
    const sourceValue = unwrap(source);
    const model = { apiVersion: DESIGN_API_VERSION, windowId: this.bridge.selectedWindowId, capturedAt: new Date().toISOString(), project: unwrap(project), document: unwrap(document), catalog: unwrap(catalog), components: unwrap(componentData), wires: unwrap(wires), sourceDigest: typeof sourceValue === 'string' ? documentSourceDigest(sourceValue) : null };
    model.targetFingerprint = digest({ windowId: model.windowId, project: model.project, document: model.document, catalog: model.catalog, sourceDigest: model.sourceDigest });
    return model;
  }
  approve({ plan, targetFingerprint, windowId, steps = ['snapshot', 'write', 'save', 'readback', 'drc', 'rollback'] }) {
    const normalized = normalizePlan(plan);
    if (!normalized.ready) throw Object.assign(new Error(`计划信息不完整: ${normalized.missing.join(', ')}`), { code: 'PLAN_INCOMPLETE', missing: normalized.missing });
    return { ...this.approvals.issue({ planHash: normalized.planHash, targetFingerprint, windowId, steps }), planHash: normalized.planHash };
  }
  cancel({ approvalToken }) { return this.approvals.revoke(approvalToken); }
  async probe() {
    const required = ['document.source.read', 'document.source.restore', 'schematic.component.create', 'schematic.pin.noConnect', 'schematic.netFlag.create', 'schematic.wire.create', 'schematic.wire.read', 'schematic.save', 'schematic.drc'];
    const registered = new Set(this.bridge.listCommands().map((item) => item.id));
    const missing = required.filter((id) => !registered.has(id));
    if (missing.length) return { supported: false, missing, sourceSnapshot: false, officialDrc: false, checkedAt: new Date().toISOString() };
    const source = unwrap(await this.bridge.execute('document.source.read', {}, { allowSensitiveRead: true }));
    const drc = unwrap(await this.bridge.execute('schematic.drc'));
    return { supported: typeof source === 'string' && source.length > 0 && Array.isArray(drc), missing: [], sourceSnapshot: typeof source === 'string' && source.length > 0, officialDrc: Array.isArray(drc), drcFindingCount: Array.isArray(drc) ? drc.length : null, checkedAt: new Date().toISOString() };
  }
  async execute({ plan, approvalToken, targetFingerprint, windowId }) {
    if (this.running) throw Object.assign(new Error('已有写任务正在执行'), { code: 'EXECUTION_BUSY' });
    const normalized = normalizePlan(plan);
    if (!normalized.ready) throw Object.assign(new Error('计划信息不完整'), { code: 'PLAN_INCOMPLETE' });
    this.approvals.consume(approvalToken, { planHash: normalized.planHash, targetFingerprint, windowId });
    const live = await this.context();
    if (live.targetFingerprint !== targetFingerprint || live.windowId !== windowId) throw Object.assign(new Error('目标窗口或文档在批准后发生变化'), { code: 'TARGET_DRIFT' });
    const capabilities = await this.probe();
    if (!capabilities.supported) throw Object.assign(new Error('嘉立创EDA写入前能力探测未通过'), { code: 'EDA_CAPABILITY_PROBE_FAILED', capabilities });
    const id = crypto.randomUUID();
    const execution = { id, state: 'snapshotting', planHash: normalized.planHash, targetFingerprint, capabilities, events: [], createdPrimitiveIds: [], createdWireIds: [], noConnectChecks: [], snapshot: null, drc: null };
    this.executions.set(id, execution); this.running = true;
    const event = (stage, status, detail = {}) => execution.events.push({ at: new Date().toISOString(), stage, status, detail });
    let mutated = false;
    try {
      const source = unwrap(await this.bridge.execute('document.source.read', {}, { allowSensitiveRead: true }));
      if (typeof source !== 'string' || !source.length) throw Object.assign(new Error('无法建立非空文档源码快照'), { code: 'SNAPSHOT_EMPTY' });
      execution.snapshot = { id: crypto.randomUUID(), digest: documentSourceDigest(source), size: source.length, source };
      event('snapshot', 'passed', { id: execution.snapshot.id, digest: execution.snapshot.digest, size: execution.snapshot.size });
      execution.state = 'executing';
      const componentPrimitiveIdsByOperationIndex = new Map();
      const realizedWireOperations = [];
      for (const [operationIndex, operation] of normalized.plan.operations.entries()) {
        const mapping = { 'component.create': 'schematic.component.create', 'pin.noConnect': 'schematic.pin.noConnect', 'netFlag.create': 'schematic.netFlag.create', 'wire.create': 'schematic.wire.create' };
        let commandArgs = operation.args;
        if (operation.type === 'net.connect') {
          const componentData = unwrap(await this.bridge.execute('schematic.components')) || {};
          const pinsByComponent = componentData.pins || {};
          const points = operation.args.endpoints.map((endpoint) => {
            const primitiveId = componentPrimitiveIdsByOperationIndex.get(endpoint.componentOperationIndex);
            const pin = (pinsByComponent[primitiveId] || []).find((item) => String(item.pinNumber ?? item.number ?? '') === String(endpoint.pinNumber));
            const x = Number(pin?.x ?? pin?.position?.x ?? pin?.getState_X?.()); const y = Number(pin?.y ?? pin?.position?.y ?? pin?.getState_Y?.());
            if (!primitiveId || !Number.isFinite(x) || !Number.isFinite(y)) throw Object.assign(new Error(`无法解析网络${operation.args.net}的引脚${endpoint.pinNumber}`), { code: 'NET_PIN_RESOLUTION_FAILED' });
            return { x, y };
          });
          for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
            const start = points[0]; const end = points[pointIndex];
            const wireOperation = { type: 'wire.create', args: { net: operation.args.net, line: [start.x, start.y, end.x, start.y, end.x, end.y] } };
            const wireResult = unwrap(await this.bridge.execute('schematic.wire.create', wireOperation.args, { allowWrite: true }));
            mutated = true; realizedWireOperations.push(wireOperation);
            const wireId = wireResult?.primitiveId || wireResult?.id; if (wireId) { execution.createdPrimitiveIds.push(wireId); execution.createdWireIds.push(wireId); }
          }
          event(operation.type, 'passed', { net: operation.args.net, segments: points.length - 1 });
          continue;
        }
        if (operation.type === 'pin.noConnect') {
          const componentPrimitiveId = componentPrimitiveIdsByOperationIndex.get(operation.args?.componentOperationIndex);
          if (!componentPrimitiveId) throw Object.assign(new Error('未连接标识引用了无效的元件操作'), { code: 'PIN_COMPONENT_REFERENCE_INVALID' });
          commandArgs = { componentPrimitiveId, pinNumbers: operation.args.pinNumbers };
        }
        const result = unwrap(await this.bridge.execute(mapping[operation.type], commandArgs, { allowWrite: true }));
        mutated = true;
        const primitiveId = result?.primitiveId || result?.id;
        if (primitiveId) execution.createdPrimitiveIds.push(primitiveId);
        if (primitiveId && operation.type === 'component.create') componentPrimitiveIdsByOperationIndex.set(operationIndex, primitiveId);
        if (primitiveId && operation.type === 'wire.create') execution.createdWireIds.push(primitiveId);
        if (operation.type === 'pin.noConnect') {
          const expectedPins = [...operation.args.pinNumbers].map(String).sort();
          const actualPins = [...(result?.pinNumbers || [])].map(String).sort();
          if (stableStringify(expectedPins) !== stableStringify(actualPins)) throw Object.assign(new Error('未连接标识未覆盖全部批准引脚'), { code: 'PIN_NO_CONNECT_INCOMPLETE' });
          execution.noConnectChecks.push({ componentPrimitiveId: commandArgs.componentPrimitiveId, pinNumbers: expectedPins });
        }
        event(operation.type, 'passed', { primitiveId: primitiveId || null });
      }
      const saved = unwrap(await this.bridge.execute('schematic.save', {}, { allowWrite: true }));
      if (saved !== true) throw Object.assign(new Error('嘉立创EDA未确认保存成功'), { code: 'SAVE_FAILED' });
      event('save', 'passed');
      execution.state = 'reading';
      const after = await this.context();
      const afterSource = unwrap(await this.bridge.execute('document.source.read', {}, { allowSensitiveRead: true }));
      if (documentSourceDigest(afterSource) === execution.snapshot.digest) throw Object.assign(new Error('保存后设计内容未发生预期变化'), { code: 'READBACK_UNCHANGED' });
      const uniqueWireIds = [...new Set(execution.createdWireIds)];
      const wireReadback = uniqueWireIds.length ? unwrap(await this.bridge.execute('schematic.wire.read', { primitiveIds: uniqueWireIds })) : [];
      if (uniqueWireIds.length) await new Promise((resolve) => setTimeout(resolve, 800));
      const refreshedWires = uniqueWireIds.length ? unwrap(await this.bridge.execute('schematic.wires')) : [];
      const wireIdSet = new Set(uniqueWireIds);
      const absentIds = execution.createdPrimitiveIds.filter((primitiveId) => !wireIdSet.has(primitiveId) && !containsPrimitiveId(after.components, primitiveId));
      if (absentIds.length) throw Object.assign(new Error(`回读缺少新建对象: ${absentIds.join(',')}`), { code: 'READBACK_PRIMITIVE_MISSING' });
      const pinsByComponent = after.components?.pins || {};
      const missingNoConnect = execution.noConnectChecks.flatMap((check) => check.pinNumbers.filter((number) => !(pinsByComponent[check.componentPrimitiveId] || []).some((pin) => String(pin.pinNumber) === number && (pin.noConnected === true || pin.getState_NoConnected?.() === true))).map((number) => `${check.componentPrimitiveId}:${number}`));
      if (missingNoConnect.length) throw Object.assign(new Error(`回读缺少未连接标识: ${missingNoConnect.join(',')}`), { code: 'READBACK_NO_CONNECT_MISSING' });
      const wireOperations = [...normalized.plan.operations.filter((operation) => operation.type === 'wire.create'), ...realizedWireOperations];
      const missingWireOperations = wireOperations.map((operation, index) => ({ operation, index })).filter(({ operation }) => !wireOperationMatches(operation, refreshedWires)).map(({ index }) => index);
      if (missingWireOperations.length) throw Object.assign(new Error(`回读缺少导线操作: ${missingWireOperations.join(',')}`), { code: 'READBACK_WIRE_GEOMETRY_MISSING' });
      event('readback', 'passed', { targetFingerprint: after.targetFingerprint, sourceDigest: documentSourceDigest(afterSource), verifiedPrimitiveIds: execution.createdPrimitiveIds, verifiedWireIds: uniqueWireIds.filter((primitiveId) => containsPrimitiveId(wireReadback, primitiveId)), verifiedWireOperations: wireOperations.length, verifiedNoConnectPins: execution.noConnectChecks.reduce((sum, item) => sum + item.pinNumbers.length, 0) });
      execution.state = 'verifying';
      const drc = unwrap(await this.bridge.execute('schematic.drc'));
      if (!Array.isArray(drc)) throw Object.assign(new Error('官方原理图DRC返回结构未知'), { code: 'DRC_UNKNOWN_RESULT' });
      execution.drc = { passed: drc.length === 0, findings: drc };
      event('drc', execution.drc.passed ? 'passed' : 'failed', { count: drc.length });
      if (!execution.drc.passed) {
        try { await this.bridge.execute('schematic.drc.ui'); event('drc.ui', 'passed', { opened: true }); }
        catch (uiError) { event('drc.ui', 'failed', { code: uiError.code || 'DRC_UI_FAILED', message: uiError.message }); }
        throw Object.assign(new Error(`原理图DRC发现${drc.length}项问题`), { code: 'DRC_FAILED' });
      }
      execution.state = 'completed';
    } catch (error) {
      event('execution', 'failed', { code: error.code || 'EXECUTION_FAILED', message: error.message });
      if (mutated && execution.snapshot) {
        try {
          execution.state = 'rollback_required';
          const restored = unwrap(await this.bridge.execute('document.source.restore', { source: execution.snapshot.source }, { allowWrite: true }));
          const saved = restored === true && unwrap(await this.bridge.execute('schematic.save', {}, { allowWrite: true })) === true;
          const restoredSource = saved ? unwrap(await this.bridge.execute('document.source.read', {}, { allowSensitiveRead: true })) : '';
          if (!saved || documentSourceDigest(restoredSource) !== execution.snapshot.digest) throw Object.assign(new Error('恢复后的规范化设计摘要不匹配'), { code: 'ROLLBACK_VERIFY_FAILED' });
          execution.state = 'rolled_back'; event('rollback', 'passed', { digest: execution.snapshot.digest });
        } catch (rollbackError) { execution.state = 'rollback_failed'; event('rollback', 'failed', { code: rollbackError.code || 'ROLLBACK_FAILED', message: rollbackError.message }); }
      } else execution.state = 'failed';
      execution.error = { code: error.code || 'EXECUTION_FAILED', message: error.message };
    } finally { if (execution.snapshot) delete execution.snapshot.source; this.running = false; }
    return execution;
  }
  get(id) { return this.executions.get(id) || null; }
  evidence(id) { const item = this.get(id); return item ? { ...item, snapshot: item.snapshot ? { id: item.snapshot.id, digest: item.snapshot.digest, size: item.snapshot.size } : null } : null; }
}
