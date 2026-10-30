# 全链路进度（2026-10-21 13:00 更新）

## 已完成
1. 需求/图纸 → AI 对话 12 轮（页面原生发送，records/APP-PAGE-CONVERSATION-12TURNS.md）
2. AI 选型 BOM（主板 25 行 + 按键灯板 11 行，33 行 LCSC 已核验）
3. 单一运行时（127.0.0.1:4178），模型 deepseek-v4-flash
4. 新工程「衣橱助手V2.0-AI设计」(uuid ba4924190e3a4388a097f3dee090da20)：
   - 原理图 497616c287ca5819 / 页 87dba2a22fe7096e —— 已落 64 件主板组件并回填位号
   - PCB 5595e77cead09682 / Board1_1 —— 已建，4 层铜
   - 证据：records/eda-schematic-64components-20261021.png、records/eda-pcb-4layer-20261021.png
   - 组件清单：design/fresh-schematic-mainboard-components.csv
5. 第一版网络意图：design/net-intent-first-pass.json（14 个网，待写入）

## 阻塞（下一步）
- 运行时 net-connect 需先有网表基线：现返回 EDA_NETLIST_EMPTY；createNetPort 可建但网表未收敛；createNetFlag 超时
- PCB importChanges：`Cannot read properties of undefined (reading 'schemaId')`，PCB 仍 0 封装
- 待做：板框(DXF) → 布局 → 布线 → DRC → 仿真 → 3D STEP → Gerber/BOM/CPL → DFM/放行

## 关键事实
- EDA bridge: http://127.0.0.1:49620（window 0edf58df-3569-4f99-b58c-49e85eb0fff1）
- 组件创建：每件约 1.5–6s；重件（ESP32 模块等）首件约 38s；批量 >110s 会触发 bridge 超时
- 屏幕必须保持唤醒（caffeinate -dims），否则 EDA 断连
- 待补料号替代：SS34→C49861250，5.1kΩ→C25905，650Ω→C82294（需签核）
