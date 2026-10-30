# 04 · 平台支撑链复审（自动化 / 写暂停 / 知识库 / RAG / 项目持久化）

> **修复收口（2026-10-29 晚）**：本文件是复审当时的证据与问题清单；所列 P0/P1 已在本轮"请全部修复"中逐项落地，当前状态以 `../flow-gap-audit-2026-10-29.md` §0.1 为准。下文保留原始判定以说明修复对象，不代表仍未解决。


> **范围**：CircuitPilot 平台支撑链的"修复后复审"（P0-8 全局写暂停、P0-9 知识→门禁引用，附带自动化运行/恢复/重放、RAG 索引与语料、项目持久化、Provider/诊断抽查）。
> **方法**：只读代码核对 + 只读数据扫描 + 隔离环境单文件测试 + 临时进程 HTTP 探针（自建 fake bridge，不接触真实 EDA）。
> **判定标准**：`✅ 打通` = 有 UI→API→Runtime 实现、有可复现自动化测试或本轮探针证据；`🟨 半通` = 主路径存在但存在边界/数据不闭合；`🟥 断` = 宣称存在但实际不生效/绕得过；`⬜ 未实现`。历史真机证据标注「历史证据（日期），本轮未复验」。
> **只读声明**：本轮未改 `src/`、`runtime/`、`scripts/`、`e2e/`，未启动/重启 4177/4178 服务，未执行任何 EDA/bridge 写命令，未使用 Playwright，未做 git 操作；唯一写入为本文件（以及测试/探针在临时目录生成的产物）。
> **基线**：工作树为 2026-10-29 修复后状态；旧审计见 `docs/implementation/flow-gap-audit-2026-10-26.md`（§2.5 记录 P0-8/P0-9「已修复」）。
> **结论摘要**：P0-8 **主体成立**（真设计写路由暂停后全部 409；三文件 11/11 测试 + 本轮探针复核），但仍有 **2 个 P0 边界**（权威门禁文件损坏即静默 fail-open = P0-A；会话级"暂停本会话写入"仍是前端自觉 = P0-B）。P0-9 **只算结构接通**：`approved→建议→usage` 的代码/测试都在，但真实语料下 `knowledgeAdvice` **恒空**，审核通过对产品行为仍无可见影响 → 不能标 ✅（列 P0-C）。另有 8 项 P1（影响排序见 §3）。

---

## ① 流程节点表

### A. 自动化（配方 → 批准 → 运行 → 中止/恢复/重放/审计）

| # | 节点 | 实现位置（file:line） | 状态 | 证据/说明 |
|---|---|---|---|---|
| A1 | 配方注册与审批需求推导（含 `requiredApprovals`） | `runtime/automation/recipes.mjs:234-252` | ✅ | 未知 scope 直接 fail；R1 `eda-open-project` 显式 `requiredApprovals:['write']`（`recipes.mjs:368-380`） |
| A2 | 参数预检（缺参数 0 步执行） | `runtime/automation/runner.mjs:163-175` | ✅ | 缺参数返回 `needs_params`，不触碰 EDA |
| A3 | 缺批准 → 0 步执行 | `runtime/automation/runner.mjs:189-192` | ✅ | `needs_approval` + `requiredApprovals`/`missingApprovals` |
| A4 | 运行主循环（步骤执行/读回/中止信号） | `runtime/automation/runner.mjs:199-220` | 🟨 | 每步有 abort 检查，但**无写暂停复核**（见 §2 P0-8 边界 4 / §3 P1-2） |
| A5 | 运行互斥 + runId 幂等 | `runtime/server.mjs:529,3631-3641` | ✅ | 单写锁只覆盖自动化运行（跨模块见 §3 P1-3） |
| A6 | 中止在途运行 | `runtime/server.mjs:3716-3725` | ✅ | abort 路由不在写暂停名单，暂停期仍可收口（合理） |
| A7 | 中断恢复扫描 | `runtime/server.mjs:3620-3622` + `runtime/automation/recovery.mjs:50-100` | ✅ | 终态/未知配方/已写动作分级，给出 verdict |
| A8 | 只读重放 | `runtime/server.mjs:3683-3714` + `recovery.mjs:38-46,138-143` | ✅ | 仅 `readonly_replayable` 放行；配方含 GUI 兜底/写步骤/人工步骤一律拒绝 |
| A9 | 审计包导出 | `runtime/server.mjs:3727-3737` | ✅ | `buildRunAuditBundle` 汇总 journal/写步骤 |
| A10 | 编排计划 / 失败恢复决策 | `runtime/server.mjs:3604-3619` | ✅ | 只产出计划与建议，不执行写 |
| A11 | 在途 run 遇全局暂停 | `runtime/automation/runner.mjs:199`（无 gate 调用） | 🟥 | 暂停只拦"启动新 run"，已启动 run 会继续写（见 §3 P1-2） |
| A12 | journal 落盘位置 | `runtime/automation/journal.mjs:37-39` | 🟨 | 默认 `~/.circuitpilot/automation-runs`，不随 `CIRCUITPILOT_STATE_DIR`（Tauri 只注入 STATE_DIR：`src-tauri/src/lib.rs:56-58,138`）→ 旧 P1-15 仍在 |

### B. 写暂停（全局门禁 + 会话开关 + UI 镜像）

| # | 节点 | 实现位置（file:line） | 状态 | 证据/说明 |
|---|---|---|---|---|
| B1 | 设置页开关 → Runtime 落盘（失败关闭） | `src/pages/SettingsPage.tsx:292-305` | ✅ | Runtime 不可达/拒绝时**不改本地**并 danger 提示 |
| B2 | `GET/POST /api/write-gate` | `runtime/server.mjs:1462-1480` | ✅ | POST 故意不在 `EDA_WRITE_ROUTES`，保证暂停后还能恢复 |
| B3 | 磁盘权威 + 版本号 + 原子写 | `runtime/write-gate.mjs:56-75` | ✅ | tmp + rename，写失败抛错（不会"内存改了重启又放行"） |
| B4 | 加载/损坏/不可读处理 | `runtime/write-gate.mjs:24-41` | 🟥 | 只记录 `loadError`，`paused` 保持 false → **fail-open**（见 §2 P0-8 边界 1 / §3 P0-A） |
| B5 | 分发前统一门禁（含新增写路由防漏） | `runtime/server.mjs:1460` + `767-771` | ✅ | 18 条 `EDA_WRITE_ROUTES`（`server.mjs:138-158`）全覆盖 |
| B6 | 写批准路径同样过门禁 | `runtime/server.mjs:773-779` | ✅ | `requireWriteApproval` 先 `assertEdaWritesOpen`；12 个调用点（其中 11 个在 Set 路由内，`evidence/retention/prune` 属破坏性证据删除、经此路径间接受暂停约束） |
| B7 | GUI 通道按动作放行（仅 state/screenshot 只读） | `runtime/server.mjs:3508-3517` | ✅ | `eval` 另受 `CIRCUITPILOT_ALLOW_GUI_EVAL` 限制；非白名单动作暂停期 409 |
| B8 | 重启保留 | `runtime/__tests__/write-gate-http.test.mjs:113-127` | ✅ | 两个独立 Runtime 进程共享磁盘状态，第二轮仍 paused |
| B9 | UI 镜像以 Runtime 为准 | `src/state/AppContext.tsx:329-338` | 🟨 | 只取 `gate.paused`，`loadError` 与旧 Runtime 404 都被 `.catch(()=>undefined)` 吞掉（见 §3 P1-4） |
| B10 | 写入按钮禁用 | `AutomationPage.tsx:319-320`、`PlacementPage.tsx:105,224`、`LayerStackPanel.tsx:33`、`EdaPage.tsx:120-123` | 🟨 | 主页面已接；`RoutingWritePanel`、`ValidationPage` 修复、`PartProposalPage` 批量落件未接（见 §3 P2-3） |
| B11 | 会话级"暂停本会话写入" | `src/pages/EdaPage.tsx:623`、`src/state/taskMachine.ts:37`、`src/components/Shell.tsx:44` | 🟥 | 仅 `dispatch(PATCH_EDA)` 改前端状态；Runtime 无对应概念（见 §3 P0-B） |
| B12 | 门禁状态缓存/多实例 | `runtime/write-gate.mjs:24-25` | 🟨 | 每进程只 load 一次；外部/第二个进程改文件本进程看不到（单 Runtime 部署下影响低，P2-7） |
| B13 | dryRun 只读预演 | `runtime/server.mjs:2406,2504` | 🟥 | `dryRun:true` 也被整条路由 409 拦下（实测，见 §2 边界 3 / §3 P2-1） |

### C. 知识库 → 门禁建议 / usage；RAG 语料与索引

| # | 节点 | 实现位置（file:line） | 状态 | 证据/说明 |
|---|---|---|---|---|
| C1 | 采集/AI 只能写候选 | `runtime/knowledge-api.mjs:54-63`、`runtime/agents/knowledge-manager.mjs:111` | ✅ | API 强制 `reviewState:'candidate'`；agent 同样 candidate |
| C2 | 人工审核（reviewedBy 必填） | `runtime/knowledge-api.mjs:65-73`、`runtime/knowledge.mjs:455-480` | ✅ | 无审核人/非法状态拒绝；UI 有审核入口 |
| C3 | 门禁准入判定 | `runtime/knowledge.mjs:486-492` | ✅ | trust≠unverified + approved + createdAt + 未过期 |
| C4 | 建议构建（按 reason code 检索 + 去重 + 上限） | `runtime/knowledge-gate-advice.mjs:32-70` | ✅ | 只用 `isUsableForGate` 条目；非可用计入 `unusableSkipped` |
| C5 | status 接线（只读，不写 usage） | `runtime/server.mjs:1651-1655` | 🟨 | `record:false`；页面默认"重新读取"走这里 |
| C6 | evaluate 接线（归档报告 + 写 usage） | `runtime/server.mjs:1656-1660` | ✅ | 集成断言在 `runtime/__tests__/gates-p05-http.test.mjs:83-113` |
| C7 | usage 写入 | `runtime/knowledge-gate-advice.mjs:64-68` | 🟨 | 失败被吞，返回体无 `usageRecorded` 标记（P2-5） |
| C8 | usage 读取/产品可见性 | `runtime/server.mjs:1692-1695`；`src/services/runtimeClient.ts` 无 usage 方法 | ⬜ | API 有、UI 无；"谁用了哪条知识"产品界面查不到（P2-5） |
| C9 | 真实语料命中 | 本轮只读扫描（§4 记录 6） | 🟥 | `artifacts/knowledge` 408 条 / approved 0 / 含 `GATE_` 0 条 → 建议恒空（§3 P0-C） |
| C10 | RAG 语料排除过期 | `runtime/rag/corpus.mjs:14-19,89` | ✅ | 单测覆盖（`knowledge-gate-advice.test.mjs:91-112`） |
| C11 | RAG 命中带 review/trust/gateUsable/expired | `runtime/rag/corpus.mjs:38`、`src/pages/KnowledgePage.tsx:236-247` | ✅ | 前提是索引按新语料重建；旧索引见 C12 |
| C12 | RAG 索引随知识/文档更新失效 | `runtime/rag/store.mjs:60-77`、`runtime/rag/index.mjs:15,168` | 🟥 | 只在空索引时懒构建；`schemaVersion` 未 bump → 升级后继续用旧索引（§3 P1-1） |
| C13 | 对话/Agent 消费知识 | `runtime/chat.mjs` 0 引用知识/RAG；`runtime/agents/orchestrator.mjs:48` 未被 `server.mjs` import | 🟥 | 引用校验器 `knowledge-citations.mjs:27-33` 只在脚本/测试中用（§3 P1-5） |
| C14 | 引用格式校验（approved 才可引用） | `runtime/agents/knowledge-citations.mjs:20-33` | 🟨 | 逻辑正确，但没有产品入口消费 |

### D. 项目持久化 / Provider / 诊断（本轮只抽查）

| # | 节点 | 实现位置（file:line） | 状态 | 证据/说明 |
|---|---|---|---|---|
| D1 | 项目状态 GET/PUT | `runtime/server.mjs:1482-1514` | ✅ | 本轮只读核对路由存在、参数校验与 scoped 兼容分支 |
| D2 | 原子写 + 损坏不假装成功 | `runtime/project-state.mjs:9`（注释契约）、`runtime/server.mjs:441-443` | ✅ | 历史证据：旧审计 2026-10-26 复核过 c1/c6；本轮未做真机复验 |
| D3 | 项目级切面隔离 | `runtime/server.mjs:441-443` + `src/state/AppContext.tsx:275-320` | ✅ | 切项目按 projectId 读切面；历史证据（2026-10-26） |
| D4 | Provider 目录/钥匙串/无盘上密钥 | `runtime/keychain.mjs`、`runtime/server.mjs:1742+` | ✅ | **历史证据（2026-10-20 打包 smoke / 2026-10-26 审计），本轮未复验**；本轮只抽查无新增落盘密钥代码 |
| D5 | 诊断包 | `runtime/server.mjs:1613` | ✅ | 历史证据（2026-10-20），本轮未复验 |
| D6 | 联网检索开关真实生效 | `src/pages/SettingsPage.tsx:369-374` vs `runtime/server.mjs:587,1741` | 🟥 | 开关只存前端；`/api/research/status` 硬编码 `enabled:false`；KMA 后台默认联网（旧 P1-10，§3 P1-6） |
| D7 | 桌面 sidecar/token/app-data | `src-tauri/src/lib.rs:56-58,138` | ✅ | **历史证据（2026-10-20 package smoke），本轮未复验** |

---

## ② P0-8 / P0-9 修复验证

### 2.1 P0-8「全局暂停所有写入」验证

**修复范围（旧审计 §2.5 声明）**：`runtime/write-gate.mjs` 磁盘权威状态 + `runtime/server.mjs` 写路由前置 409 + GUI 只读白名单 + `GET/POST /api/write-gate` + 设置页/自动化页/布局页禁用 + AppContext 镜像。

**逐条核验**

| # | 声明 | 证据（本轮只读核对/探针） | 结论 |
|---|---|---|---|
| 1 | 暂停状态由 Runtime 持久化，不是内存开关 | `write-gate.mjs:24-75`（读盘/原子写/version）；`write-gate-http.test.mjs:113-127` 两进程重启仍 paused；本轮 `node --test` 11/11 通过 | ✅ |
| 2 | 所有设计写路由分发前 409 | 18 条清单 `server.mjs:138-158`；前置判断 `server.mjs:1460`；测试覆盖 9 条代表路由 409+`details.reason`（`write-gate-http.test.mjs:75-100`，含 approvals/run/placement/repair/routing finish/layers/pcb|design execute/gui click）；本轮独立探针另复测 `placement/apply {dryRun:true}`、`schematic/repair`、`automation/run` 均为 `EDA_WRITE_PAUSED` | ✅ |
| 3 | 路由清单无漏网设计写入口 | 见 §2.2「漏网写路由排查」；`allowWrite:true` 调用点全部落在 Set 路由或桥写权拦截路径；探针：`POST /api/eda/commands/pcb.importChanges` 被 bridge 以 `EDA_WRITE_BLOCKED` 拒绝，写命令未到桥 | ✅ |
| 4 | GUI 非只读动作被挡，只读动作可用 | `server.mjs:3508-3517`；测试 `:93-98`（click 409、screenshot 不被 409）；`eval` 另需显式环境变量 | ✅ |
| 5 | UI 以 Runtime 为准，失败关闭 | `SettingsPage.tsx:292-305`（不可达/拒绝不落本地）；`AppContext.tsx:329-338` 镜像；`AutomationPage.tsx:319-320`、`PlacementPage.tsx:105,224` 禁用 | 🟨 主路径 ✅，但镜像吞错 + 3 处写入口未接（P1-4/P2-3） |
| 6 | 暂停写批准/运行写配方/布局写回 | 测试 `:75-100` + 本轮探针；`requireWriteApproval` 首行校验（`server.mjs:773-779`） | ✅ |
| 7 | 暂停后"连检查都做不了"的边界 | `server.mjs:1453-1458` 注释声明只读分析/文件导出/证据落盘不在名单；实测 `pcb/3d/export` 暂停期仍执行导出并写盘（见边界 3） | 🟨 设计如此，但 dryRun 预演被误挡与之矛盾 |

**边界漏洞（逐条）**

1. **【P0-A，新增】权威门禁文件损坏/不可读 → 静默 fail-open。**
   `write-gate.mjs:24-41`：`load()` 在 JSON 解析失败/EACCES/EISDIR 时只设置 `loadError`，`state.paused` 保持默认 `false`；`server.mjs:1462-1464` 把 `loadError` 一起返回；`AppContext.tsx:332-334` 只读 `gate.paused`，**UI 不提示、徽标显示"未暂停"**。
   本轮证据：模块探针（损坏 JSON / 目录占位）均 `paused:false` + `loadError`；HTTP 探针用损坏文件启动 Runtime，`GET /api/write-gate` 返回 `paused:false, loadError:"Expected property name..."`，随后 `POST /api/eda/gui/execute {action:'click'}` **穿过暂停门禁**（只因无 CDP 才在 400 `EDA_GUI_CDP_UNAVAILABLE` 失败）。
   影响：用户以为"写入已暂停"，实际所有写命令放行；一次磁盘损坏/手工编辑/权限变更就静默关闭最高优先级安全门禁。→ 列入 §3 P0-A。
2. **【P0-B】会话级"暂停本会话写入"仍是前端自觉。**
   `EdaPage.tsx:623` 的 Toggle 只 `dispatch(PATCH_EDA)`；`taskMachine.ts:37`、`Shell.tsx:44` 用它显示 `WRITE PAUSED`；`runtime/` 无任何对应状态（本轮 grep 仅 `settings.writePaused`/全局 gate）。影响：会话开关打开后，顶部徽标与 `canWrite` 会让用户相信"所有写命令已被阻断"，但 curl/脚本/自动化仍可写；且该开关的说明文案是"立即阻断所有写命令"。→ 列入 §3 P0-B。
3. **【P2-1，过度阻断】`dryRun:true` 预演与只读配方也被拦。**
   本轮探针（暂停态）：`POST /api/eda/pcb/placement/apply {dryRun:true}` → 409；`POST /api/automation/run {recipeId:'eda-read-state'}` → 409。原因：路由级整条门禁（`server.mjs:1460`）不区分 `dryRun`/配方只读性，与 `server.mjs:1453-1458` 注释"只读分析不在名单，暂停写入不能让人连检查都做不了"自相矛盾；`RoutingWritePanel` 的"预演"按钮在暂停期不可用。
   修法：门禁支持按请求体判定（`dryRun!==false` 跳过；`/api/automation/run` 允许 `isReadonlyRecipe` 配方）；验收：暂停时预演/只读配方成功，真实写仍 409。
4. **暂停不中断在途运行 → 暂停后仍写板（P1-2）。**
   `server.mjs:1460` 只在请求分发前检查；`runner.mjs:199-220` 每步没有 `assertEdaWritesOpen`，也无"暂停时 abort active runs"；而 `write-gate` 状态本身在 `server.mjs:438` 的 store 里，runner 完全可读。影响：点暂停后已启动的写配方继续落到下一步，顶部徽标与实际写入行为不一致。
   修法：runner 每步执行前调用 gate 检查（注入回调），或 `POST /api/write-gate {paused:true}` 时对 `activeRunControllers` 发 abort + 记录审计；验收：暂停后 1 个步骤内 run 变为 aborted，且 journal 有 `gate.paused` 事件。
5. **暂停不阻断"非设计写"文件入口（按设计，但需口径）。**
   实测暂停期 `POST /api/pcb/3d/export` 执行 `pcb.3d.export`（permission `validate`）并写出 `.step` 文件；同理 `production/export`（`production-export.mjs:75-76` 对 export-beta 传 `allowWrite:true`）、`eda/gates/evaluate|signoff`（`gates-service.mjs:46,71` 落证据）、`knowledge/*`、`rag/reindex`、`evidence/retention/prune`（`server.mjs:2981-2990`，`dryRun:false` 时经 `requireWriteApproval` 间接受暂停约束）。这些不会改 EDA 设计，但会在暂停期产生/删除文件；建议在设置页文案写明"只冻结设计写入口，不冻结导出/证据/知识落盘"（P2-2）。
6. **混合版本 UI 镜像（P1-4）。**
   `AppContext.tsx:329-338` 的 `.catch(() => undefined)`：旧 Runtime（本轮只读核对：安装版 `/Applications/CircuitPilot.app/Contents/Resources/runtime/server.mjs`（2026-10-26）grep `/api/write-gate` = 0 命中）或瞬时网络错误时，UI 保留 localStorage 里可能为 `true` 的镜像 → 徽标显示"已暂停"但旧 Runtime 可写；同时 `SettingsPage.tsx:292-305` 会拒绝本地改开关，用户无法在旧 Runtime 上解除误显示（只能升级或清 localStorage）。修复：404 时显式标记 `gateSupported:false` 并展示"该 Runtime 不支持写门禁"警告；网络错误展示"门禁状态未知"而不是静默保留旧值。
7. **单进程缓存（P2-7）**：`write-gate.mjs:24-25` 每进程只读一次磁盘；外部脚本/第二个实例改文件不生效（单 Runtime 部署影响小，但调试/多实例场景需按 mtime 或每次 `load()` 热校验）。

### 2.2 漏网写路由排查（任务第 1 项，结论：无漏网设计写路径）

排查方式：① 提取 `server.mjs` 全部 `method==='POST'` 路由；② 对每个路由追踪 `bridge.execute(..., {allowWrite:true})`/`writeFileSync`/manager 写方法；③ 与 `EDA_WRITE_ROUTES`(18 条)、`requireWriteApproval`(12 调用点，`server.mjs:2016,2111,2167,2198,2232,2406,2504,2524,2534,2569,2682,2990`)、`assertEdaWritesOpen` 交叉比对；④ 用 fake bridge + 暂停态 HTTP 探针验证是否真的能到桥。

- **设计写入口**：`placement-write.mjs:114,180`、`pcb-routing.mjs:800-1024,1817-1948`、`schematic-batch.mjs:203-224`、`schematic-repair.mjs:297-432`、`net-connect.mjs:206-391`、`design.mjs:321-385`、`pcb.mjs:340-521`、`server.mjs:2580,2589,2616,2696,2717,3476` 的 allowWrite 调用，均只能由 Set 内路由触发；`automation/recipes.mjs:419,450,486,491` 的写步骤只能由 Set 内 `/api/automation/run` 执行，replay 只放只读配方（`recovery.mjs:38-46,138-143`）。
- **通用命令路由**：`POST /api/eda/commands/:id`（`server.mjs:1836`）不在 Set，但 `bridge.execute(commandId, body)` 不带 `allowWrite`，桥对 `write/write-beta/export-beta` 抛 `EDA_WRITE_BLOCKED`（`bridge.mjs:1123-1126`）；本轮探针实测 `pcb.importChanges` 被拒、未到桥。**未发现"暂停后仍能改 EDA 设计"的 HTTP 路由。**
- **按设计放行的文件写路径**（清单）：`/api/pcb/3d/export`、`/api/production/export|release|releases/archive`、`/api/eda/gates/evaluate|signoff`、`/api/eda/schematic/acceptance`、`/api/eda/schematic/simulation/run`、`/api/eda/pcb/drc/start|cancel|report`、`/api/evidence/retention/prune`、`/api/knowledge/entries|usage`、`/api/rag/reindex`、`/api/library/proposals`、`/api/timeline/link`、`/api/chat/*`、`/api/providers/:id/key`。这些路径暂停期可写文件（实测 3D 导出成功落盘），与"只冻结设计写入口"的设计一致，但**与"全局暂停所有写入"的直觉文案有差距**。
- **另一个不一致**：`/api/eda/project/open`（`server.mjs:3376`，navigate）不在暂停名单，而 R1 配方把 `project.open` 当作 `requiredApprovals:['write']` 的写批准步骤（`recipes.mjs:368-380`）——同一动作两套口径（P2-6）。

**P0-8 判定**：**主体 ✅（不可宣称完整闭环）**。真设计写路由全部被 Runtime 前置 409 拦住（含重启保留），这是原 P0 的核心；但 fail-open 文件损坏（P0-A）与会话开关前端化（P0-B）仍属同类"暂停可被绕过"，必须修复后才能写"已修复"。

### 2.3 P0-9「approved → 门禁引用」验证

**修复范围（旧审计 §2.5 声明）**：`runtime/knowledge-gate-advice.mjs`；`GET /api/eda/gates/status`（record:false）与 `POST /api/eda/gates/evaluate`（写 usage）返回 `knowledgeAdvice`；`rag/corpus.mjs` 过滤过期 + meta；`VerificationCenterPage` 建议面板；`KnowledgePage` RAG 命中标注。

**逐条核验**

| # | 声明 | 证据 | 结论 |
|---|---|---|---|
| 1 | 只用 approved+可信+未过期条目 | `knowledge-gate-advice.mjs:50-53` + `knowledge.mjs:486-492`；单测 3 个（`knowledge-gate-advice.test.mjs:35,73`）含 candidate/unverified/过期排除 | ✅ |
| 2 | 真实 HTTP 接线（status + evaluate） | `server.mjs:1651-1660`；`gates-p05-http.test.mjs:83-113` 断言：审核前 0 条、审核后进入、evaluate 写 usage、GET 不写 usage；本轮该文件 2/2 通过 | ✅ |
| 3 | usage 在评估时落盘 | `knowledge-gate-advice.mjs:64-68`；`gates-p05` 断言 `usages[0].outcome==='used'` 且 note 含门禁/原因码 | ✅ |
| 4 | RAG 排除过期并标注 review/trust/gateUsable | `rag/corpus.mjs:14-19,38,89`；单测 `knowledge-gate-advice.test.mjs:91-112` | ✅（新索引） |
| 5 | UI 建议面板/RAG 徽标 | `VerificationCenterPage.tsx:155-171`；`KnowledgePage.tsx:236-247` | ✅ |
| 6 | **真实语料下"approved 改变产品行为"** | 只读扫描：`artifacts/knowledge` 408 条 / approved 0 / `GATE_` 命中 0；`artifacts/state/knowledge` 13 条 / approved 0；安装版 state 392 条 / approved 0；`store.query({text:'GATE_EVIDENCE_MISSING'})` 0 命中；安装版 RAG 索引 3376 chunks **meta 全空** | 🟥 建议恒空 |
| 7 | usage 记录真实性/可审计 | GET status `record:false`（`server.mjs:1654`）但 UI 文案写"usage 已记录"（`VerificationCenterPage.tsx:158`）；`recordUsage` 异常被吞且无标记（`knowledge-gate-advice.mjs:64-68`） | 🟨 P2-4/P2-5 |

**边界漏洞（逐条）**

1. **【P0-C，数据不闭合】真实语料 0 命中 → `knowledgeAdvice` 恒空。**
   `buildGateKnowledgeAdvice` 只按 `report.gates[].reasons[].code` 做 `store.query({text: code})`（`knowledge-gate-advice.mjs:47-56`），而门禁 code 只有 7 个 `GATE_*`（`gate-engine.mjs:24-32`）；真实知识语料（failure/module/part/rule 四类，408 条）payload 里没有任何 `GATE_` 串，也没有任何 approved 条目。后果：`GET/POST gates/*` 永远返回 `suggested:[]`、`note:"没有 approved + 未过期的相关知识"`，UI 永远显示"暂无可用知识"——**P0-9 声称的"approved 进入门禁建议"在真实数据下不可触发**，approve 仍只影响 RAG 徽标（且依赖索引重建）。
   修法（二选一或并用）：① 给门禁 reason code 建"知识标签映射"（如 `GATE_EVIDENCE_MISSING→[drc,evidence,report]`），建议检索用标签/entityKey 而非原样 code；② 在知识条目里补 `payload.ruleId: GATE_*` 的种子/采集规则，并至少准备 1 条 approved 示例走通全链；③ 在 UI 明确"当前语料无对应门禁知识"而不是笼统"暂无可用知识"。
   验收：用真实语料（或一条真实采集的 approved 条目）+ 真实门禁报告，`status` 返回 ≥1 条建议；`evaluate` 后 `GET /api/knowledge/usage?id=` 有记录；`approved` 与 `candidate` 两条同主题条目只有前者进入建议。
2. **【P1-1】RAG 索引不随审核/过期/文档变化失效，旧索引直接沿用。**
   `rag/store.mjs:69-77`：`query()` 仅在 `chunks===0` 时懒构建；无 `corpusDigest` 比对（`index.json` 里虽有 `corpusDigest` 字段但加载/查询不用）；`RAG_INDEX_VERSION` 仍为 1（`rag/index.mjs:15,168`），所以 2026-10-22 构建的安装版索引（3376 chunks，meta 全空）升级后继续使用：RAG 命中没有 `review/trust/expired`，UI 会把 approved 也显示成"候选未审核"，已过期条目也不会标"已过期"；更危险的反向是"审核通过后又被驳回/过期"的条目按旧 meta 仍显示"已审核"。同时新审核知识搜不到，需手动"重建索引"。
   修法：`load()` 后比较 `corpusDigest`（或 bump `RAG_INDEX_VERSION`）→ 不一致自动重建；知识 save/review/过期时给 index 打失效标记；验收：审核一条知识后不点"重建"直接检索即可命中且徽标正确；过期条目检索不到或标"已过期"。
3. **【P2-4】GET status 显示建议但不写 usage，UI 文案却说"usage 已记录"。**
   `server.mjs:1654` 明确 `record:false`；`gates-p05:104-105` 断言 GET 后 usage 为空；但 `VerificationCenterPage.tsx:158` 面板标题固定"usage 已记录"。影响：用户看到建议即认为可追溯，审计时查不到 usage。修法：文案改为"评估时记录 usage"，或 GET 也写一条 `viewed` 类型 usage（需先扩 outcome 枚举）。
4. **【P2-5】usage 写失败被吞、无 UI 出口、可被伪造。**
   `knowledge-gate-advice.mjs:64-68` `catch {}` 后仍把建议计入 `used`；返回体无 `usageRecorded`；`runtimeClient.ts` 无 usage 方法；`POST /api/knowledge/usage` 接受任意 `id/agent/outcome`（`knowledge-api.mjs:107-112`），不校验条目存在。修法：建议对象带 `usageRecorded:boolean`，失败计入 `usageFailures`；增加 `GET /api/knowledge/usage` 的 UI 展示（或"使用记录"面板）；usage POST 校验条目存在并校验调用方角色。
5. **【P1-5】知识仍未进入对话/Agent。**
   `runtime/chat.mjs` 对 knowledge/RAG **0 引用**（grep 唯一命中是注释里的 localStorage）；`runtime/agents/orchestrator.mjs:48` 使用 `attachKnowledgeCitations` 校验引用，但 `server.mjs` 未 import orchestrator（grep 0 命中），引用校验器只在脚本/测试中跑。旧审计 P0-9 的修法列了"放行建议/ERC 修复建议/badcase 任务"三个真实消费者，目前只接了门禁建议一个，且它恒空。修法：把 RAG 检索 + 引用校验接入 chat 的证据回填（回答中标注 `knowledge:<id>` 且 approved 才显示"可引用"），orchestrator 至少接到一个后台任务入口。验收：对话中引用候选条目被拒/降级，引用 approved 条目带徽标与 usage。
6. **【P2-2/P2-3】** 知识/RAG/证据写入口暂停期可写（同 §2.1 边界 5）；UI 未接写暂停的 3 处写入口（`RoutingWritePanel.tsx:80,98`、`ValidationPage.tsx:1135`、`PartProposalPage.tsx:162`）在暂停期按钮仍可点，靠 Runtime 409 兜底（错误文案可读性差，且 `RoutingWritePanel` 的预演被误挡）。

**P0-9 判定**：**🟨 结构接通、真实行为未闭环**。代码路径与测试真实存在（不是"只有文案"），但"approved 真的改变产品行为"在真实语料下仍不成立：没有 approved 条目、也没有能匹配门禁 reason code 的知识；同时 RAG 旧索引使"标注/过滤"在实际安装版失效。旧审计 §2.5 的 ✅ 应降级为 🟨（或"代码接线完成，数据/索引闭环未完成"）。

---

## ③ 未解决 P0 / P1 清单（按影响排序）

### P0（安全/核心承诺失真）

| # | 问题 | 证据（file:line） | 影响 | 修法 | 验收 |
|---|---|---|---|---|---|
| P0-A | 写暂停权威文件损坏/不可读时 **fail-open**，UI 静默 | `runtime/write-gate.mjs:24-41`（仅 `loadError`，`paused` 默认 false）；`runtime/server.mjs:1462-1464`（原样返回）；`src/state/AppContext.tsx:332-334`（只读 paused） | 一次磁盘损坏/手工改/权限变更即静默关闭最高优先级写门禁；用户以为已暂停，脚本/UI 实际可写（本轮已用损坏文件 + HTTP 探针复现） | `load()` 捕获非 ENOENT 错误时把状态视为 **未知→按暂停处理**（`paused:true` 且 `loadError` 透出）；或 `assertEdaWritesOpen` 在 `gate.loadError` 时抛 503 `WRITE_GATE_UNAVAILABLE`；UI 展示"门禁状态异常，写入已保守阻断/需人工检查文件" | 损坏 JSON/EACCES/EISDIR 三种情况下：`GET /api/write-gate` 返回 `paused:true`（或 503）+ 明确 code；写路由不得放行；UI 显示异常横幅；新增单测覆盖 corrupt-file |
| P0-B | 会话级「暂停本会话写入」仍是前端自觉 | `src/pages/EdaPage.tsx:623`（仅 dispatch）；`src/state/taskMachine.ts:37`、`src/components/Shell.tsx:44`（UI 据此显示 WRITE PAUSED）；`runtime/` 无对应概念 | 用户打开"暂停本会话写入"后顶部徽标/按钮均显示暂停，但 curl/脚本/自动化仍可写 → 与 P0-8 同类"安全叙事失真" | 把会话开关也放进 Runtime：`POST /api/write-gate` 增加 `scope:'session'|'global'`（或独立 `/api/write-gate/session`），UI Toggle 改为调 Runtime 并镜像；Runtime 在 `assertEdaWritesOpen` 同时看会话开关 | 会话开关打开后，脚本 `POST /api/eda/commands/pcb.save`（或任一写路由）返回 409 `EDA_WRITE_PAUSED`（`scope:'session'`）；UI 徽标状态与 Runtime 一致；新增 HTTP 测试 |
| P0-C | P0-9 真实语料下建议恒空：0 approved + 0 门禁 code 命中 | `runtime/knowledge-gate-advice.mjs:47-56`（按 code 检索）；`runtime/gate-engine.mjs:24-32`（仅 7 个 `GATE_*`）；本轮扫描：`artifacts/knowledge` 408 条 approved 0、含 `GATE_` 0；`store.query({text:'GATE_EVIDENCE_MISSING'})` 0 命中；安装版 392 条全 candidate | "approved 进入门禁建议并改变产品行为"在真实数据下不可触发；审核通过对门禁裁决仍无影响（仅 RAG 徽标，且旧索引不生效）→ P0-9 核心承诺未达成 | ① 门禁 reason code → 知识标签映射（如 `GATE_EVIDENCE_MISSING→[drc,evidence,report]`）+ 用标签/entityKey 检索；② 补采集/种子规则产出 `payload.ruleId: GATE_*` 条目；③ 至少 1 条真实采集条目走完 candidate→approved→建议→usage 全链并留证据 | 真实语料 + 真实门禁报告：`GET /api/eda/gates/status` 返回 ≥1 条建议；`POST .../evaluate` 后 usage 有记录；candidate 同主题不出现；全程不依赖手工构造 payload |

### P1（半打通 / 影响可信度或数据完整性，按影响排序）

| # | 问题 | 证据（file:line） | 影响 | 修法 | 验收 |
|---|---|---|---|---|---|
| P1-1 | RAG 索引不随知识/文档变化失效；旧索引无 meta 直接沿用 | `runtime/rag/store.mjs:69-77`（只空索引懒构建）；`runtime/rag/index.mjs:15,168`（version 仍 1）；本轮安装版索引 3376 chunks meta 全空、digest 与当前语料不符 | 新审核知识搜不到；approved 被显示为"候选未审核"；已驳回/过期条目按旧 meta 仍显示"已审核"；P0-9 的 RAG 排除过期在安装版不生效 | `load()` 后比较 `corpusDigest` 或 bump `RAG_INDEX_VERSION`（不一致自动重建）；knowledge save/review 时给 index 打 `dirty`；查询前检查 dirty | 审核一条知识后**不点重建**直接检索命中且徽标为"已审核"；过期条目检索不到或标"已过期"；安装版升级后首次查询自动重建 |
| P1-2 | 全局暂停不中断在途自动化运行（暂停后仍写板） | `runtime/server.mjs:1460`（仅分发前）；`runtime/automation/runner.mjs:199-220`（每步无 gate 复核）；`server.mjs:3716`（只能手动 abort） | 点暂停后已启动写配方继续执行后续步骤，徽标与实际行为不一致；用户以为"已止血" | runner 每步前调用注入的 `assertWritesOpen()`；`POST /api/write-gate {paused:true}` 对 `activeRunControllers` 触发 abort + journal 记 `gate.paused`；UI 提示"暂停已生效，在途运行将中止" | 暂停后 ≤1 步内 run 进入 `aborted`，journal 有 `gate.paused` 事件；UI 运行态显示"已暂停中止"；单测覆盖 |
| P1-3 | 写互斥只覆盖自动化运行，布局/布线/修复/叠层可并发写同一文档 | `runtime/server.mjs:529,3631-3641`（仅 automation lock）；`placement-write.mjs`/`pcb-routing.mjs`/`schematic-repair.mjs` 无锁 | 同一文档被两个页面/请求并发写 → 互相踩踏、回滚互相覆盖；暂停/审计难以判断"谁在写" | 引入文档级写锁（`documentUuid` 为键），覆盖全部 `EDA_WRITE_ROUTES`；冲突返回 409 `EDA_WRITE_BUSY`；与自动化锁共用一套 | 两个并发 placement/routing 请求：一个成功一个 409；自动化与手工写互斥；测试覆盖 |
| P1-4 | 旧 Runtime/混合版本时 UI 镜像静默保留旧值 | `src/state/AppContext.tsx:329-338`（`.catch(()=>undefined)`）；`SettingsPage.tsx:292-305` | 旧 Runtime（无 `/api/write-gate`）下徽标可能显示"已暂停"但实际可写；且用户无法通过设置页解除（保存被拒） | 404/网络错误区分处理：404→`gateSupported:false` 显式警告"该 Runtime 不支持写门禁，请升级"；网络错误→"门禁状态未知"；保存时允许带 `forceLocalOnly` 的显式确认或提示升级 | 旧 Runtime 下 UI 出现"不支持写门禁"警告；不会显示虚假"已暂停"；有测试（mock 404） |
| P1-5 | 知识仍未进入对话/Agent；orchestrator 未接线 | `runtime/chat.mjs` knowledge/RAG 0 引用；`runtime/agents/orchestrator.mjs:48` 未被 `server.mjs` import；`knowledge-citations.mjs:27-33` 仅脚本/测试使用 | RAG 命中不能进入对话依据；引用校验（approved 才可引用）无产品入口；P0-9 只接了"门禁建议"一个消费者且恒空 | 在 chat 证据回填/回答中接入 RAG 检索结果（带 review/trust 标注），orchestrator 至少接一个后台任务入口；引用必须过 `attachKnowledgeCitations` | 对话回答可显示 `knowledge:<id>` 依据且 candidate 被标注/拒绝；orchestrator 有 HTTP/任务入口；测试覆盖 |
| P1-6 | 联网检索开关无消费者；KMA 后台默认联网且外发清单漏项 | `src/pages/SettingsPage.tsx:369-374`（只改本地）；`runtime/server.mjs:587`（KMA web 默认开）、`1741`（status 硬编码 `enabled:false`）；旧审计 P1-10 | 用户关闭联网后 KMA 仍外发；外发端点披露不完整 | 把 research 开关放进 Runtime（`POST /api/settings/research`），`/api/research/*` 与 KMA 采集都读同一状态；KMA 默认改为 off 或按开关；外发清单补 KMA 通道 | 关闭开关后 KMA 不发起网络请求（可用 nock/本地代理断言）；`/api/research/status` 返回真实开关；清单与代码一致 |
| P1-7 | automation journal 默认落在 `~/.circuitpilot`，不随 state 目录 | `runtime/automation/journal.mjs:37-39`；Tauri 只注入 `CIRCUITPILOT_STATE_DIR`（`src-tauri/src/lib.rs:56-58,138`） | dev/安装版双状态源，排障时证据在他处；卸载边界不清（旧 P1-15） | journal 默认 `join(stateDir,'automation-runs')`，保留 env 覆盖；迁移旧目录或提供 `--journal-dir` 提示 | Tauri 启动后 journal 与 state 同目录；重启恢复扫描能看到历史 run；迁移测试 |
| P1-8 | GUI 通道写动作（click/type/shortcut/drag）不要求一次性写批准 | `runtime/server.mjs:3508-3517`（仅白名单/暂停检查，无 `requireWriteApproval`）；`src/components/Shell.tsx:153` 产品文案称"所有写入都需要计划哈希 + 一次性批准令牌 + 快照" | 任何持 token 的页面/脚本可通过 GUI 点击"应用修改"写板，绕过"一次性批准"边界（暂停期被挡，恢复后即可）；与产品叙事不一致 | 明确 GUI 通道定位：要么 GUI 写动作也要求 `approvalIds`（用动作/目标指纹绑定），要么在 UI/文档把 GUI 定义为"受信任人工输入通道、不受一次性批准约束"并去掉绝对化文案 | 二选一后：GUI 写动作带批准校验（或文案与帮助页明确边界）；安全评审记录；测试覆盖至少一条 GUI 写动作 |

### P2 备忘（不影响 P0/P1 判定，但应排期）

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| P2-1 | 暂停期 `dryRun:true` 预演/只读自动化配方被 409 误挡 | `server.mjs:1460`（整路由）+ `2406,2504`；本轮探针：`placement/apply dryRun:true` 409、`automation/run eda-read-state` 409 | 门禁按请求体/配方只读性分流；测试覆盖"暂停时预演可用、真写 409" |
| P2-2 | 暂停期仍可写导出/证据/知识/RAG 文件（设计声明 vs 直觉文案） | `server.mjs:1453-1458` 注释；实测 `pcb/3d/export` 暂停期落盘 `.step`；`gates-service.mjs:46,71`；`knowledge-api.mjs`；`rag/store.mjs:62-65` | 设置页/帮助文案写明"只冻结设计写入口"；如需"全冻结"另设 `includeFileWrites` 选项 |
| P2-3 | 3 处写入口未接 `settings.writePaused`（按钮不置灰，靠 409） | `RoutingWritePanel.tsx:80,98`；`ValidationPage.tsx:1135`；`PartProposalPage.tsx:162` | 统一从 `getExecutionGate`/`settings.writePaused` 取禁用态与原因 |
| P2-4 | GET status 不写 usage，UI 文案却写"usage 已记录" | `server.mjs:1654`（record:false）；`gates-p05:104-105`；`VerificationCenterPage.tsx:158` | 文案改为"评估时记录 usage"或 GET 写 `viewed` 记录 |
| P2-5 | usage 写失败被吞、无 UI、可伪造 | `knowledge-gate-advice.mjs:64-68`；`runtimeClient.ts` 无 usage 方法；`knowledge-api.mjs:107-112`（不校验条目/角色） | 返回 `usageRecorded`/`usageFailures`；增加"知识使用记录"面板；usage POST 校验条目存在 + 调用方角色 |
| P2-6 | `/api/eda/project/open`（navigate）不暂停，但 R1 把 `project.open` 当写批准步骤 | `server.mjs:3376` vs `recipes.mjs:368-380` | 统一口径：要么 navigate 也不算写（R1 降为只读/无批准），要么暂停名单包含项目/文档切换 |
| P2-7 | 写门禁状态单进程缓存 | `write-gate.mjs:24-25` | 每次 `load()` 校验 mtime/内容或短 TTL 热读 |
| P2-8 | 通用命令路由被桥拦截时返回 `EDA_WRITE_BLOCKED` 而非暂停码 | `server.mjs:1836`；`bridge.mjs:1123-1126`；本轮探针 | 暂停期在通用路由前缀也做路径判定，或错误映射统一为 `EDA_WRITE_PAUSED`（附 cause） |
| P2-9 | 设置项仍只有 localStorage 权威（除 writePaused） | `AppContext.tsx:258-265`（旧 P1-14 残留） | 逐步把安全相关设置（research、readOnlyDefault 等）落 Runtime |

---

## ④ 验证记录

**环境**：macOS（Darwin），仓库 `/Users/jescochen/Desktop/AI- PCBA`（路径含空格），2026-10-29；Node.js（`node --test` 可用）；工作树为修复后状态。

**本轮执行（全部只读/隔离，未接触真实 EDA）**

1. `node --test runtime/__tests__/write-gate-http.test.mjs runtime/__tests__/knowledge-gate-advice.test.mjs runtime/__tests__/automation-http.test.mjs`（隔离 `CIRCUITPILOT_STATE_DIR=$PWD/.tmp/audit-state-plat` 等）→ **11 tests / 11 pass / 0 fail**（write-gate 2、knowledge-gate-advice 3、automation-http 6；含"暂停 9 条代表路由 409"与"跨 Runtime 重启保留"）。
2. `node --test runtime/__tests__/gates-p05-http.test.mjs`（同上隔离）→ **2 tests / 2 pass**，其中包含 P0-9 段（`gates-p05-http.test.mjs:83-113`：candidate 不进建议、approved 进入、GET 不写 usage、evaluate 写 usage）。
3. **模块探针（write-gate）**：损坏 JSON 与 EISDIR 两种文件 → `paused:false` + `loadError`（证明 fail-open，见 P0-A）。
4. **HTTP 探针 A（暂停态）**：隔离 Runtime + fake bridge，`POST /api/write-gate {paused:true}` 后：`placement/apply {dryRun:true}`→409、`schematic/repair`→409、`automation/run eda-read-state`→409、`/api/eda/commands/pcb.importChanges`→400 `EDA_WRITE_BLOCKED`（桥拦截，未到桥）；另 `gui state` 在无 CDP 时非 409（不影响只读判定，正式断言见 `write-gate-http.test.mjs:93-98`）。同一隔离环境另测：`POST /api/pcb/3d/export` 在暂停期仍执行 `pcb.3d.export` + `pcb.3d.chunk` 并**写出 `.step` 文件**（设计放行，P2-2）。
5. **HTTP 探针 B（损坏门禁文件）**：预置 `write-gate.json` 为非法 JSON → `GET /api/write-gate` 返回 `paused:false, loadError:"Expected property name..."`；随后 `POST /api/eda/gui/execute {action:'click'}` **通过暂停门禁**（只因无 CDP 在 400 `EDA_GUI_CDP_UNAVAILABLE` 失败）→ P0-A 端到端证据。
6. **真实语料只读扫描（node 只读脚本）**：`artifacts/knowledge` 408 条（failure 91 / module 104 / part 57 / rule 156）/ approved 0 / `GATE_` 命中 0；`store.query({text:'GATE_EVIDENCE_MISSING'})` 0；`artifacts/state/knowledge` 13 条全 candidate；安装版 `~/Library/Application Support/com.circuitpilot.desktop/state/knowledge` 392 条全 candidate、approved 0。
7. **安装版 RAG 索引只读检查**：`~/Library/Application Support/com.circuitpilot.desktop/state/rag/index.json`：`builtAt 2026-10-22T07:51:16Z`、479 docs / 3376 chunks / **meta 全空（0/3376）**、digest `8af268…`；当前语料重算 digest `7935f2…`（408 知识 + 141 文档 = 549 docs）→ 旧索引与新语料不一致（P1-1）。
8. **交叉核对**：`grep` 确认 `runtime/` 内 `isUsableForGate` 调用点（`knowledge-gate-advice.mjs:52`、`agents/knowledge-citations.mjs:20`、`rag/corpus.mjs:17`、`knowledge-api.mjs:46`）；`runtime/chat.mjs` 对 knowledge/RAG 0 引用；`orchestrator` 未被 `server.mjs` import；`allowWrite:true` 全量站点与 18 条 `EDA_WRITE_ROUTES` 对照（见 §2.2）；安装版 runtime（`/Applications/CircuitPilot.app/Contents/Resources/runtime/server.mjs`，2026-10-26）grep `/api/write-gate` = 0 命中（证明旧 Runtime 无此端点，P1-4 真实存在）。

**未复验/限制**

- 未启动真实 EDA/Bridge，未做真机写板/暂停演练；"暂停后真实 EDA 不落板"只有 fake bridge + 既有测试证据。
- 未重启 4177/4178 服务、未做 Playwright/e2e；UI 层结论来自代码与单测，未做真机截图验证。
- 安装版桌面（Tauri sidecar/打包）为**历史证据（2026-10-20 package smoke，旧审计引用）**，本轮未复验；本轮只读检查了其 state 目录数据。
- 单文件测试只覆盖 9 条代表路由的 HTTP 断言；18 条清单逐条断言仍缺（P2 测试缺口，非产品缺口）。
- 本轮未修改任何源码/配置；`docs/implementation/flow-audit-2026-10-29/` 为本轮唯一新增内容（本文件）。
