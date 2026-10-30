# CircuitPilot 全链路现状体检（哪些流程还没打通）

- 审计时间：2026-10-19
- 范围：`src/`（15 个页面 / 7 个主页签）、`runtime/`（36 个模块、75 条 HTTP 路由）、`scripts/e2e-live.mjs`、`manufacturing/`、`release/`、`docs/implementation/` 既有记录
- 方法：静态走查 + 路由/调用对账（脚本比对 client 方法 ↔ 服务端路由）+ 真机记录复核 + 现场实跑（`npm test` 455/455、`node --test` 相关模块、`discoverSolver`、`ngspice --version`）
- 判定口径（严格区分，不把"有代码"当"打通"）：
  - **[真机]** 在本机真实嘉立创EDA上跑通并留下可复核读数
  - **[代码]** 有实现且有测试，但只对 mock/fixture 验证过
  - **[只读验证]** 能真机只读检查，但不能驱动写入/放行
  - **[纸面]** 只有文案/字段/常量
  - **[缺失]** 完全没有

---

## 0. 结论先行

系统已经不是一个 Demo 壳子：**选型（真库+真价格）、受控写入（审批/快照/回读/DRC/回滚）、生产文件导出（真落盘+内容级校验）、3D STEP、128 条布局规则引擎**都有真实实现和测试。
但"从需求到生产"这条链**仍有 5 处硬断点**，其中 3 处卡在"真做了，但接不到下一步"：

1. **原理图 → PCB 落板必须人工**：嘉立创EDA 公开 API 不能新增 PCB 器件，系统只能判定差异 + 给指引，用户必须在 EDA 里手动"更新原理图到 PCB"；
2. **DRC 取证靠人填文件路径**，且界面默认路径指向 6 层演示板的旧报告 → 默认永远 blocked，真机 DRC 结果也不进"检查与问题"列表（那里是种子数据）；
3. **放行有三套口径**（release-gate 6 闸 / production readiness 6 条证据链 / export 裁决），互相不一致：export 能出 "final"，readiness 却因 online-dfm 恒 false 永远是 `ready:false`；
4. **价格/库存证据不进闸门也不进订单卡**：供应链模块真打网络，但前端没有入口，`gateSupply` 永远 unknown（只当 warning），下单卡永远"价格未知"；
5. **项目/需求/版本/问题/聊天全部存 localStorage**，runtime 侧计划与终审只存内存 → 清缓存或重启即丢，没有可归档的审计链；需求"硬约束违反即阻断"只是界面文案，执行门禁并不检查需求。
6. **前端交接断裂**：AI 计划候选只存在各自页面的 `useState`，从聊天页跳到 EDA 页会丢失；「创建AI修复任务」写进 `state.task.goal` 但聊天页不读；选型计划没有批准入口；阶段机只在执行原理图时写一次「原理图」，never 推进到 PCB布局/验证。

另有 3 段是**结构性缺失**（不是没实现，是产品边界）：自动下单/支付永久禁用、在线 DFM 只有外链+人工、全电路 SPICE/射频电磁无本地求解链（只能验证据）。

---

## 0.5 覆盖统计（路由 ↔ 前端）

- 服务端 HTTP 路由 **74 条**；前端经 `runtimeClient` 命中 **47 条**；**27 条没有前端入口**（16 条无任何消费者、8 条仅真机脚本、3 条仅单测）。
- `runtimeClient` 共 **55 个方法**，**7 个零页面引用**：`generateDesignPlan`、`normalizeProductionPlan`、`productionReadiness`、`recordProductionFinalReview`、`engineeringProfiles`、`events`、`productionRelease`。
- 15 个页面组件全部接入路由，无死页面；e2e 5 个 spec 里默认真机可跑的只有 `layout-rules`；`placement-live`/`sync-verify-live` 需 `CP_LIVE_EDA_E2E=1`，而它们的断言仍是旧 UI（`getByTestId('nav-placement')`、h1「验证中心/布局微调」），现 UI 已改为「验证与交付 / 布局微调」标签页且没有 `nav-placement` —— 即使开了真机开关也会失败，等于真机 e2e 覆盖是断的。

## 1. 目标链路九段现状

| # | 环节 | 现状 | 关键证据 | 断在哪 |
|---|---|---|---|---|
| 1 | 语言/语音输入需求 | [真机·文档] 文本；语音 [代码] | `src/utils/useVoiceInput.ts`（Web Speech，追加式、权限失败给中文提示）；`e2e/voice-requirement-input.spec.ts` 用假识别器 | 语音未真机验证；浏览器兼容性；需求只进 localStorage |
| 2 | AI 专业性判断/方案 | [真机] chat 真实 provider；曾正确 blocked | `runtime/chat.mjs`；`/api/chat/sessions/:id/messages`；AI 上下文由运行时事后补查（非 tool-calling） | 需求未 confirmed 也能继续；AI 计划与需求无强绑定 |
| 3 | 元件匹配（立创） | **[真机]** 真库检索 + 真价格库存 | `runtime/proposal.mjs`、`runtime/engineering/supply.mjs`（jlcpcb SMT 选料接口，实测 C23186 价格/库存）；`PartProposalPage` 勾选→计划 | 勾选计划只有 `component.create`，网络只作声明；价格未进闸门 |
| 4 | 画原理图（受控写入） | [真机]。通道已证明可行 | `runtime/design.mjs`（component/wire/netFlag/repair）、bridge 写命令、一次性审批+快照+回读+DRC+回滚；`wardrobe-assistant-design-verification.md` §82 实测 `createNetFlag`/`wire.create`/网表回读 | 产品 UI 里的同一条通道**缺少最新真机复证**；整板 179/179 是脚本/轮次驱动，不是 UI 流程 |
| 5 | ERC / 网表验收 | [真机·只读] | `runtime/schematic-acceptance.mjs`（网表 sha256、ERC 聚合、计划比对、仿真检查点）；`server.mjs` `/api/eda/schematic/acceptance` | **前端无调用**；ERC 只有聚合计数；验收结果不驱动写入门禁 |
| 6 | 按板框排布 + 微调 | [代码+真机只读] | `runtime/engineering/layout.mjs`、`placement.mjs`、`PlacementPage`（plan/apply）、`pcb.sync/verify` | 自动新增器件仍靠 EDA 人工；`sync verify` 空集 fail-open（`pcb.mjs:90-92`） |
| 7 | 仿真验收 | [真机] 能跑，但覆盖窄 | `runtime/simulation.mjs` 真 spawn；本机 `ngspice-46` 实测可跑；`spice-checks.mjs` 仅 CC-Rd / I2C 上拉 2 条 DC | `simulation.mjs:13-16` 注释已过期；全电路 SPICE 需 EDA 导出带模型网表；RF 电磁只验证据哈希 |
| 8 | 线路符合要求（DRC） | [真机只读] 但 UI 断 | `runtime/drc.mjs`、`/api/eda/pcb/drc/*`（start/report/cancel/exemptions） | **无 client/无 UI**；gate 只认 `drcReportPath` 手填；界面默认 demo 板旧报告 |
| 9 | 3D 贴装模型 | **[真机]** STEP 10.9–12.1MB | `/api/pcb/3d/export`；`scripts/e2e-live.mjs` 第 9 步；`release/2026-10-15/STEP_*.step` | **无 UI 入口**；GLB 该 EDA 版本不支持 |
| 10 | 生产文件/放行 | [真机] 导出；放行口径混乱 | `runtime/release-gate.mjs`（6 闸）、`production-export.mjs`（真写盘+复核+sha256）、`production.mjs` readiness | 三套口径不一致；readiness 恒 false；online DFM 恒 false |
| 11 | 下单/报价 | **[设计上禁用]** | `production.mjs:433` `order.status='disabled'`；`production.mjs:493` `orderEnabled:false` | 永久禁用；无嘉立创下单 API；价格只到"参数卡" |

---

## 2. 已经真正打通的（可以放心用）

| 能力 | 证据 |
|---|---|
| 元件选型：需求 → 真实库检索 → 勾选 → 计划 | `/api/library/proposals` 真实检索；`supply.mjs` 真实价格/库存（含阶梯价、库存、来源与查询时间）；`PartProposalPage` 有完整交互 |
| 受控写入：绑定 → 审批（planHash+一次性令牌）→ 快照 → 写入 → 回读 → DRC → 失败回滚 | `EdaPage` 两套五步流程；`runtime/design.mjs`、`pcb.mjs`、`eda-gui.mjs`（GUI 通道白名单化，CDP 受信任输入） |
| 布局规则：128 条可执行判定 + 7 门禁 + UI + e2e | `runtime/engineering/layout-rules.mjs`；`#validation/rules`；`e2e/layout-rules.spec.ts` 3/3；457 条 runtime 测试 |
| 生产文件：裁决 → 导出 → 落盘 → 内容级复核 → manifest(sha256) | `release/2026-10-15/manifest.json`（有真实字节+哈希）；`release/2026-10-16`；`artifacts.mjs` 的 Gerber 铜层/BOM 位号/CPL 坐标/STEP 头校验 |
| 3D STEP 贴装模型 | 真机 12,157,210 bytes，`release/2026-10-15/STEP_CircuitPilot-assembled.step` |
| 工程数值：阻抗反解、叠层、IPC-2221 载流、布线几何 | `impedance.mjs`（正反解 round-trip）、`stackup.mjs`、`layout-rules.requiredTraceWidthMm`、`pcb-routing.mjs`（A* + 间距复核 + 差分等长，apply 默认 dryRun） |
| 真机全链路只读脚本 | `scripts/e2e-live.mjs` 15 步全过（2026-10-16），首末铜几何比对证明不改板 |

---

## 3. 半打通 / 断点（按用户视角，从"卡得最死"排序）

### P0-1 原理图 → PCB 落板必须人工

- 嘉立创EDA 3.2.186 公开 API **不能新增 PCB 器件**（`runtime/pcb.mjs:73-76`、`server.mjs:1064-1075`）；`importChanges` 空转、源码通道只支持改写。
- 系统能做的是 `GET /api/pcb/sync/verify`：判定缺/多/未标注器件 + 给操作指引（"设计 → 更新/转换原理图到 PCB"）。
- 后果：AI 生成的原理图**无法自动变成 PCB**，必须人进 EDA 点菜单，再回来点"回读验收"。
- 附带缺陷：`diffPcbAgainstNetlist` 在两边都读空时 `ready:true`（fail-open），读取失败会被误报成一致。

### P0-2 DRC 证据靠人手填，且默认指向演示板

- 闸门从 `body.drcReportPath` 读报告（`server.mjs:476-480`），前端默认填 `deliverables/cp-multilayer-monitor-20261013/drc-report-20261013.json`（`ValidationPage.tsx:27-28`）——这是 6 层演示板的旧报告（156 条，含 63 条 Connection Error），不是当前工程。
- `/api/eda/pcb/drc/start|report|cancel|exemptions` 四条路由**没有 client 方法、没有 UI**（`server.mjs:936-983`）。
- 用户看到的"检查与问题"列表来自 `src/data/seed.ts:113-121` 的种子数据（ERC 2 条、DRC pass、BOM warn…），与真机 DRC 无关；"在EDA中定位/创建AI修复任务"也只改本地状态。

### P0-3 放行口径三套，互相打架

| 入口 | 闸门 | 结果 |
|---|---|---|
| `POST /api/eda/release/gate` | 6 闸：schematic / simulation / drc / placement / artifacts / supply | 可 `ready:true`（"可以下单"），但 supply 价格靠传参 |
| `POST /api/production/readiness` | 6 条证据：semantic-plan / compiled-quality / official-pcb-drc / artifacts / **online-dfm(恒 false)** / human-final-review | **永远 false**；`orderEnabled:false` |
| `POST /api/production/export` | 复用 release-gate 裁决 | 可写 `final` 文件（`release/<date>`） |

- 真机报告就出现"export final 成功，readiness ready:false"（`docs/implementation/e2e-live-2026-10-16.md`）。
- 目录分裂：闸门默认扫 `deliverables/`（`server.mjs:441`），导出默认写 `release/<date>/`（`server.mjs:675`）→ 导出完必须手改路径才被下一次闸门看见；`deliverables/` 里还留着 `-DRAFT-NOT-FOR-ORDER` 产物。
- 人工终审 `reviews` 是内存 Map（`production.mjs:449,468`），runtime 重启即丢，且无 UI 入口。

### P0-4 价格/库存证据没有接入闸门与订单

- `supply.mjs` 真实可用，但前端 0 调用（`/api/supply/pricing` 无 client 方法）。
- `runtimeClient.releaseGate` 支持 `pricing` 参数，`ValidationPage.tsx:205-211` **不传** → `gateSupply` 永远 unknown，且只算 warning 不阻断（`release-gate.mjs:356-372`）。
- `orderCard` 不传价格（`fabrication-order.mjs:165`），下单卡永远"价格未知"。

### P1-5 需求未进入运行时门禁

- `RequirementsPage` 文案写"违反硬约束时阻断执行"，但执行门禁 `getExecutionGate` 只查计划批准/步骤/EDA 连接/写入暂停/窗口（`src/state/taskMachine.ts:33-40`）。
- runtime 的 plan 校验（`design.mjs`、`production.mjs`）完全不读需求（grep 无 `requirements`）。
- 后果：需求冲突/缺失时仍然可以生成并写入设计，只要 AI 没拒绝。

### P1-6 持久化与审计链缺失

- 项目、需求、组件、验证结果、变更记录、问题、聊天记录全在 `localStorage`（`AppContext.tsx:118,187`），schema 版本迁移也在前端。
- runtime 侧：chat sessions 内存 Map；production plans/reviews 内存 Map；DRC 报告与豁免只认文件路径。
- 后果：清缓存/换浏览器/重启 Runtime 即丢工作痕迹；没有可归档的"审计包"，与"证据哈希绑定"的工程哲学不匹配。

### P1-7 概览与检查页显示的是种子数据

- `OverviewPage` 的验证通过数、组件数、问题数全部来自 `state.validations/components`（seed + localStorage），与真机 gate/DRC 结果无关。
- 用户在概览看到的"检查 8 项 / 3 项通过"不是当前工程的真实现状，容易被误判为"已验证"。

### P1-8 前端流程断点（按钮点了但流程没接上）

| 断点 | 证据 | 用户后果 |
|---|---|---|
| **AI 计划交接断裂**：需求页/聊天页生成候选后点「进入EDA编译与审批」，只做 `navigate('eda')`；候选计划存在 AiTasksPage 的 `useState`，EdaPage 的 `conversationCandidate` 是另一份 `useState` | `AiTasksPage.tsx:234`、`EdaPage.tsx:79` | 到 EDA 页后候选为空，只能再花一次 AI 调用重生成；最终批准的可能不是原计划 |
| **「创建AI修复任务」石沉大海**：把问题写进 `state.task.goal` 后跳聊天页，但聊天页只读 `planHash`，不读 `goal` | `ValidationPage.tsx:77-80`、`AiTasksPage.tsx:128` | 用户以为创建了任务，回聊天页输入框仍是空的 |
| **选型「落 plan」无出口**：计划只在 PartProposalPage 内存里，验证页没有接收该 planHash 的批准入口 | `PartProposalPage.tsx:67-75,162` | 刷新即丢；后续批准无法绑定这份选型 |
| **阶段机不推进**：全仓只有 `EdaPage.tsx:282` 写 `stage:'原理图'`，无代码写 `PCB布局/验证` | `EdaPage.tsx:282`、`seed.ts` | 概览主 CTA 永远停在 EDA；Execution 步进器第 3/4 步永不点亮；「生成交付包」条件不可达 |
| **主验证按钮是 Demo**：「运行全部检查」走 `demoAdapter`（seed 状态），真闸门是另一个按钮 | `ValidationPage.tsx:48-53,571` | 用户点最显眼的按钮得到"模拟通过"，与真机结论无关 |

### P1-9 孤儿能力（后端/脚本有，产品无入口）

| 能力 | 路由/模块 | 现状 |
|---|---|---|
| PCB 自动布线 plan/apply/rollback/finish | `/api/eda/pcb/routing/*`（4 条） | 真几何 + dryRun + 回读回滚，**无 client/无 UI**，仅 `scripts/e2e-live.mjs` 只读 plan |
| DRC 取证 | `/api/eda/pcb/drc/*`（4 条 + 豁免 2 条） | 无 client/无 UI |
| EDA GUI 通道 | `/api/eda/gui/execute|state` | 白名单化 CDP 动作，无 UI；铺铜/菜单等只能靠它 |
| 3D 导出 | `/api/pcb/3d/export` | 无 UI，只能脚本 |
| 原理图验收 | `/api/eda/schematic/acceptance` | 无 client |
| 供应链查价 | `/api/supply/pricing` | 无 client |
| 项目打开 | `/api/eda/project/open` | 无 client |
| 设计取消/能力探测 | `/api/design/cancel`、`/api/design/capabilities/probe` | 无 client |
| 生产就绪/终审 | `/api/production/readiness`、`/api/production/reviews/final` | 有 client、无页面 |
| 工程能力清单 | `/api/engineering/profiles` | 有 client、无页面 |
| 事件流 | `GET /api/events` | 有 client、无页面 |

### P2-10 仿真覆盖窄，RF 只验证据

- 本机 `ngspice-46` 可跑（实测 `discoverSolver` 命中 `/opt/homebrew/bin/ngspice`），但 `spice-checks` 只有 2 条 DC 检查（USB-C Rd、I2C 上拉），且 `hasRd` 判"有任一电阻"、上拉靠"电阻数 > 1"推断，不是网表级判定。
- 全电路仿真依赖 EDA 导出带 `.op/.tran` 的 SPICE 网表；当前工程没有仿真模型绑定。
- RF 只做 CPWG/λg 公式与证据门禁，电磁结果不产出（`rf.mjs` 明确 `executable:false`）；`simulationJobs` 不可执行。

### P2-11 语音与协作

- 语音是 Web Speech API（浏览器能力），e2e 用假识别器；未真机验证识别质量，Firefox/Safari 兼容性有限。
- 全系统单用户本地运行：没有账号、团队、项目共享、云端库。

---

## 4. 结构性缺失（产品边界，不是 bug）

| 缺失 | 现状 | 说明 |
|---|---|---|
| 自动下单/支付 | 永久禁用（`production.mjs:433,493`） | 明确的安全边界；只出"下单参数卡" |
| 在线 DFM | 无 API，只有 `https://www.jlc-dfm.com` 外链 + 人工上传 | readiness 因此恒 false |
| 全电路仿真/热仿真 | 无本地求解链（ngspice 只能跑检查点） | 需外部工具 + 模型 |
| 3D 干涉/装配校验 | 仅 STEP 导出，无干涉计算 | 布局规则里有外形/壳体一致性条目，但需要结构输入 |
| 团队/多用户/云端 | 无 | 本地单机产品定位 |

---

## 5. 建议修复顺序（按"解锁下游"排序）

**P0（不修则整条链走不到放行）**
1. 统一放行口径：readiness 与 release-gate 合并为一套证据；online DFM 改为"人工上传结果 + 签核证据"gate（有证据才过），不再恒 false；导出/gate 统一到 `release/<date>/`。
2. DRC 一键取证进 UI：`drc/start → poll → drc/report`，报告落到当前工程目录并自动填进 gate；删除/隔离 `seed.ts` 的验证数据（或显著标 DEMO）；默认路径改为当前工程。
3. 持久化与审计：runtime 侧加项目/计划/终审/DRC 的 JSON 落盘（或 SQLite），`reviews` 不再只在内存；导出时生成"审计包"（manifest + 证据哈希 + 时间线）。

**P1（把"有实现"变成"可点"）**
4. 修前端交接：计划候选提到全局 store（或路由参数带 planHash）；修复任务真正传给聊天页；选型计划落到 `state.task` 并在验证页可直接批准；阶段机按真实执行结果推进（原理图→PCB布局→验证→归档）。
5. 供应链接闸门与订单卡：`/api/supply/pricing` 加 client；orderCard 传价格；`gateSupply` 在"无价格"时由用户选择"阻断"或"知悉后放行"。
6. 补 4 个关键 UI：布线（plan 预览 + dryRun + apply）、3D 导出、原理图验收、生产就绪/终审。
7. 需求门禁：confirmed 需求/冲突作为 `execute` 前置；runtime 校验读需求快照。
8. 概览/版本页接真实数据（最近 gate、最近 DRC、最近导出），否则明确标 DEMO。

**P2（体验/覆盖）**
9. 仿真：把 2 条 DC 检查点扩到网表级（I2C 上拉/总线电容、RC 上升时间），接入 EDA 导出的带模型网表。
10. 语音真机验证 + 兼容性提示。
11. 真机 e2e 常态化：`e2e-live.mjs` 接入 CI（无 EDA 时 skip 并如实标记），而不是只留人工脚本。

---

## 6. 本次审计的复现命令

```bash
npm test                                   # 455/455 通过（typecheck + vitest + runtime）
node --test runtime/__tests__/engineering.test.mjs   # 规则引擎/API 接线
node --input-type=module -e "import('./runtime/simulation.mjs').then(m=>console.log(m.discoverSolver()))"
ngspice --version                          # 本机 ngspice-46
npx playwright test e2e/layout-rules.spec.ts         # 规则中心真机 UI（需 npm run dev:full）
node scripts/e2e-live.mjs                  # 真机全链路只读（需 EDA + runtime）
```

## 7. 证据可信度说明

- 本报告所有"断点"均在当前代码里核对过 file:line；"真机"结论引用既有真机记录（`docs/implementation/e2e-live-2026-10-16.md`、`whole-board-progress.md` §40–§59、`wardrobe-assistant-design-verification.md` §82）。
- 未在本轮重新真机验证的项（语音识别质量、AI netlist 当前是否仍 blocked、最新 EDA 版本上布线/铺铜写入成败）已明确标注"未验证"，不当作结论。
- 两个子审计的旧结论已被本轮证据推翻或修正：①"原理图写入真机不可用"——最新记录（§82）显示是"文档未真正打开"造成的假象，通道已通；②"本机无 SPICE 求解器"——`simulation.mjs` 注释过期，本机已装 ngspice-46。

---

## 8. 进展更新（同日，自动化 Phase 0+1 之后）

> 说明：本节只记录**已经用测试/真机证据确认**的变化；没有证据的条目不写"已修复"。

| 审计项 | 状态变化 | 证据 |
|---|---|---|
| 原理图 → PCB 落板必须人工（§0 第 1 条） | 🟡 **有自动通道，待人工批准的真机写入验收**：新增 R2 配方 `pcb-sync-from-schematic`，先调 `pcb.importChanges`，读回"PCB 器件数 ≥ 原理图器件数"，不符再走 GUI 菜单兜底 | `runtime/automation/recipes.mjs`；单测 22/22；HTTP 契约 6/6；真机未批准时 `needs_approval`、0 步执行 |
| 自动化没有落地链路 | ✅ **内核 + R1 真机通过**：配方 schema/读回断言/哈希链/服务端一次性批准（绑定窗口+工程+文档指纹）/API 优先+GUI 兜底/UI `#automation`/CLI | `docs/implementation/automation-kernel.md` §7；`artifacts/automation-phase1-smoke.json`；真机 R1 `completed` |
| 写入无批准/批准可伪造 | ✅ 客户端不能再自报布尔；批准由服务端签发、一次性、30 分钟、换板 409 | `runtime/automation/approvals.mjs`；HTTP 契约测试"复用 409 / 指纹变化 409 / 配方不匹配 409" |
| 读回"假成功" | ✅ 每步必须读回+断言；真机还暴露并修复了桥信封 `{success,result}` 没解开导致 `eda-read-project` 假失败 | `verify.mjs` `unwrapReadback`；回归测试；真机三个只读配方 `completed` |
| DRC 取证靠人填路径 + demo 默认（§0 第 2 条） | ⛔ 未修（Phase 3） | — |
| 三套放行口径（§0 第 3 条） | ⛔ 未修（Phase 3） | — |
| 价格/库存不进闸门（§0 第 4 条） | ⛔ 未修（Phase 3） | — |
| 全 localStorage / 内存计划与终审（§0 第 5 条） | ⛔ 未修（Phase 3；配方审计已落盘，但业务状态仍未持久化） | — |
| 前端交接断裂（§0 第 6 条） | ⛔ 未修（Phase 2） | — |
| R2/R6 真机写入 | ⏳ 需要**人**在 UI/CLI 上批准后执行；AI 不代签写板批准 | `node scripts/automation-run.mjs pcb-sync-from-schematic --approve` |

**结论**：自动化内核把"有没有一条可审计的自动执行链"从 [纸面/缺失] 推进到 **R1 [真机] + R2/R6 [代码+模拟验证，待人工写板批准]**；审计里的其余 5 类硬断点（DRC 证据、放行口径、价格闸门、持久化、前端交接）仍是未修状态，按 Phase 2/3 推进。
