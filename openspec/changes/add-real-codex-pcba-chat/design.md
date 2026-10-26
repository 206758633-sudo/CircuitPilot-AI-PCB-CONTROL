## Context

现有 React Demo 将任务目标交给 `demoAdapter`，没有真实模型调用。项目已经具备只绑定回环地址的 Node Runtime、Codex CLI 登录检测、Runtime 会话令牌、修改日志/问题中心，以及嘉立创EDA Bridge 的两个固定只读命令。本变更需要跨越前端状态、Runtime 协议和本机 Codex 进程，同时保持当前 EDA 零写入边界。

## Goals / Non-Goals

**Goals:**

- 使用已登录的 Codex 账号进行连续、真实的 PCBA 需求澄清。
- 把现有结构化项目资料和固定 EDA 只读证据作为每轮上下文。
- 让 AI 输出自然语言回复与可人工接受/拒绝的需求建议。
- 对凭据、上下文大小、并发、协议异常、审批请求和日志进行防护。

**Non-Goals:**

- 不在本变更中接入 Claude 或 API Key Provider 的真实聊天。
- 不让 Codex 直接读取任意工程文件、调用 Bridge 任意代码或写入嘉立创EDA。
- 不替换现有“计划审批—快照—执行—回读—验证”受控写入状态机。
- 不承诺模型输出等同于工程师签核。

## Decisions

### 1. 直接使用 Codex App Server 的 stdio 协议

Runtime 启动一个长生命周期的 `codex app-server --listen stdio://` 子进程，通过换行分隔 JSON 请求 `initialize`、`thread/start` 和 `turn/start`，并消费 `item/agentMessage/delta` 与 `turn/completed` 通知。使用安装版本生成的协议 schema 作为实现依据。

选择原因：App Server 复用本机 ChatGPT/Codex 登录态，支持连续 thread、结构化输出 schema 和完整生命周期事件，不需要把凭据传给浏览器。相比每轮执行 `codex exec`，它能保留会话；相比新增 SDK 依赖，直接协议减少依赖并更容易固定安全参数。

### 2. Runtime 聚合 EDA 证据，Codex 不获得 EDA 工具

每次发送前，Runtime 只调用 Bridge 已登记的 `project.current` 和 `document.current`，并将结果与前端传入的受限项目上下文合并。Codex 不注册动态工具，因此无法越过固定 allowlist。

### 3. 使用 `outputSchema` 约束最终回复

每轮 `turn/start` 传入固定 JSON Schema，结果包含 `reply`、`questions` 和 `requirementSuggestions`。Runtime 从最终 agent message 解析 JSON并再次进行字段、长度、枚举与数量校验。前端只消费归一化结构，不执行模型生成的命令或代码。

### 4. 用户确认后再修改结构化需求

AI 建议保存在聊天消息中，默认 `pending`。用户接受时由前端 reducer 创建或更新 `Requirement`，同时写入 audit/change log；拒绝仅改变建议状态。对现有需求的更新必须携带明确 target ID，否则降级为新增建议。

### 5. 前端持久化可见聊天，Runtime 仅持有 thread 映射

可见消息与建议随应用状态存入 localStorage；Codex thread ID 由 Runtime 会话映射维护，不在 UI 暴露。Runtime 重启后，前端保留历史，但下一轮安全地创建新 Codex thread，并把精简对话摘要随上下文提供。

## Risks / Trade-offs

- [App Server 协议仍标记 experimental] → 针对安装版本生成 schema，封装协议适配层，提供清晰版本/协议错误。
- [模型可能提出不正确的电路建议] → 所有建议保持 pending，明确 AI 建议不是工程签核，并保留来源和修改记录。
- [长上下文影响延迟或额度] → 限制消息、需求、BOM、资料数量和字段长度，仅发送必要元数据。
- [Runtime 重启造成 thread 丢失] → 保留 UI 历史，自动创建新 thread，并提示会话已重建。
- [Codex 意外发起工具/审批] → thread 使用 read-only + never approve；Runtime 不实现批准并把请求视为安全异常。

## Migration Plan

1. 扩展 schemaVersion 3 的聊天状态，并为 v2 持久化数据提供默认迁移。
2. 增加 Runtime Codex App Server 适配器和聊天端点；保留全部现有端点。
3. 将 AI 页面切换为“需求对话”主视图，同时保留只读边界提示。
4. 执行单元、Runtime 集成、类型、构建和 E2E 验证。
5. 若回滚，仅移除聊天路由/UI并将存储迁移回默认状态；既有项目、需求和日志数据保持兼容。

## Open Questions

- 后续受控写入版本是否复用同一 thread，还是将已确认需求生成独立、可签名的计划输入；本变更不提前决定。
- Claude Code 和 API Provider 的统一聊天协议将在其登录、计费与数据边界单独确认后设计。
