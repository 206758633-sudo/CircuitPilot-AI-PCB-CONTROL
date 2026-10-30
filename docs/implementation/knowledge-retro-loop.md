# 知识库 Agent 分工与复盘回路（W5-01）

> 一句话结论：知识库里的"Agent"不是一个万能助手，而是**各管一段、谁都不许自己发合格证**的流水线。
> 新增的 **RLA 复盘学习 Agent** 只负责把"项目做完才知道的事"变成 candidate；去重/冲突/过期由 **KMA** 维护，
> 能不能进门禁仍由 **人工审核** 决定。

## 1. 现有 Agent 职责（审计结论）

知识库相关能力分成四层：**写入层 → 整理层 → 审核层 → 使用层**。没有任何一层可以跨层自证。

| Agent / 模块 | 层 | 职责 | 输入 | 输出 | 硬边界 |
|---|---|---|---|---|---|
| `agents/knowledge-manager.mjs`（KMA） | 写入 + 整理 | ① badcase 入库：扫证据目录里 `blocked/unknown` 的证据，按"证据类型+缺陷码"归并成 failure 候选；② 网页知识采集；③ 定期维护：健康度/过期/待审积压/approved 冲突/陈旧候选 | 证据目录 JSON、白名单网页采集器 | candidate 知识条目、维护报告（可落证据） | 只写 candidate，绝不自动 `approved`；配额上限；同内容幂等；不写 EDA |
| `agents/retrospective-learner.mjs`（**RLA，本轮新增**） | 写入 | 项目收尾复盘：读交付/门禁/缺陷/变更事实，把"事实"映射成 failure，把"人的判断"映射成 failure/rule/module，另生成 1 条项目复盘 module；落 `retrospective` 证据 | 各类证据最新一条、release 归档结果、changes、可选的 `lessons[]`（人/AI） | `retrospective` 证据 + candidate（failure/rule/module） | 只写 candidate；没有事实就失败；无根因标 `needsInvestigation`，不编造原因；payload 不含时间戳（幂等）；不写 EDA |
| `agents/field-loop.mjs`（Field Loop） | 写入 | 样机/产测问题 → 结构化问题单 → 回归用例 → failure 候选 | `field-issue`（症状+根因+证据） | `field-issue` 证据 + failure 候选 | 无根因拒绝生成回归用例；只写 candidate |
| `agents/librarian.mjs`（Librarian） | 使用（核验） | 器件身份三源核验（EDA 库/供应商/datasheet），只出证据 | 器件身份数据 | `lib-evidence`（pass/blocked + findings） | 只读；缺数据 = blocked，不是"通过" |
| `agents/netlist-auditor.mjs`（Netlist Auditor） | 使用（核验） | 意图网表 vs EDA 实际网表逐引脚 diff | 规格网表 + EDA 实际网表 | `netlist-diff` 证据 | 输入缺失/格式不认识 → 抛错，绝不返回 pass |
| `agents/rule-runner.mjs`（Rule Runner） | 使用（核验） | 归一化 ERC/DRC 报告 + 豁免，产出可阻断证据 | 已获取的 ERC/DRC 报告 + 豁免清单 | `rules` 证据 | 只做归一化，不重写规则引擎；缺报告 = unknown |
| `agents/orchestrator.mjs`（Orchestrator） | 编排 | 按"器件→网表→规则"跑步骤、附 RAG 检索与知识引用，最后交门禁裁决 | design-spec + 步骤 + 知识库 + RAG | 证据信封数组 + 门禁裁决 | 不掌握放行权；任一失败 → unknown（fail-closed）；引用无效整份证据作废 |
| `agents/knowledge-citations.mjs`（引用核验） | 使用（约束） | Agent 引用 `knowledgeId` 前逐条核验：存在、approved、未过期 | 证据里的 citations | 校验后的 citations | 任一不满足 → 引用无效、证据作废 |
| `knowledge-pipeline.mjs`（加工管道） | 整理 | 采集器结果 → 合规标注 → 入库去重 → 冲突/审核队列 → 健康度 | collector 输出 | 去重统计、`buildReviewQueue`、`healthMetrics` | candidate ≠ approved；参考工程只能当基准 |
| `knowledge-scheduler.mjs`（KMA 调度） | 整理 | 把 badcase 采集/网页抓取/定期维护挂到定时器（默认 24h），状态落 `state/knowledge-agent.json` | KMA manager | 调度状态/历史 | 同一时刻只允许一轮；失败只记录不拖垮 Runtime |
| RAG（`rag/*`） | 使用 | 知识条目 + 工程文档混合索引（BM25 + 特征哈希向量），给检索/引用提供依据 | 知识库 + `docs/` | `RagStatus` / hits | 只提供依据，不构成放行 |
| 人工审核（UI「审核队列」） | 审核 | `candidate → approved/rejected`，审核人必填 | 审核队列 | 审核结论（reviewedBy/reviewedAt） | 只有 approved + 未过期 + trust 达标才可被门禁引用 |

> 另有一套与知识库无关的 **Agent 控制面**（`runtime/agent-token.mjs`、`apps` 侧 DSH 插件、`agent/mcp-server.mjs`），
> 它负责"谁能调 Runtime 写设计"，不参与知识入库；两者不要混为一谈。

## 2. 配合逻辑：两条闭环，共用一个"审核闸门"

```
证据闭环（已有的）
  ERC/DRC/网表/器件核验/门禁 ──证据──▶ KMA badcase 归并 ──candidate──▶ 审核队列 ──approved──▶ 门禁引用 / RAG

复盘闭环（本轮新增）
  交付归档 / 人工触发 ──事实+经验──▶ RLA ──candidate──▶ KMA maintain（去重/冲突/过期/积压） ──▶ 审核队列 ──approved──▶ RAG / 下个项目复用
```

关键顺序（不可颠倒）：

1. **采集只读**：KMA/Field Loop/RLA 都只读证据与输入，不写 EDA、不改设计；
2. **先证据后知识**：RLA 必须先有 `retrospective` 证据（事实快照），知识候选才允许写入；证据写失败 → 整轮失败（`RETRO_EVIDENCE_WRITE_FAILED`），不写"无出处的经验"；
3. **写入只到 candidate**：所有 Agent 的 `reviewState` 固定 `candidate`，`trust` 最高 `reference`；
4. **整理归 KMA**：去重靠 store 的 `entityKey + fingerprint`（同内容不新增版本），冲突/过期/积压靠 `knowledge-pipeline.mjs` 的队列与健康度；
5. **审核归人**：`candidate → approved` 必须 `reviewedBy`；`knowledge-citations` 在编排层再核一遍（存在/approved/未过期）；
6. **使用 fail-closed**：门禁只认 approved + 未过期 + trust 达标的引用；缺证据一律 unknown。

## 3. RLA 合同（`agents/retrospective-learner.mjs`）

### 3.1 输入

| 字段 | 必填 | 说明 |
|---|---|---|
| `projectId` / `boardId` / `pcbUuid` | 至少一个（否则 key=`unspecified`） | 用于生成稳定 id：`RETRO-<key>-*` |
| `evidence[]` | 否 | `{kind, digest, savedAt, fingerprint, payload}`；只认 `rules`/`drc-report`/`dfm-evidence`/`netlist-diff`/`placement`/`field-issue`/`gate-report`/`fabrication-release` |
| `release` / `gates` / `changes` / `notes` / `docRefs` | 否 | 交付结论、门禁裁决、收尾变更、复盘正文、关联文档 |
| `lessons[]` | 否 | 人或 AI 提交的经验；`kind` 只能是 `failure`/`rule`/`module`，见 3.2；`origin='ai'` 的条目按 `trust=unverified` 入库 |

### 3.2 经验（lessons）最小字段

| kind | 必须 | 说明 |
|---|---|---|
| `failure` | `title`、`symptom` | `rootCause` 可空；空则条目带 `needsInvestigation=true`，不编造 |
| `rule` | `title`、`statement`、`limits[]`（≥1 条数值边界） | 没有数值边界只能当 failure/module 沉淀 |
| `module` | `title`、`purpose`、`designPoints[]`（≥1 条） | 可复用做法/设计模式 |

### 3.2.1 AI 起草经验（`POST /api/knowledge/retro/draft`）

- 复用 `ChatManager.generate()`（与对话同一套后端解析/密钥/超时/错误码），把事实 JSON 交给模型起草 1~6 条经验；
- 模型输出**不直接入库**：先过 `normalizeLessons`（缺 symptom/limits/designPoints 的条目被丢弃并列入 `problems`），再由人决定是否点「运行项目复盘」；
- 写入时 `origin='ai'` → `trust='unverified'`，`provenance.collector=retrospective-learner`；即使审核通过，也是"参考经验"而非标准结论；
- 未配置 API Key/Provider 时返回 `PROVIDER_CREDENTIAL_MISSING`（503），不降级为编造内容。

### 3.2.2 跨项目合并（`POST /api/knowledge/retro/merge`）

- 扫描所有 `kind=failure` 且 `payload.source='retrospective'`、带 `code` 与 `projectKey` 的候选，按缺陷码聚合；
- **≥2 个不同项目**才生成一条 `failure`（`failureId=RETRO-CODE-<CODE>`），payload 带 `projectKeys[]`、总 `occurrences`、合并后的 `evidenceRefs`；
- `rootCause` 恒为 `null`、`needsInvestigation=true`——合并只提示"这是复发性问题"，不替人下结论；
- 幂等：同输入重复运行 `created=0`；写入仍为 `candidate`。

### 3.2.2 经验包导出（`POST /api/knowledge/retro/export`）

- 无云端服务器时的"经验回流"最小通道：只生成**脱敏 JSON**，由用户自己通过 GitHub Issue / 邮件 / 共享盘提交；
- 默认脱敏：项目/板号/PCB UUID 只给 `sha256` 前 12 位、缺陷 message 丢弃、路径/邮箱/密钥走 `redactSecrets`、不含工程文件字节；
- 包内 `bundleSha256`（canonical JSON）供维护者校验内容未被改动；服务端**不落盘、不上传、不写知识库**；
- 与 `provider-egress` 合同一致：per-action、用户可预览、可拒绝；详见 [ota-and-experience-loop.md](ota-and-experience-loop.md) §4.2。

### 3.3 输出

- **1 份 `retrospective` 证据**：`verdict='advisory'`，含事实快照（证据 digest、缺陷、交付、门禁、变更）、经验清单、候选清单、运行时间；
- **N 条 candidate**：
  - 每类 error 级缺陷 → `failure`（`failureId=RETRO-<key>-<CODE>`，聚合证据 digest，`needsInvestigation=true`）；
  - `lessons` → `failure` / `rule`（`RETRO-<key>-R01…`）/ `module`（`RETRO-<key>-M01…`）；
  - 另有 1 条项目复盘 `module`（`RETRO-<key>-PROJECT`），把交付/门禁/变更/缺陷串成可迁移案例。

### 3.4 红线

- 没有事实也没有经验 → `RETRO_NO_EVIDENCE`（409），不生成空复盘；
- `lessons` 任一条不合法 → `RETRO_LESSON_INVALID`（400），**整轮不写**（不允许半套候选）；
- 候选 payload 不含时间戳/运行计数 → 重复运行 `created=0, duplicates=N`；
- 只写 candidate，`never` 列表显式声明：不 approved、不写 EDA/设计。

## 4. 接入点

| 位置 | 行为 |
|---|---|
| `GET /api/knowledge/retro/status` | RLA 状态：上次运行、累计新增、证据/经验类型白名单 |
| `POST /api/knowledge/retro/run` | 手动复盘：默认自动采集各类证据最新一条；可传 `lessons/changes/notes/docRefs`；`includeEvidence=false` 可关闭自动采集；成功后自动调用 KMA `maintain()` 做一轮整理，返回 `maintenance`（待审/冲突/过期/陈旧候选），并跑一次跨项目合并返回 `merged` |
| `POST /api/knowledge/retro/draft` | AI 起草经验：只回草案（`lessons` + `problems` + `provider/model`），不写库；无事实 → 409，Provider 未配置 → 503 |
| `POST /api/knowledge/retro/export` | 导出经验包：默认只读、脱敏、不落盘；返回 `bundle` + `preview`（sha256/字节数/脱敏策略）；无内容 → 409 |
| `POST /api/knowledge/retro/merge` | 跨项目合并：按缺陷码聚合 ≥2 个项目的 failure 候选，写 candidate，返回 `groups/created/duplicates/candidates` |
| `POST /api/production/releases/archive` | 交付归档成功后**自动**跑一次复盘（`CIRCUITPILOT_RETRO_AUTO=off` 可关）；归档是事实，复盘失败不回滚，只写 `result.retro` |
| 前端「知识库 → 概览 → 复盘学习 Agent（RLA）」 | 状态卡 + 「运行项目复盘」按钮；结果明示"只产 candidate，整理/审核仍由 KMA + 人工完成" |

## 5. 验证

| 测试 | 覆盖 |
|---|---|
| `runtime/__tests__/retrospective-learner.test.mjs`（13 组） | 缺陷归并去重、经验字段校验、候选 id 确定性/幂等、无事实失败、只写 candidate、不可用于门禁、非法经验不写半套、warning 不算事实、能力边界声明、AI 经验 `unverified`、起草提示词约束、跨项目合并与幂等、经验包默认脱敏与哈希稳定 |
| `runtime/__tests__/knowledge-retro-http.test.mjs`（7 组） | HTTP 契约：状态/无事实 409/只有经验也接受且 KMA 待审计数/非法经验 400 且不写半套/AI 草案只回不回写且过滤非法字段/合并空数据 0 组 |
| `runtime/__tests__/evidence-store.test.mjs` | `retrospective` 证据类型可落盘/可按 fingerprint 读回 |
| `runtime/__tests__/route-contract.test.mjs` | 新路由有真实消费者（client 方法 + 知识库页按钮），无孤儿路由 |
| `src/pages/__tests__/verification-knowledge-smoke.test.tsx` | RLA 面板入口与边界文案 |

### 5.1 真机实跑（DBTS-A01，2026-10-29 17:45）

对真实工程（`artifacts/state/knowledge` + `artifacts/evidence`）跑了一次完整复盘：

| 项 | 结果 |
|---|---|
| 证据 | `rules` / `drc-report` / `netlist-diff` 最新各一条：4 条 error 缺陷 + 84 warning |
| 候选 | **9 条**：1 项目复盘 module、6 failure（4 条证据归并 + 2 条人工经验）、1 rule、1 module，全部 `candidate` |
| 证据落盘 | `artifacts/evidence/retrospective/retrospective-2026-10-29T09-45-40-297Z-…json`（`verdict=advisory`） |
| 幂等 | 同输入重跑 `created=0, duplicates=9`，知识库总数不变 |
| 跨项目合并 | 单项目 `groups=0`（规则要求 ≥2 个项目）；多项目场景由单测覆盖 |
| 审核队列 | `buildReviewQueue()` 的 281 条候选中含这 9 条 `RETRO-*` |

## 6. 边界与后续（不假装已完成）

1. **AI 起草已接但仍是草案**：`POST /api/knowledge/retro/draft` 用已配置的模型起草经验，产出先过字段校验、再以 `unverified` 入库；模型不能直接 approved，也不会绕过人工审核。未配置 Provider 时明确失败，不伪造。
2. **项目完成信号**目前取"交付归档成功"；未归档的项目需要通过 UI 手动触发（或后续在项目状态机增加 `closed` 事件）。
3. **跨项目聚合只做"提示"**：按缺陷码把 ≥2 个项目的 failure 聚合成一条候选（`RETRO-CODE-*`），但不会自动提升为通用规则——规则需要数值边界，必须人工在审核队列里补。
4. **审核仍是瓶颈**：RLA 会提高候选量；`知识库 → 审核队列` 的"待审积压"健康度指标是观察点，后续可按 evidenceDigest 去重、按缺陷码合并。
