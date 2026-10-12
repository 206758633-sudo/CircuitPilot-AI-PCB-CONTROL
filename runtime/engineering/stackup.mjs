const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;
export const finding = (code, message, path, severity = 'blocking') => ({ code, message, path, severity });

export function validateStackup(input = {}) {
  const stackup = { id: String(input.id || ''), source: String(input.source || ''), layers: Array.isArray(input.layers) ? input.layers : [], capabilities: input.capabilities || {} };
  const findings = [];
  if (!stackup.id || !stackup.source) findings.push(finding('STACKUP_EVIDENCE_REQUIRED', '叠层必须包含版本标识和板厂来源', 'stackup'));
  if (![4,6,8].includes(stackup.layers.filter((l) => l.type === 'copper').length)) findings.push(finding('STACKUP_LAYER_COUNT_UNSUPPORTED', '高级引擎支持4/6/8个铜层', 'stackup.layers'));
  for (const [i, layer] of stackup.layers.entries()) {
    if (!['copper','dielectric'].includes(layer.type)) findings.push(finding('STACKUP_LAYER_TYPE_INVALID', `第${i + 1}层类型无效`, `layers.${i}`));
    if (layer.type === 'copper' && !positive(Number(layer.thicknessUm))) findings.push(finding('COPPER_THICKNESS_REQUIRED', `铜层${layer.name || i}缺少厚度`, `layers.${i}.thicknessUm`));
    if (layer.type === 'dielectric' && (!positive(Number(layer.thicknessMm)) || !positive(Number(layer.er)) || Number(layer.er) <= 1)) findings.push(finding('DIELECTRIC_EVIDENCE_REQUIRED', `介质层${layer.name || i}缺少厚度或介电常数`, `layers.${i}`));
  }
  return { stackup, findings, ready: findings.length === 0 };
}

export function signalLayerContext(stackup, layerName) {
  const index = stackup.layers.findIndex((l) => l.name === layerName && l.type === 'copper');
  if (index < 0) return null;
  const above = stackup.layers.slice(0,index).reverse().find((l) => l.type === 'dielectric');
  const below = stackup.layers.slice(index + 1).find((l) => l.type === 'dielectric');
  return { index, layer: stackup.layers[index], above, below };
}

export function microstripImpedance({ widthMm, copperThicknessMm, heightMm, er }) {
  if (![widthMm,copperThicknessMm,heightMm,er].every(positive) || er <= 1) throw new Error('IMPEDANCE_INPUT_INVALID');
  const u = widthMm / heightMm; const t = copperThicknessMm / heightMm;
  const effectiveWidth = u + (t / Math.PI) * Math.log(1 + 4 * Math.E / Math.max(t * t, 1e-9));
  const ee = (er + 1) / 2 + (er - 1) / 2 / Math.sqrt(1 + 12 / effectiveWidth);
  const z0 = effectiveWidth <= 1 ? (60 / Math.sqrt(ee)) * Math.log(8 / effectiveWidth + effectiveWidth / 4) : (120 * Math.PI) / (Math.sqrt(ee) * (effectiveWidth + 1.393 + 0.667 * Math.log(effectiveWidth + 1.444)));
  return { impedanceOhm: z0, effectiveEr: ee, method: 'analytical-estimate', model: 'Hammerstad-like microstrip' };
}

export function striplineImpedance({ widthMm, copperThicknessMm, planeSpacingMm, er }) {
  if (![widthMm,copperThicknessMm,planeSpacingMm,er].every(positive) || er <= 1) throw new Error('IMPEDANCE_INPUT_INVALID');
  const effectiveWidth = widthMm + copperThicknessMm;
  return { impedanceOhm: (60 / Math.sqrt(er)) * Math.log((4 * planeSpacingMm) / (0.67 * Math.PI * effectiveWidth)), effectiveEr: er, method: 'analytical-estimate', model: 'symmetric-stripline' };
}

export function cpwgImpedance({ widthMm, gapMm, heightMm, er }) {
  if (![widthMm,gapMm,heightMm,er].every(positive) || er <= 1) throw new Error('IMPEDANCE_INPUT_INVALID');
  const k = widthMm / (widthMm + 2 * gapMm); const kp = Math.sqrt(1 - k * k);
  const ratio = Math.log(2 * (1 + Math.sqrt(kp)) / Math.max(1 - Math.sqrt(kp), 1e-9)) / Math.log(2 * (1 + Math.sqrt(k)) / Math.max(1 - Math.sqrt(k), 1e-9));
  return { impedanceOhm: (30 * Math.PI / Math.sqrt((er + 1) / 2)) * ratio, effectiveEr: (er + 1) / 2, method: 'analytical-estimate', model: 'finite-gap CPWG approximation', heightMm };
}

export function propagationDelayPsPerMm(effectiveEr) { if (!positive(effectiveEr)) throw new Error('ER_INVALID'); return Math.sqrt(effectiveEr) / 0.299792458; }

/**
 * 单端阻抗 -> 差分阻抗（含线间距耦合修正）。
 *
 * 这里是该公式的**唯一**实现：正向分析（highspeed.mjs）与反向求解（impedance.mjs）
 * 都必须调用它。否则会出现最难查的一类问题——用 A 公式反解出的线宽，
 * 被 B 公式判定为超差，两边都“有测试”、都自洽，但合起来是错的。
 */
export function differentialFromSingleEnded({ singleEndedOhm, pairGapMm, heightMm }) {
  if (!positive(singleEndedOhm) || !positive(heightMm)) throw new Error('IMPEDANCE_INPUT_INVALID');
  // 与改造前的 highspeed.mjs 逐字一致：`Number(input.pairGapMm || 0)`，
  // 即 undefined/NaN/空串都按 0 处理（不引入新的拒绝路径）。
  const gapMm = Number(pairGapMm || 0);
  const coupling = Math.exp(-0.96 * gapMm / heightMm);
  return { differentialOhm: 2 * singleEndedOhm * (1 - 0.48 * coupling), coupling, gapMm };
}
