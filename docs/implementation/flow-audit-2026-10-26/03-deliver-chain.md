# 03 · 验证 → 放行 → 导出 → 签核/订单链路

> 审计对象：CircuitPilot「验证（ERC/DRC/仿真/DFM）→ 放行闸门 → 生产文件导出 → 人工终审/签核 → 订单参数/证据归档」链路。
> 审计方式：只读源码 + 本机历史证据文件。**本轮未启动嘉立创EDA/Bridge，未执行任何测试（含 `npm test`/playwright/单文件 vitest）**；凡涉及真机的结论均按「历史证据（日期），本轮未复验」标注。审计日期 2026-10-26，工作目录 `/Users/jescochen/Desktop/AI- PCBA`。
> 判定口径：✅ 已打通（UI→API→runtime 均有实现且有测试或历史证据）；🟨 半打通（有实现但到不了下一步/口径不一致）；🟥 断点（无 UI 入口或后端必死）；⬜ 纸面；🚫 产品边界。

## 0. 结论（按严重度）

1. **[P0] 正式生产导出在默认 UI 接线下不可达（三重死锁）**：① 按钮解锁条件是 `gate.outputDecision.allowed && outputClass==='final'`（`src/pages/ValidationPage.tsx:1617-1624`），但闸门路由始终按 `requested:'final'` 且 `draftPathsReplaced` 为空裁决（`runtime/server.mjs:1734`、`runtime/server.mjs:969-980`），而 `deliverables/` 根目录只有 DRAFT 命名的 gerber/bom/cpl（`deliverables/manifest.json`，2026-10-23T08:55Z；STEP 在子目录）→ 恒为 `STALE_DRAFT_MARKER`（`runtime/production-release.mjs:87-100`）；② 即便解锁，导出端要求 `manifestHash` 等于按 `artifactsDir` 重算的值，UI 唯一来源是 AssetsPage 按 `manufacturing/` 根算出的交接哈希（`runtime/server.mjs:1813-1817`、`runtime/release-binding.mjs:44-61`、`src/pages/AssetsPage.tsx:83`、`runtime/server.mjs:493`），两个产物根不同源；③ 要产出"非草稿命名的产物"又必须先有一次成功的正式导出。历史 final 导出（`release/2026-10-15/manifest.json`，manifest 内 `generatedAt=2026-10-16T02:31Z`、`outputClass:final`、`released:true`）是"人工 DFM+签核"要求（B1/B4）之前的旧规则产物，不能作为当前链路的离线证据。
2. **[P0] 生产就绪 readiness 仍恒不可用——旧的"恒 false"没修好，只是从硬编码变成了入参接线错误**：UI 把语义计划哈希同时当 `compiledPlanHash` 传入、把任务 id 当 `pcbExecutionId` 传入，`compiled-quality`/`official-pcb-drc` 两门必红；未在 AI 任务页生成过计划时直接 `PRODUCTION_PLAN_UNKNOWN` 404（`src/pages/AssetsPage.tsx:49,60,69-78`、`runtime/production.mjs:500,503,506,520`、`src/data/seed.ts:72,77`）。
3. **[P0] W5 验证中心门禁是死路，且其副作用会污染主链签核**：G1/G5/G6 需要的 `design-spec`/`placement`/`fabrication-release` 证据全仓无生产者 → verdict 永远 unknown → "签字放行"永远被拒（`runtime/gate-engine.mjs:9-16`、`runtime/gates-service.mjs:52-58`、`src/pages/VerificationCenterPage.tsx:161`）；更危险的是 `evaluate()` 把门禁报告也写成 `kind:'signoff'`，主链用无指纹过滤的 `evidenceStore.latest('signoff')` 取"最新签核"，新报告会遮蔽真实三方签核，使统一裁决报"签核记录无效"（`runtime/gates-service.mjs:41-50`、`runtime/release-decision.mjs:70-74`、`runtime/server.mjs:1738`；`artifacts/evidence/signoff/` 2026-10-21 同目录内 gate-report 与 signoff-record 两种形状并存）。
4. **[P1] "三套放行口径"从 3 套收成 2.5 套，仍未统一**：`gateFabricationRelease → buildReleaseDecision → decideProductionOutput` 已合并为一条（真修复，见 `runtime/release-gate.mjs:625-667`）；AssetsPage 的 `ProductionManager.readiness` 仍是另一套独立门禁（不同产物根、不同证据输入，`runtime/production.mjs:498-532`）；VerificationCenter 的 G1–G6 是第三套且必死（`runtime/gate-engine.mjs:9-16`）。三页可同时给出三种结论。
5. **[P1] 价格/库存/DFM 已"进闸门、进订单卡"，但只作 warning，不阻断任何结论**：`gateSupply` 缺价/缺货/过期只产生 warning（`runtime/release-gate.mjs:467-495`），不影响 `ready`（`:640-642`）；订单卡 `readyToOrder` 只看 blocking/unknown（`runtime/fabrication-order.mjs:172-178`），`supplySummary` 的缺货/过期不参与；人工确认只查 `readyToOrder+操作人+paymentManual`（`runtime/order-confirmation.mjs:22-36`）。本机 `artifacts/evidence/dfm-evidence/`、`artifacts/evidence/order-confirmation/` 目录从未生成过 → 这两步在真机上一次都没走通。
6. **[P1] 归档（B8）强制要求 planHash，UI 却标"可留空"**：`runtime/release-archive.mjs:104` 硬性要求 planHash、`:105` 要求 manifestHash、`:106` 要求 reviewHash；而签核表单把"语义计划哈希"标注为可留空（`src/pages/ValidationPage.tsx:1713`），归档按钮只判 ready（`:1636`），未走 Assets 交接时归档必然 400 `RELEASE_ARCHIVE_BINDING_INVALID`。

## 1. 链路现状表

| # | 环节 | 用户动作 | UI / 代码位置 | 后端路由 / 模块 | 判定 | 证据 |
|---|---|---|---|---|---|---|
| 1 | ERC 取证 | 运行 ERC / 拉最新 | `runErc`/`loadLatestErc` `ValidationPage.tsx:522,544` | `POST /api/eda/schematic/erc/run`、`PUT .../exemptions`；证据 kind `schematic-erc` | ✅ | 历史真机 `artifacts/a13-erc/real-machine-erc-repairs-20261019T130258Z.json`（2026-10-19）；`runtime/__tests__/erc-http.test.mjs`（文件日期 2026-10-19，未执行） |
| 2 | DRC 取证 | 一键 DRC / 取消 / 拉最新 | `runPcbDrc` `ValidationPage.tsx:357`；取证后自动填闸门路径 `:342,398` | `/api/eda/pcb/drc/run / report / cancel`、`runtime/drc.mjs`；证据 kind `drc-report` | ✅ | 历史 `artifacts/evidence/drc-report/*`（2026-10-19/20）；`runtime/__tests__/drc-evidence.test.mjs`（2026-10-23，未执行） |
| 3 | DRC 豁免 | 编辑/保存豁免 | `loadExemptions`/`saveExemptions` `ValidationPage.tsx:442,482` | `GET/PUT /api/eda/pcb/drc/exemptions`；闸门默认读盘 | ✅ | `runtime/release-gate.mjs:268`、`runtime/server.mjs:1311`（缺省 `loadDrcExemptionFileForCurrentProject`） |
| 4 | ERC 豁免 | 保存 ERC 豁免 | `saveErcExemptions` `ValidationPage.tsx:566` | `PUT /api/eda/schematic/erc/exemptions`；`applyErcExemptions` 只在 ERC 取证路由 | 🟨 不进入放行闸门 | `runtime/server.mjs:2722,2740-2744`；`runtime/schematic-acceptance.mjs:120-155` 无豁免参数 |
| 5 | SPICE/仿真取证 | 运行仿真并落证据 | `runSimulation` `ValidationPage.tsx:611` | `POST /api/eda/schematic/simulation/run`（真 spawn 求解器）；证据 kind `spice-simulation` | ✅ | 历史 `artifacts/a14-simulation/*`（2026-10-19）；本机现有 `/opt/homebrew/bin/ngspice`（本轮 `which` 确认）；`runtime/__tests__/simulation.test.mjs` |
| 6 | 仿真→闸门 | 重跑闸门消费仿真 | 闸门内部 `loadSimulationEvidence` 回退 | `runtime/server.mjs:560-590`、`runtime/schematic-acceptance.mjs:258-292` | 🟨 回退路径丢 `partial` 标记，可能被判 pass | `runtime/release-gate.mjs:207-237` 对比 `runtime/server.mjs:1068`（显式路径 `partial:true`） |
| 7 | 本地/联网 DFM | 出 DFM 结论 | 无本地 DFM 路由，只跳外部门户 | 无（在线 DFM 不在本系统） | 🚫 产品边界（人工门户） | `src/pages/AssetsPage.tsx:143`、`runtime/server.mjs:2746` |
| 8 | DFM 证据登记 | 选结论+填操作人保存 | `submitDfm` `ValidationPage.tsx:700` | `POST /api/production/dfm-evidence`（只登记人看过的结论） | 🟨 纯人工自报，无 URL/回执/上传件 | `runtime/server.mjs:2746-2762`；UI 未传 `url/artifacts` |
| 9 | 放行闸门 | 填 PCB/产物目录/DRC 路径→跑闸门 | `runReleaseGate` `ValidationPage.tsx:1097`；勾人工确认 `:1535` | `POST /api/eda/release/gate` → `gateFabricationRelease` + `buildReleaseDecision` | 🟨 取证齐全，但正式导出解锁条件不可达 | `runtime/release-gate.mjs:625-667`、`runtime/server.mjs:1732-1739` |
| 10 | 生产就绪 readiness | Assets 页"检查生产资料"→"运行 readiness" | `inspectProduction`/`runReadiness` `AssetsPage.tsx:45,57` | `/api/production/artifacts/inspect`、`/api/production/readiness` → `ProductionManager` | 🟥 恒不可 ready（入参接线错） | `runtime/production.mjs:498-527`；`src/pages/AssetsPage.tsx:49,60,69-78` |
| 11 | 草稿导出 | 导出草稿文件 | `runExport('draft')` `ValidationPage.tsx:909` | `POST /api/production/export` → `decideProductionOutput` + `runProductionExport` | ✅ | 历史 `release/2026-10-16/19/20/22/23/manifest.json`（2026-10-16~23，DRAFT 命名）、`deliverables/manifest.json`（2026-10-23T08:55Z `outputClass:draft` `released:false`） |
| 12 | 正式导出 | 导出正式生产文件 | 按钮 `ValidationPage.tsx:1617-1624` | 同上 + `verifyExportManifestBinding` + releaseDecision 双钥匙 | 🟥 默认接线不可达（见 §2 A1） | `runtime/server.mjs:1809-1871`、`runtime/release-binding.mjs:30-64` |
| 13 | 3D 导出 | 导出 STEP/GLB | `pcb3dExport` `ValidationPage.tsx:425-440` | `POST /api/pcb/3d/export`（分片/总时限/头校验/落盘字节校验） | ✅ | 历史 `deliverables/pcb-3d/*.step`（2026-10-22/23，7–41MB）、`release/2026-10-22/STEP_...DRAFT...step`；`runtime/server.mjs:3250-3306` |
| 14 | 人工终审签核 | 三位签字 + 物料清单哈希 | `submitSignoff` `ValidationPage.tsx:740` | `POST /api/production/signoff` → 证据 kind `signoff` + 账本 scope `release/issued` | 🟨 落盘真实，但与 W5 共用 kind 会被遮蔽 | `runtime/server.mjs:2786-2813`；`artifacts/evidence/signoff/*`（2026-10-21，历史样本多为 W5 形状） |
| 15 | 发布归档 B8 | 点"归档为发布版本" | `archiveReleaseVersion` `ValidationPage.tsx:882` | `/api/production/releases/archive` → `createReleaseArchiveStore`（`wx` 只追加、无 update/delete、读取重算哈希） | 🟨 机制真实，属性可达性依赖 planHash 手填与 ready | `runtime/release-archive.mjs:82-106,56-73`；真机拒绝证据 `artifacts/b8-release-archive/`（2026-10-20：409 + `releases:[]` + 404） |
| 16 | 订单参数卡 | 填工艺参数→生成参数卡 | `runOrderCard` `ValidationPage.tsx:1011` | `POST /api/production/order-card` → `buildFabricationOrder`（有价格证据时附 `summarizeSupplyEvidence`） | 🟨 参数自洽可做，缺货/价格不阻断 `readyToOrder` | `runtime/fabrication-order.mjs:165-178`、`runtime/supply-summary.mjs:44-52`、`runtime/server.mjs:2188-2193` |
| 17 | 下单确认/支付 | 人工确认参数卡 | `submitOrderConfirmation` `ValidationPage.tsx:721` | `POST /api/production/order-confirmation` → `validateOrderConfirmation`（不代下单、不代付） | 🚫 产品边界（系统永久禁用） | `runtime/order-confirmation.mjs:22-53`、`runtime/release-decision.mjs:114`（`orderEnabled:false`） |
| 18 | 证据时间线/追溯 | 读时间线、证据索引、发布版本重校验 | `loadTimeline`/`loadEvidenceIndex`/`loadReleaseArchives` `VersionsPage.tsx` events 页 | `GET /api/timeline`（journal+账本+证据三源）、`GET /api/evidence/index`、`GET /api/production/releases` | ✅ | `runtime/server.mjs:1475-1490,2818`、`runtime/timeline.mjs`、`runtime/evidence-index.mjs:21-27,165-215` |
| 19 | 版本/回滚 | 创建快照/回滚/看版本时间线 | `snapshot`/`rollback` `VersionsPage.tsx:181-188` | `/api/trace-state` 读写（AppContext 防抖持久化） | 🟨 持久化真实，但版本内容为客户端造数 | `src/state/AppContext.tsx:416-418,455-459`、`runtimeClient.ts:148,159`；`VersionsPage.tsx:181-188`（`designObjects:148` 硬编码、回滚仅 Demo） |
| 20 | W5 门禁 G1–G6 | 评估并归档报告 / 签字放行 | `VerificationCenterPage.tsx:56-95` | `/api/eda/gates/status / evaluate / signoff` → `gate-engine`/`gates-service` | 🟥 永远 unknown/blocked，且污染主链 signoff | 见 §2 A3；`runtime/gate-engine.mjs:9-16`、`runtime/gates-service.mjs:41-66` |

## 2. 断点/半打通明细

### A1 · 正式生产导出三重死锁（P0）
- **用户视角**：按页面顺序把 ERC/DRC/仿真/DFM/签核都做完、闸门也点过了，但"导出正式生产文件"按钮始终灰；即使强行调接口，也会被 `RELEASE_MANIFEST_BINDING_REQUIRED`/`RELEASE_MANIFEST_MISMATCH` 或 `RELEASE_DECISION_BLOCKED` 挡住。
- **代码位置**：解锁条件 `ValidationPage.tsx:1617-1624`；闸门恒定 `requested:'final'` 且 `draftPathsReplaced=[]`（`runtime/server.mjs:1734`、`runtime/server.mjs:969-980`，UI 的 `releaseGate` 请求体无 `requested` 字段 `runtimeClient.ts:653`）；草稿标记判定 `runtime/production-release.mjs:87-100`、`:91`；导出端重算/绑定 `runtime/server.mjs:1809-1817`、`runtime/release-binding.mjs:44-61`；两个产物根 `runtime/server.mjs:493`（`manufacturing/`）vs `runtime/server.mjs:1812`（`body.artifactsDir`，缺省 `deliverables/`）；交接哈希来源 `AssetsPage.tsx:60-83`。
- **影响**：正式件与"已放行"状态在本机永远产不出；B8 归档、正式命名交付、以正式件为准的下单参数卡全部连坐。用户看到的是"每一步都做了，最后一步永远不行"。
- **建议修复**：① 闸门路由接收 `requested`/`draftPathsReplaced` 并把"本次将被覆盖的自产草稿"传入（与导出路由对齐）；或把 `outputDecision` 从闸门报告中拆出、由导出路由唯一计算；② 产物根统一：readiness/inspect 与 gate/export 都吃同一个显式 `artifactsDir`（默认同一目录），`manifestHash` 由当前流程目录重算；③ UI 允许显式粘贴/展示当前目录的 `manifestHash`，消除对 Assets 页 sessionStorage 的隐式依赖。
- **验收方式**：在无 EDA 的离线夹具目录上跑：草稿导出 → 同一目录重跑闸门应出现 `outputDecision.allowed:false, code:STALE_DRAFT_MARKER`（现状）；修复后应允许"以本次导出覆盖草稿"，且正式导出返回 `exported:true, outputClass:'final', released:true`，manifest 中 `manifestHash` 可由同目录重算复现（新增集成测试覆盖）。

### A2 · 生产就绪 readiness 恒不可用（P0）
- **用户视角**：Assets 页"运行 readiness 复核"，要么 404"语义计划未登记"，要么 6 门里 `compiled-quality`、`official-pcb-drc` 永远红；即使界面上显示"已检查生产资料"，也永远到不了 ready，自然拿不到可用于签核/导出的可信交接状态。
- **代码位置**：`runtime/production.mjs:500`（计划未登记即 404）、`:503`（`pcbExecutionId` 查执行）、`:506`（`compiledPlanHash` 比对）、`:520`（官方 DRC）；UI 传参 `src/pages/AssetsPage.tsx:73-78`（`compiledPlanHash: planHash`）、`:49`（`executionId: state.task.id`）、`:76`（`pcbExecutionId: manifest.executionId || state.task.id`）；种子值 `src/data/seed.ts:72,77`。
- **影响**：跨页释放链路（生产就绪 → 签核 → 正式导出）的主入口不可用；用户会误判为"设计没过门禁"，实际是接线错误。
- **建议修复**：AssetsPage 调 `productionManager.compile`（或 readiness 响应回传 `referenced.compiledPlanHash`）后再传 compiled 值；`pcbExecutionId` 取真实 PCB 执行记录 id（EDA 页执行历史）而非任务 id；计划未登记时 UI 引导去 AI 任务页生成而不是报 404。
- **验收方式**：新增服务端测试：登记计划（normalize）→ readiness 传入 `referenced.compiledPlanHash` 与真实 executionId → `compiled-quality`/`official-pcb-drc` 依真实执行结果判定，而非恒定 false；UI 端到端用例断言 readiness 不再因入参形状必然 blocked。

### A3 · W5 门禁 G1–G6 必死 + `signoff` 证据 kind 污染主链（P0）
- **用户视角**：验证中心里无论怎么补证据，"签字放行"按钮都是灰的；更怪的是：明明在验证页完成过三方签核，放行统一裁决却报"签核记录无效"。
- **代码位置**：G1/G5/G6 所需 kind 无生产者 `runtime/gate-engine.mjs:9-16`；签字门槛 `runtime/gates-service.mjs:52-58` + UI 禁用 `VerificationCenterPage.tsx:161`；报告与签核都写 `kind:'signoff'` `runtime/gates-service.mjs:41-50`、`:59-66`；主链无指纹取最新签核 `runtime/server.mjs:1738`（gate）、`:1752,1762,1816`（release/归档/export 内 `evidenceStore.latest('signoff')`；readiness 同病 `:3684`），裁决只认 `payload.passed===true && roles.length>0` `runtime/release-decision.mjs:74`。
- **影响**：① 第三套门禁完全不可用；② 用户在验证中心点一次"评估并归档报告"，就会在证据目录留下无 `passed` 的 signoff 条目，遮蔽真实签核，使放行链"看起来没签核"；跨板同样受影响（无指纹过滤）。历史样本 `artifacts/evidence/signoff/signoff-2026-10-21T14-50-58-566Z-80c6ddeb1e33.json`（`payload.kind=gate-report`）与 `...14-51-06-757Z-4294f5e52207.json`（`payload.kind=signoff-record`）共存即证据（2026-10-21，`pcb-smoke` 冒烟数据）。
- **建议修复**：W5 报告改用独立 kind（如 `gate-report`/`gate-eval`），`signoff` 只留给人工签核；主链取签核时带指纹过滤（`pcbUuid`/`manifestHash`/`planHash`），或按 `payload.kind==='signoff-record'` 且 `passed===true` 过滤；为 G1/G5/G6 补证据生产者，或在 UI 明示"该页为规划中/未接线"。
- **验收方式**：单测：写入一条 W5 报告后再写三方签核 → `latest('signoff')` 必须返回签核记录，`buildReleaseDecision.ready` 不受 W5 报告影响；门禁状态：三块 kind 缺失时 UI 显示"未接线"而不是可点击的"签字放行"。

### A4 · 三套放行口径仍未统一（P1）
- **用户视角**：验证页说"可放行"、Assets 页说"blocked"、验证中心说"unknown"，不知道信哪个。
- **代码位置**：口径 A `runtime/release-gate.mjs:625-667`（gate+outputDecision）+ `runtime/release-decision.mjs:54-124`；口径 B `runtime/production.mjs:498-532`；口径 C `runtime/gate-engine.mjs:9-16` + `runtime/gates-service.mjs`。
- **影响**：同一份证据得到三种结论；"能不能放行"没有单一权威答案，审计与自动化都无锚点。
- **建议修复**：把 readiness 的 6 门降级为"放行报告的一个子门视图"，或让 readiness 直接消费 `gateFabricationRelease` 的结果；三页共用同一份 `releaseDecision` 对象与指纹。
- **验收方式**：同一组离线证据（acceptance/DRC/产物/DFM/signoff）分别打三个接口，断言 `ready/blockedBy` 完全一致（新增跨路由一致性测试）。

### A5 · 价格/库存/DFM 只作 warning，不阻断；订单确认不校验供应链（P1）
- **用户视角**：BOM 里料号库存 0、价格过期 3 天、DFM 是"我听人说没问题"式自报，仍能生成"参数自洽"下单卡并完成人工确认。
- **代码位置**：`runtime/release-gate.mjs:467-495`（价格缺失/料号非 LCSC/过期 → warning；`ready` 只看 blocking/unknown `:640-642`）；`runtime/fabrication-order.mjs:165-178`；`runtime/supply-summary.mjs:44-52`；`runtime/order-confirmation.mjs:22-36`；DFM 登记只存 `passed/operator/conclusion` `runtime/server.mjs:2746-2762`。
- **影响**：缺货/涨价/DFM 真阻断可以带病走到"可下单参数"；而这些恰是下错单最贵的错误。
- **建议修复**：把"缺货/价格未知/DFM 未通过/过期"提升为下单卡的 `blocking`（或单独 `orderBlocking`），订单确认接口同时校验 `supplySummary.findings` 无 blocking；DFM 证据要求附 URL/截图/上传件哈希，否则 `passed:true` 不接受。
- **验收方式**：构造 `stock:0` 与 `checkedAt=72h 前` 的 pricing → 断言卡片 `readyToOrder:false`、订单确认 409；DFM 证据缺 URL/附件时保存应被拒或降级为 `unknown`。

### A6 · 归档要求 planHash，但 UI 标"可留空"（P1）
- **用户视角**：闸门 ready 后点"归档为发布版本"，得到 400"归档必须绑定 planHash"，而表单上该字段写着可留空。
- **代码位置**：`runtime/release-archive.mjs:104-106`；归档路由取 `body.planHash` 或签核证据里的 planHash `runtime/server.mjs:1763-1764`；UI 不传 planHash `src/pages/ValidationPage.tsx:882-900`；字段提示"可留空" `:1713`。
- **影响**：B8 不可变发布版本的创建路径在正常填表下必然失败，用户只能靠 sessionStorage 交接的隐藏预填（`:875-880`）。
- **建议修复**：归档 UI 直接展示/预填交接的 `semanticPlanHash` 并标必填；或降低服务端要求（planHash 缺失时用 manifestHash+reviewHash 即可，planHash 可空且如实记 null）。
- **验收方式**：无交接 sessionStorage 场景下，签核时不填 planHash → 归档应给出可操作提示（UI 阻止提交/预填），而不是点击后 400。

### A7 · 仿真部分证据经 acceptance 回退可在闸门被判 pass（P1）
- **用户视角**：只跑过关键子电路（非整板）仿真，闸门"仿真验收"却显示通过，用户以为整板仿真过了。
- **代码位置**：显式证据路径正确置 `partial:true` `runtime/server.mjs:1064-1075` 且闸门判 unknown `runtime/release-gate.mjs:225-234`；但 acceptance 回退构造的 `reused` 不含 `partial` `runtime/schematic-acceptance.mjs:258-292`，return 的 `simulation` 也无 partial `:320-321`，闸门因此走 `else` 分支给 info `runtime/release-gate.mjs:235-237`。
- **影响**：同一份关键子电路证据，两条入口两个结论；"覆盖范围"提示被降级为普通 info，容易被当成整板通过。
- **建议修复**：acceptance 回退时保留 `partial/coverage/scopeNote` 并在 gate 判 unknown（与显式路径一致）；或两条路径共用同一校验函数。
- **验收方式**：同一份 `artifacts/evidence/spice-simulation/*` 分别走显式 `simulationEvidence` 与 acceptance 回退，断言 simulation 门状态一致（unknown）。

### A8 · ERC 豁免不进入放行闸门（P2）
- **用户视角**：页面里保存了 ERC 豁免、ERC 取证报告已"已豁免"，但闸门重跑 ERC 时仍把同类错误当 blocking。
- **代码位置**：`applyErcExemptions` 只在 `POST /api/eda/schematic/erc/run` 生效 `runtime/server.mjs:2722`；闸门重跑验收 ERC `runtime/schematic-acceptance.mjs:120-155` 无豁免入参，`gateSchematic` 也无豁免概念 `runtime/release-gate.mjs:179-188`。
- **影响**：用户必须"真的改掉"或永远被挡；页面上的豁免看起来生效、实际只在取证报告中生效。
- **建议修复**：acceptance/gate 读取默认 ERC 豁免文件并传入 `normalizeErcReport`/逐条比对；或在 UI 明确"ERC 豁免不参与放行闸门"。
- **验收方式**：保存一条 ERC 豁免后重跑闸门，`schematic` 门应对应 finding 从 blocking 降为 warning/info，并记录豁免路径。

### A9 · 追溯与死亡代码：版本节点不绑定计划/归档、仍有直连终审路由（P2）
- **用户视角**：版本时间线只能看到"手动快照/回滚事件"，看不到它对应哪份 planHash/manifestHash；归档记录也不会出现在版本节点里；"回滚"确认框写着 Demo。
- **代码位置**：版本项客户端生成 `src/pages/VersionsPage.tsx:181-188`（`designObjects:148` 硬编码、`id:ver-${Date.now()}`、回滚仅 dispatch + Demo 文案）；归档记录无 versionId 字段 `runtime/release-archive.mjs:116-150`；`/api/production/reviews/final` 仍存在但 UI 不用（`runtimeClient.ts:505-507` `@legacy`、`runtime/server.mjs:3687`）；`/api/production/releases/[id]`、`/api/production/plans/normalize` 无 UI 消费者。
- **影响**：发布追溯链缺"版本 ↔ 计划 ↔ 物料清单 ↔ 归档"这一环；用户无法从版本节点证明"这次的发布版本对应哪一版设计"。
- **建议修复**：版本快照绑定 `semanticPlanHash/compiledPlanHash/manifestHash/releaseId`；归档记录写入 versionId 并允许从版本节点跳转；删除或标注死路由。
- **验收方式**：归档后版本页能显示 `releaseId + planHash + manifestHash` 三关联；无 UI 的路由在路由表标注 deprecated/仅测试。

## 3. 已确认打通（附证据）

1. **草稿生产导出真实落盘**：`runtime/production-export.mjs` 先裁决后写盘、草稿强制 DRAFT 命名、落盘后复核；历史 `release/2026-10-16/19/20/22/23/manifest.json`（2026-10-16~23）与 `deliverables/manifest.json`（2026-10-23T08:55Z，`outputClass:draft, released:false`）证明曾真实产出。
2. **证据落盘与哈希校验 fail-closed**：原子写 + 读取重算 digest、坏文件抛 `EVIDENCE_CORRUPT`（`runtime/evidence-store.mjs:63-118`）；`runtime/__tests__/evidence-store.test.mjs`（文件日期 2026-10-21，未执行）；本机 `artifacts/evidence/` 下 19 类真实证据目录。
3. **统一裁决的封印**：`orderEnabled:false`、`humanSignoffRequired:true` 固定写死在裁决（`runtime/release-decision.mjs:109-120`），人工 DFM/签核缺失即 blocked；`release-decision.test.mjs`（2026-10-19）、`release-evidence-binding.test.mjs`（2026-10-21）覆盖绑定不一致场景（未执行）。
4. **B8 不可变归档的机制与拒绝路径**：`writeFileSync(...,{flag:'wx'})` 已存在即失败、模块无 update/delete、读取重算记录哈希并重校验证据 sha256（`runtime/release-archive.mjs:52-73,109-160`）；真机拒绝路径有证据：`artifacts/b8-release-archive/`（2026-10-20，`RELEASE_ARCHIVE_NOT_ALLOWED` + `releases:[]` + 404），但 README 明确写明**从未造出 ready 放行**。
5. **批准哈希链持久化**：`runtime/approval-ledger.mjs:43-68` 只追加 + `prevHash/entryHash` 可核对；本机 `artifacts/state/approvals-ledger.json`（2026-10-20，291 KB）；`approval-ledger.test.mjs`（未执行）。
6. **计划/终审已不在内存 Map**：计划持久化在 `artifacts/state/production.json`（`data.plans` 存在，2026-10-20，`runtime/server.mjs:496-508`）；签核落盘为 `signoff` 证据（`:2786`）。旧"终审是内存 Map"结论应改判为"已落盘，但遗留一条无 UI 的直连路由"（`runtime/server.mjs:3687`）。仅当状态文件损坏时才"大声降级为内存"（`runtime/server.mjs:505-508`）。
7. **时间线/证据索引/下载通道**：`GET /api/timeline` 三源合成并暴露坏行（`runtime/server.mjs:1475-1490`、`runtime/timeline.mjs`）；`/api/evidence/index` fail-closed 索引（`runtime/evidence-index.mjs:21-27,165-215`）；下载限定 `release/`、`deliverables/` 且扩展名白名单（`runtime/server.mjs:164-184`）。
8. **3D 导出有真机产物**：`deliverables/pcb-3d/*.step`（2026-10-22/23，7–41 MB）、`release/2026-10-22/STEP_...step`；路由对 STEP/GLB 头、分片长度、落盘字节做校验（`runtime/server.mjs:3250-3306`）。
9. **订单边界真实禁止**：`validateOrderConfirmation` 返回 `orderExecutedBySystem:false`、`paymentExecutedBySystem:false`，`orderEnabled` 全链固定 false（`runtime/order-confirmation.mjs:39-53`、`runtime/production.mjs:528`、`runtime/release-decision.mjs:114`）；`order-confirmation.test.mjs`（2026-10-19，未执行）。本机无 `order-confirmation` 历史证据，故这一步只算"边界已封死"，不算"跑通过"。

## 4. 本轮未复验/限制

1. **EDA/Bridge 未启动**：所有 UI→EDA 的真机动作（ERC、DRC、网表验收、仿真、3D 导出、生产导出）本轮**未复验**；文中历史证据均带日期，仅代表当时机器状态。
2. **未执行任何测试**：未跑 `npm test`/`npm run test:runtime`/playwright/单文件 vitest；文中"有测试"仅指测试文件存在及其内容断言，**不代表通过**。
3. **真机从未达成 ready 放行**：`artifacts/f3-live-chain/*`（2026-10-20）R7/R8 均 SKIPPED；`artifacts/a16-release-gate/README.md`（2026-10-20）两次真实调用均 `ready:false`；`artifacts/b8-release-archive/README.md` 明说没有造出 ready 放行。因此"正式导出/归档成功"只有代码与单测依据，无真机成功样本（旧的 final 导出是 2026-10-16 旧规则产物）。
4. **追溯页持久化无落盘样本**：`artifacts/state/trace-state.json` **不存在**，版本/修改/审计的 runtime 持久化在本机未见真实数据；`project-state.json`（2026-10-21）存在但未用于版本节点。
5. **DFM / 下单确认无真机证据**：`artifacts/evidence/dfm-evidence/`、`artifacts/evidence/order-confirmation/` 目录不存在，说明这两类证据在本机从未被登记过。
6. **`signoff` 历史样本是冒烟数据**：`artifacts/evidence/signoff/` 4 份均为 `pcb-smoke`（2026-10-21），分别 3 份 `gate-report` + 1 份 `signoff-record(decision=reject)`，只能证明 kind 冲突与形状并存，不能证明真实板签核。
7. **"正式导出不可达"是静态接线结论**：若手工把带前缀命名的成品复制进 `manufacturing/` 并去掉 DRAFT 名，理论上可能凑齐同源 `manifestHash`，但那是绕过流程而非产品路径（待确认）。
8. **产品边界不在断点统计内**：板厂真实报价/交期/库存接口、在线 DFM 上传登录、下单与支付均为明确的人工/外部边界（`runtime/server.mjs:2746`、`runtime/order-confirmation.mjs`、`runtime/production.mjs:436` manifest 中 `order.status:'disabled'`）。
9. **未核对 `artifacts/priority`、`deliverables/open-source-*` 等非本链路目录**；`npm` 脚本与 CI 配置未审。
