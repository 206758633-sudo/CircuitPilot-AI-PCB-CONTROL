# PCBA 布局设计规则包 · ESP32 测试板

> 针对 2026-10-18 提供的测试板 3D 渲染图（元件重叠、摆放与接线方向不合理）生成的**量产级 PCBA 布局设计规则**。
> 规则不是泛泛的教科书，而是**逐条对着这块板的具体器件**写成可判定数值，并已用规则把现有问题判成 FAIL。

## 一句话结论

这块板目前**不能投板**：3 处 3D 实体干涉（其中一处压住射频天线端）、2 个 FFC 开口相对无法插线、6 处插线方向散成 4 个方向、丝印 ≥12 处互相叠压且 4 处压在焊盘上（会被板厂 CAM 裁掉导致位号消失）、无拼板/工艺边/Mark/定位孔/安装孔/测试点。
按本规则包整改并通过 10 道门禁（3D 干涉 / 装配净空 / DRC / DFM / DFA / FAI / ECO / 布局变更影响 / 交付放行 / 8 条不可投产红线）后，才具备小批量生产条件。

## 交付物

| 文件 | 内容 | 给谁看 |
| --- | --- | --- |
| [`01-布局诊断.md`](01-布局诊断.md) | 13 处编号缺陷的定位、成因、后果、整改动作 + 根因分析 + 整改顺序 | 硬件负责人 / 评审会 |
| [`02-设计规则A-机械占位连接器RF.md`](02-设计规则A-机械占位连接器RF.md) | **63 条**：MECH 15（板框/拼板/Mark/定位孔）、SPACE 18（占位与禁止叠放）、CONN 17（朝向/插拔空间/线缆禁布区）、RF 13（天线禁布区/缝合） | PCB 工程师改图时逐条照做 |
| [`03-设计规则B-电气丝印制造装配.md`](03-设计规则B-电气丝印制造装配.md) | **65 条**：PWR 13（去耦/载流/热）、SILK 16（字高/位号/极性/禁压焊盘）、DFM 16（线宽线距/过孔/阻焊/拼板/阻抗）、DFA 13（返修/测试点/治具/ESD）、GATE 7（5 道门禁 + 8 条红线） | PCB + 工艺 + 品质 |
| [`06-踩坑台账.md`](06-踩坑台账.md) | 全量 **61 条**踩坑（环境/几何/数据/流程），逐条标注是否已固化成规则或脚本、证据在哪 | 下一位工程师照着躲坑 |
| [`05-画板全过程复盘与经验沉淀.md`](05-画板全过程复盘与经验沉淀.md) | 这次 DBTS-A01 从零到交付的 11 段全过程、10 条关键决策、27 个坑的根因与固化、可复用 SOP | **下次画板前 10 分钟读这个** |
| [`04-规则落地校验清单.md`](04-规则落地校验清单.md) | 本板逐条 PASS/FAIL 核验、放行门禁签核表、151 条规则索引（自动生成）、规则→EDA 落地映射 | 评审签字 / 放行决策 |
| [`rules/board-layout-rules.json`](../../rules/board-layout-rules.json) | 151 条规则的机器可读版（由文档自动抽取，编号严格一致，含 `sourceHashes`） | 写自定义 DRC / 接自动化检查 |
| [`rules/kicad-drc-snippet.kicad_dru`](../../rules/kicad-drc-snippet.kicad_dru) | KiCad 自定义 DRC 片段（可直接粘到 Board Setup → Custom Rules） | 用 KiCad 的团队 |
| **CircuitPilot 规则引擎** [`runtime/engineering/layout-rules.mjs`](../../runtime/engineering/layout-rules.mjs) | 把 151 条规则变成可执行判定（PASS/FAIL/REVIEW/NA + 量值证据 + 10 道门禁 + 可复现哈希），带 HTTP API 与 Web 界面；含 **ZCLR（Z 轴装配净空）**、**MOVE（布局变更影响）**、**PRJ（工程与交付一致性）** 三组真机规则 | 想直接跑审计、不想人肉打勾的团队 |
| [`docs/implementation/pcba-layout-rules-integration.md`](../implementation/pcba-layout-rules-integration.md) | 引擎接入说明：输入契约、输出契约、API、UI、样板实测数字、已知限制 | 接自动化 / 二次开发 |
| [`_baseline-板面基线.md`](_baseline-板面基线.md) | 图像取证底稿：标定、器件清单、缺陷清单（判定依据） | 复核结论可信度 |
| [`artifacts/pcb-layout/board-layout-issues-annotated.png`](../../artifacts/pcb-layout/board-layout-issues-annotated.png) | 图 A：13 处问题标注 | 汇报 / 评审 |
| [`artifacts/pcb-layout/board-layout-proposal.png`](../../artifacts/pcb-layout/board-layout-proposal.png) | 图 B：整改后布局骨架（分区、朝向、净空） | 改图起点 |
| [`artifacts/pcb-layout/crops/`](../../artifacts/pcb-layout/crops/) | 14 张区域放大图（A–N）+ 坐标网格 | 逐处核对 |

## 2026-10-29 新增：ZCLR（Z 轴装配净空）与 MOVE（布局变更影响）

起因是一次真机返工：DBTS-A01 双电池板上 Φ16/20 mm 的铝电解与 8.1 mm 功率电感被放进「排针对插外置充电模块」的装配区，
2D 上只表现为元件重叠，3D 上却是实体互穿 + 模块背面压死；原来 SPACE 组**没有任何一条规则用 `heightMm3d` 判 Z 向**，所以漏判。

| 组 | 条数 | 判什么 | 关键输入 |
| --- | --- | --- | --- |
| **ZCLR** `02` §7 | 9（硬门禁 5 / 推荐 4） | 高度表完整性（01）、同面 3D 实体干涉（02）、装配区插合高度上限（03）、维护侧向环带（04）、高件禁区（05）、正反叠装总高（06）、遮盖区禁放电解/晶振（07）、装配证据覆盖（08）、模块下方气流层（09） | `components[].heightMm3d`、`assemblyZones[]`、`board.enclosureHeightMm` |
| **MOVE** `03` §8 | 5（硬门禁 5） | 搬迁必须登记（01）、开关/功率网络长度上限（02）、环路面积增长上限（03）、搬迁后装配净空复检（04）、与 ECO 编号一致（05） | `changes[]`、`previousPositions`、`nets[]`、`evidence.eco` |

配两个真机样板（`DBTS-A01-MODULE-BEFORE/AFTER`）与一个可复跑的审计脚本：

```bash
node scripts/audit-dbts-3d-layout.mjs     # 读实板 readback，输出返工前/后两份 ZCLR+MOVE 审计 JSON
```

**PRJ 工程与交付一致性组（`03` §9，6 条）** 判的是"板做得对、但发不出去"的问题：工程对象唯一性、规则文档同源、
6 类交付物完整性、阶段门禁证据闭合、记录与实测一致、推断项兜底；由 **GATE-10 交付放行门** 聚合，
配套一键预检：

```bash
npm run preflight:pcb                     # 读 projects/<board>/preflight.json + 磁盘交付物 + 文档哈希
                                          # 退出码 0=PASS / 1=REVIEW / 2=FAIL（可接 CI）
```

返工前判出 3 处同面 3D 实体干涉 + 2 件装配区超高（C39 25 mm、L2 8.1 mm）；返工后硬门禁全清，
只剩两条「推荐」级边界项（C40 7.7 mm、L1 6.0 mm 侵入模块投影）与两条已具名接受的搬迁代价（SW_NODE 环路 ×38）。

---

## 10 分钟读法

1. 看 `01` §1 结论 + 图 A → 知道为什么不能投板。
2. 看 `02` §5 + `03` §6 的「本板裁定值表」→ 直接照着改图（每个器件距边多少、朝哪、留多少净空）。
3. 改完用 `04` §1 逐条打勾 + §2 五道门禁签字 → 放行。

## 在 CircuitPilot 里执行（不用人肉打勾）

```bash
python3 scripts/build-rule-json.py     # 文档 → 规则包（同时写 rules/ 与 runtime/ 两份拷贝）
node --test runtime/engineering/layout-rules.test.mjs   # 11 条引擎自测
npm run test:runtime                   # 全量 Runtime 测试
```

- 界面：`#validation/rules`（验证与交付 → 规则中心）→「审计现状板 / 审计整改骨架 + 自定义输入」；
- API：`GET /api/engineering/layout-rules`、`POST /api/engineering/layout-rules/audit`；
- 三阶段工程报告：`POST /api/engineering/analyze` 传 `input.layoutRules` 即并入审计段与 findings。

引擎对现状板实测：**12 PASS / 54 FAIL（阻断 50）/ 58 REVIEW / 4 NA**，GATE-01 与 GATE-07 不通过；
对整改骨架实测：**0 FAIL / 10 道门禁全通过 → 可放行**。
注意 REVIEW 是"本引擎没有证据"，不是"通过"——它要么由调用方补数据，要么由对应门禁（DRC/DFM/DFA/FAI）签字覆盖。

## 关键数字速查（最常被违反的 10 条）

| 场景 | 规则 | 数值 |
| --- | --- | --- |
| 元件能不能挨着 | SPACE-02 | courtyard 相交 = P0；XY 间隙 ≥0 且高度包络重叠 = 0，两条同时满足 |
| 模组旁边留多少 | SPACE-08 | 模组 ↔ 其他器件 ≥1.00 mm（推荐 1.50） |
| FFC 插线空间 | CONN-03 | 插口正前方板外 ≥5.0 mm（推荐 8.0）= 翻盖 1.5–2.0 + 手指 3.0 |
| 两个 FFC 能不能并排 | CONN-04 | 同边净距 ≥3.0 mm；开口不得相对（相对则必须 ≥10.0 mm） |
| 连接器朝向 | CONN-10/11/12 | 全板方向 ≤2 类（本板仲裁允许 3 类）；同一边轴线夹角 0°；开口侧板内 ≥5.0 或齐平板边 |
| 天线净空 | RF-01/02 | 天线端伸出板边 2–5 mm；正前方 15 mm 内无金属件；下方各层禁铜 |
| 丝印压焊盘 | SILK-05 | 重叠面积 = 0（0 容忍，压上去会被 CAM 裁掉） |
| 丝印字高 | SILK-01 | 1.0 mm（密集区下限 0.8，同区一致） |
| 去耦电容 | PWR-01 | 电容到电源脚 ≤2.0 mm（模组 ≤1.5、QFN ≤1.0） |
| 拼板三件套 | MECH-10/11/12 | 工艺边 ≥5.0 mm；Mark Ø1.0/开窗 Ø2.0 ≥3 个；定位孔 Ø3.2±0.05 距边 ≥3.0 |

## 现状统计

| 指标 | 数值 |
| --- | --- |
| 规则总数 | 151 条（硬门禁 126 / 推荐 25），12 组 |
| 本板已确认违反 | **49 条**，其中硬门禁 **45 条** |
| 需在 EDA/网表/板厂复核 | 22 条（⚠️ 不等于 ✅，未闭合不得放行） |
| 阻断投产的红线 | 8 条中 7 条已确认未清、1 条待定 |

## 已知限制（请连同结论一起读）

1. **量测口径**：所有间隙来自 3D 渲染图目视量测（≈24 px/mm，±10%），透视会让「相邻」看起来像「接触」。硬结论都写了「需在 EDA 里用 courtyard + 3D 复核确认」。
2. **无网表**：11 颗去耦电容的归属是**推定值**（`03` §6.1），必须用网表复核。
3. **无外网**：本环境无法检索，标注 `JLC` 的板厂能力值（0.09/0.09 mm、环宽 0.13 mm、阻焊桥 0.10 mm、丝印 0.15 mm）均为厂规默认，**下单前以工程确认单为准**。
4. **无 Gerber / 叠层 / 结构图**：凡需这两类文件才能判的（阻抗、阻焊桥、天线区禁铜、外壳叠合）一律标 ⚠️ 待复核。
5. **不替代**板厂 DFM 报告、官方 DRC、首件 FAI。

## 维护

```bash
python3 scripts/build-rule-json.py   # 改了 02/03 后重跑，同步 rules/ 与 runtime/engineering/rules/ 两份 JSON
```

规则编号格式固定为 `前缀-两位序号`（如 `CONN-04`），被 `01`、`04`、图 A 标注、JSON 四处引用，**不得重排**；新增规则只能在组末追加序号。
