/**
 * 求解器层统一入口：纯 JS 确定性实现 + 外部求解器"存在性探测"。
 *
 * 设计原则（与仓库一致）：
 *   - 本机离线、runtime 零依赖，**没有** ortools / z3 / shapely，也禁止 npm 安装；
 *     所以求解一律由本目录的纯 JS 实现兜底（回溯布局 / 阻抗二分反解 / 网表图算法）。
 *   - 外部求解器适配器**只探测、不假装**：`SOLVER_ADAPTERS` 的静态基线是 available:false，
 *     真实可用性必须由 `detectExternalSolvers()` 在运行时用 `spawnSync` 探测（不联网）。
 *     探测不到时调用方必须走纯 JS 路径；探测本身失败也绝不抛异常。
 *   - 探测结果只反映"当前机器环境"，不参与任何求解结果；同环境同输入必得同 digest。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../board-model.mjs';

export { PLACEMENT_CODES, solvePlacement } from './placement.mjs';
export {
  COPPER_MM_PER_OZ,
  DEFAULT_DIELECTRIC_ER,
  STACKUP_ASSUMPTIONS,
  STACKUP_CODES,
  WIDTH_DOMAIN_MM,
  buildStackupPlan,
  layerAssignmentFor,
  solveStackup,
  solveStackupImpedance,
} from './stackup.mjs';
export { NETLIST_CODES, checkNetlist, netlistDiff, parseEndpoint } from './netlist.mjs';

/**
 * 外部求解器适配器基线。available 恒为 false：真实可用性由 detectExternalSolvers() 决定，
 * 任何模块都不得把这里的 false 改写成 true 来"宣称外部求解器已就绪"。
 */
export const SOLVER_ADAPTERS = Object.freeze({
  ortools: Object.freeze({
    name: 'OR-Tools CP-SAT',
    module: 'ortools',
    language: 'python',
    available: false,
    requiresDetection: true,
    usedFor: ['placement'],
    fallback: 'solvers/placement.mjs#solvePlacement（纯 JS 确定性回溯搜索）',
    note: '未安装时布局由纯 JS 回溯搜索兜底；不许把 fail-closed 的探测结果当成可用。',
  }),
  z3: Object.freeze({
    name: 'Z3 SMT',
    module: 'z3',
    language: 'python',
    available: false,
    requiresDetection: true,
    usedFor: ['netlist', 'stackup-constraints'],
    fallback: 'solvers/netlist.mjs#checkNetlist（纯 JS 图算法），solvers/stackup.mjs#solveStackup（纯 JS 枚举）',
    note: '未安装时连接性/叠层判定由纯 JS 实现兜底；不联网、不安装。',
  }),
  shapely: Object.freeze({
    name: 'Shapely 几何运算',
    module: 'shapely',
    language: 'python',
    available: false,
    requiresDetection: true,
    usedFor: ['placement-geometry'],
    fallback: 'solvers/placement.mjs 的矩形 AABB 相交/包含检测（含 courtyard+clearance 膨胀）',
    note: '未安装时几何判定是矩形近似（非任意多边形），已知局限在返回结果的 note 里说明。',
  }),
});

const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const DEFAULT_PROBE_TIMEOUT_MS = 2000;

function probeModule(binary, moduleName, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, env = process.env } = {}) {
  try {
    const result = spawnSync(binary, ['-c', `import ${moduleName}`], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: 'pipe',
      env,
    });
    if (result?.error) {
      return {
        binary,
        module: moduleName,
        ok: false,
        reason: result.error.code === 'ENOENT' ? 'binary-not-found' : `spawn-failed:${result.error.code ?? 'UNKNOWN'}`,
      };
    }
    if (result?.status === 0) {
      return { binary, module: moduleName, ok: true, reason: null };
    }
    const stderr = String(result?.stderr ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
    return {
      binary,
      module: moduleName,
      ok: false,
      reason: result?.status === null ? 'timeout-or-killed' : `import-failed:${result?.status}${stderr ? ` (${stderr.slice(0, 160)})` : ''}`,
    };
  } catch (error) {
    return { binary, module: moduleName, ok: false, reason: `probe-error:${error?.code ?? error?.message ?? error}` };
  }
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim() !== ''))];
}

/**
 * 探测外部求解器是否可用（spawn `python -c "import ortools"` 之类，纯本地、不联网、不安装）。
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env=process.env] 传给子进程的环境变量；可用 DSH_SOLVER_PYTHON 指定解释器
 * @param {string[]} [options.pythonBinaries] 覆盖解释器探测顺序（默认 DSH_SOLVER_PYTHON → python3 → python）
 * @param {number} [options.timeoutMs=2000] 单次探测超时
 * @returns {{ortools:object, z3:object, shapely:object, fallback:object, policy:string, digest:string}}
 */
export function detectExternalSolvers({ env = process.env, pythonBinaries = null, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const binaries = unique(
    Array.isArray(pythonBinaries) && pythonBinaries.length
      ? pythonBinaries
      : [env?.DSH_SOLVER_PYTHON, 'python3', 'python'],
  );
  const adapters = {};
  try {
    for (const [key, adapter] of Object.entries(SOLVER_ADAPTERS)) {
      const probed = [];
      let selected = null;
      for (const binary of binaries) {
        const probe = probeModule(binary, adapter.module, { timeoutMs, env });
        probed.push(probe);
        if (probe.ok) {
          selected = probe;
          break;
        }
        // 解释器本身不存在时没必要再试同一个解释器的其它模块顺序，但不同解释器仍继续尝试。
      }
      adapters[key] = {
        name: adapter.name,
        module: adapter.module,
        available: Boolean(selected),
        status: selected ? 'available' : 'unavailable',
        reason: selected ? null : (probed[probed.length - 1]?.reason ?? 'not-probed'),
        probed,
        fallback: adapter.fallback,
      };
    }
  } catch (error) {
    // 探测本身绝不能把调用方带崩：任何异常都收敛成 unavailable。
    for (const [key, adapter] of Object.entries(SOLVER_ADAPTERS)) {
      if (adapters[key]) continue;
      adapters[key] = {
        name: adapter.name,
        module: adapter.module,
        available: false,
        status: 'unavailable',
        reason: `probe-error:${error?.code ?? error?.message ?? error}`,
        probed: [],
        fallback: adapter.fallback,
      };
    }
  }
  const fallback = {
    available: true,
    implementation: 'pure-js',
    modules: [
      'solvers/placement.mjs（确定性回溯布局）',
      'solvers/stackup.mjs（层数枚举 + impedance.mjs 二分反解）',
      'solvers/netlist.mjs（网表图算法）',
    ],
    note: '外部求解器不可用时由纯 JS 实现兜底；结果可能不是全局最优，但确定且可复现，失败时 fail-closed。',
  };
  const payload = {
    ortools: { available: adapters.ortools?.available ?? false, reason: adapters.ortools?.reason ?? null },
    z3: { available: adapters.z3?.available ?? false, reason: adapters.z3?.reason ?? null },
    shapely: { available: adapters.shapely?.available ?? false, reason: adapters.shapely?.reason ?? null },
    fallback: fallback.implementation,
  };
  return {
    ...adapters,
    fallback,
    policy: '外部求解器未安装时不得声称可用；纯 JS 兜底，缺证据/超预算一律 fail-closed，不联网、不 npm install。',
    digest: sha256(payload),
  };
}
