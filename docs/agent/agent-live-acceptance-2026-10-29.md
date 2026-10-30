# Agent 控制面真机验收记录（2026-10-29）

> 结论：**Runtime 0.2.0 + 真实 UI + 真实 MCP 12 工具已打通并复验**；**真实 EDA 只读 DRC/ERC 已通过实验适配器验证**（DRC 0、ERC 1 warning；验证后适配器已停止），**真实写板/签核/导出未执行**；**真实 DSH 宿主已能激活插件并完成真实模型驱动的 `cp_status` 工具调用**（`tokenfens/deepseek-flash`，证据 `artifacts/agent-dsh-live-toolcall.json`）。以下只写实际跑过的证据，不把临时 Runtime 结果冒充桌面壳结果。

## 1. 环境与构建

| 项 | 值 |
|---|---|
| 机器时间 | 2026-10-29 17:30–19:11 Asia/Shanghai |
| 修复前 | `127.0.0.1:4178` 为 `/Applications/CircuitPilot.app` **0.2.1**，无 `agent-token.json` |
| 新构建 | `npm run desktop:app` → exit 0；产物 `src-tauri/target/release/bundle/macos/CircuitPilot.app` |
| 启动方式 | 退出旧 app 后启动新 bundle；Runtime `0.2.0`，`agent-token.json` 已生成（0600，210B） |
| 桌面 app PID | 旧进程 74650（17:35 启动，已退出）；新进程 30796（19:06 从工作区 bundle 启动） |

> 注意：新 app 目前从工作区 bundle 启动，不是重新安装到 `/Applications`；用户下次可直接启动该 bundle 做验收。

## 2. 真实 Runtime 9/9（手动启动的 4178 + 工作区状态）

DSH 文件沙箱只允许写工作区，直接对桌面 Runtime 的 `~/Library/Application Support/CircuitPilot` 写审计会 `EPERM`；因此真机 Runtime 验收使用工作区状态目录启动同一份 `runtime/server.mjs`：

```bash
CIRCUITPILOT_STATE_DIR="$PWD/.tmp/real-accept-state" \
CIRCUITPILOT_EVIDENCE_DIR="$PWD/.tmp/real-accept-evidence" \
CIRCUITPILOT_AUTOMATION_DIR="$PWD/.tmp/real-accept-automation" \
CIRCUITPILOT_AGENT_TOKEN_FILE="$PWD/.tmp/real-accept-state/agent-token.json" \
node runtime/server.mjs
```

```bash
CIRCUITPILOT_AGENT_TOKEN_FILE="$PWD/.tmp/real-accept-state/agent-token.json" \
  npm run verify:agent-live -- --base-url http://127.0.0.1:4178
```

结果：

```text
[PASS] 1. Runtime /api/health 就绪且可取得 UI 会话令牌 — version=0.2.0 token=health.sessionProof
[PASS] 2. UI GET /api/agent/status：200 且 agent.available=true — scopes=read|plan|execute
[PASS] 3. UI status 响应不包含 agent token / 审计密钥 — payload=400B
[PASS] 4. Agent GET /api/agent/status：200
[PASS] 5. Agent GET audit / POST rotate：403 AGENT_ROUTE_FORBIDDEN
[PASS] 6. Agent POST design/approve 缺 confirm：403 AGENT_APPROVAL_CONFIRMATION_REQUIRED
[PASS] 7. 越权/审批尝试产生审计事件 — events=3 kinds=denied|request
[PASS] 8. UI GET audit：200、ok、anchored=true、无 token/key — events=3 verified=3
[PASS] 9. UI rotate：200；旧 token 401 / 新 token 200

PASS 9/9  exit 0
```

## 3. 真实 UI 深链/控制台 E2E（1/1 PASS）

Vite `127.0.0.1:4177`（`VITE_RUNTIME_URL=http://127.0.0.1:4178`）直连上述真实 Runtime：

```bash
npx playwright test e2e/agent-console-deeplink.spec.ts --reporter=list
```

结果：**1 passed**。页面实际读取均为 200：

```text
/api/health 200
/api/agent/status 200
/api/agent/audit?limit=8 200
/api/approvals/ledger 200
/api/agent/approvals 200
```

断言覆盖：
- `?agent=approvals#settings` 深链存在 `#agent-access` / `#agent-approvals` / `#agent-ledger`
- 真实令牌可用、`审计链完整`、`已锚定`、`最近 Agent 调用`
- 待执行批准空态、批准账本区
- 页面文本不含 `cpa_...` 令牌与 `agent-audit.key`
- 无 pageerror

截图：`artifacts/agent-console-real.png`（1280×3665，全页）。

## 4. 真实 MCP 12 工具

### 4.1 对真实 Runtime（手动 4178）

```bash
node agent/mcp-server.mjs --http --http-port 4186 \
  --runtime-url http://127.0.0.1:4178 \
  --token-file "$PWD/.tmp/real-accept-state/agent-token.json" --approval-mode chat
```

调用结果：`initialize` 200；`tools/list` **12** 工具；`cp_status` / `cp_project_context` / `cp_issues` 均 `ok:true`；`cpa_`/`agent-audit.key` 未泄漏。

### 4.2 对桌面 app Runtime（真实 token 文件）

```bash
node agent/mcp-server.mjs --http --http-port 4186 \
  --runtime-url http://127.0.0.1:4178 \
  --token-file "$HOME/Library/Application Support/CircuitPilot/agent-token.json" \
  --approval-mode chat
```

结果：`tools/list` **12**；`cp_status` 返回真实项目「衣橱助手V2.0 测试板」、Runtime 0.2.0 在线、**EDA 未绑定/不可用**；`cp_project_context` 项目数 4、未收口问题 9；`cp_issues` 9 条；`cp_knowledge` `approved 知识 0 条`。均无 `ok:false` 假通过。

## 5. 桌面壳的 `--base-url` 验收限制

桌面 Tauri 由壳层随机生成 UI 会话令牌并通过 stdin 注入 Runtime，`/api/health` 按设计**不发放 sessionProof**；外部 shell 的 `verify:agent-live --base-url` 无法取得 UI 令牌。修复了脚本的错误提示顺序后，现在返回明确提示：

```text
✖ 无法取得 UI 会话令牌：/api/health 未发放 sessionProof（桌面版注入了令牌），且未设置 CIRCUITPILOT_RUNTIME_TOKEN。
```

这**不是**旧 Runtime；桌面壳内的 Agent 面板使用注入令牌可正常调用 `/api/agent/status`（MCP 用 agent token 已验证）。完整 9/9 需要对开发 Runtime 跑，或在启动 Runtime 的终端导出 `CIRCUITPILOT_RUNTIME_TOKEN`。

## 5.1 真实 DSH 宿主启动：发现并修复插件激活错误

在隔离 `DSH_HOME=.tmp/dsh-host` 中用 `--from-default-profile headless` 创建 `cp-agent` profile，安装插件后启动：

```bash
DSH_HOME="$PWD/.tmp/dsh-host" dsh --profile cp-agent "调用 cp_status..."
```

首次真实启动失败：

```text
dsh: warning: 1 entry did not activate
dsh-circuitpilot (dsh-circuitpilot): TypeError: Invalid effect
```

根因：`plugin/dsh-circuitpilot/index.mjs` 的 `apply` 返回了 `{ tools, dispose }` 普通对象；cordis 会把 `apply` 返回值当 effect，普通对象触发 `Invalid effect`。已改为返回 `undefined`，清理统一走 `ctx.effect`。修复后同一 profile 启动不再出现 “entry did not activate / Invalid effect”，进入模型鉴权阶段；隔离 profile 没有 `TOKENFENS_API_KEY`，因此只到 `MISSING_CREDENTIAL`（用 dummy key 则 401）。**随后用复制 desktop provider 配置的 `cp-live-headless` + 临时注入的 tokenfens 凭据完成真实调用**，见 §5.3。

## 6. 仍未验证（必须如实保留）

1. **真实 DSH 宿主加载插件（部分完成）**：`cp-live-headless` 已真实加载插件、Skill，并由模型调用 `cp_status`（见 §5.3）；desktop profile 已安装插件但尚未重启 Electron 复验工具列表；DSH 内计划/审批/写链路未执行（当时 EDA 离线；后续只读适配器已通，但 DSH 内写链路仍未执行）。
2. **真实 EDA 写板/DRC/签核/导出**：验证时 `cp_status` 显示 EDA 在线（实验适配器），真实 DRC 0、ERC 1 warning；**适配器已停止，当前恢复离线**。真实写板/回滚/签核/导出仍未执行。
3. **桌面壳内的 UI 截图/端到端**：用同代码 Vite UI + 真实 Runtime 验证；Tauri 壳的注入令牌路径只做了 token/Agent/MCP 级验证。
4. **真实 DSH profile 的 token 轮换后自动读取**：逻辑在插件里，未在 live DSH 会话复验。
5. 桌面 app 新 bundle 未覆盖安装到 `/Applications`，避免影响用户旧安装；用户可手工替换。

## 7. 本轮新增/修复

- `e2e/agent-console-deeplink.spec.ts`：真实 Runtime UI 深链/控制台 e2e（1/1）。
- `scripts/agent-live-acceptance.mjs`：先判断“无 UI token”，再判断“旧 Runtime 404”，避免把桌面壳误报为旧 Runtime。
- 新 app 构建 + 启动 + token 生成；4178 已从 0.2.1 升级到 0.2.0。

## 5.2 计划级待审批队列真实验收（2026-10-29 18:10）

为验证“Agent 登记计划 → UI 逐条批准/拒绝 → Agent 仍需 cp_approve”的完整链路，启动隔离 Runtime（`CIRCUITPILOT_RUNTIME_PORT=4186`、临时 state/token、无固定 UI token），Vite 4177 指向它，不连 4178/EDA。

- 真实 HTTP 矩阵 **14/14 PASS**：Agent 创建 `apr_` 请求、Agent GET/decision 403、UI GET/decision 200、缺 `confirm` 400、二次 decision 409、EDA 离线时带 `approvalRequestId` 的 approve 失败且请求回滚为 `approved`、state 0600、持久化无 token、旧 approve 路径不受影响。
- 真实 UI：创建 design/pcb 两条 pending；`/?agent=plans#settings` 显示计划队列；批准第一条（确认弹窗明确“UI 只记录人工决定，不会签发 token”），行变为“已批准（等待 Agent）”；拒绝第二条，行移除且后端为 `rejected`。
- 证据：`artifacts/agent-plan-queue-real.png`；同轮真实 Runtime 的 Agent 控制台 e2e 也复跑 **1/1 PASS**（`artifacts/agent-console-real.png`，隔离 4186 Runtime，审计链完整/已锚定）。
- 仍不包含：从 UI 批准直接触发执行；当前执行仍需 Agent `cp_approve` → `cp_execute`。

## 7.1 本轮新增/修复（计划级队列）

- `runtime/plan-requests.mjs` + server 路由 + `agent-auth` 精确放行 + 12 个后端测试。
- 插件 `requestApproval` / `approvalRequestId` 自动携带 + 6 个插件测试。
- UI `#agent-plan-requests` 队列、`?agent=plans` 深链、批准/拒绝二次确认 + 3 个面板测试。
- 真实验收脚本/证据见 `.auto-coding/testing/reports/20261029_plan-queue.md`。

## 5.3 真实 DSH 对话工具调用（2026-10-29 18:30）

目标：不只用 fake ctx 证明插件激活，而是让真实 DSH 模型在对话里自动选择并调用 `cp_*`。

做法：

1. 在 desktop profile 安装 `dsh-circuitpilot`（`dsh plugin --profile desktop add link:$PWD/plugin/dsh-circuitpilot`），使真实桌面宿主下次重启可加载。
2. 复制 desktop 的 provider/model 配置到 `cp-live-headless`（headless 模板 + `@deepseek-ai/dsh-llm-pi-ai` 的 tokenfens provider + `@deepseek-ai/dsh-agent-default-model` = `tokenfens/deepseek-flash`），安装插件；凭据仅通过启动环境临时注入，不写入仓库。
3. 执行：

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" --profile cp-live-headless \
  "请调用 cp_status 工具，读取 CircuitPilot Runtime 与 EDA 的当前状态；只返回 status 摘要，不要调用任何写操作。"
```

真实事件（从 DSH session 取证）：

- `request/header`: provider `tokenfens`, model `deepseek-flash`
- 模型先调用 `skill` 加载 `circuitpilot`，再调用 `cp_status`（args `{}`）
- `tool/result`：`ok:true`；Runtime 0.2.0 在线、项目「衣橱助手V2.0 测试板」、**EDA 离线 `BRIDGE_NOT_FOUND`**、写暂停否、9 个未收口问题、97 份证据
- 最终回答 1272 字符，摘要与工具结果一致；无写操作

脱敏证据：`artifacts/agent-dsh-live-toolcall.json`（只保留 tool 结果/模型/provider，无 API key、无 agent token）。验收后临时 `cp-live-headless` profile 已删除；`desktop` profile 中的插件 link 保留，Electron 重启后生效。

仍未验证：Electron 桌面会话重启后的工具列表/授权交互；DSH 内 plan→approve→execute→DRC（受 EDA 离线限制）。


## 6. EDA 离线根因（2026-10-29 19:00 核查）

- 本机 EasyEDA 已打开，`easyeda-agent` v1.3.0 在 **60832** 有 1 个窗口；
- CircuitPilot 只扫描 **49620-49629** 且要求 `service:"easyeda-bridge"`；
- 临时起 legacy `bridge-server.mjs`（49620）→ `/health` 正常但 `edaConnected:false`、0 窗口，说明没有 EDA 客户端连这个旧桥；
- 当时真实 EDA 写板/DRC 不能执行，也没有伪造在线状态。**后续已用实验适配器打通只读（见 §7）**；根因见 `.auto-coding/testing/reports/20261029_eda-offline-rootcause.md`。

## 5. 桌面 app 重启加载新 bundle（2026-10-29 19:06）

此前 4178 一直是 17:35 启动的旧进程；本轮完成优雅退出 + 启动新 bundle：

```bash
osascript -e 'tell application id "com.circuitpilot.desktop" to quit'
open src-tauri/target/release/bundle/macos/CircuitPilot.app
```

验证：

- `/api/health` → `{"ok":true,"service":"circuitpilot-runtime","version":"0.2.0"}`；新进程 PID 30796，Runtime PID 30815。
- `POST /api/agent/plan-requests`（agent token，空体）→ **400 `PLAN_REQUEST_INVALID`**；旧进程未装载该路由时为 404，证明新计划级队列已加载。
- `GET /api/agent/plan-requests`（agent token）→ **403 `AGENT_ROUTE_FORBIDDEN`**，路由边界仍生效。
- MCP `cp_status` 对重启后的 4178 成功；重启当时 EDA 仍为 `BRIDGE_NOT_FOUND`（后续 §7 用适配器打通只读），未执行任何写板/DRC。
- 证据：`artifacts/agent-desktop-restart-20261029.json`。
- 新桌面窗口内导航到「系统设置 → Agent 控制台」，真实看到 1 条 pending 计划（`apr_627b8406b1a1f790`），点击「拒绝」+ 确认；state 文件转 `rejected`，decisionNote「用户在 UI 拒绝该计划」，队列恢复「无」。**已在真实桌面壳内完成拒绝操作**，未签发 token、未执行写；截图 `artifacts/agent-desktop-plan-reject.png`、OCR `artifacts/agent-desktop-plan-reject.txt`、证据 `artifacts/agent-desktop-plan-queue-20261029.json`。

注意：桌面壳通过 stdin 注入 UI 令牌，外部浏览器/脚本无法取得 `sessionProof`，因此新桌面进程的 UI 内操作仍需用户在 app 窗口内验收；本轮验证的是路由装载与鉴权边界，不等于已完成真机写板。

## 7. 真实 EDA 只读打通（2026-10-29 19:09，实验适配器）

### 7.1 适配器

本机 EasyEDA 3.2.186 使用 `easyeda-agent` v1.3.0（daemon 60832），Runtime 只认旧 `easyeda-bridge`（49620–49629）。新增实验性适配器 `scripts/easyeda-agent-bridge.mjs`：

- 在 `127.0.0.1:49620` 暴露旧桥 `/health`、`/eda-windows`、`/eda-windows/select`、`/execute`；
- `/execute` 的 raw JS 通过 CLI `easyeda --skip-version-check debug exec` 在真实 EDA connector 内执行；
- 不修改 Runtime 协议；CLI 与 connector 版本不一致，因此仅用于本机只读/受控验收，不是生产默认桥。

启动：`npm run bridge:agent`（可选 `CIRCUITPILOT_BRIDGE_TOKEN`）。

### 7.2 真实结果

- 在 EasyEDA 打开 **PCB1_1**（`084751e2c073fcf2`，仅切前景/激活文档，不是设计修改）。
- `cp_status` → `eda.online:true`，workspace 绑定 `DBTS-A01 双电池无缝切换测试板` / `Board1_1` / PCB1_1。
- 真实 PCB DRC：**0 违规**，`reportedCount=0`、`truncated=false`、报告 digest `f857db...b85629`。
- 真实 ERC（schematic page `3c6b71d02c23a22f`）：fatal 0 / error 0 / **warning 1** / info 0；仅聚合计数（`EDA_GUI_CDP_UNAVAILABLE` 无逐条明细），报告 digest `690a0a...f48073`。
- 六门：verdict **unknown**（G1–G6 输入未齐），不宣称通过。
- **未执行写入**：未调用 `cp_approve`/`cp_execute`/`cp_export`，未写 PCB 图元、未保存、未导出。
- 验证后已停止适配器（`kill 32026`），当前 Runtime 恢复 EDA 离线；复现：`npm run bridge:agent`。
- 证据：`artifacts/agent-eda-adapter-real-20261029.json`；报告 `.auto-coding/testing/reports/20261029_eda-agent-adapter.md`。

### 7.3 真实批量校验 + 一个真实语义 bug

用同一适配器对两块真实板顺序跑 ERC+DRC：

| 板 | ERC | DRC | 结论 |
|---|---|---|---|
| PCB1_1 `084751e2c073fcf2` | 0 error / 1 warning | 0 违规，`ready:true` | 通过 |
| PCB1 `9ab008aa6dfb92c2` | 0 error / 0 warning | 1 条 unexplained，`ready:false` | **不通过** |

第一次批量复跑暴露了旧逻辑的真实缺陷：DRC 任务成功（`ok:true`）就被当作板子通过，摘要错误输出“2 板 2 通过”。已在 `plugin/dsh-circuitpilot/lib/tools.mjs` 收紧为按 target 判定：
DRC 要求 `classification.ready===true` 且未截断；ERC 要求 fatal/error 为 0；gates 要求 `verdict==='pass'`。
修复后同一两板真机复跑：**“批量校验：2 板，1 通过，1 失败”**，第二板 `error.failedTargets=["drc"]`。
插件 **85/85 PASS**；真实证据 `artifacts/agent-eda-batch-20261029.json`，报告 `.auto-coding/testing/reports/20261029_batch-validation-fix.md`。

### 7.4 真实写链路（用户批准后）

用户在对话中明确批准最小风险计划 `5ed49af5…`（`pcb.save` + `pcb.drc`，不改设计图元）后执行：

- approvalId `3e0dd669e7bd9c4c`；execution `b0b8eac8-c786-434f-8098-5ed95ebc2dae`；state **completed**。
- `pcb.save` 返回 true；写前快照 digest `b33bac…bc5b`，写后 sourceDigest 相同。
- write-verify：outline/line/via/pour 几何 **delta=0**，`missing:[]`、`unverifiable:[]`。
- DRC 基线 0、执行后 0，`passed:true`，`truncated:false`；写锁已释放。
- 回读：95 components / 1152 lines / 191 vias / 13 pours / 1 outline。
- 证据：`artifacts/agent-real-pcb-write-20261029.json`、报告 `.auto-coding/testing/reports/20261029_real-pcb-write.md`。
- 边界：这是**真实保存写链路**，但**未新增/修改设计图元**；回滚演练、正式签核、导出、下单均未执行。适配器验证后已停止，当前 EDA 恢复离线。

### 7.5 真机定向回滚复验（2026-10-30，新代码，用户批准）

用户批准新计划 `planHash c629fda8097b58bc4212cb9a7156353edf42287d1e8915a3d79f516786e6e590` 后，在**隔离 Runtime 4186**（直接加载仓库 `runtime/pcb.mjs` 新代码，非桌面 4178 旧 bundle）执行：

- 目标：`PCB1_1` `084751e2c073fcf2`；window `0a54ded2-…`；target fingerprint `4ec5db59…`。
- 操作：`pcb.line.create`（临时线，返回 id `c7614511fe67a28c`）→ 故意非法 `pcb.component.modify`（`EDA_COMMAND_ARGS_INVALID`）→ `pcb.drc`。
- 结果：state **rolled_back**；`rollback.scope=targeted`；`snapshotRestored=false`；补偿删除 `c7614511fe67a28c`，`failed:[]`、`skipped:[]`、`createdStillPresent:[]`；**没有走整档 `document.source.restore`**。
- 板面复核：95 components / **1152 lines** / 191 vias / 13 pours；临时线 id **不存在**；写前基线 DRC **0**；无 safety write lock。
- execution `b81cea1b-70be-4a86-bbd4-7bf9308b57b2`；证据 `artifacts/agent-rollback-drill-targeted-success-20261030.json`。
- 边界：这验证的是 **create-only 定向回滚**（本次实际落板只有创建线）；**没有验证整档 `document.source.restore`**。含 `component.modify`/`importChanges` 的非创建变更仍需真机验证。
- 2026-10-30 已重建桌面 bundle 并重启（见 §7.6）；本结果来自隔离 4186，验证的是代码级 create-only 定向回滚。适配器在复验后曾停止，2026-10-30 已重新启动。


### 7.6 2026-10-30 运行环境修复

- 桌面重打包并重启：bundle `runtime/pcb.mjs` SHA-256 `3236fef6…`，与仓库一致；4178 健康检查通过。
- Vite 4177 指向开发 Runtime 4179（状态为桌面 state 副本，含审计锚点）；`e2e/app.spec.ts` **31/31 PASS**，完整 Playwright **38 passed / 6 skipped**（4 个需 `CP_LIVE_EDA_E2E=1` 的真机用例 + 2 个需要独占 4178 的 C6/F7 用例；无失败）。
- E2E mock 改为 host-agnostic；规则中心按当前 151 条规则包更新断言。
- 实验 EDA 适配器启动后 `cp_status` EDA **online**；仍不是生产桥。
- `cp_issues` 的 title/code 回退已修（插件测试 85/85）；当前 DSH 进程需重启后加载；3 条旧 issue-state 已做兼容数据迁移，`cp_issues` 当前即可读。
- 证据：`artifacts/agent-environment-recovery-20261030.json`。
- 2026-10-30 按用户选择打开项目保存工程，活动 EDA PCB 已对齐到 `5595e77cead09682`；仅切换活动文档，未改工程数据。
- 2026-10-30 非创建回滚演练（planHash `c0b54846…`，用户确认）失败：C1 移动 0.01mm 后第二操作 `EDA_REQUEST_ABANDONED`（15s），`document.source.restore` 回读摘要不匹配，state=`rollback_failed`，安全写锁已触发。表面回读/DRC 与演练前一致（DRC 仍 1 条已知 Netlist Error），但 sourceDigest 不一致，不能宣称整档回滚成功；未自动重试。证据：`artifacts/agent-rollback-drill-noncreate-failure-20261030.json`。
