# GitHub 上的 PCB AI 设计约束规则：调研与可用性评估

- 调研时间：2026-10-23
- 方法：GitHub 仓库搜索（`pcb design rules` / `jlcpcb design rules` / `pcb drc rules` / `kicad design rules` / `IPC-2221`）+ 主题页（`design-rules`、`drc`、`jlcpcb`、`pcb-design`、`easyeda`）+ 克隆关键仓库核对文件/许可证/测试
- 结论：**有可直接利用的规则源，但没有“唯一权威的 AI 约束包”**。最值得用的是两类：① 官方 EasyEDA「设计规则生成器」源码（Apache-2.0，规则生成语义 + IPC-2221 电流公式 + 叠层阻抗匹配）；② Cimos/kicad-druid 的 fab capability 数据源（MIT，JLCPCB/PCBWay/Generic 的完整数值矩阵）。

---

## 1. 找到的仓库（按可用价值排序）

| 仓库 | 许可 | 形式 | 能提供什么 | 质量/测试 |
| --- | --- | --- | --- | --- |
| [easyeda/eext-design-rule-generator](https://github.com/easyeda/eext-design-rule-generator) | **Apache-2.0** | TypeScript + 已构建 iframe | 官方「设计规则生成器」扩展源码（v1.9.1）：网络分类、IPC-2221 电流→线宽、叠层匹配、离线 RBF 阻抗反算、生成 `ADR_*` 规则 profile 但不激活 | vitest 单测齐全（rules/stackup/jlc-current/impedance 等 20+ 文件） |
| [Cimos/kicad-druid](https://github.com/Cimos/kicad-druid) | **MIT** | TOML 数据源 + 生成的 `.kicad_dru` + 配对测试板 | JLCPCB / PCBWay / Generic 三套 fab capability：30 条固定限值、4 种层数/铜厚变体、5 类阻抗 net class、工艺注意事项；CI 校验生成物不漂移 | 有配对 PASS/FAIL 测试板，Druid CI lint + DRC |
| [labtroll/KiCad-DesignRules](https://github.com/labtroll/KiCad-DesignRules) | 无 LICENSE 文件 | `.kicad_dru` + 测试板 | JLCPCB KiCad 7 规则，附 PASS/FAIL 测试板；规则语义可参考 | 每规则有验证板 |
| [tinfever/KiCAD-Custom-DRC-Rules-for-JLCPCB-with-Unit-Tests](https://github.com/tinfever/KiCAD-Custom-DRC-Rules-for-JLCPCB-with-Unit-Tests) | 无 LICENSE 文件 | `.kicad_dru` + 单测 PCB | JLCPCB 规则 + 单测；README 明确记录 JLC 规则自相矛盾处（PTH 孔径、annular ring、via/PTH 区分） | 单元测试 |
| [pcbway/PCBWay-Design-Rules](https://github.com/pcbway/PCBWay-Design-Rules) | 无 LICENSE 文件（官方账号） | Altium `.RUL`、Eagle `.dru`、KiCad zip、Allegro zip | PCBWay 2/4/6/8 层、1/2oz 的 DRC 与叠层文件 | 官方发布，无测试 |
| [Huaqiu-Electronics/NextPCB-Manufacturing-Rules](https://github.com/Huaqiu-Electronics/NextPCB-Manufacturing-Rules) | 无 LICENSE 文件（官方账号） | KiCad `.kicad_pcb/.kicad_pro` 模板 | NextPCB Simple/Advanced DRC 模板 | 官方发布，无测试 |
| [easyeda/easyeda-api-sdk](https://github.com/easyeda/easyeda-api-sdk) | Apache-2.0 | TypeScript SDK | 官方 API/SDK，含 DRC、规则、网络类等接口类型；用于“写规则”而非“规则值” | 官方维护 |
| [Cimos/KiCad-CustomDesignRules](https://github.com/Cimos/KiCad-CustomDesignRules) | — | README | 已迁移到 kicad-druid，仅保留旧链接 | — |

> 许可提示：Cimos/kicad-druid 是 MIT，官方 EasyEDA 仓库是 Apache-2.0，可安全复用（保留声明）；**labtroll/tinfever/PCBWay/NextPCB 没有 LICENSE 文件，只能把数值当公开事实参考，不能整段复制其文件/代码**。

---

## 2. 可直接提取的数值约束（JLCPCB vs PCBWay vs Generic）

来自 Cimos/kicad-druid 的生成对照表（MIT），完整机读版已落到
`fab-capabilities.json`（由使用者自备的板厂能力表）。

### 2.1 固定限值（30 条，单位 mm，节选）

| 参数 | JLCPCB | PCBWay | Generic |
| --- | --- | --- | --- |
| 钻孔最大 | 6.3 | 6.3 | 6.3 |
| 过孔 annular ring 最小 | 0.05 | 0.15 | 0.15 |
| PTH 孔径最小 | 0.15 | 0.2 | 0.2 |
| PTH annular ring 最小 | 0.15 | 0.15 | 0.15 |
| NPTH 孔径最小 | 0.5 | 0.5 | 0.5 |
| 金属化槽宽最小 | 0.35 | 0.5 | 0.5 |
| 非金属化槽宽最小 | 1.0 | 0.8 | 1.0 |
| 异网过孔孔-孔 | 0.2 | 0.5 | 0.5 |
| 异网孔-焊盘孔 | 0.45 | 0.5 | 0.5 |
| 同网孔-孔 | — | 0.254 | 0.254 |
| 异网焊盘-焊盘（无孔） | 0.15 | 0.127 | 0.15 |
| 过孔孔到走线 | 0.2 | 0.254 | 0.254 |
| PTH 孔到走线 | 0.28 | 0.33 | 0.33 |
| 焊盘到走线 | 0.2 | 0.2 | 0.2 |
| SMD 焊盘最小 | 0.125 | — | 0.125 |
| BGA 到走线 | 0.1 | — | 0.1 |
| 丝印线宽最小 | 0.15 | 0.15 | 0.15 |
| 丝印字高最小 | 1.0 | 0.8 | 1.0 |
| 焊盘到丝印 | 0.15 | 0.15 | 0.15 |
| 走线到板边（铣边） | 0.2 | 0.3 | 0.3 |

### 2.2 变体矩阵（4 组：2L-1oz / 4L-1oz / 4L-2oz / 6L-1oz）

| Fab / 变体 | 最小孔 | 最小过孔 | 外层线宽 | 外层间距 | 内层线宽 | 内层间距 |
| --- | --- | --- | --- | --- | --- | --- |
| JLCPCB 4L-1oz（默认） | 0.15 | 0.15 | 0.09 | 0.09 | 0.09 | 0.09 |
| JLCPCB 4L-2oz | 0.15 | 0.15 | 0.15 | 0.15 | 0.15 | 0.15 |
| PCBWay 4L-1oz（默认） | 0.15 | 0.2 | 0.09 | 0.09 | 0.1 | 0.1 |
| PCBWay 4L-2oz | 0.15 | 0.2 | 0.1524 | 0.1778 | 0.1524 | 0.1778 |
| Generic 4L-1oz | 0.15 | 0.2 | 0.09 | 0.09 | 0.1 | 0.1 |

### 2.3 阻抗 net class（典型起点值，非通用默认）

| Net class | JLCPCB（宽/距） | PCBWay | Generic |
| --- | --- | --- | --- |
| `50R` | 0.2 / n/a | 0.2 / n/a | 0.2 / n/a |
| `60R_Diff` | 0.3 / 0.15 | 0.3 / 0.15 | 0.3 / 0.15 |
| `90R_Diff` | 0.2 / 0.13 | 0.2 / 0.13 | 0.2 / 0.13 |
| `100R_Diff` | 0.2 / 0.2 | 0.2 / 0.2 | 0.2 / 0.2 |
| `120R_Diff` | 0.15 / 0.2 | 0.15 / 0.2 | 0.15 / 0.2 |

### 2.4 工艺注意事项（比数值更重要的“隐性规则”）

- JLCPCB 对 **小孔做四线 Kelvin 测试会加价**；孔 <0.3mm 且过孔直径 <0.45mm 会加价。
- JLCPCB 标准工艺**不允许盲埋孔**；金属化槽长宽比 ≥2。
- 同网走线间距在 KiCad 里是“禁用的 workaround”（0.25mm），不要当通用规则。
- JLC 的 PTH/via 孔径、annular ring 规则**自相矛盾**（tinfever README 有完整记录）；照抄会误报，必须按“保守交集”处理并标注来源。

---

## 3. 官方「设计规则生成器」的规则语义（最接近 AI 约束）

仓库：[easyeda/eext-design-rule-generator](https://github.com/easyeda/eext-design-rule-generator)（Apache-2.0，扩展 v1.9.1，用户机器上已装同款扩展）。

### 3.1 网络分类（`src/core/rules.ts`）

| 类别 | 识别规则 | 默认目标 |
| --- | --- | --- |
| ground | `GND/AGND/DGND/PGND/GNDA/GNDD` 前缀 | 地线宽 |
| power | `+3V3/1V8/VBUS/VCC/VDD/VBAT/VCORE/...` | 电源线宽 |
| differential | `_DP/_DM`、`_P/_N`、`P/N`、`+/-` 成对 | PCIe 85Ω / USB 90Ω / 其它 100Ω |
| impedance | 网名含 `_Z50` 形式（`Z(\d{2,3})`） | 50Ω 单端 |
| signal | 其余；孤立 `_P` 等给 warning | 普通线宽 |

### 3.2 规则生成

- 每个类别/阻抗目标生成一个 `ADR_*` profile：`ADR_POWER_20MIL`、`ADR_GROUND_24MIL`、`ADR_Z50_7_2MIL`、`ADR_DIFF90_5_1MIL_6GAP`。
- 差分对生成 `ADR_<pair>` 并配对正负网络。
- **安全策略**：把配置另存为“工程名-板名”的新配置，**不激活、不改当前 PCB 的 net class/差分对/网络颜色**；用户需在 EDA 里手动选择。
- 生成前检查现有配置结构，模板缺失即报错，不猜字段。

### 3.3 电流→线宽（`src/core/jlc-current.ts`）

反推自嘉立创官方计算器，IPC-2221 截面公式：

```
f(mil²) = (I / (k·ΔT^0.44))^(1/0.725)     k=0.048 外层 / 0.024 内层
width   = f 转 cm² / 铜厚(cm) / 0.1        → mm
```

另含过孔载流 `maxCurrentA = 3140·d_mm/25.4·t_μm/25.4·ΔT^0.44` 形式（官方经验常数 3140）。

### 3.4 叠层与阻抗

- 按 `板类型/层数/板厚/内层铜厚/外层铜厚` 精确匹配嘉立创叠层模板；排除“自定义/废弃/作废”模板。
- 用微带/差分近似公式反算线宽（`solveWidth` 二分），并给可制造性打分（宽度 <3.5mil 或 >20mil 罚分）。
- 叠层数据 `stackups.json` 8.6MB，含全部 JLC 模板。

---

## 4. 这些规则怎么用到 CircuitPilot

### 4.1 直接补进现有 128 条规则体系的（建议 12–16 条）

| 规则族 | 来源 | 建议检查 |
| --- | --- | --- |
| FAB 制造能力 | Cimos（MIT） | 最小线宽/间距、过孔/孔径/annular ring、槽宽、板边间距、丝印字高线宽、SMD 焊盘最小 |
| 电流驱动线宽 | 官方 JLC 公式 | 电源网按电流+铜厚+温升计算最小宽度，低于即 FAIL |
| 网络分类 | 官方扩展语义 | 电源/地/差分/阻抗网识别，缺失配对、孤立 `_P` 给 warning |
| 阻抗/叠层 | 官方扩展 + Cimos | 目标阻抗是否与叠层/线宽/间距匹配；叠层缺失即 REVIEW |
| 工艺红线 | Cimos | 盲埋孔、Kelvin 小孔、金属化槽长宽比、同网间距 workaround 标注 |
| 规则生成 | 官方扩展 | 生成 `ADR_*` 建议（只读预览，不写 EDA 配置） |

### 4.2 与现有规则包的关系

- CircuitPilot `runtime/engineering/rules/board-layout-rules.json` 是**示例板**的 128 条布局/DFM 规则；新补的是**工艺能力（fab capability）+ 电气驱动（电流/阻抗/网络）**两层，不重复。
- 建议新增独立 pack：`runtime/engineering/rules/fab-rules.json` + `net-rules.json`，避免污染现有 128 条的来源声明。
- 所有新规则先 **advisory**，不直接进 `GATE-*`；与上一份 内部 skill 约束清单 的 zone/access/keepout/two-round 缺口一起排期。

### 4.3 不要做的事

- 不要复制 `.kicad_dru`/Altium `.RUL` 文件当运行时数据（格式绑定、且多数仓库无许可）。
- 不要把官方扩展的 8.6MB `stackups.json` 塞进 CircuitPilot；需要时按板参数只取匹配项。
- 不要把具体考题/样例数值当通用默认（官方扩展和 Cimos 都明确写了“以实际叠层/板厂确认为准”）。

---

## 5. 建议的落地顺序（下一步）

1. **数据层**：把 `fab-capabilities.json` 并入 `runtime/engineering/rules/`，加来源/许可/版本字段（MIT 署名）。
2. **检查器**：新增 `runtime/engineering/fab-rules.mjs`，实现 4.1 表中 12–16 条（PASS/FAIL/REVIEW/NA，REVIEW≠PASS），先 advisory。
3. **网络/电流**：新增 `runtime/engineering/net-rules.mjs`，移植官方 `classifyNets` + IPC-2221 公式（Apache-2.0，保留 NOTICE），对电源网与差分对做只读检查。
4. **规则生成预览**：生成 `ADR_*` 建议清单，走 `/api/engineering/*` 只读返回；写 EDA 配置仍需审批（当前桥没有 config 写命令）。
5. **回归夹具**：用 Cimos 的 JLCPCB/PCBWay 数值做 golden cases（MIT），用官方扩展的 `rules.test.ts` 语义做行为对照。

---

## 6. 参考链接

- EasyEDA 官方设计规则生成器：https://github.com/easyeda/eext-design-rule-generator
- EasyEDA 官方 API SDK：https://github.com/easyeda/easyeda-api-sdk
- Cimos/kicad-druid（fab capability 数据源）：https://github.com/Cimos/kicad-druid
- Labtroll JLCPCB 规则：https://github.com/labtroll/KiCad-DesignRules
- tinfever JLCPCB 规则与矛盾记录：https://github.com/tinfever/KiCAD-Custom-DRC-Rules-for-JLCPCB-with-Unit-Tests
- PCBWay 官方规则：https://github.com/pcbway/PCBWay-Design-Rules
- NextPCB 官方规则：https://github.com/Huaqiu-Electronics/NextPCB-Manufacturing-Rules
- 嘉立创能力页：https://jlcpcb.com/capabilities/pcb-capabilities
- PCBWay 能力页：https://www.pcbway.com/capabilities.html

---

## 7. 实现状态（2026-10-23 已落地）

按第 5 节顺序完成了前两步的最小可用版本，全部为**只读审计**，不写 EDA 配置、不进阻断门：

### 7.1 新增文件

| 文件 | 作用 |
| --- | --- |
| [runtime/engineering/rules/fab-capabilities.json](../../runtime/engineering/rules/fab-capabilities.json) | 板厂能力数据包（30 条限值、3×4 变体、5 类阻抗、9 条工艺注意事项，带 MIT 来源/许可） |
| [runtime/engineering/fab-rules.mjs](../../runtime/engineering/fab-rules.mjs) | FAB-01..FAB-16 检查器 + 样板 + 包校验 |
| [runtime/engineering/net-rules.mjs](../../runtime/engineering/net-rules.mjs) | NET-01..NET-05：网络分类、IPC-2221 载流线宽、差分对配对、目标阻抗、过孔载流 |
| [runtime/__tests__/fab-net-rules.test.mjs](../../runtime/__tests__/fab-net-rules.test.mjs) | 11 个测试：数据包/合规/缺陷/缺数据/确定性/HTTP |
| [runtime/server.mjs](../../runtime/server.mjs) | 新增 4 个只读路由 |

### 7.2 规则清单

| 编号 | 规则 | 级别 |
| --- | --- | --- |
| FAB-01 | 最小走线宽度（外层/内层） | 硬门禁 |
| FAB-02 | 最小走线间距（外层/内层） | 硬门禁 |
| FAB-03 | 过孔孔径 | 硬门禁 |
| FAB-04 | 过孔 annular ring | 硬门禁 |
| FAB-05 | PTH 孔径（min/max） | 硬门禁 |
| FAB-06 | PTH annular ring | 硬门禁 |
| FAB-07 | NPTH 孔径 | 硬门禁 |
| FAB-08 | 金属化槽宽度 + 长宽比 | 硬门禁 |
| FAB-09 | 非金属化槽宽度 | 硬门禁 |
| FAB-10 | SMD 焊盘最小尺寸 | 硬门禁 |
| FAB-11 | 丝印线宽/字高 | 推荐 |
| FAB-12 | 焊盘到丝印间距 | 推荐 |
| FAB-13 | 走线到板边 | 硬门禁 |
| FAB-14 | 盲埋孔禁令 | 硬门禁 |
| FAB-15 | JLCPCB 小孔/小过孔加价提示 | 推荐 |
| FAB-16 | 变体与层数/铜厚一致性 | 硬门禁 |
| NET-01 | 网络分类完整性（命名歧义 → REVIEW） | 推荐 |
| NET-02 | 电源网载流线宽（IPC-2221） | 硬门禁 |
| NET-03 | 差分对配对（声明 vs 分类） | 硬门禁 |
| NET-04 | 目标阻抗匹配（微带/差分近似，±10%） | 硬门禁 |
| NET-05 | 过孔载流 | 硬门禁 |

判定语义：`PASS / FAIL / REVIEW / NA`，**REVIEW ≠ PASS**；`passed` 只表示无硬门禁 FAIL，`releaseReady` 还要求 REVIEW 为 0。

### 7.3 只读 API

```text
GET  /api/engineering/fab-rules                     # 数据包元信息 + 样板名（不返回 30 条正文）
POST /api/engineering/fab-rules/audit               # {fixtureId} 或 {input}
GET  /api/engineering/net-rules                     # 5 条规则说明 + 样板名
POST /api/engineering/net-rules/audit               # {fixtureId} 或 {input}
```

`input` 最小示例：

```json
{
  "fab": "JLCPCB",
  "variant": "4L-1oz",
  "design": {
    "layers": 4,
    "copperOz": 1,
    "minTraceWidthMm": { "outer": 0.12, "inner": 0.12 },
    "minSpacingMm": { "outer": 0.12, "inner": 0.12 },
    "holes": [{ "id": "V1", "type": "via", "diameterMm": 0.3, "outerDiameterMm": 0.5, "annularRingMm": 0.1 }],
    "smdPads": [{ "id": "R1", "widthMm": 0.8, "heightMm": 0.6 }],
    "silk": { "lineWidthMm": 0.15, "textHeightMm": 1.0, "padToSilkMm": 0.2 },
    "traceToEdgeMm": 0.3,
    "slots": [{ "id": "S1", "plated": true, "widthMm": 0.5, "lengthMm": 2.0 }],
    "blindBuriedVias": false
  }
}
```

`net-rules` 输入支持 `nets`、`copper`（厚度/内外层/温升）、`power[]`、`pairs[]`、`impedance[]`（含 `stackup.heightMm/er`）、`vias[]`。

### 7.4 仍未做（下一步）

- 规则生成预览（`ADR_*` 建议清单）只完成了官方语义调研，尚未实现；
- 写回 EDA 配置仍被桥限制（只有 `pcb.rules.read` / 新增只读 `pcb.rules.detail`，没有写命令），所以所有输出保持 advisory；
- 阻抗公式是初筛近似，正式验收必须用板厂叠层阻抗计算器/实测；
- FAB/NET 规则还没有并入前端验证页（当前只有 API + 测试消费者）。

第二批 skill 约束（zone/keepout/两轮自检/丝印/net-class 等）见 内部 skill 约束清单 §8：SKL-01..10 与只读 `constraint-rules` API 已落地。
