/**
 * T5：BOM 供应商证据富化（fail-closed，不伪造 LCSC/价格/库存数据）。
 *
 * 问题：BOM 里通常只有位号/mpn/lcsc，报价、库存、币种要么没有，要么靠 AI "估计"。
 * 把估计值当真数据比没有数据更危险：报错价、报错库存、错料。本模块只做一件事：
 *   把 BOM 行与**可信证据源**（立创商城/嘉立创导出，或人工核对过的 JSON 证据文件）
 *   做确定性匹配；命中（且新鲜）才给出价格/库存/币种。
 *
 * fail-closed 语义：
 *   - 未命中（BOM_EVIDENCE_MISSING）：price/stock/currency 一律 null，不补造、不估算；
 *   - 歧义（BOM_AMBIGUOUS）：同一 mpn 对应多个 lcsc、lcsc 与 mpn 证据冲突、
 *     同一 partNumber 的证据互相矛盾 → 不猜，主字段 null，列出候选证据；
 *   - 过期（BOM_STALE）：证据存在但过期/无法确认新鲜度（缺 fetchedAt、未来时间）
 *     → 主字段按 unknown 输出，原始值只放进 provenance.observed 供人工核对。
 *
 * 设计边界（本任务）：
 *   - 纯适配器：**不联网**、不自动抓价、不改 server.mjs、不接 UI/放行门；
 *   - 证据必须带 source（可追溯）与 fetchedAt（可判新鲜度），否则拒绝采信；
 *   - 确定性：同一输入（含注入的 now）+ 同一证据集合 → 同一输出，且与证据数组顺序无关。
 */
import { readFile } from 'node:fs/promises';

/** 原因码（对下游 UI/放行门稳定，勿随意改名）。 */
export const BOM_ENRICH_CODES = Object.freeze({
  /** 命中且证据新鲜：price/stock/currency 可用。 */
  MATCH: 'BOM_EVIDENCE_MATCH',
  /** 没有任何可信证据命中：供应商字段保持 unknown（null），不是 0 元。 */
  MISSING: 'BOM_EVIDENCE_MISSING',
  /** 证据存在歧义（同 mpn 多 lcsc / 编号冲突 / 同一快照自相矛盾）：拒绝自动选择。 */
  AMBIGUOUS: 'BOM_AMBIGUOUS',
  /** 证据存在但过期，或新鲜度无法确认：价格/库存不可用于报价/放行。 */
  STALE: 'BOM_STALE',
  /** 调用参数非法（fail-closed：无法核对就不返回"空 = 通过"）。 */
  INPUT_INVALID: 'BOM_ENRICH_INPUT_INVALID',
  /** 证据文件不可读/不是合法 JSON。 */
  EVIDENCE_FILE_INVALID: 'BOM_EVIDENCE_FILE_INVALID',
});

/** 行状态（与原因码一一对应，便于 UI 渲染）。 */
export const BOM_ENRICH_STATUS = Object.freeze({
  MATCHED: 'matched',
  MISSING: 'missing',
  AMBIGUOUS: 'ambiguous',
  STALE: 'stale',
});

/** 供应商报价快照默认有效期：24 小时（与 evidence-freshness 的口径一致）。 */
export const DEFAULT_BOM_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const text = (value) => String(value ?? '').trim();
/** 编号匹配键：去空白 + 大写（C25804 / c25804 视为同一编号；输出仍保留原值）。 */
const identityKey = (value) => text(value).toUpperCase();

function numberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const priceOrNull = (value) => {
  const parsed = numberOrNull(value);
  return parsed != null && parsed >= 0 ? parsed : null;
};

const stockOrNull = (value) => {
  const parsed = numberOrNull(value);
  return parsed != null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const currencyOrNull = (value) => {
  const code = text(value).toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
};

const timestampOrNull = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const isoOrNull = (ms) => (ms == null ? null : new Date(ms).toISOString());

/** 金额只保留 4 位小数，避免浮点长尾进入 JSON（确定性输出的一部分）。 */
const roundMoney = (value) => Number(value.toFixed(4));

function makeError(code, message, details = null) {
  return Object.assign(new Error(message), { code, details });
}

function formatAge(ms) {
  const abs = Math.abs(ms);
  if (abs >= DAY_MS) return `${Math.round(abs / DAY_MS)} 天`;
  if (abs >= HOUR_MS) return `${Math.round(abs / HOUR_MS)} 小时`;
  return `${Math.round(abs / 60_000)} 分钟`;
}

/**
 * 把证据条目归一化 + 校验；不合规条目进入 rejected（不静默丢弃、不猜）。
 * @param {object} raw 原始证据条目
 * @returns {{value?: object, reason?: string}}
 */
function normalizeEvidenceEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: '证据条目不是对象' };
  const source = text(raw.source);
  const partNumber = text(raw.partNumber) || text(raw.lcsc);
  const mpn = text(raw.mpn);
  if (!source) return { reason: '证据缺少 source（无法追溯来源，拒绝采信）' };
  if (!partNumber && !mpn) return { reason: '证据缺少 partNumber/lcsc 与 mpn（无法建立映射）' };
  const fetchedAtMs = timestampOrNull(raw.fetchedAt);
  return {
    value: {
      source,
      partNumber: partNumber || null,
      mpn: mpn || null,
      partKey: identityKey(partNumber),
      mpnKey: identityKey(mpn),
      price: priceOrNull(raw.price),
      stock: stockOrNull(raw.stock),
      currency: currencyOrNull(raw.currency),
      fetchedAtMs,
      fetchedAt: isoOrNull(fetchedAtMs),
    },
  };
}

/**
 * 归一化证据源：接受数组，或 `{entries: [...]}`（`loadBomEvidenceFile()` 的返回值）。
 * 无效条目不会让整份证据失败，但会被如实记入 rejected。
 * @param {Array|{entries?: Array}|null|undefined} input
 * @returns {{entries: object[], rejected: Array<{index: number|null, reason: string, source: string|null, partNumber: string|null, mpn: string|null}>}}
 */
export function normalizeBomEvidence(input) {
  const rawEntries = Array.isArray(input) ? input : Array.isArray(input?.entries) ? input.entries : null;
  if (!rawEntries) {
    return { entries: [], rejected: [{ index: null, reason: '证据源不是数组，也不是 {entries:[...]} 结构（按空证据处理）', source: null, partNumber: null, mpn: null }] };
  }
  const entries = [];
  const rejected = [];
  rawEntries.forEach((raw, index) => {
    const normalized = normalizeEvidenceEntry(raw);
    if (normalized.value) entries.push(normalized.value);
    else {
      rejected.push({
        index,
        reason: normalized.reason,
        source: text(raw?.source) || null,
        partNumber: text(raw?.partNumber) || text(raw?.lcsc) || null,
        mpn: text(raw?.mpn) || null,
      });
    }
  });
  return { entries, rejected };
}

/**
 * 从本地 JSON 证据文件加载（立创商城导出 / 人工证据文件）。
 * **不联网**：只读调用方显式给出的本地文件。
 * @param {string} filePath
 * @returns {Promise<{path: string, entries: object[], rejected: Array}>}
 */
export async function loadBomEvidenceFile(filePath) {
  const path = text(filePath);
  if (!path) throw makeError(BOM_ENRICH_CODES.EVIDENCE_FILE_INVALID, '需要证据文件路径');
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw makeError(BOM_ENRICH_CODES.EVIDENCE_FILE_INVALID, `读取证据文件失败：${error?.message || String(error)}`, { path });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw makeError(BOM_ENRICH_CODES.EVIDENCE_FILE_INVALID, `证据文件不是合法 JSON：${error?.message || String(error)}`, { path });
  }
  const { entries, rejected } = normalizeBomEvidence(parsed);
  return { path, entries, rejected };
}

/** 确定性排序：最新抓取优先；同时间按 source/编号/价格/库存的码位序比较（不用 locale）。 */
function compareEntries(a, b) {
  const aTime = a.fetchedAtMs ?? -Infinity;
  const bTime = b.fetchedAtMs ?? -Infinity;
  if (aTime !== bTime) return bTime - aTime;
  const fields = [
    [a.source, b.source],
    [a.partNumber ?? '', b.partNumber ?? ''],
    [a.mpn ?? '', b.mpn ?? ''],
    [a.price ?? -Infinity, b.price ?? -Infinity],
    [a.stock ?? -Infinity, b.stock ?? -Infinity],
    [a.currency ?? '', b.currency ?? ''],
  ];
  for (const [left, right] of fields) {
    if (left === right) continue;
    return left < right ? -1 : 1;
  }
  return 0;
}

const sortedEntries = (entries) => [...entries].sort(compareEntries);

function candidateList(entries) {
  const seen = new Set();
  const candidates = [];
  for (const entry of sortedEntries(entries)) {
    const key = [entry.source, entry.partKey, entry.mpnKey, entry.fetchedAtMs ?? '', entry.price ?? '', entry.stock ?? '', entry.currency ?? ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      source: entry.source,
      partNumber: entry.partNumber,
      mpn: entry.mpn,
      price: entry.price,
      stock: entry.stock,
      currency: entry.currency,
      fetchedAt: entry.fetchedAt,
    });
  }
  return candidates;
}

const unresolved = (status, reasonCode, note, extra = {}) => ({
  status,
  reasonCode,
  note,
  matchBy: null,
  ageMs: null,
  observed: null,
  candidates: null,
  ...extra,
});

const ambiguous = (note, entries) => unresolved(BOM_ENRICH_STATUS.AMBIGUOUS, BOM_ENRICH_CODES.AMBIGUOUS, note, { candidates: candidateList(entries) });
const missing = (note) => unresolved(BOM_ENRICH_STATUS.MISSING, BOM_ENRICH_CODES.MISSING, note);

/**
 * 在已经确定「同一编号/同一 mpn 的证据组」之后，判定新鲜度与内部一致性。
 * 组内多条 = 同一供应商编号的多次抓取快照 → 最新快照赢（刷新语义），
 * 但同一时间戳却互相矛盾 → 歧义，不挑一个。
 */
function settle(entries, matchBy, row, { now, maxAgeMs }) {
  const mpnKeys = [...new Set(entries.map((entry) => entry.mpnKey).filter(Boolean))];
  if (mpnKeys.length > 1) {
    return ambiguous(`同一供应商编号的证据 mpn 互相矛盾（${mpnKeys.join('/')}）：不自动采信`, entries);
  }
  const rowMpnKey = identityKey(row.mpn);
  if (rowMpnKey && mpnKeys.length === 1 && mpnKeys[0] !== rowMpnKey) {
    return ambiguous(`证据 mpn（${text(entries[0]?.mpn)}）与 BOM mpn（${text(row.mpn)}）不一致：不自动替换`, entries);
  }
  const sorted = sortedEntries(entries);
  const chosen = sorted[0];
  const sameTime = sorted.filter((entry) => entry.fetchedAtMs != null && entry.fetchedAtMs === chosen.fetchedAtMs);
  const contradiction = sameTime.find(
    (entry) => entry.price !== chosen.price || entry.stock !== chosen.stock || entry.currency !== chosen.currency,
  );
  if (contradiction) {
    return ambiguous(`同一抓取时间（${chosen.fetchedAt}）存在价格/库存/币种互相矛盾的证据：不自动采信`, entries);
  }

  const ageMs = chosen.fetchedAtMs == null ? null : now - chosen.fetchedAtMs;
  let stale = false;
  let note;
  if (chosen.fetchedAtMs == null) {
    stale = true;
    note = '证据缺少可解析的 fetchedAt：新鲜度无法确认，按过期处理';
  } else if (ageMs < 0) {
    stale = true;
    note = `证据 fetchedAt（${chosen.fetchedAt}）晚于当前时间：时间不可信，按过期处理`;
  } else if (ageMs > maxAgeMs) {
    stale = true;
    note = `证据已过期：抓取于 ${chosen.fetchedAt}（约 ${formatAge(ageMs)} 前），超过 ${formatAge(maxAgeMs)} 的上限`;
  } else if (matchBy === 'lcsc') {
    note = `命中证据：按立创编号 ${chosen.partNumber} 关联`;
  } else {
    note = `命中证据：按 mpn ${chosen.mpn} 关联`;
  }
  if (!stale) {
    if (!chosen.partNumber) note += '；证据未提供立创编号（不补造 BOM 的 lcsc）';
    if (chosen.price == null) note += '；证据缺少有效价格（unknown，不是 0 元）';
    if (chosen.stock == null) note += '；证据缺少有效库存（unknown，不是 0 件）';
    if (chosen.currency == null && chosen.price != null) note += '；证据缺少币种，不能计入费用合计';
  } else {
    note += '；价格/库存按 unknown 输出，原始值仅记录在 provenance.observed 供人工核对';
  }

  return {
    status: stale ? BOM_ENRICH_STATUS.STALE : BOM_ENRICH_STATUS.MATCHED,
    reasonCode: stale ? BOM_ENRICH_CODES.STALE : BOM_ENRICH_CODES.MATCH,
    note,
    matchBy,
    ageMs,
    observed: { price: chosen.price, stock: chosen.stock, currency: chosen.currency },
    candidates: null,
    chosen,
  };
}

/**
 * 单行匹配（确定性；不修改输入）。
 * 规则：
 *   1. 行有 lcsc 且证据有该 partNumber → 用该组（再校验 mpn/内部一致性/新鲜度）；
 *   2. 否则回落到 mpn：
 *      - 一条都没有 → MISSING；
 *      - 行显式给了 lcsc 但证据只按 mpn 命中别的编号 → AMBIGUOUS（编号冲突，不自动替换）；
 *      - 同一 mpn 对应多个不同 partNumber → AMBIGUOUS（不猜）；
 *      - 唯一 partNumber / 证据未给 partNumber → settle；
 *   3. 行既无 mpn 也无 lcsc → MISSING（无法建立映射）。
 * @param {object} row 归一化后的 BOM 行
 * @param {{byPartNumber: Map, byMpn: Map}} indexes
 * @param {{now: number, maxAgeMs: number}} options
 */
function resolveRow(row, indexes, { now, maxAgeMs }) {
  const lcscKey = identityKey(row.lcsc);
  const mpnKey = identityKey(row.mpn);
  if (!lcscKey && !mpnKey) {
    return missing('BOM 行缺少 mpn/lcsc，无法查询可信证据：供应商字段保持 unknown（不是 0 元）');
  }

  if (lcscKey) {
    const exact = indexes.byPartNumber.get(lcscKey) || [];
    if (exact.length) return settle(exact, 'lcsc', row, { now, maxAgeMs });
  }

  const byMpnEntries = mpnKey ? indexes.byMpn.get(mpnKey) || [] : [];
  if (!byMpnEntries.length) {
    return missing(
      lcscKey
        ? `证据中没有立创编号 ${text(row.lcsc)}${mpnKey ? `，也没有 mpn ${text(row.mpn)}` : ''} 的记录：不补造供应商数据`
        : `证据中没有 mpn ${text(row.mpn)} 的记录：不补造供应商数据`,
    );
  }

  if (lcscKey) {
    const partKeys = [...new Set(byMpnEntries.map((entry) => entry.partKey).filter(Boolean))].sort();
    return ambiguous(
      `BOM 指定立创编号 ${text(row.lcsc)} 在证据中不存在，但 mpn ${text(row.mpn)} 命中${partKeys.length ? `其它编号（${partKeys.join('/')}）` : '未标注立创编号的证据'}：编号冲突，拒绝自动替换`,
      byMpnEntries,
    );
  }

  const partKeys = [...new Set(byMpnEntries.map((entry) => entry.partKey).filter(Boolean))].sort();
  if (partKeys.length > 1) {
    return ambiguous(`同一 mpn（${text(row.mpn)}）对应多个立创编号（${partKeys.join('/')}）：不猜哪一个，需人工确认`, byMpnEntries);
  }
  return settle(byMpnEntries, 'mpn', row, { now, maxAgeMs });
}

function enrichOne(rawRow, index, indexes, options) {
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
    return {
      index,
      designator: null,
      value: null,
      mpn: null,
      lcsc: null,
      quantity: null,
      status: BOM_ENRICH_STATUS.MISSING,
      reasonCode: BOM_ENRICH_CODES.MISSING,
      price: null,
      stock: null,
      currency: null,
      provenance: {
        source: null,
        fetchedAt: null,
        stale: false,
        note: 'BOM 行不是对象：按缺失处理，不补造任何字段',
        matchBy: null,
        partNumber: null,
        mpn: null,
        ageMs: null,
        observed: null,
        candidates: null,
      },
    };
  }

  const quantity = numberOrNull(rawRow.quantity);
  const row = {
    designator: text(rawRow.designator) || null,
    value: text(rawRow.value) || null,
    mpn: text(rawRow.mpn) || null,
    lcsc: text(rawRow.lcsc) || null,
    quantity: quantity != null && quantity >= 0 ? quantity : null,
  };
  const resolved = resolveRow(row, indexes, options);
  const matched = resolved.status === BOM_ENRICH_STATUS.MATCHED;
  const chosen = resolved.chosen || null;

  return {
    index,
    designator: row.designator,
    value: row.value,
    mpn: row.mpn,
    lcsc: row.lcsc,
    quantity: row.quantity,
    status: resolved.status,
    reasonCode: resolved.reasonCode,
    // fail-closed：只有「命中且新鲜」才把证据值放到主字段；过期只进 provenance.observed。
    price: matched && chosen ? chosen.price : null,
    stock: matched && chosen ? chosen.stock : null,
    currency: matched && chosen ? chosen.currency : null,
    provenance: {
      source: chosen ? chosen.source : null,
      fetchedAt: chosen ? chosen.fetchedAt : null,
      stale: resolved.status === BOM_ENRICH_STATUS.STALE,
      note: resolved.note,
      matchBy: resolved.matchBy,
      partNumber: chosen ? chosen.partNumber : null,
      mpn: chosen ? chosen.mpn : null,
      ageMs: resolved.ageMs,
      observed: resolved.observed,
      candidates: resolved.candidates,
    },
  };
}

function summarize(rows) {
  const counts = {
    total: rows.length,
    matched: 0,
    missing: 0,
    stale: 0,
    ambiguous: 0,
    withTrustedPrice: 0,
    unknownPrice: 0,
  };
  for (const row of rows) {
    if (row.status === BOM_ENRICH_STATUS.MATCHED) counts.matched += 1;
    else if (row.status === BOM_ENRICH_STATUS.MISSING) counts.missing += 1;
    else if (row.status === BOM_ENRICH_STATUS.STALE) counts.stale += 1;
    else if (row.status === BOM_ENRICH_STATUS.AMBIGUOUS) counts.ambiguous += 1;
    if (row.price != null && row.currency != null && row.status === BOM_ENRICH_STATUS.MATCHED) counts.withTrustedPrice += 1;
  }
  counts.unknownPrice = counts.total - counts.withTrustedPrice;

  const costRows = rows.filter(
    (row) => row.status === BOM_ENRICH_STATUS.MATCHED && row.price != null && row.currency != null && row.quantity != null,
  );
  const currencies = [...new Set(costRows.map((row) => row.currency))].sort();
  const unknownCostRows = rows.length - costRows.length;
  const totals = {
    /** 只有全部行都有可信价格+币种+数量，才允许把 knownCost 当「总成本」。 */
    costComplete: false,
    /** 有可信价格的行的小计之和；没有任何可信价格时为 null（不是 0）。 */
    knownCost: null,
    currency: null,
    unknownCostRows,
    notes: [],
  };
  if (!rows.length) {
    totals.notes.push('BOM 为空：没有可核对的行，成本保持 unknown（不返回 0）');
  } else if (costRows.length && currencies.length === 1) {
    totals.currency = currencies[0];
    totals.knownCost = roundMoney(costRows.reduce((sum, row) => sum + row.price * row.quantity, 0));
  } else if (currencies.length > 1) {
    totals.notes.push(`证据包含多币种（${currencies.join('/')}）：不做跨币种求和，knownCost 保持 unknown`);
  }
  totals.costComplete = rows.length > 0 && unknownCostRows === 0 && currencies.length === 1;
  if (unknownCostRows > 0) {
    totals.notes.push(
      `有 ${unknownCostRows} 行缺少可信价格/币种/数量：这些行成本为 unknown（不是 0 元），knownCost 只是已知部分，不得当作总成本`,
    );
  } else if (totals.costComplete) {
    totals.notes.push('全部行均有可信且新鲜的证据价格与币种：costComplete=true');
  }
  return { counts, totals };
}

/**
 * 富化 BOM 行：输入 BOM 行 + 可信证据源，输出逐行状态、原因码、provenance 与成本汇总。
 *
 * 纯函数（不读文件、不联网）：`now` 由调用方注入，保证同一输入同一输出。
 * 需要从 JSON 证据文件加载时，先 `await loadBomEvidenceFile(path)` 再传 `evidence`。
 *
 * @param {object} input
 * @param {Array<{designator?:string,value?:string,mpn?:string,lcsc?:string,quantity?:number|string}>} input.rows BOM 行
 * @param {Array<object>|{entries:Array<object>}} [input.evidence] 证据条目（或 loadBomEvidenceFile 的返回值）
 * @param {number} [input.now=Date.now()] 当前时间毫秒戳（注入以保证确定性；测试固定它）
 * @param {number} [input.maxAgeMs=DEFAULT_BOM_EVIDENCE_MAX_AGE_MS] 证据有效期
 * @returns {{schemaVersion:number, kind:string, generatedAt:string, maxAgeMs:number, evidence:object, counts:object, totals:object, rows:object[]}}
 */
export function enrichBomRows({ rows, evidence = [], now = Date.now(), maxAgeMs = DEFAULT_BOM_EVIDENCE_MAX_AGE_MS } = {}) {
  if (!Array.isArray(rows)) {
    throw makeError(BOM_ENRICH_CODES.INPUT_INVALID, 'enrichBomRows 需要 rows 数组（fail-closed：无法读取 BOM 就不返回"空 = 通过"）');
  }
  if (!Number.isFinite(now)) throw makeError(BOM_ENRICH_CODES.INPUT_INVALID, 'now 必须是毫秒时间戳');
  const limit = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0 ? Number(maxAgeMs) : DEFAULT_BOM_EVIDENCE_MAX_AGE_MS;
  const { entries, rejected } = normalizeBomEvidence(evidence);
  const indexes = { byPartNumber: new Map(), byMpn: new Map() };
  for (const entry of entries) {
    if (entry.partKey) {
      if (!indexes.byPartNumber.has(entry.partKey)) indexes.byPartNumber.set(entry.partKey, []);
      indexes.byPartNumber.get(entry.partKey).push(entry);
    }
    if (entry.mpnKey) {
      if (!indexes.byMpn.has(entry.mpnKey)) indexes.byMpn.set(entry.mpnKey, []);
      indexes.byMpn.get(entry.mpnKey).push(entry);
    }
  }

  const enrichedRows = rows.map((row, index) => enrichOne(row, index, indexes, { now, maxAgeMs: limit }));
  const { counts, totals } = summarize(enrichedRows);
  const provided = Array.isArray(evidence) ? evidence.length : Array.isArray(evidence?.entries) ? evidence.entries.length : 0;

  return {
    schemaVersion: 1,
    kind: 'bom-enrichment',
    generatedAt: new Date(now).toISOString(),
    maxAgeMs: limit,
    evidence: {
      provided,
      accepted: entries.length,
      rejected: rejected.length,
      rejectedDetails: rejected,
    },
    counts,
    totals,
    rows: enrichedRows,
  };
}
