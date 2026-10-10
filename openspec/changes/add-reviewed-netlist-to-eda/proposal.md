# Why

项目BOM、约束和嘉立创EDA器件绑定完成后，系统仍不能画图，因为BOM没有结构化引脚网络表，PCB编译器又只会修改已经存在的EDA图元。用户需要一条从已确认项目证据到可审核网络表、原理图和PCB对象的安全链路。

# What Changes

- AI基于当前项目的已确认需求、BOM、资料和器件绑定生成结构化网络表草案。
- 网络表逐项展示器件、引脚和网络；缺少精确器件绑定、位号、引脚号或关键网络时保持阻断。
- 用户确认网络表后才转换为固定的原理图操作计划；确认本身不写入EDA。
- 最终执行沿用目标绑定、一次性批准、源码快照、写入、回读、官方原理图DRC和失败恢复。
- 原理图通过后调用固定PCB同步操作并重新读取PCB图元；禁止自动下单。

# Impact

- Add project-scoped reviewed netlist state and UI.
- Add Runtime schemas and deterministic compilation endpoints.
- Extend the registered schematic execution plan with reviewed connectivity.
- Preserve all existing write gates and audit evidence.
