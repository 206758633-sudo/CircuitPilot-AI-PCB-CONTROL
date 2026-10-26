/**
 * C3（剩余）：把签核/导出等"证据文件"显式关联到一次自动化 run。
 *
 * 背景：时间线把 journal / 批准账本 / 证据索引合成一条链，但 evidence ↔ run 只能靠
 * 路径/note/内容启发式猜测；签核与导出各自没有 runId 字段。这里提供**显式关联**：
 * 人/上层在知道对应关系时登记 `{runId, digest}`，时间线按 digest 精确标注 runId；
 * 猜不出来就不猜（启发式仍保留但标注 `linkedBy:'heuristic'` 的来源只来自原有逻辑）。
 *
 * fail-closed：坏行进 invalid（不静默丢）；重复关联拒绝；digest/runId 形状不合法拒绝；
 * 只做追加（append-only JSONL），没有删除/修改接口。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const TIMELINE_LINKS_CODES = Object.freeze({
  INVALID: 'TIMELINE_LINK_INVALID',
  DUPLICATE: 'TIMELINE_LINK_DUPLICATE',
  RUN_NOT_FOUND: 'TIMELINE_LINK_RUN_NOT_FOUND',
  EVIDENCE_NOT_FOUND: 'TIMELINE_LINK_EVIDENCE_NOT_FOUND',
});

const text = (value) => String(value ?? '').trim();
const RUN_ID_RE = /^[A-Za-z0-9._-]{4,120}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export function validateTimelineLink(input = {}) {
  const runId = text(input.runId);
  const digest = text(input.digest).toLowerCase();
  if (!RUN_ID_RE.test(runId)) throw Object.assign(new Error('runId 不合法（4-120 位字母数字/._-）'), { code: TIMELINE_LINKS_CODES.INVALID, details: { field: 'runId' } });
  if (!DIGEST_RE.test(digest)) throw Object.assign(new Error('digest 必须是 64 位 sha256 十六进制'), { code: TIMELINE_LINKS_CODES.INVALID, details: { field: 'digest' } });
  const note = text(input.note).slice(0, 500);
  return { runId, digest, note: note || null };
}

/** 读回链接；坏行进 invalid，不静默丢弃。文件不存在返回空（available:true 但 count 0）。 */
export function loadTimelineLinks({ file, readFile = readFileSync } = {}) {
  if (!file) return { available: false, reason: 'linksFile 未提供', count: 0, links: [], invalid: [] };
  if (!existsSync(file)) return { available: true, reason: null, count: 0, links: [], invalid: [] };
  let raw = '';
  try { raw = String(readFile(file, 'utf8')); } catch (error) { return { available: false, reason: `读取失败：${String(error?.message || error).slice(0, 160)}`, count: 0, links: [], invalid: [] }; }
  const links = [];
  const invalid = [];
  raw.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      const runId = text(parsed?.runId); const digest = text(parsed?.digest).toLowerCase();
      if (!RUN_ID_RE.test(runId) || !DIGEST_RE.test(digest)) throw new Error('字段不合法');
      links.push({ runId, digest, note: text(parsed?.note) || null, at: text(parsed?.at) || null });
    } catch (error) { invalid.push({ line: index + 1, reason: error instanceof Error ? error.message : '解析失败' }); }
  });
  return { available: true, reason: null, count: links.length, links, invalid };
}

/** 追加一条关联（append-only）；重复/不存在由调用方先校验。 */
export function appendTimelineLink({ file, runId, digest, note = null, at = new Date().toISOString() } = {}) {
  const normalized = validateTimelineLink({ runId, digest, note });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ...normalized, at })}\n`, 'utf8');
  return { ...normalized, at };
}
