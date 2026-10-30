# 01 · AI 设计 → 原理图链路

审计日期：2026-10-26（本机）。范围：需求对话 → 需求约束 → 选型 → 原理图计划 → 人工批准（令牌绑定 planHash）→ 受控写入嘉立创EDA → 保存/回读/ERC → 交接 PCB。方法：只读代码 + 本轮单文件单测（不改源码），历史真机证据逐条标注日期；本轮嘉立创EDA/Bridge 未运行（2026-10-26 18:50 检查 4178 与 49620–49629 无监听、无 EasyEDA 进程），**本轮没有任何真机复验**。判定口径：✅ 实现+测试或证据；🟨 实现但接不到下一步/证据链不闭合；🟥 无入口、后端缺失或可假成功；⬜ 只有文案/字段；🚫 明确产品边界。

## 0. 结论

1. **P0｜"AI 任务页 → 原理图受控写入"实际是两条互不相通的链**：AI 任务页的语义计划交给 EDA 页后只进入 PCB 编译管线（`AiTasksPage.tsx:225-231` → `EdaPage.tsx:141-150,215-229`），而真正写原理图的是 EDA 页自己的「1. AI生成网络表草案 → 3/4/5」（`EdaPage.tsx:340-374`）。两份计划是不同 schema、不同 planHash（`draftStore.ts:63-66` 注释即承认"两者结构、校验器、审批链不同"）；PCB 批准令牌只绑定 PCB 计划哈希，账本也不含语义计划哈希（`runtime/pcb.mjs:112` 重建计划时丢弃 `semanticPlanHash`；`runtime/design.mjs:87-92` 仅记 planHash/targetFingerprint/windowId/steps）。⇒ 跨页"同一 planHash"不成立，判 🟥（衔接处断）。
2. **P0｜"原理图 → PCB"同步可假成功**：UI 的「3. 同步原理图到PCB」只下发 `pcb.importChanges + pcb.save + pcb.drc`（`EdaPage.tsx:242`），而真机 `pcb.importChanges` 返回 `true` 却 0 器件（`runtime/bridge.mjs:472-477` 注释；`artifacts/wardrobe-case/pm-run-20261022/evidence/led-board-import-changes-r32.json`，2026-10-22：`compsAfterImport: 0`，需 CDP 点原生"应用修改"才落 19 件）；PCB 执行器的回读只记录计数，不比对原理图器件/位号（`runtime/pcb.mjs:414,432-438`）。⇒ 可能 `completed` 但 PCB 未变，判 🟥。
3. **P1｜ERC 证据与本次执行解绑，且放行语义不同**：EdaPage 用 `schematic.drc` 并以 `findings.length === 0` 放行（`EdaPage.tsx:573`；`runtime/design.mjs:325-333`；同一命令也是验证页 ERC 引擎 `runtime/server.mjs:2693`），验证页 ERC 则把 error/warning 分级并落盘取证（`ValidationPage.tsx:522-546`）；原理图验收 `body` 为空、证据只按 window/project/document 指纹落盘（`ValidationPage.tsx:665`；`runtime/server.mjs:2961-3000`），没有 planHash/executionId。⇒ 执行链既拿不出"这次写入的网表"的 ERC 明细证据，还会把 warning 当阻断（真机该板 32 warnings，见 D3）。
4. **P1｜阶段证据 `netlistApproved` 没有生产者**：EdaPage 执行成功只回写 `schematicStatus/schematicExecutedAt/schematicExecutionId`（`EdaPage.tsx:418`）；全仓没有代码写 `netlistExecutionId/netlistExecutedAt`（`types.ts:56-57` 仅类型）或把 `state.task.status` 置 `approved`，故 `stageEvidence.ts:33-37` 恒 false，`stageMachine.ts:91` 的「原理图->PCB」恒被阻断，`ProjectsPage.tsx:100-116` 的手动推进也恒失败。
5. **P1｜需求硬约束与写入目标都没有进入运行时闸门**：`constraints.mjs` 只被 `release-gate.mjs:16,501` 使用，`design.approve/execute` 不看需求（`runtime/design.mjs:224-247`）；AI 计划上下文传入全部需求（含 suggested/conflict，`AiTasksPage.tsx:105`；`runtime/chat.mjs:229-237`），仅靠提示词"只能用已确认需求"，无确定性过滤。同时无 workspace 时「打开关联原理图」回退到工程第一张图（`runtimeClient.ts:399-405`；`runtime/server.mjs:3110-3119`），批准框只显示 windowId+fingerprint（`EdaPage.tsx:573`），没有项目名/页 UUID 对照。UI 文案"硬约束违反时阻断执行"（`RequirementsPage.tsx:35`）与实现不符（fail-open）。
6. **P2｜受控写入证据链与操作生命周期仍有缺口**：回读只验"新建图元 ID 存在 + 导线网名/几何"（`runtime/design.mjs:303-323`），不验器件库身份/位号/值/网表归属；从零设计无引脚证据时仍会继续生成网表（`EdaPage.tsx:347-365`，assumption 只展示原始 JSON）；「停止等待」≠停止服务端写入（`EdaPage.tsx:414-425` 自行提示"服务端可能仍在执行"）；快速通道还用 `plan.ready` 冒充"已批准"（`EdaPage.tsx:255`，对比严格五步 `EdaPage.tsx:122-123`）。

## 1. 链路现状表

| 环节 | 用户动作 | UI/代码位置 | 后端路由/模块 | 判定 | 证据 |
|---|---|---|---|---|---|
| 需求对话 | 发送/重试消息 | `AiTasksPage.tsx:239-289` | `POST /api/chat/sessions/:id/messages`；`runtime/chat.mjs:571-637` | ✅ | `artifacts/state/chat-transcripts.json`（2026-10-21）；e2e 走 mock |
| 新建会话 | 新建对话 | `AiTasksPage.tsx:324-330` | `DELETE /api/chat/sessions/:id`；`chat.mjs:717` | ✅ | 代码路径完整；无专门单测/e2e（待确认） |
| AI 需求建议 | 接受/拒绝 | `AiTasksPage.tsx:292-301` | 无后端：`ADD/UPDATE_REQUIREMENT` + `DECIDE_CHAT_SUGGESTION` | 🟨 | 仅本地 reducer；靠 `/api/project-state` 间接持久化（`AppContext.tsx:384-407`） |
| 需求约束 | 新增/编辑/确认 | `RequirementsPage.tsx:29,39,42` | 无后端 | 🟨 | 同上；`ai` 页建议接受后仍为 `suggested`，须再点确认 |
| 修复任务回填 | 验证页「创建AI修复任务」后到 AI 页 | `fixTask.ts:11-41`；`ValidationPage.tsx:583`；`VersionsPage.tsx:199`；`AiTasksPage.tsx:84-88` | 无后端（`SET_TASK` dispatch） | ✅ | `fixTask.test.ts`；e2e `app.spec.ts:641`（同一目标跨页可见） |
| 选型检索/报价 | 检索、勾选、落计划 | `PartProposalPage.tsx:66-103` | `/api/library/proposals`、`/plan`、`/api/eda/schematic/component-batch(dryRun)` | ✅ | 真库检索工件 `artifacts/wardrobe-case/ai-conversations/library-proposals-20261021.json`（2026-10-21）；dry-run `artifacts/a6-batch/real-batch-dryrun-20261020.json`（真机 2026-10-20） |
| 选型→设计批准 | 「送到设计批准（EDA 页）」 | `PartProposalPage.tsx:110-121` → `EdaPage.tsx:158-167` | 无后端（sessionStorage 草稿） | ✅ | `draftStore.test.ts` 本轮 4/4；e2e `app.spec.ts:652`；哈希不一致有显式告警 `EdaPage.tsx:335` |
| 批量落件（写板） | 「签发写板批准并执行」 | `PartProposalPage.tsx:151-175` | `/api/automation/approvals` + `/api/eda/schematic/component-batch`（`server.mjs:2106-2160`） | 🟨 | 真机 dry-run + 无批准 409 fail-closed（2026-10-20，`artifacts/a6-batch/README.md`）；2026-10-22 真机批量写入尝试均 `BRIDGE_TIMEOUT` 失败（`artifacts/wardrobe-case/pm-run-20261022/evidence/batch-write*.json`）；无源码快照/回滚 |
| AI 生产计划 | 「生成可验证计划」 | `AiTasksPage.tsx:191-219` | `/api/production/plans/ai`；`chat.mjs:670-691` | 🟨 | 真实路由；仓库无 ready 计划真机产物，2026-10-16 三次真机均 blocked/留空（`wardrobe-assistant-design-verification.md` §八.5）；无 e2e |
| AI→EDA 交接 | 「进入EDA编译与审批」 | `AiTasksPage.tsx:225-231` → `EdaPage.tsx:141-150,215-229` | `/api/production/plans/compile` → `/api/pcb/plan/ai`（`server.mjs:3598-3606`） | 🟥 | 到达 PCB 管线，**不进原理图审批/写入**；跨页 planHash 不互通，见结论 1 |
| 新建/绑定 EDA 文件 | 「新建EDA文件」「绑定当前EDA设计」 | `EdaPage.tsx:174-199,542,555` | `POST /api/eda/workspaces`、`GET /api/eda/workspaces/current`（`runtimeClient.ts:455-464`） | ✅ | 代码路径；无真机复验；绑定会把 `schematicStatus` 置 `empty`（`EdaPage.tsx:190-199`），不探测原理图实际内容 |
| AI 生成网络表 | 「1. AI生成网络表草案」 | `EdaPage.tsx:340-374` | `POST /api/design/netlist/ai`；`server.mjs:3129-3155` | ✅ | 2026-10-22 真机 `ai-netlist-response-r25/26/27-deepseek.json`（status=ready；Codex 变体 TIMEOUT）；2026-10-25 网表一致性 PASS（历史） |
| 打开原理图/读上下文 | 「2. 打开关联原理图」「读取当前原理图」 | `EdaPage.tsx:315-331` | `/api/eda/schematic/open-current`、`/api/design/context` | ✅ | 代码路径；无真机复验（R3 工件是 net-connect 通道，不覆盖本动作）；无项目绑定校验（见结论 5） |
| 校验计划 | 「3. 校验计划」 | `EdaPage.tsx:333-338` | `POST /api/design/plan`；`design.mjs:25-63` | ✅ | 确定性哈希/非法操作阻断：`runtime/__tests__/design.test.mjs` 本轮 6/6（2026-10-26） |
| 人工批准 | 「4. 人工批准」 | `EdaPage.tsx:376-382` | `POST /api/design/approve`；`design.mjs:224-228`；`approval-service.mjs` | ✅ | 绑定/过期/不可重放：`design.test.mjs` 2026-10-26；账本 500 条含 issued/consumed/replayed：`artifacts/state/approvals-ledger.json`（2026-10-20） |
| 受控写入 | 「5. 生成原理图」 | `EdaPage.tsx:411-426` | `POST /api/design/execute`；`design.mjs:239-350` | 🟨 | 后端闭环有单测（2026-10-26 6/6）；UI 路径无落盘执行记录（`artifacts/state/` 无 `design-executions.json`）；真机仅 2026-10-16 小批（`wardrobe-assistant-design-verification.md` §32） |
| 保存/回读/DRC | 执行内自动 | `design.mjs:303-333` | bridge `schematic.save/wire.read/wires/schematic.drc` | ✅ | 单测覆盖 save、回读缺图元、DRC 失败回滚（2026-10-26）；历史真机 2026-10-16 回滚摘要校验通过 |
| ERC | 验证页单独执行 | `ValidationPage.tsx:522-546` | `POST /api/eda/schematic/erc/run`；`server.mjs:2684-2715` | 🟨 | ERC 真实可用，但与本次 planHash/executionId 无绑定（结论 3） |
| 交接 PCB | 「3. 同步原理图到PCB」 | `EdaPage.tsx:231-269` | `/api/pcb/*`；`pcb.mjs:333-458` | 🟥 | `importChanges` 真机空转 2026-10-22；回读只记计数（结论 2） |
| 执行历史 | 列表/查看事件 | `EdaPage.tsx:384-409` | `/api/design/executions`、`/:id`；`server.mjs:3176-3192` | ✅ | 前后端齐备；仓库状态目录无 design 记录；`pcb-executions.json`（2026-10-20）来源待确认（见 §4） |
| 资料上传/导出 | 上传资料、导出 BOM | `AssetsPage.tsx:35-42` | 无后端（Demo） | ⬜/🚫 | 假 `sha256: demo-*`、DEMO ONLY CSV，均在 UI 明示；不计入链路 |
| 生产资料检查 | 校验真实产物包 | `AssetsPage.tsx:60-73` | `/api/production/artifacts/inspect`、`/api/production/readiness` | 🟨 | 用 `state.task.planHash/id` 作语义计划/执行绑定，而 EdaPage 执行不回写这两个字段 → 下游绑定不成立（交付链另审） |

## 2. 断点/半打通明细

### D1（P0）AI 页的 planHash 不进入原理图批准链

- **用户视角**：在 AI 任务页生成计划、点「进入EDA编译与审批」，以为批准的就是这份 AI 计划；实际 EDA 页批准/写入的是编译后的 PCB 计划，账本里查不到 AI 页那份哈希。
- **证据**：`AiTasksPage.tsx:225-231`（只存草稿）；`EdaPage.tsx:141-150`（载入候选，未做服务端校验）；`EdaPage.tsx:215-229`（编译为 PCB 计划）；`runtime/pcb.mjs:112`（重建计划丢弃 `semanticPlanHash`）；`runtime/design.mjs:87-92`（账本只记 planHash/fingerprint/windowId/steps）；`draftStore.ts:63-66`（注释承认两条审批链不同）。
- **影响**：跨页"同一 planHash"不可证明；审计只看到 PCB 哈希；AI 方案被替换为编译产物时用户无感知。
- **建议修复**：编译产物保留 `semanticPlanHash`，批准/执行/账本同时记录语义哈希与编译哈希；或明确把 UI 改为两条链并去掉"同一 planHash"话术。
- **验收方式**：e2e：AI 页交接后 EDA 页批准的 plan 内 `semanticPlanHash` 与 AI 页一致；账本条目含双哈希且可反查；单测覆盖 `normalizePcbPlan` 保留字段。

### D2（P0）原理图 → PCB 同步"假成功"

- **用户视角**：原理图写入成功后点「3. 同步原理图到PCB」，界面提示写入/保存/回读/DRC 全部完成，但 PCB 仍是空的。
- **证据**：`EdaPage.tsx:242`（同步计划仅 importChanges/save/drc）；`runtime/bridge.mjs:472-477`（注释：真机返回 true 却 0 器件）；`artifacts/wardrobe-case/pm-run-20261022/evidence/led-board-import-changes-r32.json`（2026-10-22：`importOk: true, compsAfterImport: 0`，人工点原生确认后 19 件）；`runtime/pcb.mjs:414`（readback 仅记计数）、`pcb.mjs:432-438`（DRC 通过即 completed，不校验期望器件数）。
- **影响**：空 PCB 被当作"已交接"；后续 DRC/DFM/交付建立在空板上；阶段证据 `pcbPlaced` 也会失真。
- **建议修复**：同步计划带上原理图期望位号集合，执行后用现有 `diffPcbAgainstNetlist`（`pcb.mjs:86-104`）做一致性判定，不一致→`blocked/rolled_back`；或走 GUI 原生"应用修改"并读回验收。
- **验收方式**：真机空 PCB + 原理图 N 器件 → 同步必须 `completed && componentCount >= N`，否则失败且回滚；单测加 readback 数量不匹配用例。

### D3（P1）ERC/验收证据与受控写入解绑

- **用户视角**：看到「原理图 DRC（ERC等效）」通过，就认为 ERC 通过；换到验证页再跑 ERC/验收时，产物与本链执行无关联。
- **证据**：`EdaPage.tsx:573`（标签"ERC等效"）；`runtime/design.mjs:325-333`（只跑 `schematic.drc` 且要求零 findings）；`runtime/server.mjs:2693`（验证页 ERC 复用同一命令并做明细归一化）；`ValidationPage.tsx:522-546`（ERC 分级取证另跑）；`ValidationPage.tsx:665`（验收 body 为空，`runtime/schematic-acceptance.mjs:57` 起支持传 plan 做网表比对却没用上）；`runtime/server.mjs:2961-3000`（验收证据指纹仅 window/project/document）。
- **影响**："保存/回读/ERC"里 ERC 这一环无法归属到某次 planHash/executionId；且 DRC 零 findings 会把 warning 也当阻断，真机该板 32 warnings（`ai-design-completion-r25.json`）若同样返回，写入会"写完即回滚"（待复验）。
- **建议修复**：执行结束后同一目标跑验收并写 `executionId+planHash` 绑定；UI 区分 DRC 与 ERC 文案；DRC 放行按 error 分级（warning 展示不阻断，或显式策略）。
- **验收方式**：验收/ERC 证据含 executionId+planHash 并可反查；单测覆盖 warning-only DRC 的策略分支。

### D4（P1）`netlistApproved` 无生产者 → 阶段恒不推进

- **用户视角**：原理图写入成功、审计显示"证据已记录"，但点「推进阶段」仍被"网表未批准"阻断，项目永远停在需求/选型。
- **证据**：`EdaPage.tsx:418`（只写 schematicStatus/schematicExecutedAt/schematicExecutionId）；`src/services/stageEvidence.ts:33-37`；`src/services/stageMachine.ts:91`；`src/pages/ProjectsPage.tsx:100-116`；`src/types.ts:56-57`（字段只有类型定义，全仓无写入）。
- **影响**：8 阶段机的核心门禁永远过不去；下游 PCB/验证阶段无法以产品内流程推进。另注意 `schematicGenerated` 是 UI 在 `EdaPage.tsx:418` 自写的标志（`stageEvidence.ts:39` 直接信任），`EdaPage.tsx:555` 又据此放行「同步到PCB」，并非 Runtime 回读证明——UI 一旦误写，同步闸门即被绕过。
- **建议修复**：设计批准成功时写 `state.task={status:'approved',planHash}`；或在 design.execute 成功回写 `netlistExecutionId=value.id/netlistExecutedAt`；或删除该证据改用 `schematicGenerated`。
- **验收方式**：单测用真实 reducer 路径产生证据；e2e 完成原理图写入后（需求/BOM 齐备）点「推进阶段」成功到 PCB。

### D5（P1）需求硬约束与写入目标未进入运行时闸门

- **用户视角**：硬约束标了"违反时阻断执行"，但改需求/换一张原理图后仍可批准并写入。
- **证据**：`runtime/release-gate.mjs:16,501`（约束只在发布闸门）；`runtime/design.mjs:224-247`（approve/execute 不读 requirements）；`AiTasksPage.tsx:105` + `runtime/chat.mjs:229-237`（全部需求进上下文）；`EdaPage.tsx:315-331`（目标=当前活动文档）；`runtimeClient.ts:399-405` + `server.mjs:3110-3119`（无 uuid 时回退第一张图）；`EdaPage.tsx:573`（批准框只看 windowId/fingerprint）。
- **影响**：fail-open：违反硬约束或写错项目/页的风险只能靠人眼看窗口；本轮无法真机验证是否已实际发生。
- **建议修复**：`design.approve/execute` 增加 projectId+schematicPageUuid 绑定并与活动文档比对；把 confirmed 硬约束送 `checkConstraints` 做写前门禁。
- **验收方式**：篡改需求/切换项目原理图后批准或执行返回 409；单测覆盖双绑定。

### D6（P2）写入身份/网表回读不足 + 从零设计证据 fail-open

- **用户视角**：写入结果"全绿"，但器件可能绑错库/位号，或网络来自 AI 推断而未被逐条确认。
- **证据**：`runtime/design.mjs:303-323`（只验 primitiveId/导线网名几何，不验 libraryUuid/refdes/value，也不导出网表比对端子）；`EdaPage.tsx:347-365`（无 pinEvidence 时 `requirePinEvidence=false` 继续生成）；assumption 仅在网表 JSON 展示（`EdaPage.tsx:573` 面板）。
- **影响**：读回证据不足以证明"写进去的设计=批准的网表"；从零设计存在 AI 猜网络的窗口（有提示但非阻断）。
- **建议修复**：执行后 `schematic.netlist.export` 与 plan ops 对比；`component.create` 回读库身份/位号；无 pinEvidence 时要求勾选"接受 assumption 清单"。
- **验收方式**：单测/dry-run：故意绑错器件或改网名必须回读失败。

### D7（P2）操作生命周期与快速通道语义

- **用户视角**：长写入点「停止等待」后以为已停止；快速通道点"执行"时批准令牌由 UI 自动签发，与严格五步的"人工批准"不是同一语义。
- **证据**：`EdaPage.tsx:414-425`（160s 超时后提示服务端可能仍在执行）；`EdaPage.tsx:255`（`planApproved` 用 `pcbPlanning.ready && pcbContext.complete` 代替真实批准）；`EdaPage.tsx:259-261`（确认后立即 approvePcb+executePcb）；严格门禁见 `src/state/taskMachine.ts:33-40`。
- **影响**：服务端可能继续写入而 UI 已放弃等待（有审计可查，但用户认知不一致）；快速通道的"人工批准"被弱化为一次确认框。
- **建议修复**：执行提供取消/查询接口；快速通道在确认框中展示"将签发一次性写板批准"并记录批准 id；停止等待后轮询执行状态。
- **验收方式**：模拟超时后服务端仍完成 → UI 能通过执行历史看到并提示；审计含批准 id。

### D8（P2）选型批量落件无快照/回滚

- **用户视角**：「签发写板批准并执行」可以真写，但中途失败会留下部分器件。
- **证据**：`PartProposalPage.tsx:151-175`（UI 自签批准+执行同一动作）；`runtime/server.mjs:2106-2160`（逐件落、每件原子、失败即停、可续跑；无 source 快照/回滚）；`artifacts/a6-batch/README.md`（2026-10-20 真机 dry-run + 无批准 409）；`artifacts/wardrobe-case/pm-run-20261022/evidence/batch-write*.json`（2026-10-22 真机写入尝试均 `BRIDGE_TIMEOUT`，未证明成功）。
- **影响**：部分写入后需人工清理；与主链"快照→失败回滚"的安全级别不一致。
- **建议修复**：写前 `document.source.read` 快照，失败自动 restore+校验；或明确产品边界为"可续跑、不承诺原子"。
- **验收方式**：人为让第 2 件失败，验证自动回滚或产品文案明确不原子。

## 3. 已确认打通（附证据）

1. **选型 → 原理图计划交接**：`PartProposalPage.tsx:110-121` 存草稿，`EdaPage.tsx:158-167` 载入并在校验时对哈希不一致显式告警（`EdaPage.tsx:335`）。证据：`src/services/draftStore.test.ts` 本轮 4/4（2026-10-26）；e2e `e2e/app.spec.ts:652`（2026-10-20）。
2. **原理图计划的确定性与一次性批准**：`normalizePlan` 稳定哈希/非法操作阻断（`runtime/design.mjs:25-63`）；令牌绑定 planHash+fingerprint+windowId、过期/不可重放（`design.mjs:96-116`；账本 `approval-ledger.mjs` 只追加哈希链、记 scope/action/bindings；自动化写板批准另走 `approval-service.mjs`）。证据：`runtime/__tests__/design.test.mjs` 本轮 6/6（2026-10-26）；账本含 issued/consumed/replayed/mismatch 历史（`artifacts/state/approvals-ledger.json`，2026-10-20）。
3. **受控写入的失败安全闭环**：快照 → 写入 → save → 回读（图元存在/导线网名几何）→ 官方 `schematic.drc` → 失败 `document.source.restore` + 摘要校验（`runtime/design.mjs:254-350`）。证据：单测覆盖 DRC 失败回滚并恢复源码（2026-10-26 6/6）；历史真机 2026-10-16 三次 `design.execute` 失败后 `sourceDigest` 原样还原（`docs/implementation/wardrobe-assistant-design-verification.md` §32.3）。
4. **真实原理图写入能力（接口/脚本层，非本 UI 链）**：2026-10-22 真机 80 条 `net.connect` 写入并读回，引脚有网络 95→175、ERC 0 error/32 warning（`artifacts/wardrobe-case/pm-run-20261022/evidence/ai-design-completion-r25.json`）；2026-10-25 两板网表逐位号/逐引脚一致性 PASS（`netlist-consistency-r54.json`）。注意：走 `/api/eda/schematic/net-connect`，**不是** UI 的 `/api/design/execute`，不能替后者背书。
5. **AI 网络表的引脚证据前置门禁**：`/api/design/netlist/ai` 对传入 pinEvidence 做 fail-closed 审计（`runtime/server.mjs:3129-3148`；`runtime/pin-evidence.mjs`；`runtime/netlist.mjs:6-47` 做 refs/引脚校验并确定性编译 `component.create`/`net.connect`），真机证据 `artifacts/a4-pins/real-machine-pin-evidence-20261019T122510Z.json`（2026-10-19）。
6. **阶段机 fail-closed**：8 阶段相邻推进、证据缺失即阻断（`src/services/stageMachine.ts:87-101`）；单测 `src/services/__tests__/stageEvidence.test.ts` 本轮 5/5（2026-10-26）；`ProjectsPage.tsx:100-116` 只提示不强行 dispatch。**但** `netlistApproved` 生产者缺失（见 D4）。
7. **执行历史查询链路**：`EdaPage.tsx:384-409` 读 `/api/design/executions` 与 `/api/pcb/executions`，详情按 id 再取（`server.mjs:3176-3192`）；持久化失败如实显示 `persistenceError`（`runtime/design.mjs:180-199` 构造/持久化）。
8. **页面组装与路由**：`App.tsx:81-82`（design/eda）；`DesignPage.tsx:9-14,41-44` 四页签；`ExecutionPage.tsx` 组合 `EdaPage`，五步按钮与文案见 `EdaPage.tsx:573`。

## 4. 本轮未复验/限制

- **无真机**：2026-10-26 18:50 检查 4178、49620–49629 均无监听、无 EasyEDA 进程；所有"真机"结论均引用 2026-10-16/19/20/22/25 的历史工件或文档，本轮未复验。
- **无 UI 原理图执行落盘证据**：`artifacts/state/` 无 `design-executions.json`（配置见 `runtime/server.mjs:456-463`），因此无法证明 UI 的 `/api/design/execute` 曾真机成功。
- **`pcb-executions.json` 来源待确认**：2026-10-20 落盘的 106 条 `completed` 记录中 `componentCount` 全为 0，且 2544 个 primitiveId 全部形如 `pcb.line.create-1` 的占位值；判定为测试/桩写入状态目录，**不作为真机证据**。
- **A7/R3 工件不覆盖本链**：`artifacts/a7-r3/2026-10-19T09-51-44-141Z/` 是 `/api/eda/schematic/net-connect` 脚本通道的写入/清理/回滚，不是 UI 的 `design.execute`，不能作为本链真机证据。
- **单测不是真机**：`runtime/__tests__/design.test.mjs` 使用内存 mock bridge（`project.current` 等固定桩），证明逻辑边界，不证明 EDA 行为；`e2e/app.spec.ts:208-233` 全部 mock API，只验证按钮启停，未执行 `executeDesign`，也未覆盖 AI 页→EDA 语义草稿交接。
- **本轮运行的单文件只读测试**：`stageEvidence.test.ts` 5/5、`draftStore.test.ts` 4/4、`runtime/__tests__/design.test.mjs` 6/6（2026-10-26）；未运行 `npm test`、`npm run test:runtime` 或 Playwright。
- **判定不覆盖**：PCB 链、交付/发布链、平台/自动化链、UI 装配另见 02–05 审计；本文件只到"交接 PCB"为止。
- **证据日期口径**：仓库工作树含 10-21 之后未提交改动，故引用文件内容与 mtime（如 `EdaPage.tsx` 2026-10-20 17:41、`runtime/chat.mjs` 2026-10-22 11:19、`runtime/server.mjs` 2026-10-25 16:28），不引用 git 提交时间。
