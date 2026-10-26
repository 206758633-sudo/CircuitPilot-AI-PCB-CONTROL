/**
 * 证据新鲜度/归属校验：防止"引用旧证据"把门禁放过去（假证据是发布链路上最危险的一类问题）。
 *
 * 场景（真机第 59 轮）：原理图验收用 `loadSimulationEvidence` 回退引用本机落盘的
 * `spice-simulation` 证据。如果只取 `latest()`，就可能引用到：
 *   - 别的工程/别的文档的证据（换项目后文件还在）；
 *   - 改版之前的旧证据（设计已变，仿真结论不再成立）；
 *   - 过期很久的证据。
 * 本模块只做判定、不读文件：调用方把证据条目 + 当前 EDA 指纹交进来，拿 `{ok, problems}`。
 */
export const DEFAULT_SIM_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object|null} entry 证据条目（evidence-store 结构：{kind,savedAt,digest,fingerprint,payload}）
 * @param {{current?: {windowId?: string|null, projectUuid?: string|null, documentUuid?: string|null}|null, maxAgeMs?: number, now?: number}} options
 * @returns {{ok: boolean, problems: string[], savedAt: string|null, ageHours: number|null}}
 */
export function assessEvidenceFreshness(entry, { current = null, maxAgeMs = DEFAULT_SIM_EVIDENCE_MAX_AGE_MS, now = Date.now() } = {}) {
  const problems = [];
  if (!entry || typeof entry !== 'object') return { ok: false, problems: ['证据不存在'], savedAt: null, ageHours: null };
  if (!entry.digest || typeof entry.digest !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.digest)) problems.push('证据缺少有效摘要（digest）');
  const savedAtMs = Date.parse(String(entry.savedAt || ''));
  let ageHours = null;
  if (!Number.isFinite(savedAtMs)) problems.push('证据缺少有效落盘时间（savedAt）');
  else {
    ageHours = Math.round(((now - savedAtMs) / 3_600_000) * 10) / 10;
    const limitHours = Math.round((Number(maxAgeMs) || DEFAULT_SIM_EVIDENCE_MAX_AGE_MS) / 3_600_000);
    if (now - savedAtMs > maxAgeMs) problems.push(`证据已过期（落盘 ${new Date(savedAtMs).toISOString()}，超过 ${limitHours} 小时）`);
  }
  const fingerprint = entry.fingerprint && typeof entry.fingerprint === 'object' ? entry.fingerprint : {};
  if (current) {
    if (!fingerprint.projectUuid && current.projectUuid) problems.push('证据没有绑定工程（无法确认是当前工程的仿真结论）');
    else if (fingerprint.projectUuid && current.projectUuid && String(fingerprint.projectUuid) !== String(current.projectUuid)) problems.push(`证据属于其它工程（证据 ${fingerprint.projectUuid} ≠ 当前 ${current.projectUuid}）`);
    if (fingerprint.windowId && current.windowId && String(fingerprint.windowId) !== String(current.windowId)) problems.push('证据绑定的是其它 EDA 窗口');
    if (fingerprint.documentUuid && current.documentUuid && String(fingerprint.documentUuid) !== String(current.documentUuid)) problems.push('证据绑定的是其它文档（设计文档已切换）');
  }
  return { ok: problems.length === 0, problems, savedAt: Number.isFinite(savedAtMs) ? new Date(savedAtMs).toISOString() : null, ageHours };
}
