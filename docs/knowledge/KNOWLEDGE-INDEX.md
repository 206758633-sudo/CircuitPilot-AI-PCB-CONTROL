# CircuitPilot 知识库总索引（知识点地图）

> **自动生成，请不要手改本文件。** 修改 `docs/knowledge/**/*.md` 或 `knowledge/pcb/dataset/*.json` 后运行：
> ```bash
> npm run knowledge:index        # 重新生成
> npm run knowledge:index:check  # 检查是否过期
> ```

本索引解决三个问题：

1. **文档在哪里**：按 `pcb / schematic / components / cases / checklists / requirements` 分域列出，直接点进原文。
2. **知识点在哪里**：每个 `KP-*` 编号都列出标题和所属文档，不再靠全文搜索。
3. **哪些内容没有编号**：清单、需求档案、能力边界/研究笔记单独标出，避免“看起来漏了”。

> 知识分层：本索引只表示“文档里的知识点位置”；结构化条目的审核状态以 knowledge store / 知识库页面为准，未审核条目（candidate）不得作为门禁依据。

## 1. 总览

| 指标 | 数量 |
|---|---:|
| Markdown 文档（不含 README/索引/冲突登记） | **70** |
| 其中：设计内容文档（不含 requirements） | **69** |
| 带 KP 编号的知识点 | **1037** |
| 无 KP 编号的文档（清单/需求/专题） | **12** |
| 结构化知识条目 | **442** |
| 来源登记 | **26** |

结构化条目构成：

| kind | 数量 | 说明 |
|---|---:|---|
| rule | 173 | 可判定规则 |
| module | 110 | 模块 93 + 案例 17 |
| part | 57 | 料号/器件身份 |
| failure | 102 | 失败模式 |

## 2. 领域导航

| 领域 | 文档 | KP | 结构化条目 | 无 KP 文档 | 说明 |
|---|---:|---:|---:|---:|---|
| [PCB / 制造 / 可靠性](./pcb/) | 25 | 369 | 240 | 8 | 叠层、布局布线、电源完整性、EMC/ESD/热、DFM、测试、安规、封装装配 |
| [原理图 / 电路设计](./schematic/) | 13 | 286 | 84 | 0 | 电源架构、最小系统、接口、保护、ERC、模拟、电池、RF、ECO |
| [元器件 / 选型 / 库](./components/) | 12 | 211 | 88 | 0 | 无源、分立、电源 IC、MCU/无线/连接器、晶振、料号、供应链、库管理 |
| [参考设计案例](./cases/) | 16 | 171 | 26 | 0 | 真实板与公开参考设计的复盘、规则依据、可迁移经验 |
| [评审清单](./checklists/) | 3 | 0 | 4 | 3 | 原理图/Layout/选型可勾选门禁 |
| [需求档案](./requirements/) | 1 | 0 | 0 | 1 | 产品需求/验收；不属于设计知识点，不进入设计门禁 |

## 3. 主题导航（跨域）

同一个工程问题经常横跨原理图、PCB、器件与案例；下表按“设计问题”而不是按文件夹给入口。

| 主题 | 入口文档 | 说明 |
|---|---|---|
| 需求 → 电源架构 → 电源树 | [电源架构](./schematic/02-power-architecture.md) · [电源拓扑](./schematic/12-power-topologies.md) · [电源完整性](./pcb/04-power-integrity-decoupling.md) · [电源 IC](./components/04-power-ics.md) | 先定义电源域/上电顺序/保护，再画具体电路 |
| MCU 最小系统：电源/时钟/复位/调试 | [MCU 最小系统](./schematic/03-mcu-minimal-system.md) · [晶振](./components/06-crystals-oscillators.md) · [Pico 案例](./cases/01-rpi-pico-rp2040.md) · [Nucleo 案例](./cases/04-stm32-nucleo.md) | 去耦、晶振、复位、BOOT、下载口 |
| 接口、保护与隔离 | [接口](./schematic/04-interfaces.md) · [保护](./schematic/05-protection.md) · [接口保护](./components/10-interface-protection.md) · [高速接口](./pcb/14-high-speed-protocols.md) · [隔离 CAN/RS485](./cases/07-isolated-can-rs485.md) | 连接器/ESD/TVS/隔离带/爬电，先保护后通信 |
| 布局、布线、叠层 | [叠层与阻抗](./pcb/02-stackup-impedance.md) · [布局布线](./pcb/03-placement-routing.md) · [布局依据](./pcb/08-component-placement.md) · [EDA 工程闭环](./pcb/23-lceda-project-workflow-and-bilibili-course.md) · [预布线/电源优先](./pcb/24-prerouting-and-power-first.md) · [布线十条原则](./pcb/25-ten-routing-principles.md) | 从结构/接口/功率/防护/主控到预布线和十条原则 |
| 电源完整性、去耦与地 | [去耦](./pcb/04-power-integrity-decoupling.md) · [四层板平面](./pcb/18-four-layer-planes-mech-holes-and-research-limits.md) · [无源件](./components/01-passives.md) · [电感/磁珠](./components/08-inductors-ferrites-fuses.md) | 目标阻抗、回流、去耦距离、地平面/分割 |
| 高速/信号完整性 | [多层高速](./pcb/07-multilayer-highspeed.md) · [高速协议](./pcb/14-high-speed-protocols.md) · [6 层案例](./cases/10-circuitpilot-6l.md) · [模拟信号链](./schematic/08-analog-signal-chain.md) | 阻抗、差分、等长、参考平面、过孔/背钻 |
| EMC / ESD / 热 / 安规 | [EMC/ESD/热](./pcb/05-emc-esd-thermal.md) · [可靠性与降额](./pcb/09-reliability-derating.md) · [安规认证](./pcb/11-safety-certification.md) · [TVS](./components/02-diodes-tvs.md) · [工业控制器](./cases/13-industrial-controller.md) · [AC-DC](./cases/14-ac-dc-power.md) | 发射/抗扰、接口防护、热路径、认证证据 |
| DFM、制造、测试与装配 | [DFM 制造](./pcb/06-dfm-manufacturing.md) · [可测试性](./pcb/10-testability-production-test.md) · [封装装配](./pcb/13-package-assembly-rework.md) · [封装核验](./components/07-lcsc-quickref-footprint.md) · [供应链](./components/11-supply-chain.md) · [低成本案例](./cases/11-ch32v003-p0.md) | Gerber/BOM/坐标、拼板、测试点、ICT/FCT、返修 |
| 可靠性、柔性与封装 | [可靠性](./pcb/09-reliability-derating.md) · [柔性/刚挠](./pcb/12-flex-rigid-flex.md) · [封装/返修](./pcb/13-package-assembly-rework.md) · [柔性板案例](./cases/16-flex-rigid-board.md) | 寿命/环境/降额、弯折半径、补强、BGA/QFN 返修 |
| 案例、研究与能力边界 | [案例库](./cases/README.md) · [公开资料研究](./pcb/20-researched-layout-constraints.md) · [EDA API/ECO](./pcb/21-eda-api-eco-playbook.md) · [AI 布局](./pcb/22-ai-assisted-layout-and-readable-schematic.md) · [能力边界](./pcb/17-circuitpilot-mechanical-capability-gaps.md) | 参考设计不能照抄；先看可信度、证据和工具边界 |

## 4. 文档目录

| # | 文档 | 标题 | KP 数 | KP 范围 | 结构化条目 | 备注 |
|---:|---|---|---:|---|---:|---|
| 1 | [01-design-rules.md](<./pcb/01-design-rules.md>) | PCB 设计规则数值基线（Layout → 制造） | 18 | 01–18 | 13（rule 11 · failure 2） |  |
| 2 | [02-stackup-impedance.md](<./pcb/02-stackup-impedance.md>) | 叠层与阻抗控制（2/4/6 层） | 18 | 19–36 | 7（rule 4 · module 2 · failure 1） |  |
| 3 | [03-placement-routing.md](<./pcb/03-placement-routing.md>) | 布局与布线（Placement & Routing） | 18 | 37–54 | 5（rule 2 · module 1 · failure 2） |  |
| 4 | [04-power-integrity-decoupling.md](<./pcb/04-power-integrity-decoupling.md>) | 电源完整性与去耦（Power Integrity & Decoupling） | 17 | 55–71 | 4（rule 2 · module 1 · failure 1） |  |
| 5 | [05-emc-esd-thermal.md](<./pcb/05-emc-esd-thermal.md>) | EMC / ESD / 热设计（板级） | 17 | 72–88 | 8（rule 3 · module 2 · failure 3） |  |
| 6 | [06-dfm-manufacturing.md](<./pcb/06-dfm-manufacturing.md>) | DFM 与制造文件（制造前闭环） | 18 | 089–106 | 13（rule 6 · module 2 · failure 5） |  |
| 7 | [07-multilayer-highspeed.md](<./pcb/07-multilayer-highspeed.md>) | 多层高密度与高速设计（6 层及以上） | 30 | 107–136 | 25（rule 17 · module 4 · failure 4） |  |
| 8 | [08-component-placement.md](<./pcb/08-component-placement.md>) | 元器件布局与部署位置的依据规则（市场实际做法） | 30 | 137–166 | 26（rule 20 · module 3 · failure 3） |  |
| 9 | [09-reliability-derating.md](<./pcb/09-reliability-derating.md>) | 可靠性与降额设计（寿命、环境试验、鉴定与闭环） | 34 | 167–200 | 10（rule 4 · module 3 · failure 3） |  |
| 10 | [10-testability-production-test.md](<./pcb/10-testability-production-test.md>) | 可测试性与量产测试（DFT、测试点、ICT/FCT、边界扫描与产测流程） | 28 | 201–228 | 8（rule 2 · module 3 · failure 3） |  |
| 11 | [11-safety-certification.md](<./pcb/11-safety-certification.md>) | 安规与认证（IEC 62368-1、EMC、市场准入与电池安全） | 28 | 229–256 | 8（rule 4 · module 2 · failure 2） |  |
| 12 | [12-flex-rigid-flex.md](<./pcb/12-flex-rigid-flex.md>) | 柔性板与刚挠结合板设计（Flex / Rigid-Flex） | 26 | 257–282 | 8（rule 3 · module 3 · failure 2） |  |
| 13 | [13-package-assembly-rework.md](<./pcb/13-package-assembly-rework.md>) | 封装、装配与返修（BGA / QFN / WLCSP） | 26 | 283–308 | 8（rule 3 · module 2 · failure 3） |  |
| 14 | [14-high-speed-protocols.md](<./pcb/14-high-speed-protocols.md>) | 高速协议与接口设计（USB3/4、PCIe、以太网、MIPI、HDMI、SDIO） | 32 | 309–340 | 8（rule 2 · module 3 · failure 3） |  |
| 15 | [15-circuitpilot-recheck-truthfulness.md](<./pcb/15-circuitpilot-recheck-truthfulness.md>) | 15. 复核真值性：包围盒、双面、证据绑定（CircuitPilot 真机教训） | 0 | — | 5（rule 3 · failure 2） | 清单/专题，无 KP 编号 |
| 16 | [16-fine-pitch-escape.md](<./pcb/16-fine-pitch-escape.md>) | 16. 细间距逃逸与扇出：判定数学与真机标定 | 0 | — | 4（rule 1 · case 1 · failure 2） | 清单/专题，无 KP 编号 |
| 17 | [17-circuitpilot-mechanical-capability-gaps.md](<./pcb/17-circuitpilot-mechanical-capability-gaps.md>) | 17 · CircuitPilot 机械要素能力边界与参考工程对标方法（本轮真机记录） | 0 | — | 9（rule 5 · case 1 · failure 3） | 清单/专题，无 KP 编号 |
| 18 | [18-four-layer-planes-mech-holes-and-research-limits.md](<./pcb/18-four-layer-planes-mech-holes-and-research-limits.md>) | 四层板电源平面、机械孔近似与外部检索受限（r45–r46） | 0 | — | 4（rule 2 · failure 2） | 清单/专题，无 KP 编号 |
| 19 | [19-camera-interface-gc0308-and-eda-netlist-edit-limits.md](<./pcb/19-camera-interface-gc0308-and-eda-netlist-edit-limits.md>) | 19. 相机接口（GC0308/DVP）与 EDA 网表编辑边界 | 0 | — | 4（rule 2 · failure 2） | 清单/专题，无 KP 编号 |
| 20 | [20-researched-layout-constraints.md](<./pcb/20-researched-layout-constraints.md>) | PCB 布局约束：公开资料与真实参考设计研究（2026-10-23） | 0 | — | 29（rule 20 · case 4 · failure 5） | 清单/专题，无 KP 编号 |
| 21 | [21-eda-api-eco-playbook.md](<./pcb/21-eda-api-eco-playbook.md>) | 21. 用 EDA 插件 API 对既有工程做受控 ECO（相机 GC0308 实战） | 0 | — | 12（rule 6 · failure 6） | 清单/专题，无 KP 编号 |
| 22 | [22-ai-assisted-layout-and-readable-schematic.md](<./pcb/22-ai-assisted-layout-and-readable-schematic.md>) | 22. AI 辅助布局的功能分区与"可读原理图"验收 | 0 | — | 2（rule 1 · module 1） | 清单/专题，无 KP 编号 |
| 23 | [23-lceda-project-workflow-and-bilibili-course.md](<./pcb/23-lceda-project-workflow-and-bilibili-course.md>) | 23. 嘉立创EDA专业版工程闭环与 B 站课程学习笔记 | 13 | 341–353 | 11（rule 5 · module 3 · failure 3） |  |
| 24 | [24-prerouting-and-power-first.md](<./pcb/24-prerouting-and-power-first.md>) | 24. 预布线与“电源优先”：关键网络先锁定，普通信号后走 | 6 | 354–359 | 4（rule 2 · module 1 · failure 1） |  |
| 25 | [25-ten-routing-principles.md](<./pcb/25-ten-routing-principles.md>) | 25. PCB 布线十条原则：从“经验口诀”到可执行检查 | 10 | 360–369 | 5（rule 3 · module 1 · failure 1） |  |
| 26 | [01-conventions.md](<./schematic/01-conventions.md>) | 原理图设计规范：图框、网络命名、符号与可读性 | 18 | 01–18 | 6（rule 4 · failure 2） |  |
| 27 | [02-power-architecture.md](<./schematic/02-power-architecture.md>) | 电源架构设计：拓扑选择、LDO/Buck 边界、时序与电源域 | 18 | 19–36 | 4（module 4） |  |
| 28 | [03-mcu-minimal-system.md](<./schematic/03-mcu-minimal-system.md>) | MCU 最小系统设计：电源、复位、时钟、调试与量产接口 | 17 | 37–53 | 4（module 3 · failure 1） |  |
| 29 | [04-interfaces.md](<./schematic/04-interfaces.md>) | 总线与接口设计：I2C / SPI / UART / USB / CAN / RS485 / 电平转换 | 19 | 54–72 | 10（rule 2 · module 7 · failure 1） |  |
| 30 | [05-protection.md](<./schematic/05-protection.md>) | 保护电路设计：ESD、TVS、过压/过流/反接、浪涌与热插拔 | 18 | 73–90 | 5（module 2 · failure 3） |  |
| 31 | [06-erc-review-checklist.md](<./schematic/06-erc-review-checklist.md>) | ERC 与原理图评审：常见错误逐条处理、评审清单与证据要求 | 19 | 091–109 | 5（rule 4 · failure 1） |  |
| 32 | [07-analog-audio.md](<./schematic/07-analog-audio.md>) | 模拟 / 音频 / 采样前端设计：分区、麦克风、功放、ADC 与检测 | 25 | 110–134 | 2（module 2） |  |
| 33 | [08-analog-signal-chain.md](<./schematic/08-analog-signal-chain.md>) | 模拟信号链设计：运放、基准源、ADC/DAC、滤波与误差预算 | 26 | 135–160 | 10（rule 4 · module 3 · failure 3） |  |
| 34 | [09-sensors-actuators.md](<./schematic/09-sensors-actuators.md>) | 传感器与执行器接口设计：I2C/SPI/模拟/脉冲、校准、隔离与电机驱动 | 26 | 161–186 | 8（rule 2 · module 3 · failure 3） |  |
| 35 | [10-battery-bms.md](<./schematic/10-battery-bms.md>) | 电池与 BMS 设计：充电、保护、电量计、均衡、热安全与认证证据 | 24 | 187–210 | 6（rule 2 · module 2 · failure 2） |  |
| 36 | [11-rf-antenna.md](<./schematic/11-rf-antenna.md>) | RF 与天线设计：50Ω 传输、匹配、巴伦、净空、调试与认证 | 26 | 211–236 | 9（rule 3 · module 3 · failure 3） |  |
| 37 | [12-power-topologies.md](<./schematic/12-power-topologies.md>) | 先进电源拓扑：Buck-Boost、反激、LLC、多相、热插拔与环路 | 26 | 237–262 | 10（rule 3 · module 4 · failure 3） |  |
| 38 | [13-documentation-eco.md](<./schematic/13-documentation-eco.md>) | 文件与 ECO：版本矩阵、变更控制、BOM、评审门禁与归档 | 24 | 263–286 | 5（rule 2 · module 1 · failure 2） |  |
| 39 | [01-passives.md](<./components/01-passives.md>) | 无源器件（电阻 / 电容 / 电感）选型知识 | 18 | 01–18 | 8（part 7 · failure 1） |  |
| 40 | [02-diodes-tvs.md](<./components/02-diodes-tvs.md>) | 二极管 / 齐纳 / LED / TVS 选型知识 | 18 | 19–36 | 7（module 2 · part 5） |  |
| 41 | [03-transistors-mosfets.md](<./components/03-transistors-mosfets.md>) | 三极管 / MOSFET 开关与驱动知识 | 17 | 37–53 | 3（part 3） |  |
| 42 | [04-power-ics.md](<./components/04-power-ics.md>) | 电源 IC（LDO / Buck / Boost / 充电管理）选型知识 | 18 | 54–71 | 4（part 4） |  |
| 43 | [05-mcu-wireless-connectors.md](<./components/05-mcu-wireless-connectors.md>) | MCU / 无线模组 / 连接器选型知识 | 17 | 72–88 | 6（module 1 · part 5） |  |
| 44 | [06-crystals-oscillators.md](<./components/06-crystals-oscillators.md>) | 晶振 / 振荡器 / 时钟电路知识 | 16 | 089–104 | 5（module 1 · part 3 · failure 1） |  |
| 45 | [07-lcsc-quickref-footprint.md](<./components/07-lcsc-quickref-footprint.md>) | 常用料号速查与封装核验知识 | 17 | 105–121 | 1（failure 1） |  |
| 46 | [08-inductors-ferrites-fuses.md](<./components/08-inductors-ferrites-fuses.md>) | 电感 / 磁珠 / 共模电感 / 保险丝 / PTC / 热敏电阻选型知识 | 18 | 122–139 | 14（module 2 · part 10 · failure 2） |  |
| 47 | [09-sensors-actuators.md](<./components/09-sensors-actuators.md>) | 传感器与执行器（温湿度 / 压力 / IMU / 霍尔 / 光电 / 麦克风 / 蜂鸣器 / 继电器 / 电机 / 电磁阀）选型知识 | 18 | 140–157 | 14（module 2 · part 10 · failure 2） |  |
| 48 | [10-interface-protection.md](<./components/10-interface-protection.md>) | 接口保护（ESD / TVS 阵列 / 共模滤波 / 隔离器 / 连接器保护）选型知识 | 18 | 158–175 | 14（module 2 · part 10 · failure 2） |  |
| 49 | [11-supply-chain.md](<./components/11-supply-chain.md>) | 供应链与元件生命周期管理（EOL / PCN / NRND / 双供 / 替代料 / 假货 / 批次追溯） | 18 | 176–193 | 6（rule 2 · module 2 · failure 2） |  |
| 50 | [12-library-management.md](<./components/12-library-management.md>) | 元件库管理（符号 / 封装 / 焊盘 / IPC-7351 / 版本与审核 / BOM 一致性） | 18 | 194–211 | 6（rule 2 · module 2 · failure 2） |  |
| 51 | [01-rpi-pico-rp2040.md](<./cases/01-rpi-pico-rp2040.md>) | 案例 01：Raspberry Pi Pico / RP2040 —— 2 层板的电源树、去耦与回流 | 11 | 01–11 | 1（case 1） |  |
| 52 | [02-arduino-uno-r3.md](<./cases/02-arduino-uno-r3.md>) | 案例 02：Arduino Uno R3 —— 双 MCU 架构、电源自动切换与 5 V 单板的热边界 | 10 | 01–10 | 2（rule 1 · case 1） |  |
| 53 | [03-esp32-devkit.md](<./cases/03-esp32-devkit.md>) | 案例 03：ESP32-DevKitC / ESP32-S3-DevKitC —— 无线模组底板的天线净空、峰值电流与自动下载 | 11 | 01–11 | 2（rule 1 · case 1） |  |
| 54 | [04-stm32-nucleo.md](<./cases/04-stm32-nucleo.md>) | 案例 04：ST STM32 Nucleo-64 官方参考设计 —— 把“供电选择、电流测量、调试隔离”做成可见连接 | 11 | 01–11 | 1（case 1） |  |
| 55 | [05-usb-c-pd-sink.md](<./cases/05-usb-c-pd-sink.md>) | 案例 05：USB-C PD 受电/充电参考设计 —— CC 是“通行证”，VBUS 开关与泄放是“安全闸” | 12 | 01–12 | 1（case 1） |  |
| 56 | [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) | 案例 06：同步 Buck 电源参考布局 —— 先管“热环路”，再谈纹波与效率 | 12 | 01–12 | 2（rule 1 · case 1） |  |
| 57 | [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) | 案例 07：隔离 CAN / RS485 工业节点参考设计 —— 隔离带是“结构”，不是一条分割线 | 12 | 01–12 | 2（rule 1 · case 1） |  |
| 58 | [08-wardrobe-v12.md](<./cases/08-wardrobe-v12.md>) | 案例 08：衣橱助手参考原理图 V1.2 —— ESP32-S3 整机的电源树、USB HUB 与音视频接口 | 10 | 01–10 | 3（rule 2 · case 1） |  |
| 59 | [09-wardrobe-v20.md](<./cases/09-wardrobe-v20.md>) | 案例 09：衣橱助手 V2.0（主板 + 按键灯板）—— 4 层异形板的电源树、天线净空与细间距 DFM | 10 | 01–10 | 4（rule 3 · case 1） |  |
| 60 | [10-circuitpilot-6l.md](<./cases/10-circuitpilot-6l.md>) | 案例 10：CircuitPilot 6 层监测板 —— 90Ω 差分反解、屏蔽过孔墙与“编译器抓出的 CC 缺失” | 10 | 01–10 | 2（rule 1 · case 1） |  |
| 61 | [11-ch32v003-p0.md](<./cases/11-ch32v003-p0.md>) | 案例 11：CircuitPilot CH32V003 P0 —— 45×30mm 2 层最小系统的成本极限 | 10 | 01–10 | 1（case 1） |  |
| 62 | [12-consumer-tws.md](<./cases/12-consumer-tws.md>) | 案例 12：消费电子 TWS / 可穿戴 —— 结构先定、电源其次，天线与音频是硬约束 | 11 | 01–11 | 1（module 1） |  |
| 63 | [13-industrial-controller.md](<./cases/13-industrial-controller.md>) | 案例 13：工业控制器 —— 宽压输入、隔离总线、宽温与抗扰是四条硬边界 | 11 | 01–11 | 1（module 1） |  |
| 64 | [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) | 案例 14：AC-DC / 适配器 —— 安规是设计输入，隔离带与热环路是两条命门 | 10 | 01–10 | 1（module 1） |  |
| 65 | [15-rf-module.md](<./cases/15-rf-module.md>) | 案例 15：RF 模组 / 天线 —— 50 Ω、净空、共存三件事决定“能不能连得远” | 10 | 01–10 | 1（module 1） |  |
| 66 | [16-flex-rigid-board.md](<./cases/16-flex-rigid-board.md>) | 案例 16：柔性 / 刚挠结合板 —— 弯折区是“结构件”，不是普通布线区 | 10 | 01–10 | 1（module 1） |  |
| 67 | [component-selection.md](<./checklists/component-selection.md>) | 选型评审清单（Component Selection Checklist） | 0 | — | 1（module 1） | 清单/专题，无 KP 编号 |
| 68 | [layout-review.md](<./checklists/layout-review.md>) | Layout 评审清单（PCB Layout Review Checklist） | 0 | — | 1（module 1） | 清单/专题，无 KP 编号 |
| 69 | [schematic-review.md](<./checklists/schematic-review.md>) | 原理图评审清单（Schematic Review Checklist） | 0 | — | 2（module 1 · failure 1） | 清单/专题，无 KP 编号 |
| 70 | [requirements.md](<./requirements/requirements.md>) | 衣橱助手 PCB 需求与验收清单（需求档案） | 0 | — | 0 | 需求档案，不进设计门禁 |

## 5. 完整知识点索引

按领域 → 文档 → 文档内顺序展开；`KP-CASE-*` 保持案例短名，不强行改成数字。

### PCB / 制造 / 可靠性

#### [01-design-rules.md](<./pcb/01-design-rules.md>) — PCB 设计规则数值基线（Layout → 制造）

- 文档：`docs/knowledge/pcb/01-design-rules.md`
- KP：**18**（01–18） · 结构化条目：**13**
- **KP-PCB-001** 载流能力由电流、铜厚、允许温升、层位四要素共同决定
- **KP-PCB-002** IPC-2152 载流参考表（1 oz、ΔT = 10 °C）
- **KP-PCB-003** 内层载流能力显著低于外层，内层只做平面
- **KP-PCB-004** 载流设计取 1.2 倍余量，峰值取 1.5 倍
- **KP-PCB-005** ≥1 A 优先用铜皮/平面，不靠单根走线
- **KP-PCB-006** 线距按工作电压分级，不按「信号/电源」拍脑袋
- **KP-PCB-007** 线距与工艺档：默认 0.15 mm，能力档只在必要处用
- **KP-PCB-008** 过孔孔径与孔环：Ø0.3/环宽 0.15 mm 是常规安全档
- **KP-PCB-009** 过孔载流按「每 A ≥2 孔」保守估算
- **KP-PCB-010** 焊盘与阻焊开窗：SMD 单边 0.05 mm、插件 0.10 mm
- **KP-PCB-011** 阻焊桥：绿色 ≥0.10 mm，其他颜色 ≥0.12 mm
- **KP-PCB-012** 丝印：字高 1.0 mm、线宽 0.15 mm、不压焊盘
- **KP-PCB-013** 板边距离：铜 ≥0.30 mm、元件 ≥0.50 mm
- **KP-PCB-014** 拼板与工艺边：工艺边 ≥5 mm，V-CUT/邮票孔按板厂能力
- **KP-PCB-015** 光学定位点（Fiducial）：每拼板 ≥3 个、Ø1.0/开窗 Ø2.0
- **KP-PCB-016** 测试点：Ø≥1.0 mm、间距 ≥2.54 mm、上方 15 mm 无遮挡
- **KP-PCB-017** 铜平衡、孤岛与酸角：残铜率 40–70%、孤岛必须处理
- **KP-PCB-018** 厂家能力数值必须带来源与日期，定期复核

#### [02-stackup-impedance.md](<./pcb/02-stackup-impedance.md>) — 叠层与阻抗控制（2/4/6 层）

- 文档：`docs/knowledge/pcb/02-stackup-impedance.md`
- KP：**18**（19–36） · 结构化条目：**7**
- **KP-PCB-019** 叠层的核心是「信号层必须有紧邻的完整参考平面」
- **KP-PCB-020** 两层板只有「外层微带」，参考面天然不完整
- **KP-PCB-021** 四层板推荐 S-G-P-S（外层信号、内层地与电源）
- **KP-PCB-022** 四层叠层顺序的取舍：地优先于电源
- **KP-PCB-023** 六层板两种典型叠层：S-G-S-S-G-S 与 S-G-S-P-G-S
- **KP-PCB-024** 参考平面完整性：跨分割次数必须为 0（高速/时钟/差分）
- **KP-PCB-025** 换层必须同时换回流：回流地过孔就近放置
- **KP-PCB-026** 50 Ω 单端微带线估算（IPC-2141 近似）
- **KP-PCB-027** 50 Ω 单端带状线估算（上下都有参考平面）
- **KP-PCB-028** 90 Ω / 100 Ω 差分阻抗估算
- **KP-PCB-029** 阻抗设计六步法（从目标到验收）
- **KP-PCB-030** 阻焊、铜厚、蚀刻对阻抗的影响不可忽略
- **KP-PCB-031** 阻抗测试条（coupon）必须与产品同叠层、同工艺
- **KP-PCB-032** 叠层对称与翘曲控制
- **KP-PCB-033** 介质材料与 PP/芯板：厚度与 εr 由板厂标准组合决定
- **KP-PCB-034** 铜厚选择：1 oz 常规、2 oz 大电流、0.5 oz 内层细线
- **KP-PCB-035** 高速过孔的 stub 与背钻
- **KP-PCB-036** 阻抗验收：±10% 为常规门槛，超差要闭环

#### [03-placement-routing.md](<./pcb/03-placement-routing.md>) — 布局与布线（Placement & Routing）

- 文档：`docs/knowledge/pcb/03-placement-routing.md`
- KP：**18**（37–54） · 结构化条目：**5**
- **KP-PCB-037** 布局先分区，再摆件：功能区块用矩形边界定死
- **KP-PCB-038** 按信号流向「一字型」布局，避免输入输出折返
- **KP-PCB-039** 电源区集中布置：输入保护 → DCDC → 电感 → 输出电容
- **KP-PCB-040** 模拟、数字、RF 分区：敏感电路远离噪声源
- **KP-PCB-041** 接口与保护器件：连接器沿边、ESD 先于芯片
- **KP-PCB-042** 器件朝向统一：只用 0°/90°，同类同向
- **KP-PCB-043** 器件间距按「courtyard + 吸嘴 + 返修 + 高件遮挡」四层判据
- **KP-PCB-044** 去耦电容摆位：小电容最近、GND 过孔就近、回路面积最小
- **KP-PCB-045** 晶振/时钟：靠芯片、包地、下方不走线
- **KP-PCB-046** 功率环路面积最小化：输入环路优先
- **KP-PCB-047** 大电流路径用铜皮 + 过孔阵列，不靠单线
- **KP-PCB-048** 差分对：等宽、等距、同层、少过孔、不跨分割
- **KP-PCB-049** 等长匹配：先对内、再对间，蛇形线不能自耦合
- **KP-PCB-050** 换层必须换回流：信号过孔旁就近放地过孔
- **KP-PCB-051** RF 走线与天线：50 Ω 短直、禁 stub、净空优先
- **KP-PCB-052** 地平面：完整优先、不随意分割、需要时单点连接
- **KP-PCB-053** 热焊盘与散热过孔：先把热从芯片引到铜皮
- **KP-PCB-054** 布局布线完成检查：先看回流与环路，再看 DRC

#### [04-power-integrity-decoupling.md](<./pcb/04-power-integrity-decoupling.md>) — 电源完整性与去耦（Power Integrity & Decoupling）

- 文档：`docs/knowledge/pcb/04-power-integrity-decoupling.md`
- KP：**17**（55–71） · 结构化条目：**4**
- **KP-PCB-055** 目标阻抗由允许纹波与负载瞬态电流决定
- **KP-PCB-056** 目标阻抗算例：3.3 V/1 A 与 1.0 V/10 A 差两个数量级
- **KP-PCB-057** 电容阻抗-频率曲线：自谐振频率以上呈感性
- **KP-PCB-058** 容值组合要防「反谐振峰」，不是越多越好
- **KP-PCB-059** 去耦半径：受波长与安装电感共同限制
- **KP-PCB-060** 安装电感由过孔与环路决定：一个 GND 过孔不够
- **KP-PCB-061** 电源平面是「中频去耦」，也是腔体谐振器
- **KP-PCB-062** 电源平面分割按电源域，桥接要够宽、跨分割要加缝合电容
- **KP-PCB-063** DC-DC 输入环路：最小化「输入电容—开关—地」
- **KP-PCB-064** DC-DC 输出环路与反馈：反馈要 Kelvin 取样、远离电感
- **KP-PCB-065** 地平面回流：高频走最低电感路径，不是「最短路径」
- **KP-PCB-066** 地分割误区：默认不分割，模拟地单点只在必要时用
- **KP-PCB-067** 平面过孔缝合：间距按最高频率的 λ/20 取
- **KP-PCB-068** 平面载流与压降：1 oz 铜每方块约 0.49 mΩ
- **KP-PCB-069** 量测点：纹波用短地弹簧、阻抗用 VNA 双端口
- **KP-PCB-070** 去耦布局检查：距离、过孔、回路面积三件套
- **KP-PCB-071** PDN 交付物：目标阻抗表、电容清单、仿真/实测报告

#### [05-emc-esd-thermal.md](<./pcb/05-emc-esd-thermal.md>) — EMC / ESD / 热设计（板级）

- 文档：`docs/knowledge/pcb/05-emc-esd-thermal.md`
- KP：**17**（72–88） · 结构化条目：**8**
- **KP-PCB-072** EMC 三要素：源、耦合路径、天线，按顺序处理
- **KP-PCB-073** 辐射发射：差模看环路，共模看线缆与地
- **KP-PCB-074** 传导发射：电源入口滤波 + 低阻抗回流
- **KP-PCB-075** 开关节点（SW）：铜皮够用就好，不要当散热片
- **KP-PCB-076** 时钟与高速信号：短、直、包地、不跨分割
- **KP-PCB-077** 接口滤波 + TVS 摆放：TVS 最靠接口，滤波在其后
- **KP-PCB-078** TVS 选型与低电感接地：钳位电压要低于芯片绝对最大额定
- **KP-PCB-079** 接地策略：整片地优先，单点/混合接地只在必要时用
- **KP-PCB-080** 屏蔽罩：接地过孔间距 ≤λ/20，罩内不走过长线
- **KP-PCB-081** 线缆与连接器：线缆是最大天线，接口处就要处理
- **KP-PCB-082** ESD 放电路径：给电流一条「短、宽、低感」的路
- **KP-PCB-083** 热阻链：Tj = Ta + P × θJA，θJA 不是常数
- **KP-PCB-084** 热阻估算流程：功耗 → θJA → 温升 → 降额
- **KP-PCB-085** 散热焊盘与热过孔阵列：把热从焊盘引到内层/底层
- **KP-PCB-086** 铜皮散热面积：1 W 约需 ≥100 mm²（1 oz、单面、自然对流）
- **KP-PCB-087** 热仿真与实测：先算再测，测点要可复现
- **KP-PCB-088** EMC/热评审清单：投板前逐项签字

#### [06-dfm-manufacturing.md](<./pcb/06-dfm-manufacturing.md>) — DFM 与制造文件（制造前闭环）

- 文档：`docs/knowledge/pcb/06-dfm-manufacturing.md`
- KP：**18**（089–106） · 结构化条目：**13**
- **KP-PCB-089** Gerber：层齐全、单位一致、板框闭合
- **KP-PCB-090** 钻孔文件：PTH/NPTH 分开、槽孔与孔表齐全
- **KP-PCB-091** 阻焊层：开窗、阻焊桥、过孔盖油/塞孔
- **KP-PCB-092** 丝印层：位号、极性、1 脚、不被板边裁掉
- **KP-PCB-093** 钢网/Paste：只含焊接焊盘、面积比达标
- **KP-PCB-094** BOM：位号、料号、封装、数量、DNP、替代料一致
- **KP-PCB-095** 坐标文件（Pick & Place）：原点、角度、面别统一
- **KP-PCB-096** 拼板：V-CUT/邮票孔、工艺边、Mark、定位孔一次到位
- **KP-PCB-097** Mark 与定位孔：贴片机的「眼睛」和「脚」
- **KP-PCB-098** 贴片方向与极性：同类同向、极性标识可读
- **KP-PCB-099** 板厚、表面处理、颜色、工艺说明：写进工艺单
- **KP-PCB-100** 制造前检查清单：8 类 30 项，逐项签字
- **KP-PCB-101** 常见退单原因 Top 10（按发生频率）
- **KP-PCB-102** 工程确认单（EQ）：所有偏离必须书面闭环
- **KP-PCB-103** 首件 FAI：AOI + X-ray + 外观 + 功能 + 阻抗
- **KP-PCB-104** 版本与变更：ECO 管住「改一点」
- **KP-PCB-105** 成本与交期优化：先动拼板与层数，再动工艺
- **KP-PCB-106** 交付物与验收：一套文件、一个版本、一份清单

#### [07-multilayer-highspeed.md](<./pcb/07-multilayer-highspeed.md>) — 多层高密度与高速设计（6 层及以上）

- 文档：`docs/knowledge/pcb/07-multilayer-highspeed.md`
- KP：**30**（107–136） · 结构化条目：**25**
- **KP-PCB-107** 8 层板优先保证“每个信号层都有相邻完整平面”，再谈布线密度
- **KP-PCB-108** 电源/地平面成对放置，间距越小平面电容越大、电源阻抗越低
- **KP-PCB-109** 10/12 层板用“多个信号-地平面对 + 对称结构”扩展，而不是简单加信号层
- **KP-PCB-110** 叠层对称与铜平衡是多层板翘曲控制的第一原则
- **KP-PCB-111** 层数选择的判据是“独立布线通道 + 电源域 + 参考面”，不是“信号多”
- **KP-PCB-112** 通孔、盲埋孔、微孔按“速率/引脚密度/成本”三要素选择
- **KP-PCB-113** 微孔（laser via）按“孔径/纵横比/叠孔方式”设计，禁止无支撑的叠孔
- **KP-PCB-114** 高速过孔的 stub 必须控制：能盲埋就盲埋，不能就背钻
- **KP-PCB-115** 过孔纵横比（aspect ratio）按板厂能力控制，厚板尤其危险
- **KP-PCB-116** 换层过孔旁必须就近布置回流地孔，差分对换层要成对换
- **KP-PCB-117** 反焊盘（antipad）与焊盘尺寸决定过孔阻抗，不能只按“最小间距”画
- **KP-PCB-118** 差分对“对内等长、对间等长、等距、同参考”四项必须同时满足
- **KP-PCB-119** 并行总线按“字节通道/组”等长，不要全局等长
- **KP-PCB-120** 串扰控制：间距优先，3W 是底线、5W 更稳，带状线优于微带
- **KP-PCB-121** 玻璃纤维效应（fiber weave）会让差分对内偏斜，10° 布线或低 Dk 材料可缓解
- **KP-PCB-122** 高速信号跨分割次数必须为 0；无法避免时加缝合电容并记录例外
- **KP-PCB-123** 阻抗公差按协议/板厂能力定义，差分阻抗与单端阻抗分别验收
- **KP-PCB-124** 高速串行接口的 AC 耦合电容、ESD 与连接器位置要按协议放
- **KP-PCB-125** 目标阻抗法：Ztarget = 允许纹波 / 瞬态电流，按频段分配去耦
- **KP-PCB-126** 电源平面分割要“按域、按电流、按回流”设计，禁止细长瓶颈与跨分割
- **KP-PCB-127** 平面腔体谐振：大平面要评估谐振频率，用缝合电容/分割/阻尼抑制
- **KP-PCB-128** VRM 远端 sense 与反馈走线要避开大电流/开关节点
- **KP-PCB-129** 高速链路要做损耗预算：Df、铜箔粗糙度、过孔 stub、连接器都要计入
- **KP-PCB-130** 混压/多层材料要匹配 CTE 与压合参数，防止分层/翘曲
- **KP-PCB-131** 多层板要防 CAF（导电阳极丝）：材料、钻孔、清洁、压合四管齐下
- **KP-PCB-132** 多层板热设计：热过孔阵列 + 内层铜平面 + 散热焊盘
- **KP-PCB-133** 屏蔽与接地缝合：屏蔽罩/板边屏蔽要连续接地，缝合孔间距按最高频率
- **KP-PCB-134** 多层板必须做阻抗测试条 + TDR 验收，不能只看计算书
- **KP-PCB-135** 高速链路用 VNA/眼图/BER 验收，按协议做一致性测试
- **KP-PCB-136** 多层板制造验收：切片、X-Ray、AOI、翘曲、CAF/热循环按可靠性等级执行

#### [08-component-placement.md](<./pcb/08-component-placement.md>) — 元器件布局与部署位置的依据规则（市场实际做法）

- 文档：`docs/knowledge/pcb/08-component-placement.md`
- KP：**30**（137–166） · 结构化条目：**26**
- **KP-PCB-137** 每条布局规则必须有“依据链”，禁止只写“经验”
- **KP-PCB-138** IPC-2221B/2222B 的布局原则：分区、热、机械、可制造、可测试
- **KP-PCB-139** IPC-7351B 的 courtyard 是“最小间距”的基准，不是随便留 0.2mm
- **KP-PCB-140** IPC-A-610/J-STD-001 把“可焊、可检、可返修”变成布局约束
- **KP-PCB-141** J-STD-020 的 MSL/回流曲线影响布局与工艺窗口
- **KP-PCB-142** IPC-7093（底部端子器件）决定 QFN/BGA 的散热、过孔与间距
- **KP-PCB-143** datasheet 的 Layout/Application 章节是布局首选依据，要原文摘录成检查项
- **KP-PCB-144** 去耦电容：依据回路电感 ΔV=L·di/dt，距离和过孔决定 L（已核对 TI）
- **KP-PCB-145** 晶振：依据负载电容/寄生电容/驱动电平，靠芯片、包地、下方不走线
- **KP-PCB-146** DC-DC：依据输入热环路 di/dt，输入电容紧贴 VIN/GND，SW 节点最小
- **KP-PCB-147** 模拟/数字分区：依据地回流与耦合，敏感电路远离噪声源
- **KP-PCB-148** RF 模组：依据天线净空/参考地/50Ω，模组靠板边、天线朝外
- **KP-PCB-149** ESD 器件：依据残压与走线电感，连接器→TVS→IC，地短而宽
- **KP-PCB-150** 连接器：依据插拔力/机械应力/面板开孔，靠边、补强、避免受力
- **KP-PCB-151** 器件间距的“市场规则”= courtyard + 吸嘴 + 返修 + 高件遮挡四层判据
- **KP-PCB-152** 器件朝向：同类同向、极性一致、连接器开口朝外（量产板惯例）
- **KP-PCB-153** 板边/拼板：元件距板边留工艺余量，V-CUT/邮票孔应力区禁放
- **KP-PCB-154** 波峰焊/选择性焊：阴影效应与偷锡焊盘决定通孔件布局
- **KP-PCB-155** 可测试性：测试点按探针网格布置，留 ICT/FCT 空间
- **KP-PCB-156** 可返修：热风/烙铁空间与屏蔽罩可拆性决定长期成本
- **KP-PCB-157** 热布局：热源分散、热过孔、远离热敏感件（市场消费/工业板通用）
- **KP-PCB-158** 机械/结构：安装孔、板刚度、连接器受力与外壳间隙
- **KP-PCB-159** 市场分层：消费电子、工业、开发板的布局差异
- **KP-PCB-160** 成本/密度权衡：封装、层数、拼板利用率共同决定布局
- **KP-PCB-161** 规则冲突裁决顺序：安全 > 功能 > EMC/SI > DFM/DFA > 成本/面积
- **KP-PCB-162** 每条布局规则必须可量测：距离、面积、温度、阻抗、时间
- **KP-PCB-163** 布局评审证据：截图、量测、3D、DFM/DFA 报告与签核
- **KP-PCB-164** 市场证据的采集与验证：公开参考设计/评估板/拆解，标注来源与日期
- **KP-PCB-165** 布局与布线/叠层耦合：布局阶段就锁定回流、阻抗与层数
- **KP-PCB-166** 量产反馈闭环：DFM/ICT/返修/客诉数据回写布局规则

#### [09-reliability-derating.md](<./pcb/09-reliability-derating.md>) — 可靠性与降额设计（寿命、环境试验、鉴定与闭环）

- 文档：`docs/knowledge/pcb/09-reliability-derating.md`
- KP：**34**（167–200） · 结构化条目：**10**
- **KP-PCB-167** 可靠性指标必须写清“口径 + 条件”，不能只写“高可靠”
- **KP-PCB-168** 任务剖面（mission profile）是降额、寿命与试验条件的共同输入
- **KP-PCB-169** 降额、试验、FMEA 三条证据链缺一不可
- **KP-PCB-170** 可靠性证据分级：区分“标准要求 / 厂商承诺 / 实测 / 经验”
- **KP-PCB-171** 降额的定义与算法：先算应力比，再按器件类型查表
- **KP-PCB-172** 电阻降额：功率、电压、温度三重校核，脉冲要单独算
- **KP-PCB-173** 电容降额：MLCC 看电压/温度/DC bias，钽电容最怕过压与浪涌
- **KP-PCB-174** 电感/磁珠降额：饱和电流、温升电流、DCR 三项都要看
- **KP-PCB-175** 二极管/MOSFET 降额：电压、电流之外必须看结温与 SOA/雪崩
- **KP-PCB-176** IC/连接器/继电器降额：输出电流、触点电流与温升是主应力
- **KP-PCB-177** PCB 本体降额：走线/过孔/焊盘按温升与电流密度设计
- **KP-PCB-178** 降额门禁：BOM 自动算应力比，超限清单必须签核
- **KP-PCB-179** Arrhenius 温度加速：AF = exp[Ea/k·(1/T_use − 1/T_test)]，Ea 必须来自数据
- **KP-PCB-180** “10 °C 法则”只是粗略经验，不能替代 Ea 计算与厂商公式
- **KP-PCB-181** 焊点热疲劳用 Coffin-Manson：寿命随 ΔT 的 n 次方下降
- **KP-PCB-182** 电解电容寿命：厂商公式 + 纹波自发热，不能只看环境温度
- **KP-PCB-183** 浴盆曲线与早期失效：筛选只能压早期，不能改固有寿命
- **KP-PCB-184** 失效机理清单：先列机理，再选试验，不要“一套试验打天下”
- **KP-PCB-185** 寿命预算：整机寿命由最短寿命件决定，必须做“短板分析”
- **KP-PCB-186** 可靠性与成本：降额和选型是“用 BOM 成本换保修成本”
- **KP-PCB-187** 环境试验矩阵按任务剖面裁剪：温度、湿热、振动、冲击、腐蚀
- **KP-PCB-188** 温度循环/热冲击：温变速率、驻留时间与循环数决定暴露的机理
- **KP-PCB-189** 湿热与偏压：THB/HAST 针对电化学迁移，条件必须含偏压与监测
- **KP-PCB-190** 机械试验：振动、冲击、跌落按“使用+运输”两套条件
- **KP-PCB-191** 腐蚀与表面处理：盐雾/混合气体/硫化按环境选，镀层与三防要匹配
- **KP-PCB-192** 环境试验的样本量与判据：没有样本量就没有统计结论
- **KP-PCB-193** 加速试验外推：先验证失效机理一致，再谈加速因子
- **KP-PCB-194** 器件鉴定看 JESD47/JESD22，板级鉴定看 IPC-9592B/IPC-9701，两者不能互相替代
- **KP-PCB-195** 车规/高可靠场景：AEC-Q100/Q200 等级与温度等级必须匹配任务剖面
- **KP-PCB-196** HALT/HASS：HALT 找极限、HASS 筛缺陷，都不等于“鉴定通过”
- **KP-PCB-197** FMEA/DFMEA：用严重度×发生度×探测度排序，措施要落到设计/测试
- **KP-PCB-198** MTBF 口径：Telcordia/MIL-HDBK-217/IEC 61709 各有假设，不能横比
- **KP-PCB-199** 关键单点失效与 FTA：一个器件坏就整机失效的点必须单独管
- **KP-PCB-200** 现场数据闭环：FRACAS/ORT 把失效变成规则与选型变更

#### [10-testability-production-test.md](<./pcb/10-testability-production-test.md>) — 可测试性与量产测试（DFT、测试点、ICT/FCT、边界扫描与产测流程）

- 文档：`docs/knowledge/pcb/10-testability-production-test.md`
- KP：**28**（201–228） · 结构化条目：**8**
- **KP-PCB-201** DFT 必须从原理图/布局阶段介入，测试成本随发现阶段指数上升
- **KP-PCB-202** 测试策略按“缺陷谱”分层选择，不能指望单一手段包打天下
- **KP-PCB-203** 可测网络覆盖率是硬门禁：关键网络 100%，整体按项目定义
- **KP-PCB-204** 可达性三选一：测试盘、探针接触焊盘/过孔、连接器/调试口
- **KP-PCB-205** 测试点会改变信号：高频/高阻/低电平节点要评估 stub 与负载影响
- **KP-PCB-206** 测试盘几何按治具能力定：直径、间距、网格、开窗一次到位
- **KP-PCB-207** 测试点位置：优先单面、避开高件/板边/拼板应力区、保证探针垂直可达
- **KP-PCB-208** 网络选择：每个电源域/地/复位/时钟/调试口必测，模拟节点按精度要求取舍
- **KP-PCB-209** 测试点与过孔/焊盘共用：可以，但要满足“露铜、平整、不被塞孔/盖油”
- **KP-PCB-210** 测试点命名、丝印与坐标：程序/治具/文档三方一致
- **KP-PCB-211** 测试点数量与布局冲突：按“关键性 > 可测性 > 面积/美观”裁决
- **KP-PCB-212** ICT 原理与能力边界：测开路/短路/元件值/极性，不测功能
- **KP-PCB-213** 治具设计：探针选型、弹簧力、导向、真空/压合、防呆与寿命
- **KP-PCB-214** ICT 可测性约束：并联网络、大电容、低阻节点、双面/屏蔽要特殊处理
- **KP-PCB-215** 飞针测试：适合小批量/高密度/无治具，但不适合大批量产
- **KP-PCB-216** ICT 误判与接触不良预防：清洁、压力、氧化、地回路、程序判据
- **KP-PCB-217** FCT 覆盖关键功能与边界条件，不能只测“能开机”
- **KP-PCB-218** 产测流程按缺陷拦截效率排序：SPI→AOI→X-ray→ICT→FCT→老化→终检
- **KP-PCB-219** 测试程序/治具/固件/BOM 版本必须对齐，ECO 要同步测试资产
- **KP-PCB-220** 老化/烧机只筛早期失效，不能替代 ICT/FCT 与设计验证
- **KP-PCB-221** 产测数据是质量资产：FPY、DPPM、误判率、追溯与 SPC
- **KP-PCB-222** IEEE 1149.1 边界扫描：用 TAP 访问器件引脚，测互连不靠探针
- **KP-PCB-223** 扫描链设计：拓扑、电平、参考电压、链路长度与保护
- **KP-PCB-224** IEEE 1149.6：AC 耦合/差分链路的边界扫描
- **KP-PCB-225** 边界扫描覆盖率：互连覆盖率与器件覆盖率分开统计
- **KP-PCB-226** DFT 评审表与门禁：覆盖率、治具、程序、误判率四项签字
- **KP-PCB-227** X-ray/AOI 的可测性设计：BGA/底部端子/遮挡与视角
- **KP-PCB-228** 小批量试产是可测性的最终验证：治具、程序、覆盖率、误判率、节拍

#### [11-safety-certification.md](<./pcb/11-safety-certification.md>) — 安规与认证（IEC 62368-1、EMC、市场准入与电池安全）

- 文档：`docs/knowledge/pcb/11-safety-certification.md`
- KP：**28**（229–256） · 结构化条目：**8**
- **KP-PCB-229** 适用标准由“产品类型 + 输入电压 + 使用环境”决定，不能默认套 62368-1
- **KP-PCB-230** IEC 62368-1 的核心方法：能量源分级（ES/PS/TS/RS）+ 安全防护
- **KP-PCB-231** 绝缘类型：功能/基本/附加/双重/加强，决定“几层、多厚、多远”
- **KP-PCB-232** 间距计算的四个输入：工作电压、污染等级、材料组、过压类别（+海拔）
- **KP-PCB-233** 爬电距离 ≠ 电气间隙：一个沿表面、一个过空气，失效机理不同
- **KP-PCB-234** 海拔、涂层、开槽/筋、污染等级会改变间距要求，必须逐项声明
- **KP-PCB-235** 爬电距离按“实测工作电压 + 污染等级 + 材料组”查表，不能套固定毫米数
- **KP-PCB-236** 电气间隙按冲击电压/过压类别/海拔查表，瞬态是主应力
- **KP-PCB-237** 开槽/加强筋/三防涂覆能帮忙，但必须满足标准条件，不能“想当然”
- **KP-PCB-238** 隔离带布局：Y 电容、光耦、变压器、数字隔离器各有各的间距与证书
- **KP-PCB-239** 市电区 PCB 规则：保险丝、L/N、PE、放电电阻、压敏/热敏电阻的位置与间距
- **KP-PCB-240** 耐压（hipot）测试：区分型式试验与例行试验，判据与失效要可追溯
- **KP-PCB-241** EMC 标准选择：发射、抗扰、谐波/闪烁分属不同标准
- **KP-PCB-242** IEC 61000-4 系列抗扰测试项与常见等级：按产品环境选，不是越高越好
- **KP-PCB-243** EMC 预测试与裕量：正式认证前至少留 6 dB 量级裕量（经验）
- **KP-PCB-244** 认证样品必须按“最不利配置”准备：线缆、外壳、负载、软件状态
- **KP-PCB-245** EMC 整改优先级：先接口/线缆/回流，再屏蔽/滤波，最后改板
- **KP-PCB-246** CE/UKCA/FCC/UL/CCC 的差异：强制性与证据形式不同
- **KP-PCB-247** 技术文件（TCF）与 DoC：认证的“证据包”，不是一张证书
- **KP-PCB-248** GB 31241-2022：便携式锂电“使用安全”的测试项与设计输入
- **KP-PCB-249** UN38.3：锂电池运输强制测试 T1–T8，报告与样品状态要匹配
- **KP-PCB-250** IEC 62133-2 / UL 2054 / UL 1642：电池“安全认证”与运输测试不是一回事
- **KP-PCB-251** 电池包 PCB/BMS 安规：过充/过放/过流/短路/温度保护要“可验证”
- **KP-PCB-252** 认证测试项清单与送样状态：先列全，再排期
- **KP-PCB-253** 认证失败常见项与整改证据：间距、耐压、温升、EMC、电池保护
- **KP-PCB-254** 关键元器件认证与 BOM 一致性：安规件必须有证，换料要评估
- **KP-PCB-255** 标签/铭牌/说明书合规：额定值、警告语、认证标志、电池标识
- **KP-PCB-256** 认证变更管理：ECO/PCN 要判断“是否影响认证”，不能默默改

#### [12-flex-rigid-flex.md](<./pcb/12-flex-rigid-flex.md>) — 柔性板与刚挠结合板设计（Flex / Rigid-Flex）

- 文档：`docs/knowledge/pcb/12-flex-rigid-flex.md`
- KP：**26**（257–282） · 结构化条目：**8**
- **KP-PCB-257** 柔性板 = PI 基材 + 铜 + 覆盖膜，先定层结构再谈布线
- **KP-PCB-258** 覆盖膜 vs 阻焊油墨：动态弯折区必须覆盖膜
- **KP-PCB-259** 覆盖膜开窗与焊盘：开窗要「大一点、对得准、不盖焊盘」
- **KP-PCB-260** 补强板：连接器、SMT、插拔区必须局部加硬
- **KP-PCB-261** 静态弯折半径：按总厚的 6–10 倍起步
- **KP-PCB-262** 动态弯折半径：按总厚的 20–100 倍并必须实测寿命
- **KP-PCB-263** 弯折区走线：垂直弯折线、圆弧过渡、少铜/网格铜
- **KP-PCB-264** 弯折区禁过孔、禁镀通孔、禁器件
- **KP-PCB-265** 刚挠结合过渡区：应力释放与覆盖膜去除要一起做
- **KP-PCB-266** 刚挠板叠层：刚性层与挠性层分别对称，压合次数受控
- **KP-PCB-267** 金手指/ZIF：厚度、镀金、倒角与插入方向
- **KP-PCB-268** 柔性连接器选型：ZIF/FFC/板对板/热压，按插拔次数与空间选
- **KP-PCB-269** 柔性板阻抗控制：材料 Dk/Df 与胶层厚度决定阻抗
- **KP-PCB-270** 柔性板载流与散热：铜薄、散热差，按最窄处降额
- **KP-PCB-271** 柔性板屏蔽：银浆/铜箔屏蔽层要连续接地
- **KP-PCB-272** 柔性板接地与 ESD：给放电电流一条短而宽的路
- **KP-PCB-273** 柔性板 SMT：托盘/支撑、低温回流、防翘曲
- **KP-PCB-274** 柔性板拼板与工艺边：用「框+桥」而不是 V-CUT
- **KP-PCB-275** 柔性板表面处理：ENIG/硬金/OSP 按接触与焊接需求选
- **KP-PCB-276** 柔性板测试：通断、阻抗、弯折寿命、外观四件套
- **KP-PCB-277** 柔性板常见失效：铜裂、分层、覆盖膜脱落、补强剥离
- **KP-PCB-278** 柔性板存储与装配：防潮、防折、防拉
- **KP-PCB-279** 柔性板 DFM 清单：10 项投板前必查
- **KP-PCB-280** 刚挠板机械与结构：弯折区与安装点分开受力
- **KP-PCB-281** 弯折寿命估算：只能做量级估算，最终必须实测
- **KP-PCB-282** 柔性板评审清单：材料/弯折/连接/工艺四组签字

#### [13-package-assembly-rework.md](<./pcb/13-package-assembly-rework.md>) — 封装、装配与返修（BGA / QFN / WLCSP）

- 文档：`docs/knowledge/pcb/13-package-assembly-rework.md`
- KP：**26**（283–308） · 结构化条目：**8**
- **KP-PCB-283** 封装选型先匹配工艺能力，再谈电气/成本
- **KP-PCB-284** QFN 焊盘：按 IPC-7351 密度等级 + 散热焊盘 + 外延
- **KP-PCB-285** QFN 钢网与 AOI：面积比、散热焊盘开窗、侧面爬锡可检
- **KP-PCB-286** BGA 焊盘：NSMD 优先，焊盘/阻焊开窗/过孔按规范
- **KP-PCB-287** BGA 空洞判据：按面积百分比 + 位置，不只看「有没有」
- **KP-PCB-288** 枕头效应（HoP）：焊球未与焊膏熔合，X-ray 难发现
- **KP-PCB-289** WLCSP：焊盘小、应力大，底部填充/NSMD 与板级应力要一起管
- **KP-PCB-290** 底部填充（underfill）：材料、填充路径与返修性一起选
- **KP-PCB-291** 焊盘坑裂（pad cratering）：板级弯曲/返修应力导致焊盘从树脂脱落
- **KP-PCB-292** 封装翘曲（warpage）：来料与回流温度都要控
- **KP-PCB-293** MSL 湿度等级与烘烤：floor life 超期必须烘烤
- **KP-PCB-294** 回流曲线：按焊膏 + 器件 + 板厚测，不抄「通用曲线」
- **KP-PCB-295** 返修前评估：层数、邻件、热敏、焊盘损伤风险
- **KP-PCB-296** BGA 返修：预热—拆除—除胶—植球—对位—回流—检验
- **KP-PCB-297** QFN/WLCSP 返修：热风+底部预热，避免吹飞小器件
- **KP-PCB-298** 返修后检验：X-ray + AOI + 电测 + 必要时切片
- **KP-PCB-299** 返修次数与可靠性：一般不超过 2–3 次，超限评估报废
- **KP-PCB-300** 焊点可靠性试验：热循环、跌落、弯曲、振动按场景选
- **KP-PCB-301** 焊点失效分析：外观→X-ray→染色→切片→SEM/EDS 逐级做
- **KP-PCB-302** 三防漆/灌胶与返修兼容：先想清楚「以后怎么拆」
- **KP-PCB-303** 分板应力：V-CUT/邮票孔/铣边都会把应力传到焊点
- **KP-PCB-304** 连接器/通孔件装配应力：固定脚、补强、螺柱要一起设计
- **KP-PCB-305** 共面性与装配公差：BGA/连接器/屏蔽罩都要看
- **KP-PCB-306** 来料检验：MSL、包装、焊球、共面度、可焊性
- **KP-PCB-307** 装配 DFM 清单：封装/焊盘/钢网/返修/检测五项闭环
- **KP-PCB-308** 返修记录与追溯：谁、何时、哪颗、几次、结果

#### [14-high-speed-protocols.md](<./pcb/14-high-speed-protocols.md>) — 高速协议与接口设计（USB3/4、PCIe、以太网、MIPI、HDMI、SDIO）

- 文档：`docs/knowledge/pcb/14-high-speed-protocols.md`
- KP：**32**（309–340） · 结构化条目：**8**
- **KP-PCB-309** 高速通道先做损耗预算，再决定层数/材料/长度
- **KP-PCB-310** USB 3.x：5/10/20 Gbps，差分 90 Ω，全链路参考平面连续
- **KP-PCB-311** USB4 / Thunderbolt：更高速率，损耗与连接器要求更严
- **KP-PCB-312** USB3 AC 耦合电容：位置、容值、封装与阻抗连续
- **KP-PCB-313** PCIe Gen3–Gen5：8/16/32 GT/s，差分阻抗按规范
- **KP-PCB-314** PCIe AC 耦合与 ESD：电容/保护器件不能破坏通道
- **KP-PCB-315** PCIe 参考时钟：100 MHz 差分、低抖动、远离噪声
- **KP-PCB-316** PCIe 连接器/金手指：阻抗受控、stub 短、地针完整
- **KP-PCB-317** 以太网 1G/2.5G/10G：MDI 差分 100 Ω，变压器/PHY 布局关键
- **KP-PCB-318** 以太网 PHY/变压器布局：隔离带、地分割与回流
- **KP-PCB-319** PoE：电流、温升、隔离与 PD 检测一起设计
- **KP-PCB-320** MIPI D-PHY：100 Ω 差分、速率/通道按规范
- **KP-PCB-321** MIPI C-PHY：三线组（trio）布线与对称性
- **KP-PCB-322** HDMI 2.0/2.1：TMDS/FRL 差分 100 Ω，通道预算按版本
- **KP-PCB-323** HDMI 连接器/ESD/5V：保护与高速共存
- **KP-PCB-324** SDIO/eMMC：单端 50 Ω、时钟/CMD/DAT 等长与上拉
- **KP-PCB-325** 高速连接器选型：阻抗、stub、串扰、插拔与成本
- **KP-PCB-326** AC 耦合/共模电感/ESD 的位置：按「信号流向 + 阻抗连续」排
- **KP-PCB-327** 高速过孔/背钻/stub：能少则少、能短则短
- **KP-PCB-328** 参考平面与跨分割：高速对跨分割次数必须为 0
- **KP-PCB-329** 损耗预算：Df、铜粗糙度、过孔、连接器、线缆都要算
- **KP-PCB-330** 眼图/BER：按协议模板与测试点验收
- **KP-PCB-331** TDR/VNA 与去嵌：先校准，再谈阻抗/损耗
- **KP-PCB-332** 测试夹具/探头/校准：夹具也是通道的一部分
- **KP-PCB-333** 协议一致性认证：先预测试，再送认证
- **KP-PCB-334** SI 仿真流程：模型—叠层—通道—眼图—迭代
- **KP-PCB-335** 高速接口 ESD：低电容、短地回路、靠连接器
- **KP-PCB-336** 共模与屏蔽：高速接口的共模电流要在线缆/连接器处处理
- **KP-PCB-337** 低损耗材料选型：Df 与铜粗糙度决定高频损耗
- **KP-PCB-338** 差分对间串扰：间距、屏蔽、走向与协议预算
- **KP-PCB-339** 高速接口电源与时钟：低噪声、低抖动
- **KP-PCB-340** 高速协议评审清单：协议/通道/连接器/测试四组签字

#### [15-circuitpilot-recheck-truthfulness.md](<./pcb/15-circuitpilot-recheck-truthfulness.md>) — 15. 复核真值性：包围盒、双面、证据绑定（CircuitPilot 真机教训）

- 文档：`docs/knowledge/pcb/15-circuitpilot-recheck-truthfulness.md`
- KP：**0** · 结构化条目：**5**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

#### [16-fine-pitch-escape.md](<./pcb/16-fine-pitch-escape.md>) — 16. 细间距逃逸与扇出：判定数学与真机标定

- 文档：`docs/knowledge/pcb/16-fine-pitch-escape.md`
- KP：**0** · 结构化条目：**4**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

#### [17-circuitpilot-mechanical-capability-gaps.md](<./pcb/17-circuitpilot-mechanical-capability-gaps.md>) — 17 · CircuitPilot 机械要素能力边界与参考工程对标方法（本轮真机记录）

- 文档：`docs/knowledge/pcb/17-circuitpilot-mechanical-capability-gaps.md`
- KP：**0** · 结构化条目：**9**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

#### [18-four-layer-planes-mech-holes-and-research-limits.md](<./pcb/18-four-layer-planes-mech-holes-and-research-limits.md>) — 四层板电源平面、机械孔近似与外部检索受限（r45–r46）

- 文档：`docs/knowledge/pcb/18-four-layer-planes-mech-holes-and-research-limits.md`
- KP：**0** · 结构化条目：**4**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

#### [19-camera-interface-gc0308-and-eda-netlist-edit-limits.md](<./pcb/19-camera-interface-gc0308-and-eda-netlist-edit-limits.md>) — 19. 相机接口（GC0308/DVP）与 EDA 网表编辑边界

- 文档：`docs/knowledge/pcb/19-camera-interface-gc0308-and-eda-netlist-edit-limits.md`
- KP：**0** · 结构化条目：**4**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

#### [20-researched-layout-constraints.md](<./pcb/20-researched-layout-constraints.md>) — PCB 布局约束：公开资料与真实参考设计研究（2026-10-23）

- 文档：`docs/knowledge/pcb/20-researched-layout-constraints.md`
- KP：**0** · 结构化条目：**29**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

#### [21-eda-api-eco-playbook.md](<./pcb/21-eda-api-eco-playbook.md>) — 21. 用 EDA 插件 API 对既有工程做受控 ECO（相机 GC0308 实战）

- 文档：`docs/knowledge/pcb/21-eda-api-eco-playbook.md`
- KP：**0** · 结构化条目：**12**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

#### [22-ai-assisted-layout-and-readable-schematic.md](<./pcb/22-ai-assisted-layout-and-readable-schematic.md>) — 22. AI 辅助布局的功能分区与"可读原理图"验收

- 文档：`docs/knowledge/pcb/22-ai-assisted-layout-and-readable-schematic.md`
- KP：**0** · 结构化条目：**2**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

#### [23-lceda-project-workflow-and-bilibili-course.md](<./pcb/23-lceda-project-workflow-and-bilibili-course.md>) — 23. 嘉立创EDA专业版工程闭环与 B 站课程学习笔记

- 文档：`docs/knowledge/pcb/23-lceda-project-workflow-and-bilibili-course.md`
- KP：**13**（341–353） · 结构化条目：**11**
- **KP-PCB-341** 七阶段闭环与每阶段放行物
- **KP-PCB-342** 原理图可读性：标题栏、模块分区、未连接标记
- **KP-PCB-343** 符号/封装/3D 身份必须先对齐
- **KP-PCB-344** 布局：先固定“不能动”的，再摆“可以动”的
- **KP-PCB-345** 布线：电源/地→高速/差分→普通信号→铺铜
- **KP-PCB-351** 布局不是“先放主控”，而是先放不能动的约束
- **KP-PCB-352** 功率链路和接口防护要“先短直粗、再谈美观”
- **KP-PCB-353** 布局评审的最小问题清单
- **KP-PCB-346** DRC 是必要条件，不是充分条件
- **KP-PCB-347** 生产文件是“一套”，不是“一个 Gerber”
- **KP-PCB-348** BOM / 坐标 / 装配图必须三方一致
- **KP-PCB-349** 下单参数必须与设计/工艺单一致
- **KP-PCB-350** 视频只能当 C 级证据

#### [24-prerouting-and-power-first.md](<./pcb/24-prerouting-and-power-first.md>) — 24. 预布线与“电源优先”：关键网络先锁定，普通信号后走

- 文档：`docs/knowledge/pcb/24-prerouting-and-power-first.md`
- KP：**6**（354–359） · 结构化条目：**4**
- **KP-PCB-354** 预布线预的是“关键约束”，不是“所有网络”
- **KP-PCB-355** 预布线七步流程
- **KP-PCB-356** “电源优于一切”的正确含义
- **KP-PCB-357** 预布线必须给普通信号留“通道”，否则等于没预布
- **KP-PCB-358** 预布线的评审门禁
- **KP-PCB-359** 什么时候不需要/不应过度预布

#### [25-ten-routing-principles.md](<./pcb/25-ten-routing-principles.md>) — 25. PCB 布线十条原则：从“经验口诀”到可执行检查

- 文档：`docs/knowledge/pcb/25-ten-routing-principles.md`
- KP：**10**（360–369） · 结构化条目：**5**
- **KP-PCB-360** 连线精简：短、少拐弯、少换层，但不牺牲约束
- **KP-PCB-361** 避免直角/锐角：本质是阻抗连续与可制造性
- **KP-PCB-362** 差分走线：等宽、等距、同层、参考平面连续
- **KP-PCB-363** 蛇形走线：只用于等长补偿，不能过度
- **KP-PCB-364** 圆滑走线/泪滴：焊盘入口平滑，不等于到处加泪滴
- **KP-PCB-365** 数字/模拟分开：分开的是噪声路径，不只是“画两个区”
- **KP-PCB-366** 3W 原则：降低平行走线串扰的起点，不是绝对标准
- **KP-PCB-367** 20H 原则：电源平面回缩，依赖叠层和场分布
- **KP-PCB-368** 铜箔载流：按 IPC-2152/温升/压降算，不靠“1A 1mm”
- **KP-PCB-369** 过孔载流：单孔不是无限流，按孔径/镀层/长度/温升算

### 原理图 / 电路设计

#### [01-conventions.md](<./schematic/01-conventions.md>) — 原理图设计规范：图框、网络命名、符号与可读性

- 文档：`docs/knowledge/schematic/01-conventions.md`
- KP：**18**（01–18） · 结构化条目：**6**
- **KP-SCH-001** 图框与标题栏必须承载可追溯字段
- **KP-SCH-002** 版本号与修订记录按变更性质递增
- **KP-SCH-003** 版本一致性必须覆盖原理图 / BOM / PCB 三件套
- **KP-SCH-004** 网络命名总则：唯一、可读、可检索
- **KP-SCH-005** 电源网络名按电压域唯一
- **KP-SCH-006** 地网络命名与地策略：默认单地，分割要有唯一桥接点
- **KP-SCH-007** 差分对命名与配对必须支持自动约束
- **KP-SCH-008** 总线与位序命名
- **KP-SCH-009** 电源符号与网络标签的使用边界
- **KP-SCH-010** 网络标签作用域与隐式连接
- **KP-SCH-011** 参考位号前缀与唯一性
- **KP-SCH-012** 器件值与单位书写规范
- **KP-SCH-013** 引脚编号与封装映射必须一一对应
- **KP-SCH-014** 隐藏引脚与未用门必须显式处理
- **KP-SCH-015** 去耦电容的画法与归属
- **KP-SCH-016** 层次图与端口
- **KP-SCH-017** 悬空引脚与 NC 必须显式标注
- **KP-SCH-018** 可读性布局与测试点约定

#### [02-power-architecture.md](<./schematic/02-power-architecture.md>) — 电源架构设计：拓扑选择、LDO/Buck 边界、时序与电源域

- 文档：`docs/knowledge/schematic/02-power-architecture.md`
- KP：**18**（19–36） · 结构化条目：**4**
- **KP-SCH-019** 先画电源树，再选器件
- **KP-SCH-020** 输入级顺序：连接器 → 保护 → 滤波 → 变换
- **KP-SCH-021** LDO 与 Buck 的选择边界
- **KP-SCH-022** LDO 热耗与结温校核
- **KP-SCH-023** LDO 压差（dropout）与最低输入电压
- **KP-SCH-024** LDO 稳定性与输出电容选择
- **KP-SCH-025** Buck 关键外围：电感、输出电容、反馈分压
- **KP-SCH-026** Buck 输入电容与输入纹波电流
- **KP-SCH-027** EN/UVLO 分压与滞回
- **KP-SCH-028** 软启动与输入浪涌电流
- **KP-SCH-029** 多电源域上电时序与 Power Good
- **KP-SCH-030** 电源树与去耦分配
- **KP-SCH-031** 电源域划分与地/回流
- **KP-SCH-032** 电池充电拓扑：线性 vs 开关、CC/CV 与热
- **KP-SCH-033** 电池电压与电量检测
- **KP-SCH-034** USB 供电与受电
- **KP-SCH-035** 电源指示、测试点与上电验证
- **KP-SCH-036** 降额与余量规则

#### [03-mcu-minimal-system.md](<./schematic/03-mcu-minimal-system.md>) — MCU 最小系统设计：电源、复位、时钟、调试与量产接口

- 文档：`docs/knowledge/schematic/03-mcu-minimal-system.md`
- KP：**17**（37–53） · 结构化条目：**4**
- **KP-SCH-037** 最小系统六要素清单
- **KP-SCH-038** 电源引脚去耦：每对 VDD/VSS 一颗 100nF
- **KP-SCH-039** 模拟电源、基准与 ADC 精度
- **KP-SCH-040** 复位电路：上电复位 + 手动复位 + 复位脉宽
- **KP-SCH-041** 复位与启动异常排查接口
- **KP-SCH-042** BOOT/模式引脚必须在复位采样时刻有确定电平
- **KP-SCH-043** 晶振电路与负载电容计算
- **KP-SCH-044** 内部 RC 与外部晶振的选择边界
- **KP-SCH-045** SWD 调试接口标准接法
- **KP-SCH-046** JTAG 与多器件调试链（按需）
- **KP-SCH-047** 调试接口的保护与量产复用
- **KP-SCH-048** 看门狗：内部与外部看门狗的选择
- **KP-SCH-049** GPIO 上电默认状态与外部负载
- **KP-SCH-050** 未用引脚处理
- **KP-SCH-051** 量产烧录接口与流程
- **KP-SCH-052** IO 电平与 VDDIO 匹配
- **KP-SCH-053** 最小系统的布局约束必须在原理图阶段固化

#### [04-interfaces.md](<./schematic/04-interfaces.md>) — 总线与接口设计：I2C / SPI / UART / USB / CAN / RS485 / 电平转换

- 文档：`docs/knowledge/schematic/04-interfaces.md`
- KP：**19**（54–72） · 结构化条目：**10**
- **KP-SCH-054** 接口设计四问：电平、速率、距离、参考地
- **KP-SCH-055** I2C 上拉电阻范围计算
- **KP-SCH-056** I2C 地址规划与多从机
- **KP-SCH-057** I2C 总线电容、走线与缓冲
- **KP-SCH-058** I2C 隔离与电平转换
- **KP-SCH-059** SPI 信号完整性：串阻、走线与速率
- **KP-SCH-060** SPI 多从机与片选管理
- **KP-SCH-061** SPI 时序模式（CPOL/CPHA）与建立保持
- **KP-SCH-062** UART 电平与交叉连接
- **KP-SCH-063** UART 流控与接口保护
- **KP-SCH-064** UART 隔离
- **KP-SCH-065** USB 2.0 设备端硬件要点
- **KP-SCH-066** USB Type-C CC 配置（Sink 与 Source）
- **KP-SCH-067** USB ESD 与保护器件选型
- **KP-SCH-068** USB PD 受电要点
- **KP-SCH-069** CAN 总线终端、共模与保护
- **KP-SCH-070** RS485 终端、失效保护偏置与共模范围
- **KP-SCH-071** CAN/RS485 隔离
- **KP-SCH-072** 电平转换：双向与单向、方向控制

#### [05-protection.md](<./schematic/05-protection.md>) — 保护电路设计：ESD、TVS、过压/过流/反接、浪涌与热插拔

- 文档：`docs/knowledge/schematic/05-protection.md`
- KP：**18**（73–90） · 结构化条目：**5**
- **KP-SCH-073** 保护设计总则：先定应力，再定顺序，最后定器件
- **KP-SCH-074** ESD 防护基础：等级、器件类型与选型参数
- **KP-SCH-075** TVS 钳位余量计算
- **KP-SCH-076** TVS/ESD 摆放与接地回流
- **KP-SCH-077** 过压保护（OVP）
- **KP-SCH-078** 过流保护：保险丝选型与 I²t 协调
- **KP-SCH-079** PTC 自恢复保险丝
- **KP-SCH-080** 反接保护：P-MOS 高边方案
- **KP-SCH-081** 理想二极管与 ORing
- **KP-SCH-082** 浪涌与雷击防护：GDT + TVS 分级
- **KP-SCH-083** 热插拔与限流
- **KP-SCH-084** 上电冲击（inrush）与负载电容
- **KP-SCH-085** 保护器件顺序与协调
- **KP-SCH-086** 保护接地与地弹
- **KP-SCH-087** 通信接口保护：USB / CAN / RS485
- **KP-SCH-088** 电源口保护：VBUS / DC 输入
- **KP-SCH-089** 保护验证与测试记录
- **KP-SCH-090** 保护设计常见错误清单

#### [06-erc-review-checklist.md](<./schematic/06-erc-review-checklist.md>) — ERC 与原理图评审：常见错误逐条处理、评审清单与证据要求

- 文档：`docs/knowledge/schematic/06-erc-review-checklist.md`
- KP：**19**（091–109） · 结构化条目：**5**
- **KP-SCH-091** ERC 判读总则：分类、基线、豁免都要留痕
- **KP-SCH-092** 悬空引脚 / 未连接（Unconnected pin）
- **KP-SCH-093** 输出冲突 / 多驱动（Output conflict）
- **KP-SCH-094** 电源引脚未驱动（Power pin not driven）
- **KP-SCH-095** 单端网络（Net has only one pin）
- **KP-SCH-096** 重复网络名 / 同名网络（Multiple net names / implicit short）
- **KP-SCH-097** 输入引脚未驱动（Input pin not driven）
- **KP-SCH-098** 引脚电气类型配置错误
- **KP-SCH-099** 总线与层次端口连接错误
- **KP-SCH-100** 未用门 / NC 处理与 ERC
- **KP-SCH-101** 电源与去耦专项检查
- **KP-SCH-102** 复位、时钟、BOOT 专项检查
- **KP-SCH-103** 接口专项检查（上拉/终端/ESD/电平）
- **KP-SCH-104** 保护与降额专项检查
- **KP-SCH-105** 可制造性与可测试性检查
- **KP-SCH-106** 评审问题单与关闭标准
- **KP-SCH-107** 原理图走查方法（读图顺序与提问清单）
- **KP-SCH-108** 放行门禁：ERC + 评审 + 证据三件套
- **KP-SCH-109** 常见“假通过”与复核方法

#### [07-analog-audio.md](<./schematic/07-analog-audio.md>) — 模拟 / 音频 / 采样前端设计：分区、麦克风、功放、ADC 与检测

- 文档：`docs/knowledge/schematic/07-analog-audio.md`
- KP：**25**（110–134） · 结构化条目：**2**
- **KP-SCH-110** 模拟小信号、音频功率与数字必须分区
- **KP-SCH-111** 模拟地与单点连接
- **KP-SCH-112** 参考电压与 VDDA 处理
- **KP-SCH-113** 信号链噪声预算：输入参考噪声 RSS 合成
- **KP-SCH-114** 麦克风接口：驻极体与 MEMS 模拟输出
- **KP-SCH-115** 音频输入交流耦合与高通截止
- **KP-SCH-116** 差分模拟输入、共模与单端转差分
- **KP-SCH-117** 音频/模拟输入保护与 ESD
- **KP-SCH-118** 音频功放选型：A/B 类与 D 类边界
- **KP-SCH-119** 功放电源去耦与 PVDD/AVDD 分离
- **KP-SCH-120** D 类功放输出 LC 滤波与 EMI
- **KP-SCH-121** 静音、增益与关断引脚
- **KP-SCH-122** 功放输出保护：短路、过流、过热与直流
- **KP-SCH-123** 喇叭接口与走线
- **KP-SCH-124** 耳机接口与插入检测
- **KP-SCH-125** ADC 分压与源阻抗
- **KP-SCH-126** 采样时间与保持电容计算
- **KP-SCH-127** RC 抗混叠滤波
- **KP-SCH-128** 运放缓冲与驱动
- **KP-SCH-129** 电池电压检测
- **KP-SCH-130** 电流检测：低边与高边采样
- **KP-SCH-131** 采样校准：偏移、增益与两点法
- **KP-SCH-132** 采样精度与噪声预算：ENOB、地反弹、数字串扰
- **KP-SCH-133** 模拟走线布局要点
- **KP-SCH-134** 模拟/音频评审清单

#### [08-analog-signal-chain.md](<./schematic/08-analog-signal-chain.md>) — 模拟信号链设计：运放、基准源、ADC/DAC、滤波与误差预算

- 文档：`docs/knowledge/schematic/08-analog-signal-chain.md`
- KP：**26**（135–160） · 结构化条目：**10**
- **KP-SCH-135** 从分辨率与量程倒推信号链（先算 LSB，再选器件）
- **KP-SCH-136** 运放选型：GBW、压摆率、共模/输出摆幅与容性负载
- **KP-SCH-137** 运放稳定性：噪声增益、相位裕度与容性负载
- **KP-SCH-138** 仪表放大器：CMRR、增益设置与参考端
- **KP-SCH-139** 电流检测放大器（CSA）：共模电压、CMRR 与分流电阻
- **KP-SCH-140** 外部基准源：初始精度、温漂与噪声预算
- **KP-SCH-141** 基准缓冲、开尔文连接与负载调整
- **KP-SCH-142** SAR ADC 驱动：电荷反冲与建立时间
- **KP-SCH-143** ΔΣ ADC 前端：输入偏置电流、混叠与数字滤波
- **KP-SCH-144** ADC 输入过压、多路复用与保护
- **KP-SCH-145** DAC 输出缓冲、容性负载与建立时间
- **KP-SCH-146** DAC 静态精度：INL/DNL、毛刺与滤波
- **KP-SCH-147** 比较器：迟滞、传输延迟与输出电平
- **KP-SCH-148** 有源滤波拓扑：Sallen-Key 与多重反馈（MFB）
- **KP-SCH-149** 滤波器元件容差与灵敏度：最坏情况截止频率偏差
- **KP-SCH-150** 单端↔差分转换：全差分运放（FDA）与变压器
- **KP-SCH-151** 噪声预算：1/f、宽带、折合输入与 SNR/ENOB
- **KP-SCH-152** 失调与漂移误差预算：VOS、IB、CMRR/PSRR
- **KP-SCH-153** 电阻热噪声与高阻节点
- **KP-SCH-154** 采样时钟抖动对 SNR 的限制
- **KP-SCH-155** 模拟通道自校准与自检
- **KP-SCH-156** 混合信号接地：AGND/DGND 引脚与地反弹
- **KP-SCH-157** 长线/远端信号：地环流与隔离
- **KP-SCH-158** 无源 RC 滤波与有源滤波的选择边界
- **KP-SCH-159** 模拟通道测试点与信号注入验证
- **KP-SCH-160** 模拟信号链评审清单

#### [09-sensors-actuators.md](<./schematic/09-sensors-actuators.md>) — 传感器与执行器接口设计：I2C/SPI/模拟/脉冲、校准、隔离与电机驱动

- 文档：`docs/knowledge/schematic/09-sensors-actuators.md`
- KP：**26**（161–186） · 结构化条目：**8**
- **KP-SCH-161** 传感器接口选型矩阵：模拟 / I2C / SPI / 脉冲 / 开关量
- **KP-SCH-162** I2C 传感器接入：上拉、地址、中断与总线电容
- **KP-SCH-163** SPI 传感器接入：片选、时序模式与 MISO 三态
- **KP-SCH-164** 模拟传感器激励：恒压/恒流与比例式测量
- **KP-SCH-165** 惠斯通电桥与应变片：灵敏度、非线性与引线补偿
- **KP-SCH-166** RTD 与热敏电阻：激励电流、自热与引线补偿
- **KP-SCH-167** 热电偶：冷端补偿与 µV 级放大
- **KP-SCH-168** 霍尔与磁编码器接口：上拉、供电噪声与去抖
- **KP-SCH-169** 光电/增量编码器脉冲输入：整形、计数与最大频率
- **KP-SCH-170** 传感器中断/唤醒脚与低功耗时序
- **KP-SCH-171** 传感器校准：零点、满量程、多点与温补
- **KP-SCH-172** 传感器激励与参考供电：噪声、时序与负载
- **KP-SCH-173** 隔离传感器接口：隔离放大器与数字隔离
- **KP-SCH-174** 长线传感器：屏蔽、共模、浪涌与串扰
- **KP-SCH-175** H 桥电机驱动：拓扑、死区与损耗
- **KP-SCH-176** 电机驱动体电容与再生能量
- **KP-SCH-177** 步进电机驱动：电流设定、细分与失步
- **KP-SCH-178** 继电器驱动：线圈电流、续流与触点灭弧
- **KP-SCH-179** 电磁阀/螺线管驱动：续流、保持电流与热
- **KP-SCH-180** 有刷电机换向噪声与滤波
- **KP-SCH-181** 执行器故障检测：开路、短路与堵转
- **KP-SCH-182** 执行器驱动安全：上电默认、互锁与急停
- **KP-SCH-183** 传感器/执行器分区与布线：小信号 vs 大电流
- **KP-SCH-184** 传感器/执行器测试与可量测判据
- **KP-SCH-185** 传感器/执行器接口保护与 ESD
- **KP-SCH-186** 传感器/执行器评审清单

#### [10-battery-bms.md](<./schematic/10-battery-bms.md>) — 电池与 BMS 设计：充电、保护、电量计、均衡、热安全与认证证据

- 文档：`docs/knowledge/schematic/10-battery-bms.md`
- KP：**24**（187–210） · 结构化条目：**6**
- **KP-SCH-187** 电池系统架构：充电、保护、电量计、BMS 的职责边界
- **KP-SCH-188** 充电拓扑：线性与开关的边界与热耗
- **KP-SCH-189** CC/CV、预充、终止与温度窗口（JEITA）
- **KP-SCH-190** 充电输入：限流、动态电源管理与输入保护
- **KP-SCH-191** 1S 保护板：OVP/OCP/SCP/OTP 与双 MOS 选型
- **KP-SCH-192** 多串电池 AFE 采样与断线检测
- **KP-SCH-193** 电量计选型：库仑计、电压法与阻抗跟踪
- **KP-SCH-194** SOC 估算误差预算与学习
- **KP-SCH-195** 均衡：被动与主动、均衡电流与热
- **KP-SCH-196** 电池温度检测：NTC 分压、断线与温窗
- **KP-SCH-197** 热失控防护与二次保护
- **KP-SCH-198** 充放电 MOS 背靠背与体二极管路径
- **KP-SCH-199** 电池连接器与线束：接触电阻、压降与温升
- **KP-SCH-200** 保险丝、PTC 与双保护协调（I²t）
- **KP-SCH-201** 认证证据：UN38.3、GB31241、IEC 62133 与整机安规
- **KP-SCH-202** 电池测试与可量测判据：容量、内阻、循环与自放电
- **KP-SCH-203** BMS 通信：SMBus/I2C、CAN 与隔离
- **KP-SCH-204** 电池反接、热插拔与浪涌
- **KP-SCH-205** 电池 PCB 分区与开尔文采样
- **KP-SCH-206** 多串采样线序与均衡走线：共阻抗串扰
- **KP-SCH-207** 电池存储、运输与 SoC 窗口
- **KP-SCH-208** 硬件保护与固件保护的冗余
- **KP-SCH-209** 电池包 EOL 测试、追溯与档案
- **KP-SCH-210** 电池与 BMS 评审清单

#### [11-rf-antenna.md](<./schematic/11-rf-antenna.md>) — RF 与天线设计：50Ω 传输、匹配、巴伦、净空、调试与认证

- 文档：`docs/knowledge/schematic/11-rf-antenna.md`
- KP：**26**（211–236） · 结构化条目：**9**
- **KP-SCH-211** RF 前端设计总则：先定链路指标，再谈电路
- **KP-SCH-212** 50Ω 参考阻抗与微带线宽度
- **KP-SCH-213** 共面波导与地回流：RF 走线的“地”比线更重要
- **KP-SCH-214** 匹配网络拓扑：L 型、π 型、T 型与 Q 值
- **KP-SCH-215** 匹配元件选型：Q 值、SRF 与容差
- **KP-SCH-216** 巴伦（Balun）：差分 RF 与单端的转换
- **KP-SCH-217** 滤波器：SAW/LC/低通/带通与抑制指标
- **KP-SCH-218** 天线类型选型：PCB/陶瓷/外置
- **KP-SCH-219** 天线净空：禁布区、参考地与周围金属
- **KP-SCH-220** 天线馈线与地回流
- **KP-SCH-221** RF 走线布局：短、直、包地、远离干扰
- **KP-SCH-222** RF 连接器、测试点与 π 型调试网络
- **KP-SCH-223** 发射功率、EIRP 与法规限值
- **KP-SCH-224** 接收灵敏度、噪声系数与 Friis 级联
- **KP-SCH-225** 共存与干扰：WiFi/BT/LTE 同板共存
- **KP-SCH-226** 天线与 RF 测量：VNA、S11、效率与暗室
- **KP-SCH-227** RF 接口的 ESD 与保护
- **KP-SCH-228** 参考时钟与相位噪声对 RF 的影响
- **KP-SCH-229** 屏蔽、隔离与腔体谐振
- **KP-SCH-230** 认证测试：按地区标准核对，不凭记忆引用条款
- **KP-SCH-231** 天线与匹配的批次一致性
- **KP-SCH-232** 谐波、杂散与板级 EMC
- **KP-SCH-233** RF 调试记录与证据要求
- **KP-SCH-234** RF 常见失败模式
- **KP-SCH-235** 天线与结构/外壳的配合
- **KP-SCH-236** RF 设计评审清单

#### [12-power-topologies.md](<./schematic/12-power-topologies.md>) — 先进电源拓扑：Buck-Boost、反激、LLC、多相、热插拔与环路

- 文档：`docs/knowledge/schematic/12-power-topologies.md`
- KP：**26**（237–262） · 结构化条目：**10**
- **KP-SCH-237** 拓扑选择总则：四个变量定方向
- **KP-SCH-238** 四开关 Buck-Boost：宽输入升降压
- **KP-SCH-239** 反激（Flyback）：隔离中小功率主力
- **KP-SCH-240** LLC 谐振：中大功率高效隔离
- **KP-SCH-241** 隔离拓扑对比：正激/推挽/半桥/全桥
- **KP-SCH-242** 多相 Buck：大电流与纹波抵消
- **KP-SCH-243** 热插拔控制器：浪涌、SOA 与 dV/dt
- **KP-SCH-244** eFuse / 电子保险丝
- **KP-SCH-245** ORing 与理想二极管：多电源切换
- **KP-SCH-246** 隔离电源与安规：隔离电压、爬电与 Y 电容
- **KP-SCH-247** 环路补偿基础：穿越频率、相位裕度与 Type II/III
- **KP-SCH-248** 环路稳定性测量：注入法与判据
- **KP-SCH-249** 反馈分压、基准与输出精度
- **KP-SCH-250** 变压器设计要点：匝比、磁芯、饱和与漏感
- **KP-SCH-251** 同步整流：效率、死区与驱动
- **KP-SCH-252** 输出电容与纹波计算
- **KP-SCH-253** 输入滤波与 EMI：差模/共模
- **KP-SCH-254** 保护与软启动：OVP/OCP/OTP/UVLO
- **KP-SCH-255** 并联与均流：droop 与主动均流
- **KP-SCH-256** 轻载效率与工作模式
- **KP-SCH-257** 损耗分解与热设计
- **KP-SCH-258** 功率级布局要点
- **KP-SCH-259** 拓扑选择案例
- **KP-SCH-260** 电源模块 vs 分立方案
- **KP-SCH-261** 先进电源拓扑常见失败模式
- **KP-SCH-262** 先进电源拓扑评审清单

#### [13-documentation-eco.md](<./schematic/13-documentation-eco.md>) — 文件与 ECO：版本矩阵、变更控制、BOM、评审门禁与归档

- 文档：`docs/knowledge/schematic/13-documentation-eco.md`
- KP：**24**（263–286） · 结构化条目：**5**
- **KP-SCH-263** 文档受控总则：唯一入口、唯一版本、可追溯
- **KP-SCH-264** 版本矩阵：原理图/BOM/PCB/固件/测试五件套
- **KP-SCH-265** 版本号语义与递增规则
- **KP-SCH-266** 版本一致性校验：三件套/五件套对齐
- **KP-SCH-267** 文件命名、目录与元数据规范
- **KP-SCH-268** 归档、保留与可读性
- **KP-SCH-269** ECO 流程与必填字段
- **KP-SCH-270** ECO 触发条件：什么变更必须开 ECO
- **KP-SCH-271** PCN（供应商变更通知）处理
- **KP-SCH-272** BOM 变更管理与替代料
- **KP-SCH-273** 替代料参数差异评估清单
- **KP-SCH-274** 原理图—PCB—BOM 同步变更
- **KP-SCH-275** 变更影响分析：接口/电源/认证/供应链
- **KP-SCH-276** 固件版本与硬件版本绑定
- **KP-SCH-277** 测试记录与证据归档
- **KP-SCH-278** 变更通知与发布：内部/外协/客户
- **KP-SCH-279** 量产文件包：Gerber/BOM/CPL/装配图/测试规范
- **KP-SCH-280** 评审门禁与签核
- **KP-SCH-281** 需求—设计—测试—认证的可追溯性
- **KP-SCH-282** 配置管理工具、权限与只读归档
- **KP-SCH-283** 变更后验证与回归
- **KP-SCH-284** 版本回滚与冻结
- **KP-SCH-285** 认证与合规文件的版本管理
- **KP-SCH-286** 文档审计、抽查与评审清单

### 元器件 / 选型 / 库

#### [01-passives.md](<./components/01-passives.md>) — 无源器件（电阻 / 电容 / 电感）选型知识

- 文档：`docs/knowledge/components/01-passives.md`
- KP：**18**（01–18） · 结构化条目：**8**
- **KP-CMP-001** 电阻精度按电路功能分档，不按「越准越好」
- **KP-CMP-002** 电阻温漂（TCR）与工作温度必须一起看
- **KP-CMP-003** 电阻额定功率必须按降额曲线使用
- **KP-CMP-004** 电阻的工作电压与脉冲能力常被忽略
- **KP-CMP-005** 电阻用于限流/分压时的连接顺序要与失效模式匹配
- **KP-CMP-006** MLCC 介质代号决定温度特性，先选介质再选容量
- **KP-CMP-007** MLCC 直流偏压降容必须按工作电压复核有效容量
- **KP-CMP-008** MLCC 老化与「去老化」处理
- **KP-CMP-009** MLCC 额定电压要按介质与用途降额
- **KP-CMP-010** MLCC 的 ESR/ESL 与自谐振频率决定它「滤什么频段」
- **KP-CMP-011** 多只电容并联会反谐振，组合要有依据
- **KP-CMP-012** MLCC 压电效应与机械应力开裂
- **KP-CMP-013** 电解/钽/聚合物电容的降额与失效模式
- **KP-CMP-014** 电感必须同时满足饱和电流 Isat 与温升电流 Irms
- **KP-CMP-015** 功率电感选型要按拓扑公式算，不要凭经验套值
- **KP-CMP-016** 铁氧体磁珠用于 EMI 抑制，不能当「万能滤波」
- **KP-CMP-017** 无源器件选型标准步骤（SOP）
- **KP-CMP-018** 无源器件常见错误清单

#### [02-diodes-tvs.md](<./components/02-diodes-tvs.md>) — 二极管 / 齐纳 / LED / TVS 选型知识

- 文档：`docs/knowledge/components/02-diodes-tvs.md`
- KP：**18**（19–36） · 结构化条目：**7**
- **KP-CMP-019** 先按功能选二极管类型，再谈参数
- **KP-CMP-020** 正向压降 Vf 决定导通损耗，必须按工作电流与温度查
- **KP-CMP-021** 反向漏电随温度指数上升，肖特基尤其明显
- **KP-CMP-022** 反向恢复时间 trr 与开关损耗
- **KP-CMP-023** 肖特基选型：VRRM、If、Vf、漏电四者权衡
- **KP-CMP-024** 齐纳二极管：Vz 容差、最小工作电流与动态电阻
- **KP-CMP-025** LED 限流电阻必须按实际 Vf 与目标电流计算
- **KP-CMP-026** LED 亮度、PWM 调光与「GPIO 直驱」风险
- **KP-CMP-027** LED 的反向电压与 ESD 防护
- **KP-CMP-028** TVS 四个核心参数：VRWM、VBR、VC、IPP
- **KP-CMP-029** TVS 峰值功率要按波形与温度降额
- **KP-CMP-030** TVS 结电容必须与信号速率匹配
- **KP-CMP-031** 单向 TVS 与双向 TVS 的选择
- **KP-CMP-032** ESD 与浪涌（Surge）是两种不同应力，不能混为一谈
- **KP-CMP-033** TVS 布局：先钳位、短地回路、不打弯
- **KP-CMP-034** 二极管/TVS 常见误用清单
- **KP-CMP-035** 防反接方案：串联二极管 vs P-MOS vs 理想二极管
- **KP-CMP-036** 二极管 BOM 与料号使用规范

#### [03-transistors-mosfets.md](<./components/03-transistors-mosfets.md>) — 三极管 / MOSFET 开关与驱动知识

- 文档：`docs/knowledge/components/03-transistors-mosfets.md`
- KP：**17**（37–53） · 结构化条目：**3**
- **KP-CMP-037** 三极管开关：基极电阻按 Ib = Ic / hFE(min) 计算
- **KP-CMP-038** 三极管饱和压降与「深度饱和」的代价
- **KP-CMP-039** 三极管功耗与结温核算
- **KP-CMP-040** 三极管用于线性放大/射极跟随器的偏置要点
- **KP-CMP-041** Vgs(th) 不是「导通电压」，必须看测试条件与驱动电压
- **KP-CMP-042** Rds(on) 随温度与驱动电压上升，热设计按最坏值
- **KP-CMP-043** 栅极电荷 Qg 决定驱动损耗与驱动能力需求
- **KP-CMP-044** 米勒平台与 Qgd：开关损耗的真正瓶颈
- **KP-CMP-045** 低边开关与高边开关的拓扑选择
- **KP-CMP-046** 栅极电阻与下拉电阻：默认态与开关速度
- **KP-CMP-047** 体二极管方向与用途（含反接/续流）
- **KP-CMP-048** P-MOS 反接保护：方向、Vgs 与栅极钳位
- **KP-CMP-049** SOA（安全工作区）与热：脉冲/容性/热插拔场景必查
- **KP-CMP-050** SOT-23 引脚定义不统一，必须逐器件核对
- **KP-CMP-051** 封装热阻 RθJA 与散热设计
- **KP-CMP-052** 三极管/MOSFET 选型参数表（按用途查）
- **KP-CMP-053** 三极管/MOSFET 常见错误清单

#### [04-power-ics.md](<./components/04-power-ics.md>) — 电源 IC（LDO / Buck / Boost / 充电管理）选型知识

- 文档：`docs/knowledge/components/04-power-ics.md`
- KP：**18**（54–71） · 结构化条目：**4**
- **KP-CMP-054** 先按输入输出窗口与电流选拓扑
- **KP-CMP-055** LDO 压差（Dropout）决定最小输入电压
- **KP-CMP-056** LDO 静态电流 Iq 决定待机功耗
- **KP-CMP-057** LDO 的 PSRR 与输出噪声要按频段看
- **KP-CMP-058** LDO 热耗计算与散热焊盘
- **KP-CMP-059** LDO 稳定性依赖输出电容（ESR/容量），按 datasheet 选
- **KP-CMP-060** 同步与非同步 Buck 的选择
- **KP-CMP-061** Buck 电感按公式计算，并校核 Isat/Irms
- **KP-CMP-062** Buck 输入电容按 RMS 电流选，且要靠近 IC
- **KP-CMP-063** Buck 输出电容按纹波公式选，注意 ESR 与直流偏压
- **KP-CMP-064** Buck 反馈电阻按 Vref 计算，走线远离 SW 节点
- **KP-CMP-065** 开关电源布局：小功率环路、单点地、散热
- **KP-CMP-066** Boost 拓扑：占空比、输入电流与输出电容
- **KP-CMP-067** 充电管理：CC/CV 与温度保护
- **KP-CMP-068** 电源 IC 外围参数计算 SOP
- **KP-CMP-069** 电源 IC 替代料判断：pin-to-pin 不等于可替代
- **KP-CMP-070** 多路电源的上电时序与电源树复核
- **KP-CMP-071** 电源设计常见错误清单

#### [05-mcu-wireless-connectors.md](<./components/05-mcu-wireless-connectors.md>) — MCU / 无线模组 / 连接器选型知识

- 文档：`docs/knowledge/components/05-mcu-wireless-connectors.md`
- KP：**17**（72–88） · 结构化条目：**6**
- **KP-CMP-072** MCU 选型六维度总表
- **KP-CMP-073** IO 数量与复用：按「功能 + 预留」核算
- **KP-CMP-074** 外设匹配：接口电平、时序与数量要逐项核对
- **KP-CMP-075** 存储、封装与可制造性
- **KP-CMP-076** 供货与替代：同系列 pin-compatible 是首选
- **KP-CMP-077** MCU 最小系统：复位、BOOT、去耦、调试口
- **KP-CMP-078** 无线模组选型：协议、认证、功耗、接口
- **KP-CMP-079** 天线净空（Keep-out）必须按模组 layout guide 执行
- **KP-CMP-080** 无线认证：模组预认证 ≠ 整机免测
- **KP-CMP-081** 无线模组电源：峰值电流与去耦
- **KP-CMP-082** 连接器选型四要素：电流、间距、寿命、防呆
- **KP-CMP-083** USB Type-C 连接器：16P 与 24P 的能力差异
- **KP-CMP-084** 排针/排母：间距、针数与防呆
- **KP-CMP-085** FPC/FFC 连接器：间距、翻盖方向、补强与触点面
- **KP-CMP-086** 线对板端子（SH/ZH/GH/XH）：间距与线径匹配
- **KP-CMP-087** 引脚定义与防呆：以 datasheet + 实物丝印双向核对
- **KP-CMP-088** 连接器与模组替代风险清单

#### [06-crystals-oscillators.md](<./components/06-crystals-oscillators.md>) — 晶振 / 振荡器 / 时钟电路知识

- 文档：`docs/knowledge/components/06-crystals-oscillators.md`
- KP：**16**（089–104） · 结构化条目：**5**
- **KP-CMP-089** 负载电容 CL 与匹配电容 C1/C2 的计算
- **KP-CMP-090** 匹配电容必须用 C0G，且靠近晶振放置
- **KP-CMP-091** 晶振 ESR 与振荡器负阻裕度
- **KP-CMP-092** 驱动电平（Drive Level）必须限制在晶振额定值内
- **KP-CMP-093** 无源晶振接法：并联谐振 vs 串联谐振
- **KP-CMP-094** 有源晶振（XO）选型：输出类型、供电、使能
- **KP-CMP-095** TCXO / VCXO 与频率精度等级
- **KP-CMP-096** 32.768kHz 与 RTC：起振慢、ESR 高、最忌干扰
- **KP-CMP-097** 频率误差 ppm 换算与老化/温漂预算
- **KP-CMP-098** 起振失败的常见原因与排查顺序
- **KP-CMP-099** 晶振布局：短、包地、远离干扰源
- **KP-CMP-100** 晶振封装与机械应力
- **KP-CMP-101** 时钟抖动、相位噪声与时钟树
- **KP-CMP-102** 双晶振/多时钟系统的主从与使能
- **KP-CMP-103** 晶振电路常见错误清单
- **KP-CMP-104** 晶振/振荡器 BOM 与料号使用规范

#### [07-lcsc-quickref-footprint.md](<./components/07-lcsc-quickref-footprint.md>) — 常用料号速查与封装核验知识

- 文档：`docs/knowledge/components/07-lcsc-quickref-footprint.md`
- KP：**17**（105–121） · 结构化条目：**1**
- **KP-CMP-105** LCSC 料号使用规范：必须携带「核验状态」
- **KP-CMP-106** Librarian 三源核验判定逻辑（与本文档的对应关系）
- **KP-CMP-107** 符号-封装-焊盘三源核验流程（建库 SOP）
- **KP-CMP-108** 封装族命名与「公制/英制」混淆
- **KP-CMP-109** 片式阻容封装（0402/0603/0805/1206）与焊盘要点
- **KP-CMP-110** SOT-23 / SOT-23-5 / SOT-23-6 引脚与焊盘
- **KP-CMP-111** SOT-223 / SOT-89 散热焊盘封装
- **KP-CMP-112** QFN / DFN：散热焊盘与 Pin 1 识别
- **KP-CMP-113** LQFP / TQFP：0.5mm 间距与 Pin 1
- **KP-CMP-114** 二极管封装：SMA/SMB/SMC（DO-214）与 SOD 系列
- **KP-CMP-115** SOD-123 与 DO-41/DO-35 等插件封装
- **KP-CMP-116** 极性标识：二极管/LED/钽电容/电解/连接器
- **KP-CMP-117** 常用阻容速查表（项目 BOM 参考，全部待核验）
- **KP-CMP-118** 常用半导体/连接器速查表（项目 BOM 参考，全部待核验）
- **KP-CMP-119** 替代料判断：封装兼容只是第一关
- **KP-CMP-120** 钢网、焊盘与返修注意
- **KP-CMP-121** 封装/料号常见错误清单

#### [08-inductors-ferrites-fuses.md](<./components/08-inductors-ferrites-fuses.md>) — 电感 / 磁珠 / 共模电感 / 保险丝 / PTC / 热敏电阻选型知识

- 文档：`docs/knowledge/components/08-inductors-ferrites-fuses.md`
- KP：**18**（122–139） · 结构化条目：**14**
- **KP-CMP-122** 电感选型第一约束：饱和电流 Isat 与温升电流 Irms 必须同时满足
- **KP-CMP-123** DCR 铜损决定效率与压降，必须计入预算
- **KP-CMP-124** 功率电感的 SRF 与频率特性：不要把它当高频滤波器
- **KP-CMP-125** 功率电感按拓扑公式计算，不凭经验套值
- **KP-CMP-126** 电感温升与布局：靠近开关节点但不进敏感区
- **KP-CMP-127** 共模电感按接口类型选：阻抗、额定电流、漏感、绕法
- **KP-CMP-128** 铁氧体磁珠是「频率相关电阻」，必须按直流偏置降额
- **KP-CMP-129** 磁珠电流、DCR 与「磁珠+电容」谐振
- **KP-CMP-130** 磁珠 / 电感 / 0Ω / 保险丝：四种「串联件」的边界
- **KP-CMP-131** 一次性保险丝：额定电流降额、电压与分断能力三件套
- **KP-CMP-132** 保险丝 I²t：既要防误断，也要防「该断不断」
- **KP-CMP-133** PPTC 自恢复保险丝：保持电流、动作电流与温度降额
- **KP-CMP-134** 保护器件顺序与布局：先保险丝，后 TVS，靠近入口
- **KP-CMP-135** NTC 测温：R25、B 值与分压/ADC 换算
- **KP-CMP-136** NTC 自热、线阻与长线误差
- **KP-CMP-137** PTC 与 NTC 的用途边界
- **KP-CMP-138** 磁性/保护元件选型速查表（参数档位，具体料号待核验）
- **KP-CMP-139** 电感/磁珠/保险丝的失败模式与可量测判据

#### [09-sensors-actuators.md](<./components/09-sensors-actuators.md>) — 传感器与执行器（温湿度 / 压力 / IMU / 霍尔 / 光电 / 麦克风 / 蜂鸣器 / 继电器 / 电机 / 电磁阀）选型知识

- 文档：`docs/knowledge/components/09-sensors-actuators.md`
- KP：**18**（140–157） · 结构化条目：**14**
- **KP-CMP-140** 传感器选型首问：接口类型决定信号链与成本
- **KP-CMP-141** 数字传感器 I2C/SPI 总线：上拉、总线电容、电平与地址
- **KP-CMP-142** 温湿度传感器选型：精度之外先看开孔与热设计
- **KP-CMP-143** 温湿度校准、结露与污染防护
- **KP-CMP-144** 压力传感器：表压/绝压/差压、量程与过压
- **KP-CMP-145** IMU 选型：量程、ODR、噪声密度、带宽与安装
- **KP-CMP-146** IMU 校准与振动隔离
- **KP-CMP-147** 霍尔传感器：开关型/线性型/锁存型，上拉与磁路
- **KP-CMP-148** 光电传感器：对射/反射/光耦，发射电流与阈值
- **KP-CMP-149** MEMS 麦克风：模拟/PDM/I2S、偏置、灵敏度与声孔
- **KP-CMP-150** 蜂鸣器：有源/无源先分清，驱动方式与续流
- **KP-CMP-151** 继电器：线圈驱动、续流与触点负载
- **KP-CMP-152** 直流电机：H 桥、PWM 频率、续流与制动
- **KP-CMP-153** 步进电机：细分、电流设定、加减速与失步
- **KP-CMP-154** 电磁阀/电磁铁：驱动、续流、保持电流与热
- **KP-CMP-155** 感性负载驱动通用规则：续流、隔离、地回路
- **KP-CMP-156** 传感器/执行器选型速查表（参数档位，具体料号待核验）
- **KP-CMP-157** 传感器/执行器的失败模式与可量测判据

#### [10-interface-protection.md](<./components/10-interface-protection.md>) — 接口保护（ESD / TVS 阵列 / 共模滤波 / 隔离器 / 连接器保护）选型知识

- 文档：`docs/knowledge/components/10-interface-protection.md`
- KP：**18**（158–175） · 结构化条目：**14**
- **KP-CMP-158** ESD 威胁模型：HBM / CDM / IEC 61000-4-2 不是一回事
- **KP-CMP-159** TVS 选型四参数：VRWM / VBR / VC / IPP 与后级耐压匹配
- **KP-CMP-160** 结电容决定信号完整性：高速接口必须选低电容 TVS
- **KP-CMP-161** ESD 阵列/多路保护器件选型：通道数、极性、钳位与封装
- **KP-CMP-162** ESD 保护布局：先打后过、地回路短、紧靠连接器
- **KP-CMP-163** 共模滤波：USB / CAN / RS485 的参数与布局
- **KP-CMP-164** 接口保护链顺序：保险丝/PPTC → TVS → 共模 → 串阻
- **KP-CMP-165** 浪涌（IEC 61000-4-5）与 TVS 能量校核
- **KP-CMP-166** 热插拔与连接器保护：限流、防反接、上电顺序
- **KP-CMP-167** 串阻/RC 滤波与 ESD 器件的配合
- **KP-CMP-168** 天线/射频口保护：低电容、低损耗、少分支
- **KP-CMP-169** 光耦选型：CTR、速度、隔离电压与老化降额
- **KP-CMP-170** 数字隔离器选型：隔离等级、速率、CMTI、供电
- **KP-CMP-171** 隔离电源与地分割：爬电距离/电气间隙按标准查
- **KP-CMP-172** 接地与屏蔽：机壳地/信号地/保护地的连接策略
- **KP-CMP-173** 保护器件降额与失效模式：短路失效最危险
- **KP-CMP-174** 接口保护选型速查表（参数档位，具体料号待核验）
- **KP-CMP-175** 接口保护的失败模式与可量测判据

#### [11-supply-chain.md](<./components/11-supply-chain.md>) — 供应链与元件生命周期管理（EOL / PCN / NRND / 双供 / 替代料 / 假货 / 批次追溯）

- 文档：`docs/knowledge/components/11-supply-chain.md`
- KP：**18**（176–193） · 结构化条目：**6**
- **KP-CMP-176** 元件生命周期状态机：Active → NRND → LTB → EOL/Obsolete
- **KP-CMP-177** PCN 变更影响评估：不是所有 PCN 都一样
- **KP-CMP-178** LTB 与安全库存：最后一次采购要覆盖“剩余生命周期需求”
- **KP-CMP-179** 生命周期风险分级：按“不可替代性 × 用量 × 交期 × 认证依赖”排序
- **KP-CMP-180** 双供准入：pin-to-pin 只是入场券
- **KP-CMP-181** 替代料 7 项比对：电气 / 封装 / 温度 / 精度 / 寿命 / 认证 / 供货
- **KP-CMP-182** 替代料验证流程：样机 → 小批 → 量产三阶段
- **KP-CMP-183** 单点失效识别：BOM 里“只有一个来源”的器件必须显性化
- **KP-CMP-184** BOM 替代料字段与“禁用替代”规则
- **KP-CMP-185** 交期与排期：长交期器件必须前置锁定
- **KP-CMP-186** 成本模型：单价 ≠ 总成本
- **KP-CMP-187** 安全库存与缓冲：按交期波动与需求波动定
- **KP-CMP-188** 批次与日期码追溯：出问题要能圈定范围
- **KP-CMP-189** 假货与灰色渠道：来源比外观更重要
- **KP-CMP-190** 来料检验（IQC）与 AQL 抽检
- **KP-CMP-191** 供应商资质与 AVL：合格来源要“审过”而不是“用过”
- **KP-CMP-192** 停产/断供应急预案：触发条件与动作要预先定义
- **KP-CMP-193** 供应链评审门禁与数据时效：投产前必须过、过期必须重采

#### [12-library-management.md](<./components/12-library-management.md>) — 元件库管理（符号 / 封装 / 焊盘 / IPC-7351 / 版本与审核 / BOM 一致性）

- 文档：`docs/knowledge/components/12-library-management.md`
- KP：**18**（194–211） · 结构化条目：**6**
- **KP-CMP-194** 库的四层模型：part / symbol / footprint / 3D 各自独立、互相链接
- **KP-CMP-195** 三源核验：datasheet 第一优先，供应商次之，EDA 库最后
- **KP-CMP-196** 引脚映射与 Pin 1：符号引脚号必须等于封装焊盘号
- **KP-CMP-197** IPC-7351 密度等级 A/B/C：按产品与工艺选，同板统一
- **KP-CMP-198** 焊盘尺寸计算：基于引脚公差与工艺能力，禁止“通用尺寸”
- **KP-CMP-199** 散热焊盘 / 过孔 / 阻焊开窗：三件事一起定
- **KP-CMP-200** 3D 模型与机械装配核对
- **KP-CMP-201** 命名规范：族 + 尺寸 + 变体 + 极性 + 密度等级
- **KP-CMP-202** 库版本管理：受控库 + 变更记录 + 已投产板快照
- **KP-CMP-203** 审核流程：四眼原则 + 首件验证
- **KP-CMP-204** EDA 库与 BOM 一致性：字段映射 + 双向核对
- **KP-CMP-205** 库来源与授权：原厂/自建优先
- **KP-CMP-206** 库变更影响分析：覆盖已投产/在制板
- **KP-CMP-207** 库测试与验证：试贴 / 首件 / 通断
- **KP-CMP-208** BOM → 库 → 封装 双向核对（料号/封装/符号/位号）
- **KP-CMP-209** 多工具/多团队库同步：唯一主库
- **KP-CMP-210** 库废弃与迁移：deprecated 不删除
- **KP-CMP-211** 库质量指标与审计：用数据驱动改进

### 参考设计案例

#### [01-rpi-pico-rp2040.md](<./cases/01-rpi-pico-rp2040.md>) — 案例 01：Raspberry Pi Pico / RP2040 —— 2 层板的电源树、去耦与回流

- 文档：`docs/knowledge/cases/01-rpi-pico-rp2040.md`
- KP：**11**（01–11） · 结构化条目：**1**
- **KP-CASE-PICO-01** 用升降压而不是 LDO，把输入电压不确定性隔离在电源域之外
- **KP-CASE-PICO-02** RP2040 的内核电压由片内稳压器产生，外部 LC 是「必画件」
- **KP-CASE-PICO-03** 每个电源引脚就近去耦：QFN-56 的多对 VDD/VSS 不能合并处理
- **KP-CASE-PICO-04** 体电容与高频电容按约 10 倍容值组合，并警惕 MLCC 直流偏压降容
- **KP-CASE-PICO-05** 12 MHz 晶振是 PLL 参考，频偏会被倍频放大
- **KP-CASE-PICO-06** BOOTSEL 与复位：启动模式引脚必须在复位释放瞬间有确定电平
- **KP-CASE-PICO-07** micro-USB：90 Ω 差分 + ESD 靠连接器，2 层板只能「短而直」
- **KP-CASE-PICO-08** ADC 与模拟域：ADC_AVDD 单独滤波，输入不超范围
- **KP-CASE-PICO-09** 2 层板的地回流：底层整片 GND 铺铜当参考面，换层必须补回流孔
- **KP-CASE-PICO-10** 半孔（castellated）模块封装：DFM 能力与分板应力
- **KP-CASE-PICO-11** 热：RP2040 与 3.3 V 升降压的散热路径

#### [02-arduino-uno-r3.md](<./cases/02-arduino-uno-r3.md>) — 案例 02：Arduino Uno R3 —— 双 MCU 架构、电源自动切换与 5 V 单板的热边界

- 文档：`docs/knowledge/cases/02-arduino-uno-r3.md`
- KP：**10**（01–10） · 结构化条目：**2**
- **KP-CASE-UNO-01** 两路电源不能直接并联：必须用比较器 + P-MOSFET 做优先级切换
- **KP-CASE-UNO-02** 线性稳压把「热」变成设计边界：VIN 越高、负载越大，5 V LDO 越危险
- **KP-CASE-UNO-03** 双 MCU 架构：USB 交给 16U2，主控只管应用
- **KP-CASE-UNO-04** 两颗 16 MHz 晶振：USB 侧的时钟精度决定「能不能被识别」
- **KP-CASE-UNO-05** DTR 自动复位：AC 耦合到 RESET，是「能下载」的关键小电路
- **KP-CASE-UNO-06** USB 数据线缺专用 ESD 阵列：这是开发板的已知妥协
- **KP-CASE-UNO-07** 可恢复保险丝与二极管：给供电边界一个可量化的上限
- **KP-CASE-UNO-08** 5 V / 3.3 V 混合电平：接口处必须先确认电平，再谈保护
- **KP-CASE-UNO-09** 2 层板 + 地铺铜：去耦靠「近」，回流靠「整片」
- **KP-CASE-UNO-10** 排针间距与安装孔是「接口规范」：机械不兼容等于电气白做

#### [03-esp32-devkit.md](<./cases/03-esp32-devkit.md>) — 案例 03：ESP32-DevKitC / ESP32-S3-DevKitC —— 无线模组底板的天线净空、峰值电流与自动下载

- 文档：`docs/knowledge/cases/03-esp32-devkit.md`
- KP：**11**（01–11） · 结构化条目：**2**
- **KP-CASE-ESP32-01** 底板不做 RF 设计：射频、晶振、匹配网络都在模组内
- **KP-CASE-ESP32-02** 天线净空区（keep-out）是硬约束：任何层都不得有铜、器件、走线
- **KP-CASE-ESP32-03** 3.3 V LDO 必须按 Wi-Fi 发射峰值选型，不能按平均电流
- **KP-CASE-ESP32-04** 去耦：模组 3V3 引脚就近 0.1 µF + 10 µF 级体电容，回路要短
- **KP-CASE-ESP32-05** EN 复位：RC 延时 + 按键，上电时序必须确定
- **KP-CASE-ESP32-06** BOOT 自动下载电路：DTR/RTS 两管控制 EN 与 GPIO0
- **KP-CASE-ESP32-07** strapping 引脚必须有确定的默认电平
- **KP-CASE-ESP32-08** USB-UART 桥与 USB 差分：2 层板短直走线，ESD 是可改进的妥协
- **KP-CASE-ESP32-09** 5 V/3.3 V 双电源入口：外部供电与 USB 供电要防反灌
- **KP-CASE-ESP32-10** 2 层板的地：模组下方整片铺地，天线区禁铜，缝合过孔按 λ/20
- **KP-CASE-ESP32-11** 热：Wi-Fi 持续发射 + LDO 是主要热源

#### [04-stm32-nucleo.md](<./cases/04-stm32-nucleo.md>) — 案例 04：ST STM32 Nucleo-64 官方参考设计 —— 把“供电选择、电流测量、调试隔离”做成可见连接

- 文档：`docs/knowledge/cases/04-stm32-nucleo.md`
- KP：**11**（01–11） · 结构化条目：**1**
- **KP-CASE-NUCLEO-01** 评估板的真正价值：每个可配置项都有跳线/焊桥/测试点
- **KP-CASE-NUCLEO-02** 多路 5V 来源必须互锁：跳线选择或 ORing，禁止简单并联
- **KP-CASE-NUCLEO-03** 3.3V LDO 的压差与功耗决定它能不能“从 VIN 供电”
- **KP-CASE-NUCLEO-04** 8MHz HSE 晶振要“贴、短、对称、净空”
- **KP-CASE-NUCLEO-05** NRST 与 BOOT0 必须有确定电平，不能悬空
- **KP-CASE-NUCLEO-06** 板载 ST-LINK：SWD + VCP + 可断开焊桥，是调试通路最小集
- **KP-CASE-NUCLEO-07** USB 受电口：90Ω 差分 + 连接器侧 ESD + VBUS 保护
- **KP-CASE-NUCLEO-08** 每个 VDD 脚就近 100 nF，VDDA 单独滤波
- **KP-CASE-NUCLEO-09** 整片地 + 局部保护，比“分模拟地/数字地”更有效
- **KP-CASE-NUCLEO-10** 评估板的 EMC 余量来自“接口保护 + 短回流 + 完整地”，不来自堆料
- **KP-CASE-NUCLEO-11** 可测试性/可制造性：焊桥、丝印、定位点、排针间距都要在 DFM 评审里过

#### [05-usb-c-pd-sink.md](<./cases/05-usb-c-pd-sink.md>) — 案例 05：USB-C PD 受电/充电参考设计 —— CC 是“通行证”，VBUS 开关与泄放是“安全闸”

- 文档：`docs/knowledge/cases/05-usb-c-pd-sink.md`
- KP：**12**（01–12） · 结构化条目：**1**
- **KP-CASE-USBCPD-01** 两个独立 5.1 kΩ Rd 是“能被供电”的最小必要条件
- **KP-CASE-USBCPD-02** PD 协商是 CC 上的 BMC 数字通信，不是模拟分压
- **KP-CASE-USBCPD-03** VBUS 开关与泄放：换档前必须先落到 vSafe0V
- **KP-CASE-USBCPD-04** 死电池（dead battery）路径：系统没电也要能拿到 5 V
- **KP-CASE-USBCPD-05** 上电/复位时序：VBUS 建立、控制器复位、PG 与后级使能要有先后
- **KP-CASE-USBCPD-06** VBUS 入口保护顺序：连接器 → ESD/TVS → 保险丝/eFuse → 开关 → 后级
- **KP-CASE-USBCPD-07** CC 走线与 ESD：短、独立、低电容，不并大电容
- **KP-CASE-USBCPD-08** USB2 D+/D−：90Ω 差分 + ESD + 不跨分割
- **KP-CASE-USBCPD-09** 涌流与 VBUS 电容：受电端电容有上限，必须软启动/限流
- **KP-CASE-USBCPD-10** PD 控制器供电与接口：去耦、I2C 地址、GPIO 中断
- **KP-CASE-USBCPD-11** 整机 EMC/ESD：接口保护 + 外壳地 + 线缆共模，按产品等级做
- **KP-CASE-USBCPD-12** 热与 DFM：VBUS 开关/充电 IC 的损耗按最大档位算

#### [06-sync-buck-layout.md](<./cases/06-sync-buck-layout.md>) — 案例 06：同步 Buck 电源参考布局 —— 先管“热环路”，再谈纹波与效率

- 文档：`docs/knowledge/cases/06-sync-buck-layout.md`
- KP：**12**（01–12） · 结构化条目：**2**
- **KP-CASE-BUCK-01** 热环路（hot loop）面积是布局第一优先级
- **KP-CASE-BUCK-02** 输入电容：VIN 与 PGND 成对、就近、并联多颗
- **KP-CASE-BUCK-03** SW 节点：面积最小、载流够、不引长线
- **KP-CASE-BUCK-04** 电感：紧靠 SW、下方净空、按饱和/温升选
- **KP-CASE-BUCK-05** 布局前置约束：开关频率、电感、输出电容必须先定
- **KP-CASE-BUCK-06** 使能/软启动/频率设置：小信号要有确定电平且靠近芯片
- **KP-CASE-BUCK-07** 保护与接口：OCP/OVP/UVLO 与 PGOOD 的布局同样影响可靠性
- **KP-CASE-BUCK-08** 输出电容与反馈取样：Kelvin 从输出电容之后取
- **KP-CASE-BUCK-09** 地：PGND 与 AGND 单点连接，内层地完整
- **KP-CASE-BUCK-10** 自举与 VCC：短回路、就近去耦
- **KP-CASE-BUCK-11** 开关电源的 EMC：源头（dv/dt、di/dt、环路）+ 传播路径一起管
- **KP-CASE-BUCK-12** 散热：EPAD 过孔阵列 + 铜面积 + 热焊盘

#### [07-isolated-can-rs485.md](<./cases/07-isolated-can-rs485.md>) — 案例 07：隔离 CAN / RS485 工业节点参考设计 —— 隔离带是“结构”，不是一条分割线

- 文档：`docs/knowledge/cases/07-isolated-can-rs485.md`
- KP：**12**（01–12） · 结构化条目：**2**
- **KP-CASE-CANISO-01** 隔离节点四件套：隔离电源 + 数字隔离 + 收发器 + 总线保护
- **KP-CASE-CANISO-02** 隔离电源的开关噪声会直接调制到总线上
- **KP-CASE-CANISO-03** 使能/方向/上电时序：不得让总线出现“错误驱动”
- **KP-CASE-CANISO-04** CAN 终端：120Ω 分裂终端 + 中心电容
- **KP-CASE-CANISO-05** RS485 终端与失效保护偏置
- **KP-CASE-CANISO-06** TVS / 共模电感：位置比型号更重要
- **KP-CASE-CANISO-07** 总线布线：成对、无 stub、终端在两端
- **KP-CASE-CANISO-08** 两侧地必须真正分开：万用表测应开路
- **KP-CASE-CANISO-09** 隔离带：爬电/间隙按标准算，必要时开槽
- **KP-CASE-CANISO-10** 屏蔽、Y 电容与共模回流：给共模电流一条受控路径
- **KP-CASE-CANISO-11** 整机抗扰：ESD/EFT/浪涌按工业等级做，保护地回路要短
- **KP-CASE-CANISO-12** 热与 DFM：隔离电源占位、开槽可制造、丝印标隔离区

#### [08-wardrobe-v12.md](<./cases/08-wardrobe-v12.md>) — 案例 08：衣橱助手参考原理图 V1.2 —— ESP32-S3 整机的电源树、USB HUB 与音视频接口

- 文档：`docs/knowledge/cases/08-wardrobe-v12.md`
- KP：**10**（01–10） · 结构化条目：**3**
- **KP-CASE-WARDROBE12-01** 电源域按“噪声/电压/关断”三原则划分
- **KP-CASE-WARDROBE12-02** 电池采样用高阻分压 + 可选开关，避免长期漏电
- **KP-CASE-WARDROBE12-03** 充电与升压拓扑必须与电池化学体系匹配
- **KP-CASE-WARDROBE12-04** 防反接与浪涌保护要放在“最靠近连接器”的位置
- **KP-CASE-WARDROBE12-05** USB HUB 把“下载/调试/数据”拆成独立下游口
- **KP-CASE-WARDROBE12-06** USB 差分对按 90Ω 设计，ESD 器件放在连接器侧
- **KP-CASE-WARDROBE12-07** USB-C CC 下拉是“受电”身份的硬性条件
- **KP-CASE-WARDROBE12-08** DVP 摄像头按“并行总线 + 独立模拟电源”设计
- **KP-CASE-WARDROBE12-09** I2S 音频要区分“数字时钟域”和“模拟地参考”
- **KP-CASE-WARDROBE12-10** 共享 I2C 总线要核对地址、上拉与总线电容

#### [09-wardrobe-v20.md](<./cases/09-wardrobe-v20.md>) — 案例 09：衣橱助手 V2.0（主板 + 按键灯板）—— 4 层异形板的电源树、天线净空与细间距 DFM

- 文档：`docs/knowledge/cases/09-wardrobe-v20.md`
- KP：**10**（01–10） · 结构化条目：**4**
- **KP-CASE-WARDROBE20-01** 4 层板优先“信号-地-电源-信号”，但异形板要先定板框再谈叠层
- **KP-CASE-WARDROBE20-02** 电源树按“充电-储能-升压-降压-负载”分层，并核算每一级的电流
- **KP-CASE-WARDROBE20-03** 电池充电 IC 的“后缀电压”是硬约束，不是可调参数
- **KP-CASE-WARDROBE20-04** 升压/降压外围按 datasheet 计算，不用“参考模块”的默认值
- **KP-CASE-WARDROBE20-05** ESP32 模组天线净空区必须“四层无铜、无走线、无器件、无丝印”
- **KP-CASE-WARDROBE20-06** 射频模组的电源去耦与地回流要“短、宽、多孔”
- **KP-CASE-WARDROBE20-07** 0.5mm 细间距器件禁止盘中孔，阻焊桥与钢网要同步设计
- **KP-CASE-WARDROBE20-08** 板间连接器用“交叉线序 + 防呆 + 低电容 TVS”防装反
- **KP-CASE-WARDROBE20-09** 异形板框不能 V-CUT，拼板用邮票孔/铣槽
- **KP-CASE-WARDROBE20-10** 结构件与 3D 复核是“能不能装”的最后一道门

#### [10-circuitpilot-6l.md](<./cases/10-circuitpilot-6l.md>) — 案例 10：CircuitPilot 6 层监测板 —— 90Ω 差分反解、屏蔽过孔墙与“编译器抓出的 CC 缺失”

- 文档：`docs/knowledge/cases/10-circuitpilot-6l.md`
- KP：**10**（01–10） · 结构化条目：**2**
- **KP-CASE-CP6L-01** 阻抗控制必须“叠层→线宽→回算”闭环，不能拍脑袋填线宽
- **KP-CASE-CP6L-02** 差分对“等长 + 等距 + 同参考 + 少过孔”四件事缺一不可
- **KP-CASE-CP6L-03** 差分对两侧的 GND 屏蔽过孔墙要“连续、够密、不切断参考”
- **KP-CASE-CP6L-04** 6 层板要明确每一层的“职责”，避免“有层但没参考”
- **KP-CASE-CP6L-05** 电流监测（INA226 类）要用开尔文接法，采样电阻功率与温漂要核算
- **KP-CASE-CP6L-06** 温湿度/温度传感器要远离热源与板边，并留热隔离槽/开窗
- **KP-CASE-CP6L-07** I2C 多器件共享要核对地址、上拉、总线电容与 ALERT 极性
- **KP-CASE-CP6L-08** CC1/CC2 各一只 5.1kΩ 下拉是受电“通电”的前提，编译器应在投板前拦住缺件
- **KP-CASE-CP6L-09** USB ESD 器件要靠近连接器，且结电容/钳位满足 HS 要求
- **KP-CASE-CP6L-10** “DRC 有项数”比“DRC 0 项”更可信：要区分真违规、陈旧填充与未布线

#### [11-ch32v003-p0.md](<./cases/11-ch32v003-p0.md>) — 案例 11：CircuitPilot CH32V003 P0 —— 45×30mm 2 层最小系统的成本极限

- 文档：`docs/knowledge/cases/11-ch32v003-p0.md`
- KP：**10**（01–10） · 结构化条目：**1**
- **KP-CASE-CH32-01** 低成本 MCU 最小系统 = 电源 + 去耦 + 复位/BOOT + 下载口 + 晶振（若需要）
- **KP-CASE-CH32-02** LDO 的输入/输出电容与压差/热耗要按实际负载核算
- **KP-CASE-CH32-03** Type-C 受电只做“5V 取电”也要两只 5.1kΩ CC 下拉
- **KP-CASE-CH32-04** 按键/ LED 的“小电阻”决定可制造性与可测试性
- **KP-CASE-CH32-05** 2 层板靠“双面 GND 铺铜 + 过孔缝合”补回流
- **KP-CASE-CH32-06** 盘中孔（via-in-pad）必须确认塞孔/填平工艺，否则虚焊漏锡
- **KP-CASE-CH32-07** 无安装孔/无测试点的“成本板”要提前确认结构固定与产线测试方式
- **KP-CASE-CH32-08** “DRC 0 项”不等于“DFM 通过”，发布必须区分自动检查与人工 DFM
- **KP-CASE-CH32-09** 缺货替代料必须“同封装/同参数/同工艺”并重新验证
- **KP-CASE-CH32-10** 上电前“短路检查 + 限流供电”是最便宜的风险控制

#### [12-consumer-tws.md](<./cases/12-consumer-tws.md>) — 案例 12：消费电子 TWS / 可穿戴 —— 结构先定、电源其次，天线与音频是硬约束

- 文档：`docs/knowledge/cases/12-consumer-tws.md`
- KP：**11**（01–11） · 结构化条目：**1**
- **KP-CASE-TWS-01** 超小板的第一个约束是结构与装配，不是电气
- **KP-CASE-TWS-02** 充电盒与耳机是两套电源树，不要按“一块板”设计
- **KP-CASE-TWS-03** 充电电流、截止电压、温度保护必须与电池规格逐项匹配
- **KP-CASE-TWS-04** 电池保护必须独立于充电 IC，且过放恢复要有明确策略
- **KP-CASE-TWS-05** 天线净空是第一位约束：耳机里比板上更难，因为电池和人体都在旁边
- **KP-CASE-TWS-06** 射频走线按 50 Ω 处理，匹配网络靠近天线且地参考连续
- **KP-CASE-TWS-07** 音频链路：功放电源去耦 + 单点 AU_GND + 默认静音，三件事决定“有没有爆音”
- **KP-CASE-TWS-08** 充电触点是“用户可触摸的裸金属”，ESD/浪涌路径必须在触点侧处理
- **KP-CASE-TWS-09** 超小板的去耦与地：引脚到电容的 2 mm 比“总容量”重要
- **KP-CASE-TWS-10** 热：充电 + 射频 + 音频同时工作，小体积里没有对流
- **KP-CASE-TWS-11** DFM 与可测试性：0.4 mm 间距、拼板分板、测试点都要在布局阶段定

#### [13-industrial-controller.md](<./cases/13-industrial-controller.md>) — 案例 13：工业控制器 —— 宽压输入、隔离总线、宽温与抗扰是四条硬边界

- 文档：`docs/knowledge/cases/13-industrial-controller.md`
- KP：**11**（01–11） · 结构化条目：**1**
- **KP-CASE-INDUSTRIAL-01** 24 V 输入的保护顺序是“先泄放、再阻断、后稳压”
- **KP-CASE-INDUSTRIAL-02** 隔离侧要有独立隔离电源，不能从非隔离侧“借电”
- **KP-CASE-INDUSTRIAL-03** 隔离带是物理结构：无铜、无过孔、爬电/间隙按标准算
- **KP-CASE-INDUSTRIAL-04** RS485/CAN 终端、偏置与 TVS 的位置决定“能不能长期活”
- **KP-CASE-INDUSTRIAL-05** 隔离器两侧的去耦与地：每侧各自就近，禁止跨带
- **KP-CASE-INDUSTRIAL-06** EMC 抗扰要按 IEC 61000-4 系列逐项设计，不是“加个 TVS”**
- **KP-CASE-INDUSTRIAL-07** 数字输入的隔离与滤波：现场 24 V 不能直接进 MCU
- **KP-CASE-INDUSTRIAL-08** 宽温设计是“降额 + 选型 + 布局”三件事，不是筛选
- **KP-CASE-INDUSTRIAL-09** 掉电保持与看门狗：工业现场断电是常态，不是异常
- **KP-CASE-INDUSTRIAL-10** 4～20 mA / 电流采样：开尔文接法 + 成对走线 + 功率降额
- **KP-CASE-INDUSTRIAL-11** 机械防护与可测试性：端子、安装孔、三防与调试口都要在布局阶段定

#### [14-ac-dc-power.md](<./cases/14-ac-dc-power.md>) — 案例 14：AC-DC / 适配器 —— 安规是设计输入，隔离带与热环路是两条命门

- 文档：`docs/knowledge/cases/14-ac-dc-power.md`
- KP：**10**（01–10） · 结构化条目：**1**
- **KP-CASE-ACDC-01** 先定绝缘等级/污染等级/海拔/过压类别，再谈间距与器件
- **KP-CASE-ACDC-02** 隔离带是物理结构：所有层无铜、无过孔、必要时开槽，且宽度按查表值
- **KP-CASE-ACDC-03** Y 电容是“共模回流通道”，容值受安规漏电流限制
- **KP-CASE-ACDC-04** 输入保护顺序：保险丝 → 压敏/NTC → X 电容/共模 → 整流
- **KP-CASE-ACDC-05** 初级热环路（输入电容—开关管—变压器）面积决定 EMI 与效率
- **KP-CASE-ACDC-06** 变压器/光耦/隔离反馈是隔离带的“合法跨越点”，但周边布线仍要守距离
- **KP-CASE-ACDC-07** 次级整流与输出电容：环路要小，纹波与寿命要一起算
- **KP-CASE-ACDC-08** 热：效率与损耗分布决定散热结构，电解电容是寿命短板
- **KP-CASE-ACDC-09** 高压测量与安规验证：耐压、绝缘电阻、爬电、漏电流四件套
- **KP-CASE-ACDC-10** DFM 与认证标识：高压区丝印、开槽、三防与安全标识

#### [15-rf-module.md](<./cases/15-rf-module.md>) — 案例 15：RF 模组 / 天线 —— 50 Ω、净空、共存三件事决定“能不能连得远”

- 文档：`docs/knowledge/cases/15-rf-module.md`
- KP：**10**（01–10） · 结构化条目：**1**
- **KP-CASE-RFMOD-01** 底板不设计射频：模组与底板的责任边界必须先划清
- **KP-CASE-RFMOD-02** 射频走线必须按 50 Ω 单端设计，且参考面连续
- **KP-CASE-RFMOD-03** 射频走线要远离噪声源与金属件，长度按“最短可行”而非“布线方便”
- **KP-CASE-RFMOD-04** 天线净空是硬约束：所有层禁铜、禁器件、禁走线，宁大勿小
- **KP-CASE-RFMOD-05** 匹配网络按 π 型留焊盘，元件靠近天线端且地端多过孔
- **KP-CASE-RFMOD-06** 电源噪声会直接调制到射频：按发射峰值电流做去耦与 LDO/Buck 选型
- **KP-CASE-RFMOD-07** 共存：多射频同时工作时，滤波、隔离与时分策略要一起设计
- **KP-CASE-RFMOD-08** 天线口/射频前端的 ESD 与浪涌：保护器件要低电容、靠接口
- **KP-CASE-RFMOD-09** 认证是“整机行为”：预测试、测试口与结构一起规划
- **KP-CASE-RFMOD-10** 量产一致性：天线一致性靠工艺与抽检，不靠“设计一次成功”

#### [16-flex-rigid-board.md](<./cases/16-flex-rigid-board.md>) — 案例 16：柔性 / 刚挠结合板 —— 弯折区是“结构件”，不是普通布线区

- 文档：`docs/knowledge/cases/16-flex-rigid-board.md`
- KP：**10**（01–10） · 结构化条目：**1**
- **KP-CASE-FLEX-01** 先把板分成刚性区、柔性区、过渡区、连接器区，再谈布线
- **KP-CASE-FLEX-02** 弯折区走线必须垂直于弯折线，且禁止跨弯折线换层/打孔
- **KP-CASE-FLEX-03** 弯折半径与板厚/铜厚共同决定寿命，半径不足是断线首因
- **KP-CASE-FLEX-04** 补强（stiffener）要覆盖连接器/焊接区，但必须避开弯折区
- **KP-CASE-FLEX-05** FPC 连接器：翻盖方向、Pin1 标识、插拔空间三件事缺一不可
- **KP-CASE-FLEX-06** 刚挠过渡区是分层与开路的高发区：禁布、禁孔、留结合宽度
- **KP-CASE-FLEX-07** 覆盖膜（coverlay）开窗要包住焊盘并留工艺余量，不能按阻焊思维设计
- **KP-CASE-FLEX-08** 柔性区的阻抗要按“柔性材料 + 覆盖膜”重新算，不能沿用刚性板参数
- **KP-CASE-FLEX-09** 装配：柔性板要“托着装”，不能悬空受力
- **KP-CASE-FLEX-10** 可靠性验证：弯折寿命、湿热、冷热冲击、插拔四类测试缺一不可

### 评审清单

#### [component-selection.md](<./checklists/component-selection.md>) — 选型评审清单（Component Selection Checklist）

- 文档：`docs/knowledge/checklists/component-selection.md`
- KP：**0** · 结构化条目：**1**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

#### [layout-review.md](<./checklists/layout-review.md>) — Layout 评审清单（PCB Layout Review Checklist）

- 文档：`docs/knowledge/checklists/layout-review.md`
- KP：**0** · 结构化条目：**1**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

#### [schematic-review.md](<./checklists/schematic-review.md>) — 原理图评审清单（Schematic Review Checklist）

- 文档：`docs/knowledge/checklists/schematic-review.md`
- KP：**0** · 结构化条目：**2**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

### 需求档案

#### [requirements.md](<./requirements/requirements.md>) — 衣橱助手 PCB 需求与验收清单（需求档案）

- 文档：`docs/knowledge/requirements/requirements.md`
- KP：**0** · 结构化条目：**0**
- 说明：该文档使用章节/表格而非 `KP-*` 编号；内容仍在知识库中，按文档名和标题检索。

## 6. 无 KP 编号的文档（有意保留）

这些文档不是“漏整理”，而是清单/需求/专题笔记；它们的价值在可勾选条目或边界说明，不强行造 KP 编号。

| 文档 | 领域 | 原因 |
|---|---|---|
| [15-circuitpilot-recheck-truthfulness.md](<./pcb/15-circuitpilot-recheck-truthfulness.md>) | pcb | 能力边界/研究笔记/API 专题，按章节组织比强行编号更清晰 |
| [16-fine-pitch-escape.md](<./pcb/16-fine-pitch-escape.md>) | pcb | 能力边界/研究笔记/API 专题，按章节组织比强行编号更清晰 |
| [17-circuitpilot-mechanical-capability-gaps.md](<./pcb/17-circuitpilot-mechanical-capability-gaps.md>) | pcb | 能力边界/研究笔记/API 专题，按章节组织比强行编号更清晰 |
| [18-four-layer-planes-mech-holes-and-research-limits.md](<./pcb/18-four-layer-planes-mech-holes-and-research-limits.md>) | pcb | 能力边界/研究笔记/API 专题，按章节组织比强行编号更清晰 |
| [19-camera-interface-gc0308-and-eda-netlist-edit-limits.md](<./pcb/19-camera-interface-gc0308-and-eda-netlist-edit-limits.md>) | pcb | 能力边界/研究笔记/API 专题，按章节组织比强行编号更清晰 |
| [20-researched-layout-constraints.md](<./pcb/20-researched-layout-constraints.md>) | pcb | 能力边界/研究笔记/API 专题，按章节组织比强行编号更清晰 |
| [21-eda-api-eco-playbook.md](<./pcb/21-eda-api-eco-playbook.md>) | pcb | 能力边界/研究笔记/API 专题，按章节组织比强行编号更清晰 |
| [22-ai-assisted-layout-and-readable-schematic.md](<./pcb/22-ai-assisted-layout-and-readable-schematic.md>) | pcb | 能力边界/研究笔记/API 专题，按章节组织比强行编号更清晰 |
| [component-selection.md](<./checklists/component-selection.md>) | checklists | 可勾选评审清单，条目本身就是检查项 |
| [layout-review.md](<./checklists/layout-review.md>) | checklists | 可勾选评审清单，条目本身就是检查项 |
| [schematic-review.md](<./checklists/schematic-review.md>) | checklists | 可勾选评审清单，条目本身就是检查项 |
| [requirements.md](<./requirements/requirements.md>) | requirements | 产品需求/验收档案，不进入设计门禁 |

## 7. 索引健康检查

生成时会检查并暴露以下问题：

- 重复 `KP-*` ID；
- 有结构化条目但没有对偶文档的路径；
- 文档没有结构化条目（`requirements` 除外）；
- 索引是否落后于源文档。

当前检查结果：

- 重复 KP ID：无
- 文档无结构化条目：无
- 条目对应文档不存在：无
- 文档/条目逐项校验见 `npm run knowledge:index:check` 与 `node scripts/seed-knowledge-pcb.mjs --check`。

