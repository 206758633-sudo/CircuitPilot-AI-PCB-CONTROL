import { PCB_GATES, evaluatePcbGates } from './gate-engine.mjs';

/**
 * 门禁服务（W5-03/W5-04）：从证据库取最新证据 → Gate Engine 裁决 → 归档门禁报告 → 人工终审签字。
 *
 * 不可绕过的规矩：
 *   - 签字只能签 `pass`；blocked/unknown 一律拒绝（要签就先修设计/补证据）；
 *   - P0-5：评估落独立 `gate-report`、终审签字落 `gate-signoff`（不再占用交付签核 `signoff`）；
 *     签字同时写 approval-ledger 哈希链（可核对历史）；
 *   - 门禁报告里保留所用证据的 kind/digest/path，事后可逐条回溯。
 */
export const GATE_SERVICE_CODES = Object.freeze({
  INVALID: 'GATE_SERVICE_INVALID',
  SIGNOFF_BLOCKED: 'GATE_SIGNOFF_BLOCKED',
  SIGNOFF_REQUIRED: 'GATE_SIGNOFF_REQUIRED',
});

const coded = (code, message, details = null) => Object.assign(new Error(message), { code, details });
const evidenceKinds = () => [...new Set(PCB_GATES.flatMap((gate) => gate.requiredKinds))];

export function createGateService({ evidenceStore, approvalLedger = null, now = () => new Date() } = {}) {
  if (!evidenceStore || typeof evidenceStore.latest !== 'function' || typeof evidenceStore.save !== 'function') throw coded(GATE_SERVICE_CODES.INVALID, '门禁服务需要注入 evidence store');

  const collect = ({ pcbUuid } = {}) => {
    if (!pcbUuid || !String(pcbUuid).trim()) throw coded(GATE_SERVICE_CODES.INVALID, '需要 pcbUuid 才能评估门禁');
    const target = String(pcbUuid).trim();
    const envelopes = [];
    const refs = [];
    const pushEntry = (kind, entry) => {
      envelopes.push(entry.payload);
      refs.push({ kind, digest: entry.digest, path: entry.path, savedAt: entry.savedAt });
    };
    for (const kind of evidenceKinds()) {
      // task-16：lib-evidence 是**逐器件**凭证，G2 必须看全部器件；只看 latest 会让
      // "U1 通过、U2 blocked" 被最新一条 pass 盖住（fail-open）。其它 kind 仍按 latest（单份证据）。
      if (kind === 'lib-evidence') {
        const entries = evidenceStore.list(kind, { fingerprint: { pcbUuid: target } }) ?? [];
        const matching = entries.filter((entry) => (entry?.fingerprint?.pcbUuid ?? null) === target);
        for (const entry of matching) pushEntry(kind, entry);
        continue;
      }
      const entry = evidenceStore.latest(kind, { fingerprint: { pcbUuid: target } });
      if (!entry) continue;
      pushEntry(kind, entry);
    }
    return { envelopes, refs };
  };

  const status = ({ pcbUuid } = {}) => {
    const { envelopes, refs } = collect({ pcbUuid });
    return { report: evaluatePcbGates({ envelopes, targetPcbUuid: String(pcbUuid).trim() }), evidenceRefs: refs };
  };

  const evaluate = ({ pcbUuid } = {}) => {
    const { report, evidenceRefs } = status({ pcbUuid });
    // P0-5：报告必须用独立 kind。修复前写进 'signoff' 会让一次"评估"遮蔽真实交付签核
    // （release/export/readiness 都用 latest('signoff')），统一裁决随后报"签核不通过"。
    const saved = evidenceStore.save({
      kind: 'gate-report',
      payload: { kind: 'gate-report', schemaVersion: 1, pcbUuid: String(pcbUuid).trim(), report, evidenceRefs },
      fingerprint: { pcbUuid: String(pcbUuid).trim() },
      note: 'W5-03 门禁评估报告（未签字）',
    });
    return { report, evidenceRefs, evidencePath: saved.path, digest: saved.digest };
  };

  const signoff = ({ pcbUuid, signedBy, decision = 'approve', note = '' } = {}) => {
    if (!signedBy || !String(signedBy).trim()) throw coded(GATE_SERVICE_CODES.SIGNOFF_REQUIRED, '人工终审必须提供 signedBy（签字人）');
    if (!['approve', 'reject'].includes(decision)) throw coded(GATE_SERVICE_CODES.INVALID, 'decision 只能是 approve 或 reject');
    const evaluated = evaluate({ pcbUuid });
    if (decision === 'approve' && evaluated.report.verdict !== 'pass') {
      const unimplemented = (evaluated.report.notImplementedGates || []).join(',') || '-';
      throw coded(GATE_SERVICE_CODES.SIGNOFF_BLOCKED, `门禁结论为 ${evaluated.report.verdict}（blocked=${evaluated.report.blockedGates.join(',') || '-'}，unknown=${evaluated.report.unknownGates.join(',') || '-'}，未实现=${unimplemented}）：不能签字放行`, { pcbUuid, report: evaluated.report });
    }
    const record = {
      schemaVersion: 1, kind: 'signoff-record',
      pcbUuid: String(pcbUuid).trim(), decision,
      signedBy: String(signedBy).trim(), note: String(note || '').slice(0, 300),
      gateVerdict: evaluated.report.verdict, reportDigest: evaluated.digest,
      signedAt: now().toISOString(),
    };
    // 门禁终审签字与交付签核分开存：两条流程的语义/绑定字段不同，共用 kind 会互相遮蔽。
    const saved = evidenceStore.save({ kind: 'gate-signoff', payload: record, fingerprint: { pcbUuid: record.pcbUuid }, note: `W5-04 人工终审：${decision} by ${record.signedBy}` });
    let ledgerEntry = null;
    if (approvalLedger && typeof approvalLedger.record === 'function') {
      ledgerEntry = approvalLedger.record({
        scope: 'release',
        action: decision === 'approve' ? 'signed' : 'rejected',
        approvalId: `signoff-${record.pcbUuid}`,
        bindings: { pcbUuid: record.pcbUuid, gateVerdict: record.gateVerdict, reportDigest: record.reportDigest },
        note: record.note,
      });
    }
    return { record, evidencePath: saved.path, digest: saved.digest, ledgerEntry, report: evaluated.report };
  };

  return { status, evaluate, signoff };
}
