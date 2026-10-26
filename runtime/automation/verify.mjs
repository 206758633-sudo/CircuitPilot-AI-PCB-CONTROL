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

export const ASSERTION_OPS = Object.freeze(['equals', 'notEquals', 'atLeast', 'atMost', 'contains', 'matches', 'nonEmpty', 'truthy', 'falsy', 'in', 'equalsPath', 'atLeastPath', 'atMostPath']);

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
  return {
    ok: failed.length === 0,
    checks,
    failedCount: failed.length,
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
