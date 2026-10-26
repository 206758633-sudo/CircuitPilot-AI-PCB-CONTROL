## ADDED Requirements

### Requirement: Board and manufacturing constraints
系统 SHALL 在布局前明确板框、层数、板厚、铜厚、安装孔、禁布区、接口位置、线宽间距和过孔规则，并将其纳入批准哈希。

#### Scenario: CH32V003 fixture constraints
- **WHEN** 执行本变更的验收样板
- **THEN** 使用 45×30mm、2层、1.6mm、1oz、无安装孔及已确认接口位置

### Requirement: Deterministic placement
系统 SHALL 按接口、机械、电源、去耦、关键网络、可操作性和装配方向规则放置元件，并回读每个元件的封装、坐标、旋转和板内状态。

#### Scenario: Place edge connectors
- **WHEN** 布局 USB-C 和 SWIO 排针
- **THEN** USB-C 与指定板边齐平且 SWIO 位于可插接长边区域

### Requirement: Rule-driven routing and copper
系统 SHALL 为电源、地、关键信号和普通信号应用明确线宽、间距、层和过孔策略，并在铺铜后验证网络归属与孤岛规则。

#### Scenario: Route power and ground
- **WHEN** 执行电源和地网络布线
- **THEN** 使用批准规则并保持连续回流路径且不得出现未连接铜皮

### Requirement: Official validation gates
系统 MUST 在完成前验证原理图-PCB 网表一致性、封装完整性、未布线数量、板框、PCB DRC 和适用的 3D/机械检查；未知或非零硬错误 MUST 阻断完成。

#### Scenario: DRC has errors
- **WHEN** 嘉立创EDA官方 PCB DRC 返回错误
- **THEN** 执行不得标记完成且生产导出保持禁用

### Requirement: Reviewable quality evidence
系统 SHALL 提供布局截图或结构化坐标、规则摘要、关键网络路径、过孔数量、未布线数量和官方检查结果供人工终审。

#### Scenario: Request final PCB review
- **WHEN** 所有自动门禁通过
- **THEN** 桌面端展示可核对的最终证据而不是仅显示“成功”
