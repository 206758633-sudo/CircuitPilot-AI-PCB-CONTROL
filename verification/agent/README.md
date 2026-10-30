# CircuitPilot Agent MVP 独立验证（verification/agent）

> 任务：task-19「Agent MVP 独立验证与安全测试」。只做验证，不改生产代码。
> 生产代码所有权：插件 `plugin/dsh-circuitpilot/**`、Runtime `runtime/**`、契约 `docs/agent/**` 均只读。
> 本目录只写 `verification/agent/**`。

## 1. 验证目标与边界

验证对象是 Agent MVP 的**可执行契约**（`docs/agent/agent-contract.md`）：

1. DSH 插件工具层（`plugin/dsh-circuitpilot/lib/{runtime,jobs,tools,projection}.mjs`）通过**真实 HTTP**
   调用 Runtime 关键路由的行为；
2. Runtime 的 agent token 认证（`runtime/agent-token.mjs`）与路由 denylist（`runtime/agent-auth.mjs`）在
   **纯函数层 + HTTP 层**都 fail-closed；
3. 审批/执行/幂等/裁剪/超时等安全语义；
4. `runtime/server.mjs` 的生产接线存在性（只读静态校验，不启动真实 Runtime）。

**明确不做**：不启动真实 CircuitPilot Runtime / 嘉立创 EDA / DSH 宿主，不连接 `127.0.0.1:4178`，
不读写 `~/Library`（token 一律临时目录或显式注入），不跑 git，不修改任何生产文件。

## 2. 文件

| 文件 | 作用 |
|---|---|
| `fake-runtime.mjs` | 本地 `node:http` fake Runtime：`127.0.0.1:0` 随机端口；模拟契约 §2 路由；认证/授权直接复用**真实** `runtime/agent-token.mjs` 与 `runtime/agent-auth.mjs`；approve 返回真实形态 `{approvalId, token, bindings:{planHash,targetFingerprint,windowId}}`；execute 校验 approvalToken 一次性；支持 401/409/500/延迟超时/超大 JSON/断连注入；记录所有请求；含工具 harness 与临时 token 文件工具函数 |
| `contract.test.mjs` | 10 个 `node:test` 用例：12 工具目录、参数校验、read happy path、统一结果 envelope、设计/PCB 闭环、16KB 裁剪、requestId 幂等、超时不自动重试、错误映射与脱敏 |
| `security.test.mjs` | 8 个 `node:test` 用例：无/坏 token、真实 token 签发与文件权限、agent-auth 纯函数 denylist（含编码/路径绕过）、HTTP 层越权 403、approvalToken 不暴露、agent token 不泄露、写暂停 409、超时写不重试、server.mjs 接线静态校验 |
| `acceptance.mjs` | 可执行验收脚本：10 条端到端场景，逐条打印 PASS/FAIL + 证据（fake Runtime 请求记录与关键结果字段），退出码 0/1 |
| `README.md` | 本文档 |

fake Runtime 支持的路由：`GET /api/health`（公开）、`/api/project-state`、`/api/issue-state`、
`/api/write-gate`（GET）、`/api/eda/workspaces/current`、`/api/evidence/index`、`/api/evidence/find`、
`/api/knowledge/entries`、`/api/design/context`、`/api/pcb/context`、
`POST /api/design/plan`、`/api/design/plan/ai`、`/api/pcb/plan`、`/api/design/approve`、
`/api/pcb/approve`、`/api/design/execute`、`/api/pcb/execute`、`/api/eda/schematic/erc/run`、
`/api/eda/pcb/drc/start`、`/api/eda/pcb/drc/report`、`/api/eda/gates/evaluate`、
`/api/production/export`、`/api/rag/query`，以及 `GET /api/design/executions/:id/evidence`。

## 3. 如何运行

在仓库根目录（注意路径含空格，命令整体加引号）：

```bash
node --test "verification/agent/*.test.mjs"
node verification/agent/acceptance.mjs
```

预期结果（2026-10-29 实测）：

- `node --test`：**18 tests / 18 pass / 0 fail**（contract 10 + security 8），约 1.1s；
- `acceptance.mjs`：**10/10 PASS，退出码 0**，输出每条场景的请求记录与关键字段；
- 基线复核：`node --test "plugin/dsh-circuitpilot/test/*.test.mjs"` → **60 tests pass**（生产插件自带用例）。

## 4. 覆盖矩阵

### contract.test.mjs（10）

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | 工具目录 | `TOOL_NAMES` 12 个、顺序稳定；type=read/plan/approve/execute 正确；schema 为 object；写/长任务 required 含 requestId；approve required 含 planHash+confirm；构造不产生请求 |
| 2 | 参数校验 | 11 组必填/类型/枚举/范围错误 → `INVALID_ARGUMENTS`，且 0 网络请求 |
| 3 | read happy path | `cp_status`/`cp_project_context` 聚合 health/project/write-gate/eda/issues/evidence；每个请求都带 `x-circuitpilot-agent-token` |
| 4 | issues/evidence/knowledge | 只统计 open/investigating 并按严重度排序；severity 过滤；索引/kind+digest/executionId 三种取证；只信 approved（candidate 不返回）；RAG 500 时标注 `ragError` 而不冒充 citation |
| 5 | 统一 envelope | 12 个工具成功/拒绝路径都有 `{ok,summary/data,evidence,nextActions,truncated}`（失败遵循契约 §5 的 `{ok:false,code,message}` 形态）且 JSON 可序列化 |
| 6 | 设计/PCB 闭环 | plan→approve（读 context、校验 bindings、请求体带 confirm/planHash/targetFingerprint/windowId）→execute（用内存 approvalToken + 缓存 plan，模型不可替换）→cp_job done→证据；PCB 审批无顶层 planHash 时按 `bindings.planHash` 绑定 |
| 7 | 16KB 裁剪 | 50 条大证据 → `truncated=true` 且 JSON ≤ 16384；自定义 `maxResultBytes=2048` 同样裁剪且保留下钻 evidence |
| 8 | requestId 幂等 | 同 requestId 返回同一 job 且 `deduped=true`；execute/ERC 实际只调用 1 次 |
| 9 | 超时 | job `state=timeout`、`mayHaveTakenEffect=true`、`error.code=JOB_TIMEOUT`；nextActions 明确禁止自动重试；等待后再等 800ms 仍只有 1 次 HTTP 写请求 |
| 10 | 错误映射/脱敏 | 401→`AGENT_TOKEN_INVALID`、409→保留 Runtime code+可执行 nextActions、500→提示日志；响应体里出现的 agent token 被 `[REDACTED]`；`maxResponseBytes` 超限返回 `RESPONSE_TOO_LARGE` 且不把大 body 带回模型 |

### security.test.mjs（8）

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | 身份认证 | token 文件缺失→本地 `AGENT_TOKEN_MISSING` 且不发请求；坏 token→HTTP 401 `AGENT_TOKEN_INVALID` 且错误不含 token；用生产 `ensureAgentTokenFile` 签发的临时文件（0600）可被接受，成功结果不回显 token |
| 2 | agent-auth 纯函数 | `POST /api/design|pcb/approve` 放行（含尾斜杠、`%61` 解码）；GET/PUT/子路径拒绝；signoff/reviews-final/order-confirmation/write-gate POST/settings/providers/research-config/diagnostics/download/agent-pair 全部拒绝；尾斜杠、单/双重 URL 编码、`..`、重复斜杠、query 掩盖、非法编码、非绝对路径、空方法均 fail-closed；`assertAgentRouteAllowed` 抛 403 `AGENT_ROUTE_FORBIDDEN` |
| 3 | HTTP 层越权 | 合法 agent token 调 7 条越权路由→403 `AGENT_ROUTE_FORBIDDEN`，`handledCount=0`（不进业务 handler），响应不含 token；GET write-gate / POST approve 仍 200；坏 token/无 token 先 401（认证先于授权，不泄露 denylist 细节） |
| 4 | approvalToken 不暴露 | cp_approve/cp_execute/cp_job list/错误结果 JSON 均不含 approvalToken；`approvalTokenExposed=false`；只有插件→Runtime 的 execute 请求体允许出现（内存通道） |
| 5 | agent token 不泄露 | 注入“错误 message 含 token”的 Runtime 500 → 工具错误已脱敏；所有请求 token 只在约定 header，path/query/body 均无 token |
| 6 | 写暂停 | cp_status 提示“写入已暂停/不要执行任何写操作”；execute → 409 `WRITE_PAUSED`，job 结果 nextActions 可执行且只请求 1 次 |
| 7 | 超时写 | export job 超时 `mayHaveTakenEffect=true`、nextActions 禁重试；等待 800ms 后仍只 1 次导出请求 |
| 8 | 生产接线 | 静态只读校验 `runtime/server.mjs`：导入 agent-token/agent-auth、`verifyAgentToken(request.headers[...])`、`assertAgentRouteAllowed(method, url.pathname)`，且认证+授权位于业务分发之前 |

### acceptance.mjs（10 场景）

1. 健康公开 + 受保护路由要求 agent token（无/坏 token → 401）
2. `cp_status` 汇总 Runtime/项目/EDA/写门禁/问题/证据
3. `cp_design_plan` 返回 planHash/ready/missing 与审批提示（只出计划）
4. `cp_approve` 必须 confirm=true + 本会话 planHash；approvalToken 不返回模型
5. 设计闭环 plan→approve→execute→cp_job 完成（证据/结果结构可核对）
6. approvalToken 一次性：Runtime 重放 409 `APPROVAL_CONSUMED`；插件复用已用批准 `APPROVAL_REQUIRED`
7. requestId 幂等：同 id 同一 job，execute 只 1 次
8. 16KB 结果裁剪（50 条大证据 → truncated、字节 ≤ 16384、保留 evidence）
9. 超时 mayHaveTakenEffect=true、不自动重试（写请求只 1 次）
10. 安全边界：signoff/write-gate POST/settings→403；写暂停 409 有可执行 nextActions 且不重试

## 5. 结论（本次验证）

- **契约验证 10/10 PASS，安全验证 8/8 PASS，验收 10/10 PASS → 验收结论：PASS。**
- 未发现生产代码缺陷；未发现 token（agent token / approvalToken）泄露到模型可见结果的路径。
- 生产插件自带 60 个单测基线全绿（只读复核，未修改）。
- 契约文档存在一处表述差异（已在测试中按文档 §5 处理，非缺陷）：成功结果有 `summary`，
  错误结果按 §5 为 `{ok:false, code, message, nextActions}` 不带 `summary`；`failResult` 实现与 §5 一致。

## 6. 未覆盖项（限制，需在真实环境补验）

| 未覆盖 | 原因 / 建议 |
|---|---|
| 真实嘉立创 EDA / Bridge / 写锁 / DRC 基线 / lineage 业务正确性 | fake Runtime 只模拟响应形状，不能证明真实 EDA 侧行为；需真机 E2E（另有人工验收清单） |
| 真实 `runtime/server.mjs` 进程（端口 4178）端到端 | 约束禁止启动真实 Runtime / 连接 4178；本目录用真实 auth 纯函数 + 静态接线校验替代，真实 server 层 401/403 应在集成环境复验 |
| DSH 宿主 `apply()`：`ctx.tools.register`、skill 注册、systemPrompt 注入、`@deepseek-ai/*` peer 解析 | 需要 DSH 实例；本目录仅 import host-independent `lib/**`，未执行 host 适配层 |
| 真机 UI 审批模式（未来 `approvalMode`）、macOS 钥匙串、真实默认 token 路径 `~/Library/Application Support/CircuitPilot` | 为避免触碰真实凭证，全部使用临时目录/显式 token；真实路径与权限行为未在本机执行 |
| 真实长任务（默认 120s DRC 轮询、真实导出耗时）、并发/多 Agent、性能 | fake 用毫秒级延迟模拟超时/完成；未做压力与并发一致性测试 |
| Runtime 侧 agent 审计日志落盘（谁在何时批准/执行） | server 侧审计属于真实进程行为，本次未验证落盘格式与不可抵赖性 |
| 真实 Runtime 的 409/500 语义细节（目标漂移、审批过期、写锁占用） | fake 注入的是形状级错误；真实错误码/文案与恢复建议需在真实 Runtime 上抽查 |

## 7. fake Runtime 用法（复用时注意）

```js
import { startFakeRuntime, createToolHarness } from './fake-runtime.mjs';

const runtime = await startFakeRuntime();                // 随机端口，token 默认 TEST_TOKEN
runtime.enqueue('POST /api/design/execute', {             // 一次性失败注入
  status: 409,
  body: { ok: false, error: { code: 'WRITE_PAUSED', message: '写入已暂停' } },
});
runtime.enqueue('GET /api/evidence/index', { delayMs: 500 });        // 超时
runtime.enqueue('GET /api/evidence/index', { jsonBytes: 4096 });     // 超大 JSON
runtime.setGate({ paused: true, reason: '写暂停' });                  // 写暂停
runtime.setLargeEvidence(50, 1200);                                 // 大结果（裁剪用）

const harness = await createToolHarness({ runtime, config: { jobTimeoutMs: 120 } });
const result = await harness.callTool('cp_status');
console.log(runtime.requests);   // 请求记录：method/path/query/body/headers/status/authorized/denied/handled
await harness.close();           // 取消在途 job 并关闭 http server
```

约束提醒：

- fake Runtime 的认证/授权调用的是**真实** `runtime/agent-token.mjs`、`runtime/agent-auth.mjs`，
  因此 401/403 用例验证的是生产函数；但业务路由响应仍是模拟数据，不能替代真实 Runtime 验证；
- 所有测试使用随机端口与 `mkdtemp`，不依赖固定 4178 端口、不读写真实用户目录；
- 若生产代码（插件/runtime）行为变更导致本目录用例失败，请由对应 owner 修改生产代码或更新契约，
  验证目录不替生产代码“兜底改测试”。
