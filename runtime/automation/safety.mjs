/**
 * 自动化安全边界（Phase 0 内核）。
 *
 * 为什么单独一个文件：GUI 通道（`runtime/eda-gui.mjs`）能发受信任的鼠标键盘事件，
 * 对 EDA 来说等价于真人在点。如果把它直接交给 AI 自由使用，最坏情况不是"点错菜单"，
 * 而是**删工程、退出、点支付**。所以自动化执行器必须过这一层闸：
 *
 *   1. 动作分级（read / write / destructive / debug），写入必须带批准；
 *   2. `eval` 默认禁用（它是任意 JS 执行），只有显式调试开关才放行；
 *   3. 危险文案黑名单：点/输入"支付/下单/删除/退出/覆盖保存"一律拒绝；
 *   4. 危险快捷键黑名单：Cmd+Q / Cmd+W / Alt+F4 这类会关窗口的不允许；
 *   5. 目标锁定：只允许操作 EDA 页面（url/title 命中 allowlist），不碰浏览器别的标签。
 *
 * 这里的原则和仓库其它门禁一致：**拒绝要给出可复核的 code，不能静默降级**。
 */

/** 允许的 GUI 动作（与 eda-gui.mjs 的白名单对齐，但 eval 被单独摘出来）。 */
export const SAFE_GUI_ACTIONS = Object.freeze([
  'state', 'targets', 'screenshot',
  'click', 'dblclick', 'drag', 'move',
  'type', 'key', 'shortcut',
  'clickText', 'waitText', 'focus', 'launch', 'findTexts',
]);

/** 调试专用动作：默认禁用，必须设置 CIRCUITPILOT_GUI_DEBUG=1。 */
export const DEBUG_GUI_ACTIONS = Object.freeze(['eval']);

/** 动作分级：destructive 必须显式批准；write 需要 write 批准；read 无需批准。 */
export const GUI_ACTION_CLASS = Object.freeze({
  state: 'read',
  targets: 'read',
  screenshot: 'read',
  move: 'read',
  waitText: 'read',
  findTexts: 'read',
  focus: 'read',
  click: 'write',
  dblclick: 'write',
  drag: 'write',
  type: 'write',
  key: 'write',
  shortcut: 'write',
  clickText: 'destructive',
  launch: 'write',
  eval: 'debug',
});

/** 人工批准作用域：与产品里保留的三次批准一致（计划 / 写板 / 放行）。 */
export const APPROVAL_SCOPES = Object.freeze(['plan', 'write', 'release']);

/**
 * 危险文案：出现在 clickText 的目标文本里就拒绝。
 * 注意：这不是"猜用户意图"，而是硬性红线——这些入口一旦被自动化点到，
 * 损失不可逆（删工程/下单/支付/退出丢失未保存内容）。
 */
export const DANGEROUS_TEXTS = Object.freeze([
  // 支付/下单：任何"把板子变成真实订单"的入口都永久禁入（G2 红线，不是功能开关）。
  /支付/i, /付款/i, /下单/i, /结算/i, /收银/i, /采购单/i, /立即购买/i,
  /提交订单/i, /确认订单/i, /确认支付/i, /去支付/i, /继续支付/i, /提交支付/i,
  /place\s*order/i, /checkout/i, /check\s*out/i, /pay\s*now/i, /confirm\s*payment/i, /purchase/i,
  // 删除/退出/覆盖：会丢未保存工作或删工程。
  /删除/i, /移除工程/i, /清空工程/i, /格式化/i,
  /退出/i, /关闭工程/i, /覆盖保存/i, /另存为/i,
  /uninstall/i, /delete project/i,
]);

/**
 * 支付/下单确认页的 URL/标题特征：即使配方里没有 clickText（例如直接导航到收银台），
 * 目标命中这些特征也必须停手——这是"看得见的停止条件"，不是靠文案黑名单兜底。
 */
export const CHECKOUT_URL_PATTERNS = Object.freeze([
  /checkout/i, /payment/i, /pay\./i, /cashier/i, /settle/i, /order[\/._-]?(confirm|submit|pay)/i,
  /收银/i, /支付/i, /下单/i, /订单确认/i, /结算/i,
]);

/** 危险快捷键：直接关闭窗口/退出应用/关闭文档。 */
const FORBIDDEN_SHORTCUT_KEYS = new Set(['q', 'w', 'f4']);

/** EDA 页面识别：命中任意一条即认为是 EDA 目标。 */
export const EDA_TARGET_PATTERNS = Object.freeze([
  /easyeda\.com/i,
  /lceda\.cn/i,
  /easyeda/i,
  /嘉立创\s*EDA/i,
  /立创\s*EDA/i,
]);

const code = (message, name, extra = {}) => Object.assign(new Error(message), { code: name, ...extra });

/** GUI 动作是否允许执行（不传 approve 时默认只允许 read）。 */
export function assertGuiActionAllowed(action, { allowEval = false } = {}) {
  const name = String(action || '');
  if (DEBUG_GUI_ACTIONS.includes(name)) {
    if (allowEval) return { action: name, class: 'debug' };
    throw code(`GUI 动作 ${name} 是任意 JS 执行，默认禁用（调试需显式开启）`, 'AUTOMATION_EVAL_DISABLED', { allowed: SAFE_GUI_ACTIONS });
  }
  if (!SAFE_GUI_ACTIONS.includes(name)) {
    throw code(`GUI 动作未在自动化白名单内：${name}`, 'AUTOMATION_GUI_ACTION_NOT_ALLOWED', { allowed: SAFE_GUI_ACTIONS });
  }
  return { action: name, class: GUI_ACTION_CLASS[name] || 'write' };
}

/** 判断一个 GUI 动作需要哪个批准作用域；read 返回 null。 */
export function requiredApprovalFor(action) {
  const cls = GUI_ACTION_CLASS[String(action || '')] || 'write';
  if (cls === 'read') return null;
  if (cls === 'destructive') return 'write';
  if (cls === 'debug') return 'write';
  return 'write';
}

/** 检查文本里有没有危险指令（用于 clickText 的 target）。 */
export function findDangerousText(text) {
  const value = String(text ?? '');
  for (const pattern of DANGEROUS_TEXTS) {
    const match = value.match(pattern);
    if (match) return { pattern: String(pattern), matched: match[0] };
  }
  return null;
}

/** 危险文本必须拒绝；空文本交给参数校验。 */
export function assertSafeText(text) {
  const danger = findDangerousText(text);
  if (danger) {
    throw code(`拒绝对危险入口执行自动化操作：命中「${danger.matched}」`, 'AUTOMATION_DANGEROUS_TEXT', { matched: danger.matched });
  }
}

/** 快捷键：只禁止真正会关窗口/退出/关闭文档的组合。 */
export function assertShortcutAllowed({ key, modifiers = [] } = {}) {
  const normalized = String(key || '').toLowerCase();
  const mods = Array.isArray(modifiers) ? modifiers.map((item) => String(item).toLowerCase()) : [];
  const destructiveModifier = mods.includes('meta') || mods.includes('ctrl');
  if (destructiveModifier && FORBIDDEN_SHORTCUT_KEYS.has(normalized)) {
    throw code(`拒绝危险快捷键：${mods.join('+')}+${normalized}`, 'AUTOMATION_SHORTCUT_FORBIDDEN', { key: normalized, modifiers: mods });
  }
  return { key: normalized, modifiers: mods };
}

/** 目标锁定：只允许 EDA 页面。target 可以是 {url,title} 或字符串。 */
export function assertEdaTarget(target) {
  const url = typeof target === 'string' ? target : String(target?.url || '');
  const title = typeof target === 'string' ? '' : String(target?.title || '');
  const haystack = `${url} ${title}`;
  if (!EDA_TARGET_PATTERNS.some((pattern) => pattern.test(haystack))) {
    throw code(`自动化目标不是嘉立创EDA页面：${haystack.slice(0, 200)}`, 'AUTOMATION_TARGET_NOT_EDA');
  }
  return { url, title };
}

/**
 * 目标是否已经进入支付/下单确认页。命中即返回 {matched, haystack}，否则 null。
 * 与 `assertEdaTarget` 不同：这是"停手条件"，与目标是不是 EDA 无关。
 */
export function findCheckoutTarget(target) {
  const url = typeof target === 'string' ? target : String(target?.url || '');
  const title = typeof target === 'string' ? '' : String(target?.title || '');
  const haystack = `${url} ${title}`.trim();
  if (!haystack) return null;
  for (const pattern of CHECKOUT_URL_PATTERNS) {
    const match = haystack.match(pattern);
    if (match) return { pattern: String(pattern), matched: match[0], haystack: haystack.slice(0, 300) };
  }
  return null;
}

/** 已进入支付/下单确认页必须停手：任何配方都不允许越过参数卡完成下单。 */
export function assertNotCheckoutTarget(target) {
  const signal = findCheckoutTarget(target);
  if (signal) {
    throw code(`拒绝在支付/下单确认页执行自动化：命中「${signal.matched}」`, 'AUTOMATION_CHECKOUT_BLOCKED', { matched: signal.matched, url: signal.haystack });
  }
  return true;
}

/** 批准检查：required ⊆ approvals（值为 true 才算数）。 */
export function assertApprovals(approvals, required = []) {
  const granted = approvals && typeof approvals === 'object' ? approvals : {};
  const missing = required.filter((scope) => !APPROVAL_SCOPES.includes(scope) || granted[scope] !== true);
  if (missing.length) {
    const message = `缺少人工批准：${missing.join('、')}`;
    throw code(message, 'AUTOMATION_APPROVAL_REQUIRED', { required: [...new Set(required)], missing, granted });
  }
  return true;
}

/** 汇总一次配方所需的全部批准作用域（供 runner 预检）。 */
export function collectRequiredApprovals(steps = []) {
  const required = new Set();
  for (const step of steps) {
    if (step?.approval && APPROVAL_SCOPES.includes(step.approval)) required.add(step.approval);
    if (step?.action?.kind === 'gui') {
      const need = requiredApprovalFor(step.action.action);
      if (need) required.add(need);
    }
    if (step?.action?.kind === 'human') {
      // 人工步骤本身就是"请人处理"，不需要预先批准
      continue;
    }
  }
  return [...required];
}
