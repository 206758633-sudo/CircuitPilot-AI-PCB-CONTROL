# CircuitPilot Agent MVP 剩余可交付项完成矩阵（2026-10-30）

> 口径：**代码级/本机验证完成**，不是正式生产放行。桌面 4178 仍需重建/重启才能加载本轮新 Runtime 代码；整档 `document.source.restore` 与非创建变更回滚仍是已知限制。

| 目标项 | 状态 | 证据 | 边界 |
|---|---|---|---|
| 真实改图元写入 + 自动回滚演练 | **已验证（create-only）** | 隔离 Runtime 4186 真机执行 `planHash c629fda8…`；临时线 `c7614511fe67a28c` 创建后因非法 `component.modify` 失败，自动定向删除；`state=rolled_back`、`scope=targeted`、`snapshotRestored=false`；板面 95/1152/191/13、临时 id 不存在、无 safety lock；`artifacts/agent-rollback-drill-targeted-success-20261030.json` | 未验证整档源码恢复；未验证含 component.modify/importChanges 的非创建回滚；回滚后未单独跑官方 DRC |
| 受控导出/签核边界验证 | **边界已核对** | `docs/agent/export-signoff-boundary.md`；runtime 套件中的 release/production gate 回归通过（1433/1433 内含）；未生成正式生产文件 | 正式导出仍被 A16/在线 DFM/人工终审签核 block；AI 不签核、不下单 |
| 批量写/导出评估 | **评估完成** | `docs/agent/batch-write-export-evaluation.md`；批量只读真机 1 通过/1 失败已修复并记录 | 不实现一键批量写/批量正式导出；每板独立 planHash/批准/执行 |
| 审计外部锚点 | **实现 + 真机冒烟通过** | `createExternalAuditAnchor`/`verifyExternalAuditAnchor` + CLI；真实 state seq=44 锚点，`currentMatches=true`；`artifacts/audit-external-anchor-20261029/`；测试 9/9 | 独立目录签名收据，**不是远端 WORM** |
| UI 批准直接执行设计评估 | **评估完成** | `docs/agent/ui-approval-execute-evaluation.md` | 当前保持两步链；未开放 UI 直接执行 |
| 实验 EDA 适配器加固 | **已完成 + 冒烟 + 当前在线** | body/token 上限 8MB、token timingSafeEqual、health limits；无 token/错 token 401、空 code 400；未执行写 | 仍是实验适配器，不是生产桥 |

## 验证命令

- `npm run test:runtime` → **1433/1433 PASS**
- `npm run typecheck` → exit 0
- 审计归档/外部锚点测试 → **9/9 PASS**
- 适配器加固冒烟 → 401/401/400（见本轮记录）
- 真机回滚 → 见上表证据

## 仍未完成/部署注意

1. 桌面 4178 已重建并重启为包含定向回滚的新 bundle（`3236fef6…`）；当前 DSH 进程仍需重启才能加载 `cp_issues` 投影修复。
2. 整档 `document.source.restore` 仍不可靠；只对 create-only 变更提供定向回滚。
3. 非创建变更回滚演练需要新 planHash + 用户确认，当前未做。
4. 正式导出/签核/下单永久受人工门禁与禁止项约束，AI 不替代。


## 2026-10-30 环境修复补充

- 桌面 app 已用 `npm run desktop:app` 重建并重启；bundle 与仓库 `runtime/pcb.mjs` 哈希一致。
- Vite 4177 指向开发 Runtime 4179；`e2e/app.spec.ts` **31/31 PASS**，完整 Playwright **38 passed / 6 skipped**（4 个需 `CP_LIVE_EDA_E2E=1` 的真机用例 + 2 个需要独占 4178 的 C6/F7 用例；无失败）。
- 实验 EDA 适配器启动后 `cp_status` EDA **online**。
- `cp_issues` title/code 回退修复，插件测试 **85/85**。
- E2E mock 改为 host-agnostic；规则中心按 151 条规则包更新断言；完整 E2E 已全绿（除显式 live 与需独占 4178 的跳过项）。
- 证据：`artifacts/agent-environment-recovery-20261030.json`。
- 2026-10-30 非创建回滚演练失败：planHash `c0b54846…`，C1 0.01mm 后 `EDA_REQUEST_ABANDONED`，`source.restore` 摘要不匹配，安全写锁已触发；表面回读/DRC 与演练前一致但 sourceDigest 不一致。证据：`artifacts/agent-rollback-drill-noncreate-failure-20261030.json`。
