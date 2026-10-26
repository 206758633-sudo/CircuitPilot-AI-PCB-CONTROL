import { spawn } from 'node:child_process';
import { findExecutable } from './process.mjs';

// AI 规划属长任务（首次冷启动 + 大上下文）：120s 硬上限会稳定误杀（真机连续 CODEX_TIMEOUT）。
// 默认仍 120s，但允许用环境变量放宽，避免把「AI 想得久」误报成失败。
const DEFAULT_TIMEOUT_MS = Number(process.env.CIRCUITPILOT_CODEX_TIMEOUT_MS) > 0 ? Number(process.env.CIRCUITPILOT_CODEX_TIMEOUT_MS) : 120_000;

function protocolError(message, code = 'CODEX_PROTOCOL_ERROR') {
  return Object.assign(new Error(message), { code, status: 502 });
}

export class CodexAppServerClient {
  constructor({ executable = null, cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, spawnProcess = spawn } = {}) {
    this.executable = executable;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.turnBuffers = new Map();
    this.stdoutBuffer = '';
    this.stderr = '';
    this.readyPromise = null;
  }

  async ensureReady() {
    if (this.child && !this.child.killed) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.start().finally(() => { this.readyPromise = null; });
    return this.readyPromise;
  }

  async start() {
    const executable = this.executable || await findExecutable('codex');
    if (!executable) throw Object.assign(new Error('Codex CLI未安装'), { code: 'CLI_NOT_FOUND', status: 503 });
    this.executable = executable;
    const child = this.spawnProcess(executable, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-8_192); });
    child.on('error', (error) => this.failAll(Object.assign(new Error(`Codex App Server启动失败：${error.message}`), { code: 'CODEX_START_FAILED', status: 503 })));
    child.on('close', (code) => {
      const error = Object.assign(new Error(`Codex App Server已退出（${code ?? 'unknown'}）`), { code: 'CODEX_SERVER_EXITED', status: 502 });
      this.child = null;
      this.failAll(error);
    });
    await this.request('initialize', { clientInfo: { name: 'circuitpilot-runtime', title: 'CircuitPilot Runtime', version: '0.3.0' }, capabilities: { experimentalApi: true } }, 15_000);
    this.notify('initialized', {});
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        try { this.onMessage(JSON.parse(line)); } catch { this.failAll(protocolError('Codex App Server返回了无效JSON')); }
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  onMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(protocolError(message.error.message || 'Codex请求失败', 'CODEX_REQUEST_FAILED'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.respond(message.id, null, { code: -32601, message: 'CircuitPilot只读聊天不接受审批或工具请求' });
      for (const turn of this.turns.values()) turn.reject(Object.assign(new Error('Codex请求了未授权操作，已拒绝'), { code: 'CODEX_APPROVAL_BLOCKED', status: 403 }));
      this.turns.clear();
      return;
    }
    const params = message.params || {};
    if (message.method === 'item/agentMessage/delta') {
      const turn = this.turns.get(params.turnId);
      if (turn) turn.text += String(params.delta || '');
      else {
        const buffered = this.turnBuffers.get(params.turnId) || { text: '', completed: null };
        buffered.text += String(params.delta || '');
        this.turnBuffers.set(params.turnId, buffered);
      }
    }
    if (message.method === 'turn/completed') {
      const turnId = params.turn?.id;
      const turn = this.turns.get(turnId);
      if (!turn) {
        const buffered = this.turnBuffers.get(turnId) || { text: '', completed: null };
        buffered.completed = params.turn;
        this.turnBuffers.set(turnId, buffered);
        return;
      }
      this.turns.delete(turnId);
      clearTimeout(turn.timer);
      if (params.turn?.status === 'failed') turn.reject(protocolError(params.turn?.error?.message || 'Codex本轮失败', 'CODEX_TURN_FAILED'));
      else turn.resolve({ text: turn.text, turn: params.turn });
    }
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    if (!this.child?.stdin?.writable) return Promise.reject(Object.assign(new Error('Codex App Server未运行'), { code: 'CODEX_SERVER_NOT_READY', status: 503 }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Codex请求超时：${method}`), { code: 'CODEX_TIMEOUT', status: 504 }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params) {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id, result, error) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(error ? { id, error } : { id, result })}\n`);
  }

  async createThread({ instructions, model = null } = {}) {
    await this.ensureReady();
    const result = await this.request('thread/start', {
      cwd: this.cwd,
      model,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      baseInstructions: instructions,
      developerInstructions: instructions,
      ephemeral: true,
      personality: 'pragmatic',
    });
    const threadId = result?.thread?.id;
    if (!threadId) throw protocolError('Codex未返回thread ID');
    return threadId;
  }

  async runTurn({ threadId, input, images = [], outputSchema, model = null } = {}) {
    await this.ensureReady();
    const result = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: input }, ...images.map((path) => ({ type: 'localImage', path, detail: 'auto' }))],
      outputSchema,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      summary: 'none',
      model,
    });
    const turnId = result?.turn?.id;
    if (!turnId) throw protocolError('Codex未返回turn ID');
    return new Promise((resolve, reject) => {
      const buffered = this.turnBuffers.get(turnId);
      if (buffered?.completed) {
        this.turnBuffers.delete(turnId);
        if (buffered.completed.status === 'failed') reject(protocolError(buffered.completed?.error?.message || 'Codex本轮失败', 'CODEX_TURN_FAILED'));
        else resolve({ text: buffered.text, turn: buffered.completed });
        return;
      }
      const timer = setTimeout(() => {
        this.turns.delete(turnId);
        reject(Object.assign(new Error('Codex回答超时'), { code: 'CODEX_TIMEOUT', status: 504 }));
      }, this.timeoutMs);
      this.turns.set(turnId, { text: buffered?.text || '', resolve, reject, timer });
      this.turnBuffers.delete(turnId);
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    for (const turn of this.turns.values()) { clearTimeout(turn.timer); turn.reject(error); }
    this.pending.clear();
    this.turns.clear();
    this.turnBuffers.clear();
  }

  close() {
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
    this.child = null;
  }
}
