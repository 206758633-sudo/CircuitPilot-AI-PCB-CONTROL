# UI 批准直接执行：设计评估（2026-10-29）

> 结论：**当前不把“UI 点批准”直接等同于执行授权。** UI 批准仍只改变计划请求状态；真正写入必须由 Agent/调用方在用户明确确认后调用 `cp_approve`，再由 Runtime 签发一次性令牌、校验 `planHash` + 目标指纹 + 写锁后执行。  
> 本文评估的是“是否/如何演进为 UI 直接执行”，不是已实现能力。

## 1. 现状

- `POST /api/agent/plan-requests` 由 Agent 创建 pending 计划。
- UI `POST /api/agent/plan-requests/:id/decision` 只把请求改为 approved/rejected；**不签发 token、不执行**。
- Agent 仍需 `cp_approve`（Runtime 校验 `confirm=true` + `approvalMode=chat` + 计划级请求绑定）→ `cp_execute`。
- 设计/Pcb Manager 的批准令牌绑定 `planHash`、目标指纹/window、一次性使用；执行前校验写锁、快照、DRC 等。

## 2. 为什么不能简单“UI 批准即执行”

1. **人类意图证明弱**：UI 的 approved 只证明“某个已登录浏览器会话点了按钮”，不能证明点击者看过具体 `planHash`/风险/缺失项；误点、脚本/CSRF、共享桌面都会放大风险。
2. **计划漂移**：UI 批准到执行之间 EDA 目标可能切换（窗口/文档/板），必须重新做 target fingerprint 与写锁校验；不能复用旧批准。
3. **越权面**：UI token 是会话级权限；若直接执行，任何能调用 UI API 的页面/扩展都能触发写板，等于绕过 Agent 的审批链。
4. **审计链**：当前 Agent 审批有 audit 记录（actor=agent、approvalId、planHash）。UI 直接执行必须把“人类决定”和“执行”分成两条可核验记录，不能只记一条 approved。
5. **永久禁止项**：签核/订单/设置不能因为 UI 按钮而绕过；生产导出仍需人工门禁。

## 3. 可接受的演进方案（候选）

### 方案 A（推荐，MVP 后）：UI 生成“一次性执行意图”，不直接执行

- UI 批准时写一条 `execution-intent`：绑定 `planHash`、target fingerprint、请求 id、过期时间（≤10 分钟）、一次性 nonce、人类操作者 id。
- Agent 执行前必须消费该 intent；Runtime 再校验 target 未变、写锁可用、计划 hash 一致，才签发执行令牌。
- UI 仍不能单独触发执行；只是把“人已批准”做成更强的、可过期的凭证。
- 风险：仍需 Agent/服务端发起执行，但把“批准”与“执行”解耦，可重放检测。

### 方案 B：UI 直接执行 + 二次确认 + 目标重校验

- 仅对 **低风险、create-only、无 component.modify/importChanges** 的计划开放；必须二次弹窗输入/确认 planHash 后 8 位。
- 执行前强制重新读 target fingerprint/window，重新取写锁；任何变化拒绝。
- UI token 只允许 `/api/pcb/execute` 的 intent 消费路径，不允许直接传 plan/approvalToken。
- 需要新端点 + 新审计事件 + 新测试；未实现。

### 方案 C：不演进（当前）

- 保持“UI 决策只记录、Agent 执行”的两步链；最简单、风险最低。当前选择。

## 4. 建议

- **短期保持方案 C**；先把回滚可靠性修好（当前 create-only 定向回滚已落地、待真机复验）。
- 中期若要做方案 A，必须先补：
  - intent 一次性/过期/绑定测试；
  - UI 二次确认显示 planHash/风险/缺失；
  - target 漂移回归；
  - 审计事件 actor=ui + agent 双记录；
  - create-only 限制与拒绝非创建计划。
- **不建议**方案 B 在当前阶段直接开放 `component.modify`/`importChanges` 的 UI 执行。

## 5. 验收标准（未来实现时）

- UI 批准不会单独改变 EDA 板子；只有消费 intent + Runtime 重校验后才可能写。
- 过期/重放/目标漂移/intent 与 planHash 不一致全部 fail-closed。
- 审计能回答“谁在何时批准了哪个 planHash、谁在何时执行、目标指纹是什么”。
- 生产导出/签核/订单仍被人工门禁和永久禁止项阻断。
