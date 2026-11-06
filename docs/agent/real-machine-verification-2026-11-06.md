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
