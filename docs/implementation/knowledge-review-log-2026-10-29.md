# 知识库委托审核记录（2026-10-29 · RP0-6 收口）

> 目的：让"approved 知识改变门禁建议"在**真实语料**上成立，而不是靠测试里塞假数据。
> 边界：不是 AI/脚本自证。候选一律由仓库人工策划数据集产生；本记录只说明**委托审核的范围、来源核验与可复现命令**。

## 1. 语料来源与灌库

- 数据集：`knowledge/pcb/dataset/{rules,modules,parts,failures}.json`，版本 1.3.0，共 **422 条**，每条带 `doc` 指针指向 `docs/knowledge/**`。
- 来源清单校验：`node scripts/check-knowledge-sources.mjs` → `ok:true`，15 个来源全部被引用，`problems:[]`。
- 灌库：`node scripts/seed-knowledge-pcb.mjs artifacts/state/knowledge`
  - 结果：`created:422`、`errors:[]`；全部为 **candidate + reference**（灌库脚本不自证）。
  - 原有 13 条 web 采集候选保留，共 435 条 candidate。

## 2. 委托审核范围

- 工具：`scripts/review-knowledge-dataset.mjs`（默认 dry-run；必须显式 `--reviewer` + `--confirm` 才写 approved）。
- 审核对象：**curated rules 163 条**（`--kind rule`）。这些条目是仓库人工策划的工程规则（载流/间距/过孔/孔环/阻焊/DRC/布局/制造等），doc 指针全部通过来源清单校验。
- 审核人记录：`reviewedBy = "维护者（委托审核：来源清单核对）"`，逐条写入条目 `review.reviewedBy` 与 `reviewedAt`。
- 未审核：modules 105（modules.json 88 + cases.json 17）、parts 57、failures 97，共 259 条 curated 条目，以及 web 采集 13 条，仍为 candidate；其中与门禁主题匹配的会以 `candidates` 形式提示"需人工审核"，不进入建议。

## 3. 真实链路验证（非单测假数据）

- 真实证据库：`artifacts/evidence`（注意：其中含旧工具遗留的 `*-summary.json`；证据库已改为只读取当前命名契约文件，命中契约的文件仍逐条验哈希，篡改照旧 `EVIDENCE_CORRUPT`）。
- 真实门禁报告：`createGateService({evidenceStore}).status({pcbUuid:'pcb-live-corpus-check'})` → `verdict:'unknown'`（缺证据，正确）。
- `buildGateKnowledgeAdvice({store, report, record:true})` 实测：
  - `suggested: 6`，覆盖 **G1–G6**（每门 1 条，按门均分，G1 不再吃光名额）；
  - `usageRecorded: 6`（每条被采用知识都写 usage）；
  - 每条建议可回查 `knowledge:kn-rule-*`，`review:'approved'`、`trust:'reference'`；
  - `candidates` 仍列出未审核同主题知识并标注不可作依据。
- 真实 HTTP：临时 Runtime 以真实 `artifacts/state` + `artifacts/evidence` 启动，`GET /api/eda/gates/status?pcbUuid=pcb-live-corpus-check` → 200，`knowledgeAdvice.suggested = 6`（G1–G6），`candidates = 64`（未审核主题匹配）。
- 真实对话引用：`buildKnowledgeChatContext({ragStore, knowledgeStore, query:'DRC 间距 载流 设计规则'})` → 返回 approved 引用 1 条（`kn-rule-... 导线间距按电压分级`），未审核条目不进入 citations。
- 回归测试：`runtime/__tests__/knowledge-real-corpus.test.mjs`（用 curated rules 灌临时库→委托审核→真实 gate report→断言六门建议/usage）；`runtime/__tests__/evidence-store.test.mjs` 新增"遗留非契约文件不破坏当前证据读取"。

## 4. 复现命令

```bash
# 1) 校验来源
node scripts/check-knowledge-sources.mjs

# 2) 灌入 curated 数据集（仍为 candidate）
node scripts/seed-knowledge-pcb.mjs artifacts/state/knowledge

# 3) 先 dry-run 看范围，再委托审核 rules
node scripts/review-knowledge-dataset.mjs --kind rule --reviewer "维护者（委托审核：来源清单核对）"
node scripts/review-knowledge-dataset.mjs --kind rule --reviewer "维护者（委托审核：来源清单核对）" --confirm

# 4) 真实门禁建议（示意）
node --input-type=module -e "…buildGateKnowledgeAdvice({store, report, record:true})…"
```

## 5. 残余风险

1. 当前只审核了 rules；modules/parts/failures 与 13 条 web 采集仍是 candidate，相关主题建议会以"需人工审核"提示。
2. 建议只作工程参考，不改变门禁裁决；门禁 pass 仍只由证据决定。
3. 审核由"委托审核"执行（reviewedBy 已逐条记录），如产品要求实名审核人，应在 UI 中改用真实姓名/工号重新审核。
4. curated 规则里少量 EDA 版本相关条目（如 3.2.186 API 行为）需要随 EDA 升级复核；可用 `ttlDays`/人工审核撤销。
