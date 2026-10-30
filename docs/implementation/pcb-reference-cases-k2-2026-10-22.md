# K2 参考设计案例分析与知识沉淀（2026-10-22）

> 目标：在 K1 的「规则 + 模块 + 元件 + 失败模式」之上，补一层**案例知识**——用真实板卡/公开参考设计回答“别人为什么这样设计、依据哪条规则、代价是什么、换到新板怎么迁移”。
>
> 红线不变：案例条目与派生规则一律 `candidate` + `reference`，人工审核前不得作为门禁依据；公开案例不得直接当项目规则使用。

## 1. 本期新增内容

### 1.1 案例文档（`docs/knowledge/cases/`）

| 编号 | 案例 | 级别 | 行数 | KP |
|---|---|---|---:|---:|
| 01 | Raspberry Pi Pico / RP2040 官方参考设计 | B · 公开资料 | 190 | 11 |
| 02 | Arduino Uno R3 开源参考设计 | B · 公开资料 | 181 | 10 |
| 03 | ESP32-DevKitC / ESP32-S3-DevKitC 官方参考设计 | B · 公开资料 | 193 | 11 |
| 04 | ST STM32 Nucleo-64 官方参考设计 | B · 公开资料 | 179 | 11 |
| 05 | USB-C PD 受电/充电参考设计 | B · 公开资料 | 187 | 12 |
| 06 | 同步 Buck 电源参考布局 | B · 公开资料 | 185 | 12 |
| 07 | 隔离 CAN / RS485 工业节点参考设计 | B · 公开资料 | 185 | 12 |
| 08 | 衣橱助手参考原理图 V1.2（ESP32-S3 整机拓扑） | A · 本地证据 | 129 | 10 |
| 09 | 衣橱助手 V2.0 主板 + 按键灯板（4 层异形板） | A · 本地证据 | 130 | 10 |
| 10 | CircuitPilot 6 层监测板（90Ω 差分 + 电流/温度监测） | A · 本地证据 | 131 | 10 |
| 11 | CircuitPilot CH32V003 P0（2 层 45×30mm 最小系统） | A · 本地证据 | 129 | 10 |

合计 **11 篇 / 1819 行 / 119 个案例知识点**，外加 `cases/README.md`（案例库导览、可信度分级、写作与灌库约定）。

每篇固定结构：案例档案 → 设计原理拆解 → 规则依据（映射 `PCB-RULE-*`）→ 可迁移经验（做对/妥协/反面教训）→ 评审清单 → 可信度与来源声明 → 关联知识条目。

### 1.2 结构化知识

| 数据 | 变更 |
|---|---|
| `knowledge/pcb/dataset/cases.json`（新增） | 11 条 `module` 知识（`moduleId = PCB-CASE-*`），payload 含 boardType/sourceType/evidence/summary/designPrinciples/ruleBasis/lessons/reviewFocus/verificationNotes |
| `knowledge/pcb/dataset/rules.json` | 新增 10 条由案例沉淀的规则（30 → 40）：`RF-001` 天线净空、`POWERMUX-001` 多电源切换、`SHUNT-001` 开尔文采样、`FEEDBACK-001` DC-DC 反馈、`FPC-001`、`BOARD2BOARD-001`、`CHARGER-001`、`AUDIO-001`、`LED-001`、`ISO-001` |
| 数据集总计 | **130 条**（rule 40 / module 41 / part 27 / failure 22） |

### 1.3 工具链与集成

- `scripts/seed-knowledge-pcb.mjs`：支持一个 kind 对应多个数据集文件（`module = modules.json + cases.json`），并校验文件内 kind 一致、entityKey 唯一、doc 指针存在。
- `runtime/__tests__/knowledge-pcb-seed.test.mjs`：阈值提高到 ≥128 条、断言 cases.json 存在、provenance 允许 `docs/knowledge/cases/`；RAG 回归仍覆盖 PCB/原理图/元件/案例。
- `scripts/verify-rag.mjs`：golden query 15 → **23 条**，新增 8 条案例检索（Pico、Uno、ESP32、USB-C PD、Buck、隔离 CAN/RS485、衣橱助手、6 层差分）。
- `docs/knowledge/README.md`：目录表加入 `cases/`，数据集表加入 `cases.json`，说明 A/B 可信度分级与“案例不得直接当规则”。

## 2. 验证结果

| 验证 | 结果 |
|---|---|
| 数据集自检 | 130 条，0 problems；4 类齐全、entityKey 唯一、130 个 doc 指针全部存在 |
| 灌库（仓库开发库） | created 21 / updated 109 / errors 0；仓库知识库 202 → **223 条**（rule 45 · module 79 · part 60 · failure 39） |
| 单元/回归测试 | `knowledge-pcb-seed.test.mjs` 3/3 通过（数据集、幂等 candidate、RAG 命中） |
| RAG 检索评估 | **Pass**：23/23 query Hit@1，Hit@3=1.0，MRR=1.0；316 docs / 2261 chunks / 57117 terms |
| 运行中的应用 | 新增 21 条（11 案例 + 10 规则），知识库 **233 条**（part 63 · module 79 · rule 50 · failure 41），全部 candidate；RAG 重建后 326 docs / 2277 chunks |
| 应用内实测检索 | “Raspberry Pi Pico 2 层 参考设计”“Arduino Uno 电源自动切换”“ESP32 天线净空”“USB-C PD 受电”“同步 Buck 布局”“隔离 CAN RS485”“衣橱助手 4 层”“6 层 90Ω 差分”“CH32V003 最小系统”均命中案例知识，且同一查询能同时命中 `[knowledge]` 条目与 `[doc]` 案例文档（说明运行中的 RAG 已包含 `docs/knowledge`） |
| TypeScript | `npm run typecheck` 通过（本次未改 TS） |

## 3. 案例带来的规则增量（按案例）

| 规则 | 来源案例 | 核心判据 |
|---|---|---|
| `PCB-RULE-RF-001` | 03 ESP32 | 天线净空区所有层禁铜/禁线/禁器件，尺寸按模组 datasheet |
| `PCB-RULE-POWERMUX-001` | 02 Uno / 03 ESP32 | 多电源优先级、防倒灌、切换不掉电 |
| `PCB-RULE-SHUNT-001` | 10 6 层板 | 分流电阻四线开尔文、成对走线、功率 ≥2×I²R |
| `PCB-RULE-FEEDBACK-001` | 06 Buck | 反馈取自输出电容之后、远离 SW 节点 |
| `PCB-RULE-FPC-001` | 08 V1.2 | FPC 翻盖方向/补强/弯折半径/Pin1 |
| `PCB-RULE-BOARD2BOARD-001` | 09 V2.0 | 板间连接交叉线序 + 防呆 + 低电容 TVS |
| `PCB-RULE-CHARGER-001` | 09 V2.0 | 充电截止电压/电流/NTC 与电池匹配 |
| `PCB-RULE-AUDIO-001` | 08 V1.2 | 功放 LC/去耦、AU_GND 单点、默认静音 |
| `PCB-RULE-LED-001` | 09 V2.0 | WS2812 数据电平、每颗 100nF、刷新电流预算 |
| `PCB-RULE-ISO-001` | 07 隔离 CAN/RS485 | 隔离带无铜、爬电/间隙、TVS/终端、地分割 |

## 4. 已知限制与后续

1. **公开案例为 B 级**：本机无外网（`web_search` 无 API key、`web_fetch` 被网络策略拦截），01–07 基于公开官方设计指南/原理图的工程常识整理，**未逐页核对官方文件**；层数、尺寸、器件参数、天线净空、爬电数值均标注“以官方文件/datasheet 复核”，不得直接抄入项目规则。
2. **本地案例为 A 级但有版本问题**：衣橱助手 V1.2 参考 PDF 与 V2.0 BOM 存在版本差异；6 层监测板的叠层介质/εr 是当时假设；V2.0 记录中存在 BOM 缺值/CPL 偏差/网表不完整；CH32 P0 的 DFM 未验证、库存快照已过期。引用前须对齐版本。
3. **案例条目全部 candidate**：233 条知识仍为候选，人工审核前只能作为“检索/参考”，不能作为门禁依据。
4. **运行中 RAG 已含案例文档**（实测 `[doc]` 命中）；若之后重新打包/重启，`docs/knowledge` 已在开发版 RAG 目录中，重新构建即可保持。
5. **建议下一步**：把 10 条新规则进入人工评审；对 B 级案例逐条查官方文件并更新“复核状态”；补充“案例→规则→门禁”的引用闭环测试（当前已有 `verify-knowledge-loop.mjs` 覆盖 fail-closed 语义，但未覆盖案例条目）。
