# 原理图可读性与 AI 辅助布局改造（10-28 评审会落地）

> 需求来源：[10-28 PCB 布局与 AI 辅助设计讨论 · 会议转写与判读](../../hardware/参考文献-10-28-PCB布局与AI辅助设计讨论.md)（R1–R9）。
> 知识沉淀：[22. AI 辅助布局的功能分区与"可读原理图"验收](../../knowledge/pcb/22-ai-assisted-layout-and-readable-schematic.md)（候选知识，证据等级 D）。
> 本文只记录**本次真正改了什么、怎么验证、还差什么**，不把"AI 已审核"或"真机已验证"写成既成事实。

## 0. 一句话结论

把评审会指出的两个原理图可见缺陷（网络标签全朝右压元件、元件落位不看规模/连接关系）改成**确定性可审计**的算法；把 PCB 侧"按功能块分区、约定区域、保持相对位置、先出分区图"落成**设计意图 `blocks` + 布局约束 + 响应 `blockMap` + UI 分区图**。写入链路的安全语义（批准、回读、ERC/DRC、回滚）一律未放宽；真机逐角度渲染与真实板分区效果仍需人工复核。

## 1. 需求 → 改动 → 测试 追溯

| 需求（会议） | 改动 | 代码 | 测试 |
|---|---|---|---|
| R1 标签朝向可任意、不得压元件/叠字 | 网络端口按"引脚相对元件主体的朝外方向"选 rotation，再做 4 方向 AABB 碰撞打分；既有 netport 也当障碍 | `runtime/schematic-layout.mjs`（`planNetPortLabels`）、`runtime/net-connect.mjs`、`runtime/schematic-repair.mjs` | `runtime/__tests__/schematic-layout.test.mjs`、`net-connect.test.mjs`、`schematic-repair.test.mjs` |
| R2 元件不得重叠/过密 | 固定 4 列网格 → 按连通簇分带、按引脚数估计符号尺寸、格点对齐、包围盒不重叠 | `runtime/schematic-layout.mjs`（`layoutSchematicComponents`）、`runtime/netlist.mjs` | `netlist.test.mjs`、`schematic-layout.test.mjs` |
| R1/R2 写前能发现问题 | 可读性审计：标签压元件、标签互叠、元件互叠；全部 warning，不替代电气验收 | `runtime/schematic-layout.mjs`（`auditSchematicReadability`）；`netlist.mjs` 返回 `layoutAudit`；net-connect 的 `plan.findings` 透出 | `schematic-layout.test.mjs` |
| R3 功能块分区 | 设计意图新增可选 `blocks`（id/name/refs/region/priority），成员跨块/非法区域 fail-closed；未知位号只报告 | `runtime/engineering/functional-blocks.mjs`、`runtime/engineering/layout-intent.mjs` | `functional-blocks.test.mjs`、`layout-intent.test.mjs` |
| R4 小件靠芯片、简单网就近 | 复用既有 `netAffinity`（按 `1/(网络端点数-1)` 加权）；块内成员区域约束 + 就近 | `runtime/placement.mjs`（`region` 候选点约束）、`runtime/server.mjs` placement/plan 路由 | `placement.test.mjs`、`functional-blocks.test.mjs` |
| R5 约定区域 + 保持相对位置 | `componentRegions` 限制候选中心；`anchors`（nearX/nearY/weightNear=8）表达"尽量保持原位"，用户 body.anchors 优先；不锁定绝对位置 | `runtime/engineering/functional-blocks.mjs`、`runtime/placement.mjs`、`runtime/server.mjs` | `functional-blocks.test.mjs`（含 HTTP 假桥端到端）、`placement.test.mjs` |
| R6 先出"原理图 → 区域图" | placement/plan 响应新增 `blockMap`（块/区域/成员/面积/利用率/推导标记）与 `blocks.findings`；PlacementPage 新增"分区布局图"面板（无 blocks 时明确显示"未声明分区"） | `runtime/server.mjs`、`src/types.ts`、`src/pages/PlacementPage.tsx` | 服务端：`functional-blocks.test.mjs`；UI：`tsc -b` + 人工代码审阅（无组件级 UI 测试） |
| R7 层数策略/加电源重验 | 写入知识文档 §2；不改叠层/布局放行逻辑（避免把经验当硬门禁） | `docs/knowledge/pcb/22-...md`、本文件 §5 | 文档审阅 |
| R8 人工复核 ≥30 分钟 | 知识文档 §5 给出可勾选清单；不伪造自动签核 | 同上 | 文档审阅 |
| R9 高频单独处理 | 高速分组/阻抗继续走既有 `highSpeed` 设计意图；知识文档明确高频块留区 | `layout-intent` 既有能力 + 文档 | 既有 `layout-intent.test.mjs` |

## 2. 原理图侧实现要点

### 2.1 标签朝向（`planNetPortLabels`）

- 方向语义集中在 `LABEL_ROTATION`：`0=右 / 90=上 / 180=左 / 270=下`。**这是对立创EDA `createNetPort` 的纸面假设**，真机若相反只改这一处映射，碰撞算法按方向语义工作。
- 朝外方向优先：元件读回的 `x/y` → 否则该元件引脚质心；都拿不到就保留原 rotation 并报低置信度 warning，**不猜坐标**。
- 碰撞打分：标签矩形（字符宽 8、字高 14、padding 4、最短 20 单位）与"本元件主体框 / 本元件引脚框外扩 10 / 其它元件主体框 / 既有 netport 标签 / 本次已放标签"的加权重叠面积；选最小，平局按朝外→rotation 升序，保证确定性。
- 放置后二次自查标签互叠，残留以 `LABEL_LABEL_OVERLAP` / `LABEL_OVERLAP_REMAINING` warning 如实报出，不假装解决。

### 2.2 元件布局（`layoutSchematicComponents`）

- 由 nets 端点统计每个位号引脚数；按共享网络并查集分组（连通簇）；簇内按 `(pinCount 降序, 位号自然序)` 排布；带宽超限换行，带间距 60。
- 符号尺寸按类别（连接器/IC/无源）+ 引脚数保守估计（真机 0603≈80×40、32 脚 IC≈160×200），向上取整到 10 格点；任意两元件包围盒不重叠。
- `compileReviewedNetlist` 保持"先全部 `component.create`，再 `net.connect`"和端点→操作下标映射不变；`planHash` 因坐标变化而变（同输入仍确定），`netlistHash` 不变。
- 原理图侧审计是**布局后、写入前**的 warning；写后仍以官方网表读回 + 原理图 ERC 为准。

### 2.3 安全边界

- net-connect 仅给 `operation.args` 增加 `rotation`，执行/回读/回滚**一字未改**；`schematic-repair` 计划阶段仍 `rotation:0`，执行阶段才用读回引脚算 rotation。
- 不重试写入、不猜器件身份、失败必回滚的既有断言全部保留。
- 单次连接计划新增 2000 引脚上限：标签规划是 O(端口²) 的 4 方向碰撞打分，超限直接 blocking 并提示拆批，不把运行时拖到超时。
- net-connect dry-run 的 `plan.readability` 透出可读性摘要（朝外/换向/低置信度/残留估算重叠），审批前先看它，不只看 `ok`。

## 3. PCB 侧实现要点

### 3.1 `blocks` 设计意图 schema（mm）

```json
{
  "blocks": [
    { "id": "dcdc", "name": "DC-DC", "refs": ["U1", "C1", "C2"], "region": { "xMinMm": 8, "yMinMm": 8, "xMaxMm": 38, "yMaxMm": 30 }, "priority": 1 },
    { "id": "battery", "name": "电池管理", "refs": ["U2", "Q1", "R1"] }
  ]
}
```

- `region` 可省略：用成员当前包围盒 + 3mm margin 推导，并裁到板框；成员无当前坐标 → 不猜区域，报 finding。
- 校验：id 唯一、name 非空、refs 非空且块内不重复、同一 ref 不能进两个块、region 有限且 `xMax>xMin/yMax>yMin`；完全板外丢弃，越界裁剪并报告。
- 区域是**调整范围**，不是物理墙：候选器件中心必须在区域内，板框/边距/间距/禁布仍独立判定；放不下返回 `NO_SPACE_IN_REGION` + blocking finding，不静默忽略。

### 3.2 保持相对位置

- 每个块成员得到 `anchors[ref] = { nearX, nearY, weightNear: 8 }`，`planOutlinePlacement` 用锚定距离参与候选打分；用户显式 `body.anchors` 覆盖默认值。
- 这是"高权重靠近原位置"，**不是锁定绝对坐标**；布局引擎仍可为了满足板框/间距/区域而移动。

### 3.3 先出分区图

- `POST /api/eda/pcb/placement/plan` 响应新增顶层 `blockMap`（无 blocks 时为 `[]`）与 `blocks: { ok, blockMap, findings }`。
- 每项含：`id/name/refs/priority/region/regionDerived/areaMm2/componentAreaMm2/utilization/memberCount...`，可直接用于人工评审。
- 顺带修正该路由 `outline.bounds` 由 `polygonBounds()` 真实计算（之前 `parsePolygonSource` 不返回 bounds，导致 region 越界裁剪静默失效）。
- PlacementPage 展示"分区布局图"：功能块 / 成员 / 区域 / 面积 / 利用率 / 声明或推导；无 blocks 时明确显示"未声明分区 ≠ 分区通过"；分区 findings（含 blocking）在面板内列出。
- 面板顶部新增汇总：功能块数（声明/推导）、覆盖器件数、平均利用率、缺坐标成员数；`unpositionedMemberCount > 0` 时明确提示"保持相对位置对它们不成立"。

### 3.4 规模与性能优化（本轮追加）

> 背景：区域约束上线后暴露了一个既有的规模缺陷——300×200mm 的普通板在 0.5mm 网格上有 24 万个候选点，
> 旧逻辑对**每个器件**都先铺满整板、再 `if (candidates.length > 20000) unplaced`，结果是整板一个器件都放不下，
> 而不是"放得慢"。本轮按"先剪枝、再抽样、最后只算一次分"修掉。

| 优化 | 改法 | 实测（合成基准 `scripts/bench-placement-region.mjs`） |
|---|---|---|
| 候选点按 region 剪枝 | 有 region 的器件只在 `region ∩ 可用板框` 内生成候选点；不再先铺整板再过滤 | 300×200mm 板 / 120 个带 35×90mm 区域的器件：**0/120 放置（3.5s 后整板失败）→ 120/120 放置（约 0.28–0.30s）** |
| 大板候选超限抽样 | 候选数 > `maxCandidates` 时按 `√(count/limit)` 抽稀（整板共享一份），并报 `PLACEMENT_CANDIDATE_GRID_COARSENED` warning；不再直接判 `CANDIDATE_GRID_TOO_LARGE` | 300×200mm / 0.5mm 网格 241001 个点 → 按 2mm 网格抽样，2/2 器件放置且独立复核通过 |
| 候选评分只算一次 | 排序前对每个候选算一次 `score`（Schwartzian transform），替代让比较器反复算分 | 2 万点级候选集少算一个数量级的评分 |
| 整板候选共享 | 无 region 器件共享同一份基准候选数组，逐器件 `slice()` 后独立排序 | 省掉 N 次 24 万点的重复生成 |
| 标签可读性摘要 | `planNetPortLabels` 返回 `summary`（朝外/换向/低置信度/残留重叠/告警码）；net-connect dry-run 的 `plan.readability` 透出 | 审批前先看摘要，不再只看到 `ok:true` |
| 标签障碍去重 | 读回里的 `netport/netflag` 只按既有标签矩形占位，不再同时被估成"元件主体框" | 避免新标签被旧端口双重占位无谓挤走 |

> 这些优化不改变执行/回读/回滚语义，也不改变"小网格默认路径逐值不变"（`placement.test.mjs` 用 `deepEqual` 锁住
> `regions:{}` 与旧行为完全一致）。抽样是**精度换可用性**，因此必须报 warning，不能静默降级。

- 独立复核补上 region 判定：`verifyOutlinePlacement` 会对带 `regionMm` 的落位再查一次"中心是否在约定区域内"，
  不再只信规划器自己的分支；越界时报 blocking `REGION_UNSATISFIED`。这样 R5 的"区域内"结论也是被独立验过的。

## 4. 验证记录

| 检查 | 命令 | 结果 |
|---|---|---|
| 原理图四文件 | `node --test --test-timeout=120000 runtime/__tests__/schematic-layout.test.mjs runtime/__tests__/net-connect.test.mjs runtime/__tests__/schematic-repair.test.mjs runtime/__tests__/netlist.test.mjs` | 43/43 pass（改动前基线 27/27） |
| PCB 四文件 | `node --test ... functional-blocks.test.mjs layout-intent.test.mjs placement.test.mjs placement-rules.test.mjs` | 39/39 pass（改动前基线 27/27） |
| 知识数据集 | `node scripts/merge-knowledge-dataset.mjs --check` + `node scripts/seed-knowledge-pcb.mjs --check` | 422 条 / 0 problems |
| 知识门禁 | `node --test runtime/__tests__/knowledge-dataset.test.mjs` | 5/5 pass |
| 类型检查 | `npm run typecheck` | exit 0 |
| 全量 runtime | `npm run test:runtime` | 1171 例 / 1164 pass / 7 fail；失败集合与改动前基线**完全相同**（`~/.circuitpilot/automation-runs` 写入 EPERM → `AUTOMATION_JOURNAL_FAILED` 等沙箱/环境问题），本次改动链路 0 新增失败 |
| 前端单测 | `npx vitest run` | 25 个测试文件 / 177 例全 pass |
| 构建 | `npm run build` | exit 0（`tsc -b` + vite build；仅有既有的 chunk >500kB 提示，不是错误） |

> 基线说明：改动前 `npm run test:runtime` 已是 1136/1143（7 项环境失败），因此不能用"全量全绿"作为本次验收口径；本次以**受影响测试全绿 + 全量失败集合不新增**为准。

## 5. 未验证 / 已知局限（必须让用户知道）

1. **rotation 真机语义**：0=右/90=上/180=左/270=下 是纸面假设，未在真机 EDA 逐角度验证；若渲染相反，改 `runtime/schematic-layout.mjs` 的 `LABEL_ROTATION` 一处即可。真机复核时建议：先 `dryRun` 看计划里的 rotation，再小批量写 2–4 个端口截图确认，不要一次写满整板。
2. **标签矩形是 AABB 估计**（字宽 8/字高 14/padding 4），不是真实字体度量；CJK/竖排未特判。估计重叠只作 warning，写前仍应人工看截图。
3. **元件尺寸估计**按类别/引脚数保守推算，不是真实符号包围盒；已有 `component.width/height` 时优先用真实值。
4. **region 只约束器件中心**：本体/焊盘可能少量越出区域边界，板框/间距/禁布仍由独立规则兜底；区域过小会明确失败（`NO_SPACE_IN_REGION`），需人工扩区。
5. **"保持相对位置"不是位置锁**：只是高权重锚定；若用户要求绝对不动，需要另行实现"固定器件"语义，不能把当前实现说成已锁死。
6. **UI 无组件级测试**：PlacementPage 分区图仅通过 `tsc -b` 与代码审阅，未跑浏览器 e2e；需要的话后续补 Playwright 用例。
7. **知识条目仍是 candidate**：本轮 2 条结构化条目（AI 功能分区 module、网络标签可读性 rule）证据等级 D、`reviewState=candidate`，`approved=0`，人工审核前不得被门禁引用。
8. **会议 ASR 噪声**：`B 的重复×3`、`安装门店`、`股票`等无法还原为工程约束，未进入实现，见会议判读 §二。

## 6. 真机复核清单（下一步，不声称已完成）

- [ ] 打开目标原理图，跑一次 `POST /api/eda/schematic/net-connect` dryRun（或 UI 网表连线预演），确认每个端口 `rotation` 与引脚所在边一致。
- [ ] 小批量写 2–4 个端口（右侧/左侧/上侧/下侧各一），保存后截图确认标签朝外、不压元件；再跑官方 ERC + 网表读回。
- [ ] 在 PCB 侧给真实板填 `blocks`（先用 2–3 个块，如 DC-DC、电池管理、接口），看 placement plan 的 `blockMap` 与器件落位是否落在区域内。
- [ ] 人工复核 ≥30 分钟（按知识文档 §5 清单），记录复核人/时间/结论。
- [ ] 若 rotation 渲染与假设相反：只改 `LABEL_ROTATION` 并补一条真机截图证据，不要改碰撞算法。

## 7. 关联

- 会议转写：[参考文献-10-28-PCB布局与AI辅助设计讨论](../../hardware/参考文献-10-28-PCB布局与AI辅助设计讨论.md)
- 知识文档：[22-ai-assisted-layout-and-readable-schematic.md](../../knowledge/pcb/22-ai-assisted-layout-and-readable-schematic.md)
- 布局依据链：[08-component-placement.md](../../knowledge/pcb/08-component-placement.md)
- 既有布局证据体系：[placement-basis-k4-2026-10-22.md](placement-basis-k4-2026-10-22.md)
- 已知缺口审计：[flow-gap-audit-2026-10-26.md](flow-gap-audit-2026-10-26.md)
