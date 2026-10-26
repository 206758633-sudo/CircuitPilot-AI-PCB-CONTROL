#!/usr/bin/env node
/**
 * T6：macOS 代码签名 / 公证就绪检查（**只读**，不改 app、不重签、不联网）。
 *
 * 为什么要有它：当前 /Applications/CircuitPilot.app 是 ad-hoc（linker-signed）打包，
 * 双击能跑不等于能分发——Gatekeeper 会拦、别人机器上会弹"无法验证开发者"。
 * 而"能不能分发"取决于一串外部事实（证书、公证凭证、bundle 结构、entitlements），
 * 这些事实必须逐个用系统命令**实测**后如实写进报告，不能凭印象说"应该可以"。
 *
 * 纪律：
 *   - 只跑只读命令（codesign -dv / --verify / -d --entitlements、spctl -a、stapler validate、
 *     security find-identity、xcrun --find/--version、plutil、file、ls）；
 *   - 不调用 `security find-generic-password` 之类可能暴露用户密码项的命令，不读取任何密钥/令牌值；
 *   - 不尝试签名、不尝试公证、不联网、不下载证书；
 *   - 找不到证书/凭证就如实写"缺"，并标注它属于**用户必须提供的凭证边界**。
 *
 * 用法：node scripts/check-signing-readiness.mjs
 * 环境变量：
 *   CIRCUITPILOT_APP_PATH     被检查的 .app 路径（默认 /Applications/CircuitPilot.app）
 *   CIRCUITPILOT_RELEASE_DIR  输出目录（默认 artifacts/release-gate-real）
 *
 * 退出码：存在 blocker 级就绪缺口 → 1（fail closed）；全部通过 → 0。
 * 无论退出码如何，JSON + Markdown 报告都会落盘（"检查跑成功"与"就绪结论"是两件事）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const APP = process.env.CIRCUITPILOT_APP_PATH || '/Applications/CircuitPilot.app';
const OUT_DIR = process.env.CIRCUITPILOT_RELEASE_DIR || join(ROOT, 'artifacts', 'release-gate-real');
const GENERATED_AT = new Date().toISOString();
const STAMP = GENERATED_AT.replace(/[:.]/g, '-');
const JSON_PATH = join(OUT_DIR, `signing-readiness-${STAMP}.json`);
const MD_PATH = join(OUT_DIR, `signing-readiness-${STAMP}.md`);
const YAML_PATH = join(OUT_DIR, `signing-readiness-${STAMP}.yaml`);

const checks = [];
const record = (check) => {
  const entry = {
    id: check.id,
    title: check.title,
    category: check.category || 'inspect',
    status: check.status,
    detail: check.detail ?? null,
    command: check.command ?? null,
    exitCode: check.exitCode ?? null,
    output: check.output ?? null,
    data: check.data ?? null,
  };
  checks.push(entry);
  return entry;
};
const truncate = (value, max = 2400) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…（截断，原始共 ${text.length} 字符）` : text;
};
const sha256File = (path) => {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
};

/** 跑一条只读命令并记录真实 stdout/stderr/exitCode（不吞失败）。 */
function run(command, args, { timeoutMs = 30_000, cwd = ROOT } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, cwd, maxBuffer: 8 * 1024 * 1024 });
  return {
    command: [command, ...args].join(' '),
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

/** 把一条命令的复合输出（stdout+stderr）收成可直接引用的文本。 */
const combined = (result) => [result.stdout, result.stderr].filter((item) => item && item.trim()).join('\n').trim();

/** 解析 codesign -dv --verbose=4 的 key=value 行（Authority 会出现多行，单独收集）。 */
function parseCodeSignDv(text) {
  const fields = {};
  const authorities = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9 ]*?)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (key === 'Authority') { authorities.push(value); continue; }
    fields[key] = value;
  }
  if (authorities.length) fields.Authority = authorities.join(' → ');
  return { fields, authorities };
}

/** 从 codesign 输出推断签名类型（Signature= 行不一定存在，provisioning/authority 行才是分发签名）。 */
function classifySignature({ fields = {}, authorities = [], flags = [] }) {
  if (fields.Signature) return fields.Signature;
  if (flags.includes('adhoc') || flags.includes('linker-signed')) return 'adhoc';
  if (authorities.some((item) => /^Developer ID Application:/i.test(item))) return 'Developer ID Application';
  if (authorities.some((item) => /^Apple (Development|Distribution):/i.test(item))) return 'Apple Development/Distribution';
  if (authorities.length) return 'signed';
  return 'unsigned/unknown';
}

/** 从 codesign 的 `flags=0x...(...)` 里取出能力的文本标记。 */
function parseFlags(text) {
  const match = /flags=0x[0-9a-fA-F]+\(([^)]*)\)/.exec(String(text || ''));
  return match ? match[1].split(',').map((item) => item.trim()).filter(Boolean) : [];
}

/** 解析 `codesign -d --entitlements :-` 输出的 plist（只取 key 列表与布尔值，不执行外部工具）。 */
function parseEntitlements(text) {
  const raw = String(text || '');
  const keys = [...raw.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)].map((match) => ({ key: match[1], value: match[2] === 'true' }));
  return keys;
}

// ---------------------------------------------------------------- 0. 基本信息

mkdirSync(OUT_DIR, { recursive: true });

const appExists = existsSync(APP);
let bundleStat = null;
if (appExists) {
  try {
    const stat = statSync(APP);
    bundleStat = { path: APP, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    bundleStat = { path: APP, error: String(error?.message || error) };
  }
}
record({
  id: 'app.exists',
  title: '目标 .app 是否存在',
  category: 'environment',
  status: appExists ? 'pass' : 'blocker',
  detail: appExists ? `应用存在：${APP}` : `找不到应用：${APP}（用 CIRCUITPILOT_APP_PATH 指定实际安装位置）`,
  data: bundleStat,
});

const contentsDir = join(APP, 'Contents');
const mainExecutable = join(contentsDir, 'MacOS', 'circuitpilot');
const infoPlist = join(contentsDir, 'Info.plist');

// ---------------------------------------------------------------- 1. bundle 结构

let contentsEntries = [];
if (appExists && existsSync(contentsDir)) {
  try { contentsEntries = readdirSync(contentsDir); } catch { contentsEntries = []; }
}
const codeSignatureDir = join(contentsDir, '_CodeSignature');
const codeResources = join(codeSignatureDir, 'CodeResources');
const hasCodeSignatureDir = existsSync(codeSignatureDir);
const hasCodeResources = existsSync(codeResources);
record({
  id: 'bundle.structure',
  title: 'bundle 结构（_CodeSignature / CodeResources）',
  category: 'bundle',
  status: hasCodeSignatureDir && hasCodeResources ? 'pass' : 'blocker',
  detail: hasCodeSignatureDir && hasCodeResources
    ? '存在 _CodeSignature/CodeResources：bundle 有完整签名封条'
    : `缺少 ${relative(APP, codeSignatureDir)}${hasCodeSignatureDir ? '（目录在但缺 CodeResources）' : ''}：bundle 不是被完整签名过的 .app，Gatekeeper 会拒绝评估`,
  data: { contentsEntries, hasCodeSignatureDir, hasCodeResources },
});

// ---------------------------------------------------------------- 2. 版本 / 可执行文件

let version = null;
if (appExists && existsSync(infoPlist)) {
  const result = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist]);
  version = result.exitCode === 0 ? (result.stdout || '').trim() : null;
  record({
    id: 'app.version',
    title: 'bundle 版本号（Info.plist）',
    category: 'bundle',
    status: version ? 'pass' : 'warn',
    detail: version ? `CFBundleShortVersionString=${version}` : '读不出版本号',
    command: result.command,
    exitCode: result.exitCode,
    output: truncate(combined(result)),
  });
}

let machoFiles = [];
if (appExists && existsSync(join(contentsDir, 'MacOS'))) {
  try {
    machoFiles = readdirSync(join(contentsDir, 'MacOS'))
      .map((name) => join(contentsDir, 'MacOS', name))
      .filter((path) => {
        try { return statSync(path).isFile(); } catch { return false; }
      });
  } catch { machoFiles = []; }
}

function inspectBinary(path, id, title) {
  if (!existsSync(path)) {
    record({ id, title, category: 'signing', status: 'warn', detail: `文件不存在：${path}` });
    return null;
  }
  const dv = run('codesign', ['-dv', '--verbose=4', path]);
  const dvText = combined(dv);
  const { fields, authorities } = parseCodeSignDv(dvText);
  const flags = parseFlags(dvText);
  const signature = classifySignature({ fields, authorities, flags });
  const verification = run('codesign', ['--verify', '--strict', '--verbose=2', path]);
  const entitlementsResult = run('codesign', ['-d', '--entitlements', ':-', path]);
  const entitlements = parseEntitlements(combined(entitlementsResult));
  const stat = statSync(path);
  record({
    id,
    title,
    category: 'signing',
    status: verification.exitCode === 0 ? (signature === 'adhoc' ? 'warn' : 'pass') : 'blocker',
    detail: [
      `签名=${signature || fields.Signature || '未知'}`,
      `Authority=${fields.Authority || (fields.TeamIdentifier ? `TeamIdentifier=${fields.TeamIdentifier}` : '无（ad-hoc/未签名）')}`,
      `TeamIdentifier=${fields.TeamIdentifier || 'not set'}`,
      `flags=${flags.join(',') || 'none'}`,
      `codesign --verify=${verification.exitCode === 0 ? '通过' : '失败'}`,
    ].join('；'),
    command: `${dv.command} && ${verification.command}`,
    exitCode: verification.exitCode,
    output: truncate(verification.exitCode === 0 ? dvText : `${dvText}\n--- verify ---\n${combined(verification)}`),
    data: {
      path,
      sizeBytes: stat.size,
      fields,
      flags,
      signature,
      verified: verification.exitCode === 0,
      verifyMessage: combined(verification) || null,
      entitlements,
    },
  });
  return { path, fields, flags, signature, verified: verification.exitCode === 0, entitlements };
}

const mainBinary = inspectBinary(mainExecutable, 'codesign.main-binary', '主程序 Mach-O 签名（Contents/MacOS/circuitpilot）');
const sidecarBinaries = machoFiles
  .filter((path) => path !== mainExecutable)
  .map((path) => inspectBinary(path, `codesign.sidecar:${path.split('/').pop()}`, `内嵌二进制签名（${relative(APP, path)}）`));

// ---------------------------------------------------------------- 3. app 整体签名

let appSignature = null;
if (appExists) {
  const dv = run('codesign', ['-dv', '--verbose=4', APP]);
  const dvText = combined(dv);
  const { fields, authorities } = parseCodeSignDv(dvText);
  const flags = parseFlags(dvText);
  const verification = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', APP]);
  const entitlementsResult = run('codesign', ['-d', '--entitlements', ':-', APP]);
  const entitlements = parseEntitlements(combined(entitlementsResult));
  appSignature = {
    fields,
    authorities,
    flags,
    entitlements,
    signature: classifySignature({ fields, authorities, flags }),
    teamIdentifier: fields.TeamIdentifier || null,
    verified: verification.exitCode === 0,
    verifyMessage: combined(verification) || null,
  };
  record({
    id: 'codesign.app',
    title: '.app bundle 整体签名状态',
    category: 'signing',
    status: verification.exitCode === 0 ? (appSignature.signature === 'adhoc' ? 'warn' : 'pass') : 'blocker',
    detail: [
      `Signature=${appSignature.signature || '未知'}`,
      `TeamIdentifier=${appSignature.teamIdentifier || 'not set'}`,
      `flags=${flags.join(',') || 'none'}`,
      `codesign --verify --deep --strict=${verification.exitCode === 0 ? '通过' : `失败（exit ${verification.exitCode}）`}`,
    ].join('；'),
    command: `${dv.command} && ${verification.command}`,
    exitCode: verification.exitCode,
    output: truncate(`${dvText}\n--- verify ---\n${combined(verification)}`),
    data: { fields, flags, entitlements, verified: verification.exitCode === 0, verifyMessage: combined(verification) || null },
  });
}

// ---------------------------------------------------------------- 4. Gatekeeper / 公证票据

if (appExists) {
  const spctl = run('spctl', ['--assess', '--type', 'exec', '--verbose=4', APP]);
  record({
    id: 'spctl.assess',
    title: 'Gatekeeper 评估（spctl -a）',
    category: 'gatekeeper',
    status: spctl.exitCode === 0 ? 'pass' : 'blocker',
    detail: spctl.exitCode === 0
      ? 'spctl 接受该 app（本机 Gatekeeper 判定可执行）'
      : `spctl 拒绝该 app（exit ${spctl.exitCode}）：${combined(spctl).split('\n').filter(Boolean).pop() || '无输出'}。用户机器上双击会被 Gatekeeper 拦截。`,
    command: spctl.command,
    exitCode: spctl.exitCode,
    output: truncate(combined(spctl)),
  });

  const stapler = run('xcrun', ['stapler', 'validate', APP]);
  const staplerText = combined(stapler);
  record({
    id: 'notarization.ticket',
    title: '公证票据是否已装订（stapler validate）',
    category: 'notarization',
    status: stapler.exitCode === 0 ? 'pass' : 'blocker',
    detail: stapler.exitCode === 0
      ? '已装订公证票据（offline Gatekeeper 也能通过）'
      : `没有公证票据：${staplerText.split('\n').filter(Boolean).pop() || 'stapler validate 失败'}。未公证的 app 只能在开发机 ad-hoc 运行。`,
    command: stapler.command,
    exitCode: stapler.exitCode,
    output: truncate(staplerText),
  });
}

// ---------------------------------------------------------------- 5. 证书 / 身份

const identitiesResult = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
const identityText = combined(identitiesResult);
const identities = [...identityText.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map((match) => ({ sha1: match[1], name: match[2] }));
const identityKinds = {
  appleDevelopment: identities.filter((item) => /^Apple Development:/i.test(item.name)),
  appleDistribution: identities.filter((item) => /^Apple Distribution:/i.test(item.name)),
  developerIdApplication: identities.filter((item) => /^Developer ID Application:/i.test(item.name)),
  developerIdInstaller: identities.filter((item) => /^Developer ID Installer:/i.test(item.name)),
  other: identities.filter((item) => !/^(Apple Development|Apple Distribution|Developer ID (Application|Installer)):/i.test(item.name)),
};
record({
  id: 'identity.list',
  title: '本机有效代码签名身份（security find-identity -v -p codesigning）',
  category: 'certificates',
  status: identityKinds.developerIdApplication.length ? 'pass' : (identities.length ? 'warn' : 'blocker'),
  detail: identities.length
    ? `共 ${identities.length} 个有效身份；Developer ID Application ${identityKinds.developerIdApplication.length} 个、Apple Development ${identityKinds.appleDevelopment.length} 个。${identityKinds.developerIdApplication.length ? '' : '没有 Developer ID Application：无法做对外分发签名/公证。'}`
    : '没有任何有效代码签名身份（钥匙串里没有可用证书/私钥）',
  command: identitiesResult.command,
  exitCode: identitiesResult.exitCode,
  output: truncate(identityText),
  data: { identities, identityKinds, raw: truncate(identityText, 800) },
});

// 证书存在 ≠ 私钥可用；find-identity -v 已要求"有效（含私钥）"，这里额外看 Developer ID 证书是否在钥匙串。
const devIdCertResult = run('/usr/bin/security', ['find-certificate', '-c', 'Developer ID Application', '-a']);
record({
  id: 'identity.developer-id-certificate',
  title: '钥匙串是否存在 Developer ID Application 证书',
  category: 'certificates',
  status: /Developer ID Application/.test(combined(devIdCertResult)) ? 'pass' : 'warn',
  detail: /Developer ID Application/.test(combined(devIdCertResult))
    ? '钥匙串里有 Developer ID Application 证书（仍以 find-identity 的有效身份为准）'
    : '钥匙串里没有 Developer ID Application 证书：必须由 Apple Developer Program 账号（付费）创建并下载安装',
  command: devIdCertResult.command,
  exitCode: devIdCertResult.exitCode,
  output: truncate(combined(devIdCertResult)),
});

// ---------------------------------------------------------------- 6. notarytool / 公证凭证

const notaryFind = run('xcrun', ['--find', 'notarytool']);
const notaryVersion = notaryFind.exitCode === 0 ? run('xcrun', ['notarytool', '--version']) : null;
record({
  id: 'notarytool.available',
  title: 'notarytool 是否可用',
  category: 'notarization',
  status: notaryFind.exitCode === 0 && notaryVersion?.exitCode === 0 ? 'pass' : 'blocker',
  detail: notaryFind.exitCode === 0
    ? `notarytool 可用：${(notaryFind.stdout || '').trim()}${notaryVersion ? `（${(notaryVersion.stdout || notaryVersion.stderr || '').trim().split('\n')[0]}）` : ''}`
    : 'xcrun 找不到 notarytool：Xcode Command Line Tools 不完整，无法提交公证',
  command: notaryFind.command + (notaryVersion ? ` ; ${notaryVersion.command}` : ''),
  exitCode: notaryFind.exitCode,
  output: truncate([combined(notaryFind), notaryVersion ? combined(notaryVersion) : ''].filter(Boolean).join('\n')),
  data: { path: (notaryFind.stdout || '').trim() || null, version: notaryVersion ? (notaryVersion.stdout || notaryVersion.stderr || '').trim().split('\n')[0] : null },
});

/**
 * 公证凭证只做"环境变量是否声明"的静态检查。
 * 不读钥匙串里的密钥项、不尝试 notarytool submit/--keychain-profile 探测——
 * 那会把"检查"变成"猜用户密码"，也违背本任务"不提供/不伪造凭证"的边界。
 */
const credentialEnvNames = [
  'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID',
  'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_PATH',
  'APPLE_SIGNING_IDENTITY', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_KEYCHAIN_PROFILE',
];
const presentCredentialEnv = credentialEnvNames.filter((name) => typeof process.env[name] === 'string' && process.env[name].trim().length > 0);
record({
  id: 'notary.credentials',
  title: '公证/签名凭证环境变量（只检查是否声明，不读取值）',
  category: 'credentials',
  status: presentCredentialEnv.length ? 'warn' : 'unknown',
  detail: presentCredentialEnv.length
    ? `检测到已声明的环境变量：${presentCredentialEnv.join(', ')}（只是"声明了"，不代表凭证有效；本脚本不联网验证）`
    : '当前进程环境没有声明任何公证/签名凭证变量。注意：这不等于"用户没有配置"——notarytool 也可能用钥匙串 profile（APPLE_KEYCHAIN_PROFILE），本脚本不读取钥匙串、不猜测。实际提交公证前需用户自行确认凭证可用。',
  data: {
    checkedEnvNames: credentialEnvNames,
    presentEnvNames: presentCredentialEnv,
    values: '（刻意不记录任何凭证值）',
    keychainProfileProbe: '未执行（只读边界：不读取/不猜测用户钥匙串里的密码项）',
  },
});

// ---------------------------------------------------------------- 7. Tauri 签名配置 / entitlements

const tauriConfigPath = join(ROOT, 'src-tauri', 'tauri.conf.json');
let tauriConfig = null;
if (existsSync(tauriConfigPath)) {
  try {
    const parsed = JSON.parse(readFileSync(tauriConfigPath, 'utf8'));
    tauriConfig = parsed;
    const macOS = parsed?.bundle?.macOS || {};
    const entitlementsPath = macOS.entitlements ? join(ROOT, 'src-tauri', macOS.entitlements) : null;
    const entitlementsExists = entitlementsPath ? existsSync(entitlementsPath) : false;
    const entitlementsKeys = entitlementsExists ? parseEntitlements(readFileSync(entitlementsPath, 'utf8')).map((item) => item.key) : [];
    record({
      id: 'tauri.signing-config',
      title: 'Tauri 打包签名配置（src-tauri/tauri.conf.json）',
      category: 'config',
      status: macOS.hardenedRuntime === true && entitlementsExists ? 'pass' : 'warn',
      detail: [
        `bundle.identifier=${parsed?.identifier ?? parsed?.bundle?.identifier ?? '未声明'}`,
        `bundle.targets=${JSON.stringify(parsed?.bundle?.targets ?? [])}`,
        `hardenedRuntime=${macOS.hardenedRuntime === true}`,
        `entitlements=${macOS.entitlements ?? '未声明'}（${entitlementsExists ? '文件存在' : '文件缺失'}）`,
        `entitlements keys=${entitlementsKeys.join(',') || '无'}`,
      ].join('；'),
      data: {
        identifier: parsed?.identifier ?? parsed?.bundle?.identifier ?? null,
        targets: parsed?.bundle?.targets ?? [],
        hardenedRuntime: macOS.hardenedRuntime === true,
        minimumSystemVersion: macOS.minimumSystemVersion ?? null,
        entitlementsFile: macOS.entitlements ?? null,
        entitlementsExists,
        entitlementsKeys,
      },
    });
  } catch (error) {
    record({ id: 'tauri.signing-config', title: 'Tauri 打包签名配置', category: 'config', status: 'warn', detail: `读取失败：${String(error?.message || error)}` });
  }
} else {
  record({ id: 'tauri.signing-config', title: 'Tauri 打包签名配置', category: 'config', status: 'warn', detail: `找不到 ${relative(ROOT, tauriConfigPath)}` });
}

// ---------------------------------------------------------------- 8. 就绪结论

const appAdhoc = Boolean(appSignature && (appSignature.signature === 'adhoc' || appSignature.flags?.includes('adhoc') || appSignature.flags?.includes('linker-signed')));
const hasDeveloperId = identityKinds.developerIdApplication.length > 0;
const verifies = Boolean(appSignature?.verified);
const staplerPassed = checks.find((item) => item.id === 'notarization.ticket')?.status === 'pass';
const bundleStructOk = checks.find((item) => item.id === 'bundle.structure')?.status === 'pass';
const notarytoolOk = checks.find((item) => item.id === 'notarytool.available')?.status === 'pass';

const blockers = [];
const warnings = [];
const addBlocker = (code, title, detail) => blockers.push({ code, title, detail });
const addWarning = (code, title, detail) => warnings.push({ code, title, detail });

if (!appExists) addBlocker('APP_NOT_FOUND', '.app 不存在', `找不到 ${APP}`);
if (!bundleStructOk) {
  addBlocker(
    'APP_BUNDLE_SIGNATURE_STRUCTURE_INVALID',
    'bundle 签名封条缺失/无效',
    'Contents/_CodeSignature/CodeResources 缺失（或 codesign --verify --deep --strict 失败）：这不是一个被完整签名的 .app。即使之后用 Developer ID 重签，也要从干净 bundle 重新签（先清掉旧 _CodeSignature 再 codesign --force --deep）。',
  );
}
if (!hasDeveloperId) {
  addBlocker(
    'DEVELOPER_ID_APPLICATION_CERT_MISSING',
    '缺少 Developer ID Application 证书',
    '对外分发（DMG/直接下载）必须用 Developer ID Application 证书签名；本机只有 Apple Development（开发用，不能分发）。需要 Apple Developer Program（付费）账号 → Certificates 里创建 Developer ID Application → 下载 .cer 并安装（含私钥的 .p12 或 Xcode 自动管理）。该凭证只能由用户提供，本脚本不下载/不伪造。',
  );
}
if (appAdhoc) {
  addBlocker('SIGNING_ADHOC', '当前 app 是 ad-hoc 签名', 'Signature=adhoc / flags 含 adhoc：只适合本机开发运行，其他机器会被 Gatekeeper 拦截，也无法通过公证。');
}
if (!staplerPassed) {
  addBlocker('NOTARIZATION_TICKET_MISSING', '未公证/未装订票据', 'stapler validate 失败：必须先 notarytool submit 通过，再 xcrun stapler staple 装订。仅签名不公证的 app 在 macOS 10.15+ 首次运行仍会被拦。');
}
if (!notarytoolOk) addBlocker('NOTARYTOOL_UNAVAILABLE', 'notarytool 不可用', '需要完整 Xcode Command Line Tools（xcode-select --install）或 Xcode。');

if (mainBinary && !mainBinary.verified) addWarning('MAIN_BINARY_NOT_VERIFIED', '主程序签名校验失败', 'codesign --verify 主程序失败；重签时务必对主程序单独校验。');
if (mainBinary && mainBinary.entitlements.length === 0) {
  addWarning(
    'MAIN_BINARY_NO_ENTITLEMENTS',
    '主程序没有 entitlements',
    'ad-hoc 主程序当前没有任何 entitlements。正式签名时若启用 Hardened Runtime，需要显式声明所需能力（本应用需要网络 client/server）；否则运行时会因沙箱/硬化限制失败。',
  );
}
for (const sidecar of sidecarBinaries) {
  if (sidecar && sidecar.entitlements.some((item) => item.key === 'com.apple.security.get-task-allow' && item.value)) {
    addWarning(
      'SIDECAR_GET_TASK_ALLOW',
      '内嵌 Node sidecar 的签名带 get-task-allow（调试用）',
      `${sidecar.path} 是官方 Node.js 二进制（Developer ID: Node.js Foundation），其签名带 get-task-allow 与一组放宽的硬化运行时例外。公证审核通常不接受 get-task-allow；正式发布建议用你自己的 Developer ID 重新签这个 sidecar，并只保留 V8 必需的最小 entitlements（allow-jit / allow-unsigned-executable-memory / disable-library-validation），去掉 get-task-allow。`,
    );
  }
  if (sidecar && !sidecar.verified) addWarning('SIDECAR_NOT_VERIFIED', '内嵌二进制签名校验失败', `${sidecar.path} codesign --verify 失败。`);
}
const notaryEnvRecord = checks.find((item) => item.id === 'notary.credentials');
if (notaryEnvRecord?.status !== 'pass') {
  addWarning(
    'NOTARY_CREDENTIALS_NOT_VERIFIED',
    '未验证公证凭证可用性',
    '未在环境变量中检测到公证凭证，且本次检查刻意不读取钥匙串/不联网验证。提交公证前需要用户自行确认 App Store Connect API Key（issuer/key/key path）或 Apple ID（app-specific password + team）可用。',
  );
}

const readyForDistribution = blockers.length === 0;
const state = !appExists
  ? 'absent'
  : appAdhoc || !verifies
    ? (appSignature?.signature === 'adhoc' || appAdhoc ? 'ad-hoc' : 'invalid')
    : hasDeveloperId
      ? 'developer-id'
      : 'signed-other-identity';

const report = {
  kind: 'macos-signing-readiness',
  schemaVersion: 1,
  generatedAt: GENERATED_AT,
  disclaimer: '本报告只做只读就绪检查：不签名、不公证、不联网、不修改/不重装 app。readyForDistribution=false 表示"当前还不具备对外分发条件"，不代表应用功能有问题。',
  app: {
    path: APP,
    exists: appExists,
    version,
    bundleStat,
    executable: mainExecutable,
    mainExecutableSha256: sha256File(mainExecutable),
    sidecars: machoFiles.filter((path) => path !== mainExecutable).map((path) => ({ path, sha256: sha256File(path) })),
  },
  verdict: {
    readyForDistribution,
    signingState: state,
    adhoc: appAdhoc,
    codesignVerified: verifies,
    bundleStructureValid: bundleStructOk,
    notarizationTicketStapled: staplerPassed,
    developerIdApplicationIdentity: hasDeveloperId,
    notarytoolAvailable: notarytoolOk,
    hardenedRuntimeDeclaredInBuildConfig: tauriConfig?.bundle?.macOS?.hardenedRuntime === true,
    blockers,
    warnings,
    summary: readyForDistribution
      ? '签名与公证就绪检查全部通过（仍需人工确认公证凭证与最终 Gatekeeper 实机验证）。'
      : `还不能对外分发：${blockers.length} 个阻断（${blockers.map((item) => item.code).join('、')}）。当前 app 是 ${state} 签名。`,
  },
  checks,
  userCredentialBoundary: [
    'Apple Developer Program 账号（付费）及其 Team ID —— 只能用户本人提供/登录。',
    'Developer ID Application 证书及私钥（钥匙串里的有效身份）—— 本脚本只读"有没有"，不导出、不创建。',
    '公证凭证：App Store Connect API Key（Issuer ID / Key ID / .p8 文件）或 Apple ID + app-specific password —— 不得写进仓库/报告；建议用 xcrun notarytool store-credentials 存进钥匙串后只引用 profile 名。',
    '无法在无凭证环境自动完成的部分：证书申请、Team 审核、公证提交与票据装订、最终在"别人的 Mac"上的 Gatekeeper 实机验证。',
  ],
  reproduction: [
    'node scripts/check-signing-readiness.mjs',
    `codesign -dv --verbose=4 "${APP}"`,
    `codesign --verify --deep --strict --verbose=2 "${APP}"`,
    `spctl --assess --type exec --verbose=4 "${APP}"`,
    `xcrun stapler validate "${APP}"`,
    'security find-identity -v -p codesigning',
    'xcrun notarytool --version',
  ],
  nextSteps: [
    '1) 用户提供 Developer ID Application 证书（含私钥）并安装到钥匙串。',
    '2) 修复 bundle 签名结构：从干净 .app 开始，用 codesign --force --deep --options runtime 重新签名（sidecar 单独按 JIT 最小 entitlements 重签）。',
    '3) 用 notarytool submit 提交公证（凭证由用户提供，建议 zipped .app 或 .dmg）。',
    '4) 公证通过后 xcrun stapler staple 装订票据，再 spctl --assess 复验。',
    '5) 在另一台未安装开发者证书的 Mac 上实机验证 Gatekeeper 放行。',
    '详见 docs/macos-signing.md。',
  ],
};

writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const statusLabel = (status) => (status === 'pass' ? '✅ pass' : status === 'blocker' ? '❌ BLOCKER' : status === 'warn' ? '⚠️ warn' : '❓ unknown');
const md = [];
md.push('# macOS 签名 / 公证就绪检查（T6，只读）');
md.push('');
md.push(`- 生成时间：\`${GENERATED_AT}\``);
md.push(`- 被检查应用：\`${APP}\``);
md.push(`- 报告文件：\`${relative(ROOT, JSON_PATH)}\``);
md.push('- 边界：**只读检查**——不签名、不公证、不联网、不修改/不重装 app。');
md.push('');
md.push('## 结论');
md.push('');
md.push(`**readyForDistribution = ${readyForDistribution ? 'true' : 'false'}**（签名状态：\`${state}\`）`);
md.push('');
md.push(report.verdict.summary);
md.push('');
if (blockers.length) {
  md.push('| # | 阻断码 | 说明 |');
  md.push('|---|---|---|');
  blockers.forEach((item, index) => md.push(`| ${index + 1} | \`${item.code}\` | ${item.title}：${item.detail} |`));
  md.push('');
}
if (warnings.length) {
  md.push('### 警告（不直接阻断，但正式发布前必须处理/确认）');
  md.push('');
  md.push('| # | 警告码 | 说明 |');
  md.push('|---|---|---|');
  warnings.forEach((item, index) => md.push(`| ${index + 1} | \`${item.code}\` | ${item.title}：${item.detail} |`));
  md.push('');
}
md.push('## 实测检查项');
md.push('');
md.push('| 检查项 | 状态 | 结论 |');
md.push('|---|---|---|');
for (const item of checks) {
  md.push(`| ${item.title} | ${statusLabel(item.status)} | ${String(item.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 400)} |`);
}
md.push('');
md.push('## 关键命令真实输出');
md.push('');
for (const item of checks) {
  if (!item.command || !item.output) continue;
  md.push(`### ${item.title}`);
  md.push('');
  md.push(`\`${item.command}\` → exit ${item.exitCode}`);
  md.push('');
  md.push('```text');
  md.push(item.output.replace(/```/g, '\\`\\`\\`'));
  md.push('```');
  md.push('');
}
md.push('## 用户必须提供的凭证（本脚本不代做、不伪造）');
md.push('');
for (const item of report.userCredentialBoundary) md.push(`- ${item}`);
md.push('');
md.push('## 下一步（完整命令见 docs/macos-signing.md）');
md.push('');
for (const item of report.nextSteps) md.push(`- ${item}`);
md.push('');
md.push('## 复现');
md.push('');
for (const item of report.reproduction) md.push(`- \`${item}\``);
md.push('');
md.push('> 说明：签名/公证这两件事本质上依赖**用户账号与外部 Apple 服务**，沙箱/CI 无法"自己变出证书"。');
md.push('> 因此本报告的价值是：把"缺什么、缺在哪一步、需要谁提供什么"变成可复核的事实，而不是一句笼统的"发布受阻"。');
md.push('');
writeFileSync(MD_PATH, md.join('\n'), 'utf8');

// 附带一份 YAML（便于 CI 读取；不引入第三方依赖，简单转 key: value 结构）
const yamlLines = [
  `kind: macos-signing-readiness`,
  `generatedAt: "${GENERATED_AT}"`,
  `app: "${APP}"`,
  `readyForDistribution: ${readyForDistribution}`,
  `signingState: ${state}`,
  `codesignVerified: ${verifies}`,
  `bundleStructureValid: ${bundleStructOk}`,
  `notarizationTicketStapled: ${staplerPassed}`,
  `developerIdApplicationIdentity: ${hasDeveloperId}`,
  `notarytoolAvailable: ${notarytoolOk}`,
  'blockers:',
  ...(blockers.length ? blockers.map((item) => `  - ${item.code}`) : ['  []']),
  'warnings:',
  ...(warnings.length ? warnings.map((item) => `  - ${item.code}`) : ['  []']),
  `json: "${relative(ROOT, JSON_PATH)}"`,
  `markdown: "${relative(ROOT, MD_PATH)}"`,
  '',
];
writeFileSync(YAML_PATH, yamlLines.join('\n'), 'utf8');

console.log(JSON.stringify({
  ok: true,
  app: APP,
  readyForDistribution,
  signingState: state,
  blockers: blockers.map((item) => item.code),
  warnings: warnings.map((item) => item.code),
  output: { json: JSON_PATH, markdown: MD_PATH, yaml: YAML_PATH },
}, null, 2));

process.exit(readyForDistribution ? 0 : 1);
