# CircuitPilot RAG 工程方案（W3-20）

> 目标：让 CircuitPilot 的 Agent 在"做判断"之前先"找到依据"，并且依据可追溯、可复现、可审计。
> 约束：**本地优先、零新依赖、离线可用、不把检索结果当门禁结论**。

## 1. 为什么不是"调一个向量数据库/embedding API"

- 工程要装进桌面 App（Tauri + 本地 Node sidecar），不能依赖外部 embedding 服务/API Key；
- 生产门禁要求可复现：同样问题在评委/用户机器上必须得到同样依据；
- 知识库现在只有约 100 条结构化条目 + 50+ 篇工程文档，规模不需要 ANN 向量库；
- 因此选择 **确定性特征哈希向量 + BM25 混合检索**：无模型下载、无网络、构建 200ms 级。

## 2. 总体架构

```
语料层                 索引层                       服务层                    使用方
knowledge store ─┐    chunkMarkdown (700字/90重叠)   createRagStore          /api/rag/{status,reindex,query}
docs/**.md      ─┼─→  tokenize (中文bigram+英文)  ─→ 懒构建 + 持久化       ─→ 知识库页面 RAG 面板
（可扩展：evidence）│    embed (384维feature hash)     state/rag/index.json      编排层 step.ragQuery（可选）
                  └→   混合打分 BM25+Cos+标题加权      损坏自动重建            证据里附 retrieval + 引用
```

## 3. 关键设计

### 3.1 分块（chunk）
- Markdown 感知：按标题切段，块保留「标题路径」（如 `规则 > DRC`），一个块尽量能独立回答一个工程问题；
- 目标 700 字符、最小 60、块间 90 字符重叠（跨块句子不被切断）；
- 超长行先切片再入块（修复过的真实 bug），单文档最多 80 块，防止单文档刷屏。

### 3.2 分词（tokenize）
- 英文/数字/料号：连续字母数字串，小写化，去停用词；
- 中文：**单字 + 相邻二元组**，无需词典即可召回"阻抗控制/叠层/悬空引脚"等词；
- 纯净函数 → 可测试、可复现。

### 3.3 向量（embed）
- **特征哈希**（FNV-1a）：token 与相邻 token 对哈希到 384 维，带符号累加；
- TF 权重 `1+log(tf)`，L2 归一化 → 点积即余弦；
- 确定性：同文本任何机器得到同向量；索引里以 base64 Float32 持久化；
- 语义能力有限但"同主题词共现"足够召回；不冒充语义模型，词法通道兜底。

### 3.4 混合打分（hybrid）
- BM25（k1=1.2, b=0.75）在词法通道排序；
- 余弦在语义通道排序；
- `score = 0.65 * 归一化BM25 + 0.35 * clamp(cos) + 标题/标题路径命中加权(≤0.1) + knowledge 类目加权 0.02`。
- 返回 `bm25/cosine/score` 三列，便于解释"为什么这条排前面"。

### 3.5 索引与持久化
- `state/rag/index.json`：docs、chunks、postings、df、avgLen、builtAt、corpusDigest；
- **懒构建**：首次 query / 显式 reindex 才建索引；状态未构建时如实显示"未构建"；
- 索引损坏/维度不符 → 记 `loadError`，下次检索自动重建，**不把空结果伪装成"没搜到"**；
- 语料目录不存在（如 App 包内没有 docs/）→ 自动跳过，只用知识库条目，不报假错；
- 桌面端把 `docs/implementation`、`docs/wardrobe-case` 作为 Tauri resources 一并打进 .app，App 内 RAG 语料与开发机一致。

### 3.6 API
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/rag/status` | built/docs/chunks/terms/dims/builtAt/loadError/corpus |
| POST | `/api/rag/reindex` | 重建 + 落盘，返回构建耗时相关统计 |
| POST | `/api/rag/query` | `{query, topK, kinds?, minScore?}` → 混合排序结果 |

### 3.7 与 Agent 编排的集成（W3-20）
- `runDesignPipeline({ rag, steps })`：步骤声明 `ragQuery` 时，检索 topK 依据并写进该步证据 `retrieval`；
- 检索器缺失/检索失败 → 该步失败（fail-closed），门禁判 `unknown`，**不用"没检索"冒充"没依据"**；
- 检索结果只提供上下文；是否放行仍由证据（ERC/DRC/网表/BOM…）+ 人工审核决定。

### 3.8 前端
- 「知识库 → RAG 检索（本地混合索引）」面板：索引状态/文档块数/词项/上次检索、重建按钮、检索框与结果表（分数、标题片段、类型、来源）；
- 明确标注"只提供依据，不构成放行"。

## 4. 实测（真实语料，非模拟）

- 语料（开发机）：知识库 **93 条** + 工程文档 **54 篇** → **147 文档 / 1373 块 / 35908 词项**；
- 安装版 `.app` 内置 docs 语料后：知识库 **103 条** + 文档 **55 篇** → **158 文档 / 1405 块 / 36477 词项**，构建 **283ms**，索引 `state/rag/index.json`（≈9.6MB）；
- 开发机索引 `artifacts/rag/index.json`；
- Golden query（7 条：阻抗/DRC/ERC/立创封装/USB-C/Gerber/焊接）→ **Hit@1=7/7，Hit@3=7/7，MRR=1.0**；
- 评估脚本 `scripts/verify-rag.mjs` 可复跑；结果落证据 `artifacts/evidence/knowledge/…`。

## 5. 边界与后续

**边界**
- 特征哈希向量不是神经 embedding，跨词表同义改写（如"立碑"↔"tombstoning"）召回有限，靠词法+同义词典/知识条目别名补；
- Golden query 是关键词命中判定，不等于人工相关性标注；
- 检索不是门禁：RAG 命中不能替代 ERC/DRC/网表/BOM 证据与人工签字；
- 索引全量重建，增量索引留到语料 >1 万块再做。

**后续可选**
- 同义词/别名表（立碑→tombstoning、叠层→stackup）；
- 基于 RAG 相似度的 KMA 去重（新增知识先查重再入库）；
- 增量索引 + 索引版本化；
- 若引入本地 embedding 模型，保持"向量可替换、接口不变"。
