# 知识库关联图（只做有增量的部分）

日期：2026-11-02  
范围：`docs/knowledge`、`knowledge/pcb/dataset`  
结论：**不引入第二套 Wiki 正文，只增加从现有知识派生的关联图。**

## 1. 为什么只做图

对“是否引入 LLM Wiki”的评估结论是：

- 当前瓶颈是 442 条 candidate、0 条 approved，以及检索/审核，不是缺少 Wiki 页面；
- 再建一套 Wiki 正文会形成“文档 + 结构化条目 + Wiki”三份内容，增加漂移和审核负担；
- 现有知识库已经具备索引、条目对偶、来源校验、冲突登记和审核状态机，直接替换风险大于收益；
- 真正有增量的部分是**互链/导航/来源覆盖可见性**，因此只把已有关系抽成派生图。

## 2. 产物

| 产物 | 作用 |
|---|---|
| `knowledge/pcb/dataset/graph.json` | 机器可读节点/边；供 Agent/RAG 做相邻扩展，不作为“已验证知识”依据 |
| `docs/knowledge/KNOWLEDGE-GRAPH.md` | 人可读报告：领域连接、文档枢纽、KP 枢纽、孤岛、互链缺口、来源覆盖 |
| `scripts/build-knowledge-graph.mjs` | 生成器；只读，不写正文、不改审核状态、不联网 |

节点 ID 约定：

- `doc:<相对路径>`
- `kp:<KP-ID>`
- `entry:<kind>:<ID>`
- `source:<SRC-ID>`

边类型：`DOC_HAS_KP`、`DOC_HAS_ENTRY`、`DOC_LINKS`、`DOC_REFERENCES_KP`、`DOC_REFERENCES_ENTRY`、`ENTRY_SOURCE`、`ENTRY_REFERENCES_ENTRY`、`ENTRY_REFERENCES_KP`。

## 3. 当前图数据

| 指标 | 数量 |
|---|---:|
| 文档 | 70 |
| 知识点 | 1,037 |
| 结构化条目 | 442 |
| 来源 | 26 |
| 节点 / 边 | 1,575 / 2,507 |
| 跨文档 KP 引用 | 80 |
| 跨文档条目引用 | 537 |
| 孤岛 KP | 948 |
| 无跨文档连接文档 | 31 |
| 无来源条目 | 380 |

说明：“孤岛 KP”指没有被其他文档、结构化条目或来源引用的 KP，不等于错误；它用于生成维护清单，避免把“独立概念”误判成“漏整理”。无来源条目多数是内部规则，不批量伪造来源。

## 4. 使用

```bash
npm run knowledge:graph        # 重新生成
npm run knowledge:graph:check  # 校验生成物是否最新
```

任何文档、KP、结构化条目或来源变化后，需要重新生成；`runtime/__tests__/knowledge-graph.test.mjs` 会在运行时测试中执行 `--check`。

## 5. 验证记录

- `npm run knowledge:graph`：成功；70 文档 / 1,037 KP / 442 条目 / 26 来源。
- `npm run knowledge:graph:check`：通过（`KNOWLEDGE_GRAPH_CURRENT`）。
- `node --test runtime/__tests__/knowledge-graph.test.mjs`：4/4 通过（同步、无悬空边、Markdown 链接可解析、RAG 排除导航/派生图）。
- `npm run knowledge:index:check`：仍需通过；图不替代索引。
- `npm run verify:rag`：仍需通过；`KNOWLEDGE-INDEX.md` 与 `KNOWLEDGE-GRAPH.md` 都不进入 RAG 正文。
- 未改知识正文、未改审核状态、未新增 approved 条目。

## 6. 边界与后续

- 图是**派生索引**，不是知识权威来源；不能因为图里有边就认为知识已审核。
- 图不改变门禁：仍只认 `approved + 未过期 + trust 合格` 的结构化条目。
- 下一步若要用图提升检索，应先在更难的多跳/引用评测集上做 A/B；没有可测提升就不扩大。
- 原始来源快照（`raw/`）是另一项独立的高价值工作，涉及版权、存储和抓取合规，未在本增量中引入。
