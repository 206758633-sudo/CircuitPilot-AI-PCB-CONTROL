# 04 平台链闭环审计（只读 · 2026-11-05）

- 审计对象：`/Users/jescochen/Desktop/AI- PCBA`，基线 **HEAD `98429be`**（审计开始时 git 干净；typecheck ✓ / vitest 228/228 / runtime 1455/1455 为既有基线）。
- 范围：运行时状态 Store（`artifacts/state/*`、`~/.circuitpilot`、`appDataDir`）→ 知识库/RAG/门禁建议/usage → 联网研究与外发告知 → Supervisor 值守队列 → Agent 令牌/审计锚点/归档 → 扩展市场/DSH plugin → 备份/诊断/长跑。
- 只读声明：未改任何源码/配置/状态 Store；唯一有意写入为本文件。未联网外发，未触 EDA/Bridge 写，未启动/重启固定端口（4177/4178），未跑 acceptance/live e2e/Playwright。**如实披露**：运行只读 demo `node scripts/ext-market-demo.mjs --snapshot artifacts/ext-market/installed-extensions.json` 时，该脚本按其既有行为重写了未跟踪证据文件 `artifacts/ext-market/capability-board.json` 与 `prompt-snippet.txt`（同输入再生成，未跟踪、无产品消费者，未改源码/git 跟踪内容）。
- 方法：逐文件读代码 + 只读数据扫描（`artifacts/state`、`~/.circuitpilot`、安装目录 state）+ **隔离 `node --test`**（临时 `CIRCUITPILOT_STATE_DIR`）+ 4 个隔离/只读探针 + 1 次锚点 verify（临时目录 + 随机端口，fake/无 bridge，不接触真实 EDA 与外部网络）。
- 判定：✅ 已闭环（读写者/展示面/失败语义齐）｜🟨 半闭环（口径/入口/失败语义缺一）｜🟥 断点或失真｜⬜ 纸面/无产品入口｜🚫 产品边界。
- **基线漂移提示**：审计期间工作树出现并发修复（已见 `runtime/server.mjs`、`runtime/__tests__/route-contract.test.mjs`、`plugin/dsh-circuitpilot/test/package.test.mjs` 等被改，另有链路修复落地）。本报告所有 `file:line` 以 **HEAD `98429be`** 为准（与其他 01/02/03/05 报告同基线）；`server.mjs` 路由段在当前工作树约偏移 +55~+85 行，复查时以 `git show HEAD:runtime/server.mjs` 为准。

---

## ① 结论摘要

**一句话**：平台链的“持久工单 / 知识门禁 / Agent 审计”主体已真实闭环（读写者、UI 展示面、回归测试都在），**未发现 P0**；但“损坏/读失败的展示与写回语义”“RAG 索引失效边界”“联网开关不是外发门禁 + 外发清单不全”“Supervisor 单源不可用被静默降级”构成 **6 项 P1**，另有 12 项 P2。

| 级别 | 计数 | 主题 |
|---|---|---|
| **P0** | **0** | 未发现“安全叙事失真/假成功/权威状态被静默改写”的平台链结构性断点（逐项见 §①正面结论） |
| **P1** | **6** | ①知识库损坏 → 门禁建议伪装“没有知识” ②RAG 不随离线写入/文档变更失效（真实 state 已有 9 条漏索引）③状态读失败被 UI 吞掉且启动写回会覆盖损坏文件 ④联网开关不约束外发（2 个 UI 入口 + Agent token + env 覆盖可绕过）⑤G4 外发清单漏 5 类真实外发点，且“测试断言路由集合”并不存在 ⑥Supervisor 的 plan 源不可用被静默省略 |
| **P2** | **12** | 见 §③.2（usage 无 UI、blocked 状态不可达、KMA 调度状态可伪造、多状态根备份缺口、job journal 无轮转、对话引用不记 usage、账本降级继续签发、路由契约把测试当消费者、锚点语义/自动验收缺失、扩展市场纸面、plugin 运行态不可用、诊断包未含平台键状态） |

**已确认闭环（正面结论，避免只报问题）**

1. **状态 Store 无纯死存储**：逐项核对 26 类持久面（§2.1），全部有真实读取者；其中 23 类有 UI 展示面（含间接展示），3 类为纯内部消费者（`knowledge/usage` 无产品 UI、`production.json` 无列表路由、`eda-jobs.jsonl` 仅启动恢复读取）。
2. **Supervisor 生命周期真闭环**：official-only 过滤、fingerprint 去重、ack/dismiss/resolve、done 源仍失败自动重开、明确 pass/resolved/approved 自动收口、30s `unref` 扫描、Agent 改工单 403、Store 损坏 503。真实 state 4 工单与 `issue-state` 2 条 open 一致（`artifacts/state/supervisor-tickets.json`）。
3. **知识 approved→门禁建议→usage 真实非空**：真实语料 163 条 approved，用真实 `gateService.status()` 只读计算得 **6 条建议覆盖 G1–G6**、73 条同主题 candidate 被排除；`gates-p05-http` 3/3 覆盖“candidate 不进建议 → 审核后进入 → GET 不写 usage → evaluate 写 usage”。
4. **对话 citations 真接线**：`server.mjs:4685-4696` → `knowledge-chat.mjs` → `chat.mjs:238` → `AiTasksPage.tsx:363-364`，真实语料抽测可命中 approved、candidate 被过滤。
5. **写门禁损坏 fail-closed**：`write-gate.mjs:45-92` 损坏时 `paused:true` + `loadError`，写路由 409；回归 26/26（含 corrupt-file、跨进程重启、session 作用域）。
6. **Agent 身份/审计可验证**：令牌 0600 + 常量时间比较 + 非法 fail-closed；HMAC 审计链 + head 锚点能检测改写/删行/换序/尾部删除/整文件删除；**本轮真跑 `verify-anchor` exit 0**（锚点签名有效、`currentMatches=false` 如实报告），`.app` 归档 create/verify 9/9。
7. **字段语义务实**：Supervisor 对 Agent 只读、对“源状态消失”不擅自收口；`design/pcb` 执行记录损坏有 `persistenceError` UI 横幅；诊断包脱敏/有界/缺段如实。

---

## ② 闭环矩阵

### 2.1 运行时状态 Store 全量核对（写者 / 读者 / UI 展示面 / 失败语义）

> 判定口径：✅ = 写者有、读取者真实存在（HTTP/内部）、UI 或明确内部消费者可达、损坏语义不伪装；🟨 = 读取/展示/失败语义缺一；⬜ = 无产品展示面。

| # | Store（路径） | 写入者（file:line） | 读取者 | UI 展示面（file:line） | 损坏/读失败语义 | 判定 |
|---|---|---|---|---|---|---|
| 1 | `project-state.json` | `server.mjs:510,1973-1979` | `GET /api/project-state`；AppContext hydrate | 项目/需求/器件/资料页（`AppContext.tsx:286-336,472-495`） | 抛 `STORE_CORRUPT`→400 明确码；**UI 仅 logger.warn 且会写回覆盖** | 🟨（P1-3） |
| 2 | `project-states/<id>.json` | `server.mjs:512,2000-2007` | `GET/PUT /api/projects/:id/state`；项目切换；门禁 G2 读器件 | 项目切换（`AppContext.tsx:414-495`） | 项目文件损坏→400；聚合损坏被 `try/catch` 吞成 404→UI 当“新项目”清空工作集（`project-state.mjs:196`） | 🟨（P1-3） |
| 3 | `trace-state.json` | `server.mjs:514,1966-1972` | `GET /api/trace-state`；诊断包 | 版本/修改/审计（`VersionsPage`，`AppContext.tsx:499-547`） | 400 `STORE_CORRUPT`；UI 吞读错后写回覆盖 | 🟨（P1-3） |
| 4 | `issue-state.json` | `server.mjs:516,1930-1936` | `GET /api/issue-state`；Supervisor 源 | 问题中心（`VersionsPage.tsx:173-176`） | 同上 | 🟨（P1-3） |
| 5 | `validation-state.json` | `server.mjs:518,1937-1946` | `GET /api/validation-state`；Supervisor 源；KPI | 验证页/KPI（`ValidationPage.tsx:316-333`） | 400；读失败吞，`validationReadyRef` 在读失败后仍置 true → 写回覆盖（`AppContext.tsx:371-384`） | 🟨（P1-3） |
| 6 | `write-gate.json` | `server.mjs:505,1907-1920` | 所有写路由前置门禁 | 设置页开关/TopBar 徽标（`AppContext.tsx:341-355`） | **损坏→paused:true+loadError，写路由 409（fail-closed）** | ✅ |
| 7 | `research-config.json` | `server.mjs:507,2387-2393` | `/api/research/config|status`；KMA 调度 | 设置页联网开关（`SettingsPage.tsx:77-124,423-465`） | 损坏→enabled:false+loadError（保守方向） | ✅（消费者边界见 P1-4） |
| 8 | `supervisor-tickets.json` | `server.mjs:521-537,1947-1965` | `/api/supervisor/attention|tickets` | 概览页值守队列（`OverviewPage.tsx:164`；30s 轮询 `SupervisorPanel.tsx:19,90`） | **损坏→启动禁用、路由 503** | ✅ |
| 9 | `approvals-ledger.json` | `server.mjs:571-579` | `/api/approvals/ledger`、批准链 | Agent 页账本徽标（`AgentAccessPanel.tsx:291,516-540`） | 损坏→降级内存 + `loadError` UI 提示、链从 GENESIS 重记 | 🟨（P2-9） |
| 10 | `agent-plan-requests.json` | `server.mjs:489-503,1775-1841` | `/api/agent/plan-requests*`、Supervisor plan 源 | Agent 页计划请求（`AgentAccessPanel.tsx:407-470`） | 路由 503 `PLAN_REQUEST_STORE_UNAVAILABLE`；**Supervisor 侧静默省略** | ✅/🟥（P1-6） |
| 11 | `knowledge/<kind>/*.json`（真实 444 条） | `knowledge.mjs:248-264,383-451` | `knowledge-api`；门禁建议；RAG 语料；健康/审核队列 | 知识页（`KnowledgePage.tsx`） | 条目损坏→400 `KNOWLEDGE_CORRUPT`（entries/health 诚实）；**门禁建议吞错→200 空建议** | 🟥（P1-1） |
| 12 | `knowledge/usage.jsonl` | `knowledge.mjs:529-553` | `listUsages`（health hitRate、`GET /usage`） | **无产品 UI**（仅健康度“命中率”间接展示，`KnowledgePage.tsx:244`） | 读损坏→`KNOWLEDGE_CORRUPT`；写失败抛出但建议侧仅计数 | ⬜（P2-1） |
| 13 | `knowledge-agent.json` | `knowledge-scheduler.mjs:57-101` | `GET /api/knowledge/agent/status` | 知识页 KMA 面板（`KnowledgePage.tsx:251-272`） | 损坏→`corruptState` 标记 + 重置模板；**UI 不显示该标记** | 🟨（P2-4） |
| 14 | `rag/index.json`（真实 582 docs/4129 chunks/28MB） | `rag/store.mjs:37-55,106-116` | `/api/rag/status|query`；对话 citations | 知识页 RAG 面板（`KnowledgePage.tsx:318-323`） | 损坏/版本不符→`loadError`+自动重建；重建失败保留旧索引并暴露错误 | 🟨（P1-2） |
| 15 | `custom-providers.json` | `server.mjs:590-612,2406+` | `/api/providers`；Provider 调用 | 自定义 Provider 编辑器（`CustomProviderEditor.tsx`） | 损坏→读降级内存 + 写 503；**`runtimeClient.providers()` 丢弃 degraded 字段**（`runtimeClient.ts:479-482` vs `server.mjs:2404`） | 🟨（P2-9） |
| 16 | `chat-transcripts.json` | `server.mjs:613-621` | transcript 路由/重启重建线程 | AI 页恢复消息（`AiTasksPage`） | 损坏→降级内存，仅日志，UI 无提示 | 🟨（P2-9） |
| 17 | `design-executions.json` | `server.mjs:622-630` | `/api/design/executions` | EDA 页执行历史（`EdaPage.tsx:552-563,763`） | 损坏→降级内存 + `persistenceError` 横幅 | ✅ |
| 18 | `pcb-executions.json` | `server.mjs:631-638` | `/api/pcb/executions` | 资产/验证/EDA 页 | 同上 | ✅ |
| 19 | `production.json` | `server.mjs:742-757` | readiness/finalReview 内部读（构造时 load）；**无列表 GET** | 无直接列表（靠 readiness 报错） | 损坏→降级内存仅日志，UI 无提示 | 🟨（P2-9） |
| 20 | `agent-audit.jsonl` + `head` + `key` | `agent-console.mjs:604-720` | `/api/agent/status|audit`；CLI 归档/锚点 | Agent 页链校验徽标（`AgentAccessPanel.tsx:286-291,363-372`） | 坏行/尾部删除/head 不一致→`broken` 如实上报，append 拒绝 | ✅ |
| 21 | `agent-token.json`（appDataDir） | `agent-token.mjs:60+` | Agent 认证、`/api/agent/status` | Agent 页令牌状态/轮换 | 非法 JSON/权限过宽→`AGENT_TOKEN_INVALID` fail-closed | ✅ |
| 22 | `automation-runs/*.jsonl`（`~/.circuitpilot`，真实 3029 文件/12MB） | `automation/journal.mjs` | 时间线、recovery、审计包 | 追溯页系统事件（`VersionsPage.tsx:236`） | 坏行进 `invalid`、哈希链校验 | ✅（无保留策略 P2-5） |
| 23 | `timeline-links.jsonl` | `server.mjs:2065-2080` | `/api/timeline`、runId 过滤 | 追溯页“关联到该运行”（`VersionsPage.tsx:236`） | 坏行 `invalid`、重复 409 | ✅ |
| 24 | `eda-jobs.jsonl`（appDataDir，真实 5.1MB） | `eda-job-journal.mjs:11-35` | `EdaJobStore.recover`（启动恢复） | 无 UI（内部恢复） | 只跳坏行；**无上限/无轮转** | 🟨（P2-6） |
| 25 | `pcb-write-lock.json`、`releases/` | `pcb.mjs:406+`、`release-archive.mjs` | `GET /api/pcb/write-lock`、`GET /api/production/releases` | EDA 页安全锁横幅、版本页归档列表 | 当前无文件=未触发（正常）；损坏按各自加载器报错 | ✅（本轮无文件） |
| 26 | `schematic-batches/*.json`、`drc-exemptions(.json)`、`last-project.json`（`~/.circuitpilot`） | `schematic-batch`/`drc.mjs`/`server.mjs:1061-1078` | 批量续跑内部状态；DRC/ERC 豁免 UI；EDA 重启自愈内部读取 | 验证页豁免编辑（`ValidationPage.tsx:625-770`） | 各自读取失败有明确路径；**状态根与 STATE_DIR 分裂** | 🟨（P2-5） |

**死存储结论**：无“只写不读”的 Store；但存在 **3 个“有存储/API、无产品展示或展示失真”**：`knowledge/usage.jsonl`（仅健康度间接 + 无按条 UI）、`custom-providers` 降级信息被前端丢弃、`knowledge-agent.json` 的 enabled/nextRunAt 可被手动运行写成“已排期”（§2.5/§3.2）。另有遗留物：`artifacts/state/eda-jobs.jsonl`（2026-10-20，当前代码已改写到 appDataDir，见 P2-7）。

### 2.2 损坏 / 读失败语义矩阵（是否 fail-closed、是否伪装空状态）

| 子系统 | 损坏/读失败行为 | HTTP/CLI 表现 | UI 是否可见 | 判定 |
|---|---|---|---|---|
| 写门禁 | 保守 `paused:true` + `loadError` | GET 200 带告警；写路由 409 | 设置页/徽标显示暂停（可恢复） | ✅ |
| Supervisor Store | 启动禁用 + 明确错误 | 所有 `/api/supervisor/*` 503 | 面板显示错误码 + 重试 | ✅ |
| Supervisor 源 history/issue | `SOURCE_UNAVAILABLE` 包装 | `/attention` 503 | 面板显示错误码 | ✅ |
| **Supervisor 源 plan（启动时已损坏）** | **`planRequestStore=null` → 按空数组扫描** | **`/attention` 200，无 degraded 字段** | 用户看不到“计划源不可用” | 🟥（P1-6，已用隔离 HTTP 探针复现） |
| project/trace/issue/validation 文件 | Store 抛 `STORE_CORRUPT`（不返回空态） | 400 + 明确 code（非 503） | 仅 console.warn；启动写回会覆盖损坏文件 | 🟨（P1-3） |
| knowledge 条目损坏 | `readKind` 抛 `KNOWLEDGE_CORRUPT` | entries/health 400；**门禁建议 200 + “没有 approved 知识”** | 用户以为“无知识”而非“知识库坏了” | 🟥（P1-1，已用隔离 HTTP 探针复现） |
| RAG 索引损坏 | `loadError` + 下次查询重建；重建失败保留旧索引并暴露错误 | `/api/rag/status` 200 带 loadError | 知识页横幅显示 | ✅ |
| custom-providers | 读降级内存（空列表），写 503 | 写路由 503 明确 | **列表显示为空（degraded 字段被客户端丢弃）** | 🟨（P2-9） |
| chat / production | 降级内存 + 日志 | 读接口正常（历史为空） | UI 无降级提示 | 🟨（P2-9） |
| approvals-ledger | 降级内存 + `loadError` | `/api/approvals/ledger` 带 loadError | 面板“批准账本读取降级” | 🟨（P2-9） |
| design/pcb 执行记录 | 降级内存 + `persistenceError` | GET 带 persistenceError | EDA 页黄色横幅 | ✅ |
| KMA 调度状态 | `corruptState=true` + 重置 | status 带 corruptState | **UI 不展示，显示“尚未运行”** | 🟨（P2-4） |
| Agent 审计 head | 不一致 → append 拒绝 / read `broken` | 200（带 integrity）+ 拒绝追加 | “审计链异常/未锚定”徽标 | ✅ |

### 2.3 知识 approved → 门禁建议 → usage；RAG revision；对话 citations

| # | 节点 | 判定 | 证据（file:line / 实测） |
|---|---|---|---|
| 1 | 采集/API/Agent 只能写 candidate | ✅ | `knowledge-api.mjs:53-63`；`runtime/__tests__/knowledge-api.test.mjs` |
| 2 | 审核必须 `reviewedBy`，只能 approved/rejected | ✅ | `knowledge.mjs:460-488`、`knowledge-api.mjs:65-73` |
| 3 | 门禁准入 = approved + trust 非 unverified + 未过期 | ✅ | `knowledge.mjs:490-497`；`knowledge-gate-advice.mjs:88,117-138` |
| 4 | 门禁 reason code → 语义标签（覆盖全部 7 个 `GATE_*`） | ✅ | `knowledge-gate-advice.mjs:26-34`；`gate-engine.mjs` |
| 5 | **真实语料下建议非空** | ✅ | 只读实测：`artifacts/state/knowledge` 444 条/163 approved；真实 `gateService.status({pcbUuid})` → `suggested=6` 覆盖 G1–G6；`candidates=73`（同主题未审核，未进建议）；`unusableSkipped=438` |
| 6 | candidate/过期排除 | ✅（过期语料缺失） | 探针：73 candidate 只进 `candidates` 不进 `suggested`；过期过滤单测通过；**真实语料 0 条过期**，未能在真实数据上验证（边界） |
| 7 | usage 只在“评估”写，GET 不写副作用 | ✅ | `server.mjs:2119-2199`（`record:false` vs 默认 true）；`gates-p05-http` 3/3 |
| 8 | usage 条数/失败透出前端 | 🟨 | 后端返回 `usageRecorded/usageSkipped/usageFailures/candidates`（`knowledge-gate-advice.mjs:165-175`），前端类型只到 `used/unusableSkipped`（`types.ts:1614-1621`），UI 不显示（`VerificationCenterPage.tsx:193-211`） |
| 9 | usage 产品可查“谁用过哪条” | ⬜ | `GET /api/knowledge/usage` 存在但 `runtimeClient.ts` 无方法、无页面；仅健康度 hitRate（`KnowledgePage.tsx:244`） |
| 10 | **RAG 随知识 revision 失效重建** | 🟥 | 见 P1-2；真实证据：`rag/index.json` builtAt `2026-10-29T04:13:20Z`（435 knowledge docs）vs 现有 444 条 → **9 条新增未进索引**；`corpusRevision=0` 与运行期 revision 0 相等→不重建 |
| 11 | RAG 随文档（docs/*.md）变化失效 | ⬜ | `corpusDigest` 只写不比对（`rag/index.mjs:45,85-86,156-189`）；`rag/store.mjs:71-75` 只比较 knowledge revision |
| 12 | 对话注入 approved citations | ✅ | `server.mjs:4685-4696`；`knowledge-chat.mjs:74-99`；`chat.mjs:238`；`AiTasksPage.tsx:363-364`；真实语料抽测 3 查询命中/过滤正确 |
| 13 | 对话引用写 usage | ⬜ | `knowledge-chat.mjs` 不调用 `recordUsage`；usage 只由门禁建议/手工 POST 产生 |
| 14 | 知识库损坏时门禁建议不伪装 | 🟥 | 见 P1-1；`knowledge-gate-advice.mjs:78-80` 吞掉 `store.query` 异常 |

### 2.4 Supervisor 工单生命周期

| # | 节点 | 判定 | 证据 |
|---|---|---|---|
| 1 | 源过滤：只收 official + 有 projectId 的 validation；open/investigating issue；pending plan | ✅ | `supervisor.mjs:101-146,149-182,185-229` |
| 2 | 去重：同 fingerprint 不重复建单/不重复计 occurrence；signalKey 变化才重开 | ✅ | `supervisor.mjs:96-98,417-492` |
| 3 | ack/dismiss/resolve + 非法动作/已关闭 | ✅ | `supervisor.mjs:545-578`、`supervisor.test.mjs` 5/5 |
| 4 | **done + 源仍失败 → 下一次扫描重开**（标记解决不隐藏证据） | ✅ | `supervisor.mjs:447-461` |
| 5 | dismissed 不复活直到源变化 | ✅ | `supervisor.mjs:462-492` |
| 6 | 明确 pass/resolved/approved 自动收口；源记录消失不擅自收口 | ✅ | `supervisor.mjs:232-269,494-508` |
| 7 | 每次 GET 先扫描 + 30s 常驻扫描（unref） | ✅ | `server.mjs:1947-1951,4734-4742` |
| 8 | Agent 可读 `/attention`，三个 POST 403 `AGENT_SUPERVISOR_ACTION_FORBIDDEN` | ✅ | `server.mjs:558-570`；`supervisor-http.test.mjs` 2/2 |
| 9 | Store 损坏 → 503 fail-closed | ✅ | `server.mjs:521-537`；`supervisor.test.mjs:120-140` |
| 10 | 源 Store 损坏 → 503 不伪装空队列 | ✅/🟥 | validation/issue 有包装（`server.mjs:538-557`）；**plan 启动损坏时被省略**（P1-6，探针已复现） |
| 11 | 真实数据一致性 | ✅ | 磁盘 4 工单：2 `open`（issue）×2、2 `done`；与 `issue-state` 2 open 一致；只读重算 `buildSupervisorSignals` 得同样 2 信号 |
| 12 | `blocked` 状态 | 🟨 | 在枚举/UI/attention 中但**没有任何动作或自动逻辑会产生它**（`supervisor.mjs:28-29`，UI `SupervisorPanel.tsx:41`）→ 永远 0（P2-3） |
| 13 | UI 失败保留旧数据并显示错误码/重试；不自动执行 | ✅ | `SupervisorPanel.tsx:70-121,135-140` |

### 2.5 联网研究开关真实消费者 + 外发清单覆盖

| # | 节点 | 判定 | 证据 |
|---|---|---|---|
| 1 | 开关 Runtime 权威持久化（`research-config.json`） | ✅ | `research-config.mjs`；`research-config.test.mjs` 4/4 |
| 2 | 设置页读写以 Runtime 为准、失败回滚/标注来源 | ✅ | `SettingsPage.tsx:77-124,423-465` |
| 3 | KMA 定时器随开关启停（默认关闭） | ✅ | `server.mjs:823-841`；`knowledge-scheduler.mjs` |
| 4 | **`/api/research/search|fetch` 由 `research-config` 把关** | 🟥 | 两条路由只认请求体 `allowResearch===true`，从不读 config（`server.mjs:2368-2383`）；config 仅在 `/config|status`/调度器使用（`2384-2396,824-841`） |
| 5 | 设置页“测试联网检索”遵守开关 | 🟥 | 固定 `allowResearch:true`，仅按 Runtime 可达禁用（`SettingsPage.tsx:315-320,461`）→ 开关关闭仍可外发 |
| 6 | 知识页“抓取网页知识”遵守开关 | 🟥 | 按钮无开关判断（`KnowledgePage.tsx:251-256`）→ `POST /api/knowledge/agent/run`（`server.mjs:2231-2240`）→ `knowledge-manager.mjs:140-205` 直接跑 web collectors |
| 7 | Agent token 不能绕过（研究/知识任务路由） | 🟥 | Agent denylist 只拒 `/api/research/config`（`agent-auth.mjs:52-59`），`/api/research/search|fetch`、`/api/knowledge/agent/run` 默认放行（同文件 `140-160`） |
| 8 | env 覆盖 `CIRCUITPILOT_KNOWLEDGE_AGENT=on` 时开关关闭能停调度 | 🟨 | `server.mjs:826-839`：env='on' 时 `shouldRun` 恒真，config 关闭不会 stop；外发清单/设置页未提示该覆盖 |
| 9 | KMA 手动“全部运行/抓取”与调度状态一致 | 🟨 | 手动 `runNow` 在模板 `enabled:true` 上写 `nextRunAt`（`knowledge-scheduler.mjs:18,97-101`），但定时器未必启动；真实 state 佐证：`research-config.json enabled:false` 而 `knowledge-agent.json enabled:true, nextRunAt=2026-10-30T12:44:29Z, lastRun reason=schedule` |
| 10 | 外发清单（G4）覆盖现有外发点 | 🟥 | 清单 5 项（`provider-egress.mjs:19-76`）漏：research search/fetch（`server.mjs:2368-2383`）、supply pricing/alternatives→jlcpcb.com（`4519-4547`）、custom provider models probe（`2435-2446`）、provider 连通性测试（`2466-2473`）、retro draft 模型调用（`2280-2313`）；chat.turn 未列“注入的 approved 知识摘要”（`4685-4696`） |
| 11 | “测试断言现有路由集合”的自我承诺 | 🟥 | `provider-egress.test.mjs:14` 只断言 endpoint id 数组，未与 server 路由交叉校验（P1-5） |
| 12 | `/api/research/status` 有产品消费者 | ⬜ | 仅测试/诊断；设置页读 `/config`（route-contract 允许清单亦如此标注） |

### 2.6 Agent 令牌 / 审计锚点 / 归档

| # | 节点 | 判定 | 证据 |
|---|---|---|---|
| 1 | 令牌路径/格式/0600/目录 0700；非法 fail-closed | ✅ | `agent-token.mjs:10-60`；真实 `~/Library/Application Support/CircuitPilot/agent-token.json` 0600 |
| 2 | 常量时间比较；认证/授权分离；路由归一化防编码绕过 | ✅ | `agent-token.mjs`、`agent-auth.mjs:90-160`；测试 14/14 |
| 3 | denylist（签核/终审/下单/下载/诊断包/设置/Provider/写门禁）；对话审批精确例外；计划请求精确例外 | ✅ | `agent-auth.mjs:40-160`；`agent-auth-http` 测试 |
| 4 | UI 令牌轮换立刻生效（重读令牌缓存） | ✅ | `server.mjs:1764-1774` |
| 5 | 审计事件（accepted/denied/request/approve/rotate）落 HMAC 链 | ✅ | `server.mjs:465-477,1684-1703`；`agent-console.mjs:604-720` |
| 6 | 链完整性/尾部删除/整文件删除/换序/坏行检测 | ✅ | `agent-console.mjs:354-420,577-720`；`agent-console.test.mjs` 52/52 + `agent-console-http` |
| 7 | 外部锚点 CLI 可生成/验证，且不冒充“链未推进” | ✅ | `scripts/agent-audit-archive.mjs`；本轮真跑（安装版 state seq=66）：`verify-anchor` **exit 0**，锚点 seq=44 签名有效、`currentMatches=false` 如实报告 |
| 8 | 归档 create/verify（离线可复核、路径穿越/错 key fail-closed） | ✅ | `agent-audit-archive.mjs:336-420`；`agent-audit-archive.test.mjs` 9/9 |
| 9 | 外部锚点自动/验收步骤 | 🟨 | 仅手工 CLI；无 acceptance 步骤；`artifacts/audit-external-anchor-20261029/` 的 verify 报告是 10-29 快照（P2-11） |
| 10 | UI “已锚定”语义 | 🟨 | = 本地 `head` 与最后一条链记录一致（`agent-console.mjs:878`），**不是** CLI 外部锚点；文案易误读（P2-11） |

### 2.7 扩展市场 / DSH plugin / 备份 / 诊断 / 长跑

| # | 节点 | 判定 | 证据 |
|---|---|---|---|
| 1 | 扩展市场：product 入口（HTTP/UI） | ⬜ | `runtime/server.mjs` 对 `extension` 0 命中；`src/` 0 命中；只有只读 agent `runtime/agents/extension-registry.mjs` + demo `scripts/ext-market-demo.mjs` + 设计稿 `docs/design/extension-market/*`（Draft，写动作“首版恒 501”未实现） |
| 2 | 扩展市场：只读能力公告板可复现 | 🟨 | `node scripts/ext-market-demo.mjs` 只读跑通（本机已装 8 张卡 + 市场合并版在 artifacts/ext-market/）→ 研究/证据资产，不是产品能力 |
| 3 | DSH plugin 包真实性与测试 | ✅ | `plugin/dsh-circuitpilot/**`；本轮 `node --test "test/*.test.mjs"` **86/86**；`desktop` profile `package.json` bundles + pnpm-lock 指向 `link:.../plugin/dsh-circuitpilot` |
| 4 | DSH plugin 本机运行态 | 🟨 | 4178 当前监听者是旧版 App（`/Applications/CircuitPilot-v0.2.20-before-outline-20260907.app`，health `version=0.8.15`，`/api/agent/status`、`/api/write-gate`、`/api/research/config` 全 404）→ 插件即使被宿主加载也无法完成真实调用（边界，非代码缺陷） |
| 5 | 备份/恢复演练（H6） | ✅/🟨 | `scripts/backup-restore-drill.mjs:34-80` 备份 state/evidence/automation-runs 并用运行时加载器复核；**漏 `~/.circuitpilot/drc-exemptions*`、`schematic-batches`、`last-project.json`**（P2-5） |
| 6 | 诊断包（H5） | ✅ | `server.mjs:2081-2102`；`SettingsPage.tsx:201,379`；脱敏/有界/缺段如实；**未含 supervisor/write-gate/research/knowledge 健康度**（P2-12） |
| 7 | 长跑（H4 24h） | ⬜ | 只有短窗 smoke 脚本（`scripts/long-run-memory.mjs`）；24h 未做（环境边界） |

---

## ③ 问题清单与修复建议

### 3.1 P1（6 项）

**P1-1 知识库损坏被门禁建议伪装成“没有相关知识”（fail-open 展示）**
- 证据：`runtime/knowledge-gate-advice.mjs:78-80` `try { found = store.query({text}) } catch { found = [] }`；`server.mjs:2119-2123,2188-2193` 把空建议 200 返回。
- 复现（隔离，随机端口/临时 state）：knowledge 目录放坏 JSON 后 `GET /api/knowledge/entries` → **400 `KNOWLEDGE_CORRUPT`**，同一 Runtime `GET /api/eda/gates/status?pcbUuid=…` → **200，`suggested=[]`，note=“没有 approved + 未过期的相关知识”**。
- 影响：用户/审计把“知识库读坏了”理解成“没有可引用知识”，放行判断依据缺失却无告警。
- 修法：`collect()` 不吞错——捕获后累计 `knowledgeErrors`，在返回值给 `knowledgeAvailable:false + code`；路由对“知识库不可用”返回 503（或 200 带显式 error 字段），UI 显示“知识库不可用，请修复 state/knowledge”。
- 测试：corrupt knowledge + gate status → 503/显式错误；gates-p05 增加断言。
- 风险：低（只在错误路径改变状态码）；**无需真机**。

**P1-2 RAG 索引不随“离线写入/文档变更/重启”失效（真实 state 已有漏索引）**
- 证据：`knowledge.mjs:233-237,262` revision 仅内存计数；`rag/store.mjs:33-35,57-89` 只比较“内存 revision vs 持久 corpusRevision”；`rag/index.mjs:45,85-86,156-189` `corpusDigest` 只写不比对。
- 实测 1（隔离）：写入 R1 → 新实例（revision=0）建索引（corpusRevision=0）→ 离线写入 R2 → 再“重启”（revision=0，读回 corpusRevision=0）→ `docs=1`、`storeEntries=2`、新条目不在 RAG 命中，而 status 显示 `corpusRevision=knowledgeRevision=0`（看似最新）。
- 实测 2（真实 state，只读）：`artifacts/state/rag/index.json` builtAt `2026-10-29T04:13:20Z`、435 条 knowledge docs、corpusRevision=0；`artifacts/state/knowledge` 现有 **444 条** → **9 条新增未进索引**（当前均为 candidate，故今日无 approved 漏检；与 `docs/implementation/*.md` 变更同属不可见）。
- 影响：项目文档化的“批量委托审核脚本（离线写 store）”之后，运行中的 Runtime 与重启后的 Runtime 都可能继续用旧索引 → 新 approved 知识搜不到、徽标/meta 过期；`KnowledgePage` 的“重建索引”变成必需人工步骤。
- 修法：①索引文件落 `corpusDigest`（已有）+ 知识条目 id/digest 集合摘要，`load()` 后比对，不一致自动 rebuild；②`knowledgeStore` revision 持久化到 `knowledge/.revision`（或每次 load 计算语料摘要），避免“重启 revision 归零”；③docs 目录 mtime/digest 纳入失效；④status 暴露 `stale: true` 与原因。
- 测试：新增 `rag-invalidation.test.mjs`（离线写→重启/在线写→不点重建即命中；docs 改动同样失效）。
- 风险：首次升级会重建一次索引（28MB/1~2s，可接受）；**无需真机**。

**P1-3 状态读失败被 UI 吞掉，且启动写回会把损坏的权威文件覆盖**
- 证据：`AppContext.tsx:286-336`（project）、`362-380`（validation，`finally` 在读失败时仍置 `validationReadyRef=true`）、`499-529`（trace/issue）读失败只 `logger.warn`；写回 effect 无“hydrate 成功”守卫：`472-495`（project，800ms）、`381-410`（validation）、`531-547`（issue/trace，1s）；`store.mjs:77-93` `save` 不读旧文件 → 直接原子覆盖。
- 影响：`project-state.json` / `validation-state.json` 等损坏后，UI 静默用 localStorage 缓存继续，~1s 后把缓存写回覆盖损坏文件（丢失后续人工取证/修复机会），且无任何用户可见告警；`custom-providers` 损坏时 `/api/providers` 已返回 degraded，但 `runtimeClient.providers()` 只返回数组（`runtimeClient.ts:479-482`）→ 列表显示空，像是“没有自定义 Provider”。
- 修法：①读失败进入全局“持久化降级”状态并在顶栏/设置页横幅展示（含 code/文件），**禁止自动写回**（需用户显式“用本地覆盖”）；②validation/trace/issue 的 ready/守卫只在读成功时置位；③`runtimeClient.providers()` 透传 `customProviders{available:false,…}` 并在自定义 Provider 面板展示。
- 测试：vitest `AppContext`（mock 500/400 + 损坏码：不写回、有告警）；`SettingsPage`（providers degraded 横幅）。
- 风险：低；**无需真机**。

**P1-4 联网研究开关不是外发门禁（UI 入口/Agent/env 均可绕过）**
- 证据：`server.mjs:2368-2383`（search/fetch 只认 `body.allowResearch`）、`2384-2396`（config 只服务读写/状态）、`823-841`（调度随 config，但 env='on' 恒真）；`SettingsPage.tsx:315-320,461`（测试按钮恒 `allowResearch:true`，仅按可达禁用）；`KnowledgePage.tsx:251-256` + `server.mjs:2231-2240` + `knowledge-manager.mjs:140-205`（手动 web 采集不看 config）；`agent-auth.mjs:52-59,140-160`（Agent 可调 research/knowledge 任务）。
- 真实状态佐证：`research-config.json enabled:false` 与 `knowledge-agent.json enabled:true,lastRunAt 2026-10-29T12:44:34Z,reason=schedule,nextRunAt 2026-10-30T12:44:29Z` 相互矛盾（调度实际在跑/或历史 env 覆盖），设置页却显示“默认关闭”。
- 影响：“允许 AI 联网查询公开资料”关闭后，用户点“测试联网检索/抓取网页知识”、旧页面、脚本或 Agent 仍能发起外网请求；安全叙事与真实外发不一致。
- 修法：①`/api/research/search|fetch` 前置 `await researchConfig.load()`，`enabled!==true` 一律 403 `RESEARCH_DISABLED`（`allowResearch` 仅作为“用户确认”第二因子）；②设置页测试按钮随开关禁用；知识页 web 任务同校验（或路由内 `if (task web && !config.enabled) 409`）；③Agent denylist 增加 `/api/research` 子树（或显式允许清单）；④env 覆盖仅在显式 `CIRCUITPILOT_KNOWLEDGE_AGENT=on` 时生效且在设置页显著提示“运维覆盖中”。
- 测试：research HTTP（mock fetch）覆盖“config off + allowResearch:true → 403 且 fetch 未被调用”“config on → 放行”；设置页按钮禁用断言；设置页/KMA 状态一致性断言。
- 风险：会改变现有脚本/测试依赖（需同步 `research.test`/`knowledge-research.test` 的注入方式）；**无需真机，外发可用 nock/local proxy 断言**。

**P1-5 G4 外发清单覆盖面不足，且“测试断言现有路由集合”的自述不成立**
- 证据：`provider-egress.mjs:19-76`（只有 chat.turn / plan.ai / netlist.ai / knowledge.research / part.proposal）；遗漏真实外发：`/api/research/search|fetch`（`server.mjs:2368-2383`）、`/api/supply/pricing|alternatives` → `https://jlcpcb.com/...`（`server.mjs:4519-4547`、`engineering/supply.mjs:39`）、custom provider models 探测（`server.mjs:2435-2446`）、provider 连通性测试（`server.mjs:2466-2473`）、retro 经验起草模型调用（`server.mjs:2280-2313`）；`chat.turn` 的 data 字段未包含注入的 approved 知识摘要（`server.mjs:4685-4696`，`chat.mjs:238`）。
- 测试缺口：`provider-egress.test.mjs:14` 只断言 id 数组；manifest 自述“测试会断言现有路由集合”（`provider-egress.mjs:10,89`）在代码中不存在。
- 影响：G4“告知/同意”面板与实际外发面不一致，新增外发点无回归保护（安全/合规口径失真）。
- 修法：①清单补上述 5 类外发点（含触发条件、发送字段、不发送项）；②把清单 route 与 `server.mjs` 模型调用/外网调用点做静态交叉校验测试（从 `chatManager.*`/`searchWeb`/`fetchPage`/`lookupLcscParts`/`testProvider` 调用点提取，清单缺项即失败）；③chat.turn 增列 `knowledgeExcerpts`。
- 测试：`provider-egress.test.mjs` 增加“外发调用点 ⊆ 清单”断言。
- 风险：纯文档+测试，无行为变化；**无需真机**。

**P1-6 Supervisor 的 plan 源不可用被静默省略（“源读失败→503”承诺不完整）**
- 证据：`server.mjs:486-503`（plan store 构造失败→`planRequestStoreError`，路由 fail-closed 503）、`538-557`（scanSupervisor）、**`:545` `planRequests = planRequestStore ? planRequestStore.listAll() : []`**；`supervisor-readonly-2026-11-02.md §2.1` 承诺“源 Store 读失败时路由返回 503，不返回空队列”。
- 复现（隔离，随机端口/临时 state）：预置坏 `agent-plan-requests.json` + 合法 `validation-state.json`，启动 Runtime：
  - `GET /api/agent/plan-requests` → **503 `PLAN_REQUEST_STORE_UNAVAILABLE`**（正确）
  - `GET /api/supervisor/attention` → **200**，`sources=['validation']`、`total=1`，响应无任何 degraded/告警字段（计划源被静默省略）
- 影响：plan 待审批源损坏时，值守队列看起来“只有验证/问题待办”，用户不会去修复 plan store；与“读失败不伪装空队列”的既有承诺不一致。
- 修法：`scanSupervisor` 在 `planRequestStore` 不可用时抛 `SOURCE_UNAVAILABLE`（503）；若产品要“部分可用”，则返回显式 `sources[].available:false + warnings`，UI 顶部提示（不能静默省略）。
- 测试：`supervisor-http.test.mjs` 增加“plan store 损坏 → /attention 503（或显式 warnings，二选一并锁定）”。
- 风险：低；**无需真机**。

### 3.2 P2（12 项，按影响排序）

| # | 问题 | 证据（file:line） | 修法建议 |
|---|---|---|---|
| P2-1 | `knowledge/usage.jsonl` 无产品查询入口；`POST /api/knowledge/usage` 不校验条目存在/调用方角色 | `server.mjs:2224-2228`；`knowledge-api.mjs:76-88`；`runtimeClient.ts` 无 usage 方法 | 加 `runtimeClient.knowledgeUsage(id)` + 知识详情“使用记录”面板；POST 校验条目存在与角色 |
| P2-2 | 门禁建议的 `candidates/usageRecorded/usageFailures` 前端类型缺失、UI 不展示（无法确认“评估时记录 usage”） | 后端 `knowledge-gate-advice.mjs:165-175`；前端 `types.ts:1614-1621`；`VerificationCenterPage.tsx:193-211` | 补类型并显示“usage 已记录 N 条/失败 M 条/候选 K 条（可展开）” |
| P2-3 | Supervisor `blocked` 状态不可达（枚举/UI/attention 都有，但无任何写入路径） | `supervisor.mjs:28-29,345-361`；`SupervisorPanel.tsx:41,163` | 删除该状态，或定义触发规则（如源连续 N 次不可用/证据冲突）并接入；否则 UI 永远 0 误导 |
| P2-4 | KMA 调度状态可被“手动运行”写成已启用/已排期，UI 不显示 `corruptState`，与 research 配置可相互矛盾 | `knowledge-scheduler.mjs:18,97-101`；`KnowledgePage.tsx:260-261`（未用 `scheduler.corruptState`，类型见 `types.ts:1645`）；真实 state 矛盾见 2.5 #9 | runNow 不写 `nextRunAt`（除非真正 schedule）；UI 展示 `corruptState` 与“定时器是否运行”；设置页展示 env override |
| P2-5 | 状态根分裂 + 备份/迁移覆盖不全：journal/`schematic-batches`/`last-project`/`drc-exemptions` 固定 `~/.circuitpilot`，Tauri 只注入 STATE_DIR/EVIDENCE_DIR；backup-drill 未覆盖上述用户数据 | `automation/journal.mjs:43-47`；`server.mjs:1061-1078,2968`；`drc.mjs:53-60`；`src-tauri/src/lib.rs:146-150`；`scripts/backup-restore-drill.mjs:34-80`；真实 automation-runs 3029 文件/12MB 无保留策略 | 统一 state 根（或显式多根清单+备份脚本覆盖）；journal 目录随 STATE_DIR；为 automation-runs 加保留/归档策略（如保留最近 N 天） |
| P2-6 | `eda-jobs.jsonl` 无上限/无轮转（真实 5.1MB），启动时整文件 `readFileSync` 恢复 | `eda-job-journal.mjs:11-35`；`server.mjs:430-444` | 按大小/天数轮转 + 恢复只读尾部窗口；或改按 job 分文件（EdaJobStore 已有内存模型） |
| P2-7 | 遗留旧状态文件：`artifacts/state/eda-jobs.jsonl`（2026-10-20，当前代码写 appDataDir），排障时易看错 journal | `runtime/server.mjs:430`；磁盘 `artifacts/state/eda-jobs.jsonl` | 迁移/删除旧文件并在启动日志给出“当前 journal 路径” |
| P2-8 | 对话引用 approved 知识不写 usage（无法回答“对话里谁引用过这条知识”） | `knowledge-chat.mjs:47-111`（无 `recordUsage`）；`server.mjs:4685-4696` | 对话命中后写 `usage(agent:'chat', outcome:'used', note:'对话引用')`，失败计入 `usageFailures` |
| P2-9 | 降级语义不统一：approvals-ledger 损坏仍继续签发（新链从 GENESIS，审计历史丢失）；chat/production 损坏仅日志、无 UI 提示；custom-providers 降级字段被前端丢弃 | `approval-ledger.mjs:26-38`；`server.mjs:571-579,613-621,742-757,2404`；`runtimeClient.ts:479-482` | 账本损坏时“只读历史 + 禁止新签发”或显式 `chainBroken`；统一 degraded 状态字段并在 UI 横幅；client 透传 degraded |
| P2-10 | 路由契约把“测试引用”当消费者，掩盖产品级无消费者（`research/status`、`research/fetch`、`design/plan/ai`、`production/reviews/final` 被判定可清理） | `runtime/__tests__/route-contract.test.mjs`（规则 2：scripts/tests 也算消费者）；本轮输出“允许清单有 4 条可以清理” | 区分“产品消费者/测试消费者/诊断消费者”；对无产品入口的路由保留说明并要求显式 allowlist |
| P2-11 | Agent 审计外部锚点：仅手工 CLI、无 acceptance 自动校验；UI “已锚定”徽标语义是本地 head 一致而非外部锚点；`artifacts/audit-external-anchor-20261029/` 是 10-29 快照 | `scripts/agent-audit-archive.mjs:79-92`；`agent-console.mjs:878`；`AgentAccessPanel.tsx:286-291`；本轮 verify：锚点 seq=44 vs 当前 seq=66，`currentMatches=false`（诚实但无自动归档更新） | 说明文案区分“head 锚定/外部锚点”；接受 `verify-anchor` 作为可选 acceptance 步骤（显式开关）或提供“生成新锚点”CLI 指引 |
| P2-12 | 诊断包不含 supervisor/write-gate/research/knowledge 健康度（平台链排障差最后一公里） | `server.mjs:2081-2102` | 增四段（各 `available:false+reason` 不伪造），复用现有只读 snapshot |

---

## ④ 需真机 / 人工边界（诚实清单）

1. **本机 4178 不是本仓库 Runtime**：当前监听者为旧版 App（`/Applications/CircuitPilot-v0.2.20-before-outline-20260907.app`，health `version=0.8.15`，无 `/api/agent/*`、`/api/write-gate`、`/api/research/config`、`/api/supervisor/*`）。本报告所有 HTTP 级结论来自**隔离临时 Runtime（随机端口、fake/无 bridge、临时 state）**，**未对旧进程做任何真机复验**，也未重启它（遵守约束）。真机复验前需人工退出旧进程并以本仓代码启动。
2. **Supervisor 真机闭环**沿用 `supervisor-readonly-2026-11-02.md §5.1` 的**历史证据**（official DRC 失败→工单→概览接单→人工批准修复→重测 pass→自动收口），本轮未复跑；其“待补/未验证”项（Tauri 桌面壳内点击验收、计划审批队列端到端点击、`pcb-sync-from-schematic` 配方读回误判）仍开放。
3. **联网外发路径本轮未实际触发**（遵守“不联网外发”）：P1-4/P1-5 结论来自代码路径 + 现有测试；若需证明“开关关闭时零外发”，应在隔离 Runtime + nock/local proxy 下断言 fetch 未被调用，而不是发真实请求。
4. **知识 approved→usage 的“真实 state 痕迹”缺失**：`artifacts/state/knowledge/usage.jsonl` 与安装版 state 均不存在（本轮未调用 evaluate 写盘）；闭环由 `gates-p05-http` 与真实语料只读建议验证，**不宣称线上已有 usage 记录**。
5. **过期条目排除**：代码与单测成立，但真实语料 0 条 expired，未能在真实数据上复验“过期不进建议/RAG”。
6. **扩展市场仍是纸面**：只有只读 agent + demo 脚本 + Draft 设计稿；无 HTTP 路由/UI/写层（自动安装首版即 501 设计）。
7. **DSH plugin**：包/测试/挂载声明真实，但“DSH 宿主实际加载 + cp_* 工具在对话中可见 + 对 4178 真实调用”本轮未验证（且 4178 是旧 Runtime，不可能成功）。
8. **H4 24h 长跑 / H6 跨机器迁移 / Tauri 桌面壳 E2E / Playwright**：本轮均未执行；H6 只有脚本级演练证据。
9. **审计期间工作树出现并发修复**（`server.mjs`、`route-contract.test.mjs`、`plugin/dsh-circuitpilot/test/package.test.mjs` 等被改），本报告按 HEAD `98429be` 行号记录；若以当前工作树复查，行号会偏移（路由段 +55~+85），结论是否随修复失效需 Lead 按修复清单复核。

---

## ⑤ 验证记录（全部只读；隔离临时 state/随机端口；0 fail）

### 5.1 测试套件（本轮真跑）

| 命令（片段） | 结果 |
|---|---|
| `node --test runtime/__tests__/supervisor.test.mjs` | 5/5 |
| `node --test runtime/__tests__/supervisor-http.test.mjs` | 2/2 |
| `node --test runtime/__tests__/knowledge-gate-advice.test.mjs` | 6/6 |
| `node --test runtime/__tests__/knowledge-real-corpus.test.mjs` | 1/1 |
| `node --test runtime/__tests__/knowledge-chat.test.mjs` | 6/6 |
| `node --test runtime/__tests__/rag.test.mjs` | 9/9 |
| `node --test runtime/__tests__/research-config.test.mjs` | 4/4 |
| `node --test runtime/__tests__/research.test.mjs` | 15/15（fetch 全部 stub，无真实外网） |
| `node --test runtime/__tests__/provider-egress.test.mjs` | 4/4 |
| `node --test runtime/__tests__/gates-p05-http.test.mjs` | 3/3（含 candidate→approved→建议→usage 全链） |
| `node --test runtime/__tests__/{write-gate-http,write-gate-store,project-state,trace-state,trace-state-http,issue-state,validation-state}.test.mjs` | 26/26（含损坏门禁 fail-closed、跨进程重启保留） |
| `node --test runtime/__tests__/{agent-auth,agent-console,agent-console-http,agent-auth-http,agent-audit-archive}.test.mjs` | 75/75（含尾部删除/换序/并发 append/错 key） |
| `node --test runtime/__tests__/extension-capability-board.test.mjs` | 15/15 |
| `node --test runtime/__tests__/route-contract.test.mjs` | 3/3；输出：**200 路由 / 193 有消费者 / 11 允许清单 / 0 孤儿**（另有 4 条 allowlist 可清理提示，见 P2-10） |
| `cd plugin/dsh-circuitpilot && node --test "test/*.test.mjs"` | 86/86（fake runtime，无 DSH/EDA 依赖） |

### 5.2 只读数据扫描

- `artifacts/state/knowledge`：444 条（module 107 / rule 164 / failure 108 / part 60 + 审核态拆分：approved 163 rule，其余 candidate；rejected 0；expired 0）；`usage.jsonl` **不存在**。
- `artifacts/state/rag/index.json`：schemaVersion 2、582 docs / 4129 chunks、knowledge docs 435（163 条 `gateUsable:true`）、builtAt `2026-10-29T04:13:20Z`、corpusRevision 0 → 与现有 444 条知识存在 **9 条缺口**（P1-2）。
- `artifacts/state/supervisor-tickets.json`：4 工单 = open issue×2 + done×2；`issue-state.json` 3 条（2 open）→ 只读重算 `buildSupervisorSignals` 得 2 信号，一致。
- `artifacts/state/research-config.json`（enabled:false）vs `knowledge-agent.json`（enabled:true, lastRunAt 2026-10-29T12:44:34Z, reason=schedule, collectors 6）→ 矛盾（P1-4/P2-4）。
- 安装版 state（`~/Library/Application Support/com.circuitpilot.desktop/state`）：agent-audit seq=66；knowledge 392 条（141 rule/100 module/91 failure/60 part），无 usage.jsonl。
- 目录体积：`artifacts/state` 33MB（RAG 索引 28MB）；`~/.circuitpilot/automation-runs` 12MB/3029 文件；appData `eda-jobs.jsonl` 5.1MB（P2-5/P2-6）。

### 5.3 隔离探针（可复现；随机端口 + `mktemp -d`，不触真实 EDA/外网）

1. **Gate 建议吞损坏**：临时 state 放坏 knowledge JSON → `GET /api/knowledge/entries`=400 `KNOWLEDGE_CORRUPT`；`GET /api/eda/gates/status?pcbUuid=pcb-x`=200、`knowledgeAdvice.suggested=[]`、note=“没有 approved + 未过期的相关知识”。（P1-1）
2. **Supervisor plan 源静默省略**：预置坏 `agent-plan-requests.json` + 合法 official validation → `GET /api/agent/plan-requests`=503 `PLAN_REQUEST_STORE_UNAVAILABLE`；`GET /api/supervisor/attention`=200、sources 仅 `['validation']`、无 degraded 字段。（P1-6）
3. **RAG 失效边界**：临时 knowledge 根写入 R1 → 新 store（revision=0）建索引（corpusRevision=0）→ 离线写 R2 → 新 store/同索引查询：`docs=1`、`storeEntries=2`、R2 不在结果、status 显示两 revision 相等。（P1-2）
4. **真实语料门禁建议**（只读，`record:false`）：真实 `artifacts/state/knowledge` + 真实 `gateService.status()` → `suggested=6`（G1–G6）、`candidates=73`（unreviewed）、`unusableSkipped=438`。
5. **外部审计锚点**：`node scripts/agent-audit-archive.mjs verify-anchor --anchor-file artifacts/audit-external-anchor-20261029/anchor-44-…json --audit-file <安装版 state>/agent-audit.jsonl --key-file <安装版 state>/agent-audit.key.json` → **exit 0**，锚点签名有效、`currentMatches=false`（链已推进，如实报告）。另 `audit:archive create` 在 `/tmp` 隔离目录成功（已清理）。
6. **旧 Runtime 识别**：`lsof -iTCP:4178` → 进程 cwd=`/Applications/CircuitPilot-v0.2.20-before-outline-20260907.app/Contents/Resources`；`GET /api/health`=`0.8.15`；`/api/agent/status`、`/api/write-gate`、`/api/research/config`=404（非本仓代码）。

未做：任何写 EDA/Bridge、任何外网请求、4177/4178 重启、Playwright/live e2e、acceptance、git 操作。

---

## ⑥ 关键文件索引

- 状态与路由：`runtime/server.mjs:480-870,1737-2082,2112-2396,4680-4742`；`runtime/store.mjs`；`runtime/{project-state,trace-state,issue-state,validation-state,write-gate,research-config,supervisor,plan-requests}.mjs`。
- 知识/RAG：`runtime/knowledge.mjs`、`knowledge-api.mjs`、`knowledge-gate-advice.mjs`、`knowledge-chat.mjs`、`knowledge-manager.mjs`、`knowledge-scheduler.mjs`、`knowledge-pipeline.mjs`、`rag/{store,index,corpus}.mjs`。
- 研究/外发：`runtime/research.mjs`、`research-config.mjs`、`provider-egress.mjs`、`collectors/*`。
- Agent：`runtime/agent-auth.mjs`、`agent-token.mjs`、`agent-console.mjs`、`agent-audit-archive.mjs`、`scripts/agent-audit-archive.mjs`；UI `src/components/AgentAccessPanel.tsx`。
- UI 接线：`src/state/AppContext.tsx`、`src/components/SupervisorPanel.tsx`、`src/pages/{SettingsPage,KnowledgePage,VerificationCenterPage,AiTasksPage,VersionsPage,ValidationPage}.tsx`。
- 扩展/插件：`runtime/agents/extension-registry.mjs`、`runtime/extension-market/**`、`scripts/ext-market-demo.mjs`、`plugin/dsh-circuitpilot/**`。
- 备份/诊断/长跑：`scripts/backup-restore-drill.mjs`、`runtime/diagnostic-bundle.mjs`、`scripts/long-run-memory.mjs`、`src-tauri/src/lib.rs:56-58,146-150`。
- 回归：`runtime/__tests__/{supervisor,supervisor-http,knowledge-gate-advice,knowledge-real-corpus,knowledge-chat,rag,research-config,research,provider-egress,gates-p05-http,write-gate-http,write-gate-store,project-state,trace-state*,issue-state,validation-state,agent-*,extension-capability-board,route-contract}.test.mjs`。
