# 第 61 轮 · 放行门证据接线硬化（仿真证据消费 + DRC 证据 PCB 绑定）

范围：`runtime/server.mjs`（gate 取证/校验/接线）、`runtime/release-gate.mjs`（simulation / drc 子门）、
新增离线契约测试。不写 EDA、不改 T6 脚本、不构建安装包。

## 1. 背景：T6 真机报告暴露的两个"代码能力缺口"

T6 用真机跑 `/api/eda/release/gate` 得到 `artifacts/release-gate-real/gate-*.json`，暴露：

1. **仿真证据永远不被消费**：T3 已用真实网表 + 真 ngspice 产出
   `artifacts/spice/simulation-evidence-*.json`（`kind=spice-simulation-evidence`、netlist sha256、
   runs exitCode=0、数值结果），但 gate 路由没有仿真证据输入通道，simulation 子门永远是
   `RELEASE_SIMULATION_NOT_RUN`——即使证据就在磁盘上。
2. **DRC 证据不校验 PCB 绑定**：最新 DRC 证据 `pcbUuid=5d632dde4548e1a0`，当前板是
   `5595e77cead09682`。若把这份报告喂给 gate，会得到"DRC 干净"的假结论。

两个问题都属于"证据接线"而非板子数据，本轮在代码里修掉。

## 2. 变更一：可选仿真证据输入（fail-closed 消费）

### 2.1 输入形态

`POST /api/eda/release/gate`（以及共用同一取证的 `/api/production/release` 等）新增可选字段：

```jsonc
{
  "pageUuid": "87dba2a22fe7096e",
  "pcbUuid": "5595e77cead09682",
  "acceptanceExtraOptions": {
    // 本机 JSON 证据文件路径（T3 产物），或同形状内联对象
    "simulationEvidence": "artifacts/spice/simulation-evidence-2026-10-21T11-35-31-155Z.json"
  }
}
```

兼容顶层写法 `"simulationEvidence": "<path|object>"`。**不传 = 不消费**（保持旧行为）。
提供但不可用 → 不静默忽略，也不降级成"没跑"。

### 2.2 服务端 fail-closed 校验（`runtime/server.mjs`）

`validateReleaseSimulationEvidence()` 依次校验，任一失败都返回 `rejected`：

| 检查 | 失败语义 |
| --- | --- |
| 路径可读 / JSON 可解析 / 是对象 | `RELEASE_SIMULATION_EVIDENCE_INVALID` |
| `kind === 'spice-simulation-evidence'` | INVALID（别的报告不能冒充仿真证据） |
| `status === 'ok'` | INVALID |
| `generatedAt` 可解析、不过期（复用 `CIRCUITPILOT_SIM_EVIDENCE_MAX_AGE_HOURS`，默认 24h）、不在未来 | INVALID（旧证据必须重跑，不能放行） |
| `netlist.sha256` 为 64 位 hex、`parseable !== false`、`componentCount > 0` | INVALID（没有真实网表＝没证据） |
| `runs` 非空且每个 `exitCode === 0` | INVALID（求解器失败不能当通过） |
| `results` 至少有一个有限数值 | INVALID（没有可复核结论） |
| 证据记录了工程 UUID 且与当前 EDA 工程指纹一致 | `RELEASE_SIMULATION_EVIDENCE_UNBOUND` |
| 证据记录的原理图页与请求页一致（若都能拿到） | UNBOUND（页不一致） |
| 实时导出网表 sha256 可用时必须与证据 `netlist.sha256` 一致 | UNBOUND（不是这块板当前版本的网表） |
| 既无匹配页、也无实时网表 sha256 可对照 | UNBOUND（无法确认归属，fail-closed） |

校验通过后映射成 `acceptance.simulation`（含 `evidencePath/evidenceHash/source/solver/scopeNote/
partial/coverage/binding/netlist`）。**覆盖范围永远标注为 `partial: true`**：T3 deck 是从真实网表里
挑出的关键子电路（USB-C VBUS → IP2312 充电 → VBAT），EDA 侧整板 SPICE 网表导不出
（`edaSimulationNetlist.available=false`），所以它**不是整板仿真**。

### 2.3 闸门语义（`runtime/release-gate.mjs` → `gateSimulation`）

| 情形 | 子门状态 | 代码 |
| --- | --- | --- |
| 没提供输入 | unknown | `RELEASE_SIMULATION_NOT_RUN`（不变） |
| 提供但校验失败 | unknown | 具体原因：`SIMULATION_EVIDENCE_INVALID` / `SIMULATION_EVIDENCE_UNBOUND` |
| 校验通过并消费（仅关键子电路） | **unknown** | **`RELEASE_SIMULATION_COVERAGE_PARTIAL`**（"已消费 ≠ 通过，整板模型仍缺"） |
| 验收自带 `designChecks` 且全部通过 | pass/warn/blocked | 原有逻辑不变 |

这样报告能如实区分"没提供 / 提供了但不可用（含绑定不符）/ 已消费但仍不够"，且**不会因为磁盘上有
一个 JSON 就出现假 PASS**。放行报告新增 `evidenceBinding.simulation`（`consumed/evidencePath/
evidenceHash/partial/binding/rejected`）与各子门 `evidence.*` 自证字段。

## 3. 变更二：DRC 证据必须绑定当前 PCB

### 3.1 输入与绑定抽取

DRC 输入支持两种真实形状（`body.drcReport` 内联对象，或 `body.drcReportPath` 指向文件）：

- 裸 DRC 报告（原有）；
- 证据库条目 `{kind:'drc-report', fingerprint:{pcbUuid}, payload:{report}}`——此前这种形状会被
  `normalizeDrcReport` 判成"结构不可识别"且绑定信息丢失，现在由 `normalizeReleaseDrcReport()`
  解包报告并把绑定信息保留在 `report.binding = {pcbUuid, projectUuid, savedAt, digest}`。

当前目标 PCB（`targetPcbUuid`）：实机路径取 `readPcbPlacement()` 解析出的 PCB；全离线注入证据时取
请求里的 `body.pcbUuid`。

### 3.2 闸门语义（`gateDrc({ report, exemptions, targetPcbUuid })`）

| 情形 | 子门状态 | 代码 |
| --- | --- | --- |
| 有 target 且证据 pcbUuid 一致 | 按原规则判定 + info"已绑定" | 原有 DRC 码 |
| 有 target 且证据 pcbUuid 不一致 | **blocked** | **`RELEASE_DRC_EVIDENCE_PCB_MISMATCH`**（消息写明两个 UUID） |
| 有 target 但证据没有 pcbUuid | **unknown** | **`RELEASE_DRC_EVIDENCE_UNBOUND`**（"无法归属"不是"干净"） |
| 未给 target（旧调用/离线单测） | 保持旧行为 | 能判则判，`evidence.binding.matched=null`，不宣称绑定 |

`gateFabricationRelease()` 新增 `targetPcbUuid` / `simulationEvidence` 参数并写入
`report.evidenceBinding`；DRC 子门 `evidence.binding` 记录 target/evidence UUID、是否匹配、
savedAt/digest。

## 4. 兼容性

- **不传新字段的调用方行为不变**：仿真仍按原逻辑（无证据 → NOT_RUN），DRC 没有 target 时按原规则判定。
- 新增 4 个 release 错误码；前端/脚本按 `gate.status` + `code` 展示，无需改解析。
- T6 脚本 `scripts/release-gate-report.mjs` 的 `CATEGORY` 分类表没有这 4 个新码，若其报告出现它们会被归为
  `unknown`（"待人工归类"）——这是诚实降级，不会当成通过；本轮按约束未改该脚本。
- DRC 输入接上绑定后，**给 target 的调用方**若一直传"别的板的旧报告"，会从"pass"变成 blocked —— 这正是要修的假结论，不是回归。
- 未改动 T6 脚本、EDA 写入路径、`eda-gui.mjs` / `eda-erc-detail.mjs` / `bridge.mjs`。

## 5. 测试证据

### 5.1 离线契约（全绿）

```bash
node --test --test-timeout=120000 \
  runtime/__tests__/release-gate.test.mjs \
  runtime/__tests__/release-evidence-binding.test.mjs \
  runtime/__tests__/constraints.test.mjs \
  runtime/__tests__/multilayer-http.test.mjs \
  runtime/__tests__/route-contract.test.mjs
# tests 51 / pass 51 / fail 0
```

本轮新增：

- `release-gate.test.mjs`（+2 条）：DRC 绑定一致/不一致/缺 pcbUuid/无 target 旧行为；仿真
  "已消费但只有子电路 → unknown"、校验失败报具体原因而非 NOT_RUN。
- `release-evidence-binding.test.mjs`（新，5 条，真实 `createRuntimeServer` + 假桥，HTTP 端到端）：
  仿真证据正常消费（COVERAGE_PARTIAL、`netlistSha256MatchedLive=true`、`ready=false`）、
  绑定不符（UNBOUND，含两个工程 UUID）、缺证据（NOT_RUN）、不可用（文件缺失/kind 错/run 非 0 →
  INVALID）、DRC 一致/不一致/缺 pcbUuid 三态。

### 5.2 真机验证（只读、不写 EDA）

> 说明：已在跑的 sidecar 4181 进程启动于改动之前，加载的是旧代码；按约束**没有重启它**，而是用当前代码
> 在 **4199** 起了临时 runtime（独立 state/evidence 目录、独立令牌），对真实 EDA 桥（49620）+ 真 T3/DRC
> 证据做只读验证。4181 未被改动。

基线（不带新字段，T6 同款 body）→ `simulation unknown RELEASE_SIMULATION_NOT_RUN`、`ready=false`。

喂真实 T3 证据（`artifacts/spice/simulation-evidence-2026-10-21T11-35-31-155Z.json`）：

```
simulation: unknown ["RELEASE_SIMULATION_COVERAGE_PARTIAL"]
已消费: true, partial: true
覆盖: decks=2, usedComponents=4, usedNets=3, edaSimulationNetlistAvailable=false
绑定: projectUuid=ba4924190e3a4388a097f3dee090da20, pageUuid=87dba2a22fe7096e,
      pageMatched=true, netlistSha256=a7bbca3fe9f0…, targetPcbUuid=5595e77cead09682
ready: false / verdict: blocked   ← 有证据也绝不放行
```

（该路由先读 PCB 布局再导出网表，活动文档是 PCB 时 `design.netlistSha256=null`，因此本次绑定依据是
工程 + 原理图页指纹；若实时网表 sha 可用，代码会强制与证据 sha 比对，不符即 UNBOUND。）

绑定不符（同一份证据把工程 UUID 改成 `P-OTHER`）→ `simulation unknown RELEASE_SIMULATION_EVIDENCE_UNBOUND`，
消息："仿真证据属于工程 P-OTHER，当前工程是 ba4924…：这是别的工程的证据"，`consumed=false`。

真实最新 DRC 证据（`artifacts/evidence/drc-report/…-aff12a18…json`，`fingerprint.pcbUuid=5d632dde4548e1a0`）
对当前板 `5595e77cead09682`：

```
drc: blocked ["RELEASE_DRC_EVIDENCE_PCB_MISMATCH"]
消息：DRC 证据属于 PCB 5d632dde4548e1a0，当前目标是 5595e77cead09682：
      这是另一块板/上一版板的报告，不能当作当前板 DRC 结论
ready: false / verdict: blocked
```

### 5.3 重跑 T6 报告的结论（诚实记录）

按约束**未修改** `scripts/release-gate-report.mjs`，把它指向 4199 重跑（输出到 `/tmp/cp-t7-gate-reports/`，
不污染仓库 artifacts）：

- 报告 `status=gate-blocked`、`gateReady=false`、`verdict=blocked`、`passIllusionScan=needs-review`；
- 请求体仍是 `{pageUuid,pcbUuid,artifactsDir,userConfirmed}` —— **脚本没有发送新的可选字段**，所以其报告里
  simulation 仍是 `RELEASE_SIMULATION_NOT_RUN`。这是"脚本没喂证据"的如实结果，不是假 PASS。
- 要让该脚本报告直接呈现三种状态，只需在 `REQUEST_BODY` 增加一行（本次按约束未做）：
  `acceptanceExtraOptions: { simulationEvidence: <最新 T3 证据路径> }`。
  三种状态已由上面的直连 gate 调用验证并记录。

## 6. 复现

```bash
# 离线
node --test --test-timeout=120000 runtime/__tests__/release-gate.test.mjs \
  runtime/__tests__/release-evidence-binding.test.mjs

# 真机（等价于临时 runtime 验证；4181/4178 未重启时也可直接对它们调用，但需其加载新代码）
TOKEN=...; BASE=http://127.0.0.1:4199
EV=$(ls -t artifacts/spice/simulation-evidence-*.json | head -1)
curl -s -H "content-type: application/json" -H "x-circuitpilot-token: $TOKEN" \
  -d "{\"pageUuid\":\"87dba2a22fe7096e\",\"pcbUuid\":\"5595e77cead09682\",\"userConfirmed\":false,\"acceptanceExtraOptions\":{\"simulationEvidence\":\"$EV\"}}" \
  $BASE/api/eda/release/gate | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.gates.find(g=>g.id==="simulation"))})'
```

## 7. 风险与未闭环

- **整板仿真仍缺**：T3 证据只覆盖关键子电路，EDA 侧整板 SPICE 模型导不出。即使被消费，simulation 仍是
  unknown（`RELEASE_SIMULATION_COVERAGE_PARTIAL`）——这是真实状态，不是本轮能补的。
- **DRC 真证据仍不可用**：本机最新 DRC 属 `5d632dde…`（与当前板 `5595e77c…` 不符），gate 会 blocked；
  需要在当前板上重跑 DRC 并落盘绑定 `pcbUuid` 的证据。
- 临时 runtime 4199 仅用于验证，验证后可关闭；未触碰 4178/4181/4182 与安装包。
