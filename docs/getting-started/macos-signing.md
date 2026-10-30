# macOS 签名 / 公证手册：从 ad-hoc 到 Developer ID + 公证

> 适用对象：CircuitPilot 桌面应用（Tauri 2 + Node sidecar）。
> 本文只讲**怎么把 .app 变成能对外分发、能被 Gatekeeper 放行的产物**，以及需要用户提供哪些凭证。
> 配套的只读体检脚本：`node scripts/check-signing-readiness.mjs`（结论落盘到 `artifacts/release-gate-real/signing-readiness-<ts>.json/.md`）。

---

## 0. 一句话结论（当前实测状态）

当前安装的 `/Applications/CircuitPilot.app` **只是 ad-hoc（linker-signed）**，不能对外分发：

| 事实 | 实测（<DATE>，见 signing-readiness 报告） | 含义 |
|---|---|---|
| `codesign -dv` | `Signature=adhoc`、`flags=adhoc,linker-signed`、`TeamIdentifier=not set` | 只适合本机开发运行 |
| `Contents/_CodeSignature/CodeResources` | **不存在** | bundle 不是被完整签名过的 .app（`codesign --verify --deep --strict` 失败） |
| `spctl -a -t exec` | 拒绝：`code has no resources but signature indicates they must be present` | 用户机器上双击会被 Gatekeeper 拦 |
| `xcrun stapler validate` | 没有装订公证票据 | 未公证 |
| `security find-identity -v -p codesigning` | 只有 1 个 `Apple Development: <TEAM_ID> (<CERT_ID>)` | **没有 Developer ID Application，无法分发** |
| `xcrun notarytool` | 可用（`1.1.2 (41)`） | 工具在，缺的是凭证与证书 |
| `src-tauri/tauri.conf.json` | `hardenedRuntime=true`、`entitlements=entitlements.plist` | 构建配置已声明硬化运行时，但产物实际未按分发签名 |
| 内嵌 Node sidecar | 官方 Node.js 二进制，`Developer ID Application: Node.js Foundation (HX7739G8FX)`，自带 `get-task-allow` 等调试 entitlement | 正式发布前要处理（见 §3.2） |

**这些缺口的本质：证书与公证凭证属于用户账号/外部 Apple 服务，代码仓库和 CI 无法"自己变出来"。** 本仓库不做、也不应该做：下载证书、伪造签名、伪造公证结论。

---

## 1. 先把概念分清（否则会白折腾）

| 概念 | 作用 | 失败表现 |
|---|---|---|
| **代码签名（codesign）** | 证明"这个二进制是谁打的包、有没有被改过" | Gatekeeper 提示"无法验证开发者" / `codesign --verify` 失败 |
| **Hardened Runtime** | 给运行时加硬化限制（JIT、dylib 注入等都要显式 entitlement） | 公证拒绝，或应用启动即崩 |
| **公证（notarization）** | 把产物提交 Apple 扫描，Apple 发一个"我已检查过"的票据 | 未公证的 app 首次运行被拦（macOS 10.15+） |
| **装订（staple）** | 把公证票据嵌进 .app/.dmg，离线也能验 | `stapler validate` 失败；离线机器上被拦 |
| **ad-hoc 签名** | 本地链接器给的临时签名，没有身份 | 只能本机跑，不能分发 |
| **Apple Development 证书** | 开发者本机调试用 | **不能**用于对外分发 |
| **Developer ID Application 证书** | 对外分发（DMG/直接下载）用的签名身份 | 没有它就只能停在 ad-hoc |

本项目的 `entitlements.plist` 目前只有：

```xml
com.apple.security.network.client  = true
com.apple.security.network.server  = true
```

（运行时要监听 `127.0.0.1` 并与前端/EDA 桥通信，这两条是必需的。）

---

## 2. 前置条件（全部属于"用户必须提供"的边界）

1. **Apple Developer Program 账号（付费，个人 $99/年 或公司）** —— 免费账号没有 Developer ID。
2. **Team ID**（10 位，如 `HX7739G8FX`）—— 在 Apple Developer → Membership 里看。
3. **Developer ID Application 证书 + 私钥**
   - 最省事：Xcode → Settings → Accounts → 登录账号 → Manage Certificates → `+` → **Developer ID Application**（Xcode 会自动把证书和私钥放进钥匙串）。
   - 手工：developer.apple.com → Certificates → `+` → Developer ID Application → 生成 CSR（钥匙串访问 → 证书助理）→ 上传 → 下载 `.cer` → 双击导入。**私钥必须在你生成 CSR 的那台机器上**（或在团队里导出 `.p12` 交接）。
4. **公证凭证（三选一）**
   - **推荐：App Store Connect API Key**：Users and Access → Integrations → App Store Connect API → 生成 Key（下载 `.p8`，只能下载一次），记录 **Issuer ID / Key ID / .p8 路径**。
   - Apple ID + **app-specific password**（appleid.apple.com 生成）+ Team ID。
   - 已存进钥匙串的 notarytool profile 名（`xcrun notarytool store-credentials <profile>`）。
5. **Xcode / Command Line Tools**（`xcrun notarytool` 已确认可用）。
6. 目标机器：macOS 12+（本项目 `LSMinimumSystemVersion=12.0`）。

> **凭证纪律**：`.p8`、`.p12`、app-specific password、issuer/key id **一律不进仓库、不进报告、不进日志**。
> 推荐做法：`xcrun notarytool store-credentials "circuitpilot-notary" --apple-id ... --team-id ... --password ...`
> 之后命令里只出现 `--keychain-profile "circuitpilot-notary"`。本仓库的只读检查脚本只检查"环境变量是否声明/身份是否存在"，**不读取值**。

---

## 3. 完整步骤

### 3.1 准备一个"干净的、结构化正确"的 .app

**当前问题的直接原因之一**：安装到 `/Applications` 的 app 没有 `_CodeSignature/CodeResources`，`codesign --verify` 报
`code has no resources but signature indicates they must be present`。常见成因：

- 手工 `cp -R` 或某些安装脚本复制时丢掉了 `_CodeSignature` 目录；
- 先签名、后往 bundle 里塞 `Resources/`（runtime、manufacturing）——签名封条立刻失效；
- 直接对"已经 install 到 /Applications 的旧包"反复改内容。

正确做法：

```bash
# 1) 构建干净产物（注意：本任务（T6）只写文档，不跑 desktop:build；Lead 统一负责构建）
npm run sidecar:stage          # 确认 src-tauri/binaries/node-* 已就位
npm run desktop:release-check  # 预检版本/sidecar/证书/公证凭证/hdiutil（见 scripts/check-macos-release.mjs）
npx tauri build --bundles app  # 产物：src-tauri/target/release/bundle/macos/CircuitPilot.app

# 2) 从 bundle 产物直接做签名与公证，**不要**先拷到 /Applications 再改
# 3) 安装到 /Applications 时用 ditto（保留签名/扩展属性）而不是 cp -R：
sudo rm -rf /Applications/CircuitPilot.app
ditto "src-tauri/target/release/bundle/macos/CircuitPilot.app" /Applications/CircuitPilot.app
```

> 如果你必须先改 bundle 内容（例如替换 runtime），**改完再签**，不要签完再改。

### 3.2 entitlements：主程序与 Node sidecar 分开设计

主程序（`CircuitPilot.app` / `Contents/MacOS/circuitpilot`）最小集：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- 运行时需要本机回环网络：起 sidecar、和 EDA 桥/前端通信 -->
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.network.server</key><true/>
  <!-- 若用到 WebView 自动化/截屏（EDA GUI 取证），按需再加：
  <key>com.apple.security.automation.apple-events</key><true/>
  -->
</dict>
</plist>
```

Node sidecar（`Contents/MacOS/node`）**必须**保留 V8 需要的最小 JIT 能力（否则启动即崩）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
```

注意：

- 官方 Node.js 二进制当前签名带 `com.apple.security.get-task-allow`（调试用）以及 `disable-executable-page-protection`、`disable-library-validation` 等放宽项。**`get-task-allow` 是公证审核的常见拒绝项**，正式发布前建议用你自己的 Developer ID **重签 sidecar**，并只保留上面最小 JIT 集（去掉 `get-task-allow`）。
- 不要给主程序加 `com.apple.security.cs.disable-library-validation` 除非确实要加载未签名 dylib。
- 不要加 `com.apple.security.app-sandbox`（本项目不是 App Store 沙箱应用；加了会改变文件/网络行为）。

### 3.3 签名（顺序：先内层，后外层；不要迷信 `--deep`）

```bash
APP="src-tauri/target/release/bundle/macos/CircuitPilot.app"
IDENTITY="Developer ID Application: Your Name (TEAMID)"   # security find-identity -v -p codesigning 里的完整名字

# 1) 内嵌二进制 / dylib / framework 先签（外部 Binaries 也要签）
codesign --force --timestamp --options runtime \
  --entitlements src-tauri/sidecar-node.entitlements.plist \
  --sign "$IDENTITY" "$APP/Contents/MacOS/node"

# 如有其它内嵌可执行文件/框架，依次签；本项目当前只有 node sidecar。

# 2) 主可执行文件
codesign --force --timestamp --options runtime \
  --entitlements src-tauri/entitlements.plist \
  --sign "$IDENTITY" "$APP/Contents/MacOS/circuitpilot"

# 3) 整个 app bundle（最后签，生成 _CodeSignature/CodeResources）
codesign --force --timestamp --options runtime \
  --entitlements src-tauri/entitlements.plist \
  --sign "$IDENTITY" "$APP"

# 4) 校验（这一步必须过，否则后面公证必拒）
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP"        # 期望：Developer ID Application + TeamIdentifier + flags=runtime
```

要点：

- `--timestamp` 必须有（公证要求可信时间戳；离线签会失败）。
- `--options runtime` 必须与 `hardenedRuntime=true` 一致。
- 签完后**不要再改 bundle 内任何文件**（哪怕改一个 txt 都会让封条失效）。
- 不要用 `--deep` 去"一把签"：Apple 明确不推荐，且容易漏签/错签 entitlements。先内层后外层。

### 3.4 公证（notarytool）

先确认凭证可用（二选一）：

```bash
# 方式 A：App Store Connect API Key（推荐）
#   - 把 AuthKey_XXXX.p8 放到安全位置（不要进仓库）
#   - issuer id / key id 从 App Store Connect 获取
xcrun notarytool submit "$APP_ZIP" \
  --issuer "$APPLE_API_ISSUER" --key-id "$APPLE_API_KEY" --key "$APPLE_API_KEY_PATH" \
  --wait

# 方式 B：存进钥匙串的 profile（最省事，凭证不出现在命令行历史）
xcrun notarytool store-credentials "circuitpilot-notary" \
  --apple-id "you@example.com" --team-id "TEAMID" --password "<app-specific-password>"
xcrun notarytool submit "$APP_ZIP" --keychain-profile "circuitpilot-notary" --wait
```

提交物选择：

```bash
# 提交 .app：先压成 zip（保留符号链接与权限）
ditto -c -k --keepParent "$APP" "CircuitPilot.zip"
xcrun notarytool submit "CircuitPilot.zip" --keychain-profile "circuitpilot-notary" --wait

# 也可以提交 .dmg（先公证 app→装订→再做 dmg→签 dmg→公证 dmg→装订 dmg）
```

看结果：

```bash
xcrun notarytool log <submission-id> --keychain-profile "circuitpilot-notary"
```

`status: Accepted` 才算通过。`Invalid` 时会给出逐个二进制的原因（常见为 hardened runtime 未启用、entitlement 不当、内嵌二进制未签名/被改）。

### 3.5 装订票据 + Gatekeeper 复验

```bash
xcrun stapler staple "$APP"          # 若是 dmg 分发的，也 staple 一次 dmg
xcrun stapler validate "$APP"
spctl --assess --type exec --verbose=4 "$APP"   # 期望：accepted，source=Notarized Developer ID
```

最终验证（**必须**）：在一台**从未装过开发者证书**的 Mac 上，从下载的 DMG/zip 安装并双击启动，确认：

- 不出现"无法验证开发者/已损坏"；
- 首次启动不要求右键打开绕过；
- 应用功能（启动 sidecar、连 EDA 桥、读工程）正常。

### 3.6 让 Tauri 构建自动化（可选，但建议）

Tauri 2 会用这些环境变量自动签名/公证（不同版本变量名可能略有差异，以 `tauri build --help` 与官方文档为准）：

| 变量 | 用途 |
|---|---|
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: ...` |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` | CI 里导入 .p12（base64 + 密码） |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Apple ID 公证 |
| `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH` | API Key 公证（CI 推荐） |

CI/本机都建议先跑本仓库的只读检查：

```bash
node scripts/check-signing-readiness.mjs   # 本文档配套：检查证书/票据/结构/配置，缺什么列什么
npm run desktop:release-check              # 构建前预检：版本/sidecar/证书/凭证/hdiutil
```

---

## 4. 常见失败与诊断

| 现象 | 根因 | 处理 |
|---|---|---|
| `code has no resources but signature indicates they must be present` | bundle 结构/封条不一致（手工复制丢 `_CodeSignature`，或签名后又改了 bundle 内容） | 从干净 `tauri build` 产物重签；安装用 `ditto`；**改内容必须在签名之前** |
| `code object is not signed at all` | 内嵌二进制（node、dylib、framework）没签 | 先签内层可执行/dylib，最后签 .app |
| `The executable does not have the hardened runtime enabled` | 签名漏了 `--options runtime` | 重签并加 `--options runtime`；核对 `hardenedRuntime=true` |
| 公证 `Invalid`，日志指向 `get-task-allow` | 内嵌二进制带调试 entitlement | 用自己 Developer ID 重签 sidecar，去掉 `get-task-allow` |
| 公证 `Invalid`，日志指向某个 `.dylib`/`node` | 内嵌二进制未签名或被改动 | 逐个签名；签后不要改 |
| `errSecInternalComponent` / 钥匙串报错 | 钥匙串被锁/无权限 | `security unlock-keychain ~/Library/Keychains/login.keychain-db` |
| notarytool 401/403 | 凭证/Team ID 不匹配或 app-specific password 用成了登录密码 | 重新生成 app-specific password / 核对 issuer+key id / 用 API Key |
| `stapler: does not have a ticket` | 没公证或没装订 | 先 `notarytool submit --wait` 通过，再 `stapler staple` |
| Gatekeeper 说"已损坏，应移到废纸篓" | 未公证 + 有 quarantine 属性 | 正式修复是公证+装订；临时自测可 `xattr -dr com.apple.quarantine <app>`（**不可作为交付方案**） |
| 应用启动即崩（V8/JIT） | sidecar 缺 JIT entitlements 或硬化运行时禁止未签名内存 | 给 sidecar 最小 JIT entitlements 并重签 |
| DMG 能装但 app 被拦 | 只公证了 dmg 没公证/签名 app（或反之） | app 与 dmg 各自签名+公证+装订；顺序见 §3.4 |

---

## 5. 凭证边界（必须由用户提供，仓库不保存）

| 凭证 | 谁提供 | 存放建议 | 本仓库行为 |
|---|---|---|---|
| Apple Developer Program 账号 / Team ID | 用户 | Apple ID 账号 | 不接触 |
| Developer ID Application 证书 + 私钥 | 用户 | 钥匙串（或 CI secret 的 .p12） | 只读检查"是否存在有效身份" |
| App Store Connect API `.p8` + Issuer ID / Key ID | 用户 | 本机密钥目录 / CI secret | 不读取、不写入报告 |
| Apple ID app-specific password | 用户 | `notarytool store-credentials` 存钥匙串 | 不读取 |
| 公证 profile 名 | 用户 | 钥匙串 | 只检查 notarytool 可用性 |
| 已公证产物（.app/.dmg） | 构建流程 | release/ | 本任务不构建、不重签、不安装 |

**不能自动化/不能代替的部分**：证书申请、Team 审核、公证提交（需要网络+凭证）、在他人 Mac 上的 Gatekeeper 实机验证。

---

## 6. 当前缺口清单 → 操作顺序

1. [ ] 用户提供 **Developer ID Application 证书 + 私钥**（否则后续全部无法开始）。
2. [ ] 用户提供 **公证凭证**（API Key 或 app-specific password + Team ID），建议 `notarytool store-credentials`。
3. [ ] 从**干净构建产物**重签（先 node sidecar 的 JIT entitlements，再主程序，再 .app；`--timestamp --options runtime`）。
4. [ ] `codesign --verify --deep --strict` 通过（当前失败，原因：`_CodeSignature` 缺失）。
5. [ ] `notarytool submit --wait` 得到 `Accepted`。
6. [ ] `stapler staple` + `stapler validate` 通过（当前失败：没有票据）。
7. [ ] `spctl -a -vvv` 返回 `accepted`（当前拒绝）。
8. [ ] 另一台干净 Mac 上双击验证（Gatekeeper 放行 + 功能正常）。
9. [ ] 完成后重跑 `node scripts/check-signing-readiness.mjs`，`readyForDistribution` 应为 `true`。

> 注意：本手册描述的是 **app 分发门禁**，与 PCB 的**放行门禁**（`/api/eda/release/gate`）是两码事：
> 一个决定"这个 app 能不能发给用户"，一个决定"这块板能不能下单"。两者都不能靠伪造证据通过。

---

## 7. 复现本文档的实测依据

```bash
node scripts/check-signing-readiness.mjs
codesign -dv --verbose=4 /Applications/CircuitPilot.app
codesign --verify --deep --strict --verbose=2 /Applications/CircuitPilot.app
spctl --assess --type exec --verbose=4 /Applications/CircuitPilot.app
xcrun stapler validate /Applications/CircuitPilot.app
security find-identity -v -p codesigning
xcrun notarytool --version
```

输出会落到 `artifacts/release-gate-real/signing-readiness-<ts>.json` 与同名 `.md`，其中包含每条命令的原始输出（凭证/令牌不会被记录）。
