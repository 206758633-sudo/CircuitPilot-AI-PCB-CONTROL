# K5 元器件布局依据“联网核对”实施与验证（2026-10-22）

> 触发：用户要求“请你联网搜索”。上一轮 K4 因工具层无外网，只能基于标准框架+datasheet 常识整理；本轮实际打通网络并完成核对。
> 结论先行：**联网成功**。`web_search`/`web_fetch` 工具仍被限制（无 API key / 策略拦截），但 **bash + curl 可直连公网**；已抓取 IPC 官方目录、TI app note、Espressif 硬件设计指南、JLCPCB 能力表等 14 个来源，并把“已核对事实”回写知识库。

## 1. 检索过程（可复现）

| 步骤 | 操作 | 结果 |
|---|---|---|
| 1 | `web_search`（3 组查询） | 失败：`DeepSeek search has no API key for "DEEPSEEK_API_KEY"` |
| 2 | `web_fetch`（Wikipedia/ipc.org） | 失败：`URL hostname ... resolves to a non-public IP address` |
| 3 | `curl https://example.com` | **HTTP 200**，确认 shell 有出网能力 |
| 4 | `curl html.duckduckgo.com` | 被反爬验证码拦截 |
| 5 | `curl search.brave.com` | 前几轮可用，后续触发 captcha；用首批结果拿到入口链接 |
| 6 | 直接抓取官方/厂商 URL（PDF/HTML） | 成功；PDF 用 `pdftotext` 提取正文 |
| 7 | 交叉核对（14 个来源） | 见 §2；关键数值至少 1 个一手来源 + 1 个二手解读 |

说明：搜索引擎只用于“找入口”，**所有引用结论都回到原始页面/PDF 核对**；搜索引擎摘要不作为证据。

## 2. 已核对来源与关键发现

| # | 来源 | 类型 | 关键发现（已回写知识库） |
|---|---|---|---|
| 1 | [IPC-2221A 官方目录](https://www.electronics.org/TOC/IPC-2221A.pdf) | IPC 官方 TOC | §8.1 General Placement Requirements，下设 8.1.1 自动装配、8.1.2 摆位、8.1.3 朝向、8.1.4 可达性、8.1.5 设计包络、8.1.6 本体居中、8.1.7 跨导电区安装、8.1.8 间隙、8.1.9 物理支撑、8.1.10 散热、8.1.11 应力释放；§5.4.2、§8.2.5、Figure 7-1、Table 6-1 |
| 2 | [IPC-7351B 官方目录](https://www.electronics.org/TOC/IPC-7351B.pdf) | IPC 官方 TOC | §3.4.1 Component Spacing、§3.4.2 单/双面装配、§3.4.3 清洗离地高度、§3.4.4 Fiducial、§7.3 Component Placement；前言 Note 2：courtyard 以**回流焊**为基准，波峰焊需调整 |
| 3 | [IPC-2222A 官方目录](https://www.electronics.org/TOC/IPC-2222A.pdf) | IPC 官方 TOC | §8 Component and Assembly Issues、§9.1.3 Clearance Area in Planes、Table 9-1 |
| 4 | [IPC-2226A 官方目录](https://www.electronics.org/TOC/IPC-2226A.pdf) | IPC 官方 TOC | HDI 结构章节（多层/HDI 引用入口） |
| 5 | [TI SLUA383](https://www.ti.com/lit/an/slua383/slua383.pdf) | 厂商 app note | 去耦靠 IC、走线最短/等长同向、VSS 就近过孔；ESD 二极管靠连接器、地回流到 Pack−；模拟/数字地分开、开尔文采样 |
| 6 | [TI SPRABV2](https://www.ti.com/lit/pdf/sprabv2) | 厂商 app note | 每个电源引脚附近 0.1 µF（最小封装）；细间距 BGA 两球共享过孔把电容放器件下方；模拟/PLL 磁珠隔离；约每 10 个电源引脚 ≥15 µF 体电容 |
| 7 | [TI SLAA920](https://www.ti.com/lit/an/slaa920/slaa920.pdf) | 厂商 app note | 引脚到去耦电容寄生电感上限 **100/150/200/500 pH**（按引脚）；电容与器件**同层**；过孔贴焊盘 |
| 8 | [TI AN-1149 / SNVA021C](https://www.ti.com/lit/an/snva021c/snva021c.pdf) | 厂商 app note | 输入陶瓷电容贴 VIN；输入/输出电容/电感/二极管彼此靠近并就近接地平面；反馈远离电感与噪声功率线 |
| 9 | [Espressif ESP32-S3 PCB Layout](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/pcb-layout-design.html) | 厂商硬件指南 | 推荐 4 层、RF/晶振/芯片下完整 GND；晶振距时钟引脚 **≥2.0 mm**、时钟线地孔 stitching、顶层地足够时晶振周围 keepout；整机外壳内天线各方向净空 **≥15 mm**；电源入口 10 µF+0.1/1 µF 星形；芯片地焊盘 ≥9 地孔 |
| 10 | [JLCPCB PCB 能力表](https://jlcpcb.com/capabilities/pcb-capabilities) | 板厂能力 | 多层最小线宽/间距 0.09 mm；BGA 焊盘到走线 ≥0.1 mm（多层 0.09 mm）；V-CUT 铜避让 ≥0.4 mm；工艺边 ≥3 mm（SMT 建议 5 mm）+2 mm 工艺孔+1 mm Mark（中心距边 3.85 mm）；邮票孔 0.5–0.8 mm、孔距 0.2–0.3 mm、连接筋 ≥4 mm |
| 11 | [JLCPCB 贴装能力表](https://jlcpcb.com/capabilities/pcb-assembly-capabilities) | 贴片厂能力 | 最小封装 0402/01005；最小 IC 间距 0.4/0.35 mm；BGA 0.5/0.3 mm；高级服务需 fiducials/工艺边 |
| 12 | [JLCPCB 布局指南](https://jlcpcb.com/blog/pcb-component-placement-guide-2026) | 工艺文章 | 布局顺序、去耦贴引脚（走线增加电感）、功能分区、3W 与完整地平面 |
| 13 | [Sierra Circuits IPC-2221 解读](https://www.protoexpress.com/blog/ipc-2221-circuit-board-design/) | 标准解读 | IPC-2221 覆盖 placement/间距/热/DFM/DFA/DFT；元件引线/安装硬件间隙要求 |
| 14 | [bestpcbs IPC-7351 解读](https://www.bestpcbs.com/blog/2026/09/ipc-7351/) | 标准解读 | courtyard=器件包络+工艺余量；**无万能间距值**；每边 0.25 mm 只是示例；courtyard 检查不替代铜间距/绝缘/工具空间 |

## 3. 知识库变更

### 3.1 文档

`docs/knowledge/pcb/08-component-placement.md`：290 → **337 行**

- 顶部可信度声明改为“已联网核对”，区分三类标注；
- KP-137/138 增加 IPC-2221A §8.1.1–8.1.11 官方条款；
- KP-139 增加 IPC-7351B §3.4.1/§3.4.2/§3.4.4/§7.3 与“courtyard 以回流焊为基准”；
- KP-144 增加 TI 100–500 pH、同层、过孔贴焊盘；
- KP-145 增加 Espressif 晶振 ≥2.0 mm、完整 GND、keepout 条件；
- KP-146 增加 TI AN-1149 输入电容/反馈/功率回路；
- KP-148 增加整机天线净空 ≥15 mm；
- KP-151 修正“0.25 mm/边不是标准默认值”；
- KP-153 增加 JLCPCB V-CUT/工艺边/Mark/邮票孔数值；
- KP-155 增加 SMT Mark/工艺孔要求；
- 新增 §7“可信度、来源与联网核对记录”：检索方法、14 个来源表、7 条结论修正、仍未核对项、使用规则；
- 评审清单新增 4 条（IPC 条款、寄生电感、晶振 2.0 mm、天线 15 mm）。

### 3.2 新增规则（4 条，全部 candidate + reference）

| ruleId | 标题 | 关键判据 |
|---|---|---|
| `PCB-RULE-PLACE-PARASITIC-001` | 去耦以寄生电感为判据（TI 100–500 pH） | 引脚-电容 pH、同层、过孔贴焊盘、0.1 µF 最小封装 |
| `PCB-RULE-PLACE-CRYSTAL-GAP-001` | 晶振距时钟引脚 ≥2.0 mm、完整 GND、地孔围栏 | 2.0 mm、GND 平面、stitching、按需 keepout |
| `PCB-RULE-PLACE-ANTENNA-15MM-001` | 整机天线净空 ≥15 mm | 外壳内各方向 15 mm、四边掏空、铺地打孔、整机吞吐/距离测试 |
| `PCB-RULE-PLACE-PANEL-001` | 拼板/板边按板厂能力 | V-CUT 0.4 mm、工艺边 3/5 mm、Mark 1 mm@3.85 mm、邮票孔 0.5–0.8 mm、连接筋 4 mm |

数据集：**177 → 181 条**（rule 73 → 77；module 48、part 27、failure 29 不变）。

## 4. 验证结果

| 验证 | 结果 |
|---|---|
| 数据集自检 | **181 条，0 problems** |
| 单元/回归测试 | `knowledge-pcb-seed` 3/3 通过（阈值已同步 ≥180） |
| RAG 评估 | **Pass：39/39 Hit@1，MRR=1.0**；371 docs / 2414 chunks / 59530 terms |
| 仓库灌库 | created 4 / duplicate 177 / errors 0；仓库知识库 270 → **274 条** |
| 运行中的应用 | 280 → **284 条**（rule 87 · module 86 · part 63 · failure 48），全部 candidate；RAG 381 docs / 2430 chunks |
| 应用内实测检索 | “去耦 寄生电感 100pH 同层”“晶振 2.0mm 时钟引脚 地孔围栏”“天线 净空 15mm 整机 外壳”“拼板 V-CUT 3.85mm”均命中新规则/文档 |

## 5. 未解决/边界

1. **IPC 正文未购买**：只核对官方免费目录的条款号与标题，未抄录正文数值；IPC 相关的具体毫米值仍需按正文/项目标准复核。
2. **J-STD-020、IPC-7093、IPC-A-610/J-STD-001** 本期未抓到官方可引用页面，相关条目仍按通用框架表述。
3. **市场拆解未做**：消费/工业成品布局仍为 D 级证据；未做实物拆解/照片核对。
4. **数值的器件/厂商边界**：TI pH、Espressif 2.0 mm/15 mm、JLCPCB 0.09 mm/0.4 mm 等均绑定其器件/工艺，迁移必须重查对应 datasheet/能力表。
5. **搜索引擎反爬**：Brave 后续触发 captcha、Google/Startpage 为 JS 页、Bing 结果质量差；本次靠直接抓取官方 URL 完成核对，后续可优先用已知官方入口。

## 6. 变更文件

- `docs/knowledge/pcb/08-component-placement.md`（337 行，新增 §7 来源表与核对结论）
- `knowledge/pcb/dataset/rules.json`（+4 条，77 条）
- `runtime/__tests__/knowledge-pcb-seed.test.mjs`（阈值 ≥180）
- `scripts/verify-rag.mjs`（+4 条 golden query，共 39）
- `docs/knowledge/README.md`（38 篇 / 6599 行 / 540 KP；结构化 181 条）
- `docs/implementation/placement-basis-k4-2026-10-22.md`（K4 基线，保留）
- `docs/implementation/placement-web-verification-k5-2026-10-22.md`（本报告）
- `artifacts/evidence/knowledge/knowledge-2026-10-22T05-25-52-255Z-*.json`（RAG 评估证据）
