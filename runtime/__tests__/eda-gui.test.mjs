import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EdaGuiClient, EdaGuiError, GUI_ACTIONS, assertGuiAction, launchArgs, stripChildEnv,
} from '../eda-gui.mjs';

/**
 * 通道 B 的测试原则：
 * - 动作白名单是安全边界，必须逐条验证拒绝行为；
 * - GUI 序列（点击=move+press+release）必须能被断言，否则"点了但没效果"无法区分；
 * - 不依赖真实 EDA：用假 CDP 会话验证协议序列，真机验证留给运行时的真机 e2e。
 */

function fakeTargets(pages) {
  return async () => pages;
}

function fakeSession({ evaluateImpl, contexts = [{ id: 7 }] } = {}) {
  const calls = [];
  return {
    calls,
    executionContexts: contexts,
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.enable') return {};
      if (method === 'Page.captureScreenshot') return { data: 'aGVsbG8=' };
      return {};
    },
    async evaluate(expression) {
      calls.push({ method: 'evaluate', expression });
      if (evaluateImpl) return evaluateImpl(expression);
      if (expression === 'location.href') return 'https://pro.lceda.cn/editor?cll=warn';
      return null;
    },
    async editorContextId() { return 7; },
    close() {},
  };
}

function makeClient({ pages, session, cdpPort = 9222 } = {}) {
  return new EdaGuiClient({
    cdpPort,
    fetchJsonImpl: fakeTargets(pages || [{ type: 'page', url: 'https://pro.lceda.cn/editor?cll=warn', webSocketDebuggerUrl: 'ws://fake/1' }]),
    sessionFactory: async () => (session || fakeSession()),
    logger: { warn() {} },
  });
}

test('GUI 动作白名单：未知动作必须被拒绝且给出允许清单', async () => {
  assert.ok(GUI_ACTIONS.includes('click'));
  assert.throws(() => assertGuiAction('rm -rf'), (error) => error instanceof EdaGuiError && error.code === 'EDA_GUI_ACTION_NOT_ALLOWED');
  const client = makeClient({});
  await assert.rejects(() => client.execute('rm -rf'), (error) => error.code === 'EDA_GUI_ACTION_NOT_ALLOWED');
});

test('子进程环境必须剥掉 ELECTRON_RUN_AS_NODE（否则 EDA 会退化成 Node 直接退出）', () => {
  const env = stripChildEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

test('launchArgs 只注入调试端口', () => {
  assert.deepEqual(launchArgs(9222), ['--remote-debugging-port=9222']);
});

test('pickPage 优先选择已打开工程的窗口', async () => {
  const client = makeClient({
    pages: [
      { type: 'page', url: 'https://client/editor?cll=warn', webSocketDebuggerUrl: 'ws://start' },
      { type: 'page', url: 'https://pro.lceda.cn/editor?cll=warn#id=abc', webSocketDebuggerUrl: 'ws://project' },
      { type: 'iframe', url: 'https://passport.jlc.com/by-pit', webSocketDebuggerUrl: 'ws://passport' },
    ],
  });
  const page = await client.pickPage();
  assert.equal(page.webSocketDebuggerUrl, 'ws://project');
});

test('click(text) 先定位元素，再发 move + mousePressed + mouseReleased', async () => {
  const session = fakeSession({
    evaluateImpl: (expression) => {
      if (expression === 'location.href') return 'https://pro.lceda.cn/editor?cll=warn';
      return { found: true, x: 120, y: 240, width: 40, height: 20, tag: 'SPAN', text: '放置' };
    },
  });
  const client = makeClient({ session });
  const result = await client.execute('click', { text: '放置' });
  assert.equal(result.clicked, true);
  assert.deepEqual({ x: result.x, y: result.y }, { x: 120, y: 240 });
  const inputs = session.calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(inputs.map((call) => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  for (const call of inputs) {
    assert.equal(call.params.x, 120);
    assert.equal(call.params.y, 240);
  }
});

test('dblclick 发两组 press/release（clickCount 1 → 2），EDA 才会打开工程', async () => {
  const session = fakeSession({
    evaluateImpl: (expression) => {
      if (expression === 'location.href') return 'https://pro.lceda.cn/editor?cll=warn';
      return { found: true, x: 10, y: 20, width: 10, height: 10 };
    },
  });
  const client = makeClient({ session });
  await client.execute('dblclick', { text: '智能衣橱助手' });
  const inputs = session.calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(inputs.map((call) => `${call.params.type}:${call.params.clickCount}`), [
    'mouseMoved:1', 'mousePressed:1', 'mouseReleased:1', 'mousePressed:2', 'mouseReleased:2',
  ]);
});

test('drag 必须步进移动，不能一步跳到终点', async () => {
  const session = fakeSession();
  const client = makeClient({ session });
  const result = await client.execute('drag', { x1: 0, y1: 0, x2: 100, y2: 50, steps: 4 });
  assert.equal(result.dragged, true);
  const movements = session.calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
  const pressed = movements.filter((call) => call.params.type === 'mousePressed');
  const released = movements.filter((call) => call.params.type === 'mouseReleased');
  const moved = movements.filter((call) => call.params.type === 'mouseMoved');
  assert.equal(pressed.length, 1);
  assert.equal(released.length, 1);
  assert.equal(moved.length, 4);
  assert.equal(moved[moved.length - 1].params.x, 100);
  assert.equal(moved[moved.length - 1].params.y, 50);
});

test('type 走 Input.insertText；key 只接受白名单按键', async () => {
  const session = fakeSession();
  const client = makeClient({ session });
  await client.execute('type', { text: 'GND' });
  const inserted = session.calls.find((call) => call.method === 'Input.insertText');
  assert.equal(inserted.params.text, 'GND');
  await client.execute('key', { key: 'Enter' });
  assert.equal(session.calls.filter((call) => call.method === 'Input.dispatchKeyEvent').length, 2);
  await assert.rejects(() => client.execute('key', { key: 'F13' }), (error) => error.code === 'EDA_GUI_UNSUPPORTED_KEY');
});

test('state 如实反映在线/离线与工程打开状态', async () => {
  const session = fakeSession({
    evaluateImpl: () => ({ url: 'https://pro.lceda.cn/editor?cll=warn#id=abc', online: true, offline: false, projectOpen: true, hasProjectText: true, tabs: ['PCB1'], text: '全在线 | PCB1' }),
  });
  const client = makeClient({ session });
  const state = await client.execute('state');
  assert.equal(state.online, true);
  assert.equal(state.offline, false);
  assert.equal(state.projectOpen, true);
});

test('调试端口不可用时给出可诊断错误码，而不是静默失败', async () => {
  const client = new EdaGuiClient({
    fetchJsonImpl: async () => { throw new EdaGuiError('boom', 'EDA_GUI_CDP_HTTP_ERROR'); },
    sessionFactory: async () => fakeSession(),
  });
  await assert.rejects(() => client.execute('state'), (error) => error.code === 'EDA_GUI_CDP_UNAVAILABLE');
});

test('eval 需要非空表达式（不允许空串变成"任意读取"）', async () => {
  const client = makeClient({});
  await assert.rejects(() => client.execute('eval', {}), (error) => error.code === 'EDA_GUI_INVALID_PARAMS');
});

test('shortcut：字母键带修饰位发出 rawKeyDown + keyUp，且不会当文本插入', async () => {
  const session = fakeSession();
  const client = makeClient({ session });
  const result = await client.execute('shortcut', { key: 's', modifiers: ['meta'] });
  assert.equal(result.pressed, 's');
  assert.equal(result.modifiers, 4); // CDP: Meta/Command = 4
  const downs = session.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
  assert.equal(downs.length, 2);
  assert.equal(downs[0].params.type, 'rawKeyDown');
  assert.equal(downs[0].params.key, 'S');
  assert.equal(downs[0].params.code, 'KeyS');
  assert.equal(downs[0].params.windowsVirtualKeyCode, 83);
  assert.equal(downs[0].params.modifiers, 4);
  assert.equal('text' in downs[0].params, false);
  assert.equal(downs[1].params.type, 'keyUp');
});

test('shortcut：Ctrl+Z 组合位为 2，功能键走已登记码值', async () => {
  const session = fakeSession();
  const client = makeClient({ session });
  const z = await client.execute('shortcut', { key: 'z', modifiers: ['ctrl'] });
  assert.equal(z.modifiers, 2);
  const esc = await client.execute('shortcut', { key: 'Escape', modifiers: ['shift'] });
  assert.equal(esc.modifiers, 8);
  const down = session.calls.filter((c) => c.method === 'Input.dispatchKeyEvent')[0];
  assert.equal(down.params.windowsVirtualKeyCode, 90);
});

test('shortcut：未知修饰键/多字符键必须被拒绝（不开任意键注入后门）', async () => {
  const client = makeClient({});
  await assert.rejects(
    () => client.execute('shortcut', { key: 's', modifiers: ['hyper'] }),
    (err) => err instanceof EdaGuiError && err.code === 'EDA_GUI_UNSUPPORTED_MODIFIER',
  );
  await assert.rejects(
    () => client.execute('shortcut', { key: 'ss', modifiers: ['meta'] }),
    (err) => err instanceof EdaGuiError && err.code === 'EDA_GUI_UNSUPPORTED_KEY',
  );
  await assert.rejects(
    () => client.execute('shortcut', {}),
    (err) => err instanceof EdaGuiError && err.code === 'EDA_GUI_INVALID_PARAMS',
  );
});

test('move：只发 mouseMoved（不按键），用于标定画布坐标与画线前定位', async () => {
  const session = fakeSession();
  const client = makeClient({ session });
  const result = await client.execute('move', { x: 640, y: 480 });
  assert.deepEqual(result, { moved: true, x: 640, y: 480 });
  const events = session.calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
  assert.equal(events.length, 1);
  assert.equal(events[0].params.type, 'mouseMoved');
  assert.equal(events[0].params.button, 'none');
  assert.equal(events[0].params.buttons, 0);
});

test('move：缺少或非法坐标必须拒绝（防止 0,0 静默点击左上角）', async () => {
  const client = makeClient({});
  await assert.rejects(
    () => client.execute('move', { x: '640', y: 480 }),
    (err) => err instanceof EdaGuiError && err.code === 'EDA_GUI_INVALID_PARAMS',
  );
  await assert.rejects(
    () => client.execute('move', {}),
    (err) => err instanceof EdaGuiError && err.code === 'EDA_GUI_INVALID_PARAMS',
  );
});

test('focus：激活页面 + 强制 active 生命周期 + 焦点模拟，并回报 visibility', async () => {
  const session = fakeSession({ evaluateImpl: (expression) => (expression === 'document.visibilityState' ? 'visible' : null) });
  const client = makeClient({ session });
  const result = await client.execute('focus');
  assert.equal(result.focused, true);
  assert.equal(result.visibility, 'visible');
  assert.equal(result.broughtToFront, true);
  assert.equal(result.lifecycleActive, true);
  assert.equal(result.focusEmulated, true);
  const methods = session.calls.map((c) => c.method);
  assert.ok(methods.includes('Page.bringToFront'));
  assert.ok(methods.includes('Page.setWebLifecycleState'));
  assert.ok(methods.includes('Emulation.setFocusEmulationEnabled'));
  const lifecycle = session.calls.find((c) => c.method === 'Page.setWebLifecycleState');
  assert.deepEqual(lifecycle.params, { state: 'active' });
});

test('focus：CDP 老版本不支持某条命令时必须降级而不是抛错（否则画布操作全被连带阻断）', async () => {
  const session = fakeSession({ evaluateImpl: (expression) => (expression === 'document.visibilityState' ? 'hidden' : null) });
  const originalSend = session.send.bind(session);
  session.send = async (method, params) => {
    if (method === 'Page.setWebLifecycleState') throw new Error('Method not found');
    return originalSend(method, params);
  };
  const client = makeClient({ session });
  const result = await client.execute('focus');
  assert.equal(result.focused, true);
  assert.equal(result.broughtToFront, true);
  assert.equal(result.lifecycleActive, false);
  assert.equal(result.visibility, 'hidden');
});

test('ercDetail 发给页面的脚本必须保留反斜杠（真机曾因宿主模板吃掉 \\r 整段 SyntaxError，明细永久失败）', async () => {
  const expressions = [];
  const session = fakeSession({
    evaluateImpl: (expression) => {
      expressions.push(expression);
      if (expression.includes('scrollHeight')) {
        return { ok: true, items: [{ level: 'warning', message: '发现元件引脚悬空 : R1.1' }], panelTextLength: 200, scrollable: true };
      }
      return [{ label: '检查DRC', counts: { total: 37, fatal: 0, error: 1, warning: 34, info: 2 }, x: 10, y: 10, panelLength: 200, panelText: '检查DRC导出清空全部(37)致命错误(0)错误(1)警告(34)信息(2)' }];
    },
  });
  const client = makeClient({ session });
  const result = await client.execute('ercDetail', { timeoutMs: 2000 });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.counts, { total: 37, fatal: 0, error: 1, warning: 34, info: 2 });
  assert.ok(expressions.length >= 2);
  for (const expression of expressions) {
    // 宿主模板字面量会处理转义：页面代码里允许出现反斜杠+"r"两个字符，绝不允许出现真正的 CR。
    assert.ok(!expression.includes('\r'), '页面脚本里出现了真实回车符，说明转义在宿主侧被吃掉了');
    assert.ok(expression.includes('/\\r/g'), 'textOf 的 \\r 清洗正则被破坏了');
  }
});

test('ercDetail 只认可见的检查面板，并通过虚拟列表滚动收集全部明细', async () => {
  const expressions = [];
  const session = fakeSession({
    evaluateImpl: (expression) => {
      expressions.push(expression);
      if (expression.includes('scrollHeight')) {
        return { ok: true, items: Array.from({ length: 37 }, (_, index) => ({ level: index === 0 ? 'error' : index < 35 ? 'warning' : 'info', message: `明细 ${index}` })), panelTextLength: 900, scrollable: true };
      }
      return [{ label: '检查DRC', counts: { total: 37, fatal: 0, error: 1, warning: 34, info: 2 }, x: 10, y: 10, panelLength: 200, panelText: '全部(37)致命错误(0)错误(1)警告(34)信息(2)' }];
    },
  });
  const client = makeClient({ session });
  const result = await client.execute('ercDetail', { timeoutMs: 2000 });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 37);
  const detailExpression = expressions.find((expression) => expression.includes('scrollHeight'));
  assert.ok(detailExpression, '明细提取脚本必须包含滚动收集逻辑（虚拟列表只渲染可见行）');
  assert.ok(detailExpression.includes('log-container'), '面板根必须是 log-container，否则拿到的只是左侧计数栏');
});

test('ercDetail 面板晚渲染：前几次扫描为空时必须在预算内重试，而不是立刻 ERC_PANEL_NOT_FOUND（真机切页回归）', async () => {
  let scans = 0;
  const expressions = [];
  const session = fakeSession({
    evaluateImpl: (expression) => {
      expressions.push(expression);
      if (expression.includes('scrollHeight')) return { ok: true, items: [{ level: 'error', message: '网络 GND 与 +3V3 短路' }], panelTextLength: 300, scrollable: false };
      scans += 1;
      if (scans <= 2) return []; // 刚切完文档，检查面板还没渲染出来
      return [{ label: '检查DRC', counts: { total: 1, fatal: 0, error: 1, warning: 0, info: 0 }, x: 8, y: 830, panelLength: 200, panelText: '全部(1)致命错误(0)错误(1)警告(0)信息(0)' }];
    },
  });
  const client = makeClient({ session });
  const result = await client.execute('ercDetail', { timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.counts.error, 1);
  assert.ok(scans >= 3, '必须重试扫描，直到检查面板出现');
});
