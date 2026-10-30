# 嘉立创EDA专业版 扩展市场 — 真实数据通道侦察报告

- 侦察对象：嘉立创EDA专业版 **3.2.186.b52e3e87**（`package.json` name=`client.pro.lceda.cn`, productName=`JLCEDA_Pro`），Electron 客户端
- 侦察时间：2026-10-23
- 约束：仅只读侦察；未登录任何账号、未安装/卸载扩展、未写入任何 EasyEDA 数据目录；网络侧只做公开 GET/HEAD
- 结论一句话：**市场清单、扩展详情、全量版本历史、`.eext` 下载包在匿名状态下全部公开可读**（无 token/cookie 要求），因此「API 直连」是首选通道；但**自动更新状态与 autoInstall 配置字段需要登录态**，且本地已装扩展落在 **IndexedDB**（非明文文件），「只读文件」通道可靠性低。

---

## 0. TL;DR（给 lead 的 5 条）

1. **市场列表 = 公开 GET API**：`GET https://pro.lceda.cn/api/extensions/editor/search?page=1&pageSize=20[&keywords=x]`，匿名 200，`total=235`（12 页），返回 28 个字段（含 `version`/`install_num`/`file_path`/`publisher`/`average_score`/`updated_at`）。
2. **详情 + 全量版本历史也是公开 GET**：`/api/extensions/detail?uuid=&version=`（含 `readme`/`change_log`/`engines.eda`/`categories`/`keywords`/`license`）、`/api/extensions/editor/his_version_list?uuid=`（含每个版本的 `engines.eda` 兼容范围与 `file_path`）。
3. **不需要登录即可拿到「清单 + 版本 + 下载 URL + 兼容 EDA 版本」**；只有 `config.autoInstall / autoUpdate` 这类**服务端下发的安装策略**需要登录态（匿名响应里没有 `config` 字段）——即"读市场"不需要登录，"知道官方让你装什么/自动更新什么"需要。
4. **安装/更新机制已完全还原**：一键安装 = `detail` 取 `file_path` → CDN GET `.eext`（image.lceda.cn，匿名 200）→ `extensionApi.importExtensionPackages` 写入 IndexedDB；更新检查在**登录钩子 `hookOnLogged`** 时批量跑一遍，**只对 `isAutoUpdate=true` 的扩展静默升级**（该位来自已装记录，默认 `false`，样例 `extension.json` 无 `autoUpdate` 键）；**未发现周期性定时器**。
5. **合规与供应链**：`robots.txt` 未禁止这些路径（pro.lceda.cn 仅禁 `/login`；jlc-ext.com `Disallow:` 为空），扩展广场有官方公开站点 https://jlc-ext.com （`lceda.cn` 导航 `扩展广场` 直链）；但**代码里未发现 `.eext` 签名/验签逻辑**，且服务端可下发 `autoInstall=ON` 让客户端**自动安装**指定扩展 —— 这是本项目必须设防的供应链风险点。

---

## 1. 客户端怎么加载前端代码（证明"抓 JS 是合法的公开静态资源"）

`/Applications/嘉立创EDA(专业版).app/Contents/Resources/app/editor.ini` 列出全部模块 URL（公开 CDN）：

```
[default]
https://modules.lceda.cn/pro-mgr/3.2.177.b354aab9/js/pro-mgr.js
https://modules.lceda.cn/pro-api/0.3.18.0bc12bb0/api.js
https://modules.lceda.cn/pro-ui/3.2.181.db96fbff/js/ui.js
```

命令与结果（全部 200，可匿名下载）：

```bash
$ for u in .../pro-mgr.js .../api.js .../preload.js; do curl -sS -o $(basename $u) -w "%{http_code} %{size_download}\n" "$u"; done
200 2192887  pro-mgr.js
200 1855625  api.js
200 873268   preload.js
```

**渲染进程的页面 origin 就是 `pro.lceda.cn`**，这是理解"相对路径 API"的关键。证据在 `app.js`（`Resources/app/app.js`）：

```js
function sz(t){ ... if(I.type!=="ONLINE"||r){ ... `https://client/editor?cll=${e}#...` }
               else return `${I.onlineService}/editor?cll=${e}` }   // → https://pro.lceda.cn/editor
```

且 `app.js` 用 `protocol.handle("https", u)` 全局拦截请求，把自维护 cookie 罐里的 cookie 注入 `cookie` 头、改写 `host`/`origin`；只有 `/editor`、`/api/client`、以及 modules 特定前缀会被路由到本地（`function xC(t,e,r)`），**`/api/extensions/*` 不被本地化，直连远端 pro.lceda.cn**：

```js
function xC(t,e,r){ return r.startsWith("/editor") ? (e="client")
  : r.startsWith("/api/client") ? (e="client")
  : (e==="modules.lceda.cn"||...) && (... ) , {domain:e,uri:r} }
```

> 推论：应用内的市场请求是 **同源相对 GET**，自动带上客户端 cookie；但在**匿名/未登录**场景下服务端并不校验，见第 2 节实测。

---

## 2. 市场列表 API（核心结论：公开可读）

### 2.1 接口定义（源码级证据）

`pro-api/api.js` 的 HTTP 基座是一个**裸 GET，无 header、无 token**：

```js
async function ma(e,t,i="low"){ if(typeof t=="object"){e+="?";...encodeURIComponent(t[s])...}
  let n={method:"GET",cache:"no-cache",redirect:"follow",priority:i};
  try{let r=await fetch(e,n);return r.ok?r:void 0}catch{return}}
async function fh(e,t,i="low"){let n=await ma(e,t,i);return n?await n.text():void 0}
```

完整端点表在 `pro-ui/ui.js`（`w.apis.others`）：

```js
outsideExtension:"/api/org/outside-ext",
outsideExtensionDataDetail:"/api/extensions/ext-detail",
outsideExtensionDataSearch:"/api/extensions/ext-search",
searchExtensions:"/api/extensions/editor/search",
getExtensionDetail:"/api/extensions/detail",
getExtensionVersionList_SYH:"/api/extensions/",
getExtensionVersionList_DEV:"/api/extensions/editor/his_version_list",
```

真实请求参数由扩展管理器 `getExtensionListData()` 拼出（`ui.js`）：

```js
let i={page:this.curPageNumber,pageSize:20};
Fr.searchValue && (i.keywords=Fr.searchValue),
Fr.filterConfig.extensionLib.categoriesStatus!==Ky && (i.keywords=..., i.category=...);
see.default.getJSON(w.apis.others.searchExtensions, i)   // 5s 超时
```

### 2.2 匿名实测（`page`/`pageSize` 生效）

```bash
$ curl -sS -o out -w "HTTP %{http_code}\n" "https://pro.lceda.cn/api/extensions/editor/search"
HTTP/1.1 200 OK     Content-Type: application/json
（仅下发 HWWAFSESID / extensions_session / csrf_token 三个新 cookie，响应不依赖任何输入 cookie）
{"success":true,"code":0,"result":{"page":1,"pageSize":20,"total":235,"totalPage":12,"lists":[ ... 20 items ... ]}}
```

| 请求 | HTTP | 观察 |
|---|---|---|
| `/api/extensions/editor/search` | 200 | `total=235, pageSize=20, totalPage=12, 20 items` |
| `?page=2&pageSize=50` | 200 | `page=2, pageSize=50`, 50 items（**pageSize 可放大**） |
| `?pageSize=100` | 200 | 100 items，`total` 仍 235 |
| `?keywords=agent` | 200 | `total=5`（**keywords 是真实搜索参数**） |
| `?keyword=agent` / `?q=` / `?search=` / `?name=` | 200 | 参数被忽略，`total=235` |
| `?category=PCB` / `=SCH` / `=ALL` | 200 | 匿名单下 `total` 不变（235）→ **category 过滤匿名无效/未生效** |
| `?autoInstall=yes` | 200 | 与裸请求**逐字节同构**：匿名响应**不含 `config` 字段** |

`keywords=agent` 的返回样例（对 CircuitPilot 直接相关）：

```
EDA API Agent            | uuid d6bdad7f18414e5383464fd2e41d49c2 | v1.4.5  | installs 342  | JLCEDA <support[#]lceda.cn>
EDA Agent Connector      | uuid 4dae27407c1d43be98e8e210d45fe587 | v1.14.0 | installs 683  | zhoushoujian
原理图PCBAI-Agent v0.22.9| uuid d237ca0e502f44b4962d6b9c4c02217f | v0.22.9 | installs 95   | AhangYa
JLCEDA AI Agent          | uuid 0a81a60ee3ae43a7b602689c83bbffed | v0.5.3  | installs 191  | Codex
AI 设计助手              | uuid 4585803ac4eb41d19e17c601bfa15528 | v2.6.1  | installs 1480 | Lion
```

### 2.3 列表字段全集（28 个，匿名可见）

`biz_key, current_ver_biz_key, ext_uuid, uuid, name, display_name, description, version, publisher, username, nickname, avatar, license, images{logo,banner?}, install_num, average_score, com_total, ext_status, version_status, review_status, plugin_status, order_num, user_biz_key, file_path, create_time, created_at, ext_create_time, updated_at`

字段语义（由后续详情/版本接口交叉确认）：

- `display_name` 中文名，`name` 英文包名（`extension.json` 的 `name`），`ext_uuid`/`uuid` 同值 → **主键**
- `version` = 当前市场版本；`updated_at` = 该版本发布/更新时间
- `install_num` = 下载量；`average_score`/`com_total` = 评分与评价数
- `file_path` = **`.eext` 直链**（`https://image.lceda.cn/extensions/files/<hash>.eext`）
- `review_status`（观测值 4）、`ext_status`（2）、`version_status`（2）、`plugin_status`（1，客户端只展示 `===1` 的项）
- **列表里没有**：`engines.eda`（兼容 EDA 版本）、`change_log`、`categories`、`keywords`、`config{autoInstall,autoUpdate,...}` → 这些都要走详情/版本接口或需登录态

### 2.4 分页 / 频率实测

- 分页：`page` 从 1 起，`pageSize` 支持 20/50/100（未测上限）；235 个扩展 = 12 页（pageSize=20）
- **限流**：连续 15 次串行 GET，全部 `200`，单次 ~1.5–3.5s（**是动态接口，非 CDN 缓存**；响应 22.8KB 且恒为同一内容）。未见 429/5xx/验证码；**未做更长时间压测**，无法断言"无 rate limit"
- 注意：`/api/extensions/{uuid}?order=desc`（私有化版分支）匿名 **404**；`/api/extensions/ext-search`（"外部扩展"标签页）匿名 **404** → 二者属于**私有化部署/企业能力**，普通在线版不可用

---

## 3. 扩展详情与版本查询接口（公开）

### 3.1 `GET /api/extensions/detail?uuid=<uuid>&version=<ver>`

```bash
$ curl -sS "https://pro.lceda.cn/api/extensions/detail?uuid=4dae27407c1d43be98e8e210d45fe587&version=1.14.0"
HTTP 200, 17.8KB
result keys: avatar, average_score, bugs, categories, change_log, comTotal, created_at, engines,
             ext_biz_key, ext_uuid, extension, file_path, homepage, install_num, keywords, license,
             name, nickname, publisher, readme, review_status, status, user_biz_key, username,
             uuid, v_create_time, v_deleted_flag, v_deleted_time, v_update_time, version, version_status
```

样例（easyeda-agent-connector，即本机 `~/Downloads` 里那个扩展的线上版）：

```
name        = easyeda-agent-connector
version     = 1.14.0
engines     = {"eda": "~3.2.0"}          ← 兼容的 EDA 版本（semver range）
categories  = "Other"
keywords    = "agent,automation,websocket,schematic,AI"
license     = MIT
file_path   = https://image.lceda.cn/extensions/files/659bb91c1a1b4210b6e8a79b70ae5b1d.eext
install_num = 683
publisher   = zhoushoujian ; nickname = zhoushoujian
v_update_time = 2026-10-19T06:45:58.000Z
homepage    = https://github.com/zhoushoujianwork/easyeda-agent
readme      = 5392 chars（Markdown）；change_log = 50465 chars（Markdown）
```

### 3.2 `GET /api/extensions/editor/his_version_list?uuid=<uuid>` → **全量版本历史**

```bash
$ curl -sS "https://pro.lceda.cn/api/extensions/editor/his_version_list?uuid=6ce496ac1d7ee23d62e605c8762b5744"
HTTP 200, 11893, application/json
{"success":true,"code":0,"result":[
  {"biz_key":"371188635172114434","version":"1.1.4","version_status":2,"review_status":4,"deleted_flag":0,
   "create_time":"2026-10-21T06:51:07.000Z","update_time":"2026-10-21T07:47:53.000Z",
   "file_path":"https://image.lceda.cn/extensions/files/934154464f024790ba9e1a7abea4b541.eext",
   "ext_uuid":"6ce496ac1d7ee23d62e605c8762b5744",
   "engines":{"eda":"^3.2.0"},
   "change_log":"# 更新日志\n\n## 1.1.4 (2026-10-21)\n\n- 修复…"}, ... ]}
```

- 缺 `uuid` 参数：`{"code":103001,"success":false,"msg":""}`（HTTP 仍 200）
- 每个版本都带 `engines.eda`、`file_path`、`change_log`、`status` → **这就是"公开的版本查询接口"**，可用来做「已装版本 vs 市场最新版」的兼容性判断

### 3.3 版本判定逻辑（客户端同款的语义，务必照抄才能与市场"一致"）

`pro-api/api.js`：

```js
// 1) 取版本列表：私有化版走 /api/extensions/{uuid}?order=desc，在线版走 his_version_list
async function Qle(e){ let t; if(kn) t=await fh("/api/extensions/"+e,{order:"desc"});
                       else   t=await fh("/api/extensions/editor/his_version_list",{uuid:e});
  ... for(a...){ if(i.result[a].status===1 && $E.valid(i.result[a].version)){ n=version; r=file_path; s=engines; break } }
  return {version:n, filePath:r, engines:s} }        // kn = IS_PRIVATE（私有化部署）

// 2) 兼容性 + 是否需要更新
async function eS(e,t){  // e=uuid, t=已装版本
  let i=await Qle(e);
  if(!i || (i.engines?.eda && !$E.satisfies(hh(!0), i.engines.eda))) return !1;   // 不兼容就直接不提示
  return qg(t,i.version) ? {version:i.version,filePath:i.filePath} : !1 }          // qg = semver 大于
```

- `hh(!0)` = 编辑器当前版本（取 `document.querySelector("meta[name=editorMainVersion]")`，截取前 3 段 → `3.2.186`）
- 即：**服务端 `status===1`（上架）+ semver 比较 + `engines.eda` 兼容过滤** 三件套。runtime 若自建判定，必须与之一致，否则会出现"runtime 说有新版、客户端不提示"的错位。

---

## 4. 安装与自动更新机制

### 4.1 一键安装（市场 → 已装）

`ui.js` `installExtension()`：

```js
if(!s){ let d=await this.getExtensionVersionDetail(i,o); if(d) s=d.result.file_path; else return error }
let l=await fetch(s,{method:"GET"});                       // 直接 GET CDN 上的 .eext
... let p=new File([new Blob(u)], `${n}_v${o}.eext`);
await w.extensionApiMessageBus2.rpcCall("extensionApi.importExtensionPackages",{files:[p],action:r});
```

- 下载 URL 形态：`https://image.lceda.cn/extensions/files/<32位hex>.eext`（内容寻址式文件名）
- 匿名可下载（HEAD 验证）：

```
$ curl -I https://image.lceda.cn/extensions/files/934154464f024790ba9e1a7abea4b541.eext
HTTP/2 200 | server: Tengine | content-type: application/octet-stream
content-length: 691807 | content-disposition: inline | accept-ranges: bytes
etag: "759cfbe3cf16195e01c74b05e8db5e67" | last-modified: Wed, 21 Oct 2026 06:51:07 GMT
```

- **副作用提示**：`installExtension` 里还有"覆盖安装时先把 `isAutoUpdate` 置 `false`"的行为（`setExtensionStatus("isAutoUpdate",!1)` 后再 install）——升级动作本身不会自动打开静默更新。

### 4.2 `.eext` 侧载

- 侧载入口用 MIME 白名单接受 zip：`["text/javascript","application/zip","application/octet-stream","application/x-zip-compressed","multipart/x-zip",""]`（`ui.js` 的 `eWn`/`wbo(files,"extensionCode")`）
- 本机样例 `~/Downloads/easyeda-agent-connector-1.3.0.eext` 结构（zip）：
  `CHANGELOG.md, LICENSE, README.md, extension.json, dist/index.js, images/*`
- `extension.json` 关键字段（实证）：
  `name, uuid(32hex，与市场 uuid 一致), displayName, description, version, publisher, engines.eda("~3.2.0"), license, repository{type,url}, homepage, categories, keywords[], images{logo}, activationEvents{onStartupFinished}, entry("./dist/index"), dependentExtensions{}, headerMenus{home/blank/sch/symbol/pcb/footprint}`
- **样例里没有 `autoUpdate` 键** → 已装记录 `isAutoUpdate` 走默认 `false`

### 4.3 自动更新（结论：非静默默认开启、无周期定时器、由登录钩子触发）

`pro-api/api.js`：

```js
async function aU(){                      // 检查全部已装扩展
  for(let t of await ko()){               // ko() = 已装扩展列表
    let i=await eS(t.uuid,t.config.version);
    _.extensionCheckUpdateStatus[t.uuid]={latestVersion:i?i.version:void 0,
      isNeedUpdate:typeof i=="object", isAutoUpdate:t.isAutoUpdate,   // ← 来自已装记录的开关
      downloadFilePath:i?i.filePath:void 0} } }

async function oU(){                      // 静默升级：四个条件全真才动
  for(let e of Object.keys(_.extensionCheckUpdateStatus)){
    s.isNeedUpdate && s.latestVersion && s.isAutoUpdate && s.downloadFilePath && await $le(e) } }

async function $le(e){                    // 下载并 upgrade
  let n=await Es(i,void 0,void 0,`auto-update-${e}_v${t}.eext`);
  return n?await yc({files:[n],action:"upgrade"}):... }
```

**触发点**（唯一一处，登录后）：

```js
// 内置扩展初始化完成后：已登录则触发 hookOnLogged()
_.globalVariableUserInfo.uuid ? (ax() /*hookOnLogged*/) : "尚未登录，不触发"
// hookOnLogged 内：
await nx();  SE();  aU().then(()=>{ oU().then(()=>{ kn && lU() }) });
```

- **检查频率**：无 `setInterval` 周期器命中扩展更新路径；实际是「**每次会话登录/用户信息就绪后各跑一次全量检查**」。`ui.js` 里另有 `checkUpdateInterval:36e5`（1 小时）但位于客户端设置对象的通用属性中，**未验证其与扩展更新相关**，不作为结论。

### 4.4 ⚠️ 服务端可"指令式自动安装"（供应链风险重点）

`pro-api/api.js` 存在一条**由服务端配置驱动**的自动安装链路：

```js
async function tue(){ let e=await fh("/api/extensions/editor/search",{autoInstall:"yes"});
  ... let i=t.result.lists.filter(n=> n.config?.autoInstall==="ON");   // 服务端说装什么就装什么
  return i }
async function lU(){ let e=await iue();                                 // 未装的
  for(let t of e) t.config && await nue(t.uuid,t.version,t.file_path,t.config) }  // 静默下载并 install
// nue(): yc({files:[...]}, action:"autoInstall",
//           isAutoUpdate:config.autoUpdate==="ON", isShowAtHeaderMenu:..., isAllowExternalInteractions:...)
```

- 匿名请求 `?autoInstall=yes` 时响应里**没有 `config` 字段**（实测逐字节等同裸请求）→ 该能力依赖登录态/服务端策略
- 含义：**客户端会按服务端下发的 `config` 自动安装扩展，并可一并打开 `autoUpdate`（静默升级）与 `allowExternalInteraction`（对外通信）**。CircuitPilot 若做"扩展市场管家"，必须把这四个开关的状态纳入可见性与审计（用户应当能看见"谁让装了什么"）。
- 该链路的服务端返回在匿名态**未验证**（需登录态，本次按纪律未登录）。

### 4.5 未发现签名/验签

对 `pro-api/api.js` 做 `signature|verifySign|checksum` 检索：**仅命中 JSZip 内部实现**（`../signature`、`checkSignature`），业务侧 `importExtensionPackages → yc()` 路径中**没有 `.eext` 签名校验或 hash 校验**代码。

> 结论（谨慎表述）：**未发现客户端强制签名校验**（基于 3.2.186 的 api.js 静态检索；不排除在服务端 CDN/WAF 侧或未审计模块中存在校验 → 细节**未验证**）。这直接决定「第三方/来源不明 `.eext` 侧载」的风险等级。

---

## 5. 已装扩展的本地形态（为什么"只读文件"通道不好用）

- 客户端把扩展存进 **IndexedDB**，两张表：
  - `extensionsIndex`：`{uuid, config(extension.json 内容), fileIndex, fileSize, installationTime, isEnable, isAllowExternalInteractions, isAutoUpdate, isOnlineSync, isShowAtHeaderMenu, isInExtensionStore}`
  - `extensionsObjectStorage`：`{key, uuid, path, source(File/Blob)}` — 实际文件字节（`path=""` 表示整包，其余为包内条目）
  - 另有 `builtinExtensionIndexedDBUtils` / `builtinExtensionsDynamicMockIndexedDB`（内置扩展）
- 证据（`api.js`）：`await _.extensionIndexedDBUtils.insert("extensionsIndex", p)` / `await _.builtinExtensionIndexedDBUtils.insert("extensionsObjectStorage", v)`
- 含义：
  1. 已装扩展**不是** `~/Documents/LCEDA-Pro` 下的明文目录树（该目录只有 `config.json/database/libraries/projects/logs/...`），所以"扫目录读清单"不可行；
  2. 从 Chromium LevelDB 解析 IndexedDB 是**可行但脆弱**的（需处理 .ldb/.log 合并、Blob 外置文件），且随版本变化；**不推荐作为主通道**；
  3. 官方可用的读取方式在客户端内部：`extensionApi.getExtensionsDetail` / `ko()` 等 RPC（见 §6）。
- **注意**：lead 侧实测「本机 IndexedDB 有 46 个已装扩展」与本条一致（内容即在上述两张表中），本报告不重复其磁盘取证细节（物理路径见 §8.9，未验证）。

---

## 6. 通道排序与推荐（可靠性 / 工作量 / 合规）

| 排名 | 通道 | 能拿到什么 | 可靠性 | 工作量 | 合规判断 |
|---|---|---|---|---|---|
| **1（首选）** | **API 直连**：`pro.lceda.cn/api/extensions/editor/search` + `/detail` + `/his_version_list` | 清单/详情/全量版本/兼容版本/更新日志/下载 URL/下载量/评分 | **高**：匿名 200、分页参数有效、字段稳定且有官方 UI 同源实现 | **低**：3 个 GET，纯 JSON | 公开 GET、robots 未禁止、无鉴权绕过；建议限速（≤1 req/s）与缓存 |
| 2 | 公开站点 `https://jlc-ext.com`（官方导航"扩展广场"）HTML/RSC | 与 API 同名同构的字段（首页 SSR 内嵌 50 条，含 `file_path`/`install_num`）；商品详情页 `/item/...` | 中：HTML 结构随发版变化，需解析 | 中：解析 Next.js RSC/`__next_f` | **最稳妥的对外表述**（官方公开站点、robots `Disallow:` 为空） |
| 3 | 客户端内 RPC / GUI 抓取（`extensionApi.getExtensionsDetail`、devtools） | 已装列表（含 `isAutoUpdate` 等本地开关） | 中低：需驱动 Electron/devtools 或注入；随版本变动 | 高 | 需在用户机器上自动化 UI，属于"操作客户端"，风险与维护成本都高 |
| 4 | 文件系统只读（IndexedDB LevelDB / `~/Library/Application Support/...`） | 已装扩展的 config 与整包字节 | **低**：非明文、跨版本脆弱、写入互斥风险 | 高 | 只读可行，但**易踩锁**（应用运行时 LevelDB 锁） |
| 5 | 桥接扩展内执行（自己写 .eext 在编辑器里跑） | 一切（编辑器 API + 本地文件） | 中（需用户安装我们自己的扩展） | 高（要维护扩展包与 marketplace 审核） | 需走扩展发布/审核流程；适合"必须写操作"的场景，不适合只读采集 |

**推荐落地形态**

- **只读采集层**：runtime 直接吃 `search` + `detail` + `his_version_list`，落本地缓存（建议 TTL ≥ 30min，全量 12 页 ≈ 20s @1.5s/req）。**不要**逐条拉 detail（235×~1.5s ≈ 6min），按需拉取。
- **已装状态层**：优先走官方扩展内 RPC（`extensionApi.getExtensionsDetail`），文件系统/IndexedDB 仅作为兜底；不要自己写 IndexedDB（存在与运行中客户端写冲突风险）。
- **安装/更新层**：**默认只读+建议**（展示"有新版 X.Y.Z，兼容 ^3.2.0"，由用户在客户端点击）。真要自动执行时，必须显示"由服务端 `autoInstall/autoUpdate` 策略触发"的来源，并加二次确认。

---

## 7. 合规与供应链风险（附可引用证据）

### 7.1 robots / 可抓取性

```bash
$ curl -sS https://pro.lceda.cn/robots.txt        # HTTP 200
User-agent: AhrefsBot / dotbot / MJ12bot / DeuSu / grapeshot → Disallow: /
User-agent: *
Disallow: /login
Sitemap: /sitemap.xml

$ curl -sS https://modules.lceda.cn/robots.txt    # HTTP 403（AccessDenied，OSS 直读，无 robots）
$ curl -sS https://jlc-ext.com/robots.txt         # HTTP 200
User-agent: *
Disallow:                                          # ← 全站允许
Sitemap: https://jlc-ext.com/sitemap.xml
```

- `pro.lceda.cn` 的 robots 只禁 `/login`，`/api/extensions/*` 未被禁止；`jlc-ext.com` 明确全站允许（该站是 `lceda.cn` 顶部导航"扩展广场"的官方直链：`<a href="https://jlc-ext.com" ...>扩展广场</a>`）
- `pro.lceda.cn/sitemap.xml` 只有 6 个 URL，**不含**扩展市场 → 市场页不在搜索索引入口，公开可读性来自 API 本身
- **未验证**：用户协议/服务条款正文。`https://lceda.cn/page/terms` 是 SPA（拉取 522KB HTML，抽取后正文仅 865 字符，全是导航与"自动登录中"），**未能从静态 HTML 读到条款文本**；也没有找到针对"扩展市场数据抓取"的专项条款。→ 结论：**未验证，不能断言"明确允许/明确禁止"**；建议法务/人工在浏览器中阅读 `lceda.cn` → 服务条款 + 扩展开发者协议后再定稿。

### 7.2 限流

- 15 次串行 GET 全 200（见 §2.4）；存在 WAF（下发 `HWWAFSESID`、`Server: CW`，且有 CDN `via` 链路）。
- **只读脚本必须自律限速**：建议 ≤ 1 req/s、单次会话 ≤ 100 请求、失败退避（客户端自身也是 20 条/5s 超时）。

### 7.3 第三方扩展供应链风险（有代码证据）

| 风险 | 证据 | 影响 |
|---|---|---|
| 无强制签名校验 | `importExtensionPackages → yc()` 路径无 `signature/verifySign/checksum` 业务命中（§4.5） | 侧载/中间人替换的 `.eext` 可直接获得扩展权限 |
| 服务端可远程下发自动安装 | `tue()` 过滤 `config.autoInstall==="ON"` → `lU()` 静默安装（§4.4） | 账户/服务端策略可改变本机代码执行面（"谁让我装的"可审计性缺失） |
| 可静默升级 | `oU()` 在 `isAutoUpdate` 为真时直接 `action:"upgrade"` | 供应链更新无用户确认 |
| 扩展可申请对外交互 | `isAllowExternalInteractions` / `allowExternalInteraction==="ON"`（§4.4）、编辑器提示"未启用扩展和独立脚本的外部交互权限" | 扩展可对内外通信，数据外流面 |
| 客户端渲染层 `webSecurity:false` | `app.js`: `new BrowserWindow({webPreferences:{...,webSecurity:!1,...}})` + 全局 `protocol.handle("https")` 注入 cookie | 渲染层同源策略被关闭，任何被加载的第三方代码风险更高 |
| 下载源为公开 CDN | `image.lceda.cn/extensions/files/<hash>.eext`，匿名 200，`etag`/`last-modified` 可用 | **优点**：可做 hash/size 归档与差异比对；**缺点**：无发布者签名可绑定 |

**给 CircuitPilot 的硬性建议**：任何"自动安装/自动升级"都必须（a）展示来源与触发策略，（b）展示 `engines.eda` 兼容性与 diff 摘要，（c）默认关闭，（d）记录 `.eext` 的 `etag/sha256/content-length` 以便复现与回滚。

---

## 8. 未验证清单（明确边界）

1. **用户协议/服务条款正文**：`lceda.cn/page/terms` 为 SPA，静态未取到正文 → "是否违反 ToS"**未验证**。
2. **登录态下的 `config` 字段**（`autoInstall/autoUpdate/allowExternalInteraction/topMenu`）与 `?autoInstall=yes` 的真实过滤效果：匿名响应无该字段 → **未验证**（需登录，按纪律未做）。
3. **`category` 参数**：匿名下无效；真实取值集合（数值 id？中文名？）**未验证**（客户端是拿 `categories` 做前端过滤，且列表项 `categories` 恒为 `[]`）。
4. **rate limit 上限**：仅测 15 次串行，未做持续压测 → **未验证**。
5. **`pageSize` 上限**：仅测到 100 → 上限**未验证**。
6. **`.eext` 签名机制**：未在客户端代码中发现，但不排除服务端/CDN 校验 → **未验证**。
7. **`jlc-ext.com` 的机器可读 API**：`/api/extensions/editor/search` 等在该域 **404**；其数据在 Next.js RSC 载荷中，逐页/详情接口形态**未验证**（可从 `__next_f` 断言首页内嵌 50 条）。
8. **扩展运行时沙箱强度**（iframe + message bus 的权限边界、能否直接读写本地文件）→ **未验证**，需单独审计。
9. **已装扩展 IndexedDB 的物理路径**：本机 `~/Library/Application Support` 下未按 `lceda/easyeda` 命名发现（`app.js` 有 `app.setPath("userData", cr)` 自定义路径）→ 精确路径**未验证**（由 `local-probe` 负责）。

---

## 9. 复现命令集（全部只读）

```bash
# 0) 模块与清单来源
cat "/Applications/嘉立创EDA(专业版).app/Contents/Resources/app/editor.ini"
cat ~/Documents/LCEDA-Pro/config.json          # onlineService / updateService

# 1) 拉前端 JS（公开 CDN）
curl -sS -o api.js https://modules.lceda.cn/pro-api/0.3.18.0bc12bb0/api.js
curl -sS -o ui.js  https://modules.lceda.cn/pro-ui/3.2.181.db96fbff/js/ui.js
curl -sS -o pro-mgr.js https://modules.lceda.cn/pro-mgr/3.2.177.b354aab9/js/pro-mgr.js

# 2) 市场列表（匿名）
curl -sS "https://pro.lceda.cn/api/extensions/editor/search?page=1&pageSize=20" | jq '.result|{total,totalPage,n:(.lists|length)}'
curl -sS "https://pro.lceda.cn/api/extensions/editor/search?pageSize=100&keywords=agent" | jq '.result.lists[]|{display_name,uuid,version,install_num}'

# 3) 详情 / 版本历史（匿名）
curl -sS "https://pro.lceda.cn/api/extensions/detail?uuid=4dae27407c1d43be98e8e210d45fe587&version=1.14.0" | jq '.result|{name,version,engines,categories,keywords,license,file_path,readme:(.readme|length)}'
curl -sS "https://pro.lceda.cn/api/extensions/editor/his_version_list?uuid=6ce496ac1d7ee23d62e605c8762b5744" | jq '.result[]|{version,status,engines,file_path}'

# 4) .eext 可匿名下载（只取头部，不落地安装）
curl -I "https://image.lceda.cn/extensions/files/934154464f024790ba9e1a7abea4b541.eext"

# 5) 合规面
curl -sS https://pro.lceda.cn/robots.txt ; curl -sS https://jlc-ext.com/robots.txt
```

---

## 10. 附：源码定位索引（便于复核）

| 事实 | 文件 | 关键符号 |
|---|---|---|
| 主窗口 URL / origin | `Resources/app/app.js` | `function sz(t)` |
| 请求拦截与 cookie 注入 | `Resources/app/app.js` | `protocol.handle("https",...)`、`function xC(t,e,r)` |
| 裸 GET 基座 | `pro-api/api.js` | `async function ma(e,t,i)`、`fh()` |
| 市场列表 | `pro-api/api.js` / `pro-ui/ui.js` | `/api/extensions/editor/search`、`searchExtensions` |
| 版本历史/最新版判定 | `pro-api/api.js` | `async function Qle(e)`、`async function eS(e,t)` |
| 更新检查与静默升级 | `pro-api/api.js` | `async function aU()`、`oU()`、`$le(e)`、`hookOnLogged` |
| 服务端指令式自动安装 | `pro-api/api.js` | `async function tue()`、`lU()`、`nue()` |
| 一键安装实现 | `pro-ui/ui.js` | `installExtension(...)`、`getExtensionVersionDetail(...)` |
| 扩展存储（IndexedDB） | `pro-api/api.js` | `extensionsIndex`、`extensionsObjectStorage`、`importExtensionPackages` |
| 安装包 MIME 白名单 | `pro-ui/ui.js` | `eWn`、`wbo(t,"extensionCode")` |
| 渲染层安全开关 | `Resources/app/app.js` | `webSecurity:!1` |
