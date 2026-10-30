# 05 · UI 动作接线矩阵

> 范围：`src/App.tsx` 出发的全部可达路由（9 个 canonical + 9 个页签组合）、`src/pages/*`、`src/components/*`、`src/services/runtimeClient.ts`。
> 方法：静态穷举 `<Button>/<button>/onClick/onSubmit/hash 跳转` → 处理函数 → `runtimeClient.*` → `runtime/server.mjs` 路由（路径 + method），再用 grep 交叉核对「client 方法有无消费者 / 路由有无 client」。未启动 4177/4178，不做真机验证。

## 0. 结论

1. **共抽取 154 个交互/数据动作：A 类 90、B 类 22、C 类 36、D 类 1、E 类 5、F 类 0**（G 不单列，作为「本地独立状态源」标注在 B/E 行说明，至少 4 处：settings、boards、task/validations、edaWorkspaceStore）；Runtime 真接线率约 58%，其余多为导航与本地实现，但**「验证与交付」页签存在一条完整的 Demo 假通过链路**。
2. **最严重的断点不在接线，而在「来源标注止步于动作」**：`ValidationPage.tsx:295-325` 的「运行全部检查」走 `demoAdapter`，调用点确实打 `source='demo'`（`:300`）并给了免责 toast（`:301`）——但下游汇总不按 source 过滤：`OverviewPage.tsx:22-24` 只按 `status==='pass'` 计数、`DeliverPage.tsx:21,31` 与 `ValidationPage.tsx:293,1158` 同理，`seed.ts:114-123` 还预置了 3 pass/3 warn/2 idle → 首次打开即显示 75% 覆盖率、3/8 通过，Demo 通过直接计入「已验证」。真实 ERC/DRC（`ValidationPage.tsx:522`、`:357`）只写组件内 state，从不回写。
3. **阶段机「验证→生产」是死门禁**：`stageEvidence.ts:43-44` 要求 DRC 结果 `source==='official'`，但全仓无任何代码写入该值（仅 `types.ts:667` 定义）→ `ProjectsPage.tsx:100` 推进阶段必被阻断；而真实 DRC 证据只存在于 `/api/eda/pcb/drc/*` 响应里。
4. **跨页交接基本真的接通了**：`draftStore`（AI 页/选型页 → EDA 页，`EdaPage.tsx:142,159` 读取）、`fixTask`（验证/版本页 → `AiTasksPage.tsx:84` 消费）、`stageEvidence`（EDA/布局执行后自动推进）均有消费者；但 `state.task`/`state.validations`/`state.settings` 不在持久化载荷里，只活 localStorage（G）。
5. **路由无死链**：5 个 `LEGACY_ALIASES` 全部解析到 canonical 页，`navigate('ai'/'requirements'/'assets')` 靠别名兜底仍可用；但 D6 单一事实源迁移未收尾（6 处调用仍在用旧 id）。
6. **无消费者 client 方法 9 个**（生产放行/终审签核/发布版本详情/项目列表等），另有约 20 条 server 路由既无 client 也无 UI —— 能力有、入口无（见 §4）。

## 1. 可达路由与页面树

| 路由 | 页面组件 | 页签/子页 | 证据 |
|---|---|---|---|
| `#overview` | OverviewPage | — | App.tsx:79 |
| `#projects` | ProjectsPage（一级快捷入口 + 概览入口） | — | App.tsx:80, navigation.ts:50 |
| `#design/chat` | DesignPage → AiTasksPage | AI 对话（默认） | App.tsx:81, DesignPage.tsx:41 |
| `#design/req` | DesignPage → RequirementsPage | 需求约束 | DesignPage.tsx:42 |
| `#design/select` | DesignPage → PartProposalPage | 元件选型 | DesignPage.tsx:43 |
| `#design/assets` | DesignPage → AssetsPage | 资料与 BOM | DesignPage.tsx:44 |
| `#eda` | ExecutionPage → EdaPage（+LongTaskPanel/LayerStackPanel） | 受控执行 | App.tsx:82, ExecutionPage.tsx:34 |
| `#automation` | AutomationPage | — | App.tsx:83 |
| `#validation/verify` | DeliverPage → ValidationPage | 检查与问题（默认） | App.tsx:84, DeliverPage.tsx:38 |
| `#validation/placement` | DeliverPage → PlacementPage（+RoutingWritePanel） | 布局微调 | DeliverPage.tsx:38, PlacementPage.tsx:394 |
| `#validation/rules` | DeliverPage → RuleCenterPage | 规则中心 | DeliverPage.tsx:38 |
| `#validation/verification` | DeliverPage → VerificationCenterPage | 验证中心（门禁） | DeliverPage.tsx:38 |
| `#validation/knowledge` | DeliverPage → KnowledgePage | 知识库（与 #knowledge 重复） | DeliverPage.tsx:10-16 |
| `#knowledge` | KnowledgePage | — | App.tsx:85 |
| `#versions` | VersionsPage | — | App.tsx:86 |
| `#settings` | SettingsPage（+CustomProviderEditor） | — | App.tsx:87, SettingsPage.tsx:318 |
| 旧别名 | `requirements→design/req`、`assets→design/assets`、`proposal→design/select`、`ai→design/chat`、`placement→validation/placement` | 全部可解析，无死链 | navigation.ts:56-62, App.tsx:32-33 |
| 壳层 | Shell（7 主导航 + 3 快捷入口 + ⌘K 面板） | — | Shell.tsx:104-132, 65-71 |

## 2. 接线矩阵

判定：A 真调用且路由存在 ｜ B 只改本地 state/dispatch 并提示成功 ｜ C 只导航/本地派生/只读展示 ｜ D no-op/占位 ｜ E demo/seed 冒充 ｜ F 路由不存在 ｜ G 本地独立状态源（与 Runtime 权威副本并存）

| # | 路由 | 动作 label | 处理函数 file:line | 目标 API / 方法（server.mjs:line） | 判定 | 问题说明 |
|---|---|---|---|---|---|---|
| 1 | 全局 | 主导航 7 项 | Shell.tsx:112 → AppContext.tsx:498 | —（hash 路由） | C | 解析 App.tsx:34-37 |
| 2 | 全局 | 快捷入口（项目/需求约束/布局微调） | Shell.tsx:128 | — | C | NAV_SHORTCUTS navigation.ts:49-53 |
| 3 | 全局 | ⌘K 快速指令 | Shell.tsx:54-71,159 | — | C | 命令全部 navigate |
| 4 | 全局 | 页头「最后保存 HH:mm」 | Shell.tsx:172 | — | C | 取浏览器当前时间，非 Runtime 保存时间（P2） |
| 5 | 全局 | 模式徽标 DEMO/受控写入/写入暂停 | Shell.tsx:34-39,44 | GET /api/health (1366) | C | 只读 state.runtime.mode；「写入暂停」来自前端 state.eda.writePaused |
| 6 | 全局 | 旧 hash 别名 | navigation.ts:56-62 / App.tsx:32 | — | C | 5 个别名都落到 canonical 页 |
| 7 | #overview | 主 CTA（继续完善约束） | OverviewPage.tsx:83 | — | C | primary.hash |
| 8 | #overview | 和 AI 继续聊 / 版本与审计 | OverviewPage.tsx:84-85 | — | C | hash 跳转 |
| 9 | #overview | 决策卡 CTA（冲突/建议/问题/验证） | OverviewPage.tsx:122 | — | C | action 为 design/req、versions、validation |
| 10 | #overview | 全部问题 | OverviewPage.tsx:114 | — | C | navigate('versions') |
| 11 | #overview | 完整链路 8 步 / 快速入口 5 卡 | OverviewPage.tsx:177,187-191 | — | C | GUIDED_FLOW navigation.ts:184-196 |
| 12 | #overview | 页面统计（验证通过/风险/进度） | OverviewPage.tsx:22-28 | — | E | 计数只按 status，不按 source；首次加载即 3 pass/3 warn（seed.ts:114-123），非 Runtime 证据（P0-1） |
| 13 | #projects | 新建项目 | ProjectsPage.tsx:58 | PUT /api/project-state (1395)（AppContext.tsx:395-408 防抖落盘） | B | 无 Runtime 项目创建领域 API |
| 14 | #projects | 保存更改 | ProjectsPage.tsx:72 | 同上 | B | 同上 |
| 15 | #projects | 推进阶段 | ProjectsPage.tsx:100 | — | B | 仅 stageMachine 本地门禁；Runtime 无阶段 API（前端即权威，P1） |
| 16 | #projects | 设为当前工作项目 | ProjectsPage.tsx:182(inline) | GET /api/projects/:id/state (1415) | B | 选择本身只 dispatch；随后拉项目切面 |
| 17 | #projects | 恢复 / 归档 | ProjectsPage.tsx:141 | PUT /api/project-state (1395) | B | 自动落盘 |
| 18 | #projects | 删除项目 | ProjectsPage.tsx:151 | DELETE /api/chat/sessions/:id (3781) | A | 会话删除真调用；项目数据本身只本地删 |
| 19 | #projects | 继续完善约束 | ProjectsPage.tsx:172 | — | C | 用旧别名 navigate('requirements')（P2） |
| 20 | #projects | 校验当前 EDA 绑定 | ProjectsPage.tsx:83 | GET /api/projects/:id/binding/verify (1430) | A | 真读取，防止跨项目签发批准 |
| 21 | #design/chat | 发送 / 重试 | AiTasksPage.tsx:239,360 | POST /api/chat/sessions/:id/messages (3771) | A | 无 |
| 22 | #design/chat | 新建对话 | AiTasksPage.tsx:324 | DELETE /api/chat/sessions/:id (3781) | A | 只清 Runtime transcript |
| 23 | #design/chat | 会话状态/历史列表/载入历史 | AiTasksPage.tsx:93-103,131,136 | GET /api/chat/status (3769)、/api/chat/sessions (3776)、transcript (3778) | A | localStorage 仅 UI 缓存（AiTasksPage.tsx:107 注释） |
| 24 | #design/chat | 快速提示 / 语音输入 / 上传附件 | AiTasksPage.tsx:356,365,154 | — | C | 本地 input 与浏览器 API |
| 25 | #design/chat | 接受/拒绝需求建议 | AiTasksPage.tsx:292 | PUT /api/project-state (1395) | B | 只改 requirements；无 Runtime 约束校验 API |
| 26 | #design/chat | 确认写入当前项目BOM | AiTasksPage.tsx:303 | PUT /api/project-state (1395) | B | 只改本地 components，无 BOM 写入 API |
| 27 | #design/chat | 生成可验证 PCBA 语义计划 | AiTasksPage.tsx:191 | POST /api/production/plans/ai (3604) | A | 真长任务，失败/超时有独立措辞 |
| 28 | #design/chat | 进入 EDA 编译与审批 | AiTasksPage.tsx:225 | —（sessionStorage→EdaPage.tsx:142） | C | 交接被消费：EdaPage 读 readSemanticPlanDraft |
| 29 | #design/chat | 忽略校验修复 / 项目切换 | AiTasksPage.tsx:233,180 | — | B | 清/切本地 task、chat 切面 |
| 30 | #design/chat | 取消/重试长任务 | LongTaskPanel.tsx:48-49 | — | C | 只停本页等待 |
| 31 | #design/req | 新增约束 / 保存并确认 / 解决冲突 | RequirementsPage.tsx:27,22 | PUT /api/project-state (1395) | B | 自动落盘，但无 Runtime 约束语义接口 |
| 32 | #design/req | 设计输入完整度 / 需求表 | RequirementsPage.tsx:36-39 | — | C | 只读 state |
| 33 | #design/req | 页签切换 | DesignPage.tsx:26-33 | — | C | hash design/req |
| 34 | #design/select | 生成候选提案 | PartProposalPage.tsx:61 | POST /api/library/proposals (3637) | A | 长任务 |
| 35 | #design/select | 勾选 / 改数量 | PartProposalPage.tsx:83,90 | — | C | 本地选择 |
| 36 | #design/select | 落入计划 | PartProposalPage.tsx:95 | POST /api/library/proposals/plan (3667) | A | 标签易误解：只产出计划，不写项目 BOM（P2） |
| 37 | #design/select | 送到设计批准（EDA 页） | PartProposalPage.tsx:110 | —（sessionStorage→EdaPage.tsx:159） | C | 交接被消费：readSchematicPlanDraft |
| 38 | #design/select | 生成 dry-run 计划 / 签发写板批准并执行 | PartProposalPage.tsx:130,151 | POST /api/eda/schematic/component-batch (2106) + POST /api/automation/approvals (3444) | A | 批量落件真写图 |
| 39 | #design/assets | 上传资料 | AssetsPage.tsx:34 | — | E | 仅本地元数据；AssetsPage.tsx:180 明示 Demo |
| 40 | #design/assets | 下载带标记的 CSV | AssetsPage.tsx:42 | — | E | downloadDemoFile，DEMO ONLY 文案 |
| 41 | #design/assets | 设为正式依据 / 移除 / 关联AI任务 | AssetsPage.tsx:179(inline) | PUT /api/project-state (1395) | B | 只改 assets 数组 |
| 42 | #design/assets | 关联当前 EDA 项目 | AssetsPage.tsx:118 | POST /api/eda/commands/:id (1721) | A | 通过固定命令执行 |
| 43 | #design/assets | 嘉立创EDA搜索 | AssetsPage.tsx:99 | POST /api/eda/library/devices/search (3101) | A | 真检索 |
| 44 | #design/assets | 确认绑定器件 | AssetsPage.tsx:110 | — | B | 只改本地 easyEdaBinding 字段 |
| 45 | #design/assets | 批准替代料 | AssetsPage.tsx:41 | — | B | 本地状态 + 审计 |
| 46 | #design/assets | 生产资料检查 / readiness 复核 | AssetsPage.tsx:43,57 | POST /api/production/artifacts/inspect (3673) + /api/production/readiness (3676) | A | 无 |
| 47 | #eda | 新建 EDA 文件 | EdaPage.tsx:174 | POST /api/eda/workspaces (3321) + GET /api/pcb/context (3215) | A | 真建工程 |
| 48 | #eda | 绑定当前 EDA 设计 | EdaPage.tsx:190 | GET /api/eda/workspaces/current (3336) | A | 只读 + 本地落绑定；Runtime 无绑定写回（P2） |
| 49 | #eda | 读取当前 PCB / 打开 PCB 编辑器 | EdaPage.tsx:428,440 | GET /api/pcb/context (3215) / POST /api/eda/commands/pcb.open (1721) | A | 无 |
| 50 | #eda | 在嘉立创EDA中查看 | EdaPage.tsx:169 | POST /api/eda/app/focus (3310) | A | 无 |
| 51 | #eda | 生成可审核设计方案 | EdaPage.tsx:202 | POST /api/production/plans/ai (3604) | A | 无 |
| 52 | #eda | 确认方案并准备执行 | EdaPage.tsx:215 | POST /api/production/plans/compile (3601) + POST /api/pcb/plan (3352) | A | 编译失败即阻断 |
| 53 | #eda | 3. 同步原理图到 PCB | EdaPage.tsx:231 | POST /api/eda/commands/pcb.open (1721) + /api/pcb/plan (3352) + /api/app/focus (3316) | A | 无 |
| 54 | #eda | 重连 / 运行全量检查 | EdaPage.tsx:271 | GET /api/eda/discover (1709) + /api/eda/windows (1713) + /api/pcb/capabilities (3213) + /api/eda/version/adaptation (3195) | A | Runtime 不可达时降级 demoAdapter.checkEnvironment（EdaPage.tsx:274，E，有「Demo检查完成」文案） |
| 55 | #eda | 断开 | EdaPage.tsx:308 | — | B | 只清本地 state，Bridge 会话仍在（无 disconnect 路由，P1） |
| 56 | #eda | PCB 五步（读取/编译/校验/批准/执行） | EdaPage.tsx:428,450,460,470,482 | GET /api/pcb/context (3215)、POST /api/pcb/fixtures/ch32v003/compile (3355)、/pcb/plan (3352)、/pcb/approve (3358)、/pcb/execute (3361) | A | 批准/执行绑定一次性令牌 |
| 57 | #eda | 1. AI 生成网络表草案 | EdaPage.tsx:340 | POST /api/eda/pins/evidence (2287) + POST /api/design/netlist/ai (3129) | A | 无 |
| 58 | #eda | 2. 打开关联原理图 / 读取当前原理图 | EdaPage.tsx:322,315 | POST /api/eda/schematic/open-current (3110) + GET /api/design/context (3108) | A | 无 |
| 59 | #eda | 3. 校验计划 | EdaPage.tsx:333 | POST /api/design/plan (3120) | A | 无 |
| 60 | #eda | 4. 人工批准 | EdaPage.tsx:376 | POST /api/design/approve (3163) | A | 批准绑定 targetFingerprint |
| 61 | #eda | 5. 生成原理图 | EdaPage.tsx:411 | POST /api/design/execute (3172) | A | 门禁未过时按钮 disabled |
| 62 | #eda | 刷新历史 / 查看事件 | EdaPage.tsx:384,402 | GET /api/design/executions (3176) + /api/pcb/executions (3178) + :id (3180/3190) | A | 无 |
| 63 | #eda | 运行（命令日志） | EdaPage.tsx:504 | POST /api/eda/commands/:id (1721) | A | Demo 会话走 demoAdapter.executeCommand（EdaPage.tsx:510，E，有 Demo 文案） |
| 64 | #eda | 复制结构化日志 | EdaPage.tsx:614(inline) | — | C | clipboard |
| 65 | #eda | 叠层：读取 / 签发批准设置层数 | LayerStackPanel.tsx:56,89-90 | GET /api/eda/pcb/layers (2506) + POST /api/automation/approvals (3444) + POST /api/eda/pcb/layers (2523) | A | 无 |
| 66 | #eda | 高级控制折叠 | EdaPage.tsx:559 | — | C | 纯 UI |
| 67 | #automation | 刷新配方 | AutomationPage.tsx:77 | GET /api/automation/recipes (3441) + /api/automation/approvals (3444) | A | 无 |
| 68 | #automation | 签发批准 | AutomationPage.tsx:170 | POST /api/automation/approvals (3444) | A | 人工点击签发 |
| 69 | #automation | 运行配方 | AutomationPage.tsx:200 | POST /api/automation/run (3480) + GET /api/automation/runs/:id (3593) | A | 长任务 |
| 70 | #automation | 中止运行 | AutomationPage.tsx:186 | POST /api/automation/runs/:id/abort (3571) | A | 无 |
| 71 | #automation | 扫描中断运行 | AutomationPage.tsx:135 | GET /api/automation/recovery (3475) | A | 无 |
| 72 | #automation | 安全重放 | AutomationPage.tsx:147 | POST /api/automation/runs/:id/replay (3538) | A | 无 |
| 73 | #automation | 探测两种窗口尺寸 | AutomationPage.tsx:234 | POST /api/eda/gui/capabilities/probe (3391) | A | 无 |
| 74 | #automation | 生成配方序列 / 获取恢复建议 | AutomationPage.tsx:107,121 | POST /api/automation/orchestration/plan (3459) + /failure (3467) | A | 无 |
| 75 | #automation | 查看哈希链审计 / 写步骤审计包 | AutomationPage.tsx:93,257 | GET /api/automation/runs/:id/audit-bundle (3582) + runs/:id (3593) | A | 无 |
| 76 | #validation/verify | 运行全部检查 / 运行选中检查 | ValidationPage.tsx:295,310 | — | E | demoAdapter.runValidations（:298、:314），source='demo' 写回 state.validations（:300，有免责 toast :301）；无任何 /api 请求（P0） |
| 77 | #validation/verify | 在 EDA 中定位 | ValidationPage.tsx:326 | — | D | 只 notify「已发送定位请求」，无 API（P2） |
| 78 | #validation/verify | 创建 AI 修复任务（清单） | ValidationPage.tsx:327 | — | B | PATCH_TASK + navigate('ai')；被 AiTasksPage.tsx:84 消费，但 task 不落 Runtime |
| 79 | #validation/verify | 运行 / 载入 / 取消 PCB DRC | ValidationPage.tsx:357,334,413 | POST /api/eda/pcb/drc/start (2619) + /report (2642) + GET latest (2680) + POST cancel (2630) | A | 结果只存组件 state，不回写全局（P0-2） |
| 80 | #validation/verify | DRC 豁免载入/生成草稿/保存/删除 | ValidationPage.tsx:442,458,482,477 | GET /api/eda/pcb/drc/exemptions (2673) + PUT (2675) | A | 行内增删仅本地，保存才写 |
| 81 | #validation/verify | 填入下方闸门 | ValidationPage.tsx:1247,1257 | — | C | 本地 state |
| 82 | #validation/verify | 运行 / 载入 ERC 取证 | ValidationPage.tsx:522,544 | POST /api/eda/schematic/erc/run (2684) + GET latest (2736) | A | 同样不回写全局（P0-2） |
| 83 | #validation/verify | 载入 / 保存 ERC 豁免 | ValidationPage.tsx:554,566 | GET /api/eda/schematic/erc/exemptions (2738) + PUT (2740) | A | 无 |
| 84 | #validation/verify | 从 ERC 建议建修复任务 / 生成豁免草稿 | ValidationPage.tsx:581,597 | — | B | SET_TASK 本地 + 审计；草稿仅本地 |
| 85 | #validation/verify | 运行 / 载入仿真 | ValidationPage.tsx:611,627 | POST /api/eda/schematic/simulation/run (2889) + GET latest (2959) | A | 无 |
| 86 | #validation/verify | 采集引脚证据 / 引脚两阶段计划 | ValidationPage.tsx:637,649 | POST /api/eda/pins/evidence (2287) + POST /api/automation/flows/pin-first-netlist (3156) | A | 无 |
| 87 | #validation/verify | 原理图验收 | ValidationPage.tsx:661 | POST /api/eda/schematic/acceptance (2961) | A | 长任务 |
| 88 | #validation/verify | 载入 DFM/签核/订单确认证据 | ValidationPage.tsx:685 | GET dfm-evidence/latest (2783) + signoff/latest (2886) + order-confirmation/latest (2780) | A | 无 |
| 89 | #validation/verify | 保存 DFM 证据 / 记录三方签核 / 保存下单确认 | ValidationPage.tsx:700,740,721 | POST dfm-evidence (2746) + signoff (2786) + order-confirmation (2765) | A | demo 模式下按钮 disabled |
| 90 | #validation/verify | 手工豁免验证问题 | ValidationPage.tsx:774 | — | B | 只 dispatch UPDATE_VALIDATION；真实豁免在 /api/eda/.../exemptions（双口径，P0-2） |
| 91 | #validation/verify | 工程分析 | ValidationPage.tsx:780 | POST /api/engineering/analyze (3763) | A | 无 |
| 92 | #validation/verify | 刷新供应链定价 / 选型兜底 / 查替代料 | ValidationPage.tsx:799,817,833 | POST /api/supply/pricing (3608) + /api/eda/library/search/fallback (3093) + /api/supply/alternatives (3619) | A | 无 |
| 93 | #validation/verify | 读取批准账本 | ValidationPage.tsx:853 | GET /api/approvals/ledger (3787) | A | 无 |
| 94 | #validation/verify | 归档发布版本 | ValidationPage.tsx:882 | POST /api/production/releases/archive (1756) + GET releases (1790) | A | 无 |
| 95 | #validation/verify | 导出制造包 / 下载产物 / 下载清单 | ValidationPage.tsx:909,965,983 | POST /api/production/export (1798) + GET /api/production/download (1796) | A | 清单 CSV 为本地派生（数据来自真实 exportResult） |
| 96 | #validation/verify | 下单卡 | ValidationPage.tsx:1011 | POST /api/production/order-card (2145) | A | 无 |
| 97 | #validation/verify | PCB 同步验收 | ValidationPage.tsx:1041 | GET /api/pcb/sync/verify (3221) | A | 无 |
| 98 | #validation/verify | 原理图自动修复（预演/执行） | ValidationPage.tsx:1055 | POST /api/eda/schematic/repair (1890) | A | 长任务 |
| 99 | #validation/verify | 下单前放行闸门 | ValidationPage.tsx:1101 | POST /api/eda/release/gate (1732) | A | 无 |
| 100 | #validation/verify | 3D 导出 | ValidationPage.tsx:423 | POST /api/pcb/3d/export (3250) | A | 无 |
| 101 | #validation/verify | 刷新 Bridge 状态 | ValidationPage.tsx:498 | GET /api/eda/discover (1709) + /api/eda/windows (1713) | A | 无 |
| 102 | #validation/verify | 去布局微调 / 打开 EDA 控制页 | ValidationPage.tsx:1688 | — | C | hash 跳转 |
| 103 | #validation/verify | 选中检查卡片 / 处理 | ValidationPage.tsx:2156 | — | C | 本地选中 |
| 104 | #validation/placement | 读取板框并自动布局 | PlacementPage.tsx:77 | POST /api/eda/pcb/placement/plan (2200) | A | 无 |
| 105 | #validation/placement | 插入模板 / 清空 / 解析设计意图 | PlacementPage.tsx:192,193,62 | — | C | 本地文本 |
| 106 | #validation/placement | 预演写回 | PlacementPage.tsx:95 | POST /api/eda/pcb/placement/apply (2262) | A | 无 |
| 107 | #validation/placement | 执行写回 / 确认写回 | PlacementPage.tsx:110 | POST /api/eda/pcb/placement/apply (2262) + 证据 patch → PUT /api/project-state (1395) | A | 写回成功后写 stageEvidence（:130-132） |
| 108 | #validation/placement | 还原到原位置 | PlacementPage.tsx:145 | POST /api/eda/pcb/placement/apply (2262) | A | 走回滚恢复 |
| 109 | #validation/placement | 请求/签发写板批准 | PlacementPage.tsx:56 | POST /api/automation/approvals (3444) | A | 无 |
| 110 | #validation/placement | 断网规划/预演/写入/收尾/回滚 | RoutingWritePanel.tsx:53,80,98,155,123 | POST routing/plan (2321) + /apply (2361) + /rollback (2382) + /finish (2392) + GET /pours (2500) + approvals (3444) | A | 无 |
| 111 | #validation/placement | 布局页签 | DeliverPage.tsx:30 | — | C | hash validation/placement |
| 112 | #validation/rules | 运行夹具审计 / 自定义 JSON 审计 | RuleCenterPage.tsx:56,66 | POST /api/engineering/layout-rules/audit (3696) | A | 无 |
| 113 | #validation/rules | 加载规则包 | RuleCenterPage.tsx:44 | GET /api/engineering/layout-rules (3693) | A | 无 |
| 114 | #validation/rules | 自定义输入展开 / 清空 | RuleCenterPage.tsx:103,139 | — | C | 本地文本 |
| 115 | #validation/verification | 重新读取门禁状态 | VerificationCenterPage.tsx:52 | GET /api/eda/gates/status (1541) | A | 无 |
| 116 | #validation/verification | 评估并归档报告 | VerificationCenterPage.tsx:52 | POST /api/eda/gates/evaluate (1543) | A | 无 |
| 117 | #validation/verification | 签字放行 / 驳回 | VerificationCenterPage.tsx:88 | POST /api/eda/gates/signoff (1547) | A | only pass 可放行 |
| 118 | #validation/verification | 批准账本 | VerificationCenterPage.tsx:95 | GET /api/eda/gates/approvals (1551) | A | 无 |
| 119 | #validation/verification | 绑定这块板 / 移除当前板 | VerificationCenterPage.tsx:71,78 | — | B | 只写 localStorage `circuitpilot.boards.v1`（:10,43-45），Runtime 无板列表（G） |
| 120 | #validation/verification | 选择板 chip | VerificationCenterPage.tsx:103 | — | C | 本地 selectedId |
| 121 | #knowledge 与 #validation/knowledge | 刷新（健康/队列/agent/RAG） | KnowledgePage.tsx:49 | GET /api/knowledge/health (1573) + review-queue (1571) + agent/status (1582) + /api/rag/status (1594) | A | 同一组件两个路由入口（P2） |
| 122 | 同上 | 检索知识 | KnowledgePage.tsx:65 | GET /api/knowledge/entries (1553) | A | 无 |
| 123 | 同上 | 通过 / 驳回审核 | KnowledgePage.tsx:72 | POST /api/knowledge/entries/:id/review (1566) | A | 无 |
| 124 | 同上 | 重建索引 | KnowledgePage.tsx:82 | POST /api/rag/reindex (1596) + GET status (1594) | A | 无 |
| 125 | 同上 | RAG 检索 | KnowledgePage.tsx:90 | POST /api/rag/query (1600) | A | 无 |
| 126 | 同上 | 采集 badcase / 网页 / 维护 / 全部 | KnowledgePage.tsx:98 | POST /api/knowledge/agent/run (1584) | A | 无 |
| 127 | 同上 | badcase 列表 | KnowledgePage.tsx:109 | GET /api/knowledge/badcases (1607) | A | 无 |
| 128 | 同上 | 提交候选 | KnowledgePage.tsx:116 | POST /api/knowledge/entries (1562) | A | 无 |
| 129 | 同上 | 检测冲突 | KnowledgePage.tsx:128 | GET /api/knowledge/conflicts (1575) | A | 无 |
| 130 | #versions | 创建手动快照 | VersionsPage.tsx:180 | PUT /api/trace-state (1388)（AppContext.tsx:455） | B | 只改本地 versions 数组 |
| 131 | #versions | 回滚 / 回滚到此版本 | VersionsPage.tsx:185 | — | E | 只本地追加一条「Demo 回滚已记录」，无任何回滚 API |
| 132 | #versions | 诊断包 / 工程评审包 | VersionsPage.tsx:154 | — | C | 本地文件，数据来自 state 与真实 /api/events |
| 133 | #versions | 查看差异 / 详情 | VersionsPage.tsx:(inline) | — | C | 本地 drawer |
| 134 | #versions | 标记处理中 / 解决 / 重新打开 / 忽略 | VersionsPage.tsx:208 | PUT /api/issue-state (1381)（AppContext.tsx:446） | B | 无 Runtime 问题处理 API |
| 135 | #versions | 建修复任务 | VersionsPage.tsx:198 | — | B | SET_TASK → AiTasksPage.tsx:84 消费；task 不在持久化载荷（G，P2） |
| 136 | #versions | 前往来源 | VersionsPage.tsx:212 | — | C | 映射 canonical 页；runtime repair.page 值均在 PageId 内，无死链 |
| 137 | #versions | 加载时间线 | VersionsPage.tsx:101 | POST /api/timeline (1475) | A | 无 |
| 138 | #versions | 刷新事件 | VersionsPage.tsx:61 | GET /api/events (3785) | A | 无 |
| 139 | #versions | 导出运行事件 JSON | VersionsPage.tsx:154 | — | C | 本地导出已加载真实事件 |
| 140 | #versions | 关联到该运行 | VersionsPage.tsx:88 | POST /api/timeline/link (1487) | A | 无 |
| 141 | #versions | 证据索引 / 查找 / 保留计划 | VersionsPage.tsx:112,126,140 | GET /api/evidence/index (2818) + /api/evidence/find (2822) + POST retention plan (2830/2859) | A | 无 |
| 142 | #versions | 读取发布版本 | VersionsPage.tsx:72 | GET /api/production/releases (1790) | A | 详情 GET /releases/:id 有路由无 UI（§4） |
| 143 | #versions | 复制诊断 | VersionsPage.tsx:(inline) | — | C | clipboard |
| 144 | #settings | 刷新本机状态 | SettingsPage.tsx:110 | GET /api/health (1366) + /api/providers (1627) + /api/diagnostics (1525) | A | 无 |
| 145 | #settings | 官方登录 / 保存 Key / 撤销 / 测试 / 控制台 | SettingsPage.tsx:163,183,204,211,191 | POST providers/:id/login (1679) /key (1683) DELETE (1691) /test (1696) /console (1704) | A | demo provider 测试走 demoAdapter（:215，E，有文案） |
| 146 | #settings | 自定义 Provider 保存/删Key/删除/探测/测试 | CustomProviderEditor.tsx:243,305,377,318,345 | PUT/DELETE /api/custom-providers/:id (1636/1650) + /models (1665) + providers key/test | A | 无 |
| 147 | #settings | 保存设置（Provider/模型/写入暂停） | SettingsPage.tsx:277 | — | B | 只 SET_SETTINGS + localStorage；无 /api/config 类路由（G，P1） |
| 148 | #settings | 重置本地数据 | SettingsPage.tsx:410 | — | B | resetDemo 仅本地 |
| 149 | #settings | 导出脱敏诊断包 | SettingsPage.tsx:142 | GET /api/diagnostics/bundle (1503) | A | 无 |
| 150 | #settings | 研究检索测试 | SettingsPage.tsx:256 | POST /api/research/search (1609) | A | allowResearch 显式放行 |
| 151 | #settings | 出口策略读取 / 预览 | SettingsPage.tsx:222,236 | GET /api/provider/egress (1534) + POST /preview (1537) | A | 无 |
| 152 | #settings | 撤销 / 保存（dirty 态） | SettingsPage.tsx:412 | — | C | 本地表单 |
| 153 | #settings | 页签切换 | SettingsPage.tsx:305 | — | C | 本地 providerTab |
| 154 | 全局 | 复制按钮（Toast/代码块） | components/ui.tsx:128-150 | — | C | navigator.clipboard |

## 3. 问题清单

### P0（阻断交付判断 / 假通过）

1. **「运行全部检查」是 Demo 模拟，但汇总口径未按来源过滤，导致「已验证」可全是模拟值**：`ValidationPage.tsx:295-325` 调 `demoAdapter.runValidations`（`:298`、`:314`），`:300` 标注 `source:'demo'`、`:301` 有免责提示（这一点是诚实的），但汇总侧只认 `status`：`OverviewPage.tsx:22-24`（3 pass/8 → 概览「验证交付」）、`DeliverPage.tsx:21,31`（页签角标与 openFindings）、`ValidationPage.tsx:293,1158`（覆盖率）；且 `seed.ts:114-123` 预置 pass/warn，零次运行就显示 75%。真实 ERC/DRC 在另一条 lane（`ValidationPage.tsx:522`、`:357`）且从不回写。验收：点「运行全部检查」，Network 面板应无 `/api/eda/*` 请求；概览的通过数应随后变化，但 `.source` 仍为 demo。
2. **真实 ERC/DRC 证据不回写全局，手工豁免只改 Demo 数据**：`runErc`/`runPcbDrc` 只 `setErcResult/setDrcResult`（`ValidationPage.tsx:522-542`、`357-411`），无 `dispatch SET_VALIDATIONS`；真实豁免走 `/api/eda/schematic/erc/exemptions`（`:566`）与 `/api/eda/pcb/drc/exemptions`（`:482`），但 `confirmWaiver`（`:774`）只改本地 `state.validations` 并提示「豁免已记录」→ 两套豁免口径。
3. **阶段机「验证→生产」永远阻断（死门禁）**：`stageEvidence.ts:43-44` 要求 `state.validations` 中 DRC `status==='pass' && source==='official'`，但全仓没有一处写入 `source:'official'`（`grep -rn "source: 'official'" src` 仅命中 `types.ts:667` 定义）→ `ProjectsPage.tsx:100` 的「推进阶段」在「验证」阶段必被阻断，且提示是「DRC 已通过」缺失。

### P1（接线错位 / 双状态源 / 缺证据消费）

4. **「写入暂停」等闸门配置只在前端**：`SettingsPage.tsx:277-290` 保存只 `dispatch SET_SETTINGS`；持久化载荷（`AppContext.tsx:395-408`）只写 projects/requirements/components/assets；`server.mjs` 无 `/api/config`、`/api/settings` 路由 → 换浏览器/清缓存后 `Shell.tsx:44` 的 writePaused 与 Runtime 实际写权限可脱节。
5. **`state.validations` / `state.task` / `state.settings` / `state.eda` 是 localStorage 独立源（G）**：都不在 `AppContext.tsx:395-408` 的写回载荷里，而 Runtime 已有对应权威（`/api/eda/pcb/drc/*`、`/api/eda/gates/*`、`/api/production/*`）；刷新/换端后 UI 仍展示旧状态。
6. **同一「验证」两套入口与两套统计**：交付页「检查与问题」用 Demo 卡片（`ValidationPage.tsx:1158,2150-2160`），同页下方又有真实 DRC/ERC 面板（`:1174`、`:1423`），页头「覆盖率/通过」恒读 Demo 数据 → 用户无法判断哪份可作放行依据。
7. **EDA「断开」无 Runtime 动作**：`EdaPage.tsx:308` 只 `dispatch`，`server.mjs` 无 disconnect/close 路由；提示「连接已断开」但 Bridge 会话仍存活，下一次操作会重新连上。
8. **有路由无 UI 的关键能力**：生产放行 `productionRelease`、终审签核 `recordProductionFinalReview`、生产计划归一化 `normalizeProductionPlan`、发布版本详情 `releaseArchive`、项目列表 `listProjects` 等 9 个 client 方法无任何消费者（详见 §4），对应「终审/放行/归档详情」在界面上不可达。

### P2（一致性 / 可维护性）

9. **D6 单一事实源未收尾**：`VersionsPage.tsx:205`、`:212`、`ValidationPage.tsx:328`、`:594`（navigate('ai')）、`AiTasksPage.tsx:368`（requirements/assets）、`ProjectsPage.tsx:172`（requirements）仍在用旧 PageId，靠 `LEGACY_ALIASES`（`navigation.ts:56-62`）兜底 —— 无死链，但别名一旦删除即断。
10. **标签与行为不一致**：「落入计划」只产出 `partProposalPlan`（`PartProposalPage.tsx:95`），不写 BOM；「在 EDA 中定位」只弹 toast（`ValidationPage.tsx:326`）；「最后保存」取浏览器时间（`Shell.tsx:172`）。
11. **同一页面双路由**：`#knowledge` 与 `#validation/knowledge` 都渲染 `KnowledgePage`（`App.tsx:85`、`DeliverPage.tsx:10-16,38`），统计与导航高亮各算一份。
12. **板列表只在本机**：`VerificationCenterPage.tsx:10,43-45` 的 `circuitpilot.boards.v1` 无 Runtime 副本；换端后需重新输入 PCB uuid，门禁上下文不跟随项目。
13. **「绑定当前 EDA 设计」无写回**：`EdaPage.tsx:190-200` 只读 `/workspaces/current` 再本地保存绑定；Runtime 侧不记录「哪个项目绑了哪个板」，多端/多人不一致。
14. **概览数字无来源标注**：`OverviewPage.tsx:22-28` 的「验证通过/未运行/发现」来自 seed 或 Demo 适配器；Shell 有 DEMO 徽标，但数字本身没有「模拟/Demo」标记。

## 4. 无消费者 client 方法 / 路由孤儿清单

**A. `runtimeClient` 方法无任何页面/状态消费者（9 个）**

| 方法 | 定义 | 对应 server 路由 |
|---|---|---|
| `listProjects` | runtimeClient.ts:172 | GET /api/projects (1402) |
| `researchFetch` | runtimeClient.ts:241 | POST /api/research/fetch (1618) |
| `generateDesignPlan` | runtimeClient.ts:412 | POST /api/design/plan/ai (3124) |
| `normalizeProductionPlan` | runtimeClient.ts:484 | POST /api/production/plans/normalize (3598) |
| `recordProductionFinalReview` | runtimeClient.ts:506 | POST /api/production/reviews/final (3687) |
| `engineeringProfiles` | runtimeClient.ts:511 | GET /api/engineering/profiles (3691) |
| `productionRelease` | runtimeClient.ts:615 | POST /api/production/release (1740) |
| `releaseArchive` | runtimeClient.ts:644 | GET /api/production/releases/:id (1793) |
| `orchestrationGoals` | runtimeClient.ts:724 | GET /api/automation/orchestration/goals (3456) |

**B. server 路由无 client 方法、也无 UI 入口（约 20 条）**

`POST /api/design/cancel` (3167)、`POST /api/design/capabilities/probe` (3170)、`GET /api/design/executions/:id/evidence` (3185)、`GET /api/eda/commands` (1719)、`POST /api/eda/project/open` (3233)、`POST /api/eda/schematic/net-connect` (1985) 与 `/rollback` (2043)、`POST /api/eda/schematic/designators/set` (2067)、`POST /api/eda/footprint/integrity` (3003)、`POST /api/eda/gui/execute` (3365)、`GET /api/eda/gui/state` (3439)、`POST /api/eda/pcb/pour/create` (2403)、`GET|POST /api/knowledge/usage` (1577/1579)、`GET /api/research/status` (1625)、`GET /api/engineering/constraint-rules` (3728) + `/audit` (3730) + `/bridge-audit` (3737)、`GET /api/engineering/fab-rules` (3703) + `/audit` (3706)、`GET /api/engineering/net-rules` (3719) + `/audit` (3721)、`POST /api/evidence/retention/prune` (2840)。

**C. 判定为 F 的接线错误：0 条。** 所有被调用的 `runtimeClient.*` 路径都能在 `server.mjs` 找到（动态段 `/api/eda/commands/:id` 1721、`/api/custom-providers/:id` 1636、`/api/automation/runs/:id` 3593 等均覆盖）。

## 5. 本轮限制

- 未启动 4177/4178 Runtime，未启动 EDA/Bridge，**没有真机成功证据**；A 判定为「静态接线正确（方法名 + 路径 + method 匹配）」，不代表运行时一定成功。
- 未运行 `npm test` / `npm run test:runtime` / playwright（Lead 正在跑全量基线）；本报告结论全部来自静态 grep/源码阅读，`node -e` 仅用于脚本化核对路由与方法名。
- server.mjs 路由为长 `if/else` 链，动态路由用 `url.pathname.match(/^.../)` 与 `.test()` 两种写法；本报告用脚本抽取后人工复核，若后续新增路由段可能漏检。
- 行号基于当前工作区版本（2026-10-26）；未修改任何源码/配置。
- 「待确认」项：Runtime 是否另有未通过 HTTP 暴露的写暂停/配置通道；`productionRelease`/`reviews/final` 是否为后续版本预留入口 —— 均需 Runtime 侧确认。
