# Why

项目总览只支持新建和归档，无法永久移除不再需要的应用内项目。AI需求对话只有一个全局会话，切换项目后会混用历史，无法按项目恢复上下文。

# What Changes

- 项目卡片增加“删除”操作和二次确认。
- 删除仅永久移除应用内项目数据及其专属AI会话记忆，不访问、修改或删除本机工程目录和嘉立创EDA工程。
- AI对话页增加项目选择器，切换时同步当前工作项目并恢复该项目历史。
- 将单一聊天状态迁移为按项目ID分区持久化的会话字典。
- “新建对话”只重置当前项目会话，不清除项目、需求或资料。

# Impact

- Frontend state schema: v3 -> v4.
- Affected files: state types, seed/migration/reducer, project overview, AI chat page, styles, reducer and E2E tests.
- Runtime chat API remains unchanged; each project owns a distinct persisted session ID.

