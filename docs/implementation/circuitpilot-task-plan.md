# CircuitPilot 目标达成 · 任务清单与验证清单（Track 1 执行版）

- 生成时间：2026-10-19
- 来源：`circuitpilot-completion-checklist.md`（75 项缺口，18 P0 / 27 P1）
- 本次迭代目标：把"验证与交付可信 + 数据可存档 + 前端不断链 + 测试可回归"这条地基打通（Track 1），不依赖人工写板批准。
- 状态图例：⬜ 未开始 ｜ 🟨 进行中 ｜ ✅ 完成（附验证编号）｜ ⛔ 阻塞（写明原因）
- 纪律：每项完成必须同时满足"代码 + 测试/证据 + 文档状态"；缺一条不算完成；不得用"调用没报错"当通过。
- **当前基线（以 §5 V00 为准）**：vitest **156/156**、runtime **754/754**、`npm run build` exit 0、e2e **30/30**、路由契约 133 条（exact 116 / pattern 17 / orphan 0）、`npm run acceptance` PASS（`artifacts/acceptance/acceptance-2026-10-20T06-11-49-093Z.md`，含 c6-project-switch、f7-ui-render 与 a11y-audit）。第 6–16 节里的 V00 数字是**当轮历史快照**，不是当前基线。


## 1. 任务清单

| ID | 任务 | 对应缺口 | 写作用域 | 验收证据 | 状态 |
|---|---|---|---|---|---|
| T01 | DRC 一键取证闭环：start→poll→report→**落盘**→UI 展示→自动喂放行闸门；移除 `ValidationPage` 硬编码 demo 证据路径 | A12 / B5 / D1 | `runtime/evidence-store.mjs`(新)、`runtime/server.mjs`、`src/services/runtimeClient.ts`、`src/pages/ValidationPage.tsx`、`runtime/__tests__/evidence-store.test.mjs`(新)、`runtime/__tests__/evidence-http.test.mjs`(新) | V01–V04 ✅ | ✅ 2026-10-19（余：豁免编辑器） |
| T02 | 统一放行决策：新增 `buildReleaseDecision`（本地门禁 + DFM 证据 + 人工终审 → 单一 ready/blocked/orderEnabled），release-gate 与 readiness 共用；DFM/终审证据落盘，`online-dfm` 不再写死 false | B1 / B2 / B4(存储部分) | `runtime/release-decision.mjs`(新)、`runtime/production.mjs`、`runtime/server.mjs`、`runtime/__tests__/release-decision.test.mjs`(新) | V05–V08 ✅ | ✅ 2026-10-19（余：三页 UI 口径统一） |
| T03 | Runtime 业务状态持久化（第一批）：语义计划 / 编译计划 / 终审 / DFM 证据 / DRC 报告写盘（原子写 + 启动加载 + schemaVersion） | C1 | `runtime/store.mjs`(新)、`runtime/production.mjs`、`runtime/evidence-store.mjs`、`runtime/__tests__/store.test.mjs`(新) | V09–V11 ✅ | ✅ 2026-10-19（余：项目/聊天/执行历史） |
| T04 | 前端 Demo/真实边界 + 验证页证据来源标注：真实 runtime 未连接时禁用"运行/放行"；所有结果带 source 标签；`ValidationPage` 不再默认 demo 路径 | D3 / D4 / B5 | `src/pages/ValidationPage.tsx`、`src/components/ui.tsx`(如需要) | V12–V13 ✅ | ✅ 2026-10-19（source 逐条标签已在第 3 轮补齐；第 11 轮复核） |
| T05 | 过期 live e2e 修复 + 路由契约测试：`placement-live.spec.ts`/`sync-verify-live.spec.ts` 适配新导航（`nav-validation`、h1「验证与交付」）；新增路由消费者契约测试（防新增孤儿） | F1 / F4 | `e2e/placement-live.spec.ts`、`e2e/sync-verify-live.spec.ts`、`runtime/__tests__/route-contract.test.mjs`(新) | V14–V15 ✅ | ✅ 2026-10-19（e2e-guard 执行，Lead 复核并清理 1 条已接线条目） |
| T06 | 前端交接死链（第一批）：`AiTasksPage` 计划候选进入共享 draft store → `EdaPage` 读取；`ValidationPage` 修复任务写入后 `AiTasksPage` 预填目标（修复目标落 AI 对话页，非 DesignPage） | D2 | `src/services/draftStore.ts`(新)、`src/pages/AiTasksPage.tsx`、`src/pages/EdaPage.tsx`、`src/pages/ValidationPage.tsx`、`e2e/app.spec.ts` | V16–V17 ✅（第 11 轮补页面级 e2e） | ✅ 2026-10-19 |

> 本批不做的 P0（需单独排期/人工批准）：R2/R6 真机写板验收（E1）、R3 连线（A7）、R5 布线 UI（A10）、终审签核 UI 完整版（B4）、三页口径 UI 统一展示（B1 的界面部分）。

## 2. 验证清单（每条都要有命令或读数）

| ID | 验证项 | 命令/操作 | 通过标准 | 对应任务 |
|---|---|---|---|---|
| V00 | 基线不回归 | `npm test`；`npm run build` | typecheck 0；vitest 73+；runtime 483+；build 成功 | 全部 |
| V01 | DRC 报告可落盘 | `node --test runtime/__tests__/evidence-store.test.mjs` | 写入→读回 digest 一致；损坏/缺文件 fail-closed；原子写不留半文件 | T01 |
| V02 | DRC 路由契约 | 起 runtime 后 `curl -s localhost:4199/api/eda/pcb/drc/start` 等（fake bridge 或真机） | start 返回 jobId；report 完成后含 `saved.path/digest`；latest 返回最近一份 | T01 |
| V03 | UI 不再有 demo 默认路径 | `grep -n "cp-multilayer-monitor" src/pages/ValidationPage.tsx` | 0 命中 | T01/T04 |
| V04 | 闸门吃真实报告 | UI：DRC 面板"使用最新取证"→运行闸门；或 `POST /api/eda/release/gate` 带 `drcReportPath` | 闸门 evidence.drc 与 DRC 面板报告 digest 一致；缺证据仍 blocked | T01 |
| V05 | 统一决策纯函数 | `node --test runtime/__tests__/release-decision.test.mjs` | 本地/DFM/终审三组证据组合裁决正确；orderEnabled 恒 false；缺证据 blocked | T02 |
| V06 | readiness 的 DFM 不再恒 false | 单测注入 DFM 证据；HTTP 路由测试 | 有证据→通过；无证据→blocked 且原因可读 | T02 |
| V07 | 三处结论一致 | 单测对比 release-gate / production re-release / readiness 的 decision | 同一证据输入下 ready/blocked 与 blockedBy 一致 | T02 |
| V08 | 终审/DFM 持久化 | 单测 + 重启模拟（重新构造 manager） | 重启后 review/DFM 仍可读；哈希不变 | T02/T03 |
| V09 | 存储原子写 | `node --test runtime/__tests__/store.test.mjs` | 并发/中断写不留半文件；schemaVersion 存在；旧数据可读 | T03 |
| V10 | 计划/终审重启存活 | 单测：构造→normalize→finalReview→新实例加载 | 新实例能 readiness 到同一结论 | T03 |
| V11 | 无静默降级 | 单测：存储损坏 | 抛明确错误并 fail-closed，不返回空通过 | T03 |
| V12 | Demo 边界 | Playwright `app.spec.ts` + 页面断言 | 无 runtime 时"运行闸门/正式导出"禁用；结果带"演示/真实"标签 | T04 |
| V13 | 类型/构建 | `npm run build` | tsc 0 错误 | T01–T06 |
| V14 | live 用例适配 | `npx playwright test e2e/app.spec.ts`；`CP_LIVE_EDA_E2E=1 npx playwright test e2e/placement-live.spec.ts --list` | 非 live 全绿；live 用例可被正确收集/跳过且无旧导航引用 | T05 |
| V15 | 路由契约 | `node --test runtime/__tests__/route-contract.test.mjs` | 每条路由有消费者或显式 internal 标记；新增孤儿会失败 | T05 |
| V16 | 计划候选交接 | Playwright/组件断言 | AI 任务页生成候选→EDA 页可见同一 planHash | T06 |
| V17 | `npx playwright test -g "修复目标"` | 第 11 轮新增页面级 e2e：验证页「创建AI修复任务」→ AI 对话页横幅显示同一目标、聊天输入框预填同一文本（不再只是切页面） |

## 3. 执行顺序与依赖

1. T01 → T02 → T03（后端证据/决策/存储同一条数据链，先做可复用存储）
2. T04 依赖 T01/T02 的接口
3. T05 独立并行（已委派）
4. T06 独立于 T01–T03 的前端状态，但会改 `ValidationPage` → 放在 T04 之后避免冲突
5. 全部完成后跑 V00 收口，更新本文件状态列与 `circuitpilot-completion-checklist.md` 对应条目。

## 4. 完成后的状态更新规则

- 本文件状态列改为 ✅ 并写验证编号；
- `circuitpilot-completion-checklist.md` 中对应条目补"已完成（日期/证据）"标注；
- 新增测试计入 `npm test` 基线数量并更新本文档基线；
- 如出现"假通过/静默降级"，回退该任务并记录反例。

## 5. 本轮实测证据（2026-10-19，逐条可复跑）

| V | 命令 | 结果 |
|---|---|---|
| V00 | `npm test` / `npx playwright test e2e/app.spec.ts` | typecheck 0；vitest **84/84**；runtime **519/519**；**e2e 28/28**；exit 0（第 11 轮收口后数字） |
| V01 | `node --test runtime/__tests__/evidence-store.test.mjs` | 6/6（digest 读回、篡改 `EVIDENCE_CORRUPT`、指纹隔离、参数校验） |
| V02 | `node --test runtime/__tests__/evidence-http.test.mjs` | 3/3（DRC start→report→`saved.digest`→latest；pcbUuid 指纹隔离） |
| V03 | `grep -n "cp-multilayer-monitor" src/pages/ValidationPage.tsx` | 0 命中（demo 默认路径已删） |
| V04 | `server.mjs` release gate 路由 + UI 自动填入 | `POST /api/eda/release/gate` 返回 `releaseDecision`；DRC 面板完成后 `gateDrcPath` 自动指向落盘文件 |
| V05 | `node --test runtime/__tests__/release-decision.test.mjs` | 6/6（缺证据 blocked、ready/ready-with-warnings、orderEnabled 恒 false、指纹稳定/变化） |
| V06 | `node --test runtime/__tests__/production.test.mjs` | 13/13，其中新增：DFM 证据绑定本计划→`online-dfm` 通过；绑定别的计划→不通过；伪造 payload→不通过 |
| V07 | 同上 + `server.mjs` `/api/production/readiness` | readiness 与 release gate 都从 `evidence-store.latest(...)` 取同一份证据；`orderEnabled:false` 两处一致 |
| V08 | `node --test runtime/__tests__/store.test.mjs` + HTTP 测试 | 签核/DFM/DRC 落盘；ProductionManager 新实例能读回计划与终审 |
| V09 | `node --test runtime/__tests__/store.test.mjs` | 4/4（原子写无 `.tmp-` 残留、损坏→`STORE_CORRUPT`、schema 不符→`STORE_SCHEMA_MISMATCH`） |
| V10 | 同上 "重启后已登记计划与终审仍在" | 新实例 `plans/reviews` 读回同一哈希 |
| V11 | 同上 "损坏 fail-closed" | 读损坏文件抛明确错误；服务启动捕获后大声降级为内存（计划缺失→readiness blocked，不产生假通过） |
| V12 | `npx playwright test e2e/app.spec.ts` | 26/26（见 V14 同一轮基线；验证页 DEMO 横幅/按钮禁用为纯前端条件渲染） |
| V13 | `npm run build` | 成功（tsc 0 错误 + vite build，exit 0） |
| V14 | `npx playwright test e2e/app.spec.ts`；`npx playwright test e2e/placement-live.spec.ts e2e/sync-verify-live.spec.ts --list` | 收口后 **28/28**（exit 0，第 11 轮新增 2 条交接 e2e）；`Total: 4 tests in 2 files`，无 env 时 4 skipped。注：早期曾有一次全量跑出现视觉/控制台用例单测失败，单跑与两次复跑均通过，判定为顺序相关 flaky，未改断言 |
| V15 | `node --test runtime/__tests__/route-contract.test.mjs` | 3/3；server 84 条 / client 70 条 / 允许清单 16 / 孤儿 0 |
| V16 | `npx vitest run src/services/draftStore.test.ts`；`npx playwright test -g "草稿进入"` | 4/4 存储单测；**第 11 轮新增页面级 e2e**：sessionStorage 草稿 → EDA 页计划编辑器载入 `E2E_HANDOFF` 并显示来源/交接哈希 |
| V17 | 代码审查 + `draftStore` 单测 | 验证页写 `state.task.goal` + `planHash=fix-*` → AI 页横幅/预填/`instruction`；**未做 Playwright 断言** |
| V18 | `POST /api/production/export` 收口 | 正式导出 = 本地门禁通过 **且** 统一裁决 ready；缺 DFM/签核返回 `RELEASE_DECISION_BLOCKED`，草稿不受影响；UI“导出正式”同步禁用。`node --test runtime/__tests__/multilayer-http.test.mjs runtime/__tests__/evidence-http.test.mjs runtime/__tests__/production-release.test.mjs` → 31/31；**缺“门禁过 + 人工证据缺”的 HTTP 反例**（见 §5 未打通第 1 条） |
| V19 | 运行时冒烟（真实进程） | `CIRCUITPILOT_RUNTIME_PORT=4199 ... node runtime/server.mjs` → `/api/health` ok、`GET /api/eda/pcb/drc/latest` 返回 `{ok:true,evidence:null}`（无证据不伪造）；SIGTERM 正常退出 |

### 新增/修改文件（本轮）

- 新增：`runtime/evidence-store.mjs`、`runtime/release-decision.mjs`、`runtime/store.mjs`、`runtime/__tests__/evidence-store.test.mjs`、`runtime/__tests__/evidence-http.test.mjs`、`runtime/__tests__/release-decision.test.mjs`、`runtime/__tests__/store.test.mjs`、`runtime/__tests__/route-contract.test.mjs`、`src/services/draftStore.ts`、`src/services/draftStore.test.ts`
- 修改：`runtime/server.mjs`（证据路由 + 统一裁决 + 持久化注入）、`runtime/production.mjs`（readiness 吃 DFM 证据 + 持久化）、`src/pages/ValidationPage.tsx`（DRC 面板 / 人工证据面板 / 统一裁决展示 / DEMO 边界 / 修死链）、`src/pages/AiTasksPage.tsx`（计划交接 + 修复目标预填）、`src/pages/EdaPage.tsx`（接收计划草稿）、`src/services/runtimeClient.ts`（DRC/DFM/签核方法）、`src/types.ts`（证据/决策类型）、`e2e/*.spec.ts`（T05）、`.gitignore`（忽略运行时产物目录）
- 运行时产物目录（不入库）：`artifacts/evidence/`（DRC/DFM/签核证据）、`artifacts/state/production.json`（语义计划/终审）

### 本轮仍未打通（诚实标注）

1. ~~DFM/签核证据还没有成为 final 导出的强制门禁~~ → **已补**（2026-10-19 收口）：`POST /api/production/export` 在 `decision.allowed && requested==='final'` 之上再要求 `releaseDecision.ready`，缺 DFM/签核返回 `RELEASE_DECISION_BLOCKED`（草稿不受影响）；UI“导出正式”按钮同步要求统一裁决 ready。仍未做：该分支的 HTTP 级反例（夹具里门禁本身没过，走不到“门禁过但人工证据缺”的分支），目前由 `release-decision` 单测 + 路由代码审查覆盖。
2. `readiness` 与 `export` 的 UI 没有共用同一块"统一裁决"展示；三页口径 UI 统一未做。
3. V16/V17 只是代码接线 + 纯函数单测，页面级（Playwright）交接未断言；需要可用的 AI 后端与真机 EDA 才能稳定测。
4. 豁免编辑器、ERC/仿真 UI、选型提案→plan、验收→EDA 交接、R2/R6 真机写板接受（人工批准）仍未做。
5. **人工证据的板级绑定**：release gate / export 取的是 `evidence-store.latest(...)` 最新一份 DFM/签核，只展示指纹、未强制校验它属于当前这块板/这份计划（readiness 路径已按 planHash 绑定）。换板后旧 DFM 证据理论上可能被复用——需下一步把 DFM/签核指纹绑定到 gate 的 design fingerprint 后再放行。

## 6. 第 2 轮增补（goal round 1，2026-10-19）

> 本轮继续按清单推进 P0：补人工证据的板级绑定、让落盘签核真正驱动 readiness、打通"选型提案→设计批准"、补 3D 导出 UI 与验证结果来源标签。

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T07 | 人工证据板级绑定 | B1/B2/B4 | `buildReleaseDecision` 新增 `binding {planHash, pcbUuid, manifestHash}`：给 binding 时，DFM/签核指纹必须与当前板/计划/清单一致，否则该人工门不过并给出可读原因；release gate / production release / export 三条路由都传 binding（body.pcbUuid / body.planHash）；DFM/签核保存时 UI 自动带上闸门里的 PCB UUID | V20 | ✅ |
| T08 | 落盘签核驱动 readiness | B4/C1 | `ProductionManager.readiness` 的 `human-final-review` 子门改为 `reviewHash（旧路径）|| 落盘签核证据`，签核必须同时绑定 planHash + manifestHash；重启后无需重新签核 | V21 | ✅ |
| T09 | 选型提案 → 设计批准交接 | A3/D2 | `draftStore` 新增独立的 `SchematicPlanDraft`（与语义计划草稿隔离）；`PartProposalPage` "送到设计批准"；`EdaPage` 载入计划编辑器 + 打开高级控制 + 校验时比对提案哈希（不一致显式警告）+ 批准后清草稿 | V22 / V46 ✅ | ✅ 2026-10-19（第 11 轮补页面级 e2e） |
| T10 | 3D 导出 UI | A15 | 新增 `runtimeClient.pcb3dExport` + 验证页 3D 面板（STEP/GLB 选择、PCB UUID、字节数/sha256/分片数、失败给明确错误码；GLB 不可得不伪造） | V23 | ✅ |
| T11 | 验证结果来源标签 | D3 | `ValidationCheck.source`（demo/runtime/official/manual）；Demo 运行结果逐条标"DEMO 模拟"，抽屉里显示数据来源；不再只有页面级横幅 | V24 | ✅ |

### 第 2 轮验证结果

| ID | 命令/操作 | 结果 |
|---|---|---|
| V20 | `node --test runtime/__tests__/release-decision.test.mjs` | 7/7：绑定一致→ready；换板→`manual:dfm`/`manual:signoff` 阻断；证据未绑定→阻断；manifest 不一致→签核阻断 |
| V21 | `node --test runtime/__tests__/production.test.mjs` | 14/14：无 reviewHash 时，绑定 plan+manifest 的签核证据可让 `human-final-review` 通过（source=`persisted-signoff`）且整体 ready；签核绑定错清单→不通过 |
| V22 | `npx vitest run src/services/draftStore.test.ts` | 4/4：原理图草稿与语义草稿互不覆盖、移除/损坏载荷返回 null；页面自动载入未做 Playwright |
| V23 | `npm run build` + 页面代码审查 | tsc 0 错误；`POST /api/pcb/3d/export` 从无 UI 消费者变为 `ValidationPage` 调用；落地后展示字节数/sha256/分片数 |
| V24 | `npx vitest run` + `npx playwright test e2e/app.spec.ts` | vitest 77/77；app.spec 26/26（来源标签为纯展示层，未破坏既有断言） |
| V00 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` | 全绿：vitest 77/77、runtime 507/507、build exit 0、e2e 26/26 |

| T12 | DRC 豁免编辑器 | A12/D1 | 验证页新增"DRC 豁免清单"面板：载入/按本次报告生成草稿/手动新增/逐条编辑（范围、errorType/instanceKey、配额、理由、残留风险、批准人）/删除/保存；服务端仍执行"缺理由/缺风险/缺配额一律拒绝"；GET/PUT `/api/eda/pcb/drc/exemptions` 从零消费者变为 UI 消费 | V25 | ✅ |
| T13 | DRC 分类结论上屏 | A12 | DRC 面板展示 `classification`：ready、总数/已豁免/未解释、截断标记与每条 finding（含 blocking 项）；不再只显示条目数 | V26 | ✅ |

| T14 | readiness 统一裁决 UI | B1/D1 | `AssetsPage` 生产资料面板新增"生产放行统一裁决"：按钮调用 `POST /api/production/readiness`（服务端重算本地门禁 + 落盘 DFM/终审证据），展示 ready/reason/逐门禁 source/原因、referenced manifestHash/reviewHash，并明确"下单永久禁用"；`productionReadiness` 客户方法从 0 页面调用变为真实消费 | V27 | ✅ |
| T15 | 导出结果展示统一裁决 | B1 | `ProductionExportResult` 增加 `releaseDecision`；导出面板显示"可放行/不可放行 + blockedBy"，导出被拒时不再只有一句错误 | V28 | ✅ |

| T16 | 执行历史落盘（原理图/PCB） | C1/C7 | `DesignManager`/`PcbManager` 接受 `createJsonStore`：启动加载、执行结束（含回滚/失败）后原子落盘；列表返回摘要、按 id 取详情；落盘失败不掩盖"板上已写入"的事实，而是记录 `persistenceError` 并在列表响应里如实透出；server 用 `CIRCUITPILOT_STATE_DIR` 下 `design-executions.json`/`pcb-executions.json`，损坏时大声降级为内存（不伪造历史） | V29 | ✅ |
| T17 | 执行历史 UI | C1/D1 | EdaPage 新增"执行历史（落盘，重启仍在）"面板：原理图+PCB 合并列表（时间/状态/计划哈希/DRC/事件数）、刷新、展开完整事件 JSON；执行成功/失败后自动刷新；`GET /api/design/executions`、`GET /api/pcb/executions`、`GET /api/pcb/executions/:id` 与 `designExecution/pcbExecution/designExecutions/pcbExecutions` 客户端方法全部接入 | V30 | ✅ |

### 第 3 轮验证结果（收口）

| ID | 命令/操作 | 结果 |
|---|---|---|
| V25 | `node --test runtime/__tests__/evidence-http.test.mjs` | 4/4：缺理由/风险的豁免 PUT 返回 `DRC_EXEMPTION_INVALID`；合法条目落盘后可读回（count/配额/批准人），测试用 `CIRCUITPILOT_DRC_EXEMPTIONS` 隔离，不碰本机真实豁免文件 |
| V26 | `node --test runtime/__tests__/route-contract.test.mjs` | 3/3：路由 84、有消费者 **71**、允许清单 **13**、孤儿 0（豁免 GET/PUT 两项移出允许清单） |
| V00 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` | 全绿：vitest 77/77、runtime 508/508、build exit 0、e2e 26/26 |

### 第 2 轮仍未打通（相对上一轮的变化）

- 人工证据绑定：已从"只展示指纹"升级为"给 binding 就强制校验"；**export 路径故意不绑 manifestHash**——export 是"生成 final 产物"的动作，签核/DFM 签的是送入生产的那份包，若在生成前用旧包的 manifest 绑定会形成先有鸡还是先有蛋（且 final 重新生成后字节指纹会变）。清单绑定留在 readiness（当前检查包）里校验，export 只绑 planHash/pcbUuid。这是设计决定，不是遗漏，已在本节写明。
- 选型提案交接的页面自动载入只有代码 + 纯函数单测，无 Playwright 断言（需要真实 Runtime/提案数据）。
- 3D 面板只做"导出并自证"，未做产物下载/打开；GLB 在 EDA API 不可得时只能报错。
- 仍未做：ERC/仿真 UI、A7 网表连线、A10 布线 UI、A11 铺铜新建、R2/R6 真机写板（需人工批准）。

## 7. 第 4 轮增补（goal round 4，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T18 | DRC 逐条违规明细 | A12 剩余 | DRC 面板在分类结论下新增明细表：每条违规的类型/规则、对象、网络/层、官方说明、结论（已豁免/未解释/无结论）；豁免与未解释直接从 `classification` 的 `exempted[].itemIndexes` / `unexplained[].index` 映射到行上，最多显示 300 行并明示截断 | V31 | ✅ |
| T19 | 生产清单 CSV 导出 | B6 剩余 | 导出结果面板新增"导出清单 CSV"：文件 kind/name/bytes/sha256/path + outDir/manifestSha256/released/decisionTicket/releaseDecision 一起落成 CSV（前端 Blob 生成，不改运行时时序） | V32 | ✅ |
| T20 | 未消费客户端方法显式标注 | D1 | 给 `generateDesignPlan`、`normalizeProductionPlan`、`recordProductionFinalReview`、`engineeringProfiles`、`events`、`productionRelease` 加 `@legacy` 文档注释，说明替代路径；不再让"看起来能用、实际没人调用"的方法隐身 | V33 | ✅ |

### 第 4 轮验证结果（收口）

| ID | 命令/操作 | 结果 |
|---|---|---|
| V31 | `npx tsc -b` + 代码审查 | tsc 0 错误；明细表仅读 `report.items` 与 `classification`，不改服务端结论；无结论行显示"无结论"而不是默认通过 |
| V32 | `npm run build` | exit 0；CSV 在前端生成，不新增运行时路由（避免为下载任意本地文件开新的攻击面） |
| V33 | `npx tsc -b` | exit 0；`@legacy` 注释随类型检查通过 |
| V00 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` | 全绿：vitest 77/77、runtime 512/512、build exit 0、e2e 26/26 |

**本轮仍不做的（诚实边界）**：
- 生产文件本体（Gerber/BOM/CPL/STEP）仍不能从浏览器直接下载：Runtime 没有"发文件"路由，新增它等于给本机开一个任意文件读取面，需要单独的安全设计（路径白名单 + 一次性令牌 + 仅限产物目录）；当前只下载"清单 CSV"，实际文件在落盘目录用系统文件管理器取。
- A12 明细表 300 行上限：超过时明确标注截断，完整数据在落盘 JSON 里。

## 8. 第 5 轮增补（goal round 5，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T21 | 供应链价格/库存证据接线 | B3/B9 | 新增 `runtimeClient.supplyPricing` + 验证页"供应链证据"面板：按当前 BOM 的精确 LCSC 料号在线查询，展示有价格条目（单价/库存/时间）、无证据条目与原因、`checkedAt/freshnessKnown`；刷新后随 body 传入 release gate **和** production export（`pricing`），供应链闸门据此重算 warning；DEMO 模式禁用联网按钮 | V34 | ✅ |
| T22 | 路由清单收口 | D1 | `POST /api/supply/pricing` 从"死路由/TODO"变为 UI 消费；路由契约 87 路由 / 76 消费者 / 11 允许 / 孤儿 0 | V35 | ✅ |

### 第 5 轮验证结果（收口）

| ID | 命令/操作 | 结果 |
|---|---|---|
| V34 | `npx tsc -b` + `npm run build` | tsc 0 错误；build exit 0；面板无证据时只给 warning，不伪造价格；DEMO 禁用查询 |
| V35 | `node --test runtime/__tests__/route-contract.test.mjs` | 3/3：87 路由、76 消费者、允许清单 11、孤儿 0 |
| V00 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` | 全绿：vitest 77/77、runtime 512/512、build exit 0、e2e 26/26 |

**诚实边界**：在线询价依赖真实外网源（`lookupLcscParts` 直连），没有可注入的假件，因此本轮**没有**做"假 HTTP → UI 快照"的端到端测试；已有 `supply.test.mjs`/`release-gate.test.mjs` 覆盖 `formatSupplyEvidence` 与 `gateSupply` 的判据。UI 只负责发起查询并把结果原样带入门禁/导出，不参与定价。

## 9. 第 6 轮增补（goal round 6，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T23 | 输入变化自动标废批准 | C4 | `AiTask.invalidation`（trigger/reason/at）+ `invalidateTaskApproval` 支持失效上下文；AppContext reducer 在**新增/修改需求、修改器件、BOM 草案写入、资料增删**时自动把 `approved/planned` 任务退回 `planned`、作废旧 `planHash` 并记录触发原因；AI 任务页顶部显示"旧计划/批准已自动失效"警示与重新批准指引 | V36 | ✅ |
| T24 | 防止误伤 | C4 | 只对 `approved/planned` 生效：`draft`（本就无可失效批准）与执行中/已完成任务不被回退；运行时侧原有的 `targetFingerprint`/planHash 漂移拒绝保持不变（双保险） | V37 | ✅ |

### 第 6 轮验证结果（收口）

| ID | 命令/操作 | 结果 |
|---|---|---|
| V36 | `npx vitest run src/state/__tests__/appReducer.test.ts` | 20/20：需求更新后状态→planned、planHash 前缀 `invalidated-`、invalidation.trigger=requirement；器件变化 trigger=component；draft 任务不受影响 |
| V37 | `npx vitest run src/state/__tests__/taskMachine.test.ts` | 11/11：失效上下文（trigger/reason/ISO 时间）正确记录，旧行为（无 context 不写 invalidation）不回归 |
| V00 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` | 全绿：vitest 80/80、runtime 512/512、build exit 0、e2e 26/26 |

## 10. 第 7 轮增补（goal round 7，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T25 | 放行产物安全下载 | A15/B6 | 新增 `GET /api/production/download?path=` + `runtimeClient.downloadProductionArtifact`：三道闸（根目录白名单 `release/`、`deliverables/`，可用 `CIRCUITPILOT_DOWNLOAD_ROOTS` 覆盖；realpath 后仍须在根内，防符号链接逃逸；扩展名白名单 zip/csv/step/stp/glb/gbr/drl/json/txt/pdf/md/xlsx）＋ 300MB 上限 ＋ 仍要求会话令牌；导出文件表与 3D 面板增加"下载"按钮 | V38 | ✅ |
| T26 | 路由契约同步 | D1 | 新路由被客户端消费：88 路由 / 77 消费者 / 允许清单 11 / 孤儿 0 | V39 | ✅ |

### 第 7 轮验证结果（收口）

| ID | 命令/操作 | 结果 |
|---|---|---|
| V38 | `node --test runtime/__tests__/production-download.test.mjs` | 1/1：放行目录内 zip 可下载（字节一致、attachment）；目录外真实文件→403 `DOWNLOAD_PATH_FORBIDDEN`；`../../etc/passwd` →非 200；`.sh`→400 `DOWNLOAD_TYPE_FORBIDDEN`；缺文件→404；无令牌→401 |
| V39 | `node --test runtime/__tests__/route-contract.test.mjs` | 3/3：88/77/11/0 |
| V00 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` | 全绿：vitest 80/80、runtime 513/513、build exit 0、e2e 26/26 |

**诚实边界**：只有 `release/` 与 `deliverables/` 下的产物能下载；导出时手工指定到这两个目录之外的 `outDir`，文件可用系统文件管理器取，但不会经 Runtime 下载（这是刻意的安全边界）。下载路由本身不放行目录列表、不写盘。

## 11. 第 8 轮增补（goal round 8，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T27 | 统一批准审计账本 | C2 | 新增 `runtime/approval-ledger.mjs`：计划/写板/放行共用一条只追加哈希链（prevHash+entryHash，落盘 `state/approvals-ledger.json`，损坏时给 `loadError` 并从空链起锚、不伪造历史）；设计/PCB 计划批准（`ApprovalStore`）与自动化写板批准（`createApprovalStore`）的签发/消费/撤销/过期/复用拒绝全部写入账本；账本只存批准ID（令牌哈希前16位）与绑定哈希，**绝不存令牌原文** | V40 | ✅ |
| T28 | 账本查询与 UI | C2 | `GET /api/approvals/ledger` 返回最近 100 条 + 按 scope/action 汇总 + 链校验结果；验证页新增"统一批准账本（哈希链审计）"面板（作用域/动作/批准ID/绑定、链完整度告警、DEMO 不访问） | V41 | ✅ |

### 第 8 轮验证结果（收口）

| ID | 命令/操作 | 结果 |
|---|---|---|
| V40 | `node --test runtime/__tests__/approval-ledger.test.mjs` | 5/5：3 条记录链成立且首条 `GENESIS`；落盘重启后 4 条仍校验通过；篡改文件第 1 条后重开 `verify()` 报 `brokenAt:1`；损坏文件→`loadError=STORE_CORRUPT` 且不伪造；计划批准签发/消费/复用拒绝留痕且快照不含令牌原文；自动化写板批准与计划共用同链 |
| V41 | `node --test runtime/__tests__/route-contract.test.mjs` + `npm run build` | 3/3：89 路由（+1）/78 消费者/允许清单 11/孤儿 0；build exit 0 |
| V00 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` | 全绿：vitest 80/80、runtime 518/518、build exit 0、e2e 26/26 |

**诚实边界（C2 未完成部分）**：本轮统一的是**审计链**，不是三种批准的全部语义——计划批准（设计/PCB 各自绑定各自 planHash 的一次性 token）与写板批准（服务端签发、指纹绑定）仍是两套内存实现；**放行批准没有独立签发点**，目前以人工签核证据表达并进入统一 `ReleaseDecision`（B1）。三者的共同点是都写进同一条哈希链，因此可统一核对，但"统一 `ApprovalLedger` 签发 API"尚未合并，留待后续轮次。

## 12. 第 9 轮增补（goal round 9，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T29 | 工程写路由的写板批准闸门 | A8/A10/A11 安全前置 | 新增 `requireWriteApproval`：`placement/apply`（`dryRun:false`）、`routing/apply`（`dryRun:false`）、`routing/finish`、`routing/rollback`、`schematic/repair`（`dryRun:false`）在真实写入前必须消费一次**服务端签发、绑定当前窗口+工程+文档指纹**的 `write` 批准；缺批准 409 `AUTOMATION_APPROVAL_REQUIRED`，批准不匹配/过期/复用 409 `AUTOMATION_APPROVAL_INVALID`。此前这些路由"浏览器说写就写"——页面上的批准只是 UI 自觉，绕开页面直接打 HTTP 就能写板 | V42 | ✅ |
| T30 | 行为回归 | — | `multilayer-http.test.mjs` 的真实修复写入流程改为：先验证无批准被拒 → 再由"签发写板批准"接口拿一次性批准 → 写入成功后批准被消费；空网表用例也先拿新批准，证明 409 的原因是网表而不是缺批准 | V43 | ✅ |

### 第 9 轮验证结果（收口）

| ID | 命令/操作 | 结果 |
|---|---|---|
| V42 | `node --test runtime/__tests__/multilayer-http.test.mjs` | 20/20：四条工程写路由无批准均 409 `AUTOMATION_APPROVAL_REQUIRED`（placement apply / routing apply / finish / rollback）；修复路由 dry-run 不需要批准、真写必须带批准 |
| V43 | `node --test runtime/__tests__/multilayer-http.test.mjs`（修复用例） | 无批准→409；签发 write 批准后真写成功（12 条写命令、addIntoPcb=true、写后重跑验收）；空网表在**带新批准**时仍 409 `EDA_NETLIST_EMPTY`，拒绝原因准确 |
| V00 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` | 全绿：vitest 80/80、runtime 519/519、build exit 0、e2e 26/26 |

**诚实边界**：这只补上了"服务端强制批准"的程序闸门，**不等于**真机写板验收（A8/E1 R2·R6 仍需真机 + 人工批准）。dry-run 路径不需要批准（不写盘），设计如此。

## 13. 第 10 轮增补（goal round 10，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T31 | 放行批准入统一账本 | C2（补齐 release 签发点） | 三方签核成功落盘后，同时向统一批准账本写一条 `scope=release, action=issued` 记录，绑定 `planHash/manifestHash/pcbUuid`，批准ID取签核证据 digest 前 16 位（不存原文）。放行仍以持久签核证据 + `buildReleaseDecision` 裁决（不是一次性令牌），但现在三类批准（计划/写板/放行）都能在同一哈希链里核对 | V44 | ✅ |
| T32 | 回归 | — | 终审签核 HTTP 测试新增断言：签核后账本出现 release 记录且绑定清单/计划哈希、链完整 | V45 | ✅ |

### 第 10 轮验证结果（收口）

| ID | 命令/操作 | 结果 |
|---|---|---|
| V44 | `node --test runtime/__tests__/evidence-http.test.mjs` | 4/4：签核落盘后 `GET /api/approvals/ledger` 出现 `scope=release, action=issued`，`bindings.manifestHash=m-1`、`planHash=plan-1`，`chain.ok=true` |
| V45 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` | 全绿：vitest 80/80、runtime 519/519、build exit 0、e2e 26/26 |

**诚实边界**：release 仍是"持久证据 + 决策"而非一次性令牌（这是刻意设计：放行要能重启后复核）；统一的是账本与审计事实，不是三套批准实现本身——C2 的"合并为同一签发 API"仍未做，记为剩余。

## 14. 第 11 轮增补（goal round 11，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T33 | 前端交接页面级回归 | T06 / D2 | `e2e/app.spec.ts` 新增 2 条交接 e2e：① 验证页「创建AI修复任务」→ AI 对话页横幅带同一目标 + 聊天输入框预填同一修复文本；② sessionStorage 计划草稿 → EDA 页计划编辑器载入结构化计划、显示来源与交接哈希 | V46 | ✅ |
| T34 | T01–T06 状态收口 | — | T04（source 标签已补齐）、T06（页面级 e2e 已补）改为 ✅；T01–T06 六项全部 ✅；V00 基线更新为 vitest 80 / runtime 519 / e2e 28 | V47 | ✅ |

### 第 11 轮验证结果（收口）

| ID | 命令/操作 | 结果 |
|---|---|---|
| V46 | `npx playwright test e2e/app.spec.ts -g "修复目标|草稿进入"` | 2/2 通过（选择器按真实 aria-label 修正：`发送给Codex的PCBA需求`、哈希前 12 位 `e2e-handoff-`） |
| V47 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` | 全绿：vitest 80/80、runtime 519/519、build exit 0、**e2e 28/28** |

**T01–T06 收口结论**：六项均为 ✅，且每项都有对应验证编号与可复跑命令；页面级交接回归已自动化。P0 中剩下的 A7/A8/A10/A11/E1 是真实写入链路，必须真机 + 用户签发写板批准，不能在无人工批准的情况下"完成"。

## 15. 第 12 轮·最终一致性核对（goal round 12，2026-10-19）

| 核对项 | 结果 |
|---|---|
| T01–T06 状态 | 六项全部 ✅，每项都有 V 编号（V01–V17）与可复跑命令；T09（选型→EDA 交接）随页面级 e2e 一并 ✅ |
| 测试基线 | `npm test`：typecheck 0、vitest 80/80、runtime 519/519；`npm run build` exit 0；`npx playwright test e2e/app.spec.ts` 28/28；live 两文件 4 tests 可收集（无 env 时 skipped） |
| 路由/消费者 | 89 路由 / 78 消费者 / 允许清单 11 / 孤儿 0（`route-contract.test.mjs` 3/3） |
| 文档一致性 | `circuitpilot-completion-checklist.md` 头部基线已更新为当前实测；A3/A15/B1/B4 已补"当前结论=✅ 验收满足"；C1/C2/D1 补"当前结论=🟨 剩余点"；删除了 A15 一条被后续更新取代的旧状态行 |
| 阻塞项 | A7/A8/A10/A11/E1 真实写入链路必须真机 + 用户签发写板批准；AI 不得自批，故不在本目标内"完成" |

### 目标达成判定

- 目标要求的 Track 1 六项交付（DRC 取证闭环、统一放行决策、Runtime 持久化、Demo/真实边界、live e2e 修复+路由契约、前端交接死链）**全部完成并验证**。
- 后续 P0/P1 已按清单推进：A12/A15/B2/B3/B4/B5/B6/C2(审计链)/C4/D2/D3 等关闭或收口，C1 执行历史落盘、C2 三类批准同链、D1 契约对账。
- 剩余为**用户/真机阻塞**与**产品决策**项（写板批准、聊天 transcript 持久化、批准实现合并、legacy 方法去留），已如实记录，不冒充完成。

## 16. 第 13 轮增补（goal round 13，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T35 | 系统事件时间线 | C3 | `VersionsPage` 新增「系统事件」页：切换即拉取 `/api/events`（Runtime 日志事件），支持级别筛选/刷新/导出运行事件 JSON（含 runtime 状态与界面审计），并显著标注"进程内存日志 ≠ 持久审计"，Runtime 不可达时明确报错而非空列表；`runtimeClient.events` 去掉 `@legacy` 注释 | V48 | 🟨 部分完成（无统一 runId 回放） |
| T36 | 订单卡供应链证据 | B7 | 下单参数卡内新增「供应链证据」：有价/无价料号数、查询时间戳、按下单数量估算的库存不足料号数；无证据时明确"未知不是 0 元"。仍不下单、不猜价 | V49 | 🟨 部分完成（交期/工艺能力/替代料未接） |
| T37 | 文档状态规范化 | H1 | 检查表 D2/D3 补 ✅ 当前结论（工作早已完成但状态行缺标记）；C3/B7/D1 写入当前结论；基线更新（e2e 29/29）；`automation-kernel.md` 旧 e2e 数字更新 | V50 | ✅ |

### 第 13 轮验证结果（收口）

| ID | 命令/操作 | 结果 |
|---|---|---|
| V48 | `npx playwright test e2e/app.spec.ts -g "系统事件"` | 1/1：事件页展示边界说明；Runtime 不可达时显示读取失败；无事件时导出按钮禁用 |
| V49 | `npx tsc -b` + `npm run build` | 0 错误；订单卡供应链区块复用第 5 轮价格证据，无新网络调用 |
| V50 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` | 全绿：vitest 80/80、runtime 519/519、build exit 0、**e2e 29/29** |

**诚实边界**：C3 只做到"日志时间线 + 导出"，未做"任意一次运行按 runId 回放完整执行/批准/门禁/签核/导出链"；B7 只做到价格/库存证据展示，交期/工艺能力仍是示例档，替代料未接。真机写板（A7/A8/A10/A11/E1）仍需用户显式签发写板批准。

## 17. 第 14 轮增补（goal round 14，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T38 | 一键验收脚本 | F3 | 新增 `scripts/acceptance.mjs` + `npm run acceptance`：依次执行 typecheck→vitest→runtime→build→路由契约→e2e（可 `--skip-e2e`），并产出 `artifacts/acceptance/acceptance-*.json` + `.md`（机器可读 + 人读）；真机写板/live/配方矩阵/衣橱验收默认 **SKIPPED 并写明原因**，不伪装 PASS；必需步骤失败 exit 1 | V51 | 🟨 部分完成（真机段为 SKIP，报告未接 CI） |

### 第 14 轮验证结果

| ID | 命令/操作 | 结果 |
|---|---|---|
| V51 | `npm run acceptance` | exit 0；PASS：typecheck、vitest 80/80、runtime 519/519、build、契约 3/3、e2e 29/29；SKIP：live e2e、真机写板、配方矩阵、衣橱（报告写入 `artifacts/acceptance/`，目录已 gitignore） |
| V51b | `node scripts/acceptance.mjs --skip-e2e` | exit 0；快速自检模式可用，e2e 段标 SKIPPED 并注明主动跳过 |

## 18. 第 15 轮增补（goal round 15，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T39 | 存储 schema 迁移机制 | C7 | `runtime/store.mjs` 支持 `migrations[旧版本]` 逐级迁移：load 内不写盘、返回 `migratedFrom`、迁移函数需幂等；未来版本显式拒绝（`direction:'future'`）；缺迁移/迁移抛错/迁移返回空分别 `STORE_MIGRATION_MISSING`/`STORE_MIGRATION_FAILED`；旧测试保持兼容 | V52 | ✅ 机制完成（现网所有文件均 v1，无实际迁移脚本需求） |

### 第 15 轮验证结果

| ID | 命令/操作 | 结果 |
|---|---|---|
| V52 | `node --test runtime/__tests__/store.test.mjs`；`npm test` / `npm run build` | store 6/6（新增：1→3 逐级迁移且 load 无副作用、迁移后 save 再 load 不重迁、缺迁移/迁移抛错/未来版本三类 fail-closed）；全量 vitest 80/80、runtime **543/543**、build exit 0 |

## 19. 第 16 轮增补（goal round 16，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T40 | 写板批准 fail-closed 反例矩阵 | G6 | 新增 `runtime/__tests__/fail-closed.test.mjs`：5 条写入路由缺批准 → 409 且**零写入命令执行**；伪造批准 → 409 且带当前 EDA 指纹/缺失原因；dry-run 不受批准闸门拦截；关键路由无会话凭证 → 401。错误断言用具体 code，不用"状态码 >= 400"糊弄 | V53 | ✅ |

### 第 16 轮验证结果

| ID | 命令/操作 | 结果 |
|---|---|---|
| V53 | `node --test runtime/__tests__/fail-closed.test.mjs`；`npm test` / `npm run build` | 4/4；全量 vitest 80/80、runtime **543/543**、build exit 0；`npm run acceptance --skip-e2e` PASS |
| 备注 | 首次运行失败原因 | 断言用了顶层 `payload.code`，实际错误信封是 `{ok:false,error:{code,details}}`；改为按真实信封断言后通过（不是放宽断言） |

## 20. 第 17 轮增补（goal round 17，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T41 | 批准签发/校验核心合并（C2/E5） | C2 / E5 | 新增 `runtime/approval-service.mjs`：scope、TTL、一次性、绑定校验、撤销、容量上限、审计事件回调统一到唯一实现；`Design ApprovalStore`（plan）与 `automation createApprovalStore`（write）改为薄适配器，保留原 API、错误码、journal/ledger 记录格式；release 仍以持久签核证据表达并写同一账本（有意差异） | V54 | ✅ 核心合并（release 语义差异已记录） |

### 第 17 轮验证结果

| ID | 命令/操作 | 结果 |
|---|---|---|
| V54 | `node --test runtime/__tests__/approval-service.test.mjs`；`npm test` / `npm run build` / `npm run acceptance` | service 5/5（令牌不落公开视图、一次性/重放、绑定与作用域不匹配不消费、过期/撤销/未知码、批量 resolve 原子性、容量淘汰）；全量 vitest 80/80、runtime **543/543**、build exit 0、e2e 29/29、acceptance PASS |
| 备注 | 兼容性 | 旧测试全部未改断言即通过（design 的绑定/TTL/重放、automation 的签发/消费、ledger 的签发/消费链、multilayer 的批准消费）；仅新增 service 单测，没有放宽任何既有断言 |

**诚实边界**：合并的是 plan/write 的签发与校验实现；release 仍是"持久签核证据 + 统一账本记录"，不是一次性令牌（产品语义差异）。E5 的“计划批准自动继承写步骤”按三次人工批准策略有意未做。

## 21. 第 18 轮增补（goal round 18，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T42 | ERC 归一化/分类/豁免/修复建议 + 取证落盘 + UI | A13 | 新增 `runtime/erc.mjs`：聚合式与明细式 ERC 统一归一化为 finding（明确 `aggregateOnly`，不伪造对象）；确定性修复建议（引脚悬空→noConnect/上拉、缺 PWR_FLAG→补 netFlag、重复/命名→人工确认）；豁免校验（理由必填、可按 code/对象）与原子文件写入；新增 4 条只读/登记路由与证据 kind `schematic-erc`；验证页新增「原理图 ERC 收敛」面板（运行取证/载入最新/生成豁免草稿/保存豁免/区分聚合与明细） | V55 | 🟨 产品流程完成，真机错误清 0 待 A7 |

### 第 18 轮验证结果

| ID | 命令/操作 | 结果 |
|---|---|---|
| V55 | `node --test runtime/__tests__/erc.test.mjs runtime/__tests__/erc-http.test.mjs`；`npx playwright test -g "ERC 收敛面板"`；`npm test` / `npm run build` / `npm run acceptance` | erc 单测 5/5（聚合不伪装明细、明细计数、空/畸形 ran=false、豁免无效退回、文件原子写）；HTTP 1/1（取证落盘→latest 同 digest→无效豁免 400→有效豁免写入→重跑豁免生效且 digest 变化）；e2e 1/1（DEMO 禁用 + 空态说明）；全量 vitest 80/80、runtime **543/543**、build 0、e2e **30/30**、acceptance PASS |

**诚实边界**：ERC 面板是取证 + 人工收敛流程，不自动改原理图；ERC 结论未并入放行 gate（原理图 ERC 与 PCB 放行证据是两类证据，避免混淆）；真实错误清 0 需要 A7 完成 + 真机重跑，属于人工/真机验收。

## 22. 第 19 轮增补（goal round 19，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T43 | 统一失败诊断入口 | D4 | 新增 `runtime/failure-diagnosis.mjs`：错误码目录（严重级/建议/修复页面）、上下文白名单（令牌/密钥类字段一律丢弃）、指纹聚合、`toIssueRecord`；`POST /api/diagnostics/failure`；前端 `reportFailure`（诊断不可达时退回本地记录，不丢问题）+ 问题中心「去修复」按钮；接线闸门失败与自动化失败两个高频入口 | V56 | 🟨 两个入口已统一，其余 catch 待迁移 |

### 第 19 轮验证结果

| ID | 命令/操作 | 结果 |
|---|---|---|
| V56 | `node --test runtime/__tests__/failure-diagnosis.test.mjs`；`node --test runtime/__tests__/route-contract.test.mjs`；`npm test` / `npm run build` / `npm run acceptance` | 诊断 4/4（已知码建议+修复入口、未知码不降级、上下文白名单不含 token、IssueRecord 结构、HTTP 200/400）；路由契约 94 条 / 有消费者 86 / 允许清单 11 / 孤儿 0；全量 vitest 80/80、runtime **543/543**、build 0、e2e 30/30、acceptance PASS |

**诚实边界**：D4 只完成"统一入口 + 两个高频接线"，不是所有 catch 都已迁移；`reportFailure` 在 Runtime 不可达时只能退回本地记录（没有服务端证据），这一点已在 UI 文案与文档中写明。

## 23. 第 20 轮增补（goal round 20，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T44 | 聊天 transcript 落盘与重启重建 | C1 | `ChatManager` 接入 `createJsonStore`（`chat-transcripts.json`）：成功问答后追加 user/assistant 文本；Codex 线程创建时注入最近 12 条历史（ephemeral 线程重建而非落盘 threadId）；API 后端优先用落盘历史；`GET /api/chat/sessions/:id/transcript`；reset 清空；AI 页 localStorage 为空时从 Runtime 恢复消息并标来源 | V57 | 🟨 聊天已持久化；项目/需求数据仍未迁 |

### 第 20 轮验证结果

| ID | 命令/操作 | 结果 |
|---|---|---|
| V57 | `node --test runtime/__tests__/chat-transcript.test.mjs`；`route-contract.test.mjs`；`npm test` / `npm run build` / `npm run acceptance` | transcript 3/3（落盘角色/内容、重启后新线程 instructions 含历史用户与助手消息、reset 清空、HTTP 401/读回/清空）；路由契约 95 / 87 / 11 / 0；vitest 80/80、runtime **543/543**、build 0、e2e 30/30、acceptance PASS |

**诚实边界**：只持久化对话 transcript，没有持久化"项目/需求/组件"这些业务主数据（仍在 localStorage）；UI 恢复路径需真实 Runtime 才能触发（DEMO 下不执行），本轮以 TypeScript 编译 + HTTP 测试覆盖，未做真机 UI 恢复截图。

## 24. 第 21 轮增补（goal round 21，2026-10-19）

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T45 | 订单卡来源/假设标记与一致性告警 | B7 | 下单参数表加交期（示例档，不猜交期）与板厂能力档来源行；渲染 assumptions；价格已知但无供应链证据时红色一致性告警 | e2e 30/30 + build | ✅（实时供应商 API 仍外部依赖） |
| T46 | legacy 客户端方法与路由允许清单收口 | D1 | 保留 5 个 legacy 方法并统一 `@legacy` 标注替代路径；路由允许清单 11 条全部有原因；契约 95/87/11/0 | route-contract 3/3 | ✅ 决策收口 |
| T47 | 关键页面渲染冒烟 | F5 | 新增 `pages-smoke.test.tsx`：Automation/Validation/Placement/PartProposal 四页渲染 + 安全文案断言 | vitest 84/84 | ✅ 渲染冒烟（交互仍靠 e2e） |
| T48 | live 测试分层核查 | F2 | 确认 `CP_LIVE_EDA_E2E=1` 门槛、失败截图/trace/HTML 报告、acceptance JSON/MD 归档 | 配置核查 | 🟨 未做统一证据目录 |

### 第 21 轮验证结果

| ID | 命令/操作 | 结果 |
|---|---|---|
| V58 | `npm test` / `npm run build` / `npx playwright test e2e/app.spec.ts` / `npm run acceptance` | vitest **84/84**、runtime 543/543、build 0、e2e 30/30、acceptance PASS；新增页面冒烟 4/4 |

**诚实边界**：B7 未接实时供应商交期/价格（外部依赖）；F2 失败证据仍在 Playwright 默认目录、未做统一归档；F5 是渲染冒烟而非完整 RTL 交互测试。

## 25. 第 22 轮增补（goal round 22，2026-10-19）——真机写板验收与 R3 网表连线通道

授权背景：用户在本会话显式指示"我批准你去做，请你需要我签发就控制电脑去自己实现"——
允许代理通过受控通道（HTTP 批准接口 + 本机 EDA 会话）按其指令代签一次性 write 批准并执行真机写板。
批准仍由服务端在真实 EDA 指纹上签发、一次性消费、30 分钟 TTL，未伪造 EDA 状态、未放宽门禁；
journal/notes 如实记录"由 AI 代用户签发"。

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T49 | 真实网表可读（大文件分片） | A7/A12 | `schematic.netlist.export` 返回 `inline:false` 时新增 `schematic.netlist.chunk`（read，30s）分片取回；`runtime/schematic-acceptance.mjs` 新增 `exportSchematicNetlistText` 循环拼接，分片失败显式报 `ACCEPTANCE_NETLIST_EMPTY`（不把半截网表当完整）；bridge/验收测试补用例 | V59 | ✅ |
| T50 | R3 网表连线通道（写→保存→读回→回滚） | A7 | 新增 `runtime/net-connect.mjs`：`indexNetlist`/`planNetConnect`/`applyNetConnect`/`verifyNetConnect`/`rollbackNetConnect`/`collectDanglingPins`/`buildTestConnections`；写命令 30s 预算不重放，中止后先按"网络名+坐标"读回再决定是否重试；回滚二次清理并读回核实（幂等：已删除不再写盘） | `net-connect.test.mjs` 7/7 | ✅ |
| T51 | 两个真实写路由 + A7 验收脚本 | A7/E5 | `POST /api/eda/schematic/net-connect`（默认 dryRun 只读、`autoCandidates` 自动挑悬空引脚、写前消费 write 批准并校验文档）、`POST .../rollback`；`ensureSchematicActive` 统一校验批准文档/打开页面/等文档就绪；`scripts/a7-r3-acceptance.mjs`（probe/write/rollback 三相位 + 证据落盘 + 代签批准 note） | 真机 probe→write→rollback（见 V59） | ✅ |
| T52 | R2 配方读回纠错与读回重试 | A8/E1 | 读回改为 PCB 上下文 `pcb.placement.read` + 新增 `schematic.parts.read`（仅 part）与 `expectedComponentCount` 参数（`schematic.*` 在 PCB 文档上下文真机必 500）；新增 `expect.readRetries`（只重读、写动作绝不重放）并补 runner/配方校验测试；`netPort.create` 声明 longRunning | V59 | ✅ |
| T53 | R2/R6 真机写板验收 | A8/E1 | 真机执行两条配方：R2 `completed`、R6 `completed`；R2 前一版失败（读回 500 + 兜底菜单文案漂移）作为失败证据留存；独立 `/api/pcb/sync/verify` 复核 designator diff 0；失败路径（无批准 0 步、复用 409、指纹漂移 409）真机复验 | V59 | ✅ |
| T54 | 验收证据与文档回填 | E1/H | `artifacts/r2-r6-acceptance/README.md` + journal 副本 + before/after 读回 + 409 原始响应；A7 证据 `artifacts/a7-r3/2026-10-19T09-51-44-141Z/`（含首轮失败清理记录）；本清单与完成清单状态更新 | V59 | ✅ |

### 第 22 轮验证结果

| ID | 命令/操作 | 结果 |
|---|---|---|
| V59 | `npm test`（typecheck + vitest + runtime）/ `npm run acceptance` / `npm run build` / `app.spec` e2e / 真机 R2+R6+R3 | typecheck 0、vitest **84/84**、runtime **554/554**、build 0、e2e **30/30**、acceptance **PASS**；路由契约 **97/89/11/0**；真机 R2 `completed`（designator diff 0、哈希链完整）、R6 `completed`（铺铜 2 个非空）、R3 写 5 引脚/3 网络后网表逐引脚读回正确并删除复原；失败路径无批准 0 步、复用批准 409、指纹漂移 409 均真机验证 |

**诚实边界**：
- R2 在本板执行前 designator diff 已为 0（`importChanges` 在已同步板上是 no-op），本轮价值是通道真机跑通与读回证据，不是"修好了一个坏板"；
- GUI 兜底菜单文案 `更新/转换原理图到 PCB` 在本机 EDA 3.2.186 找不到（菜单文案漂移，E6 仍待补；R2 成功路径为 API 优先，不依赖兜底）；
- A7 写入的是**验证用临时网络 `CP_R3_TEST_*`**，写后已全部删除复原；真实语义网络归属需要设计意图，不能由自动化猜测；
- 写板批准由代理按用户显式会话授权代签，批准内容可在 `artifacts/a7-r3/*/approval-*.json` 与 `artifacts/r2-r6-acceptance/*` 审计。

## 26. 第 22 轮增补（R4/R5/R7/R8 真机边界，2026-10-19）

| ID | 任务 | 对应缺口 | 真机结果 | 状态 |
|---|---|---|---|---|
| T55 | R7 DRC 长任务真机 | A9/E3 | DRC 任务真机 `done`，归一化分类 ready=false（total 13464 / unexplained 13462），证据落 `artifacts/evidence/drc-report/…json` 与 `artifacts/r2-r6-acceptance/r7-drc-report.json` | ✅ 通道可用 |
| T56 | R8 先裁决后导出真机 | A15/E3 | `final` 被门禁拒绝写盘（8 类阻断，releaseDecision ready=false）；`draft` 真导出 Gerber/BOM/CPL 三件且强制 DRAFT 命名、复核 pass；证据 `artifacts/r2-r6-acceptance/r8-*` | ✅ 通道可用 |
| T57 | R4 布局写回真机（不保存） | A9/E3 | 1 器件 0.06mm 位移：写入→逐项回读→独立复核拦截→自动回滚并读回确认，`saved=false`，C38 复原；证据 `r4-placement-write.json` | ✅ 写/读/复核/回滚通道可用；本板自动布局 plan 未过几何复核，无 applied 成功证据（不伪造） |
| T58 | R5 布线写回真机 | A10/E3 | 读回/规划/独立复核真机可用（1 条 AMP_VCC 路由通过复核）；`apply` 对未复核计划拒绝（未写），对合法路由连续两次 `BRIDGE_HTTP_ERROR`（Bridge 500）→ 内部回滚后铜读回 5048/412 不变 | 🟨 布线真机写入**未打通**（EDA 写命令 500）；只读规划链可用 |

**诚实边界**：R4/R5 的写入都未保存（`save:false`），失败路径均回滚并以铜/坐标读回核实"板子原样"；R5 写命令在本机 EDA 3.2.186 返回 Bridge HTTP 500，属 EDA 侧限制/回归，不标 PASS。

## 27. 第 23 轮增补（goal：`请全部修补这些问题`，2026-10-19）

目标：按上一轮差距清单逐项**真修**（不假 PASS），先修离线可验证的 P0/P1/P2 项，真机受限项给出可诊断边界 + 复跑路径。
授权背景不变：用户已在会话中显式授权代理"需要签发就控制电脑自己实现"；批准仍是服务端在真实 EDA 指纹上一次性签发/消费、30 分钟 TTL、journal/notes 标注"由 AI 代用户签发"，`orderEnabled:false` 不新增任何下单/支付能力。

| ID | 任务 | 对应缺口 | 改了什么 | 验证 | 状态 |
|---|---|---|---|---|---|
| T59 | 失败诊断库对齐真机错误码 | E12 | `runtime/failure-diagnosis.mjs` 目录扩到 40+ 个真机实际出现过的错误码（BRIDGE_HTTP_ERROR、EDA_REQUEST_ABANDONED、EDA_JOB_BUSY、TARGET_DRIFT、READBACK_*、NET_CONNECT_*、PLACEMENT_WRITE_*、ROUTING_*、PRODUCTION_*、DESIGNATOR_*、SCHEMATIC_BATCH_*、RELEASE_CONSTRAINT_* 等），每条给严重级/建议/修复页；删掉杜撰码 | `failure-diagnosis.test.mjs` 5/5 | ✅ |
| T60 | 支付/下单红线加固 | G2 | `DANGEROUS_TEXTS` 覆盖中英文下单/支付全变体；新增 `CHECKOUT_URL_PATTERNS` + `assertNotCheckoutTarget`，runner 预检 + GUI 执行器点击前都拦截；配方 alternatives 也逐个过红线检查 | `automation-safety.test.mjs` 4/4 | ✅ |
| T61 | 选型检索回退链 | A2 | `buildQueryVariants`（去括号/去品牌/取首段/去斜杠后缀，≤5 级）+ `attempts`/`usedQuery`/`fallback` 证据，全空给 `NO_RESULT` 不产候选；首变体命中只调一次搜索 | `selection-evidence.test.mjs` 3/3 | ✅ |
| T62 | 原理图批量落件通道 | A6 | 新增 `runtime/schematic-batch.mjs`：逐项校验身份/坐标、按"身份+坐标"幂等匹配（同型号多颗不误判）、逐件创建并原子落进度（同 planHash 可续跑）、失败即停、保存后读回验收；`POST /api/eda/schematic/component-batch`（默认 dryRun，写盘必须 write 批准） | 模块 6/6 + HTTP 2/2 | ✅ |
| T63 | 位号标注门禁与通道 | A5 | 新增 `runtime/designator.mjs`（`C?` 判定/计划断言/目标位号格式）；布局写回在快照前拒收 `?`、PCB 计划引用 `?` 判不完整；新增桥命令 `schematic.component.designator.set` + `POST /api/eda/schematic/designators/set`（写批准→逐件标注→保存→独立读回核对） | `designator.test.mjs` 4/4 + bridge 33/33 | ✅ 通道；真机清零待跑 |
| T64 | 需求硬约束进门禁 | A1 | 新增 `runtime/constraints.mjs`（板框最小尺寸/电流预算/GPIO 下限/必需接口/温度上限归一化 + 事实比对，缺事实 unknown 阻断）；`gateFabricationRelease` 新增 `constraints` 子门并透传 constraints/designFacts，报告逐条列结论 | `constraints.test.mjs` 4/4 | ✅ 机器门禁；UI 接线待补 |
| T65 | 布局计划接 128 条规则审计 | A9 | 新增 `runtime/placement-rules.mjs`：计划+读回→规则引擎输入（不编造几何）；写回前审计，硬门禁量到违规才阻断（MECH-05 出框），证据不足记 `evidenceGapFailures` 不冒充违规；apply 非 dryRun 前置 `PLACEMENT_RULES_BLOCKED`，plan 返回 layoutAudit | `placement-rules.test.mjs` 3/3 | ✅ 适配器/门禁；UI/真机证据待补 |
| T66 | 配方版本化与菜单文案漂移 | E6 | `RECIPE_CHANGELOG` 要求每条内置配方当前版本有日期+说明、升级保留旧记录（R2→v2）；GUI `clickText` 支持 `alternatives` 文案变体，全部候选先过红线，全失败给 `attemptedTexts` + 能力探测提示 | `recipe-versioning.test.mjs` 4/4 | ✅ 机制；真机复验待补 |
| T67 | live e2e 运行手册 | F1 | 新增 `docs/implementation/live-e2e-runbook.md`（前置、env、命令、证据路径、已知限制、CI 约定） | 文档 + live 用例仍显式开关 | ✅ |
| T68 | 过期注释/矛盾结论修正 | H1 | `runtime/pcb.mjs` 与设计验证文档的"公开 API 不能新增 PCB 器件"旧结论标【已废弃】并给版本化结论 | 文档/注释 | ✅ |

| T69 | 自动化运行单写锁与幂等 | E7 | 新增 `runtime/automation/run-lock.mjs`（TTL/心跳/陈旧接管/持有者校验）；`/api/automation/run` 支持 runId 幂等重放与 EXECUTION_BUSY 409，失败路径释放锁 | `automation-run-lock.test.mjs` 5/5 | 🟨 进程内完成；跨进程/中止/重启恢复待补 |

| T70 | A10 写铜通道真机打通 | A10 | 修复 `routing/plan` nets 过滤被默认 24 条截断的 bug；真机单网络路由：write 批准 → apply 写 3 段铜 → 独立复核 ok（minGap 6.28≥6/连通）→ 重新 plan 读回 → rollback 删 3 段、residual 0、板子复原 | 证据 `artifacts/a10-routing/real-apply-rollback-WS2812_D1-20261019T120809Z.json` + `routing-plan-filter.test.mjs` 1/1 | ✅ 写通道；前端入口待 E2 |
| T71 | A11 新建覆铜通道 | A11 | 真机定位 `PCB_MathPolygon.createComplexPolygon(flat)` 正确构造；`pcb.pour.create` 支持 outline；新增 `pcb.pours.detail`/`pcb.pour.delete` 桥命令、`POST /api/eda/pcb/pour/create`（write 批准+属性读回+失败回滚+cleanup 自检）、配方 `pcb-create-pour` v1；真机 GND 新建→读回→删除复原（未保存） | `pour-create.test.mjs` 5/5 + 真机 `artifacts/a11-pour/real-machine-pour-create-20261019T120346Z.json` | ✅ 通道；保存/DRC 对比待接 |

| T72 | C1 业务状态服务端落盘 | C1 | 新增 `runtime/project-state.mjs` 原子 store + `GET/PUT /api/project-state`（fail-closed 校验）；前端启动恢复（空状态不覆盖本地）+ 防抖写回；真机写入探针→重启 Runtime→读回仍在→恢复空状态 | `project-state.test.mjs` 3/3、`appReducer.test.ts` 3 例、真机证据 `artifacts/c1-project-state/real-machine-persistence-*.json` | 🟨 主体打通；聊天/执行历史/审计仍内存 |

| T73 | E2 R4/R5/R6 接 UI + 参数解析 | E2 | Placement 真实写回/还原消费服务端 write 批准；新增 `RoutingWritePanel`（规划/预演/批准写入/回滚，未保存显式提示）；自动化中心结构化参数 JSON 解析（`outline`）；测试 `automationParams.test.ts` 4/4 | build 通过、vitest 91/91、typecheck 0 | 🟨 R3 无独立 UI；三链路未跑页面级真机闭环 |

| T74 | A14 仿真证据产品化（真机） | A14 | 新增 `/api/eda/schematic/simulation/run|latest`（真实求解器 + 证据校验/落盘/读回）与证据类型 `spice-simulation`；acceptance 落盘 designChecks 证据；验证页新增"SPICE 仿真证据"面板；真机：探针网表真实跑通、衣橱板 acceptance ready=true、设计检查点 cc-rd 实测 0.417V/5V pass、I2C 上拉不适用，证据落盘且 latest 读回一致 | `simulation-http.test.mjs` 4/4 + 真机证据 `artifacts/a14-simulation/real-machine-acceptance-persisted-20261019T122141Z.json` | ✅ 设计检查点范围；全电路仿真需绑定 SPICE 模型 |

| T75 | A4 引脚证据链（部分闭环） | A4 | `pin-evidence.mjs` 证据表+审计（空/未知网络/重复焊盘/位号覆盖 fail-closed）；`POST /api/eda/pins/evidence`（只读，可选核对原理图并切回）；`/api/design/netlist/ai` 前置门禁（pinEvidence 审计必须过、requirePinEvidence 缺证据 409）；EDA 页生成前采集证据并阻断；验证页新增引脚证据面板 | `pin-evidence.test.mjs` 9/9 + 真机 180 器件/591 焊盘/419 有网/172 未知/11 重复 证据 | 🟨 剩余两阶段自动编排 |

| T76 | B3 供应链摘要进下单卡/闸门 | B3 | `supply-summary.mjs`：已知单价合计（混币不合计）、缺货/库存未知分列、证据 TTL（stale）、缺证据 known:false；order-card 接收 `pricingEvidence` 回填 `supplySummary`；`gateSupply` 新增 `RELEASE_FRESHNESS_STALE`；验证页下单卡展示四项摘要与 finding | `supply-summary.test.mjs` 6/6 + `release-gate.test.mjs` stale 判据 | ✅ 无定时刷新（人工查价） |

| T77 | E3 R9/R10 人工执行器 | E3 | `order-confirmation.mjs` fail-closed 校验（ready 卡/确认人/支付人工声明/价格来源）；证据类型 `order-confirmation` + `POST /api/production/order-confirmation|GET latest`；验证页「人工执行器 R9/R10」面板（R9 DFM 回填状态、R10 参数卡确认、人工支付无入口）；诊断码 | `order-confirmation.test.mjs` 4/4 + 18/18 定向测试 | 🟨 R1–R8 真机全链仍受门禁阻断；R9 需人工在线 DFM |

| T78 | F2 live 证据归档 | F2 | `evidence-archive.mjs`：复制+逐文件 sha256+manifest（缺失来源/重叠目录如实记录）；`scripts/archive-live-evidence.mjs`（0 文件退出码 2）；`e2e/global-teardown.ts` 在 `CP_LIVE_EDA_E2E=1` 时自动归档到 `artifacts/live-evidence/<ts>/`；runbook 补归档说明 | `evidence-archive.test.mjs` 5/5 | ✅ 离线不触发 |

| T79 | E9 GUI 兜底动作目录+探测 | E9 | `gui-capabilities.mjs` 8 条动作（clickText+waitText 断言，绑定配方；在线 DFM/下单导航 blocked=G2 红线）；只读 `findTexts`（read 类白名单，支持 viewport Emulation）；`POST /api/eda/gui/capabilities/probe` 返回 available/complete/missingTexts + 截图（CDP 超时降级 macOS 仅窗口截图）；自动化页两尺寸探测面板 | `gui-capabilities.test.mjs` 5/5、`eda-window-capture.test.mjs` 3/3 + 真机两尺寸证据 | 🟨 未逐条点击验证兜底动作 |

| T80 | E8 半写恢复（真机） | E8 | runner 支持回退 `$result` 引用；`pcb-create-pour` v2 + `existingPourIds` + rollback；桥 `pcb.pour.deleteAdded` 差集删除；`scripts/e8-halfwrite-injection.mjs` 真机注入（读回 3 个覆铜断言失败→回滚→2 个，journal 有 rollback.step） | `automation-halfwrite.test.mjs` 5/5 + `artifacts/e8-halfwrite/e8-halfwrite-2026-10-19T12-48-50-056Z.json` | ✅ 真机闭环 |

| T81 | D4 失败统一入口收尾 + 问题→修复任务 | D4 | EDA 页 15 处 catch 统一走 `fail()`（审计+toast+`reportFailure`）；新增 `src/services/fixTask.ts`（问题→read_only 任务草稿，含 issue 证据/unknowns/risks）；问题中心"建修复任务"一键跳 AI 任务页 | `fixTask.test.ts` 3/3、vitest 94/94 | ✅ 不自动建任务（防轰炸） |

| T82 | B9 缺料替代候选（真机） | B9 | `supply-alternatives.mjs`（真实关键词检索+排序，候选强制 `equivalence:unverified`）；`searchLcscByKeyword`；`POST /api/supply/alternatives`；验证页"查询缺料替代候选"（优先缺货料号，展示型号/封装/价格/库存，不自动替换） | `supply-alternatives.test.mjs` 4/4 + `artifacts/b9-alternatives/b9-alternatives-2026-10-19T12-58-31-817Z.json` | ✅ 真机检索 |

| T83 | A13 ERC 结构化修复建议 | A13 | `repairFor()` 逐条生成 pwr-flag/no-connect/net-flag/manual（autoFixable=false、requiresHumanConfirm、steps、verify、suggestedCommand）；`repairSummary`；验证页展示修复步骤 + "建修复任务"（只读草稿，带 erc id/digest） | `erc.test.mjs` 7/7 + `fixTask.test.ts` 4/4 + 真机 `artifacts/a13-erc/real-machine-erc-repairs-20261019T130258Z.json` | 🟨 EDA 仍只给聚合计数，逐条结论待明细接口/A7 |

| T84 | C4 EDA 指纹/Runtime 版本前端提前失效 | C4 | `AiTask.boundEnv`（批准时绑定指纹+版本）；`CHECK_ENV_DRIFT` reducer + AppContext 监听；`EdaPage.syncPcbContext` 指纹漂移即清空 PCB 批准并提示；后端一次性令牌仍做最后兜底 | `appReducer.test.ts` C4 环境漂移 3 例（vitest 98/98） | ✅ 前端提前标 stale |

| T102 | F7 只读路径耗时基线 | F7 | `scripts/perf-baseline.mjs`：6 个只读端点 × N 次采样 → min/p50/p95/max，落 `artifacts/f7-perf/`；与上一份基线自动对比，p95>2× 且 >50ms 告警（不阻断） | 真机运行报告 `artifacts/f7-perf/perf-2026-10-20T03-32-56-445Z.md`；无运行时→SKIPPED+原因 | 🟨 只读路由基线完成；重模型工程/UI 渲染未测 |

| T118 | F6 runtime 覆盖率地板 | F6 | `scripts/coverage-gate.mjs`：完整 runtime 测试 + Node 内置覆盖率，5 个关键模块 lines/branches/funcs 地板（实测向下取整，只许升），缺失/低于 → exit 1；接入 acceptance `coverage` 必需步 | 实测 5 模块 89–97% 达标；报告 `artifacts/f6-coverage/` | ✅ |
| T119 | H3 打包/sidecar 冒烟 | H3 | `scripts/package-smoke.mjs`：三方版本一致性 + staged sidecar 可执行 + 用 sidecar 启动 runtime 后 health；接入 acceptance `package-smoke` 必需步 | 实测 PASS；报告 `artifacts/h3-package/` | ✅ 冒烟；codesign/notarize/.dmg 属发布流程未做 |
| T120 | H4 长跑内存采样脚本 | H4 | `scripts/long-run-memory.mjs`：隔离 runtime + 周期 RSS/health/只读流量采样，首末/峰值/增长/warnings + 边界声明；`drill:longrun`、acceptance 短窗冒烟 | 15s 短窗 PASS（99.3→92.1MB、16 请求）；`--hours 24` 可复现 | 🟨 24h 真实长跑仍为环境受限项 |
| T121 | A16 工程分析/规则审计纳入放行 | A16 | `runtime/release-gate.mjs` `gateEngineering`：缺省 skipped+info（不阻断不冒充通过）；blocking→ENGINEERING_BLOCKED、warning→ENGINEERING_WARNING、layoutAudit 失败→LAYOUT_RULES_BLOCKED；例外需 code+reason，未使用例外警告；三个放行/导出/归档调用点透传；ValidationPage 随请求提交工程分析 | `release-gate.test.mjs` 14/14；证据 `artifacts/a16-release-gate/` | ✅ 接入；skipped≠PASS，规则覆盖边界见 checklist |
| T122 | B8 不可变发布版本 | B8 | `runtime/release-archive.mjs` + 三条路由：服务端重算 ready 才归档；绑定 planHash/manifestHash/reviewHash/门禁+裁决指纹+证据文件 sha256；`wx` 写入无覆盖、模块无 update/delete；读取重校验；ValidationPage 归档按钮 + VersionsPage 只读列表 | `release-archive.test.mjs` 4/4；证据 `artifacts/b8-release-archive/`（真实 runtime 未 ready→409 被拒绝） | ✅ 归档；无第三方签名/不可防目录级删除 |
| T123 | G4 数据外发清单与脱敏预览 | G4 | `runtime/provider-egress.mjs` + 路由：4 个现有外发点/触发条件/发送字段/明确不发；per-action 同意模式；redactSecrets 预览（Bearer/JWT/sk-/邮箱/路径）且不发送；SettingsPage 面板 | `provider-egress.test.mjs` 4/4；证据 `artifacts/g4-egress/` | ✅ 告知+预览；脱敏非语义审查 |
| T124 | G5 EDA 版本适配诊断 | G5 | `runtime/eda-adaptation.mjs` + `GET /api/eda/version/adaptation`：版本来源如实标注、tested/patch-drift/untested/unknown、eda.api.describe 核对关键图元 API、缺项降级、3 个已知坑+降级路径；EdaPage 告警 | `eda-adaptation.test.mjs` 4/4；证据 `artifacts/g5-adaptation/` | ✅ 诊断；版本号无稳定自动查询命令 |
| T125 | D9 对话框键盘可达性 | D9 | Modal/Drawer 统一焦点：打开移入、Tab/Shift+Tab 循环、Escape 关闭、关闭归还焦点；jsdom 真实 DOM 测试 | `overlays-a11y.test.tsx` 3/3 | 🟨 对话框已做；全站 a11y 审计/对比度/SR 实测未做 |
| T126 | D8 批量落件接入统一长任务 | D8 | `PartProposalPage.applyBatch` 迁到 `createSingleCallTask` + `LongTaskPanel`（取消/超时/重试/分状态措辞）；`schematicComponentBatchApply` 支持 AbortSignal；新增面板交互测试 | `longTaskPanel-interaction.test.tsx` 5/5（vitest 153/153） | 🟨 其它长任务未逐个迁移 |
| T127 | D9 全站静态 a11y 审计 | D9 | `scripts/a11y-audit.mjs` 扫描 30 个 tsx 的确定性启发式问题（按钮名/img alt/可点击 div/input 标签/tabIndex/锚点），报告 JSON+MD，接入 acceptance `a11y-audit` 步 | 实测 violations 0、warnings 86；报告 `artifacts/d9-a11y/` | 🟨 非 WCAG 认证，advisory |
| T128 | F5 长任务面板交互单测 | F5 | jsdom 真实点击 LongTaskPanel：运行中取消、终态重试、超时/取消边界文案；补足 F5 关键交互单测 | 同 T126 测试 5/5 | 🟨 页面级事件单测仍未做 |
| T129 | A4 两阶段计划 + assumption 结构化 | A4 | `netlist-assumptions.mjs`（方向/来源分类+审计，strict 409）；`automation/pin-first-flow.mjs` + 路由（落板→引脚证据→审计→网表，executable/blockers，只出计划）；`/api/design/netlist/ai` 返回 assumptionAudit；验证页「生成两阶段计划」 | `netlist-assumptions.test.mjs` 3/3；runtime 743/743 | ✅ 计划层闭环；执行仍走人工批准 |
| T130 | C1 issues 落 Runtime | C1 | `issue-state.mjs` + `GET/PUT /api/issue-state`（fail-closed 校验/原子写/300 上限如实截断）；AppContext 启动恢复 + 防抖写回；测试 3/3 | runtime **746/746**；issue-state 重启读回/HTTP 400 | ✅ C1 收口 |
| T131 | D8 布线长调用接入统一长任务 | D8 | `RoutingWritePanel` 规划/写入改 `createSingleCallTask` + `LongTaskPanel`（停止等待/超时/失败/重试，写入取消措辞不冒充已终止）；routingPlan/routingApply 支持 AbortSignal | tsc/build/vitest 153/153；面板交互测试复用 longTaskPanel-interaction 5/5 | 🟨 R2 写板/AI 计划/原理图修复等长调用未迁移 |
| T132 | D8 R2 布局写回接入统一长任务 | D8 | `PlacementPage.apply` 改 `createSingleCallTask` + `LongTaskPanel`（确认弹窗后启动/停止等待/超时/重试，每次重签一次性批准）；`applyPlacement` 支持 AbortSignal；证据补丁用真实 approvalId | tsc/build/vitest 153/153 | 🟨 restore/AI 计划/原理图修复等长调用未迁移 |
| T133 | D8 还原/AI 计划接入统一长任务 | D8 | `PlacementPage.restore` 与 `AiTasksPage.generateProductionPlan` 改 `createSingleCallTask` + `LongTaskPanel`（停止等待/超时/失败/重试，AI 计划重试仍替换旧批准）；`generateProductionPlan` 支持 AbortSignal | tsc/build/vitest 153/153 | 🟨 原理图修复/验收/放行门禁仍 busy 布尔 |
| T134 | D8 原理图验收/修复/放行门禁迁移（收口） | D8 | `ValidationPage` 三个长调用改 `createSingleCallTask` + `LongTaskPanel`（停止等待/超时/失败/重试）；三个 client 方法支持 AbortSignal | tsc/build/vitest 153/153 | ✅ D8 长调用迁移完成（每个页面不再裸 await 长任务） |
| T135 | F5 页面级真实点击单测 | F5 | `pages-interaction.test.tsx` 2/2（jsdom+假 fetch，只 mock HTTP）：SettingsPage G4 读取外发清单渲染契约；ValidationPage A4 生成两阶段计划渲染 fail-closed 阻断与阶段表 | vitest 155/155 | 🟨 未逐页覆盖，交互链仍靠 e2e |
| T136 | E10.2 配方参数推断 | E10 | `automation/params-inference.mjs`（证据驱动参数，缺证据 fail-closed 列 missing）；编排节点带 params+paramsInference（not-provided/证据不全阻断）；路由透传 evidence；自动化页新增参数推断列 | `params-inference.test.mjs` 4/4；runtime **750/750** | ✅ 参数推断落地（仍不自动执行/不代批准） |
| T137 | C3 证据↔run 显式关联 | C3 | `timeline-links.mjs` + `POST /api/timeline/link`（append-only JSONL；run/证据不存在 404、重复 409、坏行进 invalid）；时间线按 digest 精确标注 runId+linkedBy；追溯页新增关联入口 | `timeline-links.test.mjs` 3/3；runtime **753/753** | ✅ C3 收口 |
| T139 | C6 真实 GUI 两项目切换验收 | C6 | `e2e/c6-project-switch.spec.ts`：自起真实 Runtime（4178/临时状态）、真实 API 种两项目+两份切面、界面来回「设为当前」、断言工作集不串 + 服务端切面读回不串；接入 acceptance `c6-project-switch` 必需步骤 | spec 1 passed（约 3s）；acceptance 新步骤 PASS | ✅ 真实 GUI 验证（EDA 绑定分支仍限真机） |
| T140 | F7 180 器件 UI 渲染基线 | F7 | `e2e/f7-ui-render.spec.ts`：真实 Runtime 种 180 器件，真实浏览器 3 页面×3 采样中位 + BOM 180 行断言 + 基线 JSON/2× 回归告警；接入 acceptance `f7-ui-render` 必需步骤 | spec 1 passed；UI 中位 8-15ms、行数 180/180；真机 EDA 耗时仍受限 | 🟨 UI 渲染已测（EDA 读取/布局/DRC 未测） |
| T141 | D8 候选提案长调用接入统一控制器 | D8 | `PartProposalPage`「生成候选提案」迁 `createSingleCallTask` + `LongTaskPanel`（180s；取消只停本页、重试重新生成）；`partProposal` 支持 `AbortSignal`；页面交互测试新增第 3 例 | `pages-interaction.test.tsx` 3/3；vitest **156/156**；typecheck 0 | 🟨 已迁移；EDA 页 R1/R2 受控执行仍 busy 布尔 |
| T142 | D8 EDA 页执行/AI 网络表迁移 + 长调用棘轮 | D8 | `EdaPage` R1 AI 网络表（120s+150s）与 R1/R2 受控执行（150s/180s）迁 `createSingleCallTask` + `LongTaskPanel`；四个客户端方法加 `AbortSignal`；新增 `runtime/__tests__/long-call-signal.test.mjs` 棘轮（≥110s 未传 signal 必须在白名单，白名单只减不增） | vitest **156/156**；runtime **754/754**；typecheck/build 0；白名单 11 项如实登记剩余 | 🟨 已迁移主要执行链；D8 仍有明确剩余（见 checklist） |
| T143 | D8 自动化/验证页长调用迁移（白名单缩到 6 项） | D8 | `AutomationPage` GUI 探测（120s×2）+安全重放（600s）、`ValidationPage` ERC（120s）/3D 导出（320s）/发布归档（120s）迁 `createSingleCallTask`+`LongTaskPanel`；五个客户端方法加 `AbortSignal`；棘轮白名单 11→6 | vitest **156/156**；runtime **754/754**；typecheck/build 0 | 🟨 D8 剩余 6 项已登记 |
| T144 | D8 批量落件 dry-run 计划迁移（白名单缩到 5 项） | D8 | `PartProposalPage` 计划（600s）迁 `createSingleCallTask`+`LongTaskPanel`，与写板执行分成两个控制器；`schematicComponentBatchPlan` 加 `AbortSignal`；页面交互测试新增 dry-run 点击例 | vitest **157/157**；runtime **754/754**；typecheck/build 0 | 🟨 D8 剩余 5 项已登记 |
| T145 | D8 需求对话发送迁移（白名单缩到 4 项） | D8 | `AiTasksPage` `sendChat`（150s）迁 `createSingleCallTask`+`LongTaskPanel`，保留消息状态机；新增「停止等待」、超时/取消分措辞、失败按错误码处理；`sendChat` 加 `AbortSignal` | vitest **157/157**；runtime **754/754**；typecheck/build 0 | 🟨 D8 剩余 4 项已登记 |
| T138 | C4 环境漂移触发器核对 | C4 | 核对 `boundEnv` + `CHECK_ENV_DRIFT`（EDA 指纹/运行时版本漂移自动标废）已有实现与测试，文档回填 | `appReducer.test.ts` 覆盖同值/EDA/版本/无 boundEnv | ✅ 文档收口（无代码改动） |

| T117 | E10 目标编排 + 失败恢复决策 | E10 | `orchestration.mjs`：目标→确定性配方序列（4 profile + gate 节点 + 依赖/预算/decisionLog）、失败分类→恢复决策（写失败禁自动重放）；`GET/POST /api/automation/orchestration/*`；自动化中心 E10 面板 | `orchestration.test.mjs` 5/5；真机证据 `artifacts/e10-orchestration/real-plans-20261020.json` | 🟨 计划/决策落地；参教育推断与更多 profile 未做 |

| T116 | E11 写步骤安全审计包 | E11 | `audit-bundle.mjs` 汇总 before/after 截图摘要+读回+批准 id/目标指纹+链校验+warnings；`run.start.approvals` 记录 approvalIds/指纹；`GET /api/automation/runs/:runId/audit-bundle`；自动化中心新增审计包面板 | `audit-bundle.test.mjs` 4/4；真机证据 `artifacts/e11-audit-bundle/`（写 run 缺口如实告警、只读 run 链完整、未知 run 404） | 🟨 审计包落地；独立账号签名/录像仍为边界 |

| T115 | D8 单调用长任务 + 生产导出接入 | D8 | `createSingleCallTask`（可中断、取消/超时措辞纪律）+ `request` 外部 AbortSignal + `productionExport` 可中断；ValidationPage 生产导出迁到 LongTaskPanel（停止等待/重试/状态清楚） | `longTask.test.ts` 10/10；vitest 145；build 通过 | 🟨 导出已接入；批量落件/布线等长调用待逐个迁移 |

| T114 | D5 阶段证据推进收敛 | D5 | `stageEvidence.ts` 统一证据推导 + `applyEvidencePatch`/`tryAdvanceProjectStage`（只允许相邻正向推进）；EdaPage 不再直接写 stage，改记录执行证据后过门禁；PlacementPage R4 写回+复核通过才记录 pcbPlaced 证据 | `stageEvidence.test.ts` 5/5；vitest 141；build 通过 | ✅ 证据推进收敛；ProjectStage 8 阶段类型桥与 R5/R6 是否计入布局完成待产品定义 |

| T113 | D6 信息架构单一事实源 + 新手链路 | D6 | `src/navigation.ts` 统一导航/页面职责/旧 hash 别名/链路数据；Shell/App/AppContext 改为消费它；概览页新增 7 步「从零到交付」面板；`docs/implementation/information-architecture.md` | `navigation.test.ts` 4/4；build + e2e 30/30 | ✅ 收敛落地；新手用户走查待做 |

| T112 | C3 统一证据时间线 | C3 | `runtime/timeline.mjs` 合并执行 journal/批准账本/证据索引，runId 过滤 + 坏行/来源不可用如实暴露 + limit 截断；`GET /api/timeline`；追溯页「系统事件」新增统一时间线面板 | `timeline.test.mjs` 4/4；真机证据 `artifacts/c3-timeline/`（total 869、run333/approval500/evidence36、runId 过滤 allMatch） | 🟨 时间线落地；签核/导出的 runId 强关联与门禁事件归一仍待做 |

| T111 | C6 项目级状态隔离 + EDA 绑定校验 | C6 | Runtime 项目级切片读写（每项目一文件、跨项目实体 400、非法 id 400、未知项目 404）+ `/api/projects` 三组路由 + EDA 窗口↔项目绑定只读校验；前端 AppContext 切面加载/切换落盘 + ProjectsPage 绑定校验面板 | `project-isolation.test.mjs` 3/3；真实运行时 fail-closed 证据 `artifacts/c6-isolation/`；build 通过 | 🟨 隔离+校验落地；真实 GUI 切换点击待验 |

| T110 | A5 真机位号 diff 清零证据 | A5 | 只读 `GET /api/pcb/sync/verify` 真机校验：原理图 180 / PCB 180、matched 180、`unannotated=[]`、ready=true；含 `?` 计划拒绝的模块/HTTP 测试此前已就位 | `artifacts/a5-designators/real-sync-verify-20261020.json` + README | ✅ 真机清零；未来出现 `C?` 仍需批准后标注 |

| T109 | E11/E9 写步骤 before/after 截图证据 | E11/E9 | 修复 evidence 规范化丢失；runner 动作前/验证后双截图、journal 只存 sha256、失败不伪造；截图降级下沉 gui 执行器（CDP 超时→仅 EDA 窗口截图，双失败 `EDA_SCREENSHOT_UNAVAILABLE`） | `automation-evidence-screenshots.test.mjs` 5/5；真机 `eda-screenshot-evidence` before/after sha256 + journal 证据 `artifacts/e11-evidence/` | 🟨 只读配方真机取证完成；写步骤真机截图待批准 |

| T108 | A6/E2 批量落件 UI + 真机 dry-run | A6/E2 | 元件选型页「原理图批量落件（A6/R3）」面板 + `schematicComponentBatchPlan/Apply` 客户端：dry-run 计划 → 签发一次性写板批准 → 执行/续跑；真机 dry-run 证据（planHash c2be7fe0…，create 1）与无批准 409 `AUTOMATION_APPROVAL_REQUIRED` | vitest 132/132（含页面冒烟断言面板在场）；`artifacts/a6-batch/real-batch-dryrun-20261020.json` + README | 🟨 UI+真机 dry-run 完成；整板写入待用户批准 |

| T107 | D8 统一长任务控制器 | D8 | `src/services/longTask.ts`（idle/running/done/failed/timeout/cancelled 状态机，轮询/取消/超时/重试，取消与超时措辞不冒充任务终止）+ `src/components/LongTaskPanel.tsx`；ValidationPage PCB DRC 首个真实接入（替换手写轮询循环，接服务端 cancel） | `longTask.test.ts` 6/6、`longTaskPanel.test.tsx` 3/3；vitest 132/132；build 通过 | 🟨 控制器+DRC 接入完成；布线/导出等未迁移 |

| T106 | F3 真机只读链路矩阵 | F3 | `scripts/live-chain-report.mjs`：R1/R4/R5/R6 只读可执行段 + R2/R3/R6-write/R8 安全边界 SKIPPED（带原因）+ R7 证据缺失 SKIPPED；JSON+MD 报告 `artifacts/f3-live-chain/`；接入 acceptance `--live` 的 `live-chain` 步骤 | 真机报告 `artifacts/f3-live-chain/live-chain-2026-10-20T03-52-00-642Z.md`（R1/R4/R5/R6 PASS：602 pads/1339 lines/153 vias、pours 2、DRC digest f0b1ddb9） | ✅ 只读段可执行；写板/matrix/衣橱仍为人工边界 |

| T105 | E7 重启后中断 run 恢复 | E7 | `runtime/automation/recovery.mjs`（分析终态/写动作/只读判定）+ `GET /api/automation/recovery` + `POST /api/automation/runs/:id/replay`：只读中断 run 安全重放（新 runId + 原 run 追加 `run.recovered`）；写过的 run 409 `AUTOMATION_RECOVERY_NOT_SAFE`；未知配方/坏文件/批准账本分别处理；UI「中断运行恢复」面板 | `automation-recovery.test.mjs` 3/3；真机 `scanned=200 interrupted=0`（`artifacts/e7-recovery/real-recovery-scan-20261020.json`）；runtime 704/704、路由 121 | ✅ E7 收口（跨主机 TTL 边界保留） |

| T104 | E7 长任务中止接口 | E7 | `POST /api/automation/runs/:runId/abort` + AbortController：步骤边界/动作后读回前生效，返回 `aborted` + `mayHaveTakenEffect`，journal 记 `run.abort`，锁 finally 释放；UI 运行中"中止运行"按钮；非执行中 run 409 `AUTOMATION_RUN_NOT_RUNNING` | `automation-abort.test.mjs` 4/4；真机 409 验证；runtime 701/701、路由 119（orphan 0） | ✅ 中止完成；重启自动重放未做 |

| T103 | E4 无人值守故障注入演练 | E4 | `scripts/fault-drill.mjs`（npm run drill:faults，接入 acceptance `fault-drill`）：进程内真实装配运行时 + 注入 EDA 断连/桥接错误/无批准写/伪造批准/追溯存储损坏/未知配方，断言全部 fail-closed；运行时可达时 3 次真机只读 run + journal 链校验。顺带修复 `/api/automation/run` 返回 runId 与 journal runId 不一致（查审计 404）的真实 bug | 演练报告 `artifacts/e4-drill/fault-drill-2026-10-20T03-39-14-377Z.md`；`automation-http.test.mjs` 6/6（含 runId 一致性断言） | ✅（GUI 弹窗/人工超时未注入，真机写板需人工批准） |

| T101 | E7 跨进程文件锁 | E7 | `createRunLock({file})` 文件锁模式：原子创建、pid 存活+心跳 TTL 判陈旧、rename 原子接管并记录 staleTakeover、损坏锁拒绝接管、非持有者不能释放；接入 `/api/automation/run`（锁文件 `artifacts/state/automation-run.lock`） | `automation-run-lock.test.mjs` 9/9、`run-lock-cross-process.test.mjs` 1/1（双实例共享锁文件并发 200/409） | 🟨 跨进程互斥完成；中止接口/重启重放未做 |

| T99 | H5 诊断包（脱敏/有界/可复现） | H5 | `runtime/diagnostic-bundle.mjs` 纯函数 + `GET /api/diagnostics/bundle` + 设置页导出按钮；内容含版本/本机诊断/证据索引摘要/追溯计数/journal 链/最近错误；bundleHash 可复现；缺失段 available:false+reason | `diagnostic-bundle.test.mjs` 5/5、`diagnostic-bundle-http.test.mjs` 1/1、build | ✅ |

| T100 | H6 备份/恢复演练脚本 | H6 | `scripts/backup-restore-drill.mjs`（npm run drill:backup，接入 acceptance 必需步）：真实备份 state/evidence/automation-runs + sha256 manifest → 临时目录恢复 → 用运行时加载器验证 trace/证据/journal 可继续；实测 561 文件恢复一致、journal 链 ok | 演练报告 `artifacts/h6-backup/backup-restore-2026-10-20T03-29-50-578Z.md`、acceptance `backup-drill` | ✅ |

| T95 | A1 需求硬约束 UI 接线 | A1 | 验证页折叠面板把 `state.requirements` 自动带进 `releaseGate`/`productionExport`，并录入 6 项设计事实（空值不写字段 = unknown 阻断）；闸门结果逐条展示 pass/fail/unknown/unclassified；`buildDesignFacts` 抽服务 + 3/3 单测；`/api/production/export` 也透传 constraints/designFacts（此前漏传，两条路结论可能不同） | `designFacts.test.ts` 3/3、`constraints.test.mjs` 4/4、build | 🟨 事实仍人工录入（EDA 自动采集未接）、e2e 未加 |

| T96 | A2 回退检索产品化 | A2 | `searchLibraryWithFallback`/`probeSelectionFallback` 抽出；只读路由 `POST /api/eda/library/search/fallback`；验证页面板展示命中来源与每次尝试；真机检索历史样本 4 条（命中 4、回退命中 1、无结果 0） | `a2-fallback-http.test.mjs` 2/2、真机证据 `artifacts/a2-selection/` | ✅ |

| T97 | A9 布局规则审计 UI + 真机门禁 | A9 | 布局页展示硬门禁/证据缺口/警告/复查/通过/审计哈希；真机只读审计 180 器件、阻断 0、证据缺口 1、releaseReady=false；真机故意出框计划写回被 409 `PLACEMENT_RULES_BLOCKED` 拒（写入前） | `placement-rules.test.mjs` 3/3、真机证据 `artifacts/a9-placement/` | ✅（courtyard 证据缺口为库侧边界） |

| T98 | A10 多网络真机门禁证据 | A10 | 真机对 2 网络规划成功（5 段+1 过孔）但独立复核 4 条盘中孔违规 → apply 400 `ROUTING_PLAN_REJECTED` 拒写；快照铜计数变化如实记录为非本轮写入、未保存；整板布线受盘中孔工艺缺口阻断 | 真机证据 `artifacts/a10-routing/README-20261020.md` | 🟨 多网络门禁成立；整板布线需人工工艺决策 |

| T91 | C1 前端追溯三件套落 Runtime | C1 | 新增 `runtime/trace-state.mjs`（原子写 + fail-closed：形状/id 重复 → `TRACE_STATE_INVALID`；上限 versions 500/changes 2000/audit 2000 并回报截断）+ `GET/PUT /api/trace-state`；`AppContext` 启动从 Runtime 恢复（服务端空不覆盖本地）、变化防抖 1s 写回；`HYDRATE_TRACE_STATE` reducer | `trace-state.test.mjs` 4/4、`trace-state-http.test.mjs` 2/2、`appReducer.test.ts` 28/28 | 🟨 issues 仍未落盘；聊天线程 ephemeral（transcript 可重建） |

| T92 | H4 长期运行内存上限 | H4 | ProductionManager 终审记录上限 200（`maxStoredReviews`，淘汰最旧）；ChatManager 线程映射 LRU 50（淘汰只丢映射、transcript 保留）、transcript 会话表按 updatedAt 上限 50、单会话消息 200 | `memory-bounds.test.mjs` 3/3 | 🟨 机制完成；24h 真机长跑未执行（不宣布通过） |

| T93 | G3 无自由 computer-use 回归 | G3 | `/api/eda/gui/execute` 的 `eval` 默认 403 `GUI_EVAL_DISABLED`（仅 `CIRCUITPILOT_ALLOW_GUI_EVAL=1` 诊断开）；未知动作白名单拒绝；`EdaGuiError.detail` 同时暴露 `details` 便于 HTTP 信封看到允许清单；无令牌 401 | `g3-computer-use.test.mjs` 3/3、`eda-gui.test.mjs` 18/18 | ✅ 攻击性用例被拒 |

| T94 | H2 实现文档索引 | H2 | 新增 `docs/implementation/README.md`（checklist→task-plan→automation-kernel 阅读顺序；按角色路径；一键验收入口；文档约定），根 README 项目结构链接该索引 | 文档走查：3 份必读 + 5 条角色路径 + 2 条命令入口 | ✅ |

| T86 | B1/B4 正式导出绑定物料清单 | B1/B4 | 新增 `runtime/release-binding.mjs`（`verifyExportManifestBinding`：final 有签核却缺 manifestHash → `RELEASE_MANIFEST_BINDING_REQUIRED`；提供了但与当前产物重算不一致 → `RELEASE_MANIFEST_MISMATCH`；只有一致才进 `buildReleaseDecision` 的 `manifestHash` binding）；`/api/production/export` 用 readiness 同 binding 重算 manifest 后裁决，响应附 `manifestBinding`（provided/recomputed/signoff 三值对照）；`AssetsPage` readiness 后把 `{manifestHash,binding}` 交接给 `ValidationPage`（sessionStorage），签核表单预填、正式导出自动携带 | `release-binding.test.mjs` 4/4 + `multilayer-http.test.mjs` B1/B4 三态 HTTP 用例（均 0 写盘） | ✅ 堵住"旧签核复用"；服务端重算为唯一可信值 |

| T87 | C5 证据索引/保留计划 | C5 | 新增 `runtime/evidence-index.mjs`（索引 entries/invalid/duplicates/errors/complete；坏文件不隐藏；`findEvidence`；`planEvidenceRetention` dry-run 无删除能力）；接线 `GET /api/evidence/index`、`GET /api/evidence/find`、`POST /api/evidence/retention/plan`；追溯页「系统事件」读索引/按 digest 查找/生成保留计划 | `evidence-index.test.mjs` 7/7 + 真实数据冒烟（34 条/74MB/149ms/complete=true）+ route-contract orphan 0 | ✅ 索引与计划；apply 未暴露 HTTP |

| T88 | C8 日志/诊断统一脱敏 | C8 | 新增 `runtime/log-redaction.mjs`（敏感键整值替换、Bearer/JWT/sk-/URL token/邮箱/本机路径擦除、循环引用/超深/超长安全降级、异常类型不崩、可 JSON.stringify）；`runtime/logger.mjs` 的 `redact` 委托该模块（保留兼容导出） | `log-redaction.test.mjs` 6/6、`logger.test.mjs` 通过 | ✅ 日志单一脱敏入口 |

| T89 | B10 制造物保留策略 | B10 | 新增 `runtime/artifact-retention.mjs`（evaluate/plan/apply；policy kind 白名单+maxAgeDays+maxTotalBytes；未知时间/未来/未知大小/非白名单 kind 一律保留；缺 policy=关闭保留；apply 默认 dry-run、需显式 false+注入 remove、单点失败如实进 failed）；接线 `POST /api/artifacts/retention/plan`（只扫 deliverables/release/manufacturing 白名单目录，仅计划）；追溯页 dry-run 摘要按钮 | `artifact-retention.test.mjs` 8/8 + 真实目录冒烟 | ✅ 不提供联网删除入口 |

| T90 | D5 阶段机与进度 | D5 | 新增 `src/services/stageMachine.ts`（8 阶段 canonical、相邻正向推进、六项证据门禁、false/undefined 视为缺失、中文阻断 reasons）；`ProjectStage` 扩为 8 阶段并同步 Overview/Execution 的 stageOrder；旧记录 `'PCB布局'→'PCB'` 映射；`ProjectsPage` 新增"推进阶段"（抽屉阶段链+证据预检，缺证据只提示不 dispatch） | `stageMachine.test.ts` 16/16、vitest 118/118、build 0 | ✅ 前端阶段机；pcbPlaced/official DRC 刻意 fail-closed 待 Runtime 证据回写 |

| T85 | D7 EDA 文档绑定按项目收敛 | D7 | 新增 `edaWorkspaceStore.ts`（按项目持久化、UUID 校验、非法即清旧值、优先级解析）；EDA 页去掉硬编码错板 UUID，输入/新建/绑定均写回；项目删除清绑定；真实证据仍由运行时 `targetFingerprint` 决定 | `edaWorkspaceStore.test.ts` 4/4（vitest 102/102） | ✅ |

### 第 23 轮验证结果（截至本节写入）

| ID | 命令/操作 | 结果 |
|---|---|---|
| V60 | `npm run test:runtime` | **585/585** pass（较上轮 554 增 31 条：A1 4 + A5 4 + A6 8 + A9 3 + E6 4 + 其它） |
| V62 | `npm run test:runtime`（E7 后） | 590/590 pass（再 +5：run-lock 单元/HTTP） |
| V63 | 第 23 轮真机（A10/A11） | A10：写 3 段铜→复核 ok→读回→回滚 removed 3/residual 0、板子复原；A11：新建 GND 覆铜→读回匹配→cleanup 删除、数量 2→2、未保存 |
| V64 | 第 23 轮（C1/A10/A11 后） | typecheck 0、vitest 87/87、runtime 599/599、build 通过、contract 3/3；C1 真机重启持久化通过 |
| V65 | 第 23 轮（E2 UI 后） | typecheck 0、vitest 91/91、build 通过；R4/R5/R6 UI 入口接入，参数 JSON 解析 4/4 |
| V66 | 第 23 轮最终验证（G1 后） | `npm run acceptance` PASS：typecheck 0、vitest 91/91、runtime 599/599、build 通过、contract 3/3、e2e-app 30/30；真机/写入项按显式开关 SKIP（不伪装通过）。报告 `artifacts/acceptance/acceptance-2026-10-19T12-16-03-415Z.md` |
| V67 | 第 23 轮（A14 后） | typecheck 0、vitest 91/91、runtime 603/603（+4 仿真 HTTP）；真机 ngspice-46 设计检查点仿真证据落盘/读回 |
| V68 | 第 23 轮（A14 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 91/91、runtime 603/603、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-19T12-22-50-330Z.md` |
| V69 | 第 23 轮（A4 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 91/91、runtime 612/612（+9 引脚证据/门禁）、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-19T12-27-54-631Z.md` |
| V70 | 第 23 轮（B3 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 91/91、runtime 618/618（+6 供应链摘要）、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-19T12-31-23-446Z.md` |
| V71 | 第 23 轮（E3 R9/R10 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 91/91、runtime 622/622（+4 下单确认）、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-19T12-34-26-096Z.md` |
| V72 | 第 23 轮（F2 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 91/91、runtime 627/627（+5 证据归档）、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-19T12-37-00-912Z.md`；`archive:live-evidence` 冒烟归档 1 文件/manifest hash 可复核 |
| V73 | 第 23 轮（E9 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 91/91、runtime 635/635（+8 GUI 能力/窗口截图）、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-19T12-44-39-248Z.md`；真机两尺寸探测证据 `artifacts/e9-gui/real-machine-gui-capabilities-20261019T124333Z.json` |
| V74 | 第 23 轮（E8 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 91/91、runtime 640/640（+5 半写回滚、bridge 夹具修正）、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-19T12-51-23-528Z.md`；真机半写注入证据 `artifacts/e8-halfwrite/e8-halfwrite-2026-10-19T12-48-50-056Z.json` |
| V75 | 第 23 轮（D4 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 94/94（+3 问题→修复任务）、runtime 640/640、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-19T12-54-09-701Z.md` |
| V76 | 第 23 轮（B9 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 94/94、runtime 644/644（+4 替代候选）、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-19T12-58-46-696Z.md`；真机检索证据 `artifacts/b9-alternatives/b9-alternatives-2026-10-19T12-58-31-817Z.json` |
| V77 | 第 23 轮（A13 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 95/95、runtime 646/646（+2 ERC 建议、+1 fixTask）、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-19T13-03-08-280Z.md`；真机 ERC 证据 `artifacts/a13-erc/real-machine-erc-repairs-20261019T130258Z.json` |
| V78 | 第 24 轮（C4 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 98/98（+3 C4 环境漂移）、runtime 646/646、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T02-01-44-761Z.md` |
| V79 | 第 24 轮（D7 后最终） | `npm run acceptance` PASS：typecheck 0、vitest 102/102（+4 D7 绑定）、runtime 646/646、build 通过、contract 3/3、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T02-38-33-537Z.md` |
| V100 | 第 45 轮（F6 覆盖率地板 + H3 打包冒烟 + H4 长跑采样后最终） | `npm run acceptance` PASS：typecheck 0、vitest **145/145**、runtime **725/725**、coverage 5 模块达标、build、contract 3/3、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T04-46-32-592Z.md`；证据 `artifacts/f6-coverage/`、`artifacts/h3-package/`、`artifacts/h4-longrun/` |
| V101 | 第 46 轮（A16/B8/G4/G5/D9 后最终） | `npm run acceptance` PASS：typecheck 0、vitest **148/148**、runtime **740/740**、coverage 5 模块达标、build、contract 3/3、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T05-02-18-330Z.md`；证据 `artifacts/a16-release-gate/`、`artifacts/b8-release-archive/`、`artifacts/g4-egress/`、`artifacts/g5-adaptation/`；首次 acceptance 出现 1 例 runtime 偶发失败、重跑通过（未定位固定用例，不伪装为已消除） |
| V102 | 第 47 轮（D8 批量落件长任务 + D9 静态审计 + F5 交互单测后最终） | `npm run acceptance` PASS：typecheck 0、vitest **153/153**、runtime **740/740**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、a11y-audit PASS（D9 静态 0 violations/86 warnings）、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-07-04-755Z.md`；证据 `artifacts/d9-a11y/` |
| V103 | 第 48 轮（A4 两阶段计划 + assumption 结构化后最终） | `npm run acceptance` PASS：typecheck 0、vitest **153/153**、runtime **743/743**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、a11y-audit PASS、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-10-43-391Z.md`；证据 `netlist-assumptions.test.mjs` 3/3 + 验证页 A4 两阶段计划面板 |
| V104 | 第 49 轮（C1 issues 落 Runtime 后最终） | `npm run acceptance` PASS：typecheck 0、vitest **153/153**、runtime **746/746**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、a11y-audit PASS、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-14-49-800Z.md`；证据 `issue-state.test.mjs` 3/3 |
| V105 | 第 50 轮（D8 布线长任务迁移后最终） | `npm run acceptance` PASS：typecheck 0、vitest **153/153**、runtime **746/746**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、a11y-audit PASS、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-17-54-490Z.md` |
| V106 | 第 51 轮（D8 R2 写回长任务迁移后最终） | `npm run acceptance` PASS：typecheck 0、vitest **153/153**、runtime **746/746**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、a11y-audit PASS、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-20-17-850Z.md` |
| V107 | 第 52 轮（D8 还原/AI 计划长任务迁移后最终） | `npm run acceptance` PASS：typecheck 0、vitest **153/153**、runtime **746/746**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、a11y-audit PASS、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-22-40-083Z.md` |
| V108 | 第 53 轮（D8 长调用迁移收口后最终） | `npm run acceptance` PASS：typecheck 0、vitest **153/153**、runtime **746/746**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、a11y-audit PASS、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-25-24-195Z.md` |
| V109 | 第 54 轮（F5 页面交互单测后最终） | `npm run acceptance` PASS：typecheck 0、vitest **155/155**、runtime **746/746**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、a11y-audit PASS、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-28-05-124Z.md` |
| V110 | 第 55 轮（E10.2 参数推断后最终） | `npm run acceptance` PASS：typecheck 0、vitest **155/155**、runtime **750/750**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、a11y-audit PASS、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-32-03-427Z.md` |
| V111 | 第 56 轮（C3 关联 + C4 核对后最终） | `npm run acceptance` PASS：typecheck 0、vitest **155/155**、runtime **753/753**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、a11y-audit PASS、fault-drill PASS、backup-drill PASS、package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-36-19-925Z.md` |
| V112 | 第 57 轮（C6 真实 GUI 切换后最终） | `npm run acceptance` PASS：typecheck 0、vitest **155/155**、runtime **753/753**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、**c6-project-switch 1/1（真实 Runtime+真实 GUI）**、a11y-audit PASS、fault-drill/backup-drill/package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-44-10-600Z.md`。首次运行 runtime 出现一次 752/753 偶发（重跑 3 次均 753/753，验收复跑全绿），如实记录一次。 |
| V113 | 第 58 轮（F7 UI 渲染基线后最终） | `npm run acceptance` PASS：typecheck 0、vitest **155/155**、runtime **753/753**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、c6-project-switch 1/1、**f7-ui-render 1/1（180 器件真实前端渲染）**、a11y-audit/fault-drill/backup-drill/package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-47-29-257Z.md` |
| V114 | 第 59 轮（D8 候选提案长任务后最终） | `npm run acceptance` PASS：typecheck 0、vitest **156/156**、runtime **753/753**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、c6-project-switch 1/1、f7-ui-render 1/1、a11y-audit/fault-drill/backup-drill/package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-52-26-559Z.md` |
| V115 | 第 60 轮（EDA 执行迁移 + 长调用棘轮后最终） | `npm run acceptance` PASS：typecheck 0、vitest **156/156**、runtime **754/754**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、c6-project-switch 1/1、f7-ui-render 1/1、a11y-audit/fault-drill/backup-drill/package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T05-59-18-433Z.md` |
| V116 | 第 61 轮（自动化/验证长调用迁移后最终） | `npm run acceptance` PASS：typecheck 0、vitest **156/156**、runtime **754/754**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、c6-project-switch 1/1、f7-ui-render 1/1、a11y-audit/fault-drill/backup-drill/package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T06-03-41-257Z.md` |
| V117 | 第 62 轮（批量落件 dry-run 迁移后最终） | `npm run acceptance` PASS：typecheck 0、vitest **157/157**、runtime **754/754**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、c6-project-switch 1/1、f7-ui-render 1/1、a11y-audit/fault-drill/backup-drill/package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T06-09-16-256Z.md`。**注**：首次验收 coverage 步骤 FAIL，单独重跑 `scripts/coverage-gate.mjs` 通过、随后整轮 acceptance 复跑通过——按覆盖率抽检波动如实披露，未改地板。 |
| V118 | 第 63 轮（需求对话迁移后最终） | `npm run acceptance` PASS：typecheck 0、vitest **157/157**、runtime **754/754**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、c6-project-switch 1/1、f7-ui-render 1/1、a11y-audit/fault-drill/backup-drill/package-smoke PASS、long-run-smoke（15s 短窗）PASS；报告 `artifacts/acceptance/acceptance-2026-10-20T06-11-49-093Z.md` |
| V119 | 第 64 轮（收官最终） | `npm test` + `npm run acceptance` 全绿：typecheck 0、vitest **157/157**、runtime **759/759**、coverage 5 模块达标、build、contract 3/3、e2e-app 30/30、c6-project-switch 1/1、f7-ui-render 1/1、a11y-audit/fault-drill/backup-drill/package-smoke/long-run-smoke PASS；5 项真机/环境受限步骤 SKIPPED 且写明原因；报告 `artifacts/acceptance/acceptance-2026-10-20T06-14-27-690Z.md`；checklist 新增「收官核对」：真机受限项边界+恢复方案、诚实残余（C1 versions/changes/audit 前端副本、B7 订单卡汇总、D8 3 项 legacy/abort 例外） |
| V120 | 第 65 轮（用户要求全面检查） | `npm test` + `npm run acceptance` PASS（vitest **157/157**、runtime **759/759**、报告 `artifacts/acceptance/acceptance-2026-10-20T06-44-54-645Z.md`）；复查发现并修复 runtime 测试偶发 401 flake（`multilayer-http` devices/search 依赖 health.sessionProof → 改注入本实例 token；单文件 10/10、全量 3×759/759）；a11y warnings 实测 87/31 tsx（启发式，0 violations）；4179 真实 Runtime 健康、layers 路由正常（旧 404 系过期进程） |

| V99 | 第 44 轮（E10 目标编排 + 失败恢复决策后最终） | `npm run acceptance` PASS：typecheck 0、vitest **145/145**、runtime **725/725**（+5 E10）、build、contract 3/3、fault-drill PASS、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T04-42-07-432Z.md`；真机证据 `artifacts/e10-orchestration/` |

| V98 | 第 43 轮（E11 写步骤安全审计包后最终） | `npm run acceptance` PASS：typecheck 0、vitest **145/145**、runtime **720/720**（+4 E11）、build、contract 3/3、fault-drill PASS、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T04-38-07-745Z.md`；真机证据 `artifacts/e11-audit-bundle/` |

| V97 | 第 42 轮（D8 单调用长任务 + 生产导出接入后最终） | `npm run acceptance` PASS：typecheck 0、vitest **145/145**（+4 D8）、runtime **716/716**、build、contract 3/3、fault-drill PASS、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T04-34-02-022Z.md` |

| V96 | 第 41 轮（D5 阶段证据推进收敛后最终） | `npm run acceptance` PASS：typecheck 0、vitest **141/141**（+5 D5）、runtime **716/716**、build、contract 3/3、fault-drill PASS、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T04-30-44-663Z.md` |

| V95 | 第 40 轮（D6 信息架构单一事实源后最终） | `npm run acceptance` PASS：typecheck 0、vitest **136/136**（+4 D6）、runtime **716/716**、build、contract 3/3、fault-drill PASS、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T04-26-38-651Z.md` |

| V94 | 第 39 轮（C3 统一证据时间线后最终） | `npm run acceptance` PASS：typecheck 0、vitest **132/132**、runtime **716/716**（+4 C3）、build、contract 3/3、fault-drill PASS、backup-drill PASS、e2e-app 30/30（修正系统事件 e2e 的 strict locator）；报告 `artifacts/acceptance/acceptance-2026-10-20T04-22-53-875Z.md`；真机时间线证据 `artifacts/c3-timeline/` |

| V93 | 第 38 轮（C6 项目级隔离+绑定校验后最终） | `npm run acceptance` PASS：typecheck 0、vitest **132/132**、runtime **712/712**（+3 C6）、build、contract 3/3（121 路由 / orphan 0）、fault-drill PASS、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T04-16-49-212Z.md`；真实运行时 fail-closed 证据 `artifacts/c6-isolation/` |

| V92 | 第 37 轮（A5 真机位号清零证据后最终） | `npm run acceptance` PASS：typecheck 0、vitest **132/132**、runtime **709/709**、build、contract 3/3（121 路由 / orphan 0）、fault-drill PASS、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T04-10-24-279Z.md`；A5 真机证据 `artifacts/a5-designators/` |

| V91 | 第 36 轮（E11 写步骤 before/after 截图证据后最终） | `npm run acceptance` PASS：typecheck 0、vitest **132/132**、runtime **709/709**（+5 E11/E9 截图证据）、build、contract 3/3（121 路由 / orphan 0）、fault-drill PASS、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T04-08-50-860Z.md`；真机截图证据 `artifacts/e11-evidence/` |

| V90 | 第 35 轮（A6/E2 批量落件 UI 后最终） | `npm run acceptance` PASS：typecheck 0、vitest **132/132**、runtime **704/704**、build、contract 3/3（121 路由 / orphan 0）、fault-drill PASS、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T04-00-31-016Z.md`；A6 真机 dry-run 证据 `artifacts/a6-batch/` |

| V89 | 第 34 轮（D8 统一长任务控制器后最终） | `npm run acceptance` PASS：typecheck 0、vitest **132/132**（+9 D8）、runtime **704/704**、build、contract 3/3（121 路由 / orphan 0）、fault-drill PASS、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T03-55-55-464Z.md` |

| V88 | 第 33 轮（F3 真机只读链路矩阵后最终） | `npm run acceptance` PASS：typecheck 0、vitest **123/123**、runtime **704/704**、build、contract 3/3（121 路由 / orphan 0）、fault-drill PASS、backup-drill PASS、e2e-app 30/30；新增 `live-chain` 步骤（`--live` 执行，离线 SKIP 带原因）；报告 `artifacts/acceptance/acceptance-2026-10-20T03-52-21-424Z.md`；真机只读矩阵证据 `artifacts/f3-live-chain/live-chain-2026-10-20T03-52-00-642Z.md` |

| V87 | 第 32 轮（E7 重启恢复后最终） | `npm run acceptance` PASS：typecheck 0、vitest **123/123**、runtime **704/704**、build、contract 3/3（**121 路由** / orphan 0）、fault-drill PASS、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T03-50-31-915Z.md` |

| V86 | 第 31 轮（E7 中止接口后最终） | `npm run acceptance` PASS：typecheck 0、vitest **123/123**、runtime **701/701**、build、contract 3/3（**119 路由** / orphan 0）、fault-drill PASS（固定注入令牌，消除 401 噪声）、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T03-46-21-532Z.md` |

| V85 | 第 30 轮（E4 故障注入演练后最终） | `npm run acceptance` PASS：typecheck 0、vitest **123/123**、runtime **697/697**、build、contract 3/3（118 路由 / orphan 0）、**fault-drill PASS**（6 类故障全部 fail-closed + 3 次真机只读 completed）、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T03-42-20-627Z.md` |

| V84 | 第 29 轮（E7 跨进程锁 + F7 基线后最终） | `npm run acceptance` PASS：typecheck 0、vitest **123/123**、runtime **697/697**（+4 文件锁 +1 跨进程 +HTTP 隔离）、build、contract 3/3（118 路由 / orphan 0）、backup-drill PASS、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T03-36-51-631Z.md` |

| V83 | 第 28 轮（H5/H6 后最终） | `npm run acceptance` PASS：typecheck 0、vitest **123/123**、runtime **692/692**（+6 H5 诊断包）、build、contract 3/3（118 路由 / orphan 0）、**backup-drill PASS**、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T03-30-37-934Z.md` |

| V82 | 第 27 轮（A1/A2/A9/A10 后最终） | `npm run acceptance` PASS：typecheck 0、vitest **123/123**（+3 designFacts）、runtime **686/686**（+2 A2 回退 HTTP）、build 通过、contract 3/3（117 路由 / orphan 0）、e2e-app 30/30；真机证据：A2 回退检索 4 条、A9 布局审计+出框拒写、A10 多网络拒写；报告 `artifacts/acceptance/acceptance-2026-10-20T03-26-49-128Z.md` |

| V81 | 第 26 轮（C1/H4/G3/H2 后最终） | `npm run acceptance` PASS：typecheck 0、vitest **120/120**（+2 C1 追溯 hydrate）、runtime **684/684**（+4 trace-state、+2 trace HTTP、+3 memory-bounds、+3 G3）、build 通过、contract 3/3（116 路由 / orphan 0）、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T03-19-52-345Z.md` |
| V80 | 第 25 轮（B1/B4/C5/C8/B10/D5 后最终） | `npm run acceptance` PASS：typecheck 0、vitest **118/118**（+16 D5 阶段机）、runtime **672/672**（+4 release-binding、+7 evidence-index、+6 log-redaction、+8 artifact-retention、+1 B1/B4 HTTP）、build 通过、contract 3/3（orphan 0）、e2e-app 30/30；报告 `artifacts/acceptance/acceptance-2026-10-20T03-14-47-595Z.md` |
| V61 | 分项 | diagnosis 5/5、safety 4/4、selection 3/3、schematic-batch 6/6 + HTTP 2/2、designator 4/4、constraints 4/4、placement-rules 3/3、recipe-versioning 4/4、bridge 33/33、route-contract 3/3（98+ 路由 / orphan 0） |

**本轮诚实边界**：A5/A6 的写通道只做了离线假桥/HTTP 验证，真机标注清零与整板批量落件尚未执行（需本机 EDA 会话 + 逐件写状态）；A9 只把"量到违规"作为写回阻断，缺 courtyard/3D 证据的规则保持 REVIEW+证据缺口，不宣布 releaseReady；E6 只是机制（alternatives/诊断/版本记录），EDA 3.2.186 实际可用菜单文案仍需真机截图确认后回填；A1 的 UI 自动带上 requirements 与设计事实录入仍未接。

| T146 | D8 收口：布线回滚迁移 + 白名单 3 项登记 | D8 | `RoutingWritePanel` 回滚（120s）迁 `createSingleCallTask`+`LongTaskPanel`；`routingRollback` 加 `AbortSignal`；棘轮白名单 4→3（legacy 无 UI ×2 + 服务端 abort ×1） | vitest **157/157**；runtime **759/759**；typecheck/build 0 | ✅ D8 收口（无未迁移的 UI 长调用） |
