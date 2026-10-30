# MCP server 独立复验（task-22）

对 `agent/mcp-server.mjs` 的独立复验：不采信作者单测（`agent/__tests__/*`）的结论，改用
**DSH 安装包内置的官方 MCP client**（`@modelcontextprotocol/client@2.2.0` + `StdioClientTransport`）
直连真实 server 子进程，并用裸 JSON-RPC 会话 + 官方 `@modelcontextprotocol/core` 的 zod schema
做 wire 级交叉校验。

**结论（二元）：PASS** — 22/22 通过；未发现需要修复的功能/安全 bug。

```
$ node --test "verification/agent/mcp/*.test.mjs"
ℹ tests 22
ℹ pass 22
ℹ fail 0
ℹ duration_ms ~3.8s
```

## 运行方式

```bash
# 仓库根目录执行；不需要安装任何依赖（SDK 从 DSH app.asar 只读解包到系统临时目录）
node --test "verification/agent/mcp/*.test.mjs"
```

可选环境变量：

| 变量 | 作用 |
| --- | --- |
| `DSH_ASAR` | 覆盖 DSH `app.asar` 路径（默认 macOS 安装路径） |
| `DSH_MCP_SDK_DIR` | 指向已解包的 `node_modules` 根目录（跳过解包，用于离线复跑） |

## 环境与边界

- macOS / Node **v24.14.0**；DSH 安装包：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（只读）。
- 官方 SDK 版本：`@modelcontextprotocol/client@2.2.0`、`@modelcontextprotocol/core@2.2.0`（从 asar 内 `dsh/node_modules` 解析依赖闭包，解包 1333 个文件 / ~12.6 MB 到 `mkdtemp` 临时目录，测试结束删除）。
- 不修改生产代码（只写 `verification/agent/mcp/**`）；不向仓库安装依赖。
- 不连接真实 CircuitPilot Runtime / EDA / 4178；每个用例自建 fake Runtime（127.0.0.1 随机端口）+ 临时 token 文件（`0600`，`cpa_` 随机值），不重启 DSH、不执行 git。

## 文件

| 文件 | 说明 |
| --- | --- |
| `dsh-sdk.mjs` | 解析 asar 头 → 静态解析 client 依赖闭包 → 解包到临时目录 → 动态 import 官方 Client/StdioClientTransport/core schema |
| `wire-proxy.mjs` | stdio 只读代理：把官方 Client ↔ server 的每行 JSON-RPC 落盘（JSONL），用于取证协商与取消 |
| `fake-runtime.mjs` | 最小 fake CircuitPilot Runtime（token 校验、cp_status 所需路由、500/409/大结果注入、请求 abort 记录） |
| `mcp-session.mjs` | 官方 Client 会话、裸 JSON-RPC 会话、临时 token、wire 日志解析、schema 断言等工具 |
| `protocol.test.mjs` | 官方 Client 端到端（9 个用例） |
| `wire.test.mjs` | 裸 JSON-RPC + 官方 schema + CLI 边界（7 个用例） |
| `business.test.mjs` | 业务边界（6 个用例） |

## 覆盖矩阵（对照 task-22 要求）

| 要求 | 验证方式 | 结果 |
| --- | --- | --- |
| `server/discover` → `-32601` → `initialize` 回退（官方 Client auto 协商） | server 请求/响应与 initialize 落在不同 pid；wire 日志时序可证；官方 Client 协商结果 `2025-11-25` | PASS |
| `tools/list` 恰好 12 个 | 官方 Client `listTools()` 名称集合与硬编码 12 名单一致，`ListToolsResultSchema` 通过 | PASS |
| `cp_status` 经 fake Runtime | 结构化 `CallToolResult`，项目/EDA/门禁字段正确，token 头正确，`CallToolResultSchema` 通过 | PASS |
| `ping` | 官方 Client `ping()` 返回 `{}`；裸会话中未初始化时也允许 `ping` | PASS |
| 官方 schema 校验 | `InitializeResultSchema` / `ListToolsResultSchema` / `CallToolResultSchema` / `JSONRPCErrorResponseSchema` 全部 safeParse 通过（官方 core zod） | PASS |
| 未知工具 `-32602` | 官方 Client reject `ProtocolError.code === -32602`，消息含“未知工具”，会话保持可用 | PASS |
| 重复 `initialize` `-32600` | 二次 initialize 返回 `-32600`，之后 ping/listTools 仍正常 | PASS |
| token 不泄漏 | 官方 Client + wire 代理全流程、裸会话（含错误路径）、CLI `--print-config/--version/--help` 均不含 token；server stdout 全为 JSON-RPC | PASS |
| 取消：无响应 + abort | `AbortSignal` 与裸 `notifications/cancelled` 两条路径：无该 id 的 JSON-RPC 响应、fake Runtime 观测到 HTTP 请求被 abort、stderr 记录“收到取消通知/已中止执行”、server 继续可服务 | PASS |
| 16KB 裁剪 | 大 evidence 索引（约 50×2.4KB）返回 `truncated=true`、`data._truncated=true`，envelope ≤ 16384 字节，证据列表被裁剪 | PASS |
| approve/execute 拒绝 | `approvalMode=off` → `APPROVAL_MODE_DISABLED` 且零 Runtime 请求；chat 模式：未知 planHash `PLAN_NOT_KNOWN`、`confirm=false` → `CONFIRM_REQUIRED`、缺 confirm/requestId → `INVALID_ARGUMENTS`、无批准执行 → `APPROVAL_REQUIRED` | PASS |
| 业务错误 envelope | Runtime 500 → `{ok:false,code:'INTERNAL_ERROR',message,nextActions}`；协议层仍为 success（无 `isError`）；写门禁暂停 → job 结果 `WRITE_PAUSED`，同 requestId 幂等不重放 | PASS |

## 关键取证细节

1. **协商时序**（官方 Client `versionNegotiation:{mode:'auto'}`）：
   - probe 进程 pid A：`in server/discover` → `out error -32601`（“本 server 实现 legacy（2025-era）协议”）；
   - 正式会话 pid B：`in initialize(protocolVersion=2025-11-25)` → `out result` → `notifications/initialized`；
   - 官方 Client 最终 `getNegotiatedProtocolVersion() === '2025-11-25'`，`serverInfo = {name:'circuitpilot-agent', version:'0.1.0'}`。
2. **12 个工具**：`cp_status, cp_project_context, cp_issues, cp_evidence, cp_knowledge, cp_design_plan, cp_pcb_plan, cp_approve, cp_execute, cp_validation, cp_export, cp_job`；每个 `inputSchema.type==='object'` 且 `properties` 为对象。
3. **协议错误码**：未初始化 `tools/list` → `-32600`；未知方法 → `-32601`；未知工具/坏参数 → `-32602`；二次 initialize → `-32600`；非法 JSON → `-32700`（无伪造 id）；JSON-RPC batch → `-32600`；缺 `jsonrpc` → `-32600`。
4. **取消**：`notifications/cancelled.params.requestId` 与在途 `tools/call` 的 id 一致；server 只 abort、不写响应；fake Runtime 通过 response close 观测到 `/api/health` 请求提前断开，证明取消穿透到 HTTP 层，而非仅丢弃响应。
5. **裁剪**：`capResult` 在 16384 字节上限下将 data 降级为 `{_truncated, bytes, preview}`，`content[0].text` 与 `structuredContent` 严格同源。

## 独立发现

- **无需修复的 bug：未发现。** 上述所有验收点行为符合 `docs/agent/agent-contract.md` 与 MCP legacy 语义。
- 观察项（非缺陷，供后续演进参考）：
  1. server 只实现 legacy（2025-era）子集；官方 2.2.0 Client 的默认协商模式是 `legacy`，其 `auto` 模式依赖 `server/discover` 返回 `-32601` 判定 legacy。如果未来 DSH 改用现代协议期望 `DiscoverResult`，此 server 需要跟进。
  2. `initialize` 收到未知/过新 `protocolVersion`（如 `2026-07-28`）时回落到默认 `2025-11-25` 而不是报错；官方 Client 可接受，但“静默降级”需要客户端能接受旧版本。
  3. 解析错误响应省略了 `id` 字段（不是 `id:null`）；JSON-RPC 2.0 允许 `null`，官方 Client 对无 id 错误不路由到请求，实测不影响会话。
  4. `--print-config` 会输出 `tokenFile` 路径（非 token 内容），属脱敏后配置，可接受。
  5. 工具的业务失败统一走 `CallToolResult.structuredContent` envelope，不设置 `isError`；与契约一致，但要求调用方（模型）读取 envelope 的 `ok/code`，不能只看协议错误。

## 未覆盖 / 限制

- 不使用真实 Runtime/EDA，因此 approve→execute 的**成功**写路径与真实审批令牌校验不在本复验范围（只验证拒绝/门禁/幂等分支）；不连接 4178。
- 只验证 stdio transport；HTTP/SSE transport 不在本 server 支持范围。
- 未做多客户端并发、长时间压力/内存 soak、Windows 平台验证。
- 取消的“底层 abort”通过 fake Runtime 的 socket 提前关闭观测；真实 Runtime/EDA 侧的中断行为未验证。
- `server/discover` 的现代协议返回体不做验证（server 明确不实现现代协议，这是设计边界而非缺陷）。

## 复跑与排障

- 首次运行会解析 `app.asar` 并解包 SDK（约 0.3s）；解包失败时检查 DSH 安装路径或设置 `DSH_ASAR`。
- 用例均为随机端口/随机 token/临时目录，可并行重复执行；`node --test` 每个测试文件独立进程。
- wire 取证日志位于每个用例的临时目录（`wire.jsonl`），用例失败时打印的断言信息会指出具体请求/响应行。
