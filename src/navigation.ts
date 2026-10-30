/**
 * D6：信息架构单一事实源。
 *
 * 为什么单独成模块：此前导航项写在 `Shell.tsx`、路由别名写在 `App.tsx`、页面职责写在页面里，
 * 三处各说各话，容易出现"导航能点但没人维护职责 / 路由能进但导航找不到"的遗留页面。
 * 这里用纯数据描述：导航项、页面职责、旧路由别名、新手完整链路；由测试守护一致性。
 * 页面组件只消费，不再各自定义一份。
 */
import type { PageId } from './types';

/** 侧边栏直接可见的页面（与 PageId 的子集一致）。 */
export type NavPage = Extract<PageId, 'overview' | 'design' | 'eda' | 'automation' | 'validation' | 'knowledge' | 'versions' | 'settings'>;

export type DesignTab = 'chat' | 'req' | 'select' | 'assets';
export type ValidationTab = 'verify' | 'placement' | 'rules' | 'verification' | 'knowledge';

export interface NavItem {
  id: NavPage;
  label: string;
  hint: string;
}

/** 主导航：顺序即用户默认工程顺序（概览 → 设计 → 执行 → 自动化 → 验证 → 追溯）。 */
export const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: '概览', hint: 'OVERVIEW' },
  { id: 'design', label: 'AI 设计', hint: 'CHAT · 需求 · 选型' },
  { id: 'eda', label: 'EDA 执行', hint: '受控写入' },
  { id: 'automation', label: '自动化', hint: '配方 · 批准 · 审计' },
  { id: 'validation', label: '验证与交付', hint: 'ERC / DRC / 输出' },
  { id: 'knowledge', label: '知识库', hint: 'RAG · 审核 · BADCASE' },
  { id: 'versions', label: '版本与问题', hint: 'TRACEABILITY' },
];

/**
 * 一级导航的常用子页快捷入口。
 *
 * 背景：D6 重构把「项目 / 需求约束 / 布局微调」并进了页签与概览入口，一级导航里
 * 看不到它们，用户找不到。这里不新增页面，只用数据描述"一级入口 → 已有页面/页签"，
 * 由 Shell 与测试共同消费（快照式断言，防止再次悄悄消失）。
 */
export interface NavShortcut {
  id: string;
  label: string;
  hint: string;
  page: PageId;
  tab?: DesignTab | ValidationTab;
}

export const NAV_SHORTCUTS: NavShortcut[] = [
  { id: 'projects', label: '项目与资料', hint: '新建 · 切换 · 归档', page: 'projects' },
  { id: 'requirements', label: '需求约束', hint: '可验证约束 · 冲突裁决', page: 'design', tab: 'req' },
  { id: 'placement', label: '布局微调', hint: '板框布局 · 数值微调', page: 'validation', tab: 'placement' },
];

/** 旧 hash/导航别名 → 规范化页面（历史书签继续可用，但不再新增别名）。 */
export const LEGACY_ALIASES: Record<string, { page: PageId; tab?: DesignTab | ValidationTab }> = {
  requirements: { page: 'design', tab: 'req' },
  assets: { page: 'design', tab: 'assets' },
  proposal: { page: 'design', tab: 'select' },
  ai: { page: 'design', tab: 'chat' },
  placement: { page: 'validation', tab: 'placement' },
};

/** 页面职责：每个 PageId（含旧页面别名）都必须有一条，写清"回答什么问题 / 主操作 / 交接给谁"。 */
export interface PageResponsibility {
  title: string;
  description: string;
  question: string;
  primaryAction: { label: string; page: PageId; tab?: DesignTab | ValidationTab };
  handoff: string;
}

export const PAGE_RESPONSIBILITIES: Record<PageId, PageResponsibility> = {
  overview: {
    title: '概览',
    description: '当前项目走到哪一步、下一步做什么、哪里在报错——一屏看清。',
    question: '我现在该做什么？',
    primaryAction: { label: '继续完善约束', page: 'design', tab: 'req' },
    handoff: '交接给「AI 设计」补输入，最终都要落到受控写入与验证。',
  },
  projects: {
    title: '项目与工程资料',
    description: '新建、切换、归档项目，维护工程目录与交付依据。',
    question: '我在为哪个项目干活？',
    primaryAction: { label: '打开当前项目', page: 'projects' },
    handoff: '项目切换会改变全局工作上下文；多项目隔离见 C6。',
  },
  design: {
    title: 'AI 设计',
    description: '用对话补齐设计输入，把需求变成可验证的约束与选型依据。',
    question: '需求/选型/原理图方案由什么证据支撑？',
    primaryAction: { label: '让 AI 追问补全', page: 'design', tab: 'chat' },
    handoff: '方案确定后交「EDA 执行」受控写入，写板前必须人工批准。',
  },
  requirements: {
    title: '需求约束（已并入 AI 设计 · 需求页签）',
    description: '受控约束的确认、冲突裁决与缺口收敛。',
    question: '每条约束是否可验证？',
    primaryAction: { label: '打开需求页签', page: 'design', tab: 'req' },
    handoff: '约束变化会标脏下游版本/批准（C4）。',
  },
  assets: {
    title: '元件与资料（已并入 AI 设计 · 资料页签）',
    description: 'BOM、器件与工程资料是否有证据、是否已批准。',
    question: '每个元件/资料是否可采购、可替代、有来源？',
    primaryAction: { label: '打开资料页签', page: 'design', tab: 'assets' },
    handoff: '选型批准后交原理图/PCB 受控写入。',
  },
  proposal: {
    title: '选型计划（已并入 AI 设计 · 选型页签）',
    description: '需求 → 真实候选 → 人工确认与批量落件（R3）。',
    question: 'BOM 草案从哪里来、谁批准的？',
    primaryAction: { label: '打开选型页签', page: 'design', tab: 'select' },
    handoff: '写板前必须签发一次性写批准（A6/R3）。',
  },
  ai: {
    title: 'AI 对话（已并入 AI 设计 · 对话页签）',
    description: '对话式设计入口：追问、任务、修复目标交接。',
    question: 'AI 在帮我推进哪件事、依据是什么？',
    primaryAction: { label: '打开对话页签', page: 'design', tab: 'chat' },
    handoff: 'AI 只选配方/填参数/诊断，不允许自由点击 EDA。',
  },
  eda: {
    title: 'EDA 执行',
    description: '在本机嘉立创 EDA 中完成受控写入：快照、批准、回读、DRC、可回滚。',
    question: '这次写入的批准、回读和回滚边界在哪里？',
    primaryAction: { label: '打开 EDA 执行', page: 'eda' },
    handoff: '结果与证据回流到验证/追溯页，写板不可绕过批准。',
  },
  automation: {
    title: '自动化',
    description: 'AI 选配方、填参数；API 优先/GUI 兜底；每步读回验证，写板批准一次一用。',
    question: '这条链路是否可重放、可诊断、可回滚？',
    primaryAction: { label: '打开自动化中心', page: 'automation' },
    handoff: '批量/跨文档动作优先走配方，而不是散点点击。',
  },
  validation: {
    title: '验证与交付',
    description: '统一运行电气与制造检查，收口问题后再生成交付物。',
    question: '能不能交付？缺哪份证据？',
    primaryAction: { label: '打开验证与交付', page: 'validation' },
    handoff: '问题进问题中心，可转修复任务回到 AI 设计。',
  },
  placement: {
    title: '布局与布线（已并入验证与交付 · 布局页签）',
    description: 'R4 布局写回、R5 布线写入与回滚，均走批准与回读。',
    question: '布局/布线写回的差异和回滚点是什么？',
    primaryAction: { label: '打开布局页签', page: 'validation', tab: 'placement' },
    handoff: '写入需一次性 write 批准；失败进问题中心。',
  },
  knowledge: {
    title: '知识库',
    description: '知识不是文档堆：条目可追溯、可审核、可失效；RAG 检索 + badcase + 定时维护。',
    question: '这条依据从哪来、谁审的、还能不能用？',
    primaryAction: { label: '打开知识库功能区', page: 'knowledge' },
    handoff: 'AI/采集器只产 candidate；approved 且未过期才能被门禁引用。',
  },
  versions: {
    title: '版本与问题',
    description: '快照对比、字段修改、审计事件、统一证据时间线与待处理问题。',
    question: '谁在什么时候改了什么、证据在哪？',
    primaryAction: { label: '打开版本与问题', page: 'versions' },
    handoff: '追溯只读；结论以 Runtime 账本/证据为准。导出/放行/签核在「验证与交付」页完成，本页只做证据核对与归档追溯。',
  },
  settings: {
    title: '系统设置',
    description: '配置 AI Provider、本机 Runtime 与安全策略。',
    question: 'AI 与 Runtime 是否连对、写入门禁是否合理？',
    primaryAction: { label: '打开系统设置', page: 'settings' },
    handoff: '密钥只进 keychain，日志/诊断包脱敏（C8）。',
  },
};

/** 新手从零到交付的完整链路；顺序与阶段机一致（需求→选型→原理图→PCB→验证→生产/归档）。 */
export interface GuidedStep {
  id: string;
  stage: string;
  label: string;
  description: string;
  page: PageId;
  tab?: DesignTab | ValidationTab;
}

export const GUIDED_FLOW: GuidedStep[] = [
  { id: 'requirements', stage: '需求', label: '① 需求约束', description: '把口语需求变成可验证的受控约束，冲突先裁决。', page: 'design', tab: 'req' },
  { id: 'selection', stage: '选型', label: '② 元件选型', description: '需求换真实候选，人工确认后写进当前项目。', page: 'design', tab: 'select' },
  { id: 'schematic', stage: '原理图', label: '③ 原理图方案', description: 'AI 生成/编辑方案，写板前先计划与批准。', page: 'design', tab: 'chat' },
  { id: 'eda-write', stage: '原理图', label: '④ 受控写入', description: '快照→批准→回读→可回滚；写板批准一次一用。', page: 'eda' },
  { id: 'pcb-place', stage: 'PCB', label: '⑤ 布局布线', description: 'R4 布局写回 / R5 布线写入，均带回滚点。', page: 'validation', tab: 'placement' },
  { id: 'verify', stage: '验证', label: '⑥ 验证检查', description: 'ERC/DRC/DFM 统一运行，问题进问题中心。', page: 'validation', tab: 'verify' },
  // ⑦ 必须是「交付」而不是「追溯」：导出/放行/签核/归档的实际操作按钮都在「验证与交付」页，
  // 而「版本与问题」页只做证据时间线/变更/发布归档的核对（只读为主）。旧版把 ⑦ 指向 versions，
  // 导致按新手链路走到最后找不到交付入口（前端与全流程操作不一致），这里拆成 ⑦ 交付 + ⑧ 追溯。
  { id: 'deliver', stage: '生产', label: '⑦ 交付导出', description: '在验证与交付页跑放行闸门、导出制造包（未过门禁只能出草稿）、登记签核与下单参数。', page: 'validation', tab: 'verify' },
  { id: 'archive', stage: '归档', label: '⑧ 追溯归档', description: '在版本与问题页核对证据时间线/变更记录/发布归档，归档前不缺证据。', page: 'versions' },
];

/**
 * 规范页面集合：主导航 6 项 + 系统设置 + 项目页（项目页现在既可从项目卡/概览进入，也有一级快捷入口）。
 * 旧页面别名不在此集合里；它们必须解析到这里的页面。
 */
export const CANONICAL_PAGES: PageId[] = [...NAV_ITEMS.map((item) => item.id), 'settings', 'projects'];

/** 旧别名必须全部落到规范页面上（测试守护，防止一个别名指回自己造成死循环）。 */
export function resolveAlias(hash: string): { page: PageId; tab?: DesignTab | ValidationTab } | null {
  const alias = LEGACY_ALIASES[hash];
  if (!alias) return null;
  return alias;
}

export const DESIGN_TABS: DesignTab[] = ['chat', 'req', 'select', 'assets'];
export const VALIDATION_TABS: ValidationTab[] = ['verify', 'placement', 'rules', 'verification', 'knowledge'];
