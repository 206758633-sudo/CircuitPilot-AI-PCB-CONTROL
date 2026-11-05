/**
 * 步骤验证层（Phase 0 内核）。
 *
 * GUI 自动化最大的假阳性是"点了没报错 = 成功"。对 EDA 来说这尤其危险：
 * 菜单点空了、对话框没弹、换了个 EDA 窗口，动作都会"成功返回"，但世界没有变。
 *
 * 所以每个自动化步骤都可以带 `expect`：
 *
 *   expect: {
 *     readback: { kind: 'gui', action: 'state' },      // 或 {kind:'api', action:'project.current'}
 *     assertions: [
 *       { path: 'tabs', op: 'contains', value: 'PCB1', label: 'PCB 标签页' },
 *       { path: 'url', op: 'matches', value: 'easyeda' },
 *     ],
 *   }
 *
 * 判定规则（和仓库其它门禁一致）：
 *   - 读回本身失败 → 步骤失败（不是"没证据就算过"）；
 *   - 断言路径不存在 → 失败（不是"没有这个字段就算过"）；
 *   - 所有断言通过才算 verified。
 */

export const ASSERTION_OPS = Object.freeze(['equals', 'notEquals', 'atLeast', 'atMost', 'contains', 'containsAll', 'matches', 'nonEmpty', 'truthy', 'falsy', 'in', 'equalsPath', 'atLeastPath', 'atMostPath']);

/**
 * `containsAll`：数组/对象集合的包含断言（网表名、位号这类"A 必须都在 B 里"的读回）。
 *
 * 为什么需要它：pcb-sync-from-schematic 原来只比器件数，真机出现过"importChanges 弹窗未应用但
 * 器件数已达阈值 → 判 completed"的假成功；网表级读回必须能表达"期望网络名全部出现在 PCB 网络表"。
 * 空期望集合 = 调用方没传网表名 → 恒通过（向后兼容），但会把 readbackScope 标成 componentCountOnly
 * 供审计区分"只验了器件数"与"验了网表"。
 */
const nameOf = (item) => {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') {
    const name = item.net ?? item.name ?? item.netName ?? item.netname ?? item.designator ?? item.ref ?? null;
    return name === null || name === undefined ? null : String(name).trim();
  }
  return null;
};
/** 兼容桥的几种返回形状：['GND'] / [{net:'GND'}] / {nets:[...]} / {netNames:[...]}。 */
const namesOf = (actual) => {
  if (Array.isArray(actual)) return actual.map(nameOf).filter(Boolean);
  if (actual && typeof actual === 'object') {
    const nested = actual.nets ?? actual.netNames ?? actual.items ?? actual.data;
    if (Array.isArray(nested)) return nested.map(nameOf).filter(Boolean);
  }
  return null;
};
/** 期望集合归一化；非数组（调用方传错形状）返回 null，由断言层 fail-closed，避免静默降级成"只验计数"。 */
const expectedNamesOf = (expected) => {
  if (expected === undefined || expected === null) return [];
  if (!Array.isArray(expected)) return null;
  return expected.map((item) => String(item ?? '').trim()).filter(Boolean);
};

/** 取 obj 的点路径；数组用 `arr.0` 或 `arr[0]` 都可以。 */
export function getPath(value, path) {
  if (path === '' || path === null || path === undefined) return { value };
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((part) => part !== '');
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return { missing: true, path: String(path) };
    if (!(part in current)) return { missing: true, path: String(path) };
    current = current[part];
  }
  return { value: current };
}

const describe = (value) => {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  try { return JSON.stringify(value).slice(0, 120); } catch { return String(value); }
};

/** 单条断言的判定；不支持的 op 直接失败（防止写错 op 被静默忽略）。 */
export function evaluateAssertion(assertion, state) {
  const label = assertion?.label || assertion?.path || '(未命名断言)';
  const op = assertion?.op || 'equals';
  if (!ASSERTION_OPS.includes(op)) {
    return { ok: false, label, op, message: `不支持的断言操作：${op}`, expected: assertion?.value, actual: undefined };
  }
  const picked = getPath(state, assertion?.path);
  if (picked.missing) {
    return { ok: false, label, op, message: `读回结果里没有路径 ${assertion?.path}（没有证据不算通过）`, expected: assertion?.value, actual: undefined };
  }
  const actual = picked.value;
  const expected = assertion.value;
  const expectedNames = op === 'containsAll' ? expectedNamesOf(expected) : null;
  // readbackScope 供执行器/审计区分"只验了计数"与"验了网表集合"（见 evaluateAssertions 聚合）。
  // 形状非法也按 netlist 记（fail-closed，不降级成 componentCountOnly 骗过审计）。
  const scope = op === 'containsAll' ? ((expectedNames === null || expectedNames.length) ? 'netlist' : 'componentCountOnly') : null;
  let ok = false;
  let detail = '';
  switch (op) {
    case 'equals': ok = actual === expected; detail = `期望等于 ${describe(expected)}`; break;
    case 'notEquals': ok = actual !== expected; detail = `期望不等于 ${describe(expected)}`; break;
    case 'atLeast': ok = Number(actual) >= Number(expected); detail = `期望 ≥ ${describe(expected)}`; break;
    case 'atMost': ok = Number(actual) <= Number(expected); detail = `期望 ≤ ${describe(expected)}`; break;
    case 'contains':
      ok = typeof actual === 'string'
        ? actual.includes(String(expected))
        : Array.isArray(actual) ? actual.map((item) => String(item)).join(' ').includes(String(expected)) : false;
      detail = `期望包含 ${describe(expected)}`;
      break;
    case 'containsAll': {
      // 形状非法（非数组）：fail-closed，不能静默降级成"未提供集合"（那会让网表校验形同虚设）。
      if (expectedNames === null) { ok = false; detail = '期望集合必须是字符串数组（expectedNetNames）'; break; }
      // 空期望 = 调用方没传网表名：保持向后兼容（恒通过），但 scope 标成 componentCountOnly。
      if (!expectedNames.length) { ok = true; detail = '未提供期望集合（仅验证读回可用，不足以证明网表等价）'; break; }
      const actualNames = namesOf(actual);
      // 集合形状不可枚举时必须失败：不能把"读不到网络表"当成"网络都在"。
      if (!actualNames) { ok = false; detail = `期望可枚举的数组/集合，实际 ${describe(actual)}`; break; }
      const missing = expectedNames.filter((name) => !actualNames.includes(name));
      ok = missing.length === 0;
      detail = `期望包含 ${expectedNames.length} 个名字，缺 ${missing.slice(0, 8).join('、')}${missing.length > 8 ? '…' : ''}（实际 ${actualNames.length} 个）`;
      break;
    }
    case 'matches': {
      let regex = null;
      try { regex = new RegExp(String(expected), 'i'); } catch { regex = null; }
      ok = regex ? regex.test(String(actual)) : false;
      detail = `期望匹配 /${describe(expected)}/`;
      break;
    }
    case 'nonEmpty':
      ok = Array.isArray(actual) ? actual.length > 0 : typeof actual === 'string' ? actual.trim().length > 0 : actual !== null && actual !== undefined && actual !== '';
      detail = '期望非空';
      break;
    case 'truthy': ok = Boolean(actual); detail = '期望为真'; break;
    case 'falsy': ok = !actual; detail = '期望为假'; break;
    case 'in': ok = Array.isArray(expected) && expected.includes(actual); detail = `期望属于 ${describe(expected)}`; break;
    case 'equalsPath':
    case 'atLeastPath':
    case 'atMostPath': {
      // 与另一个读回路径比较（例如 PCB 器件数 ≥ 原理图器件数），避免把"计数"硬编码进配方。
      const other = getPath(state, String(expected));
      if (other.missing) {
        return { ok: false, label, op, message: `${label}：比较路径 ${expected} 不存在（没有证据不算通过）`, expected: expected === undefined ? null : expected, actual: actual === undefined ? null : actual };
      }
      const otherValue = other.value;
      if (op === 'equalsPath') ok = actual === otherValue;
      else if (op === 'atLeastPath') ok = Number(actual) >= Number(otherValue);
      else ok = Number(actual) <= Number(otherValue);
      detail = `期望 ${op === 'equalsPath' ? '等于' : op === 'atLeastPath' ? '≥' : '≤'} ${expected}（当前 ${describe(otherValue)}）`;
      break;
    }
    default: ok = false; detail = '未知断言';
  }
  return {
    ok,
    label,
    op,
    ...(scope ? { scope } : {}),
    message: ok ? `${label}：通过` : `${label}：${detail}，实际 ${describe(actual)}`,
    expected: expected === undefined ? null : expected,
    actual: actual === undefined ? null : actual,
  };
}

/** 对读回结果执行一组断言；任何一条失败 → 整体失败。 */
export function evaluateAssertions(assertions, state) {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    return { ok: false, checks: [], message: '步骤没有配置断言：没有证据的步骤不算验证通过' };
  }
  const checks = assertions.map((assertion) => evaluateAssertion(assertion, state));
  const failed = checks.filter((check) => !check.ok);
  // readbackScope：只要有一条 containsAll，就说明这步声明了集合级读回；期望集合为空时是
  // componentCountOnly（向后兼容），非空才是 netlist。runner 会把它写进 step.evidence 供审计。
  const scopes = checks.map((check) => check.scope).filter(Boolean);
  const readbackScope = scopes.includes('netlist') ? 'netlist' : scopes.includes('componentCountOnly') ? 'componentCountOnly' : null;
  return {
    ok: failed.length === 0,
    checks,
    failedCount: failed.length,
    ...(readbackScope ? { readbackScope } : {}),
    message: failed.length ? failed.map((check) => check.message).join('；') : '全部断言通过',
  };
}

/** 读回原始结果解包：bridge 的返回值习惯性包一层 {ok,result}。 */
export function unwrapReadback(result) {
  // 桥的成功信封是 { success: true, result }（真机实测），HTTP 层/测试桩可能用 { ok: true, result }。
  // 两种都要解开；否则断言会对着信封找路径，永远"路径不存在"（真机踩过）。
  if (result && typeof result === 'object' && 'result' in result && ('ok' in result || 'success' in result)) return result.result;
  return result;
}
