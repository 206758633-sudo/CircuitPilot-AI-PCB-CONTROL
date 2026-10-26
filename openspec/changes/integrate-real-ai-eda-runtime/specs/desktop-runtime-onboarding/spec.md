## ADDED Requirements

### Requirement: 首次启动配置状态机
系统SHALL按系统环境、AI Provider、嘉立创EDA、Bridge、工程回读和写入门禁的顺序建立可恢复配置状态，并在任何一步失败时保留已完成步骤。

#### Scenario: 首次启动完成只读配置
- **WHEN** 用户完成Provider授权且系统发现一个已连接的嘉立创EDA窗口
- **THEN** 系统进入`real_read_only`并显示Provider、Bridge、窗口、工程和文档的真实状态

#### Scenario: 配置中途失败
- **WHEN** Provider已就绪但Bridge未找到
- **THEN** 系统保留Provider配置、显示Bridge修复指引且不得显示“真实环境全部就绪”

### Requirement: 显式运行模式
系统MUST在所有核心页面区分`demo`、`real_read_only`和`real_controlled_write`，且不得用模拟结果提升真实就绪状态。

#### Scenario: Runtime不可用时降级
- **WHEN** 前端无法连接本机Runtime
- **THEN** 系统保持可操作Demo、显示明确降级原因并阻止真实Provider和EDA操作

### Requirement: 本机环境诊断
系统SHALL检测macOS、CPU架构、Runtime、Codex、Claude Code、嘉立创EDA、Gateway/Bridge和活动窗口，并输出不含敏感信息的结构化诊断。

#### Scenario: 依赖缺失
- **WHEN** 任一依赖未安装或未连接
- **THEN** 诊断结果包含稳定错误代码、影响、修复步骤和可重试动作

### Requirement: 桌面与开发双运行入口
系统SHALL允许桌面壳层和浏览器开发模式复用同一Runtime协议，且桌面构建状态必须独立于Web构建状态展示。

#### Scenario: 仅Web构建通过
- **WHEN** Web与Runtime测试通过但Tauri工具链或签名不可用
- **THEN** 系统记录Web/Runtime通过并将桌面安装包标记为未验证而非完成
