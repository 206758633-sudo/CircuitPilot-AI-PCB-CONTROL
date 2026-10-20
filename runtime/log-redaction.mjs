/**
 * C8：日志脱敏（把"会被写进日志/审计/错误上报的内容"先擦干净）。
 *
 * ## 为什么需要它
 *
 * 运行时会把请求体、聊天消息、工具参数、异常堆栈、第三方接口响应写进日志与磁盘
 * （`runtime/logger.mjs`、`~/.circuitpilot/**`、证据 JSON 等）。这些内容里经常混着：
 *
 * - `authorization: Bearer ...`、`apiKey`、`password`、`cookie` 等**结构性密钥字段**；
 * - 字符串里的 `sk-...`、JWT、URL query 里的 `?token=...` 等**自由文本密钥**；
 * - 用户邮箱、本机绝对路径（`/Users/<用户名>/...`、`C:\Users\<用户名>\...`）等**身份信息**。
 *
 * `logger.mjs` 里有一个极简版 `redact`，只处理密钥字段名和少数 token 形态，且不处理循环引用。
 * 本模块是 C8 的完整实现：**保持数据结构**（对象还是对象、数组还是数组）、
 * **长字符串截断**、**循环引用不崩溃**，并且对拿不准的内容选择"多擦"而不是"漏擦"。
 *
 * ## 设计约束
 *
 * - 纯函数、零副作用、不读写磁盘；同一份输入永远得到同一份输出（便于测试与审计）；
 * - 不抛异常给调用方（除 options 本身非法）：日志脱敏失败不应该让业务请求失败；
 *   遇到 Proxy 抛错的 getter、BigInt、Date、Error、Buffer、Map/Set 都降级成安全表示；
 * - 截断标记里带原始长度，避免"以为看到全部"；
 * - 本机路径按"身份片段"擦除（`/Users/<user>` → `/Users/[REDACTED_USER]`），
 *   保留尾部目录用于排障，但用户名/卷名/主机名不会泄漏。
 */

/** 结构性命名字段被整体替换成这个标记。 */
export const REDACTED = '[REDACTED]';
/** 被替换掉的用户/主机身份片段（路径前缀）。 */
export const REDACTED_USER = '[REDACTED_USER]';
export const REDACTED_VOLUME = '[REDACTED_VOLUME]';
export const REDACTED_HOST = '[REDACTED_HOST]';
export const REDACTED_EMAIL = '[REDACTED_EMAIL]';

export const DEFAULT_MAX_STRING_LENGTH = 512;
export const DEFAULT_MAX_DEPTH = 8;

export const LOG_REDACTION_CODES = Object.freeze({
  OPTIONS_INVALID: 'LOG_REDACTION_OPTIONS_INVALID',
});

/**
 * 字段名命中即整值脱敏。规则刻意宽：
 * `accessToken` / `refresh_token` / `clientSecret` / `dbPassword` / `x-api-key` 都会命中；
 * 代价是 `tokenCount` 这类字段也会被擦掉——日志少一个数字比泄漏一个 token 便宜得多。
 */
const SECRET_KEY_PATTERN = /(?:authorization|cookie|api[-_]?key|apikey|access[-_]?key|secret|password|passwd|pwd|token|credential|passphrase|private[-_]?key|session[-_]?id)/i;

/**
 * 自由文本里的密钥形态。顺序有讲究：
 * 先擦带协议前缀的（Bearer/Basic）、再擦固定前缀令牌（sk-/ghp_/AKIA）、再擦 URL query 与 header 文本，
 * 最后才是邮箱和路径（避免把已擦除的标记再当路径处理一遍）。
 */
const STRING_RULES = Object.freeze([
  // Authorization 头里的凭据（保留 scheme 便于排查鉴权方式，但值不保留）
  { pattern: /(\b(?:bearer|basic|token|digest)\s+)[A-Za-z0-9._~+/=-]{6,}/gi, replace: `$1${REDACTED}` },
  // JWT：三段 Base64URL
  { pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, replace: REDACTED },
  // 常见固定前缀 API key / token
  { pattern: /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abps]|AKIA|ASIA)[-_A-Za-z0-9]{8,}/g, replace: REDACTED },
  // URL / query string 里的密钥参数
  { pattern: /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|client_secret|password|passwd|signature|sig)=)[^&\s#]+/gi, replace: `$1${REDACTED}` },
  // 形如 "authorization: xxx" / "api_key=xxx" 的裸文本（不吞掉 & 后面的非敏感参数）
  { pattern: /(\b(?:authorization|api[-_]?key|apikey|cookie|set-cookie|password|passwd|secret|token)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&#]+)/gi, replace: `$1${REDACTED}` },
  // 邮箱
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: REDACTED_EMAIL },
  // file:// URL（整个擦除，避免后续路径规则只擦一半）
  { pattern: /file:\/\/[^\s"'<>]+/gi, replace: 'file://[REDACTED_PATH]' },
  // macOS / Linux 家目录：只擦用户名，保留尾部目录
  { pattern: /\/Users\/[^/\s"':]+/g, replace: `/Users/${REDACTED_USER}` },
  { pattern: /\/home\/[^/\s"':]+/g, replace: `/home/${REDACTED_USER}` },
  // macOS 外接卷名、临时目录里的机器级标识
  { pattern: /\/Volumes\/[^/\s"':]+/g, replace: `/Volumes/${REDACTED_VOLUME}` },
  { pattern: /\/private\/var\/folders\/[^/\s"':]+/g, replace: '/private/var/folders/[REDACTED_TMP]' },
  // Windows 用户目录与 UNC 主机名
  { pattern: /\b([A-Za-z]):\\Users\\[^\\\s"':]+/g, replace: `$1:\\Users\\${REDACTED_USER}` },
  { pattern: /\\\\[^\\\s"':]+\\[^\\\s"':]+/g, replace: `\\\\${REDACTED_HOST}\\[REDACTED_SHARE]` },
]);

/** 判断一个字段名是否敏感（导出给审计/测试复用）。 */
export function isSensitiveKey(key) {
  return typeof key === 'string' && SECRET_KEY_PATTERN.test(key);
}

function truncate(textValue, maxLength) {
  if (textValue.length <= maxLength) return textValue;
  return `${textValue.slice(0, maxLength)}…[truncated ${textValue.length - maxLength} chars]`;
}

/** 只做字符串级脱敏 + 截断（导出便于单独测试；常规入口是 redactSecrets）。 */
export function redactString(value, { maxStringLength = DEFAULT_MAX_STRING_LENGTH } = {}) {
  let output = String(value);
  for (const rule of STRING_RULES) output = output.replace(rule.pattern, rule.replace);
  return truncate(output, maxStringLength);
}

function normalizeOptions(options) {
  const raw = options === undefined || options === null ? {} : options;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('redactSecrets 的 options 必须是对象'), { code: LOG_REDACTION_CODES.OPTIONS_INVALID });
  }
  const maxStringLength = raw.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxDepth = raw.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(maxStringLength) || maxStringLength < 32) {
    throw Object.assign(new Error('maxStringLength 必须是 >=32 的整数'), { code: LOG_REDACTION_CODES.OPTIONS_INVALID });
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw Object.assign(new Error('maxDepth 必须是 >=1 的整数'), { code: LOG_REDACTION_CODES.OPTIONS_INVALID });
  }
  return { maxStringLength, maxDepth };
}

function describeError(error, maxStringLength) {
  const base = {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: redactString(typeof error.message === 'string' ? error.message : String(error), { maxStringLength }),
  };
  if (error.code !== undefined) base.code = typeof error.code === 'string' || typeof error.code === 'number' ? error.code : String(error.code);
  // 堆栈里同样可能有本机路径/凭据，必须走同一套字符串规则。
  if (typeof error.stack === 'string') base.stack = redactString(error.stack, { maxStringLength });
  return base;
}

/**
 * 脱敏任意值：对象/数组保持结构，字符串擦除密钥/邮箱/本机路径并按上限截断，
 * 循环引用降级为 `[Circular]`，深度超限降级为 `[DEPTH_LIMIT]`。
 *
 * 本函数不会因为输入内容崩溃：Proxy getter 抛错 → `[UNREADABLE]`；
 * BigInt/Symbol/函数/Buffer/TypedArray/Date/Error/Map/Set 都有安全表示。
 *
 * @param {unknown} value
 * @param {{maxStringLength?: number, maxDepth?: number}} [options]
 * @returns {unknown} 与输入结构对齐、可安全 JSON.stringify 的值
 */
export function redactSecrets(value, options = undefined) {
  const { maxStringLength, maxDepth } = normalizeOptions(options);
  // seen 记录"当前递归路径"上的对象（不是全局），所以 DAG 里的共享引用会被正常展开，
  // 只有真正的环才会命中 —— 环返回标记而不是抛错。
  const walk = (input, depth, seen) => {
    if (depth > maxDepth) return '[DEPTH_LIMIT]';
    if (typeof input === 'string') return redactString(input, { maxStringLength });
    if (input === null || input === undefined) return input;
    const kind = typeof input;
    if (kind === 'number' || kind === 'boolean') return input;
    if (kind === 'bigint') return `${input.toString()}n`;
    if (kind === 'symbol') return input.toString();
    if (kind === 'function') return '[Function]';
    if (kind !== 'object') return String(input);

    const object = input;
    if (seen.has(object)) return '[Circular]';
    seen.add(object);
    try {
      if (object instanceof Date) {
        return Number.isFinite(object.getTime()) ? object.toISOString() : null;
      }
      if (object instanceof Error) return describeError(object, maxStringLength);
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(object)) return `[Buffer ${object.length} bytes]`;
      if (ArrayBuffer.isView(object)) return `[TypedArray ${object.byteLength} bytes]`;
      if (object instanceof Map) {
        const mapped = {};
        for (const [key, item] of object.entries()) {
          const name = typeof key === 'string' ? key : String(key);
          mapped[name] = isSensitiveKey(name) ? REDACTED : walk(item, depth + 1, seen);
        }
        return mapped;
      }
      if (object instanceof Set) return Array.from(object.values(), (item) => walk(item, depth + 1, seen));
      if (Array.isArray(object)) return object.map((item) => walk(item, depth + 1, seen));

      const output = {};
      for (const key of Object.keys(object)) {
        if (isSensitiveKey(key)) {
          output[key] = REDACTED;
          continue;
        }
        let item;
        try {
          item = object[key];
        } catch {
          // Proxy / getter 抛错：宁可标成不可读，也不能让日志脱敏本身把请求打挂。
          output[key] = '[UNREADABLE]';
          continue;
        }
        output[key] = walk(item, depth + 1, seen);
      }
      return output;
    } finally {
      seen.delete(object);
    }
  };
  return walk(value, 0, new Set());
}
