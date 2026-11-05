# 03 验证/交付链闭环审计（2026-11-05 · 只读）

- 审计对象：`/Users/jescochen/Desktop/AI- PCBA`（HEAD `98429be`，git 干净），**只读复审**：未连 EDA/Bridge、未启动固定端口、未跑 acceptance/live e2e、未改源码。
- 范围：官方 ERC/DRC → Runtime 持久化 → issue 收口 → 六门 G1–G6 证据 → release-decision → readiness → production-export → release-archive → 签核 binding → deliverables，含前端 `ValidationPage`/`DeliverPage`/`VerificationCenterPage`/`AssetsPage`/`VersionsPage`。
- 判定：✅ 已闭环（产品内可完成且有证据）｜🟨 半闭环（口径/入口/一致性问题）｜🟥 断链或结构性不可达｜⬜ 无消费者/无回填｜🚫 产品边界。
- 方法：逐文件读代码 + 3 组只读复现实验 + 隔离 `node --test`（38/38 + 37/37，见 §5）。凡"端到端 200"未真机复验的，一律列 §4 边界，不冒充打通。

---

## ① 结论摘要

**一句话**：官方验证的"单一口径 + 持久化 + 项目过滤 + Demo 隔离"这一层已经真实闭环（P0-1/P0-3/P1-13 修复成立）；但**六门签字在产品内结构性不可达**（4 门没有 UI 输入通道，G5 证据恒 blocked），**签核锚点与导出/归档的 manifest 哈希域不一致**（`projectName` 被导出/归档侧丢弃）导致合法签核也必被 `MANIFEST_*_DRIFT/MISMATCH` 拒绝——"六门可签"与"签核→正式导出→归档"两条主链仍未闭环。加上历史 W5 签核遮蔽、三处 `releaseDecision` 输入域不一致等 5 条 P1，交付链判定为 **🟥 结构未闭环 / 🟨 取证与持久化已闭环**。

| 等级 | 数量 | 主题 |
|---|---|---|
| **P0** | **2** | ①六门可签不成立（G1/G2/G3/G5 输入通道缺失 → 门禁永不为 pass → 签字永久禁用）②签核/导出/归档 manifest 哈希域不一致（`projectName` 丢失）→ 合法签核也无法正式导出/归档 |
| **P1** | **5** | ①旧 W5 `signoff-record` 仍遮蔽有效交付签核（真实升级机命中）②gate/export/archive 三处 `releaseDecision` 输入域不同 ③`validation-state` 接受客户端伪造 official 记录 ④门禁证据无新鲜度/失效判定 ⑤`pcbUuid` 绑定来源不一致（默认"留空"即恒 blocked） |
| **P2** | **7** | ①readiness inputs 死存储 ②锚点哈希覆盖整个产物根 ③evidence→KPI 无回填 ④DFM 计划哈希不预填 ⑤gate-signoff 无下游消费者 ⑥archive `reviewHash` 语义混淆 ⑦版本快照状态仍混入 demo/seed |

已确认**不存在**的伪闭环路径（正面结论）：Demo/种子无法改写/冒充官方结论（`mergeDemoValidationRun` 保留 official，official 行禁用 Demo 重跑）；无"demo 数据被当官方证据"的写入路径；证据索引/保留计划/dry-run/统一时间线/发布版本读取**都有真实 UI 消费者**（VersionsPage）。

---

## ② 闭环矩阵（每行带 file:line）

### 2.1 官方验证取证 → 持久化（④）

| # | 节点 | 判定 | 证据（file:line） |
|---|---|---|---|
| 1 | 官方 ERC 取证落盘（kind `schematic-erc`，绑 window/project/document） | ✅ | `runtime/server.mjs:3560-3604`；`src/pages/ValidationPage.tsx:700-745` |
| 2 | 官方 DRC 取证落盘（全量报告 + 分类，`drc-report`） | ✅ | `runtime/server.mjs:3510-3545`；`ValidationPage.tsx:477-580` |
| 3 | 官方结论唯一写入口 → 项目域记录（`source:'official'`+`projectId`+digest+executionId/planHash/compiledPlanHash） | ✅ | `ValidationPage.tsx:332-368,547-580,710-735`；`src/services/validationEvidence.ts:143-166` |
| 4 | 结论持久化到 Runtime `/api/validation-state`；启动 hydrate + 800ms 防抖写回 | ✅ | `runtime/server.mjs:1937-1948`；`runtime/validation-state.mjs:18-60`；`src/state/AppContext.tsx:363-410` |
| 5 | 刷新/重启后 KPI/阶段一致（同机同 state） | ✅ | `AppContext.tsx:370` HYDRATE；`HYDRATE_VALIDATIONS` 空值不覆盖（`AppContext.tsx:188-190`）；`stageEvidence.ts:52-53` |
| 6 | 官方记录服务端可核验（digest 必须对应真实证据文件/执行记录） | 🟨 | `runtime/validation-state.mjs:18-43` 只校验 id/name 形状；`server.mjs:1940-1947` 原样落盘；无 evidenceStore/executions 校验（P1-3） |
| 7 | 换机/新 state 时 evidence→KPI 回填 | ⬜ | `ValidationPage.tsx:417-430,747-751`（`loadLatestErc/Drc` 只 set 组件 state，不生成 official 记录）（P2-3） |
| 8 | 取证前校验"当前 EDA 工程 = 项目绑定"（fail-closed） | ✅ | `ValidationPage.tsx:456-513`；`validationEvidence.ts:83-90` |
| 9 | KPI/阶段只认"当前项目 + official" | ✅ | `validationEvidence.ts:92-141`；`stageEvidence.ts:52-53`；`DeliverPage.tsx:22-25`；`components/Shell.tsx:54` |
| 10 | Demo/种子不进 KPI；Demo 运行不改写 official；official 禁用 Demo 重跑 | ✅ | `validationEvidence.ts:207-214`；`ValidationPage.tsx:370-377,2418`；`src/data/seed.ts:114-123`（seed 无 source） |
| 11 | 官方 findings → 问题中心；官方通过自动收口旧 issue | ✅ | `ValidationPage.tsx:341-358`；`validationEvidence.ts:225-233`；`runtime/supervisor.mjs:101-135`（只吃 official） |

### 2.2 六门 G1–G6（①）

| # | 节点 | 判定 | 证据（file:line） |
|---|---|---|---|
| 12 | 六门**证据生产者**存在（design-spec/lib-evidence/netlist-diff/rules/placement/fabrication-release） | ✅ | `runtime/gates-evidence.mjs:191-352`（G4:235-254，G3:256-270，G2:272-306，G1:308-314，G5:316-322，G6:324-330）；隔离测试 9 例通过 |
| 13 | G5/G6 由产品动作自动落盘（placement/apply、release/gate） | ✅ | `runtime/server.mjs:3145-3152`（G5）；`server.mjs:2509-2516`（G6） |
| 14 | **G1 有 UI 输入通道** | 🟥 | UI 只传 `specInput{project,requirements}`（`VerificationCenterPage.tsx:88-97`），但 `buildDesignSpec→validateDesignSpec` 要求 `boards` 非空（`runtime/design-spec.mjs:318`）→ 服务端 `buildDesignSpec` 抛错只记 missing（`server.mjs:2146-2148,2182`） |
| 15 | **G2 有 UI 输入通道** | 🟥 | UI 组件只映射 `id/refdes/mpn/package/lcscId/qty`（`VerificationCenterPage.tsx:86`；类型 `src/types.ts:105-120` 无 eda/supply/datasheet）→ `auditPartIdentity` 对每件必报 `LIB_EDA_SOURCE_MISSING`/`LIB_SUPPLY_SOURCE_MISSING` 为 error（`runtime/agents/librarian.mjs:29-30`）→ 证据恒 blocked，G2 恒 blocked |
| 16 | **G3 有 UI 输入通道** | 🟥 | UI 不传 `intentNetlist`（`VerificationCenterPage.tsx:83-98`），`specInput` 无 `netIntent`（`design-spec.mjs:364-370` 默认空）→ `gates-evidence.mjs:256-270` 必进 missing，永不产证据 |
| 17 | G4 有 UI 输入通道 | 🟨 | 需要 ERC+DRC 同时绑定：ERC 按 `projectUuid`（`server.mjs:2135-2137`），DRC 按 `pcbUuid`（`:2138-2140`），而 DRC 证据的 `pcbUuid` 只来自用户手填字段（`ValidationPage.tsx:195` 默认 `''`；`:522`；`server.mjs:3526-3528` 为空即 `null`）→ 不手填 UUID 时 DRC 取不到，`rules` 恒 unknown（`runtime/agents/rule-runner.mjs:127-130`） |
| 18 | **G5 有 UI 可签通道** | 🟥 | 生产者要求 `userConfirmed:true`（`server.mjs:3147` 传 `body.userConfirmed===true`），但布局页写回调用不带该字段（`PlacementPage.tsx:112,147`），client 类型也没有该参数（`src/services/runtimeClient.ts:759`）→ 恒为 `false` → 证据恒 blocked（`gates-evidence.mjs:133-135`） |
| 19 | G6 制造门可产 pass | ⬜ | 只有 release/gate 真 ready（真实 Gerber/BOM/CPL/DRC 产物）才产 pass（`server.mjs:2509-2516`；`gates-evidence.mjs:144-168`）→ 需真机，本轮未验 |
| 20 | 门禁报告/签字可走通 | 🟥 | 签字要求六门 `verdict==='pass'`（`runtime/gates-service.mjs:71-73`），UI 按钮 `disabled={report.verdict!=='pass'}`（`VerificationCenterPage.tsx:246`）；由 #14/#15/#16/#18 推得"永久禁用" |
| 21 | 六门签字影响放行/导出/归档 | ⬜ | `gate-signoff` 只写入证据库（`gates-service.mjs:83`；kind 白名单 `runtime/evidence-store.mjs:27`），全仓无消费者；release/export/readiness 只读 `dfm-evidence`+`signoff`（`server.mjs:2508,2529,2548,2650`）（P2-5） |
| 22 | 门禁证据新鲜度/设计变更失效 | 🟨 | `gates-service.mjs:33-45` 直接 `latest(kind)`，无 savedAt/TTL/指纹校验；`runtime/evidence-freshness.mjs` 只被仿真证据使用（`server.mjs:877`）（P1-4） |
| 23 | 门禁证据跨项目污染 | 🟨（fail-closed 兜底） | projectId/pcbUuid 为空时取无过滤 latest（`server.mjs:2135-2140`）；但 gate-engine 对 pcbUuid 不符/为空给 blocked/unknown（`runtime/gate-engine.mjs:60-63`），不会假 pass |

### 2.3 统一裁决与「签核→导出→归档」（②⑥）

| # | 节点 | 判定 | 证据（file:line） |
|---|---|---|---|
| 24 | 统一 `releaseDecision` 函数被 gate/readiness/export/archive 共用 | ✅ | `runtime/release-decision.mjs:54-125`；调用点 `server.mjs:2508,2529,2548,2650`；`runtime/production.mjs:498-532` |
| 25 | 三处 `releaseDecision` **输入**一致 | 🟥 | gate 只用 `{pcbUuid,planHash}`（`server.mjs:2506-2508`）；export 追加 manifestHash + 8 域（`:2650-2656`）；archive 追加 signoff 的 plan/manifest（`:2542-2556`）；UI 解锁只读 gate 的结论（`ValidationPage.tsx:1869,1875,1887`）→ 按钮亮、点下 409（P1-2） |
| 26 | 正式导出共用的**六域/七域 binding** 与 readiness/签核完全一致 | 🟥 | manifest 哈希域含 `projectName`（`runtime/production.mjs:436`）；readiness/签核的 binding 带 projectName（`src/pages/AssetsPage.tsx:104-112,123`；`server.mjs:4587-4597`）；exportBinding 白名单**不含 projectName**（`server.mjs:2616-2625`）；archiveBinding 也不含（`:2555-2563`）；archive 内部 fullBinding 虽含 projectName（`runtime/release-archive.mjs:105-113`）但上游没传 → 重算值必然不同（P0-2） |
| 27 | 重导出漂移 fail-closed（输出锚点） | ✅（机制） | `runtime/production-export.mjs:141-167`（不一致→409 `PRODUCTION_EXPORT_MANIFEST_DRIFT` 且保留草稿）；`runtime/__tests__/production-release.test.mjs:214-240`（隔离测试通过） |
| 28 | 签核锚点 = 导出物（同一批文件、可正式命名） | 🟥 | 因 #26：正式导出第一步 `verifyExportManifestBinding` 就会 `RELEASE_MANIFEST_MISMATCH`（`runtime/release-binding.mjs:53-60`；`server.mjs:2631,2657-2677`）；即使绕过，锚点比较也必不相等（`production-export.mjs:145-166`）（P0-2） |
| 29 | 归档不可变 + 证据重校验 | ✅ | `runtime/release-archive.mjs:57-78,176-213`；`runtime/__tests__/release-archive.test.mjs` 4/4 |
| 30 | 归档真实路径可达 | 🟥 | 稀疏→完整 binding 已修（`release-archive.mjs:114-147`），但 `projectName` 域不一致致 `RELEASE_ARCHIVE_MANIFEST_DRIFT`（`:139-145`）；且 HTTP 测试只有"未 ready→409"负路径（`runtime/__tests__/release-archive.test.mjs:108-146`），没有 happy-path 路由测试 → 回归漏网 |
| 31 | 旧签核不被历史文件遮蔽 | 🟨 | `server.mjs:771-781` 对 `kind==='signoff-record'` 一律返回 true（旧 W5 记录也命中），`:783-790` 取首条 → 真实机器 `artifacts/evidence/signoff/…-4294f5e52207.json`（`kind:'signoff-record'`、`decision:'reject'`、无 passed/roles）仍被当成"交付签核"并遮蔽更早有效签核（P1-1；只读复现见 §5-C） |
| 32 | readiness 入参真实（服务端编译+真实 PCB 执行+DRC pass+manifestHash） | ✅ | `src/pages/AssetsPage.tsx:68-124`；`src/services/releaseBindingStore.ts:78-85`；`runtime/production.mjs:498-532`（全部服务端重算） |
| 33 | readiness inputs 被产品内消费 | 🟥 | `saveReadinessInputs` 写入 sessionStorage（`AssetsPage.tsx:120`），`readReadinessInputs` **只有测试在读**（`src/services/releaseBindingStore.ts:34-44`；唯一引用 `releaseBindingStore.test.ts:21`）；真实交接走另一个 key `circuitpilot:release-binding`（`AssetsPage.tsx:123` ↔ `ValidationPage.tsx:64-73`）（P2-1） |
| 34 | 首件产物写回被签核/闸门检查的同一个根 | ✅（代码） | 默认 `outDir=productionArtifactsRoot`（`runtime/production-export.mjs:108-110`；`server.mjs:2694-2698`）；草稿也能写该根，本机 `deliverables/` 已有根级 `GERBER_/BOM_/CPL_-DRAFT-*` 实迹 |
| 35 | 正式导出/归档在真实 EDA 上端到端 200 | ⬜ | 未真机复验；且 #26/#27 的静态推理表明当前代码路径会先被 MISMATCH/DRIFT 挡住（见 §4） |

### 2.4 证据索引/保留/时间线/归档 UI 消费者（⑤）

| # | 节点 | 判定 | 证据（file:line） |
|---|---|---|---|
| 36 | 证据索引（C5）有 UI 消费者 | ✅ | `runtime/evidence-index.mjs`；`server.mjs:3687-3708`；`VersionsPage.tsx:265-296`（读取/按 digest 查找/坏文件明示） |
| 37 | 证据保留计划（dry-run，无删除能力） | ✅ | `server.mjs:3699-3727`；`VersionsPage.tsx:272-296`；破坏性 prune 需 confirm+写批准（`server.mjs:3709-3727`） |
| 38 | 制造物保留计划（B10 dry-run） | ✅ | `runtime/artifact-retention.mjs`；`server.mjs:3728-3752`；`VersionsPage.tsx:140-141,296` |
| 39 | 统一时间线 + digest→run 显式关联（C3） | ✅ | `runtime/timeline.mjs`、`runtime/timeline-links.mjs`；`server.mjs:2053-2075`；`VersionsPage.tsx:230-251` |
| 40 | 发布版本只读列表 + 逐文件重校验（B8） | ✅ | `server.mjs:2597-2604`；`VersionsPage.tsx:301-326` |
| 41 | 只读值守队列（Supervisor）有 UI | ✅ | `runtime/supervisor.mjs`；`src/components/SupervisorPanel.tsx` 挂载于 `src/pages/OverviewPage.tsx:164` |

### 2.5 边界（不算缺陷）

| # | 节点 | 判定 | 证据 |
|---|---|---|---|
| 42 | 下单/支付永久禁入 | 🚫 | `release-decision.mjs:114` `orderEnabled:false`；`production.mjs:528`；无下单路由 |
| 43 | Demo/seed 被当官方证据的写入路径 | ✅ 不存在 | official 唯一写入口在验证页真实取证回调；Demo 按钮在 demo 模式禁用（`ValidationPage.tsx:1425,1674`）；`mergeDemoValidationRun` 保留 official |

---

## ③ 修复建议（精确文件 / 行为 / 测试 / 风险 / 是否需真机）

### P0

**P0-1｜六门"可签"不成立：G1/G2/G3/G5 的产品输入通道缺失**
- 行为（诚实口径，优先、无需真机）：对没有完整产品输入通道的门，在 `runtime/gate-engine.mjs:15-22` 增加 `implemented:false` + `unimplementedReason`（例如 G1「缺 boards 输入」、G2「缺 EDA/供应商/资料三源」、G3「缺意图网表」），或保留 `implemented:true` 但把 `VerificationCenterPage` 的逐门文案改为"本门产品内暂无完整输入通道，需脚本/后续接线"，并同步修正 `flow-gap-audit-2026-10-29.md` §0.1 的"六门全接/可签"表述。
- 行为（补通道，按门拆）：
  - G5（纯前端，最小改动、无需真机）：`PlacementPage.tsx` 写回前增加人工确认勾选 → `applyPlacement` 传 `userConfirmed`，`runtimeClient.ts:759` 补类型；服务端已支持（`server.mjs:3147`）。
  - G1：`collectEvidence` 传 `specInput.boards`（来自项目/EDA 回读的板框+层数），或改用已校验 spec 注册表。
  - G2：把已有的 `easyEdaBinding`（`AssetPage` 绑定结果）映射为 `eda`，把供应链价格/库存证据映射为 `supply`，datasheet 核验结果映射为 `datasheet` 后再 collect。
  - G3：从"已审核网表/design-spec.netIntent"取意图网表，随 collect 传 `intentNetlist`。
- 测试：`runtime/__tests__/gates-evidence.test.mjs` 增加"UI 形状载荷"用例（当前测试用的是完整三源输入，见 `:29-37,61`，掩盖了 UI 通道缺口）；`VerificationCenterPage` 加前端测试断言 missing 原因可读。
- 风险：标未实现会降低"六门"卖点；补 G2 需引入联网/供应链数据源（与 G4 红线无关，但要做时效与来源标注）。
- 是否需真机：口径修正 + G5 通道**无需真机**；G1/G2/G3 的通道接线代码可离线完成，但"真实 pass"必须真机数据。

**P0-2｜签核锚点/导出/归档 manifest 哈希域不一致（`projectName` 丢失）**
- 行为：在 `runtime/release-binding.mjs` 新增单一 `normalizeManifestBinding(input)`，readiness/export/archive 全部用它；二选一：
  - 方案 A（推荐、无需迁移）：`server.mjs:2616-2625`（exportBinding）与 `:2555-2563`（archiveBinding）从 `body.binding.projectName` 兜底补 `projectName`；同时 `releaseBindingRequestFields`（`src/services/releaseBindingStore.ts:61-76`）把 `projectName` 提到顶层。
  - 方案 B：`runtime/production.mjs:436` 从 `manifestCore` 移除 `projectName`（显示名不应进入物料身份），但会使历史签核哈希失效，需要迁移说明。
- 测试（关键缺口）：新增 HTTP 级"readiness（带 projectName）→ signoff → `requested:'final'` 导出 → archive"happy-path 用例（可用 `production-release.test.mjs` 的假桥 payload 手法，不需要真机 EDA），断言 `releaseDecision.ready===true`、导出 200、`signoffAnchor.matched===true`、归档 200 且 `binding.manifestHash === signoff.payload.manifestHash`；并断言三处 recompute 相等。
- 风险：改哈希域会让"旧签核"失效（方案 B），方案 A 向后兼容更好。
- 是否需真机：**无需真机**（假桥即可覆盖路由/哈希一致性），真机只补"真实重导字节稳定性"。

### P1

**P1-1｜旧 W5 `signoff-record` 仍遮蔽有效交付签核**
- 行为：`server.mjs:771-781` 的 `isReleaseSignoffPayload` 对 `kind==='signoff-record'` 也要求 `payload.passed===true && roles.length>0`（并拒绝带 `decision/gateVerdict/reportDigest` 的门禁终审形状）；`:783-790` 保持向前扫描直到命中有效签核。
- 测试：HTTP 用例——先落有效 signoff，再落旧 gate-report + 旧 W5 signoff-record（`decision:'reject'`、无 passed/roles）→ `signoff/latest`、`releaseDecision`、readiness 仍取有效签核。可用现网真实文件的复制样本。
- 风险：极低（收紧谓词）。
- 是否需真机：**不需要**。

**P1-2｜gate/export/archive 三处 `releaseDecision` 输入域不同 → 按钮亮、点下必败**
- 行为：gate 路由（`server.mjs:2506-2508`）也用完整 binding（含 manifestHash/DFM/签核域）计算 `releaseDecision`，并在响应里额外给 `exportReady/archiveReady`；UI 解锁改为读服务端预检结果（`ValidationPage.tsx:1869,1875,1887`）。
- 测试：同一组证据下三处 `releaseDecision.ready`/`blockedBy` 逐项一致；UI 解锁 == 导出/归档实际成功。
- 风险：gate 响应字段变更，需同步 `src/types.ts` 与前端。
- 是否需真机：**不需要**（HTTP + 假桥）。

**P1-3｜`validation-state` 接受客户端伪造 official 记录**
- 行为：`runtime/server.mjs:1940-1947` 在保存前校验每条 `source==='official'` 记录：`evidence.digest` 必须存在于 evidenceStore（ERC→`schematic-erc`、DRC→`drc-report`），且 `evidence.path`/fingerprint 的项目/板与 `projectId`/记录一致；不一致 409 `VALIDATION_EVIDENCE_UNKNOWN`/`..._MISMATCH`，不落盘。或改为服务端从 evidenceStore 派生官方记录（GET 时合成）。
- 测试：`runtime/__tests__/validation-state.test.mjs` 增加"伪造 digest / 别项目 digest / 过期 executionId"三例必须 409；现网真实 evidence 文件做正例。
- 风险：旧版本已落盘的 `validation-state.json` 可能含不合法记录 → 迁移策略（读时降级为非 official 并在 UI 明示，而不是 500）。
- 是否需真机：**不需要**（夹具证据文件）。

**P1-4｜门禁证据无新鲜度/失效判定**
- 行为：`runtime/gates-service.mjs:33-45` 对每类证据调用 `assessEvidenceFreshness`（`runtime/evidence-freshness.mjs`，注入当前 EDA 指纹与 maxAge），过期/指纹不符 → 该门 verdict `unknown` 并在 reasons 明示；最近一次设计变更/执行时间晚于证据 savedAt 时也判 unknown。
- 测试：`gates-service.test.mjs` 增加过期证据/换板证据两例，断言不会 pass。
- 风险：现有"最新一条"语义变化会更多显示 unknown（诚实但更严格）。
- 是否需真机：**不需要**（注入 now/current fingerprint）。

**P1-5｜`pcbUuid` 绑定来源不一致（默认"留空=当前 PCB"反而恒 blocked）**
- 行为：`ValidationPage.tsx:913,954`（DFM/签核）与 `:1091,1324`（归档/闸门）统一 derivation：都 `gatePcb.trim() || activeProject?.edaWorkspace?.pcbUuid`；并把 `pcbUuid` 放进 readiness 交接 binding（`AssetsPage.tsx:104-112,123` 目前没有 pcbUuid，可用 `manifest.documentId`）。
- 测试：单测/HTTP——项目已绑定、输入留空时，签核指纹 `pcbUuid` 与 gate/export 绑定一致，`releaseDecision` 不因"签核未绑 pcbUuid"被拒。
- 风险：低。
- 是否需真机：**不需要**。

### P2

| # | 问题 | 修法（文件） | 无需真机 |
|---|---|---|---|
| P2-1 | readiness inputs 死存储 + 两个 sessionStorage key 分裂 | 让 `readReadinessInputs()` 或有删除/让 `saveReadinessInputs` 直接写 `circuitpilot:release-binding`（`releaseBindingStore.ts:28-48`；`AssetsPage.tsx:120,123`） | 是 |
| P2-2 | 锚点哈希覆盖整个 artifacts 根（含 `manifest.json`、他批次/他项目文件） | `production-export.mjs:141-167` 只对"本次 kinds 的文件集合 + 明细"算锚点（或按子目录隔离 projectId），避免无关文件触发漂移 | 是 |
| P2-3 | 换机/新 state 时 evidence→KPI 无回填 | 启动时若 validation-state 为空则从 evidenceStore 最新 ERC/DRC 生成 official 记录（`ValidationPage.tsx:417-430,747-751`；服务端加 `/api/validation-state/rehydrate` 或派生） | 是 |
| P2-4 | DFM 语义计划哈希不预填（签核已预填） | `ValidationPage.tsx:1080-1083` 同法把 `handoff.binding.semanticPlanHash` 预填到 `dfmPlanHash`（`:1958`） | 是 |
| P2-5 | `gate-signoff`/`gate-report` 无下游消费者 | 明确二选一：让 releaseDecision 把 `gate-signoff`（最近一次 pass）作为附加证据并展示，或在文档/UI 标注"W5 签字仅为门禁看板留痕，不驱动放行"（`gates-service.mjs:58-94`；`server.mjs:2508`） | 是 |
| P2-6 | archive `reviewHash` 用 signoff digest 顶替终审 reviewHash | `server.mjs:2565` 用 `productionManager.finalReview` 记录的 reviewHash，或改名 `signoffHash` 并在类型/UI 同步（`release-archive.mjs:166`；`production.mjs:479-491`） | 是 |
| P2-7 | 版本快照 `validationStatus` 仍混入 demo/seed | `VersionsPage.tsx:182` 改用 `validationKpis(state.validations, activeProject?.id)` 的 official 口径 | 是 |

---

## ④ 需真机 / 未验证边界（不冒充打通）

1. **六门真实 pass 与签字**：G1 需要真实 design-spec/板框，G2 需要真实器件 EDA/供应商/资料三源，G3 需要真实意图网表与 EDA 实际网表，G4 需要真实官方 ERC/DRC，G5 需要真实布局写回+人工确认，G6 需要真实制造产物。本轮未连 EDA/Bridge，只证明"生产者函数可被完整输入驱动"（单测）与"产品输入通道缺口"（静态+路由体形状）。
2. **正式导出/归档 happy path**：`/api/production/export`、`/api/production/releases/archive` 的 200 路径均未真机复验；本轮静态+只读哈希实验表明当前 binding 域先会返回 `RELEASE_MANIFEST_MISMATCH` / `RELEASE_ARCHIVE_MANIFEST_DRIFT`（fail-closed）。修 P0-2 后仍需真机跑一次"readiness→signoff→final 导出→归档"。
3. **真实重导字节确定性**：签核→重导出是否因 EDA 输出非确定性而频繁触发漂移，只能真机复导观察（且锚点当前按整目录比对，见 P2-2）。
4. **DRC 证据绑定**：真机 `pcb.job.poll` 返回形状、以及 `pcbUuid` 是否可由 UI 自动取得（而非手填），需真机验证。
5. **官方 KPI 刷新一致性**：同机重启已由隔离 HTTP 测试证明；"换机/清 state"场景需要一次真实换机演练（P2-3 修复前会显示 0/2，不冒充一致）。
6. 本轮未执行：acceptance、Playwright/live e2e、任何写盘/写 EDA/重启服务；`artifacts/`、`release/`、`deliverables/` 未写。

---

## ⑤ 验证记录（只读复现）

**A. 隔离 runtime 测试（未连真机、未用固定端口；state/evidence 指向系统临时目录）**
```
TMP=$(mktemp -d)
CIRCUITPILOT_STATE_DIR=$TMP/state CIRCUITPILOT_EVIDENCE_DIR=$TMP/evidence \
CIRCUITPILOT_AUTOMATION_DIR=$TMP/automation CIRCUITPILOT_ARTIFACTS_DIR=$TMP/artifacts \
CIRCUITPILOT_RELEASES_DIR=$TMP/releases \
node --test runtime/__tests__/gate-engine.test.mjs runtime/__tests__/gates-evidence.test.mjs \
  runtime/__tests__/gates-service.test.mjs runtime/__tests__/release-decision.test.mjs \
  runtime/__tests__/release-binding.test.mjs runtime/__tests__/validation-state.test.mjs
→ tests 38 / pass 38 / fail 0（2026-11-05T14:53+08:00）
```
```
同上 env；node --test runtime/__tests__/release-archive.test.mjs runtime/__tests__/production-export.test.mjs \
  runtime/__tests__/production-release.test.mjs runtime/__tests__/release-p06-http.test.mjs \
  runtime/__tests__/gates-p05-http.test.mjs
→ tests 37 / pass 37 / fail 0
```
说明：两组测试全绿本身**不能**证明交付链闭环——它们喂的是完整 binding/完整六类输入（`production-release.test.mjs:114-121`；`gates-evidence.test.mjs:29-37,61`），与真实 UI/路由的 binding 域和输入形状不同（本报告 P0-1/P0-2 正是"测试绿 vs 真实路径断"的差）。

**B. manifest 哈希域差异（只读，未写盘）**
```
node --input-type=module -e '
import { inspectProductionArtifacts } from "./runtime/production.mjs";
const base={projectId:"proj-1",documentId:"doc-1",sourceDigest:"d".repeat(64),semanticPlanHash:"p".repeat(64),compiledPlanHash:"c".repeat(64),executionId:"exec-1"};
const withName=inspectProductionArtifacts("deliverables",{...base,projectName:"衣橱助手"}).manifest.manifestHash;
const withoutName=inspectProductionArtifacts("deliverables",base).manifest.manifestHash;
console.log(withName,withoutName,withName===withoutName);'
→ withProjectName   20316bf9bb8e…1b69fa
→ withoutProjectName d1459b87bd94…0ef72194
→ equal: false
```
对应 P0-2：readiness/签核侧带 `projectName`（`AssetsPage.tsx:104-112`），export/archive 路由白名单把它丢弃（`server.mjs:2616-2625,2555-2563`）。

**C. 旧 W5 签核遮蔽（只读，读现网真实证据目录）**
```
node --input-type=module -e '
import { createEvidenceStore } from "./runtime/evidence-store.mjs";
const list = createEvidenceStore({root:"artifacts/evidence"}).list("signoff");
const isRelease=(p)=>p?.kind==="signoff-record" || (p?.kind===undefined && p?.passed===true && Array.isArray(p?.roles) && p.roles.length>0);
console.log(list.map(e=>({savedAt:e.savedAt,kind:e.payload?.kind,passed:e.payload?.passed,roles:(e.payload?.roles||[]).length,decision:e.payload?.decision})));
console.log("latestReleaseSignoff ->", list.find(e=>isRelease(e?.payload))?.digest?.slice(0,12));'
→ 4 条：3×gate-report + 1×signoff-record(decision:"reject", 无 passed/roles, pcb-smoke)
→ latestReleaseSignoff -> 4294f5e52207   （旧门禁驳回记录被当成"交付签核"返回）
```
对应 P1-1：`server.mjs:771-781` 的 kind 谓词未要求 `passed/roles`，`:783-790` 取首条即返回。

**D. 静态核查文件**：`runtime/{gate-engine,gates-evidence,gates-service,release-decision,release-binding,release-gate,production-export,production-release,production,validation-state,evidence-store,evidence-index,artifact-retention,release-archive,timeline,timeline-links,supervisor}.mjs`、`runtime/agents/{librarian,rule-runner,netlist-auditor}.mjs`、`runtime/server.mjs`（gates 2119-2199、release/export 2500-2730、签名/证据 3653-3760、readiness/inspect 4584-4610、DRC/ERC 3510-3604、placement/apply 3127-3155）、`src/pages/{ValidationPage,DeliverPage,VerificationCenterPage,AssetsPage,VersionsPage,PlacementPage,OverviewPage}.tsx`、`src/state/AppContext.tsx`、`src/services/{validationEvidence,stageEvidence,releaseBindingStore}.ts`、`src/data/seed.ts`。

**E. 修复后建议的最小回归集**：`gates-evidence`（UI 形状）+ `gates-service`（新鲜度）+ `release-p06-http`/`release-archive`（happy path + 跨路径 binding 等值）+ `validation-state`（伪造拒绝）+ `gates-p05-http`（旧签核不遮蔽）。全部可用假桥离线跑，无需真机。
