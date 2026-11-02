# 只读 Supervisor（C 方案 MVP）

日期：2026-11-02
范围：`runtime/supervisor.mjs`、`runtime/server.mjs`、概览页值守队列
结论：**已落地“只读聚合 + 持久工单 + 确定性诊断 + 人工收口”的最小闭环；不新增写板权限，不绕过既有批准链。**

## 1. 为什么是 C 方案

对 Super-agent 的评估结论是：CircuitPilot 的瓶颈不在“多一个会自己干活的 Agent”，而在

1. 已有事实（DRC/ERC 失败、问题中心、待审批计划）散落在不同 Store，需要人主动去找；
2. 缺少“持续巡检 → 持久工单 → 人处理 → 收口”的注意力层；
3. 写板链已经很强（planHash → 人工批准 → 目标指纹/写锁 → 快照 → 读回 → DRC/ERC → 回滚/证据），不能为了“自治”把它绕开。

因此 C 方案只引入 Super-agent 的**注意力/编排模式**，不引入它的执行权限：

- Source：只读现有 Runtime Store；
- Router：确定性过滤，不调用模型；
- Ticket：持久化、可去重、可收口；
- Worker：确定性规则诊断，只给建议，不执行；
- Attention：概览页队列，人决定接单/忽略/解决；
- 写操作：仍然必须回到原有页面，走原有批准链。

## 2. 模块与数据流

```text
validation-state.json ─┐
issue-state.json ──────┼─→ buildSupervisorSignals() ─→ scan() ─→ supervisor-tickets.json
agent-plan-requests ───┘        │                              │
                                │                              └─→ GET /api/supervisor/attention
                                └─→ rule-worker 诊断（确定性）        ↓
                                                              概览页「值守队列」
                                                                  │
                                                      ack / dismiss / resolve（仅 UI）
```

### 2.1 Source 映射

| 源 | 进入队列的条件 | 严重度 | 自动收口条件 |
|---|---|---|---|
| `validation-state` | `source=official`、有 `projectId`、`status=fail/warn` | fail→error，warn→warning | 同项目同名检查出现 `status=pass` |
| `issue-state` | `status=open/investigating` | 继承 issue severity | `status=resolved/ignored` |
| `agent-plan-requests` | `status=pending` | 有 risks→warning，否则 info | `approved/rejected/consumed` |

明确排除：

- demo、种子、人工登记的 validation（必须 `source=official`）；
- 没有 `projectId` 的 validation（避免把别的项目/模板数据算到当前项目）；
- 缺少 `requestId` 的计划请求；
- 读取失败不等于“没有待办”：源 Store 读失败时路由返回 503，不返回空队列。

### 2.2 Ticket 生命周期

```text
open ──ack──→ acknowledged ──resolve──→ done
  │                │
  ├────dismiss─────┴──→ dismissed

done/dismissed ──源 signalKey 变化──→ open（新失败/新问题才重开）
done + 源仍然失败/未解决 ──下一次扫描──→ open（标记解决不能隐藏证据）
```

- `signalKey` 由源状态的关键字段组成；同一信号反复扫描不重复建单、不重复计 occurrence。
- `dismissed` 是显式忽略：同一源信号不复活，直到源状态实质变化。
- `done` 只代表人的判断：下一次扫描若源仍显示 fail/open/pending，会重新打开并写明“源仍显示未通过/未解决”，避免用“已解决”把真实问题藏起来。
- 明确 pass/resolved/approved 才自动收口；源记录暂时消失不自动收口（避免把读失败洗成已解决）。
- 每次 `GET /api/supervisor/attention` 先扫描再返回；另有 30 秒定时扫描（`unref`，不阻止进程退出）。
- 状态文件损坏时 Supervisor 相关路由 503（fail-closed），由日志给出文件路径；不会用空队列伪装“没事”。

### 2.3 Worker 边界

`rule-worker` 是**确定性规则诊断**，不是 LLM Worker：

- 输入：Ticket 的 source/severity/evidence；
- 输出：`verdict` + 最多 10 条检查步骤；
- 不执行 EDA 命令、不签发批准、不修改源 Store；
- UI 只展示建议，不把建议当“已执行”。

后续若接 LLM Worker，应保持同样的只读输入和“输出建议、不直接写”的边界，并单独评审。

## 3. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/supervisor/attention` | 扫描后返回需要人处理的 Ticket（open/acknowledged/blocked）+ 全量摘要 |
| GET | `/api/supervisor/tickets?status=open\|acknowledged\|blocked\|done\|dismissed\|all` | 全量/按状态查询 |
| POST | `/api/supervisor/tickets/:id/ack` | UI 接单；body `{note?}` |
| POST | `/api/supervisor/tickets/:id/dismiss` | UI 忽略；body `{note?}` |
| POST | `/api/supervisor/tickets/:id/resolve` | UI 标记解决；body `{note?}` |

安全口径：

- 三个 POST **只允许本机 UI 会话**；Agent token 调用返回 `403 AGENT_SUPERVISOR_ACTION_FORBIDDEN`。
- Agent 可以读 `/attention`，但不能替人改变处理状态。
- 所有动作只改 `supervisor-tickets.json`，不改 validation/issue/plan 源状态，不写 EDA。
- 不新增审批签发点；计划类 Ticket 只跳转既有计划审批队列。

## 4. 前端接线

- `src/components/SupervisorPanel.tsx`：概览页「值守队列（只读巡检）」。
- 挂载加载 + 30 秒轮询；失败保留上次结果并显示错误码，可重试。
- 操作：接单/忽略/已解决；操作后重新拉取，以 Runtime 返回状态为准。
- 「去处理」只跳到现有页面：validation→验证页、issue→版本与问题、plan→自动化。
- 组件不使用 `AppProvider`，避免把概览页状态耦合进来；可直接单测。
- 明确文案：不写 EDA、不自动执行；标记成功不会让未通过检查自动通过；源仍失败时已解决票据会重新出现。

## 5. 验证记录

### 5.1 真机闭环（2026-11-02，嘉立创EDA Pro 3.2.186）

环境：Runtime `127.0.0.1:4178`、UI `127.0.0.1:4177`、EasyEDA CDP `9222`、easyeda-agent 适配桥 `49620`；工程 `DBTS-A01 双电池无缝切换测试板`，PCB1 `9ab008aa6dfb92c2`，Board1 原理图 `738a71eb6fa3da56`。

实际链路与证据：

1. **官方 DRC 失败**：validation-state 写入 `official-drc-dual-battery-tsb`，`source=official`、`projectId=dual-battery-tsb`、`status=fail`、`count=1`，finding 为 `Netlist Error / Import Changes`。证据 `artifacts/evidence/drc-report/drc-report-2026-11-02T02-38-10-984Z-0e8522c90bd5.json`，digest `0e8522c90bd5a31e2eaa5ab997190a6069fb1523c95f0d32672d39f55facb64c`。
2. **工单生成**：`sup_5a94ae39a178`（validation / error / open，10:38:31）与 `sup_180cfc7c66a8`（issue / error / open，同一 DRC 根因）。
3. **概览页处理**：在概览页对验证工单点「接单」；`acknowledgedAt=2026-11-02T02:42:26.700Z`。截图 `artifacts/supervisor-e2e-2026-11-02/01-ticket-ack.png`。
4. **源修复**：用户明确批准后，走 CircuitPilot 自动化配方 `pcb-sync-from-schematic`（write 批准 + 读回 + 审计链）。主通道 `pcb.importChanges` 只弹出 EDA「确认导入信息」对话框并返回 success，PCB 器件数仍为 99；在 EDA 对话框点「应用修改」并保存 PCB1 后，器件数仍为 99。
   - **重要边界**：该配方的读回断言只比较 `pcb.placement.read` 器件数，本次因此把“弹窗未应用”误判成 `completed`；它不能证明网表已同步。真正是否生效以 EDA 对话框应用 + 后续官方 DRC 为准。后续应把断言改为 netlist/DRC 等价性，不能只比器件数。
5. **重新取证通过**：保存后重跑官方 DRC，报告 `itemCount=0`、`classification.ready=true`；validation-state 的官方 DRC 变为 `status=pass`、`count=0`，证据 `artifacts/evidence/drc-report/drc-report-2026-11-02T02-50-24-507Z-c2820b9e7e21.json`，digest `c2820b9e7e2169783ef3e7dcfeed486c396bea2961bb6ecf15be8011535bdb19`。验证工单在 10:49:30 自动 `done`。
6. **问题自动收口**：`recordOfficialValidation` 检测到同 `checkId` 的旧问题仍 open，自动 `updateIssue(..., 'resolved', ...)`；issue-state 变为 `resolved`，30 秒扫描后问题工单在 10:50:31 自动 `done`。
7. **最终概览**：`/api/supervisor/attention` 返回 total=4、attention=2、done=2；只剩两条与本次 DRC 无关的人工问题工单。截图 `artifacts/supervisor-e2e-2026-11-02/04-overview-after-autoclose.png`。

结论：真实链路已跑通“official DRC 失败 → 持久工单 → 概览接单 → 人工批准源修复 → 重新取证通过 → 验证工单+问题工单自动收口”。Supervisor 本身没有写 EDA、没有签发批准；写操作发生在既有自动化批准链内。

已完成：

- `node --test runtime/__tests__/supervisor.test.mjs`：5/5（信号过滤、去重、动作、源变化重开、明确 pass 收口、持久化、损坏 fail-closed、错误码）。
- `node --test runtime/__tests__/supervisor-http.test.mjs`：2/2（GET 聚合、UI ack、agent 读允许/写 403、非法 status 400、重启读回）。
- `node --test runtime/__tests__/route-contract.test.mjs`：3/3（新增路由均有消费者，孤儿 0）。
- `npx vitest run src/components/__tests__/SupervisorPanel.test.tsx`：6/6（加载渲染、空态、GET 失败错误码+重试、接单 POST+刷新、忽略二次确认、只读文案边界）。
- `npm run typecheck`：通过。
- 全量前端：`npx vitest run` 228/228 通过（29 个文件；含新增的 `validationEvidence` 自动收口单测）。
- 全量 Runtime：`node --test --test-force-exit --test-timeout=120000 "runtime/**/*.test.mjs"` 1455/1455 通过，cancelled 0（含 route-contract；新增路由均有消费者，孤儿 0）。
- `npm run build`：通过（Vite 构建成功；仅保留既有 chunk size 警告）。

待补/未验证：

- 概览页在真实桌面壳（Tauri）中的点击验收；本次是真实浏览器 + 真机 Runtime/EDA，不是桌面壳 E2E；
- 计划审批队列的端到端点击（只读跳转，不自动批准）；
- `pcb-sync-from-schematic` 配方把“弹窗未应用”误判为 completed（见 5.1 第 4 条）；需增加 netlist/DRC 等价读回。

## 6. 明确不做

- 不自动修复、不自动重跑、不自动批准、不自动导出/下单；
- 不新增写 EDA 的 Worker；
- 不把 Ticket 状态当设计证据；真实放行仍以 official 验证/门禁证据为准；
- 不引入官方 Super-agent 代码（协议/依赖/权限模型不匹配），只借鉴 Source→Trigger→Ticket→Attention 模式；
- 不做跨项目聚合：validation 无 `projectId` 不进入队列，避免把模板/别的项目数据算到当前项目；
- 不提供跨进程互斥：`supervisor-tickets.json` 与其它状态 Store 一样，假设单个 Runtime 持有写权；多 Runtime 共享 stateDir 不是本增量支持的部署方式。

## 7. 后续可做的增量（有证据再做）

1. ~~用真实失败样本做一次 ticket 生成→UI 处理→源修复→自动收口的真机闭环~~（2026-11-02 已完成，见 5.1）；
2. 给计划类 ticket 增加 dueAt 过期提示（只提示，不自动批准）；
3. 若接 LLM Worker，先做只读 A/B：同一 Ticket 下规则诊断 vs 模型建议的可解释性/误报率，不达标不替换；
4. 评估是否需要把“值守队列”提升为独立页；当前先放概览，避免导航膨胀。

## 8. 关键文件

- `runtime/supervisor.mjs`：信号、Ticket、Store、动作、摘要。
- `runtime/server.mjs`：`/api/supervisor/*` 路由、30 秒只读扫描、fail-closed 降级。
- `src/components/SupervisorPanel.tsx`：概览页只读队列。
- `src/services/runtimeClient.ts`：四个客户端方法。
- `src/services/validationEvidence.ts`：`autoResolvableOfficialIssueIds()`——官方检查通过后，只收口同 `checkId`/同项目的旧问题。
- `src/types.ts`：Ticket/Summary/View 类型。
- `runtime/__tests__/supervisor.test.mjs`、`runtime/__tests__/supervisor-http.test.mjs`。
