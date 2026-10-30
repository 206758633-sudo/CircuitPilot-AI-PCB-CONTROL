# CircuitPilot 产品级缺陷修复（2026-10-21，第 59 轮）

本文件记录从"衣橱助手 V2.0"真机全链路里暴露、且**属于产品代码缺陷**（不是单板设计问题）的
6 个修复点。它们此前只以"安装包热补丁"形式存在于本机 `/Applications/CircuitPilot.app`，
本轮已回流到源码 `runtime/`，并补齐回归测试。

> 判定标准：换一块板、换一个工程仍然会踩的缺陷 → 产品级；只和这块板的设计数据有关 → 项目级
> （项目级动作见 `artifacts/wardrobe-case/records/PCB-FULL-CHAIN-RUN-20261021.md`）。

## 1. CPL 坐标基准（release-gate.mjs + server.mjs）

- **缺陷**：EDA 导出的 CPL `Mid X/Y` 是**器件原点**，而板面证据 `placement` 的 `xMm/yMm` 是**包围盒中心**。
  非对称封装（USB-C、座子、模组）中心与原点差 1~2mm，发布门禁 `gateArtifacts` 稳定误报
  `RELEASE_CPL_COORD_MISMATCH`，把正确产物判成"CPL 不是这块板的"。
- **修复**：
  - `runtime/server.mjs` 板面证据同时保留 `originXMm/originYMm`（EDA 读回原点）；
  - `runtime/release-gate.mjs` 坐标比对同时试 `center` / `origin` 两套基准，取最小误差，
    并在通过证据里写明实际使用的基准。
- **测试**：`runtime/__tests__/release-gate.test.mjs`「CPL 坐标：非对称封装允许用器件原点基准核对」。

## 2. 布线层选择（server.mjs + engineering/route-layers.mjs）

- **缺陷**：布线器默认 `layers=[1,2,17,18]`、`innerLayer=17`。而 4 层板真实启用层是 `[1,2,15,16]`，
  且 `pcb.layers.read` 返回**全部理论层**（46 层都有 id/type）。结果计划里写出 layer 17/29（板上不存在的层），
  应用到 EDA 必然 `Bridge HTTP 500`；即使能写，也是在不存在层上"布线"。
- **修复**：新增纯函数 `runtime/engineering/route-layers.mjs#selectRoutableLayers()`：
  仅 `layerStatus===1` 的层算启用铜层；顶层/底层 1/2、内层 15..44；不足两层返回 `null`
  让调用方保留默认并由独立复核拦截。`/api/eda/pcb/routing/plan` 规划前按实机读回覆盖 `layers/innerLayer`。
- **测试**：`runtime/__tests__/route-layers.test.mjs`。

## 3. 焊盘间距几何（bridge.mjs + pad-geometry.mjs）

- **缺陷**：`pcb.copper.read` 把焊盘 shape 的**长边/2**当半径（旧 `Math.max`）。0.4mm 间距的
  QFN 矩形焊盘（真机 U5/ES7210）被放大成互相重叠的圆 → 所有 A* 路线判"间距不足"、计划永远无法复核通过。
- **修复**：新增 `runtime/pad-geometry.mjs#padClearanceRadiusMil()`：取**内切半径（最短边/2）**，
  且只统计正数尺寸（EDA shape 第三位常是旋转角 0，不能被当成 0 尺寸）。
  `bridge.mjs` 用 `${FN.toString()}` 把同一实现内联进远程脚本，避免"模块里改了、远程没改"两套几何。
- **测试**：`runtime/__tests__/pad-geometry.test.mjs` + `bridge.test.mjs` 的注入校验。

## 4. ERC 明细接口（eda-gui.mjs + eda-erc-detail.mjs + server.mjs + schematic-acceptance.mjs）

- **缺陷**：EDA 扩展 API `schematic.drc` 只返回聚合计数（`[{type:'error',count:1}]`）。
  CircuitPilot 因此只能报"有 1 个错误"，用户不知道错在哪，工程卡在 `RELEASE_SCHEMATIC_NOT_READY`；
  `/api/eda/schematic/erc/run`、验收、发布门禁都拿不到逐条依据。
- **修复**：
  - `eda-gui.mjs` 新增只读 GUI 动作 `ercDetail`：定位 EDA 检查面板、必要时点一次「检查ERC」触发、
    轮询计数、从面板 DOM 抓逐条 `[错误]/[警告]/[信息]` 行；抓不到如实返回 `{ok:false, reason}`；
  - 新增 `runtime/eda-erc-detail.mjs`：`extractErcDetail()` 带**硬超时**（GUI/CDP 卡住时降级），
    `mergeErcDetail()` 把逐条明细合并进 `erc.mjs` 归一化报告——**某级别明细条数 ≥ 聚合计数才整体替换**，
    覆盖不全时保留聚合余量（不把 34 条警告只当 5 条）；
  - `/api/eda/schematic/erc/run` 在聚合结论下自动尝试明细，证据里记录 `ercDetail` 来源/失败原因；
  - 验收 `runSchematicAcceptance` 支持注入 `ercDetail`：抓到明细时把"ERC 报告 N 个错误"的聚合 finding
    升级成逐条可定位 finding（含对象/建议），并在报告里返回 `erc` 明细块。
- **测试**：`runtime/__tests__/eda-erc-detail.test.mjs`、`schematic-acceptance.test.mjs` 的 ERC 明细用例、
  `erc-http.test.mjs`（离线契约仍不把聚合伪装成明细）。

## 5. 仿真证据回退（schematic-acceptance.mjs + release-gate.mjs + server.mjs）

- **缺陷**：EDA 符号没有绑定仿真模型 → `schematic.simulation.netlist.export` 返回 `null`；
  验收每次重跑都得到 `simulation:null`，即使本机曾用**真实 ngspice** 跑过显式网表并落盘了
  `spice-simulation` 证据，发布门禁 `gateSimulation` 仍判 unknown（`RELEASE_SIMULATION_NOT_RUN`）。
- **修复**：验收新增 `loadSimulationEvidence` 注入；EDA 导不出网表且设计检查点也跑不了时，
  回退引用本机已落盘的真实求解器证据，并在报告里明确 `source/evidenceHash/scopeNote/evidencePath`；
  门禁文案改为"仿真证据在（哈希，来源 X）；覆盖范围：…"，不再默认冒充"EDA 导出网表"。
  没有落盘证据时仍如实报"没有仿真"（不是免检通道）。
- **测试**：`runtime/__tests__/schematic-acceptance.test.mjs` 的回退用例（有证据/无证据两条）+
  `release-gate.test.mjs` 的门禁文案用例。

## 6. 截图传输（gui-artifact-transport.mjs + server.mjs）

- **缺陷**：`/api/eda/gui/execute` 的 `screenshot` 直接内联整页截图 base64（真机 3420×2040 ≈ 4.6MB），
  响应体过大在传输层被截断成 `[truncated N chars]`，调用方拿到半截 base64 必然解析失败；
  失败看起来像"截图坏了"，实际是响应体太大。
- **修复**：新增 `runtime/gui-artifact-transport.mjs#materializeGuiScreenshot()`：
  小图（≤256KB）保持 `{base64}` 内联完全兼容；大图落盘到证据目录并返回
  `{kind:'file', path, bytes, sha256}`，数据完整、响应体小、截图本身成为可归档证据。
- **测试**：`runtime/__tests__/gui-artifact-transport.test.mjs`。

## 验证

```bash
node --test --test-timeout=120000 \
  runtime/__tests__/pad-geometry.test.mjs \
  runtime/__tests__/route-layers.test.mjs \
  runtime/__tests__/gui-artifact-transport.test.mjs \
  runtime/__tests__/eda-erc-detail.test.mjs \
  runtime/__tests__/release-gate.test.mjs \
  runtime/__tests__/schematic-acceptance.test.mjs \
  runtime/__tests__/bridge.test.mjs \
  runtime/__tests__/erc-http.test.mjs
```

关联回归（已跑通）：`eda-gui`、`pcb-routing`、`routing-plan-filter`、`erc`、`release-decision`、
`production-release`、`multilayer-http`、`pcb-layers-http`、`server`。

## 尚未覆盖（需要真机 EDA 会话）

1. 本机 EDA 当前停在开始页、API 网关（49620-49629）未挂起，无法做本轮修复的真机闭环验证；
2. `ercDetail` 的 DOM 行解析依赖 EDA 3.2.186 面板结构，需要在打开的工程上实测一次
   （失败也只是降级为聚合结论，不会伪造）；
3. 大截图落盘路径默认 `artifacts/gui-capabilities/`，可用 `CIRCUITPILOT_GUI_EVIDENCE_DIR` 覆盖。
