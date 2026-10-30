# 参考工程 vs CircuitPilot 设计板：差异检验报告

- 检验时间：2026-10-21 20:4x（Asia/Shanghai）
- 参考对象：`测试板文件/ProDoc_衣橱助手V2.0_2026-10-16.epro2`（嘉立创EDA专业版工程包，工程名 **衣橱助手V2.0**，1 块 PCB `5d632dde4548e1a0`，4 层）
- 被检对象：CircuitPilot 工程 `ba4924190e3a4388a097f3dee090da20`（**衣橱助手V2.0-AI设计**）中唯一有实际内容的板 **Board1_1 / PCB3 `5595e77cead09682`**（另两个 Board 为空板，见 §3）
- 方法：参考文件离线解析（EPRO = zip(project2.json + .epru 文档行)，脚本 `artifacts/reference-epro2/parse-reference.py` 可复跑）；当前板通过 EasyEDA Bridge **只读**命令读取（`pcb.placement.read` / `pcb.copper.read` / `pcb.nets.read` / `pcb.pours.detail` / `pcb.layers.read` / `pcb.rules.read` / `schematic.netlist.export`），只做文档激活导航，**无任何写操作**。
- 原始证据：`artifacts/reference-epro2/`（reference-parsed.json、current-board-read-2026-10-21.json、current-board1_1-netlist.json、diff-summary.json）。

## 0. 结论摘要

1. **不是同一块板**：参考板是"完整设计 + 已布线 + DRC 0 违规"的量产状态（179 器件、127 网络、963 段走线、609 过孔、13 块铺铜），CircuitPilot 板是"简化重设计 + 未完成"的中间状态（64 器件、34 网络、345 段走线、51 过孔、4 块孤立 GND 铺铜）。
2. **BOM 只有 58 个位号相同，且这 58 个全部是不同料号**（51 个值也不同）；参考板独有 122 个位号（67 个电容、26 个电阻、10 个 LED、10 个 IC…），CircuitPilot 独有 6 个（MK1、R17、R21–R24）。
3. **网络体系不同**：参考板是 ESP32-S3 + CH340K(UART) + CH334F(USB HUB) + ETA9880(充电) + ME6211 LDO + ES8311(codec) + ES7210(ADC) + NS4150B(功放) + WS2812B×5 + 10 颗 LED；CircuitPilot 改为 IP2312 充电 + MT3608/SY8089 电源 + ES7210 + NS4168，无 USB-UART/HUB、无 codec、无 LED 器件。两板只有 GND/VBUS/+5V 三条网络名重合（GND 在 CircuitPilot 板还是空网络）。
4. **板尺寸不同**：参考板按铜几何反推约 **81.6×61.8mm**（异形轮廓、多段圆弧）；CircuitPilot 板框 **56.32×62.10mm**（矩形）。高度一致（~62mm），**宽度差约 25mm**。
5. **当前板存在上电级问题**：GND 网络 0 焊盘/0 走线/0 过孔、4 块 GND 铺铜电气孤岛；官方网表把 10 个 GND 引脚归到 +3V3（详见 T3/T4 报告）。**修复前禁止上电**。
6. 参考板在仓库里留有一份 **0 违规 DRC 证据**（`artifacts/evidence/drc-report/drc-report-2026-10-20T15-22-46-358Z-aff12a180172.json`，pcbUuid=`5d632dde4548e1a0`）；当前板 `5595e77c…` **没有**绑定自身的 DRC 证据。

## 1. 工程结构差异

| 项 | 参考工程 | CircuitPilot 工程 |
|---|---|---|
| 工程/板 | 1 个 Board、1 块 PCB（`5d632dde…`） | 3 个 Board：Board1/PCB2 `ffedea82…`（2 层、0 器件）、**Board1_1/PCB3 `5595e77c…`（4 层、64 器件，唯一有内容）**、Board1_2/PCB4 `1a5ab2c2…`（2 层、0 器件） |
| 原理图 | 2 页：P1（103 个器件）、P2（77 个器件） | Board1_1 2 页（P1/P2，网表合计 **64 个器件**）；另两个 Board 的页面为空 |
| 原理图→PCB | 180 个位号中 179 个落到 PCB（U3=MX1.25 3P 连接器只有符号，无 PCB 封装） | 64/64 全部落 PCB |
| 板框尺寸 | 铜/过孔几何范围 **102.60–184.15 × 9.75–71.54 mm（≈81.6×61.8）**；轮廓由多段圆弧/样条构成，非矩形 | 板框 **56.32×62.10 mm**；器件铺开范围 44.0×56.4mm |
| 层数 | 4 层（Top/Bottom/Inner1/Inner2） | 4 层（同层结构）；两个空板是 2 层 |
| 规则/叠层 | RULE_TEMPLATE `自定义配置`；PREFERENCE `JLC04161H-7628`（嘉立创 4 层叠层） | 规则名 `JLCPCB Capability(Two Layers Board)`（**4 层板却套"两层板"规则名，名不副实**） |

## 2. 器件与 BOM 差异

| 指标 | 参考板 | CircuitPilot Board1_1 |
|---|---|---|
| 原理图器件位号 | **180** | **64** |
| PCB 器件 | **179**（U3 仅符号） | **64** |
| BOM 行（有位号） | 180 | 64 |
| 有供应商料号 | 180/180 | 64/64 |
| 有 3D 模型 | 53/180（29%） | 64/64（100%） |
| 与对方相同位号 | — | **58**（其中 7 个值相同、51 个值不同；58 个全部料号不同） |
| 参考板独有位号 | **122** | — |
| CircuitPilot 独有位号 | — | **6**：MK1、R17、R21、R22、R23、R24 |

参考板独有 122 个位号按类型：**C 67、R 26、LED 10、U 10、D 3、Q 2、SW 2、MIC 1、X 1**（U 为 U7/U9–U12/U14/U16–U18/U20；LED 为 LED1–LED10；D 为 D11–D13 的 ESD 阵列；Q 为 Q2/Q16；SW 为 SW1/SW3；MIC 为 MIC1；X 为 12MHz 晶振）。

同号器件举例（参考 → CircuitPilot）：
- C10 22uF → 10uF；C11 100nF → 10uF；C13 100nF → 22nF；C15 22uF → 22nF；C19 100nF → 22pF；C3/C4 22uF → 10uF
- R4/R6 1kΩ → 10kΩ；R7/R8 91kΩ → 10kΩ；R9 287kΩ → 10kΩ；R11/R12 5.1kΩ → 33Ω；R19 100Ω → 5.1kΩ
- L1 4.7uH → 22uH；U1 ESP32-S3-WROOM-1-N16R8 → N16R16V；USB1/CN1/CN5/J7 同型号

### 功能块对照（差异的实质）

| 功能 | 参考板 | CircuitPilot 板 |
|---|---|---|
| 主控 | ESP32-S3-WROOM-1-N16R8 | ESP32-S3-WROOM-1-N16R16V（Flash/PSRAM 容量不同） |
| USB-UART | CH340K | **无** |
| USB HUB | CH334F | **无** |
| 充电/电源 | ETA9880E8A + SY8301ABC + ME6211C28M5G-N + ME6211C15M5G-N | IP2312 + MT3608 + SY8089AAAC（架构不同） |
| 音频 codec | ES8311 | **无** |
| 麦克风 ADC | ES7210 | ES7210（相同） |
| 功放 | NS4150B | NS4168（不同） |
| 麦克风 | ZTS6216（MIC1） | LMA2718B381（MK1） |
| 指示灯 | WS2812B-2020 ×5 + 普通 LED ×5（共 10） | **无 LED 器件**（只有 R21–R25 预留限流电阻） |
| 摄像头 | 24P FPC（HX 0.5-24PIN） | 24P FPC（U8） |
| 按键 | SW1/SW3 | **无** |
| 晶振 | 12MHz X1 | **无**（依赖模块内部） |
| ESD | RCLAMP0521T ×3 | SMAJ5.0CA TVS ×1 + SS34 |
| 连接器 | SH1.0×4、GH1.25、ZH1.5、J7、Type-C | SH1.0、GH1.25、ZH1.5、J7、Type-C（部分相同位号） |

## 3. 网络（Net）差异

| 指标 | 参考板 | CircuitPilot Board1_1 |
|---|---|---|
| 网络总数 | 127（65 个命名 + 62 个自动 `$…`） | 原理图 34 个命名；PCB 35 个（多出的 GND 是空网络） |
| 命名风格 | `3V3 / 5V0 / GND / AU_GND / GND0 / AGND / USB_D± / IO19_USB_D- / CH340_D± / IO15_DVP_D4 / IO12_I2S_DI / ADC_* / BUTTON / LED / LOCK / MOTOR / RESET / IO0_BOOT …`（ESP32 引脚功能命名） | `+3V3 / +5V / VBUS / VBAT / CAM_1..24 / I2S_BCLK/LRCLK/SDATA/SDOUT / MIC_OUT / AMP_CTRL`（自定义命名） |
| 两板共同命名网络 | — | **仅 3 条：GND、VBUS、+5V**（且 GND 在 CircuitPilot 板是空网络） |
| 参考板独有命名网络 | **62 条**（USB_D±、CH340_D±、DVP 总线、I2S 全组、ADC_*、GND/AU_GND/GND0/AGND、LED/LOCK/MOTOR/BUTTON/TOUCH…） | — |
| CircuitPilot 独有命名网络 | — | **32 条**（CAM_1..24、I2S_*、MIC_OUT、AMP_CTRL、+3V3、VBAT） |
| GND 状态 | GND 103 个焊盘 + GND0 20 个 + 4 层 GND 铺铜，实际连通 | **GND 网络存在但 0 焊盘/0 走线/0 过孔**；4 块 GND 铺铜为电气孤岛；网表把 10 个 GND 引脚归到 +3V3（疑似地-电源短接） |

## 4. PCB 实现差异

| 指标 | 参考板 | CircuitPilot Board1_1 |
|---|---|---|
| 铜层 | 4（Top/Bottom/Inner1/Inner2） | 4（相同层号 1/2/15/16） |
| 器件 | 179 | 64 |
| 走线 | **963 段 / 1781.3 mm** | **345 段 / 622.8 mm** |
| 过孔 | **609** | **51** |
| 铺铜 | **13 块**：GND（1/2/15/16）、AU_GND（1/2/15/16）、3V3（15）、GND0（1/2/15/16） | **4 块，全 GND**（1/2/15/16），且 GND 焊盘/过孔为 0 → 电气孤岛 |
| 焊盘/连接 | PAD_NET 605 条，其中 572 条有网络（**94.5%**） | PCB 焊盘 274 个，103 个有网络（37.6%）；网表 266 引脚中 95 个有网络（**35.7%**） |
| 丝印文字 | 26 条 | **0 条** |
| 3D 模型 | 53/180 器件 | 64/64 器件 |
| DRC | 仓库有 0 违规证据（pcbUuid=5d632dde，2026-10-20T15:22） | **无当前板绑定的 DRC 证据**（唯一干净报告属于参考板，不能冒充当前板） |

## 5. 一致性/符合性判断

- **相同点**：板高（约 62mm）、4 层叠层、主控平台（ESP32-S3 模组）、ES7210 麦克风 ADC、部分连接器/Type-C 料号、摄像头 FPC 24P 功能取向。
- **不同点（性质不同，不只是完成度）**：
  1. 参考板是**已完成的量产设计**（全连通、全布线、GND 平面、DRC 0）；CircuitPilot 板是**未完成的简化重设计**（35.7% 引脚有网、GND 短接、无 DRC）。
  2. 参考板面积更大（宽约 82mm vs 56mm），器件密度与功能（USB-UART/HUB、codec、LED 阵列、按键、晶振、ESD ×3）明显更多；CircuitPilot 板缺这些功能块，且电源/充电架构换成另一套方案。
  3. BOM 只有 58 个位号交叉，且全部料号不同（51 个值不同），不能把两块板当成"同一设计的两个版本"直接互换。
- **结论**：CircuitPilot 当前产物是"按需求从零设计的简化版雏形"，与参考工程**不是同一块板**，尺寸、BOM、网络、布线、制造状态均有实质差异；在完成连线/GND 修复/DRC/仿真/放行门之前，不具备与参考板对比制造的条件。

## 6. 方法边界与局限

- 参考板 BOM 的 `Value` 字段部分为空（DEVICE 未填），值比较仅作参考，料号/器件名比较更可靠。
- 参考板板框为多段圆弧/样条（非单一矩形），尺寸按铜几何 + 过孔包络反推（≈81.6×61.8mm）；若需精确板框，建议在 EDA 里打开参考工程直接测量（会引入工程导入，属写操作，本次未做）。
- CircuitPilot 侧只读命令有单飞限制，已串行执行；快照文件 `current-board-read-2026-10-21.json` 为当时状态。
- 当前板 BOM 以 Board1_1 的原理图网表（P1+P2 合并导出，64 器件）为准；两个空板不计入。

## 7. 建议的下一步（按优先级）

1. **P0 修 GND/网络**：按 T4 triage 修 `$2N8`(GND/+3V3)、`$2N23`(+3V3/MIC_VDD)，把 171 个悬空引脚定性（补线/NC/DNP/删件），MK1 补焊盘。
2. **P0 重跑 ERC/DRC**：当前板 1 error/34 warning → 修完重跑，并把 DRC 证据绑定当前 `pcbUuid=5595e77c…`。
3. **P1 机械确认**：参考板 ~82×62mm vs 当前 56×62mm，需确认外壳/安装孔/DXF 尺寸约束，避免板宽方向装不进去。
4. **P1 BOM 对齐决策**：若目标是与参考板等价，需要补齐 122 个位号并统一样器件料号（尤其电容值、LED、ESD、USB-UART/HUB、codec）；若是"简化版"则需明确删减功能并同步产品需求。
5. **P2 补制造证据**：丝印文字（当前 0 条）、GND 缝合、正式 Gerber/BOM/CPL（去草稿）、价格库存、DFM 签核。

## 8. 后续结构变更（2026-10-21 21:2x 清理）

本报告 §1/§5 描述的“3 个 Board + 3 个游离文档”已按需求（PCB-M-01 双板结构）清理为 **2 块板**：
`Board1_1`（主控板，PCB3，内容未动）+ `按键指示灯板`（Board1_2 改名，PCB4，待设计）；
游离 PCB1/Schematic1/Schematic1_1 与空板 Board1（含 PCB2/Schematic1_2）已删除。
详见 `docs/implementation/board-cleanup-2026-10-21.md` 与 `artifacts/evidence/board-cleanup-2026-10-21/`。
