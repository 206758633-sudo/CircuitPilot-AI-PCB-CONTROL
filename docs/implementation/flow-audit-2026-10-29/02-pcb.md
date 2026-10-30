# 02 · PCB 布局 / 布线 / 铺铜 / DRC / 多层链路复审（修复后）

> **修复收口（2026-10-29 晚）**：本文件是复审当时的证据与问题清单；所列 P0/P1 已在本轮"请全部修复"中逐项落地，当前状态以 `../flow-gap-audit-2026-10-29.md` §0.1 为准。下文保留原始判定以说明修复对象，不代表仍未解决。


- **审计角色**：只读审计员（pcb-chain-auditor），不写 src/runtime/scripts/e2e，不动 EDA/Bridge，不重启服务，不做 git 操作，不跑 Playwright/live e2e。
- **审计时间**：2026-10-29（复审），基线为 `docs/implementation/flow-gap-audit-2026-10-26.md`（下称"旧审计"）及其 §2.5 修复记录。
- **审计对象**：原理图→PCB 落板同步（P0-2）、受控 PCB 计划/批准/执行、布局写回（R4）、布线/过孔/覆铜（R5）、布线收尾（P0-4）、DRC 取证与基线/回滚、叠层与多层、门禁 G1~G6 与证据链。
- **方法**：静态通读关键分支 + 隔离状态跑 runtime 单测 + 只读 HTTP/管理器级探针（内存态，不落盘、不连 EDA）+ `tsc -b` 全量类型检查。本轮**没有**真机 EDA 验证（见 §4 覆盖边界）。
- **受控写作用域**：本文件是本次审计**唯一**写入的文件。

**一句话结论**：P0-2（落板比对）与 P0-4（覆铜收尾）在**执行器/服务端分支层面**已按 fail-closed 真正落地（代码 + 单测 + 探针可复现），但两条链的**外层**仍各有未闭合口子：布线收尾/写回的 `pcb.save` 返回值未校验仍会假报"已保存"（P0-A）；受控执行/回滚未绑定目标文档 UUID，执行期间切换 PCB 文档可写错板（P0-B）。

---

## 1. 流程节点表

判定图例：✅ 已验证闭环（有代码 + 测试/探针证据）；🟨 已实现但有明确缺口（见 §3）；🟥 链路断/不可用（已诚实标注或未标注，逐条说明）；⬜ 本轮未覆盖。

| # | 流程节点 | 判定 | 证据（file:line） | 说明 / 缺口 |
|---|---|---|---|---|
| 1 | 原理图↔PCB 只读差异验收（同步前判定） | ✅ | `runtime/server.mjs:3363`（`GET /api/pcb/sync/verify`）；`runtime/pcb.mjs:92-110`；`src/pages/ValidationPage.tsx:1116-1128,1846-1875` | 只读、不写 EDA；缺件/多件/未标注分别入 `missing/extra/unannotated`，`ready` 才放行；与 P0-2 的判定同源（同一 `diffPcbAgainstNetlist`）。 |
| 2 | 同步前判定→期望位号→计划 | 🟨 | `src/pages/EdaPage.tsx:238-284`（`:248-252` 只读校验、`:254` 取期望位号、`:266` `openPcb(target)`、`:269-277` 组装 `expectations`） | 判定本身正确（已一致→不写；未标注→阻断；多件→阻断）。**缺口 C**：`pcbSyncVerify()` 未传目标 UUID，服务端按"工程内当前板"解析并会激活它，多 PCB 工程可能判错板。 |
| 3 | 受控计划归一化 + 双哈希血缘批准 | ✅ | `runtime/pcb.mjs:112-209`（`:127-146` expectations 规范化、`:148` `attachPlanLineage`、`:191-207` 操作白名单/DRC 必须最后）；`runtime/pcb.mjs:368-375`；`runtime/server.mjs:3494,3500` | 计划哈希 + semantic/compiled 双哈希绑定批准令牌与账本；旧计划（无 expectations）哈希保持稳定。 |
| 4 | 执行快照 → 阶段写入 → 逐阶段保存 → 回读 | 🟨 | `runtime/pcb.mjs:376-453`（`:382-397` 快照/指纹；`:398-411` 写前基线 DRC；`:412-444` 阶段循环 + 无 save 阶段自动保存 + 阶段回读；`:446-453` after 回读） | 快照/恢复/回读框架完整；**缺口 A**：after 只记录计数，不按写入类型断言；**缺口 D**：阶段级自动保存使"部分阶段已落盘"，与 UI "已恢复执行前快照"文案不符。 |
| 5 | `pcb.importChanges` 落板比对（P0-2） | ✅ | `runtime/pcb.mjs:463-482`；测试 `runtime/__tests__/pcb.test.mjs:263-327` | 有期望位号→回读缺件即 `PCB_SYNC_INCOMPLETE` 并回滚；无期望且纯同步空转→`PCB_SYNC_NO_EFFECT`。**缺口 B**：期望集合由调用方提供，仍可被"已存在位号"绕过。 |
| 6 | 布局写回（R4，微调/还原） | ✅ | `runtime/server.mjs:2400-2436`（默认 dryRun、写批准、写后逐项回读+几何复核、不通过自动回滚、`save:false`）；`runtime/placement-write.mjs`；`src/pages/PlacementPage.tsx:101-159` | 写回链路 fail-closed 成立。**缺口 G**：写回证据只写前端绑定（`PlacementPage.tsx:127-133`），未落 `placement` 门禁证据。 |
| 7 | 布线写回 + 官方 DRC 守卫 + 回滚 | ✅ | `runtime/server.mjs:2499-2528`；`runtime/engineering/pcb-routing.mjs:777-871`（按 ID+几何合并启发式回读、缺失即回滚并报 residual）、`:883-913`（回滚按"当前铜−写前铜"删并回读确认） | 真机合并/ID 失效等边界已按"几何+端点"兜住，且回滚要求删干净。**缺口 A（同类）**：`save:true` 时 `:860-863` 不校验保存结果。 |
| 8 | 过孔/覆铜创建（单点写） | ✅ | `runtime/server.mjs:2541-2640` | 创建后按 id/net/layer 回读；`cleanup` 验证模式删净才算通过；创建失败按泄漏 id 回收；`pcb.save !== true` → `SAVE_FAILED` + 回收。 |
| 9 | 布线收尾（重建铺铜 + 显式保存，P0-4） | 🟨 | `runtime/engineering/pcb-routing.mjs:915-973`；`runtime/server.mjs:2530-2539`；`src/components/RoutingWritePanel.tsx:146-199` | 读不到填充→`PCB_POUR_FILL_UNKNOWN` 不保存；未填充重试后→`PCB_POUR_FILL_INCOMPLETE` 不保存（均 ✅，见 §2.2）。**缺口 P0-A**：`pcb.save` 返回值未校验仍报 `saved:true`。 |
| 10 | DRC 取证（job start → poll report → 落盘） | 🟨 | `runtime/server.mjs:2757-2779`（start 已读 `body.pcbUuid`）、`:2780-2809`（report 归一化+分类+落盘全量、给 UI 500 条）、`:2811-2816`（豁免 GET/PUT 按工程）、`:2818-2822`（latest）；`src/pages/ValidationPage.tsx:378-473` | 长任务"受理+轮询"模型正确，报告落盘全量。**缺口 F**：截断口径未进执行器放行；**缺口 I**：report 分类仍用全局豁免文件；**P2**：UI 起跑/取 latest 不传 pcbUuid。 |
| 11 | DRC/ERC 结论 → 项目验证记录 + 问题中心 | ✅ | `src/pages/ValidationPage.tsx:306-336`（`recordOfficialValidation`：合并项目域记录 + findings 进问题中心 + pass 时尝试阶段推进）、`:440-461`（DRC→`buildOfficialValidationRecord`）；`src/services/validationEvidence.ts:14-92` | P1-2 修复后 DRC findings 可达问题中心（前 20 条），并只认官方报告 + projectId 归属。 |
| 12 | 叠层 / 多层设置 | ✅ | `runtime/server.mjs:2644`（GET）、`:2661-2755`（POST：写批准→before→`setCount`→读回层数/层 id/type→`pcb.save===true`→落 `pcb-layer-stack` 证据） | 官方 Beta 返回 true 不作数，读回不符 409；保存未确认 → `SAVE_FAILED`。P2：证据 fingerprint 无 pcbUuid（不进任何门禁 kind，见 §3 P2-8）。 |
| 13 | 门禁 G1~G6（布局/制造证据→判据→签字） | 🟥 | `runtime/gate-engine.mjs:12-21`（G1/G5/G6 `implemented:false`）、`:39-84`（裁决）、`:87-100`；`runtime/gates-service.mjs:27-83`；`src/pages/VerificationCenterPage.tsx:20-21,130-142,180` | 评估/签字机制本身可用且 fail-closed（非 pass 不可签）；但 G5/G6 全仓无证据生产者 → 全局 verdict 恒 `unknown` → **PCB 布局→交接签字放行这条链仍不可用**。已诚实显示"未实现"，不是假成功（P0-5 的"诚实"部分成立）。**缺口 G**。 |
| 14 | 交付/制造放行（release/gate） | ⬜ | `runtime/server.mjs:1847`；`src/services/runtimeClient.ts:674`（客户端 body 无 `layoutAudit`） | 本轮未展开（属交付链；05 号审计覆盖）。仅记录：布局审计结论尚未作为 `layoutAudit` 传入放行闸门（缺口 G 的一部分）。 |

---

## 2. 修复验证段（逐条证据 → 结论 → 边界）

### 2.1 P0-2「原理图→PCB 落板比对必须 fail-closed」

| # | 验证点 | 证据 | 结论 |
|---|---|---|---|
| V1 | 有期望位号时，写后回读缺件必须失败 | `runtime/pcb.mjs:463-475`（期望→after.components 去重大写集合→`missingDesignators`→`PCB_SYNC_INCOMPLETE`，携带 missing/expected/actual） | ✅ 成立 |
| V2 | 失败必须回滚，且失败明细进执行记录 | `runtime/pcb.mjs:506-537`（catch 置 `rollback_required`、`execution.error` 带 missing/expected/actual、restore+save+digest 校验→`rolled_back`，失败→`rollback_failed`+写锁） | ✅ 成立 |
| V3 | 无期望位号的"纯同步空转"不能成功 | `runtime/pcb.mjs:476-482`（importChanges 且全为 SYNC_ONLY 且源码摘要与器件数都没变 → `PCB_SYNC_NO_EFFECT`） | ✅ 成立（边界见 B/§2.4） |
| V4 | 单测覆盖两条路径 | `runtime/__tests__/pcb.test.mjs:263-301`（缺 R1→`rolled_back`+`PCB_SYNC_INCOMPLETE`+`missing=['R1']`+`sync-check failed` 事件；齐备→`completed`+`syncCheck.missing=[]`）、`:303-327`（无期望空转→`PCB_SYNC_NO_EFFECT`）；本轮复跑 44 pass / 0 fail（含 `pcb-routing`） | ✅ 成立 |
| V5 | UI 同步前判定（不写空转） | `src/pages/EdaPage.tsx:248-262`：未标注→`PCB_SYNC_UNANNOTATED`；已一致→提示"无需写入"并 return；仅多件→`PCB_SYNC_EXTRA` | ✅ 成立 |
| V6 | UI 执行后二次复核 | `src/pages/EdaPage.tsx:300-321`：完成后再 `pcbSyncVerify()`；仍缺件→问题中心 + danger 提示"不能算同步完成"（覆盖旧计划无 expectations 的路径） | ✅ 成立（但见边界 V7/V8） |
| V7 | **边界：期望位号由调用方提供，执行器不校验来源** | 探针 A（见 §2.6）：expectations=`['U1']`（U1 写前就已在板上）、`importChanges` 空转 → `state=completed`、`syncCheck={expected:1,actual:1,missing:[],passed:true}`；同一计划去掉 expectations → `PCB_SYNC_NO_EFFECT`+回滚 | 🟨 **未闭合**：计划 JSON 在"高级控制"里可编辑并重新校验/批准（`EdaPage.tsx:519-527,545`），手填既有位号即可绕过空转检测。产品对话路径自身正确（写前 missing>0 才执行），风险为"手改计划/复制旧计划"。→ P1-B |
| V8 | **边界：只读判定/复核未绑定目标 PCB UUID** | `EdaPage.tsx:252`（pre）、`:306`（post）均调 `pcbSyncVerify()` 无参；`runtimeClient.ts` 对应 `GET /api/pcb/sync/verify` 无 pcbUuid；`server.mjs:3363-3372` 调 `readPcbPlacement(null)`，`server.mjs:905-917` 选"当前板/工程首板"并 **激活** 该板 | 🟨 **未闭合**：多 PCB 工程中 pre-check 判的可能是另一块板（误判"已一致"→跳过真正同步；或误判差异），post-check 也可能审错板 → 假通过/假失败。→ P1-C |

**P0-2 结论**：执行器分支层面的"落板比对 fail-closed"**真修复**（V1~V6 代码+测试+探针均可复现；空转不再能报成功）。剩余是**调用方信任边界**（V7）与**目标绑定**（V8）两处外层缺口，均不影响"对话主路径"的 fail-closed，但会在高级面板/多板工程下重新制造同类假成功。

### 2.2 P0-4「覆铜收尾 fail-closed」

| # | 验证点 | 证据 | 结论 |
|---|---|---|---|
| V1 | 填充数据读不到（抛错/非数组）→ 未知、失败、绝不保存 | `pcb-routing.mjs:925-934`（`readFills` 返回 `null`）、`:961-970`（`ok=false`、`PCB_POUR_FILL_UNKNOWN`、`poursFilled=null`、不 save）；测试 `pcb-routing.test.mjs:201-215`（读抛错→`saved:false`、重建只 1 次、`save` 0 次） | ✅ 成立 |
| V2 | 重建后仍无填充（`filledFills<1`）→ 重试一次仍失败 → `PCB_POUR_FILL_INCOMPLETE`、不保存 | `pcb-routing.mjs:936-960`（重试上限后置 `PCB_POUR_FILL_INCOMPLETE`）；测试 `:180-199`（2 次 rebuild、`ok:false`、`saved:false`、`unfilledPours=['GND']`、save 0 次） | ✅ 成立 |
| V3 | 成功路径：重建→读填充→保存，且写入必须带受控授权 | `pcb-routing.mjs:971-973`；测试 `:160-178`（调用序 `pour.rebuild→poured.read→save`，写命令全部 `allowWrite`） | ✅ 成立（保存结果校验缺失，见 V5） |
| V4 | UI 必须按失败呈现（内联错误 + 问题中心 + danger，不能说"未保存"糊过去） | `RoutingWritePanel.tsx:161-180`（`ok===false`→`[code] detail · 未填充覆铜…`、`reportIssue('routing:finish:<code>')`、notify"本次没有保存"）、`:215`（`inline-alert--danger`） | ✅ 成立 |
| V5 | **边界：`pcb.save` 返回值未校验** | `pcb-routing.mjs:971-973` 无条件 `result.saved = true`；`applyRoutingPlan` 同类问题 `:860-863`；真实 `pcb.save` 是 `return await eda.pcb_Document.save()`（`runtime/bridge.mjs:423`），可能返回 false。探针 C：`save` 返回 `{result:false}` → `finishRouting` 仍 `ok:true,saved:true` | 🟥 **假成功仍存在（P0-A）**：UI 会显示"布线收尾完成…并已保存"（`:181-182`），实际铜只在内存。→ P0-A |
| V6 | **边界：`fills=[]` 视为"板无覆铜"并保存** | `pcb-routing.mjs:967-969`（空数组→`poursFilled=null`、ok 保持 true、随后 save） | 🟨 可接受但需说明：空数组与"读到了对象但形状不对→被归一成空数组"不可区分，UI 文案"当前板无覆铜"可能掩盖解析异常（低概率，真实桥返回数组）。→ P2-11 |
| V7 | **边界：失败后不自动回滚** | 失败分支在 `pcb-routing.mjs:950-970` 直接返回，前面 `pcb.pour.rebuild` 已改变内存板态；UI 建议"手动重建覆铜"（`RoutingWritePanel.tsx:172`） | 🟨 内存板态 = 已重建未保存；用户若直接保存会把未复核的填充状态落盘。→ P2-5 |
| V8 | **边界：HTTP 逃生门** | `server.mjs:2530-2539`：`rebuildPours: body.rebuildPours !== false`、`save: body.save !== false`；传 `{rebuildPours:false,save:true}` 即在无任何填充校验下保存（需 write 批准） | 🟨 调用方可绕过校验；返回体记录了实际参数但 UI 不显示。→ P2-6 |

**P0-4 结论**：`PCB_POUR_FILL_UNKNOWN` / `PCB_POUR_FILL_INCOMPLETE` 两个 fail-closed 分支**真修复**（V1~V4），"读失败不保存""没填充不保存"均有测试与 UI 呈现。但"保存本身未确认"（V5）使收尾的成功声明仍可假；失败后残留内存态（V7）与 HTTP 逃生门（V8）是明确边界。

### 2.3 相关项：门禁"诚实化"（P0-5）本轮抽查

- `runtime/gate-engine.mjs:12-21` 把无生产者的 G1/G5/G6 标 `implemented:false`，裁决返回 `not-implemented`；`gates-service.mjs:54-83` 对非 `pass` 的 signoff 一律 `GATE_SIGNOFF_BLOCKED`；UI 分开展示"未实现门"并禁签（`VerificationCenterPage.tsx:130-142,180`）。
- **结论**：✅ "不再假装只差补证据"成立；但 G5（布局）与 G6（制造放行）确实**仍无生产者**（全仓 `evidenceStore.save({kind:'placement'|'fabrication-release'})` 0 处），PCB 链的"交接签核"仍不可用 → 见 P1-G。

### 2.4 旧计划 / 旧执行记录兼容性

| 场景 | 证据 | 结论 |
|---|---|---|
| 旧计划无 `expectations` | `pcb.mjs:127-146` 仅当调用方提供才写 expectations；探针 A/B：无 expectations 时哈希/结构正常、空转走 `PCB_SYNC_NO_EFFECT` | ✅ 兼容（行为按 P0-2 收紧：旧"纯同步空转"计划现在会失败并回滚，属预期 fail-closed） |
| 旧 execution 无 `syncCheck` / 无 `readback` | 探针 E：把 `{id,state:'completed',events,snapshot}` 与 `{state:'rolled_back',error}` 注入 store → `list()`/`get()` 正常返回，无异常；`list()`（`pcb.mjs:251-262`）不读 `syncCheck`；详情即原始 JSON（`server.mjs:3322`）；历史 UI 只读 state/planHash 等（`EdaPage.tsx:436-461`） | ✅ 兼容；但旧 `completed` 记录无法追溯是否真同步（历史仍显示"完成"）→ P2-9 |
| `syncCheck` 类型契约 | `src/types.ts:361-367` 声明 `missing: string[]`，运行时 no-effect 分支写 `missing:null`（`pcb.mjs:474`）；无 UI 消费者 | 🟨 类型契约不一致（低风险）→ P2-3 |
| 旧执行记录回滚失败后的写锁 | 见 P1-E（锁不持久） | 🟨 不兼容"重启即解除" |

### 2.5 错误码在 UI / 问题中心的可达性

| 错误码 | 产生点 | 前端呈现 | 问题中心 | 结论 |
|---|---|---|---|---|
| `PCB_SYNC_INCOMPLETE` / `PCB_SYNC_NO_EFFECT` | `pcb.mjs:471,481` | 执行失败分支 `EdaPage.tsx:310-314`（先 reportIssue，再 notify danger） | ✅ code 原样入库 | ✅ 可达（但未在失败诊断 CATALOG 中，无修复建议，见 P2-1） |
| `PCB_SYNC_UNANNOTATED` / `PCB_SYNC_EXTRA` / `PCB_SYNC_PLAN_INVALID` | `EdaPage.tsx:255-278` 前置校验 | `fail()`（`:127-134`）→ `reportFailure`→`diagnoseFailure` | ✅ 可达（code 保留，`known:false`） | ✅ 可达，诊断页无专项指引 → P2-1 |
| `PCB_POUR_FILL_UNKNOWN` / `PCB_POUR_FILL_INCOMPLETE` | `pcb-routing.mjs:964,468` | `RoutingWritePanel.tsx:161-180` 内联 + reportIssue | ✅ 可达 | ✅ 可达 → P2-1（CATALOG 未登记） |
| `PCB_WRITE_LOCKED` / `PCB_ROLLBACK_*` | `pcb.mjs:377,526` | `fail()` / 执行失败分支 | ✅ 可达 | ✅ 可达；写锁无 UI 状态面板（P1-E） |

### 2.6 本轮"假成功"专项探针（内存态，不连 EDA、不落盘）

探针均为 `node --input-type=module` 一次性脚本，用假 bridge + 内存 store，**没有**写仓库文件、没有启动/重启服务。

```
A) expectations=['U1']（U1 写前已在板上）+ importChanges 空转
   => state=completed | syncCheck={"expected":1,"actual":1,"missing":[],"passed":true}
B) 同一计划去掉 expectations
   => state=rolled_back | error=PCB_SYNC_NO_EFFECT
C) finishRouting：pcb.save 返回 {result:false}
   => saved=true | ok=true | calls=pcb.pour.rebuild,pcb.poured.read,pcb.save
D) rollback_failed 后模拟 Runtime 重启（同 store 新建 PcbManager）
   => 旧 writeLocked=true，重启后 writeLocked=false；历史 state=rollback_failed 仍在
E) 注入旧格式 execution（无 syncCheck/readback）
   => list 2 条、get 正常、无异常；old-1 无 syncCheck；old-2 error.missing 保留
```

结论：A 与 C 是两个**当前仍可复现**的假成功/假完成路径（分别对应 P1-B、P0-A）；D 是"回滚失败锁不持久"（P1-E）；E 证明旧记录 UI 兼容。

---

## 3. 未解决 P0/P1 清单（按影响排序）

**计数：未解决 P0 = 2 条（P0-A 保存未确认、P0-B 文档未绑定）；未解决 P1 = 9 条（A~I）。**

> 说明：P0-A / P0-B 是**本轮新发现**，不是 P0-2 / P0-4 的回归；旧审计 §2 的 P0 条目除 P0-5 的"诚实标注"外，其余结论沿用旧审计，本轮只复核与本链路相关的部分。

### P0-A（假成功）布线收尾 / 布线写回的保存结果未校验，仍可报"已保存"

- **证据**：`runtime/engineering/pcb-routing.mjs:971-973`、`:860-863`（`saved=true` 无条件）；`runtime/server.mjs:2530-2539`（默认 `save=true`）；`src/components/RoutingWritePanel.tsx:181-195`（按 `result.saved` 显示"并已保存"）；`runtime/bridge.mjs:423`（`pcb.save` 返回原始布尔）；探针 C 已复现。
- **影响**：`pcb_Document.save()` 返回 false/非 true 时，服务端 `ok:true`、`saved:true`，UI 通知"布线收尾完成…并已保存"、审计记 success。铜/覆铜只存在于 EDA 内存，EDA 崩溃或被关闭即丢失；用户以为已落盘，后续 DRC/交付读到未保存板态。与执行器严格校验 `pcb.save===true`（`pcb.mjs:427`）不一致。
- **修法**：两条路径统一 `unwrap(result) === true` 才算保存；否则 `ok:false`、`saved:false`、`code:'PCB_SAVE_UNCONFIRMED'`（或复用 `SAVE_FAILED`），message 明确"写入/重建已生效但保存未确认"，UI 走失败分支并提示勿关闭 EDA；返回体加 `writeApplied:true` 便于审计；补单测（save→false ⇒ ok:false）。
- **验收**：`pcb-routing.test.mjs` 新增 save=false 用例（`ok:false,saved:false`，无"已保存"文案）；真机/断网场景里 `pcb.save` 失败时 UI 显示 danger 且问题中心有该 code。

### P0-B（写错板 + 回滚假通过）受控 PCB 执行/回滚未绑定目标文档 UUID

- **证据**：`runtime/pcb.mjs:382-397`（before context 只记录 `targetFingerprint/windowId`，execution 未存 documentUuid）；`:412-444`（每阶段写命令作用于"当前活动文档"，无任何 document 校验）；`:446-449`（执行后只校验 `windowId`，不校验 document uuid）；`:513-520`（回滚 `document.source.restore` 未传 `expectedDocumentUuid`，而桥**已支持**该护栏：`runtime/bridge.mjs:131-151`）；同类问题在原理图链 `runtime/design.mjs:381-388`。
- **影响**：执行可能持续数十秒到数分钟（DRC 轮询 + 分批写）。期间用户在同一 EDA 窗口切到另一块 PCB：后续写入落到错板；sync/DRC 在错板上判定；回滚把**旧板快照整份 `setDocumentSource` 写进新板**（覆盖新板源码），而回读也在新板 → 摘要与快照匹配 → 执行记录 `rolled_back`"恢复成功"，旧板仍半写。数据损坏 + 假成功，且现有 windowId 检查发现不了。
- **修法**：before 阶段保存 `documentUuid`（`before.pcb.document?.uuid` 或 `document.current`）；每个 stage 开始前校验当前活动文档 UUID，不一致 → `PCB_DOCUMENT_DRIFT`（记录 `rollback_required` + `writeLocked=true`，**不要自动 restore**，因为 restore 必然写错文档）；restore 一律带 `expectedDocumentUuid`；执行后校验 documentUuid（补齐现有 windowId 检查）；placement/routing/finish 的 save 前也做一次文档一致性检查。
- **验收**：单测：假 bridge 在第二次 `pcb.source.read` 前切换 `document.current` 为 D2 ⇒ 执行以 `PCB_DOCUMENT_DRIFT` 失败、无 restore 落到 D2（或 restore 被护栏拒绝 → `rollback_failed`+锁）、不产生 `rolled_back`；对 `design.mjs` 同规则补测。

### P1-A 执行器回读未按"写入类型"断言（问题①的答案：**未覆盖全部写入类型**）

- **证据**：`runtime/pcb.mjs:412-444`（`runOperation` 返回值除 `pcb.save`/DRC 外不校验，只把结果写事件；阶段结束仅校验源码非空、digest 记录）；`:446-453` after 只记录 component/line/via/pour/outline 计数，未与写前对比；`:484-504` 最终只由官方 DRC 裁决。
- **影响**：`pcb.outline.create` / `pcb.line.create` / `pcb.via.create` / `pcb.pour.create` / `pcb.component.modify` 若 EDA 返回成功但未生效（该 EDA 已有 `importChanges`、`setDocumentSource` 假成功先例），计划仍可 `completed`（只要 DRC 不报新增违规，而缺板框/少一段线不一定被 DRC 抓到）；UI 宣称"写入、保存、回读和官方PCB DRC 均已完成"。`importChanges` 已被 P0-2 覆盖，其余类型没有。
- **修法**：写前记录 `outline bounds/count`、`lines/vias/pours` 计数与几何指纹（或 id 集合）；写后按操作类型断言：outline 存在且 bbox 与计划一致、新增 line/via 数 ≥ 计划、pour 数变化、`component.modify` 逐项位置读回；无法可靠断言的类型在计划里显式标 `verification:'drc-only'`，并在执行结果与 UI 明示"该类型仅由 DRC 兜底"。
- **验收**：每种类型的"写接口返回成功但板面不变"假 bridge 单测 ⇒ 执行必须 `rolled_back` 且错误码点名类型；UI 不显示"完成"。

### P1-B 期望位号由调用方提供，仍可被"已存在位号"绕过空转检测（P0-2 外层边界）

- **证据**：`runtime/pcb.mjs:463-482`（expectations 分支只查"是否都在"，`PCB_SYNC_NO_EFFECT` 只在**无** expectations 的 `else if`）；`src/pages/EdaPage.tsx:515-527`（计划 JSON 可编辑并重新校验）、`:537-557`（高级执行）；探针 A 复现（completed + passed）。
- **影响**：手改/复制旧计划，把 `expectations.designators` 填成板上已有位号（或子集）⇒ `importChanges` 空转也能 `completed`，与 P0-2 要防的形态相同。混合计划（importChanges + 其他写入，无 expectations）同样可让同步空转混进成功。
- **修法**：执行前对 expectations 做"写前存在性快照"：若期望集合 ⊆ 写前 designator 集合 → `PCB_SYNC_NO_EFFECT`；expectations 分支同样要求"至少一个期望位号写前不存在、写后存在"；混合计划里若含 importChanges 且写前/写后 designator 集合无变化 → 记录 `syncCheck.reason='no-effect'` 并失败（不只纯同步计划）。
- **验收**：单测：expectations 全为既有位号 + importChanges 空转 ⇒ `PCB_SYNC_NO_EFFECT` + `rolled_back`。

### P1-C 同步只读判定/复核未绑定目标 pcbUuid（多板工程可判错板）

- **证据**：`src/pages/EdaPage.tsx:252`（pre）、`:306`（post）调 `pcbSyncVerify()` 无参；`src/services/runtimeClient.ts` 对应函数无 pcbUuid；`runtime/server.mjs:3363-3372` → `readPcbPlacement(url.searchParams.get('pcbUuid'))`（无参走 `:1010-1026` `resolveProjectPcbUuid`，`:905-917` 选"当前板/首板"并激活）；目标板来自手填 `pcbDocumentUuid`，执行前才 `openPcb(target)`（`:266`）。`ValidationPage.tsx:1121` 同样无参。
- **影响**：多 PCB 工程中，pre-check 可能对"工程里另一块板"得出"已一致，无需导入"⇒ 目标板从未同步却不再尝试；或对错板报缺件 ⇒ 无效写入尝试。post-check 可能审错板 ⇒ 假"同步完成"或假失败；服务端还会把 EDA 激活文档切走，用户以为目标板已打开。
- **修法**：`pcbSyncVerify(pcbUuid)` 传目标 UUID；服务端返回的 `pcbUuid` 与目标比对，不一致抛 `PCB_SYNC_TARGET_MISMATCH`；pre-check 前先 `openPcb(target)`（不等价于当前 `:266` 的执行前打开）；post-check 同样带目标并校验。
- **验收**：HTTP/单测用"双 PCB 工程"fixture：目标 B 时不得使用 A 的判定；不匹配时报错；UI 文案不出现"已一致"。

### P1-D 阶段级回滚仍被表述为"已恢复执行前快照"（半写残留的诚实性问题）

- **证据**：`runtime/pcb.mjs:412-444`（每阶段结束自动 `pcb.save`，若阶段无 save 操作也会保存）；`:441-444`（阶段失败把 `stageSnapshot` 挂到 error）；`:513-520`（用 `error.stageSnapshot?.source` 回滚，仅回滚当前阶段之前的状态）；UI 文案 `src/pages/EdaPage.tsx:313`、`:548`"已恢复执行前快照"；测试 `pcb.test.mjs:116-144` 明确是"回滚到 stage 快照并保留有界进度"。
- **影响**：多阶段计划（sync→outline→placement→routing→copper→validation）在中途失败时，之前的阶段已经**保存进 EDA**；执行记录 `rolled_back` + 文案让用户以为板子未动，可能直接重试/保存，留下意外板框、走线或导入器件。
- **修法**：记录 `rollbackScope: {stage, digest, retainedStages:[...已保存阶段]}`；UI/问题中心文案改为"已回滚到 `<stage>` 开始前快照；以下阶段写入已保存并保留：…"；对 outline/placement 已落盘的情况提示人工核对；愿意全量恢复时另行提供显式"恢复到执行前快照"动作（需写批准）。
- **验收**：两阶段计划（outline 成功→placement 失败）单测断言 `retainedStages` 与文案字段；UI 不再出现"已恢复执行前快照"。

### P1-E `rollback_failed` 写锁只在内存，重启即解除（回滚半写状态的阻断不持久）

- **证据**：`runtime/pcb.mjs:233`（构造 `writeLocked=false`）、`:377`（守卫）、`:526`（回滚失败置 true）；`persist()`（`:242-249`）只存 executions，不存锁；UI 错误文案"…请人工检查工程并重启Runtime"（`:377`）反而暗示重启解封。
- **影响**：回滚失败（板可能半写/错写）后，进程崩溃或用户重启 Runtime ⇒ 新实例 `writeLocked=false`，后续写板在未核实状态上继续；历史记录仍 `rollback_failed`（探针 D 已复现），但没有任何硬阻断。属于"回滚残留"风险。
- **修法**：持久化 `writeLocked` + `rollbackFailedExecutionId/at/digest`；构造时恢复锁并暴露到 `/api/pcb/executions` 与 UI 状态面板；提供显式人工解锁路由（写批准 + 审计 + 二次确认，要求粘贴回读 digest）。
- **验收**：store 注入含 `rollback_failed` 的记录 ⇒ 新 `PcbManager.execute` 抛 `PCB_WRITE_LOCKED`；解锁后放行且账本有记录。

### P1-F DRC 截断未参与执行器放行裁决（基线截断可假 pass / 假回滚）

- **证据**：`runtime/pcb.mjs:436-441`（记录 `drcMeta.truncated` 但仍取数组裁决）、`:484-504`（`drcVerdict` 只看 findings 分组计数）；`runtime/engineering/eda-jobs.mjs:24,80`（`JOB_ITEM_CAP=2000` 截断）；`runtime/drc.mjs:289` 在报告分类里把 `truncated` 当阻断（口径不一致）。
- **影响**：大板/规则刷屏时基线被截断 → 某类基线计数偏低 → 改动后若计数接近上限被判"加重"→ 误回滚（假失败）；或改动后结果被截断 → 新增类别落在截断外 → DRC 判 pass（假成功）。执行器与报告链对同一事实两种口径。
- **修法**：`drcVerdict({baseline,findings,truncated,baselineTruncated})`：任一截断 → `passed:false` 或 `unknown`（不允许静默 pass），并把 `truncated` 写进 `execution.drc` 与错误明细；与 `drc.mjs` 统一为"截断=不可放行（除非分页取全量）"。
- **验收**：单测：`truncated:true` 时不得 `completed`；基线截断时不得判 `pass`；UI 显示"DRC 结果被截断，不可放行"。

### P1-G G5/G6 仍无证据生产者 → 布局/制造门禁不可用；release gate 未接布局审计

- **证据**：`runtime/gate-engine.mjs:12-21`（G5/G6 `implemented:false`）；全仓 `evidenceStore.save` 无 `kind:'placement'`/`'fabrication-release'` 生产者（白名单在 `runtime/evidence-store.mjs:21-27`，仅类型登记）；布局写回证据只进前端：`src/pages/PlacementPage.tsx:127-133`（`applyEvidencePatch` + 本地绑定）与 `stageEvidence.ts:43-46`（`pcbPlaced` 读该绑定）；`runtime/server.mjs:2400-2436` 返回 `layoutAudit` 但未落库；`src/services/runtimeClient.ts:674` 的 `releaseGate` body 无 `layoutAudit` 字段。
- **影响**：布局复核结论不落证据台账 ⇒ G5 恒 `not-implemented` ⇒ 全局 verdict 恒 `unknown` ⇒ `gates/signoff` 永远拒绝（`gates-service.mjs:60-64`），"PCB→交接签字放行"链路不可用；release gate 无法引用布局审计，制造放行少一道复核。
- **修法**：`placement/apply` 成功后把 `{pcbUuid, auditHash, verification, approvalId, readbackDigest, at}` 以 `kind:'placement'` + `fingerprint:{pcbUuid}` 落库；`releaseGate` 接收并使用 `layoutAudit`；G5 翻 `implemented:true`；G6 由 release/gate 产出 `fabrication-release` 证据（或维持"未实现"但不在签字叙事里）。
- **验收**：真机写回一次后 `evidenceStore.list('placement')` 有绑定 pcbUuid 的条目；`gates/status` 中 G5 由证据裁决；`releaseGate` 报告引用 layoutAudit digest。

### P1-H 同步差异不阻断自动布局（"已锁定"只是文案）

- **证据**：`src/pages/ValidationPage.tsx:1846-1875`（"差异没清零就不解锁自动布局"/"自动布局：已锁定"）；`src/pages/PlacementPage.tsx:77-91`（`loadPlan` 直接调 `placementPlan`，不查同步差异）；`runtime/server.mjs:2317-2345`（placement/plan 无同步前置校验）。
- **影响**：用户可跳过"回读验收"直接自动布局并写回；页面承诺的锁定没有强制力，D5 证据链断一环但仍可继续，容易在未同步的板上布局。
- **修法**：`loadPlan` 前强制 `pcbSyncVerify` 并 `ready`（或至少显示差异并要求显式确认）；服务端 placement/plan 可选加"同步差异未清零"警告字段；文案与实现对齐。
- **验收**：差异未清零时点"生成布局方案"→ 被拒/需确认，且提示指向回读验收；UI 测试覆盖。

### P1-I DRC 豁免作用域不一致：报告分类用全局文件，编辑器写工程文件

- **证据**：`runtime/drc.mjs:56-72`（`exemptionScopePath/defaultExemptionPath` 支持 projectUuid）、`:85-104`（`loadScopedExemptionFile`）；`runtime/server.mjs:2793`（report 路由 `defaultExemptionPath()` **未传 projectUuid** → `global.json`）、`:2811-2816`（GET/PUT 走 `loadDrcExemptionFileForCurrentProject`，写 `project-<uuid>.json`）；`src/services/runtimeClient.ts:775-777`（report 请求不传 exemptionsPath）。
- **影响**：用户在验证页编辑的工程级豁免，DRC 报告分类时读不到（用的是全局文件）→ 已豁免项仍被当违规（假失败/不可放行）；反之全局文件里的旧豁免会作用于所有板（跨板污染）。
- **修法**：report 路由解析当前工程 UUID（`resolveProjectUuid`/`ensurePcbDocument` 已有上下文）并传 `defaultExemptionPath(env, projectUuid)`；或让 UI 把当前 `exemptions`/`path` 随 report 请求带上；返回体标明实际作用域。
- **验收**：工程级豁免登记后重跑 DRC → 同一条目被归为已豁免；另一工程不受影响。

---

### P2 简表（不阻断但应排期）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P2-1 | `PCB_SYNC_*` / `PCB_POUR_FILL_*` 未登记失败诊断 CATALOG，问题中心 `known:false`、无修复动作 | `runtime/failure-diagnosis.mjs`（CATALOG 无这些 code；`diagnoseFailure` 保留原 code + 通用摘要）；`EdaPage.tsx:127-134` | 给 4 个 sync code + 2 个 pour code 加诊断条目与 suggestedAction |
| P2-2 | 执行完成但 post-sync 复核**失败**时仍宣布"EDA设计执行完成…均已完成"（warning 语气）；`ok` 变量算了不用 | `src/pages/EdaPage.tsx:308-321`（`ok` 未使用；`postError` 只放 warning） | 标题改"执行完成，同步复核未完成"并降级；用 `ok` 决定是否记 success |
| P2-3 | `PcbExecution.syncCheck.missing` 类型 `string[]`，运行时可 `null` | `src/types.ts:361-367`；`runtime/pcb.mjs:474` | 类型改 `string[] \| null`，或运行时统一空数组 |
| P2-4 | `syncCheck` 不进 `list()`/历史 UI；completed-but-missing 的旧执行只能看 detail JSON，历史仍计"完成" | `runtime/pcb.mjs:251-262`；`EdaPage.tsx:436-461,640,651` | list 暴露 `syncCheck.passed/missing` 摘要；历史行加"同步复核"徽标；旧记录标"无复核证据" |
| P2-5 | 收尾失败后内存板态已改且不回滚；UI 建议"手动重建覆铜"可能诱导直接保存未复核板态 | `pcb-routing.mjs:950-970`；`RoutingWritePanel.tsx:161-180`；探针 C 同链 | 失败时尝试恢复到收尾前快照（若可行），至少把文案改为"内存已重建但未保存，请勿直接保存" |
| P2-6 | HTTP 逃生门可绕过校验：`routing/apply verifyDrc:false`、`routing/finish rebuildPours:false+save:true`、`placement save:false` 等（需写批准，返回体已记录） | `server.mjs:2499-2518,2530-2539,2400-2409` | 把逃生门收窄为"必须显式理由字段"，并在 UI/审计显著标注"本次未校验" |
| P2-7 | `pcb.component.create` 已在桥注册（Beta，单件落板），但不在执行器操作白名单，受控计划无法使用；`pcb.mjs:76-82` 注释与实现不一致 | `runtime/bridge.mjs:479`；`runtime/pcb.mjs:29` | 要么加入白名单并补"按类型回读断言"，要么在能力矩阵/注释里明确"仅供人工复核，不走受控计划" |
| P2-8 | 叠层证据 fingerprint 无 pcbUuid（`windowId/projectUuid/documentUuid`），任何按 pcbUuid 过滤的消费者都取不到；且 `pcb-layer-stack` 不是任何门禁的 requiredKind | `runtime/server.mjs:2733-2746`；`runtime/gate-engine.mjs:12-21` | fingerprint 补 `pcbUuid`；若希望叠层进 G4/G5，明确 requiredKinds 与生产者 |
| P2-9 | 旧 `completed` 记录无 `syncCheck`，无法追溯是否真同步；历史/统计仍算"完成" | 探针 E；`pcb.mjs:251-262`；`EdaPage.tsx:640,651` | 历史 UI 对无 `syncCheck` 的旧记录显示"无同步复核证据（旧版本）" |
| P2-10 | DRC 起跑与 latest 取证 UI 不传 pcbUuid：多板工程里 DRC 在"当前板"跑、latest 取任意板最新 | `src/services/runtimeClient.ts:768-773`；`src/pages/ValidationPage.tsx:380,408`；`server.mjs:2757-2764,2818-2822` | 前端带目标 pcbUuid（可与 P1-C 一起改）；latest 按 pcbUuid 过滤 |
| P2-11 | 收尾读到的填充列表为空数组时被当作"板无覆铜"（无法区分"真无覆铜"与"读取结构异常被归一成空"） | `pcb-routing.mjs:967-969`；`RoutingWritePanel.tsx:181-182` | 返回 `fillsRawKind`/`poursCount` 供 UI 说明；异常形状（非数组）已按 UNKNOWN 处理，空数组时 UI 明示"读到 0 块覆铜" |

---

## 4. 验证记录

### 4.1 执行的只读/隔离检查

| 命令 | 结果 |
|---|---|
| `CIRCUITPILOT_STATE_DIR="$PWD/.tmp/audit-state-pcb" CIRCUITPILOT_EVIDENCE_DIR="$PWD/.tmp/audit-evidence-pcb" CIRCUITPILOT_AUTOMATION_DIR="$PWD/.tmp/audit-automation-pcb" node --test runtime/__tests__/pcb.test.mjs runtime/__tests__/pcb-routing.test.mjs` | **44 pass / 0 fail**（5125 ms）。含 P0-2 两条同步用例、P0-4 两条收尾用例、回滚/超时/阶段回滚/基线 DRC/多层用例 |
| 同上环境变量 `node --test runtime/__tests__/drc.test.mjs runtime/__tests__/routing-drc.test.mjs runtime/__tests__/pcb-layers-http.test.mjs` | **24 pass / 0 fail**（134 ms） |
| `npx tsc -b --pretty false` | 无输出 = 全量类型检查通过 |
| 探针 A~E（`node --input-type=module`，内存假 bridge/store） | 输出见 §2.6；**不写仓库文件、不落盘、不连 EDA/Bridge、不启动/重启服务** |

隔离说明：三个 `CIRCUITPILOT_*` 目录都指向仓库内 `.tmp/audit-*-pcb` 独立子目录，避免污染真实 state/evidence/automation。探针只用内存对象，不触达任何持久目录；`tsc -b` 仅刷新 `tsconfig.app.json/tsconfig.node.json` 已配置的 `node_modules/.tmp/*.tsbuildinfo` 构建缓存（不产生产物文件）。

### 4.2 覆盖边界（本轮**没有**证明的东西）

- **无真机 EDA 验证**：本轮没有启动 EDA/Bridge，没有跑 `placement-live`/`sync-verify-live`（默认 skip，需 `CP_LIVE_EDA_E2E=1`）；`pcb.save` 真实返回值行为、真实 DRC 截断形态、多板工程切换文档的复现均未在真机确认（P0-B/P1-F 为静态+接口证据）。
- **无 HTTP 端到端**：没有对 `/api/pcb/execute`、`/api/eda/pcb/routing/finish` 发真实 HTTP 请求（PcbManager/ApprovalStore 直接用单测与探针覆盖；HTTP 层只做代码审读）。
- **无 Playwright/UI 截图**：UI 结论来自代码审读（按钮文案、分支、`data-testid`），未做浏览器交互验证。
- **未重启 Runtime / 未跑 live e2e / 未改任何源码、测试、脚本、配置**；未做任何 git 操作。
- **抽样限制**：`runtime/placement.mjs`（807 行）、`runtime/engineering/layout-rules.mjs`（1324 行）、`middleware`/自动化配方等只按调用链抽查，未逐行通读；布局算法正确性不在本轮范围（只审"写回/证据/门禁"链路）。

### 4.3 与旧审计的对应关系

- 旧审计 §2 P0-2（落板同步）→ 本轮 §2.1：**执行器层面确认修复**，新增 V7/V8 两个外层边界。
- 旧审计 §2 P0-4（覆铜收尾）→ 本轮 §2.2：**两个 fail-closed 分支确认修复**，新增 V5（保存未校验，P0-A）/V6~V8 边界。
- 旧审计 §2 P0-5（门禁诚实化）→ 本轮 §2.3：诚实标注成立；G5/G6 仍无生产者（P1-G）。
- 旧审计 §3 P1 中与本链路相关且**仍未修**：P1-2（DRC findings 进问题中心）本轮**已修**（`ValidationPage.tsx:306-336`）；P1-3（DRC 豁免作用域）→ 本轮 P1-I；P1-4（128 条布局规则未进放行）→ 本轮 P1-G（release gate 不收 layoutAudit）；其余（DRC 结论口径、写互斥、无消费者路由）未在本轮展开，沿用旧审计结论。

---

*本文件由只读审计生成；所有行号基于审计时工作区（2026-10-29），修复后请同步更新行号。*
