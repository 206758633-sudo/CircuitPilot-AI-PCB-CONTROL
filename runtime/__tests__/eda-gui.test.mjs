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
