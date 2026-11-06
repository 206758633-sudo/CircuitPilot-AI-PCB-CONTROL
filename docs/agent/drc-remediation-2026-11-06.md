# 真实板 DRC 整改建议（2026-11-06）

> 来源：真实 EDA 在线只读 DRC（`cp_validation`），证据 `drc-report` digest `743d2cc1b206fc0c11bfa9c279477652e29822675af9fc4fa1f028119e82a40b`。
> **本文件只是分析建议：没有修改任何板子，也不会自动修复/豁免。**

## 1. 结果摘要

- `reportedCount=1`（EDA 的“分组数”），**实际违规 `itemCount=39` 条**，`truncated=false`，`countsConsistent=false`（已按实际条数统计）。
- 错误类型：{"Clearance Error":39}
- 规则：{"copperThickness1oz":39}
- 层分布：{"Top Layer":20,"Inner2":9,"Inner1":8,"Multi-Layer":2}
- 分类：`ready=false`，blocking finding `DRC_UNEXPLAINED_ITEMS`（全部未解释）+ warning `DRC_COUNT_MISMATCH`。
- 结论：**不得放行**；先修复几何/规则，或登记带理由与风险的豁免，然后重跑 DRC。

## 2. 按签名分组

| 条数 | 签名 |
|---|---|
| 13 | Clearance Error/copperThickness1oz/Top Layer/Board Outline->Track/- |
| 8 | Clearance Error/copperThickness1oz/Inner2/Board Outline->Track/- |
| 7 | Clearance Error/copperThickness1oz/Inner1/Board Outline->Track/- |
| 4 | Clearance Error/copperThickness1oz/Top Layer/Board Outline->SMD Pad/- |
| 2 | Clearance Error/copperThickness1oz/Top Layer/Board Outline->Via/- |
| 2 | Clearance Error/copperThickness1oz/Multi-Layer/Board Outline->Hole/- |
| 1 | Clearance Error/copperThickness1oz/Inner1/Copper Region(Filled)->Board Outline/GND |
| 1 | Clearance Error/copperThickness1oz/Inner2/Copper Region(Filled)->Board Outline/+3V3 |
| 1 | Clearance Error/copperThickness1oz/Top Layer/Copper Region(Filled)->Board Outline/EXT_48V |

## 3. 样本（前 12 条）

| 层 | 规则 | 说明 | 对象 |
|---|---|---|---|
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 0mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(GND): e10245 |
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 0mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(INT_MID): e11004 |
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 0mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(VDC): e10062 |
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 1.2mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(BST3): e11195 |
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 0mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(GND): e10240 |
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 0mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(GND): e10263 |
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 2.1mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(INT_24V): e11193 |
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 0mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(EN_INT_A): e10830 |
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 0mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(TG4): e11078 |
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 0mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(VDC): e10077 |
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 0mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(Q4_GATE): e11028 |
| Top Layer | copperThickness1oz | Object 1 to object 2 distance is 0mil, should be >= 11.8mil | Board Outline: e5 ↔ Track(GND): e10246 |

## 4. 建议处理顺序（只建议，不执行）

1. 先处理 `Board Outline to Track` 的 0mil 间距（板框/走线贴边）：核对板框与 GND 走线，必要时内缩走线或调整板框。
2. `Track to Track` / `Track to Pad` / `Pad to Pad`：按 `copperThickness1oz` 规则的最小间距（报告样例为 ≥11.8mil）调整；确认规则本身是否符合本工艺档位。
3. 对确认“实物可接受”的条目，登记**带理由/风险/有效范围**的豁免（不能只写“忽略”），再重跑 DRC 复核。
4. 重跑 `cp_validation({requestId, targets:['drc']})`，对比 digest 与 itemCount 是否下降；不要用“计数变化”当通过证据，仍需 classification.ready=true 或明确豁免记录。
5. 若 EDA 只返回分组计数（count=1），继续以 `itemCount` 为准，并要求 EDA 返回逐条明细。

## 5. 边界

- 本轮 0 写入、0 豁免、0 签核；DRC 结果来自真实 EDA（版本错位：connector 1.14.0 / CLI 1.3.0，可读性可能受适配器影响，建议同版 connector 复测）。
- 29 条（示例）的层/规则只是报告字段；具体修复要回到 EDA 里逐条看对象。
