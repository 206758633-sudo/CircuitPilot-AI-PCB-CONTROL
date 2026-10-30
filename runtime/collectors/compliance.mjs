/**
 * 来源合规标注（W3-09）：采集即标注许可/版权/可信等级，并强制“参考工程不得作为设计输入”。
 * 所有采集条目入库前都必须带 provenance；这里给一个统一构造函数 + 校验。
 */
export const COMPLIANCE_CODES = Object.freeze({ INVALID: 'COMPLIANCE_INVALID', REFERENCE_AS_INPUT: 'COMPLIANCE_REFERENCE_AS_INPUT' });
const invalid = (message, details = null) => Object.assign(new Error(message), { code: COMPLIANCE_CODES.INVALID, details });

export function annotateProvenance({ source, url = null, license = null, copyright = null, referenceProject = false, trust = 'unverified', fetchedAt = null } = {}) {
  if (!source || !String(source).trim()) throw invalid('来源 source 必填');
  if (!['authoritative', 'reference', 'unverified'].includes(trust)) throw invalid(`未知可信等级：${trust}`);
  return {
    source: String(source).trim(),
    url: url ? String(url) : null,
    license: license ? String(license) : null,
    copyright: copyright ? String(copyright) : null,
    referenceProject: referenceProject === true,
    allowedAsDesignInput: referenceProject !== true,
    trust,
    fetchedAt: fetchedAt ?? new Date().toISOString(),
  };
}

/** 校验入库条目的 provenance；参考工程作为设计输入直接拒绝。 */
export function assertCompliance(provenance) {
  if (!provenance || typeof provenance !== 'object' || !provenance.source) throw invalid('条目缺少 provenance.source');
  if (provenance.referenceProject === true && provenance.allowedAsDesignInput === true) throw Object.assign(new Error('参考工程只能当验收基准，不能作为设计输入'), { code: COMPLIANCE_CODES.REFERENCE_AS_INPUT });
  return true;
}
