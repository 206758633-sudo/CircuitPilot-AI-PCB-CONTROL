# 01 设计链复审：AI 设计 → 原理图受控写入（修复后）

> **修复收口（2026-10-29 晚）**：本文件是复审当时的证据与问题清单；所列 P0/P1 已在本轮"请全部修复"中逐项落地，当前状态以 `../flow-gap-audit-2026-10-29.md` §0.1 为准。下文保留原始判定以说明修复对象，不代表仍未解决。


> 复审日期：2026-10-29 · 方式：只读静态审计 + 隔离环境单文件 runtime 测试（未连接 EDA/Bridge，未重启服务，未使用 git）
> 基线：`docs/implementation/flow-gap-audit-2026-10-26.md` §2.5（2026-10-29 九项 P0 修复记录）；上一轮结论 `docs/implementation/flow-audit-2026-10-26/01-design-chain.md`
> 判定口径：✅已打通 / 🟨半打通 / 🟥断点 / ⬜纸面 / 🚫当前不可验证。**“代码存在”不等于打通**，须有执行路径与证据链。

## 1. 流程节点表

| # | 节点 | 判定 | 证据（file:line） | 说明 |
|---|---|---|---|---|
| N1 | 需求/器件/资产 → AI 语义计划 + 生产编译（双哈希） | ✅ | `src/pages/EdaPage.tsx:204-214`；`runtime/production.mjs:319-320` | 编译产物同时给出 `semanticPlanHash` 与 `compiledPlanHash` |
| N2 | 语义计划跨页交接（AI 页 → EDA 页草稿） | ✅ | `src/pages/AiTasksPage.tsx:227-232`；`src/pages/EdaPage.tsx:160-170`；`src/services/draftStore.ts:37,44` | 草稿带 planHash，EDA 页载入后强制重新校验 |
| N3 | 编译产物 → 可执行 PCB 计划（血缘参与 planHash） | ✅ | `src/pages/EdaPage.tsx:217-231`；`runtime/pcb.mjs:147-148` | `semanticPlanHash/compiledPlanHash` 进入计划字段 |
| N4 | 真实目标上下文（窗口/文档/源码指纹） | 🟨 | `src/pages/EdaPage.tsx:370-383`；`runtime/server.mjs:3257-3261` | `open-current` 传空 uuid 时取任意原理图页；未见“当前工程/PCB = 项目绑定”的服务端校验 |
| N5 | 人工批准 + 一次性令牌 + 批准账本（双哈希整链） | ✅ | `runtime/design.mjs:124-151`；`runtime/pcb.mjs:368-381`；`runtime/server.mjs:169-174,3305-3308,3501-3506` | 令牌绑定 planHash/目标/双哈希；账本记录同一组字段 |
| N6 | 原理图受控写入（快照→写→存→回读→官方 DRC→回滚） | ✅（静态+单测） | `runtime/design.mjs:283-397`；`runtime/__tests__/design.test.mjs:80-113`（成功路径）、`:50-78`（DRC 失败回滚） | 真机本轮未复验，见 §4 |
| N7 | 写入后证据落账（执行记录/账本/阶段/验证） | 🟨 | `runtime/design.mjs:293,392`；`src/pages/EdaPage.tsx:473` | 执行记录/账本落盘；但官方 ERC/DRC 不绑 executionId（P1-1），阶段证据仍前端写（P1-6） |
| N8 | 原理图 → PCB 同步（期望位号/回读比对/失败回滚） | ✅ 主路径 | `src/pages/EdaPage.tsx:252-280`；`runtime/pcb.mjs:458-495`；`runtime/__tests__/pcb.test.mjs:263-301` | 对话同步路径会声明 expectations，执行器缺件即回滚 |
| N9 | 高级/手工 PCB 计划执行（可无 expectations 的旁路） | 🟨 | `runtime/pcb.mjs:118-146,472-484`；`src/pages/EdaPage.tsx:495-560` | 不带期望位号且含混合操作时，空转检测可能不触发（P1-4） |
| N10 | **AI 页语义计划 → 原理图写入（同一条链）** | 🟥 | `src/pages/EdaPage.tsx:217-231`（只进 PCB）；`src/pages/EdaPage.tsx:395-430`（原理图计划来自另一条 AI 网表链）；`runtime/netlist.mjs:6-47`（无血缘字段） | 原始 P0-1 的另一半未修：AI 页计划仍不驱动原理图写入（P0-1） |
| N11 | 血缘 UI 展示 | 🟨 | `src/pages/EdaPage.tsx:626,628`（批准面板显示）；`src/pages/EdaPage.tsx:642-660`（历史表只显示 planHash，详情为原始 JSON） | 批准瞬间可见；列表/详情不显式展示双哈希（P2-1），且无 e2e 覆盖（P2-5） |
| N12 | 真机端到端（EDA 3.2.186 + Bridge + 真实写入） | 🚫 | 本轮无 EDA/Bridge；`artifacts/.../led-board-import-changes-r32.json`（2026-10-22，早于修复）；`artifacts/state/*.json` 无修复后执行 | 历史真机证据只能说明“旧版曾空转”，不能证明修复后行为 |

## 2. 修复验证（逐条：证据 → 结论 → 边界）

### P0-1 计划双哈希血缘（声明范围：✅ 闭环；原始问题的另一半：🟥）

**证据链**
1. 归一化保留并参与哈希：`runtime/design.mjs:33-49`（格式校验 `^[a-f0-9]{16,64}$`、小写化、非法→null；仅非空才写入计划），`runtime/design.mjs:53,64`（reviewed-netlist / simple-control-board 都过 `attachPlanLineage`），`runtime/pcb.mjs:147-148`。
2. 令牌绑定：`runtime/design.mjs:124-140` 把双哈希放进 bindings 并在 consume 时逐字段严格比较（`runtime/approval-service.mjs:134-157`，任一不等抛 `APPROVAL_MISMATCH{field}`）；PCB 同构 `runtime/pcb.mjs:368-381`。
3. 账本落盘：`runtime/design.mjs:106-123` 把 planHash/targetFingerprint/windowId/steps/双哈希写入 `ledger.record`；`runtime/approval-ledger.mjs:41-53` 持久化到 `approvals-ledger.json`。单测断言账本条目含两哈希：`runtime/__tests__/design.test.mjs:127-156`。
4. HTTP 409：`runtime/server.mjs:169-174`（`APPROVAL_CONFLICT_CODES → 409`，兜底 400，见 `:3947-3948`），路由 `:3305-3308`（design approve）、`:3501-3506`（pcb approve/execute）。HTTP 测试：`runtime/__tests__/plan-lineage-http.test.mjs:43-72`（design 换计划→409 `APPROVAL_MISMATCH`，字段 planHash）、`:74-108`（PCB 同）。
5. 执行记录带血缘：`runtime/design.mjs:293`、`runtime/pcb.mjs:389`；类型 `src/types.ts:294-320`（`DesignApproval/DesignExecution` 可选字段）、`:363-367`（`PcbExecution`）。
6. UI 传递/展示：`src/pages/EdaPage.tsx:225-231`（编译产物两哈希传给 `normalizePcbPlan`）、`:390`（选型提案草稿注入 `semanticPlanHash`）、`:626,628`（“批准血缘（语义/编译）”）。

**结论**：在“调用方提供合法双哈希”的前提下，计划哈希、令牌、账本、执行记录、UI 批准面板已形成一条可核对链；换计划（planHash 变）在触碰 EDA 前 409。**声明范围闭环成立**。

**边界漏洞（按严重度）**
- a) **服务端不验证来源**：`/api/design|pcb/approve` 只做归一化后签发（`runtime/server.mjs:3305-3308,3501-3506`；`runtime/design.mjs:260-272`、`runtime/pcb.mjs:368-375`），没有用 `productionManager` 注册的语义/编译计划重算或反查。双哈希是**客户端自报**，本地脚本可批准“伪造来源”的计划并让账本落盘。账本证明的是“批准时绑定了这两个值”，不是“这两个值真的产出了该计划”。
- b) `compiledPlanHash` 是**编译产物哈希**，而执行的是 `normalizePcbPlan` 重建后的计划（`runtime/pcb.mjs:112-148` 只保留 board/constraints/operations/stackup/expectations，丢弃编译产物的 `frame` 等元数据）。二者不是同一对象；normalize 后是否仍是同一设计，只有客户端断言，无服务端重算/映射证明。
- c) **非法/空血缘被静默忽略**：`runtime/design.mjs:33-41` 对不合法值返回 null，`attachPlanLineage` 直接省略字段，不报错、不告警（`design.test.mjs:122-125` 把该行为固定为预期）。若前端/脚本把空串、短 UUID、非 hex 传进来，批准仍成功、面板显示“— / —”，可追溯性静默降级且账本不会留下“血缘缺失”的事实。
- d) **主原理图写入链没有血缘**：`runtime/netlist.mjs:6-47` 的 reviewed-netlist normalize/compile 不产生 `semanticPlanHash`；`generateAiPlan`（`EdaPage.tsx:395-430`）生成的计划不带来源哈希；`EdaPage.tsx:390` 只对“选型提案草稿”注入一个批量计划哈希，且字段名为 `semanticPlanHash`（语义与 AI 页语义计划不同）。因此“项目网络表 → 原理图”面板的批准血缘长期显示“— / —”（`EdaPage.tsx:628`）。
- e) **旧计划兼容**：不带血缘时 `attachPlanLineage` 不写字段（`design.mjs:42-49`），哈希输入与旧逻辑一致；plan-lineage 测试只断言“带/不带血缘哈希不同”，未对旧构建常量做回归。仓库禁止 git，无法与 10-26 版本 diff 验证“其他归一化逻辑未变”，故该点仅静态推断成立。
- f) **409 覆盖面**：planHash/windowId/targetFingerprint/双哈希任一不一致都会在 consume 时抛 `APPROVAL_MISMATCH`→409（`approval-service.mjs:146-154`；HTTP 测试覆盖 planHash）。但 `TARGET_DRIFT` 发生在 **令牌已 consume 之后**（`runtime/design.mjs:287-289`；`runtime/pcb.mjs:378-381`），返回 **400** 且令牌被烧毁；`APPROVAL_SCOPE_MISMATCH` 不在 409 集合（当前双 store 隔离使其不可达，属代码完整性瑕疵）。
- g) **账本“真落盘”证据**：本轮 HTTP 测试产生的临时账本确含双哈希（测试目录 `cp-p01-state-*` 的 `approvals-ledger.json`：`plan issued`/`plan mismatch` 两条 bindings 含 `semanticPlanHash/compiledPlanHash`）。但仓库 `artifacts/state/approvals-ledger.json` 现有 500 条中最近 2 条为 2026-10-28 的 `write`，**plan+lineage 条目为 0**；`artifacts/state/pcb-executions.json` 106 条均为 2026-10-20 旧执行（无血缘），`design-executions.json` 不存在。即：**代码路径与测试已验证落盘，工作区无修复后真实设计批准记录**。
- h) UI 展示：批准面板已显示双哈希；执行历史表无该列（`EdaPage.tsx:642-660`），刷新后只能进详情看原始 JSON。

### P0-2 原理图→PCB 落板比对（主路径 ✅；旁路 🟨）

**证据**
- `runtime/pcb.mjs:118-146`：`expectations.designators` 可选，大写/去重/拒绝 `?`/上限 2000，空期望或超限进入 `missing`（计划不可批）；仅显式提供才写入计划，旧计划哈希不变。
- `runtime/pcb.mjs:458-481`：回读后逐个比对期望位号，缺一个抛 `PCB_SYNC_INCOMPLETE`（带 missing/expected/actual）；无期望且“唯一写入是 importChanges 且源码摘要+器件数均未变”抛 `PCB_SYNC_NO_EFFECT`。
- 回滚：catch 中恢复执行前源码并校验摘要（`runtime/pcb.mjs:499-528`），失败才 `writeLocked`。
- UI 双闸：写前只读验收 + 缺件/多余/未标注位号分别处理（`EdaPage.tsx:252-280`），计划中写入 `expectations`（`:276`）；写后再次 `sync/verify` 复核，缺件仍如实报失败（`:300-321`）。
- 测试：`runtime/__tests__/pcb.test.mjs:263-301`（A 成功路径含 syncCheck 证据；B 缺件失败回滚并点名 R1）、`:303-327`（无期望纯同步空转→`PCB_SYNC_NO_EFFECT`）。

**结论**：修复前“importChanges 返回 success 但 0 器件落板却显示完成”的主路径已被执行器 + UI 双闸关闭；缺件会失败并回滚。

**边界**
- 期望可缺省：`normalizePcbPlan` 对不带 expectations 的计划照常 ready（`pcb.mjs:118-146`）；高级 PCB 流水线（`EdaPage.tsx:495-560`）没有补 expectations。空转检测要求“所有操作都属于 sync-only（importChanges/modify/save/drc）且源码摘要与器件数都不变”（`pcb.mjs:472-477`），一旦计划混入任何几何写操作，或保存导致规范化源码摘要变化，空转仍可能被记为 completed。
- 期望只校验“存在”，不校验封装/网络/位置；PCB 多出的器件只警告不阻断（`EdaPage.tsx:263-265` 在写前拦多余，执行器不拦）。
- 真机未复验：本轮无 EDA/Bridge；历史真机证据（`artifacts/wardrobe-case/pm-run-20261022/evidence/led-board-import-changes-r32.json`，2026-10-22）证明旧版曾 0→0 空转、需人工点原生对话框才 0→19，早于本次修复，不能作为修复后真机证据（见 §4）。

### P0-3 验证结果单一来源（数据层 ✅；执行链连接 🟨）

**证据**
- 官方记录唯一构造：`src/services/validationEvidence.ts:13-22`（只认 `source:'official'` + `projectId`）、`:51-80`（buildOfficialValidationRecord/KPI），`:23-31`（按 projectId+name upsert）。
- 写入口：`src/pages/ValidationPage.tsx:306-325`（落 state.validations + DRC findings 进问题中心 + DRC pass 时尝试推进阶段）；DRC 写入 `:449-461`（projectId+digest/path/jobId）；ERC 写入 `:592-606`。
- KPI/阶段：`ValidationPage.tsx:298`、`src/pages/OverviewPage.tsx:24-26`、`src/pages/DeliverPage.tsx:22`；`src/services/stageEvidence.ts:45-52`（drcPassed 只认本项目 official）、`:32-41`（netlistApproved 改由原理图执行证据派生）；阶段机要求 `原理图->PCB` 需 netlistApproved+schematicGenerated（`src/services/stageMachine.ts:85-95`）。
- 测试：`src/services/__tests__/validationEvidence.test.ts`、`stageEvidence.test.ts`、`stageMachine.test.ts` 共 27 例通过（§4）。

**结论**：KPI、问题中心、阶段门禁不再吃 Demo/种子；DRC pass 可推进“验证→生产”；切项目不会串 DRC 证据。声明范围基本闭环。

**边界**
- 官方 ERC/DRC 证据只有 `engine/digest/path/jobId`（`src/types.ts:682-688`），**没有 executionId/planHash**；`EdaPage` 原理图执行成功后不写官方验证记录（grep `official|SET_VALIDATIONS` 在 `EdaPage.tsx` 0 命中）。因此无法证明“这次受控写入的网表通过了 ERC”，阶段 drcPassed 仍要求人工去验证页再跑一次（P1-1）。
- 阶段证据仍由前端写：`EdaPage.tsx:473` 在执行成功后用 `applyEvidencePatch` 写 `schematicStatus/schematicExecutedAt/schematicExecutionId`，Runtime 不产出该状态；`/api/project-state` 载荷只含 projects/requirements/components/assets（`src/state/AppContext.tsx:355-364,410-420`），validations 只在 localStorage。换机/清缓存后证据丢失（P1-6）。
- `DeliverPage.tsx:22` 的 openFindings 未按 projectId 过滤（且 `:32` 页签角标仍用 `state.validations.length`，含 seed/demo，与注释“只统计官方”矛盾）（P2-2）。

## 3. 未解决 P0/P1 清单（按影响排序）

### P0（1 项）

**P0-1 “AI 页语义计划 → 原理图受控写入”仍不是一条链（N10 🟥）**
- 证据：AI 页计划只编译成 PCB 计划（`EdaPage.tsx:217-231` → PCB 高级面板）；原理图写入由另一条“AI 网表草案”链驱动（`EdaPage.tsx:395-430`），其计划来自 `runtime/netlist.mjs:6-47`，不产生/不接收 semantic/compiled 哈希；两链之间无 ID/哈希关联。
- 影响：用户从 AI 页“进入EDA编译与审批”后，被引导的是 PCB 计划，而页面上的“生成原理图”用的是另一条网表计划；原始 P0-1 想解决的“两条链互不相认”仍在（本次只修了血缘绑定）。产品文案（`AiTasksPage.tsx:227-232` 提示“可直接确认方案并准备执行”、`EdaPage.tsx:628` 面板名“项目网络表 → 原理图受控执行”）会让用户以为 AI 语义计划直接写原理图。
- 修法（二选一，需产品拍板）：① 增加“语义计划 → 原理图计划”编译分支，把 production 语义计划转成 reviewed-netlist（或复用同一 planHash 注册表），让原理图批准令牌绑定 AI 页 planHash；② 明确拆成两条产品线：AI 页只做 PCB，原理图网表链独立入口，删除/改写误导文案，并在交接处显式说明“不会写原理图”。
- 验收：从 AI 页生成语义计划 → EDA 页原理图批准返回 `semanticPlanHash === AI 页 planHash`，执行记录/账本/UI 三处一致；若走方案②，e2e 断言任一面板不展示另一链的哈希，文案与真实行为一致。

### P1（6 项）

**P1-1 官方 ERC/DRC 证据不绑定本次执行/planHash，执行成功不落官方记录**
- 证据：`src/types.ts:682-688`（evidence 无 executionId/planHash）；`ValidationPage.tsx:449-461,592-606`（字段只有 digest/path/jobId）；`EdaPage.tsx` 无 official 写入；`stageEvidence.ts:45-52` 只按项目+official 判定。
- 影响：无法回答“这次写入的网表/Drc 通过了没有”；阶段 drcPassed 依赖人工另跑；账本/执行记录与验证记录无法互证。
- 修法：`design.execute` 把官方 DRC 结果连同 `executionId/planHash/snapshot digest` 写入 Runtime 证据（或由 UI 在执行成功回调里带 executionId 落 official 记录）；同理 ERC 记录带 `planHash/executionId`。`drcPassed` 要求 executionId 与最近一次 completed 原理图执行匹配。
- 验收：执行成功后无需手工，验证页自动出现 official 记录且 `evidence.executionId` 等于 execution.id；伪造/过期 executionId 不计入 drcPassed。

**P1-2 血缘哈希服务端不可验证（客户端自报）+ 非法值静默丢弃**
- 证据：`server.mjs:3305-3308,3501-3506` 只归一化签发；`design.mjs:33-41` 非法→null；`design.test.mjs:122-125` 固定“非法不进入计划”。
- 影响：本地脚本可让账本记录“伪造来源”；空串/短 hash 使可追溯性静默降级且无告警。
- 修法：approve 时用 `semanticPlanHash` 反查 production store 并重算 compiledPlanHash（至少当该语义计划在运行期注册过时强制）；同时把非法血缘改为 400/响应 warnings，UI 显示“血缘缺失”。
- 验收：伪造 compiledPlanHash 的批准被 4xx 拒绝；非法 hash 请求返回明确错误/warning；账本不落半截血缘。

**P1-3 原理图执行 DRC 零容忍且不叫 ERC**
- 证据：`design.mjs:371-376`（`drc.length !== 0` 即失败并回滚）；对比 PCB 用 baseline/regression 判定（`pcb.mjs:493-500`）；面板仍叫“原理图 DRC（ERC等效）”（`EdaPage.tsx:628`）。
- 影响：真实板常带既有 warning，任何新计划都会因“非本次新增”的违规失败回滚；且该检查不是电气规则 ERC，用户会误以为已过 ERC。
- 修法：原理图执行也采用 baseline + 新增/加重判定，或按严重度分级（error 阻断、warning 需显式例外并记录）；面板改文案并给出 DRC/ERC 区别。
- 验收：带既有 warning 的板子执行无新增违规计划 → completed，证据记录 baseline 与本次新增数；有新 error 仍回滚。

**P1-4 PCB 同步旁路：expectations 可缺省，混合计划不做落板比对**
- 证据：`pcb.mjs:118-146`（可选）、`:472-484`（仅 sync-only+摘要不变才判空转）；`EdaPage.tsx:495-560` 高级流水线不加 expectations。
- 影响：手工/旧计划/混合操作路径仍可能出现 completed 而 PCB 未落件；UI 只提示不阻断。
- 修法：执行器增加独立硬校验——若计划含 `pcb.importChanges`，回读器件集必须覆盖原理图器件集（从上下文拿，而非只信 expectations）；无原理图上下文时拒绝 importChanges 计划。
- 验收：任意含 importChanges 的计划在 0 器件变化/缺件时返回 `PCB_SYNC_INCOMPLETE` 并回滚；测试覆盖混合操作。

**P1-5 批准/执行未绑定项目与 EDA 工程身份**
- 证据：`server.mjs:3257-3261`（open-current 空 uuid 取任意页）；`EdaPage.tsx:370-383`（只取窗口上下文）；approve/execute 传 `windowId/targetFingerprint`（`EdaPage.tsx:294,434,529`），无 projectId/工程 UUID；sync/verify 也不带项目（`server.mjs:3363-3374`）。
- 影响：只要窗口指纹一致，可把批准用于另一工程/另一块板；账本无法回答“写的是哪个项目”。
- 修法：批准/执行体加 `projectId+projectUuid+pcbUuid` 并绑定目标；服务端比对项目 workspace 注册表与当前 EDA 工程；open-current 显式传绑定页 uuid，空 uuid 拒绝或返回候选要求选择。
- 验收：切换工程后旧批准 409/400；账本 bindings 含 project/工程/PCB；空 uuid open-current 不再默认取任意页。

**P1-6 阶段证据/官方验证记录仍非 Runtime 权威持久化**
- 证据：`EdaPage.tsx:473`（前端写 `schematicStatus/ExecutedAt/ExecutionId`）；`AppContext.tsx:355-364`（project-state 载荷无 validations/证据）；`ValidationPage.tsx:306-325` 只 dispatch 本地。
- 影响：换机/清 localStorage 后 `schematicGenerated/drcPassed` 丢失，阶段回退或需重跑；多端不一致。
- 修法：官方 ERC/DRC 记录与阶段证据写入 Runtime 证据存储（`/api/project-state` 或独立 evidence API），加载时恢复；`deriveStageEvidence` 优先读 Runtime 证据（失败时回退本地并明示）。
- 验收：清 localStorage 后重新加载仍能还原阶段与 drcPassed；未运行官方 DRC 前保持 false。

### P2（不单列为修复项，但建议随 P1 一并处理）

1. 执行历史表不显示双哈希，仅 planHash + 详情原始 JSON（`EdaPage.tsx:642-660`）。
2. `DeliverPage.tsx:22` openFindings 未按 projectId 过滤；`:32` 角标用全部 validations，与“只统计官方”注释矛盾。
3. `TARGET_DRIFT` 发生在令牌 consume 之后（`design.mjs:287-289`、`pcb.mjs:378-381`）→ 400 且令牌已烧；语义上应属 409 冲突，并应在 consume 前校验。
4. 选型提案草稿把“批量元件计划哈希”直接当 `semanticPlanHash`（`EdaPage.tsx:390`），与 AI 页语义计划同名不同物；批准面板会出现语义混淆。
5. 无 e2e/HTTP 覆盖 UI 期望位号装配、确认框文案、写后复验与血缘展示：`plan-lineage-http.test.mjs` 仅覆盖 planHash 不一致（`:63-72,102-108`），`pcb.test.mjs` 只覆盖执行器（`:263-327`）。

## 4. 可执行验证记录

| # | 命令（均只读/隔离目录） | 结果 |
|---|---|---|
| 1 | `CIRCUITPILOT_STATE_DIR=$PWD/.tmp/audit-state CIRCUITPILOT_EVIDENCE_DIR=$PWD/.tmp/audit-evidence CIRCUITPILOT_AUTOMATION_DIR=$PWD/.tmp/audit-automation node --test runtime/__tests__/design.test.mjs runtime/__tests__/plan-lineage-http.test.mjs runtime/__tests__/pcb.test.mjs` | **25 passed / 0 failed**（2026-10-29 11:10）；含 P0-1 血缘/令牌/账本/409 两用例、P0-2 三用例 |
| 2 | `npx vitest run src/services/__tests__/stageEvidence.test.ts src/services/__tests__/validationEvidence.test.ts src/services/__tests__/stageMachine.test.ts` | **3 files / 27 tests passed**（11:11） |
| 3 | 只读检查测试账本（`/var/folders/.../cp-p01-state-*/approvals-ledger.json`） | `plan issued`/`plan mismatch` 条目 bindings 含 `semanticPlanHash`+`compiledPlanHash` → 双哈希确实经 HTTP 路径落盘 |
| 4 | 只读检查仓库账本/执行持久化 | `artifacts/state/approvals-ledger.json`：500 条，plan+lineage=0（最近 plan 相关为空；2026-10-28 仅 2 条 write）；`pcb-executions.json`：106 条全为 2026-10-20，lineage=0；`design-executions.json` 不存在 → **无修复后真实运行证据** |
| 5 | 静态检索 | `EdaPage.tsx` 无 official/SET_VALIDATIONS 写入；`netlist.mjs` 无血缘字段；`grep 血缘/semanticPlanHash e2e` 0 命中（无 UI e2e 覆盖） |

**未执行/不可验证（诚实标注）**
- 未连接嘉立创 EDA / Bridge，未启动或重启服务，未跑 Playwright/live e2e（按任务约束）；因此 N6/N8 的**真机**行为、`pcb.importChanges` 在 EDA 3.2.186 上是否仍空转、`document.source.read` 指纹稳定性均未复验。
- 未使用 git：无法与 10-26 版本 diff，故“旧计划哈希兼容”“normalize 其他逻辑未变”仅为静态推断。
- 未跑 `npm run typecheck`/全量 vitest/runtime：任务仅授权单文件 runtime 测试与只读静态检查，避免写构建产物；Lead 声称的 typecheck/serial 绿未在本报告采信。
- 仓库 `pcb-executions.json` 的 106 条 completed 无真实图元 ID（均为占位），不作为真机证据。

## 5. 结论

- **P0-1（声明范围）**：双哈希血缘已贯通“计划→令牌→账本→执行记录→批准 UI”，换计划 409 有 HTTP 测试；但血缘是客户端自报、非法值静默丢弃，且**原始 P0-1 的“AI 页计划→原理图写入”仍为断点**。
- **P0-2**：主同步路径已由执行器回读比对 + UI 双闸关闭“空转报成功”，缺件回滚有单测；高级/旧计划混合路径仍有旁路。
- **P0-3**：KPI/问题中心/阶段门禁已收口到项目域 official 结果，数据层闭环；但执行链不产官方记录、证据不绑 executionId、阶段证据仍前端写。
- **未解决 P0 = 1 项**（AI 页语义计划与原理图写入不是一条链）；P1 = 6 项（ERC/DRC 证据绑定、血缘服务端不可验证、原理图 DRC 零容忍、PCB 同步旁路、项目/工程绑定、证据持久化）。
- 复审定性：**修复方向正确、主路径可用，但“AI 设计 → 原理图受控写入”作为一条端到端链仍未成立**；下一轮应先补 N10 的链路抉择（合并或显式拆分），再补 P1-1 的执行-验证绑定。
