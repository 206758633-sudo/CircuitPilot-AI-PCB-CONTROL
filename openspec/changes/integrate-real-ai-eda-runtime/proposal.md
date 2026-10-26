## Why

当前产品只有可点击的浏览器 Demo：AI Provider、嘉立创EDA连接、命令响应和验证结果均由本地模拟器生成，无法让个人硬件工程师在安装后通过 Codex、OpenAI、Claude 或 Anthropic 凭据完成真实环境配置。现在需要建立本机优先的真实运行底座，同时保留明确的模拟/真实边界和工程安全门禁。

## What Changes

- 增加首次启动配置向导，检测本机运行环境、AI Provider、嘉立创EDA专业版、API Gateway、Bridge和活动窗口。
- 增加真实 AI Provider 配置：Codex官方账号状态、OpenAI API Key、个人本机Claude Code状态和Anthropic API Key。
- 使用macOS Keychain保存API密钥；前端、LocalStorage、SQLite、日志和诊断包不得接触或回显明文密钥。
- 增加本机Runtime服务和统一Provider Adapter，向现有React界面提供类型化健康检查、认证状态、连接测试和错误响应。
- 增加真实EasyEDA Bridge发现、服务身份校验、窗口选择、项目/文档只读回读和类型化命令白名单。
- 保留“只读检查→变更计划→批准→快照→执行→回读→ERC/DRC/BOM/DFM→保存或回滚”闭环；关键未知项、未批准计划或Bridge状态不确定时禁止写入。
- 设置页、EDA页、状态栏、审计和问题记录区分 `DEMO`、`REAL_READ_ONLY` 与 `REAL_CONTROLLED_WRITE`，禁止把模拟成功显示为真实就绪。
- 增加可安装macOS桌面壳层及本机Sidecar生命周期边界；开发环境仍允许浏览器连接本机Runtime进行验证。
- 记录实现决策、任务进度、测试证据、已知限制和后续生产化门槛。

## Capabilities

### New Capabilities

- `desktop-runtime-onboarding`: 首次启动向导、本机依赖检测、运行模式、就绪状态机和可恢复诊断。
- `secure-provider-configuration`: Codex/OpenAI/Claude/Anthropic适配、官方登录状态、Keychain密钥管理、连接测试和凭据撤销。
- `easyeda-runtime-bridge`: EasyEDA Bridge发现、握手、窗口选择、当前工程与文档回读、断线处理和只读自检。
- `controlled-pcba-execution`: 结构化计划、权限门禁、类型化命令白名单、快照/回读/验证/回滚和可追溯错误记录。

### Modified Capabilities

<!-- 主规格目录目前没有已归档的同名能力；现有Demo规格保持不变，真实运行能力以新增规格并行定义。 -->

## Impact

- 前端：设置页、EDA页、全局状态、类型、服务适配器、状态栏、审计和错误展示。
- 本机运行层：新增Runtime API、Provider进程管理、macOS Keychain封装、Bridge客户端和结构化日志。
- 桌面交付：新增Tauri 2配置、Rust命令边界、Sidecar配置和DMG构建入口。
- 测试：新增Runtime单元/集成测试、前端Provider/Bridge测试、Playwright首次配置流程和安全回归测试。
- 依赖系统：Codex或OpenAI有效访问权限；Claude Code或Anthropic API权限；嘉立创EDA专业版、Run API Gateway与本地Bridge。
- 安全：不接收账号密码，不在普通存储或日志中保存密钥，不允许任意自然语言直接成为EDA可执行代码。
