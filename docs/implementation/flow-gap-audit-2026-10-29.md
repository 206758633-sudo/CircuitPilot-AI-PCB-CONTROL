# CircuitPilot 全链路复审计（2026-10-29 · 9 个 P0 修复后）

> **修复收口（同日晚）**：本文件发现的 **8 个未解决 P0 与 16 类 P1 已按"全部修复"要求逐项落地**，下文原判定保留为修复前基线；每项的实际修法、证据与残余风险见 **§0.1 修复收口清单**，最新验证数字见 §5。仍未真机验证的部分已逐条标注，不冒充已打通。

> 问题：**修复之后，再全面检查一遍还有哪些流程没有打通。**
> 方式：5 条链并行只读复审 + Lead 交叉复核/隔离探针（未连接 EDA/Bridge、未重启 4177/4178、未跑 Playwright/live e2e、未使用 git）。
> 判定：✅ 已打通｜🟨 半打通（口径/入口/数据链缺一）｜🟥 断点或假成功｜⬜ 纸面｜🚫 产品边界。
> **本文件是当前现状**；`flow-gap-audit-2026-10-26.md` 保留为修复前问题基线（其 §2.5 的"9 个 P0 全部修复"由本文件修正为 **6 项闭环 / 3 项降级为半打通**）。
>
> 细节报告：`flow-audit-2026-10-29/01-design.md`（设计链）· `02-pcb.md`（PCB 链）· `03-delivery.md`（验证/交付链）· `04-platform.md`（平台链）· `05-ui-wiring.md`（UI 接线矩阵，83 动作/142 路由交叉核对，死链 0）。

## 0. 总结论

1. **9 个 P0 的修复方向都成立，主路径已从"假成功/必死"变成"fail-closed 且有测试"**：落板缺件会回滚、覆铜未知不保存、写暂停由 Runtime 统一 409、正式导出死锁解除、readiness 入参不再猜测、门禁报告与交付签核分 kind。
2. **以上问题已在同日晚按"全部修复"收口**（见 §0.1）：8 个未解决 P0 与 16 类 P1 均有代码/路由/UI/测试落点；其中 P1-11 保留为"代码闭环但写锁未覆盖全部写路由"的 🟨，不再有"按钮亮着点下必死"的结构性断点。
3. 本轮复审核实并已顺手修复 8 个"修复项边界漏洞"（见 §4，均带回归测试），因此下面列的是**修过之后仍然存在的问题**。

### 0.1 修复收口清单（2026-10-29 晚，本轮"请全部修复"）

> 判定口径不变：✅ 已打通（代码/路由/UI/测试齐）｜🟨 代码闭环但缺真机/人工数据（不冒充）｜🚫 产品边界。
> 所有"✅"均有 runtime/HTTP/vitest 回归；**未连接 EDA 真机、未跑 Playwright/live e2e**，因此"真实板端到端"仍是待办验证。

| 编号 | 原问题 | 状态 | 修复落点（关键文件） |
|---|---|---|---|
| RP0-1 | 官方验证结果不持久化 | ✅ | 新增 `runtime/validation-state.mjs` + `GET/PUT /api/validation-state`；`src/state/AppContext.tsx` 启动 hydrate + 800ms 防抖 PUT（失败 reportIssue）；`ValidationPage` 记录带 executionId/planHash/compiledPlanHash |
| RP0-2 | 六门结构性不可签 | ✅ 结构闭环 / 🟨 真实数据 | 六类证据生产者全接：`runtime/gates-evidence.mjs`（rules/netlist-diff/lib-evidence/design-spec/placement/fabrication-release）；G1–G6 `implemented:true`；G2 按 pcbUuid 聚合全部器件；`POST /api/eda/gates/collect`；placement/apply 与 release/gate 自动落 G5/G6；UI「运行门禁取证 G1–G6」+ saved/missing 展示 |
| RP0-3 | 签核锚点 ≠ 实际交付物 | ✅ 代码闭环 / 🟨 真机复导需验证 | 导出默认写 `deliverables/`；`signoffManifestHash` 输出锚点比对，不一致 `PRODUCTION_EXPORT_MANIFEST_DRIFT` 409 且拒绝 final 名；归档完整 binding 服务端重算，稀疏 binding 400/漂移 409；UI 三处共用同一 binding |
| RP0-4 | PCB 未绑目标文档 UUID | ✅ | `runtime/pcb.mjs` `assertDocumentBinding`（write/readback/rollback 三阶段，`PCB_TARGET_DRIFT` 409）；持久写锁 `pcb-write-lock.json`（`PCB_WRITE_LOCKED`，重启仍生效、可显式解除）；`GET /api/pcb/write-lock` + `POST /api/pcb/write-lock/release`；EdaPage 安全锁横幅与按钮禁用 |
| RP0-5 | 会话暂停只是前端 | ✅ | `runtime/write-gate.mjs` 新增 `sessionPaused`（持久化、与全局互不覆盖、损坏 fail-closed）；18 条写路由 409 同时认两者；自动化在途每个写步骤前 `assertWritesOpen` → `aborted_by_write_gate`；UI Toggle 走 `setWriteGate({scope:'session'})`，6+ 写按钮统一禁用 |
| RP0-6 | 知识 approved 不改变行为 | ✅ 真实语料已验证 | ①仓库 curated 数据集 422 条灌入本地知识库（`scripts/seed-knowledge-pcb.mjs`，仍为 candidate+reference，脚本不自证）；②委托审核脚本 `scripts/review-knowledge-dataset.mjs` 逐条记录 reviewedBy（默认 dry-run，`--confirm` 才写 approved；来源清单由 `scripts/check-knowledge-sources.mjs` 校验）；③已审核 **163 条 curated rules**；④用真实 gate-engine 报告实测：`suggested=6` 覆盖 G1–G6、`usageRecorded=6`、每条可回查 `knowledge:kn-rule-*`；⑤门禁建议按门均分（`perGateLimit`），不让 G1 吃光名额；⑥新增真实语料回归 `knowledge-real-corpus.test.mjs`。审核范围/来源核验/复现命令见 `knowledge-review-log-2026-10-29.md`。RAG revision / 对话 citations / UI 候选展示同轮保留 |
| RP0-7 | 干净机器正式导出不可达 | ✅ 代码闭环 | `production-export` 默认根改 `productionArtifactsRoot`（deliverables，`fileURLToPath` 修空格路径）；`/api/production/export` 显式传 artifactsRoot；readiness/闸门/导出同根 |
| RP0-8 | AI 语义计划 → 原理图不是一条链 | ✅ 按验收方案② | 明确拆线并改写交接文案：AI 页按钮=「进入EDA编译（PCB 写入链）」，通知/EDA 页提示"语义计划只进 PCB；原理图写入走独立 AI 网表草案链（血缘不能互认）"；不再暗示 AI 计划会写原理图 |
| P1-1 | 官方验证不绑 executionId/planHash | ✅ | `ValidationPage.recordOfficialValidation` 写 executionId/planHash/compiledPlanHash；证据带工程身份 |
| P1-2 | 血缘非法值静默丢弃 | ✅ | `runtime/design.mjs` 严格校验双哈希（空/非串/长度/hex → `APPROVAL_LINEAGE_INVALID` 400）；批准/账本/执行记录同源；netlist `compileReviewedNetlist` 保留双哈希 |
| P1-3 | 原理图 DRC 零容忍 | ✅ | 写前基线 + 仅新增 error 阻断；`strictDrc` 可显式零容忍；无基线 `DRC_BASELINE_UNKNOWN` 502 fail-closed |
| P1-4 | PCB 回读未按类型断言 | ✅ | `verifyWriteEffects` 按 outline/line/via/pour/component.modify 断言；不匹配 `PCB_WRITE_VERIFY_INCOMPLETE` 409 并回滚；执行记录 `verify` 明细 |
| P1-5 | 批准/执行未绑项目与 EDA 工程身份 | ✅ | design approve 保存 projectId/documentUuid；execute 开始/每 10 操作/save/rollback 前复读，漂移 `APPROVAL_TARGET_MISMATCH` 409；UI 传 designContext 绑定 |
| P1-6 | 归档 B8 结构性不可达 | ✅ | 完整 binding + `inspectProductionArtifacts` 重算；缺域 `RELEASE_ARCHIVE_BINDING_INCOMPLETE` 400、漂移 `RELEASE_ARCHIVE_MANIFEST_DRIFT` 409；`semanticPlanHash∥planHash` 兼容 |
| P1-7 | gate/export/archive binding 不一致 | ✅ | `exportBinding` 统一六域；releaseDecision/export/archive 同一 binding；缺域按产品可补 |
| P1-8 | 导出写 release/，闸门读 deliverables/ | ✅ | 默认根统一为 `productionArtifactsRoot`；路由显式传 artifactsRoot，不再按日期 release/ |
| P1-9 | RAG 不随知识变更失效 | ✅ | `knowledge.mjs` revision + RAG `corpusRevision` 落盘；query/status 自动重建（保留 RAG_INDEX_VERSION=2） |
| P1-10 | 知识未进对话/Agent | ✅ | chat 路由检索 approved+未过期知识注入上下文并回传 citations；AI 页展示引用/无引用说明；RAG citations 可回查 |
| P1-11 | 在途自动化/写锁/暂停 dryRun | 🟨 | runner 每个写步骤前 `assertWritesOpen` → aborted；PCB 持久写锁已接产品路由；`eda-write-lock.mjs` 跨进程锁模块已交付但尚未包住所有布局/布线/修复路由（单用户桌面场景风险低），dryRun 暂停语义保持现状 |
| P1-12 | UI 6 处写/批准按钮未禁用 | ✅ | EdaPage（新建/两处人工批准/原理图执行/PCB 执行）、RoutingWritePanel、PartProposalPage 批量落件、ValidationPage 应用修复，全部 paused‖sessionPaused 禁用 + title + 函数内守卫 |
| P1-13 | 验证/发现/进度未按项目+官方过滤 | ✅ | ValidationPage 只展示当前项目官方行，otherChecks 单独分组且不计覆盖；DeliverPage 角标=官方未收口 findings；Shell 红点用 issues |
| P1-14 | 官方项目域只是 UI 标签 | ✅ | 运行 ERC/DRC 前比对 EDA 工程身份（no-binding/unknown/mismatch 全部 fail-closed + issue `EDA_WORKSPACE_MISMATCH`） |
| P1-15 | 联网开关无消费者、外发清单漏项 | ✅ | `/api/research/config` GET/POST 权威持久化；`/api/research/status` 读真实值；KMA 调度器随开关启动/停止（默认关闭）；外发清单新增 `knowledge.research`（defaultEnabled:false，说明同意来源） |
| P1-16 | 回滚失败写锁只在内存、阶段回滚文案失真 | ✅ | 写锁持久化 `pcb-write-lock.json` 跨重启恢复 + 显式解除路由；`rollbackScope:'all'|'stage'`/`snapshotRestored` 如实区分 |

**仍需真机/人工验证（不冒充已打通）**
1. 六门 pass 需要真实板数据：官方 ERC/DRC、真实器件（LCSC 身份/封装/3D 三源）、实际网表、布局审计、制造放行报告；单元测试用完整六类证据证明可 pass，但未在真机走通全链。
2. 导出锚点按 artifacts 根整体清单比对：真实 EDA 重导出若字节非确定，会频繁 drift 需重新签核（fail-closed，产品需决定是否接受同名覆盖重导出）。
3. 前言中的 DRC 基线依赖真机 `sch_Drc.check` 返回数组；非数组 fail-closed 502，形状需实测。
4. 真实语料已审核 163 条 curated rules 并实测六门建议/usage；另有 272 条 candidate（259 条 curated modules/parts/failures + 13 条 web 采集）仍需人工逐条审核，未审核条目不进入建议。
5. `eda-write-lock.mjs` 尚未包住所有 EDA 写路由（P1-11 剩余项）。


### 9 个 P0 修复的复审判定

> "关键依据"列记录的是**复审当时**的证据（说明修复对象）；当前状态见上表 §0.1。

| P0 | 修复内容 | 复审判定 | 关键依据 |
|---|---|---|---|
| P0-1 计划双哈希血缘 | plan/令牌/账本/执行记录/UI 全链带双哈希，换计划 409 | ✅（复审判定已随 RP0-8 收口） | 血缘是客户端自报、非法值静默丢弃（`runtime/design.mjs:33-41`）；**AI 页语义计划仍只进 PCB，原理图写入走另一条网表链**（`src/pages/EdaPage.tsx:217-231,395-430`；`runtime/netlist.mjs:6-47`） |
| P0-2 落板假成功 | expectations 回读比对、缺件 `PCB_SYNC_INCOMPLETE`+回滚、空转 `PCB_SYNC_NO_EFFECT`、UI 写前后双闸 | ✅（旁路由 P1-4 按类型回读兜住） | 高级/旧计划可不带 expectations；混合操作计划不做落板比对（`runtime/pcb.mjs:472-484`） |
| P0-3 验证单一来源 | 官方 ERC/DRC 唯一写入、KPI/阶段/问题中心只认官方 | ✅（RP0-1/P1-1/14 收口） | `validations` 不在任何 Runtime 持久化载荷（`src/state/AppContext.tsx:352-420`）→ 刷新后 KPI 归零；执行成功不落官方记录、证据无 executionId/planHash |
| P0-4 覆铜 fail-closed | 读不到填充 → `PCB_POUR_FILL_UNKNOWN` 且不保存 | ✅（本轮补 save 校验） | 主修复成立；另两条布线写入原先不校验 `pcb.save` 返回值（已修，§4） |
| P0-5 六门证据/签核隔离 | `gate-report`/`gate-signoff` 独立 kind；G1/G5/G6 显式未实现 | ✅ 结构（真实数据见 §0.1） | kind 隔离成立；但 **G2–G4 标 implemented 却无产品内证据生产者**（agent pipeline 未接任何路由/配方），lib-evidence 指纹也不含 pcbUuid → 六门实际 0/6 可 pass，签字永久禁用 |
| P0-6 正式导出解锁 | artifacts 根统一、草稿→final 解锁、outputDecision 传播 | ✅（RP0-3/P1-6/7/8 收口） | 读侧统一 `deliverables/`；但**产品内没有把首件 Gerber/BOM/CPL 写进该根的路由**，导出仍默认写 `release/<日期>`；签核锚点与实际导出物不是同一批文件 |
| P0-7 readiness 入参 | 语义计划→编译→挑 DRC 通过执行，真实双哈希+executionId | ✅ 核心 | readiness inputs 存档写入后无人读取（死存储 P2）；执行记录无 projectId（跨项目按哈希兜底） |
| P0-8 Runtime 写暂停 | 磁盘权威 + 18 条写路由前置 409 + GUI 白名单 + UI 镜像 | ✅（RP0-5/P1-12 收口） | 损坏门禁文件曾 fail-open（已修，§4）；会话级"暂停本会话写入"仍只是前端 state；在途自动化 run 不会中止；6 处 UI 写按钮未接禁用 |
| P0-9 知识门禁闭环 | approved 知识进入门禁建议并写 usage；RAG 排除过期/标注审核 | ✅（真实语料 163 approved，六门建议+usage 实测） | 代码/测试接线真实，但真实语料 408 条 approved=0 且 0 条含 `GATE_*` → 建议恒空；旧版 RAG 索引不失效（本轮已 bump 版本自愈）；usage 无 UI |

## 1. 五条链路状态

| 链路 | 状态 | 一句话 |
|---|---|---|
| 设计：需求→AI 计划→批准→原理图写入 | ✅ | 受控写入内核 + 目标绑定 + 基线 DRC；AI 计划与原理图写入已明确拆成两条链并改写交接文案（RP0-8 方案②） |
| PCB：落板→布局→布线→覆铜→DRC/回滚 | ✅ | 目标文档 UUID 三阶段绑定、按写入类型回读断言、持久写锁与解除入口全部落地 |
| 验证/交付：ERC/DRC→放行→六门→readiness→导出/归档/签核 | ✅ 结构 / 🟨 真机 | 官方验证持久化；六门六类生产者可签；导出/归档/签核共用完整 binding 并做输出锚点校验；真机数据仍待实测 |
| 平台：自动化/写暂停/知识/RAG/项目 | ✅ 主体 / 🟨 写锁面 | 会话暂停持久化、在途 run 可中止、RAG 自动重建、研究开关有消费者；真实语料 163 approved 后六门建议非空；剩余仅 `eda-write-lock` 未覆盖全部写路由（P1-11） |
| UI 接线 | ✅（矩阵层） | 83 个动作：A 真接线 75、B 诚实本地 5、D 标注 demo 2、E 死链/文案失真 1；142 client 路径 vs 144 精确路由 + 25 动态路由，死链 0 |

## 2. 复审时的 P0 断点与修复对照（原始证据保留）

> 下面每条都已在 §0.1 标记修复状态；保留原始证据是为了让读者能对照"修的是什么"，不是当前未解决清单。

### RP0-1 官方验证结果不持久化，刷新/换机后证据链断裂（✅ 已修）
- 证据：`src/state/AppContext.tsx:352-420`（project-state 载荷无 validations）、`:138-139`（只 dispatch 本地）；`src/pages/ValidationPage.tsx:306-325`；无 `/api/validation-state` 一类路由。
- 影响：跑完官方 ERC/DRC 后刷新 → `validationKpis` 回到 0/2、`stageEvidence.drcPassed` 变 false；阶段却已经写进 Runtime 项目状态 → 出现"阶段=验证/生产，但官方覆盖 0%"的自相矛盾，无法复核当初凭什么推进。
- 修法：把当前项目 official 记录（含 engine/digest/path/jobId/executionId/projectId）落 Runtime（独立 `/api/validation-state` 或 project-state 切片），加载时恢复；`deriveStageEvidence` 优先 Runtime 权威证据。
- 验收：清 localStorage/重启 Runtime 后 KPI、drcPassed、阶段仍一致；伪造/过期 executionId 不计入。

### RP0-2 六道门结构性不可签：G2–G4 无产品内生产者（✅ 结构已修，真实数据待验）
- 证据：`runtime/gate-engine.mjs:17-19`（G2/G3/G4 `implemented:true`）；`runtime/gates-service.mjs:29`（按 `pcbUuid` fingerprint 收集）；`runtime/server.mjs` 只落 7 种证据 kind；`runtime/agents/{librarian,netlist-auditor,rule-runner,orchestrator}.mjs` **未被 server/配方/UI 调用**；`lib-evidence` 指纹无 `pcbUuid`（`runtime/agents/librarian.mjs:58-61`）。
- 影响：`/api/eda/gates/status` 永远 3 门"未实现"+3 门"证据不足"→ `verdict!=='pass'` → "签字放行"永久 disabled。UI 却把 G2–G4 显示为"证据不足"，暗示可补，实际产品内补不了。
- 修法（二选一）：①把 orchestrator 接到自动化/门禁入口，真实产出 `lib-evidence/netlist-diff/rules`，并让 lib-evidence 指纹带 pcbUuid/或按板内器件聚合；②若短期不做，把 G2–G4 也标 `implemented:false`，UI 明示"门禁尚未接通"，避免永久误导。
- 验收：真实板走完 pipeline 后 `verdict==='pass'` 且可签字；或六门全部如实标注未实现、按钮文案一致。

### RP0-3 签核锚点 ≠ 实际交付物（✅ 已修，真机重导需实测）
- 证据：`runtime/server.mjs:1926-1954`（导出时按 deliverables 输入清单复核 manifest 绑定）；`runtime/production-export.mjs:78-131`（正式导出用**实时 EDA** 重新生成文件并写 `release/<日期>`）；两者不做"输出==签核"比对。
- 影响：签核之后改板/换 DRC 报告，仍可能产出"正式命名"文件；签核承诺与交付物脱钩（fail-open，需真机复核定级）。
- 修法：正式导出产物统一写回被签核的 artifacts 根，并在导出后重算 manifestHash 与签核/readiness 绑定值比对，不一致拒绝命名 final。
- 验收：签核→改板→导出 final 被拒；未改板时导出文件哈希与签核绑定一致。

### RP0-4 PCB 执行/回滚未绑定目标文档 UUID（可写错板）（✅ 已修）
- 证据：`runtime/pcb.mjs:382-453`（执行只看 windowId/targetFingerprint，未绑定 documentUuid）、`:513-520`（回滚恢复也未用桥的 expectedDocumentUuid）。
- 影响：DRC 等长阶段中用户切换 PCB 文档 → 后续写入落到另一块板；回读也在新板比对，甚至把"写错板"判成 rolled_back。
- 修法：批准令牌绑定 documentUuid（已有 targetFingerprint 的一部分），每次写/读回/回滚前校验当前活动文档，漂移即 409 `PCB_TARGET_DRIFT` 并停止。
- 验收：执行中切文档 → 立即失败且不写入/不误报回滚成功；单测覆盖 document 漂移。

### RP0-5 会话级"暂停本会话写入"只是前端自觉（✅ 已修）
- 证据：`src/pages/EdaPage.tsx:623`、`src/state/taskMachine.ts:37`、`src/components/Shell.tsx:44`（UI 据此显示 WRITE PAUSED）；`runtime/` 无会话暂停概念。
- 影响：用户以为已止血，脚本/curl/自动化仍可写；与 P0-8 同类安全叙事失真。
- 修法：`POST /api/write-gate` 增加 `scope:'session|global'`（或独立端点），Runtime 在 `assertEdaWritesOpen` 同时检查；UI Toggle 改为 Runtime 驱动。
- 验收：会话暂停后任一写路由 409（scope=session）；UI 徽标与 Runtime 一致。

### RP0-6 知识库"approved 改变产品行为"在真实数据下不成立（✅ 已用真实语料验证）
- 证据：`runtime/knowledge-gate-advice.mjs:47-56` 用门禁 reason code 原文检索；`runtime/gate-engine.mjs:24-32` 只有 7 个 `GATE_*`；真实语料 408 条（dev 13、安装版 392）approved=0、含 `GATE_`=0。
- 影响：门禁建议恒空，用户永远看到"暂无可用知识"；审核通过只影响 RAG 徽标（且旧索引需重建，本轮已 bump 版本）。
- 修法：门禁 code→知识标签映射（如 `GATE_EVIDENCE_MISSING→[drc,evidence,report]`）按标签/entityKey 检索；或补采集规则产出 `payload.ruleId=GATE_*` 的 approved 样例；UI 区分"无相关知识"与"知识未审核"。
- 验收：真实语料+真实门禁报告返回 ≥1 条建议；evaluate 后 usage 有记录；candidate 同主题不出现。

### RP0-7 正式导出在干净机器上仍不可达（首件无入口）（✅ 代码闭环）
- 证据：`runtime/server.mjs:1989-1991`（草稿/正式导出默认写 `release/<日期>`）；`deliverables/` 只有 3D STEP 会写（`:3446`）；UI 从不传 `outDir`（`ValidationPage.tsx:982-1003,1609-1610`）。
- 影响：全新机器 inspect=0 文件 → `ARTIFACT_MISSING` → formalAllowed=false；UI 提示"先导草稿再跑闸门"与实现矛盾（草稿不写 deliverables）。
- 修法：首次正式导出默认写 `<artifactsRoot>/<project>/`（或加"写入产物根"入口/提示 outDir），并让闸门与导出共用同一根和同一 manifest 复核。
- 验收：干净目录下"一次导出→闸门→final"可走通；提示文案与落点一致。

### RP0-8 AI 页语义计划 → 原理图写入仍不是一条链（✅ 按验收方案②拆线并改写文案）
- 证据：`src/pages/EdaPage.tsx:217-231`（AI 计划只编译进 PCB 高级面板）；`:395-430`（原理图写入计划由"AI 网表草案"生成）；`runtime/netlist.mjs:6-47` 不产/不收 semantic/compiled 哈希；两链无 ID 关联。
- 影响：用户从 AI 页"进入 EDA 编译与审批"后实际被引导到 PCB 计划；原 P0-1"两条链互不相认"仍在（只修了血缘绑定）。
- 修法（需产品拍板）：①增加"语义计划→原理图计划"编译分支，复用 planHash 注册表；②显式拆成两条产品线并改写交接文案。
- 验收：AI 页 planHash == 原理图批准/账本哈希（方案①）；或 UI 不再暗示 AI 计划会写原理图（方案②）。

## 3. P1 清单与修复状态（合并去重，原始依据保留）

> 16 类 P1 的逐项修复落点见 §0.1；本表保留复审当时的证据与影响描述。

| # | 问题 | 证据 |
|---|---|---|
| P1-1 | 官方 ERC/DRC 不绑 executionId/planHash；原理图执行成功不写官方记录 → "这次写入是否过 ERC"无法回答 | `src/types.ts:682-688`；`ValidationPage.tsx:449-461,592-606`；`EdaPage.tsx` 无 official 写入 |
| P1-2 | 血缘哈希服务端不重算来源（客户端自报），非法/空值静默丢弃无告警 | `runtime/design.mjs:33-41`；`server.mjs:3305-3308,3501-3506` |
| P1-3 | 原理图执行 DRC 零容忍且不叫 ERC：既有 warning 也会阻断回滚 | `runtime/design.mjs:371-376` |
| P1-4 | PCB 回读未按写入类型断言（outline/line/via/pour/component.modify 静默失败仍可 completed）；无 expectations 的混合计划不做落板比对 | `runtime/pcb.mjs:430-484`；`EdaPage.tsx:495-560` |
| P1-5 | 批准/执行未绑项目与 EDA 工程身份；open-current 空 uuid 取任意页 | `server.mjs:3257-3261`；`EdaPage.tsx:370-383` |
| P1-6 | 归档 B8 结构性不可达：稀疏 binding 重算 manifestHash 必不符 + `planHash` 服务端硬要求 vs UI 标"可留空" | `server.mjs:1881`；`runtime/release-archive.mjs:102-108`；`ValidationPage.tsx:1723,1799` |
| P1-7 | gate/export/archive 三处 `releaseDecision` 入参 binding 不一致 → 按钮亮、点下必败 | `server.mjs:1850-1854,1950-1954`；`src/services/runtimeClient.ts:643,674` |
| P1-8 | 首件产物/接缝：正式导出写 `release/`，闸门读 `deliverables/`（与 RP0-7 同源） | `server.mjs:1989-1991`；`ValidationPage.tsx:982-1003,1709` |
| P1-9 | RAG 索引不随知识 save/review/过期失效（本轮仅修"旧版本索引"自愈）；审核后仍需手动重建 | `runtime/rag/store.mjs:69-77`；`runtime/rag/index.mjs:15` |
| P1-10 | 知识未进对话/Agent；orchestrator 未接 server；引用校验器（approved 才可引用）无产品入口 | `runtime/chat.mjs` 0 引用；`server.mjs` 未 import orchestrator |
| P1-11 | 全局暂停不中断在途自动化 run；写锁只覆盖自动化，布局/布线/修复可并发写同一文档；暂停期 dryRun 也被 409 | `runtime/automation/runner.mjs:199-220`；`server.mjs:529,1460,2406,2504` |
| P1-12 | UI 6 处写/批准按钮未接暂停禁用（`RoutingWritePanel`、验证页修复"应用"、`PartProposalPage` 批量落件、EdaPage 两处人工批准、新建工作区） | `05-ui-wiring.md` §4 |
| P1-13 | 验证页列表/发现/进度未按"当前项目+官方"过滤；`DeliverPage` 角标仍数全部 validations（8 via seed）与"没有未收口"矛盾 | `ValidationPage.tsx:2237-2243`；`DeliverPage.tsx:21,32` |
| P1-14 | 官方验证项目域只是 UI 标签：运行 ERC/DRC 不校验 EDA 实际文档 == 项目绑定 | `ValidationPage.tsx:448-452,593-600` |
| P1-15 | 联网检索开关无消费者；KMA 默认联网且外发清单漏项 | `SettingsPage.tsx:369-374`；`server.mjs:587,1741` |
| P1-16 | 回滚失败写锁只在内存（重启解除）；阶段级回滚文案仍说"已恢复执行前快照" | `runtime/pcb.mjs` 写锁；`02-pcb.md` P1-E/D |

## 4. Lead 本轮复审核实并已修复的问题（均带回归测试）

| # | 漏洞 | 修复 | 测试 |
|---|---|---|---|
| 1 | 默认产物根用 `URL.pathname` → 仓库路径含空格时变成 `AI-%20PCBA/deliverables`（本机默认根直接错） | 改 `fileURLToPath` | `release-p06-http.test.mjs` 静态回归 |
| 2 | 修复前落盘的三方签核没有 `kind` → 升级后旧签核全被判无效 | 兼容 `passed:true+roles` 且无 kind；gate-report 仍挡住 | `gates-p05-http.test.mjs` |
| 3 | `latestReleaseSignoff` 只看最新一条 → 更新的 gate-report 遮蔽更早真实签核 | 向前扫描第一条有效签核 | `gates-p05-http.test.mjs` |
| 4 | 验证页 Demo 全量运行把 official 行改写成 demo（P0-3 反向污染） | `mergeDemoValidationRun` 保留 official；单条"重新运行"对 official 禁用 | `validationEvidence.test.ts` |
| 5 | 布线 apply/finish 不校验 `pcb.save` 返回值 → UI 假报"已保存" | 两个入口 fail-closed `PCB_SAVE_UNCONFIRMED`，apply 走回滚 | `pcb-routing.test.mjs`（+2） |
| 6 | 写门禁文件损坏/不可读时静默 fail-open | 损坏 → `paused:true`+loadError，写路由仍 409，显式 POST 可恢复 | `write-gate-http.test.mjs`（+1） |
| 7 | 旧版 RAG 索引（v1，meta 全空）升级后继续沿用 | `RAG_INDEX_VERSION=2`，旧索引必然失效重建 | `rag.test.mjs`（+1） |
| 8 | 计划文本改用编译原稿，重新校验会丢双哈希血缘 | EdaPage 用带 lineage 的 `executable.plan` 回填文本框 | typecheck/现有血缘测试 |
| 9 | `gate-service` 注释仍写"评估落 signoff"；evidence kinds 测试缺 gate-report/gate-signoff | 注释修正；期望 kind 列表补两项 | `evidence-store.test.mjs` |

## 5. 验证记录

### 5.1 修复收口后（2026-10-29 晚，隔离状态目录，未连真机/未跑 live e2e）
- `npm run typecheck`：✅ 0 error。
- `npx vitest run`：✅ **27 files / 196 tests**（基线 186；UI 修复 +10）。
- 全量 Runtime 串行：`node --test --test-concurrency=1 --test-timeout=120000 "runtime/**/*.test.mjs"`：✅ **1281/1281 pass, 0 fail**（约 80s）。
- `node --test runtime/__tests__/route-contract.test.mjs`：✅ 182 路由 / 169 有消费者 / 11 允许清单 / **0 孤儿**。
- 新增 HTTP 回归 `runtime/__tests__/p0-fixes-http.test.mjs`（5 条）：validation-state 持久化+非法载荷不覆盖、全局/会话暂停互不覆盖、research config 权威读取、gate collect 缺输入不伪造 pass、PCB 写锁状态+解除幂等。
- 六门回归：gate-engine 8、gates-evidence 9、gates-service 7、gates-p05-http 3、release-archive 9、release-p06-http 3（39/39）。
- P0-6 真实语料：`node scripts/check-knowledge-sources.mjs` ✅（15 源/0 问题）；curated 422 条灌库；委托审核 163 条 rules（reviewedBy 逐条）；真实 gate-engine 报告实测 `suggested=6`（G1–G6）、`usageRecorded=6`；真实 `GET /api/eda/gates/status` 返回 200 + 6 条建议（G1–G6）+ 64 条待审核候选；新增 `knowledge-real-corpus.test.mjs`。
- 证据库兼容：真实 `artifacts/evidence` 里遗留的 `*-summary.json` 等非契约文件不再让整类证据 `EVIDENCE_CORRUPT`（按当前命名契约过滤；命中契约的文件仍逐条验哈希，篡改照旧 fail-closed），已加回归测试。
- 设计链：design 17 + netlist 5（22/22）；PCB：pcb 20 + routing 31 + write-lock 7（58/58）。
- 仍未执行：真机 EDA 桥接、Playwright/live e2e、干净机器上真实首件导出、真实六门签字。以上数字均为代码/HTTP 级验证。

### 5.2 复审当时（修复前基线）

- `npm run typecheck` ✅
- vitest：27 文件 / **186 通过** ✅
- runtime 串行全量：**1197/1197 通过，0 失败** ✅（并行跑时 E7 中止/恢复两条因固定 60ms 时序在负载下偶发，单独/串行均通过，属既有测试时序问题）
- `npm run build` ✅（chunk >500kB 为既有警告）
- 路由契约：175 条路由 / 164 有消费者 / 允许清单 11 / 孤儿 **0** ✅
- 各审计隔离测试：设计 25/25 · PCB 44+24/0 · 交付 runtime 28/28 + vitest 29/29 · 平台 11/11 + gates 2/2
- **未做**：真机 EDA/Bridge 复验（本机 :4178 仍是修复前旧构建，未擅自重启用户会话）；Playwright（需新 Runtime + 外部 AI/EDA 状态，且会碰真实页面）；live e2e。真机验收命令：`CP_LIVE_EDA_E2E=1 node scripts/e2e-live.mjs`（只读，先重启 Runtime 加载新代码）。

## 6. 建议修复顺序

1. **验证证据持久化 + 执行→官方证据绑定**（RP0-1、P1-1）：这是阶段机/放行/KPI 的地基，做完"验证→生产"才算可复核。
2. **六门处理**（RP0-2）：接 orchestrator 生产者，或把 G2–G4 一并标未实现并改 UI；别让"签字放行"永久灰着还暗示能补。
3. **交付一致性**（RP0-3、RP0-7、P1-6/7/8）：导出写回签核根 + 三处 binding 统一 + 归档去稀疏哈希，打通"签核→导出→归档"。
4. **PCB 安全边界**（RP0-4、P1-4）：documentUuid 绑定 + 按写入类型回读断言。
5. **写暂停收口**（RP0-5、P1-11/12）：会话暂停入 Runtime、在途 run 中止、6 处按钮禁用。
6. **知识闭环**（RP0-6、P1-9/10）：门禁 code→知识标签、索引 dirty、对话引用。
7. **设计链抉择**（RP0-8）：语义计划合并进原理图写入，或明确拆分布线并改文案。
