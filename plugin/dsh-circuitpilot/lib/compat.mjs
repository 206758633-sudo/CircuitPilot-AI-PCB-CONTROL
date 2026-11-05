/**
 * 共享兼容性基础层（host-independent，不 import 任何 DSH 包）。
 *
 * 目标：让插件在 DSH / CircuitPilot 升级后「不需要改代码就能继续加载」，
 * 并在版本越界时给出明确、可操作的原因，而不是静默 404 / TypeError。
 *
 * 单一数据源是 ../compat.json（由 scripts/sync-compat.mjs 自动检测本机版本后维护）：
 *  - dsh.supported         → package.json engines.dsh（DSH 插件清单门禁唯一依据）
 *  - circuitpilot.supportedRuntime → 运行期 /api/health.version 的版本门禁
 *
 * 这里只实现 semver 的一个受控子集（与 DSH 自身门禁一致：semver.satisfies(v, range,
 * { includePrerelease: true })）：
 *  - 比较器：`=`、`>`、`>=`、`<`、`<=`、裸版本（等价 `=`），空白连接为 AND；
 *  - `||` 分隔为 OR；
 *  - `*` / `x` / `X` 视为任意版本；
 *  - 不支持 `^` / `~` / hyphen range（compat.json 必须写完整显式区间，避免歧义）。
 * includePrerelease 语义按 DSH 的用法实现：预发布版本参与普通比较，不做“同 tuple 才放行”的额外限制。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ------------------------------------------------------------------ */
/* 版本数据源                                                          */
/* ------------------------------------------------------------------ */

function readCompatJson() {
  const url = new URL('../compat.json', import.meta.url);
  const raw = readFileSync(url, 'utf8');
  return JSON.parse(raw);
}

export const COMPAT = readCompatJson();

/** 插件支持的 DSH 版本区间（同时写入 package.json engines.dsh）。 */
export const DSH_SUPPORTED_RANGE = COMPAT.dsh.supported;
/** 已真实验证过的 DSH 版本（证据见 docs/agent/plugin-compat.md）。 */
export const DSH_VERIFIED_VERSIONS = Object.freeze([...(COMPAT.dsh.verified ?? [])]);
/** 插件支持的 CircuitPilot Runtime 版本区间（/api/health.version）。 */
export const CP_SUPPORTED_RUNTIME_RANGE = COMPAT.circuitpilot.supportedRuntime;
/** 已真实验证过的 CircuitPilot Runtime 版本。 */
export const CP_VERIFIED_RUNTIME_VERSIONS = Object.freeze([...(COMPAT.circuitpilot.verifiedRuntime ?? [])]);
/** CircuitPilot Runtime 必须具备的能力（缺一即判定不可用）。 */
export const CP_REQUIRED_CAPABILITIES = Object.freeze([...(COMPAT.circuitpilot.requiredCapabilities ?? [])]);

/* ------------------------------------------------------------------ */
/* semver 子集                                                         */
/* ------------------------------------------------------------------ */

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?\s*(.+)$/;

const NUMERIC = /^\d+$/;

/**
 * 解析版本字符串。
 * @param {unknown} value
 * @returns {{major:number,minor:number,patch:number,prerelease:string[],raw:string}|null}
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = SEMVER_PATTERN.exec(text);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.').filter((part) => part.length > 0) : [];
  if (prerelease.some((part) => !/^[0-9A-Za-z-]+$/.test(part))) return null;
  // 纯数字的预发布标识不能有前导零（semver 规定），否则视为非法。
  if (prerelease.some((part) => NUMERIC.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    raw: text,
  };
}

/** 是否是可解析的版本号。 */
export function isValidVersion(value) {
  return parseVersion(value) !== null;
}

function compareNumeric(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function comparePrereleaseIdentifiers(left, right) {
  const leftNumeric = NUMERIC.test(left);
  const rightNumeric = NUMERIC.test(right);
  if (leftNumeric && rightNumeric) return compareNumeric(Number(left), Number(right));
  if (leftNumeric) return -1; // 数字标识优先级低于字母标识
  if (rightNumeric) return 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * 比较两个版本（semver precedence）。
 * @param {string|object} left
 * @param {string|object} right
 * @returns {-1|0|1|null} 无法解析时返回 null
 */
export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  if (!a || !b) return null;
  const release = compareNumeric(a.major, b.major)
    || compareNumeric(a.minor, b.minor)
    || compareNumeric(a.patch, b.patch);
  if (release !== 0) return release;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1; // 正式版大于同号预发布
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const order = comparePrereleaseIdentifiers(leftPart, rightPart);
    if (order !== 0) return order;
  }
  return 0;
}

/** 单个比较器是否成立；无法解析的比较器返回 false（fail-closed）。 */
function matchesComparator(version, comparator) {
  if (comparator === '*' || comparator === 'x' || comparator === 'X') return true;
  const match = COMPARATOR_PATTERN.exec(comparator);
  if (!match) return false;
  const operator = match[1] ?? '=';
  const target = parseVersion(match[2]);
  if (!target) return false;
  const order = compareVersions(version, target);
  if (order === null) return false;
  switch (operator) {
    case '>=': return order >= 0;
    case '>': return order > 0;
    case '<=': return order <= 0;
    case '<': return order < 0;
    case '=': return order === 0;
    default: return false;
  }
}

/**
 * 判断版本是否满足区间（受控 semver 子集，见文件头）。
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  if (typeof range !== 'string' || !range.trim()) return false;
  const alternatives = range.split('||').map((part) => part.trim()).filter(Boolean);
  if (alternatives.length === 0) return false;
  return alternatives.some((alternative) => {
    const comparators = alternative.split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    return comparators.every((comparator) => matchesComparator(parsed, comparator));
  });
}

/* ------------------------------------------------------------------ */
/* 兼容性判定                                                          */
/* ------------------------------------------------------------------ */

function unsupportedReason(subject, version, range) {
  return `${subject} ${version} 不在插件支持区间 ${range} 内`;
}

/**
 * 判定 DSH 宿主版本是否在插件支持区间内。
 * @param {string|null|undefined} version 宿主 DSH 版本
 * @returns {{supported:boolean,version:string|null,range:string,verified:string[],reason:string|null,unknown:boolean}}
 */
export function evaluateDshHost(version) {
  const normalized = typeof version === 'string' ? version.trim() : '';
  const base = {
    range: DSH_SUPPORTED_RANGE,
    verified: [...DSH_VERIFIED_VERSIONS],
  };
  if (!normalized || !isValidVersion(normalized)) {
    return {
      ...base,
      supported: false,
      unknown: true,
      version: normalized || null,
      reason: normalized
        ? `无法识别 DSH 版本 "${normalized}"，无法判定兼容性`
        : '未能检测到 DSH 宿主版本（不影响已加载的插件；仅用于兼容性报告）',
    };
  }
  const supported = satisfiesRange(normalized, DSH_SUPPORTED_RANGE);
  return {
    ...base,
    supported,
    unknown: false,
    version: normalized,
    reason: supported ? null : unsupportedReason('DSH', normalized, DSH_SUPPORTED_RANGE),
  };
}

/**
 * 判定 CircuitPilot Runtime 版本是否在插件支持区间内。
 * @param {string|null|undefined} version /api/health.version
 * @returns {{supported:boolean,version:string|null,range:string,verified:string[],reason:string|null,unknown:boolean}}
 */
export function evaluateCpRuntime(version) {
  const normalized = typeof version === 'string' ? version.trim() : '';
  const base = {
    range: CP_SUPPORTED_RUNTIME_RANGE,
    verified: [...CP_VERIFIED_RUNTIME_VERSIONS],
  };
  if (!normalized || !isValidVersion(normalized)) {
    return {
      ...base,
      supported: false,
      unknown: true,
      version: normalized || null,
      reason: normalized
        ? `无法识别 CircuitPilot Runtime 版本 "${normalized}"，无法判定兼容性`
        : 'CircuitPilot Runtime 未返回版本号（/api/health.version 缺失）',
    };
  }
  const supported = satisfiesRange(normalized, CP_SUPPORTED_RUNTIME_RANGE);
  return {
    ...base,
    supported,
    unknown: false,
    version: normalized,
    reason: supported ? null : unsupportedReason('CircuitPilot Runtime', normalized, CP_SUPPORTED_RUNTIME_RANGE),
  };
}

/* ------------------------------------------------------------------ */
/* 本机版本探测（只读，best effort）                                    */
/* ------------------------------------------------------------------ */

/**
 * 读取本机 DSH 版本。优先顺序：
 *  1. 显式传入的 version；
 *  2. 环境变量 DSH_RUNTIME_VERSION；
 *  3. $DSH_HOME/dsh-runtimes/dsh-primary-runtime/runtime.json 的 desktopVersion；
 *  4. 默认 ~/.dsh 下同一 runtime.json。
 * @param {{env?:Record<string,string|undefined>, version?:string|null}} [options]
 * @returns {{version:string|null, source:string|null}}
 */
export function readLocalDshVersion(options = {}) {
  const env = options.env ?? process.env;
  const explicit = typeof options.version === 'string' ? options.version.trim() : '';
  if (explicit) return { version: explicit, source: 'argument' };
  const fromEnv = typeof env.DSH_RUNTIME_VERSION === 'string' ? env.DSH_RUNTIME_VERSION.trim() : '';
  if (fromEnv && isValidVersion(fromEnv)) return { version: fromEnv, source: 'env:DSH_RUNTIME_VERSION' };
  const candidates = [];
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : '';
  if (home) candidates.push(join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'));
  const userHome = typeof env.HOME === 'string' ? env.HOME : '';
  if (userHome) candidates.push(join(userHome, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'));
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const version = typeof parsed?.desktopVersion === 'string' ? parsed.desktopVersion.trim() : '';
      if (version && isValidVersion(version)) return { version, source: file };
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  return { version: null, source: null };
}

/** 版本的主体线（major.minor），供 sync 计算下一条支持区间使用。 */
export function versionLine(version) {
  const parsed = parseVersion(version);
  return parsed ? `${parsed.major}.${parsed.minor}` : null;
}

/** 区间内是否已覆盖某个版本（用于 sync/check 的漂移告警）。 */
export function isVersionCovered(version, range) {
  return typeof version === 'string' && isValidVersion(version) && satisfiesRange(version, range);
}
