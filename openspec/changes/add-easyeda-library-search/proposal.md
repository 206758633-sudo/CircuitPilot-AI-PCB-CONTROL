# Why

CircuitPilot 资料页目前只搜索本地元数据，BOM中的型号和立创C编号无法在嘉立创EDA库中核验和绑定。

# What Changes

- BOM元件可按关键词/型号或立创C编号搜索嘉立创EDA器件库。
- 候选结果展示器件、符号、封装、3D模型与库身份。
- 只有用户确认才将嘉立创EDA身份绑定到BOM；不自动放置或修改原理图。
- 资料文件可关联当前嘉立创EDA项目，仍由CircuitPilot本地管理。

# Impact

- Add a fixed read-only Bridge command and authenticated Runtime endpoint.
- Extend BOM component metadata with optional EasyEDA library identity.
- Update Assets/BOM UI, tests, and audit records.

