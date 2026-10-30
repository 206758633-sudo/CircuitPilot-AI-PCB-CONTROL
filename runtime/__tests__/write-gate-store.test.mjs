import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WriteGateStore, writePausedError } from '../write-gate.mjs';

/** WP4 P0-5：会话级写暂停必须与全局共存、持久化，并对旧文件/损坏文件有确定行为。 */

const makeFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-wg-store-'));
  return { dir, file: join(dir, 'write-gate.json') };
};

test('WP4 P0-5：缺省 = 未暂停；set(scope=global) 持久化且重启后仍生效', async () => {
  const { dir, file } = makeFile();
  try {
    const store = new WriteGateStore({ file });
    const initial = await store.load();
    assert.equal(initial.paused, false);
    assert.equal(initial.sessionPaused, false);
    assert.equal(initial.version, 0);
    assert.equal(store.active, false);

    const paused = await store.set({ paused: true, reason: '演练：暂停全部写板', actor: 'lead', scope: 'global' });
    assert.equal(paused.paused, true);
    assert.equal(paused.sessionPaused, false);
    assert.equal(paused.reason, '演练：暂停全部写板');
    assert.equal(paused.version, 1);
    assert.equal(store.active, true);

    // 落盘内容同时包含两个字段（旧版本 runtime 读到时仍按 paused 生效）。
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.paused, true);
    assert.equal(raw.sessionPaused, false);

    const reopened = new WriteGateStore({ file });
    const reloaded = await reopened.load();
    assert.equal(reloaded.paused, true);
    assert.equal(reloaded.sessionPaused, false);
    assert.equal(reloaded.reason, '演练：暂停全部写板');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P0-5：session 作用域独立持久化，不覆盖全局状态', async () => {
  const { dir, file } = makeFile();
  try {
    const store = new WriteGateStore({ file });
    await store.load();
    const sessionPaused = await store.set({ paused: true, reason: '本标签页暂停', actor: 'ui', scope: 'session' });
    assert.equal(sessionPaused.paused, false);
    assert.equal(sessionPaused.sessionPaused, true);
    assert.equal(sessionPaused.sessionReason, '本标签页暂停');
    assert.equal(store.active, true, '任一级暂停都算活动暂停');

    // 全局暂停后再关会话，全局仍保持暂停。
    await store.set({ paused: true, reason: '全局演练', actor: 'lead', scope: 'global' });
    const after = await store.set({ paused: false, scope: 'session' });
    assert.equal(after.paused, true);
    assert.equal(after.sessionPaused, false);
    assert.equal(after.sessionReason, null);

    const reopened = new WriteGateStore({ file });
    const reloaded = await reopened.load();
    assert.equal(reloaded.paused, true);
    assert.equal(reloaded.sessionPaused, false);
    assert.equal(reloaded.version, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P0-5：旧格式文件（只有 paused）兼容读取，sessionPaused 默认 false', async () => {
  const { dir, file } = makeFile();
  try {
    writeFileSync(file, JSON.stringify({ paused: true, reason: '旧版本写的', actor: 'legacy', updatedAt: '2026-10-01T00:00:00.000Z', version: 7 }), 'utf8');
    const store = new WriteGateStore({ file });
    const state = await store.load();
    assert.equal(state.paused, true);
    assert.equal(state.sessionPaused, false);
    assert.equal(state.version, 7);
    assert.equal(state.loadError, undefined, '旧格式是合法兼容，不算损坏');
    // 旧文件基础上改会话开关，写出的新文件必须同时保留全局 paused。
    const next = await store.set({ paused: true, reason: '会话暂停', scope: 'session' });
    assert.equal(next.paused, true);
    assert.equal(next.sessionPaused, true);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.paused, true);
    assert.equal(raw.sessionPaused, true);
    assert.equal(raw.version, 8);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P0-5：文件损坏 → 全局 fail-closed 暂停 + loadError（不静默放行）', async () => {
  const { dir, file } = makeFile();
  try {
    writeFileSync(file, '{"paused": tru', 'utf8');
    const store = new WriteGateStore({ file });
    const state = await store.load();
    assert.equal(state.paused, true, '损坏时必须保守按已暂停');
    assert.equal(state.sessionPaused, false);
    assert.ok(state.loadError, '必须暴露 loadError 供 UI/设置页提示');
    assert.equal(state.version, -1);
    assert.equal(store.active, true);

    // 显式恢复（写文件成功）后 loadError 清空。
    const resumed = await store.set({ paused: false, reason: null, actor: 'lead', scope: 'global' });
    assert.equal(resumed.paused, false);
    assert.equal(resumed.loadError, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P0-5：合法 JSON 但 sessionPaused 类型非法 → 会话按 false、保留 loadError，全局字段照读', async () => {
  const { dir, file } = makeFile();
  try {
    writeFileSync(file, JSON.stringify({ paused: true, reason: '全局暂停', sessionPaused: 'yes', version: 2 }), 'utf8');
    const store = new WriteGateStore({ file });
    const state = await store.load();
    assert.equal(state.paused, true);
    assert.equal(state.sessionPaused, false);
    assert.match(String(state.loadError), /sessionPaused/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P0-5：set 参数校验（paused 非布尔 / scope 非法）抛 WRITE_GATE_INVALID，且不落盘', async () => {
  const { dir, file } = makeFile();
  try {
    const store = new WriteGateStore({ file });
    await store.load();
    await assert.rejects(() => store.set({ paused: 'yes' }), (error) => error.code === 'WRITE_GATE_INVALID' && error.status === 400);
    await assert.rejects(() => store.set({ paused: true, scope: 'tab' }), (error) => error.code === 'WRITE_GATE_INVALID' && error.status === 400 && /scope/.test(error.message));
    assert.equal(store.snapshot().paused, false);
    assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/, '非法 set 不得创建状态文件');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WP4 P0-5：writePausedError 区分 global/session，携带 scope 与原因', async () => {
  const global = writePausedError({ paused: true, reason: '全局演练', actor: 'lead', updatedAt: 'T', version: 3, sessionPaused: false }, '/api/eda/gui/execute');
  assert.equal(global.code, 'EDA_WRITE_PAUSED');
  assert.equal(global.status, 409);
  assert.equal(global.details.scope, 'global');
  assert.equal(global.details.reason, '全局演练');
  assert.match(global.message, /全局写入已暂停/);

  const session = writePausedError({ paused: false, sessionPaused: true, sessionReason: '本标签页暂停', sessionActor: 'ui', version: 4 });
  assert.equal(session.details.scope, 'session');
  assert.equal(session.details.reason, '本标签页暂停');
  assert.equal(session.details.sessionPaused, true);
  assert.match(session.message, /本会话写入已暂停/);
});

test('WP4 P0-5：refresh 能读到其它进程/外部对状态文件的修改', async () => {
  const { dir, file } = makeFile();
  try {
    const store = new WriteGateStore({ file });
    await store.load();
    assert.equal(store.snapshot().paused, false);
    // 模拟另一个 Runtime 实例（或设置页）改了文件。
    const other = new WriteGateStore({ file });
    await other.set({ paused: true, reason: '另一实例暂停', scope: 'global' });
    assert.equal(store.snapshot().paused, false, '未 refresh 前保持缓存');
    const refreshed = await store.refresh();
    assert.equal(refreshed.paused, true);
    assert.equal(refreshed.reason, '另一实例暂停');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
