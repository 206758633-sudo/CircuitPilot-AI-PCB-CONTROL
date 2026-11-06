/**
 * KiCad CLI DRC 适配器（外部 oracle，fail-closed）。
 *
 * 定位：Rule-as-Code 只覆盖规则包里"能写公式"的部分；真实 DRC 必须由 EDA/KiCad 产出。
 * 本文件是**唯一**的 KiCad DRC 入口，遵循 runtime/simulation.mjs 的外部求解器范式：
 *
 *   - 只有真的 spawn 了 `kicad-cli` 并解析到合法 JSON 报告，才返回 ok:true；
 *   - 缺 CLI / 不可执行 → KICAD_CLI_MISSING；缺输入 → KICAD_DRC_INPUT_MISSING；
 *     超时 → KICAD_DRC_TIMEOUT；报告取不到/JSON 非法/结构不认识 → KICAD_DRC_REPORT_INVALID；
 *   - **绝不**在报告缺失/非法时返回 "0 violations" 假装通过——调用方只能把 ok:false 当"不可放行"。
 *
 * 真机现状（本机未安装 KiCad）：detectKicadCli() 会如实返回 available:false；
 * 测试用临时伪造的 `kicad-cli` 脚本覆盖"成功/非法/超时/缺命令"四种路径，不连真实 KiCad。
 *
 * 纯 Node 内置模块；不联网、不读用户配置；临时目录跑完清理。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const KICAD_DRC_CODES = Object.freeze({
  CLI_MISSING: 'KICAD_CLI_MISSING',
  INPUT_MISSING: 'KICAD_DRC_INPUT_MISSING',
  TIMEOUT: 'KICAD_DRC_TIMEOUT',
  REPORT_INVALID: 'KICAD_DRC_REPORT_INVALID',
  EXEC_FAILED: 'KICAD_DRC_EXEC_FAILED',
});

export const DEFAULT_DRC_TIMEOUT_MS = 120_000;
export const DEFAULT_DETECT_TIMEOUT_MS = 5_000;

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uniq = (values) => [...new Set(values)];

function failure(code, message, extra = {}) {
  return { ok: false, code, message, findings: [], counts: null, exitCode: null, reportDigest: null, durationMs: 0, ...extra };
}

/* ------------------------------------------------------------------ */
/* CLI 探测                                                            */
/* ------------------------------------------------------------------ */

/**
 * 探测可用的 kicad-cli。只做真的 `--version` 调用，不猜"大概装在哪就当作装好了"。
 *
 * @param {{env?: object, candidates?: string[], timeoutMs?: number}} [options]
 * @returns {{available:boolean, command:string|null, version?:string, searched:string[], reason?:string}}
 */
export function detectKicadCli({ env = process.env, candidates = ['kicad-cli'], timeoutMs = DEFAULT_DETECT_TIMEOUT_MS } = {}) {
  const explicit = String(env?.KICAD_CLI_PATH ?? '').trim();
  const searched = [];
  const list = uniq([explicit, ...(Array.isArray(candidates) ? candidates : [])].filter(Boolean).map((item) => String(item)));
  for (const candidate of list) {
    searched.push(candidate);
    const result = spawnSync(candidate, ['--version'], { timeout: Math.max(200, Number(timeoutMs) || DEFAULT_DETECT_TIMEOUT_MS), encoding: 'utf8', env });
    if (result.error) {
      // ENOENT/EACCES/超时都说明这个候选不可用；继续找下一个，而不是直接转成"没有 DRC"。
      if (result.error.code === 'ENOENT' || result.error.code === 'EACCES') continue;
      continue;
    }
    const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    if (!text) continue;
    const version = text.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? null;
    return { available: true, command: candidate, version, searched };
  }
  return { available: false, command: null, searched, reason: list.length ? `已尝试 ${list.length} 个候选，均不可用` : '没有候选命令' };
}

/** 路径形态的 command 先做可执行性检查，避免把 EACCES 误报成"报告非法"。 */
function commandProblem(command) {
  if (typeof command !== 'string' || !command.trim()) return KICAD_DRC_CODES.CLI_MISSING;
  const trimmed = command.trim();
  if (!trimmed.includes('/') && !trimmed.includes('\\')) return null; // 裸命令名交给 spawn 解析 PATH
  try {
    accessSync(trimmed, constants.X_OK);
    return null;
  } catch {
    return KICAD_DRC_CODES.CLI_MISSING;
  }
}

/* ------------------------------------------------------------------ */
/* 报告解析（纯函数，便于单测）                                        */
/* ------------------------------------------------------------------ */

const SEVERITIES = new Set(['error', 'warning', 'exclusion', 'ignore', 'info']);

function normalizeSeverity(raw) {
  const text = String(raw ?? '').toLowerCase();
  if (SEVERITIES.has(text)) return text;
  if (text === 'fatal' || text === 'critical') return 'error';
  if (text === 'warn') return 'warning';
  return 'error'; // KiCad 的 violation 默认视为 error；不认识就按最严处理
}

function normalizeViolation(raw, index, fallbackType) {
  const source = isRecord(raw) ? raw : {};
  const type = String(source.type ?? source.rule ?? source.rule_id ?? fallbackType ?? 'unknown');
  const description = String(source.description ?? source.message ?? source.text ?? `${type} #${index + 1}`);
  const items = Array.isArray(source.items) ? source.items : null;
  return {
    severity: normalizeSeverity(source.severity ?? (source.is_error === true ? 'error' : source.is_error === false ? 'warning' : undefined)),
    type,
    description,
    ...(items ? { items } : {}),
    ...(source.sheet_path === undefined ? {} : { sheetPath: String(source.sheet_path) }),
    ...(source.excluded === true ? { excluded: true } : {}),
  };
}

/**
 * 解析 KiCad `pcb drc --format json` 报告文本。
 * 兼容顶层 `violations` / `items` / `unconnected_items`（KiCad 8/9 及部分封装差异）；
 * 如果一个可识别的列表都没有，返回 KICAD_DRC_REPORT_INVALID——**不能**把它当成 0 违规。
 *
 * @param {string} reportText
 * @returns {{ok:true, findings:Array, counts:object, payload:object} | {ok:false, code:string, message:string}}
 */
export function parseKicadDrcReport(reportText) {
  if (typeof reportText !== 'string' || !reportText.trim()) {
    return { ok: false, code: KICAD_DRC_CODES.REPORT_INVALID, message: 'DRC 报告为空：没有可解析的 JSON' };
  }
  let payload;
  try {
    payload = JSON.parse(reportText);
  } catch (error) {
    return { ok: false, code: KICAD_DRC_CODES.REPORT_INVALID, message: `DRC 报告不是合法 JSON：${String(error?.message ?? error).slice(0, 200)}` };
  }
  if (!isRecord(payload)) {
    return { ok: false, code: KICAD_DRC_CODES.REPORT_INVALID, message: `DRC 报告顶层必须是对象（收到 ${Array.isArray(payload) ? 'array' : typeof payload}）` };
  }
  const knownKeys = ['violations', 'items', 'unconnectedItems', 'unconnected_items', 'schematic_parity'];
  const hasKnownKey = knownKeys.some((key) => Object.prototype.hasOwnProperty.call(payload, key));
  if (!hasKnownKey) {
    return { ok: false, code: KICAD_DRC_CODES.REPORT_INVALID, message: `DRC 报告里没有任何已知结果字段（${knownKeys.join(' / ')}），不能当作 0 违规` };
  }
  // 已知字段存在但不是数组 → 结构不认识，必须报错；否则会被静默当成"0 违规"。
  const nonArrayFields = ['violations', 'items', 'schematic_parity', 'unconnected_items', 'unconnectedItems']
    .filter((key) => Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== null && !Array.isArray(payload[key]));
  if (nonArrayFields.length) {
    return { ok: false, code: KICAD_DRC_CODES.REPORT_INVALID, message: `DRC 报告字段不是数组：${nonArrayFields.join(' / ')}` };
  }
  const findings = [];
  const collect = (list, fallbackType, label) => {
    if (!Array.isArray(list)) return;
    list.forEach((item, index) => findings.push({ ...normalizeViolation(item, index, fallbackType), source: label }));
  };
  collect(payload.violations, 'violation', 'violations');
  if (!Array.isArray(payload.violations)) collect(payload.items, 'item', 'items');
  const unconnected = payload.unconnected_items ?? payload.unconnectedItems;
  if (unconnected !== undefined && !Array.isArray(unconnected)) {
    return { ok: false, code: KICAD_DRC_CODES.REPORT_INVALID, message: 'DRC 报告的 unconnected_items 不是数组' };
  }
  collect(unconnected, 'unconnected', 'unconnected_items');
  collect(payload.schematic_parity, 'schematic_parity', 'schematic_parity');
  const counts = {
    violations: Array.isArray(payload.violations) ? payload.violations.length : 0,
    items: Array.isArray(payload.items) ? payload.items.length : 0,
    unconnectedItems: Array.isArray(unconnected) ? unconnected.length : 0,
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
    exclusions: findings.filter((finding) => finding.severity === 'exclusion').length,
    total: findings.length,
  };
  return { ok: true, findings, counts, payload };
}

/* ------------------------------------------------------------------ */
/* 执行 DRC                                                            */
/* ------------------------------------------------------------------ */

function readReport({ reportPath, stdout }) {
  if (reportPath && existsSync(reportPath)) {
    try {
      return { text: readFileSync(reportPath, 'utf8'), source: 'file' };
    } catch {
      /* 落到 stdout 兜底 */
    }
  }
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return { text: trimmed, source: 'stdout' };
  return { text: '', source: null };
}

/**
 * 真跑一次 `kicad-cli pcb drc --format json --output <tmp> <pcbFile>`。
 *
 * @param {{pcbFile?: string, command?: string, timeoutMs?: number, workdir?: string, env?: object}} [options]
 * @returns {{ok:true, exitCode:number|null, findings:Array, counts:object, reportDigest:string,
 *            durationMs:number, reportSource:string, command:string, pcbFile:string}
 *          | {ok:false, code:string, message:string, findings:Array, counts:null, exitCode:number|null,
 *             reportDigest:null, durationMs:number}}
 */
export function runKicadDrc({ pcbFile, command, timeoutMs = DEFAULT_DRC_TIMEOUT_MS, workdir, env } = {}) {
  const startedAt = Date.now();
  const commandIssue = commandProblem(command);
  if (commandIssue) {
    return failure(commandIssue, `KiCad CLI 不可用：${JSON.stringify(command ?? null)}（需要可执行的 kicad-cli；本机未安装时请先安装或用 detectKicadCli 探测）`, { durationMs: Date.now() - startedAt });
  }
  if (typeof pcbFile !== 'string' || !pcbFile.trim()) {
    return failure(KICAD_DRC_CODES.INPUT_MISSING, '缺少 pcbFile（KiCad .kicad_pcb 路径）', { durationMs: Date.now() - startedAt });
  }
  if (!existsSync(pcbFile)) {
    return failure(KICAD_DRC_CODES.INPUT_MISSING, `pcbFile 不存在：${pcbFile}`, { durationMs: Date.now() - startedAt });
  }
  const budget = Math.max(1, Number(timeoutMs) || DEFAULT_DRC_TIMEOUT_MS);
  let dir;
  let cleanup = false;
  try {
    dir = workdir ? mkdtempSync(join(workdir, 'kicad-drc-')) : mkdtempSync(join(tmpdir(), 'kicad-drc-'));
    cleanup = true;
  } catch (error) {
    return failure(KICAD_DRC_CODES.EXEC_FAILED, `无法创建 DRC 临时目录：${error?.message ?? String(error)}`, { durationMs: Date.now() - startedAt });
  }
  const reportPath = join(dir, 'drc-report.json');
  const args = ['pcb', 'drc', '--format', 'json', '--output', reportPath, pcbFile];
  try {
    const invoked = spawnSync(command, args, {
      cwd: dir,
      encoding: 'utf8',
      timeout: budget,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(isRecord(env) ? env : {}) },
    });
    const durationMs = Date.now() - startedAt;
    if (invoked.error) {
      const errorCode = invoked.error.code;
      if (errorCode === 'ETIMEDOUT' || (invoked.signal && durationMs >= budget - 100)) {
        return failure(KICAD_DRC_CODES.TIMEOUT, `kicad-cli DRC 超过 ${budget}ms 未结束，已终止`, { durationMs });
      }
      if (errorCode === 'ENOENT' || errorCode === 'EACCES') {
        return failure(KICAD_DRC_CODES.CLI_MISSING, `KiCad CLI 无法执行：${invoked.error.message}`, { durationMs });
      }
      return failure(KICAD_DRC_CODES.EXEC_FAILED, `kicad-cli 启动失败：${invoked.error.message}`, { durationMs });
    }
    const exitCode = Number.isInteger(invoked.status) ? invoked.status : null;
    const report = readReport({ reportPath, stdout: invoked.stdout });
    if (!report.text) {
      return failure(
        KICAD_DRC_CODES.REPORT_INVALID,
        `kicad-cli 退出码 ${exitCode ?? 'n/a'}，但没有产出可解析的 JSON 报告${invoked.stderr ? `：${String(invoked.stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 300)}` : ''}`,
        { durationMs, exitCode },
      );
    }
    const parsed = parseKicadDrcReport(report.text);
    if (!parsed.ok) return failure(parsed.code, parsed.message, { durationMs, exitCode });
    // 非零退出但报告可解析：如实返回 exitCode，让调用方自己决定门禁（不隐藏真实退出状态）。
    return {
      ok: true,
      exitCode,
      findings: parsed.findings,
      counts: parsed.counts,
      reportDigest: sha256(report.text),
      reportSource: report.source,
      durationMs,
      command,
      pcbFile,
      args,
    };
  } finally {
    if (cleanup && dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不掩盖主结果 */ }
    }
  }
}
