# 已验证设计规则 → 硬约束（Verified Design Rules）

> 目标：把"真实 EDA 验证过、测试锁住的经验"变成**可执行参数/门禁**，而不是停在候选知识或文档里。

## 1. 规则包

位置：`runtime/design-rules/schematic-design-rules.json`（随 Runtime 打包，App 自带）。

每条规则至少包含：

```json
{
  "id": "SCH-RULE-FRAME-A4",
  "severity": "error",
  "enforcement": "hard",
  "appliesTo": ["layout", "plan", "execution", "audit"],
  "parameters": { "frame": { "width": 1170, "height": 825, "margin": 30, "titleBlock": {...} } },
  "verification": {
    "status": "verified",
    "verifiedAt": "2026-11-11",
    "method": "真机 schematic.catalog + 回归测试",
    "evidence": ["artifacts/...json", "runtime/__tests__/....test.mjs"]
  }
}
```

当前已验证规则（6 条，全部 `hard`）：

| 规则 | 约束 |
|---|---|
| `SCH-RULE-FRAME-A4` | 图框 A4 1170×825、边距 30、右下标题栏 240×130；计划阶段 margin 10 |
| `SCH-RULE-GRID-10` | 落位/符号尺寸对齐 10 格点 |
| `SCH-RULE-SYMBOL-SIZE` | 符号保守尺寸（连接器/IC/无源/其它）+ 引脚间距/引脚区 |
| `SCH-RULE-COMPONENT-SPACING` | 分带布局、gaps/bandGap、禁止堆叠/越框 |
| `SCH-RULE-LABEL-READABILITY` | 标签朝向/字宽/字高/padding/双向不重叠 |
| `SCH-RULE-WIRE-INSIDE-FRAME` | 走线端点必须在图框内；写入后回读阻断新增违规 |

## 2. 规则如何真正生效（不是文档）

```
rules/schematic-design-rules.json
        │ load + validate（损坏 fail-closed）
        ▼
runtime/design-rules/verified-rules.mjs
        │ SCHEMATIC_RULE_PARAMS
        ├── runtime/schematic-layout.mjs：图框/格点/符号尺寸/间距/标签参数
        ├── runtime/design.mjs：计划门禁（图框/重叠/标签/走线）
        ├── runtime/design.mjs execute：写入前后回读 diff，新增硬违规 → 回滚
        └── GET /api/design/framework/status：designRules 状态可审计
```

关键点：

- **布局常量不再手写**：`SCHEMATIC_SHEET_FRAME / GRID / SYMBOL_BASE / DEFAULT_LABEL_OPTIONS / gap` 均由规则包解析；
- **门禁参数同源**：`SCHEMATIC_PLAN_MARGIN`、走线检查开关来自规则包；
- **执行期硬约束**：写前计划拒绝 + 写后回读 diff（只阻断新增） + `document.source.restore` 回滚；
- **禁止绕过**：直接结构写命令 409；批量落件越框 400。

## 3. 候选知识如何晋升（人工闸门）

规则包**不会**自动吸收候选知识。晋升流水线：

1. 知识条目需满足：`kind=rule`、`review.state=approved`、`trust≠unverified`、
   `payload.verification.status=verified` 且有 evidence、`payload.designRule` 参数在白名单内；
2. 运行（默认只检查，不写）：

```bash
node scripts/promote-schematic-rules.mjs --check \
  --state-dir "$HOME/Library/Application Support/com.circuitpilot.desktop/state"
```

3. 人工确认后写包：

```bash
node scripts/promote-schematic-rules.mjs --write --confirm \
  --state-dir "..." --pack runtime/design-rules/schematic-design-rules.json
```

4. 写包后必须跑：

```bash
npm run test:runtime
node --test runtime/__tests__/verified-rules.test.mjs
```

候选知识/未验证/缺证据/未知参数一律拒绝，不会改变硬约束。

## 4. 与知识库的关系

- 知识库（`approved` 且 trust 非 unverified）仍是"经验来源 + 引用"；
- 但**硬约束不依赖审批状态**：已验证规则包独立、可测试、可审计；
- 知识条目晋升会写 `provenance.knowledgeId`，保留来源链。

## 5. 边界

- 只覆盖经过 Runtime/插件/AI 的写入；EasyEDA 内人工拖拽不受代码约束。
- 规则包参数是工程默认（A4/格点等），换模板需更新规则包并重新验证。
- 标签重叠是估计矩形；仍可能有假阳性，但硬门禁优先"拒绝/回滚"而不是放行坏图。
