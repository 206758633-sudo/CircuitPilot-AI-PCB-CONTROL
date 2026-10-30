# CircuitPilot Agent 控制面 MVP 实施状态（2026-10-29）

> 结论：Agent 控制面 MVP 的 **Runtime 鉴权 + DSH 原生插件 + 内置 Skill + MCP Server + 独立验证** 已由 AI 团队交付。
> 2026-10-29 已构建并**重启加载** CircuitPilot 0.2.0（4178，19:05 新 bundle），token 已生成，Runtime 9/9、真实 UI e2e 1/1、真实 MCP 12 工具已实测；**计划级待审批队列 + UI 逐条批准/拒绝 + 真实 UI 验收已落地**；**真实 DSH 对话已由 `tokenfens/deepseek-flash` 模型自动调用 `cp_status` 并拿到真实 Runtime 结果**（证据 `artifacts/agent-dsh-live-toolcall.json`）；**真实 EDA 已通过实验适配器只读打通（验证后已停止适配器；当前恢复离线）**：`cp_status` 曾显示 EDA 在线，真实 PCB DRC 0 违规、ERC 1 warning（仅聚合）；真实批量 2 板结果为 1 通过/1 失败（第二块 1 条 DRC 未解释违规，已修正批量摘要语义）；**真实写链路已执行（pcb.save + pcb.drc，用户批准）：execution `b0b8eac8-c786-434f-8098-5ed95ebc2dae`，DRC 0 违规，几何 delta=0**；**真实回滚演练已尝试但自动回滚失败**：用户批准 planHash `03f6ae40…`，临时线段创建成功后故意参数失败，Runtime 报 `PCB_ROLLBACK_VERIFY_FAILED`（源码摘要不匹配）并触发安全写锁；已用 EasyEDA 撤销历史恢复为 1152 线并保存，DRC 0，安全锁已释放，但**源码与执行前快照不是逐字节一致**（`ca9c…` vs `b33…`）。**这不是回滚成功，是回滚失败 + 人工语义恢复；修复前禁止再次自动回滚演练**；证据 `artifacts/agent-rollback-drill-failed-20261029.json`。正式签核、导出仍未执行。详见 `agent-live-acceptance-2026-10-29.md` 与 `.auto-coding/testing/reports/20261029_eda-agent-adapter.md`。

## 1. 已交付

### 1.1 Runtime 第二认证通道

| 文件 | 内容 |
|---|---|
| `runtime/agent-token.mjs` | 签发/读取/校验 `cpa_` token；文件 0600、目录 0700、原子写；常量时间比较；损坏/权限过宽 fail-closed |
| `runtime/agent-auth.mjs` | 纯函数路由边界：denylist + 对话审批豁免（仅 POST `/api/design/approve`、`/api/pcb/approve` 精确路径） |
| `runtime/server.mjs`（Lead 接入） | `x-circuitpilot-agent-token` 与 UI token 双通道；agent 越权 403 `AGENT_ROUTE_FORBIDDEN`；CORS 补头；启动时 `ensureAgentTokenFile`；agent approve 强制 `confirm=true` + `approvalMode=chat` |
| `runtime/__tests__/agent-token.test.mjs` | 8 用例 |
| `runtime/__tests__/agent-auth.test.mjs` | 14 用例（含计划级请求精确放行） |
| `runtime/__tests__/agent-auth-http.test.mjs` | 5 用例（真实 `createRuntimeServer` + 临时 token 文件） |
| `runtime/agent-console.mjs` | 令牌状态/原子轮换/JSONL 审计；审计带 `seq/prevHash/hash` 的 HMAC-SHA256 哈希链 + `agent-audit.head.json` 链头锚点（尾部删除可检测），密钥 0600；失败不拖垮业务 |
| `runtime/__tests__/agent-console.test.mjs` | 52 用例（含篡改/删任意行/换序/尾部删除/锚点落后/密钥缺失/并发续链） |
| `runtime/__tests__/agent-console-http.test.mjs` | 9 用例（status/audit/rotate、旧 token 立即失效、Agent 越权 403、approve 审计、锚点后尾部删除仍 broken） |
| `runtime/__tests__/agent-approvals-http.test.mjs` | 6 用例（待执行批准 UI 列表/撤销、Agent 403、404/409/400 边界、used/expired 过滤、降级空列表、无 token 泄漏） |
| `runtime/plan-requests.mjs` + `runtime/__tests__/agent-plan-requests.test.mjs` | 计划级请求 Store：`apr_` ID、pending/approved/rejected/consumed、24h TTL、100 容量、原子 0600、绑定校验、fail-closed；单元 + HTTP 共 12 用例 |

默认 token 文件：`~/Library/Application Support/CircuitPilot/agent-token.json`（`CIRCUITPILOT_AGENT_TOKEN_FILE` 可覆盖）。

### 1.2 DSH 原生插件

`plugin/dsh-circuitpilot/`：

- `package.json` / `cordis.patch.yml`：DSH bundle patch，`insert` 插件条目
- `index.mjs`：`inject=['tools','skills','systemPrompt']`；12 工具；bundled skill；systemPrompt 安全规程；动态 import + 兜底
- `lib/runtime.mjs`：agent token 文件、HTTP client、超时、错误映射、token 脱敏
- `lib/jobs.mjs`：长任务 JobManager，requestId 幂等、status/wait/cancel、超时 `mayHaveTakenEffect`
- `lib/projection.mjs`：统一 envelope + 16KB 渐进裁剪
- `lib/tools.mjs`：`cp_status` / `cp_project_context` / `cp_issues` / `cp_evidence` / `cp_knowledge` / `cp_design_plan` / `cp_pcb_plan` / `cp_approve` / `cp_execute` / `cp_validation` / `cp_export` / `cp_job`
- `cp_project_context{includeAllProjects}`：多项目/多板只读总览（项目/板/计数，单项目失败 partial）
- `cp_validation{boards}`：最多 3 块板顺序批量只读校验（ERC/DRC/门禁）；`boards` 与单板 `pcbUuid/schematicUuid` 互斥；ERC 缺该板 `schematicUuid` 直接失败，绝不回退当前原理图；有失败板时 fail-closed 返回 `ok:false` + 每板 `results/error`
- `skills/circuitpilot/SKILL.md`：先读后写、计划→用户确认→执行→证据、禁止签核/订单/自动重试
- `test/*.test.mjs`：85 用例（fake Runtime、fake DSH ctx；含多项目/多板只读总览、多板批量只读校验、计划级 UI 审批、审批 deep link）

### 1.3 MCP Server（stdio）

`agent/mcp-server.mjs`：

- 零第三方依赖、手写 legacy MCP JSON-RPC（2025-era）
- `initialize` / `ping` / `tools/list` / `tools/call` / `notifications/cancelled`
- 对 `server/discover` 返回 `-32601`，触发 DSH SDK 回退 `initialize`
- 复用 plugin 的 12 工具、审批、JobManager、投影
- `agent/__tests__/*.test.mjs`：49 用例（25 单测 + 12 stdio + 9 HTTP + 3 HTTP 认证）
- 传输：默认 stdio；`--http --http-port 4180` 可选 Streamable HTTP（POST /mcp、Mcp-Session-Id、GET /health、8MB 上限、通知 202、畸形 JSON -32700；协议仍 legacy 2025-era）
- HTTP 认证：可选 `--http-token-file`（0600、非空、权限严格）/ env；对 `/mcp` 校验 Bearer 或 `x-circuitpilot-mcp-token`（常量时间），失败 401 固定 JSON；`/health` 公开；不配置时仅 loopback 并告警
- `agent/dsh-profile.example.yml`：DSH `dsh-mcp-client` stdio 接入片段

### 1.4 设置页 Agent 接入面板（UI 控制台 MVP）

`src/components/AgentAccessPanel.tsx` + `SettingsPage` 挂载：

- 令牌状态：可用/缺失/损坏、文件路径、scopes、创建时间；不可用时提示重启 CircuitPilot 生成令牌
- 轮换：二次确认 → `POST /api/agent/token/rotate`；成功明确“旧令牌立即失效、插件下次自动读取”，失败展示 `[code] message`
- 审计：最近 8 条 Agent 调用（时间/kind/actor/method·path/outcome），denied 红色、failed 黄色；空态
- 审计完整性徽标：ok/empty「审计链完整」、legacy「含旧格式」、broken「审计链异常」；broken 时提示保留现场，不提供修复/清空按钮；额外显示锚点状态【已锚定】/【未锚定（旧审计）】
- 计划级审查请求：Agent 通过 `requestApproval:true` 登记 pending 计划（类型/标题/摘要/planHash/window/风险/缺失/过期），UI 逐条批准或拒绝；UI 决策只改队列状态，不签发 token；批准后 Agent 仍需 `cp_approve`，执行仍走一次性 token
- 待执行批准：已签发未使用/撤销/过期的 design+pcb 批准队列（planHash/windowId 前缀、过期时间），可二次确认后按 approvalId 撤销（只让令牌失效，不执行写操作）；不含 token
- 审批 deep link：`?agent=plans` / `?agent=approvals` / `?agent=ledger` / `?agent=access` 自动滚动到对应区块（插件 plan/approve 结果输出链接；`uiUrl` 已进入 DSH Config/cordis.patch.yml，默认 4177）
- 批准账本：最近 8 条计划/写板批准生命周期（scope/action、approvalId 前缀、planHash/windowId 前缀）+ 账本哈希链完整性；损坏时保留现场；旧 Runtime 404 只隐藏该区块
- 永远不渲染/复制 token 原文；不提供签核/订单；Runtime 不可达或旧版本 404 时降级说明，不白屏
- 测试：`src/components/__tests__/AgentAccessPanel.test.tsx` 20 用例（含计划级请求展示/二次确认批准/已批准等待、待执行批准展示/空态/二次确认撤销/404 降级、账本正常/空/链异常/旧 Runtime 降级/anchored、审批 deep link 滚动）

### 1.5 计划级待审批队列（task-40 / task-41）

- 后端 `runtime/plan-requests.mjs` + `server.mjs`：`POST /api/agent/plan-requests`（Agent 仅可创建）、`GET /api/agent/plan-requests`（仅 UI）、`POST /api/agent/plan-requests/:id/decision`（仅 UI，强制 `confirm:true`）。
- 请求状态 `pending|approved|rejected|consumed`；`apr_` ID；绑定 `kind/planHash/targetFingerprint/windowId`；24h TTL、100 容量、原子 JSON 0600、损坏 fail-closed。
- `POST /api/design/approve` / `/api/pcb/approve` 带 `approvalRequestId` 时：用 manager 权威 planHash 校验绑定并消费已批准请求，再签发 token；manager 失败回滚，签发后消费失败撤销 token；无 `approvalRequestId` 的旧对话路径不变。
- 插件：`cp_design_plan` / `cp_pcb_plan` 新增 `requestApproval`，读取 EDA context 后登记请求；成功返回 `approvalRequestId` + `?agent=plans` 深链；`cp_approve` 自动带 requestId；创建失败计划仍可用并暴露 `approvalRequestError`。
- UI：`AgentAccessPanel` 新增 `#agent-plan-requests`，逐条展示 pending/approved，二次确认批准/拒绝；明确“UI 只记录决定，不签发 token，Agent 仍需 cp_approve”。
- 证据：真实 Runtime + 真实 UI（隔离 4186 + Vite 4177）批准/拒绝各 1 条，`artifacts/agent-plan-queue-real.png`；真实 HTTP 矩阵 **14/14 PASS**（创建、Agent 403、UI 决策、confirm、二次决策 409、失败回滚、0600、无 token、旧路径不受影响）。详见 `.auto-coding/testing/reports/20261029_plan-queue.md`。

### 1.6 独立验证

`verification/agent/`：

- `fake-runtime.mjs`：真实 auth 纯函数 + 关键路由 + 失败注入
- `contract.test.mjs`（10）+ `security.test.mjs`（8）：18/18 pass
- `acceptance.mjs`：10/10 PASS
- `verification/agent/console/**`：独立复验控制台/审计链 **35/35 PASS**（head 锚点/尾部删除/整文件删除/head 落后/head 损坏/密钥/泄漏/轮换/路由边界/下载/P3 多根复验）；P2 已修复复验
- 覆盖：12 工具、approval bindings、一次性 token、16KB 裁剪、requestId 幂等、超时不重试、denylist、token 不泄漏

### 1.7 Live Runtime 端到端验收脚本

`scripts/agent-live-acceptance.mjs`（npm script：`verify:agent-live`）：

- 默认在随机空闲回环端口 **spawn 真实子进程** `node runtime/server.mjs`；state/token/audit/key/head/evidence/job-journal 全部指向 mkdtemp 临时目录，不连 4178/EDA、不写用户状态；`/api/health` 就绪（≤10s）后从 `sessionProof` 取 UI token、从 token 文件读 agent token；结束 kill 子进程并删除临时目录。
- 验收矩阵 9 项：health/sessionProof、UI status 200 + `agent.available`、UI status 无 token/key 泄漏、Agent status 200、Agent `GET /api/agent/audit`/`POST /api/agent/token/rotate` 均 403、Agent approve 缺 `confirm`/`approvalMode` → 403、越权/审批尝试产生审计、UI audit `integrity.ok=true` + `anchored=true` 且无 token/key、UI rotate 后旧 agent token 立即 401 / 新 token 200。
- `--base-url http://127.0.0.1:4178`：不 spawn，直接对现有 Runtime 跑同一矩阵；若目标是旧 Runtime（`/api/agent/status` 返回 404），打印“旧 Runtime，需重启/重建”+ 重启步骤并 **exit 2**（版本问题，不算新代码失败）。

最近结果（2026-10-29）：`npm run verify:agent-live` → **PASS 9/9，exit 0**；临时目录与子进程均清理；`node --check` 通过。

### 1.8 MCP HTTP + Live Runtime 端到端验收脚本

`scripts/agent-mcp-live-acceptance.mjs`（npm script：`verify:agent-mcp-live`）：

- 自包含：先在随机空闲回环端口 spawn 真实 `node runtime/server.mjs`（临时 state/token/audit/key/head/evidence/job-journal；不连 4178/EDA），再 spawn 真实 `node agent/mcp-server.mjs --http --http-port <free> --runtime-url <base> --token-file <temp token>`，等 `GET /health` 返回 `transport=streamable-http`。
- 验收矩阵 9 项：Runtime `/api/health` 200、MCP `/health` 200 + `transport=streamable-http`、`POST /mcp initialize` 200 + `application/json` + `Mcp-Session-Id` UUID + `2025-11-25`、通知 202 空 body、`tools/list` 12 工具名集合与 `TOOL_NAMES` 一致、`tools/call cp_status` 200 CallToolResult（`content`/`structuredContent`、`data.runtime.reachable`、`data.eda.online`）、响应无 agent token/`cpa_`/审计密钥、MCP 子进程 stdout 0 字节且 stderr 仅日志无 token、`GET /mcp` 405 / 未知路径 404。
- 收尾 SIGTERM 两个子进程、删除临时目录并校验端口已释放；`PASS x/y`，exit 0/1。

最近结果（2026-10-29）：

- `npm run verify:agent-mcp-live` → **PASS 9/9，exit 0**；真实 Runtime + 真实 MCP HTTP 子进程、stdout 0 字节、无临时/端口残留。
- 真机 4178（0.2.0）`verify:agent-live --base-url` → **PASS 9/9**（工作区 state 手动 Runtime；桌面壳 stdin 注入令牌需另取）。
- 真实 UI（Vite 4177 + 真 Runtime）Playwright → **1/1 PASS**，截图 `artifacts/agent-console-real.png`。
- 桌面 app Runtime + 真实 MCP：12 工具，`cp_status`/`cp_issues` `ok:true`；早期为 EDA 离线，后续实验适配器已做真实 DRC/ERC 只读验证；token/审计密钥未泄漏。


### 1.9 审计归档/回放（安全加固）

`runtime/agent-audit-archive.mjs` + `scripts/agent-audit-archive.mjs`（npm script：`audit:archive`）：

- `create`：先完整校验当前 HMAC 链（含 head 锚点），拒绝断链/缺 head/密钥不可用；把 `agent-audit.jsonl` + `agent-audit.head.json` 冻结到新目录（0700/0600），manifest 记录 SHA-256、链计数/lastSeq/lastHash、创建时间，并用审计 key 对 manifest 做 HMAC 签名；**不复制审计密钥**，也不复制 token。
- `verify`：先验 manifest HMAC 签名与 audit/head 的 SHA-256，再用外部 key 从头重算整条链，校验 seq/prevHash/HMAC/head；manifest 路径只允许 basename（拒绝 `../` 穿越）；篡改审计行、改 head、密钥错误/缺失均 fail-closed。
- 边界：这是**时点快照 + 篡改检测**，不是远端 WORM；同用户仍可同时重写快照和 manifest。
- **外部锚点（新增）**：`createExternalAuditAnchor`/`verifyExternalAuditAnchor` + CLI `anchor`/`verify-anchor`。把当前链头 `seq/lastHash/auditSha256` 冻结为**独立目录**里的 HMAC 签名收据（`anchor-<seq>-<hash>.json`，0600）；验证时用外部 key 先验收据签名，再重算当前链，如实报告 `currentMatches=false`（链已推进不等于锚点失效）。它解决“审计目录和 head 一起被改”的外部副本交叉核对，但**仍是本地独立目录，不是远端 WORM**；真正抗同用户篡改需对象存储 WORM/时间戳服务/独立主机。最大 64MB，超限拒绝。
- 测试：`runtime/__tests__/agent-audit-archive.test.mjs` 9/9（成功归档、改审计行、改 head、manifest 未重签、源链断/重复 outDir、路径穿越、密钥错误/缺失、外部锚点成功/推进、外部锚点收据被改写）。
- 本机 CLI 冒烟：create/verify/anchor/verify-anchor 均 exit 0；真实 Runtime state 的审计链 seq=44 生成外部锚点 `anchor-44-b6db6969…`，verify `currentMatches=true`；证据 `artifacts/audit-external-anchor-20261029/`；归档目录仅 3 个文件，无 key/token 字符串。

### 1.10 外部审计锚点 + 实验适配器加固（2026-10-29）

- **外部审计锚点**：`runtime/agent-audit-archive.mjs` 新增 `createExternalAuditAnchor` / `verifyExternalAuditAnchor`；CLI `anchor` / `verify-anchor`（npm `audit:anchor` / `audit:verify-anchor`）。将链头 seq/lastHash/auditSha256 写成独立目录的 HMAC 签名收据（0600），verify 同时验签名并重算当前链，`currentMatches=false` 如实报告“锚点有效但链已推进”。真实 state 审计链 **seq=44** 冒烟通过，证据 `artifacts/audit-external-anchor-20261029/`；边界仍是**本地独立目录，不是远端 WORM**。
- **适配器加固**：`scripts/easyeda-agent-bridge.mjs` 的 body/code 上限从 1MB 提升到可配置 8MB（`CIRCUITPILOT_BRIDGE_BODY_LIMIT`，硬上限 8MB），为整档源码恢复留余量；Bridge token 改为 `timingSafeEqual` 常量时间比较；`/health` 暴露 limits 但绝不暴露 code/token。冒烟：无 token/错 token 均 401，正确 token 空 code 400，health 返回 limits；未执行 EDA 写。
- **评估文档**：`docs/agent/ui-approval-execute-evaluation.md`（UI 批准直接执行：当前保持两步链，列出方案 A/B/C 风险与验收）、`docs/agent/batch-write-export-evaluation.md`（批量写/导出：只读批量可做，写/导出必须逐板计划与人工确认）、`docs/agent/export-signoff-boundary.md`（正式导出/签核仍被人工门禁阻断，AI 不签核/不下单）。
- 测试：runtime **1433/1433 PASS**；审计归档/外部锚点测试 **9/9 PASS**。

### 1.11 2026-10-30 运行环境修复

- **桌面 Runtime 更新**：重新执行 `npm run desktop:app`，bundle 内 `runtime/pcb.mjs` 与仓库 SHA-256 均为 `3236fef6…`（旧 bundle 为 `2eaf86ec…`，不含定向回滚代码）；已重启 CircuitPilot.app，4178 健康检查通过。
- **Vite 4177 / E2E Runtime**：桌面 Runtime 4178 保留给 DSH 插件；另起开发 Runtime 4179（状态为桌面 state 的副本，含审计锚点）供真实 UI/E2E 使用，Vite 4177 指向 4179。`e2e/app.spec.ts` **31/31 PASS**；完整 Playwright **38 passed / 6 skipped**（4 个需 `CP_LIVE_EDA_E2E=1` 的真机用例 + 2 个需要独占 4178 的 C6/F7 用例；无失败）。
- **E2E 测试环境修正**：`app.spec.ts` 的 API mock 改为 host-agnostic `**/api/**`（不再硬编码 :4178）；`layout-rules` 规则数按当前规则包改为 151/硬门禁 126，并修复 strict-mode 多按钮；`voice-requirement-input` 的 API 拦截改为 host-agnostic。
- **EDA 恢复在线**：启动实验适配器（49620），`cp_status` 的 EDA 从 offline 变为 online；仍是实验适配器，不是生产桥。
- **`cp_issues` 投影修复**：`summarizeIssues` 对旧 issue-state 的 `title`/id 内 code 做回退；插件测试 85/85。当前 DSH 会话仍加载旧插件模块；已对 3 条旧 issue-state 做一次向后兼容数据迁移（备份 `issue-state.json.backup-20261030-issue-projection`），`cp_issues` 已能显示 code/summary。
- **证据**：`artifacts/agent-environment-recovery-20261030.json`。
- **目标板已按用户选择对齐**：2026-10-30 通过只读切换打开项目保存工程 `ba4924…/Board1_1`，活动 EDA PCB 已从 `0847…` 切到项目保存的 `5595e77cead09682`；`cp_status` 的 project.edaWorkspace.pcbUuid 与 eda.workspace.pcbUuid 现已一致。只切换活动文档，未改工程数据。
- **回滚演练已执行但失败（2026-10-30）**：用户确认 planHash `c0b54846…` 后执行：C1 真实移动 0.01mm，第二操作（故意无效目标）触发 `EDA_REQUEST_ABANDONED`（派发后 15s 未返回）；回滚 `PCB_ROLLBACK_VERIFY_FAILED`（`PCB恢复后的源码摘要不匹配`），execution `84c220b7…` state=`rollback_failed`，安全写锁已触发且未释放。表面回读仍与演练前一致（53 器件 / 773 线 / 117 过孔 / 4 铺铜 / 1 板框，C1 位置未变），post-drill DRC 仍只有 1 条已知 Netlist Error；但 sourceDigest `ec2ba51e…` → `6664e203…` 不一致，因此**不能宣称整档回滚成功**。失败后没有自动重试。证据：`artifacts/agent-rollback-drill-noncreate-failure-20261030.json`。人工两次 Cmd+Z 后：C1 回到 46.000mm、53/773/117/4/1 计数与逐器件位置均回到演练前、post-undo DRC 仍仅 1 条已知 Netlist Error；但保存后 sourceDigest 仍为 `ade564e0…` 而非 `ec2ba51e…`；用户明确批准接受语义恢复后，安全锁已释放；但 sourceDigest 仍为 `ade564e0…`，摘要差异保留为未解释缺口，不能宣称摘要级回滚成功。
- **仍存在**：整档 `document.source.restore` 已被真机再次证明不可靠；安全写锁需人工恢复/核对 sourceDigest 后才能释放；正式导出仍被人工门禁 block。

## 2. 验证记录

Agent 范围独立测试合计：106（Runtime：token/auth/auth-http/console/console-http/approvals-http/plan-requests）+ 85（插件）+ 49（MCP：stdio+HTTP+认证）+ 18（独立验证）+ 22（MCP 独立复验）+ 35（控制台/审计独立复验）= **315 个用例，全部通过**；另有 Live Runtime 端到端 **9/9 PASS**、MCP HTTP + Live Runtime 端到端 **9/9 PASS**、真实 UI 深链 e2e **1/1 PASS**、计划级 UI 真实验收 **2/2 PASS**、真实 DSH 对话工具调用 **1/1 PASS**（`cp_status`）；UI 控制台另有 **21** 个 vitest 用例（整套 **218**）。

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npx vitest run` | 28 files / **218** tests pass（含 Agent 面板 21 个） |
| `npm run build` | exit 0（820KB bundle，已有 chunk 警告） |
| `npm run desktop:app` | exit 0；2026-10-30 重新构建，bundle `runtime/pcb.mjs` 与仓库 SHA-256 一致（`3236fef6…`），已重启 4178 新进程 |
| `node --test runtime/__tests__/agent-{token,auth,auth-http,console,console-http,approvals-http,plan-requests}.test.mjs` | **106/106 pass** |
| `node --test "plugin/dsh-circuitpilot/test/*.test.mjs"` | **85/85 pass** |
| `node --test "agent/__tests__/*.test.mjs"` | 49/49 pass（25 单测 + 12 stdio + 9 HTTP + 3 HTTP 认证） |
| `node --test "verification/agent/*.test.mjs"` | 18/18 pass |
| `node --test "verification/agent/mcp/*.test.mjs"` | 22/22 pass（DSH 官方 SDK + wire 复验） |
| `node --test "verification/agent/console/*.test.mjs"` | 35/35 pass（独立控制台/审计链 + head 锚点复验） |
| `node verification/agent/acceptance.mjs` | 10/10 PASS |
| `npm run verify:agent-live` | PASS 9/9（临时端口真实 Runtime 子进程，exit 0；`--base-url` 模式旧 Runtime exit 2） |
| `npm run verify:agent-mcp-live` | PASS 9/9（真实 Runtime + 真实 MCP `--http` 子进程；stdout 0B、无 token/key 泄漏、无残留，exit 0） |
| `npm run audit:archive` | 本机临时链 create/verify 均 exit 0；真实 state 审计链 anchor/verify-anchor 均 exit 0（seq=44，currentMatches=true）；归档 0700/0600、无 key/token |
| 完整 runtime 套件 | **1433/1433 pass**（新增回滚定向回滚 + 审计外部锚点用例） |
| 真 runtime + plugin `cp_status` smoke | 12 tools；`ok:true`；EDA offline 被如实降级，无假通过 |
| `npx playwright test e2e/agent-console-deeplink.spec.ts` | **1/1 PASS**（真实 Runtime + Vite UI；状态/审计/锚点/账本/待执行批准/深链） |
| 计划级真实 UI（隔离 Runtime 4186 + Vite 4177） | **批准/拒绝 2/2 PASS**；`artifacts/agent-plan-queue-real.png`；无 token 泄漏、无 page error |
| 计划级真实 HTTP 矩阵（隔离 Runtime） | **14/14 PASS**（创建/Agent 403/UI 决策/confirm/409/失败回滚/0600/无 token/旧路径） |
| 真机 Runtime `verify:agent-live --base-url` | **9/9 PASS**（手动 4178 + 工作区 state；详见 `agent-live-acceptance-2026-10-29.md`） |
| 桌面 app 真机 | **已重启为 19:05 新 bundle**；4178 Runtime 0.2.0，新计划级路由探针返回 `400 PLAN_REQUEST_INVALID`（旧进程为 404）；Agent 控制台在桌面窗口内实际驳回 1 条测试计划（队列转「无」、state 0600、无 token/写操作）；token 文件 0600；MCP `cp_status` 成功；**后续已用实验适配器只读打通 EDA（DRC 0、ERC 1 warning），真实写板/签核仍未执行** |
| 真机 DSH 宿主启动 | 隔离 `cp-agent` profile：修复前 `entry did not activate / Invalid effect`；修复后不再出现；已在 `desktop` profile 安装插件（link），当前 DSH 会话的工具可用 |
| 真机 DSH 工具调用 | **PASS**：`cp-live-headless`（headless 模板 + desktop tokenfens provider + 插件）真实模型调用 `cp_status`，返回 Runtime 0.2.0 在线/EDA 离线/9 issues；证据 `artifacts/agent-dsh-live-toolcall.json` |

### DSH 包安装验证（隔离 profile，不影响 desktop）

```bash
DSH_HOME="$PWD/.tmp/dsh-home" \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile cp-test add "link:$PWD/plugin/dsh-circuitpilot"

DSH_HOME="$PWD/.tmp/dsh-home" dsh --profile cp-test --dump-config | grep -A5 dsh-circuitpilot
```

结果：profile 初始化成功、插件条目进入 compose 配置；Node 能从 profile 的 peer 依赖成功 `import('dsh-circuitpilot')`（name/inject 正确）。随后在 `cp-live-headless` 上启动真实 headless 会话，模型自动加载 `circuitpilot` Skill 并调用 `cp_status`；证据 `artifacts/agent-dsh-live-toolcall.json`。

## 3. 未验证 / 已知限制

1. **真实 EDA/Bridge**：已用实验适配器 `scripts/easyeda-agent-bridge.mjs` 把本机 `easyeda-agent` 60832 映射为旧 `easyeda-bridge` 49620；Runtime `cp_status` 验证时显示 **EDA 在线**，真实 PCB DRC **0 违规**、ERC **1 warning（仅聚合）**；验证后已停止适配器，当前恢复离线。**真实回滚已做 create-only 真机复验，正式导出/签核仍未执行**；根因/限制见 `.auto-coding/testing/reports/20261029_eda-agent-adapter.md` 与 `20261029_eda-offline-rootcause.md`。
2. **真实 DSH 宿主加载（已推进）**：修复了 `apply` 返回普通对象导致 cordis `TypeError: Invalid effect` 的真实 bug（现返回 `undefined`，清理走 `ctx.effect`）；已在 desktop profile 安装 `dsh-circuitpilot`（link，Electron 重启后生效）。用 `cp-live-headless`（headless 模板 + desktop tokenfens provider + 插件）+ 真实 `tokenfens/deepseek-flash` 跑通：模型先加载 `circuitpilot` Skill，再调用 `cp_status`，args `{}`、返回 `ok:true`、Runtime 0.2.0、EDA `BRIDGE_NOT_FOUND`、9 issues；证据 `artifacts/agent-dsh-live-toolcall.json`。**2026-10-30 复核**：desktop profile 已重新 `dsh plugin add link:...`，当前 DSH 会话 `cp_status`/`cp_issues` 可用；`cp_issues` 的 title/code 回退修复已进代码（85/85），但当前 DSH 进程仍加载旧模块，需重启 DSH 才生效。仍待验证：DSH 重启后的 peer 解析、DSH 内 token 轮换自动读取、DSH 内计划/审批/写链路。
3. **桌面 app 已重建并重启**：2026-10-30 执行 `npm run desktop:app` 后 bundle 与仓库 `runtime/pcb.mjs` SHA-256 一致（`3236fef6…`），已重启 CircuitPilot.app，4178 健康检查通过；证据 `artifacts/agent-environment-recovery-20261030.json`。外部 `--base-url` 验收仍无法取得 `sessionProof`；新 bundle 尚未覆盖安装到 `/Applications`。
4. **对话审批是 MVP 模式**：`cp_approve` 依赖模型在用户明确确认后调用；Runtime 侧只校验 `confirm=true` + `approvalMode=chat`，不是密码学级人类证明。签核/订单/设置仍由 denylist 硬拒绝。
5. **cp_job 内存态**：DSH/插件重启后 job 表丢失，需用 `cp_status`/`cp_evidence` 核对；写操作超时不自动重试。
6. **DRC 轮询**默认 120s，超时不能断点续轮询。
7. **插件 link 的 peerDependencies**：DSH 提示无法从 link 目标解析 peer；若加载失败，按 README 复制到 `<profile>/node_modules/dsh-circuitpilot` 或用 `file:`。
8. **工作区并发变更**：2026-10-29 15:27–15:37 有另一路 AI/进程修改 `runtime/engineering/layout-rules.mjs`、`rules/board-layout-rules.json`、`docs/pcb-layout/*`（规则 128→144、新增 ZCLR/MOVE 组），并同步更新了测试；完成后完整 runtime 套件 1341/1341 通过。该变更不属于 Agent MVP，未回滚、未改动。
9. **计划级队列已落地，但不等于“UI 批准即执行”**：UI 的批准/拒绝只改变请求状态，不签发 token、不执行写操作；Agent 仍需在用户确认后 `cp_approve`（Runtime 再消费已批准请求并签发一次性 token），随后 `cp_execute`。计划级 UI 目前不直接触发执行；真实 EDA 写板仍受 EDA 在线/绑定限制。
9a. **批量只读校验已真机跑通，并修复“任务成功≠板子通过”**：`cp_validation{boards}` 最多 3 块板、顺序跑 ERC/DRC/门禁；2026-10-29 对两块真实板跑出 1 通过/1 失败，第二块 DRC 有 1 条 unexplained 违规，修复后不再错误显示“2 通过”。批量写/批量导出仍未做，仍需逐板计划+逐板人工批准。证据 `.auto-coding/testing/reports/20261029_batch-validation-fix.md`、`artifacts/agent-eda-batch-20261029.json`。
10. **审计链的边界**：HMAC 链 + head 锚点能检测改写/删任意行/换序/尾部删除/整文件删除；但**无法防“同用户同时拿到密钥并同步改 head”**的攻击者重算整条链。head 领先/落后会 fail-closed（需人工核对后修 head 或归档重建）；密钥丢失时链不可验证（标 broken，不自动重建假链）。已新增 `audit:archive` 时点快照 + 回放校验（篡改/路径穿越/错 key fail-closed）；并新增 `anchor`/`verify-anchor` **独立目录签名收据**（真实链 seq=44 冒烟通过），但它仍是本地独立目录，**不是远端 WORM**；同用户仍可同时重写审计、head 与外部目录。
11. **独立复验发现 P3 已修**：`CIRCUITPILOT_DOWNLOAD_ROOTS` 在 POSIX 曾按 `;` 判断分隔符导致 `:` 多根静默失效；现改用 `node:path.delimiter` 并加测试。
12. **审计 head 的瞬态窗口**：append 先写行、再 rename head，微秒级窗口内读取可能短暂 `head-behind`；UI 轮询如偶现 broken 可 debounce，无需改链。
13a. **桥端口缓存自愈已修**：此前 `BridgeClient.windows()` 在桥进程退出后只抛 `BRIDGE_UNREACHABLE`，不清除旧 `port`，导致后续不再触发 `discover()`，EDA 恢复后 UI 会一直“桥不可达”直到重启 Runtime。现在读窗口遇到 `BRIDGE_UNREACHABLE`/`BRIDGE_TIMEOUT` 会清空 port/selectedWindowId，下一次读取重新发现；新增 `bridge-reconnect` 回归用例，runtime 1418/1418；并在 4178 新 Runtime 上做了真实恢复演练：桥在 → `windows count=0`；杀桥后 `windows #1=BRIDGE_UNREACHABLE`、`#2=BRIDGE_NOT_FOUND`（旧端口已清、重新 discover）。证据 `artifacts/agent-bridge-selfheal-20261029.json`。
13. **审计 head 恢复**：head 领先/落后均拒绝追加；人工确认尾部完整后可把 head 改回最后一条记录，或归档 audit+head（key 可留）让下一请求重建 seq=1。
14. **既有 `e2e/app.spec.ts` 已回到全绿**：2026-10-29 复核为 **31/31 PASS**。原 25/31 的 6 条失败均为测试与当前产品语义漂移（P0 官方 ERC/DRC 才进入问题清单、Runtime 权威写门禁、多 Provider/Agent alert 作用域、未 mock `write-gate`/`validation-state`、禁用开关缺 `title`）；已按当前语义更新用例并补 `Toggle` 禁用原因 `title`，未放宽断言。详见 `.auto-coding/testing/reports/20261029_app-e2e.md`；既有 app suite **31/31 PASS**。
15. **真实自动回滚不可靠（P0，已真机暴露）**：2026-10-29 用户批准的回滚演练 `planHash 03f6ae40…` 先成功创建临时线 `dd798b01445c4e6a`，随后故意非法 `component.modify` 失败；Runtime 调用 `document.source.restore` 返回 true，但恢复后源码摘要仍与阶段快照 `b33bac25…` 不匹配，报 `PCB_ROLLBACK_VERIFY_FAILED` 并锁写。真机恢复时发现线数 1152→1153，VCCD4 被拆成两段；用 EasyEDA 撤销历史 + 保存恢复为 1152 线/95 器件/191 过孔/13 铺铜，DRC 0（证据 digest `fd0e7947…`），安全锁按用户全部批准释放。**fail-closed 行为正确，但自动回滚不能作为生产承诺**；根因指向实验适配器与 EasyEDA `setDocumentSource` 组合（CLI v1.3.0 / connector v1.14.0），修复前不得再执行回滚演练。**已实施代码级缓解**：回滚前按本次创建返回的 primitive id 先执行 `pcb.lines.delete`/`pcb.vias.delete`/`pcb.pour.delete` 定向清理并保存；**若实际落板变更全是创建类，则走定向回滚**（核对计数与创建 id 消失，`rollback.scope=targeted`，明确不做整档源码恢复）；含 component.modify/importChanges 等非创建变更仍走整档恢复，摘要不匹配仍锁写。新增回归用例，runtime 1433/1433。**2026-10-30 已用隔离 Runtime 4186 + 新代码真机复验 create-only 定向回滚通过**（临时线删除、1152 线/95 器件/191 过孔/13 铺铜、基线 DRC 0、无安全锁；证据 `artifacts/agent-rollback-drill-targeted-success-20261030.json`）；整档 `document.source.restore` 及非创建变更回滚仍未验证。证据 `artifacts/agent-rollback-drill-failed-20261029.json`。

## 4. 使用步骤（Runtime 已就绪，剩 DSH 加载与 EDA）

1. 桌面 app 已于 2026-10-30 重建并重启，bundle 与仓库哈希一致（见 `artifacts/agent-environment-recovery-20261030.json`）；后续只需在 EDA 可写后做真机写板验收。
2. 确认 token 文件存在且 0600：
   `ls -l "$HOME/Library/Application Support/CircuitPilot/agent-token.json"`
3. 安装插件到独立 profile：
   `dsh plugin --profile cp-test add "link:$PWD/plugin/dsh-circuitpilot"`
4. 启动 cp-test profile（或把插件加入 desktop 后重启 DSH）。
5. 在对话里先调用 `cp_status`；再试 `cp_design_plan` / `cp_pcb_plan`，确认无误后再 `cp_approve` + `cp_execute`。
6. 真实 EDA（只读/批量/最小写链路已通，回滚演练失败）：`npm run bridge:agent` 起实验适配器 → 在 EasyEDA 打开测试板 → `cp_status` 确认在线 → 按 plan→approve→execute→DRC 做写链路；验证后停适配器。**自动回滚已真机失败，修复并回归前不要再次执行回滚类写入**；下一步先修回滚可靠性，再由用户确认新的改图元/导出计划。

## 5. 下一步（按优先级）

- **P0：真实自动回滚（create-only 定向回滚已真机通过；整档/非创建仍待验）**：2026-10-30 隔离 4186 加载新代码，用户批准 `c629fda8…` 后真机通过：临时线删除、计数回到 1152/95/191/13、基线 DRC 0、无安全锁。非创建变更仍整档恢复、失败锁写；整档 restore 仍不可靠。下一步：桌面 4178 重建/重启加载新 bundle；再设计非创建回滚演练（须新 planHash + 用户确认）。
- ~~P0：安装插件并完成一次真实宿主加载 + 只读 `cp_status` 验收~~（已完成：`artifacts/agent-dsh-live-toolcall.json`；desktop profile 已 link 安装，Electron 重启后生效）。
- ~~P0：在可擦写测试板完成一条 plan→approve→execute→DRC 证据链（人工在场）~~（已完成：planHash `5ed49af5…`，approvalId `3e0dd669e7bd9c4c`，execution `b0b8eac8-c786-434f-8098-5ed95ebc2dae`，save 成功、DRC 0、几何 delta=0；证据 `artifacts/agent-real-pcb-write-20261029.json`、报告 `.auto-coding/testing/reports/20261029_real-pcb-write.md`。注意：不改设计图元，不等于改板/回滚验收）。
- P1：计划级待审批队列 + 逐条批准/拒绝已完成；下一步评估“UI 批准后由 Runtime 直接触发执行”的授权语义（当前仍是 Agent `cp_approve` → `cp_execute`，UI 不签发 token）。
- P1：批量/多板**写**计划（只读批量已真机跑通）、审计归档/回放、跨宿主（Claude Code/Codex）。
- P2：跨宿主（Claude Code/Codex）验证；MCP streamable-http 已实现并在真实 Runtime + 真实 MCP HTTP 子进程端到端取证（`verify:agent-mcp-live` 9/9），可选 HTTP 认证已加；尚未在真实 DSH/第三方宿主加载。
