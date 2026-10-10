# Why

AI 对话能够分析需求和现有 BOM，但不能把已确认需求转换为可审核、可写入当前项目的 BOM 草案，用户仍需手工逐项建立元件清单。

# What Changes

- AI 对话可依据当前项目需求、资料元数据、既有 BOM 和只读 EDA 证据生成结构化 BOM 草案。
- 关键工程信息缺失时先追问并阻断草案确认；非关键不确定项以“待确认”显示。
- Runtime 尝试为草案项只读搜索嘉立创EDA器件候选，但不会自动绑定或修改原理图/PCB。
- 用户一次确认后才把草案批量写入当前项目 BOM；取消或继续聊天不会修改 BOM。
- BOM 草案和确认状态随项目聊天记忆独立保存；新建对话只清除草案与聊天，不删除已确认 BOM。

# Impact

- Extend structured chat output and normalization with an optional BOM draft.
- Reuse the existing fixed EasyEDA library search command to enrich draft rows.
- Extend project chat persistence, reducer actions, AI chat UI, audits, and tests.
