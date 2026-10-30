# Round 61 · T6 真机放行门诚实报告 + macOS 签名/公证就绪

**一句话结论**：对当前打开的衣橱板（工程 `ba4924190e3a4388a097f3dee090da20`，Board1_1 / PCB3 / 原理图页 `87dba2a22fe7096e`）**真实调用**了 `POST /api/eda/release/gate`，HTTP 200、门禁 **`ready=false` / `verdict=blocked` / 10 条阻断**（另有 1 条警告、9 项统一裁决 blockedBy）——**这不是放行通过**。
同时确认 `/Applications/CircuitPilot.app` 仍是 **ad-hoc 签名、无 Developer ID 证书、未公证**，对外分发就绪性 `false`；证书与公证凭证属于**用户必须提供**的边界，本任务不伪造、不重签。
**没有发现 `ready=true` 的假通过**；唯一需要人警惕的"PASS 假象"是：`constraints` 闸门 `status=pass`（因为 `provided=false`，含义是"没提供约束、本闸门不阻断"）和 `engineering` 闸门 `status=skipped`（本次未覆盖）——两者都不是通过。

---

## 0. 证据落盘（真实文件）

| 内容 | 路径 |
|---|---|
| 门禁请求 + 完整响应 + blockedBy 中文解释（JSON） | `artifacts/release-gate-real/gate-2026-10-21T11-37-31-142Z.json` |
| 人工可读版（含 PASS 假象扫描、证据来源、复现命令） | `artifacts/release-gate-real/gate-2026-10-21T11-37-31-142Z.md` |
| 签名/公证就绪检查（JSON / MD / YAML） | `artifacts/release-gate-real/signing-readiness-2026-10-21T11-30-34-335Z.json`（同名 `.md` / `.yaml`） |
| 脚本（可重跑） | `scripts/release-gate-report.mjs`、`scripts/check-signing-readiness.mjs` |
| 签名/公证完整操作手册 | `docs/macos-signing.md` |
| 前置证据（只交叉参考，未注入门禁） | DRC：`artifacts/evidence/drc-report/drc-report-2026-10-20T15-22-46-358Z-aff12a180172.json`；ERC：`artifacts/evidence/schematic-erc/schematic-erc-2026-10-21T10-58-05-239Z-437da612538c.json`；T3 SPICE：`artifacts/spice/simulation-evidence-2026-10-21T11-35-31-155Z.json` + `artifacts/spice/netlist-2026-10-21T11-35-31-155Z.net` |

---

## 1. 这次门禁到底是怎么调的（不预置证据，让服务端实时取证）

请求（**未包含任何令牌**，令牌只在 HTTP 头里）：

```json
{
  "pageUuid": "87dba2a22fe7096e",
  "pcbUuid": "5595e77cead09682",
  "artifactsDir": "<repo>/deliverables",
  "userConfirmed": false
}
```

关键设计：

- **不传 `acceptance` / `design` / `placementVerification` / `drcReport` / `pricing`**：服务端会自己打开指定原理图页、导出网表、跑原理图验收、读 PCB 布局与铜层数；缺什么就让对应闸门 blocked，**不拿历史文件冒充当前板的证据**。
- `userConfirmed=false`：布局没有被人确认过，这是真实状态，脚本不代签。
- 调用前做了只读预检：`GET /api/health`（ok，runtime 0.2.0）、桥 `GET /api/eda/discover`（端口 49620，`edaConnected=true`）、`GET /api/eda/windows`（1 个窗口）、`POST /api/eda/commands/document.current`（活动文档 = `87dba2a2…`）、`POST /api/eda/commands/project.current`（工程 = `ba4924…`，Board1_1 → PCB `5595e77c…`）。目标工程与任务指定值一致。

服务端实时验收结果（来自门禁证据）：网表 **64 器件 / 34 网络 / 95 个具名引脚**（与 T3 网表 sha256 `a7bbca3f…` 的规模一致），**ERC 报告 1 个错误** → 原理图闸门 blocked。

---

## 2. 门禁结论（原文数字）

| 项 | 值 |
|---|---|
| HTTP | 200（`POST /api/eda/release/gate`，本次耗时约 1.6s；三次真实调用均 <3s） |
| 响应 body | 17,930 bytes，sha256 `7a96ff7a…`（本次报告对应的调用） |
| `ready` | **false** |
| `verdict` | **blocked** |
| `blockers` | **10** |
| `warnings` | 1（价格/库存证据缺失） |
| `humanSignoffRequired` | **true**（下单永远需要人签字） |
| `releaseDecision.ready` | **false** |
| `releaseDecision.blockedBy` | `local:schematic`、`local:simulation`、`local:drc`、`local:placement`、`local:artifacts`、`local:supply`、`local:engineering`、`manual:dfm`、`manual:signoff` |
| `releaseDecision.orderEnabled` | **false**（自动下单/支付永久禁用） |
| `outputDecision` | `allowed=false` / `outputClass=null` / `PRODUCTION_OUTPUT_BLOCKED`（"现在只能产出草稿文件"） |

### 2.1 阻断清单（逐条 + 归属）

| # | code | 门禁原文 | 中文解释 | 归属 |
|---|---|---|---|---|
| 1 | `RELEASE_SCHEMATIC_NOT_READY` | ERC报告1个错误 | 原理图验收被 ERC 错误阻断；必须人工确认电气意图并改图，系统不自动改图 | 人工 |
| 2 | `RELEASE_SIMULATION_NOT_RUN` | 既没有 EDA 侧仿真证据、也没有设计检查点结论 | 这不是"仿真通过"，是"没有仿真"：该页没有绑定仿真器件模型，EDA 导不出 SPICE 网表 | 代码能力（缺仿真接线） |
| 3 | `RELEASE_DRC_EVIDENCE_MISSING` | 没有 DRC 报告 | 门禁不会自己跑 DRC；必须先在 EDA 跑完 DRC 并落盘证据 | 流程 |
| 4 | `RELEASE_PLACEMENT_NOT_CONFIRMED` | 布局没有被明确确认过 | 布局复核本身通过（64 个器件都在板框内），但**没有人确认**，不能下单 | 人工 |
| 5–7 | `RELEASE_ARTIFACT_DRAFT_MARKER` ×3 | gerber / bom / cpl 产物文件名自带草稿标记 | 当前 deliverables 只有 `DRAFT-NOT-FOR-ORDER` 草稿件（Gerber 649,253 B / BOM 9,532 B / CPL 79,236 B），不能下单 | 流程 |
| 8 | `RELEASE_BOM_SUPPLIER_MISSING` | 1 条 BOM 行没有供应商料号 | 52 行 BOM 里 1 行缺料号；料号只能来自可信来源，不伪造 | 外部 / 数据 |
| 9 | `RELEASE_CPL_COORD_MISMATCH` | CPL 坐标与实机读回不一致：C3(78.432mm)、CN1(82.809mm)、J7(92.018mm)… | 偏差几十到上百毫米，说明这份 CPL 不是当前布局（基准/单位/版本问题），不是小误差 | 流程 / 数据 |
| 10 | `RELEASE_SUPPLY_IDENTITY_MISSING` | 1 条 BOM 行的供应商料号不是 LCSC 编号（Cxxxxx） | 52 行 BOM、0 条有价格/库存证据；机器不猜料号/价格 | 外部 |

> 说明：同一 code 出现多次是因为门禁逐产物/逐行报告（3 个草稿产物 = 3 条阻断）。`blockers` 里 10 条、去重后 8 类，与 `outputDecision.blockers` 的 8 类一致。

### 2.2 统一裁决里的人工门禁

`releaseDecision.gates` 里 `manual:dfm`（在线 DFM 人工回填）与 `manual:signoff`（人工终审签核）都是 `unknown`：`artifacts/evidence/` 下既没有 `dfm-evidence/` 也没有 `signoff/`。这是**真实缺失**，不是脚本没读。

---

## 3. PASS 假象扫描（本次重点）

脚本内置扫描结论：**`needs-review`**（门禁整体 blocked，未发现 `ready=true` 的假通过；但有两处容易被误读为"通过"的局部状态）。

| 检查 | 结果 |
|---|---|
| `ready=false` / `verdict=blocked` | ✅ 一致，门禁明确未通过 |
| `humanSignoffRequired=true` | ✅ 机器不能替人签字 |
| `releaseDecision.ready=false` + 9 项 blockedBy | ✅ 统一裁决未通过 |
| `orderEnabled=false` | ✅ 自动下单永久禁用 |
| `outputDecision.allowed=false` / `outputClass=null` | ✅ 禁止产出正式文件，只能出草稿 |
| 局部 `status=pass` 闸门 | ⚠️ 只有 `constraints`：`evidence.provided=false`、`checked=0`，含义是"**没提供结构化硬约束，本闸门不阻断**"，绝不是"需求约束已满足" |
| `status=skipped` 闸门 | ⚠️ 只有 `engineering`（A16 工程分析/布局规则未纳入本次放行）：`skipped ≠ 通过` |
| 产物真实性 | ⚠️ deliverables 3/3 带草稿标记；门禁判为草稿阻断（没有把草稿当正式件） |
| `info` 级 `RELEASE_GATE_PASSED` | 仅出现在 `supply` 的局部提示里？本次没有跨闸门的"整体通过"info —— 无假 PASS |

**结论**：不存在"没证据却显示 ready"的自相矛盾；但 UI/人读报告时**必须**把 `constraints=pass` 与 `engineering=skipped` 当作"未覆盖"而不是"通过"。这也是本次报告把这两点单独标黄的原因。

---

## 4. 代码能力缺口（本次真实调用暴露的 4 个）

1. **门禁路由内置的验收调用不启用 `acceptanceExtraOptions`。**
   `runtime/server.mjs` 的 `/api/eda/release/gate` 在实时验收时调用 `runSchematicAcceptance({ execute, plan, skipSimulation:false })`，没有传 `ercDetail` / `loadSimulationEvidence`；而 `/api/eda/schematic/acceptance` 才传。后果：
   - 门禁的 ERC 明细只能是聚合计数（无逐条）；
   - **即使本机已有真实 ngspice 证据（T3 已产出 `status=ok`、op/tran 均 exit 0），门禁也不会引用它**，A14 仿真闸门仍为 `unknown`。
   建议：把 `acceptanceExtraOptions` 接进 gate 路由，或在 gate body 里显式接受"仿真证据条目"，并如实标注来源与覆盖范围（不是整板仿真）。
2. **DRC 证据没有"绑定当前板"的校验。** gate 的 `drcReportPath`/`drcReport` 只做结构归一化，不校验 pcbUuid 指纹；而 `releaseDecision` 的 binding 只校验 DFM/签核。实测最新 DRC 证据（0 违规）指纹是 `pcbUuid=5d632dde4548e1a0`，与当前板 `5595e77cead09682` **不一致** —— 如果调用方直接把它喂给门禁，会得到"DRC 干净"的假象。本报告因此**没有注入**它。
3. **evidence-store 里已落盘的 DRC 不会自动进入门禁。** DFM/签核由 `evidenceStore.latest()` 自动读取，DRC 却必须由调用方显式传路径/对象；"跑过 DRC 并落盘"对门禁没有帮助，容易造成"以为验过了其实没纳入"。
4. **需求硬约束未接线。** `project-state` 里有 37 条需求（含硬约束），但没有任何代码把它们映射成 gate 的 `constraints`/`designFacts`，所以 `constraints` 闸门永远 `provided=false`。它不阻断，但会让"需求满足"变成未覆盖项（见 §3）。

> 这 4 条都是"产品能力缺口"，不是"设计有问题"；修它们需要改 `runtime/server.mjs`（T1 已占写域，本任务只报告不动代码）。

---

## 5. 交叉参考证据（不注入门禁，只帮人复核）

- **ERC 现状（真实、且与当前工程/页指纹一致）**：`artifacts/evidence/schematic-erc/schematic-erc-2026-10-21T10-58-05-239Z-437da612538c.json` —— `fatal=0 / error=1 / warning=34 / info=2 / total=37`，指纹 `projectUuid=ba4924… / documentUuid=87dba2a2…`。与本次门禁实时验收得到的"ERC 报告 1 个错误"一致。
- **DRC 最新证据（0 违规但绑定的是别的 PCB 指纹）**：`drc-report-2026-10-20T15-22-46-358Z-aff12a180172.json`，`pcbUuid=5d632dde4548e1a0` ≠ 当前 `5595e77cead09682` → **不能当本板 DRC 证据**（见 §4.2）。
- **T3 独立 SPICE 证据（真实网表 + 真实 ngspice，但非整板仿真、且未被门禁消费）**：
  - 网表：`artifacts/spice/netlist-2026-10-21T11-35-31-155Z.net`（168,941 B，sha256 `a7bbca3fe9f0ab3738d05ddb704f6e119fc8297895e7515ed432651e05fec3e2`，64 器件 / 266 引脚 / 95 有网引脚 / 34 网络）；
  - 仿真证据：`artifacts/spice/simulation-evidence-2026-10-21T11-35-31-155Z.json`（`status=ok`；ngspice-46 `.op`/`.tran` 均 exit 0；`vbus=5.000 V`、`vbus_vin=4.975 V`、`vbat_pack=3.740 V`、`vbat_end=4.138 V@1800s`）；
  - EDA 官方 SPICE 网表导出 `null`（`EDA_SPICE_NETLIST_EXPORT_NULL`）：该页未绑定仿真器件模型，这是"整板仿真不能自动"的直接证据；
  - 该证据含 5 条人工假设（IP2312 行为模型、电池等效、源电压等），**不是**实测器件模型结果。
- **DFM / 人工终审签核**：均无（`artifacts/evidence` 下无对应目录）。

---

## 6. 从 blocked 到可放行：按归属的执行顺序（不是本任务做）

1. **人工**：处理 ERC 1 个 error（T4 triage 给出逐条建议）；确认布局（`userConfirmed=true` 由人负责）。
2. **流程**：在 EDA 跑 PCB DRC 并用证据路由落盘（且必须绑定当前 `pcbUuid=5595e77c…`）；补齐在线 DFM 回填与人工终审签核。
3. **外部数据**：补 BOM 供应商料号/价格/库存（立创可信来源，不伪造）；修正 CPL 导出基准/版本，使其与实机读回一致（当前偏差 78–117mm）。
4. **代码**：修 §4 的 4 个能力缺口（门禁接仿真证据回退、DRC 绑定校验、DRC 自动取证、需求约束映射）。
5. **产出**：以上证据齐、门禁 `ready=true` 后，才允许走正式导出（去掉 `-DRAFT-NOT-FOR-ORDER`），再由人工终审签核，最后才可能下单（自动下单永久禁用）。

---

## 7. macOS 签名 / 公证就绪结论（与本任务另一条线）

实测（`node scripts/check-signing-readiness.mjs`，退出码 1 = 有阻断）：

| 项 | 实测 |
|---|---|
| 签名状态 | **ad-hoc**（`Signature=adhoc`，`flags=adhoc,linker-signed`，`TeamIdentifier=not set`） |
| bundle 结构 | `Contents/_CodeSignature/CodeResources` **缺失**，`codesign --verify --deep --strict` 失败（`code has no resources but signature indicates they must be present`） |
| Gatekeeper | `spctl` 拒绝 |
| 公证票据 | `stapler validate` 失败：没有票据 |
| 证书 | `security find-identity -v -p codesigning` 只有 1 个 `Apple Development`，**没有 Developer ID Application** |
| notarytool | 可用（1.1.2 (41)） |
| 构建配置 | `hardenedRuntime=true`、entitlements 文件存在（network client/server） |
| 内嵌 Node sidecar | 官方 Node.js（Developer ID: Node.js Foundation），带 `get-task-allow` 等调试 entitlement（公证前建议重签为最小 JIT 集） |

**`readyForDistribution=false`**，阻断：`APP_BUNDLE_SIGNATURE_STRUCTURE_INVALID`、`DEVELOPER_ID_APPLICATION_CERT_MISSING`、`SIGNING_ADHOC`、`NOTARIZATION_TICKET_MISSING`；警告 4 条（主程序未通过校验/无 entitlements、sidecar 带 get-task-allow、公证凭证未验证）。
完整操作步骤、entitlements、常见失败与**用户必须提供的凭证边界**见 `docs/macos-signing.md`。

> 注意：签名/公证是 **app 分发门禁**，与 PCB 放行门禁是两条独立红线；它们都不能靠伪造证据通过，本任务也没有重签/重装/公证现有 app。

---

## 8. 复现

```bash
# 门禁报告（需要运行时令牌；令牌只从环境变量/本机临时文件读取，不写进报告）
CIRCUITPILOT_RUNTIME_TOKEN=<令牌> node scripts/release-gate-report.mjs
#   → artifacts/release-gate-real/gate-<ts>.json + .md
#   → 退出码 0 = 调用成功且报告已落盘（门禁 blocked 也算成功）；1 = 运行时不可达/令牌无效/调用失败

# 只做预检（health/桥/目标/证据扫描，不调用门禁）
CIRCUITPILOT_RUNTIME_TOKEN=<令牌> CIRCUITPILOT_GATE_DRY_RUN=1 node scripts/release-gate-report.mjs

# 签名/公证就绪检查（只读）
node scripts/check-signing-readiness.mjs
#   → artifacts/release-gate-real/signing-readiness-<ts>.json/.md/.yaml
#   → 退出码 0 = 全就绪；1 = 有阻断（以报告为准）
```

两个脚本均无第三方依赖、无网络下载、不写 EDA、不重签/不安装 app；`node --check` 均通过。

---

## 9. 本次没有做什么（边界）

- 没有签发任何放行批准/审批令牌；
- 没有写 EDA 设计（无 `schematic.*.set/place`、`pcb.*.apply`、`routing.apply`、`pour.create`）；
- 没有导出正式生产文件、没有调用 `production/export` / `releases/archive`；
- 没有重签/重装/公证 `/Applications/CircuitPilot.app`（只做只读检查）；
- 没有启动新端口服务（复用已在运行的源码 sidecar `127.0.0.1:4181`）；
- 没有把 DRC/SPICE 历史证据注入本次门禁（只在报告里交叉参考并标注绑定风险）。
