# 嘉立创EDA 扩展市场管家 Agent —— 可行性评估与设计裁决

- 评估对象：用户提出的「在 CircuitPilot 中新建一个 agent 管理嘉立创EDA拓展市场，实时抓取/读取扩展功能；若与 AI 设计 PCB 需求相关，自动下载并实时更新版本；并告知其他 AI agent 可以调用哪些扩展功能」
- 评估方式：三路只读侦察（市场 API / 本机落盘 / 现有架构）+ 只读 MVP 落地验证
- 证据目录：[docs/design/extension-market/recon.md](recon.md)、[local-probe.md](local-probe.md)、[integration.md](integration.md)、[artifacts/ext-market/](../../../artifacts/ext-market/)
- 时间：2026-10-23；EDA 版本 3.2.186.b52e3e87

---

## 0. 结论先行

**方向有价值，但不能按原话做。**

| 维度 | 判定 | 一句话理由 |
| --- | --- | --- |
| 读取扩展清单（本机已装） | ✅ 可行，但通道脆弱 | 不在明文目录，在 Electron IndexedDB（LevelDB+snappy+V8）；已只读跑通 46 条 |
| 读取扩展市场（线上） | ✅ 可行且成本低 | `pro.lceda.cn/api/extensions/editor/search` 匿名公开，235 个扩展、12 页、28 字段 |
| 判断“与 AI 设计 PCB 需求相关” | ⚠️ 可做但只能做“推荐” | 标签/打分可确定复现；但“相关”不等于“可被 agent 调用” |
| 自动下载 + 实时更新 | ❌ 首版不应做 | `.eext` 无验签 → 扩展在 EDA 主进程跑任意 JS；静默更新会击穿“已验证”语义 |
| 告知其他 AI agent 可用能力 | ✅ 最有价值、应优先做 | 已有 prompt 注入点；但必须防“模型声称已调用扩展”的幻觉 |
| 作为一个“带写权限的 manager agent” | ❌ 物理不可能 | `runtime/agents/agent-contract.mjs:23` 对 `readOnly!==true` 直接抛 `AGENT_NOT_READONLY` |

**评分（10 分制）**

- 只读“扩展能力目录 + 公告板 + 受控安装建议”：**8/10**（价值明确、可落地、风险可控）
- 按用户原话的“自动下载 + 实时更新 + 全自动告知”：**4/10**（技术可行，但供应链/合规/可复现性三项硬伤）
- 工程成本：P0（只读 MVP）≈ 1–2 人日；P1（接 server/prompt/UI）≈ 3–5 人日；P2（受控安装）≈ 2 周+，且需产品接受“安装会新建临时沙箱工程”。

**建议裁决：做成“扩展能力注册 Agent（只读）+ 能力公告板 + 受控安装器（默认关、人工审批）”，首版不做自动安装。**

---

## 1. 需求拆解：四件事，四种命运

### 1.1 “实时抓取/读取扩展功能”

- **市场侧**：公开 JSON API，动态接口（单次 1.5–3.5s），235 个扩展全量 12 页约 20s；逐条 detail（235×1.5s≈6min）不可取。因此“实时”只能是**按需刷新 + 30min 缓存**，不是秒级轮询。
- **本机侧**：已装清单在 `~/.config/LCEDA-Pro/cache.arm64.3/IndexedDB/https_pro.lceda.cn_0.indexeddb.leveldb`，库 `User_<userUuid>_v6`、仓库 `extensionsIndex`。可以 `fs.watch` + 30s 轮询做“准实时”，但解析属于逆向内部存储：v1 提取器未按 LevelDB sequence 合并，46 条里**含历史记录**（例：`Run API Gateway` 读到 1.0.5，log 里已 1.0.6）。必须做 seq/tombstone 合并后才可当“当前已装集合”。
- 结论：**“实时”应定义为“打开面板/对话时按需刷新，后台 30min 一次，变更即广播”，而不是持续抓取。**

### 1.2 “如果跟 AI 设计 PCB 需求相关”

“相关”可以计算（标签词表 + 打分 + EDA 版本兼容过滤），但必须承认两件事：

1. **扩展能力大多数是 GUI 菜单，不是可编程 API。** 本机 46 个扩展里，能力入口基本都是 `headerMenus` 菜单项；CircuitPilot 桥接命令表 80 条中扩展相关为 **0**，pro-api 也不向其它扩展暴露扩展管理器。因此“告诉 agent 有哪些扩展”只能产出**工具线索**，不能产出“可直接调用的函数”。
2. **“相关”不等于“安全/兼容/已验证”。** 兼容要按 `engines.eda` semver 判定（市场详情/版本历史接口提供）；已验证要真机探到入口；两者都缺时只能标 `unverified`，不能推荐。

### 1.3 “自动下载并实时更新版本”

这是原方案里唯一**必须否决**的部分，理由不是“做不到”，而是“做了会破坏 CircuitPilot 的安全模型”：

- **无验签**：对 `pro-api/api.js` 检索 `signature|verifySign|checksum`，只命中 JSZip 内部实现；`importExtensionPackages → yc()` 路径没有 `.eext` 签名/hash 校验。扩展在 EDA 主进程内执行任意 JS，等于**任意代码执行**。
- **服务端可“指令式自动安装”**：客户端存在 `config.autoInstall==="ON"` → 静默 `action:"autoInstall"` 的链路，并可同时下发 `autoUpdate` / `allowExternalInteraction`。这属于登录态行为（匿名响应无 `config`），但一旦我们做“自动安装”，等于把这套不可见的服务端策略放大到 CircuitPilot。
- **静默更新击穿“已验证”语义**：今天公告板说“某扩展 v1.4.2 在本机验证过”，明天它静默变 v1.5.0，能力/入口/副作用全变，用户却不知情。
- 项目自身的纪律也是“写动作必须人工批准 + 证据 + 可回滚”（法规/DFM/放行全链路如此），自动安装与这条纪律直接冲突。

结论：**首版只做“发现 + 推荐 + 一键人工安装入口（跳转/引导）”；下载/安装/回滚是独立的、审批绑定的、可回滚的 v2 能力，默认关闭。**

### 1.4 “告知其他 AI agent 可以调用哪些扩展”

这是**性价比最高**的一环，且已有落点：

- `runtime/chat.mjs` 的对话/计划/网表三条链路都把“EDA 只读证据”塞进 prompt；新增一段有界的能力公告板片段即可（`chat.mjs:616-619` 已有动态拼 instructions 的先例）。
- 但必须固定免责与边界：**“菜单入口 ≠ 可编程调用”**，片段里不得出现 uuid/路径/下载 URL，模型不得声称“已调用/已成功”。
- 检索用确定性标签 + 打分 + token 三档裁剪，保证同一输入 prompt 不抖动（digest 稳定）。

---

## 2. 现场证据（真机实测）

### 2.1 市场通道：匿名公开 GET（recon）

```bash
GET https://pro.lceda.cn/api/extensions/editor/search?page=1&pageSize=20
→ 200 {"success":true,"code":0,"result":{"page":1,"pageSize":20,"total":235,"totalPage":12,"lists":[...]}}
```

- 无需登录/cookie/token；`pageSize` 测到 100；`keywords` 是真实搜索参数（`keywords=agent` → total=5）；`category` 匿名无效。
- 列表 28 字段：`uuid/name/display_name/version/publisher/install_num/average_score/file_path/updated_at/...`。
- 详情 `GET /api/extensions/detail?uuid=&version=` 补 `engines.eda/categories/keywords/change_log/readme`；版本历史 `GET /api/extensions/editor/his_version_list?uuid=` 返回每版 `{version,engines.eda,file_path,change_log}`。
- 安装 = detail 取 `file_path` → 匿名 GET `https://image.lceda.cn/extensions/files/<hash>.eext` → 内部 RPC `importExtensionPackages` 写入 IndexedDB。
- 自动更新只在**登录钩子**跑一次全量检查，静默升级需 `isNeedUpdate && latestVersion && isAutoUpdate && downloadFilePath` 同时成立；`isAutoUpdate` 默认 false，样例 `extension.json` 无该键。
- ⚠️ 合规未闭环：robots 允许、未见限流，但服务条款正文是 SPA、取不到 → **“是否违反 ToS”未验证**，需人工/法务确认后再决定市场源是否默认开启。

### 2.2 本机通道：IndexedDB（local-probe）

```
~/.config/LCEDA-Pro/cache.arm64.3/IndexedDB/https_pro.lceda.cn_0.indexeddb.leveldb
  DB: User_<userUuid>_v6
  store: extensionsIndex (keyPath=uuid) / extensionsObjectStorage / extensionsUserConfig
```

- 46 条记录字段：uuid / config.{name,displayName,version,publisher,license,engines,homepage,keywords,categories} / fileSize / installationTime / isEnable / isShowAtHeaderMenu / isAutoUpdate / isInExtensionStore。
- 与截图吻合：格式转换 1.8.29、AI巧绘 1.0.8、电源地就近打孔 0.6.3、设计规则生成器 1.8.2、PCBTrans CSV 绕组导入 0.1.5 等。
- 桥接读不到（COMMANDS 0 条扩展相关；pro-api 只给扩展自身 uuid + SYS_Storage）；CDP 9222 实际开着，但读 IndexedDB 需要 `Runtime.evaluate` 注入，不能算只读。
- 失败模式：EDA 运行时 LevelDB 有 LOCK，只能读字节不能开库；卸载记录的 tombstone 不处理会把历史当“已装”；按账号切库（`User_<uuid>`）。

### 2.3 现有架构约束（integration）

- `defineAgent` 强制 `readOnly:true`；现有 4 个 verifier agent **没有 HTTP 暴露**，真正的“agent + 路由”样板是 KMA（`knowledge/agent/status|run`）。
- 证据契约 fail-closed：`subject.type` 白名单 7 项，新增扩展证据要加 `'extension'`；`EVIDENCE_KINDS` 加项会顺带扩宽 `design-spec` 白名单（需知情）。
- 门禁陷阱：`unknown` 证据塞进 `runDesignPipeline` 会把整条流水线判 unknown；把扩展能力加进 `PCB_GATES` 会让存量签字全被拒。**扩展证据只能 `advisory`，且不进 `PIPELINE_STEPS`/`PCB_GATES`**。
- 安装审批复用 `createApprovalService` 的 `scope:'write'` + `bindings.kind:'extension-install'`，不要新增 ledger scope。

---

## 3. 正确的 Agent 形态（设计裁决）

**一句话：拆成两层，只读层进 agent 体系，写层不进。**

```
┌──────────────────────────────────────────────────────────────┐
│ extension-registry（只读 agent，defineAgent，30s）            │
│  providers: local-snapshot / market-api / (bridge 预留)       │
│  → capability cards → 打分裁剪 → 公告板 + prompt 片段          │
│  evidence: kind=extension-inventory, verdict=advisory         │
└───────────────┬──────────────────────────────────────────────┘
                │ 只读
   ┌────────────┴─────────────┐
   │ /api/extensions/*（10 条）│→ chat / 计划生成器 / EdaPage / Settings
   └────────────┬─────────────┘
                │ 写（v2，默认关，恒 501）
┌───────────────┴──────────────────────────────────────────────┐
│ ExtensionMarketService（不是 agent）                          │
│  下载→校验(V1–V7)→隔离工程→安装→回读→失败回滚                │
│  一次性审批：uuid+version+artifactDigest+edaVersion+沙箱工程  │
└──────────────────────────────────────────────────────────────┘
```

- **为什么不做一个 manager agent**：`agent-contract.mjs:23` 对非只读直接抛错；且“安装成功”是事实记录，不该用 `verdict:'pass'` 表达。
- **公告板数据模型**（`ExtensionCapability`）：`extensionId/uuid/version/tags/entryPoints/preconditions/sideEffects/installPolicy/compat{edaVersionRange,status}/status/lastVerifiedAt/trust/provenance`。
- **状态机**：`verified → probed → unverified`，加 `stale / incompatible / disabled`；`incompatible/disabled` 硬过滤，`unverified` 默认不进 prompt。
- **检索**：硬过滤（状态/安装策略/标签）+ 加权打分（tag 0.5 / status 0.2 / compat 0.15 / 新鲜度 0.1 / 副作用 0.05），同分按 extensionId 兜底。
- **token 预算**：默认 900、硬顶 1500；`full → compact → id-only` 三档降级，裁剪只影响注入文本、不影响落盘。
- **通知机制**：`revision=sha256(cards)[:16]` 变更广播（轮询零成本）；注入 chat / 计划 / 网表三处消费点；片段固定免责句。

---

## 4. 原方案的问题清单（按严重度）

| # | 问题 | 后果 | 处理 |
| --- | --- | --- | --- |
| 1 | 自动下载/更新无验签扩展 | 任意代码执行；供应链完全交给第三方 | 首版不做；v2 必须审批+摘要+发布者白名单+隔离工程+回滚 |
| 2 | “实时更新”语义 | 静默变更击穿已验证语义；用户不知情 | 只做“提示有更新”，更新动作永远显式 |
| 3 | “可调用”幻觉 | 模型声称调用了扩展，实际只是菜单；用户误以为设计已完成 | 能力卡区分 `menu / market / command`；prompt 明确“不能直接调用” |
| 4 | 本机清单靠逆向 IndexedDB | EDA 升级即碎；历史记录混入；运行中锁库 | provider 抽象 + degraded 标注 + 快照可替换；不把“读不到”当“没有” |
| 5 | 市场抓取合规未闭环 | ToS 风险 | 市场源默认关；法务确认后再开；限速+缓存 |
| 6 | 证据污染门禁 | 一条 unknown 让整条流水线 unknown / 签字全拒 | 扩展证据只 advisory；不进 PIPELINE_STEPS / PCB_GATES |
| 7 | prompt 膨胀 | 235 个扩展全塞进去会挤爆上下文 | 标签检索 + 预算裁剪 + `includeUnverified` 开关 |

---

## 5. 已交付的只读 MVP（真机跑通）

为验证“能力公告板”不是纸上设计，本次落了一个可运行的最小实现（不改任何现有 runtime 行为）：

| 文件 | 作用 |
| --- | --- |
| [runtime/agents/extension-registry.mjs](../../../runtime/agents/extension-registry.mjs) | 只读 agent（`defineAgent`，id `extension-registry`，30s，readOnly），provider 失败隔离，全挂 fail-closed |
| [runtime/extension-market/capability-board.mjs](../../../runtime/extension-market/capability-board.mjs) | 归一化 / semver 兼容 / 打分裁剪 / prompt 片段 / revision（纯函数） |
| [runtime/extension-market/tags.mjs](../../../runtime/extension-market/tags.mjs) | 确定性标签词表（不做 LLM 打标） |
| [runtime/extension-market/providers/installed-snapshot.mjs](../../../runtime/extension-market/providers/installed-snapshot.mjs) | 本机快照 provider（明确 degraded） |
| [runtime/extension-market/providers/market-api.mjs](../../../runtime/extension-market/providers/market-api.mjs) | 市场 API provider（匿名 GET、注入 fetch、失败码） |
| [scripts/ext-market-demo.mjs](../../../scripts/ext-market-demo.mjs) | 离线演示：真实 46 条已装记录 → 公告板 + prompt |
| [runtime/__tests__/extension-capability-board.test.mjs](../../../runtime/__tests__/extension-capability-board.test.mjs) | 15 个单测（兼容/去重/预算/确定性/失败隔离） |

**实跑结果**（2026-10-23，真实快照）：

```
provider: local-installed=ok
能力卡 46 张；选中 17 张；revision=7f9fd1035695873b
预算 504/900 tokens；提示词 17 条
Top: PCBTrans CSV 绕组导入 / 电源地就近打孔 / 原理图引脚网络扇出 / 原理图PCBAI-Agent / 铜路卫士…
```

产物：`artifacts/ext-market/capability-board.json`、`prompt-snippet.txt`。

**已知局限（必须如实说）**

- 快照 v1 未做 LevelDB sequence/tombstone 合并 → 46 条**可能含历史记录**，只能证明“链路可行”，不能当“当前已装集合”。
- 本机 Node `fetch` 访问 `pro.lceda.cn` 间歇性 10s 连接超时（同机 curl 可 200）→ 演示中市场源按设计降级为 `EXT_SOURCE_UNAVAILABLE`，不影响本机清单；这是**失败隔离**的实证，不是“市场接口不可用”。
- 未接 `server.mjs` 路由、未改 prompt、未做 UI —— 这些属于 P1，设计见 integration.md §3/§7（10 条路由、3 处注入、9 处加法改动、明确不改清单）。

---

## 6. 分阶段路线图

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0（本次已完成）** | 只读 agent + 能力公告板 + prompt 片段 + 单测 | 15 测试全绿；真实 46 条跑通；无现有行为改动 |
| **P1（建议下一步）** | 接 `/api/extensions/*` 10 条路由；chat/计划注入；EdaPage 只读面板；Settings 三开关；证据 kind/subject 加法 | 断网仍返回本机清单；同输入 revision 稳定；prompt 无 uuid/URL；route-contract 全绿 |
| **P2（需产品决策）** | 市场 provider 打开（ToS 确认后）、按需 detail 补 `engines.eda`、更新提示（只提示不自动） | 235 条全量刷新 ≤ 30s；更新提示与客户端判定一致（status=1 + semver + engines） |
| **P3（v2，可选）** | 受控安装/回滚：一次性审批（10 字段绑定）、V1–V7 硬门、隔离沙箱工程、回读校验、审计 | 未审批恒 501；摘要不符拒绝；失败可回滚；沙箱工程可清理 |
| **永不做（建议）** | 静默自动更新；无审批自动安装；把扩展能力当“可编程工具”直接暴露给模型 | — |

---

## 7. 最终评价（直说）

**这个 agent 值得做，但要“降级”做。**

- 它的真实价值不在“自动装插件”，而在**把 EDA 生态里现成的能力变成 CircuitPilot 其它 agent 可检索、可审计的“工具线索”**。本机已经有 46 个扩展（AI 设计助手、设计规则生成器、绕组导入、电源打孔、载流助手、仿真、BOM/器件库……），这些能力现在对 CircuitPilot 的 AI 完全不可见——把“不可见”变成“可检索 + 带免责”，就是最大的增量。
- 它的真正风险也不在“抓不到数据”，而在**把第三方代码的执行权交给自动化**。`.eext` 无验签 + 服务端可下发 autoInstall，这两条决定了“自动下载/更新”只能是人工审批下的 v2，不能是默认能力。
- 数据通道的现实是：市场 API 靠谱（公开、稳定、字段全），本机 IndexedDB 脆弱（逆向、锁库、历史记录）。所以架构上必须 provider 化、失败隔离、`degraded` 如实上报——**宁可少推荐，也不推错**。
- 一句话：**把它做成“扩展能力目录 agent”，评分 8/10；按原话做成“自动装插件 agent”，评分 4/10。** 建议按前者推进，先接 P1，再谈 P3。
