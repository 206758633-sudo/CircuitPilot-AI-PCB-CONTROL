# 双电池无缝切换测试板 · 项目基线

| 项 | 内容 |
|---|---|
| CircuitPilot 项目 ID | `dual-battery-tsb` |
| 项目代号 | **DBTS-A01** |
| 阶段 | 需求（CircuitPilot 阶段机：概念 → 需求 → 选型 → 原理图 → PCB → 验证 → 生产） |
| 需求条目 | **55 条**（CircuitPilot 需求库，已落盘 `artifacts/state/project-states/dual-battery-tsb.json`） |
| 候选 BOM | 14 行（全部 pending，待选型确认） |
| 参考资料 | 4 份（需求汇总 v2、会议转写、初版原理图审阅、初步 epro2） |
| 控制台 | <http://127.0.0.1:4177> （本项目为当前工作项目） |
| Runtime | <http://127.0.0.1:4179/api/health> |

> 全过程复盘与可复用 SOP：[`docs/pcb-layout/05-画板全过程复盘与经验沉淀.md`](../../docs/pcb-layout/05-画板全过程复盘与经验沉淀.md)

## 1. 系统定义（2026-10-28 澄清后）

| 项 | 参数 | 来源 |
|---|---|---|
| 负载 | 直流电机，额定 **2 kW**，含再生制动 | 会议 10-28 |
| 外置电池 | **48 V** 电池，优先供电 | 会议 + 用户确认 |
| 内置电池 | **24 V 锂电池组**（串数/化学体系待定） | 用户 2026-10-28 |
| 充电 | **48 V → 24 V 锂电，3–5 A CC/CV（72–120 W）** | 用户 2026-10-28 |
| 电池接口 | **XT60**（60 A） | 用户 2026-10-28 |
| 功率开关 | 背靠背共漏 N-MOS **4 管全保留**（Q1 不省） | 用户 2026-10-28 + 原理图 |
| 切换要求 | 负载**完全不断电**，额定负载稳定输出 | 会议 10-28 |

## 2. 功率拓扑

```
        外置 48V 电池                                       电机负载
        (XT60)                                              (2 kW)
           │                                                   │
           ├── Q1 ──●── Q2 ────────────── VDC 母线 ────────────┤
           │      (共漏)                                        │
           │                                                   │
           └──→ 充电模块 48V→24V 3–5A CC/CV                    │
                     │                                         │
        内置 24V 锂电 ├── Q3 ──●── Q4 ──────────────────────────┘
        (XT60)      │      (共漏)
                    └── 电池本体

栅极驱动：G1–G4（外部控制板给出逻辑电平，本板做电荷泵高边驱动）
采样：V_EXT / V_INT / VDC；在位检测；母线过压 → 制动斩波泄放
```

- **外置通路** Q1/Q2：双向开关，外置在位时导通。
- **内置通路** Q3/Q4：Q3 作单向阀（体二极管 电池→中点），Q4 作双向通道。
- **插入时序**：关 Q3 → 开 Q1/Q2（Q3 体二极管续流，负载不断电，外置接管后 Q3 体二极管反偏阻断倒灌）。
- **拔出时序**：先确认 Q3/Q4 导通 → 再关 Q1/Q2。

## 3. 电流与损耗核算（本次澄清后的关键变化）

| 工况 | 电流 | 单管损耗（3.4 mΩ） | 单路串联两管 | 体二极管续流 |
|---|---|---|---|---|
| 外置 48 V / 2 kW | 41.7 A | 5.9 W | 11.8 W | 0.9 V×42 A ≈ 38 W |
| **内置 24 V / 40 A（限值）** | **40 A** | **5.4 W** | **10.9 W** | **0.9 V×40 A ≈ 36 W** |

**结论（v4，用户确认 24 V 侧限 40 A 后）**：83 A 工况不存在，TO-263 单管 5.4 W、单路串联 10.9 W 可承受；XT60（60 A）满足 42 A。母线电容建议 ≥2000 µF（42 A 下 ≈48 µs/1 V）。2 kW 仅在 48 V 外置供电时保证，24 V 侧需在控制逻辑中做 ≈960 W 功率限制。

## 4. 待确认（阻塞选型/原理图）

1. ~~24 V 锂电池化学体系与串数~~ **已定：6S 锂离子电池，25.2 V 满电、充电 3 A（见 §8）**。
2. 电池容量与最大充放电电流 → 决定回馈限流与充电电流档位。
3. **2 kW 是否要求在 24 V（内置供电）下也能满功率输出** → 决定并联管数与连接器规格。
4. 电机额定电压（48 V / 24 V / 宽压）与反电动势常数。
5. 允许的母线掉压幅度与切换时间上限。
6. 回馈策略：回充电池 / 电阻泄放 / 两者。

## 5. 下一步（CircuitPilot 流程）

1. **需求确认**：把 55 条需求逐条从 `suggested` 推进到 `confirmed`（需用户逐条确认）。
2. **选型**：完成 BOM（含并联管数、电荷泵驱动器、充电模块、TVS、泄放电路）。
3. **新建 EDA 工程**：通过 EasyEDA Bridge 在嘉立创EDA专业版创建全新工程（当前 bridge `edaConnected=false`，需打开 EDA 并启用外部交互）。
4. **原理图计划 → 受控写入 → 回读 → ERC**。
5. **PCB 布局 → DRC → 制造文件**。

## 6. 现有资产

| 文件 | 说明 |
|---|---|
| `docs/hardware/双电池热插拔供电切换板-PCB需求.md` | 需求汇总 v2（含会话 + 会议） |
| `docs/hardware/参考文献-10-28-双电池无缝切换电路设计-会议转写.md` | 会议 ASR 原文 + 歧义判读 |
| `docs/hardware/原理图审阅-测试板初版-2026-10-28.md` | 初版原理图网表与问题清单 |
| `测试板文件/ProPrj_New Project_2026-10-28_16-59-55_2026-10-28.epro2` | 初步原理图（参考，非最终工程） |

---

## 7. 执行状态（2026-10-28 晚）

| 步骤 | 状态 | 证据 |
|---|---|---|
| CircuitPilot 新建项目 | ✅ | `GET /api/projects` → `dual-battery-tsb`，scopedFiles=2（原项目已备份切片） |
| 需求库写入 | ✅ | 55 条，全部带 `projectId=dual-battery-tsb` |
| 候选 BOM | ✅ | 14 行（含 XT60、48V→24V 3–5A 充电模块） |
| 参考资料登记 | ✅ | 4 份（含初步 epro2） |
| 原理图网络表计划 v0.1 | ✅ 校验通过 | `POST /api/design/plan` → ready=true, planHash=`fe49e766…`，18 网络 / 29 操作 |
| 新建 EDA 工程 | ⛔ 阻塞 | `POST /api/eda/workspaces` → `EDA_WINDOW_NOT_CONNECTED`：桥接在线但无 EDA 窗口，需在嘉立创EDA专业版启用 **Run API Gateway** 扩展并允许外部交互 |

### 解除阻塞后即可执行

1. `POST /api/eda/workspaces`（friendlyName=DBTS-A01）建全新原理图工程
2. `POST /api/design/approve` 绑定 planHash 与 EDA 窗口 → `POST /api/design/execute` 受控写入
3. `schematic.erc` → PCB 布局 → DRC → 制造文件

## 7.1 板框与 PCB 进展（2026-10-28 更新，板框数据已过期）

| 项 | 状态 |
|---|---|
| M-01 板框尺寸 | ✅ **已定义：130 × 88 mm**（10-29 02:25 由 120×80 放大 19%，原尺寸最小间隙仅 1.4 mil 无法收敛），4 层，2oz 外层 —— 见 `design/04-PCB板框与布局规则.md` |
| 原理图 | ✅ 8 页，逐页 `sch gate` PASS；网表 70 网，无同轨异名/无单引脚；含 **NRST = 100nF + 10kΩ**（R31/C37） |
| PCB 工程 | ✅ PCB1 已建并 linked；板框 + 4×M3 孔；95 个封装导入；GND/+3V3 内电层已建 |
| PCB 布局 | ✅ 模拟退火优化落位：**0 短路 / 0 重叠 / 0 出板**；ratsnest 110831→**50984 mil**，交叉 494→**140**；`layout-score` **60.3/100 [fair]** |
| 布线 | ✅ 130×88 mm 板框整板自动布线：**1152 段走线 / 191 过孔 / 13 块铺铜**（GND Inner1 平面 + +3V3 Inner2 平面 + 11 块电源铺铜），**DRC 0 间隙 0 连通（通过）**；DFM 审计 **ERROR=0**、WARN=121（耦合/散热孔/线宽类改善项） |
| 丝印 | ✅ 95 个位号全部正置并避开焊盘：`silkFlipped 0` / `silkOverPad 0`（`silk-align` 修 61 个翻转后，用自算环向候选位逐条 `silk-set` 落位） |
| 盘中孔 | ✅ 从布线器源头消除：关闭 Freerouting 扇出（`router.fanout.enabled=false`）后重布，**原 8 个盘中孔归零**；现余 22 个 DFM 提示中 20 个为 GND 平面热/缝合孔（建议树脂塞孔），2 个为圆形焊盘模型误判（实际在铜皮外 20 mil，DRC 0 间隙佐证） |
| 分区框（原理图） | ✅ 已画（P1 5 个、P3 3 个、P5 3 个、P2/P7/P4/P8/P6 各 1 个） |

### 板框要点（详见 04 文档）
- **130 × 88 mm**（原 120 × 80 于 10-29 放大），R2 圆角，原点左下；4 × M3（Ø3.2，内缩 4 mm）+ 板中加强孔位。
- 层叠：L1 信号/功率(2oz) / L2 完整 GND 平面 / L3 电源平面(+3V3) / L4 信号/功率(2oz)。
- 三区：A 功率级（左半板，40 A 铺铜）/ B 充电 Buck（右上）/ C 控制（右下）。
- 规则：40 A 母线铺铜、检流开尔文、栅极回路 ≤60 mm²、SW 节点最小化、48 V 爬电 ≥1.5 mm。

---

## 8. 2026-10-29 设计变更 v2：外置充电模块 + 降压改 5 V

> 本节**取代**上文 §1「内置电池 24 V」与「板载 48V→24V CC/CV 充电」的表述。

| 变更 | 原方案 | 现方案 | 原因 |
|---|---|---|---|
| 充电 | 板载 48 V→29.4 V CC/CV Buck（U9 LM5146 + 检流放大器 + 恒流环路 R28/R29/C34） | **外购现成 6S 3 A 充电模块**（淘宝 id 668512066699 / skuId 4814038489529），**通过排针**接本板 | 普通开关电源无恒流，锂电充电不受控；模块自带 CC/CV、NTC、超时、OVP/OCP |
| 内置电池 | 24 V 锂电组（串数待定） | **6 串（6S）锂电，满电 25.2 V，充电 3 A（≈75.6 W）** | 用户确认「6S，采用 6 串 3A 模块」 |
| 48 V 侧处理 | 直接进充电 Buck | U9 改为 **27.0 V CV 预稳压**（FB 0.8×(1+360k/11k)=26.98 V），给模块 VIN 供电 | 模块 VIN ≤28 V、6S 档需 VIN≳26 V，48 V 不能直入 |
| 降压输出 | +12 V | **+5 V**（R20 33 kΩ / R19 100 kΩ，Vout=1.225×(1+100/33)=4.94 V） | 12 V→3.3 V 线性压差过大、效率低；5 V 给 AMS1117-3.3 后耗散降约 80% |
| 充电状态 | 模拟 CC 环路 → MCU | 模块 ST 脚经 R35 10 kΩ → MCU `CHG_ST`（PA8 组），EN 由 MCU `CHG_EN` 控制 | 保留数字遥测/使能 |

### 8.1 充电链路（P6 页）
```
48V(EXT_48V) ──C39 1000µF/63V──┬── U9 LM5146 Buck(27V CV) ──CHG_VBUS(27V)──┬── J7 (1×6)
                              │  R24 10mΩ 输入检流 + U10 INA240A1 ×20      │   EN ST GND NC VIN NC
                              └─────────────────────────── I_SENSE         └── 外置模块(6S 3A) 直接对插
                                                                              │ NTC NC VBAT NC GND NC
                                                         INT_24V(6S 电池) ◄───┘  (VBAT 经 J12 跳线, 默认开路)
                                                    C29/C30 10µF/50V + J8 (1×6) / J9 (NTC)
```
- 模块规格：50×30 mm，1.2 MHz NMOS-NMOS 同步 Buck，VIN 5–28 V，最大 4 A，1S–6S，±0.5 % 电压 / ±3 % 电流精度，带 NTC、安全定时、输入 OVP、OCP/SCP、电池 OVP；**6S 档输出 25.2 V / 3 A，输入取 27 V**（本板 U9 预稳压给出）。
- 关键器件（6S 版）：U9 反馈 **R25 360 kΩ / R26 11 kΩ → 27.0 V**；输出滤波 **C26–C28 10 µF/50 V ×3**；储能电感 **L2 22 µH / 5.6 A（XAL8080-223MED，C40897141，Isat 6.4 A）**，纹波 ≈2.1 A p-p、峰值 ≈4.1 A；电池侧 **C29/C30 10 µF/50 V**。
- 本板接口（**2026-10-29 14:35 起改为「模块直接对插」，两列排距 47.0 mm**；丝印已标注功能）：
  - **J7**（1×6P 2.54，C5156433，x=4300）= 模块 VIN 侧：pin1 `CHG_EN`(EN)、pin2 `ST_SENSE`(ST)、pin3 `GND`、pin4 **NC**、pin5 `CHG_VBUS` 27 V(VIN)、pin6 **NC**
  - **J8**（1×6P，C5156433，x=2450）= 模块电池侧：pin1 `NTC_BAT`(NTC)、pin2 NC、pin3 `INT_24V_HDR`(VBAT)、pin4 NC、pin5 `GND`、pin6 NC
  - **J12**（1×2P，C5156429）= `INT_24V` ↔ `INT_24V_HDR` 安全跳线，**默认开路**：核对模块引脚无误后再插短接帽，否则 6S 电池不会接到模块 VBAT
  - **J9**（1×2P，C5156429）= `NTC_BAT / GND` 电池包 NTC 接口（与 J8.1 同网）
  - 两列中心距 = 1850 mil = **47.0 mm**（与模块实测一致）；模块 50×30 mm 挂在板下并全部落在板框内；单列 6 位 / 2.54 mm / 跨 12.7 mm
- 网络：`CHG_VBUS`(27 V) / `CHG_VIN`(模块输入) / `EXT_48V` / `INT_24V`(6S 电池侧，沿用旧网名) / `INT_24V_HDR`(模块 VBAT 侧，新) / `FB_CHG` / `CHG_ST` / `ST_SENSE` / `CHG_EN` / `NTC_BAT`。

### 8.2 本版实测状态（2026-10-29 14:45，直插接口版）
| 项 | 结果 |
|---|---|
| 原理图 | P1–P8 逐页 `sch gate`：`check / bridge-check / drc` 全 pass（P6/P8 的 `clusters` 段仅剩标签框视觉重叠告警）；74 网；P6 已把 J7/J8 改 1×6、新增 J12 |
| PCB | **99 个器件**（新增 J12；J7/J8 换 1×6 C5156433） |
| DRC | **间隙违规 0**（唯一 1 条 `Netlist Error` 由工程内重复旧图纸引起，见 REWORK-REPORT §8.7） |
| DFM | **ERROR=0 / WARN=149**（viaInPad 22 = 沿用 GND 热/缝合孔；coupling 42、decapTooFar 10、dangling 9） |
| 布线 | **1250 段走线 / 205 过孔 / 12 块铺铜**；接口 6 个网络全部重新布线并过 DRC |
| 网表一致性 | 原理图导出 ENET ↔ PCB1 逐脚比对：**339 脚 / 74 网，0 差异** |
| 交付物 | `artifacts/final-5v-chg/`：四层板图 PNG、**排针对插界面图 PNG**、BOM（CSV+XLSX，39 行 / 99 器件）、DRC/DFM 证据、网表报告 |

### 8.3 装配干涉修复（2026-10-29 15:20）：C39 / L2 迁到右下角空区
| 项 | 内容 |
|---|---|
| 问题 | 3D 视图红框内实体干涉：`C39`（CD11Z 63V1000μF，Φ16/**≈25 mm**，首版误记 20）压在 `L2`(8.9×4.6 mm)、`Q5`(4.5×5.3 mm)、`C40`(7.5×2.2 mm) 上；且两者都在 J7/J8 ↔ 充电模块装配区内，高过排针连接高度 |
| 新位置 | `C39` → **(4760, 660)**（J2 与 CN3 之间空区，距板边 48 mil）；`L2` → **(4700, 1190)** 旋转 −90°（CN3 上方，距 CN3 本体 73 mil） |
| 装配区高度 | 装配区（`x 2394–4363 / y 1738–2919`）**硬门禁已清**：无任何 `> 8.0 mm`（插合 8.5 − 0.5）的元件。残留推荐级边界项：`C40` RVT 4.7 µF/100 V（Φ6.3 SMD 电解）**7.7 mm**、`L1` SWPA6045 **6.0 mm** —— 分别给出 0.8 mm 余量与 1.5 mm 边缘擦入，须签核或按 §8.4 处理 |
| 重布 | `EXT_48V` L1 30 mil（+1 过孔接下 L15 旧 48 V 主干）、`SW_NODE` L1 40 mil、`CHG_VBUS` L1 40 mil（改走 L2 右侧再折回 J7.5）、`C40.2` 补 1 个 GND 过孔 |
| 结果 | DRC 间隙 **0**（仅剩平台级 `Netlist Error`）；DFM **ERROR=0 / WARN=149**，悬空端 9→7；**1267 走线 / 207 过孔**；99 器件 0 重叠 |
| 折衷 | `SW_NODE` 由 ~140 mil 增至 ~1911 mil（EMI/振铃变差）。若要缩短，可把 `L2` 改到模块窗外贴近 `Q5/Q6` 的 `(4560, 2900)`（≈900 mil），`C39` 保持角落 |

### 8.4 高度表更正 + 规则化（2026-10-29 15:45）

复核发现首版高度表低估了两颗电解：`C40`（封装 `CAP-SMD_BD6.3`，KNSCHA RVT 4.7 µF/100 V Φ6.3×7.7）实为 **7.7 mm** 而非 2.5 mm；
`C39`（`CAP-TH_BD16.0`，63 V 1000 µF）实为 **25 mm** 而非 20 mm。更正后装配区仍有两条**推荐级**边界项（硬门禁已清）：

| 项 | 现状 | 可选动作 |
|---|---|---|
| `C40` 7.7 mm 侵入模块投影 0.89 mm | 硬门禁 PASS（7.7 ≤ 8.0），余量 0.8 mm | ① `C40` 上移 +80 mil（2.03 mm）出投影；② 换 2.54 mm 加高排母，插合高度抬到 11 mm |
| `L1` 6.0 mm 擦区 1.5 mm | 硬门禁 PASS（余 2.5 mm） | 装配区白名单具名接受（模块底面为平面时成立），或换 4.5 mm 同规格电感 |

这两条不再是"人工目测记得住"的口头约束，而是已经写进 CircuitPilot 规则引擎：
新增 **ZCLR 组 9 条**（`docs/pcb-layout/02` §7：高度表完整性、同面 3D 实体干涉、装配区插合高度、维护环带、高件禁区、正反叠装、遮盖区禁放电解、证据覆盖、气流层）
与 **MOVE 组 5 条**（`docs/pcb-layout/03` §8：搬迁登记、SW/PWR 网络长度上限、环路面积上限、搬迁后净空复检、ECO 一致性），
并新增两个真机样板 `DBTS-A01-MODULE-BEFORE/AFTER` 与可复跑脚本 `node scripts/audit-dbts-3d-layout.mjs`。

用引擎复核本板（实板 readback + 高度表）：

| 规则 | 返工前 | 返工后 |
|---|---|---|
| ZCLR-02 同面 3D 实体干涉 | FAIL 3 处（Q5×C39 4.52×5.25、C39×C40 7.47×2.18、C39×L2 8.89×4.57 mm） | PASS |
| ZCLR-03 装配区插合高度 | FAIL 2 件（C39 25 mm、L2 8.1 mm > 8.0 mm） | PASS |
| ZCLR-05/07 高件与遮盖区（推荐） | FAIL（C39/L2/C40/L1） | FAIL（C40 7.7、L1 6.0，待签核） |
| MOVE-02/03 搬迁代价 | NA | REVIEW（SW_NODE 3.6→48.5 mm、环路 ×38，已具名接受） |
| GATE-08 / GATE-09 | FAIL / PASS | REVIEW / REVIEW |


### 8.5 交付链体检 + 规则化（2026-10-29 17:00）

复盘发现这块板还有三个"不是画错线、但发不出去"的问题：工程内重复旧图纸（DRC 那条 `Netlist Error` 的根因）、
**Gerber 从未导出**、`post_route_checked` 门禁从未置 ●。它们现在由新增的 **PRJ 组 6 条 + GATE-10 交付放行门**
（`docs/pcb-layout/03` §9）与 `scripts/circuitpilot-preflight.mjs` 自动判定，登记数据在 [`preflight.json`](preflight.json)。

```bash
npm run preflight:pcb          # = node scripts/circuitpilot-preflight.mjs
# 退出码：0 = GATE-10 PASS；1 = REVIEW；2 = FAIL（可直接接 CI）
```

当前真机结论（`artifacts/final-5v-chg/project-preflight.json`）：

| 规则 | 结论 | 说明 |
|---|---|---|
| PRJ-01 工程对象唯一性 | **FAIL** | 重复旧图纸页名与主设计重名（P6/P8），U9/J7/J8/U7 跨页重复；`PCB1_1` 已登记为 `primary:false` |
| PRJ-02 规则文档与规则包同源 | PASS | 02/03 号文档 sha256 与规则包 `sourceHashes` 一致 |
| PRJ-03 交付物完整性 | **FAIL** | 5/6 类齐备，**缺 Gerber** |
| PRJ-04 阶段门禁证据闭合 | REVIEW | `post_route_checked` 未置位，需签核「DRC+DFM+网表 等效」 |
| PRJ-05 记录一致性 | PASS | README / REWORK-REPORT 关键数字与 15:20 快照一致 |
| PRJ-06 推断项兜底 | PASS | 模块引脚为照片推断，但带「J12 默认开路」+ 4 步核对 |
| **GATE-10 交付放行门** | **FAIL** | 补齐 Gerber + 清理重复图纸 + 签核等效证据后转 PASS |

> ⚠️ 工程内另有一套旧版（3S/20 V）重复图纸 + `PCB1_1`：**投板只用 `PCB1`（9ab008aa6dfb92c2）+ 8 页主图纸**（详见 `REWORK-REPORT.md` §6）。
> 复查修复：R14/R18 分压下臂、U8.7 地线此前悬空，已在 13:10 修复（EXT_SENSE 48 V→3.00 V、VDC_SENSE 48 V→3.00 V、INT_SENSE 25.2 V→2.70 V）。

### 8.6 首次项目复盘沉淀（2026-10-29 17:45，RLA）

用新增的**复盘学习 Agent（RLA）**跑了本项目的第一次真实复盘（`runtime/agents/retrospective-learner.mjs`）：

- **输入**：`artifacts/evidence` 中 `rules` / `drc-report` / `netlist-diff` 最新证据（4 条 error 缺陷 + 84 warning）+ 3 项收尾变更 + 4 条人工经验（3D 遮挡、Netlist Error、高器件复核阈值、双电池架构）；
- **输出**：`retrospective` 证据（`artifacts/evidence/retrospective/retrospective-2026-10-29T09-45-40-297Z-1f83bf5b3fec.json`）+ **9 条 candidate**：1 条项目复盘 module、6 条 failure、1 条 rule、1 条 module；全部 `trust=reference`、`review=candidate`；
- **幂等**：同输入重跑 `created=0, duplicates=9`（payload 不含时间戳，同内容不新增版本）；
- **跨项目合并**：当前只有本项目，`groups=0`（≥2 个项目的同缺陷码才会生成 `RETRO-CODE-*` 候选）。

| 候选 entityKey | kind | 来源 / 说明 |
|---|---|---|
| `RETRO-dual-battery-tsb-PROJECT` | module | 项目复盘（缺陷 4 · 变更 3） |
| `RETRO-dual-battery-tsb-ERC-ERROR` | failure | `rules` 证据里的 ERC error 归并，`needsInvestigation=true` |
| `RETRO-dual-battery-tsb-NETLIST-GND-EMPTY` | failure | `netlist-diff` 证据归并 |
| `RETRO-dual-battery-tsb-NETLIST-NET-MISSING` | failure | `netlist-diff` 证据归并 |
| `RETRO-dual-battery-tsb-NETLIST-PIN-MISMATCH` | failure | `netlist-diff` 证据归并 |
| `RETRO-dual-battery-tsb-3D-C39` | failure | 人工经验：C39 高度按实测 25 mm 复核 |
| `RETRO-dual-battery-tsb-PCB-DRC-NETLIST-ERROR` | failure | 人工经验：重复图纸导致平台级 Netlist Error |
| `RETRO-dual-battery-tsb-R01` | rule | 高器件 3D 遮挡复核阈值（≥20 mm / 高度差 ≥5 mm） |
| `RETRO-dual-battery-tsb-M01` | module | 双电池 48 V→27 V→6S 充电→4.94 V→3.3 V 参考架构 |

> 这些条目现在在 CircuitPilot「知识库 → 审核队列」里等待人工审核（`approved` 前不能作为门禁依据）。
> 补齐 Gerber、清理重复图纸并归档交付后，**归档成功会自动再跑一轮复盘**（`CIRCUITPILOT_RETRO_AUTO=off` 可关）。
