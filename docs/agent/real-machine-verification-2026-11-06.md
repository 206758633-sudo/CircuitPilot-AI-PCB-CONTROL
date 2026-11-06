# 本机真机验证报告（2026-11-06）

> 结论：**在本机真实环境中完成了三层验证**（真实安装版 CircuitPilot 0.2.0 Runtime、本仓库最新
> Runtime、真实 DSH 0.2.1-rc.5 宿主），9/9 + 真机宿主断言全部通过；并据此**补齐了
> `cp_design_loop` 的 `source:"project"` 输入**与"安装版构建早于复合框架"的精确错误提示。
>
> 验证过程只读、隔离端口 + 临时 state/token；**未写入任何 EDA、未触碰用户正在运行的 App（4178）**。

## 1. 环境

| 项 | 值 |
|---|---|
| 时间 | 2026-11-06 16:28–16:35 Asia/Shanghai |
| 真实安装版 App | `/Applications/CircuitPilot.app`（CFBundleShortVersionString 0.2.0），Runtime 版本 **0.2.0** |
| 隔离 Runtime（安装版） | `127.0.0.1:4196`（`/Applications/CircuitPilot.app/Contents/Resources/runtime/server.mjs` + 临时 state/token） |
| 隔离 Runtime（本仓库最新） | `127.0.0.1:4197`（`node runtime/server.mjs` + 临时 state/token） |
| DSH 宿主 | `/Applications/DeepSeek Harness.app` **0.2.1-rc.5**；隔离 `DSH_HOME=.tmp/dsh-verify-home` profile `cp-verify`（headless 模板 + `link:` 插件 + 验收探针） |
| 外部工具 | kicad-cli / ortools / z3 / shapely 本机均不可用（适配器如实报告 unavailable） |

## 2. 真机结果

### 2.1 真实安装版 CircuitPilot.app（0.2.0）

| 断言 | 结果 | 说明 |
|---|---|---|
| `cp_status` | ✔ `ok:true` | Runtime 0.2.0 在线、版本判定 supported、6 项核心能力齐全 |
| `cp_design_loop(model)` | ✔ 明确失败 `RUNTIME_ROUTE_MISSING` | 安装版 App 的构建**早于复合框架**，不含 `/api/design/framework/*`；插件不再返回裸 404，而是提示"改用本仓库 `node runtime/server.mjs` 或重新打包/安装 App" |

> 这是本轮真机验证发现的关键事实：**装好的 App 需要重新打包/安装**才能获得设计框架路由；
> 在此之前 `cp_design_loop` 会 fail-closed 并给出可执行提示，其余只读工具不受影响。

### 2.2 本仓库最新 Runtime（0.2.0，含复合框架）

| 断言 | 结果 |
|---|---|
| `cp_status` | ✔ ok:true（版本/能力门禁通过） |
| `cp_design_loop(model)` | ✔ `needs-review`、blocking=0、repair=1（离线闭环生效） |
| `PUT /api/project-state` + 读回 | ✔ 200 / activeProjectId 正确 |
| `cp_design_loop(source="project")`（EDA 离线） | ✔ `DESIGN_FRAMEWORK_EDA_OFFLINE` fail-closed："EDA 未返回可用板框/铜层数（拒绝编造尺寸）" |
| `GET /api/design/framework/status` | ✔ 200；kicad.available=false 如实报告 |
| `GET /api/design/framework/golden` | ✔ 200；金板 5/5（needs-review=3、blocked=2） |

证据：`artifacts/real-machine-verification-2026-11-06.json`（**9/9 通过**）。

### 2.3 真实 DSH 宿主（0.2.1-rc.5）

| 断言 | 结果 |
|---|---|
| 插件激活 | ✔ 无 `skipping bundle` / `did not activate` |
| 工具注册 | ✔ 宿主共 38 工具，其中 **13 个 cp_***（含 `cp_design_loop`） |
| `cp_status` | ✔ ok:true |
| `cp_design_loop(model)` | ✔ `needs-review`（迭代 2 / 修复 1 / blocking 0 / review 144 / 规则覆盖 21.2%） |
| `cp_design_loop(source="project")` | ✔ `DESIGN_FRAMEWORK_EDA_OFFLINE`（EDA 离线时 fail-closed，不伪造 IR） |

证据：`artifacts/real-dsh-host-verification-2026-11-06.json`。

### 2.4 本仓库打包的桌面 App bundle（新增验证，2026-11-06 16:39）

为了让"安装版缺路由"不再成为缺口，本轮用 `npm run desktop:app` 重新打包了 App bundle
（`src-tauri/target/release/bundle/macos/CircuitPilot.app`，0.2.0），并把 `eval/golden` 纳入
Tauri resources；随后**直接用打包产物的 runtime** 起隔离实例（4198）验证：

| 断言 | 结果 |
|---|---|
| bundle runtime 含 design-framework / design-framework-service / net-connectivity | ✔ |
| bundle 内嵌 eval/golden（5 个金板用例） | ✔ |
| `/api/health` = 0.2.0 | ✔ |
| `cp_status` | ✔ ok:true |
| `cp_design_loop(model)` | ✔ needs-review / blocking=0 / repair=1 |
| `cp_design_loop(source="project")`（EDA 离线） | ✔ `DESIGN_FRAMEWORK_EDA_OFFLINE` fail-closed |
| `/api/design/framework/golden` | ✔ 5/5 |

证据：`artifacts/packaged-app-verification-2026-11-06.json`（**7/7**）。
> 说明：该 bundle 在**工作区**验证通过；`/Applications/CircuitPilot.app` 仍是旧构建，
> 需要用户把新 bundle 复制/安装过去（或重新安装）后，桌面会话才带设计框架路由。

### 2.5 安装到 /Applications 并验证（2026-11-06 16:43）

- 备份旧安装版：`/Applications/CircuitPilot.app.bak-20261106-1650`（0.2.0 旧构建）
- 安装新构建：`/Applications/CircuitPilot.app`（0.2.0，含 design-framework + 内嵌 eval/golden，
  已 `codesign --verify --deep --strict` 通过；本地 ad-hoc 重签）
- 退出占用 4178 的旧 0.2.20 备份构建，启动新 App（进程 90720 / Runtime 90746）

| 断言 | 结果 |
|---|---|
| `/api/health` | ✔ 0.2.0 |
| `cp_status`（真实 agent token） | ✔ ok:true；版本兼容 supported |
| `cp_design_loop(model)` | ✔ needs-review / blocking=0 / repair=1（真实安装版 Runtime） |
| `cp_design_loop(source="project")` | ✔ `DESIGN_FRAMEWORK_EDA_OFFLINE`（EDA Bridge 不在线，拒绝编造尺寸） |
| EDA 状态探测 | ✔ `/api/eda/workspaces/current` 503 `BRIDGE_NOT_FOUND`（如实） |
| framework status / golden | ✔ 200；金板 5/5 |

证据：`artifacts/installed-app-verification-2026-11-06.json`（**6/6**）。
> 剩余动作：**重启 DeepSeek Harness** 让 desktop profile 重新加载新版插件（当前会话是旧加载）；
> 打开 EasyEDA 并选中目标 PCB 后，可再验证 `source:"project"` 的真实 EDA 读回链路。

### 2.6 DSH 重启后真实会话验证（2026-11-06 17:01）

- DSH 重启后 desktop profile 重新加载 `dsh-circuitpilot@0.2.0`（`link:` 本仓库）。
- 从真实会话 `request/header` 取证：模型可见工具共 **56 个**，其中 **13 个 `cp_*`**
  （`cp_status…cp_job + cp_design_loop`），`skill circuitpilot` 可正常加载（bundled skill 生效）。
- 证据：`artifacts/dsh-session-tool-registration-2026-11-06.json`。
- EDA 仍离线：`/api/eda/workspaces/current` = 503 `BRIDGE_NOT_FOUND`（`cp_design_loop(source="project")`
  会如实返回 `DESIGN_FRAMEWORK_EDA_OFFLINE`）。

### 2.7 真实 DSH 会话内工具调用验证（独立 teammate，只读）

由独立 DSH teammate 在**真实 desktop 会话**里直接调用 cp_* 工具（不经过本机 HTTP 脚本）：

| 调用 | 结果 |
|---|---|
| 工具注入 | ✔ 13/13 `cp_*` 全部可用 |
| `cp_status` | ✔ ok:true；Runtime 0.2.0、versionCompat supported、EDA 离线 `BRIDGE_NOT_FOUND`、写门禁 available/paused=false、插件 host dsh 0.2.1-rc.5（registration=mcp）、未收口问题 9、证据 113 |
| `cp_project_context` | ✔ ok:true；项目「衣橱助手V2.0 测试板」、项目数 4、EDA 未绑定、问题 9 |
| `cp_design_loop(model)` | ✔ ok:true；needs-review、2 轮、1 次修复（solve_placement 2/2，清掉 OVERLAP/SPACE-14/ZCLR-02）、blocking=0、review=145、规则覆盖 21.2%、evidence digest 已记录 |
| `cp_design_loop(source="project")` | ✔ fail-closed `DESIGN_FRAMEWORK_EDA_OFFLINE` + 4 条 nextActions（EDA 离线不编造尺寸） |
| 写入/审批/签核 | ✔ 0 次（未调用 cp_approve/cp_execute/cp_export/cp_validation）；无 token/approvalToken 泄漏 |

证据：`artifacts/dsh-live-tool-verification-2026-11-06.json`（**PASS**）。

### 2.8 真实 EDA 在线读回尝试（2026-11-06 17:12）——阻塞在 connector

用户打开 EasyEDA Pro（LCEDA-Pro 3.2.186，进程 99334）后尝试真实读回：

| 检查 | 结果 |
|---|---|
| EasyEDA Pro 进程 | ✔ 运行中 |
| `easyeda daemon start`（60832） | ✔ daemon health found（v1.3.0） |
| daemon windows | ✖ `windows: []` —— **EDA Agent connector 未导入/未连接** |
| 实验性 adapter `scripts/easyeda-agent-bridge.mjs`（49620） | ✔ 启动；`edaConnected=false`、`edaWindowCount=0` |
| Runtime `/api/eda/discover` | ✔ 发现 49620 bridge（adapter） |
| Runtime `/api/eda/windows` | ✖ `BRIDGE_HTTP_ERROR`（Bridge HTTP 503：没有已连接窗口） |
| `cp_design_loop(source="project")` | ✖ 预期 `DESIGN_FRAMEWORK_EDA_OFFLINE` |

**结论：阻塞在 EasyEDA 内的 EDA Agent connector 未连接**（不是 Runtime/插件问题）。

**解除步骤（需用户在 EDA GUI 操作）**：
1. 在嘉立创EDA专业版导入扩展 `~/Downloads/easyeda-agent-connector-1.3.0.eext`
   （设置/扩展 或 高级 → EDA Agent），启用并重连（建议开 Auto-Connect）；
2. 打开目标原理图/PCB 并保持前台；
3. 确认 `easyeda daemon health` 的 `windows` 非空、`http://127.0.0.1:49620/health` 里
   `edaConnected=true`；
4. 之后重跑 `cp_design_loop({source:"project"})`（只读）。

证据：`artifacts/eda-online-readback-attempt-2026-11-06.json`。

### 2.9 真实 EDA 在线读回成功（2026-11-06 17:17）

用户连接 EDA Agent connector 并打开 PCB 后，完成**真实 EDA 只读读回 + 离线设计闭环**：

| 项 | 结果 |
|---|---|
| Runtime `/api/eda/workspaces/current` | ✔ 绑定成功：项目「DBTS-A01 双电池无缝切换测试板」、Board1_1、PCB1_1 `084751e2c073fcf2` |
| `pcb.outline.read` | ✔ 板框 **130.505 × 88.519 mm**（permission=read） |
| `pcb.layers.copperCount` | ✔ **4 层**（permission=read） |
| `pcb.placement.read` | ✔ **95 个器件**（含 bbox/层/旋转/每器件 nets，permission=read） |
| `schematic.netlist.export` | ⚠ 返回 null：CLI v1.3.0 与 connector 1.14.0 版本错位，`getNetlistFile` 未返回文本 → Runtime 如实置空（不编造网络） |
| `cp_design_loop(source="project")` | ✔ ok:true、**needs-review**、2 轮、1 次修复（`solve_stackup` layers=4；离线、不写 EDA）、blocking=0、review=147、规则覆盖 21.2%、evidence digest `8aed9185…` |
| cp_status | ✔ EDA online、Runtime 0.2.0、写门禁未暂停 |
| 写入/审批/签核 | ✔ **0**（只读命令均为 permission=read；doc switch 仅切前台文档） |

证据：`artifacts/eda-online-readback-verified-2026-11-06.json`

> 这是首次在**真实 EDA 在线**状态下跑通 `source:"project"`（板框/层数/95 器件几何来自真实工程）。
> 已知限制：connector 版本错位导致网表导出为空（netCount=0）；建议导入与 CLI 同版的
> `easyeda-agent-connector-1.3.0.eext` 后复测网表。

### 2.10 真实官方 ERC/DRC（只读，2026-11-06 17:19）

在真实 EDA 在线状态下跑官方检查（`cp_validation`，只读，不写板、不签核）：

| 检查 | 结果 | 证据 |
|---|---|---|
| ERC | ✔ 完成：fatal 0 / error 0 / **warning 1** / total 1（aggregateOnly） | `schematic-erc` digest `d8807cb9…` |
| DRC | ✔ 完成但**不通过**：`reportedCount=1`（分组数）/**itemCount=39** 条，全部 Clearance Error（规则 `copperThickness1oz`；Top 20 / Inner2 9 / Inner1 8 / Multi 2），`classification.ready=false` + `DRC_UNEXPLAINED_ITEMS` | `drc-report` digest `743d2cc1…` |

> 这是**真实 EDA 结果**，如实记录：ERC 1 warning、DRC 39 条未解释 clearance 违规 → 不能当放行依据。
> 另注：connector 1.14.0 / CLI 1.3.0 版本错位，网表导出为空（netCount=0），待同版 connector 复测。

### 2.11 真实 DSH 会话内真实读回复验（独立 teammate）

`cp-eda-live-verifier` 在真实 desktop 会话内直接调用：
- `cp_status`：EDA 在线、Board1_1/`084751e2…`、Runtime 0.2.0、写门禁未暂停；
- `cp_design_loop({source:"project"})`：✔ ok、**未出现 `DESIGN_FRAMEWORK_EDA_OFFLINE`**——真实读回成功；
  needs-review、2 轮、1 次 `solve_stackup`、blocking=0、review=147、板 130.505×88.519mm / 4 层 / 95 器件；
- 写/审批/签核调用 **0**；无 token 泄漏。
- 注意：项目状态 `edaWorkspace.pcbUuid=5595e77c…` 与当前活动板 `084751e2…` 不一致（source=project 用活动板读回，正确）；
  design-loop 证据只以 digest 引用（未归档进证据索引）。

## 3. 本轮据此完成的代码改进

1. **新增 `source:"project"`**（Runtime 服务层 + HTTP 路由 + 插件工具）：
   - 由 Runtime 用「项目状态 + EDA 只读读回」构建板级 IR：
     `pcb.outline.read`（板框 bounds）→ `widthMm/heightMm`；`pcb.layers.copperCount` → layers；
     `pcb.placement.read` → 器件几何（经 `adaptPlacements` 归一；尺寸未知显式 `sizeUnknown`）。
   - EDA 离线/未选中 PCB → `DESIGN_FRAMEWORK_EDA_OFFLINE`（409，拒绝编造尺寸）；
   - 无活动项目 → `DESIGN_FRAMEWORK_NO_ACTIVE_PROJECT`（409）。
2. **精确的"构建早于框架"提示**：`cp_design_loop` 遇到 `ROUTE_NOT_FOUND` 时返回
   `RUNTIME_ROUTE_MISSING` + "改用本仓库新构建 Runtime / 重新打包 App"的 nextActions（不再靠猜）。
3. **测试补齐**：服务层 11 项（含 `buildModelFromProject` 几何/尺寸未知/EDA 离线/无项目）、
   插件 210 项（含 `source=project` 成功与 EDA 离线映射）。

## 4. 仍未完成（如实保留）

1. **安装版 App 已替换并验证**（§2.5）：`/Applications/CircuitPilot.app` 现为含复合框架的新构建，
   旧版备份在 `/Applications/CircuitPilot.app.bak-20261106-1650`；仍需**重启 DSH** 让插件重新加载。
2. **真实 EDA 在线读回未验证**：本机 EDA 当前离线，`source:"project"` 只验证了离线 fail-closed 路径；
   EDA 在线时的 `pcb.outline.read`/`placement.read`/`schematic.netlist.export` 真机链路未跑。
3. **网表自动读取已实现但未真机验证**：`source:"project"` 现在会额外只读 `schematic.netlist.export`
   并解析成 IR nets（失败/无网表时如实为空，不编造）；本机 EDA 离线，未跑真机链路。
4. 真实 EDA 写板 / 官方 DRC / KiCad CLI 真机 / 外部求解器仍未执行（与前几轮一致）。

## 5. 复现

```bash
cd "/Users/jescochen/Desktop/AI- PCBA"

# 真实安装版 App Runtime（隔离 4196，临时 state/token）
CIRCUITPILOT_RUNTIME_PORT=4196 \
CIRCUITPILOT_STATE_DIR="$PWD/.tmp/cp-real-app-state" \
CIRCUITPILOT_EVIDENCE_DIR="$PWD/.tmp/cp-real-app-evidence" \
CIRCUITPILOT_AGENT_TOKEN_FILE="$PWD/.tmp/cp-real-app-state/agent-token.json" \
node "/Applications/CircuitPilot.app/Contents/Resources/runtime/server.mjs"

# 本仓库最新 Runtime（隔离 4197）
CIRCUITPILOT_RUNTIME_PORT=4197 \
CIRCUITPILOT_STATE_DIR="$PWD/.tmp/cp-real-ws-state" \
CIRCUITPILOT_EVIDENCE_DIR="$PWD/.tmp/cp-real-ws-evidence" \
CIRCUITPILOT_AGENT_TOKEN_FILE="$PWD/.tmp/cp-real-ws-state/agent-token.json" \
node runtime/server.mjs

# 真机验证脚本（本机安装版 + 本仓库 Runtime）
node .tmp/real-machine-verify.mjs

# 真实 DSH 宿主（隔离 profile）
DSH_HOME="$PWD/.tmp/dsh-verify-home" \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile cp-verify "回答 OK"
```
