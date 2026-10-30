# 原理图落网运行状态（netflag 通道实测）

> 日期：2026-10-19　｜　执行：Agent（CircuitPilot bridge + EDA Pro）　｜　状态：**412/412 计划条目全部回读验证通过**
> 纪律：调用没报错 ≠ 改成功；以下数字均为导出 `.enet` 的 `pinInfoMap` 回读实测。

## 1. 数据源（三通道交叉）

| 来源 | 文件 | 内容 |
|---|---|---|
| 参考原理图 PDF 矢量重建 | `/tmp/ref_nets_full.json` | 131 网 / 446 引脚（61 具名 + 70 个 N$）；U1 41 脚与文本层 31/31 一致 |
| 整板网络计划 | `/tmp/net_plan_v2.json` | 412 entries + 168 gaps（580 脚全覆盖）；90 网；basis：reference 358 / engineering-judgement 52 / requirement 2 |
| 计划说明 | `docs/implementation/netlist/net-plan-gaps.md` | 168 gap 逐条 + 人工输入 I-01..I-14 |
| 参考网表提取说明 | `docs/implementation/netlist/ref-net-extraction.md` | 两轮方法/覆盖率/未判定逐条 |
| PCB 现有落网（启发式，Round 67） | `/tmp/pcb_netlist.json` | 180 器件 / 599 焊盘 / 505 有网 / 60 网（**不作真源**，与参考设计不一致） |

## 2. 写入通道（已验证）

- 写入：`eda.sch_PrimitiveComponent.createNetFlag('Power'|'Ground'|..., net, x, y)`，x/y = 引脚坐标（`sch_PrimitiveComponent.getAllPinsByPrimitiveId` 实测坐标，与 `.enet` 引脚 net 绑定一致）。
- 幂等：按 `(net, x, y)` 去重已有 netflag；分块（4~5 个/次）创建以规避单次执行超时（本机实测：一次建 8~10 个会触发 `EasyEDA execution timed out`）。
- 保存：`eda.sch_Document.save()` → true。
- 回读：`sch_ManufactureData.getNetlistFile()` → `.enet` → `components[*].pinInfoMap[*].net`（带 netflag 后导出 2~3s，曾一度 42s，随后恢复）。

## 3. 最终实测结果（2026-10-19 11:40）

| 指标 | 数值 |
|---|---|
| 原理图器件 | 178（+2 缺失：U3/U15，见 §6） |
| netflag 组件 | **412（= 计划条目数，一 flag 一条，无重复/无缺漏）** |
| 导出网表：有网引脚 | **419** |
| 导出网表：网络数 | **92** |
| **计划 412 条回读一致** | **412（100%）** |
| 未收敛 | **0** |

### 3.1 收敛过程（两轮修复）
1. **第一轮（批量落网）**：412 条 → 回读 388 条（94.2%），24 条异常。
2. **第二轮（三处根因修复）**：
   - 删除 19 个错位/重复 flag（含落在 C11.1 坐标上的 +5V 错位 flag、各网重复 flag）；
   - 把 4 个与 IC/同组电阻**坐标完全叠放**的器件移开：C74→(300,1500)、C53→(600,1500)、R13→(900,1500)、R14→(1200,1500)；
   - 删除这些器件旧坐标 flag（7 个）并按新引脚坐标重落（8 个），补建 4 条缺失 flag（C8.1/C85.2 GND、Q1.4/U4.4 DTR）。
3. **第三轮（清尾）**：删除 1 个重复 GND flag；最终 **412 flags ↔ 412 plan entries 一一对应**，导出回读 **412/412**。

### 3.2 已收敛网络（92 网，含以下重点）
GND(118 脚)、3V3(32)、+5V、VOUT、VBUS、VBAT、1V5、2V8、AVDD_2V8、ADC_3V3、CODEC_3V3、CODEC_OUTP/K、CODEC_OUTN/K、全部 DVP 12 路（IO3–IO9/16/17/18/46）、I2S 5 路（IO12/13/14/38/45）、I2C（IO1/IO2）、USB（IO19/IO20、CH340_D±、USB_D±、CC1/CC2）、UART0（U0TXD/RXD）、RESET、IO0_BOOT、AUTO_DL_B1/B2、DTR、RTS、TOUCH10、BAT_SAMPLE、MIC 链路（MIC_VDD/ADC_MIC*/MIC1_OUT）、AMP_*、SPK±、MOTOR、PA_EN、DVP_PWDN、WS2812 链（DIN/D1–D4）、SY_*（SY_LX/SY_BS/SY_EN/SY_FB）、AMP_VCC、XI/XO 等。

### 3.3 落网后器件坐标变更记录（原理图）
| 器件 | 原坐标（叠放） | 新坐标 |
|---|---|---|
| C74 | (235,515)，pin1 与 U1.14 重合 | (300,1500) |
| C53 | (1015,515)，pin1 与 U8.21 重合 | (600,1500) |
| R13 | (1200,420)，与 R3/R14 完全重合 | (900,1500) |
| R14 | (1200,420)，与 R3/R13 完全重合 | (1200,1500) |

## 4. 产物

| 文件 | 说明 |
|---|---|
| `docs/implementation/netlist/net-plan-v2.json` | 最终网络计划（412 entries + 90 nets + 168 gaps），已回写 C74/C53/R13/R14 新坐标 |
| `docs/implementation/netlist/enet-final-verified.enet` | 落网后导出的网表（412/412 验证用的原件，428,130 B） |
| `/tmp/net_plan_v2.json`、`/tmp/enet_final.enet` | 同上工作副本 |
| `/tmp/flags_now.json` | 412 个 netflag 全量快照（net,x,y,id） |

## 5. 技术要点（后续复用）

- `createNetFlag(type, net, x, y)` 落在**引脚坐标**即可绑定引脚；导出 `.enet` 的 `pinInfoMap` 是唯一可靠回读（`sch_Net` 系列 API 返回空）。
- 单次 in-page 批量创建 ≥8 个 flag 会触发 `EasyEDA execution timed out`；**每批 3~5 个**、每批后回读增量最稳。
- **同坐标两个不同网的 flag / 器件引脚完全叠放 ⇒ EDA 合并网络并产生错名**（曾导致 2V8→+5V、CODEC_OUTP→AVDD_2V8、DTR/RTS→GND 等 15 条串扰）。落网前必须先保证器件不叠放。
- 原理图重构遗留的 9 组叠放器件已处理 4 组（影响落网的）；剩余 LED3/R2、LED4/U1.2、R38/R71 只影响未定网（gap），不影响 412 条验证结果。
- 保存用 `eda.sch_Document.save()`；导出用 `sch_ManufactureData.getNetlistFile()`（带 412 flags 时约 3~40 s）。

## 6. 硬阻塞（与落网无关但影响整板放行）

1. **原理图缺 U3（SY8301ABC）、U15（ME6211C15M5G-N）**：PCB 有（U3 6 焊盘、U15 5 焊盘，均未落网）、BOM 有、原理图无。补入需先确定二者输出轨（U3 6 脚 SY8301 是第二路 DC-DC；U15 是第 3 片 ME6211）——属**工程决策**，已登记为待人工输入（I-15/I-16），未擅自猜测。
2. **PCB Q16（SI2305）0 焊盘**：需重摆封装/重新放置。
3. **168 个 gap**：音频模拟前端 RC、指示 LED 与 ETA9880 状态、3P 接口线序、CH334F 配置电阻、安装脚、V2.0 新增器件等，逐条见 `net-plan-gaps.md`（含 I-01..I-16 人工输入项）。
4. **PCB 尚未 importChanges**：当前 PCB 仍为旧的 60 网启发式状态（基线 1232 线/113 过孔/599 焊盘/180 器件/2 铺铜，未破坏）；等 U3/U15 补入且 gap 决策后同步，再自动布线 → DRC → ERC → 制造包。

## 7. V2.0 未接器件实测（PCB 铜箔连通性分析，2026-10-19）

用 `pcb_PrimitiveComponent.getAllPinsByPrimitiveId` + `pcb_PrimitiveLine.getAll()`（1232 段）+ 过孔做端点并查集，实测：

- **U3（SY8301ABC，SOT-23-6）**：6 个焊盘**各自孤立**（无走线），仅 pad1/pad6 带历史启发式网名 `N_SW`；即 V2.0 新增的第二路 DC-DC 尚未接线。
- **U15（ME6211C15M5G-N，SOT-23-5）**：5 个焊盘**全部孤立**、无网名；第三片 LDO 未接线。
- **Q16（SI2305）**：`getAllPinsByPrimitiveId` 返回 **0 个焊盘**（封装 `SOT-23-3` 已挂但无 pad 几何），即"有器件无焊盘"。
- 参照 U6（同型号 SY8301ABC）焊盘网：pin2=GND 等，可用于补 U3 时的引脚映射（SY8301：1=BS、2=GND、3=FB、4=EN、5=VIN、6=LX）。
- ME6211C15（SOT-23-5）典型：1=VIN、2=GND、3=CE、4=NC/BP、5=VOUT（以数据手册为准）。

结论：**U3/U15 的输入/输出轨属 V2.0 未定设计**，参考 PDF 的 U3 是另一版本位号（MOTOR 接插件），不可迁移；需设计侧给出两片器件各自"输入轨 / 输出轨 / EN 连接"，才能补入原理图并落网。
