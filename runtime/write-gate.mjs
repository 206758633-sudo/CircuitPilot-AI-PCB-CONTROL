import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * P0-8 / WP4 P0-5：写入暂停（Runtime 侧持久化，全局 + 会话两级）。
 *
 * 修复前的缺陷：设置页承诺"最高优先级门禁，阻断所有 EDA 写命令"，但 `writePaused` 只存在于
 * 浏览器 localStorage；Runtime 完全不知道，脚本/curl 直接打 HTTP 照样能签发写批准、写板。
 *
 * 现在暂停状态落在 Runtime 状态目录（默认 `artifacts/state/write-gate.json`）：
 *   - `paused`（全局）：最高优先级，所有 EDA 写路由分发前 fail-closed 409 `EDA_WRITE_PAUSED`；
 *   - `sessionPaused`（会话）：EDA 页"暂停本会话写入"，与全局并存、独立持久化；
 *     只要任一为 true，写入口都必须拒绝（由 server 的 assertEdaWritesOpen 判定）；
 *   - 旧文件只有 `paused` 字段时按 `sessionPaused:false` 兼容读取；
 *   - 文件损坏/不可读 → 全局按 `paused:true` 保守阻断（fail-closed），并在 snapshot 暴露 `loadError`。
 */
export const WRITE_GATE_CODES = Object.freeze({
  INVALID: 'WRITE_GATE_INVALID',
});

const SCOPES = Object.freeze(['global', 'session']);

const emptyState = () => ({
  paused: false,
  reason: null,
  actor: null,
  updatedAt: null,
  version: 0,
  sessionPaused: false,
  sessionReason: null,
  sessionActor: null,
  sessionUpdatedAt: null,
});

const cleanText = (value, limit) => (value === null || value === undefined ? null : String(value).slice(0, limit));

export class WriteGateStore {
  constructor({ file = join(process.env.CIRCUITPILOT_STATE_DIR || join(process.cwd(), 'artifacts/state'), 'write-gate.json') } = {}) {
    this.file = file;
    this.state = emptyState();
    this.loaded = false;
    this.loadError = null;
  }

  async load() {
    if (this.loaded) return this.snapshot();
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const problems = [];
      // 全局字段：损坏 = 状态未知。复审 2026-10-29 发现旧实现只记 loadError 却保持 paused:false，
      // 等于一次磁盘损坏/手工改坏就能静默关闭最高优先级写门禁（fail-open）→ 这里保守按“已暂停”。
      if (typeof parsed?.paused === 'boolean') {
        this.state.paused = parsed.paused;
        this.state.reason = parsed.paused ? cleanText(parsed.reason || '用户暂停所有写入', 200) : null;
        this.state.actor = cleanText(parsed.actor, 80);
        this.state.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
      } else {
        problems.push('paused 字段缺失或不是布尔值');
        this.state.paused = true;
        this.state.reason = '写门禁状态文件字段非法：已保守阻断写入，请在设置页确认后恢复';
        this.state.actor = 'runtime';
        this.state.updatedAt = null;
      }
      // 会话字段：旧文件没有这个字段是合法兼容（默认 false）；写了但类型不对 = 损坏，保留 loadError。
      if (typeof parsed?.sessionPaused === 'boolean') {
        this.state.sessionPaused = parsed.sessionPaused;
        this.state.sessionReason = parsed.sessionPaused ? cleanText(parsed.sessionReason || parsed.reason || '暂停本会话写入', 200) : null;
        this.state.sessionActor = cleanText(parsed.sessionActor, 80);
        this.state.sessionUpdatedAt = typeof parsed.sessionUpdatedAt === 'string' ? parsed.sessionUpdatedAt : null;
      } else {
        this.state.sessionPaused = false;
        if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'sessionPaused')) problems.push('sessionPaused 字段非法');
      }
      if (Number.isFinite(Number(parsed?.version))) this.state.version = Number(parsed.version);
      if (problems.length) this.loadError = problems.join('；');
    } catch (error) {
      // 文件不存在 = 从未暂停（默认放行写，但写路由本身仍要求一次性批准 + 快照）。
      if (error?.code !== 'ENOENT') {
        this.loadError = String(error?.message || error);
        this.state = {
          ...emptyState(),
          paused: true,
          reason: '写门禁状态文件损坏/不可读：已保守阻断写入，请在设置页确认后恢复',
          actor: 'runtime',
          version: -1,
        };
      }
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      paused: this.state.paused === true,
      reason: this.state.reason,
      actor: this.state.actor,
      updatedAt: this.state.updatedAt,
      version: this.state.version,
      sessionPaused: this.state.sessionPaused === true,
      sessionReason: this.state.sessionReason,
      sessionActor: this.state.sessionActor,
      sessionUpdatedAt: this.state.sessionUpdatedAt,
      file: this.file,
      ...(this.loadError ? { loadError: this.loadError } : {}),
    };
  }

  /** 任一作用域暂停都算“写入已暂停”（server 的 assertEdaWritesOpen 直接用这个布尔值）。 */
  get active() {
    return this.state.paused === true || this.state.sessionPaused === true;
  }

  /**
   * 设置暂停/恢复；写入失败必须抛出（不能内存里改了、重启后又变回放行）。
   * scope='global' 改全局开关，scope='session' 改会话开关，互不覆盖。
   */
  async set({ paused, reason = null, actor = '本机用户', scope = 'global' } = {}) {
    await this.load();
    if (typeof paused !== 'boolean') {
      throw Object.assign(new Error('write-gate.paused 必须是布尔值'), { code: WRITE_GATE_CODES.INVALID, status: 400 });
    }
    const normalizedScope = scope === undefined || scope === null ? 'global' : String(scope);
    if (!SCOPES.includes(normalizedScope)) {
      throw Object.assign(new Error(`write-gate.scope 只能是 ${SCOPES.join('/')}`), { code: WRITE_GATE_CODES.INVALID, status: 400, details: { scope } });
    }
    const at = new Date().toISOString();
    const next = { ...this.state, version: (Number(this.state.version) || 0) + 1 };
    if (normalizedScope === 'global') {
      next.paused = paused;
      next.reason = paused ? cleanText(reason || '用户暂停所有写入', 200) : null;
      next.actor = cleanText(actor || '本机用户', 80);
      next.updatedAt = at;
    } else {
      next.sessionPaused = paused;
      next.sessionReason = paused ? cleanText(reason || '暂停本会话写入', 200) : null;
      next.sessionActor = cleanText(actor || '本机用户', 80);
      next.sessionUpdatedAt = at;
    }
    await fs.mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(temp, this.file);
    this.state = next;
    this.loadError = null;
    return this.snapshot();
  }

  /** 重新读盘（外部/其它进程改过文件时用；正常单 Runtime 部署不需要）。 */
  async refresh() {
    this.loaded = false;
    this.loadError = null;
    this.state = emptyState();
    return this.load();
  }
}

/** 统一构造 409 写暂停错误（所有入口共用同一 code/文案，脚本可按 code 判断）。 */
export function writePausedError(gate, pathname = null) {
  const sessionOnly = gate?.paused !== true && gate?.sessionPaused === true;
  const scope = sessionOnly ? 'session' : 'global';
  const reason = sessionOnly ? (gate?.sessionReason || '暂停本会话写入') : (gate?.reason || '用户暂停所有写入');
  const label = sessionOnly ? '本会话写入已暂停' : '全局写入已暂停';
  return Object.assign(new Error(`${label}（${reason}）：Runtime 拒绝执行 EDA 写操作。请在设置页/会话控制恢复写入后重试`), {
    code: 'EDA_WRITE_PAUSED',
    status: 409,
    details: {
      ...(pathname ? { path: pathname } : {}),
      scope,
      reason,
      actor: sessionOnly ? (gate?.sessionActor ?? null) : (gate?.actor ?? null),
      pausedAt: sessionOnly ? (gate?.sessionUpdatedAt ?? null) : (gate?.updatedAt ?? null),
      gateVersion: gate?.version ?? 0,
      sessionPaused: gate?.sessionPaused === true,
    },
  });
}
