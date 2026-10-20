/**
 * 需求硬约束 → 可机器校验的门禁（A1）。
 *
 * 问题：过去 `requirements` 只是给 AI 看的文本，AI 可以产出"形式合法但违反约束"的计划
 * （电流预算、板框尺寸、GPIO 数量、接口、温度），放行闸门完全看不见。
 *
 * 本模块把**硬性且可量化**的需求归一化成约束项，与设计事实逐条比对，输出：
 *   pass / fail / unknown（拿不到事实一律 unknown，按 fail-closed 阻断，绝不默认通过）。
 *
 * 边界：
 *   - 只做确定性比对，不猜需求；无法量化的需求标 `unclassified` 给人工确认，不冒充通过；
 *   - 同一约束的方向（max=不得超预算 / min=不得低于下限）由约束类型固定，避免"随便比一下"。
 */

export const CONSTRAINT_CODES = {
  FAILED: 'CONSTRAINT_FAILED',
  UNKNOWN_FACT: 'CONSTRAINT_FACT_UNKNOWN',
  UNCLASSIFIED: 'CONSTRAINT_UNCLASSIFIED',
  INVALID: 'CONSTRAINT_INVALID',
};

const num = (value) => {
  const match = String(value ?? '').replace(/,/g, '').match(/-?[0-9]+(?:\.[0-9]+)?/);
  return match ? Number(match[0]) : null;
};
const toMilliAmp = (value, unit) => {
  const n = num(value);
  if (n === null) return null;
  return /a/i.test(String(unit || '')) && !/ma/i.test(String(unit || '')) ? n * 1000 : n;
};
const text = (value) => String(value ?? '').trim();

/** 把一条 Requirement 归一化成可校验约束；不可量化时返回 unclassified 约束。 */
export function normalizeRequirementConstraint(requirement = {}) {
  const name = `${text(requirement.name)} ${text(requirement.category)}`;
  const value = text(requirement.value);
  const unit = text(requirement.unit);
  const base = { id: text(requirement.id) || null, name: text(requirement.name) || text(requirement.category), raw: `${value}${unit}`, blocking: requirement.blocking !== false, kind: requirement.kind || 'hard' };
  if (requirement.status && requirement.status !== 'confirmed') return { ...base, type: 'unclassified', reason: `需求状态为 ${requirement.status}，未确认前不作为门禁` };
  if (requirement.kind === 'soft') return { ...base, type: 'unclassified', reason: '软约束只提示，不作为硬门禁' };
  if (/板框|外形尺寸|板尺寸|尺寸/.test(name)) {
    const numbers = (value.match(/-?[0-9]+(?:\.[0-9]+)?/g) || []).map(Number);
    const width = numbers[0] ?? null; const height = numbers[1] ?? null;
    if (width === null) return { ...base, type: 'unclassified', reason: '板框尺寸没有可解析数值' };
    return { ...base, type: 'board.minSize', minWidthMm: width, minHeightMm: height, comparator: 'min' };
  }
  if (/电流|功耗|供电预算|预算/.test(name)) {
    const budgetMa = toMilliAmp(value, unit);
    if (budgetMa === null) return { ...base, type: 'unclassified', reason: '电流预算没有可解析数值' };
    return { ...base, type: 'power.maxTotalMa', limitMa: budgetMa, comparator: 'max' };
  }
  if (/gpio|引脚|io\s*口|io\s*数/i.test(name)) {
    const required = num(value);
    if (required === null) return { ...base, type: 'unclassified', reason: 'GPIO 数量没有可解析数值' };
    return { ...base, type: 'gpio.minAvailable', required, comparator: 'min' };
  }
  if (/接口|type-?c|usb|uart|i2c|spi|can|rs485/i.test(name)) {
    const required = value.split(/[、,，/\s+]+/).map((item) => item.trim()).filter(Boolean);
    if (!required.length) return { ...base, type: 'unclassified', reason: '接口需求为空' };
    return { ...base, type: 'interface.required', required, comparator: 'includes' };
  }
  if (/温度|耐温|工作温度/.test(name)) {
    const maxC = num(value);
    if (maxC === null) return { ...base, type: 'unclassified', reason: '温度需求没有可解析数值' };
    return { ...base, type: 'temperature.maxC', limitC: maxC, comparator: 'max' };
  }
  return { ...base, type: 'unclassified', reason: '没有对应的机器校验器（需人工确认）' };
}

/** 批量归一化：接受 Requirement 列表或已结构化约束列表。 */
export function normalizeConstraints(input = []) {
  if (!Array.isArray(input)) throw Object.assign(new Error('constraints 必须是数组'), { code: CONSTRAINT_CODES.INVALID });
  return input.map((item) => (item && typeof item.type === 'string' ? { ...item, blocking: item.blocking !== false } : normalizeRequirementConstraint(item)));
}

/** 从设计事实里读数值；缺就返回 null（unknown），不猜。 */
export function readDesignFacts(facts = {}) {
  const board = facts.board || {};
  const power = facts.power || {};
  const mcu = facts.mcu || {};
  const env = facts.environment || {};
  return {
    boardWidthMm: num(board.widthMm ?? facts.boardWidthMm),
    boardHeightMm: num(board.heightMm ?? facts.boardHeightMm),
    powerTotalMa: num(power.totalMa ?? facts.powerTotalMa),
    gpioAvailable: num(mcu.gpioAvailable ?? facts.gpioAvailable),
    interfaces: Array.isArray(facts.interfaces) ? facts.interfaces.map((item) => String(item).toLowerCase()) : (Array.isArray(mcu.interfaces) ? mcu.interfaces.map((item) => String(item).toLowerCase()) : null),
    maxTemperatureC: num(env.maxTemperatureC ?? facts.maxTemperatureC),
  };
}

/**
 * 逐条比对约束与设计事实。
 * @returns {{ok:boolean, report:Array, fails:Array, unknowns:Array, unclassified:Array}}
 */
export function checkConstraints({ constraints = [], facts = {} } = {}) {
  const normalized = normalizeConstraints(constraints);
  const design = readDesignFacts(facts);
  const report = normalized.map((constraint) => {
    if (constraint.type === 'unclassified') return { ...constraint, status: 'unclassified', message: constraint.reason || '不可机器校验，需人工确认' };
    if (constraint.type === 'board.minSize') {
      if (design.boardWidthMm === null || design.boardHeightMm === null) return { ...constraint, status: 'unknown', message: '拿不到板框实测尺寸：无法证明满足最小板框，按阻断处理' };
      const actual = { widthMm: design.boardWidthMm, heightMm: design.boardHeightMm };
      const ok = actual.widthMm >= constraint.minWidthMm && (constraint.minHeightMm === null || actual.heightMm >= constraint.minHeightMm);
      return { ...constraint, status: ok ? 'pass' : 'fail', actual, message: ok ? `板框 ${actual.widthMm}×${actual.heightMm}mm 满足最小 ${constraint.minWidthMm}×${constraint.minHeightMm ?? '—'}mm` : `板框 ${actual.widthMm}×${actual.heightMm}mm 小于需求 ${constraint.minWidthMm}×${constraint.minHeightMm ?? '—'}mm` };
    }
    if (constraint.type === 'power.maxTotalMa') {
      if (design.powerTotalMa === null) return { ...constraint, status: 'unknown', message: '拿不到电流预算实测/估算值：无法证明不超预算，按阻断处理' };
      const ok = design.powerTotalMa <= constraint.limitMa;
      return { ...constraint, status: ok ? 'pass' : 'fail', actual: design.powerTotalMa, message: ok ? `总电流 ${design.powerTotalMa}mA ≤ 预算 ${constraint.limitMa}mA` : `总电流 ${design.powerTotalMa}mA 超过预算 ${constraint.limitMa}mA` };
    }
    if (constraint.type === 'gpio.minAvailable') {
      if (design.gpioAvailable === null) return { ...constraint, status: 'unknown', message: '拿不到可用 GPIO 数：无法证明满足，按阻断处理' };
      const ok = design.gpioAvailable >= constraint.required;
      return { ...constraint, status: ok ? 'pass' : 'fail', actual: design.gpioAvailable, message: ok ? `可用 GPIO ${design.gpioAvailable} ≥ 需求 ${constraint.required}` : `可用 GPIO ${design.gpioAvailable} 少于需求 ${constraint.required}` };
    }
    if (constraint.type === 'interface.required') {
      if (!design.interfaces) return { ...constraint, status: 'unknown', message: '拿不到接口清单：无法证明具备所需接口，按阻断处理' };
      const missing = constraint.required.filter((need) => !design.interfaces.some((have) => have.includes(String(need).toLowerCase()) || String(need).toLowerCase().includes(have)));
      return { ...constraint, status: missing.length ? 'fail' : 'pass', actual: design.interfaces, message: missing.length ? `缺少需求接口：${missing.join('、')}` : `接口齐全：${constraint.required.join('、')}` };
    }
    if (constraint.type === 'temperature.maxC') {
      if (design.maxTemperatureC === null) return { ...constraint, status: 'unknown', message: '拿不到温度实测值：无法证明满足，按阻断处理' };
      const ok = design.maxTemperatureC <= constraint.limitC;
      return { ...constraint, status: ok ? 'pass' : 'fail', actual: design.maxTemperatureC, message: ok ? `温度 ${design.maxTemperatureC}°C ≤ 上限 ${constraint.limitC}°C` : `温度 ${design.maxTemperatureC}°C 超过上限 ${constraint.limitC}°C` };
    }
    return { ...constraint, status: 'unclassified', message: `未知约束类型：${constraint.type}` };
  });
  const fails = report.filter((item) => item.status === 'fail');
  const unknowns = report.filter((item) => item.status === 'unknown' && item.blocking !== false);
  const unclassified = report.filter((item) => item.status === 'unclassified');
  return { ok: fails.length === 0 && unknowns.length === 0, report, fails, unknowns, unclassified, facts: design };
}
