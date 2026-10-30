# Agent 控制台 / 审计链安全：独立复验（task-28，task-30/task-32 回归）

**结论：PASS**（二值；范围内验收通过。P2 尾部删除检测已由 Lead 以 head 锚点修复，本目录复验通过；P3 下载根分隔符已修复复验通过；另有 3 项边界观察 + 1 项并发窗口观察。均不构成 fail-open 绕过，详见下文）。

- 执行者：`agent-verifier`（独立复验，不修改生产代码）
- 范围：`runtime/agent-console.mjs` / `runtime/agent-token.mjs` / `runtime/agent-auth.mjs` / `runtime/server.mjs` 的 Agent 控制台、审计链 + head 锚点、令牌轮换、路由边界、下载拒绝、日志脱敏
- 真实 Runtime：`createRuntimeServer()` + 随机回环端口 + 临时 state/evidence/automation 目录 + 临时 token/audit/key/head
- 约束：未连接真实 EDA/4178、未重启 DSH、未执行 git、未改 `runtime/**`/`src/**`/`agent/**`/`plugin/**`（本目录之外零改动）
- 演进：task-30 适配 P3（`CIRCUITPILOT_DOWNLOAD_ROOTS` 改用 `node:path.delimiter`）；task-32 适配 P2（新增 `agent-audit.head.json` 链头锚点、`integrity.anchored/headSeq/headHash`、`head-ahead/head-behind/head-hash-mismatch/head-invalid`、下载拒绝 head 文件）。

## 运行方式与结果

```bash
node --test "verification/agent/console/*.test.mjs"
```

**35/35 全绿**，连续重跑 3 次稳定（约 2.1–2.6s/次）：

| 文件 | 用例数 | 说明 |
| --- | --- | --- |
| `chain-attacks.test.mjs` | 21 | 直接攻击 `agent-audit.jsonl` + head：改字段/删中间行/删尾行/删整文件/换序/legacy 注入/截断/改 hash/prevHash/seq/head 缺失/head 落后/head 损坏；密钥缺失/权限过宽/内容损坏；legacy 前缀、并发 append、脱敏与 UTF-8 截断、独立 HMAC 复算 |
| `http-security.test.mjs` | 14 | 真实 HTTP：status/audit/rotate、篡改矩阵（含 head-ahead/head-hash-mismatch/head-behind/head-invalid）200+broken、链断/head 落后 append 零字节、head 缺失不误报、rotate 旧 401/新 200 与并发、Agent 路由矩阵、无 token/权限过宽、泄漏扫描、下载敏感文件（token/key/**head**）/穿越/symlink、P3 多根分隔复验 |
| `helpers.mjs` | — | 临时 Runtime/token/audit/key/head、HTTP 调用、链构造与篡改、独立 canonical JSON + HMAC 复算 |

## 验收点覆盖矩阵

| 要求 | 证据（测试名） | 实测结果 |
| --- | --- | --- |
| 改字段/删中间行/换序/legacy 注入/截断/改 hash/prevHash/seq → GET audit **200 + broken 不 500** | `HTTP 审计篡改矩阵…`；模块级同名用例 | 全部 HTTP 200；`integrity.ok=false, chain='broken'`，reason/firstBadSeq 精确匹配；events 仍返回；status 同样 200 并透传 broken |
| P2 head 锚点：写 3 条→head 与最后记录一致；删最后一行/删整文件→head-ahead；改最后一条→head-hash-mismatch；删中间行→seq-mismatch；head 缺失→anchored:false 不 broken；head 落后→append CHAIN_BROKEN 零字节 | `P2 修复（head 锚点）…`、`head 锚点：改最后一条的 hash…`、`head 缺失…`、`head 落后…`、`head 损坏…`、`HTTP head 锚点缺失…`、`HTTP head 落后…` | 见下方 head 锚点专项表；全部符合 |
| 链断/head 不一致时 append 不写任何字节 | `链断时 Agent 请求仍成功但 append 不写字节…`、`head 落后…`、`head 锚点：改最后一条的 hash…`、`P2 修复…` | `AGENT_AUDIT_CHAIN_BROKEN`；审计文件字节数前后完全一致；拒绝时 head 也不被改写 |
| 密钥缺失/权限过宽 → `key-missing`/`key-invalid`，绝不换新 key 假续 | `HTTP 密钥攻击…`、`密钥文件缺失…`、`密钥文件权限过宽…`、`密钥文件内容损坏…` | read 200 + 对应 reason；append 拒绝；密钥文件不重建、不 chmod、不重写；恢复原 key 后旧链重新验证通过 |
| token/密钥不出现在 status/audit/rotate/diagnostics/download 响应、stdout/stderr、错误 message | `泄漏扫描…`、`UI status/audit…`、`rotate…` | 响应体/错误 message/捕获的 logger 输出/落盘审计均无 `cpa_...`、旧/新 token、64hex 审计密钥；diagnostics `redaction.applied=true` |
| 下载路由拒绝 `agent-token.json` / `agent-audit.key.json` / **`agent-audit.head.json`**（即使配置到下载根） | `下载路由…`、`泄漏扫描…`、`P3 修复复验…` | 三个敏感文件均 403 `DOWNLOAD_SENSITIVE_FORBIDDEN`（多 root 配置下同样拒绝）；路径穿越、symlink 指向敏感文件同样 403；symlink 逃逸根目录 403 `DOWNLOAD_PATH_FORBIDDEN`；合法 `.json` 产物 200 |
| P3 修复：多下载根分隔符 | `P3 修复复验…` | `node:path.delimiter`（POSIX `:`）拼两个 root：第一/第二 root 内产物均 200；同配置下 token/key/head 仍 403；POSIX `;` 不再被当分隔符（整串单一路径 → 根列表空 → fail-closed 403） |
| rotate 后旧 token 立即 401、新 token 200；审计链完整 | `rotate：旧 token…`、`并发 rotate + 旧 token 请求…` | rotate 返回后连续 5 次旧 token 全 401；新 token 立即 200；10 并发的旧 token 请求在 rotate 完成后全部 401；rotate 事件落盘（`kind=rotate, actor=ui`）且链 `ok`、`anchored=true` |
| Agent 路由边界：GET status 200；GET audit / POST rotate / settings / signoff / write-gate 403 | `Agent 路由边界矩阵…` | 全部符合；`%61`、`%25` 双重编码、`..`、尾斜杠等变体均 403，无绕过；无 token/错 token 为 401（未误判为 403） |
| 审计脱敏/UTF-8 截断不破链 | `脱敏与 UTF-8 截断…` | path 中 `cpa_...` → `cpa_[redacted]`；512B 上限按整字符截断无 U+FFFD；白名单外 `token/authorization/key/嵌套` 不落盘；追加后链仍 `ok`、`anchored=true` |
| 独立复算（不只信实现结论） | `基线链：3 条事件…` | 自实现 canonical JSON + `node:crypto` HMAC 逐条复算一致；普通 SHA-256 与链 hash 不等；并发 10 写入 seq 严格 1..10、无分叉 |

### head 锚点专项（P2 修复复验）

| 攻击/状态 | 实测（模块级 + HTTP 级一致） |
| --- | --- |
| 正常写 3 条 | `agent-audit.head.json` 0600，`{version:1,seq:3,hash}`，hash == 最后一条记录 hash；`integrity.anchored=true, headSeq=3, headHash=<hash>` |
| 删最后一条完整记录 | `200 + broken / reason=head-ahead / anchored=false / headSeq=3`，events 仍返回 2 条；append 再取 `CHAIN_BROKEN` 且零字节 |
| 删除整个审计文件（head 仍在） | `200 + broken / head-ahead / anchored=false`，events=[] |
| 改最后一条的 hash 字段 | `head-hash-mismatch`（锚点优先于链内 hash 检查），`anchored=false` |
| 只改最后一条内容、保留旧 hash | `hash-mismatch`（链自校验先发现）；此时 head 与“记录里的 hash 字段”仍一致，故 `anchored=true` |
| 删中间行 | `seq-mismatch`（链序号缺口），head 与末条一致 → `anchored=true` |
| head 文件缺失（旧审计） | `ok=true / chain='ok' / anchored=false / headSeq=null`，不误报 broken；后续 append 自动重建 head 并恢复 anchored |
| head 回退（seq 落后） | read：`broken / head-behind / anchored=false / headSeq=3 / firstBadSeq=4`；append：`CHAIN_BROKEN`、零字节、head 不变 |
| head 损坏 | `broken / head-invalid / anchored=false / headSeq=null`；append `CHAIN_BROKEN`、零字节 |

## 独立发现（非作者测试覆盖）

### F1（P2，已修复并由本目录复验通过）尾部删除检测：`agent-audit.head.json` 链头锚点

- 原问题：前缀 HMAC 链没有外部锚点，删掉最后一条完整记录后 `integrity.ok=true`，与契约“删行 → broken”不符（本目录 task-28 报告）。
- **Lead 修复**（task-31）：`runtime/agent-console.mjs` 新增 head 锚点文件（默认 `dirname(auditFile)/agent-audit.head.json`，0600，原子写），append 成功后更新；append 前校验 head 与最后一条链记录；read 新增 `anchored/headSeq/headHash` 与 `head-ahead/head-behind/head-hash-mismatch/head-invalid`；下载路由把 `agent-audit.head.json` 加入敏感名。
- **本次复验**：见上方专项表，删尾行/删整文件/改末条 hash/head 落后/head 损坏均被检出，HTTP audit/status 均 200 且 `integrity.broken`；head 缺失保持兼容（`anchored=false` 不误报）；`P2 修复…`、`head 锚点…`、`HTTP head…` 用例全绿。
- **仍保留的边界（不在链内防御）**：能同时改写 `agent-audit.jsonl` + `agent-audit.head.json` + 审计密钥的同用户攻击者仍可重算整条链与 head（本机单用户威胁模型的固有限制，需要远端镜像/签名锚点才能跨越）。head 锚点把“只删尾行”的静默篡改门槛提高到“必须同时改 head”，但不能对抗拥有全部三份文件的攻击者。

### F2（P3，已修复并由本目录复验通过）`CIRCUITPILOT_DOWNLOAD_ROOTS` 在 POSIX 用 `:` 分隔曾静默失效

- 原问题：`runtime/server.mjs` 用 `sep` 判断分隔符（`sep === ':'` 在 POSIX 恒 false），整串被当单一路径 → 根列表空 → 根内合法产物 403。
- **Lead 修复**：改用 `import { delimiter } from 'node:path'` 并 `split(delimiter)`；补生产测试。
- **本次复验**（`P3 修复复验…`）：两个 root 用 `delimiter` 拼接均 200；同配置下 token/key/head 仍 403；POSIX `;` 不再作为分隔符（fail-closed 403）；泄漏扫描/下载安全用例攻击强度未降低。

### F3（观察，语义边界）白名单外字段注入不会被判为链篡改

- `已知语义边界…`：存储行加入 `evilInjected`/`token` 等白名单外字段后，`integrity` 仍 `ok`——读取先按白名单 sanitize 再复算 HMAC，字段被丢弃、不显示、不泄漏；head 锚点也不受影响。
- 影响：不能借此改变 UI 展示或注入秘密；但“文件字节被改”不必然 broken。建议明确 HMAC 覆盖“规范化事件字段”而非整行字节。

### F4（观察）运行中放宽 token 文件权限：status 立即报 invalid，但已缓存 token 仍可认证

- `chmod 0644` 后 `GET /api/agent/status` 立即 `available:false / AGENT_TOKEN_INVALID` 且不自动修复；但启动时已读入内存的 token 仍能通过认证，直到重启。属于缓存语义，不构成读取泄漏（能 chmod 的同用户本来就能读文件）。

### F5（观察，未利用）下载敏感名拦截是 basename 匹配

- 只拦 `agent-token.json` / `agent-audit.key.json` / `agent-audit.head.json` 三个**文件名**；若把敏感内容复制/硬链接成根内另一个 `.json` 名字，路由无法凭内容识别。利用它需要先能写下载根（与读密钥同权限），且 Agent 根本到不了下载路由；未作为攻击用例断言，仅记录边界。

### F6（观察，并发窗口）append 落行与 head 更新之间的窄窗口，并发 read 可能短暂看到 head-behind/broken

- 实测：Agent 请求刚返回时立刻 `GET /api/agent/audit`，偶发一次 `head-behind/broken`（此后同一文件的下一次读即恢复 `ok/anchored=true`）。原因：append 先追加审计行、后原子写 head，两步骤之间存在毫秒级窗口。
- 影响：不丢记录、不 fail-open，最坏是设置页徽标在写入瞬间闪一下“审计链异常”；本次测试通过“等特定事件 + integrity.ok”消除抖动。若要求零闪烁，可让 read 在 head 缺失/落后时增加极短重试或按“写入中”降级展示。

## 未覆盖 / 未验证

- `>8MB` 审计文件“只读尾部窗口”的 `read-window-truncated` 分支（构造 8MB+ 文件成本高，未测）。
- rotate **写盘失败**路径（token 目录只读/磁盘满 → `AGENT_TOKEN_ROTATE_FAILED`）与 **head 写失败**路径（append 返回 `headUpdated:false` warning），未构造。
- 设置页 UI 组件 `src/components/AgentAccessPanel.tsx` 的渲染、`anchored` 展示与 401 展示（Lead 允许只测 API；本次全部为 API 级）。
- 真正的 `process.stdout/stderr` 字节流：本次捕获的是 logger 实际使用的 `console.info/warn/error`（已覆盖日志泄漏路径）；未 hook 底层 fd。
- Windows 权限位语义、非 POSIX 平台的文件模式检查（macOS 上验证 0600/0644）。
- 常量时间比较无法从外部黑盒证明（仅代码审阅 `timingSafeEqual` + 长度预判）。
- 多进程并发 append（生产用进程内 `appendQueues`；本次只验证同进程并发）。
- 审计文件本身未强制 0600（落盘内容已脱敏；未纳入本轮重点）。

## 证据摘要（关键断言）

- 独立 HMAC：`hash === HMAC-SHA256(key, "${seq}\n${prevHash}\n${canonical(event)}")` 逐条复算一致；首条 `prevHash` 为 64 个 `0`；head 文件 0600，字段仅 `{version,seq,hash,updatedAt}`。
- 篡改矩阵实测（HTTP 均 200，非 500）：改字段→`hash-mismatch#2`；删中间行→`seq-mismatch#2`；换序→`seq-mismatch#1`；legacy 注入链后→`legacy-after-chain`；截断最后一行→`bad-line`；改 hash→`hash-mismatch#2`；改 prevHash→`prev-hash-mismatch#2`；seq 跳号（中间）→`seq-mismatch#2`；删尾行→`head-ahead#3`；删整文件→`head-ahead`；改末条 hash→`head-hash-mismatch#3`；head 回退→`head-behind#3`；head 损坏→`head-invalid`。
- 链断/head 落后时 append：`AGENT_AUDIT_CHAIN_BROKEN`，审计文件字节数不变、head 不变；Agent 业务请求仍 200。
- 密钥文件：缺失→`key-missing`，0644→`key-invalid`，均不重建/不自动 chmod；恢复原 key 后旧链重新 `ok`。
- rotate：响应不含任何 token；旧 token 立即 401，新 token 立即 200；新 token 文件 0600；审计 `rotate` 事件使链继续完整且 `anchored=true`。
- 泄漏扫描 haystack = 10 个响应体（status/audit/diagnostics/三个下载/错误/rotate/status/audit）+ 捕获日志 + 落盘审计：不含旧/新 token、审计密钥、`cpa_` 模式。
- head 锚点文件下载：`agent-audit.head.json` → 403 `DOWNLOAD_SENSITIVE_FORBIDDEN`（根内、多 root 配置下同样拒绝）。

## 文件

- `verification/agent/console/helpers.mjs` — 临时 Runtime/token/audit/key/head 与攻击夹具
- `verification/agent/console/chain-attacks.test.mjs` — 模块级链/head/密钥攻击（21）
- `verification/agent/console/http-security.test.mjs` — HTTP 级控制台/轮换/边界/泄漏/下载/head 攻击（14）
- `verification/agent/console/README.md` — 本文件

> 生产代码零改动；本目录之外无写入。
