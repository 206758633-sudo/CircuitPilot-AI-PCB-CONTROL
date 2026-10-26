/**
 * A4：两阶段"先落器件 → 读引脚 → 再生成网表"的计划层（只出计划，不自动执行）。
 *
 * 顺序是硬的：PCB 焊盘证据只能来自已经真实落板的器件（R2 写通道，需一次性写板批准）；
 * 没有落板就没有焊盘，没有焊盘就不能生成可执行网表——绝不允许"跳过落板直接编网表"。
 * 每个阶段都写清楚依赖、所需批准、预期证据；上游缺失时 executable=false + blockers，
 * 不把"计划生成了"当成"可以执行了"。
 */
export const PIN_FLOW_CODES = Object.freeze({
  PCB_NOT_PLACED: 'PIN_FLOW_PCB_NOT_PLACED',
  PIN_EVIDENCE_MISSING: 'PIN_FLOW_PIN_EVIDENCE_MISSING',
  PIN_AUDIT_BLOCKED: 'PIN_FLOW_PIN_AUDIT_BLOCKED',
  ASSUMPTIONS_UNMARKED: 'PIN_FLOW_ASSUMPTIONS_UNMARKED',
});
import crypto from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function planPinFirstNetlistFlow({ pcbExecutionId = null, pinEvidence = null, pinAudit = null, assumptionAudit = null, notes = '' } = {}) {
  const blockers = [];
  const decisionLog = [];
  const placed = Boolean(text(pcbExecutionId));
  if (!placed) {
    blockers.push({ code: PIN_FLOW_CODES.PCB_NOT_PLACED, message: '还没有 PCB 落板的执行记录：先走 R2 落板（需一次性写板批准），焊盘证据才有权威来源' });
    decisionLog.push('未提供 pcbExecutionId：阶段 1 未完成，后续阶段全部不可执行');
  }
  const hasEvidence = Boolean(pinEvidence && Array.isArray(pinEvidence.rows));
  if (!hasEvidence) blockers.push({ code: PIN_FLOW_CODES.PIN_EVIDENCE_MISSING, message: '缺引脚证据：阶段 2 未完成，不能生成网表；先调用 /api/eda/pins/evidence（只读）' });
  const auditOk = pinAudit?.ok === true;
  if (hasEvidence && !auditOk) blockers.push({ code: PIN_FLOW_CODES.PIN_AUDIT_BLOCKED, message: `引脚证据审计未通过：${(pinAudit?.blockers || []).slice(0, 4).map((item) => item.message).join('；') || '未提供审计结果'}` });
  const unmarked = (assumptionAudit?.items || []).filter((item) => item.direction === 'unknown');
  if (unmarked.length) blockers.push({ code: PIN_FLOW_CODES.ASSUMPTIONS_UNMARKED, message: `${unmarked.length} 条网表 assumption 未标注方向，不能进可执行计划（先补 power/ground/signal/no-connect）` });

  const stages = [
    { id: 'pcb-placement', order: 1, type: 'write', title: '先落器件到 PCB（R2）', dependsOn: [], requiresApproval: true, reason: 'PCB 焊盘是引脚证据的权威来源；没落板就没有焊盘', expectedEvidence: ['pcbExecutionId', '落板后读回：器件/位号数量'] },
    { id: 'pin-evidence', order: 2, type: 'read', title: '采集引脚证据（只读）', dependsOn: ['pcb-placement'], command: 'POST /api/eda/pins/evidence', requiresApproval: false, reason: '每个焊盘必须能回答位号/脚号/网络/来源；未知网络需显式 assumption', expectedEvidence: ['evidence.rows 非空', 'audit.counts.withNet/assumed/unknown'] },
    { id: 'pin-audit', order: 3, type: 'gate', title: '引脚证据审计（fail-closed）', dependsOn: ['pin-evidence'], requiresApproval: false, passCondition: 'audit.ok === true', reason: '未知网络无 assumption 直接阻断，不猜电气意图', expectedEvidence: ['audit.ok', 'blockers 为空'] },
    { id: 'netlist-ai', order: 4, type: 'ai', title: '生成网表草案（带证据摘要）', dependsOn: ['pin-audit'], route: 'POST /api/design/netlist/ai', requiresApproval: false, requires: { pinEvidence: true, strictAssumptions: true }, reason: '网表里的每条工程判断要有 assumption 标注（方向+来源）', expectedEvidence: ['netlist.pinEvidence.digest', 'netlist.assumptionAudit'] },
  ];
  const plan = { schemaVersion: 1, kind: 'pin-first-netlist-flow', executable: blockers.length === 0, pcbExecutionId: text(pcbExecutionId) || null, pinEvidenceDigest: hasEvidence ? digest(pinEvidence) : null, stages, blockers, decisionLog, notes: text(notes) || null, autoExecute: false };
  plan.planId = digest(plan);
  return plan;
}
