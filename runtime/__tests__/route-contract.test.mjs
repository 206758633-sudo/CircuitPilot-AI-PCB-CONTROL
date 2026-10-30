import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * 路由消费者契约（纯静态、无网络、毫秒级）。
 *
 * 目的：防止 runtime/server.mjs 里继续出现"只注册、没有任何前端/脚本/测试消费者"的孤儿路由。
 * 判定方式（三条，命中任意一条即视为有消费者）：
 *
 *   1) runtimeClient 里有对应方法，且该方法在 src/pages、src/components、src/state 中被
 *      `runtimeClient.<name>(` 实际调用；
 *   2) 路径字符串出现在 scripts/、e2e/、runtime/__tests__/ 中（脚本与测试也算消费者）；
 *   3) 路径字符串出现在 src/ 的任意业务文件里（runtimeClient.ts 除外——否则"客户端方法存在"
 *      会自证"路由有消费者"，第一条件就形同虚设）。
 *
 * 没有消费者的路由必须显式登记到 KNOWN_UNWIRED_ROUTES（并写清原因/TODO），
 * 否则测试失败并打印缺失列表。反过来，允许清单里已经接线（或路由已删除）的条目
 * 也会被打印出来提醒清理——只提示、不失败。
 *
 * 注意：本文件自身包含 KNOWN_UNWIRED_ROUTES 里的完整路由字符串，因此扫描语料时
 * 必须排除本文件，否则清单会自我证明。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SERVER_PATH = join(ROOT, 'runtime', 'server.mjs');
const CLIENT_PATH = join(ROOT, 'src', 'services', 'runtimeClient.ts');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PARAM = ':param';

/**
 * 已知且"故意暂不接线"的路由：key = `METHOD /api/...`（参数段统一记为 :param）。
 * 每条都必须有一句原因/TODO。新增路由若只是"还没来得及接 UI"，优先补消费者，
 * 不要把这里当成免死金牌。
 */
const KNOWN_UNWIRED_ROUTES = {
  // --- 布局/走线写回只有受控脚本与 e2e-live 使用，UI 还没有入口（写板风险高，先不接）---
  // --- DRC 会话控制：start/report/cancel 已有 UI（验证页一键取证）；豁免清单还没有 UI 编辑器 ---
  // 豁免清单 GET/PUT 已由验证页豁免编辑器消费（dr 面板 → 载入/保存），不再列入允许清单。
  // --- 设计执行取消/能力探测：客户端方法尚未被页面调用 ---
  'POST /api/design/cancel': 'TODO: 设计执行取消暂无 UI 入口（执行窗口较短，后续再补"中止"按钮）。',
  'POST /api/design/capabilities/probe': 'TODO: 能力探测尚无可视化入口，保留给流程编排。',
  // --- GUI 兜底：Phase 0 自动化尚未接 GUI 执行 ---
  'GET /api/eda/gui/state': 'TODO: GUI 状态回读尚无 UI 消费者。',
  // --- 供应链价格：只接受用户显式提供，当前没有在线询价 UI ---
  // POST /api/supply/pricing 已由 runtimeClient.supplyPricing + 验证页"供应链证据"面板消费。

  // --- 设计执行结果查询：客户端还没有对应方法 ---
  // GET /api/design/executions 与 /:id 已由 runtimeClient + EdaPage 执行历史面板消费。

  'GET /api/design/executions/:param/evidence': 'TODO: 执行证据查询尚无 runtimeClient 方法与 UI 消费者。',
  // --- 实际静态扫描发现的其它孤儿路由（不在任务给定的最小清单里，但同样没有消费者）---
  'GET /api/eda/commands': 'TODO: 命令清单目前由前端静态命令卡定义，未调用 GET 清单；保留给外部诊断/未来动态命令发现。',
  'POST /api/evidence/retention/prune': 'TODO: 证据清理是破坏性运维动作，目前只给 CLI/运维脚本用（必须 confirm+写批准），暂无 UI 入口。',
  'POST /api/design/plan/ai': 'TODO: runtimeClient.generateDesignPlan 已定义但无页面调用（AI 设计草案目前走 netlist/ai），待接线或删除。',
  'POST /api/eda/footprint/integrity': 'TODO: 封装完整性预检当前由 CLI（npm run check:footprint-integrity）经 bridge 直连消费；HTTP 路由留给验证页/门禁后续接线（2026-10-22 新增）。',
  'POST /api/production/reviews/final': 'TODO: runtimeClient.recordProductionFinalReview 已定义但无 UI 调用，终审登记入口待接线。',
  // --- W3/W1 知识库与联网检索的运维/内部入口：暂无 UI 消费者，留作采集器/审计工具 ---
  'GET /api/research/status': 'TODO: 联网检索状态查询暂无 UI（设置页只调 search），保留给诊断。',
  'POST /api/research/fetch': 'TODO: 单页抓取由 runtime 内部资料采集器调用，暂无 UI 入口。',
};

// ---------------------------------------------------------------------------
// 1. 解析 runtime/server.mjs 的路由定义
// ---------------------------------------------------------------------------

/**
 * 把 server.mjs 里的正则路由（如 /^\/api\/providers\/[^/]+\/login$/）
 * 归一成带 :param 的路径。/api/... 之外的一律忽略。
 */
function canonicalRegexPath(source) {
  let path = source;
  if (path.startsWith('^')) path = path.slice(1);
  if (path.endsWith('$')) path = path.slice(0, -1);
  path = path.replace(/\\\//g, '/').replace(/\\\./g, '.');
  path = path
    .replace(/\[\^\/\]\+/g, PARAM)
    .replace(/\[\^\/\]\*/g, PARAM)
    .replace(/\[\^\/\]\{[^}]*\}/g, PARAM)
    .replace(/\.\+/g, PARAM)
    .replace(/\$\{[^}]*\}/g, PARAM);
  return path;
}

function parseServerRoutes(source) {
  const routes = new Map();
  const add = (method, rawPath, kind) => {
    if (!HTTP_METHODS.includes(method)) return;
    if (typeof rawPath !== 'string' || !rawPath.startsWith('/api/')) return;
    const key = `${method} ${rawPath}`;
    // 同一路由可能同时出现在鉴权判断和分发表里，按 METHOD+路径 去重。
    if (!routes.has(key)) routes.set(key, { method, path: rawPath, kind });
  };

  // 形式 A：method === 'GET' && url.pathname === '/api/x'
  for (const match of source.matchAll(/method\s*===\s*'(GET|POST|PUT|PATCH|DELETE)'\s*&&\s*url\.pathname\s*===\s*'([^']+)'/g)) {
    add(match[1], match[2], 'exact');
  }
  // 形式 A 的反向书写：url.pathname === '/api/x' && method === 'GET'
  for (const match of source.matchAll(/url\.pathname\s*===\s*'([^']+)'\s*&&\s*method\s*===\s*'(GET|POST|PUT|PATCH|DELETE)'/g)) {
    add(match[2], match[1], 'exact');
  }
  // 形式 B：method === 'POST' && /^\/api\/x\/[^/]+$/.test(url.pathname)
  // 正则字面量里既可能出现 \/ 转义，也可能在字符类里出现裸 /（[^/]），两种都要能跳过。
  const REGEX_LITERAL_BODY = String.raw`(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\[\]])+`;
  for (const match of source.matchAll(new RegExp(`method\\s*===\\s*'(GET|POST|PUT|PATCH|DELETE)'\\s*&&\\s*\\/(${REGEX_LITERAL_BODY})\\/[dgimsuvy]*\\.test\\(\\s*url\\.pathname\\s*\\)`, 'g'))) {
    add(match[1], canonicalRegexPath(match[2]), 'pattern');
  }
  // 形式 B 的反向书写：/^\/api\/x$/.test(url.pathname) && method === 'POST'
  for (const match of source.matchAll(new RegExp(`\\/(${REGEX_LITERAL_BODY})\\/[dgimsuvy]*\\.test\\(\\s*url\\.pathname\\s*\\)\\s*&&\\s*method\\s*===\\s*'(GET|POST|PUT|PATCH|DELETE)'`, 'g'))) {
    add(match[2], canonicalRegexPath(match[1]), 'pattern');
  }
  // 形式 C：method === 'GET' && url.pathname.startsWith('/api/x')
  for (const match of source.matchAll(/method\s*===\s*'(GET|POST|PUT|PATCH|DELETE)'\s*&&\s*url\.pathname\.startsWith\(\s*'([^']+)'\s*\)/g)) {
    add(match[1], match[2], 'prefix');
  }
  // 形式 C 的反向书写：url.pathname.startsWith('/api/x') && method === 'GET'
  for (const match of source.matchAll(/url\.pathname\.startsWith\(\s*'([^']+)'\s*\)\s*&&\s*method\s*===\s*'(GET|POST|PUT|PATCH|DELETE)'/g)) {
    add(match[2], match[1], 'prefix');
  }

  return [...routes.values()].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

// ---------------------------------------------------------------------------
// 2. 解析 src/services/runtimeClient.ts 的客户端方法（路径 + 方法）
// ---------------------------------------------------------------------------

/** 跳过一段字符串/模板字面量，返回闭引号之后的下标。 */
function skipLiteral(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') { index += 2; continue; }
    if (char === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

/**
 * 从一个客户端方法体里取出第一个 request(...) 调用的路径字面量。
 * request 的泛型实参可能跨行且含嵌套 <>（Record<...> 等），这里做括号配对扫描。
 */
function extractFirstRequestPath(chunk) {
  const call = /request(?=\s*[<(])/.exec(chunk);
  if (!call) return null;
  let index = call.index + 'request'.length;

  while (chunk[index] === '<') {
    let depth = 0;
    let closed = false;
    for (; index < chunk.length; index += 1) {
      const char = chunk[index];
      if (char === '<') depth += 1;
      else if (char === '>') {
        depth -= 1;
        if (depth === 0) { index += 1; closed = true; break; }
      } else if (char === "'" || char === '"' || char === '`') {
        index = skipLiteral(chunk, index) - 1;
      }
    }
    if (!closed) return null;
  }

  if (chunk[index] !== '(') return null;
  const literal = /^\s*(`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*")/.exec(chunk.slice(index + 1));
  if (!literal) return null;
  return literal[1].slice(1, -1);
}

/** 把客户端路径归一成与 server 路由可比较的形态：查询串丢弃、模板变量 → :param。 */
function normalizeClientPath(raw) {
  let path = raw;
  const query = path.indexOf('?');
  if (query >= 0) path = path.slice(0, query);
  path = path.replace(/\$\{([^}]*)\}/g, (_whole, expression) => {
    const inner = expression.trim();
    // 这些方法把查询串拼进模板（`/api/chat/status${query}`），不是路径参数。
    if (inner === 'query' || inner.endsWith('Query')) return '';
    return PARAM;
  });
  return path;
}

function parseRuntimeClientCalls(source) {
  const start = source.indexOf('export const runtimeClient = {');
  assert.notEqual(start, -1, 'runtimeClient.ts 里找不到 `export const runtimeClient = {`，解析规则可能已过期');
  const tail = source.slice(start);
  const closeMatch = /^};$/m.exec(tail);
  assert.ok(closeMatch, '无法定位 runtimeClient 对象结尾');
  const region = tail.slice(0, closeMatch.index);

  const methodStarts = [...region.matchAll(/^ {2}async ([A-Za-z_$][\w$]*)\s*\(/gm)];
  assert.ok(methodStarts.length > 0, 'runtimeClient 对象里没有解析到任何 async 方法');

  const calls = [];
  for (let i = 0; i < methodStarts.length; i += 1) {
    const name = methodStarts[i][1];
    const chunkStart = methodStarts[i].index;
    const chunkEnd = i + 1 < methodStarts.length ? methodStarts[i + 1].index : region.length;
    const chunk = region.slice(chunkStart, chunkEnd);
    const rawPath = extractFirstRequestPath(chunk);
    if (!rawPath) continue;
    const methodMatch = chunk.match(/method:\s*'(GET|POST|PUT|PATCH|DELETE)'/);
    calls.push({
      clientMethod: name,
      method: methodMatch ? methodMatch[1] : 'GET',
      path: normalizeClientPath(rawPath),
    });
  }
  return calls;
}

// ---------------------------------------------------------------------------
// 3. 收集消费者语料
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

function listSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
    files.push(fullPath);
  }
  return files;
}

function readAll(paths) {
  return paths.map((file) => readFileSync(file, 'utf8')).join('\n');
}

function collectConsumerCorpus() {
  // 第 2 条：脚本 / e2e / runtime 测试。
  const scriptSideFiles = [
    ...listSourceFiles(join(ROOT, 'scripts')),
    ...listSourceFiles(join(ROOT, 'e2e')),
    ...listSourceFiles(join(ROOT, 'runtime', '__tests__')),
  ];
  // 第 3 条：src 业务文件；排除 runtimeClient.ts（它自己定义路径，不能自证被消费），
  // 也排除本测试文件（允许清单里的完整路径会让清单自我证明）。
  const srcSideFiles = listSourceFiles(join(ROOT, 'src')).filter((file) => {
    const rel = relative(ROOT, file);
    return rel !== join('src', 'services', 'runtimeClient.ts');
  });
  const selfPath = fileURLToPath(import.meta.url);
  const corpus = readAll([...scriptSideFiles, ...srcSideFiles].filter((file) => file !== selfPath));
  return corpus;
}

function collectUiClientCalls() {
  const directories = ['src/pages', 'src/components', 'src/state'].map((item) => join(ROOT, ...item.split('/')));
  const files = directories.flatMap((directory) => listSourceFiles(directory));
  const calls = new Set();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/runtimeClient\.([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(match[1]);
  }
  return calls;
}

// ---------------------------------------------------------------------------
// 4. 匹配路由 ↔ 消费者
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 路由路径（含 :param）→ 可区分路径段的匹配器。 */
function routePathRegExp(path, flags = '') {
  const body = path
    .split('/')
    .map((segment) => (segment === PARAM ? '[^/]+' : escapeRegExp(segment)))
    .join('/');
  return new RegExp(`^${body}$`, flags);
}

/** 在原始文本语料里找路径字符串：参数段允许模板变量，边界不允许吞掉更长路径。 */
function corpusPathRegExp(path) {
  const body = path
    .split('/')
    .map((segment) => (segment === PARAM ? "[^/\\s'\"`]+" : escapeRegExp(segment)))
    .join('/');
  // 结尾必须是引用符/空白/查询串/模板变量/右括号等，避免 /api/pcb/plan 命中 /api/pcb/plan/ai。
  return new RegExp(`${body}(?=$|[\\s'\"\`?)\\]},;]|\\$\\{)`);
}

function findConsumers(route, context) {
  const reasons = [];

  // 条件 1：客户端方法存在，且被 pages/components/state 实际调用。
  const clientMatcher = routePathRegExp(route.path);
  const matchedCalls = context.clientCalls.filter((call) => call.method === route.method && clientMatcher.test(call.path));
  const calledMethods = matchedCalls.filter((call) => context.uiClientCalls.has(call.clientMethod));
  if (calledMethods.length > 0) {
    reasons.push(`runtimeClient 方法 ${[...new Set(calledMethods.map((call) => call.clientMethod))].join(', ')} 已在页面/组件/状态中被调用`);
  }

  // 条件 2/3：路径字符串出现在脚本、e2e、runtime 测试或 src 业务文件里。
  if (route.kind === 'prefix') {
    if (context.corpus.includes(route.path)) reasons.push('路径前缀出现在脚本/测试/src 语料中');
  } else if (corpusPathRegExp(route.path).test(context.corpus)) {
    reasons.push('路径字符串出现在脚本/测试/src 语料中');
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('解析器覆盖三种路由定义形式（含 server.mjs 当前还没用到的 startsWith）', () => {
  // 用合成源码验证解析器本身，避免"现在恰好没有 startsWith 路由"掩盖解析缺口。
  const fixture = [
    "if (method === 'GET' && url.pathname === '/api/alpha') {",
    "} else if (method === 'POST' && /^\\/api\\/beta\\/[^/]+$/.test(url.pathname)) {",
    "} else if (method === 'DELETE' && url.pathname.startsWith('/api/gamma/')) {",
    "} else if (url.pathname === '/api/delta' && method === 'PUT') {",
    "} else if (method === 'GET' && url.pathname === '/not-api/ignored') {",
  ].join('\n');
  const routes = parseServerRoutes(fixture);
  const byKey = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
  assert.equal(routes.length, 4, `合成路由解析数量不对：${routes.map((route) => `${route.method} ${route.path} (${route.kind})`).join(', ')}`);
  assert.equal(byKey.get('GET /api/alpha')?.kind, 'exact');
  assert.equal(byKey.get('PUT /api/delta')?.kind, 'exact');
  assert.equal(byKey.get('POST /api/beta/:param')?.kind, 'pattern');
  assert.equal(byKey.get('DELETE /api/gamma/')?.kind, 'prefix');
  for (const route of routes) assert.ok(!route.path.includes('\\'), `正则路由未被归一化：${route.path}`);
});

test('路由静态解析：三种定义形式都能覆盖，且解析结果合法', () => {
  const routes = parseServerRoutes(readFileSync(SERVER_PATH, 'utf8'));
  assert.ok(routes.length >= 40, `解析到的路由数量异常偏少：${routes.length}`);
  for (const route of routes) {
    assert.ok(HTTP_METHODS.includes(route.method), `非法 HTTP 方法：${route.method}`);
    assert.ok(route.path.startsWith('/api/'), `非 /api 路由不应参与契约：${route.path}`);
    assert.ok(!route.path.includes('\\'), `正则路由未被归一化：${route.path}`);
  }
  // 当前 server.mjs 至少有 exact 与 pattern 两种写法；将来出现 startsWith 时也应被解析。
  const kinds = new Set(routes.map((route) => route.kind));
  assert.ok(kinds.has('exact'), '没有解析到 url.pathname === 形式的路由');
  assert.ok(kinds.has('pattern'), '没有解析到 /^...$/.test(url.pathname) 形式的路由');

  const clientCalls = parseRuntimeClientCalls(readFileSync(CLIENT_PATH, 'utf8'));
  assert.ok(clientCalls.length >= 30, `解析到的客户端请求数量异常偏少：${clientCalls.length}`);
  for (const call of clientCalls) {
    assert.ok(call.path.startsWith('/api/'), `客户端路径解析异常：${call.clientMethod} → ${call.path}`);
    assert.ok(!call.path.includes('${'), `客户端模板变量未被归一化：${call.path}`);
  }

  console.log(`[route-contract] 服务端路由 ${routes.length} 条（exact ${routes.filter((r) => r.kind === 'exact').length} / pattern ${routes.filter((r) => r.kind === 'pattern').length} / prefix ${routes.filter((r) => r.kind === 'prefix').length}），客户端请求 ${clientCalls.length} 条。`);
});

test('不存在没有消费者的孤儿路由', () => {
  const routes = parseServerRoutes(readFileSync(SERVER_PATH, 'utf8'));
  const context = {
    clientCalls: parseRuntimeClientCalls(readFileSync(CLIENT_PATH, 'utf8')),
    uiClientCalls: collectUiClientCalls(),
    corpus: collectConsumerCorpus(),
  };
  const allowlist = Object.keys(KNOWN_UNWIRED_ROUTES);

  const missing = [];
  const wired = [];
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const reasons = findConsumers(route, context);
    const allowlisted = Object.prototype.hasOwnProperty.call(KNOWN_UNWIRED_ROUTES, key);
    if (reasons.length > 0) {
      wired.push({ key, reasons, allowlisted });
    } else if (!allowlisted) {
      missing.push(key);
    }
  }

  const allowedButUnconsumed = allowlist.filter((key) => !routes.some((route) => `${route.method} ${route.path}` === key));
  const stats = {
    routes: routes.length,
    wired: wired.length,
    allowlisted: allowlist.length,
    orphan: missing.length,
  };
  console.log(`[route-contract] 路由统计：总数 ${stats.routes}，有消费者 ${stats.wired}，允许清单 ${stats.allowlisted}，孤儿 ${stats.orphan}。`);

  if (missing.length > 0) {
    assert.fail([
      `发现 ${missing.length} 条没有消费者的孤儿路由（要么接线，要么登记到 KNOWN_UNWIRED_ROUTES 并写明原因）：`,
      ...missing.map((key) => `  - ${key}`),
    ].join('\n'));
  }

  // 允许清单里已接线 / 已删除的条目：提示清理，不失败。
  const stale = wired.filter((entry) => entry.allowlisted).map((entry) => entry.key);
  const removed = allowedButUnconsumed.filter((key) => !wired.some((entry) => entry.key === key));
  const cleanup = [...new Set([...stale, ...removed])];
  if (cleanup.length > 0) {
    console.log([
      `[route-contract] 允许清单有 ${cleanup.length} 条可以清理（已接线或路由已删除）：`,
      ...cleanup.map((key) => `  - ${key}`),
    ].join('\n'));
  }

  assert.equal(missing.length, 0, `孤儿路由 ${missing.length} 条`);
});
