# 第 61 轮 · T2：把第 60 轮 ERC 新能力接到 UI（目标文档 / 明细来源 / 逐条明细 / 桥自愈状态）

- 范围：只改前端 + 客户端类型；**未改 `runtime/*.mjs`**、未跑 `desktop:build`、未安装 app、未操作真机 EDA。
- 触及文件：
  - `src/services/runtimeClient.ts`（ERC 返回类型对齐 `ercDetail`）
  - `src/types.ts`（`ErcReport.documentUuid/detailSource/detailCounts`、`ErcDetailMeta`、evidence payload `ercDetail`）
  - `src/pages/ValidationPage.tsx`（A13 ERC 面板 + 桥连接状态块）
  - `src/styles.css`（`.erc-findings-scroll`、`.erc-evidence`）
  - `src/pages/__tests__/validation-erc.test.tsx`（新增 3 条 UI 契约测试）
- 验收命令与结果：
  - `npx tsc -b --pretty false` → 通过（无输出）
  - `npx vitest run src/pages/__tests__/validation-erc.test.tsx` → **3/3 passed**
  - `npx vitest run src/pages/__tests__` → **16/16 passed（4 files）**，含 `pages-smoke.test.tsx` 对验证页的空态回归

## 1. 问题（第 60 轮真机暴露的三个 UI 缺口）

运行时的能力已经打通，但 UI 只显示"有几条错误"，用户仍然无法据此动手：

1. **不知道查的是哪一页原理图。** 多板工程里 ERC 默认取"第一块板"，得到 0 错误时无法判断是设计干净还是切到了空板。
2. **看不到明细来源。** EDA 扩展 API 只返回聚合计数，逐条明细要靠 GUI 面板抓（`ui-dom`）；UI 既没区分两者，也没有明细表。
3. **桥断线后没有状态与重试入口。** `/api/eda/windows`、`/api/eda/session` 已支持惰性重新发现，但界面看不到桥/窗口状态，断线时只能靠重启。

## 2. 类型与客户端（src/types.ts、src/services/runtimeClient.ts）

`ErcReport` 补齐第 60 轮字段（全部可选，旧证据可安全读取）：

```ts
documentUuid?: string | null;                       // 本次 ERC 实际检查的原理图文档
detailSource?: 'ui-dom' | 'aggregate' | string | null; // 逐条明细来源
detailCounts?: { fatal?/error?/warning?/info?/total?; partial?: Record<string, {detailed, expected}> } | null;
```

新增 `ErcDetailMeta`（`ok/source/reason/counts/targetBefore/targetAfter`），并让：

- `runtimeClient.ercRun()` 返回类型增加 `ercDetail: ErcDetailMeta | null`（服务端 `/api/eda/schematic/erc/run` 已返回）；
- `ErcEvidenceEntry.payload.ercDetail?: ErcDetailMeta | null`，让"载入最新 ERC"也能还原当时的失败原因；
- `ercLatest()` 沿用 `ErcEvidenceEntry`，类型自动对齐。

## 3. ERC 面板 UI（`ErcDetailEvidence` 组件）

组件为纯展示（导出于 `ValidationPage.tsx`，供单测直接渲染），页面把
`ercResult?.ercDetail ?? ercLatest?.payload?.ercDetail` 传进去。三段结构：

1. **检查目标文档**：`本次 ERC 检查的原理图文档（documentUuid）` + `<code>{documentUuid}</code>`。
   缺 UUID（旧版证据/运行时未返回）时如实显示 `未记录 documentUuid`，并提示"不能拿别的页面/板子的结论代替，请重新运行一次 ERC 取证"。
2. **明细来源徽标**：
   - `明细来源：ui-dom（EDA 检查面板逐条）`
   - `明细来源：aggregate（仅聚合计数）`
   - 无标注时按是否有逐条 findings 显示"未标注（但含逐条条目）/未标注（无逐条明细）"；
   - 部分明细（`detailCounts.partial`）显示 `部分明细：warning 5/34`，不把部分当全量。
3. **逐条明细表**（仅当存在非聚合 findings）：列 `级别 / 规则·Code / 对象 / 说明 / 修复建议 / 结论`，
   外包 `.erc-findings-scroll`（`max-height: 320px; overflow: auto`）可滚动；修复建议与"建修复任务"保留在该表内。
4. **明细不可用时**：`本次没有逐条明细，只有聚合计数。` + 运行时原因码（如 `ERC_DETAIL_TIMEOUT` 及其人话解释）
   + "到嘉立创 EDA 里手动点一次“设计检查 / ERC”后回来点“运行 ERC 取证”重试"。
   聚合 findings 单独渲染为 `ERC 聚合计数（仅计数，不是逐条明细）` 表（`×count`），**不混入逐条表**。

> 红线：`aggregate` 状态下不渲染任何"逐条明细"表格，聚合计数不得渲染成逐条行。

## 4. 桥连接状态块（EDA BRIDGE 面板）

数据来自已有的 `runtimeClient.discoverBridge()` + `runtimeClient.windows()`（后者在运行时内部会对断线做一次惰性重新发现）：

- 面板头：`尚未探测` / `探测中` / `未连接` / `N 个 EDA 窗口` / `未发现 EDA 窗口`（如实反映最近一次结果）。
- 四格：`桥端口`、`EDA 窗口`、`目标窗口`、`最近探测`（时间戳）；有窗口时列出窗口标题并标出当前目标。
- 动作：`重新连接 / 重新发现桥` → 重新走 `discover + windows`；失败时展示运行时错误码
  （`重新发现桥失败：[CODE] message`），并提示确认 EDA/Bridge 扩展状态；**不假装已连接**。
- 进入验证页且非 DEMO 时静默探测一次；DEMO 模式禁用重连按钮（沿用本页其它真机入口的约定）。

## 5. 实际 DOM 文案（SSR 渲染抓取，作为截图不可用时的验收证据）

### 5.1 `detailSource=ui-dom`（含逐条 findings）

```
本次 ERC 检查的原理图文档（documentUuid）
9f2c4a7d1b3e5f60
多板工程里用它确认这次 ERC 检查的是哪一页原理图；换页后结论不能沿用，需要重新取证。
明细来源：ui-dom（EDA 检查面板逐条） 逐条 1 条
级别 规则 / Code 对象 说明 修复建议 结论
error ERC_POWER_PIN 电源脚未连接 U1.VCC 电源引脚没有连接 补电源标志后重跑 未处理
```

### 5.2 `detailSource=aggregate`（明细不可用，如实降级）

```
本次 ERC 检查的原理图文档（documentUuid）
aabbccddeeff0011
明细来源：aggregate（仅聚合计数） 聚合组 1 个
本次没有逐条明细，只有聚合计数。 运行时原因： ERC_DETAIL_TIMEOUT （从 EDA 检查面板抓取明细超时）。
聚合计数只能说明“有几条问题”，不能当逐条修复依据，这里也不会把聚合计数伪装成逐条条目。
请到嘉立创 EDA 里 手动点一次“设计检查 / ERC” ，让检查面板跑出结果后回到本页点“运行 ERC 取证”重试。
级别 聚合计数 说明
error ×1 EDA 只返回聚合计数（1 项），没有逐条对象/规则明细。
```

### 5.3 桥连接状态块（DEMO/未探测初始态，SSR）

```
EDA BRIDGE
桥连接状态（ERC 逐条明细依赖 EDA 检查面板）
尚未探测
重新连接 / 重新发现桥
桥断线后，运行时的 /api/eda/windows 、 /api/eda/session 会做一次惰性重新发现；这里展示的是 最近一次探测 的事实。
失败只显示错误码，不会假装已连接，也不影响已完成证据的只读查看。
桥端口 — 尚无已发现端口
EDA 窗口 0 EDA 未启动或桥未就绪
目标窗口 未选择 ERC 明细只从当前活动窗口抓取
最近探测 未探测 点击右侧按钮会重新 discover + windows
```

## 6. 测试证据（src/pages/__tests__/validation-erc.test.tsx）

1. `显示本次 ERC 检查的原理图 documentUuid，并渲染 ui-dom 逐条明细`：
   断言包含 `本次 ERC 检查的原理图文档`、UUID、`ui-dom`、`ERC 逐条明细`、`U1.VCC`、code 与说明。
2. `detailSource=aggregate 时如实说明没有逐条明细，且不渲染逐条表格冒充`：
   断言包含 `本次没有逐条明细，只有聚合计数。`、`不能当逐条修复依据`、`ERC_DETAIL_TIMEOUT`、`手动点一次`、
   `ERC 聚合计数（仅计数，不是逐条明细）`；并断言 **不包含** `ERC 逐条明细`（红线）。
3. `旧版证据缺 documentUuid 时如实说“未记录”`：断言 `未记录 documentUuid` 且不再渲染 UUID 节点。

## 7. 边界与未做（Lead 验收须知）

- 真实桥连接/断线重连的**真机**路径未执行：按任务约定真实 EDA 为只读验证环境，不点击/操作 EDA，也未启动新端口服务；
  本次证据为类型检查 + SSR DOM + 单测，桥的运行时路由（第 60 轮已实现）由 runtime 测试覆盖。
- 未跑 `desktop:build`、未安装 app、未改 `runtime/*.mjs`、未改其它页面。
- `pcbLayers` 类型已存在（`PcbLayerStack`）且与本任务无关，未改动。
