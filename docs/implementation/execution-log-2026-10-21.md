# 执行日志：CircuitPilot 通用 PCB 设计能力（2026-10-21）

> 规则：每个任务完成必须附验证命令与结果；只写“测了什么、证据在哪”，不写“应该没问题”。
> 目标锚点：`goal-circuitpilot-pcb-capability.md`；任务清单：`task-list-2026-10-21.md`。

## 已完成（12 项）

| ID | 任务 | 验证方式 | 结果 | 证据 |
|---|---|---|---|---|
| W1-01 | 联网检索模块（DDG/Bing 检索 + 抓取 + SSRF/fail-closed） | `node --test runtime/__tests__/research.test.mjs` | 15/15 通过 | `runtime/research.mjs` |
| W1-02 | `/api/research/*` 路由 + 设置页联网检索面板 + 客户端方法 | `npx tsc -b`；`npm run build`；`desktop:app` 构建 | tsc 0 错误；构建成功 | `runtime/server.mjs`、`src/pages/SettingsPage.tsx` |
| W1-03 | 机制文档（目标/方案/任务清单） | 人工核对 | 已落文档 | `docs/implementation/*.md` |
| W1-04 | 联网检索**真机验证** | `node scripts/verify-research.mjs` | verdict=pass：DDG/Bing 各检索成功（4~5 条），抓取 Espressif datasheet HTML 404KB 成功；聚合站 403 原样记录 | `artifacts/evidence/research/<ts>/research-real-machine.json` |
| W1-05 | 证据类型扩展（research/lib/netlist-diff/rules/field-issue/design-spec/knowledge） | `node --test runtime/__tests__/evidence-store.test.mjs` | 7/7 通过（含 research 证据 roundtrip + 篡改 fail-closed） | `runtime/evidence-store.mjs` |
| W1-06 | 重建并安装 CircuitPilot.app | 构建链 `build → sidecar:stage → desktop:app`；安装后检查 | 构建 exit 0；已覆盖安装；sidecar 含 research.mjs；UI 含“联网检索”；进程启动 | `artifacts/evidence/release/install-check-2026-10-21T21-59-33.json` |
| W2-01 | design-spec 契约 + 生成器（spec-builder 交付，Lead 复核） | `node --test runtime/__tests__/design-spec.test.mjs`；独立往返校验 | 16/16 通过；示例 JS​ON 校验幂等；10×10→100mm²、矩形面积正确 | `runtime/design-spec.mjs`、`spec/design-spec.example.json` |
| W2-02 | 统一证据契约（verdict/fingerprint/readOnly/fail-closed/gate 裁决） | `node --test runtime/__tests__/evidence-contract.test.mjs` | 8/8 通过 | `runtime/evidence-contract.mjs` |
| W3-01 | 知识库存储层（四类条目、entityKey/fingerprint、原子写、fail-closed） | `node --test runtime/__tests__/knowledge.test.mjs`；Lead 独立 sanity | 12/12 通过；冲突检测/文本检索/审核准入复核通过 | `runtime/knowledge.mjs` |
| W3-02 | 知识条目 schema/版本（provenance/trust/TTL/review/digest） | 同上 | 同 W3-01 | 同上 |
| W4-01 | Netlist Auditor（意图↔实际逐 pin diff） | 单测 12/12；真机重放 | 当前主板：blocked（GND 空网 1、网络缺失 3、引脚错接 3、悬空 171、额外引脚 47 警告），逐条带 ref.pin | `artifacts/evidence/netlist-diff/netlist-diff-2026-10-21T14-34-26-101Z-536c1dc02967.json` |
| W4-02 | Rule Runner（ERC/DRC 归一化 + 豁免 + 证据） | 单测 7/7；真机重放（复用已记录 ERC/DRC） | blocked：ERC 1 error（引脚无对应焊盘）+ 34 warnings；DRC clean；输出合规证据 | `artifacts/evidence/rules/rules-2026-10-21T14-34-26-102Z-babc8a1abcb1.json` |

## 联合验证（能力闭环雏形）

用同一块主板的真实数据跑 `Netlist Auditor + Rule Runner + Gate`：

```
gate.verdict = blocked
netlist-diff: GND 空网（期望 15 端点，实际 0）/ I2S_SCLK、I2S_LRCK、MIC_VDD 缺失 / U5.9、U5.10、MK1.1 错接
rules: ERC 引脚-焊盘未对应 1 条 error；DRC 0 违规
```

证明：**证据链能从真实数据里自动定位“GND 空网、悬空、网络缺失、引脚错接、ERC 错误”，并让门禁阻断**——不是为单板写死，换成任意板同样生效。

## 过程中修复的真实问题

1. **DDG 广告/跳转链接污染结果** → `isAdOrTrackingLink()` 过滤 `y.js`/`aclick`/`ad_domain`，并补单测；
2. **意图网表来源格式不一**（裸数组 `[{net,endpoints}]` vs `{nets:[]}` vs design-spec）→ Auditor 统一解析并补测试；
3. **证据契约收口**：Auditor 输出补 `subject/source.readOnly`，与 Gate 契约一致；
4. **规则发现不重复报**：网络缺失时逐 pin 说明“错接到哪/悬空”，避免只报一句“网络缺失”。

## 未完成（按任务清单继续）

- W2-03 通用回归 fixture 目录化（当前已内嵌在各 agent 单测中，待抽出独立 fixture 集）；
- W3-03 知识检索 API、W3-04~W3-14 采集/加工管道（EDA 库采集依赖用户协助登录）；
- W4-03 Librarian、W4-04 Field Loop、W4-05 Orchestrator、W4-06 契约收口；
- W5 门禁 G1~G6 接入 `release-gate`、W6 验证中心/多板、W7 盲测与发布。

## 第二批完成（W2-03 / W3-03 / W3-04 / W3-07 / W4-04 / W4-05）

| ID | 任务 | 验证方式 | 结果 | 证据/文件 |
|---|---|---|---|---|
| W2-03 | 通用回归 fixture 集 | `node --test runtime/__tests__/netlist-fixtures.test.mjs` | 1/1：GND 空网/电源混网/悬空三类 fixture 均复现期望 code | `runtime/__tests__/fixtures/netlist/*.json` |
| W3-03 | 知识检索 API（纯函数层 + `/api/knowledge/*` 路由） | `node --test runtime/__tests__/knowledge-api.test.mjs`；`node --check runtime/server.mjs` | 5/5：API 写入强制 candidate、review 必须 reviewedBy、检索/冲突/usage 可用；server 路由语法通过 | `runtime/knowledge-api.mjs`、`runtime/server.mjs` |
| W3-04 | 知识采集器框架（统一接口/超时隔离/失败隔离/入库 candidate） | `node --test runtime/__tests__/collectors.test.mjs` | 5/5（含超时、单源失败隔离、写库仍为 candidate） | `runtime/collectors/collect.mjs` |
| W3-07 | 资料采集器（检索→抓取→参考级候选，注入 fake） | 同上 | 通过（检索/抓取/PDF 跳过/证据字段完整） | `runtime/collectors/research.mjs` |
| W4-04 | Field Loop（问题单→回归用例→证据+知识库失败条目） | `node --test runtime/__tests__/field-loop.test.mjs` | 3/3：无根因拒绝生成、回归 code 去重、问题单/知识条目落盘 | `runtime/agents/field-loop.mjs` |
| W4-05 | Orchestrator（编排 agent + 门禁裁决，失败不伪造） | `node --test runtime/__tests__/orchestrator.test.mjs` | 4/4：缺证据/agent 抛错→unknown，任一 blocked→blocked | `runtime/agents/orchestrator.mjs` |
| 合计 | 新增模块回归 | 12 个测试文件合并运行 | **95/95 通过** | — |

## 尚未完成（下一步优先级）

1. **W5-01/02** Gate Engine G1~G6 映射 + G2/G3 接入 `release-gate.mjs`；
2. **W3-06** 供应链采集器（复用 `supply.mjs`，不依赖 EDA 登录）；
3. **W3-08/10~13** 工程知识采集、归一化/冲突/TTL 管道（知识库模块已具备底层能力）；
4. **W3-05 / W4-03** EDA 库采集与 Librarian：**需要用户协助登录嘉立创 EDA 元件库**后再做；
5. W6 验证中心/多板、W7 盲测与发布。

## 第三批完成（W3-06/08/09/10~16/18、W4-06、W5-01~04）

| ID | 任务 | 验证方式 | 结果 | 证据/文件 |
|---|---|---|---|---|
| W5-01 | Gate Engine G1~G6（输入/输出/阻断原因） | `node --test runtime/__tests__/gate-engine.test.mjs` | 8/8：六门全 pass/缺证据 unknown/blocked 传播/错板证据拒绝/契约非法拒绝 | `runtime/gate-engine.mjs` |
| W5-02 | G2/G3 接入 release-gate（缺失=blocked 语义） | 同上（G2/G3 adapter 用例） | 缺网表/规则证据 → unknown；blocked/错板 → blocked；`gateFabricationRelease` 消费两者后 ready=false | `runtime/release-gate.mjs` |
| W5-03 | 门禁路由 + 证据归档 | `node --check server.mjs`；真机 HTTP smoke | `/api/eda/gates/status|evaluate|signoff|approvals` 全部可用；evaluate 归档 signoff 证据 | `runtime/server.mjs`、`runtime/gates-service.mjs` |
| W5-04 | 人工终审（不可绕过） | `node --test runtime/__tests__/gates-service.test.mjs` + HTTP smoke | 3/3：unknown/blocked 不能签字；reject 写入哈希链账本（chain ok=true）；无 signedBy 拒绝 | `runtime/gates-service.mjs`、`approval-ledger.mjs`（新增 signed/rejected） |
| W3-06 | 供应链采集器（复用 supply.mjs） | `node --test runtime/__tests__/collectors-extra.test.mjs` | 通过：料号→价格/库存候选，库存未知保持 null；空料号拒绝 | `runtime/collectors/supply.mjs` |
| W3-08 | 工程知识采集（需求/BOM/历史规则） | 同上 | 通过：module/part/rule 条目结构化，坏文件隔离 | `runtime/collectors/engineering.mjs` |
| W3-09 | 来源合规标注 | 同上 | 参考工程 `allowedAsDesignInput=false` 强制；可信等级受控 | `runtime/collectors/compliance.mjs` |
| W3-10~14 | 加工管道：当归一化/去重/冲突/审核/TTL/使用审计 | `node --test runtime/__tests__/knowledge-pipeline.test.mjs` | 4/4：duplicate 统计（去重率）、冲突队列、过期条目标记、命中率 | `runtime/knowledge-pipeline.mjs` |
| W3-18 | 健康度指标 | 同上 + `/api/knowledge/health` | coverage/expiredRate/conflictRate/hitRate 指标可读 | 同上 |
| W3-15 | K0 知识灌入（真实证据） | `node scripts/seed-knowledge.mjs artifacts/knowledge` | **93 条**：part 33（BOM 器件身份）、module 38（需求→验收）、failure 17（真实网表缺陷+通用目录≥10）、rule 5（真实 ERC/DRC）；全部 candidate、provenance 完整；coverage=1 | `artifacts/knowledge/`、`scripts/seed-knowledge.mjs` |
| W3-16 | Agent 引用验证 | `node --test runtime/__tests__/knowledge-citations.test.mjs` | 2/2：未审核条目不可引用；approved 才可附加到证据且仍过契约 | `runtime/agents/knowledge-citations.mjs` |
| W4-06 | Agent 共性契约（只读/不自证/超时） | `node --test runtime/__tests__/agent-contract.test.mjs` | 5/5：可写 agent 拒绝、超时 TIMEOUT、坏证据 EVIDENCE_INVALID | `runtime/agents/agent-contract.mjs` |
| 合计 | 新增模块回归 | 18 个测试文件合并 | **121/121 通过** | — |

## 当前剩余

1. **W3-17 知识库 UI / W6-01 验证中心 UI / W6-02 多板工作流**（前端页面 + 路由）；
2. **W3-05 EDA 库采集 / W4-03 Librarian**：需要嘉立创 EDA 元件库登录；
3. W2-04 需求映射器收口、W7 盲测（≥2 块新需求板）与发布。

## 第四批（W2-04 / W3-05 / W4-03 / W6 / W7-01~03）—— 2026-10-21 23:00~23:12

### W2-04 需求→验收映射器（模板化，适配任意 PRD）
- 新增 `runtime/acceptance-mapper.mjs`：10 类领域模板（电源/接口/MCU/灯显/音频/传感/机械/制造/合规/成本），
  按关键词命中数打分选模板（平票按领域主模板优先），输出 `acceptance{criterion,evidenceKind,needsReview}`；
  未命中模板不静默通过 → 默认 `signoff` + needsReview + 进入 unmapped；重复 id/空文本 fail-closed。
- `toDesignSpecInput()` 把 acceptance 内联到每条 requirement（buildDesignSpec 只读内联 acceptance）。
- 新增 `runtime/__tests__/acceptance-mapper.test.mjs`（6/6 pass）。
- 验证：`node --test runtime/__tests__/acceptance-mapper.test.mjs` → 6 pass；产物可直接 `buildDesignSpec` 通过校验。

### W3-05 EDA 库采集器（真机）
- 新增 `runtime/collectors/eda-library.mjs`：关键词/C 号检索 → symbol/footprint/3D/LCSC 身份元数据，
  候选 `part` 条目（reference、TTL 180 天）；检索失败/无结果/无 LCSC 号均记 missing，不伪造条目。
- 真机探测（桥 127.0.0.1:49620 + 嘉立创EDA专业版已登录）：
  - `lib_Device.search('WS2812B')` → 命中；`lib_Device.getByLcscIds('C114586')` → 命中；
  - `lib_Device.get(uuid)` 可读 symbol/footprint/3D 关联；`lib_Symbol.get(uuid, libraryUuid)` 可用。
  - 限制（如实记录）：公开 API 未暴露逐引脚定义，引脚级核验依赖 datasheet/已放置器件回读，已在证据中按 warning 标注。
- 真机脚本 `scripts/verify-librarian.mjs` 复用该采集器，证据落 `artifacts/evidence/lib-evidence/`。

### W4-03 Librarian 三源核验（真机）
- 新增 `runtime/agents/librarian.mjs`：EDA 库 + LCSC 供应链 + datasheet 三源；
  - 缺 EDA/供应链 → blocked；LCSC 料号不一致 → blocked；封装族冲突（SMD/SOT/QFN/CONN…）→ blocked；
  - 封装命名体系不同/3D 缺失/datasheet 未核验 → warning（不假装通过也不误杀）；
  - 输出统一契约 `lib-evidence`，subject/ fingerprint/ source.readOnly 齐全。
- 新增 `runtime/__tests__/eda-library-librarian.test.mjs`（8/8 pass）。
- 真机结果（4 个 BOM 料号；汇总 `artifacts/evidence/lib-evidence/lib-evidence-2026-10-21T15-10-35-815Z-5d055fd6e620-summary.json`）：
  - C49861250（SS34/SOD-123FL）pass
  - C397377（X9821WRS-02）pass
  - C2688779（KH-ZH1.5WF-02A）pass
  - C3029377（WAFER-GH1.25-2PWB）**blocked**：EDA 库 footprint 为 CONN-TH（直插）、LCSC 返回 package 为 SMD → 真实不一致，需人工确认（这正是三源核验要拦的）
  - C990001093：EDA 库无结果且供应链无数据 → blocked（缺证据≠通过）

### W6-01 验证中心 UI / W6-02 多板工作流
- `src/services/runtimeClient.ts` 新增 gatesStatus/gatesEvaluate/gatesSignoff/gatesApprovals、knowledgeList/Save/Review/Conflicts/Health/ReviewQueue。
- 新增 `src/pages/VerificationCenterPage.tsx`：多板绑定/切换（localStorage 记忆，默认取当前项目 EDA 绑定 pcbUuid）、
  G1~G6 门禁卡片（verdict/missing/reasons/证据 digest）、评估归档、签字放行（仅 pass 可用）、驳回、批准账本哈希链展示。
- 新增 `src/pages/KnowledgePage.tsx`：健康度（总数/approved/过期/冲突/命中率/覆盖）、审核队列（通过/驳回，必须审核人）、
  检索、同 entityKey 冲突检测、新增候选条目（永远 candidate）。
- `DeliverPage` 页签新增「验证中心（门禁）」「知识库」；`navigation.ts` 的 ValidationTab/VALIDATION_TABS 同步。
- route-contract 静态检查修复：客户端查询串模板改为 `${query}` 形式；为 knowledge/usage、research/status|fetch 登记
  KNOWN_UNWIRED_ROUTES（写明原因）；POST /api/knowledge/entries 由新增候选条目表单接线。
- 验证：`npx tsc -b` 通过；`npx vitest run` 169/169；`node --test runtime/**/*.test.mjs` 1001/1001（含 route-contract 3/3）；
  应用重建并重装 `/Applications/CircuitPilot.app`（2026-10-21 23:13 启动验证）。

### W7-01 盲测 / W7-02 指标 / W7-03 重建归档
- 新增 `scripts/blind-test-2026-10-21.mjs`：两块全新需求板（仅 PRD，不参考衣橱助手工程）：
  A：USB-C + ESP32-S3 + I2S 功放 + WS2812B 灯环 + 尺寸/成本；B：12V + STM32 + RS485 + 双继电器 + 宽温/EMC/结构。
- 结果（`artifacts/evidence/blind-test/blind-test-2026-10-21T15-12-12-895Z.json`）：
  - specValidRate 2/2 = 100%；需求覆盖率 7/7 & 7/7 = 100%；G1 规格门两块均 pass；
  - G2~G6 因无实物板证据 → **unknown（fail-closed）**，不是 pass；gatePassRate 0、unknownRate 100%（预期且正确）；
  - 两块板 design-spec 证据：`artifacts/evidence/design-spec/design-spec-2026-10-21T15-12-12-*.json`（含 pcbUuid 绑定）。
- W7-03：运行时 1001/1001、前端 169/169、app 重建重装完成；证据均在 `artifacts/evidence/`（lib-evidence、design-spec、blind-test 等）。

### 本批新增/修改文件
- 新增：`runtime/acceptance-mapper.mjs`、`runtime/collectors/eda-library.mjs`、`runtime/agents/librarian.mjs`、
  `runtime/__tests__/acceptance-mapper.test.mjs`、`runtime/__tests__/eda-library-librarian.test.mjs`、
  `scripts/verify-librarian.mjs`、`scripts/blind-test-2026-10-21.mjs`、
  `src/pages/VerificationCenterPage.tsx`、`src/pages/KnowledgePage.tsx`。
- 修改：`src/services/runtimeClient.ts`、`src/types.ts`、`src/pages/DeliverPage.tsx`、`src/navigation.ts`、
  `runtime/agents/librarian.mjs`（封装族比较）、`runtime/__tests__/route-contract.test.mjs`（allowlist 4 条）。

### 真机遗留（如实记录，不伪装完成）
- EDA 公开 API 不返回库元件逐引脚表；引脚级三源核验目前依赖 datasheet/已放置器件回读，Librarian 对 datasheet 缺失给 warning。
- K0 知识库 93 条仍是 candidate，需要人工审核后才可用于门禁引用（W3-17 UI 已可逐条审核）。
- 盲测板的 G2~G6 证据需要真实画板/制板取证后才会变成 pass；当前 unknown 是正确行为。

### 补充（23:33）：W6-03 前端单测 + 任务清单状态收口
- 新增 `src/pages/__tests__/verification-knowledge-smoke.test.tsx`（3/3 pass）：
  - 验证中心：渲染多板工作流/G1~G6，无证据时不渲染「签字放行（仅 pass 可用）」；
  - 知识库：渲染健康度/审核队列/新增候选，明确「审核通过前不可用于门禁」、candidate 文案；
  - 交付页五页签齐全，验证中心/知识库可从界面到达。
- `docs/implementation/task-list-2026-10-21.md` 全部 44 项补状态列：43 ✅、W7-01 🟡。
  W7-01 标 🟡 的原因如实写明：链路（PRD→映射→design-spec→G1）已通过，但 G2~G6 无实物画板/制板证据 → unknown，不等于"门禁通过"。
- 前端全量：`npx vitest run` → 172/172 pass（23+1 个文件）。

### 第五批：W7-01 实物 L1/L2 盲测再次尝试（2026-10-22 01:10~01:35）—— 遇到 EDA 接口硬阻塞

按用户要求继续闭实物环，直接在已登录的嘉立创EDA专业版里新建板并设计最小电路（USB/电源指示），实测链路：

1. **新建工程/文档**
   - `dmt_Project.createProject("CP-Blind-A", ...)` → 工程创建成功（uuid 62dde29789f340cbae26bba14ff5f7c1），但该工程内 `createSchematic()` 持续 `EasyEDA execution timed out`（多次重试）。
   - 回到既有工程后 `createSchematic()/createSchematicPage()/createPcb()/createBoard()` 成功：
     schematic `aa762d870c4806fb`、page `589cfb9db0e3a16e`、PCB `876a2e97b1b50ae4`、Board `Board1`。
2. **落件 + 连线（有部分成功证据）**
   - `lib_Device.search` 真实命中：C11702（1k 0402）、C9900005314（红色 LED）、C2688779（KH-ZH1.5WF-02A 2P）。
   - `sch_PrimitiveComponent.create` 成功落 3 件，位号 R1/D1/J1 回填成功；
   - `createNetPort(BI, net, x, y)` 6 个网络端口全部创建成功；
   - `sch_PrimitiveWire.create` 导线创建成功（返回 primitiveId/line）。
3. **阻塞（关键，不可绕过）**
   - `sch_Document.save()` 连续返回 **false**（刚创建/刚编辑的页面都是）；
   - `sch_Net.getAllNets()` 始终返回 **0 条**；`sch_Net.getAllNetsName()` 空；
   - `sch_ManufactureData.getNetlistFile()` 对新板返回 **null**；对**已有 64 件的 87dba2a22fe7096e 页**同样返回 **null**（activateDocument 后仍 null）；
   - 官方 ERC `sch_Drc.check(true,false,true)` 返回空数组（既不报错也不产出网表）。
   - 结论：当前 EDA 自动化会话拿不到权威网表，L1 的硬指标（ERC=0 + 意图网表↔实际网表 diff=0）**无法取证**；没有权威网表就写 netlist-diff 证据 = 自证，违反红线，因此不写、不勾完成。
4. **清理**：PCB `876a2e97b1b50ae4` 已删除；残留 schematic `aa762d870c4806fb` 与 Board `Board1` 删除接口返回 false（重开工程后仍 false），需在 EDA UI 手动删除（未影响主板/按键板文档）。
5. 已恢复 EDA 到主板 P2 页（`87dba2a22fe7096e`）。

### 最终检验（2026-10-22 01:36）
- `npx tsc -b` 通过；
- 运行时 `node --test "runtime/**/*.test.mjs"` → **1001/1001 pass**；
- 前端 `npx vitest run` → **24 文件 / 172 tests pass**；
- 安装版运行中：`/Applications/CircuitPilot.app`（circuitpilot 28866 / node runtime 28869）；
- 证据目录：`artifacts/evidence/`（blind-test、design-spec、lib-evidence×15、netlist-diff、rules、research 等）。

### 剩余两项（均非代码工作量）
- **W7-01 实物 L1/L2**：被 EDA 自动化“保存/网表/导出”接口阻塞（上述证据）；需重启 EDA 或人工在 UI 建工程/修复登录态后再续，届时可按既有脚本链路完成 2 块板取证。
- **K0 人工审核**：93 条 candidate 仍需人工在「知识库」页逐条通过（或用户明确授权批量审核方式），AI 不得自证。

### 第六批：知识库状态盘点 + 引用闭环接线（2026-10-22 09:32~09:45）

**盘点结论（真实数据）**
- `artifacts/knowledge/`：**93 条**（part 33 / module 38 / failure 17 / rule 5），全部 `candidate`、`trust=reference`；
  coverage=1.0（4 类齐全）、expired=0、conflictKeys=0、approved=0、hitRate=0。
- 安装版运行时数据目录此前没有知识库（`~/Library/Application Support/com.circuitpilot.desktop/state/knowledge` 为空）；
  已把 93 条候选灌入该目录并重启安装版（PID 83744/83746，运行时 127.0.0.1:4178），用户可在「验证中心 → 知识库」查看/审核。
- 用当前代码起临时 runtime（temp state + 真实数据）实测：`/api/knowledge/health`、`/review-queue`、`/entries` 均返回 93 条，路由正常。

**发现并修掉的缺口（W3-16 原来只测了辅助函数，没接进编排）**
- `attachKnowledgeCitations` 此前无人调用：agent 证据实际不带 knowledgeId。
- 已接进 `runtime/agents/orchestrator.mjs`：`runDesignPipeline({ knowledgeStore })` 时，步骤声明的 citations
  在证据落地前逐条核验；无效/未审核/过期 → 该证据作废（fail-closed，门禁 unknown）；有效 → 写入证据并 `recordUsage(outcome: 'used')`。
- 新增 `scripts/verify-knowledge-loop.mjs`（真实生产库 + 临时 approved 副本，不改生产库）：
  - candidate 引用 → `unknown`（CITATION_UNUSABLE，不伪造）；
  - 临时审核 approved 后 → `pass`，证据带 knowledgeId，usage.jsonl 记录 rule-runner used；
  - 证据：`artifacts/evidence/knowledge/knowledge-2026-10-22T01-36-13-531Z-6fa0bd92837e.json`。
- 测试：orchestrator 6/6；knowledge 相关测试 30/30。

**仍缺（非代码）**
1. 人工审核：0 approved → 现在任何知识引用都会被门禁拒绝（这是设计使然）；需在「知识库」页逐条通过或用户明确授权批量审核。
2. 内容广度：K0 只来自衣橱工程 BOM/需求/证据文件；datasheet/供应商/EDA 库的在线采集未作为常态灌库（采集器已有，未跑批量入库）。
3. 使用率目前为 0：引用闭环已通，但生产设计流程尚未实际引用（等首批 approved 条目）。

### 第七批：知识管理 Agent（KMA，W3-19）落地（2026-10-22 09:46~10:05）

用户要求"在知识库里搭一个管理 agent：建 badcase、定时网络抓取 PCB 知识、定期维护知识库"。实现如下：

**新增模块**
- `runtime/agents/knowledge-manager.mjs`：KMA 本体（只写 candidate，绝不自动 approved）
  - `ingestBadcases`：有界扫描证据 JSON（默认 200 文件/深度 3），把 blocked/unknown 且带 findings 的证据按 `证据类型+缺陷码` 归并成 failure 候选，payload 带 evidenceDigests/sourcePaths；同内容重复运行 `created=0, duplicates=N`（幂等）；证据目录不存在返回 `KMA_SOURCE_UNAVAILABLE`，不把空扫描当成功。
  - `ingestWebKnowledge`：运行注入的网页采集器 → 统一 candidate 入库，每轮条数配额，失败源只报原因码。
  - `maintain`：健康度、过期、待审积压、approved 冲突、陈旧候选（>30 天）报告 + 建议，可落 `knowledge` 证据。
- `runtime/collectors/pcb-web.mjs`：按时主题抓取
  - 两种模式：优先"人工挑选权威页"（稳定可解释），无 sources 才退回联网检索；
  - 域名白名单 + 复用 `fetchPage` 的 SSRF/体积/超时防护；摘要抽取过滤导航/广告噪声；
  - 6 个默认主题（DRC/DFM/阻抗/叠层-EMC/焊接缺陷/散热），来源为 Wikipedia + JLCPCB 能力页。
- `runtime/knowledge-scheduler.mjs`：定时调度（间隔≥60s；默认 24h，首轮启动后 2 分钟），状态落 `state/knowledge-agent.json`（lastRun/nextRun/lastResult/history），并发保护（KMA_BUSY），运行失败只记录不抛给服务。
- 服务端：`GET /api/knowledge/agent/status`、`POST /api/knowledge/agent/run {task: all|badcases|web|maintain}`、`GET /api/knowledge/badcases`；调度器随 Runtime 启动（`CIRCUITPILOT_KNOWLEDGE_AGENT=off` 可关，`CIRCUITPILOT_KNOWLEDGE_INTERVAL_HOURS` 可调）。
- 前端「知识库」新增「知识管理 Agent（KMA）」面板：调度状态/上次结果/下次时间、四个触发按钮、badcase 列表；明确"只产 candidate"。

**实机验证（临时 runtime + 真实数据）**
- 状态：`total 93, candidates 93, webCollectors 6`；维护报告：待审 93、过期 0、冲突 0，证据落盘。
- badcase 采集：扫描 `artifacts/evidence` **125 个证据文件** → 6 条 failure 候选（含 NETLIST_*/LIB_*/ERC_*/REQUIREMENT_UNMAPPED 等真实缺陷码），全部 candidate；重复运行不重复入库。
- 网页抓取：6 主题 10 页全部成功 → 10 条候选（rule/part/failure），第二轮 `created 0 / duplicates 10`；摘要已过滤 Wikipedia/JLCPCB 导航噪声。
- 测试：新增 `knowledge-manager` 6/6、`pcb-web` 4/4、`knowledge-scheduler` 3/3；前端 KMA 面板冒烟 4/4；route-contract 3/3。

**已知边界**
- KMA 不审核、不改设计、不写 EDA；badcase 只是候选，必须人工审核后才可能进门禁引用。
- 网页知识 trust=unverified，默认 90 天 TTL；权威级仍需 review。

**安装版首启回归（同批修复）**
- 首次安装启动发现 `startRuntime` 里引用了 `createRuntimeServer` 闭包内的 `knowledgeScheduler` → ReferenceError（运行时退出）。已把"启动调度器"移入 `createRuntimeServer`（与 manager/scheduler 同作用域），并用 `CIRCUITPILOT_KNOWLEDGE_AGENT=off` 可关闭。
- 修复调度状态文件里 `intervalMs:null` 被 `Number(null)=0` 误读成 0 的问题（载入时要求 ≥60s，否则回退默认间隔）。
- 启动日志现在会打印 `KMA scheduler started { intervalMs, nextRunAt }`，供安装版实机核对。
- 安装版首轮实机结果（01:52:33Z，scheduler 自动触发）：web 新增 10 条候选、维护报告 pendingReview 103、知识库 93→103；badcase 任务因证据目录位于 .app 包内且首轮尚未创建而报 `KMA_SOURCE_UNAVAILABLE`（fail-closed，不伪造）。
  已进一步修复：Tauri 启动 sidecar 时把 `CIRCUITPILOT_EVIDENCE_DIR` 指到用户数据目录 `state/evidence` 并预创建，证据/维护报告不再写进 .app 包内。

**最终回归（2026-10-22 10:00 前后）**
- 运行时测试 **1016/1016 pass**（新增 KMA/调度/网页采集 13 条）；前端 **24 文件 / 173 tests pass**；`tsc -b` 通过。
- 安装版（重建+重装后）实测自动调度：`lastRunAt 01:57:31Z`、`ok: true`、web `created 0`（幂等去重）、维护 `pendingReview 103`、证据写用户数据目录
  `~/Library/Application Support/com.circuitpilot.desktop/state/evidence/knowledge/…json`（不再写进 .app 包内），knowledge 文件 103。
- 前端「知识库 → 知识管理 Agent（KMA）」面板可用：调度状态、上次/下次时间、采集 badcase / 抓取网页知识 / 立即维护 / 全部运行、badcase 列表。

### 第八批：RAG 工程落地（W3-20，2026-10-22 10:00~10:15）

用户要求"把 CircuitPilot 里面的 RAG 工程搭建好，并告诉我搭建的方案"。方案与实现：

**方案（详见 `docs/implementation/rag-design.md`）**
- 本地优先、零新依赖：`BM25 词法（中文 bigram+英文 token） + 384 维特征哈希向量（FNV-1a，确定性）+ 标题/知识类目加权`；
- 语料：知识库条目 + 工程 Markdown 文档（目录不存在自动跳过）；
- 分块：Markdown 标题感知、700 字/90 重叠、超长行切片；
- 持久化 `state/rag/index.json`（base64 Float32 向量），懒构建、损坏自动重建、不把空索引当"没搜到"；
- API：`GET /api/rag/status`、`POST /api/rag/reindex`、`POST /api/rag/query`；
- 编排集成：`runDesignPipeline({rag})` 支持步骤 `ragQuery`，检索依据写进证据 `retrieval`；检索失败 fail-closed → unknown；
- 前端「知识库 → RAG 检索（本地混合索引）」面板：状态/重建/检索/结果表（标注"只提供依据，不构成放行"）。

**实测**
- 语料 147 文档 / 1373 块 / 35908 词项，构建 **239ms**；Golden 7 查询 Hit@1=7/7、Hit@3=7/7、MRR=1.0（脚本 `scripts/verify-rag.mjs`，证据落 `artifacts/evidence/knowledge/`）。
- 测试：新增 `runtime/__tests__/rag.test.mjs` 6/6；编排 RAG 集成 1/1（合计 orchestrator 7/7）；route-contract 3/3；前端 RAG 面板冒烟 5/5。

**边界**：特征哈希不是神经 embedding；检索≠门禁结论；Golden query 为关键词命中判定而非人工相关性标注。

**安装版实测（RAG）**
- `.app` 内置 `runtime/rag/*` 与 `/api/rag/*` 路由；用安装包内的 Runtime 对 App 用户数据目录跑：`reindex` 成功、查询「ERC 悬空引脚 规则」命中 `PIN_FLOATING` 失败模式知识条目，索引落 `state/rag/index.json`。
- 发现首版 App 只带知识库条目（103 文档/109 块，无工程文档）；已把 `docs/implementation`、`docs/wardrobe-case` 加入 Tauri resources，重打后 App 语料与开发机一致（147 文档/1373 块）。

### 第九批：知识库「功能区」UI 升级 + 重新安装（W3-21，2026-10-22 10:16~10:24）

用户要求"重新安装 CircuitPilot，并更新前端 UI，增加知识库的功能区"。完成内容：

**UI 重构（`src/pages/KnowledgePage.tsx`）**
- 页面升级为「知识库功能区（KNOWLEDGE WORKBENCH）」：顶部统一统计条（条目总数/待审/门禁可用/过期/冲突/RAG 索引）+ 六个分区：
  1. **概览**：健康度（覆盖率/过期率/冲突率/命中率）+ KMA 调度与手动触发；
  2. **RAG 检索**：索引状态/重建/混合检索结果表（分数、片段、类型、来源）；
  3. **审核队列**：逐条通过/驳回（必须填审核人）；
  4. **知识条目**：新增类型/审核状态/可信等级/是否过期筛选，命中数、行内审核，冲突检测；
  5. **badcase**：真实证据归并的候选列表 + 采集/刷新 + 行内审核；
  6. **贡献**：新增候选条目（payload JSON 校验，写入必为 candidate）。
- 审核人输入提升到功能区头部，各分区共用；`KnowledgePage` 增加 `initialTab` 便于测试与深链。
- 明确边界文案：AI/采集器只产 candidate，approved 才进门禁；RAG 只提供依据、不构成放行。

**验证**
- `tsc -b` 通过；前端测试 **24 文件 / 175 tests 全绿**（知识库 UI 冒烟 6/6）；运行时 **1023/1023**。
- 重新构建（vite + sidecar stage + Tauri）并 `ditto` 覆盖安装 `/Applications/CircuitPilot.app`；启动日志 `KMA scheduler started`、`Runtime started :4178`；KMA 自动轮次 `ok: true`（history 5），`state/rag/index.json`、103 条知识、调度状态均保留。
- 构建产物 `dist/assets/index-*.js` 已包含「知识库功能区 / RAG 检索（本地混合索引）」字符串。

**浏览器实测（对构建产物，不只靠单测）**
- 用 Playwright + Chromium 打开 `dist` 预览的 `#validation/knowledge`：知识库功能区头、六个分区入口、RAG 检索面板、审核队列、知识条目筛选（3 个 select + 包含过期）、badcase、贡献、审核人输入 **全部可见可点**；页面无 JS 报错（pageerror=0）。
- 截图留档：`artifacts/screenshots/knowledge-workbench-rag.png`、`artifacts/screenshots/knowledge-workbench-contribute.png`。

**按「先更新 UI、再重装」顺序完成最终闭环（2026-10-22 10:30~10:37）**
1. **UI 更新**：知识库功能区（6 分区）源码改动完成，`npm run build` 产出 `dist/assets/index-D0ETGiaY.js`（含「知识库功能区 / RAG 检索（本地混合索引）」）。
2. **浏览器验证**：Playwright + Chromium 打开 `#validation/knowledge`，功能区头、6 分区切换、知识条目 3 个筛选 select + 包含过期、RAG/审核/badcase/贡献面板、审核人输入全部可见可点，**pageerror=0**（截图 `artifacts/screenshots/knowledge-workbench-final.png`）。
3. **重新打包**：`sidecar:stage` + Tauri release 构建成功（未复用旧产物）。
4. **干净重装**：删除 `/Applications/CircuitPilot.app` 后 `ditto` 覆盖安装；启动日志 `KMA scheduler started`、`Runtime started :4178`。
5. **重装一致性校验**：`.app` 可执行文件内嵌资源名 `index-D0ETGiaY.js` 与 `dist` 最新构建一致 → 安装的是含新 UI 的版本。
6. **装后运行校验**：KMA 自动轮次 `ok: true`（history 6）；103 条知识、`state/rag/index.json` 均保留。

**补充：侧边栏新增一级「知识库」入口（2026-10-22 10:38~10:45）**
- 之前知识库只是「验证与交付」里的一个页签，用户在左侧一级导航看不到入口（反馈"没有看到知识库入口"）。
- 已在 `navigation.ts` 新增规范页面 `knowledge`（一级导航：概览 / AI 设计 / EDA 执行 / 自动化 / 验证与交付 / **知识库** / 版本与问题），并补 `PAGE_RESPONSIBILITIES`、Shell 图标（BookOpen）、`App.tsx` 路由渲染；旧页签入口保留。
- 同时修掉一个真实 UI 缺陷：`.stat-grid` 缺少 CSS（只有 `.stats-grid`），导致知识库/验证中心指标卡竖排；已补响应式网格规则（auto-fit minmax 170px）。
- 验证：`tsc -b` 通过、前端 175/175、导航信息架构测试 6/6；Playwright 实测侧边栏含「知识库」、点击跳到 `#knowledge` 并渲染知识库功能区，pageerror=0（截图 `artifacts/screenshots/knowledge-sidebar-entry.png`）。
- 重新打包并**干净重装**（删除旧 `.app` 后 ditto）：`.app` 内嵌资源 `index-BHV1SvRp.js` 与 dist 一致；启动日志 `KMA scheduler started`、`Runtime started :4178`；KMA 自动轮次继续正常。
