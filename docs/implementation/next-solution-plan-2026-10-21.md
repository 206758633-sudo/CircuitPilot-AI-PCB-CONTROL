# CircuitPilot 下一步解决方案（整合版，2026-10-21）

> 目标：把“AI 生成板子”升级为“AI 在规格、知识、验证、迭代闭环内做板”——用**验证 agent + 硬门禁 + 联网查证**替代模型自证。
> 现状：EDA 工程已清理为双板（主板 Board1_1 64 器件、按键指示灯板空板）；参考工程解析基准就绪；Bridge/ERC/DRC/证据链可用；本机公网可用（DuckDuckGo/Bing/LCSC 实测可抓）；EDA 器件库列表为空（需登录/下载）；`research.mjs` 尚未接入。

## 0. 总体原则

1. **生成与验证分离**：设计 agent 不许自证；验证 agent 只读取证；冲突升级给人。
2. **确定性优先**：能由工具判定的（网表 diff、ERC/DRC/DFM、铺铜连通、电流/压降）绝不交给模型“感觉”。
3. **规格是唯一事实来源**：每块板先有 `design-spec`（板卡/接口/BOM 锁/意图网表/验收矩阵），设计、验证、放行都以它为准。
4. **证据即通行证**：每个 agent 产出标准化 `evidence.json`（来源、时间、结论、阻断原因），门禁只认证据。
5. **fail-closed**：查不到、对不上、过期 → 判 `ambiguous/blocked`，绝不默认通过。
6. **AI 查资料只做“归纳+解释”**：资料源（EDA 库/JLC/LCSC/datasheet）说了算，AI 不得编造料号、引脚、封装。

## 1. 能力地图（四个验证 agent + 一个编排）

| 组件 | 职责 | 工具/数据源 | 输出 | 门禁 |
|---|---|---|---|---|
| **规范化 Orchestrator** | 调度生成→取证→验证→修复→复验；不掌握放行权 | 各 agent 结果、Gate Engine | 流程状态 + 汇总证据 | — |
| **Librarian（器件核验）** | 料号身份核验：symbol/footprint/3D/引脚定义/替代料 | ① EDA 器件库（权威）② 嘉立创 SMT/LCSC 接口 ③ datasheet/官网（联网） | `lib-evidence.json` | G2 |
| **Netlist Auditor（网表比对）** | 意图网表 vs 实际网表逐 pin diff；悬空/短路/NC 显式化 | `netlist.mjs` + bridge 网表导出 | `netlist-diff.json` | G3 |
| **Rule Runner（规则执行）** | ERC/DRC/DFM/铺铜连通/电气计算；规则与叠层一致性 | EDA 官方 ERC/DRC、规则读取、计算脚本 | `rules-evidence.json` | G5 |
| **Field Loop（样机回归）** | 打样/调试/产测数据 → 问题单 → 回归用例 | 测试记录、版本/BOM、问题库 | `field-issue.json` + 回归集 | L4 |
| **Gate Engine** | 读证据→判定 pass/block；不给“没证据的通过” | 上述 evidence + 门禁规则 | `gate-<board>.json` | G1~G6 |
| **Research（联网检索）** | 给 Librarian 提供网页检索/抓取能力；SSRF 防护、超时、体积上限、证据留痕 | DuckDuckGo/Bing（无 key）+ 可配置 API 源 | `research-evidence.json` | 支撑 G2 |

## 2. 分阶段落地（每阶段有独立验收）

### P0 联网检索能力 + 设置入口（1~2 天，先做）
- `runtime/research.mjs`：`searchWeb()`（DDG HTML/Bing，无 key，可注入 fetchImpl）、`fetchPage()`（HTML→文本、超时、2MB 上限、仅 http/https、拒绝私网/本机地址、重定向后复检、证据留痕）；
- `runtime/server.mjs`：`POST /api/research/search`、`/api/research/fetch`（默认关闭，请求显式 `allowResearch:true` 才放行）；
- 设置页新增「联网检索」：总开关 + 检出源（DuckDuckGo/Bing）+ “测试联网检索”按钮；`SettingsState` 用可选字段兼容旧状态；
- 证据：`artifacts/evidence/research/`；测试：`runtime/__tests__/research.test.mjs`（注入 fetchImpl，不打网络）。

**验收**：真机 `searchWeb('WS2812B datasheet')` 返回 ≥3 条带 URL 结果；`fetchPage` 抓取 LCSC/datasheet 页成功；设置页开关生效；fail-closed 用例全绿；既有基线（runtime 872/872、vitest 169/169）不破。

### P1 确定性验证 agent（2~3 天）
- `runtime/agents/netlist-auditor.mjs`：从 spec 意图网表 + EDA 实际网表做 per-pin diff；输出 missing/extra/mismatch/floating/GND 空网/电源混网；把本次缺陷（GND 0 焊盘、10 个 GND→+3V3、171 悬空）固化为首组回归用例；
- `runtime/agents/rule-runner.mjs`：跑 ERC/DRC/铺铜连通性/规则叠层一致性；违规明细与证据落盘；复用现有 `erc.mjs`/`drc.mjs`/routes；
- `runtime/gates.mjs`：G2/G3/G5 判定 + `gate-<board>.json`；先以只读/报告模式接入，验证通过后再切硬阻断。

**验收**：对当前主板跑出第一份 `netlist-diff.json`（能定位 GND/悬空问题）与 `rules-evidence.json`；任一缺陷可触发门禁 block；单测覆盖 diff 规则与门禁判定。

### P2 规格先行 + Librarian（3~5 天）
- `spec/design-spec.json`：双板 + 接口契约（U14↔U16、U18↔U17）+ BOM 锁 + 意图网表 + 37 条需求验收矩阵；DXF 点数据生成两块不规则板框；
- `runtime/agents/librarian.mjs`：EDA 库 + JLCPCB SMT 接口（`supply.mjs` 已实测可用）+ `research.mjs` datasheet 三源交叉；缺 symbol/footprint/3D 或引脚冲突 → `ambiguous`；
- **前置修复 EDA 库访问**：登录/下载元件库，验证 `library.device.search` 有候选；若仍不可用 → 降级模式（仅 JLC+datasheet，结论标 `ambiguous`，不冒充权威）。

**验收**：37/37 需求有映射；两块板框与需求误差 ≤0.5mm；按键灯板 15 器件每颗有 `lib-evidence.json`；三源冲突全部显性化。

### P3 编排 + 验证中心 UI + 硬门禁（1 周内）
- `runtime/agents/orchestrator.mjs`：串起 Librarian → Netlist Auditor → Rule Runner → Gate Engine；失败自动回传修复任务并复验；
- UI 新增「验证中心」：每板每门状态、证据链接、阻断原因、时间线；项目页放行按钮受门禁控制；
- 人工节点：spec 评审、BOM 冻结、门禁放行、首样评审（不可省）。

**验收**：按键灯板从 spec→原理图→网表 diff→PCB→DRC 全流程硬门禁通过；主板缺陷修复后复验通过；证据可审计、可复跑。

### P4 实证与回归（持续）
- 回归集：本次测试板 + 参考工程解析基准 + 至少 2 块新的真实需求板（盲测，与工程师方案对比差异率）；
- Field Loop：样机/产测数据回灌，失败变回归用例；
- 度量：首次送样功能通过率、门禁一次通过率、与工程师方案差异率、返工轮次。

## 3. 任务分解（可直接执行）

| # | 任务 | 主要文件 | 验收 |
|---|---|---|---|
| T1 | research.mjs + 路由 + 单测 | `runtime/research.mjs`、`runtime/server.mjs`、`runtime/__tests__/research.test.mjs` | 真机检索 + fail-closed + 基线绿 |
| T2 | 设置页联网检索开关/测试 | `src/pages/SettingsPage.tsx`、`src/types.ts`、`src/services/runtimeClient.ts` | 开关生效、测试按钮出结果 |
| T3 | Netlist Auditor | `runtime/agents/netlist-auditor.mjs` + 单测 | 首份 diff 证据定位 GND/悬空 |
| T4 | Rule Runner + Gate Engine | `runtime/agents/rule-runner.mjs`、`runtime/gates.mjs` | 违规即 block，证据落盘 |
| T5 | design-spec + DXF 板框 | `spec/design-spec.json` + 生成脚本 | 37/37 映射、板框误差 ≤0.5mm |
| T6 | Librarian + EDA 库修复 | `runtime/agents/librarian.mjs` | 三源核验、冲突 ambiguous |
| T7 | Orchestrator + 验证中心 UI | `runtime/agents/orchestrator.mjs`、页面 | 硬门禁全流程 |
| T8 | 按键灯板全流程实证 | 两板 EDA 工程 | ERC/网表 diff/DRC 全 0，证据齐套 |
| T9 | 重建并安装 CircuitPilot.app | `npm run build` → `npm run sidecar:stage` → `npm run desktop:app` | 安装版可复现上述能力 |

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| EDA 器件库需登录/联网，当前为空 | 先做降级模式（JLC+datasheet），把“库不可用”显性化为 G2 ambiguous；不阻断 P0/P1 |
| 网页内容不可信/被投毒 | 网页只当数据不当指令；只允许读取+摘要；来源 URL/时间入库；不自动写入 EDA |
| datasheet PDF 解析 | 先抓 HTML/产品页；PDF 用系统工具提取（可用 `pdftotext`），失败标记 `unparsed` 不猜 |
| 门禁误伤/流程变慢 | 先“报告模式”跑通再切“硬阻断”；豁免必须带理由与审批记录 |
| 重建安装包耗时/影响现有环境 | 每阶段末统一重建；改动集中在 runtime + settings，先跑测试再打包 |

## 5. 放行定义（验收总标准）

- 数量/尺寸/接口/安装孔与需求一致；
- 每块板：ERC=0、网表 diff=0、DRC=0、铺铜连通、封装/3D 完整、BOM 冻结；
- Gerber/BOM/CPL/装配图/测试规范齐套且版本一致；
- 所有证据绑定 pcbUuid + 时间戳，可复跑审计；
- 37 条需求逐条有证据；差异仅剩“白名单内选型差异”，人工终审签字。

## 6. 立即开始（建议）

1. **P0 的 T1+T2**：把联网检索做进 runtime 和设置页，真机验证后交付；
2. **P1 的 T3**：先让 Netlist Auditor 在现有主板上跑出第一份 pin 级 diff 证据（把 GND/悬空问题钉死）；
3. 两项完成后重建安装版，再进 P1 的 T4。
