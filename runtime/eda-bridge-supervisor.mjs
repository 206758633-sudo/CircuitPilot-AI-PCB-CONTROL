/**
 * EDA bridge 托管启动器（Runtime 侧，可选）。
 *
 * 背景（2026-11-06 真机）：安装版 App 只启动 Runtime（server.mjs），不会启动 EDA bridge；
 * 本机 EasyEDA 3.2.x 用 `easyeda-agent` CLI（daemon 60832），与 Runtime 旧的
 * easyeda-bridge 协议（49620）不同，需要仓库里的 experimental adapter 做协议映射。
 *
 * 目标：App 启动时自动恢复“daemon + adapter”，让真实 EDA 连接可自恢复；
 * - 默认关闭：只有 env CIRCUITPILOT_EDA_AUTO_BRIDGE=on 才执行（Tauri 壳启动时注入）；
 * - 纯只读：只启动本机 bridge/daemon，不碰 EDA 设计数据；
 * - fail-open：任何一步失败只降级为“未自动连接”，不阻塞 Runtime 启动；
 * - 依赖注入，便于单测（不真起进程）。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const DEFAULT_BRIDGE_PORTS = Object.freeze([49620, 49621, 49622, 49623, 49624, 49625, 49626, 49627, 49628, 49629]);
const ADAPTER_FILE = 'easyeda-agent-bridge.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/** 解析 easyeda CLI：env 覆盖 → 用户安装目录 → 常见包管理路径。 */
export function resolveEasyedaCli({ env = process.env, exists = existsSync } = {}) {
  const candidates = [
    env.EASYEDA_CLI,
    join(homedir(), '.local/bin/easyeda'),
    '/opt/homebrew/bin/easyeda',
    '/usr/local/bin/easyeda',
  ].filter((value) => typeof value === 'string' && value.length > 0);
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** 解析 adapter 脚本：开发目录 runtime/../scripts；打包后 Resources/runtime/../scripts。 */
export function resolveAdapterScript({ env = process.env, exists = existsSync, moduleUrl = import.meta.url } = {}) {
  if (typeof env.CIRCUITPILOT_EDA_ADAPTER === 'string' && env.CIRCUITPILOT_EDA_ADAPTER) return env.CIRCUITPILOT_EDA_ADAPTER;
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(moduleDir, '..', 'scripts', ADAPTER_FILE),
    resolve(moduleDir, 'scripts', ADAPTER_FILE),
    join(moduleDir, ADAPTER_FILE),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

async function fetchJson(url, timeoutMs = 1_500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** 探测 49620–49629 上是否已有 `easyeda-bridge` 服务。 */
export async function probeBridge(ports = DEFAULT_BRIDGE_PORTS) {
  for (const port of ports) {
    const health = await fetchJson(`http://127.0.0.1:${port}/health`);
    if (health?.service === 'easyeda-bridge') return { port, health };
  }
  return null;
}

/**
 * 托管启动（依赖注入版）。
 * @returns {Promise<{status:string, actions:string[], adapterPid?:number, bridge?:object|null, reason?:string}>}
 */
export async function startEdaBridgeSupervisor(options = {}) {
  const {
    env = process.env,
    logger = () => {},
    exists = existsSync,
    spawnFn = spawn,
    execFileFn = null,
    probe = probeBridge,
    cliPath = resolveEasyedaCli({ env, exists }),
    adapterScript = resolveAdapterScript({ env, exists }),
    nodePath = process.execPath,
    ports = DEFAULT_BRIDGE_PORTS,
    daemonWaitMs = 8_000,
    adapterWaitMs = 8_000,
    sleep = delay,
  } = options;

  if (env.CIRCUITPILOT_EDA_AUTO_BRIDGE !== 'on') return { status: 'disabled', actions: [], reason: 'CIRCUITPILOT_EDA_AUTO_BRIDGE!=on' };

  const existing = await probe(ports);
  if (existing) return { status: 'already-online', actions: ['detected-existing-bridge'], bridge: existing };

  if (!cliPath) return { status: 'skipped-no-cli', actions: [], reason: 'easyeda CLI not found' };
  if (!adapterScript) return { status: 'skipped-no-adapter', actions: [], reason: `adapter not found: ${ADAPTER_FILE}` };

  const actions = [];
  let daemonStarted = false;
  let adapterChild = null;

  // 1) daemon：健康检查失败才启动（阻塞式 CLI，detached 后台）。
  try {
    const healthy = execFileFn
      ? await new Promise((done) => execFileFn(cliPath, ['daemon', 'health'], { timeout: 5_000 }, (error) => done(!error))).catch(() => false)
      : false;
    if (!healthy) {
      const child = spawnFn(cliPath, ['daemon', 'start'], { detached: true, stdio: 'ignore', env: process.env });
      child?.unref?.();
      daemonStarted = true;
      actions.push('start-easyeda-daemon');
      // daemon 启动是异步的：等 daemon health 就绪再起 adapter（不拿 bridge 探测当 daemon 判据）。
      if (execFileFn) {
        const deadline = Date.now() + daemonWaitMs;
        while (Date.now() < deadline) {
          const healthyNow = await new Promise((done) => execFileFn(cliPath, ['daemon', 'health'], { timeout: 5_000 }, (error) => done(!error))).catch(() => false);
          if (healthyNow) break;
          await sleep(400);
        }
      }
    } else {
      actions.push('daemon-already-healthy');
    }
  } catch (error) {
    logger('warn', 'EDA bridge: daemon start failed', { message: String(error?.message ?? error).slice(0, 160) });
  }

  // 2) adapter：Runtime 旧 bridge 协议 ↔ easyeda-agent CLI。
  try {
    adapterChild = spawnFn(nodePath, [adapterScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CIRCUITPILOT_AGENT_BRIDGE_PORT: String(ports[0]) },
    });
    adapterChild?.unref?.();
    actions.push('start-agent-bridge-adapter');
    const deadline = Date.now() + adapterWaitMs;
    while (Date.now() < deadline) {
      const bridge = await probe(ports);
      if (bridge) {
        logger('info', 'EDA bridge: online', { port: bridge.port, daemonStarted, adapterPid: adapterChild?.pid ?? null });
        return { status: 'started', actions, bridge, adapterPid: adapterChild?.pid ?? null, daemonStarted };
      }
      await sleep(400);
    }
    logger('warn', 'EDA bridge: adapter started but bridge health not ready');
    return { status: 'started-not-ready', actions, bridge: null, adapterPid: adapterChild?.pid ?? null, daemonStarted };
  } catch (error) {
    logger('warn', 'EDA bridge: adapter start failed', { message: String(error?.message ?? error).slice(0, 160) });
    return { status: 'failed', actions, bridge: null, reason: String(error?.message ?? error).slice(0, 200) };
  }
}

/** 生产包装：真实依赖 + 返回 stop() 用于进程退出时清理 adapter。 */
export async function ensureManagedEdaBridge({ logger = () => {}, env = process.env } = {}) {
  const result = await startEdaBridgeSupervisor({ env, logger });
  if (result.status === 'disabled') return result;
  logger('info', 'EDA bridge supervisor', { status: result.status, actions: result.actions, port: result.bridge?.port ?? null });
  return { ...result, stop: () => { /* adapter 以 detached 启动，进程退出由系统回收；此处保留扩展点 */ } };
}
