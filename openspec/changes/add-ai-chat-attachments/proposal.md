# Why

AI对话只能接收文字，用户无法把结构图、原理图截图、BOM或网表等证据直接交给AI分析。

# What Changes

- AI对话输入区支持选择图片和文本类工程文件，每条消息最多4个附件。
- PNG/JPEG/WebP/GIF通过Codex App Server的`localImage`输入交给模型视觉理解。
- TXT/Markdown/CSV/JSON/XML/YAML/日志/网表等文本文件提取正文并作为不可信证据输入。
- 不支持解析的二进制文件明确拒绝，不声称AI已读取。
- 聊天记录仅持久化附件名、类型和大小；图片临时文件在本轮结束后删除。

# Impact

- Extend the chat request, Runtime validation and Codex App Server turn input.
- Increase the authenticated localhost request limit while enforcing attachment-specific limits.
- Extend project chat message metadata and attachment UI.

