# 知识类型谱 v2（8 类）

> 一句话：**`kind` 只表达"身份 + 生命周期"，`topic` 表达主题。** 核心 4 类 + 扩展 4 类，共 8 类；主题标签（anti-pattern / precedent / eda-compat 等）放在 `payload.topic`，不膨胀 kind 枚举。
>
> 代码真源：`runtime/knowledge.mjs` 的 `KNOWLEDGE_KINDS` / `KNOWLEDGE_CORE_KINDS` / `KNOWLEDGE_EXTENDED_KINDS` / `KNOWLEDGE_KIND_SPECS`。测试：`runtime/__tests__/knowledge-kinds-v2.test.mjs`。

---

## 1. 为什么不再无限加 kind

`kind` 决定的是**身份与生命周期**：目录名（`<kind>/…`）、id 前缀（`kn-<kind>-…`）、`entityKey` 身份字段、去重/版本/冲突规则。`topic` 决定的是**检索与呈现**。如果把每个主题都做成 kind，会带来：

- 每个新 kind 都要改存储、正则、API 校验、UI、数据集校验；
- 同一实体在不同主题下产生重复条目，破坏去重与冲突检测。

因此约定：**新主题优先用 `payload.topic`；只有"身份与生命周期不同"才新增 kind。**

| 原本想新增的主题 | 实际落位 |
|---|---|
| `anti-pattern`（反模式） | `failure` + `payload.topic='anti-pattern'` |
| `precedent`（先例默认值） | `assumption` + `payload.topic='precedent'` |
| `eda-compat`（EDA/版本兼容） | `decision` + `payload.topic='eda-compat'` |
| `eda-compat`（修复动作） | `repair` 的 `actions` 字段，或 `decision` 记录决策 |

---

## 2. 8 类总表

| kind | 类别 | 身份字段（entityKey） | 典型 topic | 生产者 | 消费者 | 门禁关系 |
|---|---|---|---|---|---|---|
| `part` | 核心 | `lcscId` \| `mpn` \| `url` \| `value+footprint` | — | 采集器 / 人工 / Librarian 核验 | 选型、BOM、封装核验 | 仅作依据，不直接 PASS |
| `module` | 核心 | `moduleId` | — | 数据集 / 复盘 / 人工 | 方案检索、复用 | 同上 |
| `rule` | 核心 | `ruleId` | — | 规则包 / 复盘 / 人工 | 规则判定、门禁建议 | 可支撑 REVIEW/阻断理由；不能替代官方 DRC |
| `failure` | 核心 | `failureId` | `badcase` / `anti-pattern` | KMA / RLA / Field Loop | 门禁建议、计划避坑 | 同上 |
| `repair` | 扩展 | `strategyId` | `fix` / `workaround` | 计划修复 Agent（P1）/ 人工 | 自动修复候选 | 只产候选，不自动写 |
| `assumption` | 扩展 | `assumptionId` | `precedent` / `default` | 需求澄清（P0）/ 复盘 | 澄清排序、默认值建议 | 只作先验，必须被验证覆盖 |
| `decision` | 扩展 | `decisionId` | `design` / `select` / `eda-compat` / `policy` | 人工 / Agent（P1） | 审批、解释、复盘 | 记录"为什么"，不参与判定 |
| `eval-case` | 扩展 | `caseId` | `golden-board` / `regression` | Field Loop / 历史纠正 / 人工 | 评估台、回归 | 只做评估，不影响单板门禁 |

**核心四类**（`KNOWLEDGE_CORE_KINDS`）保持可灌库、可由数据集生成；**扩展四类**（`KNOWLEDGE_EXTENDED_KINDS`）由运行期/复盘生成，不要求数据集灌库。

---

## 3. 通用信封（沿用现有 store schema，不新增顶层字段）

每条知识的落盘结构不因 kind 扩展而改变：

```json
{
  "id": "kn-<kind>-<fingerprint 前 16 位>",
  "kind": "repair",
  "title": "修复杂志：补板框尺寸缺失",
  "payload": { "...": "按 §4 约定" },
  "provenance": { "source": "required", "url": "optional", "version": "optional", "fetchedAt": "optional", "collector": "optional" },
  "trust": "unverified | reference | authoritative",
  "ttlDays": 30,
  "review": { "state": "candidate | approved | rejected", "reviewedBy": "optional", "reviewedAt": "optional" },
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "digest": "<整条内容 sha256>"
}
```

读取时额外派生 `entityKey`（用于检索/冲突/去重）与 `expired`（TTL）。**不新增顶层字段**，是为了保持 digest、文件格式与既有 463 条候选知识完全兼容。

**约定**：每个 kind 的 `payload` 都是自由 JSON，但 §4 的字段是"语义约定"——写入方按约定填，消费方按约定读；`payload.topic` 是主题标签（字符串，建议用 §2 表中的值）。

---

## 4. 各类 payload 约定

### 4.1 核心四类

沿用现有数据集规范（见 [`docs/knowledge/README.md`](./README.md) 与 `knowledge/pcb/dataset/`、`scripts/seed-knowledge-pcb.mjs` 的 `REQUIRED` 校验），不在本文重复。

### 4.2 `repair`（修复策略）

| 字段 | 必填 | 说明 |
|---|---|---|
| `strategyId` | ✅ | 身份：如 `repair:MISSING_OUTLINE`（按错误码族/缺失码） |
| `errorCode` | ✅ | 对应 `plan.missing` / 工具错误码 |
| `preconditions` | ✅ | 前置条件数组（不满足不得套用） |
| `actions` | ✅ | 修复动作数组（确定性、可回放） |
| `riskLevel` | ✅ | `low` / `medium` / `high`（决定自动/候选/人工） |
| `sideEffects` | ✅ | 副作用数组（无则 `[]`） |
| `verifyBy` | ✅ | 修复后用什么证据验证（如 `design-spec.outline`） |
| `successRate` / `sampleCount` | 否 | 使用统计，由 usage 回灌维护 |
| `scope` | 否 | 适用域（板型/工艺/EDA 版本），缺省视为"通用" |
| `topic` | 否 | `fix` / `workaround` |

```json
{
  "strategyId": "repair:MISSING_OUTLINE",
  "errorCode": "MISSING_OUTLINE",
  "preconditions": ["board.outline 缺失", "未锁定结构图"],
  "actions": ["用 DXF 点集生成 outline", "无 DXF 时按结构图宽高生成"],
  "riskLevel": "low",
  "sideEffects": [],
  "verifyBy": "design-spec.outline",
  "topic": "fix"
}
```

### 4.3 `assumption`（受控假设 / 先验默认值）

| 字段 | 必填 | 说明 |
|---|---|---|
| `assumptionId` | ✅ | 身份：板型/参数族，如 `board-class:esp32-usbc-3v3-2l` |
| `scope` | ✅ | 适用域：`{ boardType, layers, process, edaVersion? }` |
| `parameter` | ✅ | 被假设的参数名（如 `stackup`、`traceWidthDefault`） |
| `value` | ✅ | 假设值（JSON） |
| `rationale` | ✅ | 依据（来源/样本数/经验） |
| `confidence` | ✅ | 0–1；低置信度只能"问人"，不能自动采用 |
| `verifyBy` | ✅ | 后续用什么证据覆盖该假设 |
| `expiresWith` | 否 | 失效条件（如新板型/新工艺） |
| `topic` | 否 | `precedent` / `default` |

```json
{
  "assumptionId": "board-class:esp32-usbc-3v3-2l",
  "scope": { "boardType": "mcu-usb", "layers": 2, "process": "jlc-1.6mm" },
  "parameter": "stackup",
  "value": { "layers": 2, "thicknessMm": 1.6, "copperOz": 1 },
  "rationale": "同类板 10/12 例采用 2 层 1.6mm",
  "confidence": 0.8,
  "verifyBy": "engineering.stackup",
  "topic": "precedent"
}
```

### 4.4 `decision`（决策记录 / 设计理由）

| 字段 | 必填 | 说明 |
|---|---|---|
| `decisionId` | ✅ | 身份，如 `decision:runtime-agent-routes` |
| `topic` | ✅ | `design` / `select` / `eda-compat` / `policy` |
| `context` | ✅ | 决策背景（问题/约束） |
| `options` | ✅ | 备选方案数组 |
| `chosen` | ✅ | 选定方案 |
| `rationale` | ✅ | 理由（含取舍） |
| `evidenceRefs` | ✅ | 证据引用（文档/证据文件/门禁记录） |
| `supersedes` | 否 | 取代的旧 decisionId（保留历史可追溯） |

```json
{
  "decisionId": "decision:runtime-agent-routes",
  "topic": "eda-compat",
  "context": "旧构建 0.8.15 缺 project-state/issue-state 等路由",
  "options": ["兼容旧构建", "换用 0.2.x Runtime"],
  "chosen": "换用 0.2.x Runtime 并 fail-closed",
  "rationale": "旧构建没有 agent 通道，兼容会导致静默 404",
  "evidenceRefs": ["docs/agent/plugin-compat.md"]
}
```

### 4.5 `eval-case`（评估 / 回归用例）

| 字段 | 必填 | 说明 |
|---|---|---|
| `caseId` | ✅ | 身份，如 `eval:batch-validation-board-pass` |
| `input` | ✅ | 输入（需求/板/计划/targets） |
| `expected` | ✅ | 期望结果（结构化，断言用） |
| `goldenEvidence` | ✅ | 金证据引用（证据文件/哈希） |
| `severity` | 否 | `critical` / `error` / `warning`（回归失败时的严重度） |
| `topic` | 否 | `golden-board` / `regression` |

```json
{
  "caseId": "eval:batch-validation-board-pass",
  "input": { "boards": ["pcb-a", "pcb-b"], "targets": ["drc"] },
  "expected": [
    { "board": "pcb-a", "ok": true },
    { "board": "pcb-b", "ok": false, "failedTargets": ["drc"] }
  ],
  "goldenEvidence": "artifacts/agent-eda-batch-20261029.json",
  "severity": "error",
  "topic": "golden-board"
}
```

---

## 5. 身份 / 版本 / 冲突 / 生命周期

- **entityKey**：由身份字段派生；缺失抛 `KNOWLEDGE_KEY_MISSING`（fail-closed，不落无法去重的知识）。
- **版本**：同 `entityKey`、不同 `payload` → 不同 `fingerprint` → 不同 id（多版本共存，旧版本仍可取回）；同内容重复保存只更新元数据（不把已 approved 打回 candidate）。
- **审核**：`candidate → approved/rejected`；API/采集器/Agent 写入一律 `candidate`；`authoritative` 必须人工审核并记录 `reviewedBy`。
- **TTL/过期**：过期条目默认从 `list`/RAG 排除，`isUsableForGate` 为 false；过期不是删除，审计仍可查。
- **作用域**：`assumption`/`repair`/`decision`/`eval-case` 建议/要求写 `scope`（板型、工艺、EDA 版本），避免过拟合历史板；缺 scope 视为"通用"，但消费方应在跨板复用时提示风险。
- **冲突**：同一 entityKey 的 approved 条目关键字段不一致 → `detectConflicts`；冲突口径见 [`conflict-register.md`](./conflict-register.md)，证据优先于知识。

---

## 6. 门禁交互铁律

1. 知识只能**加严或转 REVIEW**，不能自动 PASS、不能替代证据/官方 DRC/ERC。
2. 只有 `approved` + 未过期 + `trust ∈ {authoritative, reference}` 可用于门禁引用（`store.isUsableForGate`）。
3. 证据 > 知识；知识冲突不静默采用，进入冲突登记。
4. 采用/否决都写 usage（`used`/`overturned`），用于质量评估。
5. 新类型与核心类型同等对待：AI 只能提候选，权威级必须人工审核。

---

## 7. 向后兼容与迁移

- 既有 4 类条目**零改动**：文件格式、digest、目录、id 全部不变。
- 新 kind 目录按需创建（`root/<kind>/`），空目录不报错。
- `id` 正则由 `KNOWLEDGE_KINDS` 派生：`^kn-(part|module|rule|failure|repair|assumption|decision|eval-case)-[a-f0-9]{16}$`。
- **覆盖率分母 4 → 8**：`healthMetrics.coverage` 与 UI「类型覆盖」现在反映全类型谱；核心数据集仍只灌核心 4 类，因此初始覆盖率会显示为 50%，这是**如实反映**，不是回归。
- 数据集校验（`scripts/seed-knowledge-pcb.mjs`）只要求核心四类；新增 kind 不需要改数据集。
- 新增 kind 的步骤（未来再扩展时）：
  1. `runtime/knowledge.mjs`：`KNOWLEDGE_EXTENDED_KINDS` + `KNOWLEDGE_KIND_SPECS`（身份字段/主题）；
  2. 测试：`runtime/__tests__/knowledge-kinds-v2.test.mjs` 增加样例与身份/版本/审核断言；
  3. UI：`src/pages/KnowledgePage.tsx` 的 `KNOWLEDGE_KIND_OPTIONS` / labels；
  4. 文档：本文 §2/§4 补一行/一节；
  5. 跑 `node --test runtime/__tests__/knowledge*.test.mjs` + `npm run typecheck`。

---

## 8. 验收

```bash
cd "/Users/jescochen/Desktop/AI- PCBA"
node --test runtime/__tests__/knowledge*.test.mjs   # 当前 79 项全绿（含 knowledge-kinds-v2）
npm run typecheck                                    # TS 通过
npx vitest run src/pages/__tests__/verification-knowledge-smoke.test.tsx
```

已覆盖：类型谱常量/身份字段/主题标签；扩展四类 save/list/get/query；缺失身份 fail-closed；同 entityKey 多版本与幂等；审核/TTL/门禁可用性；RAG 语料带 `knowledgeKind` 元数据。

关联文档：[风险规避矩阵](./RISK-MITIGATION-MATRIX.md) · [知识库 README](./README.md) · [知识索引](./KNOWLEDGE-INDEX.md)。
