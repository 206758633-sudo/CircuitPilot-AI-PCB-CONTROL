# 结合当前 CircuitPilot 的可行性落地解决方案（2026-10-21）

> 这是 `next-solution-plan-2026-10-21.md` 的“结合现状、细化到代码”的落地版：
> 只做**现有架构能承接、现有测试能守护、每步可独立验证**的改动；不重写应用、不新增运行时依赖。
> 现状锚点：仓库 `circuitpilot-control-demo 0.2.0`（Node v24.14.0）；EDA 工程已清理为双板（Board1_1 主板 64 器件、按键指示灯板空板）；Bridge/ERC/DRC/放行门证据链可用；本机公网可用；EDA 器件库列表为空（需登录/下载）。

## 0. 结论先行

**可行性成立**：需要的 80% 零件已经在仓库里（Bridge 读写、ERC/DRC 归一化、放行门 `release-gate.mjs`、证据库 `evidence-store.mjs`、网表编译 `netlist.mjs`、供应链查询 `supply.mjs`、设置页与测试体系），真正要新增的只有四块：
1. `runtime/research.mjs`（联网检索/抓取，带 SSRF 防护与证据）；
2. `runtime/agents/`（Netlist Auditor、Rule Runner、Librarian、Orchestrator 四个薄模块）；
3. `runtime/knowledge.mjs`（K0 知识库：失败/回归 + 规则模板 + 器件身份缓存，JSON+索引，无新依赖）；
4. 少量路由、设置项与一个「验证中心」页面，最后重建安装版。

## 1. 现状盘点：能直接复用的 vs 缺口

| 能力 | 现状 | 位置 | 缺口 |
|---|---|---|---|
| EDA 读写/回读 | ✅ 可用（单飞队列、写权限门、503 演练已过） | `runtime/bridge.mjs`、`server.mjs` | 无新增 |
| 原理图 ERC | ✅ 归一化 + 豁免 + 报告 | `runtime/erc.mjs`、`/api/eda/schematic/erc/run` | 无 |
| PCB DRC | ✅ 归一化（叶子计数/解释/豁免） | `runtime/drc.mjs`、`/api/eda/pcb/drc/*` | 无 |
| 放行门 | ✅ 已有综合闸门（Gerber/BOM/CPL/DRC/仿真/约束/供应链） | `runtime/release-gate.mjs`、`/api/eda/release/gate` | 缺 **G2 器件身份** 与 **G3 意图网表 diff** 两类检查 |
| 证据存储 | ✅ sha256 绑定 + EVIDENCE_KINDS + latest/list | `runtime/evidence-store.mjs` | 需扩展证据 kind（research/lib/netlist-diff/knowledge） |
| 网表 | ✅ 意图网表编译/校验 | `runtime/netlist.mjs` | 缺“意图网表 ↔ EDA 实际网表”逐 pin diff |
| 供应链 | ✅ 嘉立创/立创 SMT 接口（价格库存） | `runtime/engineering/supply.mjs` | 缺 datasheet/封装/3D 三源核验 |
| AI 计划/选型 | ✅ chat/plan/selection 证据注入 | `runtime/chat.mjs`（`collectSelectionEvidence`、`plan()`） | 选型证据依赖 EDA 库（当前为空），且无联网 |
| 设置 | ✅ Provider/自定义 Provider/钥匙串 | `src/pages/SettingsPage.tsx`、`runtimeClient.ts` | 缺“联网检索”开关与测试 |
| 多板 | ⚠️ 单板绑定模型 | `src/types.ts` `EdaWorkspaceBinding` | 双板展示/绑定需扩展（本方案后期处理） |
| 测试/构建 | ✅ runtime 872 + vitest 169 基线；`build`/`sidecar:stage`/`desktop:app` | `package.json`、`scripts/` | 新能力需补单测与真机验证脚本 |

## 2. 落地路线（4 个阶段，每阶段可独立交付）

### S1（1.5 天）联网检索 + 设置入口
**目标**：让 CircuitPilot 的 AI 具备“查公网”能力（Librarian 的前置）。
- 新增 `runtime/research.mjs`：
  - `searchWeb(query, {provider='duckduckgo'|'bing', limit, timeoutMs, fetchImpl})`；
  - `fetchPage(url, {maxBytes=2MB, timeoutMs=12s, fetchImpl})`：仅 http/https、拒绝本机/私网/凭据 URL、重定向后复检、HTML→文本；
  - 统一返回 `{ok, source, query/url, fetchedAt, results/text, digest}`，失败 fail-closed 带原因码；
- `runtime/server.mjs` 新增路由：`POST /api/research/search`、`/api/research/fetch`（**默认关闭**，请求显式 `allowResearch:true` 才执行）；
- 设置页新增「联网检索」：开关 + 源（DuckDuckGo/Bing）+ “测试联网检索”按钮；`SettingsState` 加**可选**字段（`researchEnabled?`、`researchProvider?`），兼容旧状态；
- `runtimeClient.ts` 增加 `researchSearch/researchFetch`，`plan`/`chat` 请求透传 `research`；
- `runtime/__tests__/research.test.mjs`：注入 fetchImpl，覆盖解析/SSRF 拒绝/超时/体积上限/fail-closed（测试不联网）。

**验收**：真机 `searchWeb('WS2812B datasheet')` ≥3 条带 URL 结果；抓 LCSC/datasheet 成功；设置页开关 + 测试按钮可用；基线测试不破。

### S2（3 天）确定性验证 agent + 门禁（最高价值）
**目标**：把“GND 空网/10 个 GND 归 +3V3/171 悬空/ERC/DRC”变成可阻断的 agent 证据。
- 新增 `runtime/agents/netlist-auditor.mjs`：输入 = spec 意图网表（先支持 chat `netlist` 产物）+ EDA 实际网表（`schematic.netlist.export`）；输出 `netlist-diff.json`：`missing/extra/pinMismatch/floating/gndEmpty/powerMixed`，逐条带 ref.pin 与证据；把本次三处缺陷固化为首组回归 fixture；
- 新增 `runtime/agents/rule-runner.mjs`：薄封装 `erc.mjs`/`drc.mjs` + 现有路由，产出 `rules-evidence.json`（规则集版本、运行时间、违规明细、豁免）；
- 扩展 `runtime/release-gate.mjs`：新增 `gateNetlistDiff()`、`gateLibrary()`（G3/G2）并挂进 `gateFabricationRelease()`（未知证据=阻断）；
- 扩展 `evidence-store.mjs` 的 `EVIDENCE_KINDS`（`research`、`lib-evidence`、`netlist-diff`、`rules`、`knowledge`）；
- 路由：`POST /api/eda/gates/netlist-diff`、`GET /api/eda/gates/latest`；先“报告模式”，验证后切硬阻断；
- 单测：diff 规则、GND/电源判定、闸门阻断语义；真机：对当前主板跑出第一份 diff 与 rules 证据。

**验收**：`netlist-diff.json` 能定位 GND 空网与 171 悬空；违规可触发 block；证据 sha256 绑定 pcbUuid。

### S3（4 天）规格先行 + K0 知识库 + Librarian
**目标**：给设计/验证提供“事实来源”和“工程记忆”。
- `spec/design-spec.json`（+生成脚本）：双板、板框（DXF→pts）、接口契约（U14↔U16、U18↔U17）、BOM 锁、意图网表、37 条需求→验收证据矩阵；
- `runtime/knowledge.mjs`（K0）：JSON 存储 + 简单全文索引；条目 schema：`{id, kind(part|module|rule|failure), title, payload, provenance{source,url,version,fetchedAt}, trust(authoritative|reference|unverified), ttlDays, review}`；首批：本次缺陷/回归、规则模板、两块板器件身份缓存；
- `runtime/agents/librarian.mjs`：EDA 库（权威）→ `supply.mjs` JLC（价格库存）→ `research.mjs` datasheet（参考）三源交叉；缺 symbol/footprint/3D/引脚冲突 → `ambiguous`；输出 `lib-evidence.json`；
- 设置/API：`GET /api/knowledge/search`、`POST /api/knowledge/entries`（写入需 review 标记）。

**验收**：37/37 需求映射；按键灯板 15 器件每颗有 `lib-evidence.json`；三源冲突显性化；K0 至少 10 条失败/规则条目。

### S4（1 周）Orchestrator + 验证中心 UI + 实证 + 重建
- 新增 `runtime/agents/orchestrator.mjs`：串 `spec → librarian → plan → netlist → auditor → rule-runner → gate`，失败回传修复并复验；
- 新增页面「验证中心」（React）：每板每门状态/证据/阻断原因/时间线；放行按钮受门禁控制（`release-gate` 已有结果可复用）；
- 按键指示灯板全流程实证（spec→原理图→网表 diff→PCB→DRC→证据），主板修复 GND/接口后复验；
- 回归：本次测试板 + 参考基准 + 至少 1 块新需求板；
- 构建安装：`npm run build` → `npm run sidecar:stage` → `npm run desktop:app`，替换安装版并验证（需用户确认）。

**验收**：验证中心可见全部门状态；按键灯板硬门禁通过；安装版可复现；指标（门禁一次通过率、与工程师差异率）开始记录。

## 3. 关键接口契约（示例）

```jsonc
// artifacts/evidence/netlist-diff/netlist-diff-<ts>-<hash>.json
{
  "schemaVersion": 1, "kind": "netlist-diff",
  "fingerprint": { "pcbUuid": "5595e77cead09682", "intentDigest": "…", "actualDigest": "…" },
  "payload": {
    "counts": { "nets": 34, "endpoints": 0, "floating": 171, "gndEmpty": true, "powerMixed": 10 },
    "findings": [ { "code": "NETLIST_PIN_FLOATING", "ref": "U13", "pin": "1", "detail": "…" } ],
    "verdict": "blocked"
  }
}
```

门禁结果统一：`{ gate: 'G3', board, pcbUuid, verdict: 'pass'|'blocked'|'unknown', reasons: [...], evidencePath }`。

## 4. 关键决策（避免返工）

1. **不新增运行时依赖**：K0 用 JSON 文件 + 自建索引（Node 24 有 `node:sqlite`，但先不用实验特性；需要时再平滑迁移）。
2. **联网默认关闭、显式开启**：设置里开 + 每次请求 `allowResearch:true`；抓取只读、结果只作证据，不自动写入 EDA。
3. **agent 不做判定**：agent 只编排和解释；判定全在 `release-gate.mjs`/`erc.mjs`/`drc.mjs` 这些确定性代码里。
4. **证据 fail-closed**：缺失/过期/冲突一律 `blocked|unknown`，绝不默认通过。
5. **测试不联网**：所有网络调用注入 `fetchImpl`；真机验证单独脚本（`scripts/verify-research.mjs` 等）。
6. **设置字段可选**：不改 `seed.ts`/旧状态结构，前端缺省视为关闭。
7. **重建分批**：S1 末与 S4 末各重建一次，避免频繁覆盖安装版。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| EDA 器件库当前为空（需登录/下载） | Librarian 降级模式（JLC+datasheet 两源），把库不可用显性成 G2 `ambiguous`，不阻断 S1/S2 |
| datasheet 以 PDF 为主，解析成本高 | 先抓产品页/HTML；PDF 用系统 `pdftotext`（若可用），失败标 `unparsed` 不猜 |
| 网页不可信/被投毒 | 只读+摘要；来源 URL/时间入库；不自动写入 EDA；与库/供应链证据交叉 |
| 门禁误伤既有流程 | 先报告模式，再切硬阻断；豁免必须带理由+审批记录 |
| 重建安装包耗时 | 集中在 S1/S4；构建失败不阻塞 runtime 能力验证 |
| 范围膨胀（自动布局布线/L3） | 本方案先把 L1 做扎实（spec→原理图→网表→DRC 门禁），布局布线自动化留到下一阶段 |

## 6. 总验收标准（放行定义）

- 两板数量/尺寸/接口/安装孔与需求一致；
- 每板：ERC=0、意图 vs 实际网表 diff=0、DRC=0、铺铜连通、封装/3D 完整、BOM 冻结；
- 证据全部带 sha256 与 pcbUuid，可复跑审计；37 条需求逐条有证据；
- 验证中心显示每门状态；人工终审签字后放行。

## 7. 立即可交付（第一周）

| 顺序 | 交付物 | 完成标志 |
|---|---|---|
| 1 | `runtime/research.mjs` + 路由 + 设置页开关 | 真机检索/抓取成功，测试绿 |
| 2 | `runtime/agents/netlist-auditor.mjs` | 当前主板第一份 pin 级 diff 证据（GND/悬空定位） |
| 3 | `runtime/agents/rule-runner.mjs` + G3 报告模式 | ERC/DRC 证据 + 阻断演示 |
| 4 | 重建安装版（S1 末，可选） | 安装版设置页出现「联网检索」并可用 |

需要用户确认：①允许修改 runtime/前端并重建安装 CircuitPilot.app；②EDA 账号是否可登录下载元件库（决定 Librarian 是权威模式还是降级模式）。
