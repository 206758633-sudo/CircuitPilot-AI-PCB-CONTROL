# 真机 E2E 运行手册（F1）

> 真机用例默认 **skip**：本机没有嘉立创EDA/桥/Runtime 时硬跑只会产生"假失败"。
> 本手册的目标是：**一条命令可复现**、失败能定位到证据、CI 不会被真机依赖卡住。

## 1. 前置条件（缺一不可）

| 条件 | 检查方式 | 备注 |
| --- | --- | --- |
| 嘉立创EDA 专业版已打开目标工程 | 手工确认 | 本机验证版本：EDA 3.2.186 |
| EDA 已开启远程调试（CDP 9222） | `curl -s http://127.0.0.1:9222/json/version` | GUI 兜底通道依赖它 |
| EasyEDA Bridge 已启动 | `curl -s http://127.0.0.1:49620/api/eda/discover` | 只读发现即可 |
| 工作区 Runtime 跑在 4179 | `curl -s -H "x-circuitpilot-token: $TOKEN" http://127.0.0.1:4179/api/health` | 必须用工作区代码启动，不要用已安装 App 的旧 Runtime |
| 前端 dev server（Playwright webServer 可代起） | `npm run dev -- --port 4177` | 或用 `BASE_URL` 指定 |

启动 Runtime（推荐受管后台进程，避免随 shell 退出被杀）：

```bash
CIRCUITPILOT_RUNTIME_PORT=4179 \
CIRCUITPILOT_RUNTIME_TOKEN="$(cat /tmp/cp_my_token.txt)" \
node runtime/server.mjs
```

## 2. 运行真机用例

```bash
# 只跑真机布局用例
CP_LIVE_EDA_E2E=1 VITE_RUNTIME_URL=http://127.0.0.1:4179 \
  npx playwright test e2e/placement-live.spec.ts

# 只跑真机同步验收用例
CP_LIVE_EDA_E2E=1 VITE_RUNTIME_URL=http://127.0.0.1:4179 \
  npx playwright test e2e/sync-verify-live.spec.ts

# 全量（真机用例默认 skip，仍会跑非 live 用例）
npx playwright test
```

**环境变量**

| 变量 | 作用 |
| --- | --- |
| `CP_LIVE_EDA_E2E=1` | 真机开关；不设时两个 live spec 全部 skip，**不会假装通过** |
| `VITE_RUNTIME_URL` | 前端请求的 Runtime 地址（默认 4178；真机必须指到 4179 的工作区实例） |
| `BASE_URL` | Playwright 页面地址（默认读 `.auto-coding/allocated-ports.json` 或 4177） |

> 真机用例的 `beforeEach` 会把 `127.0.0.1:4178/api/**` 改写到 4179，防止测试打到已安装 App 的旧 Runtime（那是最危险的假绿）。

## 3. 失败时看哪里

| 证据 | 路径 | 说明 |
| --- | --- | --- |
| 失败截图 | `test-results/<spec>/test-failed-1.png` | `screenshot: only-on-failure` |
| 首次重试 trace | `test-results/<spec>/trace.zip` | `trace: on-first-retry`；`npx playwright show-trace <zip>` |
| HTML 报告 | `playwright-report/index.html` | `npx playwright show-report` |
| Runtime 侧证据 | `artifacts/`（DRC/导出/截图/验收报告） | 以页面/接口返回的证据路径为准 |
| 自动化 run 日志 | `artifacts/automation-runs/*.jsonl` | 哈希链 journal，可核对步骤与批准 ID |

失败必须先归类，再决定重试：

1. **环境类**（EDA 未开/桥未启动/端口不对）→ 修环境，不算产品失败；
2. **指纹漂移 409**（`TARGET_DRIFT`/`AUTOMATION_APPROVAL_INVALID`）→ 重新签发批准，不是 bug；
3. **真实产品失败** → 保留 runId + 证据路径，按 `docs/implementation/circuitpilot-task-plan.md` 建修复任务，**不得**改断言放宽成通过。

## 4. 已知限制（写清楚，避免误判）

- `e2e/placement-live.spec.ts` 依赖「验证与交付」页的「布局微调」子 tab；导航/标题改动要同步更新 selector（历史已踩坑：`nav-placement` 已改为 `nav-validation`）。
- `e2e/sync-verify-live.spec.ts` 只验证「如实报缺件 + 锁自动布局」，不代表 PCB 落板已打通。
- 真机 DRC 可能跑 2 分钟以上，单用例超时已配到 240s；不要用默认 45s。
- 桥偶发 `BRIDGE_HTTP_ERROR`/`EDA_REQUEST_ABANDONED`：读命令可重试，**写命令必须先读回确认**再决定是否重试（见失败诊断库 E12）。

## 5. CI 约定

- CI **只跑非 live**：`npx playwright test`（live 用例自动 skip）。
- 真机验收由人/授权代理在本机按本手册执行，产物归档到 `artifacts/`；`npm run acceptance` 的真机段默认 SKIPPED，不伪装 PASS。

## 6. 证据归档（F2）

- **自动**：设置 `CP_LIVE_EDA_E2E=1` 跑 Playwright 时，`e2e/global-teardown.ts` 在整轮结束后把 `test-results/`、`playwright-report/`、自动化 journal 目录（`CIRCUITPILOT_AUTOMATION_DIR` 或 `~/.circuitpilot/automation-runs`）归档到 `artifacts/live-evidence/<timestamp>/`，并写 `manifest.json`（逐文件 sha256 / 字节数 / 缺失来源）。归档失败只 warn，不影响测试结论。
- **手动/CI**：`npm run archive:live-evidence`（可加 `--run-id`、`--out`、`--source` 多次）。一条文件都没归档时退出码 **2**——空归档不会被当成成功。
- 校验：打开 `artifacts/live-evidence/<id>/manifest.json`，`summary.files > 0` 且 `missing` 为空/已解释；任何文件哈希能被 `sha256` 复核。
- 注意：上方"自动化 run 日志"路径按 `CIRCUITPILOT_AUTOMATION_DIR` 覆盖，默认 `~/.circuitpilot/automation-runs`（不是仓库内 `artifacts/automation-runs`）。
