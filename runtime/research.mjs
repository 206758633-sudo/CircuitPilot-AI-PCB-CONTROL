import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';

/**
 * 联网检索（S1）：让 AI 在用户显式允许时查询公网 datasheet / 器件资料 / 参考页面。
 *
 * ## 为什么有这个文件
 *
 * 设计差异的一大根因是“查不到资料只能猜”。但把公网访问直接塞给模型同样危险：
 * 谁都能让一个内部地址被访问，抓回来的网页也可能是慢速/超大/不可信的。
 * 所以这里只做两件事，并把边界写死：
 *   1. `searchWeb()`：用无需 API Key 的 DuckDuckGo / Bing HTML 结果页取回候选链接；
 *   2. `fetchPage()`：抓取单个页面并转成纯文本，供模型做“归纳解释”。
 *
 * ## 安全边界（fail-closed）
 *
 * - 只允许 `http:`/`https:`；拒绝带账号密码的 URL；
 * - 拒绝本机/私网/链路本地/保留地址（含 `localhost`、`.local`、`.internal`、0/8、10/8、127/8、
 *   169.254/16、172.16/12、192.168/16、100.64/10、224/4 与 IPv6 回环/链路本地/唯一本地）；
 * - 域名先做 DNS 解析，**任一**解析结果落在私网即拒绝（防止 DNS 指向内网）；
 * - 重定向后的最终 URL 重新校验（防止 302 跳内网）；
 * - 超时、响应体积上限、内容类型白名单；错误一律返回带原因码的失败结果，绝不静默当空；
 * - 本模块只“取资料”，不写 EDA、不执行网页里的任何指令——网页内容只作为不可信证据交给上游。
 *
 * ## 测试
 *
 * 所有网络调用都通过 `fetchImpl` / `resolveHost` 注入；单测不联网。
 */

export const RESEARCH_CODES = Object.freeze({
  DISABLED: 'RESEARCH_DISABLED',
  INPUT_INVALID: 'RESEARCH_INPUT_INVALID',
  URL_BLOCKED: 'RESEARCH_URL_BLOCKED',
  URL_INVALID: 'RESEARCH_URL_INVALID',
  NETWORK_ERROR: 'RESEARCH_NETWORK_ERROR',
  TIMEOUT: 'RESEARCH_TIMEOUT',
  HTTP_ERROR: 'RESEARCH_HTTP_ERROR',
  RESPONSE_TOO_LARGE: 'RESEARCH_RESPONSE_TOO_LARGE',
  CONTENT_UNSUPPORTED: 'RESEARCH_CONTENT_UNSUPPORTED',
  MALFORMED: 'RESEARCH_RESPONSE_MALFORMED',
  NO_RESULTS: 'RESEARCH_NO_RESULTS',
  OUTPUT_INVALID: 'RESEARCH_OUTPUT_INVALID',
});

export const RESEARCH_SOURCES = Object.freeze({
  duckduckgo: Object.freeze({
    id: 'duckduckgo',
    label: 'DuckDuckGo（无需 API Key）',
    endpoint: 'https://html.duckduckgo.com/html/',
    verifiedAt: '2026-10-21',
  }),
  bing: Object.freeze({
    id: 'bing',
    label: 'Bing（无需 API Key）',
    endpoint: 'https://www.bing.com/search',
    verifiedAt: '2026-10-21',
  }),
});

export const DEFAULT_RESEARCH_PROVIDER = 'duckduckgo';
/** 首选源 0 结果时按顺序回退；两个源都失败才判失败（fail-closed）。 */
export const RESEARCH_FALLBACK_PROVIDERS = Object.freeze(['duckduckgo', 'bing']);

export const RESEARCH_LIMITS = Object.freeze({
  maxQueryChars: 200,
  maxResults: 10,
  defaultResults: 5,
  defaultTimeoutMs: 12_000,
  maxResponseBytes: 2_000_000,
  maxTextChars: 20_000,
});

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 CircuitPilot/0.2';

const fail = (code, message, details = null) => Object.assign(new Error(message), { code, details });

function invalidInput(message) {
  return fail(RESEARCH_CODES.INPUT_INVALID, message);
}

/** 统一把失败包成结构化结果，便于路由/证据层使用（不抛给最终用户堆栈）。 */
function failure(code, message, details = null) {
  return { ok: false, code, message, details };
}

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// HTML → 纯文本 / 实体解码
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  hellip: '…', mdash: '—', ndash: '–', middot: '·', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®',
};

/** 解码常见 HTML 实体（数字实体 + 常用命名实体）；未知实体原样保留，不瞎猜。 */
export function decodeHtmlEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try { return String.fromCodePoint(codePoint); } catch { return match; }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * 把 HTML 变成“可读文本”：去掉脚本/样式/注释/标签，块级标签换行，保留可读文字。
 * 只用于给模型当证据，不做任何 DOM 级渲染。
 */
export function htmlToText(html, { maxChars = RESEARCH_LIMITS.maxTextChars } = {}) {
  let text = String(html ?? '');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|blockquote|pre)>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t\f\v]+/g, ' ').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n');
  text = text.split('\n').map((line) => line.trim()).filter(Boolean).join('\n').trim();
  return text.slice(0, Math.max(0, maxChars));
}

// ---------------------------------------------------------------------------
// 搜索结果页解析
// ---------------------------------------------------------------------------

function parseAnchorTags(html, className) {
  const results = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html)) !== null) {
    const attrs = match[1];
    const classMatch = /class\s*=\s*"([^"]*)"/i.exec(attrs) || /class\s*=\s*'([^']*)'/i.exec(attrs);
    if (!classMatch || !classMatch[1].split(/\s+/).includes(className)) continue;
    const hrefMatch = /href\s*=\s*"([^"]*)"/i.exec(attrs) || /href\s*=\s*'([^']*)'/i.exec(attrs);
    if (!hrefMatch) continue;
    results.push({ href: decodeHtmlEntities(hrefMatch[1].trim()), inner: match[2] });
  }
  return results;
}

/** DuckDuckGo 的结果页链接是 `/l/?uddg=<encoded>` 形式，必须还原成真实目标地址。 */
export function unwrapDuckDuckGoHref(href) {
  const value = String(href ?? '').trim();
  if (!value) return '';
  try {
    const url = new URL(value, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    if (target) return decodeURIComponent(target);
    return /^https?:\/\//i.test(value) ? value : (value.startsWith('//') ? `https:${value}` : url.toString());
  } catch {
    return value;
  }
}

/** 结果页里的广告/跳转链接（DDG 的 y.js、Bing 的 aclick）不是资料，直接剔除。 */
export function isAdOrTrackingLink(raw) {
  try {
    const url = new URL(String(raw ?? ''));
    const host = url.hostname.toLowerCase();
    if ((host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) && url.pathname.startsWith('/y.js')) return true;
    if ((host === 'www.bing.com' || host === 'bing.com') && url.pathname.startsWith('/aclick')) return true;
    if (url.searchParams.has('ad_domain') || url.searchParams.has('ad_provider')) return true;
    return false;
  } catch {
    return false;
  }
}

export function parseDuckDuckGoResults(html, { limit = RESEARCH_LIMITS.defaultResults } = {}) {
  const anchors = parseAnchorTags(html, 'result__a');
  const snippets = parseAnchorTags(html, 'result__snippet');
  return anchors.slice(0, limit).map((anchor, index) => ({
    title: cleanText(htmlToText(anchor.inner, { maxChars: 300 })),
    url: unwrapDuckDuckGoHref(anchor.href),
    snippet: cleanText(htmlToText(snippets[index]?.inner || '', { maxChars: 400 })),
  })).filter((item) => item.title && item.url && !isAdOrTrackingLink(item.url));
}

export function parseBingResults(html, { limit = RESEARCH_LIMITS.defaultResults } = {}) {
  const results = [];
  const blockPattern = /<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[\s\S]*?<\/li>/gi;
  let block;
  while ((block = blockPattern.exec(html)) !== null && results.length < limit) {
    const chunk = block[0];
    const titleMatch = /<h2[^>]*>[\s\S]*?<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(chunk);
    if (!titleMatch) continue;
    const snippetMatch = /<p[^>]*class="[^"]*(?:b_lineclamp|b_algoSlug)[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(chunk)
      || /<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk);
    results.push({
      title: cleanText(htmlToText(titleMatch[2], { maxChars: 300 })),
      url: decodeHtmlEntities(titleMatch[1].trim()),
      snippet: cleanText(htmlToText(snippetMatch?.[1] || '', { maxChars: 400 })),
    });
  }
  return results.filter((item) => item.title && item.url && !isAdOrTrackingLink(item.url));
}

export function parseSearchResults(provider, html, options = {}) {
  return provider === 'bing' ? parseBingResults(html, options) : parseDuckDuckGoResults(html, options);
}

// ---------------------------------------------------------------------------
// URL 安全校验（SSRF 防护）
// ---------------------------------------------------------------------------

function parseIPv4(host) {
  const parts = String(host ?? '').split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return null;
  return nums;
}

export function isPrivateIpv4(parts) {
  if (!Array.isArray(parts) || parts.length !== 4) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

export function isPrivateIpv6(host) {
  const value = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!value || !value.includes(':')) return false;
  if (value === '::1' || value === '::') return true;
  if (/^fe[89ab][0-9a-f]:/i.test(value)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(value)) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) return isPrivateIpv4(parseIPv4(mapped[1]));
  return false;
}

/**
 * 校验一个 URL 是否允许被本模块访问；通过则返回 `URL` 实例，否则抛出带原因码的错误。
 * 仅做“字面量”检查；域名解析结果由 `assertPublicAddresses()` 在抓取前复核。
 */
export function assertPublicUrl(raw, { allowPrivate = false } = {}) {
  const value = String(raw ?? '').trim();
  if (!value) throw fail(RESEARCH_CODES.URL_INVALID, 'URL 不能为空');
  let url;
  try { url = new URL(value); } catch { throw fail(RESEARCH_CODES.URL_INVALID, 'URL 格式不合法'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail(RESEARCH_CODES.URL_BLOCKED, `只允许 http/https 协议，收到 ${url.protocol}`);
  if (url.username || url.password) throw fail(RESEARCH_CODES.URL_BLOCKED, '不允许在 URL 中携带账号密码');
  if (allowPrivate) return url;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw fail(RESEARCH_CODES.URL_INVALID, 'URL 缺少主机名');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw fail(RESEARCH_CODES.URL_BLOCKED, `拒绝访问本机/内网域名：${host}`);
  }
  const ipv4 = parseIPv4(host);
  if (ipv4 && isPrivateIpv4(ipv4)) throw fail(RESEARCH_CODES.URL_BLOCKED, `拒绝访问私网/保留地址：${host}`);
  if (isPrivateIpv6(host)) throw fail(RESEARCH_CODES.URL_BLOCKED, `拒绝访问私网/保留 IPv6 地址：${host}`);
  return url;
}

/** DNS 解析结果复核：任一地址落在私网/本机即拒绝（防 DNS 指向内网）。 */
export function assertPublicAddresses(addresses) {
  for (const entry of Array.isArray(addresses) ? addresses : []) {
    const address = String(entry?.address ?? entry ?? '');
    if (!address) continue;
    const ipv4 = parseIPv4(address);
    if (ipv4) {
      if (isPrivateIpv4(ipv4)) throw fail(RESEARCH_CODES.URL_BLOCKED, `域名解析到私网/保留地址：${address}`);
      continue;
    }
    if (isPrivateIpv6(address)) throw fail(RESEARCH_CODES.URL_BLOCKED, `域名解析到私网/保留 IPv6 地址：${address}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 网络请求
// ---------------------------------------------------------------------------

async function readLimitedBody(response, maxBytes) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw fail(RESEARCH_CODES.RESPONSE_TOO_LARGE, `响应超过上限（${buffer.byteLength} > ${maxBytes} 字节）`);
  }
  return buffer;
}

function contentTypeOf(response) {
  const headers = response?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get('content-type') ?? '');
  return String(headers['content-type'] ?? '');
}

async function fetchWithTimeout(url, { fetchImpl, timeoutMs, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw fail(RESEARCH_CODES.TIMEOUT, `请求超时（>${timeoutMs}ms）`);
    throw fail(RESEARCH_CODES.NETWORK_ERROR, `网络请求失败：${String(error?.message || error).slice(0, 160)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAndCheck(hostname, resolveHost, allowPrivate) {
  if (allowPrivate) return true;
  const bare = String(hostname ?? '').replace(/^\[|\]$/g, '');
  if (parseIPv4(bare) || isPrivateIpv6(bare)) return true; // 字面量地址已在 assertPublicUrl 里查过
  const addresses = await resolveHost(bare);
  assertPublicAddresses(addresses);
  return true;
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 搜索公网资料。
 *
 * @param {object} options
 * @param {string} options.query 查询词（去空白后 2~200 字符）
 * @param {'duckduckgo'|'bing'} [options.provider] 指定首选源；缺省按 duckduckgo→bing 回退
 * @param {number} [options.limit] 结果条数（1~10，默认 5）
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(hostname: string) => Promise<Array<{address: string, family?: number}>>} [options.resolveHost]
 */
export async function searchWeb({
  query,
  provider = null,
  limit = RESEARCH_LIMITS.defaultResults,
  timeoutMs = RESEARCH_LIMITS.defaultTimeoutMs,
  fetchImpl = globalThis.fetch,
  resolveHost = (hostname) => lookup(hostname, { all: true, verbatim: true }),
  allowPrivate = false,
} = {}) {
  const keyword = String(query ?? '').trim();
  if (keyword.length < 2) return failure(RESEARCH_CODES.INPUT_INVALID, '查询词至少 2 个字符');
  if (keyword.length > RESEARCH_LIMITS.maxQueryChars) return failure(RESEARCH_CODES.INPUT_INVALID, `查询词不能超过 ${RESEARCH_LIMITS.maxQueryChars} 字符`);
  if (!Number.isInteger(limit) || limit < 1 || limit > RESEARCH_LIMITS.maxResults) return failure(RESEARCH_CODES.INPUT_INVALID, `结果数必须是 1~${RESEARCH_LIMITS.maxResults} 的整数`);
  if (provider !== null && !RESEARCH_SOURCES[provider]) return failure(RESEARCH_CODES.INPUT_INVALID, `不支持的检索源：${String(provider)}`);

  const providers = provider
    ? [provider]
    : RESEARCH_FALLBACK_PROVIDERS.filter((id) => RESEARCH_SOURCES[id]);
  const attempts = [];
  for (const id of providers) {
    const source = RESEARCH_SOURCES[id];
    try {
      const url = assertPublicUrl(`${source.endpoint}?q=${encodeURIComponent(keyword)}`, { allowPrivate });
      await resolveAndCheck(url.hostname, resolveHost, allowPrivate);
      const response = await fetchWithTimeout(url.toString(), { fetchImpl, timeoutMs, headers: { accept: 'text/html,application/xhtml+xml' } });
      if (!response || !response.ok) {
        attempts.push({ provider: id, ok: false, code: RESEARCH_CODES.HTTP_ERROR, status: Number(response?.status ?? 0) || null });
        continue;
      }
      const contentType = contentTypeOf(response);
      if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
        attempts.push({ provider: id, ok: false, code: RESEARCH_CODES.CONTENT_UNSUPPORTED, contentType });
        continue;
      }
      const buffer = await readLimitedBody(response, RESEARCH_LIMITS.maxResponseBytes);
      const results = parseSearchResults(id, buffer.toString('utf8'), { limit });
      attempts.push({ provider: id, ok: results.length > 0, results: results.length });
      if (!results.length) continue;
      const fetchedAt = new Date().toISOString();
      const payload = { query: keyword, provider: id, fetchedAt, results };
      return {
        ok: true,
        query: keyword,
        provider: id,
        source: { ...source },
        fetchedAt,
        results,
        attempts,
        digest: digestOf(payload),
      };
    } catch (error) {
      if (error?.code === RESEARCH_CODES.URL_BLOCKED || error?.code === RESEARCH_CODES.TIMEOUT) {
        attempts.push({ provider: id, ok: false, code: error.code, message: String(error.message).slice(0, 120) });
        if (error.code === RESEARCH_CODES.URL_BLOCKED) return failure(error.code, error.message);
        continue;
      }
      attempts.push({ provider: id, ok: false, code: error?.code || RESEARCH_CODES.NETWORK_ERROR, message: String(error?.message || error).slice(0, 120) });
    }
  }
  return failure(RESEARCH_CODES.NO_RESULTS, `所有检索源都失败（${providers.join(' → ')}）`, { attempts });
}

/**
 * 抓取单个页面并转纯文本。
 *
 * @returns {{ ok: true, url: string, finalUrl: string, status: number, contentType: string, bytes: number,
 *             text: string, fetchedAt: string, digest: string } | { ok: false, code: string, message: string }}
 */
export async function fetchPage({
  url,
  maxBytes = RESEARCH_LIMITS.maxResponseBytes,
  timeoutMs = RESEARCH_LIMITS.defaultTimeoutMs,
  fetchImpl = globalThis.fetch,
  resolveHost = (hostname) => lookup(hostname, { all: true, verbatim: true }),
  allowPrivate = false,
} = {}) {
  let target;
  try {
    target = assertPublicUrl(url, { allowPrivate });
    await resolveAndCheck(target.hostname, resolveHost, allowPrivate);
  } catch (error) {
    return failure(error?.code || RESEARCH_CODES.URL_INVALID, String(error?.message || error));
  }
  try {
    const response = await fetchWithTimeout(target.toString(), { fetchImpl, timeoutMs, headers: { accept: 'text/html,application/xhtml+xml,text/plain' } });
    if (!response || !response.ok) return failure(RESEARCH_CODES.HTTP_ERROR, `HTTP ${Number(response?.status ?? 0) || '未知'}`, { status: Number(response?.status ?? 0) || null });
    const finalUrl = String(response.url || target.toString());
    try { assertPublicUrl(finalUrl, { allowPrivate }); } catch (error) { return failure(error.code, `重定向目标被拒绝：${error.message}`); }
    const contentType = contentTypeOf(response);
    const buffer = await readLimitedBody(response, maxBytes);
    if (/application\/pdf/i.test(contentType)) return failure(RESEARCH_CODES.CONTENT_UNSUPPORTED, 'PDF 暂不支持在线解析，请抓取产品页/HTML 页面', { contentType, bytes: buffer.byteLength });
    const isHtml = !contentType || /text\/html|application\/xhtml/i.test(contentType);
    const isText = /text\/plain|application\/json/i.test(contentType);
    if (!isHtml && !isText) return failure(RESEARCH_CODES.CONTENT_UNSUPPORTED, `不支持的内容类型：${contentType || '未知'}`, { contentType });
    const text = isHtml ? htmlToText(buffer.toString('utf8')) : buffer.toString('utf8').slice(0, RESEARCH_LIMITS.maxTextChars);
    const fetchedAt = new Date().toISOString();
    return { ok: true, url: target.toString(), finalUrl, status: Number(response.status ?? 0), contentType, bytes: buffer.byteLength, text, fetchedAt, digest: digestOf({ finalUrl, fetchedAt, text }) };
  } catch (error) {
    return failure(error?.code || RESEARCH_CODES.NETWORK_ERROR, String(error?.message || error));
  }
}
