# CircuitPilot 工程知识库 · PCB 设计 / 原理图 / 元件

本目录是 CircuitPilot 的**人工可读工程知识源**，与 `artifacts/knowledge`（或运行时 `state/knowledge`）里的**结构化知识条目**一一对应：

- 文档负责把“为什么、怎么判断、怎么落地”讲清楚，供人阅读、评审、培训；
- 结构化条目负责让 Agent / RAG / 门禁能检索和引用（`part` / `module` / `rule` / `failure` 四类）；
- 两者通过 `knowledge/pcb/dataset/*.json` 里的 `provenance.url` 与 `refs` 互相链接，`scripts/seed-knowledge-pcb.mjs` 负责灌库，`scripts/verify-rag.mjs` 负责验证检索质量。

> 知识分层原则：候选（candidate）≠ 可用（approved）。本目录内容与脚本灌入条目一律按 `reference` 可信等级、`candidate` 审核状态入库；只有人工审核通过后，才允许被编排层作为门禁引用。**AI 不得自证知识正确。**
>
> **快速导航：** [知识点总索引（KNOWLEDGE-INDEX）](./KNOWLEDGE-INDEX.md) · [案例库](./cases/README.md) · [冲突登记](./conflict-register.md) · [本次全面整理审计](../implementation/knowledge-consolidation-2026-10-30.md)

> 总索引把 **1,037 个 `KP-*` 知识点**按“领域 → 文档 → 文档内顺序”展开；每个文档同时标注结构化条目数。它是知识库的入口，不是替代原文。

## 目录结构

| 目录 | 内容 | 覆盖的设计阶段 |
|---|---|---|
| [`pcb/`](./pcb/) | 叠层/阻抗、布局布线、电源完整性、EMC/ESD/热、DFM 与制造文件、设计规则数值表、**6 层以上多层/HDI/高速总线**（07 篇）、**元器件布局依据与市场规则**（08 篇）、**可靠性/降额/环境试验**（09 篇）、**可测试性与产测**（10 篇）、**安规与认证**（11 篇）、**柔性/刚挠**（12 篇）、**封装/装配/返修**（13 篇）、**高速协议**（14 篇）、**公开资料/真实参考设计研究**（[20 篇研究笔记](./pcb/20-researched-layout-constraints.md)）、**AI 辅助布局功能分区与可读原理图**（[22 篇](./pcb/22-ai-assisted-layout-and-readable-schematic.md)）、**嘉立创EDA专业版工程闭环与 B 站课程学习笔记**（[23 篇](./pcb/23-lceda-project-workflow-and-bilibili-course.md)）、**预布线与“电源优先”**（[24 篇](./pcb/24-prerouting-and-power-first.md)）、**PCB 布线十条原则**（[25 篇](./pcb/25-ten-routing-principles.md)） | PCB Layout → 制造 → 量产 |
| [`schematic/`](./schematic/) | 原理图规范、电源架构、MCU 最小系统、总线接口、保护电路、ERC 审查清单、**模拟信号链**（08 篇）、**传感器/执行器**（09 篇）、**电池与 BMS**（10 篇）、**RF/天线**（11 篇）、**先进电源拓扑**（12 篇）、**文件与 ECO**（13 篇） | 需求 → 原理图 → 评审 |
| [`components/`](./components/) | 无源器件、二极管/TVS、三极管/MOSFET、电源 IC、MCU/无线/连接器、晶振、常用料号速查与封装核验、**电感/磁珠/保险丝**（08 篇）、**传感器/执行器**（09 篇）、**接口保护**（10 篇）、**供应链**（11 篇）、**元件库管理**（12 篇） | 选型 → BOM → 封装 → 量产维持 |
| [`checklists/`](./checklists/) | 原理图评审、Layout 评审、选型评审三张可勾选清单 | 评审门禁 |
| [`cases/`](./cases/) | 参考设计案例复盘：本地真实板（衣橱助手 V1.2/V2.0、6 层监测板、CH32V003）+ 公开参考设计（Pico、Uno、ESP32、Nucleo、USB-C PD、Buck、隔离 CAN/RS485）+ **TWS/工业控制器/AC-DC/RF 模组/柔性板**（12–16 篇） | 案例学习 → 规则依据 → 迁移 |
| [`requirements/`](./requirements/) | 产品需求/验收档案（原被误分类为 `module` 的 38 条需求，已迁出） | 产品验收，不进入设计门禁 |
| [`legacy/`](./legacy/) | 历史条目迁移/退役记录与运行态重建命令 | 治理/迁移 |

> 现状（2026-10-30，全面整理后）：Markdown 文档 **70 篇**（设计内容 **69 篇** + 需求档案 1 篇）；知识点 **1,037 个**（PCB 369 / SCH 286 / CMP 211 / CASE 171）；结构化知识 **442 条**（rule 173 · module 93（含 5 条案例模块）+ case 17 · part 57 · failure 102）；来源登记 **26 条**；本地 `artifacts/knowledge` 中 **442 条全部为 candidate，approved 仍为 0**。所有新知识均为 `reference` + `candidate`，须人工审核后才可被门禁引用。来源登记见 [`sources.json`](../../knowledge/pcb/dataset/sources.json)。

> 冲突口径与优先级见 [`conflict-register.md`](./conflict-register.md)；机器可读分类见 [`taxonomy.json`](../../knowledge/pcb/dataset/taxonomy.json)、冲突登记见 [`conflicts.json`](../../knowledge/pcb/dataset/conflicts.json)；全面审计见 [`docs/implementation/knowledge-audit-k6-2026-10-22.md`](../implementation/knowledge-audit-k6-2026-10-22.md)，K7 治理落地见 [`docs/implementation/knowledge-k7-governance-2026-10-22.md`](../implementation/knowledge-k7-governance-2026-10-22.md)；本次全面整理与审计见 [`docs/implementation/knowledge-consolidation-2026-10-30.md`](../implementation/knowledge-consolidation-2026-10-30.md)。

结构化数据源在 [`knowledge/pcb/dataset/`](../../knowledge/pcb/dataset/)：

| 文件 | kind | 说明 |
|---|---|---|
| `rules.json` | `rule` | 可判定的设计规则（带数值边界、判定方法、依据） |
| `modules.json` | `module` | 电路模块 / 板级设计模式（电源、总线、最小系统、叠层、接地……） |
| `parts.json` | `part` | 常用元件身份与引脚知识（MPN/LCSC/封装/引脚/极性/注意事项） |
| `failures.json` | `failure` | 典型失败模式（症状 → 根因 → 发现方法 → 预防） |
| `cases.json` | `module` | 参考设计案例（`moduleId = PCB-CASE-*`，含设计原理/规则依据/可迁移经验/可信度声明） |
| `sources.json` | 来源登记 | 公开资料研究的 URL/发布者/版本/抓取时间/快照 SHA-256/证据等级/**reviewBy 复核期限**，供条目 `sources` 字段引用；`npm run check:knowledge-sources` 校验 |
| `taxonomy.json` | 映射 | 216 个 category → 8 个领域（schematic/pcb/components/manufacturing/reliability/rf/reference/requirements） |
| `conflicts.json` | 冲突登记 | 9 组冲突规则的 scope/裁决/状态，不修改历史 payload |

## 文档写法约定

为了让人和 Agent 都读得懂，本目录所有文档遵循同一套结构：

1. **一句话结论**：文档开头先给可执行结论，不铺垫。
2. **知识点编号**：每个知识点用 `### KP-<域>-<三位编号> 标题` 开头（域：`PCB` / `SCH` / `CMP`）；案例文档用 `### KP-CASE-<案例短名>-<两位编号>`，案例短名与收录规则见 [`cases/README.md`](./cases/README.md)。
   - 例外：`checklists/`、`requirements/` 和部分“能力边界/研究笔记/API 专题”不强制编号；它们按清单或章节组织，并在总索引第 6 节单列。**不要为了凑编号伪造知识点。**
3. 每个知识点必须回答四个问题：
   - **判据**：什么条件下成立（数值、单位、适用工艺）。
   - **为什么**：物理/工艺/成本原因。
   - **怎么做**：具体到网络、器件、层、间距、顺序。
   - **怎么查**：DRC/ERC/目检/测量/评审项，写清楚“不通过时怎么办”。
4. **表格优先**：能用数值表就不用长句；数值必须带单位和适用前提。
5. **不确定就标注**：datasheet 未核实、工艺能力随厂变化的数值，标注「需按厂家能力表/实测复核」，**禁止编造**。
6. **交叉引用**：文末列「关联知识条目」，写清对应的 `ruleId/moduleId/failureId/mpn`，方便从文档跳到结构化条目。

## 知识如何进入 CircuitPilot

```bash
# 0) 校验数据集（fragment 先合并，再灌库）
node scripts/merge-knowledge-dataset.mjs --check   # 只读：报告 accepted/duplicates/problems
node scripts/merge-knowledge-dataset.mjs           # 合并 fragments/*.json 到四类核心 JSON 并归档
node scripts/build-knowledge-index.mjs --check     # 只读：检查总索引是否落后于文档/条目
node scripts/build-knowledge-index.mjs             # 重新生成 docs/knowledge/KNOWLEDGE-INDEX.md
node scripts/seed-knowledge-pcb.mjs --check        # schema/doc/entityKey 自检

# 1) 灌入候选条目（默认写 artifacts/knowledge，幂等，可重复执行）
node scripts/seed-knowledge-pcb.mjs

# 2) 重建并评估 RAG 检索（golden query 命中率写入 artifacts/evidence）
node scripts/verify-rag.mjs

# 3) 在应用「知识库」页人工审核（审核人必填）：candidate → approved 后才可被门禁引用
```

## 知识库 Agent 的分工与复盘回路

知识入库不是"一个 Agent 写、大家信"，而是分段负责、共用一个审核闸门：

| 环节 | Agent / 模块 | 只做什么 | 绝不做 |
|---|---|---|---|
| 写入 | KMA`（[`knowledge-manager.mjs`](../../runtime/agents/knowledge-manager.mjs)） | 证据 badcase 归并、白名单网页采集、定期维护 | 不自动 approved、不写 EDA |
| 写入 | RLA 复盘学习 Agent（[`retrospective-learner.mjs`](../../runtime/agents/retrospective-learner.mjs)） | 项目收尾：事实 → failure；经验 → failure/rule/module；落 `retrospective` 证据；支持大模型起草（草案 unverified）与跨项目同缺陷码合并 | 没有事实不硬写、无根因不编原因、不自动 approved |
| 写入 | Field Loop（[`field-loop.mjs`](../../runtime/agents/field-loop.mjs)） | 样机/产测问题单 → 回归用例 → failure 候选 | 无根因不生成回归用例 |
| 整理 | 加工管道（[`knowledge-pipeline.mjs`](../../runtime/knowledge-pipeline.mjs)）+ KMA 维护 | 去重、冲突、过期、审核队列、健康度 | 不改写历史 payload、不代替审核 |
| 审核 | 人工（知识库 →「审核队列」） | `candidate → approved/rejected`，审核人必填 | AI 不得自审自证 |
| 使用 | 编排层 + [`knowledge-citations.mjs`](../../runtime/agents/knowledge-citations.mjs) + 门禁 | 引用前核验"存在 + approved + 未过期"；缺证据判 unknown | 不把 candidate 当门禁依据 |

两条闭环：

- **证据闭环（已有）**：ERC/DRC/网表/器件核验 → `badcase` → candidate → 审核 → 门禁/RAG；
- **复盘闭环（新增）**：交付归档/人工触发 → RLA（事实 + 经验） → candidate → KMA 整理 → 审核 → RAG/下个项目复用。

完整合同、路由与验证见 [`docs/implementation/knowledge-retro-loop.md`](../implementation/knowledge-retro-loop.md)。

## 维护规则

- 新增/修改知识点：先改本目录文档与 `knowledge/pcb/dataset/`，再重新灌库；**不要直接手改 `artifacts/knowledge` 里的 JSON**（digest 会失配，store 会按损坏 fail-closed）。
- 公开资料/标准类条目必须带 `sources`（指向 `knowledge/pcb/dataset/sources.json`）与 `evidenceLevel`；A 级标准/原厂、B 级板厂/行业文章不得混用，二手转述必须回到原文复核。
- `sources.json` 每条必须有 `reviewBy`；到期后 `npm run check:knowledge-sources` 报 `SOURCE_REVIEW_OVERDUE`，必须重新抓取、更新 `snapshotSha256/fetchedAt` 后再顺延，不得无声续期。
- 工艺能力类数值（嘉立创/PCBWay 最小线宽、孔环、板边距离等）随厂家与产线变化：引用时写清厂家与日期，复核后再更新 TTL。
- 器件身份类知识（LCSC 料号、封装、引脚）必须经 Librarian 三源核验（EDA 库 / 供应商 / datasheet）后才可信；灌库时 `identityVerification` 字段明确写“待核验”。
- 注意：数据集里的 `lcscIdVerified` 只表示“料号线索与项目 BOM/公开记录一致”，**不等于**三源核验通过；凡带 `identityVerification`、`lcscIdVerificationNote` 或文档标注“待核验”的，使用前都必须走 Librarian 核验。
- 任何结论如果来自参考工程，只能作为验收基准，不得作为设计输入照抄。
