# 26. 嘉立创官方能力 + 开源优秀板例：铺线（布线/铺铜）与排版（布局）的学习、复核与真机验证

> **一句话结论：** 嘉立创官网把「线宽线距 / 过孔 / 阻焊 / 丝印 / 板边拼板 / 阻抗 / 铺铜」的**可制造下限**写得很清楚，但下限不是设计目标；优秀开源板例能学的是**排版意图**（接口定边、电源定轴、主控居中、按信号流排模块、敏感区远离）与**铺线策略**（电源宽线、去耦就近、差分等长、铺铜+缝合），而不是照抄线宽数值。把两者合起来复核本板 **DBTS-A01（4 层）**：可制造性全部 PASS、DRC 0 违规，但「优秀设计」层差距明显——`layout-score 45.9/100`、DFM 149 WARN、主功率网仍用 0.254mm 细线、7 条悬空线、10 颗去耦电容远离 IC。**结论是：DRC 通过只证明“做得出来”，不证明“做得好”。**

> **来源与证据边界：** 本文的官方事实来自嘉立创官网（www.jlc.com 工艺能力总表、铺铜/拼板/V 割/邮票孔/层压/阻焊等帮助文档）与嘉立创 EDA 官方 wiki（wiki.lceda.cn，含四层板 Layout 规范、DC-DC/LDO/USB/SD 模块页、铺铜/孤铜/过孔/回流/3W-20H 等知识点），共 **39 个来源、61 条事实**，逐条带快照与 SHA-256（见 `artifacts/evidence/research/jlc-2026-11-02/jlc-official/`）。板例来自嘉立创旗下**立创开源硬件平台**（oshwhub.com）3 个工程，属 **C 级**（社区工程，非厂商规范），图片结论来自视觉模型对已下载原图的逐图分析，且已标注证据强度；**三例都没有层数/叠层/拼板标注，也没有可测的线宽/阻抗数值**。本板验证数据来自 EasyEDA 当前打开工程的**只读**快照（`artifacts/evidence/jlc-verify-2026-11-02/`），未改板。**B 级工艺数值随产线/工厂/油墨变化，投板前必须按当日能力表与工程确认单（EQ）复核；本文所有数值引用均标注抓取日期 2026-11-02。**

> **复核期限：** 2027-05-01（B 级来源 180 天重抓；官网能力页若改版需重新核对）。

---

## 0. 本文回答什么

1. 嘉立创官方公开的**可制造边界**里，哪些直接约束「铺线」和「排版」？（第 1 节）
2. 嘉立创 EDA 官方文档怎么教「布局/走线/四层板/模块/铺铜」？（第 2 节）
3. 立创开源硬件平台上的优秀板，**排版与铺线的意图**是什么、能学到什么、不能照抄什么？（第 3 节）
4. 把这些边界套到项目真实板 **DBTS-A01** 上，哪些过、哪些差、先改什么？（第 4 节）
5. 投板前可执行的**检查清单与复跑命令**。（第 5 节）

方法：官网/文档用 `runtime/research.mjs` 的 `fetchPage()` + 页面 `lean.js` 正文提取（wiki 为 VitePress SPA，正文不在 HTML 里）；板例用页面正文 + 正文图下载 + `read-image` 视觉分析；本板用 `easyeda` CLI 只读命令 + dump 解析。全部证据落盘可复核。

---

## 1. 嘉立创官方制造能力：铺线/排版的硬边界

> 官方能力页：<https://www.jlc.com/portal/vtechnology.html>（抓取 2026-11-02，快照 10,863 字符纯文本；`SRC-JLC-CAP-CN`）。以下数值均可在快照 `jlc-capability.txt` 中按原文复核。

### KP-PCB-370 线宽/线距按成品铜厚分档：贴极限是风险，不是水平

| 项目 | 官方能力（1oz 成品铜厚） | 说明 |
|---|---|---|
| 最小线宽/线距（单/双面板） | **0.10/0.10mm（4/4mil）** | 常规 FR4 |
| 最小线宽/线距（多层板） | **0.09/0.09mm（3.5/3.5mil）** | BGA 处局部可做 3mil |
| 1.5oz 多层（6 层） | 0.13/0.13mm（5/5mil） | |
| 2oz | 双面 0.16/0.16mm；多层 0.15/0.15mm | |
| 2.5/3.5/4.5/5/6oz | 0.20 / 0.25 / 0.30 / 0.35 / 0.45mm | 铜越厚，最小线宽越大 |
| 线宽公差 | **±20%**（0.1mm 成品允许 0.08–0.12mm） | 极限线宽要按公差下限核算 |
| 焊盘边到线边 | ≥0.10mm（BGA ≥0.09mm） | |
| HDI | 3/3mil（极限 2.7/2.7mil） | 4–32 层一至三阶 |

**判据：** 设计中的“最小线宽/线距”不是取能力表最小值，而是**先满足载流/压降/阻抗，再留工艺余量**：常规信号 ≥0.15–0.2mm（6–8mil）更稳；只有 BGA 逃逸、高密度连接器扇出等局部才用 3.5–4mil，并且那段要短、要能过 DFM。**为什么：** 线宽公差 ±20%，0.09mm 的线实际可能只有 0.072mm；蚀刻、铜厚、板厂产线差异都会吃掉余量，贴极限的板在换厂/换批次时最容易出问题。**怎么做：** 按“网络类别→电流→线宽”建 net-class（信号/电源支路/电源主干/大电流/地），线宽阶梯来自载流预算，不来自能力表最小值；投板前用板厂 DFM 复核 widthUnderSpec。**怎么查：** `easyeda pcb net-classes` 看阶梯；`pcb lines` 统计实际线宽分布；`pcb check` 看 widthUnderSpec / widthMismatch。

### KP-PCB-371 过孔四件事：孔径、孔环、孔边到孔边、盘中孔工艺

| 项目 | 官方能力（多层板） | 说明 |
|---|---|---|
| 最小过孔（内径/外径） | **0.15mm / 0.25mm** | 单双面同最小值；外径必须比内径大 ≥0.1mm，推荐 ≥0.15mm |
| 推荐最小孔 | **内径 ≥0.2mm** | 0.15mm 属非常规、费用高 |
| 孔环（焊环） | 多层板建议 ≥0.20mm，极限 0.15mm；双面建议 ≥0.25mm，极限 0.18mm | 有铜插件孔 |
| 孔边到孔边 | **≥0.2mm**（过孔）；插件孔 ≥0.45mm | 孔太密会钻孔破孔/CAF 风险 |
| 钻孔范围 | 多层 0.15–6.3mm；2–12 层 FR4 可 0.1mm 微孔（板厚 ≤1mm、沉金/OSP） | |
| 过孔塞油墨 | 0.15–0.5mm；双面盖油才能塞；单面开窗且 <0.4mm 只能半塞 | 半塞可能透光 |
| 盘中孔（树脂/铜浆+电镀盖帽） | 0.15–0.55mm，盖帽铜厚 ≥10um；6 层及以上默认树脂塞孔盖帽 | 需在下单时声明，否则按普通过孔开窗 |
| 过孔盖油 vs 开窗 | 盖油=阻焊盖住；开窗=露铜可焊 | 散热焊盘过孔通常盖油/塞孔，信号盘中孔必须塞孔 |

**判据：** 过孔不是“能打就行”：①孔径/外径满足能力；②孔环 ≥0.15–0.2mm；③孔边到孔边 ≥0.2mm；④明确“盖油/塞油/盘中孔”工艺。**为什么：** 盘中孔若未声明塞孔，回流焊会漏锡/虚焊；孔环不足会破环；孔太密在钻孔/沉铜时易破孔或 CAF。**怎么做：** 统一过孔库（推荐 0.3/0.6mm 或 0.2/0.45mm）；BGA/QFN 散热焊盘用多孔+盖油；信号盘中孔集中列出并声明树脂塞孔+盖帽；焊盘环按板厂建议值设计。**怎么查：** `pcb vias` 统计孔径/盘径/孔环；`pcb check` 看 viaInPad / overlapVia / plugClearance；下单备注盘中孔工艺。

### KP-PCB-372 阻焊、丝印、板边与拼板：投板前一次性收口

| 项目 | 官方能力 | 说明 |
|---|---|---|
| 阻焊桥（1oz） | 焊盘间距 **≥0.10mm**（绿/红/黄/蓝/紫）；**≥0.13mm**（黑/白） | 2oz ≥0.20mm |
| 阻焊开窗 | 2025-06 起 LDI，焊盘与开窗 **1:1**；客户可按单边 ≥0.02mm 设计；焊盘边距线边 ≥0.09mm | 开窗补偿过大挤掉阻焊桥 |
| 阻焊厚度 | ≥10um | |
| 字符高度/粗细 | **≥1mm / ≥0.1mm**；字符到露铜焊盘 **≥0.15mm** | 低于 0.15mm 会被掏空字符 |
| 锣边 | 走线/焊盘距板边 **≥0.2mm**；距锣槽 ≥0.2mm | 外形公差 ±0.2mm（普锣）/±0.1mm（精锣） |
| V 割 | V 割处走线/焊盘距板边 **≥0.4mm** | V 割拼板尺寸 70–475mm |
| 邮票孔 | 非孔位走线/焊盘距板边 ≥0.2mm；孔 0.6mm、每组 5–8 个、孔边间隙 0.35–0.4mm | 拼板间隙 1.6/2mm（最小 1.2mm） |
| 工艺边 | 常规 **3mm**（SMT 建议 5mm）；光点 1mm、定位孔 2mm、光点中心到板边 3.85mm | |

**判据：** 阻焊桥、字符、板边距离是**投板前一次性核对**的项，改板阶段最便宜、投板后最贵；拼板方式（V 割/邮票孔/半孔）要在下单时定，并保证工艺边/光点/定位孔。**为什么：** 阻焊桥不够会连锡；字符 <1mm 印不清；走线距板边 <0.2mm 锣边会露铜/毛刺；V 割处 <0.4mm 会切到铜。**怎么做：** 下单前跑 DFM 检查；阻焊开窗补偿按 1:1 或 ≤0.02mm/边（不要用 0.05mm 把桥挤没）；丝印字号 ≥1mm、位号统一方向、避开焊盘；板边器件/走线留 0.2–0.4mm。**怎么查：** `pcb check` 看 silkOverPad / silkFlipped / copperNearEdge / edge 相关告警；`pcb silk-list` 查字号；拼板图核对 V 割线与工艺边。

### KP-PCB-373 阻抗与叠层：先选板厂现成层压，再谈 ±10%

| 项目 | 官方能力 | 说明 |
|---|---|---|
| 阻抗管控 | **免费档只控线宽/线隙 ±20%**；**收费精密阻抗测试**管控阻抗值 **±10%** | 有阻抗要求建议 4 层及以上 |
| 层压结构 | 4/6/8/10/12/14/16/18/20 层（最高 64 层） | 支持自定义结构，需工程核算 |
| 板厚公差 | ≥1.0mm：±10%；<1.0mm：±0.1mm | |
| 铜厚 | 外层 1oz（双面 1–6oz 可选）；内层 0.5/1/2oz | 内层 0.5oz 载流能力差，要按铜皮宽度核算 |
| 阻抗线设计 | 按叠层计算线宽/线距；共面阻抗要保证参考平面完整 | 阻抗文件（阻抗值/线宽/层/参考层/位置）随单提供 |

**判据：** 有 USB/以太网/DDR/PCIe 等阻抗要求时，**先定叠层再布线**，阻抗目标由协议/芯片厂商规定；需要 ±10% 就选收费精密阻抗，并在下单文件里给阻抗管控表。**为什么：** 板厂默认只保证线宽线隙±20%，不保证阻抗值；叠层不同、介质厚度不同，同一线宽的阻抗差很多。**怎么做：** 用板厂层压结构/阻抗计算器出线宽；把阻抗层、参考层、目标值写进叠层表；单端/差分分别列；换层处加回流地过孔。**怎么查：** 叠层表与阻抗表是否随单；`pcb stackup-show` 查层结构（本板字段缺失，见 4.4）。

### KP-PCB-374 铺铜五问：平面/回流/孤铜尖角/对称平衡/热焊盘

官方铺铜指引（`SRC-JLC-GUIDE-COPPER-POUR`，<https://www.jlc.com/portal/server_guide_38573.html>）与 EDA wiki（`SRC-LCEDA-WIKI-POUR`）要点：

| 要点 | 做法/判据 | 为什么 |
|---|---|---|
| 热焊盘 | 大铜面上的焊盘用**十字热焊盘**（thermal relief） | 铜导热快，直接全连接会吸走烙铁/回流热，难焊 |
| 实心 vs 网格 | 低频/大电流用**实心铺铜**；高频屏蔽可网格；优先实心（干膜工艺） | 网格载流差、可能形成电长度谐振；实心载流/屏蔽更好 |
| 孤铜 | **保留孤岛=否**，孤铜必须删 | 孤铜=天线，拾取/辐射噪声 |
| 高速线距铺铜 | 高速信号线离铺铜边缘 **≥0.5mm** | 减小寄生电容/阻抗突变 |
| 残铜率 | 内层空旷区尽量覆铜，保持残铜率均匀 | 残铜率过低→压合缺胶、板薄、起皱、分层 |
| 对称层铜覆盖 | 对称层铜覆盖率尽量接近（比值不低于 ~0.8） | 抑制翘曲（bow/twist） |
| 尖角铜 | 铺铜尖角/细长铜箔要**倒角/清除** | 尖端放电、电场集中、阻抗不连续、毫米级尖铜可谐振在 WiFi 频段 |
| 过孔缝合 | 顶层 GND 铺铜每隔 ≤λ/20 打缝合孔到底层 GND；板边地过孔成排 | 否则大片铜皮自身会成谐振天线；板边地孔抑制 EMI |
| 天线/RF 区 | 设禁布/净空，不铺铜 | 铺铜会改变天线阻抗、降低灵敏度 |
| 两层板 | 顶层铺铜只有在密集缝合时才有益；优先底层完整 GND | 顶层铺铜被走线切碎会变“瑞士奶酪”，反而恶化回流 |

**判据：** 铺铜要回答四个问题：**给谁做平面？回流路径连不连续？有没有孤铜/尖角？对称层平衡吗？** **为什么：** 完整平面决定阻抗与回流；孤铜/尖角是天线与阻抗不连续点；铜分布不均会翘曲。**怎么做：** 先铺 GND 平面→检查孤岛→热焊盘→高速线距 0.5mm→缝合孔→对称层平衡→尖角倒角。**怎么查：** `pcb check` 看 floatingIsland / netlessPour / powerNotPoured / copperNearEdge；`pcb pour-list` 看铺铜网络与范围；DFM 报告残铜率（板厂侧）。

---

## 2. 嘉立创 EDA 官方布局/走线指引（wiki）

> 来源：<https://wiki.lceda.cn/zh-hans/design-production/pcb-design/layout-guidance.html>、`routing-guidance.html`、`four-layer-board-layout.html`、`moduler-design/*`、`knowledge-point/*`。**注意：layout/routing 两页是图片教程（六步走/常见错误），正文文字很少，本文只把它们登记为来源，不把图里的内容当文字证据引用。**

### KP-PCB-375 四层板：完整 GND 平面优先，内层 0.5oz 要算载流

官方《四层板 PCB Layout 设计规范指导》（`SRC-LCEDA-WIKI-4LAYER`）给的两种常用叠层：

| 叠层 | 优点 | 缺点/适用 |
|---|---|---|
| 信号–**GND**–**PWR**–信号（或镜像） | 完整地平面、回流路径最短、EMC 好、阻抗易控 | 顶层元件多时高速信号难布 |
| 信号–PWR–GND–信号 | 电源/地平面都在内层 | 电源平面不完整，适合电源不复杂但板很密 |

要点：①核心器件在底层时翻转叠层，保证**高速信号贴近 GND**；②内层铜厚通常 **0.5oz**、散热不如外层，电源/地放内层时**必须按电流算铜皮宽度**；③共面阻抗要保证参考平面完整，并每隔 **150–300mil** 打 GND 过孔（<λ/20~λ/10）；④顶层走阻抗线也可以铺铜，铺铜到阻抗线距离取 **3 倍线宽**；⑤投板随附**阻抗管控文件**（阻抗值/线宽/层/参考层/位置图），叠层/钻孔表放进 PCB。

### KP-PCB-376 模块级铺线：DC-DC 环路、LDO 电容、USB 90Ω、SD 50Ω

官方模块页（`SRC-LCEDA-WIKI-MOD-DCDC` / `-MOD-LDO` / `-MOD-USB` / `-MOD-SD`）是可执行的检查项：

**DC-DC：** 旁路/去耦电容靠近输入/输出端；**电感与续流二极管紧贴 PH 开关节点**，缩小电流环路；布局横平竖直、避免拉长电源路径；发热器件远离热敏器件；输入/输出按最大电流算线宽，大电流可用铺铜；GND 焊盘铺铜/全连接，底层铺铜（避开电感区）并在 GND 焊盘打孔；**反馈线不穿电感/二极管/大电容/散热焊盘下方、不被大电流环包围**，按 10–15mil 常规线宽；热焊盘多过孔散热；**电感下方不走线**。

**LDO：** 按输入/输出路径一字型或 L 型摆放；电容**先大后小**靠近输入/输出引脚；两侧电容数量一致、GND 引脚同向；电源输入/输出可全填充或粗线；走线直、拐弯走钝角/圆弧；输入先过电容再到芯片；双/多层板在 GND 焊盘附近整齐打孔；加丝印防接错。

**USB：** 接口靠板边/按结构定位；端接电阻/ESD/共模电感靠近接口；远离 RF/摄像头等 EMI 源；差分 **90Ω** 并包地（包地线距差分 >20mil、每隔一段回流地过孔、总长建议 ≤1800mil）；组内等长 **±5mil**；少换层，必须换层时加一对回流地过孔、过孔 ≤2 个；端接电阻距主控引脚 <200mil；差分距板边/铺地边缘 ≥90mil，距电源/大电流/DDR/HDMI ≥50mil。

**SD 卡：** 靠板边、靠主控；电源脚就近滤波（先大后小）；上拉电阻靠近 SD 卡；信号加 ESD、不打孔换层；单端 **50Ω**；同组同层、参考平面完整不跨分割；**时钟 3W 处理**、尽量包地；以时钟为目标做等长，误差 **≤300mil**。

### KP-PCB-377 过孔效应、回流路径、参考平面与 3W/20H

- **过孔效应**（`SRC-LCEDA-WIKI-VIA-EFFECT`）：单孔把 50Ω 线压到约 44Ω（反射系数 ≈0.06，单孔可忽略；3–5GHz 以上输入阻抗发散）；0.3mm 孔寄生电容约 0.3–0.8pF；0.5pF 可使 10Gbps 眼图张度降 10–15%；残桩 stub 在 FR-4 下约 **1.65mm 谐振 ~5GHz**，TI 建议 stub ≤15mil（0.38mm），超长用背钻。
- **回流路径**（`SRC-LCEDA-WIKI-RETURN-PATH`）：高频回流走“最低阻抗”即信号线正下方；平面裂缝/分割会让回流绕行、放大环路与 EMI；参考平面必须连续，跨分割处要桥接/换层回流孔。
- **3W/20H**（`SRC-LCEDA-WIKI-SPACING` / `SRC-LCEDA-WIKI-3W20H`）：3W=线间距 ≥3 倍线宽（抑制串扰）；20H=电源层相对地层内缩 20H 可限制约 70% 电场在接地层边沿内（100H≈98%），工程取 1mm 或 ≥20mil、优先 40mil，前提是 GND 平面仍完整。

---

## 3. 优秀开源板例拆解（立创开源硬件平台，C 级）

> 证据：`artifacts/evidence/research/jlc-2026-11-02/oshwhub-cases/`（3 个工程 + 34 张图 + 逐图视觉分析）。**C 级说明：** 社区工程页不是厂商设计规范；页面不标层数/叠层，也没有拼板图；视觉模型只能定性，线宽/阻抗/等长数值**不可测**。以下“手法”均为**候选经验（candidateLessons）**，进设计前需按第 1、2 节官方边界复核。

### 3.1 样本与证据强度

| 工程 | 定位 | 版面证据 | 可学什么 |
|---|---|---|---|
| 立创·实战派 ESP32-S31 开发板（`SRC-OSHWHUB-S31`，<https://oshwhub.com/li-chuang-kai-fa-ban/project_wxwsirbz>） | 无线+音频+视觉开发板，PMU 六路电源域 | 1 张 2 分屏 Layout（顶层/底层，已裁剪放大）；其余 4 张是带壳成品照 | 接口分区、电源区夹在入口与主控之间、去耦环绕、USB/SDIO 走线、GND 铺铜缝合 |
| MicroScope Power 便携电源/微电流分析仪（`SRC-OSHWHUB-MICROSCOPE`，<https://oshwhub.com/txp666/project_iupheygc>） | 电源+精密模拟仪器（RP2040） | 1 张裸板实拍 + 3 张原理图/系统框图；**无 Layout 图** | 功率路径一字排开、输入/输出分置两端、采样电阻串联不旁路、Kelvin、ADC 就近 RC、独立基准 |
| Mini RV1126B AI BOX（`SRC-OSHWHUB-AIBOX`，<https://oshwhub.com/guapi-exe/project_gzqvuteg>） | 6 层边缘 AI 盒子 | 3 张裸板实拍；无 Layout/叠层 | **定位为反例/边界**：接口沿边同向、SoC 居中+屏蔽、RF 收板角；自述 USB3.0 工作不正常、6 层免费档取舍 |

> 取材陷阱：原候选 **LockDrive 智能锁** 的 10 张正文图逐图核验全是产品渲染/CAD 剖视/代码/电商订单截图，**没有任何 PCB 版面图**，已淘汰并保留记录（`oshwhub-cases/lockdrive/`）。这提醒：开源工程“有图”不等于“有版面证据”。

### KP-PCB-378 排版手法（候选）：接口定边、电源定轴、主控居中、信号流

**判据/做法（候选）：**
1. **接口定边**：先按人机/装配方向把连接器钉在板边，再排内部；S31 四边分区（CAMERA 左、LCD 中上、USB+SD 右、SPK/BAT 底），AI BOX 全部 I/O/FPC 沿边同向外引。
2. **电源定轴**：双供电入口（USB/BAT）相邻并靠近电源转换区，电源区夹在入口与主控之间，按电流流向布置；MicroScope 把“输入 Type-C—LDO—采样电阻—输出”沿一条轴排开，输入/输出各占板子一端。
3. **主控居中、去耦环绕**：S31 主控居中，去耦电容正面四边环绕 + 背面正下方再密排，晶振紧靠主控；AI BOX 主控边缘成排 MLCC（照片级）。
4. **精密模拟成链**：MicroScope 按信号流 INA296A3→TMUX1119→OPA320→RC→ADS8866 一列摆放，独立基准 REF3025 就近 ADC。
5. **高密度盒子**：SoC 居中+屏蔽罩/散热盖，RF 模块收板角+IPEX 外置天线，大件网口/电解电容靠板边。

**为什么：** 接口和电源路径一旦定死，布线只能绕着它们走；先定“不能动的”（接口、电源入口、主控、RF），再定“可以调的”，返工最少。**怎么做：** 布局前先画“接口朝向 + 电源树 + 信号流”三张草图；按“入口→转换→负载”排电源轴；去耦贴着电源脚摆；模拟链按信号流一列排。**怎么查：** 连接器是否都朝板边/可插拔；电源入口到转换器的路径是否最短；去耦到 IC 电源脚的距离（目标 ≤2mm）；敏感区与噪声源是否拉开。

### KP-PCB-379 铺线手法（候选）：电源宽线、差分等长、铺铜缝合、Kelvin

**判据/做法（候选）：**
1. **电源宽线由载流/压降预算决定**：S31 的 BAT/USB 入口明显宽线；MicroScope 更强调“采样电阻始终串联、不旁路”（双量程靠切换放大器，不靠切电阻）。
2. **差分平行等距 + 45°/圆弧拐角**：S31 的 USB D+/D- 平行等距出线，全板 45°/圆弧拐角；但“平行”≠“阻抗受控”，阻抗仍要靠叠层计算。
3. **SDIO/存储蛇形等长**：S31 正文明确 SDIO 3.0 对**布线长度、阻抗、参考平面完整性**有要求；图里可见 MicroSD↔主控蛇形等长。
4. **GND 铺铜 + 过孔缝合**：S31 整板 GND 铺铜、接插件/去耦/主控地焊盘周边密布缝合孔；缝合间距应按最高频率（≤λ/20）而不是“看起来密”。
5. **高增益采样/ADC 前端**：每颗采样电阻单独引一对差分线到电流检测放大器（Kelvin，从焊盘内缘取）；ADC 输入就近 RC（33Ω/1nF）+ 独立 2.5V 基准。

**为什么：** 电源路径的宽度/回流决定压降与发热；差分/等长/参考平面决定信号质量；Kelvin 与就近 RC 决定测量精度。**怎么做：** 先按电流算电源线宽→差分/等长按协议→铺铜/缝合→敏感模拟按“远离+分源”。**怎么查：** 电源网络线宽是否覆盖全路径（含过孔数量）；差分是否等长/包地/少换层；铺铜是否有孤岛/尖角；采样是否 Kelvin。

### KP-PCB-380 「优秀 ≠ 可照抄」的边界与证据分级

| 边界 | 说明 |
|---|---|
| 层数/叠层未标注 | 三例都没有层数/叠层标注；AI BOX 正文自述 6 层。**层数不同，“地”的实现方式就不同**（2/4 层靠铺铜/完整平面，6 层靠内层平面+缝合）。 |
| 成本/工艺档位不同 | AI BOX 用 6 层免费档 + 大量 0201，手工复刻/返修难；MicroScope 明确“省略供电与部分前端 RC”，照抄会缺滤波。 |
| 设计成熟度不同 | S31 自述 V0.3 有飞线、V0.4 未验证；AI BOX 自述 USB3.0 不正常、“仅限能用”。它们适合学**布局意图与取舍**，不适合当**布线正确性背书**。 |
| 视觉模型有过度解读 | MicroScope“电源宽线”在整图与裁剪图判断矛盾（已标不可引用）；OCR 会混淆型号（S31 丝印 `ESP32-S3`/`WLKFB`，AI BOX 网口两版本）。**型号/参数一律以正文为准。** |
| 拼板无证据 | 三例都没有拼板图；拼板结论只能来自板厂规则（第 1.3 节）。 |

---

## 4. 本板真机验证：DBTS-A01 双电池无缝切换测试板（只读）

> 证据：`artifacts/evidence/jlc-verify-2026-11-02/`（`raw/` 26 条命令 + `parsed-board.json` + `verification.md` + `dbts-a01-dump.json`）。快照 capturedAt = 2026-11-02T12:02:31Z；**未改板、未改规则、未铺铜**；CLI v1.3.0 vs connector v1.14.0 以 `--skip-version-check` 放行（审计已写）。

### 4.1 快照读数

| 项目 | 读数 | 出处 |
|---|---|---|
| 板框 | 折线 28 点、四角 45° 倒角；坐标 5128×3475（mil），**约 130.5×88.5mm**（不同量法 130.25×88.27~130.5×88.5mm） | `raw/outline-get.json` |
| 铜层 | **4 层**（Top/Bottom/Inner1/Inner2 均 SIGNAL；GND 铺铜在 Inner1、+3V3 在 Inner2） | `raw/layers.json` / `raw/stackup-show.json` |
| 器件/焊盘/网络 | **99 器件 / 339 焊盘（顶层 288 + THT 51）/ 74 网络** | `raw/list.json` / `raw/nets.json` |
| 走线 | **1267 条**；最窄 **10mil=0.254mm**（1226/1267 条）；其余 12/20/30/40mil 共 41 条 | `raw/lines.json`（只读 action） |
| 过孔 | **207 个**，全部 12mil 孔/24mil 盘（0.3048/0.6096mm），单边孔环 **0.1524mm**，孔边到孔边最小 **0.4905mm** | `raw/vias.json` |
| 铺铜 | 12 块（GND-Inner1、+3V3-Inner2 + Top 10 块电源/开关网整板铺铜） | `raw/pour-list.json` |
| DRC | **passed = true，0 违规**（clearance 5.98mil、铜到边 10mil） | `raw/drc.json` / `raw/drc-rules.json` |
| DFM check | **152 条：ERROR 0 / WARN 149 / INFO 3** | `raw/check.txt` |
| 布局评分 | **45.9/100（poor）**；可布性 lint **0/100（193 处飞线交叉）** | `raw/layout-score.txt` / `raw/layout-lint.txt` |

### KP-PCB-381 本板验证：DRC 0 违规 ≠ 优秀设计（22 项检查）

| # | 检查项 | 官方能力/基线 | 本板实测 | 结论 |
|---|---|---|---|---|
| 1 | 最小线宽 | 多层 0.09mm | 0.254mm（10mil） | **PASS** |
| 2 | 最小线距 | 多层 0.09mm | DRC 规则 5.98mil（0.152mm），0 违规 | **PASS** |
| 3 | 过孔内/外径 | 0.15/0.25mm | 0.3048/0.6096mm | **PASS** |
| 4 | 孔环 | 多层建议 ≥0.20mm、极限 0.15mm | 0.1524mm（接近极限） | **REVIEW** |
| 5 | 孔边到孔边 | ≥0.2mm | 0.4905mm | **PASS** |
| 6 | 铜到板边 | 锣边 ≥0.2mm | 规则 10mil（0.254mm），0 违规 | **PASS** |
| 7 | 4 层可制造 | 支持 4–64 层 | 4 层 | **PASS** |
| 8 | 电源载流线宽 | 按 net-class：power-trunk 0.4 / high-current 0.5 / gnd 0.5mm | **+5V 27/27、VDC 80/80、CHG_VIN 31/31、EXT_48V 47/56、INT_24V 44/51 条为 10mil** | **FAIL** |
| 9 | 铺铜完整性 | 无无网络铜/死铜/未铺电源 | 12 块铺铜；`floatingIsland=0`、`netlessPour=0`；**+5V 5 pads 未铺铜（powerNotPoured=1）** | **FAIL**（部分） |
| 10 | 悬空线 | 无 dangling | **7 条 dangling-end**（GND×2、CHG_VIN×3、FB_CHG、INT_24V，坐标见 raw） | **FAIL** |
| 11 | 3W 平行耦合 | 线间距 ≥3W（本板 ~30mil） | **43 对 <30mil**（最小 17.6mil EN_EXT↔FLT1） | **FAIL** |
| 12 | 去耦就近 | 去耦 ≤2mm 到 IC 电源脚 | **10 颗 >2mm**（C17 28.9、C36 13.7、C25 10.3mm 最差） | **FAIL** |
| 13 | 盘中孔工艺 | 盘中孔需声明树脂塞孔+盖帽（0.15–0.55mm） | 22 处 via-in-pad：15 个 GND 热盘（可接受）+ **7 个信号/电源盘中孔未声明** | **FAIL/REVIEW** |
| 14 | 板边器件/端口朝向 | 接口靠板边、可插拔 | J7 距边 767mil、J12 1436mil；CN3↔J7 9.72mm<19.20、J12↔J8 4.51<6.07mm 包络干涉 | **FAIL** |
| 15 | 丝印可读 | 字高 ≥1mm、不压焊盘 | 3 条 36mil=0.914mm；J8 压 R26.1；J7/J8 侧向 270° | **FAIL** |
| 16 | 阻焊桥 | 1oz ≥0.10mm | 开窗补偿 0.0508mm/边 + 铜间距 0.152mm → 最坏桥宽 **0.0504mm** | **REVIEW** |
| 17 | Mark 点 | 量产/细间距建议 ≥3 个非共线 Mark | 0 个（INFO） | **REVIEW** |
| 18 | 锐角走线 | 内部夹角 <90° 才是酸角 | 30 条被标 acute，但偏折角 10–69°、内部夹角 111–170°，**真锐角=0** | **REVIEW**（工具口径待校准） |
| 19 | 走线一致性 | 0/45/90°、无重复段 | nonOrtho=19、dupSegment=4、widthMismatch=2 | **REVIEW** |
| 20 | 功能分区越界 | 器件在声明分区内 | zoneViolation=6（C33/L2/Q5/U10/CN3/D1） | **REVIEW** |
| 21 | 叠层/板材参数 | 4 层、板厚/铜厚/介质可追溯 | 内层声明 SIGNAL（非 PLANE）；**板厚/铜厚/介质字段缺失** | **REVIEW**（N/A 数据） |
| 22 | 全板最小铜间距/孔到铜/阻焊桥实际值/字符到焊盘间隙/钻孔表 | 需 DFM/EQ 提供 | 工具未提供 | **N/A**（字段缺失） |

> 口径说明：`pcb check` 的 `acute-angle` 把方向偏折 45°（内部夹角 135°）也标成 acute，与工程定义（内部 <90°）不一致，故按 **REVIEW** 处理，真锐角实测 0 条；`layout-score` 分区/流向维度为启发式（无 S0 spec、无 RF、无手焊剖面），未测维度已标注。

### 4.3 差距与整改优先级

**P0（投板/试产前必须修）**
1. **修复 7 条悬空线**：GND @(2865,2350)(3532,1803)；CHG_VIN @(3222,2245)(3166,2189)(2936,2136)；FB_CHG @(3041,2473)；INT_24V @(2098,2727)。续接或删除，否则开路/浮铜蚀刻残留。
2. **主功率网加宽/改铺铜**：EXT_48V（47/56 条）、INT_24V（44/51）、VDC（80/80）、CHG_VIN（31/31）、+5V（27/27）仍为 10mil；按 net-class 升到 power-trunk 0.4 / high-current 0.5 / gnd 0.5mm，+5V 补铺铜。

**P1**
- 7 处信号/电源盘中孔（U8.14/U7.4/U7.2/+3V3、U5.3/VCCD4、L1.2/+5V、U3.8/EN_EXT_A、U4.16/INT_MID）下单声明树脂塞孔+盖帽，或改 dog-bone。
- 10 颗去耦电容就近到对应 IC 电源脚（≤2mm）。
- 端口/插头排版：J7/J12 移到板边，补插头包络表，消除 CN3↔J7、J12↔J8 干涉。
- 丝印：3 条字号升到 ≥1mm；J8 位号避开 R26.1；J7/J8 方向统一。

**P2**
- 3W 耦合 43 对拉开到 ≥3W 或加地线隔离；+5V 铺铜；SW_NODE 顶层整板铺铜评估（开关节点铺铜可能增大辐射/容性耦合，建议缩到热回路或移内层）。
- 布线一致性：nonOrtho 19 整理为 0/45/90°，dupSegment 4、widthMismatch 2 清理。
- 加 Mark 点（≥3 个非共线 1mm）；阻焊开窗补偿降到 ≤0.02mm/边或请板厂按 LDI 1:1 复核桥宽；叠层改为 PLANE 层并补板厚/铜厚/介质参数。

### 4.4 可复用验证命令（只读）

```bash
# 工程/板身份
~/.local/bin/easyeda project info --skip-version-check
~/.local/bin/easyeda doc ls --skip-version-check
~/.local/bin/easyeda pcb board-info --skip-version-check
# 结构/规则/统计
~/.local/bin/easyeda pcb layers --skip-version-check
~/.local/bin/easyeda pcb stackup-show --skip-version-check
~/.local/bin/easyeda pcb nets --skip-version-check
~/.local/bin/easyeda pcb net-classes --skip-version-check
~/.local/bin/easyeda pcb drc-rules --skip-version-check
~/.local/bin/easyeda pcb drc --skip-version-check
~/.local/bin/easyeda pcb check --skip-version-check        # DFM 审计（152 条）
~/.local/bin/easyeda pcb layout-score --skip-version-check # 45.9/100
~/.local/bin/easyeda pcb layout-lint --skip-version-check
~/.local/bin/easyeda pcb pour-list --skip-version-check
~/.local/bin/easyeda pcb outline-get --skip-version-check
~/.local/bin/easyeda pcb dump --out artifacts/evidence/jlc-verify-2026-11-02/dbts-a01-dump.json --skip-version-check
# 走线/过孔明细（mutates:false 的只读 action）
~/.local/bin/easyeda call pcb.line.list --skip-version-check
~/.local/bin/easyeda call pcb.via.list --skip-version-check
```

> 复跑注意：`pcb check` 的 acute-angle 口径需人工甄别；`layout-score` 无 spec 时只作趋势；`pcb dump` 的 routedLines 是计数不含几何，线宽/过孔必须用 `pcb.line.list`/`pcb.via.list` 拿明细。

---

## 5. 投板前「铺线/排版」检查清单（SOP）

### KP-PCB-382 投板前铺线/排版门禁清单

**A. 工艺边界（对照第 1 节，下单前当日能力表复核）**
- [ ] 最小线宽/线距按铜厚档核对；贴极限的线只出现在 BGA/连接器扇出，且长度短。
- [ ] 过孔内/外径、孔环（多层 ≥0.15–0.2mm）、孔边到孔边 ≥0.2mm。
- [ ] 盘中孔/散热孔已声明塞孔工艺（树脂/铜油+盖帽）或改 dog-bone。
- [ ] 阻焊桥 ≥0.10mm（黑白 0.13）；开窗补偿 ≤0.02mm/边；字符 ≥1mm/≥0.1mm/离焊盘 ≥0.15mm。
- [ ] 走线/焊盘距锣边 ≥0.2mm、V 割 ≥0.4mm；拼板方式/工艺边/光点/定位孔已确认。

**B. 排版**
- [ ] 连接器全部可用：朝板边、留插头/护套包络、无相互干涉。
- [ ] 电源轴：入口→转换→负载最短；大电流路径宽线/铺铜；输入输出电容先大后小、就近。
- [ ] 主控居中、去耦 ≤2mm（含背面去耦配就近地孔）；晶振紧靠 MCU。
- [ ] 敏感区（模拟/ADC/基准/RF/晶振）与噪声源（DC-DC/开关/射频/大电流）拉开；模拟链按信号流成链。
- [ ] 热：发热器件远离热敏件；热焊盘多过孔；电感下方不走线。

**C. 铺线/铺铜**
- [ ] 差分：90/100Ω 按叠层算，等长/包地/少换层/换层回流孔。
- [ ] 电源网络线宽覆盖全路径（含过孔数量）；反馈线不穿电感/散热焊盘、不被大电流环包围。
- [ ] GND 平面完整、无孤铜/死铜；高速线距铺铜 ≥0.5mm；热焊盘用十字；对称层铜平衡。
- [ ] 板边/接口/晶振/RF 缝合孔成排；缝合间距按最高频率 ≤λ/20。
- [ ] 两层板：优先底层完整 GND；顶层铺铜仅在密集缝合时保留。

**D. 验证门禁**
- [ ] DRC 0 违规；DFM check 无 ERROR；widthUnderSpec/powerNotPoured/dangling 清零。
- [ ] layout-score / layout-lint 作为趋势项，不替代人工评审。
- [ ] 阻抗管控文件、叠层表、钻孔表随单；Mark 点 ≥3 个。
- [ ] 生成 Gerber/BOM/CPL 后跑 `verify-research`/投板门禁脚本，截图归档。

---

## 6. 与现有知识的关系

- 载流线宽、叠层阻抗、DFM 的老规则见 [01](01-design-rules.md)、[02](02-stackup-impedance.md)、[03](03-placement-routing.md)、[06](06-dfm-manufacturing.md)；本文补的是「板厂能力边界 + 官方文档口径 + 板例意图 + 本板实测」四层证据。
- 预布线/电源优先流程见 [24](24-prerouting-and-power-first.md)；本文第 5 节是投板前的收口清单。
- 研究型知识库的写法/来源纪律见 [README](../README.md) 与 [20](20-researched-layout-constraints.md)；本文新增来源全部登记在 `sources.json`（B/C 级），未核实的数值已在正文标注。

## 7. 关联知识条目

- `PCB-RULE-JLC-TRACE-001`：板厂线宽/线距能力分档与设计余量
- `PCB-RULE-JLC-VIA-001`：过孔孔径/孔环/孔边/盘中孔工艺
- `PCB-RULE-JLC-MASK-001`：阻焊桥/开窗/丝印可制造性
- `PCB-RULE-JLC-EDGE-001`：锣边/V 割/邮票孔/工艺边
- `PCB-RULE-JLC-IMP-001`：阻抗管控与层压选择
- `PCB-RULE-POUR-001`：铺铜（热焊盘/孤铜/高速距离/残铜率/缝合）
- `PCB-RULE-4L-STACK-001`：四层板叠层与参考平面
- `PCB-RULE-20H-001`：20H 与 3W 的适用边界
- `PCB-RULE-VIA-HS-001`：过孔效应/残桩/换层回流
- `PCB-RULE-GND-STITCH-001`：地过孔缝合与板边地孔
- `PCB-RULE-2L-COPPER-001`：两层板铺铜与回流
- `PCB-RULE-LAYOUT-FLOW-001`：接口定边/电源定轴/主控居中/信号流
- `PCB-RULE-MOD-POWER-001`：DC-DC/LDO/USB/SD 模块铺线
- `PCB-RULE-RF-MOD-001`：RF/模拟/时钟隔离
- `PCB-RULE-ROUTE-ORDER-001`：布线顺序（电源→时钟→高速→普通）
- `PCB-CASE-JLC-S31-001`：实战派 ESP32-S31 排版/铺线案例
- `PCB-CASE-JLC-MICROSCOPE-001`：MicroScope Power 电源/精密模拟案例
- `PCB-CASE-JLC-AIBOX-001`：AI BOX 反面边界案例
- `PCB-FAIL-PWR-TRACE-UNDERSIZE`：电源网络细线载流不足
- `PCB-FAIL-DANGLING-COPPER`：悬空线/未完成布线
- `PCB-FAIL-VIA-IN-PAD-UNPLUGGED`：盘中孔未声明塞孔

## 8. 来源

> 完整登记（39 + 3 条，含快照 SHA-256、reviewBy）见 `knowledge/pcb/dataset/sources.json`；下表列本文直接引用的主要来源。全部为 B/C 级，**非标准原文**，投板前按当期能力表/EQ 复核。

| 来源 ID | 等级 | 用途 | 链接 |
|---|---|---|---|
| `SRC-JLC-CAP-CN` | B | 嘉立创工艺能力总表（线宽/过孔/阻焊/丝印/板边/拼板/阻抗） | <https://www.jlc.com/portal/vtechnology.html> |
| `SRC-JLC-GUIDE-COPPER-POUR` | B | 铺铜注意事项（热焊盘/实心 vs 网格/残铜率/孤铜） | <https://www.jlc.com/portal/server_guide_38573.html> |
| `SRC-JLC-GUIDE-PANEL` | B | 拼板操作流程（V 割/邮票孔/工艺边） | <https://www.jlc.com/portal/server_guide_71.html> |
| `SRC-JLC-GUIDE-VCUT` | B | V 割拼板规范 | <https://www.jlc.com/portal/server_guide_69.html> |
| `SRC-JLC-GUIDE-STAMP` | B | 邮票孔拼板规范 | <https://www.jlc.com/portal/server_guide_10181.html> |
| `SRC-JLC-GUIDE-LAMINATE` | B | 层压结构 | <https://www.jlc.com/portal/server_guide_36372.html> |
| `SRC-JLC-GUIDE-MASK` | B | 阻焊设计规范 | <https://www.jlc.com/portal/server_guide_34402.html> |
| `SRC-LCEDA-WIKI-4LAYER` | B | 四层板 Layout 规范（叠层/内层 0.5oz/共面阻抗/150–300mil 缝合） | <https://wiki.lceda.cn/zh-hans/design-production/pcb-design/four-layer-board-layout.html> |
| `SRC-LCEDA-WIKI-POUR` | B | 铺铜的作用与思考（参考平面/回流/翘曲/尖角） | <https://wiki.lceda.cn/zh-hans/design-production/pcb-design/knowledge-point/role-and-consideration-of-copper-pour.html> |
| `SRC-LCEDA-WIKI-LAYOUT` | C | 布局指导（图片教程，仅登记来源） | <https://wiki.lceda.cn/zh-hans/design-production/pcb-design/layout-guidance.html> |
| `SRC-LCEDA-WIKI-ROUTING` | C | 走线指导（图片教程，仅登记来源） | <https://wiki.lceda.cn/zh-hans/design-production/pcb-design/routing-guidance.html> |
| `SRC-LCEDA-WIKI-MOD-DCDC` | C | DC-DC 模块布局/铺线 | <https://wiki.lceda.cn/zh-hans/design-production/pcb-design/moduler-design/dc-dc-moduler.html> |
| `SRC-LCEDA-WIKI-MOD-LDO` | C | LDO 模块布局/铺线 | <https://wiki.lceda.cn/zh-hans/design-production/pcb-design/moduler-design/ldo-moduler.html> |
| `SRC-LCEDA-WIKI-MOD-USB` | C | USB 接口布局/差分 | <https://wiki.lceda.cn/zh-hans/design-production/pcb-design/moduler-design/usb-interface.html> |
| `SRC-LCEDA-WIKI-MOD-SD` | C | SD 卡模块布局/走线 | <https://wiki.lceda.cn/zh-hans/design-production/pcb-design/moduler-design/sd-card.html> |
| `SRC-OSHWHUB-S31` | C | 实战派 ESP32-S31 案例 | <https://oshwhub.com/li-chuang-kai-fa-ban/project_wxwsirbz> |
| `SRC-OSHWHUB-MICROSCOPE` | C | MicroScope Power 案例 | <https://oshwhub.com/txp666/project_iupheygc> |
| `SRC-OSHWHUB-AIBOX` | C | Mini RV1126B AI BOX 案例（反例） | <https://oshwhub.com/guapi-exe/project_gzqvuteg> |

> 核对记录：2026-11-02 抓取；wiki 正文取自页面 `lean.js`（SPA 无 SSR 正文），layout/routing 两页为纯图片教程；板例图片分析由视觉模型完成，已按 C 级标注“候选/待验证”。**本文不把任何 C 级图片观察写成硬数值规则。**
