/**
 * 位号标注门禁（A5）。
 *
 * 真机教训：新建原理图器件默认是 `C?`/`R?` 占位，EDA 的位号标注是异步的；
 * 未标注位号会让 PCB 同步 diff 的 `unannotated` 非 0，落板/布局/同步全链路都不可信。
 *
 * 因此把"位号必须已标注"做成执行前硬门禁：计划里出现 `?` 一律拒绝（fail-closed），
 * 而不是带着占位位号去写板。标注本身走 `schematic.component.designator.set`
 * （真机验证过的 `sch_PrimitiveComponent.modify(id,{designator})`）。
 */

export const DESIGNATOR_CODES = {
  UNANNOTATED: 'DESIGNATOR_UNANNOTATED',
  INVALID: 'DESIGNATOR_INVALID',
};

/** 是否已标注：非空且不含占位符 `?`。 */
export function isAnnotatedDesignator(value) {
  const text = String(value ?? '').trim();
  return text.length > 0 && !text.includes('?');
}

/** 找出列表里的未标注位号（保序去重），保留原值便于报错定位。 */
export function findUnannotatedDesignators(list) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(list) ? list : []) {
    const text = String(value ?? '').trim();
    if (!text || isAnnotatedDesignator(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 执行前断言：计划/更新清单里不允许出现未标注位号。
 * @param {Array} list 位号数组
 * @param {{label?:string}} options
 */
export function assertAnnotatedDesignators(list, { label = '计划' } = {}) {
  const unannotated = findUnannotatedDesignators(list);
  if (unannotated.length) {
    throw Object.assign(new Error(`${label}含未标注位号：${unannotated.slice(0, 8).join('、')}${unannotated.length > 8 ? '…' : ''}；请先在 EDA 完成位号标注（设计→标注位号）再执行`), {
      code: DESIGNATOR_CODES.UNANNOTATED,
      details: { label, unannotated },
    });
  }
  return true;
}

/** 标注目标位号的格式校验：只接受"字母前缀 + 数字（可带 1 个后缀字母）"，拒绝 `?`。 */
export function assertAnnotatableDesignator(designator) {
  const text = String(designator ?? '').trim();
  if (!/^[A-Za-z]{1,5}[0-9]+[A-Za-z]?$/.test(text)) {
    throw Object.assign(new Error(`目标位号不合法：${text || '(空)'}；只接受字母前缀+数字（如 C12、U3A→U3），不能用 C? 占位`), {
      code: DESIGNATOR_CODES.INVALID,
      details: { designator: text },
    });
  }
  return text;
}
