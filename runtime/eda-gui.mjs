import { spawn } from 'node:child_process';
import { EDA_APP_CANDIDATES } from './config.mjs';

/**
 * EDA GUI 通道（通道 B）——**CircuitPilot 运行时自己的 GUI 执行器**。
 *
 * 为什么需要它：桥接通道（`runtime/bridge.mjs`，49620）只能执行 `eda.*` 扩展 API；
 * 而铺铜、交互式连线、菜单/对话框这类动作在 EDA V3.2.186 里**没有可用的扩展 API**
 * （`pcb_PrimitivePour.create` 全参数组合实测均抛"无法创建覆铜边框图元"）。
 * 真机唯一可靠的办法是让 EDA 以调试端口启动，由本模块通过 Chrome DevTools Protocol
 * 发送**受信任输入事件**（Input.dispatchMouseEvent / dispatchKeyEvent）——对 EDA 而言
 * 与真人点击完全等价。
 *
 * 边界（必须守住）：
 * - 本模块只做"操作 + 读回状态"，不做任何设计判断；
 * - 每个动作都返回 EDA 侧可复核的读数（url / 文本 / 截图），禁止"调用没报错就当真成功"；
 * - 动作必须白名单化：GUI 通道能点任何东西，绝不能开成任意代码执行后门。
 */

export const DEFAULT_CDP_PORT = Number.parseInt(process.env.CIRCUITPILOT_EDA_CDP_PORT || '9222', 10);

/** GUI 动作白名单。新增动作必须同时补测试，否则等于开后门。 */
export const GUI_ACTIONS = Object.freeze([
  'state', 'click', 'dblclick', 'drag', 'move', 'type', 'key', 'shortcut', 'eval', 'screenshot',
  'clickText', 'waitText', 'launch', 'targets', 'focus', 'findTexts', 'ercDetail',
]);

/** CDP 修饰键位掩码：Alt=1 / Ctrl=2 / Meta(Command)=4 / Shift=8。 */
const MODIFIER_BITS = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 });

/**
 * 组合键描述符：只允许「已登记功能键」或「单个字母数字」＋已登记修饰键。
 * 白名单化的目的是让 GUI 通道能发 Cmd+S / Cmd+Z 这类必备快捷键，同时不变成任意键注入。
 */
export function shortcutSpec(key, modifiers = []) {
  const list = Array.isArray(modifiers) ? modifiers : [];
  let bits = 0;
  for (const mod of list) {
    const bit = MODIFIER_BITS[String(mod).toLowerCase()];
    if (!bit) {
      throw new EdaGuiError(`不支持的修饰键：${String(mod)}`, 'EDA_GUI_UNSUPPORTED_MODIFIER', { supported: Object.keys(MODIFIER_BITS) });
    }
    bits |= bit;
  }
  const raw = String(key ?? '');
  if (KEY_CODES[raw]) {
    return { spec: { ...KEY_CODES[raw], modifiers: bits }, modifiers: bits, key: raw };
  }
  if (!/^[a-z0-9]$/i.test(raw)) {
    throw new EdaGuiError(`组合键只支持单个字母数字或已登记功能键：${raw}`, 'EDA_GUI_UNSUPPORTED_KEY', { supported: [...Object.keys(KEY_CODES), 'a-z', '0-9'] });
  }
  const upper = raw.toUpperCase();
  const code = /[0-9]/.test(raw) ? `Digit${raw}` : `Key${upper}`;
  return {
    spec: { key: upper, code, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers: bits },
    modifiers: bits,
    key: raw,
  };
}

const KEY_CODES = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
});

export class EdaGuiError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'EdaGuiError';
    this.code = code;
    if (detail) {
      this.detail = detail;
      // 同时暴露 details：HTTP 错误信封统一读 error.details，真机排查要能直接看到允许清单/参数。
      this.details = detail;
    }
  }
}

/** 子进程环境里必须剥掉 ELECTRON_RUN_AS_NODE：带着它启动 EDA，主进程会退化成 Node 直接退出。 */
export function stripChildEnv(env = process.env) {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

export function launchArgs(debugPort) {
  return [`--remote-debugging-port=${debugPort}`];
}

export function assertGuiAction(action) {
  if (!GUI_ACTIONS.includes(action)) {
    throw new EdaGuiError(`GUI 动作未在白名单内：${String(action)}`, 'EDA_GUI_ACTION_NOT_ALLOWED', { allowed: GUI_ACTIONS });
  }
}

/** 极简 CDP 会话：只保留本模块需要的 send/evaluate/close，避免把 devtools 客户端依赖引进运行时。 */
export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this._id = 0;
    this._pending = new Map();
    this.executionContexts = [];
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id && this._pending.has(message.id)) {
        this._pending.get(message.id)(message);
        this._pending.delete(message.id);
      }
      if (message.method === 'Runtime.executionContextCreated') this.executionContexts.push(message.params.context);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new EdaGuiError('CDP WebSocket 连接失败', 'EDA_GUI_CDP_CONNECT_FAILED')), { once: true });
    });
    const session = new CdpSession(ws);
    await session.send('Runtime.enable');
    return session;
  }

  send(method, params = {}, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const id = this._id += 1;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new EdaGuiError(`CDP 调用超时：${method}`, 'EDA_GUI_CDP_TIMEOUT', { method }));
      }, timeoutMs);
      this._pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new EdaGuiError(message.error.message || 'CDP 错误', 'EDA_GUI_CDP_ERROR', message.error));
        else resolve(message.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * 找到"外壳页面"的执行上下文。
   *
   * 真机教训：EDA 页面里存在多个执行上下文，PCB 画布那层 iframe 的
   * `location.href` 是 `https://pro.lceda.cn/editor?entry=pcb` 且 body 为空；
   * 只按 "包含 /editor" 取第一个会选中它，于是读状态永远拿到空文本、
   * 点菜单也点不到任何元素。这里按"是否带工程 hash / 是否 cll 外壳 / 是否有正文"打分取最优。
   */
  async editorContextId({ retries = 12, intervalMs = 250 } = {}) {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      let best = null;
      for (const context of this.executionContexts) {
        try {
          const info = await this.evaluate(`({ href: location.href, textLength: (document.body && document.body.innerText ? document.body.innerText.length : 0) })`, context.id);
          if (!String(info?.href || '').includes('/editor')) continue;
          const score = (String(info.href).includes('#id=') ? 3 : 0)
            + (String(info.href).includes('cll=') ? 2 : 0)
            + (Number(info.textLength) > 200 ? 1 : 0);
          if (!best || score > best.score) best = { id: context.id, score, href: info.href };
        } catch { /* 上下文可能已销毁，继续找 */ }
      }
      if (best) return best.id;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new EdaGuiError('未找到 EDA 编辑器执行上下文', 'EDA_GUI_NO_EDITOR_CONTEXT');
  }

  async evaluate(expression, contextId) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      // 真机验收（第 60 轮）：只报 "页面脚本执行出错" 无法定位问题；把页面异常描述带进 message，
      // 原始 exceptionDetails 仍放在 details 里，便于还原 DOM/堆栈。
      const description = result.exceptionDetails?.exception?.description
        || result.exceptionDetails?.exception?.value
        || result.exceptionDetails?.text
        || 'unknown';
      throw new EdaGuiError(`页面脚本执行出错：${String(description).slice(0, 300)}`, 'EDA_GUI_EVAL_FAILED', result.exceptionDetails);
    }
    return result.result?.value;
  }

  close() {
    try { this.ws.close(); } catch { /* 忽略 */ }
  }
}

/** 在本机 127.0.0.1 上探测 CDP HTTP 端点。 */
async function fetchJson(url, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new EdaGuiError(`CDP HTTP ${response.status}`, 'EDA_GUI_CDP_HTTP_ERROR', { url, status: response.status });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class EdaGuiClient {
  constructor({
    cdpPort = DEFAULT_CDP_PORT,
    appCandidates = EDA_APP_CANDIDATES,
    sessionFactory = (wsUrl) => CdpSession.connect(wsUrl),
    spawnImpl = spawn,
    fetchJsonImpl = fetchJson,
    logger = console,
  } = {}) {
    this.cdpPort = cdpPort;
    this.appCandidates = appCandidates;
    this.sessionFactory = sessionFactory;
    this.spawnImpl = spawnImpl;
    this.fetchJsonImpl = fetchJsonImpl;
    this.logger = logger;
    this._session = null;
    this._wsUrl = null;
  }

  async targets() {
    return this.fetchJsonImpl(`http://127.0.0.1:${this.cdpPort}/json`);
  }

  /** 选一个页面目标：优先已打开工程的窗口（URL 带 #id=），否则取第一个编辑器页。 */
  async pickPage() {
    let list;
    try {
      list = await this.targets();
    } catch (error) {
      throw new EdaGuiError('EDA 未开启调试端口（GUI 通道不可用）', 'EDA_GUI_CDP_UNAVAILABLE', { port: this.cdpPort, cause: error?.code });
    }
    const pages = list.filter((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    if (!pages.length) throw new EdaGuiError('EDA 没有可用的页面目标', 'EDA_GUI_NO_PAGE');
    const withProject = pages.find((item) => String(item.url || '').includes('#id='));
    return withProject || pages[0];
  }

  async session() {
    const page = await this.pickPage();
    if (this._session && this._wsUrl === page.webSocketDebuggerUrl) return this._session;
    this._session?.close();
    this._wsUrl = page.webSocketDebuggerUrl;
    this._session = await this.sessionFactory(page.webSocketDebuggerUrl);
    return this._session;
  }

  async contextId() {
    const session = await this.session();
    if (!this._contextId) this._contextId = await session.editorContextId();
    return this._contextId;
  }

  async evaluate(expression) {
    const run = async () => {
      const session = await this.session();
      const contextId = await this.contextId();
      return session.evaluate(expression, contextId);
    };
    try {
      return await run();
    } catch {
      /**
       * 页面重载/换窗口会让缓存的 session 与 contextId 失效。GUI 通道必须能自愈一次，
       * 否则每次 EDA 刷新后调用方都得手动重启运行时（真机踩过）。
       */
      this._session?.close?.();
      this._session = null;
      this._wsUrl = null;
      this._contextId = null;
      return run();
    }
  }

  /** 找到元素中心点（CSS 像素，相对页面视口）。精确匹配优先，找不到再退化为包含匹配。 */
  async locate({ text, exact = true, selector = null, index = 0 }) {
    const payload = await this.evaluate(`(function(){
      const selector = ${JSON.stringify(selector)};
      const text = ${JSON.stringify(text)};
      const exact = ${JSON.stringify(exact)};
      const index = ${JSON.stringify(index)};
      let nodes = selector ? [...document.querySelectorAll(selector)] : [...document.querySelectorAll('*')];
      if (text) {
        const want = String(text).trim();
        const matched = nodes.filter((e) => {
          if (e.children && e.children.length) return false;
          const value = (e.textContent || '').trim();
          return exact ? value === want : value.includes(want);
        });
        if (!matched.length) {
          const anyMatched = nodes.filter((e) => {
            const value = (e.textContent || '').trim();
            return exact ? value === want : value.includes(want);
          });
          nodes = anyMatched;
        } else {
          nodes = matched;
        }
      }
      const el = nodes[index];
      if (!el) return { found: false, count: nodes.length };
      const rect = el.getBoundingClientRect();
      return { found: true, count: nodes.length, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80) };
    })()`);
    if (!payload?.found) throw new EdaGuiError(`找不到元素：${text || selector}`, 'EDA_GUI_ELEMENT_NOT_FOUND', payload);
    return payload;
  }

  async dispatchMouse(type, x, y, { button = 'left', clickCount = 1 } = {}) {
    const session = await this.session();
    await session.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: type === 'mousePressed' ? 1 : 0 });
  }

  async click({ x, y, text, exact = true, selector = null, index = 0 }) {
    let point = { x, y };
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const located = await this.locate({ text, exact, selector, index });
      point = { x: located.x, y: located.y };
    }
    await this.dispatchMouse('mouseMoved', point.x, point.y);
    await this.dispatchMouse('mousePressed', point.x, point.y);
    await this.dispatchMouse('mouseReleased', point.x, point.y);
    await sleep(120);
    return { clicked: true, x: point.x, y: point.y };
  }

  async dblclick({ x, y, text, exact = true, selector = null, index = 0 }) {
    let point = { x, y };
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const located = await this.locate({ text, exact, selector, index });
      point = { x: located.x, y: located.y };
    }
    await this.dispatchMouse('mouseMoved', point.x, point.y);
    for (const count of [1, 2]) {
      await this.dispatchMouse('mousePressed', point.x, point.y, { clickCount: count });
      await this.dispatchMouse('mouseReleased', point.x, point.y, { clickCount: count });
      await sleep(80);
    }
    await sleep(150);
    return { doubleClicked: true, x: point.x, y: point.y };
  }

  /** 拖拽：EDA 的矩形铺铜/框选都靠它。步进很重要，一步跳到终点不会触发拖拽语义。 */
  async drag({ x1, y1, x2, y2, steps = 24 }) {
    for (const value of [x1, y1, x2, y2]) {
      if (!Number.isFinite(value)) throw new EdaGuiError('拖拽需要 x1,y1,x2,y2', 'EDA_GUI_INVALID_PARAMS', { x1, y1, x2, y2 });
    }
    const session = await this.session();
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 1 });
    for (let step = 1; step <= steps; step += 1) {
      const x = x1 + ((x2 - x1) * step) / steps;
      const y = y1 + ((y2 - y1) * step) / steps;
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(12);
    }
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(200);
    return { dragged: true, from: [x1, y1], to: [x2, y2] };
  }

  /**
   * 只移动鼠标（不按键）。用于读 EDA 状态栏的 X/Y 读数来标定"画布坐标 ↔ 屏幕像素"，
   * 也是画线前把光标停到引脚上的必要动作。
   */
  async moveTo({ x, y }) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new EdaGuiError('move 需要 x,y 数值', 'EDA_GUI_INVALID_PARAMS', { x, y });
    }
    const session = await this.session();
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await sleep(120);
    return { moved: true, x, y };
  }

  /**
   * 把页面激活到前台并强制 lifecycle=active。
   * 真机踩过：EDA 窗口在后台时 document.visibilityState==='hidden'，浏览器会节流渲染与
   * 事件处理，表现为「DOM 菜单点击有效、画布点击/坐标读数全部失效」——不是 EDA 的问题，
   * 是页面没在前台。画布类操作前必须先 focus。
   */
  async focus() {
    const session = await this.session();
    let broughtToFront = false;
    let lifecycleActive = false;
    let focusEmulated = false;
    try { await session.send('Page.bringToFront', {}); broughtToFront = true; } catch { /* 老版本 CDP 可能不支持 */ }
    try { await session.send('Page.setWebLifecycleState', { state: 'active' }); lifecycleActive = true; } catch { /* 非实验域，忽略 */ }
    try { await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }); focusEmulated = true; } catch { /* 同上 */ }
    await sleep(200);
    const visibility = await this.evaluate('document.visibilityState');
    return { focused: true, broughtToFront, lifecycleActive, focusEmulated, visibility };
  }

  async typeText({ text }) {
    if (typeof text !== 'string' || !text.length) throw new EdaGuiError('type 需要非空 text', 'EDA_GUI_INVALID_PARAMS');
    const session = await this.session();
    await session.send('Input.insertText', { text });
    return { typed: text.length };
  }

  async key({ key }) {
    const spec = KEY_CODES[key];
    if (!spec) throw new EdaGuiError(`不支持的按键：${String(key)}`, 'EDA_GUI_UNSUPPORTED_KEY', { supported: Object.keys(KEY_CODES) });
    const session = await this.session();
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
    await sleep(120);
    return { pressed: key };
  }

  /**
   * 组合键（如 Cmd/Ctrl+S、Cmd/Ctrl+Z）。用 rawKeyDown 保证不会把字母当文本插进画布，
   * 修饰位按 CDP 约定传入（Alt=1 / Ctrl=2 / Meta=4 / Shift=8）。
   */
  async shortcut({ key, modifiers }) {
    const { spec, modifiers: bits } = shortcutSpec(key, modifiers);
    const session = await this.session();
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...spec });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, modifiers: bits });
    await sleep(150);
    return { pressed: key, modifiers: bits };
  }

  async state() {
    const payload = await this.evaluate(`(function(){
      const text = document.body.innerText || '';
      const tabs = [...document.querySelectorAll('*')]
        .filter((e) => !e.children.length && /^(Schematic|PCB|Board)/.test((e.textContent || '').trim()))
        .map((e) => (e.textContent || '').trim())
        .slice(0, 12);
      return {
        url: location.href,
        online: text.includes('全在线'),
        offline: text.includes('全离线'),
        projectOpen: /#id=/.test(location.href),
        hasProjectText: text.includes('智能衣橱助手'),
        tabs,
        text: text.replace(/\\n/g, ' | ').slice(0, 400),
      };
    })()`);
    return payload;
  }

  async screenshot() {
    const session = await this.session();
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    return { base64: shot.data, bytes: Math.floor((shot.data.length * 3) / 4) };
  }

  /**
   * 抓原理图 ERC 的**逐条明细**（EDA 扩展 API 只有聚合计数，明细在检查面板 DOM 里）。
   *
   * 只读：先找面板；面板里没有结论时点一次「检查ERC/检查DRC」触发，再轮询计数
   * （最长 timeoutMs 毫秒）。抓不到就如实返回 `{ok:false, reason}`，不编造条目。
   * 返回结构：{ ok, counts:{total,fatal,error,warning,info}, items:[{level,message,object?}], source:'ui-dom' }
   */
  async ercDetail({ timeoutMs = 25_000, expectedCounts = null } = {}) {
    /**
     * 真机验收（第 60 轮）重写。原先一整段页面 async 脚本在真机上暴露两个致命问题：
     *   1) 模板字面量把 \r/\s/\d 在宿主侧吃掉了 → 页面直接 SyntaxError，明细永远抓不到；
     *   2) 面板定位太松：EDA 里同时存在多个「检查DRC / 检查ERC」面板（含 PCB DRC、器件标准化），
     *      且普通 DOM click() 不是受信任输入，EDA 的检查可能根本不触发。
     * 现在改为宿主侧编排：页面只做只读快照（可见面板的按钮坐标/计数/文本），
     * 点击用 CDP 受信任输入，轮询与稳定性判断在宿主侧完成。
     *
     * 真机事实（第 60 轮实测）：**原理图**里的检查面板按钮文案也是「检查DRC」，
     * 结果计数就是 ERC 的 1 error / 34 warning；所以这里按"当前可见的检查面板"定位，
     * 由调用方（ERC 路由）先确保活动文档是原理图——不能用隐藏的旧面板冒充。
     */
    const budget = Math.max(2_000, Math.min(Number(timeoutMs) || 25_000, 120_000));
    const startedAtForWait = Date.now();
    const scan = async () => this.evaluate(String.raw`(function(){
      const textOf = (el) => ((el && (el.textContent || el.innerText)) || '').replace(/\r/g, '');
      // 避免在"宿主模板 + 页面字符串"两层转义里绕圈：直接按字符找 label 后的括号数字。
      // 「错误(」会先命中「致命错误(」，所以带关键前缀的标签按"前一个字符不是前缀末字"过滤。
      const countsOf = (text) => {
        const findAfter = (label, skipWhenPrecededBy = null) => {
          let from = 0;
          while (true) {
            const at = text.indexOf(label + '(', from);
            if (at < 0) return null;
            const preceded = at > 0 ? text.slice(Math.max(0, at - skipWhenPrecededBy?.length || 0), at) : '';
            if (!skipWhenPrecededBy || preceded !== skipWhenPrecededBy) {
              let index = at + label.length + 1;
              let digits = '';
              while (index < text.length && /[0-9]/.test(text[index])) { digits += text[index]; index += 1; }
              return digits ? Number(digits) : null;
            }
            from = at + 1;
          }
        };
        return {
          total: findAfter('全部'),
          fatal: findAfter('致命错误'),
          error: findAfter('错误', '致命'),
          warning: findAfter('警告'),
          info: findAfter('信息'),
        };
      };
      // 面板根节点：检查面板的「计数 + 明细」在同一个 .log-container 里；
      // 只找到左侧按钮栏的话，明细永远抓不到。
      const panelRootOf = (button) => {
        let node = button.parentElement;
        let fallback = null;
        for (let depth = 0; depth < 10 && node; depth += 1) {
          const panelText = textOf(node);
          if (panelText.includes('全部(')) {
            // 真机实测：左侧计数栏的 class 也含 "log-container-left_*"，不能用子串匹配，
            // 必须精确到 token "log-container"（它才是同时含计数与明细的面板根）。
            if ((' ' + String(node.className || '') + ' ').includes(' log-container ')) return node;
            if (!fallback && panelText.length > 200) fallback = node;
          }
          node = node.parentElement;
        }
        return fallback;
      };
      const out = [];
      for (const el of document.querySelectorAll('button')) {
        const label = (el.textContent || '').trim();
        if (label !== '检查DRC' && label !== '检查ERC') continue;
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;
        const panel = panelRootOf(el);
        if (panel) {
          const panelText = textOf(panel);
          out.push({ label, counts: countsOf(panelText), x: r.x + r.width / 2, y: r.y + r.height / 2, panelLength: panelText.length, panelText: panelText.slice(0, 4000) });
        }
      }
      return out;
    })()`);
    // 期望的 ERC 聚合计数（来自 EDA 的 schematic.drc）：用来把"本页的 ERC 面板"和
    // EDA 里同时存在的 PCB DRC / 其它文档的旧面板区分开。真机踩过：切页瞬间点到 PCB 面板的
    // 「检查DRC」会把活动文档切回 PCB，随后指纹校验失败、整次明细作废（还白等 40 秒）。
    const expected = expectedCounts && typeof expectedCounts === 'object' ? expectedCounts : null;
    const expectedNumbers = expected ? {
      fatal: Number(expected.fatal) || 0,
      error: Number(expected.error) || 0,
      warning: Number(expected.warning) || 0,
    } : null;
    const matchesExpected = (counts) => {
      if (!expectedNumbers) return Number(counts?.total) > 0;
      return Number(counts?.fatal ?? null) === expectedNumbers.fatal
        && Number(counts?.error ?? null) === expectedNumbers.error
        && Number(counts?.warning ?? null) === expectedNumbers.warning;
    };
    const pickMatch = (list) => list.find((item) => matchesExpected(item.counts)) || null;
    let panel = pickMatch(await scan());
    const discoverStarted = Date.now();
    while (!panel && Date.now() - discoverStarted < 8_000) {
      await sleep(400);
      panel = pickMatch(await scan());
    }
    if (!panel) {
      // 没有匹配面板：如果只有一个"空"的可见检查面板，可能是第一次检查、面板还没出结果。
      // 用受信任鼠标事件点一次让它现场跑；但**绝不在多面板/计数不符时乱点**（会切错文档）。
      const candidates = await scan();
      if (candidates.length === 1 && !Number(candidates[0]?.counts?.total)) {
        await this.click({ x: candidates[0].x, y: candidates[0].y });
        const waitUntil = Date.now() + Math.min(20_000, budget);
        while (Date.now() < waitUntil && !panel) {
          await sleep(500);
          panel = pickMatch(await scan());
        }
      }
    }
    if (!panel) return { ok: false, reason: 'ERC_PANEL_NOT_READY', expected: expectedNumbers, items: [] };
    // 计数稳定：确认不是"检查中"的中间态（最多等 5s，避免长任务把预算吃光）。
    const stableStarted = Date.now();
    let last = JSON.stringify(panel.counts || {});
    let stable = 0;
    while (Date.now() - stableStarted < Math.min(5_000, budget)) {
      await sleep(300);
      const current = pickMatch(await scan());
      if (!current) break;
      panel = current;
      const checking = /检查中|正在检查|运行中/.test(String(current.panelText || ''));
      const snapshot = JSON.stringify(current.counts || {});
      if (!checking && snapshot === last) { stable += 1; if (stable >= 2) break; } else { stable = 0; last = snapshot; }
    }
    const detail = await this.evaluate(String.raw`(async function(){
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const textOf = (el) => ((el && (el.textContent || el.innerText)) || '').replace(/\r/g, '');
      const levelOf = (raw) => {
        const value = String(raw || '').toLowerCase();
        if (value.includes('致命') || value === 'fatal') return 'fatal';
        if (value.includes('错误') || value === 'error' || value === 'err') return 'error';
        if (value.includes('警告') || value === 'warn' || value === 'warning') return 'warning';
        return 'info';
      };
      const panelRootOf = (button) => {
        let node = button.parentElement;
        let fallback = null;
        for (let depth = 0; depth < 12 && node; depth += 1) {
          const panelText = textOf(node);
          if (panelText.includes('全部(')) {
            if ((' ' + String(node.className || '') + ' ').includes(' log-container ')) return node;
            if (!fallback && panelText.length > 200) fallback = node;
          }
          node = node.parentElement;
        }
        return fallback;
      };
      let panel = null;
      for (const el of document.querySelectorAll('button')) {
        const label = (el.textContent || '').trim();
        if (label !== '检查DRC' && label !== '检查ERC') continue;
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;
        panel = panelRootOf(el);
        if (panel) break;
      }
      if (!panel) return { ok: false, reason: 'PANEL_DISAPPEARED', items: [] };
      // 真机实测：明细列表是虚拟滚动列表（37 条只渲染 ~8 条，scrollHeight 是总高度）。
      // 只查一次 DOM 只能拿到可见的几行，必须逐屏滚动收集；滚回顶部还原界面。
      const countsOf = (text) => {
        const pick = (label) => {
          const at = text.indexOf(label + '(');
          if (at < 0) return null;
          let index = at + label.length + 1;
          let digits = '';
          while (index < text.length && /[0-9]/.test(text[index])) { digits += text[index]; index += 1; }
          return digits ? Number(digits) : null;
        };
        return { total: pick('全部'), fatal: pick('致命错误'), error: pick('错误'), warning: pick('警告'), info: pick('信息') };
      };
      const expected = countsOf(textOf(panel)) || {};
      const items = [];
      const seen = new Set();
      const collect = () => {
        for (const el of panel.querySelectorAll('*')) {
          const t = (el.textContent || '').trim();
          if (t.length < 3 || t.length > 4000) continue;
          const m = t.match(/\[(致命错误|错误|警告|信息)\]\s*[:：]?\s*([\s\S]+)$/);
          if (!m) continue;
          if (/\[(致命错误|错误|警告|信息)\]/.test(m[2])) continue;
          const message = m[2].trim();
          if (message.length < 5) continue;
          const key = m[1] + '|' + message.slice(0, 200);
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ level: levelOf(m[1]), message: message.slice(0, 400) });
        }
      };
      const collectPass = async () => {
        const scrollable = [...panel.querySelectorAll('*')]
          .filter((el) => el.scrollHeight > el.clientHeight + 20)
          .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
        if (!scrollable) { collect(); return; }
        scrollable.scrollTop = 0;
        await sleep(180);
        collect();
        const step = Math.max(60, Math.floor(scrollable.clientHeight * 0.7));
        for (let top = scrollable.clientHeight; top <= scrollable.scrollHeight + step; top += step) {
          scrollable.scrollTop = top;
          await sleep(200);
          collect();
        }
        scrollable.scrollTop = 0;
        await sleep(120);
        collect();
      };
      await collectPass();
      // 点击「检查」触发的新一轮 ERC 是流式出结果的：第一屏收集时列表可能还没长全，
      // 只收集一次会得到"部分明细"（真机表现为 36 条结果只抓到 10 条）。
      // 按面板计数校验，未收全就等下一批渲染后再滚一遍；但必须有内部截止时间——
      // 宁可返回"部分明细+聚合余量"，也不能把整次 ERC 拖到硬超时、一条明细都拿不到。
      const target = Number(expected.total) || 0;
      const collectDeadline = Date.now() + 8_000;
      let passes = 1;
      while (passes < 3 && target > 0 && items.length < target && Date.now() < collectDeadline) {
        passes += 1;
        await sleep(600);
        await collectPass();
      }
      return { ok: true, items, expected, panelTextLength: textOf(panel).length, collected: items.length, passes };
    })()`);
    if (!detail || detail.ok !== true) return { ok: false, reason: String(detail?.reason || 'ERC_DETAIL_FAILED'), counts: panel.counts, items: [] };
    if (!Array.isArray(detail.items) || !detail.items.length) {
      return { ok: false, reason: 'ERC_DETAIL_NO_ITEMS', counts: panel.counts, items: [] };
    }
    return { ok: true, counts: panel.counts, items: detail.items, source: 'ui-dom', panelTextLength: detail.panelTextLength };
  }

  /** 启动 EDA 并等调试端口就绪。返回是否由本调用启动。 */
  async launch({ waitMs = 45_000 } = {}) {
    try {
      await this.targets();
      return { alreadyRunning: true, cdpPort: this.cdpPort };
    } catch { /* 没启或没开端口，继续启动 */ }
    const appPath = this.appCandidates.find((candidate) => candidate);
    if (!appPath) throw new EdaGuiError('找不到嘉立创EDA应用路径', 'EDA_GUI_APP_NOT_FOUND');
    const binary = `${appPath}/Contents/MacOS/LCEDA-Pro`;
    const child = this.spawnImpl(binary, launchArgs(this.cdpPort), {
      env: stripChildEnv(process.env),
      detached: true,
      stdio: 'ignore',
    });
    child.unref?.();
    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs) {
      await sleep(1_000);
      try {
        await this.targets();
        return { launched: true, pid: child.pid, waitedMs: Date.now() - startedAt };
      } catch { /* 还没起来 */ }
    }
    throw new EdaGuiError('EDA 启动后调试端口仍未就绪', 'EDA_GUI_LAUNCH_TIMEOUT', { waitedMs: Date.now() - startedAt });
  }

  async execute(action, params = {}) {
    assertGuiAction(action);
    switch (action) {
      case 'state': return this.state();
      case 'targets': return { pages: (await this.targets()).filter((item) => item.type === 'page').map((item) => ({ url: item.url, ws: item.webSocketDebuggerUrl })) };
      case 'screenshot': return this.screenshot();
      case 'eval': {
        if (typeof params.expression !== 'string' || !params.expression.trim()) throw new EdaGuiError('eval 需要 expression', 'EDA_GUI_INVALID_PARAMS');
        return { value: await this.evaluate(params.expression) };
      }
      case 'click': return this.click(params);
      case 'dblclick': return this.dblclick(params);
      case 'drag': return this.drag(params);
      case 'move': return this.moveTo(params);
      case 'focus': return this.focus();
      case 'type': return this.typeText(params);
      case 'key': return this.key(params);
      case 'shortcut': {
        if (!params.key) throw new EdaGuiError('shortcut 需要 key', 'EDA_GUI_INVALID_PARAMS');
        return this.shortcut({ key: params.key, modifiers: params.modifiers });
      }
      case 'clickText': {
        if (!params.text) throw new EdaGuiError('clickText 需要 text', 'EDA_GUI_INVALID_PARAMS');
        return this.click({ text: params.text, exact: params.exact !== false, index: params.index || 0 });
      }
      case 'waitText': return this.waitForText(params);
      case 'findTexts': return this.findTexts(params);
      case 'ercDetail': return this.ercDetail(params);
      case 'launch': return this.launch(params);
      default:
        throw new EdaGuiError(`GUI 动作未实现：${action}`, 'EDA_GUI_ACTION_NOT_IMPLEMENTED');
    }
  }

  /**
   * E9：只读探测页面上是否存在给定文案（菜单/按钮），用于兜底动作能力清单与菜单文案漂移诊断。
   * 不点击、不输入；可选 `viewport` 用 CDP Emulation 覆盖布局尺寸，从而在同一份 EDA 上
   * 校验"2 种窗口尺寸下文案仍可定位"（结束后清除覆盖，不改变真实窗口）。
   */
  async findTexts({ texts = [], viewport = null } = {}) {
    const wanted = (Array.isArray(texts) ? texts : []).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 80);
    if (!wanted.length) throw new EdaGuiError('findTexts 需要 texts', 'EDA_GUI_INVALID_PARAMS');
    const session = await this.session();
    const contextId = await this.contextId();
    const override = viewport && Number.isFinite(Number(viewport.width)) && Number.isFinite(Number(viewport.height))
      ? { width: Math.max(320, Math.min(4096, Math.round(Number(viewport.width)))), height: Math.max(240, Math.min(4096, Math.round(Number(viewport.height)))), deviceScaleFactor: 1, mobile: false }
      : null;
    try {
      if (override) await session.send('Emulation.setDeviceMetricsOverride', override);
      const payload = await session.evaluate(`(function(){
        const wanted = ${JSON.stringify(wanted)};
        const out = [];
        for (const text of wanted) {
          const matches = [];
          for (const el of document.querySelectorAll('body *')) {
            if (el.children.length) continue;
            const value = (el.textContent || '').trim();
            if (!value) continue;
            const hit = value === text || (text.length >= 2 && value.includes(text));
            if (!hit) continue;
            const rect = el.getBoundingClientRect();
            matches.push({ tag: el.tagName, text: value.slice(0, 60), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), visible: rect.width > 0 && rect.height > 0 });
            if (matches.length >= 5) break;
          }
          out.push({ text, found: matches.length > 0, matches });
        }
        return { viewport: { width: innerWidth, height: innerHeight }, matches: out };
      })()`, contextId);
      return { ...payload, emulatedViewport: override ? { width: override.width, height: override.height } : null };
    } finally {
      if (override) { try { await session.send('Emulation.clearDeviceMetricsOverride', {}); } catch { /* 清除失败不影响探测结果 */ } }
    }
  }

  async waitForText({ text, timeoutMs = 15_000, intervalMs = 400 }) {
    if (!text) throw new EdaGuiError('waitText 需要 text', 'EDA_GUI_INVALID_PARAMS');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const present = await this.evaluate(`(document.body.innerText || '').includes(${JSON.stringify(text)})`);
      if (present) return { present: true, text };
      await sleep(intervalMs);
    }
    throw new EdaGuiError(`等待文本超时：${text}`, 'EDA_GUI_WAIT_TEXT_TIMEOUT', { text, timeoutMs });
  }
}
