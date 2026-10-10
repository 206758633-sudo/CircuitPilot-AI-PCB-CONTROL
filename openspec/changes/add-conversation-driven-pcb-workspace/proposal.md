# Why

现有 EDA 控制页面暴露了过多工程管线和命令，用户无法直接从已确认的项目对话进入 PCB 设计与微调，也无法在 CircuitPilot 内看到当前嘉立创EDA设计的同步摘要。

# What Changes

- EDA 页默认显示对话驱动的 PCB 工作台，自动带入当前项目需求、资料和 BOM。
- 通过 Bridge 只读获取当前 PCB 图元，在应用内显示同步预览、图元数量和读取状态。
- 用户用自然语言提出布局/布线微调；AI 只生成结构化语义计划或精确阻断问题。
- AI 计划必须先展示差异和风险，用户确认后才进入现有受控编译/审批/执行链。
- 提供“在嘉立创EDA中查看”按钮，聚焦本机已安装的嘉立创EDA。
- 原连接、命令、手工计划和诊断界面收纳到“高级控制”。
- 主工作台常驻“开始执行EDA设计”控制；条件不足时指明前置步骤，条件齐备后经最终确认自动完成受控审批和执行链。
- 新建模式由Runtime后台启动嘉立创EDA，通过固定API创建工程、Board、关联原理图、原理图页和PCB，并自动打开PCB文档；用户无需手工建文件。

# Impact

- Extend the local Runtime with a fixed, authenticated EasyEDA focus action.
- Extend the AI production-planning request with a bounded user instruction.
- Recompose the EDA React page while preserving the existing controlled write pipeline.
