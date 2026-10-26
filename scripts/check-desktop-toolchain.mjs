import { spawnSync } from 'node:child_process';

const checks = [
  ['cargo', ['--version'], 'Rust/Cargo未安装，不能构建Tauri桌面包。Web与Runtime构建不能替代桌面验收。'],
  ['rustc', ['--version'], 'Rust编译器未安装，不能构建Tauri桌面包。'],
];

let failed = false;
for (const [command, args, message] of checks) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    console.error(`${new Date().toISOString()} [ERROR] DesktopToolchain: ${message}`);
    failed = true;
  } else {
    console.info(`${new Date().toISOString()} [INFO] DesktopToolchain: ${(result.stdout || result.stderr).trim()}`);
  }
}
if (failed) process.exit(1);
