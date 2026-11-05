# 05 · UI 接线 / 路由契约 / 文案诚实性（只读审计 · 2026-11-05）

> 审计对象：CircuitPilot 前端 `src/`（18 个页面组件 / 14 个 PageId / 9 个规范页）↔ `runtime/server.mjs`（200 条可解析路由 + 3 条解析器盲区路由）↔ `src/services/runtimeClient.ts`（180 个 async 方法）↔ `src/state`。
> 基线：git 干净，HEAD `98429be`（2026-11-02）；基线 typecheck ✓ / vitest 228 / runtime 1455。
> 本次**只读**：未改源码、未触写操作、未启动 4177/4178、未跑 live e2e。唯一写入是本文件。
> 判定：✅ 已闭环｜🟨 半打通/口径缺一｜🟥 断点或失真｜⬜ 纸面/无入口｜🚫 产品边界（不可删/不可接）。

## ① 结论摘要

**总体：主写链（AI 计划→原理图/PCB 受控执行→布局/布线→验证/放行）的按钮门禁与失败反馈基本闭环（复审 10-29 的 P0 均已修）；本轮新发现集中在「会话级写暂停覆盖缺口」「能力声明文案与产品现状相反」「路由契约统计口径把测试当消费者」。P0 = 0。**

| 级别 | 计数 | 一句话 |
|---|---|---|
| P0 | **0** | 未发现"点下必死/假成功/官方证据被本地动作抹掉"的结构性断点（Demo 覆盖官方已由 `mergeDemoValidationRun` 修掉，ValidationPage.tsx:370-382）。 |
| P1 | **5** | 布局"还原"写操作不受写暂停保护；自动化两处危险按钮不认会话暂停；设置页两处能力声明与现状相反；概览宣称"检查已通过、可导出"；路由契约用"测试引用"当消费者，掩盖约 20 条产品级孤儿。 |
| P2 | **11** | 见 §3.4。含：未迁移长任务 5 处、9 个未接线 client 方法（4 个缺 @legacy）、交接残留无清理、Toast 丢标题、项目状态写回失败静默、禁用原因仅 title 等。 |

**必修验证记录（真跑）**

```
$ node --test runtime/__tests__/route-contract.test.mjs
[route-contract] 服务端路由 200 条（exact 174 / pattern 26 / prefix 0），客户端请求 179 条。
[route-contract] 路由统计：总数 200，有消费者 193，允许清单 11，孤儿 0。
[route-contract] 允许清单有 4 条可以清理（已接线或路由已删除）：
  - GET /api/research/status
  - POST /api/design/plan/ai
  - POST /api/production/reviews/final
  - POST /api/research/fetch
✔ 解析器覆盖三种路由定义形式 ✔ 路由静态解析 ✔ 不存在没有消费者的孤儿路由
ℹ tests 3 / pass 3 / fail 0（约 112ms）
```

**统计口径校正（与任务简报不一致处，如实记录）**

| 项 | 简报 | 实测 | 证据 |
|---|---|---|---|
| `KNOWN_UNWIRED_ROUTES` 条数 | 13 | **11** | route-contract.test.mjs:40-65 |
| runtimeClient 方法数 | 181 | **180 个 async**（179 走 `request` + 1 走裸 `fetch`） | runtimeClient.ts:993-995 |
| 页面数 | 19 | **18 个 .tsx 页面组件**（9 个规范页 + 页签壳） | `ls src/pages/*.tsx` |
| HTTP 路由 | 约 140+ | **200 条被契约解析 + 3 条不在解析范围 = 203** | server.mjs:1993/2000/2008 |

## ② 路由 / 动作矩阵

### 2.1 双向对账结果

| 核对项 | 方法 | 结果 |
|---|---|---|
| 客户端路径 → 服务端路由（死链） | 抽 179 条 `request` 路径 + 1 条 fetch 路径，对 200 条精确/正则路由逐条匹配 | **死链 0**（`downloadProductionArtifact` 走裸 fetch，靠白名单/测试兜住） |
| 服务端路由 → UI 消费者 | 条件①client 方法被 pages/components/state 调用；②路径字符串在 scripts/e2e/tests/src | 165 条有 UI 调用；44 条在 src 文本中出现；**11 条允许清单**；**孤儿 0**（按契约口径） |
| 契约解析盲区 | 手工枚举 205 条含 `method===`+`url.pathname` 的定义行 | **3 条 `.match()` 路由不在解析器覆盖内且全部有 UI 消费者**：`GET/PUT /api/projects/:id/state`（AppContext.tsx:308,429,485）、`GET /api/projects/:id/binding/verify`（ProjectsPage.tsx:84）——server.mjs:1993/2000/2008；故契约"孤儿 0"不覆盖这 3 条 |
| 按钮无 handler | 扫描 pages/components 全部 `<Button>`/`<button>` 的 onClick/onSubmit/href | **真死按钮 0**（2 处命中为 `ui.tsx:18,31` 基组件 props 透传） |
| 外部调用方（删除风险） | 扫 `plugin/dsh-circuitpilot/lib`、`scripts/`、`e2e/` | 3 条路由由 DSH 插件真实消费：`GET /api/projects`（tools.mjs:636）、`POST /api/design/plan/ai`（:1360）、`GET /api/design/executions/:id/evidence`（:1200）；`POST /api/production/plans/normalize` 由 e2e-live 脚本消费 |

### 2.2 `KNOWN_UNWIRED_ROUTES` 逐条判定（11 条，全部实测）

| # | 路由（key） | 服务端 | 现状/消费者 | 判定 | 建议 |
|---|---|---|---|---|---|
| 1 | `POST /api/design/cancel` | server.mjs:4052 | 无 client、无 UI、无脚本/测试引用；Agent token 可调（agent-auth 是 denylist） | ⬜ 真孤儿 | 接 EDA 页"中止执行"（与长任务取消联动），或删除；删除会减少 Agent 中止能力 |
| 2 | `POST /api/design/capabilities/probe` | server.mjs:4055 | 无任何消费者；"保留给流程编排"的编排器未接 | ⬜ 真孤儿 | 接 AutomationPage 能力探测，或删并改注释 |
| 3 | `GET /api/eda/gui/state` | server.mjs:4345 | 无消费者；AutomationPage 的 GUI 兜底只调 `/capabilities/probe` | ⬜ 真孤儿 | 接到 AutomationPage GUI 兜底面板（回读当前 GUI 状态） |
| 4 | `GET /api/design/executions/:id/evidence` | server.mjs:4076 | **有外部消费者**：plugin/dsh-circuitpilot/lib/tools.mjs:1200（cp_evidence） | ✅ 已接线（非 UI） | **🚫 不可删**；允许清单原因（:55）已过期，应改为"由 DSH 插件消费" |
| 5 | `GET /api/eda/commands` | server.mjs:2489 | 无消费者（`POST /:id` 有 UI；GET 清单无） | ⬜ 真孤儿 | 保留给诊断需补 CLI 证据，否则删除 |
| 6 | `POST /api/evidence/retention/prune` | server.mjs:3709 | 无消费者；注释（:58）称"只给 CLI/运维脚本用"，但 scripts/ 无任何引用 | 🟥 原因失真 | 保留（破坏性动作需 confirm+批准），但把原因改为"暂无入口，勿删"；若要接 UI 必须带二次确认 |
| 7 | `POST /api/design/plan/ai` | server.mjs:3995 | **有外部消费者**：插件 tools.mjs:1360；`runtimeClient.generateDesignPlan` 带 @legacy（runtimeClient.ts:559）无页面调用 | ✅ 已接线（非 UI） | 保留路由+@legacy 方法；允许清单原因（:59）"待接线或删除"改为"由插件消费" |
| 8 | `POST /api/eda/footprint/integrity` | server.mjs:3874 | CLI 经 **bridge 直连**（scripts/footprint-integrity-preflight.mjs:45-70 打 BRIDGE_URL，不走 Runtime HTTP） | 🟨 能力已消费、路由无入口 | 保留路由（供门禁/验证页后续接线）；原因（:60）准确 |
| 9 | `POST /api/production/reviews/final` | server.mjs:4598 | 无产品消费者；Agent 被拒（agent-auth.mjs:54）；仅测试引用；@legacy 方法存在（:653） | 🟨 能力债 | 与 signoff 二选一：确认 `recordSignoff` 为终审唯一契约后删除该路由，或接"终审登记"入口 |
| 10 | `GET /api/research/status` | server.mjs:2394 | 无 client/UI；设置页只调 search；"开关有消费者"指的是 `/config`，状态查询无 UI | 🟨 半打通 | 接设置页联网面板（显示真实 enabled/来源），否则删除 |
| 11 | `POST /api/research/fetch` | server.mjs:2377 | 无产品消费者；注释称"runtime 内部采集器调用"，但 runtime/ 内无 HTTP 自调用证据 | 🟥 原因待证 | 保留（Agent 可用）；把原因改为"暂无入口，供 Agent/采集器" |

> 另有**契约测试未覆盖但产品无入口**的路由（本轮新发现，按"测试引用"被误判为已接线）：`POST /api/eda/gui/execute`、`GET /api/supervisor/tickets`、`GET/POST /api/knowledge/usage`、`POST /api/eda/schematic/designators/set`、`POST /api/eda/pcb/pour/create`、`GET /api/automation/orchestration/goals`、`POST /api/production/release`、`GET /api/engineering/profiles`、`GET/POST /api/engineering/{fab,net,constraint}-rules`（6 条 audit 路由）、`GET /api/production/releases/:id`。合计约 **20 条**——它们不是死链，但"孤儿 0"是口径产物（route-contract.test.mjs:14-17 把测试算作消费者）。

## ③ 发现清单与修复建议

### 3.1 P1（5 条）

**P1-1 布局"还原到原位置"是写操作，但完全不受写暂停/会话暂停保护**
- 证据：`PlacementPage.tsx:140-147` `restore()` 直接 `issueAutomationApproval`→`applyPlacement({dryRun:false})`；按钮 `:225` `disabled={!plan}`（无暂停条件）；对照同页 `apply()` `:103-105` 只认 `state.settings.writePaused`，`:224` 同样漏 `sessionPaused`。
- 影响：Runtime 已暂停写入时按钮仍可点，点下才 409；会话级暂停被完全绕过（服务端 409 兜底，但 UI 违背"以 Runtime 状态为准"）。
- 修法：抽 `const writeGateClosed = settings.writePaused || settings.sessionPaused === true`（复用 RoutingWritePanel.tsx:23-24），接入 apply/restore 两处 `disabled`+`title`+函数首行守卫；测试：`PlacementPage` 在 sessionPaused 下两按钮 disabled。

**P1-2 AutomationPage「签发写批准」「运行配方」只认全局暂停，不认会话暂停**
- 证据：`AutomationPage.tsx:319-320` `disabled={... || state.settings.writePaused}`，无 `sessionPaused`；同页无 `writeGateClosed`。对照 `PartProposalPage.tsx:27-28,297`、`RoutingWritePanel.tsx:23,211-213` 已用 `writeGateClosed` 双口径。
- 修法：同上抽 `writeGateClosed` 接入两按钮 + `approve()/run()` 守卫；测试：会话暂停时按钮 disabled 且 title 区分"全局/本会话"。
- 风险：低（服务端 409 已在）；改动仅 UI。

**P1-3 设置页两处能力声明与产品现状相反（文案失真）**
- 证据：`SettingsPage.tsx:495`「验证通过后自动保存」描述"当前真实运行时尚未开放保存命令"——实际 `pcb.save` 已用于 PCB 执行/布线收尾/叠层（`RoutingWritePanel.tsx:188-189`、`LayerStackPanel.tsx:94`、`EdaPage.tsx:760` "已保存"字段）；`:497`「写入仍未开放 / 真实能力仅限诊断、窗口选择、工程与文档只读回读」——实际原理图/PCB/布局/布线/叠层写入链均已产品化并有批准门禁（`server.mjs:161-181` 18 条写路由）。
- 修法：改为"写入默认关闭，需计划哈希+一次性批准+快照；当前已开放：原理图/PCB 受控执行、布局/布线/叠层写回"；`autoSave` 描述改为"导出/落盘行为见验证页"或删除该开关（无后端消费者）。测试：文案断言 + `SettingsPage` 快照。

**P1-4 概览宣称"检查已通过，可导出"，判据只有官方 ERC/DRC，忽略放行闸门/人工证据/需求完整度**
- 证据：`OverviewPage.tsx:72` 主 CTA 返回 `{hash:'validation', label:'生成交付包', hint:'检查已通过，可导出'}`，判据是 `idle`（官方检查未运行数）与 `openFindings`；`:123` 空态写"需求已确认、检查已通过。可以直接进入交付"。而正式导出另需本地门禁+人工 DFM/三方签核（`ValidationPage.tsx:1869-1875` 双钥匙），需求完整度 `requirementCompleteness`（AppContext.tsx:667）也未被该空态检查（`missing/conflict` 之外的 `suggested` 才会生成决策卡）。
- 修法：`primary` 与空态文案降级为"官方检查已运行，进入交付核对放行证据"；或把 `releaseDecision.ready`/人工证据状态（可从 `state.validations`+`gate` 无法派生，建议加只读 `/api/eda/gates/status` 摘要）纳入。测试：`OverviewPage` 单测断言不出现"可导出"除非 gate ready。

**P1-5 路由契约把"测试引用"当消费者，"孤儿 0"掩盖约 20 条产品级孤儿；另有 3 条 `.match` 路由与 1 个 fetch 客户端在解析盲区**
- 证据：`route-contract.test.mjs:14-17`（判定条件②明确"脚本与测试也算消费者"）、`:245-261` 语料含 `runtime/__tests__`；本轮实测 20 条路由只在 `runtime/__tests__` 出现（如 `POST /api/eda/gui/execute` 仅 write-gate-http/g3-computer-use/agent-auth 引用）；`server.mjs:1993/2000/2008` 用 `url.pathname.match(/^\/api\/projects\/.../)`，不在三种解析形式内；`runtimeClient.ts:993-995` 用裸 `fetch`，契约只解析 `request(`。
- 修法：①测试增加"产品级消费者"断言：`runtime/__tests__` 不算数（或单列 `KNOWN_TEST_ONLY_ROUTES` 清单并写明原因）；②解析器补 `.match()` 形式与 fetch 客户端（或至少在报告里标注 203 条）；③清理 4 条"可清理"误报（research/status、design/plan/ai、reviews/final、research/fetch 的判定来源全是测试/插件）。
- 验收：`node --test runtime/__tests__/route-contract.test.mjs` 输出真实产品孤儿清单（预期 ≈20 条），且插件消费的 2 条不被列为可删。

### 3.2 P2（11 条，精选证据）

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| 1 | `getExecutionGate` 不认 `settings.sessionPaused`（跨窗口会话暂停可绕过） | taskMachine.ts:33-39（只查 `eda.writePaused || settings.writePaused`）；EdaPage.tsx:344-348 对话执行只靠此门禁 | 门禁加 `settings.sessionPaused !== true`；或调用方统一 `writeGateClosed` |
| 2 | LayerStackPanel 写暂停跨窗口不同步 + 确认框无守卫 | LayerStackPanel.tsx:33 用 `eda.writePaused`（仅本地镜像）而非 `settings.sessionPaused`；`:204` `onConfirm={() => void write()}`，`write()` `:78-90` 无守卫 | 用双口径 + 函数首行守卫 |
| 3 | 长任务未迁移 5 处 | LayerStackPanel.tsx:89-90（setPcbLayers 180s 裸等）；VerificationCenterPage.tsx:83（gatesCollect 60s）；SettingsPage.tsx:204（diagnosticBundle 60s）；AssetsPage.tsx:76-130（readiness 三步链无取消）；AutomationPage.tsx:195-230（run 600s 裸等，仅有独立 abort 按钮） | 统一 `createSingleCallTask`，并注明"取消只停止本页等待" |
| 4 | 9 个未接线 client 方法；4 个缺 @legacy | 无 src 调用：`listProjects`、`researchFetch`、`generateDesignPlan`(@legacy:559)、`normalizeProductionPlan`(@legacy:631)、`recordProductionFinalReview`(@legacy:653)、`engineeringProfiles`(@legacy:658)、`productionRelease`(@legacy:770-771 双注释)、`releaseArchive`(:797-803)、`orchestrationGoals`(:877-883)。缺 @legacy 的 4 个：listProjects/researchFetch/releaseArchive/orchestrationGoals；另 runtimeClient.ts:652-653 有悬空旧注释、:770-771 双 @legacy | 4 个补 @legacy 或接线；删除重复注释；确认 `productionRelease` 无旧调用方后删方法 |
| 5 | 交接残留无清理/无项目绑定 | `clearReadinessInputs` 从未被调用（releaseBindingStore.ts:46）；`circuitpilot:release-binding` 写后不删（AssetsPage.tsx:123 → ValidationPage.tsx:66-84 无条件读取）；draftStore 无 projectId/过期（draftStore.ts:12-31；EdaPage.tsx:200-211/215-225 挂载即导入） | 读时校验项目/时间戳；交接消费后 clear；draft 增 projectId |
| 6 | 写暂停镜像只在启动/focus 同步，写前不刷新 | AppContext.tsx:336-350 | 写操作前调一次 `writeGate()`，或 409 时强制对齐 |
| 7 | Toast 丢标题（所有 notify 的 title 不渲染） | overlays.tsx:85 只渲染 `toast.message`；ToastMessage.title 定义于 types.ts:984-989，`notify` 写入 AppContext.tsx:577-581 | 渲染 title+message（或拼接） |
| 8 | 项目状态写回失败静默，但与"已保存"文案冲突 | AppContext.tsx:487-503 仅 `logger.warn`；ProjectsPage.tsx:76-78 直接 `notify('已保存')`；对照 validation-state 失败会 `REPORT_ISSUE`（AppContext.tsx:384-416） | 项目写回失败落 issue 或 toast 降级为"已保存到本机" |
| 9 | "全局暂停所有写入"文案 > 实际范围 | SettingsPage.tsx:495 label；server.mjs:161-181 仅 18 条 EDA 写路由（证据/导出/签核不暂停） | label 改"暂停所有 EDA 写入" |
| 10 | 幽灵/不可点入口 | SettingsPage.tsx:374「前往EDA控制检查」是 `<small>` 纯文本，无链接/按钮 | 改为可点 `navigate('eda')` 或删除"前往"字样 |
| 11 | a11y 概述 | 禁用原因仅 `title`（AutomationPage.tsx:319-320、LayerStackPanel.tsx:128、PlacementPage.tsx:224）；**已做对**：Toast 有 `aria-live="polite"`（overlays.tsx:85）、模态有焦点陷阱/恢复（overlays.tsx:15-46） | 禁用原因用 inline 小字/`aria-describedby` |

### 3.3 ✅ 本轮复核确认已闭环（避免重复修）

- Demo 全量运行不再抹掉官方 ERC/DRC：`mergeDemoValidationRun`（ValidationPage.tsx:370-382）、Demo 行单独分组不计覆盖（:322-323, 2406-2409）；交付页角标已按"当前项目+官方"（DeliverPage.tsx:22-36）。
- 官方验证持久化 `/api/validation-state` 已接：AppContext.tsx:364-416（失败落 issue）。
- 写暂停服务端前置 409（server.mjs:161-181,1728）+ 设置页必须 Runtime ack（SettingsPage.tsx:353-365）+ 主要写按钮双口径禁用（EdaPage.tsx:130-136,711,760；RoutingWritePanel.tsx:23,98,126,153,211-213；PartProposalPage.tsx:27,156,297；ValidationPage.tsx:1278-1279,2050）。
- 长任务迁移已覆盖 7 个文件（longTask.ts + LongTaskPanel）；叠层/布线收尾"已保存/未保存"如实区分（LayerStackPanel.tsx:188、RoutingWritePanel.tsx:188-189）。
- 导航/深链无死路：`LEGACY_ALIASES` 全部落到规范页（navigation.ts:56-62；App.tsx:31-40）；Supervisor「去处理」只跳现有页（SupervisorPanel.tsx:24,218）。

## ④ 诚实边界

1. **未做 live/真机验证**：未连 EDA/Bridge、未重启 4177/4178、未跑 Playwright/acceptance；所有"按钮可点/不可点"结论来自静态代码，Runtime 409 兜底为代码级结论。
2. **数值口径**：路由 200 为契约解析数，另有 3 条 `.match()` 路由（实际 203）；客户端 180 方法中有 1 个走裸 `fetch` 不在契约统计内（179）；页面 18 个组件（简报 19）；allowlist 实际 11 条（简报 13）。
3. **未覆盖**：`CircuitPilot-open-source/`、`src-tauri/target/**`（构建产物副本，不计消费者）；plugin 只用于判断"外部调用方风险"，未审计其自身逻辑；a11y 只做概述未逐条。
4. **未验证的外部调用方**：除 DSH 插件（3 条路由）与 e2e-live 脚本（normalize）外，不排除有仓外脚本/curl 直接调 Runtime HTTP，故对"孤儿路由"的删除建议一律先改注释/保留，不直接删。
5. **本轮为收口版**：P2 的 3 条（draftStore 项目绑定、AssetsPage readiness 链取消、AutomationPage run 迁移）证据充分但修复方案未与产品/写锁设计对齐，标为"建议"而非"结论"。
