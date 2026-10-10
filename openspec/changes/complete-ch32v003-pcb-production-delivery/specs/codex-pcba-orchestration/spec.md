## ADDED Requirements

### Requirement: Evidence-constrained PCBA planning
Codex SHALL 从用户对话、已确认约束、库身份和实时 EDA 证据生成版本化结构计划；缺少关键证据时 MUST 返回阻断项而不是猜测器件、封装、坐标或规则。

#### Scenario: Missing mechanical dimensions
- **WHEN** 用户未确认板框或结构图
- **THEN** Codex 追问并保持 PCB 写入计划不可批准

### Requirement: Semantic plan compilation
系统 SHALL 将 Codex 的语义布局和布线意图通过确定性编译器转换为固定 PCB 操作，并展示输入证据、规则、对象和预计影响。

#### Scenario: Compile an approved placement
- **WHEN** 语义计划包含已确认器件和布局区域
- **THEN** 编译器生成有限坐标、旋转、层和对象引用且计划哈希稳定

### Requirement: Human-controlled autonomy
Codex MAY 自主读取、分析和提出修改，但 MUST 在批量写入和生产导出前分别获得用户批准。

#### Scenario: Continue after approved write plan
- **WHEN** 用户批准绑定的 PCB 写入计划
- **THEN** Codex 可执行批准范围内全部阶段但不得扩大对象、规则或导出范围

### Requirement: Durable task context
系统 SHALL 在本机保存项目事实、用户决定、计划版本、执行证据和未解决问题，使后续对话可以继续而无需重复询问已确认事实。

#### Scenario: Resume a PCBA project
- **WHEN** 用户重新打开桌面软件并继续项目
- **THEN** Codex 恢复已确认约束和最近验证状态，同时重新读取易变的 EDA 目标
