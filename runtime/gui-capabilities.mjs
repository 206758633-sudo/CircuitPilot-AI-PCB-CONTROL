/**
 * E9：GUI 兜底动作清单（与配方绑定）+ 只读能力探测。
 *
 * 背景：API 优先、GUI 兜底，但兜底动作此前只登记了 15 个原子动作，没有"应用级动作清单"，
 * 也没法回答"这台 EDA 上这些菜单文案还在不在"。本模块把兜底动作写成可探测的目录：
 *   - `click`：主文案（clickText 会按顺序尝试 alternatives）；
 *   - `waitFor`：动作后的断言文案（waitText），缺断言的动作不允许登记为 wired；
 *   - `blocked`：政策红线（如进入下单/支付页）永远不登记为兜底动作；
 *   - `recipeIds`：该动作被哪个自动化配方使用（没有配方的动作是"候选"，不是已完成）。
 *
 * 探测本身只读（findTexts），不点击、不输入；配 `viewport` 可在同一份 EDA 上验证
 * 两种布局尺寸下文案是否仍可定位（用于 E9 验收的"2 种窗口尺寸可复现"）。
 */
export const GUI_CAPABILITY_CATALOG = Object.freeze([
  {
    id: 'open-project', label: '打开工程', group: 'navigation', write: false,
    click: ['打开工程', '工程'],
    waitFor: ['原理图', 'PCB'],
    recipeIds: [],
    note: '仅在 API 上下文探测失败时使用；点击会改变 UI 状态，但不会写板。',
  },
  {
    id: 'open-pcb-document', label: '切到 PCB 文档', group: 'navigation', write: false,
    click: ['PCB'],
    waitFor: ['PCB'],
    recipeIds: [],
  },
  {
    id: 'rebuild-pours', label: '重建铺铜', group: 'pcb', write: true,
    click: ['铺铜', '重建铺铜', '铺铜管理器'],
    waitFor: ['铺铜'],
    recipeIds: ['pcb-rebuild-pours'],
  },
  {
    id: 'update-pcb-from-schematic', label: '更新/转换原理图到 PCB', group: 'pcb', write: true,
    click: ['更新/转换原理图到 PCB', '更新PCB到原理图', '更新'],
    waitFor: ['更新', '转换'],
    recipeIds: ['pcb-sync-from-schematic'],
    note: 'EDA 3.2.186 真机未找到该菜单文案（E6 漂移），此条为候选，探测可用性后才能承诺兜底。',
  },
  {
    id: 'open-drc-panel', label: '打开 DRC 面板', group: 'validation', write: false,
    click: ['DRC', '设计规则检查'],
    waitFor: ['DRC'],
    recipeIds: ['pcb-drc-run'],
  },
  {
    id: 'export-production-files', label: '导出生产文件菜单', group: 'production', write: false,
    click: ['导出', '制造', '生产文件'],
    waitFor: ['Gerber', '导出'],
    recipeIds: ['pcb-export-production'],
  },
  {
    id: 'online-dfm-nav', label: '在线 DFM 导航', group: 'human', write: false,
    click: [],
    waitFor: [],
    recipeIds: [],
    blocked: true,
    reason: 'R9 在线 DFM 必须由人到嘉立创网站执行后回填证据；系统不做自动导航/提交。',
  },
  {
    id: 'checkout-nav', label: '下单/支付页导航', group: 'forbidden', write: false,
    click: ['下单', '支付', '结算', '提交订单', '立即购买', 'place order'],
    waitFor: [],
    recipeIds: [],
    blocked: true,
    reason: 'G2 政策红线：orderEnabled=false，任何配方不得进入下单/支付确认页。',
  },
]);

/** 目录里所有需要探测的文案（去重，供 findTexts 一次查询）。 */
export function catalogTexts(catalog = GUI_CAPABILITY_CATALOG) {
  const texts = [];
  for (const entry of catalog) for (const text of [...(entry.click || []), ...(entry.waitFor || [])]) if (!texts.includes(text)) texts.push(text);
  return texts;
}

/**
 * 把 findTexts 探测结果映射到目录条目。
 * @param {{catalog?:Array, probe?:{matches?:Array<{text:string,found:boolean,matches:Array}>}}} input
 * @returns {{entries:Array, missingTexts:string[], availableCount:number, blockedCount:number}}
 */
export function evaluateGuiCapabilities({ catalog = GUI_CAPABILITY_CATALOG, probe = {} } = {}) {
  const found = new Map((probe.matches || []).map((item) => [String(item.text), item]));
  const entries = catalog.map((entry) => {
    const texts = [...(entry.click || []), ...(entry.waitFor || [])];
    const details = texts.map((text) => ({ text, found: found.get(text)?.found === true, matches: found.get(text)?.matches?.length ?? 0 }));
    const missingTexts = details.filter((item) => !item.found).map((item) => item.text);
    const wired = (entry.click || []).length > 0 && (entry.waitFor || []).length > 0;
    return {
      id: entry.id,
      label: entry.label,
      group: entry.group,
      write: entry.write === true,
      blocked: entry.blocked === true,
      reason: entry.reason ?? null,
      recipeIds: entry.recipeIds || [],
      wired,
      available: entry.blocked === true ? false : details.some((item) => item.found),
      complete: wired && missingTexts.length === 0,
      details,
      missingTexts,
    };
  });
  return {
    entries,
    missingTexts: entries.flatMap((entry) => entry.missingTexts),
    availableCount: entries.filter((entry) => entry.available).length,
    blockedCount: entries.filter((entry) => entry.blocked).length,
  };
}
