/**
 * A4：网表 assumption 的结构化标注（方向 + 来源）。
 *
 * 问题：AI/人工给的 assumptions 原来只是一串字符串，无法回答"这条判断是电源方向？信号方向？
 * 还是未用脚？来自显式人工判断还是 AI 推断？"。本模块把字符串归一成可审计结构：
 *   { text, direction: 'power'|'ground'|'signal'|'no-connect'|'unknown', source: 'explicit'|'inferred', needsReview }
 *
 * fail-closed 口径：
 *   - 空文本 → 直接 blocker（不是"没意见"，是脏数据）；
 *   - direction=unknown → warning + needsReview（不阻断普通生成；`strict:true` 时调用方要求必须标注，才 409）；
 *   - 来源未知（既非 explicit 也非 inferred）→ blocker；
 *   - 不猜测语义：分类只按关键词，未知就保持 unknown，绝不硬塞方向。
 */
export const ASSUMPTION_DIRECTIONS = Object.freeze(['power', 'ground', 'signal', 'no-connect', 'unknown']);
export const ASSUMPTION_SOURCES = Object.freeze(['explicit', 'inferred']);
export const ASSUMPTION_CODES = Object.freeze({
  EMPTY: 'NETLIST_ASSUMPTION_EMPTY',
  SOURCE_INVALID: 'NETLIST_ASSUMPTION_SOURCE_INVALID',
  UNMARKED: 'NETLIST_ASSUMPTION_UNMARKED',
});

const text = (value) => String(value ?? '').trim();

const RULES = [
  { direction: 'no-connect', patterns: [/未用/, /悬空/, /不接/, /\bNC\b/i, /no[-_ ]?connect/i, /not connected/i] },
  { direction: 'ground', patterns: [/\bGND\b/i, /接地/, /地线/, /ground/i, /AGND|DGND|PGND/i] },
  { direction: 'power', patterns: [/电源/, /供电/, /上拉/, /下拉/, /\bVCC|VDD|VBAT|3V3|5V|12V|PWR\b/i, /power/i, /rail/i] },
  { direction: 'signal', patterns: [/信号/, /数据/, /时钟/, /总线/, /通信/, /串口/, /I2C|SPI|UART|USB|CAN|GPIO|CLK|DATA\b/i, /signal/i] },
];

export function classifyAssumption(value) {
  const raw = text(value);
  for (const rule of RULES) if (rule.patterns.some((pattern) => pattern.test(raw))) return rule.direction;
  return 'unknown';
}

/**
 * @param {Array<unknown>} list
 * @param {{defaultSource?:'explicit'|'inferred', sourceOverrides?:Array<'explicit'|'inferred'>}} [options]
 */
export function normalizeAssumptions(list, { defaultSource = 'inferred' } = {}) {
  const items = [];
  (Array.isArray(list) ? list : []).forEach((entry, index) => {
    if (entry && typeof entry === 'object') {
      const itemText = text(entry.text ?? entry.assumption);
      const direction = ASSUMPTION_DIRECTIONS.includes(entry.direction) ? entry.direction : classifyAssumption(itemText);
      const source = ASSUMPTION_SOURCES.includes(entry.source) ? entry.source : defaultSource;
      items.push({ index, text: itemText, direction, source, needsReview: direction === 'unknown' || !ASSUMPTION_SOURCES.includes(entry.source) });
      return;
    }
    const itemText = text(entry);
    const direction = classifyAssumption(itemText);
    items.push({ index, text: itemText, direction, source: defaultSource, needsReview: direction === 'unknown' });
  });
  return items;
}

export function auditNetlistAssumptions(list, { defaultSource = 'inferred' } = {}) {
  const items = normalizeAssumptions(list, { defaultSource });
  const blockers = [];
  const warnings = [];
  for (const item of items) {
    if (!item.text) blockers.push({ code: ASSUMPTION_CODES.EMPTY, message: `第 ${item.index + 1} 条 assumption 是空文本`, index: item.index });
    else if (!ASSUMPTION_SOURCES.includes(item.source)) blockers.push({ code: ASSUMPTION_CODES.SOURCE_INVALID, message: `第 ${item.index + 1} 条 assumption 来源非法：${item.source}`, index: item.index });
    else if (item.direction === 'unknown') warnings.push({ code: ASSUMPTION_CODES.UNMARKED, message: `第 ${item.index + 1} 条 assumption 未标注方向（power/ground/signal/no-connect）："${item.text}"`, index: item.index });
  }
  return {
    ok: blockers.length === 0,
    strictOk: blockers.length === 0 && warnings.length === 0,
    counts: {
      total: items.length,
      marked: items.filter((item) => item.direction !== 'unknown').length,
      unmarked: items.filter((item) => item.direction === 'unknown').length,
      explicit: items.filter((item) => item.source === 'explicit').length,
      inferred: items.filter((item) => item.source === 'inferred').length,
    },
    items,
    blockers,
    warnings,
  };
}
