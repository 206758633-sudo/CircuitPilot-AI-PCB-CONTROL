## ADDED Requirements

### Requirement: Bridge安全发现
系统SHALL只扫描`127.0.0.1:49620-49629`，并只接受健康响应中`service`严格等于`easyeda-bridge`的服务。

#### Scenario: 发现有效Bridge
- **WHEN** 允许端口中的服务返回有效身份和EDA连接状态
- **THEN** 系统记录端口、连接状态和探测时间并继续读取窗口

#### Scenario: 端口存在非Bridge服务
- **WHEN** 某端口返回HTTP成功但服务身份不匹配
- **THEN** 系统忽略该端口、记录身份不匹配且不发送后续EDA请求

### Requirement: EDA窗口选择
系统SHALL根据已连接窗口数量决定目标窗口，且多个窗口时MUST要求用户明确选择。

#### Scenario: 单窗口自动采用
- **WHEN** Bridge返回一个已连接窗口
- **THEN** 系统采用该窗口并记录其临时ID

#### Scenario: 多窗口阻断
- **WHEN** Bridge返回两个或更多窗口且用户未选择
- **THEN** 系统保持写入阻断并展示可选窗口列表

### Requirement: 工程与文档只读回读
系统SHALL在任何EDA写入前读取当前工程和当前文档，并验证文档类型与后续命令域匹配。

#### Scenario: 当前停留在首页
- **WHEN** 当前文档不是原理图或PCB工程文档
- **THEN** 系统报告文档状态不满足且不执行PCB或原理图命令

### Requirement: Bridge断线处理
系统MUST在Bridge或目标窗口断开时暂停依赖任务，不自动切换其他窗口或重放可能产生副作用的请求。

#### Scenario: 执行中断线
- **WHEN** Runtime收到断线、超时或目标窗口消失
- **THEN** 当前步骤标记为未知、后续步骤停止并要求回读后才能恢复或回滚
