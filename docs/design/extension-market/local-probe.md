# 本机已装扩展清单 · 只读实地勘察报告（local-probe）

- 任务：task-2「侦察：本机已安装扩展的实时读取与桥接能力盘点」
- 执行人：teammate `local-probe`
- 探测时间：2026-10-23 16:11–16:21 (+08:00)
- 主机：macOS，EasyEDA Pro 3.2.186 (`JLCEDAPro/3.2.186.b52e3e87`, Electron 36.3.2 / Chrome 136.0.7103.115)
- 纪律：**全程只读**。未安装/卸载扩展，未写入 EasyEDA 任何数据目录，未向 EDA 注入任何代码（未使用 CDP `Runtime.evaluate`）。

证据文件（全部为真机实测产物）：见 `artifacts/ext-market/`（`installed-extensions.json`、`dir-tree.txt`、`web-db-schema.sql`、`web-db-tables.txt`、`health.json`、`cdp-version.json`、`cdp-targets.json`、`DevToolsActivePort.txt`、`installed-extensions.json`、`probe/extract-registry-v1.mjs`）。

---

## 0. 结论先行（TL;DR）

| 问题 | 结论 |
|---|---|
| 扩展清单有没有普通 JSON 落盘（如 `extension.json` / `*.eext` / `extensions/` 目录）？ | **没有**。数据目录与 Electron userData 里都找不到扩展清单文件；`~/Documents/LCEDA-Pro` 下只有 config/database/libraries/projects/logs。 |
| 那清单在哪？ | 在 **Electron 渲染进程的 IndexedDB** 里：`~/.config/LCEDA-Pro/cache.arm64.3/IndexedDB/https_pro.lceda.cn_0.indexeddb.leveldb`，数据库名 `User_<userUuid>_v6`（本机实测 `User_8403292ee0024153a2774b76157fbf42_v6`），对象仓库 `extensionsIndex`（keyPath=`uuid`）/`extensionsObjectStorage`/`extensionsUserConfig`/`standaloneScript`。 |
| 字段拿全了吗？ | **拿到了**：uuid / id / displayName / version / publisher / license / engines / homepage / fileSize / installationTime / isEnable / isShowAtHeaderMenu / isAutoUpdate / isInExtensionStore。已落 `artifacts/ext-market/installed-extensions.json`（46 条，含完整 config 原文 `rawRecords`）。 |
| 桥接扩展（`eda.*` / pro-api）能直接读扩展清单吗？ | **不能**。pro-api 只给扩展自己的 `extensionUuid` 与 `SYS_Storage`（仅自身配置）；`runtime/bridge.mjs` 的 80 条 COMMANDS 里没有任何 extension/plugin/market 命令。 |
| 实时性方案 | **文件监听可行**（可 `fs.watch` leveldb 目录）。实测该目录随使用持续变化（`000063.log` 10-23 16:04 仍在写）。建议 `fs.watch` + 30s 兜底轮询。 |
| 主要风险 | ① 需要自己实现 LevelDB(snappy)+V8 structured-clone 解码；② EDA 运行中 leveldb 处于 LOCK 状态，只能读字节、不能开库；③ 记录删除（卸载）需要按 sequence number 合并 WAL/ldb，否则会把历史记录当"已安装"（本次 v1 提取即有此问题）；④ 清单按账号（`User_<uuid>`）隔离，换账号/未登录会切库。 |

**可行性判定：可行（读取层面已跑通），但属于"逆向内部存储"路径，不是官方接口；实时性用文件监听 + 低频轮询最稳。**

---

## 1. 落盘位置：真实目录树

### 1.1 应用包（只读，装什么版本、有没有内置扩展）

```
/Applications/嘉立创EDA(专业版).app/Contents/Resources/app/
├── app.js                      # Electron 主进程（2.6MB，已确认 userData 计算逻辑）
├── package.json                # name=client.pro.lceda.cn, version=3.2.186.b52e3e87
├── version.txt                 # 3.2.186.b52e3e87.3e236c, 08/21/2026
├── editor.ini
└── assets/
    ├── pro-api/0.3.18.0bc12bb0/     # ★ 扩展 API 包（含 extension.json 样例 + api-types.d.ts）
    │   ├── extension.json           # ← 唯一真实存在的 extension.json（pro-api 自身，非已装扩展）
    │   ├── api.js / api.d.ts / api-types.d.ts / api-types.js
    ├── db/                          # lceda-std.elib(461MB) + example-projects.zip
    ├── pro-ui/3.2.181.db96fbff/js/ui.js   # 扩展管理器 UI（导入 .eext / 卸载 / 下载）
    ├── pro-sw/ pro-mgr/ pro-panel/ pro-pcb/ pro-sch/ pro-chat/ pro-versions/ locale/ …
```

`assets/pro-api/0.3.18.0bc12bb0/extension.json`（**真实字段样例**，可作 manifest 参考）：

```json
{
  "services": { "default": ["/api.js"], "sch": ["/api.js"], "symbol": ["/api.js"],
                "pcb": ["/api.js"], "panel": ["/api.js"] },
  "name": "pro-api", "version": "0.3.18",
  "files": { "/api.d.ts": "465f4183…", "/api.js": "885e0595…" },
  "innerSign": "M1hQAQNAXLno3HugJtX+…"
}
```

> `mdfind "kMDItemFSName == '*.eext'"` 只命中 3 个**用户下载的安装包**，不是已安装态：
> `/Users/jescochen/Downloads/easyeda-agent-connector-1.3.0.eext`、
> `~/Documents/电路板AI设计/worktree/artifacts/extensions/…/freerouting-intergration_v1.7.1_zh-cn.eext`、
> `…/easyeda-agent-v1.2.10/easyeda-agent-connector.eext`。
> `mdfind "kMDItemFSName == 'extension.json'"` 只命中 `~/Downloads/eda-connector/extension.json`（开发中源码）。
> ⇒ **已安装扩展不以 .eext / extension.json 形式留盘。**

### 1.2 数据目录 `~/Documents/LCEDA-Pro`（不含扩展清单）

```
~/Documents/LCEDA-Pro/
├── config.json          # type=ONLINE, APP_PROJECT_DIR, LIB_DIR, ONLINE_BACKUP_DIR…
├── database/web.db      # 1.9MB SQLite，35 张表，全部是工程/器件/会话，无扩展表
├── libraries/lceda-std.elib
├── projects/  example-projects/  online-projects-backup/  projects-recovery/
└── logs/{warn,editor}/  # warn/*.log 里只有 /api/extensions/editor/his_version_list 的 ECONNRESET
                         #   → 证明扩展接口是**线上接口**，本地不做落盘
```

`web.db` 表清单（`artifacts/ext-market/web-db-tables.txt`，完整 DDL 在 `web-db-schema.sql`）：

```
attributes  backups  block_symbol_attributes  boards  branch_locks  branches
broadcast_messages  categories  coppers  db_paths  db_versions  devices
documents  editor_caches  history_data  notifications  project_histories
project_images  project_logs  project_members  project_structures  projects
resources  schematics  sessions  system_attributes  system_config  team_members
texts  users  web_cookies  components  components_tmp  component_histories  project_histories
```

> **`web.db` 中没有 extension / plugin 相关表**（`CREATE TABLE` 35 条已全量核对）。扩展清单不在这里。

### 1.3 Electron userData（真正的扩展注册表所在）

`app.js` 里的路径推导（已从压缩代码中还原）：

```js
Oy = darwin ? path.join(home, '.config') : …      // macOS 走 ~/.config，不是 Application Support
lc = 'LCEDA-Pro'                                  // 产品名（ONLINE 版）
Je = path.join(documents, lc)                     // = ~/Documents/LCEDA-Pro        （数据目录）
jo = path.join(Oy, lc)                            // = ~/.config/LCEDA-Pro
cr = path.join(jo, `cache.${arch}.3`)             // ★ app.setPath('userData', cr)
```

```
~/.config/LCEDA-Pro/
├── cache.model.2/                 # 空
├── updater/                       # 空
└── cache.arm64.3/                 # ★ Electron userData（Chromium profile）
    ├── DevToolsActivePort         # 内容：9222 / /devtools/browser/4a388f93-…（CDP 已开！）
    ├── IndexedDB/
    │   ├── https_pro.lceda.cn_0.indexeddb.leveldb   # ★★ 扩展注册表在这里
    │   │   ├── 000063.log         # 2.1MB WAL，2026-10-23 16:04 仍在写
    │   │   ├── 000065.ldb         # 586KB 已压缩排序表
    │   │   ├── MANIFEST-000001 / CURRENT / LOG / LOCK
    │   ├── https_client_0.indexeddb.leveldb
    │   └── https_passport.jlc.com_0.indexeddb.leveldb
    ├── Local Storage/leveldb/  Session Storage/  Cache/Cache_Data/
    ├── Code Cache/js|wasm/  Service Worker/{CacheStorage,ScriptCache}
    ├── "JLCEDA Pro"/            # 空目录
    └── Preferences  Cookies  DIPS …
```

> ❗ 注意：`~/Library/Application Support/` 下**没有** LCEDA/EasyEDA 目录（实测 `ls | grep -i lceda|easyeda` 无结果）。
> 只有 `~/Library/Application Support/freerouting/freerouting.json`（Freerouting 扩展**自己**的配置，不是清单）。

---

## 2. 扩展注册表：存储格式与字段

### 2.1 数据库 / 对象仓库结构（从 pro-api 源码还原，已与实测数据对上）

`assets/pro-api/…/api.js` 里：

```js
extensionIndexedDBVersion = 6
getCurrentExtensionDatabaseName() { return 'User_' + globalVariableUserInfo.uuid + '_v6' }
onupgradeneeded:
  store 'extensionsIndex'        keyPath 'uuid'   index: installationTime / fileSize
  store 'extensionsObjectStorage' keyPath 'key'   index: uuid / path
  store 'extensionsUserConfig'   keyPath 'uuid'
  store 'standaloneScript'       keyPath 'name'
```

实测 leveldb 中命中的数据库名（`strings`）：

```
483 × User_8403292ee0024153a2774b76157fbf42_v6
  3 × User_config
  1 × User_co
```

### 2.2 单条记录的真实字段（`extensionsIndex`，V8 structured clone）

字段集合（实测 46 条记录一致）：

| 字段 | 路径 | 示例 |
|---|---|---|
| uuid | `uuid` | `6e242d1b51c64d3e9fd75c33f37dd749` |
| 扩展 id | `config.name` | `pcbtrans-lceda-extension` |
| 显示名 | `config.displayName` | `PCBTrans CSV 绕组导入` |
| 版本 | `config.version` | `0.1.5` |
| 发布者 | `config.publisher` | `PCBTrans` / `liuem` / `EasyEDA` |
| 许可 | `config.license` | `Apache-2.0` |
| 引擎约束 | `config.engines` | `{"eda":"^3.2.0"}` |
| 主页 | `config.homepage` | `https://trans.rkdianzi.com/` |
| 关键词/分类 | `config.keywords` / `config.categories` | `["Via","Fanout"]` / `["PCB"]` |
| 激活事件 | `config.activationEvents` | `{entry, dependentExtensions, headerMenus}` |
| 包大小 | `fileSize` | `2929066` |
| 安装时间 | `installationTime` | `2026-10-23T08:04:46.228Z` |
| 启用 | `isEnable` | `true` |
| 顶栏菜单 | `isShowAtHeaderMenu` | `true` |
| 自动更新 | `isAutoUpdate` | `true` |
| 商店来源 | `isInExtensionStore` | `false` |
| 外部交互 | `isAllowExternalInteractions` | 见 rawRecords |

`artifacts/ext-market/installed-extensions.json` 里的真实样例（节选，原文）：

```json
{
  "uuid": "6e242d1b51c64d3e9fd75c33f37dd749",
  "id": "pcbtrans-lceda-extension",
  "displayName": "PCBTrans CSV 绕组导入",
  "version": "0.1.5",
  "publisher": "PCBTrans",
  "license": "Apache-2.0",
  "engines": { "eda": "^3.2.0" },
  "homepage": "https://trans.rkdianzi.com/",
  "isEnable": true,
  "isShowAtHeaderMenu": true,
  "isAutoUpdate": true,
  "isInExtensionStore": false,
  "fileSize": 2929066,
  "installationTime": "2026-10-23T08:04:46.228Z"
}
```

### 2.3 本次提取到的真实清单（46 条，节选 12 条；全量见 JSON）

| 显示名 | 版本 | publisher | id | uuid |
|---|---|---|---|---|
| 格式转换 | 1.8.29 | EasyEDA | `eext-format-convert` | `d16ec4f7259c47fda39f9183547c52d5` |
| AI巧绘 | 1.0.8 | LCY | `pro-schematic-ai-drafty` | `7f5625494d16493692e4532279c15b58` |
| 电源地就近打孔 | 0.6.3 | liuem | `lceda-pcb-autofanout` | `e4b41778209e47768b4f04e6aba93146` |
| 原理图引脚网络扇出 | 0.1.8 | liuem | `lceda-sch-net-fanout` | `9e600c31253b4e3a9245b0b655aef2c9` |
| 设计规则生成器 | 1.8.2 | EasyEDA | `eext-design-rule-generator` | `a17d5c349e674b8bb253a958c213a980` |
| PCBTrans CSV 绕组导入 | 0.1.5 | PCBTrans | `pcbtrans-lceda-extension` | `6e242d1b51c64d3e9fd75c33f37dd749` |
| PCB 工具箱 | 1.5.1 | chenlong11 | `pcb-toolkit` | `a7e3f1d9b2c84e6a9f0d5b3c7e1a4f8d` |
| PCB Auto Router | 1.46.12 | PcbAutoRouter | `pcb-auto-router` | `6478ce6707ac4293a6c1827ad510f621` |
| EDA Agent Connector | 1.14.0 | zhoushoujian | `easyeda-agent-connector` | `4dae27407c1d43be98e8e210d45fe587` |
| PartLab 元器件库存管理 | 0.1.37 | PartLab | `partlab` | `2180e2bfa3954fc6bd907e2fe5188e71` |
| AI 本地知识库 | 1.8.3 | EasyEDA | `eext-knowledge-base` | `fe9db7f3d27046ff92b3913de197736f` |
| 引脚丝印生成器 | 1.0.0 | 沧海有闲鱼 | `pin-silkscreen` | `f84b3eadba9a4dc9b2932060a821eeff` |

> 与截图比对：截图中的「格式转换 / AI巧绘 / 电源地就近打孔(liuem) / 设计规则生成器 / PCBTans CSV 绕组导入」**均在本次提取结果中命中且版本一致**。
> 截图中「AI 彩色丝印生成器 / 养生模式 / 流程图生成器」在本次快照里**未命中同名记录**（`grep 养生模式`、`流程图生成器` 在 profile 全量字节里 0 命中）——判断为：截图时刻与本机当前注册表状态不同（卸载/换账号/截图来自另一环境），或这三项是**内置扩展**（见 2.4）。**此项标记为未验证。**

### 2.4 内置扩展 vs 用户扩展（重要边界）

pro-api 的 `builtinExtensionsUsingDynamicMock: true`：官方内置扩展清单来自内部 RPC
`/pro-sw/extensions/private/list`，运行时**动态 Mock**（不落普通磁盘文件、不进 `User_*_v6` 的持久语义）。
⇒ 「EasyEDA 官方内置」（仿真引擎、格式转换等）与「账号已装扩展」在数据来源上是两条链路；
本报告的 46 条是从 `User_<uuid>_v6` 里解出的记录，其中部分官方项的 `isInExtensionStore=false`，说明它们由账号侧同步写入。

---

## 3. 读取方法（本次实际使用的脚本，已跑通）

`artifacts/ext-market/probe/extract-registry-v1.mjs`（Node 24，纯只读）：

1. 遍历 `https_pro.lceda.cn_0.indexeddb.leveldb/{*.log,*.ldb}`；
2. `.ldb`：解析 LevelDB 表（footer → index block → data blocks），**自行实现 snappy 解压**
   （类型 0 literal / 1 copy-1B / 2 copy-2B / 3 copy-4B）；
3. `.log`：直接按 WAL 记录扫描；
4. 在解压后的字节里定位 V8 structured-clone 记录（`0x22 0x04 "uuid"` 标记，向前 1–6 字节找 `0xFF 0x0F` 版本头），
   用 **`node:v8` 的 `v8.deserialize()`** 反序列化成 JS 对象；
5. 按 `uuid` 去重，映射成上表字段输出。

关键踩坑（写进脚本注释，避免后人重踩）：

- **snappy copy 分支必须 `const v = out[o-offset]; out[o]=v; o++`**。
  写成 `out[o++] = out[o-offset]` 时 JS 先自增左值、再读右值，产出整体错位 1 字节，
  解出来的 index block 看似正常实则句柄全错（表现为 `unsupported block compression type 176`）。
- `v8.deserialize(buf.subarray(start))` **允许尾部多余字节**，所以不必精确算记录长度，能大幅降低解析难度。
- EDA 运行中 leveldb 持 `LOCK`：**不要用 sqlite/leveldb 库去 open**，只读原始文件字节。

### 3.1 已知精度缺口（必须写进实现约束）

- v1 脚本对 `.ldb`（旧快照）+ `.log`（新写入）**按文件顺序去重**，没有按 LevelDB
  **internal sequence number** 合并，也没有处理 **delete tombstone**。
  ⇒ 结果是「曾经装过的记录」可能混入当前清单（46 条里包含历史条目），版本号也可能取到旧值
  （例：`Run API Gateway` 在 log 中为 1.0.6、在 ldb 中为 1.0.5）。
- v2 版（WAL batch 解析 + `seq` 合并 + tombstone 过滤 + 表条目 internal key 解析）已写好逻辑但
  **本次时间盒内未完成验证**，标记为「未验证」；实现要点：
  WAL 记录 = 7B 头(CRC32C/len/type) + write batch(8B seq + 4B count + [1B type + varint keyLen + key + varint valLen + val])；
  `.ldb` 条目 userKey 末尾 8B 是 `(seq<<8)|type`，`type=0` 即删除标记。
- 若要「当前准确清单」，除 v2 外还需注意：EDA 退出时才会把 WAL flush 进 ldb，运行中读取必然混着两代数据。

---

## 4. 桥接 / pro-api 能否直接读？（结论：不能）

### 4.1 `runtime/bridge.mjs`

- `COMMANDS` 是 `Object.freeze({...})`，共 **80 条**命令，id 形如
  `project.current`、`document.current`、`pcb.drc`、`pcb.gerber.inspect`、`pcb.bom.inspect`、
  `library.device.search`、`pcb.job.*`、`workspace.create`、`schematic.open`、`pcb.open` …
- `grep -iE "ext|plugin|market"` 命中数：**0 条扩展相关命令**。
- 协议面：`GET /health`（已实测，见 `health.json`）、任务模型 `pcb.job.*`；每条命令带
  `permission: 'read'|'write'` 与 `signature`（pro-api 调用签名），本质是"把一段 `eda.*` 代码
  送进 EDA 执行"。**没有扩展管理器/扩展列表通道。**

### 4.2 pro-api（`assets/pro-api/0.3.18.0bc12bb0/api-types.d.ts`）

- 可用命名空间：`DMT_* / SCH_* / PCB_* / LIB_* / SYS_*`（SYS_FileSystem、SYS_Storage、SYS_MessageBus、
  SYS_FileManager、SYS_Timer、SYS_WebSocket …）。
- 与"扩展"相关的公开成员只有：
  - `SYS_Storage` 的 **`private extensionUuid`**（仅自身扩展的配置读写，注释明确"仅扩展有效"）；
  - 注释里提到的内部总线 `extensionApiMessageBus2` 主题（`extensionApi.PCB_Event.*` 等），
    **不是** 列扩展的 API。
- `grep -c "extension" api-types.d.ts` = 65，均为 `extensionUuid` / `extensionApiInit` 之类**内部或事件**语义。
  **没有 `eda.extensions.list()` 这类接口。**

⇒ 想通过桥接扩展拿到「已安装扩展清单」**不可行**；pro-api 内部确有
`extensionApiMessageBus2.rpcCall('extensionApi.getExtensionsDetail')`（在 `api.js` 里注册），
但那是 **pro-ui ↔ pro-api 的内部 RPC 通道**，第三方扩展/桥接命令未暴露、也拿不到句柄，
且调用它等于"让扩展去操控宿主 UI 内部消息"——属于高风险越界，本任务明确不做。

---

## 5. GUI 路线评估（只评估，不执行）

### 5.1 Electron 远程调试端口（CDP）—— **实际是开着的**

实测证据（`cdp-version.json` / `cdp-targets.json` / `DevToolsActivePort.txt`）：

```
GET http://127.0.0.1:9222/json/version →
  { "Browser": "Chrome/136.0.7103.115", "Protocol-Version": "1.3",
    "User-Agent": "...JLCEDAPro/3.2.186.b52e3e87 Chrome/136.0.7103.115 Electron/36.3.2..." }

GET http://127.0.0.1:9222/json/list → 6 个 target
  page  : 衣橱助手V2.0-AI设计 | 嘉立创EDA(专业版) - V3.2.186
          url = https://pro.lceda.cn/editor?cll=warn#id=ba4924190e3a4388a097f3dee090da20…
  worker: ×5
```

- 9223 / 9333 探测：无响应（只有 9222）。
- `~/.config/LCEDA-Pro/cache.arm64.3/DevToolsActivePort` = `9222` + `/devtools/browser/4a388f93-…`
  ⇒ 该实例以 `--remote-debugging-port` 启动（用户配置里 `devTools` 为空，说明是默认开启或 CLI 注入）。
- 可行做法：`Runtime.evaluate` 执行 `indexedDB.databases()` / `IDBFactory.open('User_…_v6')` 读 `extensionsIndex`，
  **一条命令即可拿到准确、含 tombstone 语义的当前清单**，比逆向 leveldb 稳得多。
- **风险**：这就是"向 EDA 注入代码"——本任务明令禁止；且 CDP 客户端的临时代码会在页面上下文里执行，
  一旦并发执行写命令可能污染编辑器状态。**结论：能力存在，但不采用；仅在人工排障时作为最后手段。**
- 稳定性备注：端口只在 EDA 以调试模式启动时存在，重启可能变化（虽然 `DevToolsActivePort` 会更新）。

### 5.2 AppleScript / 辅助功能（Accessibility）抓窗口文本

- 需要「辅助功能」TCC 授权（当前会话审批被禁用，无法验证授权状态）→ **未验证**。
- 即使能抓，Electron 自绘列表的 AX 树通常只有 `AXWebArea`，文本需逐节点遍历，稳定性差；
  另外涉及系统权限弹窗，不适合无人值守。

### 5.3 截图 + OCR

- 项目已有 `runtime/eda-window-capture.mjs` 可复用（截图能力本身成熟）。
- 但扩展管理器的"版本"列字号小、深浅色主题差异大、列表可滚动 → OCR 需要人工校对；
  且只能拿到"屏幕上那一屏"，无法保证全量。
- **定位：兜底/交叉校验手段**（例如用于确认某个扩展是否在 UI 上真实可见），不作为主通道。

---

## 6. 实时性方案与建议周期

| 方案 | 延迟 | 成本 | 结论 |
|---|---|---|---|
| `fs.watch` 监听 `…/IndexedDB/https_pro.lceda.cn_0.indexeddb.leveldb/` | 秒级（写入即触发，可能有重复事件） | 低（只监听 1 个目录） | **推荐主方案**：目录在每次安装/卸载/配置变更时必有写；监听 `*.log`、`*.ldb`、`CURRENT` |
| 定时轮询（读 `*.log` mtime+size，变化才做全量解析） | 取决于周期 | 中（全量解析一次 ~1–2s） | **推荐兜底**：30s 轮询 + 只在 mtime/size 变化时解析 |
| 事件推送（扩展/EDA 主动通知） | 实时 | — | **不可行**：无公开事件通道；桥接扩展无法感知扩展管理器状态 |

建议实现参数：

- `fs.watch(dir, {persistent:false})` + 300ms debounce；
- 变化触发后：先做「mtime/size 快照比对」，不同再解析；
- 解析产物按 `uuid` 建立内存索引，输出给上层时附 `probedAt` + `sourceFile` + `recordSeq`；
- 兜底轮询 `30_000ms`；EDA 退出/重启时做一次强制全量；
- 注意 `LOCK` 文件：**只读字节，不 open 库**。

失败模式（实现时必须显式报错，不能静默返回空清单）：

1. 目录不存在 → EDA 从未登录/从未启动过扩展管理器（`IndexedDB/https_pro.lceda.cn_0.*` 尚未创建）；
2. 账号切换 → 数据库名 `User_<uuid>_v6` 变化，需要重新发现库名（扫描 leveldb 中的 `User_*_v6` 字符串）；
3. 版本升级 pro-api（当前 `extensionIndexedDBVersion=6`）→ 库名后缀从 `_v6` 变 `_v7`，解析器要按前缀匹配；
4. 文件被 EDA 独占写 → 读到半条记录（失败要重试一次，仍失败标记 `PARTIAL`）；
5. macOS 全盘访问/沙箱限制 → `~/Documents`、`~/.config` 读取权限（本机实测可读）。

---

## 7. 替代指标（若后续决定不碰 IndexedDB）

- **不要**退回"读 `~/Documents/LCEDA-Pro` 目录猜清单"——那里没有扩展信息，容易误报。
- 可用替代量：
  - `~/Documents/LCEDA-Pro/logs/warn/*.log` 中 `/api/extensions/editor/his_version_list`
    的出/入口记录 → 只能反映"扩展库接口被调用"，不能反映已装清单（本机日志里只有 ECONNRESET 错误）；
  - `fileSize` 合计 + `installationTime` 分布 → 可作为"环境健康度"指标；
  - 若桥接恢复，`GET /health` 的 `edaConnected / edaWindowCount / activeWindowId` 持续采集，
    可用于判断"EDA 是否在线"，与扩展清单分属两条独立指标。

---

## 8. 运行环境告警（本次实测发现）

- **Bridge 不稳定**：16:11:44 探测 `GET http://127.0.0.1:49620/health` 返回
  `{"service":"easyeda-bridge","status":"ok","managedBy":"circuitpilot-runtime","processId":38908,
  "edaConnected":true,"edaWindowCount":2,"activeWindowId":"9ecb7999-502f-49da-9068-519c6d88e6bb",
  "pendingRequests":3,...}`；
  但 **16:20:30 再探已 `Connection refused`**（进程 38908 已退出）。
  ⇒ 任何依赖 bridge 的实时采集都要有"桥接不可用"的降级路径，不能假设常驻。
- **沙箱限制**：本会话 `/bin/ps` 被拒（`Operation not permitted`），进程枚举不可用；
  `lsof -iTCP -sTCP:LISTEN` 可用（据此确认 `LCEDA-Pro 36487` 监听 9222、`node 38908` 监听 49620）。

---

## 9. 未验证项清单（不要当成结论使用）

1. v2 sequence-aware 提取器（tombstone/版本取最新）——逻辑已写，**未跑通验证**；
   因此当前 46 条清单含历史条目，**不是可信的"当前已装集合"**，需 v2 落地后才能定稿。
2. 截图中的「AI 彩色丝印生成器 / 养生模式 / 流程图生成器」在本机注册表快照中未找到同名字符串，
   原因（卸载 / 换账号 / 内置扩展 / 截图来自其他环境）**未验证**。
3. AppleScript / Accessibility 路线因审批被禁用，**未验证**可行性。
4. CDP `Runtime.evaluate` 读取 IndexedDB 的实际结果——**故意未执行**（任务禁止注入）。
5. 内置扩展（pro-sw `/extensions/private/list`）的本地缓存路径——只从源码确认存在，**未在磁盘定位**。
