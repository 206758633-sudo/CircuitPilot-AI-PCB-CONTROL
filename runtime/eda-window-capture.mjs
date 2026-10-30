/**
 * E9 兜底截图：CDP `Page.captureScreenshot` 在本机 EDA 3.2.186 上会超时，
 * 而"兜底动作必须有截图证据"不能因为一个通道坏了就造假。这里用 macOS 自带
 * `screencapture -R <EDA 窗口区域>` 截**仅 EDA 窗口**的 PNG（不截全屏，避免
 * 把用户其它窗口带进证据），并返回 sha256/字节数/窗口 bounds。
 *
 * 只读：不点击、不改 EDA 状态。失败时抛结构化错误（调用方决定是否降级为 JSON 证据）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';

export const EDA_WINDOW_CAPTURE_CODES = Object.freeze({
  BOUNDS_FAILED: 'EDA_WINDOW_BOUNDS_FAILED',
  CAPTURE_FAILED: 'EDA_WINDOW_CAPTURE_FAILED',
  UNSUPPORTED: 'EDA_WINDOW_CAPTURE_UNSUPPORTED',
});

const APP_NAME = 'LCEDA-Pro';
const BOUNDS_SCRIPT = `tell application "System Events" to tell process "${APP_NAME}" to get {position, size} of window 1`;

/** 解析 AppleScript 返回的 "x, y, w, h"（position 与 size 会被拍平成 4 个数）。 */
export function parseWindowBounds(stdout) {
  const numbers = String(stdout || '').match(/-?\d+/g)?.map(Number) ?? [];
  if (numbers.length < 4 || numbers.some((value) => !Number.isFinite(value))) return null;
  const [x, y, width, height] = numbers;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export function captureEdaWindow({ outDir, now = () => new Date(), spawnSync = nodeSpawnSync, captureExecutable = 'screencapture', osascript = 'osascript', platform = process.platform } = {}) {
  if (platform !== 'darwin') {
    throw Object.assign(new Error(`当前平台 ${platform} 尚未实现 EDA 窗口截图兜底；请使用 CDP 截图或人工截图，不能伪造证据`), { code: EDA_WINDOW_CAPTURE_CODES.UNSUPPORTED, details: { platform } });
  }
  if (!outDir) throw Object.assign(new Error('截图输出目录不能为空'), { code: EDA_WINDOW_CAPTURE_CODES.CAPTURE_FAILED });
  const boundsRun = spawnSync(osascript, ['-e', BOUNDS_SCRIPT], { encoding: 'utf8', timeout: 15_000 });
  if (boundsRun?.status !== 0) {
    throw Object.assign(new Error(`读不到 EDA 窗口位置：${String(boundsRun?.stderr || boundsRun?.error?.message || 'osascript 失败').slice(0, 200)}`), { code: EDA_WINDOW_CAPTURE_CODES.BOUNDS_FAILED, details: { status: boundsRun?.status ?? null } });
  }
  const bounds = parseWindowBounds(boundsRun.stdout);
  if (!bounds) throw Object.assign(new Error(`EDA 窗口位置无法解析：${String(boundsRun.stdout || '').slice(0, 120)}`), { code: EDA_WINDOW_CAPTURE_CODES.BOUNDS_FAILED });
  mkdirSync(outDir, { recursive: true });
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const file = join(outDir, `eda-window-${stamp}.png`);
  const region = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  const shot = spawnSync(captureExecutable, ['-x', '-R', region, file], { timeout: 30_000 });
  if (shot?.status !== 0 || !existsSync(file)) {
    throw Object.assign(new Error(`窗口截图失败：${String(shot?.stderr || shot?.error?.message || 'screencapture 失败').slice(0, 200)}`), { code: EDA_WINDOW_CAPTURE_CODES.CAPTURE_FAILED, details: { region } });
  }
  const bytes = readFileSync(file);
  if (!bytes.length) throw Object.assign(new Error('窗口截图文件为空'), { code: EDA_WINDOW_CAPTURE_CODES.CAPTURE_FAILED, details: { file } });
  return { ok: true, kind: 'os-window-capture', path: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: statSync(file).size, bounds, region, note: 'CDP Page.captureScreenshot 超时后改用 macOS 窗口区域截图（仅 EDA 窗口）' };
}
