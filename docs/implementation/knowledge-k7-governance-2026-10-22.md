# K7 知识治理 + K8/K9 内容补齐 · 交付报告

> 日期：2026-10-22 15:49 +0800（Asia/Shanghai）
> 范围：执行 K6 审计建议——先完成 K7 治理（冲突登记/分类/一致性测试/RAG 门禁/运行态重建），并同步完成 K8 P0 与 K9 P1/P2 内容（20 篇新文档 + 172 条结构化条目）。
> 结论：**内容与治理均已落地并通过自动门禁；但 `approved` 仍为 0，知识未获人工批准，不能作为门禁依据。** 这是设计约束，不是遗漏。

## 1. 结果总览

| 指标 | K7 前 | 现在 | 变化 |
|---|---:|---:|---:|
| 人类可读文档 | 38 篇 | **58 篇** | +20 |
| 文档行数 | 6,599 | **12,011** | +5,412 |
| 知识点（KP） | 540 | **1,008** | +468 |
| 结构化条目 | 181 | **353** | +172 |
| rule | 77 | **123** | +46 |
| module（含 case 11） | 48 | **98** | +50 |
| part | 27 | **57** | +30 |
| failure | 29 | **75** | +46 |
| 运行态重复 entityKey | 17 | **0** | 修复 |
| `approved` | 0 | **0** | 仍未人工审核 |
| RAG golden Hit@1 / Hit@3 | 39/39 | **43/43** | 100% |
| RAG 来源正确率 | 未检查 | **43/43** | 100% |
| RAG 负向查询拦截 | 无 | **4/4** | 见 §5 口径 |

## 2. 新增内容（20 篇 / 468 KP）

| 领域 | 文档 | KP | 结构化条目 |
|---|---|---|---:|---:|
| PCB | `09-reliability-derating.md` | 167–200（34） | 10 |
| PCB | `10-testability-production-test.md` | 201–228（28） | 8 |
| PCB | `11-safety-certification.md` | 229–256（28） | 8 |
| PCB | `12-flex-rigid-flex.md` | 257–282（26） | 8 |
| PCB | `13-package-assembly-rework.md` | 283–308（26） | 8 |
| PCB | `14-high-speed-protocols.md` | 309–340（32） | 8 |
| 原理图 | `08-analog-signal-chain.md` | 135–160（26） | 10 |
| 原理图 | `09-sensors-actuators.md` | 161–186（26） | 8 |
| 原理图 | `10-battery-bms.md` | 187–210（24） | 6 |
| 原理图 | `11-rf-antenna.md` | 211–236（26） | 9 |
| 原理图 | `12-power-topologies.md` | 237–262（26） | 10 |
| 原理图 | `13-documentation-eco.md` | 263–286（24） | 5 |
| 元件 | `08-inductors-ferrites-fuses.md` | 122–139（18） | 14 |
| 元件 | `09-sensors-actuators.md` | 140–157（18） | 14 |
| 元件 | `10-interface-protection.md` | 158–175（18） | 14 |
| 元件 | `11-supply-chain.md` | 176–193（18） | 5 |
| 元件 | `12-library-management.md` | 194–211（18） | 7 |
| 案例 | `12-consumer-tws.md` | 11 | case 1 |
| 案例 | `13-industrial-controller.md` | 11 | case 1 |
| 案例 | `14-ac-dc-power.md` | 10 | case 1 |
| 案例 | `15-rf-module.md` | 10 | case 1 |
| 案例 | `16-flex-rigid-board.md` | 10 | case 1 |

> 另：K7 自身先补了 15 条治理相关条目（8 rule / 3 module / 4 failure），覆盖原理图命名、版本、符号、ERC、评审门禁与网表别名。

## 3. K7 治理交付

| 机制 | 文件 | 作用 |
|---|---|---|
| 冲突登记（人读） | [`conflict-register.md`](../../docs/knowledge/conflict-register.md) | 9 组冲突（EDGE/PANEL、DECOUPLE、CRYSTAL、ESD、THERMAL、TESTPOINT、RF、FIDUCIAL、VIA），写清口径、优先级 L1–L4、裁决与状态 |
| 冲突登记（机读） | [`conflicts.json`](../../knowledge/pcb/dataset/conflicts.json) | 同上，测试可校验引用的 ruleId 必须存在 |
| 领域分类 | [`taxonomy.json`](../../knowledge/pcb/dataset/taxonomy.json) | 122 个 category → 8 个 domain；不改历史 payload，避免产生新版本 |
| 文档↔条目对偶 | `runtime/__tests__/knowledge-dataset.test.mjs` | 每篇内容文档至少 1 条结构化条目；schema/枚举/料号核验/冲突 ID 全部自动校验 |
| 数据集合并 | [`merge-knowledge-dataset.mjs`](../../scripts/merge-knowledge-dataset.mjs) | fragment 全量校验→原子合并→归档；重复 entityKey 拒绝写入 |
| 运行态重建 | [`legacy/README.md`](../../docs/knowledge/legacy/README.md) | 备份、清空四类目录、seed、reindex 的完整命令与验收 |
| 需求归档 | [`requirements/requirements.md`](../../docs/knowledge/requirements/requirements.md) | 把误分类为 `module` 的 38 条产品需求迁出，避免污染工程知识检索 |
| 人工审核包 | [`knowledge-review-packet-k7.md`](./knowledge-review-packet-k7.md) | 20 条建议首批审核清单 + 审核 API/判定口径 |

### 3.1 并行写作与合并流程

- 7 个 teammate 分工写文档，各自只写 `write_scopes` 内的文件，并产出 `knowledge/pcb/dataset/fragments/*.json`；
- Lead 不直接改他们负责的文档，只做 schema/编号/冲突校验与合并；
- 7 个 fragment 共 157 条全部通过 `merge-knowledge-dataset.mjs --check`：`accepted=157, duplicates=[], problems=[]`；
- 合并后核心数据集 353 条，`seed-knowledge-pcb.mjs --check` 为 `problems: 0`。

## 4. 运行态修复（repo + live）

### 4.1 仓库存储 `artifacts/knowledge`

- 修复前 274 个 JSON 文件；已备份到 `artifacts/evidence/knowledge-repo-backup-k7-20261022-154758/`；
- 清空四类目录后重灌：**rule 123 / module 98 / part 57 / failure 75 = 353**，全部 candidate/reference。

### 4.2 运行态存储（应用实际读取）

- 位置：`~/Library/Application Support/com.circuitpilot.desktop/state/knowledge`；
- 修复前 284 条（rule 87 / module 86 / part 63 / failure 48），含 84 条不可复现条目、17 个重复料号 entityKey；
- 已备份两份：
  - `artifacts/evidence/knowledge-backup-k7-20261022-153136/`
  - `artifacts/evidence/knowledge-live-backup-k9-20261022-154808/`
- 清空四类目录 → API seed 353 条 → `POST /api/rag/reindex`；
- 验证：`/api/knowledge/health` = `{total:353, approved:0, candidates:353, coverage:1, conflictKeys:0}`；磁盘计数 123/98/57/75，重复 entityKey **0**；RAG 索引 `docs:477, chunks:3351, knowledge:353`。

> 说明：这是**破坏性重建**，但旧数据已完整备份；`review.state` 全部回到 candidate（原本 approved 也是 0），不丢已批准知识。

## 5. RAG 门禁

`scripts/verify-rag.mjs` 升级为四道门：

| 门 | 结果 |
|---|---|
| golden 查询 43 条（原 39 + K7 治理 4 条） | Hit@1 **43/43**、Hit@3 **43/43**、MRR **1.0** |
| 来源白名单（top1 必须是 `docs/knowledge/` 或 knowledge 条目） | **43/43**；并给知识文档 +0.05 权重，修掉“实施记录压过知识文档”的污染 |
| 负向查询 4 条（火箭燃料/股票/房贷/训猫） | 4/4 最高分 < **0.85** 阈值 |
| 证据落盘 | `artifacts/evidence/knowledge/` |

**口径警告**：负向阈值 0.85 是按当前 BM25+哈希向量分数校准的，不是语义拒答；中文 BM25 对无关查询仍会给 0.65–0.83 的分数。它只能防“高置信误答”，不能替代领域意图分类。真正上线前应加 query classifier 或“无答案”阈值策略，见 §8。

## 6. 自动测试

| 测试 | 结果 |
|---|---|
| `runtime/__tests__/knowledge-dataset.test.mjs`（新增 5 项） | **5/5 pass** |
| `runtime/__tests__/knowledge-pcb-seed.test.mjs`（3 项） | **3/3 pass** |
| `runtime/__tests__/rag.test.mjs`（6 项） | **6/6 pass** |
| `node scripts/seed-knowledge-pcb.mjs --check` | `entries:353, problems:0` |
| `node scripts/merge-knowledge-dataset.mjs --check` | `ok:true, duplicates:[], problems:[]` |

`knowledge-dataset` 测试覆盖：四类 schema 必填字段、文档对偶、122 category→8 domain、冲突组 ID 存在、part 核验标记一致性。

## 7. 未完成/不能由 AI 完成

1. **人工审核（硬门禁）**：`approved=0`。按项目规则，只有人类评审人能给 `approved`；AI 自审会使知识失去可信度。已提供 20 条[审核包](./knowledge-review-packet-k7.md)。
2. **标准正本核对**：仅 IPC-9592B 官方目录 PDF 做了 curl+pdftotext 结构化核对（§4/§5/§7 条款结构）；IEC 62368-1、IEC 60664-1、IEC 61000-4、JESD/AEC、GB 31241/4943.1、UN38.3、UL/FCC 等**未购正本/未逐条核对**，文档中所有具体数值均标“需按标准正本复核”。
3. **料号核验**：57 条 part 中仅 5 条 `lcscIdVerified=true`，52 条待 Librarian 三源核验；新补 30 条全部 `lcscId:null + 待核验`，未编造 LCSC。
4. **审核结果回写仓库**：当前审核只改运行态；重新 seed 会回到 candidate。需要后续做“审核结论→dataset 状态字段”的回写工具，否则 approved 不能长期保持。
5. **P2 剩余**：专门 SI/PI 仿真工作流（场求解器/眼图/去嵌脚本化）、机械/跌落/振动专项、认证实测报告库、供应链价格/交期实时化。本次已覆盖高速协议、封装返修、柔性、供应链、元件库与文件 ECO，但上述“工具链/实测”类仍需真实数据。

## 8. 下一步建议（按优先级）

1. **人工审核 20 条**（审核包），把规则类先过一遍；通过后观察 RAG/门禁引用是否变准。
2. **加 query classifier**：先判断“是否 PCB 领域”，再决定检索/拒答；替代当前 0.85 分数阈值。
3. **审核结果回写**：增加 `reviewedBy/reviewedAt/evidence` 到 dataset 的派生文件（不改 payload），重建时可恢复 approved。
4. **料号三源核验**：优先 30 条新 part + 项目 BOM 实际用料，核验后再升 `lcscIdVerified`。
5. **标准正本**：至少购买/获取 IEC 62368-1、IPC-A-610、IPC-2223 正本，逐条替换“经验值”标注。

## 9. 复现命令

```bash
node scripts/merge-knowledge-dataset.mjs --check
node scripts/seed-knowledge-pcb.mjs --check
node scripts/seed-knowledge-pcb.mjs                     # 仓库 artifacts/knowledge
node scripts/seed-knowledge-pcb.mjs --api http://127.0.0.1:4178   # 运行态
node scripts/verify-rag.mjs
node --test --test-timeout=120000 runtime/__tests__/knowledge-dataset.test.mjs
node --test --test-timeout=120000 runtime/__tests__/knowledge-pcb-seed.test.mjs
node --test --test-timeout=120000 runtime/__tests__/rag.test.mjs
```

## 10. 证据与备份索引

- 运行态备份：`artifacts/evidence/knowledge-backup-k7-20261022-153136/`、`artifacts/evidence/knowledge-live-backup-k9-20261022-154808/`
- 仓库备份：`artifacts/evidence/knowledge-repo-backup-k7-20261022-154758/`
- RAG 证据：`artifacts/evidence/knowledge/knowledge-*.json`（`report: rag-eval`，含 metrics/records/negativeRecords）
- 合并归档：`knowledge/pcb/dataset/fragments/_merged/2026-10-22T07-46-27-759Z/`
- K6 审计：[`knowledge-audit-k6-2026-10-22.md`](./knowledge-audit-k6-2026-10-22.md)
- K7 审核包：[`knowledge-review-packet-k7.md`](./knowledge-review-packet-k7.md)
