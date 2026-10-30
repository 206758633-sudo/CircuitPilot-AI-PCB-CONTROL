# 02 · PCB 布局/布线/铺铜/DRC/多层链路

> 审计基线：2026-10-26 工作树（HEAD `14317cd`，2026-10-20；大量文件 mtime 10-23～10-25），以磁盘现状为准，旧文档只当假设。
> 审计方式：只读核对 代码 / 路由 / 测试 / 历史证据；**本轮未启动 Runtime、Bridge 与嘉立创EDA**，所有"真机"条目均为历史证据，不代表本轮复验。
> 判定口径：✅已打通＝UI→API→runtime 三段齐且有测试或真机证据；🟨半打通＝能跑但缺入口/缺校验/缺闭环；🟥断点或假成功；⬜纸面（只有函数/测试）；🚫产品边界。

## 0. 结论（按严重度）

1. **P0** 主工作台「3. 同步原理图到PCB」把 `pcb.importChanges`（桥注释明确记录真机"返回 success 却一个器件都不落"）当作写板动作；执行器只校验保存/源码回读/DRC，**从不比对器件数**，因此可以在板子没变的情况下报"写入、保存、回读和官方 PCB DRC 均已完成"（`src/pages/EdaPage.tsx:242,259-266`；`runtime/bridge.mjs:473-475`；`runtime/pcb.mjs:388-438`）。
2. **P0** 布线收尾时，若读不到覆铜填充数据（`pcb.poured.read` 失败），`finishRouting` 仍保持 `ok:true` 并继续保存；UI 又只显示"重建覆铜 N 块/已保存"，不读 `result.ok` 与 `unfilledPours` ⇒ 可能把"看似重建、实际没填充"的板保存下来（`runtime/engineering/pcb-routing.mjs:930-932,941,955-960`；`src/components/RoutingWritePanel.tsx:161-169`）。
3. **P0** 布局/制造两份放行证据没有产品生产者：六道门 G5 要求 `placement`、G6 要求 `fabrication-release`（`runtime/gate-engine.mjs:9-16`），但全仓 grep 无 `kind:'placement'` / `kind:'fabrication-release'` 的生产调用，`artifacts/evidence/` 下也没有这两个目录；布局写回只写 localStorage 阶段字段（`src/pages/PlacementPage.tsx:127-135`）。结果 G5/G6 恒 `unknown`，`signoff` 永远被拒（`runtime/gates-service.mjs:23-39,52-58`；`src/pages/VerificationCenterPage.tsx:161`）。
4. **P1** 128 条布局规则审计既不落证据、也不进任何放行决策：规则只在写回前拦一次（`runtime/server.mjs:2280-2283`），下单闸门客户端 body 里根本没有 `layoutAudit` 字段（`src/services/runtimeClient.ts:653`），而 `gateEngineering` 对 `layoutAudit` 的处理代码是存在但永远收不到（`runtime/release-gate.mjs:569-584`）。
5. **P1** DRC 条目只在 PCB DRC 面板表格里显示，不进问题中心/验证矩阵；且面板上"已豁免/未解释"用的豁免文件与编辑器/闸门用的不是同一份（`runtime/server.mjs:2653-2656` vs `:676-680,1311`）。
6. 已真正打通且值得保留的：自动布局（真机 180 器件、板框读回、硬门禁拒写）、布线"规划→独立复核→拒写"、布局写回"快照→写→逐项回读→独立复核→定点回滚"、DRC 后台任务取证落盘并自动填闸门、叠层 2→4 写后读回+保存+证据。

## 1. 链路现状表

| 环节 | 用户动作 | UI/代码位置 | 后端路由/模块 | 判定 | 证据 |
|---|---|---|---|---|---|
| 原理图↔PCB 差异判定 | 验证与交付→回读验收 | `src/pages/ValidationPage.tsx:1756-1790`；`src/services/runtimeClient.ts:442-446` | `GET /api/pcb/sync/verify`（`runtime/server.mjs:3221-3232`）；`diffPcbAgainstNetlist`（`runtime/pcb.mjs:79-104`） | ✅ | 单测 `runtime/__tests__/pcb.test.mjs`；真机 e2e 默认跳过（`e2e/sync-verify-live.spec.ts:14`） |
| 实际落板（写 PCB） | 主工作台「3. 同步原理图到PCB」 | `src/pages/EdaPage.tsx:231-249,251-268,555` | `POST /api/pcb/approve|execute`（`runtime/pcb.mjs:333-458`）；`pcb.importChanges`（`runtime/bridge.mjs:422,473-475`） | 🟥 P0-1 | 无器件数断言（`runtime/pcb.mjs:388-438`） |
| 按板框自动布局 | 布局微调→读取板框并自动布局 | `src/pages/PlacementPage.tsx:77-90` | `POST /api/eda/pcb/placement/plan`（`runtime/server.mjs:2200-2260`）；`planOutlinePlacement`（`runtime/placement.mjs:268-353`） | ✅ | 单测 `runtime/__tests__/placement.test.mjs`；真机 `artifacts/a9-placement/README.md:5-13` |
| 布局规则审计（128+SUP） | 自动带出，面板显示 | `src/pages/PlacementPage.tsx:282-322` | `auditPlacementPlan`（`runtime/placement-rules.mjs:312+`；`runtime/engineering/layout-rules.mjs`、`layout-supplements.mjs`） | 🟨 P1-1 | 真机 107 REVIEW / releaseReady=false（`artifacts/a9-placement/README.md:9-11`） |
| 人工微调 | 表格改 X/Y/旋转 | `src/pages/PlacementPage.tsx:230-243` | 无独立接口（改 plan 后重算） | 🟨 P2-1 | 只能改数值，不能改面（见 P2-1） |
| 布局写回 | 预演写回 / 执行写回 / 还原 | `src/pages/PlacementPage.tsx:91-135,138+` | `POST /api/eda/pcb/placement/apply`（`runtime/server.mjs:2262-2286`）；`runtime/placement-write.mjs:74-206` | ✅ | 单测 `placement-write.test.mjs`；真机出框计划 409 拒写（`artifacts/a9-placement/README.md:15-24`） |
| 布线规划 | 布线面板→读取断网并规划 | `src/components/RoutingWritePanel.tsx:50-53,184` | `POST /api/eda/pcb/routing/plan`（`runtime/server.mjs:2321-2360`）；`runtime/engineering/pcb-routing.mjs` | ✅ | 单测 `pcb-routing.test.mjs`；真机 2 网络规划+复核拒写（`artifacts/a10-routing/README-20261020.md:9-22`） |
| 布线受控写入 | 预演→签发批准并写入→回滚 | `src/components/RoutingWritePanel.tsx:77-128,185-188` | `routing/apply|rollback`（`runtime/server.mjs:2361-2391`；`routing-drc.mjs:51+`） | ✅ | 单测 `routing-drc.test.mjs`；单网络写+回读+回滚真机记录（`a10-routing/README:27`） |
| 布线收尾（重建铺铜+保存） | 收尾按钮 | `src/components/RoutingWritePanel.tsx:146-175,187` | `routing/finish`（`runtime/server.mjs:2392-2402`）；`finishRouting`（`pcb-routing.mjs:915-961`） | 🟥 P0-2 | `pcb-routing.mjs:930-932,941,955-960` |
| 差分对/等长/长度匹配 | 无入口 | 无 | 仅库函数（`pcb-routing.mjs:1087,1201,1510,1694,1774`） | ⬜ P1-3 | 仅 `runtime/__tests__/pcb-routing.test.mjs` 引用 |
| 铺铜新建 | 自动化→配方 `pcb-create-pour` | `src/pages/AutomationPage.tsx:201-227`；`src/services/automationParams.ts:3-5` | `POST /api/eda/pcb/pour/create`（`runtime/server.mjs:2403-2499`）；配方（`runtime/automation/recipes.mjs:468-499`） | 🟨 P1-4 | 单测 `pour-create.test.mjs`；真机 `artifacts/a11-pour/real-machine-pour-create-20261019T120346Z.json` |
| DRC 取证 | 运行 PCB DRC→轮询→落盘→填闸门 | `src/pages/ValidationPage.tsx:357-400,1171-1187` | `drc/start|report|cancel`（`runtime/server.mjs:2619-2671`）；`runtime/drc.mjs` | ✅ | 证据 47 份 `artifacts/evidence/drc-report/`；单测 `drc.test.mjs, drc-evidence.test.mjs` |
| DRC 豁免 | 管理豁免→保存 | `src/pages/ValidationPage.tsx:444-490` | `GET|PUT /api/eda/pcb/drc/exemptions`（`runtime/server.mjs:2673-2679`） | 🟨 P1-5 | 文件范围错位，见 P1-5 |
| DRC→问题中心/矩阵 | 无 | — | — | 🟥 P1-6 | `ValidationPage.tsx:305,321,948,1032,1072,1121` 只报"运行失败" |
| 多层/叠层 2..32 | EDA 页→叠层面板读/写 | `src/components/LayerStackPanel.tsx:10,56,71-104,120-133` | `GET|POST /api/eda/pcb/layers`（`runtime/server.mjs:2506-2601`） | ✅ | 真机 4 层读回+saved：`artifacts/evidence/pcb-layer-stack/pcb-layer-stack-2026-10-20T06-23-06-789Z-5569b13faaef.json`；`pcb-layers-http.test.mjs` |
| 内层布线/内层平面 | 仅 AI 计划编译执行 | `src/pages/EdaPage.tsx:215-229,470-502` | `POST /api/production/plans/compile`（`runtime/server.mjs:3601`）→ `production.mjs:297-314` | 🟨 P1-7 | `multilayer-http.test.mjs`（12 层 HTTP 全流程） |
| 盲埋孔 | 无入口 | 无 | 桥参数存在（`runtime/bridge.mjs:574-582,868-876`），无规则项创建 | 🚫/⬜ P2-2 | `docs/implementation/multilayer-pcb-execution.md:99-130,261-262` |
| 阻抗控制 | 无入口；下单卡勾选 | `src/pages/ValidationPage.tsx:1013-1027` | 求解器无产品调用（`runtime/engineering/impedance.mjs`）；下单校验（`runtime/fabrication-order.mjs:143-146`） | ⬜ P1-8 | 全仓仅测试引用 solver |
| 规则中心 128 审计 | 规则中心→审计现状板 | `src/pages/RuleCenterPage.tsx:44-61,104-108` | `POST /api/engineering/layout-rules/audit`（`runtime/server.mjs:3693-3708`） | 🟥 P1-2 | 审计对象是 fixture `ESP32-TEST-BOARD`，不是当前板 |
| 下单前闸门（布局/DRC） | 验证与交付→运行闸门 | `src/pages/ValidationPage.tsx:1095-1112,1520` | `POST /api/eda/release/gate`；`runtime/release-gate.mjs:259-318,625+` | 🟨 P1-1 | 实时读板算几何，DRC 按 pcbUuid 绑定，但 128 审计缺席 |
| 六道门交接签核 | 验证中心→G1~G6→签字 | `src/pages/VerificationCenterPage.tsx:56,121,157-161` | `GET/POST /api/eda/gates/*`（`runtime/server.mjs:1541-1555`）；`gates-service.mjs` | 🟥 P0-3 | 证据生产者缺失（见 P0-3） |

## 2. 断点/半打通明细

### P0-1 落板按钮把"空转的变更导入"当写板，成功后不核对器件数
- 用户视角：原理图已生成，点「3. 同步原理图到PCB」→ 弹窗确认 → 提示"写入、保存、回读和官方 PCB DRC 均已完成"。
- 位置：计划只有 `pcb.importChanges`+`pcb.save`+`pcb.drc`（`src/pages/EdaPage.tsx:242`）；成功后按 `value.state==='completed'` 判定完成（`:263-266`）；桥侧明确注释该命令真机四组对照全部 8→8 空转（`runtime/bridge.mjs:473-475`），且 `pcb.component.create` 才是可写通道（`:470-479`）。
- 影响：整条 PCB 链的起点可以"假成功"；后续自动布局只在旧器件上做，用户却以为落板完成。执行记录里其实有 `componentCount`（`runtime/pcb.mjs:415`），但从未断言期望值。
- 建议：`pcb.importChanges` 后强制对比 `before/after.componentCount` 与 `readback` 位号集合；不达标立即失败并回滚（或改用 `pcb.component.create` 逐器件落板+读回）。UI 不得只凭 `state==='completed'` 显示"已完成"。
- 验收：真机原理图 12 个要上板器件、PCB 8 个时点击，必须明确失败并列出缺件；任何路径都不允许显示完成。

### P0-2 布线收尾读不到覆铜填充仍判成功并保存
- 用户视角：写完铜点「收尾：重建铺铜并保存」→ 提示"已重建覆铜 N 块，并已保存"。
- 位置：`readFills` 读不到返回 `null`（`pcb-routing.mjs:925-932`），循环 `if (!fills) break` 后 `result.ok` 仍为 true（`:941`），`save && result.ok` 直接保存（`:957-960`）。UI 只取 `pours.rebuilt` 与 `saved`，不读 `ok/error/poursFilled/unfilledPours`（`RoutingWritePanel.tsx:161-169`）。
- 影响：可能保存一块覆铜没真正填充的板；后续 DRC/交付读到的是"已重建"的假象，且服务端返回 HTTP 200，调用方无法分辨。
- 建议：`fills === null` 视为 `PCB_POUR_FILL_UNKNOWN` → `ok:false` 且不保存；UI 必须显示 `poursFilled/unfilledPours` 与错误码。
- 验收：mock `pcb.poured.read` 抛错时，`routing/finish` 返回失败、`saved:false`，UI 显示失败原因；单测覆盖。

### P0-3 布局/制造放行证据无生产者，六道门签字永久不可用
- 用户视角：验证中心点"评估/签字放行"→ G1~G6 大面积 `unknown`，签字按钮永远禁用。
- 位置：G5/G6 要求 `placement`、`fabrication-release`（`runtime/gate-engine.mjs:14-15`），证据白名单有这两类（`runtime/evidence-store.mjs:21-27`）；但产品路径只写 localStorage：`pcbPlacementExecutedAt`（`src/pages/PlacementPage.tsx:127-135`）。全仓 grep 无 `kind:'placement'`／`kind:'fabrication-release'` 的 `evidenceStore.save` 调用，`artifacts/evidence/` 无对应目录。`design-spec/lib-evidence/rules/netlist-diff` 的生产者也仅 `runtime/agents/*` 与 `scripts/verify-*.mjs`（`runtime/agents/librarian.mjs:62`、`rule-runner.mjs:106`、`netlist-auditor.mjs:273`、`scripts/blind-test-2026-10-21.mjs:73`）。
- 影响：交接签核这条产品链在产品操作下不可能通过；G5/G6 恒 unknown → `verdict!=='pass'` → `signoff` 必然 409（`gates-service.mjs:52-58`；`VerificationCenterPage.tsx:161`）。
- 建议：布局写回成功后由 runtime 落 `placement` 证据（带 pcbUuid+planHash+auditHash+verified）；生产放行时落 `fabrication-release`（与 release-gate 的 fabrication-release-gate 名称对齐，见 `runtime/release-gate.mjs:648`）；G1/G2/G3 至少给出"由哪个 UI 动作产生"的闭环或明确标"脚本证据，非产品路径"。
- 验收：真机完成一次布局写回后 `GET /api/eda/gates/status?pcbUuid=...` 的 G5 不再是 `missing:['placement']`；六道门可被正常评估。

### P1-1 128 条布局规则审计不落证据、不进下单闸门
- 用户视角：布局页看到"128 条审计、有证据缺口"，下单闸门却只按板框几何判布局，用户以为规则已参与放行。
- 位置：审计在写回前拦一次（`runtime/server.mjs:2280-2283`），响应即丢；`releaseGate` 客户端 body 无 `layoutAudit`（`src/services/runtimeClient.ts:653`），`ValidationPage` 也不传（`:1095-1112`）；服务端与 `gateEngineering` 支持该字段（`runtime/server.mjs:1734`；`runtime/release-gate.mjs:569-584`）但永远收不到。规则中心"现状板"审计的是 fixture（`runtime/server.mjs:3693-3708`；`src/pages/RuleCenterPage.tsx:104-108`），真正读当前板的 `/api/engineering/constraint-rules/bridge-audit`（`runtime/server.mjs:3737-3760`）没有 client 方法、也没有 UI。
- 影响：128 条规则（MECH/SPACE/热/PDN/爬电/EMC…）与"可下单"脱钩；用户看到的"审计哈希"无法在放行记录里回溯。
- 建议：布局写回成功后保存审计证据（或至少把 audit 传给 releaseGate）；把 `bridge-audit` 接到规则中心并改名"审计当前板"，fixture 审计标"样板"。
- 验收：release gate 报告含 `layoutAuditHash/layoutReleaseReady`；规则中心有"当前板"审计按钮并在断言里点名当前 pcbUuid。

### P1-2 规则中心"审计现状板"名不副实
- 用户视角：点"审计现状板"，以为在审自己的板。
- 位置：按钮按 fixture 名渲染（`src/pages/RuleCenterPage.tsx:104-108`），实际调用 `auditLayoutRules({fixtureId})`（`:56-61`），服务端只认 fixture 或手输 JSON（`runtime/server.mjs:3691-3708`）。
- 影响：真实板只跑 MECH-05/SPACE 几何（在布局页），其余 100+ 条规则从未对当前板执行；"现状板"结论误导评审。
- 建议：按钮改名"审计样板（ESP32）"，另建"审计当前板"走 `bridge-audit`。
- 验收：e2e 断言当前板审计结果中含当前 pcbUuid，且样板入口文案不再写"现状板"。

### P1-3 差分对/等长/线宽/间距参数零入口
- 用户视角：布线面板只有"按网络过滤"和"最多 24 条"，无差分对、目标阻抗、线宽、等长设置。
- 位置：面板只发 `nets/maxConnections`（`RoutingWritePanel.tsx:53`），全部几何参数取 `ROUTING_DEFAULTS`（`pcb-routing.mjs:13-31`：clearance 6mil/width 8mil/24-12 过孔）；差分识别、长度测量、偏斜补偿、配对复核、配对写回只在库里（`:1087,1201,1510,1694,1774`），全仓仅测试引用。
- 影响：USB/SPI 等高速链路只能靠固定 8mil 通孔走线；"等长/差分"能力是纸面能力。
- 建议：布线面板加"差分对/目标阻抗/线宽/最大偏斜"输入，接 `detectDifferentialPairs→planPairSkewCompensation→applyPairMatchingPlan`（默认 dryRun），成功后写证据。
- 验收：e2e 展示识别到的差分对数量与等长前后偏斜；写回后回读复核同 `verifyPairMatching`。

### P1-4 铺铜只有通用自动化配方入口
- 用户视角：无"铺铜"面板，只能在自动化页选配方、手填 mil 顶点、现有覆铜 id、期望数量。
- 位置：`AutomationPage.tsx:201-227` 通用配方运行；配方要求 `outline/expectedPourCount/existingPourIds`（`recipes.mjs:468-499`）；专用路由读回+失败回收很完整（`runtime/server.mjs:2403-2499`）。
- 影响：铺铜能力可用但对普通用户不可发现、易填错；"按板框自动铺铜"没有产品入口。
- 建议：在布局/布线页加"覆铜"面板（板框内缩自动生成 outline，从 `pcb.pours.detail` 自动带 existingPourIds/expectedPourCount）。
- 验收：面板点一次即可完成"读现有→生成 GND 覆铜→读回断言→保存"，并显示 created/verification。

### P1-5 DRC 报告分类用的豁免文件与编辑器/闸门不是同一份
- 用户视角：在面板保存了豁免，重新跑 DRC 仍显示"未解释 N 条"；闸门却可能已按工程豁免放行。
- 位置：DRC report 路由用 `defaultExemptionPath()`（无 projectUuid→`global.json`）做分类（`runtime/server.mjs:2653-2656`；`runtime/drc.mjs:59-66`）；编辑器 GET/PUT 用当前工程文件（`runtime/server.mjs:676-680,2673-2679`；`drc.mjs:71-80`）；放行闸门也用工程文件（`runtime/server.mjs:1311`）。
- 影响：UI 的逐条"已豁免/未解释"（`ValidationPage.tsx:1138-1152`）与真实放行结论互相矛盾，用户无法自证豁免生效。
- 建议：report 路由改用 `loadDrcExemptionFileForCurrentProject()`，并在响应中回显所用文件路径与 scope。
- 验收：保存豁免后重跑 DRC，分类 summary 中 `exempted` 增加；另起工程验证不会串用。

### P1-6 DRC 条目不进问题中心/验证矩阵
- 用户视角：DRC 出 63 条必须修，但"未收口发现"总览不增加，也无法逐条指派/关闭。
- 位置：`reportIssue` 仅用于 DRC/导出/闸门**运行失败**（`ValidationPage.tsx:305,321,948,1032,1072,1121`）；验证矩阵 `val-drc` 是种子数据 `pass`（`src/data/seed.ts:116`），DEMO 横幅另在 `ValidationPage.tsx:1159-1164`。
- 影响：修 DRC 没有待办闭环；总览指标失真。
- 建议：DRC report 落盘后按 `disposition` 生成 issue（Connection Error=must-fix），关闭动作回写 evidence/状态；矩阵项改为读取同一次取证。
- 验收：真机 DRC 完成后问题中心出现对应条目，数量与 classification.unexplained 一致。

### P1-7 内层布线/内层平面只走 AI 编译计划，无手动入口
- 用户视角：叠层面板只能改层数；内层走线/平面/缝合孔要靠 AI 方案或手改 JSON。
- 位置：`production.mjs:297-314` 生成平面/顶层铺铜/缝合孔，经 `/api/production/plans/compile`→`/api/pcb/approve|execute` 执行（`runtime/server.mjs:3601`；`EdaPage.tsx:470-502`）；叠层面板只写层数（`LayerStackPanel.tsx:90`）。
- 影响：多层板"能做"但不可视化编辑；层数变更后没有"层角色/平面网络"配置入口。
- 建议：叠层/平面面板展示 `planCopperRoles` 结果并允许声明各层 role 与平面网络，生成受控计划。
- 验收：4 层板在 UI 内声明 L2=GND 平面、L3=信号，计划中出现对应 `pcb.pour.create` 且读回层号正确。

### P1-8 阻抗控制链路纸面，下单卡永远拿不到阻抗网络
- 用户视角：下单卡勾"阻抗控制"必被阻断，且没有地方填阻抗网络/叠层。
- 位置：求解器只有测试引用（`runtime/engineering/impedance.mjs`，全仓无产品 import）；下单卡 UI 只发 `impedanceControl`（`ValidationPage.tsx:1013-1027`），服务端 `impedanceNets` 默认 `[]`（`runtime/server.mjs:2184`）；校验据此阻断（`runtime/fabrication-order.mjs:143-146`）。
- 影响：勾选即死路；阻抗控制无法作为可交付能力。
- 建议：布局/叠层页加"目标阻抗→线宽反解"面板，把结果写入 `constraints.impedance` 与下单 `impedanceNets`；无叠层证据时明确 unknown，不回退默认。
- 验收：4 层板输入 90Ω 差分后，计划线宽=反解值、下单卡显示阻抗网络与叠层来源。

### P2-1 布局几何对"旋转/翻面"只做半套
- 位置：自动布局保留原旋转、原面，不搜索旋转（`runtime/placement.mjs:326-327,300-340`）；占位矩形忽略旋转（`:504-515`），而 UI 允许直接改旋转（`PlacementPage.tsx:243`）；写回 API 只有 x/y/rotation，含 layer/side 字段也不接受（`runtime/bridge.mjs:445-469`）。
- 影响：无法把器件从顶层移到底层（半打通）；用户把旋转改成 90° 后，写前审计用旧宽高可能漏判，靠写后独立复核+自动回滚兜底（`placement-write.mjs:112-160`）。
- 建议：写入 payload 支持 layer（top/bottom）并在 UI 提供"翻面"；旋转改变时按新姿态重算包围盒再审计。
- 验收：真机把一颗器件顶→底写入并读回 `layerSide=bottom`；旋转 90° 的器件预演审计即报出正确占位。

### P2-2 盲埋孔：桥有参数、产品无调用
- 位置：`pcb.via.create` 支持 `viaType/designRuleBlindViaName`（`runtime/bridge.mjs:574-582,868-876`），但没有"创建/读取盲埋孔规则项"的命令；分析引擎会生成带 `viaType` 的 `pcb.via.create` 操作（`runtime/engineering/engine.mjs:28`），但报告明确"尚未执行，需独立审批"（`src/pages/ValidationPage.tsx:2114`），且分析面板当前只接受 fixture（`:783`）。`hdi.mjs` 只在分析路径（`engine.mjs:4,16`）。
- 影响：HDI 只到分析/计划层；`docs/implementation/multilayer-pcb-execution.md:99-130` 已列为残余。
- 建议：保留为产品边界并在 UI 显式"不支持盲埋孔写入"，避免用户以为能写。

### P2-3 DRC 证据归属依赖"手填 UUID"，start 不接收目标板
- 位置：`startPcbDrc()` 发空 body（`src/services/runtimeClient.ts:751-752`）→ 服务端按工程默认板启动（`runtime/server.mjs:2619-2625`）；落盘时却把 UI 由 `gatePcb` 传入的 UUID 写进 fingerprint（`:2642-2666`）。`latestPcbDrc()` 不带 pcbUuid（`runtimeClient.ts:747-749`），`loadLatestDrc` 直接填路径（`ValidationPage.tsx:336-343`）。
- 影响：手填 UUID 与实际运行的板不一致时，证据会被错误绑定（闸门对"证据属于另一块板"有阻断，见 `release-gate.mjs:259-318`，但错标方向仍不安全）。
- 建议：start 接收并返回真实 pcbUuid，report 只信服务端记录的板；latest 按 pcbUuid 过滤。

### P2-4 叠层证据未绑 pcbUuid、无人消费
- 位置：`pcb-layer-stack` 证据 fingerprint 是 window/project/document（`runtime/server.mjs:2589-2601`），没有 pcbUuid；六道门与下单闸门都不读它；只有需求验收映射按 `evidenceKind` 使用（`runtime/acceptance-mapper.mjs:12,17`）。
- 影响：层数变更本身"读回+保存"可靠，但"叠层是否正确/是否影响放行"没有闭环。
- 建议：fingerprint 补 pcbUuid；放行闸门读叠层证据并与 `design.boardLayerCount` 比对。

### P2-5 同步验收只比位号，不比网络/引脚
- 位置：`diffPcbAgainstNetlist` 只比较 `designators` 集合（`runtime/pcb.mjs:86-104`），路由只取原理图 `addIntoPcb` 位号与 PCB 位号（`runtime/server.mjs:3226-3232`）。
- 影响：位号齐但网络接错/多脚少脚不会被发现；真正的 pin 级网表差异（G3 的 `netlist-diff`）没有产品路径。
- 建议：复用 `netlist-diff` 能力做 pin 级比较，或把面板文案从"网表"改为"位号集合"。

## 3. 已确认打通（附证据）

1. **板框自动布局**：真机 PCB `2844799d86eeed27` 读回 60×40mm 闭合板框、180 器件，方案复核 `ok:true`，审计 hash 可追（`artifacts/a9-placement/README.md:5-13`）。
2. **写回硬门禁**：故意把 U1 放到 -1000mm，`placement/apply` 在写入前 409 `PLACEMENT_RULES_BLOCKED`（`artifacts/a9-placement/real-bad-plan-blocked-20261020.json`；`runtime/server.mjs:2280-2283`）。
3. **布局写回复核+定点回滚**：逐项回读中心点误差 ≤0.02mm、独立几何复核（含焊盘包络）、失败按原坐标写回并回读确认（`runtime/placement-write.mjs:112-206`；单测 `placement-write.test.mjs`）。
4. **布线门禁先复核后写**：真机两网络计划因 minGap -3.95mil/4 条 via-in-pad 违规被 400 拒写，写入循环未执行（`artifacts/a10-routing/README-20261020.md:9-22`；`runtime/engineering/routing-drc.mjs:51+`）。
5. **布线写入默认 dryRun+写后读回+自动回滚**：`applyRoutingPlan` 默认 `dryRun=true`（`pcb-routing.mjs:777`），写后按 id/几何回读，DRC 新增违规则回滚。
6. **DRC 后台任务**：start→poll→done 才归一化/分类/落盘，支持 cancel；超时/未知结果绝不返回空数组（`runtime/server.mjs:2619-2667`；`runtime/pcb.mjs:302-331`）。
7. **DRC 证据→闸门绑定**：证据文件按 kind 识别、按 pcbUuid 绑定，另一块板的报告会被 block（`runtime/server.mjs:1104-1115`；`release-gate.mjs:259-318`）。
8. **叠层 2→32 写后读回**：`pcb.layers.setCount` 不凭返回值；读回层数+每个铜层 id/type=SIGNAL 校验后才算成功并保存+落证据（`runtime/server.mjs:2523-2601`）；真机 4 层记录 2026-10-20（`artifacts/evidence/pcb-layer-stack/…5569b13faaef.json`）。
9. **R11/R12 教训已产品化**：所有写路由先快照后写、按 id/属性回读、失败自动回滚+回读（布局/布线/铺铜/叠层）；服务端一次性 write 批准绑定窗口+工程+文档指纹（`runtime/server.mjs:691+`）。

## 4. 本轮未复验/限制

- 本轮未启动 Runtime / Bridge / 嘉立创EDA：P0-1、P0-2 是代码路径判定；真机结论引用 2026-10-19～10-21 的历史证据（A9/A10/A11/叠层），**未复跑**。
- 两个真机 e2e（`e2e/placement-live.spec.ts:15`、`e2e/sync-verify-live.spec.ts:14`）默认 skip，只在 `CP_LIVE_EDA_E2E=1` 时运行；它们本身也只断言"自动布局已锁定"这句文案（`sync-verify-live.spec.ts:40-42`），**不能证明锁定生效**——代码里没有任何锁定（`ValidationPage.tsx:1043,1759,1785` 只是文案，`PlacementPage.tsx:77-90` 不检查同步结论；`runtime/pcb.mjs:80-81` 的注释"差异没清零就绝不放行后续自动布局"无对应实现）。
- 128 条规则包的具体逐条内容（thermal/PDN/EMC 等 SUP-*）只核对了实现和状态语义（缺证据→REVIEW），未逐条判定正确性；`SPACE-01/SPACE-18` 缺 courtyard/3D 时永远 REVIEW（`layout-rules.mjs:375-407,493-500`），唯一补证据入口是手写设计意图 JSON（`PlacementPage.tsx:188-189`；`placement-rules.mjs:143-150`）。
- 未见"整板自动布线完成"证据：A10 明确记录细间距必须 via-in-pad、需工艺声明（`a10-routing/README:26`），本轮不做能力推断。
- 历史文档 `docs/implementation/current-flow-gap-audit-2026-10-19.md` 的若干结论已过时（"布线/DRC 无 UI"），本文件以代码为准；其 P0-1（落板人工）、"DRC 未进问题列表"、"DRC 默认路径/演示报告"三点部分仍成立：落板入口有 UI 但仍不可自动（P0-1），DRC 不进问题中心成立（P1-6），默认路径预填已改为空并在取证后自动填（`ValidationPage.tsx:334-343`）。
