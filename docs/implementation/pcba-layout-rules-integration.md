# PCBA 布局规则引擎接入 CircuitPilot

> 目标：把 `docs/pcb-layout` 的 151 条布局规则从"评审文档"变成"可执行判定"——能对一块板子给出
> **逐条 PASS / FAIL / REVIEW / NA + 量值证据 + 10 道门禁结论 + 可复现哈希**，并接进三阶段工程报告、
> HTTP API 与 Web 界面。规则数值只认 `rules/board-layout-rules.json`，代码不另抄常量。

- 规则来源：`docs/pcb-layout/01 诊断`、`02 设计规则A`、`03 设计规则B`、`04 落地校验清单`
- 规则数值：`rules/board-layout-rules.json`（151 条，硬门禁 126 / 推荐 25）
- 判定引擎：`runtime/engineering/layout-rules.mjs`
- 样板：`runtime/engineering/rules/fixtures.mjs`（现状板 / 整改骨架）

---

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `runtime/engineering/rules/board-layout-rules.json` | **运行时的唯一规则数值来源**（sidecar 只打包 `runtime/`，所以必须放这里）；由脚本从 02/03 号文档生成 |
| `rules/board-layout-rules.json` | 同一份内容的公开副本，供文档评审、外部工具与规则索引使用 |
| `runtime/engineering/layout-rules.mjs` | 规则加载/校验、几何判定、门禁聚合、`auditHash` |
| `runtime/engineering/rules/fixtures.mjs` | 六个样板输入：现状板（13 处已知缺陷 + 交付链硬伤）、整改骨架（证明规则可被满足）、DBTS-A01 排针对插装配区返工前/后（2026-10-29 真机）、DBTS-A01 交付链返工前/后（PRJ 组，2026-10-29 真机） |
| `runtime/engineering/layout-rules.test.mjs` | 22 条 `node:test` 断言（防假通过、防退化、确定性、IPC 载流公式、ZCLR/MOVE/PRJ 真机案例） |
| `runtime/engineering/engine.mjs` | 三阶段工程报告新增可选 `layoutRules` 段；审计 FAIL 并入 `findings` |
| `runtime/server.mjs` | `GET /api/engineering/layout-rules`、`POST /api/engineering/layout-rules/audit` |
| `src/pages/RuleCenterPage.tsx` | 规则中心页（`#validation/rules`） |
| `e2e/layout-rules.spec.ts` | 3 条 Playwright 用例：直连真实 Runtime，验证加载/现状板阻断/整改骨架可放行 |
| `scripts/audit-dbts-3d-layout.mjs` | 真机审计脚本：读 EasyEDA readback（mil→mm）+ 器件高度表，跑 ZCLR/MOVE 并输出返工前/后两份证据 |
| `scripts/circuitpilot-preflight.mjs` | 工程健康预检：读 `projects/<board>/preflight.json` + 磁盘交付物 + 文档哈希，跑 PRJ-01..06 并输出 `project-preflight.json`（GATE-10 结论 + 退出码 0/1/2，可直接接 CI） |
| `artifacts/pcb-layout/rule-center-defective.png`、`rule-center-rectified.png` | 两个状态的界面实拍（见 §6） |
| `src/types.ts` / `src/services/runtimeClient.ts` | 审计结果类型与两个客户端方法 |
| `scripts/build-rule-json.py` | 从 02/03 号文档机械抽取 151 条规则，**同时写两份 JSON**（含 `sourceHashes` + `generatedFrom`，PRJ-02 用它判同源），并回写 04 号文档的分组条数表与规则索引 |

---

## 2. 判定模型

### 2.1 四种状态

| 状态 | 含义 | 会不会进 `findings` |
| --- | --- | --- |
| `PASS` | 引擎用输入数据**验证**通过（带 `evidence` 量值） | 否 |
| `FAIL` | 引擎用输入数据**判定违反**（带谁/多少毫米/阈值多少） | 是 |
| `REVIEW` | 输入数据不足以判定，或该规则需要 Gerber/网表/3D/板厂证据 | 否（但会降低门禁与放行结论） |
| `NA` | 本板确实不存在该工艺/器件（例如无 V-CUT、无晶振） | 否 |

**REVIEW ≠ PASS** 是本模块的第一纪律：缺数据时宁可说"待复核"，也不把没验证的规则洗成通过。
空输入（只给板框）的实测结果是 `PASS 1 / REVIEW 120 / NA 7`——没有任何一条几何/电气规则被"真空判过"。

### 2.2 findings 与 severity

- 每条 `FAIL` 生成一条 `finding`：`code = LAYOUT_RULE_<组>_<编号>`（如 `LAYOUT_RULE_SPACE_02`），
  `path = layoutRules.<规则编号>`，`message` 含规则名 + 量值 + 阈值。
- `level = 硬门禁` → `severity: 'blocking'`；`level = 推荐` → `severity: 'warning'`。
- 沿用 `runtime/engineering/stackup.mjs` 的 `finding()` 形状，与既有工程报告消费者兼容。

### 2.3 门禁与"可放行"

`GATE-01..09` 不独立臆造，而是由其它规则状态 + 外部签字证据聚合：

| 门禁 | 判定依据 |
| --- | --- |
| GATE-01 3D 干涉 | `SPACE-02/07/08/09/18`、`MECH-05` 全部非 FAIL **且** `evidence.step3d` 为带 provenance 的 PASS |
| GATE-02 DRC | `evidence.officialDrc` 为带 provenance 的 PASS |
| GATE-03 板厂 DFM | `evidence.dfm` 为带 provenance 的 PASS |
| GATE-04 DFA 装配评审 | `evidence.dfa` 为带 provenance 的 PASS |
| GATE-05 首件 FAI | `evidence.fai` 为带 provenance 的 PASS |
| GATE-06 ECO | `evidence.eco` 的 `lastChangeId` + provenance |
| GATE-07 不可投产红线 | 8 条红线逐条命中/已清/未验证（含 3D 干涉、丝印压焊盘、去耦超距、RF 禁布区、拼板工艺边、Mark 与定位孔、USB 阻抗、FAI） |

- `passed`：没有 `blocking` 级 FAIL（规则层面）。
- `releaseReady`：`passed` 且 **10 道门禁全部 PASS**。门禁 PASS 意味着对应外部证据已签字，
  引擎不会因为"规则全过"就宣布可投产。
- 门禁证据必须带 `source/artifactHash/issuedAt/scope`；只有 `{passed:true}` 的裸布尔值按 REVIEW 处理，
  避免调用方用一个布尔值绕过 DRC/DFM/DFA/FAI/ECO 门禁。
- `REVIEW` 规则若被已通过的门禁覆盖（例如 DFM 组被 GATE-03 覆盖），会在 `coveredBy` 里写明；
  `uncoveredReviews` 统计"既没数据也没门禁覆盖"的规则数。

### 2.4 方向类别（CONN-10 / DFA-11）的降级裁定

目标 ≤2 类出线方向。本板 6 个连接器本体合计 95 mm > 70 mm 板边，物理上必须用 3 类（+Y / −Y / −X）。
引擎允许 3 类，但**必须**同时满足：

```jsonc
{ "directionClassLimit": 2, "directionClassDegradationApproved": true } // 后者代表 ECO 已书面记录降级
```

否则 `CONN-10` 与 `DFA-11` 同时 FAIL（两条规则共用同一个检查函数，避免"一个过一个是坑"）。
测试里专门有一条"去掉审批后两条规则同时翻脸"的断言。

---

## 3. 输入契约

### 3.1 最小输入

```json
{ "board": { "widthMm": 70, "heightMm": 48, "thicknessMm": 1.6 } }
```

能判定的只有板厚这类纯板框规则，其余全部 REVIEW。

### 3.2 主要字段

> 布局设计意图的完整 JSON 契约见 [layout-intent-schema.md](../design/layout-intent-schema.md)；
> 真机审计脚本：`node scripts/bridge-layout-audit.mjs --open-uuid <pcbUuid> [--design <json>] [--drc]`。


| 字段 | 说明 |
| --- | --- |
| `board` | `widthMm/heightMm/thicknessMm/cornerRadiusMm/outlineClosed/processEdgeMm/panelized/warpPercent/padToEdgeMm/copperToEdgeMm/vCutLines[]/fiducials[]/toolingHoles[]/mountingHoles[]` |
| `components[]` | `ref/x/y/widthMm/heightMm/rotationDeg/side/heightMm3d/courtyardMm/packageClass`；`side` 缺省 top；`courtyardMm` 缺失时 SPACE-01/02/03 统一 REVIEW（不按默认 0.25 冒充）；`packageClass` 决定 SPACE-04..08/12/18 的适用性 |
| `components[].conn` | `kind/openingDir/openingNormalityDeg/plugClearanceMm/cableKeepout/massG/reinforced/pin1Marked/pressClearanceMm`；`openingDir` 用**世界坐标**轴向 |
| `components[].antenna` | `endDir`，标记天线所在端 |
| `rf` | `componentRef/overhangMm/keepout{x0,y0,x1,y1}/copperInKeepout/metalRefs/viaFencePitchMm/gndCoveragePercent/noiseSourcesNearAntenna/maskOpeningInKeepout/silkInKeepout/viasInKeepout/gndViaRatio` |
| `silk` | `items[{ref,gapToPadMm,onPadRefs,outsideBoard}]/textHeights/minCharGapMm/overlappingPadCount/strayLineCount/runsOffBoard` |
| `power` | `nets[{net,currentA,widthMm,layer}]/decoupling[{capRef,icRef,distanceMm,icClass}]/paths[{net,peakCurrentA,designedForA}]` |
| `testPoints[]`、`requiredNets[]` | 测试点直径/坐标/网络，以及必须覆盖的网络清单 |
| `switches[]` | 按键操作空间 `clearanceMm` |
| `silk` | `textCount/textHeights/lineWidthsMm/items[{ref,boundsMm,gapToPadMm,onPadRefs,courtyardOverlapRefs,outsideBoard,edgeDistanceMm}]/designators[{ref,rotationDeg,mirror,gapToBodyMm,placementRelative,sideMismatch}]` |
| `power` | `decoupling[]`（`capRef/icRef/distanceMm/icClass/icClassKnown/auto`）；`auto=true` 的疑似超距只判 REVIEW |
| `evidence` | 门禁证据必须带 `passed/source/artifactHash/issuedAt/scope`；裸 `{passed:true}` 降 REVIEW |
| `esd` | `devices[{ref,distanceMm,gndViaDistanceMm,orderBeforeBranch}]`；DFA-09 缺量测保持 REVIEW |
| `thermal/pdn/highSpeed/creepage/clearance/enclosure/emc` | 独立 `SUP-*` 规则族的事实输入；见 `layout-supplements.mjs`，不改变 151 条规则包 |
| `assemblyZones[]` | **ZCLR 组的核心输入**：`name/kind('MODULE'|'SHIELD'|'TOOLING'|'OPEN'|'MAINTENANCE')/rect{x0,y0,x1,y1}（或 rectMm:[x0,y0,x1,y1]）/matingHeightMm/clearanceMm/sideClearanceMm/sideMaxHeightMm/toolAccess/allowedRefs[]/allowedTallRefs[]/source`。`matingHeightMm` = 模块 PCB 底面到本板面的实测距离；`allowedRefs` 具名豁免区结构件（排针/插座本体）；`toolAccess:true` 才判维护侧向环带（ZCLR-04） |
| `board.enclosureHeightMm` | 外壳内腔高度，ZCLR-06 正反叠装总高判定用；缺失时叠装规则 REVIEW |
| `changes[]` | **MOVE 组的核心输入**：`ref/from{x,y}/to{x,y}/reason(≥10 字)/ecoId/approvedBy[]/zclrRechecked`；MOVE-01 会与 `previousPositions` 做位移比对，抓「私自挪件不登记」 |
| `previousPositions` | `{ref:{x,y}}` 上一版坐标快照；与当前 components 坐标比对可反查未登记的位移 |
| `nets[]` | `net/class('SW'|'PWR'|'GATE'|'FB'|'SIGNAL')/lengthBeforeMm/lengthAfterMm/loopAreaBeforeMm2/loopAreaAfterMm2/approvedBy`；MOVE-02/03 的量化输入 |
| `limits` | 引擎阈值的**显式**覆盖：`matingClearanceMm/sideClearanceMm/sideMaxHeightMm/highComponentMm/stackSolderMm/stackEnclosureClearanceMm/coverTallMm/moveGrowthPercent/swMaxLengthMm/swLoopGrowthFactor/pwrLoopGrowthFactor`；默认值与 02 §7 / 03 §8 的规则表述一一对应，覆盖值原样进 `auditHash`（可审计，不是偷改常量） |
| `project` | **PRJ-01 的输入**：`designs[{id,name,kind,refs[]}]`（图纸页）与 `boards[{id,name,primary,pcbUuid}]`（PCB 实例）。页名重复 / 位号跨页重复 / 投板板 ≠1 → FAIL；缺清单 REVIEW |
| `docs` | **PRJ-02 的输入**：`docHashes{文件名:sha256}` + `generatedFrom`。与规则包 `sourceHashes` 逐份比对，不等 = 有人手改了 md 或 JSON → FAIL |
| `deliverables[]` | **PRJ-03 的输入**：`kind('GERBER'|'BOM'|'DRC'|'DFM'|'NETLIST'|'STEP3D')/path/sha256/issuedAt/passed`；6 类缺一即 FAIL，`sha256` 非 64 位 hex 或 `passed:false` 也算不合规 |
| `stageGates` | **PRJ-04 的输入**：`postRouteChecked:boolean` + `equivalentEvidence[]`；未置位但 DRC/DFM/NETLIST 齐备 → REVIEW（需签核等效），否则 REVIEW |
| `records[]` | **PRJ-05 的输入**：`file/updatedAt/numbers{}`；与 `latestSnapshot` 比时间戳与关键数字（components/tracks/vias/dfmWarn…），落后或不等 → FAIL（推荐级 → GATE-10 转 REVIEW） |
| `latestSnapshot` | 最新实测快照：`updatedAt` + `numbers{}`，PRJ-05 的比对基准 |
| `inferredParts[]` | **PRJ-06 的输入**：`ref/what/inferred/safeDefault/verifySteps[]`；照片推断的引脚分配必须带安全默认 + ≥2 步核对，否则 REVIEW |
| `directionClassLimit`、`directionClassDegradationApproved` | 见 §2.4 |
| `evidence` | `step3d/officialDrc/dfm/dfa/fai/eco/highSpeedImpedance`，只接受 `{ passed: boolean, … }` 形式 |

### 3.3 检查器覆盖

141 条非门禁规则全部挂了检查器（MECH-09 邮票孔、MECH-15 外形与外壳装配在缺数据时如实 REVIEW）；
10 条 GATE 由门禁聚合计算（GATE-08 装配净空门、GATE-09 布局变更影响门、GATE-10 交付放行门为 2026-10-29 新增）。其中一部分检查器在缺少专用证据时**如实返回 REVIEW**（例如 PWR-02 回路面积、
SILK-06 位号角度、DFM-02 过孔环宽）——这不是没实现，而是输入里没有相应证据时不假装能算。

判定完全基于几何/数值的规则（节选）：`SPACE-01..11/14/16/18`、`MECH-01..08/10..14`、
`CONN-01..07/10..14/16/17`、`RF-01..05/07/08/11/12`、`PWR-01/05/11`、`SILK-01/03/04/05/13/14`、
`DFM-01/08/09/15`、`DFA-04..07/11/13`、`ZCLR-01..09`、`MOVE-01..05`、`PRJ-01..06`、`GATE-01..10`。

---

## 4. 输出契约（摘录）

```jsonc
{
  "kind": "pcba-layout-rule-audit",
  "schemaVersion": 1,
  "packVersion": "1.0.0",
  "packHash": "fa8e8ccaf528e5070cc391be29fd48fe1ab22be5d274375f063026956da8e13f",
  "board": { "widthMm": 70, "heightMm": 48, "thicknessMm": 1.6 },
  "rules": [{ "id": "SPACE-02", "group": "SPACE", "level": "硬门禁", "status": "FAIL",
              "message": "courtyard 相交 3 处：…", "evidence": { "violations": [ … ] }, "coveredBy": [] }],
  "gates": [{ "id": "GATE-01", "status": "FAIL", "message": "布局几何干涉未清零（SPACE-02、SPACE-09）" }],
  "gatesSummary": { "GATE-01": "FAIL", "GATE-02": "REVIEW", "…": "…" },
  "redLines": [{ "key": "3D 干涉未清零", "hit": true }],
  "summary": { "total": 128, "PASS": 12, "FAIL": 54, "REVIEW": 58, "NA": 4,
               "blockingFailures": 51, "warningFailures": 4, "byGroup": { "…": { "…": 0 } } },
  "findings": [{ "code": "LAYOUT_RULE_SPACE_02", "severity": "blocking", "path": "layoutRules.SPACE-02", "message": "…" }],
  "passed": false,
  "releaseReady": false,
  "uncoveredReviews": 58,
  "humanReviewRequired": true,
  "officialDrcRequired": true,
  "policy": "REVIEW 不等于 PASS：…",
  "auditHash": "f0c7e0a6b0ec4654…"
}
```

`auditHash = sha256(除 auditHash 外的完整结果)`；同输入逐字节一致（测试断言），
可直接被门禁、ECO、交付清单引用。

---

## 5. HTTP API

所有路由与既有 Runtime 一致：需要 `x-circuitpilot-token`（开发模式先 `GET /api/health` 取 `sessionProof`）。

### 5.1 规则包元信息

```bash
curl -s http://127.0.0.1:4178/api/engineering/layout-rules -H "x-circuitpilot-token: $TOKEN"
```

返回 `{ ok, pack: { version,total,counts,levels,hash,groups,documents,policy }, fixtures: ['ESP32-TEST-BOARD','ESP32-TEST-BOARD-RECTIFIED','DBTS-A01-MODULE-BEFORE','DBTS-A01-MODULE-AFTER','DBTS-A01-DELIVERY-BEFORE','DBTS-A01-DELIVERY-AFTER'] }`。
只回元信息，不回 151 条正文，避免每个页面都拉 80 KB。

### 5.2 审计

```bash
# 审计内置样板
curl -s -X POST http://127.0.0.1:4178/api/engineering/layout-rules/audit \
  -H "content-type: application/json" -H "x-circuitpilot-token: $TOKEN" \
  -d '{"fixtureId":"ESP32-TEST-BOARD"}'

# 审计自己的布局输入
curl -s -X POST http://127.0.0.1:4178/api/engineering/layout-rules/audit \
  -H "content-type: application/json" -H "x-circuitpilot-token: $TOKEN" \
  -d '{"input":{"board":{"widthMm":80,"heightMm":55,"thicknessMm":1.6},"components":[]}}'
```

样板不存在 → `404 LAYOUT_RULE_FIXTURE_NOT_FOUND`。

### 5.3 并入三阶段工程报告（可选）

```jsonc
POST /api/engineering/analyze
{ "input": { "stackup": { … }, "layout": { … }, "layoutRules": { "board": { … }, "components": [ … ] } } }
```

- 只有传了 `layoutRules` 才执行审计；`analysis.layoutRules` 出现该段，`analysis.releaseReady` 取审计结论。
- 审计 FAIL 会并入 `analysis.findings`（硬门禁 → blocking，`analysis.passed` 随之为 false）。
- **不传该字段时报告形状不变**，既有工程样板与测试不受影响（可选段是刻意设计，避免改变既有哈希语义）。

---

## 6. Web 界面：`#validation/rules`（规则中心）

"验证与交付"下新增第三个标签页（`检查与问题 / 布局微调 / 规则中心`）：

1. **规则包**：151 条、126 硬门禁、25 推荐、12 分组、SHA-256 前缀、规则出处绑定状态；
2. **两个样板按钮**：「审计现状板」「审计整改骨架」直接调 Runtime；
3. **审计结论**：PASS/FAIL/REVIEW/NA 统计、阻断数、10 道门禁卡片、8 条不可投产红线、放行结论；
4. **阻断项与待复核规则**：按状态/分组筛选 + 关键字搜索，逐条显示判定依据（含量值），
   `查看证据` 展开 JSON，REVIEW 行显示 `coveredBy`（哪个门禁签字覆盖）；
5. **可执行整改清单**：FAIL 的 findings（阻断优先），带 `path` 便于回到规则/文档；
6. **自定义输入**：粘贴 JSON 直接审计（解析失败不会提交）。

界面上 `REVIEW` 一律显示"待复核"（黄色），绝不显示成"通过"。

实测截图（真实本机 Runtime，Playwright 驱动）：

| 现状板（阻断 50） | 整改骨架（7 门禁通过） |
| --- | --- |
| ![规则中心-现状板](../../artifacts/pcb-layout/rule-center-defective.png) | ![规则中心-整改骨架](../../artifacts/pcb-layout/rule-center-rectified.png) |

自动化校验：`npx playwright test e2e/layout-rules.spec.ts`（3 条用例，直连 4178，不 mock），
断言"128 条规则已加载 / 现状板显示存在阻断项且 GATE-01 不通过 / 整改骨架 0 不通过且 7 门禁通过"。

---

## 7. 样板与实测数字

| 输入 | PASS | FAIL | REVIEW | NA | 阻断 | 门禁 | `releaseReady` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 空输入（仅板框） | 0 | 0 | 135 | 16 | 0 | 10×REVIEW | false |
| `ESP32-TEST-BOARD`（现状板） | 14 | 62 | 62 | 13 | **57** | GATE-01/07/08/10 FAIL，其余 REVIEW | false |
| `ESP32-TEST-BOARD-RECTIFIED`（整改骨架） | 83 | 0 | 49 | 19 | 0 | 10×PASS | **true** |
| `DBTS-A01-MODULE-BEFORE`（返工前，聚焦装配区） | 24 | 25 | 83 | 19 | 23 | GATE-01/07/08 FAIL | false |
| `DBTS-A01-MODULE-AFTER`（返工后，聚焦装配区） | 33 | 17 | 87 | 14 | 15 | GATE-07 FAIL、GATE-08/09/10 REVIEW | false |
| `DBTS-A01-DELIVERY-BEFORE`（交付链返工前） | 24 | 30 | 79 | 18 | **27** | GATE-01/07/08/10 FAIL | false |
| `DBTS-A01-DELIVERY-AFTER`（交付链闭合） | 40 | 17 | 81 | 13 | 15 | **GATE-10 PASS**、GATE-07 FAIL、其余 REVIEW | false |

现状板命中的规则集合与 01 号文档的 13 处缺陷一一对应（测试逐条锚定，不是抽样）：
`SPACE-02/07/08/09/14`、`CONN-01/04/06/10/11/13`、`RF-01/03/04/07`、`PWR-01/05`、
`MECH-04/06/10/11/12/13/14`、`SILK-01/03/04/05/13/14`、`DFM-08/15`、`DFA-04/05/06/07/11/13`、`PRJ-01/02/03/05`、`GATE-01/07/08/10`。

整改骨架证明"规则可被执行满足"：板框 80×55、模组右上角天线 +X 伸边 2.25 mm、连接器按 3 个板边分组、
去耦 ≤1.3 mm、3 A 载流 2.0 mm、Mark/定位孔/工艺边齐全、10 道门禁证据齐备。
其中 49 条 REVIEW 是**刻意保留**的：它们需要 Gerber/网表/叠层/3D 数据，不能让一个纯几何输入假装验证过。

### 7.1 DBTS-A01 真机案例（ZCLR/MOVE 两组的来源与验收）

`scripts/audit-dbts-3d-layout.mjs` 直接把 EasyEDA readback `artifacts/final-5v-chg/board-final.json`
（mil → mm，×0.0254）+ 器件高度表喂给引擎，同一份输入跑"返工前 / 返工后"：

| 规则 | 返工前 | 返工后 |
| --- | --- | --- |
| ZCLR-02 同面 3D 实体干涉 | **FAIL 3 处**：Q5×C39 4.52×5.25 mm、C39×C40 7.47×2.18 mm、C39×L2 8.89×4.57 mm | PASS |
| ZCLR-03 装配区插合高度 | **FAIL 2 件**：C39 25 mm、L2 8.1 mm > 8.5−0.5 = 8.0 mm | PASS |
| ZCLR-05 高件禁区（推荐） | FAIL：C39/L2/C40/L1 在模块投影内 | FAIL（C40 7.7 mm、L1 6.0 mm，待签核） |
| ZCLR-07 遮盖区电解（推荐） | FAIL：C39、C40 | FAIL（C40，待签核或上移） |
| MOVE-02/03 搬迁代价 | NA（未搬迁） | REVIEW（SW_NODE 3.6→48.5 mm、环路 ×38，已具名接受） |
| GATE-08 / GATE-09 | FAIL / PASS | REVIEW / REVIEW |

返工后硬门禁全部闭环，只剩两条"推荐"级警告与两条已签核的搬迁代价——这正是该板当时的真实状态：
`C39`（Φ16 电解）与 `L2`（8.1 mm 电感）迁出后，模块投影边缘仍有 `C40`（Φ6.3 电解，本体 7.7 mm）
与 `L1`（6.0 mm）各侵入零点几毫米，属「可签核接受但必须留痕」的边界项。
**注意**：`C40` 的高度在首版人工复核里被误记为 2.5 mm，引擎按封装名（`CAP-SMD_BD6.3`）与型号（RVT 4.7 µF/100 V）
判为 7.7 mm 后立刻把这条边界项翻了出来——这就是"高度表必须登记来源"（ZCLR-01）的实际价值。

### 7.2 DBTS-A01 交付链案例（PRJ 组的来源与验收）

`scripts/circuitpilot-preflight.mjs` 读 `projects/dual-battery-tsb/preflight.json`（图纸页/PCB 实例/阶段门禁/记录数字/推断项）
+ 磁盘上的交付物 + 02/03 号文档哈希，跑 PRJ 组并写出 `artifacts/final-5v-chg/project-preflight.json`。
2026-10-29 16:55 的真机结论（**这就是这块板当前的真实状态**）：

| 规则 | 结论 | 说明 |
| --- | --- | --- |
| PRJ-01 工程对象唯一性 | **FAIL** | 重复旧版图纸页名与主设计重名（`P6 充电链路`、`P8 5V/3.3V 降压`），位号 U9/J7/J8/U7 跨页重复；备用板 `PCB1_1` 已登记为 `primary:false` |
| PRJ-02 规则文档与规则包同源 | PASS | 2 份文档 sha256 与规则包 `sourceHashes` 一致（pack `5fca9a215e6d…`） |
| PRJ-03 交付物完整性 | **FAIL** | 5/6 类齐备（BOM/DRC/DFM/网表/3D 高度），**缺 Gerber** |
| PRJ-04 阶段门禁证据闭合 | REVIEW | `post_route_checked` 未置位，但 DRC+DFM+网表 三项等效证据齐备 → 需 PCB 工程师签核 |
| PRJ-05 记录一致性 | PASS | README / REWORK-REPORT 的 4 个关键数字（99/1267/207/149）与 15:20 快照一致 |
| PRJ-06 推断项兜底 | PASS | 模块 6 脚分配是照片推断，但带「J12 默认开路」+ 4 步万用表核对 |
| **GATE-10 交付放行门** | **FAIL** | 退出码 2（可直接接 CI） |

这三条硬伤（重复图纸、缺 Gerber、门禁未置位）都不是"板上哪条线画错了"，而是"这块板还不能发出去"——
PRJ 组把它们从复盘文档里的"待办"变成了引擎里可重复执行的判定。

数值来源标注：现状板为 3D 渲染图目视量测（≈24 px/mm，±10%），仅用于校准规则；
整改骨架是按 02 号文档裁定值搭的骨架，DBTS 样板是实板 readback + 工程高度表（CD11Z/RVT 待卡尺实测），
**都不是**可直接投板的最终布局。

---

## 8. 规则包同步机制

```bash
python3 scripts/build-rule-json.py
# {"counts":{...},"levels":{"硬门禁":126,"推荐":25},"total":151,"problems":"none"}
# 04 号文档分组条数表已重写
# 04 号文档规则索引已重写
node scripts/audit-dbts-3d-layout.mjs   # DBTS 真机 ZCLR/MOVE 审计（返工前/后各一份 JSON）
node scripts/circuitpilot-preflight.mjs # DBTS 工程健康预检（PRJ 组 + GATE-10，写 project-preflight.json）
```

- 脚本从 `docs/pcb-layout/02|03` 的规则表机械抽取，校验编号连续/不重复/分组计数，一次性写两份 JSON；
- 运行时不读文档、不读 md，只读 `runtime/engineering/rules/board-layout-rules.json`；
- 加载时再做一次同规则校验（`validateRulePack`），坏包直接抛 `LAYOUT_RULE_PACK_INVALID`，不会带着坏规则跑；
- `packHash = sha256(rules 数组)`，进入审计结果，规则改动必然反映到哈希上；
- Tauri 打包 `"../runtime": "runtime"` 是整目录资源，新 JSON 自动进 sidecar，无需额外配置。

---

## 9. 测试

```bash
node --test runtime/engineering/layout-rules.test.mjs   # 11 条，~50 ms
node --test runtime/__tests__/engineering.test.mjs      # 含两条新 API 用例（规则包 / 审计 / 404 / 报告并入）
npm run test:runtime                                    # 全量 Runtime 测试（1143 条）
npm test                                                # typecheck + vitest + runtime
npx playwright test e2e/layout-rules.spec.ts            # 真机 UI：需先 npm run dev:full
```

覆盖重点：

1. 规则包 128 条/9 组/等级计数/编号连续/文档指针；
2. 校验器能拦住重复编号、非法等级、计数不符、编号断档；
3. **空输入不得产生假 PASS**（REVIEW 120、`releaseReady=false`、7 门禁全 REVIEW）；
4. 现状板 13 处缺陷对应规则逐条 FAIL，findings/severity/path 形状正确；
5. 整改骨架 0 FAIL、7 门禁 PASS、`releaseReady=true`，天线越边记入 `MECH-05.evidence.rfGoverned`；
6. 方向类别降级去掉 ECO 记录后 `CONN-10` 与 `DFA-11` 同时 FAIL；
7. 门禁证据缺失/官方 DRC 失败 → `releaseReady=false`；
8. 同输入逐字节一致、异输入哈希不同、规则顺序与规则包一致；
9. IPC-2221B 载流宽度（1 A 外层 ≈0.302 mm、内层 ≈0.785 mm、2 A ≈0.79 mm、3 A ≈1.377 mm）；
10. 规则包摘要不吐正文但含 UI 所需元信息；
11. PWR-05 用 3 A / 0.4 mm 必须 FAIL 并报出所需宽度。

---

## 10. 已知限制与下一步

| 限制 | 现状 | 下一步 |
| --- | --- | --- |
| 没有 Gerber/ODB++ 解析 | 焊盘到边、阻焊桥、丝印压焊盘等只能 REVIEW 或依赖调用方传实测值 | 接 Gerber 解析后把 MECH-06、SILK-04/05、DFM-02/03 变成真几何判定 |
| 没有网表 | PWR-02/03/04、SILK-09/10、DFA-09 无法自动判 | 从 EDA 导出网表/引脚坐标，补电源脚-去耦配对与 GND 过孔统计 |
| 没有 3D 高度表全覆盖 | SPACE-18 只要求关键器件 | 接 STEP/高度表后把 SPACE-10/13 变成可判定 |
| 拼板/V-CUT/邮票孔 | 只判宽度与禁布带，不判 V-CUT 直线度与闭环 | 接拼板图几何（线段集合）后补 MECH-07/08/09、RF-13 |
| 外壳/整机 | GATE-01 依赖 `evidence.step3d` | 桥接 STEP 干涉检测，输出干涉体积 |
| 无在线查厂规 | 已登记 2026-10-23 的 JLC/PCBWay 能力快照与来源，但运行时仍不会自动刷新 | 接板厂能力单/EQ 后把 basis=JLC 的规则改为可刷新数据 |

这些限制都体现在判定里（REVIEW / `coveredBy`），不会伪装成通过。

---

## 11. 验收命令

```bash
npm run typecheck                                  # TS 类型
node --test runtime/engineering/layout-rules.test.mjs
npm run test:runtime                               # 1143 条，含既有多层板/工程报告测试
npx playwright test e2e/layout-rules.spec.ts       # 真机规则中心（需先 npm run dev:full）
npx vitest run                                     # 前端单测
npm run build                                      # tsc -b + vite build

# 手工验收（Runtime 跑起来之后）
curl -s localhost:4178/api/engineering/layout-rules -H "x-circuitpilot-token: $TOKEN"
curl -s -X POST localhost:4178/api/engineering/layout-rules/audit \
  -H 'content-type: application/json' -H "x-circuitpilot-token: $TOKEN" \
  -d '{"fixtureId":"ESP32-TEST-BOARD"}' | python3 -c 'import json,sys; a=json.load(sys.stdin)["audit"]; print(a["summary"], a["gatesSummary"], a["releaseReady"])'
```

界面：打开 `http://127.0.0.1:50100/#validation/rules` → 点「审计现状板」应显示 50 项阻断、GATE-01/07 不通过；
点「审计整改骨架」应显示 0 阻断、7 门禁全通过、可放行。


---

## 12. 知识来源与研究批次（2026-10-23）

- 人类可读：`docs/knowledge/pcb/20-researched-layout-constraints.md`
- 来源登记：`knowledge/pcb/dataset/sources.json`
- 新增结构化知识：20 条 rule、4 个 case、5 个 failure；全部 `reference + candidate`，人工审核前不得被门禁引用
- 覆盖：ESP32 模组天线/RF/电源/SDIO、TI QFN 热焊盘/散热过孔/钢网、TI USB/ESD、TI 开关电源环路、Raspberry Pi Pico USB 90 Ω 实例、JLCPCB/PCBWay 能力窗口、IPC-2221 间隙与 IEC 爬电边界
- 测试：`node --test runtime/__tests__/knowledge-research.test.mjs`

这些知识只提供「依据 + 适用条件 + 复核边界」，不会自动把 REVIEW 改成 PASS；运行时判定仍按 `PASS/FAIL/REVIEW/NA` 与证据链执行。
