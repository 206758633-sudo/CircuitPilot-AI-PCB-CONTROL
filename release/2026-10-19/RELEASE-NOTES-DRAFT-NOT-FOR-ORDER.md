# 智能衣橱助手 · 生产草稿说明（DRAFT / 禁止下单）

- 记录时间：2026-10-19 20:45（Asia/Shanghai）
- 工程：嘉立创EDA「智能衣橱助手」`5e1059beff734847ba4b38b557e8ed59`
  - PCB：`2844799d86eeed27`（PCB1）
  - 原理图：`8db59ac7bbc9510b`（p1）
- 板卡：60 mm × 40 mm，2 层，1.6 mm，1 oz
- **放行状态：`DRAFT-NOT-FOR-ORDER`，`humanSignoffRequired=true`，`orderEnabled=false`，未签核，禁止下单**

> 本目录所有文件均为**草稿**（文件名强制带 `-DRAFT-NOT-FOR-ORDER`），由 CircuitPilot 运行时
> `/api/production/export` 在"先裁决、后导出、再复核"的通道中产生。未通过放行门禁、未人工签核，
> 不得作为下单依据。

## 一、本批产物（2026-10-19 实测导出）

| 文件 | 大小 | 说明 |
|---|---|---|
| `BOM_CircuitPilot-bom-DRAFT-NOT-FOR-ORDER.csv` | 9,146 B | EDA 原生 BOM 导出，**178 个位号**（U3/U15 为 DNP 预留，按决策 D6 不贴装、不进 BOM） |
| `CPL_CircuitPilot-cpl-DRAFT-NOT-FOR-ORDER.csv` | 75,764 B | EDA 原生贴装坐标导出后按 DNP 剔除 U3/U15，**178 行** |
| `GERBER_CircuitPilot-gerber-DRAFT-NOT-FOR-ORDER.zip` | 252,536 B | EDA 原生 Gerber 导出（2 层板） |
| `manifest.json` | 2,458 B | 产物清单：outputClass=draft、sha256、gateFingerprint、humanSignoffRequired=true |

生成通道（可复现）：

```bash
curl -X POST -H "x-circuitpilot-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"requested":"draft","kinds":["bom","cpl","gerber"],"outDir":"release/2026-10-19"}' \
  http://127.0.0.1:4179/api/production/export
```

## 二、设计状态与验证结论

| 项目 | 实测（2026-10-19） | 判定 |
|---|---|---|
| 元件 | **180** 个 | 与 BOM 位号集合一致（含 DNP 的 U3/U15） |
| 焊盘 | 602 个（有网 430） | 布局/网络已落板 |
| GND 铺铜 | 2 块（顶层/底层，`preserveSilos=false` 重建） | 已填充 |
| 走线/过孔 | **1185 条 / 163 个**（Freerouting SES 导入结果） | 覆盖约 90% 连接 |
| **PCB DRC** | **193 项 ✗**：Connection 186 / Clearance 6 / Netlist 1 | 未清零（基线 609 → 193） |
| **ERC** | 致命 0 / 错误 0 / **警告 6** / 信息 0（聚合计数） | 警告全部为 DNP/未用引脚悬空，属设计意图内 |
| 放行门禁 | **未通过**：111 项阻塞 | 见第四节 |

DRC 明细（`/tmp/drc_final3.json`）：

- **Connection 186 项 / 34 个网络**：GND 96、+5V 7、USB_D+ 5、IO38_I2S_MCK 5、IO1_I2C_SDA 5、
  VBUS 4、USB_D- 4、IO13_I2S_WS 4、IO14_I2S_BCK 3、DTR 3、DVP_PWDN 3、CODEC_OUTN 3，其余 22 网各 2 项。
  原因：Freerouting 在 7.0 mil 间距余量下仍有 50 个连接未布通；GND 依赖铺铜连通，但铺铜碎片岛机制
  导致约 96 个 GND 焊盘未与主铜相连（需显式走线/过孔缝合）。
- **Clearance 6 项**：
  1. `U5_8(IO20_USB_D+) ↔ SW3_3` 0 mil —— SW3 为备用轻触开关，需挪位；
  2. `U13_3(GND) ↔ SW1_1(IO0_BOOT)` 2.4 mil —— 需微调 U13 或 SW1；
  3. `C64_2(GND) ↔ U1_26` 5.4 mil、`C64_1(IO13_I2S_WS) ↔ U1_26` 5.4 mil —— C64 需微调；
  4. `C67_1/C67_2 ↔ Slot Region e76` 0 mil ×2 —— C67 压在板内槽孔上，必须挪离槽孔（槽孔是物理开槽）。
- **Netlist 1 项**：`Import Changes` 聚合项（原理图↔PCB 匹配性复核项），需人工判定规则差异。

## 三、规则与工艺口径（已记录在案，不隐藏）

| 项 | 值 | 说明 |
|---|---|---|
| 安全间距矩阵 | **0.15 mm**（所有铜类两两） | 由 0.2 mm 下调并全局统一。JLCPCB 2 层标准能力 min trace/space = **0.127 mm**，0.15 mm 留 0.023 mm 余量；**不再继续下调** |
| 信号线宽 | **5 mil (0.127 mm)** | 板子按 5 mil 线宽检查；电源线原计划 8 mil |
| 过孔 | 孔径 12 mil / 外径 19.7 mil (0.5 mm) | 外径为规则最小值；孔-孔 11.8 mil |
| 板框 | 60 × 40 mm（2362.2 × 1574.8 mil） | 2 块 GND 铺铜内缩 12 mil |
| 层数 | 2 层 | 若继续追 DRC 清零，建议评估 4 层（见第五节） |

## 四、放行门禁阻塞项（2026-10-19 实测）

`POST /api/eda/release/gate` 返回 **111 项阻塞**，分类：

1. **RELEASE_PLACEMENT_NOT_VERIFIED × 105**：U3、CN5、C45、D2、R52、R62、SW3、U5、U16 等
   **105 个器件距板边 < 1 mm**（早前为降密度做过 1.18× 布局散开 + 113 个器件的合法性重排，
   把部分器件推近板边）。**下单前必须重新布局收敛**，属硬阻塞。
2. **RELEASE_DRC_EVIDENCE_MISSING × 1**：门禁取证时未携带 DRC 报告（DRC 未清零前本就不允许放行）。
3. **RELEASE_ARTIFACT_MISSING × 3**：门禁要求同一次取证中携带 gerber/bom/cpl 产物记录
   （本次草稿已导出到本目录并带 manifest，但放行取证链路仍需按要求重新采集）。
4. **RELEASE_PLACEMENT_NOT_CONFIRMED × 1**：布局未人工确认（自动布局位移可达上百 mil）。
5. **RELEASE_SUPPLY_IDENTITY_MISSING × 1**：BOM 物料身份未逐行确认（缺货料号下单前需刷新）。

## 五、剩余工作的建议顺序（继续收敛 DRC 的路线）

1. **先修布局**（最优先）：把 105 个距边 <1 mm 的器件拉回安全区；同时把 C67 移离槽孔 e76、
   SW3 移离 U5、微调 U13/C64 消除 6 条间距错误。布局每动一次都要重跑 DRC 核对。
2. **重布**：用清理过的 DSN（全局间距 7.0 mil / 类 6.95 mil，比规则多 1 mil 余量）重跑 Freerouting，
   导入后间距误报可控制到近 0；剩余未布通连接再用受约束的补线处理。
3. **GND 缝合**：铺铜碎片岛不参与跨岛连通，必须显式"焊盘→走线→过孔→底层铺铜"逐点缝合，
   且过孔布置要同时满足孔-孔 11.8 mil 与同网过孔间距。
4. **2 层 vs 4 层**：180 器件/62 网在 60×40 mm 2 层板上，0.15 mm 间距 + 5 mil 线宽已接近极限；
   若 DRC 清零无法在可接受轮次内达成，建议升级 4 层（成本增加有限，布线余量显著提升）。
5. 收尾：重跑 DRC/ERC 取证 → 刷新 DFM 证据 → 人工签核（硬件/工艺/项目负责人）→ 才可出正式件。

## 六、变更与已知偏差记录

- **U3 / U15（DNP 预留）**：按决策 D6 不接线、不贴装，已从 BOM 与 CPL 草稿剔除（PCB 上保留封装占位）。
- **Q16**：按决策 D7 采用"方案一"——修复封装、保留原 BOM 料号，未替换器件。
- **铺铜 `preserveSilos`**：曾试 `true` 保留填充岛，DRC GND 未连接从 84 涨到 280，已回退 `false`。
- **迷宫布线器实验（自研，2026-10-19）**：GND 缝合与信号补线实验曾把 DRC 连接错误从 209 降到 172，
  但同时引入 24 条新间距错误（过孔孔-孔、焊盘-走线），且铺铜重建会改变岛结构；
  为保证板面干净已**整体回退**（回到 1185 线/163 过孔）。实验过程与数据记录在
  `docs/implementation/whole-board-progress.md` §68–§70。
- **间距矩阵 0.15 mm、线宽 5 mil、过孔 12/19.7 mil** 为显式设计决策，非静默放宽。
- **禁止**在本工程上执行"从原理图导入变更"的 Apply（历史事故：焊盘 602→24，需工程历史还原）；
  网表同步已于 §67 完成，当前"无变更，PCB 与原理图已经匹配"。

## 七、人工签核（保留，未执行）

| 角色 | 姓名 | 结论 | 日期 |
|---|---|---|---|
| 硬件设计 |  |  |  |
| 制造/工艺 |  |  |  |
| 项目负责人 |  |  |  |

> 在人工签核完成、放行门禁转绿之前，本目录所有制造物**不得用于任何下单生产**。
> 本说明仅作工程过程记录与风险披露。
