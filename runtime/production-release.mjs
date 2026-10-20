import crypto from 'node:crypto';

/**
 * 生产文件产出策略：**门禁没通过，就只能出草稿**。
 *
 * 为什么要有这个模块：本目录那批 Gerber/BOM/CPL/STEP 的文件名里就写着 `DRAFT-NOT-FOR-ORDER`，
 * 而文件名是**人手工取的**——也就是说"出的是不是正式文件"此前完全靠自觉。
 * 板厂不会读你的意图，它只按文件内容生产；所以"能不能出正式文件"必须由门禁裁决、
 * 由命名规则强制，而不是靠导出的人记性好。
 *
 * 单一事实来源：界面与脚本都不许自己推导这条规则，一律读这里（及其在门禁报告里的 `outputDecision`）。
 */

export const PRODUCTION_OUTPUT_CODES = {
  REQUEST_INVALID: 'PRODUCTION_OUTPUT_REQUEST_INVALID',
  BLOCKED: 'PRODUCTION_OUTPUT_BLOCKED',
  FINGERPRINT_REQUIRED: 'PRODUCTION_OUTPUT_FINGERPRINT_MISSING',
  STALE_DRAFT_MARKER: 'PRODUCTION_OUTPUT_DRAFT_MARKER_PRESENT',
};

export const DRAFT_MARKER = '-DRAFT-NOT-FOR-ORDER';
export const OUTPUT_CLASSES = ['draft', 'final'];

export const DRAFT_WARNING = '草稿文件不得用于下单：板厂只按文件内容生产，而草稿意味着这批设计还没通过验收。';

const NAME_BASE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const NAME_EXT = /^[A-Za-z0-9]{1,8}$/;

/**
 * 产物命名。草稿必须带草稿标记、正式**必须不带**——这条规则可测，就不该留给人工。
 * 重复调用不会叠加标记（幂等）。
 */
export function artifactName({ base, ext, outputClass = 'draft' } = {}) {
  if (typeof base !== 'string' || !NAME_BASE.test(base)) throw Object.assign(new Error('产物名 base 必须是 1..80 位的字母数字/下划线/点/中划线'), { code: PRODUCTION_OUTPUT_CODES.REQUEST_INVALID });
  if (typeof ext !== 'string' || !NAME_EXT.test(ext)) throw Object.assign(new Error('产物扩展名必须是 1..8 位字母数字'), { code: PRODUCTION_OUTPUT_CODES.REQUEST_INVALID });
  if (!OUTPUT_CLASSES.includes(outputClass)) throw Object.assign(new Error(`产物类别必须是 ${OUTPUT_CLASSES.join('/')}`), { code: PRODUCTION_OUTPUT_CODES.REQUEST_INVALID });
  const stripped = base.split(DRAFT_MARKER).join('');
  return { name: outputClass === 'draft' ? `${stripped}${DRAFT_MARKER}.${ext}` : `${stripped}.${ext}`, outputClass, draftMarker: outputClass === 'draft' ? DRAFT_MARKER : null };
}

const hasDraftMarker = (value) => typeof value === 'string' && /draft|not[-_ ]?for[-_ ]?order|草稿|请勿下单|preliminary/i.test(value);

/**
 * 裁决"现在允许产出什么"。
 *
 * @param {object} options
 * @param {{ready?: boolean, verdict?: string, blockers?: Array<{code: string, message?: string}>, fingerprint?: {sha256?: string}}} options.gate 门禁报告
 * @param {'draft'|'final'} [options.requested] 调用方想要的产物类别，默认 `final`（默认最严）
 * @param {Array<{path?: string, name?: string, kind?: string}>} [options.artifacts] 已存在的产物（用于识别"还是草稿文件名"）
 * @param {string[]} [options.draftPathsReplaced] 本次正式导出**将要覆盖**的自产草稿路径。
 *   没有这条时存在"鸡生蛋"死结（真机复现）：门禁要求产物不是草稿名，而草稿只能由正式导出替换，
 *   正式导出又被这道守卫拒绝 ⇒ `requested:'final'` 永远不可能成功。只豁免显式列出的路径，且如实记进结果。
 */
export function decideProductionOutput({ gate = null, requested = 'final', artifacts = [], draftPathsReplaced = [] } = {}) {
  if (!OUTPUT_CLASSES.includes(requested)) throw Object.assign(new Error(`产物类别必须是 ${OUTPUT_CLASSES.join('/')}`), { code: PRODUCTION_OUTPUT_CODES.REQUEST_INVALID });
  const fingerprint = typeof gate?.fingerprint?.sha256 === 'string' && gate.fingerprint.sha256.length >= 16 ? gate.fingerprint.sha256 : null;
  const ready = gate?.ready === true;
  const blockerCodes = [...new Set((gate?.blockers || []).map((item) => item.code).filter(Boolean))];
  const base = {
    kind: 'production-output-decision',
    requested,
    humanSignoffRequired: true,
    gate: { verdict: gate?.verdict ?? null, ready, fingerprint, blockerCodes },
    draftNaming: `{名称}${DRAFT_MARKER}.{扩展名}`,
  };
  const ticket = (cls) => (fingerprint ? crypto.createHash('sha256').update(`${fingerprint}|${cls}`).digest('hex').slice(0, 32) : null);

  if (requested === 'draft') {
    return { ...base, allowed: true, outputClass: 'draft', naming: { suffix: DRAFT_MARKER }, warning: DRAFT_WARNING, ticket: ticket('draft'), blockers: [] };
  }

  if (!fingerprint) {
    return {
      ...base, allowed: false, outputClass: null, code: PRODUCTION_OUTPUT_CODES.FINGERPRINT_REQUIRED,
      message: '没有设计指纹：放行无法绑定到具体这一版设计，拒绝产出正式文件',
      fix: ['先运行下单前闸门取到设计指纹，再申请正式产出'],
    };
  }
  if (!ready) {
    return {
      ...base, allowed: false, outputClass: null, code: PRODUCTION_OUTPUT_CODES.BLOCKED,
      message: `门禁未通过（${blockerCodes.length} 类阻断）：现在只能产出草稿文件`,
      blockers: blockerCodes,
      fix: ['按阻断清单修设计或按规则登记豁免', '重新运行下单前闸门直到 ready=true', `需要先交付时用草稿命名：{名称}${DRAFT_MARKER}.{扩展名}`],
    };
  }
  // 门禁通过还不够：如果目录里还是草稿文件名，说明产物没按正式命名重新导出，不能算正式。
  // 例外：调用方显式声明"这些草稿正是本次要覆盖的"（仅限本目录、仅限 requested:'final'）。
  const replaced = new Set((Array.isArray(draftPathsReplaced) ? draftPathsReplaced : []).filter((item) => typeof item === 'string'));
  const staleAll = artifacts.map((item) => item?.path || item?.name).filter((item) => hasDraftMarker(item));
  const stale = staleAll.filter((item) => !replaced.has(item));
  const replacedDrafts = staleAll.filter((item) => replaced.has(item));
  if (stale.length) {
    return {
      ...base, allowed: false, outputClass: null, code: PRODUCTION_OUTPUT_CODES.STALE_DRAFT_MARKER,
      message: `门禁已通过，但仍有 ${stale.length} 个产物用的是草稿文件名：请按正式命名重新导出`,
      staleArtifacts: stale,
      fix: ['按正式命名重新导出这些产物（名字里不得含 DRAFT/NOT-FOR-ORDER/草稿）', '重新运行下单前闸门'],
    };
  }
  return {
    ...base, allowed: true, outputClass: 'final', naming: { suffix: '' }, blockers: [], ticket: ticket('final'),
    // 被豁免的草稿必须显式出现在结果里：不静默隐藏，人才看得到"哪些旧文件会被这次导出覆盖"。
    replacedDrafts,
    message: '门禁通过：允许按正式命名产出生产文件（仍须人工签字后才下单）',
    exampleNames: [
      artifactName({ base: 'GERBER_CircuitPilot-gerber', ext: 'zip', outputClass: 'final' }).name,
      artifactName({ base: 'BOM_CircuitPilot-bom', ext: 'csv', outputClass: 'final' }).name,
      artifactName({ base: 'CPL_CircuitPilot-cpl', ext: 'csv', outputClass: 'final' }).name,
      artifactName({ base: 'STEP_CircuitPilot-step', ext: 'step', outputClass: 'final' }).name,
    ],
  };
}
