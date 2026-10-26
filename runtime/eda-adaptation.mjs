/**
 * G5：嘉立创 EDA 版本适配。
 *
 * 目标不是"猜版本号"，而是**换版本时先报能力差异**：
 *   - 版本来源必须显式（调用方传入的实测版本 / 能力矩阵里的基线版本 / 未知）并如实标注来源，
 *     `versionSource:'unknown'` 时不允许给出"已适配"结论；
 *   - 版本与真机验收基线比对：一致 → tested；同 minor 不同 patch → patch-drift（未验证补丁位）；
 *     其它 → untested；解析不了 → unknown；
 *   - `eda.api.describe` 探针结果按关键图元 API 核对：缺 create/方法 → degraded 并指出缺哪一项；
 *   - 适配表把已知坑写死（CDP 截图超时、importChanges 静默无效、EDA 侧文件系统不可用），
 *     每项给**明确降级路径**，避免运行到一半才神秘失败。
 *
 * 边界：这是契约与诊断层，不会自动切换实现；降级动作仍由各配方/命令执行器按已有 fallback 走。
 */

export const TESTED_VERSIONS = Object.freeze(['3.2.186']);
export const BASELINE_VERSIONS = Object.freeze(['3.2.175']);
export const EDA_ADAPTATION_SCHEMA_VERSION = 1;

export const KNOWN_ISSUES = Object.freeze([
  {
    id: 'cdp-screenshot-timeout',
    title: 'CDP 截图在 EDA 3.2.186 超时',
    affects: '3.2.x',
    fallback: 'gui screenshot 降级为 macOS 窗口区域截图（仅 EDA 窗口），返回 fallback 证据来源',
    evidence: '第 31 轮真机：CDP 截图 20s 超时；窗口截图可用',
  },
  {
    id: 'import-changes-silent-noop',
    title: 'pcb.importChanges 返回 success 但不落板',
    affects: '<=3.2.186',
    fallback: '禁用该路径；PCB 器件落板改走已注册的 pcb.component.create 写命令（需批准）',
    evidence: '第 16 轮四组对照实验',
  },
  {
    id: 'eda-filesystem-unavailable',
    title: 'EDA 渲染进程 sys_FileSystem 不可用',
    affects: '<=3.2.186',
    fallback: '导出/3D 分片取回后由运行时进程写盘并校验 sha256，不在 EDA 侧落盘',
    evidence: '第 27 轮真机：getDocumentsPath() 空串、saveFileToFileSystem false',
  },
]);

/** 关键图元 API：缺任何一个都意味着对应自动化路径不可用。 */
export const REQUIRED_API = Object.freeze([
  { name: 'pcb_PrimitiveComponent', method: 'create', usedBy: 'PCB 器件落板（pcb.component.create）' },
  { name: 'pcb_PrimitiveVia', method: 'create', usedBy: '过孔创建（pcb.via.create）' },
  { name: 'pcb_PrimitiveLine', method: 'create', usedBy: '走线/铜皮线创建（pcb.line.create）' },
  { name: 'sch_PrimitiveComponent', method: 'create', usedBy: '原理图器件创建（schematic.component.create）' },
]);

export function parseVersion(value) {
  const match = String(value ?? '').trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0), build: match[4] ? Number(match[4]) : null, raw: String(value).trim() };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

/**
 * @param {object} options
 * @param {string|null} options.version 实测/声明的 EDA 版本
 * @param {'probe'|'capability-matrix'|'user'|'unknown'} [options.versionSource]
 * @param {object|null} options.probe `eda.api.describe` 返回（{ [name]: {methods,createArity}|null }）
 * @param {Array<{id:string,status:string,reason?:string}>} [options.capabilityItems] pcb.capabilities().items
 * @param {string|null} [options.probeError] 探针失败原因（失败也必须如实报告，不能当作通过）
 */
export function assessEdaAdaptation({ version = null, versionSource = 'unknown', probe = null, probeError = null, capabilityItems = [] } = {}) {
  const parsed = parseVersion(version);
  const testedList = TESTED_VERSIONS.map((item) => ({ version: item, parsed: parseVersion(item) }));
  const warnings = [];
  const degradations = [];
  let status;
  let supported = false;

  if (!parsed) {
    status = 'unknown';
    warnings.push('无法确定 EDA 版本：不能声称已适配；请提供实测版本或先运行能力探测');
  } else {
    let best = null;
    for (const candidate of testedList) {
      const cmp = compareVersions(parsed.raw, candidate.version);
      if (cmp === 0) { best = { match: 'exact', version: candidate.version }; break; }
      const sameMinor = parsed.major === candidate.parsed.major && parsed.minor === candidate.parsed.minor;
      if (sameMinor) best = { match: 'patch-drift', version: candidate.version };
    }
    if (best?.match === 'exact') { status = 'tested'; supported = true; }
    else if (best?.match === 'patch-drift') {
      status = 'patch-drift';
      warnings.push(`补丁版本 ${parsed.raw} 未在真机验收基线（${TESTED_VERSIONS.join('、')}）内：命令面可能变化，先按 untested 处理，关键链路需人工复核`);
    } else {
      status = 'untested';
      warnings.push(`版本 ${parsed.raw} 未经真机验收（基线 ${TESTED_VERSIONS.join('、')}）：不代表不能用，但缺证据就不能声称已适配`);
    }
    if (BASELINE_VERSIONS.includes(parsed.raw) && status !== 'tested') {
      warnings.push(`能力矩阵登记的基线版本 ${parsed.raw} 不是真机验收版本；以能力探测/实机结果为准`);
    }
  }

  const missingApi = [];
  if (probe && typeof probe === 'object') {
    for (const required of REQUIRED_API) {
      const api = probe[required.name];
      const methods = Array.isArray(api?.methods) ? api.methods : null;
      if (!api) { missingApi.push({ ...required, problem: '探针未发现该图元 API' }); continue; }
      if (!methods || !methods.includes(required.method)) missingApi.push({ ...required, problem: `缺少 ${required.method} 方法（现有：${(methods || []).slice(0, 8).join(',') || '无'}）` });
    }
    for (const item of missingApi) degradations.push(`${item.usedBy} 不可用：${item.problem}；该路径必须降级为人工操作或只读诊断`);
  } else if (probeError) {
    warnings.push(`能力探测失败：${probeError}（失败不等于不支持，但也不能据此声称能力齐全）`);
  } else {
    warnings.push('未提供 eda.api.describe 探针结果：图元 API 能力未知');
  }

  const unavailableItems = (Array.isArray(capabilityItems) ? capabilityItems : []).filter((item) => item?.status === 'unavailable');
  for (const item of unavailableItems) degradations.push(`${item.id} 不可用：${item.reason || '能力矩阵标记 unavailable'}`);

  const versionMatches = (affects) => {
    if (!parsed) return false;
    if (affects === '<=3.2.186') return compareVersions(parsed.raw, '3.2.186') !== null && compareVersions(parsed.raw, '3.2.186') <= 0;
    if (affects === '3.2.x') return parsed.major === 3 && parsed.minor === 2;
    return true;
  };

  return {
    schemaVersion: EDA_ADAPTATION_SCHEMA_VERSION,
    version: parsed?.raw ?? null,
    versionSource,
    status,
    level: status === 'tested' && !degradations.length && warnings.length === 0 ? 'ok' : 'warn',
    supported,
    testedVersions: [...TESTED_VERSIONS],
    baselineVersions: [...BASELINE_VERSIONS],
    testedVersionsNote: '3.2.186 = 真机验收基线；3.2.175 = 能力矩阵登记的声明基线（不等于真机验证）',
    warnings,
    degradations,
    missingApi,
    unavailableCapabilities: unavailableItems.map((item) => ({ id: item.id, reason: item.reason ?? null })),
    knownIssues: KNOWN_ISSUES.filter((issue) => versionMatches(issue.affects)).map((issue) => ({ ...issue })),
    guidance: status === 'tested'
      ? '版本在真机验收基线内：可继续使用现有配方；运行中仍以每步读回证据为准。'
      : status === 'unknown'
        ? '先在 EDA 页运行环境检查/能力探测取得实测版本；未知版本不要走写链路。'
        : '按未验证版本对待：先跑只读命令与 eda.api.describe，把失败暴露成明确错误，再决定是否走写链路；不要直接跑长任务。',
  };
}
