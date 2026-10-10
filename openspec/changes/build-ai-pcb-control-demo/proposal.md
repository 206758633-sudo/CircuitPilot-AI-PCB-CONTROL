## Why

现有PRD已经定义了Mac端AI电路板设计控制台，但尚无可操作界面验证信息架构、审批闭环和EDA控制体验。需要先交付一套完整可点击的高保真Demo，让每个页面、按钮和主要状态都可演示，从而在接入真实AI与嘉立创EDA之前发现产品流程和交互问题。

## What Changes

- 新建一个面向macOS桌面视口的React交互Demo，采用工业仪器式视觉语言和中文界面。
- 实现项目、需求、BOM与资料、AI任务、EDA控制台、验证、版本与日志、设置八个主功能区。
- 为所有可见按钮提供实际交互结果，包括页面导航、筛选、搜索、表单编辑、弹窗、抽屉、状态变更、通知和确认流程。
- 使用本地模拟数据完成AI计划、审批、EDA连接、执行进度、验证、快照、回滚和导出闭环；所有模拟外部能力明确标注“演示模式”。
- 增加结构化前端日志、数据持久化、空状态、错误状态和重置Demo能力。
- 增加自动化交互检查，确保主导航和关键操作无死按钮、无控制台错误。
- 不连接真实AI账户，不修改真实嘉立创EDA工程，不提交真实订单或支付。

## Capabilities

### New Capabilities

- `desktop-shell-navigation`: Mac桌面应用壳层、全局状态栏、八个主页面导航和通用交互反馈。
- `project-requirements-workspace`: 项目创建切换、需求约束、文件资料和BOM的可编辑演示工作区。
- `ai-task-approval-workflow`: AI任务生成、缺失信息提示、计划审阅、分步审批和高风险确认流程。
- `eda-control-simulation`: 嘉立创EDA环境检查、窗口选择、连接控制和类型化命令执行模拟。
- `validation-version-audit`: 回读差异、验证报告、快照、版本比较、回滚和审计日志演示。
- `demo-settings-persistence`: AI Provider设置、权限偏好、本地持久化、演示数据重置和诊断导出。

### Modified Capabilities

<!-- 当前项目没有既有OpenSpec能力，本变更不修改既有规格。 -->

## Impact

- 新增前端应用工程、构建配置、页面、组件、样式、状态管理、模拟服务和测试文件。
- 新增本地浏览器存储用于保存Demo状态；不新增远程后端或云数据库。
- 可能引入React、TypeScript、Vite、图标库和前端测试依赖。
- 设计依据为`docs/product/AI-PCB-Design-Control-Mac-PRD.md`。
- 真实EasyEDA Bridge、AI Provider、macOS Keychain和生产文件接口仅保留适配边界，不在本变更中接入。
