# 知识库全面整理与审计（2026-10-30）

> **结论：** 知识库已从“70 篇文档 + 442 条结构化条目”整理成可导航的 **1,037 个知识点地图**。本次只做**索引、去重标题、修复失效引用、统计口径和治理说明**，不改写任何知识结论，不自动审核，不把 `candidate` 升级为 `approved`。

## 1. 整理范围与方法

- 扫描 `docs/knowledge/**/*.md`：提取 `KP-*` 标题、文档标题、领域归属。
- 读取 `knowledge/pcb/dataset/{rules,modules,cases,parts,failures}.json`：统计结构化条目、文档对偶、分类与来源。
- 读取 `taxonomy.json`、`sources.json`：核对 8 个 domain、category 映射、来源引用。
- 检查：重复 KP ID、重复标题、编号断档、文档无条目、条目无文档、失效 `ruleId/moduleId/failureId` 引用、索引是否过期。
- 生成：`docs/knowledge/KNOWLEDGE-INDEX.md`，并新增 `npm run knowledge:index` / `knowledge:index:check`。

## 2. 整理后总览

| 指标 | 结果 |
|---|---:|
| Markdown 文档（不含 README/索引/冲突登记） | **70** |
| 其中设计内容文档（不含 requirements） | **69** |
| 带 `KP-*` 编号的知识点 | **1,037** |
| 无编号文档（清单/需求/专题） | **12** |
| 结构化知识条目 | **442** |
| 来源登记 | **26** |
| taxonomy category | **216** |
| domain | **8** |

知识点按域：

| 域 | 文档 | 知识点 | 编号范围 | 无 KP 文档 |
|---|---:|---:|---|---:|
| PCB | 25 | 369 | `KP-PCB-001`–`369` | 8 |
| SCH | 13 | 286 | `KP-SCH-001`–`286` | 0 |
| CMP | 12 | 211 | `KP-CMP-001`–`211` | 0 |
| CASE | 16 | 171 | `KP-CASE-<短名>-01`–`12` | 0 |
| 清单/需求 | 4 | 0 | — | 4 |

结构化条目按 kind：

| kind | 数量 | 说明 |
|---|---:|---|
| rule | 173 | 可判定规则 |
| module | 93 | 模块/设计模式 |
| case | 17 | 参考设计案例（`cases.json`，seed 时按 module 载入）；另有 5 条 `PCB-CASE-*` 在 `modules.json`，合计 22 条案例模块 |
| part | 57 | 料号/器件身份 |
| failure | 102 | 失败模式 |

审核状态（本地 `artifacts/knowledge`，2026-10-30）：

- `candidate`：**442**
- `approved`：**0**
- 结论：索引只提供“知识点位置”，不改变门禁可用性；人工审核前所有条目仍不可作为门禁依据。

## 3. 审计发现与处理

### 3.1 已处理

| # | 发现 | 处理 |
|---:|---|---|
| 1 | README 旧统计只写 442 条，没有 1,037 个知识点的口径 | 更新 README：70 篇 / 69 内容 / 1,037 KP / 442 条 / 26 来源；新增总索引入口 |
| 2 | 3 个泛化 KP 标题完全重复：`失败模式与可量测判据（本章门禁）` | 分别改为“电感/磁珠/保险丝”“传感器/执行器”“接口保护”的失败模式标题，保留 ID 不变 |
| 3 | 5 个失效结构化引用 | `PCB-RULE-EMC`→`PCB-RULE-SAFE-EMC-001`；`PCB-RULE-TEST-POINT-001`→`PCB-RULE-TESTPOINT-001`；`PCB-FAIL-FOOTPRINT-MISMATCH`→`PCB-FAIL-FOOTPRINT`；`PCB-FAIL-SOLDER-BRIDGE`→`PCB-FAIL-BRIDGE`；`PCB-FAIL-DOC-VERSION-DRIFT`→`SCH-FAIL-VERSION-DRIFT` |
| 4 | 索引会随文档变化而过期 | 新增生成器与 `--check`，并纳入 `knowledge-dataset` 测试：索引过期即失败 |
| 5 | 文档目录里没有“总入口” | 生成 `KNOWLEDGE-INDEX.md`：领域导航 + 跨域主题导航 + 文档目录 + 全部 KP 标题 + 无编号文档说明 |
| 6 | 总索引含全部 KP 标题，若进入 RAG 会把“导航”当成“知识命中” | 在 RAG 语料加载器跳过 `KNOWLEDGE-INDEX.md`（reason `NAVIGATION_INDEX`），保留真实文档与条目检索 |

### 3.2 保留项（不是缺陷）

| 现象 | 判断 | 理由 |
|---|---|---|
| 12 篇文档没有 `KP-*` 编号 | 保留 | 3 篇评审清单、1 篇需求档案、8 篇能力边界/研究/API 专题；按清单或章节组织更合适，索引第 6 节单列 |
| 案例编号每个短名从 `01` 重新开始 | 保留 | `KP-CASE-<短名>-NN` 是篇内编号；171 个 ID 全局唯一，不强行改成连续数字 |
| `SCH-RULE-SENSOR` / `SCH-RULE-ANALOG` / `SCH-RULE-BATT` 被正则识别为“未解析” | 保留 | 文档里写的是 `SCH-RULE-*-*` 通配组，不是单个 ID；不是失效引用 |
| 同一主题在 PCB/SCH/CMP/案例中重复出现 | 保留并交叉索引 | 去耦、接地、回流、ESD 等在不同层级有不同判据；**不盲目合并**，避免把“布局视角”和“原理图视角”压成一条 |
| 380/442 条结构化条目没有外部 `sources` | 记录，不阻塞 | 多数是内部工程规则/项目经验；62 条公开资料类条目已有来源。后续按领域补来源，但不伪造引用 |

### 3.3 编号与引用检查

- 重复 `KP-*` ID：**0**。
- 各数字族编号断档：**0**（PCB 1–369、SCH 1–286、CMP 1–211 连续）。
- 重复 KP 标题：修复后 **0**。
- 文档无结构化条目：**0**（69 篇内容文档全部有对偶条目）。
- 结构化条目对应文档不存在：**0**。
- 失效的单个结构化 ID 引用：修复后 **0**；剩余 3 个为通配组写法，见 3.2。
- `KP-*` 交叉引用未解析：**0**（171 个 `KP-CASE` 引用均可解析）。

## 4. 索引怎么用

```bash
npm run knowledge:index         # 重新生成 docs/knowledge/KNOWLEDGE-INDEX.md
npm run knowledge:index:check   # CI/提交前检查索引是否落后
```

阅读路径建议：

1. 先看 [`KNOWLEDGE-INDEX.md`](../knowledge/KNOWLEDGE-INDEX.md) 的“领域导航”；
2. 进入某篇文档，按 `KP-*` 定位具体判据；
3. 在文档末尾的“关联知识条目”跳到 `ruleId/moduleId/failureId`；
4. 需要门禁引用时，先确认条目已由人工审核为 `approved`，否则只能作为参考。

## 5. 验证记录

| 检查 | 结果 |
|---|---|
| `node scripts/build-knowledge-index.mjs` | 写入成功；70 文档 / 1,037 KP / 442 条 / 26 来源 |
| `node scripts/build-knowledge-index.mjs --check` | 通过（索引最新） |
| `node --test runtime/__tests__/knowledge-dataset.test.mjs runtime/__tests__/rag.test.mjs` | **15/15 通过**（含索引同步与 RAG 回归） |
| `npm run test:runtime` | **1,442/1,442 通过** |
| `node scripts/seed-knowledge-pcb.mjs --check` | 442 条，0 问题 |
| `node scripts/check-knowledge-sources.mjs` | 26/26 被引用，0 问题 |
| `npm run verify:rag` | 60/60 Hit@1、60/60 Hit@3；导航索引已从语料排除 |

## 6. 残余工作

- **人工审核**：442 条仍全部是 candidate；优先审核公开资料/新 B 站来源条目，审核前不得写“已验证/可用于门禁”。
- **来源补齐**：380 条无外部来源的条目多为内部规则；后续只对确实来自公开资料的条目补 `sources`，不批量伪造。
- **专题去重**：跨域重复主题保留多视角；若后续发现同一判据出现数值冲突，走 `conflicts.json` 登记，不在文档里静默改数。
- **索引维护**：任何文档/KP/条目变更后运行 `npm run knowledge:index`，否则测试会失败。
