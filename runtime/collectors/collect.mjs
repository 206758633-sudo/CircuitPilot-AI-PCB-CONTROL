/**
 * 知识采集器框架（W3-04）。
 *
 * 每个采集器是一个“外部知识源 → 结构化条目 + 证据”的小适配器：
 *   - 统一 `defineCollector({id, kind, source, run})` 接口；
 *   - `runCollector` 负责超时与失败隔离：单个源挂掉不影响其它源，失败返回原因码而不是抛栈；
 *   - `collectAll` 汇总各源结果，供知识库入库（candidate）与证据落盘。
 *
 * 边界：采集器只读取、只产出候选条目；写入知识库必须经过 store 校验并保持 candidate。
 */

export const COLLECTOR_CODES = Object.freeze({
  INVALID: 'COLLECTOR_INVALID',
  TIMEOUT: 'COLLECTOR_TIMEOUT',
  FAILED: 'COLLECTOR_FAILED',
});

const invalid = (message, details = null) => Object.assign(new Error(message), { code: COLLECTOR_CODES.INVALID, details });

/** 定义一个采集器（不可变），返回的统一形状供 collectAll/ingest 使用。 */
export function defineCollector({ id, kind, source, run } = {}) {
  if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) throw invalid('采集器 id 必须是小写连字符标识');
  if (!kind || typeof kind !== 'string') throw invalid('采集器 kind 必填');
  if (!source || typeof source !== 'string') throw invalid('采集器 source 必填');
  if (typeof run !== 'function') throw invalid('采集器 run 必须是函数');
  return Object.freeze({ id, kind, source, run });
}

/** 执行单个采集器；超时/异常都变成结构化失败，绝不把“没抓到”当“没有知识”。 */
export async function runCollector(collector, { timeoutMs = 15_000 } = {}) {
  if (!collector || typeof collector.run !== 'function') throw invalid('需要传入 defineCollector 定义的采集器');
  const startedMs = Date.now();
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`采集超时（>${timeoutMs}ms）`), { code: COLLECTOR_CODES.TIMEOUT })), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => collector.run({ timeoutMs })), timeout]);
    const items = Array.isArray(value?.items) ? value.items : [];
    return { ok: true, collector: { id: collector.id, kind: collector.kind, source: collector.source }, items, evidence: value?.evidence ?? null, elapsedMs: Date.now() - startedMs };
  } catch (error) {
    return { ok: false, collector: { id: collector.id, kind: collector.kind, source: collector.source }, code: error?.code || COLLECTOR_CODES.FAILED, message: String(error?.message || error).slice(0, 300), elapsedMs: Date.now() - startedMs };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 并发执行多个采集器（失败隔离），返回统一汇总。 */
export async function collectAll({ collectors = [], timeoutMs = 15_000 } = {}) {
  const results = await Promise.all(collectors.map((collector) => runCollector(collector, { timeoutMs })));
  return {
    total: results.length,
    ok: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    itemCount: results.reduce((sum, result) => sum + (result.items?.length ?? 0), 0),
    results,
  };
}

/** 把采集条目写入知识库（统一 candidate，绝不直接 approved）。 */
export function ingestCollectorItems({ store, result } = {}) {
  if (!store || typeof store.save !== 'function') throw invalid('ingest 需要知识库 store');
  if (!result || result.ok !== true) throw invalid('只能 ingest 成功采集的结果');
  const entries = [];
  for (const item of result.items ?? []) {
    if (!item || typeof item !== 'object') continue;
    const saved = store.save({
      kind: item.kind,
      title: item.title,
      payload: item.payload && typeof item.payload === 'object' ? item.payload : { value: item.payload },
      provenance: item.provenance && typeof item.provenance === 'object' ? item.provenance : { source: result.collector.source },
      trust: item.trust && ['authoritative', 'reference', 'unverified'].includes(item.trust) ? item.trust : 'unverified',
      ttlDays: item.ttlDays ?? null,
      reviewState: 'candidate',
    });
    entries.push({ id: saved.entry.id, created: saved.created, kind: saved.entry.kind });
  }
  return { collector: result.collector, count: entries.length, entries };
}
