# 16. 细间距逃逸与扇出：判定数学与真机标定

对应数据集条目：`PCB-CASE-WARDROBE-V2`、`PCB-RULE-CP-AUTO-001`。
证据：`artifacts/wardrobe-case/pm-run-20261022/evidence/`（`fine-pitch-geometry-r31.json`、`routing-broken-nets-r31.json`、`drc-robust-main-r40b-r38.json`）。

## 16.1 什么时候"布不出来"是物理事实

两条线能否从两个焊盘之间穿过，只看三个数：

```
可用缝隙 = pitch - padWidth            （焊盘边缘到边缘）
所需宽度 = 2 × clearance + traceWidth   （两条间隙 + 一条线）
可行 ⇔ 可用缝隙 ≥ 所需宽度
```

真机标定（嘉立创 2 层/多层板规则，clearance = 6 mil ≈ 0.152mm，实际按 11.8mil 复核）：

| 场景 | pitch | 焊盘宽 | 可用缝隙 | 8mil 线 + 2×clearance | 结论 |
|---|---|---|---|---|---|
| 0.5mm FPC 6P | 19.6 mil | ~11.8 mil | ~7.8 mil | 6+2×11.8=29.6 mil | ✗ 直出不可能 |
| 0.5mm 间距 + 6mil 线 | 19.6 mil | ~8 mil | ~11.6 mil | 6+2×6=18 mil | ✗（按 6mil 规则仍不够） |
| 0.4mm QFN | 15.7 mil | ~8 mil | ~7.7 mil | 6+2×6=18 mil | ✗ 必须 via-in-pad 或更细规则 |
| 0.65mm 间距 | 25.6 mil | ~10 mil | ~15.6 mil | 6+2×6=18 mil | ✗/边界，看板厂能力 |

结论：**细间距不是"布线器不努力"，是几何不允许。** 这时正确的产品行为是 fail-closed（拒绝写违规计划），而不是硬布然后指望 DRC 放过。

## 16.2 逃逸策略（按优先级）

1. **via-in-pad / 盘中孔**：焊盘中心打孔，直接从焊盘下钻到内层。要求板厂做塞孔/填平（树脂塞孔+电镀填平），并确认最小孔/环宽。
   - 真机教训：`viaSize minRadius=9.8425`（0.5mm 直径）时 0.2mm 过孔被 EDA 判 `Physical Error`；把设计规则改为 `minRadius=3.937` 后 0.2mm 盘中孔可用。
   - 规则改动必须**记录原源码快照 + sha256**，改后读回校验，可回滚（设计规则存在 PCB 文档源码的 `type=RULE` 行里）。
2. **打孔到内层再扇出**：多层板把细间距网络先下到内层，用更宽的间距绕出。
3. **换封装/改板**：≥0.65mm 间距封装，或改成能容纳逃逸的板层结构。
4. **登记 DRC 豁免**：只对"已识别为物理不可扇出"的网络，必须写明理由并接受电气/可制造性风险；豁免要能在门禁里被逐条解释（`RELEASE_DRC_EXEMPTED`）。

## 16.3 与放行门的关系

- DRC 里 `Connection Error`（未连通）与 `Clearance Error`（间距）是两类问题：前者是"没连上"，后者是"连得危险"。混在一起报会误导修复方向。
- 覆铜重建"假成功"必须拦住：`pcb_PrimitivePour.getAll + pcb_PrimitivePoured.getAll` 读回**实际填充片数**，0 填充必须失败且不保存。
- 自动布线只能当 EVT 候选：布通不代表可制造，必须重建覆铜 + 官方 DRC 读回 + 人工评审线宽/过孔/回流。

## 16.4 检查清单

- [ ] 先算缝隙/所需宽度，再决定能否直出（不要先布线后解释）
- [ ] 细间距网络优先 via-in-pad，确认板厂塞孔填平能力
- [ ] 改设计规则前存源码快照 + sha256，改后读回
- [ ] DRC 报告按 Error 类型分组，Connection vs Clearance 分开修
- [ ] 覆铜重建后读 fills 数，0 填充不保存
- [ ] 自动布线结果标注 EVT 候选 + 人工评审
