/**
 * Agent 路由边界（契约 docs/agent/agent-contract.md §1「Agent 禁止访问的路由」）。
 *
 * 认证与授权分离：server 先用 agent-token.mjs 校验 `x-circuitpilot-agent-token`（认证），
 * 命中后把请求标记为 agent，再在分发前用本模块判定"这个路由能不能由 Agent 调"（授权）。
 *
 * 这里必须是**纯函数**：只依赖 (method, pathname)，不读盘、不发请求、不看运行时状态。
 * 好处是单测稳定，也避免授权结果随文件/网络波动（"这次放行、下次拒绝"本身就是风险）。
 *
 * 口径：denylist —— 未命中路由默认放行；命中即拒绝（fail-closed）。
 * 路径归一化会处理 query/hash、URL 编码（含双重编码）、重复斜杠、`.`/`..` 段与结尾斜杠，
 * 防止 `/api/design/%61pprove/`、`/api/settings/`、`/api/x/../settings` 这类变体绕过字符串比较。
 * 敏感路由按"子树"拒绝（例如 `/api/production/signoff/latest` 也拒绝），因为只读子路径同样属于
 * 签核/下单链路的旁路信息面，MVP 阶段宁可不给 Agent。
 *
 * 例外（契约 §1）：
 *   - `approvalMode='chat'` 时允许 Agent POST 精确路径 `/api/design/approve`、
 *     `/api/pcb/approve`（必须带 planHash + confirm=true，审计由 server 记录）；
 *   - 计划级待审批队列（task-40）：允许 Agent POST 精确路径 `/api/agent/plan-requests`
 *     创建待审批请求。只创建；GET 列表/decision 由 UI 完成，Agent 仍然 403。
 * 豁免只到"精确路径 + POST"：GET/HEAD、子路径、其它方法仍然拒绝，避免把口子放大成
 * 任意 /api/agent/*、/api/design/* 或读接口。
 */

export const AGENT_AUTH_CODES = Object.freeze({
  ROUTE_FORBIDDEN: 'AGENT_ROUTE_FORBIDDEN',
});

/** 契约允许的只读方法（HEAD 与 GET 同语义、无副作用）。 */
const READ_METHODS = new Set(['GET', 'HEAD']);

const AGENT_ROUTE_PREFIX = '/api/agent';

/** `/api/agent/*` 里唯一放行的两条只读探测路由（契约「除 status/health」）。 */
export const AGENT_PUBLIC_ROUTES = Object.freeze(['/api/agent/status', '/api/agent/health']);
const PUBLIC_AGENT_ROUTE_SET = new Set(AGENT_PUBLIC_ROUTES);

/**
 * task-40：Agent 在 `/api/agent/*` 下唯一允许的写路由——创建计划级待审批请求。
 * 精确路径 + POST；GET 列表与 POST decision 仍属于 UI。
 */
export const AGENT_PLAN_REQUEST_CREATE_ROUTE = '/api/agent/plan-requests';

/**
 * 精确路由及其子路径全部拒绝。每一条都对应契约 §1 的 denylist：
 * 签核/终审/下单确认必须由人完成；文件下载与诊断包导出会把本机文件读出口径交给 Agent，
 * research/config 属于设置面（研究开关由用户显式设置，Agent 不能自行打开联网）。
 *
 * 注意：design/pcb 的 approve 不在本列表里——它们在 approvalMode='chat' 下走下面的精确豁免，
 * 但豁免之外（GET/子路径）仍然拒绝；签核/终审/下单确认没有这个例外。
 */
const DENIED_ROUTE_TREES = Object.freeze([
  '/api/production/signoff',
  '/api/production/reviews/final',
  '/api/production/order-confirmation',
  '/api/production/download',
  '/api/diagnostics/bundle',
  '/api/research/config',
]);

/**
 * 对话审批（approvalMode='chat'）豁免：只放行 POST 的精确路径。
 * 契约要求 `cp_approve` 必须带 planHash 和显式 confirm=true，并由 server 写 agent 审批审计；
 * 本模块只做路由级控制，不替代 server 的参数校验/审计。
 */
export const AGENT_CHAT_APPROVAL_ROUTES = Object.freeze(['/api/design/approve', '/api/pcb/approve']);
const CHAT_APPROVAL_ROUTE_SET = new Set(AGENT_CHAT_APPROVAL_ROUTES);

/** 设置/Provider 面：契约写 `/api/settings*`、`/api/providers*`，读写都拒绝。 */
const DENIED_ROUTE_PREFIXES = Object.freeze(['/api/settings', '/api/providers']);

const WRITE_GATE_ROUTE = '/api/write-gate';
const MAX_DECODE_ROUNDS = 3;

const isReadMethod = (method) => READ_METHODS.has(method);
const matchesTree = (path, tree) => path === tree || path.startsWith(`${tree}/`);
const matchesPrefix = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * 把传进来的 pathname 归一化成可比较的绝对路径；无法安全归一化时返回 null（调用方按拒绝处理）。
 *
 * 只接收 pathname（query 不属于它）；若调用方把 `?`/`#` 也带进来会先切掉，避免
 * `/api/settings?next=/api/health` 之类的字符串诡计影响判定。非法百分号编码不能"猜"，直接拒绝。
 */
export function normalizeAgentPath(pathname) {
  if (typeof pathname !== 'string') return null;
  let raw = pathname.trim();
  if (!raw.startsWith('/')) return null;
  const cut = raw.search(/[?#]/);
  if (cut >= 0) raw = raw.slice(0, cut);

  try {
    for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
      const decoded = decodeURIComponent(raw);
      if (decoded === raw) break;
      raw = decoded;
    }
  } catch {
    return null;
  }
  // 解码后带出控制字符：不是合法路由，拒绝（也防止日志/正则被注入）。
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;

  const segments = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/**
 * 判断 Agent 令牌能否访问某个 HTTP 路由（纯函数）。
 *
 * @param {string} method HTTP 方法（大小写不敏感）
 * @param {string} pathname 仅路径（不含 query；传了也会被切掉）
 * @returns {boolean} true=允许，false=denylist/入参非法（fail-closed）
 */
export function isAgentRouteAllowed(method, pathname) {
  const verb = typeof method === 'string' ? method.trim().toUpperCase() : '';
  if (!verb) return false;
  const path = normalizeAgentPath(pathname);
  if (!path) return false;

  // 1) /api/agent/*：GET/HEAD status、health 只读放行；POST 仅放行“创建计划待审批请求”这一精确路径；
  //    pair/jobs/plan-requests 的读与 decision 等（含非 GET 的 status）全部拒绝。
  if (matchesPrefix(path, AGENT_ROUTE_PREFIX)) {
    if (isReadMethod(verb) && PUBLIC_AGENT_ROUTE_SET.has(path)) return true;
    return verb === 'POST' && path === AGENT_PLAN_REQUEST_CREATE_ROUTE;
  }
  // 2) 设置/Provider 面：Agent 不负责改 Runtime 配置，读写都不给。
  if (DENIED_ROUTE_PREFIXES.some((prefix) => matchesPrefix(path, prefix))) return false;
  // 3) 签核/终审/下单确认/文件下载/诊断包：任何方法都拒绝（子树 fail-closed）。
  if (DENIED_ROUTE_TREES.some((tree) => matchesTree(path, tree))) return false;
  // 3.5) 对话审批豁免：仅 POST 精确路径（含归一化后的尾斜杠）；GET/HEAD、子路径、其他方法拒绝。
  if (AGENT_CHAT_APPROVAL_ROUTES.some((route) => matchesTree(path, route))) {
    return verb === 'POST' && CHAT_APPROVAL_ROUTE_SET.has(path);
  }
  // 4) 写门禁：只读快照可看；POST 及其他写语义会改变写权限，拒绝。
  if (matchesTree(path, WRITE_GATE_ROUTE) && !isReadMethod(verb)) return false;

  // denylist 之外默认放行（真正的路由存在性与 404 仍由 server 分发决定）。
  return true;
}

/**
 * server 侧便捷断言：不允许时抛结构化错误（403），由既有错误映射返回 `{ok:false,code,...}`。
 *
 * @throws {Error & {code:string,status:number}}
 */
export function assertAgentRouteAllowed(method, pathname) {
  if (isAgentRouteAllowed(method, pathname)) return true;
  throw Object.assign(new Error(`Agent令牌无权访问该路由：签核/下单确认、设置与文件下载只能由本机用户完成；对话审批只允许 POST /api/design/approve、/api/pcb/approve；计划待审批只允许 POST ${AGENT_PLAN_REQUEST_CREATE_ROUTE}`), {
    code: AGENT_AUTH_CODES.ROUTE_FORBIDDEN,
    status: 403,
  });
}
