/**
 * EDA 后台任务模型（第 2 版：任务状态的所有权移出渲染进程）
 *
 * 第 1 版把任务登记表放在 EDA 渲染进程的 `globalThis` 里，于是有三个结构性弱点：
 *   1. 渲染进程一重载，在途任务凭空"消失"，上层只能报 `EDA_JOB_LOST`——**不知道它到底跑没跑完**；
 *   2. 取消是空转：EDA 侧的调用本身不可中断，`cancel` 只能改状态；
 *   3. 每次"超时重试"都会在 EDA 里再压一个仍在跑的调用（真机实测：客户端 0.8s 放弃，
 *      EDA 侧副作用在 5.9s 仍然落地 ⇒ 客户端 abort ≠ 服务端取消）。
 *
 * 第 2 版把**状态的所有权**搬到 CircuitPilot 运行时（这一层才是能持久、能收口的地方）：
 *   - `EdaJobStore` 是唯一权威，可选落盘 journal，运行时重启后能恢复并**如实**收口；
 *   - EDA 渲染进程只当 worker，它的 `globalThis` 登记表降级为**快照来源**；
 *   - 用 **epoch**（渲染进程会话标识）区分"还是同一个 worker"与"换了一个 worker"：
 *     epoch 变了 ⇒ 在途任务一律标记 `interrupted`（含义明确："结果不可知"），
 *     绝不退化成 done，更不会退化成 0 项；
 *   - 同类任务做**在途互斥**（`EDA_JOB_BUSY`），从结构上杜绝"遗弃调用堆积"。
 */

export const JOB_REGISTRY_NAME = '__circuitpilotEdaJobs';

/** 渲染进程会话（epoch）标识：随渲染进程重载而变。 */
export const JOB_EPOCH_NAME = '__circuitpilotEdaEpoch';

export const JOB_ITEM_CAP = 2000;

export const JOB_HISTORY_LIMIT = 16;

/**
 * journal 里每条记录最多保留多少条结果明细 / 多少字符。
 *
 * 计数（count）永远精确；明细只留一截并显式标注。**只按条数封顶是不够的**：
 * DRC 的结果只有 3 个分组，但每组长达上百 KB——真机上因此一次写进了 551KB 的 journal。
 * 所以条数与字符数两道闸都要有。
 */
export const JOURNAL_ITEM_CAP = 50;

export const JOURNAL_CHAR_BUDGET = 32_768;

/** 结果封顶：先按条数，再按字符预算，必要时继续砍明细。返回的对象自带“被截断”标注。 */
export function capJournalResult(result) {
  if (!result || typeof result !== 'object') return result ?? null;
  const chars = (value) => { try { return JSON.stringify(value).length; } catch { return Number.POSITIVE_INFINITY; } };
  if (!Array.isArray(result.items)) {
    return chars(result) > JOURNAL_CHAR_BUDGET ? { ...result, value: null, journalTruncated: true, journalFullChars: chars(result) } : result;
  }
  let items = result.items;
  let truncated = items.length > JOURNAL_ITEM_CAP;
  if (truncated) items = items.slice(0, JOURNAL_ITEM_CAP);
  let candidate = { ...result, items };
  if (chars(candidate) > JOURNAL_CHAR_BUDGET) {
    for (const keep of [5, 1, 0]) {
      candidate = { ...result, items: items.slice(0, keep) };
      if (chars(candidate) <= JOURNAL_CHAR_BUDGET) break;
    }
    truncated = true;
  }
  return truncated ? { ...candidate, journalTruncated: true, journalFullChars: chars(result) } : candidate;
}

/** 任务状态机。`interrupted` 是第 2 版新增：明确表达"结果不可知"，与 done/error 并列且不可混淆。 */
export const EDA_JOB_STATES = Object.freeze(['created', 'running', 'done', 'error', 'cancelled', 'interrupted']);

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isJobId(value) {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

export function newJobId(randomUUID) {
  return typeof randomUUID === 'function' ? randomUUID() : globalThis.crypto.randomUUID();
}

/** 注入到 EDA 渲染进程的公共前置代码：epoch + 快照登记表 + 结果归一化。 */
function jobPrelude() {
  return [
    `const EPOCH=globalThis[${JSON.stringify(JOB_EPOCH_NAME)}]||(globalThis[${JSON.stringify(JOB_EPOCH_NAME)}]={id:String(Date.now())+'-'+Math.random().toString(36).slice(2,10),startedAt:Date.now()});`,
    `const REG=globalThis[${JSON.stringify(JOB_REGISTRY_NAME)}]||(globalThis[${JSON.stringify(JOB_REGISTRY_NAME)}]=new Map());`,
    `const CAP=${JOB_ITEM_CAP},KEEP=${JOB_HISTORY_LIMIT};`,
    `const prune=()=>{const done=[...REG.values()].filter(j=>j.state!=='running').sort((a,b)=>(a.finishedAt||0)-(b.finishedAt||0));while(done.length>KEEP){const victim=done.shift();REG.delete(victim.jobId);}};`,
    `const norm=(value)=>{if(typeof value==='undefined')return{kind:'undefined',count:0,items:[],truncated:false};if(Array.isArray(value))return{kind:'array',count:value.length,items:value.slice(0,CAP),truncated:value.length>CAP};let text;try{text=JSON.stringify(value);}catch(error){return{kind:'unserializable',count:0,items:[],truncated:false,note:String(error&&error.message||error)};}if(typeof text==='undefined')return{kind:'undefined',count:0,items:[],truncated:false};if(text.length>200000)return{kind:'value-truncated',count:0,items:[],truncated:true,preview:text.slice(0,2000)};return{kind:'value',count:Array.isArray(value)?value.length:0,items:[],truncated:false,value};};`,
  ].join('');
}

/**
 * 读取渲染进程会话标识（epoch）。这是最便宜的健康探针：
 * 3s 都答不上来就说明渲染进程不正常，此时**不该**再去发一个 110s 的长调用。
 */
export function sessionCode() {
  return `return (function(){${jobPrelude()}return {epoch:EPOCH.id,startedAt:EPOCH.startedAt,jobs:REG.size};})()`;
}

/**
 * 启动一个后台任务：立刻返回 jobId，调用本身不等待结果。
 * @param {{jobId: string, label: string, expression: string}} input expression 必须是受信任的、返回 Promise 的表达式。
 */
export function startJobCode({ jobId, label, expression }) {
  if (!isJobId(jobId)) throw Object.assign(new Error('任务ID必须是UUID'), { code: 'EDA_JOB_ID_INVALID' });
  if (typeof expression !== 'string' || !expression.trim()) throw Object.assign(new Error('任务表达式不能为空'), { code: 'EDA_JOB_EXPRESSION_INVALID' });
  const safeLabel = JSON.stringify(String(label ?? 'eda-job').slice(0, 120));
  const safeId = JSON.stringify(jobId);
  return [
    // 注意：jobPrelude() 返回的是**字符串**，所以这里必须发出 "prune();" 这段文本，
    // 而不是在 Node 侧调用 prune()（曾经写成 prune()，直接 ReferenceError）。
    // 桥接层把生成的源码当作**函数体**执行，所以最外层必须是 return 语句；
    // 只写 (function(){…})() 的话副作用会执行，但返回值被丢弃（真机上表现为 result:null，
    // 后台任务因此被误判成“任务已丢失”）。
    'return (function(){', jobPrelude(), 'prune();',
    `REG.set(${safeId},{jobId:${safeId},label:${safeLabel},state:'running',epoch:EPOCH.id,startedAt:Date.now(),finishedAt:null,result:null,error:null});`,
    `Promise.resolve().then(()=>(${expression})).then(`,
    `(value)=>{const current=REG.get(${safeId})||{};REG.set(${safeId},{...current,state:'done',result:norm(value),finishedAt:Date.now()});prune();},`,
    `(error)=>{const current=REG.get(${safeId})||{};REG.set(${safeId},{...current,state:'error',error:String(error&&error.message||error).slice(0,400),finishedAt:Date.now()});prune();});`,
    `const record=REG.get(${safeId});return {jobId:${safeId},label:record.label,state:record.state,epoch:EPOCH.id,startedAt:record.startedAt,accepted:true};})()`,
  ].join('');
}

export function pollJobCode({ jobId }) {
  if (!isJobId(jobId)) throw Object.assign(new Error('任务ID必须是UUID'), { code: 'EDA_JOB_ID_INVALID' });
  const safeId = JSON.stringify(jobId);
  return `return (function(){${jobPrelude()}const record=REG.get(${safeId});if(!record)return {jobId:${safeId},state:'unknown',known:false,epoch:EPOCH.id};return {jobId:record.jobId,label:record.label,state:record.state,epoch:EPOCH.id,startedAt:record.startedAt,finishedAt:record.finishedAt,error:record.error||null,result:record.result||null,known:true};})()`;
}

export function listJobsCode() {
  return `return (function(){${jobPrelude()}return {epoch:EPOCH.id,jobs:[...REG.values()].map(j=>({jobId:j.jobId,label:j.label,state:j.state,epoch:j.epoch||null,startedAt:j.startedAt,finishedAt:j.finishedAt,error:j.error||null,count:j.result&&j.result.count||0}))};})()`;
}

export function cancelJobCode({ jobId }) {
  if (!isJobId(jobId)) throw Object.assign(new Error('任务ID必须是UUID'), { code: 'EDA_JOB_ID_INVALID' });
  const safeId = JSON.stringify(jobId);
  return `return (function(){${jobPrelude()}const record=REG.get(${safeId});if(!record)return {jobId:${safeId},state:'unknown',cancelled:false,epoch:EPOCH.id};if(record.state==='running'){REG.set(${safeId},{...record,state:'cancelled',finishedAt:Date.now(),error:'cancelled-by-client'});}return {jobId:${safeId},state:(REG.get(${safeId})||{}).state,cancelled:true,epoch:EPOCH.id};})()`;
}

/** 内存 journal（默认；测试与单进程场景用）。 */
export function createMemoryJournal(initial = []) {
  const lines = [...initial];
  return { append: (record) => lines.push({ ...record }), read: () => lines.map((line) => ({ ...line })) };
}

/**
 * 任务状态的**唯一权威**。
 *
 * 放在 CircuitPilot 运行时侧：可持久化、可在客户端/渲染进程/整个进程重启后如实收口。
 * 渲染进程的快照只能**印证**它，不能推翻它——尤其不能把"不知道"说成"完成"。
 */
export class EdaJobStore {
  constructor({ journal = null, now = () => Date.now(), historyLimit = JOB_HISTORY_LIMIT } = {}) {
    this.records = new Map();
    this.journal = journal;
    this.now = now;
    this.historyLimit = historyLimit;
    this.epoch = null;
    this.epochStartedAt = null;
  }

  _write(record) {
    if (!this.journal || typeof this.journal.append !== 'function') return;
    this.journal.append({ ...record, result: capJournalResult(record.result) });
  }

  create({ jobId, label = 'eda-job', kind = 'generic', deadlineMs = null }) {
    if (!isJobId(jobId)) throw Object.assign(new Error('任务ID必须是UUID'), { code: 'EDA_JOB_ID_INVALID' });
    const existing = this.records.get(jobId);
    if (existing) return existing;
    const record = { jobId, label: String(label).slice(0, 120), kind, state: 'created', createdAt: this.now(), dispatchedAt: null, finishedAt: null, epoch: null, attempts: 0, deadlineMs, result: null, error: null };
    this.records.set(jobId, record);
    this._write(record);
    return record;
  }

  dispatched({ jobId, epoch = null, attempt = 1 }) {
    const record = this.records.get(jobId);
    if (!record) throw Object.assign(new Error('任务未在运行时登记'), { code: 'EDA_JOB_NOT_REGISTERED', jobId });
    record.state = 'running';
    record.dispatchedAt = this.now();
    record.epoch = epoch;
    record.attempts = attempt;
    record.error = null;
    this._write(record);
    return record;
  }

  /** 观察 worker 的 epoch：一变，就把所有在途任务如实收口为 interrupted。 */
  observeEpoch(epoch) {
    if (!epoch) return { changed: false, interrupted: [] };
    if (this.epoch === null) {
      this.epoch = epoch;
      return { changed: false, interrupted: [], firstSeen: true };
    }
    if (this.epoch === epoch) return { changed: false, interrupted: [] };
    const previous = this.epoch;
    this.epoch = epoch;
    const interrupted = this.interruptInFlight({ code: 'EDA_RENDERER_RELOADED', message: `EDA 渲染进程会话已更换（${previous} → ${epoch}），在途任务的结果不可知` });
    return { changed: true, interrupted, previousEpoch: previous };
  }

  interruptInFlight(reason) {
    const interrupted = [];
    for (const record of this.records.values()) {
      if (record.state === 'created' || record.state === 'running') {
        record.state = 'interrupted';
        record.finishedAt = this.now();
        record.error = reason;
        this._write(record);
        interrupted.push(record.jobId);
      }
    }
    return interrupted;
  }

  /** 用渲染进程快照印证/推进本地记录。快照永远不能把 interrupted 说成 done。 */
  applySnapshot(snapshot) {
    const record = snapshot && isJobId(snapshot.jobId) ? this.records.get(snapshot.jobId) : null;
    if (!record) return null;
    if (record.state === 'interrupted') return record;
    if (snapshot.state === 'unknown') {
      // EDA 渲染进程**根本不认识**这个任务，而运行时记录里它连一次派发都没有发生过
      // ⇒ 登记之后派发没落地（桥未发现 / 无 EDA 窗口 / 校验失败）。这种占位必须回收：
      // 否则 runningOfKind 会永久认为“同类任务在途”，整条 DRC 验证通道被 EDA_JOB_BUSY 堵死
      // （真机实测：一次 BRIDGE_NOT_FOUND 之后，重启 EDA 也救不回来）。
      if (!record.dispatchedAt && (record.state === 'created' || record.state === 'running')) {
        record.state = 'error';
        record.error = { code: 'EDA_JOB_ABANDONED', message: '派发未落地（EDA 侧不认识该任务），已在运行时侧回收占位' };
        record.finishedAt = this.now();
        this._write(record);
        this.prune();
      }
      return record;
    }
    if (snapshot.state === 'running') record.state = 'running';
    else if (snapshot.state === 'done') {
      record.state = 'done';
      record.result = snapshot.result ?? null;
      record.finishedAt = snapshot.finishedAt ?? this.now();
    } else if (snapshot.state === 'error') {
      record.state = 'error';
      record.error = { code: 'EDA_JOB_FAILED', message: String(snapshot.error ?? '未知错误').slice(0, 400) };
      record.finishedAt = snapshot.finishedAt ?? this.now();
    } else if (snapshot.state === 'cancelled') {
      record.state = 'cancelled';
      record.finishedAt = snapshot.finishedAt ?? this.now();
    }
    this._write(record);
    return record;
  }

  complete({ jobId, result, elapsedMs = null }) {
    const record = this.records.get(jobId);
    if (!record) return null;
    record.state = 'done';
    record.result = result ?? null;
    record.elapsedMs = elapsedMs;
    record.finishedAt = this.now();
    this._write(record);
    this.prune();
    return record;
  }

  fail(jobId, error) {
    const record = this.records.get(jobId);
    if (!record) return null;
    record.state = 'error';
    record.error = typeof error === 'string' ? { code: 'EDA_JOB_FAILED', message: error } : error;
    record.finishedAt = this.now();
    this._write(record);
    this.prune();
    return record;
  }

  cancel(jobId, reason = { code: 'EDA_JOB_CANCELLED', message: '客户端放弃等待' }) {
    const record = this.records.get(jobId);
    if (!record) return null;
    if (record.state === 'created' || record.state === 'running') {
      record.state = 'cancelled';
      record.error = reason;
      record.finishedAt = this.now();
      this._write(record);
    }
    return record;
  }

  /** 同类任务在途互斥：从结构上防止"遗弃调用堆积"。 */
  runningOfKind(kind) {
    for (const record of this.records.values()) {
      if ((record.state === 'created' || record.state === 'running') && (!kind || record.kind === kind)) return record;
    }
    return null;
  }

  prune() {
    const finished = [...this.records.values()].filter((record) => record.state !== 'created' && record.state !== 'running').sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    while (finished.length > this.historyLimit) {
      const victim = finished.shift();
      this.records.delete(victim.jobId);
    }
  }

  get(jobId) {
    return this.records.get(jobId) || null;
  }

  list() {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  snapshot() {
    return { epoch: this.epoch, epochStartedAt: this.epochStartedAt, jobs: this.list() };
  }

  /**
   * 运行时重启后从 journal 恢复。
   * 在途任务一律收口为 `interrupted`（"结果不可知"），已完成的**保留结果**——
   * 重启不能让真相消失，也不能凭空捏造结论。
   */
  static recover({ journal, now = () => Date.now() } = {}) {
    const store = new EdaJobStore({ journal, now });
    const lines = typeof journal?.read === 'function' ? journal.read() : [];
    for (const line of lines) {
      if (!line || !isJobId(line.jobId)) continue;
      store.records.set(line.jobId, { ...line });
    }
    const interrupted = store.interruptInFlight({ code: 'EDA_JOB_INTERRUPTED_BY_RESTART', message: 'CircuitPilot 运行时重启，在途任务的结果不可知' });
    return { store, interrupted };
  }
}

export function normalizeJobSnapshot(raw) {
  const value = raw?.result ?? raw?.data ?? raw;
  if (!value || typeof value !== 'object') return { jobId: null, state: 'unknown', known: false, epoch: null };
  return {
    jobId: value.jobId || null,
    label: value.label || null,
    state: value.state || 'unknown',
    known: value.known !== false,
    epoch: value.epoch || null,
    startedAt: value.startedAt ?? null,
    finishedAt: value.finishedAt ?? null,
    error: value.error ?? null,
    result: value.result ?? null,
  };
}

/**
 * 轮询直到任务结束。
 *
 * 关键约束（三条都不能破）：
 *   1. **绝不把超时当成空结果**：超过 deadline 抛 `EDA_JOB_TIMEOUT`；
 *   2. **绝不把"结果不可知"当成完成**：渲染进程换会话（epoch 变化）抛 `EDA_JOB_INTERRUPTED`；
 *   3. **快照缺失也不等于完成**：抛 `EDA_JOB_LOST`。
 */
export async function waitForEdaJob({ execute, jobId, store = null, deadlineMs = 15 * 60 * 1000, pollIntervalMs = 5_000, onHeartbeat = null, onProgress = null, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() }) {
  const startedAt = now();
  let polls = 0;
  for (;;) {
    const snapshot = normalizeJobSnapshot(await execute('pcb.job.poll', { jobId }));
    polls += 1;
    if (store) {
      const epochInfo = store.observeEpoch(snapshot.epoch);
      store.applySnapshot(snapshot);
      if (epochInfo.changed && epochInfo.interrupted.includes(jobId)) {
        throw Object.assign(new Error('EDA 渲染进程已更换会话，在途任务的结果不可知（不会被当成完成）'), { code: 'EDA_JOB_INTERRUPTED', jobId, polls, previousEpoch: epochInfo.previousEpoch, epoch: snapshot.epoch });
      }
    }
    if (snapshot.state === 'done') {
      if (store) store.complete({ jobId, result: snapshot.result, elapsedMs: now() - startedAt });
      return { ...snapshot, polls, elapsedMs: now() - startedAt };
    }
    if (snapshot.state === 'error') {
      if (store) store.fail(jobId, { code: 'EDA_JOB_FAILED', message: String(snapshot.error || '未知错误') });
      throw Object.assign(new Error(`EDA 后台任务失败: ${snapshot.error || '未知错误'}`), { code: 'EDA_JOB_FAILED', jobId, jobError: snapshot.error, polls });
    }
    if (snapshot.state === 'cancelled') {
      if (store) store.cancel(jobId);
      throw Object.assign(new Error('EDA 后台任务已取消'), { code: 'EDA_JOB_CANCELLED', jobId, polls });
    }
    if (snapshot.state === 'interrupted') {
      // 运行时权威层已经把这条任务收口为"结果不可知"（渲染进程换了会话）。
      // 必须立刻显式抛出：如果放任它继续轮询，最后会报成一个**误导性的**超时。
      throw Object.assign(new Error('EDA 后台任务因渲染进程会话更换而中断，结果不可知'), { code: 'EDA_JOB_INTERRUPTED', jobId, polls, jobError: snapshot.error ?? null });
    }
    if (snapshot.state === 'unknown') {
      const record = store ? store.get(jobId) : null;
      if (record && record.state === 'interrupted') {
        throw Object.assign(new Error('EDA 后台任务在渲染进程会话更换后不可确认，结果不可知'), { code: 'EDA_JOB_INTERRUPTED', jobId, polls, jobError: record.error });
      }
      throw Object.assign(new Error('EDA 后台任务已丢失（渲染进程可能已重载或窗口重连）'), { code: 'EDA_JOB_LOST', jobId, polls });
    }
    const elapsedMs = now() - startedAt;
    if (elapsedMs > deadlineMs) throw Object.assign(new Error(`EDA 后台任务超过 ${Math.round(deadlineMs / 1000)}s 仍未返回（已轮询 ${polls} 次）`), { code: 'EDA_JOB_TIMEOUT', jobId, polls, elapsedMs, deadlineMs });
    if (onHeartbeat) onHeartbeat({ jobId, state: snapshot.state, polls, elapsedMs });
    if (onProgress) onProgress({ jobId, state: snapshot.state, polls, elapsedMs });
    await sleep(pollIntervalMs);
  }
}
