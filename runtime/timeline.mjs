/**
 * C3：统一证据时间线。
 *
 * 问题：执行 journal、批准账本、DRC/DFM/导出证据分散在不同目录/页面，"这次运行到底发生了什么"要人工拼。
 * 本模块把三类事实合成一条按时间倒序的时间线（只读、有界、不猜）：
 *   - run：`<journalDir>/<runId>.jsonl` 的运行/步骤阶段（哈希链里每条都带 at/phase）；
 *   - approval：统一批准账本（签发/消费/撤销/过期/不匹配）；
 *   - evidence：证据目录索引（kind/digest/savedAt/path）。
 *
 * fail-closed 取向：目录/账本读不到就写 `sources.*.available:false + reason`；坏行进 `invalid` 并暴露，
 * 不静默跳过；时间未知的条目排最后（不能靠"看起来新"冒充时间）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildEvidenceIndex } from './evidence-index.mjs';
import { loadTimelineLinks } from './timeline-links.mjs';

export const TIMELINE_CODES = Object.freeze({ DIRS_REQUIRED: 'TIMELINE_DIRS_REQUIRED' });

const text = (value) => String(value ?? '').trim();
const isoOf = (value) => (typeof value === 'string' && value ? value : null);

function summarizeRunEntry(entry) {
  const phase = text(entry?.phase) || 'unknown';
  const stepPart = entry?.stepId ? ` · 步骤 ${entry.stepId}` : '';
  const reason = entry?.reason ? ` · ${entry.reason}` : '';
  const errorPart = entry?.error?.message ? ` · ${String(entry.error.message).slice(0, 160)}` : '';
  return `${phase}${stepPart}${reason}${errorPart}`;
}

/**
 * @param {object} options
 * @param {string} options.journalDir 自动化 journal 目录（approval-*.jsonl 账本也会被排除）
 * @param {string} [options.evidenceDir] 证据目录（交给 evidence-index 索引）
 * @param {string} [options.approvalsFile] 统一批准账本 JSON 文件
 * @param {string|null} [options.runId] 只看某次运行（证据按 path/note 里出现 runId 关联）
 * @param {number} [options.limit]
 */
export function buildTimeline({ journalDir, evidenceDir = null, approvalsFile = null, linksFile = null, runId = null, limit = 200, now = () => new Date() } = {}) {
  if (!text(journalDir)) throw Object.assign(new Error('时间线至少需要 journal 目录'), { code: TIMELINE_CODES.DIRS_REQUIRED });
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw Object.assign(new Error('limit 必须是 1-1000 的整数'), { code: TIMELINE_CODES.DIRS_REQUIRED });
  const selectedRun = runId ? text(runId) : null;
  const sources = {
    journal: { available: false, reason: null, files: 0 },
    approvals: { available: false, reason: null, entries: 0 },
    evidence: { available: false, reason: null, entries: 0 },
    links: { available: false, reason: '未提供链接文件', count: 0 },
  };
  const invalid = [];
  const entries = [];
  // C3（剩余）：显式证据↔run 关联（人工/上层登记），digest 精确匹配；关联读坏进 invalid。
  const links = loadTimelineLinks({ file: linksFile });
  sources.links = { available: links.available, reason: links.reason, count: links.count };
  for (const bad of links.invalid || []) invalid.push({ file: linksFile || '?', error: `链接行 ${bad.line} 损坏：${bad.reason}` });
  const linksByDigest = new Map();
  for (const link of links.links || []) if (!linksByDigest.has(link.digest)) linksByDigest.set(link.digest, link);

  // 1) 运行 journal
  try {
    if (!existsSync(journalDir)) {
      sources.journal.reason = `journal 目录不存在：${journalDir}`;
    } else {
      sources.journal.available = true;
      const files = readdirSync(journalDir).filter((name) => name.endsWith('.jsonl') && !name.startsWith('approval-'));
      sources.journal.files = files.length;
      for (const file of files) {
        const fileRunId = file.slice(0, -'.jsonl'.length);
        if (selectedRun && fileRunId !== selectedRun) continue;
        let lines;
        try {
          lines = readFileSync(join(journalDir, file), 'utf8').split('\n').filter((line) => line.trim());
        } catch (error) {
          invalid.push({ file, error: String(error?.message || error).slice(0, 160) });
          continue;
        }
        lines.forEach((line, index) => {
          let parsed;
          try { parsed = JSON.parse(line); } catch (error) { invalid.push({ file, line: index + 1, error: 'JSON 解析失败' }); return; }
          entries.push({
            at: isoOf(parsed.at),
            kind: 'run',
            runId: parsed.runId || fileRunId,
            seq: Number.isInteger(parsed.seq) ? parsed.seq : null,
            phase: text(parsed.phase) || 'unknown',
            stepId: parsed.stepId ? text(parsed.stepId) : null,
            summary: summarizeRunEntry(parsed),
            digest: parsed.hash ? String(parsed.hash) : (parsed.stateDigest ? String(parsed.stateDigest) : null),
            detail: {
              attempt: parsed.attempt ?? null,
              strategy: parsed.strategy ?? null,
              ok: parsed.ok ?? null,
              reason: parsed.reason ?? null,
              state: parsed.state ?? null,
              error: parsed.error?.code ?? null,
            },
          });
        });
      }
    }
  } catch (error) {
    sources.journal.available = false;
    sources.journal.reason = String(error?.message || error).slice(0, 200);
  }

  // 2) 统一批准账本
  try {
    if (!approvalsFile || !existsSync(approvalsFile)) {
      sources.approvals.reason = approvalsFile ? `批准账本不存在：${approvalsFile}` : '未提供批准账本路径';
    } else {
      const parsed = JSON.parse(readFileSync(approvalsFile, 'utf8'));
      const list = parsed?.data?.entries;
      if (!Array.isArray(list)) throw Object.assign(new Error('批准账本缺 data.entries'), { code: 'TIMELINE_LEDGER_INVALID' });
      sources.approvals.available = true;
      sources.approvals.entries = list.length;
      for (const item of list) {
        if (selectedRun && !`${item?.note || ''} ${item?.approvalId || ''}`.includes(selectedRun)) continue;
        entries.push({
          at: isoOf(item?.at),
          kind: 'approval',
          runId: null,
          phase: text(item?.action) || 'unknown',
          summary: `批准 ${text(item?.scope) || '?'} / ${text(item?.action) || '?'}${item?.approvalId ? ` · ${String(item.approvalId).slice(0, 24)}` : ''}`,
          digest: item?.entryHash ? String(item.entryHash) : null,
          detail: { scope: item?.scope ?? null, approvalId: item?.approvalId ?? null, bindings: item?.bindings ?? null, note: item?.note ?? null },
        });
      }
    }
  } catch (error) {
    sources.approvals.available = false;
    sources.approvals.reason = String(error?.message || error).slice(0, 200);
  }

  // 3) 证据索引
  if (evidenceDir) {
    try {
      if (!existsSync(evidenceDir)) {
        sources.evidence.reason = `证据目录不存在：${evidenceDir}`;
      } else {
        const index = buildEvidenceIndex({ dirs: [evidenceDir] });
        sources.evidence.available = true;
        sources.evidence.entries = index.entries.length;
        sources.evidence.complete = index.complete === true;
        sources.evidence.truncated = index.truncated === true;
        for (const item of index.entries) {
          const path = String(item?.path || '');
          const note = text(item?.note);
          const explicitLink = item?.digest ? linksByDigest.get(String(item.digest).toLowerCase()) || null : null;
          const heuristicMatch = Boolean(selectedRun) && (() => { let raw = ''; try { raw = readFileSync(path, 'utf8').slice(0, 4000); } catch { raw = ''; } return `${path} ${note} ${raw}`.includes(selectedRun); })();
          if (selectedRun && !explicitLink && !heuristicMatch) continue;
          if (selectedRun && explicitLink && explicitLink.runId !== selectedRun) continue;
          entries.push({
            at: isoOf(item?.savedAt),
            kind: 'evidence',
            runId: explicitLink ? explicitLink.runId : null,
            linkedBy: explicitLink ? 'explicit' : null,
            phase: text(item?.kind) || 'unknown',
            summary: `证据 ${text(item?.kind) || '?'}${note ? ` · ${note.slice(0, 160)}` : ''}`,
            digest: item?.digest ? String(item.digest) : null,
            detail: { path, bytes: item?.bytes ?? null, fingerprint: item?.fingerprint ?? null },
          });
        }
        for (const bad of index.invalid || []) invalid.push({ file: String(bad?.path || '?'), error: '证据文件损坏' });
      }
    } catch (error) {
      sources.evidence.available = false;
      sources.evidence.reason = String(error?.message || error).slice(0, 200);
    }
  } else {
    sources.evidence.reason = '未提供证据目录';
  }

  // 时间倒序；时间未知的排最后（不伪装成"最新"）。
  entries.sort((left, right) => {
    if (left.at && right.at) return right.at.localeCompare(left.at);
    if (left.at) return -1;
    if (right.at) return 1;
    return 0;
  });
  const total = entries.length;
  const truncated = total > limit;
  const page = entries.slice(0, limit);
  const counts = page.reduce((acc, item) => { acc[item.kind] = (acc[item.kind] || 0) + 1; return acc; }, { run: 0, approval: 0, evidence: 0 });
  return {
    ok: true,
    generatedAt: typeof now === 'function' ? new Date(now()).toISOString() : new Date().toISOString(),
    runId: selectedRun,
    entries: page,
    counts,
    total,
    truncated,
    invalid,
    sources,
    complete: invalid.length === 0 && sources.journal.available,
  };
}
