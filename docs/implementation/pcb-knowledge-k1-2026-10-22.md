# K1 通用工程知识补给：PCB 设计 / 原理图 / 元件（2026-10-22）

> 目标：把知识库从「只覆盖衣橱工程 BOM/需求/证据」的 K0，扩展为**跨板可复用的通用 PCB 工程知识**（设计规则、原理图模式、元件身份与封装），并保证「文档可读、条目可检索、检索可验证、审核仍由人做」。
>
> 红线保持不变：脚本/Agent 只产 `candidate` + `reference`，**不自动 approved**；approved 前不得作为门禁引用。

## 1. 本期新增内容

### 1.1 人类可读知识文档（`docs/knowledge/`）

| 目录 | 文件数 | 行数 | 知识点 | 内容 |
|---|---:|---:|---:|---|
| `pcb/` | 6 | 986 | 106 个 `KP-PCB-*` | 设计规则数值基线、叠层与阻抗、布局布线、电源完整性与去耦、EMC/ESD/热、DFM 与制造文件 |
| `schematic/` | 7 | 1357 | 134 个 `KP-SCH-*` | 原理图规范、电源架构、MCU 最小系统、总线接口、保护电路、ERC 评审、模拟/音频/ADC 前端 |
| `components/` | 7 | 1499 | 121 个 `KP-CMP-*` | 无源器件、二极管/TVS、三极管/MOSFET、电源 IC、MCU/无线/连接器、晶振、常用料号与封装核验 |
| `checklists/` | 3 | 269 | — | 原理图评审、Layout 评审、选型评审三张可勾选清单 |
| `README.md` | 1 | — | — | 目录导览、写作约定、灌库与审核流程 |

合计 **24 篇 Markdown / 4112 行 / 361 个知识点**。每个知识点按「判据 / 为什么 / 怎么做 / 怎么查」四段书写，数值带单位与适用前提；厂家能力值统一标注「需按当前能力表 + 工程确认单复核」，未编造厂家参数与标准条款。

### 1.2 结构化知识数据集（`knowledge/pcb/dataset/`）

| 文件 | kind | 条数 | entityKey | 说明 |
|---|---|---:|---|---|
| `rules.json` | rule | 30 | `ruleId` | 可判定的设计规则：载流、间距、过孔/孔环、阻焊、丝印、阻抗、差分、叠层、去耦、ESD、热、爬电、DRC、制造文件、BOM、拼板…… |
| `modules.json` | module | 30 | `moduleId` | 电路模块/板级设计模式：4 层叠层、接地、PDN、阻抗、热、EMC、DFM、拼板、LDO/Buck/Boost、输入保护、USB-C、充电、MCU 最小系统、晶振、复位、I2C/SPI/UART/USB/CAN/RS485、电平转换、ESD、LED/RGB、音频、ADC、RF、SWD |
| `parts.json` | part | 27 | LCSC 料号或 MPN | 常用元件身份与引脚知识：阻容/二极管/TVS/LDO/Buck/充电/串口桥/MCU/无线模组/MOSFET/LED/连接器/晶振/电感/FPC；均标 `identityVerification`，料号与封装需 Librarian 三源核验 |
| `failures.json` | failure | 22 | `failureId` | 典型失败模式：立碑、冷焊、连锡、ESD、闩锁、使能悬空、去耦缺失、地环路、串扰、阻抗失配、EMI、热失控、USB-C CC、晶振、TVS、反接、封装映射、载流、MLCC 偏压、酸角、via-in-pad、板翘 |

合计 **109 条结构化知识**（rule 30 / module 30 / part 27 / failure 22），每条 `provenance.url` 指向 `docs/knowledge/` 下的对应文档，`trust=reference`、`reviewState=candidate`、默认 TTL 365 天。

### 1.3 工具链与集成

- `scripts/seed-knowledge-pcb.mjs`：数据集自检（字段/唯一 entityKey/doc 指针存在）→ 本地灌库（幂等）或经 Runtime HTTP API 写入正在运行的应用（`--api`）；`--check` 只校验。
- `runtime/__tests__/knowledge-pcb-seed.test.mjs`：数据集完整性、灌库幂等与「candidate 不可门禁使用」、RAG 命中回归。
- `runtime/server.mjs`：RAG 语料目录加入 `docs/knowledge`（与 `docs/implementation`、`docs/wardrobe-case` 并列）。
- `scripts/verify-rag.mjs`：语料目录同步加入 `docs/knowledge`；golden query 从 7 条扩展到 15 条，覆盖 PCB/原理图/元件三类知识。
- `package.json`：新增 `seed:knowledge:pcb`、`seed:knowledge:pcb:api`、`verify:rag`。

## 2. 验证结果

| 验证 | 命令 | 结果 |
|---|---|---|
| 数据集自检 | `node scripts/seed-knowledge-pcb.mjs --check` | 109 条，0 problems；4 类齐全、entityKey 唯一、doc 指针全部存在 |
| 灌库（仓库开发库） | `node scripts/seed-knowledge-pcb.mjs` | created 109 / errors 0；仓库知识库 93 → **202 条**（part 60 · module 68 · rule 35 · failure 39） |
| 单元/回归测试 | `node --test runtime/__tests__/knowledge-pcb-seed.test.mjs` | 3/3 通过（数据集、幂等、RAG 命中） |
| 知识相关回归 | knowledge / knowledge-api / rag / citations / pipeline | 32/32 通过 |
| RAG 检索评估 | `node scripts/verify-rag.mjs` | **Pass**：15/15 query Hit@1，Hit@3=1.0，MRR=1.0；281 docs / 1986 chunks / 52509 terms |
| 引用闭环 | `node scripts/verify-knowledge-loop.mjs` | candidate 引用 → unknown（fail-closed）；临时审核 approved 后 → pass 并落 usage |
| TypeScript | `npm run typecheck` | 通过（本次未改 TS） |
| 运行时全量测试 | `npm run test:runtime` | 1026 tests / 1018 pass / 8 fail；8 个失败均在 `pour-create`、`schematic-batch-http`、自动化工单预算等**既有未提交改动相关模块**；把本次 `server.mjs` 的 ragDirs 单行改动回退后同样失败，确认与知识变更无关 |

### 2.1 正在运行的 CircuitPilot 应用

| 项 | 变更前 | 变更后 |
|---|---:|---:|
| 知识条目 | 103（part 36 · module 38 · rule 10 · failure 19） | **212**（part 63 · module 68 · rule 40 · failure 41） |
| 待审候选 | 103 | 212（新增 109 条全部 candidate，等待人工审核） |
| RAG 索引 | 158 docs / 1405 chunks | 267 docs / 1535 chunks |
| RAG 实测查询 | — | 「去耦电容摆放」命中规则 kn-rule-eb276c99f111d2bb；「USB-C CC 5.1k」命中失败 kn-failure-b89d39d1ec784b08；「晶振负载电容起振」命中失败 kn-failure-38a8bb6106f80ef7；「MLCC 直流偏压降容」命中 kn-failure-2083075e04f8808a |

> 应用内知识库页刷新即可看到 109 条新候选；`approved` 仍需人工在「知识库 → 审核队列」逐条/批量审核（审核人必填）。

## 3. 已知限制与后续

1. **LCSC 料号/引脚/参数均为候选知识**：`parts.json` 中的 `lcscIdVerified` 仅表示“料号线索与项目 BOM/公开记录一致”，不等于三源核验通过；凡带 `identityVerification`、`lcscIdVerificationNote` 或文档标注“待核验”的条目，必须经 Librarian 三源核验（EDA 库 / 供应商 / datasheet）后才可作为选型依据。SS34 在项目 BOM 中记为 SOD-123 与常见 SMA 不符等存疑点已在文档与数据中显式标注。
2. **厂家工艺参数需复核**：线宽/间距/孔环/阻焊桥/V-cut 残厚等随板厂与产线变化，文档中的数值是「设计基线 + 判据」，下单前必须用当前能力表与工程确认单复核。
3. **既有规则口径冲突待裁决**：`docs/pcb-layout/02 MECH-08`（V-cut 残厚 ≈1.07mm）与 `03 DFM-08`（≈0.5mm）互相矛盾，本期文档取「≈1/3 板厚、约 0.5mm，需板厂确认」，建议后续统一回写规则中心。
4. **运行中的应用是打包版**：本次通过 HTTP API 灌入结构化条目并已重建 RAG，因此应用内立即可检索；`docs/knowledge` 已加入开发版 RAG 目录，**打包版需重新构建/重启后**才会把 24 篇文档一起纳入语料（条目内容已包含等价的 payload，不影响当前检索）。
5. **人工审核待办**：212 条候选需要人工审核；审核通过前，RAG 可用于“找依据”，但编排层引用仍会 fail-closed（不会把候选知识当门禁依据）。
