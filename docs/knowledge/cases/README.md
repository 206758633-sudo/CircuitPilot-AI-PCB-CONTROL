# PCB 参考设计案例库（Case Studies）

> 本目录用「真实板卡 / 公开参考设计」做案例复盘：不只看“画成什么样”，而是拆解**为什么这样设计、依据哪条规则、代价是什么、换到别的板子上怎么迁移**。每条结论尽量落到可判定的规则 ID 或计算/标准上，避免“经验之谈”。

## 1. 案例从哪来（可信度分级）

| 级别 | 标识 | 含义 | 本目录案例 |
|---|---|---|---|
| A · 本地实测/工程文件 | `本地证据` | 有工程文件、网表、Gerber/DRC/叠层/发布报告等可直接核对的证据；结论可复现 | 08 衣橱助手参考原理图 V1.2、09 衣橱助手 V2.0、10 CircuitPilot 6 层监测板、11 CH32V003 P0 |
| B · 公开参考设计 | `公开资料` | 基于厂商官方设计指南/公开原理图的公开工程常识整理；**受工具层检索限制，未逐页核对官方文件；K5 已用 curl 核对部分官方标准/厂商指南（见 `docs/implementation/placement-web-verification-k5-2026-10-22.md`）**，具体数值/层数/尺寸以官方文件与 datasheet 为准 | 01 RP2040/Pico、02 Arduino Uno R3、03 ESP32-DevKitC、04 STM32 Nucleo、05 USB-C PD 受控端、06 同步 Buck 布局、07 隔离 CAN/RS485、12 消费电子 TWS、13 工业控制器、14 AC-DC 适配器、15 RF 模组、16 柔性/刚挠板 |

> 使用规则：A 类案例的拓扑/数值可以当作“本项目已验证事实”；B 类案例只作为设计思路与规则依据的参考，**不得**把其中的具体数值直接抄进项目规则，必须先查官方文件/datasheet 并留下复核记录。

> 当前收录：**16 篇案例 / 2707 行 / 171 个 `KP-CASE-*` 知识点**，对应 `knowledge/pcb/dataset/cases.json` 的 16 条 `module` 条目（`PCB-CASE-*`）；灌库与验证命令见文末。

## 2. 案例清单

| 编号 | 案例 | 板型/主题 | 主要规则依据 |
|---|---|---|---|
| [01](./01-rpi-pico-rp2040.md) | Raspberry Pi Pico / RP2040 | 2 层低成本 MCU 模块、半孔、板载电源 | 去耦、晶振、USB、叠层、回流 |
| [02](./02-arduino-uno-r3.md) | Arduino Uno R3 | 2 层开源板、电源自动切换、USB 串口 | 电源优先级、ESD、晶振、地平面 |
| [03](./03-esp32-devkit.md) | ESP32-DevKitC / S3-DevKitC | 2 层无线模组开发板、天线净空 | RF 净空、去耦、自动下载、ESD |
| [04](./04-stm32-nucleo.md) | STM32 Nucleo-64 | 官方 MCU 开发板、板载调试器 | 调试接口、电源选择、晶振、ESD |
| [05](./05-usb-c-pd-sink.md) | USB-C PD 受控端 | Type-C 受电、PD 协商、VBUS 保护 | CC、VBUS、ESD、泄放、死电池 |
| [06](./06-sync-buck-layout.md) | 同步 Buck 参考布局 | DC-DC 功率环路、反馈、热 | 输入环路、SW 节点、反馈采样、热过孔 |
| [07](./07-isolated-can-rs485.md) | 隔离 CAN / RS485 节点 | 工业隔离接口、爬电、共模 | 隔离带、爬电/间隙、TVS、终端、地分割 |
| [08](./08-wardrobe-v12.md) | 衣橱助手参考原理图 V1.2 | ESP32-S3 整机：USB HUB、音频、摄像头、电源树 | 电源域、USB、DVP、I2S、充电、防反接 |
| [09](./09-wardrobe-v20.md) | 衣橱助手 V2.0（主板 + 按键灯板） | 4 层异形板、Type-C、FPC、板间连接、WS2812 | 叠层、细间距、天线净空、板间防护、DFM |
| [10](./10-circuitpilot-6l.md) | CircuitPilot 6 层监测板 | 6 层、90Ω 差分、USB-C、电流/温度监测 | 阻抗反解、等长、屏蔽过孔、CC、ESD |
| [11](./11-ch32v003-p0.md) | CircuitPilot CH32V003 P0 | 2 层 45×30mm 最小系统、成本极限 | 去耦、LDO、Type-C CC、DFM、测试点 |
| [12](./12-consumer-tws.md) | 消费电子 TWS / 可穿戴 | 充电、电池、天线、音频、ESD、DFM | 充电/电量、天线净空、音频、ESD、装配 |
| [13](./13-industrial-controller.md) | 工业控制器 | 24V 输入、隔离 RS485/CAN、宽温、EMC | 输入保护、隔离带、爬电、TVS、宽温降额 |
| [14](./14-ac-dc-power.md) | AC-DC / 适配器 | 安规绝缘、初级热环路、Y 电容、EMI | 爬电/间隙、保险丝、Y 电容、热、认证 |
| [15](./15-rf-module.md) | RF 模组 / 天线 | 50Ω、净空、匹配、共存、认证 | 阻抗、净空、匹配、ESD、共存 |
| [16](./16-flex-rigid-board.md) | 柔性 / 刚挠板 | 弯折半径、补强、刚挠过渡、连接器 | 弯折应变、覆盖膜、补强、过渡区、装配 |

## 3. 每篇案例的固定结构

1. **案例档案**：板型、层数/尺寸、主控/电源、关键接口、来源类型与证据路径。
2. **设计原理拆解**：电源树 → 时钟/复位 → 接口与保护 → 去耦与地 → EMC/ESD → 热/DFM（按案例取舍）。
3. **规则依据**：每条设计动作对应 `PCB-RULE-*` / `SCH-*` 规则，并解释物理或标准依据（回路面积、回流、阻抗、降额、爬电、IEC/UL/ISO 条款等）。
4. **可迁移经验**：做对的、妥协的、反面教训。
5. **评审清单**：可直接勾选的检查项。
6. **可信度与来源声明**：A/B 级别、已核对/未核对内容、必须复核的数值。
7. **关联知识条目**：`moduleId` / `ruleId` / `failureId`，便于 RAG 与门禁引用。

## 4. 写作与维护约定

- 案例知识点编号：`### KP-CASE-<案例短名>-<两位编号>`，篇内连续、不跨篇复用；案例短名见各篇标题。
- **禁止编造**：没有证据的尺寸、层数、料号、器件参数一律写“公开资料常见为…（以官方文件为准）”或“待核验”；不得把案例数值直接当成项目规则。
- 结构化数据源在 [`knowledge/pcb/dataset/cases.json`](../../../knowledge/pcb/dataset/cases.json)：每条案例是一个 `module` 知识条目（`moduleId = PCB-CASE-*`），`provenance.url` 指向本目录文档。
- 新增案例流程：案例文档 → `cases.json` 条目（含 ruleBasis/evidence/lessons）→ `node scripts/seed-knowledge-pcb.mjs` 灌库 → `node scripts/verify-rag.mjs` 验证检索 → 人工审核。
- 案例中的“规则依据”如果暴露出规则缺口，应在 `rules.json` 补规则，而不是把规则埋在案例正文里。

## 5. 灌库与验证

```bash
# 1) 数据集自检 + 灌入库（幂等；module 同时载入 modules.json 与 cases.json）
node scripts/seed-knowledge-pcb.mjs --check
node scripts/seed-knowledge-pcb.mjs

# 2) 灌入正在运行的应用（候选条目经 HTTP API 写入）
node scripts/seed-knowledge-pcb.mjs --api http://127.0.0.1:4178

# 3) 重建并评估 RAG（43 条 golden query + 4 条负向查询）
node scripts/verify-rag.mjs
```
