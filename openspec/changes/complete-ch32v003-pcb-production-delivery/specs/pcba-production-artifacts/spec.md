## ADDED Requirements

### Requirement: Controlled production export
系统 SHALL 仅在设计验证通过并取得独立导出批准后生成 BOM、CPL、Gerber、钻孔和评审资料，且不得自动下单或支付。

#### Scenario: Export approval missing
- **WHEN** 用户未批准生产资料导出
- **THEN** Runtime 拒绝调用导出命令

### Requirement: Artifact completeness validation
系统 SHALL 检查 Gerber 必需层和钻孔文件、BOM 必需字段、CPL 位号/坐标/旋转/面别以及三者位号集合一致性。

#### Scenario: CPL omits an SMT component
- **WHEN** CPL 位号集合少于批准 BOM 中的贴片元件集合
- **THEN** 导出标记失败并禁止宣称可生产

### Requirement: Provenance and immutable manifest
每次生产资料生成 SHALL 创建包含工程、文档、设计摘要、计划哈希、执行编号、检查结果、文件哈希和时间的清单。

#### Scenario: Review exported package
- **WHEN** 用户查看生产资料包
- **THEN** 系统展示每个文件哈希及其对应的已验证设计版本

### Requirement: Procurement status boundary
系统 SHALL 区分库身份、历史 LCSC 编号、实时库存/价格和可贴装状态；无法实时验证时 MUST 显示待人工复核。

#### Scenario: Live procurement data unavailable
- **WHEN** 没有官方采购接口或查询失败
- **THEN** BOM 保留器件身份但不得声称当前有库存或给出确认价格
