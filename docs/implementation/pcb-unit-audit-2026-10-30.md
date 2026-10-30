# PCB 画板单位问题检查与修复（2026-10-30）

## 1. 结论

发现一个会产生 **25.4 倍缩板** 的静默缺陷：

- 语义计划 / AI 生成的 PCB 计划使用 **mm**；
- 嘉立创EDA 的 PCB 数据单位是 **mil**（官方 `SYS_Unit` 类型注释：“PCB 数据单位跨度等效为 mil”；真机 COMPONENT `x=393.7008` 即 10mm）；
- 编译计划把 mm 数值直接塞进 `pcb.component.modify` / `pcb.line.create` / `pcb.via.create` / `pcb.pour.create`，执行器原样下发；
- 板框 `pcb.outline.create` 接收的是 `widthMm/heightMm`，桥内会正确换算。结果是**板框 45mm，但器件、走线、过孔、覆铜全部只有正确尺寸的 1/25.4**。

这不是“看起来怪”的显示问题：它可能通过官方 DRC（所有铜都缩在板内），也可能通过当前“只核对数量/位号”的回读，于是 UI 仍显示执行完成。必须按几何参数逐项核对，不能只看计数。

## 2. 影响示例

| 计划值（mm） | 修复前下发给 EDA | EDA 实际含义 | 修复后下发（mil） |
|---|---:|---:|---:|
| 器件 x=20mm | 20 | 0.508mm | 787.401575 |
| 走线宽 0.2mm | 0.2 | 0.00508mm | 7.874016 |
| 过孔外径 0.6mm | 0.6 | 0.01524mm | 23.622047 |
| 覆铜轮廓 x=45mm | 45 | 1.143mm | 1771.653543 |
| 板框宽 45mm | `widthMm:45` | 45mm（桥内换算） | `widthMm:45`（不重复换算） |
| 覆铜边框线宽 0.2 | 0.2 | 0.2mm（真机既有覆铜读回） | 0.2（保持 mm） |

### 2.1 真机既有板读回（用于判定字段单位，不靠猜）

同一块真实 PCB 的读回数据：

- 走线 `width: 10`（mil，约 0.254mm），说明 `pcb.line.create.lineWidth` 是 mil；
- 过孔 `diameter: 24 / holeDiameter: 12`（mil，约 0.61/0.30mm），说明过孔字段是 mil；
- 覆铜 `source` 坐标 `0..5118`（mil，约 130mm），但 `lineWidth: 0.2`（mm，约 7.87mil）——覆铜边框线宽是例外，不能跟着坐标转 mil。

这些证据来自本机真机读回（`artifacts/final-5v-chg/pours.json`、`vias.json`、`artifacts/reference-epro2/current-board-read-2026-10-21.json`），不是从参数名推测。

## 3. 根因与修复

### 3.1 根因

单位换算责任没有落在单一位置：

- `runtime/production.mjs` 的 `compileSemanticPlan` 输出 mm 操作；
- `runtime/engineering/engine.mjs` 的布局/走线/过孔操作也按 mm 输入；
- `runtime/bridge.mjs` 的 `pcb.component.modify`、`pcb.line.create`、`pcb.via.create`、`pcb.pour.create` 直接使用 EDA 数据单位（mil），没有统一转换；
- 只有 `pcb.outline.create` 在桥内做了 mm→mil，导致其他类型更容易被忽略。

### 3.2 修复

在 `runtime/pcb.mjs` 增加唯一的高层计划单位边界：

- 导出 `PCB_PLAN_GEOMETRY_UNIT = 'mm'`，明确计划契约；
- 新增 `toEdaOperationArgs(operation)`，只转换需要原生 mil 的字段：
  - `pcb.component.modify.property.x/y`
  - `pcb.line.create.startX/startY/endX/endY/lineWidth`
  - `pcb.via.create.x/y/holeDiameter/diameter`
  - `pcb.pour.create.outline[*][0..1]`
  - `pcb.outline.create.lineWidth`
- `PcbManager.runOperation` 在调用 `bridge.execute` 前统一调用它；
- `pcb.outline.create` 的 `widthMm/heightMm` 保持 mm，不重复换算；
- `pcb.pour.create.lineWidth` 是覆铜边框线宽，真机既有覆铜读回为 `0.2`（mm），不随坐标转 mil；
- `complexPolygon` 视为已构造好的 EDA 原生对象，不重复换算；
- 转换是纯函数，**计划哈希、审批令牌、账本仍绑定 mm 值**，不会因执行层换算而改变批准对象。

## 4. 回归覆盖

新增 `runtime/__tests__/pcb-units.test.mjs`：

1. 单位契约测试：组件/走线/过孔/覆铜的 mm→mil 值；板框与 `complexPolygon` 不重复换算；转换不修改原计划。
2. 执行边界测试：构造一份含全部四类几何操作的 PCB 计划，经 `PcbManager` 执行，断言假桥实际收到的 EDA 参数是 mil。
3. 更新 `runtime/__tests__/multilayer-design.test.mjs`：线宽断言从“计划 mm 值”改为“下发 EDA 的 mil 值”，并保留计划层 mm 断言。

## 5. 验证

- `npm run typecheck`：通过
- `npm run test:runtime`：**1,444/1,444 通过**（新增 2 项）
- 定向测试：`pcb.test`、`multilayer-design.test`、`multilayer.test`、`highlayer.test`、`production.test`、`layers.test`、`pcb-units.test` 全部通过

## 6. 边界与未完成

- 本轮 **没有** 做真机 EDA 写入验证：CircuitPilot Runtime 当前不可达（`ECONNREFUSED 127.0.0.1:4178`）。上述结论来自代码路径、官方 API 类型注释、真机历史证据（COMPONENT x=393.7008 = 10mm）和离线假桥测试。
- 直接调用桥的旧入口（如 `/api/eda/pcb/pour/create`、`pcb-routing.apply`）仍按 EDA 原生 mil 接收参数；它们不是语义计划执行路径，不在本次统一转换范围内。使用这些入口时必须继续按原生 mil 传参。
- 当前执行回读仍以数量/位号为主，尚未按每个器件的目标 mm 坐标逐项比对。单位换算修复后建议下一步补“位置回读误差”断言，让缩板/偏移类错误在写后复核阶段也必然失败。
