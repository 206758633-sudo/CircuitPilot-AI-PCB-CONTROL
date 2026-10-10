# CircuitPilot · AI PCBA 控制台

CircuitPilot 是面向个人硬件工程师的 Mac 本地控制软件原型。当前版本已经把 React 控制台接到本机 Runtime，可使用已登录的 Codex 账号进行真实 PCBA 需求对话和结构化简单板计划生成，并检查 Codex、Claude Code、API Key、嘉立创EDA专业版和 EasyEDA Bridge。

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
   - OpenAI API：Key 由 Runtime 写入 macOS 钥匙串。
   - Claude Code个人账号：仅用于用户自己的本机工作流。
   - Anthropic API：适合后续可分发产品。
   - Demo本地模拟：Runtime离线时的显式降级模式。
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

1. 保持 `npm run dev:full` 运行，并在“系统设置”确认“Codex账号”测试通过。
2. 进入“AI 对话”，输入板卡功能、接口、电源、尺寸、环境、法规或制造要求。
3. 每轮发送时，应用只会提供：当前项目元数据、结构化需求、BOM行、资料名称/版本/状态，以及固定嘉立创EDA只读证据。
4. Codex 会返回自然语言答复、优先追问和结构化需求建议。
5. 需求建议默认处于“待确认”；点击“接受并写入”才会更新需求库，并写入修改日志与审计记录。点击“拒绝”不会修改需求。
6. “新建对话”会结束当前 Runtime 会话并清空可见聊天，但不会删除已经接受的需求。

聊天 Runtime 使用 `codex app-server --listen stdio://`，复用本机 ChatGPT/Codex 登录态。线程固定为只读沙箱、禁止审批、禁止网络与工具请求，不向 Codex 暴露嘉立创EDA任意执行接口。

## 凭据与撤销

- 浏览器只保存Provider ID、模型、安全策略与就绪摘要。
- API Key保存在macOS钥匙串：
  - `com.circuitpilot.provider.openai`
  - `com.circuitpilot.provider.anthropic`
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
- 会话令牌只发给受信任的浏览器来源（`http://127.0.0.1:4177` 等开发端口，或 Tauri WebView 的 `tauri://localhost`）。不带 `Origin` 的本机进程调用 `/api/health` 只会拿到 `ok:true`，不会拿到令牌。
- Host 头必须是回环地址，防止 DNS 重绑定；非回环 Host 返回 `403 HOST_FORBIDDEN`。
- Tauri 壳层可以用环境变量 `CIRCUITPILOT_RUNTIME_TOKEN` 注入令牌，使令牌完全不经过 HTTP 分发。
- 已知残余风险：本机同用户的任意进程都能伪造 `Origin` 头。要彻底消除需要改用 Unix 域套接字或 Tauri IPC 传递身份，属于后续架构项。

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
npm run desktop:dev
npm run desktop:build
```

本机 Rust/Cargo 已安装（1.98.0），`npm run desktop:check` 通过。但仓库里最新的 `CircuitPilot_0.2.0_aarch64.dmg` 生成于 2026-08-25 18:25，早于此后对 `src/` 的修改；修复前 `npx tsc -b` 有 18 处类型错误，会让 `npm run build` 与 `beforeBuildCommand` 直接失败，所以不存在对应当前源码的桌面包。本次修复已让 typecheck 恢复通过，但没有在本次变更中重跑完整的 `tauri build`，因此桌面包仍未按当前提交验收。Web构建成功不会被当作桌面包成功。发布版还需要把Node Runtime打包为受控Sidecar并完成Apple签名与公证。

## 验证

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
openspec validate integrate-real-ai-eda-runtime
openspec validate add-real-codex-pcba-chat
openspec validate implement-controlled-simple-board-design --strict
```

回环端口测试和Playwright在受限沙箱中需要本机网络/浏览器权限。

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
- `openspec/changes/integrate-real-ai-eda-runtime/`：本次真实接入的proposal、design、specs和tasks。
- `openspec/changes/add-real-codex-pcba-chat/`：真实PCBA需求对话的proposal、design、specs、tasks和实施记录。
- `openspec/changes/implement-controlled-simple-board-design/`：P0简单控制板端到端受控设计的OpenSpec产物与任务清单。

## 仍未完成的生产能力

- 首次真实快照/恢复演练及 MCU、电源、LED、按键现场写入尚未执行；仍缺用户确认的专用空白工程和精确嘉立创EDA器件库身份。
- Claude Code、OpenAI API与Anthropic API尚未接入真实聊天会话。
- P0 尚未自动从确认后的器件/引脚证据编译完整连线 operations；计划不完整时会保持阻塞。
- Node Runtime尚未作为自包含Sidecar进入签名的Mac安装包。
- 没有有效OpenAI/Anthropic Key时，不会伪造API连接测试成功。
- 没有真实Bridge窗口时，不会把Demo响应标成真实EDA结果。
