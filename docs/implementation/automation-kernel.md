# 自动化内核（Phase 0 + Phase 1）实现说明

- 时间：2026-10-19
- 范围：把"AI 决策 + 确定性配方 + API 优先/GUI 兜底 + 每步读回验证 + 三次人工批准 + 安全审计"的内核落地，并接入真实 EDA。
- 当前状态：
  - **Phase 0 完成**：配方 schema / 校验器 / 读回断言 / 哈希链审计 / 执行器 / 只读配方 / HTTP API / 单测与契约测试。
  - **Phase 1 内核与通道完成**：必填参数、`compose` 多路读回、GUI 兜底动作、服务端一次性批准（绑定窗口+工程+文档指纹）、三条写入配方 R1/R2/R6、自动化 UI 页、CLI 真机验收脚本。
  - **真机验收**：R1（打开工程，API `project.open` + compose 读回）、R2（`pcb.importChanges`）、R6（`pcb.pour.rebuild`）均已在真实嘉立创EDA 上 `completed`（2026-10-19 第 22 轮）。写板批准由服务端在真实 EDA 指纹上签发、一次性消费；本轮由代理按用户在会话中的显式授权指令代签，journal/证据如实记录。R2 首轮真机失败（读回 HTTP 500 + GUI 兜底菜单文案漂移）已作为失败证据留存并修复。

## 1. 为什么不是"AI 自由点鼠标"

GUI 通道（`runtime/eda-gui.mjs`）发的是受信任鼠标键盘事件，对 EDA 来说等价于真人在点。如果直接交给 AI 自由使用：

- 无法复核"点了但世界没变"（GUI 自动化的最大假阳性）；
- 可能点到删除工程、退出、支付等不可逆入口；
- 坐标/缩放/语言/版本一漂移就不可复现。

所以内核的设计是：**AI 只选配方、填参数、读诊断；点击发生在配方内部，且每一步都必须有读回证据。**

## 2. 目录与职责

| 文件 | 职责 |
|---|---|
| `runtime/automation/safety.mjs` | 动作分级（read/write/destructive/debug）、`eval` 默认禁用、危险文案/快捷键黑名单、EDA 目标锁定、批准作用域 |
| `runtime/automation/verify.mjs` | 断言求值：`equals/notEquals/atLeast/atMost/contains/matches/nonEmpty/truthy/falsy/in` + 跨路径比较 `equalsPath/atLeastPath/atMostPath`；路径缺失=失败；`unwrapReadback` 解桥信封 |
| `runtime/automation/journal.mjs` | 哈希链审计（JSONL，`hash = sha256(prevHash + core)`；篡改可定位） |
| `runtime/automation/approvals.mjs` | 服务端批准存储：签发/校验/一次性消费；绑定 `窗口+工程+文档` 指纹；TTL；签发与消费都进审计链 |
| `runtime/automation/recipes.mjs` | 配方 schema fail-closed 校验、参数声明与 `{$param}` 引用校验、注册表、7 条内置配方（4 只读 + R1/R2/R6）+ `RECIPE_CHANGELOG` 版本变更记录（E6） |
| `runtime/automation/runner.mjs` | 执行状态机：参数预检 → 批准预检 → 动作 → 读回断言 → API 失败时 GUI 兜底 → 失败策略（focus 重试/abort/rollback/needs_human） |
| `runtime/automation/executors.mjs` | api（bridge 69 命令）/ gui（CDP 15 动作）/ human（人工兜底）三通道适配 |
| `runtime/automation/automation.test.mjs` | 内核单测（22 条） |
| `runtime/__tests__/automation-http.test.mjs` | HTTP 契约测试（6 条，含批准/指纹/参数/路径穿越） |
| `src/pages/AutomationPage.tsx` | 自动化执行中心 UI（配方列表/参数/签发批准/运行/哈希链审计） |
| `scripts/automation-run.mjs` | 真机 CLI：跑一条配方、按需签发批准、打印读回与审计链；非 completed 退出码非 0 |

## 3. 关键契约

### 配方

```js
{
  id: 'pcb-rebuild-pours',                 // ^[a-z][a-z0-9-]{2,63}$
  title: '重建 PCB 铺铜填充（API 优先，铺铜管理器兜底）', version: 1,
  params: { projectUuid: { required: false, description: '...' } },  // 运行参数声明
  requiredApprovals: ['write'],
  steps: [{
    id: 'rebuild-pours',
    action: { kind: 'api', command: 'pcb.pour.rebuild', params: {}, allowWrite: true },
    expect: {
      readback: { kind: 'api', command: 'pcb.pours.read' },          // 或 {kind:'gui'} / {kind:'compose',reads:{...}}
      assertions: [{ path: '', op: 'nonEmpty', label: '铺铜图元非空' }],
    },
    fallback: { actions: [                                            // 主通道失败/读回不符时执行
      { kind: 'gui', action: 'focus' },
      { kind: 'gui', action: 'clickText', params: { text: '工具' } },
      { kind: 'gui', action: 'clickText', params: { text: '铺铜管理器', exact: false } },
      { kind: 'gui', action: 'clickText', params: { text: '重建所有', exact: false } },
      { kind: 'gui', action: 'clickText', params: { text: '确认', exact: false } },
    ] },
    onFail: { retries: 0, recover: ['focus'], then: 'abort' },        // abort | rollback | human
  }],
  rollback: [{ kind: 'api', command: 'document.source.restore', params: {} }], // then:'rollback' 时用
}
```

**校验规则（全部 fail-closed）**：

- 非人工步骤没有 `expect` 直接拒绝（没有读回证据等于假通过）；
- `eval` 不能写进配方（debug 动作不在 `SAFE_GUI_ACTIONS`）；
- 读回断言 op 白名单；`equalsPath/atLeastPath/atMostPath` 的 value 必须是另一条读回路径；
- `{$param:'name'}` 引用未声明的参数 → 整条配方拒绝；
- 写入动作（GUI 写动作或 `allowWrite:true` 的 API 动作）自动要求 `write` 批准；
- `fallback.actions` 只能 api/gui，且参数引用同样要已声明。

### 运行状态

| state | 含义 |
|---|---|
| `completed` | 所有步骤都有读回证据且断言通过 |
| `needs_params` | 缺必填参数/参数格式不符，**一步都没执行**，返回 `missingParams` |
| `needs_approval` | 缺人工批准，**一步都没执行**，返回 `missingApprovals` |
| `needs_human` | 人工步骤没有 human 执行器，或按策略交给人工 |
| `failed` | 动作失败 / 读回不符 / 断言失败（返回 `failedStep.failures`） |
| `rollback_failed` | 失败后回退也失败（必须人工介入） |

### 重试与兜底语义

- 动作报错 → 可重试（`recover:['focus']` 会先拉回 EDA 窗口再重放）；
- 读回不符 → **只重新读回，不重放动作**（点击/输入非幂等，重放可能翻页/删字/触发二次确认）；
- 主通道失败或读回不符 → 按 `fallback.actions` 顺序执行 GUI 兜底，再重新读回断言（journal 记录 `fallback.*`）；
- 只有 `verified` 才写 `step.verified`；否则按 `onFail.then` 走 abort/rollback/needs_human。

## 4. 人工批准（Phase 1 的关键安全件）

Phase 0 的 `approvals` 是调用方传布尔——等于自己给自己发许可证。Phase 1 改为**服务端签发的一次性批准**：

1. `POST /api/automation/approvals`：服务端在真实 EDA 会话上读取 `窗口 + 工程 + 文档` 生成指纹（`fingerprintOf`），签发 `approvalId`；
2. 批准记录 `scope`（plan/write/release）、目标 `recipeId`（null=任意配方）、`expiresAt`（默认 30 分钟）、`usedAt`；
3. `POST /api/automation/run` 传 `approvalIds`：服务端按 `requiredScopes` 校验范围、一次性、有效期、配方匹配、**当前指纹匹配**；全部满足才原子消费（先全查再全消费）；
4. 批准后换文档/换工程/换窗口 → 指纹不符 → 409 `AUTOMATION_APPROVAL_INVALID`（防止"批 A 板、写 B 板"）；
5. 签发与消费都写哈希链审计（`approval-<id>.jsonl`）。

## 5. 安全矩阵

| 风险 | 处置 |
|---|---|
| `eval` 任意 JS | 默认禁用；仅 `CIRCUITPILOT_GUI_DEBUG=1` 放开（调试用） |
| 危险入口（支付/下单/删除/退出/覆盖保存/另存为） | `clickText` 命中黑名单直接拒绝 `AUTOMATION_DANGEROUS_TEXT` |
| 危险快捷键（Cmd+Q / Cmd+W / Alt+F4） | `AUTOMATION_SHORTCUT_FORBIDDEN` |
| 操作错窗口/错页面 | `assertEdaTarget` 只允许 EDA 页面（url/title allowlist） |
| 未批准写入 | 参数预检 → 批准预检，缺批准 0 步执行 |
| 客户端自报批准 | 批准只由服务端签发，绑定真实 EDA 指纹；调用方不能传 `{write:true}` |
| 批准跨板复用 | 指纹（窗口+工程+文档）不匹配 → 409；一次性消费 |
| 没有回读证据 | 非人工步骤缺 `expect` → 配方校验失败 |
| 读回"假成功" | 每步必须读回+断言；失败策略不会写 `completed` |
| 审计被篡改/丢失 | 哈希链 + journal 写失败 → 整个 run fail-closed |
| runId 路径穿越 | 只允许 `^[A-Za-z0-9_-]{3,80}$` |

## 6. API 契约

### `GET /api/automation/recipes`

返回 `{ ok, schemaVersion, recipes: [{ id, title, version, summary, stepCount, requiredApprovals, params, steps[] }] }`。
不返回可执行体，只返回元信息（和规则包路由一致的做法）。

### `POST /api/automation/approvals`

```json
{ "scope": "write", "recipeId": "pcb-rebuild-pours", "note": "人工确认" }
```

- 返回 `{ ok, approval: { approvalId, scope, recipeId, fingerprint, issuedAt, expiresAt, target: { windowId, projectUuid, documentUuid } } }`；
- `scope` 非法 → 400 `AUTOMATION_APPROVAL_SCOPE_INVALID`；
- EDA 未连接/未选窗口 → 相应 503/409（拿不到指纹就不签发，避免盲批）。

### `GET /api/automation/approvals`

列出仍可用的批准（已用/过期自动剔除）。

### `POST /api/automation/run`

```json
{ "recipeId": "pcb-rebuild-pours", "params": {}, "approvalIds": ["<uuid>"] }
```

- 配方不存在 → 404 `AUTOMATION_RECIPE_NOT_FOUND`；
- 缺参数 → `run.state = needs_params`；缺批准 → `run.state = needs_approval`（HTTP 200，因为请求本身成功）；
- 传了 `approvalIds` 但校验失败（已用/过期/配方不符/指纹不符）→ 409 `AUTOMATION_APPROVAL_INVALID`，`details.missing` / `details.currentFingerprint` 说明原因；
- 读回不符 → `run.ok = false, run.state = failed`（**绝不假通过**）。

### `GET /api/automation/runs/:runId`

返回 `{ run: { runId, entries, chain: {ok, brokenAt, entries, lastHash}, journalPath } }`；
`runId` 非法（路径穿越）→ 400 `AUTOMATION_JOURNAL_RUN_ID_INVALID`；不存在 → 404。

### 前端

- `runtimeClient`：`automationRecipes()` / `issueAutomationApproval()` / `automationApprovals()` / `runAutomation({recipeId, params, approvalIds})` / `automationRun(runId)`；
- 页面：`#automation`（侧栏"自动化"）：配方列表、步骤与兜底标记、参数表单、签发批准、运行、失败原因、哈希链审计；
- DEMO 模式显式提示"只展示配方元信息，不能签发批准或执行"，不伪造数据。

## 7. 验证记录（本轮实测）

### 自动化测试

| 验证 | 结果 |
|---|---|
| `npm test`（typecheck + vitest 73 + runtime **482**） | 全绿 |
| `node --test runtime/automation/automation.test.mjs` | **22/22** |
| `node --test runtime/__tests__/automation-http.test.mjs` | **6/6**（含批准签发/消费/复用 409/指纹变化 409/参数缺失/路径穿越） |
| `npx playwright test e2e/app.spec.ts` | **28/28**（自动化页 DEMO 边界用例 + 交接回归；第 12 轮实测） |
| `npm run build` | 通过 |

### 真机（真实嘉立创EDA + Runtime 4199，CDP 9222）

证据文件：`artifacts/automation-phase1-smoke.json`、`artifacts/automation-runs/*.jsonl`、`artifacts/automation-page*.png`。

| 场景 | 结果 |
|---|---|
| `eda-read-state` / `eda-read-project` / `eda-read-document` / `eda-screenshot-evidence` | `completed`，策略 `primary`，哈希链 `chain.ok=true` |
| `pcb-sync-from-schematic`（R2）不带批准 | `needs_approval`，`steps:[]`（0 步执行） |
| `pcb-rebuild-pours`（R6）不带批准 | `needs_approval`，`steps:[]`（0 步执行） |
| R1 `eda-open-project`（真实工程 UUID）不带批准 | `needs_approval` |
| R1 带服务端签发的 write 批准 | **`completed`**：`project.open` → compose 读回（`project.current` + `document.current`）两条断言通过，链 `chain.ok=true` |
| **R2 `pcb-sync-from-schematic` 真机执行**（2026-10-19 第 22 轮，write 批准） | **`completed`**：7 条审计、哈希链完整；独立 `sync/verify` = schematic 180 / PCB 180 / missing 0 / extra 0 / ready true |
| R2 第一轮真机执行 | `failed`（未假通过）：importChanges 主通道返回后读回遇 `BRIDGE_HTTP_ERROR`，GUI 兜底文案 `更新/转换原理图到 PCB` 找不到；据此修了"读回只重读"与读回口径 |
| **R6 `pcb-rebuild-pours` 真机执行**（2026-10-19 第 22 轮，write 批准） | **`completed`**：7 条审计、哈希链完整；`pcb/context` 读回铺铜 2 个非空、器件 180、网络 92 |
| 批准绑定 PCB 文档 → 切到原理图页面后再执行写入 | **409 `AUTOMATION_APPROVAL_INVALID`**（指纹漂移，未执行任何写入） |
| 给 R6 签批准却拿去跑 R1 | **409 `AUTOMATION_APPROVAL_INVALID`**（配方不匹配） |
| 同一批准第二次使用 | **409 `AUTOMATION_APPROVAL_INVALID`**（一次性已消费） |
| UI（真实 Runtime）：加载 7 条配方、点 R6、签发写板批准 | 7 行配方；批准按钮可见；toast 显示"一次性有效，绑定当前 EDA 目标；到期 …" |

### 真机暴露并修复的 bug（重要）

桥的成功信封是 `{ success: true, result }`，而 `unwrapReadback` 只认 `{ ok: true, result }`。结果：`eda-read-project` 在真机上永远报"读回结果里没有路径 data"——**假失败**。修复：同时认 `ok`/`success`，并加回归测试。修复后 `eda-read-project`/`eda-read-document`/R1 真机全部 `completed`。

## 8. 已知限制与下一步

1. **R2/R6 真机写入已验收**（2026-10-19 第 22 轮，`completed`；证据 `artifacts/r2-r6-acceptance/`）。写板批准仍需人工授权：本轮由用户会话显式授权代理代签，服务端仍按真实指纹签发、一次性消费、30 分钟 TTL。剩余边界：R2 的 GUI 兜底菜单文案 `更新/转换原理图到 PCB` 在本机 EDA 3.2.186 找不到（E6 文案漂移），成功路径为 API 优先、不依赖兜底；R2 在本板执行前 designator diff 已为 0（`importChanges` no-op），本轮价值是通道真机跑通。
3. **R6 从"只有重建"补到"可新建"（第 23 轮，A11）**：新增配方 `pcb-create-pour` v1（参数 net/layer/outline/expectedPourCount；读回 `pcb.pours.detail` 断言数量与属性；创建动作绝不重放），底层桥命令 `pcb.pour.create` 修正为真机验证过的 `PCB_MathPolygon.createComplexPolygon([x0,y0,'L',…])` + `PCB_PrimitivePour.create(...)`，并新增 `pcb.pours.detail` / `pcb.pour.delete`。A10 同时修复 `routing/plan` 按网过滤被截断的 bug，真机完成"写 3 段铜→复核→读回→回滚复原"；前端 0 入口与保存/DRC 对比仍待接线。
3. **E6 文案漂移可诊断（第 23 轮）**：R2 升级到 v2 并写入 `RECIPE_CHANGELOG`（readback 改 `pcb.placement.read`、`readRetries` 只重读不重放、clickText 增加文案 alternatives）；GUI `clickText` 的 `params.alternatives` 会按顺序尝试已知菜单文案，**所有候选（含主文案）先过危险文案红线**，全失败时错误详情带 `attemptedTexts` 与"先能力探测/截图确认当前菜单"提示。未做的事不写成功：EDA 3.2.186 上 `更新/转换原理图到 PCB` 仍找不到，alternatives 只是候选，真机可用文案需截图确认后回填。
4. **需求硬约束与布局规则审计（第 23 轮，A1/A9）**：放行闸门新增 `constraints` 子门（confirmed+hard 需求→板框/电流/GPIO/接口/温度逐条比对，缺事实 unknown 阻断）；布局写回前新增 128 条规则审计（`runtime/placement-rules.mjs`），只把"量到违规"的硬门禁 FAIL 当阻断、证据不足保持 `evidenceGapFailures`，不符就 `PLACEMENT_RULES_BLOCKED` 拒写。两者的 UI 展示/真机证据仍是后续项。
2. R2 的配方读回口径是"PCB 器件数 ≥ 调用方只读传入的原理图器件数"（`expectedComponentCount`，因为 `schematic.*` 命令在 PCB 文档上下文真机必 500）；逐 designator diff 由独立 `GET /api/pcb/sync/verify` 复核（本轮 missing/extra = 0）。
3. R6 的读回是"铺铜图元非空"；正确性（网络/间距）仍要靠 DRC 门禁，而不是配方自证。
4. 批准存储是进程内内存：Runtime 重启后旧批准全部失效（有意的安全行为），代价是重启后要重新批。
5. 没有断点续跑；human 执行器还没有 UI 通道（DFM 上传/下单仍需人工）。
6. 默认 journal 目录 `~/.circuitpilot/automation-runs`；沙箱/受限环境用 `CIRCUITPILOT_AUTOMATION_DIR` 指到可写目录。
7. Phase 2/3/4（R3/R4/R5 接入、放行口径统一、持久化、无人值守演练）未开始。

## 9. 复现命令

```bash
npm test                 # typecheck + vitest + runtime（482）
npm run build
npx playwright test e2e/app.spec.ts

# 真机：起 Runtime
CIRCUITPILOT_RUNTIME_PORT=4199 CIRCUITPILOT_AUTOMATION_DIR="$PWD/artifacts/automation-runs" node runtime/server.mjs &

# 只读配方
node scripts/automation-run.mjs eda-read-state --base http://127.0.0.1:4199

# 写入配方：必须人工显式 --approve（服务端签发一次性批准，绑定当前窗口/工程/文档）
node scripts/automation-run.mjs eda-open-project \
  --param projectUuid=<工程UUID> --param projectText=<工程名> --param documentText=PCB1 \
  --approve --base http://127.0.0.1:4199

# 未批准必须 0 步执行
node scripts/automation-run.mjs pcb-rebuild-pours --base http://127.0.0.1:4199   # 退出码非 0，提示需要 --approve
```

## 9. 第 23 轮补充：仿真证据与验收落盘（A14）

- 新增 `POST /api/eda/schematic/simulation/run`：网表来源 = 请求 `netlistText` → EDA `schematic.simulation.netlist.export`；两者都没有时返回 `SIMULATION_NETLIST_REQUIRED`（409），**绝不把"没网表"写成"仿真通过"**。
- 证据只能由 `runSimulation()` 真实 spawn 求解器产出，并经 `verifySimulationEvidence()` 校验来源（必须 `solver-run`）、网表 sha256、产物哈希；不通过 → `SIMULATION_EVIDENCE_INVALID`，不落盘。
- 证据类型新增 `spice-simulation`（`runtime/evidence-store.mjs`），`GET /api/eda/schematic/simulation/latest` 读回；原理图验收路由会把 `designChecks`/全电路仿真结论一并落盘（`savedSimulation`）。
- `gateSimulation` 消费 `acceptance.designChecks`（真实求解器实测数值），放行闸门不是读一个"通过"标志。
- 真机（2026-10-19 第 23 轮）：本机 `ngspice-46` 可用；衣橱板 `/api/eda/schematic/acceptance` → `ready:true`，EDA 导不出 SPICE 网表（未绑定仿真模型）→ 设计检查点仿真：USB-C CC 下拉 Rd 实测 cc1=cc2=0.417V、vbus=5V pass，I2C 上拉 not-applicable；证据落盘 `artifacts/evidence/spice-simulation/spice-simulation-2026-10-19T12-21-41-529Z-17e98a65f717.json`（digest `17e98a65…`）。**边界**：设计检查点仿真 ≠ 全电路仿真；全电路需要原理图绑定 SPICE 模型。

## 11. 半写恢复（E8，回退动作可引用本 run 结果）

写动作最容易出错的不是"命令报错"，而是**命令已写入、读回却对不上**。执行器的约束：

1. 写动作只在动作报错时允许重试；读回不符时**只重读，绝不重放写动作**；
2. 步骤 `onFail.then='rollback'` 时，按 `recipe.rollback` **逆序**执行收敛动作；回退动作必须显式 `allowWrite:true`，并写进 journal 的 `rollback.step`；
3. 回退动作参数可用 `{$result:'stepId.path'}` 引用本 run 该步骤的动作结果（例如刚创建的图元 id），引用缺失/路径不存在 → `AUTOMATION_ROLLBACK_RESULT_MISSING`，回退失败则 run 状态是 `rollback_failed`，不是 `failed`；
4. 回退失败不会重试、不会假装成功，保留现场给人工。

`pcb-create-pour` v2 是参考实现：调用方先只读 `GET /api/eda/pcb/pours` 拿 `existingPourIds`，配方失败回退调用 `pcb.pour.deleteAdded` 做差集删除。真机演练脚本 `scripts/e8-halfwrite-injection.mjs` 用"故意读回失败"注入半写，验收要求：`failed` + `rollback.ok` + 覆铜 id 集合与运行前一致 + journal 有回退记录。

## 12. 第 25 轮：证据治理（C5/C8/B10）与放行绑定（B1/B4）

自动化跑完不是"结束"，证据要能被找得到、读得懂、留得对、不泄密：

- **C5 证据索引**（`runtime/evidence-index.mjs`）：`buildEvidenceIndex` 扫描证据目录，产出 `entries(kind/digest/savedAt/fingerprint/note/schemaVersion)` + `invalid`（坏文件带 code）+ `duplicates`（同 kind+digest 旧副本）+ `errors` + `complete`；坏文件/读失败**不隐藏**，`complete:false` 如实透出。`findEvidence` 按 kind/digest 定位；`planEvidenceRetention` 只生成 dry-run 计划（时间未知/未来/损坏一律保留，索引不完整 → `safeToApply:false`），模块**没有删除能力**。路由：`GET /api/evidence/index`、`GET /api/evidence/find`、`POST /api/evidence/retention/plan`。
- **C8 统一脱敏**（`runtime/log-redaction.mjs`）：`redactSecrets` 对敏感键整值替换、自由文本擦 Bearer/JWT/sk-/URL token/邮箱/本机路径；循环引用 `[Circular]`、超深/超长安全降级、异常类型不崩、输出可 JSON.stringify。`runtime/logger.mjs` 的 `redact` 已委托该模块，日志/诊断/失败上报共用一套规则（宁可多擦）。
- **B10 制造物保留**（`runtime/artifact-retention.mjs`）：`evaluateRetention`/`planRetention`/`applyRetention`；policy = kind 白名单 + maxAgeDays + maxTotalBytes；未知时间/未来时间/未知大小/非白名单 kind 一律保留；缺 policy = 关闭保留。`applyRetention` 默认 dry-run，必须显式 `dryRun:false` **且**注入 `remove()` 才真删，单点失败进 `failed` 不伪装成功。只暴露 `POST /api/artifacts/retention/plan`（扫 deliverables/release/manufacturing 白名单目录，仅计划），**不暴露 HTTP apply**。
- **B1/B4 放行绑定**（`runtime/release-binding.mjs`）：正式导出必须证明"签核的物料 = 本次导出的物料"。`/api/production/export` 用与 readiness 相同的 binding 重算当前 `artifactsDir` 的 manifestHash：有签核却没给 manifestHash → `RELEASE_MANIFEST_BINDING_REQUIRED`；给了但与重算不一致 → `RELEASE_MANIFEST_MISMATCH`（旧签核不能复用）；两者都 0 写盘。只有一致才把 `manifestHash` 放进 `buildReleaseDecision` 的 binding。UI 通过 sessionStorage 交接 `{manifestHash,binding}`，服务端重算值才是唯一可信值。

失败路径仍是 fail-closed：坏证据进 invalid、脱敏失败安全降级、保留拿不准就保留、绑定不成立就拒绝导出——没有一项以"看起来通过"收尾。

## 13. 第 27 轮：需求约束/选型回退/布局审计的界面闭环（A1/A2/A9/A10）

本轮的共同主题：**把"后端已经有的真实结论"接到人能看到、能操作的位置**，并补真机证据；没有新增任何"猜测型"能力。

- **A1 需求硬约束**：验证页把已确认需求自动带进 `releaseGate` / `productionExport` 的 `constraints`，并录入 6 项设计事实（板框/电流/GPIO/接口/温度）。空值不写字段 ⇒ 服务端按 `unknown` 阻断（不补 0、不填目标值）。闸门结果逐条展示 pass/fail/unknown/unclassified。同时修复 `/api/production/export` 漏传 constraints/designFacts 的不一致（两条放行路径会让同一块板得到不同结论）。
- **A2 选型回退**：抽 `searchLibraryWithFallback`（原始→去括号→去品牌→首段→去斜杠后缀，最多 5 级），新增只读路由 `/api/eda/library/search/fallback` 与验证页面板。真机检索验证：回退确实能救回 0 命中的中文参数查询（`扬声器 4欧 3W → 扬声器`），但关键词命中会出现无关器件——所以候选**只作证据**，身份必须人工确认，全空给 `NO_RESULT`。
- **A9 布局规则审计**：布局页显示 128 条规则里与布局几何相关的真实结论（硬门禁/证据缺口/警告/复查/通过/审计哈希），并明确"证据不足 ≠ 通过"。真机：只读审计 180 器件、板框 60×40mm、阻断 0、courtyard 证据缺口 1、`releaseReady=false`；故意出框计划在写入前被 `PLACEMENT_RULES_BLOCKED` 拒绝。
- **A10 多网络门禁**：真机已铺铜板（读回 1339 线/153 孔），两网络规划成功但独立复核发现盘中孔压焊盘（minGap -3.95mil），`routing/apply` 在写入循环前拒绝（`ROUTING_PLAN_REJECTED`）。整板自动布线仍不可完成：细间距器件必须盘中孔，需要库侧真实尺寸/工艺豁免或规则调整，属人工决策，不伪造。
- **证据卫生**：A10 两次铜计数快照间出现 +32 线/+13 孔的来源未查明，证据 README 如实记录"非本轮写入、未保存"，不宣称"板子绝对未变"。这也是 fail-closed 的一部分：**不知道就写不知道**。

## 14. 第 28 轮：诊断包与备份恢复演练（H5/H6）

- **H5 诊断包**：`runtime/diagnostic-bundle.mjs` 只做组装，不读磁盘不联网，输入由调用方注入（便于单测/HTTP 复用）。服务端 `GET /api/diagnostics/bundle` 收集本机诊断、证据索引、追溯计数、自动化 journal 摘要与最近错误；**整体过 `redactSecrets`**，每段有硬上限，缺数据写 `available:false + reason`，`bundleHash` 排除时间戳所以同一状态可复现。设置页按钮在浏览器侧下载，不落服务端文件。关键纪律：诊断包不是数据导出——不含工程文件内容，只含"定位失败所需的最小事实"。
- **H6 备份/恢复演练**：`scripts/backup-restore-drill.mjs` 对真实数据做备份→恢复→**用运行时加载器验证可继续**的闭环：state 目录（运行时状态文件）、evidence（证据 JSON）、automation-runs（journal JSONL）。每文件 sha256 入 manifest，恢复到临时目录后逐文件校验，再用 `createTraceStateStore().load()` / `buildEvidenceIndex()` / `summarizeJournalRuns()` 重开并与原始计数/哈希链比对。缺目录/缺段如实 SKIPPED 并写原因，绝不因为"备份命令 exit 0"就宣布恢复成功。已接入 `npm run acceptance` 的 `backup-drill` 必需步（`npm run drill:backup` 可单独跑）。
- 两者共同的 fail-closed 语义：**不知道就写不知道**——诊断包里没有就是 `available:false`，演练里没有就是 `SKIPPED`；不补空对象、不补 PASS。

## 15. 第 29 轮：跨进程单写锁（E7 续）

- `runtime/automation/run-lock.mjs` 增加**文件锁模式**（传 `file` 即启用），运行时默认锁文件为 `artifacts/state/automation-run.lock`。这样多开 runtime / 并行脚本共享同一状态目录时，仍只有一个自动化 run 能进入写阶段。
- 语义（fail-closed）：
  - 原子创建：`open(file,'wx')`，已存在即进入判旧流程；
  - 判旧：心跳超过 TTL **或** 同机持有 pid 已死（`process.kill(pid,0)`，EPERM 视为活着；跨主机不做 pid 猜测，交给 TTL）；
  - 接管：`rename(lock → claim)` 只有成功者获得接管权，随后写入自己的锁；接管事件以 `staleTakeover` 返回，不悄悄覆盖；
  - **锁文件损坏 → `EXECUTION_BUSY` + `unreadable` 原因，拒绝接管**（"看不懂就当有人在用"），需人工确认后清理；
  - 非持有者 `release`/`heartbeat` 一律拒绝，避免旧 run 误放新 run 的锁。
- 测试：`automation-run-lock.test.mjs` 9/9（进程内 5 + 文件锁 4）+ `run-lock-cross-process.test.mjs` 1/1（两个 runtime 实例共享状态目录：并发 run 一个 200 一个 409，释放后另一实例可执行）。
- 仍保留边界：无长任务中止接口；"重启后按 journal 自动恢复未完成 run"未产品化；跨主机不提供分布式互斥。

## 16. 第 29 轮续：只读路径性能基线（F7）

- `scripts/perf-baseline.mjs`：对运行时**只读**端点采样，产出基线表与回归告警。只测读路径是有意的——写路径的耗时被批准/读回/EDA 状态主导，单测环境里测出来的数字没有指导意义。
- 输出：`artifacts/f7-perf/perf-<时间>.json|md`，字段 min/p50/p95/max；自动与目录中上一份基线对比，`p95 > 2× 上一份` 且 `> 50ms` 才告警（避免小数值抖动误报），只告警不阻断。
- fail-closed：本机运行时不可达或没有令牌 → verdict `SKIPPED` 并写原因，**不产出假的耗时表**。
- 实测基线（本机，10 次采样）：health 0.61ms p50 / 1.83ms p95；approvals 0.24/0.5ms；trace-state 0.27/0.52ms；diagnostics 44.7/48ms；evidence-index 97.9/120ms；diagnostics-bundle 156/199ms。evidence-index 与 bundle 偏慢来自证据目录扫描（75MB），已作为后续优化线索。

## 17. 第 30 轮：无人值守故障注入演练（E4）

- `scripts/fault-drill.mjs`（`npm run drill:faults`，已接入 `npm run acceptance` 的 `fault-drill` 必需步）把"失败必须自停/留证据/不假通过"变成可执行断言，而不是文档承诺：
  - Part A（进程内真实装配运行时 + 故障 bridge）：EDA 断连 → run `failed`；桥接 500 → `failed`；写配方无批准 → `needs_approval` 且写命令 0 次；伪造批准 → 409 `AUTOMATION_APPROVAL_INVALID`；追溯存储损坏 → 400 `STORE_CORRUPT`；未知配方 → 404。
  - Part B（运行时可达时）：连跑 3 次真机只读配方 `eda-read-project`，全部 `completed` 且 journal 哈希链 `ok:true`；运行时不可达则如实 SKIPPED。
- 演练过程中发现并修复一个真实 bug：`/api/automation/run` 响应里的 `runId` 是 route 自己生成的，而 `runRecipe` 内部又随机生成另一个 runId 写 journal，导致"用接口返回的 runId 查审计"永远 404。修复：把 route 的 runId 显式传给 `runRecipe`，并在 `automation-http.test.mjs` 断言 `payload.runId === payload.run.runId` 且能按它查到 journal 链。
- 边界：GUI 弹窗/菜单文案漂移/人工步骤超时属于 GUI 长任务场景（E9/E6 另有证据）；真机写板仍需人工批准，不在无人值守演练范围。

## 18. 第 31 轮：长任务中止（E7 续）

- `POST /api/automation/runs/:runId/abort`：只对**正在执行**的 run 有效。服务端为每个 run 建一个 `AbortController`，`runRecipe` 接收 `signal`。不在执行中（已完成/失败/不存在）→ 409 `AUTOMATION_RUN_NOT_RUNNING`（带 hint），不会把"结束了的 run"伪装成可中止。
- 中止语义（fail-closed，写清楚边界）：
  - 生效点：每个步骤开始前（步骤边界）、主通道动作返回后但读回前、GUI 兜底动作序列每次之前；
  - 进行中的动作不会被硬杀：动作会跑完，但若中止已到且尚未读回，run 返回 `aborted` 并标记 `mayHaveTakenEffect: true`（写动作可能已落盘）——绝不说成"什么都没发生"；
  - 读回/验证不会被中途放弃成"通过"；中止状态是 `aborted`，不是 `completed`/`failed`；
  - 回退（rollback）不受中止影响：失败收敛优先，避免把半写状态丢下；
  - 无论中止还是异常，`activeRunControllers` 与文件单写锁都在 `finally` 释放，下一次 run 可正常执行（测试覆盖）。
- journal：`run.abort` 事件带 reason、stepId、completedSteps、mayHaveTakenEffect；UI 覆盖：自动化页运行中显示"中止运行"，前端先本地生成 runId 再发 run，保证按钮能在请求飞行中拿到 id。
- 测试：`automation-abort.test.mjs` 4/4；真机 route 对不存在 run 返回 409。剩余：重启后按 journal 自动重放未完成 run 仍未产品化。

## 19. 第 32 轮：重启后中断 run 的恢复（E7 收口）

- 新增 `runtime/automation/recovery.mjs`：
  - **终态判定**：`run.end / run.abort / run.paused / run.rollback / step.failed / run.recovered` 任一为最后一条即"已结束"；没有终态事件的 run 才进入恢复列表。
  - **风险判定**：若中断前发出过写动作（journal 里成功的 `attempt` 对应配方步骤 `allowWrite:true`，或跑过 `fallback.action`）→ `needs_human`；配方不在注册表 → `unknown_recipe`；全程只读 → `readonly_replayable`。坏文件显式列为 `corrupt`，不静默跳过。
  - journal 目录与批准账本共用：只分析首条为 `run.start` 且带 `recipeId` 的记录，`approval-*.jsonl` 不算 run。
- 路由：
  - `GET /api/automation/recovery`：只读扫描（`available/scanned/corrupt/runs`），不可用给 `available:false + reason`；
  - `POST /api/automation/runs/:runId/replay`：仅 `readonly_replayable` 允许；生成新 runId（`<原id>-replay-<ts>`）、先写 `recovery.start` 事件、跑完成功后给原 run 追加 `run.recovered`（终态，避免反复重放）；其它结论 409 `AUTOMATION_RECOVERY_NOT_SAFE` 并带 verdict/reason/analysis；单写锁同样保护重放。
- UI：自动化页「中断运行恢复」面板，扫描后按结论显示徽章；仅只读结论有「安全重放」按钮，其它结论明确写"需人工读回现场后再决定（不提供一键重放）"。
- 测试与真机：`automation-recovery.test.mjs` 3/3；真机 `scanned=200, corrupt=0, interrupted=0`（证据 `artifacts/e7-recovery/real-recovery-scan-20261020.json`）。
- 边界：恢复扫描只看文件名序（上限 200 个文件），跨主机仍不做分布式锁；写过的 run 绝不自动重放（这是安全策略，不是缺口）。

## 20. 第 33 轮：真机只读链路矩阵（F3）

- `scripts/live-chain-report.mjs`（`npm run report:live-chain`）把 R1–R8 从"验收报告里一句 SKIPPED"变成**逐项可执行、可诊断**的矩阵：
  - 执行段（只读）：R1 目标解析（`/api/eda/discover` + `/api/eda/windows`）、R4 PCB 铜几何（`/api/eda/pcb/routing/plan` 只读规划）、R6 覆铜快照（`/api/eda/pcb/pours`）、R5 DRC 最新证据（`/api/eda/pcb/drc/latest`，没有证据就 SKIPPED 写原因，不自动触发 DRC 改会话状态）；
  - 安全边界段：R2 落板、R3 布线写铜、R6-write 铺铜重建/新建、R8 导出/放行——只读报告**不执行**，逐条写"必须人工签发批准"；
  - R7 生产签核/DFM：只查 latest 证据，缺失则 SKIPPED 并说明需人工完成 DFM/签核；
  - 只读段失败 → 整体 FAIL / exit 1；跳过不算失败。
- 接入 acceptance：`--live` 时执行 `live-chain` 必需步，离线时 SKIPPED + 原因（不把"没跑"伪装成 PASS）。
- 真机实测：R1 PASS（selectionRequired=false, windowId dd8f03c1…）、R4 PASS（pads 602 / lines 1339 / vias 153）、R6 PASS（pours 2）、R5 PASS（digest f0b1ddb9…）、R7 SKIPPED；证据 `artifacts/f3-live-chain/live-chain-2026-10-20T03-52-00-642Z.md`。
- 边界：automation matrix（写阶段）与衣橱板验收仍依赖人工批准/真机 DRC，保持 SKIPPED；报告未接 CI 归档。

## 21. 第 34 轮：统一长任务控制器（D8）

- 问题：DRC/布线/导出各自手写"for 循环 + sleep + 取消按钮"，状态含义不一致，容易把"本页停止等待"说成"任务已取消"。
- 方案：`src/services/longTask.ts` 提供框架无关的 `createLongTask` 状态机：
  - 状态：`idle → running → done | failed | timeout | cancelled`；
  - `startTask()` 轮询（首次立即轮询，之后按 `pollIntervalMs`），`timeoutMs` 超时，`maxPolls` 兜底；
  - `cancelTask()` 调服务端 cancel（如 DRC 的 `pcbDrcCancel`）并让循环在下一检查点收尾；**取消/超时都只表示"本页停止等待"**，note 明确写"服务端任务可能仍在执行，以审计/报告为准"，不冒充失败/完成；
  - 重试 = 重新 `startTask()`（是否可恢复由任务本身决定，控制器不自动续跑）。
- UI：`LongTaskPanel` 纯展示状态、轮询次数、耗时、错误、说明与取消/重试按钮。`ValidationPage` 的 PCB DRC 已整体迁移到该控制器（进程内真实的 DRC 长任务）。
- 测试：`longTask.test.ts` 6/6（含虚拟时钟的 timeout/取消时序、启动失败后重试、启动完成前取消）；`longTaskPanel.test.tsx` 3/3（SSR 文案断言）。vitest 123→132。
- 边界：布线/导出/批处理等其它长任务尚未迁移；"可恢复"依赖任务自身语义（DRC 可重跑，写板类必须重新批准）。

## 22. 第 35 轮：原理图批量落件的 UI 入口（A6/E2-R3）

- 后端批量通道（`runtime/schematic-batch.mjs` + `POST /api/eda/schematic/component-batch`）此前只有模块/HTTP 测试，没有 UI 入口。本轮在元件选型页新增「原理图批量落件（A6/R3）」面板：
  - 输入落件项 JSON（每项必须 `component.libraryUuid` + `component.uuid` + 坐标；服务端拒绝猜身份）；
  - **先 dry-run**：只读比对当前原理图器件，展示 planHash / 新建与已存在计数 / 逐项动作 / `identityUnproven`；
  - 再点「签发写板批准并执行」：页面发起一次性 write 批准（服务端绑定窗口+工程+文档指纹），然后 `dryRun:false` 执行；逐件原子落进度、失败即停，同一 planHash 可续跑，重复执行按"身份+坐标"幂等跳过。
- 客户端新增 `schematicComponentBatchPlan/Apply` 与对应类型；页面冒烟测试断言入口与"dry-run 后才可执行"文案在场。
- 真机只读验证（2026-10-20）：真实库检索 `WS2812B` → dry-run **HTTP 200**，`planHash=c2be7fe0…`、`counts={total:1,create:1,skipExisting:0}`；不带批准执行 → **409 `AUTOMATION_APPROVAL_REQUIRED`**（写入一律需要人工批准）。证据 `artifacts/a6-batch/`。
- 边界：衣橱板整板 180 件的真机写入与中断续跑仍需用户在 UI 签发批准后执行；本项不代批、不预跑整板写入。

## 23. 第 36 轮：写步骤 before/after 截图证据（E11/E9）

- **真实缺陷修复**：配方里 `evidence: { screenshot: true }` 之前会被 `validateRecipe` 规范化丢弃，runner 永远读不到——等于"声明了取证但从未取证"。现在 evidence 校验后保留（未知字段/非布尔值直接拒绝），配方合同与执行一致。
- runner 对声明截图证据的步骤：
  - 动作发出**前**采集 `before`，journal 记 `step.evidence.before`；
  - 验证通过后采集 `after`，journal 记 `step.evidence.after`；
  - 只落 `sha256/bytes/kind/path`（**不落 base64**）；失败写 `ok:false+error`，未验证通过不产生 after（不伪造）。
- 截图通道降级下沉到 gui 执行器：CDP `Page.captureScreenshot` 超时 → macOS 仅 EDA 窗口截图（`kind=os-window-capture`、`fallbackFrom`）；两条通道都失败抛 `EDA_SCREENSHOT_UNAVAILABLE`。
- 真机证据：`eda-screenshot-evidence` completed，before/after `bytes=268725`、sha256 `6fafd1e9…`、`fallbackFrom=EDA_GUI_CDP_TIMEOUT`；journal 含两个 evidence 阶段。证据 `artifacts/e11-evidence/`。
- 测试：`automation-evidence-screenshots.test.mjs` 5/5（独立采集/journal 无 base64/失败不阻断/失败运行保留 before/配方字段校验/CDP 降级与双失败）。
- 边界：写步骤真机截图需要用户签发写板批准；录像未做；"操作人"以签发会话/审计链为准，无独立账号代签。

## 24. 第 37 轮：A5 位号标注的真机清零证据

- A5 的代码（`runtime/designator.mjs` 门禁、`schematic.component.designator.set` 桥命令、`POST /api/eda/schematic/designators/set` 写批准+保存+独立读回、含 `?` 计划拒绝）此前已落地；本轮补**真机只读校验证据**。
- 真机 `GET /api/pcb/sync/verify`：原理图 180 / PCB 180、`matched` 180、`unannotated=[]`、`ready=true`（designators 中 0 个 `?`）——位号差异真机清零，本项未触发任何写板动作。
- 证据：`artifacts/a5-designators/real-sync-verify-20261020.json` + `README.md`。
- 边界：当前工程已零 `?`；未来若出现 `C?`，标注写入仍需一次性写板批准，且写后要跑 sync diff 复核。

## 25. 第 38 轮：多项目隔离与 EDA 窗口绑定校验（C6）

- 问题：前端只有一个 activeProject 工作集，runtime 也没有项目级数据分片；多项目并行时容易"在 A 项目的页面里对 B 项目的板子签发批准"。
- Runtime：
  - `sliceProjectState`（读）/`normalizeProjectSlice`（写）：项目级切面。给了 `projectId` 的实体按项目过滤；未打标的旧数据只在"它就是当前 active 项目"时归属，否则不放进任何切片。写入时强制打标，实体属于别的项目 → 400 `PROJECT_STATE_INVALID`（不静默改归属）。
  - `createProjectScopedStore`：每项目一个 JSON 文件（`project-states/<id>.json`），原子写；文件缺失时从聚合状态迁移出只读切片（`legacy-migration`），首次写入才落文件。
  - 路由：`GET /api/projects`、`GET/PUT /api/projects/:id/state`、`GET /api/projects/:id/binding/verify`（比对项目 `edaWorkspace` 与窗口真实 projectUuid/pcbUuid/schematicPageUuid，逐条列 mismatches；未绑定项目不触碰 EDA 会话）。
- 前端：AppContext 先加载聚合拿项目列表、再加载当前项目切面；切换项目先把上一项目写回再加载新项目切面；仅在"内存工作集来自该项目切面"时写项目文件（防止防抖窗口把 A 数据写进 B）。ProjectsPage 详情新增绑定校验面板与"不一致不要签发写板批准"提示。
- 测试与证据：`project-isolation.test.mjs` 3/3；真实运行时 fail-closed（非法 id 400 / 未知项目 404 / 未绑定校验 404 / 错误 activeProjectId 400）证据 `artifacts/c6-isolation/`。
- 边界：真实 GUI 两项目切换点击验收待用户会话；项目文件是逻辑隔离不是磁盘权限边界；绑定校验"一致"需项目已绑定同一 EDA 工程。

## 26. 第 39 轮：统一证据时间线（C3）

- 问题：执行 journal、批准账本、DRC/DFM/导出证据分散在三个目录/页面，"一次运行发生了什么"要人工拼；`/api/events` 只是进程内存日志。
- `runtime/timeline.mjs`：`buildTimeline({journalDir, evidenceDir, approvalsFile, runId, limit})` 合并三类事实并倒序：
  - run：`<journalDir>/<runId>.jsonl`（排除 `approval-*.jsonl`；用 hash 作 digest）；
  - approval：统一批准账本 `data.entries`（entryHash 作 digest）；
  - evidence：`evidence-index` 索引（路径/note/前 4KB 关联 runId）。
  - fail-closed：来源缺失写 `available:false + reason`；坏 JSON/坏证据进 `invalid` 且 `complete=false`；`limit` 截断 `truncated=true`；时间未知排最后。
- 路由 `GET /api/timeline`；前端追溯页「系统事件」新增面板（runId 过滤/计数/来源/坏行/条目）。
- 真机：total=869（run 333 / approval 500 / evidence 36），complete=true，invalid=0，runId 过滤 allMatch=true；证据 `artifacts/c3-timeline/`。
- 边界：只读汇总视图，权威仍是 journal/批准账本哈希链与证据文件；evidence↔run 关联是启发式，签核/导出尚未强制打 runId。

## 27. 第 40 轮：信息架构单一事实源（D6）

- 问题：导航项写在 `Shell.tsx`、路由别名写在 `App.tsx`、页面职责散在页面内，旧页面（`AiTasksPage` 等）长期"能进但没人维护职责"。
- `src/navigation.ts`：纯数据单一事实源——`NAV_ITEMS`（6 项主导航）、`PAGE_RESPONSIBILITIES`（13 个 PageId 的标题/描述/回答的问题/主操作/交接）、`LEGACY_ALIASES`（旧 hash → 规范页面）、`GUIDED_FLOW`（7 步新手链路，对齐 `STAGE_ORDER`）、`CANONICAL_PAGES`（导航 6 + 设置 + 项目页）。
- 接入：Shell 导航/页面说明、App 路由别名与页签解析、`navigate(page, tab?)` 统一 hash 路由；概览页渲染「从零到交付的完整链路」面板。
- 旧入口归并：`requirements→design/req`、`assets→design/assets`、`proposal→design/select`、`ai→design/chat`、`placement→validation/placement`；`projects` 升为规范页面。
- 测试：`navigation.test.ts` 4/4 守护职责全覆盖/导航唯一/别名不悬空不指回自己/链路顺序与阶段机一致；e2e 30/30。
- 边界：链路面板只是导航引导，不自动推进阶段；阶段推进仍由 D5 阶段机证据门禁决定。

## 28. 第 41 轮：阶段证据推进收敛（D5）

- 问题：`EdaPage` 执行成功后直接写 `project.stage='原理图'`，绕过 D5 阶段机门禁；`deriveStageEvidence` 埋在项目页里，执行/验证事件无法复用同一套证据规则。
- `src/services/stageEvidence.ts`（唯一实现）：
  - `deriveStageEvidence(state, project)`：需求/BOM/网表/原理图/布局/DRC 六项 fail-closed 推导——网表认人工批准任务或 Runtime 执行 id；原理图需 `schematicStatus=generated` **且**有执行时间；`pcbPlaced` 需布局写回时间 **且**批准 id 同时存在；DRC 只认 `source=official`；非当前项目不借用当前工作集证据。
  - `applyEvidencePatch(project, patch)`：执行/回读成功后把证据写回 `edaWorkspace`（不可变）。
  - `tryAdvanceProjectStage(state, updatedProject)`：证据更新后只允许相邻正向推进；缺证据返回中文阻断项，绝不跳级。
- 接入：`EdaPage` 原理图执行成功 → 记录执行证据 + 审计，再按门禁决定是否推进；`PlacementPage` R4 写回成功且 A9 `verified.ok` → 记录 pcbPlaced 证据 + 门禁推进；`ProjectsPage` 改用共享推导。
- 测试：`stageEvidence.test.ts` 5/5；vitest 141/141；build 通过。
- 边界：`ProjectStage` 类型仍是旧 5 值 + 8 阶段兼容桥；R5 布线/R6 铺铜是否计入"布局完成"待产品定义；UI 证据只是预检，权威仍是 Runtime 执行记录/批准账本/官方 DRC。

## 29. 第 42 轮：单调用长任务与生产导出接入（D8）

- 问题：生产导出是一次 240s 的长 HTTP 调用，没有服务端 job 可轮询，页面只有"导出中"文案——不能取消、超时/失败/停止等待混在一起。
- `src/services/longTask.ts` 新增 `createSingleCallTask`：`call(signal)` 一次可中断调用，复用统一状态机（idle/running/done/failed/timeout/cancelled）。取消 = abort 本页请求；措辞纪律：cancelled/timeout 都写"服务端任务可能仍在执行或已落盘，以审计与产物目录为准"，不冒充 failed/已终止。
- `runtimeClient.request` 增加外部 `AbortSignal`：用户取消 → `REQUEST_ABORTED`，本页超时 → `RUNTIME_TIMEOUT`（两者分开报）；`productionExport(..., { signal })` 可中断。
- `ValidationPage.runExport` 迁移：`createSingleCallTask` + `LongTaskPanel`（停止等待导出/重试/耗时/状态）；失败仍走 `reportIssue` 与审计，取消/超时只写"已停止等待"审计，不写失败。
- 测试：`longTask.test.ts` 10/10（含成功/取消 abort/超时不算 failed/失败后重试）；vitest 145/145；build 通过。
- 边界：批量落件（服务端一次调用）、布线 dry-run/apply 等长调用尚未逐个迁移；"恢复"仍依赖任务自身（导出可重试，写板需重新批准）。

## 30. 第 43 轮：写步骤安全审计包（E11）

- 问题：写步骤有 journal 链和 before/after 截图，但没有"把一次运行的写证据收成可核对包"的入口；批准只记 boolean，事后无法对上"哪个批准放行了这次写"。
- `runRecipe` 新增 `approvalIds`/`approvalFingerprint` 参数，`run.start.approvals` 记录批准 id 与签发时目标指纹（批准 id 非令牌原文，可安全落链）。
- `runtime/automation/audit-bundle.mjs` + `GET /api/automation/runs/:runId/audit-bundle`：
  - chain：哈希链校验，断/被改 → `ok:false + brokenAt`；
  - steps：before/after 截图摘要（sha256/bytes/kind/path/fallbackFrom/error）+ attempts + readback stateDigest + verified/failed；
  - approvals：required/granted、approvalIds、operatorBinding（本地会话+目标指纹，明确"无独立第三方签名"）；
  - warnings：写步骤缺 before/after、缺成功读回、base64 泄漏、截图失败、链断；`summary.evidenceComplete`。
- 前端：自动化中心「写步骤审计包（E11）」按钮/面板（链状态、证据齐备、批准 id/指纹、warnings、写步骤证据表）。
- 真机：真实历史写 run 的 bundle 如实列出"缺 before/after/读回"warnings（不把没截图当通过）、只读 run 链完整、未知 run 404；证据 `artifacts/e11-audit-bundle/`；测试 4/4。
- 边界：无独立账号签名；截图是屏幕旁证不是 EDA 内部状态证明（状态以读回摘要/官方 DRC 为准）；录像未做。

## 31. 第 44 轮：目标编排与失败恢复决策（E10）

- 问题：Phase 0/1 只有"选配方/填参数"，没有"目标 → 多步序列"和"失败后走哪条恢复路径"的可解释决策层。
- `runtime/automation/orchestration.mjs`：
  - `planOrchestration`：目标关键词 → 预定义 profile（netlist-to-drc / pour-rebuild / pour-create / read-only-evidence）→ 配方节点 + 显式 gate 节点（DRC/人审），每节点 `stage/dependsOn/approvalRequired/expectedEvidence/reason`；`planId` 可复算；`decisionLog` 记录 profile 命中/预算检查/批准政策。
  - 预算控件：配方数/写配方数/预计秒数；token 预算显式 `not-accounted`（无可信计量，不假装有）。
  - fail-closed：目标无法映射 → `E10_GOAL_UNSUPPORTED`（supported 列表）；预算超限/配方缺失 → `ok:false + blockers`；非法 budget → `E10_BUDGET_INVALID`。
  - `decideFailureRecovery`：暂时性错误只在只读阶段重试；批准/指纹类 → 重批准；写阶段任何失败 → `needs_human_inspection` + 禁自动重放；gate → 人工；未知 → 人工；>2 次升级。
- 路由：`GET /api/automation/orchestration/goals`、`POST .../plan`、`POST .../failure`（只出计划/建议，不执行 EDA 动作）。
- 前端：自动化中心「目标编排与失败恢复（E10）」面板。
- 真机：`artifacts/e10-orchestration/real-plans-20261020.json`（6 节点计划/预算阻断/422/三种恢复决策）；测试 5/5。
- 边界：只出计划不自动执行、不代批准；4 个 profile；参数推断未做；DRC/导出/签核是 gate。

## 32. 第 45 轮：覆盖率地板、打包冒烟、长跑采样（F6/H3/H4）

- F6：`scripts/coverage-gate.mjs` 跑完整 runtime 测试集 + Node 内置覆盖率，只对 5 个关键模块（orchestration/audit-bundle/timeline/project-state/evidence-index）设 lines/branches/funcs 地板（实测值向下取整、只许升）；缺失或回退 exit 1，报告落 `artifacts/f6-coverage/`；接入 acceptance `coverage` 必需步。边界：不假装全仓 70%。
- H3：`scripts/package-smoke.mjs` 校验 package.json / tauri.conf / runtime/version 三方版本一致 → staged sidecar 可执行且版本一致 → 用 staged sidecar 启动 runtime 后 health 正确；接入 acceptance `package-smoke`。边界：不做 codesign/notarize/.app/.dmg（发布流程），无 Rust 时 SKIPPED 不冒充 PASS。
- H4：`scripts/long-run-memory.mjs` 隔离 runtime + 周期 RSS/health/只读流量采样，输出首/末/峰值/增长/错误/warnings 与"短窗 ≠ 24h"边界；`--hours 24` 可复现，短窗冒烟接入 acceptance。

## 33. 第 46 轮：放行证据闭环、不可变发布、外发告知、版本适配、对话框可达性（A16/B8/G4/G5/D9）

- A16：`gateEngineering` 纳入 `gateFabricationRelease`。缺省（未提供 `engineering`）→ 门禁 `skipped` + info 记录，不阻断也不冒充通过（既有调用方行为不变）；提供时 blocking → `ENGINEERING_BLOCKED` 阻断、warning → `ENGINEERING_WARNING`、`layoutAudit` 失败 → `LAYOUT_RULES_BLOCKED`；例外必须 `code+reason`，未使用例外给警告。三个放行/导出/归档路由透传。
- B8：`runtime/release-archive.mjs`。归档只接受**服务端重算**的 `gate.ready && releaseDecision.ready`（重跑取证/门禁/DFM+签核裁决），否则 409 带 blockers/blockedBy；记录绑定 plan/compiled/manifest/reviewHash/pcbUuid/门禁+裁决指纹 + 证据文件逐个 sha256+bytes；`wx` 写入、模块无 update/delete；读取重校验，篡改/缺失 → verified:false + problems。前端放行区归档按钮 + 追溯页只读列表。
- G4：`runtime/provider-egress.mjs`。4 个现有外发调用点（chat/plan/netlist/part proposal）的触发与字段、明确不发项；`consentMode:'per-action'`（无后台批量上传）；预览复用 `redactSecrets`，只展示不发送。边界：人工维护清单、脱敏非语义审查、附件原样发送。
- G5：`runtime/eda-adaptation.mjs`。版本来源如实标注（user/capability-matrix/unknown），与真机基线 3.2.186 比对输出 tested/patch-drift/untested/unknown；`eda.api.describe` 核对关键图元 API，缺项写进 degradations；内置 3 个已知坑与降级路径（CDP 截图超时→窗口截图、importChanges 静默无效→禁用、EDA 文件系统不可用→运行时写盘）；EdaPage 告警。边界：版本号无稳定自动查询命令，不伪造自动检测。
- D9：Modal/Drawer 统一焦点管理（打开移入、Tab/Shift+Tab 循环、Escape 关闭、关闭归还焦点），jsdom 真实 DOM 测试 3 条；全站 a11y 审计仍未做完，不声称 WCAG 合规。

## 34. 第 47 轮：批量落件长任务接入、全站静态 a11y 审计、面板交互单测（D8/F5/D9）

- D8：`PartProposalPage.applyBatch` 从"busy 布尔 + 一个 await"迁到 `createSingleCallTask` + `LongTaskPanel`。批量落件是服务端一次长调用且**真实写入原理图**，所以：取消只 abort 本页请求并明示"服务端可能仍在写/已落盘，以审计与产物目录为准"；超时与取消分开报；重试=重新执行（同一 planHash 由服务端保证幂等/续跑）；`schematicComponentBatchApply` 新增可选 `{signal}`（request 已支持外部 AbortSignal）。剩余：布线 dry-run/apply 等长任务未逐个迁移。
- F5：新增 `longTaskPanel-interaction.test.tsx` 5/5，用 jsdom 真实点击补足长任务面板的取消/重试/终态措辞断言（此前只有 SSR 文案）；页面级事件单测仍缺。
- D9：新增 `scripts/a11y-audit.mjs`（接入 acceptance `a11y-audit` 步）：只查 JSX 源码可确定性判定的问题（图标按钮可访问名、img alt、可点击 div role/tabIndex、input label/aria、正数 tabIndex、无 href 锚点），报告 `artifacts/d9-a11y/a11y-audit-*.{json,md}`。实测 30 个 tsx：violations 0、warnings 86（主要为 Field 包装的 input 需人工复核）。边界：静态正则启发式 ≠ WCAG 认证；不查运行时 DOM/对比度/屏幕阅读器；违规仍 advisory exit 0，不假装构建门禁。

## 35. 第 48 轮：引脚先行两阶段计划与 assumption 结构化（A4）

- 顺序约束：PCB 焊盘证据只能来自已真实落板的器件（R2 写通道，需一次性写板批准）。所以把"先落器件→读引脚→审计→生成网表"做成**计划层**：`planPinFirstNetlistFlow` 输出 4 个阶段（pcb-placement / pin-evidence / pin-audit / netlist-ai），每阶段带 dependsOn、requiresApproval、expectedEvidence；缺落板记录/缺证据/审计不过/assumption 未标注 → `executable:false` + 明确 blockers，`autoExecute:false`（只出计划，不执行、不代批准）。
- assumption 结构化：`netlist-assumptions.mjs` 把字符串归一为 `{text, direction, source, needsReview}`，方向只按关键词（power/ground/signal/no-connect），未知保持 unknown 不硬猜；`/api/design/netlist/ai` 返回 `assumptionAudit`，`strictAssumptions:true` 时未标注方向 409 `NETLIST_ASSUMPTION_UNMARKED`。
- 路由 `POST /api/automation/flows/pin-first-netlist`；验证页 A4 面板「生成两阶段计划」展示阶段/依赖/批准要求/阻断原因，并明示不自动执行。

## 36. 第 49 轮：问题中心记录落 Runtime（C1 收口）

- 缺口：项目/需求/器件、追溯三件套、证据/批准账本、聊天 transcript 都已落 Runtime，但 **issues（问题中心）仍只在浏览器 localStorage**——换机器/清缓存后"问题处理历史"就没了，C1 不成立。
- `runtime/issue-state.mjs` + `GET/PUT /api/issue-state`：原子写 `issue-state.json`（schemaVersion=1）；fail-closed 校验（非对象/issues 非数组/条目非对象/缺 id/id 重复 → `ISSUE_STATE_INVALID` 400，不静默修正）；上限 300 条（与前端 reducer 一致）超出如实截断并回报。
- `AppContext`：Runtime 可达时读回 issues（服务端为空不覆盖本地），变化后防抖 1s 写回；失败只 warning、本地缓存保留，不阻塞操作。
- 测试 `issue-state.test.mjs` 3/3（校验/截断、原子落盘+重开读回、HTTP 往返与 400）；runtime 746/746。

## 37. 第 50 轮：布线规划/写入接入统一长任务控制器（D8）

- `RoutingWritePanel` 的规划（只读 300s）与真实写入（300s）原本是 busy 布尔 + 裸 await：无超时分类、无法停止等待、失败与取消措辞混在一起。现迁到 `createSingleCallTask` + `LongTaskPanel`：状态机 running/done/failed/timeout/cancelled 统一，取消=abort 本页请求并明确"服务端可能仍在执行/已写铜，以审计与铜读回为准"，重试=重新执行（写入仍重新签发一次性批准并重新走门禁）。
- `runtimeClient.routingPlan/routingApply` 新增可选 `{signal}`，把外部 AbortSignal 传到 request（abort→REQUEST_ABORTED，与超时区分）。
- 剩余：R2 写板执行（`/api/pcb/execute` 180s）、AI 计划生成、原理图修复/验收等长调用仍是 busy 布尔，按写板确认流程优先后续迁移。

## 38. 第 51 轮：R2 布局写回接入统一长任务控制器（D8）

- `PlacementPage.apply`（R2 写回：逐器件写坐标并逐项回读，110s 级）原来 busy 布尔 + 裸 await：确认弹窗后无法停止等待、超时/失败/取消不可区分。现改 `createSingleCallTask` + `LongTaskPanel`：确认后启动任务；运行中「停止等待写回」= abort 本页请求并明确"可能已部分写入，以审计与回读为准"；failed/timeout/cancelled 分状态；重试=重新确认并**重新签发一次性 write 批准**（批准不被复用）。
- `applyPlacement` 新增可选 `{signal}`；写回证据（pcbPlacementExecutedAt/ApprovalId）只在 done 且复核通过后由真实消费的 approvalId 写入，绝不伪造。
- 剩余：`restore`、AI 计划生成、原理图修复/验收等长调用仍 busy 布尔，后续迁移。

## 39. 第 52 轮：还原与 AI 计划生成接入统一长任务控制器（D8）

- `PlacementPage.restore`（R4 还原到原位置，写路径）迁到 `createSingleCallTask` + `LongTaskPanel`：停止等待=abort 本页请求并提示"可能部分写入，以审计/回读为准"；重试重新签发一次性 write 批准。
- `AiTasksPage.generateProductionPlan`（AI 语义计划，180s）迁到同一控制器：停止等待只停本页等待，模型可能仍在服务端生成；failed/timeout/cancelled 分状态，重试重新生成（新计划 planHash 仍会使旧批准失效，不静默复用）。
- 剩余：原理图修复（240s）、原理图验收（300s）、放行门禁（180s）等长调用仍 busy 布尔，按使用频率后续迁移。

## 40. 第 53 轮：原理图验收/修复/放行门禁迁移，D8 长调用收口

- `ValidationPage` 三个 180–300s 长调用（原理图验收、原理图自动修复 dry/apply、下单前放行门禁）从 busy 布尔 + 裸 await 迁到 `createSingleCallTask` + `LongTaskPanel`：停止等待=abort 本页请求并区分"验收/闸门只停本页等待"与"修复可能已部分写入"；failed/timeout/cancelled 分状态；重试重新执行（修复仍按 dry/apply 各自语义，不跳过确认）。
- 三个 client 方法新增可选 `{signal}`。
- D8 结论：所有 ≥110s 的 UI 长调用入口（DRC 轮询、生产导出、批量落件、布线规划/写入、R2 写回、R4 还原、AI 计划、原理图验收/修复、放行门禁）均已统一使用 `createLongTask`/`createSingleCallTask` + `LongTaskPanel`；不再有裸 await + busy 布尔的长任务。

## 41. 第 54 轮：F5 页面级真实点击单测

- 此前 F5 只有 SSR 冒烟（渲染文案在场）和 Playwright e2e；没有"页面内真实点击 → 用户可见结果"的单测。
- 新增 `src/pages/__tests__/pages-interaction.test.tsx` 2/2：jsdom + 假 fetch（只 mock HTTP 响应，不 mock 页面/控制器逻辑），`createRoot` 挂载 `AppProvider`：
  - SettingsPage G4：真实点击「读取外发清单」→ 断言渲染 `chat.turn` 契约、`notSent`、策略版本；
  - ValidationPage A4：真实点击「生成两阶段计划」→ 断言渲染服务端 fail-closed 阻断 `PIN_FLOW_PCB_NOT_PLACED`、4 阶段表与"本页只生成计划"边界。
- 边界：不是 RTL 全量覆盖，布局写回确认流、自动化中止/恢复等仍由 e2e 30 条覆盖；后续按页面逐步补。

## 42. 第 55 轮：E10.2 配方参数推断（证据驱动、缺证据阻断）

- 此前 E10 编排节点的 `params` 恒为空对象——计划看起来可执行，实际运行时还得人工猜 `expectedComponentCount`/`existingPourIds`/`outline`，猜错会写错板。
- `runtime/automation/params-inference.mjs`：确定性推断，值只来自只读证据或显式默认值——`pcb-create-pour`（现有铺铜数+1、现有 ids、板框顶点、GND 网络/调用方指定、层默认顶层并注明）、`pcb-sync-from-schematic`（原理图器件数、可选 UUID）、`pcb-rebuild-pours`（无必填）；证据不足 → `ok:false + missing + E10_PARAMS_EVIDENCE_MISSING`，不给"大概值"。
- 编排：`POST /api/automation/orchestration/plan` 接受只读 `evidence`；节点带 `params` + `paramsInference`；未给证据显式 `not-provided`；给了但不全 → 计划阻断。UI 表格新增「参数推断」列。测试 `params-inference.test.mjs` 4/4，runtime 750/750。

## 43. 第 56 轮：C3 证据↔run 显式关联、C4 环境漂移核对

- C3 剩余：签核/导出证据没有 runId 字段，时间线只能靠路径/note/内容启发式猜 evidence↔run。新增 `runtime/timeline-links.mjs`（append-only JSONL，形状校验、坏行进 invalid）+ `POST /api/timeline/link`：存在性校验（run 不在 journal 404、digest 不在证据索引 404、重复 409），时间线按 digest 精确标注 `runId + linkedBy:'explicit'`，runId 过滤可命中；追溯页时间线面板新增 digest 输入与「关联到该运行」。未登记关联的证据仍走原启发式，不伪造。
- C4 核对：`boundEnv`（批准时绑定 EDA 指纹/运行时版本）+ `CHECK_ENV_DRIFT`（变化即自动标废并记原因）已实现并有测试；本轮只做文档收口，无代码改动。
- 测试：`timeline-links.test.mjs` 3/3；runtime 753/753。

## 44. 第 57 轮：C6 真实 GUI 两项目切换验收

- 此前 C6 剩余项：只能验证 fail-closed 分支（Runtime 业务状态为空、无绑定项目），真实 GUI 双项目来回切换未验收。
- `e2e/c6-project-switch.spec.ts`：不 mock Runtime——spec 自起真实 `runtime/server.mjs`（端口 4178、临时状态/证据/自动化/发布目录），经真实 API `PUT /api/project-state` + `PUT /api/projects/:id/state` 种两个项目（各一条需求、两份互斥切面）；Playwright 在真实界面点「设为当前」甲→乙→甲，断言需求工作集只显示当前项目；最后用 API 读回两份切面，断言各自只含自己项目/需求，无交叉写入。已接入 `npm run acceptance` 的 `c6-project-switch` 必需步骤。
- 边界：不验证 EDA 窗口↔项目绑定 fingerprint（需真机 EDA），该分支由 `/api/projects/:id/binding/verify` 运行时测试与 fail-closed 路径覆盖。

## 45. 第 58 轮：F7 180 器件 UI 渲染基线

- 此前 F7 只覆盖运行时只读路由（health/approvals/evidence-index/diagnostics），UI 渲染未测；真机 EDA 读取/布局/DRC 仍受限。
- `e2e/f7-ui-render.spec.ts`：自起真实 Runtime（4178、临时状态目录），经真实 API 写入 180 器件工程；真实浏览器对 assets（资料与 BOM）、requirements、validation 三页各 3 次采样取中位；切 BOM 清单页签断言真实渲染 180 行；结果写 `artifacts/f7-perf/ui-render-*.json` 并覆盖 `ui-render-baseline.json`，下次运行对同页做 2× 回归告警（不阻断）。acceptance 新增 `f7-ui-render` 必需步骤。
- 实测：UI 中位 8–15ms、行数 180/180、告警 0。边界：不含真机 EDA 读取/布局/DRC 耗时，不冒充 EDA 性能已验证。

## 46. 第 59 轮：D8 候选提案长调用接入统一控制器

- 上一轮核对发现 D8 仍有一处 180s 级 UI 长调用未接统一控制器：`PartProposalPage` 的「生成候选提案」（`/api/library/proposals`，客户端超时 180s，此前 busy 布尔、无取消/超时/重试）。
- 迁移到 `createSingleCallTask` + `LongTaskPanel`：标题「候选提案长任务」，取消只停止本页等待（服务端可能仍在检索），失败/超时/取消分状态，重试=重新生成；`runtimeClient.partProposal` 新增可选 `AbortSignal`。
- 测试：`pages-interaction.test.tsx` 第 3 例真实点击→假 HTTP→渲染候选 + 断言面板与措辞，vitest 156/156。
- 剩余：EDA 页 R1/R2「受控执行」（`executeDesign` 150s / `executePcb` 180s）仍 busy 布尔，下一轮迁移。

## 47. 第 60 轮：EDA 页执行/AI 网络表接入统一长任务 + D8 长调用棘轮

- 迁移：EDA 页 R1「AI 生成网络表」（`pinEvidence` 120s + `generateReviewedNetlist` 150s）与 R1/R2「受控执行」（`executeDesign` 150s / `executePcb` 180s）改用 `createSingleCallTask` + `LongTaskPanel`：取消只停止本页等待（写路径明确"可能已部分生效"）、失败/超时/取消分状态、重试重新执行；四个客户端方法新增 `AbortSignal`。
- 棘轮：`runtime/__tests__/long-call-signal.test.mjs` 扫描客户端所有 ≥110s 调用，未传 `AbortSignal` 者必须在白名单并写原因，白名单只减不增。
- 诚实边界：D8 仍有明确剩余（`sendChat`/`routingRollback`/`archiveRelease`/`guiCapabilityProbe`/`replayAutomationRun`/`schematicComponentBatchPlan`/`ercRun`/`pcb3dExport`/`productionRelease`/`generateDesignPlan`；`runAutomation` 走服务端 abort 接口）。不再声称"全部关闭"。

（补充：棘轮测试放在 `runtime/__tests__/long-call-signal.test.mjs`——它读源码文本，属于工具链校验；vitest 侧无法直接引用 node:fs 类型。）

## 48. 第 61 轮：自动化/验证页长调用迁移，D8 白名单 11→6

- 迁移：`AutomationPage`「GUI 兜底能力探测」（120s×2 种窗口尺寸）与「安全重放中断 run」（600s）、`ValidationPage`「ERC 取证」（120s）、「3D 导出」（320s）、「发布归档」（120s）改用 `createSingleCallTask` + `LongTaskPanel`：取消只停本页等待、失败/超时/取消分状态、可重试处提供重试；五个客户端方法新增 `AbortSignal`。
- 棘轮白名单从 11 项缩到 6 项：`generateDesignPlan`（@legacy）、`sendChat`、`routingRollback`、`productionRelease`（UI 已走 releaseGate）、`runAutomation`（服务端 abort 接口）、`schematicComponentBatchPlan`。
- 纪律不变：白名单只减不增；SKIPPED 不冒充 PASS。

## 49. 第 62 轮：批量落件 dry-run 计划迁移，D8 白名单 6→5

- 迁移：`PartProposalPage`「生成计划（dry-run）」（600s）改用 `createSingleCallTask` + `LongTaskPanel`，并把"计划"与"写板执行"拆成两个独立控制器——计划只读、执行写板，两者状态互不掩盖；取消只停本页等待，dry-run 不写板。
- `schematicComponentBatchPlan` 新增 `AbortSignal`；页面交互测试新增真实点击 dry-run 例（断言 planHash、逐项计划表与长任务面板）。
- 棘轮白名单 11→6→**5**：`generateDesignPlan`(@legacy)、`sendChat`、`routingRollback`、`productionRelease`（UI 已走 releaseGate）、`runAutomation`（服务端 abort 接口）。

## 50. 第 63 轮：需求对话发送迁移，D8 白名单 5→4

- 迁移：`AiTasksPage` 需求对话发送（`sendChat` 150s）改用 `createSingleCallTask` + `LongTaskPanel`，**保留既有消息状态机**（发送中→完成/失败）；新增「停止等待」按钮与统一面板措辞：取消=本页停止等待、服务端可能仍在生成、回复稍后可能出现在会话；超时单独 `CHAT_TIMEOUT`；失败仍按错误码区分 Codex 未就绪并报问题。
- `sendChat` 新增 `AbortSignal`；棘轮白名单缩到 4 项：`generateDesignPlan`(@legacy)、`routingRollback`、`productionRelease`（UI 已走 releaseGate）、`runAutomation`（服务端 abort 接口）。
- 覆盖说明：对话路径依赖 provider/会话上下文，未新增 jsdom 用例；由 e2e-app 与 typecheck/build 覆盖，如实在 checklist 标注。

## 51. 第 64 轮（收官）：布线回滚迁移，D8 收口

- 迁移：`RoutingWritePanel`「回滚本批图元」（120s 写路径）改用 `createSingleCallTask` + `LongTaskPanel`，取消只停本页等待、措辞明确回滚可能已部分生效（以铜读回/审计为准）；`routingRollback` 新增 `AbortSignal`。
- 棘轮白名单 4→**3**，三项均有明确理由：`generateDesignPlan`/`productionRelease` 为 @legacy 且无页面调用方（后者 UI 走 `releaseGate`/`productionExport`，均有 signal）；`runAutomation` 的中止走服务端 `POST /runs/:id/abort`（步骤边界生效 + `mayHaveTakenEffect`），属等价可中止通道。
- D8 判定：**收口**。所有用户可触发的 ≥110s 调用均可停止等待；不再有"未迁移的 UI 长调用"。

## 52. 第 65 轮：用户要求"全面检查"——全量回归 + 测试 flake 修复

- 复查执行：`npm test`（typecheck/vitest 157/runtime 759）与 `npm run acceptance` 全绿（报告 `artifacts/acceptance/acceptance-2026-10-20T06-44-54-645Z.md`）；真机/环境受限 5 步仍 SKIPPED+原因。
- 发现 flake：首次验收 runtime 758/759，失败用例 `POST /api/eda/library/devices/search` 返回 401 `RUNTIME_TOKEN_INVALID`；6 次循环复现 1 次。根因：用例依赖 `/api/health` 发放的 `sessionProof`，并发/端口复用场景下偶发拿到非本实例令牌（日志 `hadAuthHeader:true, issuanceEnabled:true`）。
- 修复：`startServer` 支持注入 `runtimeToken` 并返回 token；该用例改用本实例注入令牌、health 只断言可用。证据：单文件 10/10、全量 runtime 连续 3×759/759、acceptance PASS。
- 诚实边界：其余多数 HTTP 用例仍使用 `sessionProof` 模式，本次只加固已复现的一条；不声称"所有 flake 已清除"。
- 另核对：4179 真实 Runtime `/api/health` ok、`GET /api/eda/pcb/layers` 正常（此前 404 属重启前旧进程缺路由）。
