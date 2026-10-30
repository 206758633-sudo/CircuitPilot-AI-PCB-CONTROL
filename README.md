# CircuitPilot · AI PCBA 控制台

CircuitPilot 是面向个人硬件工程师的本地优先 AI PCBA 控制台；macOS 已完成真机验证，Windows/Ubuntu 已加入代码级跨平台适配，但真机 EDA 能力尚未验收。当前版本已经把 React 控制台接到本机 Runtime，可使用已登录的 Codex 账号进行真实 PCBA 需求对话和结构化简单板计划生成，并检查 Codex、Claude Code、API Key、嘉立创EDA专业版和 EasyEDA Bridge。

> 平台状态：macOS 已验证；Windows/Ubuntu 的 UI/Runtime 可构建，但 EDA 落板链路尚未真机验收，不能宣称与 macOS 同等 AI 设计能力。详见 [`docs/agent/cross-platform-support.md`](docs/agent/cross-platform-support.md)。

> 让 AI 自动安装并配好 DSH 插件、skill、MCP 和嘉立创EDA：见 **[`INSTALL_AI.md`](INSTALL_AI.md)**（含 macOS/Windows/Ubuntu 分支、检查点和安全卡点）。

当前安全边界：Runtime 已实现受控原理图写入框架，但默认仍关闭。只有精确器件身份和连接计划完整、已读取真实目标、计划哈希经人工批准、源码快照成功时才允许执行；随后必须保存、按 primitive ID 回读并通过嘉立创EDA官方原理图 DRC（ERC 等效），失败会用源码快照恢复。首次现场执行仍必须使用用户确认的专用空白测试工程。

## 一键开发启动

```bash
npm install
npm run dev:full
```

- 控制台：<http://127.0.0.1:4177>（`vite.config.ts` 固定端口且启用 `strictPort`，端口被占用时会直接失败而不是静默换端口）
- 本机 Runtime：<http://127.0.0.1:4178/api/health>
- Tauri 桌面壳层的 `devUrl` 同样指向 4177

`dev:full` 会同时启动 Vite 和只监听 `127.0.0.1` 的 Runtime，并在退出时清理两个子进程。

## 首次配置

1. 进入“系统设置”，点击“刷新本机状态”。
2. 选择一种 Provider：
   - Codex账号：使用本机 Codex CLI 官方登录，不读取账号密码。
   - Claude Code个人账号：仅用于用户自己的本机工作流。
   - Demo本地模拟：Runtime离线时的显式降级模式。
   - 官方 API：OpenAI API、Anthropic API，Key 由 Runtime 写入 macOS 钥匙串。
   - 第三方平台 API：DeepSeek、Moonshot/Kimi、智谱 GLM、阿里云百炼（通义千问）、
     硅基流动、火山方舟（DeepSeek）、百度智能云千帆（DeepSeek）、OpenRouter、
     Google Gemini、xAI Grok、Groq、Mistral。
     在 Provider 下拉框里按“国内平台 API / 国际平台 API”分组选择，
     点“去平台申请Key”可直接打开该平台的官方控制台；每个平台的 Key 在钥匙串里
     是独立条目，撤销某一个平台不会影响其它平台。
   - 第三方供应商平台的 DeepSeek 模型：选择任一托管 DeepSeek 的平台（官方/硅基流动/
     火山方舟/千帆/OpenRouter/阿里云百炼），保存该平台 Key 并选择具体模型即可直接
     作为 AI 后端；如果走企业网关或其它 OpenAI 兼容供应商，在“第三方供应商 Base URL”
     填入网关地址（HTTPS，本机回环可用 HTTP），Runtime 会向该地址的
     `/chat/completions` 发起请求。
   - 自定义 API（快捷槽）：Provider 选“自定义 API（OpenAI 兼容）”，直接填写 **API URL**、
     **API Key** 和 **模型名称** 三项。API URL 例如 `https://api.deepseek.com/v1`
     （Runtime 会请求 `{API URL}/chat/completions` 与 `{API URL}/models`），
     Key 只写入 macOS 钥匙串的 `com.circuitpilot.provider.custom` 条目，
     模型名称必须显式填写（没有 auto 默认值）。
   - 自定义模型 API（可注册多个）：在“系统设置 → 02 · AI PROVIDER → 自定义模型 API”
     页签里定义自己的 Provider（面板右上角有“自定义模型 API”直达按钮；Provider 下拉框里
     也有一项“＋ 新增自定义 Provider（地址/密钥/目录）…”可直接跳转）：**Provider ID**（小写字母开头，唯一标识，用于派生凭据名）、
     **显示名称**、**API 地址**、**API 协议**（OpenAI Chat Completions 或 Anthropic
     Messages）、**API 密钥**，以及**模型目录**（每个模型的 ID、显示名称、上下文窗口、
     最大输出 token 数、输入类型“文本/图片”、推理等级）。地址只接受 HTTPS 或本机回环 HTTP；
     保存后该 Provider 会出现在 Provider 下拉框的“自定义 API”分组，可直接作为 AI 后端。
     “获取可用模型”会用已保存的钥匙串 Key 请求 `{API 地址}/models`，把结果增量合并进
     模型目录（已手工填写的条目不会被覆盖）。配置持久化在 Runtime 的 state 目录
     `custom-providers.json`（开发模式下是 `artifacts/state/`；**打包版是
     `~/Library/Application Support/com.circuitpilot.desktop/state/`**，这样升级/重装不会丢配置；
     可用 `CIRCUITPILOT_STATE_DIR` 覆盖），文件里**只有公开配置**，不含任何密钥。
3. 点击“测试连接”。API 测试只读取模型列表；完整Key不会返回前端。
4. 打开嘉立创EDA专业版并确认 Run API Gateway / 外部交互已开启。
5. 启动 EasyEDA Bridge 后，进入“EDA控制”运行全量检查。
6. 若检测到多个窗口，必须人工选择目标窗口，才能运行固定命令。

## 简单控制板受控设计流程

1. 在“AI 对话”中补齐电源、接口、尺寸、环境、器件和制造约束，并逐条确认写入需求库。
2. 在“EDA控制”点击“AI生成候选计划”。Codex 只输出固定 JSON Schema；没有证据的 `libraryUuid`、`uuid` 和器件值必须留空。
3. 点击“读取真实设计”，Runtime 固定读取工程、文档、原理图目录、元件/引脚、导线及文档源码摘要。
4. 点击“校验计划”。任何 MCU、电源、LED、按键精确身份、网络或操作缺失都会阻止批准。
5. 点击“人工批准”。一次性令牌绑定计划 SHA-256、目标窗口、目标文档指纹、步骤和五分钟有效期。
6. 关闭“暂停写入”后点击“执行受控写入”。Runtime 串行完成源码快照、白名单写入、保存、primitive 回读和官方原理图 DRC。
7. 任一步失败后停止剩余动作；已发生修改时恢复源码、保存并核对恢复摘要。

P0 仅覆盖原理图，不代表 PCB 布局、布线、铺铜、Gerber/BOM/CPL 或下单已完成。嘉立创EDA文档源码和原理图 DRC API 均为 BETA，不能未经现场验证直接用于生产工程。

## 使用真实 AI 需求对话

有两种后端，任选其一，在“系统设置”的 Provider 里切换后保存：

- **Codex账号（本机 CLI 登录）**：适合本机个人工作流，沿用 ChatGPT/Codex 登录态。
- **第三方平台 API（含 DeepSeek 模型）**：保存平台 Key 后即可用于对话、生产计划和
  网络表生成，不再要求 Codex 登录。`auto` 模型会回落到平台声明的默认模型；没有默认
  模型的平台需要显式选择模型。内置第三方平台通道只支持文本附件（DeepSeek 系模型不支持
  图片），图片会得到明确的拒绝提示而不是被静默丢弃。
- **自定义模型 Provider**：模型是否支持图片由模型目录里的“输入类型”决定。勾选“图片”的
  多模态模型会把图片作为真实图片输入（base64 直传，不落盘、不经图床）；未勾选时同样
  明确拒绝而不是静默丢弃。模型 ID 必须在该 Provider 的模型目录里，Runtime 会拒绝目录外
  的模型并列出可用模型 ID。

1. 保持 `npm run dev:full` 运行，并在“系统设置”确认所选 Provider 测试通过。
2. 进入“AI 对话”，输入板卡功能、接口、电源、尺寸、环境、法规或制造要求。
3. 每轮发送时，应用只会提供：当前项目元数据、结构化需求、BOM行、资料名称/版本/状态，以及固定嘉立创EDA只读证据。
4. Codex 会返回自然语言答复、优先追问和结构化需求建议。
5. 需求建议默认处于“待确认”；点击“接受并写入”才会更新需求库，并写入修改日志与审计记录。点击“拒绝”不会修改需求。
6. “新建对话”会结束当前 Runtime 会话并清空可见聊天，但不会删除已经接受的需求。

聊天 Runtime 使用 `codex app-server --listen stdio://`，复用本机 ChatGPT/Codex 登录态。线程固定为只读沙箱、禁止审批、禁止网络与工具请求，不向 Codex 暴露嘉立创EDA任意执行接口。

## 凭据与撤销

- 浏览器只保存Provider ID、模型、安全策略与就绪摘要。
- API Key保存在macOS钥匙串，每个平台一个独立条目（`runtime/config.mjs` 的 `KEYCHAIN_SERVICES`）：
  - `com.circuitpilot.provider.openai` / `com.circuitpilot.provider.anthropic`
  - `com.circuitpilot.provider.deepseek` / `moonshot` / `zhipu` / `dashscope` / `siliconflow`
  - `com.circuitpilot.provider.ark` / `qianfan` / `custom`
  - `com.circuitpilot.provider.openrouter` / `gemini` / `xai` / `groq` / `mistral`
  - 自定义模型 Provider：`com.circuitpilot.provider.custom.<Provider ID>`（每个 Provider
    一个条目，撤销其中一个不影响其它 Provider；删除 Provider 配置时会一并删除该条目）。
- 自定义模型 Provider 的配置由 Runtime 权威持久化（`artifacts/state/custom-providers.json`，
  原子写、带 `schemaVersion`）：文件损坏时 Runtime 会大声降级为内存并拒绝写操作
  （503 `CUSTOM_PROVIDER_STORE_UNAVAILABLE`），不会把“读失败”伪装成“没有自定义 Provider”。
- 新增内置第三方平台只需三处声明：`runtime/providers.mjs` 的 `PROVIDERS`
  表（模型列表地址、OpenAI 兼容 `chatBaseUrl` 与默认模型）、`runtime/config.mjs` 的
  `KEYCHAIN_SERVICES`、`src/data/providerCatalog.ts` 的界面目录（分组、Key 申请入口、
  默认 Base URL 与模型建议）。API 对话通道在 `runtime/apiChat.mjs`，内置平台兼容
  `/chat/completions` 即可；自定义模型 Provider 另外支持 Anthropic Messages 协议
  （`/messages` + `x-api-key` + `anthropic-version`），协议差异只在 `apiChat.mjs` 收口，
  `server.mjs` 与前端路由不需要为每个网关写分支。
- “第三方供应商 Base URL”是请求级覆盖值，只接受 HTTPS 或本机回环 HTTP；不允许 URL
  内嵌账号密码。Key 仍只出现在请求头里，不会进入 URL、日志和错误信息。
- 鉴权头由 `authHeaders()` 统一生成（Bearer / `x-api-key` / `x-goog-api-key`），
  Key 不会出现在 URL、日志和错误信息里。
- 在设置页点击“撤销Key”可明确删除对应钥匙串项。
- 重置本地工作区不会删除钥匙串凭据，避免无提示破坏账号配置。

## EasyEDA Bridge

Runtime扫描 `127.0.0.1:49620-49629`，只有 `/health` 返回 `service: "easyeda-bridge"` 才接受。当前真实命令注册表：

- `project.current` → `DMT_Project.getCurrentProjectInfo()`
- `document.current` → `DMT_SelectControl.getCurrentDocumentInfo()`
- `schematic.catalog/components/wires` → 固定原理图目录与 primitive 回读
- `document.source.read/restore` → `SYS_FileManager.getDocumentSource/setDocumentSource`
- `schematic.component.create`、`schematic.netFlag.create`、`schematic.wire.create` → 固定类型化原理图写入
- `schematic.save` → `SCH_Document.save()`
- `schematic.drc` → `SCH_Drc.check(true, false, true)`

前端不能提交任意JavaScript。Runtime 只执行白名单里登记的类型化命令，而且计划参数会先逐字段做类型校验、再用 JSON 字面量序列化后才拼成下发给扩展的调用，因此字符串参数无法截断语句注入代码（回归测试见 `runtime/__tests__/bridge.test.mjs`）。未注册命令、直接运行写命令、无有效批准、计划被修改、令牌重放、目标漂移或快照失败都会被拒绝。

### Runtime 访问控制

- `GET /api/health` 是唯一公开路由；其余路由（含只读 GET）都要求 `x-circuitpilot-token`。
- Host 头必须是回环地址，防止 DNS 重绑定；非回环 Host 返回 `403 HOST_FORBIDDEN`。
- 令牌有且只有两条不经由 HTTP 的交付通道：
  1. **生产/桌面模式（默认）**：Tauri 壳层为每次启动生成一次性令牌，经 **stdin 管道**
     交给 sidecar（同时设置 `CIRCUITPILOT_TOKEN_STDIN=1`），并用
     `WebviewWindowBuilder::initialization_script` 在页面脚本执行前注入
     `window.__CIRCUITPILOT_RUNTIME_TOKEN__`。
     **为什么不放环境变量**：环境变量会进入 `ps -E` 可见的进程环境、崩溃转储与
     `launchd` 相关工具链，属于"本机同用户进程可读"的暴露面；管道内容不落在
     argv、环境变量或磁盘上。启动日志会记录令牌来源（只记 `source`，不记令牌本身），
     可据此核实发布版走的是哪条通道。
     若壳层声明用管道但管道没送到，Runtime 会**拒绝启动**（fail closed），
     而不会退化成"随机令牌 + HTTP 发放"把已关闭的攻击面重新打开。
  2. **开发/测试模式**：`CIRCUITPILOT_RUNTIME_TOKEN` 环境变量或浏览器引导（见下一条）。
     这条通道仅用于本机开发与自动化测试，发布版不使用。
- **一旦令牌由壳层注入，Runtime 会彻底关闭 HTTP 令牌发放**：`/api/health` 不再返回 `sessionProof`，
  因此本机其它进程即使伪造 `Origin` 也领不到令牌（回归测试见 `runtime/__tests__/server.test.mjs`
  的 “injected shell token disables HTTP token issuance entirely”）。
- 只有在没有注入令牌的开发模式（`npm run dev:full`，浏览器直连）下，才回退到「随机令牌 + 受信 Origin 引导」，
  且不带 `Origin` 的本机进程调用 `/api/health` 只会拿到 `ok:true`，不会拿到令牌。
- 若本机已经有一个外部 Runtime 在跑（例如先执行了 `npm run dev:runtime`），壳层无法得知它的令牌，
  此时不注入令牌，前端回退到上述开发模式引导，以免破坏开发流程。
- 残余暴露面（如实说明）：令牌仍需经回环 HTTP 请求头 `x-circuitpilot-token` 从 WebView 送到 Runtime，
  在 macOS 上抓取回环流量需要 root/BPF 权限。要连这一层也消除，就得把前端全部流量改为
  Unix 域套接字或 Tauri IPC 代理——那是架构级改动，会让每个请求改道；对"同用户非特权进程"
  这一威胁模型，stdin 管道 + 关闭 HTTP 发放已经等价，因此当前没有采用 UDS/IPC。

## 修改日志与问题中心

“版本、日志与问题”包含四个视图：

- 版本时间线：快照、比较与Demo回滚事件。
- 修改日志：对象、操作者、原因、前值、后值及关系ID，最多500条。
- 问题中心：Runtime、Provider、EDA、AI和验证问题；重复指纹会聚合，最多300条。
- 审计日志：粗粒度业务事件，最多200条。

问题可以标记处理中、解决、重新打开或带原因忽略；诊断包会包含安全化的问题和修改记录，不包含API Key、Token或模型思维链。

## Mac 桌面壳层

仓库包含 Tauri 2 配置：[`src-tauri`](./src-tauri)。先检查工具链：

```bash
npm run desktop:check
```

工具链齐全后：

```bash
npm run desktop:dev     # tauri dev（beforeDevCommand 会先 dev:full）
npm run desktop:app     # 只产出 .app（不依赖 hdiutil，适合受限环境与 CI）
npm run desktop:build   # .app + .dmg
npm run desktop:release # 先跑发布门禁（签名/公证/sidecar/DMG 能力），再打包
```

Node Runtime 现在会作为受控 sidecar 打进应用包：`beforeBuildCommand` 会调用
`scripts/stage-runtime-sidecar.mjs`，把当前 Node 二进制瘦身到目标架构后放到
`src-tauri/binaries/node-<target-triple>`（由 Tauri 的 `externalBin` 复制到
`CircuitPilot.app/Contents/MacOS/node`）。因此发布版不再要求用户机器上装过 Node；
代价是安装包增大约 114 MB。

```bash
npm run sidecar:stage   # 单独重新生成 sidecar（已是最新时会跳过）
npm run desktop:release-check  # 发布门禁：工具链/版本一致性/sidecar/entitlements/签名/公证/DMG 能力
```

`desktop:release-check` 会把“`hdiutil` 无法创建磁盘映像”这类只有在打包最后一步才会暴露的问题提前报出来。
若它报告 `dmg-capability` 失败（受限或无 GUI 会话下属于预期），用 `npm run desktop:app` 只产出 `.app`。
Apple 签名与公证需要本机具备 Developer ID 证书与公证凭证（`APPLE_TEAM_ID` 及 App Store Connect API Key 或 Apple ID），
仓库本身无法提供这两项凭据，因此在缺少它们的机器上门禁会如实失败。

## 验证

```bash
npm run typecheck
npm run build
npm test                # typecheck + vitest + runtime(node:test)
npm run test:coverage   # 带覆盖率地板门禁（实测 行11.64%/分支8.15%/函数8.36%/语句9.84%，阈值取整向下设定）
npm run test:e2e
npm run desktop:release-check
openspec validate integrate-real-ai-eda-runtime
openspec validate add-real-codex-pcba-chat
openspec validate implement-controlled-simple-board-design --strict
```

回环端口测试和Playwright在受限沙箱中需要本机网络/浏览器权限。
版本号只有一个数据源：`runtime/version.mjs`，由 `runtime/__tests__/version.test.mjs`
强制校验 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 与之一致。

依赖审计注意：若本机 npm registry 指向 npmmirror，`npm audit` 会因该镜像未实现
`/-/npm/v1/security/*` 而报 `404 NOT_IMPLEMENTED`。这不是依赖问题，请用官方源复核：

```bash
npm audit --registry=https://registry.npmjs.org
```

`manufacturing/CircuitPilot-CH32V003-P0-3D.step`（约 13.8MB）直接入库，并用 `.gitattributes`
标记为二进制（禁止行尾转换与文本 diff）。当前只有个别大体积交付物，引入 Git LFS 会让所有
贡献者多出安装与拉取步骤而收益不足；若 STEP/STL 数量继续增长，再迁移到 LFS。

## 项目结构

- `runtime/`：回环HTTP Runtime、Provider、Keychain、Bridge、日志与诊断。
- `src/services/runtimeClient.ts`：渲染层类型化Runtime客户端。
- `src/pages/SettingsPage.tsx`：首次配置、账号/API、诊断和安全策略。
- `src/pages/EdaPage.tsx`：Bridge发现、窗口选择、完整读取、AI候选计划、审批和受控执行状态。
- `src/pages/AiTasksPage.tsx`：真实Codex需求对话、追问、建议确认与错误恢复。
- `runtime/codexAppServer.mjs`：Codex App Server stdio协议与只读会话管理。
- `runtime/chat.mjs`：上下文限额、固定EDA证据、结构化输出校验与聊天会话。
- `runtime/design.mjs`：计划规范化/哈希、一次性批准、目标指纹、快照、写入、回读、DRC和恢复编排。
- `src/pages/VersionsPage.tsx`：版本、修改日志、问题中心和审计。
- `src-tauri/`：Tauri 2桌面壳层骨架。
- `docs/implementation/README.md`：实现文档索引（新人先读 checklist → task-plan → automation-kernel，10 分钟找到链路验收入口）。
- `openspec/changes/integrate-real-ai-eda-runtime/`：本次真实接入的proposal、design、specs和tasks。
- `openspec/changes/add-real-codex-pcba-chat/`：真实PCBA需求对话的proposal、design、specs、tasks和实施记录。
- `openspec/changes/implement-controlled-simple-board-design/`：P0简单控制板端到端受控设计的OpenSpec产物与任务清单。

## 仍未完成的生产能力

- 首次真实快照/恢复演练及 MCU、电源、LED、按键现场写入尚未执行；仍缺用户确认的专用空白工程和精确嘉立创EDA器件库身份。
- Claude Code、OpenAI API与Anthropic API尚未接入真实聊天会话。
- P0 尚未自动从确认后的器件/引脚证据编译完整连线 operations；计划不完整时会保持阻塞。
- Node Runtime 现在会作为自包含 sidecar 打进 `.app`（见上文“桌面壳层”），但仍**未完成 Apple 签名与公证**：
  需要本机具备 Developer ID 证书与公证凭证，`npm run desktop:release-check` 会在缺少时如实失败。
- 没有有效OpenAI/Anthropic Key时，不会伪造API连接测试成功。
- 没有真实Bridge窗口时，不会把Demo响应标成真实EDA结果。
