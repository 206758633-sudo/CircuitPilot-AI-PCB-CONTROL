/**
 * B1/B4：把「正式导出」与「人工签核的物料清单」绑在一起。
 *
 * 背景缺陷：`/api/production/export` 之前只把 pcbUuid/planHash 传给统一裁决，
 * 从不比对 manifestHash —— 签核文件即便绑定的是**上一版物料**，导出路径也可能放行。
 *
 * 规则（fail-closed）：
 *   1. 正式（final）导出时，只要存在人工签核证据，就必须提供本次产物的 manifestHash；
 *      没提供 ⇒ RELEASE_MANIFEST_BINDING_REQUIRED（让调用方先去跑 readiness / 读出当前 manifestHash）。
 *   2. 提供的 manifestHash 必须等于**当前产物内容重算**的哈希；不等 ⇒ RELEASE_MANIFEST_MISMATCH
 *      （物料变了，旧签核不能复用）。
 *   3. 草稿（draft）不要求绑定：草稿本来就不用于放行。
 *   4. 只有以上都过，才把 manifestHash 放进统一裁决的 binding，让签核/DFM 的指纹校验真正生效。
 */
export const RELEASE_BINDING_CODES = Object.freeze({
  REQUIRED: 'RELEASE_MANIFEST_BINDING_REQUIRED',
  MISMATCH: 'RELEASE_MANIFEST_MISMATCH',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {object} input
 * @param {'draft'|'final'} input.requested
 * @param {string|null} input.providedManifestHash 调用方给的「当前产物」manifestHash
 * @param {string|null} input.recomputedManifestHash 服务端按当前产物内容重算的哈希
 * @param {string|null} input.signoffManifestHash 人工签核证据里绑定的哈希（无签核则为 null）
 * @returns {{ok:boolean, code:string|null, message:string|null, manifestHash:string|null, checks:object}}
 */
export function verifyExportManifestBinding({ requested, providedManifestHash = null, recomputedManifestHash = null, signoffManifestHash = null } = {}) {
  const provided = text(providedManifestHash) || null;
  const recomputed = text(recomputedManifestHash) || null;
  const signed = text(signoffManifestHash) || null;
  const checks = {
    requested: requested === 'final' ? 'final' : 'draft',
    hasSignoff: Boolean(signed),
    provided: Boolean(provided),
    recomputed: Boolean(recomputed),
    signoffMatchesProvided: Boolean(signed && provided && signed === provided),
  };
  if (requested !== 'final') {
    return { ok: true, code: null, message: null, manifestHash: provided ?? recomputed, checks };
  }
  if (signed && !provided) {
    return {
      ok: false,
      code: RELEASE_BINDING_CODES.REQUIRED,
      message: '正式导出存在人工签核，但请求没有提供 manifestHash：先运行生产就绪并读出当前物料的 manifestHash，再导出；否则无法证明签核属于这批物料。',
      manifestHash: recomputed,
      checks: { ...checks, signoffMatchesRecomputed: Boolean(signed && recomputed && signed === recomputed) },
    };
  }
  if (provided && recomputed && provided !== recomputed) {
    return {
      ok: false,
      code: RELEASE_BINDING_CODES.MISMATCH,
      message: `请求绑定的 manifestHash=${provided.slice(0, 12)} 与当前产物重算=${recomputed.slice(0, 12)} 不一致：物料/文件已变化，旧签核不能复用，需重新签核。`,
      manifestHash: recomputed,
      checks: { ...checks, signoffMatchesRecomputed: Boolean(signed && recomputed && signed === recomputed) },
    };
  }
  // 有签核但签核哈希与当前产物不一致 ⇒ 这里不直接拒绝，交给统一裁决的 binding 校验给出明确原因；
  // 但把重算哈希作为唯一可信值返回，避免调用方用旧值冒充。
  return { ok: true, code: null, message: null, manifestHash: recomputed ?? provided ?? null, checks: { ...checks, signoffMatchesRecomputed: Boolean(signed && (recomputed ?? provided) && signed === (recomputed ?? provided)) } };
}
