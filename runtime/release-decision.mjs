import { createHash } from 'node:crypto';

/**
 * 统一的放行决策：把"本地门禁"与"人工证据"合成**一个**答案。
 *
 * 之前的毛病：release-gate 能说 `ready-to-order`，production readiness 却写死
 * `online-dfm:false`、`orderEnabled:false`，三处页面三种口径；用户不知道信谁。
 * 这里把规则收成一处：
 *   - 本地门禁来自 `gateFabricationRelease`（schematic/simulation/drc/placement/artifacts/supply）；
 *   - 人工证据来自落盘的 DFM 回填与终审签核（`evidence-store`）；
 *   - 任何一项缺失 / 未通过 → `ready:false`，并逐项给 blockedBy；
 *   - `orderEnabled` 永远是 false（自动下单/支付是业务红线，裁决器无权打开）。
 */

export const RELEASE_DECISION_SCHEMA_VERSION = 1;

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const localGateStatus = (gate) => {
  if (!gate) return 'unknown';
  if (gate.status === 'pass' || gate.status === 'warn') return 'pass';
  return gate.status === 'blocked' ? 'blocked' : 'unknown';
};

const evidenceRef = (entry) => (entry ? { digest: entry.digest, savedAt: entry.savedAt, path: entry.path, fingerprint: entry.fingerprint ?? {} } : null);

/**
 * @param {{ gate?: object | null, dfm?: object | null, signoff?: object | null, generatedAt?: string }} input
 * @returns {{
 *   schemaVersion: number, kind: 'release-decision', generatedAt: string,
 *   ready: boolean, orderEnabled: false, humanSignoffRequired: true,
 *   verdict: 'ready' | 'ready-with-warnings' | 'blocked',
 *   gates: Array<{ id: string, scope: 'local'|'manual', title: string, status: string, passed: boolean, reason: string | null, evidence: object | null }>,
 *   blockedBy: string[], reason: string,
 *   evidence: { gateFingerprint: object | null, dfm: object | null, signoff: object | null },
 *   fingerprint: string,
 * }}
 */
const bindingMismatch = (entry, binding, keys, label) => {
  if (!entry || !binding) return null;
  for (const key of keys) {
    const expected = binding[key];
    if (expected === null || expected === undefined || expected === '') continue;
    const actual = entry.fingerprint?.[key] ?? null;
    if (actual === null) return `${label}未绑定 ${key}（当前 ${expected}），不能证明属于本板/本计划`;
    if (actual !== expected) return `${label}绑定 ${key}=${actual} 与当前 ${expected} 不一致`;
  }
  return null;
};

/**
 * @param {{ gate?: object | null, dfm?: object | null, signoff?: object | null, binding?: { planHash?: string | null, pcbUuid?: string | null, manifestHash?: string | null } | null, generatedAt?: string }} input
 */
export function buildReleaseDecision({ gate = null, dfm = null, signoff = null, binding = null, generatedAt = new Date().toISOString() } = {}) {
  const localGates = (gate?.gates || []).map((item) => ({
    id: `local:${item.id}`,
    scope: 'local',
    title: item.title,
    status: localGateStatus(item),
    passed: localGateStatus(item) === 'pass',
    reason: localGateStatus(item) === 'pass' ? null : `本地门禁未通过：${item.title}（${item.status}）`,
    evidence: item.evidence ?? null,
  }));

  if (!gate) {
    localGates.push({ id: 'local:release-gate', scope: 'local', title: '本地放行门禁', status: 'unknown', passed: false, reason: '没有本地门禁报告：不能声称可以放行', evidence: null });
  }

  // 证据必须是"这一块板/这一份计划"的：给了 binding 就强制校验指纹里的绑定字段。
  const dfmBindingIssue = bindingMismatch(dfm, binding, ['planHash', 'pcbUuid'], 'DFM 证据');
  const signoffBindingIssue = bindingMismatch(signoff, binding, ['planHash', 'pcbUuid'], '签核证据')
    || (signoff && binding?.manifestHash && binding.manifestHash !== (signoff.payload?.manifestHash ?? null) ? '签核绑定的物料清单与当前产物不一致' : null);
  const dfmPassed = dfm?.payload?.passed === true && !dfmBindingIssue;
  const signoffPassed = signoff?.payload?.passed === true && Array.isArray(signoff?.payload?.roles) && signoff.payload.roles.length > 0 && !signoffBindingIssue;
  const manualGates = [
    {
      id: 'manual:dfm',
      scope: 'manual',
      title: '在线 DFM（人工回填）',
      status: dfm ? (dfmPassed ? 'pass' : 'blocked') : 'unknown',
      passed: dfmPassed,
      reason: dfmPassed ? null : (dfmBindingIssue || (dfm ? '人工回填的 DFM 结论为不通过' : '缺在线 DFM 证据：本地检查不能冒充在线 DFM')),
      evidence: evidenceRef(dfm),
    },
    {
      id: 'manual:signoff',
      scope: 'manual',
      title: '人工终审签核',
      status: signoffPassed ? 'pass' : (signoff ? 'blocked' : 'unknown'),
      passed: signoffPassed,
      reason: signoffPassed ? null : (signoffBindingIssue || (signoff ? '签核记录无效（需 passed:true 且至少一个角色）' : '缺人工终审签核记录')),
      evidence: evidenceRef(signoff),
    },
  ];

  const gates = [...localGates, ...manualGates];
  const blockedBy = gates.filter((item) => !item.passed).map((item) => item.id);
  const ready = blockedBy.length === 0;
  const hasWarnings = Boolean(gate?.warnings?.length);
  const verdict = ready ? (hasWarnings ? 'ready-with-warnings' : 'ready') : 'blocked';
  const evidence = {
    gateFingerprint: gate?.fingerprint ?? null,
    binding: binding ?? null,
    dfm: evidenceRef(dfm),
    signoff: evidenceRef(signoff),
  };
  const fingerprint = digestOf({ schemaVersion: RELEASE_DECISION_SCHEMA_VERSION, gates, evidence });

  return {
    schemaVersion: RELEASE_DECISION_SCHEMA_VERSION,
    kind: 'release-decision',
    generatedAt,
    ready,
    orderEnabled: false,
    humanSignoffRequired: true,
    verdict,
    gates,
    blockedBy,
    reason: ready
      ? (hasWarnings ? '证据齐全，可出正式生产文件；仍有警告需人工知悉。自动下单/支付仍永久禁用。' : '证据齐全，可出正式生产文件；自动下单/支付仍永久禁用。')
      : `还不能放行：${gates.filter((item) => !item.passed).map((item) => item.reason).join('；')}`,
    evidence,
    fingerprint,
  };
}
