# 全面检查与完善报告（2026-11-06）

> 范围：本轮「DSH 插件兼容修复 → 知识类型谱 v2 → 复合设计框架 → Runtime/MCP/UI 接入」的**全量回归与一致性修补**。
> 结论：**所有可离线运行的测试套件全绿**；本轮回合修掉了 5 类"代码/文档/验证夹具不同步"问题，
> 并补上了 UI 闭环面板。剩余缺口见 §4（已如实保留，无"假通过"）。

## 1. 回归矩阵（本机实测）

| 套件 | 命令 | 结果 |
|---|---|---|
| Runtime 全量 | `npm run test:runtime` | **1571 / 1571 pass** |
| 前端全量（含新面板） | `npx vitest run` | **277 / 277 pass**（41 files） |
| DSH 插件（13 工具） | `cd plugin/dsh-circuitpilot && node --test "test/*.test.mjs"` | **208 / 208 pass** |
| 复合设计框架（含服务层） | `npm run test:design-framework` | **77 / 77 pass** |
| MCP agent | `node --test "agent/__tests__/*.test.mjs"` | **49 / 49 pass** |
| 独立验证（契约 + 安全） | `node --test verification/agent/contract.test.mjs verification/agent/security.test.mjs` | **18 / 18 pass** |
| 路由契约 + agent 授权 | `node --test runtime/__tests__/agent-auth.test.mjs runtime/__tests__/route-contract.test.mjs` | **17 / 17 pass** |
| 类型检查 | `npm run typecheck` | 通过 |

MCP 独立验证套件（`verification/agent/mcp/*.test.mjs`）依赖 `@modelcontextprotocol/sdk`；
本机离线环境未安装该 SDK，**本轮未执行**（代码与期望值已同步到 13 工具，待有 SDK 的环境复跑）。

## 2. 本轮发现并修复的问题

| # | 类别 | 问题 | 修复 |
|---|---|---|---|
| 1 | 契约/文档不同步 | 插件/agent/verification 多处仍写「12 个工具」，与新增 `cp_design_loop`（13）不一致 | 统一为 13：`lib/tools.mjs` 头注释、`docs/agent/agent-contract.md` 工具表、`verification/agent/{contract,security}`、`verification/agent/mcp/{mcp-session,protocol,wire,README}`、`agent/README.md`、`agent/mcp-server.mjs` 注释 |
| 2 | 验证夹具过期 | `verification/agent/fake-runtime.mjs` 的 `/api/health` 仍返回 `0.1.0-verify`，被 task-2 的运行期版本门禁判为不兼容 → 7 个用例失败 | 夹具改为 `0.2.0`（真实 Runtime 版本），用例恢复通过 |
| 3 | 验证用例假设过期 | `security.test.mjs` 只 enqueue 一次 `project-state` 500；task-2 的能力探测会先消费它，导致 cp_status 实际成功后仍断言失败 | 改为 enqueue 两次（探测 + 工具本身各一次），断言"工具失败 + 错误脱敏"语义不变 |
| 4 | UI 缺口 | 设计框架只有 client 方法/类型，没有界面 | 新增 `src/components/DesignFrameworkPanel.tsx`，接入「验证与交付 → 验证中心」顶部：框架状态/金板指标/可编辑 IR 运行闭环；**needs-review 显示为「需人工审阅（不是 passed）」**，并常驻"写 EDA 仍需官方 ERC/DRC + 人工审批"边界提示 |
| 5 | UI 测试 | 新面板无回归 | 新增 `src/components/__tests__/DesignFrameworkPanel.test.tsx`（4 用例：状态渲染、金板指标、needs-review≠passed、非法 JSON 不请求 Runtime） |
| 6 | 文档一致性 | 架构文档仍写"UI 尚未接入"；历史验收文档的 12 工具无时间注记；MCP README 工具清单漏 `cp_design_loop` | 更新 `docs/architecture/composite-design-framework.md` §10.2/§10.4；历史验收文档加"当时 12 / 2026-11-06 起 13"注记；修正 MCP README 清单 |

## 2.5 本机真机验证（2026-11-06 追加）

用**真实安装版 CircuitPilot.app（0.2.0）**、**本仓库最新 Runtime（0.2.0）**、**真实 DSH 0.2.1-rc.5
宿主**做了三层真机验证（隔离端口/临时 token，只读，不写 EDA、不碰用户 4178）：

| 验证 | 结果 |
|---|---|
| 安装版 App：`cp_status` | ✔ ok:true（Runtime 0.2.0、版本/能力门禁通过） |
| 安装版 App：`cp_design_loop(model)` | ✔ 明确 `RUNTIME_ROUTE_MISSING`——安装版构建早于复合框架，提示改用本仓库 `runtime/server.mjs` 或重新打包 App |
| 本仓库 Runtime：`cp_design_loop(model)` | ✔ needs-review / blocking=0 / repair=1 |
| 本仓库 Runtime：`cp_design_loop(source="project")`（EDA 离线） | ✔ `DESIGN_FRAMEWORK_EDA_OFFLINE` fail-closed（不编造板框尺寸） |
| 本仓库 Runtime：framework status/golden | ✔ 200；金板 5/5 |
| 真实 DSH 宿主 | ✔ 13 个 cp_* 工具；`cp_design_loop` 分别验证 model（needs-review）与 source=project（EDA_OFFLINE） |
| 本仓库打包 App bundle（含 framework + 内嵌 eval/golden） | ✔ 7/7：runtime 内含 framework、golden 5/5、cp_design_loop(model/source=project) 均符合预期 |
| **安装到 /Applications 的新 App** | ✔ 6/6：health 0.2.0、cp_status、cp_design_loop(model)、source=project EDA_OFFLINE、golden 5/5（真实安装版 Runtime） |

据此补齐：`source:"project"`（项目状态 + EDA 只读读回构建 IR）、`cp_design_loop` 的
"安装版构建早于框架"精确提示、以及对应测试（服务层 11 项、插件 210 项）。

详细报告与证据：[real-machine-verification-2026-11-06.md](./real-machine-verification-2026-11-06.md)、
`artifacts/real-machine-verification-2026-11-06.json`、`artifacts/real-dsh-host-verification-2026-11-06.json`。

---

## 3. 关键安全/确定性复核（本轮再次确认）

- **token 不泄漏**：插件/MCP/HTTP 响应均不含 `cpa_`/token；`verification/agent/security.test.mjs`、模拟验收脚本均覆盖。
- **fail-closed**：不兼容 Runtime（0.8.15）→ `RUNTIME_VERSION_UNSUPPORTED`；超大/非法模型 → 413/400；
  不可修复布局/网表 → blocked；缺证据/无机器判据 → REVIEW（不转 PASS）。
- **确定性**：同一 IR 两次闭环 digest 一致；金板评估两次指标一致。
- **只读边界**：复合框架与 `cp_design_loop` 不写 EDA、不签核、不进 `cp_approve/cp_execute`；
  写链路仍需现有审批链。

## 4. 仍未完成（如实保留）

1. **自动 IR 来源**：`cp_design_loop` 仍需调用方传入板级 IR；尚未从项目状态/EDA 读回自动构建
   （`design-spec`/PCB plan 适配器已有，缺"当前项目 → IR"的服务端组装）。
2. **真实 KiCad CLI DRC**：本机未安装，适配器仅伪 CLI 单测；装好后需真机回归 `parseKicadDrcReport`。
3. **外部求解器**：OR-Tools / Z3 / Shapely 本机不可用（探测如实报告 unavailable），纯 JS 兜底。
4. **规则覆盖率 21.2%（32/151）**：119 条无机器判据 → 恒为 REVIEW，`releaseReady` 恒 false；
   提升路径：补 IR 字段（3D 高度/courtyard/连接器朝向/silk/铜层几何）+ 给规则补判定器与测试。
5. **UI 形态**：当前是验证中心内的面板，不是独立页面/导航项。
6. **MCP 独立验证套件**：需要 `@modelcontextprotocol/sdk`（本机离线未安装）。
7. **真实 EDA 写链路/真机 DRC**：模拟验收明确不写板，未执行。

## 5. 复现命令

```bash
cd "/Users/jescochen/Desktop/AI- PCBA"

npm run test:runtime
npx vitest run
(cd plugin/dsh-circuitpilot && node --test "test/*.test.mjs")
npm run test:design-framework
node --test "agent/__tests__/*.test.mjs"
node --test verification/agent/contract.test.mjs verification/agent/security.test.mjs
node --test runtime/__tests__/agent-auth.test.mjs runtime/__tests__/route-contract.test.mjs
npm run typecheck

# 模拟验收（自动起隔离 Runtime，不碰用户 App）
node scripts/design-framework-sim.mjs --out artifacts/design-framework-sim-2026-11-06.json
```
