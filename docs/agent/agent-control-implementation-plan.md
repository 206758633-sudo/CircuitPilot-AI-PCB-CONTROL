# CircuitPilot Agent 控制面实施计划（2026-10-29）

> 目标：把 CircuitPilot 从「页面操作」扩展为「对话可驱动、关键动作仍由人批准」的 PCB 设计 Runtime。
> 形态：Agent Gateway（MCP）+ DSH 插件壳 + Skill。
> 实施状态（2026-10-29）：MVP（Runtime agent token + DSH 插件 + Skill + MCP + 独立验证）已完成；设置页 Agent 接入/审计控制台（令牌状态、轮换、最近调用审计 + HMAC 哈希链 + head 锚点 + 批准账本只读视图 + 待执行批准队列与按 approvalId 撤销 + 插件/UI 审批 deep link）也已落地；**计划级待审批队列 + UI 逐条批准/拒绝 + `approvalRequestId` 绑定消费**已完成（task-40/task-41，真实 UI 2/2、真实 HTTP 14/14）；多项目/多板只读总览、最多 3 板批量只读校验（ERC/DRC/门禁）已实现；MCP 已支持 stdio + Streamable HTTP（可选 `--http`）；`npm run verify:agent-live` 对**真机 4178（0.2.0）**跑出 9/9，真实 UI 深链 e2e 1/1、真实 MCP 12 工具对桌面 Runtime 实测通过。详见 `docs/agent/agent-live-acceptance-2026-10-29.md`。
> 仍待：真实 DSH profile 在有凭据的宿主里自动调用工具（插件激活 bug 已修）、真实 EDA 写板/DRC 证据链、从 UI 批准后直接触发执行的授权语义（当前 UI 仍不签发 token）、批量写/导出、审计归档/回放与跨宿主；本文工期与验证口径继续作为这些阶段的计划。

## 1. 范围与非目标

**范围内**
- Agent 配对与 scoped token（只读/计划/执行，不含签核）
- Agent Job API（start/status/wait/cancel、幂等、超时语义）
- 12–15 个高层意图工具（status/plan/execute/validate/evidence/job）
- MCP server（stdio + streamable-http）与 DSH 接入
- 内置 Skill + 系统提示 + 审批 deep link
- 原生 DSH 插件（原生工具、bundled skill、图片/资源、companion）
- 批量/定时、审计回放、安全与跨宿主验证

**非目标（本期不做）**
- 重写 CircuitPilot React UI
- 自动签核/自动付款/自动绕过审批
- 多租户/云端/远程 EDA
- 替代 EasyEDA 的布局编辑器
- 对 EDA 私有协议做逆向或绕过 Bridge

## 2. 前提假设

1. 复用现有 Runtime、受控写入链、证据库、门禁、EDA Bridge；不做大规模重写。
2. 有一块可反复擦写的真实测试板 + EasyEDA 环境，用于 L3/L4 验收。
3. 第 1 周内确定两个产品决策：审批模式（UI 点击 / 纯对话 / 混合）、是否接受 DSH 插件依赖。
4. 以 1 名资深工程师 + AI 辅助为基准；有 2–3 个并行 teammate 时按并行列估算。
5. 不包含外部安全审计、正式订单/支付接入、长期运维。

## 3. 总工期结论

| 交付级别 | 内容 | 单人 + AI | 2–3 人并行 |
|---|---|---|---|
| **L0 可行性验证** | 契约 + MCP 通路 + 配对 spike + 只读 smoke | 3–5 天 | 2–3 天 |
| **L1 对话 MVP** | 配对 + Job API + MCP + 10–12 工具 + Skill；可完成读状态→计划→UI 批准→执行→证据摘要 | 3 周 | 2 周 |
| **L2 日常可用** | 原生 DSH 插件（companion、原生工具、bundled skill、图片、审批链接、干净安装） | 累计 6–7 周 | 累计 4–5 周 |
| **L3 完整建议形态** | 批量/定时、审批控制台、审计回放、安全加固、跨宿主、性能/上下文预算 | 累计 10–13 周 | 累计 7–9 周 |

> 关键路径：配对 token → Job/幂等 → 执行工具审批边界 → MCP 接入 → 真实板验收 → 插件打包。  
> 风险缓冲：上表已含约 20% 缓冲；真实 EDA 行为不确定时按 +1–2 周计。


## 3.1 连续 AI 实施模式（用户不中断、不等待人工排期）

上面的工期是“人类工程师排期”。如果由本 Agent 连续实施（长回合、边改边跑测试、只在真机/重启/审批处等待），可压缩约 5–10 倍：

| 交付 | 人类排期 | 连续 AI 实施 |
|---|---|---|
| 只读 MCP + Skill（status/context/issues/evidence） | 约 1 周 | 2–4 小时 |
| 对话 MVP（配对 + Job + 10–12 工具 + 计划/执行） | 约 3 周 | 1–2 个工作日 |
| 原生 DSH 插件（干净安装、原生工具、bundled skill、图片） | 累计 6–7 周 | 累计 3–5 个工作日 |
| 完整 L3（批量/定时/审计/安全/跨宿主） | 累计 10–13 周 | 累计 6–10 个工作日 |

**不能压缩的固定成本**
1. 真实 EDA / 测试板验收：需要 EDA 在线、可擦写板、审批点击；等待时间取决于你。
2. DSH 宿主重启 / 插件安装生效：需要重启 GUI（我不能重启自己的宿主）。
3. 产品决策：审批模式、是否装 desktop profile；默认走安全选项可不等。
4. 真实硬件/电气行为：代码再快也不能替代实测。

**连续模式的风险控制**
- 每个 Phase 结束必须过 Gate 和回归命令，不通过不继续堆功能。
- 写操作只在可擦写测试项目；默认写暂停，显式开启。
- 每 2–3 小时做一次可运行检查点，避免长回合后难以定位回归。

## 4. 阶段与任务清单

### Phase 0 — 可行性验证（3–5 天）

| ID | 任务 | 产出 | 依赖 | 估算 |
|---|---|---|---|---|
| T0.1 | 冻结 Agent 工具契约、审批边界、job 语义 | `docs/agent/agent-contract.md` | — | 1d |
| T0.2 | DSH MCP 通路 spike：临时 fake MCP server + profile patch + 工具调用 | 可复现的 profile 片段与调用记录 | — | 1d |
| T0.3 | Runtime 配对 spike：scoped token 签发/读取/撤销最小路径 | 配对原型 + 威胁模型草稿 | T0.1 | 1d |
| T0.4 | 真实 Runtime 只读 smoke：DSH→MCP→status/project/issues | 只读验收记录 | T0.2/T0.3 | 1d |
| T0.5 | Go/No-Go 评审：工具面、审批模式、插件依赖 | 决策记录 | T0.4 | 0.5d |

**Gate G0**：DSH 能通过 MCP 调用一个只读工具并返回真实项目状态；配对 token 不能被 agent 自行签发；审批模式已定。

### Phase 1 — Agent Gateway MVP（15–22 工程师日；AI 辅助约 10–15 个工作日）

| ID | 任务 | 产出 | 依赖 | 估算 |
|---|---|---|---|---|
| T1.1 | Agent 配对与 scoped token：签发/撤销/审计 actor、私有文件、权限范围 | `/api/agent/pair*` + token 存储 + UI/CLI 配对入口 | T0.3 | 2–3d |
| T1.2 | Agent Job API：start/status/wait/cancel、requestId 幂等、结果封顶、重启恢复 | `/api/agent/jobs*` + 契约测试 | T1.1 | 3d |
| T1.3 | 读工具：status/context/projects/issues/evidence/knowledge | 6 个工具 + schema | T1.2 | 2d |
| T1.4 | 计划工具：design_plan/pcb_plan/release_readiness + approvalUrl | 3 个工具 + 计划摘要 | T1.2 | 2d |
| T1.5 | 执行工具：design/pcb/validation/gates/export + 强制审批 token | 5–6 个工具 + 越权测试 | T1.4 | 3–4d |
| T1.6 | 结果投影：摘要、证据引用、图片/资源、错误→下一步 | projection 模块 + 大小上限 | T1.3/T1.5 | 2d |
| T1.7 | MCP server：stdio + streamable-http、鉴权、resources | `agent/mcp-server.mjs` | T1.3–T1.6 | 2d |
| T1.8 | Skill + 系统提示 + 10 条验收脚本 | `.dsh/skills/circuitpilot/SKILL.md` | T1.7 | 1d |
| T1.9 | 测试：unit/contract/fake bridge/live read-only | `agent/**/*.test.mjs` + 验收记录 | 全部 | 3d |
| T1.10 | 安装/配对/使用文档 | `docs/agent/install.md` | T1.9 | 1d |

**Gate G1**：在 DSH 对话中完成一条真实链：读取状态 → 出计划 → UI 批准 → 执行 → job 进度 → DRC 摘要 + 证据链接；无 token 执行被拒绝；重复 requestId 不重复写。

### Phase 2 — 原生 DSH 插件（18–22 工程师日；AI 辅助约 12–18 个工作日）

| ID | 任务 | 产出 | 依赖 | 估算 |
|---|---|---|---|---|
| T2.1 | 插件 scaffold：package.json、`dsh.bundle.patch`、peer 版本、CI | `plugin/` 可安装包 | G1 | 2d |
| T2.2 | companion：配对 token 私有存储、Runtime 健康/重连、job 轮询 | `plugin/companion.mjs` | T2.1 | 3d |
| T2.3 | 原生工具注册：schema、会话绑定、abort、并发 barrier | `ctx.tools.register` 实现 | T2.2 | 3d |
| T2.4 | bundled Skill + systemPrompt section | 插件内 skill provider | T2.3 | 1d |
| T2.5 | 图片/资源 + approval deep link + 结果卡片（markdown） | 截图附件、审批链接 | T2.3 | 2–3d |
| T2.6 | 打包/发布/插件市场/安装说明 | npm 包或 GitHub Release | T2.4/T2.5 | 2d |
| T2.7 | 兼容测试：干净 profile 安装、Runtime/EDA 离线、升级、卸载、版本矩阵 | 测试记录 + 矩阵 | T2.6 | 3–4d |
| T2.8 | 真实测试板验收 | 验收报告 | T2.7 | 1–2d |

**Gate G2**：全新 DSH profile 从包安装插件 → 工具与 skill 出现 → 完成 G1 场景 → 卸载后无残留、无崩溃；Runtime/EDA 不在线时给出可执行提示。

### Phase 3 — 产品化与体验（20–25 工程师日；AI 辅助约 15–20 个工作日）

| ID | 任务 | 产出 | 依赖 | 估算 |
|---|---|---|---|---|
| T3.1 | 审批控制台：审批卡片/deep link/ledger actor 展示 | UI 改造（最小） | G2 | 3d |
| T3.2 | 批量/多板：批量 DRC、导出、汇总 | 批量 job + 汇总 | T1.2 | 4d |
| T3.3 | 定时/恢复：夜间任务、DSH/Runtime 重启恢复 | scheduler + recovery | T1.2 | 3d |
| T3.4 | 可观测：工具调用日志、执行回放、导出诊断包 | 日志/回放页 | G2 | 3d |
| T3.5 | 安全加固：scope、路径白名单、prompt injection、审批绕过测试 | 威胁模型 + 测试 | G1 | 3d |
| T3.6 | 跨宿主：Claude Code/Codex 接入文档与 smoke | 适配文档 + 测试 | G1 | 2d |
| T3.7 | 性能/上下文预算：结果上限、缓存、状态摘要 | 性能报告 | G2 | 2d |
| T3.8 | 使用手册/培训/故障排查 | `docs/agent/runbook.md` | 全部 | 2d |

**Gate G3**：3 块板批量跑完；定时任务可恢复；审批/审计可回放；安全测试通过；第二宿主能完成只读+计划。

## 5. 关键路径与并行建议

```text
配对 → Job/幂等 → 执行工具 → MCP → 真实板验收 → 插件打包 → 干净安装
        ↘ 读工具/计划工具/结果投影（可并行）
        ↘ Skill/验收脚本（可并行）
        ↘ 插件 companion/native tools（G1 后并行）
```

- **必须串行**：配对 → Job → 执行审批边界 → 真实板验收。
- **可并行**：读/计划工具、结果投影、Skill、MCP 传输、插件 companion、测试脚本。
- 2–3 人配置建议：1 人 Runtime/配对/Job，1 人 Gateway/工具/测试，1 人插件/companion/Skill；Lead 负责契约、审批边界、真实板验收。

## 6. 验证计划

### 6.1 验证层级

| 层级 | 环境 | 允许写 EDA | 用途 |
|---|---|---|---|
| V0 静态/单元 | 本地 | 否 | schema、参数校验、错误码 |
| V1 契约 | fake Runtime/Bridge | 否 | 工具契约、审批、幂等、超时、投影 |
| V2 集成只读 | 真实 Runtime，只读 | 否 | status/context/issues/evidence 与 UI 一致 |
| V3 真实 EDA | 可擦写测试板 | 是（受控） | 计划→批准→写入→回读→DRC→回滚 |
| V4 DSH 客户端 | 干净 profile/插件 | 视场景 | 安装、工具/skill 可见、断线、卸载 |
| V5 验收 | 真实测试板 + DSH 对话 | 是（受控） | 端到端对话验收 |
| V6 回归 | CI | 否 | 现有 1281 runtime + 196 vitest + typecheck + build |

### 6.2 必须覆盖的测试

**审批与安全**
- 无 token / 过期 token / 重放 token 执行 → 401/403/409。
- 执行工具不能签发 approval；agent 不能调用签发接口。
- token scope 只读时不能执行；撤销后立即失效；审计 actor=agent。
- 错误项目/板子/documentUuid → 拒绝，不隐式落到当前选中。
- 项目数据/知识/BOM 文本含 prompt injection 时，不改变工具权限与审批。

**Job 与幂等**
- 同一 requestId 重复提交 → 同一结果，只执行一次。
- 超时后查询 → 返回 done/running/mayHaveTakenEffect，不盲目重试。
- cancel 后状态正确；Runtime/DSH 重启后 job 可恢复或如实 interrupted。
- 并发写同一文档 → 409/写锁提示，不出现双写。

**结果与证据**
- DRC 摘要的计数/分组与原始报告一致；超限时明确 `truncated`。
- 证据引用可回查，不返回伪造的通过。
- 图片/截图附件在模型不支持图像时明确报限制。

**DSH/插件**
- 干净 profile 安装/卸载；Runtime 未启动、EDA 未开、Bridge 断开的提示。
- 插件升级/回退不破坏 profile；peer 版本不兼容时拒绝安装。
- Skill 出现在 catalog；native 工具名稳定；会话销毁时取消在途调用。

### 6.3 验收脚本（建议 10 条对话）

1. “现在这块板什么状态？” → project/board/EDA/write gate/最近证据。
2. “出 4 层 0.2mm 间距重排计划，不要执行。” → 计划 + diff + 风险 + approvalUrl。
3. 未批准直接执行 → 被拒绝，提示去批准。
4. UI 批准后执行 → job 进度 → 完成回读。
5. “取消这个 job。” → 状态 cancelled，副作用说明。
6. “DRC 结果按 blocking 分组，给我截图和报告。” → 摘要 + 图片 + 证据链接。
7. “这三类问题怎么修？” → 修复建议 + approved 知识引用。
8. “重复提交刚才的 requestId。” → 返回同一结果，不重复写。
9. “对另外两块板跑同样 DRC，汇总。” → 批量 job + 汇总。
10. “把 Runtime 关掉再试。” → 可执行错误提示，不崩溃。

### 6.4 回归命令（每阶段必须绿）

```bash
npm run typecheck
npx vitest run
node --test --test-concurrency=1 --test-timeout=120000 "runtime/**/*.test.mjs"   # 基线 1281
node --test runtime/__tests__/route-contract.test.mjs                            # 182 路由 / 0 孤儿
npm run build
node --test "agent/**/*.test.mjs"                                                # 新增
```

真实 EDA 用例默认 gated（`CP_LIVE_EDA_E2E=1`），不得进入日常 CI。

## 7. 风险与缓冲

| 风险 | 影响 | 缓解 |
|---|---|---|
| Runtime token 目前只从 Tauri stdin 注入，外部进程拿不到 | 阻塞插件/CLI | Phase 0 先做 pairing，scoped token + 撤销；不复用 UI token |
| 长操作同步、超时重试重复写 | 数据/硬件风险 | requestId 幂等 + job 查询 + mayHaveTakenEffect |
| 审批边界设计不清 | 误写真实板 | 默认 UI 批准；执行工具不能签发 token；测试覆盖绕过 |
| EDA 真实行为/版本差异 | 验收延期 | 测试板 + 快照/回滚；错误分类；版本矩阵 |
| DSH 插件 API 版本演进 | 插件返工 | Gateway 独立；插件薄壳；peer 版本锁定 + 兼容测试 |
| 证据 JSON 过大 | 上下文爆炸/费用 | 结果投影上限、资源/图片、按需下钻 |
| 并发（GUI + agent） | 双写/状态错乱 | 写锁、当前操作者、409 可读提示 |
| 纯对话审批被模型绕过 | 安全风险 | 默认 UI 审批；纯对话作为显式可选模式并审计 |

## 8. 决策点（开工前必须确认）

1. 审批模式：默认 UI 点击 / 纯对话 / 混合（建议混合：低风险自动、写板 UI）。
2. 是否允许把插件安装进当前 desktop profile；建议先用独立 profile 验证。
3. 第一个验收板：用哪块可擦写测试板、允许哪些写入（设计/PCB/导出）。
4. Agent token scope：只读/计划/执行/导出分别授权还是一把 token（建议分 scope）。
5. 是否要求跨宿主（Claude Code/Codex）首发支持；建议首发只保证 DSH。

## 9. 建议执行顺序

1. 本周：Phase 0（3–5 天），先证明 MCP 通路 + 配对 + 只读 smoke。
2. 第 2–4 周：Phase 1，交付对话 MVP（10–12 工具 + Skill + UI 批准）。
3. 第 5–8 周：Phase 2，原生插件与干净安装。
4. 第 9–13 周：Phase 3，批量/定时/审计/安全/跨宿主。
5. 每个 Gate 做一次 Go/No-Go；未过不进入下一阶段。

---

**结论**：先做 3–5 天可行性验证；3 周内可交付“对话能读、能计划、能执行、能看证据”的 MVP；6–7 周达到日常可用；10–13 周完成建议的完整形态。若只做 MCP + Skill、不做原生插件，可压缩到约 3–4 周。
