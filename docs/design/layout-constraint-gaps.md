# 设计排版阶段约束缺口审计

> 审计对象：`runtime/engineering/rules/board-layout-rules.json`（128 条）、排版写回链路
> `runtime/placement-rules.mjs` → `runtime/engineering/layout-rules.mjs`、
> 自动布局 `runtime/engineering/layout.mjs` / `runtime/placement.mjs`、
> 桥接读命令 `runtime/bridge.mjs`。
>
> 真机基线：衣橱助手 PCB（`5595e77cead09682`，docType=3，47 器件，56.065 × 61.843 mm），
> 2026-10-23 只读审计（未写入）。

## 0. 结论

不是“没有约束”，而是**约束条款很多、排版流程只喂进了二维包围盒**：

1. **128 条规则在真实排版审计里只有 5 PASS / 5 FAIL / 105 REVIEW / 13 NA**。
   105 条 REVIEW 的主因不是规则没写，而是 `buildPlacementAuditInput` 只提供
   板宽/板高/板框闭合 + 器件中心/宽/高/角度；缺少层、courtyard、高度、封装类别、
   连接器意图、电源数据、丝印、测试点、3D/DRC/DFM 证据。
2. **已有规则里存在“实现口径错误”**，会把可排版判成不可排版：
   - `SPACE-02` 不区分顶层/底层，当前 14 处“courtyard 相交”里有 **7 处是上下层器件**；
   - `SPACE-14` 同样不区分面；
   - `SPACE-18` 因 `packageClass` 永远为空，实际长期 REVIEW，3D 高度门禁形同虚设；
   - `MECH-05` 用 courtyard 判“本体到板边”，默认 0.25 mm 外扩把 0.50 mm 要求变成 0.75 mm；
   - `SPACE-03` 又把“没有声明 courtyard”默认成 0.25 mm 并判 PASS，掩盖证据缺失。
3. **规则包还缺若干排版约束族**：EMC/ESD、爬电/隔离、PDN/IR drop、高速器件摆放、
   模拟/数字地分区、晶振/时钟摆放、热设计、拼板/分板应力、DFT/编程/探针、外壳/线缆空间。
4. **流程治理缺口**：没有约束冻结、没有统一 waiver、门禁证据只认 `passed: true`
   布尔值（没有报告哈希/签署人/日期），排版审计与写回复核对“上下层”口径还不一致。

---

## 1. 真机审计基线

对当前板按“保持现状”的布局计划做只读审计（不写 EDA）：

| 指标 | 值 |
| --- | --- |
| 板框 | 56.065 × 61.843 mm，闭合 |
| 器件 | 47 |
| 规则总数 | 128 |
| PASS / FAIL / REVIEW / NA | **5 / 5 / 105 / 13** |
| 硬门禁阻断 | 2（`SPACE-02` 14 处相交、`SPACE-14` 12 处吸嘴间距；后者 7 处跨层） |
| 证据缺口 | 3（`SPACE-01`、`GATE-01`、`GATE-07`） |
| `releaseReady` | `false`（缺 3D/DFM/DFA/FAI/ECO 证据；DRC 可由 `autoDrc` 自动采集） |

分组结果：

| 组 | PASS | FAIL | REVIEW | NA | 主要缺口 |
| --- | --- | --- | --- | --- | --- |
| MECH 15 | 2 | 0 | 11 | 2 | 板厚/圆角/翘曲/焊盘到边/Mark/定位孔/安装孔/拼板 |
| SPACE 18 | 3 | 3 | 5 | 7 | courtyard、层/高度、封装类别、极性 |
| CONN 17 | 0 | 0 | 13 | 4 | 连接器 kind/开口方向/插拔空间/线缆禁布 |
| RF 13 | 0 | 0 | 13 | 0 | 天线模组/禁布区/GND 缝合/匹配网络 |
| PWR 13 | 0 | 0 | 13 | 0 | 电源脚-去耦配对/回路面积/GND 过孔/载流 |
| SILK 16 | 0 | 0 | 16 | 0 | 丝印文本几何/位号归属/极性标识 |
| DFM 16 | 0 | 0 | 16 | 0 | DRC/Gerber/叠层/拼板/钢网证据 |
| DFA 13 | 0 | 0 | 13 | 0 | 测试点/返修/治具/ESD/遮挡 |
| GATE 7 | 0 | 2 | 5 | 0 | 3D/DRC/DFM/DFA/FAI/ECO 未接证据 |

> 说明：105 条 REVIEW 是“本轮输入”的结果；即使把当前可填字段全部填上，
> 此前审计仍有约 46 条长期 REVIEW（SILK/CONN/DFM/DFA/PWR/RF 中的专用证据项），
> 这些需要新增数据源或评审证据，不能靠几何推算。

---

## 2. 已有规则里“没按约束本意执行”的部分（P0）

### 2.1 顶层/底层不区分 → 上下层器件被当成叠放

`SPACE-02` 的规则原文要求“XY 包络间隙 ≥0 **且高度包络重叠量 = 0**”，
但实现只做二维 `courtyard` 相交，输入 schema 里连 `side` 都没有：

- `buildPlacementAuditInput()` 只写 `ref/x/y/widthMm/heightMm/rotationDeg`，没有 `side`；
- `normalizeComponent()` 不读取 `layerSide`，`SPACE-02` 直接两两求交；
- `SPACE-14` 也不区分面，顶层器件和底层器件被要求保持 0.30 mm 本体间距。

真机证据：当前 14 处 `SPACE-02` 相交中 **7 处是 top↔bottom**：

```text
C3(top)↔U1(bottom)      C7(top)↔U1(bottom)      C13(top)↔U1(bottom)
CN5(top)↔U1(bottom)     J7(top)↔U1(bottom)
U1(bottom)↔U8(top)      U1(bottom)↔U18(top)
```

其中 U1↔U8 面积 55.93 mm²、U1↔U18 36.93 mm²，实际是双面布局的正常投影重叠。`SPACE-14` 的 12 处吸嘴间距里也有 7 处跨层。
**结论：当前排版审计会把双面布局判成“叠放”，阻断写回。**

同时，规则要求的高度重叠量没有实现：`heightMm3d` 只用于 `SPACE-14/15/18`，
`SPACE-02` 完全不看高度。

### 2.2 courtyard 用默认 0.25 mm 代替真实封装轮廓

`normalizeComponent()` 在未提供 `courtyardMm` 时直接取 0.25 mm 外扩，
但真实 courtyard 是封装轮廓（可能不是矩形，外扩值也未必 0.25）：

| 规则 | 后果 |
| --- | --- |
| `SPACE-01` | 47/47 器件“未显式声明 courtyard”，返回 FAIL |
| `SPACE-02` | 用默认矩形外扩判相交，既可能误报，也可能漏报异形封装 |
| `SPACE-03` | 因为默认值恒为 0.25，反而 PASS“全板统一 Nominal”，**假 PASS** |
| `MECH-05` | 用 `courtyard` 而不是 `body` 判“本体到边”，0.50 mm 要求实际变 0.75 mm |

实测：器件本体左边距 0.60 mm（满足 ≥0.50），`MECH-05` 报 `U1=0.35 mm` FAIL；
`SPACE-03` 同时报 PASS。这说明“缺 courtyard”既会假失败，也会假通过。

### 2.3 自动布局把所有器件旋转归零、且不区分面

`planOutlinePlacement()` 写回计划时固定：

```js
rotationDeg: 0
```

- 不保留原旋转角；对 90°/180°/270° 器件，相当于在移动时把器件转回 0°；
- 不区分 top/bottom，所有器件在同一二维平面做间距；
- 不支持任意角度、成组旋转、极性方向保持；
- `solveLayout()` 同样只做轴对齐矩形碰撞，`rotation` 字段不参与几何。

这会让“自动排版”本身违反：
`SPACE-16`（角度仅 0/90）、`SPACE-17`（极性方向统一）、`CONN-01`（开口朝外）、
`SILK-06`（位号角度/朝向）等约束，但审计却可能因为全被改成 0° 而 PASS。

### 2.4 排版审计与写回复核口径不一致

- 排版审计 `auditPlacementPlan()` 走 `buildPlacementAuditInput()`，**没有 side/height**；
- 写回复核 `verifyOutlinePlacement()` 在成对间距检查里**有 side 判断**
  （`if ((effective[i].side || 'top') !== (effective[j].side || 'top')) continue;`），
  也带 pad envelope，但没有真实 courtyard/高度。

结果：同一块双面板，审计可能判 `SPACE-02` FAIL，写回复核却按 side 跳过上下层对。
两套结论不一致，不能同时作为门禁依据。

---

## 3. 规则包已有、但排版流程拿不到数据的约束（P0/P1）

以下不是“规则不存在”，而是 `buildPlacementAuditInput` 没有对应输入；
桥接其实已经能读到一部分，只是没接进排版审计。

| 约束族 | 规则 | 排版审计现状 | 需要的数据 | 桥接现状 |
| --- | --- | --- | --- | --- |
| 层/面/高度 | SPACE-02/14/18 | 105 REVIEW，或按二维误判 | component.side、heightMm3d、真实 courtyard | placement.read 有 layerSide/bbox，无高度/courtyard |
| 连接器意图 | CONN-01/02/04/05/09/10/11/12/13/14/15/16/17 | 13 REVIEW | conn.kind/openingDir/openingNormality/plugClearance/cableKeepout/massG/reinforced | 无读取；需意图声明或封装属性 |
| 天线/RF | RF-01..13 | 13 REVIEW | rf.componentRef/keepout/overhang/gndViaRatio/viaFencePitch/gndCoverage | regions/copper/pours 可读，但没有天线绑定 |
| 电源/去耦 | PWR-01..13 | 13 REVIEW | power.nets/decoupling/paths/planes | pads/copper/nets 可读，但没有电源分类/引脚配对 |
| 丝印 | SILK-01..16 | 16 REVIEW | 文本 bbox/所属位号/极性/1 脚/层 | texts.detail 可读文本，但无 bbox/归属；当前板 0 个独立文本 |
| 机械 | MECH-02/03/04/06/09/10/11/12/13/14/15 | 11 REVIEW + 2 无检查器 | 板厚/圆角/翘曲/Mark/定位孔/安装孔/拼板/V-CUT | 无读取；需机械图/拼板图/工艺单 |
| DFM | DFM-01..16 | 16 REVIEW | DRC 报告/Gerber/叠层/钢网/表面处理/拼板 | `pcb.drc` 可由 `autoDrc:true` 自动跑并注入；叠层/拼板/Gerber 仍无读取 |
| DFA | DFA-01..13 | 13 REVIEW | 测试点/开关/治具/返修空间/ESD 拓扑 | 部分可由 pads/placement 推导，但未建模型 |
| 门禁证据 | GATE-02..06 | 5 REVIEW | DRC/DFM/DFA/FAI/ECO 的真实报告 | DRC 可自动采集（opt-in）；DFM/DFA/FAI/ECO 无采集；只认带 provenance 的报告 |

### 3.1 连接器：缺“开口方向/插拔空间”的意图数据

`CONN` 组 17 条里 13 条 REVIEW，原因统一是“未提供连接器清单（conn 字段）”。
仅凭器件 bbox 无法知道 USB/FFC/JST 的开口方向、翻盖开启方向、插头插入深度、
线缆弯曲半径、按压方向。当前板 CN1/CN5/J7/USB1 都在，但审计完全看不见这些约束。

### 3.2 RF：有禁布区图元，但没有“天线属于谁”的绑定

`pcb.regions.detail` 能读 region 层/规则类型/bounds，`pcb.copper.read` 能读铜线/焊盘/过孔，
但 `rf.componentRef`、`antenna.endDir`、`rf.keepout` 没有输入，所以 RF-01/03/04/05
无法把“天线模组”和“禁布多边形”关联起来，13 条全 REVIEW。

### 3.3 电源：有焊盘/网络，但没有引脚级电源配对

`pcb.pads.read`/`pcb.copper.read` 能给出位号/焊盘号/网络/坐标，
`pcb.rules.detail` 能给出网络类与规则值；但排版审计没有：
- 哪些是电源脚、哪些是去耦电容；
- cap→IC pin 的配对；
- 电流/电压/目标阻抗；
- GND 过孔统计与回路面积。

所以 PWR-01（去耦距离）、PWR-02（回路面积）、PWR-03（每脚电容）、PWR-04（GND 过孔）
全部 REVIEW。这块不是“读不到”，而是“还没建引脚级模型”。

### 3.4 丝印：文本对象不是位号

`pcb.texts.detail` 能读文本/层/mirror/reverse/rotation/fontSize/lineWidth/x/y，
但当前板返回 `texts=0`——位号很可能作为封装字段/丝印属性存在，不在独立文本对象里。
即使有文本，也缺：
- 文本包围盒（需 `getPrimitivesBBox` 或用字号/字数估算，不能猜）；
- 文本与器件的归属映射；
- 1 脚/极性标识的语义；
- 丝印线与 courtyard 的层归属。

因此 SILK-01..16 全 REVIEW。

### 3.5 3D/DRC/DFM/DFA 门禁：只有布尔值，没有证据链

`GATE-02..06` 的 `evidenceGate()` 只判断：

```js
if (record.passed === true) return PASS;
if (record.passed === false) return FAIL;
return REVIEW;
```

任何调用方传 `{passed:true}` 就能过门禁，没有：
- 报告文件哈希/URL；
- 执行工具/版本/时间；
- 操作者/签署人；
- 覆盖范围（哪块板/哪个版本/哪些规则）；
- 与当前设计 revision 的绑定。

这是“排版放行”最大的治理缺口：约束可以算，但门禁可以被一个布尔值绕过。

---

## 4. 规则包完全没有（或只有很弱覆盖）的约束族（P2）

这些不是 REVIEW，而是**128 条里没有对应条款**，需要新增规则组：

| 约束族 | 缺什么 | 现有最接近的条款 |
| --- | --- | --- |
| EMC/EMI | 时钟/晶振/开关节点摆放、回流路径连续性、板边辐射、电缆屏蔽接地、机壳地 | RF-12 只做“噪声源远离天线”；PWR-07 只做开关热环路面积 |
| ESD | TVS/ESD 器件在连接器与芯片之间的顺序、ESD 回路面积、GND 过孔距离、火花隙 | DFA-09 只有一条“ESD 器件位置”，且 REVIEW |
| 爬电/电气间隙 | 高压/隔离间距、开槽、污染等级、工作电压 | 无；DFM-01 是最小线宽/线距，不是爬电 |
| PDN/IR drop | 目标阻抗、直流压降、电流密度、平面分割、过孔载流 | PWR-05/06/11 只做载流线宽/铜面积/余量 |
| 高速器件摆放 | 串联端接/AC 耦合电容位置、连接器到保护器件顺序、参考平面换层、长度匹配的摆放前提 | `highspeed.mjs`/`impedance.mjs` 只做布线长度/阻抗分析，不参与排版 |
| 模拟/数字分区 | AGND/DGND 单点连接、隔离带、ADC 参考/模拟输入远离数字噪声 | RF-12 只针对天线；无模拟分区规则 |
| 晶振/时钟摆放 | 负载电容靠近、晶振下方禁走线、guard ring、时钟环路面积 | SPACE-12 只做“晶振↔其他器件间距” |
| 热设计 | 结温/温升、热过孔阵列、铜箔散热面积、热耦合、热敏器件远离热源 | PWR-09/10 是“推荐”，SPACE-10 只做电解/钽电容↔热源 |
| 拼板/分板应力 | V-CUT/邮票孔应力区、板边器件、拼板方向、工艺边、分板方向 | MECH-09/10、DFM-08 部分覆盖，但 REVIEW |
| DFT/可测试性 | 测试点覆盖、探针侧、编程/调试接口、边界扫描、ICT 夹具 | DFA-05/06/07/08/10 分散覆盖，全部 REVIEW |
| 外壳/线缆/机构 | 线缆弯曲半径、连接器插入轨迹、按键/显示/灯导光、螺钉头空间、外壳公差 | MECH-13/14、CONN-14 部分覆盖，REVIEW |
| 成本/工艺 | 过孔数量、盲埋孔、盘中孔、背钻、HDI 阶数、拼板利用率 | `hdi.mjs` 有能力模型，但未接入排版审计 |

> 注：`highspeed.mjs`、`impedance.mjs`、`stackup.mjs`、`rf.mjs`、`hdi.mjs`
> 这些模块已经存在，但它们是**布线/仿真**输入模型，不是排版约束；排版阶段没有调用。

---

## 5. 输入契约缺口（最该先补的）

当前排版审计实际输入：

```js
{
  board: { widthMm, heightMm, outlineClosed },
  components: [{ ref, x, y, widthMm, heightMm, rotationDeg }],
}
```

`normalizeComponent()` 还支持但没人填：`heightMm3d`、`courtyardMm`、`packageClass`、
`conn`、`antenna`、`isNoiseSource`、`isMetal`。
`normalizeContext()` 还支持但没人填：`rf`、`silk`、`power`、`testPoints`、`switches`、
`evidence`、`directionClassLimit`。

排版流程需要但**没有 schema** 的输入：

| 输入 | 用途 |
| --- | --- |
| `side`（top/bottom） | 上下层叠放、吸嘴、双面回流、丝印 |
| 真实 courtyard 多边形/外扩 | SPACE-01/02/03/07/08/09/14 |
| 器件高度/3D 包络 | SPACE-02/14/15/18、GATE-01 |
| 封装类别（0402/QFN/MODULE/...） | SPACE-04..08/12/18 |
| 连接器意图（kind/opening/insertion/cable） | CONN 13 条 |
| 天线意图（componentRef/endDir/keepout） | RF 13 条 |
| 电源拓扑（电源脚、去耦配对、电流） | PWR 13 条、DFM-09 |
| 丝印文本归属/极性/1 脚 | SILK 16 条 |
| 测试点/开关/治具 | DFA 05/06/07/08/10 |
| 板厚/叠层/铜厚/工艺边/拼板/Mark/孔 | MECH/DFM 多组 |
| DRC/3D/DFM/DFA/FAI/ECO 证据（含哈希） | GATE-02..07 |

另外，设计意图的 6 类声明（zones / assembly / selfCheck / diffPairs / netClasses）
仍未提供；SKL 审计在当前板上是 0 PASS / 6 REVIEW，原因就是缺这些声明。
它们不是“排版几何”，但会直接决定排版是否满足功能分区、装配策略、等长/差分意图。

---

## 6. 流程与治理缺口

| 缺口 | 现状 | 风险 |
| --- | --- | --- |
| 约束冻结 | 没有“排版前先冻结板框/连接器/天线/电源意图”的步骤 | 排版后才发现方向/开口/禁布错，返工 |
| 统一 waiver | 只有 `overhangAllowances`（带理由） | 其它规则无法合法豁免，容易被“改数据”绕过 |
| 证据链 | GATE 只认 `{passed:true}` | 一个布尔值即可放行 |
| 版本绑定 | 审计输入没有 PCB revision / 原理图 revision / ECO id | 报告可能对应旧板 |
| 审计/写回一致性 | 审计无 side，写回复核有 side | 同一板两套结论 |
| 缺省值策略 | courtyard 默认 0.25、高度缺省 | 假 PASS / 假 FAIL 都可能 |
| REVIEW 语义 | `SPACE-01` 返回 FAIL，但 `auditPlacementPlan` 把它当 evidence gap 过滤 | UI 显示 FAIL，门禁却可能放行 |
| 证据覆盖范围 | `coveredBy` 只标“哪个门禁覆盖”，不标“覆盖了哪些规则/版本” | 无法审计签字范围 |

---

## 7. 建议优先级

### P0：先让排版结论“不撒谎”（1–2 天量级）

1. **加 `side` + `heightMm3d` 到排版输入与规则上下文**：
   - `SPACE-02` 只对同面器件判 courtyard 相交；跨面另算“高度包络干涉”；
   - `SPACE-14` 只对同面器件判吸嘴间距；跨面按贴装顺序/高度差处理；
   - 修掉当前 14 处里的 7 处上下层误报。
2. **真实 courtyard 或“未知”**：
   - 去掉 `SPACE-03` 的默认 0.25 PASS；
   - `MECH-05` 改用 `body`；
   - `SPACE-01` 缺 courtyard 时统一 REVIEW（或阻断），不要一边 FAIL 一边被过滤。
3. **自动布局保留旋转/面**：
   - `planOutlinePlacement` 输出原 `rotationDeg`/`side`；
   - 碰撞按旋转后的 bbox，或显式拒绝非 0/90 器件；
   - 连接器/极性器件锁定方向。
4. **门禁证据加最小 provenance**：
   - `evidence.*` 至少要求 `{passed, source, artifactHash, issuedAt, scope}`；
   - 没有 artifactHash 的 `{passed:true}` 只能算 REVIEW。

### P1：把已有桥接数据接进排版审计（3–5 天量级）——**已落地，见 §11**

5. ✅ 接 `pcb.pads.read`/`pcb.copper.read`：建“位号-焊盘-网络-坐标”映射，
   先做 PWR-01（去耦距离）、DFA-09（ESD 器件顺序）、DFA-11（方向一致性）。
6. ✅ 接 `pcb.texts.detail` + bbox：先做 SILK-01/02/03/04/05/06/13/16；
   位号归属/极性/1 脚若封装 API 拿不到，显式标 REVIEW。
7. ✅ 接 `pcb.drc`（adapter + CLI `--drc`）：把官方 DRC 结果映射到 GATE-02/DFM-01/02/03/05/13/15；
   不要把“DRC 0 项”直接当“DFM 全过”。
8. ✅ 连接器/RF/电源意图声明：先做 schema + 校验 + 缺省 REVIEW，
   不要用封装名猜开口方向/天线位置。

### P2：补规则族（按产品风险排序）

9. EMC/ESD（时钟/晶振/开关节点/接口保护/回流路径）；
10. 爬电/隔离（若有市电/高压）；
11. PDN/IR drop（若有低压大电流）；
12. 高速器件摆放（USB/SPI/时钟的端接/AC 耦合/换层）；
13. 热设计（热过孔/铜面积/热耦合）；
14. 拼板/分板/DFT/外壳线缆；
15. 把 `highspeed`/`impedance`/`stackup`/`rf`/`hdi` 从“布线/仿真模块”提升为
    “排版可调用的前置约束”。

---

## 8. 验收判据（建议）

- 同一块双面板：`SPACE-02` 对 top↔bottom 不再报叠放；同面真实重叠仍 FAIL。
- 器件本体距板边 0.60 mm：`MECH-05` PASS（按 body），不再因 courtyard 默认值 FAIL。
- 未提供 courtyard：`SPACE-01`/`SPACE-03` 不得 PASS；`releaseReady=false`。
- 自动布局计划：每个器件的 `rotationDeg`/`side` 与原读回一致，除非显式允许旋转。
- 只传 `{passed:true}` 的 DRC/DFM/DFA/FAI 证据：GATE 仍为 REVIEW。
- 排版审计与写回复核对同一输入给出相同的 side/courtyard 结论。

---

## 9. 证据与相关文件

- 规则包：`runtime/engineering/rules/board-layout-rules.json`
- 排版输入：`runtime/placement-rules.mjs`（`buildPlacementAuditInput`，L29）
- 规则引擎：`runtime/engineering/layout-rules.mjs`
  - `normalizeComponent` L172（无 side；courtyard 默认 L180）
  - `MECH-05` L259、`SPACE-02` L375、`SPACE-14` L442、`SPACE-18` L471
  - `evidenceGate` L1041
- 自动布局：`runtime/engineering/layout.mjs`（`solveLayout` L67）、
  `runtime/placement.mjs`（`planOutlinePlacement` L268、固定 `rotationDeg:0` L327/L337）
- 写回复核：`runtime/placement-write.mjs`（`verifyOutlinePlacement` 有 side 判断，但无高度/courtyard）
- 桥接：`runtime/bridge.mjs` 的 `pcb.placement.read`、`pcb.outline.read`、
  `pcb.pads.read`、`pcb.copper.read`、`pcb.texts.detail`、`pcb.drc`、`pcb.3d`
- 既有接入说明：`docs/implementation/pcba-layout-rules-integration.md` §10
- SKL 设计意图缺口：`docs/design/eda-skill-constraints.md` §8
- 真机证据：`artifacts/pcb-constraints/skill-audit-live.json`

---

## 10. P0 修复结果（2026-10-23 已落地）

按 §7 的 P0 建议完成了 4 项，均带回归测试：

| P0 项 | 实现 | 结果 |
| --- | --- | --- |
| 1. `side` + 高度语义 | `normalizeComponent` 读 `side/layerSide`；`buildPlacementAuditInput` 把 `pcb.placement.read` 的 `layerSide` 传进规则；`SPACE-02/14` 只比较同面 | 真机 `SPACE-02` 14 处 → 不再有跨层误报；`SPACE-14` 12 处 → 5 处（7 处跨层已消除） |
| 2. courtyard 不再默认冒充 | 缺 courtyard 时 `SPACE-01/02/03` 统一 REVIEW；`MECH-05` 改用 `body` 判板边 | 当前板 `SPACE-01/02/03` 从 FAIL/PASS 改为 REVIEW；`MECH-05` 不再把 0.75 mm 当 0.50 mm |
| 3. 自动布局保留旋转/面 | `planOutlinePlacement` 输出 `rotationDeg/side`，碰撞按同面过滤 | 90° 器件不再被转回 0°；上下层投影重叠不再被规划器判碰撞 |
| 4. 门禁证据 provenance | `evidenceGate` 要求 `source/artifactHash/issuedAt/scope`；`GATE-01/06/07` 同步 | 只有 `{passed:true}` 的 DRC/DFM/DFA/FAI/ECO 证据不再 PASS，降为 REVIEW |

修复后同一块板的只读审计（**P0 刚落地时的中间轮次**；P1/P2 后的最终数见 §11，不是当前结论）：

| 指标 | 修复前 | P0 后（中间轮次） |
| --- | --- | --- |
| PASS | 5 | **4** |
| FAIL | 5 | **1**（`SPACE-14`，剩余 5 对同面本体间距） |
| REVIEW | 105 | **110**（courtyard 未知从 FAIL/PASS 改为诚实 REVIEW） |
| NA | 13 | 13 |
| `releaseReady` | false | false |

剩余 `SPACE-14` 的 5 对（CN1↔CN5、CN1↔J7、D1↔USB1、J7↔U18、R24↔USB1）都是同面、且用 `bboxMm` 当本体：
`bbox` 可能含焊盘/连接器轮廓，不能等同“本体”。这条要等真实 courtyard/body 轮廓数据，
否则只能继续 REVIEW 或人工复核，不能为了“全绿”放宽阈值。

测试：`layout-rules` 15 条、`placement-rules` 4 条、`placement` 全部通过；
全量回归 **1120 个测试 / 1113 通过 / 7 个既有 EPERM 失败**，`npm run typecheck` 通过。

---

## 11. P1 修复结果（2026-10-23 已落地）

| P1 项 | 实现 | 真机/测试结果 |
| --- | --- | --- |
| 丝印文字包围盒 | `pcb.texts.detail` 增加 `boundsMm`（`getPrimitivesBBox`）；适配器保留 `fontSizeMm/lineWidthMm/boundsMm` | 建临时文字实测 `boundsMm` 正常，读后即删；当前板 `texts=0` 仍全部 REVIEW |
| SILK 规则接线 | SILK-02 用线宽；SILK-04/05/07/13/16 用文字 bbox/焊盘/板边/courtyard；SILK-06 用位号角度/镜像/本体间距 | 0 文字时不再误判 PASS，统一 REVIEW“封装内丝印未读取” |
| 铜焊盘 → 去耦 | `pcb.copper.read` + 封装名 → 最近 IC 电源脚距离；排除电阻/连接器；自动配对只 REVIEW 不 FAIL | 当前板生成 16 对，PWR-01 报“自动配对疑似超距”REVIEW，不冒充硬违规 |
| 官方 DRC 证据 | `runtime/engineering/drc-evidence.mjs` 哈希 DRC 结果 + `source/issuedAt/scope/reportId`；`buildPlacementAuditInput({drcReport})` 注入 `evidence.officialDrc` | 真机 `pcb.drc` 0 条 → GATE-02 PASS；`POST /placement/plan|apply` 可带 `drcReport/drcScope`，或 `autoDrc:true` 自动跑并注入；CLI `--drc` / `--drc-report`；有项 FAIL |
| 设计意图 | `runtime/engineering/layout-intent.mjs` 校验 + 合并：`components` 补丁（courtyard/height/conn/antenna/packageClass/side）、`rf/power/testPoints/switches/esd/requiredNets/evidence` | 连接器/天线/去耦/测试点/ESD 规则不再因“没有字段”而 REVIEW；非法方向/负距离直接拒绝 |
| 布局审计 CLI | `scripts/bridge-layout-audit.mjs`：placement/outline/texts/pads/copper + 可选 DRC + 可选意图 | 真机跑通，输出 `artifacts/pcb-layout/layout-audit-live-p1.json` |

当前板 P1 后审计：

```text
PASS=5 FAIL=0 REVIEW=116 NA=7 blocking=0 releaseReady=false（含真机 DRC 0 条，GATE-02 PASS）
无硬门禁阻断；SPACE-14 五对同面“bbox 间距为 0”（CN1↔CN5、CN1↔J7、D1↔USB1、J7↔U18、R24↔USB1）因 bbox 含焊盘降为 REVIEW，需真实本体/封装轮廓复核
```

为什么还是 116 REVIEW：
- `texts.detail=0`，但封装内丝印/位号没有独立图元可读 → SILK 不冒充 PASS；
- 没有设计意图 JSON：连接器开口、天线端、测试点、按键、ESD 拓扑都缺；
- 没有 3D/DFM/DFA/FAI/ECO 证据；
- `SPACE-14` 已把 `bboxMm` 标记为“含焊盘”，疑似不足只判 REVIEW；真实本体/封装轮廓仍未读到。

P1 仍留的尾巴：
1. DRC 已支持 `autoDrc:true` 在 plan/apply 内自动跑（只读、阻塞式 `pcb.drc`）；大板尚未切 `pcb.drc.job.*`，报告也不自动归档到 artifacts；
2. 丝印只读独立文字图元，封装自带丝印/位号仍读不到；
3. PWR-01 的自动配对是“最近 IC 电源脚”，不能替代设计意图里的真实去耦对象；
4. `esd/thermal` 等仍只吃显式声明，不自动从网表推导。

测试：全量 runtime **1143/1143 通过**，`npm run typecheck` 通过。

---

## 12. P2 第一批：独立补充规则族（已落地）

128 条规则包面向“2D 板级几何 + 官方证据”；下面这些事实**无法从包围盒/铜皮推出**，
因此不塞进 128 条包（不改总/hash），而是作为独立 `SUP-*` 规则族，吃设计意图里的显式量测：

| 规则 | 判据 | 缺数据 |
| --- | --- | --- |
| `SUP-TH-01` 热功耗铜箔面积 | 1 W→100 mm²，每 +0.5 W→+50 mm²（与 PWR-10 同口径） | REVIEW |
| `SUP-TH-02` 散热过孔阵列 | ≥9 孔、间距 1.0–1.2 mm、孔径 0.25–0.35 mm | REVIEW |
| `SUP-PDN-01` PDN 直流压降 | `dropV ≤ maxDropV` | REVIEW |
| `SUP-HS-01` 高速组内等长/阻抗 | 组内 skew ≤ `maxSkewMm`；阻抗偏离目标 ≤±10% | REVIEW |
| `SUP-HS-02` USB 差分对/参考平面几何 | USB2/3/4 阻抗 ±15%；USB3/4 对内偏斜 ≤0.127 mm、对间距 ≥0.762 mm、平面边距 ≥2.286 mm、stub ≤0.381 mm（TI SLLA414A） | REVIEW |
| `SUP-CREEP-01` 爬电/电气间隙 | `actualMm ≥ requiredMm`（要求值由设计按标准填写，不猜） | REVIEW |
| `SUP-IPC-01` IPC-2221 电气间隙 | 电压/层位/涂覆/海拔查 IPC-2221 表；`actualMm ≥ requiredMm`；>500 V 不自动外推 | REVIEW |
| `SUP-ENCL-01` 外壳/线缆空间 | 间隙 ≥ 要求、内部高度 ≥ 最高器件 | REVIEW |
| `SUP-EMC-01` EMC 噪声源/敏感体间距 | `actualMm ≥ minMm` | REVIEW |

实现：
- `runtime/engineering/layout-supplements.mjs`：9 条规则 + `requiredThermalCopperMm2()` / `requiredClearanceMm()`；
- `validateLayoutIntent` 增加 `thermal/pdn/highSpeed/creepage/clearance/enclosure/emc` 校验；
- `auditPlacementPlan` 返回 `supplements{summary,rules}`、`supplementFailures`；
  有 `SUP-*` FAIL 时计入 `blockingFailures` 并让 `releaseReady=false`，REVIEW 不冒充 PASS；
- `scripts/bridge-layout-audit.mjs` 自动带出。

当前板没传这些意图 → 9 条全部 REVIEW，不虚报 PASS；真机总结：
`PASS=5 FAIL=0 REVIEW=116 NA=7 blocking=0 releaseReady=false`（DRC 0 条，GATE-02 PASS；SPACE-14 因 bbox 含焊盘降 REVIEW）。

仍不自动做的：从网表/铜皮反推热功耗、PDN 电阻、高速长度、爬电要求值。
这些属于“设计输入”，不应由排版工具猜；下一步是让设计页/规则中心提供录入与默认模板。

测试：P2 新增 `layout-supplements.test.mjs` 7 条；全量 runtime **1143/1143 通过**，`npm run typecheck` 通过。

---

## 13. 公开资料 + 真实案例的知识沉淀（2026-10-23）

本轮不再只补运行时判定，而是把「这些阈值为什么成立、来自哪份官方文件、真实参考设计怎么取舍」沉淀成可复核知识：

- 人类可读研究文档：`docs/knowledge/pcb/20-researched-layout-constraints.md`（18 条约束 + 6 个真实案例 + 与 128 条/`SUP-*` 的映射）；
- 来源登记：`knowledge/pcb/dataset/sources.json`（Espressif / TI / Raspberry Pi / JLCPCB / PCBWay / Sierra Circuits / IPC / USB-IF；含 URL、版本、抓取时间、快照 SHA-256、证据等级）；
- 结构化条目：新增 **20 条 rule、4 个 case、5 个 failure**，全部带 `sources`/`evidenceLevel`，灌库后仍是 `reference + candidate`，人工审核前不得被门禁引用；
- 新规则 ID：`PCB-RULE-SRC-001`、`RF-MODULE/TRACE/PWR/SDIO`、`USB-HS/USB-ESD`、`HS-REF`、`ESD-GND`、`PWR-SW`、`THERM-QFN`、`MFG-CAP/PANEL/STENCIL`、`SILK-LEGIBLE`、`SAFE-CREEP/CTI`、`COURTYARD-002`、`IMPEDANCE-002`、`DFT-002`。
- 本轮已把其中两条接进运行时补充规则：`SUP-HS-02`（USB2/3/4 阻抗、对内偏斜、对间距、平面边距、stub）与 `SUP-IPC-01`（按电压/层/涂覆/海拔查 IPC-2221 间隙）；其余仍是知识条目，未接运行时。
- 来源登记新增 `reviewBy` 强制复核期限，`npm run check:knowledge-sources` 会校验 ID/HTTPS/证据等级/哈希/引用关系/到期；到期必须重抓并顺延，不能无声续期。

从公开资料提炼出的关键边界（也已写进条目 `limits`/`verificationNotes`）：

1. **不能用一个 0.2 mm 覆盖所有电压**：IPC-2221 裸板间隙按内层/外层未涂覆/海拔 >3050 m/永久涂覆分档；51–100 V 外层未涂覆 0.6 mm，高海拔 1.5 mm。
2. **爬电 ≠ 间隙**：还要 CTI、污染等级、海拔、绝缘类型；FR-4 默认 CTI≈175，高 CTI 材料可到 600，但仍须按标准表取值。
3. **天线净空是整机约束**：ESP32 模组天线伸出底板边缘；外壳内各方向建议 ≥15 mm；禁止放板中心四面掏空。
4. **USB/ESD 是一条路径**：90 Ω 差分、对内 5 mil、对间 30 mil、参考平面边缘 90 mil、stub <15 mil；TVS 靠连接器、ESD 源到 TVS 不换层/不布未保护线/转角 ≤45°、TVS 地脚旁地孔 + 地平面缝合。
5. **QFN 热焊盘不是 1:1 钢网**：过孔约 1.0 mm 间距/0.3 mm 钻孔、塞孔或盖油、钢网 50–70%、空洞 ≤50%、NSMD。
6. **板厂能力不是 universal**：JLC 标准盖油 0.15/0.15 mm、露铜 0.25/0.25 mm；PCBWay 标准 0.1/0.1 mm；V-CUT 余厚/拼板间距/阻抗公差也不同，必须按目标板厂当前能力表 + EQ 锁定。
7. **bbox 不是本体**：EDA 回读 bbox 可能含焊盘；没有真实 body/courtyard/3D 时，器件干涉/吸嘴间距只能 REVIEW（对应运行时 `SPACE-14` 的真机修正）。

测试：新增 `runtime/__tests__/knowledge-research.test.mjs` 校验来源登记、`sources` 可解析、研究批次条目齐全；全量 runtime 数字见最终验收。
