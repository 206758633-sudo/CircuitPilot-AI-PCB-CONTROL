import { createEvidenceEnvelope } from '../evidence-contract.mjs';

/**
 * Librarian（W4-03）：器件身份三源核验（EDA 库 / 供应商 / 资料），只读、只出候选证据。
 * 判定：
 *   - EDA 库或供应商数据缺失 → blocked（无法核验，不等于通过）；
 *   - LCSC 料号/MPN/封装不一致 → blocked；
 *   - 3D 模型缺失 / datasheet 未核验 → warning（不阻断，但显式记录）；
 *   - 全部一致 → pass；证据绑定 lcscId 与来源摘要，可回溯。
 */
export const LIBRARIAN_CODES = Object.freeze({
  INPUT_MISSING: 'LIBRARIAN_INPUT_MISSING',
  IDENTITY_MISMATCH: 'LIB_PART_IDENTITY_MISMATCH',
  PACKAGE_MISMATCH: 'LIB_PACKAGE_MISMATCH',
  PACKAGE_UNVERIFIED: 'LIB_PACKAGE_UNVERIFIED',
  MODEL3D_MISSING: 'LIB_MODEL3D_MISSING',
  DATASHEET_UNVERIFIED: 'LIB_DATASHEET_UNVERIFIED',
  OK: 'LIB_IDENTITY_VERIFIED',
});

const norm = (value) => String(value ?? '').toLowerCase().replace(/[\s_\-()]/g, '');
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export function auditPartIdentity({ part, eda = null, supply = null, datasheet = null, pcbUuid = null, projectId = null, now = () => new Date() } = {}) {
  const lcscId = text(part?.lcscId) ?? text(eda?.lcscId) ?? null;
  if (!lcscId) throw Object.assign(new Error('Librarian 需要 LCSC 料号（part.lcscId 或 eda.lcscId）'), { code: LIBRARIAN_CODES.INPUT_MISSING });
  const findings = [];
  const add = (code, severity, message) => findings.push({ code, severity, message });
  if (!eda) add('LIB_EDA_SOURCE_MISSING', 'error', '没有 EDA 库数据：无法核对 symbol/footprint/3D，不能放行选型');
  if (!supply) add('LIB_SUPPLY_SOURCE_MISSING', 'error', '没有供应商数据（价格/库存/封装/MPN）：无法确认可采购与身份一致');
  const supplyLcsc = text(supply?.lcscId);
  if (supply && supplyLcsc && norm(supplyLcsc) !== norm(lcscId)) add(LIBRARIAN_CODES.IDENTITY_MISMATCH, 'error', `供应商返回料号 ${supplyLcsc} ≠ 请求料号 ${lcscId}`);
  const edaLcsc = text(eda?.lcscId);
  if (eda && edaLcsc && norm(edaLcsc) !== norm(lcscId)) add(LIBRARIAN_CODES.IDENTITY_MISMATCH, 'error', `EDA 库料号 ${edaLcsc} ≠ 请求料号 ${lcscId}`);
  const edaPackage = text(eda?.footprint);
  const supplyPackage = text(supply?.package);
  // EDA 库里的 footprintName 与供应商的 package 不是同一命名体系（前者常带完整库名）。
  // 只按封装族（SMD/SOT/QFN/CONN…）比较：族明确冲突才阻断；无法判定则标"未核验"警告，不假装通过也不误杀。
  const familyOf = (value) => {
    const found = norm(value).match(/(smd|sot|qfn|dfn|bga|dip|sop|soic|tssop|msop|lqfp|tqfp|qfp|conn|con|led|to)\d*/g);
    return found ? [...new Set(found.map((token) => token.replace(/\d+$/, '')))] : [];
  };
  if (edaPackage && supplyPackage) {
    const edaFamilies = familyOf(edaPackage);
    const supplyFamilies = familyOf(supplyPackage);
    const overlap = edaFamilies.filter((token) => supplyFamilies.includes(token));
    if (edaFamilies.length && supplyFamilies.length && !overlap.length) {
      add(LIBRARIAN_CODES.PACKAGE_MISMATCH, 'error', `封装族冲突：EDA=${edaPackage} / 供应商=${supplyPackage}`);
    } else if (!overlap.length) {
      add(LIBRARIAN_CODES.PACKAGE_UNVERIFIED, 'warning', `封装命名体系不同（EDA=${edaPackage} / 供应商=${supplyPackage}），无法按名字判定；需 datasheet/人工确认`);
    }
  } else if (edaPackage || supplyPackage) {
    add(LIBRARIAN_CODES.PACKAGE_UNVERIFIED, 'warning', `封装信息单边缺失：EDA=${edaPackage ?? '无'} / 供应商=${supplyPackage ?? '无'}`);
  }
  if (eda && !text(eda?.model3D)) add(LIBRARIAN_CODES.MODEL3D_MISSING, 'warning', 'EDA 库没有 3D 模型：机械/装配检查会缺依据');
  if (!datasheet) add(LIBRARIAN_CODES.DATASHEET_UNVERIFIED, 'warning', 'datasheet 未核验：引脚定义/电气参数仍可能不一致（需资料采集或人工确认）');
  else if (datasheet?.ok === false) add(LIBRARIAN_CODES.DATASHEET_UNVERIFIED, 'warning', `datasheet 抓取失败：${String(datasheet?.code ?? 'UNKNOWN')}`);
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (!errors.length) add(LIBRARIAN_CODES.OK, 'info', '器件身份三源核验通过');
  const verdict = errors.length ? 'blocked' : 'pass';
  // 可选 pcbUuid/projectId：门禁按 fingerprint.pcbUuid 取证据（G2），缺了门禁永远查不到；
  // 但这两个参数是可选的——旧的库内审计调用不传时必须保持原有行为（向后兼容）。
  const boundPcbUuid = text(pcbUuid);
  const boundProjectId = text(projectId);
  return createEvidenceEnvelope({
    kind: 'lib-evidence',
    subject: { type: 'part', id: lcscId, ...(boundPcbUuid ? { pcbUuid: boundPcbUuid } : {}) },
    fingerprint: { lcscId, pcbUuid: boundPcbUuid, projectId: boundProjectId, edaDeviceUuid: eda?.deviceUuid ?? null, supplyCheckedAt: supply?.checkedAt ?? null },
    source: { agent: 'librarian', version: '1.0.0', readOnly: true },
    verdict,
    findings,
    counts: { errors: errors.length, warnings: findings.filter((finding) => finding.severity === 'warning').length },
    details: { part: part ?? null, eda: eda ?? null, supply: supply ?? null, datasheet: datasheet ?? null },
    blockedReason: errors.length ? `${errors.length} 条身份/来源问题` : null,
    now,
  });
}
