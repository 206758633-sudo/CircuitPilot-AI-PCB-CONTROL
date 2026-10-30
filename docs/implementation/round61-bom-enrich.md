# 第 61 轮 · T5：BOM 供应商证据富化（fail-closed，不伪造 LCSC 数据）

- 交付物：`runtime/bom-enrich.mjs`（纯适配器，未接入 `server.mjs`）、`runtime/__tests__/bom-enrich.test.mjs`
- 验收命令：`node --test --test-timeout=120000 runtime/__tests__/bom-enrich.test.mjs`（当前 14/14 通过）
- 边界：本任务**不联网、不自动抓价、不接 UI/放行门**，也不改 `runtime/server.mjs` 与其它 runtime 文件。

## 1. 为什么需要这个模块

BOM 里的位号/型号/数量是设计事实，但**价格、库存、币种、供货编号不是**。之前缺这块数据时，最危险的做法是让模型
"估一个价格"或把缺失当 0：一份 0 元 BOM 看起来能过报价，实际是错料/错价的起点。

本模块的立场是 **unknown ≠ 0 元**：

- 只有与**可信证据源**命中、且证据新鲜的 BOM 行，才输出 `price/stock/currency`；
- 未命中、歧义、过期一律 fail-closed：主字段保持 `null`，给出稳定原因码与 `provenance`；
- 任何"补造"（凭 mpn 编 lcsc、把过期价格当现价、同 mpn 多编号时挑一个）都不允许。

## 2. 可信数据来源（唯一允许的入口）

证据必须来自以下两类之一，并在每条证据上带 `source` 说明具体来源：

1. **电商/制造平台的人工导出文件**
   - 立创商城（LCSC）购物车/商品页导出、嘉立创（JLCPCB）BOM 报价导出等；
   - 导出为 JSON 后作为本地证据文件，例如 `source: "lcsc-export"`、`source: "jlcpcb-bom-export"`。
2. **人工核对过的证据文件**
   - 采购/工程师逐条确认后整理的文件，`source` 例如 `"manual-evidence"`，可附 `note`（本模块不把 note 当数据用）。

本模块**不主动联网**：既不请求立创 API，也不打开浏览器抓页面。证据文件由调用方显式传入，刷新节奏由人控制。

### 证据文件格式

文件内容可以是 JSON 数组，也可以是 `{"entries": [...]}`：

```json
[
  {
    "source": "lcsc-export",
    "partNumber": "C25804",
    "mpn": "RC0603FR-0710KL",
    "price": 0.0125,
    "stock": 152000,
    "currency": "CNY",
    "fetchedAt": "2026-10-21T08:00:00.000Z"
  }
]
```

字段与校验规则：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `source` | 是 | 非空；缺 source 的证据无法追溯，整条拒绝采信 |
| `partNumber` / `lcsc` | 二者之一 | 立创编号；也可用 `lcsc` 别名 |
| `mpn` | 二者之一 | 厂家型号；与 `partNumber` 至少给一个 |
| `price` | 否 | 有限非负数；缺失/非法 → 视为 unknown（不是 0 元） |
| `stock` | 否 | 非负整数；`0` 是有效库存（缺货），不是 unknown |
| `currency` | 否 | 3 位字母码（如 `CNY`/`USD`）；有价格但缺币种不能计入费用合计 |
| `fetchedAt` | **强烈建议** | ISO 时间或毫秒戳；缺失/不可解析/在未来 → 按过期处理 |

无效条目（非对象、缺 source、既无 partNumber 又无 mpn）**不会拖垮整份证据**，但会逐条记入
`report.evidence.rejectedDetails`，并计入 `report.evidence.rejected`，不静默丢弃。

## 3. API 与输出

```js
import { loadBomEvidenceFile, enrichBomRows } from './runtime/bom-enrich.mjs';

const evidence = await loadBomEvidenceFile('/path/to/lcsc-export.json'); // 仅读本地文件
const report = enrichBomRows({
  rows: bomRows,                 // [{designator,value,mpn,lcsc,quantity}]
  evidence,                      // 数组，或 loadBomEvidenceFile() 的返回值
  now: Date.now(),               // 注入时间，保证确定性；测试固定它
  maxAgeMs: 24 * 60 * 60 * 1000, // 可覆盖默认 24h
});
```

输入 BOM 行只读不改：`designator/value/mpn/lcsc/quantity` 原样保留（`quantity` 支持数字字符串）。
输出行结构：

```js
{
  index, designator, value, mpn, lcsc, quantity,
  status,                 // matched | missing | ambiguous | stale
  reasonCode,             // BOM_EVIDENCE_MATCH / BOM_EVIDENCE_MISSING / BOM_AMBIGUOUS / BOM_STALE
  price, stock, currency, // 只有 matched 且证据新鲜时非 null
  provenance: {
    source, fetchedAt, stale, note,
    matchBy,              // 'lcsc' | 'mpn' | null
    partNumber, mpn,      // 命中的证据编号（不代表 BOM 行被改写）
    ageMs,                // 证据年龄；无法解析时间为 null
    observed,             // 命中的原始证据值（命中/过期时给出，仅供审计核对）
    candidates,           // 歧义时的候选证据列表（确定性排序）
  }
}
```

报告级汇总：

```js
{
  schemaVersion: 1, kind: 'bom-enrichment', generatedAt, maxAgeMs,
  evidence: { provided, accepted, rejected, rejectedDetails },
  counts:   { total, matched, missing, stale, ambiguous, withTrustedPrice, unknownPrice },
  totals:   { costComplete, knownCost, currency, unknownCostRows, notes },
  rows: [...],
}
```

## 4. 匹配规则与原因码

稳定原因码（对下游 UI/放行门，勿随意改名）：

| 原因码 | 行状态 | 含义 | 主字段 |
| --- | --- | --- | --- |
| `BOM_EVIDENCE_MATCH` | `matched` | 命中可信且新鲜的证据 | price/stock/currency 可用 |
| `BOM_EVIDENCE_MISSING` | `missing` | 没有任何证据命中 / 行缺编号 | 全部 `null` |
| `BOM_AMBIGUOUS` | `ambiguous` | 同 mpn 对应多个 lcsc、BOM lcsc 与证据冲突、同一快照自相矛盾、同编号证据 mpn 不一致 | 全部 `null` + candidates |
| `BOM_STALE` | `stale` | 证据过期，或缺 `fetchedAt`/时间在未来（新鲜度无法确认） | 全部 `null`，原值进 `provenance.observed` |

匹配优先级：

1. BOM 行有 `lcsc` 且证据里有该 `partNumber` → 用该组证据（再校验 mpn 一致性/新鲜度）；
2. 否则回落到 `mpn`：
   - 一条都没有 → `BOM_EVIDENCE_MISSING`；
   - BOM 明确给了 `lcsc`，但证据只按 `mpn` 命中**别的**编号 → `BOM_AMBIGUOUS`（编号冲突，不自动替换）；
   - 同一 `mpn` 对应多个不同 `lcsc` → `BOM_AMBIGUOUS`（不猜哪一个，需人工确认）；
   - 唯一 `lcsc`（或证据只给了 mpn）→ 进入新鲜度判定。
3. BOM 行既无 `mpn` 又无 `lcsc` → `BOM_EVIDENCE_MISSING`（无法建立映射）。

组内多条证据（同一编号的多次抓取快照）按**最新 `fetchedAt` 赢**；但同一 `fetchedAt` 却价格/库存/币种互相矛盾时，
按 `BOM_AMBIGUOUS` 处理，不按排序挑一个。

## 5. 新鲜度/过期语义

- 默认有效期 **24 小时**（`DEFAULT_BOM_EVIDENCE_MAX_AGE_MS`），由 `maxAgeMs` 覆盖；`maxAgeMs` 非法/负数回退默认值。
- `ageMs > maxAgeMs` → `BOM_STALE`。
- 缺 `fetchedAt`、时间不可解析、或在未来（时钟不可信）→ 一律 `BOM_STALE`。**"无法确认新鲜"不等于"新鲜"**。
- 过期行的 `price/stock/currency` 为 `null`，原始值只放在 `provenance.observed`，供人工核对；
  下游不得直接把 `observed` 用于报价。

## 6. unknown ≠ 0 元：成本汇总也 fail-closed

- 没有任何可信价格时 `totals.knownCost === null`（**不是 0**）；BOM 为空时同样为 `null`。
- `totals.costComplete` 只有在**每一行**都 matched、有价格、有币种、有可解析数量且币种一致时才为 `true`；
  任何一行 missing/stale/ambiguous 或信息不全都会让它为 `false`。
- 存在 unknown 成本行时，`knownCost` 只是"已知部分"的小计；`totals.notes` 会明确写出
  "不得当作总成本"。跨币种证据不做求和（`knownCost: null`，`currency: null`）。
- 金额最多保留 4 位小数（`knownCost`），避免浮点长尾让输出不可复现。

UI 侧建议（本轮不接）：missing 行价格列显示"—（无证据）"而不是 `¥0.00`；stale 行显示"证据过期"并可展开
`provenance.observed`；ambiguous 行展开候选证据让人工选择，选择结果写回证据文件，**不要自动改 BOM 行**。

## 7. 确定性

- 纯函数：不读文件（`enrichBomRows` 不读文件，文件加载是单独 async 函数）、不联网、不读环境变量；
- 时间由 `now` 注入，`generatedAt` 由它派生；同一输入 → 同一输出；
- 输出行顺序 = 输入 BOM 行顺序；候选证据/快照排序与证据数组顺序无关（按 fetchedAt 降序，再按
  source/编号/mpn/价格/库存的码位序比较，不用 locale 排序）；
- 测试覆盖：同输入重复调用 deepEqual、证据数组反转输出一致。

## 8. 未来接 UI / 放行门的方式（本轮明确不接）

1. **UI（BOM 表格）**：直接消费 `report.rows[*].status/reasonCode/provenance`；用 `matched` 才显示价格，
   missing/stale/ambiguous 显示 unknown + 原因；歧义展开 `candidates`。
2. **放行门（release gate）**：建议规则——报价/下单前要求
   - 所有行 `status === 'matched'` 且 `price/currency` 非空，`totals.costComplete === true`；
   - 否则阻断并带 `reasonCode` + `provenance`；人工确认要有可审计证据（走既有 approval/evidence 链），
     不能把"人工放行"降级成"当作 0 元"。
3. **接线位置**：后续轮次在 server 路由/产品层调用本适配器即可，本模块不感知 HTTP；
   证据文件位置与刷新频率由产品层决定（建议放在项目级目录，与 DRC/ERC 豁免的"按工程隔离"思路一致）。
4. **证据刷新**：人工重新导出立创/嘉立创文件覆盖证据文件；不做定时联网抓取，避免把第三方页面解析
   的不稳定性带进报价链路。

## 9. 测试覆盖（14 条）

`runtime/__tests__/bom-enrich.test.mjs`：

- 正常命中（lcsc 关联）、mpn-only 命中且不伪造 lcsc；
- 缺证据：unknown 不是 0 元、不补造字段、成本汇总不给 0；
- 歧义：同 mpn 多 lcsc、BOM lcsc 与证据编号冲突、同一快照价格矛盾；
- 过期：超期、缺 `fetchedAt`、未来时间；
- 确定性：重复调用一致、证据顺序无关、候选排序稳定；
- 无效证据条目逐条拒绝；JSON 文件加载（数组/`entries` 包装、坏文件/缺文件抛
  `BOM_EVIDENCE_FILE_INVALID`）；
- 边界：空 BOM、缺编号行、非对象行、非法参数抛 `BOM_ENRICH_INPUT_INVALID`、负有效期回退默认值；
- 库存 `0` 与 unknown 区分、有价格缺币种不能计入费用合计；
- 模块边界：只 import `node:fs/promises`，无 `fetch`/http/net 调用，不接 `server.mjs`。

## 10. 明确不做的事

- 不联网、不自动抓价、不调用立创/嘉立创接口；
- 不修改 `runtime/server.mjs` 或其它 runtime 模块，不新增 HTTP 路由；
- 不动 EDA 工程，不跑桌面打包/安装；
- 不把"未命中"当 0，不把"过期价格"当现价，不把"多候选"自动选一个。
