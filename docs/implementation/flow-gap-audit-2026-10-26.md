# CircuitPilot 全链路打通审计（2026-10-26）

> 问题：**全面检查还有哪些流程没有打通。**
> 方式：5 条链路并行只读审计（01 设计 / 02 PCB / 03 交付 / 04 平台 / 05 UI 接线）+ Lead 独立复核与基线实测；所有结论均以当前工作树代码为准，旧审计文档只当假设。
> 判定：✅ 已打通（UI→API→runtime 三段齐，且有测试或带日期真机证据）｜🟨 半打通（能跑但缺入口/缺校验/到不了下一步）｜🟥 断点或假成功｜⬜ 纸面｜🚫 产品边界。
> **本轮没有 EDA/Bridge**（4178 与 49620–49629 无监听、无 EasyEDA 进程），所有"真机"结论都是 2026-10-16～10-23 的历史证据，**本轮未复验**；本轮只做了可离线执行的测试与 Runtime HTTP 探针。

> **2026-10-29 更新：9 个 P0 已实现修复并带自动化测试**（本文件保留 10-26 审计为问题基线；修复记录见 §2.5）。
> **2026-10-29 复审修正：修复后另做了 5 链复审计，结论以 `flow-gap-audit-2026-10-29.md` 为准**：9 项中 6 项闭环，P0-3/P0-5/P0-9 降级为半打通（官方验证不持久、六门 G2–G4 无产品内生产者、知识建议在真实语料下恒空），并新发现 8 个未解决 P0（含签核锚点≠导出物、PCB 未绑 documentUuid、会话暂停仅前端）。§2.5 的"全部修复"仅指当轮实现与测试完成，不等于端到端打通。
> **2026-10-29 晚修复收口：复审发现的 8 个 P0 与 16 类 P1 已全部落地**（六门六类生产者、validation-state 持久化、导出/归档锚点、PCB 目标绑定/持久写锁、会话暂停与在途自动化中止、知识对话引用、AI 计划与原理图拆线文案等），逐项证据见 `flow-gap-audit-2026-10-29.md` §0.1。最新验证：typecheck ✅、vitest 196 ✅、runtime 全量串行 1281 ✅、build ✅、路由孤儿 0。**仍未连真机 EDA/live e2e**，真实板六门签字与干净机器首件导出仍需实测。
> 当轮修复验证：`npm run typecheck` ✅；vitest **186 通过**；runtime 串行 **1197/1197 通过**；`npm run build` ✅；路由契约孤儿 0。
> 真机链路需另跑 `CP_LIVE_EDA_E2E=1 node scripts/e2e-live.mjs`——本机 :4178 仍是修复前旧进程，未擅自重启用户会话，故未做真机写板复验。

## 0. 结论（2026-10-26 基线；P0 修复见 §2.5）

> 以下 9 个 P0 结论是修复前基线，保留用于对照；当前状态以 §2.5 与顶部更新为准。

1. **单点能力是真的，端到端主链是断的。** 取证（ERC/DRC/SPICE/3D/叠层）、PCB 写回（快照→写→逐项回读→独立复核→定点回滚）、自动化内核、项目持久化都能拿出实现+测试/历史证据；但「AI 计划→原理图→PCB→验证→放行→正式导出→归档」这条主链上有 **9 个 P0**，其中 2 处会**假成功**（落板、覆铜收尾），3 处默认 UI **永远走不到**（正式导出、readiness、六道门签字）。
2. **最危险的是一类"双口径"问题**：真实 ERC/DRC 结果不回写全局，Demo/seed 却计入概览与交付页 KPI；写暂停徽标显示"已暂停"但 Runtime 仍接受写入；六道门"评估"会以 `signoff` 名义落盘，反过来污染主链真实签核。这些不是缺功能，而是**同一事实有两个来源**，用户会据此得出错误结论。
3. **"有消费者"≠"打通"。** 服务端 173 条路由、客户端 154 条请求、160 条有消费者、孤儿 0；但 05 审计抽取 154 个 UI 动作，真正调用 Runtime 的 A 类只有 90 条（约 58%），B 类纯本地假动作 22 条、E 类 demo/seed 冒充 5 条。路由测试只证明"路径有人写"，不证明"结论可信"。
4. **可端到端走通的现实范围**：需求对话/约束/选型、PCB 自动布局与受控写回、ERC/DRC/3D 取证、草稿导出与诊断/Provider/项目持久化。**不可端到端走通**：原理图受控写入→落板→验证汇总→正式放行→正式导出→归档。

## 1. 端到端流程总览

| # | 流程 | 状态 | 一句话 |
|---|---|---|---|
| 1 | 需求对话 → 需求约束 → 选型检索 | ✅/🟨 | 对话与选型真接线；需求/建议是本地 reducer + 间接持久化 |
| 2 | AI 语义计划 → 编译 → 人工批准 → 原理图受控写入 | ✅（P0-1 已修） | 双哈希血缘贯通计划/批准/账本；不一致 409 |
| 3 | 原理图 → PCB 落板（同步） | ✅（P0-2 已修） | 期望位号回读比对，缺件失败回滚；空转有 `PCB_SYNC_NO_EFFECT` |
| 4 | PCB 自动布局 / 布线 / 铺铜 / 写回 | ✅（P0-4 已修） | 收尾覆铜读不到填充即失败且不保存 |
| 5 | ERC / DRC / SPICE / DFM / 叠层取证 | ✅ | 路由、落盘证据、历史真机工件齐全 |
| 6 | 验证结果 → 问题中心 / 概览 / 阶段机 | ✅（P0-3 已修） | 官方 ERC/DRC 单一来源回写，KPI/阶段机只用官方证据 |
| 7 | 放行闸门 / 验证中心 / 生产 readiness | ✅（P0-5/6/7 已修） | 统一 artifacts 根 + 真实 readiness 输入 + 门禁报告独立 kind；G1/G5/G6 显式未实现 |
| 8 | 人工 DFM/三方签核 → 归档发布版本 | 🟨 | 入口有，但归档硬要 planHash/reviewHash，UI 却标"可留空" |
| 9 | 生产文件导出（草稿/正式） | ✅（P0-6 已修） | 草稿→正式导出链路解锁；正式导出显式 `requested:'final'` |
| 10 | 下单 / 支付 | 🚫 | 产品边界：`orderEnabled:false`，全链禁止自动下单付款 |
| 11 | 项目 / 多项目隔离 / 持久化 / 追溯 | ✅ | Runtime 权威 + 切面写入 + 重启恢复（历史证据） |
| 12 | 自动化配方（执行/批准/中止/哈希链） | ✅（P0-8 已修） | 写暂停由 Runtime 磁盘权威状态前置阻断所有写路由 |
| 13 | 知识库（候选→审核→门禁引用→RAG） | ✅（P0-9 已修） | 门禁建议接真实消费者并写 usage；RAG 排除过期并标注 review/trust |
| 14 | Provider / 设置 / 诊断 / 日志 / 桌面壳 | ✅/🟨 | Key 走钥匙串、诊断包/脱敏真；设置无 Runtime 权威副本 |

## 2. P0 断点（按影响排序）

### P0-1 AI 语义计划与原理图/PCB 写入计划不是同一条链 — ✅ 2026-10-29 已修复
- 证据：AI 页把语义计划存草稿并跳 EDA（`src/pages/AiTasksPage.tsx:225-231`），EDA 页载入后编译成 **PCB 计划**（`src/pages/EdaPage.tsx:215-229`）；`normalizePcbPlan` 重建计划时只保留 board/operations/stackup，**丢弃 `semanticPlanHash`**（`runtime/pcb.mjs:106-112`）；批准账本只记录单一 planHash（`runtime/design.mjs:87-92`）。真正写原理图的是 EDA 页自己的「AI 网表草案」链路（`EdaPage.tsx:340-374`），与 AI 页计划无哈希关联。
- 影响：用户以为批准的是 AI 页那份计划，实际写入由另一份计划驱动；事后无法用账本证明"写的就是批准的"。
- 修法：PCB/原理图计划与批准令牌都携带并校验 `semanticPlanHash + compiledPlanHash`；账本条目写双哈希；UI 同时展示两值。
- 验收：AI 页生成→交接→批准→执行后，账本中两哈希均等于来源页显示值；任一不一致必须 409。

### P0-2 原理图→PCB「同步」可假成功 — ✅ 2026-10-29 已修复
- 证据：按钮只下发 `pcb.importChanges + pcb.save + pcb.drc`（`src/pages/EdaPage.tsx:242`）；桥注释明确该命令真机四组对照全部 0 器件（`runtime/bridge.mjs:472-477`，历史证据 `artifacts/wardrobe-case/pm-run-20261022/evidence/led-board-import-changes-r32.json` 显示 `compsAfterImport: 0`，需 CDP 点原生"应用修改"才落 19 件）；执行器回读只记录 `componentCount`，**从不与期望器件/位号比对**（`runtime/pcb.mjs:414,432-438`）；UI 仅凭 `state==='completed'` 提示"写入、保存、回读和 DRC 均已完成"（`EdaPage.tsx:259-266`）。
- 影响：PCB 链起点可以"没落一个器件却报成功"，后续自动布局在旧器件上做，用户毫无察觉。
- 修法：落板前记录 before 位号集合与期望集合，执行后强制比对；不达标直接失败并回滚；或改走 `pcb.component.create` 逐器件落板+读回（桥已具备，`bridge.mjs:470-479`）。
- 验收：原理图 12 件、PCB 8 件时点击必须失败并列出缺件；任何路径不得显示"已完成"。

### P0-3 验证结果双轨：真实结果不回写，Demo/seed 计入 KPI，阶段机死门禁 — ✅ 2026-10-29 已修复
- 证据：
  - 真实 ERC/DRC 只写组件内 state（`src/pages/ValidationPage.tsx:357-400`、`:522-546`）；
  - 写全局 `state.validations` 的只有 `demoAdapter`/演示路径，且标 `source:'demo'`（`ValidationPage.tsx:298-300,312-319,778`）；全仓**无代码写 `source:'official'`**（仅 `types.ts:667` 定义、`stageEvidence.ts:44` 读取）；
  - 种子数据预置 3 pass/3 warn/2 idle（`src/data/seed.ts:114-123`），首次打开就显示 75% 覆盖率；概览/交付页只按 status 计数，不过滤来源（`OverviewPage.tsx:22-35`、`DeliverPage.tsx:21,31`、`ValidationPage.tsx:293,1158`）；
  - 阶段证据：`drcPassed` 永远 false（`stageEvidence.ts:44`）→「验证→生产」永被阻断；`netlistApproved` 依赖的 `state.task.status='approved'` 与 `workspace.netlistExecutionId` **都没有写入者**（`stageEvidence.ts:33-37`；`types.ts:56-57` 仅类型）→「原理图→PCB」也永被阻断（`stageMachine.ts:91-98`）；
  - 真实 DRC 的 **findings** 不写 issues：`ValidationPage.tsx` 的 `reportIssue` 只用于"运行/导出失败"（`:305,321,948,1032`），不是把 DRC 违规条目落问题中心。
- 影响：概览"已验证 75%"是假的；问题中心收不到 DRC 条目；两个阶段推进按钮必失败；验证证据无项目归属（`ValidationCheck` 无 projectId），切换项目会串证据。
- 修法：新增"验证结果"权威投影（按项目 + 引擎 + 证据 digest），真实 ERC/DRC 成功时写 `source:'official'`；KPI 只统计 official；DRC findings 落 issue；`deriveStageEvidence` 改读项目域已持久化证据；`progress` 由阶段派生而非存储。
- 验收：全新安装显示"未运行/0%"；真机 DRC 后 KPI 更新、问题中心出现条目、"验证→生产"可推进；项目 A 的 DRC 不能推进项目 B。

### P0-4 布线收尾：读不到覆铜填充仍判成功并保存 — ✅ 2026-10-29 已修复
- 证据：`readFills` 读不到返回 null（`runtime/engineering/pcb-routing.mjs:925-932`），循环 `if (!fills) break` 后 `result.ok` 仍为 true（`:941`），`save && result.ok` 直接保存（`:957-960`）；UI 只看 `pours.rebuilt/saved`，不读 `ok/poursFilled/unfilledPours`（`src/components/RoutingWritePanel.tsx:161-169`）。
- 影响：可能保存一块"看似重建、实际没填充"的板；服务端返回 HTTP 200，调用方无法分辨。
- 修法：`fills===null` 视为 `PCB_POUR_FILL_UNKNOWN` → `ok:false` 且不保存；UI 显示 `poursFilled/unfilledPours/error.code`。
- 验收：mock `pcb.poured.read` 抛错时，`routing/finish` 返回失败、`saved:false`，UI 显示原因。

### P0-5 六道门 G1–G6 无证据生产者 + "评估"污染主链签核 — ✅ 2026-10-29 已修复
- 证据：G1/G5/G6 要求 `design-spec/placement/fabrication-release`（`runtime/gate-engine.mjs:9-16`），但全仓无这些 kind 的 `evidenceStore.save` 生产者（grep 仅测试与白名单）；布局写回只写 localStorage（`src/pages/PlacementPage.tsx:127-135`）→ `gates-service.mjs:52-58` 必然拒签，"签字放行"按钮常禁（`VerificationCenterPage.tsx:161`）。
- 更危险：`evaluate()` 把门禁报告以 `kind:'signoff'` 落盘（`runtime/gates-service.mjs:41-50`），而 release/export/readiness 全部用**不带 payload 类型过滤**的 `evidenceStore.latest('signoff')`（`server.mjs:1738,1752,1762,1816`；`release-decision.mjs:70-74`）→ 用户在验证中心点一次"评估"，会把最新 signoff 换成 gate-report，导致真实三方签核被遮蔽、统一裁决报"签核不通过/无效"。
- 修法：门禁报告改用独立 kind（如 `gate-report`）；`latest('signoff')` 校验 `payload.kind==='signoff-record'`；为 G1/G5/G6 补真实生产者（设计规格、布局复核、制造放行），否则先把这三门从"可签字"降级为"未实现"。
- 验收：点"评估"不影响交付签核；评估后归档仍能通过；三门在无证据时显示"未实现"而非"可签字"。

### P0-6 正式生产导出在默认 UI 接线下不可达（先有鸡还是先有蛋） — ✅ 2026-10-29 已修复
- 证据：
  - 正式导出按钮解锁要求 `gate.outputDecision.allowed && outputClass==='final'` 且 `releaseDecision.ready`（`ValidationPage.tsx:1617-1624`）；
  - 闸门路由固定按 `requested:'final'` 裁决，但 `draftPathsReplaced` 只有在请求体显式 `requested:'final'` 时才计算（`server.mjs:969-977,1734`）；UI 的闸门请求不带该字段 → `deliverables/` 根目录的 DRAFT 产物（`deliverables/manifest.json`，`GERBER_...-DRAFT-NOT-FOR-ORDER.zip` 等）恒触发 `STALE_DRAFT_MARKER`（`runtime/production-release.mjs:87-100`）→ 按钮永不解锁；
  - 即便解锁，导出端要求 `manifestHash` 等于按 `artifactsDir` 重算的值（`server.mjs:1813-1817`、`release-binding.mjs:44-61`），而 UI 唯一交接值来自 AssetsPage 按 `manufacturing/` 根算出的 hash（`AssetsPage.tsx:83`、`server.mjs:493`），两个产物根不同源 → `RELEASE_MANIFEST_MISMATCH`。
- 影响：当前默认工作流无法产出第一份正式命名文件；草稿导出可用，但正式交付只能靠手工改名/搬运绕过。
- 修法：① 闸门路由接受 `requested:'final'` 并复用 `selfDraftReplacedPaths`（与导出同一规则），让"本次将覆盖旧草稿"可被承认；② 统一产物根：readiness/导出/门禁都用同一个 `artifactsDir`（默认 `deliverables/`），交接 hash 也按该目录算；③ 把"缺正式产物需先导出草稿"的提示写清。
- 验收：干净目录 → 跑闸门 → 正式导出解锁；导出后文件名无 DRAFT、manifestHash 与签核绑定一致；mock e2e 覆盖。

### P0-7 生产 readiness 恒不可用（接线错误，不是"还没做"） — ✅ 2026-10-29 已修复
- 证据：`AssetsPage.tsx:49-78` 把语义计划哈希同时当 `compiledPlanHash`、把 `state.task.id` 当 `pcbExecutionId` 传给 readiness；`production.mjs:500-520` 要求：语义计划已登记、`compiledPlanHash` 等于重新编译值、PCB 执行记录存在且其 DRC passed、artifacts 在 `manufacturing/` 根齐全、DFM/signoff 绑定本计划与 manifestHash；UI 的入参使 `compiled-quality` 与 `official-pcb-drc` 必红，seed/demo 计划则直接 404 `PRODUCTION_PLAN_UNKNOWN`。
- 影响：「生产放行复核」按钮永远 blocked，无法作为交付依据；且它和 ValidationPage 闸门是两套结论，用户不知道该信哪个。
- 修法：readiness 入参改为 `planning.compiledPlanHash`（AI 计划响应已返回）；`pcbExecutionId` 取自 EDA 受控执行记录；artifacts 根与导出统一；长期与 ValidationPage 闸门合并成一条"生产放行"入口。
- 验收：AI 计划→受控 PCB 执行→DFM/签核绑定后 readiness 才 ready；缺任一环节必须给出精确 code（而非笼统 blocked）。

### P0-8 「全局暂停所有写入」只在前端 — ✅ 2026-10-29 已修复
- 证据：设置页承诺"最高优先级门禁，阻断所有 EDA 写命令"（`SettingsPage.tsx:409`），但 `writePaused` 只存在于 `src/`（`taskMachine.ts:37`、`Shell.tsx:44`、`EdaPage.tsx:120`）；`runtime/`、`src-tauri/src/`、`scripts/` **grep 0 命中**；签发写批准（`server.mjs:3444-3456`）、自动化运行（`:3480-3538`）、布局写回（`:2262-2285`）均不校验。自动化页/布局页的写动作也不检查（`AutomationPage.tsx:170,200`、`PlacementPage.tsx:101-130`）。
- 影响：暂停后仍能签发批准并写板；顶部徽标却显示"写入已暂停"，安全叙事失真（脚本/curl 亦可绕过）。
- 修法：Runtime 持久化写暂停状态（`/api/settings` 或独立 write-gate），在 `requireWriteApproval` 与所有写路由前置 fail-closed 返回 409 `EDA_WRITE_PAUSED`；UI 只展示 Runtime 状态。
- 验收：暂停后 `POST /api/automation/approvals`、`/api/automation/run`、`/api/eda/pcb/placement/apply` 全部 409；UI 按钮禁用且原因来自 Runtime。

### P0-9 知识库「approved → 门禁引用」最后一环不存在 — ✅ 2026-10-29 已修复
- 证据：UI 文案承诺"approved 才能进门禁引用"（`KnowledgePage.tsx:151,245`），但 `isUsableForGate`（`runtime/knowledge.mjs:484-491`）只被计数使用（`knowledge-api.mjs:46`）；`gate-* / release-* / production* / placement*` 对 knowledge 0 引用；引用闭环只在 `runtime/agents/orchestrator.mjs`，而它没有被 `server.mjs` import（唯一消费者是 `scripts/verify-knowledge-loop.mjs:13`）；`runtime/chat.mjs` 无 RAG/knowledge 引用；RAG 语料还包含 candidate 与过期条目（`rag/corpus.mjs:14`）。安装版运行态 392 条知识全部 candidate、approved=0（04 审计只读检查，2026-10-26）。
- 影响：审核通过与否对产品行为零影响；知识库退化成"可审的文档柜"；RAG 可能把未审核条目当依据返回。
- 修法：至少接一个真实消费者（放行建议/ERC 修复建议/badcase 任务）调用 `isUsableForGate` 并写 usage；RAG 默认过滤或标注 candidate/过期；对话引用时带审核状态。
- 验收：未 approved 条目不进入门禁建议；approved 后进入且 usage 有记录；RAG 命中显示 review/trust。

## 2.5 P0 修复记录（2026-10-29，本轮"开始完善"）

| # | 修复内容 | 关键文件 | 自动化测试 |
|---|---|---|---|
| P0-1 | 计划血缘双哈希：`normalizePlan`/`normalizePcbPlan` 保留 `semanticPlanHash`+`compiledPlanHash` 并参与 planHash；批准令牌/批准账本/执行记录同时绑定；计划被换掉 → HTTP **409 `APPROVAL_MISMATCH`**；EDA 页展示批准血缘两值 | `runtime/design.mjs`、`runtime/pcb.mjs`、`runtime/server.mjs`、`src/pages/EdaPage.tsx`、`src/types.ts` | `runtime/__tests__/design.test.mjs`（含 2 个 P0-1 用例）、`runtime/__tests__/plan-lineage-http.test.mjs`（2，409） |
| P0-2 | 落板比对 fail-closed：计划可带 `expectations.designators`，执行回读后逐项比对，缺件抛 `PCB_SYNC_INCOMPLETE` 并回滚；仅 importChanges 且板子无变化 → `PCB_SYNC_NO_EFFECT`；UI 先只读验收再决定写，执行后复验并报 issue | `runtime/pcb.mjs`、`src/pages/EdaPage.tsx`、`src/types.ts` | `runtime/__tests__/pcb.test.mjs`（3 个 P0-2 用例） |
| P0-3 | 验证单一来源：官方 ERC/DRC 回写 `state.validations`（`source:'official'`+projectId+evidence），KPI/阶段机/交付页只用官方结果；Demo/seed 不再计入，阶段推进改为证据驱动；新建 `validationEvidence` 服务与 `stageProgress` | `src/services/validationEvidence.ts`、`src/pages/ValidationPage.tsx`、`src/services/stageEvidence.ts`、`src/pages/OverviewPage.tsx`、`DeliverPage.tsx`、`stageMachine.ts` | `src/services/__tests__/validationEvidence.test.ts`、`stageEvidence.test.ts`、`stageMachine.test.ts` |
| P0-4 | 覆铜收尾 fail-closed：布线收尾重建后读不到覆铜填充 → `ok=false` + `PCB_POUR_FILL_UNKNOWN`，**不保存**；UI 显示错误并提示"本次没有保存"，成功时展示 `poursFilled` | `runtime/engineering/pcb-routing.mjs`、`src/components/RoutingWritePanel.tsx` | `runtime/__tests__/pcb-routing.test.mjs` |
| P0-5 | 六道门：门禁报告改用独立 kind `gate-report`（不再写 `signoff` 遮蔽交付签核）；交付签核 `latest('signoff')` 校验 `payload.kind='signoff-record'`；G1/G5/G6 无生产者 → 明确 `not-implemented`（UI 显示"未实现"，不参与可签字），G2/G3/G4 仍按证据裁决 | `runtime/gate-engine.mjs`、`runtime/gates-service.mjs`、`runtime/evidence-store.mjs`、`runtime/server.mjs`、`src/pages/VerificationCenterPage.tsx` | `runtime/__tests__/gate-engine.test.mjs`、`gates-service.test.mjs`（4）、`gates-p05-http.test.mjs` |
| P0-6 | 正式导出解锁：readiness/inspect/放行闸门/导出/DFM 统一以 `deliverables/`（`CIRCUITPILOT_ARTIFACTS_DIR` 可覆盖）为产物根；自产草稿替换清单传入 `decideProductionOutput`（`outputDecision` 不再丢失 `draftPathsReplaced`）；导出显式 `requested:'final'` | `runtime/release-gate.mjs`、`runtime/server.mjs`、`src/pages/ValidationPage.tsx`、`runtimeClient.ts` | `runtime/__tests__/release-gate.test.mjs`、`release-p06-http.test.mjs` |
| P0-7 | readiness 不再猜输入：真实读取语义计划草稿→`compileProductionPlan`→挑选 `completed && drc.passed` 的 PCB 执行，用真实双哈希+执行 id 调 readiness；缺任一环节给精确 code；获批输入落 sessionStorage 供交付导出复用 | `src/services/releaseBindingStore.ts`、`src/pages/AssetsPage.tsx` | `src/services/__tests__/releaseBindingStore.test.ts` |
| P0-8 | 写暂停进 Runtime：`WriteGateStore`（磁盘权威、原子写）+ 所有写路由前置 `409 EDA_WRITE_PAUSED`；GUI 仅放行只读 `state/screenshot`；`GET/POST /api/write-gate`；UI 以 Runtime 状态为准禁用写操作 | `runtime/write-gate.mjs`、`runtime/server.mjs`、`src/pages/SettingsPage.tsx`、`AutomationPage.tsx`、`PlacementPage.tsx`、`AppContext.tsx` | `runtime/__tests__/write-gate-http.test.mjs` |
| P0-9 | 知识库接真实消费者：门禁状态/评估返回 `knowledgeAdvice`，只用 `isUsableForGate`（approved+可信+未过期）条目并写 usage；RAG 语料默认排除过期条目，命中结果带 review/trust/gateUsable，UI 显式标注"候选未审核/已过期" | `runtime/knowledge-gate-advice.mjs`、`runtime/server.mjs`、`runtime/rag/corpus.mjs`、`src/pages/VerificationCenterPage.tsx`、`KnowledgePage.tsx` | `runtime/__tests__/knowledge-gate-advice.test.mjs`（3）、`gates-p05-http.test.mjs`（P0-9 段） |

## 3. P1（半打通/口径不一致）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1-1 | ERC/仿真/原理图验收证据不绑定 planHash/executionId | `runtime/design.mjs:325-333`；`ValidationPage.tsx:522-546,665`；`server.mjs:2961-3000` | 无法证明"这次写入的网表"通过了 ERC |
| P1-2 | DRC 条目不进问题中心/验证矩阵 | `ValidationPage.tsx:305,321,948,1032` 只报"运行/导出失败"，不落 DRC findings；对比 `EdaPage.tsx:265,312` 会把失败写成 issue | 问题中心看不到真实 DRC 违规 |
| P1-3 | DRC 豁免文件范围错位 | 面板用 global 文件（`server.mjs:2653-2656`），编辑器/闸门用 project 文件（`server.mjs:676-680,1311`） | 面板"已豁免"与实际放行口径不一致 |
| P1-4 | 128 条布局规则审计不落证据、不进放行闸门；规则中心"审计现状板"审的是 ESP32 fixture | `RuleCenterPage.tsx:44-61,104-108`；`server.mjs:3693-3708`；releaseGate client 无 `layoutAudit` 参数（`runtimeClient.ts:651-655`） | 规则审计与真实板/放行脱钩，看起来"审过了" |
| P1-5 | 阶段证据不持久、跨项目污染 | `stageEvidence.ts:29-44`；`types.ts:659-668` 无 projectId；task/validations 不在 project-state 载荷（`AppContext.tsx:157-176,261-265`） | 切项目/重启后证据串或蒸发 |
| P1-6 | 差分/等长/线宽/阻抗控制零产品入口；阻抗 solver 无调用；订单卡 `impedanceNets` 恒空 | `runtime/engineering/impedance.mjs` 仅测试引用；`server.mjs:2184`；`fabrication-order.mjs:143-146` | 勾选"阻抗控制"必被阻断，能力不可交付 |
| P1-7 | 归档硬要求 planHash/manifestHash/reviewHash，UI 却标"语义计划哈希可留空" | `runtime/release-archive.mjs:104-106`；`ValidationPage.tsx:1713`；`server.mjs:1762` | 未走 Assets 交接时归档必 400 |
| P1-8 | 价格/库存/DFM 只作 warning，不阻断放行/下单卡 | `release-gate.mjs:467-495,640-642`；`fabrication-order.mjs:172-178` | 缺货/过期料仍显示可下单参数 |
| P1-9 | RAG 索引不随知识/文档更新 | 仅空索引时懒构建（`rag/store.mjs:71-72`）；save/review 无失效信号 | 新审核知识搜不到，需手动重建 |
| P1-10 | 「联网检索」开关无消费者，KMA 后台默认联网 | `SettingsPage.tsx:256-266,351-356`；`server.mjs:517-534,1623-1625` | 用户关闭联网仍会外发请求，外发清单漏该通道 |
| P1-11 | 写入互斥只覆盖自动化 | `server.mjs:486` 锁只用于 automation；placement/routing/repair 无锁 | 跨页面并发写同一文档会互相踩踏 |
| P1-12 | e2e 1 条失败：`.provider-test` class 重复 | `SettingsPage.tsx:343,374` 同用该 class；`e2e/app.spec.ts:333` strict mode 命中 2 元素 | 测试漂移（非产品流程断），但 CI 红 |
| P1-13 | 打包资源疑似缺 `manufacturing/docs/knowledge/scripts` | 安装版 `/Applications/CircuitPilot.app/Contents/Resources/` 只有 `runtime/`；`tauri.conf.json` resources 含 manufacturing+两处 docs 但不含 `docs/knowledge`；RAG dirs 含 `docs/knowledge`（`server.mjs:540`） | 打包版可能生产资料/RAG 为空；安装包来源与仓库版本不一致，需重打包复验 |
| P1-14 | 设置无 Runtime 权威副本；运行模式两套口径 | 设置只 localStorage（`AppContext.tsx:258-265`），无 `/api/settings`；`runtime.mode` 与 Settings/Shell 各自计算（`AppContext.tsx:469`、`SettingsPage.tsx:116`） | 换机丢选择；徽标不可作写权限依据 |
| P1-15 | journal 固定 `~/.circuitpilot`，不随 state 目录；dev/安装版双状态源 | `runtime/automation/journal.mjs:36-41` vs `server.mjs:395`、`src-tauri/src/lib.rs:56-58,138` | 排障时"证据在他处"，卸载边界不清 |
| P1-16 | 无消费者 client 方法 9 个、约 20 条服务端路由无 client/UI | 见《05》§4；`productionRelease`、`releaseArchive` 详情、`normalizeProductionPlan`、`/api/eda/gui/*`、`/api/design/cancel`、`/api/design/capabilities/probe`、`/api/design/executions/:id/evidence` 等 | 能力有、入口无，需明确"产品化/删除/仅 CLI" |

## 4. 产品边界（不是缺陷，但要在 UI/文档里说清）

| 边界 | 证据 | 说明 |
|---|---|---|
| 自动下单/支付永久禁用 | `production.mjs:528`；`order-confirmation.mjs:39-53` | `orderEnabled:false`，系统只给参数与证据，绝不代替人下单 |
| 在线 DFM 只能人工回填 | `release-gate` 人工证据门；DFM 证据目录历史为空 | 需要登录态、上传与确认，本地检查不能冒充 |
| 原理图→PCB 的 EDA API 限制 | `bridge.mjs:472-477` | 官方 `importChanges` 空转，需要 CDP/GUI 兜底——本轮已列为 P0-2 修法 |
| 盲埋孔只有桥参数，无工艺入口 | `bridge.mjs:574-582,868-876`；`docs/implementation/multilayer-pcb-execution.md` | 多层 2..32 层已打通，盲埋孔未产品化 |
| 在线检索默认关闭且无内置 Key | `server.mjs:1623-1625` | 应改为"开关真实生效"（P1-10）而非假装 |

## 5. 已确认打通（不要重复修）

- 需求/对话/选型：`POST /api/chat/sessions/:id/messages`、`/api/library/proposals|plan`、10-21 聊天记录与 e2e。
- 批量落件 A6 **已有 UI**：`PartProposalPage.tsx:128-175`（计划→签发批准→执行），历史真机 dry-run `artifacts/a6-batch/real-batch-dryrun-20261020.json`。
- PCB 自动布局（真机 180 器件、板框读回、硬门禁拒写）、布线"规划→独立复核→拒写"、布局写回"快照→写→逐项回读→独立复核→定点回滚"、叠层 2→4 写后读回+保存、DRC 后台任务取证落盘并自动填闸门。
- 取证：ERC/DRC/SPICE/3D 导出/证据索引/时间线；`artifacts/evidence/drc-report/`（47 份）、`a13-erc`、`a9/a10/a11` 真机工件。
- 自动化内核：配方注册/参数预检/一次性批准/哈希链/中止/只读重放/审计包/恢复扫描/编排计划；历史 R1/R2/R6、`r2-r6-acceptance`、`e10/e11`。
- 项目：project-state 原子写、按项目切面、跨项目实体校验、重启恢复（`c1/c6` 历史证据）、trace/issue 持久化。
- Provider/Key/诊断/日志：16 provider 目录、连接测试、CLI 登录、自定义 Provider、钥匙串、4 外发端点披露、诊断包、日志脱敏（测试齐全）。
- 桌面启动链路：sidecar + token stdin + app data state（2026-10-20 package smoke，历史）。
- 草稿导出与 3D 导出：有真机产物；**正式导出**是 P0-6。

## 6. 建议修复顺序（先止血，再补齐）

1. **第 1 周（假成功/死门禁）**：P0-2 落板比对；P0-4 覆铜 fail-open；P0-8 写暂停进 Runtime；P0-3 验证结果单一来源 + 阶段证据项目域。验收全部用 runtime 单测 + 一条 e2e。
2. **第 2 周（放行主线打通）**：P0-6 导出解锁 + 产物根统一；P0-7 readiness 入参修正并合并口径；P0-5 六道门生产者/signoff 隔离。
3. **第 3 周（可追溯性）**：P0-1 双哈希贯通；P1-1 ERC 证据绑定；P1-2 DRC 进问题中心；P1-7 归档字段一致性。
4. **第 4 周（能力/体验）**：P1-4 规则审计进闸门；P1-6 阻抗入口；P1-9~P1-11 知识/联网/写锁；P1-12 e2e 选择器；P1-13 重打包复验。
5. 全部完成后，用 `CP_LIVE_EDA_E2E=1` 在真机把 7 条 skip 的 live e2e 跑一遍，才算"端到端打通"。

## 7. 本轮基线实测（可复现）

| 项 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | ✅ | 无输出错误 |
| `vitest run` | ✅ 25 文件 / 177 用例 | 前端单测全绿 |
| `node --test runtime` | ✅ ~1132 通过；7 失败仅沙箱 | 4 个失败文件在 `CIRCUITPILOT_AUTOMATION_DIR=$PWD/.tmp/automation-runs` 下重跑 **32/32 通过**；失败根因是 DSH workspace-write 沙箱拒写 `~/.circuitpilot/automation-runs`（EPERM），**不是产品回归** |
| `npm run build` | ✅ | built in ~1s |
| route-contract | ✅ 3/3 | 服务端 173 条（exact 152/pattern 21），客户端 154 条，有消费者 160，允许清单 15，孤儿 0；允许清单 2 条已过期待清理 |
| Playwright | 35 passed / 1 failed / 7 skipped | 失败为 `.provider-test` 选择器重复（P1-12）；7 skip 是 `CP_LIVE_EDA_E2E` 真机用例 |
| Runtime 探针（4199 + 独立 state） | ✅ | `/api/health`、`/api/project-state`、`/api/providers`、`/api/diagnostics`、`/api/knowledge/health`、`/api/rag/status`、`/api/projects`、`/api/trace-state`、`/api/issue-state`、`/api/timeline`、`/api/provider/egress`、`/api/eda/gates/approvals` 均 200；EDA 路由按设计返回 503 `BRIDGE_NOT_FOUND` |
| 真机链路 | ❌ 本轮不可验 | 无 EDA/Bridge；P0-1/2/4/6/7 的"真机可复现"均引用历史证据，修复后必须真机回归 |

## 8. 明细报告

- `docs/implementation/flow-audit-2026-10-26/01-design-chain.md`（AI 设计→原理图，P0×2）
- `docs/implementation/flow-audit-2026-10-26/02-pcb-chain.md`（PCB 布局/布线/铺铜/DRC/多层，P0×3）
- `docs/implementation/flow-audit-2026-10-26/03-deliver-chain.md`（验证→放行→导出→签核/订单，P0×3）
- `docs/implementation/flow-audit-2026-10-26/04-platform-chain.md`（自动化/知识库/持久化/Provider/运维，P0×2）
- `docs/implementation/flow-audit-2026-10-26/05-ui-wiring.md`（154 动作接线矩阵，假动作 27 条）

### 与旧审计的口径修正

- `docs/implementation/current-flow-gap-audit-2026-10-19.md` 的"布线/DRC 无 UI"已过时；本轮以代码为准。
- 生产终审已不是"内存 Map"：signoff 证据 + `production.json` 已落盘（仅存储损坏时大声降级内存）。
- 三套放行口径已收成 2.5 套（gate→outputDecision→releaseDecision 合并；`ProductionManager.readiness` 与 W5 六道门仍是另外两套，且均不可用）。
- `recordProductionFinalReview` / `engineeringProfiles` 已在 client 标注 `@legacy`（被三方签核/未产品化取代），**不计入未接线缺陷**。
