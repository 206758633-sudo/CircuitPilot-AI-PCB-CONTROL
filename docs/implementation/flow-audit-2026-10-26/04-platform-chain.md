# 04 · 自动化/知识库/项目持久化/Provider/运维链路

> 范围：`src/pages/AutomationPage.tsx`、`KnowledgePage.tsx`、`ProjectsPage.tsx`、`SettingsPage.tsx`、`OverviewPage.tsx`；`src/services/{automationParams,longTask,edaWorkspaceStore}.ts`、`src/state/{AppContext,taskMachine}.ts`；`runtime/automation/**`、`knowledge*.mjs`、`rag/**`、`research.mjs`、`project-state.mjs`、`store.mjs`、`trace-state.mjs`、`issue-state.mjs`、`customProviders.mjs`、`providers.mjs`、`keychain.mjs`、`diagnostic-bundle.mjs`、`log-redaction.mjs`、`server.mjs` 对应路由；`src-tauri/**`、`scripts/**`、`.github/workflows/ci.yml`。
> 方法：只读静态读码 + `grep` 交叉（UI 调用 ↔ client 方法 ↔ server 路由 ↔ runtime 实现）+ 只读检查本机安装版状态目录。**未启动 4177/4178，未跑 `npm test`/`npm run test:runtime`/playwright，未改任何源码**；EDA/Bridge 本轮未启动，真机结论一律标注「历史证据（日期），本轮未复验」。
> 判定：✅已打通（UI→API→runtime 且有测试或带日期证据）｜🟨半打通｜🟥断点｜⬜纸面｜🚫产品边界。**「有代码」不算打通。**

## 0. 结论（按严重度 3-6 条）

1. **P0：写入门禁「全局暂停所有写入」只活在前端。** `runtime/`、`src-tauri/src/`、`scripts/` 源码对 `writePaused` **0 命中**（`grep -rn writePaused runtime/ src-tauri/src scripts/`），但设置页文案承诺「最高优先级门禁，阻断所有 EDA 写命令」（`src/pages/SettingsPage.tsx:409`）。运行时不读该开关：签发写批准（`runtime/server.mjs:3444-3456`）、自动化运行（`server.mjs:3480-3538`）、布局写回（`server.mjs:2262-2285`）都不校验，`AutomationPage`/`PlacementPage` 页面也不校验（`src/pages/AutomationPage.tsx:170,200`；`PlacementPage.tsx:101-130`）。→ 暂停后仍可写板。
2. **P0：知识库「candidate→approved→门禁引用」最后一环不存在。** UI 明说「approved 才能进门禁引用」（`KnowledgePage.tsx:151,245`），但 `isUsableForGate`（`runtime/knowledge.mjs:484-491`）只被列表计数使用（`runtime/knowledge-api.mjs:46` 的 `gateUsable`）；`gate-engine / gates-service / release-* / production* / placement*` 对 `knowledge` **0 引用**（grep）；引用闭环只在 `runtime/agents/orchestrator.mjs`，而它**没有被 `server.mjs` import**（仅 `scripts/verify-knowledge-loop.mjs:13`）。安装版运行态 392 条知识**全部 candidate、approved=0**（2026-10-26 12:58 只读检查 app data）；K7 文档也自述「approved=0 是设计约束」（`docs/implementation/knowledge-k7-governance-2026-10-22.md:5,120`）。
3. **P1：阶段机/概览的证据源不持久且跨项目污染。** `deriveStageEvidence` 读全局 `state.task.status`（`src/services/stageEvidence.ts:29-33`）与无 `projectId` 的 `validations`（`src/types.ts:659-668`；`stageEvidence.ts:41-44`），切换项目只改 `activeProjectId`（`AppContext.tsx:56`）→ A 项目证据可满足 B 项目阶段；且全仓**无代码写 `source:'official'`**（仅定义 `types.ts:667` 与读取 `stageEvidence.ts:44`，`ValidationPage.tsx:300,315` 只写 `'demo'`）→「验证→生产」永被阻断。概览计数/进度同样取自 demo 验证与静态 `project.progress`（`OverviewPage.tsx:22-35`；`ProjectsPage.tsx:64`）。
4. **P1：RAG 索引不会随知识/文档更新。** 只有索引为空时才懒构建（`runtime/rag/store.mjs:71-72`），知识保存/审核路由不发失效信号（`server.mjs:1553-1580`）；安装版索引 `builtAt=2026-10-22`（479 docs/3376 chunks），此后新增条目/文档检索不到。
5. **P1：「联网检索」开关是纸面，KMA 后台反而默认联网。** `researchEnabled` 只出现在 `types.ts:758` 与设置页；唯一消费者是连通性测试按钮且硬编码 `allowResearch:true`（`SettingsPage.tsx:256-266`），AI 对话不调用检索（`runtime/chat.mjs` 无 research 引用）。而 KMA 网页采集默认开启并直接调 `searchWeb/fetchPage`（`server.mjs:517-534`；`runtime/agents/knowledge-manager.mjs`；`runtime/collectors/pcb-web.mjs`），不经 `/api/research/*` 的 `allowResearch` 请求闸；`GET /api/research/status` 硬编码 `enabled:false`（`server.mjs:1623-1625`）。
6. **P2：运维/桌面层实现真实，但存在双状态源与发布缺口。** 诊断包/日志脱敏/失败诊断/Tauri sidecar 均有实现与测试；但自动化 journal 固定写 `~/.circuitpilot/automation-runs`（`runtime/automation/journal.mjs:43-46`），安装版状态在 app data（`src-tauri/src/lib.rs:56-58,138`），开发态又用 `artifacts/state`（`server.mjs:395`）；设置（provider/暂停）只存 localStorage（`AppContext.tsx:258-265`，无 `/api/settings`）；CI 无发布签名流水线（`.github/workflows/ci.yml` 仅两 job）。

## 1. 链路现状表（环节 | 用户动作 | UI/代码位置 | 后端路由/模块 | 判定 | 证据）

| 环节 | 用户动作 | UI/代码位置 | 后端路由/模块 | 判定 | 证据 |
|---|---|---|---|---|---|
| 自动化·配方目录 | 打开自动化页 | `AutomationPage.tsx:77-92` | `GET /api/automation/recipes`（`server.mjs:3441`） | ✅ | `runtime/automation/recipes.mjs` 8 条；`runtime/__tests__/automation-http.test.mjs` 6 条 |
| 自动化·参数表单 | 选配方填 uuid/JSON | `AutomationPage.tsx:339-347`；`services/automationParams.ts:21` | runner 参数预检（`runtime/automation/runner.mjs`） | ✅ | 坏 JSON fail-closed（`automationParams.ts:11-18`） |
| 自动化·步骤预演 | 看步骤清单 | `AutomationPage.tsx:329-337` | 无 preview 端点（`server.mjs:3441-3500`） | 🟥 | 只能看静态步骤，无法预演影响（§2.9） |
| 自动化·签发写批准 | 点「签发写板批准」 | `AutomationPage.tsx:170-184` | `POST /api/automation/approvals`（`server.mjs:3444-3456`） | 🟨 | 真签发、绑定 EDA 指纹；但不读 writePaused（§2.1） |
| 自动化·运行只读配方 | 点「运行配方」 | `AutomationPage.tsx:200-232` | `POST /api/automation/run`（`server.mjs:3480-3538`） | ✅ | 历史证据（2026-10-19）4 条只读 `completed`：`artifacts/automation-phase1-smoke.json`，本轮未复验 |
| 自动化·运行写入配方 | 批准后运行 | 同上 | `runner.mjs` + bridge `pcb.importChanges`（`bridge.mjs:422`）/`pcb.pour.rebuild`（`bridge.mjs:617`） | ✅ | 历史证据（2026-10-19）R2/R6 真机 `completed` + 哈希链：`artifacts/r2-r6-acceptance/`，本轮未复验 |
| 自动化·缺批准/缺参数 | 直接运行 | `AutomationPage.tsx:216-217,531-532` | runner 返回 `needs_approval`/`needs_params`，0 步执行 | ✅ | `automation-http.test.mjs`；UI 显示 missing* |
| 自动化·中止运行 | 运行中点中止 | `AutomationPage.tsx:186-198` | `POST /api/automation/runs/:id/abort`（`server.mjs:3571-3580`） | ✅ | 步骤边界生效；已结束 run 返回 409 |
| 自动化·哈希链审计 | 查看哈希链 | `AutomationPage.tsx:257` | `GET /api/automation/runs/:id`（`server.mjs:3593-3601`） | ✅ | `journal.mjs:60-66` `sha256(prevHash+core)`；`automation.test.mjs` |
| 自动化·写步骤审计包 | 点「审计包（E11）」 | `AutomationPage.tsx:93` | `GET /api/automation/runs/:id/audit-bundle`（`server.mjs:3582-3588`） | ✅ | before/after 截图 sha256 + chain.ok：`artifacts/e11-audit-bundle/` |
| 自动化·中断扫描 | 扫描中断 run | `AutomationPage.tsx:135` | `GET /api/automation/recovery`（`server.mjs:3475`） | ✅ | 历史证据 2026-10-20：`artifacts/e7-recovery/real-recovery-scan-20261020.json` |
| 自动化·安全重放 | 只读 run 一键重放 | `AutomationPage.tsx:147` | `POST /api/automation/runs/:id/replay`（`server.mjs:3538-3570`） | ✅ | 仅全程只读放行（`server.mjs:3546-3551`），写过的标 needs_human |
| 自动化·目标编排 | 生成配方序列 | `AutomationPage.tsx:107` | `POST /api/automation/orchestration/plan`（`server.mjs:3459`） | ✅ | 只出计划、不执行：`artifacts/e10-orchestration/real-plans-20261020.json` |
| 自动化·失败恢复建议 | 取恢复建议 | `AutomationPage.tsx:121` | `POST /api/automation/orchestration/failure`（`server.mjs:3467`） | ✅ | `decideFailureRecovery`，写动作禁止自动重放 |
| 自动化·暂停时执行 | 暂停写入后签发/运行 | `AutomationPage.tsx:170,200`；`PlacementPage.tsx:101-130` | 无暂停校验（grep 0） | 🟥 | §2.1 |
| 知识库·列表筛选 | 检索知识 | `KnowledgePage.tsx:65` | `GET /api/knowledge/entries`（`server.mjs:1553-1567`） | ✅ | 安装版 392 条（2026-10-26 只读检查 `.../state/knowledge`） |
| 知识库·新增候选 | 提交候选 | `KnowledgePage.tsx:116` | `POST /api/knowledge/entries`（`server.mjs:1553+`） | ✅ | API 层强制 candidate（`knowledge-api.mjs:59`） |
| 知识库·审核 | 填审核人点通过/驳回 | `KnowledgePage.tsx:72` | `POST /api/knowledge/:id/review`（`server.mjs:1567-1571`） | ✅ | `reviewedBy` 必填（`knowledge-api.mjs:63-68`）；下游无消费者（§2.2） |
| 知识库·健康/冲突 | 打开概览 | `KnowledgePage.tsx:49-58` | `GET /api/knowledge/{review-queue,health,conflicts}`（`server.mjs:1571-1577`） | 🟨 | 指标真算，但 approved=0 时冲突恒空（`knowledge-pipeline.mjs:73-77`） |
| 知识库·过期/健康消费者 | 看过期数 | `KnowledgePage.tsx:266` | `knowledge-pipeline.mjs:56,84-87` | 🟨 | 只展示，不阻断任何流程 |
| 知识库·RAG 重建 | 点重建索引 | `KnowledgePage.tsx:82` | `POST /api/rag/reindex`（`server.mjs:1596`） | ✅ | 安装版索引 2026-10-22：479 docs / 3376 chunks（`state/rag/index.json`） |
| 知识库·RAG 检索 | 输入问题检索 | `KnowledgePage.tsx:90` | `POST /api/rag/query`（`server.mjs:1600`） | ✅ | `runtime/__tests__/rag.test.mjs` 6 条 |
| 知识库·RAG 同步 | 新增/审核后检索 | 无失效信号（`rag/store.mjs:71-72`；`server.mjs:1553-1580`） | — | 🟨 | 需手动重建（§2.4） |
| 知识库·KMA 手动运行 | 点采集/维护 | `KnowledgePage.tsx:98` | `POST /api/knowledge/agent/run`（`server.mjs:1584`） | ✅ | 只产 candidate（`agents/knowledge-manager.mjs`） |
| 知识库·KMA 定时 | 自动运行 | `runtime/knowledge-scheduler.mjs`；`server.mjs:517-534` | 间隔 24h、初始 2min | 🟨 | 默认自动开 + web 采集默认开（§2.5） |
| 知识库·badcase | 查看 badcase | `KnowledgePage.tsx:109` | `GET /api/knowledge/badcases`（`server.mjs:1607`） | ✅ | 证据根目录真实（`artifacts/evidence/`，含 knowledge 备份） |
| 知识库·候选→门禁引用 | 审核通过后期望被门禁采用 | 无消费者 | 无 gate/API 调用 `isUsableForGate` | 🟥 | §2.2 |
| 知识库·AI 对话引用知识 | 对话里用知识作答 | `runtime/chat.mjs` 无 RAG/knowledge | 无 | 🟥 | 仅手动检索页；orchestrator 未接线（§2.2） |
| 知识库·RAG 命中审核状态 | 看命中列表 | `KnowledgePage.tsx:227-240` | 无 | 🟥 | `corpus.mjs:33` 有 `meta.review/trust`，UI 未展示（§2.8） |
| 项目·列表/切换 | 切换项目 | `ProjectsPage.tsx`；`AppContext.tsx:329-380` | `GET /api/project-state` / `/api/projects/:id/state`（`server.mjs:1414`） | ✅ | `runtime/__tests__/project-isolation.test.mjs` 3 条 |
| 项目·新建/编辑 | 新建项目 | `ProjectsPage.tsx:58-71` | `PUT /api/project-state`（`server.mjs:1395`） | 🟨 | 无项目领域 API，靠聚合状态落盘 |
| 项目·多项目隔离 | 两项目并行编辑 | `AppContext.tsx:396-404` 切面写入 | `PUT /api/projects/:id/state`（`server.mjs:1423`） | ✅ | 历史证据 2026-10-20 fail-closed：`artifacts/c6-isolation/` |
| 项目·重启恢复 | 重启后继续 | `AppContext.tsx:283-398` | `project-state.json` + `project-states/` | ✅ | 历史证据 2026-10-19：`artifacts/c1-project-state/real-machine-persistence-20261019T121342Z.json`，本轮未复验 |
| 项目·追溯三件套 | 版本/修改/审计 | `VersionsPage` | `GET/PUT /api/trace-state`（`server.mjs:1372-1395`） | ✅ | `trace-state-http.test.mjs` 2 条；上限 500/2000/2000 |
| 项目·问题记录 | 问题持久化 | `VersionsPage`/`OverviewPage` | `GET/PUT /api/issue-state`（`server.mjs:1378-1393`） | ✅ | `issue-state.test.mjs` 3 条 |
| 项目·EDA 绑定校验 | 点「校验绑定」 | `ProjectsPage.tsx:79-90` | `GET /api/projects/:id/binding/verify`（`server.mjs:1430-1480`） | ✅ | 逐项比对并列出 mismatches；不匹配不误写 |
| 项目·阶段推进 | 点「推进阶段」 | `ProjectsPage.tsx:100-139`；`stageMachine.ts` | 无 Runtime 阶段 API（前端权威） | 🟨 | 证据不持久 + 跨项目（§2.3） |
| 概览·阶段/计数 | 打开概览 | `OverviewPage.tsx:19-35,70-83` | 读本地 `state` | 🟨 | 验证计数来自 demo（`ValidationPage.tsx:300,315`），`progress` 静态（`ProjectsPage.tsx:64`） |
| 项目·EDA 文档绑定 | 记住当前 PCB 文档 | `services/edaWorkspaceStore.ts:1-77` | localStorage（无 Runtime） | ✅ | UUID 校验 + 按项目隔离 + 插拔后以读回指纹为准 |
| 项目·localStorage vs Runtime | 清缓存/换机器 | `AppContext.tsx:157-183,283-330` | 空不覆盖本地的合并策略 | 🟨 | 双写可短暂漂移（有意策略，见 §4） |
| 设置·Provider 列表 | 打开设置 | `SettingsPage.tsx:131` | `GET /api/providers`（`server.mjs:1627-1645`） | ✅ | `runtime/__tests__/providers.test.mjs` |
| 设置·保存/撤销 Key | 保存 API Key | `SettingsPage.tsx:183,204` | `POST/DELETE /api/providers/:id/key`（`server.mjs:1684-1696`） | ✅ | 钥匙串存取 + 回读校验（`keychain.mjs`）；`keychain.test.mjs` 8 条；Key 不进 localStorage |
| 设置·连接测试 | 点「测试连接」 | `SettingsPage.tsx:211` | `POST /api/providers/:id/test`（`server.mjs:1697`） | ✅ | 真打 modelsUrl，401→`PROVIDER_UNAUTHORIZED`（`providers.mjs:164-200`） |
| 设置·账号登录/控制台 | CLI 登录、开控制台 | `SettingsPage.tsx:163,191` | `POST .../login`（`server.mjs:1679`）、`.../console`（`server.mjs:1705`） | ✅ | `providers.mjs:122-136` 起 CLI 登录进程 |
| 设置·自定义 Provider | 新建/删除/探测模型 | `CustomProviderEditor.tsx:243-377` | `PUT/DELETE /api/custom-providers`（`server.mjs:1635-1690`） | ✅ | 持久化不含密钥；`custom-providers-http.test.mjs` 4 条 |
| 设置·外发清单/脱敏预览 | 看清单/预览 | `SettingsPage.tsx:220-252` | `GET /api/provider/egress`（`server.mjs:1534`）、`POST .../preview`（`1537`） | 🟨 | 4 个外发端点真实，但漏 KMA 抓取通道（§2.5） |
| 设置·联网开关 | 打开/关闭联网 | `SettingsPage.tsx:351-356` | 无真实消费者（仅 `testResearch:256-266`） | ⬜ | 开关不控制任何功能（§2.5） |
| 设置·保存设置 | 保存 | `SettingsPage.tsx:277-291` | 无 `/api/settings`（grep 0）；localStorage（`AppContext.tsx:258-265`） | 🟨 | 换机器/清缓存后选中 Provider、暂停态丢失（§2.7） |
| 运维·诊断包 | 导出诊断包 | `SettingsPage.tsx:145` | `GET /api/diagnostics/bundle`（`server.mjs:1503`） | ✅ | `diagnostic-bundle-http.test.mjs`；历史证据 2026-10-20：`artifacts/h5-diagnostic/real-bundle-20261020.json` |
| 运维·统一失败诊断 | 任意失败→issue | `AppContext.tsx:527-559` | `POST /api/diagnostics/failure`（`server.mjs:1527-1534`） | ✅ | `failure-diagnosis.test.mjs`；Runtime 不可达退本地结构化记录（`AppContext.tsx:531-534`） |
| 运维·日志脱敏 | 查看/导出日志 | `runtime/logger.mjs`；`log-redaction.mjs` | 300 条内存 + 递归脱敏 | ✅ | `log-redaction.test.mjs` 6 条 + `logger.test.mjs` |
| 运维·桌面启动链路 | 打开 App | `src-tauri/src/lib.rs:19,109,138-157,171` | spawn sidecar → 等 4178 → token 走 stdin | ✅ | 打包 smoke（2026-10-20）：版本一致 0.2.0、sidecar 二进制可执行、runtime health 通过：`artifacts/h3-package/package-smoke-2026-10-20T06-46-07-742Z.json`；桌面窗口启动本轮未复验 |
| 运维·桌面日志轮转 | 长跑 | `lib.rs:31-34` | `runtime.log` 5MB 轮转 | 🟨 | 仅代码实现，无测试/本轮未复验 |
| 运维·CI | push/PR | `.github/workflows/ci.yml:19-94` | typecheck/vitest/runtime/audit/build/e2e + `cargo check` | ✅ | 两 job：`typecheck · unit · runtime · build · e2e`、`tauri rust compile check` |
| 运维·发布签名/公证 | 发版 | `package.json:24-28`；`scripts/check-macos-release.mjs` | 无 CI 发布流水线 | 🟨 | 仅本地 `desktop:release*` 脚本（§2.10） |
| 运维·双状态源 | dev ↔ 安装版 | `server.mjs:395`；`lib.rs:56-58,138`；`journal.mjs:43-46` | 两套 state/journal 根 | 🟨 | 安装版 392 条知识 vs 仓库 `artifacts/state` 无 `knowledge/`；journal 固定 `~/.circuitpilot`（§2.10） |

## 2. 断点/半打通明细（编号、用户视角、file:line、影响、建议修复、验收方式）

### 2.1 P0：写暂停（全局/会话）不进入 Runtime

- 用户视角：在设置里打开「全局暂停所有写入」，或在 EDA 页暂停本会话写入；随后到自动化页点「签发写板批准」→「运行配方」，或在布局页点「执行写回」——**照样能写板**。顶部徽标却显示「写入已暂停」（`Shell.tsx:37,44`），与行为矛盾。
- 证据（file:line）：暂停只在前端判定——`src/state/taskMachine.ts:37`、`EdaPage.tsx:120,234`、`Shell.tsx:44`、`LayerStackPanel.tsx:33`；`AutomationPage.tsx:170-184`（签发）与 `200-232`（运行）无判定；`PlacementPage.tsx:101-130` 无判定。运行时侧 `grep -rn writePaused runtime/ src-tauri/src scripts/` 源码 0 命中；签发路由 `server.mjs:3444-3456`、运行路由 `3480-3538`、布局写回 `2262-2285` 均不读暂停。暂停态也只存 localStorage（`AppContext.tsx:258-265`），服务端无副本。
- 影响：安全叙事「最高优先级门禁」不成立；脚本/curl 或任何页面都能绕过暂停写板。
- 建议修复：新增 Runtime 侧持久化 `writePaused`（或 `/api/settings`），在 `requireWriteApproval`（`server.mjs:693-708`）与 `approvals` 签发、automation run、placement/routing/repair 全部入口前置 fail-closed 返回 `EDA_WRITE_PAUSED`；UI 删除本地唯一判定，改为展示 Runtime 状态。
- 验收：runtime 测试——paused 时 `POST /api/automation/approvals`、`POST /api/automation/run`、`POST /api/eda/pcb/placement/apply`（dryRun:false）均 409 `EDA_WRITE_PAUSED`；页面冒烟断言暂停后按钮禁用且提示来自 Runtime。

### 2.2 P0：知识「approved→门禁/引用」闭环缺失（且 AI 对话不消费知识）

- 用户视角：在知识库把候选条目「通过」审核，期望它成为后续门禁/评审依据；实际上除颜色标签外没有任何东西使用 approved，RAG 检索也不区分候选/已审批。
- 证据（file:line）：UI 文案承诺 `KnowledgePage.tsx:151,245`；`isUsableForGate` 定义 `runtime/knowledge.mjs:484-491`，仅 `knowledge-api.mjs:46` 计数；`grep -rln knowledge runtime/gate-engine.mjs runtime/gates-service.mjs runtime/release-*.mjs runtime/production*.mjs runtime/placement*.mjs` = 0；引用闭环仅在 `runtime/agents/orchestrator.mjs`（`server.mjs` 未 import，`scripts/verify-knowledge-loop.mjs:13` 是唯一消费者）；`runtime/chat.mjs` 无 rag/knowledge。安装版运行态 392 条全 candidate、approved=0（2026-10-26 12:58 只读检查）；K7 文档自述为设计约束（`knowledge-k7-governance-2026-10-22.md:5,120`）。
- 影响：知识库只是「可审的文档柜」；门禁/建议/AI 都不会引用，审核通过与否对产品行为零影响；RAG 反而会把候选条目当依据返回（`runtime/rag/corpus.mjs:14` `includeExpired:true`，无 review 过滤）。
- 建议修复：定义至少一个真实消费者（如 release gate 的 PCB 规则/器件风险引用、ERC 修复建议、badcase 修复任务）调用 `isUsableForGate` 并写 `usage.jsonl`；RAG 过滤或标注 candidate；对话注入检索证据时带 review 状态。
- 验收：单测——未 approved 条目不进入 gate 建议；approved 后进入且 usage 有记录；RAG query 默认不返回 candidate（或返回时带 `review` 标记）。

### 2.3 P1：阶段机/概览证据不持久、跨项目污染、「验证→生产」死门禁

- 用户视角：项目 A 跑完 DRC/任务后切到项目 B，B 的阶段推进可能用上 A 的证据；重启应用后刚做过的证据消失，概览「设计进度/验证通过」长期停在种子数字。
- 证据（file:line）：`deriveStageEvidence` 用 `state.task.status`（`stageEvidence.ts:29-33`）与全局 `validations`（`:41-44`）；`ValidationCheck` 无 `projectId`（`types.ts:659-668`）；切换只改 id（`AppContext.tsx:56`）；`task`/`validations` 不在 project-state/trace-state（`AppContext.tsx:157-176,261-265` 只落 localStorage）；`grep source:'official'` 无写入者 → `drcPassed` 恒 false（`stageEvidence.ts:44`）；概览读同一份 demo validations（`OverviewPage.tsx:22-35`），`progress` 仅创建时写 12（`ProjectsPage.tsx:64`）+ 种子值，无更新消费者。
- 影响：阶段机可被错误证据推进/永久卡死；概览数字与 Runtime 证据脱钩；换机器/清缓存后"已完成的阶段证据"蒸发。
- 建议修复：`validations`/`task` 按项目归属并落 Runtime（或从 `/api/eda/*` 证据投影）；`deriveStageEvidence` 只读已持久化且能归属当前项目的证据；真实 DRC 路由写回 `source:'official'`；`progress` 由阶段/证据派生而非存储。
- 验收：单测——项目切换后 A 的证据不满足 B；重启后阶段与证据一致；官方 DRC 写入后「验证→生产」可推进；概览进度=派生值。

### 2.4 P1：RAG 索引不随知识/文档更新

- 用户视角：刚审核通过的知识、刚写的文档，在 RAG 检索里搜不到；只有手动「重建索引」后才出现。
- 证据（file:line）：`runtime/rag/store.mjs:71-72` 仅在 `chunks===0` 时懒构建；知识 save/review 路由（`server.mjs:1553-1580`）不触发失效；`corpusDigest` 只在构建时记录（`rag/index.json` 字段），查询不校验；安装版索引 `builtAt=2026-10-22`（只读检查），而知识/文档在此后仍有变化。
- 影响：「依据」过期，检索结果与知识库状态不一致；用户会以为知识已生效。
- 建议修复：知识 save/review 与文档变更后标 dirty（或增量更新），query 前校验 `corpusDigest`，不一致则重建并回报 `rebuilt:true`。
- 验收：新增 approved 条目后不手动重建即可检索到；测试覆盖 save→query 链路。

### 2.5 P1：「联网检索」开关无消费者；KMA 后台默认联网抓取

- 用户视角：设置里「联网检索」默认关闭，关闭后以为 AI 不会联网；实际后台知识 Agent 每 24h 自动抓取公网页面（初始 2 分钟即跑），且设置页的「测试」按钮在开关关闭时仍能联网。
- 证据（file:line）：`researchEnabled` 仅 `types.ts:758` + `SettingsPage.tsx:351-356`；唯一调用 `researchSearch` 的地方硬编码 `allowResearch:true`（`SettingsPage.tsx:261`）；AI 对话不调用检索（`runtime/chat.mjs` 无引用）；KMA web 默认启用（`server.mjs:517-534`，`CIRCUITPILOT_KNOWLEDGE_WEB` 默认非 off），`collectors/pcb-web.mjs` 直接 `searchWeb/fetchPage`，绕过 `/api/research/*` 的 `allowResearch` 闸（`server.mjs:1610-1620`）；`GET /api/research/status` 硬编码 `enabled:false`（`server.mjs:1623-1625`）。
- 影响：用户的「关闭联网」不生效，公网请求与设置声明不一致；外发清单（G4）只列 4 个 provider 端点，未列该通道。
- 建议修复：KMA 采集读取 Runtime 持久化开关（与 Provider 设置同源）；`research/status` 返回真实状态；`provider-egress.mjs` 增加 `knowledge.web` 通道；若 AI 不打算用 research，删除开关或接入对话。
- 验收：关闭开关后 KMA run 不发起网络（注入 fetchImpl 断言 0 调用）；`/api/research/status` 与真实一致；egress 清单含该通道。

### 2.6 P1：写入互斥只覆盖自动化，跨通道并发写同一文档

- 用户视角：自动化运行中，另一个页面（布局写回/布线/修复）或脚本仍能同时写同一 EDA 文档；一次性批准无法阻止并发交错。
- 证据（file:line）：`automationRunLock` 创建 `server.mjs:486`，仅用于运行时 `3491` 与重放 `3555`；其他写路径 `requireWriteApproval`（`server.mjs:693-708`）有批准校验但无锁——`/api/eda/pcb/placement/apply`（`2262-2285`）、`/api/eda/commands/:id`（`1721-1735`）、routing/repair 等直接 `bridge.execute`。
- 影响：两路写同一文档时读回/回滚可能互相踩踏，证据链失真；单写锁叙事（E7）只在自动化配方内成立。
- 建议修复：Runtime 级按 `projectUuid|pcbUuid` 的写互斥（覆盖所有 `requireWriteApproval` 路径），冲突返回 `EDA_WRITE_BUSY`。
- 验收：并发两个写请求，一个 409；自动化运行中发起 placement apply 被拒；测试覆盖。

### 2.7 P2：Provider/安全设置无 Runtime 权威副本，运行模式两套口径

- 用户视角：换机器/清缓存后，刚选的第三方 Provider、模型、「暂停写入」都回到默认；顶部「真实只读/受控写入」徽标在不同页面刷新后互相矛盾（实际 `controlled_write` 从不被设置）。
- 证据（file:line）：设置只经 `SET_SETTINGS` 落 localStorage（`AppContext.tsx:258-265`；`SettingsPage.tsx:277-291`），全仓无 `/api/settings`（grep 0）；`runtime.mode` 由 AppContext 按「任一 provider ready」算（`AppContext.tsx:469`），Settings 刷新按「EDA 已连接且非 demo 窗口」算（`SettingsPage.tsx:116`）；`Shell.tsx:36` 的 CONTROLLED WRITE 永不出现（只有 seed `task.mode` 是 controlled_write，与 runtime.mode 无关）。
- 影响：同一事实两个状态源；换机器后 Key 还在钥匙串但选择丢失；徽标不可作为写权限判断依据。
- 建议修复：Runtime 增加 `GET/PUT /api/settings`（只存非敏感配置）；`mode` 单一计算；Shell 徽标改为读 Runtime 的 EDA 指纹+暂停状态。
- 验收：清 localStorage 后 Provider/暂停态恢复；两处 mode 一致；UI 测试断言徽标取值唯一来源。

### 2.8 P2：RAG 命中不展示审核/可信状态，候选被当「依据」

- 用户视角：RAG 检索结果里知识条目与文档混排，看不出该条是 candidate 还是 approved、可信等级如何、是否过期。
- 证据（file:line）：`corpus.mjs:33` 已把 `review/trust` 放进 `meta`，但 `KnowledgePage.tsx:227-240` 只显示分数/类型/来源；`corpus.mjs:14` 语料包含 candidate 与过期条目。
- 影响：候选条目可能被复制进设计说明/评审材料，形成"伪依据"。
- 建议修复：命中行展示 review/trust/expired 徽标；candidate 默认折叠或标黄，并提示"未审核，不可作为放行依据"。
- 验收：RAG 命中列表对 candidate 显示警示；UI 测试断言。

### 2.9 P2：自动化配方无 dry-run/预演

- 用户视角：写配方第一次点「运行」就是真写（需批准）；页面只有静态步骤清单，没有"这次会改什么/预计几步/风险点"的预演。
- 证据（file:line）：`AutomationPage.tsx:329-337` 仅渲染步骤；`server.mjs:3441-3500` 无 preview 路由；`grep 预演|dry-run` 在 `runtime/automation/**` 无命中（dry-run 仅在批量落件/布局等其它功能）。
- 影响：用户在批准前无法确认影响面，只能依赖配方标题/摘要。
- 建议修复：新增 `POST /api/automation/recipes/:id/preview`（只读：解析参数、检查批准/指纹、列出步骤与预期读回，不执行、不写 journal），UI 增加「预演」按钮。
- 验收：预演不产生 `run.start` 与 bridge 写命令；参数错误/缺批准在预演阶段即报出。

### 2.10 P2：运维数据双状态源与发布链路缺口

- 用户视角：开发态（`npm run dev:full`）看到的自动化历史/知识库，与安装版 App 里看到的不是同一份；卸载/迁移后自动化审计历史与知识库可能"消失"；发版依赖本机脚本，CI 无签名/公证流水线。
- 证据（file:line）：state 根——开发 `artifacts/state`（`server.mjs:395`）vs 桌面 app data（`lib.rs:56-58,138`）；journal 固定 `~/.circuitpilot/automation-runs`（`journal.mjs:43-46`），不随 stateDir；安装版 app data 有 392 条知识而仓库 `artifacts/state` 无 `knowledge/`（本轮只读检查）；CI 仅 `.github/workflows/ci.yml` 两个 job，无 tag 发布/签名流程（本地脚本 `package.json:24-28`、`scripts/check-macos-release.mjs`）。
- 影响：排障时"证据在他处"；用户数据边界（卸载是否删审计）不明确；发版仍需人工。
- 建议修复：journal 跟随 `CIRCUITPILOT_STATE_DIR`（保留 env 覆盖）；文档明确"哪些数据随 App 删除"；补 tag 触发的 macOS 签名/公证 workflow（或至少 CI 跑 `desktop:release-check`）。
- 验收：安装版与开发态路径约定成文；`CIRCUITPILOT_STATE_DIR` 下能找到 journal；发布 workflow 存在并跑通（历史/待确认）。

## 3. 已确认打通（附证据）

- **自动化执行内核**：配方 schema/参数预检/一次性批准/逐步读回/哈希链/失败策略/中止/重放均有 runtime 实现与测试（`runtime/automation/*.mjs`、`runtime/__tests__/automation-http.test.mjs` 6 条、`runtime/automation/automation.test.mjs`）；历史真机证据（2026-10-19）R1/R2/R6 `completed`、写批准一次性/过期/指纹变更均被拒：`artifacts/r2-r6-acceptance/`、`artifacts/automation-phase1-smoke.json`（本轮未复验）。
- **写批准边界**：服务端签发、绑定 `windowId|projectUuid|documentUuid` 指纹、TTL 30min、一次性消费、签发与消费进同一哈希链（`runtime/automation/approvals.mjs`；`server.mjs:3444-3456,693-708`）；无批准的真实写返回 409（`automation-http.test.mjs`）。
- **自动化恢复/审计包/编排**：只读 run 才允许重放（`server.mjs:3546-3551`）；审计包含 before/after 截图 sha256 与 chain 校验（`runtime/automation/audit-bundle.mjs`）；目标编排只出计划不执行（`runtime/automation/orchestration.mjs`；证据 `artifacts/e10-orchestration/real-plans-20261020.json`、`artifacts/e11-audit-bundle/`）。
- **项目持久化与隔离**：`project-state.json` 原子写 + 有界规范化 + fail-closed（`runtime/project-state.mjs`、`store.mjs`）；项目切面 `PUT/GET /api/projects/:id/state` 带跨项目实体校验（`runtime/__tests__/project-isolation.test.mjs` 3 条；历史证据 `artifacts/c6-isolation/real-runtime-failclosed-20261020.json` 404/400）；重启恢复真机证据（2026-10-19）`artifacts/c1-project-state/`（本轮未复验）。
- **追溯与问题持久化**：trace-state 校验 id 唯一/有界截断（500/2000/2000）、issue-state 同构（`trace-state-http.test.mjs` 2 条、`issue-state.test.mjs` 3 条）。
- **知识存储与审核闸**：原子写/哈希校验/review 状态机/冲突只比 approved/过期判断（`runtime/knowledge.mjs`）；API 写入只能是 candidate、审核必须带 `reviewedBy`（`knowledge-api.mjs:59,63-68`；`knowledge-api.test.mjs` 5 条）。
- **RAG 混合检索**：BM25 + 特征哈希向量、语料上限与注入式文件系统（`runtime/rag/*`；`rag.test.mjs` 6 条；安装版索引 2026-10-22 479 docs/3376 chunks）。
- **Key 只在钥匙串**：macOS `security` CLI 存取 + 回读校验（`runtime/keychain.mjs`；`keychain.test.mjs` 8 条）；前端与自定义 Provider 注册表均不落密钥（`SettingsPage.tsx` 无 localStorage 写 Key；`runtime/customProviders.mjs` 无 key 字段）。
- **Provider 目录/测试/登录/自定义/外发清单**：声明表 16 个 provider（`runtime/providers.mjs:12-25`）；测试打真实 models 端点并按 401/429 映射错误；CLI 登录进程；自定义 Provider CRUD 与模型探测（`custom-providers-http.test.mjs` 4 条；`providers.test.mjs`）；4 个外发端点与脱敏预览（`provider-egress.mjs`）。
- **失败诊断与日志脱敏**：`POST /api/diagnostics/failure` 统一翻译为 issue（`runtime/failure-diagnosis.mjs`；`failure-diagnosis.test.mjs`），UI 不可达时退本地记录（`AppContext.tsx:531-534`）；`log-redaction.mjs` 覆盖 Bearer/JWT/Key/URL token/邮箱/路径且有长度/深度上限，`logger.mjs` 全量脱敏 + 300 条环形缓冲（`log-redaction.test.mjs` 6 条 + `logger.test.mjs`）。诊断包有界/去敏/带 bundleHash（`diagnostic-bundle-http.test.mjs`；历史证据 `artifacts/h5-diagnostic/real-bundle-20261020.json`）。
- **桌面壳启动链路**：Rust spawn sidecar Node + `runtime/server.mjs`，等待 `127.0.0.1:4178` 就绪，token 走 stdin（`CIRCUITPILOT_TOKEN_STDIN=1`）、`CIRCUITPILOT_STATE_DIR` 指 app data、WebView `initialization_script` 注入 token、退出 kill child（`src-tauri/src/lib.rs:19,31-34,56-58,109,138-157,171,184`）；打包 smoke 历史证据（2026-10-20）：版本一致 0.2.0 + sidecar 启动 + runtime health 通过（`artifacts/h3-package/package-smoke-2026-10-20T06-46-07-742Z.json`）；`beforeDevCommand` 先 stage sidecar（`src-tauri/tauri.conf.json`）。
- **CI 基线**：typecheck → vitest 覆盖率门禁 → runtime node:test → `npm audit --omit=dev` → build → playwright chromium e2e；另有桌面 `cargo check` job（`sidecar:stage` 后）（`.github/workflows/ci.yml:19-94`）。

## 4. 本轮未复验/限制

1. **EDA/Bridge 未启动**：自动化配方与写批准的真机行为、DRC/布局写回、`/api/eda/*` 路由只按源码与历史证据判定；R2/R6/R1、隔离/重启持久化等结论均为「历史证据（2026-10-19/20），本轮未复验」。
2. **未跑测试与服务器**：未执行 `npm test` / `npm run test:runtime` / playwright，未启动 4177/4178；测试条数为静态 `grep` 计数，不代表本轮全绿。
3. **只读检查了本机安装版状态**（`~/Library/Application Support/com.circuitpilot.desktop/state`，2026-10-26 12:58 最后写入）：392 条知识全部 candidate、approved=0；RAG 索引 builtAt 2026-10-22；`/Applications/CircuitPilot.app` 为 0.2.1（本仓 0.2.0，构建来源不同，未复验其资源完整性）。
4. **「首次启动项目切面竞态」待确认**：切换项目时若 `GET /api/projects/:id/state` 在聚合写回（800ms 防抖）之前返回 404，`AppContext.tsx:367-375` 会清空工作集并可能在随后写回空切面；本轮未启动 Runtime，无法复现，标记「待确认」。
5. **「advance 阶段后 progress 是否更新」等 UI 细节**：`progress` 无更新消费者已核实；`stageBeforeArchive` 等归档路径未逐页复验。
6. **打包资源清单待确认**：`tauri.conf.json` resources 含 `docs/implementation`、`docs/wardrobe-case` 但不含 `docs/knowledge`，而 RAG 语料目录含 `docs/knowledge`（`server.mjs:540`）；安装版是否因此少检索 K1 文档需重新打包后复验（本轮安装包来源不同，标待确认）。
7. **P0/P1 判定口径**：本轮按「UI→API→runtime 实现 + 测试/带日期证据」判 ✅；自动化真机证据为历史记录，未声称本轮实测。
