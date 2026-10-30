# CircuitPilot AI 安装与联通操作指导书

**适用对象：** 想让 DeepSeek Harness（DSH）或其他 AI 客户端安装、配置并调用 CircuitPilot 的工程师。  
**文档版本：** 2026-10-30  
**对应代码：** GitHub `main`，包含 `plugin/dsh-circuitpilot`、`agent/mcp-server.mjs`、跨平台 Runtime。  
**目标：** 让 AI 按本文执行后，能启动 CircuitPilot、连接嘉立创EDA专业版、安装 DSH 插件/skill/MCP，并完成只读验收。

> **给 AI 执行者的第一条指令：** 本文不是“建议阅读”，而是带检查点的执行清单。每完成一步必须运行检查命令；检查不通过时不要继续，不要改用绕过审批的路径，不要把“安装命令成功”当成“插件已运行”或“EDA 已连通”。

**给用户的启动提示（可直接连同本文件发给 AI）：**

```text
请阅读 INSTALL_AI.md，并按第 12 节执行。你可以在终端执行安装命令、检查端口、
启动 CircuitPilot/DSH；但遇到 EDA 登录、扩展广场安装、DSH 桌面 profile 切换、
任何 EDA 写入审批时，必须停下来让本机用户确认。不要输入或输出 token/API Key，
不要自动下单、签核或绕过写门禁。每一步都要报告“已验证/未验证”。
```

---

## 0. 先确认目标系统：不要承诺不存在的“同等能力”

CircuitPilot 目前的状态必须按系统区分：

| 系统 | CircuitPilot 本体 | 嘉立创EDA 受控写入链路 | 结论 |
|---|---|---|---|
| macOS 12+ | 有桌面应用/源码部署 | **真机验证过** | 推荐；可按本文完整执行 |
| Windows 10/11 | 源码可构建，桌面目标已加入 | **未真机验收** | 可安装、可只读试用；不能承诺与 macOS 同等 AI 设计能力 |
| Ubuntu | 源码可构建，桌面目标已加入 | **未真机验收；官方 Linux EDA 客户端需先确认** | 先确认 EDA 可用；不能承诺与 macOS 同等能力 |

**AI 必须遵守：**

1. 如果用户目标是 macOS：按本文完整安装，最后只能声明“已完成只读验收”；正式写入仍需按第 10 节人工批准。
2. 如果用户目标是 Windows/Ubuntu：完成安装后只能声明“代码级适配 + 待真机 EDA 验收”，**不得**写“已具备与 Mac 相同能力”。
3. 如果目标系统没有可用的嘉立创EDA专业版桌面客户端，**停止**，不要用 Wine、浏览器版或第三方 MCP 冒充同等链路；先向用户报告缺口。
4. 不要自动下单、付款、签核、导出生产文件，也不要绕过任何审批门禁。

---

## 1. 最终要装什么、连什么

```
用户电脑
├─ CircuitPilot 控制台（React，127.0.0.1:4177）
├─ CircuitPilot Runtime（Node，127.0.0.1:4178）
│   ├─ agent token 文件（插件/MCP 用它访问 Runtime）
│   ├─ EDA CDP 连接（127.0.0.1:9222）
│   └─ 本地桥守护进程（127.0.0.1:49620–49629）
├─ 嘉立创EDA专业版（本地桌面客户端）
│   └─ 官方扩展 run-api-gateway（API Gateway）
│       └─ 开启“外部交互权限 / External Interaction Permission”
└─ DeepSeek Harness
    ├─ dsh-circuitpilot 插件（原生 cp_* 工具）
    ├─ circuitpilot skill（插件内置，不需要单独下载）
    └─ 可选：CircuitPilot MCP Server（给 DSH 或其他 MCP 宿主用）
```

### 端口和地址

| 地址/端口 | 用途 | 是否可暴露 |
|---|---|---|
| `http://127.0.0.1:4177` | CircuitPilot 控制台 | 仅本机 |
| `http://127.0.0.1:4178` | CircuitPilot Runtime | 仅本机；外部请求 401 是预期 |
| `http://127.0.0.1:9222` | 嘉立创EDA CDP 调试口 | 仅本机 |
| `127.0.0.1:49620–49629` | CircuitPilot 本地 EDA 桥 | 仅本机；自动启动 |
| `127.0.0.1:4180` | 可选 MCP Streamable HTTP | 仅本机 |
| `http://127.0.0.1:55510` | 当前 DSH Web GUI（因安装而异） | 仅本机 |

**不要**把 4178、9222、49620–49629 暴露到局域网或公网。

---

## 2. 安装前检查表

### 2.1 所有系统都要有

| 软件 | 要求 | 安装方式 | 检查 |
|---|---|---|---|
| Git | 任意近期版本 | 官方 git-scm.com 安装包；macOS 可用 Xcode CLT | `git --version` |
| Node.js | **22 或更高**（Runtime/构建需要） | 官方 nodejs.org LTS；macOS `brew install node@22`；Windows `winget install OpenJS.NodeJS.LTS`；Ubuntu 用 NodeSource/nvm 安装 22.x | `node -v` |
| npm | 随 Node | 随 Node 安装 | `npm -v` |
| DeepSeek Harness | 已安装；插件按当前 DSH 版本验证（本文按 0.2.1-rc.2 系列说明） | 从 DSH 官方发行渠道安装；不要使用第三方镜像 | `dsh --version` 或应用内查看 |
| 嘉立创EDA专业版 | 官方桌面客户端；已登录 | 官方 lceda.cn 下载专业版 | 能打开本地测试工程 |
| CircuitPilot 源码 | GitHub 仓库；**插件/MCP 必须有源码目录** | `git clone`，见第 4 节 | 见第 4 节 |

### 2.2 只有从源码构建桌面版才需要

| 系统 | 额外依赖 |
|---|---|
| macOS | Xcode Command Line Tools、Rust stable：`xcode-select --install`、`rustc -vV` |
| Windows | Rust stable MSVC、Visual Studio Build Tools（C++ 桌面开发）、WebView2 Runtime、NSIS（Tauri 打包用） |
| Ubuntu | Rust stable，以及 Tauri v2 Linux 依赖：`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev` |

> 只使用 Web 控制台（`npm run dev:full`）时，不需要 Rust 和桌面打包依赖；但仍需要 Node 22。

### 2.3 人类必须参与的卡点

AI 可以执行终端命令、读文件、启动进程、调用 MCP/插件工具；以下步骤涉及 GUI、账号或安全确认，**必须由本机用户完成或明确授权**：

1. 安装/登录嘉立创EDA专业版；
2. 在 EDA 扩展广场安装 `run-api-gateway` 并开启外部交互权限；
3. DSH 桌面应用切换/重启 profile（如 CLI 不能自动重载）；
4. 任何 EDA 写入前的 planHash 批准；
5. Windows/Ubuntu 真机 EDA 验收签字。

AI 不得替用户输入账号密码，不得把 API key/token 写进对话、日志或仓库。

---

## 3. 安装 CircuitPilot

### 3.1 取得代码（所有系统）

```bash
git clone https://github.com/206758633-sudo/CircuitPilot-AI-PCB-CONTROL.git
cd CircuitPilot-AI-PCB-CONTROL
git checkout main
git pull --ff-only
node -v   # 必须 >= 22
npm ci
```

**AI 检查点：**

```bash
test -f plugin/dsh-circuitpilot/index.mjs
test -f agent/mcp-server.mjs
test -f runtime/server.mjs
echo "source-tree-ok"
```

如果 `agent/mcp-server.mjs` 不存在，说明拿到的是旧 release/旧分支；**MCP 与当前插件说明以源码 main 为准**，请重新拉取 main，或明确告诉用户“当前版本没有 MCP”。

> 插件和 MCP 需要源码目录；只安装 macOS `.app` 不包含这些开发文件。因此即使使用桌面安装包，也建议保留一份仓库源码供 DSH 插件 link。

### 3.2 macOS

#### A. 使用 GitHub Release 安装包（普通用户）

1. 打开 <https://github.com/206758633-sudo/CircuitPilot-AI-PCB-CONTROL/releases>；
2. 下载对应架构的 `.dmg` 和 `SHA256SUMS.txt`（若当前 Release 没有对应资产，改用源码构建）；
3. 校验：

```bash
cd ~/Downloads
shasum -a 256 CircuitPilot_*.dmg
# 与 SHA256SUMS.txt 对应行比较；不一致就重新下载
```

4. 打开 DMG，把 `CircuitPilot.app` 拖到 `/Applications`；
5. 首次启动在 Finder 中 **右键 → 打开**；未公证版本可能被 Gatekeeper 拦截，确认来源和 SHA256 后再放行。

#### B. 源码启动（推荐给需要 DSH 插件/MCP 的用户）

```bash
# 在仓库根目录
npm run dev:full
# 控制台: http://127.0.0.1:4177
# Runtime: http://127.0.0.1:4178
```

或者构建桌面应用：

```bash
npm run desktop:app
open src-tauri/target/release/bundle/macos/CircuitPilot.app
```

**检查点：**

```bash
curl -fsS http://127.0.0.1:4178/api/health
```

看到 `ok`/健康 JSON 才继续。若端口被占用，先关闭旧 CircuitPilot 实例。

### 3.3 Windows 10/11（源码构建，实验性）

> 当前没有与 macOS 等价的官方 Windows 安装包；以下是源码构建路径。完成构建也不代表 EDA 链路已验收。

1. 安装 Node.js 22 x64、Git、Rust stable（MSVC toolchain）；
2. 安装 Visual Studio Build Tools，勾选“Desktop development with C++”；
3. 确认 WebView2 Runtime（Windows 11 通常自带；Windows 10 如缺失需安装）；
4. 在 PowerShell 执行：

```powershell
git clone https://github.com/206758633-sudo/CircuitPilot-AI-PCB-CONTROL.git
Set-Location CircuitPilot-AI-PCB-CONTROL
node -v
npm ci
npm run dev:full
```

另开一个 PowerShell 验证：

```powershell
Invoke-RestMethod http://127.0.0.1:4178/api/health
```

构建桌面安装包：

```powershell
npm run desktop:build:windows
```

构建产物在 `src-tauri\target\release\bundle\` 下（具体 `.msi`/`.exe` 名称以实际为准）。**AI 不应声称这是已验收的正式 Windows 版。**

### 3.4 Ubuntu（源码构建，实验性）

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev
git clone https://github.com/206758633-sudo/CircuitPilot-AI-PCB-CONTROL.git
cd CircuitPilot-AI-PCB-CONTROL
node -v   # 需要 22+
npm ci
npm run dev:full
```

另开终端：

```bash
curl -fsS http://127.0.0.1:4178/api/health
```

构建桌面包：

```bash
npm run desktop:build:linux
```

产物在 `src-tauri/target/release/bundle/`（`.deb` / AppImage，具体以实际为准）。

> **Ubuntu 前置阻断：** 先确认嘉立创EDA专业版是否有可用的官方 Linux 桌面客户端。若没有，停止；不要用 Wine 或浏览器版冒充桌面 EDA 链路。

---

## 4. 安装嘉立创EDA专业版

### 4.1 安装

1. 打开嘉立创EDA官网 <https://lceda.cn/>，下载**专业版**桌面客户端；
2. 安装并登录；
3. 新建一个**空白测试工程**，确认保存、关闭、重开正常；
4. 在 EDA 中打开该测试工程的原理图/PCB 文档（后续只读验收需要）。

### 4.2 必须安装的官方扩展：`run-api-gateway`

在嘉立创EDA专业版中：

1. 打开 **扩展 / 扩展广场**；
2. 搜索 **`run-api-gateway`**（显示名通常为 **API Gateway**）；
3. 安装官方扩展；
4. 打开扩展设置，启用 **外部交互权限 / External Interaction Permission**；
5. 完全退出并重启 EDA，让扩展重新连接本地桥（端口 49620–49629）。

**检查点：** CircuitPilot 的“连接与环境 / EDA 连接”中应能看到桥/EDA 通过；如果仍显示未连接，按第 11 节排查。

### 4.3 其他扩展要不要装？

| 扩展 | 是否必需 | 说明 |
|---|---|---|
| `run-api-gateway` / API Gateway | **是** | CircuitPilot 连接 EDA 的官方必需扩展 |
| `eext-design-rule-generator`（官方设计规则生成器） | 否 | 可选的规则辅助工具；CircuitPilot 不依赖它才能启动 |
| 任何第三方“CircuitPilot 扩展” | **不要装** | 本项目不分发 EDA 扩展，也没有要求安装第三方 EDA MCP |

> **不要把 “EasyEDA Bridge” 当成 EDA 扩展去下载。** 这里的 EasyEDA Bridge 是 CircuitPilot 自动启动的本地桥服务；EDA 侧需要的是 `run-api-gateway` 扩展。

### 4.4 以调试端口启动 EDA

必须先**完全退出** EDA，再以调试端口启动；不要同时开多个实例。

#### macOS

优先用 CircuitPilot 界面 **EDA 执行 → 启动EDA**。终端备用：

```bash
# 先 Cmd+Q 完全退出 EDA
env -u ELECTRON_RUN_AS_NODE \
  "/Applications/嘉立创EDA(专业版).app/Contents/MacOS/LCEDA-Pro" \
  --remote-debugging-port=9222 \
  > /tmp/lceda-run.log 2>&1 &
```

#### Windows（PowerShell）

```powershell
# 路径以实际安装为准；先完全退出 EDA
& "C:\Program Files\嘉立创EDA专业版\嘉立创EDA专业版.exe" --remote-debugging-port=9222
```

如果实际目录不同，用 `Get-ChildItem "C:\Program Files" -Recurse -Filter "*EDA*.exe"` 定位后替换。

#### Ubuntu

```bash
# 路径以官方 Linux 客户端实际安装为准；没有官方客户端则停止
"/opt/嘉立创EDA专业版/lceda-pro" --remote-debugging-port=9222
```

也可以用 CircuitPilot 的“启动EDA”按钮，但 Windows/Ubuntu 的 EDA 启动链路尚未真机验收，失败时按第 11 节处理，不要伪造成功。

### 4.5 验证 CDP

```bash
curl -fsS http://127.0.0.1:9222/json/version
curl -fsS http://127.0.0.1:9222/json/list | head
```

Windows PowerShell：

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/version
(Invoke-RestMethod http://127.0.0.1:9222/json/list) | Select-Object -First 5
```

期望：`/json/version` 返回包含 `Browser` / `webSocketDebuggerUrl` 的 JSON；`/json/list` 至少有一个 `type: "page"` 的 EDA 页面。

**若连接被拒绝：** EDA 没有以调试端口启动，先完全退出再重开；不要继续后面的写入步骤。

### 4.6 桥端口 49620–49629

CircuitPilot 会自动启动本地桥，不需要手工运行 `node bridge-server.mjs`。检查：

```bash
# macOS/Linux
lsof -nP -iTCP:49620-49629 -sTCP:LISTEN
```

```powershell
# Windows
Get-NetTCPConnection -LocalPort 49620..49629 -State Listen -ErrorAction SilentlyContinue
```

桥只应监听 `127.0.0.1`。若端口被旧实例占用，先关闭 EDA 和 CircuitPilot，再重开。

---

## 5. 安装 DeepSeek Harness 插件

### 5.1 找到 DSH CLI

优先使用 PATH 中的 `dsh`：

```bash
dsh --version
```

macOS 如果 `dsh` 不在 PATH，可使用应用内 CLI（路径以实际安装为准）：

```bash
DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH_BIN" --version
```

Windows：

```powershell
Get-Command dsh
# 若没有，在 DeepSeek Harness 安装目录中查找 dsh.cmd / dsh.exe
```

### 5.2 用独立 profile 安装（推荐）

不要直接装进日常 profile；先用 `cp-test` 验证：

```bash
export REPO="$HOME/CircuitPilot-AI-PCB-CONTROL"
export DSH_BIN="${DSH_BIN:-dsh}"

"$DSH_BIN" plugin --profile cp-test add "link:$REPO/plugin/dsh-circuitpilot"
```

Windows PowerShell：

```powershell
$env:REPO = "$HOME\CircuitPilot-AI-PCB-CONTROL"
$dsh = (Get-Command dsh).Source
& $dsh plugin --profile cp-test add "link:$env:REPO\plugin\dsh-circuitpilot"
```

如果 link 方式失败，进入插件目录用相对路径：

```bash
cd "$REPO/plugin/dsh-circuitpilot"
"$DSH_BIN" plugin --profile cp-test add "link:."
```

### 5.3 启动/重载 DSH

```bash
# 以实际 DSH 支持的方式启动；例如：
"$DSH_BIN" web --profile cp-test
```

也可以打开 DSH 桌面应用，切换到 `cp-test` profile。安装命令成功不等于插件已运行；必须检查：

1. profile 的插件列表里 **dsh-circuitpilot** 处于运行中；
2. skill catalog 中能看到 **`circuitpilot`**；
3. 对话中能调用 `cp_status`。

若插件没有出现在列表，重启 DSH；仍没有则检查 profile 的插件配置是否引用了 `dsh-circuitpilot`。不同 DSH 版本挂载方式可能不同。

### 5.4 插件配置

插件自带 `cordis.patch.yml`，默认：

```yaml
runtimeUrl: http://127.0.0.1:4178
approvalMode: chat
uiUrl: http://127.0.0.1:4177
```

通常在 DSH profile 中覆盖即可。**推荐显式设置 token 文件路径**（尤其 Windows/Linux）：

- macOS：`/Users/<你>/Library/Application Support/CircuitPilot/agent-token.json`
- Windows：`C:\Users\<你>\AppData\Roaming\CircuitPilot\agent-token.json`
- Linux：`/home/<你>/.local/state/circuitpilot/agent-token.json`（或 `$XDG_STATE_HOME/circuitpilot/agent-token.json`）

配置片段示例（放在 profile 的插件配置里，不要改仓库默认值）：

```yaml
- id: dsh-circuitpilot
  name: dsh-circuitpilot
  config:
    runtimeUrl: 'http://127.0.0.1:4178'
    approvalMode: chat
    agentTokenFile: '/绝对路径/agent-token.json'
```

同样可以在启动 DSH 的进程环境中设置：

```bash
export CIRCUITPILOT_AGENT_TOKEN_FILE="$HOME/Library/Application Support/CircuitPilot/agent-token.json"
```

Windows：

```powershell
$env:CIRCUITPILOT_AGENT_TOKEN_FILE = "$env:APPDATA\CircuitPilot\agent-token.json"
```

**注意：** token 文件由 CircuitPilot Runtime 启动时自动生成并设为仅当前用户可读；不要手工编辑、不要 `cat` 到日志、不要贴进对话。它不是 API Key，也不需要用户输入。

---

## 6. Skill 怎么调用

`circuitpilot` skill 已经打包在插件内（`plugin/dsh-circuitpilot/skills/circuitpilot/SKILL.md`），**不需要单独下载或安装**。插件运行后，DSH 的 skill catalog 应出现它。

### 6.1 调用方式

直接对 DSH 说：

```text
使用 circuitpilot skill，先调用 cp_status 读取当前状态；只读，不要执行任何写入。
```

或：

```text
用 circuitpilot skill 读取当前项目和 EDA 状态，然后用 cp_issues 列出未收口问题；不要写 EDA。
```

模型应调用 `cp_status` / `cp_project_context` / `cp_issues` 等工具，而不是凭空回答。

### 6.2 原生工具名

插件成功加载后，DSH 工具目录中应能看到：

```text
cp_status
cp_project_context
cp_issues
cp_knowledge
cp_design_plan
cp_pcb_plan
cp_approve
cp_execute
cp_job
cp_validation
cp_export
cp_evidence
```

如果使用 MCP（第 7 节），工具名会变成：

```text
mcp__circuitpilot__cp_status
mcp__circuitpilot__cp_execute
...
```

两者不要同时装进同一个 profile，否则模型会看到重复工具，容易误用。**优先原生插件 + skill。**

### 6.3 第一次只读验证

在 DSH 对话中执行：

```text
请用 circuitpilot skill：
1) cp_status
2) cp_project_context
3) cp_issues(limit=10)
只读，不生成计划、不执行、不修改任何设置。
```

期望：

- `cp_status` 返回 `ok: true`；
- Runtime 地址是 `127.0.0.1:4178`；
- 能看到当前项目/EDA 状态；
- 如果 EDA 未连接，工具应明确报告未连接，而不是编造已连接。

---

## 7. MCP 怎么配置和调用（可选）

> **版本提示：** 当前源码 `main` 含 `agent/mcp-server.mjs`；旧版 `v0.2.1` 安装包/旧手册可能没有 MCP。若文件不存在，不要按本节配置，改用原生插件。

### 7.1 什么时候用 MCP

- DSH 原生插件已能满足 `cp_*` 工具时，**不需要 MCP**；
- 需要给其他 MCP 宿主（或 DSH 的 `@deepseek-ai/dsh-mcp-client`）暴露 CircuitPilot 时，才配置 MCP；
- MCP 仍然受 Runtime 的审批/写门禁约束，不会绕过 `planHash` 批准。

### 7.2 通用 MCP 配置

```json
{
  "mcpServers": {
    "circuitpilot": {
      "command": "node",
      "args": [
        "/绝对路径/CircuitPilot-AI-PCB-CONTROL/agent/mcp-server.mjs",
        "--approval-mode",
        "chat"
      ],
      "env": {
        "CIRCUITPILOT_RUNTIME_URL": "http://127.0.0.1:4178",
        "CIRCUITPILOT_AGENT_TOKEN_FILE": "/绝对路径/agent-token.json"
      }
    }
  }
}
```

### 7.3 DSH MCP profile 片段

把类似下面的条目加入 DSH profile 的插件列表（与其它 `- id/name/config` 条目同级），具体 profile 文件位置以 DSH 安装为准：

```yaml
- id: mcp-circuitpilot
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: circuitpilot
    transport: stdio
    command: node
    args:
      - '/绝对路径/CircuitPilot-AI-PCB-CONTROL/agent/mcp-server.mjs'
      - '--approval-mode'
      - 'chat'
    env:
      CIRCUITPILOT_RUNTIME_URL: 'http://127.0.0.1:4178'
      CIRCUITPILOT_AGENT_TOKEN_FILE: '/绝对路径/agent-token.json'
    toolCallTimeoutMs: 300000
    maxInstructionBytes: 32768
    failOnStartupError: false
    reconnect:
      enabled: true
      initialDelayMs: 500
      maxDelayMs: 30000
      maxAttempts: 10
```

### 7.4 手工验证 MCP server

先确保 Runtime 已启动，然后：

```bash
export REPO="$HOME/CircuitPilot-AI-PCB-CONTROL"
export TOKEN_FILE="$HOME/Library/Application Support/CircuitPilot/agent-token.json"

CIRCUITPILOT_RUNTIME_URL=http://127.0.0.1:4178 \
CIRCUITPILOT_AGENT_TOKEN_FILE="$TOKEN_FILE" \
node "$REPO/agent/mcp-server.mjs" --print-config
```

`--print-config` 只输出脱敏配置到 stderr；stdout 是 MCP JSON-RPC 通道，不要用普通 `curl` 直接测 stdio。

### 7.5 可选：Streamable HTTP

只在需要时启用，且必须绑定回环：

```bash
TOKEN_DIR="$HOME/Library/Application Support/CircuitPilot"
mkdir -p "$TOKEN_DIR"
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex') + '\n')" \
  > "$TOKEN_DIR/mcp-http-token"
chmod 600 "$TOKEN_DIR/mcp-http-token"

CIRCUITPILOT_AGENT_TOKEN_FILE="$TOKEN_DIR/agent-token.json" \
node "$REPO/agent/mcp-server.mjs" \
  --http --http-host 127.0.0.1 --http-port 4180 \
  --http-token-file "$TOKEN_DIR/mcp-http-token"
```

Endpoint：`http://127.0.0.1:4180/mcp`，需 `Authorization: Bearer <mcp-http-token>`；健康检查 `http://127.0.0.1:4180/health`。不要把 4180 暴露到局域网。

---

## 8. 启动顺序（每次开机/重启后）

按这个顺序做，避免“工具能调用但 EDA 没连上”：

1. 启动嘉立创EDA专业版（确认 `run-api-gateway` 已安装、外部交互权限已开）；
2. 完全退出旧 EDA 后，以 `--remote-debugging-port=9222` 重启；
3. 启动 CircuitPilot（桌面应用，或 `npm run dev:full`）；
4. 确认 `http://127.0.0.1:4178/api/health` 正常；
5. 在 CircuitPilot 中打开测试工程，点击“刷新本机状态/检测 EDA”；
6. 启动/切换 DSH 的 `cp-test` profile；
7. 在 DSH 中调用 `cp_status` 做只读检查；
8. 需要写入时，按第 10 节重新生成计划并取得用户批准。

> 顺序不要反：先 EDA 再 CircuitPilot，通常更容易让 CDP/桥稳定连接。

---

## 9. 第一次验收：只读，不写

### 9.1 Runtime

```bash
curl -fsS http://127.0.0.1:4178/api/health
```

### 9.2 EDA CDP

```bash
curl -fsS http://127.0.0.1:9222/json/version
curl -fsS http://127.0.0.1:9222/json/list | head
```

### 9.3 DSH 工具

```text
使用 circuitpilot skill，依次调用：
cp_status
cp_project_context
cp_issues(limit=10)
只读，不生成计划、不执行、不修改设置。
```

### 9.4 通过标准

- [ ] `cp_status` 返回 `ok: true`；
- [ ] Runtime 为 `127.0.0.1:4178`；
- [ ] EDA/CDP 检测正常（或明确报告未连接，不能伪造）；
- [ ] 当前工程/文档身份与 EDA 界面一致；
- [ ] `cp_issues` 返回真实 issue 列表或明确为空；
- [ ] 没有执行任何写入、导出、下单、签核。

**没有通过上述只读验收，不允许进入写入。**

### 9.5 写入验收（只有测试工程）

1. 用**专用空白测试工程**，不要用生产板；
2. 让 DSH 生成计划（`cp_design_plan` / `cp_pcb_plan`），先只展示 `planHash`、`missing`、风险、假设；
3. 用户明确说“批准这个计划”后，模型才能 `cp_approve({planHash, confirm:true})`；
4. 用户明确说“执行”后，模型用唯一 `requestId` 调 `cp_execute`，再用 `cp_job` 等待；
5. 完成后 `cp_validation` 读 ERC/DRC/门禁证据；
6. 任一步失败：停止，不要自动重试写入；按结果回滚/检查，保留证据；
7. 写入后必须回读并保存；不允许“看起来成功”就宣布完成。

---

## 10. 安全与审批边界（AI 必须遵守）

- **只读优先**：没有明确需求，不生成写计划。
- **计划先行**：任何写入必须先出计划并完整展示 `planHash` / `missing` / 风险 / 假设。
- **人工批准**：只有用户在当前对话明确批准后才能 `cp_approve({planHash, confirm:true})`；AI 不能自批。
- **一次性**：批准绑定 `planHash`、目标指纹、单次执行；过期/目标漂移/写锁未释放时停止。
- **不重放**：写入超时、取消、结果未知时，先 `cp_status` / `cp_job` / `cp_evidence` 检查，不能自动重放。
- **不代签**：不签核、不确认订单、不改 Provider/研究配置、不释放写暂停、不绕过审批链。
- **不伪造**：没有证据就报告“未验证”；截图/DRC/回滚失败也要如实记录。
- **不泄密**：token/API key 不进对话、日志、Git；不把 4178/9222/49620 暴露到 LAN。
- **生产隔离**：首次写入必须在专用测试工程；生产板由用户自己承担判断。

---

## 11. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `dsh: command not found` | CLI 不在 PATH | 用应用内 CLI 绝对路径；macOS 默认在 `DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` |
| 插件列表没有 dsh-circuitpilot | 安装成功但未重载/未挂载 | 重启 DSH；检查 profile 插件配置；必要时把插件目录复制到 profile 的 `node_modules/dsh-circuitpilot`（保留 `skills/circuitpilot/SKILL.md`） |
| skill catalog 没有 `circuitpilot` | 插件未运行或包不完整 | 确认插件运行；检查 `plugin/dsh-circuitpilot/skills/circuitpilot/SKILL.md` 存在；重启宿主 |
| `RUNTIME_UNREACHABLE` | CircuitPilot 没启动/端口不对 | 启动 CircuitPilot；`curl http://127.0.0.1:4178/api/health`；检查 4178 占用 |
| `AGENT_TOKEN_MISSING` | token 文件路径不对/未生成 | 启动 Runtime 让其生成；显式设置 `CIRCUITPILOT_AGENT_TOKEN_FILE`；不要手工创建空文件 |
| `AGENT_TOKEN_INVALID` | token 被轮换/损坏 | 重启 CircuitPilot 重新生成；不要复用旧 token |
| `EDA_CONNECTED false` / 未连接 | EDA 没开调试口/扩展没装/权限没开 | 检查 9222；安装 `run-api-gateway`；开启外部交互权限；完全重启 EDA |
| `BRIDGE_NOT_FOUND` | 本地桥没起/端口占用 | 退出 EDA 和 CircuitPilot 后重开；检查 49620–49629 |
| 多个 EDA 窗口 | 打开了多个工程/实例 | 只保留一个目标实例；在 CircuitPilot 中人工选择目标窗口 |
| `APPROVAL_REQUIRED` / `PLAN_REQUEST_EXPIRED` | 没有批准/计划过期 | 重新生成计划，展示给用户，等明确批准；不要绕过 |
| MCP 工具名不存在 | MCP server 未启动/配置路径错 | 用 `--print-config` 检查；确认 `serverName: circuitpilot`；查看 DSH 日志 |
| Windows 构建失败 | 缺 MSVC C++/WebView2/Rust MSVC | 安装 VS Build Tools C++、WebView2、`rustup default stable-msvc`；用 x64 shell |
| Ubuntu 构建失败 | 缺 WebKitGTK 等 Tauri 依赖 | 安装第 3.4 节 apt 依赖；确认 Rust stable |
| EDA 扩展广场找不到 `run-api-gateway` | 版本/地区/市场不可用 | 升级到官方专业版并确认扩展市场；**不要**从非官方来源安装或绕过权限；报告用户 |

---

## 12. 给 AI 的最终执行清单（可直接照做）

复制以下清单，逐项执行并记录输出；任何一项失败就停止并报告。

```text
PHASE 0 — 识别环境
[ ] uname -a / ver / lsb_release -a，确认 macOS/Windows/Ubuntu
[ ] node -v >= 22；git --version；npm -v
[ ] 确认目标系统是否有官方嘉立创EDA专业版桌面客户端
[ ] 如果目标是 Windows/Ubuntu：明确告知用户“EDA 落板链路未验收，不能承诺同等能力”

PHASE 1 — CircuitPilot
[ ] git clone 仓库并 git checkout main
[ ] npm ci
[ ] 检查 plugin/dsh-circuitpilot/index.mjs、agent/mcp-server.mjs、runtime/server.mjs
[ ] macOS：npm run dev:full 或启动 .app；Windows/Ubuntu：npm run dev:full（桌面构建可选）
[ ] curl http://127.0.0.1:4178/api/health 成功

PHASE 2 — EDA
[ ] 安装/登录嘉立创EDA专业版
[ ] 扩展广场安装 run-api-gateway（API Gateway）
[ ] 开启外部交互权限 / External Interaction Permission
[ ] 完全退出 EDA，以 --remote-debugging-port=9222 重启
[ ] curl http://127.0.0.1:9222/json/version 成功
[ ] 确认 49620–49629 本地桥监听（CircuitPilot 自动启动）

PHASE 3 — DSH 插件/Skill
[ ] dsh --version 或应用内 CLI 可用
[ ] dsh plugin --profile cp-test add "link:<REPO>/plugin/dsh-circuitpilot"
[ ] 重启/切换 cp-test profile
[ ] 插件列表出现 dsh-circuitpilot 且运行中
[ ] skill catalog 出现 circuitpilot
[ ] 设置 agentTokenFile 为当前系统真实路径（或 CIRCUITPILOT_AGENT_TOKEN_FILE）

PHASE 4 — 只读验收
[ ] DSH 调用 cp_status -> ok:true
[ ] cp_project_context -> 当前项目/EDA 身份正确
[ ] cp_issues(limit=10) -> 真实结果
[ ] 不执行任何写入/导出/下单/签核

PHASE 5 — 汇报
[ ] 报告操作系统、CircuitPilot 启动方式、插件版本、EDA 扩展状态
[ ] 明确区分“已验证”和“未验证”
[ ] Windows/Ubuntu：只报告“已安装/待真机 EDA 验收”，不报告“同等能力已完成”
```

---

## 13. 路径与命令速查

### 13.1 token / 状态目录

| 系统 | agent token |
|---|---|
| macOS | `~/Library/Application Support/CircuitPilot/agent-token.json` |
| Windows | `%APPDATA%\CircuitPilot\agent-token.json` |
| Linux | `$XDG_STATE_HOME/circuitpilot/agent-token.json`，缺省 `~/.local/state/circuitpilot/agent-token.json` |

桌面应用状态目录通常为：
- macOS：`~/Library/Application Support/com.circuitpilot.desktop/state`
- Windows/Linux：Tauri 对应 app data 目录（以应用诊断输出为准）

**不要**把 token 原文复制到 profile、日志、Git 或聊天。

### 13.2 常用命令

```bash
# health
curl -fsS http://127.0.0.1:4178/api/health

# CDP
curl -fsS http://127.0.0.1:9222/json/version
curl -fsS http://127.0.0.1:9222/json/list | head

# bridge 端口
lsof -nP -iTCP:49620-49629 -sTCP:LISTEN

# DSH 插件
dsh plugin --profile cp-test add "link:$HOME/CircuitPilot-AI-PCB-CONTROL/plugin/dsh-circuitpilot"
dsh web --profile cp-test

# MCP 配置检查
CIRCUITPILOT_AGENT_TOKEN_FILE="$HOME/Library/Application Support/CircuitPilot/agent-token.json" \
  node agent/mcp-server.mjs --print-config
```

### 13.3 关键文件

| 文件 | 作用 |
|---|---|
| `plugin/dsh-circuitpilot/` | DSH 原生插件 + `circuitpilot` skill |
| `plugin/dsh-circuitpilot/skills/circuitpilot/SKILL.md` | skill 定义 |
| `agent/mcp-server.mjs` | MCP stdio/HTTP server |
| `agent/dsh-profile.example.yml` | MCP profile 示例 |
| `runtime/server.mjs` | Runtime 入口 |
| `docs/guides/user-manual.zh-CN.md` | 人类版操作手册（EDA/安全/边界） |
| `docs/agent/cross-platform-support.md` | Windows/Ubuntu 能力矩阵与限制 |

---

## 14. 已知限制（必须向用户说明）

1. **Windows/Ubuntu 没有经过本环境真机 EDA 验收**；当前只能证明代码/构建适配和 macOS 链路。
2. **Ubuntu 是否能用官方嘉立创EDA专业版桌面客户端尚未确认**；没有就不要承诺落板能力。
3. **非 macOS 的窗口截图兜底**会显式返回 `EDA_WINDOW_CAPTURE_UNSUPPORTED`，不会伪造截图；可改用 CDP 截图，但不能假装等价。
4. **Windows/Linux 凭据存储**目前是 AES-256-GCM 本地加密文件，不是 Windows DPAPI / Linux Secret Service；安全性低于 macOS Keychain，发布前需替换。
5. **签名/公证/安装包**按系统分别处理；当前没有与 macOS 等价的 Windows/Linux 正式签名发布。
6. **CircuitPilot 不做**：自动下单、付款、签核、生产放行；证据不足时门禁保持阻断是设计行为。
7. **旧 release 可能不含 MCP**：以源码 `main`/本文件的文件存在性检查为准。

---

**完成定义：** 只有当第 9.4 节只读验收全部通过，并且第 12 节 PHASE 5 已如实汇报，才可以把“安装与联通”标记为完成。写入能力必须另按第 9.5/10 节审批和验收，不能一并声称完成。
