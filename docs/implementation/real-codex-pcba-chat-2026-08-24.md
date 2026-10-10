# 真实 Codex PCBA 需求对话实施记录

日期：2026-08-24  
OpenSpec 变更：`add-real-codex-pcba-chat`

## 实施结果

- AI 页面已从“模拟计划输入”改为连续 PCBA 需求聊天工作台。
- 本机 Runtime 通过 Codex App Server stdio 协议复用已登录的 ChatGPT/Codex 账号。
- 每轮会话携带受限的项目、需求、BOM、资料元数据和嘉立创EDA固定只读证据。
- Codex 最终回复由 JSON Schema 约束，并在 Runtime 再次验证与归一化。
- AI 需求建议默认待确认；接受后才新增或更新需求，同时记录修改日志与审计事件。
- 支持快捷问题、Enter发送、Shift+Enter换行、发送中禁用、失败重试和确认后新建对话。
- 应用状态升级为 schemaVersion 3，并保留 v2/v1 本地状态迁移。

## 安全边界

- Codex thread 使用 `read-only` 沙箱、`approvalPolicy: never`，网络关闭。
- Runtime 不向 Codex 注册任何 EDA 或本机动态工具；审批/工具请求会被拒绝。
- EDA 证据只来自 `project.current` 和 `document.current` 两个固定 allowlist 命令。
- 浏览器不接触 Codex 凭据、API Key或内部thread ID。
- AI建议不能自动写入需求，更不能触发原理图或PCB写入。
- 未连接 EDA 窗口时返回明确 `unavailable`，不会把 Demo 数据冒充真实回读。

## 已验证证据

- `npm run typecheck`：通过。
- `npm run build`：通过，Vite生产构建完成。
- 前端单元测试：16/16通过。
- Runtime非HTTP测试：Bridge、聊天、日志和Provider共12项通过；其中聊天覆盖成功、账号未就绪、超时恢复、上下文限额、无效输出与EDA降级。
- Runtime HTTP端点：使用正在运行的0.3.0服务完成真实 `/api/chat/status` 与 `/api/chat/sessions/:id/messages` 冒烟测试。
- 真实 Codex 冒烟：CLI 0.148.0、`Logged in using ChatGPT`；返回自然语言答复、关键追问和1条待确认结构化建议。
- 嘉立创EDA Bridge冒烟：Bridge在线但当时窗口数为0；真实聊天准确返回“没有已连接的EDA窗口”，未执行写命令。
- Playwright：11/11通过，覆盖聊天发送、追问、建议接受、失败重试、新建会话、可访问性和全站回归。
- E2E报告：`.auto-coding/testing/reports/20260824_172330_e2e.md`。

## 已知限制

- 受当前执行环境的回环随机端口权限限制，最终一次完整 `npm test` 中的3项HTTP server测试无法绑定临时端口；同一轮的其余12项Runtime测试通过，真实0.3.0 Runtime端点与11项E2E另行验证通过。
- 当前嘉立创EDA没有连接窗口，所以没有获取到真实工程/文档内容；这不改变只读命令边界已经验证的事实。
- Rust/Cargo尚未安装，Mac `.app` / `.dmg`仍未构建。
- App Server协议在当前Codex版本中仍属于实验接口，升级CLI后应重新生成协议schema并执行兼容性测试。

## 经验总结

1. AI电路设计入口必须将“对话建议”和“工程写入”拆开：自然语言可以开放，结构化状态必须人工确认，EDA写入继续由独立审批门控制。
2. 让Runtime主动聚合固定只读EDA证据，比把任意EDA工具交给模型更容易审计，也能在Bridge或窗口不可用时可靠降级。
3. 使用模型端 `outputSchema` 与Runtime二次校验的双重约束，可以避免前端把自由文本误当成可执行需求变更。
4. 本地账号登录状态、Runtime就绪、Bridge在线和EDA窗口连接是四个不同状态，界面必须分别表达，不能用一个“已连接”笼统代替。
