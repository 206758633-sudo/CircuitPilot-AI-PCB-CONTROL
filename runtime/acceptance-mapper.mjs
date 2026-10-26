/**
 * 需求→验收证据映射器（W2-04，模板化，适用于任意 PRD）。
 *
 * 输入只有需求文本（不要求先知道电路细节），输出每条需求的验收判据与证据类型，
 * 可直接喂给 design-spec 的 acceptance[]。规则按"领域语义"而不是具体板子命名：
 * 同一套模板对任意新 PRD 生效；无法识别的需求不静默通过，而是标 needsReview 并默认 signoff 证据。
 */
import { DESIGN_SPEC_EVIDENCE_KINDS } from './design-spec.mjs';

export const ACCEPTANCE_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'mcu', keywords: ['mcu', '主控', '单片机', '处理器', 'esp32', 'stm32', 'ch32', 'nrf', 'rp2040', 'soc', '芯片'], category: 'schematic', evidenceKind: 'schematic-erc', criterion: (text) => `主控连接/上电时序可验证：${text}（ERC 与网表证据）` }),
  Object.freeze({ id: 'interface', keywords: ['接口', '连接器', 'usb', 'type-c', 'i2c', 'spi', 'uart', 'i2s', 'can', 'rs485', 'rs232', 'hdmi', '排针', '端子', '焊盘'], category: 'interface', evidenceKind: 'pcb-layer-stack', criterion: (text) => `接口定义/引脚与板框匹配：${text}（叠层/板框与接口契约证据）` }),
  Object.freeze({ id: 'power', keywords: ['电源', '供电', '电压', '稳压', 'ldo', 'dcdc', 'buck', 'boost', '3v3', '5v', '12v', '24v', 'vcc', 'vbat', '电池', '防反接'], category: 'power', evidenceKind: 'spice-simulation', criterion: (text) => `供电/电压满足：${text}（仿真/上电测试证据）` }),
  Object.freeze({ id: 'led', keywords: ['led', '灯', 'ws2812', 'rgb', '数码管', '显示', 'oled', 'lcd', '背光'], category: 'bom', evidenceKind: 'order-confirmation', criterion: (text) => `发光/显示器件型号与驱动可采购：${text}（选型/BOM 证据）` }),
  Object.freeze({ id: 'audio', keywords: ['音频', '喇叭', '扬声器', '功放', '麦克风', 'mic', 'i2s', 'codec'], category: 'signal', evidenceKind: 'spice-simulation', criterion: (text) => `音频链路增益/失真可验证：${text}（仿真或实测证据）` }),
  Object.freeze({ id: 'sensor', keywords: ['传感', '触摸', '按键', '温湿度', '光敏', '加速度', '陀螺', '霍尔', '编码器'], category: 'signal', evidenceKind: 'spice-simulation', criterion: (text) => `传感器输入/按键响应可验证：${text}（信号完整性或实测证据）` }),
  Object.freeze({ id: 'mechanical', keywords: ['尺寸', '板框', '安装', '结构', '外壳', '孔位', '厚度', 'mm', '散热', '温度'], category: 'mechanical', evidenceKind: 'pcb-layer-stack', criterion: (text) => `机械/尺寸约束满足：${text}（板框/叠层证据）` }),
  Object.freeze({ id: 'manufacture', keywords: ['工艺', '制造', '拼板', '贴片', 'smt', '打样', '良率', '可制造'], category: 'dfm', evidenceKind: 'dfm-evidence', criterion: (text) => `可制造性满足：${text}（DFM 证据）` }),
  Object.freeze({ id: 'compliance', keywords: ['认证', 'emc', 'emi', '安规', 'ce', 'fcc', 'rohs', 'reliability', '可靠性', 'esd'], category: 'compliance', evidenceKind: 'dfm-evidence', criterion: (text) => `认证/合规约束满足：${text}（DFM/测试证据）` }),
  Object.freeze({ id: 'cost', keywords: ['成本', 'bom', '物料', '选型', '替代', '采购', '价格', '库存', 'lcsc', '立创'], category: 'bom', evidenceKind: 'order-confirmation', criterion: (text) => `选型/成本可落地：${text}（BOM/采购证据）` }),
]);

const DEFAULT_EVIDENCE_KIND = 'signoff';
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** 单条需求 → 验收项（纯函数、确定性）。 */
export function mapRequirement(requirement, { availableEvidenceKinds = DESIGN_SPEC_EVIDENCE_KINDS } = {}) {
  const requirementText = text(requirement?.requirement ?? requirement?.text ?? requirement);
  if (!requirementText) throw Object.assign(new Error('需求文本不能为空'), { code: 'ACCEPTANCE_REQUIREMENT_EMPTY' });
  const haystack = requirementText.toLowerCase();
  // 按命中关键词数量打分，平票按模板顺序（先领域主模板，再接口/供电等通用词）。
  let template = null;
  let bestScore = 0;
  for (const candidate of ACCEPTANCE_TEMPLATES) {
    const score = candidate.keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; template = candidate; }
  }
  const evidenceKind = template && availableEvidenceKinds.includes(template.evidenceKind) ? template.evidenceKind : DEFAULT_EVIDENCE_KIND;
  const mapped = Boolean(template);
  return {
    acceptance: {
      criterion: template ? template.criterion(requirementText) : `满足需求：${requirementText}（需人工确认验收方式）`,
      evidenceKind,
      needsReview: !mapped || evidenceKind !== template.evidenceKind,
    },
    mapped,
    templateId: template?.id ?? null,
    category: template?.category ?? 'general',
    rationale: mapped ? `命中模板 ${template.id}` : '未命中任何验收模板：默认 signoff 并标记人工确认，不静默通过',
  };
}

/**
 * 任意 PRD 需求清单 → acceptance 矩阵。
 * requirements 支持 [{id, requirement/text, category?}] 或字符串数组（自动编号 REQ-1..）。
 */
export function buildAcceptanceMatrix(requirements = [], options = {}) {
  if (!Array.isArray(requirements)) throw Object.assign(new Error('requirements 必须是数组'), { code: 'ACCEPTANCE_INPUT_INVALID' });
  const rows = requirements.map((item, index) => {
    const id = text(item?.id) || `REQ-${index + 1}`;
    const requirement = text(item?.requirement ?? item?.text ?? item);
    const { acceptance, mapped, templateId, category, rationale } = mapRequirement(requirement, options);
    return { id, requirement, category, mapped, templateId, rationale, acceptance: { requirementId: id, ...acceptance } };
  });
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) throw Object.assign(new Error(`需求 id 重复：${row.id}`), { code: 'ACCEPTANCE_INPUT_INVALID' });
    ids.add(row.id);
  }
  const unmapped = rows.filter((row) => !row.mapped).map((row) => row.id);
  return {
    total: rows.length,
    mapped: rows.length - unmapped.length,
    coverage: rows.length ? (rows.length - unmapped.length) / rows.length : 0,
    unmapped,
    requirements: rows,
  };
}

/**
 * 生成 design-spec 可直接消费的 requirements[]：acceptance 内联在每条需求上
 * （buildDesignSpec 的 acceptance 只读 requirement.acceptance，顶层列表仅作汇总/展示）。
 */
export function toDesignSpecInput(matrix) {
  const requirements = matrix.requirements.map((row) => ({
    id: row.id,
    category: row.category,
    requirement: row.requirement,
    acceptance: [{ criterion: row.acceptance.criterion, evidenceKind: row.acceptance.evidenceKind, needsReview: row.acceptance.needsReview }],
  }));
  const acceptance = matrix.requirements.map((row) => ({ ...row.acceptance }));
  return { requirements, acceptance };
}
