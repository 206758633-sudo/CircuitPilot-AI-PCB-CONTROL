# 知识库冲突登记表（Conflict Register）

> 目的：同一工程问题在知识库、项目规则包、板厂能力表、datasheet 之间出现不同数值时，**先登记口径与优先级，再谈谁对谁错**；禁止用一条规则直接否定另一条规则。
> 机器可读版：[`knowledge/pcb/dataset/conflicts.json`](../../knowledge/pcb/dataset/conflicts.json)；分类映射：[`taxonomy.json`](../../knowledge/pcb/dataset/taxonomy.json)。
> 状态：本表只做“口径裁决与优先级登记”，不修改历史条目 payload（避免产生大量新版本）；新增条目必须写清 `scope`。

## 0. 口径定义（先统一词）

| 口径 | 含义 | 典型判据 |
|---|---|---|
| 元件本体 | 器件塑封/陶瓷体/连接器外壳的物理外框 | 到板边、到 V-CUT 的禁布距离 |
| 焊盘/开窗 | 铜焊盘或阻焊开窗边缘 | 到板边、到 V-CUT 的铜避让 |
| 铜/走线 | 内层/外层铜箔边缘 | 到板边、到孔/槽的铜避让 |
| 工艺边 | 拼板上用于贴片机轨道/定位的边 | 宽度、禁布、Mark 位置 |
| 连接筋 | V-CUT/邮票孔之间保留的板料 | 宽度、禁放易损件 |
| 电气判据 | 由 datasheet/仿真给出的电学上限（pH、阻抗、热阻） | 优先于 mm 经验值 |

## 1. 优先级（从高到低）

1. **L1 项目规则包 / 当前板厂能力表 / 工程确认单**：`rules/board-layout-rules.json`（128 条可执行规则）、厂家最新能力表、EQ 确认。项目已量化的值优先。
2. **L2 器件 datasheet / 模组 layout guide**：引脚、焊盘、净空、时序、热阻、寄生电感上限。
3. **L3 本知识库通用规则**：无项目规则包时的默认基线。
4. **L4 经验值 / 市场惯例**：只能作推荐值，不得单独作为硬门禁；必须标注“经验”。

> 同级冲突：取**更严格且可测**的值；无法判定时按 L1→L2 顺序裁决，并在评审记录写明依据。

## 2. 已登记冲突组

| 组 | 涉及规则 | 冲突/重叠点 | 裁决（scope） | 状态 |
|---|---|---|---|---|
| EDGE-PANEL | `EDGE-001`、`PANEL-001`、`PLACE-EDGE-001`、`PLACE-PANEL-001` | 0.5 / 1 / 3–5 / 0.4 mm 四个数值混用 | 0.5 mm=元件本体到铣边**硬最小**；1 mm=V-CUT/邮票孔两侧**元件禁布**；5 mm=SMT 工艺边；3–5 mm=分板应力/装配**推荐值**（细间距/易损/连接器）；0.4 mm=V-CUT 处**裸铜/焊盘**到 V 线的最小铜避让（板厂能力） | 已裁决（按口径） |
| DECOUPLE | `DECOUPLE-001/002`、`PLACE-DECOUPLE-001`、`PLACE-PARASITIC-001` | ≤2 mm 与 100–500 pH 两套判据 | datasheet 给 pH 上限时以 **pH 为主判据**；无 pH 数据时用 ≤2 mm/地过孔 ≤1 mm 作代理；两者都满足才放行 | 已裁决（主/代理） |
| CRYSTAL | `CRYSTAL-001`、`PLACE-CRYSTAL-001`、`PLACE-CRYSTAL-GAP-001` | ≤5–10 mm 与 ≥2.0 mm 看似矛盾 | 目标窗口 **2.0–10 mm**：≥2.0 mm 是晶振本体到芯片时钟引脚的下限（机械/热/寄生电容），≤5–10 mm 是布局上限；负载电容 ≤3 mm 且对称 | 已裁决（区间） |
| ESD | `ESD-001`、`PLACE-ESD-001` | ≤10 mm 与 ≤5–10 mm | 顺序固定为连接器→TVS→IC；距离目标 ≤5 mm、上限 ≤10 mm；结电容按速率另校 | 已裁决（取严） |
| THERMAL | `THERMAL-001`、`PLACE-THERMAL-001` | 散热过孔阵列 vs 热源间距 ≥5 mm | 对象不同，叠加执行；5 mm 只是默认经验，最终以热仿真/实测为准 | 已裁决（不同对象） |
| TESTPOINT | `TESTPOINT-001`、`PLACE-TEST-001` | 2.54 mm 与 1.27 mm 网格 | 默认 2.54 mm；治具明确支持时才用 1.27 mm；两者都不得被高件/结构件遮挡 | 已裁决（治具决定） |
| RF | `RF-001`、`PLACE-RF-001`、`PLACE-ANTENNA-15MM-001` | 模组 keepout 与整机 15 mm | 板级按模组 datasheet；整机外壳内各方向 ≥15 mm 且天线前方无金属；冲突取严，以整机吞吐/距离实测为准 | 已裁决（板级/整机） |
| FIDUCIAL | `FIDUCIAL-001`、`PLACE-PANEL-001` | 1 mm/2 mm 与 3.85 mm | 铜盘 Ø1 mm、开窗 Ø2 mm、周围 ≥1 mm 净空；3.85 mm 是拼板 Mark 中心到拼板边的贴片厂口径，与“板内 Mark 到板边”分开 | 已裁决（两种边） |
| VIA | `VIA-001`、`ANNULAR-001`、`VIA-TENT-001`、`ML-HDI-001`、`ML-BACKDRILL-001` | 普通过孔 vs HDI/背钻 | 先按机械/载流定普通过孔，再按高速/HDI 选微孔/背钻；不得用普通规则否定 HDI 专项规则 | 已裁决（工艺分级） |

## 3. 与项目 128 条规则包的映射原则

`rules/board-layout-rules.json` 是**项目级、可执行**规则（MECH/SPACE/CONN/RF/PWR/SILK/DFM/DFA/GATE），本知识库是**通用原理+默认基线**。映射规则：

1. 项目规则包已有量化值的，知识库条目只解释“为什么”，不覆盖项目值；
2. 项目规则包没有、但知识库有的，按知识库默认值并标注“待项目确认”；
3. 知识库文档引用 `MECH-xx/DFM-xx/SILK-xx/GATE-xx` 时，必须同时给知识库条目 ID，便于双向追溯；
4. 每次项目规则包升级（`python3 scripts/build-rule-json.py`）后，跑一次冲突登记检查。

## 4. 维护动作

- 新增/修改规则前：先查本表与 `conflicts.json`，确认是否落入已有冲突组；
- 新增条目必须在 payload 里写 `scope`（元件/焊盘/铜/工艺边/电气）或至少在 `limits` 里写清对象；
- 发现新冲突：先登记（组、规则、口径、裁决、状态），不要直接改旧 payload；
- 审核（approved）时：同一 `entityKey` 只允许一个“当前有效”版本；冲突组内的规则必须都带 scope 才能批量通过。

## 5. 关联

- [知识库 README](./README.md)
- [K6 审计报告](../implementation/knowledge-audit-k6-2026-10-22.md)
- [项目规则包](../../rules/board-layout-rules.json)
- [K4 布局依据](./pcb/08-component-placement.md)
- [K5 联网核对记录](../implementation/placement-web-verification-k5-2026-10-22.md)
