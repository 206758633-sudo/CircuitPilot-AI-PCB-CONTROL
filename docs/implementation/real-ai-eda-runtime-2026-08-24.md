# 真实 AI 与嘉立创EDA Runtime 实施记录

日期：2026-08-24  
OpenSpec：`integrate-real-ai-eda-runtime`

## 已实施

1. 建立只监听 `127.0.0.1:4178` 的Node Runtime，包含Origin白名单、64KB请求上限、会话证明、统一错误码、超时和结构化脱敏日志。
2. 检测本机Node、Codex、Claude Code、Rust/Cargo和嘉立创EDA专业版。
3. 实现Codex/Claude官方CLI状态与登录启动；实现OpenAI/Anthropic API Key的macOS钥匙串保存、撤销与连接测试。
4. 实现EasyEDA Bridge端口扫描、服务身份校验、窗口列表、多窗口人工选择和断线处理。
5. 按API签名登记当前工程、当前文档两个固定只读命令；任意代码、未注册命令和写命令默认拒绝。
6. 将前端持久化升级到Schema v2并兼容v1数据；API Key与Token不进入LocalStorage。
7. 改造设置页为首次配置向导，改造EDA页为真实只读控制台，更新全局DEMO/REAL READ ONLY标识。
8. 增加结构化修改日志、持久化问题中心、重复问题聚合、处理历史、安全诊断导出。
9. 增加Tauri 2壳层、构建脚本和工具链诊断。

## 本机实测结果

- Node：已安装。
- Codex CLI：`~/.npm-global/bin/codex`，账号状态为ChatGPT登录。
- Claude Code：`~/.npm-global/bin/claude`，账号状态为OAuth登录。
- 嘉立创EDA专业版：`/Applications/嘉立创EDA(专业版).app`。
- EasyEDA Bridge：已启动于`127.0.0.1:49620`，嘉立创EDA窗口已连接，单窗口已自动选定。
- Rust/Cargo：当时未安装；Tauri桌面包未构建。（更正：Rust/Cargo 1.98.0 已安装，`desktop:check` 通过；仓库内 `CircuitPilot_0.2.0_aarch64.dmg` 生成于 2026-08-25 18:25，早于此后对 `src/` 的修改，因此没有对应当前源码的桌面包。）
- 真实API Key：未使用、未读取、未写入测试Key。

## 验证记录

- `openspec validate integrate-real-ai-eda-runtime`：通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm test`：前端14项 + Runtime 9项通过。
- `npm run test:e2e`：11/11通过，覆盖配置持久化、真实Bridge、修改日志、问题处理和无死按钮检查。
- 固定只读端到端回读：`project.current`成功返回（当前未打开工程，因此工程结果为`null`）；`document.current`成功返回当前起始页标识。
- `npm run desktop:check`：按预期失败，明确报告Rust/Cargo缺失。

## 安全与准确性约束

- AI输出不能成为任意Bridge代码；只能引用Runtime登记的命令ID。
- 0窗口阻断；1窗口自动采用；多窗口必须人工选定。
- 真实写入能力没有因为Provider或Bridge就绪而自动开启。
- 写入开放前必须另行实现并验收：工程快照、计划哈希、逐步审批、固定写命令、对象回读、ERC/DRC、失败回滚。
- 问题与日志只保存安全摘要；字段名命中token、key、secret、authorization等会脱敏。

## 经验总结

1. “已登录CLI”“API Key已保存”“Provider可调用”必须拆成三个独立状态，不能用一个绿色灯代替。
2. 本机端口返回HTTP 200不等于可信Bridge，必须验证服务身份。
3. 多窗口是PCB自动化最容易误操作真实工程的入口，目标选择必须成为强门禁。
4. 桌面壳层配置完成不等于可交付安装包；工具链、Sidecar、签名与公证必须分别验收。
5. Runtime不可达时允许继续Demo，但所有结果必须保持显式标记，不能制造“已经自动配置成功”的错觉。
