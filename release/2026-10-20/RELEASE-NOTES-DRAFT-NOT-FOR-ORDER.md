# 智能衣橱助手 · 生产草稿说明（4 层板 / DRAFT / 禁止下单）

- 记录时间：2026-10-20 14:35（Asia/Shanghai）
- 工程：嘉立创EDA「智能衣橱助手」`5e1059beff734847ba4b38b557e8ed59`
  - PCB：`2844799d86eeed27`（PCB1）—— **本轮已由 2 层升级为 4 层**（Top / Inner1 / Inner2 / Bottom）
  - 原理图：`8db59ac7bbc9510b`（p1）
- 板卡：60 mm × 40 mm，**4 层**，1.6 mm，1 oz
- **放行状态：`DRAFT-NOT-FOR-ORDER`，`humanSignoffRequired=true`，`orderEnabled=false`，未签核，禁止下单**

> 本目录所有文件均为**草稿**（文件名强制带 `-DRAFT-NOT-FOR-ORDER`），由 CircuitPilot 运行时
> `/api/production/export` 在「先裁决、后导出、再复核」的通道中产生。未通过放行门禁、未人工签核，
> 不得作为下单依据。本轮导出复核结论 `PRODUCTION_EXPORT_VERIFY_FAILED`（1 条阻断：缺产物取证），
> 产物已落盘但**不能当交付物**。

## 一、本批产物（2026-10-20 14:34 实测导出，4 层）

| 文件 | 大小 | 说明 |
|---|---|---|
| `BOM_CircuitPilot-bom-DRAFT-NOT-FOR-ORDER.csv` | 9,146 B | EDA 原生 BOM；U3/U15 为 DNP 预留（决策 D6，不贴装、不进 BOM） |
| `CPL_CircuitPilot-cpl-DRAFT-NOT-FOR-ORDER.csv` | 70,830 B | EDA 原生贴装坐标（布局未变，180 器件） |
| `GERBER_CircuitPilot-gerber-DRAFT-NOT-FOR-ORDER.zip` | 330,691 B | EDA 原生 Gerber，**含 `Gerber_InnerLayer1.G1` + `Gerber_InnerLayer2.G2`** 与 PTH 钻孔 |
| `manifest.json` | 7,7xx B | 产物清单：outputClass=draft、sha256、gateFingerprint、humanSignoffRequired=true |

生成通道（可复现）：

```bash
curl -X POST -H "x-circuitpilot-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"requested":"draft","kinds":["bom","cpl","gerber"],"outDir":"release/2026-10-20"}' \
  http://127.0.0.1:4179/api/production/export
```

历史批次：`release/2026-10-20-2l/`（同日 2 层尝试，已被本批次取代，仅作存档）、`release/2026-10-19/`、`release/2026-10-16/`。

## 二、4 层是怎么做出来的（全程走 CircuitPilot 自身能力）

1. **叠层能力（产品接口，本轮新增）**
   - 新增 `GET /api/eda/pcb/layers`：读回当前铜层数 + 层表（真机实测返回 `copperCount=4`）；
   - 新增 `POST /api/eda/pcb/layers {copperLayers, approvalIds}`：消费 write 批准 → `pcb.layers.setCount`
     → 读回校验（层数 + `copperLayerIds(4)=[1,15,16,2]` 逐层存在且 type=SIGNAL）→ 保存 → 记录
     `pcb-layer-stack` 证据（`artifacts/evidence/pcb-layer-stack/`）。
   - 真机执行：`2 → 4` 层成功（`changed:true`，`verification.matched:true`，`saved:true`）；随后幂等复跑 `4 → 4`
     也返回 `verification.matched:true`。**内层铜层编号从 15 起**（3/4 是丝印、5/6 是阻焊），层号换算由
     `runtime/engineering/layers.mjs` 统一处理，禁止裸写层号。
2. **4 层铺铜**：GND 铺铜从 2 块扩到 **4 块**（Top / Inner1 / Inner2 / Bottom，`preserveSilos=false`，solid）。
3. **4 层整板重布**（从无铜态导出 DSN，DSN 自动带 4 个铜层）：
   - 方案 A（GND 不参与布线，靠铺铜+缝合）：1108 线 / 138 过孔，DRC 89（Clearance 1）；
   - **方案 B（GND 参与布线，最终采用）**：1634 线 / 159 过孔，
     层分布 Top 1271 / Inner1 174 / Inner2 157 / Bottom 32，**DRC 57（Clearance 0）**。
4. **SES 导入后线宽回置 5 mil**（EDA 导入默认改写 10 mil），重建 4 块铺铜并保存。

## 三、设计状态与验证结论（2026-10-20 14:35 实测）

| 项目 | 2 层（上一轮） | **4 层（本轮）** |
|---|---|---|
| 铜层数 | 2 | **4**（Top/Inner1/Inner2/Bottom，内层 id 15/16） |
| 走线 / 过孔 | 1339 / 153 | **1634 / 159** |
| **PCB DRC** | **110**（Clearance 0） | **57**（**Clearance 0**）：Connection 56（SMD 焊盘 51 / Track 4 / 过孔 1）+ Netlist 1 |
| GND 未连焊盘 | 33 | **2**（`U8_23`、`C12_2`） |
| 信号未连焊盘 | 55（21 网） | **51 个焊盘 / 15 网**（另有 4 段孤立 Track、1 个孤立过孔、1 条 Netlist） |
| Gerber | 2 层 | **4 层**（含 G1/G2 内层文件） |
| ERC | 0/0/6/0 | 0/0/6/0（原理图未改动） |

- **4 层带来的真实变化**：GND 从「33 个孤岛焊盘」降到 **2 个**（内层地平面+铺铜缝合生效）；
  Clearance 保持 **0**；总 DRC 110 → **57（-48%）**。
- 之后又做了 3 轮「残余补线」（4 层 A* 网格 + 精确几何校验，只补有合法扇出位置的焊盘），再清掉若干孤立碎片，
  DRC 63 → **57**（仍是 **Clearance 0**）。残余 51 个焊盘 / 15 网、4 段孤立 Track、1 个孤立过孔、1 条 Netlist。
- **剩余焊盘是同一批物理受限点**（不是路由算法失败）：
  U9（CODEC QFN）、U10（ADC QFN）等 0.4 mm 间距 QFN 焊盘周边净空不足，2 层/4 层都无法在不做
  via-in-pad 的前提下出线；对应网络 ADC_3V3 5、CODEC_3V3 5、USB_D- 3、OUTN 3、IO38_I2S_MCK 3、
  IO13_I2S_WS 3、IO1_I2C_SDA 3、CODEC_OUTN 3、其余各 2。
  4 层解决的是 GND 平面与走线通道，**不改变 0.4 mm 焊盘间距的出线物理约束**。
- **Netlist 1 项**：`Import Changes` 聚合项（原理图↔PCB 匹配性复核），需人工判定。
- **ERC**：致命 0 / 错误 0 / 警告 6 / 信息 0（EDA 只回聚合计数）。

## 四、放行门禁阻塞项（10 项，均为取证/流程类）

`RELEASE_ARTIFACT_MISSING` ×3、`RELEASE_SCHEMATIC_EVIDENCE_MISSING` ×2、`RELEASE_SCHEMATIC_NOT_READY` ×1、
`RELEASE_SIMULATION_NOT_RUN` ×1、`RELEASE_DRC_EVIDENCE_MISSING` ×1、`RELEASE_PLACEMENT_NOT_CONFIRMED` ×1、
`RELEASE_SUPPLY_IDENTITY_MISSING` ×1。

- 布局类阻塞（105 项「距板边 <1 mm」）已在上一轮全部消除；
- DRC 证据已通过运行时任务通道落盘（`artifacts/evidence/drc-report/`，2026-10-20 14:54，57 项），
  但门禁的「产物取证/原理图取证/人工签核」链路仍需单独补齐，故草稿仍为阻断态。

## 五、规则与工艺口径（4 层版）

| 项 | 值 | 说明 |
|---|---|---|
| 叠层 | 4 层：Top / Inner1(GND 平面) / Inner2 / Bottom | 内层铜层编号 **15/16** |
| 安全间距矩阵 | **0.15 mm**（所有铜类两两） | 4 层板厂能力优于 0.15 mm；**本轮未放宽**，保持与前两轮一致 |
| 走线宽度 | 5 mil (0.127 mm) | DSN 预处理线宽 5 mil；SES 导入后回置 5 mil |
| 过孔 | 24/12 mil（0.61/0.30 mm），通孔贯穿 4 层 | 缝合/层间转换统一用通孔 |
| DSN 预处理 | 间距 7.0 / 线宽规则 5 / 间距规则 6.95 mil | 比 5.9 mil 规则多约 1.05 mil 余量 |
| 铺铜 | GND × 4 层（Top/Inner1/Inner2/Bottom），solid，full-board inset 12 mil | `preserveSilos=false` 重建 |

## 六、未结工程输入 / 决策（下单前必须关闭）

1. 摄像头 FPC 24P 引脚定义；2. 舵机 3 脚顺序；3. WS2812 级联顺序；4. SW1/SW2/SW3 角色定义；
5. 4 层板 USB 90 Ω 差分阻抗需要**板厂叠层数据**（铜厚/介质厚/εr）才能反解线宽——目前按 5 mil 保守值走线，未做阻抗控制；
6. A9 128 条布局规则 `SPACE-02`（courtyard 相交即硬违规）在本板不可行（180 器件“本体+0.5 mm”
   面积占可用面积 99.5%），已作为**公开偏差**记录，需人工签核；
7. 人工签核未执行（保留）。

## 七、复现与取证

- 叠层：`GET/POST /api/eda/pcb/layers`（新增产品接口，批准门禁 + 读回校验 + `pcb-layer-stack` 证据）；
- 4 层布线：清空铜 → 导出 4 层 DSN（自动含 Inner1/Inner2）→ Freerouting 2.5.0（`-mp 250 -mt 8 -us Global`，
  方案 B 9 分 34 秒 / pass 20 / 42 条未布通 / 3 条内部违规；随后 3 轮残余补线（4 层 A* + 精确校验））→ SES 导入 → 批量回置 5 mil → 重建 4 块铺铜 → 保存；
- DRC：`POST /api/eda/pcb/drc/start` + `/report`（运行时任务通道，证据落盘 `artifacts/evidence/drc-report/`）；
- ERC：`POST /api/eda/schematic/open-current` 后 `POST /api/eda/schematic/erc/run`。
