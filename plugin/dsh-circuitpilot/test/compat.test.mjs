/**
 * test/compat.test.mjs — 兼容层 + 自动同步工具链的离线单测。
 *
 * 覆盖：
 *  1. package.json ↔ compat.json 一致性（engines.dsh / dsh-* peerDependencies / files / version）；
 *  2. semver 子集矩阵（与 DSH 自带 semver.satisfies(v, range, {includePrerelease:true}) 对齐的用例）；
 *  3. evaluateDshHost / evaluateCpRuntime 的 支持/越界/缺失/非法 四态；
 *  4. readLocalDshVersion 用临时目录伪造 runtime.json（不读真实 ~/.dsh 做写入）；
 *  5. 漂移告警：本机 DSH 版本必须被 compat.json 覆盖（DSH 升级后这里会红 → 提醒跑 sync）；
 *  6. sync-compat 纯函数（区间放宽 / 清单投影 / check 报告 / 参数解析）；
 *  7. sync-compat 子进程：真实文件只读 --check、模拟越界 exit 1、mkdtemp 副本上的写模式/幂等/事务回滚；
 *  8. probe-cp-compat 纯函数（能力归类 / 汇总 / token 读取）+ fake fetch / 本地 fake Runtime 的只读探测。
 *
 * 全部离线：不连真实 DSH 实例、不连 4178、不改 ~/.dsh、不启动/杀 Runtime。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPAT,
  CP_REQUIRED_CAPABILITIES,
  CP_SUPPORTED_RUNTIME_RANGE,
  CP_VERIFIED_RUNTIME_VERSIONS,
  DSH_SUPPORTED_RANGE,
  DSH_VERIFIED_VERSIONS,
  compareVersions,
  evaluateCpRuntime,
  evaluateDshHost,
  isVersionCovered,
  isValidVersion,
  parseVersion,
  readLocalDshVersion,
  satisfiesRange,
  versionLine,
} from '../lib/compat.mjs';

import {
  CompatToolError,
  buildCheckReport,
  detectDshVersion,
  detectInstalledCpVersion,
  evaluateManifestConsistency,
  extractSemver,
  mergeVerifiedVersions,
  parseArgs as parseSyncArgs,
  parseRangeBounds,
  parseTestSummary,
  planCompatSync,
  planPackageSync,
  planRangeWiden,
  probeRuntimeHealth,
  readJsonFile,
  readRuntimeVersionFile,
  serializeJson,
} from '../scripts/sync-compat.mjs';

import {
  AGENT_TOKEN_HEADER,
  ROUTE_PROBES,
  classifyProbe,
  defaultTokenFile,
  loadAgentToken,
  parseArgs as parseProbeArgs,
  probeRuntime,
  resolveTokenFile,
  summarizeCapabilities,
} from '../scripts/probe-cp-compat.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(TEST_DIR, '..');
const SYNC_SCRIPT = join(PLUGIN_DIR, 'scripts', 'sync-compat.mjs');
const PROBE_SCRIPT = join(PLUGIN_DIR, 'scripts', 'probe-cp-compat.mjs');
const COMPAT_FILE = join(PLUGIN_DIR, 'compat.json');
const PACKAGE_FILE = join(PLUGIN_DIR, 'package.json');

const compat = JSON.parse(readFileSync(COMPAT_FILE, 'utf8'));
const pkg = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8'));

/* ------------------------------------------------------------------ */
/* 测试辅助                                                            */
/* ------------------------------------------------------------------ */

const tmpCleanup = [];

function mkTemp(prefix = 'dsh-cp-compat-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpCleanup.push(dir);
  return dir;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 构造一个「与当前 compat.json 一致」的 package.json（不依赖 Task A 是否已落地）。 */
function consistentPkg() {
  const files = Array.isArray(pkg.files) ? [...new Set([...pkg.files, 'compat.json'])] : ['compat.json'];
  return {
    ...pkg,
    engines: { ...(pkg.engines ?? {}), dsh: compat.dsh.supported },
    peerDependencies: {
      ...(pkg.peerDependencies ?? {}),
      '@deepseek-ai/dsh-skill': compat.dsh.supported,
      '@deepseek-ai/dsh-mcp-client': compat.dsh.supported,
    },
    files,
  };
}

/** 故意把 engines.dsh / dsh-* peer 写成旧值的 package.json（验证 sync 的字段级投影）。 */
function pkgWithStaleRanges() {
  const base = consistentPkg();
  return {
    ...base,
    engines: { ...base.engines, dsh: '>=0.0.1' },
    peerDependencies: {
      ...base.peerDependencies,
      '@deepseek-ai/dsh-skill': '0.1.0-rc.1',
      '@deepseek-ai/dsh-mcp-client': '0.1.0-rc.1',
    },
  };
}

/** 创建临时插件目录（compat.json + package.json [+ anon files]）。 */
function tempPluginDir({ compatData = compat, pkgData = consistentPkg(), extraFiles = {} } = {}) {
  const dir = mkTemp();
  writeJson(join(dir, 'compat.json'), compatData);
  writeJson(join(dir, 'package.json'), pkgData);
  for (const [relative, content] of Object.entries(extraFiles)) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return dir;
}

function runNode(args, { cwd = PLUGIN_DIR, env = process.env, timeout = 60_000 } = {}) {
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_V8_COVERAGE;
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout, env: childEnv });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal,
    error: result.error ?? null,
  };
}

function runSyncJson(args, options) {
  const run = runNode([SYNC_SCRIPT, '--json', ...args], options);
  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    report = null;
  }
  return { ...run, report };
}

function childEnvFor(env = process.env) {
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_V8_COVERAGE;
  return childEnv;
}

/**
 * 异步子进程（用于「同进程 fake Runtime + CLI 子进程」的组合测试）：
 * spawnSync 会阻塞父进程 event loop，导致同进程的 fake HTTP server 无法应答。
 */
function runNodeAsync(args, { cwd = PLUGIN_DIR, env = process.env, timeout = 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { cwd, env: childEnvFor(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr, signal, timedOut, error: null });
    });
  });
}

function runProbeJson(args, options) {
  const run = runNode([PROBE_SCRIPT, '--json', ...args], options);
  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    report = null;
  }
  return { ...run, report };
}

async function runProbeJsonAsync(args, options) {
  const run = await runNodeAsync([PROBE_SCRIPT, '--json', ...args], options);
  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    report = null;
  }
  return { ...run, report };
}

/** 起一个本地 fake Runtime（只读 GET），返回 baseUrl 与调用记录。 */
async function startFakeRuntime(handler) {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ method: request.method, url: request.url, headers: request.headers });
    const payload = handler(request);
    response.writeHead(payload.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload.body));
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

function writeTokenFile(dir, token = 'cpa_0123456789abcdef0123456789abcdef01234567') {
  const file = join(dir, 'agent-token.json');
  writeFileSync(file, JSON.stringify({ version: 1, name: 'dsh-plugin', token, scopes: ['read'] }, null, 2), 'utf8');
  return file;
}

/* ================================================================== */
/* 1. package.json ↔ compat.json 一致性                                */
/* ================================================================== */

test('compat.json 结构完整（schemaVersion/plugin/两个区间/verified 数组/能力清单）', () => {
  assert.equal(compat.schemaVersion, 1);
  assert.equal(typeof compat.plugin, 'string');
  assert.equal(compat.plugin, 'dsh-circuitpilot');
  assert.equal(typeof compat.dsh.supported, 'string');
  assert.ok(Array.isArray(compat.dsh.verified));
  assert.equal(typeof compat.circuitpilot.supportedRuntime, 'string');
  assert.ok(Array.isArray(compat.circuitpilot.verifiedRuntime));
  assert.ok(Array.isArray(compat.circuitpilot.requiredCapabilities));
  for (const version of compat.dsh.verified) assert.ok(isValidVersion(version), `dsh.verified 含非法版本 ${version}`);
  for (const version of compat.circuitpilot.verifiedRuntime) assert.ok(isValidVersion(version), `verifiedRuntime 含非法版本 ${version}`);
});

test('compat.json 的 requiredCapabilities 覆盖 6 项核心能力', () => {
  const expected = ['agent-api', 'project-state', 'issue-state', 'evidence-index', 'write-gate', 'eda-workspace'];
  for (const capability of expected) {
    assert.ok(compat.circuitpilot.requiredCapabilities.includes(capability), `缺少核心能力 ${capability}`);
  }
  assert.deepEqual([...CP_REQUIRED_CAPABILITIES], compat.circuitpilot.requiredCapabilities);
});

test('lib/compat.mjs 的常量与 compat.json 一致', () => {
  assert.equal(DSH_SUPPORTED_RANGE, compat.dsh.supported);
  assert.deepEqual([...DSH_VERIFIED_VERSIONS], compat.dsh.verified);
  assert.equal(CP_SUPPORTED_RUNTIME_RANGE, compat.circuitpilot.supportedRuntime);
  assert.deepEqual([...CP_VERIFIED_RUNTIME_VERSIONS], compat.circuitpilot.verifiedRuntime);
  assert.deepEqual(COMPAT.dsh, compat.dsh);
});

test('package.json version 是合法 semver', () => {
  assert.ok(isValidVersion(pkg.version), `package.json version "${pkg.version}" 不是合法 semver`);
});

test('package.json engines.dsh === compat.json dsh.supported（DSH 清单门禁的唯一依据）', () => {
  assert.equal(
    pkg?.engines?.dsh,
    compat.dsh.supported,
    'engines.dsh 必须严格等于 compat.json 的 dsh.supported；改完执行 node scripts/sync-compat.mjs',
  );
});

test('package.json engines.node 存在（>=22，node:test glob 等能力依赖）', () => {
  assert.equal(typeof pkg?.engines?.node, 'string');
  assert.match(pkg.engines.node, />=\s*2[2-9]/);
});

test('package.json dsh-* peerDependencies 区间 === compat.json dsh.supported', () => {
  for (const name of ['@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-mcp-client']) {
    assert.equal(
      pkg?.peerDependencies?.[name],
      compat.dsh.supported,
      `peerDependencies["${name}"] 必须等于 compat.json dsh.supported`,
    );
  }
  // cordis / schemastery 由宿主管，保持独立区间（sync 不改）
  assert.equal(typeof pkg?.peerDependencies?.['@deepseek-ai/cordis'], 'string');
  assert.equal(typeof pkg?.peerDependencies?.['@deepseek-ai/schemastery'], 'string');
});

test('package.json files 包含 compat.json（运行期 lib/compat.mjs 必须能读到）', () => {
  assert.ok(Array.isArray(pkg.files), 'package.json files 必须是数组');
  assert.ok(pkg.files.includes('compat.json'), 'files 必须包含 compat.json');
  assert.ok(pkg.files.includes('lib'), 'files 必须包含 lib');
});

test('package.json dsh.bundle.patch 仍指向 cordis.patch.yml', () => {
  assert.equal(pkg?.dsh?.bundle?.patch, './cordis.patch.yml');
});

test('evaluateManifestConsistency 对真实清单判定一致', () => {
  const result = evaluateManifestConsistency(compat, pkg);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test('evaluateManifestConsistency 能捕获 engines.dsh 漂移', () => {
  const tampered = { ...pkg, engines: { ...(pkg.engines ?? {}), dsh: '>=9.9.9 <10.0.0' } };
  const result = evaluateManifestConsistency(compat, tampered);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('engines.dsh')));
});

test('evaluateManifestConsistency 能捕获 files 缺少 compat.json 与非法 version', () => {
  const tampered = { ...pkg, files: ['index.mjs', 'lib'], version: 'not-semver' };
  const result = evaluateManifestConsistency(compat, tampered);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('compat.json')));
  assert.ok(result.problems.some((problem) => problem.includes('version')));
});

/* ================================================================== */
/* 2. semver 子集矩阵（对齐 DSH 门禁语义）                             */
/* ================================================================== */

test('semver 矩阵：>=0.2.1-rc.2 <0.3.0 命中的版本', () => {
  const range = '>=0.2.1-rc.2 <0.3.0';
  // includePrerelease 语义下 0.3.0-rc.1 < 0.3.0，所以它命中；0.3.0 正式版不命中。
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.5', '0.2.1', '0.2.2', '0.2.2-rc.1', '0.2.9', '0.3.0-rc.1']) {
    assert.equal(satisfiesRange(version, range), true, `${version} 应命中 ${range}`);
    assert.equal(isVersionCovered(version, range), true);
  }
});

test('semver 矩阵：>=0.2.1-rc.2 <0.3.0 不命中的版本', () => {
  const range = '>=0.2.1-rc.2 <0.3.0';
  for (const version of ['0.2.0', '0.2.1-rc.1', '0.3.0', '1.0.0', '0.1.9']) {
    assert.equal(satisfiesRange(version, range), false, `${version} 不应命中 ${range}`);
  }
});

test('semver 预发布排序：rc.2 < rc.5 < 正式 0.2.1；数字标识按数值比较', () => {
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1-rc.5'), -1);
  assert.equal(compareVersions('0.2.1-rc.5', '0.2.1-rc.2'), 1);
  assert.equal(compareVersions('0.2.1-rc.5', '0.2.1'), -1);
  assert.equal(compareVersions('0.2.1', '0.2.1-rc.5'), 1);
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1-rc.10'), -1);
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
});

test('semver 非法版本 fail-closed（parse/satisfies/compare 都不抛）', () => {
  for (const value of ['', 'abc', '0.2', '1.2.3.4', 'x.y.z', null, undefined, 42]) {
    assert.equal(parseVersion(value), null, `${String(value)} 不应被解析`);
    assert.equal(satisfiesRange(value, '>=0.0.0'), false);
  }
  assert.equal(compareVersions('nope', '0.2.0'), null);
});

test('semver 支持 * / x / || OR / 裸版本等受控语法', () => {
  assert.equal(satisfiesRange('9.9.9', '*'), true);
  assert.equal(satisfiesRange('9.9.9', 'x'), true);
  assert.equal(satisfiesRange('1.2.3', '1.2.3'), true);
  assert.equal(satisfiesRange('1.2.4', '>=1.2.3 <1.3.0 || >=2.0.0'), true);
  assert.equal(satisfiesRange('2.1.0', '>=1.2.3 <1.3.0 || >=2.0.0'), true);
  assert.equal(satisfiesRange('1.5.0', '>=1.2.3 <1.3.0 || >=2.0.0'), false);
});

test('versionLine 返回 major.minor，供同步器计算放宽后的上界', () => {
  assert.equal(versionLine('0.2.1-rc.5'), '0.2');
  assert.equal(versionLine('0.3.1'), '0.3');
  assert.equal(versionLine('nope'), null);
});

/* ================================================================== */
/* 3. evaluateDshHost / evaluateCpRuntime 四态                          */
/* ================================================================== */

test('evaluateDshHost：支持态字段齐全且 reason 为 null', () => {
  const result = evaluateDshHost('0.2.1-rc.5');
  assert.equal(result.supported, true);
  assert.equal(result.unknown, false);
  assert.equal(result.version, '0.2.1-rc.5');
  assert.equal(result.range, DSH_SUPPORTED_RANGE);
  assert.ok(Array.isArray(result.verified));
  assert.equal(result.reason, null);
});

test('evaluateDshHost：越界态 reason 可读（含版本与区间）', () => {
  const result = evaluateDshHost('0.3.0');
  assert.equal(result.supported, false);
  assert.equal(result.unknown, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.includes('0.3.0'));
  assert.ok(result.reason.includes(DSH_SUPPORTED_RANGE));
});

test('evaluateDshHost：缺失/非法态标记 unknown 且不崩', () => {
  for (const value of [null, undefined, '', 'not-a-version']) {
    const result = evaluateDshHost(value);
    assert.equal(result.supported, false);
    assert.equal(result.unknown, true);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  }
});

test('evaluateCpRuntime：0.2.0 支持、0.8.15/0.3.0 越界、缺失 unknown', () => {
  const supported = evaluateCpRuntime('0.2.0');
  assert.equal(supported.supported, true);
  assert.equal(supported.range, CP_SUPPORTED_RUNTIME_RANGE);
  assert.equal(supported.reason, null);

  for (const version of ['0.8.15', '0.3.0', '0.2.0-rc.1']) {
    const result = evaluateCpRuntime(version);
    assert.equal(result.supported, false, `${version} 应越界`);
    assert.equal(result.unknown, false);
    assert.ok(result.reason.includes(version));
  }

  const missing = evaluateCpRuntime(null);
  assert.equal(missing.supported, false);
  assert.equal(missing.unknown, true);
  assert.ok(missing.reason.includes('未返回版本号'));
});

/* ================================================================== */
/* 4. readLocalDshVersion（临时 DSH_HOME）                              */
/* ================================================================== */

test('readLocalDshVersion：从 $DSH_HOME 的 runtime.json 读取 desktopVersion', () => {
  const home = mkTemp('dsh-home-');
  const emptyHome = mkTemp('dsh-empty-home-');
  mkdirSync(join(home, 'dsh-runtimes', 'dsh-primary-runtime'), { recursive: true });
  writeJson(join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'), { desktopVersion: '0.2.1-rc.5' });
  const found = readLocalDshVersion({ env: { DSH_HOME: home, HOME: emptyHome } });
  assert.equal(found.version, '0.2.1-rc.5');
  assert.ok(found.source.includes('runtime.json'));
});

test('readLocalDshVersion：runtime.json 损坏/缺失/非法版本都返回 null 且不抛', () => {
  const corruptHome = mkTemp('dsh-home-corrupt-');
  const emptyHome = mkTemp('dsh-empty-home-');
  mkdirSync(join(corruptHome, 'dsh-runtimes', 'dsh-primary-runtime'), { recursive: true });
  writeFileSync(join(corruptHome, 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'), '{ not json', 'utf8');
  assert.deepEqual(readLocalDshVersion({ env: { DSH_HOME: corruptHome, HOME: emptyHome } }), { version: null, source: null });
  assert.deepEqual(readLocalDshVersion({ env: { DSH_HOME: mkTemp('dsh-absent-'), HOME: emptyHome } }), { version: null, source: null });
});

test('readLocalDshVersion：显式 argument / DSH_RUNTIME_VERSION 环境变量优先且带来源', () => {
  const emptyHome = mkTemp('dsh-empty-home-');
  assert.deepEqual(readLocalDshVersion({ version: '0.2.2', env: { HOME: emptyHome } }), { version: '0.2.2', source: 'argument' });
  assert.deepEqual(readLocalDshVersion({ env: { HOME: emptyHome, DSH_RUNTIME_VERSION: '0.2.1-rc.5' } }), {
    version: '0.2.1-rc.5',
    source: 'env:DSH_RUNTIME_VERSION',
  });
});

/* ================================================================== */
/* 5. 漂移告警（DSH 升级后本测试会红 → 提醒执行 sync）                 */
/* ================================================================== */

test('漂移告警：本机检测到的 DSH 版本必须被 compat.json dsh.supported 覆盖', (t) => {
  const detected = detectDshVersion({ options: {}, env: process.env });
  if (!detected.version) {
    t.skip('本机未检测到 DSH 版本（CI 无宿主属正常）');
    return;
  }
  assert.equal(
    satisfiesRange(detected.version, compat.dsh.supported),
    true,
    `本机 DSH ${detected.version}（来源 ${detected.source}）不在 compat.json dsh.supported=${compat.dsh.supported} 内。` +
      'DSH 升级后请执行 node scripts/sync-compat.mjs（同 minor 自动放宽 + 跑测试），并人工复核运行期接口。',
  );
});

test('漂移告警：macOS 已安装的 CircuitPilot App 版本必须被 compat.json supportedRuntime 覆盖', (t) => {
  const installed = detectInstalledCpVersion({ env: process.env });
  if (!installed) {
    t.skip('本机未安装 CircuitPilot App（CI 属正常）');
    return;
  }
  assert.equal(
    satisfiesRange(installed.version, compat.circuitpilot.supportedRuntime),
    true,
    `已安装 CircuitPilot ${installed.version}（来源 ${installed.source}）不在 supportedRuntime=${compat.circuitpilot.supportedRuntime} 内。`,
  );
});

/* ================================================================== */
/* 6. sync-compat 纯函数                                              */
/* ================================================================== */

test('parseRangeBounds：解析 >= 下界与最后一个 < 上界', () => {
  assert.deepEqual(parseRangeBounds('>=0.2.1-rc.2 <0.3.0'), { lower: '0.2.1-rc.2', upper: '0.3.0' });
  assert.deepEqual(parseRangeBounds('>=1.2.3 <2.0.0 <3.0.0'), { lower: '1.2.3', upper: '3.0.0' });
  assert.deepEqual(parseRangeBounds('*'), { lower: null, upper: null });
});

test('planRangeWiden：区间已覆盖 → none', () => {
  const result = planRangeWiden({ range: '>=0.2.1-rc.2 <0.3.0', version: '0.2.2', label: 'DSH' });
  assert.equal(result.action, 'none');
  assert.equal(result.range, '>=0.2.1-rc.2 <0.3.0');
});

test('planRangeWiden：同一 major 更高 minor → 放宽上界为 <major.(minor+1).0，下界保留', () => {
  const result = planRangeWiden({ range: '>=0.2.1-rc.2 <0.3.0', version: '0.3.1', label: 'DSH' });
  assert.equal(result.action, 'widen');
  assert.equal(result.nextRange, '>=0.2.1-rc.2 <0.4.0');
  assert.ok(result.reason.includes('0.3.1'));
});

test('planRangeWiden：低于下界/跨 major/跨度>1 都不自动放宽（manual）', () => {
  const below = planRangeWiden({ range: '>=0.2.1-rc.2 <0.3.0', version: '0.2.0', label: 'DSH' });
  assert.equal(below.action, 'manual');
  assert.ok(below.reason.includes('下界'));

  const crossed = planRangeWiden({ range: '>=0.2.1-rc.2 <0.3.0', version: '1.0.0', label: 'DSH' });
  assert.equal(crossed.action, 'manual');
  assert.ok(crossed.reason.includes('跨 major'));

  // 本机 4178 的旧构建 0.8.15 就是这种：0.2.x → 0.8.x 跨 5 个 minor，不能自动放宽。
  const farJump = planRangeWiden({ range: '>=0.2.0 <0.3.0', version: '0.8.15', label: 'CircuitPilot Runtime' });
  assert.equal(farJump.action, 'manual');
  assert.ok(farJump.reason.includes('跨度'));
});

test('mergeVerifiedVersions：去重 + 过滤非法 + semver 升序', () => {
  assert.deepEqual(mergeVerifiedVersions(['0.2.2', '0.2.1-rc.5', '0.2.2', 'nope', null], '0.2.1-rc.2'), [
    '0.2.1-rc.2',
    '0.2.1-rc.5',
    '0.2.2',
  ]);
  assert.deepEqual(mergeVerifiedVersions(undefined, '0.2.0'), ['0.2.0']);
});

test('planCompatSync：追加 verified + 按需放宽，且幂等 / 不动 notes', () => {
  const first = planCompatSync(compat, { dshVersion: '0.3.1', cpVersion: '0.2.1' });
  assert.equal(first.nextCompat.dsh.supported, '>=0.2.1-rc.2 <0.4.0');
  assert.ok(first.nextCompat.dsh.verified.includes('0.3.1'));
  assert.ok(first.nextCompat.dsh.verified.includes('0.2.1-rc.5'));
  assert.equal(first.nextCompat.circuitpilot.supportedRuntime, compat.circuitpilot.supportedRuntime);
  assert.ok(first.nextCompat.circuitpilot.verifiedRuntime.includes('0.2.1'));
  assert.deepEqual(first.nextCompat.dsh.notes, compat.dsh.notes);
  assert.ok(first.changes.some((change) => change.path === 'dsh.supported'));
  assert.ok(first.changes.some((change) => change.path === 'dsh.verified'));

  const second = planCompatSync(first.nextCompat, { dshVersion: '0.3.1', cpVersion: '0.2.1' });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.nextCompat, first.nextCompat);
});

test('planCompatSync：越界需要人工确认时不改区间，并给出 warn 提示', () => {
  const result = planCompatSync(compat, { dshVersion: '0.2.0', cpVersion: '0.8.15' });
  assert.equal(result.nextCompat.dsh.supported, compat.dsh.supported);
  assert.equal(result.nextCompat.circuitpilot.supportedRuntime, compat.circuitpilot.supportedRuntime);
  const codes = result.warnings.map((warning) => warning.code);
  assert.ok(codes.includes('DSH_RANGE_MANUAL'));
  assert.ok(codes.includes('CIRCUITPILOT_RANGE_MANUAL'));
  assert.ok(result.warnings.some((warning) => warning.level === 'warn'));
});

test('planCompatSync：未检测到版本时跳过并给出提示', () => {
  const result = planCompatSync(compat, { dshVersion: null, cpVersion: null });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.nextCompat, compat);
  const codes = result.warnings.map((warning) => warning.code);
  assert.ok(codes.includes('DSH_VERSION_UNDETECTED'));
  assert.ok(codes.includes('CIRCUITPILOT_VERSION_UNDETECTED'));
});

test('planPackageSync：字段级更新 engines.dsh + dsh-* peer，不动 cordis/schemastery', () => {
  const original = {
    ...pkg,
    engines: { node: '>=22', dsh: '>=0.0.1' },
    peerDependencies: {
      ...(pkg.peerDependencies ?? {}),
      '@deepseek-ai/dsh-skill': 'old',
      '@deepseek-ai/dsh-mcp-client': 'old',
    },
  };
  const { nextPkg, changes } = planPackageSync(original, compat);
  assert.equal(nextPkg.engines.dsh, compat.dsh.supported);
  assert.equal(nextPkg.peerDependencies['@deepseek-ai/dsh-skill'], compat.dsh.supported);
  assert.equal(nextPkg.peerDependencies['@deepseek-ai/dsh-mcp-client'], compat.dsh.supported);
  assert.deepEqual(nextPkg.peerDependencies['@deepseek-ai/cordis'], original.peerDependencies['@deepseek-ai/cordis']);
  assert.deepEqual(nextPkg.peerDependencies['@deepseek-ai/schemastery'], original.peerDependencies['@deepseek-ai/schemastery']);
  assert.ok(changes.length >= 3);
  // 再算一次应当没有变化（幂等）
  const again = planPackageSync(nextPkg, compat);
  assert.deepEqual(again.changes, []);
});

test('planPackageSync：peerDependencies 缺失时给警告而不是造结构', () => {
  const { nextPkg, warnings } = planPackageSync({ name: 'x', engines: {} }, compat);
  assert.equal(nextPkg.peerDependencies, undefined);
  assert.ok(warnings.some((warning) => warning.code === 'PEER_DEPENDENCIES_MISSING'));
});

test('parseArgs（sync）：默认值 / 各开关 / 非法参数抛错', () => {
  assert.deepEqual(parseSyncArgs([]), {
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
  });
  const options = parseSyncArgs([
    '--check',
    '--json',
    '--dry-run',
    '--no-test',
    '--no-runtime-probe',
    '--no-dsh-cli',
    '--dsh-version',
    '0.2.1-rc.5',
    '--cp-version',
    '0.2.0',
    '--runtime-url',
    'http://127.0.0.1:9',
    '--plugin-dir',
    '/tmp/x',
  ]);
  assert.equal(options.mode, 'check');
  assert.equal(options.json, true);
  assert.equal(options.dryRun, true);
  assert.equal(options.noTest, true);
  assert.equal(options.noRuntimeProbe, true);
  assert.equal(options.noDshCli, true);
  assert.equal(options.dshVersion, '0.2.1-rc.5');
  assert.equal(options.cpVersion, '0.2.0');
  assert.equal(options.runtimeUrl, 'http://127.0.0.1:9');
  assert.equal(options.runtimeUrlExplicit, true);
  assert.equal(options.pluginDir, '/tmp/x');
  assert.throws(() => parseSyncArgs(['--nope']), CompatToolError);
  assert.throws(() => parseSyncArgs(['--dsh-version']), CompatToolError);
  assert.throws(() => parseSyncArgs(['--dsh-version', 'not-semver']), CompatToolError);
  assert.throws(() => parseSyncArgs(['--cp-version', '1.2']), CompatToolError);
});

test('readJsonFile：缺失/损坏给出清晰错误（不静默创建）', () => {
  const dir = mkTemp();
  assert.throws(() => readJsonFile(join(dir, 'missing.json'), '兼容清单 compat.json'), (error) => {
    assert.ok(error instanceof CompatToolError);
    assert.equal(error.code, 'COMPAT_FILE_MISSING');
    assert.ok(error.message.includes('不会静默创建'));
    return true;
  });
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{oops', 'utf8');
  assert.throws(() => readJsonFile(broken, '包清单 package.json'), (error) => error.code === 'COMPAT_FILE_INVALID');
});

test('serializeJson：2 空格缩进 + 末尾换行（保证幂等）', () => {
  const text = serializeJson({ a: 1, b: [2] });
  assert.equal(text, '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n');
  assert.ok(text.endsWith('\n'));
});

test('extractSemver：从 dsh -V / health 文本解析版本', () => {
  assert.equal(extractSemver('0.2.1-rc.5\n'), '0.2.1-rc.5');
  assert.equal(extractSemver('v0.2.1'), '0.2.1');
  assert.equal(extractSemver('DeepSeek Harness 0.2.1-rc.5 (darwin)'), '0.2.1-rc.5');
  assert.equal(extractSemver('no version here'), null);
  assert.equal(extractSemver(undefined), null);
});

test('readRuntimeVersionFile：解析 RUNTIME_VERSION 文本，缺失/无版本返回 null', () => {
  const dir = mkTemp();
  const file = join(dir, 'version.mjs');
  writeFileSync(file, "export const RUNTIME_VERSION = '0.2.0';\n", 'utf8');
  assert.equal(readRuntimeVersionFile(file), '0.2.0');
  writeFileSync(file, 'export const OTHER = 1;\n', 'utf8');
  assert.equal(readRuntimeVersionFile(file), null);
  assert.equal(readRuntimeVersionFile(join(dir, 'absent.mjs')), null);
});

test('probeRuntimeHealth：注入 fetchImpl，成功/失败都不抛', async () => {
  const ok = await probeRuntimeHealth('http://example.invalid', {
    timeoutMs: 50,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: '0.2.0', service: 'circuitpilot-runtime' }) }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.version, '0.2.0');
  assert.equal(ok.service, 'circuitpilot-runtime');

  const failure = await probeRuntimeHealth('http://example.invalid', {
    timeoutMs: 50,
    fetchImpl: async () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    },
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.version, null);
  assert.equal(failure.error, 'ECONNREFUSED');

  const garbage = await probeRuntimeHealth('http://example.invalid', {
    timeoutMs: 50,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: 'not-a-version' }) }),
  });
  assert.equal(garbage.version, null);
});

test('parseTestSummary：兼容 TAP / spec reporter 两种输出', () => {
  const tap = parseTestSummary('# tests 86\n# pass 86\n# fail 0\n# skipped 2\n');
  assert.deepEqual(tap.counts, { tests: 86, pass: 86, fail: 0, skipped: 2 });
  assert.ok(tap.text.includes('tests=86'));
  const spec = parseTestSummary('ℹ tests 3\nℹ pass 2\nℹ fail 1\n');
  assert.deepEqual(spec.counts, { tests: 3, pass: 2, fail: 1 });
  assert.equal(parseTestSummary('').text, null);
});

test('buildCheckReport：覆盖时不报问题，观测到的旧 Runtime 只进 warning', () => {
  const report = buildCheckReport({
    compat,
    pkg: consistentPkg(),
    dshDetected: { version: '0.2.1-rc.5', source: 'test' },
    cpDetected: {
      version: '0.2.0',
      source: 'test',
      authoritative: true,
      observedRuntime: { url: 'http://127.0.0.1:4178', version: '0.8.15', ok: true, status: 200, error: null },
    },
    pluginDir: PLUGIN_DIR,
  });
  assert.equal(report.ok, true, `不应有问题：${report.problems.join('; ')}`);
  assert.deepEqual(report.problems, []);
  assert.ok(report.warnings.some((warning) => warning.code === 'RUNTIME_OBSERVED_INCOMPATIBLE'));
});

test('buildCheckReport：模拟 DSH 0.3.0 越界 → ok=false 且 problems 可读', () => {
  const report = buildCheckReport({
    compat,
    pkg: consistentPkg(),
    dshDetected: { version: '0.3.0', source: '--dsh-version' },
    cpDetected: { version: '0.2.0', source: 'test', authoritative: true, observedRuntime: null },
    pluginDir: PLUGIN_DIR,
  });
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((problem) => problem.includes('0.3.0')));
});

/* ================================================================== */
/* 7. sync-compat 子进程（真实文件只读 check）                         */
/* ================================================================== */

test('sync --check（真实文件，本机 DSH 0.2.1-rc.5 + CP 0.2.0）exit 0', () => {
  const run = runSyncJson(['--check', '--dsh-version', '0.2.1-rc.5', '--cp-version', '0.2.0', '--no-runtime-probe']);
  assert.equal(run.status, 0, `exit=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.ok(run.report, 'stdout 应是合法 JSON');
  assert.equal(run.report.ok, true);
  assert.equal(run.report.mode, 'check');
  assert.equal(run.report.dsh.supported, true);
  assert.equal(run.report.circuitpilot.supported, true);
});

test('sync --check：模拟 DSH 0.3.0 越界 → exit 1 且提示可操作', () => {
  const run = runSyncJson(['--check', '--dsh-version', '0.3.0', '--no-runtime-probe']);
  assert.equal(run.status, 1);
  assert.ok(run.report);
  assert.equal(run.report.ok, false);
  assert.ok(run.report.problems.some((problem) => problem.includes('0.3.0')));
  assert.ok(run.report.nextSteps.some((step) => step.includes('sync-compat')));
});

test('sync --check：模拟 CircuitPilot 0.8.15 越界 → exit 1 且提示可操作', () => {
  const run = runSyncJson(['--check', '--cp-version', '0.8.15', '--no-runtime-probe']);
  assert.equal(run.status, 1);
  assert.ok(run.report);
  assert.equal(run.report.ok, false);
  assert.ok(run.report.problems.some((problem) => problem.includes('0.8.15')));
  assert.ok(run.report.nextSteps.some((step) => step.includes('CircuitPilot')));
});

test('sync --check：检测不到版本视为 skip 而非失败（CI 友好）', () => {
  // DSH_HOME/HOME 指向空目录 → 检测不到 DSH；--no-runtime-probe + --cp-version 让 CP 仍可判定；
  // 但真实 package.json 可能是 Task A 落地前的旧版 —— 用一致的临时副本，保证只验证 skip 语义。
  const dir = tempPluginDir();
  const run = runSyncJson(['--check', '--no-runtime-probe', '--no-dsh-cli', '--cp-version', '0.2.0', '--plugin-dir', dir], {
    env: { ...process.env, DSH_HOME: mkTemp('dsh-no-home-'), HOME: mkTemp('dsh-no-home-') },
  });
  assert.equal(run.status, 0, `exit=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.ok(run.report);
  assert.deepEqual(run.report.skipped, ['DSH']);
  assert.equal(run.report.manifest.ok, true);
});

test('sync --check（临时一致副本）exit 0；--json 是纯 JSON（无人类日志混入）', () => {
  const dir = tempPluginDir();
  const run = runSyncJson(['--check', '--dsh-version', '0.2.1-rc.5', '--cp-version', '0.2.0', '--no-runtime-probe', '--plugin-dir', dir], {
    env: { ...process.env, DSH_HOME: mkTemp('dsh-no-home-'), HOME: mkTemp('dsh-no-home-') },
  });
  assert.equal(run.status, 0, `exit=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.ok(run.report);
  assert.equal(run.report.ok, true);
  assert.equal(run.stdout.trim().startsWith('{'), true, '--json 的 stdout 必须是纯 JSON');
});

test('sync 未知参数 → exit 2（用法错误）', () => {
  const run = runNode([SYNC_SCRIPT, '--bogus-flag']);
  assert.equal(run.status, 2);
  assert.ok(run.stderr.includes('未知参数'));
});

test('sync 兼容清单缺失 → exit 2 且给出清晰错误（不静默创建）', () => {
  const dir = mkTemp();
  const run = runSyncJson(['--check', '--plugin-dir', dir]);
  assert.equal(run.status, 2);
  assert.ok(run.stderr.includes('compat.json'));
  assert.equal(existsSync(join(dir, 'compat.json')), false, '脚本不得静默创建 compat.json');
});

test('sync --check 只读：真实文件内容不变', () => {
  const beforeCompat = readFileSync(COMPAT_FILE, 'utf8');
  const beforePkg = readFileSync(PACKAGE_FILE, 'utf8');
  const run = runNode([SYNC_SCRIPT, '--check', '--no-runtime-probe', '--json']);
  assert.ok([0, 1].includes(run.status));
  assert.equal(readFileSync(COMPAT_FILE, 'utf8'), beforeCompat);
  assert.equal(readFileSync(PACKAGE_FILE, 'utf8'), beforePkg);
});

/* ================================================================== */
/* 8. sync-compat 写模式（mkdtemp 副本，绝不动真实清单）               */
/* ================================================================== */

test('sync 写模式：追加 verified + 对齐 package.json，且第二次运行幂等', () => {
  const dir = tempPluginDir({ pkgData: pkgWithStaleRanges() });
  const beforePkgRaw = readFileSync(join(dir, 'package.json'), 'utf8');
  const first = runSyncJson(['--plugin-dir', dir, '--dsh-version', '0.2.2', '--cp-version', '0.2.1', '--no-test', '--no-runtime-probe'], {
    env: { ...process.env, DSH_HOME: mkTemp('dsh-no-home-'), HOME: mkTemp('dsh-no-home-') },
  });
  assert.equal(first.status, 0, `exit=${first.status}\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  assert.ok(first.report);
  assert.equal(first.report.ok, true);

  const nextCompat = JSON.parse(readFileSync(join(dir, 'compat.json'), 'utf8'));
  const nextPkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.ok(nextCompat.dsh.verified.includes('0.2.2'));
  assert.ok(nextCompat.circuitpilot.verifiedRuntime.includes('0.2.1'));
  assert.equal(nextPkg.engines.dsh, nextCompat.dsh.supported);
  assert.equal(nextPkg.peerDependencies['@deepseek-ai/dsh-skill'], nextCompat.dsh.supported);
  assert.equal(nextPkg.peerDependencies['@deepseek-ai/dsh-mcp-client'], nextCompat.dsh.supported);
  // 非 sync 负责字段保持原样
  assert.equal(nextPkg.peerDependencies['@deepseek-ai/cordis'], pkg.peerDependencies['@deepseek-ai/cordis']);
  assert.equal(nextPkg.peerDependencies['@deepseek-ai/schemastery'], pkg.peerDependencies['@deepseek-ai/schemastery']);
  assert.notEqual(beforePkgRaw, readFileSync(join(dir, 'package.json'), 'utf8'));

  const afterFirst = readFileSync(join(dir, 'compat.json'), 'utf8') + readFileSync(join(dir, 'package.json'), 'utf8');
  const second = runSyncJson(['--plugin-dir', dir, '--dsh-version', '0.2.2', '--cp-version', '0.2.1', '--no-test', '--no-runtime-probe'], {
    env: { ...process.env, DSH_HOME: mkTemp('dsh-no-home-'), HOME: mkTemp('dsh-no-home-') },
  });
  assert.equal(second.status, 0);
  const afterSecond = readFileSync(join(dir, 'compat.json'), 'utf8') + readFileSync(join(dir, 'package.json'), 'utf8');
  assert.equal(afterSecond, afterFirst, '第二次运行必须幂等（文件字节级不变）');
  assert.ok(second.report.writes.every((write) => write.changed === false));
});

test('sync --dry-run：只预览不落盘', () => {
  const dir = tempPluginDir();
  const before = readFileSync(join(dir, 'compat.json'), 'utf8') + readFileSync(join(dir, 'package.json'), 'utf8');
  const run = runSyncJson(['--plugin-dir', dir, '--dsh-version', '0.2.2', '--no-test', '--no-runtime-probe', '--dry-run'], {
    env: { ...process.env, DSH_HOME: mkTemp('dsh-no-home-'), HOME: mkTemp('dsh-no-home-') },
  });
  assert.equal(run.status, 0);
  assert.ok(run.report);
  assert.equal(run.report.mode, 'dry-run');
  assert.ok(run.report.writes.some((write) => write.changed === true), 'dry-run 应报告将写入的变化');
  assert.equal(readFileSync(join(dir, 'compat.json'), 'utf8') + readFileSync(join(dir, 'package.json'), 'utf8'), before, 'dry-run 不得落盘');
});

test('sync 事务式写入：测试失败时回滚全部改动并 exit 1', () => {
  const dir = tempPluginDir({
    pkgData: pkgWithStaleRanges(),
    extraFiles: {
      'test/failing.test.mjs': [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('intentional failure for rollback test', () => { assert.fail('sync-compat 事务回滚测试'); });",
        '',
      ].join('\n'),
    },
  });
  const beforeCompat = readFileSync(join(dir, 'compat.json'), 'utf8');
  const beforePkg = readFileSync(join(dir, 'package.json'), 'utf8');
  const run = runSyncJson(['--plugin-dir', dir, '--dsh-version', '0.2.2', '--cp-version', '0.2.1', '--no-runtime-probe'], {
    env: { ...process.env, DSH_HOME: mkTemp('dsh-no-home-'), HOME: mkTemp('dsh-no-home-') },
    timeout: 180_000,
  });
  assert.equal(run.status, 1, `exit=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.ok(run.report);
  assert.equal(run.report.rolledBack, true);
  assert.equal(run.report.tests.ran, true);
  assert.equal(run.report.tests.ok, false);
  assert.equal(readFileSync(join(dir, 'compat.json'), 'utf8'), beforeCompat, '测试失败后 compat.json 必须回滚');
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), beforePkg, '测试失败后 package.json 必须回滚');
});

test('sync 越界需要人工确认时不写入、exit 1（避免半边更新）', () => {
  const dir = tempPluginDir();
  const beforeCompat = readFileSync(join(dir, 'compat.json'), 'utf8');
  const run = runSyncJson(['--plugin-dir', dir, '--dsh-version', '1.0.0', '--no-test', '--no-runtime-probe'], {
    env: { ...process.env, DSH_HOME: mkTemp('dsh-no-home-'), HOME: mkTemp('dsh-no-home-') },
  });
  assert.equal(run.status, 1);
  assert.equal(readFileSync(join(dir, 'compat.json'), 'utf8'), beforeCompat);
  assert.ok(run.report.problems.length > 0);
});

/* ================================================================== */
/* 9. probe-cp-compat 纯函数 + 本地 fake Runtime 只读探测              */
/* ================================================================== */

test('classifyProbe：404/ROUTE_NOT_FOUND=缺失，409/其它业务错误=存在，401=需 token，网络=unknown', () => {
  assert.equal(classifyProbe({ status: 404, body: { ok: false, error: { code: 'ROUTE_NOT_FOUND' } } }).state, 'missing');
  assert.equal(classifyProbe({ status: 404, body: null }).state, 'missing');
  assert.equal(classifyProbe({ status: 200, body: { ok: true } }).state, 'present');
  assert.equal(classifyProbe({ status: 409, body: { ok: false, error: { code: 'EDA_WINDOW_NOT_FOUND' } } }).state, 'present');
  assert.equal(classifyProbe({ status: 500, body: { ok: false, error: { code: 'INTERNAL' } } }).state, 'present');
  assert.equal(classifyProbe({ status: 401, body: { ok: false, error: { code: 'RUNTIME_TOKEN_INVALID' } } }).state, 'unauthorized');
  assert.equal(classifyProbe({ status: 403, body: { ok: false, error: { code: 'AGENT_ROUTE_FORBIDDEN' } } }).state, 'present');
  assert.equal(classifyProbe({ status: null, networkError: 'ECONNREFUSED' }).state, 'unknown');
  assert.equal(classifyProbe({ status: 418, body: null }).state, 'unknown');
});

test('summarizeCapabilities：全存在→ok；缺核心→ok=false；无 token→capabilitiesVerified=false', () => {
  const present = ROUTE_PROBES.map((probe) => ({ id: probe.id, core: true, state: 'present' }));
  const good = summarizeCapabilities({
    capabilities: present,
    versionCompat: { supported: true },
    tokenAvailable: true,
    health: { reachable: true, status: 200 },
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.coreMissing, []);
  assert.equal(good.capabilitiesVerified, true);

  const missing = present.map((item) => (item.id === 'project-state' ? { ...item, state: 'missing' } : item));
  const bad = summarizeCapabilities({
    capabilities: missing,
    versionCompat: { supported: true },
    tokenAvailable: true,
    health: { reachable: true, status: 200 },
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.coreMissing, ['project-state']);

  const tokenless = summarizeCapabilities({
    capabilities: present.map((item) => ({ ...item, state: 'unauthorized' })),
    versionCompat: { supported: true },
    tokenAvailable: false,
    health: { reachable: true, status: 200 },
  });
  assert.equal(tokenless.capabilitiesVerified, false);
});

test('probe 的 loadAgentToken：合法 token 可用；缺失/损坏/非法不抛且不泄漏', () => {
  const dir = mkTemp();
  const tokenFile = writeTokenFile(dir);
  const loaded = loadAgentToken({ file: tokenFile });
  assert.equal(loaded.available, true);
  assert.equal(loaded.token.length > 8, true);

  assert.equal(loadAgentToken({ file: join(dir, 'absent.json') }).available, false);
  assert.ok(loadAgentToken({ file: join(dir, 'absent.json') }).reason.includes('不存在'));

  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{nope', 'utf8');
  assert.equal(loadAgentToken({ file: broken }).available, false);

  const short = join(dir, 'short.json');
  writeFileSync(short, JSON.stringify({ token: 'x' }), 'utf8');
  assert.equal(loadAgentToken({ file: short }).available, false);
});

test('probe 的 token 路径：显式 > 环境变量 > 平台默认', () => {
  assert.deepEqual(resolveTokenFile({ tokenFile: '/tmp/a/token.json', env: {} }), { file: '/tmp/a/token.json', explicit: true });
  assert.deepEqual(resolveTokenFile({ env: { CIRCUITPILOT_AGENT_TOKEN_FILE: '/tmp/b/token.json' } }), {
    file: '/tmp/b/token.json',
    explicit: true,
  });
  const fallback = resolveTokenFile({ env: {} });
  assert.equal(fallback.explicit, false);
  assert.ok(fallback.file.endsWith('agent-token.json'));

  assert.ok(defaultTokenFile({ platform: 'darwin', home: '/home/u', env: {} }).includes('Library/Application Support/CircuitPilot'));
  assert.ok(defaultTokenFile({ platform: 'win32', home: 'C:/Users/u', env: { APPDATA: 'C:/Users/u/AppData/Roaming' } }).includes('CircuitPilot'));
  assert.ok(defaultTokenFile({ platform: 'linux', home: '/home/u', env: { XDG_STATE_HOME: '/state' } }).includes('circuitpilot'));
});

test('probe 的 parseArgs：默认值 / 显式参数 / 非法参数抛错', () => {
  assert.deepEqual(parseProbeArgs([]), { baseUrl: null, tokenFile: null, json: false, timeoutMs: 4000, help: false });
  const options = parseProbeArgs(['--base-url', 'http://127.0.0.1:9', '--token-file', '/tmp/t.json', '--timeout-ms', '1234', '--json']);
  assert.equal(options.baseUrl, 'http://127.0.0.1:9');
  assert.equal(options.tokenFile, '/tmp/t.json');
  assert.equal(options.timeoutMs, 1234);
  assert.equal(options.json, true);
  assert.throws(() => parseProbeArgs(['--bogus']));
  assert.throws(() => parseProbeArgs(['--timeout-ms', '0']));
  assert.throws(() => parseProbeArgs(['--timeout-ms', 'abc']));
});

test('probeRuntime：注入 fetchImpl 时只发 GET，且报告不含 token 原文', async () => {
  const dir = mkTemp();
  const tokenFile = writeTokenFile(dir, 'cpa_secret_should_never_leak_0123456789');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    const path = new URL(url).pathname;
    if (path === '/api/health') {
      return { ok: true, status: 200, json: async () => ({ ok: true, service: 'circuitpilot-runtime', version: '0.2.0' }) };
    }
    if (path === '/api/eda/workspaces/current') {
      return { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'EDA_WINDOW_NOT_FOUND', message: '没有 EDA 窗口' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const report = await probeRuntime({ baseUrl: 'http://127.0.0.1:9', tokenFile, timeoutMs: 100, fetchImpl, env: {} });
  assert.equal(report.health.version, '0.2.0');
  assert.equal(report.versionCompat.supported, true);
  assert.equal(report.token.available, true);
  assert.equal(report.summary.ok, true);
  assert.equal(report.summary.coreMissing.length, 0);
  for (const probe of report.capabilities) assert.equal(probe.state, 'present', `${probe.id} 应存在`);
  assert.ok(calls.length >= ROUTE_PROBES.length + 1);
  assert.ok(calls.every((call) => call.method === 'GET'), 'probe 只能发 GET');
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('cpa_secret_should_never_leak_0123456789'), false, '报告不得包含 token 原文');
});

test('probeRuntime：版本越界 + 全 404 → 结论不兼容', async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/health') {
      return { ok: true, status: 200, json: async () => ({ ok: true, version: '0.8.15' }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'ROUTE_NOT_FOUND', message: 'Runtime端点不存在' } }) };
  };
  const report = await probeRuntime({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 100, fetchImpl, env: {} });
  assert.equal(report.versionCompat.supported, false);
  assert.equal(report.summary.compatible, false);
  assert.equal(report.summary.ok, false);
  assert.equal(report.summary.missing.length, ROUTE_PROBES.length);
});

test('probe CLI：对本地 fake Runtime 输出 JSON，exit 0（全兼容）', async () => {
  const runtime = await startFakeRuntime((request) => {
    const path = request.url;
    if (path === '/api/health') {
      return { status: 200, body: { ok: true, service: 'circuitpilot-runtime', version: '0.2.0' } };
    }
    if (path === '/api/eda/workspaces/current') {
      return { status: 409, body: { ok: false, error: { code: 'EDA_WINDOW_NOT_FOUND', message: '没有 EDA 窗口' } } };
    }
    return { status: 200, body: { ok: true } };
  });
  try {
    const dir = mkTemp();
    const tokenFile = writeTokenFile(dir);
    const run = await runProbeJsonAsync(['--base-url', runtime.baseUrl, '--token-file', tokenFile, '--timeout-ms', '3000']);
    assert.equal(run.status, 0, `exit=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.ok(run.report);
    assert.equal(run.report.health.version, '0.2.0');
    assert.equal(run.report.summary.ok, true);
    assert.equal(run.report.summary.coreMissing.length, 0);
    assert.ok(runtime.calls.every((call) => call.method === 'GET'), 'CLI 只能发 GET');
    assert.equal(run.report.token.available, true);
  } finally {
    await runtime.close();
  }
});

test('probe CLI：本地 fake Runtime 返回旧构建（0.8.15 + 全 404）→ exit 1', async () => {
  const runtime = await startFakeRuntime((request) => {
    if (request.url === '/api/health') {
      return { status: 200, body: { ok: true, service: 'circuitpilot-runtime', version: '0.8.15' } };
    }
    return { status: 404, body: { ok: false, error: { code: 'ROUTE_NOT_FOUND', message: 'Runtime端点不存在' } } };
  });
  try {
    const run = await runProbeJsonAsync(['--base-url', runtime.baseUrl, '--token-file', '/nonexistent/token.json', '--timeout-ms', '3000']);
    assert.equal(run.status, 1, `exit=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.ok(run.report);
    assert.equal(run.report.versionCompat.supported, false);
    assert.equal(run.report.summary.missing.length, ROUTE_PROBES.length);
    assert.ok(run.report.nextActions.some((action) => action.includes('0.2')) || run.report.nextActions.length > 0);
  } finally {
    await runtime.close();
  }
});

test('probe CLI：Runtime 不可达 → exit 1 且提示启动（不启动/不杀进程）', () => {
  const run = runProbeJson(['--base-url', 'http://127.0.0.1:1', '--timeout-ms', '500']);
  assert.equal(run.status, 1);
  assert.ok(run.report);
  assert.equal(run.report.health.reachable, false);
  assert.ok(run.report.nextActions.some((action) => action.includes('启动 CircuitPilot')));
});

/* ================================================================== */
/* 10. lib/compat.mjs 导出契约（其他 teammate 依赖这些名字）           */
/* ================================================================== */

test('lib/compat.mjs 导出契约稳定（引用方：index/host/cp-compat/tools）', async () => {
  const expected = {
    COMPAT: 'object',
    DSH_SUPPORTED_RANGE: 'string',
    DSH_VERIFIED_VERSIONS: 'object',
    CP_SUPPORTED_RUNTIME_RANGE: 'string',
    CP_VERIFIED_RUNTIME_VERSIONS: 'object',
    CP_REQUIRED_CAPABILITIES: 'object',
    parseVersion: 'function',
    compareVersions: 'function',
    satisfiesRange: 'function',
    evaluateDshHost: 'function',
    evaluateCpRuntime: 'function',
    readLocalDshVersion: 'function',
    versionLine: 'function',
    isVersionCovered: 'function',
  };
  const module = await import('../lib/compat.mjs');
  for (const [name, type] of Object.entries(expected)) {
    assert.equal(typeof module[name], type, `lib/compat.mjs 必须导出 ${name}（${type}）`);
  }
});

test('lib/compat.mjs 在 import 时从 ../compat.json 读取（唯一数据源）', async () => {
  const source = readFileSync(join(PLUGIN_DIR, 'lib', 'compat.mjs'), 'utf8');
  assert.ok(source.includes("new URL('../compat.json', import.meta.url)"), '必须保持从 ../compat.json 读取');
  const module = await import('../lib/compat.mjs');
  assert.equal(module.DSH_SUPPORTED_RANGE, compat.dsh.supported);
  assert.equal(module.CP_SUPPORTED_RUNTIME_RANGE, compat.circuitpilot.supportedRuntime);
});

/* ================================================================== */
/* 11. scripts 目录完整性                                              */
/* ================================================================== */

test('scripts 提供 sync/check/probe 入口（package.json scripts 指向它们）', () => {
  assert.ok(existsSync(SYNC_SCRIPT), '缺少 scripts/sync-compat.mjs');
  assert.ok(existsSync(PROBE_SCRIPT), '缺少 scripts/probe-cp-compat.mjs');
  assert.equal(pkg?.scripts?.['compat:sync'], 'node scripts/sync-compat.mjs');
  assert.equal(pkg?.scripts?.['compat:check'], 'node scripts/sync-compat.mjs --check');
  assert.equal(pkg?.scripts?.['cp:probe'], 'node scripts/probe-cp-compat.mjs');
});

/* 清理：显式删掉本文件创建的临时目录，避免 /tmp 堆积。 */
process.on('exit', () => {
  for (const dir of tmpCleanup) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});
