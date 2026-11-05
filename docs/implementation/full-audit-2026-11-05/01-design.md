# 01 设计链闭环审计（设计链：需求 → AI 计划 → 批准 → 原理图/网表写入 → ERC → PCB 交接）

> 审计日期：2026-11-05 · 方式：只读静态审计 + 隔离状态目录下的单文件 runtime/vitest 测试 + 只读状态文件核查。
> 基线：HEAD `98429be`（2026-11-02），任务书给的基线为 typecheck 通过 / vitest 228/228 / runtime 1455/1455。
> **本报告未跑全量 acceptance、未连接 EDA/Bridge、未跑 live e2e、未启动 4177/4178、未改源码**；基线数字不被本报告采信，只采信下面 §附录A 自己跑出的数字。
> 判定口径：✅=代码+路由+UI+测试/证据齐｜🟨=半闭环（缺消费者/缺数据/缺真机）｜🟥=断点或假成功｜⬜=纸面｜🚫=产品边界/真机不可验证。
> 证据范围：`docs/implementation/{README.md,circuitpilot-completion-checklist.md,flow-gap-audit-2026-10-29.md,flow-audit-2026-10-29/01-design.md}` + `runtime/**` + `src/**` + `artifacts/state/**` 的真实落盘数据。

---

## ① 结论摘要

### P0（2 项：主链是否真的能走通 / 血缘是否真的连到头）

1. **P0-1｜原理图受控执行的"连线"主通道从无真机成功证据，且依赖历史上"静默无效"的 `schematic.wire.create`**：`runtime/design.mjs:529-536` 把 `net.connect` 编译成 `schematic.wire.create`，回读靠 `schematic.wires` 几何（`design.mjs:570-582`）；而 checklist A7 的真机结论是 `sch_PrimitiveWire.create` 静默无效、改走 `createNetPort`（`circuitpilot-completion-checklist.md:85-92`；`whole-board-progress.md:544`）。工作区 `artifacts/state/design-executions.json` **不存在**、批准账本 500 条中血缘条目 **0**（§附录B），所以"AI 网表 → 受控写入原理图"这一步只有假桥单测，真机可能全链阻断（fail-closed，不会假成功，但主按钮路径不可完成）。🟨/🚫。
2. **P0-2｜设计链会消费掉交付链 readiness 的唯一输入，design→交付 的同一 planHash 链在跨页处断开**：EDA 页"确认方案并准备执行"成功后 `clearSemanticPlanDraft()`（`src/pages/EdaPage.tsx:280`），而生产放行 readiness 的唯一计划来源就是同一份 sessionStorage 草稿（`src/pages/AssetsPage.tsx:70-77`），服务端还要求该计划在本 Runtime 会话内登记（`runtime/production.mjs:498-503`）。结果：走完设计链后 readiness 必报 `PRODUCTION_PLAN_MISSING`，只能回 AI 页重新生成（哈希会变，`finalReview`/readiness 绑定随之失效）。🟥。

### P1（10 项：有实现但消费者/绑定/证据缺一环）

1. **P1-1｜"选型提案 → 设计批准"全程同一 planHash 结构性不成立**：`EdaPage.tsx:461` 在重新校验前把提案哈希塞进 `semanticPlanHash`，lineage 参与哈希 → 校验后 planHash 必然不同（§附录A-5 实测 `1b495c6f…≠47895cc9…`），批准令牌绑定的是另一个哈希；UI 因此**每次**都弹"计划被编辑过"误导警告，且把一个批量计划哈希命名为"语义计划哈希"。checklist A3 标 ✅（`circuitpilot-completion-checklist.md:43-49`）、验收写"全程同一 planHash"。🟥（对 A3 验收）/🟨。
2. **P1-2｜AI 语义计划链与原理图写入链仍不共享任何 ID/哈希**：`runtime/chat.mjs:735` 调 `compileReviewedNetlist(value.netlist)` 时不传 lineage（`runtime/netlist.mjs:63` 支持但无人传），原理图执行记录 `semanticPlanHash/compiledPlanHash` 恒 null，批准面板"批准血缘"对这条链恒显 `— / —`（`EdaPage.tsx:760`）。RP0-8 已按方案②诚实拆线并改文案（`AiTasksPage.tsx:230`、`EdaPage.tsx:205`、`flow-gap-audit-2026-10-29.md:32`）→ 文案诚实，但产品级"AI 设计 → 原理图写入"未闭环。🟨。
3. **P1-3｜批准→执行的目标漂移校验可被"静默降级"，且不校验目标页 == 项目绑定页**：UI 侧 `designTargetBinding` 读不到 uuid 就传 null（`EdaPage.tsx:176-190`），服务端对空绑定直接跳过校验且无告警（`runtime/design.mjs:447-450,480,276-279`）；打开原理图时 `openProjectSchematic` 不比对返回的 `documentUuid` 与项目登记的 `schematicPageUuid`（`EdaPage.tsx:448-457`），`open-current` 空 uuid 回落"第一张合法页"（`runtime/server.mjs:3986-3990`）；项目↔EDA 绑定校验只作为项目页手动按钮存在（`runtime/server.mjs:2008-2060`；`ProjectsPage.tsx:80-88`），不在批准/执行路径上。🟨。
4. **P1-4｜原理图写入无跨路由/跨进程互斥，且原理图写锁不可见、不可解除**：`design.mjs` 只有实例内 `running/writeLocked`（`design.mjs:369,474,622`），而 `eda-write-lock.mjs:77` 的跨进程锁**只有测试在消费**、`server.mjs:62` 是未使用导入（全仓 0 调用点）；原理图锁既无 status 路由也无解绑路由（对比 PCB：`server.mjs:4063-4068`）。因此 batch/designators/repair/net-connect 与 `design.execute` 可并发写同一份原理图；回滚失败后只能重启 Runtime（`design.mjs:474` 文案自认）。🟨。
5. **P1-5｜写入读回断言不覆盖"已审核网表 → 实际原理图"身份**：`design.mjs:563-582` 只验"源码 digest 变了 / 新建 primitiveId 还在 / 导线几何 / noConnect 引脚"，`component.create` 不读回位号/库身份（网表 `ref` 根本没写进操作，`netlist.mjs:57`），`netlistHash` 无任何消费者（全仓只有 `netlist.mjs:32` 产生）。所以"写进去的是不是用户审核过的那张网表"只能靠客户端重算，没有服务端/读回证据。🟨。
6. **P1-6｜ERC/网表一致性结论不到放行/导出裁决，且 ERC 证据无内容绑定/新鲜度**：`release-gate.mjs:637` 的 `netlistEvidence`/`rulesEvidence` 子门在服务端**没有任何生产者**——`gatherReleaseEvidence`（`server.mjs:1444-1641`）从不返回这两个键，全仓也只有 `gate-engine.test.mjs:94` 直接调纯函数时传过；ERC 归一化结论只进六门 G4（`gates-evidence.mjs:234-253`；`server.mjs:2135-2141`）与六门签字面板（`VerificationCenterPage.tsx:83-131`），不进 `production/release|export|readiness|archive` 裁决。另外 ERC 证据 fingerprint 只有 window/project/document（`server.mjs:3595-3597`），没有设计内容摘要，`gates/collect` 只按 projectUuid 取 latest，`evidence-freshness.mjs` 只被仿真证据使用（`server.mjs:877`）→ 旧 ERC 结论可被当"当前"证据。🟥（死门）/🟨。
7. **P1-7｜pin evidence / assumption 门禁的输入是客户端自报，且不持久化、不绑定**：`pin-evidence.mjs:118-126` 只审计调用方传进来的对象（服务端不复采），`server.mjs:3154-3185` 采集路由**不落证据库**、无 digest 持久化，`server.mjs:4006-4025` 只对请求体里的 `pinEvidence` 做形状审计；`strictAssumptions` 前端从未发送（`grep src/` 0 命中），`assumptionAudit` 只在"待审核网络表"原始 JSON 里可见（`EdaPage.tsx:760`）。EdaPage 的 pin 审计阻断是真实的（`EdaPage.tsx:474-491`），但"从零设计"无 PCB 时按设计跳过（`EdaPage.tsx:485-490`）。🟨。
8. **P1-8｜阶段证据（schematicGenerated/netlistApproved）是前端自报，服务端不校验且不受写暂停约束**：`EdaPage.tsx:587` 执行成功即写 `schematicStatus/schematicExecutedAt/schematicExecutionId`；`stageEvidence.ts:22-55` 只认这些字段；`PUT /api/project-state` 对载荷**不做任何校验**（`server.mjs:1973-1979`），且不在写路由表（`server.mjs:161-180`）里，Agent 令牌也能调（`agent-auth.mjs` denylist 未含该项目状态路由）→ 任何本机脚本/Agent 都能伪造"原理图已生成/网表已批准"；需求或计划变更只作废 task 批准（`AppContext.tsx:76-77`），不作废该证据，PCB 同步按钮仍亮。🟥（可伪造）/🟨。
9. **P1-9｜Agent 通道可以"自批"设计写入**：`server.mjs:4034-4040` 只要求 Agent 带 `confirm=true && approvalMode='chat'`，这两个字段由 Agent 自己填；`agent-auth.mjs:62-66,145-149` 对 `/api/design/approve`、`/api/pcb/approve` 做了精确豁免，`/api/design/execute`、`/api/pcb/execute` 又不在拒绝清单 → 只要写暂停没开、token 有效，Agent 可以"批准→执行"一条龙。README 写"不允许 AI 自批写入"（`docs/implementation/README.md:32-33`）只是插件自觉，不是服务端事实。🟨（治理）。
10. **P1-10｜需求的结构化硬约束不进计划/批准，只在末端放行门（且可 fail-open）**：`normalizePlan`（`design.mjs:91-129`）与 `normalizeSemanticPlan/compileSemanticPlan`（`production.mjs:171,320`）都没有约束字段/`constraintReport`（全仓 grep 0 命中），需求只作为 AI 提示词文本（`chat.mjs:679,699,721`）；约束真正生效只在放行门（`release-gate.mjs:497-510,634`），而空约束时它给 info、不阻断（`release-gate.mjs:498-500`），设计事实靠人工录入（`ValidationPage.tsx:1774-1789`、`src/services/designFacts.ts`）。需求页却写"AI 只能在已确认的约束边界内规划写入"（`RequirementsPage.tsx:36`）——无实现。🟨。

### P2（6 项：文案/一致性/展示，不阻断但会误导）

1. **P2-1｜DRC 结论文案失真**：执行面板把基线模式的"无新增 error"显示成"官方检查通过"（`EdaPage.tsx:760`），面板名叫"原理图 DRC（ERC等效）"，执行历史列也写"通过"（`EdaPage.tsx:777,785`）；基线语义见 `design.mjs:168-213`。🟨。
2. **P2-2｜计划编辑器的脏状态丢失**：校验后改 JSON 文本，批准/执行仍用旧的 `planning.plan`（`EdaPage.tsx:461,503,581`），无"已修改需重新校验"标记，用户会批准/执行一份与屏上文本不同的计划。
3. **P2-3｜落位可读性审计无消费者**：`compileReviewedNetlist` 产 `layoutAudit`（`netlist.mjs:64-73`）但刻意不进 plan、EDA 页也没有任何渲染（`grep layoutAudit src/pages/EdaPage.tsx` 0 命中）；重叠/可读性发现到不了人眼前，也进不了批准门禁。
4. **P2-4｜`TARGET_DRIFT` 发生在令牌 consume 之后且是 400**：`design.mjs:480` 先消费令牌，`:485` 才抛无 status 的 `TARGET_DRIFT`（→400，令牌已烧）；PCB 同类（`pcb.mjs:750-752` consume 后才判 binding）。应 consume 前校验并返回 409。
5. **P2-5｜执行历史/血缘展示不全**：历史表只有 planHash、无 `semantic/compiled` 列（`EdaPage.tsx:777`）；原理图链的"批准血缘"恒为空（见 P1-2）。
6. **P2-6｜按钮/编号/确认框语义不一致**：主流程"2. 生成并审核原理图"（`EdaPage.tsx:724`）实际只生成网表草案、写入在高级面板"5. 生成原理图"（`EdaPage.tsx:760`）且面板步骤又从 1 开始编号；`requestConversationExecution` 的最终确认框把"签发一次性写批准 + 执行"合并在一次点击里（`EdaPage.tsx:342-352,804`），确认框不展示 planHash/血缘。另 `plan-requests` 消费已批准请求时不校验 store 里已记录的 projectId/documentUuid（`plan-requests.mjs:397-421`）。

### 计数

| 等级 | 数量 |
|---|---|
| P0 | **2** |
| P1 | **10** |
| P2 | **6** |

---

## ② 闭环矩阵

图例：✅ 已闭环（代码+路由+UI+测试）｜🟨 半闭环｜🟥 断点/假成功｜⬜ 纸面｜🚫 真机不可验证。

### A. 需求 → 结构化约束 → 计划/门禁

| # | 环节 | 期望链 | 实际证据（file:line） | 判定 | 缺什么 |
|---|---|---|---|---|---|
| A1 | 需求 → 结构化约束归一化 | confirmed+hard 需求 → 可机检约束 | `runtime/constraints.mjs:34-133`；测试 `runtime/__tests__/constraints.test.mjs`（本轮 28 passed 组内） | ✅ | —（只覆盖 5 类可量化约束，其余 unclassified 需人工） |
| A2 | 结构化约束 → 计划/批准 | 计划编译输出 `constraintReport`，违反约束的计划不可批准 | `design.mjs:91-129`、`production.mjs:171,320` 均无约束字段；全仓 `constraintReport` 0 命中 | 🟥 | 计划层完全无约束校验；AI 只把需求当提示词（`chat.mjs:679,699,721`） |
| A3 | 结构化约束 → 放行门 | 放行报告逐条 pass/fail/unknown | `release-gate.mjs:497-510,634`；UI 透传 `ValidationPage.tsx:1096-1097,1332-1333`；设计事实人工录入 `:1774-1789` | 🟨 | 设计事实手工录入（无 EDA 读回采集）；空约束 fail-open（`:498-500`）；到不了设计计划 |
| A4 | 需求 → 六门 G1 规格门 | 每条已确认需求映射到验收证据 | `VerificationCenterPage.tsx:83-99`；`design-spec.mjs:26-37,470-500`（REQUIREMENT_UNMAPPED） | 🟨 | 需人在验证页手动"六门取证"；与放行门是两套并行的需求判定 |
| A5 | 需求/计划变更 → 证据作废 | 需求变化使旧计划/批准/阶段证据失效 | `AppContext.tsx:76-77`（只作废 task 批准）；`EdaPage.tsx:587` 写的 `schematicStatus` 不作废 | 🟨 | 设计证据无失效机制（见 P1-8） |

### B. AI 计划 → 双哈希血缘 → 人工批准

| # | 环节 | 期望链 | 实际证据 | 判定 | 缺什么 |
|---|---|---|---|---|---|
| B1 | AI 语义计划生成（PCB 链） | 结构化候选 + 阻断问题 | `production.mjs:171,320`；`AiTasksPage.tsx:191-219` | ✅ | 真机/真实模型输出未在本轮复核 |
| B2 | 语义计划跨页草稿（AI 页→EDA 页） | 结构化计划+planHash 过页，重编译后哈希可核对 | `draftStore.ts:37-60`；`AiTasksPage.tsx:227-231`；`EdaPage.tsx:200-208` | 🟨 | EDA 页载入候选时**不比对** `draft.planHash` 与重编译 `compiled.planHash`（只把哈希塞进解释文字） |
| B3 | 语义计划 → PCB 受控执行（双哈希） | semantic+compiled 哈希进计划/令牌/账本/执行记录 | `EdaPage.tsx:282-287` → `pcb.mjs:298,737-741` → `design.mjs:55-75,262-271,244-260` | ✅代码 / 🟨证据 | 工作区账本 500 条血缘 0 条（§B-3），无真实记录 |
| B4 | AI 语义计划 → 原理图写入（同一条链） | 语义计划 planHash == 原理图批准/账本哈希 | `chat.mjs:735` 不传血缘；`netlist.mjs:63` 支持但无人传；`design.mjs:493` 执行记录恒 null；`EdaPage.tsx:760` 面板恒 `— / —` | 🟨 | 已按 RP0-8 方案②显式拆线（文案诚实），但链路本身不存在；无任何 ID 关联（P1-2） |
| B5 | AI 网表草案 → 编译 → 计划 | 审核过的网表编译成确定性计划 | `chat.mjs:715-736`；`netlist.mjs:46-73`；测试 `netlist.test.mjs`（本轮 28 passed 组内） | ✅ | `netlistHash` 无消费者（P1-5） |
| B6 | 计划血缘（双哈希）在原理图写入链 | 令牌/账本/执行记录都带来源哈希 | `design.mjs:262-271,493`；`EdaPage.tsx:760` | 🟨 | 该链设计上不产生来源哈希（B4）；面板仍显示血缘行，易读成"支持" |
| B7 | 选型提案 → 设计批准 | 提案→批准→执行全程同一 planHash | `PartProposalPage.tsx:114-124`；`EdaPage.tsx:216-226,461`；实测哈希必变（§A-5） | 🟥 | 注入 lineage 使哈希必变；UI 恒告警；"语义计划哈希"字段语义错位 |
| B8 | 一次性令牌 + 哈希链账本 | 签发/消费/撤销入账本，不可重放 | `approval-service.mjs:79-158`；`approval-ledger.mjs:43-56`；测试 `approval-service`/`approval-ledger`（33 passed 组内） | ✅ | 令牌只存内存（有意）；重启即失效（有文档） |
| B9 | 批准 → 执行目标漂移校验 | 批准绑定工程/文档，执行开始/每 10 操作/save/回滚前复读 | `design.mjs:447-470,480-485,513-516,560-562,614-615`；测试 `design.test.mjs:274-360` | ✅代码 / 🟨 | 绑定由客户端提供，缺了静默跳过（P1-3）；不校验"目标页==项目绑定页" |

### C. 受控写入 → 读回断言 → 失败回滚

| # | 环节 | 期望链 | 实际证据 | 判定 | 缺什么 |
|---|---|---|---|---|---|
| C1 | 快照 → 写 → 存 → 回读 → DRC → 回滚 | 每步失败 fail-closed | `design.mjs:503-627`；测试 `design.test.mjs:50-123,213-273` | ✅代码 / 🚫真机 | 无真机执行记录（`design-executions.json` 不存在） |
| C2 | 写入前 DRC 基线裁决 | 只对新增/加重违规负责，未知 severity 按 error | `design.mjs:147-213,486-497,585-606`；测试 `design.test.mjs:213-273` | ✅ | UI 把"无新增"说成"通过"（P2-1） |
| C3 | 读回断言 | 逐操作断言落板/连线/未连接标识 | `design.mjs:563-583` | 🟨 | 元件身份/位号/网表身份不读回；`netlistHash` 无消费者（P1-5） |
| C4 | 失败回滚 + 写锁 | 恢复快照并校验 digest；失败置锁并可见/可解 | `design.mjs:608-627`（锁 `:622`，入口 `:474`） | 🟨 | 原理图写锁无状态路由/无解除入口、不持久化；跨进程锁模块无消费者（P1-4） |
| C5 | 写暂停覆盖 | 所有 EDA 写路由 409 | `server.mjs:161-180,1728`；`write-gate.mjs`；`EdaPage.tsx:130-170`；测试 `write-gate-http.test.mjs`（33 passed 组内） | ✅（设计链写路由全覆盖） | 并发互斥不在暂停语义内（P1-4）；`/api/project-state` 不受暂停约束（P1-8） |

### D. 验证（DRC/ERC）→ 产品行为

| # | 环节 | 期望链 | 实际证据 | 判定 | 缺什么 |
|---|---|---|---|---|---|
| D1 | ERC 归一化/分类/豁免/修复建议 | 报告+豁免+逐条建议+证据落盘 | `erc.mjs`；`server.mjs:3551-3602`；`ValidationPage` ERC 面板；测试 `erc.test.mjs`/`erc-http.test.mjs`（36 passed 组内） | ✅ | 真机明细常只有聚合计数（已如实标注） |
| D2 | ERC 结论 → 写入裁决 | 写入前用 ERC 结论（含豁免）判断 | 写入只用原始 `schematic.drc` 数组做基线（`design.mjs:486-497,585-606`），不读 ERC 豁免文件 | 🟨 | 豁免类错误仍按"新增"阻断（偏安全但文案/结论不一致） |
| D3 | ERC 结论 → 六门签字 | G4 消费 ERC/DRC + 豁免 | `gates-evidence.mjs:234-253`；`server.mjs:2135-2141`；`VerificationCenterPage.tsx:83-131` | 🟨 | UI 采集不传 `ercExemptions/drcExemptions`（`VerificationCenterPage.tsx:83-99`）→ G4 缺豁免理由 |
| D4 | ERC/网表 diff → 放行/导出裁决 | 放行报告含规则门/网表门 | `release-gate.mjs:637` 需要 `netlistEvidence/rulesEvidence`；`server.mjs:1444-1641` 从不提供；全仓仅 `gate-engine.test.mjs:94` 传过 | 🟥 | 两个已实现的门是死参数；放行可"ready"而无网表一致性/ERC 证据（P1-6） |
| D5 | ERC 证据归属/新鲜度 | 证据绑定当前设计内容，过期/换页失效 | `server.mjs:3595-3597`（fingerprint 无内容摘要）；`gates/collect` 按 projectUuid 取 latest；`evidence-freshness.mjs` 仅仿真使用（`server.mjs:877`） | 🟨 | 无 content digest/无 maxAge/不按 documentUuid 过滤 |
| D6 | pin evidence / assumption 门禁 | 缺证据/未标注方向阻断执行计划 | `pin-evidence.mjs:118-126`；`server.mjs:3154-3185,4000-4025,4027-4033`；`EdaPage.tsx:474-491` | 🟨 | 输入客户端自报、不持久化、不进计划/批准；`strictAssumptions` 无产品消费者 |

### E. 交接 / UI / 证据持久化

| # | 环节 | 期望链 | 实际证据 | 判定 | 缺什么 |
|---|---|---|---|---|---|
| E1 | 原理图 → PCB 同步交接 | 期望位号回读比对、缺件回滚、UI 双闸 | `EdaPage.tsx:294-340`；`pcb.mjs` expectations；测试 `pcb.test.mjs:263-327` | ✅代码 / 🚫真机 | 历史真机 `importChanges` 空转（修复前证据），修复后未真机复验 |
| E2 | 设计执行 → 阶段推进（D5） | 只由可核验证据推进相邻阶段 | `EdaPage.tsx:587`；`stageEvidence.ts:22-55`；`stageMachine.ts`；测试 `stageEvidence.test.ts` 6/6 | 🟨 | 证据是客户端字段，服务端不核对 `schematicExecutionId` 是否真实存在（P1-8） |
| E3 | 设计执行 → 交付链血缘 | executionId/planHash 进入 readiness/签核/归档 | readiness 只绑 `pcbExecutionId`（`AssetsPage.tsx:109-120`；`production.mjs:436,498-514`）；原理图 executionId 无交付消费者 | 🟥 | 原理图执行记录不进入交付/签核链（只存在于 project-state 客户端字段） |
| E4 | 跨页草稿 → readiness | 设计链用过的语义计划仍是交付链输入 | `EdaPage.tsx:280` clear vs `AssetsPage.tsx:70-77` read | 🟥 | 单份草稿被两链争用；无服务端持久化引用（P0-2） |
| E5 | UI 按钮 ↔ 后端语义 | 按钮文案/编号/确认框与真实动作一致 | `EdaPage.tsx:724,760,804,342-352`；`RequirementsPage.tsx:36` | 🟨 | 编号跳号、确认框不显示 planHash、需求页功效声明过度（P2-6/P1-10） |
| E6 | 证据持久化（重启后仍可复核） | 执行历史/证据落盘、损坏 fail-closed | `server.mjs:618-638`；`design.mjs:372-388`；`evidence-store.mjs` | ✅ | 快照源码不落盘（有意，重启后无法再回滚） |

---

## ③ 修复建议（精确文件 / 预期行为 / 要加的测试 / 风险 / 是否需真机）

> 顺序 = 建议修复顺序。每条只写"改哪、改成什么、测什么、风险、是否需要真机"。默认都不需要连接 EDA（除标注者）。

### F1（对 P0-1）真机确认/替换原理图连线通道，并把 A7 通道接进受控执行
- **文件**：`runtime/design.mjs:529-536,570-582`（`net.connect` → `schematic.wire.create`）；参考 `runtime/net-connect.mjs`（A7 已用 `sch_PrimitiveComponent.createNetPort` 真机跑通、含 `.enet` 逐引脚读回）。
- **预期行为**：执行器优先走 A7 已证明的 `netPort.create + 保存 + .enet pinInfoMap 读回`；`wire.create` 降级为可选策略或直接删除。成功判据从"源码 digest 变了"升级为"目标引脚 net 名 == 计划网络名"。
- **测试**：`runtime/__tests__/design.test.mjs` 新增 2 例（假桥返回 wire 零变化 → 必须失败回滚；假桥 netPort 成功 + enet 读回 → completed 且事件含逐引脚断言）；新增 `runtime/__tests__/design-netconnect-readback.test.mjs`。
- **风险**：真机 netPort 写入慢（30s 预算，`bridge.mjs:175-178`），长计划要分批 + 每批保存；读回网表 432KB 需分片（已有 `schematic.netlist.chunk`）。
- **是否需真机**：**是**（唯一能证明 P0-1 的手段）。

### F2（对 P0-2/E4）把语义计划引用从"单次 sessionStorage"升级为可复核引用，并在 readiness 侧接受
- **文件**：`src/pages/EdaPage.tsx:280`（不要清草稿，改成"标记已消费"）；`src/services/draftStore.ts`（新增 `consume`/`lastConsumed` 或改为按 planHash 存多份）；`src/pages/AssetsPage.tsx:70-77`（优先读"本会话最近一次编译/执行的语义计划引用"，其次草稿）；`runtime/production.mjs`（`plans` 已持久化，readiness 可接受服务端登记的 planHash，不必依赖前端草稿）。
- **预期行为**：设计链执行完成后，交付链仍能拿到 `semanticPlanHash + compiledPlanHash + pcbExecutionId` 同一组引用；`clearSemanticPlanDraft` 只在"新计划覆盖旧计划"时调用。
- **测试**：`src/services/draftStore.test.ts` 新增 2 例（消费后仍可读引用；新草稿覆盖旧草稿）；新增 `src/pages/__tests__/design-to-readiness-handoff.test.tsx`（假 fetch：EDA 准备执行 → AssetsPage readiness 使用同一 semanticPlanHash）。
- **风险**：草稿保留会让"旧计划被静默复用"，需带 `createdAt/planHash` 并在 UI 明示来源；服务端应校验该 planHash 已登记（`PRODUCTION_PLAN_UNKNOWN` 已有）。
- **是否需真机**：否（HTTP/前端级即可）。

### F3（对 P1-1/B7）选型提案链不要再伪造 `semanticPlanHash`，改为独立的来源引用
- **文件**：`src/pages/EdaPage.tsx:461`；`src/services/draftStore.ts`（`SchematicPlanDraft` 增加 `sourcePlanHash` 语义说明）；必要时 `runtime/design.mjs:55-75` 增加 `sourcePlanHash` 字段（或 UI 端只比对"去掉 lineage 后重算的哈希"）。
- **预期行为**：`planHash(校验后) === planHash(提案, 未注入 lineage)` 可判定 → 一致时显示"交接哈希一致"，不一致才警告；批准面板不再把批量计划哈希当"语义计划哈希"。
- **测试**：新增 `src/pages/__tests__/eda-plan-hash-handoff.test.tsx`（注入 fixture 草稿 → 点"校验计划" → 断言一致/不一致两条分支）；`runtime/__tests__/plan-lineage-http.test.mjs` 增加"提案计划 + sourcePlanHash 不进 planHash"的用例。
- **风险**：若产品坚持"提案计划也要有来源"，则应在 plan 里显式加字段并说明语义（不要复用 semantic/compiled）。
- **是否需真机**：否。

### F4（对 P1-3/B9）目标绑定 fail-closed + 校验目标页 == 项目绑定页
- **文件**：`src/pages/EdaPage.tsx:176-190`（读不到 uuid 时禁止批准并提示，不静默 null）、`:448-457`（`opened.documentUuid` 与 `activeProject.edaWorkspace.schematicPageUuid` 不一致 → 拒绝并报 `SCHEMATIC_TARGET_MISMATCH`）；`runtime/design.mjs:447-450`（服务端对"批准记录未绑定"的情况返回 warning 字段给 UI）；`runtime/server.mjs:3986-3990`（空 uuid 不再回落"第一张页"，返回 400/候选列表）。
- **预期行为**：批准/执行前必须能回答"写的是哪个工程哪一页"；绑定缺失 = 不可批准；目标页 ≠ 项目登记页 = 409。
- **测试**：`runtime/__tests__/design.test.mjs` 增 1 例（批准未带绑定 → 响应带 `lineage/target warnings` 或直接 400，二选一由产品定）；`server` 增 HTTP 例（open-current 空 uuid → 400）；`src/pages/__tests__` 增目标页不一致例。
- **风险**：旧调用方（脚本）不传绑定时行为改变（建议用 400 而非静默），需在 checklist 记录不兼容变更。
- **是否需真机**：否（假桥可覆盖）；真机仅需复核 `document.current.uuid` 形状。

### F5（对 P1-6/D4/D5）把 ERC/网表证据接进放行门，并给 ERC 证据加内容绑定与新鲜度
- **文件**：`runtime/server.mjs:1444-1641`（`gatherReleaseEvidence` 返回 `netlistEvidence/rulesEvidence`：按 `targetPcbUuid` 从 `evidenceStore.latest('rules'|'netlist-diff', {fingerprint:{pcbUuid}})` 取）；`runtime/server.mjs:3595-3597`（ERC 证据 fingerprint 增加 `sourceDigest`/`documentUuid` + `payload.report.documentUuid`）；`runtime/__tests__` 增生产路由用例；`src/pages/VerificationCenterPage.tsx:83-99`（采集时传 `ercExemptions/drcExemptions`）。
- **预期行为**：`/api/eda/release/gate|production/release|export|readiness` 的裁决包含 `netlist`/`rules` 两门；缺证据 → unknown 阻断；ERC 证据换页/过期 → 不认。
- **测试**：`runtime/__tests__/release-gate-http.test.mjs`（新）断言"有 ERC 证据且网表 diff pass → 报告含两门；缺 → 不放行"；`gates-evidence.test.mjs` 增豁免透传例。
- **风险**：现网 ERC 常带历史 error/warning → 放行会变严格（这是产品要的口径，需同步 UI 文案与 checklist）；`rules` 证据是项目级（非板级），注意与 pcbUuid 绑定关系。
- **是否需真机**：部分（真实 ERC/网表证据产生的门禁报告需真机走一遍，否则只能证明"缺证据会阻断"）。

### F6（对 P1-8/E2）阶段证据服务端化：由 Runtime 生成，拒绝客户端自报
- **文件**：`runtime/server.mjs:1973-1979`（`PUT /api/project-state` 对 `projects[].edaWorkspace.schematicStatus/schematicExecutedAt/schematicExecutionId` 做校验：必须能在 `designManager.get(executionId)` 找到且 `state==='completed'`，或直接忽略客户端这些字段由服务端生成）；`runtime/design.mjs`（执行完成时把执行摘要写入 Runtime 侧的项目证据存储）；`src/pages/EdaPage.tsx:587`（只 dispatch 显示用，不写权威证据）。
- **预期行为**：`schematicGenerated/netlistApproved` 由 Runtime 执行记录派生；脚本/Agent 无法通过 PUT 伪造；需求变化时 Runtime 侧证据可被显式作废（或加 `sourceDigest` 绑定）。
- **测试**：`runtime/__tests__/project-state-http.test.mjs` 新增 3 例（伪造 executionId 被拒/被忽略；真实 completed 可写入；`design-executions` 不存在时 fail-closed）。
- **风险**：`project-state` 是通用状态通道，白名单校验要精确，避免破坏其它字段；前端兼容旧载荷需回退。
- **是否需真机**：否。

### F7（对 P1-4/C4）原理图写锁对齐 PCB、跨路由互斥
- **文件**：`runtime/design.mjs:369,474,622`（改为持久锁文件 + `writeLockStatus()/releaseSafetyLock()`，与 `runtime/pcb.mjs` 同构）；`runtime/server.mjs` 新增 `GET /api/design/write-lock` 与 `POST /api/design/write-lock/release`；`:161-180` 把 `/api/eda/schematic/repair|net-connect|designators/set|component-batch` 与 `/api/design/execute` 一起纳入 `withEdaWriteLock({key:'schematic'})`（当前 `server.mjs:62` 导入未使用）；`src/pages/EdaPage.tsx` 增加原理图写锁横幅与解除入口（对照 PCB `:741-757`）。
- **预期行为**：同一原理图文档同时只能有一个受控写任务；回滚失败后锁跨重启仍生效、必须人工解除；UI 能看到并解释 409。
- **测试**：`runtime/__tests__/design-write-lock.test.mjs`（新，stale 接管/并发 409/解除幂等）；复用 `eda-write-lock.test.mjs` 的锁语义。
- **风险**：IPC/锁文件在跨进程（CLI 脚本 + Runtime）场景要统一 key；误锁会让用户以为"写不了"。
- **是否需真机**：否。

### F8（对 P1-7/D6）pin evidence 持久化 + 绑定进计划/批准
- **文件**：`runtime/server.mjs:3154-3185`（采集成功后 `evidenceStore.save({kind:'pin-evidence'})` 或并入 `design-spec`/`netlist-diff`）；`runtime/__tests__/evidence-store.mjs` 的 `EVIDENCE_KINDS` 增 kind（`evidence-store.mjs:20-32`）；`runtime/netlist.mjs:63`（把 `pinEvidenceDigest` 带入 plan 或返回引用）；`src/pages/EdaPage.tsx:474-491`（显示 digest/counts，批准面板显示来源证据）；`runtime/chat.mjs:735`（把网表来源（AI 响应摘要）传给 `compileReviewedNetlist` 作为 lineage）。
- **预期行为**：批准令牌可回答"这份计划基于哪份引脚证据/哪份网表草案"；缺证据从零设计明确标 `pinEvidence: null` 且不宣称有证据。
- **测试**：`runtime/__tests__/pin-evidence.test.mjs` 增"证据落盘 + digest 绑定 + 换证据后批准哈希不同"；`netlist.test.mjs` 增 lineage 透传。
- **风险**：pin evidence 文件较大（180 器件/602 焊盘），要压缩/摘要；`kind` 扩枚举需同步 evidence 契约测试。
- **是否需真机**：部分（真实焊盘证据形状已有 10-19 证据可复用）。

### F9（对 P1-10/A2）约束进计划层：`normalizePlan` 输出 `constraintReport`，批准前校验
- **文件**：`runtime/design.mjs:91-129`（`normalizePlan` 接受 `constraints+designFacts`，输出 `constraintReport`，参与 planHash）；`runtime/server.mjs:3991-3994`（`/api/design/plan` 透传）；`src/pages/EdaPage.tsx:459-464`（校验时把 `state.requirements` 与 designFacts 带入）；`ValidationPage` 的 A1 面板复用同一份 facts（抽成共享 draft）。
- **预期行为**：违反已确认硬约束的计划 `ready=false` 且逐条列出；批准前再次校验（防"批准了违反约束的计划"）；放行门仍保留同一条判定。
- **测试**：`runtime/__tests__/constraints.test.mjs` 增"计划层 constraintReport 阻断"；`design.test.mjs` 增"违反约束计划不可批准"；UI 层 `designFacts.test.ts` 扩。
- **风险**：设计事实在计划阶段往往还没有（板框/电流未实测）→ 会大量 unknown 阻断；建议分级：计划阶段只 block `fail`，`unknown` 记为 warning 并在放行阶段 block（需产品定）。
- **是否需真机**：否（但"事实来源"最终要 EDA 读回，属另一项）。

### F10（对 P1-9）收紧 Agent 写入面
- **文件**：`runtime/agent-auth.mjs:52-66,145-149`（把 `/api/design/execute`、`/api/pcb/execute` 加入拒绝树，或要求"执行令牌由 UI 本机签发且 Agent 不能消费"）；`runtime/server.mjs:4034-4040`（Agent 批准的 `confirm` 改由 UI 侧带一次性 confirm 令牌，服务端校验该令牌由本机会话签发）。
- **预期行为**：Agent 只能"提议 + 创建待审批请求"，批准/执行必须由本机 UI 会话完成；README 的"不允许 AI 自批写入"变成服务端事实。
- **测试**：`runtime/__tests__/agent-auth.test.mjs` 增"Agent 调 execute → 403"；`agent-approvals-http.test.mjs` 增"只有 confirm=true 不足以自批"。
- **风险**：会改变现有 DSH 插件工作流（当前插件依赖 chat 审批），需要产品确认后再改；短期内至少在审计里如实记录"这是约定不是强制"。
- **是否需真机**：否。

### F11（对 P2 系列，低成本高收益）
- **文件/行为**：`EdaPage.tsx:760` 把"官方检查通过"改为"无新增违规（基线 N 条已豁免）"、面板名改"原理图 DRC（SCH_Drc.check，非 ERC 明细）"；`:461/503/581` 增加 `planDirty` 标记（文本改动后禁用批准/执行并提示重校验）；`:777` 历史表增加语义/编译哈希列；`netlist.mjs:66-72` 的 `layoutAudit` 在 `EdaPage` 计划面板显示 ok/findings；`design.mjs:485` 给 `TARGET_DRIFT` 补 `status:409` 并移到 consume 之前（`pcb.mjs:750-752` 同改）；`plan-requests.mjs:397-421` 把 projectId/documentUuid 纳入 binding 比对。
- **测试**：对应页面的 jsdom 点击测试 + `design.test.mjs` 的 409 断言。
- **风险**：低；主要是文案/顺序调整。
- **是否需真机**：否。

---

## ④ 需真机/人工的诚实边界（不冒充已打通）

1. **本轮未连接嘉立创 EDA / Bridge、未重启 4177/4178、未跑 Playwright/live e2e、未跑全量 acceptance**。因此本报告所有 ✅ 都只到"代码+路由+UI+单测/HTTP 测试"级别，**不代表真机可用**。
2. **设计链最关键的"写入原理图"一步没有任何真机成功记录**：`artifacts/state/design-executions.json` 不存在；`artifacts/state/approvals-ledger.json` 500 条中 `plan` 216 条、带 `semanticPlanHash/compiledPlanHash` 的 **0 条**；`production.json` 只有 1 条已登记计划、0 条终审。checklist A7 的真机证据（`artifacts/a7-r3/`）走的是另一条 `netPort` 通道，不是 `design.execute`。
3. **线通道历史自相矛盾**：`circuitpilot-completion-checklist.md:85-92` 记录 `sch_PrimitiveWire.create` 真机静默无效；`whole-board-progress.md:148` 记录"网络名写在导线上 ✓"；`:544` 记录"返回对象但源码零变化 ✗"。本报告无法裁决哪个版本对应当前 EDA 3.2.186，必须真机复验（这是 P0-1）。
4. **ERC 明细**：真机 EDA 扩展 API 只返回聚合计数（`[{type:'warn',count:6}]`），逐条明细依赖 GUI 面板抓取（`eda-erc-detail.mjs`，`server.mjs:3561-3586`）。工作区最新 ERC 证据是 2026-10-21（1 error / 34 warning / 37 total，`artifacts/evidence/schematic-erc/…10-21T11-48-04…json`），**不是**当前代码/当前板产生的结论。
5. **G1–G6 六门与放行门都需要真实板数据**：本报告只能证明"缺证据会阻断"，不能证明"真实证据能 pass 并签字"。六门签字与放行签核是两套并行的签核口径（six-gate vs release/export），是否合并需产品拍板。
6. **设计事实（板框/电流/GPIO/接口/温度）目前全部靠人工录入**（`ValidationPage.tsx:1774-1789`），EDA 读回采集未接；所以 A2/A3 的"约束进计划"即使修好，也要人工提供事实才能得到 pass/fail。
7. **本报告无法验证**：`document.source.read/restore` 在真机的稳定性、`schematic.drc` 返回形状（明细/聚合）、`targetFingerprint` 是否能稳定复现、`pcb.importChanges` 修复后是否仍空转、真实位号/网表读回开销。
8. **未跑全量**：任务要求不跑全量 acceptance；本轮只跑了定向的 runtime/vitest 用例（§附录A）。任务书给的 typecheck/vitest 228/runtime 1455 基线**未被本报告独立复核**。
9. **文档口径修正建议**：`flow-gap-audit-2026-10-29.md:78`"设计链 ✅"、`circuitpilot-completion-checklist.md:43-49` A3 ✅、A4 ✅ 均高于实际（A3 的"同 planHash"不成立；A4 的 pin evidence 门禁输入可自报且不持久化）。建议改成 🟨 并引用本报告编号。

---

## 附录A 本轮实际执行的只读命令与结果

隔离状态目录：`.tmp/audit-design/{state,evidence,automation,knowledge}`（未触碰 `artifacts/state`）。

| # | 命令 | 结果 |
|---|---|---|
| A-1 | `node --test runtime/__tests__/{design,netlist,plan-lineage-http,constraints}.test.mjs` | **28 passed / 0 failed**（2026-11-05 14:50） |
| A-2 | `node --test runtime/__tests__/{pin-evidence,netlist-assumptions,schematic-batch,designator,erc,erc-http,approval-ledger}.test.mjs` | **36 passed / 0 failed** |
| A-3 | `node --test runtime/__tests__/{gates-evidence,approval-service,design-spec,write-gate-http}.test.mjs` | **33 passed / 0 failed** |
| A-4 | `npx vitest run src/services/draftStore.test.ts src/services/__tests__/{stageEvidence,designFacts,stageMachine,validationEvidence}.test.ts` | **5 files / 43 tests passed** |
| A-5 | `node --input-type=module` 复现选型提案哈希：`normalizePlan(proposal)` vs `normalizePlan({...proposal, semanticPlanHash})` | `1b495c6fadf0` **≠** `47895cc9d676` → EDA 页"交接哈希一致"判定恒为不一致（P1-1） |
| A-6 | `node --input-type=module` 复现 AI 网表编译计划字段 | `plan keys = apiVersion,kind,title,nets,operations,assumptions` → **无 semanticPlanHash/compiledPlanHash**（P1-2） |
| A-7 | 只读解析 `artifacts/state/approvals-ledger.json` | 500 条：`write` 230 / `plan` 216 / `release` 54；**含 lineage 0 条**；最后写入 2026-11-02 |
| A-8 | 只读检查 `artifacts/state/` | `design-executions.json` **不存在**；`pcb-executions.json` 106 条（2026-10-20 旧数据）；`production.json` plans=1 / reviews=0；`project-state` 中 `schematicStatus='empty'` |
| A-9 | 只读解析 `artifacts/evidence/schematic-erc/` 最新文件 | 2026-10-21，`counts={fatal:0,error:1,warning:34,info:2,total:37}`，fingerprint 有 window/project/document 但**无内容摘要**（P1-6） |

## 附录B 与文档既有结论的差异（供 Lead 改口径）

| 文档结论 | 本报告 | 依据 |
|---|---|---|
| `flow-gap-audit-2026-10-29.md:78` 设计链 ✅ | 🟨（主链真机未证明 + 两链未合流 + 交付血缘断） | P0-1/P0-2/P1-2/E3 |
| `circuitpilot-completion-checklist.md:43-49` A3 ✅ "全程同一 planHash" | 🟥 | P1-1 / 附录A-5 |
| `circuitpilot-completion-checklist.md:51-69` A4 ✅ 计划层+assumption 闭环 | 🟨 | P1-7 / P1-6 |
| `circuitpilot-completion-checklist.md:134-148` A13 ERC 未进放行 gate（已如实标注） | 🟨→🟥（现在连六门之外也没有消费者；且证据无内容绑定） | P1-6 / D3/D4/D5 |
| `flow-gap-audit-2026-10-29.md:32` RP0-8 方案②"已收口" | 文案 ✅ / 链路仍 🟨 | P1-2 |
| `docs/implementation/README.md:32-33` "不允许 AI 自批写入" | 仅插件约定，服务端未强制 | P1-9 |
