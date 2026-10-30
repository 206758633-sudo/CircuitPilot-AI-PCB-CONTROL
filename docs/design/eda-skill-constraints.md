# easyeda-agent Skill 的 PCB 约束能否用于 CircuitPilot

- 对象：`zhoushoujianwork/easyeda-agent` 的 Skill（`.agents/skills/easyeda-agent/SKILL.md`，metadata.version **1.14.0**，MIT）
- 参照文档：`references/pcb-layout.md`（73KB）、`pcb-routing.md`（49KB）、`pcb-config.md`、`pcb.md`、`design-flow.md`、`actions.md`
- 结论：**可以利用，但只能利用“约束知识与判定语义”，不能利用它的“执行机制与验证结论”。**

---

## 1. 三类约束，三种处理方式

| 类别 | 例子（来自 skill） | 能否用于 CircuitPilot |
| --- | --- | --- |
| **A. 可判定的设计约束** | clearance/track/via 规则矩阵、net-class 绑定、双层 no-pours/keepout、天线禁布、晶振区禁铺、silk-over-pad / off-board、zone 九宫格、差分对/等长组、layout-lint 的 access channel（默认 60mil） | ✅ 可摘录为 rule pack / 检查器 |
| **B. 工作流不变量（方法论）** | `saved:true` 必须是布尔；save → reload → fresh readback；两轮自检（第二轮含保存重载）；`unknown ≠ 空/NC`；stale read 先回读；DRC `passed:false` 即失败；禁止 GUI 兜底、禁止手改队列/SVG | ✅ 可固化为流程门/证据契约 |
| **C. 与 CLI/daemon 绑定的机制** | typed action 名称、`easyeda` CLI 参数、端口 60832-60841、connector v4、`--doc` pinning、GUI 对话框自动点“应用修改”、`live-verified` 结论 | ❌ 不可直接搬；只作参考实现 |

**关键区分**：skill 里的数字有两类——**规则语义**（可迁移）和**具体样例值**（不可迁移）。例如 260919 考题的 6mil track-to-track、8/20mil 线宽、24/12mil 过孔，skill 自己就写了“不是其他题目的通用默认值”。

---

## 2. 映射到 CircuitPilot 现状

CircuitPilot 已有一套相当完整的约束/门禁体系，skill 的价值主要是**补缺口**而不是从零建：

| skill 约束 | CircuitPilot 现有落点 | 状态 |
| --- | --- | --- |
| 128 条布局/DFM/DFA/丝印/间距规则 | `runtime/engineering/layout-rules.mjs` + `rules/board-layout-rules.json`（MECH/CONN/DFA/DFM/GATE/PWR/RF/SILK/SPACE 共 128 条；PASS/FAIL/REVIEW/NA，REVIEW≠PASS） | ✅ 已覆盖，可做逐条 diff |
| `unknown` 不得当作空/NC | `runtime/constraints.mjs`：拿不到事实 → `CONSTRAINT_FACT_UNKNOWN`，fail-closed | ✅ 同构，已覆盖 |
| `saved:true` 才算保存成功 | `runtime/design.mjs:304`、`net-connect.mjs`、`pcb.mjs` 等 | ✅ 已覆盖 |
| DRC `passed:false` 即失败 | `runtime/engineering/routing-drc.mjs`、`pcb.drc` 桥命令、`release-gate.mjs` | ✅ 已覆盖 |
| 电气规则/叠层/阻抗/高速/RF | `runtime/engineering/{impedance,highspeed,hdi,rf,stackup}.mjs` | ✅ 已覆盖 |
| 丝印压焊盘/越板边/重叠/镜像 | 规则包 16 条 SILK + `layout-rules` 的 silk 检查；新增 SKL-09（反显/顶层镜像/位号跨面，底层 mirror 不判） | ✅ 只读覆盖 |
| 双层 no-pours / keepout / 晶振区禁铺 | SKL-05/06 + 新增 `pcb.regions.detail`、`pcb.pours.detail.boundsMm` | ✅ 只读判定，仍无写 |
| zone 九宫格与 zone-violation | SKL-01（claim 完整性）、SKL-02（九宫格违规） | ✅ 只读判定 |
| layout-lint（access channel、手焊 profile、no-access） | SKL-03（60mil 手焊通道）、SKL-04（NO_COMPONENTS 禁布区） | ✅ 只读判定 |
| 两轮自检 + artifact SHA256 + 保存重载 | SKL-07 + `pcb.save`/`pcb.reload`（reload 待真机验证） | ✅ 契约已落 |
| 差分对/等长组先声明后测量 | SKL-08（declaredBeforeRouting + skew/spread） | ✅ 只读判定 |
| net-class 绑定一致性 | SKL-10 + `pcb.rules.detail`；写回仍无命令 | ✅ 只读审计，写回仍不可执行 |
| stale read / doc pinning | `pcb.mjs`、`release-gate.mjs` 有 stale 相关处理，但无 CLI 式 pinning | ⚠️ 部分 |
| 禁止 GUI 兜底 / 手改队列 | 已有“证据可追溯、不可改写”纪律 | ✅ 同构 |

> 桥命令现状（`runtime/bridge.mjs`，80 条）：PCB 侧可读 layers/nets/components/rules/regions/pads/copper，可写 component/placement/line/via/pour/outline，但**没有** config、net-class、silk、keepout/region 写命令。这意味着 C 类里“规则配置写入”这半边在 CircuitPilot 里暂时无法照做。

---

## 3. 建议的利用方式（可执行）

1. **摘录成离线 rule pack，而不是运行时读 GitHub**
   新增 `runtime/engineering/rules/eda-skill-constraints.json`，每条：
   ```json
   {
     "id": "SKILL-PCB-001",
     "source": { "repo": "zhoushoujianwork/easyeda-agent", "skillVersion": "1.14.0",
                 "path": "references/pcb-layout.md#布局检查", "license": "MIT" },
     "severity": "FAIL|REVIEW",
     "appliesTo": ["pcb-layout"],
     "check": "computed|manual",
     "evidenceKind": "layout-facts",
     "gate": "advisory|blocking"
   }
   ```
   锁版本 + 记录来源锚点，避免 skill 升级后规则悄悄漂移。

2. **先做映射审计，只补缺口**
   把 `pcb-layout.md` / `pcb-routing.md` / `pcb-config.md` 里可判定项与现有 128 条规则逐条 diff，目标 15–25 条，优先：
   - zone claim / zone-violation（九宫格）
   - layout-lint（access channel、手焊 profile、no-access）
   - 两轮自检 artifact 契约（dump/render + SHA256 + findings + fixesApplied）
   - keepout/no-pours 双层语义与晶振区禁铺
   - 差分对/等长组的“先声明后测量”
   - 丝印覆盖补全（压焊盘、板边、重叠、镜像）

3. **新检查器先 advisory，不进阻断门**
   `skill-constraints.mjs` 只读输出 PASS/FAIL/REVIEW/NA + 证据；先挂到 gate 前作 advisory，观察误报率，再决定是否升 blocking。避免一上来把存量工程全判 fail。

4. **把“方法论语义”写进证据契约，而不是写进代码注释**
   - `unknown` 一律 fail-closed（已有）；
   - 保存必须 `saved:true` 布尔（已有）；
   - 布局完成声明必须附两轮自检 artifact（新增）；
   - 未覆盖范围必须显式列出（新增 `coverage` 字段）。

5. **回归夹具用 skill 的样例，但标注“样例值非通用默认”**
   260919 考题配置（6mil clearance、8/20mil 线宽、24/12mil 过孔、PWR 类）很适合做 golden case，但必须与“通用默认值”分开存放。

---

## 4. 风险与边界

- **许可**：MIT，可复用，保留版权与来源即可；但文档里的“经验结论”仍需自己验证。
- **版本漂移**：skill 是活文档（1.14.0），规则随 CLI/EDA 版本变化；必须锁版本 + 来源哈希。
- **过拟合**：考题/样例数值不可当通用规则；skill 自己也强调“不是其他题目的通用默认值”。
- **证据语义**：不能把 skill 的 `live-verified` 当 CircuitPilot 的 `pass`；后者必须现场取证、带 digest、可回滚。
- **能力边界**：CircuitPilot 桥没有 config/silk/keepout 写命令，C 类里的“写入+回读”暂时只能做只读检查或提示人工在 EDA 里完成。

---

## 5. 一句话结论

**能利用的是“规则清单 + 判定语义 + 工作流不变量”，不能利用的是“命令 + 端口 + 已验证结论”。**
建议按“离线摘录 rule pack → 映射审计 → 只补 15–25 条缺口 → advisory 检查 → 再升门”的顺序做，预计 2–3 人日可出第一版映射，1–2 周可把 zone/layout-lint/两轮自检这三块补进现有 128 条规则体系。

---

## 8. 实现状态（2026-10-23 第二批已落地）

第一批（FAB/NET）之后，本文件第 2 节列的 6 类缺口已全部落成**只读审计规则**；同时按用户批准，扩了 3 条只读桥命令 + 1 条 reload 命令。

### 8.1 规则：`runtime/engineering/skill-rules.mjs`（SKL-01..10）

| 编号 | 规则 | 级别 | 对应 skill 语义 |
| --- | --- | --- | --- |
| SKL-01 | 功能分区 claim 完整性 | 推荐 | `pcb zones` 的 claim 表 |
| SKL-02 | zone 九宫格违规 | 硬门禁 | left/center/right × top/bottom 词表与分区矩形 |
| SKL-03 | layout-lint 手焊通道 | 推荐 | 手焊件四侧至少一侧有 60mil 净通道 |
| SKL-04 | layout-lint 禁布区（no-access） | 硬门禁 | `NO_COMPONENTS` 区域不得压器件 |
| SKL-05 | keepout / no-pours 双层 | 硬门禁 | NO_POURS 必须多层（MULTI=12），区内不得有覆铜 |
| SKL-06 | 晶振区禁铺 | 硬门禁 | 晶振（Y*/X* 或显式清单）必须被禁铺区完整覆盖 |
| SKL-07 | 两轮自检 artifact 契约 | 硬门禁 | 两轮 dump/render+readback SHA256、fixesApplied、save→reload |
| SKL-08 | 差分对/等长先声明后测量 | 硬门禁 | declaredBeforeRouting + skew/spread 容差 |
| SKL-09 | 丝印镜像/反显 | 推荐 | reverse 禁止、顶层 mirror 禁止、位号不得跨面、位号旋转应为 0° |
| SKL-10 | net-class 一致性 | 硬门禁 | 实测线宽 vs class 声明（默认 ±5%/0.02mm） |

语义与其它规则包一致：`PASS / FAIL / REVIEW / NA`，**REVIEW ≠ PASS**；`passed` 只表示无硬门禁 FAIL，`releaseReady` 要求 REVIEW 为 0。丝印规则刻意**不判底层 mirror**（skill 明确该平台语义未验证）。

### 8.2 桥扩展（`runtime/bridge.mjs`）

| 命令 | 权限 | 用途 |
| --- | --- | --- |
| `pcb.regions.detail` | read | 区域 ID/层/规则类型（2/5/6/7/8/9）/名称/线宽/包围盒/polygon source；`MULTI=12` |
| `pcb.texts.detail` | read（已扩展） | 文字 ID/层/文本/mirror/reverse/rotation/fontSize/线宽/位置/`boundsMm`，供丝印镜像、丝印-焊盘/板边检查 |
| `pcb.rules.detail` | read | 当前规则配置完整对象（原 `pcb.rules.read` 只回 name+keys） |
| `pcb.reload` | write（document-lifecycle） | 保存后关标签→按 UUID 重开→激活；必须显式传 `saved:true`（否则拒绝执行，防丢未保存修改） |
| `pcb.pours.detail` | read（已扩展） | 增加 `boundsMm`，供禁铺区/晶振区与覆铜重叠判定 |
| `pcb.region.create/delete` | write-beta | **仅测试辅助**：创建/删除临时区域，用于真机验证 `regions.detail` 非空字段，验证后立即删除 |
| `pcb.text.create/delete` | write-beta | **仅测试辅助**：创建/删除临时丝印文字；`alignMode` 必须用合法枚举（默认 5=CENTER），否则 EDA 返回“参数不正确” |

> 真机联调（2026-10-23，衣橱助手 PCB，docType=3）：
> - `pcb.regions.detail` / `pcb.texts.detail` 先用空板验证包装；**再用 `region.create`/`text.create` 造临时对象验证非空字段**：
>   - region：`layer=12`、`rules=[2,7]`、bounds/polygon 正确；`regionName` 读回为 `null`（该 EDA 版本不暴露），`lineWidth` 是原值（0.2，不能当 mil 用）；
>   - text：`layer/mirror/reverse/rotation/fontSizeMil=40/lineWidthMil=6/xMm/yMm` 全部与创建参数一致。
> - `pcb.rules.detail` 真机返回完整规则配置（`config` + `name`）；
> - `pcb.pours.detail` 真机返回 4 块覆铜及 `boundsMm`；
> - `pcb.reload` 真机 `save→reload` 后同一 tab 重开、`documentType=3`、47 个器件的排序读回一致，未丢数据。
> - 结论：SKL-04/05/09 的非空字段路径已在真机跑通；`regionName` 和 region `lineWidth` 的单位语义仍不可靠，规则不依赖这两个字段。

### 8.3 只读 API

```text
GET  /api/engineering/constraint-rules
POST /api/engineering/constraint-rules/audit           # {fixtureId} 或 {input}
POST /api/engineering/constraint-rules/bridge-audit    # {design?, includeCopper?}：自动从桥采集当前 PCB
```

fixtures：`SKILL-PASS`（10/10 PASS）、`SKILL-FAIL`（9 FAIL + 1 REVIEW）、`SKILL-REVIEW`（10 REVIEW）。

`bridge-audit` 自动执行 `pcb.placement.read`、`pcb.regions.detail`、`pcb.texts.detail`、`pcb.pours.detail`、`pcb.outline.read`；只有传了 `design.netClasses+netClassMap` 或 `includeCopper:true` 才额外读 `pcb.copper.read`。当前文档不是 PCB（`documentType ≠ 3`）返回 409 `NOT_A_PCB_DOCUMENT`。

命令行等价入口：

```bash
node scripts/bridge-skill-audit.mjs --design design-intent.json \
  --out artifacts/pcb-constraints/skill-audit-live.json
# 当前若停在 3D/原理图页：--open-uuid <pcbUuid>
```

### 8.4 验证

- `runtime/__tests__/skill-rules.test.mjs`：9 个测试（规则清单/合规/缺陷/缺数据/两轮边界/确定性/桥命令/假 EDA 执行/HTTP）
- `runtime/__tests__/skill-input.test.mjs`：6 个测试（placement/outline/copper/regions/pours/texts 适配、buildSkillInput、HTTP 桥接审计、非 PCB 409）
- 与 fab-net、bridge、engineering、route-contract 合跑：**77/77 通过**
- `npm run typecheck`：通过

### 8.5 仍未完成

- 46 条 REVIEW 占位（SILK-06/07/09/10/11/16、DFA-01/02/03、DFM-02/03/04/05、PWR-02/03/04 等）逐步接数据源；
- `ADR_*` 规则生成预览；
- net-class / keepout / silk 的**自动写回**（桥仍无写命令，只读审计不阻塞）。

### 8.6 真机桥接结果（2026-10-23）

在运行中的 EDA（衣橱助手 PCB，47 器件，56.065×61.843mm）上完成：

| 项 | 结果 |
| --- | --- |
| 空板只读 | `regions.detail`/`texts.detail` 返回空集合；`rules.detail` 返回完整规则；`pours.detail` 返回 4 块覆铜 + bounds |
| region 非空 | 临时创建 `layer=12, rules=[2,7]`：detail 正确回读层/规则/bounds/polygon；`regionName=null`、`lineWidth=0.2`（原值，不换算） |
| text 非空 | 临时创建 top silk：`layer=3/mirror/reverse/rotation/fontSizeMil=40/lineWidthMil=6/xMm/yMm` 全部回读正确 |
| 规则实测 | 造一个压 8 个器件的 `NO_COMPONENTS` 区域 → **SKL-04 FAIL**（C1/C4/C8…）；造顶层 `mirror=true` 文字 → **SKL-09 FAIL**；合法 MULTI 层 NO_POURS → **SKL-05 PASS** |
| save→reload | `closed:true, reopened/activated:true`，同一 tab、docType=3；重载后 47 器件按位号排序读回一致 |
| CLI/HTTP | 两次 CLI auditHash 相同；HTTP `bridge-audit` 对真桥 200 且哈希与 CLI 一致 |
| 当前板审计 | PASS 0 / FAIL 0 / REVIEW 6 / NA 4（缺 zones/assembly/selfCheck/diffPairs/netClasses 意图数据；不是产品 PASS） |
| 证据 | `skill-audit-live.json`、`skill-audit-live-nonempty.json`（2 PASS）、`skill-audit-live-nonempty-fail.json`（SKL-04+SKL-09 FAIL） |

> 临时 region/text 已全部删除；随后 `pcb.reload(saved:true)` 丢弃未保存变更，回到保存态：regions/texts 归零、47 器件不变。真机尾巴已关闭。
> 仅剩：`regionName` 与 region `lineWidth` 是不可靠字段，规则刻意不依赖。
