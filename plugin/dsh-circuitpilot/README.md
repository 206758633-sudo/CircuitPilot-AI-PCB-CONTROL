# dsh-circuitpilot

DSH 原生插件（MVP）：在 DSH 对话里安全驱动本机 **CircuitPilot Runtime** 完成
「读状态 → 出计划 → 用户对话批准 → 执行 → 证据摘要 / 验证」闭环。

- 插件包目录：`plugin/dsh-circuitpilot`
- Runtime：本机 CircuitPilot（默认 `http://127.0.0.1:4178`）
- 工具前缀：`cp_*`（12 个）
- 内置 skill：`circuitpilot`（`skills/circuitpilot/SKILL.md`）
- 单元测试不依赖 DSH 实例、不依赖真实 token、不连真实 EDA。

## 1. 安全边界（先读）

本插件把审批边界写死在代码里，但模型仍必须按 skill 规程使用：

1. **chat 审批模式**（MVP 默认）：`approvalMode=chat` 时，`cp_approve` 只接受
   “本会话刚生成的 planHash + `confirm=true`”，并立刻把 Runtime 返回的
   `approvalToken` 存进**插件进程内存**；该 token **不返回给模型、不写入日志**，
   模型只能拿到 `approvalId`。`cp_execute` 使用内存里的计划和 token，模型不能替换计划。
2. **风险差异**：chat 审批的“人”是对话里的用户；它与 UI 点击审批相比少了页面上的
   二次确认和可视化 diff。因此 skill 要求：计划必须先完整展示（planHash/missing/风险/假设），
   用户明确说“批准”后才允许 `cp_approve`。默认写暂停、DRC 基线、目标指纹漂移仍由
   Runtime 原有机制 fail-closed 拦截。
3. **一次性批准**：Runtime 批准令牌与 planHash + EDA 目标指纹绑定；已用/过期/目标变化
   一律拒绝，需要用户重新确认并重新批准。
4. **批准绑定校验**：Runtime 返回的是 `approvalId + token + bindings{planHash,targetFingerprint,windowId}`；
   插件会重新核对 bindings 与本次 planHash/ETA 目标一致，不一致直接拒绝记录批准。`token` 只留在
   插件内存，返回给模型的只有 `approvalId`。
5. **幂等与重试**：所有写/长任务工具必须带唯一 `requestId`；同 id 返回同一 job，
   不重复执行。超时/取消/结果未知时**禁止自动重试**，先用 `cp_job`/`cp_status`/`cp_evidence` 核对。
6. **agent denylist**：签核、订单确认、最终评审、设置/Provider/研究配置、写暂停恢复等
   仍由 Runtime 拒绝；插件不提供也不尝试绕过这些动作。

## 2. 安装到独立 profile

> 建议先用独立 profile（例如 `cp-test`）验证，不要直接装进日常 `desktop` profile。

### 2.1 用宿主 CLI 以 link 方式安装

从仓库根目录（路径含空格，命令整体加引号）：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile cp-test add "link:/Users/jescochen/Desktop/AI- PCBA/plugin/dsh-circuitpilot"
```

也可以进入插件目录后用相对路径：

```bash
cd "/Users/jescochen/Desktop/AI- PCBA/plugin/dsh-circuitpilot"
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile cp-test add "link:."
```

安装后启动/重载对应 profile 的 DSH（例如用 `dsh web --profile cp-test`，或桌面应用切换 profile），
然后在插件列表确认 **dsh-circuitpilot** 处于运行中，并在 skill catalog 里看到 `circuitpilot`。
DSH 通过包里的 `dsh.bundle.patch`（`cordis.patch.yml`）声明插件条目；若重载后列表里没有它，
检查该 profile 的插件配置是否已引用 `dsh-circuitpilot`（不同 DSH 版本的安装后挂载方式可能不同）。
**安装命令成功 ≠ 插件已运行**；若未自动重载，重启宿主再验证。

- 卸载：`dsh plugin --profile cp-test remove dsh-circuitpilot`
- 依赖：插件 `peerDependencies` 由 DSH 宿主解析（`@deepseek-ai/cordis`、`schemastery`、
  `dsh-skill`、`dsh-mcp-client`），本仓库不需要 `npm install`。
- 本包 `lib/**` 不 import 任何 `@deepseek-ai/*`，可被 `verification/agent/**` 直接 import
  做 fake-runtime 测试；`index.mjs` 的 DSH peer（schemastery / dsh-mcp-client / dsh-skill）
  都用动态 import + 兜底，因此**包根在没有 DSH 的环境中也能 import**（Config 退化为等价默认值
  函数），真实 DSH 宿主里仍使用标准 schemastery Config / createMcpToolDefinition /
  BUNDLED_SKILL_RANK。
- 若宿主按真实路径解析 link 目录导致报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`
  （peer 在 profile 的 `node_modules` 里，不在本仓库），改为把插件目录复制到
  `<profile>/node_modules/dsh-circuitpilot`，并在 profile 的插件配置里用同一 `id`
  指向它；或者把插件目录作为 profile 依赖目录的子目录安装。两种方式都必须保证
  `skills/circuitpilot/SKILL.md` 随包存在。

### 2.2 插件配置

`cordis.patch.yml` 已提供默认配置：

```yaml
- insert:
    - id: dsh-circuitpilot
      name: 'dsh-circuitpilot'
      config:
        runtimeUrl: 'http://127.0.0.1:4178'
        approvalMode: chat
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `runtimeUrl` | `http://127.0.0.1:4178` | CircuitPilot Runtime 地址 |
| `uiUrl` | `http://127.0.0.1:4177` | CircuitPilot UI 地址，仅用于生成审批深链（不参与网络请求）；去尾斜杠、仅 http/https、非法回退默认 |
| `approvalMode` | `chat` | `chat` 允许对话批准+执行；`off` 退化为只读（`cp_approve`/`cp_execute` 直接拒绝） |
| `agentTokenFile` | 空 | 空表示按契约解析（环境变量 > 默认路径） |
| `maxResultBytes` | `16384` | 工具结果上限；超限时压缩并置 `truncated:true` |

## 3. agent token（配对）

- 默认路径：`~/Library/Application Support/CircuitPilot/agent-token.json`
- 覆盖：环境变量 `CIRCUITPILOT_AGENT_TOKEN_FILE`（插件与 Runtime 必须指向同一文件）
- 文件格式（由 Runtime 启动时 `ensureAgentTokenFile` 生成，权限 `0600`）：

```json
{
  "version": 1,
  "name": "dsh-plugin",
  "token": "cpa_<48 hex>",
  "scopes": ["read", "plan", "execute"],
  "createdAt": "2026-10-29T00:00:00.000Z"
}
```

获取方式：启动 CircuitPilot（Runtime 启动时会确保该文件存在）。不要手工编辑、不要在新会话里
粘贴 token 内容；插件只在本机读取并作为 `x-circuitpilot-agent-token` 请求头发送。

常见错误：

| code | 含义 | 下一步 |
|---|---|---|
| `AGENT_TOKEN_MISSING` | token 文件不存在 | 启动 CircuitPilot / 检查 `CIRCUITPILOT_AGENT_TOKEN_FILE` |
| `AGENT_TOKEN_INVALID` | token 文件损坏/格式不合法 | 重启 CircuitPilot 重新签发，勿手工编辑 |
| `RUNTIME_TOKEN_INVALID` | Runtime 认为 token 无效或已轮换（HTTP 401） | 重启 CircuitPilot 重新签发，确认插件与 Runtime 指向同一文件 |
| `AGENT_ROUTE_FORBIDDEN` | Runtime agent denylist 拒绝该路由（HTTP 403） | 该动作必须由用户在 UI 完成，不要绕过 |
| `APPROVAL_REQUIRED` / `APPROVAL_EXPIRED` / `APPROVAL_TARGET_MISMATCH` | 没有批准、批准过期或批准绑定与目标不一致 | 重新展示计划/目标，让用户重新明确批准 |
| `EXPORT_BLOCKED` | 导出放行门禁拒绝（`data.blockers` 列出原因） | 不要绕过门禁；补齐证据/审批后再导出 |
| `RUNTIME_UNREACHABLE` | Runtime 未启动/端口不对 | 启动 CircuitPilot，检查 `runtimeUrl` |
| `RUNTIME_TIMEOUT` | 请求超时 | 先核对在途任务；写操作不要自动重试 |

## 4. 工具面（12 个）

| 工具 | 类型 | Runtime 路由 | 用途 |
|---|---|---|---|
| `cp_status` | read | `GET /api/health`、`/api/project-state`、`/api/write-gate`、`/api/eda/workspaces/current`、`/api/issue-state`、`/api/evidence/index` | 总览：Runtime/项目/EDA/写暂停/问题/证据 |
| `cp_project_context` | read | `GET /api/project-state`、`/api/eda/workspaces/current`、`/api/issue-state`；`includeAllProjects=true` 时另读 `GET /api/projects` + `GET /api/projects/:id/state` | 项目上下文与 EDA 绑定；可选多项目/多板只读总览 |
| `cp_issues` | read | `GET /api/issue-state` | 未收口问题（open/investigating） |
| `cp_evidence` | read | `GET /api/evidence/index`、`/api/evidence/find`、`/api/design/executions/:id/evidence` | 证据索引/文件引用（kind/ref/digest） |
| `cp_knowledge` | read | `GET /api/knowledge/entries`、`POST /api/rag/query` | approved 知识 + citation |
| `cp_design_plan` | plan | `POST /api/design/plan`、`POST /api/design/plan/ai`；`requestApproval=true` 时另调 `POST /api/agent/plan-requests` | 原理图计划（只计划，不批准）；可登记计划级 UI 审批请求 |
| `cp_pcb_plan` | plan | `POST /api/pcb/plan`；`requestApproval=true` 时另调 `POST /api/agent/plan-requests` | PCB 计划（只计划，不批准）；可登记计划级 UI 审批请求 |
| `cp_approve` | approve | `GET /api/design/context` / `GET /api/pcb/context` → `POST /api/design/approve` / `POST /api/pcb/approve` | 对话批准（planHash + confirm=true）；本会话登记过计划请求时自动带 `approvalRequestId` |
| `cp_execute` | execute | `POST /api/design/execute` / `POST /api/pcb/execute` | 执行已批准计划（job） |
| `cp_validation` | execute | `POST /api/eda/schematic/erc/run`、`POST /api/eda/pcb/drc/start` + `/drc/report`、`POST /api/eda/gates/evaluate` | ERC/DRC/门禁（job）；`boards` 可对最多 3 块板顺序批量校验 |
| `cp_export` | execute | `POST /api/production/export` | 导出/归档（confirm + requestId，job） |
| `cp_job` | read | 插件本地 JobManager | 长任务 status/wait/cancel |

### 4.1 多项目/多板只读总览（`cp_project_context` 可选参数）

批量/多板任务前需要先建立全局视图，又不想额外增加第 13 个工具，因此扩展 `cp_project_context`：

- `includeAllProjects`（boolean，默认 `false`）：为 `true` 时先 `GET /api/projects`，再对每个项目
  `GET /api/projects/:id/state`（id 经 `encodeURIComponent`）。默认关闭时不会多发任何请求。
- `projectLimit`（integer，1–20，默认 10）：最多读取多少个项目；16KB 结果上限仍然生效。
- 输出只读字段：`data.projects[] = {id,name,stage,archived,edaBound,savedAt,counts:{requirements,components,assets},boards:[{name,pcbUuid,schematicUuid?}]}`，
  以及 `data.projectOverview = {total,returned,partial,errors:[{projectId,code,message}]}`。
- 每个项目最多列出 20 个 board（board 取自项目状态 `state.data` 中 `itemType==='Board'` 的项，
  兼容 `Project.data` 包裹形态）。
- 单个项目读取失败：该项目标 `error` 且 `partial:true`，其它项目与当前项目上下文照常返回；
  `GET /api/projects` 本身失败时也保留当前项目上下文，`projectOverview.partial:true`。
- `returned < total` 只表示被 `projectLimit` 截断（不算 partial）；写操作前仍需切到目标项目并重新出计划。
- 全程只读：不切换 EDA、不调用写路由、不输出 agent token。

### 4.2 多板批量只读校验（`cp_validation` 批量模式）

`cp_validation` 支持一次对最多 3 块板顺序执行同样的 targets，不新增工具：

- `boards: [{pcbUuid, schematicUuid?}]`，最多 3 块；与单板 `pcbUuid`/`schematicUuid` 互斥，同时给 → `INVALID_ARGUMENTS`；重复 `pcbUuid` 按首次出现去重。
- 默认 targets 仍为 `['erc','drc','gates']`；按 boards 顺序**逐板**执行，单板失败只记录到该板 `error` 并继续，不拖垮整批。
- 安全硬规则：targets 含 `erc` 但该板没有 `schematicUuid` → 该板直接失败 `SCHEMATIC_UUID_REQUIRED`，不会回退到“当前原理图”（防止把 A 板 ERC 结果记到 B 板）；DRC/gates 始终使用该板 `pcbUuid`。
- 完成后 `data.batch = {total,succeeded,failed,boards:[{pcbUuid,schematicUuid?,ok,results,error?}]}`；`summary` 为“批量校验：N 板，X 通过，Y 失败”；有失败板时 `ok:false`（`VALIDATION_PARTIAL_FAILED`，全失败为 `VALIDATION_ALL_FAILED`），失败板不能当作通过。
- 证据按板汇总（每条带 `boardPcbUuid`），仍受 16KB cap 裁剪；job label 为 `batch validation`。
- 提交后用 `cp_job({action:"wait",jobId})` 等待；同 requestId 返回同一 job，**不要重复提交**；失败后换新 requestId 整批重跑。
- 只读：仍只调用现有 ERC/DRC/gates 路由，不新增写路由、不切换 EDA。

### 4.3 审批 deep link（`uiUrl`）

- `cp_design_plan` / `cp_pcb_plan` 在 `ready:true` 时、`cp_approve` 成功时，`data.approvalUrl` 给出 CircuitPilot UI 的待执行批准区深链：
  `${uiUrl}/?agent=approvals#settings`，默认 `http://127.0.0.1:4177/?agent=approvals#settings`。
- `nextActions` 同时给一条“在 UI 查看/撤销待执行批准：<url>”，方便用户点击或复制；插件不会因该链接发起任何网络请求。
- 深链只由 UI 地址拼出，**不含 agent token、approvalToken、planHash 或任何密钥**。
- `uiUrl` 经 `normalizeToolConfig` 规范化：去掉末尾 `/`，仅接受 http/https，非法值回退默认；带 path 的部署（如 `https://host/ui`）会生成 `https://host/ui/?agent=approvals#settings`。
- `ready:false` 的计划不输出 `approvalUrl`，避免把不完整计划引导到批准区。

### 4.4 计划级 UI 审批（`requestApproval`）

`cp_design_plan` / `cp_pcb_plan` 可传 `requestApproval:true`（默认 false），把“已生成、尚未执行”的计划登记到 CircuitPilot UI 的待审批队列；**不新增工具、不改审批语义**。

- 仅在 `ready:true` 且 `requestApproval:true` 时生效：
  1. 读 `GET /api/design/context` / `GET /api/pcb/context` 取 `windowId`/`targetFingerprint`（及 `projectId`/`documentUuid`）；
  2. `POST /api/agent/plan-requests` 登记 pending 请求（body 只含 `kind/planHash`、绑定、title/summary/risks/missing，**不签发、不返回任何 token**）；
  3. 成功：`data.approvalRequestId`、`data.planApprovalUrl = ${uiUrl}/?agent=plans#settings`，nextActions 提示“等待用户在 UI 批准/拒绝；批准后再 cp_approve；UI 批准不签发 token”。
- 上下文缺少 `windowId`/`targetFingerprint`：整工具失败 `APPROVAL_CONTEXT_INCOMPLETE`，绝不发送空绑定；
  登记请求失败（409/503 等）：计划仍返回 `ok:true`，但带 `data.approvalRequestError={code,message}`（可重试 `requestApproval` 或改用对话审批），不伪造 requestId。
- UI 的 approve/reject 只改队列记录，**不签发 token、不执行写操作**；UI 批准后 Agent 仍必须调用 `cp_approve({planHash, confirm:true})`（本会话登记过请求时会自动带 `approvalRequestId`）。Runtime 仅在“UI 已批准且 kind/planHash/targetFingerprint/windowId 完全一致”时签发 token；否则返回 409（`PLAN_REQUEST_NOT_APPROVED`/`PLAN_REQUEST_BINDING_MISMATCH`/`PLAN_REQUEST_EXPIRED` 等），插件透传 code 并在 nextActions 给 UI 深链。
- 无 `requestApproval` 的旧对话审批路径完全不变；深链/请求体均不含 token/`cpa_`。

结果统一为契约格式：

```json
{ "ok": true, "summary": "一句话", "data": {}, "evidence": [{"kind":"...","ref":"...","digest":"..."}], "nextActions": ["..."], "truncated": false }
```

错误统一为 `{ "ok": false, "code": "...", "message": "...", "nextActions": [...] }`。

## 5. 典型对话流程

1. 用户：“现在这块板什么状态？” → `cp_status`（+ `cp_issues`）。
2. 用户：“出 4 层 0.2mm 间距重排计划，不要执行。” → `cp_pcb_plan`，把 planHash/missing/风险给用户看。
3. 用户明确说“批准这个计划” → `cp_approve({planHash, confirm:true})`。
4. 用户说“执行” → `cp_execute({planHash, requestId:"req-..."})` → `cp_job({action:"wait"})`。
5. 完成后 → `cp_validation({requestId:"req-..."})` → 报告计数 + `evidence` 引用。

## 6. 测试

```bash
cd "/Users/jescochen/Desktop/AI- PCBA"
node --test "plugin/dsh-circuitpilot/test/*.test.mjs"
```

测试使用本地 `node:http` 起 **fake Runtime**（随机端口）与 **临时 token 文件**
（`mkdtemp`），不依赖 DSH 实例、不碰真实 `~/Library/...` token、不连真实 EDA。
覆盖：token 读取/缺失/损坏/不泄露、HTTP 401/403/404/409/超时/不可达映射、
结果裁剪、approvalMode、confirm、planHash/目标绑定、approvalToken 不暴露、requestId 幂等、
job 超时/取消、DRC 轮询、导出确认，以及包元数据/skill frontmatter 校验；
并用 fake DSH ctx 跑 `index.mjs` 的 apply（12 工具 + skill provider + systemPrompt + effect）。

## 7. 已知限制与待接入点

- Runtime 侧需要完成 agent 鉴权接入（`runtime/agent-token.mjs` + `runtime/server.mjs`）：
  agent token 必须能读 `/api/design/context`、`/api/pcb/context`，并对
  `POST /api/design/approve`、`POST /api/pcb/approve` 的 chat 审批放行；其余 denylist 保持。
  未接入时 `cp_approve` 会返回可执行的 `AGENT_ROUTE_FORBIDDEN` 提示。
- JobManager 是插件进程内存实现：DSH 重启后 job 列表丢失，真实执行记录以 Runtime 的
  execution/evidence 为准；插件不会假装可恢复。
- 插件包本身不含 MCP server；MCP 入口在 `agent/mcp-server.mjs`（源码 `main`，实验性，旧 release 可能没有），需单独配置。截图附件 / approval deep link 仍未完成。
- PCB 写能力受嘉立创EDA公开 API 限制，Runtime 侧 fail-closed；工具不会承诺一定写成功。

## 8. 目录结构

```text
plugin/dsh-circuitpilot/
├── package.json          # type=module、dsh.bundle.patch、peerDependencies
├── cordis.patch.yml      # profile 插件条目（runtimeUrl / approvalMode）
├── index.mjs             # DSH 入口：工具注册 + bundled skill + systemPrompt
├── lib/
│   ├── runtime.mjs       # Runtime HTTP 客户端（token/超时/错误映射，永不泄露 token）
│   ├── jobs.mjs          # 内存 JobManager（requestId 幂等、超时 mayHaveTakenEffect、cancel）
│   ├── projection.mjs    # 结果 envelope + 16KB 裁剪（truncated 标记）
│   └── tools.mjs         # 12 个 cp_* 工具（路由映射/审批/结果摘要）
├── skills/circuitpilot/SKILL.md
├── test/                 # node:test + fake Runtime，无 DSH/EDA 依赖
└── README.md
```
