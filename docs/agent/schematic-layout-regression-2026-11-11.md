# 原理图重叠/图框越界：根因与修复（2026-11-11）

> 用户反馈：之前保存的"原理图设计经验/设计规则"像是没有了；现在画原理图仍出现元件重叠、
> 元件不在图纸框内、压到模板图框，原理图看不清。要求全面检查，并确认是否知识库 Agent 没沉淀经验。

## 0. 结论（先说清楚）

1. **规则没有"丢失"**：本机知识库现有 **392 条候选知识**（failure 91 / module 100 / part 60 / rule 141），
   但**全部是 `review.state="candidate"`，approved=0**。它们从未成为"已批准规则"，规划/门禁不会把它们当权威，
   所以体感上像"没有了"。
2. **知识 Agent 确实停了**：`knowledge-agent.json` 最后一次运行是 **2026-10-29T02:16:51Z**，
   `nextRunAt=2026-10-30`，之后没有新一轮；原因见 §2。它也只产出 candidate，审批仍是人工。
3. **更直接的原因在代码**：原理图可读性布局模块 `runtime/schematic-layout.mjs` 早就存在，但只接在
   `reviewed-netlist` 编译链路（`netlist.mjs`）；**实际"候选提案 → 画原理图"的主路径
   `proposal.mjs#selectProposalToPlan` 仍用固定栅格 `x=600+700n / y=600+700n`**，既没有图框约束、
   也没有重叠审计，`normalizePlan` 只做结构校验。A4 图框只有 **1170×825**，这个栅格必然把器件摆到
   图框外/模板上，多个器件也会叠在一起。
4. **已修复**（见 §3）：proposal 路径改用图框内确定性布局；`normalizePlan` 对越界/重叠计划直接
   `ready=false`；布局审计新增图框/标题栏 error；知识 Agent 改为**联网关闭也本地跑 badcase 采集+维护**。

## 1. 检查证据

### 1.1 知识库现状（本机 live state）

路径：`~/Library/Application Support/com.circuitpilot.desktop/state/knowledge/`

| kind | 条数 | review.state |
|---|---|---|
| failure | 91 | candidate |
| module | 100 | candidate |
| part | 60 | candidate |
| rule | 141 | candidate |

- `state/knowledge-agent.json`：`lastRunAt=2026-10-29T02:16:51.548Z`、`nextRunAt=2026-10-30T02:16:51.549Z`、
  `lastResult.badcases.created=0`、`lastResult.maintenance.pendingReview=392`。
- 141 条 rule 里包含布局/热/工艺等规则（示例 `PCB-RULE-PLACE-THERMAL-001`），但都是 candidate。

### 1.2 为什么 Agent 停了

`runtime/server.mjs` 的启动调度条件（修复前）：

```js
const shouldRun = knowledgeAgentEnv === 'on' || (config?.enabled === true && knowledgeWebEnabled);
```

- `research-config.json` 默认 `enabled:false`（本机无该文件）；
- `knowledgeWebEnabled = process.env.CIRCUITPILOT_KNOWLEDGE_WEB !== 'off'`；
- 结果：除非显式 `CIRCUITPILOT_KNOWLEDGE_AGENT=on`，**维护调度根本不会启动**——
  但 badcase 采集/维护本来不需要联网，笔记/复盘经验因此停更。

### 1.3 真实页面审计（只读，当前 EDA 页面）

用 `schematic.components` 读当前页（P1-功率通路）45 个图元（16 个器件 + 16 个网络端口 + 13 个电源/地标识），
按新图框 `A4 1170×825 / 边距 30 / 右下标题栏 240×130` 审计：

- 器件重叠：**15 处**（估算，最大 2250 单位²；例：U6 与 L1/D2/D3/C_3V3/C_5V 等）；
- 图框越界：**1 处**（U7 的估计框 y 达到 810，超过可用下边 795）；
- 压标题栏：0（当前采样）；网络端口/标签不在本次器件审计范围。
- 证据：`artifacts/schematic-layout-audit-2026-11-11.json`。

> 这正是用户看到的现象：模板图框/标题栏被器件压住、器件互相叠。
> 注意：符号尺寸是按类别/引脚数估计（真实符号包围盒未逐个读），所以是"风险证据"，不是最终 DRC。

## 2. 根因链

```
KMA 调度被"联网检索开关"连带关掉 → 没有新候选/维护
        +
候选知识从未审批（approved=0） → 规则不会成为门禁/规划依据
        +
"候选提案 → 画图"主路径用固定栅格、不做图框/重叠校验 → 直接产生重叠/越界
        +
计划归一化只做结构校验 → 坏坐标能通过 approve/execute
```

## 3. 修复内容（本次已落地）

### 3.1 图框常量与确定性装箱（`runtime/schematic-layout.mjs`）

- 新增 `SCHEMATIC_SHEET_FRAME`：A4 `1170×825`、margin 30、右下标题栏 `240×130`
  （来源：真机 `schematic.catalog.titleBlockData` 的 Page Size/Width/Height/Title Block Position）。
- `layoutSchematicComponents` 改为**按图纸可用区域装箱**：先按簇排局部坐标，再列优先放入图框；
  元件框不重叠、不越界、不压标题栏；放不下报 `SHEET_CAPACITY_EXCEEDED`（error）。
- 新增错误码：`COMPONENT_OUTSIDE_FRAME` / `COMPONENT_ON_TITLE_BLOCK`（error），
  `auditSchematicReadability` 也支持 `options.frame` 并报 error（不只是 warning）。

### 3.2 提案主路径改用布局（`runtime/proposal.mjs`）

- `selectProposalToPlan` 不再用 `x=600+700n`，改为把勾选项×数量交给 `layoutSchematicComponents`
  （ref 仅用于尺寸估计，不写 EDA；EDA 分配真实位号），操作坐标全部来自图框内布局。
- 布局 error 直接进 `planning.missing` → `planning.ready=false`，不会带着重叠/越界落图。

### 3.3 计划归一化 fail-closed（`runtime/design.mjs`）

- `normalizePlan`（reviewed-netlist / simple-control-board 两条）新增布局校验：
  任何 `component.create` 的 x/y 越出 A4 可用区域、或与其它器件重叠 → `layout:*` 进 `missing`，
  `ready=false`；坏计划进不了批准/执行。
- 兼容说明：component.create 的 x/y 语义（中心/左上）未逐版本验证，图框检查采用保守点+尺寸边界；
  重叠检查用无源件基准框，避免把大 IC 估得过大误杀。

### 3.4 知识 Agent 改为本地维护可独立运行（`runtime/knowledge-scheduler.mjs` + `server.mjs`）

- 调度器支持 `tasks` 配置；server 在联网关闭时传 `['badcases','maintain']`，
  **只跑本地采集/维护，不联网**；`web` 任务只在 `knowledgeWebEnabled` 时加入。
- 启动条件改为 `CIRCUITPILOT_KNOWLEDGE_AGENT !== 'off'`（默认运行），不再被 research-config 连带关闭。
- 仍是**只产 candidate**，不会绕过人工审核；但"经验不再停止沉淀"。
- 真机验证（2026-11-11 17:00）：重启安装版 App 后 KMA 自动运行，`lastRunAt=2026-11-11T09:00:07Z`、
  `nextRunAt=2026-11-12T09:00:07Z`，`pendingReview=392`、badcases 本轮 0；证据
  `artifacts/knowledge-agent-recovery-2026-11-11.json`。

## 4. 验证

| 检查 | 结果 |
|---|---|
| `runtime/__tests__/schematic-layout.test.mjs`（含新增图框测试） | ✔ 图框内/不压标题栏/审计 error |
| `runtime/__tests__/proposal.test.mjs` | ✔ 9/9；落点在 A4 内、5 颗不同位置 |
| `runtime/__tests__/design.test.mjs` | ✔ 17/17；越界计划 ready=false |
| `runtime/__tests__/knowledge-scheduler.test.mjs` | ✔ 含"联网关闭仍跑 badcases+maintain" |
| `npm run test:runtime` | **1585/1585 pass** |

## 5. 还没做（需要你决定/审批）

1. **已存在的重叠/越界页面没有自动改**：修复只保证"新画的图"不再产生；现有页面重排是写操作，
   需要你明确批准修复计划（`plan → cp_approve → cp_execute`）或人工调整。
2. **知识规则仍是 candidate**：需要人工审核批准（141 条 rule），才会进入门禁/规划依据。
   KMA 现在会继续沉淀候选，但不会自动批准。
3. **符号尺寸仍是估计**：真实符号包围盒未逐个读；如果有 `component.width/height` 会优先使用，
   否则按类别/引脚数保守估计。
4. 图框只覆盖 A4 默认模板；若换纸张/模板，需把 `SCHEMATIC_SHEET_FRAME` 或 `options.frame` 配成实际值。

## 6. 复现

```bash
cd "/Users/jescochen/Desktop/AI- PCBA"

# 图框/审计单测
node --test --test-timeout=120000 \
  runtime/__tests__/schematic-layout.test.mjs \
  runtime/__tests__/proposal.test.mjs \
  runtime/__tests__/design.test.mjs \
  runtime/__tests__/knowledge-scheduler.test.mjs

# 全量
npm run test:runtime

# 真实页面只读审计（需 EDA 在线，当前页）
# 1) easyeda --skip-version-check doc switch <schematic page uuid> --project "<project>"
# 2) 调 Runtime POST /api/eda/commands/schematic.components
# 3) 用 auditSchematicReadability({components,pinsByComponent,options:{frame:SCHEMATIC_SHEET_FRAME}})
```

## 7. 安装版（当前运行的操作系统 App）验证（2026-11-11 17:10）

用户要求把修复更新到"正在运行的操作系统 App"，并提交 GitHub。实际核查/验证：

- `/Applications/CircuitPilot.app`（0.2.0）运行中；其 runtime 的
  `schematic-layout.mjs / proposal.mjs / design.mjs / knowledge-scheduler.mjs / server.mjs`
  与工作区修复**逐字节一致**（sha256 前 16 位相同）。
- 通过运行中的 Runtime API（127.0.0.1:4178）实测：
  - `POST /api/library/proposals/plan` → `ready=true`，落点 `(70,60)`、`(70,170)`，在 A4 图框内；
  - `POST /api/design/plan` 传越界器件（x=3000）→ `ready=false`，
    `missing=["layout:SCHEMATIC_LAYOUT_COMPONENT_OUTSIDE_FRAME:R1"]`（坏计划被拒绝）；
  - 合法计划 → `ready=true`。
- KMA：`lastRunAt=2026-11-11T09:00:07Z`、`nextRunAt=2026-11-12T09:00:07Z`、pendingReview=392；
  EDA bridge 自动托管在线（adapter 49620）。
- 证据：`artifacts/installed-app-schematic-layout-verification-2026-11-11.json`。

> 结论：当前 App 画**新原理图**时走图框内布局；越界/重叠计划在 approve/execute 前被 fail-closed。
> 当前页面已有的历史重叠/越界仍需单独修复（写操作，必须你批准）。

## 8. 当前 P5-控制CAN 页面复核与"画线出框"补洞（2026-11-11 17:20）

用户截图显示：A4 图框可见，但 MCU/网络标签/走线大量落在图框外（红框标出）。对当前文档
`P5-控制CAN`（uuid `66ce5e62ba7100ad`）做只读读回审计：

| 检查 | 结果 |
|---|---|
| 器件 | 9 个；**8 个越出 A4 可用区域**（如 MCU1 y=880 > 795） |
| 器件重叠 | 2 处（估算） |
| 标签压元件 | 15 处 |
| 标签互叠 | 22 处 |
| 走线端点 | `schematic.wires` 54 条 / 108 端点，**98 个端点在图框外**（如 y=1015/995） |

证据：`artifacts/schematic-wire-frame-audit-2026-11-11.json`。

**为什么修复后仍看到这张图？**
- 该页面是在修复/门禁之前由 AI 坐标计划生成的（`/api/design/plan/ai` 的 candidate 直接给 x/y）；
- 修复前只校验 `component.create` 的图框/重叠，**没有校验 `wire.create` 端点与 `netFlag.create` 标签**，
  所以即使元件被拦住，走线/标签仍能出框；
- 已存在的页面不会自动被改（写操作需批准）。

**本轮补洞（已实现）**：
1. `normalizePlan` 现在对 `wire.create` 每个点、`netFlag/netPort.create` 的 x/y 做图框校验，
   并检查标签压元件/标签互叠；越界计划 `ready=false`（`WIRE_OUTSIDE_FRAME` / `LABEL_OUTSIDE_FRAME` /
   `LABEL_ON_COMPONENT` / `LABEL_LABEL_OVERLAP`）。
2. AI 计划提示增加 A4 约束：可用 x∈[30,1140]、y∈[30,795]，禁止出框/堆叠；
3. 已重新打包安装版 App，使运行中的 Runtime 加载新门禁。运行态实测：越界计划返回
   `layout:WIRE_OUTSIDE_FRAME:wire1-0` / `layout:LABEL_OUTSIDE_FRAME:netFlag.create2`（ready=false），
   合法计划 ready=true；证据 `artifacts/installed-app-wire-label-gate-2026-11-11.json`。

> 现有 P5 页面仍需要单独修复：可手动整理，或改用"候选提案/已审核网表"的布局优先链路重画；
> 全选移动/缩放 54 条走线不是安全的自动写操作，需要人工确认。

## 9. 规则硬约束升级（2026-11-11 17:35）

用户要求"一定要把规则作为约束"——不只提示/审核，而是**写入前拒绝 + 写入后回读门禁 + 回滚**：

1. **计划门禁（写前）**：`normalizePlan` 已对 `component.create` / `wire.create` / `netFlag/netPort`
   做图框/重叠/标签检查；`ready=false` 不可批准。
2. **执行期回读门禁（写后、保存后、DRC 前）**：`DesignManager.execute` 在写入前后各读回一次
   器件/标签/走线，计算可读性审计；**只阻断本次新增的硬违规**（既有问题不误伤，便于逐步修复），
   命中即抛 `SCHEMATIC_READABILITY_BLOCKING`，走既有 `document.source.restore` 回滚并保存。
   硬违规覆盖：
   - `COMPONENT_OUTSIDE_FRAME` / `COMPONENT_ON_TITLE_BLOCK` / `COMPONENT_OVERLAP`
   - `LABEL_ON_COMPONENT` / `LABEL_LABEL_OVERLAP`
   - `WIRE_OUTSIDE_FRAME`（走线端点出图框）
3. **禁止绕过**：
   - `POST /api/eda/commands/schematic.component.create|wire.create|netFlag.create|pin.noConnect|component.delete|designator.set`
     直接返回 409 `SCHEMATIC_WRITE_REQUIRES_APPROVED_EXECUTION`（结构写必须走 `design.execute` 的批准链）；
   - `POST /api/eda/schematic/component-batch` 写入前检查每个落件坐标在 A4 图框内，越界 400。
4. **测试**：`design.test.mjs` 20/20（含可读性 diff 只拦新增）；runtime **1588/1588**；
   安装版 App 重新打包并运行态验证计划门禁/直写拦截。

> 边界：EasyEDA 内**人工拖拽**不受我们代码约束；我们的约束覆盖"Dsh/插件/AI 通过 Runtime 的写入"。
> 当前 P5 页面是历史遗留，仍需人工整理或走批准修复；新的写入若产生新增违规会被拒绝并回滚。

