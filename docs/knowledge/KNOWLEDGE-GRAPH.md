# 知识库关联图（自动生成）

> 这是派生视图，不是新的知识正文；请勿手工修改。
> 重新生成：`npm run knowledge:graph`；提交前校验：`npm run knowledge:graph:check`。
> 权威内容仍是 `docs/knowledge/**` 与 `knowledge/pcb/dataset/*.json`。

## 1. 总览

| 指标 | 数量 |
|---|---:|
| 文档 | 71 |
| 知识点（KP） | 1050 |
| 结构化条目 | 463 |
| 来源登记 | 68 |
| 节点 / 边 | 1652 / 2616 |
| 跨文档 KP 引用 | 80 |
| 跨文档条目引用 | 537 |
| 孤岛 KP（无任何跨文档/条目引用） | 961 |
| 无跨文档连接的文档 | 31 |
| 无结构化条目的文档 | 1 |
| 无来源的结构化条目 | 383 |
| 引用了未登记来源的条目 | 0 |
| 未被引用的已登记来源 | 0 |

## 2. 领域连接

| 领域 | 文档 | KP | 条目 | 有跨文档引用的 KP | 孤岛 KP | 无跨文档连接文档 |
|---|---:|---:|---:|---:|---:|---:|
| cases | 16 | 171 | 26 | 0 | 171 | 0 |
| checklists | 3 | 0 | 4 | 0 | 0 | 3 |
| components | 12 | 211 | 88 | 3 | 208 | 8 |
| pcb | 26 | 382 | 261 | 41 | 341 | 10 |
| requirements | 1 | 0 | 0 | 0 | 0 | 1 |
| schematic | 13 | 286 | 84 | 45 | 241 | 9 |

## 3. 文档枢纽（按连接度）

连接度 = 文档出链 + 被其他文档引用；用来找“应该优先维护/最容易断链”的入口文档。

| # | 文档 | 领域 | 连接度 | 出链 | 入链 |
|---:|---|---|---:|---:|---:|
| 1 | [09-sensors-actuators.md](<./schematic/09-sensors-actuators.md>) | schematic | 81 | 45 | 2 |
| 2 | [09-reliability-derating.md](<./pcb/09-reliability-derating.md>) | pcb | 75 | 27 | 4 |
| 3 | [07-multilayer-highspeed.md](<./pcb/07-multilayer-highspeed.md>) | pcb | 72 | 12 | 5 |
| 4 | [10-testability-production-test.md](<./pcb/10-testability-production-test.md>) | pcb | 70 | 31 | 3 |
| 5 | [08-analog-signal-chain.md](<./schematic/08-analog-signal-chain.md>) | schematic | 70 | 32 | 2 |
| 6 | [08-component-placement.md](<./pcb/08-component-placement.md>) | pcb | 68 | 8 | 4 |
| 7 | [11-safety-certification.md](<./pcb/11-safety-certification.md>) | pcb | 66 | 28 | 2 |
| 8 | [10-battery-bms.md](<./schematic/10-battery-bms.md>) | schematic | 60 | 28 | 2 |
| 9 | [01-rpi-pico-rp2040.md](<./cases/01-rpi-pico-rp2040.md>) | cases | 59 | 47 | 0 |
| 10 | [12-consumer-tws.md](<./cases/12-consumer-tws.md>) | cases | 53 | 41 | 0 |
| 11 | [02-arduino-uno-r3.md](<./cases/02-arduino-uno-r3.md>) | cases | 52 | 40 | 0 |
| 12 | [03-esp32-devkit.md](<./cases/03-esp32-devkit.md>) | cases | 47 | 34 | 0 |
| 13 | [13-industrial-controller.md](<./cases/13-industrial-controller.md>) | cases | 45 | 33 | 0 |
| 14 | [20-researched-layout-constraints.md](<./pcb/20-researched-layout-constraints.md>) | pcb | 44 | 14 | 1 |
| 15 | [14-high-speed-protocols.md](<./pcb/14-high-speed-protocols.md>) | pcb | 43 | 3 | 0 |

## 4. 知识点枢纽（被引用最多）

| # | KP | 标题 | 所属文档 | 被引用 |
|---:|---|---|---|---:|
| 1 | `KP-CMP-089` | 负载电容 CL 与匹配电容 C1/C2 的计算 | [06-crystals-oscillators.md](<./components/06-crystals-oscillators.md>) | 2 |
| 2 | `KP-PCB-020` | 两层板只有「外层微带」，参考面天然不完整 | [02-stackup-impedance.md](<./pcb/02-stackup-impedance.md>) | 2 |
| 3 | `KP-PCB-083` | 热阻链：Tj = Ta + P × θJA，θJA 不是常数 | [05-emc-esd-thermal.md](<./pcb/05-emc-esd-thermal.md>) | 2 |
| 4 | `KP-PCB-166` | 量产反馈闭环：DFM/ICT/返修/客诉数据回写布局规则 | [08-component-placement.md](<./pcb/08-component-placement.md>) | 2 |
| 5 | `KP-PCB-294` | 回流曲线：按焊膏 + 器件 + 板厚测，不抄「通用曲线」 | [13-package-assembly-rework.md](<./pcb/13-package-assembly-rework.md>) | 2 |
| 6 | `KP-PCB-309` | 高速通道先做损耗预算，再决定层数/材料/长度 | [14-high-speed-protocols.md](<./pcb/14-high-speed-protocols.md>) | 2 |
| 7 | `KP-PCB-327` | 高速过孔/背钻/stub：能少则少、能短则短 | [14-high-speed-protocols.md](<./pcb/14-high-speed-protocols.md>) | 2 |
| 8 | `KP-PCB-328` | 参考平面与跨分割：高速对跨分割次数必须为 0 | [14-high-speed-protocols.md](<./pcb/14-high-speed-protocols.md>) | 2 |
| 9 | `KP-SCH-054` | 接口设计四问：电平、速率、距离、参考地 | [04-interfaces.md](<./schematic/04-interfaces.md>) | 2 |
| 10 | `KP-SCH-055` | I2C 上拉电阻范围计算 | [04-interfaces.md](<./schematic/04-interfaces.md>) | 2 |
| 11 | `KP-SCH-058` | I2C 隔离与电平转换 | [04-interfaces.md](<./schematic/04-interfaces.md>) | 2 |
| 12 | `KP-SCH-073` | 保护设计总则：先定应力，再定顺序，最后定器件 | [05-protection.md](<./schematic/05-protection.md>) | 2 |
| 13 | `KP-SCH-105` | 可制造性与可测试性检查 | [06-erc-review-checklist.md](<./schematic/06-erc-review-checklist.md>) | 2 |
| 14 | `KP-SCH-110` | 模拟小信号、音频功率与数字必须分区 | [07-analog-audio.md](<./schematic/07-analog-audio.md>) | 2 |
| 15 | `KP-SCH-111` | 模拟地与单点连接 | [07-analog-audio.md](<./schematic/07-analog-audio.md>) | 2 |
| 16 | `KP-SCH-131` | 采样校准：偏移、增益与两点法 | [07-analog-audio.md](<./schematic/07-analog-audio.md>) | 2 |
| 17 | `KP-SCH-139` | 电流检测放大器（CSA）：共模电压、CMRR 与分流电阻 | [08-analog-signal-chain.md](<./schematic/08-analog-signal-chain.md>) | 2 |
| 18 | `KP-CMP-007` | MLCC 直流偏压降容必须按工作电压复核有效容量 | [01-passives.md](<./components/01-passives.md>) | 1 |
| 19 | `KP-CMP-098` | 起振失败的常见原因与排查顺序 | [06-crystals-oscillators.md](<./components/06-crystals-oscillators.md>) | 1 |
| 20 | `KP-PCB-013` | 板边距离：铜 ≥0.30 mm、元件 ≥0.50 mm | [01-design-rules.md](<./pcb/01-design-rules.md>) | 1 |

## 5. 孤岛知识点

共 961 个 KP 目前没有被其他文档、条目或来源连接。它们不一定是错的，但值得确认是“独立概念”还是“漏了关联”。

| # | KP | 标题 | 所属文档 |
|---:|---|---|---|
| 1 | `KP-CASE-ACDC-01` | 先定绝缘等级/污染等级/海拔/过压类别，再谈间距与器件 | [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) |
| 2 | `KP-CASE-ACDC-02` | 隔离带是物理结构：所有层无铜、无过孔、必要时开槽，且宽度按查表值 | [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) |
| 3 | `KP-CASE-ACDC-03` | Y 电容是“共模回流通道”，容值受安规漏电流限制 | [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) |
| 4 | `KP-CASE-ACDC-04` | 输入保护顺序：保险丝 → 压敏/NTC → X 电容/共模 → 整流 | [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) |
| 5 | `KP-CASE-ACDC-05` | 初级热环路（输入电容—开关管—变压器）面积决定 EMI 与效率 | [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) |
| 6 | `KP-CASE-ACDC-06` | 变压器/光耦/隔离反馈是隔离带的“合法跨越点”，但周边布线仍要守距离 | [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) |
| 7 | `KP-CASE-ACDC-07` | 次级整流与输出电容：环路要小，纹波与寿命要一起算 | [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) |
| 8 | `KP-CASE-ACDC-08` | 热：效率与损耗分布决定散热结构，电解电容是寿命短板 | [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) |
| 9 | `KP-CASE-ACDC-09` | 高压测量与安规验证：耐压、绝缘电阻、爬电、漏电流四件套 | [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) |
| 10 | `KP-CASE-ACDC-10` | DFM 与认证标识：高压区丝印、开槽、三防与安全标识 | [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) |
| 11 | `KP-CASE-BUCK-01` | 热环路（hot loop）面积是布局第一优先级 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 12 | `KP-CASE-BUCK-02` | 输入电容：VIN 与 PGND 成对、就近、并联多颗 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 13 | `KP-CASE-BUCK-03` | SW 节点：面积最小、载流够、不引长线 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 14 | `KP-CASE-BUCK-04` | 电感：紧靠 SW、下方净空、按饱和/温升选 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 15 | `KP-CASE-BUCK-05` | 布局前置约束：开关频率、电感、输出电容必须先定 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 16 | `KP-CASE-BUCK-06` | 使能/软启动/频率设置：小信号要有确定电平且靠近芯片 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 17 | `KP-CASE-BUCK-07` | 保护与接口：OCP/OVP/UVLO 与 PGOOD 的布局同样影响可靠性 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 18 | `KP-CASE-BUCK-08` | 输出电容与反馈取样：Kelvin 从输出电容之后取 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 19 | `KP-CASE-BUCK-09` | 地：PGND 与 AGND 单点连接，内层地完整 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 20 | `KP-CASE-BUCK-10` | 自举与 VCC：短回路、就近去耦 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 21 | `KP-CASE-BUCK-11` | 开关电源的 EMC：源头（dv/dt、di/dt、环路）+ 传播路径一起管 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 22 | `KP-CASE-BUCK-12` | 散热：EPAD 过孔阵列 + 铜面积 + 热焊盘 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) |
| 23 | `KP-CASE-CANISO-01` | 隔离节点四件套：隔离电源 + 数字隔离 + 收发器 + 总线保护 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 24 | `KP-CASE-CANISO-02` | 隔离电源的开关噪声会直接调制到总线上 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 25 | `KP-CASE-CANISO-03` | 使能/方向/上电时序：不得让总线出现“错误驱动” | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 26 | `KP-CASE-CANISO-04` | CAN 终端：120Ω 分裂终端 + 中心电容 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 27 | `KP-CASE-CANISO-05` | RS485 终端与失效保护偏置 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 28 | `KP-CASE-CANISO-06` | TVS / 共模电感：位置比型号更重要 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 29 | `KP-CASE-CANISO-07` | 总线布线：成对、无 stub、终端在两端 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 30 | `KP-CASE-CANISO-08` | 两侧地必须真正分开：万用表测应开路 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 31 | `KP-CASE-CANISO-09` | 隔离带：爬电/间隙按标准算，必要时开槽 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 32 | `KP-CASE-CANISO-10` | 屏蔽、Y 电容与共模回流：给共模电流一条受控路径 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 33 | `KP-CASE-CANISO-11` | 整机抗扰：ESD/EFT/浪涌按工业等级做，保护地回路要短 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 34 | `KP-CASE-CANISO-12` | 热与 DFM：隔离电源占位、开槽可制造、丝印标隔离区 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) |
| 35 | `KP-CASE-CH32-01` | 低成本 MCU 最小系统 = 电源 + 去耦 + 复位/BOOT + 下载口 + 晶振（若需要） | [11-ch32v003-p0.md](<./cases/11-ch32v003-p0.md>) |
| 36 | `KP-CASE-CH32-02` | LDO 的输入/输出电容与压差/热耗要按实际负载核算 | [11-ch32v003-p0.md](<./cases/11-ch32v003-p0.md>) |
| 37 | `KP-CASE-CH32-03` | Type-C 受电只做“5V 取电”也要两只 5.1kΩ CC 下拉 | [11-ch32v003-p0.md](<./cases/11-ch32v003-p0.md>) |
| 38 | `KP-CASE-CH32-04` | 按键/ LED 的“小电阻”决定可制造性与可测试性 | [11-ch32v003-p0.md](<./cases/11-ch32v003-p0.md>) |
| 39 | `KP-CASE-CH32-05` | 2 层板靠“双面 GND 铺铜 + 过孔缝合”补回流 | [11-ch32v003-p0.md](<./cases/11-ch32v003-p0.md>) |
| 40 | `KP-CASE-CH32-06` | 盘中孔（via-in-pad）必须确认塞孔/填平工艺，否则虚焊漏锡 | [11-ch32v003-p0.md](<./cases/11-ch32v003-p0.md>) |
| … | 其余 921 个见 `knowledge/pcb/dataset/graph.json` | | |

## 6. 文档互链缺口

共 31 篇文档没有指向其他文档/KP/条目的跨文档链接：

| 文档 | 领域 | 连接度 |
|---|---|---:|
| [06-dfm-manufacturing.md](<./pcb/06-dfm-manufacturing.md>) | pcb | 39 |
| [12-power-topologies.md](<./schematic/12-power-topologies.md>) | schematic | 36 |
| [11-rf-antenna.md](<./schematic/11-rf-antenna.md>) | schematic | 35 |
| [05-emc-esd-thermal.md](<./pcb/05-emc-esd-thermal.md>) | pcb | 33 |
| [01-design-rules.md](<./pcb/01-design-rules.md>) | pcb | 32 |
| [04-interfaces.md](<./schematic/04-interfaces.md>) | schematic | 32 |
| [05-protection.md](<./schematic/05-protection.md>) | schematic | 31 |
| [03-placement-routing.md](<./pcb/03-placement-routing.md>) | pcb | 30 |
| [07-analog-audio.md](<./schematic/07-analog-audio.md>) | schematic | 30 |
| [13-documentation-eco.md](<./schematic/13-documentation-eco.md>) | schematic | 29 |
| [01-passives.md](<./components/01-passives.md>) | components | 26 |
| [05-mcu-wireless-connectors.md](<./components/05-mcu-wireless-connectors.md>) | components | 26 |
| [02-diodes-tvs.md](<./components/02-diodes-tvs.md>) | components | 25 |
| [02-power-architecture.md](<./schematic/02-power-architecture.md>) | schematic | 25 |
| [11-supply-chain.md](<./components/11-supply-chain.md>) | components | 24 |
| [12-library-management.md](<./components/12-library-management.md>) | components | 24 |
| [04-power-integrity-decoupling.md](<./pcb/04-power-integrity-decoupling.md>) | pcb | 24 |
| [01-conventions.md](<./schematic/01-conventions.md>) | schematic | 24 |
| [03-mcu-minimal-system.md](<./schematic/03-mcu-minimal-system.md>) | schematic | 23 |
| [06-crystals-oscillators.md](<./components/06-crystals-oscillators.md>) | components | 22 |
| [03-transistors-mosfets.md](<./components/03-transistors-mosfets.md>) | components | 20 |
| [07-lcsc-quickref-footprint.md](<./components/07-lcsc-quickref-footprint.md>) | components | 18 |
| [21-eda-api-eco-playbook.md](<./pcb/21-eda-api-eco-playbook.md>) | pcb | 12 |
| [17-circuitpilot-mechanical-capability-gaps.md](<./pcb/17-circuitpilot-mechanical-capability-gaps.md>) | pcb | 9 |
| [15-circuitpilot-recheck-truthfulness.md](<./pcb/15-circuitpilot-recheck-truthfulness.md>) | pcb | 5 |
| [18-four-layer-planes-mech-holes-and-research-limits.md](<./pcb/18-four-layer-planes-mech-holes-and-research-limits.md>) | pcb | 4 |
| [19-camera-interface-gc0308-and-eda-netlist-edit-limits.md](<./pcb/19-camera-interface-gc0308-and-eda-netlist-edit-limits.md>) | pcb | 4 |
| [layout-review.md](<./checklists/layout-review.md>) | checklists | 3 |
| [schematic-review.md](<./checklists/schematic-review.md>) | checklists | 2 |
| [component-selection.md](<./checklists/component-selection.md>) | checklists | 1 |
| … | 其余 1 篇见 graph.json | |

## 7. 来源覆盖

| 条目类型 | 总数 | 有来源 | 无来源 |
|---|---:|---:|---:|
| rule | 188 | 54 | 134 |
| module | 96 | 8 | 88 |
| case | 17 | 8 | 9 |
| part | 57 | 0 | 57 |
| failure | 105 | 10 | 95 |

- 无来源条目 383 条：多数是内部规则；只对确实来自公开资料的条目补来源，不批量伪造。
- 引用未登记来源的条目 0 条；未登记来源不能当外部证据。

## 8. 怎么用

- **人**：从“文档枢纽”和“知识点枢纽”进入，先看被引用最多的内容；再用孤岛/互链缺口做维护清单。
- **Agent/RAG**：读取 `knowledge/pcb/dataset/graph.json`，按 `edges` 做相邻节点扩展；图只提供上下文，不作为“已验证知识”依据。
- **门禁**：仍只认 `approved + 未过期 + trust 合格` 的结构化条目；图不改变审核状态。

## 9. 生成约束

- 只读 `docs/knowledge/**`、`knowledge/pcb/dataset/*.json`；不调用网络、不改正文、不改审核状态。
- `--check` 会比较两份生成物；任何源文档/条目/来源变化后必须重新生成。
- 节点 ID：`doc:<路径>`、`kp:<KP-ID>`、`entry:<kind>:<ID>`、`source:<SRC-ID>`；边类型见 `graph.json`。

