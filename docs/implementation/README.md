# CircuitPilot 实现文档索引（H2）

> 新人按下面顺序读，10 分钟内能找到「链路验收入口」和「当前还剩什么」。
> 所有结论以运行证据为准：命令能复现、报告在 `artifacts/`，文档只是索引与边界说明。

## 1. 先读这 3 份（按顺序）

| 顺序 | 文档 | 回答什么问题 |
|---|---|---|
| 1 | [circuitpilot-completion-checklist.md](circuitpilot-completion-checklist.md) | 75 项功能的**当前状态**（✅/🟨/⬜）、证据路径、真机边界。看它判断"现在能不能用"。 |
| 2 | [circuitpilot-task-plan.md](circuitpilot-task-plan.md) | 每轮做了什么（T 行）、怎么验证的（V 行，含 acceptance 报告时间戳）。看它判断"最近改了什么、为什么"。 |
| 3 | [automation-kernel.md](automation-kernel.md) | 自动化内核（配方/API 优先/GUI 兜底/读回验证/批准/回滚/审计）怎么工作、失败怎么收口。看它判断"AI 到底能安全地做什么"。 |

## 2. 按角色继续读

- **想跑起来/验收**：[live-e2e-runbook.md](live-e2e-runbook.md)（真机 live 前置、环境变量、失败证据位置）→ 根目录 `README.md` 的启动与 `npm run acceptance`。
- **想看全链设计**：[ai-desktop-automation-plan.md](ai-desktop-automation-plan.md)（AI 决策 + 确定性配方 + 双通道）→ [real-ai-eda-runtime-2026-08-24.md](real-ai-eda-runtime-2026-08-24.md)。
- **想看 PCB 工程规则**：[pcba-layout-rules-integration.md](pcba-layout-rules-integration.md) → `docs/pcb-layout/` 下的规则包与基线。
- **想看生产/放行**：[production-implementation-2026-08-25.md](production-implementation-2026-08-25.md) → [pcb-production-runtime-2026-08-24.md](pcb-production-runtime-2026-08-24.md) → [net-application-runbook.md](net-application-runbook.md)。
- **想看差距审计（历史快照）**：[current-flow-gap-audit-2026-10-19.md](current-flow-gap-audit-2026-10-19.md)、[end-to-end-gap-audit.md](end-to-end-gap-audit.md)——注意它们是**当时**的结论，现状以 checklist 为准。
- **想看任务矩阵/历史**：[task-matrix.md](task-matrix.md)、[whole-board-progress.md](whole-board-progress.md)。

## 3. 一键验收入口

```bash
npm run acceptance   # typecheck + vitest + runtime + build + 路由契约 + e2e-app；真机项按显式开关 SKIP
npm run test:runtime # 只跑 runtime node:test（含 116 条 HTTP 路由契约）
npx vitest run       # 前端单测
```

真机项（live e2e / 写板 / 自动化矩阵 / 衣橱板）**不会被自动执行**，也不允许 AI 自批写入；
按 [live-e2e-runbook.md](live-e2e-runbook.md) 显式开启并留下证据。

## 4. 文档约定

- 状态只用三种：✅ 已闭环（有测试/真机证据）、🟨 部分完成（写明缺什么）、⬜ 未开始。
- 真机受限项必须写清：错误码、被哪道门禁挡住、恢复步骤；**不写"假 PASS"**。
- 新增能力必须同时更新：checklist 状态 + task-plan 的 T/V 行 + 相关设计文档；否则视为未完成。
- 历史审计文档不改写（保留当时结论），由 checklist 标注"历史快照"。
