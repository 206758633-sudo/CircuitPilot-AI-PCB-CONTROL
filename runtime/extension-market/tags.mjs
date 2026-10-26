/**
 * 扩展能力标签词表（v0，纯手写映射，不做 LLM 自动打标）。
 *
 * 为什么要手写：
 * - 能力公告板会被注入到其它 AI agent 的 prompt 里，标签一旦由 LLM 生成就无法审计，
 *   也无法保证同一扩展每次生成的 tags/digest 稳定（prompt 会抖动）。
 * - 扩展自身 extension.json 里的 keywords/categories 是外部词，需要映射成 CircuitPilot
 *   自己的需求标签；映射不到就进 'other' 桶，宁可少推荐也不乱推荐。
 *
 * 本文件只做“外部词/名称 → 内部标签”的确定性映射，不读文件、不发网络请求。
 */

/** 内部标签词表（v0 固定）。新增标签要同时更新这里与测试夹具。 */
export const EXTENSION_TAGS = Object.freeze([
  'AI 辅助',
  '彩色丝印',
  '丝印',
  '绕组',
  '电源打孔',
  '过孔',
  '规则生成',
  'DRC',
  '仿真',
  '布线',
  '布局',
  '原理图',
  'BOM',
  '器件库',
  '封装库',
  '格式转换',
  '面板',
  '钢网',
  '载流',
  '机械/3D',
  '供应链',
  '图案',
  'demo',
]);

/**
 * 关键词 → 标签。匹配对象是 [displayName, id, keywords, categories, summary] 的拼接串，
 * 全部小写化后做 includes；顺序固定，输出按 EXTENSION_TAGS 顺序去重，保证稳定。
 */
const TAG_RULES = Object.freeze([
  { tag: 'AI 辅助', words: ['ai', 'agent', 'copilot', '助手', '智能', 'deepseek', 'gpt', '大模型'] },
  { tag: '彩色丝印', words: ['彩色丝印', 'color silk', 'color-silk', 'colorsilkscreen'] },
  { tag: '丝印', words: ['丝印', 'silkscreen', 'silk'] },
  { tag: '绕组', words: ['绕组', '变压器', 'transformer', 'winding', 'csr'] },
  { tag: '电源打孔', words: ['电源地就近打孔', '电源打孔', '就近打孔', 'autofanout', 'pcb-autofanout'] },
  { tag: '过孔', words: ['过孔', 'via'] },
  { tag: '规则生成', words: ['规则生成', 'design rule', 'design-rule', 'drc rule'] },
  { tag: 'DRC', words: ['drc', '设计规则检查'] },
  { tag: '仿真', words: ['仿真', 'simulation', 'spice', 'ngspice', 'simulide', 'kipida', 'paden'] },
  { tag: '布线', words: ['布线', 'router', 'routing', 'autorouter', 'autoroute', 'freerouting', 'fanout', '扇出'] },
  { tag: '布局', words: ['布局', 'placement', 'layout', '分组'] },
  { tag: '原理图', words: ['原理图', 'schematic', 'sch-', 'net-fanout', 'pcbai'] },
  { tag: 'BOM', words: ['bom', '物料', 'solder assistant', '映射'] },
  { tag: '器件库', words: ['器件', '元件', '元件库', '库存', 'partlab', 'library', '建库', '标准化'] },
  { tag: '封装库', words: ['封装', 'footprint', 'symbol'] },
  { tag: '格式转换', words: ['格式转换', 'format-convert', 'convert', '导入'] },
  { tag: '面板', words: ['面板', 'panel'] },
  { tag: '钢网', words: ['钢网', 'stencil'] },
  { tag: '载流', words: ['载流', 'copper-route', '电流'] },
  { tag: '机械/3D', words: ['3d', 'step', 'freecad', 'solidworks', '机械', '外壳'] },
  { tag: '供应链', words: ['erp', '供应链', '下单', '库存管理'] },
  { tag: '图案', words: ['图片', 'image', 'logo', '图案', '二维码'] },
  { tag: 'demo', words: ['demo', '巧绘', '示例'] },
]);

/** 把外部词数组安全摊平成小写字符串。 */
function flattenWords(values) {
  if (!Array.isArray(values)) return '';
  return values.filter((value) => typeof value === 'string').join(' ').toLowerCase();
}

/** 由扩展记录推导标签；顺序稳定（按 EXTENSION_TAGS 词表顺序）。 */
export function deriveTags({ name = '', extensionId = '', keywords = [], categories = [], summary = '' } = {}) {
  const haystack = `${name} ${extensionId} ${summary} ${flattenWords(keywords)} ${flattenWords(categories)}`.toLowerCase();
  const hits = new Set();
  for (const rule of TAG_RULES) {
    if (rule.words.some((word) => haystack.includes(word))) hits.add(rule.tag);
  }
  return EXTENSION_TAGS.filter((tag) => hits.has(tag));
}
