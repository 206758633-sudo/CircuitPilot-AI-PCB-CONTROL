# CircuitPilot Agent Control MVP 契约（v0.1）

> 目的：让 DSH 插件/Agent 能安全驱动 CircuitPilot 完成「读状态 → 出计划 → 用户对话确认 → 执行 → 证据摘要」。
> 本契约先服务 **DSH 原生插件 MVP**；MCP Server 复用同一套 Runtime HTTP，后续再加。

## 1. Agent 身份与令牌

### 文件
- 路径：`CIRCUITPILOT_AGENT_TOKEN_FILE`，默认 `~/Library/Application Support/CircuitPilot/agent-token.json`
- 权限：文件 `0600`，目录 `0700`
- 内容：

```json
{
  "version": 1,
  "name": "dsh-plugin",
  "token": "cpa_<48 hex>",
  "scopes": ["read", "plan", "execute"],
  "createdAt": "2026-10-29T00:00:00.000Z"
}
```

### 签发/轮换
- 由 Runtime 启动时（`startRuntime` 路径）确保存在；不存在则原子写入。
- UI 设置页「Agent 接入」面板可轮换：`POST /api/agent/token/rotate`（仅 UI 会话），原子替换文件并刷新 Runtime 认证缓存；旧 token 立即失效，插件下次请求自动读取新 token。
- 不写日志、不回显完整 token；状态接口只返回文件路径/scope/时间等元数据。
- 测试通过 `CIRCUITPILOT_AGENT_TOKEN_FILE` 指向临时文件，审计通过 `CIRCUITPILOT_AGENT_AUDIT_FILE` 隔离。

### 认证
- 请求头：`x-circuitpilot-agent-token: <token>`
- Runtime 校验文件中的 token（常量时间比较），命中后设置 `request.agent = { name, scopes }`。
- 现有 `x-circuitpilot-token`（UI 会话）保持原行为。
- 两种 token 都无效 → 401。

### Agent 禁止访问的路由（denylist）
即使 token 有 `execute`，agent 不得调用：
- `/api/production/signoff`、`/api/production/reviews/final`、`/api/production/order-confirmation`
- `/api/write-gate`（POST）
- `/api/agent/*`（除 status/health；以及 **仅创建** 的 `POST /api/agent/plan-requests`，见第 1.1 节）
- `/api/settings*`、`/api/providers*`、`/api/research/config`
- 文件下载/诊断包导出

**对话审批例外（approvalMode=chat）**：仅 `POST /api/design/approve`、`POST /api/pcb/approve` 两条精确路径允许；GET/HEAD、其它方法、子路径一律拒绝。Runtime 对 agent 的 approve 额外强制 `body.confirm === true` 且 `body.approvalMode === 'chat'`，否则 403 `AGENT_APPROVAL_CONFIRMATION_REQUIRED`。签核/订单/设置仍由 denylist 硬拒绝。

**计划级待审批例外**：仅 `POST /api/agent/plan-requests` 精确路径（创建请求）允许 Agent；`GET /api/agent/plan-requests` 与 `POST /api/agent/plan-requests/:id/decision` 仍 403。

### Agent 接入控制台 API
| 路由 | 权限 | 说明 |
|---|---|---|
| `GET /api/agent/status` | UI + Agent | 令牌元数据（available/file/name/scopes/createdAt/reason）+ 最近 5 条审计 + `auditIntegrity`；绝不返回 token 原文 |
| `GET /api/agent/audit?limit=20` | 仅 UI | 审计尾部列表（最新在前）+ `integrity`；limit 1–1000；Agent 访问被 denylist 403 |
| `POST /api/agent/token/rotate` | 仅 UI | 原子轮换令牌并刷新认证缓存；旧 token 立即 401；不返回 token |
| `GET /api/agent/approvals` | 仅 UI | 已签发未使用/撤销/过期的计划批准队列（design+pcb 合并，逐项白名单字段）；不返回 token/tokenDigest；Agent 访问被 denylist 403 |
| `POST /api/agent/approvals/:approvalId/revoke` | 仅 UI | 按 approvalId 撤销未使用批准；不存在/已撤销 404、已用/过期 409；写 UI 审计 `approve/revoked`，不执行任何写操作；Agent 访问 403 |

### 1.1 计划级待审批队列（task-40）

Agent 只能“登记计划请求”，**UI 决策不发 token**；真正的审批令牌仍由 Agent 在用户确认后调用
`POST /api/design/approve` / `POST /api/pcb/approve` 时签发（旧对话审批路径不变）。

| 路由 | 权限 | 说明 |
|---|---|---|
| `POST /api/agent/plan-requests` | Agent（或本机 UI） | 创建 pending 请求；只落队列，不签发/返回任何 approval token；审计 `kind=request, actor=agent, outcome=created` |
| `GET /api/agent/plan-requests?status=pending\|approved\|all&limit=` | 仅 UI | 查看请求（排除过期，createdAt asc）；`{ok:true,total,requests}`；Agent 403 |
| `POST /api/agent/plan-requests/:requestId/decision` | 仅 UI | body `{decision:'approve'\|'reject', confirm:true, note?}`；只改队列记录；审计 `kind=approve, actor=ui, outcome=approved\|rejected`；Agent 403 |

- `requestId`：`apr_` + 16 hex，落盘/重启保留；状态 `pending|approved|rejected|consumed`。
- 字段白名单：`requestId, kind('design'|'pcb'), planHash, targetFingerprint, windowId, projectId, documentUuid, title, summary, risks, missing, status, createdAt, expiresAt, decidedAt, consumedAt, decisionNote`；`createdAt/expiresAt/decidedAt/consumedAt` 为毫秒时间戳。**任何 token/tokenDigest 都不在 Store 中。**
- 校验：kind 必填；`planHash` 非空 ≤128；`targetFingerprint`/`windowId` 非空 ≤256；`title` ≤500；`summary` ≤2000；`risks`/`missing` 各 ≤20 条、每条 ≤300；`expiresAt` 默认 now+24h，必须未来且 ≤7d；容量 100，满时只淘汰最旧 expired/consumed/rejected，绝不淘汰 live pending/approved（否则 `PLAN_REQUEST_CAPACITY`）。
- 持久化：`<CIRCUITPILOT_STATE_DIR>/agent-plan-requests.json`，JSON 原子写（temp+rename）且 0600；加载损坏 fail-closed（Runtime 启动日志明确，相关路由 503 `PLAN_REQUEST_STORE_UNAVAILABLE`，绝不静默空队列）。
- 消费（server 内部）：`POST /api/design/approve`/`POST /api/pcb/approve` 的 body 带非空 `approvalRequestId` 时，必须先消费 `status=approved`、未过期且 `kind/planHash/targetFingerprint/windowId` 全一致的请求（用 manager 归一化后的权威 planHash 校验），manager body 会去掉 `approvalRequestId`；manager 失败回滚 consumed→approved；签发后消费失败则撤销刚签发的 token。
- 错误码（`PLAN_REQUEST_*`）：`INVALID`/`CONFIRM_REQUIRED` → 400；`NOT_FOUND` → 404；`EXPIRED`/`NOT_APPROVED`/`ALREADY_DECIDED`/`ALREADY_CONSUMED`/`BINDING_MISMATCH`/`CAPACITY` → 409；`STORE_UNAVAILABLE` → 503。
- 安全语义：Agent 不能替用户批准；UI 的 approve/reject 只改变请求状态、**不签发任何审批令牌**；后续执行仍走既有
  `cp_approve`（Agent 带 `confirm=true`+`approvalMode=chat`）→ 消费请求 → 拿 approval token → `cp_execute` 的一次性批准链。

审计为 JSONL（默认 `<CIRCUITPILOT_STATE_DIR>/agent-audit.jsonl`），字段白名单：
`seq/at/kind/actor/agent/method/path/outcome/status/planHash/tool/target/executionId/requestId/approvalId/note/prevHash/hash`。
`kind` 取 `request | denied | approve | rotate`；写入失败不影响业务请求。

**防篡改（HMAC 哈希链 + 链头锚点）**：
- 每条记录带 `seq`、`prevHash`（首条 64 个 0）、`hash = HMAC-SHA256(key, `${seq}\n${prevHash}\n${canonicalEventJson}`)`。
- 密钥文件默认 `<审计目录>/agent-audit.key.json`（`CIRCUITPILOT_AGENT_AUDIT_KEY_FILE` 可覆盖），首次自动生成 32B，文件 0600；**密钥永不出现在审计/返回/日志**。
- 链头锚点默认 `<审计目录>/agent-audit.head.json`（`CIRCUITPILOT_AGENT_AUDIT_HEAD_FILE` 可覆盖），内容 `{version:1,seq,hash,updatedAt}`，0600 原子写；只含哈希，不含密钥。读取时最后一条记录必须与锚点 `seq/hash` 一致，否则 broken：`head-ahead`（尾部/整文件被删）、`head-behind`（崩溃窗口）、`head-hash-mismatch`（最后一条被替换）、`head-invalid`（锚点损坏）。
- 读取校验 HMAC 与 `prevHash`；篡改字段/删除任意行/换序 → `integrity.ok=false, chain='broken'`，但接口仍 200 并尽量返回事件供展示；最后一行损坏或锚点不一致时追加拒绝（`AGENT_AUDIT_CHAIN_BROKEN`），不会写半条。
- 锚点缺失但链存在 → `anchored:false`、不判 broken（旧审计兼容）；下一次成功追加会补锚。
- 下载路由显式拒绝 `agent-token.json`、`agent-audit.key.json`、`agent-audit.head.json`。
- `integrity` 形状：`{ok, chain:'empty'|'ok'|'broken'|'legacy', verified, legacy, badLines, anchored, headSeq, headHash, firstBadSeq?, reason?}`。
- **恢复语义**：head 领先/落后都 fail-closed，需人工确认尾部完整后修正 head，或归档 audit+head（key 可留）让下一请求重建 seq=1；append 写行与 rename head 之间有微秒级瞬态 `head-behind` 窗口。

## 2. Runtime 复用

Agent 直接调用现有 HTTP 路由，不复制业务逻辑：

| 能力 | 路由 |
|---|---|
| 健康/版本 | `GET /api/health` |
| 项目 | `GET /api/project-state`、`GET /api/projects` |
| EDA/工作区 | `GET /api/eda/workspaces/current`、`GET /api/eda/app/focus` |
| 问题 | `GET /api/issue-state`、`GET /api/validation-state` |
| 证据 | `GET /api/evidence/find`、`GET /api/evidence/index` |
| 设计计划 | `POST /api/design/plan`、`POST /api/design/plan/ai` |
| 设计执行 | `POST /api/design/execute` |
| PCB 计划/执行 | `POST /api/pcb/plan`、`POST /api/pcb/execute` |
| 验证 | `POST /api/eda/schematic/erc/run`、`POST /api/eda/pcb/drc/start` |
| 门禁 | `GET /api/eda/gates/status`、`POST /api/eda/gates/evaluate` |
| 放行 | `GET /api/production/readiness` |
| 导出 | `POST /api/production/export` |
| 知识 | `GET /api/knowledge/entries`、`GET /api/rag/query` |
| Agent 状态 | `GET /api/agent/status`（Agent 可读元数据/最近审计） |
| 计划待审批 | `POST /api/agent/plan-requests`（Agent 创建）、`GET /api/agent/plan-requests` + `POST /api/agent/plan-requests/:id/decision`（仅 UI） |

Agent 工具只做参数校验、审批、结果裁剪、错误映射，不绕过 planHash/lineage/写锁/DRC 基线。

## 3. 插件工具面（MVP 12 个）

| 工具 | 类型 | 说明 |
|---|---|---|
| `cp_status` | read | Runtime/EDA/项目/写锁/最近证据/待处理事项 |
| `cp_project_context` | read | 当前项目、板子、阶段、官方问题；`includeAllProjects=true` 时额外返回多项目/多板只读总览 |
| `cp_issues` | read | 当前项目官方未收口问题 |
| `cp_evidence` | read | 指定 kind/execution 的证据摘要与文件引用 |
| `cp_knowledge` | read | approved 知识检索（带 citation） |
| `cp_design_plan` | plan | 需求→设计计划/planHash/风险/审批提示 |
| `cp_pcb_plan` | plan | PCB 落板/布局/布线计划 |
| `cp_approve` | approve | 对话批准：planHash + confirm=true + approvalMode=chat；Runtime 记 agent 审计 |
| `cp_execute` | execute | 执行已批准计划；无 approval 则拒绝 |
| `cp_validation` | execute | 运行 ERC/DRC/门禁并返回摘要；`boards` 最多 3 块板顺序批量只读校验（与单板参数互斥；ERC 必须带该板 schematicUuid） |
| `cp_export` | execute | 导出/归档（需显式确认） |
| `cp_job` | read | 长任务的 status/wait/cancel（插件内 job manager） |

> 实现按 12 个收敛；插件默认 `approvalMode: 'chat'`，可配置为 `off` 关闭审批类工具。

## 4. 长任务

- 插件内 `JobManager`：`start(kind, requestId, fn)` → `{jobId}`；`status`/`wait`/`cancel`。
- 写操作必须带 `requestId`，同 id 返回同一 job，不重复执行。
- 超时返回 `mayHaveTakenEffect: true` + jobId；禁止自动重试写操作。
- 结果按 `maxResultBytes`（默认 16KB）裁剪，保留 `truncated` 标记和证据引用。

## 5. 结果格式

```json
{
  "ok": true,
  "summary": "一句话",
  "data": {},
  "evidence": [{ "kind": "...", "ref": "...", "digest": "..." }],
  "nextActions": ["..."],
  "truncated": false
}
```

- 不返回完整 DRC/ERC 原始大 JSON；摘要 + 证据引用。
- 图片/截图以文件路径引用，DSH 插件可后续转附件。
- 错误统一：`{ ok:false, code, message, nextActions }`；EDA 离线/桥断开/未绑定/写暂停要可执行。
- 计划/批准结果可带 `data.approvalUrl`（CircuitPilot UI 审批深链，默认 `http://127.0.0.1:4177/?agent=approvals#settings`，只含 UI 地址，不含 token/key）。

## 6. 安全边界

- 写操作默认受现有 `write-gate` 控制；暂停时 409。
- 禁止绕过审批、签核、订单、设置。
- 不执行任意 shell/文件路径；只调用白名单路由。
- 项目/BOM/知识文本视为不可信，不改变工具权限。
- 所有 agent 动作写审计：token name、method/path、outcome/status；approve 额外记 planHash/approvalId。
- MCP HTTP 传输是**可选令牌认证**：设置 `--http-token-file`（0600 非空）或测试用
  `--http-token` 后，`POST/GET/DELETE /mcp` 必须带 `Authorization: Bearer <token>` 或
  `x-circuitpilot-mcp-token: <token>`（常量时间比较）；失败 401
  `{ok:false,error:'MCP_HTTP_UNAUTHORIZED'}`，不执行 JSON-RPC、不返回工具/错误细节；
  `GET /health` 公开、未知路径仍 404。未配置时保持仅 loopback 的旧行为（stderr warning）。
- 审计只记元数据；任何 `cpa_<48hex>` 样式字符串在写入/读取时脱敏。
- 审计 HMAC 链只保证“本机可检测篡改”；密钥丢失会让链不可验证（fail-closed 标 broken，不自动重建假链）。

## 7. 目录与所有权

- Runtime token 模块：`runtime/agent-token.mjs` + 测试
- Runtime 控制台/审计：`runtime/agent-console.mjs` + 测试
- 设置页面板：`src/components/AgentAccessPanel.tsx` + 测试
- 插件：`plugin/dsh-circuitpilot/**`
- 技能：`plugin/dsh-circuitpilot/skills/circuitpilot/SKILL.md`
- 验证：`verification/agent/**`
- MCP 传输：默认 `stdio`；`agent/mcp-server.mjs --http --http-port 4180 --http-host 127.0.0.1` 提供 Streamable HTTP（`POST /mcp` 单响应 JSON、`GET /health`；`Mcp-Session-Id` 为随机 UUID 仅作会话标识、不作认证；协议仍是 legacy 2025-era，`GET /mcp` 405、`DELETE /mcp` 204）
- MCP HTTP 认证（可选，推荐）：`--http-token-file <path>`（env `CIRCUITPILOT_MCP_HTTP_TOKEN_FILE`；文件必须 0600 且 trim 后非空，缺失/空/权限过宽 → 配置错误 exit 2）或仅测试用的 `--http-token <token>`（进程列表可见，不推荐）。`--print-config` 显示 `httpAuth`/`httpTokenFile` 但绝不打印 token。DSH streamable-http profile 在 `headers` 里加 `Authorization: 'Bearer <token>'`（或 `x-circuitpilot-mcp-token`）；无/错 token → 401 `MCP_HTTP_UNAUTHORIZED`，不执行 JSON-RPC
- Live Runtime 验收：`npm run verify:agent-live`（`scripts/agent-live-acceptance.mjs`；默认临时端口/临时目录拉起真实 Runtime 子进程跑 9 项矩阵；`-- --base-url http://127.0.0.1:4178` 对现有 Runtime，旧 Runtime 404 时 exit 2）
- MCP HTTP Live 验收：`npm run verify:agent-mcp-live`（`scripts/agent-mcp-live-acceptance.mjs`；自包含拉起真实 Runtime 子进程 + 真实 `agent/mcp-server.mjs --http`，通过真实 HTTP 跑 initialize/session/通知/tools-list 12/cp_status/无 token·key 泄漏/stdout 0B/端点边界 9 项矩阵；结束 SIGTERM 两个子进程并清理临时目录，PASS x/y exit 0/1）
- `runtime/server.mjs` 仅 Lead 修改（接入认证/denylist）
