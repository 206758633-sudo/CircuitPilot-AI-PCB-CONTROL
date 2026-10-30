import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient } from '../bridge.mjs';

const windowPayload = { windows: [{ windowId: 'w1' }] };
const okExecute = { result: { pong: true } };

test('桥自愈：读命令遇到 BRIDGE_UNREACHABLE 会重新发现端口并在新端口重试', async () => {
  let port = 49620;
  let executeAttempts = 0;
  const fetcher = async (url) => {
    if (url.endsWith('/health')) return { service: 'easyeda-bridge', version: 'test' };
    if (url.endsWith('/eda-windows')) return windowPayload;
    if (url.endsWith('/execute')) {
      executeAttempts += 1;
      if (executeAttempts === 1) {
        // 模拟 EDA 退出：桥进程没了，端口换了
        port = 49627;
        throw Object.assign(new Error('Bridge 不可达（fetch failed）'), { code: 'BRIDGE_UNREACHABLE' });
      }
      return okExecute;
    }
    throw new Error(`unexpected ${url}`);
  };
  // 发现阶段只看到新端口健康（旧端口已死）
  const client = new BridgeClient({ ports: [49620, 49627], fetcher });
  const clientDiscover = client.discover.bind(client);
  client.discover = async () => {
    const match = await clientDiscover();
    if (match) client.port = port === 49627 ? 49627 : match.port;
    return match;
  };
  const result = await client.execute('pcb.layers.read', {});
  assert.equal(result.result.pong, true);
  assert.equal(executeAttempts, 2, '第一次失败后必须在新端口重试一次');
  assert.equal(client.port, 49627);
});

test('桥自愈：写命令绝不自动重试（避免在 EDA 里二次创建）', async () => {
  let attempts = 0;
  const fetcher = async (url) => {
    if (url.endsWith('/health')) return { service: 'easyeda-bridge' };
    if (url.endsWith('/eda-windows')) return windowPayload;
    if (url.endsWith('/execute')) { attempts += 1; throw Object.assign(new Error('Bridge 不可达'), { code: 'BRIDGE_UNREACHABLE' }); }
    throw new Error(`unexpected ${url}`);
  };
  const client = new BridgeClient({ ports: [49620], fetcher });
  await assert.rejects(() => client.execute('pcb.save', {}, { allowWrite: true }), (error) => error.code === 'BRIDGE_UNREACHABLE');
  assert.equal(attempts, 1);
});

test('桥自愈：windows 读取遇到桥退出会清掉旧 port，下次可重新发现新端口', async () => {
  const fetcher = async (url) => {
    if (url.includes(':49620')) throw Object.assign(new Error('Bridge 不可达'), { code: 'BRIDGE_UNREACHABLE' });
    if (url.endsWith('/health')) return { service: 'easyeda-bridge', version: 'test' };
    if (url.endsWith('/eda-windows')) return windowPayload;
    throw new Error(`unexpected ${url}`);
  };
  const client = new BridgeClient({ ports: [49620, 49627], fetcher });
  client.port = 49620;
  await assert.rejects(() => client.windows(), (error) => error.code === 'BRIDGE_UNREACHABLE');
  assert.equal(client.port, null, '旧端口必须清掉');
  const windows = await client.windows();
  assert.equal(client.port, 49627);
  assert.equal(windows.windows.length, 1);
});
