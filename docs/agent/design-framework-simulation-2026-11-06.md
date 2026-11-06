# 复合设计框架 · 模拟验收报告（2026-11-06）

> 结论：**单元测试 + 真实 HTTP + 真实 DSH 宿主 + 真实 MCP stdio 四层模拟均通过**；
> 关键 fail-closed 路径（不兼容 Runtime、超大模型、未认证、非法 JSON）逐条验证。
> 本轮**没有**触碰用户正在运行的 App / 4178 / 真实 EDA，全部使用隔离 Runtime 与临时目录。

## 0. 环境

| 项 | 值 |
|---|---|
| 机器时间 | 2026-11-06 16:08–16:13 Asia/Shanghai |
| DSH / 插件 | DSH 0.2.1-rc.5；dsh-circuitpilot v0.2.0（13 个工具） |
| Runtime | 隔离 `node runtime/server.mjs`（临时 state/evidence/token、随机端口） |
| 外部工具 | `kicad-cli` / ortools / z3 / shapely 本机均不可用（适配器如实报告 unavailable） |
| 未触碰 | 用户 4178 Runtime、正在运行的 DSH GUI、真实 EDA 工程 |

---

## 1. 单测基线（全绿）

| 套件 | 结果 |
|---|---|
| 插件 `plugin/dsh-circuitpilot`（含 13 工具） | **208 / 208** |
| 设计框架 `runtime/__tests__/design-framework*.test.mjs`（含服务层） | **77 / 77** |
| MCP agent `agent/__tests__/*.test.mjs` | **49 / 49** |
| 路由契约 + agent 授权 | **17 / 17** |
| `npm run typecheck` | 通过 |

---

## 2. HTTP 模拟验收（隔离 Runtime，真实 HTTP）

脚本：`scripts/design-framework-sim.mjs`（可重复执行；自动起隔离 Runtime → 跑矩阵 → 清理）
证据：`artifacts/design-framework-sim-2026-11-06.json` → **13/13 通过**

| # | 断言 | 结果 |
|---|---|---|
| 1 | `GET /api/design/framework/status`：schemaVersion=1，外部工具 available=false | ✔ |
| 2 | `GET /api/design/framework/golden`：5/5 金板、failed=0 | ✔ |
| 3 | `POST run` · fixable-overlap → needs-review、blocking=0、repair≥1 | ✔ |
| 4 | `POST run` · already-good → needs-review、repair=0 | ✔ |
| 5 | `POST run` · stackup-needed → 自动补叠层（solve_stackup） | ✔ |
| 6 | `POST run` · blocked-size-unknown → blocked（fail-closed） | ✔ |
| 7 | `POST run` · blocked-netlist-short → blocked（电气意图不自动改） | ✔ |
| 8 | 确定性：同输入两次 run 的 digest 相同（64 hex） | ✔ |
| 9 | 非法模型 → **400** `DESIGN_FRAMEWORK_RUN_FAILED` | ✔ |
| 10 | 超大模型（>200KB）→ **413** `DESIGN_FRAMEWORK_MODEL_TOO_LARGE` | ✔ |
| 11 | 未认证请求 → **401/403**，不执行 | ✔ |
| 12 | 非法 JSON body → **400**，Runtime 不崩、后续请求仍可用 | ✔ |
| 13 | 响应不含 agent token / `cpa_` 前缀（token 不泄漏） | ✔ |

复现：
```bash
node scripts/design-framework-sim.mjs --out artifacts/design-framework-sim-2026-11-06.json
```

---

## 3. 真实 DSH 宿主模拟（插件 13 工具 + cp_design_loop）

方式：隔离 `DSH_HOME=.tmp/dsh-verify-home`、profile `cp-verify`（headless 模板 + `link:` 插件 +
验收探针 bundle），插件指向隔离 Runtime（4193）；探针在宿主内读取真实 ToolRegistry 并
通过 `ctx.tools.execute()` 调用工具。

证据：`artifacts/design-framework-dsh-host-sim-2026-11-06.json`

| 验收项 | 结果 |
|---|---|
| 插件门禁/激活 | ✔ 无 `skipping bundle` / `did not activate`，启动仅停在缺模型凭据 |
| 工具注册 | ✔ 宿主共 38 个工具，其中 **13 个 cp_***（含 `cp_design_loop`） |
| `cp_status` | ✔ ok:true，Runtime 0.2.0 在线 |
| `cp_design_loop` | ✔ 宿主内真实调用成功：`status=needs-review`、迭代 2、repair=1、blocking=0、review=144、规则覆盖 21.2% |
| 注册契约 | ✔ `cp_design_loop` 具备 `parameters` + `output{schema,render}`（rc.5 native/mcp 定义） |

> 摘要原文：`设计闭环（离线）：status=needs-review · 迭代 2 · 修复 1 · blocking 0 · review 144 · 规则覆盖 21.2%；需人工审阅（review 项无法机器判定，不是 passed）`

---

## 4. MCP stdio 模拟（agent 端到端）

脚本（临时）：`.tmp/sim/mcp-sim.mjs` —— 真实 spawn `agent/mcp-server.mjs`，走 NDJSON JSON-RPC。
证据：`artifacts/design-framework-mcp-sim-2026-11-06.json` → **6/6 通过**

| 场景 | 断言 | 结果 |
|---|---|---|
| 真实 Runtime 0.2.0 | `initialize` 成功 | ✔ |
| 真实 Runtime 0.2.0 | `tools/list` = **13** 且含 `cp_design_loop` | ✔ |
| 真实 Runtime 0.2.0 | `tools/call cp_design_loop` → needs-review / blocking=0 / repair=1 | ✔ |
| 安全 | MCP stdout 不含 `cpa_`/token | ✔ |
| 不兼容 Runtime 0.8.15（fake） | `cp_design_loop` → `ok:false`、`RUNTIME_VERSION_UNSUPPORTED`、不返回 404 洪水 | ✔ |
| 超大 model（210KB） | 插件本地 `DESIGN_MODEL_TOO_LARGE`，不请求 Runtime | ✔ |

---

## 5. 安全 / 确定性 / 边界复核

- **安全**：未认证拒绝；响应无 token；工具仍受 16KB 裁剪；`cp_design_loop` 为 `read` 类型，
  不进入 `cp_approve/cp_execute` 写链路；Runtime 路由不写 EDA。
- **确定性**：同一 IR 两次闭环 digest 一致；金板评估两次 metrics 一致。
- **fail-closed**：不兼容 Runtime、超大/非法模型、缺失外部工具、不可修复布局/网表均返回结构化失败，
  没有一次"假 passed"。
- **未覆盖（如实保留）**：
  1. 真实 EDA 写链路未执行（模拟不写板，符合安全边界）；
  2. 真实 KiCad CLI DRC 未验证（本机未安装，仅伪 CLI 单测 + 适配器 fail-closed）；
  3. UI 页面尚未接入设计框架（client 方法/类型已就绪）；
  4. `cp_design_loop` 的模型来源仍是调用方传入 IR（未从项目/EDA 自动构建）。

---

## 6. 复现命令汇总

```bash
cd "/Users/jescochen/Desktop/AI- PCBA"

# 1) 单测
(cd plugin/dsh-circuitpilot && node --test "test/*.test.mjs")   # 208
npm run test:design-framework                                   # 77
node --test "agent/__tests__/*.test.mjs"                        # 49
node --test runtime/__tests__/agent-auth.test.mjs runtime/__tests__/route-contract.test.mjs  # 17
npm run typecheck

# 2) HTTP 模拟验收（自动起隔离 Runtime）
node scripts/design-framework-sim.mjs --out artifacts/design-framework-sim-2026-11-06.json

# 3) DSH 宿主模拟（隔离 profile，需先起隔离 Runtime 4193 并更新 profile patch）
DSH_HOME="$PWD/.tmp/dsh-verify-home" \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile cp-verify "回答 OK"

# 4) MCP stdio 模拟
node .tmp/sim/mcp-sim.mjs
```
