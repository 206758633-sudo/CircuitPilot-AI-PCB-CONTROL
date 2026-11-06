/**
 * 复合设计框架统一入口。
 *
 * 分层（与文档 docs/architecture/composite-design-framework.md 一一对应）：
 *   Design-as-Code   → board-model.mjs（板级 IR / 适配器 / 编译到 EDA 操作）
 *   Rule-as-Code     → rule-deck.mjs + ipc-rules.mjs（规则判定器 + IPC/JLC 公式）
 *   External DRC     → kicad-drc.mjs（KiCad CLI 适配器，缺工具 fail-closed）
 *   Solvers          → solvers/**（布局回溯 / 叠层阻抗 / 网表图校验 + 外部求解器探测）
 *   Plan-Verify-Repair → loop.mjs + repair-strategies.mjs（有界闭环、只做确定性修复）
 *   Golden Evaluation → eval.mjs + eval/golden/*.json（回归与指标）
 *
 * 边界：不写 EDA、不自动签核；所有外部工具缺失时 fail-closed（绝不假装通过）。
 */
export * from './board-model.mjs';
export * from './ipc-rules.mjs';
export * from './rule-deck.mjs';
export * from './kicad-drc.mjs';
export * from './solvers/index.mjs';
export * from './repair-strategies.mjs';
export * from './loop.mjs';
export * from './eval.mjs';

// `export *` 只做再导出、不建立本地绑定；frameworkStatus 需要显式 import 这两个探测函数。
import { detectKicadCli } from './kicad-drc.mjs';
import { detectExternalSolvers } from './solvers/index.mjs';

export const DESIGN_FRAMEWORK_SCHEMA_VERSION = 1;

export const DESIGN_FRAMEWORK_LAYERS = Object.freeze([
  Object.freeze({ id: 'design-as-code', name: 'Design-as-Code', modules: Object.freeze(['board-model.mjs']), description: '板级规范 IR：统一输入/输出、可哈希、可离线迭代；EDA 由"必经之路"变为"编译目标 + 最终 oracle"' }),
  Object.freeze({ id: 'rule-as-code', name: 'Rule-as-Code', modules: Object.freeze(['rule-deck.mjs', 'ipc-rules.mjs']), description: '151 条布局规则 + IPC-2221/2152 公式的机器可判定实现；无判据给 REVIEW，绝不假 PASS' }),
  Object.freeze({ id: 'external-drc', name: 'External DRC adapter', modules: Object.freeze(['kicad-drc.mjs']), description: 'KiCad CLI 等外部 DRC 只读适配；工具缺失/报告非法 fail-closed' }),
  Object.freeze({ id: 'solvers', name: 'Solvers', modules: Object.freeze(['solvers/placement.mjs', 'solvers/stackup.mjs', 'solvers/netlist.mjs', 'solvers/index.mjs']), description: '纯 JS 确定性求解（回溯布局/叠层阻抗/网表），外部求解器只探测不假装可用' }),
  Object.freeze({ id: 'plan-verify-repair', name: 'Plan-Verify-Repair loop', modules: Object.freeze(['loop.mjs', 'repair-strategies.mjs']), description: '有界闭环：验证→确定性修复→再验证；REVIEW 未清零即 needs-review，阻断不清零即 blocked' }),
  Object.freeze({ id: 'golden-eval', name: 'Golden-board evaluation', modules: Object.freeze(['eval.mjs']), description: '金板用例回归 + 指标（通过率/迭代/修复次数/规则覆盖率），自主性改动的度量门禁' }),
]);

export function frameworkStatus({ env = process.env, candidates = ['kicad-cli'] } = {}) {
  return {
    schemaVersion: DESIGN_FRAMEWORK_SCHEMA_VERSION,
    kicad: detectKicadCli({ env, candidates }),
    externalSolvers: detectExternalSolvers({ env }),
    layers: DESIGN_FRAMEWORK_LAYERS.map((layer) => layer.id),
  };
}

/** 便捷别名：输入 IR → 闭环（等价 runDesignLoop，便于调用方按"框架"语义使用）。 */
export function runDesignFramework(input, options = {}) {
  return runDesignLoop(input, options);
}
