# 智能衣橱助手 · 制造放行状态记录（DRAFT / 禁止下单）

- 记录时间：2026-10-20 11:30（Asia/Shanghai）
- 嘉立创EDA工程：智能衣橱助手 `5e1059beff734847ba4b38b557e8ed59`；PCB1 `2844799d86eeed27`；原理图 p1 `8db59ac7bbc9510b`
- 板卡：60 mm × 40 mm，2 层，1.6 mm，1 oz
- **放行状态：DRAFT-NOT-FOR-ORDER**（`humanSignoffRequired=true` / `orderEnabled=false`，未签核，禁止下单）

## 一、当前设计状态（2026-10-20 实测）

| 项目 | 实测 | 说明 |
|---|---|---|
| 元件 | 180 | 与 BOM 位号一致（U3/U15 为 DNP） |
| 焊盘 | 602 | 有网 430 |
| 布局 | 180/180 落位、0 blocking、HPWL 1756.2 mm | CircuitPilot 规划器整板重排（机械件锚定） |
| 铺铜 | 2 | 顶层 + 底层 GND 铺铜，`preserveSilos=false` 重建后已填充 |
| 走线/过孔 | **1339 线 / 153 过孔** | 整板重布（Freerouting 2.5.0）+ GND 缝合 + 残余 A\* 补线 |
| **PCB DRC** | **未清零 ✗：110 项**（Connection 109 / **Clearance 0** / Netlist 1） | 基线 609 → 193 → **110**；Clearance 已清零 |
| **ERC（原理图）** | **致命 0 ✓ / 错误 0 ✓ / 警告 6 / 信息 0**（EDA 只回聚合计数） | 警告为 DNP 预留件与未用引脚悬空，属设计意图内 |
| 放行门禁 | **未通过：10 项阻塞（全部取证/流程类）** | 布局类 105 项阻塞已消除 |

## 二、制造物（全部 DRAFT 命名，不可下单）

存放在 `release/2026-10-20/`（本次由运行时 `/api/production/export` 先裁决后导出，复核结论
`PRODUCTION_EXPORT_VERIFY_FAILED`：产物已落盘但缺产物取证，不能当交付物）：

| 文件 | 大小 | 说明 |
|---|---|---|
| `BOM_CircuitPilot-bom-DRAFT-NOT-FOR-ORDER.csv` | 9,146 B | U3/U15 DNP 剔除 |
| `CPL_CircuitPilot-cpl-DRAFT-NOT-FOR-ORDER.csv` | 70,830 B | 180 器件，按**新布局**导出 |
| `GERBER_CircuitPilot-gerber-DRAFT-NOT-FOR-ORDER.zip` | 234,336 B | 2 层 Gerber（9 图层） |
| `manifest.json` | 7,696 B | 产物清单 + sha256 + 门禁指纹 + humanSignoffRequired=true |
| `RELEASE-NOTES-DRAFT-NOT-FOR-ORDER.md` | — | 本批草稿的完整说明与风险披露 |

历史批次：`release/2026-10-16/`（旧布局/旧布线）、`release/2026-10-19/`（重排前布局），勿与新批次混用。

## 三、阻塞项（放行前必须关闭）

1. **PCB DRC 未清零（110 项）**：
   - **Clearance 0 项 ✓**（上一轮 6 项已消除）。
   - Connection 109 项：
     - GND 未连焊盘 **33 个**（铺铜碎片岛 + 0.4 mm 间距焊盘把缝合走廊堵死；热焊盘已用焊盘内过孔）。
     - GND 缝合残桩 16 线 / 2 孔（尝试残留）。
     - 信号 55 项 / 21 网：集中在 U9（CODEC QFN）与 U10（ADC QFN）之间——
       U9 底排/U10 顶排焊盘净空仅 **0.235 mm**，而 5 mil 线需 **0.427 mm**，
       两排焊盘互相封死出线口，2 层 0.15 mm 规则下**物理不可布线**。
   - Netlist 1 项：Import Changes 聚合项，需人工判定。
2. **GND 缝合**：铺铜岛不跨岛连通；已实现受约束缝合（精确 DRC 等价几何校验），75 → 33 个未连。
3. **未结工程输入**：摄像头 FPC 24P 引脚定义、舵机 3 脚顺序、WS2812 级联顺序、SW1/SW2/SW3 角色、2 层 USB 90 Ω 决策。
4. **DFM / 物料**：未做嘉立创在线 DFM 复核；BOM 缺货料号下单前刷新；物料身份需逐行确认。
5. **人工签核**：未执行（保留）。

## 四、关键决策与偏差（记录在案）

- **间距矩阵 0.15 mm**（全铜类），线宽 5 mil，过孔 24/12 mil —— 显式决策，0.15 mm ≥ JLC 2 层 0.127 mm 能力，不静默放宽。
- **U3 / U15**：DNP 预留（决策 D6），不接线、不贴装、不进 BOM/CPL。
- **Q16**：决策 D7 方案一（修封装、保留原 BOM 料号）。
- **网表同步（§67）**：PCB 器件 uniqueId 已对齐，“从原理图导入变更”显示无变更；**禁止执行 Apply**（历史事故会毁焊盘）。
- **A9 SPACE-02 courtyard 规则**：本板 180 器件“本体+0.5 mm”面积占可用面积 99.5%，规则不可行；作为公开偏差记录，需人工签核。
- **2 层 DRC 清零可行性**：存在物理不可布线焊盘对；建议评估 **4 层板**（用户已允许作为“有文档的提案”，需批准后方可改版）。
