import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAdapterScript, resolveEasyedaCli, startEdaBridgeSupervisor } from '../eda-bridge-supervisor.mjs';

const fakeSpawn = (calls) => (command, args, options) => {
  calls.push({ command, args, options });
  return { pid: 4000 + calls.length, unref() {} };
};

test('supervisor：未开启开关时不做任何事（默认关闭，测试/开发环境不被打扰）', async () => {
  const calls = [];
  const result = await startEdaBridgeSupervisor({ env: {}, spawnFn: fakeSpawn(calls), probe: async () => null, cliPath: '/x', adapterScript: '/y' });
  assert.equal(result.status, 'disabled');
  assert.deepEqual(calls, []);
});

test('supervisor：已有 bridge 时直接复用，不启动任何进程', async () => {
  const calls = [];
  const result = await startEdaBridgeSupervisor({
    env: { CIRCUITPILOT_EDA_AUTO_BRIDGE: 'on' }, spawnFn: fakeSpawn(calls), probe: async () => ({ port: 49620, health: { service: 'easyeda-bridge' } }), cliPath: '/x', adapterScript: '/y',
  });
  assert.equal(result.status, 'already-online');
  assert.deepEqual(calls, []);
});

test('supervisor：没有 easyeda CLI / adapter 时如实 skipped（不假装启动）', async () => {
  const calls = [];
  const noCli = await startEdaBridgeSupervisor({ env: { CIRCUITPILOT_EDA_AUTO_BRIDGE: 'on' }, spawnFn: fakeSpawn(calls), probe: async () => null, cliPath: null, adapterScript: '/y' });
  assert.equal(noCli.status, 'skipped-no-cli');
  const noAdapter = await startEdaBridgeSupervisor({ env: { CIRCUITPILOT_EDA_AUTO_BRIDGE: 'on' }, spawnFn: fakeSpawn(calls), probe: async () => null, cliPath: '/x', adapterScript: null });
  assert.equal(noAdapter.status, 'skipped-no-adapter');
  assert.deepEqual(calls, []);
});

test('supervisor：daemon 不健康 → 启动 daemon；随后启动 adapter；健康探测成功 → started', async () => {
  const calls = [];
  const probes = [null, { port: 49620, health: { service: 'easyeda-bridge', edaConnected: true } }];
  let daemonChecks = 0;
  const result = await startEdaBridgeSupervisor({
    env: { CIRCUITPILOT_EDA_AUTO_BRIDGE: 'on' },
    spawnFn: fakeSpawn(calls),
    execFileFn: (_cli, _args, _opts, done) => { daemonChecks += 1; done(daemonChecks === 1 ? new Error('daemon down') : null); },
    probe: async () => probes.shift() ?? null,
    sleep: async () => {},
    daemonWaitMs: 100,
    adapterWaitMs: 1_000,
    cliPath: '/usr/local/bin/easyeda',
    adapterScript: '/repo/scripts/easyeda-agent-bridge.mjs',
    ports: [49620],
  });
  assert.equal(result.status, 'started');
  assert.equal(result.daemonStarted, true);
  assert.equal(result.bridge.port, 49620);
  assert.deepEqual(result.actions, ['start-easyeda-daemon', 'start-agent-bridge-adapter']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['daemon', 'start']);
  assert.equal(calls[1].args[0], '/repo/scripts/easyeda-agent-bridge.mjs');
  assert.equal(calls[1].options.env.CIRCUITPILOT_AGENT_BRIDGE_PORT, '49620');
});

test('supervisor：daemon 已健康时不重复启动 daemon；adapter 起不来 → started-not-ready（fail-open）', async () => {
  const calls = [];
  const result = await startEdaBridgeSupervisor({
    env: { CIRCUITPILOT_EDA_AUTO_BRIDGE: 'on' },
    spawnFn: fakeSpawn(calls),
    execFileFn: (_cli, _args, _opts, done) => done(null, '{"status":"found"}'),
    probe: async () => null,
    sleep: async () => {},
    adapterWaitMs: 0,
    cliPath: '/usr/local/bin/easyeda',
    adapterScript: '/repo/scripts/easyeda-agent-bridge.mjs',
    ports: [49620],
  });
  assert.equal(result.status, 'started-not-ready');
  assert.equal(result.daemonStarted, false);
  assert.deepEqual(result.actions, ['daemon-already-healthy', 'start-agent-bridge-adapter']);
  assert.equal(calls.length, 1);
});

test('supervisor：CLI/adapter 解析（env 覆盖 + 仓库默认路径）', async () => {
  assert.equal(resolveEasyedaCli({ env: { EASYEDA_CLI: '/custom/easyeda' }, exists: () => true }), '/custom/easyeda');
  assert.equal(resolveEasyedaCli({ env: {}, exists: () => false }), null);
  const script = resolveAdapterScript({ env: {}, exists: () => true });
  assert.ok(script && script.endsWith('/scripts/easyeda-agent-bridge.mjs'), `unexpected adapter path: ${script}`);
});
