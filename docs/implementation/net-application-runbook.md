# 整板落网 → 布线 → DRC 清零 → 放行：操作手册（Runbook）

> 版本：Round 60 后建立 ✓　｜　执行者：Agent ✓　｜　人工介入点：仅 3 处（见 §7）
> 一切结论以**实测回读**为准 ✓；"调用没报错"≠"改成功" ✗。

---

## 0. 前置条件检查（每轮开工第一件事）

| 检查 | 命令 | 期望 |
|---|---|---|
| EDA 桥接 | `curl -s -X POST http://127.0.0.1:49620/execute -H 'content-type: application/json' -H "x-circuitpilot-token: $(cat /tmp/cp_my_token.txt)" -d '{"code":"return Object.keys(eda).length"}'` | 返回数字，无 `No connected EasyEDA window` ✓ |
| PCB 文档 | `/execute` 内 `eda.dmt_EditorControl.openDocument('2844799d86eeed27')` | `"<uuid>@<project>"` ✓ |
| 器件基线 | `pcb_PrimitiveComponent.getAll()` | **180 件** ✓ |
| 焊盘基线 | `pcb_PrimitivePad.getAll()` | **603** ✓ |
| 有网焊盘 | 统计 `pad.net !== ''` | 当前 **54**（52 基线 + U2.8/U2.9）✓ |
| 候选快照 | `/tmp/pcb_snap_r26.txt`、`/tmp/pcb_src_exact.txt` | 存在 ✓ |

> ⚠️ 文档曾被静默回退过一次（623KB→420KB）⇒ **每轮必须重跑本表** ✗不能沿用上轮结论。

---

## 1. 阶段 A：落网（当前阶段）

### A1. 生成映射（只读，不写板）
```bash
# 输入：/tmp/sch_pins.json（引脚名）、/tmp/bom_items.json（位号→MPN/封装）、/tmp/pcb_padmap.json（焊盘）
node /tmp/netgen.mjs          # 产出 /tmp/net_plan.json
```
`net_plan.json` 结构：`[{ padPid, ref, pad, net, basis }]`
- `basis` 字段必填：`measured`（实测已有）/ `requirement`（需求冻结）/ `engineering-judgement`（工程判断）✓
- **凡 `engineering-judgement` 的条目，必须在文档里逐条列出** ✗不许静默混入。

### A2. 分批写入（每批 ≤ 60 个焊盘）
```bash
node /tmp/netapply_batch.mjs 1    # 批次号
```
每批内部固定动作：
1. `pcb_PrimitivePad.modify(pid, { net })`
2. `pcb_Document.save()`
3. **双通道回读**：`pcb_PrimitivePad.getAll()` + `pcb_PrimitiveComponent.getAllPinsByPrimitiveId(compId)`
4. **源码增量核对**：`getDocumentSource().length` 应等于 `上一轮长度 + Σ(网名字节差)`
5. 落盘 `/tmp/net_apply_log_<批次>.json`（每条：pid/ref/pad/旧网/新网/成功与否）

### A3. 批次验收（硬门禁，任一不过即停）
- 写入成功率 **100%**（不允许"部分成功"当通过）✓
- 双通道回读**完全一致** ✓
- 源码字节增量**可解释** ✓
- 器件数仍 **180** ✓、焊盘数仍 **603** ✓

### A4. 回滚
```bash
node /tmp/restore.mjs /tmp/pcb_src_exact.txt   # setDocumentSource(原样字符串) → 已验证返回 true
```

---

## 2. 阶段 B：布局（落网完成后）

1. `pcb_PrimitiveComponent.modify(id, {x, y})` 按功能分区摆位（计划统一用毫米坐标；`PcbManager` 在执行边界转 EDA 原生 mil ✓）
2. 分区规则：电源区（左）/ MCU 区（中）/ 音频区 / 摄像头 FPC 区 / RGB 串 / 舵机座（右边缘）
3. 验收：DRC 间距类错误数下降 ✓、无器件重叠 ✓

## 3. 阶段 C：布线

1. 先查能力：`pcb.routing.capabilities` → `nativeAutoRouting` 是否 `true`
2. 自动布线：`pcb.autoRoute`（可传 `nets`/`layers`）
3. 若自动布线不可用 ⇒ `pcb.line.create(net, layer, x1,y1,x2,y2, width, lock)` 手工/脚本逐网走线
4. 验收：DRC "未连接" **32 → 0** ✓

## 4. 阶段 D：DRC 清零（91 → 0）

```bash
# 1) 启动
POST /api/eda/pcb/drc/start  {"userInterface": false}   → {jobId}
# 2) 约 10 秒后取报告
POST /api/eda/pcb/drc/report {"jobId": "<jobId>"}        → {report, classification}
```
- 分类处理：Connection（未连接）→ 靠布线 ✓；Clearance（间距）→ 靠挪位/走线 ✓；Board Outline→Track → 挪线 ✓
- **禁止**放宽任何 ≤10 mil 规则 ✗；**禁止**把错误标 ignore 充数 ✗
- 验收：**items = 0** ✓，且规则表与基线一致 ✓

## 5. 阶段 E：ERC

- 原理图侧 `schematic.erc.start` / `erc.report`（沿用 DRC 同样的 start→poll 模式）
- 验收：ERC 0 错误（警告需逐条解释 ✓）

## 6. 阶段 F：制造产出与放行

1. `pcb.3d.export` → STEP/GLB ✓
2. `pcb.manufacture.export` → Gerber / BOM / CPL ✓
3. `artifacts inspect` 校验文件完整性 ✓
4. **放行纪律不变** ✗：`humanSignoffRequired` 保持 `true`、`orderEnabled` 保持 `false`、文档强制带 `DRAFT-NOT-FOR-ORDER` ✓

---

## 7. 需要你（人类）介入的 3 个点

| # | 时机 | 你要做的 | 为什么必须是你 |
|---|---|---|---|
| 1 | 阶段 C 前 | 确认**保留 7 个新增件**（U3 DW01A、Q3 FS8205A、RT1、U15 TPS61088、L2、U19 SN74LVC1T88、Q4 AO3401A） | 涉及 BOM 与成本 ✓ |
| 2 | 阶段 C 前 | 确认**2 层板 USB 90Ω 阻抗不做受控阻抗**可接受 | 制造工艺取舍 ✓ |
| 3 | 阶段 F | **最终放行签核**（签核按钮/签名字段） | 合规要求，Agent 不得代签 ✗ |

另需你补 4 项工程信息（不阻塞落网，但影响布线质量）：
- 摄像头 FPC 24P 真实脚序（现为占位 = 工程判断 ✗）
- 舵机 3P 座脚序（信号/电源/地）
- WS2812 串接顺序（LED5→LED7…→LED10？）
- SW1 / SW2 / SW3 的实际功能（开关机/复位/配网）

---

## 8. 每轮留痕要求（不可省）

- 追加 `docs/implementation/wardrobe-assistant-design-verification.md`：本轮做了什么 ✓、实测数字 ✓、失败与原因 ✓、下一步 ✓
- 追加 `docs/implementation/whole-board-progress.md`：3~6 行摘要 ✓
- 证据落盘：`/tmp/net_apply_log_*.json`、DRC 报告 JSON ✓
