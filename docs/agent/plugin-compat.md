# dsh-circuitpilot 版本兼容与自动升级

> 适用对象：维护 `plugin/dsh-circuitpilot` 的人。目标是把「DSH / CircuitPilot 升级后插件还能用」
> 变成可自动执行、可门禁、可解释的流程，而不是每次升级后靠人工试错。
>
> 相关文件：`plugin/dsh-circuitpilot/compat.json`（唯一数据源）、`lib/compat.mjs`（读取 + 版本判定）、
> `lib/host.mjs`（DSH 宿主自适应）、`lib/cp-compat.mjs`（CircuitPilot 运行期门禁）、
> `scripts/sync-compat.mjs`（自动同步器）、`scripts/probe-cp-compat.mjs`（Runtime 只读探针）、
> `test/compat.test.mjs`（门禁测试）、`.github/workflows/plugin-compat.yml`（CI）。

## 0. TL;DR

| 场景 | 一条命令 | 期望 |
|---|---|---|
| 升级 DSH / CircuitPilot 后 | `cd plugin/dsh-circuitpilot && npm run compat:sync` | 追加 verified、按规则放宽 minor 上界、同步 `package.json`、跑全量测试；测试失败自动回滚并 exit 1 |
| 发版 / CI 前 | `npm run compat:check` | 全部兼容且清单一致 → exit 0；否则 exit 1 并打印「怎么修」 |
| 查本机 Runtime 能不能用 | `npm run cp:probe` | 版本判定 + 6 项能力矩阵；缺核心能力/版本越界 → exit 1 |

底层数据只有一份：`plugin/dsh-circuitpilot/compat.json`。`package.json` 的 `engines.dsh` / `dsh-*`
peerDependencies 是它的投影，`lib/compat.mjs` 在运行期读它，`test/compat.test.mjs` 强制三者一致。

## 1. 诊断结论（2026-11-05，DSH 0.2.1-rc.5 真机）

### 1.1 现象 A：插件被宿主直接 skip（清单门禁）

DSH 启动日志原文（`profile bundle` 被跳过）：

```text
dsh: skipping profile bundle "dsh-circuitpilot": Error: Plugin dsh-circuitpilot@0.1.0 is incompatible with dsh 0.2.1-rc.5: requirements {"@deepseek-ai/dsh-skill":"0.2.0-rc.2 || 0.2.1-rc.2","@deepseek-ai/dsh-mcp-client":"0.2.0-rc.2 || 0.2.1-rc.2"}
```

门禁实现是 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`，
其文档注释原文：

> Check the plugin's dsh requirements against the runtime. An own `engines.dsh` range decides alone and
> peerDependencies are ignored; otherwise every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer must match.
> Prereleases participate in ranges. For peers only, `workspace:^`, `workspace:~`, and `workspace:*` refer to
> the current runtime; other empty or invalid ranges, including any `workspace:` `engines.dsh`, are unmet.

即：

1. **有 `engines.dsh` 就只看它**，peerDependencies 被忽略；
2. 没有 `engines.dsh` 时，逐个检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 区间；
3. 预发布版本参与区间计算（等价 `semver.satisfies(v, range, { includePrerelease: true })`）。

旧 manifest 没有 `engines.dsh`，peer 只写死 `0.2.0-rc.2 || 0.2.1-rc.2`，于是 0.2.1-rc.5 不满足 →
profile 启动 `skippedBundles` 里出现该插件，`dsh plugin add` 也会以 `incompatible-version` 拒绝安装。

**修复层 1**：`package.json` 增加

```json
"engines": { "node": ">=22", "dsh": ">=0.2.1-rc.2 <0.3.0" }
```

并把 `@deepseek-ai/dsh-skill` / `@deepseek-ai/dsh-mcp-client` peer 区间同步为同一区间。
区间值唯一来源是 `compat.json → dsh.supported`，由 `sync-compat.mjs` 写回，`test/compat.test.mjs` 校验一致。

### 1.2 现象 B：即使加载成功，工具注册也抛 TypeError（运行期 API）

DSH 0.2.1-rc.5 的 `ctx.tools.register(definition)` 强制要求 `output = { schema, render, presentationMeta? }`，
否则抛：

```text
TypeError: tool "cp_status" must declare output { schema, render, presentationMeta? }
```

rc.5 `tools.register` 源码要点（`dsh` 运行时内）：

```js
const output = definition.output;
if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" ||
    output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") {
  throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
}
assertSupportedJsonSchema(output.schema);
```

rc.5 tool definition 形态：`{ name, description, parameters, output: { schema, render(args, value) }, execute(args, exec), isConcurrencySafe?, timeoutMs? }`；
执行值用 `output.schema` 校验，展示内容由 `render` 产生。旧宿主则接受 `{ name, description, inputSchema, execute }`。

**修复层 2**：`lib/host.mjs` 按宿主能力自适应注册（MCP 定义 → rc.5 native `output` 定义 → legacy 定义），
注册失败不拖垮整个 `apply`，并汇总 `failed`。`index.mjs` 只调用 host 层，不再直接拼旧式 definition。

### 1.3 现象 C：CircuitPilot Runtime 版本 / 能力不匹配

本机 4178 端口当时跑的是一个旧构建：

| 探测 | 结果 |
|---|---|
| `GET /api/health` | `200 {"ok":true,"service":"circuitpilot-runtime","version":"0.8.15"}` |
| `GET /api/project-state` / `issue-state` / `evidence/index` / `write-gate` / `agent/status` | `404 {"ok":false,"error":{"code":"ROUTE_NOT_FOUND"}}` |
| `GET /api/eda/workspaces/current` | `409 {"error":{"code":"EDA_WINDOW_NOT_FOUND"}}`（路由存在，只是 EDA 未连接） |

注意两个坑：

1. **只看版本号不够**：开源 `CircuitPilot-open-source` 0.2.1 的版本号可能落在区间内，但没有
   `/api/agent/*`、`/api/plan-requests` 等路由；反过来，旧构建 0.8.15 版本号越界、路由也缺。
2. **版本号来源不可靠**：`/api/health` 报的是「当前跑着的进程」的版本，可能是一个旧构建或别人的实例，
   不能代表「本仓库/已安装 App」的版本。

**修复层 2（续）**：`lib/cp-compat.mjs` 用「版本门禁 + 能力门禁」双门禁：

- 版本：`/api/health.version` 必须满足 `compat.json → circuitpilot.supportedRuntime`（当前 `>=0.2.0 <0.3.0`）；
  明确越界 → fail-closed，返回 `RUNTIME_VERSION_UNSUPPORTED`，不再让工具吐一串 404；
- 能力：逐项探测 `requiredCapabilities`（agent-api / project-state / issue-state / evidence-index /
  write-gate / eda-workspace），`ROUTE_NOT_FOUND`/404 = 缺失，409 等业务错误 = 路由存在，网络错误 = unknown；
- 结果统一进工具结果 `data.compat`，`cp_status` 明确列出缺失能力与可操作下一步。

## 2. 三层兼容设计

| 层 | 机制 | 代码/数据 | 生效点 |
|---|---|---|---|
| 1 清单门禁 | `engines.dsh` 覆盖整个 0.2.x；`dsh-*` peer 同步 | `package.json` ← `compat.json` | 宿主启动 / `dsh plugin add`（`evaluatePluginCompatibility`） |
| 2 运行期自适应 | 工具注册三态自适应；Runtime 版本 + 能力双门禁；404 错误升级为 `RUNTIME_ROUTE_MISSING` | `lib/host.mjs` / `lib/cp-compat.mjs` / `lib/tools.mjs` | 插件 `apply()` 与每次工具调用 |
| 3 自动同步 | 一条命令检测真机版本 → 更新 `compat.json` → 投影到 `package.json` → 跑测试兜底；CI 只读门禁 | `compat.json` / `lib/compat.mjs` / `scripts/sync-compat.mjs` / `test/compat.test.mjs` / `.github/workflows/plugin-compat.yml` | 升级后手动/发版前、每次 push/PR |

### 2.1 「自动」的边界（重要）

- **自动放行的是整个 minor 线**：`engines.dsh = ">=0.2.1-rc.2 <0.3.0"` 覆盖 DSH 0.2.x 的所有 patch 与预发布。
  DSH 从 0.2.1-rc.5 升到 0.2.2 / 0.2.3 不会再把插件 skip。
- **跨 minor 不会自动放行**：DSH 0.3.x / CircuitPilot 0.3.x 超出现有区间。升级后执行 `compat:sync`：
  - 同一 major 且 minor 跨度 ≤ 1 → 自动放宽上界到 `<major.(minor+1).0`（下界保持、不降低）；
  - 跨 major、minor 跨度 > 1、或检测版本低于下界 → **不自动放宽**，报告「需要人工确认」，
    避免把「只验证过 0.2.x」悄悄说成「兼容 0.8.x」。
- **验证不是自动的**：`sync` 会跑全量测试 + 自动写 verified 列表，但运行期接口是否真的兼容仍需要人复核
  （测试覆盖的是插件契约，不是 DSH 内部实现）。跨 minor 请务必真机加载一次再发布。
- **CI 不访问 4178**：workflow 使用 `--check --no-runtime-probe`；CI 无本机 DSH 时「检测不到版本」视为 skip。

## 3. 兼容矩阵

### 3.1 DSH 宿主

| 项目 | 值 |
|---|---|
| 支持区间（`engines.dsh`） | `>=0.2.1-rc.2 <0.3.0` |
| 已验证版本 | `0.2.1-rc.5`（本机桌面版；`dsh -V` 与 `~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` 的 `desktopVersion` 一致） |
| 判定依据 | `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()`，`includePrerelease` 语义 |
| 列表来源 | `compat.json → dsh.supported` / `dsh.verified` |

已验证的 semver 子集行为（与 DSH 自带 semver 对齐）：

| 版本 | 命中 `>=0.2.1-rc.2 <0.3.0` |
|---|---|
| `0.2.1-rc.2` / `0.2.1-rc.5` / `0.2.1` / `0.2.2` / `0.2.2-rc.1` / `0.2.9` | ✅ |
| `0.3.0-rc.1`（预发布 < 0.3.0） | ✅ |
| `0.2.0` / `0.2.1-rc.1` / `0.3.0` / `0.1.9` / `1.0.0` | ❌ |

### 3.2 CircuitPilot Runtime

| 项目 | 值 |
|---|---|
| 支持区间（`supportedRuntime`） | `>=0.2.0 <0.3.0` |
| 已验证版本 | `0.2.0`（本仓库 `runtime/version.mjs` 与已安装 App `CFBundleShortVersionString` 均为 0.2.0） |
| 判定依据 | 运行期 `GET /api/health.version` + `evaluateCpRuntime()`；缺版本/非法版本只警告不硬失败 |
| 列表来源 | `compat.json → circuitpilot.supportedRuntime` / `verifiedRuntime` |

### 3.3 CircuitPilot 能力（`requiredCapabilities`）

| 能力 id | 只读探测路由 | 主要依赖工具 |
|---|---|---|
| `agent-api` | `GET /api/agent/status` | `cp_design_plan` / `cp_pcb_plan` / `cp_approve`（计划级 UI 审批队列） |
| `project-state` | `GET /api/project-state` | `cp_status` / `cp_project_context` |
| `issue-state` | `GET /api/issue-state` | `cp_issues` / `cp_status` / `cp_project_context` |
| `evidence-index` | `GET /api/evidence/index` | `cp_evidence` / `cp_status` |
| `write-gate` | `GET /api/write-gate` | `cp_status`（写暂停状态） |
| `eda-workspace` | `GET /api/eda/workspaces/current` | `cp_status` / `cp_project_context` |

> 能力判定规则：`ROUTE_NOT_FOUND`/404 = 缺失；`409`/其它业务错误 = 路由存在（例如 EDA 未连接）；
> `401` = 鉴权先于路由分发，无法判定（需要 agent token）；网络错误 = unknown。

## 4. 自动更新操作手册

### 4.1 升级 DSH 之后

```bash
cd "/Users/jescochen/Desktop/AI- PCBA/plugin/dsh-circuitpilot"
node scripts/sync-compat.mjs --dry-run    # 先看会改什么（不落盘）
node scripts/sync-compat.mjs              # 写入 + 跑全量测试（事务式，失败回滚）
node scripts/sync-compat.mjs --check      # 只读门禁，exit 0 才算收工
```

`sync` 的行为：

1. 按优先级检测 DSH 版本：`--dsh-version` > `DSH_RUNTIME_VERSION` > `~/.dsh/.../runtime.json` >
   `dsh -V`（`$DSH_CLI` / `PATH` / 常见安装路径）。
2. 检测 CircuitPilot 版本：`--cp-version` > `CIRCUITPILOT_RUNTIME_VERSION` >（显式 `--runtime-url` 时）
   `/api/health` > 本仓库 `runtime/version.mjs` > 已安装 App > 运行中实例（兜底）。
3. 追加 `verified`（去重 + semver 排序）；越界时按规则放宽 minor 上界。
4. 字段级同步 `package.json`：`engines.dsh` 与 `@deepseek-ai/dsh-skill` / `@deepseek-ai/dsh-mcp-client`
   peer 区间；`cordis` / `schemastery` 不动。
5. 跑 `node --test "test/*.test.mjs"`；失败则恢复写入前的全部文件并 exit 1。

**注意**：本机 4178 若跑着旧构建，`/api/health` 探测到的版本只进报告的「观测值/告警」，
不会推翻「本仓库/已安装 App」的权威版本。只有显式传 `--runtime-url` 或设置
`CIRCUITPILOT_RUNTIME_URL` 时，运行中实例才作为权威版本参与判定。

### 4.2 升级 CircuitPilot 之后

```bash
cd "/Users/jescochen/Desktop/AI- PCBA/plugin/dsh-circuitpilot"
node scripts/sync-compat.mjs --cp-version 0.2.1     # 若检测到的版本不符合预期，可显式指定
node scripts/probe-cp-compat.mjs                     # 版本 + 能力矩阵
```

CircuitPilot 升级后除了版本，还要确认能力路由仍然齐全（尤其 `agent-api`）：`probe-cp-compat` 会逐项
只读 GET 并给出矩阵；插件运行期 `lib/cp-compat.mjs` 用同样规则 fail-closed。

### 4.3 Runtime 只读探针

```bash
node scripts/probe-cp-compat.mjs                        # 默认 http://127.0.0.1:4178
node scripts/probe-cp-compat.mjs --json                 # 结构化（CI/脚本消费）
node scripts/probe-cp-compat.mjs --base-url http://127.0.0.1:4191
node scripts/probe-cp-compat.mjs --token-file /path/to/agent-token.json
```

- **只发 GET**，不启动/不杀 Runtime，不打印 token；
- 能力路由需要 agent token（默认 `~/Library/Application Support/CircuitPilot/agent-token.json`，
  或 `CIRCUITPILOT_AGENT_TOKEN_FILE`）；没有 token 时只能用 `/api/health` 判版本，能力状态会显示「需 token」；
- 版本越界 / 缺核心能力 / Runtime 不可达 → exit 1，并打印下一步。

### 4.4 退出码与 `--json` 报告

`sync-compat.mjs`：

| 退出码 | 含义 |
|---|---|
| 0 | 正常 / 兼容（check 通过、sync 成功、dry-run 预览完成） |
| 1 | 漂移或 check 失败（越界、清单不一致、需要人工确认、测试失败已回滚） |
| 2 | 用法/内部错误（未知参数、清单缺失/损坏、非法版本） |

`--json` 时 stdout 只有 JSON，人类日志走 stderr。主要字段：`ok` / `mode` / `dsh` / `circuitpilot`
（含 `observedRuntime`）/ `manifest` / `writes` / `tests` / `warnings` / `problems` / `skipped` / `nextSteps`。

`sync-compat.mjs` 全部开关（`--help` 里也有）：

| 开关 | 作用 |
|---|---|
| （默认） | 检测 → 写 compat.json → 同步 package.json → 跑测试 → 报告 |
| `--check` | 只读门禁：不写文件，覆盖且清单一致 → exit 0，否则 exit 1 + 修复命令 |
| `--dry-run` | 打印将写入的字段，不落盘 |
| `--json` | stdout 只输出结构化 JSON（日志走 stderr） |
| `--dsh-version <v>` / `--cp-version <v>` | 显式覆盖版本检测（模拟/手动指定） |
| `--runtime-url <url>` | 探测运行中 CircuitPilot `/api/health`；显式指定时其版本参与权威判定 |
| `--no-runtime-probe` | 不探测运行中 Runtime（CI 用，保证不访问 4178） |
| `--no-dsh-cli` | 不执行 `dsh -V`（隔离测试/CI 用，避免探测本机已安装 DSH） |
| `--no-test` | 写入后不跑测试（仅调试，不推荐） |
| `--plugin-dir <dir>` | 指定插件目录（写模式测试/多副本场景；默认脚本上一级） |

`probe-cp-compat.mjs`：0 = 兼容且核心能力齐全；1 = 版本不兼容 / 核心能力缺失 / 不可达；2 = 用法错误。

### 4.5 CI 门禁

`.github/workflows/plugin-compat.yml`（push/PR，只读、不联网、不访问 4178）：

```bash
node --test "plugin/dsh-circuitpilot/test/*.test.mjs"
node plugin/dsh-circuitpilot/scripts/sync-compat.mjs --check --json --no-runtime-probe
```

CI 无本机 DSH / App 时检测不到版本 → 视为 skip，仍会校验「`package.json` 与 `compat.json` 一致」；
一旦有人改了 `engines.dsh` 忘了同步，这里就会红。

## 5. 验证证据

### 5.1 已完成的离线自动验证（Task C 交付时）

| 项 | 命令 | 结果 |
|---|---|---|
| 插件全量测试 | `cd plugin/dsh-circuitpilot && node --test "test/*.test.mjs"` | 全绿（含 `test/compat.test.mjs` 自测 71 项） |
| 真机只读门禁 | `node scripts/sync-compat.mjs --check` | exit 0（DSH `0.2.1-rc.5` + CircuitPilot `0.2.0`） |
| 模拟 DSH 越界 | `node scripts/sync-compat.mjs --check --dsh-version 0.3.0` | exit 1 + 可操作提示 |
| 模拟 CP 越界 | `node scripts/sync-compat.mjs --check --cp-version 0.8.15` / `0.3.0` | exit 1 + 可操作提示 |
| 写模式幂等 | mkdtemp 副本上连续 sync 两次 | 第二次字节级不变 |
| 事务回滚 | mkdtemp 副本注入失败测试后 sync | exit 1 且两个文件恢复原内容 |
| 探针真机只读 | `node scripts/probe-cp-compat.mjs`（4178 旧构建 0.8.15） | exit 1，明确版本越界 + 5 条核心路由缺失，token 未泄漏 |

### 5.2 真机验收（Lead，2026-11-05，DSH 0.2.1-rc.5）

环境：DSH Desktop `0.2.1-rc.5`（Electron/CLI 同一安装）；隔离 `DSH_HOME=.tmp/dsh-verify-home`、
profile `cp-verify`（`--from-default-profile headless` 模板），插件以 `link:` 安装；
CircuitPilot Runtime 为隔离启动的本仓库 `runtime/server.mjs`（`127.0.0.1:4191`，version `0.2.0`）；
另用本机正在运行的旧构建 `127.0.0.1:4178`（`/api/health` version `0.8.15`）验证不兼容路径。
验收探针为一个仅用于隔离 profile 的小 bundle（`.tmp/dsh-verify-bundle`），它在宿主内读取
`ctx.tools.schemas()` 并通过 `ctx.tools.execute()` 真实调用 `cp_status`；**不修改生产代码**。

| 验收项 | 命令 / 观察点 | 结果 |
|---|---|---|
| 清单门禁放行 | `DSH_HOME=.tmp/dsh-verify-home dsh plugin --profile cp-verify add "link:<repo>/plugin/dsh-circuitpilot"` | ✅ 安装成功：`+ dsh-circuitpilot 0.2.0`，不再报 `incompatible-version` |
| 启动无 skip | `dsh --profile cp-verify --dump-config` 中无 `skipping profile bundle "dsh-circuitpilot"`；无 `did not activate` | ✅ 输出含 `# == dsh-circuitpilot` / `id: dsh-circuitpilot`，无 skip/激活告警；启动仅在缺模型凭据处停止（`MISSING_CREDENTIAL`），说明插件树已成功激活 |
| 工具注册 | 宿主内探针读取真实 ToolRegistry | ✅ 12/12 `cp_status…cp_job` 全部注册（宿主共 37 个工具）；注册模式 `mcp`（`hasParameters=true`、`hasOutputSchema=true`、`hasRender=true`、`hasProjectContent=true`） |
| 宿主版本诊断 | `ctx.tools.execute({name:'cp_status'})` 返回值 | ✅ `data.plugin.host = { dshVersion: "0.2.1-rc.5", supported: true, supportedRange: ">=0.2.1-rc.2 <0.3.0", registration: "mcp" }` |
| 端到端只读 | 同上，插件配置 `runtimeUrl=http://127.0.0.1:4191` | ✅ `cp_status` → `ok:true`；`data.runtime.version="0.2.0"`、`versionCompat.supported=true`、`capabilities.complete=true`（6/6 能力路由存在）；结果不含 agent token |
| 不兼容 Runtime | 同上，插件配置 `runtimeUrl=http://127.0.0.1:4178`（实测 0.8.15） | ✅ `cp_status` → `ok:false`、`code:"RUNTIME_VERSION_UNSUPPORTED"`，message 明确「0.8.15 不在 >=0.2.0 <0.3.0」，4 条可操作 nextActions；不再返回一串 404 |
| 端到端写链路 | 计划 → 批准 → 执行 → DRC/证据 | ⏸ 未执行：隔离 Runtime 无真实 EDA 工程（EDA 离线/项目为空），且写链路需要用户在对话中显式批准；本轮只验收「加载 + 工具注册 + 只读端到端 + 不兼容 fail-closed」 |

证据文件：

- `artifacts/plugin-compat-dsh-host-0.2.1-rc.5.json`：宿主内 12 工具清单 + 注册形态 + `cp_status` 真实调用结果（0.2.0 兼容路径）。
- `artifacts/plugin-compat-cp-unsupported-0.8.15.json`：同一宿主内对 0.8.15 旧构建的 `RUNTIME_VERSION_UNSUPPORTED` 结果。

> 说明：用户桌面 profile（`~/.dsh/profiles/desktop`）里的 `dsh-circuitpilot` 是 `link:` 到本仓库，
> 清单修复会随 **DSH 重启**生效；本机 `4178` 仍是旧构建 0.8.15，插件会 fail-closed 提示，
> 需换用已安装的 CircuitPilot App（或本仓库 `runtime/server.mjs`，Runtime 0.2.x）才能端到端。

## 6. 常见问题（FAQ）

### Q1. 检测错了版本 / 想手动指定版本？

```bash
node scripts/sync-compat.mjs --dsh-version 0.2.1-rc.5 --cp-version 0.2.0
node scripts/sync-compat.mjs --check --dsh-version 0.3.0        # 模拟越界，验证门禁是否报警
```

也可以用环境变量：`DSH_RUNTIME_VERSION` / `CIRCUITPILOT_RUNTIME_VERSION` / `CIRCUITPILOT_RUNTIME_URL`。
`--runtime-url` 一旦显式传入，运行中实例的 `/api/health` 版本就会作为权威版本参与判定。

### Q2. 清单门禁已经红了，能不能用 `allow-version` 兜底？

可以，但那是 **DSH profile 的 exact-version 豁免**，与插件的 `compat.json` **完全不是一个东西**，
不要混用：

| 文件/机制 | 位置 | 作用 |
|---|---|---|
| 插件 `compat.json` | `plugin/dsh-circuitpilot/compat.json` | 插件声明「我支持哪些 DSH / CircuitPilot 版本」，是 `engines.dsh` 的数据源；**由本项目维护** |
| DSH profile `compatibility.json` | `<DSH_HOME>/profiles/<profile>/compatibility.json` | DSH 的「精确版本豁免」：把精确的 `package-name@version` 映射到精确 DSH 运行时版本列表；不写进 `package.json`、不改变依赖或 patch |

DSH 侧授权方式（**用户显式确认风险后**才可用；插件作者不应把它当作兼容方案）：

```bash
dsh plugin --profile <profile> version-exemptions
dsh plugin --profile <profile> allow-version dsh-circuitpilot@0.2.0 --dsh-version 0.2.1-rc.5 --accept-risk
dsh plugin --profile <profile> revoke-version dsh-circuitpilot@0.2.0 --dsh-version 0.2.1-rc.5
```

语义要点：豁免是「精确 name@version ↔ 精确 DSH 版本」的定向授权，插件升级或 DSH 升级都**不继承**；
文件缺失 = 无豁免；文件损坏时启动不会崩（能读的记录照用），但文件会被当作只读、不再自动改写。
授权 `.github/workflows` 之外的更高优先级仍是：**跑 `sync` 把区间改对**（插件该支持就声明支持），
`allow-version` 只用于「用户明确知道可能崩但必须临时跑」的场景。注意上面这条命令会写
`<DSH_HOME>`，本仓库的脚本与测试都**不会**替你执行它。

### Q3. 本机 4178 是旧构建，`compat:check` 会不会误报？

不会。默认 check 的 CircuitPilot 权威版本取「本仓库 `runtime/version.mjs` / 已安装 App」（0.2.0），
`/api/health` 探测到的 0.8.15 只作为报告里的 `observedRuntime` 告警出现。要真正检查运行中实例，
用 `npm run cp:probe`（它会直接对 4178 报「版本越界 + 核心路由缺失」），或显式
`node scripts/sync-compat.mjs --check --runtime-url http://127.0.0.1:4178`。

### Q4. 为什么跨 minor 不自动放宽？

自动放宽等价于替维护者做出「我验证过这一条线」的承诺。0.2.x → 0.8.x 这种跨度几乎必然伴随
不兼容变更（本机 4178 就是活例子）；自动放宽会把错误承诺写进 `engines.dsh`，让宿主在真正会崩的
版本上放行插件。因此规则是：同 major、minor 跨度 ≤ 1 才自动放宽；其余必须人工确认后手动改
`compat.json` 再跑 sync（sync 会重新验证并写 verified）。

### Q4.5 我想知道插件在宿主里到底注册成功没有？

看宿主日志里插件 `apply` 结束时的那行 `logger.info`：插件版本、DSH 版本 + 兼容判定、注册模式
（`mcp` / `native` / `legacy`）、成功/失败工具数。工具注册失败不会让整个插件崩掉，而是记录 warn 并汇总。

### Q5. `test/compat.test.mjs` 突然红了怎么办？

最可能是「漂移告警」：本机 DSH / 已安装 CircuitPilot 升级后不再被 `compat.json` 覆盖。处理：

```bash
cd plugin/dsh-circuitpilot
node scripts/sync-compat.mjs          # 自动放宽（若规则允许）+ 跑测试
node scripts/sync-compat.mjs --check  # 确认 exit 0
```

如果是「包清单一致性」红了（`engines.dsh` / peer / files 与 `compat.json` 不一致），同样跑一次 `sync` 即可；
若 sync 报告 `*_RANGE_MANUAL`，说明需要人工确认（跨 major / 跨度 > 1 / 低于下界），按提示改
`compat.json` 后重跑。

### Q6. CI 里没有 DSH / CircuitPilot 怎么办？

`--check` 把「检测不到版本」当作 skip（报告 `skipped` 字段），仍会校验清单一致性；
`probe-cp-compat` 在没有 Runtime 时 exit 1，因此 CI 不跑它（只在本地按需运行）。

## 7. 维护约定

- `compat.json`、`lib/compat.mjs`、`scripts/**`、`test/compat.test.mjs`、本文件、CI workflow 由本任务维护；
  `lib/compat.mjs` 的**读取路径（`new URL('../compat.json', import.meta.url)`）与导出名**被
  `index.mjs` / `lib/host.mjs` / `lib/cp-compat.mjs` / `lib/tools.mjs` 引用，改动必须同步全仓搜索。
- 改兼容区间请只改 `compat.json` 然后跑 `sync`，不要手写 `package.json`（会被一致性测试拦下）。
- 不要为了让测试变绿而回退别人的文件；发现缺失/被回退，先报给 Lead。
- 脚本与测试均**不写 `~/.dsh`**、不启动/杀 Runtime、不联网；4178 只允许只读 GET 探测。
