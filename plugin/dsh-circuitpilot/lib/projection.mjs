/**
 * 结果投影 / 裁剪。
 *
 * 契约（docs/agent/agent-contract.md §5）：
 *   { ok, summary, data, evidence, nextActions, truncated }
 * 大 JSON（DRC/ERC 原始报告）不进模型上下文；这里只做"通用兜底"：
 * 任何工具结果在返回前都过 capResult，超过 maxResultBytes（默认 16KB）就
 * 逐级压缩 data，并把 truncated 置为 true，绝不悄悄截断却不标记。
 */

export const DEFAULT_MAX_RESULT_BYTES = 16384;

/** 结果最小可用上限：再小连 code/message 都放不下，直接按默认值处理。 */
const MIN_RESULT_BYTES = 512;

/**
 * 安全的 JSON 字符串化：循环引用/函数/BigInt 不应该让工具直接崩。
 * 这里只用于估算大小，不用于返回给模型。
 */
export function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (typeof item === 'function') return undefined;
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
  } catch {
    try {
      return JSON.stringify(String(value));
    } catch {
      return '""';
    }
  }
}

/** JSON 序列化后的字节数（UTF-8）。无法序列化时返回 Infinity，交给调用方走兜底。 */
export function jsonByteLength(value) {
  const text = safeStringify(value);
  return typeof text === 'string' ? Buffer.byteLength(text) : Infinity;
}

/** 构造成功结果（未裁剪）。 */
export function okResult(summary, { data = {}, evidence = [], nextActions = [] } = {}) {
  return {
    ok: true,
    summary: typeof summary === 'string' ? summary : String(summary ?? ''),
    data,
    evidence: Array.isArray(evidence) ? [...evidence] : [],
    nextActions: Array.isArray(nextActions) ? nextActions.map(String) : [],
    truncated: false,
  };
}

/** 构造失败结果（未裁剪）。错误统一 { ok:false, code, message, nextActions }。 */
export function failResult(code, message, { data = null, evidence = [], nextActions = [] } = {}) {
  return {
    ok: false,
    code: typeof code === 'string' && code ? code : 'TOOL_ERROR',
    message: typeof message === 'string' && message ? message : '未知错误',
    data,
    evidence: Array.isArray(evidence) ? [...evidence] : [],
    nextActions: Array.isArray(nextActions) ? nextActions.map(String) : [],
    truncated: false,
  };
}

/** 统一证据引用结构：{kind, ref, digest}。ref 可以是证据文件路径或可回查的 API 路径。 */
export function evidenceRef(kind, ref, digest = null) {
  const cleanRef = typeof ref === 'string' ? ref : ref == null ? '' : safeStringify(ref);
  return {
    kind: String(kind || 'evidence').slice(0, 80),
    ref: cleanRef.slice(0, 512),
    digest: digest == null || digest === '' ? null : String(digest).slice(0, 128),
  };
}

function trimEvidence(evidence, limit = 20) {
  const list = Array.isArray(evidence) ? evidence : [];
  return list.slice(0, limit).map((item) => {
    if (!item || typeof item !== 'object') return evidenceRef('evidence', String(item));
    return evidenceRef(item.kind, item.ref, item.digest);
  });
}

function trimList(list, limit) {
  return (Array.isArray(list) ? list : []).slice(0, limit).map((item) => String(item).slice(0, 400));
}

/**
 * 递归压缩：先丢深度、截长字符串、截长数组/多键对象，尽量保留结构可读性。
 * 这是第一级裁剪；还不够就整体退化成 preview。
 */
export function compactValue(value, options = {}, depth = 0) {
  const {
    maxDepth = 5,
    maxArray = 30,
    maxString = 600,
    maxKeys = 60,
  } = options;
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= maxDepth) {
    if (Array.isArray(value)) return `[array:${value.length}]`;
    return `[object:${Object.keys(value).length} keys]`;
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, maxArray).map((item) => compactValue(item, options, depth + 1));
    if (value.length > maxArray) out.push(`…(+${value.length - maxArray} 项)`);
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, maxKeys)) {
      const compacted = compactValue(value[key], options, depth + 1);
      if (compacted !== undefined) out[key] = compacted;
    }
    if (keys.length > maxKeys) out._omittedKeys = keys.length - maxKeys;
    return out;
  }
  return safeStringify(value);
}

/**
 * 把任意工具结果裁剪到 maxBytes 以内，并保证 JSON 可序列化。
 *
 * 优先级：summary / evidence 引用 / nextActions 比 data 重要；data 压缩后仍超限时
 * 退化成 preview，并保留 truncated=true。evidence 永远保留引用（下钻入口），
 * 但条目数与单条长度有限制。
 */
export function capResult(result, maxBytes = DEFAULT_MAX_RESULT_BYTES) {
  const limit = Number.isFinite(maxBytes) && maxBytes >= MIN_RESULT_BYTES
    ? Math.floor(maxBytes)
    : DEFAULT_MAX_RESULT_BYTES;
  const base = result && typeof result === 'object' && !Array.isArray(result)
    ? result
    : { ok: true, summary: String(result ?? ''), data: {}, evidence: [], nextActions: [], truncated: false };

  if (jsonByteLength(base) <= limit) {
    return { ...base, truncated: Boolean(base.truncated) };
  }

  const compacted = {
    ...base,
    truncated: true,
    evidence: trimEvidence(base.evidence),
    nextActions: trimList(base.nextActions, 8),
    data: compactValue(base.data),
  };
  if (jsonByteLength(compacted) <= limit) return compacted;

  const source = safeStringify(base.data);
  const previewFor = (maxChars) => {
    const size = Math.max(256, Math.min(maxChars, 4096));
    return source.length > size ? `${source.slice(0, size)}…` : source;
  };
  const degraded = {
    ...compacted,
    data: { _truncated: true, bytes: source.length, preview: previewFor(Math.max(512, Math.floor(limit / 4))) },
  };
  if (jsonByteLength(degraded) <= limit) return degraded;

  const shape = (evidenceLimit, refLimit, actionLimit, previewBytes) => ({
    ...degraded,
    evidence: trimEvidence(base.evidence, evidenceLimit).map((item) => ({ ...item, ref: item.ref.slice(0, refLimit) })),
    nextActions: trimList(base.nextActions, actionLimit).map((item) => item.slice(0, 160)),
    data: { _truncated: true, bytes: source.length, preview: previewFor(previewBytes) },
  });
  for (const [evidenceLimit, refLimit, actionLimit, previewBytes] of [[8, 256, 6, 1024], [4, 128, 4, 512], [2, 64, 3, 256]]) {
    const shaped = shape(evidenceLimit, refLimit, actionLimit, previewBytes);
    if (jsonByteLength(shaped) <= limit) return shaped;
  }

  // summary 本身可能含大段 plan 摘要：逐步减半直到放得下（保留 evidence 下钻入口）。
  const core = shape(2, 64, 2, 128);
  let summary = String(base.summary ?? '');
  while (summary.length > 0 && jsonByteLength({ ...core, summary }) > limit) {
    summary = summary.slice(0, Math.floor(summary.length / 2));
  }
  if (jsonByteLength({ ...core, summary }) <= limit) return { ...core, summary };

  // 最后兜底：只保留错误/摘要骨架。理论上到不了这里（MIN_RESULT_BYTES=512）。
  return {
    ok: Boolean(base.ok),
    ...(base.ok ? { summary: String(base.summary ?? '').slice(0, 80) } : {
      code: String(base.code ?? 'TOOL_ERROR').slice(0, 80),
      message: String(base.message ?? '').slice(0, 160),
    }),
    data: null,
    evidence: trimEvidence(base.evidence, 1).map((item) => ({ ...item, ref: item.ref.slice(0, 64) })),
    nextActions: trimList(base.nextActions, 1).map((item) => item.slice(0, 64)),
    truncated: true,
  };
}
