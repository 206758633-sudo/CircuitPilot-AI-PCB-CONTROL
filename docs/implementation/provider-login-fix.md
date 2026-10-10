# Codex 账号登录修复记录

日期：2026-08-25  
Runtime：0.6.1  
OpenSpec：`fix-provider-login`

## 根因

- `codex login` 通过 `detached + stdio: ignore` 静默启动，Runtime 不等待 `spawn/error/close`，因此启动失败也会被报告为成功。
- 界面不识别账号已经登录，重复启动登录流程。
- 启动后不轮询 Provider 状态，只提示用户手动刷新。
- 旧 Runtime 返回的登录结果没有契约版本，但界面仍按成功处理。
- “测试连接”没有检查 CLI 返回的 `ready:false`，可能产生错误的就绪状态。

## 修复

- 新增可观察的有界启动握手，捕获 spawn 错误与提前退出；授权 URL 在错误摘要中强制脱敏。
- 登录前执行真实 CLI 状态检查，已经登录时返回 `already_authenticated`。
- 登录开始后每 1.5 秒自动检查一次状态，最多 60 秒；成功、失败、超时或页面卸载时停止。
- 前端要求新版 `state` 登录契约；旧 Runtime 明确提示完全退出并重启新版 CircuitPilot。
- Provider 连接测试现在会拒绝 `ready:false` 或 `ok:false`。

## 验证

- 本机真实 `codex login status`：`Logged in using ChatGPT`。
- 本机真实修复函数：返回 `already_authenticated`，不启动重复登录进程。
- 前端测试：16/16。
- Runtime 测试：42/42。
- Playwright E2E：15/15。
- 类型检查、生产构建、OpenSpec 严格校验：通过。

## 经验总结

- 进程 PID 只能证明系统分配过进程，不能证明登录流程可用。
- 账号认证必须采用“启动确认 + 状态轮询 + 明确终态”，不能依赖一次按钮提示。
- 前端与本机 Runtime 的契约升级必须可检测，避免旧后台进程伪装成新版本。
