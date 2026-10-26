/**
 * GUI 截图的产品化传输：小图内联、大图落盘 + 摘要。
 *
 * 真机问题（第 59 轮）：3420×2040 的整页截图 base64 ≈ 4.6MB，经 Runtime HTTP 响应 /
 * 日志 / 外部工具层传输时会被截断成 "[truncated N chars]"，调用方解析半截 base64 必然失败，
 * 而失败看起来像"截图坏了"，实际是**响应体太大**。
 *
 * 取舍：
 *  - 小截图（<= inlineMaxBytes）保持 `{base64}` 内联，完全兼容既有调用方；
 *  - 大截图落盘到证据目录，返回 `{kind:'file', path, bytes, sha256}`：
 *    数据完整（可复核 sha256）、响应体小、截图本身成为可归档证据。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_INLINE_SCREENSHOT_MAX_BYTES = 256 * 1024;

const stamp = (now) => (now instanceof Date ? now : new Date(now)).toISOString().replace(/[:.]/g, '-');

/**
 * @param {{base64?: string, bytes?: number|null, outDir?: string|null, namePrefix?: string, inlineMaxBytes?: number, now?: Date}} options
 * @returns {{ok: boolean, reason?: string, inline?: boolean, kind?: string, base64?: string, path?: string, bytes?: number, sha256?: string}}
 */
export function materializeGuiScreenshot({
  base64 = '',
  bytes = null,
  outDir = null,
  namePrefix = 'gui-screenshot',
  inlineMaxBytes = DEFAULT_INLINE_SCREENSHOT_MAX_BYTES,
  now = new Date(),
} = {}) {
  const text = typeof base64 === 'string' ? base64 : '';
  if (!text) return { ok: false, reason: 'EMPTY_SCREENSHOT_BASE64' };
  const buffer = Buffer.from(text, 'base64');
  if (!buffer.length) return { ok: false, reason: 'EMPTY_SCREENSHOT_BASE64' };
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const reportedBytes = bytes !== null && bytes !== undefined && Number.isFinite(Number(bytes)) ? Number(bytes) : buffer.length;
  if (!outDir) return { ok: true, inline: true, kind: 'inline', sha256, bytes: reportedBytes, base64: text };
  if (buffer.length <= inlineMaxBytes) return { ok: true, inline: true, kind: 'inline', sha256, bytes: reportedBytes, base64: text };
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${namePrefix}-${stamp(now)}-${sha256.slice(0, 8)}.png`);
  writeFileSync(file, buffer);
  return { ok: true, inline: false, kind: 'file', path: file, bytes: buffer.length, sha256 };
}
