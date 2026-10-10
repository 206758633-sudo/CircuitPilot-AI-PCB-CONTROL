import crypto from 'node:crypto';
import { cpwgImpedance, finding } from './stackup.mjs';

export function analyzeRf(input = {}) {
  const findings = []; const frequencyGHz = Number(input.frequencyGHz);
  if (!(frequencyGHz > 0 && frequencyGHz <= 2.4)) findings.push(finding('RF_FREQUENCY_UNSUPPORTED', '当前RF阶段仅验收到2.4GHz', 'frequencyGHz'));
  let line = null; try { line = cpwgImpedance(input.geometry || {}); } catch { findings.push(finding('RF_GEOMETRY_REQUIRED', '缺少CPWG线宽、间隙、介质厚度或Er', 'geometry')); }
  const target = Number(input.targetOhm || 50);
  if (line && Math.abs(line.impedanceOhm - target) > Number(input.toleranceOhm || 5)) findings.push(finding('RF_IMPEDANCE_OUT_OF_RANGE', `解析估算${line.impedanceOhm.toFixed(1)}Ω偏离目标${target}Ω`, 'geometry'));
  if (!input.antennaKeepout?.verified) findings.push(finding('ANTENNA_KEEPOUT_UNVERIFIED', '天线禁布区未绑定机械或天线资料', 'antennaKeepout'));
  const wavelengthMm = frequencyGHz > 0 ? 299.792458 / frequencyGHz / Math.sqrt(line?.effectiveEr || 1) : null;
  const maxFencePitchMm = wavelengthMm ? wavelengthMm / 20 : null;
  const fenceLengthMm = Number(input.viaFence?.lengthMm || 0); const pitchMm = Number(input.viaFence?.pitchMm || 0);
  const viaCount = fenceLengthMm > 0 && pitchMm > 0 ? Math.floor(fenceLengthMm / pitchMm) + 1 : 0;
  if (!pitchMm || (maxFencePitchMm && pitchMm > maxFencePitchMm)) findings.push(finding('RF_VIA_FENCE_PITCH', '接地过孔围栏间距超过导波波长/20或未提供', 'viaFence'));
  if (!input.simulationEvidence?.hash) findings.push(finding('RF_SIMULATION_REQUIRED', '缺少外部电磁仿真结果哈希', 'simulationEvidence'));
  return { passed: findings.length === 0, findings, metrics: { line, wavelengthMm, maxFencePitchMm, viaCount }, provenance: { analyticalModel: line?.model, externalSimulationRequired: true } };
}

export function createSimulationHandoff(input = {}) {
  const job = { schemaVersion: 1, kind: 'rf-simulation-handoff', solver: String(input.solver || 'openEMS'), geometryHash: String(input.geometryHash || ''), stackupHash: String(input.stackupHash || ''), frequencySweepGHz: input.frequencySweepGHz || [0.1,2.4], ports: input.ports || [], requestedOutputs: ['S11','S21','field-map'] };
  return { job, jobHash: crypto.createHash('sha256').update(JSON.stringify(job)).digest('hex'), executable: false, reason: '交接清单不执行任意模型命令；外部求解结果必须重新导入并校验哈希' };
}
