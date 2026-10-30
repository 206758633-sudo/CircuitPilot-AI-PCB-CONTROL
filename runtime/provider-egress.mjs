/**
 * G4：数据外发与 provider 告知。
 *
 * 这里不是新的"外发通道"，而是把**现有**外发点说清楚 + 提供脱敏预览：
 *   - 清单列出每个会调用 AI provider 的路由、触发条件、发送字段、明确不发送的内容；
 *   - 外发模式是 per-action（用户点"发送/生成"才发），不存在后台自动上传工程文件的路径；
 *   - 预览用与日志/诊断包同一套 redactSecrets 脱敏，任何 key/token/本机路径都会在示例里被擦掉。
 *
 * 边界（不冒充）：
 *   - 清单是人工维护的接口契约，新增 provider 调用点必须同步更新并有测试兜底（测试断言路由集合）；
 *   - 脱敏不等于内容审查：把密钥写进普通业务字段仍需调用方自觉；图片/文本附件会按原样发送（用户选择上传）；
 *   - 本模块不改变任何发送行为，只做告知与预览。
 */
import { redactSecrets } from './log-redaction.mjs';

export const PROVIDER_EGRESS_POLICY_VERSION = '2026-10-20.1';

/** 现有外发点（与测试里的路由集合一一对应；新增调用点必须同步加进来）。 */
const ENDPOINTS = Object.freeze([
  {
    id: 'chat.turn',
    route: 'POST /api/chat/sessions/:id/messages',
    trigger: '用户在聊天页点击发送',
    data: [
      { field: 'messages', source: '用户输入的对话文本' },
      { field: 'attachments.text', source: '用户主动上传的文本附件' },
      { field: 'attachments.image', source: '用户主动上传的图片（视觉模型）' },
      { field: 'edaEvidence', source: '只读 EDA 摘要：当前页面/工程/文档标识与状态，不含工程文件字节' },
    ],
    excluded: ['API Key / 登录令牌（仅服务端 keychain 读取用于鉴权头，不进入提示词）', 'Gerber/STEP/PDF 等工程文件字节', '本机绝对路径（发送前经 log-redaction 擦除 /Users/<user>）'],
  },
  {
    id: 'plan.ai',
    route: 'POST /api/production/plans/ai',
    trigger: '用户在 EDA/生产页点击"AI 生成计划"',
    data: [
      { field: 'requirements', source: '当前已确认需求文本' },
      { field: 'bomSummary', source: 'BOM 摘要（位号/型号/数量），不含完整工程文件' },
      { field: 'designFacts', source: '用户录入或读回的设计事实摘要' },
    ],
    excluded: ['API Key / 登录令牌', '工程文件字节', '本机绝对路径'],
  },
  {
    id: 'netlist.ai',
    route: 'POST /api/design/netlist/ai',
    trigger: '用户在 EDA 页点击"AI 生成网表草案"',
    data: [
      { field: 'components', source: '器件清单（位号/型号/封装）' },
      { field: 'nets', source: '网络与引脚意图文本' },
      { field: 'pinEvidence', source: '引脚证据摘要（网络/脚号/焊盘），已先通过审计' },
    ],
    excluded: ['API Key / 登录令牌', '工程文件字节', '本机绝对路径'],
  },
  {
    id: 'knowledge.research',
    route: 'Runtime 内部：知识维护/联网检索（KMA 调度器）',
    trigger: '「联网检索」开关开启后由 KMA 定时器触发，或用户手动点“运行知识维护”',
    data: [
      { field: 'query', source: '已确认需求/器件主题生成的检索关键词（不含工程文件）' },
      { field: 'pageExcerpt', source: '白名单站点返回的公开网页摘要（只写入 candidate 知识条目，需人工审核后才可能被引用）' },
    ],
    excluded: ['API Key / 登录令牌', '工程文件字节（Gerber/STEP/DRC 报告本体）', '本机绝对路径', '未经用户开启联网时的任何自动请求'],
    defaultEnabled: false,
    consent: '由 Runtime researchConfig 权威控制；默认关闭，关闭时 KMA 定时器不启动',
  },
  {
    id: 'part.proposal',
    route: 'POST /api/library/proposals',
    trigger: '用户在选型页点击检索/生成提案',
    data: [
      { field: 'requirement', source: '用户输入的选型需求文本' },
      { field: 'queries', source: '关键词/料号检索词（发往 EDA 库检索接口，不是 AI provider；如实标注）' },
    ],
    excluded: ['API Key / 登录令牌', '工程文件字节', '本机绝对路径'],
  },
]);

export function providerEgressManifest() {
  return {
    schemaVersion: 1,
    policyVersion: PROVIDER_EGRESS_POLICY_VERSION,
    consentMode: 'per-action',
    consentNote: '没有后台自动上传路径：每次外发都由用户显式触发（点发送/生成/检索）；运行时不批量上传工程文件。',
    orderEnabled: false,
    redaction: 'runtime/log-redaction.mjs（与日志/诊断包同一套：敏感键整值替换、Bearer/JWT/sk-/邮箱/本机路径擦除）',
    endpoints: ENDPOINTS.map((endpoint) => ({ ...endpoint, data: [...endpoint.data], excluded: [...endpoint.excluded] })),
    notSent: ['API Key/令牌原文', '工程文件字节（Gerber/STEP/DRC 报告文件本体）', '批准令牌/哈希链私钥材料', '本机绝对路径（外发前脱敏）'],
    boundaries: [
      '清单是人工维护的接口契约：新增调用 AI provider 的路由必须同步更新（测试会断言现有路由集合）。',
      '脱敏按键名/模式识别，不能保证 100% 语义去敏；上传的文本/图片附件按用户选择原样发送。',
      '本模块只做告知与预览，不改变任何发送行为，也不提供"关闭外发"的静默后台开关。',
    ],
  };
}

/** 脱敏预览：输入将要外发的载荷，返回脱敏后的 JSON 与是否发生变化。 */
export function previewProviderEgress(payload) {
  if (payload === undefined) {
    throw Object.assign(new Error('payload 不能为空：请提供将要外发的载荷用于预览'), { code: 'PROVIDER_EGRESS_PREVIEW_INVALID', status: 400 });
  }
  const sanitized = redactSecrets(payload);
  let serialized;
  try {
    serialized = JSON.stringify(sanitized, null, 2);
  } catch (error) {
    throw Object.assign(new Error(`载荷无法序列化，不能预览：${error?.message || error}`), { code: 'PROVIDER_EGRESS_PREVIEW_INVALID', status: 400 });
  }
  let originalSerialized = null;
  try { originalSerialized = JSON.stringify(payload, null, 2); } catch { originalSerialized = null; }
  return {
    ok: true,
    policyVersion: PROVIDER_EGRESS_POLICY_VERSION,
    // 原载荷不可序列化（循环/大对象）时无法逐字节比较：按"已处理"标记 changed=true，不假装没变。
    changed: originalSerialized === null ? true : serialized !== originalSerialized,
    bytes: Buffer.byteLength(serialized, 'utf8'),
    sanitized: JSON.parse(serialized),
    note: '预览与日志/诊断包使用同一套脱敏；changed=true 说明有字段/路径/密钥样式被擦除。',
  };
}
