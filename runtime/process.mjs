import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
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

export async function findExecutable(name) {
  for (const candidate of CLI_CANDIDATES[name] || []) {
    if (await isExecutable(candidate)) return candidate;
  }
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of pathEntries) {
    const candidate = path.join(directory, name);
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
