# Contributing to CircuitPilot

Thanks for helping. This project controls hardware-adjacent operations, so
correctness, evidence, and honest failure reporting matter more than speed.

中文摘要见文末。

## Development setup

```bash
npm ci
npm run dev:full        # console + local runtime
npm run typecheck
npm test                # typecheck + unit + runtime tests
npm run test:e2e        # Playwright
npm run desktop:dev     # Tauri shell (needs Rust + Xcode CLT)
```

## Before opening a pull request

- Keep changes focused; one concern per PR.
- Add or update tests for behaviour changes. A failing/blocked path needs a
  test too.
- Run `npm run typecheck && npm test && npm run build`.
- Do not commit: `node_modules/`, `dist/`, state/evidence, API keys, customer
  files, test-board files, manufacturing outputs, or `.app`/`.dmg` artifacts.
- Do not weaken a fail-closed gate to make a test pass. Fix the evidence or
  the state transition instead.
- UI changes must keep text ≥11px, visible focus states, and no horizontal
  overflow at the supported desktop widths.

## Commit / PR style

- Conventional prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
  `chore:`.
- Explain *why* in the PR description, including what you verified and what
  remains unverified.
- Link related issues. Screenshots are welcome for UI changes.

## Security

Never report vulnerabilities in a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0, the same license as this project (inbound = outbound).

---

## 中文摘要

- 先 `npm ci`，用 `npm run dev:full` 启动控制台与本地 Runtime。
- 提交前必须跑 `npm run typecheck && npm test && npm run build`。
- 一个 PR 只做一件事；行为变更必须补测试，失败/阻断路径也要有测试。
- 禁止把 `node_modules/`、构建产物、状态/证据、密钥、客户文件、测试板文件、制造文件、`.app`/`.dmg` 提交进仓库。
- 不允许为了让测试变绿而放宽 fail-closed 门禁；应修证据或状态机。
- UI 改动保持字号 ≥11px、焦点可见、无横向溢出。
- 贡献默认按 Apache-2.0 授权（inbound = outbound）。
