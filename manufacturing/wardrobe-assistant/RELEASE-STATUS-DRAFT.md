# 智能衣橱助手 · 制造放行状态记录（DRAFT / 禁止下单）

- 记录时间：2026-10-19 20:45（Asia/Shanghai）
- 嘉立创EDA工程：智能衣橱助手 `5e1059beff734847ba4b38b557e8ed59`；PCB1 `2844799d86eeed27`；原理图 p1 `8db59ac7bbc9510b`
- 板卡：60 mm × 40 mm，2 层，1.6 mm，1 oz
- **放行状态：DRAFT-NOT-FOR-ORDER**（`humanSignoffRequired=true` / `orderEnabled=false`，未签核，禁止下单）

## 一、当前设计状态（2026-10-19 实测）

| 项目 | 实测 | 说明 |
|---|---|---|
| 元件 | 180 | 与 BOM 位号一致（U3/U15 为 DNP） |
| 焊盘 | 602 | 有网 430；34 个网络仍报未连接 |
| 铺铜 | 2 | 顶层 + 底层 GND 铺铜，`preserveSilos=false` 重建后已填充 |
| 走线/过孔 | 1185 线 / 163 过孔 | Freerouting SES 导入结果（DSN 间距 7.0/6.95 mil 留余量） |
| **PCB DRC** | **未清零 ✗：193 项**（Connection 186 / Clearance 6 / Netlist 1） | 基线 609 → 193；明细见 `release/2026-10-19/RELEASE-NOTES-DRAFT-NOT-FOR-ORDER.md` |
| **ERC（原理图）** | **6 项：致命 0 ✓ / 错误 0 ✓ / 警告 6 / 信息 0**（EDA 只回聚合计数） | 警告为 DNP 预留件与未用引脚悬空，属设计意图内 |
| 放行门禁 | **未通过：111 项阻塞** | 105 项器件距板边 <1 mm；DRC 证据/产物/布局确认/物料身份缺失 |

## 二、制造物（全部 DRAFT 命名，不可下单）

存放在 `release/2026-10-19/`（本次由运行时 `/api/production/export` 先裁决后导出）：

| 文件 | 大小 | 说明 |
|---|---|---|
| `BOM_CircuitPilot-bom-DRAFT-NOT-FOR-ORDER.csv` | 9,146 B | 178 位号（U3/U15 DNP 剔除） |
| `CPL_CircuitPilot-cpl-DRAFT-NOT-FOR-ORDER.csv` | 75,764 B | 178 行（DNP 已剔除） |
| `GERBER_CircuitPilot-gerber-DRAFT-NOT-FOR-ORDER.zip` | 252,536 B | 2 层 Gerber |
| `manifest.json` | 2,458 B | 产物清单 + sha256 + 门禁指纹 + humanSignoffRequired=true |
| `RELEASE-NOTES-DRAFT-NOT-FOR-ORDER.md` | — | 本批草稿的完整说明与风险披露 |

历史批次：`release/2026-10-16/`（旧布局/旧布线，勿与新批次混用）。

## 三、阻塞项（放行前必须关闭）

1. **PCB DRC 未清零**：Connection 186（GND 96 + 33 网络 90）、Clearance 6、Netlist 1。
   - 6 条间距错误：U5_8↔SW3_3 0 mil、U13_3↔SW1_1 2.4 mil、C64↔U1_26 5.4 mil ×2、C67↔槽孔 e76 0 mil ×2。
   - 186 条连接错误：Freerouting 仍有 50 个连接未布通 + GND 铺铜碎片岛导致约 96 个 GND 焊盘孤岛。
2. **布局距板边**：105 个器件 <1 mm（1.18× 散开与合法性重排的副作用），下单前必须收敛。
3. **GND 缝合**：铺铜岛不跨岛连通，需显式"焊盘→走线→过孔→底层铺铜"缝合，过孔需同时满足孔-孔与同网间距。
4. **未结工程输入**：摄像头 FPC 24P 引脚定义、舵机 3 脚顺序、WS2812 级联顺序、SW1/SW2/SW3 角色、2 层 USB 90 Ω 决策。
5. **DFM / 物料**：未做嘉立创在线 DFM 复核；BOM 缺货料号下单前刷新；物料身份需逐行确认。
6. **人工签核**：未执行（保留）。

## 四、关键决策与偏差（记录在案）

- **间距矩阵 0.15 mm**（全铜类），线宽 5 mil，过孔 12/19.7 mil —— 显式决策，0.15 mm ≥ JLC 2 层 0.127 mm 能力，不静默放宽。
- **U3 / U15**：DNP 预留（决策 D6），不接线、不贴装、不进 BOM/CPL。
- **Q16**：决策 D7 方案一（修封装、保留原 BOM 料号）。
- **网表同步（§67）**：PCB 器件 uniqueId 已对齐，"从原理图导入变更"显示无变更；**禁止执行 Apply**（历史事故会毁焊盘）。

## 五、人工签核（保留，未执行）

| 角色 | 姓名 | 结论 | 日期 |
|---|---|---|---|
| 硬件设计 |  |  |  |
| 制造/工艺 |  |  |  |
| 项目负责人 |  |  |  |

> 本文件仅为工程过程记录与风险披露；在人工签核完成、放行门禁转绿之前，本目录所有制造物**不得用于下单生产**。
