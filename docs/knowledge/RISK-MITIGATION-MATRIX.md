# 风险规避矩阵：知识库 × PCB 设计自主性

> 目的：把「加强 PCB 设计自主性」方案里的 14 个风险，逐条落到 **知识类型 → 检索/写入钩子 → 验收指标**，并明确知识库能规避什么、不能替代什么。
>
> **铁律（先记住）**：知识只能让门禁**更严或转 REVIEW**，不能自动 PASS、不能替代证据、不能替代 DRC/ERC/仿真。知识库是"风险的概率削减器"，不是"风险消除器"。

---

## 1. 使用方式

- 每条风险标注知识库角色：**✅ 显著规避 / ⚠️ 部分缓解 / ❌ 不能替代**。
- 「知识类型」用 `kind` + `payload.topic` 表示（类型谱见 [KNOWLEDGE-KINDS-V2.md](./KNOWLEDGE-KINDS-V2.md)）。
- 「钩子」指在哪个模块检索/写入知识（现状已有的标 ✅，P0/P1 待建的标 🚧）。
- 「指标」必须可采集；没有指标的知识投入不算"规避"，只算"记录"。

---

## 2. 风险 → 知识 → 钩子 → 指标（14 条）

| # | 风险 | 知识库角色 | 知识类型（kind·topic） | 钩子（代码位置） | 验收指标 |
|---|---|---|---|---|---|
| 1 | 假精确 / 假 PASS（规则没覆盖却看起来自动化） | ⚠️ 部分 | `failure`·badcase（逃逸案例）、`rule`（可判定标记/测试） | 门禁失败建议 ✅ `runtime/knowledge-gate-advice.mjs`；规则判定 `runtime/engineering/layout-rules.mjs` | 规则覆盖率（可判定/151）、离线 vs 官方 DRC 一致率、门禁逃逸率 |
| 2 | 规则工程成本（151 条维护负担、标准漂移） | ✅ 显著 | `rule`（来源/版本/谓词/测试/误判案例） | 规则包生成/审核 🚧（复用 `knowledge/pcb/dataset/rules.json` + `sourceHashes`） | 规则"有测试/有复核日期"占比、复核过期数 |
| 3 | 离线 IR 与 EDA 双真相源漂移 | ⚠️ 部分 | `decision`·eda-compat（已知转换差异）、`rule`（round-trip 契约） | EDA 适配器 🚧 `runtime/eda-adaptation.mjs` + 新增 IR 层 | round-trip hash 一致率、已知差异条目数 |
| 4 | 求解器建模错误（模型对、物理错） | ⚠️ 部分 | `decision`（建模假设）、`failure`（模型坑） | 求解前检索 🚧（P3 `runtime/engineering/`） | 求解结果人工否决率、极端参数回归通过率 |
| 5 | 数据质量天花板（器件/封装/工艺） | ✅ 显著 | `part`/`module`（来源 hash、核验状态） | Librarian ✅ `runtime/agents/librarian.mjs`、RAG ✅ | 三源核验通过率、过期/冲突条目数、料号返工率 |
| 6 | 自主性扩张的安全/责任风险 | ❌ 不能替代 | 仅 `decision`·policy 辅助风险分级 | 门禁/审批/回滚 ✅（`approval-ledger`、`write-gate`、`drc`） | 回滚率、抽检拦截率、写操作审计完整率 |
| 7 | 零依赖原则 vs 求解器工具链 | ❌ 不能替代 | `decision`·design（架构决策记录） | 架构评审 | sidecar 进程数/超时/失败率 |
| 8 | LLM 不确定性（漂移/成本/延迟） | ✅ 部分偏强 | `rule`/`failure`/`assumption`（接地、先例、few-shot） | 计划生成前检索 🚧（P1 `plan-repair`）、知识引用核验 ✅ `knowledge-citations.mjs` | 引用核验失败率、计划返工率、单板 token 成本 |
| 9 | 评估台缺数据（金板/标注） | ✅ 显著 | `eval-case`·golden-board/regression | 复盘回灌 ✅ `runtime/agents/field-loop.mjs`、`retrospective-learner.mjs` | 金板数、回归用例数、回归通过率 |
| 10 | 复杂度/维护成本 | ⚠️ 部分 | `decision`·design（决策/取舍）、`repair`（操作手册） | 复盘沉淀 ✅ | 新人上手时间、架构决策可追溯率 |
| 11 | 流程/责任边界 | ⚠️ 部分 | `decision`·policy + `rule`（L0–L3 政策） | 审批链引用 ✅ | 审批绕过次数、责任归属清晰度评审 |
| 12 | 标准/合规（IPC/JLC 来源时效） | ✅ 部分 | `rule`（标准条目 + sources + reviewBy） | 来源校验 ✅ `scripts/check-knowledge-sources.mjs` | 来源复核过期数、A/B 级证据混用数 |
| 13 | EDA/生态版本漂移 | ✅ 显著 | `decision`·eda-compat、`failure`（已知版本坑） | 适配器启动检查 🚧；插件兼容 ✅（`compat.json`/`sync-compat`） | 版本兼容矩阵覆盖、启动前拦截数 |
| 14 | 假设认知负担（一次给用户 30 条假设） | ✅ 显著 | `assumption`·precedent/default（置信度 + 适用域） | 需求澄清排序 🚧（P0） | 每计划假设条数（≤3–5）、假设接受率、被推翻率 |

**合计：✅ 6 · ⚠️ 6 · ❌ 2。** 与架构建议的判断一致：知识库能把"人会重复犯的错"显著压下去，但不能替代"机器必须证明的事"。

---

## 3. 七个知识钩子（检索/写入点）

| # | 钩子 | 阶段 | 检索什么 | 写入什么 | 现状 |
|---|---|---|---|---|---|
| 1 | 需求澄清与约束编译 | P0 | `assumption`·precedent、`rule`·需求类别默认值、`failure`·需求遗漏坏例 | 用户回答 → `assumption`/`rule` 候选；未分类需求 → 澄清问题 | 🚧 待建 `runtime/requirements/*`；现有 `runtime/constraints.mjs` 仅 6 类模式 |
| 2 | 计划生成 / 自动修复 | P1 | `repair`（missing 码→修法）、`assumption`（板型默认值）、`failure`（同类板踩坑） | 修复成功/失败 → `repair` usage；新修法 → `repair` 候选 | 🚧 待建 `runtime/agents/plan-repair.mjs`；现有 `erc.mjs repairFor` 全部人工确认 |
| 3 | 规则判定与 REVIEW 解释 | P0/P2 | `rule`（阈值/依据）、`failure`（误判/边界案例） | FAIL/REVIEW 的判定理由与反例 → `rule` usage、`failure` 候选 | 部分 ✅ `runtime/engineering/layout-rules.mjs`（151 条规则包）；缺"规则→知识条目"映射 |
| 4 | 门禁失败建议 | 已有 | 按 `GATE_*` 原因码检索 approved 知识 | 采用/否决 → usage | ✅ `runtime/knowledge-gate-advice.mjs`（原因码→语义标签→知识，含 degraded 处理） |
| 5 | 布局/层叠/布线求解 | P3 | `assumption`（同类板参数）、`failure`（布局坑）、`rule`（约束） | 求解候选与人工选择 → `decision` | 🚧 待建求解器；现有贪心 `solveLayout` |
| 6 | 写前审批与决策记录 | 已有/P1 | `decision`·policy（什么能自动） | `decision`（选型/取舍/兼容决策）、审批账本 | 部分 ✅ `approval-ledger`/审批链；`decision` kind 为本次新增 |
| 7 | 复盘回灌 | 已有 | ——（写入为主） | `failure`/`rule`/`assumption`/`eval-case` 候选 | ✅ `retrospective-learner.mjs` + `field-loop.mjs` + `knowledge-manager.mjs` |

> P0 只要求接钩子 1、2、4；钩子 3/5/6 随 P2/P3 接入，钩子 7 已有、只需补新类型的产出。

---

## 4. 知识库自身风险的治理

| 知识库风险 | 表现 | 控制手段 | 现有机制 | 监控指标 |
|---|---|---|---|---|
| 知识中毒 | 错误经验 approved 后反复误导 | 证据绑定 + 人工审核 + 可撤销 + 效果回灌 | `review` 状态机、`provenance.source` 必填、API 写入永远 candidate、`authoritative` 需审核 | usage `overturned` 比例 |
| 过拟合历史板 | 新板型照搬旧参数 | `payload.scope` 适用域 + 新板型强制 REVIEW + holdout | `assumption`/`repair` 约定 scope 字段（见类型谱） | 新板型假设被推翻率 |
| 知识过期 | 器件 EOL / 工艺变更后仍被引用 | TTL + 来源同步 + 过期即不可门禁 | `ttlDays`/`isUsableForGate`、`knowledge-scheduler` 维护 | 过期率 `expiredRate` |
| 检索噪声 | RAG 召回不相关条目 | 结构化过滤（kind/topic/scope/EDA 版本）+ rerank | `store.query` kind/entityKey 过滤、RAG 混合检索 | 检索精度（人工抽检 precision@k） |
| 审核积压 | 候选堆积没人审 | 低风险自动批准（仅 reference、证据绑定）+ 分级审核 | `buildReviewQueue`/`healthMetrics` | 待审数、平均审核时长 |
| 双真相源冲突 | 知识与实测证据矛盾 | **证据 > 知识**；冲突进登记，不静默采用 | `conflict-register.md`、`detectConflicts` | 冲突 entityKey 数、冲突解决时长 |

---

## 5. 门禁交互铁律（实现时必须遵守）

1. **只加严，不放松**：知识可以补充阻断理由、把 PASS 降为 REVIEW、给出修复候选、排序候选方案；**不能**满足证据要求、不能降低严重度、不能替代官方 DRC/ERC。
2. **引用核验**：只有 `approved` + 未过期 + `trust ∈ {authoritative, reference}` 的知识可用于门禁引用（`store.isUsableForGate`）；`candidate` 只能作为建议/候选。
3. **证据优先**：知识冲突时以实测证据为准；知识冲突进入 `conflict-register`/`detectConflicts`，不静默采用。
4. **使用留痕**：每次被采用/被否决都写 `usage`（`used`/`overturned`），否则无法评估知识质量。
5. **新类型默认候选**：`repair`/`assumption`/`decision`/`eval-case` 与核心类型一样，AI/采集器写入一律 `candidate`；`authoritative` 必须人工审核。

---

## 6. 验收指标（先测 2 周基线，再谈"规避了多少"）

| 指标 | 定义 | 采集点 | 目标（待基线后定档） |
|---|---|---|---|
| 知识命中率 | 计划/门禁里被检索且引用的知识占比 | usage 记录 | 逐季上升 |
| 知识采纳率 | 被建议后真正被采用的比例 | usage `used` / (used+overturned) | ≥ 60% |
| 假设被推翻率 | `assumption` 在后续验证/现场被否定的比例 | usage + 门禁回访 | ≤ 10% |
| 需求机器可校验比例 | 可编译为约束的需求 / 已确认需求 | `runtime/constraints.mjs` + P0 编译器 | 30% → 70% |
| 人工纠正次数/板 | 同一计划从生成到批准的人工修改次数 | 审计/审批 diff | 逐季下降 |
| 一次 plan ready 率 | 首次生成即 `ready:true` 的计划占比 | plan 结果 | 40% → 80% |
| 规则覆盖率 | 可机器判定规则 / 151 条 | 规则包标记 | 逐季上升 |
| 离线 vs 官方 DRC 一致率 | 离线验证与 EDA 官方 DRC 结论一致比例 | 对拍证据 | ≥ 95%（未达标不进 L2） |
| 门禁逃逸率 | 现场/复审判定"本应拦截但放行"的比例 | `field-loop` 回归 + 现场问题单 | 逐季下降 |
| 知识过期率/冲突率/待审数 | 健康度指标 | `healthMetrics` / 知识库看板 | 过期率 < 10%，待审不积压 |

---

## 7. P0 落地清单（2 周）

**代码（本次已完成的部分）**
- [x] 知识类型谱 v2：核心 4 + 扩展 4（`runtime/knowledge.mjs`，`KNOWLEDGE_KIND_SPECS`/`KNOWLEDGE_CORE_KINDS`/`KNOWLEDGE_EXTENDED_KINDS`）
- [x] 测试：`runtime/__tests__/knowledge-kinds-v2.test.mjs`（类型谱/身份/版本/审核/TTL/RAG）
- [x] 健康度/覆盖率分母改为全量 8 类（`runtime/knowledge-pipeline.mjs`）
- [x] 知识库 UI 支持 8 类检索/新增（`src/pages/KnowledgePage.tsx`）
- [ ] 需求澄清/受控假设引擎（P0 主干，另立任务：`runtime/requirements/*` + `constraints` 规则包驱动）

**知识内容（按"先高频、先有证据"原则）**
- [ ] `rule`：Top 20–30 高频规则补 `machineCheckable` + 判定器/测试 + 复核日期
- [ ] `repair`：Top 10 个 `missing` 码的修复策略（前置条件/动作/风险/副作用/验证方式）
- [ ] `assumption`：3 个典型板型的先验默认值（带 scope/置信度/验证方式）
- [ ] `eval-case`：10 条金板/回归用例（来自历史人工纠正与 `field-loop`）
- [ ] `decision`·eda-compat：把 DSH/CircuitPilot 插件兼容与 EDA 已知问题入库

**度量**
- [ ] 跑 2 周基线：人工纠正次数/板、一次 plan ready 率、规则覆盖率、知识命中/采纳率
- [ ] 在知识库看板加"知识→门禁影响"一栏（建议数/采纳数/阻断数）

**DoD**
- 新增知识类型可被 store/API/UI/RAG 全链路使用（测试全绿、typecheck 通过）；
- 至少 1 个真实钩子（门禁失败建议）能检索到新类型知识并留下 usage；
- 指标基线入库，作为后续 P1/P2 的对照。

---

## 8. 参考

- 知识类型谱（8 类）：[KNOWLEDGE-KINDS-V2.md](./KNOWLEDGE-KINDS-V2.md)
- 知识库总览/治理：[README.md](./README.md)、[KNOWLEDGE-INDEX.md](./KNOWLEDGE-INDEX.md)、[conflict-register.md](./conflict-register.md)
- 代码：`runtime/knowledge.mjs`、`runtime/knowledge-pipeline.mjs`、`runtime/knowledge-gate-advice.mjs`、`runtime/agents/{retrospective-learner,knowledge-manager,field-loop,knowledge-citations}.mjs`
- 测试：`runtime/__tests__/knowledge*.test.mjs`、`runtime/__tests__/knowledge-kinds-v2.test.mjs`
- 设计背景：`docs/agent/plugin-compat.md`（兼容性知识化的现成案例）
