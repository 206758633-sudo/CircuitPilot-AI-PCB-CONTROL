/**
 * 桥断线自愈：EDA 重启会带走桥进程；重新发现桥之后，如果 EDA 停在开始页（没有工程），
 * 运行时应当用"上次用过的工程"自动重开，而不是让后续路由全部报 EDA_PROJECT_NOT_OPEN。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeServer } from '../server.mjs';

const fakeKeychain = { async configured() { return false; }, async store() { return { configured: true }; }, async read() { throw Object.assign(new Error('not configured'), { code: 'KEY_NOT_CONFIGURED' }); }, async remove() { return { configured: false }; } };

test('会话自愈：桥断线重连后按记忆自动重开工程，后续命令可用', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cp-selfheal-'));
  const memo = join(tmp, 'memo.json');
  writeFileSync(memo, JSON.stringify({ projectUuid: 'P-MEMO', at: new Date().toISOString() }));
  process.env.CIRCUITPILOT_PROJECT_MEMO = memo;
  const commands = [];
  let projectOpen = null;
  let windowsCalls = 0;
  const bridge = {
    port: 1,
    selectedWindowId: 'w1',
    async discover() { this.port = 1; return { port: 1 }; },
    async windows() {
      windowsCalls += 1;
      // 第一次调用：桥已经随 EDA 退出（不可达）
      if (windowsCalls === 1) throw Object.assign(new Error('Bridge 不可达'), { code: 'BRIDGE_UNREACHABLE' });
      return { windows: [{ windowId: 'w1' }], selectionRequired: false };
    },
    async execute(id, args = {}) {
      commands.push({ id, args });
      if (id === 'project.current') return { result: projectOpen ? { uuid: projectOpen } : null };
      if (id === 'project.open') { projectOpen = args.projectUuid; return { result: { opened: true, projectUuid: args.projectUuid } }; }
      if (id === 'document.current') return { result: { uuid: 'PAGE-1', documentType: 1 } };
      throw Object.assign(new Error(`未知命令 ${id}`), { code: 'UNKNOWN_COMMAND' });
    },
  };
  const { server, sessionToken } = createRuntimeServer({ keychain: fakeKeychain, bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    process.env.CIRCUITPILOT_DRC_EXEMPTION_DIR = tmp;
    process.env.CIRCUITPILOT_DRC_LEGACY_EXEMPTIONS = join(tmp, 'legacy-none.json');
    const response = await fetch(`${base}/api/eda/pcb/drc/exemptions`, { headers: { 'x-circuitpilot-token': sessionToken } });
    const payload = await response.json().catch(() => ({}));
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.ok(commands.some((item) => item.id === 'project.open' && item.args.projectUuid === 'P-MEMO'), '必须用记忆的工程 UUID 自动打开');
    assert.ok(commands.some((item) => item.id === 'document.current'), '自愈后后续命令（指纹读取）必须能继续执行');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  }
});
