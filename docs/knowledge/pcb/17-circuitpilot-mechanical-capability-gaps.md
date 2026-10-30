# 17 · CircuitPilot 机械要素能力边界与参考工程对标方法（本轮真机记录）

> 来源：衣橱助手 V2.0 AI 全链路设计（2026-10-23，主板 5595e77cead09682 / 灯板 1a5ab2c2e2c39df3）
> 关联规则：PCB-RULE-CP-CAP-005 / REF-006 / BOM-007 / STITCH-008 / STACK-009
> 关联失败：PCB-FAIL-CP-MECH-005 / BOM-006 / RAIL-007
> 关联案例：PCB-CASE-REFCOMPARE-WARDROBE
> 证据目录：artifacts/wardrobe-case/pm-run-20261022/evidence/

## 1. 结论先行

| 项 | 状态 | 证据 |
|---|---|---|
| 参考工程解析（.epro2 → BOM/PCB 统计） | 完成 | `reference-vs-ours-r42.json`、`reference-bom-gap-r44.json` |
| GND 缝合过孔（主板 32 / 灯板 16） | 完成，双板 DRC 0 | `main-gnd-stitching-r43.json`、`led-gnd-stitching-r43.json`、`drc-robust-main-r43-r38.json`、`drc-robust-led-r43-r38.json` |
| 安装孔 / 禁布区 / 丝印文字 | **阻塞（工具能力）** | 本轮三次探针全部失败，见 §2 |
| BOM 完备度（参考 179 vs 我方 71） | **未完成（需原理图补料重布）** | `reference-bom-gap-r44.json` |
| 4 层内层电源平面（参考 4 层/13 覆铜 vs 我方 2 层/2 覆铜） | **未做（叠层/成本决策）** | 同上 |
| 相机 2V8/1V5 供电 | **待确认（参考有 LDO，我方只有 3V3）** | `reference-bom-gap-r44.json` |

## 2. 机械要素创建的三种尝试与失败读数（3.2.186）

官方类型声明确有 `create(): Promise<IPCB_PrimitivePad>`、`PCB_PrimitiveRegion.create()`、`PCB_PrimitiveString.create()`，但真机三种形态全部失败：

1. `eda.pcb_PrimitivePad.create({...完整字段...})` → 错误：无法创建焊盘图元，可能是传入的参数不正确；读回 pads 仍 250。
2. `const p = await eda.pcb_PrimitivePad.create(); p.setState_...(...)`（无参 create + setter 链）→ 同样报错；fills/regions/strings 计数均为 0。
3. `sys_FileManager.setDocumentSource(整段 PCB 源码)`（追加 FILL/REGION/STRING 记录，记录 schema 照抄参考工程）→ 返回 `false`，`pcb_Document.save()` 返回 true 但重开后源码哈希不变（465926 B 未变），说明 PCB 编辑器拒绝整体替换源码。
   - 对照：`setDocumentSource` 在**封装编辑器**里可用（此前轮次验证），在 PCB 编辑器不可用。

**判断**：安装孔、禁布区、丝印文字在本版本只能 GUI 人工放置；不要写"批处理脚本"假装补齐。需要产品侧补 API 或安排人工操作并留操作人记录。

## 3. 参考工程 .epro2 的正确解析姿势

- 记录流按 `{header}||{payload}|` 逐行解析；`DOCHEAD` 划定文档边界；`docType` 有 `SCH`/`SCH_PAGE`/`PCB`/`DEVICE`/`FOOTPRINT`/`SYMBOL`/`BOARD`/`BLOB`/`FONT`。
- 原理图 BOM 不在单个字段里：`SCH_PAGE` 的 `ATTR` 记录用 `parentId` 挂到元件，键为 `Designator`/`Device`/`Footprint`；器件名要用 `Device` uuid → `DEVICE` 文档 `META.title` 映射（本例 61 个 DEVICE、180 位号 100% 映射）。
- PCB 统计：`COMPONENT 179 / NET 128 / VIA 609 / LINE 963 / POUR 13 / POURED 68 / STRING 26 / REGION 11 / FILL 57 / PAD 3`，铜层 Top/Bottom/Inner1/Inner2 均 `use=true`。
- **语义陷阱**：参考工程用 `FILL` 圆（layer MULTI=12，Ø2mm）+ `REGION PROHIBIT ["COPPER"]` 半径 1.8mm 表示机械定位特征，不能直接当成"通孔安装孔"；对齐前先确认它到底是孔、磁吸盘还是定位柱。

## 4. GND 缝合过孔的可复用流程

1. 读板框折线（`pcb.outline.read`）→ 取边界 30–70 mil 带内的候选点（格点采样 + 点在多边形内判断 + 点到边界距离）。
2. 净空筛选：到所有走线（距离 − 线宽/2）、焊盘中心、既有过孔 ≥ 55 mil。
3. 批量 `pcb_PrimitiveVia.create(net='GND', x, y, 12, 24)`，读回 newCount/GND 计数。
4. 重建覆铜（`pcb_PrimitivePour` + `pcb_Document.save()`）。
5. 官方 DRC（job 轮询）必须 0 items；否则删孔重来，不能带病保存。
6. 结果写 evidence（计划 JSON + 实际创建数 + DRC 报告 + approvalId）。

本轮结果：主板 32 孔、灯板 16 孔，双板 DRC 0；注意灯板候选点集中在左/下边缘，后续可按四边分布优化。

## 5. BOM 完备度差异（参考 vs 我方，摘要）

| 类别 | 参考工程 | 我方 | 差异含义 |
|---|---|---|---|
| 器件总数 | 179（PCB）/180（SCH 位号） | 71（主板 47 + 灯板 24） | 完备度约 40% |
| 电容 | 89：1uF×26、100nF×24+5、22pF×11、10uF×6+2、22uF×4+2、4.7uF×2、1nF×2 | 18：10uF×12、22nF×5、100nF×5（灯板） | 去耦/滤波网络严重不足 |
| 电阻 | 46：0Ω×19、10k×13、1k×3、100k×3、910k×3、5.1k×2、649Ω、470Ω、10Ω、3.3k、16k | 10：10k×3、649Ω×5、5.1k×2 | 缺 0Ω 选项/上拉下拉/限流 |
| IC | 18：ESP32-S3、CH340K、CH334F、ES7210、ES8311、NS4150B、ETA9880、SY8301、ME6211C28、ME6211C15、LMBT3904 等 | 10：ESP32-S3、IP2312、MT3608、SY8089、ES7210、NS4168、FPC/连接器 | 缺 USB-UART/Hub、音频 codec、2.8V/1.5V LDO |
| 保护 | RCLAMP0521T ESD×3、B5817WS×2、TVS | SMAJ5.0CA×1、SS34×1 | ESD 阵列缺失 |
| 电感 | 1uH（buck）+ 4.7uH（boost） | 22uH×1 | **降压电感缺失/规格需复核** |
| 机械 | FILL×6 + REGION×11 | 0 / 0 | 工具能力阻塞 |

## 6. 下一轮建议顺序

1. 相机 FPC 引脚定义 + OV5640 模组 datasheet 核对 2V8/1V5 是否需要板级 LDO（问产品，不自行假设）。
2. 补料清单评审（按 §5 表 + `reference-bom-gap-r44.json`），确认成本后走原理图→网表→PCB 全链。
3. 安装孔/禁布/丝印：改 GUI 人工放置并记录操作人；或产品补 create API 后重跑本轮探针。
4. 叠层决策（2 层 vs 4 层）由产品/硬件负责人拍板；决定后再动布局布线。
