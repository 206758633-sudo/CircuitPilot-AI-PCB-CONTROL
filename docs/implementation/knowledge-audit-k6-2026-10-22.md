# K6 知识库全面审计与补充清单（2026-10-22）

> 审计对象：`docs/knowledge/`（38 篇文档 / 6599 行 / 540 个 KP）+ `knowledge/pcb/dataset/`（181 条结构化知识）+ 运行中知识库（284 条）+ RAG（39 条 golden query）。
> 结论先行：**知识点数量已够“入门到中级”，但离“可评审、可门禁、可量产”还差三层**——①治理层（0 条 approved、运行态与仓库不一致、冲突未登记）；②内容层（可靠性/测试/认证/柔性/封装/模拟/传感器/电池/RF/先进电源等 10+ 个域没有专门知识）；③证据层（元件料号大面积未核验、部分规则数值口径冲突、RAG 评估偏松）。
> 本轮是**只读审计**，未改动知识库内容；缺口与建议见 §4–§6。

---

## 1. 盘点：现在有什么

### 1.1 文档层面（38 篇 / 6599 行 / 540 KP）

| 域 | 文档数 | 行数 | KP 数 | 结构化条目（按 doc 指针） | 评价 |
|---|---:|---:|---:|---:|---|
| `pcb/` | 8 | 1588 | 166 | 83 | 制造/叠层/高速/布局强；可靠性、测试、安规、柔性、封装装配缺 |
| `schematic/` | 7 | 1357 | 134 | 31 | 数字/电源/保护/接口/音频强；**规范（01）与 ERC（06）0 条目** |
| `components/` | 7 | 1499 | 121 | 34 | 无源/二极管/MOSFET/电源 IC/晶振强；**传感器、执行器、电机、连接器族、磁性件缺** |
| `cases/` | 11（+README） | 1819 | 119 | 11 | 开发板+本地板为主；缺消费/工业/电源/RF/柔性/电机/电池案例 |
| `checklists/` | 3 | 208 | 0 | **0** | 三张评审清单没有结构化条目，Agent 无法直接引用 |
| `README.md` | 1 | 66 | 0 | 0 | 索引，正常 |

### 1.2 结构化知识（181 条）

| kind | 数量 | 覆盖情况 |
|---|---:|---|
| `rule` | 77 | PCB 规则为主（载流/间距/过孔/阻抗/叠层/DFM/布局/多层/布局依据）；**原理图规则几乎为 0** |
| `module` | 37 + 11（cases） | LDO/Buck/Boost/USB-C/充电/MCU/I2C/SPI/UART/USB2/CAN/RS485/电平/ESD/LED/RGB/音频/ADC/RF/SWD/叠层/HDI/DDR/布局；缺 BMS/电机/传感器/以太网/PCIe/USB3+/显示/隔离电源等 |
| `part` | **27** | 仅 13 类（电阻 3、电容 4、电源 IC 4、MOSFET 3、二极管 2、保护 2、连接器 2、晶振 2，其余各 1）；**19 条 `lcscIdVerified=false`、2 条无 LCSC 号、仅 6 条标 true** |
| `failure` | 29 | 焊接/ESD/电源/时钟/接口/制造/高速基础失败；缺空洞/枕头效应/焊盘坑裂/晕圈/晶须/枝晶/电池鼓包/RF 失谐/连接器微动等 |

### 1.3 运行态（`http://127.0.0.1:4178`）

| 指标 | 数值 | 说明 |
|---|---|---|
| 总条目 | **284** | rule 87 · module 86 · part 63 · failure 48 |
| 仓库数据集 | **181**（180 unique key） | 运行态比仓库多 **84 条** |
| 运行态独有（不可由仓库复现） | **84** | 10 rule / 38 module / 17 part / 19 failure；来源 `seed-k0`（需求清单/旧目录/网页抓取） |
| 重复 entityKey | **17 个 part key**（34 条） | 同一 LCSC 同时存在 K0 与 K1 两条不同 digest，未 supersede；`/api/knowledge/conflicts?entityKey=...` 仍返回 `[]` |
| trust | reference 274 · unverified 10 | 没有 `authoritative` |
| review | **candidate 284 · approved 0** | `gateUsable=0`，即知识库目前对门禁“零可用” |
| RAG | 39/39 Hit@1、MRR=1.0 | 评估通过，但评估方法偏松（见 §3-Q7） |

---

## 2. 覆盖矩阵：哪些域强、哪些域缺

图例：**强**=有专门文档+多条结构化条目+案例；**中**=有文档但条目少/不系统；**弱**=只有零散规则或一两篇文档；**缺**=没有专门知识。

| # | 知识域 | 现状 | 依据（文档/条目） | 主要缺口 |
|---:|---|---|---|---|
| 1 | 原理图规范/命名/版本/层次 | 中 | `schematic/01`（18 KP，**0 条目**） | 无结构化规则/失败模式，Agent 无法引用 |
| 2 | ERC 与原理图评审 | 中 | `schematic/06`（19 KP，**0 条目**）+ 3 张清单（0 条目） | ERC 台账/豁免/证据要求未条目化 |
| 3 | 元件选型/降额/库/料号 | 中 | `components/01–07`（121 KP，27 parts） | 降额标准、EOL/替代料、连接器/磁性件/传感器/执行器、LCSC 核验 |
| 4 | 电源架构/变换器 | 中强 | `schematic/02`、`components/04`、SCH-MOD-LDO/BUCK/BOOST/CHARGER | Boost/Buck-Boost/反激/LLC/多相/热插拔/eFuse/ORing/隔离电源 |
| 5 | 模拟信号链 | 弱 | `schematic/07`（音频 25 KP）、SCH-MOD-ADC | 运放/仪表放大器/基准/滤波器/DAC/比较器/噪声预算（非音频） |
| 6 | 数字接口/总线 | 强 | `schematic/04`（19 KP/10 条目）、SCH-MOD-* | 以太网/PCIe/USB3+/MIPI/HDMI/LVDS/SDIO 等高速协议细节 |
| 7 | 高速/多层/HDI | 强 | `pcb/07`（30 KP/25 条目）、PCB-MOD-STACKUP/DDR/HDI | 协议级（PCIe Gen4/5、USB4、25G 以太网）与仿真关联 |
| 8 | RF/天线 | 弱 | RF-001/PLACE-RF/PLACE-ANTENNA-15MM、SCH-MOD-RF、CMP-078~081 | 匹配网络/巴伦/滤波器/天线调试/整机认证/共存（WiFi+BT） |
| 9 | EMC/ESD/热（板级） | 中强 | `pcb/05`（17 KP/8 条目）、PCB-MOD-EMC/THERMAL | 预测试方法、整改流程、IEC 61000-4 系列、热仿真 |
| 10 | DFM/制造/拼板 | 强 | `pcb/06`（18 KP/13 条）、`pcb/08`、PCB-MOD-DFM/PANEL、128 条执行规则包 | 与执行规则包的映射、钢网/回流/波峰/AOI/X-ray 的工艺窗口 |
| 11 | 装配/封装/返修 | 弱 | 仅 PLACE-REWORK、DFM 部分、FOOTPRINT 失败 | BGA/QFN/WLCSP/底部填充/返修/X-ray/空洞/枕头效应 |
| 12 | 测试/ICT/FCT/DFT | 弱 | TESTPOINT-001、PLACE-TEST、DFA 规则包 | 测试策略、覆盖率、边界扫描、治具、产测流程、FCT 用例 |
| 13 | 可靠性/寿命/降额/FMEA | 弱 | 零散（CAF/热/降额提示） | 无专门文档；无降额准则、MTBF、HALT、环境试验、FMEA |
| 14 | 安规/认证 | 弱 | CREEPAGE-001、无线模组认证一句 | CE/FCC/UL、IEC 62368/61000-4、GB31241/UN38.3、认证测试项 |
| 15 | 柔性/刚挠板 | 弱 | FPC-001、衣橱案例 | 无专门文档；弯折半径、补强、覆盖膜、刚挠结合、动态弯折 |
| 16 | 电池/充电/BMS | 弱 | CHARGER-001、SCH-MOD-BAT-CHARGER | BMS、电量计、保护板、热失控、UN38.3、电池认证 |
| 17 | 传感器/执行器/电机 | 弱 | PLACE-SENSOR、SCH-MOD-ADC、CP6L 案例 | 温湿度/压力/IMU/霍尔/光电接口、电机驱动/H 桥/步进/继电器/电磁阀 |
| 18 | 机械/结构/环境 | 弱 | 布局连接器、安装孔规则 | 外壳/IP 等级/跌落振动/散热结构/三防漆/灌封 |
| 19 | 供应链/成本/EOL | 弱 | BOM-001、CMP-076 供货 | 无专门文档；无 EOL/PCN/替代料/双供/成本模型 |
| 20 | 仿真/验证方法 | 弱 | `pcb/05` 热仿真 1 KP | SI/PI/热仿真流程、工具、边界条件、仿真-实测相关性 |
| 21 | 文件/ECO/PLM/知识治理 | 弱 | GERBER/BOM/DRC 规则、README 维护规则 | ECO/PCN/版本矩阵/评审门禁/知识审核 SOP |
| 22 | 案例库 | 中 | 11 篇（4 本地 + 7 公开） | 消费/工业/电源/RF/柔性/电机/电池/失效分析案例 |
| 23 | 需求/验收 | 弱 | 运行态 38 条 `PCB-R/M/F/V`（被标成 module） | 需求清单被错分类为 module；缺需求→规则→验收的追溯 |

---

## 3. 质量问题（按严重度排序，均有证据）

### Q1【P0】审核门禁完全未启用：284 条全部 candidate，approved=0

- `/api/knowledge/health`：`candidates:284, approved:0, gateUsable:0`；`review-queue` 返回 284 个候选。
- 后果：知识库只能“提示”，不能作为任何评审/门禁依据；所谓“candidate ≠ 可用”的红线目前是“全部不可用”。
- 缺：审核 SOP、审核人分配、S/A 级来源清单、批量审核工具、审核抽样规则。

### Q2【P0】文档与结构化条目不一一对应：5 篇内容文档 0 条目

- 0 条目文档：`schematic/01-conventions.md`、`schematic/06-erc-review-checklist.md`、`checklists/component-selection.md`、`checklists/layout-review.md`、`checklists/schematic-review.md`。
- README 声称“一一对应”，实际结构化条目只覆盖 31 个 doc 指针，上述 5 篇完全无 `rule/module/failure` 条目，Agent 只能检索到文档、无法引用可判定规则/失败模式。
- 建议：K7 直接补 ~15 条（SCH-RULE-* / PCB-MOD-REVIEW-* / SCH-FAIL-*），并在测试里加“非 README 文档必须 ≥1 条目”的断言。

### Q3【P0】运行态与仓库数据漂移：84 条不可复现 + 17 个重复 part key

| 项 | 数值 | 证据 |
|---|---:|---|
| live 总条目 | 284 | `/api/knowledge/health` |
| 仓库数据集 | 181 | `seed-knowledge-pcb.mjs --check` |
| live-only | 84（rule 10 / module 38 / part 17 / failure 19） | 按 entityKey 与仓库逐条 diff |
| 重复 part entityKey | 17 个（34 条） | 如 `C2982555` 同时有 `seed-k0`（BOM）与 `seed-pcb-k1`（知识库）两条不同 digest |
| conflict API | `conflicts: []`（对 C2982555） | `/api/knowledge/conflicts?entityKey=C2982555` |
| 运行态 unverified | 10 | 含 5 条 `WEB-*` 规则/失败（Wikipedia/JLCPCB 抓取） |

- 84 条 live-only 中，**38 条是需求/验收条目**（`PCB-R-01`…、`PCB-M-01`…、`PCB-MF-*`、`PCB-V-*`，payload 字段是 `requirement/acceptance/priority`），被放进 `module` kind——语义错位：它们不是“电路模块”。
- 17 个重复 part key 说明运行态把同料号的不同来源当成两条 active 记录，且冲突检测未报；`gateUsable` 也会被重复项污染。
- 后果：RAG 可能返回过时/重复料号，审核人无法判断哪条为准；仓库重灌无法恢复到当前状态。

### Q4【P0】规则冲突/重叠未登记：至少 8 组、约 22 条规则

| 组 | 规则 | 冲突/重叠点 |
|---|---|---|
| 板边/拼板 | `EDGE-001`（元件 ≥0.5 mm）、`PANEL-001`（V-cut 禁布 1 mm、工艺边 5 mm）、`PLACE-EDGE-001`（≥3–5 mm）、`PLACE-PANEL-001`（V-CUT 铜避让 0.4 mm、工艺边 ≥3 mm） | 四个数值都不标“元件本体/焊盘/铜/工艺边”的口径与适用工艺，读者无法判断哪个优先 |
| 去耦 | `DECOUPLE-001`（≤2 mm）、`DECOUPLE-002`（大小电容）、`PLACE-DECOUPLE-001`（≤2 mm/过孔≤1 mm）、`PLACE-PARASITIC-001`（100–500 pH） | mm 与 pH 两套判据未建立“主判据/代理指标”关系 |
| 晶振 | `CRYSTAL-001`（环路最小）、`PLACE-CRYSTAL-001`（≤5–10 mm）、`PLACE-CRYSTAL-GAP-001`（≥2.0 mm） | “近”与“≥2.0 mm”未解释作用对象（本体 vs 时钟引脚 vs 负载电容） |
| ESD | `ESD-001`、`PLACE-ESD-001` | 判定项重叠，未合并 |
| 热 | `THERMAL-001`、`PLACE-THERMAL-001` | 判定项重叠 |
| 测试点 | `TESTPOINT-001`（≥1.0 mm/2.54 mm/上方 15 mm）、`PLACE-TEST-001`（2.54/1.27 mm 网格） | “15 mm 无遮挡”与“1.27 mm 网格”口径不同 |
| RF | `RF-001`、`PLACE-RF-001`、`PLACE-ANTENNA-15MM-001` | 净空定义（板边 vs 外壳内）未统一 |
| Mark/基准点 | `FIDUCIAL-001`、`PLACE-PANEL-001` | 1 mm/2 mm 与 1 mm@3.85 mm 的用途不同但未标注 |

- 另外，`rules/board-layout-rules.json` 有 **128 条可执行规则**（MECH/SPACE/CONN/RF/PWR/SILK/DFM/DFA/GATE），与知识库 181 条形成**第二套规则体系**；知识库文档虽引用 `MECH-03/DFM-12/SILK-05/GATE-03`，但数据集条目没有对应 `ruleId` 映射，也没有“项目规则包优先于通用知识”的优先级声明。
- 后果：同一问题可能出现“知识库说 3–5 mm、项目规则包说 0.5 mm、板厂说 0.4 mm”的三套答案。

### Q5【P1】分类/命名碎片化：77 条规则用了 **70 个不同 category 字符串**

- 规则 category 如“布局/电源完整性”“布局/电源”“电源完整性”“布局/依据”各 1–3 条；模块 37 条用 29 个 category；失败 29 条用 26 个。
- 规则 ID 前缀不统一：`PCB-RULE-*`（K1）、`PCB-RULE-PLACE-*`（K4/K5），还有 `WEB-*` 遗留；无统一 `domain` 字段，无法做覆盖率统计/门禁分组。
- 标签有笔误：part `0402 10kΩ` 的 tags 含 `"0412"`（应为 0402）。
- 后果：RAG 过滤、UI 分组、覆盖率报表都不可靠；新增条目会继续发散。

### Q6【P1】元件知识最薄，且大面积未核验

- 27 条 part / 13 类；`lcscIdVerified=true` 仅 **6** 条，`false` 19 条，无 LCSC 号 2 条；其余均标注“需 Librarian 三源核验”。
- 缺整类：电感/磁珠/共模电感（仅 1 条电感）、保险丝/PTC、TVS 阵列、ESD 阵列、基准源、运放/比较器、ADC/DAC、电平转换、隔离器、光耦、继电器、电机驱动、传感器（温湿度/压力/IMU/霍尔）、蜂鸣器、晶振（有源/TCXO）、连接器（USB-C/FPC/板对板/端子）。
- 后果：用户原始诉求“元件知识”目前只有“选型原则”，没有“可采购、可核验、可替代”的料号级知识。

### Q7【P1】RAG 评估“39/39 通过”但方法偏松

- 39 条 golden query 全是“正向关键词”，expect 正则是关键词匹配，**不校验来源是否为知识库/是否回答了问题**；39 条中 10 条 top1 是文档而非结构化条目（可以接受，但未区分）。
- 缺负向查询（“不存在的知识”应返回低分/拒答）、跨语言查询、同义/口语查询、领域外查询；没有 Hit@1 来源白名单。
- 语料包含 `docs/implementation/`（55 篇项目进度/差距清单）与 `docs/wardrobe-case/`（5 篇），实测“ERC 检查”“ICT/FCT”“SI/PI 仿真”等查询 top1 会命中实现报告（如“第 61 轮 T2…”“CircuitPilot 目标达成全量差距清单”），而不是知识文档。
- 后果：评估指标好看，但真实用户问“怎么做 ICT”时可能拿到项目进度报告。

### Q8【P1】测试覆盖不足

- 只有 `runtime/__tests__/knowledge-pcb-seed.test.mjs` 3 个测试（数据集四类齐全/doc 存在/幂等 candidate/RAG 关键词）。
- 缺：schema 校验（必填字段/类型/单位）、category 白名单、doc↔entry 对偶、规则 ID 唯一/冲突登记、part 身份核验阈值、live-repo 一致性、RAG 负向/来源断言。
- 后果：Q2–Q5 的问题都不会被 CI 拦住。

### Q9【P2】文档陈旧/口径需更新

- `cases/README.md` 仍写“本机无外网，未逐页核对官方文件”——K5 已用 curl 联网核对过部分官方标准/厂商指南，表述需改为“工具层受限；已核对部分公开来源，案例未逐页核对”。
- `docs/knowledge/README.md` 的“一一对应”与 Q2 不符；“现状”数字准确（38/6599/540/181）。
- K1 文档的数值多为经验值，只有 08 篇在 K5 做了来源标注；其余篇缺“依据/来源”字段。

### Q10【P2】需求/验收知识错位

- 运行态 38 条 `PCB-R/M/F/V` 是需求/验收（字段 `requirement/acceptance/priority`），却放在 `module` kind；与“电路模块”语义冲突，会污染模块检索。
- 缺一条“需求 → 规则 → 验收 → 证据”的追溯链；衣橱需求清单（`docs/wardrobe-case/PCB板需求清单-PM版.md`）应作为独立需求目录/验收矩阵，而不是 module。

---

## 4. 需要补充的知识（按优先级）

> 编号建议：PCB 续 `KP-PCB-167` 起；SCH 续 `KP-SCH-135` 起；CMP 续 `KP-CMP-122` 起；案例续 `KP-CASE-*`。条目数按“文档 KP 数 / 结构化条目数”估算。

### P0 · 第一批（治理 + 现有文档补齐 + 三个高风险域）

| 编号 | 补充内容 | 建议文档/KP | 结构化条目目标 | 为什么现在做 |
|---|---|---|---|---|
| P0-1 | **知识治理与审核闭环** | `docs/knowledge/governance.md`（~20 KP） | 3 module（审核 SOP/证据要求/冲突裁决） | 0 approved、84 条漂移、17 重复 key，不先治理，新增越多越乱 |
| P0-2 | **原理图规范/ERC/三张清单条目化** | 不新增文档，补 5 篇现有文档的条目 | ~15 条（SCH-RULE-* / PCB-MOD-REVIEW-* / SCH-FAIL-*） | 5 篇 0 条目，Agent 无法引用；成本最低、收益最快 |
| P0-3 | **可靠性/降额/寿命/FMEA/环境试验** | `pcb/09-reliability-derating.md`（KP-PCB-167~200，~30 KP） | 10 rule · 4 module · 4 failure | 量产/客诉核心；目前只有零散热/CAF 知识 |
| P0-4 | **可测试性/ICT/FCT/DFT/产测** | `pcb/10-testability-production-test.md`（KP-PCB-201~228，~25 KP） | 8 rule · 3 module · 4 failure | 现有只有测试点规则，无量产测试策略/治具/覆盖率 |
| P0-5 | **安规/认证/EMC 标准** | `pcb/11-safety-certification.md`（KP-PCB-229~256，~25 KP） | 8 rule · 3 module · 3 failure | CE/FCC/UL、IEC 62368/61000-4、GB31241/UN38.3 全缺 |
| P0-6 | **元件知识扩充 + 核验** | `components/08-inductors-ferrites-fuses.md`、`09-sensors-actuators.md`、`10-interface-protection.md`（~54 KP） | part 27 → 60；新增 6 module | 用户原始诉求“元件”；当前 21/27 未核验、13 类偏少 |
| P0-7 | **规则体系合并与冲突登记** | 不新增文档；在 dataset 加 `domain`/`scope`/`supersedes`/`conflictGroup` 字段 + 冲突表 | 22 条规则去重/合并/登记 | Q4/Q5 是所有门禁的隐患 |

### P1 · 第二批（结构与模拟/功率/无线）

| 编号 | 补充内容 | 建议文档/KP | 结构化条目目标 | 为什么 |
|---|---|---|---|---|
| P1-1 | **柔性/刚挠板设计** | `pcb/12-flex-rigid-flex.md`（KP-PCB-257~282，~25 KP） | 6 rule · 3 module · 3 failure | 只有 FPC 规则与案例，缺弯折/补强/覆盖膜/刚挠结合 |
| P1-2 | **封装/装配/返修工艺** | `pcb/13-package-assembly-rework.md`（KP-PCB-283~308，~25 KP） | 8 rule · 3 module · 4 failure | BGA/QFN/WLCSP/底部填充/空洞/枕头效应/X-ray 缺 |
| P1-3 | **模拟信号链（非音频）** | `schematic/08-analog-signal-chain.md`（KP-SCH-135~160，~25 KP） | 8 rule · 4 module · 3 failure | 运放/基准/滤波/DAC/比较器/噪声预算缺 |
| P1-4 | **传感器/执行器/电机驱动** | `schematic/09-sensors-actuators.md`（KP-SCH-161~186，~25 KP） | 8 rule · 4 module · 4 failure | 只有 ADC 模块与传感器布局规则 |
| P1-5 | **电池/充电/BMS** | `schematic/10-battery-bms.md`（KP-SCH-187~210，~22 KP） | 7 rule · 3 module · 4 failure | 只有充电 IC 模块与充电规则；缺 BMS/电量计/保护/认证 |
| P1-6 | **RF/天线/匹配/共存** | `schematic/11-rf-antenna.md`（KP-SCH-211~236，~25 KP） | 7 rule · 3 module · 3 failure | 只有净空规则与模组选型；缺匹配/巴伦/调试/共存 |
| P1-7 | **先进电源拓扑** | `schematic/12-power-topologies.md`（KP-SCH-237~262，~25 KP） | 8 rule · 4 module · 3 failure | 只有 LDO/Buck/Boost/充电；缺 Buck-Boost/反激/LLC/多相/热插拔/eFuse/ORing |

### P2 · 第三批（高速/仿真/供应链/机械/案例）

| 编号 | 补充内容 | 建议文档/KP | 结构化条目目标 |
|---|---|---|---|
| P2-1 | 高速协议细节（USB3/4、PCIe Gen4/5、以太网、MIPI、HDMI、SDIO） | `pcb/14-high-speed-protocols.md`（KP-PCB-309~340） | 8 rule · 4 module · 3 failure |
| P2-2 | SI/PI/热仿真工作流与相关性 | `pcb/15-simulation-workflow.md`（KP-PCB-341~362） | 5 rule · 3 module · 3 failure |
| P2-3 | 机械/结构/IP/跌落振动/三防 | `pcb/16-mechanical-environment.md`（KP-PCB-363~386） | 6 rule · 3 module · 3 failure |
| P2-4 | 供应链/成本/EOL/PCN/替代料 | `components/11-supply-chain.md` 或 `pcb/17-supply-chain.md`（~20 KP） | 5 rule · 2 module · 3 failure |
| P2-5 | 文件/ECO/PLM/版本矩阵 | `schematic/13-documentation-eco.md`（~20 KP） | 4 rule · 2 module · 2 failure |
| P2-6 | 案例扩充：消费电子/工业控制/电源/RF/柔性/电机/电池/失效分析 | `cases/12~17`（每篇 ~10 KP） | 6 module（PCB-CASE-*） |
| P2-7 | 元件库/封装标准（IPC-7351 库管理、三源核验 SOP） | `components/12-library-management.md`（~20 KP） | 4 rule · 2 module · 2 failure |

> 累计目标（全部完成）：文档 38 → **57 篇左右**，KP 540 → **约 900**，结构化 181 → **约 350**；其中 P0 阶段约 +110 KP、+55 条目。

---

## 5. 建议执行顺序与验收标准

### K7：治理 + 对齐（P0 前半，优先做）

1. 补 5 篇 0 条目文档 → ~15 条（P0-2）；
2. 合并/登记 22 条冲突规则，新增 `domain/scope/supersedes/conflictGroup` 字段（P0-7）；
3. 把 84 条 live-only 迁移进仓库数据集或标记退役；去重 17 个 part key；修 conflict API（P0-1/Q3）；
4. 统一 category 白名单（规则 70 → 12 个域；模块 29 → 12；失败 26 → 10）；
5. 加测试：doc↔entry 对偶、schema、category、conflict、live-repo diff；
6. RAG：加 8–10 条负向/口语/跨语言查询、来源白名单、实现文档降权；
7. 人工审核 ≥20 条（S/A 级来源优先），让 `approved` 从 0 起步。

**K7 验收**：0 篇内容文档无条目；0 未登记冲突；live 可完整由仓库复现；0 重复 entityKey；approved ≥20；RAG 负向查询正确拒答。

### K8：P0 内容（可靠性/测试/认证/元件）

- 3 篇文档（09/10/11，约 80 KP），26 条结构化条目；
- components 08–10（约 54 KP，part 27→60，全部带 `lcscIdVerified` 或明确“待核验”）；
- 10 条 RAG golden query；测试阈值同步。

### K9：P1 内容（柔性/封装/模拟/传感器/电池/RF/电源）

- 7 篇文档（约 170 KP），约 50 条结构化条目；
- 每篇至少 1 个失败模式 + 1 个可量测规则 + 1 个案例引用。

### K10：P2 内容（协议/仿真/机械/供应链/案例）

- 6–8 篇文档 + 5 个案例，约 150 KP，约 60 条条目；
- 完成后知识库达到“可评审、可门禁、可培训”的完整度。

---

## 6. 现在就能做的 5 个低风险动作

1. **补 5 篇 0 条目文档**（~15 条），预计半天，立刻消除“文档-条目不对应”；
2. **生成冲突登记表**（EDGE/PANEL/DECOUPLE/CRYSTAL/ESD/THERMAL/TEST/RF），只登记不删改；
3. **写 live→repo 迁移/退役清单**（84 条），把 38 条需求类从 module 迁到需求目录；
4. **去重 17 个 part key**，修 conflict API，补 1 条回归测试；
5. **RAG 评估升级**：加负向查询 + 来源白名单，先把“39/39 但 top1 是实现报告”的问题暴露出来。

> 以上动作都不改变“所有新增仍为 candidate + reference”的红线；审核通过前不得作为门禁依据。

---

## 7. 审计方法与证据（可复现）

```bash
# 文档盘点
find docs/knowledge -name '*.md' | wc -l
grep -rh '^### KP-' docs/knowledge | wc -l

# 数据集盘点/校验
node scripts/seed-knowledge-pcb.mjs --check
python3 - <<'PY'  # 统计 kind/category/doc 指针/重复 key
...
PY

# 运行态
curl -s -H "x-circuitpilot-token: $(cat /tmp/cp_app_token.txt)" \
  http://127.0.0.1:4178/api/knowledge/health
curl -s -H "x-circuitpilot-token: ..." \
  'http://127.0.0.1:4178/api/knowledge/entries?kind=part'

# RAG 探针（示例）
curl -s -H "x-circuitpilot-token: ..." -H 'content-type: application/json' \
  -X POST http://127.0.0.1:4178/api/rag/query \
  -d '{"query":"ICT FCT 边界扫描 测试策略","topK":3}'
```

关键证据文件：

- `knowledge/pcb/dataset/*.json`（181 条）
- `rules/board-layout-rules.json`（128 条第二套规则）
- `runtime/__tests__/knowledge-pcb-seed.test.mjs`（仅 3 个测试）
- `scripts/verify-rag.mjs`（39 条 golden query）
- `/api/knowledge/health`、`/api/knowledge/entries`、`/api/knowledge/conflicts`（运行态）
- `docs/implementation/placement-web-verification-k5-2026-10-22.md`（K5 联网核对来源）

---

## 8. 一句话总结

**知识库“广度”已覆盖 PCB 设计主流程，但“深度/证据/治理”还没到位**：最该补的是①可靠性/测试/认证三大量产域；②元件料号级知识（27 条、21 条未核验）；③柔性/封装/模拟/传感器/电池/RF/先进电源七个结构域；最该先修的是 0 条 approved、84 条运行态漂移、17 个重复 part key、22 条口径冲突规则，以及“文档-条目不对应”。
