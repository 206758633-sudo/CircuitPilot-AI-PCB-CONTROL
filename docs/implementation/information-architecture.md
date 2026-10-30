# CircuitPilot 信息架构（D6）

> 单一事实源：`src/navigation.ts`（导航项 / 页面职责 / 旧 hash 别名 / 新手完整链路）。
> 由 `src/services/__tests__/navigation.test.ts` 守护一致性；本文件是给人看的说明，代码是权威。

## 1. 规范页面与职责

| 页面 | 入口 | 回答的问题 | 主操作 | 交接 |
|---|---|---|---|---|
| 概览 `overview` | 主导航① | 我现在该做什么？ | 继续完善约束 | 交接「AI 设计」补输入；最终落到受控写入与验证 |
| 项目与工程资料 `projects` | 左上角项目卡 / 概览按钮 | 我在为哪个项目干活？ | 打开当前项目 | 切换项目改变全局上下文；多项目隔离见 C6 |
| AI 设计 `design` | 主导航② | 需求/选型/原理图方案由什么证据支撑？ | 让 AI 追问补全 | 方案确定交「EDA 执行」受控写入，写板前人工批准 |
| EDA 执行 `eda` | 主导航③ | 这次写入的批准、回读和回滚边界在哪？ | 打开 EDA 执行 | 结果/证据回流验证与追溯；写板不可绕过批准 |
| 自动化 `automation` | 主导航④ | 这条链路是否可重放、可诊断、可回滚？ | 打开自动化中心 | 批量/跨文档动作用配方，而不是散点点击 |
| 验证与交付 `validation` | 主导航⑤ | 能不能交付？缺哪份证据？ | 打开验证与交付 | 问题进问题中心，可转修复任务回 AI 设计 |
| 版本与问题 `versions` | 主导航⑥ | 谁在什么时候改了什么、证据在哪？ | 打开版本与问题 | 追溯只读；结论以 Runtime 账本/证据为准 |
| 系统设置 `settings` | 侧边栏底部 / 命令面板 | AI 与 Runtime 是否连对、写入门禁是否合理？ | 打开系统设置 | 密钥只进 keychain；日志/诊断包脱敏（C8） |

旧页面（`requirements`/`assets`/`proposal`/`ai`/`placement`）**不再单独占导航**，全部并入上表的页签：

| 旧入口 | 归并位置 | 说明 |
|---|---|---|
| `#requirements` | `#design/req` | 需求约束页签 |
| `#assets` | `#design/assets` | 元件与资料页签 |
| `#proposal` | `#design/select` | 选型计划页签 |
| `#ai` | `#design/chat` | 对话式设计页签（`AiTasksPage` 不再单独路由） |
| `#placement` | `#validation/placement` | 布局/布线写回页签 |

旧 hash 作为别名保留（历史书签/外链不失效），但**别名只能解析到规范页面**，不允许指回自己形成环（测试守护）。

## 2. 新手完整链路（概览页可直接点击）

概览页「从零到交付的完整链路」面板由 `GUIDED_FLOW` 渲染，顺序与阶段机（`STAGE_ORDER`）一致：

1. **需求约束** `#design/req`：口语需求 → 可验证受控约束，冲突先裁决。
2. **元件选型** `#design/select`：需求换真实候选，人工确认后写进当前项目。
3. **原理图方案** `#design/chat`：AI 生成/编辑方案；写板前先计划与批准。
4. **受控写入** `#eda`：快照 → 批准 → 回读 → 可回滚；写板批准一次一用。
5. **布局布线** `#validation/placement`：R4 布局写回 / R5 布线写入与收尾（重建铺铜+保存），均带回滚点。
6. **验证检查** `#validation/verify`：ERC/DRC/DFM 统一运行，问题进问题中心。
7. **交付导出** `#validation/verify`：跑放行闸门、导出制造包（未过门禁只能出草稿）、登记签核/下单参数。
8. **追溯归档** `#versions`：统一证据时间线/变更/发布归档核对；导出与签核在「验证与交付」页完成，本页只做追溯。

> 2026-10-20 修正：旧版把第 7 步「交付追溯」指向 `#versions`，但真实导出/放行/签核入口在「验证与交付」页，
> 按链路走到最后找不到交付操作。现拆为「交付导出（validation）」+「追溯归档（versions）」两步，并由
> `navigation.test.ts` 断言交付步骤必须落在有导出能力的页面。

## 3. 导航与路由规则

- 主导航 6 项：概览、AI 设计、EDA 执行、自动化、验证与交付、版本与问题；系统设置与项目页不占主导航位置（分别是侧边栏底部与左上角项目卡）。
- 规范 hash：`#overview`、`#design/chat|req|select|assets`、`#eda`、`#automation`、`#validation/verify|placement|rules`、`#versions`、`#settings`、`#projects`。
- 默认页签保持短 hash（`#design` = chat、`#validation` = verify），其余页签输出 `#page/tab`。
- `navigate(page, tab?)` 统一走 hash 路由；页面不再各自改 `window.location.hash`。

## 4. 测试与验收

- `navigation.test.ts` 4/4：页面职责全覆盖、导航项唯一且与规范页面集合一致、旧别名全部落规范页面且不指回自己、链路顺序与阶段机一致。
- e2e `app.spec.ts` 30/30（含六页面导航/恢复 Hash/Demo 边界）。
- 用户走查前的已知边界：概览链路是"导航引导"，不会替用户自动推进阶段；阶段推进仍由阶段机证据门禁（D5）决定。
