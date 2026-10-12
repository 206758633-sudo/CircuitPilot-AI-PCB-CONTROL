# 多层 PCB 执行能力实施记录（4/6/8 层）

对应 openspec change：`add-advanced-pcb-engineering-engines` 的后续能力补全。
该 change 交付的是**分析**引擎（叠层/阻抗/HDI 层间图）；本文记录的是让这些分析结果
真正**可执行**的工作，以及 HDI 执行能力的结论与残余。

## 1. 改造前的真实状态（为什么需要这项工作）

| 位置 | 问题 |
| --- | --- |
| `runtime/pcb.mjs:41` | 执行计划硬编码 `board.layers !== 2` 即拒，四层以上根本无法执行 |
| `runtime/production.mjs` | 所有走线固定 `layer: 1`、覆铜只有顶层一次 → 四层板“能分析不能执行” |
| `RULE_PROFILES` | 只有 `jlc-low-cost-2l` 一个档位，四层板只能套用双层档位 |
| `validateSemanticPlan` | 只检查档位存在，不检查档位层数是否匹配；默认工艺值硬取自双层档位 |
| 指标 | `viaCount` 恒为 0、`pourCount` 恒为 1，与实际下发内容不符 |
| 工程模块 | 只有正向阻抗模型，没有目标阻抗→线宽的反解 |

## 2. 交付内容

### 2.1 官方层模型（`runtime/engineering/layers.mjs`）

依据本机安装的官方扩展 API 类型定义
`/Applications/嘉立创EDA(专业版).app/Contents/Resources/app/assets/pro-api/0.3.18.0bc12bb0/api-types.d.ts`
（`enum EPCB_LayerId`、`class PCB_Layer`、`TPCB_LayersOfCopper`）：

- `LAYER_IDS`：TOP=1、BOTTOM=2、丝印3/4、阻焊5/6、板框=11、**内层铜 15..44**
- `copperLayerIds(2|4|6|8|…|32)`：`[1,2]` / `[1,15,16,2]` / `[1,15,16,17,18,2]` /
  `[1,15,16,17,18,19,20,2]` / … / 32 层时内层为 `15..44` 共 30 个
- **执行放行范围已对齐官方能力 `2,4,6,…,32`**：原先只放行 2/4/6/8，是因为当时
  `validateStackup` 只为 4/6/8 定义铜层校验；该前提已消除，故与 EDA 能力一致。
  `EDA_COPPER_LAYER_COUNTS` 与 `PLAN_COPPER_LAYER_COUNTS` 仍是两个独立常量
  （「EDA 能做什么」vs「我们放行什么」），将来若再出现能力差不得合并
- `resolveLayerReference`：受理 `'L1'..'L32'` / `'TOP'` / `'BOTTOM'` / 铜层编号
- `planCopperRoles`：外层信号层、内层交替地/电源平面；叠层可用 `role` 显式声明，
  推导结果带 `source` 标明“声明的”还是“推导的”
- `validateLayerReferences`：校验跨层引用必须落在声明层数的铜层集合内

**必须记住的陷阱**：内层铜层编号**从 15 起**，而 3/4 是丝印、5/6 是阻焊。
把“叠层第 N 层”直接当 `layer` 传给 EDA，四层板的第 2 层（`layer: 3`）会静默画到
**顶层丝印**上 —— DRC 未必拦下，但板子已废。因此本模块禁止任何裸写层号，
`L2` 在四层板上一律换算为 **15**。

### 2.2 制造档位（`jlc-low-cost-2l` + `jlc-4l` … `jlc-32l`，共 16 个）

多层档位的工艺数值**刻意沿用与层数无关的保守下界**，并在 `note` 中写明
“不构成对嘉立创多层板实际能力的声明”。原因：嘉立创EDA 内置的
`'JLCPCB Capability(...)'` 规则配置由云端下发，应用包内没有明文，离线无法核实。
与其编造 `0.09mm` 之类的数字，不如只保留“比板厂更严”的保守约束——保守值只会让
设计更容易制造，不会放宽约束。投产前必须以 `pcb.rules.read` 读到的规则配置或
在线 DFM 复核。

### 2.3 阻抗反解（`runtime/engineering/impedance.mjs`）

`solveMicrostripWidth` / `solveStriplineWidth` / `solveCpwgWidth` / `solveDifferentialWidth`，
只做二分求根、**复用 `stackup.mjs` 同一套正向模型**，因此“解出的线宽”用正向模型
回算必然命中目标。测试里的 round-trip 断言就是守这条：谁若为了“更准”另写一个
近似式，round-trip 会立刻失败。

为此把差分耦合公式抽到 `stackup.mjs` 的 `differentialFromSingleEnded` 作为**唯一**
实现，`highspeed.mjs` 的既有计算改为调用它（行为逐字不变）。

目标不可达时返回 `achievable:false` 与可达区间，**绝不返回一个“看起来像答案”的
线宽**。结合档位最小线宽还能给出“该目标在此工艺下做不出来”的结论。

### 2.4 多层执行路径（`runtime/production.mjs`）

- 内层走线：`net.layer` 显式指定；未指定时焊盘全在底面则布底层，否则顶层
- 内层平面：按叠层角色铺地/电源平面；**没有电源网络就不凭空发明网络名**；
  显式 `constraints.planes` 优先；同层不重复铺铜；平面按层号升序输出便于复核
- 层间转换：焊盘所在层与走线层不同即生成通孔（物理必需，非可选）
- 地平面缝合孔：四角连接顶层地铺铜与内层地平面，可 `groundStitching:false` 关闭
- 指标从真实操作序列统计；`usedLayers` **只统计铜层**（板框在 11 层）

### 2.5 端到端的集成缺口修复

语义阶段原本只凭 `impedance.stackupSource` 一个字符串就放行，而执行阶段
`pcb.mjs` 要求真实叠层数据 —— 结果是四层计划“语义 ready、执行必拒”。
现改为两个阶段共用同一套 `validateStackup` 证据模型：多层必须提供
`constraints.stackup` 数据（铜层厚度、介质厚度与介电常数、板厂来源），且叠层铜层数
须与 `board.layers` 一致，编译结果携带该叠层进入执行计划。

### 2.6 桥接命令（42 → 44）

- `pcb.via.create` 增加第 7 个位置参数 `designRuleBlindViaName`
- 新增 `pcb.layers.setCount`（write，只放行 2,4,…,32 偶数层）、
  `pcb.layers.copperCount`（read）

### 2.7 用 EDA 实际发现的层列表核对（写入前门禁）

`PcbManager.verifyDocumentLayers` 在任何写入之前，用 `pcb.layers.read` **实际返回**的
层列表核对计划要写入的每一层都存在。`getAllLayers()` 返回的 `id` 就是官方
`EPCB_LayerId`，与 `layers.mjs` 换算出的层号同源，因此可以直接比对。

- 文档缺层 → `PCB_LAYER_NOT_IN_DOCUMENT`，**在写入前**拒绝（否则内层操作会失败，
  或更糟：静默不生效，计划显示“已执行”而板子根本没改）
- 核对结果（请求层、可用层、文档铜层数、声明层数）记入执行记录作为复核证据
- 统计铜层时明确排除丝印(3/4)、阻焊(5/6)等非铜层

## 3. 盲埋孔 / 微孔执行能力：结论与残余

**结论：不是被 EDA API 挡住，是我们的桥没透传。**

官方类型定义中盲埋孔是可表达的：

- `PCB_PrimitiveVia.create(net, x, y, holeDiameter, diameter, viaType?, designRuleBlindViaName?, …)`
- 官方注释：`designRuleBlindViaName` —— “盲埋孔设计规则项名称，**定义过孔的开始层与
  结束层**，`null` 表示非盲埋孔”
- `enum EPCB_PrimitiveViaType { VIA = 0, BLIND = 1, SUTURE = 2 }`
- `PCB_Drc.getAllRuleConfigurations(includeSystem?)` / `saveRuleConfiguration(...)`
  可程序化读写设计规则；层数上限 32 层

即：盲埋孔的**跨度不是用层号给的，而是引用板内已存在的“盲埋孔设计规则项”**。

### 残余 1：`viaType` 的取值编码未经真机核实

官方 TS 类型是数字枚举（0/1/2），但运行时的 `api.js` / `api-types.js` 已混淆，
无法离线确认它实际接受数字还是字符串。因此桥**保持原样透传**，不做未经证据的
语义改动；通孔路径刻意不传该参数（用官方默认行为），避免在关键路径上冒险。
`PCB_CAPABILITIES` 已如实标注 `production: false` 并写明这一点。

**需要的证据**：连上 EDA，在测试工程上用两种编码各建一个过孔，看哪种生效。
这需要打开嘉立创EDA 并允许操作一个测试工程。

### 残余 2：没有命令可创建/读取盲埋孔设计规则

`saveRuleConfiguration` 尚未暴露为桥命令，因此“规则项”目前只能由人在 EDA 内建好，
或后续补一条经过校验的命令。

**需要的证据**：官方 `ruleConfiguration` 对象的确切结构（可从
`getAllRuleConfigurations()` 在真机上读出），以及一份可接受的默认盲埋孔规则项样板。

### 残余 3：顺序压合证据

`runtime/engineering/hdi.mjs` 已实现 `validateViaCapabilities` /
`planLayerTransition`（含 `SEQUENTIAL_LAMINATION_EVIDENCE_REQUIRED`），
但真实 HDI 投产还需要板厂的顺序压合能力证据。

**需要的证据**：板厂 HDI（几次压合、微孔跨层上限、激光孔径下限）能力表。

### ~~残余 4：10 层以上未放行~~（已关闭）

`validateStackup` 现已覆盖 `2,4,6,…,32`，执行路径与 EDA 能力对齐，档位补齐到 `jlc-32l`，
层编号换算到 32 层（内层 `15..44`）。已用 10/12/16/24/32 层计划回归验证。

### 残余 5：高级工程报告的层与面模型不完整

`runtime/engineering/engine.mjs` 生成放置操作时写死 `layer:1`，而
`runtime/engineering/layout.mjs` 的放置结果只带 `{ref,w,h,rotation,role}` —— 
**输入 schema 里根本没有“器件在哪一面”这个字段**，所以这条路径无法表达底面贴装。
生产执行路径不受影响（`production.mjs` 的 `padLayerOf` 正确区分底面→2）。
需要把 `side` 加进工程输入 schema、贯通 `layout.mjs` 的放置基对象，再由它推导层号。

### 残余 6：能力清单曾失真（已修复，记录以防复发）

`runtime/engineering/engine.mjs` 的 `engineeringProfiles()` 曾硬写 `layers:[4,6,8]`，
扩容后变成对外撒谎的过期声明。已改为由 `PLAN_COPPER_LAYER_COUNTS` / `RULE_PROFILES`
推导，并加测试锁死“能力清单 == 实际实现”。同类硬编码已全仓库排查（其余为历史说明文字）。

## 4. 未削弱的受控执行属性

多层路径沿用同一套门禁，未做任何放宽：

- AI 只产出结构化计划，不下发可执行 JS
- 人工批准绑定计划哈希 + 目标指纹 + 窗口 + 一次性令牌（叠层数据进入计划哈希）
- 分阶段快照与回滚（`sync|placement|outline|routing|copper|save|validation`）
- 官方 DRC 必需、必须晚于全部改板写入，否则 `PCB_DRC_STALE` 拒绝放行
- 端到端测试用桥的**权限表**断言“DRC 之后不得再出现写命令”，
  将来新增写命令会自动被这条断言拦住

## 5. 验证证据

| 门禁 | 结果 |
| --- | --- |
| `node --test "runtime/**/*.test.mjs"` | 142/142 通过 |
| `npx tsc -b` | 0 错误 |
| `npx vitest run` | 42/42 通过 |
| `npm run test:coverage` | 退出码 0（阈值内） |
| `npx playwright test` | 21/21 通过 |
| `openspec validate --all --strict` | 15/15 VALID |
| `npm audit` | 0 漏洞 |
| `npm run build` | 通过 |

新增回归测试：层模型 8、桥接能力 2、阻抗反解 10、制造档位 11、
多层执行 13（含文档层核对）、四层高速板全流程 4、10–32 层执行 9（含 12 层端到端、
32 层全流程、显式角色控制平面分配、能力清单一致性）、**HTTP 全流程 2**。

`runtime/__tests__/multilayer-design.test.mjs` 是核心验证目标之一：一块
USB（90Ω 差分，外层微带）+ SPI 时钟（内层 L2）的四层高速板，
线宽由阻抗反解算出并真正写进计划、下发到 EDA，官方 DRC 通过后放行。

`runtime/__tests__/multilayer-http.test.mjs` 提供**最强的离线全流程证据**：
不直接调库函数，而是起一个真实运行时 HTTP 服务，通过产品真实接口走完
`POST /api/production/plans/compile` → `GET /api/pcb/context` → `POST /api/pcb/approve`
→ `POST /api/pcb/execute`，用一块 12 层板验证：

- 12 层语义计划经 HTTP 编译为可执行计划，官方 DRC 是最后一个操作
- 伪造批准令牌 → 拒绝，且**一条改板写入都没有发生**
- 批准令牌一次性：重复执行被拒
- 批准绑定计划内容：拿着有效令牌但换一块板 → 拒绝
- 内层走线（L4）以 17 层真正下发
- 官方 DRC 晚于全部改板写入
- 能力清单接口如实报告 2..32 层与 `jlc-32l` 档位

除 EDA 本体（无人值守环境无法驱动其界面，故替换为忠实记录命令的假桥）之外，
全部走产品真实代码路径。

## 6. 尚未完成

- 真实嘉立创EDA 在线跑通（需人工打开 EDA 并登录）。当前证据为：
  进程内真实执行路径 + HTTP 层真实全流程（编译→批准→执行）+ 忠实假桥
- 盲埋孔真机确认（见残余 1、2）
- 高级工程报告的“器件在哪一面”模型（见残余 5）
