# 第 61 轮 · 桥连通性错误的 HTTP 语义修复（400 → 503）

范围：`runtime/server.mjs` 的 HTTP 错误出口 + `runtime/__tests__/bridge.test.mjs` 的离线 HTTP 契约测试。
不涉及前端页面、安装包、真机 EDA 写操作。

## 1. 问题

第 60 轮真机演练记录（`product-fixes-round60-2026-10-21.md` 的"已知项"）：

> `BRIDGE_UNREACHABLE` 目前映射 HTTP 400（历史契约），语义上更像 503。

原因：`runtime/bridge.mjs` 抛出的连通性错误不带 `error.status`：

- `fetchJson` 网络层失败 → `BRIDGE_UNREACHABLE`；
- 请求预算内未返回（AbortError）→ `BRIDGE_TIMEOUT`；
- `requirePort()` 未发现桥 → `BRIDGE_NOT_FOUND`。

`server.mjs` 顶层 catch 原来写死 `error.status || 400` 兜底。于是 `/api/eda/*` 在桥暂时不可用时返回 **400 Bad Request** —— 把"服务暂时不可用、稍后重试即可"说成了"客户端请求写错了"，调用方很容易误判成参数问题而放弃重试。`BRIDGE_NOT_FOUND` 在 `ensureEdaSession` 等少数位置显式写了 `status: 503`，其余路径仍是 400，同一类故障状态码不一致。

## 2. 变更后契约

| 错误码 | 变更前 HTTP | 变更后 HTTP | 响应体变化 |
| --- | --- | --- | --- |
| `BRIDGE_UNREACHABLE` | 400 | **503** | 保留 `code`/`message`；新增 `error.retryable: true` |
| `BRIDGE_TIMEOUT` | 400 | **503** | 保留 `code`/`message`；新增 `error.retryable: true` |
| `BRIDGE_NOT_FOUND` | 503（部分路径显式） | **503（统一）** | 保留 `code`/`message`；**不加** `retryable` |
| 其它带显式 `error.status` 的错误 | 原状态码 | 原状态码（不变） | 不变 |
| 其它未标注状态的错误 | 400 | 400（不变） | 不变 |

`BRIDGE_NOT_FOUND` 不标记 `retryable`：它是"桥还没被启动/发现"，需要先连接 EDA，不属于"同一请求立即可重试"的瞬时故障；但它和另两个码一样是 503（服务不可用），前端仍可展示"重新连接 EDA"入口。

响应示例（桥断线时 `GET /api/eda/pcb/layers`）：

```json
{
  "ok": false,
  "error": {
    "code": "BRIDGE_UNREACHABLE",
    "message": "Bridge 不可达（fetch failed）：桥进程可能已随 EDA 退出",
    "retryable": true
  }
}
```

## 3. 实现

`runtime/server.mjs`：

- 新增 `BRIDGE_UNAVAILABLE_CODES = {BRIDGE_UNREACHABLE, BRIDGE_TIMEOUT, BRIDGE_NOT_FOUND}` 与 `BRIDGE_RETRYABLE_CODES = {BRIDGE_UNREACHABLE, BRIDGE_TIMEOUT}`。
- 新增 `httpStatusForError(error)`：**显式 `error.status` 永远优先**，其次桥连通性码 → 503，其余 → 400（与历史行为一致）。
- 顶层 catch 改为 `sendJson(response, httpStatusForError(error), runtimeError(error), origin)`；`runtimeError()` 对瞬时故障追加 `error.retryable: true`。

没有逐路由改代码：所有未自行吞掉/改写的桥错误都经过同一个顶层出口，包括：

- 直连 `bridge.windows()` / `bridge.execute()` 的只读路由（如 `GET /api/eda/windows`）；
- 走 `ensureEdaSession()` 先 discover 再访问桥的路由（如 `GET /api/eda/pcb/layers`、`GET /api/eda/pcb/drc/exemptions`）；
- 写路由里由桥抛出的连通性错误（写命令本身仍不会被运行时自动重试，这一点由 `bridge.mjs` 保证，本轮未改）。

## 4. 影响的路由

所有可能因桥不可用而失败的 `/api/eda/*`（以及经 `ensureEdaSession()`/`bridge.*` 访问 EDA 的 PCB/DRC/ERC/网表/仿真导出等路由）。其中：

- **只读 GET**：客户端可在 503 后安全重试；
- **写 POST/PUT**：503 表示"这次没写成功"（桥不可达时请求根本没到 EDA），但**重试写请求仍需重新走批准/绑定流程**，不要因为看到 503 就出于"反正可重试"而自动重放写动作。

## 5. 兼容性说明（旧 400 依赖方）

- `src/services/runtimeClient.ts` 把非 2xx 统一转成 `RuntimeApiError(code, message, status)`，没有针对 400 的桥错误分支；前端展示错误码/文案，因此不受状态码变化影响。
- 检查过 `src/`、`scripts/`、`e2e/`：没有代码依赖"桥错误必须是 400"。唯一出现的桥错误码是 `src/pages/EdaPage.tsx` 的本地 `BRIDGE_NOT_FOUND` 常量（发现页自检，不走 HTTP 状态码）。
- 对已有外部脚本的残余风险：若有调用方以 `status === 400` 判定"桥没连上"，需要改为判定 `status === 503` 或 `error.code`。仓库内没有这种调用方；这是本次唯一的破坏性契约变更，已在本文件与第 60 轮记录之间建立对应关系。
- 未纳入本次映射的已知例外（有意保留域语义，不在本任务放大改动）：
  - `POST /api/eda/schematic/simulation/run` 在网表导出阶段把桥异常重包成 `SIMULATION_NETLIST_EXPORT_FAILED`（409）；
  - `POST /api/eda/gui/capabilities/probe` 的 GUI/CDP 失败已是 503（`GUI_CAPABILITY_PROBE_FAILED`）。
  这两条的 `error.code` 都变了，调用方按 code 处理；若后续希望它们也透传桥码，应单独立项，避免与本次"统一出口"混在一起。

## 6. 测试证据（离线，不依赖真机）

命令：

```bash
node --test --test-timeout=120000 \
  runtime/__tests__/route-contract.test.mjs \
  runtime/__tests__/bridge.test.mjs
```

结果：`tests 42 / pass 42 / fail 0`（`route-contract` 5 条 + `bridge` 37 条，含本轮新增 4 条 HTTP 契约用例，耗时约 2.4s）。

新增用例（`runtime/__tests__/bridge.test.mjs`，用 `createRuntimeServer({ bridge: 假桥 })` 起真实 HTTP 服务，状态/证据目录隔离到临时目录）：

1. 桥不可达：`GET /api/eda/windows`（直连桥）与 `GET /api/eda/pcb/layers`（经 `ensureEdaSession`）都返回 **503**，`error.code === 'BRIDGE_UNREACHABLE'`、原文案保留、`error.retryable === true`；
2. 桥超时：只读路由返回 **503** + `BRIDGE_TIMEOUT` + `retryable: true`；
3. 桥未发现：`port=null` 且 discover 落空 → **503** `BRIDGE_NOT_FOUND`（契约不变），且**没有** `retryable` 字段；
4. 映射不放大：未知路由仍 404 `ROUTE_NOT_FOUND`；`POST /api/eda/pcb/layers` 非法层数仍 400 `EDA_COMMAND_ARGS_INVALID`。

回归覆盖：第 60 轮的桥自愈行为（读命令重连/写命令不重试、`windows()` 自动重发现）在 `bridge.test.mjs` 原有用例中继续通过（37 条全绿），说明"把状态码改成 503"没有改动桥层重试语义。

未做真机演练（本轮不操作 EDA）：桥进程被杀的实机行为由第 60 轮证据 `artifacts/evidence/session-restore-2026-10-21/real-machine-bridge-selfheal.json` 记录，本轮只变更映射层，离线契约测试足以锁住 HTTP 语义。

## 7. 复现与核验

```bash
# 离线契约
node --test --test-timeout=120000 runtime/__tests__/bridge.test.mjs

# 真机（可选，需要 EDA + 桥在跑）：杀掉桥进程后
curl -s -o /dev/null -w '%{http_code}\n' -H "x-circuitpilot-token: $TOKEN" \
  http://127.0.0.1:4178/api/eda/windows    # 期望 503（此前为 400）
```
