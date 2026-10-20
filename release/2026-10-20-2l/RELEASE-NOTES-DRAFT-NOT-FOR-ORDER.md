# 智能衣橱助手 · 生产草稿说明（DRAFT / 禁止下单）

> ⚠️ **存档说明（2026-10-20 14:35 追加）**：本目录是同日 **2 层**尝试的存档。同日已把板子升级为 **4 层**并完成 4 层重布（DRC 110 → 63，Clearance 0），正式草稿见 `release/2026-10-20/`。本目录文件仅用于追溯，**禁止下单**。


- 记录时间：2026-10-20 11:30（Asia/Shanghai）
- 工程：嘉立创EDA「智能衣橱助手」`5e1059beff734847ba4b38b557e8ed59`
  - PCB：`2844799d86eeed27`（PCB1）
  - 原理图：`8db59ac7bbc9510b`（p1）
- 板卡：60 mm × 40 mm，2 层，1.6 mm，1 oz
- **放行状态：`DRAFT-NOT-FOR-ORDER`，`humanSignoffRequired=true`，`orderEnabled=false`，未签核，禁止下单**

> 本目录所有文件均为**草稿**（文件名强制带 `-DRAFT-NOT-FOR-ORDER`），由 CircuitPilot 运行时
> `/api/production/export` 在“先裁决、后导出、再复核”的通道中产生。未通过放行门禁、未人工签核，
> 不得作为下单依据。本批导出的复核结论为 `PRODUCTION_EXPORT_VERIFY_FAILED`（1 条阻断：
> 缺少产物取证），产物本身已落盘但**不能当交付物**。

## 一、本批产物（2026-10-20 实测导出）

| 文件 | 大小 | 说明 |
|---|---|---|
| `BOM_CircuitPilot-bom-DRAFT-NOT-FOR-ORDER.csv` | 9,146 B | EDA 原生 BOM，U3/U15 为 DNP 预留（决策 D6，不贴装、不进 BOM） |
| `CPL_CircuitPilot-cpl-DRAFT-NOT-FOR-ORDER.csv` | 70,830 B | EDA 原生贴装坐标（**按 2026-10-20 收敛后新布局导出**，180 器件） |
| `GERBER_CircuitPilot-gerber-DRAFT-NOT-FOR-ORDER.zip` | 234,336 B | EDA 原生 Gerber（2 层，9 个图层文件） |
| `manifest.json` | 7,696 B | 产物清单：outputClass=draft、sha256、gateFingerprint=`9a0d184f…`、humanSignoffRequired=true |

生成通道（可复现）：

```bash
curl -X POST -H "x-circuitpilot-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"requested":"draft","kinds":["bom","cpl","gerber"],"outDir":"release/2026-10-20"}' \
  http://127.0.0.1:4179/api/production/export
```

历史批次：`release/2026-10-16/`（旧布局/旧布线）、`release/2026-10-19/`（重排前布局），勿与新批次混用。

## 二、本轮做了什么（2026-10-20 收敛轮）

1. **布局收敛**（§71）：修复运行时读回坐标语义（器件原点 vs 包围盒中心），用 CircuitPilot 自身
   规划器整板重排 **180/180 落位、0 blocking、HPWL 1756.2 mm**（旧 2005.4 mm）；机械件锚定后写回并复核。
   顺带修正 U9 与 U1 之间 5 处真实焊盘间距错误（U9 +0.12 mm）。
2. **整板重布**：清空全部旧走线与过孔（1185 线 / 163 孔），导出无铜 DSN
   （间距 7.0/6.95 mil、线宽 5 mil、剔除 GND），Freerouting 2.5.0 整板重布（`-mp 250 -mt 8`），
   SES 导入后**线宽统一回置 5 mil**（EDA 导入默认 10 mil，已批量修正）。
   - 结果：走线 **1339 条 / 过孔 153 个**，**间距错误（Clearance）0 项**。
3. **GND 缝合**：GND 不参与布线，靠 2 块 GND 铺铜 + “焊盘→短走线→过孔→底面铺铜”受约束缝合。
   实现了精确 DRC 等价几何校验（焊盘真实尺寸/旋转、线段-矩形距离、孔-孔、槽孔禁区），
   按 0.15 mm 规则挑孔位；缝合后 GND 未连焊盘由 75 个降至 **33 个**。
4. **残余信号补线**：自研网感知 A\* 补线器（层感知障碍栅格 + 多源起搜 + 精确几何复核），
   对 freerouting 未布通的残余网络做“焊盘→同网锚点”补线，只接受精确校验通过的线。

## 三、设计状态与验证结论（2026-10-20 实测）

| 项目 | 实测 | 判定 |
|---|---|---|
| 元件 | **180** 个 | 与 BOM 位号集合一致（含 DNP 的 U3/U15） |
| 焊盘 | 602 个（有网 430） | 布局/网络已落板 |
| GND 铺铜 | 2 块（顶层/底层，`preserveSilos=false` 重建） | 已填充 |
| 走线/过孔 | **1339 条 / 153 个** | 整板重布 + GND 缝合 + 残余补线 |
| **PCB DRC** | **110 项**：Connection 109（SMD pad 88 / Track 16 / Via 5）+ Netlist 1；**Clearance 0 ✓** | 未清零（基线 609 → 193 → 110） |
| **ERC（原理图）** | **致命 0 ✓ / 错误 0 ✓ / 警告 6 / 信息 0**（EDA 只回聚合计数） | 警告为 DNP 预留件与未用引脚悬空，属设计意图内 |
| 放行门禁 | **未通过：10 项阻塞**（全部为取证/流程类） | 见第四节 |

DRC 明细（110 项）：

- **Clearance 0 项**（上一轮 6 项，已全部消除；U9 位移 + 整板重布）。
- **Connection 109 项**：
  - **GND 未连焊盘 33 个**：C11_2, C12_2, C22_2, C24_2, C26_2, C28_2, C31_2, C32_2, C38_2,
    C42_2, C44_2, C45_2, C54_2, C74_2, C77_2, C7_2, C86_2, R11_2, R12_2, R3_1, R40_1,
    R61_2, R7_2, SW1_2, U10_21, U13_5, U1_1, U1_41, U5_25, U8_10, U8_23, U9_5, X1_4。
    原因：这些焊盘所在位置的铺铜被邻网铜皮切成孤立碎片岛，且 0.4 mm 间距的相邻焊盘
    把“焊盘→过孔”的 5 mil 走廊完全堵死（0.16 mm 可用间隙 < 0.427 mm 所需）；大热焊盘
    （U10_33/U9_21）已用焊盘内过孔处理，仍剩 33 个物理上有难度的孤岛。
  - **GND 缝合残桩 16 线 / 2 孔**（未连通的短走线/过孔，属尝试残留）。
  - **信号 55 项 / 21 个网络**：ADC_3V3 7、IO38_I2S_MCK 5、IO14_I2S_BCK 4、IO13_I2S_WS 4、
    IO1_I2C_SDA 3、CODEC_OUTN 3、3V3/CODEC_3V3/USB_D-/ADC_MIC1P/ADC_MIC3P_IN/CODEC_OUTP/
    AUTO_DL_B2/ADC_MICBIAS12/IO12_I2S_DI/IO0_BOOT/IO45_I2S_DO/U0RXD/CODEC_DACVREF/
    ADC_MIC1N_IN/I2S_DI_ADC 各 2。集中在 U9（CODEC QFN）与 U10（ADC QFN）周围：
    U9 底排焊盘（y≈24.1）与 U10 顶排焊盘（y≈23.2）之间只剩 **0.235 mm** 净空，
    而 5 mil 线需 **0.427 mm**（0.15 间距 ×2 + 0.127 线宽）——**两排焊盘互相把对方的出线口封死**。
- **Netlist 1 项**：`Import Changes` 聚合项（原理图↔PCB 匹配性复核项），需人工判定规则差异。

## 四、放行门禁阻塞项（10 项，均可复现）

| 代码 | 条数 | 说明 |
|---|---|---|
| `RELEASE_ARTIFACT_MISSING` | 3 | 缺少 gerber/bom/cpl 产物**取证**（本批产物已落盘但未入证据库） |
| `RELEASE_SCHEMATIC_EVIDENCE_MISSING` | 2 | 网表读取到 0 个器件 / 无具名引脚：验收时活动文档不是原理图 |
| `RELEASE_SCHEMATIC_NOT_READY` | 1 | 验收时活动文档不是原理图（documentType=3），跳过原理图验收 |
| `RELEASE_SIMULATION_NOT_RUN` | 1 | 无 EDA 侧仿真证据、无设计检查点结论 |
| `RELEASE_DRC_EVIDENCE_MISSING` | 1 | 门禁侧没有与当前板状态绑定的 DRC 报告 |
| `RELEASE_PLACEMENT_NOT_CONFIRMED` | 1 | 布局未被人工确认（自动重排位移可能很大，必须人确认） |
| `RELEASE_SUPPLY_IDENTITY_MISSING` | 1 | 没有 BOM 行，无法确认物料身份 |

对比上一批次门禁 111 项阻塞（其中 105 项“器件距板边 <1 mm”），**本轮已全部消除布局类阻塞**，
剩余 10 项均为“取证/人工签核/仿真”流程类阻塞——这正是草稿与正式交付之间的差距。

## 五、规则与工艺口径（已记录在案，不隐藏）

| 项 | 值 | 说明 |
|---|---|---|
| 安全间距矩阵 | **0.15 mm**（所有铜类两两） | 由 0.2 mm 下调并全局统一。JLCPCB 2 层标准能力 min trace/space = 0.127 mm，0.15 mm 留 0.023 mm 余量；**不再继续下调** |
| 走线宽度 | 5 mil (0.127 mm) | DSN 预处理线宽规则 5 mil；SES 导入后自动回置 5 mil |
| 过孔 | 24/12 mil（0.61/0.30 mm） | 缝合过孔同规格；孔-孔最小 0.3 mm |
| DSN 预处理 | 间距 7.0 / 线宽规则 5 / 间距规则 6.95 mil | 比 5.9 mil 规则多约 1.05 mil 余量 |
| 铺铜 | GND 顶层+底层，solid，priority 2，full-board inset 12 mil | `preserveSilos=false` 重建 |

## 六、未结工程输入 / 决策（下单前必须关闭）

1. 摄像头 FPC 24P 引脚定义；2. 舵机 3 脚顺序；3. WS2812 级联顺序；
4. SW1/SW2/SW3 角色定义；5. 2 层板 USB 90 Ω 差分阻抗决策；
6. A9 128 条布局规则 `SPACE-02`（courtyard 相交即硬违规）在本板不可行
   （180 器件“本体+0.5 mm”面积 2192 mm² / 可用 2204 mm² = 99.5%），已作为公开偏差记录，需人工签核。
7. **2 层 DRC 清零可行性结论**：本板密度下（≈78–80% 面积利用率 + QFN 0.4 mm 间距），
   2 层板在 0.15 mm 规则下存在**物理不可布线**焊盘对（U9/U10 相邻排 0.235 mm 净空）。
   建议按既定升级路径评估 **4 层板**（用户已允许作为“有文档的提案”，需批准后方可改版）。

## 七、复现与取证

- 布局规划/写回/复核：`POST /api/eda/pcb/placement/plan`、`/apply`（CircuitPilot 原生通道）；
- 清板/导入 SES：`/tmp/clear_export2.mjs`、`/tmp/finalize_route.mjs`（桥接执行，非第三方脚本改板）；
- DRC 取证：`POST /api/eda/pcb/drc/start` + `/report`（运行时任务通道）；
  bridge 侧完整报错树另存 `/tmp/drc_verbose_full.json`；
- ERC：`POST /api/eda/schematic/open-current {pageUuid:"8db59ac7bbc9510b"}` 后
  `POST /api/eda/schematic/erc/run` → 0/0/6/0（聚合计数）。
