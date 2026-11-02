# Supervisor 真机闭环（2026-11-02）

## 结论

真实链路已跑通：

`official DRC 失败 → 持久工单 → 概览页接单 → 人工批准源修复 → 重新取证通过 → 验证工单 + 问题工单自动收口`

Supervisor 本身没有写 EDA、没有签发批准；写操作发生在既有自动化批准链内。

## 环境

- Runtime：`127.0.0.1:4178`
- UI：`127.0.0.1:4177`
- EasyEDA Pro 3.2.186：CDP `9222`
- easyeda-agent 适配桥：`127.0.0.1:49620`，`edaConnected=true`
- 工程：`DBTS-A01 双电池无缝切换测试板`
- PCB1：`9ab008aa6dfb92c2`
- Board1 原理图：`738a71eb6fa3da56`

## 时间线

| 时间（Asia/Shanghai） | 事件 | 证据 |
|---|---|---|
| 10:38:10 | 官方 DRC 失败：1 条 Netlist Error（Import Changes） | `artifacts/evidence/drc-report/drc-report-2026-11-02T02-38-10-984Z-0e8522c90bd5.json` / digest `0e8522c90bd5a31e2eaa5ab997190a6069fb1523c95f0d32672d39f55facb64c` |
| 10:38:31 | 生成验证工单 `sup_5a94ae39a178` 与同根因问题工单 `sup_180cfc7c66a8` | `/api/supervisor/attention` |
| 10:42:26 | 概览页点「接单」，验证工单 `acknowledged` | `01-ticket-ack.png` |
| 10:46:46 | 又一次 DRC 失败取证（应用导入前） | `drc-report-2026-11-02T02-46-46-129Z-f9e2cd9144f4.json` |
| 10:47 左右 | 用户明确批准后执行 `pcb-sync-from-schematic`；EDA 弹「确认导入信息」，手动点「应用修改」并保存 PCB1 | 审计 `run-mvynqoyh-dyx47m.jsonl` |
| 10:49:01 | 重跑 DRC：`itemCount=0`、`ready=true`，官方记录 `pass` | `drc-report-2026-11-02T02-49-01-684Z-065aa0d6fc48.json` |
| 10:49:30 | 验证工单自动 `done`（`note: 官方 DRC 已通过`） | `supervisor-tickets.json` |
| 10:50:24 | 再次重跑 DRC 通过；同一 `checkId` 旧问题自动 `resolved` | `drc-report-2026-11-02T02-50-24-507Z-c2820b9e7e21.json` / digest `c2820b9e7e2169783ef3e7dcfeed486c396bea2961bb6ecf15be8011535bdb19` |
| 10:50:31 | 问题工单自动 `done` | `supervisor-tickets.json` |
| 10:51:09 | 最终 attention：total=4、attention=2、done=2 | `04-overview-after-autoclose.png` |

## 关键事实

- 初始失败是真实 EDA 原生 DRC：`Netlist Error / Import Changes`，不是 Demo。
- 验证工单只在 `source=official` + `projectId` + fail/warn 时生成；本次项目域记录满足条件。
- 概览页「接单」走 UI 会话，Agent 不能改工单状态（Agent 写返回 403）。
- 源修复使用既有自动化批准链（write 批准 + 审计链 + 读回），不是 Agent 自行改板。
- 修复后官方 DRC 为 `status=pass`、`count=0`；验证工单按源状态自动收口。
- 新增 `autoResolvableOfficialIssueIds()`：官方检查通过后，只自动收口同 `checkId` / 同项目的旧问题；失败、非 official、无 projectId 都不会误关。

## 重要限制

`pcb.importChanges` 在 EDA 3.2.186 上只弹出「确认导入信息」对话框并返回 success；配方的读回只校验 `pcb.placement.read` 器件数，所以本次配方报 `completed` 并不等于网表已同步。真正生效依赖：

1. 在 EDA 对话框点「应用修改」；
2. 保存 PCB；
3. 重跑官方 DRC 验证 `itemCount=0`。

后续应把 `pcb-sync-from-schematic` 的断言改为 netlist/DRC 等价性，避免“弹窗未应用”被误判为成功。

## 验证

- 前端：`npx vitest run` 29 个文件、228/228 通过。
- 新增/相关单测：`validationEvidence.test.ts` 13/13；`SupervisorPanel.test.tsx` 6/6。
- `npm run build`：通过（仅既有 chunk size 警告）。
- Runtime：`node --test --test-force-exit --test-timeout=120000 "runtime/**/*.test.mjs"` 1455/1455 通过、cancelled 0；`write-gate-http.test.mjs` 单文件 3/3 通过。

## 截图

- `01-ticket-ack.png`：概览页接单
- `02-drc-after-apply.png`：应用导入后的 DRC 页
- `03-drc-pass.png`：DRC 通过
- `04-overview-after-autoclose.png`：最终概览（4 总数 / 2 需处理）
