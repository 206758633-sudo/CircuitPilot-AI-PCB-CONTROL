# 21. 用 EDA 插件 API 对既有工程做受控 ECO（相机 GC0308 实战）

> 来源：r51 在嘉立创EDA专业版 3.2.186 上执行相机 ECO-001（真实工程 `衣橱助手V2.0-AI设计`）的实测记录。

## 1. 受控流程（已验证可执行）

1. **备份先行**：`sys_FileManager.getProjectFileByProjectUuid(uuid)` 导出 `.epro2` 作为回滚点（分块 base64 传输，单请求 < 1 MB）。
2. **改焊盘/管脚网络**：`pcb_PrimitivePad.modify(id,{net})`；清空用 `net:''`。
3. **放置器件**：从**个人库** device uuid 用 `pcb_PrimitiveComponent.create({libraryUuid,uuid}, layer, x, y, rotation)`；系统库器件先 `lib_Device.copy/lib_Symbol.copy/lib_Footprint.copy` 到个人库（项目库 symbol 会卡死桥）。
4. **同步位号**：PCB 自动位号常与原理图不一致（如 R4/C19/C20/C21），必须 `pcb_PrimitiveComponent.modify(id,{designator})` 修正。
5. **电源脚接平面**：GND/+3V3 用 `pcb_PrimitiveVia.create(net,x,y,hole,dia)` + 顶层短线，过孔穿过内层平面实现连接。
6. **信号网络布线**：`pcb_Document.autoRouting({nets:[...], ignoreNets:['GND','+3V3']})` 只布目标网络；结果必须 DRC 复核，未收敛/引入冲突时**删除本次结果回滚**（保持板面无短路）。
7. **覆铜重建**：逐块 `pour.rebuildCopperRegion()`（批量偶发超时）。
8. **验收**：`pcb_Drc.check(true,false,true)`；再导出工程文件回读 `PAD_NET`/`ATTR NET` 做真值验收（勿信 netlist API，`getNetlist` 会挂）。
9. **保存**：`pcb_Document.save()`、`sch_Document.save()` 返回 true；在线工程建议 GUI 再保存一次确认云端备份刷新。

## 2. 关键坑

- 工程文件导出的页面内缓存：重复用同一 `window.xxx` 变量会拿到旧快照，必须每次用新变量名。
- 删除走线可从 `.epro2` 解析 `LINE`/`VIA` 记录（`netName`/`layerId`/坐标/宽度）后逐条 `create` 恢复，**无需整工程回灌**。
- 器件放置前必须用铜箔/焊盘/走线做**双层**空闲区检查（底层走线同样影响过孔与器件避让），否则会批量产生间距错误。
- `importProjectByProjectFile(..., {operation:'Existing Project'})` 会**追加新 uuid 文档**而非替换，不能作为原地补丁通道。

## 11. r52/r53 追加：自动布线可行，但 DRC 必须先过“缓存关”

1. 自动布线 `pcb_Document.autoRouting({nets:[...]})` 在 3.2.186 上可用：本次 3 条相机电源网 2.7 s 布通，飞线 10 → 2。
2. **不要相信第一遍 DRC**：删/加图元后 DRC 与 ratline 会缓存旧图元；先逐块 `rebuildCopperRegion()`（GND/电源平面都要）→ `save()` → `closeDocument` → `openDocument` → 再 `pcb_Drc.check(false,false,true)`。实测同一结果：未重建时 56 条 Safe Spacing + 10 条旧 id 飞线；重建+重开后 0 间距。
3. 判据：DRC 明细里的 obj suffix 用 `getAll()` 查不到 = 缓存未刷新，必须重载文档再判。

## 12. r53 追加：机械要素 API 真相（丝印可做、禁布区可做但要空区、NPTH 仍不可行）

| 要素 | API | 实测结果 |
|---|---|---|
| 丝印文字 | `pcb_PrimitiveString.create(3,x,y,text,'Arial',40,6,alignNum,0,false,0,false,false)` | ✅ 5 条一次成功（layer 3=TOP_SILKSCREEN，坐标 mil，alignMode 数字 1–9） |
| 禁布区 | `pcb_PrimitiveRegion.create(12, poly, [2,5,6,7], name, 6, false)`；poly 用 `pcb_MathPolygon.createPolygon([x0,y0,'L',x1,y1,...])` | ⚠️ 创建成功，但覆盖已有器件/走线/覆铜会立即产生 60+ 条 DRC 违反；必须放在真空区，且实际坐标需机械图纸确认 |
| NPTH 安装孔 | `pcb_PrimitivePad.create(12,'',x,y,0,['ELLIPSE',d,d],'',['ROUND',d],0,0,0,false,'NORMAL')` | ❌ 焊盘创建成功，但随后覆铜 `rebuildCopperRegion()` 100% 抛 `Cannot read properties of undefined (reading 'length')`；删除焊盘即恢复；且不带 `hole` 参数时该 API 直接报“无法创建焊盘图元”，说明它只接受“带孔独立焊盘”，而带孔独立焊盘必崩覆铜。真 NPTH 只能人工 GUI 放置，暂用镀铜 via（hole 106.2 mil / dia 122 mil）近似并标注偏差 |

## 13. 网表一致性自检（应对 DRC 的 Netlist Error）

- `eda.pcb_Net.getNetlist()` 返回当前 PCB 的 JLCEDA JSON 网表；原理图用 `eda.sch_ManufactureData.getNetlistFile('x.txt','JLCEDA')` 取 File 后 `await f.text()`。
- 逐 designator × pin 比对 net 名即可定位差异（本次主板 53 器件 / 0 差异）。
- 若两者完全一致但 DRC 仍报 Netlist Error，说明不一致来自工程内其它板/图页（历史遗留文档），不是本板 ECO 缺陷；需逐板打开核对或清理多余图页。

## 14. r54：重叠解算、NPTH 真孔路径、工程清理与网表自证（2026-10-25）

### 14.1 包围盒重叠不是"挪一点就行"

- 读真实 bbox：`pcb_Primitive.getPrimitivesBBox([componentPrimitiveId])`，单位 mil。本板 J7 bbox = x 785.4..1106 / y 1745..1970.7，C25 bbox 高 66 mil。
- 只挪 5~90 mil 可能把重叠从 0.873 变成 0.964mm（C25 移到 (850,1750) 实测），因为新位置仍落在 J7 bbox 内。
- 可行解必须同时满足：①与所有其他器件 bbox 在 0.5mm 阈值内不相交；②新焊盘到异网铜 ≥8 mil；③新增折线（含到另一焊盘）净空 ≥8 mil；④落板后重建全部覆铜 → save → 关重开 → DRC → `POST /api/eda/release/gate` 复核 `RELEASE_PLACEMENT_NOT_VERIFIED` 消失。
- 本板最终解：C25 (760,1790)→(760,2025)，AVDD 折线 `(732.4,2025)-(732.4,1790)`，DRC 只剩 1 条项目级 Netlist Error，门禁 placement 子门通过。

### 14.2 真 NPTH 的可用路径（替代"独立焊盘"）

- 独立焊盘 `pcb_PrimitivePad.create(12,'',x,y,0,['ELLIPSE',d,d],'',['ROUND',d],...)` 会崩覆铜（见 PCB-FAIL-CP-MECH-017）。**可用路径是"器件拥有的焊盘"**：
  1. 复制系统库 1-pad 小封装到个人库（`lib_Footprint.copy`，如 SMD-1P_L2.2-W1.5-H1.0，bbox 3.1×2.4mm）；
  2. `lib_Device.create(personalLib, name, undefined, {symbolType:'NON_ELECTRICAL', footprint:{uuid,libraryUuid}}, '说明', {designator:'MH', addIntoBom:false, addIntoPcb:true})`；
  3. 放到 PCB（**必须传 `{libraryUuid, uuid}` 的设备对象**；传 footprint 搜索项会报 `Cannot destructure property 'libraryUuid'`）；
  4. `pcb_PrimitivePad.modify(padId, {pad:['ELLIPSE',106.3,106.3], hole:['ROUND',106.3], metallization:false, layer:12, net:''})`；
  5. 4 块覆铜 `rebuildCopperRegion()` 全部 ok，读回 hole=106.3、metallization=false、layer=12。
- 但"能不能放"先看需求：本板 P-M04 为磁吸安装（30mm 磁铁+磁吸片），DXF 无孔位，板形圆顶+底部缺口四角无空间，**最终不设螺钉孔**；4 个早期"角孔"其实在板框外（见 PCB-FAIL-CP-MECH-020），已删除。
- 机械坐标必须用板框多边形校验：`pcb_PrimitivePolyline.getAll()` 取 layer=11 → `getState_Polygon().getSource()`（`[x0,y0,'L',x1,y1,...]`），做点在多边形内 + 点到边界距离判定，孔位要求到边界 ≥2.3mm、到铜皮 ≥1.8mm，且尽量成对镜像。

### 14.3 工程清理与网表自证

- 本项目实测有 4 个文档：主控板（sch 2 页/PCB）、LED 板（sch 2 页/PCB）、空 Board1（sch+PCB）、孤立 Schematic1。删除 API：`eda.dmt_Board.deleteBoard('Board1')`、`eda.dmt_Schematic.deleteSchematic(uuid)`、`eda.dmt_Pcb.deletePcb(uuid)`（不是 `dmt_Project.*`）。注意 `deleteBoard` 会留下孤立 sch/pcb，必须继续删，直到 `getCurrentProjectInfo().data` 只剩目标 board。
- 网表自证：`pcb_ManufactureData.getNetlistFile('n.txt','JLCEDA')` / `sch_ManufactureData.getNetlistFile(...)` 返回 JSON，取 `components[].props.Designator` + `pinInfoMap[pin].net` 建 `des→{pin:net}` 逐条对比。本次主板 53/53、LED 板 24/24、0 pin diff；PCB 焊盘数 268 vs 网表 pin 256 的差来自 U1/USB1/MK1 的 12 个机械/散热焊盘（无网络、不进网表），属正常。
- 对比通过后 DRC 仍报 1 条项目级 Netlist Error（ruleName=Import Changes）：`importChanges()` 无参/传 sch uuid/传 project uuid 都返回 true 但错误不清除，删空文档、重存两板也不清 → 属 EDA 快照缺陷（PCB-FAIL-CP-GATE-018），记录 blocker，不再循环重试。
- 板级 SPICE：`sch_ManufactureData.getSimulationNetlistFile('x.cir','spice')` 对两块板都返回 null（器件未绑模型）→ 整板仿真不可执行；只能保留 r41 的手写子电路 ngspice 证据（LED op、5V 去耦 vload=4.995459V），不得宣称整板仿真通过。
