#!/usr/bin/env node
/**
 * sync-compat.mjs — dsh-circuitpilot 兼容性清单自动同步器。
 *
 * 目的：DSH / CircuitPilot 升级后，一条命令让插件「保持兼容」：
 *   检测本机真实版本 → 追加 compat.json 的 verified 列表 → 版本越过上界时按规则
 *   自动放宽 minor 上界（不降低下界）→ 把区间同步写回 package.json（engines.dsh /
 *   dsh-* peerDependencies）→ 跑全量测试兜底 → 打印报告。
 *
 * 设计要点：
 *  - 唯一数据源仍是 compat.json；package.json 只是它的投影（test/compat.test.mjs 强制校验）。
 *  - 事务式写入：先把所有新内容算好并备份旧内容，全部写完后跑测试；测试失败恢复原内容并 exit 1。
 *  - --check 只读：不写任何文件；检测不到版本（如 CI 无本机 DSH）视为 skip 而非失败。
 *  - 「自动」的边界：同一 major 内更高 minor 自动放宽上界；低于下界 / 跨 major 一律不自动放宽，
 *    报告「需要人工确认」，避免悄悄扩大/削减兼容承诺。
 *  - CircuitPilot 版本以「本仓库 runtime/version.mjs / 已安装 App」为权威；默认探测运行中的
 *    /api/health 只作为「观测值」，因为本机可能跑着旧构建（实测 4178 = 0.8.15）。显式传
 *    --runtime-url 或设置 CIRCUITPILOT_RUNTIME_URL 时，运行中实例才回到权威优先级。
 *  - 不联网（除本机 /api/health 只读探测，可用 --no-runtime-probe 关闭）；不写 ~/.dsh。
 *
 * 用法见 --help。
 *
 * @module scripts/sync-compat
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ */
/* 常量与错误                                                          */
/* ------------------------------------------------------------------ */

export const EXIT = Object.freeze({ OK: 0, DRIFT: 1, USAGE: 2 });

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PLUGIN_DIR = resolve(SCRIPT_DIR, '..');

const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:4178';
const RUNTIME_PROBE_TIMEOUT_MS = 3000;
const TEST_TIMEOUT_MS = 240_000;
const DSH_PEER_PACKAGES = Object.freeze(['@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-mcp-client']);

/** 子进程 / 内部错误：统一带上退出码，main 只负责打印。 */
export class CompatToolError extends Error {
  constructor(code, message, exitCode = EXIT.USAGE, extra = undefined) {
    super(message);
    this.name = 'CompatToolError';
    this.code = code;
    this.exitCode = exitCode;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------------ */
/* compat.mjs（semver 子集 + 本机探测）延迟加载                        */
/* ------------------------------------------------------------------ */

// 用动态 import：当 compat.json 缺失/损坏时，给出可读错误而不是 import 期的裸堆栈。
let compatLib = null;
let compatLibError = null;
try {
  compatLib = await import('../lib/compat.mjs');
} catch (error) {
  compatLibError = error;
}

function requireCompatLib() {
  if (compatLib) return compatLib;
  throw new CompatToolError(
    'COMPAT_MODULE_UNAVAILABLE',
    `无法加载 lib/compat.mjs（${compatLibError?.message ?? 'unknown'}）。` +
      '请确认 plugin/dsh-circuitpilot/compat.json 存在且是合法 JSON，并与 lib/compat.mjs 一起发布。',
    EXIT.USAGE,
  );
}

const parseVersion = (value) => requireCompatLib().parseVersion(value);
const compareVersions = (left, right) => requireCompatLib().compareVersions(left, right);
const satisfiesRange = (version, range) => requireCompatLib().satisfiesRange(version, range);
const isValidVersion = (value) => requireCompatLib().isValidVersion(value);
const readLocalDshVersion = (options) => requireCompatLib().readLocalDshVersion(options);

/* ------------------------------------------------------------------ */
/* CLI 参数                                                            */
/* ------------------------------------------------------------------ */

export const USAGE = `用法：node scripts/sync-compat.mjs [选项]

让 dsh-circuitpilot 的兼容清单（compat.json）与 package.json 跟上本机 DSH / CircuitPilot 版本。

选项：
  （默认）              检测 → 写 compat.json → 同步 package.json → 跑测试 → 打印报告
  --check              只检测 + 判定，不写文件。检测到的版本都被支持区间覆盖且清单一致则 exit 0，
                       否则 exit 1 并打印「怎么修」。检测不到版本（如 CI）视为 skip，不算失败。
  --dry-run            打印将要写入的字段/内容，不落盘
  --json               stdout 只输出结构化 JSON（人类日志走 stderr），便于 CI/其它脚本消费
  --dsh-version <v>    显式指定 DSH 版本（覆盖自动检测）
  --cp-version <v>     显式指定 CircuitPilot Runtime 版本（覆盖自动检测）
  --runtime-url <url>  探测 CircuitPilot /api/health 的地址（默认 ${DEFAULT_RUNTIME_URL}，
                       或环境变量 CIRCUITPILOT_RUNTIME_URL）；显式指定时该版本参与权威判定
  --no-runtime-probe   不探测运行中的 CircuitPilot（CI 用，保证不访问 4178）
  --no-dsh-cli         不执行 dsh -V（隔离测试/CI 用，避免探测到本机已安装的 DSH）
  --no-test            写入后不跑测试（仅调试用）
  --plugin-dir <dir>   插件目录（默认脚本所在目录的上一级）；写模式测试/多副本场景用
  -h, --help           显示本帮助

退出码：0 = 正常/兼容；1 = 漂移或 check 失败；2 = 用法/内部错误。

示例：
  node scripts/sync-compat.mjs                     # 升级 DSH 后一条命令同步
  node scripts/sync-compat.mjs --dry-run           # 先看会改什么
  node scripts/sync-compat.mjs --check             # CI/发版前只读门禁
  node scripts/sync-compat.mjs --check --dsh-version 0.3.0   # 模拟越界版本（预期 exit 1）
`;

function takeValue(argv, flag) {
  const next = argv.shift();
  if (next === undefined || next.startsWith('--')) {
    throw new CompatToolError('USAGE_MISSING_VALUE', `参数 ${flag} 需要一个值`);
  }
  return next;
}

/**
 * 解析 CLI 参数。不合法时抛 CompatToolError（exitCode=2）。
 * @param {string[]} argv process.argv.slice(2)
 */
export function parseArgs(argv) {
  const options = {
    mode: 'sync',
    dryRun: false,
    json: false,
    noTest: false,
    noRuntimeProbe: false,
    noDshCli: false,
    help: false,
    dshVersion: null,
    cpVersion: null,
    runtimeUrl: null,
    runtimeUrlExplicit: false,
    pluginDir: null,
  };
  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    let flag = token;
    let inlineValue = null;
    if (token.startsWith('--') && token.includes('=')) {
      const index = token.indexOf('=');
      flag = token.slice(0, index);
      inlineValue = token.slice(index + 1);
    }
    const value = () => (inlineValue !== null ? inlineValue : takeValue(args, flag));
    switch (flag) {
      case '--check':
        options.mode = 'check';
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--no-test':
        options.noTest = true;
        break;
      case '--no-runtime-probe':
        options.noRuntimeProbe = true;
        break;
      case '--no-dsh-cli':
        options.noDshCli = true;
        break;
      case '--dsh-version':
        options.dshVersion = value();
        break;
      case '--cp-version':
        options.cpVersion = value();
        break;
      case '--runtime-url':
        options.runtimeUrl = value();
        options.runtimeUrlExplicit = true;
        break;
      case '--plugin-dir':
        options.pluginDir = value();
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new CompatToolError(
          'USAGE_UNKNOWN_ARG',
          token.startsWith('-') ? `未知参数：${token}` : `无法识别的参数：${token}`,
        );
    }
  }
  if (options.dshVersion !== null && !isValidVersion(options.dshVersion)) {
    throw new CompatToolError('USAGE_INVALID_VERSION', `--dsh-version "${options.dshVersion}" 不是合法 semver`);
  }
  if (options.cpVersion !== null && !isValidVersion(options.cpVersion)) {
    throw new CompatToolError('USAGE_INVALID_VERSION', `--cp-version "${options.cpVersion}" 不是合法 semver`);
  }
  return options;
}

/* ------------------------------------------------------------------ */
/* 文件读写                                                            */
/* ------------------------------------------------------------------ */

export function readJsonFile(file, label) {
  if (!existsSync(file)) {
    throw new CompatToolError(
      'COMPAT_FILE_MISSING',
      `未找到 ${label}：${file}\n` +
        '兼容清单缺失时本脚本不会静默创建它（避免伪造兼容承诺）。请从仓库恢复该文件后重试。',
    );
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new CompatToolError('COMPAT_FILE_UNREADABLE', `无法读取 ${label}（${error?.code || 'READ_FAILED'}）：${file}`);
  }
  try {
    return { data: JSON.parse(raw), raw };
  } catch (error) {
    throw new CompatToolError('COMPAT_FILE_INVALID', `${label} 不是合法 JSON（${error?.message || 'parse error'}）：${file}`);
  }
}

export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/* 版本检测                                                            */
/* ------------------------------------------------------------------ */

const SEMVER_IN_TEXT = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.-])/;

/** 从任意文本中提取第一个合法 semver（用于 `dsh -V` / /api/health 等）。 */
export function extractSemver(text) {
  if (typeof text !== 'string') return null;
  const match = SEMVER_IN_TEXT.exec(text.trim());
  if (!match) return null;
  return isValidVersion(match[1]) ? match[1] : null;
}

/** `dsh` CLI 的常见安装位置（best effort；找不到就继续下一处）。 */
export function dshCliCandidates(env = process.env) {
  const candidates = [];
  const explicit = typeof env.DSH_CLI === 'string' ? env.DSH_CLI.trim() : '';
  if (explicit) candidates.push({ path: explicit, source: 'env:DSH_CLI' });
  candidates.push({ path: 'dsh', source: 'PATH:dsh' });
  if (process.platform === 'darwin') {
    candidates.push({
      path: '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      source: 'macOS:/Applications/DeepSeek Harness.app',
    });
    if (env.HOME) {
      candidates.push({
        path: join(env.HOME, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'),
        source: 'macOS:~/Applications/DeepSeek Harness.app',
      });
    }
  } else if (process.platform === 'win32') {
    // Windows 暂无公开稳定安装路径：best effort 尝试 LOCALAPPDATA 下的常见目录。
    const localAppData = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA : '';
    if (localAppData) {
      candidates.push({
        path: join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
        source: 'win32:%LOCALAPPDATA%/DeepSeek Harness',
      });
    }
  } else {
    // Linux：AppImage / 系统安装的 best effort 路径。
    candidates.push({ path: '/opt/deepseek-harness/resources/runtime/cli/bin/dsh', source: 'linux:/opt/deepseek-harness' });
    candidates.push({ path: '/usr/local/bin/dsh', source: 'linux:/usr/local/bin/dsh' });
  }
  return candidates;
}

/** 执行 `dsh -V` 并解析版本；失败返回 null（不抛）。 */
export function probeDshCli(candidate, { spawnImpl = spawnSync, timeoutMs = 5000 } = {}) {
  try {
    const result = spawnImpl(candidate.path, ['-V'], { encoding: 'utf8', timeout: timeoutMs });
    if (!result || result.error || result.status !== 0) return null;
    const version = extractSemver(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    return version ? { version, source: candidate.source } : null;
  } catch {
    return null;
  }
}

/**
 * 按优先级检测 DSH 宿主版本（全部失败返回 null，不抛）：
 *  1. --dsh-version
 *  2. DSH_RUNTIME_VERSION 环境变量
 *  3. readLocalDshVersion()（$DSH_HOME/runtime.json，默认 ~/.dsh）
 *  4. dsh CLI（$DSH_CLI / PATH / 常见安装路径）执行 `-V`
 * @returns {{version:string|null, source:string|null, attempts:Array<{source:string, ok:boolean}>}}
 */
export function detectDshVersion({ options, env = process.env, spawnImpl = spawnSync, skipCli = false } = {}) {
  const attempts = [];
  const record = (source, version) => {
    attempts.push({ source, ok: Boolean(version), version: version ?? null });
    return { version: version ?? null, source: version ? source : null };
  };

  if (options?.dshVersion) return { ...record('--dsh-version', options.dshVersion), attempts };

  const fromEnv = typeof env.DSH_RUNTIME_VERSION === 'string' ? env.DSH_RUNTIME_VERSION.trim() : '';
  if (fromEnv && isValidVersion(fromEnv)) return { ...record('env:DSH_RUNTIME_VERSION', fromEnv), attempts };

  try {
    const local = readLocalDshVersion({ env });
    if (local?.version && isValidVersion(local.version)) {
      return { ...record(local.source || 'runtime.json', local.version), attempts };
    }
    attempts.push({ source: 'runtime.json (readLocalDshVersion)', ok: false, version: null });
  } catch (error) {
    attempts.push({ source: 'readLocalDshVersion', ok: false, version: null, error: error?.message });
  }

  if (!skipCli && !options?.noDshCli) {
    for (const candidate of dshCliCandidates(env)) {
      const found = probeDshCli(candidate, { spawnImpl });
      if (found) return { ...record(`${found.source} (dsh -V)`, found.version), attempts };
      attempts.push({ source: `${candidate.source} (dsh -V)`, ok: false, version: null });
    }
  }
  return { version: null, source: null, attempts };
}

/** 从 `runtime/version.mjs` 源码文本里解析 RUNTIME_VERSION（只读文本，不执行代码）。 */
export function readRuntimeVersionFile(file) {
  try {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8');
    const match = /RUNTIME_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(text);
    if (!match) return null;
    const version = match[1].trim();
    return isValidVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/** 已安装 CircuitPilot App 的版本（macOS Info.plist → Resources/runtime/version.mjs；其它平台 best effort）。 */
export function detectInstalledCpVersion({ env = process.env, spawnImpl = spawnSync } = {}) {
  if (process.platform === 'darwin') {
    const appRoots = ['/Applications/CircuitPilot.app'];
    if (env.HOME) appRoots.push(join(env.HOME, 'Applications', 'CircuitPilot.app'));
    for (const appRoot of appRoots) {
      const plist = join(appRoot, 'Contents', 'Info.plist');
      if (existsSync(plist)) {
        try {
          const result = spawnImpl(
            'plutil',
            ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist],
            { encoding: 'utf8', timeout: 5000 },
          );
          const version = result && !result.error && result.status === 0 ? String(result.stdout ?? '').trim() : '';
          if (isValidVersion(version)) return { version, source: plist };
        } catch {
          /* fall through */
        }
      }
      const versionFile = join(appRoot, 'Contents', 'Resources', 'runtime', 'version.mjs');
      const fromFile = readRuntimeVersionFile(versionFile);
      if (fromFile) return { version: fromFile, source: versionFile };
    }
    return null;
  }
  // Linux / Windows：没有稳定的公开安装路径，best effort 探测常见位置（找不到就返回 null）。
  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA : '';
    if (localAppData) {
      candidates.push(join(localAppData, 'Programs', 'CircuitPilot', 'resources', 'runtime', 'version.mjs'));
      candidates.push(join(localAppData, 'CircuitPilot', 'resources', 'runtime', 'version.mjs'));
    }
  } else {
    candidates.push('/opt/CircuitPilot/resources/runtime/version.mjs');
    if (env.HOME) candidates.push(join(env.HOME, '.local', 'share', 'CircuitPilot', 'resources', 'runtime', 'version.mjs'));
  }
  for (const file of candidates) {
    const version = readRuntimeVersionFile(file);
    if (version) return { version, source: file };
  }
  return null;
}

/**
 * 只读探测 CircuitPilot /api/health（公开路由，无需 token；3s 超时；失败不抛）。
 * @returns {Promise<{url:string, ok:boolean, status:number|null, version:string|null, service:string|null, error:string|null, elapsedMs:number}>}
 */
export async function probeRuntimeHealth(url, { timeoutMs = RUNTIME_PROBE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const base = String(url || DEFAULT_RUNTIME_URL).trim().replace(/\/+$/, '');
  const startedAt = Date.now();
  const result = { url: base, ok: false, status: null, version: null, service: null, error: null, elapsedMs: 0 };
  try {
    if (typeof fetchImpl !== 'function') throw new Error('fetch 不可用');
    const response = await fetchImpl(`${base}/api/health`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    result.status = response?.status ?? null;
    result.ok = Boolean(response?.ok);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    result.version = typeof body?.version === 'string' && isValidVersion(body.version.trim()) ? body.version.trim() : null;
    result.service = typeof body?.service === 'string' ? body.service : null;
  } catch (error) {
    result.error = error?.code || error?.name || 'PROBE_FAILED';
  }
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

/**
 * 按优先级检测 CircuitPilot Runtime 版本。
 *
 * 权威链：--cp-version > CIRCUITPILOT_RUNTIME_VERSION > 显式 --runtime-url/CIRCUITPILOT_RUNTIME_URL 的
 * /api/health > 本仓库 runtime/version.mjs > 已安装 App > 运行中实例（兜底）。
 * 运行中的 /api/health 始终会探测（除非 --no-runtime-probe），但默认只作为观测值：
 * 本机可能跑着不兼容的旧构建，不能让它推翻「仓库/已安装 App」的权威版本。
 *
 * @returns {Promise<{detected:{version:string|null, source:string|null, authoritative:boolean},
 *   observedRuntime:object|null, attempts:Array<{source:string, ok:boolean, version:string|null}>}>}
 */
export async function detectCpVersion({
  options,
  env = process.env,
  pluginDir = DEFAULT_PLUGIN_DIR,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawnSync,
} = {}) {
  const attempts = [];
  const record = (source, version, authoritative = true) => {
    attempts.push({ source, ok: Boolean(version), version: version ?? null });
    return { detected: { version: version ?? null, source: version ? source : null, authoritative }, observedRuntime: observedRuntime ?? null, attempts };
  };

  let observedRuntime = null;
  const envRuntimeUrl = typeof env.CIRCUITPILOT_RUNTIME_URL === 'string' ? env.CIRCUITPILOT_RUNTIME_URL.trim() : '';
  const runtimeUrl = options?.runtimeUrl || envRuntimeUrl || DEFAULT_RUNTIME_URL;
  const runtimeUrlIsExplicit = Boolean(options?.runtimeUrlExplicit || envRuntimeUrl);
  if (!options?.noRuntimeProbe) {
    observedRuntime = await probeRuntimeHealth(runtimeUrl, { fetchImpl });
    attempts.push({ source: `runtime:${runtimeUrl}`, ok: Boolean(observedRuntime.version), version: observedRuntime.version });
  }

  if (options?.cpVersion) return record('--cp-version', options.cpVersion);

  const fromEnv = typeof env.CIRCUITPILOT_RUNTIME_VERSION === 'string' ? env.CIRCUITPILOT_RUNTIME_VERSION.trim() : '';
  if (fromEnv && isValidVersion(fromEnv)) return record('env:CIRCUITPILOT_RUNTIME_VERSION', fromEnv);

  if (runtimeUrlIsExplicit && observedRuntime?.version) {
    return record(`runtime:${runtimeUrl} (/api/health)`, observedRuntime.version);
  }

  // 本仓库 runtime/version.mjs（插件目录在 <repo>/plugin/dsh-circuitpilot 时成立）
  const repoVersionFile = resolve(pluginDir, '..', '..', 'runtime', 'version.mjs');
  const repoVersion = readRuntimeVersionFile(repoVersionFile);
  if (repoVersion) return record(repoVersionFile, repoVersion);

  const installed = detectInstalledCpVersion({ env, spawnImpl });
  if (installed) return record(installed.source, installed.version);

  if (observedRuntime?.version) return record(`runtime:${runtimeUrl} (/api/health，兜底)`, observedRuntime.version);
  return record(null, null);
}

/* ------------------------------------------------------------------ */
/* 区间放宽规则                                                        */
/* ------------------------------------------------------------------ */

/** 从区间文本里取上下界：上界取最后一个 `<X.Y.Z`，下界取第一个 `>=X.Y.Z`。 */
export function parseRangeBounds(range) {
  const text = typeof range === 'string' ? range : '';
  const lowerMatch = />=\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text);
  let upper = null;
  const upperPattern = /<\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;
  let match;
  while ((match = upperPattern.exec(text)) !== null) upper = match[1];
  return { lower: lowerMatch ? lowerMatch[1] : null, upper };
}

/**
 * 计算「检测版本越界时是否自动放宽上界」。
 *
 * 规则（任务 C 约定）：
 *  - 已被覆盖 → none；
 *  - 低于下界 → manual（不自动降低下界，避免悄悄扩大对旧版本的承诺）；
 *  - 同一 major 的更高 minor → 上界放宽为 `<major.(minor+1).0`，下界保留；
 *  - 跨 major / 区间无下界 / 规则无法覆盖 → manual；
 *  - 安全护栏：跨 minor 跨度 > 1（例如 CircuitPilot 0.2.x → 0.8.15）不自动放宽 ——
 *    这种跳跃几乎必然伴随不兼容变更，自动放宽会把「只验证过 0.2.x」说成「兼容 0.8.x」。
 *    这种情况标记 manual，要求人工确认后再改 compat.json。
 *
 * @returns {{action:'none'|'widen'|'manual', range:string, nextRange?:string, reason:string}}
 */
export function planRangeWiden({ range, version, label = '版本' }) {
  const parsed = parseVersion(version);
  const text = typeof range === 'string' ? range.trim() : '';
  if (!parsed || !text) {
    return { action: 'manual', range: text, reason: `${label}无法解析区间或版本（range=${range}, version=${version}）` };
  }
  if (satisfiesRange(version, text)) return { action: 'none', range: text, reason: `${label} ${version} 已被 ${text} 覆盖` };

  const bounds = parseRangeBounds(text);
  const lowerParsed = bounds.lower ? parseVersion(bounds.lower) : null;
  const upperParsed = bounds.upper ? parseVersion(bounds.upper) : null;
  if (!lowerParsed || !bounds.lower) {
    return { action: 'manual', range: text, reason: `${label}区间 ${text} 缺少可解析的下界（>=x.y.z），无法安全地自动放宽` };
  }
  if (compareVersions(version, bounds.lower) < 0) {
    return {
      action: 'manual',
      range: text,
      reason:
        `${label} ${version} 低于支持区间下界 ${bounds.lower}。` +
        '按规则不自动降低下界（避免悄悄扩大对旧版本的兼容承诺），需要人工确认是否仍支持旧版本。',
    };
  }
  if (parsed.major !== lowerParsed.major || (upperParsed && parsed.major !== upperParsed.major)) {
    return {
      action: 'manual',
      range: text,
      reason:
        `${label} ${version} 跨 major（当前上界 ${bounds.upper ?? '无'}），跨 major 需要人工评估 API 变化，` +
        '不自动放宽。请先人工验证后修改 compat.json 的 supported 区间。',
    };
  }
  const upperMinor = upperParsed ? upperParsed.minor : lowerParsed.minor;
  if (parsed.minor - upperMinor > 1) {
    return {
      action: 'manual',
      range: text,
      reason:
        `${label} ${version} 相对当前上界 ${bounds.upper ?? '无'} 跨了 ${parsed.minor - upperMinor} 个 minor，` +
        '跨度 > 1 时几乎必然伴随不兼容变更，不自动放宽。请先人工验证后再改 compat.json。',
    };
  }
  const nextRange = `>=${bounds.lower} <${parsed.major}.${parsed.minor + 1}.0`;
  if (!satisfiesRange(version, nextRange)) {
    return { action: 'manual', range: text, reason: `${label} ${version} 无法被自动放宽规则 ${nextRange} 覆盖` };
  }
  return {
    action: 'widen',
    range: text,
    nextRange,
    reason: `${label} ${version} 超出上界：按同 major 规则把区间放宽为 ${nextRange}（下界保持 ${bounds.lower}）`,
  };
}

/* ------------------------------------------------------------------ */
/* 同步计划（纯函数，便于单测）                                        */
/* ------------------------------------------------------------------ */

/** 合并 verified 列表：去重 + 过滤非法版本 + semver 升序排序。 */
export function mergeVerifiedVersions(existing, version) {
  const set = new Set();
  for (const value of [...(Array.isArray(existing) ? existing : []), version]) {
    if (typeof value === 'string' && isValidVersion(value.trim())) set.add(value.trim());
  }
  return [...set].sort((left, right) => compareVersions(left, right) ?? 0);
}

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return left === right;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function pushChange(changes, file, path, from, to) {
  changes.push({ file, path, from: from ?? null, to: to ?? null });
}

/**
 * 计算 compat.json 的同步结果（不写盘）。
 * @param {object} compat 现有 compat.json 内容
 * @param {{dshVersion?:string|null, cpVersion?:string|null}} versions
 * @returns {{nextCompat:object, changes:Array, warnings:Array}}
 */
export function planCompatSync(compat, { dshVersion = null, cpVersion = null } = {}) {
  const nextCompat = JSON.parse(JSON.stringify(compat));
  const changes = [];
  const warnings = [];
  if (!nextCompat.dsh || typeof nextCompat.dsh !== 'object') nextCompat.dsh = {};
  if (!nextCompat.circuitpilot || typeof nextCompat.circuitpilot !== 'object') nextCompat.circuitpilot = {};

  const planOne = ({ key, version, rangeKey, verifiedKey, label }) => {
    const section = nextCompat[key];
    if (!version) {
      warnings.push({
        code: `${key.toUpperCase()}_VERSION_UNDETECTED`,
        message: `未检测到${label}版本，跳过该维度的同步（不影响 check 通过；可用 --${key === 'dsh' ? 'dsh' : 'cp'}-version 指定）`,
      });
      return;
    }
    const currentRange = section[rangeKey];
    const widen = planRangeWiden({ range: currentRange, version, label });
    if (widen.action === 'widen') {
      section[rangeKey] = widen.nextRange;
      pushChange(changes, 'compat.json', `${key}.${rangeKey}`, currentRange, widen.nextRange);
      warnings.push({ code: `${key.toUpperCase()}_RANGE_WIDENED`, message: widen.reason, level: 'info' });
    } else if (widen.action === 'manual') {
      warnings.push({
        code: `${key.toUpperCase()}_RANGE_MANUAL`,
        message: widen.reason,
        level: 'warn',
        hint:
          `人工确认后编辑 compat.json 的 ${key}.${rangeKey}，再执行 ` +
          `node scripts/sync-compat.mjs --${key === 'dsh' ? 'dsh' : 'cp'}-version ${version}`,
      });
    }
    const finalRange = section[rangeKey];
    if (satisfiesRange(version, finalRange)) {
      const before = Array.isArray(section[verifiedKey]) ? [...section[verifiedKey]] : [];
      const after = mergeVerifiedVersions(before, version);
      if (!arraysEqual(before, after)) {
        section[verifiedKey] = after;
        pushChange(changes, 'compat.json', `${key}.${verifiedKey}`, before, after);
      }
    } else if (widen.action !== 'manual') {
      warnings.push({
        code: `${key.toUpperCase()}_VERIFIED_SKIPPED`,
        message: `${label} ${version} 未被最终区间 ${finalRange} 覆盖，未写入 verified 列表`,
        level: 'warn',
      });
    }
  };

  planOne({ key: 'dsh', version: dshVersion, rangeKey: 'supported', verifiedKey: 'verified', label: 'DSH' });
  planOne({ key: 'circuitpilot', version: cpVersion, rangeKey: 'supportedRuntime', verifiedKey: 'verifiedRuntime', label: 'CircuitPilot Runtime' });

  return { nextCompat, changes, warnings };
}

/**
 * 计算 package.json 的同步结果（字段级更新，不整文件覆盖其它字段）。
 * - engines.dsh = compat.json.dsh.supported
 * - peerDependencies["@deepseek-ai/dsh-skill" | "@deepseek-ai/dsh-mcp-client"] = compat.json.dsh.supported
 * - @deepseek-ai/cordis / schemastery 保持现状（不在此处承诺）
 */
export function planPackageSync(pkg, compat) {
  const nextPkg = JSON.parse(JSON.stringify(pkg));
  const changes = [];
  const warnings = [];
  const range = compat?.dsh?.supported;
  if (typeof range !== 'string' || !range.trim()) {
    throw new CompatToolError('COMPAT_INVALID', 'compat.json 缺少 dsh.supported 区间，无法同步 package.json');
  }

  if (!nextPkg.engines || typeof nextPkg.engines !== 'object' || Array.isArray(nextPkg.engines)) nextPkg.engines = {};
  if (nextPkg.engines.dsh !== range) {
    pushChange(changes, 'package.json', 'engines.dsh', nextPkg.engines.dsh, range);
    nextPkg.engines.dsh = range;
  }

  if (!nextPkg.peerDependencies || typeof nextPkg.peerDependencies !== 'object' || Array.isArray(nextPkg.peerDependencies)) {
    warnings.push({
      code: 'PEER_DEPENDENCIES_MISSING',
      message: 'package.json 没有 peerDependencies 对象，跳过 dsh-* peer 区间同步（请恢复清单后重试）',
    });
  } else {
    for (const name of DSH_PEER_PACKAGES) {
      if (nextPkg.peerDependencies[name] !== range) {
        pushChange(changes, 'package.json', `peerDependencies["${name}"]`, nextPkg.peerDependencies[name], range);
        nextPkg.peerDependencies[name] = range;
      }
    }
  }
  return { nextPkg, changes, warnings };
}

/**
 * 校验 package.json 与 compat.json 的一致性（check 模式的核心门禁）。
 * @returns {{ok:boolean, problems:string[]}}
 */
export function evaluateManifestConsistency(compat, pkg) {
  const problems = [];
  const expected = compat?.dsh?.supported;
  if (typeof expected !== 'string' || !expected.trim()) {
    problems.push('compat.json 缺少 dsh.supported');
  }
  const enginesDsh = pkg?.engines?.dsh;
  if (enginesDsh !== expected) {
    problems.push(`package.json engines.dsh（${enginesDsh ?? '缺失'}）!== compat.json dsh.supported（${expected ?? '缺失'}）`);
  }
  for (const name of DSH_PEER_PACKAGES) {
    const value = pkg?.peerDependencies?.[name];
    if (value !== expected) {
      problems.push(`package.json peerDependencies["${name}"]（${value ?? '缺失'}）!== compat.json dsh.supported（${expected ?? '缺失'}）`);
    }
  }
  if (!Array.isArray(pkg?.files) || !pkg.files.includes('compat.json')) {
    problems.push('package.json files 未包含 compat.json（运行期 lib/compat.mjs 必须能读到它）');
  }
  if (!isValidVersion(pkg?.version)) {
    problems.push(`package.json version（${pkg?.version}）不是合法 semver`);
  }
  const compatVersion = compat?.schemaVersion;
  if (compatVersion !== 1) problems.push(`compat.json schemaVersion 应为 1（实际 ${compatVersion}）`);
  for (const [key, rangeKey, verifiedKey] of [
    ['dsh', 'supported', 'verified'],
    ['circuitpilot', 'supportedRuntime', 'verifiedRuntime'],
  ]) {
    const section = compat?.[key];
    if (!section || typeof section !== 'object') {
      problems.push(`compat.json 缺少 ${key} 段`);
      continue;
    }
    if (typeof section[rangeKey] !== 'string' || !section[rangeKey].trim()) problems.push(`compat.json 缺少 ${key}.${rangeKey}`);
    if (!Array.isArray(section[verifiedKey])) problems.push(`compat.json 缺少 ${key}.${verifiedKey} 数组`);
    else {
      const invalid = section[verifiedKey].filter((value) => !isValidVersion(value));
      if (invalid.length > 0) problems.push(`compat.json ${key}.${verifiedKey} 含非法版本：${invalid.join(', ')}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */

function evaluationFor(version, range) {
  const normalized = typeof version === 'string' ? version.trim() : '';
  if (!normalized || !isValidVersion(normalized)) {
    return { supported: false, unknown: true, version: normalized || null, range, reason: '未检测到/无法解析版本，无法判定（skip）' };
  }
  const supported = satisfiesRange(normalized, range);
  return {
    supported,
    unknown: false,
    version: normalized,
    range,
    reason: supported ? null : `${normalized} 不在支持区间 ${range} 内`,
  };
}

/** 组装 check 报告主体（纯函数，便于单测）。 */
export function buildCheckReport({ compat, pkg, dshDetected, cpDetected, pluginDir }) {
  const manifest = evaluateManifestConsistency(compat, pkg);
  const dsh = evaluationFor(dshDetected.version, compat?.dsh?.supported ?? '');
  const cp = evaluationFor(cpDetected.version, compat?.circuitpilot?.supportedRuntime ?? '');
  const skipped = [];
  if (!dshDetected.version) skipped.push('DSH');
  if (!cpDetected.version) skipped.push('CircuitPilot');
  const problems = [...manifest.problems];
  if (!dsh.unknown && !dsh.supported) problems.push(`DSH ${dsh.version} 不在支持区间 ${dsh.range} 内`);
  if (!cp.unknown && !cp.supported) problems.push(`CircuitPilot Runtime ${cp.version} 不在支持区间 ${cp.range} 内`);
  const observed = cpDetected.observedRuntime;
  const warnings = [];
  if (observed && observed.version && !isValidVersion(observed.version)) {
    // noop：非 semver 的 health 版本只提示存在，不参与判定
  }
  if (observed?.version && satisfiesRange(observed.version, compat?.circuitpilot?.supportedRuntime ?? '') === false) {
    warnings.push({
      code: 'RUNTIME_OBSERVED_INCOMPATIBLE',
      level: 'warn',
      message:
        `运行中的 CircuitPilot ${observed.url} 报告版本 ${observed.version}，不在支持区间 ` +
        `${compat?.circuitpilot?.supportedRuntime} 内（可能是旧构建）；权威判定以 ` +
        `${cpDetected.source ?? '仓库/安装包版本'} 为准。`,
    });
  }
  if (observed && !observed.version) warnings.push({ code: 'RUNTIME_PROBE_UNAVAILABLE', level: 'info', message: `未能探测 ${observed.url}（${observed.error ?? '无版本号'}），已忽略` });
  return { ok: problems.length === 0, pluginDir, dsh: { ...dsh, source: dshDetected.source }, circuitpilot: { ...cp, source: cpDetected.source, observedRuntime: observed ?? null, authoritative: cpDetected.authoritative }, manifest, skipped, problems, warnings };
}

function formatList(values) {
  return Array.isArray(values) && values.length > 0 ? values.join(', ') : '（空）';
}

function formatChange(change) {
  const name = change.file === 'compat.json' ? 'compat.json' : 'package.json';
  return `${name} ${change.path}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`;
}

/** 生成人类可读报告文本。 */
export function formatHumanReport(report) {
  const lines = [];
  const modeLabel = report.mode === 'check' ? 'check（只读门禁）' : report.mode === 'dry-run' ? 'dry-run（只预览不落盘）' : 'sync（写入）';
  lines.push(`dsh-circuitpilot 兼容性同步 · 模式=${modeLabel}`);
  lines.push(`插件目录：${report.pluginDir}`);
  lines.push('');
  lines.push('[DSH 宿主]');
  lines.push(`  检测版本：${report.dsh.version ?? '未检测到'}${report.dsh.source ? `（来源：${report.dsh.source}）` : ''}`);
  lines.push(`  支持区间：${report.dsh.range}${report.dsh.unknown ? '（无法判定，skip）' : report.dsh.supported ? '  ✓ 覆盖' : '  ✗ 越界'}`);
  lines.push(`  已验证版本：${formatList(report.compat?.dsh?.verified ?? report.dsh.verified ?? [])}`);
  lines.push('');
  lines.push('[CircuitPilot Runtime]');
  lines.push(`  检测版本：${report.circuitpilot.version ?? '未检测到'}${report.circuitpilot.source ? `（来源：${report.circuitpilot.source}）` : ''}`);
  lines.push(`  支持区间：${report.circuitpilot.range}${report.circuitpilot.unknown ? '（无法判定，skip）' : report.circuitpilot.supported ? '  ✓ 覆盖' : '  ✗ 越界'}`);
  lines.push(`  已验证版本：${formatList(report.compat?.circuitpilot?.verifiedRuntime ?? report.circuitpilot.verified ?? [])}`);
  const observed = report.circuitpilot.observedRuntime;
  if (observed) {
    const inRange = observed.version ? satisfiesRange(observed.version, report.circuitpilot.range) : false;
    lines.push(
      `  运行中实例：${observed.url} → ${observed.version ?? '未探测到'}${observed.version ? (inRange ? '  ✓ 覆盖' : '  ⚠ 不在支持区间（可能是旧构建，不影响权威判定）') : ''}`,
    );
  }
  lines.push('');
  lines.push('[清单一致性]');
  lines.push(report.manifest.ok ? '  ✓ package.json 与 compat.json 一致（engines.dsh / dsh-* peerDependencies / files）' : '  ✗ package.json 与 compat.json 不一致：');
  for (const problem of report.manifest.problems) lines.push(`    - ${problem}`);
  if (report.manifestAfter) {
    lines.push(report.manifestAfter.ok ? '  ✓ 写入后：package.json 与 compat.json 一致' : '  ✗ 写入后仍不一致（需人工处理）：');
    for (const problem of report.manifestAfter.problems) lines.push(`    - ${problem}`);
  }
  if (report.writes && report.writes.length > 0) {
    lines.push('');
    lines.push(`[${report.mode === 'dry-run' ? '将写入（dry-run 未落盘）' : '写入'}]`);
    for (const write of report.writes) {
      if (!write.changed) {
        lines.push(`  ${write.file}：无变化`);
        continue;
      }
      lines.push(`  ${write.file}：`);
      for (const change of write.changes) lines.push(`    - ${formatChange(change)}`);
    }
  }
  if (report.tests && report.tests.ran) {
    lines.push('');
    lines.push('[测试]');
    lines.push(
      `  ${report.tests.ok ? '✓' : '✗'} node --test "test/*.test.mjs"  ${report.tests.summary ?? `exit=${report.tests.exitCode}`}`,
    );
    if (!report.tests.ok && report.tests.tail) {
      lines.push('  失败输出尾部：');
      for (const line of report.tests.tail.split('\n').slice(-25)) lines.push(`    ${line}`);
    }
  } else if (report.tests && !report.tests.ran) {
    lines.push('');
    lines.push('[测试]');
    const skipText = report.tests.skipReason === 'dry-run'
      ? 'dry-run 不落盘，不跑测试'
      : report.tests.skipReason === 'check'
        ? 'check 模式只读判定，不跑测试'
        : '--no-test';
    lines.push(`  已跳过（${skipText}）`);
  }
  if (report.problems && report.problems.length > 0) {
    lines.push('');
    lines.push('[问题]');
    for (const problem of report.problems) lines.push(`  ✗ ${problem}`);
  }
  if (report.warnings && report.warnings.length > 0) {
    lines.push('');
    lines.push('[提示]');
    for (const warning of report.warnings) {
      lines.push(`  ${warning.level === 'warn' ? '⚠' : '·'} ${warning.message}`);
      if (warning.hint) lines.push(`    → ${warning.hint}`);
    }
  }
  if (report.skipped && report.skipped.length > 0) {
    lines.push('');
    lines.push(`[跳过] 未检测到 ${report.skipped.join(' / ')} 版本：视为 skip（CI 无本机宿主属正常），不算失败`);
  }
  lines.push('');
  lines.push('[下一步]');
  for (const step of report.nextSteps ?? []) lines.push(`  · ${step}`);
  lines.push('');
  const changedFiles = (report.writes ?? []).filter((write) => write.changed).map((write) => write.file);
  if (report.mode === 'check') {
    lines.push(report.ok ? '结论：✓ 兼容（无需动作）' : '结论：✗ 存在漂移/不一致，见上');
  } else if (report.mode === 'dry-run') {
    lines.push(
      changedFiles.length > 0
        ? `结论：预览完成，将写入 ${changedFiles.join(' / ')}（未落盘）`
        : '结论：预览完成，清单已是最新（无需写入）',
    );
  } else if (report.rolledBack) {
    lines.push('结论：✗ 写入已回滚（测试未通过），见上');
  } else {
    lines.push(report.ok ? `结论：✓ 同步完成${changedFiles.length > 0 ? `（已写入 ${changedFiles.join(' / ')}）` : '（幂等：无变化）'}` : '结论：✗ 未完成，见上');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 测试执行                                                            */
/* ------------------------------------------------------------------ */

/** 在插件目录跑全量测试（spawnSync，不抛）。 */
export function runPluginTests(pluginDir, { spawnImpl = spawnSync, timeoutMs = TEST_TIMEOUT_MS } = {}) {
  // 去掉父进程的 node:test 内部环境变量，避免子测试进程被误认为 test runner 的 worker。
  const childEnv = { ...process.env, NODE_OPTIONS: '' };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_V8_COVERAGE;
  const result = spawnImpl(process.execPath, ['--test', 'test/*.test.mjs'], {
    cwd: pluginDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: childEnv,
  });
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  const summary = parseTestSummary(output);
  return {
    ran: true,
    ok: result?.status === 0 && !result?.error,
    exitCode: result?.status ?? null,
    signal: result?.signal ?? null,
    timedOut: Boolean(result?.error && result.error.code === 'ETIMEDOUT'),
    summary: summary.text,
    counts: summary.counts,
    tail: output.trim().split('\n').slice(-40).join('\n'),
  };
}

/** 解析 node:test 输出（兼容 TAP 与 spec reporter 两种格式）。 */
export function parseTestSummary(output) {
  const text = typeof output === 'string' ? output : '';
  const counts = {};
  const patterns = [
    ['tests', /(?:^|\n)\s*#\s*tests\s+(\d+)|ℹ\s*tests\s+(\d+)/],
    ['pass', /(?:^|\n)\s*#\s*pass\s+(\d+)|ℹ\s*pass\s+(\d+)/],
    ['fail', /(?:^|\n)\s*#\s*fail\s+(\d+)|ℹ\s*fail\s+(\d+)/],
    ['skipped', /(?:^|\n)\s*#\s*skipped\s+(\d+)|ℹ\s*skipped\s+(\d+)/],
    ['cancelled', /(?:^|\n)\s*#\s*cancelled\s+(\d+)|ℹ\s*cancelled\s+(\d+)/],
  ];
  for (const [key, pattern] of patterns) {
    const match = pattern.exec(text);
    if (match) counts[key] = Number(match[1] ?? match[2]);
  }
  const parts = [];
  for (const key of ['tests', 'pass', 'fail', 'skipped', 'cancelled']) {
    if (counts[key] !== undefined) parts.push(`${key}=${counts[key]}`);
  }
  return { counts, text: parts.join(' ') || null };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function emitReport(report, options, { toStderr = false } = {}) {
  if (options.json) {
    if (toStderr) process.stderr.write(`${formatHumanReport(report)}\n`);
    else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatHumanReport(report)}\n`);
}

function buildBaseReport(options, pluginDir) {
  return {
    tool: 'sync-compat',
    schemaVersion: 1,
    mode: options.mode === 'check' ? 'check' : options.dryRun ? 'dry-run' : 'sync',
    pluginDir,
    ok: false,
    dsh: {},
    circuitpilot: {},
    manifest: { ok: false, problems: [] },
    writes: [],
    tests: { ran: false },
    warnings: [],
    problems: [],
    skipped: [],
    nextSteps: [],
  };
}

/**
 * 执行一次同步/检查。
 * @returns {Promise<number>} 进程退出码
 */
export async function run(options, { env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch, spawnImpl = spawnSync } = {}) {
  const pluginDir = resolve(cwd, options.pluginDir ?? DEFAULT_PLUGIN_DIR);
  const compatFile = join(pluginDir, 'compat.json');
  const packageFile = join(pluginDir, 'package.json');
  const report = buildBaseReport(options, pluginDir);

  // 1) 读取清单（缺失/损坏 → 清晰错误，绝不静默创建）
  const { data: compat } = readJsonFile(compatFile, '兼容清单 compat.json');
  const { data: pkg } = readJsonFile(packageFile, '包清单 package.json');
  report.compat = compat;

  // 2) 检测版本
  const dshDetected = detectDshVersion({ options, env, spawnImpl });
  const cpDetected = await detectCpVersion({ options, env, pluginDir, fetchImpl, spawnImpl });
  const dshRange = compat?.dsh?.supported ?? '';
  const cpRange = compat?.circuitpilot?.supportedRuntime ?? '';
  report.dsh = {
    version: dshDetected.version,
    source: dshDetected.source,
    range: dshRange,
    verified: compat?.dsh?.verified ?? [],
    attempts: dshDetected.attempts,
    ...evaluationFor(dshDetected.version, dshRange),
  };
  report.circuitpilot = {
    version: cpDetected.detected.version,
    source: cpDetected.detected.source,
    authoritative: cpDetected.detected.authoritative,
    range: cpRange,
    verified: compat?.circuitpilot?.verifiedRuntime ?? [],
    observedRuntime: cpDetected.observedRuntime,
    attempts: cpDetected.attempts,
    ...evaluationFor(cpDetected.detected.version, cpRange),
  };
  report.manifest = evaluateManifestConsistency(compat, pkg);

  // 3) 计算同步计划（compat.json + package.json 字段级投影）
  const compatPlan = planCompatSync(compat, {
    dshVersion: dshDetected.version,
    cpVersion: cpDetected.detected.version,
  });
  const packagePlan = planPackageSync(pkg, compatPlan.nextCompat);
  const manualWarnings = [...compatPlan.warnings, ...packagePlan.warnings].filter((warning) => warning.level === 'warn');
  const infoWarnings = [...compatPlan.warnings, ...packagePlan.warnings].filter((warning) => warning.level !== 'warn');

  // 4) check 模式：只读判定
  if (options.mode === 'check') {
    const checkReport = buildCheckReport({
      compat,
      pkg,
      dshDetected: { version: dshDetected.version, source: dshDetected.source },
      cpDetected: {
        version: cpDetected.detected.version,
        source: cpDetected.detected.source,
        authoritative: cpDetected.detected.authoritative,
        observedRuntime: cpDetected.observedRuntime,
      },
      pluginDir,
    });
    report.tests = { ran: false, skipReason: 'check' };
    Object.assign(report, {
      ok: checkReport.ok && manualWarnings.length === 0,
      dsh: { ...report.dsh, ...checkReport.dsh },
      circuitpilot: { ...report.circuitpilot, ...checkReport.circuitpilot },
      manifest: checkReport.manifest,
      skipped: checkReport.skipped,
      problems: checkReport.problems,
      warnings: [...checkReport.warnings, ...infoWarnings.map((warning) => ({ level: 'info', ...warning }))],
    });
    // check 模式不应因「未探测到版本」而失败，但计划里的 manual 越界警告要算失败
    if (!report.ok) {
      report.nextSteps = buildFixSteps({ dshVersion: dshDetected.version, cpVersion: cpDetected.detected.version, problems: report.problems, manualWarnings });
    } else {
      report.nextSteps = ['无需动作：CI/发版前保持 `node scripts/sync-compat.mjs --check` 全绿即可。'];
    }
    emitReport(report, options);
    return report.ok ? EXIT.OK : EXIT.DRIFT;
  }

  // 5) 规划写入内容（事务式：先算好，全部写完后跑测试，失败恢复）
  const writes = [];
  if (JSON.stringify(compatPlan.nextCompat) !== JSON.stringify(compat)) {
    writes.push({ file: compatFile, label: 'compat.json', content: serializeJson(compatPlan.nextCompat), before: JSON.stringify(compat), changes: compatPlan.changes, changed: true });
  }
  if (JSON.stringify(packagePlan.nextPkg) !== JSON.stringify(pkg)) {
    writes.push({ file: packageFile, label: 'package.json', content: serializeJson(packagePlan.nextPkg), before: JSON.stringify(pkg), changes: packagePlan.changes, changed: true });
  }
  report.writes = [
    { file: 'compat.json', changed: writes.some((write) => write.label === 'compat.json'), changes: compatPlan.changes },
    { file: 'package.json', changed: writes.some((write) => write.label === 'package.json'), changes: packagePlan.changes },
  ];
  report.warnings = [
    ...infoWarnings.map((warning) => ({ level: 'info', ...warning })),
    ...manualWarnings.map((warning) => ({ level: 'warn', ...warning })),
  ];

  // 存在需要人工确认的漂移：不写入、exit 1（避免半边更新）
  if (manualWarnings.length > 0) {
    report.ok = false;
    report.problems = manualWarnings.map((warning) => warning.message);
    report.nextSteps = buildFixSteps({ dshVersion: dshDetected.version, cpVersion: cpDetected.detected.version, problems: report.problems, manualWarnings });
    emitReport(report, options);
    return EXIT.DRIFT;
  }

  // dry-run：只预览
  if (options.dryRun) {
    report.ok = true;
    report.tests = { ran: false, skipReason: 'dry-run' };
    report.nextSteps = writes.length > 0
      ? ['确认无误后执行：node scripts/sync-compat.mjs（会写入并跑测试）']
      : ['清单已是最新：无需写入。'];
    emitReport(report, options);
    return EXIT.OK;
  }

  // 6) 事务式写入
  const backups = new Map();
  for (const write of writes) {
    try {
      backups.set(write.file, readFileSync(write.file, 'utf8'));
    } catch (error) {
      throw new CompatToolError('WRITE_BACKUP_FAILED', `写入前无法备份 ${write.file}（${error?.code || 'READ_FAILED'}）`);
    }
  }
  try {
    for (const write of writes) writeFileSync(write.file, write.content, 'utf8');
  } catch (error) {
    for (const [file, content] of backups) {
      try {
        writeFileSync(file, content, 'utf8');
      } catch {
        /* best effort */
      }
    }
    throw new CompatToolError('WRITE_FAILED', `写入兼容清单失败，已尝试回滚：${error?.message || error}`);
  }

  // 7) 测试兜底；失败则回滚
  if (options.noTest) {
    report.tests = { ran: false, skipReason: 'no-test' };
  } else {
    report.tests = runPluginTests(pluginDir, { spawnImpl });
    if (!report.tests.ok) {
      const restoreErrors = [];
      for (const [file, content] of backups) {
        try {
          writeFileSync(file, content, 'utf8');
        } catch (error) {
          restoreErrors.push(`${file}: ${error?.message || error}`);
        }
      }
      report.ok = false;
      report.rolledBack = true;
      report.problems = [`测试未通过（exit=${report.tests.exitCode ?? 'spawn-failed'}），已${restoreErrors.length === 0 ? '回滚写入' : '尝试回滚但失败'}：${restoreErrors.join('; ')}`];
      report.nextSteps = [
        '先修复测试失败，再重新执行 node scripts/sync-compat.mjs；',
        '或先用 --dry-run 查看将要写入的字段；',
        '如需强制跳过测试，用 --no-test（不推荐，CI 会拦住）。',
      ];
      emitReport(report, options);
      return EXIT.DRIFT;
    }
  }

  report.manifestAfter = evaluateManifestConsistency(compatPlan.nextCompat, packagePlan.nextPkg);
  report.ok = true;
  report.nextSteps = writes.length > 0
    ? ['写入完成，测试通过；提交前建议再跑一次 `node scripts/sync-compat.mjs --check`。']
    : ['清单已是最新（幂等），测试通过。'];
  emitReport(report, options);
  return EXIT.OK;
}

function buildFixSteps({ dshVersion, cpVersion, problems, manualWarnings }) {
  const steps = [];
  if (problems.some((problem) => /engines\.dsh|peerDependencies|files|schemaVersion/.test(problem))) {
    steps.push('清单与 package.json 不一致：执行 `node scripts/sync-compat.mjs` 自动对齐后重试。');
  }
  if (problems.some((problem) => /^DSH .*不在支持区间/.test(problem))) {
    steps.push(`DSH 越界（${dshVersion ?? '未检测到'}）：执行 \`node scripts/sync-compat.mjs --dsh-version ${dshVersion ?? '<version>'}\` 放宽同 major 上界并跑测试。`);
  }
  if (problems.some((problem) => /^CircuitPilot Runtime .*不在支持区间/.test(problem))) {
    steps.push(
      `CircuitPilot 越界（${cpVersion ?? '未检测到'}）：确认目标 Runtime 版本后执行 ` +
        `\`node scripts/sync-compat.mjs --cp-version ${cpVersion ?? '<version>'}\`` +
        '（同 major 且 minor 跨度 ≤1 会自动放宽并跑测试；跨 major 或跨度 >1 需人工评估）。',
    );
  }
  for (const warning of manualWarnings) {
    if (warning.code === 'DSH_RANGE_MANUAL') steps.push(`DSH 需人工确认区间：${warning.message}`);
    if (warning.code === 'CIRCUITPILOT_RANGE_MANUAL') steps.push(`CircuitPilot 需人工确认区间：${warning.message}`);
  }
  steps.push('先预览改动可用 `node scripts/sync-compat.mjs --dry-run`；只读门禁是 `node scripts/sync-compat.mjs --check`。');
  return steps;
}

async function main(argv = process.argv.slice(2), io = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return error.exitCode ?? EXIT.USAGE;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  try {
    return await run(options, io);
  } catch (error) {
    if (error instanceof CompatToolError) {
      process.stderr.write(`错误（${error.code}）：${error.message}\n`);
      return error.exitCode;
    }
    process.stderr.write(`内部错误：${error?.stack || error}\n`);
    return EXIT.USAGE;
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = await main();
}
