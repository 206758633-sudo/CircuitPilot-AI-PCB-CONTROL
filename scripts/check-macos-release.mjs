import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const checks = [];
function check(id, passed, detail, blocker = true) { checks.push({ id, passed, detail, blocker }); }
for (const command of ['cargo','rustc']) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  check(command, result.status === 0, result.status === 0 ? (result.stdout || result.stderr).trim() : `${command}未安装`, true);
}
const identities = spawnSync('/usr/bin/security', ['find-identity','-v','-p','codesigning'], { encoding: 'utf8' });
check('developer-id', /Developer ID Application/.test(identities.stdout || ''), '需要有效的Developer ID Application证书', true);
check('apple-team', Boolean(process.env.APPLE_TEAM_ID), process.env.APPLE_TEAM_ID ? 'APPLE_TEAM_ID已提供' : 'APPLE_TEAM_ID未提供', true);
const notaryConfigured = Boolean(process.env.APPLE_API_ISSUER && process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_PATH) || Boolean(process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID);
check('notary-credentials', notaryConfigured, notaryConfigured ? '已检测到公证凭证变量' : '未提供App Store Connect API Key或Apple ID公证凭证', true);
check('entitlements', fs.existsSync(new URL('../src-tauri/entitlements.plist', import.meta.url)), 'Hardened Runtime entitlements文件', true);
const failed = checks.filter((item) => item.blocker && !item.passed);
console.log(JSON.stringify({ ready: failed.length === 0, checks, blockedBy: failed.map((item) => item.id) }, null, 2));
if (failed.length) process.exit(1);
