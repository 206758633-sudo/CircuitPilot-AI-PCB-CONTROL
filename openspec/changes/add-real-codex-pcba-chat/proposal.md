## Why

当前 AI 页面只能生成模拟计划，用户无法通过真实对话逐步补齐 PCBA 需求，也无法确认 AI 是否基于当前项目、BOM、约束和嘉立创EDA只读状态进行判断。需要把已登录的 Codex 账号接入本机 Runtime，形成可审计、可确认的需求澄清入口。

## What Changes

- 将 AI 页面改为真实的 Codex 对话工作台，支持连续会话、发送状态、错误恢复和新建会话。
- 每轮对话自动携带当前项目、需求、BOM、资料清单与嘉立创EDA固定只读回读结果。
- AI 返回自然语言答复、待追问问题和结构化需求建议；建议必须由用户逐条接受或拒绝后才更新需求库。
- 通过本机 Codex App Server 和现有 Codex 登录态调用模型，不在浏览器暴露凭据。
- 固定使用只读沙箱、禁止审批和任意 EDA 命令；本变更不触发真实嘉立创EDA写入。
- 记录聊天、建议采纳、异常与运行状态到现有审计、修改日志和问题中心。

## Capabilities

### New Capabilities

- `real-codex-pcba-chat`: 使用 Codex 账号进行连续 PCBA 需求澄清，并生成可确认的结构化需求建议。
- `chat-context-safety`: 安全汇总项目上下文和嘉立创EDA只读证据，隔离凭据、文件写入及任意命令执行。

### Modified Capabilities

无。

## Impact

- 前端：AI 页面、应用状态模型、Runtime 客户端、样式和测试。
- 本机 Runtime：Codex App Server 进程管理、聊天会话 API、响应结构校验、错误与日志处理。
- 外部系统：复用本机 Codex CLI 登录态；仅调用嘉立创EDA Bridge 已登记的只读命令。
- 不引入云端 API Key，不修改真实 EDA 工程，不改变现有受控写入状态机。
