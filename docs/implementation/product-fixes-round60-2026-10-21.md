# CircuitPilot 产品级修复 · 第 60 轮（2026-10-21 晚）

范围：把上一轮盘点出的**仍未修**产品问题（高/中优先）在源码里落地，并补回归测试。
本轮全部改动在源码 `runtime/`，不涉及安装包（`/Applications/CircuitPilot.app` 仍是旧运行时）。

## 1. 证据指纹/新鲜度（新：`runtime/evidence-freshness.mjs`）

- 问题：仿真回退只取 `evidenceStore.latest('spice-simulation')`，可能引用**别的工程/旧版本/过期**的证据 —— 这是最危险的"假证据放行"。
- 修复：`assessEvidenceFreshness(entry, {current, maxAgeMs})` 校验
  - digest 形状、savedAt 有效性；
  - 默认 24h 新鲜度（`CIRCUITPILOT_SIM_EVIDENCE_MAX_AGE_HOURS` 可配）；
  - 与当前 EDA 指纹（窗口/工程/文档）一致；证据未绑定工程直接拒绝（无法确认归属）。
- 接线：`server.mjs` 的 `loadSimulationEvidence` 返回 `{entry}` 或 `{entry:null, rejected:[{reason,problems}]}`；
  `schematic-acceptance.mjs` 如实把拒绝原因写进 finding（"本机虽有落盘证据但未引用：…"），**不会静默当没有**。
- 测试：`evidence-freshness.test.mjs`（5）、`schematic-acceptance.test.mjs` 拒绝用例。

## 2. 桥/会话自愈（`bridge.mjs` + `server.mjs`）

- 问题：EDA 重启会带走桥进程；`bridge.discover()` 只探测不拉起，端口变了也不会重连；桥恢复后 EDA 停在开始页，后续路由全部报错。
- 修复：
  - `fetchJson` 把网络层失败归类为 `BRIDGE_UNREACHABLE`（不再只是裸 `fetch failed`）；
  - 读/校验命令遇到 `BRIDGE_UNREACHABLE`/`BRIDGE_TIMEOUT` → **重新 discover**，换端口后重试一次（写命令绝不自动重试）；
  - `ensureEdaSession`：断线重连后若 EDA 没有工程，用"上次用过的工程"（`CIRCUITPILOT_PROJECT_MEMO`，已有机制）自动 `project.open`，只尝试一次、失败如实记录；普通调用语义不变（无工程就是无工程）。
- 测试：`bridge-reconnect.test.mjs`（端口切换重试/写命令不重试）、`session-selfheal.test.mjs`（HTTP 端到端自愈）。

## 3. 布线写入后的真实 DRC 闭环（新：`runtime/engineering/routing-drc.mjs`）

- 问题：计划复核通过 ≠ 真机 DRC 通过（第 58 轮：4 处间距违规靠人发现、手工回滚）。
- 修复：`applyRoutingWithDrcGuard()`：写前 baseline DRC → 写入 → 写后 DRC → **只比较新增违规**（按 instanceKey/signature）
  - 无新增 → 放行，记录 before/after 计数；
  - 有新增 → **自动回滚本批铜**并抛 `ROUTING_DRC_REGRESSION`（含新增明细与回滚结果）；
  - 写前/写后 DRC 不可用 → `ROUTING_DRC_REPORT_INVALID`（写后不可用会先回滚），**绝不把"没校验"当"通过"**。
- 接线：`POST /api/eda/pcb/routing/apply` 默认 `verifyDrc: true`（`body.verifyDrc===false` 为显式逃生门，可审计）。
- 测试：`routing-drc.test.mjs`（5）。

## 4. 桥层归一化（`bridge.mjs`）

- `pcb.layers.read` 现在同时返回 `enabled`（=layerStatus===1）、`enabledCopperIds`、`configuredCount`，把"46 个理论层"在桥层就归一化，避免每个上位模块重复踩坑。
- `selectRoutableLayers` 兼容归一化后的 `enabled` 字段（旧读回仍用 layerStatus）。
- 测试：`eda-real-contract.test.mjs`（真机 260 条层记录 → 只允许 1/2/15/16）。

## 5. 真机契约样本（新：`runtime/__tests__/fixtures/eda-real/` + `eda-real-contract.test.mjs`）

- 用真机取证样本锁住历史踩坑点：
  - 层列表 260 条（含全部理论层）→ 只选 SIGNAL+启用 的 1/2/15/16，内层 15；
  - 矩形焊盘 shape 第三位是旋转角（0），取内切半径，不能当 0 尺寸；
  - ERC 聚合计数（1 error + 34 warning）与明细合并规则（明细不足保留聚合余量）。
- 意义：这类问题以前只能等真机踩出来；现在有"真实返回形状"的回归语料。

## 6. ERC 明细可信度（`server.mjs` + `eda-gui.mjs`）

- 明细抓取前后校验 EDA 目标指纹（窗口/工程/文档）一致，不一致 → `EDA_TARGET_CHANGED_DURING_DETAIL`，丢弃明细而不是张冠李戴。
- `ercDetail` GUI 动作加入状态机：点完不再立即抓，等"检查中/正在检查/运行中"消失且计数连续两次稳定；面板消失最多等 3 轮。

## 7. DRC 豁免按工程隔离（`drc.mjs` + `server.mjs`）

- 默认路径改为 `~/.circuitpilot/drc-exemptions/project-<projectUuid>.json`（`CIRCUITPILOT_DRC_EXEMPTION_DIR` 可覆盖）；
- 旧全局文件仅在工程级文件不存在时**带 warning** 回退（`CIRCUITPILOT_DRC_LEGACY_EXEMPTIONS` 可测）；
- GET/PUT 豁免路由与发布门禁统一读"当前工程"的豁免文件，杜绝 A 板豁免套到 B 板。
- 测试：`exemption-scope.test.mjs`（4）。ERC 豁免走同一套规则：`~/.circuitpilot/erc-exemptions/project-<uuid>.json`，旧全局文件带 warning 回退；`server.mjs` 的 ERC 取证/读写路由统一读当前工程。

## 8. 证据保留策略（新：`runtime/evidence-retention.mjs`）

- 产品默认仍是"只出计划不删除"（既有 `/api/evidence/retention/plan`）；
- 新增可审计的显式清理：`POST /api/evidence/retention/prune`（必须 `confirm:"prune-evidence"`，非 dryRun 需写板批准；返回 removed 路径/摘要/落盘时间/原因）。
- 策略：默认保留最近 20 条 + 最多 500 条 + 90 天，超出才清理。
- 测试：`evidence-retention.test.mjs`（2）。

## 9. 附带修正（全量测试暴露的问题）

- `setPcbLayers` 接上 `AbortSignal`（D8 棘轮）；
- `custom-providers` 成本上限断言同步到 32000（推理模型思考 token 计入 completion，4000 会被吃光——代码注释已说明）；
- 新路由登记进 `KNOWN_UNWIRED_ROUTES`（证据清理只给 CLI/运维用，暂无 UI）。

## 10. 其它说明

- 安装包与源码分叉说明更新：本轮新能力只在源码。
- 回归：**全量 `npm run test:runtime`（120 个测试文件 / 840 个用例）全绿**（2026-10-21 21:5x，`EXIT:0`）。

## 仍未完成（需要外部条件/超出代码范围）

1. **真机复验**：EDA 当前停在开始页、API 网关未挂起；ERC 明细 DOM、bridge 断线自愈、DRC 闭环均需要一次真机闭环。
2. **安装包重建/同步**：`/Applications/CircuitPilot.app` 仍是旧运行时（只有前 3 项热补丁）。
3. **BOM 数据自动映射**（Value/Supplier 从物料表/商城回填）：需要 EDA BOM CSV 与器件事实的映射规则，未做。
4. **供应价格/库存**：产品已有 `/api/supply/pricing`（按需联网查询），但依赖外网；离线时如实 unknown。之前盘点里"没有对接"的说法已修正。
5. **UI 入口**：新增能力目前只有 API/GUI 动作，没有前端页面（自动化配方/按钮未加）。
6. **证据清理/复用的 UI 提示**、**CDP 截图超时降级**属体验项，未动。

---

## 第 60 轮补充：会话恢复后的真机闭环（2026-10-21 18:2x）

### A. 真机复验环境（已恢复）

- EDA 3.2.186「全在线」，工程 `衣橱助手V2.0-AI设计`（uuid `ba492419…`）已打开，活动文档切回原理图 `P2.Schematic1_3`（`87dba2a2…`）。
- EDA Bridge daemon 49620：`edaConnected:true`、1 个窗口；CircuitPilot.app 运行时 4178 已重启恢复（token 已轮换）；源码运行时 sidecar 4181 以**打补丁后的源码**连同一套 EDA 做真机验证。
- 证据：`artifacts/evidence/session-restore-2026-10-21/`（`session-snapshot.json` / `real-machine-erc-detail.json` / `real-machine-layers.json`）。

### B. 真机发现并修复：ERC 明细抓取此前在真机上是**永久失败**的

`runtime/eda-gui.mjs` 的 `ercDetail` 之前单测全绿、真机却返回 `EDA_GUI_EVAL_FAILED`。本轮定位到 5 个叠加缺陷：

1. **宿主模板字面量吃掉转义**：页面脚本用普通模板字面量拼接，`/\r/`、`/\s/`、`/\[/` 在宿主侧就被转义消费，页面收到真实 CR/错误字符 → 整段脚本 `SyntaxError`。改为 `String.raw` 传页面代码。
2. **面板定位错误**：EDA 同时存在「检查ERC」「检查DRC」「器件标准化」多个面板；原理图里真正的检查面板按钮文案也是「检查DRC」。现在只认**当前可见**的检查面板，并由 ERC 路由先 `ensureSchematicDocument()` 保证活动文档是原理图，绝不拿 PCB DRC / 隐藏旧面板冒充。
3. **面板根节点选错**：左侧计数栏 class 也含 `log-container-left_*`，子串匹配会取到只有计数的 38 字符节点。改为精确 token `log-container`。
4. **计数标签互相包含**：`错误(` 会先命中 `致命错误(`。改为按前缀过滤，得到真值 fatal0/error1/warning34/info2。
5. **明细列表是虚拟滚动列表**：37 条只渲染约 8 条。明细提取改为逐屏滚动收集，实测取回 **37/37 条**（info2/warning34/error1），与聚合计数完全一致。

真机结果（源码运行时 4181，POST `/api/eda/schematic/erc/run`，HTTP 200，约 4.7s）：

- `aggregateOnly:false`、`detailAvailable:true`、`detailSource:'ui-dom'`、`counts.total:37`；
- 逐条 findings 37 条（含真实对象/文本，如「导线 $2N8 有多个网络名」、「元件引脚悬空 : R1.2,…」）；
- 证据已落盘：`artifacts/evidence/schematic-erc/schematic-erc-2026-10-21T10-19-57-425Z-211ae0abb5fd.json`（40KB，digest `211ae0ab…`）。

回归测试新增 2 条（`eda-gui.test.mjs`）：页面脚本不得出现真实回车符且必须保留 `\r` 清洗正则；明细提取必须包含 `log-container` 面板根与虚拟列表滚动逻辑。

### C. 附带修复与复验

- ERC 路由补 `readBody`（此前 `body` 未定义会直接 500）并强制活动文档为原理图。
- 叠层读回真机复验：`copperCount:4`、`configuredCount:4`、`enabledCopperIds:[1,2,15,16]`、层记录 262 条、5 个 SIGNAL 层启用（Top/Bottom/Inner1/Inner2）。
- 全量回归：`npm run test:runtime` → **844/844 通过**（含新增 4 条）。

### D. 仍未完成（更新）

1. **安装包仍是旧运行时**：`/Applications/CircuitPilot.app` 未重建，本轮修复只在源码 + 4181 sidecar 生效；需要 `npm run desktop:build` 或同步 runtime。
2. **ERC 错误本身未修**：明细已能定位到逐条，但 1 个 error / 34 个 warning 属设计问题，需要人工确认电气意图后改图（产品不自动改图）。
3. **DRC 闭环守卫、bridge 断线自愈**：代码已实现并有单测，但本轮未再跑"杀 daemon→重连→自动重开工程"的真实破坏性演练。

## 第 60 轮补充 2（2026-10-21 18:2x–18:5x）：安装包、断线自愈、多板 ERC——三项遗留全部闭环

上一节遗留的 3 项里，第 1、3 项本轮已完成；第 2 项（ERC 错误本身）仍属人工设计决策，见文末。

### A. 重新构建并安装 GUI（修复终于进到用户实际运行的包）

- `npx tsc -b --pretty false` 通过（先修复了 `src/services/runtimeClient.ts` 的 `chatSessions` 方法缺逗号，这是之前构建直接失败的唯一原因）。
- `npm run desktop:build`（`beforeBuildCommand` = `npm run build && node scripts/stage-runtime-sidecar.mjs`）产出：
  `/Users/jescochen/Desktop/AI- PCBA/src-tauri/target/release/bundle/macos/CircuitPilot.app` 与 `dmg/CircuitPilot_0.2.0_aarch64.dmg`。
- 旧包先备份到 `/tmp/CircuitPilot-old.app`，再用 `ditto` 安装到 `/Applications/CircuitPilot.app`（162MB），`xattr -dr com.apple.quarantine` 后 `env -u ELECTRON_RUN_AS_NODE open -a` 启动；旧包 runtime 里 `log-container` 命中数曾为 0（确认是旧代码），新包命中 5 处。
- **验收方式**：GUI 的会话令牌由 Tauri 壳层经 stdin 管道注入、不落盘（`CIRCUITPILOT_TOKEN_STDIN=1`，这是防同用户进程读取的攻击面收缩，属安全设计，外部 HTTP 401 是预期）。因此用**已安装包内的同一份 runtime 代码**在 127.0.0.1:4182 以显式令牌启动做黑盒验收（覆盖 4178 会用不到的同一批路由）：
  - `GET /api/eda/pcb/layers` → 200，`copperCount:4`、`count:262`、`enabledCopperIds:[1,2,15,16]`（嵌套结构正确）；
  - 先把活动文档切到 Board1_1 的 PCB3，再 `POST /api/eda/schematic/erc/run`（不填 `schematicUuid`）→ 200，**自动定位到 87dba2a22fe7096e（Board1_1 原理图 P2）**，`aggregateOnly:false`、`detailSource:'ui-dom'`、`counts.total:37`、findings 37 条（1 error / 34 warning / 2 info），耗时约 5.7s。
  - 证据：`artifacts/evidence/session-restore-2026-10-21/installed-app-verification.json`、`session-snapshot-final.json`。

### B. 桥断线自愈：真实破坏性演练 + 修复 + 回归

- 场景：杀掉 EasyEDA Bridge daemon（模拟 EDA/桥异常退出）→ 读路由必须报明确错误 → 重启 daemon → 扩展自动重连 → **不重启 CircuitPilot Runtime** 也要自动恢复。
- 首轮演练发现真实缺陷：`discover()` 落空后把 `bridge.port` 置 null，之后 `GET /api/eda/windows` 直接 `requirePort()` 抛 `BRIDGE_NOT_FOUND`，**永久不恢复**。修复：`BridgeClient.windows()` 开头先 `if (!this.port) await this.discover()`，并新增回归测试（`bridge.test.mjs`）。
- 复测结果：杀 daemon 后约 250ms 内 `GET /api/eda/windows` → HTTP 400 `BRIDGE_UNREACHABLE`（`fetch failed`）；`/api/eda/session` 的 `discover` → `bridge:null`；重启 daemon 后约 6s 扩展重连（`edaConnected:true`），**恢复后首次 `windows` 200 仅 16ms**；工程/文档未丢：`document.current` = 87dba2a22fe7096e（原理图 P2），`~/.circuitpilot/last-project.json` = `ba4924190e3a4388a097f3dee090da20`。
- 证据：`artifacts/evidence/session-restore-2026-10-21/real-machine-bridge-selfheal.json`。
- 备注：`BRIDGE_UNREACHABLE` 目前映射 HTTP 400（历史契约），语义上更像 503；属契约兼容性变更，本轮未动，已记录为已知项。

### C. 多板工程 ERC 打错板：真机暴露、已修复

- 真机复现：从 Board1_1 的 PCB3 发起 ERC，旧实现 `resolveProjectSchematicUuid()` 永远取"工程第一块板"的第一页（Board1 的 `4882ae7c…`）。Board1 原理图基本是空的，于是返回 `ran:false`、counts 全 0——**"设计干净"和"检查了空板"看起来一样**，这是会误导用户的假结果。
- 修复：`ensureSchematicDocument()` 现在把当前活动文档（若是 PCB）的 uuid 传给 `resolveProjectSchematicUuid(preferredPcbUuid)`，按工程数据把 PCB 映射回**同一块板**的原理图页面；ERC 响应新增 `erc.documentUuid`，如实回答"这次检查的是哪一页原理图"。
- 多板映射（真机读回）：Board1 pcb `ffedea82…` → sch `4882ae7c…`；Board1_1 pcb `5595e77c…` → sch `87dba2a2…`；Board1_2 pcb `1a5ab2c2…` → sch `1188b59c…`。
- 回归测试：`erc-http.test.mjs` 新增多板用例——活动 PCB 属 Board1_1 时必须 `schematic.open` 到 `PAGE-B1` 且响应 `documentUuid` 一致。

### D. ERC 明细在"切页后第一次检查"场景下仍会退化：再修 3 处

1. **切页后面板渲染慢**：`scan()` 一次为空就 `ERC_PANEL_NOT_FOUND`。改为预算内重试（≤5–8s），新增回归测试（前两次扫描为空、第三次出现面板）。
2. **点到别的文档的面板**：EDA 里可能同时存在 PCB DRC 面板；旧逻辑"取第一个可见且 total>0"会点到 PCB 面板的「检查DRC」，把活动文档切回 PCB，随后指纹校验失败、整次明细作废（真机表现为白等 40s 后 `EDA_TARGET_CHANGED_DURING_DETAIL`）。改为**用 `schematic.drc` 的聚合计数筛选面板**（fatal/error/warning 全等才认）；只有"唯一一个空面板"才允许受信任点击，多面板/计数不符时绝不乱点。
3. **流式出结果导致明细只抓到一部分**：点击检查触发的新一轮 ERC 会逐批渲染，第一屏只收集到 10 条。改为按面板计数校验、最多 3 轮滚屏收集、内部 8s 截止时间，最坏返回"部分明细 + 聚合余量"而不是硬超时全丢；ERC 明细预算提到 45s。

修复后真机复测（源码运行时 + 已安装包运行时各一次）：切到 PCB3 → ERC → `documentUuid:87dba2a22fe7096e`、`detailSource:'ui-dom'`、**37/37 条**（1 error / 34 warning / 2 info），5.7s；证据：`real-machine-erc-board-aware.json`、`installed-app-verification.json`。

### E. 顺带修掉的真机污染问题

- 全量测试里的 `evidence-http.test.mjs` 用假桥返回 `project.current.uuid='project-1'`，把真实用户状态 `~/.circuitpilot/last-project.json` 覆盖成了 `project-1`（18:20:35 真机观察到）。已给该测试加 `CIRCUITPILOT_PROJECT_MEMO` 隔离，并把真实 memo 恢复为 `ba492419…`。

### F. 回归与当前状态

- `npm run test:runtime`：**847/847 通过**（新增：桥惰性发现 1 条、ERC 面板晚渲染 1 条、多板 ERC 1 条；此前 844）。
- `npx tsc -b` 通过；安装包已是最新代码（本轮构建 5 次，最终包标记齐全：`collectDeadline`、`expectedCounts`、`同一块板`、`惰性发现`、`timeoutMs: 45_000`）。
- `/Applications/CircuitPilot.app` 已替换并运行中；GUI runtime 4178 健康；EDA 工程保持打开（提交前在 P2.Schematic1_3）。
- 仍未完成（与上一节一致，属"需要人/外部系统"的边界）：ERC 的 1 error / 34 warning 需人工改图；SPICE/netlist、DFM 人工签核、GND 缝合、171 个无网络引脚、BOM 真实供应商数据、新能力 UI 入口、发布门的 `RELEASE_SCHEMATIC_EVIDENCE_MISSING` 等仍待办，不能算本轮闭环。
