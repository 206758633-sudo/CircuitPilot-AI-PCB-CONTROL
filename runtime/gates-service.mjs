import { PCB_GATES, evaluatePcbGates } from './gate-engine.mjs';

/**
 * 门禁服务（W5-03/W5-04）：从证据库取最新证据 → Gate Engine 裁决 → 归档门禁报告 → 人工终审签字。
 *
 * 不可绕过的规矩：
 *   - 签字只能签 `pass`；blocked/unknown 一律拒绝（要签就先修设计/补证据）；
 *   - 每次评估/签字都落 `signoff` 证据；签字同时写 approval-ledger 哈希链（可核对历史）；
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
    const envelopes = [];
    const refs = [];
    for (const kind of evidenceKinds()) {
      const entry = evidenceStore.latest(kind, { fingerprint: { pcbUuid: String(pcbUuid).trim() } });
      if (!entry) continue;
      envelopes.push(entry.payload);
      refs.push({ kind, digest: entry.digest, path: entry.path, savedAt: entry.savedAt });
    }
    return { envelopes, refs };
  };

  const status = ({ pcbUuid } = {}) => {
    const { envelopes, refs } = collect({ pcbUuid });
    return { report: evaluatePcbGates({ envelopes, targetPcbUuid: String(pcbUuid).trim() }), evidenceRefs: refs };
  };

  const evaluate = ({ pcbUuid } = {}) => {
    const { report, evidenceRefs } = status({ pcbUuid });
    const saved = evidenceStore.save({
      kind: 'signoff',
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
      throw coded(GATE_SERVICE_CODES.SIGNOFF_BLOCKED, `门禁结论为 ${evaluated.report.verdict}（blocked=${evaluated.report.blockedGates.join(',') || '-'}，unknown=${evaluated.report.unknownGates.join(',') || '-'}）：不能签字放行`, { pcbUuid, report: evaluated.report });
    }
    const record = {
      schemaVersion: 1, kind: 'signoff-record',
      pcbUuid: String(pcbUuid).trim(), decision,
      signedBy: String(signedBy).trim(), note: String(note || '').slice(0, 300),
      gateVerdict: evaluated.report.verdict, reportDigest: evaluated.digest,
      signedAt: now().toISOString(),
    };
    const saved = evidenceStore.save({ kind: 'signoff', payload: record, fingerprint: { pcbUuid: record.pcbUuid }, note: `W5-04 人工终审：${decision} by ${record.signedBy}` });
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
