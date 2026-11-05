# 02 · PCB 链闭环审计（落板→布局→布线→铺铜→DRC→回滚）

> 审计角色：只读审计员（`audit-pcb`），共享任务板 `task-2`。
> 基线：git `98429be`（2026-11-02 20:25 +0800；`git status` 无已跟踪改动，存在 86 项历史 untracked 产物目录），基线声称 typecheck 通过 / vitest 228 / runtime 1455。
> 审计时间：2026-11-05。
> 方法：只读通读 + 隔离 runtime 单测 + 离线假桥 HTTP 探针（内存态，不连 EDA/Bridge、不启动 4177/4178、不跑 acceptance/live e2e、未改源码）。
> **本文件是本次审计唯一写入的文件。**
> 判定口径：✅ 已闭环｜🟨 半闭环（写明缺口）｜🟥 断点/假成功/fail-open｜⬜ 本次未覆盖｜🚫 产品边界。

---

## 0. 一句话结论

**受控计划执行（`POST /api/pcb/execute`）这一条通道是真闭环**（跨进程写租约、三阶段 documentUuid 校验、按类型回读断言、官方 DRC 基线/时序、阶段回滚、回滚失败持久安全锁，均有代码+单测）；
但**"写锁/目标绑定/读回断言"没有横向铺开**：`eda-write-lock.mjs` 跨进程写锁**是死代码（仅 import 一次）**，18 条写路由里只有 `/api/pcb/execute` 走 `PcbManager` 租约；`placement/apply` 可把批准过的 A 板写到用户请求的 B 板，`schematic/repair` 可把批准过的原理图页写成另一页；自动化 `pcb-sync-from-schematic` 配方仍是"只比器件数"，**2026-11-02 真机已把"弹窗未应用"误判为 completed 的形态在 HEAD 上仍然存在**。

**计数：P0 = 2 · P1 = 9 · P2 = 8。**

---

## 1. 结论摘要

### P0（假成功 / 写错板，必须先修）

| 编号 | 问题 | 证据 | 判定 |
|---|---|---|---|
| **P0-1** | `pcb-sync-from-schematic` 配方读回**只比 PCB 器件数**：主通道 `pcb.importChanges` 只弹「确认导入信息」对话框、返回 success 但板面不变时，只要 `componentCount ≥ expectedComponentCount` 就判 `completed`。这是 2026-11-02 真机已复现的假成功（supervisor 文档明确列为待补），HEAD 仍是 v2 未改。 | `runtime/automation/recipes.mjs:407-446`（readback=`pcb.placement.read`，断言只有 `components nonEmpty` + `componentCount atLeast expectedComponentCount`）；`runtime/automation/automation.test.mjs:341` 也只测 count；`docs/implementation/supervisor-readonly-2026-11-02.md:118-119,141` 真机记录与待补项 | 🟥 |
| **P0-2** | `POST /api/eda/pcb/placement/apply` **批准目标可被请求体重新定向**：`requireWriteApproval` 校验通过时绑定的是"当前活动文档"（A 板），随后 `readPcbPlacement(body.pcbUuid)` 会把 EDA 切到请求里的 B 板并在 B 板写回——批准 A、写 B 的 fail-open（与 RP0-4 同类）。离线探针复现：批准绑定 D1 后带 `pcbUuid:D2` → HTTP 200 且桥收到 `pcb.open{documentUuid:"D2"}`。UI 正好把用户手填的 `pcbUuid` 原样传入（多板工程/字段残留即可自然触发）。 | `runtime/server.mjs:3122`（`requireWriteApproval(body)` 返回值被丢弃）、`:3124`（`readPcbPlacement(body.pcbUuid)`）、`:1247-1268`（readPcbPlacement 无条件 `activatePcbDocument(target)`）、`:1073-1087`（activatePcbDocument）；`src/pages/PlacementPage.tsx:112,147,186`（`pcbUuid` 来自手填输入框） | 🟥 |

### P1（闭环缺口 / 边界漏洞）

| 编号 | 问题 | 证据 | 判定 |
|---|---|---|---|
| **P1-1** | **P1-11 遗留未修**：`runtime/eda-write-lock.mjs` 的跨进程文件锁**没有被任何产品代码调用**（`server.mjs:62` 只 import，全仓仅测试引用），因此它一条写路由也没包住；实际跨进程互斥只有 `PcbManager` 的 `pcb-write-lock.json` 租约，而它只被 `/api/pcb/execute` 使用（`pcb.mjs:496-526` 获取/释放，`:753` 仅 execute 调用）。`EDA_WRITE_LOCKED` 在生产代码里**永远不会被抛出**。布局/布线/修复/叠层可并发写同一文档（平台审计 P1-3 同样结论）。 | `runtime/server.mjs:62`；`grep -rn "withEdaWriteLock" runtime` 仅 `eda-write-lock.mjs`+测试；`runtime/pcb.mjs:496,753`；`grep -rn "EDA_WRITE_LOCKED" runtime --include=*.mjs` 仅模块/测试 | 🟥 |
| **P1-2** | `ValidationPage` 的「执行修复并验收」**必然 409**：UI 调 `repairSchematic({pageUuid,dryRun:false})` 不签发/不带 `approvalIds`，而路由 `dryRun:false` 必过 `requireWriteApproval`。离线探针：`409 AUTOMATION_APPROVAL_REQUIRED`。按钮在未暂停时是亮的（`repairRunning`/暂停之外无禁用），属"点下必死"的死写路径。 | `src/pages/ValidationPage.tsx:1284`（无 approvalIds）、`:2049-2050`（按钮启用条件）；`src/services/runtimeClient.ts:792-794`（签名里根本没有 approvalIds）；`runtime/server.mjs:2732`（要求批准）、`:1010-1025`（approvalIds 为空即 409） | 🟥 |
| **P1-3** | `POST /api/eda/schematic/repair` **不校验批准绑定的文档**：`requireWriteApproval(body)` 返回值被丢弃，随后只要 `body.pageUuid` 存在就直接 `schematic.open` 并写它。离线探针：批准绑定 S-A，请求 `pageUuid:"S-B"` → 路由打开 S-B（仅因假桥网表为空停在 `EDA_NETLIST_EMPTY`；真机有网表就会写 S-B）。对照 `net-connect` 会把 pageUuid 与批准文档比对并 409（探针已验证）。 | `runtime/server.mjs:2732-2745`（对比 `:2826-2832` + `ensureSchematicActive` `:1030-1045`）；`docs/implementation/flow-gap-audit-2026-10-29.md` §RP0-4/RP0-5 口径 | 🟥 |
| **P1-4** | **直连写路由没有"在途文档漂移"校验**：`/api/eda/pcb/placement/apply`、`routing/apply|rollback|finish`、`pour/create`、`layers`、`schematic/repair` 只在请求开始时用批准指纹（含 documentUuid）比对一次，写入期间用户切文档不会被发现；`PcbManager.execute` 是唯一的"写入批次前/回读前/回滚前"三阶段校验（`pcb.mjs:543-558,760,854-856`），`design.mjs` 也有（`:449-465,513-516,559-562,615-618`）。routing 的官方 DRC 守卫可跑分钟级，窗口足够切板。 | `runtime/server.mjs:1010-1025`（仅起点校验）；`runtime/engineering/pcb-routing.mjs:777-913`（无 document 校验）；`runtime/pcb.mjs:543-558`（对照组） | 🟨→🟥（写错板风险） |
| **P1-5** | `pour/create` 的 `pcbUuid` 在"已有活动 PCB"时被**静默忽略**：`ensurePcbDocument()` 发现当前文档已是 PCB 就直接返回当前文档、不开请求指定的板。离线探针：批准绑定 D1、请求 `pcbUuid:D2` → HTTP 200、桥没有 `pcb.open`、`pcb.pour.create` 落在 D1（返回体也不带实际 pcbUuid，调用方无法察觉）。 | `runtime/server.mjs:1119-1145`（ensurePcbDocument 逻辑）、`:3297-3300`（pour 路由）；探针输出见 §7 | 🟥 |
| **P1-6** | **GUI 写通道（`/api/eda/gui/execute`）不受一次性写批准约束**：非只读动作只过写暂停门禁，然后直接 `guiClient.execute`；`click/type/key/clickText` 可点「应用修改」写板而无需 `approvalIds`。离线探针：`{action:'click'}` → 400 `EDA_GUI_CDP_UNAVAILABLE`（已穿过批准环节，不是 409）。且 `runtime/automation/safety.mjs` 的危险文案/动作分级只在 automation 执行器里生效，**这条 HTTP 路由没有套 safety**（仅 eval 受环境变量限制）。Agent 路由白名单允许该路由（`agent-auth.test.mjs:235` 明确断言 allowed）。平台审计 P1-8 同结论，HEAD 未修。 | `runtime/server.mjs:4269-4281`；`runtime/eda-gui.mjs:723-760`（clickText 无危险文案黑名单）；`runtime/automation/executors.mjs:32-38`（safety 只在执行器层）；`runtime/__tests__/agent-auth.test.mjs:235` | 🟥 |
| **P1-7** | **DRC 截断不进裁决**：`PcbManager` 只把 `truncated` 记录成事件/`execution.drc.job`，`drcVerdict({baseline,findings})` 完全忽略截断，截断报告可判 `passed`；而 DRC 报告分类链把截断当 blocking（`drc.mjs:289`），同一事实两种口径（旧审计 P1-F 仍未修）。 | `runtime/pcb.mjs:214-225`（drcVerdict 无 truncated 入参）、`:721,831`（只记事件）、`:900-930`（裁决只用 findings）；`runtime/drc.mjs:289`（对照口径） | 🟥 |
| **P1-8** | `/api/pcb/sync/verify` **UI 不带 pcbUuid**：API 已支持 `?pcbUuid=`，但 EdaPage 同步前/后复核与 ValidationPage「回读验收」都是无参调用；服务端无参时按"当前板/工程首板"解析并**激活**该板（`readPcbPlacement`），多板工程可能判错板、甚至把用户当前文档切走（旧审计 P1-C 仍在 UI 侧开放）。 | `src/services/runtimeClient.ts:590-592`（支持参数）；`src/pages/EdaPage.tsx:308,362`、`src/pages/ValidationPage.tsx:1266`（无参调用）；`runtime/server.mjs:4112-4122`、`:1247-1268` | 🟨 |
| **P1-9** | **混合计划里的 `importChanges` 不做落板比对**：`syncCheck` 的"空转检测"只在"计划里全是 SYNC_ONLY 操作"时生效；一旦同计划还有 `line.create` 等操作（源码/器件数会变），`importChanges` 空转不会被发现（也没有强制调用方给 `expectations`）。高级面板计划可编辑并重新批准。 | `runtime/pcb.mjs:891-899`（`every(SYNC_ONLY...)` 条件）、`:880-890`（只有显式 expectations 才查缺件）；`src/pages/EdaPage.tsx:629-638`（校验手改计划）、`:758`（计划编辑器） | 🟨 |

### P2（不阻断但应排期）

| 编号 | 问题 | 证据 |
|---|---|---|
| **P2-1** | `expectations` 可被"写前已存在位号"绕过（旧审计 P1-B 未修）：只校验"写后都在"，没有"写前至少一个不存在"。手改/复制旧计划可让空转 `completed`。 | `runtime/pcb.mjs:880-890`；`runtime/__tests__/pcb.test.mjs:335-374` 只覆盖缺件场景 |
| **P2-2** | `PlacementPage` 写按钮只跟随**全局** `writePaused`，没有跟随 `sessionPaused`（其它页面已跟随）：会话暂停时按钮仍亮，点下被服务端 409。服务端未被绕过，仅 UI 与 P1-12 "6+ 写按钮统一禁用"的叙事不一致。 | `src/pages/PlacementPage.tsx:105,224`（无 `sessionPaused`）；对照 `EdaPage.tsx:130`、`RoutingWritePanel.tsx:23-24`、`PartProposalPage.tsx:27` |
| **P2-3** | 部分写通道"读回断言"有了但**没有反向写/回滚**：`layers`（setCount 后读回不符只 409，不回退层数）、`designators/set`（保存后读回不符抛错，不回滚位号）、`component-batch`（失败即停，无反向写）、`routing/finish`（失败不恢复内存板态，只保证不 save）。E8 文档对"不可逆写不回滚"是诚实的，但矩阵里应标注为半闭环。 | `runtime/server.mjs:3410-3455`（layers）、`:2914-2938`（designators）、`:2940-2977` + `runtime/schematic-batch.mjs:223-236`；`runtime/engineering/pcb-routing.mjs:945-990` |
| **P2-4** | `POST /api/pcb/write-lock/release`（解除回滚失败安全锁）**无写批准、无写门禁**，`operator/note` 仅在前端校验（服务端有默认值）：探针 200 `released:false`。安全锁是"回滚失败后禁止再写"的最后一道闸，解除应带写批准+审计证据。 | `runtime/server.mjs:4065-4068`；`src/pages/EdaPage.tsx:516-545`（仅 UI 校验） |
| **P2-5** | 写暂停过度覆盖：分发前的 409 判断在解析 body 之前，`dryRun:true` 的预演、只读规划也被挡（P1-11 声称"dryRun 语义保持现状"，实际就是被挡）；不影响 fail-closed，但产品体验/语义可再区分。 | `runtime/server.mjs:1728`；`runtime/__tests__/write-gate-http.test.mjs`（暂停期 dry-run 未单列） |
| **P2-6** | 直连写路由只有 HTTP 日志+批准账本，没有 automation journal/audit-bundle 等价物：E11 的 before/after 截图、stateDigest、哈希链只覆盖自动化 run；手工路由写板的事后取证弱一档。 | `runtime/automation/audit-bundle.mjs`；`runtime/server.mjs:4278,4493`；E11 面板只读 runId |
| **P2-7** | 配方读回普遍弱于同类 HTTP 路由：`pcb-create-pour` 只断言 `pours.length ≥ expected`（路由是属性级读回 `runtime/server.mjs:3330-3350`）；`pcb-rebuild-pours` 只 `nonEmpty`。自动化走桥命令，**绕过了路由里的强断言**。 | `runtime/automation/recipes.mjs:472-510`（create-pour）；`runtime/server.mjs:3270-3358`（路由强断言） |
| **P2-8** | `evidence/retention/prune`（删证据文件，非 EDA 写）也调用 `requireWriteApproval` → 写暂停期间一并 409；语义可接受（破坏性操作），但说明"写暂停"已超出 EDA 写路由清单，需在文档写清。 | `runtime/server.mjs:3709-3719`（不在 18 条 `EDA_WRITE_ROUTES` 内，却因 requireWriteApproval 被暂停覆盖） |

### 已确认成立的关键闭环（✅，避免只报问题）

- **写暂停双作用域对全部 18 条 `EDA_WRITE_ROUTES` 生效**：离线探针逐条 POST，全局暂停全部 `409 EDA_WRITE_PAUSED`；会话暂停抽样 3 条均为 `409 EDA_WRITE_PAUSED, details.scope="session"`（分发点统一，`server.mjs:1727-1728`；`write-gate.mjs:110-113,160-177`）。磁盘损坏 fail-closed 有回归（`write-gate-http.test.mjs:136`）。
- **受控计划执行**：跨进程租约（`pcb.mjs:496-526,753`，租约文件损坏 fail-closed `:500`）、一次性批准 + 目标指纹（`:758-761`）、写前层列表核对、三阶段文档绑定（`:760,854-856,942+`）、按类型回读断言（`:563-655,864-870`）、`pcb.save===true` 强制（`:826,840`）、官方 DRC 必须晚于最后一次写入（`:900-909`）、阶段级回滚口径诚实（`rollbackScope/snapshotRestored/retainedStages`）、回滚失败持久安全锁（`:1043-1048` + `:421-431` 重启恢复）。
- **布局/布线/覆铜的主要写通道有"读回+回滚+残留如实上报"**：placement `applyPlacementPlan` 失败回滚并给 `manualCoordinates`（`placement-write.mjs:177-205`）；routing apply 写后回读+DRC 新增违规回滚+`residual`（`pcb-routing.mjs:777-878`）、`routing/rollback` 回读删除（`:893-922`）、`finish` 填充未知/未填充 fail-closed 且 save 未确认报 `PCB_SAVE_UNCONFIRMED`（`:945-990`，P0-A 已修）；pour/create 属性级读回+失败删除+保存失败删除（`server.mjs:3300-3357`）。
- **在途自动化每写步骤前 assert 写门禁**：`runner.mjs:162-166,238-256`（抛错→`aborted_by_write_gate`，不假失败）、`server.mjs:4431-4432` 接线；`automation-abort.test.mjs` 覆盖（含只读步骤不拦）。
- **自动化 run 跨进程互斥**：`run-lock` 文件锁 + 陈旧接管 + 跨进程测试通过（`automation-run-lock.test.mjs` 9 + `run-lock-cross-process.test.mjs` 1）。
- 路由契约测试 3/3（无孤儿路由），本次运行见 §8。

---

## 2. 写路由逐条核对（P1-11 专表）

> 判定：目标绑定 = 请求/批准/实际写入三者的 documentUuid 是否一致（含在途漂移）；读回 = 是否有"成功≠生效"的独立断言；回滚 = 失败是否尝试恢复并如实报告。
> `withEdaWriteLock` 列全为 ❌：该模块未被任何路由调用（P1-1）。`PcbManager lease` 列只有 `/api/pcb/execute` 为 ✅。

### 2.1 `EDA_WRITE_ROUTES`（18 条，`server.mjs:161-180`；分发前置暂停 `:1727-1728`）

| # | 路由 | write-gate | 一次性写批准 | 目标绑定 | 读回断言 | 保存确认 | 回滚/残留上报 | 判定 |
|---|---|---|---|---|---|---|---|---|
| 1 | `/api/eda/schematic/repair` | ✅ | ✅（但 UI 不带，P1-2） | 🟥 不比对批准文档（P1-3） | ✅ 网表 diff + 重跑验收 | ✅ `schematic.save===true` | ✅ 删除/恢复+`rollbackClean`（`schematic-repair.mjs:292-325`） | 🟥 |
| 2 | `/api/eda/schematic/net-connect` | ✅ | ✅ | ✅ pageUuid vs 批准文档 | ✅ 逐引脚网表核对 | ✅ | ✅ 删除+保存+回读（`net-connect.mjs:236-299`） | ✅ |
| 3 | `/api/eda/schematic/net-connect/rollback` | ✅ | ✅ | ✅ | ✅ 图元消失+目标引脚回无网 | ✅ | —（本身是回滚） | ✅ |
| 4 | `/api/eda/schematic/designators/set` | ✅ | ✅ | ✅ | ✅ 独立 `parts.read` 逐件比对 | ✅ | ❌ 保存后读回不符不回滚（P2-3） | 🟨 |
| 5 | `/api/eda/schematic/component-batch` | ✅ | ✅ | ✅ | ✅ 保存后读回缺件/重复件 | ✅ | ❌ 失败即停（有续跑状态文件，E8 诚实） | 🟨 |
| 6 | `/api/eda/pcb/placement/apply` | ✅ | ✅ | 🟥 批准后按 body.pcbUuid 重新激活（P0-2） | ✅ 逐项几何回读+规则审计 | ❌ 永不自动保存（产品选择） | ✅ 回滚+`manualCoordinates` | 🟥 |
| 7 | `/api/eda/pcb/routing/apply` | ✅ | ✅ | 🟨 只写活动文档，无在途漂移校验（P1-4） | ✅ id+几何回读，独立 DRC 复核 | ✅ `PCB_SAVE_UNCONFIRMED` | ✅ 回滚+residual | 🟨 |
| 8 | `/api/eda/pcb/routing/rollback` | ✅ | ✅ | 🟨 同上 | ✅ 删除后回读 residual | ✅ | —（本身是回滚） | 🟨 |
| 9 | `/api/eda/pcb/routing/finish` | ✅ | ✅ | 🟨 同上 | ✅ 填充读回（UNKNOWN/INCOMPLETE fail-closed） | ✅ | ❌ 失败不恢复内存板态（P2-3） | 🟨 |
| 10 | `/api/eda/pcb/pour/create` | ✅ | ✅ | 🟥 请求 pcbUuid 被忽略，写活动板（P1-5） | ✅ 属性级（net/layer/id） | ✅ | ✅ 删除+计数回读 | 🟨 |
| 11 | `/api/eda/pcb/layers` | ✅ | ✅ | 🟨 只写活动文档 | ✅ 层数+层 id+type | ✅ | ❌ 读回不符不回退（P2-3） | 🟨 |
| 12 | `/api/eda/workspaces` | ✅ | ❌（建工程，非板数据；`bridge workspace.create` allowWrite） | n/a | 返回创建结果 | n/a | n/a | ⬜（PCB 链外） |
| 13 | `/api/design/approve` | ✅ | n/a（签发计划批准） | ✅ projectId/documentUuid 入账 | n/a | n/a | n/a | ✅ |
| 14 | `/api/design/execute` | ✅ | ✅ 计划令牌 | ✅ 三阶段 `APPROVAL_TARGET_MISMATCH`（`design.mjs:449-465,513-516,559-562`） | ✅ DRC/回读 | ✅ | ✅ 回滚+`writeLocked` | ✅（原理图链） |
| 15 | `/api/pcb/approve` | ✅ | n/a（签发计划批准） | ✅ 指纹入账 | n/a | n/a | n/a | ✅ |
| 16 | `/api/pcb/execute` | ✅ | ✅ 计划令牌 | ✅ 三阶段 `PCB_TARGET_DRIFT` | ✅ 按类型 | ✅ | ✅ + 持久安全锁 | ✅ |
| 17 | `/api/automation/approvals` | ✅ | n/a（签发写批准） | ✅ 绑定当前指纹 | n/a | n/a | n/a | ✅ |
| 18 | `/api/automation/run` | ✅ + 在途每写步骤 assert | ✅ 配方/步骤批准 | ✅ 指纹+批准 id 入审计链 | 🟨 取决于配方（P0-1/P2-7） | 取决于配方 | ✅ 回滚动作/needs_human | 🟨 |

### 2.2 不在 Set 内但能写 EDA 的入口

| 路由 | 处理 | 判定 |
|---|---|---|
| `POST /api/eda/gui/execute` | 路由内按动作区分读写（`server.mjs:4278`），非只读只过暂停；**无写批准、无 safety 矩阵、无读回/回滚**（P1-6） | 🟥 |
| `POST /api/eda/pcb/drc/start` | 桥命令 `pcb.drc.job.start` 属 `validate` 权限，但调用时带了 `allowWrite:true`（`server.mjs:3495`）；不写板数据，暂停期允许（有意） | ⬜（不属设计写） |
| `POST /api/pcb/write-lock/release` | 无写暂停/写批准检查（P2-4） | 🟨 |
| `POST /api/evidence/retention/prune` | 非 EDA 写，却因 `requireWriteApproval` 受写暂停+写批准约束（P2-8） | ⬜ |

### 2.3 锁覆盖专表（P1-11 的核心问法：跨进程锁到底包住谁）

| 路由 | `EDA_WRITE_ROUTES`（暂停门禁） | `withEdaWriteLock`（跨进程文件锁） | `pcb-write-lock.json`（PcbManager 租约） | 判定 |
|---|---|---|---|---|
| `/api/eda/schematic/repair` | ✅ | ❌ | ❌ | 🟥 |
| `/api/eda/schematic/net-connect` | ✅ | ❌ | ❌ | 🟥 |
| `/api/eda/schematic/net-connect/rollback` | ✅ | ❌ | ❌ | 🟥 |
| `/api/eda/schematic/designators/set` | ✅ | ❌ | ❌ | 🟥 |
| `/api/eda/schematic/component-batch` | ✅ | ❌ | ❌ | 🟥 |
| `/api/eda/pcb/placement/apply` | ✅ | ❌ | ❌ | 🟥 |
| `/api/eda/pcb/routing/apply` | ✅ | ❌ | ❌ | 🟥 |
| `/api/eda/pcb/routing/rollback` | ✅ | ❌ | ❌ | 🟥 |
| `/api/eda/pcb/routing/finish` | ✅ | ❌ | ❌ | 🟥 |
| `/api/eda/pcb/pour/create` | ✅ | ❌ | ❌ | 🟥 |
| `/api/eda/pcb/layers` | ✅ | ❌ | ❌ | 🟥 |
| `/api/eda/workspaces` | ✅ | ❌ | ❌ | ⬜（建工程非板数据） |
| `/api/design/approve` | ✅ | ❌ | ❌ | ⬜（不写 EDA） |
| `/api/design/execute` | ✅ | ❌ | ❌ | 🟨（原理图链，内存 running 互斥） |
| `/api/pcb/approve` | ✅ | ❌ | ❌ | ⬜（不写 EDA） |
| `/api/pcb/execute` | ✅ | ❌ | ✅（`pcb.mjs:496-526,753`） | ✅（仅此一条有跨进程互斥） |
| `/api/automation/approvals` | ✅ | ❌ | ❌ | ⬜（不写 EDA） |
| `/api/automation/run` | ✅ + 在途 assert | ❌ | ❌ | 🟨（有独立 `automation-run.lock`，但与手工写不互斥） |
| `/api/eda/gui/execute`（Set 外） | ✅（路由内） | ❌ | ❌ | 🟥 |
| `/api/pcb/write-lock/release`（Set 外） | ❌ | ❌ | ❌ | 🟨（P2-4） |

**结论**：`withEdaWriteLock` 覆盖 **0/18**；`pcb-write-lock.json` 覆盖 **1/18**；自动化 `automation-run.lock` 覆盖 `/api/automation/run` 但与手工写路由互不感知。即"写锁"实质上只保护"受控计划执行"这一条，其余 17 条写路由只有"写暂停"这一道（暂停不是互斥：未暂停时两个请求仍可并发写）。

---

## 3. 闭环矩阵

### 3.1 受控计划链（`/api/pcb/execute`，主路径）

| 环节 | 期望 | 证据（file:line） | 判定 | 缺什么 |
|---|---|---|---|---|
| 语义计划/编译 | 计划可归一化、合法操作白名单、DRC 必须最后 | `pcb.mjs` `normalizePcbPlan`（`:112-209`）、双哈希 `attachPlanLineage` | ✅ | — |
| 写入批准 | 一次性、绑定计划哈希+窗口+指纹+双血缘 | `pcb.mjs:734-741`；`automation/approvals.mjs:28-40`；UI `EdaPage.tsx:639-650`（批准）+`:651-720`（执行） | ✅ | — |
| 目标 documentUuid | 执行前/每批写入前/回读前/回滚前三阶段校验 | `pcb.mjs:543-558,760,854-856,942,972,1017` | ✅ | — |
| 写锁 | 跨进程互斥，崩溃/stale 可接管，安全锁跨重启 | `pcb.mjs:496-526,1043-1048,421-431` | ✅（仅本链） | 其它写路由无锁（P1-1） |
| 快照 | 写前源码快照+摘要；阶段快照 | `pcb.mjs:768-779,800-846` | ✅ | — |
| 写入 | 分批、超时、逐操作事件 | `pcb.mjs:798-846` | ✅ | — |
| 按类型回读 | outline/line/via/pour/component.modify 逐类断言；读回不可用时如实 unverifiable | `pcb.mjs:563-655,866-870` | ✅ | 混合计划 sync 缺比对（P1-9） |
| 落板比对 | 有 expectations 缺件失败回滚；纯同步空转失败 | `pcb.mjs:880-899` | 🟨 | 混合计划/已存在位号可绕过（P1-9/P2-1） |
| 保存 | `pcb.save===true` 才继续 | `pcb.mjs:826,840` | ✅ | — |
| DRC | 官方 DRC 必须晚于最后写入；基线只追新增；无基线严格 | `pcb.mjs:900-930`；`drcVerdict` `:214-225` | 🟨 | 截断不进裁决（P1-7） |
| 回滚 | 定向删除 or 整档恢复；口径/残留诚实；失败持久锁 | `pcb.mjs:936-1048` | ✅ | — |

### 3.2 布局/布线/铺铜/叠层直连通道（横向）

| 环节 | placement/apply | routing/apply·finish·rollback | pour/create | layers | schematic/repair |
|---|---|---|---|---|---|
| 写暂停（global+session） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 一次性写批准 | ✅ | ✅ | ✅ | ✅ | ✅（UI 不带，P1-2） |
| 批准目标=执行目标 | 🟥 可被 body.pcbUuid 重定向 | 🟨 只写活动文档 | 🟥 请求目标被忽略 | 🟨 只写活动文档 | 🟥 可被 pageUuid 重定向 |
| 快照/基线 | 逐项 from 坐标 | 铜几何快照+DRC 基线 | 覆铜 id 快照 | 层栈 before | 网表 before |
| 读回断言 | ✅ 几何+规则 | ✅ id+几何 | ✅ 属性 | ✅ 层/类型 | ✅ 网表 diff+验收 |
| 保存确认 | ❌ 永不保存 | ✅ | ✅ | ✅ | ✅ |
| 失败回滚 | ✅ + manualCoordinates | ✅ + residual | ✅ + 删除回读 | ❌ 不回退 | ✅ + rollbackClean |
| 读回失败如实上报 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 在途文档漂移 | 🟥 无 | 🟥 无 | 🟥 无 | 🟥 无 | 🟥 无 |
| 跨进程写锁 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 综合判定 | 🟥 | 🟨 | 🟨 | 🟨 | 🟥 |

### 3.3 自动化写通道（配方级）

| 环节 | 期望 | 证据 | 判定 |
|---|---|---|---|
| 写暂停（起点+在途每写步骤） | 命中即 `aborted_by_write_gate` | `runner.mjs:162-166,238-256`；`server.mjs:4431-4432`；`automation-abort.test.mjs` | ✅ |
| 批准 | 配方/步骤 requiredApprovals 解析并写审计链（approvalIds/fingerprint） | `server.mjs:4417-4420,4431-4448`；`runner.mjs:207-222` | ✅ |
| 读回断言 | 每步 `expect.readback`+断言；失败即停 | `runtime/automation/verify.mjs:14-120` | 🟨 断言强度取决于配方 |
| `pcb-sync-from-schematic` | 应证明"同步真的生效" | `recipes.mjs:407-446` 只比器件数；真机已误判 completed | 🟥（P0-1） |
| `pcb-create-pour` | 属性级读回 | `recipes.mjs:472-510` 只 `pours.length ≥ expected` | 🟨（P2-7） |
| 回滚 | 声明回滚的配方（create-pour v2）删差集 | `recipes.mjs:495-497`；`automation-halfwrite.test.mjs` | ✅ |
| 审计链/证据 | journal 哈希链、before/after 截图、approvalIds | `automation/audit-bundle.mjs`；E11 文档 | ✅（仅 run） |

---

## 4. 关键发现详述

### 4.1 P1-11 复核：跨进程写锁是"交付了模块，没接线"

- `runtime/eda-write-lock.mjs` 本身质量没问题：`wx` 原子抢锁、stale 接管、token 校验释放、`inspectEdaWriteLock` 诊断（`:77-137`），测试 5 条通过（`eda-write-lock.test.mjs`）。
- **但产品代码零调用**：`runtime/server.mjs:62` 仅 `import { withEdaWriteLock }`，全仓 grep 只有模块自身与测试；`grep "EDA_WRITE_LOCKED"` 在产品代码里 0 命中 → 该错误码永远不会出现。
- 真实生效的写互斥只有两条：①自动化 run 的文件锁（`automation/run-lock.mjs`，跨进程，E7 ✅）；②`PcbManager` 的 `pcb-write-lock.json` 租约（`pcb.mjs:496-526`），**只在 `execute()` 里 acquire**（`:753`），其它 17 条写路由完全不经过它。
- 结论：P1-11 的"代码闭环但写锁未覆盖全部写路由"应改判 **🟥（未闭环）**：不仅"未覆盖全部"，而是"覆盖 1/18"；`flow-gap-audit-2026-10-29.md:43,55` 与 checklist 的 🟨 口径偏乐观。

### 4.2 P0-2 复现（离线探针）：placement/apply 批准 A、写 B

```
批准绑定当前文档 D1（POST /api/automation/approvals {scope:'write'}）
POST /api/eda/pcb/placement/apply {dryRun:false, pcbUuid:'D2', plan:{placements:[]}, approvalIds:[id]}
→ HTTP 200；桥调用记录：pcb.open {documentUuid:'D2'}
```

请求链路：`requireWriteApproval`（`server.mjs:3122`）→ 校验批准与"当前 D1"一致 → 返回值丢弃 → `readPcbPlacement(body.pcbUuid)`（`:3124`）→ `activatePcbDocument('D2')`（`:1073-1087`）→ 后续 `applyPlacementPlan` 在 D2 上写。
UI 触发条件：`PlacementPage` 的"PCB 文档 UUID"可手填（`PlacementPage.tsx:186`），批准在客户端用"当前指纹"签发（`:112`），因此多板工程中字段与当前活动板不一致时就会写错板。

### 4.3 P1-3 复现（离线探针）：repair 批准 S-A、写 S-B

```
批准绑定 S-A
POST /api/eda/schematic/repair {dryRun:false, approvalIds:[id], pageUuid:'S-B'}
→ 桥调用记录：schematic.open {pageUuid:'S-B'}（随后仅因假桥网表为空返回 EDA_NETLIST_EMPTY）
```

对照：同样"批准 S-A、pageUuid S-B"打到 `net-connect`/`designators/set`/`component-batch`，三条均 `409 AUTOMATION_APPROVAL_INVALID`（探针已验证）。说明修复只需要把 `repair` 改成其他三条的写法（接收 `approvedTarget` 并走 `ensureSchematicActive`）。

### 4.4 P1-2 复现（离线探针）：修复按钮必 409

```
POST /api/eda/schematic/repair {dryRun:false, pageUuid:'S1'}   // 无 approvalIds
→ 409 AUTOMATION_APPROVAL_REQUIRED
```

`ValidationPage.tsx:1284` 的调用里没有 `approvalIds`，`runtimeClient.repairSchematic` 的入参类型也不含该字段（`:792-794`）。即：其它写按钮（placement/routing/叠层/批量落件）都先 `issueAutomationApproval({scope:'write'})`，只有这个没有。

### 4.5 P0-1：`pcb-sync-from-schematic` 仍是 count-only

- 配方 v2（`recipes.mjs:407-446`）：
  - action `pcb.importChanges`；
  - readback `pcb.placement.read`；
  - assertions：`components nonEmpty`、`componentCount atLeast {expectedComponentCount}`；
  - GUI 兜底=点菜单后点「应用」，兜底后**确实会重新读回**（`runner.mjs:367-385`），但读回仍是同一套 count 断言，不能证明同步生效。
- `pcb.placement.read` 的 `componentCount` 是真实器件数（`bridge.mjs:373-430`），所以 count 是可信读数——问题在于**它不足以证明同步**：`importChanges` 弹窗未应用/部分应用时器件数可以不变或已在阈值上，配方仍 `completed`。
- supervisor 文档（`supervisor-readonly-2026-11-02.md:118-119,141`）已记录真机误判并列为待补；HEAD 未改（`recipes.mjs` 最近提交仍在 2026-10-19 v2）。
- 影响：这是自动化中心里**唯一登记的同步配方**；误判 `completed` 会让"源修复→官方 DRC→工单收口"的叙事建立在未证明的同步上，且 run 会写 `verified` 证据。
- 验收建议（无需真机即可测）：假桥"importChanges 只返回 true、板面 designators 不变" → 配方必须失败；断言应改为"逐 designator diff 清零"或"官方 DRC/netlist 等价"，而不是计数。

### 4.6 回滚与"如实上报"逐通道结论

| 通道 | 失败回滚 | 失败了会怎么说 | 判定 |
|---|---|---|---|
| `/api/pcb/execute` | 定向删除/整档恢复，回滚前再验文档 | `rolled_back`/`rollback_failed` + `rollbackScope` + `retainedStages` + 持久安全锁 | ✅ |
| placement/apply | 反向写回原坐标 | `rollback.ok=false` + `manualCoordinates` + blocking finding | ✅ |
| routing/apply | 按 id 删除新铜 | 错误 details 带 missing/residual | ✅ |
| routing/rollback | 删除并回读 | `residual` 列表 | ✅ |
| routing/finish | ❌ 不恢复内存板态 | `ok:false` 且不保存；文案"本次没有保存" | 🟨（诚实但半写内存） |
| pour/create | 删除新建图元并回读 | `rollback`/`leaked` 明细 | ✅ |
| layers | ❌ 不回退层数 | 409 带 before/after/缺层；但板面内存已变 | 🟨 |
| schematic repair | 删除/恢复+重读网表 | `rollbackClean`/`rollbackStrategy`/`events` | ✅ |
| net-connect | 删除端口+保存+回读 | `rollback` 事件 + 失败码 | ✅ |
| designators/set | ❌ 不回滚 | 409 逐件 expected/actual | 🟨 |
| component-batch | ❌ 失败即停（有续跑状态） | 失败项+已有进度文件 | 🟨（E8 已声明不可逆写不假装恢复） |
| automation 配方 | 仅声明了 rollback 的配方（create-pour v2） | `rollback_failed` + needs_human | ✅/🟨 按配方 |

**没有发现"回滚失败却报成功"的通道**：所有失败分支都以非 2xx / `ok:false` 返回，UI 侧（`RoutingWritePanel.tsx:141-199`、`EdaPage.tsx:310-321,662`）按失败呈现。

---

## 5. 修复建议

| 编号 | 文件 | 行为改动 | 测试 | 风险 | 无需真机？ |
|---|---|---|---|---|---|
| **P0-1** | `runtime/automation/recipes.mjs:407-446`（可加 `runtime/automation/verify.mjs` 新断言 op 或新 readback kind） | 把 `pcb-sync-from-schematic` 读回改成"逐 designator 集合相等"：新增 compose 读回 `pcb.components.read`，并新增 `equalsSet`/`containsAll` 断言（或复用 `/api/pcb/sync/verify` 的 `diffPcbAgainstNetlist` 逻辑封装为内部执行器）；`expectedDesignators` 由调用方只读传入；GUI 兜底后强制再读回 | 假桥"importChanges 返回 true 但 designators 不变"⇒ `failed`（不得 `completed`）；真机行为不变 | 配方 v3 需更新 `RECIPE_CHANGELOG` 与参数推断（`params-inference.mjs:51-56`）；调用方要多传 designators | ✅ 单元可证；真机复验属加分项 |
| **P0-2** | `runtime/server.mjs:3117-3150` | `approvedTarget = await requireWriteApproval(body)`；`readPcbPlacement(body.pcbUuid)` 后比对 `resolvedPcbUuid === approvedTarget.documentUuid`，不一致抛 `AUTOMATION_APPROVAL_INVALID`（或 `PCB_TARGET_DRIFT`），**在写入前**；`placement/plan` 同样透传目标 | 假桥批准 D1 + 请求 D2 ⇒ 409 且 0 写命令；两板 fixture | 老 UI 若传与当前不同的 pcbUuid 会从"静默写错"变成"显式 409"，需 UI 提示 | ✅ 离线 HTTP 可测 |
| **P1-1** | `runtime/server.mjs`（新增统一 **wrappedWriteRoute** 或 `assertEdaWritesOpen` 同级中间件）；`runtime/eda-write-lock.mjs` | 把 18 条写路由的 handler 统一包进 `withEdaWriteLock({dir: stateDir, key:'eda-write'}, handler)`（或按 documentUuid 分段 key）；`/api/pcb/execute` 已经持有 PcbManager 租约，需防止双重锁（统一到一把锁或检测嵌套）；补 `GET` 锁状态路由/诊断 | 两个并发 placement/routing 请求一 200 一 409 `EDA_WRITE_LOCKED`；跨进程两个 Runtime 实例同上；锁冲突时**不消耗批准**（参考 `pcb.mjs:753` 先锁后 consume） | 单用户桌面并发少，误锁/卡死需 staleMs 与诊断入口；与 automation run-lock 的关系要写清 | ✅ 单元+HTTP 可测 |
| **P1-2** | `src/services/runtimeClient.ts:792-794`、`src/pages/ValidationPage.tsx:1276-1290` | `repairSchematic` 增 `approvalIds?: string[]`；页面在 `dryRun:false` 时先 `issueAutomationApproval({scope:'write', note:'原理图修复'})` 再执行；失败提示"先签发批准" | vitest：点击执行修复会先调批准再调 repair；HTTP 层沿用现有 | 修复本身会写原理图，仍要二次确认框（当前按钮无 confirm） | ✅ 无需真机 |
| **P1-3** | `runtime/server.mjs:2721-2745` | 照抄 `net-connect` 写法：`const approvedTarget = await requireWriteApproval(body)`（dryRun:false 时），`ensureSchematicActive({pageUuid, documentUuid, approvedTarget})`，替代手写 open+轮询 | 批准 S-A + pageUuid S-B ⇒ 409 `AUTOMATION_APPROVAL_INVALID`，桥收到 0 个 `schematic.open` | 低；需保证 `ensureSchematicActive` 对"未传 pageUuid 但当前是另一页"也校验 uuid（见 P1-4 建议） | ✅ 离线可测 |
| **P1-4** | 新增 `runtime/document-binding.mjs`（或在 `server.mjs` helper）；改 `server.mjs` 各写路由；`engineering/pcb-routing.mjs`/`placement-write.mjs` 增加 `assertDocument` 回调 | 每条写路由在"写批次前/回读前/回滚前"读一次 `document.current.uuid` 并与请求/批准绑定值比对（等价于 `pcb.mjs:543-558`），漂移抛 `PCB_TARGET_DRIFT` 并停止；routing 的 DRC 守卫前后各查一次 | 假桥在写第 2 段前后切换 `document.current` ⇒ 失败且不写新板；单测覆盖 routing/placement/pour | 增加读命令开销（每条写 1-3 次 `document.current`，可接受）；需考虑 EDA 在批量写期间 `document.current` 偶发失败的重试 | ✅ 假桥可测 |
| **P1-5** | `runtime/server.mjs:1119-1145`（`ensurePcbDocument`） | 显式传 `pcbUuid` 时若与当前活动 PCB 不同，应**主动打开目标板**（`activatePcbDocument`）或直接 409 `PCB_DOCUMENT_REQUIRED`（不允许静默用当前板）；返回值带上实际 pcbUuid 供调用方核对 | 两板 fixture：请求 D2、当前 D1 ⇒ 打开 D2 或 409；返回体 `pcbUuid` 与请求一致 | 会改变 `layers`/`finish` 等调用方行为（它们目前依赖"用活动板"），需一起梳理调用点 `:3410-3412,3252-3265` | ✅ 离线可测 |
| **P1-6** | `runtime/server.mjs:4269-4281` | 二选一并写进文档/UI：①非只读 GUI 动作也要求 `approvalIds`（绑定动作+目标指纹，`/api/automation/approvals` scope=write），并用 `executors.mjs` 同一套 safety 校验（`assertGuiActionAllowed`/`assertSafeText`/`assertNotCheckoutTarget`/`assertShortcutAllowed`）；②明确定位为"受信任人工输入通道"并改掉 UI 绝对化文案 | 无批准 `click/clickText` ⇒ 409；危险文案/快捷键 ⇒ 拒绝；只读 state/screenshot 不受影响 | 会影响自动化 GUI 兜底以外的人工/Agent 用法；须确认无隐藏消费者（目前 `src/` 0 消费者，Agent 测试断言 allowed） | ✅ 离线可测；真机点击验收另计 |
| **P1-7** | `runtime/pcb.mjs:214-225,900-930` | `drcVerdict` 增加 `truncated`/`baselineTruncated` 入参：任一为 true ⇒ `passed:false`（或 `unknown`，禁止 pass）；把 `truncated` 写入 `execution.drc`；与 `drc.mjs:289` 统一口径 | 单测：`truncated:true` 时不得 completed；基线截断不得判 pass | 大会被要求"分页取全量"或人工确认，属预期 fail-closed | ✅ 单测可测；真实截断形态需真机 |
| **P1-8** | `src/pages/EdaPage.tsx:308,362`、`src/pages/ValidationPage.tsx:1266` | 两处 `pcbSyncVerify(pcbUuid)` 传目标；服务端返回的 `pcbUuid` 与请求不一致时抛 `PCB_SYNC_TARGET_MISMATCH`（新增错误码） | vitest：传入目标后 request path 带 query；服务端双板 fixture 不匹配报错 | 低 | ✅ 无需真机 |
| **P1-9** | `runtime/pcb.mjs:880-899` | 只要计划含 `pcb.importChanges`：①强制要求 `expectations`（或调用方显式声明 `syncNotRequired`）；②混合计划也做"designator 集合写前/写后增量"检查，无增量失败 `PCB_SYNC_NO_EFFECT` | 单测：混合计划（line.create + importChanges）空转 ⇒ 失败回滚 | 会拒绝一部分历史"混合计划"；需产品确认 | ✅ 单测可测 |
| **P2-1** | `runtime/pcb.mjs:880-890` | expectations 分支增加"写前存在性快照"：期望集合 ⊆ 写前 designators ⇒ `PCB_SYNC_NO_EFFECT`；至少 1 个"写前不存在、写后存在" | 单测：expectations 全为既有位号 + importChanges 空转 ⇒ 失败 | 低 | ✅ |
| **P2-2** | `src/pages/PlacementPage.tsx:105,224`（含 restore `:140-160`） | 写回/还原按钮与守卫统一用 `writeGateClosed = writePaused || sessionPaused`，并给 title | vitest 现有页面测试补一条 | 低 | ✅ |
| **P2-3** | `runtime/server.mjs:3410-3455`（layers）、`:2914-2938`（designators）、`runtime/engineering/pcb-routing.mjs:945-990`（finish） | 选择：要么补最小反向写（layers 回退到 beforeCount；designators 反向 set），要么把失败文案/返回体显式标注"内存板态已改变、未保存/未回退"（同 E8 口径），并让 UI 显示 | 每类失败单测断言返回字段与文案 | 反向写本身有风险（层数回退可能丢内容）；至少先做到"诚实标注" | ✅ 前者需真机验证；后者纯代码/测试 |
| **P2-4** | `runtime/server.mjs:4065-4068`、`src/pages/EdaPage.tsx:516-545` | 解除安全锁要求一次性 write 批准 + 必填 operator/note 服务端校验 + 审计 ledger；前端二次确认（输入上一次 executionId 或 digest） | HTTP：无批准 release ⇒ 409；有批准 ⇒ 200 且 ledger/journal 有记录 | 会增加"救火"步骤，但安全锁本来就是事故后动作 | ✅ 离线可测 |
| **P2-8** | `runtime/server.mjs:3709-3719` 或文档 | 二选一：把"写暂停"定义收窄为"EDA 写"（prune 只要求写批准，不受暂停阻断），或文档明示"破坏性文件操作也在暂停范围内" | 现有 write-gate 测试不变 | 语义选择 | ✅ |
| **P2-5/6/7** | 文档 + 小改 | P2-5 在 docs/checklist 写清"暂停期 dryRun 也被拒"；P2-6 给直连写路由加 approvalId→journal 关联（低成本）；P2-7 把 create-pour 配方断言升为属性级（读回 `pours` 里 net/layer 匹配） | P2-5 文档；P2-7 配方单测 | 低 | ✅ |

---

## 6. 需真机边界（本次未证明的东西）

1. **真实 EDA 的 `document.current` 在批量写期间的行为**：P1-4 的三阶段校验需要真实 EDA 在 `pcb.line.create` 循环中稳定响应；本次只用假桥证明"没有校验"，没有证明真机上校验不会误杀/拖慢。
2. **`pcb.importChanges` 的真实弹窗语义**：P0-1 的判据（不改变器件数、只弹框）来自 2026-11-02 supervisor 真机记录与代码审读；本次没有连接 EDA 复现，因此"HEAD 上仍会误判"是静态+历史证据结论，不是本轮真机复现。
3. **`pcb.save` 真实返回值**：各通道（routing/pour/layers/repair）保存确认都按 `=== true` fail-closed，但真机是否会出现"返回 true 却未落盘"取决于 EDA 版本；本次未验证。
4. **GUI 通道真实点击写板**：P1-6 只证明 HTTP 层不要求批准；真实 CDP 点击「应用修改」是否成功、危险文案黑名单缺失的真实后果，需真机 GUI 会话（本次禁止）。
5. **多板工程 `pcbUuid` 解析**：P1-5/P0-2 的双板行为用假桥 fixture 证明代码路径；真实 EDA 多板工程的 `project.current.data` 形状、`pcb.open` 行为（切板是否丢未保存修改）需真机。
6. **DRC 截断真实形态**：P1-7 的 `truncated:true` 是接口字段；真实大板截断阈值/形态（`JOB_ITEM_CAP`）需真机。
7. **写锁的跨进程效果**：P1-1 修复后需要"两个 Runtime 实例 + 同一 EDA 会话"的真机/半真机验证；本次只证明模块级锁可用（`eda-write-lock.test.mjs` 5/5）但产品未接线。
8. **写暂停期间 dryRun（P2-5）** 与 UI 按钮状态（P2-2）只做了代码/离线 HTTP 检查，未做浏览器点击。

---

## 7. 复现命令（本次实际执行，全部只读/隔离）

```bash
# 1) PCB 写路径相关单测（隔离 state，避免污染真实 artifacts/state）
CIRCUITPILOT_STATE_DIR=$(mktemp -d /tmp/cp-audit-state-XXXX) \
CIRCUITPILOT_EVIDENCE_DIR=$(mktemp -d /tmp/cp-audit-ev-XXXX) \
CIRCUITPILOT_AUTOMATION_DIR=$(mktemp -d /tmp/cp-audit-auto-XXXX) \
node --test --test-timeout=120000 \
  runtime/__tests__/pcb.test.mjs \
  runtime/__tests__/pcb-routing.test.mjs \
  runtime/__tests__/pcb-write-lock.test.mjs \
  runtime/__tests__/eda-write-lock.test.mjs \
  runtime/__tests__/write-gate-http.test.mjs \
  runtime/__tests__/placement-write.test.mjs \
  runtime/__tests__/placement-rules.test.mjs \
  runtime/__tests__/pour-create.test.mjs \
  runtime/__tests__/routing-drc.test.mjs
# => tests 95 / pass 95 / fail 0

# 2) 自动化写暂停/半写/锁
node --test runtime/__tests__/automation-abort.test.mjs \
  runtime/__tests__/automation-halfwrite.test.mjs \
  runtime/__tests__/automation-run-lock.test.mjs \
  runtime/__tests__/run-lock-cross-process.test.mjs
# => tests 22 / pass 22 / fail 0

# 3) 路由契约（无孤儿）
node --test runtime/__tests__/route-contract.test.mjs   # => 3/3

# 4) 静态证据：跨进程写锁是死代码
grep -n "withEdaWriteLock" runtime/server.mjs           # 只有 line 62 import
grep -rn "withEdaWriteLock" runtime --include=*.mjs     # 除模块外只有测试
grep -rn "EDA_WRITE_LOCKED" runtime --include=*.mjs     # 产品代码 0 命中（仅模块/测试）
grep -n "acquireWriteLease" runtime/pcb.mjs             # 496, 753（仅 execute）

# 5) 离线 HTTP 探针（node --input-type=module，临时 /tmp state，假桥，随机端口；
#    不连 EDA/Bridge、不启动 4177/4178）
#    5.1 写暂停：18 条 EDA_WRITE_ROUTES 全部 409 EDA_WRITE_PAUSED
#        session scope 抽样 3 条 => 409 EDA_WRITE_PAUSED, details.scope="session"
#    5.2 repair 无批准 => 409 AUTOMATION_APPROVAL_REQUIRED
#    5.3 repair 批准 S-A + pageUuid S-B => 桥收到 schematic.open {pageUuid:"S-B"}
#             （对照 net-connect/designators/batch => 409 AUTOMATION_APPROVAL_INVALID）
#    5.4 placement/apply 批准 D1 + pcbUuid D2 => 200 且桥收到 pcb.open {documentUuid:"D2"}
#    5.5 pour/create 批准 D1 + pcbUuid D2 => 200、无 pcb.open、pcb.pour.create 落在活动 D1
#    5.6 /api/eda/gui/execute {action:'click'} 无批准 => 400 EDA_GUI_CDP_UNAVAILABLE
#             （穿过批准环节，不是 409）
#    5.7 /api/pcb/write-lock/release 无批准 => 200 {"released":false,"reason":"not-locked"}
```

**本次明确未做**：未连接 EDA/Bridge、未启动/重启 4177/4178、未跑 acceptance/live e2e/Playwright、未发真实写命令、未改源码/测试/配置、未做 git 写操作。所有探针均为内存态假桥 + 临时目录 + 随机端口。

---

## 8. 与历史审计的对应关系

- **P1-11（flow-gap-audit 2026-10-29 §0.1）**：文档口径 🟨"代码闭环但写锁未覆盖全部写路由"；本轮核实为 **🟥 模块未被调用（覆盖 1/18）**，且仅有 `PcbManager` 租约覆盖 `/api/pcb/execute`。
- **旧 PCB 审计（flow-audit-2026-10-29/02-pcb.md）**：P0-A（save 未确认）已修（`PCB_SAVE_UNCONFIRMED`，`pcb-routing.mjs:866-878,981-990`）；P0-B（document 未绑定）**在受控计划链已修**，但直连通道仍有目标漂移（本报告 P1-3/P0-2/P1-4）；P1-B/P1-C/P1-F 仍未修（本报告 P2-1/P1-8/P1-7）；P1-E（rollback_failed 锁不持久）已修。
- **supervisor 文档 2026-11-02 §5.1 第 4 条**：`pcb-sync-from-schematic` count-only 读回误判 completed —— 本轮确认 HEAD 仍在（P0-1）。
- **平台审计 2026-10-29 P1-3（写互斥只覆盖自动化）与 P1-8（GUI 写无批准）**：本轮确认仍在（P1-1/P1-6）。

---

*本文件由只读审计生成；行号基于 2026-11-05 工作区（HEAD 98429be）。修复后请同步更新行号与 §8 对应关系。*
