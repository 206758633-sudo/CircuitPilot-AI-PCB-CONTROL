# CircuitPilot Agent MCP Server

`agent/mcp-server.mjs` 是 CircuitPilot 的 **MCP（Model Context Protocol）server**，默认通过
**stdio**、可选通过 **Streamable HTTP**（`--http`）把 `plugin/dsh-circuitpilot` 的 12 个
CircuitPilot 工具暴露给 MCP 宿主（首选 DSH 的 `@deepseek-ai/dsh-mcp-client`）。工具实现、审批语义、JobManager、结果投影全部
复用 `plugin/dsh-circuitpilot/lib/*`，本目录只负责协议与进程边界。

- 零第三方依赖：`@modelcontextprotocol/sdk` 未安装、也不允许在本 MVP 的根
  `package.json` 新增依赖，因此这里手写最小 JSON-RPC 实现，协议行为由真实子进程测试保证。
- 本目录只维护 MCP server/测试/README；除 `docs/agent/agent-contract.md`（同步安全边界）外
  不改 `runtime/**`、`plugin/**`、`src/**`；不重启 DSH、不调用真实 EDA/Bridge。
- 安全边界不在这里“重新发明”：agent token 校验、路由白/黑名单、写门禁、审批绑定都由
  Runtime 侧强制；MCP server 只是按契约调用，并保证 token/审批 token 不泄漏给模型。

## 目录

| 文件 | 作用 |
|---|---|
| `agent/mcp-server.mjs` | MCP server 实现（stdio 默认 + Streamable HTTP 可选）+ CLI 入口 |
| `agent/__tests__/mcp-server.test.mjs` | 进程内协议/配置单测（25 个用例） |
| `agent/__tests__/stdio-session.test.mjs` | 真实子进程 + fake HTTP Runtime 集成测试（12 个用例） |
| `agent/__tests__/mcp-http.test.mjs` | Streamable HTTP 传输测试（12 个用例：session/通知/405/404/health/关闭释放端口 + 可选 HTTP token 认证） |
| `agent/__tests__/helpers/fake-runtime.mjs` | fake CircuitPilot Runtime（node:http）与 token 文件工具 |
| `agent/__tests__/helpers/mcp-session.mjs` | 启动/驱动真实 MCP server 子进程的测试客户端 |
| `agent/dsh-profile.example.yml` | 接入 DSH 的 profile 片段示例 |

## 快速开始

```bash
# 直接作为 MCP server 运行（stdout 只输出 JSON-RPC，日志在 stderr）
CIRCUITPILOT_RUNTIME_URL=http://127.0.0.1:4178 \
CIRCUITPILOT_AGENT_TOKEN_FILE="$HOME/Library/Application Support/CircuitPilot/agent-token.json" \
node agent/mcp-server.mjs

# 可选：Streamable HTTP 传输（默认仍是 stdio；只绑回环地址）
# 推荐先创建 HTTP 认证 token 文件（必须 0600 且非空；不配置则无认证，仅本机可用）
TOKEN_DIR="$HOME/Library/Application Support/CircuitPilot"
mkdir -p "$TOKEN_DIR"
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex') + '\n')" > "$TOKEN_DIR/mcp-http-token"
chmod 600 "$TOKEN_DIR/mcp-http-token"
CIRCUITPILOT_AGENT_TOKEN_FILE="$TOKEN_DIR/agent-token.json" \
node agent/mcp-server.mjs --http --http-port 4180 --http-host 127.0.0.1 \
  --http-token-file "$TOKEN_DIR/mcp-http-token"
#   MCP endpoint: POST http://127.0.0.1:4180/mcp（需 Authorization: Bearer <mcp-http-token>）
#   健康检查:     curl http://127.0.0.1:4180/health（公开，无需 token）

# 查看有效配置（脱敏）/帮助/版本（都写 stderr，不影响协议通道）
node agent/mcp-server.mjs --print-config
node agent/mcp-server.mjs --help
node agent/mcp-server.mjs --version
```

退出码：`0` 正常；`1` 运行时致命错误；`2` 配置错误。

### 配置项

flag 优先于环境变量；默认值与 `plugin/dsh-circuitpilot/lib/tools.mjs` 的
`DEFAULT_TOOL_CONFIG` 保持一致。

| flag | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--runtime-url` | `CIRCUITPILOT_RUNTIME_URL` | `http://127.0.0.1:4178` | Runtime 地址（只允许 http/https，且不允许带用户名/密码） |
| `--token-file` | `CIRCUITPILOT_AGENT_TOKEN_FILE` | `~/Library/Application Support/CircuitPilot/agent-token.json` | agent token 文件；与 `--token` 互斥 |
| `--token` | `CIRCUITPILOT_AGENT_TOKEN` | — | 显式 token（测试/受控场景；不要写进 profile） |
| `--approval-mode` | `CIRCUITPILOT_APPROVAL_MODE` | `chat` | `chat` 开放对话审批；`off` 时 `cp_approve`/`cp_execute` 一律拒绝 |
| `--max-result-bytes` | `CIRCUITPILOT_MAX_RESULT_BYTES` | `16384` | 单工具结果上限（1024..262144） |
| `--request-timeout-ms` | `CIRCUITPILOT_REQUEST_TIMEOUT_MS` | `30000` | Runtime 单请求超时 |
| `--job-timeout-ms` | `CIRCUITPILOT_JOB_TIMEOUT_MS` | `300000` | 长任务超时 |
| `--plan-ttl-ms` / `--approval-ttl-ms` | — | 见 `DEFAULT_TOOL_CONFIG` | 计划缓存 / 对话批准 TTL |
| `--drc-poll-interval-ms` / `--drc-poll-timeout-ms` | — | 见 `DEFAULT_TOOL_CONFIG` | `cp_validation` 的 DRC 轮询 |
| `--http` | — | 关闭（stdio） | 启用 Streamable HTTP 传输；不传时仍是 stdio |
| `--http-port` | `CIRCUITPILOT_MCP_HTTP_PORT` | `4180` | HTTP 监听端口（1..65535；`0` 仅测试/库调用用） |
| `--http-host` | `CIRCUITPILOT_MCP_HTTP_HOST` | `127.0.0.1` | HTTP 监听地址（默认只绑回环） |
| `--http-token-file` | `CIRCUITPILOT_MCP_HTTP_TOKEN_FILE` | — | HTTP 认证 token 文件：必须 0600 且 trim 后非空；设置后 `/mcp` 的 POST/GET/DELETE 强制认证；与 `--http-token` 互斥 |
| `--http-token` | — | — | 仅测试用的显式 HTTP 认证 token（会出现在进程列表，不推荐；不要写进 profile） |

token（agent token 与 HTTP 认证 token）只从文件或显式参数读取，**从不写日志、从不写进
MCP 响应**；`--print-config` 只显示 `tokenSource`、`httpAuth`、`httpTokenFile`，不打印
任何 token 值。设置 HTTP token 文件但未加 `--http` 时仅做配置校验（不影响 stdio）。

## 接入 DSH

把 `agent/dsh-profile.example.yml` 中的条目加入 DSH profile 的插件列表。关键字段：

- `serverName: circuitpilot` → 模型侧工具名为 `mcp__circuitpilot__cp_status`、
  `mcp__circuitpilot__cp_design_plan` 等（DSH 统一加 `mcp__<serverName>__` 前缀）。
- `transport: stdio` + `command: node` + `args: ['<仓库绝对路径>/agent/mcp-server.mjs', '--approval-mode', 'chat']`。
- `env` 显式传 `CIRCUITPILOT_AGENT_TOKEN_FILE`（和可选的 `CIRCUITPILOT_RUNTIME_URL`）。
  DSH 的 stdio 子进程环境是“清洗过的父环境 + 配置的 env”：名字含
  `KEY|PASSWORD|SECRET|TOKEN` 的父环境变量以及 `DSH_*` 会被剥离，所以 token 文件路径
  必须在这里显式配置（profile 支持 `!!js` 时可用
  `CIRCUITPILOT_AGENT_TOKEN_FILE: !!js process.env.CIRCUITPILOT_AGENT_TOKEN_FILE`）。
- `toolCallTimeoutMs: 300000`：覆盖 `cp_job wait` 最长 300s 的等待，否则长任务轮询会被
  宿主提前掐断（掐断不代表没生效，见下文）。
- `failOnStartupError: false`：MCP server 起不来时 DSH 仍能启动，只是没有这些工具。
- DSH 的 `stdio` auto 协商会**先启动一次性探测进程**发 `server/discover`，再启动正式
  进程发 `initialize`。本 server 对 `server/discover` 返回 `-32601`，这是“明确的 legacy
  信号”，DSH 会按预期回退到 2025-era handshake（详见下文）。

### Streamable HTTP（可选，DSH profile 片段）

适合希望 MCP server 独立常驻（而不是每次由宿主 spawn）的宿主；工具/审批/JobManager
语义与 stdio 完全一致，协议仍是 **legacy 2025-era**。先手动起 server：

```bash
# 推荐启用 HTTP token 认证（token 文件必须 0600 非空）：
node agent/mcp-server.mjs --http --http-port 4180 --http-host 127.0.0.1 \
  --http-token-file "$HOME/Library/Application Support/CircuitPilot/mcp-http-token"
# 健康检查（公开）：curl http://127.0.0.1:4180/health
# 不配置 --http-token-file 时保持旧行为（无认证，仅 loopback；启动 stderr 会 warning）
```

再把下面的条目加入 DSH profile 的插件列表（字段名以你的 `dsh-mcp-client` 版本为准；
核心是 `transport: streamable-http` + `url` 指向 `/mcp`）：

```yaml
- id: mcp-circuitpilot-http
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: circuitpilot
    transport: streamable-http
    url: 'http://127.0.0.1:4180/mcp'
    # 与 --http-token-file 内容一致；DSH 以 HTTP header 发送（不要放 agent token）
    headers:
      Authorization: 'Bearer <mcp-http-token>'
    toolCallTimeoutMs: 300000
    maxInstructionBytes: 32768
    failOnStartupError: false
```

- HTTP 端点：`POST /mcp`（JSON-RPC；initialize 成功响应带 `Mcp-Session-Id` UUID，
  后续请求带/不带都接受，**该 header 只是会话标识、不作认证**）；`GET /health` 健康检查；
  `GET /mcp` → 405（不提供 SSE 推送）；`DELETE /mcp` → 204（结束当前会话）。
- **HTTP 传输认证（task-38，可选但推荐）**：`--http-token-file`（0600 非空）或仅测试用的
  `--http-token` 设置后，`POST/GET/DELETE /mcp` 必须带 `Authorization: Bearer <token>`
  或 `x-circuitpilot-mcp-token: <token>`（常量时间比较）；失败 401
  `{ok:false,error:"MCP_HTTP_UNAUTHORIZED"}`，不执行 JSON-RPC、不返回工具细节。
  `GET /health` 公开且不含 token；未知路径仍 404。token 设置后启动/请求日志都不打印 token。
- 未配置 HTTP token 时保持旧行为：只监听 loopback、无认证；启动会在 stderr 明确 warning
  建议 `--http-token-file`，**不要把 4180 暴露到公网/局域网**。
- 进程内 agent token（Runtime 鉴权）与 HTTP 认证 token 是两套凭据：前者只在 MCP server
  进程 env/文件里，后者由 DSH 以 HTTP header 发送。
- 日志只写 stderr（或 `runHttpServer` 传入的 `log`），stdout 不承载协议。

> 接入后验证：问模型“调用 cp_status 看 CircuitPilot 状态”。工具缺失时先看 DSH 日志里
> `mcp-client(circuitpilot)` 的报错，再在终端手动跑 `node agent/mcp-server.mjs` 看 stderr。

## MCP 协议实现

### 传输与分帧

- 默认 **stdio**：stdin/stdout 上按换行（`\n`）分隔的 JSON-RPC 2.0 消息（MCP 官方 stdio 约定）。
- 可选 **Streamable HTTP**（`--http`，legacy 2025-era 语义）：`POST /mcp` 单响应
  `application/json`（通知 → 202 空 body；畸形 JSON → 400 + `-32700`；body 上限 8MB）；
  initialize 响应带 `Mcp-Session-Id`（UUID，随机生成、非认证）；`GET /mcp` → 405（无 SSE），
  `DELETE /mcp` → 204，`GET /health` → `{ok:true,service:'circuitpilot-mcp',transport:'streamable-http'}`。
- 可选 HTTP 认证：配置 token 后，`/mcp` 的 POST/GET/DELETE 需 `Authorization: Bearer`
  或 `x-circuitpilot-mcp-token`；401 响应固定为 `{ok:false,error:"MCP_HTTP_UNAUTHORIZED"}`，
  `/health` 与未知路径不参与认证。
- **stdout 只写 JSON-RPC 行**：任何日志、帮助、错误摘要都写 stderr（有测试断言）。
- 每条输入行独立分发；`tools/call` 不阻塞后续消息，因此 `ping`/
  `notifications/cancelled` 可以在长调用执行期间被处理。
- stdin 关闭后：等待执行中的请求（宽限 5s）→ 中止 → 退出码 0。一次性探测进程
  （只发 `server/discover` 就被关闭）同样干净退出。

### 版本协商（legacy 2025-era）

| 客户端请求 `initialize.protocolVersion` | 本 server 响应 |
|---|---|
| `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05` / `2024-10-07` | 原样回显 |
| 其他（含现代 `2026-07-28`、非法值） | 回落到 `2025-11-25` |

- 只实现 2025-era 语义：`initialize` 响应 `{protocolVersion, capabilities:{tools:{listChanged:false}}, serverInfo, instructions}`。
- **不实现** 现代（2026-07-28+）协议：对 `server/discover` 一律返回 JSON-RPC
  `-32601 Method not found`。这是官方 SDK auto 协商（`versionNegotiation: { mode: 'auto' }`）
  判定 legacy 的依据；`dsh-mcp-client` 因此会回退到 `initialize`，不会把现代 wire 语义
  强加到本 server 上。
- 重复 `initialize` 返回 `-32600`；`initialize` 缺 `protocolVersion`/`params` 非对象返回 `-32602`。

### 支持的方法

| 方法 | 行为 |
|---|---|
| `initialize` | 协商版本、声明 `tools` 能力、返回 `serverInfo` 与 `instructions`（1329 字节，远低于 DSH 默认 32KB 上限） |
| `notifications/initialized` | 静默接受 |
| `ping` | 任意时刻返回 `{}` |
| `tools/list` | 返回 12 个工具（单页，无 cursor） |
| `tools/call` | 执行工具；参数/未知工具错误用 `-32602`，工具业务失败用 `ok:false` envelope |
| `notifications/cancelled` | 中止对应执行中的 `tools/call`，且**不为被取消的请求发送响应** |
| `server/discover` | `-32601`（legacy 信号，见上） |
| 其他方法 | `-32601` |

不支持的能力：`resources`、`prompts`、`sampling`、`logging`、`tasks`、`completion`
（请求这些方法会收到 `-32601`）。这是有意的最小实现：MVP 只需要工具调用。

### 错误码

| 码 | 场景 |
|---|---|
| `-32700` | stdin 行 / HTTP body 不是合法 JSON（HTTP 返回 400） |
| `-32600` | 非对象消息、缺 `jsonrpc: "2.0"`、缺 `method`、未 `initialize` 就发 `tools/list`/`tools/call`、重复 `initialize`、JSON-RPC batch |
| `-32601` | 未知方法 / `server/discover` / 不支持的能力 |
| `-32602` | `tools/call` 的 `name`/`arguments` 类型错误、未知工具、`initialize` 参数缺失 |

工具的业务错误**不是** JSON-RPC 错误：统一放在 `structuredContent` 的
`{ok:false, code, message, nextActions}` 里（与插件原生工具、`docs/agent/agent-contract.md`
§5 一致），便于模型读取 `nextActions` 后纠正。MCP 结果不设置 `isError`：DSH 会把
`isError` 直接转成工具失败并丢掉 `nextActions`，而这里需要模型看到完整错误结构。

### 工具列表

12 个工具（名称、输入 schema、执行逻辑全部来自 `plugin/dsh-circuitpilot/lib/tools.mjs`）：

| 工具 | 类型 | 用途 / Runtime 路由 |
|---|---|---|
| `cp_status` | read | Runtime/项目/EDA/写门禁/问题/证据总览；`GET /api/health` 等 |
| `cp_project_context` | read | 项目 + EDA 工作区 + 问题快照 |
| `cp_issues` | read | 未收口问题详情（`GET /api/issue-state`） |
| `cp_evidence` | read | 证据索引/查找/执行证据 |
| `cp_knowledge` | read | approved 知识与 RAG citation |
| `cp_design_plan` | plan | 生成/规范化原理图计划，返回 `planHash`（不执行、不批准） |
| `cp_pcb_plan` | plan | 生成 PCB 计划，返回 `planHash` |
| `cp_approve` | approve | 记录对话批准：必须 `confirm:true` + 本会话已知 `planHash`；`POST /api/design/approve`、`POST /api/pcb/approve` |
| `cp_execute` | execute | 执行已批准计划（唯一 `requestId` 幂等，绝不重放写） |
| `cp_validation` | execute | ERC / DRC / 六门门禁评估 + 证据引用 |
| `cp_export` | export | 生产导出（受写入门禁与审批约束） |
| `cp_job` | read | 进程内长任务 `status/wait/list/cancel` |

`tools/list` 额外带 `annotations`（`readOnlyHint`/`destructiveHint`/`openWorldHint:false`）
帮助宿主做安全提示；DSH 桥接不依赖它。

## 安全模型

1. **token**：只从 `--token-file`/`--token`（或对应 env）读取，只放在
   `x-circuitpilot-agent-token` 请求头里；不写日志、不写 MCP 响应、不出现在
   `--print-config` 中。
2. **审批**：`approvalMode=chat` 时 `cp_approve` 仍需 `confirm:true` 且 `planHash`
   必须是本进程 `cp_design_plan`/`cp_pcb_plan` 刚生成并缓存的计划；`cp_execute`
   必须找到未使用、未过期的批准。审批 token 只在进程内存，MCP 响应里只有
   `approvalId`，并显式标注 `approvalTokenExposed:false`。
3. **写门禁/路由**：Runtime 侧仍会校验 `writeGate.paused`、agent 路由白名单
   （对话审批仅放行 `POST /api/design/approve`、`POST /api/pcb/approve` 精确路径）等；
   MCP server 不能绕过，`AGENT_ROUTE_FORBIDDEN` 会作为业务错误返回。
4. **幂等**：写/长任务必须带调用方生成的唯一 `requestId`；同 `requestId` 返回同一
   job，不会重复执行。超时/取消/失败**不代表没生效**，下一步应先 `cp_status`/
   `cp_evidence` 核对，禁止自动重试写操作。
5. **结果裁剪**：每个工具结果在返回前已按 `maxResultBytes`（默认 16KB）裁剪并标记
   `truncated`；原始 DRC/ERC 大 JSON 不进模型上下文。
6. **HTTP 传输认证（可选）**：`--http-token-file`（0600 非空）或测试用 `--http-token`
   启用后，`/mcp` 请求必须带 Bearer/x header；用 SHA-256 + `timingSafeEqual` 常量时间
   比较；401 不执行 JSON-RPC；token 不落日志/响应，`--print-config` 只给
   `httpAuth`/`httpTokenFile`。默认（未配置）仍是仅 loopback 的旧行为。

## 限制与已知边界

- **无官方 SDK**：手写最小 JSON-RPC；只支持上表方法/通知，不支持 resources/prompts/
  sampling/logging/tasks 等能力。未来若根仓库引入 `@modelcontextprotocol/sdk`，可在
  不改工具层的前提下替换传输/协议层。
- **仅 legacy 协议**：现代 `2026-07-28+` 协议（`server/discover`、per-request `_meta`
  envelope、2026 wire 语义）未实现；DSH 的 auto 协商会自动回退到 legacy。
- **Streamable HTTP 是单会话/单客户端语义**：`Mcp-Session-Id` 只作会话标识、不作认证，
  且不实现 SSE 服务器推送；可启用内置 HTTP token 认证（`--http-token-file`），但多客户端
  并发共享、跨机访问仍建议额外网关/鉴权（默认只绑 `127.0.0.1`）。
- **job 表在进程内**：`cp_job` 查的是本 MCP server 进程的 JobManager，DSH 重启或
  MCP server 重连后 job 丢失；Runtime 侧的真实执行记录仍在 CircuitPilot 里，用
  `cp_status`/`cp_evidence` 核对，不要重放写。
- **不重启 DSH、不跑真实 EDA/Bridge**：测试全部使用 fake HTTP Runtime；接入真实
  CircuitPilot 需要在 DSH profile 里配置后由用户自行重载/重启 DSH 验证。
- `instructions` 是固定文本（约 1.3KB）；MCP 提示词模板（prompts）不受支持。

## 测试

```bash
# 全量（49 个用例：25 单测 + 12 stdio 集成 + 12 Streamable HTTP）
node --test "agent/__tests__/*.test.mjs"

# 分开跑
node --test agent/__tests__/mcp-server.test.mjs
node --test agent/__tests__/stdio-session.test.mjs
node --test agent/__tests__/mcp-http.test.mjs
```

### 额外离线验证（不属于仓库测试依赖）

本机无法安装 `@modelcontextprotocol/sdk`，但 DSH 自带 `@modelcontextprotocol/client@2.2.0`
（`@deepseek-ai/dsh-mcp-client` 的依赖）。开发时已从 DSH 的 asar 中提取该客户端做过一次
直连验证（不写入仓库、不作为 CI 依赖）：用官方 `Client` + `StdioClientTransport` 以
`versionNegotiation: { mode: 'auto' }` 启动本 server，成功完成
`server/discover(-32601) → initialize(2025-11-25) → tools/list(12) → cp_status → ping`，
并用官方 `InitializeResultSchema`、`ListToolsResultSchema`、`CallToolResultSchema`、
`JSONRPCErrorResponseSchema`/`JSONRPCResultResponseSchema` 校验所有响应均通过。
这说明 DSH 的 stdio auto 协商会正确回退到 legacy，且 MCP 载荷与官方 schema 兼容。

覆盖内容：

- **协议单测**（进程内注入 fake RuntimeClient）：legacy 版本回显/回落、`server/discover`
  返回 `-32601`、`ping`、非法 JSON `-32700`、JSON-RPC 基础校验 `-32600`、未知方法
  `-32601`、`tools/list` 恰好 12 个工具且 schema 为 object 根、未知工具/参数类型
  `-32602`、工具业务失败仍是 `ok:false` envelope（无 `isError`）、
  `notifications/cancelled` 中止且不响应、配置解析与环境变量/flag 优先级/非法输入。
- **Streamable HTTP 传输**（真实 node:http server + fake RuntimeClient，port 0）：
  initialize 200 + `application/json` + `Mcp-Session-Id` UUID、session 带/不带/错误值都接受、
  `tools/list` 12、`ping`、通知 202 空 body、畸形 JSON 400/`-32700`、8MB body 上限 413、
  `GET /mcp` 405、`DELETE /mcp` 204、`GET /health`、未知路径 404、`tools/call cp_status`
  返回 CallToolResult 且响应无 token、`close()` 幂等且端口可立即复用、CLI 配置解析。
- **stdio 集成**（真实 `node agent/mcp-server.mjs` 子进程 + fake HTTP Runtime）：
  DSH 式 `server/discover → initialize` 协商、工具发现、`cp_status` 真实 HTTP +
  token 头、token 文件缺失/401/5xx 的失败语义、`plan → approve(confirm) → execute →
  cp_job wait` 全链路（含审批 token 不出现在 stdout/stderr、同 `requestId` 幂等）、
  `--approval-mode off`、取消语义（底层 HTTP 被 abort 且无响应）、CLI 模式
  （`--help/--version/--print-config` 只写 stderr、退出码）、stdin EOF 干净退出、
  stdout 只含合法 JSON 行。

## 排障

| 现象 | 处理 |
|---|---|
| DSH 里没有任何 `mcp__circuitpilot__*` 工具 | 看 DSH 日志的 `mcp-client(circuitpilot)`；手动运行 server 看 stderr；确认 profile 路径、`node` 可用、token 文件存在 |
| `AGENT_TOKEN_MISSING` | token 文件不存在：启动 CircuitPilot 生成，或设置正确的 `CIRCUITPILOT_AGENT_TOKEN_FILE` |
| `AGENT_TOKEN_INVALID` / HTTP 401 | token 与 Runtime 不一致：删除旧 token 文件让 Runtime 重新生成，或使用正确的文件 |
| `RUNTIME_UNREACHABLE` | CircuitPilot 未启动/端口不对：确认 `CIRCUITPILOT_RUNTIME_URL` 指向运行中的 Runtime |
| `AGENT_ROUTE_FORBIDDEN`（403） | Runtime 未开放该 agent 路由：对话审批只能用批准路由；其他写操作走 CircuitPilot UI 或升级 Runtime |
| `APPROVAL_MODE_DISABLED` / `CONFIRM_REQUIRED` / `PLAN_NOT_KNOWN` | 审批模式为 `off`、没传 `confirm:true`、或 `planHash` 不是本会话刚生成并展示过的计划 |
| `CALL_CANCELLED` 或响应“消失” | 宿主取消了调用（MCP `notifications/cancelled`）：不代表 Runtime 没执行，先 `cp_status`/`cp_evidence` 核对 |
| stdout 出现非 JSON 行导致 DSH 报协议错误 | 说明有代码/依赖往 stdout 打日志；本 server 保证不写，检查是否有人替换了 `args` 或 `command` |
