# CircuitPilot 目标达成全量差距清单（完成清单）

- 生成时间：2026-10-19
- 目标（本清单的"完成定义"）：A 档全链路 —— 需求 → 选型 → 原理图/网表 → PCB 落板 → 布局 → 布线 → 铺铜 → DRC → 制造包/3D → 放行报告，**AI 决策 + 确定性配方 + API 优先/GUI 兜底 + 每步读回验证 + 3 次人工批准（计划 / 写板 / 放行）**，失败可诊断、可回滚、不假通过；不自动下单/支付，在线 DFM 与终审人工。
- 判定口径：**P0** = 不补就无法宣称"目标打通"；**P1** = 主链能跑但不可信/不可交付；**P2** = 工程化与体验；**P3** = 优化。
- 现状基线（2026-10-20 第 64 轮收官实测）：`npm test` = typecheck 0 + vitest **157/157** + runtime **759/759**；`npm run build` 通过；`npm run acceptance` **PASS**（`artifacts/acceptance/acceptance-2026-10-20T06-44-54-645Z.md`：vitest 157/157、runtime 759/759、e2e 32（app 30 + C6 真实切换 1 + F7 UI 渲染 1）、coverage 5 模块达标、a11y-audit（D9 静态 0 violations；warnings 为启发式人工复核提示，实测 87 条/31 个 tsx，不设假门槛）、package-smoke PASS、long-run-smoke 短窗 PASS、fault-drill PASS、backup-drill PASS、e2e-app 30/30；`live-chain` 离线 SKIP 不伪装；首次 acceptance 曾出现 1 例 runtime 偶发失败、重跑 740/740，未定位到固定用例，后续轮次继续观察）（typecheck/vitest/runtime/build/contract/e2e-app 全绿，真机项按显式开关 SKIP）；`app.spec` e2e **30/30**；live 用例 4 条可收集（无 env 时 skipped）；**133 条 HTTP 路由**（exact 116 / pattern 17；契约 3/3、orphan 0）、**76 条桥命令**、16 个页面；衣橱板仍 `DRAFT-NOT-FOR-ORDER`（第 22 轮真机 DRC：total 13464 / unexplained 13462、ready=false；R8 final 导出被门禁拒绝、draft 导出复核 pass；R4 布局写回通道真机验证并经自动回滚复原；R5 布线写铜已打通，见下方 A10）。第 23 轮已补：失败诊断库对齐真机错误码（E12）、支付/下单红线加固（G2）、选型回退链（A2）、原理图批量落件通道（A6）、位号标注门禁+通道（A5）、需求硬约束门禁（A1）、布局 128 条规则审计门禁（A9）、配方版本化+菜单文案漂移诊断（E6）、自动化单写锁+runId 幂等（E7）、live 手册（F1）、过期注释修正（H1）；**A10 布线写铜真机打通（写 3 段→独立复核 ok→读回→回滚复原；并修复 `routing/plan` 按网过滤被截断的 bug）**；**A11 新建覆铜真机打通（createComplexPolygon 正确构造 + 属性读回 + 失败回滚 + cleanup 自检 + 配方 `pcb-create-pour`）**；**C1 项目/需求/器件/资料业务状态 Runtime 权威落盘（GET/PUT `/api/project-state` + 前端启动恢复/防抖写回，真机验证重启后仍可读回）**；**第 46 轮：A16 工程分析/布局规则纳入放行门禁（缺省 skipped 不冒充、blocking 阻断、例外校验）、B8 不可变发布版本（服务端重算 ready 才归档、证据 sha256、无更新/删除）、G4 provider 外发清单+脱敏预览、G5 EDA 版本适配诊断（tested/patch-drift/untested/unknown + 已知坑降级）、D9 对话框焦点管理**。上述均在测试中验证，真机/UI 剩余项见各条状态。
---

## 0. 总览：缺口分布

| 域 | 条数 | P0 | P1 | 一句话 |
|---|---|---|---|---|
| A 设计主链 | 16 | 7 | 8 | 连线/布线/DRC/落板仍断 |
| B 放行与交付 | 10 | 4 | 3 | 三套口径、DFM/签核/价格未闭环 |
| C 数据/持久化/审计 | 8 | 1 | 2 | 业务状态基本不落盘 |
| D 前端与交接 | 10 | 3 | 2 | 23 条路由无 UI 消费者（13 死 + 6 仅脚本/测试 + 4 仅客户端）、4 处跨页死链 |
| E 自动化/桌面控制 | 12 | 3 | 6 | R3/R4/R5/放行未接，演练未做 |
| F 测试与 CI | 7 | 0 | 3 | live 用例过期、无一键验收 |
| G 安全/边界 | 6 | 0 | 3 | 红线已在，需回归与展示 |
| H 文档/运维/性能 | 6 | 0 | 0 | 注释/索引/长期运行 |
| **合计** | **75** | **18** | **27** | **P0 全部集中在 A/B/D/E** |

> 已完成、不要重做的底座：自动化内核（配方/读回/哈希链/一次性写板批准）、72 条桥命令、128 条 PCBA 布局规则、16 页面壳、三阶段设计门禁（plan→approve→execute）、GUI 15 动作白名单、DRC 异步任务与豁免、工单式全链路体检、483+73+26 测试基线。

---

## A. 设计主链（需求 → 制造包）

### A1 需求硬约束没有进入计划/放行门禁 【P1】
- 现状：`state.requirements` 只在 `src/pages/EdaPage.tsx:88,132` 作为 AI 上下文传给生成接口；`runtime/release-gate.mjs` 的子门只接收 acceptance/drc/placement/artifacts/pricing，没有"GPIO 够不够、电流预算、板框尺寸、接口/温度"的机器比对。
- 缺口：需求约束是"给 AI 看的文本"，不是"可验证门禁"；AI 可以产出违反约束但形式合法的计划。
- 要做：Requirement 增加结构化 constraints；计划编译输出 `constraintReport`；`gateFabricationRelease` 增加 `constraints` 子门；UI 展示约束达成/违反。
- 验收：故意把电流预算改小、把板框改小的计划被阻断（单测 + e2e），放行报告里列出逐条约束结论。
- 状态（第 23 轮）：🟨 机器门禁完成、UI 接线待补——新增 `runtime/constraints.mjs`：把 confirmed+hard 需求归一化为可校验约束（板框最小尺寸/总电流预算/GPIO 下限/必需接口/温度上限），与 `designFacts` 逐条比对，拿不到事实一律 unknown 且按 fail-closed 阻断；`gateFabricationRelease` 新增 `constraints` 子门，`/api/eda/release/gate` 与 `/api/production/release` 透传 constraints/designFacts，放行报告逐条列出 pass/fail/unknown/unclassified；测试 4/4（含改小电流预算/板框被阻断、缺事实阻断、满足时子门 pass 不被其它缺口连坐）。- 状态更新（第 27 轮，界面接线完成、仍 🟨）：验证页新增「A1 需求硬约束」折叠面板——把 `state.requirements` 自动带进 `releaseGate` / `productionExport` 请求（`constraints`），并录入 6 项设计事实（板框宽高/总电流/GPIO/接口/温度）；空值不写字段（拿不到事实 = unknown 阻断，不补 0）。闸门结果新增「A1 需求硬约束逐条结论」表（pass/fail/unknown/unclassified）。`buildDesignFacts` 抽成 `src/services/designFacts.ts` + 3/3 单测；`/api/production/export` 的门禁也透传同一份 constraints/designFacts（此前只有 release 路由透传，两条路会给不同结论——已修）。**剩余**：设计事实仍靠人工录入（EDA 读回板框/GPIO 的自动采集未接）；e2e 未加（闸门在 demo 模式禁用，需要真机运行时模式）。

### A2 选型检索无回退序列 【P1】
- 现状：`runtime/chat.mjs:88-121` 每条 query 只做一次 `library.device.search`；已区分 `error` 与 `found=0`（:117），但**没有** verification §6 建议的回退。
- 缺口：`BQ24074RGTR` 一类带后缀/品牌前缀的型号 0 命中后没有第二/第三次尝试，AI 只能拿空证据。
- 要做：查询变体链（去后缀 → 系列 → 品牌+品类 → 参数化），记录 attempts 与命中来源；提案页展示"回退证据"；统计命中率。
- 验收：历史 0 命中样本（BQ24074、4Ω3W 喇叭等）能给出候选或明确"无结果原因"，且不产生假身份。
- 状态（第 23 轮）：🟨 机制完成、UI 待接——新增 `buildQueryVariants` 确定性回退链（去括号封装/去品牌前缀/取第一段/去斜杠后缀，最多 5 级），每次尝试记 `attempts`/`usedQuery`/`fallback`，全空给 `NO_RESULT` 且不产生候选；单测 3/3。- 状态更新（第 27 轮，✅ 验收满足）：回退检索已产品化——抽出 `searchLibraryWithFallback` / `probeSelectionFallback`，新增只读路由 `POST /api/eda/library/search/fallback`（400 `SELECTION_QUERY_REQUIRED`）+ 验证页「A2 选型回退检索」面板（逐条展示命中来源与每次尝试）。真机检索 4 条历史样本：命中 4（回退命中 1：`扬声器 4欧 3W → 扬声器`），无结果 0；`BQ24074RGTR` 本次直接命中（库侧变化如实记录），`BQ24074 (SOT-23)` 命中的是无关器件——再次证明关键词命中 ≠ 等价。证据 `artifacts/a2-selection/real-fallback-20261020.json` + README；测试 `a2-fallback-http.test.mjs` 2/2（含 NO_RESULT 与 400）。**保留边界**：回退只做关键词变形，候选身份必须人工确认；"命中率统计"只是单次诊断，不是长期指标。

### A3 选型提案 → 设计计划跨页交接断裂 【P0】
- 现状：`src/pages/PartProposalPage.tsx:66-84` 生成的 `planned` 只存在组件 `useState`；页面文案说"下一步在验证中心批准这一份方案"，但没有任何存储/路由把 plan 交给 `EdaPage` 的计划编辑器（`EdaPage.tsx:424` 的 planText 是独立 state）。
- 缺口：用户勾选 7 颗新器件后，方案无法带到批准/执行；跨页刷新即丢。
- 要做：共享 draft store（Context/reducer）+ "送到设计批准"按钮（写 planText/planHash/来源提案 ID）+ 设计页读取并标注来源；批准令牌绑定该 planHash。
- 验收：提案 → 设计批准 → 执行全程同一 planHash，刷新/切页不丢；Playwright 覆盖。
- 状态：🟨 2026-10-19。已做：`draftStore` 新增独立的 `SchematicPlanDraft`；`PartProposalPage` “送到设计批准（EDA 页）”；`EdaPage` 载入计划编辑器、打开高级控制、校验时比对提案哈希（不一致显式警告）、批准后清草稿。证据：`src/services/draftStore.test.ts` 4/4；剩余：Page 级 Playwright 未做（需真实 Runtime/提案数据）。
- 当前结论（第 12 轮）：✅ 已关闭——提案草稿落 `sessionStorage`、EDA 页载入并显示来源/交接哈希、批准后清草稿；页面级 e2e 已补（`e2e/app.spec.ts`「选型计划草稿进入 EDA 页」）。证据：`draftStore.test.ts` 4/4、e2e 28/28。

### A4 引脚证据链未产品化 【P1，部分闭环】
- 现状：库元数据没有引脚功能名（verification §4/§6）；只能 PCB 落板后用 `getAllPinsByPrimitiveId`（`bridge.mjs:352`）；AI 网表在缺证据时 `status:blocked`（正面行为，但对"从零设计"是死路）。
- 缺口：没有"先落器件 → 读真实引脚 → 再生成网表"的产品化采集配方；网表里的工程判断没有 assumption 标记。
- 要做：新增"引脚证据采集"步骤（原理图侧能读什么读什么；PCB 侧 `pcb.pins.read`），产出证据表；网表生成要求每个 net 有 pin/方向/来源或显式 assumption；缺证据的执行计划直接阻断。
- 验收：网表证据可逐条展开；缺证据时 0 步执行并给可操作提示。

- 状态（第 23 轮，部分闭环 🟨）：
  - 新增 `runtime/pin-evidence.mjs`：`buildPinEvidence`（PCB 焊盘 → 位号/脚号/网络/层/通孔证据表 + 原理图位号覆盖比对）、`auditPinEvidence`（空证据/未知网络/重复焊盘/位号差异 fail-closed）、`assertPinEvidenceForNetlist`（`PIN_EVIDENCE_BLOCKED` 409）。
  - 新增 `POST /api/eda/pins/evidence`（只读；PCB 焊盘为权威来源，可选切原理图核对位号并切回 PCB），前端验证页新增"引脚证据链（A4）"面板。
  - 网表生成前置门禁：`POST /api/design/netlist/ai` 支持 `pinEvidence`（审计必须通过，结果回填证据 digest/counts）与 `requirePinEvidence`（不给证据 409 `PIN_EVIDENCE_REQUIRED`）；EDA 页"AI 生成项目网络表草案"先采集证据、审计不过直接不生成（从零设计无 PCB 时明确标注"无引脚证据"而不是伪造）。
  - 真机证据（2026-10-19）：衣橱板 180 器件 / 602 焊盘 → 591 个位号+脚号 / 419 有网络 / **172 未知网络** / 11 组重复焊盘（如 USB1.EP）；原理图 180 器件位号覆盖一致（onlySchematic/onlyPcb 均为空）；审计如实 `ok:false` 并阻断（不伪装通过）；采集后已切回 PCB，2 块铺铜/180 器件保持不变。证据 `artifacts/a4-pins/real-machine-pin-evidence-20261019T122510Z.json`。
  - 测试：`runtime/__tests__/pin-evidence.test.mjs` 9/9（含 3 条 netlist AI 门禁 HTTP 用例）。
  - 状态（第 48 轮，✅ A4 计划层 + assumption 结构化闭环）：
    - `runtime/netlist-assumptions.mjs`：assumption 从纯字符串归一为 `{text, direction(power/ground/signal/no-connect/unknown), source(explicit/inferred), needsReview}`，只按关键词分类、未知保持 unknown 不硬猜；`auditNetlistAssumptions` 输出 counts/items/blockers/warnings，空文本与非法来源 blocker，未标注方向 warning + `strictOk:false`。
    - `/api/design/netlist/ai` 返回 `netlist.assumptionAudit`（AI 生成默认 `source:'inferred'`）；显式 `strictAssumptions:true` 时未标注方向 → 409 `NETLIST_ASSUMPTION_UNMARKED`（fail-closed，不生成可执行网表）。
    - `runtime/automation/pin-first-flow.mjs` + `POST /api/automation/flows/pin-first-netlist`：两阶段计划"先落器件（R2，需一次性写板批准）→ 采集引脚证据（只读）→ 引脚审计（fail-closed gate）→ 生成网表（带证据摘要/assumption 标注）"，每阶段写依赖/是否需批准/预期证据；缺落板记录 → `PIN_FLOW_PCB_NOT_PLACED`、缺证据 → `PIN_FLOW_PIN_EVIDENCE_MISSING`、审计不过 → `PIN_FLOW_PIN_AUDIT_BLOCKED`、assumption 未标注 → `PIN_FLOW_ASSUMPTIONS_UNMARKED`，`executable:false` + blockers，**只出计划不执行**（`autoExecute:false`）。
    - 前端验证页 A4 面板新增「生成两阶段计划」：展示阶段/依赖/是否需批准/阻断原因，并明示不自动落板/不代批准/不自动生成网表。
    - 测试：`netlist-assumptions.test.mjs` 3/3（分类/审计边界、计划 fail-closed 与可执行路径、HTTP assumptionAudit + strict 409 + 计划路由）；runtime 743/743。
    - **剩余边界**：计划本身不自动执行（写阶段仍要人工批准；执行由既有 runner/批准通道负责）；"从零设计"仍需真实落板后才能采到 PCB 焊盘证据——这条是 EDA 物理限制，不是编排缺口。

### A5 位号未标注（`C?`）会破坏落板/同步 【P1，✅ 门禁+标注通道+真机清零】
- 现状：EDA 位号异步标注；PCB 自动位号与 BOM 不符（Round 34-35），需 create→`modify` 改位号；`runtime/pcb.mjs` 的 diff 把 `?` 单独计入 `unannotated`。
- 缺口：原理图侧没有"标注/校验"动作；含 `?` 的计划仍可能进入执行。
- 要做：探测/登记 schematic 标注命令（无 API 则 GUI 兜底）；执行前校验计划内 designator 不含 `?`；标注后跑 sync diff。
- 验收：含 `?` 计划被拒（明确错误码）；真机标注后 diff 清零。
- 状态（第 23 轮）：🟨 门禁与标注通道完成、真机清零待跑——新增 `runtime/designator.mjs`（`C?` 判定/计划断言/目标位号格式校验）；布局写回在快照前拒收 `?` 计划、PCB 计划引用 `?` 判不完整；新增真机验证过的桥命令 `schematic.component.designator.set`（`sch_PrimitiveComponent.modify(id,{designator})`）+ `POST /api/eda/schematic/designators/set`（写批准→逐件标注→保存→独立读回核对）；测试 4/4。**第 37 轮真机证据（清零）**：`GET /api/pcb/sync/verify` 只读校验当前工程「智能衣橱助手」→ 原理图 180 / PCB 180、`matched`=180、`unannotated`=[]、`ready=true`，designators 中 0 个含 `?` —— 位号差异真机清零，无需写板。证据 `artifacts/a5-designators/real-sync-verify-20261020.json` + `README.md`。**边界**：若未来再出现 `C?`，仍需签发一次性写板批准后执行标注；真机标注写入闭环此前已用桥命令+读回验证。

### A6 原理图批量落件未产品化 【P1】
- 现状：逐件创建 16–75s，连续第 2 件 `code 20 aborted`（Round 34）；已有"单命令内循环 + 小批 2–3 件"的脚本经验，但产品只提供单件命令。
- 缺口：180 件级工程必须靠临时脚本；无断点续跑/幂等。
- 要做：`schematic.component.create` 批内循环参数（或新 batch 命令）+ 按 LCSC/designator 幂等去重 + 断点续跑 journal；失败不改他人。
- 验收：整板一次（或分批）执行完成；重复执行不产生重复件；中断后可续跑。
- 状态（第 23 轮）：🟨 批量通道完成、UI/整板证据待补——新增 `runtime/schematic-batch.mjs`：逐项校验身份/坐标、按“身份+坐标”幂等匹配（同型号多颗不误判）、逐件创建且每件原子落进度（同 planHash 可续跑）、失败即停、保存后读回验收（缺件/重复件 fail-closed）；新增 `POST /api/eda/schematic/component-batch`（默认 dryRun，写盘必须 write 批准）；模块 6/6 + HTTP 2/2。**真机教训已固化**：连续创建会 `code 20 aborted`，所以必须逐件写状态、失败即停。**第 35 轮补：UI 入口已补（E2/R3）**——元件选型页新增「原理图批量落件（A6/R3）」面板：落件项 JSON 输入 → dry-run 计划（计数/逐项动作/planHash/身份未证明）→ 显式**签发一次性写板批准并执行**（失败可同 planHash 续跑），DEMO/无 Runtime 时按钮不可用。客户端新增 `schematicComponentBatchPlan/Apply`。**真机只读证据**：库检索到 `WS2812B` 后 dry-run → HTTP 200、`planHash=c2be7fe0…`、`counts={create:1}`；带 `dryRun:false` 但不带批准 → 409 `AUTOMATION_APPROVAL_REQUIRED`（fail-closed）。证据 `artifacts/a6-batch/real-batch-dryrun-20261020.json` + `README.md`。**剩余**：衣橱板整板 180 件真机写入/续跑证据仍需用户显式批准后执行（本项不代批）。

### A7 原理图网表连线 R3 ✅【P0】
- 现状：`sch_PrimitiveWire.create` 真机静默无效（§32/§36–38）；§82 证明"文档真正打开 + focus"时写入通道可用，但 R3 配方 `/api/design` 计划里的 `wire.create`/`net.connect` 尚未在真机跑通；ERC 158 项、引脚悬空 138 信息。
- 缺口：没有"网络赋名/连线 + 读回 `.enet pinInfoMap`"的稳定通道；R3 一直停留在方案。
- 要做：真机探测 wire.create 三种前提（打开文档/focus/network flag）→ 不可用则 GUI 点击连线 + 回读；实现 R3 配方（netFlag/wire + compose 读回 + 失败恢复）；把 ERC 结果接进配方门禁。
- 验收：2–3 器件网络写入后 `.enet` 目标 pin 的 net 名正确；删除后复原；连续 5 网稳定；ERC 悬空项下降。

- 当前结论（第 22 轮）：✅ **通道打通**（真机证据在案）。首轮真机探测已证明 `sch_PrimitiveWire.create` 静默无效，改用官方 API `sch_PrimitiveComponent.createNetPort`（`schematic.netPort.create`，写命令 30s 预算、不重放）→ `schematic.save`（必须 `===true`）→ 导出官方网表 `.enet` 分片取回（432KB 真实网表 > 256KB 内联上限；新增 `schematic.netlist.chunk` 2 片拼接）→ 按 `props['Unique ID']` + `pinInfoMap[pinNumber].net` 逐引脚读回。实现层：`runtime/net-connect.mjs`（计划/校验/执行/读回/回滚/中止恢复，7 条单测）+ 两个真实写路由（`POST /api/eda/schematic/net-connect`、`.../rollback`，均先消费绑定当前窗口+工程+文档指纹的一次性 write 批准）+ `scripts/a7-r3-acceptance.mjs`（probe/write/rollback 三相位）。真机结果：探测 5 个悬空引脚 → 写 5 个端口（`CP_R3_TEST_1/2/3`）→ 保存 → 读回 `C34.1→CP_R3_TEST_1、C34.2→CP_R3_TEST_1、C35.1→CP_R3_TEST_2、C35.2→CP_R3_TEST_2、C37.1→CP_R3_TEST_3` 全部命中（`verification.ok`，无计划外赋网，网表 92→95 nets、namedPins 419→424）→ **删除端口 + 保存 + 读回复原**（`remaining=[]`，5 个目标引脚回到无网）。证据：`artifacts/a7-r3/2026-10-19T09-51-44-141Z/`（probe/write/rollback/approval/state），首轮传输中止与精确清理在 `artifacts/a7-r3/2026-10-19T09-49-24-261Z/README.md`。
- 诚实边界：`CP_R3_TEST_*` 是**验证用临时网络**，写入后已全部删除复原；它证明"按网络名挂接 + 保存后网表读回 + 删除复原"通道可用，不等于替用户猜测真实网络归属（那需要设计意图）。ERC 悬空项在写入窗口的下降未单独留存报告（验收以网表逐引脚为准），真实语义连线的批量应用仍待用户提供网络表。

### A8 PCB 落板 R2 真机验收 ✅【P0】
- 现状：`pcb-sync-from-schematic` 配方已登记（`importChanges` + compose 两侧器件数 + GUI 菜单兜底）；真机**未执行写操作**（红线：人工批准）。
- 缺口：R2 的"逐 designator diff 清零、PCB 器件数 = 原理图 designators 数"没有真机证据。
- 要做：人工签发一次写板批准后跑 `node scripts/automation-run.mjs pcb-sync-from-schematic --approve`；把结果补进 `automation-kernel.md` 验收表。
- 验收：真机 `completed`；全 designator 对齐；journal 哈希链 ok；失败时证据含 stateShape。

- 状态更新（第 9 轮·安全前置）：工程写路由（placement/routing/finish/rollback/schematic repair）已补服务端写板批准闸门——真实写入必须消费一次绑定当前 EDA 指纹的 `write` 批准，绕开页面直接打 HTTP 不再能写板（`multilayer-http.test.mjs` 20/20）。**真机验收本身仍未做**：R2/R6 需要真机执行 + 用户签发写板批准。
- 状态更新（第 22 轮）：✅ **真机验收通过**。用户在会话中显式授权"需要我签发就控制电脑去自己实现"后，由代理控制本机 EDA 会话、在真实指纹上签发一次性 write 批准并执行；`node scripts/automation-run.mjs pcb-sync-from-schematic --param schematicUuid=04a04eb56ffd6173 --param expectedComponentCount=180 --approve` → **completed**，7 条审计、哈希链完整（`~/.circuitpilot/automation-runs/13a03fbe-9d9b-418b-b9f1-12dfce7940b3.jsonl`，已复制到 `artifacts/r2-r6-acceptance/r2-journal.jsonl`）；独立复核 `/api/pcb/sync/verify`：schematic 180 / PCB 180 / matched 180 / missing 0 / extra 0 / unannotated 0 / ready true。期间修复两个真实缺陷：① 读回原来用 `schematic.components`（含网络标识/图框共 593 图元）与 PCB 器件数比较，已改为新增 `schematic.parts.read`（仅 `componentType=part`）+ 调用方只读传入 `expectedComponentCount`（`schematic.*` 命令在 PCB 文档上下文真机必 500）；② 桥读命令偶发 HTTP 500 会误触发 GUI 兜底，新增 `expect.readRetries`（只重读、不重放写动作）。失败路径同轮真机验证：无批准 → `needs_approval` 0 步；复用已消费批准 → 409；批准绑定 PCB 后切到原理图页面 → 409 `AUTOMATION_APPROVAL_INVALID`（未执行任何写入）。证据：`artifacts/r2-r6-acceptance/`。诚实边界：本板执行前 designator diff 已是 0，R2 本轮价值是"通道真机跑通 + 读回证据"，`importChanges` 在已同步板上为 no-op；GUI 兜底菜单文案 `更新/转换原理图到 PCB` 在本机 EDA 3.2.186 找不到（E6 文案漂移待补，成功路径不依赖兜底）。
### A9 布局 R4 与规则引擎没有强制联动 【P1】
- 现状：`PlacementPage` 有 plan/apply/restore；128 条布局规则只在 `RuleCenterPage` 展示/审计；placement plan/apply 不调用规则审计，也没有 courtyard 重叠硬门禁（部分 verify 在 plan 内）。
- 缺口：布局"看起来对"与"规则通过"是两条线；写回前不强制。
- 要做：placement plan/apply 前后调用 `auditLayoutRules` + placement verify（板框/courtyard/间距矩阵）；不过则拒写；UI 展示规则结论。
- 验收：故意重叠/出框计划被拒；真机 apply 后回读与计划一致。
- 状态（第 23 轮）：🟨 审计适配器+写回门禁完成、真机/UI 展示待补——新增 `runtime/placement-rules.mjs`：把布局计划+读回板框翻译成 128 条规则输入（只填真有的几何，缺尺寸不编造），写回前审计；硬门禁里量到违规（如 MECH-05 器件出框）才阻断，证据不足（缺 courtyard/3D）记 `evidenceGapFailures` 但不冒充违规、也不宣布 releaseReady；`/api/eda/pcb/placement/apply` 非 dryRun 前置审计（`PLACEMENT_RULES_BLOCKED`），`/plan` 也返回 layoutAudit；测试 3/3。- 状态更新（第 27 轮，✅ 验收满足）：布局页新增「布局规则审计」面板——硬门禁阻断/证据缺口/警告/复查/通过/审计哈希逐项展示，明确"证据不足 ≠ 通过"；真机只读计划（180 器件、板框 60×40mm、135 颗纳入几何）审计 `ok=true`、阻断 0、证据缺口 1（SPACE-01 courtyard 缺失 → REVIEW）、`releaseReady=false`；真机故意把 U1 移到 `x=-1000mm` 后 `dryRun:false` 写回被 **409 `PLACEMENT_RULES_BLOCKED`（MECH-05）** 拒绝，拒绝发生在写入之前。证据 `artifacts/a9-placement/`；类型 `LayoutAuditSummary`；测试沿用 `placement-rules.test.mjs` 3/3 + build。**保留边界**：courtyard 数据缺失是证据缺口，不能清零；布局审计只是放行子门。

### A10 布线 R5 前端 0 入口 【P0】
- 状态更新（第 22 轮真机）：后端只读链真机可用（`/api/eda/pcb/routing/plan` 读回 5048 走线/412 过孔/602 焊盘，3 个断网，为 AMP_VCC 规划路由并通过独立复核）；但 `routing/apply` 真机写入连续两次遇 `BRIDGE_HTTP_ERROR`（EDA `line.create` 500），内部回滚后铜读回不变（未保存、未残留）。前端 0 入口 + 真机写铜未打通，本项仍 🟨。
- 现状：`/api/eda/pcb/routing/plan|apply|rollback|finish` 四条路由中 apply/rollback/finish 属**死路由**（无客户端、无 UI、无脚本消费者）；真机自动布线断于 ~65%，PCB DRC 1100（Clearance 925 / Connection 174）。
- 缺口：无 UI 参数面板、dryRun 对比、diff、回滚、收尾；无"只提交 0 新增违规"的产品门禁；布线器间距与规则不一致的问题未产品化处理。
- 要做：新增布线面板（计划/预览/apply/rollback/finish）；门禁：断网 0 + 新增违规 0；失败自动回滚；证据截图/几何快照入库。
- 验收：真机 dryRun → apply → 回读 → DRC 不增；回滚后铜几何复原；journal 完整。
- 状态（第 23 轮真机）：🟨→✅ 写铜通道**已打通**（单网络级）。修复 `routing/plan` 的 `nets` 过滤 bug（旧实现先用默认 24 条截断再过滤，导致按网布线永远 0 条——"假功能"）；真机对 `WS2812_D1`（2 孤岛）规划 1 条路由 → `routing/apply`（write 批准，`save:false`）**真实写入 3 段铜**，独立复核 `ok:true`（minGap 6.28 mil ≥ 6、connectivity connected、0 违规）→ 重新 plan 读回该网络不再出现在 brokenNets → `routing/rollback` 删除 3 个图元、`removed:3 residual:0`，板子读回 lines 0 / vias 0 复原。证据：`artifacts/a10-routing/real-apply-rollback-WS2812_D1-20261019T120809Z.json`、`artifacts/a10-routing/probe-line-create-20261019T120515Z.json`。**保留边界**：本板当时读回无铜，所以这是"空铜板上的真实写铜+回读+回滚"，不是整板自动布线完成；前端入口已由 `RoutingWritePanel`（E2 R5）补上（第 23 轮）。
- 状态更新（第 27 轮真机，🟨 多网络门禁成立、整板布线仍受真实工艺缺口阻断）：本机 e2e/EDA 在线（3.2.186）。只读读回铜 **1339 线/153 孔**（板子已有铜），断网 GND 119 岛等；对 `CODEC_3V3`+`USB_D-` 两网络规划均 `ok:true`（5 段铜+1 过孔），但独立复核 `minGap=-3.95mil`、4 条 `via-in-pad-to-pad` 违规 → `routing/apply` **400 `ROUTING_PLAN_REJECTED` 拒写**（拒写在写入循环之前）。证据 `artifacts/a10-routing/real-plan-2nets-20261020.json`、`real-apply-refused-2nets-20261020.json` + README（含铜计数快照间变化 1307/140→1339/153 的如实记录：非本轮写入、未保存）。**整板自动布线仍不可完成**：已铺铜板细间距器件必须盘中孔才能连通，需要库侧真实尺寸/工艺豁免或改规则，属人工决策，不伪造。

### A11 铺铜 R6 只有重建、无新建 【P0】
- 现状：`pcb.pour.rebuild`（`bridge.mjs:420`）+ GUI"工具→铺铜管理器→重建所有"兜底已登记；`pcb_PrimitivePour.create` 六类参数组合真机全失败。
- 缺口：新建铺铜区域仍需人工 GUI；R6 真机验收未做。
- 要做：R6 真机批准验收并记录铜皮数/DRC 下降；GUI 兜底做成配方（含菜单文案变化检测）；铺铜后跑 DRC 对比。
- 验收：重建后铜皮数 ≥ 期望；DRC 间距条数下降；证据可追溯。
- 状态（第 23 轮真机）：✅ 新建覆铜通道已打通。真机定位到官方 API 的正确构造：`PCB_MathPolygon.createComplexPolygon(flat)`（flat = `[x0,y0,'L', x1,y1, …, x0,y0]`，原生单位 mil）→ `PCB_PrimitivePour.create(net,layer,cp,…)`；`pcb.pour.create` 现支持 `outline:[[x,y],…]` 自动构造，`bridge` 新增 `pcb.pours.detail`（按网络/层读回）与 `pcb.pour.delete`（回滚）。新增 `POST /api/eda/pcb/pour/create`（write 批准 + 按属性读回 + 失败自动删除 + `SAVE_FAILED` 回滚；`cleanup:true` 为建后即删的真机自检模式）与配方 `pcb-create-pour` v1（读回数量断言）。真机验证：GND/顶层新建成功 → 读回 newCount 1、net/layer 匹配 → cleanup 删除 → 数量 2→2 复原、未保存。证据：`artifacts/a11-pour/real-machine-pour-create-20261019T120346Z.json`、`artifacts/a11-pour/probe-pour-create-math-20261019T120232Z.json`。**保留边界**：真机未执行"新建+保存"路径（避免把测试覆铜落盘；该路径由离线假桥测试覆盖）；铺铜后 DRC 对比仍待 E3 接线。

### A12 DRC R7 无 UI、取证靠手填路径 【P0】
- 现状：后端 `/api/eda/pcb/drc/start|cancel|report` + exemptions 完整（`server.mjs:962-1010`），但前端 0 调用（start/report 仅脚本/测试用，cancel/exemptions 死路由）；`ValidationPage` 的放行闸门要用户**手填** `drcReportPath`，默认值还是 6 层演示板 `deliverables/cp-multilayer-monitor-20261013/drc-report-20261013.json`（`ValidationPage.tsx:27-28`）。
- 缺口：真机 DRC 跑完也进不了产品流程；默认 demo 路径会让人误判。
- 要做：DRC 面板（start→poll→report→保存 JSON→自动喂 release gate）；豁免编辑器（校验配额/理由）；移除 demo 默认路径，改为当前工程/最近导出自动发现。
- 验收：真机 DRC 一键产出报告并在 UI 可分类查看；放行闸门无需手填路径；错误/中断有明确状态。
- 状态：🟨 2026-10-19 部分完成。已做：`runtime/evidence-store.mjs`、`/api/eda/pcb/drc/{start,report,latest}` 落盘、`ValidationPage` DRC 面板（启动→轮询→取消→自动填入闸门、删除 demo 默认路径）；剩余：豁免编辑器（读取/校验/配额）仍无 UI。证据：`runtime/__tests__/evidence-http.test.mjs` 3/3，`npm test` runtime 506 全绿。
- 状态更新（第 3 轮）：豁免编辑器已上屏（载入/按本次报告生成草稿/手动新增/逐条编辑/删除/保存；服务端校验理由/风险/正整数配额，UI 逐条显示问题）；DRC 面板新增分类结论（ready、总数/已豁免/未解释、截断、每条 finding）；`GET/PUT /api/eda/pcb/drc/exemptions` 从死路由变为 UI 消费（允许清单 15→13）。证据：`evidence-http.test.mjs` 4/4（含本机豁免文件隔离）、`route-contract.test.mjs` 3/3。剩余：逐条违规明细表（分类与模板已展示，明细仍只有 JSON）。
- 状态更新（第 4 轮）：逐条违规明细表已上屏（类型/规则、对象、网络/层、说明、结论映射自豁免与未解释；300 行显式截断）→ 本项验收满足，标 ✅。证据：`npm test` 512/512、`npm run build` 0。

### A13 ERC 收敛（原理图）【P1，建议产品化 ✅ / 明细受限 🟨】
- 现状：衣橱板 ERC 158 项（致命 0/错误 1/警告 19/信息 138，主要引脚悬空）；`repairSchematic` 有 UI，但无法替代连线。
- 缺口：ERC 报告没有归一化/豁免/自动修复建议的产品流程；与 R3 脱节。
- 要做：ERC 报告归一化 + 分类 + 豁免；自动修复建议（noConnect/netFlag）；A7 完成后重跑并入库。
- 验收：ERC 错误 0；警告逐条有结论；报告可进放行 gate。
- 当前结论（第 18 轮）：🟨 产品流程已落地、真机验收待 A7——新增 `runtime/erc.mjs`（归一化/分类/确定性修复建议/豁免校验/豁免文件原子写）+ 4 条 HTTP 路由（run/latest/exemptions GET/PUT）+ 证据落盘 kind=`schematic-erc` + 验证页「原理图 ERC 收敛」面板（DEMO 禁用真机取证、聚合计数与逐条明细分栏、豁免需理由、生成草稿/保存）。证据：`erc.test.mjs` 5/5、`erc-http.test.mjs` 1/1、ERC e2e 1/1、`npm test` runtime 536/536、build 0。**剩余**：真实衣橱板 ERC 错误清 0 需要 A7 网表连线完成 + 真机重跑；ERC 结论尚未并入放行 gate（当前作为独立证据，避免把原理图 ERC 冒充 PCB 放行证据）。
- 状态更新（第 23 轮核对）：🟨 产品流程已存在——`runtime/erc.mjs` 归一化/分类/豁免（必须写 reason、按 code/object 匹配）、`summarizeErcConvergence`（聚合条目显式标 aggregateOnly）、`/api/eda/schematic/erc/run|latest|exemptions` 落盘证据；`ValidationPage` 有"原理图 ERC 收敛"面板（运行取证/载入最新/豁免编辑/按报告生成草稿）。真机第 22 轮 ERC 158 项（fatal 0/error 1/warning 19/info 138）；本轮真机 acceptance 的 EDA ERC 返回 `[{type:"warn",count:6}]`（仅聚合、无明细，UI 已如实标注）。**剩余**：自动修复建议（noConnect/netFlag 逐条生成）与 A7 后重跑入库仍待产品化。

- 状态更新（第 23 轮，建议产品化 ✅ / 真机明细仍受限 🟨）：
  - `runtime/erc.mjs` 新增 `repairFor()`：按 code 生成**逐条结构化修复建议**——悬空→`no-connect`（给 `schematic.pin.noConnect` 命令与所需参数，并明确"必须人工确认电气意图"）、`pwr-flag`、`no-connect-review`、`net-flag`、`manual`；聚合式条目→`manual` 且 `blockedReason` 写明"没有对象/引脚，系统不猜"。
  - 每条 finding 带 `repair`（`autoFixable` **恒为 false**、`requiresHumanConfirm:true`、`steps`、`verify`）；报告带 `repairSummary`（kinds/autoFixable/requiresHuman）。
  - 验证页 ERC 条目新增可展开修复步骤与"建修复任务"：复用 `buildFixTaskFromFailure` 生成 read_only 任务草稿（带 ERC id + digest 证据），修复写图仍需重新计划/人工批准。
  - 真机（2026-10-19）：EDA ERC 仍只返回聚合计数（warn ×6，`aggregateOnly:true`）→ 建议如实降级为 `manual`（total 1 / autoFixable 0），随后已切回 PCB 文档，环境未改变；证据 `artifacts/a13-erc/real-machine-erc-repairs-20261019T130258Z.json`。
  - 测试：`erc.test.mjs` 7/7（含悬空/PWR_FLAG/聚合/manual 及豁免不丢建议）、`fixTask.test.ts` 4/4；runtime 646/646、vitest 95/95。
  - **边界**：真机 EDA 端 ERC 不返回逐条 items 时，无法生成"逐条有结论"的验收；ERC 错误清 0 仍需 A7 网表连线完成后真机重跑。
### A14 仿真证据未入库/无 UI【P1】
- 现状：ngspice 可用（T7 真机跑过 CC1/CC2/SDA/SCL）；但没有仿真入口 UI，`gateSimulation` 依赖 acceptance 里的 design checks。
- 缺口：仿真结果无法作为放行证据；用户看不到"仿真跑没跑"。
- 要做：仿真运行 UI（选择 netlist/参数/结果）→ 生成 acceptance 证据 → gate 消费；报告持久化。
- 验收：仿真报告可在放行闸门显示 pass/fail 与关键电压。
- 状态（第 23 轮真机）：✅ 仿真证据已产品化并真机产出。
  - 新增 `POST /api/eda/schematic/simulation/run`：网表来源 = 请求 `netlistText` → EDA `schematic.simulation.netlist.export`；都没有 ⇒ `SIMULATION_NETLIST_REQUIRED`（409）；`runSimulation` 真实 spawn 求解器，`verifySimulationEvidence` 校验来源/网表 sha256/产物哈希，失败 ⇒ `SIMULATION_EVIDENCE_INVALID`；证据落盘 `spice-simulation`（证据库新增类型），`GET /api/eda/schematic/simulation/latest` 读回。
  - 验收路由现在把 `designChecks`/全电路仿真结论**落盘**（`savedSimulation`）。
  - 真机实测（本机已装 `ngspice-46`，`/opt/homebrew/bin/ngspice`；旧文档"本机没有求解器"已过时）：对探针网表真实运行成功并落盘；对衣橱板跑 `/api/eda/schematic/acceptance`：`ready:true`，EDA 仍导不出 SPICE 网表（原理图没绑定仿真模型）⇒ 自动改用**设计检查点仿真**，真实求解器实测 `USB-C CC 下拉 Rd`：cc1=cc2=0.417V、vbus=5V → pass；`I2C 上拉` not-applicable；证据落盘 `spice-simulation-2026-10-19T12-21-41-529Z-17e98a65f717.json`（digest `17e98a65...`），`latest` 读回一致；`gateSimulation` 通过 `acceptance.designChecks` 消费该结论（放行闸门真实读取）。
  - UI：验证页新增"SPICE 仿真证据"面板（运行仿真取证/载入最新/运行原理图验收，显示求解器路径、证据哈希、工作点、阻断项）。
  - **边界（不夸大）**：当前是"设计检查点仿真"（2 项，1 通过/1 不适用），**不等于全电路仿真**；全电路仿真需要原理图绑定 SPICE 模型后 EDA 导出仿真网表。证据：`artifacts/a14-simulation/real-machine-acceptance-persisted-20261019T122141Z.json`、`real-machine-simulation-boundary-20261019T122030Z.json`；测试 `runtime/__tests__/simulation-http.test.mjs` 4/4。

### A15 制造包 R8 导出入口与 3D【P0/P2】
- 状态更新（第 22 轮真机）：R8 导出链真机验证——`requested:"final"` 被门禁拒绝写盘（8 类阻断、releaseDecision ready=false）；`requested:"draft"` 真 EDA 导出 Gerber/BOM/CPL 三件、强制 DRAFT-NOT-FOR-ORDER 命名、落盘后复核 pass 并写 manifest（gateFingerprint/decisionTicket/sha256）。证据 `artifacts/r2-r6-acceptance/r8-*`。
- 现状：`production/export`、`order-card` 有 UI；`/api/pcb/3d/export` 只有脚本/测试消费者（无 UI 客户端）；STEP ✅（10.9MB），GLB API 返回 null（T14）。
- 缺口：正式 final 导出流程（门禁→final 命名→manifest/sha256 校验）没有完整 UI；3D 导出无按钮；GLB 缺失没在 UI 明说。
- 要做：导出面板（draft/final 切换、清单/sha256 展示、失败原因）；3D STEP 导出按钮 + 证据；GLB 明确"官方 API 不可得"。
- 验收：门禁未过只能 DRAFT；通过后 final 产物可校验；UI 能下载/查看清单。
- 状态：🟨 2026-10-19。已做：`runtimeClient.pcb3dExport` + 验证页 3D 面板（STEP/GLB、字节数/sha256/分片数、GLB 不可得明确报错）；final 导出已强制统一裁决 ready。剩余：产物下载/打开入口、清单导出。
- 状态更新（第 7 轮）：清单 CSV 导出（第 4 轮）+ 组件 `GET /api/production/download`（第 7 轮：目录白名单/realpath/扩展名白名单/300MB/令牌）已补齐"下载/查看"入口 → 本项验收满足，标 ✅。证据：`production-download.test.mjs` 1/1、路由契约 88/77/11/0、`npm run build` 0。GLB 仍是官方 API 返回 null（A15 已接受"API 不可得"的明确提示）。
- 当前结论（第 12 轮）：✅ 验收满足——门禁未过只能 DRAFT、final 强制统一裁决 ready、导出后复核 manifest/sha256、清单 CSV 与产物安全下载均已上屏。证据：`production-download.test.mjs` 1/1、`route-contract.test.mjs` 89/78/11/0、e2e 28/28。

### A16 工程分析/规则审计结果不进主流程 【P2】
- 现状：`engineering/analyze`、`layout-rules/audit` 有 UI（ValidationPage/RuleCenterPage）但结果只显示，不作为放行/布局门禁输入。
- 要做：把 engineering findings 映射为 issue/豁免，纳入放行证据。
- 验收：工程分析 blocking 项直接阻断放行。
- 状态更新（第 46 轮，✅ 已接入统一放行门禁，向后兼容）：`runtime/release-gate.mjs` 新增 `gateEngineering({analysis,layoutAudit,exemptions})` 并纳入 `gateFabricationRelease` 的 `gates` 列表：
  - 缺省（未提供 `engineering`）→ 该门禁状态 `skipped` + info 记录"未提供工程分析证据"，**不阻断也不冒充通过**（既有调用方行为不变）；
  - 提供 `engineering` 时，`blocking` findings 映射为 `ENGINEERING_BLOCKED` 阻断；`warning` findings → `ENGINEERING_WARNING`（gate 可能 ready-with-warnings）；`layoutAudit.passed=false`/`releaseReady=false` → `LAYOUT_RULES_BLOCKED` 阻断；
  - 例外必须带 `code`+`reason`，否则 `ENGINEERING_EXEMPTION_INVALID`；提供了却没用上的例外记 `ENGINEERING_EXEMPTION_UNUSED` 警告（不静默吞）。
  - `POST /api/eda/release/gate`、`POST /api/production/release`、`POST /api/production/releases/archive` 三个调用点均透传 body 的 `engineering`/`layoutAudit`/`engineeringExemptions`；ValidationPage 工程分析结果已随放行/导出/归档请求一起提交。
  - 测试：`release-gate.test.mjs` 14/14（新增 3 条：缺省 skipped 不阻断/blocking 阻断/layout+例外规则）；真实证据 `artifacts/a16-release-gate/`。
  - **边界**：engineering findings 不会自动生成 B8 版本或改计划；`skipped` 只表示"本次没提供证据"，不能当 PASS；规则包覆盖范围仍以 `rules/` + layout-rules 审计结果为准。

---

## B. 放行与交付

### B1 三套放行口径不统一 【P0】
- 现状：`release-gate.mjs` 可判 `verdict: 'ready-to-order'`；`runtime/production.mjs:435` 固定 `productionReleased:false`，`:490` `online-dfm passed:false`，`:493` `orderEnabled:false`；`productionReadiness`/`productionRelease` 还是"未被 UI 调用"的客户端方法。
- 缺口：同一块板三个页面三种结论；用户不知道信哪一个。
- 要做：抽一个 `ReleaseDecision` 服务（输入同一组证据，输出 ready/blocked + 原因 + 指纹），release-gate/readiness/export 全部调它；UI 三处共用同一结论。
- 验收：同一证据下三页结论一致；单测覆盖"证据缺失→blocked"。
- 状态：🟨 2026-10-19 部分完成。已做：`runtime/release-decision.mjs` 统一裁决；`/api/eda/release/gate`、`/api/production/release` 响应均附 `releaseDecision`；`ValidationPage` 展示统一结论与逐项 blockedBy；剩余：readiness/export 的 UI 未共用同一块展示。证据：`runtime/__tests__/release-decision.test.mjs` 6/6。
- 状态更新（第 2 轮）：已补 `binding`（planHash/pcbUuid/manifestHash）——给 binding 时别的板/别的计划的 DFM/签核不能充数；单测 7/7。剩余仍是 readiness/export 的 UI 共用展示与 manifestHash 绑定。
- 状态更新（第 3 轮）：readiness 与 export 的 UI 共用同一份服务端裁决——`AssetsPage` 生产面板新增 readiness 统一裁决（逐门禁 source/原因、referenced 清单/终审哈希），导出结果渲染 `releaseDecision`（可放行/不可放行 + blockedBy）；`productionReadiness` 从 0 页面调用变为真实消费。export 仍只绑 planHash/pcbUuid（manifestHash 留在 readiness 校验，理由见任务计划 §6）。
- 当前结论（第 12 轮）：✅ 已关闭——gate / export / readiness 共用同一 `buildReleaseDecision` 结果，UI 三处展示同源（阻塞原因/证据来源一致）。
- 状态更新（第 25 轮，补上 export 的 manifestHash 绑定）：修复"先签核、后重导"漏洞——`/api/production/export` 现在接受 `manifestHash + binding`，用与 readiness 相同的 binding 重算当前 `artifactsDir` 的 manifest 哈希，再交给 `buildReleaseDecision` 的 `manifestHash` 绑定校验；正式导出时若已有签核却没给 manifestHash → `RELEASE_MANIFEST_BINDING_REQUIRED`，给了但与重算不一致 → `RELEASE_MANIFEST_MISMATCH`（旧签核不能复用到新物料），两种情况都 0 写盘。UI 侧 `AssetsPage` readiness 成功后把 `{manifestHash,binding}` 交接给 `ValidationPage`（sessionStorage），签核表单自动预填、正式导出自动携带；服务端仍以重算值为唯一可信值。证据：`runtime/release-binding.mjs` 4/4、`multilayer-http.test.mjs` B1/B4 HTTP 用例（缺哈希/哈希不一致/一致三态）。

### B2 在线 DFM 永远是 false → readiness 永远不 ready 【P0】
- 现状：`production.mjs:490` 把 `online-dfm` 写死 `passed:false`（理由：需要登录态/上传/人工确认 —— 这是对的），但没有"人工 DFM 证据回填"通道。
- 缺口：即使全部本地检查通过，readiness 也永远 `ready:false`，无法完成放行。
- 要做：DFM 证据接口（上传截图/报告 + 结论 + 操作人 + 时间 + hash）；gate 状态由证据驱动；UI 引导"去嘉立创 DFM → 回填结果"。
- 验收：回填合格证据后 DFM 子门通过；无证据仍 fail-closed。
- 状态：✅ 2026-10-19。`POST/GET /api/production/dfm-evidence` 落盘（显式 passed、操作人、结论、指纹）；`ProductionManager.readiness` 吃绑定到本计划的 DFM 证据（不再写死 false）；UI 有回填表单。证据：`production.test.mjs` 新增 bound-DFM 用例、`evidence-http.test.mjs`。

### B3 价格/库存不进闸门、不进订单卡 【P1，✅ 闭环】
- 现状：`gateSupply` 只有 warning；`/api/supply/pricing` 是死路由（无客户端/UI）；订单卡永远"价格未知"。
- 缺口：成本与缺货风险无法在放行前暴露。
- 要做：价格/库存采集（立创 BOM 导出/开放平台凭据/手工导入）→ 进 gate（至少 blocking-warning 策略）→ 订单卡展示；过期时间戳。
- 验收：有价格证据时订单卡显示总价/缺货项；过期证据标 warn。
- 状态：🟨 2026-10-19（第 5 轮）。已做：`POST /api/supply/pricing` 接线 + 验证页"供应链证据"面板（按 BOM 精确 C 编号查询、有价/无价条目与原因、时间戳/新鲜度；刷新后随 body 传给 release gate 与 production export，供应链闸门据此重算 warning；DEMO 禁用）。剩余：订单卡未显示总价/缺货项汇总（B7/P2）、过期策略仍由用户重查（没有定时刷新）。证据：`route-contract.test.mjs` 87/76/11/0、`release-gate.test.mjs` 已覆盖 gateSupply 判据。
- 状态（第 23 轮，✅ 闭环）：新增 `runtime/supply-summary.mjs`（已知单价合计/缺货项/库存未知/证据时效 TTL/货币混用 fail-closed 不合计）并接入 `POST /api/production/order-card`（请求带 `pricingEvidence` ⇒ 卡上 `supplySummary`）；验证页下单卡新增"已知单价合计 / 缺货料号 / 库存未知 / 证据时效"四项与逐条 finding；`gateSupply` 新增 `RELEASE_FRESHNESS_STALE`（超过 `staleAfterHours` 默认 24h 标 warning，下单前必须重查）。UI 生成下单卡时自动带上当前价格/库存证据（查询时刻快照）。
- 测试：`supply-summary.test.mjs` 6/6（合计/缺货/过期/混币/空证据/HTTP 回填）、`release-gate.test.mjs` 覆盖 stale 判据。
- 剩余（不阻塞本项）：没有定时刷新（价格证据仍需人工触发查询）；下单/支付仍永久人工，系统只出参数卡。
### B4 终审/签核无 UI、内存存储 【P0】
- 现状：`recordProductionFinalReview` 客户端方法**从未被页面调用**；`production.mjs:449` 的 `reviews` 是内存 `Map`；制造目录签核表为空。
- 缺口：放行所需的三方签核（硬件/工艺/项目）无法在产品内完成与追溯。
- 要做：终审页（三人签核 + 结论 + 理由 + 签名 hash + 绑 plan/manifest hash）+ 持久化 + 不可变记录；未签核时导出只能 DRAFT。
- 验收：签核后 final 导出解锁；重启后签核记录仍在；缺签核 final 导出被拒。
- 状态：🟨 2026-10-19（收口后）。已做：三方签核落盘 `POST/GET /api/production/signoff`（绑定 manifestHash/planHash）、`ValidationPage` 签核表单、终审记录持久化（重启存活）、**final 导出强制要求统一裁决 ready（缺签核/DFM → `RELEASE_DECISION_BLOCKED`）**；剩余：终审页与签核 UI 未合并、签核尚未驱动 readiness 的 `human-final-review` 子门。
- 状态更新（第 2 轮）：签核已驱动 readiness 的 `human-final-review`（绑定 planHash + manifestHash，source=`persisted-signoff`，重启后仍有效），并补证据板级绑定；剩余：终审页与签核 UI 未合并、export 路径未用 manifestHash 做 binding。
- 当前结论（第 12 轮）：✅ 验收条件已满足——三方签核持久化（绑 planHash+manifestHash）、重启后仍在、签核驱动 readiness 的 `human-final-review`、缺签核时 final 导出被 `RELEASE_DECISION_BLOCKED` 拒绝；终审/签核 UI 已同屏（DFM + 三方签核 + 统一裁决 + 导出）。遗留仅为页面组织偏好与 `recordProductionFinalReview` 标注 legacy。证据：`evidence-http.test.mjs` 4/4、`production.test.mjs` 14/14。
- 状态更新（第 25 轮）：export 路径开始真正使用 manifestHash binding（见 B1 第 25 轮）：签核文件绑定哈希 ≠ 本次产物重算哈希时，正式导出被 `RELEASE_MANIFEST_MISMATCH` / `RELEASE_MANIFEST_BINDING_REQUIRED` 拒绝，堵住"签核后换物料再导出"的复用口子。

### B5 放行默认证据路径指向 demo 板 【P0】
- 现状：`ValidationPage.tsx:27-28` 硬编码 `deliverables/cp-multilayer-monitor-20261013/...`；该目录存在旧 6 层报告。
- 缺口：用户直接点"运行闸门"会拿旧板证据算当前板。
- 要做：删除硬编码；按当前工程/最近导出/DRC 报告索引自动填充；允许手动覆盖但显示"来源"。
- 验收：新工程默认路径为空/自动发现，e2e 断言不再出现 demo 路径。
- 状态：✅ 2026-10-19。`ValidationPage` 硬编码 demo 路径已删除（`grep cp-multilayer-monitor src/pages/ValidationPage.tsx` → 0）；DRC 取证后自动填入，也可“载入最新取证”。

### B6 正式导出流程不完整 【P1】
- 现状：`decideProductionOutput` 与 DRAFT 命名逻辑存在；UI 有 productionExport，但"门禁通过 → final 导出 → 清单核验"没有一条龙。
- 要做：导出前校验 ReleaseDecision=ready；final 命名不可手改；导出后展示 manifest/sha256/文件数并复查。
- 验收：DRAFT 状态下"正式导出"按钮禁用；通过后产物可复核。
- 状态：🟨 2026-10-19。已做：导出前统一裁决 `ReleaseDecision`（本地门禁 + DFM + 签核）；final 命名由运行时决定、导出后复核 manifest/sha256；UI 展示清单与阻断原因。剩余：产物下载/打开入口、3D STEP 按钮、GLB 缺失提示。
- 状态更新（第 4 轮）：新增"导出清单 CSV"（文件哈希 + outDir + manifestSha256 + released + decisionTicket + 统一裁决一起落盘归档）；3D STEP/GLB 按钮已在 A15 完成。剩余：**产物本体下载/打开**——Runtime 无发文件路由，新增它等于开任意文件读取面，需单独安全设计（路径白名单 + 一次性令牌 + 仅产物目录），未做。
- 状态更新（第 7 轮）：安全下载路由已落地（`release/`、`deliverables/` 根白名单 + realpath 防逃逸 + 扩展名白名单 + 300MB 上限 + 令牌），导出文件表与 3D 面板均有"下载"按钮；`production-download.test.mjs` 覆盖越权/逃逸/类型/缺文件/无令牌。→ 本项验收满足，标 ✅（导出到白名单目录外的自定义 outDir 不提供下载，属刻意边界）。

### B7 订单参数卡信息不足【P2】
- 现状：`orderCard` 有 UI 与事实推导；缺少价格、交期、工艺能力、阻抗确认、缺货刷新。
- 要做的：把 B3 价格/库存 + 板厂能力 + 用户选择摆在一张卡上；仍不代下单。
- 验收：卡内每项有来源/假设标记。
- 状态（第 13 轮）：🟨 部分完成——下单参数卡内新增「供应链证据」区块：有价/无价料号数、查询时间戳、按下单数量估算的库存不足料号数；无证据时明确提示“未知不是 0 元”。剩余：交期/板厂工艺能力仍来自示例档、缺货替代候选未接入、价格与卡内 price 字段未做一致性校验。证据：`npm test`/`build`/e2e 29/29。
- 当前结论（第 21 轮）：✅ 卡内每项都有来源/假设标记——下单参数表新增「交期」行（示例能力档，明确"不是供应商实时承诺，不猜交期"）与「板厂能力档」行（capability.provenance/note/maxSize）；渲染 `orderCard.assumptions`（字段=值+原因）；新增一致性告警：卡内价格已知但本次无供应链价格证据时标红"不得据此下单"。**仍未接入**供应商实时交期/价格 API 与缺货替代候选（外部依赖，B9 跟踪）；系统不会把示例值当实时承诺。证据：TypeScript 0 + e2e 30/30（验证页订单卡路径被 e2e 覆盖）。

### B8 版本/归档与放行绑定【P2】
- 现状：版本快照 UI 有（VersionsPage）；终审后没有"不可变发布版本"。
- 要做：放行完成后打 immutable 版本（绑 planHash/manifestHash/签核/证据目录），可回看。
- 验收：发布版本不可编辑；可从版本追溯到证据。
- 状态更新（第 46 轮，✅ 不可变发布版本落地）：新增 `runtime/release-archive.mjs` + 路由 `POST /api/production/releases/archive`、`GET /api/production/releases`、`GET /api/production/releases/:releaseId`：
  - **只有服务端重算**的 `gate.ready && releaseDecision.ready` 都为真才允许归档（服务端重跑取证/门禁/DFM+签核裁决，不接受客户端自报 ready）；否则 409 `RELEASE_ARCHIVE_NOT_ALLOWED` 并带 blockers/blockedBy；
  - 记录绑定 `planHash`/`compiledPlanHash`/`manifestHash`/`reviewHash`/`pcbUuid`/`gateFingerprint`/`decisionFingerprint`；证据文件逐个记 `path+sha256+bytes`；写盘用 `wx` 已存在即失败，**模块没有 update/delete 接口**（不可变是能力缺失，不是 UI 约定）；
  - 读取时重算记录哈希并重新校验证据文件 sha256/长度：被改/缺失 → `verification.verified=false` + problems，不把"记录还在"当"证据可信"；
  - 前端：ValidationPage 放行结果区「归档为发布版本（B8）」（未 ready 时禁用并说明原因），VersionsPage 系统事件页只读列表展示版本/结论/指纹/证据数/重校验状态；
  - 测试：`release-archive.test.mjs` 4/4（ready 归档+追溯、未 ready/绑定缺失/证据不可读拒绝、篡改检测、HTTP 409/列表/404）；真实证据 `artifacts/b8-release-archive/`（真实 runtime 未 ready → 409 **被拒绝**，如实记录，不是 fake PASS）。
  - **边界**：归档本身不产生下单/支付能力（`orderEnabled:false`）；没有签名/第三方时间戳（不可变=本地只追加+哈希，不防有权限者整目录删除）；证据文件校验只覆盖归档时记录的文件，不覆盖之后新增的文件。

### B9 BOM 缺货/替代料刷新【P1，✅ 闭环】
- 现状：选型页有 stockNote；BOM 缺货料号需下单前刷新（放行状态记录 §3.4）。
- 要做：放行前强制刷新一次价格/库存并记录时间；缺货项列出替代候选（来自真实检索）。
- 验收：过期的价格/库存证据被标记，放行前提示。

- 状态（第 23 轮，✅ 闭环）：
  - 新增 `runtime/engineering/supply-alternatives.mjs`：`buildAlternativeQuery`（优先真实型号，其次 value+package）、`rankAlternativeRows`（排除原料号/去重；有货按库存降序，库存未知/为 0 靠后；**每条候选显式 `match:'keyword'` + `equivalence:'unverified'`**）、`findAlternatives`（逐条查询；空/失败/无效都带原因码，不整体成功、不伪造候选）。
  - `runtime/engineering/supply.mjs` 新增 `searchLcscByKeyword`（真实 JLC/立创 SMT 选料接口关键词检索，行归一化复用精确查询解析，缺价格/库存仍标未知）。
  - 新增 `POST /api/supply/alternatives` + 前端 `runtimeClient.supplyAlternatives`；验证页下单卡新增"查询缺料替代候选"：优先列出缺货料号，展示候选型号/封装/价格/库存与"等价性未验证"，不自动替换 BOM。
  - 真机证据（2026-10-19）：C6186（AMS1117-3.3/SOT-223）检索到 C347222（同型号同封装，库存 656,577，$0.0515）及两个 SOT-89 变体（C347256/C5120796）——恰好说明"关键词命中≠等价替代"，必须由工程确认封装/参数；C23186 的候选库存为 0（如实标注）；无型号/值输入的条目按 invalid 返回。证据 `artifacts/b9-alternatives/b9-alternatives-2026-10-19T12-58-31-817Z.json`。
  - 测试：`supply-alternatives.test.mjs` 4/4（查询构造/排序排除/逐条失败隔离/HTTP 注入检索）；runtime 644/644。
  - 边界：接口是第三方、随时可能变；查询失败只影响该条并给原因。替代候选**不会**自动写入 BOM/下单，等价性需人工确认。
### B10 制造物保留/清理策略【P3】
- 现状：deliverables 目录手动管理。
- 要做：按版本保留 + 清理策略 + 索引。
- 验收：旧草稿可清理，发布版本保留。
- 状态（第 25 轮，✅ 闭环）：新增 `runtime/artifact-retention.mjs`——`evaluateRetention`/`planRetention`/`applyRetention`（policy 支持 kind 白名单 / maxAgeDays / maxTotalBytes；未知时间、未来时间、未知大小、kind 不在白名单一律保留；缺 policy=关闭=全部保留）；`applyRetention` 默认 dry-run，必须显式 `dryRun:false` 且注入 `remove()` 才真删，单点失败进 `failed` 不中断、不伪装成功。接线：`POST /api/artifacts/retention/plan` 只扫描 `deliverables/release/manufacturing` 白名单目录并生成 plan（不删除）；追溯页「系统事件」提供"生成保留计划（dry-run）"按钮与摘要。**不暴露 HTTP apply**（删除能力不联网），发布版本仅由 policy 白名单+时间+预算共同决定。测试：`artifact-retention.test.mjs` 8/8；真实数据冒烟：evidence/manufacturing 目录扫描与 dry-run 计划正常。

---

## C. 数据 / 持久化 / 审计

### C1 业务状态基本不落盘 【P0】
- 现状：前端 `localStorage`（`AppContext.tsx:118,187`）；runtime 的 `plans`/`reviews` 是内存 Map（`production.mjs:449`）；聊天会话是内存 Map（`chat.mjs:275`）；执行/审计只在内存或前端 state。
- 缺口：重启 Runtime / 清缓存 / 换浏览器即丢需求、计划、审批、终审、执行历史；无法作为"工程记录"。
- 本轮状态（第 23 轮）：🟨 主体已打通。`runtime/project-state.mjs` 用原子写 store 持久化 `projects/activeProjectId/requirements/components/assets`，`GET/PUT /api/project-state` 做 fail-closed 校验（id 重复、activeProjectId 悬空、形状错误 → 400 `PROJECT_STATE_INVALID`；文件损坏 → `STORE_*` 不假装空状态）；前端启动时若服务端有业务状态则恢复（空状态不覆盖本地），编辑后防抖 800ms 写回（Runtime 不可达时纯本地不阻塞）。**真机验证**：写入探针项目 → 杀掉 Runtime → 重启 → GET 读回探针仍在 → 恢复空状态；证据 `artifacts/c1-project-state/real-machine-persistence-*.json`，测试 `runtime/__tests__/project-state.test.mjs` 3/3 + `appReducer.test.ts` 3 例。**剩余（核对后）**：聊天会话已有 `chat-transcripts.json`、设计/PCB 执行历史已有 `design-executions.json`/`pcb-executions.json`、批准有哈希链账本、DRC/DFM/签核/ERC/仿真证据均落盘；仍缺的是**前端 `versions`/`changes`/`audit` 的权威副本**与交付物索引（这些仍只在前端内存/localStorage）。
- 要做：runtime 持久层（SQLite 或每项目 JSON + 原子写），覆盖项目/需求/计划/审批/执行/问题/终审/证据索引；前端从 runtime 恢复；localStorage 只做 UI 偏好。
- 验收：重启后项目、计划、签核、执行历史仍在；并发写入不损坏。
- 状态：🟨 2026-10-19 部分完成。已做：`runtime/store.mjs`（原子写 + schemaVersion + 损坏 fail-closed）、`ProductionManager` 语义/编译计划与终审落盘并在启动加载、DRC/DFM/签核证据落盘；损坏时大声降级为内存（不返回假通过）；剩余：项目/聊天/执行历史未接入。证据：`runtime/__tests__/store.test.mjs` 4/4。
- 状态更新（第 4 轮）：**执行历史已接入**——`DesignManager`/`PcbManager` 用 `createJsonStore` 落盘（启动加载、执行结束/回滚后原子写），`GET /api/design|pcb/executions` 列表 + 按 id 详情 + EdaPage 面板；损坏时 server 大声降级为内存（不伪造历史），落盘失败通过 `persistenceError` 如实透出。剩余：项目、聊天会话仍未接入 runtime 持久层（前端仍靠 localStorage）。证据：`execution-persistence.test.mjs` 3/3、`execution-history-http.test.mjs` 1/1、`npm test` runtime 512/512。
- 状态更新（第 5 轮·chat 持久化的技术结论）：查证 `runtime/codexAppServer.mjs:137-148` 建线程时 `ephemeral: true`，且线程存活于 Codex app-server 进程内——**把 threadId 落盘并不能恢复会话**（重启后线程已不存在，反而制造"有记录但打不开"的假象）。因此本项不做"持久化 threadId"；聊天连续性目前靠前端 `localStorage` 的项目会话记录，若要 runtime 侧持久化应改为"持久化消息 transcript + 重启后重放历史重建线程"，属于产品/成本决策，未做。
- 当前结论（第 12 轮）：🟨 部分完成——执行历史（原理图/PCB）已落盘并可在 UI 查看；DRC/DFM/签核/批准账本已落盘。**未做**：项目数据与聊天 transcript 未接 runtime（聊天线程 `ephemeral:true`，落盘 threadId 无意义，需产品决策）。
- 状态更新（第 26 轮，前端追溯副本已落盘）：新增 `runtime/trace-state.mjs`（`versions/changes/audit` 的原子写存储 + fail-closed 校验：形状错误/缺 id/重复 id → 400 `TRACE_STATE_INVALID`；上限 版本 500 / 修改 2000 / 审计 2000，超出如实回报截断）；`GET/PUT /api/trace-state`；`AppContext` 启动从 Runtime 恢复追溯三件套（服务端为空不覆盖本地）、变化后防抖 1s 写回，localStorage 仅作离线缓存。测试：`trace-state.test.mjs` 4/4（校验/截断/重启读回/损坏 STORE_CORRUPT）、`trace-state-http.test.mjs` 2/2（PUT/GET 往返、重启读回、400 校验）、`appReducer.test.ts` +2（28/28）。**C1 剩余**：issues（问题中心记录）仍只在前端内存/localStorage；聊天线程仍 `ephemeral`（transcript 已可重建）；这是下一步。
- 状态更新（第 49 轮，✅ C1 收口）：新增 `runtime/issue-state.mjs` + `GET/PUT /api/issue-state`：问题中心记录落 Runtime 权威副本（原子写、schemaVersion=1、fail-closed 校验：形状/id 必填/重复 → `ISSUE_STATE_INVALID` 400、上限 300 条与前端 reducer 一致、超出如实截断）；`AppContext` 启动从 Runtime 恢复 issues（服务端为空不覆盖本地）、变化后防抖 1s 写回（失败只警告，本地缓存保留）。测试：`issue-state.test.mjs` 3/3（校验/截断、原子落盘+重开读回、HTTP 往返+400）。**C1 完整结论**：项目/需求/器件/资料、版本/修改/审计、问题中心、DRC/DFM/签核/批准账本、聊天 transcript 均已落 Runtime（聊天线程仍 `ephemeral`，用 transcript 重建上下文，这是 Codex 线程生命周期限制，不是落盘缺口）。
- 当前结论（第 20 轮）：🟨 **聊天 transcript 已落盘并可重启重建**——`ChatManager` 新增 transcript 持久化（`artifacts/state/chat-transcripts.json`，schemaVersion=1，原子写）：每轮成功问答存 user/assistant 文本（不含附件内容/图片 base64/令牌）；Codex 线程仍 `ephemeral:true`，重启后**用 transcript 重建线程上下文**（不是落盘无效 threadId）；第三方 API 后端优先使用落盘历史；`GET /api/chat/sessions/:id/transcript` 读回、`DELETE` reset 同时清空；前端 AI 页在 localStorage 为空（换浏览器/清缓存）时从 Runtime 恢复消息。**剩余**：项目/需求/组件本身仍未接 runtime 持久层（仍在 localStorage），C1 整体只能算部分完成。证据：`chat-transcript.test.mjs` 3/3（落盘→重启重建指令含历史→reset 清空→HTTP 401/读回/清空）、runtime 543/543、build 0、e2e 30/30、acceptance PASS。

### C2 审批账本不统一 【P1】
- 现状：自动化批准有服务端一次性账本（`runtime/automation/approvals.mjs`，write scope）；设计批准是内存 token（`design.mjs:165,179`）；plan/release 批准没有实现。
- 缺口：三种批准（计划/写板/放行）语义、有效期、绑定对象不一致；无法统一审计。
- 要做：统一 `ApprovalLedger`（scope=plan|write|release、指纹、planHash、TTL、一次性、审计）；设计/自动化/放行全部改用它。
- 验收：三类批准都能签发/消费/过期/复用拒绝；审计链一致。
- 状态更新（第 10 轮）：放行批准（release）补上入链点——三方签核成功后会写 `scope=release, action=issued` 记录（绑定 planHash/manifestHash/pcbUuid），三类批准现在都能在同一哈希链核对。证据：`evidence-http.test.mjs` 4/4。剩余不变：三套实现未合并为同一签发 API；release 仍是持久证据裁决而非一次性令牌。
- 状态：🟨 2026-10-19（第 8 轮）。已做：统一只追加哈希链账本（落盘、重启可核对、篡改可检出、损坏不伪造历史）；计划批准（设计/PCB `ApprovalStore`）与写板批准（自动化 `createApprovalStore`）的签发/消费/撤销/过期/复用拒绝全部入链；`GET /api/approvals/ledger` + 验证页"统一批准账本"面板（作用域/动作/批准ID/绑定/链校验）。证据：`approval-ledger.test.mjs` 5/5、路由契约 89/78/11/0。剩余：① 放行批准仍无独立签发点（以人工签核证据 + `ReleaseDecision` 表达）；② 三种批准仍各自实现（计划 token / 写板 approvalId / 放行签核），未合并为同一签发 API——统一的是审计链，不是全部语义。
- 当前结论（第 12 轮）：🟨 大部分完成——统一只追加哈希链账本已落盘、可校验、防篡改；计划/写板/放行三类批准生命周期全部入链（放行=签核时写 release/issued）；UI 可查。**未做**：三套批准实现合并为同一签发 API。证据：`approval-ledger.test.mjs` 5/5、路由 89/78/11/0。
- 当前结论（第 17 轮）：✅ 核心已合并——新增 `runtime/approval-service.mjs` 作为**唯一**签发/校验实现（scope/TTL/一次性/绑定校验/审计事件），`Design ApprovalStore`（plan）与 `automation createApprovalStore`（write）都改为其薄适配器，对外 API/错误码/账本与 journal 记录保持兼容；`store.test`/`design.test`/`ledger.test`/`automation-http`/`multilayer-http`/`fail-closed` 全绿。**有意不合并的部分**：release 批准是持久签核证据（不是一次性令牌），仍以签核文件表达并写入同一哈希链账本——这是产品语义差异，不是两套实现。证据：`approval-service.test.mjs` 5/5、`npm test` runtime 530/530、e2e 29/29。

### C3 事件与审计无统一消费入口【P2】
- 现状：`/api/events` 存在但无 UI；变更/审计分散在 AppContext 与 journal。
- 要做：Evidence Timeline 页（执行/批准/门禁/签核/导出），支持导出诊断包。
- 验收：任意一次运行可回放完整时间线。
- 状态（第 13 轮）：🟨 部分完成——VersionsPage 新增「系统事件」页：Runtime 日志事件时间线（级别筛选/刷新/导出运行事件 JSON），并明确标注“进程内存日志 ≠ 持久审计”；持久证据（批准哈希链、执行历史、DRC/DFM/签核文件）各有入口。剩余：没有把“执行/批准/门禁/签核/导出”合成一条可按运行回放的时间线（需要给 journal/evidence 增加统一 runId 关联）。证据：`app.spec.ts` 系统事件 e2e 1/1、build 0。
- 状态（第 39 轮）：🟨 统一时间线落地——`runtime/timeline.mjs` 把 **执行 journal（run/步骤/回读/证据阶段）+ 统一批准账本（签发/消费/撤销/过期/不匹配）+ 证据索引（kind/digest/savedAt/path）** 合成一条按时间倒序的时间线；支持 `runId` 过滤；坏行/坏证据进 `invalid` 并置 `complete=false`，来源不可用写 `available:false+reason`，时间未知排最后；`GET /api/timeline`（limit 有界+truncated）。追溯页「系统事件」新增「C3 统一证据时间线」面板（runId 过滤/三类计数/来源可用性/坏行提示）。
  - 真机证据：`artifacts/c3-timeline/real-timeline-20261020.json`（真实 Runtime：total=869、run 333/approval 500/evidence 36、complete=true、invalid=0、runId 过滤实测 allMatch=true）。
  - 测试：`runtime/__tests__/timeline.test.mjs` 4/4（合并/倒序/账本不冒充 run/runId 过滤/fail-closed/HTTP）。
  - **剩余**：门禁/签核/导出目前以"证据文件"身份进入时间线，尚未给签核与导出各自打 runId 强关联（当前 evidence↔run 是路径/note/内容启发式）；时间线是只读汇总，不是新权威账本。
- 状态更新（第 56 轮，✅ C3 收口）：新增 `runtime/timeline-links.mjs` + `POST /api/timeline/link` + `timeline-links.jsonl`（append-only）——把签核/导出等证据 **digest 显式关联到一次 run**（run 不存在/证据不在索引 404、重复 409、形状非法 400、坏行进 invalid 不静默丢）；`GET /api/timeline` 读回链接，证据条目精确标注 `runId + linkedBy:'explicit'`，按 runId 过滤可命中；追溯页「系统事件」时间线面板新增 digest 输入 +「关联到该运行」。测试：`timeline-links.test.mjs` 3/3（形状/坏行/append-load、时间线显式标注与过滤反例、HTTP 404/409/成功读回）；runtime **753/753**。**边界**：未登记关联的证据仍走原启发式（不伪造）；链接是人工/上层登记的事实，不等于第三方签名。

### C4 需求/计划变更不会自动失效【P1】
- 现状：计划批准绑定 planHash（好），但需求/器件/文件变化后，旧批准/旧计划不会自动标废；`invalidateTaskApproval` 靠页面手动调用。
- 要做：定义失效触发（需求版本、器件身份、EDA 指纹、代码版本），自动标 stale 并要求重批准。
- 验收：改需求后旧批准 409/stale；计划重新生成。
- 状态（第 56 轮，✅ 收口核对）：C4 两类环境触发器均已实现并有测试——`AiTask.boundEnv {edaFingerprint,runtimeVersion,at}` 在批准时绑定（`SET_TASK` approved 分支），`CHECK_ENV_DRIFT` reducer 对 EDA 目标指纹/运行时版本漂移自动 `invalidateTaskApproval`（触发 `eda`/`code`，说明原因），`AppContext` 在 `eda.targetFingerprint`/`runtime.serviceVersion` 变化时 dispatch 检查；`appReducer.test.ts` 覆盖批准绑定、同值不标废、EDA 漂移、版本漂移、无 boundEnv 不误伤。因此"前端提前标 stale"不再是缺口；运行时侧指纹/planHash 漂移拒绝仍是双保险。
- 状态：🟨 2026-10-19（第 6 轮）。已做：reducer 级自动标废（新增/修改需求、修改器件、BOM 草案写入、资料增删 → `approved/planned` 任务退回 `planned`、作废旧 planHash、记录 `invalidation{trigger,reason,at}`），AI 任务页明确警示；运行时侧 planHash/fingerprint 漂移拒绝保持（双保险）。证据：`appReducer.test.ts` 20/20、`taskMachine.test.ts` 11/11。剩余：EDA 指纹/代码版本两类触发器仍由运行时在执行/批准时拒绝（没有前端"提前标 stale"）；已执行完成的记录按历史保留，不标废。

- 状态更新（第 24 轮，✅ 前端提前标 stale）：
  - `AiTask` 新增 `boundEnv`：任务批准时（`PATCH_TASK status='approved'`）自动绑定当前 `state.eda.targetFingerprint` 与 `state.runtime.serviceVersion`。
  - 新增 reducer 动作 `CHECK_ENV_DRIFT`：EDA 目标指纹变化 → `invalidation.trigger='eda'`、Runtime 版本变化 → `trigger='code'`；已批准/已计划任务退回 `planned` 并写清"批准时/当前"值，草稿不受影响。`AppContext` 监听两处状态自动派发，不依赖页面记得调。
  - `EdaPage.syncPcbContext()`：PCB 上下文读回统一入口，把真实 `targetFingerprint` 写入全局并检测漂移——指纹变化立即清空 PCB 批准/执行结果并 notify/audit（前端提前失效，后端指纹校验仍是最后兜底）。
  - 测试：`appReducer.test.ts` C4 环境漂移 3 例（绑定快照/同指纹不误伤/EDA 与 code 触发/草稿不受影响）；vitest 98/98。
  - 边界：真正生效的写门禁仍是 Runtime 一次性令牌绑定 `windowId+projectUuid+documentUuid+targetFingerprint`，前端仅做提前提示，不参与放行。
### C5 证据索引/保留/清理【P2】
- 现状：`artifacts/automation-runs/*.jsonl` 有 maxEntries；DRC/导出/截图无索引。
- 要做：证据登记表（kind/path/sha256/time/runId）+ 保留策略 + 清理任务。
- 验收：任意结论能追到证据文件与 hash。
- 状态（第 25 轮，✅ 闭环）：新增 `runtime/evidence-index.mjs`——`buildEvidenceIndex` 扫描证据目录生成 `{entries(kind/digest/savedAt/fingerprint/note/schemaVersion), invalid, duplicates, errors, complete, truncated}`（坏文件进 invalid 并如实标记 complete:false，不隐藏）；`findEvidence(kind|digest)`；`planEvidenceRetention` 只生成保留计划（dry-run，模块无删除能力；时间未知/未来/损坏一律保留，索引不完整时 safeToApply:false）。接线：`GET /api/evidence/index`、`GET /api/evidence/find`、`POST /api/evidence/retention/plan`；追溯页「系统事件」可读索引、按 digest 查找证据、生成保留计划。真实数据冒烟：`artifacts/evidence` 34 条/74MB 建索引 complete=true、149ms。测试：`evidence-index.test.mjs` 7/7。边界：索引每请求全量读盘，高频场景需 TTL/ETag（当前页面按需触发）。

### C6 多项目/多窗口隔离【P2，✅ 项目级隔离+绑定校验+真实 GUI 切换验收】
- 现状：前端单 activeProject；runtime 支持 workspace 选择但项目数据不分片。
- 要做：项目级数据隔离与切换；EDA 窗口与项目绑定校验。
- 验收：两项目并行不串数据。
- 状态（第 38 轮）：
  - Runtime：`project-state.mjs` 新增项目级切片（读 `sliceProjectState` / 写 `normalizeProjectSlice`，跨项目实体 400 不静默改归属）+ `createProjectScopedStore`（每项目一个文件 `project-states/<id>.json`，缺失时从聚合状态迁移只读切片）；新增 `GET /api/projects`、`GET/PUT /api/projects/:id/state`、`GET /api/projects/:id/binding/verify`（EDA 窗口↔项目绑定只读校验，未绑定不碰 EDA 会话）。
  - 前端：`AppContext` 启动先取聚合拿项目列表、再取当前项目切面；切换项目先把上一项目落盘再加载新项目切面（仅当内存工作集来自该项目切面时才写项目文件，防串写）；`ProjectsPage` 项目详情新增「C6 EDA 窗口绑定校验」面板，不一致时明确"不要签发写板批准"。
  - 测试：`project-isolation.test.mjs` 3/3（切片读不串项目/写强制打标、跨项目实体/错误 activeProjectId/非法 id/未知项目 400/404、绑定校验一致/不一致/未绑定不碰 EDA）；真实运行时 fail-closed 证据 `artifacts/c6-isolation/real-runtime-failclosed-20261020.json`。
  - 状态（第 57 轮，✅ 真实 GUI 切换验收）：`e2e/c6-project-switch.spec.ts` 不 mock Runtime——spec 自起真实 `runtime/server.mjs`（4178、全新临时状态目录），经真实 API 种两个项目（甲/乙各一条需求）与两份互斥切面，浏览器里点「设为当前」在甲↔乙来回切换，断言需求工作集只显示当前项目、且服务端读回两份切面没有交叉写入；已接入 `npm run acceptance` 的 `c6-project-switch` 必需步骤（约 3s，不需要 EDA/写板批准）。
  - **剩余边界**：本 spec 不验证"EDA 窗口↔项目绑定"的真机 fingerprint（该分支由 `/api/projects/:id/binding/verify` 运行时测试与 fail-closed 路径覆盖，真机绑定仍需 EDA 环境）；项目状态文件是逻辑隔离，不是磁盘加密权限边界。

### C7 schema 版本与迁移【P2】
- 现状：localStorage 有 v2/v3/v4 迁移；runtime 无 schemaVersion。
- 要做：runtime 存储加 schemaVersion + 迁移脚本 + 兼容测试。
- 验收：旧数据可升级，不丢字段。
- 状态（第 15 轮）：✅ 机制完成——`createJsonStore` 支持 `migrations[旧版本]` 逐级迁移（load 不写盘、返回 `migratedFrom`、迁移函数需幂等）；未来版本文件被显式拒绝（`STORE_SCHEMA_MISMATCH` + `direction:'future'`）；缺迁移/迁移抛错/迁移返回空数据分别 `STORE_MIGRATION_MISSING`/`STORE_MIGRATION_FAILED` fail-closed。当前所有持久文件均为 v1，暂无现网迁移脚本需求；机制已由测试覆盖。证据：`store.test.mjs` 6/6、`npm test` runtime 521/521。

### C8 隐私/日志脱敏【P2】
- 现状：凭据走 keychain（好）；日志/诊断包可能含路径/项目信息。
- 要做：诊断包导出前脱敏清单 + 审查；provider 请求数据提示。
- 验收：诊断包不含 key/token；用户可预览。
- 状态（第 25 轮，✅ 闭环）：新增 `runtime/log-redaction.mjs`——`redactSecrets` 结构化脱敏：敏感键整值 `[REDACTED]`、自由文本擦 Bearer/JWT/sk-/URL token/邮箱/本机路径（`/Users/<user>`、`C:\Users\...`、`file://`）、循环引用 `[Circular]`、超深/超长安全降级、Error/Date/Map/Set/Buffer/BigInt 与抛错 getter 均不崩、输出可 JSON.stringify；`runtime/logger.mjs` 的 `redact` 已改为委托该模块（保留导出兼容旧调用/测试）。取向是"宁可多擦"：诊断包/日志/错误上报同一套规则。测试：`log-redaction.test.mjs` 6/6、`logger.test.mjs` 通过。边界：极端场景（把密钥写进普通键名的短字符串）仍需调用方可读性审查；脱敏不是权限控制。

---

## D. 前端与页面交接

### D1 路由/客户端覆盖率缺口（以当前代码对账）【P0/P1】
- **13 条死路由**（无产品、无脚本、无测试消费者）：
  - 布线：`POST /api/eda/pcb/routing/apply`、`rollback`、`finish`（plan 仅脚本/测试）
  - DRC：`POST /api/eda/pcb/drc/cancel`、`GET/PUT /api/eda/pcb/drc/exemptions`（start/report 仅脚本/测试）
  - 设计：`POST /api/design/cancel`、`POST /api/design/capabilities/probe`
  - GUI：`POST /api/eda/gui/execute`、`GET /api/eda/gui/state`
  - 供应：`POST /api/supply/pricing`
  - 执行证据：`GET /api/design/executions/:id`、`GET /api/design/executions/:id/evidence`
- **6 条只有脚本/测试用、无 UI**：routing/plan、drc/start、drc/report、schematic/acceptance、project/open、pcb/3d/export。
- **4 个客户端方法从未被页面调用**：`productionRelease`、`normalizeProductionPlan`、`productionReadiness`、`recordProductionFinalReview`（另有 `generateDesignPlan`、`engineeringProfiles`、`events` 也未被页面调用）。
- 状态：🟨 2026-10-19。已做：路由契约测试（84 路由/消费者/允许清单 13/孤儿 0）；死路由 `GET/PUT /api/eda/pcb/drc/exemptions`、`POST /api/pcb/3d/export` 已由 UI 消费；`productionReadiness` 已由 AssetsPage 消费。剩余：`productionRelease`、`normalizeProductionPlan`、`recordProductionFinalReview`、`generateDesignPlan`、`engineeringProfiles`、`events` 仍无页面调用（终审走签核路径，生产输出走 export 路径；这些方法应标注 legacy/internal 或删除）。
- 状态更新（第 4 轮）：上述 6 个方法已加 `@legacy` 注释并写明替代路径；路由契约仍 87/75/12/0。剩余：是否最终删除这些方法留待下一轮决策（删除会破坏未知外部调用方，先标注更稳）。
- 要做：按 P0 接 UI（DRC、布线、3D、放行、终审）；对确定不做的死路由（gui/state、gui/execute、design/cancel、capabilities/probe）显式删掉或标注 internal，并加"路由必须有消费者或标记 internal"的契约测试。
- 验收：路由清单与消费表纳入 CI；不再新增孤儿。
- 当前结论（第 12 轮）：🟨 收口——89 路由 / 78 消费者 / 允许清单 11 / 孤儿 0，路由契约测试强制对账；`events` 已接 UI（系统事件页）；剩余 5 个未消费客户端方法（`generateDesignPlan`/`normalizeProductionPlan`/`recordProductionFinalReview`/`engineeringProfiles`/`productionRelease`）已标注 `@legacy` 并写明替代路径。剩余：是否删除这些方法与内部路由，待产品决策（删除会破坏未知外部调用方）。
- 当前结论（第 21 轮）：✅ **决策收口**——不删除 legacy 客户端方法，统一标注 `@legacy LEGACY/未接 UI` 并写明替代路径（生产计划走 generateReviewedNetlist+语义草稿；终审走三方签核；放行走 productionExport；工程档位未产品化）。路由契约实测 95 条 / 有消费者 87 / 允许清单 11 / 孤儿 0；允许清单 11 条全部带原因/TODO（布线写回仅受控脚本、GUI 兜底未接 UI、执行证据查询待接等），属"故意不接"而不是遗忘。证据：`route-contract.test.mjs` 3/3、`grep @legacy` 5 处。

- **当前结论（第 66 轮，2026-10-20，与 4 层能力对齐的前端补口）**：✅ 三类"前端没跟上全流程"的不一致已修：
  1. **叠层（4 层）没有前端入口** → 新增 `src/components/LayerStackPanel.tsx`（EDA 执行页）接 `GET/POST /api/eda/pcb/layers`：读当前铜层数/层列表、填目标层数（2,4,…,32）→ 签发一次性 write 批准 → 写 → 服务端读回校验/保存/证据，UI 展示 before/after/期望铜层/保存状态；`runtimeClient` 新增 `pcbLayers`/`setPcbLayers`（`routing/finish`、`pcbPours` 一并补齐）。
  2. **布线写入缺"收尾"** → `RoutingWritePanel` 新增「收尾：重建铺铜并保存」按钮（`POST /api/eda/pcb/routing/finish`，消费 write 批准），收尾后回读覆铜详情上屏；路由契约允许清单中 `routing/apply`、`routing/rollback`、`routing/finish` 三条已从 KNOWN_UNWIRED_ROUTES 移除（已有 UI 消费者）。
  3. **新手链路第⑦步指向错页** → `GUIDED_FLOW` 拆为 ⑦ 交付导出（`validation/verify`，导出/放行闸门/签核实际入口）+ ⑧ 追溯归档（`versions`，只做证据核对/归档）；`navigation.test.ts` 新增断言（交付步骤必须落在有导出能力的页面、顺序在验证之后追溯之前）；`docs/implementation/information-architecture.md` 同步为 8 步。
  验证：`npm run typecheck` 0 错误、vitest 165/165、`route-contract.test.mjs` 3/3、`npm run build` 通过。仍保留的脚本/内部通道（GUI 兜底、design/cancel 等）按第 21 轮决策不接 UI。

### D2 四处跨页死链【P0/P1】
1. `AiTasksPage.tsx:60` 的 `productionCandidate` 只存在 useState，"进入 EDA 编译与审批"只做导航，候选计划丢失 → 共享 draft store。
2. `ValidationPage.tsx:79` "创建 AI 修复任务" 写入 `state.task.goal` 并 `navigate('ai')`，但**没有任何页面读 `state.task.goal`**（旧聊天页已并入设计页）→ 修复任务预填或删按钮。
3. 选型提案 → 计划（A3，P0）。
4. 阶段机只在 `EdaPage.tsx:282` 推进到"原理图"，后续阶段无人推进 → 按执行/验证事件推进（P2）。
- 状态：🟨 2026-10-19 部分完成。已做：AI 任务页计划候选 → `sessionStorage` 草稿 → EDA 页自动载入（可直接编译/准备执行）；验证页“创建修复任务”的目标 → AI 任务页横幅 + 输入预填 + 作为 `instruction` 传给计划生成；剩余：器件提案→plan、验收→EDA 两处仍只跳页面。证据：`src/services/draftStore.test.ts` 2/2。
- 状态更新（第 3 轮）：器件提案→plan 已打通（独立 `SchematicPlanDraft` + 选型页"送到设计批准"+ EDA 页载入/哈希比对/批准后清理；`draftStore.test.ts` 4/4）。第 4 项阶段机属 P2 未做；①②③ 的 Playwright 断言仍缺（需要真实 Runtime/AI 数据）。
- 状态更新（第 11 轮）：①②③ 的页面级回归已补：新增 2 条 Playwright e2e（验证页创建修复任务→AI 页横幅/输入框同文本；sessionStorage 草稿→EDA 页计划编辑器载入并显示来源与交接哈希），`npx playwright test e2e/app.spec.ts` 28/28。剩余：第 4 项阶段机自动推进（P2）未做。→ ①②③ 已关闭。
- 当前结论（第 13 轮核对）：✅ ①②（计划候选→EDA、修复任务→AI 页目标）③（选型提案→EDA 计划）均已打通并有页面级 e2e；仅第 4 项“阶段机自动推进”属 P2 未做，不影响本项死链关闭。

### D3 Demo 数据边界不清 【P0】
- 现状：`demoAdapter` 被 `EdaPage`、`SettingsPage`、`VersionsPage`、`AssetsPage`、`ValidationPage` 使用；`ValidationPage.tsx:51,571` 的"工程验证矩阵"仍是 Demo 模拟（"Demo 模拟检查，不替代 EDA 原生报告"），但真实闸门与 Demo 结果同屏。
- 缺口：用户可能把 Demo 的 pass 当真实通过（假通过红线）。
- 要做：Runtime 未连接时禁用/明确水印"演示数据"；真实结果与 Demo 分栏；e2e 断言 Demo 时关键按钮不可执行；数据源标记进入每条记录。
- 验收：无 Runtime 时写/放行按钮禁用；页面上任何结果都有数据源标签。
- 状态：🟨 2026-10-19 部分完成。已做：验证页顶部 DEMO 横幅（明示“不能作为放行证据”）、demo 模式禁用 DRC 取证/放行闸门按钮、移除 demo 路径；剩余：验证矩阵每条结果未逐个带 source 标签。
- 状态更新（第 2 轮）：已补逐条 source 标签（`ValidationCheck.source` = demo/runtime/official/manual），Demo 运行结果标“DEMO 模拟”，抽屉显示数据来源 → 该项完成。
- 当前结论（第 13 轮核对）：✅ 验证矩阵逐条 source 标签（demo/runtime/official/manual）已上屏，DEMO 结果明示且不作为放行证据。

### D4 问题中心与失败可诊断性【P1，✅ 闭环】
- 现状：`reportIssue` 有；失败任务、404、门禁失败、执行回滚分散。
- 要做：统一 issue 入口（失败自动建 issue，含证据/运行 ID/建议）；与修复任务打通。
- 验收：任意失败能一键定位到证据与修复入口。
- 当前结论（第 19 轮）：🟨 统一入口已落地、灰度接线完成——新增 `runtime/failure-diagnosis.mjs`（已知错误码目录：严重级/建议/修复页面；未知码 fail-closed 为 error）+ `POST /api/diagnostics/failure` + 前端 `reportFailure`（Runtime 不可达时退回本地结构化记录）+ 问题中心「去修复」按钮。已接线：下单前闸门失败、自动化加载/执行失败。**剩余**：其余散落 catch（EDA 页设计执行、版本/导出等）未全部替换为 reportFailure；失败自动建修复任务尚未联动（任务中心仍手工创建）。证据：`failure-diagnosis.test.mjs` 4/4、`npm test` runtime 540/540、build 0。

- 状态更新（第 23 轮，✅ 闭环）：EDA 页 15 处散落 catch 统一改为 `fail()` 助手（审计 + 提示 + `reportFailure`，带 `page/operation` 上下文），覆盖打开/新建/绑定 EDA、AI 设计、方案编译、执行前检查、执行请求、打开原理图/PCB、AI 计划、批准、PCB 读取、窗口选择、执行详情读取；问题中心新增"建修复任务"：`src/services/fixTask.ts` 把问题转成 **read_only** 任务草稿（目标含 code/摘要/详情/建议，evidence 带 `issue:<id>`，显式 unknowns/risks），一键写入 AppContext 并跳转 AI 任务页，写板仍需重新计划+人工批准。
- 测试：`src/services/__tests__/fixTask.test.ts` 3/3（目标/证据/未知与风险/无建议的安全默认）；vitest 94/94。
- 边界：不自动为每次失败创建任务（避免任务轰炸）；"自动"体现在失败必进问题中心（含运行 ID/证据），修复任务是显式一键动作。
### D5 阶段机与进度【P2】
- 现状：`ProjectStage = 概念|原理图|PCB布局|验证|归档`；只写一次原理图。
- 要做：由执行/验证/放行事件推进；允许人工回退/标脏。
- 验收：项目页阶段与真实进度一致。
- 状态（第 25 轮，✅ 闭环）：新增 `src/services/stageMachine.ts`——8 阶段 canonical 顺序（概念→需求→选型→原理图→PCB→验证→生产→归档）+ `evaluateStageAdvance` 纯函数：只允许相邻正向推进（跳级/回退/原地/未知阶段全部中文阻断），六项证据门禁（requirementsConfirmed/bomApproved/netlistApproved/schematicGenerated/pcbPlaced/drcPassed），证据 `false|undefined` 一律视为缺失（fail-closed）；`ProjectStage` 类型已扩为 8 阶段，`OverviewPage`/`ExecutionPage` 的 stageOrder 统一引用 `STAGE_ORDER`，旧记录 `'PCB布局'` 由 `stageOfProjectStage` 映射为 `'PCB'`；`ProjectsPage` hero 与详情抽屉新增"推进阶段"（抽屉展示阶段链 + 六项证据预检；缺证据只 notify+audit、不 dispatch）。测试：`stageMachine.test.ts` 16/16、vitest 118/118、build 0。**刻意的 fail-closed 边界**：`pcbPlaced`（需布局写回+回读证据）与 `drcPassed`（需 EDA 原生 official DRC）当前 AppContext 无权威字段 → 恒 false、不臆测放行；`EdaPage` 执行成功仍直接写 `stage='原理图'`（历史行为），真正权威阶段应由 Runtime 证据回写（后续接 E2/E3 时收敛）。

- 状态（第 41 轮，✅ 证据推进收敛）：`deriveStageEvidence` 抽到 `src/services/stageEvidence.ts` 成为唯一实现，并新增 `applyEvidencePatch` + `tryAdvanceProjectStage`（证据更新后**只允许相邻正向推进**，缺证据返回中文阻断项）。
  - 修复真实缺陷：`EdaPage` 执行成功后原先直接 `dispatch({stage:'原理图'})`，绕过证据门禁；现改为只写 `edaWorkspace.schematicStatus/schematicExecutedAt/schematicExecutionId` 等执行证据，再按相邻阶段门禁决定是否推进，并在审计里写"自动推进到 X"或"阶段未推进：缺 X"。
  - `PlacementPage` R4 写回成功且 A9 复核 `verified.ok` 才记录 `pcbPlacementExecutedAt/pcbPlacementApprovalId`（只记时间不算证据）；阶段推进同样走门禁。
  - 证据 fail-closed：`schematicGenerated` 必须同时有执行时间；`pcbPlaced` 必须执行时间 + 批准 id 同时存在；`drcPassed` 只认 `source=official`；非当前项目不借用当前工作集的需求/网表/DRC 证据。
  - 测试：`stageEvidence.test.ts` 5/5（空证据阻断、执行证据逐级推进 需求→选型→原理图→PCB 后因缺布局证据阻断、布局证据缺批准 id 不算、DRC 来源、跨项目隔离）；vitest 136→141；build 通过。
  - **剩余**：`ProjectStage` 类型仍是旧 5 值 + 8 阶段兼容桥（新阶段写入走 `projectStageValue`）；`pcbPlaced` 目前只由 R4 布局写回产生，R5 布线/R6 铺铜完成是否也视为"PCB 布局完成"需产品定义后再接。

### D6 信息架构与遗留页面【P2，✅ 收敛落地 / 用户走查待做】
- 现状：16 页面 + 5 组导航；`AiTasksPage` 是旧任务页（仍被路由）；`DeliverPage` 聚合验证/布局/规则。
- 要做：明确每页职责，合并/下线遗留页；导航与任务流一致。
- 验收：新手按导航能走完整链路（用户走查）。
- 状态（第 40 轮）：
  - 新增 `src/navigation.ts` 作为信息架构**单一事实源**：`NAV_ITEMS`（主导航 6 项）、`PAGE_RESPONSIBILITIES`（全部 13 个 PageId：标题/描述/回答什么问题/主操作/交接）、`LEGACY_ALIASES`（旧 hash 别名 → 规范页面）、`GUIDED_FLOW`（新手完整链路，顺序与阶段机一致）、`CANONICAL_PAGES`（规范页面 = 导航 6 + 设置 + 项目页）。
  - `Shell.tsx` 导航/页面标题、`App.tsx` 路由别名与页签解析、`AppContext.navigate(page, tab?)` 全部改为消费该模块，不再各写一份；`projects` 收为规范页面（左上角项目卡进入），`requirements/assets/proposal/ai/placement` 保留为旧 hash 别名并全部并入 `design/*`、`validation/placement` 页签（`AiTasksPage` 不再单独路由）。
  - 概览页新增「从零到交付的完整链路」面板（7 步，可点击直达对应页面/页签），与阶段机 `STAGE_ORDER` 对齐。
  - 文档：`docs/implementation/information-architecture.md`（页面职责表/旧入口归并/路由规则/链路）。
  - 测试：`navigation.test.ts` 4/4（职责全覆盖、导航唯一与规范集合一致、别名不悬空不指回自己、链路顺序与阶段机一致），vitest 132→136。
  - **剩余**：新手用户实际走查（需真实用户操作）；`AiTasksPage` 组件仍存在于 `DesignPage` 对话页签内（作为内容组件，不再是独立路由）。

### D7 状态一致性【P1，✅ 文档绑定收敛】
- 现状：同一事实多处 useState（计划候选、审批、执行结果、Demo 结果）。
- 要做：关键业务状态收敛到 AppContext/共享 store + runtime 为唯一事实源。
- 验收：跨页/刷新状态一致。

- 状态更新（第 24 轮，✅ 文档绑定状态收敛）：
  - 修复真实缺陷：EDA 页 `pcbDocumentUuid` 原来硬编码 `de4911bced17666d`（另一块板），刷新/切项目后可能指向错板去读取，属于典型"同一事实多个状态源"。
  - 新增 `src/services/edaWorkspaceStore.ts`：EDA 文档身份**按项目**持久化（`circuitpilot-eda-docs-v1`），`resolvePcbDocumentUuid` 优先级 = 项目 `edaWorkspace.pcbUuid` > 本机按项目记忆 > 空串；只接受 16–64 位 hex UUID，非法值删除旧值（fail-closed 不猜目标）。
  - EDA 页：初始值/切项目改为 `resolvePcbDocumentUuid(activeProject)`；用户输入、新建 EDA 设计、绑定当前设计都会写回按项目记忆；项目删除时清绑定（避免项目 id 复用串目标）。
  - 事实源说明：本机记忆只决定"打开哪个文档"，是否可信仍由运行时读回的 `targetFingerprint` 决定（结合 C4 漂移标废）；不把本机缓存当证据。
  - 测试：`edaWorkspaceStore.test.ts` 4/4（项目隔离/非法 UUID 清旧值/优先级/损坏存储回退）；vitest 102/102。
### D8 空态/加载/错误/超时【P2】
- 现状：多数页面有基础处理；长任务（DRC/布线/导出）缺统一进度与取消。
- 要做：统一异步任务组件（轮询/取消/超时/重试）。
- 验收：长任务可取消、可恢复、状态清楚。
- 状态（第 34 轮，🟨 统一控制器+首个真实接入完成）：新增 `src/services/longTask.ts`（框架无关的 `createLongTask` 状态机：idle→running→done/failed/timeout/cancelled；轮询/取消/超时/重试）与 `src/components/LongTaskPanel.tsx`（纯展示）。措辞纪律：取消/超时只代表"本页停止等待"，note 明确写"服务端任务可能仍在执行，以审计/报告为准"，不冒充 failed/cancelled 已完成；重试 = 重新 start。已把 `ValidationPage` 的 PCB DRC 长任务从手写 for+sleep 循环整体迁到该控制器（含服务端 `pcbDrcCancel`），面板显示状态/轮询次数/耗时/错误/说明与取消/重试按钮。测试：`longTask.test.ts` 6/6（done/failed/timeout/取消/启动失败重试/启动前取消）+ `longTaskPanel.test.tsx` 3/3（SSR 文案与按钮），vitest 总数 123→132。**剩余**：布线/导出/批处理等其它长任务尚未逐个迁移到该控制器；"可恢复"依赖任务自身（DRC 可重新运行，布线/导出需重新规划/批准），控制器不自动续跑。

- 状态（第 53 轮，✅ D8 长调用迁移收口）：`ValidationPage` 的「原理图验收」（300s）、「原理图自动修复 dry/apply」（240s）、「下单前闸门」（180s）全部迁到 `createSingleCallTask` + `LongTaskPanel`：运行中可停止等待（验收/闸门=停本页等待；修复=可能已部分写入，提示核对快照/审计）、failed/timeout/cancelled 分状态、重试重新执行（修复仍走 dry/apply 各自语义）。`schematicAcceptance/repairSchematic/releaseGate` 新增可选 `{signal}`。**D8 结论**：所有 ≥110s 的 UI 长调用（DRC 轮询、生产导出、批量落件、布线规划/写入、R2 写回、R4 还原、AI 计划、原理图验收/修复、放行门禁）均已统一走 `createLongTask`/`createSingleCallTask` + `LongTaskPanel`，不再有裸 await + busy 布尔的长任务入口。
`PlacementPage.restore`（R4 还原到原位置，写路径 110s→超时 120s）与 `AiTasksPage.generateProductionPlan`（AI 生产计划生成 180s）迁到 `createSingleCallTask` + `LongTaskPanel`：运行中可停止等待（还原=abort 本页请求，提示可能部分写入；AI 计划=停止等待本页，服务端/模型可能仍在生成），失败/超时/取消分状态、重试重新签发批准/重新生成（新计划仍会让旧批准失效）；`generateProductionPlan` 新增可选 `{signal}`。**剩余**：原理图修复（`/api/eda/schematic/repair` 240s）、原理图验收（300s）、放行门禁（180s）按钮仍 busy 布尔，未迁移。
`PlacementPage.apply`（R2 布局写回，逐器件写+回读，110s→任务超时 120s）迁到 `createSingleCallTask` + `LongTaskPanel`：确认弹窗后启动任务，运行中可「停止等待写回」（取消=abort 本页请求，明确写回可能已部分写入，以审计与回读为准）、失败/超时/取消分状态、重试=重新确认写回（每次重新签发一次性 write 批准）；`applyPlacement` 新增可选 `{signal}`；证据补丁仍使用真实消费的 approvalId（不伪造）。**剩余**：`restore`（还原到原位置，同属写路径）、AI 计划生成（180s）、原理图修复/验收（240s）仍用 busy 布尔，未迁移。
`RoutingWritePanel` 的「读取断网并规划」（只读，300s）与「签发批准并写入」（写，300s）迁到 `createSingleCallTask` + `LongTaskPanel`：运行中可停"停止等待"（取消=abort 本页请求，提示服务端可能仍在执行/已写铜，以审计与铜读回为准）、超时/失败/取消分状态、重试=重新执行；`runtimeClient.routingPlan/routingApply` 新增可选 `{signal}`。**剩余**：R2 写板执行（`/api/pcb/execute` 180s）、AI 计划生成（180s）、原理图修复/验收（240s）仍用 busy 布尔，未逐个迁移（优先级低于写板确认流程，下一轮继续）。
- 状态（第 47 轮，🟨 批量落件也接入统一控制器）：`PartProposalPage.applyBatch`（A6/R3 原理图批量落件，服务端一次长调用 + 真实写入）迁到 `createSingleCallTask` + `LongTaskPanel`：运行中可"停止等待写入"（abort 本页请求，措辞明确服务端可能仍在写/已落盘）、完成/失败/超时/取消分状态展示、重试=重新执行（同一 planHash 幂等/续跑语义由服务端保证）；`schematicComponentBatchApply` 新增可选 `{signal}`。新增 `longTaskPanel-interaction.test.tsx` 5/5（取消点击、三种终态重试、超时/取消不被说成已完成）。**剩余**：布线 dry-run/apply、其它批处理长任务仍未逐个迁移；"可恢复"仍依赖任务自身语义。
  - 状态（第 59 轮，补最后一批长调用）：`PartProposalPage` 的「生成候选提案」（`/api/library/proposals`，客户端超时 180s）此前仍是 busy 布尔、无取消/超时/重试——迁到 `createSingleCallTask` + `LongTaskPanel`（标题"候选提案长任务"，取消只停止本页等待、服务端可能仍在检索；重试=重新生成；`partProposal` 新增可选 `AbortSignal`）。测试：`pages-interaction.test.tsx` 新增第 3 例（真实点击→假 HTTP→渲染候选→断言长任务面板与措辞），vitest **156/156**。**仍剩余（下一轮）**：EDA 页 R1/R2「受控执行」（`executeDesign` 150s / `executePcb` 180s）仍用 busy 布尔，未接统一长任务。
  - 状态（第 60 轮，EDA 页执行与 AI 网络表迁移 + 棘轮测试）：EDA 页 R1「AI 生成网络表」（`pinEvidence` 120s + `generateReviewedNetlist` 150s）与 R1/R2「受控执行」（`executeDesign` 150s / `executePcb` 180s）全部迁到 `createSingleCallTask` + `LongTaskPanel`（各自标题、取消只停止本页等待、写路径提示"可能已部分生效"、失败/超时/取消分状态、重试重新执行；`pinEvidence`/`generateReviewedNetlist`/`executeDesign`/`executePcb` 均新增 `AbortSignal`）。新增 `runtime/__tests__/long-call-signal.test.mjs` **棘轮**：扫描客户端所有 ≥110s 调用，未传 `AbortSignal` 的必须登记在白名单（含原因），白名单只减不增，防止新的不可取消长调用悄悄出现。`runtime **754/754**`（棘轮 1 条）。**D8 明确剩余（白名单）**：`sendChat`（对话发送）、`routingRollback`、`archiveRelease`、`guiCapabilityProbe`、`replayAutomationRun`、`schematicComponentBatchPlan`、`ercRun`、`pcb3dExport`、`productionRelease`（UI 已走 `releaseGate`）、`generateDesignPlan`（@legacy 未接 UI）；`runAutomation` 经服务端 `POST /runs/:id/abort` 中止（页面"中止运行"），不依赖 AbortSignal——不再声称"D8 全部关闭"。
  - 状态（第 61 轮，继续缩小白名单）：`AutomationPage`「GUI 兜底能力探测」（120s×2 尺寸）与「安全重放」（600s）、`ValidationPage`「ERC 取证」（120s）、「3D 导出」（320s）、「发布归档」（120s）全部迁到 `createSingleCallTask` + `LongTaskPanel`（取消只停本页等待、超时/失败/取消分状态、能重试的提供重试）；对应五个客户端方法新增 `AbortSignal`，棘轮白名单从 11 项缩到 **6 项**（`generateDesignPlan`/`sendChat`/`routingRollback`/`productionRelease`/`runAutomation`/`schematicComponentBatchPlan`）。
  - 状态（第 62 轮，缩到 5 项）：`PartProposalPage` 批量落件 dry-run 计划（600s）迁 `createSingleCallTask` + `LongTaskPanel`，与写板执行分成两个控制器（计划/执行各自状态，取消只停本页等待、dry-run 不写板）；`schematicComponentBatchPlan` 加 `AbortSignal`；新增页面交互测试（真实点击「生成计划（dry-run，不写）」→ 假 HTTP → 断言 planHash 与逐项计划表），vitest **157/157**。棘轮白名单 6→**5**（`generateDesignPlan`/`sendChat`/`routingRollback`/`productionRelease`/`runAutomation`）。
  - 状态（第 63 轮，缩到 4 项）：`AiTasksPage` 需求对话发送（`sendChat` 150s，Codex/AI 对话）迁 `createSingleCallTask` + `LongTaskPanel`：保留原消息状态机（发送中→完成/失败），新增「停止等待」按钮与面板措辞（取消=本页停止等待，服务端可能仍在生成、回复稍后可能出现在会话；超时单独 `CHAT_TIMEOUT`），失败仍按错误码区分 Codex 未就绪并报问题；`sendChat` 加 `AbortSignal`。无新增 jsdom 用例（对话依赖 provider/会话上下文，靠 e2e-app 与 typecheck/build 覆盖，如实标注）。棘轮白名单 5→**4**（`generateDesignPlan`/`routingRollback`/`productionRelease`/`runAutomation`）。
  - 状态（第 64 轮，D8 收口）：`RoutingWritePanel`「回滚本批图元」（120s 写路径）迁 `createSingleCallTask` + `LongTaskPanel`（取消只停本页等待、可能已部分生效，以铜读回/审计为准）；`routingRollback` 加 `AbortSignal`。棘轮白名单 **4→3**，且三项均有明确理由、不再是"未完成的 UI 长调用"：`generateDesignPlan`（@legacy、无页面调用方）、`productionRelease`（@legacy、无页面调用方；UI 走 `releaseGate`/`productionExport` 且都有 signal）、`runAutomation`（UI 运行中的中止走服务端 `POST /runs/:id/abort`，在步骤边界生效并回报 `mayHaveTakenEffect`，属等价可中止通道而非缺口）。**D8 判定：收口**——所有用户可触发的 ≥110s 调用均可停止等待；剩余 3 项为无 UI 的 legacy 方法或已有更强中止语义的服务端任务。
- 状态（第 42 轮，🟨 控制器扩展 + 生产导出接入）：`longTask.ts` 新增 **`createSingleCallTask`**（单调用版：一次长 HTTP 调用、无服务端 job 可轮询）——`call(signal)` 可中断，状态机复用 idle/running/done/failed/timeout/cancelled；取消 = abort 本页请求，措辞明确"服务端任务可能仍在执行或已落盘，以审计与产物目录为准"；超时与取消分开报（不是 failed）。
  - `runtimeClient.request` 支持外部 `AbortSignal`（用户取消 → `REQUEST_ABORTED`，超时 → `RUNTIME_TIMEOUT`），`productionExport` 可被中断。
  - `ValidationPage.runExport`（生产导出，240s 长调用）从"只有 busy 文案"迁到 `createSingleCallTask` + `LongTaskPanel`：运行中可"停止等待导出"，完成/失败/超时/取消状态清楚，重试 = 重新发起导出（导出本身由 Runtime 判裁决，重复调用不会绕过门禁）。
  - 测试：`longTask.test.ts` 6→10（成功/取消 abort/超时不算失败/失败后重试成功）；vitest 141→145；build 通过。
  - **剩余**：`PartProposalPage` 批量落件是服务端一次调用（有 busy 但无超时/取消文案）；布线 dry-run/apply、批处理尚未逐个套用；"可恢复"仍依赖任务自身（导出可重试，写板需重新批准）。

### D9 可访问性/键盘【P3】
- 未系统审计；表格/抽屉/弹窗键盘可达性待查。
- 状态更新（第 47 轮，🟨 静态审计脚本落地）：新增 `scripts/a11y-audit.mjs`（`node scripts/a11y-audit.mjs`，接入 acceptance `a11y-audit` 步）：扫描 `src/**/*.tsx` 30 个文件的确定性启发式问题——图标按钮无可访问名、img 缺 alt、可点击 div 无 role/tabIndex、input 无 label/aria 关联、正数 tabIndex、无 href 的 a；报告 `artifacts/d9-a11y/a11y-audit-<ts>.{json,md}`。当前实测：**violations 0**、warnings 86（84 条 input 可能由 Field 包装 + 2 条通用 Button children prop，均需人工复核）。**边界**：静态正则启发式不是 WCAG 认证，不查运行时 DOM/颜色对比度/屏幕阅读器/动态焦点；发现违规也 exit 0（advisory），不假装挡住构建。
- 状态更新（第 46 轮，🟨 对话框焦点管理已做，全站审计仍未做完）：`src/components/overlays.tsx` 的 Modal/Drawer 新增统一焦点逻辑——打开后焦点移入对话框（首个可聚焦元素）、Tab/Shift+Tab 在框内循环、Escape 关闭、关闭后焦点归还打开者；jsdom 测试 `overlays-a11y.test.tsx` 3/3（初始焦点/Esc 归还、双向循环、重开）。**仍未做**：全站逐页审计（表格排序/抽屉深层区域/命令面板键盘导航以外的组件）、屏幕阅读器实测、颜色对比度扫描；不声称 WCAG 合规。

### D10 桌面壳/移动端【P3】
- Tauri sidecar 与打包验收（H3）；移动端不在目标内。

---

## E. 自动化 / 桌面控制

### E1 Phase 1 剩余：R2/R6 真机写入验收 ✅（第 22 轮关闭）
- 现状（原）：R2/R6 配方已登记，内核/批准/读回/兜底都在；真机写操作未执行（AI 不得自签）。
- 当前结论：用户在会话中显式授权代理按其指令代签 write 批准后，两条配方均真机 `completed`：R2（`pcb-sync-from-schematic`）→ designator diff 0（180/180）、journal 7 条哈希链完整；R6（`pcb-rebuild-pours`）→ 读回铺铜 2 个非空、PCB 180 器件/92 网络不变。失败路径同轮真机验证：无批准 `needs_approval` 0 步；复用已消费批准 409；批准绑定 PCB 文档后切到原理图页面执行 409（未写入）。证据：`artifacts/r2-r6-acceptance/`（run 日志、journal 副本、before/after `sync-verify`、指纹漂移 409 原始响应）。
- 写板批准真实性：仍由服务端在真实 EDA 会话上绑定当前窗口+工程+文档指纹签发、一次性消费、30 分钟 TTL，未伪造 EDA 状态也未放宽门禁；报告与 journal 均如实记录"由 AI 代用户签发"。

### E2 Phase 2：R3/R4/R5 接入 UI + 配方【P0】
- 现状：R3 未实现；R4 有页面无门禁联动；R5 无 UI；AI 只做配方选择/填参/诊断的设计尚未落地。
- 要做：三条配方 + 页面入口 + 真机验收；AI 仅允许选配方/填参数/诊断失败，不允许自由点击。
- 验收：三条链路各跑通一次真机闭环，失败有诊断建议。
- 状态更新（第 23 轮）：🟨 R4/R5/R6 已接 UI。`PlacementPage` 真实写回/还原会先签发一次性 write 批准并带 `approvalIds`（此前页面按钮绕过了服务端批准，属"UI 自觉"）；新增 `RoutingWritePanel`（R5）：只读规划 → 预演（dryRun）→ 签发批准并真实写入（`save:false`，不自动保存）→ 按图元 id 回滚，失败/复核/残留全部显式展示；`pcb-create-pour` 配方已出现在自动化中心（R6 新建），自动化参数输入支持 JSON 结构化参数（`outline`，非法 JSON 在发请求前报错）。测试：`automationParams.test.ts` 4/4、vitest 91/91。**第 35 轮补**：R3 已有独立 UI 入口（元件选型页 A6/R3 批量落件面板：dry-run 计划 → 签发写板批准 → 逐件写入可续跑；真机 dry-run 与无批准 409 证据见 A6）。**剩余**：三条链路尚未各跑一次真机 UI 闭环点击验收（R4/R5 的真机写入走的是运行时通道并经自动回滚/读回；整板 R3 写入需用户显式批准）。

### E3 Phase 3：R7/R8 接线 + R9/R10 人工执行器【P0，R9/R10 UI 已补】
- 状态更新（第 22 轮真机）：R7 DRC 长任务真机 `done`、归一化分类 ready=false（total 13464/unexplained 13462）并落盘证据；R8 真机导出见 A15。R9/R10 未新增。
- 现状：R7 后端全、UI 无；R8 导出 UI 不完整；R9/R10 只有文字边界。
- 要做：DRC/制造包配方接入；"人工执行器"UI（DFM 上传/回填、下单参数卡确认、支付人工），每步有证据与批准。
- 验收：整条链从 R1 到 R8 可演示；R9/R10 有引导与证据回填。
- 状态更新（第 23 轮）：R7 DRC（`ValidationPage` 长任务 + 取消 + 落盘证据）与 R8 产出裁决（`ValidationPage` 生产导出，门禁拒绝时只允许草稿）已在第 22 轮接通；R9/R10 人工执行器仍无 UI（只剩文字边界）。**剩余**：DFM 上传/回填、下单参数卡确认、支付人工留痕的界面与证据回填。

- 状态（第 23 轮，R9/R10 人工执行器已补 🟨）：
  - 新增 `runtime/order-confirmation.mjs`：下单参数卡人工确认的 fail-closed 校验（卡必须 `readyToOrder:true`、确认人必填、必须显式声明支付人工；价格已知但无来源拒绝），payload 固化 `acknowledged.{orderExecutedBySystem:false,paymentExecutedBySystem:false,humanExecutor}`。
  - 新增证据类型 `order-confirmation` + `POST /api/production/order-confirmation` / `GET .../latest`（只落证据，服务端无下单/支付能力可调用）；失败诊断补 `ORDER_CONFIRMATION_INPUT_INVALID`/`BLOCKED`。
  - UI：验证页新增「人工执行器 R9/R10」面板——R9 在线 DFM 回填状态（复用既有人工证据面板，明确本地 DRC ≠ 在线 DFM）、R10-1 下单参数卡确认（确认人/备注/人工声明 + 证据哈希）、R10-2 人工支付（无系统入口、无支付凭据）。
  - 测试：`order-confirmation.test.mjs` 4/4（ready 卡规范化、不可下单阻断、缺确认人/未声明支付 400、HTTP 落盘+latest 读回+无下单/支付字段）。
  - **剩余（边界）**：R1–R8 整条链真机演示仍受放行门禁阻断（衣橱板 DRC 未过、R8 final 导出被拒——这是真实门禁，不是 UI 缺口）；R9 在线 DFM 仍需人工到嘉立创网站执行后回填。
### E4 Phase 4：无人值守演练【P1】
- 要做：3 次只读 + 目标板实跑 + 故障注入（EDA 断连、超时、弹窗、登录过期、菜单文案变化、人工步骤超时）；产出演练报告。
- 验收：无人值守下失败能自停/自恢复/留证据，不假通过。
- 状态（第 30 轮，✅ 验收满足）：新增 `scripts/fault-drill.mjs`（`npm run drill:faults`，接入 acceptance 必需步 `fault-drill`）。Part A 真实装配运行时并注入故障：EDA 断连→run `failed`、桥接错误→`failed`、写配方无批准→`needs_approval` 且 **0 次写命令**、伪造批准→409 `AUTOMATION_APPROVAL_INVALID`、追溯存储损坏→400 `STORE_CORRUPT`（不返回假空状态）、未知配方→404；Part B 本机运行时可达时连跑 **3 次真机只读配方**（`eda-read-project`）全部 `completed` 且 journal 哈希链 `ok:true`。报告 `artifacts/e4-drill/fault-drill-2026-10-20T03-39-14-377Z.md`。**顺带修复真实 bug**：`/api/automation/run` 返回的 `runId` 与 journal 里的 runId 不一致（route 生成一个、`runRecipe` 里又随机生成一个），导致"用接口返回的 runId 查审计"404——现在把 route 的 runId 传进 `runRecipe`，并在测试里断言两者相等且能查到审计。**保留边界**：弹窗/菜单文案变化/人工步骤超时属于 GUI 长任务场景，本轮未注入（GUI 兜底与超时另有 E9/E6 证据）；"目标板实跑"写板路径仍需人工批准，不在无人值守演练内。

### E5 计划/放行批准（scope）未实现【P1】
- 现状：批准账本只有 write scope；计划批准（planHash）与放行批准（终审）没有统一实现。
- 要做：plan 批准绑定 planHash + 证据摘要；一次计划批准可继承后续写步骤；release 批准绑定终审/放行报告与指纹。
- 验收：批准对象/哈希可见；错对象/过期/复用被拒。
- 当前结论（第 17 轮）：🟨 作用域机制已统一（approval-service 支持 plan/write/release + scope 校验；错令牌/过期/复用/错绑对象全部拒绝并有测试），**未实现**“一次计划批准自动继承后续写步骤”——按三次人工批准安全策略这是有意不做（写板仍需单独签发），属策略选择而非缺口。证据：`approval-service.test.mjs` 5/5；`design.test.mjs` 计划批准绑定/TTL/重放全绿。

### E6 配方可靠性与版本化【P1】
- 现状：配方是常量定义，无版本/回归；GUI 菜单文案变化会让兜底失效。
- 要做：配方版本号 + 变更记录 + 回放回归脚本；菜单文案定位失败给明确诊断与备选动作。
- 验收：配方升级可追溯；菜单变更检测有用例。
- 状态（第 23 轮）：🟨 版本化与文案漂移诊断完成、真机复验待补——新增 `RECIPE_CHANGELOG`（每条内置配方当前版本必须有日期+说明，升级保留旧记录；R2 升 v2 记录 readback/readRetries/alternatives 改动）；GUI `clickText` 支持 `alternatives` 文案变体：逐个尝试、全部候选先过危险文案检查、全失败时错误详情带 `attemptedTexts` + 先能力探测/截图确认菜单提示；测试 4/4。**剩余**：对 EDA 3.2.186 真机复验 R2 兜底菜单（此前 `更新/转换原理图到 PCB` 未找到），把实际可用的菜单文案写回 alternatives 并用截图证据留档。

### E7 运行并发/断点续跑/重放【P1】
- 现状：journal 有哈希链；但无"同一 EDA 窗口只允许一个 run"的跨配方锁、无断点续跑、无 journal 重放。
- 要做：run 锁（窗口+项目+文档）、step 级 checkpoint、从失败 step 续跑、journal 重放验证幂等。
- 验收：并发 run 被拒；中断后续跑不重复写。
- 状态（第 23 轮）：🟨 单写锁+幂等+陈旧锁接管完成、跨进程/中止/重启恢复待补——新增 `runtime/automation/run-lock.mjs`：同一时刻只允许一个自动化 run，第二个直接 `EXECUTION_BUSY`（不排队、不盲等），锁带 TTL/心跳、可标记 stale 接管并保留"从哪个 run 接管"的记录，非持有者不能释放；`POST /api/automation/run` 支持 `runId` 幂等（同 runId 短期返回同一结果、不重复执行配方），失败/needs_params 路径都释放锁；测试 5/5（含并发 200/409、幂等重放不重复读、needs_params 后锁可再用）。- 状态更新（第 29 轮，跨进程互斥完成、🟨 仍缺中止接口）：`createRunLock({file})` 新增**文件锁**模式并接入 `/api/automation/run`（锁文件 `artifacts/state/automation-run.lock`）。语义：`open(...,'wx')` 原子创建；同机持有进程已死（`pid` 存活检查）或心跳超 TTL 判陈旧；陈旧接管用 `rename` 原子抢锁（只有一个进程能成功）并如实返回 `staleTakeover`；锁文件损坏 → **拒绝接管**（`unreadable`，fail-closed）；非持有者 release/heartbeat 拒绝。测试：`automation-run-lock.test.mjs` 9/9（含 4 条文件锁用例）+ `run-lock-cross-process.test.mjs` 1/1（两个 runtime 实例共享状态目录，并发 run → 一个 200 一个 409 `EXECUTION_BUSY`，锁释放后另一实例可执行）。**第 31 轮补：长任务中止接口已产品化**——`POST /api/automation/runs/:runId/abort` → 运行时 AbortController；runner 在**步骤边界**与"动作已发出、读回前"两处检查，返回 `state=aborted` 且 `aborted.mayHaveTakenEffect`（写动作可能已生效，绝不标记成"什么都没发生"），journal 记录 `run.abort`，锁在 finally 释放；不在执行中的 run 一律 409 `AUTOMATION_RUN_NOT_RUNNING`。UI 自动化页在运行中显示"中止运行"（前端先生成 runId 以便即时中止）。测试：`automation-abort.test.mjs` 4/4（预中止 0 步、动作中中止不读回/不续步且 mayHaveTakenEffect=false、HTTP 中止后 aborted+journal+锁释放可再跑、未执行 run 409）。真机验证：`POST .../abort` 对不存在 run 返回 409 + hint。**第 31 轮续：重启恢复已产品化（🟨→✅）**——新增 `runtime/automation/recovery.mjs` + `GET /api/automation/recovery` + `POST /api/automation/runs/:runId/replay`。语义：扫描 journal 找出无终态事件的 run；**只有全程只读**的中断 run 可显式"安全重放"（写新 runId、审计链记 `recovery.start`，成功后给原 run 追加 `run.recovered` 终态）；中断前已发出写动作的 run 一律 `needs_human` 并 409 `AUTOMATION_RECOVERY_NOT_SAFE`——不自动重放写动作，避免重复落板/重复铺铜；未知配方/坏文件/目录不存在分别给 `unknown_recipe`/`corrupt`/`available:false+reason`；`approval-*.jsonl` 批准账本不会被误报成 run。UI 自动化页新增「中断运行恢复」面板（扫描/结论/安全重放按钮）。测试：`automation-recovery.test.mjs` **3/3**（分析、边界与坏文件、HTTP 重放+409+404）。真机扫描：`available=true, scanned=200, corrupt=0, interrupted=0`（证据 `artifacts/e7-recovery/real-recovery-scan-20261020.json`）。剩余：跨主机互斥仍依赖 TTL（不做分布式锁）；恢复扫描受文件名上限 200 约束。

### E8 回滚与"半写状态"收敛【P1】
- 现状：布线/原理图执行有回滚；`importChanges` 空转、迟到落板属半写。
- 要做：每类写操作定义"写后审计 + 收敛动作"（diff/删除重复件/恢复快照）；失败必留可执行恢复方案。
- 验收：注入半写故障后能恢复到一致状态并留证据。

- 状态（第 23 轮，真机闭环 ✅）：
  - runner 支持回退动作引用本 run 动作结果（`{$result:'stepId.path'}`，仅回退可用，缺失即 fail-closed）；并行修正 `resolveParams` 递归传递。
  - `pcb-create-pour` 升 v2：新增 required 参数 `existingPourIds`（运行前快照）、`onFail.then=rollback`；新增桥命令 `pcb.pour.deleteAdded`（按快照差集删除本次新增覆铜，绝不碰既有覆铜）。
  - 真机注入（不是模拟）：`scripts/e8-halfwrite-injection.mjs` 真实创建覆铜后，用 `expectedPourCount=快照+99` 让读回断言失败 → runner 自动回滚；证据：读回看到 3 个覆铜（2 旧+1 新）→ `failed`，回滚 executed、`rollback.ok=true`，运行后覆铜 **2→2**（无残留），journal 9 条哈希链完整且含 `rollback.step`。证据 `artifacts/e8-halfwrite/e8-halfwrite-2026-10-19T12-48-50-056Z.json`。
  - 测试：`automation-halfwrite.test.mjs` 5/5（半写回滚、$result 引用、回滚失败=rollback_failed、非法 $result 配方校验、v2 配方合同）。
  - 边界：其它写操作（R2 同步、R6 重建铺铜）仍是"读回断言 + 失败停止"，没有自动反向写——因为 EDA 不提供通用撤销；对不可逆写保持 needs_human/失败即停，不允许假装"已恢复"。
### E9 GUI 兜底动作补齐【P1，目录+探测已产品化】
- 现状：15 动作白名单；已覆盖打开工程/铺铜重建/更新 PCB。
- 缺口：连线、标注、DFM 上传、下单页导航等未登记；坐标为像素，窗口缩放/布局变化敏感。
- 要做：每个兜底动作以 `clickText/waitText` 为主 + 断言 + 截图证据；动作清单与配方绑定。
- 验收：兜底动作在 2 种窗口尺寸下可复现。

- 状态（第 23 轮，目录+探测已产品化 🟨）：
  - 新增 `runtime/gui-capabilities.mjs`：8 条应用级兜底动作清单（打开工程/切 PCB/重建铺铜/更新 PCB/DRC 面板/导出生产文件/在线 DFM/下单导航），每条带 `clickText` 主文案、`waitText` 断言、绑定的配方；`online-dfm-nav`/`checkout-nav` 登记为 **blocked**（R9 人工 / G2 红线），blocked 必须有 reason。
  - 新增只读 GUI 动作 `findTexts`（`eda-gui.mjs` + 安全矩阵 read 类）：不点击/不输入；支持 `viewport` 用 CDP Emulation 覆盖布局尺寸（结束清除，不改真实窗口）。
  - 新增 `POST /api/eda/gui/capabilities/probe`：把探测结果映射为每条动作的 `available/complete/missingTexts`；可选 `captureScreenshot` 落 PNG。截图先用 CDP，失败降级为 `runtime/eda-window-capture.mjs` 的 macOS **仅 EDA 窗口**区域截图（`screencapture -R`，仍给 sha256/bytes），两条都不行才报失败，不伪造截图。
  - 自动化页新增"GUI 兜底能力探测"面板：一键在 1280×800 / 1920×1080 两种尺寸探测，展示可用动作、缺失文案、截图 hash 与路径。
  - **真机实测**（2026-10-19）：两种尺寸各探测 8 条动作 → 6 条可用（open-project/open-pcb/rebuild-pours/update-pcb/drc-panel/export-production 至少命中一个文案），blocked 2 条按预期不可用；缺失 11 条候选文案（`重建铺铜`、`铺铜管理器`、`更新/转换原理图到 PCB`、`生产文件`、`支付`…）说明菜单文案漂移真实存在，兜底动作不能只靠猜；两种尺寸下截图均成功（CDP `Page.captureScreenshot` 超时 → 降级窗口截图 1.85MB，sha256 `864271…`）。证据 `artifacts/e9-gui/real-machine-gui-capabilities-20261019T124333Z.json` + `artifacts/gui-capabilities/eda-window-*.png`。
  - 测试：`gui-capabilities.test.mjs` 5/5（目录合同/blocked 红线/映射/只读动作/HTTP 两尺寸+截图）、`eda-window-capture.test.mjs` 3/3（bounds 解析/成功 sha/失败结构化）。
  - 第 36 轮补：截图通道降级从"能力探测专用"下沉到 **gui 执行器**——任何配方里的 `screenshot` 动作（含 E11 before/after 证据截图）在 CDP 超时后自动改用 macOS 仅 EDA 窗口截图，返回 `kind=os-window-capture` + `fallbackFrom`；两条通道都失败抛 `EDA_SCREENSHOT_UNAVAILABLE`，不返回空证据。真机复测 `eda-screenshot-evidence`：before/after 均 `kind=os-window-capture`、`fallbackFrom=EDA_GUI_CDP_TIMEOUT`、`bytes=268725`、sha256 `6fafd1e9…`。测试 `automation-evidence-screenshots.test.mjs` 5/5 覆盖降级与双失败。证据 `artifacts/e11-evidence/`。
  - **剩余（边界）**：探测证明"文案可定位"，没有真正点击执行每条兜底动作（点击会改 UI 状态，需要逐个动作的专用证据与批准）；`viewport` 是 CDP 布局覆盖，不等于物理拖动窗口大小，但能在同一份 EDA 上验证两种布局尺寸。
### E10 AI 决策层（编排/参数/诊断/预算）【P2】
- 现状：Phase 0/1 只做"配方选择/填参数"；无多步编排、无预算控制、无失败诊断闭环。
- 要做：目标 → 配方序列（DAG）编排、参数推断（带证据）、失败分类 → 替代配方/人工、token/时间预算。
- 验收：给"把这块板从网表做到 DRC 通过"目标，AI 能提出配方序列并在失败时选择正确恢复路径（人审）。
- 状态（第 44 轮，🟨 确定性编排 + 失败恢复决策落地）：
  - `runtime/automation/orchestration.mjs`：目标关键词 → 4 个预定义 profile（网表→DRC/重建铺铜/新建覆铜/只读证据）→ 节点序列（配方节点 + 显式 DRC/人审 gate），每节点带 `stage/dependsOn/approvalRequired/expectedEvidence/reason`；`planId` 可复算。
  - 预算：配方数/写配方数/预计秒数（粗估并标注"非 SLA"）；**token 预算显式 `not-accounted`**（没有可信 token 计量，不假装有）。
  - fail-closed：目标无法映射 → 422 `E10_GOAL_UNSUPPORTED` + supported 列表（不返回伪计划）；预算超限/配方缺失 → `ok:false + blockers`；非法 budget → 400 `E10_BUDGET_INVALID`。
  - 失败恢复：`POST /api/automation/orchestration/failure` 按 `errorCode+stage` 分类——暂时性只读可重试、批准/指纹类需重新批准、**写阶段任何失败一律 needs_human_inspection 且禁自动重放**、gate 需人工、未知错误人工、>2 次升级人工。
  - Runtime 路由 `GET .../orchestration/goals`、`POST .../orchestration/plan|failure`；前端自动化中心新增「目标编排与失败恢复（E10）」面板（序列/依赖/批准/gate/预算阻断/决策日志/恢复建议）。
  - 真机证据 `artifacts/e10-orchestration/real-plans-20261020.json`：6 节点网表→DRC 计划、`maxWriteRecipes:0` 阻断、咖啡目标 422、写失败/只读重试/目标漂移三种恢复决策。
  - 测试：`orchestration.test.mjs` 5/5。
  - **产品边界**：编排只出计划不自动执行、不代批准；可编排目标仅 4 个 profile（未覆盖必须人工）；DRC/导出/签核是 gate 不是配方；参数推断尚未实现（计划节点 params 为空，需人工填/后续 E10.2）。
  - 状态（第 55 轮，✅ E10.2 参数推断落地）：新增 `runtime/automation/params-inference.mjs`——按配方确定性推断参数，值只来自只读证据或显式声明默认值：`pcb-create-pour` 推断 `expectedPourCount`（现有铺铜数+1）、`existingPourIds`、`outline`（板框顶点）、`net`（调用方指定 > 读回网络表里的 GND > missing，不猜）、`layer`（调用方指定 > 默认顶层 1 并注明）；`pcb-sync-from-schematic` 推断 `expectedComponentCount`（原理图读回器件数）与可选 `schematicUuid`；`pcb-rebuild-pours` 无必填参数。证据不足 → `ok:false + missing + E10_PARAMS_EVIDENCE_MISSING`，不给"大概值"。
  - 编排集成：`POST /api/automation/orchestration/plan` 接受只读 `evidence`，节点带 `params` + `paramsInference {ok,sources,missing,notes}`；**未提供证据**时显式 `status:'not-provided'`（参数为空，不假装推断过）；提供证据但推断不全 → 计划 `ok:false` 并要求先补证据。自动化中心「目标编排」表格新增「参数推断」列（已推参数数/证据不足清单/未推断三种状态）。
  - 测试：`params-inference.test.mjs` 4/4（三配方推断与缺证据边界、编排集成三态、HTTP 透传 evidence）；runtime **750/750**。


### E11 安全审计证据（截图/录像/不可代签）【P2】
- 要做：每个写步骤留 before/after 截图与读回；批准记录绑定操作人/指纹；GUI 写动作有审计时间线。
- 状态（第 36 轮，🟨 before/after 截图链路打通）：发现并修复"配方声明 `evidence.screenshot` 但规范化时被丢弃"的真实缺陷——`validateRecipe` 现在校验并保留 evidence（未知字段/非布尔直接拒绝）；runner 在动作发出**前**采集 `before`、验证通过后采集 `after`，只把 `sha256/bytes/kind/path` 写入 journal 与步骤结果（不落 base64），采集失败如实 `ok:false+原因`、未验证通过不产生 `after`。截图通道降级下沉到 gui 执行器（CDP 超时 → 仅 EDA 窗口截图；双失败 `EDA_SCREENSHOT_UNAVAILABLE`）。真机 `eda-screenshot-evidence` 运行 completed：before/after 各 `bytes=268725`、sha256 `6fafd1e9…`、`kind=os-window-capture`、journal 含两个 evidence 阶段（`artifacts/e11-evidence/`）。测试 `automation-evidence-screenshots.test.mjs` 5/5。**剩余**：写步骤的真机 before/after 截图需用户签发写板批准后执行（同一机制，未代批）；"操作人"仍以签发会话/审计链为准，无独立账号代签；GUI 写动作时间线依赖 journal（已有），录像未做。

- 状态（第 43 轮，🟨 写步骤审计包 + 批准可追溯）：新增 `runtime/automation/audit-bundle.mjs` 与 `GET /api/automation/runs/:runId/audit-bundle`：把一次运行收成审计包——journal 哈希链校验（断则 `ok:false+brokenAt`）、每步 before/after 截图摘要（sha256/bytes/kind/path/fallbackFrom/error）、读回 stateDigest、批准 `approvalIds` + 签发时目标指纹、warnings（写步骤缺 before/after、缺成功读回、base64 泄漏、截图失败）与 `evidenceComplete`；`run.start.approvals` 现在记录 approvalIds/approvalFingerprint（可以事后核对"哪个批准放行这次写"）。前端自动化中心新增「写步骤审计包（E11）」面板。真机证据 `artifacts/e11-audit-bundle/`：真实历史写 run 的 bundle 如实列出"缺 before/after/读回"warnings（不把没截图当通过）、只读 run 链完整示例、未知 run 404。测试 `audit-bundle.test.mjs` 4/4。
  - **剩余**：操作人仍无独立账号签名（显式注明"无独立第三方签名"，批准=本地会话+目标指纹绑定）；录像未做；新 run 才有 approvalIds/指纹，历史 run 显示缺失。

### E12 失败诊断库【P2】
- 现状：`stateShape`/错误码已有；缺"错误码 → 原因 → 建议"的库。
- 要做：沉淀真机错误码（BRIDGE_HTTP_ERROR、EDA_REQUEST_ABANDONED、code 20、EDA_JOB_BUSY…）与处理建议，接 UI。
- 验收：常见失败能直接给出下一步。
- 状态（第 23 轮）：✅ 已补齐——`failure-diagnosis.mjs` 诊断目录扩到 40+ 个**真机实际出现过**的错误码（BRIDGE_HTTP_ERROR/EDA_REQUEST_ABANDONED/EDA_JOB_BUSY/EDA_GUI_ELEMENT_NOT_FOUND/TARGET_DRIFT/READBACK_*/NET_CONNECT_*/PLACEMENT_WRITE_*/ROUTING_*/PRODUCTION_*/DESIGNATOR_*/SCHEMATIC_BATCH_* 等），每条给严重级/可执行建议/修复页面；测试断言“这些码不得落进未分类失败”，并校验写命令中止类建议包含“先读回确认”。证据：`runtime/__tests__/failure-diagnosis.test.mjs` 5/5。

---

## F. 测试与 CI

### F1 live e2e 用例过期【P1】
- 现状：`e2e/placement-live.spec.ts:33` 用 `nav-placement`，Shell 现在只有 `nav-<pageId>`（`Shell.tsx:92`），导航项已改为 `eda/validation`；同文件 `:66,113` 与 `sync-verify-live.spec.ts:26` 断言 h1「验证中心」，当前页面标题已不同。这些用例当前会直接失败。
- 要做：按新导航/标题重写或标记 `test.skip` 并写明原因；live 用例统一入口/环境变量。
- 验收：`npx playwright test` 非 live 全绿；live 用例有明确跳过理由与运行手册。
- 状态：🟨 2026-10-19 部分完成。已做：`e2e/placement-live.spec.ts` / `sync-verify-live.spec.ts` 适配 `nav-validation` + h1「验证与交付」+ `role=tab` 子页；`app.spec.ts` 26/26；live 两文件 4 tests 可收集、无 env 时 4 skipped；剩余：live 运行手册未写。
- 状态（第 23 轮）：✅ 已关闭——新增 `docs/implementation/live-e2e-runbook.md`（前置条件、环境变量、运行命令、失败证据位置、已知限制、CI 约定）；live 用例保持 `CP_LIVE_EDA_E2E=1` 显式开关、默认 skip 不伪装通过；4178→4179 改写与超时设置写入手册。

### F2 live 测试分层与证据归档【P1，✅ 闭环】
- 要做：`@live` 标签 + `CP_LIVE_EDA_E2E=1` 门槛；失败自动存截图/JSON/journal；报告可归档。
- 验收：CI 默认不跑 live；本机一键跑并产出证据目录。
- 当前结论（第 21 轮）：🟨 已分层、未做真机归档目录——live e2e 由 `CP_LIVE_EDA_E2E=1` 显式开启（默认 skip，不伪装通过）；Playwright 配置失败自动截图 + first-retry trace + HTML 报告；`npm run acceptance` 产出 JSON/MD 归档。**剩余**：失败时把截图/trace/journal 自动汇总到统一证据目录（当前分散在 `test-results/`、`playwright-report/`），需要真机运行时才有实际失败样本。

- 状态（第 23 轮，✅ 闭环）：新增 `runtime/evidence-archive.mjs`（复制 + 逐文件 sha256 + manifest，缺失来源/`outDir` 在来源内跳过都如实记录）+ `scripts/archive-live-evidence.mjs`（`npm run archive:live-evidence`，0 文件时退出码 2，空归档不当成功）+ `e2e/global-teardown.ts`（`CP_LIVE_EDA_E2E=1` 时整轮后自动归档 `test-results/`、`playwright-report/`、自动化 journal 到 `artifacts/live-evidence/<timestamp>/`，归档失败只 warn 不影响测试结论）。live 手册新增"证据归档"一节并修正 journal 默认路径。
- 测试：`runtime/__tests__/evidence-archive.test.mjs` 5/5（完整归档/hash、缺失来源、outDir 在来源内跳过、空来源、脚本非 0 退出）。
- 边界：自动归档只在 live 开关打开时触发；离线 e2e 不产生归档（避免噪声）。
### F3 一键验收脚本【P1】
- 现状：`scripts/e2e-live.mjs` 只覆盖部分路由。
- 要做：覆盖 R1–R8 + automation matrix + 衣橱验收；输出机器可读报告（JSON/MD）。
- 验收：一条命令产出"链路验收报告"。
- 状态（第 13 轮）：🟨 部分完成——新增 `scripts/acceptance.mjs`（`npm run acceptance`）：一条命令依次跑 typecheck/vitest/runtime/build/路由契约/e2e，产出 JSON+Markdown 验收报告到 `artifacts/acceptance/`，任一步失败即 exit 1；真机写板、live e2e、配方矩阵、衣橱验收默认标 SKIPPED 并写明原因（不伪装 PASS），`--live`/`--skip-e2e` 可显式控制。剩余：报告尚未把 R1–R8/automation matrix/衣橱项做成可执行段（真机依赖），以及报告未接入 CI 归档。证据：`npm run acceptance` 本机 PASS（vitest 80/80、runtime 519/519、build 0、e2e 29）。
- 状态（第 33 轮，🟨→✅ 可执行段落地）：新增 `scripts/live-chain-report.mjs`（`npm run report:live-chain`），把 R1–R8 变成**只读可执行矩阵**并产出 `artifacts/f3-live-chain/live-chain-<时间>.json|md`：
  - 可自动执行段：R1 目标解析（discover/windows/selectionRequired）、R4 PCB 铜几何（routing/plan 只读规划读数）、R5 DRC 最新证据（只读 latest，没有则 SKIPPED+原因）、R6 覆铜只读快照；
  - 按安全边界 SKIPPED 段（带明确原因）：R2 落板、R3 布线写铜、R6-write 铺铜重建/新建、R8 导出/放行——都需要用户显式签发写板/放行批准，只读报告不执行；
  - R7 生产签核/DFM：只读 latest 证据，没有则 SKIPPED 并写"需人工完成 DFM 上传/签核"；
  - 只读段失败 → 整体 FAIL 且 exit 1；跳过项不算失败，报告逐项列出。
  - 已接入 `npm run acceptance`：`--live` 时执行 `live-chain` 步骤，离线时 SKIPPED + 原因。
  - **真机实测**（2026-10-20）：R1 PASS（1 个 EDA 窗口，selectionRequired=false，windowId `dd8f03c1…`）、R4 PASS（铜几何 `pads 602 / lines 1339 / vias 153`）、R6 PASS（覆铜 2 个）、R5 PASS（DRC evidence digest `f0b1ddb9…`）、R7 SKIPPED（无签核/DFM 证据）；写板/导出项按人工边界 SKIPPED。证据 `artifacts/f3-live-chain/live-chain-2026-10-20T03-52-00-642Z.md`。
  - 仍余边界：automation matrix（写阶段）与衣橱板验收（依赖真机 DRC/ERC + 人工批准）仍是 SKIPPED 段；报告未接入 CI 归档。

### F4 路由/客户端契约测试【P2】
- 要做：解析 79 条路由与客户端方法，断言每条有 UI/脚本/测试消费者或显式 `internal` 标记。
- 验收：新增孤儿路由 CI 失败。
- 状态：✅ 2026-10-19。`runtime/__tests__/route-contract.test.mjs`：server 84 条路由 / client 70 条请求，允许清单 16 条（带原因），孤儿 0；3/3 通过。

### F5 前端组件/页面测试【P2】
- 现状：只少量 vitest（demoAdapter 等）。
- 要做：关键页面（AutomationPage、ValidationPage gate、PlacementPage、PartProposalPage）RTL 测试。
- 验收：关键交互有单测。
- 状态（第 54 轮，🟨 页面级真实点击单测落地）：新增 `src/pages/__tests__/pages-interaction.test.tsx` 2/2——jsdom + 假 fetch（只 mock HTTP，不 mock 页面逻辑），真实点击：① SettingsPage「读取外发清单」→ 渲染 `chat.turn` 契约/`notSent`/策略版本；② ValidationPage A4「生成两阶段计划」→ 渲染服务端 fail-closed 阻断 `PIN_FLOW_PCB_NOT_PLACED` + 4 阶段表 + "本页只生成计划"边界。**剩余**：尚未逐页写事件级单测（布局写回确认流、自动化中止/恢复等仍靠 Playwright e2e 覆盖）；不声称 RTL 全量覆盖。第 59 轮扩到 3/3（新增 PartProposalPage 候选提案长任务点击），仍非全量。
新增 `src/components/__tests__/longTaskPanel-interaction.test.tsx` 5/5（jsdom 真实点击：运行中取消、failed/timeout/cancelled 重试、超时/取消边界文案不被说成完成）与既有 `overlays-a11y.test.tsx` 3/3（对话框焦点/循环/Esc）；页面级仍以渲染冒烟 + Playwright e2e 为主，尚未给 ValidationPage gate / PlacementPage 写事件级单测。
- 当前结论（第 21 轮）：🟨→✅ 关键页面已有渲染冒烟——新增 `src/pages/__tests__/pages-smoke.test.tsx` 4 条（AutomationPage DEMO 边界、ValidationPage ERC 空态+DEMO 不能作放行证据、PlacementPage、PartProposalPage），vitest 84/84；交互链路由 e2e 30/30 覆盖。**诚实边界**：这是渲染冒烟不是完整 RTL 交互单测（未装 @testing-library/react，交互仍靠 Playwright）。

### F6 覆盖率门槛【P3】
- 现状：无强制覆盖率。
- 要做：对 runtime 新模块设阈值（如 lines 70%），逐步提高。
- 验收：CI 覆盖率不下降。
- 状态（第 45 轮，✅ runtime 覆盖率地板落地）：新增 `scripts/coverage-gate.mjs`（`npm run test:coverage:runtime`，接入 `npm run acceptance` 的 `coverage` 必需步）：跑完整 runtime 测试集 + Node 内置覆盖率，只对 5 个关键模块设地板（实测值向下取整、只许升不许降）——orchestration 95/84/100、audit-bundle 90/68/90、timeline 88/50/100、project-state 87/68/90、evidence-index 92/71/91（lines/branches/funcs）。模块缺失或低于地板 → exit 1；报告 `artifacts/f6-coverage/coverage-runtime-*.md`（含实际值/地板/结论）。实测：5 模块全部达标（lines 89–97%）。
  - 边界：只覆盖"关键新模块"，不假装全仓 70%；真机/HTTP 大量路径离线不可达，单一全局阈值会虚低或假高。前端 vitest 已有 11/8/9/8 的 ratchet（`vite.config.ts`）。

### F7 性能基线【P2】
- 要做：100–300 器件工程的读取/布局/DRC/渲染耗时基线；回归告警。
- 验收：关键路径有基线表。
- 状态（第 29 轮，🟨 只读路径基线完成、重模型工程未建基线）：新增 `scripts/perf-baseline.mjs`（`--iterations`，默认 20）：对**只读**端点采样（health / approvals / evidence-index / trace-state / diagnostics / diagnostics-bundle），计算 min/p50/p95/max，落 `artifacts/f7-perf/`，下一次运行自动对比上一份基线并告警（p95 > 2× 且 > 50ms 记 WARN，不阻断构建）。实测本机（10 次采样）：health p95 1.83ms、approvals 0.5ms、trace-state 0.52ms、diagnostics 48ms、evidence-index 120ms、diagnostics-bundle 199ms。- 状态（第 58 轮，🟨 UI 渲染基线补齐、真机 EDA 路径仍受限）：新增 `e2e/f7-ui-render.spec.ts`——自起真实 Runtime（4178、全新临时状态），经真实 API 写入 **180 器件工程**，真实浏览器测 3 个页面的渲染/导航（3 次采样取中位），切到 BOM 清单页签并断言真实渲染出 **180 行**；结果落 `artifacts/f7-perf/ui-render-<时间>.json` 并覆盖 `ui-render-baseline.json`，下次运行自动对同一页面做 2× 回归告警（不阻断）。已接入 acceptance `f7-ui-render` 必需步骤。实测（本机 headless）：assets-180 中位 ~15ms、requirements ~8ms、validation ~14ms，行数 180/180，告警 0；`perf-baseline.mjs` 的运行时只读路由基线不变。
  - **剩余边界**：真实 180 器件工程的 EDA 读取/布局/DRC 耗时仍需真机 EDA 与稳定环境，本 spec 只覆盖前端渲染/导航这一半，不冒充"EDA 性能已测"。

---

## G. 安全与边界

### G1 写板人工不可绕过（已有）需展示【P1】
- 现状：服务端一次性批准、绑定窗口+工程+文档指纹、30min TTL、复用 409（已实现并有测试）。
- 补：批准 UI 明确显示目标指纹与作用域；审计时间线；"AI 不得自签"在代码/文档/UI 三处一致。
- 验收：无批准 0 步、伪造/复用被拒；界面可见消费记录。
- 状态更新（第 23 轮）：✅ UI 已展示一次性批准的目标指纹/绑定配方/签发与到期时间，并明示"运行时按指纹校验，复用/跨文档 409"；运行后审计记"批准已消费"。服务端批准/复用拒绝已有测试（`automation.test.mjs`），"无批准 0 步"由 runner 的 needs_approval 分支保证。

### G2 下单/支付永久禁入【P1】
- 现状：`orderEnabled:false` 常量；GUI 白名单可点菜单。
- 补：GUI 配方禁止进入支付/下单确认页（动作黑名单/停止条件）+ 测试；下单参数卡只出参数。
- 验收：任何配方都无法越过参数卡完成下单。
- 状态（第 23 轮）：✅ 已加固——`DANGEROUS_TEXTS` 覆盖支付/下单/收银/提交订单/立即购买/place order 等中英变体；新增 `CHECKOUT_URL_PATTERNS` + `assertNotCheckoutTarget`（URL/标题命中支付页即停手，与 EDA 目标锁定叠加），runner 预检与 GUI 执行器都在点击前拦截；测试 4/4 证明“危险文案/支付页 → GUI 通道 0 次调用”。`orderEnabled:false` 不变，不新增任何下单能力。

### G3 无自由 computer-use【P2】
- 现状：`eval` 默认禁用；GUI 白名单 15 动作。
- 补：回归测试"未知动作/任意 JS 被拒"；网络外联/凭据最小化审查。
- 验收：攻击性用例（注入 JS、越权动作）全部被拒。
- 状态（第 26 轮，✅ 验收满足）：`/api/eda/gui/execute` 对 `action:'eval'` 默认返回 403 `GUI_EVAL_DISABLED`（仅显式 `CIRCUITPILOT_ALLOW_GUI_EVAL=1` 的本地诊断可开）；未知动作由 `assertGuiAction` 白名单拒绝并返回 `EDA_GUI_ACTION_NOT_ALLOWED`（本轮修 `EdaGuiError` 把 `detail` 同时暴露为 `details`，HTTP 信封能看到允许清单）；无会话令牌 401。测试：`g3-computer-use.test.mjs` 3/3（注入 JS 被拒/未知动作被拒/令牌要求）。**剩余**：网络外联与凭据最小化的系统性审查未做（当前凭据仅 keychain、外发仅 provider 请求，见 G4）；`eval` 本地开关本身不是产品路径。

### G4 数据外发与 provider 告知【P2】
- 要做：发送给 AI 的内容清单/脱敏；用户可见开关。
- 验收：不在未经同意时外发工程文件。
- 状态更新（第 46 轮，✅ 清单+脱敏预览落地）：新增 `runtime/provider-egress.mjs` + `GET /api/provider/egress`、`POST /api/provider/egress/preview`；SettingsPage 新增「数据外发清单与脱敏预览（G4）」面板：
  - 清单列出现有 4 个会外发/检索的调用点（`chat.turn`/`plan.ai`/`netlist.ai`/`part.proposal`）：触发条件、发送字段来源、**明确不发送**的内容（API Key/令牌、工程文件字节、本机绝对路径）；
  - 外发模式 `consentMode:'per-action'`：没有后台批量上传工程文件路径，每次都由用户显式点击触发；`orderEnabled:false` 不变；
  - 预览用与日志/诊断包同一套 `redactSecrets`：Bearer/JWT/sk-/邮箱/本机路径/敏感键名在展示中擦除，`changed` 如实标注；预览不发送任何数据；
  - 测试：`provider-egress.test.mjs` 4/4（清单契约、脱敏不改原对象、循环载荷/缺 payload fail-closed、HTTP）；真实证据 `artifacts/g4-egress/`。
  - **边界**：清单是人工维护的接口契约（新增 provider 调用点必须同步，测试断言现有 4 个 id）；脱敏按键名/模式识别，不保证语义 100% 去敏；用户主动上传的文本/图片附件按原样发送；"用户可见开关"体现为"每次外发都由用户动作触发 + 可预览"，没有静默后台开关。

### G5 EDA 版本适配【P2】
- 现状：真机 V3.2.186；命令依赖版本。
- 要做：版本检测 + 能力探测（`eda.api.describe`）+ 不支持时明确降级；版本适配表。
- 验收：换版本启动即报能力差异而不是运行中神秘失败。
- 状态更新（第 46 轮，✅ 版本适配诊断落地）：新增 `runtime/eda-adaptation.mjs` + `GET /api/eda/version/adaptation`；EdaPage 真实能力矩阵下显示适配告警：
  - 版本来源如实标注（`user` 查询参数 / `capability-matrix` 声明基线 / `unknown`）；`unknown` 禁止给出"已适配"结论并把指引写成"不要走写链路"；
  - 与真机验收基线（3.2.186）比对：exact→`tested`；同 minor 不同 patch→`patch-drift`；其它→`untested`。能力矩阵登记的 3.2.175 明确标注为"声明基线 ≠ 真机验证"（真实 runtime 默认请求会如实给出 patch-drift 警告，不冒充 tested）；
  - 桥在线时跑 `eda.api.describe` 核对关键图元 API（pcb_PrimitiveComponent/Via/Line、sch_PrimitiveComponent 的 `create`），缺项 → `degradations` 指出哪条路径不可用；探针失败也如实报告（失败≠通过）；
  - 版本适配表内置 3 个已知坑及降级路径：CDP 截图超时→窗口截图、`pcb.importChanges` 静默无效→禁用改走 component.create、EDA 文件系统不可用→运行时写盘校验；
  - 测试：`eda-adaptation.test.mjs` 4/4（tested/unknown/patch-drift/untested、缺 API/探针失败、解析边界、HTTP）；真实证据 `artifacts/g5-adaptation/`。
  - **边界**：版本号目前来自查询参数或能力矩阵声明（EDA 没有稳定的公开版本查询命令，未伪造"自动检测"）；`patch-drift`/`untested` 是告警不是自动切换；降级动作仍由各配方/执行器按既有 fallback 执行。

### G6 fail-closed 回归【P1】
- 现状：缺证据→failed/needs_approval 已有。
- 补：对每个配方加"缺证据/读回失败/批准缺失"反例测试；不允许"跳过断言当通过"。
- 验收：反例矩阵全绿。

---

## H. 文档 / 运维 / 性能
- 状态（第 16 轮）：✅ 反例矩阵已落地——新增 `runtime/__tests__/fail-closed.test.mjs` 4/4：① 5 条真实写入路由缺写板批准一律 `AUTOMATION_APPROVAL_REQUIRED` 409，且断言**没有任何写入命令被执行**（证明闸门在读/写之前）；② 伪造 approvalId → `AUTOMATION_APPROVAL_INVALID` 409，响应带当前 EDA 指纹与缺失原因；③ dry-run 不被批准闸门拦截（未写盘）；④ 无会话凭证访问批准/写入/下载/账本路由一律 401。测试隔离了 DRC 豁免/工程记忆/状态目录，不依赖本机历史。证据：`node --test runtime/__tests__/fail-closed.test.mjs` 4/4、`npm test` runtime 525/525。

### H1 文档与代码注释滞后【P2】
- 现状：`runtime/pcb.mjs:68-76` 注释仍写"公开 API 不能新增 PCB 器件"，与后续 `pcb.component.create` 真机可用矛盾；verification 文档里旧结论没有统一"已废弃"标记。
- 要做：标注生效范围（版本/轮次），把被推翻结论移到"历史误判"并链接更正。
- 验收：文档内不再有互相矛盾的"当前结论"。
- 状态（第 23 轮）：✅ 已修正——`runtime/pcb.mjs` 注释把“公开 API 不能新增 PCB 器件”更正为版本化结论（importChanges no-op、pcb.component.create 单件 Beta 受库解析限制），旧结论标【已废弃】；`wardrobe-assistant-design-verification.md` §8.4/8.6 同步加“历史误判校正”标记，避免文档互相矛盾。

### H2 文档索引【P3】
- 现状：`docs/implementation/` 20+ 文件。
- 要做：README/索引（谁先读、按链路排序）。
- 验收：新人 10 分钟能找到链路验收入口。
- 状态（第 26 轮，✅ 闭环）：新增 `docs/implementation/README.md`（先读 checklist→task-plan→automation-kernel；按角色分阅读路径：验收/全链设计/PCB 规则/生产放行/历史审计；一键验收入口；文档约定），根 README 项目结构已链接该索引。

### H3 打包/签名/sidecar【P2】
- 现状：`dev-full.mjs`、`stage-runtime-sidecar.mjs`、`check-macos-release.mjs` 存在。
- 要做：端到端打包验收（Web + sidecar + 版本号一致性）。
- 验收：打包产物可启动、health 正常。
- 状态（第 45 轮，✅ 打包冒烟链路落地）：新增 `scripts/package-smoke.mjs`（`npm run test:package`，接入 acceptance `package-smoke` 必需步）：① package.json / src-tauri/tauri.conf.json / runtime/version.mjs 三方版本一致；② `stage-runtime-sidecar.mjs` 真实暂存后执行 staged node 二进制 `--version`，确认可运行且与宿主 Node 一致；③ 用 staged sidecar 启动真实 runtime（隔离状态目录 + 随机端口），`/api/health` 返回 service/version 正确后关闭。实测 PASS：版本 0.2.0 三方一致、sidecar 可执行、health 正常；报告 `artifacts/h3-package/package-smoke-*.json`。
  - 边界：不做 codesign/notarize/完整 `.app`/`.dmg` 生成（需要证书与网络，属发布流程，`npm run desktop:release` 负责）；本机无 Rust 时脚本输出 `SKIPPED` + 原因并 exit 0，acceptance 如实标 SKIPPED，不冒充 PASS。

- 状态（第 45 轮，🟨 可复现采样脚本落地、24h 真实长跑仍未做）：新增 `scripts/long-run-memory.mjs`（`npm run drill:longrun`，`--duration-seconds` / `--hours` / `--interval-seconds`）：用隔离状态目录 + 随机端口启动 runtime，周期采样 child RSS 并持续请求 health/approvals/diagnostics/timeline，输出首/末/峰值/增长率、请求计数、错误与 warnings，报告落 `artifacts/h4-longrun/`；只有进程挂掉/health 失败才 exit 1，RSS 增长 >64MB 记 WARN（不伪造"稳定"结论）。acceptance 新增 `long-run-smoke` 短窗（15s，输出明确标注非 24h）；短窗实测 PASS（RSS 99.3→92.1MB、16 次请求、无错误）。**24h 真实长跑**：需连续 24h 环境（不休眠/不换网），`npm run drill:longrun -- --hours 24` 可复现；报告会显式显示采样断点，不把短窗冒烟当 24h 验收。
### H4 长期运行内存【P2】
- 现状：events/chat sessions/plans 无上限（`chat.mjs:275`、`production.mjs:449`）。
- 要做：上限/淘汰/落盘；长跑测试。
- 验收：连续运行 24h 内存稳定。
- 状态（第 26 轮，🟨 上限机制完成、24h 长跑未做）：`ProductionManager` 的 plans 已有 200 上限，本轮补 reviews 上限（默认 200，超限淘汰最旧；签核结论在证据文件/批准账本留痕）；`ChatManager` 线程映射按最近使用上限 50（淘汰只丢映射，transcript 仍在磁盘，下次按 transcript 重建）；transcript 单会话消息已截 200 条，会话表按 updatedAt 上限 50。测试：`memory-bounds.test.mjs` 3/3（终审上限/线程映射上限/会话表淘汰）。**边界**：24h 真实长跑未执行——需真机长跑采样 RSS，属于环境受限项，给出可复现脚本方式（后续补）而不是宣布通过。

### H5 日志与诊断包【P2】
- 要做：诊断包内容清单、脱敏、可复现（版本/指纹/最近 journal）。
- 验收：诊断包能定位一次失败。
- 状态（第 28 轮，✅ 验收满足）：新增 `runtime/diagnostic-bundle.mjs`（纯函数、可注入数据）+ `GET /api/diagnostics/bundle` + 设置页「导出诊断包」按钮（浏览器下载，不落服务端文件）。内容：运行时版本/平台、本机诊断（复用 `redactSecrets` 整体脱敏）、证据索引摘要（按 kind 采样+上限）、追溯计数（versions/changes/audit 有界）、自动化 journal 最近 run 与哈希链校验、最近错误；`bundleHash` 只随内容变化（时间戳不影响），同状态可复现。缺失段明确 `available:false + reason`，不伪造空对象。测试：`diagnostic-bundle.test.mjs` 5/5（脱敏/上限/非法输入/缺失段/hash 稳定）+ `diagnostic-bundle-http.test.mjs` 1/1（无令牌 401、敏感值不出现在响应、非敏感字段保留）。边界：不含工程文件内容；"能定位一次失败"依赖最近错误已入日志（无错误历史时该段为空并说明）。

### H6 备份/恢复【P3】
- 要做：artifacts/存储备份与恢复演练。
- 验收：从备份恢复后可继续。
- 状态（第 28 轮，✅ 验收满足）：新增 `scripts/backup-restore-drill.mjs`（`npm run drill:backup`，并接入 `npm run acceptance` 的 `backup-drill` 必需步）。真实执行：备份 `artifacts/state`（运行时状态）+ `artifacts/evidence`（证据 36 份）+ `~/.circuitpilot/automation-runs`（journal），逐文件 sha256 + manifest；恢复到临时目录后**用运行时自己的只读加载器**重开（`createTraceStateStore().load()`、`buildEvidenceIndex()`、`summarizeJournalRuns()`）并与原始计数/链校验比对，任一必需项失败 exit 1。实测：561 文件 / 81,043,197 字节，恢复后哈希 561/561 一致，证据 36 条一致且 complete=true，journal 最近 10 run 链校验 ok=true；trace 段因线上尚无 trace-state.json 明确 SKIPPED（不伪装）。报告 `artifacts/h6-backup/backup-restore-2026-10-20T03-29-50-578Z.md`。边界：恢复目标是临时副本，不覆盖线上数据；"可继续"验证到加载器层，未做跨机器迁移。

---

## 3. 最小闭环路径（建议顺序）

**Track 1（不依赖人工写板，先做，解锁可信度）**
1. A12 DRC UI + 一键取证（含移除 B5 demo 默认路径）
2. B1 放行口径统一 + B2 DFM 证据回填接口
3. C1 持久化（项目/计划/审批/终审/证据）
4. D2 四处交接死链 + D3 Demo 边界
5. D1 死路由接 UI/下线 + F1 live 用例修复

**Track 2（需一次人工写板批准）**
6. E1 R2/R6 真机验收 → 证据入 kernel 文档
7. A8 R2 验收、A11 R6 验收 → 接入 E3 的 R7/R8

**Track 3（最大工程量，主链缺口）**
8. A7 R3 原理图连线 + A13 ERC
9. A10 R5 布线 UI + A9 R4 规则门禁
10. A15 R8 导出/3D UI + B4 终审签核 → E2/E3 全链演示 → E4 演练

**依赖关系**：A7 → A13 → A10 → A12 → B1（DRC 证据进放行）；C1 先做可避免每步都重做持久化；E1 是人工闸门，越早批准越早排错。

---

## 4. 目标完成定义（DoD，逐条可验）

1. 在真实嘉立创 EDA 上，从一份结构化需求出发，AI 生成计划（含选型证据、引脚证据、布局/布线参数），经**计划批准**后执行原理图写入，回读通过；ERC 错误 0。
2. PCB 落板与原理图 designator 逐条对齐（diff 0），铺铜重建后铜皮数达标。
3. 自动布局在规则引擎下通过（板框内、无 courtyard 重叠、间距矩阵通过）；布线 dryRun 通过后写入，断网 0、新增 DRC 违规 0，失败自动回滚。
4. DRC 全量报告可一键产出、分类、豁免；unexplained=0；报告自动进入放行 gate。
5. 放行页用同一套 `ReleaseDecision`：release-gate 六子门（原理图/仿真/DRC/布局/产物/供应链）与 DFM 人工证据、终审签核结论一致；三处 UI 不打架。
6. 价格/库存/DFM/人工签核证据可回填；终审三方签核后生成不可变发布版本；final 制造包（Gerber/BOM/CPL/STEP）带 manifest 与 sha256 可复核；DRAFT 永不可下单。
7. 三次人工批准全部有形记录（计划/写板/放行），AI 无自签路径；自动下单/支付在任何配方下都不可达。
8. 上述链路有真机证据包（journal/报告/截图）与一键验收脚本；连续 3 次只读演练 + 1 次目标板全链演练无假通过。
9. 重启 Runtime 后项目、计划、批准、终审、执行记录可恢复；文档/索引/诊断包可让第三人复现。
10. 测试基线绿：`npm test` + `npm run build` + 非 live e2e；live 用例有明确门槛与跳过理由。

---

## 5. 明确不做 / 边界

- 不自动下单、不自动支付、不代签人工批准（业务红线）。
- 不做任意 computer-use / 自由点击：GUI 只在白名单动作与配方步骤内。
- 不在缺证据时给"通过"：所有缺口只能是 failed / needs_approval / unknown。
- 在线 DFM 必须人工上传与确认；本地检查不冒充在线结果。
- 不承诺"一次点击全自动完成 180 器件整板"：慢件、EDA 侧缺陷、人工决策点仍需要人。

---

## 收官核对（第 64 轮）

**完成判据（离线可验证部分）**：`npm test`（typecheck + vitest + runtime + coverage）与 `npm run acceptance` 全绿（最终报告 `artifacts/acceptance/acceptance-2026-10-20T06-44-54-645Z.md`：vitest 157/157、runtime 759/759、e2e 32、coverage 5 模块达标、其余必需步骤 PASS）；checklist 各条状态已回填；`task-plan` 记录 T1–T146 / V1–V119；`automation-kernel` 按轮次追加记录（截至 §51）。最终报告见文末基线。

**已真实落地并验证的链路**：需求→选型→网络表/引脚证据→受控写入原理图→PCB 读取/布局写回→DRC/DFM→布线规划/预演/写入/回滚→铺铜新建/重建→统一放行裁决→不可变发布归档；每一步都有 fail-closed 门禁、读回/复核、一次性人工批准与审计链，不伪造 PASS。

**真机/环境受限项（边界 + 恢复方案，均不标假 PASS）**：
1. **E6 真机菜单文案复验（EDA 3.2.186）**：边界=需真机 EDA 窗口；恢复=`POST /api/eda/gui/capabilities/probe` 看 `missingTexts` → 按 `RECIPE_CHANGELOG`/`clickText.alternatives` 补文案 → 重跑 `pcb-sync-from-schematic` 并截图留证。
2. **E9 GUI 兜底动作逐个真机点击**：边界=需真机 EDA，当前只探测 2 种窗口尺寸、未逐个点击；恢复=在自动化中心用 `guiCapabilityProbe` 列出 available 动作后逐个以人工批准执行并截图；找不到文案即视为不可用（不降级为"成功"）。
3. **E11 写步骤真机 before/after 截图 + 独立操作人签名**：边界=写步骤需用户签发写板批准；恢复=用户批准后跑写配方 → `GET /api/automation/runs/:runId/audit-bundle` 核对 before/after/读回/批准 id；**独立账号签名未实现**（无账号体系），以签发会话/审计链追溯，文档如实标注。
4. **F7 真机 EDA 读取/布局/DRC 耗时基线**：边界=需真机 EDA；恢复=`npx playwright test e2e/f7-ui-render.spec.ts`（UI 基线已 PASS）+ 真机 live 运行采样。
5. **H4 24h 长跑**：边界=需连续 24h 不休眠环境；恢复=`npm run drill:longrun -- --hours 24`，报告会显示采样断点与 RSS 增长率；短窗冒烟（acceptance `long-run-smoke`）≠ 24h。
6. **live-chain / real-write / automation-matrix / wardrobe 验收**：边界=需真机 EDA + 用户逐次签发写板批准；恢复=先 `npm run report:live-chain` 出只读矩阵，再 `npm run acceptance -- --live`；`--live` 前必须确认窗口/工程/文档指纹。
7. **D6 真实用户 13 个 PageId 走查**：边界=需真实用户操作；恢复=按 checklist D6 的 13 项清单逐页人工走查并记录，现有 F5 3/3 交互测试与 e2e 30/30 不替代真实用户走查。

**诚实残余（非阻塞、产品决策类，不冒充已完成）**：
- **C1 子项**：`versions`/`changes`/`audit` 的权威副本仍在 `localStorage`，Runtime 只权威持有 projects/requirements/components/assets/chat-transcript/执行历史/证据；需要产品决策是否迁移（当前不阻塞主链路）。
- **B7/P2**：订单卡未显示总价/缺货汇总，`orderEnabled:false`（下单红线仍默认关闭）。
- **D8 剩余 3 项**：均为 @legacy 无 UI 方法或服务端 abort 等价通道（见 D8 第 64 轮状态），不是未迁移的 UI 长调用。

**第 65 轮复查（用户要求"全面检查"）**：
- 实际执行：`npm test`（typecheck 0、vitest 157/157、runtime 759/759）+ `npm run acceptance` 全量通过（报告 `artifacts/acceptance/acceptance-2026-10-20T06-44-54-645Z.md`）；无冲突标记、无 FIXME/XXX 遗留；最终 5 项真机/环境受限步骤仍 SKIPPED 且写明原因。
- **发现并修复一个真实测试 flake**：第 65 轮首次全量验收 runtime 758/759 失败（`POST /api/eda/library/devices/search` 返回 401 `RUNTIME_TOKEN_INVALID`）；用 6 次循环复现 1 次（同一条），根因是该用例依赖 `/api/health` 发放的 `sessionProof`，在并发/端口复用等场景下偶发拿到非本实例令牌（日志 `hadAuthHeader:true, issuanceEnabled:true`）。修复：`startServer` 支持注入 `runtimeToken` 并返回，该用例改用**本实例注入令牌**、health 仅断言可用；证据：单文件 10/10、全量 runtime 连续 3×759/759、随后 acceptance PASS。**残余风险如实说明**：其余 HTTP 用例仍多数使用 `sessionProof` 模式，本次只加固了已复现的这一条，未做全量改造。
- 另确认：4179 上真实 Runtime 健康（`/api/health` ok），新路由 `GET /api/eda/pcb/layers` 正常返回（此前 06:21 的 `ROUTE_NOT_FOUND` 是"进程启动早于路由新增"的过期进程，非代码缺陷）。
