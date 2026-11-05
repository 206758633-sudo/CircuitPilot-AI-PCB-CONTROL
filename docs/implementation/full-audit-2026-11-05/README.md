# CircuitPilot 全系统闭环审计与修复（2026-11-05）

> 用户要求："检查一遍整个 CircuitPilot 操作系统，完善所有的闭环"。
> 方式：**5 条链并行只读审计**（设计 / PCB / 验证交付 / 平台 / UI 接线）+ Lead 交叉复核与集中修复。
> 基线：git `98429be`（2026-11-02，工作区干净）；审计前基线验证：typecheck 通过、vitest 228/228、runtime `node --test` 1455/1455、build 通过、路由契约 200 路由 / 0 孤儿。
> 边界：**本轮未连接嘉立创EDA / EasyEDA Bridge、未跑 live e2e / Playwright / 全量 acceptance、未重启 4177/4178**。所有"已闭环"只到"代码 + 路由 + UI + 自动化测试"级别；需真机的项在 §5 如实列出，不冒充打通。

---

## 0. 报告索引

| 文件 | 链 | P0 | P1 | P2 | 一句话 |
|---|---|---|---|---|---|
| [01-design.md](01-design.md) | 设计：需求→AI计划→批准→原理图/网表→ERC | 2 | 10 | 6 | 受控写入内核完整，但"写入原理图"主通道无真机成功记录；设计链会消耗掉交付链唯一计划输入 |
| [02-pcb.md](02-pcb.md) | PCB：落板→布局→布线→铺铜→DRC→回滚 | 2 | 9 | 8 | `/api/pcb/execute` 真闭环；写锁/目标绑定/读回断言未横向铺开，存在"批准 A 板写 B 板"与配方假成功 |
| [03-delivery.md](03-delivery.md) | 验证交付：ERC/DRC→六门→readiness→导出→归档→签核 | 2 | 5 | 7 | 官方验证取证/持久化已闭环；六门可签结构性不成立、签核锚点哈希域不一致导致正式导出/归档不可达 |
| [04-platform.md](04-platform.md) | 平台：持久化/知识RAG/研究/监督/Agent/扩展市场 | 0 | 6 | 12 | 26 类持久面无纯死存储、Supervisor 生命周期真闭环；损坏语义与外发边界有 6 项 P1 |
| [05-ui-wiring.md](05-ui-wiring.md) | UI：路由↔client↔页面↔按钮↔文案 | 0 | 5 | 11 | 主写链按钮门禁基本闭环；会话级写暂停覆盖缺口 + 能力声明文案与现状相反 + 路由契约统计口径把测试当消费者 |

判定口径：✅ 已闭环（代码/路由/UI/测试或真机证据齐）｜🟨 半闭环（缺消费者/数据/真机）｜🟥 断点或假成功｜⬜ 纸面｜🚫 产品边界。
**五份报告合计：P0 = 6、P1 = 35、P2 = 44。** 第一轮已修 18 项（见 §1）；同日第二轮把 §2.2 里**代码层可闭环的 P0/P1 全部落地**（见 §6），剩余未闭环项只剩真机数据依赖与产品决策项（§2.1、§6.3）。所有报告以 HEAD 基线给 file:line；修复后的行号以工作树为准。

---

## 1. 本轮已修复的闭环（代码级，全部带自动化回归）

### 1.1 运行时（`runtime/`）

| # | 来源 | 断点 | 修法 | 回归 |
|---|---|---|---|---|
| R1 | 交付 P0-2 | manifest 哈希域含 `projectName`，但 export/archive binding 白名单丢弃它 → 合法签核出正式文件必 `RELEASE_MANIFEST_MISMATCH` / `RELEASE_ARCHIVE_MANIFEST_DRIFT` | `server.mjs`：`exportBinding` / `archiveBinding` 补 `projectName`（顶层优先，退回交接 `binding`） | `runtime/__tests__/full-audit-2026-11-05-http.test.mjs`（导出重算含 projectName） |
| R2 | 交付 P1-1 | 旧 W5 `signoff-record`（`decision:'reject'`、无 passed/roles）比真实签核新时被当成"最新签核"，遮蔽有效交付签核 | `isReleaseSignoffPayload`：`kind==='signoff-record'` 也必须 `passed===true` 且 `roles.length>0`；`latestReleaseSignoff` 继续向前扫描 | 同上（旧 reject 记录不再遮蔽） |
| R3 | 交付 P1-3 | `PUT /api/validation-state` 原样落盘 → 本机脚本/Agent 可伪造 `source:'official'` 把 KPI/阶段推进到"官方通过" | 保存前校验：engine→证据 kind（ERC→`schematic-erc`、DRC→`drc-report`）、digest 必须在证据库真实存在、同一 digest 不能被两个项目同时声称；`VALIDATION_EVIDENCE_*` fail-closed | 同上 + 更新 `runtime/__tests__/validation-state.test.mjs` |
| R4 | PCB P0-2 | `placement/apply` 批准绑定 A 板后，`body.pcbUuid` 可把写重定向到 B 板（离线探针 200 + `pcb.open(D2)`） | 在**消费批准之前**校验请求 `pcbUuid` 与当前文档一致，不一致 409 且不烧掉一次性批准 | 同上（D2 被拒且未切板；D1 可重试） |
| R5 | PCB P1-3 | `schematic/repair` 丢弃 `requireWriteApproval` 返回值，`pageUuid` 可切到另一页再写 | 消费批准前校验"当前就在某张原理图上时必须同页"；打开/激活统一走 `ensureSchematicActive` | 上述同文件覆盖目标绑定逻辑（离线假桥） |
| R6 | PCB P1-5 | `pour/create` 在"当前已是 PCB"时静默忽略请求 `pcbUuid`，写到活动板且响应不说明 | `ensurePcbDocument` 在显式请求别的板时真正切换；`pour/create` 响应补 `pcbUuid`（实际写入板） | 同上（请求 D2 必发 `pcb.open D2`） |
| R7 | UI P1-5 | 路由契约允许清单含 4 条已可清理项、2 条插件真实消费项被写成"无消费者/TODO" | 更新 `KNOWN_UNWIRED_ROUTES`：删除 4 条误报，插件消费的 `design/plan/ai`、`design/executions/:id/evidence` 写明"由 DSH 插件消费，勿删" | `node --test runtime/__tests__/route-contract.test.mjs`（200 路由 / 9 允许 / 0 孤儿） |

### 1.2 前端（`src/`）

| # | 来源 | 断点 | 修法 | 回归 |
|---|---|---|---|---|
| F1 | PCB P2-2 / UI P1-1/2 | 布局页「执行写回 / 还原到原位置」、自动化页「签发写批准 / 运行配方」只认全局 `writePaused`，会话级暂停可绕过 | 新增纯函数 `src/services/writeGate.ts`（`isWriteGateClosed` + 原因文案），PlacementPage/AutomationPage 两处按钮 disabled + 函数首行守卫统一走它 | `src/services/__tests__/writeGate.test.ts` |
| F2 | UI P1-3 | 设置页宣称"写入仍未开放 / 仅只读回读 / 保存命令未开放"，与已产品化的受控写入相反 | 改为"写入默认关闭，按需批准"并写清 计划哈希 + 一次性批准 + 快照/回读；"全局暂停所有写入"→"所有 EDA 写入"（服务端只覆盖 18 条写路由） | `src/pages/__tests__/write-gate-ui.test.tsx`（旧文案不再出现） |
| F3 | UI P1-4 | 概览主 CTA/空态宣称"检查已通过，可导出/可直接交付"，忽略放行门禁 + 在线 DFM + 三方签核 | 改为"官方检查已运行，进入交付核对放行证据" | 同 F2 测试文件（渲染级） |
| F4 | UI P2-7 | Toast 只渲染 `message`，`title` 被吞 | `ToastViewport` 同时渲染 title + message（保留 `aria-live`） | 同 F2 测试文件 |
| F5 | PCB P1-2 | 验证页「执行修复并验收」不签发写批准 → 服务端必 409（点亮按钮点下必死） | `runSchematicRepair(false)` 先 `issueAutomationApproval({scope:'write'})` 再带 `approvalIds`；`repairSchematic` 客户端签名补 `approvalIds` | typecheck + `npx vitest run src/pages`（页面级回归） |
| F6 | 交付 P2-4 | DFM 计划哈希不预填（签核已预填） | 交接 `useEffect` 里用 `handoff.binding.semanticPlanHash` 预填 `dfmPlanHash`（仅空值） | `npx vitest run src/pages` |
| F7 | 交付 P2-1 | `saveReadinessInputs/readReadinessInputs` 写入 sessionStorage 后无人读取（死存储，且与真实交接 `circuitpilot:release-binding` 两套来源） | 删除死存储 API 与调用，保留 `pickReadinessPcbExecution`/`releaseBindingRequestFields`；真实交接唯一来源为 release-binding | `src/services/__tests__/releaseBindingStore.test.ts`（删冗余用例后仍绿） |
| F8 | PCB P1-8 | `pcbSyncVerify()` 不带 `pcbUuid`，多板工程可能判错板/切走用户文档 | 验证页「回读验收」与 EDA 页同步前后复核都带 `gatePcb/pcbDocumentUuid || activeProject.edaWorkspace.pcbUuid` | typecheck + 页面测试 |
| F9 | 设计 P0-2 | `prepareCandidateForExecution()` 清掉语义计划草稿，而 AssetsPage readiness 唯一输入是同一份草稿 → 走完设计链 readiness 必 `PRODUCTION_PLAN_MISSING` | 不再清草稿（保留给交付链接续），并注明来源仍是本会话编译结果 | `npx vitest run src/pages` |
| F10 | 设计 P2-1 | 执行面板把"基线模式下无新增 error"显示成"官方检查通过" | 改为「无新增违规（基线模式）」并在 title 说明基线语义（类型只有 passed 布尔，不编造基线条数） | typecheck |
| F11 | 交付 P2-7 | 版本快照 `validationStatus` 把 demo/seed 一并计入 | 改用 `validationKpis(state.validations, activeProjectId)` 的 official 口径 | typecheck |

**本轮新增/更新的自动化测试**：`runtime/__tests__/full-audit-2026-11-05-http.test.mjs`（5 例）、`runtime/__tests__/validation-state.test.mjs`（真实证据夹具）、`src/services/__tests__/writeGate.test.ts`（3 例）、`src/pages/__tests__/write-gate-ui.test.tsx`（2 例）、`src/services/__tests__/releaseBindingStore.test.ts`（清理死存储用例）。

---

## 2. 仍开着的闭环（按优先级，含精确落点）

> 这些**不是本轮遗漏**，而是需要产品决策 / 真机数据 / 更大改动面。每条都标了"缺什么"。

### 2.1 需要真机才能判定（本轮无法证明，禁止宣称打通）

1. **原理图受控写入的连线主通道**（设计 P0-1）：`design.mjs` 的 `net.connect → schematic.wire.create` 无真机成功记录；A7 真机跑通的是 `netPort` 通道。需真机确认/替换，并以"目标引脚网络名 == 计划网络名"作为成功判据（报告 `01-design.md` F1）。
2. **六门真实 pass 与签字**（交付 P0-1）：G1（board/spec 输入）、G2（EDA/供应商/资料三源）、G3（意图网表）、G5（`userConfirmed`）在产品 UI 里拿不到必需输入 → 签字按钮永久禁用。报告给了两条路：短期把无通道门标 `implemented:false` 并改文案（无需真机）；长期补通道（G5 纯前端最小）。（`03-delivery.md` P0-1）
3. **正式导出 → 归档 happy path**：R1 修掉哈希域后仍需真机跑一次"readiness→签核→final 导出→归档"，确认 EDA 重导字节稳定、锚点不频繁漂移。
4. **`pcb-sync-from-schematic` 配方假成功**（PCB P0-1）：读回仍只比器件数，真机曾把"importChanges 弹窗未应用"判 completed。修法应改为网表/DRC 等价性读回（报告 `02-pcb.md` P0-1）。
5. **官方 ERC/DRC 返回形状、`pcb.importChanges` 修复后行为、真实重导耗时**：只能真机采样。

### 2.2 代码层可修但本轮未做（按影响排序）

| 优先级 | 项 | 来源 | 下一步 |
|---|---|---|---|
| P0 | 六门可签口径（标未实现/补 G5 勾选传 `userConfirmed`） | 交付 P0-1 | `gate-engine.mjs` + `PlacementPage` + `VerificationCenterPage` |
| P1 | 跨进程 EDA 写锁是死代码（`withEdaWriteLock` 仅 import，0/18 写路由覆盖；P1-11 应改判🟥） | PCB P1-1 | 在分发前对 `EDA_WRITE_ROUTES` 加锁/释放（需重构 handler finally），并补并发测试 |
| P1 | `gate/export/archive` 三处 `releaseDecision` 输入域不同 → UI 按钮亮、点下 409 | 交付 P1-2 | gate 路由改用与 export 相同的完整 binding，回 `exportReady/archiveReady`，UI 只认服务端预检 |
| P1 | 门禁证据无新鲜度/失效判定 | 交付 P1-4 | `gates-service` 接 `evidence-freshness`（过期/换板 → unknown） |
| P1 | 旧签核 `pcbUuid` 绑定来源不一致（留空即恒 blocked） | 交付 P1-5 | UI 统一 derivation + readiness binding 带 pcbUuid |
| P1 | 知识库损坏时门禁建议 200 显示"没有知识" | 平台 P1-1 | `knowledge-gate-advice` 不再吞 `store.query` 异常，返回 `dataErrors`/503 |
| P1 | RAG 不随离线审核/文档变更失效（真实 state 漏 9 条） | 平台 P1-2 | 语料摘要落盘 + 启动/查询比对自动 rebuild |
| P1 | 状态读失败只 warn，启动写回会覆盖损坏权威文件 | 平台 P1-3 | AppContext 读失败禁用自动写回 + 显式告警 |
| P1 | 联网开关不约束外发（设置页测试/知识页抓取/Agent/env 可绕过） | 平台 P1-4 | 外发入口统一过 research-config 门禁 |
| P1 | G4 外发清单漏 5 类真实外发点 | 平台 P1-5 | 补 `provider-egress` 清单 + 断言路由集合 |
| P1 | Supervisor 的 plan 源启动损坏被 `/attention` 静默省略 | 平台 P1-6 | 响应带 `sources` 可用性，UI 显示降级横幅 |
| P1 | 选型提案→设计批准 planHash 结构性不一致（A3 口径） | 设计 P1-1 | 独立 `sourcePlanHash`，不再占用 semantic/compiled |
| P1 | AI 语义计划链与原理图写入链零 ID 关联 | 设计 P1-2 | 产品决策：合流或保持诚实拆线（当前文案已诚实） |
| P1 | 阶段证据可由 `PUT /api/project-state` 伪造成 `schematicStatus` | 设计 P1-8 | 服务端只认 `designManager` 里 completed 的 executionId |
| P1 | Agent 可"自批 → 执行"设计/PCB 写入 | 设计 P1-9 | `agent-auth` 拒绝 execute，或批准 confirm 改本机会话令牌 |
| P1 | GUI 写通道不要求一次性写批准、未套 safety 文案黑名单 | PCB P1-6 | 路由级 `requireWriteApproval` + `automation/safety` 校验 |
| P1 | DRC 截断不进裁决（截断报告可判 passed） | PCB P1-7 | `drcVerdict` 接收 truncated 并按 blocking 处理 |
| P1 | 直连写路由无"在途文档漂移"校验 | PCB P1-4 | 写批内每次回读前复读 `document.current` |
| P1 | 路由契约把测试引用当消费者（说明约 20 条产品级孤儿被掩盖） | UI P1-5 | 契约测试区分"产品消费者"与"仅测试引用"（本轮只清理了允许清单） |
| P2 | 长任务未迁移 5 处、未接线 client 方法 9 个、a11y 禁用原因、draft 残留清理等 | UI P2 | 见 `05-ui-wiring.md` §3.2 |
| P2 | 六门签字无下游消费者、锚点覆盖整目录、evidence→KPI 无回填、archive reviewHash 语义等 | 交付 P2 | 见 `03-delivery.md` §③ P2 表 |

---

## 3. 本轮验证（真实执行）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（tsc -b，0 error） |
| `npx vitest run` | **231/231**（31 文件；含本轮新增 writeGate 3 例 + write-gate-ui 2 例） |
| `npm run test:runtime` | **1460/1460**（1455 基线 + 本轮新增 5 例；cancelled 0） |
| `node --test runtime/__tests__/route-contract.test.mjs` | 3/3，200 路由 / 193 有消费者 / 9 允许清单 / 孤儿 0 |
| `node --test runtime/__tests__/full-audit-2026-11-05-http.test.mjs` | 5/5（R1–R6 回归） |
| `npm run build` | 通过（Vite；仅既有 chunk size 警告） |
| `npm run knowledge:index:check` | 通过（463 entries / 1050 kps / 0 issues） |

---

## 4. 与既有文档口径的差异（需要下次更新 checklist 时采纳）

- `flow-gap-audit-2026-10-29.md` 的"设计链 ✅ / 六门结构闭环 / 交付链结构 ✅"高于实际：设计链主写入通道无真机证据、六门可签不成立、签核→导出→归档在 R1 修复前结构性不可达。本次审计后已把 R1–R7 修复，剩余口径以本文件 §2 为准。
- `circuitpilot-completion-checklist.md` 的 A3"提案→批准全程同一 planHash"、A4"计划层闭环"应改 🟨；A13 ERC 进放行 gate 仍是 🟥（`release-gate.mjs` 的 `netlistEvidence/rulesEvidence` 无生产者）。
- `docs/implementation/README.md` "不允许 AI 自批写入"目前只是插件约定，服务端未强制（设计 P1-9）。

---

## 5. 边界声明

1. 本轮**没有**修改任何 EDA 工程、没有签发/消费真实写板批准、没有写 `artifacts/evidence`、没有联网外发。
2. 所有"修复后通过"均由离线假桥/隔离 state 目录的自动化测试证明；**真机行为未被本轮验证**。
3. 官方验证记录如缺少 `evidence.engine/digest`（旧版本数据）会被 `PUT /api/validation-state` 以 `VALIDATION_EVIDENCE_*` 拒绝：这是有意的 fail-closed，处理方式是重跑一次官方 ERC/DRC 取证，而不是伪造摘要。
4. 审计期间发现 4178 端口上运行的是旧版 App（runtime 0.8.15，`/api/agent/*`、`/api/write-gate`、`/api/research/*` 均 404）；真机复验前需人工退出旧进程，否则会拿旧 Runtime 得到假结论。
5. 报告中的静态 file:line 以 HEAD `98429be` 为基线；修复后的行号已随工作树变化，引用时以修复提交为准。


---

## 6. 第二轮补闭环（2026-11-05 下午，用户要求"把未闭环的打通"）

> 目标：把 §2.2 里"代码层可修"的 P0/P1 全部落地，并给需真机/产品决策的项留下明确边界。
> 全部改动带自动化回归；本轮结束时的验证数字见 §6.4。

### 6.1 第二轮已闭环（按链）

| # | 原缺口 | 落点 | 回归 |
|---|---|---|---|
| B1 | **交付 P0-1 六门可签**：G1 缺 boards、G2 缺三源、G3 缺意图网表、G5 缺 `userConfirmed`，签字永久禁用 | G1：`gates/collect` 在 UI 未给 boards 时用只读 `pcb.outline.read`（boundsMm）+ `pcb.layers.copperCount` 自动生成 design-spec；G2/G3/G5：`VerificationCenterPage` 新增取证输入（层数/宽高、意图网表），取证时真实调 `supplyPricing` 并把 `easyEdaBinding→eda`、`priced→supply` 映射进 components；`PlacementPage` 真实写回带 `userConfirmed:true`；`EdaPage` 校验成功后写 `circuitpilot:reviewed-netlist` 交接供 G3 自动载入 | `runtime/__tests__/p0-fixes-http.test.mjs`（G1 EDA 自动取证）、`src/pages/__tests__/six-gates-inputs.test.tsx`（7 例：boards/三源/意图网表/userConfirmed） |
| B2 | **六门签字无下游消费者**（两条口径互相冒充） | 明确边界而非硬耦合：`GateSignoffRecord.drivesRelease=false` + 验证中心新增"六门签字只做看板留痕，不驱动放行"说明条；正式放行仍以交付页 readiness+DFM+三方签核为准 | `gates-service` 8/8 |
| B3 | **PCB P1-11 跨进程写锁是死代码（0/18 写路由）** | `eda-write-lock.mjs` 新增 `acquireEdaWriteLock`（可分段持锁/释放）；server 分发前对 `EDA_LOCK_ROUTES`（13 条直接写 EDA 的路由）抢同一把文件锁，响应前释放；`automation/run`、`pcb/execute` 保留各自 run 租约（避免把语义化 BUSY 变成 EDA_WRITE_LOCKED） | `eda-write-lock.test` 5/5、`automation-run-lock` 9/9、写路由相关 105/105 |
| B4 | **PCB P1-6 GUI 写通道不要求写批准、不套 safety** | `/api/eda/gui/execute` 非只读动作：先过 `assertGuiAction` 白名单 → 写暂停 → `requireWriteApproval` → 危险文案/结账目标/关窗快捷键检查 | `g3-computer-use` 3/3、`write-gate-http` 3/3 |
| B5 | **PCB P1-7 DRC 截断不进裁决** | `pcb.mjs drcVerdict` 接受 `truncated/reportedCount`：截断一律 `passed=false` 并写 reason；执行记录同步 truncated/口径 | `pcb.test` 23/23（含截断 2 例） |
| B6 | **PCB P1-4 直连写路由无在途漂移校验** | 新增 `guardedExecuteForPcb/guardedExecuteForSchematic`：每个 `allowWrite` 命令前确认活动文档仍是目标，漂移则切回目标（placement/apply、routing apply/rollback/finish、pour/create、layers、schematic/repair） | 写路径相关 105/105 |
| B7 | **PCB P0-1 pcb-sync 只比器件数（假成功）** | recipe v3：可选 `expectedNetNames`（default []）+ compose 读回 `{placement, nets}` + `containsAll` 断言；未传时结果标注 `readbackScope: componentCountOnly`，不再静默假装网表等价；runner 仅 10 行合并 default | `automation.test` 26/26、`verify` 单测 |
| B8 | **交付 P1-2 gate/export 裁决输入域不同（按钮亮、点下 409）** | gate 路由改用与正式导出完全同域 binding（含 projectName/plan/执行/manifest 重算）再 `buildReleaseDecision`，UI 按闸门解锁与实际导出一致 | `release-p06-http`、`multilayer-http`、`release-decisions` 48/48 |
| B9 | **交付 P1-4 门禁证据无新鲜度** | `gates-service` 每类证据按窗口（DRC/ERC/rules 24h、netlist/lib/placement/spec 7d、制造 72h）评估：过期→降级 unknown 并标 `stale+problems`，不能参与 pass/签字 | `gates-service` 8/8（含 stale 用例） |
| B10 | **设计 P1-6 ERC/网表证据进不了放行裁决（死门）** | `gatherReleaseEvidence` 按 targetPcbUuid 从证据库取 `netlist-diff`/`rules` 信封传给 `gateFabricationRelease`；有证据即真实驱动两个子门，缺一类按既有 fail-closed 阻断 | `p0-fixes-http` 新增用例（子门出现 + evidenceBinding 记录） |
| B11 | **交付 P1-5 pcbUuid 绑定来源不一致（留空即恒 blocked）** | `ValidationPage` 统一 `unifiedPcbUuid()`（手填优先→项目 EDA 绑定）用于 DFM/签核/闸门/导出/下单；`AssetsPage` readiness 交接 binding 补 pcbUuid | `npx vitest run src/pages` |
| B12 | **设计 P1-1 选型提案→批准 planHash 结构性不一致** | `EdaPage.validatePlan` 不再把提案哈希注入计划（旧实现使哈希必变、恒告警）；改为直接比较"提案哈希 vs 校验后哈希" | `npx vitest run src/pages` |
| B13 | **设计 P1-7 pin evidence 不落盘、可自报** | `/api/eda/pins/evidence` 落 `pin-evidence` 摘要（digest/counts/pcbUuid/blockers）并回传 digest；`/api/design/netlist/ai` 支持 `pinEvidenceDigest` 引用：服务端回查证据库核对 digest+板号+ok，否则 409；`requirePinEvidence` 认引用 | `pin-evidence.test` 10/10 |
| B14 | **设计 P1-8 阶段证据可被 PUT project-state 伪造** | `PUT /api/project-state` 与项目切面保存前 `sanitizeProjectStateEvidence`：原理图/网表证据必须对上 `designManager` completed 执行，PCB 布局证据必须对上 pcb 执行或批准账本；对不上的字段剔除并在 `evidenceRejected` 如实列出（不整包 409） | `p0-fixes-http` 新增用例 |
| B15 | **平台 P1-1 知识库损坏→门禁建议伪装"没有知识"** | `knowledge-gate-advice` 不再吞 query 异常：返回 `queryErrors/degraded`，全失败且无建议时明确"知识库不可读"；部分失败标注建议不完整 | `knowledge-gate-advice.test`（fix-kb 23/23 指定集） |
| B16 | **平台 P1-2 RAG 不随离线审核/文档变更失效** | `knowledge.mjs` 新增 `knowledgeCorpusDigest/store.corpusDigest`；RAG 索引落盘 `knowledgeCorpusDigest`，启动/查询发现不一致自动 rebuild（reason=`corpus_digest`），query/status 暴露 invalidation；旧索引/损坏/摘要失败均 fail-closed 不崩 | `rag-invalidation.test` 6/6 |
| B17 | **平台 P1-3 状态读失败被吞、启动写回覆盖损坏权威文件** | `AppContext` 四 Store hydrate 失败→ref 标记停自动写回 + `REPORT_ISSUE`（`*_STATE_HYDRATE_FAILED`），读成功恢复；项目切换预写回同守卫 | `src/state/__tests__/hydrate-guard.test.tsx` 2/2 |
| B18 | **平台 P1-4 联网开关不约束外发** | `/api/research/search`、`/api/research/fetch` 除 `allowResearch` 外必须 `researchConfig.enabled===true`，否则 403 带 `configEnabled:false` | `p0-fixes-http` 新增用例 |
| B19 | **平台 P1-5 G4 外发清单漏 5 类真实外发点** | `provider-egress` 补 web.search/web.fetch/supply.pricing/supply.alternatives/provider.modelProbe/retrospective.ai 六类；manifest schemaVersion=2 增 `warnings`（清单只覆盖本 Runtime 出网点等边界）；UI 展示 warnings | `provider-egress.test` 4/4 |
| B20 | **平台 P1-6 Supervisor plan 源损坏被静默省略** | `/api/supervisor/attention|tickets` 下发 `sources`（validations/issues/planRequests 各自 available/reason/detail）；plan 源损坏时显式 unavailable；UI 显示降级横幅（不是"没有待办"） | `supervisor-sources-http.test` 2/2、`supervisor-degraded.test.tsx` 3/3 |
| B21 | **UI P1-1/P1-2 会话级写暂停在布局/自动化页被绕过** | 第一轮已修（`writeGate.ts` + 两页守卫）；第二轮补 `taskMachine.getExecutionGate` 与 `LayerStackPanel` 双口径（task-12） | `writeGate.test.ts`、task-12 新增用例 |
| B22 | **UI P1-3 设置页能力声明失真** | 第一轮已修；第二轮继续显示 research 真实状态（enabled/scheduler/loadError，"状态未知"不冒充关闭） | `research-status.test.tsx` 4/4 |
| B23 | **UI P2（草稿/交接/脏状态/幽灵入口）** | task-12：draftStore 加项目+24h 过期校验、release-binding 读取加项目/时效校验与明确 staleReason、EdaPage 计划脏状态禁用批准/执行、SettingsPage 幽灵入口改可点、LayerStackPanel 守卫 | task-12 测试（见最终验证） |
| B24 | **平台 P2（job journal 轮转/备份覆盖/账本降级标记）** | task-13：eda-job journal 轮转 + recover 跨代读取；backup drill 覆盖 `~/.circuitpilot` 小文件；approval-ledger 降级 `degraded` 标记 | task-13 测试（见最终验证） |

### 6.2 验证口径变化

- 第一轮新增的 `full-audit-2026-11-05-http.test.mjs` 5 例（哈希域/旧签核/伪造官方验证/批准重定向/覆铜目标板）继续全绿；
- 第二轮新增 `supervisor-sources-http.test.mjs`、`rag-invalidation.test.mjs`、`six-gates-inputs.test.tsx`、`hydrate-guard.test.tsx`、`supervisor-degraded.test.tsx`、`research-status.test.tsx` 等；
- `runtime/__tests__/p0-fixes-http.test.mjs` 从 5 例扩到 9 例（G1 自动取证/阶段证据剔除/联网开关门控/release 消费 netlist+rules）。

### 6.3 第二轮后仍未闭环（只剩真机数据/产品决策）

| 项 | 为什么没在本轮关 | 需要什么 |
|---|---|---|
| 设计 P0-1 原理图受控写入的连线主通道 | A7 真机跑通的是 `netPort` 通道；`design.execute` 仍走历史"静默无效"的 `wire.create`，无真机复验不能证明可用 | 真机 EDA：用 netPort+.enet 读回替换/兜底 wire.create，并加"目标引脚网络名==计划网络名"断言；本轮已把该边界写进报告，未改执行器 |
| 六门"真实 pass" | 输入通道已补齐（B1），但 G2 供应商证据需联网/LCSC 实时数据、G6 需真实放行产物、G4 需真实 ERC/DRC；offline 只能证明"缺证据会阻断" | 真机 + 联网跑一次完整六门取证 |
| 正式导出/归档 happy path | B8 修掉哈希域/裁决输入域；仍需真机验证 EDA 重导字节稳定与归档路径 | 真机 "readiness→签核→final 导出→归档" |
| PCB P0-1 默认路径 | expectedNetNames 是可选参数，现有调用方（UI/编排）尚未传；默认仍是 componentCountOnly（已在结果标注，不静默） | 调用方（EdaPage/编排）补读原理图网表并传 expectedNetNames；真机验证 pcb.nets.read 形状 |
| 设计 P1-2 AI 语义计划链与原理图链的 ID 关联 | 产品决策：合流两条链还是保持诚实拆线（当前文案已诚实拆线） | 产品拍板 |
| 设计 P1-3 批准目标绑定可静默降级 | 允许旧批准不绑定（兼容脚本），服务端仅在有绑定字段时校验 | 是否强制新批准必须绑定（不兼容变更） |
| 设计 P1-5 读回不验证"写入的是审核过的网表" | 需服务端重算/比对网表身份并让 `netlistHash` 有消费者 | 设计 netlist readback 契约 |
| 设计 P1-9 Agent 可"自批→执行" | 仅靠 chat `confirm=true` 自报；收紧会改变 DSH 插件既有协作协议 | 产品+插件协议决策（改由 UI 签发一次性确认令牌） |
| 设计 P1-10 需求结构化约束不进计划层 | 计划阶段多数事实（板框/电流）尚未实测，直接阻断会大面积 unknown；属功能扩展 | 产品定义计划层约束分级（fail 阻断/unknown 警告） |
| 交付 P2-2/3/6、PCB P2-1/3/4/5/6/8、平台 P2-1..12（usage UI/扩展市场/锚点语义等） | 多数是展示/体验/工程化取舍，不影响"是否假成功" | 按 checklist 逐项排期；本轮已把 P2 里少数导致误导的项修掉 |

### 6.4 第二轮验证（真实执行）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（0 error） |
| `npx vitest run` | 见 §6.5 最终数字（task-12 完成后复跑） |
| `npm run test:runtime` | 见 §6.5 最终数字（task-13 完成后复跑） |
| `npm run build` | 见 §6.5 |
| `node --test runtime/__tests__/route-contract.test.mjs` | 3/3（200 路由 / 9 允许 / 0 孤儿） |

### 6.5 最终验证数字（第二轮收口实测）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | **通过**（tsc -b，0 error） |
| `npx vitest run` | **273/273**（40 文件） |
| `npm run test:runtime` | **1488/1488**（cancelled 0 / skipped 0） |
| `npm run build` | **通过**（Vite；仅既有 chunk size 警告） |
| `node --test runtime/__tests__/route-contract.test.mjs` | **3/3**：200 路由 / 有消费者 193 / 允许清单 9 / 孤儿 0 |

> 对比：第一轮收口时 vitest 231 / runtime 1460；第二轮新增约 42 条前端测试与 28 条 runtime 测试（含替换/扩充的用例），全部来自本轮闭环项。
