## Why

当前系统已经证明 Codex 能通过受控 Runtime 真实读取和写入嘉立创EDA原理图，但仍缺少 PCB 创建、布局布线、官方验证与生产资料输出能力，因此不能作为真实 PCBA 设计生产环境。现在需要把一次性的原理图执行能力扩展为可重复、可审计、可回滚的端到端 PCBA 工作流，并以已完成的 CH32V003 控制板作为现场验收样板。

## What Changes

- 扩展本机 Runtime 的嘉立创EDA固定命令注册表，覆盖 PCB 文档、元件、网络、板框、规则、走线、过孔、铺铜、丝印、DRC、3D与生产导出所需的读取和受控写入。
- 建立 PCB 级目标指纹、源码快照、一次性批准令牌、逐步骤回读、官方检查、失败回滚和恢复锁定机制。
- 将 Codex 对话输出约束为版本化 PCBA 设计计划，不允许模型直接提交任意脚本；计划必须包含证据、机械约束、布局、规则、网络和验证门禁。
- 在 Mac 桌面控制软件中展示真实工程、不可变计划、审批范围、执行进度、修改日志、问题中心和可恢复证据。
- 支持 BOM、CPL、Gerber 和审查包的受控生成、完整性检查与用途标记；导出需要独立确认。
- 使用 `CircuitPilot-CH32V003-P0` 验收：45×30mm、2层、1.6mm、1oz、无安装孔，USB-C 位于短边中央并与板边齐平，按键位于对侧，LED 靠近按键，SWIO 位于长边。
- 明确禁止自动下单、支付、删除工程、覆盖未绑定目标或绕过官方 DRC/DFM 门禁。

## Capabilities

### New Capabilities

- `production-pcb-read-write`: 版本化 PCB 读取模型、固定写命令、目标绑定、快照、回读和回滚。
- `codex-pcba-orchestration`: Codex 从连续对话生成证据约束的 PCBA 计划，并通过人工批准驱动确定性执行。
- `pcb-layout-routing-validation`: 板框、规则、器件布局、走线、过孔、铺铜、网表一致性、PCB DRC 与 3D/机械验证。
- `pcba-production-artifacts`: BOM、CPL、Gerber 和评审资料的受控生成、校验、记录与导出确认。
- `production-control-workspace`: 桌面端真实目标、计划、审批、进度、日志、错误、恢复和生产资料状态界面。

### Modified Capabilities

<!-- 当前仓库没有已归档的主规格；本变更以新增能力定义生产环境契约。 -->

## Impact

- Runtime：`runtime/bridge.mjs`、设计执行器、API、日志、错误和凭证边界。
- Codex：聊天输出 Schema、工程事实上下文、工具协议、审批绑定和执行审计。
- 前端：AI、EDA、验证、BOM/资料、版本与日志页面及共享状态类型。
- 嘉立创EDA：当前工程的 PCB 文档、规则、布局、布线、铺铜、验证和导出流程。
- 测试与交付：Runtime 单元/集成测试、前端测试、E2E、真实工程现场验收和生产文件检查。
