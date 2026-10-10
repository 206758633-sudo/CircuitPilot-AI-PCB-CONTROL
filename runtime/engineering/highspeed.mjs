import { finding, microstripImpedance, propagationDelayPsPerMm } from './stackup.mjs';

export const HIGH_SPEED_PROFILES = Object.freeze({
  usb2: { id: 'usb2', differentialOhm: 90, toleranceOhm: 10, maxSkewMm: 0.5, minSpacingWidths: 3, continuousReference: true },
  can: { id: 'can', differentialOhm: 120, toleranceOhm: 12, maxSkewMm: 5, minSpacingWidths: 3, continuousReference: true },
  rs485: { id: 'rs485', differentialOhm: 120, toleranceOhm: 12, maxSkewMm: 5, minSpacingWidths: 3, continuousReference: true },
  spi: { id: 'spi', maxClockMHz: 100, maxSkewMm: 5, minSpacingWidths: 3, continuousReference: true },
  clock200: { id: 'clock200', maxClockMHz: 200, maxSkewMm: 2, minSpacingWidths: 3, continuousReference: true },
});

export function analyzeHighSpeed(input = {}) {
  const profile = HIGH_SPEED_PROFILES[input.profileId]; const findings = [];
  if (!profile) return { passed: false, findings: [finding('HS_PROFILE_UNKNOWN', '不支持的高速接口配置', 'profileId')], metrics: {} };
  const segments = Array.isArray(input.segments) ? input.segments : [];
  const lengths = segments.map((s) => Number(s.lengthMm));
  if (!segments.length || lengths.some((v) => !Number.isFinite(v) || v <= 0)) findings.push(finding('HS_ROUTE_REQUIRED', '高速网络缺少有效路径长度', 'segments'));
  if (segments.some((s) => s.referenceContinuous !== true)) findings.push(finding('RETURN_PATH_DISCONTINUITY', '高速路径跨越参考平面分割或参考层未知', 'segments'));
  if (segments.some((s) => Number(s.neighborSpacingMm) < Number(s.widthMm) * profile.minSpacingWidths)) findings.push(finding('CROSSTALK_CLEARANCE', '相邻高速线未满足线宽倍数间距', 'segments'));
  const skewMm = lengths.length ? Math.max(...lengths) - Math.min(...lengths) : 0;
  if (skewMm > profile.maxSkewMm) findings.push(finding('LENGTH_SKEW', `长度偏差${skewMm.toFixed(3)}mm超过${profile.maxSkewMm}mm`, 'segments'));
  let impedance = null;
  if (input.geometry) {
    try { impedance = microstripImpedance(input.geometry); } catch { findings.push(finding('IMPEDANCE_INPUT_INVALID', '阻抗几何或材料参数无效', 'geometry')); }
  } else findings.push(finding('IMPEDANCE_GEOMETRY_REQUIRED', '缺少线宽、铜厚、介质厚度和介电常数', 'geometry'));
  if (impedance && profile.differentialOhm) {
    const coupling = Math.exp(-0.96 * Number(input.pairGapMm || 0) / Number(input.geometry.heightMm));
    const differentialOhm = 2 * impedance.impedanceOhm * (1 - 0.48 * coupling);
    impedance = { ...impedance, differentialOhm };
    if (Math.abs(differentialOhm - profile.differentialOhm) > profile.toleranceOhm) findings.push(finding('DIFFERENTIAL_IMPEDANCE', `估算差分阻抗${differentialOhm.toFixed(1)}Ω超出目标`, 'geometry'));
  }
  const delayPsPerMm = impedance ? propagationDelayPsPerMm(impedance.effectiveEr) : null;
  return { passed: findings.length === 0, findings, metrics: { skewMm, delayPsPerMm, impedance }, provenance: { method: 'analytical-estimate', requiresFabricatorStackup: true, requiresOfficialDrc: true } };
}
