# 05 · UI 动作接线复审（修复后 · 2026-10-29）

> **修复收口（2026-10-29 晚）**：本文件是复审当时的证据与问题清单；所列 P0/P1 已在本轮"请全部修复"中逐项落地，当前状态以 `../flow-gap-audit-2026-10-29.md` §0.1 为准。下文保留原始判定以说明修复对象，不代表仍未解决。


> 复审对象：CircuitPilot 前端（`src/`）与 Runtime（`runtime/server.mjs` + 相关模块）之间的 UI 动作接线。
> 目的：复核 2026-10-29 这一轮 9 项 P0 修复在 **UI 层是否真的闭环**，并把仍存在的新缺陷按影响排序。
> 快照时间：**2026-10-29 11:16（+08:00）**。`src/pages/EdaPage.tsx` 与 `runtime/server.mjs` 的 mtime 为 11:06，复审期间可能仍有人在编辑；下文 file:line 以本快照为准。
> 本次**只读**：未改代码、未重启服务、未触发任何 EDA/Bridge 写、未做 Playwright/真机 E2E（会写用户 EDA 工程）、未执行 git。

---

## 0. 结论摘要

1. 覆盖全部 canonical 页面/页签（`overview`、`design/*`×4、`eda`、`automation`、`validation/*`×5、`knowledge`、`versions`、`projects`、`settings`），动作矩阵共 **83 行**：A（真接线）**75**、B（纯本地且语义诚实）**5**、C（调 Runtime 但不回写）**0**、D（Demo/种子，已显式标注）**2**、E（死链/文案与语义不符）**1**。
2. 客户端 142 条 `request()` 路径与 `runtime/server.mjs` 的 144 条精确路由 + 动态正则逐条交叉核对：**F（死链）= 0**；按钮扫描 **0** 个真正无 handler 的按钮。
3. 9 项 P0 修复中 **7 项在 UI 层闭环**（P0-1/2/4/5/6/7/9），**P0-3 与 P0-8 仍有缺口**。
4. **未解决 P0 = 2 个**（均为本轮新发现，不是修复项原样残留）：
   - **P0-1（新）验证页「运行全部检查（Demo）」会把官方 ERC/DRC 记录整体改写成 `source:'demo'`**，等于用本地假动作反向抹掉官方证据：官方覆盖率跌到 0%、`drcPassed` 变 false、阶段推进被阻断。
   - **P0-2（旧 P1-5 升级）官方验证证据仍未持久化到 Runtime**：`validations` 不在 `saveProjectState` 载荷里，只有浏览器 localStorage 有；阶段却已写进 Runtime 项目状态。清缓存/换机后同一项目出现「阶段=生产/验证，但官方覆盖 0%」的自相矛盾，且无法从 Runtime 侧复核当初凭什么推进。
5. P1 共 6 项（写暂停前端覆盖不全、豁免双口径、暂停镜像刷新时机、同步复验异常不落 issue、阶段推进无 Runtime 复核、验证页列表跨项目混排）；P2 共 5 项（交付页角标口径、未接线 client 方法、注释漂移、禁用原因仅 hover、双豁免入口）。

---

## 1. 复审范围与方法

### 1.1 已复审的本轮改动文件（19）

| 类别 | 文件 |
| --- | --- |
| 页面 | `src/pages/EdaPage.tsx`、`ValidationPage.tsx`、`OverviewPage.tsx`、`DeliverPage.tsx`、`ProjectsPage.tsx`、`AssetsPage.tsx`、`SettingsPage.tsx`、`AutomationPage.tsx`、`PlacementPage.tsx`、`VerificationCenterPage.tsx`、`KnowledgePage.tsx` |
| 组件 | `src/components/RoutingWritePanel.tsx` |
| 服务 | `src/services/runtimeClient.ts`、`releaseBindingStore.ts`（新）、`validationEvidence.ts`（新）、`stageMachine.ts`、`stageEvidence.ts` |
| 状态/类型 | `src/state/AppContext.tsx`、`src/types.ts` |
| 服务端对照 | `runtime/server.mjs`、`runtime/write-gate.mjs`、`runtime/gate-engine.mjs`、`runtime/release-gate.mjs`、`runtime/design.mjs`、`runtime/pcb.mjs` |

### 1.2 抽样的未改动核心页面（6 + 全局框架）

`src/components/Shell.tsx`（全局导航/写入门禁徽标）、`src/pages/AiTasksPage.tsx`（对话/计划）、`RequirementsPage.tsx`、`PartProposalPage.tsx`（选型/批量落件）、`RuleCenterPage.tsx`、`VersionsPage.tsx`。抽样页覆盖「AI 生成 → 人工批准 → 受控写入 → 版本审计」主链，以及第二条写路径（原理图批量落件）。

### 1.3 分类口径

| 类 | 含义 |
| --- | --- |
| **A** | 真接线：点击 → 调用 Runtime HTTP（或经 AppContext 防抖持久化）→ 回写 state/证据/审计，失败有可见反馈 |
| **B** | 纯本地动作：不调 Runtime，但语义诚实（明示「本机/Demo/草稿」），不冒充真实结论 |
| **C** | 调了 Runtime 但不回写 state（本次复审 0 条） |
| **D** | Demo/种子数据参与展示，但未明示或会污染真实结论 |
| **E** | 死链，或文案/角标与真实语义不符 |

### 1.4 方法

- 逐页读 handler 全文 + JSX 按钮的 `disabled`/`title`/`onClick`，不以页面文案推断行为；
- 用脚本抽取 `runtimeClient` 方法内的请求路径（142 条）与 `server.mjs` 的 `url.pathname ===` 精确路由（144 条）+ 动态路由正则，双向比对；
- 用脚本扫描 `src/pages/**`、`src/components/**` 中所有 `<Button>` 是否缺 handler（人工复核唯一命中项为误报）；
- 只读探活：`curl` 前端 dev server 与 `/api/health`（结果见 §5）。

---

## 2. 动作接线矩阵

> 列含义：**client 方法** = `runtimeClient` 方法名；**Runtime 路由** = 服务端实际匹配的 path；**回写 state** = 是否 dispatch/写证据/写审计；**失败反馈** = 用户可见的失败路径；**证据** = file:line。

### 2.1 全局框架与路由（Shell / App）

| 动作 | client 方法 | Runtime 路由 | 回写 state | 失败反馈 | 证据 | 类 |
| --- | --- | --- | --- | --- | --- | --- |
| 侧栏导航 / ⌘K 快捷跳转 | 无（`navigate`→hash） | 无 | 否（hash→`NAVIGATE`） | 非法 hash 由 `resolvePage` 回落 | App.tsx:29,40,50-71；navigation.ts:24,56,202；Shell.tsx:128 | A |
| 顶部 WRITE GATE 徽标 / 「写入已暂停」按钮 | `writeGate()` | GET `/api/write-gate` | 是 `SET_WRITE_PAUSED` | `.catch(()=>undefined)`：Runtime 不可达时保留上次值（偏 fail-closed） | AppContext.tsx:153,331-340；Shell.tsx:44,52,142,153 | A |
| 切换项目加载项目切面 | `getProjectStateScoped` | GET `/api/project-state/:id` | 是 `HYDRATE_BUSINESS_STATE` | `logger.warn` + 保留当前工作集 | AppContext.tsx:370-400 | A |

### 2.2 总览 `#overview`

| 动作 | client 方法 | Runtime 路由 | 回写 state | 失败反馈 | 证据 | 类 |
| --- | --- | --- | --- | --- | --- | --- |
| 阶段进度百分比 | 无（`stageProgress(project.stage)`） | 无 | 否（派生，不再另存 progress） | — | OverviewPage.tsx:20；stageMachine.ts:22-26 | A |
| 验证四 KPI（通过/警告/待运行/未收口） | 无（`validationKpis(state.validations, project.id)`） | 无 | 否（派生；无官方记录时展示「尚未运行」而非「通过」） | — | OverviewPage.tsx:26-30,42；validationEvidence.ts:49-66 | A |
| 决策卡 / 全链路步骤 / 快捷动作 | 无（`navigate`） | 无 | 路由 | — | OverviewPage.tsx:87-89,126,181,191-195 | A |

### 2.3 项目 `#projects`

| 动作 | client 方法 | Runtime 路由 | 回写 state | 失败反馈 | 证据 | 类 |
| --- | --- | --- | --- | --- | --- | --- |
| 新建项目 | 无 | 无（经 AppContext 写回 `/api/project-state`） | 是 `ADD_PROJECT`+审计 | name/code 空则静默不发 | ProjectsPage.tsx:64-76；AppContext.tsx:407-419 | A |
| 保存项目资料 | 无 | POST `/api/project-state`（800ms 防抖） | 是 `UPDATE_PROJECT`+审计 | Runtime 写失败仅日志（本地缓存保留） | ProjectsPage.tsx:82-88；AppContext.tsx:407-419 | A |
| **推进项目阶段** | 无（`stageGateView`→`evaluateStageAdvance`） | 无（Runtime 审批/执行/DRC 证据未在推进时复核） | 是 `UPDATE_PROJECT`+`recordChange`；缺证据只阻断不 dispatch | warning toast + 审计「被证据门禁阻断」 | ProjectsPage.tsx:101-137,204-216；stageMachine.ts:97-105,211-225；stageEvidence.ts:22-55 | A（见 P1-5） |
| 校验 EDA 窗口↔项目绑定 | `verifyProjectBinding` | GET `/api/projects/:id/binding/verify` | 是 `setBinding`（只读展示） | warning/danger toast（mismatches 明文） | ProjectsPage.tsx:84 | A |
| 删除项目 | `resetChat` | DELETE `/api/chat/sessions/:id` | 是 `DELETE_PROJECT`+审计 | catch 忽略 Runtime 失败（本地删除仍生效） | ProjectsPage.tsx:155 | A |

### 2.4 AI 任务 `#design/chat`

| 动作 | client 方法 | Runtime 路由 | 回写 state | 失败反馈 | 证据 | 类 |
| --- | --- | --- | --- | --- | --- | --- |
| 发送对话 | `sendChat` | POST `/api/chat/sessions/:id/messages` | 是（任务/需求建议/BOM 草案） | `fail()`→danger + `reportFailure` | AiTasksPage.tsx:239,255 | A |
| 生成可验证 PCBA 计划 | `generateProductionPlan` | POST `/api/production/plans/ai` | 是 `PATCH_TASK`（plan/planHash/步骤） | toast + 审计 | AiTasksPage.tsx:191-224 | A |
| 进入 EDA 编译与审批（交接） | 无（写 sessionStorage 草稿） | 无 | 跨页交接；EDA 页读取并现场编译 | 无草稿时 EDA 页提示 | AiTasksPage.tsx:225；EdaPage.tsx:204-236 | A（本地交接，已被消费） |
| 接受需求建议 / 应用 BOM 草案 | 无 | 无 | 是 `SET_REQUIREMENTS`/`SET_COMPONENTS`+审计 | — | AiTasksPage.tsx:292-323 | A |
| 打开历史会话 / transcript | `chatSessions`/`chatTranscript` | GET `/api/chat/sessions`、`.../transcript` | 是 | `fail` toast | AiTasksPage.tsx:131-153 | A |

### 2.5 需求与选型 `#design/req`、`#design/select`

| 动作 | client 方法 | Runtime 路由 | 回写 state | 失败反馈 | 证据 | 类 |
| --- | --- | --- | --- | --- | --- | --- |
| 新增 / 更新受控需求 | 无 | 无（经 project-state 持久化） | 是 `ADD/UPDATE_REQUIREMENT`+审计 | 必填校验 | RequirementsPage.tsx:22-40 | A |
| 搜索候选器件 | `partProposal` | POST `/api/library/proposals` | 是 `setCandidates` | `fail()` danger | PartProposalPage.tsx:61-66 | A |
| 生成选型计划 | `partProposalPlan` | POST `/api/library/proposals/plan` | 是 `setPlan` | `fail()` | PartProposalPage.tsx:95-97 | A |
| 送入设计审批 | 无（dispatch 后 navigate） | 无 | 是 `SET_COMPONENTS` | — | PartProposalPage.tsx:110-121 | A |
| 批量落件（计划） | `schematicComponentBatchPlan` | POST `/api/eda/schematic/component-batch` | 是 `setBatchPlan` | 面板内 `batchError` | PartProposalPage.tsx:130-138 | A |
| **批量落件（执行，含签发写批准）** | `issueAutomationApproval`→`schematicComponentBatchApply` | POST `/api/automation/approvals`→`/api/eda/schematic/component-batch` | 是 审计 + 结果面板 | failed→`batchError` | PartProposalPage.tsx:151-172 | A（暂停未禁用，P1-1） |

### 2.6 资料与产物 `#design/assets`

| 动作 | client 方法 | Runtime 路由 | 回写 state | 失败反馈 | 证据 | 类 |
| --- | --- | --- | --- | --- | --- | --- |
| 检查生产资料（manifest） | `inspectProductionArtifacts` | POST `/api/production/artifacts/inspect` | 是 `setProductionInspection`+审计 | danger toast | AssetsPage.tsx:45-58 | A |
| **生产放行 readiness** | `compileProductionPlan`→`pcbExecutions`→`productionReadiness` | POST `/api/production/plans/compile`、GET `/api/pcb/executions`、POST `/api/production/readiness` | 是 `setReadiness`+审计+sessionStorage 交接（binding/manifestHash） | 精确错误码 toast/审计（`PRODUCTION_PLAN_MISSING`/`COMPILE_BLOCKED`/`PCB_EXECUTION_MISSING`） | AssetsPage.tsx:64-135；releaseBindingStore.ts:54-61 | A |
| 导出 BOM CSV | 无（本地拼 CSV） | 无 | 否 | — | AssetsPage.tsx:42 | B（本地导出，明示） |
| 器件库搜索 | `searchEasyEdaDevices` | GET `/api/eda/library/devices/search` | 是 结果列表 | 失败提示 | AssetsPage.tsx:145 | A |

### 2.7 EDA 受控执行 `#eda`

| 动作 | client 方法 | Runtime 路由 | 回写 state | 失败反馈 | 证据 | 类 |
| --- | --- | --- | --- | --- | --- | --- |
| 新建 EDA 设计文件 | `createEasyEdaWorkspace` | POST `/api/eda/workspaces` | 是 `PATCH_EDA`/`createdWorkspace`+`recordChange` | `fail()`→`reportFailure` | EdaPage.tsx:176-188,597 | A（暂停未禁用，P1-1） |
| 绑定当前 EDA 设计 | `currentEasyEdaWorkspace`+`pcbContext` | GET `/api/eda/workspaces/current`、GET `/api/pcb/context` | 是 `PATCH_EDA.edaWorkspace`+文档绑定 | `fail()` | EdaPage.tsx:192-203 | A |
| 发现桥 / 窗口 / 版本能力 | `discoverBridge`/`windows`/`pcbCapabilities`/`edaAdaptation` | GET `/api/eda/discover`、`/api/eda/windows`、`/api/pcb/capabilities`、`/api/eda/version/adaptation` | 是 `PATCH_RUNTIME`/`PATCH_EDA` | `fail()` | EdaPage.tsx:326-357 | A |
| 选择目标窗口 | `selectWindow` | POST `/api/eda/windows/select` | 是 `PATCH_EDA.activeWindowId` | `fail()` | EdaPage.tsx:358-362 | A |
| 打开关联原理图 / 读设计上下文 | `openCurrentSchematic`/`designContext` | POST `/api/eda/schematic/open-current`、GET `/api/design/context` | 是 上下文+审计 | `fail()` | EdaPage.tsx:370-387 | A |
| AI 生成网络表草案 | `generateProductionPlan`→`compileProductionPlan`→`normalizePcbPlan` | POST `/api/production/plans/ai`、`/plans/compile`、`/api/pcb/plan` | 是 候选/计划 + 血缘（`semanticPlanHash`/`compiledPlanHash`） | `fail()` + 阻断原因展示 | EdaPage.tsx:204-236 | A |
| 校验原理图计划 | `normalizeDesignPlan` | POST `/api/design/plan` | 是 `planning`+审计 | 缺失字段明文 | EdaPage.tsx:388-394 | A |
| **4. 人工批准（原理图）** | `approveDesign` | POST `/api/design/approve` | 是 `approval`+`recordChange` | `fail()` | EdaPage.tsx:431-438,628 | A（暂停未禁用，P1-1） |
| 执行原理图写入 | `executeDesign` | POST `/api/design/execute` | 是 执行/回读 + 阶段证据（`netlistApproved`/`schematicGenerated`） | `fail()`+`reportFailure` | EdaPage.tsx:466-482,628 | A（gate 含 `writePaused`） |
| PCB 读取 / 打开 / 编译 / 校验 | `pcbContext`/`openPcb`/`normalizePcbPlan` | GET `/api/pcb/context`、POST `/api/eda/commands/pcb.open`、POST `/api/pcb/plan` | 是 `pcbContext`/`pcbPlanning`+血缘注入 | `fail()` | EdaPage.tsx:483-524 | A |
| **PCB 人工批准** | `approvePcb` | POST `/api/pcb/approve` | 是 `pcbApproval`（含双哈希）+「批准血缘（语义/编译）」展示 | `fail()` | EdaPage.tsx:525-536,626 | A（暂停未禁用，P1-1） |
| PCB 执行 | `executePcb` | POST `/api/pcb/execute` | 是 `pcbExecution`/readback+执行历史+阶段证据（`pcbPlaced`/`drcPassed`） | `fail()` | EdaPage.tsx:537-558,626 | A（gate 含 `writePaused`） |
| 对话驱动 PCB：执行前同步验收 | `pcbSyncVerify` | GET `/api/pcb/sync/verify` | 是 `pcbPlanning`（写入 `expectations.designators`） | 未标注/多件/上下文不完整→精确错误码+`fail()` | EdaPage.tsx:238-284 | A |
| **对话驱动 PCB：执行 + 执行后复核** | `approvePcb`→`executePcb`→`pcbSyncVerify` | POST `/api/pcb/approve`、`/api/pcb/execute`、GET `/api/pcb/sync/verify` | 是 `recordChange`+`reportIssue`（缺件即 issue） | 缺件→`PCB_SYNC_INCOMPLETE` issue+danger；复验请求异常→仅 warning 文案（P1-4） | EdaPage.tsx:286-324 | A |
| 命令卡执行 | `executeCommand` | POST `/api/eda/commands/:id` | 是 命令日志 | 写命令在 UI 直接拒绝 | EdaPage.tsx:559-583 | A |
| 会话级写入暂停 | 无（`PATCH_EDA.writePaused`） | 无（全局暂停另走 `/api/write-gate`） | 是 `eda.writePaused`+审计 | 全局暂停时开关 disabled 并说明覆盖关系 | EdaPage.tsx:623 | A |
| 读取叠层 / 设置层数 | `pcbLayers` | GET/POST `/api/eda/pcb/layers` | 是 `stack`+审计 | `fail()`；写前暂停 disabled+title | LayerStackPanel.tsx:33,52,69,82,128 | A |
| 布线规划 / 预演 / 写入 / 回滚 / 收尾 | `routingPlan`/`routingApply`/`routingRollback`/`routingFinish` | POST `/api/eda/pcb/routing/{plan,apply,rollback,finish}` | 是 routes/written/verification/pours+issue（收尾失败） | `fail()`→`reportIssue`+danger；收尾 `ok:false` 点名未填充覆铜+「本次没有保存」 | RoutingWritePanel.tsx:50,77,93-145,146-190,204-206 | A（写按钮未按暂停禁用，P1-1） |

### 2.8 自动化 `#automation`

| 动作 | client 方法 | Runtime 路由 | 回写 state | 失败反馈 | 证据 | 类 |
| --- | --- | --- | --- | --- | --- | --- |
| 加载配方 / 批准账本 | `automationRecipes`/`automationApprovals` | GET `/api/automation/recipes`、`/api/automation/approvals` | 是 recipes/ledger | `fail()` | AutomationPage.tsx:82 | A |
| GUI 兜底能力探测 | `guiCapabilityProbe` | POST `/api/eda/gui/capabilities/probe` | 是 probe 状态 | `fail()` | AutomationPage.tsx:45,242 | A |
| 编排计划 / 失败恢复 | `planOrchestration`/`orchestrationFailure`/`automationRecovery` | POST `/api/automation/orchestration/plan`、`/api/automation/failure`、`/api/automation/recovery` | 是 计划/状态 | `fail()` | AutomationPage.tsx:111,125,139 | A |
| 签发写批准 | `issueAutomationApproval` | POST `/api/automation/approvals` | 是 ledger 刷新 | 暂停时 disabled +「Runtime 全局写入已暂停」 | AutomationPage.tsx:175,319 | A |
| 运行配方 | `runAutomation`→`automationRun` | POST `/api/automation/run`、GET `/api/automation/runs/:id` | 是 runId/轮询状态 | 暂停时 disabled；409 兜底 | AutomationPage.tsx:212-230,320 | A |
| 中止运行 | `abortAutomationRun` | POST `/api/automation/runs/:id/abort` | 是 状态 | `fail()` | AutomationPage.tsx:190 | A |
| 重放运行 / 审计包 | `replayAutomationRun`/`automationAuditBundle` | POST `/api/automation/runs/:id/replay`、GET `.../audit-bundle` | 是 结果面板 | `fail()` | AutomationPage.tsx:153,98 | A |

### 2.9 验证与交付 `#validation/{verify,placement,rules,verification,knowledge}`

| 动作 | client 方法 | Runtime 路由 | 回写 state | 失败反馈 | 证据 | 类 |
| --- | --- | --- | --- | --- | --- | --- |
| 加载最新官方 DRC 报告 | `latestPcbDrc`/`pcbDrcReport` | GET `/api/eda/pcb/drc/latest`、`/api/eda/pcb/drc/report` | 是 `setDrcReport`（**不回填官方验证记录**，见 P0-2） | 首次静默 | ValidationPage.tsx:378-400 | A |
| **运行官方 DRC + 回写官方证据** | `startPcbDrc`→`pcbDrcReport`→`recordOfficialValidation` | POST `/api/eda/pcb/drc/start`、GET `/api/eda/pcb/drc/report` | 是 `SET_VALIDATIONS`（`source:'official'`+projectId）+逐条 `reportIssue`+阶段自动推进+审计 | failed→`reportIssue`+danger | ValidationPage.tsx:401-482,306-336 | A |
| **运行官方 ERC + 回写** | `ercRun`→`recordOfficialValidation` | POST `/api/eda/schematic/erc/run` | 是 同上（`status` 依 errors/warnings） | 同上 | ValidationPage.tsx:583-601 | A |
| 取消 DRC | `pcbDrcCancel` | POST `/api/eda/pcb/drc/cancel` | 是 状态 | `fail()` | ValidationPage.tsx:421 | A |
| 真实 DRC 豁免（配额/条目） | `pcbDrcExemptions`/`savePcbDrcExemptions` | GET/POST `/api/eda/pcb/drc/exemptions` | 是 exemptions+审计 | `fail()` | ValidationPage.tsx:503-548 | A |
| **「记录验证豁免」（本地弹窗）** | 无（`UPDATE_VALIDATION` 改 `status:'waived'`） | 无 | 是 `UPDATE_VALIDATION`+审计 | toast「豁免已记录」 | ValidationPage.tsx:847-852,2249 | B/D（双口径，P1-2） |
| 运行全部检查（Demo） | `demoAdapter.runValidations`（无 HTTP） | 无 | 是 `SET_VALIDATIONS`（**全部打 `source:'demo'`**） | toast「结果来自模拟适配器」；异常→issue | ValidationPage.tsx:339-352；demoAdapter.ts:69-88 | D（标注）→ **覆盖官方行 = P0-1** |
| 单条运行检查（Demo） | 同上 | 无 | 是 `UPDATE_VALIDATION(source:'demo')` | 同上 | ValidationPage.tsx:354-369 | D（标注） |
| 定位问题 | 无（`navigate('eda')`） | 无 | 路由 | 明示「Demo 将定位…真实定位需 Bridge」 | ValidationPage.tsx:372 | B（诚实标注） |
| 一键生成修复任务 | 无（`PATCH_TASK`+navigate） | 无 | 是 `PATCH_TASK` | — | ValidationPage.tsx:374 | A（本地草稿） |
| 原理图自动修复（预演/执行） | `repairSchematic` | POST `/api/eda/schematic/repair` | 是 快照/审计/issue+网表复核 | 失败 `reportIssue`+danger；执行未按暂停禁用（P1-1） | ValidationPage.tsx:1132-1165,1885-1886 | A |
| 登记在线 DFM 证据 | `saveDfmEvidence` | POST `/api/production/dfm-evidence` | 是 `setDfmEvidence`+审计 | danger toast | ValidationPage.tsx:773-792 | A |
| 三方终审签核 | `recordSignoff` | POST `/api/production/signoff` | 是 `setSignoffEvidence`+审计 | danger toast | ValidationPage.tsx:813-845 | A |
| 下单参数卡人工确认 | `saveOrderConfirmation` | POST `/api/production/order-confirmation` | 是 `setOrderConfirmation`+审计 | 前置校验（无卡/未 ready/无确认人/未勾选声明）+danger | ValidationPage.tsx:794-811 | A |
| 运行放行闸门（含 DFM/签核证据刷新） | `releaseGate` | POST `/api/eda/release/gate` | 是 `setGate`+审计 | 失败审计；结论来自服务端 | ValidationPage.tsx:1170-1229 | A |
| 导出草稿生产文件 | `productionExport({requested:'draft'})` | POST `/api/production/export` | 是 `setExportResult`+审计 | 失败→`reportIssue`+danger；取消/超时只提示「已停止等待」 | ValidationPage.tsx:982-1035 | A |
| **导出正式生产文件（双钥匙）** | `productionExport({requested:'final'})+manifestHash/binding 交接` | POST `/api/production/export` | 是 `setExportResult`+审计 | disabled 且有可操作 title（门禁未过/人工证据未齐）；服务端 `RELEASE_MANIFEST_MISMATCH`/`RELEASE_DECISION_BLOCKED` 明文 | ValidationPage.tsx:982-1035,1701-1711 | A |
| 归档不可变发布 | `archiveRelease` | POST `/api/production/releases/archive` | 是 `setArchiveResult`+审计 | failed→审计+danger（不落 issue）；非 done→「已停止等待」 | ValidationPage.tsx:958-981 | A |
| 下载放行产物 | `downloadProductionArtifact` | GET `/api/production/download?path=` | 是 触发浏览器保存 | `catch`→danger；服务端路径白名单 | ValidationPage.tsx:1038-1055 | A |
| 器件布局：规划/预演/写回/还原 | `placementPlan`/`applyPlacement` | POST `/api/eda/pcb/placement/plan`、`/api/eda/pcb/placement/apply` | 是 写回结果+阶段证据（`pcbPlacementExecutedAt`/`pcbPlaced`）+审计 | 写回前 `settings.writePaused`→warning；`fail()` | PlacementPage.tsx:57,80,95-125,147 | A |
| 门禁状态/评估/签核/账本 | `gatesStatus`/`gatesEvaluate`/`gatesSignoff`/`gatesApprovals` | GET `/api/eda/gates/status`、POST `/evaluate`、POST `/signoff`、GET `/approvals` | 是 report/ledger/`knowledgeAdvice`+审计 | `fail` toast；未实现门禁与签字按钮一致禁用 | VerificationCenterPage.tsx:52-96,128-176 | A |
| 板卡本机台账（增删） | 无（localStorage `circuitpilot.boards.v1`） | 无 | 是 `setBoards` | 无 | VerificationCenterPage.tsx:10,43-45,71,78 | B（本机记录，明示） |
| 知识库检索/审核/RAG/Agent | `knowledgeList`/`knowledgeReview`/`ragQuery`/`knowledgeAgentRun`/`knowledgeSave` 等 | GET `/api/knowledge/entries`、POST `/api/knowledge/entries/:id/review`、POST `/api/rag/query`、POST `/api/knowledge/agent/run` 等 | 是 列表/审核结果/候选 | `error` 状态+`fail` | KnowledgePage.tsx:53-132 | A |
| 规则中心：规则包/夹具审计 | `layoutRulePack`/`auditLayoutRules` | GET `/api/engineering/layout-rules`、POST `/api/engineering/layout-rules/audit` | 是 pack/audit 结果 | `fail` | RuleCenterPage.tsx:44,59,71 | A |
| 版本：快照/回滚/下载诊断包 | 无（本地） | 无 | 是 `ADD_VERSION`+审计；文件名/审计明示 DEMO | — | VersionsPage.tsx:180-196 | B（本机快照） |
| 版本：证据索引/时间线/保留策略/发布归档 | `evidenceIndex`/`timeline`/`linkTimeline`/`evidenceRetentionPlan`/`artifactRetentionPlan`/`releaseArchives`/`evidenceFind` | GET/POST `/api/evidence/*`、GET `/api/production/releases` | 是 列表/审计 | `fail` | VersionsPage.tsx:58-153 | A |
| 版本：一键修复任务 / 处理问题 | 无（`SET_TASK`+navigate） | 无 | 是 `SET_TASK` | — | VersionsPage.tsx:198-212 | A |
| 设置：刷新诊断/Provider/登录/Key/测试/联网检索 | `health`/`providers`/`diagnostics`/`startLogin`/`storeKey`/`testProvider`/`researchSearch`/`providerEgress` | GET `/api/health`、`/api/providers…`、POST `/api/providers/:id/key` 等 | 是 `PATCH_RUNTIME`/`SET_SETTINGS`+审计 | danger+精确错误码 | SettingsPage.tsx:113-270 | A |
| **设置：全局暂停所有写入** | `setWriteGate` | POST `/api/write-gate` | 是 `SET_SETTINGS`（**仅在 Runtime 确认后**） | Runtime 不可达/失败→danger+审计+**不** dispatch（拒绝假保存） | SettingsPage.tsx:277-310,427 | A |

### 2.10 交付壳 `#validation/*`（DeliverPage）

| 动作 | client 方法 | Runtime 路由 | 回写 state | 失败反馈 | 证据 | 类 |
| --- | --- | --- | --- | --- | --- | --- |
| 验证/布局/规则/门禁/知识页签切换 | 无（改 `window.location.hash`） | 无 | 路由 | — | DeliverPage.tsx:23-25,31 | A |
| 验证页签角标「N」 | 无（`state.validations.length`） | 无 | 否 | — | DeliverPage.tsx:32 | **E**（与 :22/:36 官方口径不符，P2-1） |
| 「N 个检查发现待收口」文案 | 无（仅统计 `source==='official'` 的 open findings） | 无 | 否（派生） | — | DeliverPage.tsx:22,36 | A |

---

## 3. 9 项 P0 修复的 UI 层验收复核

| 修复项 | UI 层结论 | 关键证据 | 残留 |
| --- | --- | --- | --- |
| P0-1 计划双哈希血缘 | ✅ 闭环 | `EdaPage.tsx:626`「批准血缘（语义/编译）」渲染两个哈希；服务端 `approval-ledger` 绑定并在不一致时 409（`release-gate`/`design.mjs:124-145`） | — |
| P0-2 PCB 同步 fail-closed | ✅ 基本闭环 | 执行前只读验收（EdaPage.tsx:252-265）+ 执行后二次复核（:298-320）+ `PCB_SYNC_INCOMPLETE` issue | 复验请求本身失败时只 warning，不落 issue（P1-4） |
| P0-3 验证单源（官方） | ⚠️ 展示层闭环、数据生命周期不闭环 | KPI/阶段证据/Deliver 文案均走 `source==='official' && projectId`（validationEvidence.ts:18-66；stageEvidence.ts:52-53） | Demo 全量运行抹掉官方行（P0-1）；证据不持久化（P0-2） |
| P0-4 覆铜收尾 fail-closed | ✅ 闭环 | RoutingWritePanel.tsx:163-190：`ok:false` 点名 `unfilledPours`、`reportIssue`、文案「本次没有保存」 | — |
| P0-5 门禁未实现与签核一致 | ✅ 闭环 | gate-engine.mjs:10-17,32-39,79-95；VerificationCenterPage.tsx:20-21,128-176；签字按钮由 `report.verdict!=='pass'` 禁用 | — |
| P0-6 正式导出解锁 | ✅ 闭环（含可操作禁用原因） | ValidationPage.tsx:1698-1718：双钥匙判定 + 未通过时 title 说明缺什么；导出带 readiness 交接的 manifestHash/binding，服务端重算并 fail-closed | 未走 readiness 交接时按钮可能可点但服务端 `RELEASE_MANIFEST_MISMATCH` 拒绝（P2 可接受） |
| P0-7 readiness 真输入 | ✅ 闭环 | AssetsPage.tsx:64-135 只用服务端编译哈希 + 真实执行记录；`pickReadinessPcbExecution` 拒绝 rolled_back/DRC fail（releaseBindingStore.ts:54-61） | — |
| P0-8 写暂停权威在 Runtime | ⚠️ 服务端闭环、前端覆盖不全 | 服务端：EDA_WRITE_ROUTES 前置 409（server.mjs:138-161,1459,767-768）+ `write-gate.mjs`；设置页保存必须 Runtime ack（SettingsPage.tsx:292-310） | 6 处写/批准按钮未按暂停禁用（P1-1）；镜像只在启动/focus 刷新（P1-3） |
| P0-9 知识门禁建议 | ✅ 展示闭环 | VerificationCenterPage.tsx:157-176 渲染 `knowledgeAdvice` + 「未实现/证据不足」分开计数；KnowledgePage.tsx:9,11,122,151-176 审核/可信/过期标注 | 双豁免入口文案（P2-5） |

---

## 4. 发现清单（按影响排序）

### 4.1 P0（未解决 2 个）

#### P0-1 Demo「运行全部检查」覆盖官方 ERC/DRC 证据（P0-3 反向污染）

- **证据**：`ValidationPage.tsx:339-352` — `runAll` 把 `state.validations`（含官方记录）整体交给 `demoAdapter.runValidations`，随后对**每条**结果 `{...item, source:'demo'}` 全量 `SET_VALIDATIONS`；`demoAdapter.ts:69-88` 对传入的每条 check 重置 `status:'idle'` 并按 findings 重算 pass/warn/fail。官方记录是通过 `mergeValidationRecord` 原地 upsert 的（`validationEvidence.ts:24-31`），因此必然出现在被传入的列表里。触发按钮在验证页「全量检查」面板（`ValidationPage.tsx:2237` 附近），无任何官方证据保护。
- **影响**：官方 DRC 通过后，用户点一次「运行全部检查（Demo）」→ `validationKpis().ran=0`、覆盖率 0%、`stageEvidence.ts:52-53` 的 `drcPassed` 变 false → 项目「验证→生产」阶段被阻断、概览 KPI 归零（显示「官方检查尚未运行」）、交付页待收口归零。Runtime 侧真实 DRC 报告文件未变，但 UI 无法自愈（只能重跑官方 DRC/ERC）。这是「本地假动作反噬官方唯一来源」，直接违背 P0-3 的验收口径。
- **修法**：`runAll` 只传非官方记录（`state.validations.filter(i => i.source !== 'official')`），官方行原样保留；或在存在官方行时把按钮降级为「重跑 Demo 检查（不影响官方结论）」并在 `demoAdapter` 内加硬保护（拒绝改写 `source==='official'` 的记录）。同时给该按钮加二次确认/说明「本操作不替代官方 ERC/DRC」。
- **验收**：官方 DRC 通过 → 运行 Demo 全量检查 → `validationKpis(..., projectId).ran` 仍为 2、`drcPassed` 仍为 true、阶段不倒退；刷新页面后官方行仍在（需与 P0-2 一起验收）。

#### P0-2 官方验证证据仍未持久化到 Runtime（阶段结论与依据脱钩）

- **证据**：`AppContext.tsx:407-419`（项目状态防抖写回）与 `:352-357` 的 `saveProjectState` 载荷只有 `projects/activeProjectId/requirements/components/assets`，**没有 `validations`**；相比之下 issues/versions/changes/audit 都有 Runtime 权威副本（`:465`、`:474`）。官方验证记录（含 `evidence.digest/path/jobId`）只随浏览器 localStorage 持久化；页面进入时也不从 `/api/eda/pcb/drc/latest` 重建官方记录（`ValidationPage.tsx:378-400` 只设展示态）。
- **影响**：项目阶段是前端用官方验证证据派生的（`stageEvidence.ts`），推进后 `project.stage` 经 `saveProjectState` 写进 Runtime；但**凭以推进的 evidence 仍只在浏览器**。清缓存/换浏览器/换机后：同一项目阶段为「生产/归档」，页面却显示「官方 ERC/DRC 未运行、覆盖 0%」，审计（Runtime 侧）里的「官方 DRC 通过，阶段自动推进」无法用验证记录复核。P0-3 承诺的「KPI/阶段同源于官方验证记录」在跨会话场景失效。
- **修法**：(a) 把 `validations` 纳入 project-state 载荷（按 projectId 切片，含 `source/projectId/status/findings/evidence`），读回以 Runtime 为准；(b) 旧 localStorage 行迁移时标 `legacy:true`，绝不冒充官方；(c) 启动时用 `/api/eda/pcb/drc/latest` + ERC 结果（服务端已有）重建官方记录，使证据可从 Runtime 自愈；(d) 阶段推进改为带 `evidence.digest` 的 Runtime 指令（见 P1-5）。
- **验收**：记录官方 ERC/DRC → 刷新/清 localStorage/重开浏览器 → KPI 覆盖与阶段仍一致；Runtime 项目状态文件含 validations；无 projectId 的记录不计为官方；手工把 localStorage 中某条改成 official 不会被当作证据（需服务端 digest 校验）。

### 4.2 P1（6 个）

#### P1-1 写暂停（P0-8）前端禁用覆盖不全，6 处写/批准按钮仍可点

- **证据**：已正确禁用：`LayerStackPanel.tsx:33,128`、`PlacementPage.tsx:105`、`AutomationPage.tsx:319-320`、`EdaPage.tsx:120-123` 的受控执行 gate（`taskMachine.ts:31-38` 含 `writePaused`）。**未覆盖**：
  1. `EdaPage.tsx:628`「4. 人工批准」（`approveDesign` → POST `/api/design/approve`，在写暂停名单内）；
  2. `EdaPage.tsx:626` PCB「4. 人工批准PCB」（`approvePcb` → POST `/api/pcb/approve`）；
  3. `EdaPage.tsx:597`「新建EDA文件」（`createEasyEdaWorkspace` → POST `/api/eda/workspaces`）；
  4. `RoutingWritePanel.tsx:204-206` 写入/收尾/回滚（routingApply/routingFinish/routingRollback，均属写路由）；
  5. `ValidationPage.tsx:1886`「应用」原理图自动修复（POST `/api/eda/schematic/repair`）；
  6. `PartProposalPage.tsx:151-162` 批量落件执行（先 `issueAutomationApproval` 再 component-batch）。
- **影响**：Runtime 已暂停写入时，上述按钮仍显示可点；点击后先发批准/写请求，由服务端 409 `EDA_WRITE_PAUSED` 兜底并弹出红色错误。功能上安全（服务端权威），但违反 P0-8「UI 以 Runtime 状态为准禁用写操作」的承诺，用户看到的不是禁用原因而是失败；其中 3 处是「签发批准」类动作，容易让人误以为暂停只针对执行。
- **修法**：抽一个 `useWritePaused()`/`writeGate` 联合判断（`settings.writePaused || eda.writePaused`），统一接入上述 6 处 `disabled` + `title`（复用 AutomationPage 的文案「Runtime 全局写入已暂停：请在设置页恢复」）；或至少把按钮包进同一个 `<WritePausedGuard>` 组件。
- **验收**：Runtime 暂停写入时，上述按钮全部 disabled 且 title 说明原因；解除后恢复可点；用脚本直接 POST 仍得 409（不变）。

#### P1-2 验证豁免双口径：本地弹窗不写真实豁免，闸门不认

- **证据**：`ValidationPage.tsx:847-852` `confirmWaiver` 只改前端 `ValidationCheck.findings[].status='waived'` 并 `count-1`，toast「豁免已记录」；真实豁免另有一套「DRC 豁免」面板（`ValidationPage.tsx:503-548` → GET/POST `/api/eda/pcb/drc/exemptions`），放行闸门只认后者。
- **影响**：在发现行里点「记录验证豁免」后，本地 KPI「待收口」下降、看起来已处理；但重新运行放行闸门仍因同一 DRC 条目被阻断，用户不知道两套豁免的区别，会反复重跑。
- **修法**：把「记录验证豁免」改为调用真实豁免接口（或直接删除该弹窗，统一跳转到真实豁免编辑器并带上条目定位）；若保留，文案必须明示「仅本地标记，不改变官方 DRC 与放行闸门」。
- **验收**：在验证页登记豁免后，放行闸门的阻断项同步消失（真实豁免路径）；本地标记路径不再让 KPI 与闸门口径分叉。

#### P1-3 写暂停镜像只在启动/focus 刷新，且禁用文案不区分「Runtime 全局」与「本会话」

- **证据**：`AppContext.tsx:331-340` 只在 `runtime.reachable` 变化与 `window 'focus'` 时 `writeGate()`；无轮询、无写前刷新。禁用文案：`taskMachine.ts:37` 统一「全局写入已暂停」，`LayerStackPanel.tsx:128` 更笼统（「需要 Runtime + 已连接 EDA，且未暂停写入」），`EdaPage.tsx:241` 把两种情况合并成一句。
- **影响**：另一个窗口/脚本暂停 Runtime 后，当前聚焦页在失焦前仍显示未暂停、按钮可点；用户点下去才被 409 拒绝。另：会话级暂停与 Runtime 全局暂停在文案上不可区分，排查时无法判断该去设置页还是本页开关。
- **修法**：写操作前调用一次 `writeGate()`（或在 409 `EDA_WRITE_PAUSED` 时强制刷新镜像并对齐 UI）；文案区分「Runtime 全局暂停（设置页解除）」与「本会话暂停（EDA 页开关）」，并统一到 `getExecutionGate` 的 reason 中。
- **验收**：在另一窗口暂停后，本页下一次写操作前即显示暂停、按钮 disabled；两种暂停在门上给出不同原因。

#### P1-4 同步执行后「复验请求失败」不落 issue（P0-2 验收缺口）

- **证据**：`EdaPage.tsx:303-320`：`postError` 仅拼接进成功 toast 的 warning 文案（「回读复核失败」），不发 `reportIssue`；只有 `syncMissing.length>0` 才建 `PCB_SYNC_INCOMPLETE` issue（:317）。此外 `syncExtra.length>0` 也只写进 toast。
- **影响**：执行已完成但复核请求本身失败时，用户只看到一条可滚走的 warning，问题中心没有记录，事后无法追溯「这次到底复核没复核」；与 P0-2「同步验收失败必须如实报 issue」的验收不完全一致。
- **修法**：`postError` 也 `reportIssue({code:'PCB_SYNC_VERIFY_FAILED'})`（带 executionId）；`syncExtra` 可降级为 `issue(severity:'warning')` 或至少在审计里显式写「多出 N 个器件未删除」。
- **验收**：断网/桥超时模拟复验失败 → 问题中心出现对应 issue；审计含 executionId 与失败原因。

#### P1-5 阶段推进无 Runtime 复核（前端派生证据即可推进并持久化）

- **证据**：`ProjectsPage.tsx:101-137` 与 `ValidationPage.tsx:322-333` 都是前端用 `deriveStageEvidence`（`stageEvidence.ts:22-55`）算证据后直接 `UPDATE_PROJECT`；Runtime 没有 `stage/advance` 之类的指令路由（`server.mjs` 无对应 path）。`stageMachine.ts:12-14` 注释也承认「真正权威是 Runtime 证据」，但代码里没有这层校验。
- **影响**：篡改 localStorage / devtools 里调用 dispatch（或直接构造 `source:'official'` 的 DRC 记录）即可把项目推到「生产/归档」，Runtime 项目状态随之写盘，审计里还会留下「官方 DRC 通过，阶段自动推进」。这使「阶段=已通过验证」的结论可被本地伪造。
- **修法**：新增 Runtime `POST /api/projects/:id/stage/advance`，服务端自行读取审批账本/执行历史/最新官方 DRC 摘要重算证据（与 release gate 同源），前端只发请求并展示返回的 blocking；或至少把 `evidence.digest` 一并提交并在服务端比对。失败/不一致返回 409 + 中文原因。
- **验收**：本地伪造官方 DRC 记录后点「推进阶段」→ Runtime 拒绝并给出真实缺口；正常证据链下推进成功且审计记录服务端复核算出的 digest。

#### P1-6 验证页列表/发现/进度条未按「当前项目 + 官方来源」过滤，跨项目混排

- **证据**：`ValidationPage.tsx:2238`（进度条分母 `state.validations.length`）、`:2239`（检查卡片 `state.validations.map`）、`:2243`（发现列表 `state.validations.flatMap`）都直接用全量数组；而 KPI（:298）与阶段证据已按 `officialValidationsForProject` 过滤。`state.validations` 不随项目切面加载（不在 project-state 载荷，见 P0-2），因此会残留其它项目的官方记录与所有种子/Demo 行。
- **影响**：切到项目 B 后，卡片/发现列表仍显示项目 A 的缺陷与 Demo 结果，用户可能按错误对象去修；进度条口径（含 Demo/他项目）与「真实验证覆盖」口径（官方 2 项）并存，同一屏两个百分比互相矛盾。
- **修法**：列表/发现/进度统一用 `officialValidationsForProject(state.validations, activeProject?.id)`；Demo/种子行单独分区展示并注明「不计入覆盖」；或按项目切片存储 validations（与 P0-2 一起做）。
- **验收**：切换项目后卡片/发现/进度只反映当前项目官方记录；Demo 行不出现在官方发现列表。

### 4.3 P2（5 个）

#### P2-1 交付页签角标仍数全部验证记录（含种子/Demo/他项目）

- **证据**：`DeliverPage.tsx:22` 注释与 `:36` 文案都声称「只统计官方 ERC/DRC」，但 `:32` 角标仍为 `state.validations.length`（全量）。
- **影响**：角标数字与旁边的「N 个检查发现待收口」口径不一致；E 类文案失真，用户会以为有 N 项官方检查。
- **修法**：角标改为 `officialValidationsForProject(...).length` 或直接显示官方检查数 2；保留「N 条演示记录未计入」提示。
- **验收**：只有种子数据时角标为 `0/2` 或「0 项官方」，与「待收口 0」一致。

#### P2-2 9 个 `runtimeClient` 方法无 UI 消费者（能力未接线）

- **证据**：脚本比对 `src/services/runtimeClient.ts` 的 async 方法在其余 `src/**` 中的引用，无消费者的方法：`listProjects`、`researchFetch`、`generateDesignPlan`、`normalizeProductionPlan`、`recordProductionFinalReview`、`engineeringProfiles`、`productionRelease`、`releaseArchive`、`orchestrationGoals`。其中 `recordProductionFinalReview`（POST `/api/production/reviews/final`）与正式导出要求的人工终审相关，但 UI 的「三方终审签核」走的是 `recordSignoff`（`/api/production/signoff`）。
- **影响**：不是死链（路由存在、无按钮指向它们），而是「服务端有能力、界面无入口」：终审证据出现两条并行契约（final-review 与 signoff），日后容易一边写一边读。属能力债，不阻塞当前流程。
- **修法**：确认 `recordSignoff` 是否为终审唯一契约；若是，删掉 final-review 路由或标注 deprecated 并在 types 注释说明；其余未用方法按「外部诊断/脚本用」标注保留理由。
- **验收**：类型/注释中能回答每个 Runtime 路由的入口（UI 或脚本），不存在两套并行终审契约。

#### P2-3 客户端注释与 P0-5 证据类别漂移

- **证据**：`runtimeClient.ts:267` `gatesEvaluate` 注释「评估门禁并归档报告（写 signoff 证据）」，而 P0-5 实际归档 `gate-report`（`VerificationCenterPage` 文案「评估并归档报告」；服务端 evidence 类别为 gate-report）。
- **影响**：纯注释误导，后续维护者可能按 signoff 证据去查账本，找不到。
- **修法**：注释改为「归档 gate-report 证据（不改 signoff 账本）」。
- **验收**：注释与 `runtime/*.mjs` 里实际 `evidenceStore.append` 的 kind 一致。

#### P2-4 禁用原因只挂在 `title`（hover），键盘/触屏不可发现

- **证据**：`AutomationPage.tsx:319-320`、`PlacementPage.tsx:224`（title）、`ValidationPage.tsx:1701-1711`、`LayerStackPanel.tsx:128`、`RoutingWritePanel.tsx:206` 等均把「为什么不能点」写在 `title`。
- **影响**：仅鼠标悬停可见；键盘 Tab 到禁用按钮（原生 disabled 不可聚焦）或触屏设备上，用户只能看到一个灰按钮，不知道缺什么，可操作性差（P0-6/P0-8 的「禁用原因可操作」打折）。
- **修法**：在按钮旁给 inline 提示（小字/`aria-describedby`），或把原因渲染到面板 header；禁用按钮用 `aria-disabled`+可聚焦包装以保留可发现性。
- **验收**：键盘/触屏用户无需 hover 即可知道每个禁用写按钮的缺失项。

#### P2-5 两个豁免入口并存，文案未区分

- **证据**：验证页同时存在「记录验证豁免」弹窗（`ValidationPage.tsx:847-852,2249`，本地）与「DRC 豁免」编辑器（`:503-548`，真实接口），两处按钮文案都含「豁免」。
- **影响**：与 P1-2 同源，用户分不清哪个能真正解除闸门阻断。
- **修法**：合并为一个入口，或在本地入口上方固定一行差异说明并链接到真实豁免面板。
- **验收**：页面上只有一个「豁免」语义入口能改变放行结论。

---

## 5. 验证记录

### 5.1 只读探活（未写任何状态）

| 探测 | 命令（只读） | 结果 |
| --- | --- | --- |
| 前端 dev server | `curl -s -o /dev/null -w '%{http_code} %{size_download}' http://127.0.0.1:4177/` | `200 733` |
| Runtime 健康 | `curl -s http://127.0.0.1:4178/api/health` | `{"ok":true,"service":"circuitpilot-runtime","version":"0.2.1","host":"127.0.0.1"}` |
| Runtime 根路径 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4178/` | `401`（token 保护，符合预期） |

> 运行中的 Runtime 是旧构建（由 Lead 说明，本次按要求未重启）：因此 `/api/write-gate`、`/api/eda/gates/*`、`/api/production/readiness` 等新路由**未做实测**，HTTP 层结论均来自 `runtime/server.mjs` 源码。这也意味着用当前实例验证 P0-3/P0-8 的端到端行为不可靠，需重启后才成立。

### 5.2 静态交叉核对

| 核对项 | 方法 | 结果 |
| --- | --- | --- |
| 客户端路径 ↔ 服务端路由 | 抽取 `runtimeClient` request 路径 142 条；`server.mjs` 精确路由 144 条 + 动态路由正则 25 条（`projects/:id/state`、`chat/sessions/:id/*`、`eda/commands/:id`、`automation/runs/:id/*`、`providers/:id/*`、`custom-providers/:id`、`pcb/design executions/:id`、`knowledge/entries/:id/review` 等），逐条匹配 | 24 条首轮未匹配项全部落在上述正则与 2 条带 `?query` 的精确路由（`dfm-evidence/latest`、`signoff/latest`）内，人工复核均存在 → **F（死链）= 0** |
| 按钮是否有 handler | 扫描 `src/pages/**`、`src/components/**` 所有 `<Button>`，缺 `onClick/onSubmit/href` 的报出 1 处 | 1 处为误报（`LayerStackPanel.tsx:123` 的 handler 在跨行属性 `onClick={requestWrite}`）→ **真死按钮 = 0** |
| 未接线的 client 方法 | 方法名在 `src/**`（除 runtimeClient 自身）中的引用统计 | 9 个无消费者（见 P2-2） |
| 写暂停名单覆盖 | 比对 `server.mjs:138-161` 的 `EDA_WRITE_ROUTES` 与所有 `{allowWrite:true}` 调用点（7 处） | 写路由全部在名单内或被 `bridge.execute` 的 `allowWrite` 二次拦截；`POST /api/eda/commands/:id` 未在名单内，但 `bridge.execute` 对 write 权限命令默认抛 `EDA_WRITE_BLOCKED`，不构成暂停绕过（文案码不同：`EDA_WRITE_BLOCKED` vs `EDA_WRITE_PAUSED`） |
| 门禁「未实现」与签字按钮一致性 | 读 `gate-engine.mjs` 的 verdict 汇总与 `VerificationCenterPage` 的 disabled 条件 | 一致：存在 `notImplementedGates` 时全局 `verdict='unknown'`，签字按钮 `disabled` 且 title 列出未实现门 |
| 写暂停徽标来源 | 追 `settings.writePaused` 的全部写入点：`SET_WRITE_PAUSED` 仅由 `writeGate()` 同步触发（AppContext.tsx:331-340）；设置页只在 POST `/api/write-gate` 成功后 dispatch（SettingsPage.tsx:292-310）；`eda.writePaused` 是会话级显式开关（EdaPage.tsx:623） | 徽标 = 二者 OR（Shell.tsx:44），**没有本地伪造「全局暂停」的路径**；但徽标不区分两种来源（P1-3） |

### 5.3 未执行项（受约束/不适用）

- **未跑 Playwright / 真机 E2E**：会写用户嘉立创EDA 工程，Lead 明令禁止；
- **未重启任何服务**：`:4177/:4178/:49620` 保持原状；
- **未执行 git**（工作区很脏，禁止 revert/commit）；
- **未对 Runtime 发 POST**：只用 GET `/api/health`；
- **未审**：`CircuitPilot-open-source/`（上游物料转储，非本仓产品代码）。

### 5.4 快照与波动说明

`src/pages/EdaPage.tsx`、`runtime/server.mjs` 的 mtime 为 2026-10-29 11:06（本次复审期间可能仍有人在改），`docs/implementation/flow-audit-2026-10-29/` 下也有他人正在写的文件。本报告 file:line 以 **11:16 快照**为准；若相关文件继续修改，矩阵需按新行号复核（结论层面不受影响，除非修复了 P0-1/P0-2）。

---

## 6. 附：建议的修复顺序（供 Lead 排期）

1. **P0-1**（Demo 抹掉官方证据）：改动小（过滤 + 二次确认），收益最大 —— 否则任何 Demo 验证都会让 P0-3 的成果看起来倒退；
2. **P0-2**（官方证据持久化 + 从 Runtime 自愈）：与 P1-6（列表按项目/来源过滤）一起做，一次把「验证记录的生命周期」收口；
3. **P1-5**（阶段推进服务端复核）：有了 P0-2 的服务端验证记录后，推进指令才能真复算；
4. **P1-1 / P1-3**（写暂停前端覆盖 + 镜像刷新）：纯 UI 改动，可与上面并行；
5. **P1-2 / P2-5**（豁免单入口）、**P1-4**（复验失败落 issue）、**P2-1**（角标口径）：文案/小改动；
6. **P2-2 / P2-3**（未接线方法与注释）：清理项，最后做。
