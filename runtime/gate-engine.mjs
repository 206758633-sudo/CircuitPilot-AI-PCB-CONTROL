import { assertEvidenceEnvelope } from './evidence-contract.mjs';

/**
 * Gate Engine（W5-01）：把“能不能放行”拆成 6 道可独立追问的门。
 *
 * 每道门只认**统一证据契约**下的证据，产出三样东西：输入（需要哪些证据）、输出（pass/blocked/unknown+原因）、
 * 阻断原因（人话）。缺证据 = unknown，绝不默认通过；任一 blocked = 全局 blocked。
 */
export const PCB_GATES = Object.freeze([
  Object.freeze({ id: 'G1', name: '规格门', purpose: 'design-spec 完整、每条需求都映射到验收证据', requiredKinds: Object.freeze(['design-spec']) }),
  Object.freeze({ id: 'G2', name: '器件/库门', purpose: '器件身份/封装/引脚/3D 经多源核验（Librarian）', requiredKinds: Object.freeze(['lib-evidence']) }),
  Object.freeze({ id: 'G3', name: '网表门', purpose: '意图网表 ↔ 实际网表逐 pin 一致（Auditor）', requiredKinds: Object.freeze(['netlist-diff']) }),
  Object.freeze({ id: 'G4', name: '规则门', purpose: 'ERC/DRC 无未处理错误，豁免有理由并绑定当前板', requiredKinds: Object.freeze(['rules']) }),
  Object.freeze({ id: 'G5', name: '布局门', purpose: '器件在板框内、无越界/重叠，且人工确认', requiredKinds: Object.freeze(['placement']) }),
  Object.freeze({ id: 'G6', name: '制造门', purpose: 'Gerber/BOM/CPL/DRC 产物一致并完成制造放行', requiredKinds: Object.freeze(['fabrication-release']) }),
]);

export const GATE_CODES = Object.freeze({
  EVIDENCE_MISSING: 'GATE_EVIDENCE_MISSING',
  EVIDENCE_INVALID: 'GATE_EVIDENCE_INVALID',
  EVIDENCE_UNBOUND: 'GATE_EVIDENCE_UNBOUND',
  BLOCKED: 'GATE_BLOCKED',
  UNKNOWN: 'GATE_UNKNOWN',
  PASSED: 'GATE_PASSED',
});

const short = (value, length = 240) => String(value ?? '').slice(0, length);

function evaluateOneGate(gate, envelopes, targetPcbUuid) {
  const byKind = new Map();
  for (const envelope of envelopes) {
    if (!gate.requiredKinds.includes(envelope?.kind)) continue;
    if (!byKind.has(envelope.kind)) byKind.set(envelope.kind, []);
    byKind.get(envelope.kind).push(envelope);
  }
  const reasons = [];
  const missing = [];
  const digests = [];
  for (const kind of gate.requiredKinds) {
    const list = byKind.get(kind) ?? [];
    if (!list.length) { missing.push(kind); reasons.push({ code: GATE_CODES.EVIDENCE_MISSING, severity: 'unknown', message: `缺少 ${kind} 证据：不能把“没证据”当成“没问题”` }); continue; }
    for (const envelope of list) {
      try { assertEvidenceEnvelope(envelope); } catch (error) { reasons.push({ code: GATE_CODES.EVIDENCE_INVALID, severity: 'unknown', message: `${kind} 证据不符合统一契约：${short(error?.message)}` }); continue; }
      digests.push(envelope.digest ?? null);
      const evidencePcb = String(envelope.fingerprint?.pcbUuid ?? '').trim() || null;
      const target = targetPcbUuid ? String(targetPcbUuid).trim() : null;
      if (target && evidencePcb && evidencePcb !== target) { reasons.push({ code: GATE_CODES.EVIDENCE_UNBOUND, severity: 'blocking', message: `${kind} 证据属于 PCB ${evidencePcb}，当前目标是 ${target}` }); continue; }
      if (target && !evidencePcb) reasons.push({ code: GATE_CODES.EVIDENCE_UNBOUND, severity: 'unknown', message: `${kind} 证据没有 pcbUuid，无法确认属于当前 PCB ${target}` });
      if (envelope.verdict === 'blocked') reasons.push({ code: GATE_CODES.BLOCKED, severity: 'blocking', message: `${kind} 证据为 blocked：${short(envelope.blockedReason || envelope.findings.filter((item) => item.severity === 'error').map((item) => item.message).slice(0, 3).join('；'))}` });
      else if (envelope.verdict === 'unknown') reasons.push({ code: GATE_CODES.UNKNOWN, severity: 'unknown', message: `${kind} 证据为 unknown：${short(envelope.blockedReason || '原因未提供')}` });
      else reasons.push({ code: GATE_CODES.PASSED, severity: 'info', message: `${kind} 证据通过（digest ${String(envelope.digest ?? '').slice(0, 12)}…）` });
    }
  }
  const blocking = reasons.filter((reason) => reason.severity === 'blocking');
  const unknownReasons = reasons.filter((reason) => reason.severity === 'unknown');
  const verdict = blocking.length ? 'blocked' : unknownReasons.length ? 'unknown' : 'pass';
  return {
    id: gate.id, name: gate.name, purpose: gate.purpose, requiredKinds: [...gate.requiredKinds],
    verdict, evidenceDigests: digests.filter(Boolean), missing, reasons,
  };
}

/** 逐门裁决 + 全局裁决。`targetPcbUuid` 用于拒绝“另一块板的干净证据”。 */
export function evaluatePcbGates({ envelopes = [], gates = PCB_GATES, targetPcbUuid = null } = {}) {
  if (!Array.isArray(envelopes)) throw Object.assign(new Error('envelopes 必须是数组'), { code: 'GATE_INPUT_INVALID' });
  const results = gates.map((gate) => evaluateOneGate(gate, envelopes, targetPcbUuid));
  const blocked = results.filter((result) => result.verdict === 'blocked');
  const unknown = results.filter((result) => result.verdict === 'unknown');
  return {
    verdict: blocked.length ? 'blocked' : unknown.length ? 'unknown' : 'pass',
    targetPcbUuid: targetPcbUuid ?? null,
    gates: results,
    blockedGates: blocked.map((result) => result.id),
    unknownGates: unknown.map((result) => result.id),
  };
}

/** 供 UI/日志使用的一句话解释。 */
export function explainPcbGates(result) {
  return (result?.gates ?? []).map((gate) => `${gate.id} ${gate.name}：${gate.verdict}${gate.missing.length ? `（缺 ${gate.missing.join('/')}）` : ''}`);
}
