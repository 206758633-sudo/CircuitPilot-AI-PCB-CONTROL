# 工程结构清理记录（2026-10-21）：双板结构归位

## 1. 背景：需求本来就是两块 PCB

`docs/wardrobe-case/PCB板需求清单-PM版.md` 明确要求：

| 需求 ID | 内容 | 尺寸 |
|---|---|---|
| PCB-M-01 | 双板结构：**主控板 + 按键指示灯板**，两板功能分工明确 | — |
| PCB-M-02 | 尺寸上限 | 主板约 **5.6×6.2cm**、按键板约 **2.1×4.5cm** |

参考工程 `ProDoc_衣橱助手V2.0_2026-10-16.epro2` 实测也是同一套双板（同一 PCB 文档里并排两块板框）：

- 主板板框 **56.07×61.84mm**，164 个器件；
- 按键指示灯板板框 **21.44×44.9mm**，**15 个器件**：5×WS2812B-2020（LED5/7/8/9/10）、2×TS3425BA 按键（SW1/SW3）、2×ZX-SH1.0-3P（U16/U17）、6×100nF（C9/C81/C87~C90）；
- 板间接口（两板各 2 个 SH1.0-3P，两根 3P 线）：
  - 电源/灯数据：主板 U14（`+5V / GND / LED`）↔ 按键板 U16（`5V0 / GND0 / LED0`）
  - 按键：主板 U18（`BUTTON / IO0_BOOT / GND`）↔ 按键板 U17（`BUTTON0 / IO0_BOOT0 / GND0`）
- 按键板走线在参考文件里只用了顶层（2 层板做法）。

而 CircuitPilot 工程此前是 **3 个 Board（Board1/Board1_1/Board1_2）+ 3 个游离文档（PCB1、Schematic1、Schematic1_1）**：
Board1_1/PCB3 是唯一有内容的主板（56.32×62.10mm，64 器件）；Board1/PCB2、Board1_2/PCB4 都是 **0 器件空板**（重复执行 `workspace.create` 留下的占位），
按键指示灯板 **自始至终没有设计过**（无 LED/按键/WS2812 相关器件与网络）。

结论：这不是"残留太多、删到只剩一块"，而是"缺了第二块板"。清理目标应为：**主板 + 按键指示灯板 = 2 块板**。

## 2. 本次执行的清理（只删空内容，主板零改动）

通过 EasyEDA 官方扩展 API 执行（Bridge 原始调用，逐条回读校验）：

| # | 操作 | 对象 | 结果 |
|---|---|---|---|
| 1 | `dmt_Pcb.deletePcb` | 游离 PCB1 `73750871b3861fe0`（0 器件/0 线/0 过孔） | ✅ |
| 2 | `dmt_Schematic.deleteSchematic` | 游离 Schematic1 `335dc84c63c7050c`（无图页） | ✅ |
| 3 | `dmt_Schematic.deleteSchematic` | 游离 Schematic1_1 `87d29baa44909fda`（无图页） | ✅ |
| 4 | `dmt_Board.deleteBoard("Board1")` | 空板 Board1 `fed00a0a4e0038d1`（PCB2 0 器件） | ✅ |
| 5 | `dmt_Pcb.deletePcb` + `dmt_Schematic.deleteSchematic` | deleteBoard 未级联删除的 PCB2 `ffedea82912ffae9`、Schematic1_2 `1d6fddc725f9d9d5` | ✅ |
| 6 | `dmt_Board.modifyBoardName` | 保留的空板 Board1_2 `f9ad4e37125da9e5` → 改名 **按键指示灯板** | ✅ |

清理前后对比：

| 项 | 清理前 | 清理后 |
|---|---|---|
| Board | Board1、Board1_1、Board1_2 | **Board1_1（主控板）、按键指示灯板** |
| PCB | PCB1、PCB2、PCB3、PCB4 | **PCB3、PCB4** |
| 原理图 | Schematic1、Schematic1_1、Schematic1_2、Schematic1_3、Schematic1_4 | **Schematic1_3、Schematic1_4** |
| 游离文档 | 3 个 | **0 个** |

主板 Board1_1/PCB3 清理后完好性回读（当前活动文档=PCB3）：
**64 器件 / 345 线段 / 51 过孔 / 4 铺铜 / 274 焊盘** —— 与清理前一致，内容零改动。

## 3. 证据

- `artifacts/evidence/board-cleanup-2026-10-21/before-cleanup.json`（清理前 boards/pcbs/schematics 全量快照）
- `artifacts/evidence/board-cleanup-2026-10-21/orphan-pcb1-before-delete.json`（PCB1 空内容确认）
- `artifacts/evidence/board-cleanup-2026-10-21/step1-delete-orphans.json`
- `artifacts/evidence/board-cleanup-2026-10-21/step2-delete-board1.json`（含 deleteBoard 不级联、需补删 PCB2/Schematic1_2 的记录）
- `artifacts/evidence/board-cleanup-2026-10-21/step3-rename-verify.json`（改名 + 主板回读 + 清理后 project.current）
- `artifacts/evidence/board-cleanup-2026-10-21/eda-tree-after-cleanup.png`（EDA 工程树：只剩 2 块板）
- `artifacts/evidence/board-cleanup-2026-10-21/summary.json`

## 4. 还没完成：第二块板要从零设计 + 主板要补接口

### 4.1 按键指示灯板（当前为空板，PCB4 2 层）
按参考板规格需设计（约 2.1×4.5cm）：
- 5×WS2812B-2020 RGB（级联，5V，每颗 100nF 就近去耦）
- 2×按键（POWER/NET，参考为 TS3425BA，对应 `BUTTON0`、`IO0_BOOT0`）
- 2×ZX-SH1.0-3P 连接器（U16 电源+灯数据输入；U17 按键输出）
- 6×100nF 0402 + 丝印 POWER/NET/版本 + 板框 21.44×44.9mm（2 层、双面贴装有条件）

### 4.2 主控板（Board1_1/PCB3）需要补的接口（参考板有、当前没有）
- 2×SH1.0-3P 板间连接器：`+5V/GND/LED`、`BUTTON/IO0_BOOT/GND`
- 5 颗指示 LED（4 段电量 + 电源灯）及限流电阻/GPIO 网络（当前 R21~R25 未连线，主板无任何 LED/按键网络）
- 现有 U13/CN1/CN5/J7/R21~R25 多数引脚未连线，需随按键/LED 接口一并补齐
- 其余 P0：GND 短接修复（网表把 10 个 GND 归到 +3V3）、171 个悬空引脚定性、DRC/ERC 重跑

### 4.3 建议顺序
1. 按键指示灯板原理图（15 器件）→ 网表/ERC；
2. 按键指示灯板 PCB（21.44×44.9mm、2 层、双面贴装、丝印）；
3. 主板补 2 个 3P 接口 + 5 颗指示 LED + 连线；
4. 两板 ERC/DRC、3D、BOM/CPL、板间接口核对，再进放行门。
