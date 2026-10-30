import { createHash } from 'node:crypto';
import { runRuleChecks } from './agents/rule-runner.mjs';
import { auditNetlist } from './agents/netlist-auditor.mjs';
import { auditPartIdentity } from './agents/librarian.mjs';
import { buildDesignSpec, validateDesignSpec } from './design-spec.mjs';
import { createEvidenceEnvelope } from './evidence-contract.mjs';

/**
 * 六道门证据生产者（P0-2 / task-16）：把 G1~G6 要的证据从**运行时输入**落成统一证据信封。
 *
 * 背景缺陷（复审计 P0-2 / P1-8）：
 *   - G1(design-spec)/G5(placement)/G6(fabrication-release) 以前**没有任何生产者**，门禁只能标
 *     "未实现"；G2(lib-evidence)/G3(netlist-diff)/G4(rules) 虽已接通，但多器件时只落一条会漏判。
 *   - 修复不能靠伪造"通过"：本模块只做**生产者**，输入缺什么就在 `missing` 里如实登记，
 *     输入不完整/非法就落 blocked 或 unknown，绝不产生没有输入依据的 pass。
 *     门禁裁决仍由 gate-engine 按统一证据契约做。
 *
 * 设计约束：
 *   1. 只读：agent/审计结果声明 source.readOnly=true，证据只落盘不回写设计；
 *   2. 每条证据都绑定 pcbUuid（门禁按 fingerprint.pcbUuid 取证据），缺 pcbUuid 直接拒绝；
 *   3. lib-evidence 逐器件落盘，且**保存顺序把 blocked 的放最后**：万一有调用方仍按 latest 读，
 *      也不会被后面的 pass 盖住（宁可挡住，不静默放行）；
 *   4. 返回 `{saved, missing, report}`：`saved` 只含真正落盘的证据，`missing` 只含缺输入的原因。
 */
export const GATES_EVIDENCE_CODES = Object.freeze({
  STORE_REQUIRED: 'GATES_EVIDENCE_STORE_REQUIRED',
  PCB_REQUIRED: 'GATES_EVIDENCE_PCB_REQUIRED',
  SAVE_FAILED: 'GATES_EVIDENCE_SAVE_FAILED',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const coded = (code, message, details = null) => Object.assign(new Error(message), { code, details });
const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 兼容多种器件清单形态：refdes/designator、lcscId/供应商料号、以及 EDA/供应商/资料核验数据。 */
function normalizeComponent(component, index) {
  const refdes = text(component?.refdes) || text(component?.designator) || text(component?.ref) || text(component?.props?.Designator) || `#${index + 1}`;
  const lcscId = text(component?.lcscId) || text(component?.supplierPart) || text(component?.eda?.lcscId) || null;
  return { refdes, lcscId, raw: component };
}

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
};
const sha256Of = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const FINDING_CODE_RE = /^[A-Z][A-Z0-9_]+$/;
/** 证据契约只收大写错误码：下游码（如 SPEC_INVALID）照用，不合法就退回本门兜底码。 */
function findingCode(value, fallback) {
  const raw = typeof value === 'string' ? value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_') : '';
  return FINDING_CODE_RE.test(raw) ? raw : fallback;
}
/** 上游审计多用 blocking/fatal/error/warning/info；证据契约只认 error/warning/info。 */
const mapSeverity = (severity) => (severity === 'blocking' || severity === 'fatal' || severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info');

/**
 * G1 规格门证据：spec 可以是 `buildDesignSpec` 的**生成输入**（{project, requirements, boards, ...}），
 * 也可以是已校验的 design-spec（schemaVersion=1）。校验通过 → pass；不完整/非法 → blocked（不是 unknown，
 * 因为"给了但不对"与"根本没给"必须分开：前者要用户改，后者要用户补）。
 * 无 spec 时调用方不落证据、G1 由 gate-engine 判 unknown。
 */
function buildDesignSpecEnvelope({ spec, pcbUuid, projectId, now }) {
  const base = {
    kind: 'design-spec',
    subject: { type: 'spec', id: `spec-${pcbUuid}` },
    source: { agent: 'design-spec', version: '1.0.0', readOnly: true },
    now,
  };
  try {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw Object.assign(new Error('design-spec 输入必须是对象'), { code: 'SPEC_INVALID' });
    const normalized = spec.schemaVersion === 1 && spec.project && Array.isArray(spec.boards)
      ? validateDesignSpec(spec).spec
      : buildDesignSpec(spec);
    const specDigest = sha256Of(normalized);
    return createEvidenceEnvelope({
      ...base,
      subject: { type: 'spec', id: String(normalized.project?.id || normalized.project?.name || `spec-${pcbUuid}`) },
      fingerprint: { pcbUuid, projectId: text(projectId) || text(normalized.project?.id) || null, specDigest },
      verdict: 'pass',
      findings: [{ code: 'DESIGN_SPEC_VALID', severity: 'info', message: `design-spec 校验通过：${normalized.boards.length} 块板 / ${normalized.requirements.length} 条需求 / ${normalized.acceptance.length} 条验收映射` }],
      counts: { boards: normalized.boards.length, interfaces: normalized.interfaces.length, netIntent: normalized.netIntent.length, bomLock: normalized.bomLock.length, requirements: normalized.requirements.length, acceptance: normalized.acceptance.length },
      details: { project: normalized.project, boardIds: normalized.boards.map((board) => board.id), specDigest },
    });
  } catch (error) {
    return createEvidenceEnvelope({
      ...base,
      fingerprint: { pcbUuid, projectId: text(projectId) || null, specDigest: null },
      verdict: 'blocked',
      findings: [{ code: findingCode(error?.code, 'DESIGN_SPEC_INVALID'), severity: 'error', message: String(error?.message || error).slice(0, 400) }],
      counts: {},
      details: { issue: error?.code ?? null },
      blockedReason: `design-spec 不完整/非法：${String(error?.message || error).slice(0, 240)}`,
    });
  }
}

/**
 * G5 布局门证据：placement 可以是 `verifyOutlinePlacement` 的结果（{ok, blockingCount, findings, checkedCount}），
 * 也可以是 { verification, writeback, userConfirmed } 包装结构（路由 body 形状）。
 * 复核通过但人工未确认（userConfirmed=false）→ blocked；没有明确结论/没检查任何器件 → unknown。
 */
function buildPlacementEnvelope({ placement, pcbUuid, projectId, now }) {
  const wrapper = placement && typeof placement === 'object' && !Array.isArray(placement) ? placement : null;
  const verification = wrapper?.verification && typeof wrapper.verification === 'object' ? wrapper.verification : wrapper;
  const rawFindings = Array.isArray(verification?.findings) ? verification.findings : [];
  const findings = rawFindings.slice(0, 20).map((finding) => ({ code: findingCode(finding?.code, 'PLACEMENT_FINDING'), severity: mapSeverity(finding?.severity), message: String(finding?.message || '').slice(0, 400) })).filter((finding) => finding.message);
  const blocking = findings.filter((finding) => finding.severity === 'error');
  const checked = Number(verification?.checkedCount ?? verification?.checked ?? 0) || 0;
  const ok = verification?.ok === true || verification?.passed === true;
  const userConfirmed = wrapper?.userConfirmed ?? verification?.userConfirmed;
  const base = {
    kind: 'placement',
    subject: { type: 'pcb', id: String(pcbUuid) },
    fingerprint: { pcbUuid, projectId: text(projectId) || null, checkedCount: checked },
    source: { agent: 'placement-audit', version: '1.0.0', readOnly: true },
    counts: { checked, findings: findings.length },
    details: { writeback: wrapper?.writeback ?? null, userConfirmed: userConfirmed ?? null },
    now,
  };
  if (!verification || typeof verification !== 'object') {
    return createEvidenceEnvelope({ ...base, verdict: 'blocked', findings: [{ code: 'PLACEMENT_EVIDENCE_INVALID', severity: 'error', message: 'placement 输入必须是布局复核结果（{ok, findings, checkedCount}）或 {verification, userConfirmed}' }], blockedReason: '布局输入无法识别' });
  }
  if (blocking.length) {
    return createEvidenceEnvelope({ ...base, verdict: 'blocked', findings: blocking, counts: { ...base.counts, blocking: blocking.length }, blockedReason: `布局复核 ${blocking.length} 条阻断（越界/重叠/禁布等）` });
  }
  if (!ok) {
    return createEvidenceEnvelope({ ...base, verdict: 'unknown', findings, blockedReason: '布局复核结果没有明确的 ok/passed 结论，不能当成通过' });
  }
  if (checked <= 0) {
    return createEvidenceEnvelope({ ...base, verdict: 'unknown', findings, blockedReason: '布局复核没有检查任何器件（checkedCount=0），不能当成通过' });
  }
  if (userConfirmed === false) {
    return createEvidenceEnvelope({ ...base, verdict: 'blocked', findings: [...findings, { code: 'PLACEMENT_NOT_CONFIRMED', severity: 'error', message: '布局复核通过但人工未确认（G5 要求人工确认）' }], blockedReason: '布局未获人工确认' });
  }
  return createEvidenceEnvelope({ ...base, verdict: 'pass', findings: [...findings, { code: 'PLACEMENT_VERIFIED', severity: 'info', message: `布局复核通过：${checked} 个器件在板框/禁布/间距规则内` }], counts: { ...base.counts, checked } });
}

/**
 * G6 制造门证据：输入是 `gateFabricationRelease` 的报告（kind='fabrication-release-gate'），
 * 也接受统一 releaseDecision（{ready, blockedBy}）。ready 且无 blockers → pass；否则 blocked。
 * 注意：本证据只是把"制造放行报告"固化，不替代 gate 本身的重算；报告必须由调用方用当前产物生成。
 */
function buildFabricationReleaseEnvelope({ fabricationRelease, pcbUuid, projectId, now }) {
  const report = fabricationRelease;
  const base = {
    kind: 'fabrication-release',
    subject: { type: 'pcb', id: String(pcbUuid) },
    fingerprint: { pcbUuid, projectId: text(projectId) || null, gateFingerprint: report?.fingerprint?.sha256 ?? null },
    source: { agent: 'fabrication-release-gate', version: '1.0.0', readOnly: true },
    counts: {},
    details: { verdict: report?.verdict ?? null, outputDecision: report?.outputDecision ?? null },
    now,
  };
  const recognized = report && typeof report === 'object' && !Array.isArray(report) && ('ready' in report || typeof report.verdict === 'string' || Array.isArray(report.blockers) || Array.isArray(report.blockedBy));
  if (!recognized) {
    return createEvidenceEnvelope({ ...base, verdict: 'blocked', findings: [{ code: 'FABRICATION_RELEASE_INVALID', severity: 'error', message: 'fabricationRelease 输入必须是 gateFabricationRelease 报告或统一 releaseDecision（含 ready/verdict/blockers）' }], blockedReason: '制造放行输入无法识别' });
  }
  const ready = report.ready === true || report.verdict === 'ready-to-order' || report.verdict === 'ready-with-warnings';
  const blockersRaw = Array.isArray(report.blockers) ? report.blockers : (Array.isArray(report.blockedBy) ? report.blockedBy.map((code) => ({ code, message: `原料阻断码 ${code}` })) : []);
  const blockers = blockersRaw.slice(0, 20).map((blocker) => ({ code: findingCode(blocker?.code, 'RELEASE_BLOCKED'), severity: 'error', message: String(blocker?.message || blocker?.code || '制造放行阻断').slice(0, 400) }));
  const warnings = (Array.isArray(report.warnings) ? report.warnings : []).slice(0, 10).map((warning) => ({ code: findingCode(warning?.code, 'RELEASE_WARNING'), severity: 'warning', message: String(warning?.message || warning?.code || '').slice(0, 400) })).filter((warning) => warning.message);
  if (!ready || blockers.length) {
    const findings = blockers.length ? blockers : [{ code: 'RELEASE_BLOCKED', severity: 'error', message: `制造放行报告未 ready（verdict=${String(report.verdict ?? 'unknown')}）` }];
    return createEvidenceEnvelope({ ...base, verdict: 'blocked', findings, counts: { blockers: findings.length, warnings: warnings.length }, blockedReason: `制造放行未通过：${findings.length} 条阻断` });
  }
  return createEvidenceEnvelope({ ...base, verdict: 'pass', findings: [...warnings, { code: 'RELEASE_GATE_PASSED', severity: 'info', message: `制造放行报告 ready（verdict=${String(report.verdict ?? 'ready')}）：Gerber/BOM/CPL/DRC 产物一致` }], counts: { blockers: 0, warnings: warnings.length, gates: Array.isArray(report.gates) ? report.gates.length : 0 } });
}

/**
 * 生产六道门里"产品内可产出"的六类证据：design-spec / lib-evidence / netlist-diff / rules / placement / fabrication-release。
 *
 * @param {object} options
 * @param {object} options.evidenceStore 证据库（必须实现 save/list/latest）
 * @param {string} options.pcbUuid 目标 PCB（门禁按 pcbUuid 取证据，必填）
 * @param {string|null} [options.projectId] 工程域（并入 fingerprint，便于按工程回溯）
 * @param {string|null} [options.boardId]
 * @param {Array<object>} [options.components] 器件清单；每项可带 eda/supply/datasheet 核验数据
 * @param {object|string|null} [options.erc] 官方 ERC 报告（原始或已归一化）
 * @param {object|string|null} [options.drc] 官方 DRC 报告（原始或已归一化）
 * @param {object|string|null} [options.intentNetlist] 意图网表（design-spec.netIntent 或已审核网表）
 * @param {object|string|null} [options.actualNetlist] EDA 实际网表（EasyEDA 导出文本/对象或归一化网表）
 * @param {object|null} [options.spec] design-spec（`buildDesignSpec` 生成输入或已校验 spec）→ G1 证据；同时也是 G3 意图网表的兜底来源（spec.netIntent）
 * @param {object|null} [options.placement] 布局复核结果（`verifyOutlinePlacement` 的 {ok,findings,checkedCount}）或 {verification,writeback,userConfirmed} → G5 证据
 * @param {object|null} [options.fabricationRelease] `gateFabricationRelease` 报告 / 统一 releaseDecision（{ready,verdict,blockers,warnings,...}）→ G6 证据
 * @param {Array<object>} [options.ercExemptions] ERC 豁免清单（交给 rule-runner 判定有效性）
 * @param {Array<object>} [options.drcExemptions] DRC 豁免清单
 * @param {Function} [options.now]
 * @returns {{saved: Array<{kind:string,digest:string,path:string,verdict:string}>, missing: Array<{kind:string,reason:string}>, report: object}}
 */
export function collectGateEvidence({
  evidenceStore = null,
  pcbUuid = null,
  projectId = null,
  boardId = null,
  components = [],
  erc = null,
  drc = null,
  intentNetlist = null,
  actualNetlist = null,
  spec = null,
  placement = null,
  fabricationRelease = null,
  ercExemptions = [],
  drcExemptions = [],
  now = () => new Date(),
} = {}) {
  if (!evidenceStore || typeof evidenceStore.save !== 'function') {
    throw coded(GATES_EVIDENCE_CODES.STORE_REQUIRED, '缺少证据库（evidenceStore），无法落盘门禁证据');
  }
  const targetPcb = text(pcbUuid);
  if (!targetPcb) throw coded(GATES_EVIDENCE_CODES.PCB_REQUIRED, '缺少 pcbUuid：门禁证据必须绑定具体 PCB，不能产生"谁都对不上"的证据');

  const saved = [];
  const missing = [];
  const skipped = [];

  const saveEnvelope = (envelope, extraFingerprint = {}, note = null) => {
    try {
      const result = evidenceStore.save({
        kind: envelope.kind,
        payload: envelope,
        fingerprint: { pcbUuid: targetPcb, projectId: text(projectId) || null, ...extraFingerprint },
        note,
      });
      const item = { kind: envelope.kind, digest: result.digest, path: result.path, verdict: envelope.verdict, subject: envelope.subject ?? null };
      saved.push(item);
      return item;
    } catch (error) {
      throw coded(GATES_EVIDENCE_CODES.SAVE_FAILED, `门禁证据落盘失败（${envelope.kind}）：${String(error?.message || error).slice(0, 200)}`, { kind: envelope.kind, cause: error?.code ?? null });
    }
  };

  // ---- G4 rules：ERC/DRC 归一化 + 豁免归类（缺一边仍落 unknown 证据，但登记 missing，绝不判 pass）----
  if (erc || drc) {
    try {
      const envelope = runRuleChecks({
        erc, drc,
        ercExemptions: Array.isArray(ercExemptions) ? ercExemptions : [],
        drcExemptions: Array.isArray(drcExemptions) ? drcExemptions : [],
        pcbUuid: targetPcb,
        boardId: text(boardId) || null,
        projectUuid: text(projectId) || null,
        now,
      });
      saveEnvelope(envelope, { source: 'rule-runner' }, '门禁 G4 规则证据（ERC/DRC 归一化）');
      const absent = [!erc ? 'ERC' : null, !drc ? 'DRC' : null].filter(Boolean);
      if (absent.length) missing.push({ kind: 'rules', reason: `缺少 ${absent.join('/')} 报告：规则证据只能判 unknown，不能当通过` });
    } catch (error) {
      missing.push({ kind: 'rules', reason: `规则证据无法生成：${String(error?.message || error).slice(0, 200)}`, code: error?.code ?? null });
    }
  } else {
    missing.push({ kind: 'rules', reason: '缺少 ERC/DRC 报告：不能把"没有报告"当成"规则通过"' });
  }

  // ---- G3 netlist-diff：意图网表 ↔ 实际网表逐 pin 比对（两边都必须有）----
  // spec 作为意图网表兜底：只有确实带 netIntent/nets 的 spec 才交给 auditor，避免把坏 spec 当网表输入。
  const specAsIntent = spec && ((Array.isArray(spec.netIntent) && spec.netIntent.length) || (Array.isArray(spec.nets) && spec.nets.length)) ? spec : null;
  const intent = intentNetlist ?? specAsIntent;
  if (intent && actualNetlist) {
    try {
      const envelope = auditNetlist({ intent, actual: actualNetlist, pcbUuid: targetPcb, boardId: text(boardId) || null, now });
      saveEnvelope(envelope, { source: 'netlist-auditor', intentDigest: envelope.fingerprint?.intentDigest ?? null }, '门禁 G3 网表 diff 证据');
    } catch (error) {
      missing.push({ kind: 'netlist-diff', reason: `网表 diff 无法生成：${String(error?.message || error).slice(0, 200)}`, code: error?.code ?? null });
    }
  } else {
    const absent = [!intent ? '意图网表(design-spec.netIntent 或已审核网表)' : null, !actualNetlist ? 'EDA 实际网表' : null].filter(Boolean);
    missing.push({ kind: 'netlist-diff', reason: `缺少 ${absent.join('、')}：无法逐 pin 比对，不产生网表证据` });
  }

  // ---- G2 lib-evidence：逐器件三源核验（EDA 库 / 供应商 / 资料），缺料号只登记 missing ----
  const list = Array.isArray(components) ? components : [];
  if (!list.length) {
    missing.push({ kind: 'lib-evidence', reason: '缺少器件清单（components 为空）：无法核验器件身份，不能凭空出通过证据' });
  } else {
    const envelopes = [];
    for (const [index, component] of list.entries()) {
      const { refdes, lcscId, raw } = normalizeComponent(component, index);
      if (!lcscId) {
        missing.push({ kind: 'lib-evidence', reason: `器件 ${refdes} 缺 LCSC 料号：无法核验身份/封装，不伪造通过`, refdes });
        continue;
      }
      try {
        const envelope = auditPartIdentity({
          part: raw,
          eda: raw?.eda ?? null,
          supply: raw?.supply ?? null,
          datasheet: raw?.datasheet ?? null,
          pcbUuid: targetPcb,
          projectId: text(projectId) || null,
          now,
        });
        envelopes.push(envelope);
      } catch (error) {
        missing.push({ kind: 'lib-evidence', reason: `器件 ${refdes}(${lcscId}) 身份核验无法生成：${String(error?.message || error).slice(0, 200)}`, lcscId, code: error?.code ?? null });
      }
    }
    // fail-closed：blocked 的器件最后写。gates-service 只读 latest(kind)，否则更早的 blocked 会被 pass 盖住。
    const ordered = [...envelopes].sort((left, right) => (left.verdict === 'blocked' ? 1 : 0) - (right.verdict === 'blocked' ? 1 : 0));
    for (const envelope of ordered) {
      saveEnvelope(envelope, { source: 'librarian', lcscId: envelope.fingerprint?.lcscId ?? null }, `门禁 G2 器件身份证据（${envelope.subject?.id ?? 'unknown'}）`);
    }
    const blocked = envelopes.filter((envelope) => envelope.verdict === 'blocked');
    if (blocked.length) skipped.push({ kind: 'lib-evidence', reason: `${blocked.length} 件器件身份核验为 blocked（缺 EDA/供应商/资料源），已如实落盘，不判通过`, count: blocked.length });
  }

  // ---- G1 规格门：design-spec 必须是"可校验"的规格；给了但不完整 → blocked（不是 unknown）----
  if (spec) {
    const envelope = buildDesignSpecEnvelope({ spec, pcbUuid: targetPcb, projectId, now });
    saveEnvelope(envelope, { source: 'design-spec', specDigest: envelope.fingerprint?.specDigest ?? null }, '门禁 G1 规格证据（design-spec）');
  } else {
    missing.push({ kind: 'design-spec', reason: '缺少 design-spec 输入：规格门不能凭空通过（先 buildDesignSpec 或传已校验 spec）' });
  }

  // ---- G5 布局门：必须"复核通过 + 检查过器件（+ 人工确认若声明未确认）"----
  if (placement) {
    const envelope = buildPlacementEnvelope({ placement, pcbUuid: targetPcb, projectId, now });
    saveEnvelope(envelope, { source: 'placement-audit', checkedCount: envelope.fingerprint?.checkedCount ?? null }, '门禁 G5 布局复核证据');
  } else {
    missing.push({ kind: 'placement', reason: '缺少布局复核结果：不知道器件是否都在板框内、是否越界/重叠，不能当通过' });
  }

  // ---- G6 制造门：固化 gateFabricationRelease 报告（ready 且无 blockers 才 pass）----
  if (fabricationRelease) {
    const envelope = buildFabricationReleaseEnvelope({ fabricationRelease, pcbUuid: targetPcb, projectId, now });
    saveEnvelope(envelope, { source: 'fabrication-release-gate', gateFingerprint: envelope.fingerprint?.gateFingerprint ?? null }, '门禁 G6 制造放行证据');
  } else {
    missing.push({ kind: 'fabrication-release', reason: '缺少 gateFabricationRelease 报告：制造放行不能凭空通过' });
  }

  const kinds = [...new Set(saved.map((item) => item.kind))];
  return {
    saved,
    missing,
    report: {
      pcbUuid: targetPcb,
      projectId: text(projectId) || null,
      savedCount: saved.length,
      missingCount: missing.length,
      producedKinds: kinds,
      // 证据的"内容摘要"（不是门禁裁决）：只描述这次落盘了什么，裁决由 gate-engine 做。
      evidenceDigest: digestOf({ pcbUuid: targetPcb, projectId: text(projectId) || null, saved: saved.map((item) => ({ kind: item.kind, digest: item.digest })), missing }),
      verdicts: saved.map((item) => ({ kind: item.kind, digest: item.digest, verdict: item.verdict })),
      blockedParts: skipped,
      blockedKinds: saved.filter((item) => item.verdict === 'blocked').map((item) => item.kind),
      missingKinds: missing.map((item) => item.kind),
      complete: missing.length === 0 && saved.every((item) => item.verdict !== 'blocked'),
      note: '本模块只生产证据，不判放行；缺输入一律进 missing、输入不完整落 blocked/unknown，绝不伪造 pass',
    },
  };
}
