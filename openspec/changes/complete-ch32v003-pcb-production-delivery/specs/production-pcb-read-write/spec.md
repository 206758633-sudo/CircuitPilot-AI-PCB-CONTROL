## ADDED Requirements

### Requirement: Versioned PCB evidence model
系统 SHALL 通过固定只读命令返回当前 PCB 文档、板框、层、规则、网络、元件、焊盘、走线、过孔、铺铜和丝印的版本化模型，并计算绑定窗口、工程、文档和源码摘要的目标指纹。

#### Scenario: Read current PCB evidence
- **WHEN** Codex 请求分析当前 PCB
- **THEN** Runtime 返回规范化证据和目标指纹且不返回原始文档源码

### Requirement: Allowlisted PCB mutations
系统 MUST 仅执行注册且通过参数 Schema 校验的 PCB 创建或修改命令，并拒绝任意脚本、未知命令、非有限坐标、未知层和未绑定对象。

#### Scenario: Reject arbitrary PCB code
- **WHEN** 计划包含脚本字符串或未注册命令
- **THEN** Runtime 在调用嘉立创EDA前拒绝请求并记录安全错误

### Requirement: PCB transactional recovery
系统 SHALL 在写入前建立非空源码快照，在每阶段保存和回读，并在失败时恢复、保存并验证规范化摘要一致；恢复失败后 MUST 锁定后续写入。

#### Scenario: Roll back failed routing stage
- **WHEN** 走线后回读或官方 DRC 失败
- **THEN** 系统恢复阶段前快照并仅在摘要一致后标记已回滚

### Requirement: Bound approvals and target drift
PCB 写入批准 MUST 绑定计划哈希、目标指纹、窗口、阶段和有效期，并且一次性使用。

#### Scenario: Document changes after approval
- **WHEN** 用户批准后 PCB 文档或目标窗口发生变化
- **THEN** Runtime 拒绝执行并要求重新读取与批准
