import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLI_CANDIDATES, PROCESS_TIMEOUT_MS } from './config.mjs';

const OUTPUT_LIMIT = 16 * 1024;

async function isExecutable(candidate) {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析一个 CLI 的候选绝对路径（按优先级）：显式落点 → PATH → 常见用户 bin 目录。
 *
 * 最后一段是给"从 Finder/Dock 启动的 GUI App"兜底的：它拿到的是 launchd 的最小 PATH，
 * 看不到 ~/.cargo/bin、~/.local/bin、Homebrew 等目录。只在 PATH 里找，就会把已安装的
 * cargo/codex/claude 判成"未安装"——这是真实发生过的误报（Rust/Cargo 显示待安装）。
 *
 * homeDir/pathValue 可注入，便于测试不依赖真实机器环境。
 */
export function executableSearchPaths(name, { homeDir = os.homedir(), pathValue = process.env.PATH } = {}) {
  const explicit = CLI_CANDIDATES[name] || [];
  const fromPath = String(pathValue || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, name));
  const wellKnown = [
    path.join(homeDir, '.cargo/bin'),
    path.join(homeDir, '.local/bin'),
    path.join(homeDir, '.npm-global/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].map((directory) => path.join(directory, name));
  return [...new Set([...explicit, ...fromPath, ...wellKnown])];
}

export async function findExecutable(name, options = {}) {
  for (const candidate of executableSearchPaths(name, options)) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export function runProcess(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-OUTPUT_LIMIT); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-OUTPUT_LIMIT); });
    child.on('error', (error) => finish({ ok: false, code: null, stdout, stderr, error: error.message, timedOut: false }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut: false }));
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, code: null, stdout: stdout.trim(), stderr: stderr.trim(), error: 'Process timed out', timedOut: true });
    }, timeoutMs);
    if (options.stdin !== undefined) child.stdin.end(`${options.stdin}\n`);
    else child.stdin.end();
  });
}

export function startDetached(command, args = []) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
  child.unref();
  return { pid: child.pid };
}

export function startObserved(command, args = [], { startupTimeoutMs = 750, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false; let stdout = ''; let stderr = ''; let timer;
    const child = spawnProcess(command, args, { detached: true, stdio: ['ignore','pipe','pipe'], shell: false });
    const finish = (value, error = null) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const append = (current, chunk) => (current + String(chunk)).slice(-OUTPUT_LIMIT);
    child.stdout?.on('data',(chunk)=>{stdout=append(stdout,chunk);}); child.stderr?.on('data',(chunk)=>{stderr=append(stderr,chunk);});
    child.once('error',(error)=>finish(null,Object.assign(new Error(`登录进程无法启动：${error.message}`),{code:'LOGIN_SPAWN_FAILED'})));
    child.once('spawn',()=>{ timer=setTimeout(()=>{ child.unref?.(); finish({state:'started',started:true,pid:child.pid}); },startupTimeoutMs); });
    child.once('close',(code)=>{ const detail=summarizeProcessFailure(stderr||stdout); finish(code===0?{state:'exited',started:false,pid:child.pid,exitCode:code,detail}:{state:'failed',started:false,pid:child.pid,exitCode:code,detail}); });
  });
}

function summarizeProcessFailure(value) {
  return String(value||'登录进程在建立授权会话前退出').replace(/https?:\/\/\S+/gi,'[AUTH_URL_REDACTED]').replace(/\s+/g,' ').trim().slice(0,240);
}
