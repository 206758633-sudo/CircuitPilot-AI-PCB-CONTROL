# 复合 PCB 设计框架（Composite Design Framework）

> 目标：把「需求 → 可执行约束 → 方案 → 确定性验证 → 自动修复」做成**离线、可复现、可审计**的闭环，
> 让 EDA 从"每一步迭代的必经之路"变成"编译目标 + 最终验证 oracle"。
>
> 落点：`runtime/design-framework/**` + `eval/golden/**` + `scripts/design-framework.mjs`。
> 关联：知识类型谱 v2（[`docs/knowledge/KNOWLEDGE-KINDS-V2.md`](../knowledge/KNOWLEDGE-KINDS-V2.md)）、
> 风险规避矩阵（[`docs/knowledge/RISK-MITIGATION-MATRIX.md`](../knowledge/RISK-MITIGATION-MATRIX.md)）。

---

## 1. 为什么是"复合"

单一框架都无法同时解决"准确"和"自主"：

| 层 | 解决什么 | 本仓库实现 | 外部等价物（可替换/对接） |
|---|---|---|---|
| Design-as-Code | 统一、可哈希、可离线迭代的板级模型 | `board-model.mjs`（IR + 适配器 + 编译 EDA 操作） | atopile / tscircuit / SKiDL / JITX |
| Rule-as-Code | 把设计规则变成可执行判定，而不是散文 | `rule-deck.mjs` + `ipc-rules.mjs`（151 条规则判定器 + IPC 公式） | IPC-2221/2222/7351、JLC 能力表、KiCad DRC |
| External DRC | 官方/第三方 DRC 作为最终 oracle | `kicad-drc.mjs`（只读适配，缺工具 fail-closed） | KiCad CLI、EasyEDA DRC、JLC DFM |
| Solvers | 用算法选参数，而不是拍脑袋 | `solvers/{placement,stackup,netlist}.mjs`（纯 JS 确定性） | OR-Tools CP-SAT / Z3 / Shapely（旁路 sidecar） |
| Plan-Verify-Repair | 有界闭环，只做确定性修复 | `loop.mjs` + `repair-strategies.mjs` | LangGraph / Temporal（耐久编排） |
| Golden Evaluation | 自主性改动的度量门禁 | `eval.mjs` + `eval/golden/*.json` | 金板回归 / 属性测试 |

**边界**：本机离线、runtime 零依赖，所以求解器是"纯 JS 等价物"（不是 CP-SAT/Z3 的替代品），
外部工具只做**探测 + 适配 + fail-closed**，绝不在缺失时假装可用。

---

## 2. 数据流

```
design-spec / PCB plan / EDA readback
        │  boardModelFromDesignSpec / boardModelFromPcbPlan
        ▼
   Board Model IR（schemaVersion=1，digest 可复现）
        │
        ├─► rule-deck.evaluateRuleDeck(model) ──► findings(PASS/FAIL/REVIEW/NA) + summary(coverage)
        ├─► solvers.solveStackup / solvePlacement / checkNetlist
        └─► loop.runDesignLoop(model)
                 ├─ verify（网表 + 叠层缺失 + 几何 + 规则）
                 ├─ repair（solve_stackup → solve_placement，确定性）
                 ├─ 再验证（有界迭代，默认 ≤4 轮）
                 └─ evidence（initial/final digest、每轮记录、修复清单、编译操作）
                        │
                        ├─► eval.runGoldenEvaluation（金板回归指标）
                        └─► gate / 审批链（后续：写 EDA 前的人工批准）
```

---

## 3. 各层契约与 fail-closed 规则

### 3.1 `board-model.mjs`（Design-as-Code）

- 导出：`createBoardModel`、`validateBoardModel`、`boardModelDigest`、`summarizeBoardModel`、
  `boardModelFromDesignSpec`、`boardModelFromPcbPlan`、`toPcbOperations`、`outlineClosed`。
- IR：`{ schemaVersion, meta, board{widthMm,heightMm,layers,thicknessMm,copperOz,outline,keepouts,mountingHoles,fiducials}, stackup, components[], nets[], rules }`。
- fail-closed：缺板尺寸/层数非法/位号重复/网络引用未知器件/叠层层数与板层数不一致/keepout 非法 → 抛带 code 错误；
  尺寸未知必须显式 `sizeUnknown:true`，**不许猜**；`toPcbOperations` 对没有 `placementId` 的器件只报告 `skipped`，不按 ref 猜 primitiveId。

### 3.2 `rule-deck.mjs` + `ipc-rules.mjs`（Rule-as-Code）

- 规则包：复用 `runtime/engineering/rules/board-layout-rules.json`（151 条），不另抄数值。
- `evaluateRuleDeck(model)` → `{ findings, summary{total,pass,fail,review,na,blocking,machineCheckable,coverageRatio,releaseReady}, digest }`。
- 判定：**没有机器判据 → REVIEW（`NO_MACHINE_CHECKER`/`FACT_MISSING`），绝不 PASS**；不适用才 NA。
- `releaseReady = blocking===0 && review===0`：REVIEW 不清零就不能宣称"可放行"。
- IPC 公式（`currentCapacityA`/`widthForCurrent`/`viaCurrentCapacityA`/`minClearanceMm`）全部返回公式与假设，
  输入非法 fail-closed；数值是近似，必须结合厂家能力表复核。

### 3.3 `kicad-drc.mjs`（外部 DRC oracle）

- `detectKicadCli()`：本机没有 `kicad-cli` → `available:false`。
- `runKicadDrc({ pcbFile })`：缺命令/缺输入 → 明确 code；报告解析失败 → `KICAD_DRC_REPORT_INVALID`；
  **绝不返回"0 违规"假装通过**（与 `runtime/simulation.mjs` 的"编造证据"教训一致）。

### 3.4 `solvers/**`（确定性求解）

| 求解器 | 输入 | 输出 | fail-closed |
|---|---|---|---|
| `solvePlacement` | IR 器件/板框/keepouts/间距 | 坐标 + 未落位 + stats（回溯/候选/预算） | 尺寸未知跳过并记 unplaced；预算超限 → 不返回半成品当成功 |
| `solveStackup` | 层数区间/厚度/铜厚/阻抗目标 | 候选叠层 + 线宽 + alternatives | 目标不可行 → 明确 infeasible，不返回"看起来可用"的叠层 |
| `checkNetlist` | IR nets（+ 意图网表） | 短路/单端/差异 findings | 电气意图不自动改，只报告 |

外部求解器探测：`detectExternalSolvers()` 只报告 `available:false`，不假装 OR-Tools/Z3/Shapely 可用；
接入方式见 §5。

### 3.5 `loop.mjs`（Plan-Verify-Repair）

- 验证段只读：网表 + 叠层缺失 + **独立几何检查**（不复用求解器分支，避免"我算的=我验的"）+ 规则层。
- 修复段只做两类确定性修复：`solve_stackup`、`solve_placement`。
- 状态语义：
  - `passed`：blocking=0 **且** review=0；
  - `needs-review`：blocking=0 但有 REVIEW（缺证据/无机器判据），需人工；
  - `blocked`：仍有阻断且无可修复动作（网表短路/尺寸未知/求解不可行）。
- 不写 EDA、不自动签核；输出 `plan.operations` 只作为审批后的执行候选。

### 3.6 `eval.mjs` + `eval/golden/*.json`（金板评估台）

- 用例格式：`{ id, description, tags, model, options, expect{statusIn, blockingAfter, repairedIncludes, maxRepairs, ...} }`。
- `runGoldenEvaluation({dir, runLoop})` → `{ metrics{total,passed,failed,passRate,statusCounts,avgIterations,totalRepairs,ruleCoverageAvg,failures} }`。
- 指标即门禁：通过率下降/迭代异常/修复次数异常都应在 CI 或本地 `npm run design:eval` 中暴露。
- 当前金板：`fixable-overlap`（可修）、`already-good`（基线）、`stackup-needed`（补叠层）、
  `blocked-size-unknown`（fail-closed）、`blocked-netlist-short`（电气意图不自动改）。

---

## 4. 使用

```bash
cd "/Users/jescochen/Desktop/AI- PCBA"

# 金板评估（回归门禁）
npm run design:eval                       # = node scripts/design-framework.mjs --eval
node scripts/design-framework.mjs --eval --json

# 单用例 / 单模型
node scripts/design-framework.mjs --case eval/golden/01-fixable-overlap.json
node scripts/design-framework.mjs --model my-board.json --max-iterations 4

# 框架状态（KiCad CLI / 外部求解器探测）
node scripts/design-framework.mjs --status
```

在代码里：

```js
import { createBoardModel, runDesignFramework, runGoldenEvaluation, runDesignLoop } from './runtime/design-framework/index.mjs';
const result = runDesignFramework(model, { maxIterations: 4 });
if (result.status === 'needs-review') { /* 把 REVIEW 项交给人/补证据 */ }
const report = runGoldenEvaluation({ dir: 'eval/golden', runLoop: runDesignLoop });
```

---

## 5. 如何接入真实外部框架（适配缝）

| 能力 | 接入方式 | 当前状态 |
|---|---|---|
| atopile / tscircuit / SKiDL | 作为 **IR 生产者**：把网表/板框/器件参数转换为 `createBoardModel` 输入（新增 adapter 函数即可，IR 不变） | 未接入（离线无法安装）；IR/适配器接口已就绪 |
| KiCad CLI DRC | `runKicadDrc` 已实现；安装 `kicad-cli` 后 `--status` 会显示 available | 本机未安装 → fail-closed |
| OR-Tools CP-SAT / Z3 / Shapely | 作为 **sidecar**（Python/CLI）实现同签名适配器：`solvePlacement`/`solveStackup`/几何校验；`detectExternalSolvers` 探测，缺失时回退纯 JS | 未安装 → 回退纯 JS |
| Freerouting | 布线后端：IR → DSN → Freerouting → DRC 复核（尚未实现） | 未接入 |
| 门禁/审批 | `loop.evidence` 与现有 evidence/gate 契约对齐；写 EDA 前仍需人工批准 | 部分（证据格式已对齐，审批链复用现有） |

---

## 6. 明确不做 / 已知局限

1. **纯 JS 求解器是启发式回溯**，不是 CP-SAT 的最优性证明；结果必须经规则层与官方 DRC 复核。
2. **无铜层几何/布线/铺铜**：当前 IR 只覆盖板框/器件/网表/叠层约束，几何 DRC 只做"器件级间距/禁布/出板"。
3. **KiCad DRC 未真机验证**（本机无 `kicad-cli`），适配器用 fake CLI 单测；安装后需补真机验收。
4. **IPC 公式是近似**（电流-温升/电气间距），必须结合厂家能力表与实测复核；不替代 IPC 原文与官方 DRC。
5. **不自动写 EDA / 不自动签核 / 不放行订单**：`plan.operations` 仍需审批链。
6. **规则覆盖率是诚实短板**：151 条里只有一部分有机器判据；REVIEW 会阻止 `passed`，这是设计而非缺陷。

---

## 7. 验收与度量

```bash
node --test "runtime/__tests__/design-framework*.test.mjs"
npm run design:eval
npm run typecheck
```

指标（写入评估报告，可作为自主性改动的前后对照）：
- 金板通过率、状态分布（passed/needs-review/blocked）；
- 平均迭代次数、修复次数；
- 规则覆盖率（machineCheckable/151）；
- 未解决阻断项（按 code 分类）；
- （后续）离线验证 vs 官方 DRC 一致率、门禁逃逸率。

---

## 8. 与知识库的关系

- `rule` 知识条目补充"规则判据/测试/复核日期" → 提高 `machineCheckable` 覆盖率；
- `repair` 知识条目补充"missing 码 → 修法/风险/验证" → 扩展 Repair 段策略；
- `decision`（`topic=eda-compat`）记录外部工具/EDA 版本差异；
- `eval-case` 与 `eval/golden/*.json` 互相回灌：人工纠正/现场问题 → 金板用例。
- 铁律不变：知识只能让门禁更严或转 REVIEW，不能替代证据/官方 DRC（见风险规避矩阵 §5）。

---

## 9. 当前实测状态（2026-11-06）

```text
node --test "runtime/__tests__/design-framework*.test.mjs"  → 69/69 pass
npm run design:eval                                          → 5/5 金板通过（passRate=100%）
  needs-review=3（fixable-overlap / already-good / stackup-needed）
  blocked=2（blocked-size-unknown / blocked-netlist-short）
  平均迭代 1.4 · 修复总数 2 · 规则覆盖率均值 21.2%
node scripts/design-framework.mjs --status                   → kicad-cli 不可用；ortools/z3/shapely 不可用（纯 JS 兜底）
```

规则层现状：151 条规则中 **32 条有机器判据**（`machineCheckable=32`，`coverageRatio≈21.2%`），
其余 119 条按 `NO_MACHINE_CHECKER` 判 REVIEW → `releaseReady` 恒为 `false`。
这是**诚实短板**：金板里没有 `passed`，只有 `needs-review`（缺证据/无判据）与 `blocked`（不可修复）。
下一阶段提高覆盖率的路径：补 IR 字段（3D 高度/courtyard/连接器朝向/silk/铜层几何）、
接 KiCad CLI 真机 DRC、把 `rule` 知识条目补上判定器与测试（见 §8 与风险规避矩阵）。

