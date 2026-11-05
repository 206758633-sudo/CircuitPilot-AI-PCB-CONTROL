# dsh-circuitpilot 兼容性修复与自动升级验收（2026-11-05）

> 结论：**插件已恢复与 DSH 0.2.1-rc.5 兼容并完成真机激活验收**（12 个 `cp_*` 工具全部注册、
> 宿主内真实调用 `cp_status` 成功）；同时落地「三层自动兼容」机制，DSH / CircuitPilot 升级后可
> 用一条命令重新对齐版本区间，测试会主动报漂移。**新代码在用户桌面 DSH 重启后生效。**

## 1. 问题复现（修复前）

DSH 升级到 `0.2.1-rc.5` 后，插件在 profile 启动时被直接跳过：

```text
dsh: skipping profile bundle "dsh-circuitpilot": Error: Plugin dsh-circuitpilot@0.1.0 is incompatible
with dsh 0.2.1-rc.5: requirements {"@deepseek-ai/dsh-skill":"0.2.0-rc.2 || 0.2.1-rc.2",
"@deepseek-ai/dsh-mcp-client":"0.2.0-rc.2 || 0.2.1-rc.2"}. Running it may cause crashes or data loss.
```

复现命令（隔离 profile，不碰用户 `~/.dsh`）：

```bash
DSH_HOME="$PWD/.tmp/dsh-verify-home" \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile cp-verify add "link:$PWD/plugin/dsh-circuitpilot"
```

## 2. 根因（两层）

| 层 | 根因 | DSH 侧依据 |
|---|---|---|
| 清单门禁 | 插件没有 `engines.dsh`，只有 peerDependencies 且只写到 `0.2.1-rc.2`；DSH 用 `semver.satisfies(v, range, {includePrerelease:true})` 判定 `rc.5` 不满足 → 启动时 skip | `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()`：有 `engines.dsh` 就**只**看它，否则检查 `@deepseek-ai/dsh-*` peer |
| 运行期 API | 插件降级注册路径传旧式 `{name,description,inputSchema,execute}`；rc.5 的 `ctx.tools.register()` 强制要求 `output { schema, render }`，否则 `TypeError: tool "cp_status" must declare output { schema, render, presentationMeta? }` | `@deepseek-ai/dsh-tools` 的 `ToolRegistry.register()` / `createSuccessResult()` |
| 回路不匹配 | 本机 4178 实际跑的是旧构建（`/api/health` version `0.8.15`，`/api/project-state` 等核心路由 404）；插件此前只会返回一串无上下文 404 | 实测（见 §5） |

## 3. 修复内容

### 3.1 兼容层三件套（新增）

| 文件 | 作用 |
|---|---|
| `plugin/dsh-circuitpilot/compat.json` | 唯一数据源：DSH / CircuitPilot Runtime 支持区间、已验证版本、CircuitPilot 必需能力 |
| `plugin/dsh-circuitpilot/lib/compat.mjs` | semver 子集（与 DSH `includePrerelease` 语义对齐）、`evaluateDshHost` / `evaluateCpRuntime`、本机版本探测；**host-independent** |
| `plugin/dsh-circuitpilot/lib/host.mjs` | 宿主自适应注册：**MCP → rc.5 native（`parameters`+`output{schema,render}`）→ legacy（`inputSchema`）**；注册失败隔离、disposer 清理、宿主诊断 |

### 3.2 插件清单与入口

- `package.json`：`version` `0.1.0 → 0.2.0`；新增 `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`（覆盖整个 0.2.x，
  后续 0.2.x 小版本/预发布自动放行）；peerDependencies 放宽为区间；`files` 增加 `compat.json`；
  新增 `compat:sync` / `compat:check` / `cp:probe` 脚本。
- `index.mjs`：接线 `lib/host.mjs`；`apply` 结束打印「插件版本 / DSH 版本+兼容判定 / 注册模式 /
  成功·失败工具数」；把宿主对象传给工具层用于 `cp_status` 诊断。

### 3.3 CircuitPilot Runtime 兼容层（新增 `lib/cp-compat.mjs` + `lib/tools.mjs` 集成）

- 12 个工具统一门禁（`cp_job` 纯本地除外）：`/api/health.version` 可解析且越界 →
  `RUNTIME_VERSION_UNSUPPORTED` fail-closed；不可达 → `RUNTIME_UNREACHABLE`；版本缺失/非法 → 放行 + warning。
- 能力探测（6 项核心路由，30s 缓存）：缺失能力进 `cp_status` 诊断；`ROUTE_NOT_FOUND` 统一升级为
  可操作的 `RUNTIME_ROUTE_MISSING`（附 `data.originalCode` / `data.routes` / nextActions）。
- `cp_status` 新增 `data.plugin`（插件版本 + DSH 宿主版本/区间/注册模式）、`data.runtime.versionCompat`、
  `data.runtime.capabilities`、`data.compat`；不兼容时 summary/warnings/nextActions 显式提示，不再假装在线。
- 安全边界不变：approvalToken 不返回模型、approvalMode、16KB 裁剪、requestId 幂等、写暂停/失败不自动重试。

### 3.4 自动升级工具链（新增）

| 文件 | 作用 |
|---|---|
| `plugin/dsh-circuitpilot/scripts/sync-compat.mjs` | 检测本机 DSH（runtime.json / `dsh -V`）与 CircuitPilot（health / `runtime/version.mjs` / 已装 App）→ 追加 verified → 按规则放宽 minor 上界 → 投影 `package.json` → 跑测试；**事务式写入**（测试失败回滚）；`--check` 只读门禁 |
| `plugin/dsh-circuitpilot/scripts/probe-cp-compat.mjs` | CircuitPilot Runtime 只读探针：版本判定 + 6 项能力矩阵；只发 GET、不打印 token、缺失核心能力 exit 1 |
| `plugin/dsh-circuitpilot/test/compat.test.mjs` | 71 项离线测试：清单一致性、semver 矩阵、临时 DSH_HOME 探测、**漂移告警（升级后会红）**、sync 子进程/幂等/回滚、probe fake runtime |
| `docs/agent/plugin-compat.md` | 兼容设计、诊断结论、操作手册、FAQ、真机验收证据 |
| `.github/workflows/plugin-compat.yml` | PR/push：插件全量测试 + `sync-compat --check --no-runtime-probe`（不联网） |
| 根 `package.json` | 新增 `plugin:test` / `plugin:compat:sync` / `plugin:compat:check` / `plugin:cp:probe` |

## 4. 「自动兼容」机制说明

1. **清单门禁自动放行 0.2.x**：`engines.dsh` 覆盖整个 0.2.x 线，DSH 小版本升级不再 skip 插件。
2. **运行期自适应**：`lib/host.mjs` 按宿主能力选择注册契约（MCP / native / legacy），DSH 收紧
   `tools.register` 契约时插件仍能加载；`lib/cp-compat.mjs` 用「版本 + 能力」双门禁把不兼容 Runtime
   变成可读错误而不是 404 洪水。
3. **升级后一条命令对齐**：
   ```bash
   cd plugin/dsh-circuitpilot && npm run compat:sync   # 检测→放宽→投影→跑测试（事务式）
   npm run compat:check                                 # CI/发版前只读门禁
   npm run cp:probe                                     # 探测当前 Runtime 是否真的兼容
   ```
   跨大版本 / 跨度 >1 minor 不自动放宽（避免把没验证过的版本写进承诺），脚本会要求人工确认。
   漂移测试会让 `test/compat.test.mjs` 在 DSH/CircuitPilot 升级后主动变红，提醒维护者执行 sync。

## 5. 验收结果

### 5.1 离线测试

```text
cd plugin/dsh-circuitpilot && node --test "test/*.test.mjs"
tests 198 / pass 198 / fail 0（既有 86 项全部保留且未改语义 + 新增 112 项兼容/宿主测试）
```

### 5.2 工具链

| 场景 | 结果 |
|---|---|
| `node scripts/sync-compat.mjs --check`（真机 DSH 0.2.1-rc.5 + 已装/仓库 CircuitPilot 0.2.0） | exit 0，清单一致；4178 旧构建只作为 `observedRuntime` 告警 |
| `--check --dsh-version 0.3.0` / `--cp-version 0.8.15` / `--cp-version 0.3.0` | exit 1 + 可操作修复提示 |
| `node scripts/probe-cp-compat.mjs --base-url http://127.0.0.1:4191`（隔离 Runtime 0.2.0） | exit 0，版本兼容 + 6/6 能力路由，EDA 离线（409）判为「路由存在」 |
| `node scripts/probe-cp-compat.mjs --base-url http://127.0.0.1:4178`（旧构建 0.8.15） | exit 1，明确版本越界 + 5 条核心路由缺失；token 无泄漏 |

### 5.3 真机 DSH 宿主（DSH 0.2.1-rc.5，隔离 `DSH_HOME`）

| 验收项 | 结果 |
|---|---|
| `dsh plugin add link:` | ✅ 安装成功，不再 `incompatible-version` |
| `--dump-config` | ✅ `# == dsh-circuitpilot`，无 `skipping` / `did not activate` |
| 工具注册 | ✅ 12/12 `cp_*`；注册模式 `mcp`（`output{schema,render}` 契约） |
| 宿主 → 插件 → Runtime 0.2.0 | ✅ `ctx.tools.execute('cp_status')` → `ok:true`；`data.plugin.host.dshVersion="0.2.1-rc.5"`、`registration="mcp"`、`versionCompat.supported=true`、`capabilities.complete=true` |
| 不兼容 Runtime（0.8.15） | ✅ `ok:false`、`RUNTIME_VERSION_UNSUPPORTED` + 4 条 nextActions，不再 404 洪水 |

证据：`artifacts/plugin-compat-dsh-host-0.2.1-rc.5.json`、`artifacts/plugin-compat-cp-unsupported-0.8.15.json`。

## 6. 如何生效 / 使用

1. **重启 DeepSeek Harness**：桌面 profile（`~/.dsh/profiles/desktop`）里 `dsh-circuitpilot` 是
   `link:` 到本仓库，重启后即加载新版（清单门禁与运行期自适应都会生效）。
2. **CircuitPilot 侧**：本机当前 4178 是旧构建 `0.8.15`，插件会 fail-closed 并提示。请启动已安装的
   CircuitPilot App（Runtime 0.2.0）或本仓库 `node runtime/server.mjs`；可用
   `npm run plugin:cp:probe` 确认版本与能力。
3. 以后 DSH / CircuitPilot 再升级：`cd plugin/dsh-circuitpilot && npm run compat:sync`，按报告处理
   （跨 minor 会要求人工确认），再 `npm run compat:check` 确认 exit 0。

## 7. 未完成 / 边界（如实保留）

1. **写链路未在真机 DSH 会话执行**：计划 → 批准 → `cp_execute` → DRC/证据需要真实 EDA 工程与用户
   显式批准；隔离 Runtime 无真实项目（EDA 离线），本轮只验收「加载 + 12 工具 + 只读端到端 + 不兼容 fail-closed」。
2. **本机 4178 仍是旧构建 0.8.15**：需用户换成兼容 Runtime 后才能在真实桌面会话里端到端；插件已能明确提示。
3. **CI workflow 未在 GitHub 实跑**：本地等价命令通过；Linux/Windows 的 App 版本探测为 best-effort。
4. **桌面 profile 内重启后的工具列表** 未由本机验证（隔离 profile 已等价验证；用户重启后可在会话里
   让模型调用 `cp_status` 复核）。
