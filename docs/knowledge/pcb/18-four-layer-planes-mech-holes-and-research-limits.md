# 四层板电源平面、机械孔近似与外部检索受限（r45–r46）

> 本轮对象：衣橱助手V2.0 主板（PCB `5595e77cead09682`）。用户授权：①人工 GUI 补齐机械要素，由 AI 操作；②上网查相机供电；③升 4 层补电源平面。

## 1. 先纠正一个历史错误结论

早前报告写“我方 2 层铜”。r45 真机复核：`layers.copperCount=4`，`enabledCopperIds=[1,2,15,16]`（Top/Inner1/Inner2/Bottom），升级请求返回 `changed:false`（before 已是 4）。**“2 层”结论作废**，后续所有对标按 4 层板口径。

## 2. 电源平面补法（真机步骤 + 证据）

| 步骤 | 动作 | 返回/校验 |
|---|---|---|
| 1 | `GET /api/eda/pcb/layers` | copperCount 4，enabled [1,2,15,16] |
| 2 | `POST /api/eda/pcb/layers {copperLayers:4}`（带 write 批准） | `changed:false`，保存成功（无需改层） |
| 3 | `POST /api/eda/pcb/pour/create {net:'+3V3',layer:15,pourName:'PWR_3V3_INNER1',outline:[...板框105点]}` | 200，回读 net/layer 匹配 |
| 4 | 重新签批准 + `pour/create {net:'+5V',layer:2,pourName:'PWR_5V_BOTTOM'}` | 200，回读匹配 |
| 5 | `pcb.pour.rebuild`（4 个 pour）→ `pcb_Document.save()` | 4/4 `rebuildCopperRegion()=true`，save=true |
| 6 | 官方 DRC（robust 读回） | **0 items** |

最终覆铜布局：GND_TOP(layer 1)、GND_BOTTOM(layer 16=Inner2)、PWR_3V3_INNER1(15)、PWR_5V_BOTTOM(2)。
证据：`evidence/main-layer-upgrade-4l-r45.json`、`evidence/main-power-pours-4l-r45.json`、`evidence/main-power-pour-5v-r45.json`、`evidence/drc-robust-main-r45-r38.json`、`evidence/main-mech-holes-and-planes-r46.json`。

**纪律**：一次 write 批准只能消费一次（第二个 pour 必须重新签发），否则 409 `AUTOMATION_APPROVAL_INVALID`。

## 3. 机械孔：NPTH 不可创建，用镀铜 via 近似

- 安装孔 4 个：`pcb_PrimitiveVia.create('', x, y, 106.2992, 122.0472)` → 回读 `HoleDiameter=106.2mil(2.7mm)`、`Diameter=122mil(3.1mm)`，位置 (4,4)/(52,4)/(4,58)/(52,58) mm，net 空。
- 结果：via 总数 108→112，DRC r46 **0 items**。
- **必须标注**：这是“镀铜安装孔”，不是 NPTH；与参考 Ø2.0mm 非镀铜孔不同，螺钉/外壳可能被等电位连通。
- 选点依据：板框 105 点多边形算边距 + 现有 pad/via/comp 最近距离（4 个角点最近图元 ≥110mil、边距 ≥110mil）。

## 4. 禁布区 / 丝印文字：仍不可创建（能力实测）

| 尝试 | 结果 |
|---|---|
| `pcb_PrimitiveString/Region.create({完整字段})` | “无法创建…可能是传入的参数不正确” |
| 无参 `create()` + `setState_*` 链（官方 d.ts 签名） | 同错 |
| `setDocumentSource(原源码)` | **true**（无改动可接受） |
| `setDocumentSource(追加一条 STRING/LINE)` | **false**（源码不接受新增记录；读回条数不变） |
| GUI `放置` 菜单（CDP 真实鼠标事件 / System Events 座标点击） | body.innerText 前后无差异，菜单未打开；编辑器在 iframe 内由 canvas 绘制，菜单不是 DOM 元素 |

结论：禁布区/丝印只能人工 GUI 一次补齐。操作清单（坐标+尺寸+层+内容）见运行日志 §49。

## 5. 相机供电：外部检索通道受限

- `web_search` 无 Key；`web_fetch` 对 `www.ovt.com`、`en.wikipedia.org` 返回“非公网地址”；curl 访问 Bing/DDG/Sparkfun/Mouser 均为挑战页/404；仅 `raw.githubusercontent.com` 可下载（用于装 chi_sim OCR 语言包）。
- 工程推断（需标注不确定性）：OV5640 公开规格 AVDD 2.6–3.0V（典型 2.8V）、DOVDD 1.7–1.9V（典型 1.8V，部分模组 2.8V）、DVDD 1.4–1.6V（典型 1.5V）。参考工程正好有 `ME6211C28M5G-N`(2.8V) 与 `ME6211C15M5G-N`(1.5V) 两路 LDO + `RCLAMP0521T-ES` ESD。
- 判定：若我方 24P FPC 接的是**带稳压的 OV5640 模组**，单 3V3 可行；若接**裸传感器/裸 FPC**，必须补 2.8V/1.5V（及 1.8V I/O）电源轨与 ESD。**需模组型号或 FPC 24 脚定义才能定案**，不在无资料情况下改原理图。


## 5.1 r48 更正：相机模组已从验证工程中查明 = GC0308

后续从 `ProDoc_衣橱助手V2.0_2026-10-16.epro2`（sha256 `a4818cc514fd…`）内解析到：
- SCH_PAGE 文本明确写有 **“3. 摄像头：GC0308”** 与 **“DVP摄像头接口”**；
- 相机连接器 **U8 = HX 0.5-24PIN XGXJ-H2.0**，26 个焊盘的网表完整可读；
- 电源：`2V8`（U7 = ME6211C28M5G-N，3V3→2V8，C11/C24/C28/C95）、`AVDD_2V8`（2V8 经 R25 0Ω + C12/C22 滤波）、`1V5`（U20 = ME6211C15M5G-N，3V3→1V5，C31/C32）；
- 引脚：14=2V8(DOVDD)、15=1V5(DVDD)、21=AVDD_2V8、23=AGND、10=GND、25/26=GND；其余为 DVP D0–D7/PCLK/XCLK/HREF/VSYNC/PWDN/RESET 与 I2C SCL/SDA，全部映射到 ESP32 IO1–IO18/IO46。

**对我方设计的结论**：我方 U8 的 1–24 脚全部接 ESP32 GPIO（`CAM_1..CAM_24`），没有 2V8/1V5/AVDD/AGND，既缺电源轨、引脚定义也与 GC0308 不一致。修法：按上面参考引脚重画相机接口，补 ME6211C28M5G-N 与 ME6211C15M5G-N 两路 LDO（含 R25 与去耦），DVP 信号映射到 ESP32 IO。

## 6. 下一轮顺序（建议）

1. 人工 GUI 一次性补齐禁布区/丝印（清单已给，回读核对）。
2. 拿到相机模组型号/FPC 定义 → 定电源轨 → 改原理图/网表/PCB → DRC。
3. BOM 决策：按功能缺口选择性补（相机 LDO/ESD、降压电感、去耦），不照抄参考 179 件。
4. DFM/签核/正式导出仍需人工门禁。
