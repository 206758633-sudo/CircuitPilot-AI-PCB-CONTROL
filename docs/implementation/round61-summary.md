# 第 61 轮：未完成项拆分给子代理 + Lead 验收（2026-10-21 19:2x–19:5x）

本轮把第 60 轮报告里的"仍未完成/已知项"拆成 7 个自包含任务，交给 6 个子代理并行完成，Lead 负责统一验收（全量测试、构建、安装、真机复验、证据核对）。

## 1. 任务分工与交付

| 任务 | 子代理 | 交付 | 状态 |
|---|---|---|---|
| T1 桥连通性错误 HTTP 语义 | runtime-guard | `BRIDGE_UNREACHABLE/BRIDGE_TIMEOUT → 503 + retryable:true`；`BRIDGE_NOT_FOUND` 保持 503；4 条离线 HTTP 契约测试 | ✅ |
| T2 新能力接 UI | ui-erc | ERC 面板显示 `documentUuid`/明细来源/逐条 findings 表；桥连接状态与重连；3 条 vitest；DOM 文案证据 | ✅ |
| T3 SPICE 证据链 | spice-evidence | 真实网表（64 器件/266 引脚/34 网络，sha256 `a7bbca3f…`）+ ngspice-46 `.op`/`.tran` exit 0 + 证据 JSON + 可重跑脚本 | ✅（整板模型仍 BLOCKED） |
| T4 板级 triage | board-triage | ERC 37 条逐条 triage（1/34/2 与证据一致）、171 悬空引脚清单、GND 缝合分析、PCB 只读快照 | ✅（全程只读） |
| T5 BOM 证据富化 | bom-enrich | `runtime/bom-enrich.mjs`（fail-closed：MATCH/MISSING/AMBIGUOUS/STALE，unknown≠0 元）+ 14 条测试 | ✅ |
| T6 真机放行门 + 签名就绪 | release-gate | 真实 gate 调用：`ready=false`/blocked，10 阻断+1 警告，无假 PASS；签名就绪检查（ad-hoc、无 Developer ID/公证） | ✅（诚实 blocked） |
| T7 放行门证据接线硬化 | runtime-guard | gate 消费仿真证据（`COVERAGE_PARTIAL`，已消费≠通过）、DRC 证据 `pcbUuid` 绑定校验（不一致 blocked）；新增 7 条测试 | ✅ |

## 2. Lead 统一验收（亲测，不是转述）

- `npm run test:runtime` → **872/872 通过**（本轮开始前 847；新增 25 条：T1 bridge 4、T5 14、T7 7 等）。
- `npx vitest run` → **169/169 通过**（23 个文件）；`npx tsc -b` → exit 0。
- `npm run desktop:build` → exit 0，产出 `bundle/macos/CircuitPilot.app` + `dmg/CircuitPilot_0.2.0_aarch64.dmg`；已用 `ditto` 安装到 `/Applications/CircuitPilot.app` 并重启（主进程 64023 / runtime 64037）。
- 已安装包黑盒复验（用它自带的 runtime 代码 + 显式令牌启动 4182）：
  - `GET /api/eda/pcb/layers` → 200，`copperCount:4`、`count:262`、`enabledCopperIds:[1,2,15,16]`；
  - 切到 Board1_1 的 PCB3 后 `POST /api/eda/schematic/erc/run`（不填 uuid）→ 自动定位 `87dba2a22fe7096e`、`detailSource:'ui-dom'`、**37/37 条**（1 error/34 warning/2 info），7.1s。
- **桥断线 503 真机演练**：kill 桥 daemon → `GET /api/eda/windows` 返回 **503 `BRIDGE_UNREACHABLE` + `retryable:true`**（修复前 400）；重启 daemon 约 10s 后自动恢复 200（`edaConnected:true`，新 windowId，工程/文档/memo 完整，无需重启 runtime）。
- **T7 真机复验**：喂 T3 真实仿真证据 → `evidenceBinding.simulation.consumed=true`、simulation 子门 `RELEASE_SIMULATION_COVERAGE_PARTIAL`（unknown，不放行）；喂旧 DRC 证据（`pcbUuid=5d632dde…` vs 当前 `5595e77c…`）→ DRC 子门 **blocked `RELEASE_DRC_EVIDENCE_PCB_MISMATCH`**，消息写明两个 UUID。
- 完整证据：`artifacts/evidence/round61/lead-verification.json`。

## 3. 子代理产出的关键板级发现（必须人工处理）

1. **P0 地-电源短接**：官方网表 10 个 GND 引脚全被归到 +3V3；PCB 侧 **GND 焊盘/走线/过孔全为 0**，4 块 GND 铺铜是电气孤岛（内层 L15/L16 也有 GND 平面但无 GND 网络）。**修复前禁止上电**。
2. **P0 MK1 缺焊盘**：ERC 唯一 error —— 麦克风 `MK1`（LMA2718B381-OFA08）缺 1/2/3 焊盘，PCB 焊盘读回数=0。
3. **P0/P1 网络冲突**：`$2N8`（GND/+3V3）、`$2N23`（+3V3/MIC_VDD）；24 条 CAM_n 重复网络标签。
4. **P1 接线完整性**：266 引脚中 171 个无网络（64.3%，与 ERC 悬空集合逐条一致）；51 个元件完全未连接，全部引脚有网络的仅 1 个。
5. **P2 仿真边界**：EDA 官方 Ngspice 整板网表导出返回 null（器件模型未绑定），T3 只用真实网表 + 显式假设跑通关键子电路（VBUS→IP2312→VBAT），证据标注 partial。
6. **P2 封装/规则**：47 个元件需标准化核对；规则集名为 `JLCPCB Capability(Two Layers Board)` 与 4 层叠层不匹配。

## 4. 放行门真实结论（T6，供决策）

`ready=false` / `verdict=blocked`：10 条阻断 + 1 警告，`orderEnabled=false`、`humanSignoffRequired=true`。归属：人工 2（ERC 错误需改图、布局未确认）｜代码能力 1（仿真未整板，T7 已修"不消费证据"）｜流程 5（DRC 证据缺失、3×草稿产物、CPL 坐标偏差 78–117mm）｜外部 2（BOM 缺料号、无价格/库存；DFM/签核缺失）。**无假 PASS**。

## 5. 本轮仍未闭环（需人工/外部系统，不可由子代理代劳）

- 修 `$2N8`/`$2N23` 与 GND 网络（产品不自动改图；改图需人工确认电气意图 + 重新批准）。
- MK1 封装补焊盘；47 元件 BOM 标准化；171 悬空引脚逐条定"补线/NC/DNP/删件"。
- GND 修复后的缝合孔放置、铺铜重建、当前板重跑 DRC（现有 DRC 证据属于旧 PCB，不能沿用）。
- 整板 SPICE 模型绑定（ESP32-S3/IP2312/MT3608/SY8089/ES7210/NS4168/SS34/TVS/MOSFET/MIC 等）后才能谈整板仿真。
- DFM 人工签核、终审签核、真实 BOM 价格/库存数据（需可信来源）。
- macOS Developer ID 签名 + 公证（需用户 Apple 开发者证书与 notarytool 凭证）。

## 6. 相关文档与证据

- 任务文档：`round61-bridge-http-status.md`、`round61-ui-erc.md`、`round61-spice-evidence.md`、`round61-board-triage.md`、`round61-bom-enrich.md`、`round61-release-gate-real.md`、`round61-gate-evidence-wiring.md`、`macos-signing.md`。
- 证据：`artifacts/spice/`、`artifacts/board-analysis/`、`artifacts/release-gate-real/`、`artifacts/evidence/round61/`。
- 脚本：`scripts/spice-evidence.mjs`、`scripts/board-triage.mjs`、`scripts/release-gate-report.mjs`、`scripts/check-signing-readiness.mjs`。
