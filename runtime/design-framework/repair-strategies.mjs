/**
 * 修复策略注册表（Plan-Verify-Repair 的 Repair 段）。
 *
 * 原则：
 *   - 只做**确定性、可验证、可回滚**的修复：补叠层、重排布局（离线求解）、再验证；
 *   - 不能修的问题（网表短路、器件尺寸未知、规则无机器判据）一律升级为 blocked/needs-review，
 *     不假装"修好了"；
 *   - 每个修复带 riskLevel 与 verifyBy，供审批与证据链引用。
 */

/** 修复策略元数据：id/用途/风险/验证方式；真正执行在 loop.mjs（依赖求解器模块）。 */
export const REPAIR_STRATEGIES = Object.freeze({
  solve_stackup: Object.freeze({
    id: 'solve_stackup',
    description: '按候选层数/阻抗目标求解叠层，写回 IR 的 stackup 与 board.layers',
    riskLevel: 'medium',
    verifyBy: 'rule-deck + solvers/stackup',
  }),
  solve_placement: Object.freeze({
    id: 'solve_placement',
    description: '用约束回溯求解器重排未固定器件，写回坐标',
    riskLevel: 'medium',
    verifyBy: 'rule-deck + solvers/placement',
  }),
  manual_netlist: Object.freeze({
    id: 'manual_netlist',
    description: '网表短路/单端网络无法自动修复：升级给人工决定电气意图',
    riskLevel: 'high',
    verifyBy: '人工确认',
  }),
});

/** 属于"布局/几何"问题的规则组：这些 FAIL 可以尝试重排布局修复。 */
export const PLACEMENT_RULE_GROUPS = Object.freeze(['MECH', 'SPACE', 'ZCLR', 'CONN', 'MOVE', 'SILK', 'DFM', 'DFA', 'RF', 'PWR']);

const hardLevel = (level) => /硬门禁|强制|must|blocking/i.test(String(level ?? ''));

/** 判定一条规则 finding 是否阻断（优先用 rule-deck 给出的 blocking 字段）。 */
export function isBlockingFinding(finding) {
  if (!finding || finding.status !== 'FAIL') return false;
  if (typeof finding.blocking === 'boolean') return finding.blocking;
  return hardLevel(finding.level);
}

/**
 * 把阻断项分类成可执行的修复动作。
 * @param {Array<{source:string, code?:string, group?:string, ref?:string, message?:string}>} blocking
 * @returns {{needsStackup:boolean, needsPlacement:boolean, manual:Array}}
 */
export function classifyBlocking(blocking = []) {
  let needsStackup = false;
  let needsPlacement = false;
  const manual = [];
  for (const item of blocking) {
    if (!item) continue;
    if (item.source === 'stackup') { needsStackup = true; continue; }
    if (item.source === 'rule' && PLACEMENT_RULE_GROUPS.includes(item.group)) { needsPlacement = true; continue; }
    if (item.source === 'placement') { needsPlacement = true; continue; }
    manual.push(item);
  }
  return { needsStackup, needsPlacement, manual };
}
