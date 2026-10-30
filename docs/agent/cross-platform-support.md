# CircuitPilot 跨平台支持（Windows / Ubuntu）现状

生成时间：2026-10-30  
状态：**代码级跨平台地基已加入；Windows/Ubuntu 真机 EDA 尚未验收，不能宣称与 macOS 同等 AI 设计能力。**

## 1. 结论先说

- **UI、Runtime、DSH 插件、MCP、Agent 计划/审批/证据链**：基于 Node.js + React + Tauri，本身是跨平台的；本轮把 macOS 硬编码路径、进程启动、凭据存储、sidecar 文件名等做了适配。
- **AI 设计能力的关键不在 UI，而在“Runtime ↔ 嘉立创EDA ↔ Bridge/CDP”链路**：当前只有 macOS 做过真机验证。Windows/Ubuntu 能否达到同等能力，取决于：
  1. 对应系统是否有可用的嘉立创EDA专业版桌面客户端；
  2. Run API Gateway / EasyEDA Bridge 扩展是否能在该客户端加载；
  3. 是否能以调试端口启动并稳定执行 CDP 点击、源码读写、保存、DRC、回滚；
  4. 是否有真实板卡做过端到端验收。
- 因此：**不能仅凭代码适配就承诺“Windows/Ubuntu 与 Mac 完全一样”。** 当前正确表述是：
  - **核心控制台/Agent/Runtime：可跨平台运行（Windows/Linux 待真机验证）；**
  - **AI 设计落板能力：macOS 已验证；Windows 有较高可行性但未验收；Ubuntu 取决于官方 EDA Linux 支持，当前不能保证。**

## 2. 本轮已落的跨平台代码

| 领域 | 变更 | 状态 |
|---|---|---|
| 用户数据目录 | macOS `~/Library/Application Support/CircuitPilot`；Windows `%APPDATA%\\CircuitPilot`；Linux `$XDG_STATE_HOME/circuitpilot`（缺省 `~/.local/state/circuitpilot`） | 已实现，单测覆盖 |
| Agent token 路径 | 按平台落用户数据目录，仍支持 `CIRCUITPILOT_AGENT_TOKEN_FILE` 覆盖 | 已实现 |
| EDA 应用发现 | macOS `.app`、Windows `.exe`、Linux 常见安装目录/AppImage；支持 `CIRCUITPILOT_EDA_APP_PATH` 显式覆盖 | 已实现，单测覆盖 |
| EDA 启动 | macOS `Contents/MacOS/LCEDA-Pro`；Windows 直接启动 `.exe`；Linux 启动候选二进制；统一 `--remote-debugging-port` | 已实现，真机未验收 |
| 系统浏览器打开 | macOS `open`、Windows `cmd start`、Linux `xdg-open` | 已实现 |
| 凭据存储 | macOS 继续用 Keychain；Windows/Linux 用 AES-256-GCM 加密本地文件回退（不是 OS 凭据库） | 已实现，安全性低于 macOS Keychain |
| 窗口截图兜底 | macOS 继续用 `screencapture`；Windows/Linux 显式返回 `EDA_WINDOW_CAPTURE_UNSUPPORTED`，不伪造截图 | 已 fail-closed |
| Tauri 打包目标 | 改为平台默认 `all`；新增 `desktop:build:windows/linux/macos` 脚本 | 已改，需在目标系统构建 |
| sidecar | Windows 使用 `node-<triple>.exe`；Tauri 壳查找 `node.exe`；Rust 随机数改用跨平台 OS RNG | 已实现，macOS `cargo check` 通过 |
| 诊断 | 平台 id 不再硬编码 `macos`；EDA 候选按平台生成 | 已实现 |

关键文件：`runtime/platform.mjs`、`runtime/portable-keychain.mjs`、`runtime/keychain.mjs`、`runtime/eda-gui.mjs`、`runtime/diagnostics.mjs`、`runtime/agent-token.mjs`、`src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`。

## 3. 能力对等矩阵

| 能力 | macOS | Windows | Ubuntu |
|---|---|---|---|
| React 控制台 / Vite | 已验证 | 代码可构建，未真机验收 | 代码可构建，未真机验收 |
| Runtime（Node） | 已验证 1441 测试 | Node 可运行，未跑完整真机 | Node 可运行，未跑完整真机 |
| DSH 插件 / MCP | 已验证 | 插件是 Node 代码，需重装/验收 | 同左 |
| AI 需求对话/计划/审批 | 已验证 | API 网络能力相同；需验收 | 同左 |
| EDA 应用发现/启动 | 已验证 | 候选路径已加；需真实安装验收 | 候选路径已加；需确认官方 Linux 客户端 |
| EasyEDA Bridge 连接 | 已验证（实验适配器） | 需在 Windows EDA 加载扩展并验收 | 取决于 Linux EDA/扩展支持 |
| CDP GUI 点击/快捷键 | 已验证 | Electron/Chromium 路径理论可行，未验收 | 未验收 |
| 源码快照/写入/回读/DRC | macOS 已验证（仍有 restore 摘要不一致缺陷） | 未验收 | 未验收 |
| 失败回滚/安全锁 | macOS 已验证失败关闭 | 未验收 | 未验收 |
| OS 凭据库 | macOS Keychain | 目前为加密文件回退，非 DPAPI | 目前为加密文件回退，非 libsecret |
| 窗口截图证据兜底 | 已验证 | 明确不支持（可走 CDP 截图） | 明确不支持（可走 CDP 截图） |
| 安装包/签名 | `.app`/`.dmg` | `.msi`/NSIS 待目标机构建与签名 | `.deb`/AppImage 待目标机构建与签名 |

## 4. 为什么不能直接说“跟 Mac 一样”

AI 设计能力不是“能打开网页”就够了，必须证明完整闭环：

1. AI 生成计划；
2. 读取真实工程/文档/器件/网络；
3. 人工批准绑定 planHash/窗口/文档；
4. 受控写入并保存；
5. 回读/DRC/证据；
6. 失败时可靠回滚或安全锁；
7. 多窗口、权限、凭据、安装包都正常。

其中第 2–6 步依赖 EDA 桌面客户端的具体版本和平台行为。当前仓库只对 macOS + 嘉立创EDA专业版 + 实验桥做过真机验证；Windows/Linux 还没有这些证据，所以不能签“同等能力”。

## 5. 建议验收顺序

### Windows（优先）

1. 在 Windows 安装嘉立创EDA专业版 + Run API Gateway/EasyEDA Bridge；
2. 用 `CIRCUITPILOT_EDA_APP_PATH` 指向真实 `.exe`，跑 `/api/diagnostics` 与 `/api/eda/discover`；
3. 用调试端口启动 EDA，验证 CDP 点击、保存、DRC；
4. 用**测试工程**跑一次只读全链路，再跑一次 create-only 写入，最后跑非创建变更回滚；
5. 通过后才更新“Windows 已验证”状态。

### Ubuntu

1. 先确认官方嘉立创EDA专业版是否有可用的 Linux 桌面客户端；若没有，不能承诺同等落板能力；
2. 若只有浏览器版，需要重新评估 Bridge/CDP 接入方式，不能假设与桌面 Electron 一致；
3. 有桌面客户端后按 Windows 同样顺序做真机验收；
4. 补齐 Linux 截图/凭据库/打包（WebKitGTK 依赖）后再谈发布。

## 6. 当前验证结果

- 新增平台/凭据单测通过；
- Runtime 全量测试 **1441/1441 PASS**；
- `npm run typecheck` 通过；
- `npm run build` 通过；
- `cargo check` 通过（macOS）；
- **Windows/Ubuntu 真机 EDA：未验证**；
- **正式发布/签核：仍受人工门禁阻断。**

在 Windows/Ubuntu 真机验收完成前，本项目只能声明“已加入跨平台代码适配”，不能声明“Windows/Ubuntu 已具备与 macOS 相同的 AI 设计能力”。
