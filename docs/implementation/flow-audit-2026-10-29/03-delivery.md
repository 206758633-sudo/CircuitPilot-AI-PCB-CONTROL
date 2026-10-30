# 03 交付链复审：验证取证 → 放行裁决 → readiness → 导出/签核/归档

> **修复收口（2026-10-29 晚）**：本文件是复审当时的证据与问题清单；所列 P0/P1 已在本轮"请全部修复"中逐项落地，当前状态以 `../flow-gap-audit-2026-10-29.md` §0.1 为准。下文保留原始判定以说明修复对象，不代表仍未解决。


- 审计对象：当前工作区（2026-10-29 11:00–11:25，Asia/Shanghai），**不引用上一轮审计结论，全部现场重读代码 + 隔离测试**
- 审计范围：ERC/DRC 取证 → 官方验证投影 → 问题中心/概览/阶段机 → 放行闸门与统一 `releaseDecision` → 六道门 G1~G6 → 生产 readiness → 正式导出/归档/签核（含订单参数卡边界）
- 边界：只读 + 隔离目录单文件测试；**未启动/重启服务、未跑真机 EDA、未跑 Playwright/live e2e**。凡依赖 EDA 真机才能证实的条目，本报告标注"未真机复验"。

**一句话结论**：P0-3/P0-5/P0-6/P0-7 的**规则层修复基本落地且被隔离测试证实**（28 条 runtime 测试 + 29 条前端测试全绿），但交付链仍有 **1 个 P0（签核锚点≠实际交付物）与 8 个 P1（历史签核遮蔽、B8 归档不可达、首件产物无产品入口、三处裁决 binding 不一致、官方验证不持久化、Demo 覆盖官方结论、项目域仅前端标签、"六道门"G2–G4 无产品内生产者）**，因此"验证→放行→导出/归档"整链**尚未打通**。

---

## ① 流程节点判定表

判定：✅ 已打通（UI→API→runtime 有证据/测试）｜🟨 半打通（口径或入口缺失）｜🟥 未打通/断链｜⬜ 未验证（需 EDA 真机）｜🚫 产品边界（不算缺陷）

| # | 节点 | 判定 | 现场证据（file:line） | 说明 |
|---|---|---|---|---|
| 1 | 官方 ERC 取证落盘（只读） | ✅ | `runtime/server.mjs:2868-2877`；`src/pages/ValidationPage.tsx:584-611` | 原生报告 + 明细/聚合标注 + digest 落盘 |
| 2 | 官方 DRC 取证落盘（后台 job/全量条目） | ✅ | `runtime/server.mjs:2781-2812`；`ValidationPage.tsx:430-444` | 落盘全量报告，截断仅发生在传输层（500 条） |
| 3 | 官方结论 → 项目域验证记录（`source:'official'`+`projectId`+`evidence`） | ✅ | `src/services/validationEvidence.ts:69-88`；`ValidationPage.tsx:447-458,593-603` | 唯一写入点，无其它页面伪造 official |
| 4 | KPI（覆盖/通过/未运行）只认官方 | ✅ | `validationEvidence.ts:49-66`；`src/pages/OverviewPage.tsx:26-30,147-148`；`validationEvidence.test.ts` | 全新安装 0/2、0%，不再"已验证 75%" |
| 5 | Demo/seed 不进 KPI（主口径） | ✅ | `validationEvidence.ts:54,64`；`OverviewPage.tsx:26-30` | `demoOrSeed` 仅展示、不进 coverage |
| 6 | Demo/seed 不进角标/导航/快照 | 🟨 | `src/pages/DeliverPage.tsx:21,32`；`src/components/Shell.tsx:104`；`src/pages/VersionsPage.tsx:182` | 页签角标=`validations.length`=8，右侧却写"没有未收口"；导航红点用 seed findings |
| 7 | Demo 运行不污染官方结论 | 🟥 | `ValidationPage.tsx:339-347`（runAll）、`:2246`（单条重跑） | 全量/单条 Demo 会把 official 行一并重算并改写 `source:'demo'` |
| 8 | 验证结果持久化 / 重启恢复 | 🟥 | `src/state/AppContext.tsx:352-420,474`（载荷无 validations）；`runtimeClient.ts` 无 validation 路由 | 只活在前端内存；刷新后 KPI 归零，阶段证据无法复核 |
| 9 | 官方结论绑定"哪块板/哪份计划" | 🟨 | `ValidationPage.tsx:448-452,593-600`（无 `edaWorkspace` 校验）；`server.mjs:2868-2872`（fingerprint.projectUuid 未回传） | 仅按 UI 选择器的 `activeProject.id` 打标签，多项目/多板会串 |
| 10 | 验证 findings → 问题中心 | ✅ | `ValidationPage.tsx:306-317`（`reportIssue` 逐条） | 与 issue 落库链路已有（P1-2 的 DRC 进问题中心已补） |
| 11 | 概览 KPI / 阶段进度不再依赖 `task.status` | ✅ | `OverviewPage.tsx:26-38`；`src/services/stageEvidence.ts:20-56` | 阶段"验证交付"meta 用官方 ran/missing |
| 12 | 阶段推进证据（`验证→生产` 需官方 DRC pass） | ✅ | `stageEvidence.ts:52-53`；`src/services/stageMachine.ts:97-106`；`ValidationPage.tsx:323-336` | 证据驱动成立，但受 #8 影响，重启后不可复核 |
| 13 | 放行闸门 → 统一 `releaseDecision` | ✅ | `server.mjs:1848-1853`；`runtime/release-decision.mjs:78-130` | 本地门禁+人工 DFM/签核合成一个答案，`orderEnabled:false` 恒定 |
| 14 | 交付签核唯一入链（`signoff-record`） | ✅ | `server.mjs:2925-2952`（`kind:'signoff-record'`+manifestHash 必填）；`:2933-2946` 入账本 | 服务端落盘，客户端不可伪造 |
| 15 | 门禁报告与交付签核隔离（新写入） | ✅ | `runtime/gates-service.mjs:44-48,60-71`（`gate-report`/`gate-signoff`）；`server.mjs:580-584` | 新数据不再互相写同一 kind |
| 16 | 门禁报告与交付签核隔离（**历史文件**） | 🟨 | `server.mjs:580-584`（只查最新一条）；`runtime/evidence-store.mjs:123-126` | 旧 gate-report/旧 W5 signoff-record 仍遮蔽更早的有效签核（§2.2 实测） |
| 17 | G1/G5/G6 "未实现"显示与签字按钮一致 | ✅ | `runtime/gate-engine.mjs:16,20,21,41,84`；`src/pages/VerificationCenterPage.tsx:20-21,130-131,142,180` | 徽标"未实现"、不参与可签字、按钮 `disabled` 且 title 列未实现门一致 |
| 18 | G2–G4 有产品内证据生产者 | 🟥 | `gate-engine.mjs:17-19`（implemented:true）；`server.mjs` 仅落 7 种 kind（§4）；`runtime/agents/*` 未被 server 引用 | 页面显示"证据不足"（暗示可补），实际只能靠历史 scripts 落盘 |
| 19 | readiness 入参=真实编译计划 + DRC 通过的 PCB 执行 | ✅ | `src/pages/AssetsPage.tsx:70-124`；`runtime/production.mjs:498-532`；`src/services/releaseBindingStore.ts:54-61` | 不再拿 AI task id 冒充双哈希/执行 id |
| 20 | readiness 人工证据绑定 | ✅ | `production.mjs:514-526`；`server.mjs:3824-3832` | DFM 按 fingerprint.planHash 过滤；签核按 manifestHash+roles |
| 21 | 产物根统一（**读侧**：inspect/readiness/gate/export/archive） | ✅ | `server.mjs:542-543,1207-1209,3817-3819,1927,3824`；`production.mjs:453` | 默认 `deliverables/`，`CIRCUITPILOT_ARTIFACTS_DIR` 可覆盖 |
| 22 | 产物根统一（**写侧**/首件） | 🟥 | `server.mjs:1989-1991`（默认写 `release/<日期>`）；`ValidationPage.tsx:982-1003`（不带 `outDir`）；首件 Gerber/BOM/CPL 无写 `deliverables/` 的路由（仅 3D STEP 导出默认写 `deliverables/pcb-3d`：`server.mjs:3446`） | 全新机器 inspect=0 文件→闸门缺产物；UI 提示"先导草稿再跑闸门"与实现矛盾 |
| 23 | 正式导出解锁条件 | 🟨 | `ValidationPage.tsx:1704-1711`（按钮看 gate 的 decision）；`server.mjs:1960-1985`（导出另需 manifest 绑定） | 按钮可亮、点下被 `RELEASE_MANIFEST_*` 拒（§2.3） |
| 24 | 导出文件 = 签核物料 | 🟥 | `server.mjs:1926-1954`（锚在 deliverables 输入清单）；`runtime/production-export.mjs:78-131`（现场重新导出到 release/） | P0-A（§3） |
| 25 | 归档 B8 | 🟥 | `server.mjs:1876-1897`；`runtime/release-archive.mjs:82-110`；`ValidationPage.tsx:1723` | 稀疏 binding 哈希必不符 + planHash 硬要求 → 结构性 409/400（P1-2） |
| 26 | 订单参数卡/人工确认（边界） | 🚫 | `production.mjs:528`；`server.mjs:2904-2917`；`ValidationPage.tsx:815-830` | 只落人工留痕；系统无下单/支付能力（正确边界，不计断点） |

---

## ② 修复验证段（逐条证据 → 结论 + 边界漏洞）

### 2.1 P0-3 验证结果单一来源 → 结论：🟨 主口径已修，可追溯性未闭环

**成立的部分（有代码+测试）**
1. 官方记录只由 `recordOfficialValidation` 写入，带 `source:'official'`+`projectId`+`evidence`：`validationEvidence.ts:69-88`、`ValidationPage.tsx:447-458,593-603`；全仓无第二个 official 写入点（`grep SET_VALIDATIONS/UPDATE_VALIDATION` 仅验证页）。
2. KPI/概览只取本项目官方记录：`validationEvidence.ts:18-22,49-66`，`OverviewPage.tsx:26-30,38,147-148`；测试 `validationEvidence.test.ts` 断言全新安装 `ran=0/coverage=0/missing=['ERC','DRC']`、项目间不串证据（本报告 §4 已复跑）。
3. 阶段证据改证据驱动：`stageEvidence.ts:52-53`（`source==='official' && projectId===project.id`），`stageMachine.ts:97-106`；测试 `stageEvidence.test.ts`/`stageMachine.test.ts` 通过。
4. 官方 ERC/DRC 的 findings 进问题中心：`ValidationPage.tsx:306-317` 逐条 `reportIssue`。

**边界漏洞（未修）**
- **B1（P1）Demo 会改写官方结论**：`runAll` 把全部行（含 `source:'official'`）重算后统一 `source:'demo'`（`ValidationPage.tsx:339-347`），抽屉"重新运行"对官方行同样生效（`:2246`）。→ 跑一次 Demo，官方覆盖从 100% 掉回 0%、阶段 `drcPassed` 证据在内存中蒸发（fail-closed 但"演示改写生产结论"）。
- **B2（P1）不持久化**：`state.validations` 不在任何 runtime 载荷里（`AppContext.tsx:352-420` 只有 projects/requirements/components/assets；`:474` trace 只有 versions/changes/audit），也没有最新 ERC/DRC 证据回填官方记录的路径——`loadLatestErc/loadLatestDrc` 只 `setErcLatest/setDrcLatest`（`ValidationPage.tsx:378-392,617-624`）。→ 刷新/重启后 KPI 归零、`验证→生产` 的证据不可复核；这与"验证结果回写"目标只完成了一半。
- **B3（P1）项目域只是 UI 标签**：official 记录用 `activeProject.id`，但运行 ERC/DRC 时不校验 EDA 实际文档/工程是否等于 `activeProject.edaWorkspace`（`ValidationPage.tsx` 全文无 `edaWorkspace` 引用）；证据落盘的 `fingerprint.projectUuid`（`server.mjs:2871`）未回传映射。→ 在 EDA 打开 B 板、页面选 A 项目时，B 的结论会记到 A 名下（P0-3 原病"切项目串证据"仍可复现）。
- **B4（P2）DRC pass 口径过严**：official DRC 用 `itemCount ? 'fail' : 'pass'`（`ValidationPage.tsx:449-452`），忽略 `classifyDrcItems` 的豁免/已解释分类（`runtime/drc.mjs:227-260`）→ 全部条目已被合规豁免的板也永远 fail，阶段推不动。

### 2.2 P0-5 六道门 / 门禁报告与交付签核隔离 → 结论：🟨 新写入已隔离，历史文件仍会遮蔽

**成立的部分**
1. 门禁报告改独立 kind `gate-report`（`gates-service.mjs:44-48`），W5 人工终审改 `gate-signoff`（`gates-service.mjs:60-71`），交付签核写 `signoff-record`（`server.mjs:2933-2946`）；`latestReleaseSignoff` 增加 payload 类型守卫（`server.mjs:575-584`），`GET /api/production/signoff/latest` 同样过滤（`server.mjs:3027-3031`）。→ 修复后**新数据**不会再互相遮蔽。
2. G1/G5/G6 明确 `implemented:false` → `verdict:'not-implemented'`（`gate-engine.mjs:16,20,21,41,84`）；UI 独立统计"未实现门"（`VerificationCenterPage.tsx:130-131`）、每门写"本门未实现（无证据生产者）"（`:142`）、签字按钮 `disabled={report.verdict!=='pass'}` 且 title 列出未实现门（`:180`）。**显示与按钮一致**，不再"看起来能签"。

**边界漏洞（未修）**
- **B5（P1）历史 `gate-report`/旧 `signoff-record` 仍遮蔽更早的有效交付签核**：`latestReleaseSignoff()` 只看 `evidenceStore.latest('signoff')` 的最新一条，**不向更早条目回退**（`server.mjs:580-584`；`evidence-store.mjs:111-126` 的 `list` 已按 mtime 倒序，具备修条件）。
  - 本机现网证据：`artifacts/evidence/signoff/` 仍有 3 个 `gate-report` + 1 个 W5 `signoff-record`（`payload.decision='reject'`、无 `passed`）。
  - 隔离实测（§4 命令 C）：先落一条**合法** `signoff-record`（digest `1501d90e…`），再落一条历史 `gate-report`（同为 `signoff` kind）→ `GET /api/production/signoff/latest` 返回 `evidence:null`，同一函数还被 gate/ready/export/archive/readiness 使用（`server.mjs:1852,1876,1932,3828`）→ 旧的**真实签核**被当成"没有签核"。
  - 反向情形：若最新的是旧 W5 `signoff-record`（kind 相同、无 `passed`），守卫会**接受**它，`release-decision` 再判"签核记录无效（需 passed:true…）"→ 同样挡住更早的有效签核。两种都表现为"明明签过却 blocked"。
- **B6（P1）G2–G4 无产品内生产者**：`gate-engine.mjs:17-19` 标 `implemented:true`，但 server 路由直接落盘的只有 `pcb-layer-stack/drc-report/schematic-erc/dfm-evidence/order-confirmation/signoff/spice-simulation` 七种 kind（`server.mjs:2732,2797,2868,2889,2911,2933,3086,3131`），`netlist-diff/lib-evidence/rules` 没有任何落盘者：`runtime/agents/*` 只产内存信封、`runtime/agents/orchestrator.mjs` 不写 evidence store（无 `save` 调用），`runtime/server.mjs` 只 import 了 `knowledge-manager`（`server.mjs:37`）；现网该 3 类文件是 2026-10-21 历史遗留（本报告 §4 已核）。→ 页面把 G2–G4 显示为"证据不足"（`VerificationCenterPage.tsx:21,142`），暗示用户可补；实际在运行中的产品里**无法补**。W5 的"签字放行（仅 pass 可用）"因此永久禁用。
- **无 signoff 时的结论正确**：`releaseDecision` `blockedBy=['manual:dfm','manual:signoff']` 或 `['manual:signoff']`（`release-decision.mjs:97-120`）；正式导出落到 `RELEASE_DECISION_BLOCKED`（`server.mjs:1968-1978`）；readiness 的 `human-final-review` 明确"尚无人签核"（`production.mjs:519-521`）。口径一致，无需修。

### 2.3 P0-6 正式导出解锁 / 产物根统一 → 结论：🟨 规则层已修，"首件"与"输出=签核"仍断

**成立的部分（隔离 HTTP 测试证实）**
1. 读侧统一到 `productionArtifactsRoot`（默认 `deliverables/`，`server.mjs:542-543`）：inspect（`:3817-3819`）、gate（`gatherReleaseEvidence`，`:1207-1209`）、readiness（`production.mjs:453`）、export 的 manifest 重算（`:1927`）、archive（`:1880`）同根。
2. `requested:'final'` + `draftPathsReplaced` 一路传到 `decideProductionOutput`（`release-gate.mjs:676`；`server.mjs:1947`），自产草稿被承认豁免，`outputDecision` 不再丢豁免：`release-p06-http.test.mjs`（本报告 §4 复跑通过，含"缺省请求按 final""显式 draft 仍报草稿标记""outputDecision 同源"3 条）。
3. 名称正确性：正式命名只在 `final` 且复核通过时产出（`production-export.mjs:114-131`）。

**边界漏洞（未修）**
- **B7（P1）全新机器/全新目录依然走不到正式导出**：产品内**没有任何动作把首套 Gerber/BOM/CPL 写进 `deliverables/`**——草稿/正式导出都默认写 `release/<日期>`（`server.mjs:1989-1991`）；唯一往该根写的是 3D STEP 导出（`deliverables/pcb-3d`，`server.mjs:3446`），不解决首件问题，UI 从不传 `outDir`（`ValidationPage.tsx:982-1003`，尽管 client 支持 `outDir`：`runtimeClient.ts:643`）。→ inspect 0 文件 → `ARTIFACT_MISSING` → `formalAllowed=false`；只有手工/脚本往 `deliverables/` 放 `GERBER_/BOM_/CPL_/STEP_` 前缀文件才可能继续（P0-6 测试自己也是预先写文件：`release-p06-http.test.mjs:40-55`）。且按钮提示"先导出一次草稿再重跑闸门"（`ValidationPage.tsx:1709-1710`）与实现矛盾（草稿写的是 `release/`，闸门看的是 `deliverables/`），产物目录 hint 写"与正式导出同一根"（`:1606`）也不准确（导出只从该根**读**，不往该根**写**）。
- **B8（P1）三处 `releaseDecision` 的 binding 不一致 → 按钮亮、必败**：gate 只用 `{pcbUuid, planHash}`（`server.mjs:1850-1852`），而 client 的 `releaseGate` 类型里根本没有 `planHash/binding/manifestHash`（`runtimeClient.ts:674`）→ 计划/清单绑定恒空；export 追加 `manifestHash`（`server.mjs:1950-1954`，且 `planHash` 同样无通道：`runtimeClient.ts:643`）；archive 追加 `manifestHash` 但用**稀疏 binding** 重算（见 B9）。前端解锁只看 gate 的 `releaseDecision.ready`（`ValidationPage.tsx:1705`、归档 `:1723`）→ 点击后 `RELEASE_MANIFEST_BINDING_REQUIRED`/`RELEASE_MANIFEST_MISMATCH`（`release-binding.mjs:48-72`）或 `RELEASE_ARCHIVE_NOT_ALLOWED`。
- **B9（P1）归档 B8 结构性不可达（P1-7 未修且加重）**：
  - 归档重算 manifestHash 用 `inspectProductionArtifacts(dir,{pcbUuid,planHash})` 稀疏 binding（`server.mjs:1881`），而 readiness/签核交接的 manifestHash 用**完整 binding**（projectId/projectName/documentId/sourceDigest/semanticPlanHash/compiledPlanHash/executionId，`production.mjs:431-434` 参与哈希）。同一 `deliverables/` 两值实测不同：完整 `e87beb7c…` vs 稀疏 `7404d630…`（§4 命令 B）→ 签核绑定的哈希永远 ≠ 归档重算值 → `releaseDecision.ready=false` → `release-archive.mjs:89-94` 409。
  - 即使哈希修好，归档仍硬要求 `planHash`（`release-archive.mjs:102-108`），而 UI 标"语义计划哈希 可留空"（`ValidationPage.tsx:1799`），归档按钮/请求不传 `planHash`（`ValidationPage.tsx:1723`、`archiveReleaseVersion` body 无该字段，尽管 client 支持：`runtimeClient.ts:670`）→ 400 `BINDING_INVALID`。旧审计 P1-7 的"UI 可留空 vs 服务端硬要求"**依然存在**，且叠加了哈希错位。

### 2.4 P0-7 readiness 入参不再猜测 → 结论：✅ 核心诉求达成（P2 摩擦项）

**成立的部分**
1. 真实输入链：sessionStorage 计划草稿 → `compileProductionPlan` → 取 `compiledPlanHash` → `pcbExecutions()` 里挑 `completed && drc.passed===true`（`AssetsPage.tsx:70-108`；`releaseBindingStore.ts:54-61`）→ 真实 binding 调 readiness（`AssetsPage.tsx:109-124`）。
2. 缺失输入给出精确 code 且**不落盘旧结论**：`PRODUCTION_PLAN_MISSING`、`PRODUCTION_PLAN_COMPILE_FAILED/BLOCKED`、`PRODUCTION_PCB_EXECUTION_MISSING`（`AssetsPage.tsx:70-96`）；服务端 `PRODUCTION_PLAN_UNKNOWN`/`PRODUCTION_EXECUTION_UNKNOWN`/`PRODUCTION_COMPILED_PLAN_MISMATCH`（`production.mjs:481-508`）；失败分支明确"本次结论未落库"（`AssetsPage.tsx:126-129`）。
3. 审批/readiness 只吃服务端重算结果：`readiness()` 内 `recomputed.compiledPlanHash` 比对 + `execution?.drc?.passed`（`production.mjs:500-532`），不接受客户端自报通过。

**边界（P2，不阻断）**：`readReadinessInputs` 无生产消费者（`releaseBindingStore.ts:34-46`，仅测试用）；签核页读的是另一个 key `circuitpilot:release-binding`（`ValidationPage.tsx:939-948`），两个 sessionStorage key 各写各的；DFM 的"语义计划哈希"不预填（只有签核的 manifestHash/planHash 预填，`:949-953`），默认留空 → readiness `online-dfm` 永久 false，需用户手抄；readiness 依赖先点"检查生产资料"的快照 binding（`AssetsPage.tsx:60-68`），换板后会过期。

### 2.5 边界漏洞对照（任务点名的 6 个场景）

| 边界场景 | 实测/代码结论 | 证据 |
|---|---|---|
| 历史 gate-report 文件是否还会遮蔽交付签核 | **会**：最新是旧 gate-report → 返回 null（有效旧签核被忽略）；最新是旧 W5 signoff-record → 被当签核但判无效 | `server.mjs:580-584`；§4 命令 C |
| 无 signoff 时的结论 | 一致且 fail-closed：`blockedBy:['manual:signoff']` → 正式导出 `RELEASE_DECISION_BLOCKED`；readiness `human-final-review` false | `release-decision.mjs:97-120`；`server.mjs:1968-1978`；`production.mjs:519-521` |
| artifact 根不一致路径 | 读侧 5 处已同根；**写侧仍在 `release/<日期>`**；archive 稀疏 binding；signoff 锚 deliverables 输入 | `server.mjs:542-543,1209,1927,3824,1989-1991,1881` |
| readiness 输入缺失各错误码 | `PRODUCTION_PLAN_MISSING` / `..._COMPILE_FAILED` / `..._COMPILE_BLOCKED` / `PRODUCTION_PCB_EXECUTION_MISSING`（前端）；`PRODUCTION_PLAN_UNKNOWN`(404) / `PRODUCTION_EXECUTION_UNKNOWN`(404) / `PRODUCTION_COMPILED_PLAN_MISMATCH`(409)（服务端） | `AssetsPage.tsx:70-96`；`production.mjs:481-508` |
| 导出按钮解锁条件 | `outputDecision.allowed && outputClass==='final' && gate.releaseDecision.ready`，但服务端导出还要 manifest binding + releaseDecision（binding 更严）→ 条件不同源 | `ValidationPage.tsx:1704-1711`；`server.mjs:1960-1985` |
| 归档 P1-7 | **未修**：planHash 服务端硬要求 vs UI 可留空；且新增稀疏 binding 哈希错位 | `release-archive.mjs:102-108`；`ValidationPage.tsx:1799,1723`；`server.mjs:1881` |

---

## ③ 未解决 P0 / P1 清单

### P0（1 条，条件触发；不修则"人工签核"可被绕过）

**P0-A｜签核锚点 ≠ 实际交付物：正式导出用实时 EDA 重新生成文件，签核绑的是 `deliverables/` 静态输入清单**
- 证据：签核/readiness/导出绑定都是对 `deliverables/` 里的输入产物算 `manifestHash`（`server.mjs:1926-1954`；`production.mjs:498-532`；`release-decision.mjs:92-95`）；正式导出却在 `release/<日期>/` **现场从 EDA 重新导出** Gerber/BOM/CPL/STEP 并写自己的 `manifest.json`（`runtime/production-export.mjs:78-131`；`server.mjs:1987-2005`）；导出后没有任何一步把输出文件哈希与签核/输入清单比对。导出后复核用的 `verify` 只做"输出内部一致性"（铜层/位号集合/CPL 容差/STEP 头，`production-export.mjs:108-118`、`release-gate.mjs:338-430`），不比对签核清单；gate 的 DRC 证据还是落盘旧报告（`server.mjs:1246-1250`）。
- 影响：签核后改板（例如只动布局/BOM 但旧 DRC 仍 pass），闸门（实时读 acceptance/design/placement + 旧 DRC）仍可能 ready → 导出正式命名文件 → **人工签字覆盖不到真正交付的文件**（fail-open 的交付完整性问题）。这是"签核不能被复用到别的批次"的正面反例。
- 修法：把"本次导出结果"作为放行/归档锚：导出后计算输出 package 的 `manifestHash` 并写入 release 记录，签核/归档校验该值；或导出前强制校验 `输出文件 sha256 == 签核输入清单 files.sha256`（按 kind 逐项），不等即 `RELEASE_OUTPUT_MISMATCH`；同时把 live 设计指纹（executionId/双哈希/DRC digest）纳入签核 binding。
- 验收：HTTP 测试——签核绑定 M1 → 改动 EDA/替换输入包 → `requested:'final'` 必须返回 `RELEASE_OUTPUT_MISMATCH`（或导出后新 manifestHash 被记录且与旧签核不一致被拒）；未变时导出成功且归档记录里的哈希 == 签核哈希。

### P1（8 条）

**P1-1｜历史 signoff 文件仍会遮蔽/污染交付签核**（见 §2.2 B5）
- 证据：`server.mjs:580-584`；`evidence-store.mjs:111-126`；现网 `artifacts/evidence/signoff/` 3×gate-report + 1×无 passed 的 W5 signoff-record；隔离实测返回 null。
- 影响：升级机器上"明明签过却显示未签核/签核无效"，readiness/export/archive 全被挡；且更早的**真实**签核不可达。
- 修法：`latestReleaseSignoff` 改为 `evidenceStore.list('signoff')` 倒序扫描第一条满足"release signoff 形状"的记录（`kind==='signoff-record' && passed===true && roles.length>0`；或者旧格式 `kind===undefined && passed===true && roles`），并可拒绝带 `decision/reportDigest/gateVerdict` 的 W5 记录；或在升级时把历史文件迁到 `gate-report/gate-signoff` kind。
- 验收：新增 http 测试——先写有效 `signoff-record`，再写历史 `gate-report`（及旧 W5 `signoff-record`）→ `signoff/latest`、`releaseDecision`、readiness 仍取到有效签核；现网旧目录迁移脚本干跑报告。

**P1-2｜B8 归档结构性不可达（稀疏 binding + planHash 硬要求）**（见 §2.3 B9）
- 证据：`server.mjs:1876-1897`；`release-archive.mjs:82-110`；`ValidationPage.tsx:1723,1799`；`runtimeClient.ts:670`；实测哈希 `e87b…`≠`7404…`。
- 影响："签核→归档"链断；即使其它环节 ready，归档 409/400；旧审计 P1-7 未修。
- 修法：归档复用 readiness 交接的完整 binding（`server.mjs` 增加 `body.binding` 通道，client 已有 `binding` 能力需同步补类型）；UI 归档请求显式带 `planHash`（从签核/handoff 取），或服务端把 planHash 从签核 payload 兜底后不再硬要求 UI 输入；统一"manifestHash = inspect(全 binding)"。
- 验收：在产物就位 + DFM/签核齐备的隔离 HTTP 用例中，gate→readiness→export→archive 全 200，归档记录 `binding.manifestHash` 与签核 payload 一致。

**P1-3｜首件产物无产品内入口，正式导出在干净机器上不可达**（见 §2.3 B7）
- 证据：`server.mjs:1989-1991`；`ValidationPage.tsx:982-1003,1606,1709-1710`；首件 Gerber/BOM/CPL 无写 `deliverables/` 的路由（3D STEP 例外：`server.mjs:3446`）；P0-6 测试预置文件（`release-p06-http.test.mjs:40-55`）。
- 影响：全新安装/新项目"导出正式生产文件"永远 disabled（先卡 `ARTIFACT_MISSING`）；用户按提示"先导草稿再跑闸门"也不会好（草稿写 `release/`）。
- 修法：草稿导出首次落到统一产物根（或提供"导出到产物目录"选项并把 `outDir` 传给 client）；或闸门/readiness 支持"由本次导出产物构成根"；修正 `gateDir` hint 与按钮文案。
- 验收：干净 state 下（无 deliverables 内容）UI 可完成"首套产物入根→gate ready"；e2e 断言 `deliverables/` 出现 4 类文件且 inspect 不再 `ARTIFACT_MISSING`。

**P1-4｜gate/export/archive 三处 `releaseDecision` 输入 binding 不一致 → 按钮亮但必败**（见 §2.3 B8）
- 证据：`server.mjs:1850-1852`（gate 无 manifestHash）；`runtimeClient.ts:674`（gate client 无 planHash/binding）；`runtimeClient.ts:643`（export 无 planHash）；`server.mjs:1950-1954`；`ValidationPage.tsx:1705,1723`。
- 影响：正式导出按钮/归档按钮以较松的 gate 裁决为准，服务端按较严的导出裁决拒绝 → "可点即失败"；用户无法从 UI 判断真实缺什么。
- 修法：三处统一使用同一 binding（readiness 交接的完整 binding + manifestHash），client 类型补齐 `planHash/binding/manifestHash`；按钮解锁条件改为调用服务端"预检"接口（或 gate 返回同一 binding 下的 `exportReady/archiveReady`）。
- 验收：同一状态下三处 `releaseDecision.ready` 与 `blockedBy` 完全一致（HTTP 测试逐项断言）；UI 按钮解锁 == 导出/归档实际成功。

**P1-5｜官方验证结果不持久化，最新证据不回填**（见 §2.1 B2）
- 证据：`AppContext.tsx:352-420,474`；`ValidationPage.tsx:378-392,617-624`。
- 影响：重启后"官方覆盖 0/2"，阶段 `验证→生产` 的证据链消失；已落盘的 ERC/DRC 证据不能恢复项目域记录。
- 修法：official 记录落 runtime（evidenceStore 新 kind `validation-record`，或 project-state 增加 `validations` 字段并做 schema 演进），启动/切换项目时回填；`loadLatestErc/Drc` 在 `activeProject.edaWorkspace` 匹配时生成 official 记录。
- 验收：HTTP/单测——写入 official 记录 → 重启（新 store 实例）→ KPI 保持；`latest` 载入后 KPI 与 evidence digest 一致。

**P1-6｜Demo 全量/单条重跑会覆盖官方结论**（见 §2.1 B1）
- 证据：`ValidationPage.tsx:339-347,2246`；`demoAdapter.ts:68-83`。
- 影响：演示按钮可把 official 行改为 demo，覆盖率掉 0、阶段证据消失（状态诚实但生产结论被"降级"，且真机上用户会误以为检查结果丢失）。
- 修法：Demo 运行只更新 `source!=='official'` 行；official 行禁用"重新运行"并提示走"官方取证"入口。
- 验收：单测——含 official 记录时跑 runAll，official 行 `source/status/evidence` 不变，KPI 不掉。

**P1-7｜项目域绑定只是 UI 标签（可与 EDA 实际文档不一致）**（见 §2.1 B3）
- 证据：`ValidationPage.tsx:448-452,593-600`（无 `edaWorkspace` 校验）；`server.mjs:2868-2872`（fingerprint.projectUuid 未回传）。
- 影响：多项目/多板时官方结论可能记到错误项目（切项目串证据）；阶段机据此推进错误项目。
- 修法：运行前后校验 `pcbUuid/schematicUuid` 与 `activeProject.edaWorkspace` 一致，不一致 `409 EDA_TARGET_PROJECT_MISMATCH`；证据 digest 写入项目域并回填指纹。
- 验收：单测/HTTP——EDA 打开 B 板、页面选 A 项目时，ERC/DRC 落库被拒或落 B 项目，不落 A。

**P1-8｜"六道门"G2–G4 无产品内可产出路径，显示"证据不足"误导**（见 §2.2 B6）
- 证据：`gate-engine.mjs:17-19`；`server.mjs:37`（只 import knowledge-manager）、`:2732-3131`（仅 7 种业务 kind）；`runtime/gates-service.mjs:29` 只读 `evidenceStore.latest(kind,{fingerprint:{pcbUuid}})`；`runtime/agents/netlist-auditor.mjs:273`、`librarian.mjs:62`、`rule-runner.mjs:106` 产出的信封**无人落盘**（orchestrator 无 `save`），故只能消费 `artifacts/evidence/*` 的 2026-10-21 历史文件。
- 影响：W5 门禁页"证据不足"暗示可补齐，实际用户无入口；W5 签字永久禁用（G1/G5/G6 未实现 + G2–G4 不可产出）。
- 修法：要么把 orchestrator 接成一条受控路由（`POST /api/gates/agents/run`，只读产证据），要么把 G2–G4 也标成"当前无在线生产者"并给出 CLI 说明；文档/UI 明确 W5 是"只读门禁看板"。
- 验收：UI 能一键产出 G2–G4 证据并让六道门走到 pass（再受 G1/G5/G6 限制时明确展示）；或 UI 明确标注"需 CLI 生成"。

### P2（记录，不阻断）
| # | 问题 | 证据 |
|---|---|---|
| P2-1 | 页签角标/导航红点/版本快照状态仍混入 seed/Demo（角标 8 vs "0 未收口"） | `DeliverPage.tsx:21,32`；`Shell.tsx:104`；`VersionsPage.tsx:182` |
| P2-2 | findings 列表不显示来源，seed 的 open finding 与官方问题混排；运行中进度条混入 seed | `ValidationPage.tsx:2238,2243` |
| P2-3 | DFM 计划哈希不预填、readiness 要求其与编译计划一致；`readReadinessInputs` 死代码、两个 sessionStorage key 分裂 | `ValidationPage.tsx:1794-1800,949-953`；`releaseBindingStore.ts:34-46` |
| P2-4 | official DRC 以 `itemCount===0` 判 pass，忽略豁免/已解释分类；DRC 条目全量进问题中心（含已豁免） | `ValidationPage.tsx:449-452`；`runtime/drc.mjs:227-260` |
| P2-5 | 证据目录一条损坏文件会让 `latest()` 抛 `EVIDENCE_CORRUPT`，gate/readiness/export 直接 500（fail-closed 但缺"隔离坏文件并报 issue"） | `evidence-store.mjs:94-126`；`server.mjs:1852,3828` |

---

## ④ 验证记录（可复现）

环境：macOS，Node（`node --version` 略），cwd `/Users/jescochen/Desktop/AI- PCBA`（含空格）；时间为 2026-10-29 本地（Asia/Shanghai）。**隔离 state/evidence/automation/artifacts 目录，未触碰仓库 `artifacts/` 与运行中的服务。**

**A. 隔离 runtime 测试（P0-5 门禁/P0-6 导出/P0-3 相关）——28/28 通过**
```
CIRCUITPILOT_STATE_DIR=$PWD/.tmp/audit-state-deliver \
CIRCUITPILOT_EVIDENCE_DIR=$PWD/.tmp/audit-evidence-deliver \
CIRCUITPILOT_AUTOMATION_DIR=$PWD/.tmp/audit-automation-deliver \
CIRCUITPILOT_ARTIFACTS_DIR=$PWD/.tmp/audit-artifacts-deliver \
node --test runtime/__tests__/release-gate.test.mjs runtime/__tests__/gates-service.test.mjs \
  runtime/__tests__/gates-p05-http.test.mjs runtime/__tests__/release-p06-http.test.mjs
→ tests 28 / pass 28 / fail 0（2026-10-29T11:18+08:00）
```
覆盖：gate-report 不遮蔽交付签核（新数据）、未实现门 G1/G5/G6、旧格式 signoff 兼容（仅最新）、产物根统一、`requested:'final'` 自产草稿豁免、显式 draft 仍报草稿、`outputDecision` 同源、路径含空格不得用 URL.pathname。

**B. `deliverables/` 下同一目录两种 binding 的 manifestHash 实测——不相等**
```
node --input-type=module -e 'import { inspectProductionArtifacts } from "./runtime/production.mjs"; ...'
→ 完整 binding: e87beb7c2269a2601e44f40ccbafc0ba5b8f2e3f84158e280fed41091537acda
→ 稀疏 binding: 7404d630df7056da46569f33c4f5d833f93b40350ae109de322150908055c446
→ equal: false
```
证明 §2.3 B9：archive 用稀疏 binding 重算，必然与 readiness/签核（完整 binding）不一致。

**C. 历史 gate-report 遮蔽实测（隔离 evidence 目录 + 真实 HTTP 路由）**
先落合法 `signoff-record`（digest `1501d90e0b4bf418…`，`passed:true`+roles+manifestHash），再落历史 `gate-report`（同 `kind:'signoff'`）：
```
POST /api/health → GET /api/production/signoff/latest
→ latestRouteEvidence: null   （有效签核被最新 gate-report 遮蔽，而非返回旧的有效签核）
```
另：现网 `artifacts/evidence/signoff/` 实查 = 3×`gate-report` + 1×W5 `signoff-record`（`decision:'reject'`、无 `passed`）→ 升级后该目录会命中 B5 两种失败形态之一。

**D. 前端服务测试——4 文件 / 29 用例通过**
```
npx vitest run src/services/__tests__/validationEvidence.test.ts src/services/__tests__/stageEvidence.test.ts \
  src/services/__tests__/releaseBindingStore.test.ts src/services/__tests__/stageMachine.test.ts
→ Test Files 4 passed / Tests 29 passed（2026-10-29T11:19:41+08:00）
```
覆盖：seed 不算覆盖（0/2）、官方记录项目域、同名种子被官方替换、DRC/ERC findings 转换、阶段证据官方 DRC、readiness 执行挑选（completed+DRC pass）与错误文案。

**E. 静态核查清单（逐文件阅读）**：`runtime/server.mjs`（542-543,580-584,1207-1420,1846-1897,1924-2005,2781-2952,3027-3031,3820-3832）、`runtime/production.mjs`（431-434,453,481-532）、`production-export.mjs`（38-131）、`release-decision.mjs`（44-130）、`release-archive.mjs`（82-110）、`release-binding.mjs`（30-75）、`gate-engine.mjs`（16-90）、`gates-service.mjs`（40-72）、`evidence-store.mjs`（94-126）、`src/pages/ValidationPage.tsx`（306-347,378-458,584-630,773-830,939-1003,1170-1190,1600-1610,1690-1730,1780-1800,2237-2250）、`AssetsPage.tsx`（55-135）、`OverviewPage.tsx`（20-40,145-150）、`DeliverPage.tsx`（18-36）、`VerificationCenterPage.tsx`（18-30,120-145,175-185）、`stageEvidence.ts`（20-56）、`stageMachine.ts`（97-106）、`validationEvidence.ts`（14-100）、`releaseBindingStore.ts`（20-60）、`src/data/seed.ts`（114-122）。

**F. 本轮未做（超出只读边界或需真机）**
- 未跑真机 EDA / live e2e / Playwright；未重启或另起服务；未修改任何产品代码/测试；未做 git 操作。
- 因此凡"正式导出实际落盘""归档成功""签核→readiness ready"端到端步骤均**未真机复验**；P0-A 为静态链路 + fail-open 推理（前置条件明确），建议下轮用 EDA 真机按 §3 验收步骤复核后再定级。
- 并行说明：审计期间 `runtime/__tests__/gates-p05-http.test.mjs` 等测试文件被其他 teammate 更新（本轮测试计数 28 与更早的 27 不同属正常），引用行号以本报告写作时工作区为准。
