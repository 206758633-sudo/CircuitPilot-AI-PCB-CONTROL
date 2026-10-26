## Context

现有应用是Vite + React + TypeScript的纯前端Demo，`demoAdapter`对AI计划、Provider连接、Bridge、EDA命令和验证结果返回固定模拟值。项目没有后端、桌面壳层或安全凭据存储，全部状态位于LocalStorage。目标用户是使用Apple Silicon Mac的个人硬件工程师，需要在不交出账号密码、不静默修改工程的前提下，把本机Codex/Claude或API Key与嘉立创EDA专业版连接起来。

现有PRD指定Tauri 2桌面壳层、Rust本机层、SQLite、macOS Keychain、Node Bridge Sidecar和Provider Adapter。当前开发机未安装Rust工具链，因此本变更采用可独立验证的Node Runtime作为稳定服务边界，同时提供Tauri接入结构；Rust/DMG构建必须在工具链就绪后单独通过验收，不能因Web构建通过而标记桌面包已完成。

## Goals / Non-Goals

**Goals:**

- 在当前界面中提供真实、可恢复的首次启动配置和运行状态。
- 支持Codex官方登录状态、OpenAI API Key、个人本机Claude Code状态和Anthropic API Key四种配置路径。
- 通过macOS Keychain保存API Key，确保渲染层和普通持久化只看见布尔状态及不可逆提示。
- 发现并验证`127.0.0.1:49620-49629`上的EasyEDA Bridge，读取窗口、当前工程和当前文档。
- 建立统一、类型化、可测试的Runtime API和前端Adapter；真实Runtime不可用时明确降级为Demo，不伪造成功。
- 让Provider、Bridge、权限、命令和验证错误进入统一审计/问题记录接口。
- 为后续真实AI计划与小范围EDA写入保留受控命令、批准哈希、快照和回读契约。

**Non-Goals:**

- 不在本变更中承诺自动完成任意复杂、高速、射频或安规PCBA设计。
- 不收集ChatGPT、OpenAI、Claude或Anthropic账号密码。
- 不在公开分发模式中通过第三方界面转发Claude订阅OAuth；正式产品使用Anthropic API Key或支持的云提供商。
- 不允许模型生成的任意JavaScript直接提交给Bridge执行。
- 不自动开启嘉立创EDA“允许外部交互”、不自动选择多个窗口、不执行下单、支付、覆盖Gerber或删除工程。
- 未安装Rust工具链、没有签名证书或没有真实凭据时，不把Tauri/Provider生产验收标记为通过。

## Decisions

### 1. Node Runtime作为稳定本机服务边界

新增仅绑定`127.0.0.1`的Node Runtime，使用Node内置HTTP、进程和网络能力提供`/api/health`、系统诊断、Provider、Keychain和Bridge端点。React开发模式和未来Tauri壳层均调用同一类型化API。

选择该方案是因为现有项目已经具备Node 24，能够立即验证真实CLI、Keychain和Bridge行为；相比把系统命令写进React，它能隔离权限与敏感数据；相比等待Rust工具链，它不会阻塞核心接入。未来Tauri只负责生命周期、窗口、目录授权和打包，业务协议保持不变。

### 2. Provider适配器只返回状态与结构化结果

Provider统一接口包含`diagnose`、`startLogin`、`storeSecret`、`revokeSecret`和`testConnection`。Codex账号模式通过官方CLI登录并用状态命令验证；Claude个人模式只调用用户本机CLI，不读取其凭据；API模式从Keychain按需注入当前子进程或单次HTTP请求。

替代方案是在浏览器中直接调用云API，但这会暴露密钥并受CORS限制，因此拒绝。另一方案是修改用户全局shell配置，也会污染环境且难以撤销，因此拒绝。

### 3. Keychain由Runtime独占

Runtime通过macOS `security`命令读写服务名受限的Generic Password项。API只接受保存/删除操作并返回`configured: boolean`与末四位提示；读取密钥只发生在Runtime内存中，任何响应、日志、异常和诊断包都必须脱敏。

### 4. Bridge先发现再握手

Runtime并发扫描49620-49629端口，但只有`GET /health`返回`service === "easyeda-bridge"`才接受。连接后读取`/eda-windows`；0窗口报告未连接，1窗口自动采用，多个窗口保持阻断直到用户选择。所有请求限制为回环地址、短超时和已知路径。

### 5. EDA命令使用注册表而非任意代码

前端只提交命令ID。Runtime命令注册表将ID映射为查阅过官方签名的固定代码，并声明`read`或`write`权限、所需文档类型和回读断言。第一阶段只开放健康、窗口、当前工程和当前文档等只读命令；写命令只有在对应API签名、计划哈希、批准、快照和验证器全部实现后才能加入注册表。

### 6. 模式是显式状态而非隐式回退

运行模式为`demo`、`real_read_only`或`real_controlled_write`。前端启动时探测Runtime；探测失败可以继续Demo，但所有按钮、状态栏、日志和下载内容继续标记DEMO。只有Provider和Bridge真实检查均通过时才能进入`real_read_only`；写门禁满足后才能进入`real_controlled_write`。

### 7. 桌面壳层渐进接入

仓库增加Tauri目录和配置入口，桌面开发命令负责先启动Runtime再启动Vite/Tauri。由于本机当前没有Rust，Web+Runtime是本次可执行验证基线；Tauri编译、签名、公证和DMG属于独立发布门槛，必须留下明确未完成记录。

## Risks / Trade-offs

- [Node Runtime增加本机攻击面] → 只绑定127.0.0.1、限制Origin、生成会话令牌、限制方法/路径/请求体、禁用任意shell和任意Bridge代码。
- [Keychain命令错误泄露密钥] → 密钥通过stdin传递，禁止进入命令行参数和日志，统一脱敏错误。
- [CLI版本或输出变化] → 使用超时、退出码和宽松状态解析，输出只保存摘要，并显示“未验证版本”。
- [Claude订阅OAuth用于第三方产品存在限制] → 个人CLI模式标为本地实验；可分发产品默认Anthropic API Key。
- [Bridge端口被伪服务占用] → 必须校验服务身份且只访问回环地址，不信任仅HTTP 200的端口。
- [API成功但工程错误] → 强制工程/文档回读、批准哈希和独立验证；第一阶段保持只读。
- [Tauri工具链缺失] → 不伪造桌面构建结果；先验证Runtime协议，工具链就绪后完成壳层验收。
- [现有LocalStorage数据迁移] → schema升级时保留项目Demo数据，只迁移非敏感设置，旧模拟Provider映射到demo模式。

## Migration Plan

1. 新增Runtime和测试，不改变现有Demo默认行为。
2. 扩展状态模型和前端Runtime Adapter，启动失败时明确保持Demo。
3. 增加设置向导、Provider/Keychain配置和真实诊断。
4. EDA页面接入Bridge发现、窗口选择与只读回读。
5. 将真实事件写入审计/问题记录，同时保留现有Demo回放。
6. 增加Tauri壳层与构建入口；Rust工具链就绪后执行桌面构建。
7. 通过安全、单元、集成和E2E测试后才允许默认展示真实模式入口。

回滚时删除Runtime启动入口和Tauri壳层即可回到纯Web Demo；LocalStorage迁移必须容忍新字段缺失，Keychain条目只有用户明确撤销时删除。

## Open Questions

- Apple开发者签名证书和公证账号尚未提供，DMG只能在后续发布阶段验收。
- Codex CLI已在`~/.npm-global/bin/codex`发现并通过ChatGPT登录状态检查；后续仍需验证桌面打包环境中的路径发现。
- 真实OpenAI/Anthropic API连接测试需要用户在界面中自行保存有效Key；自动测试不得使用或输出用户密钥。
- 首批真实写命令的具体器件、网络和项目样例需要在只读接入稳定后另行批准。
