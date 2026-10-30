# Round 61 · T3 SPICE / 网表仿真证据链

**结论一句话**：真实网表已从嘉立创 EDA 只读导出并落盘（64 器件 / 34 命名网络 / sha256 `a7bbca3f…`），
并基于其中**真实存在的 VBUS、VBAT、GND 网络连接**用 ngspice-46 跑完了 `.op` + `.tran`（退出码均为 0，
`.op`：`vbus=5.000 V`、`vbus_vin=4.975 V`、`vbat_pack=3.740 V`；`.tran`：`vbat_end=4.138 V @1800 s`）。
**但整板/全功能 SPICE 仍然不能自动化**：EDA 官方 Ngspice 仿真网表导出返回 `null`（该页没有绑定任何仿真器件模型），
且本页 266 个引脚中 171 个（64.3%）没有网络归属（全部无源件引脚悬空），不存在"器件—器件"互连子电路。
因此本轮交付的是**可复核的网表 + 真实求解器证据链 + 显式标注假设的子电路 testbench**，
不是"整板仿真通过"。

- 证据 JSON：`artifacts/spice/simulation-evidence-2026-10-21T11-34-43-973Z.json`
- 可重跑脚本：`scripts/spice-evidence.mjs`（只读 EDA、不写设计、不访问网络）
- 复现：`node scripts/spice-evidence.mjs`（退出码 0 = 证据链完整，2 = BLOCKED，1 = 脚本自身异常）

---

## 1. 真实网表（权威读回，只读）

| 项 | 值 |
| --- | --- |
| 工程 | `eda_yfmjlvgv/衣橱助手V2.0-AI设计`（uuid `ba4924190e3a4388a097f3dee090da20`） |
| 板 / 原理图 / 页 | Board1_1 / Schematic1_3（`497616c287ca5819`）/ P2（`87dba2a22fe7096e`，活动文档） |
| 导出命令 | `sch_ManufactureData.getNetlistFile('circuitpilot-netlist','EasyEDA')`（与 runtime `schematic.netlist.export` 同一条代码路径） |
| 落地文件 | `artifacts/spice/netlist-2026-10-21T11-34-43-973Z.net` |
| 大小 / sha256 | 168941 bytes / `a7bbca3fe9f0ab3738d05ddb704f6e119fc8297895e7515ed432651e05fec3e2` |
| 格式 | `easyeda-netlist-json@2.0.0` |
| 器件数 | **64**（`U1–U6,U8,U13,MK1,USB1,Q1,D1,D2,CN1,CN5,J7,R1–R25,C1–C22,L1`） |
| 引脚数 / 有网引脚 | 266 / **95** |
| 命名网络数（pinInfoMap 口径） | **34**（`+3V3 +5V VBUS VBAT AMP_CTRL I2S_* MIC_OUT CAM_1…CAM_24`） |

两次独立运行导出的网表 sha256 完全一致（`a7bbca3f…`），可作为该原理图页的**设计内容指纹**。
注意：该 EasyEDA 网表 JSON 的顶层 `nets` 数组为空，连通性只体现在 `components[*].pinInfoMap[*].net` 中，
解析时不能把 `nets.length === 0` 当成"没有网络"。

## 2. 第二次独立读回：导线端点 ↔ 引脚坐标（交叉核对）

为了不把单一来源当真理，脚本额外用只读 API 重建连接：
`sch_PrimitiveComponent.getAll` + `getAllPinsByPrimitiveId`（引脚坐标）+ `sch_PrimitiveWire.getAll`。
本页的实际接线形式是 **10 mil 网络短桩**：wire 一端落在引脚坐标、`net` 字段携带网络名，
所以"引脚坐标 == 导线端点"就是该引脚的真实网络归属。

| 项 | 值 |
| --- | --- |
| 导线数 / 带网导线 | 95 / 95 |
| 器件 / 引脚 / 有网引脚 | 64 / 266 / 95 |
| 网络数（含 GND） | **35** |
| 与网表逐引脚一致 | 80 |
| **与网表不一致** | **15** |
| 只在导线读回出现的网络 | `GND` |

### 2.1 关键不一致（必须写进证据链的发现）

官方网表把 15 个**本应接 GND 的引脚**标注成了 `+3V3`
（例如 `U1.1/U1.40/U1.41(GND)`、`U5.8(GNDD)/U5.21(GNDA)/U5.33(EP)`、`U6.7/U6.9(EP)`、
`USB1.A1B12/B1A12/EP`、`U2.9(EP)`、`U3.2`、`U4.2`、`MK1.3`）。
导线读回与引脚名（GND/GNDA/EP）一致指向 `GND`。

- 影响：**若直接拿官方网表的 pinInfoMap 建 SPICE deck，会得到 +3V3 与 GND 短接的假电路。**
- 本证据链的处理：deck 只使用两种读回**一致**的 `VBUS`/`VBAT` 网络；`GND` 归属以导线读回 + 引脚名为准，
  并在 evidence JSON 的 `connectivity.crossCheck.disagreements` 里保留全部 15 条原始证据。
- 该现象更像是该页 net flag 导出/解析问题（网络名解析落到了另一个电源网络），建议作为 EDA/原理图侧
  人工复核项（见 §5）。

## 3. EDA 官方 SPICE 仿真网表探测（直接证据：不可自动）

`sch_ManufactureData.getSimulationNetlistFile('circuitpilot-sim','Ngspice')` → **`null`**。
即：该原理图页没有绑定任何仿真器件模型，EDA 无法直接产出 Ngspice 网表。
这正是"完整板级/整机 SPICE 仍不可自动"的直接证据，也是 A14 之前拿到的同一条结论的现场复核
（旧的 A14 证据用的是 53 bytes 手写探针网表，不是真实设计网表；本轮补上了真实网表这一环）。

## 4. 真实连接上的小子电路 + 真实 ngspice 运行

### 4.1 选中的子电路（连接全部来自真实网表）

USB-C VBUS 输入 → IP2312（U2）充电 → VBAT（CN5.1）电池等效：

| 网络 | 真实端点（网表 pinInfoMap，两种读回一致） |
| --- | --- |
| `VBUS` | `U2.8(VIN)`、`USB1.A4B9`、`USB1.B4A9`、`Q1.A2(S)`、`Q1.B2(S)` |
| `VBAT` | `U2.5(BAT)`、`CN5.1` |
| `GND` | 15 个 GND/GNDA/EP 引脚（导线读回） |

### 4.2 真实 vs 假设（**不可混淆**）

| 类别 | 内容 |
| --- | --- |
| **真实**（来自 EDA / 网表） | 网表文本与 sha256、器件位号/型号/铭牌、网络名、引脚—网络归属、网络端点数、ngspice 二进制与版本、求解器输出、退出码 |
| **显式假设**（人工模型选择） | USB-C 源 5.0 V；IP2312 行为充电模型 `ICHG=min(0.5 A, 2 A/V×(4.2−V(VBAT)))`；电池 `.op` 用 3.70 V OCV + 80 mΩ、`.tran` 用 1500 F 电荷存量降阶模型；连接器/走线 50 mΩ |
| **不能声称** | 本 deck 数值**不是**整板性能签核结论；它只证明"真实网表连接 + 真实求解器"这条链路可跑通且可复核 |

EDA 仿真模型缺失清单（人工需补）：ESP32-S3-WROOM-1、IP2312、MT3608、SY8089、ES7210、NS4168、
TVS/SS34、MOSFET FDZ451PZ、麦克风 LMA2718 等均无绑定 SPICE 模型。

### 4.3 deck 与运行结果

| 项 | .op deck | .tran deck |
| --- | --- | --- |
| 文件 | `artifacts/spice/deck-op-2026-10-21T11-34-43-973Z.cir` | `artifacts/spice/deck-tran-2026-10-21T11-34-43-973Z.cir` |
| sha256 | `27ef2a1bec51d1c9af87e015be545010126df7d4b09a67e97eea6cfe0eecaecc` | `4717f5026e6015d6c15786f985de217c9d587ab2b13818f6115c71e9433a0a49` |
| 分析 | `.op` | `.tran 1 1800 0 1 UIC`（0→1800 s）+ 5 条 `.meas` |
| 命令 | `/opt/homebrew/bin/ngspice -b -o <log> <deck>` | 同左 |
| 版本 | ngspice-46（KLU Direct Linear Solver） | ngspice-46 |
| 退出码 | **0** | **0** |
| stdout/stderr | 544 B / 0 B | 546 B / 0 B |
| 日志 sha256 | `fb63c9e9…` | `8b7adb70…` |

**.op 节点电压（ngspice 真实输出）**

| 节点 | 电压 | 含义 |
| --- | --- | --- |
| `vbus` | 5.000 V | USB-C 源（假设值） |
| `vbus_vin` | 4.975 V | 50 mΩ 接触电阻上的 25 mV 压降（0.5 A） |
| `vbat_pack` | 3.740 V | 电池 OCV 3.70 V + 80 mΩ×0.5 A |
| `vbat_ocv` | 3.700 V | 电池开路电压（假设） |

**`.tran` `.meas` 结果（ngspice 真实输出）**

| 测量 | 值 | 含义 |
| --- | --- | --- |
| `vbat_10` | 3.70333 V | 10 s 时电池电压（CC 起点附近） |
| `vbat_900` | 3.99532 V | 900 s 时电池电压 |
| `vbat_end` | 4.13835 V | 1800 s 时电池电压（CC→CV 收敛段） |
| `vbat_max` | 4.13835 V | 全程最大值 |
| `ichg_10` | −0.500 A | 10 s 时 `i(Vusb)`（负号=流出源，即 0.5 A CC 充电） |

`.tran` deck 在带 `-o` 的批处理里会打印 gmin/source stepping 的提示行；
本次两次运行 exit code 均为 0、`.meas` 全部求得，提示行仅作诊断保留（见 evidence `runs[*].warnings`）。

## 5. 仍需人工（不是本任务能自动完成的部分）

1. **绑定仿真模型**：在嘉立创 EDA 里给关键器件绑定 SPICE 模型，才能让官方 `getSimulationNetlistFile`
   返回非空网表 → 整板/整机仿真。当前返回 `null`，这是硬边界。
2. **补全原理图互连**：本页 266 引脚中 171 个悬空（64.3%），全部 R/C/L 无源件"只放器件、没有网络"，
   因此无法从本页提取任何"器件—器件"互连子电路。典型待复核项：
   - `R19/R20`（5.1 kΩ，USB-C CC1/CC2 下拉）两端均无网 → Type-C 受电识别电路未连通；
   - `C1…C22` 去耦电容一端落在 `+5V/+3V3`、另一端（GND 侧）无网 → 去耦链未闭环；
   - `D2(SS34)` 阳极接 `+5V`、阴极无网 → 单向通路不成立（方向/落点需复核）；
   - `R21…R25`（650 Ω，LED 限流意图）与全部 LED 均未出现在网表中，对应负载未落地。
3. **复核网表 GND/`+3V3` 误标**：15 个 GND 引脚在导出网表中被标成 `+3V3`（见 §2.1）。
   需要用 EDA 侧 net flag/电源符号再确认一次；否则任何"直接用导出网表建网表/仿真/ERC 比对"的流程
   都会引入短路级假象。
4. **模型参数选型**：行为模型参数（充电电流倍率、电池容量/内阻、接触电阻）是人工选值，
   需要按实际电池与线束标定后才能用于设计签核。

## 6. 复现命令

```bash
cd "/Users/jescochen/Desktop/AI- PCBA"

# 一键复跑（只读 EDA；需要 EasyEDA 已连接 Bridge 49620 与 /opt/homebrew/bin/ngspice）
node scripts/spice-evidence.mjs
# 退出码 0 = 证据链完整；2 = BLOCKED（JSON 里给出 blockedReasons）；1 = 脚本自身异常

# 单独人工复跑本次的两份 deck（数字应与 §4.3 一致）
/opt/homebrew/bin/ngspice -b artifacts/spice/deck-op-2026-10-21T11-34-43-973Z.cir
/opt/homebrew/bin/ngspice -b artifacts/spice/deck-tran-2026-10-21T11-34-43-973Z.cir

# 校验网表指纹（应等于 a7bbca3fe9f0ab3738d05ddb704f6e119fc8297895e7515ed432651e05fec3e2）
shasum -a 256 artifacts/spice/netlist-2026-10-21T11-34-43-973Z.net
```

可覆盖的环境变量：`CIRCUITPILOT_BRIDGE_PORT`（默认 49620）、
`CIRCUITPILOT_SCHEMATIC_PAGE`（默认 `87dba2a22fe7096e`）、
`CIRCUITPILOT_PROJECT_UUID`、`CIRCUITPILOT_NGSPICE`（默认 `/opt/homebrew/bin/ngspice`）。

## 7. 产物清单

```
artifacts/spice/
  netlist-2026-10-21T11-34-43-973Z.net          真实 EasyEDA 网表（169 KB, sha256 a7bbca3f…）
  deck-op-2026-10-21T11-34-43-973Z.cir          .op testbench（来自真实 VBUS/VBAT 连接）
  deck-tran-2026-10-21T11-34-43-973Z.cir        .tran testbench（同上 + 5 条 .meas）
  ngspice-op-2026-10-21T11-34-43-973Z.log       .op 求解器完整输出
  ngspice-tran-2026-10-21T11-34-43-973Z.log     .tran 求解器完整输出
  simulation-evidence-2026-10-21T11-34-43-973Z.json   证据 JSON（含上述全部 sha256/退出码/数值/发现/假设）
scripts/spice-evidence.mjs                      可重跑证据链脚本
docs/implementation/round61-spice-evidence.md   本文档
```
