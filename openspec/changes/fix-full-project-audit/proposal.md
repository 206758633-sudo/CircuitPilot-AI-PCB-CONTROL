# Why

全量项目检查发现EDA核心流程的自动化测试仍引用已移除的旧按钮，两个已完成变更缺少可校验的增量规格，并且图片附件只按声明类型和字符串长度校验，未验证真实文件签名。

# What Changes

- 更新EDA读取流程测试，使其覆盖当前“读取当前EDA设计”入口。
- 校验聊天图片的Base64、实际字节大小和PNG/JPEG/WebP/GIF文件签名。
- 补齐两个已完成OpenSpec变更的增量规格。
- 重新运行类型、单元、Runtime、E2E、OpenSpec、生产依赖安全和桌面构建检查。

# Impact

- Harden `runtime/chat.mjs` attachment validation.
- Restore meaningful EDA regression coverage.
- Make all OpenSpec changes strictly valid.
