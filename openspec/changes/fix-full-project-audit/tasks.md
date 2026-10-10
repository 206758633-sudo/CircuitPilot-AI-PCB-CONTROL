## 1. Correctness and security
- [x] 1.1 Validate image Base64, decoded size and file signature in Runtime
- [x] 1.2 Add invalid and spoofed image regression cases
- [x] 1.3 Update the EDA preview E2E flow to the current read action

## 2. Specification integrity
- [x] 2.1 Add AI chat attachment deltas
- [x] 2.2 Add conversation-driven PCB workspace deltas

## 3. Verification
- [x] 3.1 Pass typecheck, unit, Runtime, E2E and strict OpenSpec validation
  - 实测证据（2026-10-10）：`npx tsc -b` 退出 0；`npx vitest run` 20/20；`node --test "runtime/**/*.test.mjs"` 64/64；`npx playwright test` 21/21；`openspec validate fix-full-project-audit --strict` 与 `implement-controlled-simple-board-design --strict` 均通过。
  - 说明：这两项在修复前是假的 —— `npx tsc -b` 曾有 18 处类型错误，而当时 `npm test` 不含 typecheck，所以测试全绿却无法构建。现已把 typecheck 并入 `npm test`，并新增 `.github/workflows/ci.yml`。
- [x] 3.2a Pass production dependency audit（`npm audit --omit=dev --audit-level=high` 官方源 0 漏洞；注意默认 npmmirror 源不支持 audit 接口会返回 404 NOT_IMPLEMENTED，需显式指定 `--registry=https://registry.npmjs.org`）
- [ ] 3.2b Pass desktop build —— 未完成：仓库内最新 DMG 生成于 2026-08-25 18:25，早于此后对 `src/` 的修改；`cargo check` 通过、`desktop:check` 通过，但本次变更没有重跑完整 `tauri build`，因此桌面包仍未按当前源码验收。
- [x] 3.3 复现并修复安全审计中的严重项：EDA 命令参数注入（`runtime/bridge.mjs`）、Runtime 令牌分发与只读路由鉴权（`runtime/server.mjs`）、工程引擎输入导致的内存耗尽（`runtime/engineering/layout.mjs`、`hdi.mjs`）、PCB 陈旧 DRC 放行（`runtime/pcb.mjs`）、生产门禁信任客户端结论（`runtime/production.mjs`）。每项都补了回归测试。
