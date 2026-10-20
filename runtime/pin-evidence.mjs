/**
 * A4：引脚证据链产品化。
 *
 * 问题：库元数据没有引脚功能名，AI 网表在缺证据时只能 blocked（对"从零设计"是死路），
 * 而 PCB 侧其实有权威的"焊盘↔网络↔坐标"映射（`pcb.copper.read` 的 pads）。
 *
 * 本模块只做**证据表 + fail-closed 审计**：
 *   - 每个焊盘必须能回答：属于哪个位号、几号脚、什么网络、来源是什么；
 *   - 没有网络的焊盘不等于"没问题"——要么显式给 assumption（如 NC/未用脚），要么阻断；
 *   - 原理图器件与 PCB 位号的覆盖差异如实报出（只原理图/只 PCB），不猜；
 *   - 没有读到任何焊盘时返回阻断证据，不返回"空 = 通过"。
 *
 * 这里不生成网表、不改设计；它给"生成网表/执行计划"一个可审计的前置证据。
 */
export const PIN_EVIDENCE_CODES = Object.freeze({
  EMPTY: 'PIN_EVIDENCE_EMPTY',
  NET_UNKNOWN: 'PIN_NET_UNKNOWN',
  COMPONENT_MISSING: 'PIN_COMPONENT_MISSING',
  DUPLICATE_PAD: 'PIN_DUPLICATE_PAD',
  SCHEMATIC_MISMATCH: 'PIN_SCHEMATIC_MISMATCH',
  BLOCKED: 'PIN_EVIDENCE_BLOCKED',
});

const text = (value) => String(value ?? '').trim();
const keyOf = (designator, pad) => `${designator}#${pad}`;

/**
 * @param {object} input
 * @param {Array<{designator?:string,pad?:string,net?:string,layer?:number,throughHole?:boolean}>} input.pads
 * @param {Array<{designator?:string,componentType?:string}>} [input.schematicParts]
 * @param {Array<{designator:string,pad:string,reason:string}>} [input.assumptions] 显式假设（必须带理由）
 */
export function buildPinEvidence({ pads = [], schematicParts = [], assumptions = [] } = {}) {
  const rows = [];
  const seen = new Set();
  const duplicates = [];
  for (const pad of Array.isArray(pads) ? pads : []) {
    const designator = text(pad?.designator) || text(pad?.ref);
    const padNumber = text(pad?.pad ?? pad?.pinNumber ?? pad?.num);
    const net = text(pad?.net);
    if (!designator || !padNumber) continue;
    const key = keyOf(designator, padNumber);
    if (seen.has(key)) { duplicates.push({ designator, pad: padNumber }); continue; }
    seen.add(key);
    rows.push({
      designator,
      pad: padNumber,
      net,
      layer: Number.isFinite(Number(pad?.layer)) ? Number(pad.layer) : null,
      throughHole: pad?.throughHole === true || Number(pad?.layer) === 12,
      source: 'pcb-pad',
    });
  }
  const assumptionMap = new Map();
  for (const assumption of Array.isArray(assumptions) ? assumptions : []) {
    const designator = text(assumption?.designator);
    const padNumber = text(assumption?.pad);
    const reason = text(assumption?.reason);
    if (designator && padNumber && reason) assumptionMap.set(keyOf(designator, padNumber), reason);
  }
  const components = new Map();
  for (const row of rows) {
    if (!components.has(row.designator)) components.set(row.designator, { designator: row.designator, pins: 0, withNet: 0, assumed: 0 });
    const entry = components.get(row.designator);
    entry.pins += 1;
    if (row.net) entry.withNet += 1;
    else if (assumptionMap.has(keyOf(row.designator, row.pad))) entry.assumed += 1;
  }
  const schematicDesignators = [...new Set((Array.isArray(schematicParts) ? schematicParts : []).map((part) => text(part?.designator)).filter(Boolean))].sort();
  const pcbDesignators = [...components.keys()].sort();
  return {
    schemaVersion: 1,
    kind: 'pin-evidence',
    source: 'pcb-copper-read',
    rows: rows.map((row) => ({ ...row, assumption: row.net ? null : assumptionMap.get(keyOf(row.designator, row.pad)) || null })),
    components: [...components.values()].sort((a, b) => a.designator.localeCompare(b.designator)),
    duplicates,
    assumptions: [...assumptionMap.entries()].map(([key, reason]) => ({ key, reason })),
    schematic: {
      parts: schematicDesignators.length,
      onlySchematic: schematicDesignators.filter((designator) => !pcbDesignators.includes(designator)),
      onlyPcb: pcbDesignators.filter((designator) => !schematicDesignators.includes(designator)),
    },
  };
}

/** fail-closed 审计：没有证据不通过；未知网络必须有显式 assumption。 */
export function auditPinEvidence(evidence) {
  const blockers = [];
  const warnings = [];
  const rows = Array.isArray(evidence?.rows) ? evidence.rows : [];
  if (!rows.length) blockers.push({ code: PIN_EVIDENCE_CODES.EMPTY, message: '没有读到任何焊盘证据（不能把"空"当成"通过"）' });
  const unknownNet = rows.filter((row) => !text(row.net) && !text(row.assumption));
  if (unknownNet.length) {
    blockers.push({
      code: PIN_EVIDENCE_CODES.NET_UNKNOWN,
      message: `${unknownNet.length} 个焊盘没有网络且没有显式 assumption（NC/未用脚必须写理由）：${unknownNet.slice(0, 12).map((row) => `${row.designator}.${row.pad}`).join('、')}`,
      items: unknownNet.slice(0, 12).map((row) => ({ designator: row.designator, pad: row.pad })),
    });
  }
  for (const component of evidence?.components || []) {
    if (!component.pins) blockers.push({ code: PIN_EVIDENCE_CODES.COMPONENT_MISSING, message: `器件 ${component.designator} 没有焊盘证据` });
  }
  if (evidence?.duplicates?.length) blockers.push({ code: PIN_EVIDENCE_CODES.DUPLICATE_PAD, message: `PCB 焊盘位号+脚号重复 ${evidence.duplicates.length} 组`, items: evidence.duplicates.slice(0, 12) });
  if (evidence?.schematic?.onlySchematic?.length) warnings.push({ code: PIN_EVIDENCE_CODES.SCHEMATIC_MISMATCH, message: `仅原理图有、PCB 没有的位号：${evidence.schematic.onlySchematic.slice(0, 12).join('、')}`, items: evidence.schematic.onlySchematic.slice(0, 12) });
  if (evidence?.schematic?.onlyPcb?.length) warnings.push({ code: PIN_EVIDENCE_CODES.SCHEMATIC_MISMATCH, message: `仅 PCB 有、原理图没有的位号：${evidence.schematic.onlyPcb.slice(0, 12).join('、')}`, items: evidence.schematic.onlyPcb.slice(0, 12) });
  const counts = {
    components: evidence?.components?.length || 0,
    pins: rows.length,
    withNet: rows.filter((row) => Boolean(text(row.net))).length,
    assumed: rows.filter((row) => !text(row.net) && Boolean(text(row.assumption))).length,
    unknown: unknownNet.length,
  };
  return { ok: blockers.length === 0, counts, blockers, warnings };
}

/** 网表/执行计划生成前的硬门禁：证据审计不通过就抛结构化错误。 */
export function assertPinEvidenceForNetlist(evidence) {
  const audit = auditPinEvidence(evidence);
  if (!audit.ok) {
    throw Object.assign(new Error(`引脚证据不足，拒绝生成网表：${audit.blockers.map((item) => item.message).join('；')}`), {
      code: PIN_EVIDENCE_CODES.BLOCKED, status: 409, details: { audit },
    });
  }
  return audit;
}
