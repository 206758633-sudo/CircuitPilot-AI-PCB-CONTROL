# 19. 相机接口（GC0308/DVP）与 EDA 网表编辑边界

## 1. 相机模组型号的确认方法（可复用）

验证工程 `.epro2` 内是“文档记录流”：把内层 `.epru` 按行拆成 `{header}||{payload}|`，按 `DOCHEAD.docType` 分组后：

1. 先搜 `SCH_PAGE` 里的文本注释（`ELE_PLACEHOLDER`/`TEXT` 的 `value`）——本工程直接写有 **“3. 摄像头：GC0308”**；
2. 再看器件（`DEVICE`）的 `META.title` / 分类，确认连接器型号 `HX 0.5-24PIN XGXJ-H2.0`；
3. 用 `PAD_NET` 记录 `id=["PAD_NET", 元件ID, 焊盘号, 焊盘ID]` + `ATTR{key:"Designator"}` 的 `parentId` 反查位号，即可还原连接器每一脚的**真实网络**；
4. 电源轨再由 `PAD_NET` 反查电容/LDO/0Ω 的脚，确认“谁产生、谁去耦、谁隔离”。

只靠 BOM 是查不到相机型号的：参考工程 BOM 里没有相机本体（相机经 FPC 外接），必须读原理图文本 + 网表。

## 2. GC0308 相机接口事实（验证工程实测）

| U8 脚 | 网络 | U8 脚 | 网络 |
|---|---|---|---|
| 3 | IO8_DVP_D2 | 4 | IO18_DVP_D1 |
| 5 | IO17_DVP_D3 | 6 | IO16_DVP_D0 |
| 7 | IO15_DVP_D4 | 8 | IO7_DVP_PCLK |
| 9 | IO6_DVP_D5 | 11 | IO4_DVP_D6 |
| 12 | IO5_DVP_XCLK | 13 | IO9_DVP_D7 |
| 14 | **2V8（DOVDD）** | 15 | **1V5（DVDD）** |
| 16 | IO46_DVP_HREF | 17 | DVP_PWDN |
| 18 | IO3_DVP_VSYNC | 19 | RESET |
| 20 | IO2_I2C_SCL | 21 | **AVDD_2V8** |
| 22 | IO1_I2C_SDA | 10/23/25/26 | GND / AGND / GND |

电源链：`U7 ME6211C28M5G-N`（3V3→2V8，C11/C24/C28/C95）→ U8 pin14；`R25(0Ω)` 把 2V8 隔离为 `AVDD_2V8`（C12/C22）→ pin21；`U20 ME6211C15M5G-N`（3V3→1V5，C31/C32）→ pin15。I2C 上拉到 2V8。

## 3. 我方设计缺陷（判定为 error）

我方 U8 的 1–24 脚全部是 `CAM_1..CAM_24` 单端网络接 ESP32 GPIO，没有 2V8/1V5/AVDD/AGND，引脚定义与 GC0308 完全不符。整改见 `artifacts/wardrobe-case/pm-run-20261022/CAMERA-ECO-GC0308.md`（含逐脚目标网表、LDO/去耦/上拉 BOM、PCB 放置与走线要求、验收标准）。

## 4. EDA 3.2.186 网表编辑能力边界（探针实测）

| 探针 | 结果 |
|---|---|
| `sch_PrimitiveWire.create(...)` | 抛 `create failed!`（带/不带 net、flat/nested 坐标均失败） |
| `sch_PrimitiveText.createNetLabel` | 不存在；`createNetLabel` 只挂在 `sch_PrimitiveAttribute` 类 |
| `sch_PrimitiveComponent.createNetFlag('Ground','GND')` | **成功**（可创建网络标志，但无导线连不上） |
| `lib_Device.search('ME6211', 系统库)` | **超时 180s**，桥 pending 挂起，恢复后健康 |
| `PCB setDocumentSource` / `lib_Footprint.updateDocumentSource` | 一律 `false`（仅同源替换为 true） |
| GUI 菜单（DOM/CDP/Alt+P/System Events） | 全部无效（编辑器为 canvas 渲染） |

结论：**“改原理图/改网表”在 3.2.186 上无法由插件 API 自动完成**。可行路径只有三条：
1. 人工按 ECO 在 GUI 执行（最快、最稳）；
2. 等官方补齐 `create`/`modify` 网表能力；
3. 导出 `.epro2` 离线修改后，用 `importProjectByProjectFile(projectFile, fileType, ..., saveTo:{operation:"Existing Project", existingProjectUuid})` 回灌（本轮因 epro2 > 桥单次 1MB 限制未实测，列为下一轮验证项）。

## 5. 防复发（流程）

- 画任何外设接口前，先产出“脚位对照表 + 电源轨清单”，作为原理图评审必查项；
- 外设型号必须来自需求方/验证工程的可追溯证据，不接受推断；
- 有“验证工程”时只做对标（对照差异表），不照抄；
- 每次 AI 改板前先做 API 能力探针并备份，避免半成品写坏工程。
