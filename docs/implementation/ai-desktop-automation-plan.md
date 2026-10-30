# CircuitPilot 全 AI 自动化方案：API 优先 + 桌面控制兜底

- 撰写时间：2026-10-19
- 回答的问题：能不能用 CircuitPilot 的 AI 把所有链路自动跑完？嘉立创EDA 没有的 API，能不能让 CircuitPilot 通过"电脑桌面操作"（受信任鼠标键盘）替用户完成？
- 结论：**能，但不是"让 AI 自由点鼠标"，而是"AI 决策 + 确定性配方 + 双通道执行 + 每步读回验证 + 人工守闸"**。完全无人值守到"下单/支付"不建议也不安全，属于产品红线。

---

## 0. 能做到什么程度（三档，先对齐预期）

| 档 | 范围 | 是否建议 | 说明 |
|---|---|---|---|
| A. 全自动闭环（推荐目标） | 需求 → 选型 → 原理图 → PCB → 布局/布线 → 铺铜/DRC → 3D → 制造包 | ✅ 做 | 用户只保留 3 次人工批准（计划、写板、放行）；失败自动停/回退，绝不假通过 |
| B. 全自动下单/支付 | 嘉立创下单、付款 | ❌ 不做 | 涉及资金与不可逆操作，只生成"下单参数卡 + 人工点击"；系统现有 `order.status='disabled'` 是正确设计 |
| C. 无边界通用 computer-use agent | AI 自由截图点鼠标、任意 `eval` | ❌ 不做 | GUI 通道能点任何东西（含删除工程、退出、支付）；`eval` 是任意 JS 后门。必须收敛为白名单配方 |

本方案只承诺 A 档；B/C 明确排除。

---

## 1. 现有基建盘点（不是从零开始）

| 能力 | 状态 | 证据 |
|---|---|---|
| 受控写入：审批(planHash+一次性令牌) → 快照 → 写入 → 回读 → DRC → 失败回滚 | **[真机]** | `runtime/design.mjs`、`runtime/pcb.mjs`；UI 五步流程 `EdaPage.tsx` |
| 桥接 API：69 条 `eda.*` 只读/写命令 | **[真机]** | `runtime/bridge.mjs`（权限分级 read / write / write-beta） |
| GUI 通道（CDP 受信任输入）：15 个白名单动作 | **[真机部分]** | `runtime/eda-gui.mjs:23`；`state/click/dblclick/drag/move/type/key/shortcut/eval/screenshot/clickText/waitText/launch/targets/focus`；`runtime/__tests__/eda-gui.test.mjs` 18/18 |
| GUI 真机已验证动作 | **[真机]** | 快捷键 Cmd+A/Cmd+Z/Cmd+S（间距矩阵 52 格批量改、撤销回退）；缩放输入框 38%→400%；`focus` 把 `hidden` 页面拉回 `visible` 后 PCB 画布点击成功选中；菜单/对话框点击；启动 EDA（剥 `ELECTRON_RUN_AS_NODE`）；`screenshot` 返回 PNG |
| 根因已修 | **[真机]** | 页面 hidden 导致画布输入失效（`focus` 动作）；文档未真正打开导致 `sch_*` 全部"API 坏"（§82）；`openProject/openDocument` 返回 false 需从工程树双击 |
| 真机全链路只读脚本 | **[真机]** 15/15 | `scripts/e2e-live.mjs`（需求→选型→原理图验收→布局校验→布线校验→DRC→就绪→导出→3D→产物自检） |
| 每步产出的证据 | **[代码]** | bridge 命令回读、DRC 报告、manifest sha256、STEP 字节、网表 sha256 |

**已有的逃生舱**：GUI 通道挂在 runtime 上（不是外部脚本直连 CDP），有动作白名单、超时、会话自愈；`eda-gui.test.mjs` 覆盖参数校验。

---

## 2. 距离"全 AI 自动"还缺什么（按重要性）

| # | 缺口 | 现状 | 影响 |
|---|---|---|---|
| 1 | **没有工具调用循环** | `chat.mjs:157` 系统提示明确"不得调用工具"；AI 只出文本/JSON 计划，运行时事后补证据 | AI 无法"看一步、做一步、验一步"，只能一次性出计划；出错不会自己修 |
| 2 | **没有统一工具总线** | bridge(69 命令)、GUI(15 动作)、工程/生产能力散在各路由；权限分级没建模成 AI 可调用的 schema | AI 不知道"自己能做什么"，也没有参数校验/危险等级 |
| 3 | **GUI 动作没有后置验证契约** | `click` 返回 `{clicked:true}`；`type` 返回 `{typed:n}` | "点了但没生效"无法发现（这是 GUI 自动化最大的假阳性来源） |
| 4 | **感知硬编码、无视觉** | `state()` 里写死"智能衣橱助手"、`/#id=/`、固定文本；`screenshot` 只回 base64，没有视觉模型接入 | 换工程/换语言/换版本即失效；无法处理"弹窗/登录/布局变化" |
| 5 | **无配方/工作流状态机** | 每步是页面按钮里的内联 async 函数；刷新即丢，失败无重试策略 | 长流程（布线 45 分钟、铺铜重建）跨小时无法续跑 |
| 6 | **无 GUI 安全边界** | 白名单外还有 `eval`（任意 JS）、无"窗口锁定/危险动作清单/每步截图审计"；`GUI_ACTIONS` 未区分读/写/破坏性 | 一旦被 AI 或误操作驱动，可能删工程/退出/误点支付 |
| 7 | **无入口、无持久化** | `/api/eda/gui/*` 无 frontend 调用；计划/终审/配方进度只在内存 | 用户看不到、断了不能续 |
| 8 | **真机 e2e 陈旧** | `placement-live` 仍用 `nav-placement` 与旧标题断言 | 真机回归无法自动跑，改动靠人工 |

---

## 3. 推荐架构（五层）

```
┌──────────────────────────────────────────────────────────────┐
│ L1 AI 决策层（LLM）                                          │
│ 只输出受限 JSON：{recipe, params, assumptions, stopIf}       │
│ 禁止输出自由坐标点击 / eval / 脚本；只做选择、参数、失败诊断   │
└───────────────▲──────────────────────────────────────────────┘
                │ 计划 + 诊断（每次可回溯到证据）
┌───────────────┴──────────────────────────────────────────────┐
│ L2 配方引擎（确定性）                                         │
│ recipe = 步骤序列：action + expect(读回断言) + onFail(重试/    │
│ focus/回退/停机) + evidence(截图+读数哈希)；可断点续跑        │
└───────────────▲──────────────────────────────────────────────┘
                │
┌───────────────┴──────────────────────────────────────────────┐
│ L3 执行器（API 优先，GUI 兜底，人工最后）                      │
│ ApiExecutor(bridge 69 命令) > GuiExecutor(CDP 15 动作) >      │
│ HumanExecutor(暂停并请人确认)                                 │
└───────────────▲──────────────────────────────────────────────┘
                │
┌───────────────┴──────────────────────────────────────────────┐
│ L4 验证层                                                     │
│ 每步后用**只读 API** 读回：器件数/网络数/DRC 条数/铜皮数/      │
│ 文件字节/哈希/网表 pinInfoMap；与 expect 比对，不符即失败      │
└───────────────▲──────────────────────────────────────────────┘
                │
┌───────────────┴──────────────────────────────────────────────┐
│ L5 安全与审计                                                 │
│ 窗口锁定(仅 EDA bundle)、危险动作黑名单(支付/删除/退出/另存)、 │
│ 写入门禁、每步截图+读回写入 journal（哈希链）、配额与超时      │
└──────────────────────────────────────────────────────────────┘
```

**关键原则**：AI 不直接"看像素点坐标"；它选择已登记配方并填写参数。GUI 配方内部才允许点击，且每次点击前后都必须有读回证据（DOM 状态或 bridge 读数）。这既保留"桌面控制"的兜底能力，又避免不可复现的坐标漂移。

---

## 4. 需要落地的配方清单（这就是"打通"的具体物）

| 配方 | 为什么必须做 | 通道 | 成功判据（可复核读数） |
|---|---|---|---|
| R1 open-project-document | `openProject/openDocument` 返回 false；必须从工程树双击 | GUI | `tabs` 出现 `PCB1`/`Schematic1_1`；`bridge document.current` 类型正确 |
| R2 import-schematic-to-pcb | 公开 API **不能新增 PCB 器件**，只能走菜单"设计→更新/转换原理图到PCB" | GUI | `sync/verify` diff 清零；PCB 器件数 = 原理图 designators 数 |
| R3 schematic-net-connect | 建网/引脚赋网 | API（netFlag/wire）+ 回读 | `.enet` 的 `pinInfoMap[pin].net` 等于目标网名；删除后复原 |
| R4 placement-auto | 按板框自动排布/微调 | API（plan/apply）+ 回读 | 全体在板框内、courtyard 无重叠、间距矩阵通过 |
| R5 routing | 自动布线 + 间距复核 | API（plan/apply，默认 dryRun） | 断网 0、间距违规 0、差分等长；回读铜几何条数一致率 |
| R6 pour-rebuild | `pcb_PrimitivePour.create` 实测不可用；铺铜填充必须重建 | GUI（工具→铺铜管理器→重建所有） | 铜皮数 ≥ 期望；重建后 DRC 条数下降；`focus` 前置 |
| R7 drc-run | DRC 取证 | API（start/report）→ 落盘 | 报告 items 可归类、豁免合法、unexplained=0 |
| R8 export-manufacturing | 制造包 | API（门禁→导出） | 文件字节/sha256/manifest；Gerber 层数、BOM 位号、CPL 坐标、STEP 头 |
| R9 online-dfm（人工） | 无 API | Human | 上传结果截图 + 结论回填为证据 |
| R10 order（人工） | 政策红线 | Human | 只出参数卡；支付永远人工 |

**每块配方都要求**：前置条件、步骤、每步 expect、失败恢复、证据落盘、真机验收记录。配方是版本化 JSON/MJS，随代码走。

---

## 5. 分阶段实施与验收

### Phase 0：自动化内核（1–2 天）✅ 已完成（2026-10-19）
- 已新增 `runtime/automation/`：`safety.mjs`（动作分级/`eval` 默认禁用/危险文案与快捷键/目标锁定/批准）、`verify.mjs`（读回断言）、`journal.mjs`（哈希链审计）、`recipes.mjs`（配方 schema fail-closed 校验 + 4 条只读内置配方）、`runner.mjs`（状态机/重试/回退/`needs_approval`）、`executors.mjs`（api/gui/human 三通道）。
- 已接入运行时：`GET /api/automation/recipes`、`POST /api/automation/run`、`GET /api/automation/runs/:runId`；`runtimeClient` 增加三个方法。
- 单测 + HTTP 契约测试：**19 条全绿**（含"读回不符绝不返回成功""缺批准 0 步执行""journal 写失败整个 run 失败""路径穿越 400"）。
- 真机冒烟（真实 EDA CDP）：读取页面状态与截图证据均为 `completed`；未开工程时如实 `failed`（读回无 `data`），无假通过。
- 详见 [`automation-kernel.md`](./automation-kernel.md)。
- 原计划中的"断点续跑/动作分级 assert 接口"顺延到 Phase 1（journal 已按 run 分文件，结构上支持）。

### Phase 1：API 补不了的洞（3–5 天）🟡 内核与 R1 已完成（2026-10-19）
- ✅ 内核扩展：必填参数（`needs_params`）、`compose` 多路读回、`fallback.actions` GUI 兜底、跨路径断言（`atLeastPath` 等）。
- ✅ **服务端一次性批准**：`POST /api/automation/approvals` 在真实 EDA 上绑定"窗口+工程+文档"指纹，30 分钟 TTL，运行时必须携带 `approvalIds`；换板/复用 → 409。签发/消费都进哈希链。
- ✅ 写入配方 **R1/R2/R6** 已登记：R1 `project.open` → compose 读回；R2 `pcb.importChanges` → 两侧器件数对比，失败兜底"设计→更新/转换原理图到 PCB"；R6 `pcb.pour.rebuild` → 铺铜图元读回，失败兜底"工具→铺铜管理器→重建所有"。
- ✅ 自动化 UI 页 `#automation`（配方/参数/签发批准/运行/失败诊断/哈希链审计）+ CLI `scripts/automation-run.mjs`。
- ✅ **真机验收（R1）**：真实嘉立创EDA 上带 write 批准跑 `eda-open-project` → `completed`；不带批准 0 步执行；错误配方/复用批准 409。R2/R6 未在真实板子上执行写操作——按红线留待人工批准后验收。
- ⏳ 待人工批准后完成：R2/R6 真实写入验收（器件数逐 designator diff、DRC 条数下降证据）。
- 详见 [`automation-kernel.md`](./automation-kernel.md)。

### Phase 2：设计主链接入（3–5 天）
- R3/R4/R5 接 UI（布线目前 0 入口）；AI 只做配方选择与失败诊断（不做自由点击）。
- 统一"写入门禁"：单个计划一次批准 → 配方内所有写步骤继承批准，但破坏性动作仍需二次确认。
- 验收：从"绑定工程"到"DRC 报告"一键执行，人工只批 1 次；失败自动停并给出诊断证据。

### Phase 3：放行与交付（3–5 天）
- R7/R8 接线 + 统一放行口径（release-gate / readiness / export 合并）；持久化配方进度、终审、DRC 证据。
- 验收：一键产出制造包 + 3D + 报告；刷新/重启后可续跑；概览显示真实状态。

### Phase 4：无人值守演练（2–3 天）
- 在"只读板"和"目标板"各跑 3 次全链路；注入失败（关窗口、断桥、改缩放、弹登录框）验证恢复与停机。
- 验收标准：**同一块板，从空工程到 DRC=0 + 制造包 + 3D，一键完成；人工只做 3 次批准；任何失败都能回退到操作前快照并留下证据；全程无"假通过"。**

---

## 6. 风险与不可自动化边界

| 风险 | 严重度 | 缓解 |
|---|---|---|
| GUI 坐标/缩放/语言/版本漂移 | 高 | 一律先 `state`/`screenshot` 确认，再点击；点击后读回断言；不做盲点 |
| 弹窗/登录态/云端同步延迟 | 高 | 配方内显式 `waitText` + 超时 + 人工兜底；登录永远人工 |
| EDA 升级导致菜单变化 | 中 | 配方版本化 + 失败即停 + 诊断截图；不静默重试 |
| 页面 hidden 节流 | 中 | 每步前 `focus`；已在 §58 验证 |
| 误触破坏性动作 | 高 | 危险动作黑名单（支付/删除工程/退出/覆盖保存）；窗口锁定；写入门禁 |
| `eval` 后门 | 高 | 默认关闭，需显式 `CIRCUITPILOT_GUI_DEBUG=1`；审计日志强制记录 |
| 在线 DFM/下单/支付 | — | 人工，只回填证据 |
| 真机环境不可自动化测试 | 中 | 配方单测用假通道；真机验收脚本 + 记录快照；CI 里 skip 但如实标记 |

**不可承诺**：7×24 无人值守、自动付款、跨 EDA 版本零维护。这三条应该写进产品预期。

---

## 7. 结论

- "CircuitPilot 通过桌面控制替用户操作嘉立创EDA"**技术上已经有一半基建**：CDP 受信任输入通道、动作白名单、focus 修复、draw/type/shortcut/screenshot 都真机验证过；缺的是**配方化 + 每步验证 + 安全审计 + AI 工具总线**。
- 做到 A 档（全链路自动，人工只批 3 次）**可行**，按上面 4 个阶段约 **2–3 周**（单人 + 真机验收）；先做 Phase 0+1 就能看到"自动打开工程→自动同步到 PCB→自动重建铺铜"的实机效果。
- B/C 档（自动下单、无边界 computer-use）**不做**，这是安全与资金红线，也是现有系统的正确设计。

## 8. 下一步

Phase 0 + Phase 1 内核已完成。下一步：

1. **人工批准后的真机写入验收**：在 UI 点"签发写板批准"，或运行
   `node scripts/automation-run.mjs pcb-rebuild-pours --approve` / `pcb-sync-from-schematic --approve`，
   把 R2/R6 的真机结果补进 `automation-kernel.md` 的验收表；
2. **Phase 2**：R3 网络连接 / R4 布局 / R5 布线接入 UI，AI 只选配方与诊断；
   计划批准（plan）绑定 `planHash`，实现"一次计划批准 → 配方内写步骤继承、破坏性动作二次确认"；
3. **Phase 3**：R7/R8 接线 + 统一放行口径（release-gate / readiness / export 合并）+ 持久化 + DRC 证据入库；
4. **Phase 4**：只读板/目标板各 3 次全链路演练，注入失败验证停机与恢复。
