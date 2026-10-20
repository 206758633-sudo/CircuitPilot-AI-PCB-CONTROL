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
  'clickText', 'waitText', 'launch', 'targets', 'focus', 'findTexts',
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
      throw new EdaGuiError('页面脚本执行出错', 'EDA_GUI_EVAL_FAILED', result.exceptionDetails);
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
