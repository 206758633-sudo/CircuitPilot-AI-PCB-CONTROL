## ADDED Requirements

### Requirement: Provider配置方式
系统SHALL支持Codex官方账号状态、OpenAI API Key、个人本机Claude Code状态和Anthropic API Key，并为每种方式显示认证来源、可用性和撤销入口。

#### Scenario: Codex账号登录
- **WHEN** 用户选择Codex账号并启动登录
- **THEN** 系统调用官方登录流程、等待用户在浏览器完成授权并使用状态命令验证结果

#### Scenario: Claude个人模式
- **WHEN** 用户选择本机Claude Code模式
- **THEN** 系统只读取CLI认证状态且不复制、回显或重新存储其OAuth凭据

### Requirement: API Key安全存储
系统MUST把OpenAI和Anthropic API Key保存在macOS Keychain，渲染层、LocalStorage、数据库、日志、审计和诊断响应MUST NOT包含明文密钥。

#### Scenario: 保存API Key
- **WHEN** 用户提交有效格式的API Key
- **THEN** Runtime通过stdin写入Keychain、清除请求体内存并只返回已配置状态和掩码提示

#### Scenario: 导出诊断包
- **WHEN** 用户导出诊断或错误详情
- **THEN** 输出不包含完整Key、Authorization头、OAuth Token或可复用凭据

### Requirement: Provider连接测试
系统SHALL用当前配置执行有超时、可取消和可归因的最小连接测试，并区分未安装、未登录、密钥缺失、密钥无效、配额、网络和服务错误。

#### Scenario: 密钥无效
- **WHEN** Provider返回认证失败
- **THEN** 系统保持密钥不回显、将Provider标记为不可用并生成可重试的问题记录

### Requirement: Provider撤销与切换
系统SHALL允许用户删除API Key配置、退出或重新认证CLI Provider，并在切换Provider时保留项目事实、需求、BOM和历史记录。

#### Scenario: 撤销API Key
- **WHEN** 用户确认撤销某Provider密钥
- **THEN** Runtime删除对应Keychain项、Provider立即失去可用状态且项目数据保持不变
