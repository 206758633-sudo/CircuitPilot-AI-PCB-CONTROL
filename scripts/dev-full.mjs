import { spawn } from 'node:child_process';

// detached:true 让每个子进程成为自己进程组的组长，收尾时可以用 -pid 一次性结束整棵子树
// （npm → vite）。否则只杀掉 npm，vite 会继续占着 4177 端口成为孤儿进程。
const GRACE_MS = 8_000;
const children = [
  spawn(process.execPath, ['runtime/server.mjs'], { stdio: 'inherit', detached: true }),
  spawn('npm', ['run', 'dev'], { stdio: 'inherit', shell: false, detached: true }),
];

function signal(child, signalName) {
  try { process.kill(-child.pid, signalName); }
  catch { try { child.kill(signalName); } catch { /* 已经退出 */ } }
}

const isAlive = (child) => child.exitCode === null && child.signalCode === null;

let stopping = false;
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  const alive = children.filter(isAlive);
  if (!alive.length) return;
  if (reason) console.log(`[dev:full] 正在停止子进程（${reason}）…`);
  for (const child of alive) signal(child, 'SIGTERM');
  // 等子进程真正退出；只有还活着才升级为 SIGKILL，避免“父进程先退出、孙子进程仍在跑”。
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline && alive.some(isAlive)) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const child of alive.filter(isAlive)) signal(child, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const leftover = children.filter(isAlive).length;
  if (leftover) console.warn(`[dev:full] 仍有 ${leftover} 个子进程未退出（若端口被占用，请检查 4177/4178）。`);
}

// SIGKILL 无法捕获：那种情况下 Vite 可能残留并占住 4177。
// vite.config.ts 的 strictPort 会让下一次启动直接失败，而不是静默换端口。
process.once('SIGINT', () => { void stop('SIGINT').then(() => process.exit(130)); });
process.once('SIGTERM', () => { void stop('SIGTERM').then(() => process.exit(143)); });
process.once('SIGHUP', () => { void stop('SIGHUP').then(() => process.exit(129)); });

for (const child of children) child.once('exit', (code) => {
  if (stopping) return;
  void stop(`子进程 ${child.pid} 退出`).then(() => { process.exitCode = code && code !== 0 ? code : 0; });
});

console.log('[dev:full] 控制台 http://127.0.0.1:4177 · Runtime http://127.0.0.1:4178/api/health');
