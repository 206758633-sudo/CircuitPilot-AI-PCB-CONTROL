# 15. 复核真值性：包围盒、双面、证据绑定（CircuitPilot 真机教训）

本文对应数据集条目：`PCB-RULE-CP-BBOX-002`、`PCB-RULE-CP-EVID-003`、`PCB-FAIL-CP-BBOX-001`、`PCB-FAIL-CP-2SIDE-002`、`PCB-RULE-CP-AUTO-001`。
所有结论来自 2026-10-22/23 在嘉立创EDA v3.2.186 真机上的设计与复核，证据文件在 `artifacts/wardrobe-case/pm-run-20261022/evidence/`。

## 15.1 为什么"复核器说不行"不等于"板子不行"

同一块主板曾同时出现两个相反的结论：
- 官方 DRC：**0 items**（铜皮/间距层面干净）；
- 布局复核：U1 "有 85 个角在板框外，最大伸出 3.112 mm"。

两个都声称是"事实"。真值只能有一个，所以必须能定位是谁算错了。这次错在复核器的读回。

## 15.2 旋转器件的包围盒必须按 rotation 旋转

真机实测（U1 = ESP32-S3-WROOM，rotation=90、底层、原点 (31.6,31.8)）：

| 数据源 | 宽×高 (mm) | 中心 (mm) |
|---|---|---|
| `getPrimitivesBBox` 原始返回 | 26.2 × 19.0 | 原点 + (3.45, 0) |
| 物理真实（旋转后） | **19.0 × 26.17** | 原点 + (0, 3.45) |
| 焊盘实际范围（底层焊盘读回） | 4.67…22.46 × 21.25…38.75 | — |

结论：`getPrimitivesBBox` 返回的是**未旋转的局部包围盒平移后的结果**。按它做 1mm 边距与四角/边采样，必然把 rot90 的器件判成出界。

正确做法（任意角度通用）：

```js
// 局部框角点相对器件原点 → 绕原点旋转 θ → 再平移回绝对坐标
const rad = rotationDeg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
const corners = [[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY]]
  .map(([x,y]) => ({ x: originX + (x-originX)*cos - (y-originY)*sin,
                     y: originY + (x-originX)*sin + (y-originY)*cos }));
// 取旋转后 min/max 作为物理包围盒
```

修复后该板布局复核 `blockingCount=0`，与官方 DRC 0 items 一致；焊盘级板框复核 250/250。

**经验规则**：当"DRC 干净"与"布局复核出界"冲突时，先怀疑 bbox 读回，再怀疑设计；修读回而不是放宽门禁（放宽门禁会让真出界也放过）。

## 15.3 双面板必须按 side 分面比较

把 ESP32 放到底层是为了给底部 Type-C 凹口让位。结果布局复核报：
`C3×U1 7.899mm、CN5×U1 5.951mm、J7×U1 4mm、U8×U1 3.348mm、U18×U1 9.134mm` 全部"真实重叠"。

它们全在**顶层**——和底层器件在物理上不可能碰撞。旧实现不区分层，于是双面板永远过不了复核（一个把"面"当成"位置"的缺陷）。

修复：
- `verifyOutlinePlacement` 里按 `side`（来自 `layerSide`）分组，仅同面比较；
- 单测：正反面重叠 → 不报 OVERLAP；同面重叠 → 照常阻断；
- `/api/eda/pcb/placement/plan` 与 `/api/eda/release/gate` 两条路径都补传 `side`（否则门禁与布局页结论会不一致）。

## 15.4 证据必须绑定当前工程/板/网表

放行门曾出现两种"差点误放行"的形态：
1. **DRC 证据 pcbUuid 不是当前 PCB**：直接喂就会得到"DRC 干净"的假结论 → 门禁改为 `RELEASE_DRC_EVIDENCE_UNBOUND`（缺 pcbUuid）与指纹不符即阻断。
2. **仿真证据结构不对**：`status` 缺失、`kind` 不符、`netlist.sha256` 不匹配当前网表 → `RELEASE_SIMULATION_EVIDENCE_INVALID` / `_UNBOUND`。

可复核的做法：证据 JSON 至少带 `pcbUuid`（DRC）或 `netlist.sha256`（仿真），门禁消费前重算比对；拿不到绑定信息一律 fail-closed。

## 15.5 自动布线只是 EVT 候选

主板 autoRouting 一条命令 49/49 网全通，但：
- `successNetsCount` 只代表"连上"，不代表线宽/过孔/回流可制造；
- 移动器件后必须**清空旧线孔**再重布，否则会出现 80+ 条 `SMD Pad to Track` 间距错误；
- 布完必须重建覆铜并回读官方 DRC（主板 DRC 0 items 才闭环）；
- 灯板 13/14（`+3V3` 单脚网络被拒绝）→ 遗留网要逐条登记，不是"布完就算过"。

## 15.6 检查清单（可直接照做）

- [ ] rot90/270 器件的读回宽高是否互换、中心是否含旋转偏移？
- [ ] 布局复核是否按 side 分面？THT 是否单独处理？
- [ ] 板框复核是否"本体 ∪ 焊盘"包络 + 沿边采样（≥0.25mm 步长）？
- [ ] DRC 证据是否带当前 pcbUuid？仿真证据是否带当前网表 sha256？
- [ ] 每次移动器件后是否清线孔 → 重布 → 重建覆铜（读 fills>0）→ DRC 读回？
- [ ] 自动布线结果是否标注"EVT 候选、需人工评审"？
