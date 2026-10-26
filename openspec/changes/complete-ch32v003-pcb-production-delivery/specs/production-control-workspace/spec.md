## ADDED Requirements

### Requirement: Real production state presentation
桌面端 SHALL 明确区分 Demo 数据、真实 EDA 证据、候选计划、已批准计划、执行中状态、已验证结果和待人工步骤。

#### Scenario: Open EDA workspace
- **WHEN** 用户进入 EDA 控制页
- **THEN** 页面显示当前真实窗口、工程、文档、目标指纹和能力探测结果

### Requirement: Conversational requirement completion
AI 页面 SHALL 允许用户持续与 Codex 对话，自动保留已确认信息、追问阻断项并生成可跳转到审批页的结构化 PCBA 计划。

#### Scenario: Plan becomes ready
- **WHEN** 最后一个阻断约束被用户确认
- **THEN** 对话页展示计划摘要、风险和“进入审批”操作

### Requirement: Execution and recovery visibility
系统 SHALL 实时展示每个 PCB 阶段、固定命令、对象数量、保存、回读、DRC、回滚和错误证据，并同步到修改日志和问题中心。

#### Scenario: A stage rolls back
- **WHEN** 任一 PCB 阶段验证失败并恢复成功
- **THEN** 页面显示失败原因、恢复摘要和允许的下一步

### Requirement: Production readiness dashboard
系统 SHALL 汇总原理图、PCB、网表、DRC、3D/机械、BOM、CPL、Gerber、采购复核和人工终审状态，只有全部必需门禁通过才显示可生产。

#### Scenario: PCB passes but export not reviewed
- **WHEN** PCB DRC 通过但生产资料尚未验证
- **THEN** 总状态保持“未就绪”并指出缺失门禁
