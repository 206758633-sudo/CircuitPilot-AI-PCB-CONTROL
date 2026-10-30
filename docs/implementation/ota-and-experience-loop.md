# CircuitPilot 分发、OTA 与经验回流：没有云服务器怎么做

> 结论先说：**不需要自己运维服务器**。用"静态 HTTPS 托管 + 客户端验签"就能做 OTA；用"客户端导出脱敏经验包 + GitHub Issue/PR 人工审核"就能做经验回流。两者都不需要后端 API。
>
> 本文只写**当前仓库真实具备什么、缺什么、按什么顺序补**；不假装已经发布过。

---

## 0. 现状盘点（2026-10-29 实测）

| 事实 | 现状 | 对分发/OTA 的影响 |
|---|---|---|
| 桌面壳 | Tauri **2.8**（`src-tauri/Cargo.toml` `tauri = "2"`），bundle 目标 `dmg` / `app` | 可用官方 `tauri-plugin-updater` + `createUpdaterArtifacts` |
| 版本号 | `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`runtime/version.mjs` 各写一份；`scripts/check-macos-release.mjs` 有 `version-consistency` 门禁（**只校验、不改写**） | 发版前必须保证四处一致；建议加 `--sync` 一键改写并接 CI（见 §5 P0） |
| 更新器 | `tauri.conf.json` **没有** `plugins.updater` / `createUpdaterArtifacts`；`Cargo.toml` 没有 updater 插件 | 当前**没有任何 OTA 能力**，只能手动发 DMG |
| CI | `.github/workflows/ci.yml` 只有 Ubuntu 上的 typecheck/单测/e2e + Rust 编译检查 | **没有签名/打包/发布 job**；发布产物目前靠本机 `npm run desktop:release` |
| 代码签名 | 已装 `/Applications/CircuitPilot.app` 是 **ad-hoc 签名**，没有 Developer ID、没有公证（`docs/macos-signing.md` §0） | 对外分发前必须补 Apple Developer 账号 + 公证，否则 Gatekeeper 直接拦 |
| 知识资产 | `knowledge/pcb/dataset`（约 1.0 MB）、`docs/knowledge`（约 1.4 MB）**没有打进 app 资源**（`tauri.conf.json` 只打包 `docs/implementation`、`docs/wardrobe-case`） | 安装后的知识库是**空的或用户本地的**；"知识升级"必须另做**知识包**通道 |
| 外发策略 | `runtime/provider-egress.mjs`：per-action、只在用户点发送时外发、有脱敏预览、无后台自动上传 | 经验回流必须沿用同一合同：**默认不上传、可预览、显式提交** |
| 状态目录 | shell 把 state 固定到 macOS 应用数据目录（`resolve_state_dir`，可被 `CIRCUITPILOT_STATE_DIR` 覆盖） | OTA 覆盖 `.app` **不会**清掉知识库/台账；但知识包要单独写 state |

**一句话**：现在有"能打包的桌面壳 + 本地知识库"，但没有"分发后还能持续更新"的链路。下面分两条独立通道补齐。

---

## 1. 总体架构（两条通道，都不需要服务器）

```
                    ┌─────────────────────────────────────────────┐
                    │  静态 HTTPS（GitHub Releases / 对象存储/CDN） │
                    │  latest.json          ← 二进制更新清单        │
                    │  CircuitPilot.dmg     ← 已签名+公证的安装包   │
                    │  latest.json.sig      ← minisign 签名         │
                    │  knowledge-pack-*.zip ← 知识/经验包           │
                    └───────────────┬─────────────────────────────┘
                                    │ ①拉清单 ②下载 ③验签 ④原子安装
              ┌─────────────────────┴─────────────────────┐
              ▼                                           ▼
   ┌──────────────────────┐                    ┌──────────────────────┐
   │ 二进制 OTA（月更）    │                    │ 知识包（周更）        │
   │ Tauri updater 插件    │                    │ runtime 校验+合并     │
   │ 覆盖 .app，保留 state │                    │ 写 state/knowledge    │
   └──────────────────────┘                    └──────────────────────┘
              ▲                                           ▲
              │                                           │
   ┌──────────┴───────────────────────────────────────────┴──────────┐
   │ 经验回流（无服务器）：客户端「导出经验包」→ GitHub Issue/邮件 →     │
   │ 维护者用现有 review/merge 脚本审核 → 发布知识包 → 所有人收到        │
   └─────────────────────────────────────────────────────────────────┘
```

关键点：**"升级 CircuitPilot" 有两种，节奏不同**。

| 类型 | 内容 | 频率 | 是否重启 | 通道 |
|---|---|---|---|---|
| 二进制 | 代码/规则引擎/UI | 月更 | 需要 | Tauri updater |
| 知识包 | 知识条目、经验、文档语料 | 周更 | 不需要 | 自定义 pack + runtime 应用 |

把知识从二进制里拆出来，才能做到"用户不用升级也有新知识"；也避免每改一条经验就发一次版。

---

## 2. 二进制 OTA：静态源 + 客户端验签

### 2.1 用 Tauri 官方 updater（最小改动）

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-updater = "2"
tauri-plugin-process = "2"   # 更新后 relaunch
```

```json
// src-tauri/tauri.conf.json（新增）
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "endpoints": [
        "https://<你的静态源>/circuitpilot/latest.json",
        "https://<国内镜像>/circuitpilot/latest.json"
      ],
      "pubkey": "<tauri signer generate 输出的公钥>",
      "windows": { "installMode": "passive" }
    }
  }
}
```

- `endpoints` 支持**多个按顺序回退**：GitHub Releases 在国内不稳定时，第二个放阿里云 OSS/CDN 镜像（同一份文件，`latest.json` 里 URL 指向镜像也可以）。
- 私钥只放 CI Secret（`TAURI_SIGNING_PRIVATE_KEY`），**永不进仓库**；公钥写进 `tauri.conf.json`。
- 更新包内签名（minisign）由 Tauri 生成；安装前客户端必验签，验签失败**硬失败**并记日志，不重试、不降级。

`latest.json` 是**静态文件**，由 Tauri CLI 在打包时生成（`bundle.createUpdaterArtifacts=true` 会产出 `.app.tar.gz` + `.sig`），CI 里把它和 DMG 一起上传到 Release 资产即可：

```json
{
  "version": "0.3.0",
  "notes": "新增：复盘经验包；修复：……",
  "pub_date": "2026-11-02T10:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<.sig 内容>",
      "url": "https://github.com/<org>/<repo>/releases/download/v0.3.0/CircuitPilot_0.3.0_aarch64.app.tar.gz"
    }
  }
}
```

> 注意：`latest.json` 里的 `url` 必须指向**可匿名下载**的 HTTPS 地址。GitHub Release 资产对公开仓库天然满足；私有仓库需要 token，不建议给客户端发 token——所以**发布仓库要么公开，要么用对象存储**。

### 2.2 客户端更新流程（用户可感知、可拒绝）

| 步骤 | 行为 | 失败处理 |
|---|---|---|
| 检查 | 启动后延迟 10s 检查一次，之后每 24h 一次；设置页可"立即检查" | 断网/超时静默（只写本地日志），不打扰用户 |
| 提示 | 弹非阻塞横幅："有新版本 0.3.0（大小 92 MB）"，按钮：下载 / 稍后 / 跳过此版本 | 用户可永久跳过当前版本 |
| 下载 | 显示进度；可取消 | 取消即清理临时文件 |
| 校验 | Tauri 自动验 minisign 签名 + 平台包完整性 | 失败 → 红字提示"更新包校验失败"，保留旧版本，记录审计 |
| 安装 | 退出时安装或立即重启（`process.relaunch()`） | 安装失败回滚到旧版本目录（Tauri updater 自身保证原子替换） |

**红线**：不做静默强制更新；不自动重启应用；不把更新开关做成默认开启的"后台安装"。

### 2.3 发布流水线（GitHub Actions，macOS runner）

```
tag v0.3.0 ──► macOS runner
  1) npm ci && npm run typecheck && npm run test:coverage && npm run test:runtime
  2) tauri build（含 sidecar 编译、createUpdaterArtifacts）
  3) codesign --deep --force --options runtime --sign "Developer ID Application: …"
  4) xcrun notarytool submit --wait → xcrun stapler staple
  5) spctl --assess --type exec  （失败即中止，不发版）
  6) 生成/上传 release 资产：DMG、.app.tar.gz、.sig、latest.json
  7) 若 channel=beta：只更新 beta 源；stable 需人工手动 promote
```

- **没有 Apple Developer 账号时**，这条路走不通：ad-hoc 签名的 app 在别人机器上会被 Gatekeeper 拦。账号（$99/年）是**唯一无法用代码替代**的前置条件。
- 若暂时不想买：只能"内测分发"——让用户 `xattr -dr com.apple.quarantine` 或右键打开，且**不能自动更新**（更新后的包同样会被拦）。不建议长期这样。

### 2.4 频道、灰度与回滚

| 需求 | 无服务器做法 |
|---|---|
| 内测/灰度 | 两个静态 feed：`beta/latest.json`（内测用户手动启用 beta）→ 稳定后把同一份产物复制成 `stable/latest.json` |
| 按比例灰度 | 无服务器做不到精确百分比；用"beta 先行 3~7 天 + 观察 GitHub Issue/邮件反馈"替代。真要百分比，需要客户端按 `installId` 哈希自行判断是否接受（仍可绕过，不建议） |
| 回滚 | Tauri 默认拒绝降级。两种做法：① 发一个**更高版本号**的回滚版（如 `0.3.1-rollback.1`）；② `latest.json` 指回旧版本并附"已知问题，请手动下载旧版"链接（客户端不会自动降级）。**发布前保留最近 2 个版本的 DMG 下载链接** |
| 离线用户 | 更新检查静默失败；设置页给"手动下载"按钮，指向同一静态源 |

### 2.5 更新通道的安全性

| 风险 | 对策 |
|---|---|
| 更新包被篡改 | 客户端 minisign 验签，公钥编译进 app；HTTPS + 公钥双重校验 |
| 私钥泄露 | 私钥只存 CI Secret；泄露即轮换密钥并发一个"新公钥版本"（旧版本无法自动更新到新密钥，需手动下载，所以密钥轮换要提前规划） |
| 降级攻击 | 拒绝降级（Tauri 默认）；`latest.json` 只由 CI 生成 |
| 供应链 | `npm ci` + lockfile + 依赖审计（CI 已有 `npm audit --omit=dev`）；Release 资产由 CI 产出，不手工上传 |
| 更新后丢数据 | state 在应用数据目录（`resolve_state_dir`），不在 `.app` 内；新增迁移脚本时先备份 state |

---

## 3. 知识包：让"经验"比二进制更快到达用户

### 3.1 为什么必须单独做

当前 app 资源里**没有** `knowledge/pcb/dataset` 和 `docs/knowledge`（`tauri.conf.json` 只打包 `docs/implementation` / `docs/wardrobe-case`），所以装好的 CircuitPilot 知识库是空的（或只有用户自己导入的）。要让"CircuitPilot 越用越聪明"，知识必须在安装后持续到达，而不是跟着安装包一年更新一次。

### 3.2 包格式（静态文件，不需要服务器）

```
knowledge-pack-2026.11.1.zip
├── manifest.json
├── dataset/            # 与 knowledge/pcb/dataset 同构的片段
│   ├── parts.json
│   ├── modules.json
│   ├── rules.json
│   ├── failures.json
│   └── sources.json
└── docs/               # RAG 语料子集（可选）
```

```json
{
  "schemaVersion": 1,
  "packVersion": "2026.11.1",
  "appMinVersion": "0.3.0",
  "createdAt": "2026-11-01T02:00:00Z",
  "files": [{ "path": "dataset/parts.json", "sha256": "…", "bytes": 12345 }],
  "counts": { "parts": 60, "modules": 105, "rules": 168, "failures": 102 },
  "signature": { "alg": "ed25519", "keyId": "pack-2026", "value": "base64…" }
}
```

- 签名覆盖 `manifest` 去掉 `signature` 后的 canonical JSON + 每个文件 sha256；客户端用**编译进 app 的公钥**验签（与二进制更新密钥分离，便于独立轮换）。
- 包体 1~2 MB，走同一静态源；下载后**先验签再解压**，解压到临时目录，全部校验通过才原子切换。

### 3.3 客户端应用流程（runtime 侧，不重启 app）

| 步骤 | 做法 | 复用现有代码 |
|---|---|---|
| 检查 | `GET <static>/knowledge/latest.json`，对比本地 `state/knowledge/pack.json` | 新增 ~100 行 |
| 下载+验签 | ed25519 验 manifest + sha256 逐文件 | Node `crypto.verify` |
| 合并 | 按 `entityKey` 写入，**不覆盖用户本地已 approved 的条目**；冲突写 KMA 冲突台账 | `runtime/knowledge.mjs` + `knowledge-manager.mjs` |
| 重建索引 | 重新灌 RAG 语料（现有 seed 流程） | `scripts/seed-knowledge-pcb.mjs` 的逻辑搬进 runtime |
| 回滚 | 保留上一版目录 + `pack.json` 指针，失败自动切回 | 新 |
| 失败隔离 | 包坏了 → 保留旧知识，只告警；**绝不让知识包失败阻塞 app 启动** | 新 |

**审核策略（需要你拍板）**：

| 方案 | 包内条目状态 | 好处 | 风险 |
|---|---|---|---|
| A. 维护者签名即 approved（推荐） | `trust=reference` + `review=candidate` | 安全：与现有"只有人能 approved"完全一致 | 用户每台机器都要再点一次审核，体验差 |
| B. 签名包 = 已审核 | `trust=reference` + `review=approved` + `reviewedBy=pack:<id>` | 用户开箱即用；维护者就是审核人 | 需要严格保证发布前人工 review + 签名流程不可绕过 |

推荐 **B + 双保险**：`approved` 只在「manifest 验签通过 + 条目带 `sources`/`sourceHashes`」时生效；`authoritative` 仍只给标准/原厂来源；用户本地 approved 与包内冲突时**保留用户版本**并登记冲突，不静默覆盖。

### 3.4 更新节奏

- **周更**：知识包（新增踩坑、修正数值、补 sources）。
- **月更**：二进制（引擎/UI/规则校验逻辑）。
- `appMinVersion` 门禁：新包依赖新 schema 时，旧客户端跳过并在设置页提示"升级后可用"。
- 每个包附带 changelog（静态 `knowledge/changelog.md`），用户可看"这次学了什么"。

---

## 4. 收集用户经验：无服务器回流

### 4.1 原则（沿用现有外发合同）

`runtime/provider-egress.mjs` 已经把"外发"定义为 **per-action、用户点发送才发、可脱敏预览**。经验回流必须同样：

1. **默认不上传**：没有任何后台任务会把工程内容发出去；
2. **可预览**：导出前 UI 显示将包含什么（缺陷码、经验条数、哈希 ID），用户可取消；
3. **数据最小化**：默认不含项目名、板号、网络名、工程文件字节；
4. **可撤回**：导出是本地文件，用户不发给任何人都可以；
5. **可审计**：导出记录写本地审计（谁、什么时候、多少字节、sha256），不上传。

### 4.2 L0：导出经验包（**已实现，本轮**）

- 入口：知识库 → 复盘学习 Agent → **导出经验包**（`POST /api/knowledge/retro/export`）；
- 内容：`circuitpilot-experience-bundle` JSON，含缺陷码/严重级/次数、经验正文、证据 digest、脱敏策略、`bundleSha256`；
- 默认脱敏：项目/板号/UUID 只给 `sha256` 前 12 位；缺陷 message 默认丢弃；路径/邮箱/密钥统一 `redactSecrets`；不含工程文件；
- **不落盘、不上传**：服务端只生成响应，由浏览器/WebView 下载到用户本地；
- 用户手动通过 GitHub Issue、邮件、共享盘提交。

这是"零基础设施"的最小闭环：**用户愿意给才给**。

### 4.3 L1：社区知识仓库（推荐主渠道）

建一个**公开仓库**（如 `circuitpilot-experience`，与源码仓库分开，便于控制隐私与 license）：

| 环节 | 做法 | 复用现有能力 |
|---|---|---|
| 提交 | GitHub Issue Forms 两个模板：「提交复盘经验」「提交 badcase」；附上导出的 JSON（可手工贴关键字段） | 无 |
| 分诊 | 维护者打标签：`accepted` / `needs-evidence` / `duplicate` / `rejected`；每周批量处理 | 现有 `scripts/review-knowledge-dataset.mjs` |
| 入库 | 把经验整理成 `dataset/fragments/*.json`，走现有 merge + KMA 冲突检查 | `scripts/merge-knowledge-dataset.mjs` |
| 发布 | 打 tag → 自动生成知识包 + 签名 → 上传静态源 | 新增 `scripts/build-knowledge-pack.mjs` |
| 回馈 | 在 Issue 里回复"已进入 2026.11.1 知识包"，@提交者 | 无 |

好处：完全免费、公开可审计、天然带版本历史；坏处：需要维护者时间，且提交率取决于用户意愿。

### 4.4 L2：Serverless 收集（可选，流量大了再上）

如果 Issue 流程撑不住（比如几百人/周），再用**托管式 serverless**（仍不需要自己运维服务器）：

```
Cloudflare Worker（免费档） ──► R2/D1（免费档）
POST /v1/experience  { bundle, consentVersion, installId? }
  - 限流：IP + installId 每分钟 N 次
  - 校验：schemaVersion + bundleSha256 + 大小上限（1 MB）
  - 只存脱敏 bundle（不含工程文件）
  - 原始数据 90 天保留，聚合指标永久
```

客户端：本地 outbox（`state/experience-outbox`）+ 用户显式勾选"匿名上传"后才发；失败自动重试（最多 3 次）；设置页可查看/删除已排队内容。

替代方案（更省事）：**Supabase / Firebase 免费档**做同样的事，或直接用 **GitHub Issue API**（用户自带 token，只适合开发者用户，不适合普通用户）。

### 4.5 L3：产品遥测（可选，最小白名单）

只采**行为计数**、不采内容：

| 事件 | 字段 |
|---|---|
| 启动 | `appVersion`, `runtimeVersion`, `os`, `locale` |
| 功能使用 | `page`（枚举）、`action`（枚举），不含参数 |
| 规则运行 | `ruleId`, `verdict`（pass/fail/review）、`durationMs` |
| 错误 | `code`（枚举）、`message`（脱敏、截断 200 字） |

默认**关闭**，设置页显式勾选；匿名 `installId`（随机 UUID，可重置）；不采硬件 ID、不采工程名、不采网络名。

**"看不到采用率"的现实**：无服务器时拿不到精确 DAU。可用 GitHub Release 下载量 / 知识包下载量（静态源若有访问日志）作为代理指标；要精确数据只能上 L2/L3。

---

## 5. 落地路线（按依赖排序）

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **P0**（已完成，2026-10-30） | ① 版本一致性接 CI + `--sync` ② 发布清单脚本 ③ 经验包导出 ④ 知识包构建/校验脚本 | 无 | ✅ `npm run version:check` 绿 · `npm run release:manifest` 可用 · 导出包 `bundleSha256` 可校验 · 首个真实知识包 575 KB 构建+verify 通过 |
| **P1**（3~5 天，需 Apple Dev + 静态托管） | Tauri updater 接入 + CI 发布 job（签名/公证/staple/latest.json）+ stable/beta feed + 设置页更新 UI | Apple Developer 账号、公开仓库或对象存储 | 旧版本 → 新版本自动更新成功；篡改包被拒；旧版本 DMG 仍可下载 |
| **P2**（3~5 天，需经验仓库） | GitHub Issue Forms + 维护者打包发布脚本 + app 内"检查知识更新" | 经验仓库 | 提交经验 → 审核 → 新知识包 → 客户端一键更新 |
| **P3**（可选，1 周） | Serverless intake + 最小遥测白名单 | 免费 serverless 账号 | 显式同意才上传；可查看/删除；限流生效 |

**建议先做 P0，再决定买不买 Apple Developer**：P0 不花钱、不阻塞，能把"经验回流"先跑起来；P1 才是真正的 OTA，且必须依赖 Apple 证书。

### 5.1 P0 已实现（2026-10-30）

| 能力 | 入口 | 用法 / 结果 |
|---|---|---|
| 版本一致性检查/同步 | [`scripts/sync-version.mjs`](../../scripts/sync-version.mjs) | `npm run version:check`（CI 已接入，不一致退出 1）· `npm run version:sync`（以 `runtime/version.mjs` 为准改写另外三处，幂等） |
| 发布产物清单 | [`scripts/release-manifest.mjs`](../../scripts/release-manifest.mjs) | `npm run release:manifest` 生成 `artifacts/release/release-manifest.json`（版本/commit/产物大小/sha256/签名探测）；`--verify <file>` 在发布前复核，篡改或缺失即退出 1 |
| 知识包构建/校验 | [`scripts/knowledge-pack.mjs`](../../scripts/knowledge-pack.mjs) | `build --pack-version 2026.10.30 [--key <ed25519.pem> --key-id …] [--validate]`；`verify <pack.json> [--pubkey <pem>]`；未签名包明确标 `unsigned`，不冒充已签名 |
| 经验回流 Issue 模板 | `.github/ISSUE_TEMPLATE/experience-report.yml` / `badcase-report.yml` | 用户在 GitHub 提交时自带字段：版本、场景、现象→原因→预防、导出的 JSON、脱敏与 CC BY 4.0 授权 |
| CI 门禁 | `.github/workflows/ci.yml` | `Install dependencies` 之后新增 `Version consistency`（不一致直接红）+ `Knowledge pack build + verify`（数据集坏了/文档指针缺失直接红） |

首个真实知识包（未签名，用于验证构建链）：

```bash
node scripts/knowledge-pack.mjs build --pack-version 2026.10.30 --app-min 0.2.0 --validate
# ok: counts { rule: 163, module: 88, part: 57, failure: 97 } · 575,117 bytes
# contentSha256: ec9e837b…f60822 · signature: unsigned
node scripts/knowledge-pack.mjs verify artifacts/release/knowledge-pack-2026.10.30.json
# { "ok": true, "signature": "unsigned", "problems": [] }
```

签名与发布（P1 用）：

```bash
# 1) 生成 ed25519 密钥对（私钥只放 CI Secret，公钥编译进 app 用于验签）
openssl genpkey -algorithm ED25519 -out circuitpilot-pack.key
openssl pkey -in circuitpilot-pack.key -pubout -out circuitpilot-pack.pub
# 2) 签名打包
node scripts/knowledge-pack.mjs build --pack-version 2026.11.1 --key circuitpilot-pack.key --key-id pack-2026
# 3) 客户端/发布前校验
node scripts/knowledge-pack.mjs verify artifacts/release/knowledge-pack-2026.11.1.json --pubkey circuitpilot-pack.pub
```

> 注意：`artifacts/release/*` 是本地产物，不进仓库；知识包真正发布时上传到 §2 的同一静态源（`knowledge/latest.json` + `knowledge-pack-<version>.json`），并保留上一版用于回滚。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 没有 Apple 证书 → 用户装不上/更新不了 | 先内测分发（明确告知右键打开）；正式发布前必须买账号；不要把 ad-hoc 包当正式版 |
| 更新源在国内不可达 | 双 endpoint（GitHub + 国内 OSS/CDN 镜像）；`latest.json` 里 URL 指向镜像 |
| 更新包被篡改 | minisign + HTTPS + 公钥编译进 app；失败硬停 |
| 知识包污染/幻觉 | 维护者审核 + sources/sourceHashes + 签名；`authoritative` 只给标准/原厂；用户本地 approved 不被覆盖 |
| 隐私合规（PIPL/GDPR） | 默认不上传；导出前预览；数据最小化；保留删除/撤回；L2 原始数据 90 天 |
| 无遥测 → 不知道采用情况 | GitHub Release/知识包下载量作为代理；用户反馈 Issue；后续可选 L3 |
| 知识包更新破坏 RAG/审核状态 | 保留上一版目录 + 引用计数；失败自动回滚；包只写 `source=knowledge-pack` 的条目 |

---

## 7. 需要你拍板的三件事

| # | 决策 | 推荐 | 影响 |
|---|---|---|---|
| 1 | 静态托管放哪 | **GitHub Releases（公开仓库）+ 国内 OSS/CDN 镜像** | 免费、有审计历史；国内用户可达性靠镜像 |
| 2 | 知识包内条目是否"签名即 approved" | **方案 B + sources 双保险**（见 §3.3） | 用户开箱即用 vs 严格人工审核 |
| 3 | 经验回流主渠道 | **L1 GitHub Issue/PR（P1~P2）**，L2 serverless 作为后续 | 决定维护者工作量与提交率 |

另需准备：**Apple Developer Program 账号（$99/年）**——这是 P1 唯一无法用代码绕过的前置条件。

---

## 8. 本轮已落地的代码

| 能力 | 位置 | 验证 |
|---|---|---|
| 经验包构建 + 默认脱敏 + 稳定哈希 | `runtime/agents/retrospective-learner.mjs` `buildExperienceBundle` | 单测：ID 哈希、message 丢弃、路径/邮箱擦除、哈希稳定 |
| HTTP 导出（不写库、不落盘） | `POST /api/knowledge/retro/export` | HTTP 契约测试：200/409、知识库文件数不变、无 retrospective 证据 |
| UI 入口 + 本地下载 | 知识库 → 复盘学习 Agent → 「导出经验包」 | 页面 smoke + tsc |
| 经验包 schema | `circuitpilot-experience-bundle` v1，含 `bundleSha256` | 提交后维护者可校验完整性 |
| 版本一致性（P0-01） | `scripts/sync-version.mjs` + CI 步骤 | 单测 4 组；真实仓库检查通过 |
| 发布清单（P0-02） | `scripts/release-manifest.mjs` | 单测 4 组（篡改/缺失/空目录均被抓出） |
| 知识包（P0-03） | `scripts/knowledge-pack.mjs`（构建 + ed25519 签名 + 校验） | 单测 4 组；真实数据集构建 575 KB / verify 通过 |
| 回流表单 | `.github/ISSUE_TEMPLATE/{experience,badcase}-report.yml` | 字段含版本/场景/脱敏授权/JSON |

尚未做（等决策/凭证）：updater 接入、CI 发布、签名公证、知识包应用器、服务端/serverless 收集。
