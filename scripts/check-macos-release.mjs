// macOS 发布门禁。
//
// 为什么需要它：发布路径上有几类问题只有在跑到最后一步才会暴露，
// 最典型的是 `hdiutil` 无法创建磁盘映像（受限/无 GUI 会话、无 Finder 自动化权限），
// 结果 `tauri build` 先花几分钟编译，最后一步才失败。这里把能提前判定的条件都前置，
// 并且把“版本号多处不一致”“sidecar 没打进去”这类会导致交付物错误的问题也纳入门禁。
//
// 退出码：存在 blocker 级失败时返回 1（fail closed）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
function check(id, passed, detail, blocker = true) {
  checks.push({ id, passed, detail, blocker });
}
function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', cwd: root });
}

// 1) Rust 工具链
for (const command of ['cargo', 'rustc']) {
  const result = run(command, ['--version']);
  check(command, result.status === 0, result.status === 0 ? (result.stdout || result.stderr).trim() : `${command} 未安装`);
}

// 2) 目标平台（决定 sidecar 文件名与外挂二进制架构）
const rustc = run('rustc', ['-vV']);
const triple = /^host:\s*(\S+)$/m.exec(rustc.stdout || '')?.[1];
check('target-triple', Boolean(triple), triple || '无法从 rustc -vV 解析目标平台');

// 3) 版本号单一数据源：三处声明必须与 runtime/version.mjs 一致
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tauriConfig = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const cargoToml = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
const versionModule = fs.readFileSync(path.join(root, 'runtime/version.mjs'), 'utf8');
const sourceVersion = /RUNTIME_VERSION\s*=\s*'([^']+)'/.exec(versionModule)?.[1];
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
const versions = {
  'runtime/version.mjs': sourceVersion,
  'package.json': packageJson.version,
  'tauri.conf.json': tauriConfig.version,
  'Cargo.toml': cargoVersion,
};
check('version-consistency', new Set(Object.values(versions)).size === 1 && Boolean(sourceVersion), `版本声明：${JSON.stringify(versions)}`);

// 4) Node sidecar 必须已经打好包，否则发布版会依赖用户机器上是否装了 Node
const sidecar = triple ? path.join(root, 'src-tauri', 'binaries', `node-${triple}`) : null;
if (sidecar && fs.existsSync(sidecar)) {
  const probe = spawnSync(sidecar, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  check('runtime-sidecar', probe.status === 0, `${path.relative(root, sidecar)} 可执行（${(fs.statSync(sidecar).size / 1024 / 1024).toFixed(0)} MB）`);
} else {
  check('runtime-sidecar', false, `缺少打包用的 Node sidecar：${sidecar ? path.relative(root, sidecar) : '未知平台'}，请先运行 npm run sidecar:stage`);
}

// 5) Hardened Runtime 需要 entitlements 文件
check('entitlements', fs.existsSync(path.join(root, 'src-tauri', 'entitlements.plist')), 'src-tauri/entitlements.plist');

// 6) 代码签名与公证凭证
const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
check('developer-id', /Developer ID Application/.test(identities.stdout || ''), '需要有效的 Developer ID Application 证书');
check('apple-team', Boolean(process.env.APPLE_TEAM_ID), process.env.APPLE_TEAM_ID ? 'APPLE_TEAM_ID 已提供' : 'APPLE_TEAM_ID 未提供');
const notaryConfigured = Boolean(process.env.APPLE_API_ISSUER && process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_PATH)
  || Boolean(process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID);
check('notary-credentials', notaryConfigured, notaryConfigured ? '已检测到公证凭证变量' : '未提供 App Store Connect API Key 或 Apple ID 公证凭证');

// 7) DMG 能力探测：受限环境下 hdiutil 会被拒绝，提前失败比编译到最后一步再失败好得多。
// 注意输出映像必须放在源目录之外，否则 hdiutil 会以“目录非空”为由失败，掩盖真实原因。
const probeSource = fs.mkdtempSync(path.join(os.tmpdir(), 'circuitpilot-dmg-src-'));
const probeOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'circuitpilot-dmg-out-'));
let dmgProbe;
try {
  fs.writeFileSync(path.join(probeSource, 'probe.txt'), 'probe');
  const image = path.join(probeOutput, 'probe.dmg');
  const result = spawnSync('/usr/bin/hdiutil', ['create', '-volname', 'CircuitPilotProbe', '-srcfolder', probeSource, '-ov', '-format', 'UDZO', image], { encoding: 'utf8' });
  if (result.status === 0 && fs.existsSync(image)) {
    dmgProbe = { passed: true, detail: 'hdiutil 可以创建磁盘映像' };
  } else {
    const reason = `${result.stderr || result.stdout || ''}`.trim().split('\n').filter(Boolean).pop() || '未知原因';
    dmgProbe = { passed: false, detail: `hdiutil 无法创建磁盘映像：${reason}（受限或无 GUI 会话下属于预期；此时可用 npm run desktop:app 只产出 .app）` };
  }
} finally {
  fs.rmSync(probeSource, { recursive: true, force: true });
  fs.rmSync(probeOutput, { recursive: true, force: true });
}
check('dmg-capability', dmgProbe.passed, dmgProbe.detail);

// hdiutil 可用并不代表 DMG 一定能打包成功：bundle_dmg.sh 之后还会用 AppleScript 让 Finder
// 摆好安装窗口。这一步在无 GUI 会话或未授权“自动化”时会报 -10004（权限违例），
// 表现为编译与 hdiutil 都成功、却在最后一步失败并残留一个已挂载的临时卷。
// 之前只探测 hdiutil 会漏掉这种情况，所以这里单独探测 Finder 自动化。
const finder = run('/usr/bin/osascript', ['-e', 'tell application "Finder" to get name of startup disk']);
check(
  'dmg-window-automation',
  finder.status === 0,
  finder.status === 0
    ? 'Finder 自动化可用（DMG 安装窗口布局步骤可执行）'
    : `Finder 自动化不可用：${`${finder.stderr || finder.stdout}`.trim().split('\n').filter(Boolean).pop() || '未知原因'}（bundle_dmg.sh 用它摆安装窗口。在受限沙箱下它与 hdiutil 一起失败，因而无法单独隔离它的影响；只有在 hdiutil 正常、仅缺 macOS“自动化”授权时才可能单独导致最后一步失败）`,
  // 非阻断项：hdiutil 那关已经覆盖沙箱类失败；此项仅作提示，
  // 以免在“其实能打出 .dmg”的环境里误判整体不可发布。
  false,
);

const blockedBy = checks.filter((item) => item.blocker && !item.passed);
console.log(JSON.stringify({ ready: blockedBy.length === 0, blockedBy: blockedBy.map((item) => item.id), checks }, null, 2));
if (blockedBy.length) process.exit(1);
