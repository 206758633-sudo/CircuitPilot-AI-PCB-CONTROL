# 差异根因整改方案（可落地版，2026-10-21）

> 依据：`docs/implementation/reference-vs-circuitpilot-diff.md`（差异数据）、`docs/implementation/board-cleanup-2026-10-21.md`（结构现状）、`artifacts/wardrobe-case/records/original-prompt-1.txt`（双板原始需求）。
> 目标：让 CircuitPilot 产出的板从"单板简化 demo"变成"可验收的双板设计"，并把"差异"收敛到设计决策白名单内。

## 0. 根因 → 对策映射（先认清问题）

| 根因 | 表现 | 对策 |
|---|---|---|
| 输入只有文本需求+DXF，无引脚级规格 | 网表靠猜；171 悬空、GND 错归 | **规格先行**：生成 `design-spec.json`（意图网表/选型锁/接口 pinout），设计以 spec 为准 |
| 单板流程建模 | 按键板没建、空板残留 | **多板建模**：`workspace.create` 支持 boards[]，幂等；UI 展示全部板 |
| AI 自由选型 | 58 同位号全换料 | **BOM 冻结**：选型评审通过后锁料号，换料走 PCN；替换白名单 |
| 写操作半成功、无门禁 | 有器件无连线、无 DRC 证据 | **硬门禁**：ERC/网表 diff/DRC/制造输出逐门拦截，证据绑定 uuid |
| 对比口径 | 参考整包 vs CP 单板 | **验收矩阵**：按"需求条目↔spec↔证据"逐项验收，而非只比器件数 |

## 1. P0：规格先行（1~2 天，先做这个）

产出物（机器可读，进 artifacts/spec/）：
1. `spec/design-spec.json`
   - `boards[]`：主板 `{name, outline(dxf→pts), size, layers:4, stackup:"JLC04161H-7628", rules}`；按键灯板 `{name, size:21.4×44.9, layers:2, 贴装:双面}`；
   - `interfaces[]`：主板 U14(`+5V/GND/LED`) ↔ 按键板 U16(`5V0/GND0/LED0`)；主板 U18(`BUTTON/IO0_BOOT/GND`) ↔ 按键板 U17(`BUTTON0/IO0_BOOT0/GND0`)；
   - `bomLock[]`：每块板"冻结料号"清单（位号/型号/封装/供应商料号/是否关键件）；
   - `netIntent[]`：net → [{ref, pin}] 引脚级意图网表（含 NC 显式标记），电源/GND 必须非空；
   - `requirementsMap[]`：37 条需求 → spec 元素 → 验收证据类型（PCB-M-01→boards[2]、PCB-F-06→WS2812B×5、…）。
2. `spec/reference-baseline.json`：用 `artifacts/reference-epro2/parse-reference.py` 从参考 .epro2 抽出的**检验基准**（BOM/网络/接口/尺寸），只用于验收不导入工程。
3. DXF→板框流水线：复用 `artifacts/wardrobe-case/drawings/` 的点位数据，输出两块板框（含不规则外形）+ 安装孔/开孔坐标（±0.3mm 对位需求）。

验收：需求映射 100%（37/37）；两块板框尺寸与需求误差 ≤0.5mm；接口 pinout 两端一致；无"从参考工程导入"的写操作。

## 2. P1：双板流程 + 选型锁（本周）

CircuitPilot 改造（代码级，按仓库现状）：
- `runtime/bridge.mjs`：新增 `board.createFromSpec`（按 spec 建 Board+Sch+Pages+PCB，幂等），`board.delete`/`document.delete` 注册成正式命令（本次已用 EDA API 验证可行：`dmt_Board.deleteBoard(name)`、`dmt_Pcb.deletePcb(uuid)`、`dmt_Schematic.deleteSchematic(uuid)`，deleteBoard 不级联需补删）；
- `runtime/server.mjs` + `src/types.ts`：`EdaWorkspaceBinding` 扩展为 `boards[]`，页面展示全部板，绑定/切换不再只认单板；
- `runtime/workspace.mjs`（worktree 版）：`workspace.create` 支持复用与去重，避免重复建板留残留；
- 封装完整性检查：料号必须 symbol+footprint+3D 齐全（参考板 U3 仅符号是反例），缺失即阻断；
- 选型锁：BOM 评审通过 → `bomLock` 冻结；后续原理图/PCB 换料触发 diff 警示与 PCN 记录。

按键灯板落地（15 器件，按参考/需求规格）：5×WS2812B-2020 + 2×TS3425BA(POWER/NET) + 2×SH1.0-3P + 6×100nF；2 层、21.4×44.9mm、丝印 POWER/NET/版本；灯数据单线级联 + 100nF 就近去耦。

验收：工程内恰 2 块板（随时可查板数=2）；按键板 ERC 0 错误；BOM 冻结并可追溯；重复执行 create 不产生新板。

## 3. P2：设计门禁（网表/ERC/DRC/布局）

门禁服务（后端 + 证据）：
- **G1 spec 门**：spec 完整、需求映射 100%；
- **G2 选型门**：封装/3D 完整、BOM 已冻结；
- **G3 ERC 门**：ERC 0 错误；网表 diff（意图 vs 实际）0 差异（或白名单），含：悬空引脚=显式 NC、电源/GND 非空、单端网络告警、GND/+3V3 混网检测；
- **G4 布局门**：两板板框/尺寸/安装孔/开孔对位（±0.3mm）、连接器朝向外壳、禁布区、板间接口坐标一致；
- **G5 DRC 门**：按 4 层规则跑 DRC=0；铺铜连通性（GND 孤岛检测=0）；
- **G6 制造门**：Gerber/BOM/CPL/装配图/测试规范齐套，丝印版本与工程一致，3D 渲染留档。

实现方式：`runtime/` 新增 `gates.mjs`（读证据→判定→写 `artifacts/evidence/gates/<板>/…json`，绑定 pcbUuid/时间戳）；UI 项目页显示各门状态，未过门标记"未放行"，下一步按钮禁用（硬门禁）。

同时修主板：2×SH1.0-3P 接口 + 5 颗指示 LED（4 电量+电源）及 GPIO/限流网络；GND 网络 0 焊盘/10 焊盘错归 +3V3 修复；171 悬空引脚定性（补连或显式 NC）。

验收：两板 ERC 0 / 网表 diff 0 / DRC 0 / GND 孤岛 0 / Gerber-BOM-CPL 齐套、证据 JSON 绑定 uuid。

## 4. P3：防复发与规模化

- **回归基准**：每轮至少用 1 份参考工程做"差异检验"，自动生成 diff 报告（已有 `parse-reference.py` 可复跑）；
- **真实机器集成测试**：现有 872 runtime / 169 vitest 之外，补 E2E：多板创建→ERC→走线→DRC→门禁证据→制造输出（用 EDA 真实实例，不用 mock）；
- **复盘制度**：差异按"没做完/做窄/做错"三类归档，每条必须对应整改项与回归用例；
- **参考工程只做"检验"**：绝不导入；基准文件进 `artifacts/`，可复跑、可审计。

## 5. 立刻可做的三件事（建议顺序）

1. 生成 `spec/design-spec.json`（37 条需求→两板+接口+BOM 锁+意图网表）；
2. 按 spec 设计按键指示灯板（15 器件）；同步给主板补接口和 LED；
3. 加 G3（ERC+网表 diff）和 G5（DRC+铺铜）最小门禁，跑出两块板的第一份证据包。

## 6. 验收总标准（放行定义）

- 两板数量/尺寸/接口/装孔与需求一致；
- 每块板：ERC 0、网表 diff 0、DRC 0、GND 连通、封装/3D 完整；
- Gerber/BOM/CPL/装配图/测试规范齐套且版本一致；
- 37 条需求逐条对应证据，差异清单只剩"选型白名单内差异"。
