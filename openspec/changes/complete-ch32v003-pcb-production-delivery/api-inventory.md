# 嘉立创EDA V3.2.175 PCB API inventory

核对日期：2026-08-24。证据来源为本机 `easyeda-api` 技能所附官方类参考。

| 能力 | API | 结论 | 生产门禁 |
|---|---|---|---|
| 原理图同步到 PCB | `PCB_Document.importChanges(uuid?)` | 正式可用 | 必须回读器件、焊盘与网络 |
| PCB 保存 | `PCB_Document.save()` | 正式可用 | 保存后源码摘要一致 |
| PCB 读取 | `PCB_* getAll()`、`PCB_Net.getAllNets()` | 可用 | 建立目标指纹 |
| 规则读取/写入 | `PCB_Drc.getCurrentRuleConfiguration()` 等 | 可用 | 写入前后对比 |
| 官方 PCB DRC | `PCB_Drc.check(true,false,true)` | 正式可用 | 阻断项必须为零 |
| 板框/布局/走线/过孔/覆铜 | `PCB_Primitive*` | 官方 Beta | 只能实验性受控使用；界面回读和人工复核后才可放行 |
| 自动布线 | `PCB_Document.autoRouting()` | 官方 Beta，明确不应在生产环境使用 | 生产流程保持人工辅助 |
| 3D 文件 | `PCB_ManufactureData.get3DFile()` | 可生成 | 不等同 DFM 通过 |
| BOM/CPL | `getBomFile()` / `getPickAndPlaceFile()` | 官方 Beta | 导出后逐字段、位号集合和哈希复核 |
| Gerber/钻孔 | `getGerberFile()` | 官方 Beta，明确不应在生产环境使用 | 生产 Gerber 必须在嘉立创EDA界面人工导出和复核 |
| 下单/支付 | `place*Order()` 虽存在 | 永久禁用 | Runtime 不注册、不暴露 |

结论：当前公开 API 足以建立真实的读取、同步、保存、DRC、审批和审计链路；但不能诚实地宣称“全自动无人值守生产”。Beta 图元写入可以作为受控实验能力，最终生产放行仍要求嘉立创EDA界面内人工布局/导出复核。
