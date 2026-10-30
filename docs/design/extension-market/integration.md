# 嘉立创EDA 扩展市场管家 Agent —— 与 CircuitPilot 现有架构的集成设计

| 项 | 值 |
| --- | --- |
| 文档编号 | design/extension-market/integration |
| 状态 | Draft（设计评审用；**不含实现代码**，只含接口形状、契约与落点） |
| 版本 | v1.0 · 2026-10-23 |
| 作者 | integration-arch（teammate） |
| 上游任务 | task-3 |
| 同级输入 | `docs/design/extension-market/recon.md`（market-recon，进行中）、`docs/design/extension-market/local-probe.md`（local-probe，进行中） |
| 本文边界 | 只写 `docs/design/extension-market/integration.md`；不改 `runtime/**`、`src/**` 任何代码 |
| 读者 | Lead / 后续实现者（backend、frontend、tester） |

> **设计基线声明**：本文所有"现有行为"均来自对仓库源码的只读核对，引用精确到 `文件:行号`。
> 凡标注 `【待侦察结论】` 的段落依赖 market-recon / local-probe 的实测结果，本文只给**抽象接口**，
> 不预设任何真实 URL、字段名或落盘路径——避免把猜测写进架构。

---

## 0. 需求原文 → 设计落点（可追溯表）

| 用户原话（拆解） | 本文落点 | 首版是否交付 |
| --- | --- | --- |
| 「管理嘉立创EDA扩展市场」 | §3 `catalog` 数据源 + `GET /api/extensions/catalog` | 只读清单（市场侧源可用才返回，不可用如实 degraded） |
| 「实时抓取/读取扩展功能」 | §2.6 provider 抽象 + §4 能力公告板 + 调度 | 只读、定时 30min + 按需刷新（不做 fs.watch） |
| 「若与 AI 设计 PCB 需求相关」 | §4.4 检索打分（需求标签匹配） | 交付：**推荐 + 一键人工安装入口** |
| 「自动下载并实时更新版本」 | §5 | **首版明确不自动安装、不静默更新**（见 §5.1 决策与理由） |
| 「告知 CircuitPilot 其他 AI agent 可调用哪些扩展功能」 | §4.6 公告板注入 + §3.6 检索接口 | 交付（prompt 片段注入 chat / 计划生成器） |

---

## 1. 现状核实（先纠正常见误判，再谈集成）

这一节是全文的地基。**五项事实与三项"看起来有、其实没有"**，如果不先厘清，设计会立刻跑偏。

### 1.1 五项已核实事实

**F1 · Agent 契约是"只读强制"，不是可选参数。**

`runtime/agents/agent-contract.mjs:20-26` 的 `defineAgent({id, version, readOnly, timeoutMs, run})` 里，
`readOnly !== true` 时**直接抛** `AGENT_NOT_READONLY`（第 23 行），返回对象被 `Object.freeze` 且
`readOnly` 恒为 `true`（第 25 行）。`invokeAgent`（第 29 行）执行前再次校验 `agent.readOnly !== true` 即拒绝（第 30 行），
并把 `AGENT_TIMEOUT`（第 35 行）、证据契约失败（第 42 行 → `AGENT_EVIDENCE_INVALID`）都变成**结构化失败**而非抛出。

> 结论：**任何"带写权限的 manager"都不可能塞进 `defineAgent` 体系**。这不是风格问题，是硬拒绝。

**F2 · 现有 4 个 verifier agent 没有 HTTP 暴露（重要）。**

对全仓 grep `agents/orchestrator|agents/rule-runner|agents/netlist-auditor|agents/agent-contract`：
- `runtime/server.mjs` **只** import 了 `createKnowledgeManager`（第 35 行）；
- `runtime/agents/orchestrator.mjs` 的唯一非测试消费者是 `scripts/verify-knowledge-loop.mjs`；
- `defineAgent` / `invokeAgent` 的非测试消费者为 **0**（仅 `runtime/__tests__/agent-contract.test.mjs` 使用）。

> 结论：任务书里说的"与现有 4 个 verifier agent 的注册方式一致"——**在 HTTP 层并不存在这种注册方式**。
> 真正"agent + HTTP 路由"的**唯一现成样板是 KMA（`knowledge-manager`）**：`runtime/server.mjs:501-518`
> 实例化 + `:1512-1523` 暴露 `status` / `run` 两条路由。新 agent 应对齐 **KMA 的暴露方式**，
> 而在**模块内部**对齐 `defineAgent` / `invokeAgent` 的契约（只读、超时、证据）。二者都要，但层次不同。

**F3 · 证据契约是 fail-closed 白名单。**

`runtime/evidence-contract.mjs`：
- `schemaVersion` 必须 `=== 1`（第 47 行）；
- `subject.type` 必须在固定 7 项内：`project/board/pcb/schematic/part/spec/library`（第 20 行、第 51 行）；
- `source.readOnly` 必须 `=== true`（第 58 行，违者 `EVIDENCE_AGENT_NOT_READONLY`）；
- `verdict ∈ {pass, blocked, unknown, advisory}`（第 18 行）；`pass` 不允许带 `severity='error'` 的 finding（第 69 行）；
- `unknown` 必须有 error finding / `blockedReason` / 非空 findings（第 71 行）；
- `createEvidenceEnvelope`（第 75 行）最后会自算 sha256 `digest`（第 103 行）。

`runtime/evidence-store.mjs:20-26` 的 `EVIDENCE_KINDS` 是**固定白名单**（当前 17 项），
`save`（第 63 行）对未登记 kind 抛 `EVIDENCE_KIND_INVALID`（第 64 行）。

> 结论：新增扩展市场证据**必须同时动两处注册**（新 kind + 新 subject.type），这是本设计里唯一"必须改契约文件"的地方（§3.4）。

**F4 · 门禁 `evaluateGate` 与 `evaluatePcbGates` 对"多余证据"的处置完全不同（最容易踩的坑）。**

- `runtime/evidence-contract.mjs:107-122` 的 `evaluateGate({envelopes, requiredKinds})`：
  它先 `assertEvidenceEnvelope` 每一条，然后**遍历所有 envelopes**——只要有一条 `verdict === 'unknown'`
  就进 `unknownBy`，最终 `verdict = unknown`（第 121 行）。也就是说：**把一条 `unknown` 的扩展证据塞进
  `runDesignPipeline` 的 envelopes，就会把整条设计流水线判成 unknown。**
- `runtime/gate-engine.mjs:29-61` 的 `evaluateOneGate`：只处理 `kind ∈ gate.requiredKinds` 的证据，
  其余证据被**直接忽略**（第 32 行 `continue`）。

> 结论（写进验收）：扩展证据进设计流水线时，`verdict` **只允许 `advisory` 或 `pass`**，绝不 `unknown`；
> 而在 PCB 门禁侧，只要**不把新 kind 加进 `PCB_GATES[].requiredKinds`**，它就是安全的旁路证据。

**F5 · Bridge 的权限模型是"冻结的命令表 + 调用点授予"。**

`runtime/bridge.mjs:53` `const COMMANDS = Object.freeze({...})`，每条命令带 `permission`。
实测出现的取值：`read` / `navigate` / `validate` / `write` / `write-beta` / `export-beta` / `sensitive-read`
（示例：`:55` read、`:83` navigate、`:565` validate、`:367` write、`:368` write-beta、`:659` export-beta、`:1059` sensitive-read）。
`execute(commandId, args, {allowWrite, allowSensitiveRead})`（第 1055 行）：

- 未登记命令 → `EDA_COMMAND_NOT_ALLOWED`（第 1057 行，"命令未注册，已被策略拒绝"）；
- `write|write-beta|export-beta` 且 `!allowWrite` → `EDA_WRITE_BLOCKED`（第 1058 行）；
- 只有 `read`/`validate` 类命令允许瞬时重试 3 次，**写命令一次也不重试**（第 1118、1133 行）；
- 单命令超时 `Math.min(command.timeoutMs ?? commandTimeoutMs(id), MAX_TRANSPORT_TIMEOUT_MS)`，其中
  `MAX_TRANSPORT_TIMEOUT_MS = 110_000`（第 31 行）。

HTTP 侧：`GET /api/eda/commands` 返回 `bridge.listCommands()`（`:1649-1650`，字段 `{id, permission, description, signature}`，见 `bridge.mjs:1005`）；
`POST /api/eda/commands/:id`（`:1651-1660`）**不传 `allowWrite`**，因此该通用路由只能跑非写命令。

> 结论：想通过桥接读取扩展清单，必须先往 `COMMANDS` 加一条 `permission: 'read'` 命令；**不可能"先跑起来再补权限"**。

### 1.2 三项"看起来有、其实没有"（避免重复造或误判已有能力）

| 误判 | 实际情况 | 证据 |
| --- | --- | --- |
| 已有 "capability registry" 可以复用 | 只有 `GUI_CAPABILITY_CATALOG`（GUI 兜底动作目录），是**GUI 动作清单**，不是扩展能力登记表 | `runtime/gui-capabilities.mjs:14`；导出 `catalogTexts`(:72)、`evaluateGuiCapabilities`(:83) |
| 已有 "扩展" 相关代码 | 全仓 `eext` / `ExtensionMarket` / `extension.json` 命中为 **0**；`grep extension` 仅命中 chat.mjs 的图片后缀与 release-gate.mjs 的 Gerber 后缀 | `runtime/chat.mjs:625`、`runtime/release-gate.mjs:140-143` |
| 审批账本可直接用新 scope（如 `extension`） | **不行**。`approval-ledger.mjs:17` 的 `APPROVAL_LEDGER_SCOPES` 只有 `plan/write/release`，`record()`（第 43-45 行）对其它 scope 抛 `APPROVAL_LEDGER_SCOPE_INVALID` | 见 §5.3 的两种方案取舍 |

### 1.3 可复用的四个现成骨架（本设计的原则：**能不新建就不新建**）

| 骨架 | 位置 | 本次用法 |
| --- | --- | --- |
| 数据源适配器 | `runtime/collectors/collect.mjs:21` `defineCollector` / `:30` `runCollector`（超时+失败隔离）/ `:50` `collectAll`（并发汇总） | **直接对标**成 `defineExtensionProvider`（§2.6） |
| agent + 定时调度 | `runtime/knowledge-scheduler.mjs:20` `createKnowledgeScheduler({manager, stateFile, intervalMs, initialDelayMs, now, timers, fileIo})`，契约只要求 `manager.runCycle` | 复用同形骨架（可参数化接 `extensionManager`），状态文件独立 `extension-agent.json` |
| JSON 原子状态 | `runtime/store.mjs:20` `createJsonStore({file, schemaVersion, initial, migrations})`（临时文件+rename；损坏抛 `STORE_CORRUPT`；未来版本拒绝读） | 能力公告板落盘 |
| 人工批准 | `runtime/approval-service.mjs:39` `createApprovalService` → `issue({scope, bindings, ttlMs})`(:78)、`consumeToken({token, requiredScope, expectedBindings})`(:135) | 安装审批：**用通用 `bindings` 维度**，不用 `automation/approvals.mjs` 的固定三字段 |

---

## 2. 架构定位

### 2.1 一句话结论

> **拆成两层：一个真·只读的 registrar agent（进 `agent-contract`）+ 一个不进 agent 体系的写权限 manager（只暴露给审批链路）。**
> 只读层负责"看得见、说得清"；写层负责"装得对、退得回"，且首版（v1）写层**只做接口占位、恒定 fail-closed**。

### 2.2 为什么不能是"一个带写权限的 manager agent"

| 方案 | 结果 | 判定 |
| --- | --- | --- |
| A. 单一 agent，`readOnly: false` | `defineAgent` 第 23 行直接抛 `AGENT_NOT_READONLY`，进程内无法构造 | ❌ 物理不可能 |
| B. 放宽 `defineAgent` 允许写 | 等于拆掉"生成方不得自证"的红线（`evidence-contract.mjs:58` 的 `source.readOnly===true` 也依赖它），全仓 4 个 verifier agent + 门禁的可信度一起塌 | ❌ 红线，不讨论 |
| C. 双层：`extension-registry`（只读 agent）+ `ExtensionMarketService`（普通模块） | 只读层可产出证据、可被编排、可被审计；写层复用 `createApprovalService` + 哈希链账本，**从不产出"通过"证据**（写事实以 `ledger`+`evidence` 记录，不以 verdict 表达） | ✅ **采纳** |

**关键约束（写进代码评审清单）**：`ExtensionMarketService` 的任何返回值**不得**被包装成 evidence envelope 的 `verdict: 'pass'`
含义去表达"安装成功"。安装是否成功是**事实记录**（`approval-ledger` + evidence `payload.outcome`），不是"合格判定"。

### 2.3 与 Orchestrator 的关系：不进 `PIPELINE_STEPS`

`runtime/agents/orchestrator.mjs:9` 的 `PIPELINE_STEPS = ['librarian','netlist-auditor','rule-runner']` 是**冻结数组**，
`planPipeline`(:11) 的默认 `requiredKinds = ['netlist-diff','rules']` 是门禁放行的最小证据集。

**决策：v1 不修改 `PIPELINE_STEPS`、不修改默认 `requiredKinds`。** 理由：
1. 扩展清单与"这块板对不对"无因果关系，把它变成必需证据等于给设计链路加一个无关的失败源；
2. 由 F4：一旦它的 verdict 是 `unknown`，`evaluateGate` 会把整条流水线判 unknown（`evidence-contract.mjs:121`）。

**允许的旁路用法**（v2 可选，需显式传 `steps`，不改进冻结常量）：
调用方在 `runDesignPipeline({spec, steps})` 的 `steps` 里自己追加 `{id:'extension-registry', run}`，
但**必须保证该 step 的 envelope `verdict === 'advisory'`**（inventory 正常态）或 `'pass'`；源不可用时不要塞进 pipeline，
而是让 UI/status 路由展示 `unknown`（走 §3.2 的 `GET /api/extensions/agent/status`，那条路由不参与门禁）。

### 2.4 与门禁（G1–G6）的关系：**不新增 G7**

`runtime/gate-engine.mjs:9-16` 定义 G1–G6；`runtime/gates-service.mjs:18` 用
`evidenceKinds() = PCB_GATES.flatMap(g => g.requiredKinds)` 汇总要取的证据，
`:52` 的 `signoff` 在 `evaluated.report.verdict !== 'pass'` 时抛 `GATE_SIGNOFF_BLOCKED`，
而 `evaluatePcbGates`(:64) 的 `verdict = blocked ? 'blocked' : unknown ? 'unknown' : 'pass'`。

> **结论：绝不能把扩展能力加进 `PCB_GATES`。** 新增 G7 会让 `evidenceKinds()` 多一项、
> 让 `evaluatePcbGates` 多一道门，而**存量 PCB 永远不会有扩展证据 → 全部变 `unknown` → 所有人工签字被拒**。
> 这是"一行改动锁死整条放行链"的典型，必须在评审时明确否决。

扩展能力与门禁的正确关系：**旁路 advisory**。它只在两处被消费：
- UI（EdaPage 面板）给人看；
- prompt（§4.6）给模型看。

### 2.5 是否需要独立 capability registry：**需要，但形态是"目录 + 检索"，不是新门禁**

复用 `GUI_CAPABILITY_CATALOG`（`gui-capabilities.mjs:14`）已验证过的形态：**条目静态基线 + 探测结果叠加**。

| 维度 | GUI 能力目录（已有） | 扩展能力公告板（本设计） |
| --- | --- | --- |
| 基线 | 硬编码 `GUI_CAPABILITY_CATALOG` | 采集结果（三源合并），落 `stateDir/extension-capabilities.json` |
| 叠加 | `evaluateGuiCapabilities({probe})` 探测结果 | `probe/verify` 结果（是否可探测到入口、兼容版本） |
| 红线字段 | `blocked: true` + `reason`（如在线 DFM、下单/支付） | `sideEffects`、`installPolicy:'never-auto'`、`blocked === true` |
| 消费方 | 自动化配方 / UI | prompt 注入 / UI / 未来编排 |

**结论**：不新建"能力注册中心"服务，只新建**一个 JSON 目录文件 + 一个纯函数模块**（`capability-board.mjs`），
与 `gui-capabilities.mjs` 同级同风格。这样既不增加进程内常驻对象，也能被单测纯函数化覆盖。

### 2.6 三数据源统一抽象：`defineExtensionProvider`（对标 `defineCollector`）

需求要求兼容"文件系统读取 / 市场 API / 桥接"。三者差异极大（同步读目录 / HTTP / 桥 RPC），
但**对上层必须同形**。直接照抄 `collect.mjs` 的三层结构（定义 → 单源执行 → 并发汇总）：

```
【接口形状，非实现】
defineExtensionProvider({ id, kind, source, readOnly, timeoutMs, run })
  id         : ^[a-z][a-z0-9-]*$      // 与 defineAgent / defineCollector 同正则
  kind       : 'local-fs' | 'market-api' | 'bridge'   // 开集，但 UI 需按此分组
  source     : 人话来源描述（写进 evidence.provenance.source）
  readOnly   : 必须 === true          // 与 agent 契约同红线：provider 也不许写
  timeoutMs  : 单源预算（见 §3.5）
  run({timeoutMs}) -> Promise<{ items: ExtensionCapability[], evidence?: object, degraded?: string|null }>

runExtensionProvider(provider, {timeoutMs}) -> 永远 resolve，绝不上抛：
  { ok:true,  provider:{id,kind,source}, items, evidence, elapsedMs }
  { ok:false, provider:{...}, code: EXT_SOURCE_TIMEOUT|EXT_SOURCE_UNAVAILABLE|EXT_SOURCE_PARSE_FAILED, message, elapsedMs }

collectExtensionSources({providers, timeoutMs}) -> Promise.all 并发 + 失败隔离
  { total, ok, failed, itemCount, results:[...] }
```

**为什么必须"失败隔离 + 永不上抛"**：三个源里市场 API 最不可靠（公网、可能 403/改版），
若它一挂就整体失败，本机已装扩展清单这个**离线可得的确定信息**也会一起丢——
这正是 `collect.mjs:6-7` 注释里写明的原则（"单个源挂掉不影响其它源，失败返回原因码而不是抛栈"）。

各源的具体实现细节（真实 URL、路径、字段）**属于 recon 的产出**：

| provider id | kind | 首版策略 | 依赖 |
| --- | --- | --- | --- |
| `local-installed` | `local-fs` | 必有。只读扫扩展落盘清单，**不写、不校验签名** | local-probe |
| `market-catalog` | `market-api` | 有则返回；`CIRCUITPILOT_EXTENSION_MARKET !== 'on'` 时整源 `degraded:'DISABLED_BY_POLICY'` | market-recon + 合规结论 |
| `bridge-catalog` | `bridge` | 默认 `EXT_SOURCE_UNAVAILABLE`。仅当 `COMMANDS` 里登记了只读命令后启用 | local-probe（能否经 `eda.*` 读到扩展管理器） |

> 若 recon 结论是"市场必须登录/违反 ToS"，则 `market-catalog` 直接长期 `DISABLED_BY_POLICY`，
> 架构无需改动——这就是抽象成 provider 的价值。

---

## 3. 对外接口

### 3.1 Agent 定义（代码落点：新增 `runtime/agents/extension-registry.mjs`）

```
【接口形状】
export const EXTENSION_REGISTRY_VERSION = '1.0.0';
export const EXTENSION_REGISTRY_CODES = { ... };

export function createExtensionRegistryAgent({
  providers = [],            // §2.6
  boardStore = null,         // createJsonStore({file: stateDir/extension-capabilities.json})
  evidenceStore = null,      // 复用 server 注入的同一个 evidenceStore
  now = () => new Date(),
  maxItems = 200,
}) -> {
  // 只读动作
  collect({ sources = null }),        // 跑 provider，合并 → 返回 {ok, inventory, degraded[], envelope}
  board({ tags = [], budgetTokens = 900, includeUnverified = false }),  // §4
  status(),
  // 供 invokeAgent 使用
  agent: defineAgent({ id:'extension-registry', version, readOnly:true, timeoutMs: 30_000, run })
}
```

| 字段 | 值 | 依据 |
| --- | --- | --- |
| agent id | `extension-registry` | 需过 `agent-contract.mjs:21` 正则 `^[a-z][a-z0-9-]*$` |
| version | `1.0.0` | 与 `RULE_RUNNER_VERSION` / `NETLIST_AUDITOR_VERSION` 同风格 |
| readOnly | `true`（不可协商） | `agent-contract.mjs:23` |
| timeoutMs | `30_000` | 默认 15s（`agent-contract.mjs:20`）不够覆盖三源并发 + 解析；取值理由见 §3.5 |
| run 输入 | `{sources?, tags?, budgetTokens?}` | — |
| run 输出 | `{inventory, board?, envelope}` | envelope 见 §3.4 |

写权限 manager 单独一个模块（**不是 agent**）：`runtime/extension-market/service.mjs` 的 `createExtensionMarketService({...})`，
只暴露 `installApproval` / `install` / `rollback` / `audit`，且 v1 全部 fail-closed（§5.7）。

### 3.2 REST 路由（插入 `runtime/server.mjs` 分发表，紧跟知识库路由之后）

插入位置建议：`runtime/server.mjs:1537`（`GET /api/knowledge/badcases` 那条）之后、
`:1539`（`POST /api/research/search`）之前——保持"knowledge → extensions → research"的阅读顺序。

实例化位置：`:518`（`knowledgeScheduler.start()` 之后、RAG 之前）。

| # | Method | Path | 语义 | 首版状态 | 写权限 |
| --- | --- | --- | --- | --- | --- |
| 1 | GET | `/api/extensions/inventory` | 已装清单（含 `degraded` 说明） | 交付 | 读 |
| 2 | GET | `/api/extensions/catalog` | 市场清单（`?q=&tag=&page=`） | 交付（源不可用→503） | 读 |
| 3 | GET | `/api/extensions/capabilities` | 能力公告板（`?tags=a,b&budget=900&refresh=1`） | 交付 | 读 |
| 4 | POST | `/api/extensions/refresh` | 同步刷新一轮（`{sources?, reason?}`） | 交付 | 读（只采集） |
| 5 | GET | `/api/extensions/agent/status` | 调度器 + manager 状态 | 交付 | 读 |
| 6 | POST | `/api/extensions/agent/run` | 手工跑一轮（`{task:“all”|“inventory”|“catalog”|“verify”}`） | 交付 | 读 |
| 7 | GET | `/api/extensions/audit` | 采集/审批事实（ledger 摘要 + 最近证据 ref） | 交付 | 读 |
| 8 | POST | `/api/extensions/install/approvals` | 签发一次性安装批准 | **v1 恒 501** | 写（v2） |
| 9 | POST | `/api/extensions/install` | 执行安装 | **v1 恒 501** | 写（v2） |
| 10 | POST | `/api/extensions/rollback` | 回滚 | **v1 恒 501** | 写（v2） |

**必须遵守的两个仓库隐性契约（否则 CI 红）**：

1. **`runtime/__tests__/route-contract.test.mjs` 会静态扫描 `server.mjs` 的路由写法**（解析器在 `:104-128`），
   只认三种形态：
   - 精确：`method === 'GET' && url.pathname === '/api/extensions/inventory'`
   - 正则：`method === 'POST' && /^\/api\/extensions\/install\/[^/]+$/.test(url.pathname)`
   - 前缀：`method === 'GET' && url.pathname.startsWith('/api/extensions/')`
   > 别用 `switch(url.pathname)` 或先拼 `const p = ...` 再比较——扫描器抓不到，路由会被当成"不存在"。
2. **每条路由都必须有消费者**（`runtimeClient` 方法 + 在 `src/pages|components|state` 里被调用），
   或登记进 `KNOWN_UNWIRED_ROUTES`（`:40-69`）。本设计 §7.2 已为 10 条路由逐一指定消费者，
   其中 #8/#9/#10 因 v1 恒 501，**建议同时补 UI 占位与 `KNOWN_UNWIRED_ROUTES` 说明**，二选一但必须有依据。

### 3.3 请求 / 响应 schema

统一外壳沿用现有约定：成功 `{ok:true, ...}`；失败 `{ok:false, error:{code, message, details?, retryable?}}`
（由 `runtime/server.mjs:132-146` 的 `runtimeError` 生成；状态码由 `:126-130` 的 `httpStatusForError` 决定：
**显式 `error.status` 优先 → 桥类码 503 → 兜底 400**）。

#### #1 `GET /api/extensions/inventory`

```
Query: refresh=0|1 (default 0)   // 1 表示绕过缓存重采（仍受 agent 超时约束）
200: {
  ok: true,
  inventory: {
    schemaVersion: 1,
    generatedAt: "2026-10-23T08:10:00.000Z",
    cache: { hit: true, ageMs: 41000 },          // 命中缓存时必须显式标注，不假装"刚刚读过"
    edaVersion: "3.2.186",                        // 读不到就是 null，不猜
    edaVersionSource: "user" | "probe" | "unknown",
    sources: [
      { id:"local-installed", kind:"local-fs",   ok:true,      elapsedMs:41,   items:9, degraded:null },
      { id:"market-catalog",  kind:"market-api", ok:false,     elapsedMs:12003,items:0,
        code:"EXT_SOURCE_TIMEOUT", message:"市场源超时（>12000ms），本次结果只含本地清单" },
      { id:"bridge-catalog",  kind:"bridge",     ok:false,     elapsedMs:0,    items:0,
        code:"EXT_SOURCE_UNAVAILABLE", message:"桥未登记只读扩展命令" }
    ],
    installed: [ ExtensionCapability, ... ],       // §4.1，已按 extensionId 稳定排序
    counts: { installed:9, updates:2, stale:1, unverified:9, blocked:1 },
    revision: "4f1c9ab0d2e3a7c1"
  },
  envelopeRef: { kind:"extension-inventory", digest:"<sha256>", path:"artifacts/evidence/extension-inventory/....json" }
}
503: 当且仅当 **所有** 源都失败（此时不允许返回空清单冒充"没装扩展"）
```

#### #2 `GET /api/extensions/catalog`

```
Query: q=<kw>  tag=<tag>  page=1  pageSize=20 (max 50)
200: { ok:true,
  catalog: { schemaVersion:1, generatedAt:"...", sourceId:"market-catalog",
             total:120, page:1, pageSize:20,
             items:[{ uuid, name, publisher, version, updatedAt, downloads?, tags:[], compat? , installPolicy:'manual-only' }] },
  degraded: null | "MARKET_SOURCE_DISABLED_BY_POLICY" }
503: EXT_SOURCE_UNAVAILABLE | EXT_SOURCE_TIMEOUT（retryable:true，仅超时）
```
> `items` 里**不放**任何"下载地址/安装命令"字段给前端直接使用（避免以后被误接成自动安装）；
> 下载执行只允许在服务端 `install` 链路内、且必须过审批。

#### #3 `GET /api/extensions/capabilities`（能力公告板，核心）

```
Query: tags=彩色丝印,绕组   budget=900   includeUnverified=0   forAgent=chat|design|netlist
200: {
  ok:true,
  board: {
    schemaVersion: 1,
    revision: "4f1c9ab0d2e3a7c1",     // 公告板内容摘要，用于"版本变更广播"（§4.7）
    generatedAt: "...",
    stale: false,                       // 距上次成功采集 > staleAfterMs（默认 24h）
    tokenBudget: { requested:900, used:742, droppedBy:["token","status"], items:7 },
    items: [ ExtensionCapability, ... ],// 已按 §4.4 打分排序
    promptFragment: "【可用嘉立创EDA扩展能力（运行时只读公告板，revision 4f1c9ab0）】\n- ..."   // §4.6，服务端生成，前端只展示
  }
}
```

#### #4 `POST /api/extensions/refresh`

```
Body: { sources?: string[], reason?: "manual"|"chat"|"schedule" }   // 空 = 全部已启用源
200: { ok:true, cycle:{ startedAt, finishedAt, tasks, ok, inventory:{...counts}, degraded:[...] } }
409: EXT_REFRESH_BUSY（同一时刻只允许一轮，对齐 knowledge-scheduler 的 `running` 互斥，见 `knowledge-scheduler.mjs:86`）
```

#### #5 `GET /api/extensions/agent/status`

```json
{ "ok": true,
  "scheduler": { "enabled": true, "intervalMs": 1800000, "lastRunAt": "...", "nextRunAt": "...",
                 "running": false, "lastResult": {…}, "history": [ …≤10 ], "corruptState": false },
  "manager":   { "sources": [ {"id":"local-installed","enabled":true,"lastOk":true} ],
                 "board": { "revision":"…", "items":9, "stale":false },
                 "install": { "enabled": false, "policy": "manual-only", "reason": "v1 只读清单策略" } } }
```
> 字段刻意与 `GET /api/knowledge/agent/status`（`server.mjs:1512-1513` 返回 `{scheduler, manager}`）对齐，
> 前端可以复用同一套渲染组件。

#### #6 `POST /api/extensions/agent/run`

```
Body: { task: "all"|"inventory"|"catalog"|"verify" }
400: 其它取值 → EXT_TASK_INVALID（对照 `server.mjs:1517-1519` 对 KMA task 的白名单校验写法）
200: { ok:true, cycle:{...} }
```

#### #8–#10（v1 占位，fail-closed）

```
POST /api/extensions/install/approvals  -> 501 { ok:false, error:{ code:"EXT_INSTALL_DISABLED",
             message:"扩展安装首版未开放：当前只提供只读清单与推荐。安装需先完成来源校验/隔离验证/回滚设计评审。" } }
POST /api/extensions/install            -> 501 同上（**即使带了合法 approvalIds 也拒绝**，避免"批量预置 tokens 等开关"这种绕过）
POST /api/extensions/rollback           -> 501 同上
```
> 为什么不用 403：403 语义是"你没权限"，会让用户以为申请权限即可；
> 501 Not Implemented 才是事实——**功能未实现**，与"权限不足"必须区分（这也是仓库既有作风：
> `BRIDGE_UNAVAILABLE_CODES` 映射 503 而非 400 的同类取舍，见 `server.mjs:108-120` 注释）。

### 3.4 证据 envelope 契约

#### 3.4.1 需要增加的唯一一处契约改动

| 文件 | 位置 | 改动 | 影响面 |
| --- | --- | --- | --- |
| `runtime/evidence-contract.mjs` | `:20` `EVIDENCE_SUBJECT_TYPES` | `+= 'extension'` | 纯加法：仅 `assertEvidenceEnvelope:51` 的成员判定；无任何 switch/枚举分支依赖它 |
| `runtime/evidence-store.mjs` | `:20-26` `EVIDENCE_KINDS` | `+= 'extension-inventory'` | 见下方★副作用 |

★ **副作用必须知情**：`runtime/design-spec.mjs:41` 有 `export const DESIGN_SPEC_EVIDENCE_KINDS = Object.freeze([...EVIDENCE_KINDS])`，
即新 kind 会**自动成为 design-spec 允许引用的证据类型**（`design-spec.mjs:228`、`:441` 用它做白名单校验）。
这在语义上是可接受的（需求可以声明"以扩展能力清单为验收证据"），但要写入文档，避免以后有人以为是 bug。
另外 `server.mjs:2753` 的证据保留清理默认取 `[...EVIDENCE_KINDS]`，新增 kind 会让 `prune` 也多扫一个目录（该目录可能不存在，`list()` 返回 `[]`，安全）。

> **v1 只加一个 kind**（`extension-inventory`）。安装/隔离验证证据（`extension-install` / `extension-isolation-test`）
> 随 v2 一起加——首版不做安装，就不该提前扩大契约面。

#### 3.4.2 envelope 形状（inventory）

```json
{
  "schemaVersion": 1,
  "kind": "extension-inventory",
  "subject": { "type": "extension", "id": "local-editor" },
  "fingerprint": {
    "edaVersion": "3.2.186",
    "inventoryDigest": "<sha256 of sorted installed[]>",
    "capabilityRevision": "4f1c9ab0d2e3a7c1",
    "editorProfile": null
  },
  "source": { "agent": "extension-registry", "version": "1.0.0", "readOnly": true },
  "verdict": "advisory",
  "findings": [
    { "code": "EXT_SOURCE_DEGRADED", "severity": "info",
      "message": "market-catalog 源超时，本次只含本地清单（不影响本地结论）" }
  ],
  "counts": { "installed": 9, "updates": 2, "stale": 1, "unverified": 9, "sourcesOk": 1, "sourcesFailed": 2 },
  "details": { "sources": [ "…同 §3.3 #1 的 sources 数组（不含 entryPoints 细节）…" ] },
  "blockedReason": null,
  "generatedAt": "2026-10-23T08:10:00.000Z",
  "digest": "<createEvidenceEnvelope 自算>"
}
```

**verdict 判定表（fail-closed 核心）**：

| 场景 | verdict | findings | 理由 |
| --- | --- | --- | --- |
| 至少一个源成功，且清单可解析 | `advisory` | 可含 `info`/`warning` | 清单是**事实**，不构成"合格判定"，不能用 `pass` |
| **所有**源都失败 | `unknown` | ≥1 条 `error`（`EXT_SOURCE_UNAVAILABLE`） | `evidence-contract.mjs:71` 要求 unknown 必须说明原因；**绝不返回空清单** |
| 本地清单解析出非法条目，且占比 > 阈值 | `blocked` | `EXT_MANIFEST_INVALID` (`error`) | 数据不可信时不提供"能力建议"，避免把坏数据灌进 prompt |
| 单源失败、其它源成功 | `advisory` | `info` 记 degraded | 本地信息仍然可信 |

> 校验点：`verdict:'advisory'` 不受 `assertEvidenceEnvelope` 的额外约束（第 69-71 行只约束 `pass`/`blocked`/`unknown`），
> 这正是"信息类证据"该有的位置。

### 3.5 超时预算（逐层留出余量，任何一层不能等于上一层）

| 层 | 预算 | 依据 / 注意 |
| --- | --- | --- |
| 单源 `local-installed` | 3 s | 本地目录读取，正常 < 100 ms |
| 单源 `market-catalog` | 12 s | 公网；与前端默认请求超时同量级（`runtimeClient.ts:4` `REQUEST_TIMEOUT=12_000`） |
| 单源 `bridge-catalog` | 8 s | 必须 **< 桥单命令默认预算**，否则拿到的是桥超时而非真实结果（原则见 `bridge.mjs:30` 注释） |
| 源汇总（并发） | `max(单源)` = 12 s | `collectExtensionSources` 用 `Promise.all`，不是累加 |
| `agent.timeoutMs` | **30 s** | 覆盖"12s 数据源 + 解析 + 打分 + 落证据"；`invokeAgent` 到点抛 `AGENT_TIMEOUT` |
| `/api/extensions/refresh` 服务端总预算 | 25 s | 必须 < agent 30 s，让路由能给出结构化错误而不是被 invokeAgent 抢先 |
| 前端调用 `refresh` | **30 s（显式传）** | ⚠️ `runtimeClient.ts:39` 的 `request()` 默认 12 s 会**先于**服务端 25 s 超时；必须显式传 `timeoutMs=30_000`（该参数已存在，无需改函数签名） |
| 调度周期 | 默认 30 min，最小 60 s | `createKnowledgeScheduler:30` 硬性要求 `intervalMs >= 60_000`，复用骨架时不能更小 |
| 首次延迟 | 60 s | 对齐 `knowledge-scheduler.mjs:15` 的"先让运行时稳定"思路 |

**"实时"的落地口径**（不要承诺做不到的事）：
1. **温**：定时 30 min 全量刷新（本地免费、市场有成本）；
2. **热**：`GET /api/extensions/capabilities?refresh=1` 与 `POST /api/extensions/refresh` 按需；
3. **被动失效**：任何读接口发现 `generatedAt` 超 `staleAfterMs`（默认 24 h）→ 返回 `stale:true` 并在 prompt 片段里降权/加免责；
4. **不做** `fs.watch`（v1）：Electron 侧写盘行为不可控、可能触发写风暴，且权限/沙箱不确定。
   若 local-probe 证实落盘路径稳定且无写风暴，v2 再考虑作为**可选加速器**（失败即退回轮询，不影响正确性）。

---

## 4. 能力公告板（Capability Board）

目标：**让别的 AI agent（chat / 计划生成 / 网表生成）在不被灌一堆无关内容的前提下，知道"这台机器上现在能调哪些扩展能力"**。

### 4.1 数据结构 `ExtensionCapability`

字段覆盖任务书要求的九项（extensionId/uuid/version/tags/入口命令/前置条件/兼容EDA版本/上次验证时间/状态），并补齐安全与审计所需字段。

```jsonc
{
  "schemaVersion": 1,
  "extensionId": "easyeda-color-silkscreen",     // 本地稳定 id（kebab），无 uuid 时由 name+version 派生并标注 derived
  "uuid": "6f9a1c2d-...-e3",                     // EDA 扩展 uuid；读不到为 null（不猜）
  "name": "AI 彩色丝印生成器",
  "version": "1.4.2",                            // semver 解析失败 → 保留原文 + versionParsed:false
  "versionParsed": true,
  "publisher": { "name": "liuem", "verified": false },   // verified 只能由 §5.4 的来源校验置 true
  "summary": "把图片/Logo 转成彩色丝印层，用于面板与铭牌。",   // ≤ 120 字，注入时再截断
  "tags": ["彩色丝印", "丝印", "外观", "demo"],              // 需求标签（§4.4 检索主键）
  "entryPoints": [                                         // 「入口命令」
    { "kind": "menu",    "label": "彩色丝印", "bridgeCommand": null },
    { "kind": "command", "id": "colorSilk.apply", "bridgeCommand": null }
  ],
  "preconditions": [                                       // 「前置条件」
    { "id": "pcb-open",     "label": "需当前打开 PCB 文档", "checkable": true },
    { "id": "after-pour",   "label": "建议在铺铜后执行",    "checkable": false }
  ],
  "sideEffects": "writes-board",         // read-only | writes-board | unknown —— **安全关键，unknown 按 writes-board 处理**
  "installPolicy": "manual-only",        // manual-only | never-auto | blocked（永不出现在推荐里）
  "compat": {                            // 「兼容 EDA 版本」+「上次验证」
    "edaVersionRange": ">=3.2.170 <3.3.0",
    "testedEdaVersions": ["3.2.186"],
    "status": "patch-drift"              // tested | patch-drift | untested | unknown —— 复用 eda-adaptation 词汇
  },
  "status": "probed",                    // §4.2 状态机
  "lastVerifiedAt": "2026-10-23T08:10:00.000Z",
  "lastVerifiedBy": "extension-registry@1.0.0",
  "verificationEvidenceDigest": "<sha256|null>",
  "provenance": { "source": "local-fs", "path": "…/extension.json", "url": null, "fetchedAt": "…", "digest": "…" },
  "trust": "unverified",                 // 复用 KNOWLEDGE_TRUST_LEVELS 的 reference|unverified（不给 authoritative：那不是外部扩展该有的等级）
  "blocked": false,
  "blockedReason": null,
  "boardRevision": 12                    // 每次重算公告板时自增，用于 §4.7 广播
}
```

**字段级红线**：
- `sideEffects` **必须显式**；解析不出来的写 `unknown`，且 `unknown` 在检索时按 `writes-board` 降权（§4.4）。
- `installPolicy` 默认 `manual-only`；任何"看起来与 PCB 设计强相关"的判定都**不能**把 `never-auto` 改成 `auto`——
  这个字段只允许人和 §5 的审批链路改。
- `trust` 不给 `authoritative`（对照 `knowledge.mjs:28` 的三级定义：`authoritative` 需人工 `reviewedBy`）。

### 4.2 状态机（`status`）

```
        (采集到)
   ┌──────────────► unverified ──探测到入口/兼容┄┄► probed ──人工/自动验证通过──► verified
   │                    │                            │                          │
   │                    │                      版本变更│                     超过 staleAfter
   │                    ▼                            ▼                          ▼
   │                incompatible ◄── compat.status='untested'/'unknown'      stale
   │                    ▲                                                      │
   └── disabled（用户/策略停用）◄──────────────────────────────────────────────┘
```

| 状态 | 含义 | 是否出现在 prompt 推荐 |
| --- | --- | --- |
| `verified` | 本机真机验证过入口/版本，且有 `verificationEvidenceDigest` | ✅ 优先 |
| `probed` | 探测到入口文本或版本信息，但未完成端到端验证 | ✅ 标注 `未验证` |
| `unverified` | 只有清单字段（来自文件/市场），无任何探测 | ⚠️ 仅 `includeUnverified=1` 时出现，且带免责句 |
| `stale` | 曾 verified/probed，但超过 `staleAfterMs`（默认 24 h）未刷新，或市场报告有更新 | ⚠️ 出现但降权 + 提示"可能已过期" |
| `incompatible` | `compat.status ∈ {untested, unknown}` 或 EDA 版本超出 `edaVersionRange` | ❌ 硬过滤 |
| `disabled` | 用户在设置里停用，或策略禁用（`blocked:true`） | ❌ 硬过滤 |

### 4.3 落盘与索引（三份文件，职责不重叠）

| 文件 | 内容 | 写入者 | 备注 |
| --- | --- | --- | --- |
| `${stateDir}/extensions/inventory.json` | 最近一次成功采集的**原始**源结果（逐源、含 `fetchedAt`/`digest`/`degraded`） | provider 汇总 | 便于"为什么这次没数据"的自证；不参与打分 |
| `${stateDir}/extensions/capabilities.json` | 归一化后的 `ExtensionCapability[]` + `revision` + `boardRevision` | board builder | **公告板唯一事实源**，用 `createJsonStore`（原子写、schemaVersion、损坏 fail-closed） |
| `${stateDir}/extension-agent.json` | 调度状态（lastRunAt/nextRunAt/history≤10） | scheduler | 复用 `createKnowledgeScheduler` 的 `stateFile` 形态 |

`stateDir` 取值见 `runtime/server.mjs:378`：`process.env.CIRCUITPILOT_STATE_DIR || join(process.cwd(),'artifacts/state')`。
**测试隔离**：新增 `CIRCUITPILOT_EXTENSIONS_DIR` 覆盖（与 `CIRCUITPILOT_EVIDENCE_DIR`、`CIRCUITPILOT_JOB_JOURNAL` 同风格），
避免单测污染真实状态目录。

### 4.4 检索与打分（纯函数，可单测）

**硬过滤**（先砍，再打分）：

```
1. status ∉ {incompatible, disabled}
2. installPolicy !== 'blocked'
3. includeUnverified!==true → status !== 'unverified'
4. tags 与请求 tags 有交集，或 tags 为空且请求 tags 为空
5. sideEffects !== 'writes-board' 时优先；写板类在 forAgent='chat'（纯咨询）时可保留但降权
```

**打分**（同分用 `extensionId` 字典序兜底，保证**渲染稳定 → digest 稳定 → prompt 不抖动**）：

```
score =
    0.50 * tagScore        // 命中请求 tag 的比例
  + 0.20 * statusScore     // verified 1.0 / probed 0.7 / stale 0.4
  + 0.15 * compatScore     // tested 1.0 / patch-drift 0.6 / unknown 0
  + 0.10 * freshnessScore  // 1 - age/ staleAfterMs（≥0）
  + 0.05 * sideEffectScore // read-only 1.0 / unknown 0.3 / writes-board 0.5
```

**需求标签词表（v1 固定）**：`彩色丝印`、`绕组`、`电源打孔`、`规则生成`、`demo`、`格式转换`、`BOM`、`封装库`、`面板`。
> 词表落 `runtime/extension-market/tags.mjs` 常量；**不做 LLM 自动打标**（不确定性会污染 prompt 且不可审计）。
> 若扩展自身 `extension.json` 带 category/keywords，映射表里维护"外部词 → 内部 tag"，映射不中则进 `other` 桶。

### 4.5 Token 预算裁剪（三档降级）

| 档位 | 触发 | 每项内容 | 估算 |
| --- | --- | --- | --- |
| `full` | budget ≥ 900 | name + version + summary(≤60字) + 1 个入口 + 2 个前置 + compat + 免责 | ~110 token/项 |
| `compact` | 400 ≤ budget < 900 | name + version + summary(≤30字) + 1 入口 + compat | ~55 token/项 |
| `id-only` | budget < 400 | `{name, version, sideEffects}` 单行 | ~18 token/项 |

```
默认 budget = 900 token，硬上限 1500（防止调用方传入巨大值把上下文撑爆）
token 估算：ceil(chars / 2.2)  （中英混排的经验系数；只用于裁剪，不用于计费断言）
裁剪顺序（每步都记录到 tokenBudget.droppedBy）：
  1. 砍 status==='stale' 的条目
  2. 降一档 detail 级别
  3. 砍 sideEffects==='writes-board' 的条目（纯咨询场景）
  4. 保留前 N 项，N 由剩余预算决定
```

> 参照已有实现的有界投影思路：`runtime/chat.mjs:247` 的 `summarizePinEvidenceForPrompt`
> （只做"行数/字段截断"，不放宽任何 fail-closed 审计）。**裁剪只影响注入文本，不影响落盘数据**。

### 4.6 注入策略（三处消费点，各有各的边界）

#### 消费点 1 · `chat`（需求澄清对话）——最小可行实现

`runtime/chat.mjs:220-224` 的 `INSTRUCTIONS` 是**模块级常量**；但 `:616-619` 已经存在"按情况拼接 instructions"的先例
（历史会话拼接）。**照此先例拼接，不改 `INSTRUCTIONS` 常量本身**——避免改动影响所有对话轮次的既有语义：

```
【改动点，非实现代码】
runtime/chat.mjs  ChatManager.send(sessionId, body)  (:571 起)
  - 新增有界投影：summarizeExtensionsForPrompt(board, { budgetTokens: 600 })   ← 放 chat.mjs 内，与 :247 同风格
  - instructions 组装处（:616-619 附近）追加：
      const extBrief = summarizeExtensionsForPrompt(...);
      const instructions = `${INSTRUCTIONS}${extBrief ? `\n\n${extBrief.text}` : ''}${history…}`;
  - body.extensions 缺省 → 不注入（保持旧行为，向后兼容）
```

**prompt 片段（服务端生成，实测 ≈ 180 token / 4 项）**：

```text
【可用嘉立创EDA扩展能力（运行时只读公告板 revision 4f1c9ab0，本机已安装，未验证≠不可用）】
- AI 彩色丝印生成器 v1.4.2（入口：菜单「彩色丝印」；前置：需打开PCB；副作用：写板；兼容：3.2.186 patch-drift）
- PCBTans CSV 绕组导入 v0.9.1（入口：菜单「导入绕组」；前置：需CSV文件；副作用：写板；兼容：未验证）
- 设计规则生成器 v2.0.0（入口：菜单「规则生成」；副作用：只读建议；兼容：tested）
说明：以上为"可向用户建议使用"的扩展，不是 CircuitPilot 已集成能力；不得声称已调用、不得编造其参数。
若用户需求需要写板类扩展，必须先请用户手动安装并在 EDA 内自行执行，CircuitPilot 不代执行。
```

三条硬约束（写进 prompt，也写进验收）：
1. **"未验证≠不可用"，但也"不得声称已调用"**——防止模型把"清单里有"讲成"我已经用了"；
2. 写板类扩展只做**建议**，不代执行（这也是 §5.1 的对外表述一致性）；
3. 片段里**不带** uuid/路径/下载地址（不给模型"凭据感"）。

#### 消费点 2 · 计划生成器（`chat.mjs:639 plan` / `:670 productionPlan` / `:693 netlist`）

这三处的 `instructions` 是**每次调用现拼的局部常量**（`:654`、`:675`、`:697`），追加成本低、风险小。
建议：只在 `plan`（原理图计划）与 `productionPlan`（PCBA 语义计划）注入 `compact` 档，
并在 schema 中**不新增任何字段**（避免动 `DESIGN_PLAN_OUTPUT_SCHEMA` / `PCBA_PLAN_OUTPUT_SCHEMA`），
仅作为"背景知识"出现在 instructions 里。

> ⚠️ 风险提示：这两个生成器都受 JSON Schema 严格约束，**新增输出字段会连带改 schema + 前端类型 + 单测**。
> v1 明确**不改 schema**，扩展能力只影响"文字建议"，不进入结构化计划。

#### 消费点 3 · 未来的 orchestrator 旁路 step

见 §2.3：`verdict` 必须是 `advisory`/`pass`，且只在调用方显式传 `steps` 时启用。

### 4.7 失效与版本变更广播

**不引入 SSE / WebSocket**（现有 `GET /api/events` 是 `listEvents()` 的历史日志快照，`server.mjs:3633-3634`，
不是推送通道；为此新增推送会引入新的常驻资源与前端重连逻辑，收益不足）。

采用**"摘要 + 轮询 + 主动告知"**三步：

| 机制 | 实现 |
| --- | --- |
| 内容摘要 | `revision = sha256(canonical(sorted items 的 {extensionId,version,status,compat.status}))[:16]`；任何字段变化都会换 revision |
| 对外暴露 | 所有读接口都带 `revision`；`GET /api/extensions/capabilities` 支持 `If-None-Match` 语义的 `?revision=<old>` → 未变则 `{ok:true, unchanged:true}`（前端 5 s 轮询成本≈0） |
| 变更落证 | revision 变化时**立即**落一条 `extension-inventory` 证据 + `logger.info('Extensions','Board revision changed',{from,to,changes})`，并把 `changes[]` 挂在 `agent/status` 里 |
| 变化分类 | `added` / `removed` / `version-changed` / `status-changed` / `compat-changed`（逐条给出 extensionId 与 from/to） |
| 主动告知 | 下一轮 chat 若带了 `extensionsBrief` 且 `revision` 与上一轮不同，在 reply 前置一句"检测到本机扩展清单变化（X 项）"——只**告知**，不改变已有计划、不自动装/升 |

**过期（stale）广播口径**：`stale:true` 时 prompt 片段首行改为
`【可用嘉立创EDA扩展能力（数据已过期 N 小时，仅供参考）】`，且所有条目 `statusScore` 强制 0.4。
**绝不在过期时仍然给出"该扩展版本是本机最新"的断言**（对齐 `eda-adaptation` 对 `unknown` 的处理：
"禁止给出已适配结论并把指引写成不要走写链路"，`docs/implementation/circuitpilot-completion-checklist.md:683`）。

### 4.8 最小可行实现（3 件套，不含 UI）

| # | 产物 | 路径 | 规模量级 |
| --- | --- | --- | --- |
| 1 | 公告板纯函数 + 打分裁剪 | `runtime/extension-market/capability-board.mjs` | ~180 行 |
| 2 | 落盘 + 检索端点 | `runtime/server.mjs` 新增 3 条路由（#1/#3/#4）+ `runtime/extension-market/store.mjs` | ~60 行 + 路由 ~40 行 |
| 3 | prompt 片段 | `runtime/extension-market/prompt.mjs`（生成 §4.6 文本）+ `runtime/chat.mjs` 一处拼接 | ~70 行 + 3 行改动 |

> 3 件套完成即可满足"告知其他 agent 可调用哪些扩展"。**安装链路可以完全不在 MVP 里**——
> 这与"首版只读清单 + 建议"的决策（§5.1）互为支撑。

---

## 5. 安装 / 更新安全设计

### 5.1 首版决策：**只读清单 + 推荐，不自动安装、不静默更新**

| 选项 | 判定 | 理由 |
| --- | --- | --- |
| A. 自动下载 + 自动更新（用户原话的字面实现） | ❌ 首版否决 | ① 扩展包在 EDA 主进程内执行任意 JS，等同**任意代码执行**；② 无签名/无 publisher 白名单时，自动更新 = 把供应链完全交给第三方；③ 静默更新会让"上周验证过的能力"在用户不知情下变化，直接击穿 §4 公告板的 `verified` 语义；④ 合规风险（抓取/自动安装可能违反市场 ToS，待 recon 定论） |
| B. 只读清单 + 相关推荐 + 一键人工安装（跳转/引导） | ✅ **首版采纳** | 满足"管理市场"的可感知价值；把不可逆动作留给人 |
| C. 审批后自动安装（v2 候选） | ⚠️ 需前置条件 | 必须先具备 §5.3–5.6 全部能力，并有至少 2 个真实扩展的隔离验证样本 |

**对外表述必须一致**：UI、prompt、API 错误码三处都写"首版不安装"，不允许一处说"自动"一处说"手动"。

### 5.2 三个动作的权限分层（与 Bridge 权限模型同构）

参照 `bridge.mjs` 的 `read / write-beta / write` 分层思路，扩展侧定义：

| 动作 | 等价权限 | 谁执行 | 是否产证据 |
| --- | --- | --- | --- |
| 读清单 / 读市场 / 读公告板 | `read` | `extension-registry`（只读 agent） | 是（`extension-inventory`，`advisory`） |
| 下载 `.eext` 到暂存区 | `write-beta`（受控） | `ExtensionMarketService`（**必须先有审批**） | 是（`payload.stage:'download'`） |
| 安装 / 升级 / 回滚 | `write`（受控 + 一次性） | `ExtensionMarketService` | 是（`payload.stage:'install'`） |

> 下载也算写：它把外部字节落进本机磁盘。**"只是下载"不是无害的**——这正是 Bridge 把 `export-beta` 也归入 `allowWrite` 的同理（`bridge.mjs:1058`）。

### 5.3 人工审批令牌设计

**复用 `createApprovalService`（`runtime/approval-service.mjs:39`）**，而不是 `automation/approvals.mjs:32` 的
`createApprovalStore`——后者把 bindings 固定成 `{recipeId, fingerprint, planHash}`（`:57-58`、`:94`），
无法表达"这个扩展的这个版本的这个摘要"。

```js
【接口形状】
const installApprovals = createApprovalService({
  allowedScopes: ['write'],          // 复用既有 scope，不改 APPROVAL_LEDGER_SCOPES
  defaultTtlMs: 15 * 60 * 1000,      // 安装审批比写板审批更短：15min（写板默认 30min，见 approvals.mjs:22）
  onEvent: (event) => {
    // 只把 issued/consumed 写哈希链（与 approvals.mjs:74 的取舍一致：replayed/expired/mismatch 只返回错误码）
    if (event.action === 'issued' || event.action === 'consumed') {
      approvalLedger.record({
        scope: 'write',                                    // ← 见下方"为什么不新增 scope"
        action: event.action === 'issued' ? 'issued' : 'consumed',
        approvalId: event.record.approvalId,
        bindings: {                                        // 账本只记绑定哈希，不记令牌原文（approval-ledger.mjs:10 的红线）
          kind: 'extension-install',
          extensionId: event.record.bindings.extensionId,
          uuid: event.record.bindings.uuid,
          version: event.record.bindings.version,
          artifactDigest: event.record.bindings.artifactDigest,
        },
        note: `extension-install:${event.record.bindings.extensionId}@${event.record.bindings.version}`,
      });
    }
  },
});
```

**审批绑定的完整字段（缺一不可）**：

```jsonc
{
  "kind": "extension-install",
  "extensionId": "easyeda-color-silkscreen",
  "uuid": "6f9a1c2d-…-e3",
  "version": "1.4.2",
  "artifactDigest": "<sha256 of .eext bytes>",   // 下载后重算，与市场声明比对
  "publisher": "liuem",
  "edaVersionRange": ">=3.2.170 <3.3.0",
  "currentEdaVersion": "3.2.186",                // 审批时快照：EDA 换版本后旧审批自动失效
  "isolationProjectUuid": "<隔离试验工程 uuid>",  // 强制：安装必须发生在隔离工程里
  "action": "install" | "upgrade" | "rollback"
}
```

消费时必须逐字段比对（`consumeToken({token, requiredScope:'write', expectedBindings})`，定义在 `approval-service.mjs:135`，
其内部对 `expectedBindings` 的每个字段做严格 `!==` 比较，任一不符 → `APPROVAL_MISMATCH`）。
**"批完换版本"因此不可能成立**——这与写板审批 "批完换块板再执行" 的防护同源（`approvals.mjs:28-30` 的 fingerprint 设计）。

**为什么不新增 `scope:'extension'`**：
`approval-ledger.mjs:17` 的 `APPROVAL_LEDGER_SCOPES` 是账本写入的白名单，新增 scope 会抛 `APPROVAL_LEDGER_SCOPE_INVALID`；
两个方案：
- **v1 采纳**：`scope:'write'` + `bindings.kind:'extension-install'` 区分。零契约改动，账本按 `bindings.kind` 可筛选。
- v2 可选：把 `'extension'` 加进 `APPROVAL_LEDGER_SCOPES` 与 `APPROVAL_LEDGER_ACTIONS`（`+installed/rolledback`）。
  收益仅是审计可读性；成本是 `approval-ledger.test.mjs` 等既有测试的枚举断言可能失败。**v1 不做**。

### 5.4 来源与版本校验（下载后、安装前的硬门）

| # | 校验 | 通过条件 | 失败码 |
| --- | --- | --- | --- |
| V1 | 发布者白名单 | `publisher` ∈ 用户配置白名单，或用户在审批弹窗里**显式勾选"我信任该发布者"**（记录到 bindings） | `EXT_PUBLISHER_NOT_ALLOWED` |
| V2 | uuid 一致 | 包内 `extension.json` 的 uuid === 市场条目 uuid === 审批绑定的 uuid | `EXT_UUID_MISMATCH` |
| V3 | 摘要一致 | 下载字节 sha256 === 市场声明 digest === 审批绑定 `artifactDigest` | `EXT_ARTIFACT_DIGEST_MISMATCH` |
| V4 | 版本单调 | `upgrade` 时 `new > current`（semver）；降级必须 `action:'rollback'` 走单独审批 | `EXT_VERSION_DOWNGRADE_BLOCKED` |
| V5 | 兼容版本 | `currentEdaVersion` 落在 `edaVersionRange` 内；不在内则 `compat.status='untested'`，**必须人工二次确认**并记录 | `EXT_COMPAT_UNVERIFIED` |
| V6 | 包结构 | 只为 `zip`、必须含 `extension.json`、**不得含符号链接**、解压后总大小 ≤ 上限（如 50 MB）、条目数 ≤ 上限 | `EXT_PACKAGE_INVALID` |
| V7 | 签名（若有） | 市场提供签名则校验；**无签名不阻断但强制标记 `trust:'unverified'`** | `EXT_SIGNATURE_INVALID`（有而错才失败） |

> V7 的取舍很重要：**把"无签名"变成阻断条件，等于首版永远装不了**（现实里第三方扩展大多没签名）。
> 所以采用"无签名 → 降级信任 + 强制人工确认"，而不是伪造一个我们并没有的保证。

### 5.5 回滚

| 项 | 设计 |
| --- | --- |
| 回滚依据 | 安装前把**当前版本完整清单**快照落盘（`${stateDir}/extensions/snapshots/<extensionId>/<version>-<digest>.json`）+ 保留原始 `.eext` 于 `${stateDir}/extensions/packages/` |
| 回滚动作 | 卸载新版本 → 用保留的旧 `.eext` 重装（若 EDA 支持侧载）或按快照恢复配置；**每一步都需独立审批**（`action:'rollback'`） |
| 回滚失败 | `state:'rollback_failed'` 并**进入问题中心**（对齐 `PcbManager` 的 `rollback_failed` 语义与 UI 展示，`EdaPage.tsx:571` 的"恢复/锁定状态"字段） |
| 不允许 | 自动重试回滚（写动作永不自动重放，遵循 `bridge.mjs:1120` 与 `automation/approvals.mjs` 的同一条纪律） |

### 5.6 隔离测试工程

**红线：任何安装/升级都不允许发生在用户正在设计的工程里。**

```
1. 审批绑定的 isolationProjectUuid 必须是一个**新建的、命名带前缀的**工程（如 CP-EXT-LAB-<extensionId>-<ts>）：
   通过既有 `workspace.create` 通道创建（`bridge.mjs:66`，permission 'write-beta'，需 allowWrite）——
   它的 `buildCode` 会一次建好 project+schematic+pcb+board，适合作为一次性沙箱；
2. 在该工程里安装候选扩展；
3. 跑 smoke 序列（全部只读/可回滚）：
   a) 重新采集清单，确认新版本号读回一致（**读回不符即失败**，不"看起来装上了"就算成功）
   b) 尝试探测扩展入口文本是否存在（复用 `gui-capabilities.mjs:72 catalogTexts` + 桥 `findTexts` 思路）
   c) 在沙箱 PCB 上跑一次官方 DRC（`pcb.drc`，permission 'validate'）确认没把环境搞坏
4. 通过 → 才允许在目标工程"可用"；不通过 → 自动卸载并记录失败证据（不重试）
```

> 注意：`workspace.create` 是 `write-beta`，需要 `allowWrite:true`，且它创建的是**真实 EDA 工程**（会出现在用户的工程列表里）。
> 因此沙箱工程必须有**明确的命名前缀 + 可清理说明**，并在 UI 上告知"这条会新建一个临时工程"。这一成本要提前告知决策者。

### 5.7 审计

| 审计项 | 落点 |
| --- | --- |
| 审批生命周期 | `approval-ledger` 哈希链（`createApprovalLedger.record`，`approval-ledger.mjs:43`；`verify()` 第 58 行可校验链完整性） |
| 安装事实 | evidence kind `extension-install`（v2 新增到 `EVIDENCE_KINDS`），`payload = {stage, extensionId, uuid, version, artifactDigest, publisher, outcome, isolationProjectUuid, smoke:{...}}` |
| 采集事实 | evidence kind `extension-inventory`（v1 已有） |
| 操作日志 | `logger.info('Extensions', ...)`，**绝不记录令牌原文**，只记 `approvalId`（遵循 `server.mjs:1279-1288` 对令牌的处置：只记"有没有 header"） |
| 对外查询 | `GET /api/extensions/audit` → `{ ledger: approvalLedger.snapshot({limit}), evidence: [...refs], install: {enabled:false, policy:'manual-only'} }` |

### 5.8 必须的人工开关（放在 SettingsPage 安全策略区）

对照 `src/pages/SettingsPage.tsx:409` 现有的 `03 · SAFETY POLICIES` 面板（已有 `writePaused` 全局暂停开关），新增：

| 开关 | 默认 | 语义 |
| --- | --- | --- |
| 允许读取扩展市场（联网） | **关** | 关 → `market-catalog` 源 `DISABLED_BY_POLICY`（对齐 `research.mjs` 的"联网默认关闭 + 每请求显式 allowResearch"作风，`server.mjs:1540-1543`） |
| 允许推荐扩展能力给 AI | 开 | 关 → 不注入 prompt 片段（§4.6） |
| 允许安装/升级扩展 | **关（v1 固定关且不可开）** | v1 该开关渲染为 disabled + 说明"首版未开放" |

---

## 6. 测试与验收

### 6.1 单测清单（`node:test`，文件与既有风格一致；`npm run test:runtime` 覆盖 `runtime/**/*.test.mjs`）

| 文件 | 用例（断言点） |
| --- | --- |
| `runtime/__tests__/extension-providers.test.mjs` | ① `defineExtensionProvider` 对非法 id / 缺 `run` / `readOnly:false` 抛 `EXT_INVALID`；② `runExtensionProvider` 超时 → `EXT_SOURCE_TIMEOUT`（用 10ms 假 provider）；③ 抛错 → `EXT_SOURCE_UNAVAILABLE` 且**不上抛**；④ 一个源挂、另两个正常 → `collectExtensionSources` 仍 `ok≥2` 且 `failed===1`；⑤ 返回项缺 `extensionId` 被丢弃并计数 |
| `runtime/__tests__/extension-registry.test.mjs` | ① 用同一工厂构造的 agent 过 `defineAgent`（`readOnly:true`）；② `invokeAgent` 拿合规 envelope → `{ok:true, verdict:'advisory'}`；③ 三源全挂 → `verdict:'unknown'` 且 findings 有 error；④ 构造非法 envelope（`schemaVersion:2`）→ `AGENT_EVIDENCE_INVALID`；⑤ agent 超时 → `AGENT_TIMEOUT`；⑥ `subject.type:'extension'` 通过契约 |
| `runtime/__tests__/extension-capability-board.test.mjs` | ① tag 命中排序与 `extensionId` 兜底稳定（同一输入两次渲染 digest 相同）；② `budget=900/500/120` 三档 `droppedBy` 正确；③ `incompatible`/`disabled` 硬过滤；④ `includeUnverified` 开关；⑤ `stale` 降权；⑥ 过期时 prompt 首行为"数据已过期" |
| `runtime/__tests__/extension-prompt-budget.test.mjs` | ① 片段 token 估算 ≤ budget；② 片段**不含** uuid/路径/下载地址（正则断言）；③ 必含"不得声称已调用"免责句 |
| `runtime/__tests__/extension-market-service.test.mjs` | ① v1 `install()` 恒抛 `EXT_INSTALL_DISABLED`（带合法 approvalIds 也抛）；② 无审批 → `EXT_APPROVAL_REQUIRED`；③ 绑定 version 不符 → `APPROVAL_MISMATCH`；④ 降级 → `EXT_VERSION_DOWNGRADE_BLOCKED`；⑤ digest 不符 → `EXT_ARTIFACT_DIGEST_MISMATCH`；⑥ 含符号链接的包 → `EXT_PACKAGE_INVALID` |
| `runtime/__tests__/extension-scheduler.test.mjs` | ① `intervalMs<60000` 抛（复用骨架约束）；② `running` 互斥返回 `EXT_REFRESH_BUSY`；③ 状态文件损坏 → `corruptState:true` 但不崩；④ `runCycle` 抛错只记 `lastResult.ok=false` |
| `runtime/__tests__/extension-http.test.mjs` | ① `GET /api/extensions/inventory` 200 且含 `sources[]`（**用注入的假 provider，不联网**）；② 源全挂 → 503 + `EXT_SOURCE_UNAVAILABLE`；③ 无令牌 → 401（复用运行时鉴权）；④ `POST /agent/run {task:'nope'}` → 400；⑤ `install` → 501；⑥ `?revision=<旧>` 未变 → `{unchanged:true}` |

**证据契约单测**（防回归）：在 `runtime/__tests__/evidence-contract.test.mjs` 追加一例
"`subject.type:'extension'` 可通过 + `kind:'extension-inventory'` 可落 evidenceStore"。

### 6.2 接口测试（手工 / 脚本，需真实运行时）

```bash
# 0) 取令牌（开发模式）
TOKEN=$(curl -s -H 'Origin: http://127.0.0.1:5173' http://127.0.0.1:4178/api/health | jq -r .sessionProof)
H="x-circuitpilot-token: $TOKEN"

# 1) 清单（本地源应 ok）
curl -s -H "$H" 'http://127.0.0.1:4178/api/extensions/inventory' | jq '.inventory.counts, .inventory.sources'
# 2) 市场源未开 → degraded 必须如实说明，不得返回空数组冒充"无结果"
curl -s -H "$H" 'http://127.0.0.1:4178/api/extensions/catalog' | jq '.degraded'
# 3) 公告板 + 预算
curl -s -H "$H" 'http://127.0.0.1:4178/api/extensions/capabilities?tags=彩色丝印&budget=500' | jq '.board.tokenBudget'
# 4) revision 未变
curl -s -H "$H" 'http://127.0.0.1:4178/api/extensions/capabilities?revision=deadbeef' | jq '.unchanged'
# 5) 安装恒 501
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "$H" -H 'content-type: application/json' \
  -d '{"approvalIds":["fake"]}' http://127.0.0.1:4178/api/extensions/install
# 6) 路由消费者契约（CI 必跑）
npm run test:runtime -- --test-name-pattern='路由消费者契约'
```

### 6.3 离线夹具（`runtime/__tests__/fixtures/ext-market/`）

| 夹具 | 用途 |
| --- | --- |
| `installed-pro.json` | 9 条真实结构清单（**字段名待 local-probe 确认后填入**，先按 §4.1 形状写） |
| `market-page-1.json` | 市场首屏（**待 recon**） |
| `malformed-manifest.json` | 缺 uuid / version 非法 / tags 非数组 → 断言"丢弃并计数"，不整体崩 |
| `extension-ok.eext` | 合法 zip 包（含 `extension.json`），仅用于 V6 结构校验单测 |
| `extension-evil.eext` | 含 `../` 路径与符号链接的恶意样本 → 必须 `EXT_PACKAGE_INVALID` |

> 夹具全部是**合成样本**，不得把真实第三方扩展包提交进仓库（体积 + 许可证 + 供应链）。

### 6.4 fail-closed 行为矩阵（验收逐条核对）

| 场景 | 期望行为（不允许的写法） |
| --- | --- |
| 本地目录不存在 | `sources` 里 `ok:false, code:'EXT_SOURCE_UNAVAILABLE'`；**禁止**返回 `installed: []` 当成"没装扩展" |
| 市场 403 / ToS 禁止 | `degraded:'DISABLED_BY_POLICY'` + 设置开关说明；**禁止**重试轰炸 |
| 市场超时 | 503 `EXT_SOURCE_TIMEOUT` + `retryable:true`；本地清单结果**照常返回**（部分成功也返回部分结果 + 明确标注） |
| 清单 JSON 损坏 | 该条丢弃并计数；损坏率超阈值 → envelope `blocked` + 不注入 prompt |
| EDA 版本读不到 | `edaVersion:null, edaVersionSource:'unknown'`；`compat.status='unknown'` → 条目 `incompatible` **不推荐** |
| 公告板过期 | `stale:true` + prompt 免责；**禁止**断言"最新版本" |
| prompt 预算不足 | 降档 + `droppedBy` 记录；**禁止**截断 JSON 造成半条能力 |
| 无审批调 install | 409/501 + 明确下一步；**禁止**"无审批也先下载" |
| 审批绑定不符 | `APPROVAL_MISMATCH`（消费即失效，不可二次尝试同一 token） |
| 安装后回读不符 | 判失败并回滚；**禁止**把"命令返回 true"当成功 |
| 任何写动作失败 | 不自动重试（`bridge.mjs:1120` 纪律）；置 `rollback_failed` 进问题中心 |
| 运行时重启 | 审批全部失效（`approval-service.mjs` 内存态，`approvals.mjs:16` 的既定行为）；公告板从 JSON 重载 |

### 6.5 验收标准（DoD）

1. `npm run typecheck` 0 错；`npm run test:runtime` 全绿（含新增 7 个测试文件 + 证据契约回归例）；
2. **路由消费者契约测试**通过（10 条新路由各有消费者或已登记 `KNOWN_UNWIRED_ROUTES`）；
3. `GET /api/extensions/inventory` 在**断网**状态下仍能返回本地清单（`market-catalog` 失败被隔离）；
4. 公告板同一输入两次调用 `revision` 相同（稳定性）；改一个版本号 `revision` 必变（敏感性）；
5. `POST /api/extensions/install` 在 v1 恒 501，且带合法/非法 approvalIds 都 501（无法通过构造请求绕过）；
6. 证据：`artifacts/evidence/extension-inventory/` 下出现可校验（digest 自洽）的文件，`assertEvidenceEnvelope` 通过；
7. 前端：EdaPage 出现"扩展能力"面板（只读 + 推荐），SettingsPage 出现 3 个开关（其中安装开关 disabled）；
8. 文档：本文 §7 的落点清单与实际 diff 一一对应（评审时逐条核对）。

---

## 7. 代码落点清单与风险

### 7.1 新增文件（8 个）

| 路径 | 职责 | 规模量级 | 风险 |
| --- | --- | --- | --- |
| `runtime/extension-market/providers.mjs` | `defineExtensionProvider` / `runExtensionProvider` / `collectExtensionSources`（对标 `collectors/collect.mjs`） | ~150 行 | 低（纯函数 + 注入 io） |
| `runtime/extension-market/providers/local-fs.mjs` | 本地已装清单读取（路径**待 local-probe**） | ~120 行 | **中**：路径/格式随 EDA 版本变化 → 必须"读不到就 degraded，不猜" |
| `runtime/extension-market/providers/market-api.mjs` | 市场清单（**待 recon + 合规结论**；默认 `DISABLED_BY_POLICY`） | ~140 行 | **高**：外部服务不稳定/改版/ToS；必须有超时+缓存+降级 |
| `runtime/extension-market/providers/bridge.mjs` | 桥接读取（v1 默认 `EXT_SOURCE_UNAVAILABLE`） | ~60 行 | 中：依赖 `COMMANDS` 先登记只读命令 |
| `runtime/extension-market/capability-board.mjs` | 归一化 + 打分 + token 裁剪 + prompt 片段生成（§4.4–4.7） | ~220 行 | 低（纯函数，重点覆盖单测） |
| `runtime/extension-market/prompt.mjs` | `summarizeExtensionsForPrompt`（有界投影，供 chat 消费） | ~70 行 | 低 |
| `runtime/extension-market/service.mjs` | `createExtensionMarketService`（安装/回滚；v1 fail-closed） | ~180 行 | **高**：写权限。建议 v1 只实现"拒绝 + 校验前置"部分，安装执行体留 TODO |
| `runtime/agents/extension-registry.mjs` | 只读 agent（`defineAgent` 包装 + 产 envelope） | ~160 行 | 中：必须严格 `advisory`/`unknown` 语义（§3.4.2） |

另加**测试 7 个文件** + **夹具 5 个**（§6.1/6.3）。

### 7.2 需要修改的现有文件（共 9 处，全部为加法）

| 文件 | 位置 | 改动 | 风险 / 兼容性 |
| --- | --- | --- | --- |
| `runtime/server.mjs` | `:518` 之后 | 新增 import + 实例化 `extensionManager` / `extensionRegistry` / `extensionScheduler`（**env 开关 `CIRCUITPILOT_EXTENSION_AGENT=off` 默认 on，可一键关停**） | 低：与 KMA 同级并排；注意 `stateDir` 已有 |
| `runtime/server.mjs` | `:1537` 之后 | 新增 10 条路由（写法必须落在 §3.2 的三种形态内） | 中：**route-contract.test 会扫描**，写法错就"路由不存在" |
| `runtime/server.mjs` | 启动块 `:515-518` 附近 | 按 env 决定是否 `extensionScheduler.start()` | 低：参照 KMA 的 `CIRCUITPILOT_KNOWLEDGE_AGENT !== 'off'` 写法 |
| `runtime/evidence-contract.mjs` | `:20` | `EVIDENCE_SUBJECT_TYPES` 加 `'extension'` | 低（纯加法）；但**属于契约文件，需在 PR 描述里显式声明** |
| `runtime/evidence-store.mjs` | `:20-26` | `EVIDENCE_KINDS` 加 `'extension-inventory'` | 中：见 §3.4.1 ★ 副作用（会扩宽 `DESIGN_SPEC_EVIDENCE_KINDS`） |
| `runtime/chat.mjs` | `:571` `send()` / `:616-619` instructions 组装 / 新增 `summarizeExtensionsForPrompt` 调用 | 注入 prompt 片段（budget 600） | **中高**：改的是所有对话轮次的 prompt 组装；必须"无 board 时行为完全不变"，且加单测锁死 |
| `src/services/runtimeClient.ts` | `~:330` 知识库方法组之后 | 新增 6 个方法（inventory/catalog/capabilities/refresh/agentStatus/agentRun），`refresh` 必须显式 `timeoutMs=30_000` | 低；但 `request()` 默认 12 s 的坑必须显式覆盖 |
| `src/pages/EdaPage.tsx` | `:614` 命令控制台 Panel 之后 | 新增"扩展能力（只读）"Panel：清单表格 + `revision` + degraded 提示 + 刷新按钮 | 低：只读展示，无写按钮 |
| `src/pages/SettingsPage.tsx` | `:409` 安全策略 Panel 内 | 新增 3 个 Toggle（市场联网 / prompt 推荐 / 安装开关 disabled） | 低：`Toggle` 组件已有 |
| `src/types.ts` | 类型区 | 新增 `ExtensionCapability` / `ExtensionInventory` / `ExtensionBoard` 等 6 个类型 | 低 |

### 7.3 明确**不改**的东西（防止"顺手优化"引发回归）

| 文件 | 为什么不改 |
| --- | --- |
| `runtime/agents/orchestrator.mjs` | `PIPELINE_STEPS`(:9) 与默认 `requiredKinds`(:11) 冻结；改动会改变所有既有设计流水线的证据要求 |
| `runtime/gate-engine.mjs` `PCB_GATES` | 加 G7 会让存量 PCB 全部 `unknown` → 签字被拒（§2.4） |
| `runtime/approval-ledger.mjs` 的 `APPROVAL_LEDGER_SCOPES` | 复用 `write` + bindings.kind 已足够（§5.3） |
| `runtime/bridge.mjs` 的 `COMMANDS` | v1 不新增桥命令（桥命令一旦登记就成为通用攻击面的一部分）；若 recon 证实必须新增，只允许 `permission:'read'` |
| 任何 `INSTRUCTIONS` 常量本体 | 只在拼装处追加（§4.6），不改常量文本 |
| `DESIGN_PLAN_OUTPUT_SCHEMA` / `PCBA_PLAN_OUTPUT_SCHEMA` | 新增输出字段会连带改前端类型 + 单测（§4.6 消费点 2） |
| `src/navigation.ts` | 不加新 `PageId`：`PAGE_RESPONSIBILITIES`(:73) 要求每个 PageId 都有条目，`CANONICAL_PAGES`(:202) 与测试共同守护，改动面大于收益 |

### 7.4 开关与回滚（出问题时的最短止损路径）

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `CIRCUITPILOT_EXTENSION_AGENT=off` | on | 不启动调度器（**最外层总闸**） |
| `CIRCUITPILOT_EXTENSION_MARKET=off` | off（首版默认关） | 市场源 `DISABLED_BY_POLICY` |
| `CIRCUITPILOT_EXTENSION_PROMPT=off` | on | 不注入 prompt 片段（chat 行为回到基线） |
| `CIRCUITPILOT_EXTENSIONS_DIR` | `${stateDir}/extensions` | 状态隔离（测试/多实例） |

> 回滚到"零影响"的完整路径：设置 `CIRCUITPILOT_EXTENSION_AGENT=off` + `CIRCUITPILOT_EXTENSION_PROMPT=off`
> → 运行时行为与本次改动前**完全一致**（仅多 10 条路由返回 503 `EXT_SOURCE_UNAVAILABLE`）。

---

## 8. 风险 Top 3 与未决依赖

### 8.1 风险 Top 3

**R1 · 供应链 = 任意代码执行，且我们无法真正"验证安全"（等级：高，不可消除，只能围栏）**
嘉立创EDA 扩展在 EDA 主进程内运行任意 JS。即便通过 V1–V7 校验，也只能证明"包没被篡改"，**不能证明包本身是安全的**。
缓解：首版不自动装（§5.1）；安装动作必须绑定隔离工程 + 一次性审批 + 可回滚 + 审计；
UI 与 prompt 一致声明"未验证≠安全"。**风险残留必须写进用户可见文案，不能只写在本文件里**。

**R2 · 数据通道全部不可控：市场 API 随时可能改版/限流/关停，本地落盘格式随 EDA 版本漂移（等级：高）**
缓解：provider 抽象 + 失败隔离（§2.6）；**任何源失败都不得降级成"空清单"**（§6.4）；
`market-catalog` 默认关闭 + 合规结论未出前不开启；能力公告板永远带 `generatedAt`/`stale`/`degraded`；
所有条目带 `provenance.source`，让用户知道"这条是文件读到的还是网上抓的"。
> 这一条直接决定 §4 公告板能否被信任：**宁可不推荐，也不推错**。

**R3 · "unknown 证据污染门禁"与"prompt 内容越权"两类静默事故（等级：中高，但后果极端）**
- 事故 A：把 `unknown` 的扩展证据塞进 `runDesignPipeline` → 整条流水线变 unknown（F4）；或给 `PCB_GATES` 加 G7 → 全部签字被拒。
  缓解：§2.3/§2.4 的硬约束 + §7.3 的"不改清单" + 单测断言。
- 事故 B：prompt 片段让模型宣称"已调用某扩展"或给出该扩展的参数细节，用户据此以为设计已完成。
  缓解：片段内固定免责句 + 单测正则断言 + **不在片段里放 uuid/路径/参数**（§4.6）。
- 事故 C：`runtimeClient.request` 默认 12 s 与服务端 25 s 预算错配，用户看到"超时失败"但服务端其实成功 → 重复点击 → 重复刷新。
  缓解：显式 30 s + `EXT_REFRESH_BUSY` 幂等（§3.5）。

### 8.2 未决依赖（本文不替它们下结论）

| 依赖 | 影响本文哪一段 | 若结论为"不可行"的变化 |
| --- | --- | --- |
| market-recon：市场是否有公开只读 API、ToS 是否允许 | §3.3 #2、§2.6 表格、§5.1 选项 A 的合规前提 | `market-catalog` 长期 `DISABLED_BY_POLICY`；"市场管理"退化为"已装清单 + 手工引导" |
| local-probe：已装清单落盘位置/格式、桥是否可读、实时性方案 | §3.3 #1、§4.1 的 `uuid`/`provenance.path`、§3.5 的"不做 fs.watch" | 若本地也无法稳定读取 → 整个 agent 降级为"仅手动导入清单文件"（架构仍成立，价值大幅下降） |
| 产品决策：是否接受"安装会新建临时工程"的成本（§5.6） | §5.6 | 若不可接受 → v2 安装功能不做，永久保持"只推荐" |

---

## 附录 A · 完整 envelope 示例（源全挂时，fail-closed）

```json
{
  "schemaVersion": 1,
  "kind": "extension-inventory",
  "subject": { "type": "extension", "id": "local-editor" },
  "fingerprint": {
    "edaVersion": null,
    "inventoryDigest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "capabilityRevision": null,
    "editorProfile": null
  },
  "source": { "agent": "extension-registry", "version": "1.0.0", "readOnly": true },
  "verdict": "unknown",
  "findings": [
    { "code": "EXT_SOURCE_UNAVAILABLE", "severity": "error", "message": "local-installed：扩展目录不存在或不可读（provider 返回 EXT_SOURCE_UNAVAILABLE）" },
    { "code": "EXT_SOURCE_TIMEOUT",     "severity": "error", "message": "market-catalog：超过 12000ms 未返回" },
    { "code": "EXT_SOURCE_UNAVAILABLE", "severity": "error", "message": "bridge-catalog：桥未登记只读扩展命令（EDA_COMMAND_NOT_ALLOWED）" }
  ],
  "counts": { "installed": 0, "updates": 0, "stale": 0, "unverified": 0, "sourcesOk": 0, "sourcesFailed": 3 },
  "details": null,
  "blockedReason": "三个数据源全部不可用：不能把“读不到”当成“没有扩展”",
  "generatedAt": "2026-10-23T08:10:00.000Z",
  "digest": "<由 createEvidenceEnvelope 计算，这里不预填>"
}
```

> 说明：`fingerprint` 至少要有一个非空值（`evidence-contract.mjs:55`），因此即使全挂也用 `inventoryDigest`（空集摘要）占位，
> 而不是让 envelope 校验直接失败——失败原因要能被**读出来**，不是"证据不合格"。

## 附录 B · 与既有 API 的形态对照（给实现者的"抄哪里"索引）

| 要做的事 | 抄这个 | 位置 |
| --- | --- | --- |
| 定义只读 agent | `defineAgent` + `invokeAgent` | `runtime/agents/agent-contract.mjs:20,29` |
| 产证据 | `createEvidenceEnvelope` | `runtime/evidence-contract.mjs:75` |
| 落证据 | `evidenceStore.save({kind,payload,fingerprint,note})` | `runtime/evidence-store.mjs:63` |
| 定义数据源适配器 | `defineCollector`/`runCollector`/`collectAll` | `runtime/collectors/collect.mjs:21,30,50` |
| agent + 定时调度 + status/run 路由 | `knowledgeManager` + `knowledgeScheduler` 的实例化与路由 | `runtime/server.mjs:501-518`、`:1512-1523` |
| JSON 原子状态 | `createJsonStore` | `runtime/store.mjs:20` |
| 一次性人工批准 | `createApprovalService().issue/consumeToken` | `runtime/approval-service.mjs:78,135` |
| 审批审计哈希链 | `approvalLedger.record({scope,action,approvalId,bindings,note})` | `runtime/approval-ledger.mjs:43` |
| 能力目录 + 探测叠加 | `GUI_CAPABILITY_CATALOG` / `evaluateGuiCapabilities` | `runtime/gui-capabilities.mjs:14,83` |
| 版本兼容判定词汇 | `assessEdaAdaptation` 的 `tested/patch-drift/untested/unknown` | `runtime/eda-adaptation.mjs:76` |
| 有界 prompt 投影 | `summarizePinEvidenceForPrompt` | `runtime/chat.mjs:247` |
| 前端调用 + 显式超时 | `request(path, init, retry, timeoutMs)` | `src/services/runtimeClient.ts:39` |
| 新路由写法（会被 CI 扫描） | `method === 'GET' && url.pathname === '/api/…'` | `runtime/__tests__/route-contract.test.mjs:104-128` |

## 附录 C · 术语

| 术语 | 含义 |
| --- | --- |
| provider | 三数据源（local-fs / market-api / bridge）的统一适配器接口，只读、失败隔离 |
| 能力公告板（capability board） | 归一化后的扩展能力目录 + 打分裁剪结果，给 UI 与 prompt 消费 |
| revision | 公告板内容摘要（16 hex），用于变更检测与"未变则零成本轮询" |
| registrar（只读 layer） | `extension-registry` agent，进 agent-contract，产 `advisory`/`unknown` 证据 |
| manager（写 layer） | `ExtensionMarketService`，不进 agent 体系，写动作必须过一次性审批 |
| fail-closed | 读不到/校验不了就明确失败或标注 unknown，绝不默认"没问题" |
