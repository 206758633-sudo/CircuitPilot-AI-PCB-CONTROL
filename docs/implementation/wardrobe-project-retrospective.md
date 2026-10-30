# 智能衣橱助手项目复盘：遇到的问题，以及 CircuitPilot 被修复/完善到了什么程度

- 复盘时间：2026-10-19
- 对象：CircuitPilot 用 AI 设计「智能衣橱助手」主板的真实过程（EDA 工程 `5e1059beff734847ba4b38b557e8ed59`，PCB1 `2844799d86eeed27`，60×40mm 2 层）
- 证据来源：`docs/implementation/wardrobe-assistant-design-verification.md`（Round 1–82 真机记录）、`docs/implementation/whole-board-progress.md`（Round 16–64 执行交接）、`manufacturing/wardrobe-assistant/RELEASE-STATUS-DRAFT.md`、`current-flow-gap-audit-2026-10-19.md`、`automation-kernel.md`，以及本仓库当前代码与测试
- 判定口径（不把"有代码"当"打通"）：
  - **✅ 真机修复/产品化**：有代码 + 测试或真机读数证明，且是产品能力而非一次性脚本
  - **🟡 流程/配方规避**：问题被绕过，但产品代码没有根除
  - **🔁 误判已更正**：当时结论是错的，后来被真机证据推翻，并留下了方法论改进
  - **⛔ 未修**：仍然存在，阻塞放行或属于系统级缺口

---

## 0. 一句话结论

智能衣橱助手项目**把 CircuitPilot 的"执行通道 + 证据纪律 + 自动化内核"显著推完善了**，也**暴露并修复了一批真实产品缺陷**；
但它**没有把"AI 从需求到可制造放行"彻底跑通**：板子目前仍是 **DRAFT-NOT-FOR-ORDER**（PCB DRC 1100、原理图未连线、ERC 158、DFM/人工签核未做）。
所以答案是：**修复了系统的一部分能力，也完善了制度；但没有完成"全链路闭环"本身**。

---

## 1. 项目当前真实状态（不是"已完成"）

以 `RELEASE-STATUS-DRAFT.md`（2026-10-18 实测）为准：

| 项目 | 实测 | 结论 |
|---|---|---|
| 元件 | 180（51 项 BOM 落板完成） | ✅ 落板数量达成 |
| 焊盘 / 网络 | 599 焊盘，有网 505（84.3%），62 网络 | 🟡 仍有 94 焊盘无网 |
| 铺铜 | 2（顶层 + 底层 GND，已填充） | ✅ |
| 走线 / 过孔 | 1232 线 / 113 孔（EDA 自动布线器，断于约 65%） | 🟡 未收敛 |
| PCB DRC | **1100 条**（Clearance 925 / Connection 174 / Netlist 1） | ⛔ 未清零 |
| ERC（原理图） | **158 项**（致命 0 / 错误 1 / 警告 19 / 信息 138，主要引脚悬空） | ⛔ 未连线 |
| 制造物 | BOM/CPL/Gerber/STEP 全部 `DRAFT-NOT-FOR-ORDER` | ⛔ 未放行 |
| 人工签核 | 三人签核表为空 | ⛔ 禁止下单 |

---

## 2. 过程问题清单与修复判定

### 2.1 需求与选型阶段

| # | 问题 | 根因 | 处理与证据 | 状态 |
|---|---|---|---|---|
| R1 | 单轮需求输出太大导致 `CODEX_TIMEOUT`（要"6 页冻结包 + GPIO 表 + 电流预算"就超时），会话膨胀后短问也超时 | 单轮 token/工具调用过多；同一线程历史过长 | 改为**按阶段开新会话**、压缩已冻结输入（`mira-req-1`→`mira-req-2`）；`whole-board-progress.md` §五 | 🟡 流程规范，未做产品级会话裁剪 |
| R2 | 选型链"命中率不稳"：`BQ24074RGTR` 等关键词检索 0 命中，导致计划里器件身份为空 | `collectSelectionEvidence` 只按完整关键词单次检索，无"去后缀/品牌+系列"回退（`runtime/chat.mjs:88-121`） | 当时建议加回退序列；**代码未实现**，实际靠"AI 查型号→用户确认"的提案流程兜底（`PartProposalPage`、`/api/library/proposals`） | ⛔ 回退序列未修；🟡 有替代流程 |
| R3 | 真实 BOM 与设计选型有偏差（真板有板上 WS2812 ×5、若干替代料），早期设计漏项 | 需求只给功能不给型号；商城候选≠真板 BOM | 建立"候选提案→用户勾选→落 plan"通道（verification §17.4/§18.2/§19，`PartProposalPage`）；把差异显式列给用户 | 🟡 流程修复，未自动对齐真板 BOM |
| R4 | 器件**引脚功能名拿不到**（库元数据只有 symbolName/symbolUuid；LCSC 手册 405），无法直接生成网表 | 嘉立创库/接口能力边界 | 结论：引脚只能在**器件落板后**用 `getAllPinsByPrimitiveId` 读；其余必须标注"工程判断"并请用户确认，禁止猜 | ⛔ 能力边界未变；🟡 流程上诚实标注 |
| R5 | AI 网表首次调用 `status:blocked`（0 器件 0 网络） | 缺引脚证据时 AI **拒绝编造**（正面行为） | 调整顺序：先落器件拿真实引脚，再出网表；`whole-board-progress.md` §六 | ✅ 产品守住了"不编造"红线 |

### 2.2 原理图 / 网表 / 写入通道

| # | 问题 | 根因 | 处理与证据 | 状态 |
|---|---|---|---|---|
| R6 | 连写第 2 个器件必 `code 20 aborted`；逐件写板 16–75 秒/件，178 件不可行 | 单器件首次拉库数据极慢，撞单命令超时；逐件往返太贵 | 桥接改为**单飞队列 + 每命令预算 + 读/校验类安全重试（写命令不重试）**（`runtime/bridge.mjs:898-988`，`runtime/__tests__/bridge.test.mjs`）；执行侧改"小批 2–3 件 + 每批回读" | ✅ 通道加固；🟡 "整板一次落"仍靠脚本批内循环 |
| R7 | 手工注入文档源码（拼整板 `COMPONENT`）被 EDA 拒绝 | `Symbol`/`Device` 是**文档本地身份**，只能由 EDA 放置动作生成 | 判定"离线拼整板源码不可行"；改用产品自己的 `schematic.component.create` 等命令；`whole-board-progress.md` §十三 | ⛔ 源码注入永久不可行；✅ 结论被记录 |
| R8 | "原理图写通道全坏 / API 全坏"的悲观判定 | 实际是**页面 hidden 节流 + 文档没有真正打开**；且探针绕过 `validateArgs`、用错参数名 | 加入 `focus` 动作与 CDP 生命周期强制；`POST /api/eda/schematic/open-current` 激活文档（`runtime/server.mjs:1037`）；§82 真机推翻旧判定 | 🔁 误判已更正 + ✅ 产品补了打开/聚焦通道 |
| R9 | 板框命令与计划规范器互相矛盾（`buildCode` 写死坐标 vs 规范器要求 `widthMm/heightMm`） | 命令实现与校验层参数不一致 | `pcb.outline.create` 改为接受 `originXMm/originYMm/widthMm/heightMm` 并回读校验（`runtime/bridge.mjs:397,674`） | ✅ 真机修复并单测 |
| R10 | 设计门禁"从零设计永远过不了自己的门禁"（写入自锁） | 原理图 DRC 强制执行且不可跳过；器件与网络必须一起落 | 判定为**保护而非缺陷**；提供 `reviewed-netlist` 计划（组件+网络同计划）、`schematic/repair` 修复通道（`runtime/server.mjs:716`，`runtime/design.mjs:25-59`） | ✅ 产品语义成立；🟡 使用门槛高 |
| R11 | 多轮"超时/abort"后其实已经写进文档（迟到落板）→ 重复件、杂散 `CN2`、审计晚于落板 | 桥返回超时 ≠ 没写；EDA 异步落盘 | 建立铁律：**每次写入后必须回读核对**；`code 20` 后先只读审计；隔一拍二次审计；产品侧自动化内核把"读回验证"固化为每步必填（`runtime/automation/verify.mjs`/`runner.mjs`） | ✅ 已固化为产品机制（自动化配方强制读回） |

### 2.3 目标工程 / 环境

| # | 问题 | 根因 | 处理与证据 | 状态 |
|---|---|---|---|---|
| R12 | 一度在**空板**上施工（工程里有两块板：Board1_1/PCB1 真板 22 件，Board1_2/PCB2 空板） | 目标文档未先枚举确认 | 先枚举工程/文档/器件数/DRC 再定位真板；新增 `GET /api/eda/workspaces/current` 做工程绑定（`runtime/server.mjs:1205`）、`pcb.open` 打开指定文档；自动化批准绑定"窗口+工程+文档"指纹 | ✅ 目标绑定产品化；教训写入交接 |
| R13 | EDA 重启/断连后状态丢失、页面 hidden 时画布类 API 失效 | 渲染进程会话切换 + 后台节流 | `eda.session` 健康探针（`runtime/bridge.mjs:445` 附近）；GUI `focus` 强制 active；失败即收口在途任务，避免 `EDA_JOB_BUSY` 永久堵死（bridge 测试覆盖） | ✅ 产品化 |
| R14 | "专用 EDA 工程"建不出来 | EDA 侧缺陷（非 CircuitPilot） | 记录为外部阻塞；产品保留单工程内多 Board 的路线 | ⛔ 外部依赖，未修 |

### 2.4 PCB 落板 / 布局 / 布线 / 铺铜

| # | 问题 | 根因 | 处理与证据 | 状态 |
|---|---|---|---|---|
| R15 | `pcb.importChanges` 返回 `success:true` 却**零同步**（多轮复现） | EDA 该 API 空转；原理图位号 `C?` 未标注 | 不再信返回值：`GET /api/pcb/sync/verify` 做差异判定（`runtime/server.mjs:1090`）；落板改走 `pcb.component.create` + 回读（`runtime/bridge.mjs:343`）；自动化 R2 配方强制 compose 读回 + GUI 兜底 | 🟡 根因未修（EDA 侧）；✅ 产品已不依赖它并加了读回 |
| R16 | PCB 直放"能落但糙"：超时、自动位号与 BOM 不符（给成 `C6`）、layer 只认数字 | Beta API 行为 | 配方化：create → id 差集找新件 → `modify` 改位号 → 回读（`runtime/bridge.mjs:300`）；并加了 `pcb.pins.read`（`runtime/bridge.mjs:352`）供布线用 | ✅ 产品化 |
| R17 | 铺铜 API 6 类参数组合全部失败，"重建铺铜"只能人工点菜单 | 该版本无可用铺铜创建 API | 产品保留 `pcb.pour.rebuild`（write-beta）重建已有铺铜；GUI 通道自动点"工具→铺铜管理器→重建所有→确认"（真机验证）；已写进自动化 R6 配方 | ✅ 双通道兜底 |
| R18 | 板框/画布类操作"失效" | `document.visibilityState === 'hidden'`（页面隐藏节流），不是坐标算法 | `focus` 修复 + 状态栏缩放可控（§81）；`eda-gui.mjs` 白名单 15 动作（`runtime/eda-gui.mjs:23`，18 条 GUI 测试） | ✅ 产品化 |
| R19 | `TYPEC-304-BCP16` 封装不可布线（四方向穷举都新增 DRC） | 器件封装焊盘间距/焊盘形态决定 | 换可布机器件后闭环一次通过；产品侧保留"只提交 0 新增违规 + 失败自动回滚"的布线门禁 | 🟡 工程决策，非产品缺陷 |
| R20 | 自动布线器 65% 中断、间距规则与布线器不一致 → DRC 1100 | 布线器能力/规则不匹配；时间与迭代预算 | 保留"每次只提交 0 新增、失败回滚"的纪律；DRC 清零仍未完成 | ⛔ 未解决（阻塞放行） |

### 2.5 验证口径 / 门禁

| # | 问题 | 根因 | 处理与证据 | 状态 |
|---|---|---|---|---|
| R21 | DRC 数字对不上：快速检查 8 条 vs 目标/全量 47 条 | 两套口径（同步快速检查 vs 异步全量报告） | 统一走 `pcb.drc.job.start → pcb.job.poll/report`（`runtime/server.mjs:962-1000`）；文档明确"对齐前不许说 47"；原目标 52≠47 以实测为准 | ✅ 口径统一 + 产品化 |
| R22 | 误读"门禁 DRC passed:true"为"板子 DRC 干净" | 门禁语义是"本次改动没有新增/恶化" | 在记录中更正语义；产品保留基线对比（`runtime/pcb.mjs` regressions） | 🔁 误判更正；✅ 语义本来正确 |
| R23 | DRC 豁免"填了不生效/静默放行" | 豁免文件匹配与配额逻辑缺陷 | 修复后 44 条→豁免 93、反例 0/156；`/api/eda/pcb/drc/exemptions`（`runtime/server.mjs:1005-1007`）+ 单测 | ✅ 产品修复 |

### 2.6 交付 / 放行

| # | 问题 | 根因 | 处理与证据 | 状态 |
|---|---|---|---|---|
| R24 | 正式放行需要人工签核 / DFM 在线复核；下单/支付永久禁用 | 产品安全红线 | 保持 `humanSignoffRequired=true`、`orderEnabled=false`、制造物 `DRAFT-NOT-FOR-ORDER`；DFM 仅外链 + 人工补证 | ✅ 设计如此，未绕过 |
| R25 | 三套放行口径不一致（release-gate 6 闸 / production readiness 6 链 / export 裁决） | 历史演进，各写一套 | **未修**（审计 §0 第 3 条） | ⛔ 未修 |
| R26 | 项目/需求/计划/终审只存 localStorage 或内存 | 无持久化层 | **未修**（`runtime/production.mjs:449` 仍是内存 `Map`） | ⛔ 未修 |

---

## 3. 真正沉淀为产品能力的修复（"系统被完善"的部分）

这些不是一次性脚本，而是进入了 `runtime/` / `src/` 并有测试或真机记录：

1. **桥接通道加固**：单飞队列、逐命令超时预算、读/校验类瞬时失败重试、写命令不重试、长任务在途互斥与失败收口（`runtime/bridge.mjs:898-988`；`runtime/__tests__/bridge.test.mjs` 覆盖"110s 神秘超时""永久 EDA_JOB_BUSY"等反例）。
2. **命令能力补齐**：`pcb.component.create` / `pcb.component.modify` / `pcb.pins.read` / `pcb.outline.create`（可传尺寸）/ `pcb.pour.rebuild` / `eda.session` / `eda.api.describe`（`runtime/bridge.mjs:300,343,352,397,420,445`）。
3. **DRC 全量任务与豁免**：异步 DRC start/poll/report + 豁免文件 + 基线对比（`runtime/server.mjs:962-1007`，`runtime/pcb.mjs`）。
4. **目标绑定**：`/api/eda/workspaces/current`、`pcb.open`、`document.current` 指纹，避免"在空板上施工"（`runtime/server.mjs:1205`）。
5. **设计门禁三阶段**：plan → approve（指纹）→ execute（批准令牌 + 失败回滚）`/api/design/plan|approve|execute`（`runtime/server.mjs:1047-1075`），`reviewed-netlist` 强制器件与网络同计划（`runtime/design.mjs:25-59`）。
6. **GUI 受控输入通道**：15 个白名单动作（focus/dblclick/clickText/drag/type/shortcut/screenshot/launch…；`eval` 属调试动作，默认禁用），修复 hidden 节流与工程树打开（`runtime/eda-gui.mjs:23`，18 条测试）。
7. **128 条 PCBA 布局规则引擎**：规则包 + 审计 + 证据 + 门禁联动（`rules/board-layout-rules.json`、`RuleCenterPage`、规则测试），把"布局不合理"从主观判断变成可执行检查。
8. **自动化内核 Phase 0+1（本轮新增）**：确定性配方、`compose` 多路读回、GUI 兜底、服务端一次性批准（绑定窗口+工程+文档指纹、30 分钟、一次性）、哈希链审计、UI `#automation`、CLI（`runtime/automation/`、`src/pages/AutomationPage.tsx`、`scripts/automation-run.mjs`）。
9. **真机修掉一个"假失败" bug**：桥成功信封是 `{success,result}`，`unwrapReadback` 只认 `{ok,result}`，导致 `eda-read-project` 永远报"没有路径 data"；已修复并加回归测试（`runtime/automation/verify.mjs`）。
10. **测试与可复现基线**：`npm test` 从 task-matrix 记录的 346+63 条增长到 **483 runtime + 73 vitest**，`app.spec` e2e **26 条**（本轮实跑），`npm run build` 通过；每个结论尽量有可复现命令。
11. **证据纪律制度化**：`current-flow-gap-audit-2026-10-19.md`（6 类硬断点 + 27 个无前端入口路由）、`automation-kernel.md`（安全矩阵 + 真机验收）、本轮复盘（本文件）；真机记录区分 [真机]/[代码]/[纸面]/[缺失]。

---

## 4. 被"流程/配方"绕过、但产品仍未根除的技术债

| 技术债 | 现在的绕法 | 风险 |
|---|---|---|
| `pcb.importChanges` 空转 | 改用 `pcb.component.create` + 回读；自动化 R2 加读回和 GUI 菜单兜底 | EDA 升级/换版本后替代路径也可能变 |
| 逐件创建慢（16–75s/件） | 小批 2–3 件 + 每批回读；"整板一次落"靠单次调用内循环脚本 | 脚本未产品化，换机器要重写 |
| 文档源码注入被封 | 放弃离线拼整板源码 | 无法做"批量网表一次性导入" |
| 迟到落板（超时≠没写） | 人工/脚本"隔一拍二次审计" | 依赖操作纪律，未做成自动事务 |
| 选型关键词命中不稳 | 提案页 + 用户确认 | 自动化选型仍会漏检 |
| 引脚名缺失 | 落板后读 `getAllPinsByPrimitiveId`；其余靠 PDF + 工程判断 | 网表质量依赖人工判断 |
| 铺铜创建 API 不可用 | `pcb.pour.rebuild` + GUI 菜单兜底 | 新建铺铜仍要 GUI/人工 |
| 布线器 65% 中断、间距不匹配 | 只提交 0 新增 + 失败回滚，继续迭代 | DRC 1100 未清零 |

---

## 5. 仍未修复的系统级缺口（来自同日全链路体检）

1. **DRC 取证靠人填文件路径**，界面默认路径指向 6 层演示板旧报告 → 默认永远 blocked；真机 DRC 不进"检查与问题"列表。
2. **三套放行口径**（release-gate / production readiness / export）互不一致；`online-dfm` 恒 false → readiness 永远 `ready:false`。
3. **价格/库存不进闸门也不进订单卡**：`gateSupply` 永远 unknown（warning），下单卡永远"价格未知"。
4. **持久化缺失**：项目/需求/计划/终审存 localStorage 或内存，重启/清缓存即丢；没有可归档审计链。
5. **前端交接断裂**：AI 计划候选只在各页 `useState`；"创建 AI 修复任务"没人读；选型计划没有批准入口；阶段机只写一次"原理图"。
6. **自动化 R2/R6 尚未在真实板子上做写入验收**：按"写板必须人工批准"红线，等人工在 UI/CLI 批准后执行。

---

## 6. 结论：这些问题有没有"修复系统、完善系统"？

**有，但分三层，不能混为一谈：**

| 层次 | 结论 | 证据 |
|---|---|---|
| **产品能力** | ✅ 显著增强：通道（GUI/job/DRC/outline/pour/pins）、目标绑定、三阶段设计门禁、128 规则引擎、自动化内核（配方/批准/读回/审计） | 上文 §3；测试 483+73+26；真机 R1 `completed` |
| **工程制度** | ✅ 明显完善：读回纪律、"超时≠没写"、口径统一（47 条全量）、目标先枚举、"缺证据不算通过"、"AI 不代签写板" | 真机记录 §31/§41/§82；自动化 `needs_approval`/`failed` 语义 |
| **设计闭环** | ⛔ 未完成：衣橱板仍是 DRAFT（DRC 1100、ERC 158、未结输入、DFM/签核未做） | `RELEASE-STATUS-DRAFT.md` |

**一句话**：这个项目**逼着 CircuitPilot 把"能安全操作 EDA + 能拿证据 + 能审计 + 能自动执行"这套底座补了起来**，同时**留下了"设计收敛与放行"这道真正的硬题**。系统不是"被项目修好了"，而是"被项目打了一针，长出了免疫系统和一条生产线；产线还没跑完全程"。

**方法论教训（已写进文档，避免再犯）**：
- 不能用"返回值成功"当成功（`importChanges` / 超时）；
- 不能绕过校验层判断"命令不可用"（Round 9 误判）；
- 每次写操作后必须读回；任何"没有证据"的结论只能是失败；
- 写板批准必须由服务端绑定目标并一次性消费，AI 不能替人签。

---

## 7. 下一步优先级（按解锁下游排序）

1. **人工批准后跑 R2/R6 真机写入验收**（自动化内核已就绪，只差人点批准）。
2. **DRC 一键取证进 UI + 去掉 demo 默认路径**（让"检查与问题"显示真机结果）。
3. **原理图 GUI 连线落地 + ERC 收敛**（`sch_PrimitiveWire.create` 静默无效的根因已定位：文档未真正打开/hidden；`focus + open-current` 已有通道）。
4. **统一三套放行口径 + 价格进闸门**（同一套证据、同一结论）。
5. **持久化 + 前端交接**（项目/需求/计划/终审落盘；计划候选、修复任务、选型批准串起来）。
6. **选型回退序列 + 引脚元数据补强**（降低对人工判断的依赖）。

---

## 8. 证据索引

- 真机全程：`docs/implementation/wardrobe-assistant-design-verification.md`（Round 1–82）
- 执行交接：`docs/implementation/whole-board-progress.md`
- 放行状态：`manufacturing/wardrobe-assistant/RELEASE-STATUS-DRAFT.md`
- 全链路体检：`docs/implementation/current-flow-gap-audit-2026-10-19.md`
- 自动化内核：`docs/implementation/automation-kernel.md`
- 需求对话存证：`docs/implementation/evidence/ai-requirements-dialogue-1.md`
- 任务验收表：`docs/implementation/task-matrix.md`
- 真机自动化证据：`artifacts/automation-phase1-smoke.json`、`artifacts/automation-runs/*.jsonl`、`artifacts/automation-page*.png`
