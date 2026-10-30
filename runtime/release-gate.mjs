/**
 * 下单前的闸门：所有验收证据合成一个"能不能出生产文件"的裁决。
 *
 * 为什么要有它：前面每一环都已经各自"验过"了，但**没人负责说"整体能不能下单"**。
 * 而真实的失败模式是：Gerber 导出了、BOM 导出了，于是大家以为可以下单——
 * 哪怕 DRC 还有 156 条未处理、仿真有 2 个检查点没过、布局从没被人确认过。
 *
 * 三条铁律：
 *   1. **证据缺失 = 阻断**，不是"通过"（`unknown` 与 `blocked` 同等对待，只是原因不同）；
 *   2. **产物自带草稿标记就必须拦住**（本目录的产物文件名里就写着 DRAFT-NOT-FOR-ORDER）；
 *   3. **产物必须与当前设计对得上**：BOM/CPL 的位号集合要对齐网表，CPL 坐标要对齐实机读回，
 *      Gerber 的内层数量要对齐铜箔层数——否则你手上这份文件不一定是这块板。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkConstraints } from './constraints.mjs';
import { DRC_CODES, classifyDrcItems } from './drc.mjs';
import { decideProductionOutput } from './production-release.mjs';
import { assertEvidenceEnvelope } from './evidence-contract.mjs';

export const RELEASE_CODES = {
  ENGINEERING_BLOCKED: 'RELEASE_ENGINEERING_BLOCKED',
  ENGINEERING_NOT_READY: 'RELEASE_ENGINEERING_NOT_READY',
  ENGINEERING_WARNING: 'RELEASE_ENGINEERING_WARNING',
  ENGINEERING_EXEMPTION_INVALID: 'RELEASE_ENGINEERING_EXEMPTION_INVALID',
  ENGINEERING_EXEMPTION_UNUSED: 'RELEASE_ENGINEERING_EXEMPTION_UNUSED',
  LAYOUT_RULES_BLOCKED: 'RELEASE_LAYOUT_RULES_BLOCKED',
  GATE_PASSED: 'RELEASE_GATE_PASSED',
  ARCHIVE_MISSING: 'RELEASE_ARCHIVE_MISSING',
  ARTIFACT_MISSING: 'RELEASE_ARTIFACT_MISSING',
  ARTIFACT_EMPTY: 'RELEASE_ARTIFACT_EMPTY',
  ARTIFACT_UNPARSEABLE: 'RELEASE_ARTIFACT_UNPARSEABLE',
  ARTIFACT_DRAFT_MARKER: 'RELEASE_ARTIFACT_DRAFT_MARKER',
  ARCHIVE_INCONSISTENT: 'RELEASE_ARCHIVE_INCONSISTENT',
  GERBER_COPPER_MISSING: 'RELEASE_GERBER_COPPER_MISSING',
  GERBER_OUTLINE_MISSING: 'RELEASE_GERBER_OUTLINE_MISSING',
  GERBER_DRILL_MISSING: 'RELEASE_GERBER_DRILL_MISSING',
  BOM_DESIGNATOR_MISMATCH: 'RELEASE_BOM_DESIGNATOR_MISMATCH',
  BOM_SUPPLIER_MISSING: 'RELEASE_BOM_SUPPLIER_MISSING',
  BOM_VALUE_MISSING: 'RELEASE_BOM_VALUE_MISSING',
  CPL_DESIGNATOR_MISMATCH: 'RELEASE_CPL_DESIGNATOR_MISMATCH',
  CPL_COORD_MISMATCH: 'RELEASE_CPL_COORD_MISMATCH',
  CPL_LAYER_MISSING: 'RELEASE_CPL_LAYER_MISSING',
  STEP_INVALID: 'RELEASE_STEP_INVALID',
  SCHEMATIC_NOT_READY: 'RELEASE_SCHEMATIC_NOT_READY',
  SCHEMATIC_EVIDENCE_MISSING: 'RELEASE_SCHEMATIC_EVIDENCE_MISSING',
  SIMULATION_NOT_RUN: 'RELEASE_SIMULATION_NOT_RUN',
  SIMULATION_FAILED: 'RELEASE_SIMULATION_FAILED',
  SIMULATION_EVIDENCE_INVALID: 'RELEASE_SIMULATION_EVIDENCE_INVALID',
  SIMULATION_EVIDENCE_UNBOUND: 'RELEASE_SIMULATION_EVIDENCE_UNBOUND',
  SIMULATION_COVERAGE_PARTIAL: 'RELEASE_SIMULATION_COVERAGE_PARTIAL',
  DRC_EVIDENCE_MISSING: 'RELEASE_DRC_EVIDENCE_MISSING',
  DRC_EVIDENCE_UNBOUND: 'RELEASE_DRC_EVIDENCE_UNBOUND',
  DRC_EVIDENCE_PCB_MISMATCH: 'RELEASE_DRC_EVIDENCE_PCB_MISMATCH',
  DRC_UNEXPLAINED: 'RELEASE_DRC_UNEXPLAINED',
  DRC_EXEMPTED: 'RELEASE_DRC_EXEMPTED',
  DRC_EXEMPTION_INVALID: 'RELEASE_DRC_EXEMPTION_INVALID',
  DRC_EXEMPTION_UNUSED: 'RELEASE_DRC_EXEMPTION_UNUSED',
  PLACEMENT_EVIDENCE_MISSING: 'RELEASE_PLACEMENT_EVIDENCE_MISSING',
  PLACEMENT_NOT_VERIFIED: 'RELEASE_PLACEMENT_NOT_VERIFIED',
  PLACEMENT_NOT_CONFIRMED: 'RELEASE_PLACEMENT_NOT_CONFIRMED',
  PLACEMENT_ROLLED_BACK: 'RELEASE_PLACEMENT_ROLLED_BACK',
  SUPPLY_IDENTITY_MISSING: 'RELEASE_SUPPLY_IDENTITY_MISSING',
  SUPPLY_PRICE_STOCK_UNKNOWN: 'RELEASE_SUPPLY_PRICE_STOCK_UNKNOWN',
  FRESHNESS_UNKNOWN: 'RELEASE_FRESHNESS_UNKNOWN',
  FRESHNESS_STALE: 'RELEASE_FRESHNESS_STALE',
  CONSTRAINT_FAILED: 'RELEASE_CONSTRAINT_FAILED',
  CONSTRAINT_FACT_UNKNOWN: 'RELEASE_CONSTRAINT_FACT_UNKNOWN',
  CONSTRAINT_UNCLASSIFIED: 'RELEASE_CONSTRAINT_UNCLASSIFIED',
  CONSTRAINT_PASS: 'RELEASE_CONSTRAINT_PASS',
  RELEASE_READY: 'RELEASE_READY',
  RELEASE_WITH_WARNINGS: 'RELEASE_READY_WITH_WARNINGS',
  RELEASE_BLOCKED: 'RELEASE_BLOCKED',
  // W5-02：G2 网表一致性 / G3 规则证据接入下单门禁
  NETLIST_EVIDENCE_MISSING: 'RELEASE_NETLIST_EVIDENCE_MISSING',
  NETLIST_EVIDENCE_UNBOUND: 'RELEASE_NETLIST_EVIDENCE_UNBOUND',
  NETLIST_BLOCKED: 'RELEASE_NETLIST_BLOCKED',
  RULES_EVIDENCE_MISSING: 'RELEASE_RULES_EVIDENCE_MISSING',
  RULES_EVIDENCE_UNBOUND: 'RELEASE_RULES_EVIDENCE_UNBOUND',
  RULES_BLOCKED: 'RELEASE_RULES_BLOCKED',
};

const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const finding = (code, severity, message, field = null) => ({ code, severity, message, field });

// ---------------------------------------------------------------- 文本与压缩包读取

/** 真实产物是 UTF-16LE（带 BOM）：嘉立创导出的 "CSV" 实际是 Tab 分隔的 UTF-16。 */
export function decodeText(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  return bytes.toString('utf8');
}

/** 解析分隔文本。分隔符按表头里的出现次数判定（本项目产物是 Tab 但扩展名叫 .csv）。 */
export function parseTable(text) {
  const clean = String(text || '').replace(/^\ufeff/, '');
  const lines = clean.split(/\r?\n/).filter((line) => line.trim().length);
  if (!lines.length) return { delimiter: null, headers: [], rows: [] };
  const headerLine = lines[0];
  const delimiter = (headerLine.match(/\t/g) || []).length >= 2 ? '\t' : ',';
  const split = (line) => line.split(delimiter).map((cell) => cell.trim().replace(/^"(.*)"$/s, '$1').trim());
  const headers = split(headerLine);
  const rows = lines.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => [header, split(line)[index] ?? ''])));
  return { delimiter, headers, rows };
}

/** 读 zip 的中央目录（不依赖任何三方库）：条目名、大小，并核对 EOCD 声明的条目数。 */
export function readZipEntries(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const entries = [];
  let cursor = 0;
  for (;;) {
    const at = bytes.indexOf(Buffer.from('PK\x01\x02', 'latin1'), cursor);
    if (at < 0) break;
    if (at + 46 > bytes.length) break;
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    entries.push({ name, size });
    cursor = at + 46 + nameLength + extraLength + commentLength;
  }
  let declaredCount = null;
  const eocd = bytes.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (eocd >= 0 && eocd + 12 <= bytes.length) declaredCount = bytes.readUInt16LE(eocd + 10);
  return { entries, declaredCount, consistent: declaredCount === null ? null : declaredCount === entries.length };
}

const COPPER_EXTENSIONS = { GTL: 'top', GBL: 'bottom', G1: 'inner', G2: 'inner', G3: 'inner', G4: 'inner', G5: 'inner', G6: 'inner', G7: 'inner', G8: 'inner', G9: 'inner', G10: 'inner', G11: 'inner', G12: 'inner', G13: 'inner', G14: 'inner', G15: 'inner', G16: 'inner', G17: 'inner', G18: 'inner', G19: 'inner', G20: 'inner' };

export function classifyGerberEntries(names = []) {
  const copper = { top: [], bottom: [], inner: [] };
  const outline = [];
  const drills = [];
  for (const name of names) {
    const extension = String(name).split('.').pop().toUpperCase();
    if (COPPER_EXTENSIONS[extension]) { copper[COPPER_EXTENSIONS[extension]].push(name); continue; }
    if (extension === 'GKO' || /outline/i.test(name)) { outline.push(name); continue; }
    if (extension === 'DRL' || /drill/i.test(name)) { drills.push(name); }
  }
  return { copper, outline, drills, copperLayerCount: copper.top.length + copper.bottom.length + copper.inner.length };
}

/** 产物文件名自带草稿标记就必须拦住——本目录的产物就叫 DRAFT-NOT-FOR-ORDER。 */
export function isDraftArtifact(name) {
  return /draft|not[-_ ]?for[-_ ]?order|草稿|请勿下单|preliminary/i.test(String(name || ''));
}

// ---------------------------------------------------------------- 设计指纹

/** 设计指纹：把"这次验收到底看的是哪一版设计"固化下来，产物对不对得上就有据可查。 */
export function designFingerprint({ netlistSha256 = null, placement = null, outlineSource = null, drcDigest = null } = {}) {
  const parts = {
    netlistSha256,
    outline: Array.isArray(outlineSource) ? outlineSource.join(',') : (outlineSource ?? null),
    placement: Array.isArray(placement) ? [...placement].sort((a, b) => String(a.ref).localeCompare(String(b.ref))).map((item) => `${item.ref}@${round(item.xMm)}/${round(item.yMm)}/${round(item.rotationDeg ?? 0)}`) : null,
    drcDigest,
  };
  return { sha256: createHash('sha256').update(JSON.stringify(parts)).digest('hex'), parts };
}

// ---------------------------------------------------------------- 各道闸门

const gate = (id, title, findings, evidence = null) => {
  const blocking = findings.filter((item) => item.severity === 'blocking');
  const warnings = findings.filter((item) => item.severity === 'warning');
  return {
    id, title, findings, evidence,
    status: findings.some((item) => item.severity === 'unknown') ? 'unknown' : blocking.length ? 'blocked' : warnings.length ? 'warn' : 'pass',
    blockingCount: blocking.length,
  };
};
const unknown = (code, detail) => finding(code, 'unknown', detail);

export function gateSchematic({ acceptance } = {}) {
  if (!acceptance) return gate('schematic', '原理图验收', [unknown(RELEASE_CODES.SCHEMATIC_EVIDENCE_MISSING, '没有原理图验收报告：不知道 ERC/网络表/计划比对结果，不能下单')]);
  const findings = [];
  const netlist = acceptance.netlist || {};
  if (!Number.isFinite(Number(netlist.components)) || Number(netlist.components) <= 0) findings.push(unknown(RELEASE_CODES.SCHEMATIC_EVIDENCE_MISSING, '网表里 0 个器件：等于没有真读到设计，不能当成"原理图没问题"'));
  if (!Number.isFinite(Number(netlist.namedPins)) || Number(netlist.namedPins) <= 0) findings.push(unknown(RELEASE_CODES.SCHEMATIC_EVIDENCE_MISSING, '没有任何具名引脚：网络表很可能没读到'));
  for (const item of (acceptance.findings || []).filter((entry) => entry.severity === 'blocking')) findings.push(finding(RELEASE_CODES.SCHEMATIC_NOT_READY, 'blocking', item.message, item.field ?? null));
  if (acceptance.ready === false && !findings.length) findings.push(finding(RELEASE_CODES.SCHEMATIC_NOT_READY, 'blocking', '原理图验收未通过（报告未说明具体原因）'));
  return gate('schematic', '原理图验收', findings, { ready: acceptance.ready ?? null, components: netlist.components ?? null, nets: netlist.nets ?? null, namedPins: netlist.namedPins ?? null });
}

export function gateSimulation({ acceptance } = {}) {
  if (!acceptance) return gate('simulation', '仿真验收', [unknown(RELEASE_CODES.SIMULATION_NOT_RUN, '没有验收报告，无法确认仿真到底跑没跑')]);
  const checks = acceptance.designChecks || null;
  const simulation = acceptance.simulation || null;
  const findings = [];
  /**
   * 第 61 轮：调用方可以显式喂"本机落盘的 SPICE 证据"（body.acceptanceExtraOptions.simulationEvidence）。
   * 服务端会先做 fail-closed 校验（可读 / kind / 绑定 / 新鲜度 / 数值）；没通过时把原因装进
   * simulation.invalid 传到这里 —— 必须报**具体原因**，不能降级成笼统的 NOT_RUN
   * （"证据不可用"和"没跑仿真"是两件事，混在一起会让人误以为补跑就能过）。
   */
  if (simulation?.invalid === true) {
    const code = typeof simulation.code === 'string' && simulation.code ? simulation.code : RELEASE_CODES.SIMULATION_EVIDENCE_INVALID;
    findings.push(unknown(code, simulation.reason || '仿真证据未通过服务端校验（原因未提供）'));
    return gate('simulation', '仿真验收', findings, { simulated: false, invalid: true, code, reason: simulation.reason ?? null, evidencePath: simulation.evidencePath ?? null, binding: simulation.binding ?? null });
  }
  if (!checks && !simulation) return gate('simulation', '仿真验收', [unknown(RELEASE_CODES.SIMULATION_NOT_RUN, '既没有 EDA 侧仿真证据、也没有设计检查点结论：这不是"仿真通过"，是"没有仿真"')]);
  if (checks) {
    const summary = checks.summary || {};
    if (summary.simulated !== true) findings.push(unknown(RELEASE_CODES.SIMULATION_NOT_RUN, '设计检查点一次都没跑成（求解器缺失或推断不出检查点）'));
    for (const result of checks.results || []) {
      if (result.status === 'fail') findings.push(finding(RELEASE_CODES.SIMULATION_FAILED, 'blocking', `${result.title}：实测 ${JSON.stringify(result.measured)} 不满足 ${result.spec}${result.defect ? ` —— ${result.defect}` : ''}`, result.id));
      if (result.status === 'not-run') findings.push(unknown(RELEASE_CODES.SIMULATION_NOT_RUN, `${result.title}：没跑成（${result.reason}）`));
    }
    if (Number(summary.failed) > 0 && !findings.some((item) => item.code === RELEASE_CODES.SIMULATION_FAILED)) findings.push(finding(RELEASE_CODES.SIMULATION_FAILED, 'blocking', `有 ${summary.failed} 个检查点未通过`));
    if (summary.simulated === true && Number(summary.failed) === 0) {
      findings.push(finding(RELEASE_CODES.GATE_PASSED, 'info', `设计检查点仿真通过 ${summary.passed}/${summary.total}（覆盖范围仅限这些检查点，不等于全电路仿真）`));
    }
  } else {
    // 仿真证据可能来自两个真实来源：① EDA 导出的 SPICE 网表 + 求解器；② 验收时引用本机已落盘的
    // spice-simulation 证据（EDA 导不出网表、但曾用外部网表真实跑过求解器）。两者都必须如实标注来源与覆盖范围，
    // 不能把"外部网表跑的关键电路仿真"说成"全电路仿真"。
    const hash = String(simulation.evidenceHash ?? '').slice(0, 12);
    const source = simulation.source ? `来源 ${simulation.source}` : '来源 EDA 导出网表';
    const scope = simulation.scopeNote ? `；覆盖范围：${simulation.scopeNote}` : '；覆盖范围以 EDA 导出的网表为准';
    if (simulation.partial === true) {
      /**
       * 第 61 轮：真实 ngspice 证据只覆盖关键子电路（T3：USB-C VBUS→IP2312→VBAT 等），
       * EDA 侧整板 SPICE 网表导不出 ⇒ 这不能算"仿真通过"。已消费 ≠ 通过：
       * 如实 unknown 并说明还缺什么，避免"看到文件就算通过"的假 PASS。
       */
      const bindingNote = simulation.binding?.netlistSha256MatchedLive === true
        ? `；已与当前实时导出网表绑定（sha256 ${String(simulation.netlist?.sha256 ?? '').slice(0, 12)}）`
        : '';
      findings.push(unknown(RELEASE_CODES.SIMULATION_COVERAGE_PARTIAL, `仿真证据已消费（证据哈希 ${hash}，${source}）${scope}${bindingNote}；但覆盖范围仅关键子电路、整板 SPICE 模型仍缺失：这不是整板仿真通过`));
    } else {
      findings.push(finding(RELEASE_CODES.GATE_PASSED, 'info', `仿真证据在（证据哈希 ${hash}，${source}）${scope}`));
    }
  }
  return gate('simulation', '仿真验收', findings, {
    simulated: Boolean(checks?.summary?.simulated || simulation),
    summary: checks?.summary ?? null,
    source: simulation?.source ?? null,
    scopeNote: simulation?.scopeNote ?? '设计检查点仿真不等于全电路仿真',
    // 自证字段：放行报告必须能回答"到底消费了哪份证据、绑没绑上、覆盖多少"。
    evidencePath: simulation?.evidencePath ?? null,
    evidenceHash: simulation?.evidenceHash ?? null,
    partial: simulation?.partial === true,
    coverage: simulation?.coverage ?? null,
    binding: simulation?.binding ?? null,
  });
}

/**
 * DRC 闸门。
 *
 * 第 61 轮新增 `targetPcbUuid`：DRC 证据必须能证明"这份报告属于当前这块 PCB"。
 * 真机踩到过最新 DRC 证据 pcbUuid=5d632dde… 与当前板 5595e77c… 不一致 —— 直接喂给闸门
 * 会把"另一块板/上一版板 DRC 干净"读成"当前板 DRC 干净"，这是最危险的假 PASS。
 * 绑定策略（fail-closed）：
 *   - 给了 targetPcbUuid 且证据带 pcbUuid：不一致 → blocking（RELEASE_DRC_EVIDENCE_PCB_MISMATCH）；
 *   - 给了 targetPcbUuid 但证据没有 pcbUuid：无法确认归属 → unknown（RELEASE_DRC_EVIDENCE_UNBOUND）；
 *   - 没给 targetPcbUuid（如直接调用本函数的单测/离线报告）：保持旧行为，能判则判、不宣称绑定。
 */
export function gateDrc({ report, exemptions = [], targetPcbUuid = null } = {}) {
  const normalized = report && report.items ? report : null;
  if (!normalized) return gate('drc', 'DRC 校验', [unknown(RELEASE_CODES.DRC_EVIDENCE_MISSING, '没有 DRC 报告：不知道布线是否满足规则，不能下单')]);
  if (normalized.ok === false) return gate('drc', 'DRC 校验', [finding(RELEASE_CODES.DRC_EVIDENCE_MISSING, 'blocking', `DRC 报告不可用：${normalized.message || normalized.code}`)]);
  const classified = classifyDrcItems({ items: normalized.items || [], exemptions, truncated: Boolean(normalized.truncated), reportedCount: normalized.reportedCount ?? null });
  const findings = [];
  // 一律引用 drc.mjs 的常量，不硬编码码串（否则改名后这里会静默失灵）
  // 注意：EXEMPTION_UNUSED 不在此列。未匹配到任何问题的豁免等于「没豁免」（drc.mjs:237 本身也只是 warning）；
  // 若把它当阻断，就会出现「填满了也永远放行不了」的死结（第 57 轮真机遇到过）。仍然照实报出，但只作 warning。
  const invalidExemptionCodes = [DRC_CODES.EXEMPTION_INCOMPLETE, DRC_CODES.EXEMPTION_CAP_EXCEEDED, DRC_CODES.EXEMPTION_UNBOUNDED, DRC_CODES.EXEMPTION_FORBIDDEN];
  for (const item of classified.findings || []) {
    if (item.code === DRC_CODES.UNEXPLAINED) findings.push(finding(RELEASE_CODES.DRC_UNEXPLAINED, 'blocking', item.message, item.field ?? null));
    else if (item.code === DRC_CODES.ALL_EXEMPTED || /EXEMPTED/.test(String(item.code))) findings.push(finding(RELEASE_CODES.DRC_EXEMPTED, 'warning', item.message, item.field ?? null));
    else if (invalidExemptionCodes.includes(item.code)) findings.push(finding(RELEASE_CODES.DRC_EXEMPTION_INVALID, 'blocking', item.message, item.field ?? null));
    else if (item.code === DRC_CODES.EXEMPTION_UNUSED) findings.push(finding(RELEASE_CODES.DRC_EXEMPTION_UNUSED, 'warning', item.message, item.field ?? null));
    else if (item.severity === 'blocking') findings.push(finding(RELEASE_CODES.DRC_UNEXPLAINED, 'blocking', item.message, item.field ?? null));
  }
  // 证据绑定校验（第 61 轮）：见上方 gateDrc 注释。错误/未知都会改变 status（blocked/unknown），
  // 绝不允许"另一块板的干净 DRC"被读成"当前板没问题"。
  const bindingSource = normalized.binding && typeof normalized.binding === 'object' ? normalized.binding : null;
  const evidencePcbUuid = String(bindingSource?.pcbUuid ?? normalized.pcbUuid ?? normalized.fingerprint?.pcbUuid ?? '').trim() || null;
  const targetPcb = typeof targetPcbUuid === 'string' && targetPcbUuid.trim() ? targetPcbUuid.trim() : null;
  const bindingInfo = { targetPcbUuid: targetPcb, evidencePcbUuid, matched: null, projectUuid: bindingSource?.projectUuid ?? null, savedAt: bindingSource?.savedAt ?? null, digest: bindingSource?.digest ?? normalized.digest ?? null };
  if (targetPcb) {
    if (!evidencePcbUuid) {
      bindingInfo.matched = false;
      findings.push(unknown(RELEASE_CODES.DRC_EVIDENCE_UNBOUND, `DRC 证据没有 pcbUuid，无法确认它属于当前 PCB ${targetPcb}：不能把无法归属的报告当作当前板结论`));
    } else if (evidencePcbUuid !== targetPcb) {
      bindingInfo.matched = false;
      findings.push(finding(RELEASE_CODES.DRC_EVIDENCE_PCB_MISMATCH, 'blocking', `DRC 证据属于 PCB ${evidencePcbUuid}，当前目标是 ${targetPcb}：这是另一块板/上一版板的报告，不能当作当前板 DRC 结论`, 'drc'));
    } else {
      bindingInfo.matched = true;
      findings.push(finding(RELEASE_CODES.GATE_PASSED, 'info', `DRC 证据已绑定当前 PCB ${targetPcb}`, 'drc'));
    }
  }
  const summary = classified.summary || {};
  if (Number(summary.unexplained) > 0 && !findings.some((item) => item.code === RELEASE_CODES.DRC_UNEXPLAINED)) findings.push(finding(RELEASE_CODES.DRC_UNEXPLAINED, 'blocking', `还有 ${summary.unexplained} 条 DRC 问题未被解释或豁免`));
  if (classified.invalidExemptions?.length && !findings.some((item) => item.code === RELEASE_CODES.DRC_EXEMPTION_INVALID)) findings.push(finding(RELEASE_CODES.DRC_EXEMPTION_INVALID, 'blocking', `${classified.invalidExemptions.length} 条豁免无效`));
  if (classified.unusedExemptions?.length && !findings.some((item) => item.code === RELEASE_CODES.DRC_EXEMPTION_UNUSED)) findings.push(finding(RELEASE_CODES.DRC_EXEMPTION_UNUSED, 'warning', `${classified.unusedExemptions.length} 条豁免未匹配到任何问题（建议清理）`));
  // "截断"意味着我们没看全：没看全就不许算通过
  if (normalized.truncated) findings.push(unknown(RELEASE_CODES.DRC_EVIDENCE_MISSING, 'DRC 报告被截断：没有看全的问题一律按"未处理"对待'));
  // 自证字段：闸门必须能被追问「收到多少条豁免、条目里有没有 objects、报告是否被再归一化」，
  // 否则「填了却不生效」这类静默失败只能靠猜（前几轮就是这么走弯路的）。
  const drcItems = normalized.items || [];
  const diag = {
    exemptionsProvided: Array.isArray(exemptions) ? exemptions.length : 0,
    invalidExemptions: classified.invalidExemptions?.length ?? 0,
    unusedExemptions: classified.unusedExemptions?.length ?? 0,
    itemsWithObjects: drcItems.filter((i) => Array.isArray(i?.objects)).length,
    normalization: normalized.normalization || 'walk',
  };
  return gate('drc', 'DRC 校验', findings, { summary, mustFix: summary.mustFix ?? null, countsConsistent: normalized.countsConsistent ?? null, diag, binding: bindingInfo });
}

export function gatePlacement({ placementVerification, writeback = null, userConfirmed = false } = {}) {
  if (!placementVerification) return gate('placement', '布局确认', [unknown(RELEASE_CODES.PLACEMENT_EVIDENCE_MISSING, '没有布局复核结果：不知道器件是否都在板框内、是否越界/重叠')]);
  const findings = [];
  if (placementVerification.ok === false) {
    for (const item of (placementVerification.findings || []).filter((entry) => entry.severity === 'blocking')) findings.push(finding(RELEASE_CODES.PLACEMENT_NOT_VERIFIED, 'blocking', item.message, item.field ?? null));
    if (!findings.length) findings.push(finding(RELEASE_CODES.PLACEMENT_NOT_VERIFIED, 'blocking', '布局复核未通过（未说明具体原因）'));
  }
  if (writeback && writeback.ok === false && writeback.rollback?.ok === true) {
    findings.push(finding(RELEASE_CODES.PLACEMENT_ROLLED_BACK, 'warning', '有一次布局写回未通过校验并已回滚：板子保持原样，但如果这正是要交付的布局，请重新确认'));
  } else if (writeback && writeback.ok === false) {
    findings.push(finding(RELEASE_CODES.PLACEMENT_ROLLED_BACK, 'blocking', '有一次布局写回未通过且回滚也没能确认还原：板子可能处于半改状态'));
  }
  if (userConfirmed !== true) findings.push(finding(RELEASE_CODES.PLACEMENT_NOT_CONFIRMED, 'blocking', '布局没有被明确确认过（自动布局的位移最大可能上百毫米）：下单前必须由人确认'));
  else findings.push(finding(RELEASE_CODES.GATE_PASSED, 'info', '布局已由人确认'));
  return gate('placement', '布局确认', findings, { verified: placementVerification.ok ?? null, checked: placementVerification.checkedCount ?? null, userConfirmed, writebackApplied: writeback?.applied ?? null });
}

const normalizeRef = (value) => String(value || '').trim().toUpperCase();
const refSet = (items) => new Set(items.map(normalizeRef).filter(Boolean));

export function gateArtifacts({ artifacts = [], design = {}, draftPathsReplaced = [] } = {}) {
  // 显式 null 也要能走到"缺产物/不知道"结论，而不是在 null 上抛 TypeError。
  if (!design || typeof design !== 'object') design = {};
  const findings = [];
  // 自产草稿豁免（第 49 轮）：`draftPathsReplaced` 是"本次正式导出即将覆盖的产物路径"。
  // 只有**调用方显式传入**时才生效，因此既有调用方（及全部既有用例）行为一字不变。
  // 被豁免的条目**显式写成 info 记录**，绝不静默隐藏。
  const replacedDraftPaths = new Set((Array.isArray(draftPathsReplaced) ? draftPathsReplaced : []).filter((item) => typeof item === 'string'));
  const waivedDraft = [];
  const expectedDesignators = refSet(design.designators || []);
  const byKind = new Map(artifacts.map((artifact) => [artifact?.kind, artifact]));
  const required = ['gerber', 'bom', 'cpl', 'step'];
  const evidence = {};
  for (const kind of required) {
    const artifact = byKind.get(kind);
    if (!artifact) { findings.push(unknown(RELEASE_CODES.ARTIFACT_MISSING, `缺少 ${kind} 产物`)); continue; }
    evidence[kind] = { path: artifact.path ?? null, bytes: artifact.bytes ?? null, draft: isDraftArtifact(artifact.path || artifact.name) };
    if (!Number.isFinite(Number(artifact.bytes)) || Number(artifact.bytes) <= 0) findings.push(finding(RELEASE_CODES.ARTIFACT_EMPTY, 'blocking', `${kind} 产物是空文件`));
    // 门禁层的先后顺序修复：self 产的草稿在本目录内会被本次正式导出覆盖 ⇒ 记豁免而不是判死；
    // 目录外/外来草稿仍然照旧 blocking（避免"随便放个草稿进来就能绕过"）。
    if (isDraftArtifact(artifact.path || artifact.name)) {
      if (replacedDraftPaths.has(artifact.path)) waivedDraft.push({ kind, path: artifact.path ?? null });
      else findings.push(finding(RELEASE_CODES.ARTIFACT_DRAFT_MARKER, 'blocking', `${kind} 产物文件名自带草稿标记（${artifact.path || artifact.name}）：这是草稿，不能用于下单`));
    }
    if (artifact.parseError) findings.push(finding(RELEASE_CODES.ARTIFACT_UNPARSEABLE, 'blocking', `${kind} 产物解析失败：${artifact.parseError}`));
  }

  if (waivedDraft.length) {
    findings.push(finding(RELEASE_CODES.RELEASE_WITH_WARNINGS, 'info', `已豁免 ${waivedDraft.length} 条自产草稿标记（本次正式导出将覆盖：${waivedDraft.map((item) => item.kind).join('、')}）`));
  }

  const gerber = byKind.get('gerber');
  if (gerber && !gerber.parseError) {
    const classified = gerber.gerber || classifyGerberEntries((gerber.entries || []).map((entry) => entry.name ?? entry));
    evidence.gerber = { ...evidence.gerber, copperLayerCount: classified.copperLayerCount, innerLayers: classified.copper.inner, outline: classified.outline, drills: classified.drills };
    if (Number.isFinite(Number(design.boardLayerCount)) && classified.copperLayerCount !== Number(design.boardLayerCount)) {
      findings.push(finding(RELEASE_CODES.GERBER_COPPER_MISSING, 'blocking', `Gerber 铜层数(${classified.copperLayerCount})与 PCB 铜箔层数(${design.boardLayerCount})不符：内层可能没导出`, 'gerber'));
    }
    if (!classified.copper.top.length || !classified.copper.bottom.length) findings.push(finding(RELEASE_CODES.GERBER_COPPER_MISSING, 'blocking', 'Gerber 缺少顶层或底层铜', 'gerber'));
    if (!classified.outline.length) findings.push(finding(RELEASE_CODES.GERBER_OUTLINE_MISSING, 'blocking', 'Gerber 缺少板框层（GKO）：板厂无法确定外形', 'gerber'));
    if (!classified.drills.length) findings.push(finding(RELEASE_CODES.GERBER_DRILL_MISSING, 'blocking', 'Gerber 里没有钻孔文件（DRL）', 'gerber'));
    if (gerber.archive?.consistent === false) findings.push(finding(RELEASE_CODES.ARCHIVE_INCONSISTENT, 'blocking', `压缩包中央目录条目数(${gerber.entries?.length})与 EOCD 声明(${gerber.archive.declaredCount})不符：文件可能被截断`, 'gerber'));
  }

  const bom = byKind.get('bom');
  if (bom && !bom.parseError) {
    const rows = bom.rows || [];
    const bomRefs = refSet(rows.flatMap((row) => String(row.Designator || row['Designator'] || '').split(/[,\s]+/)));
    evidence.bom = { ...evidence.bom, rows: rows.length, designators: [...bomRefs].length, headers: bom.headers ?? [] };
    if (expectedDesignators.size) {
      const missing = [...expectedDesignators].filter((ref) => !bomRefs.has(ref));
      const extra = [...bomRefs].filter((ref) => !expectedDesignators.has(ref));
      if (missing.length || extra.length) findings.push(finding(RELEASE_CODES.BOM_DESIGNATOR_MISMATCH, 'blocking', `BOM 位号与网表不一致：缺 ${missing.join(',') || '无'}；多 ${extra.join(',') || '无'}`, 'bom'));
    }
    const supplierKey = bom.headers?.find((header) => /supplier\s*part/i.test(header));
    const valueKey = bom.headers?.find((header) => /^value$/i.test(header.trim()));
    const withoutSupplier = rows.filter((row) => !supplierKey || !String(row[supplierKey] || '').trim());
    if (supplierKey && withoutSupplier.length) findings.push(finding(RELEASE_CODES.BOM_SUPPLIER_MISSING, 'blocking', `${withoutSupplier.length} 条 BOM 行没有供应商料号（下单必须知道买什么）`, 'bom'));
    if (!supplierKey) findings.push(unknown(RELEASE_CODES.BOM_SUPPLIER_MISSING, 'BOM 里找不到"Supplier Part"列：无法确认每颗器件都有料号'));
    // 阻容感没有 Value 就不能买（芯片的 Value 由 Device/Comment 承载，允许为空）
    const passives = rows.filter((row) => /^(R|C|L|FB)\d+/i.test(String(row.Designator || '')));
    const passiveWithoutValue = passives.filter((row) => !valueKey || !String(row[valueKey] || '').trim());
    if (passiveWithoutValue.length) findings.push(finding(RELEASE_CODES.BOM_VALUE_MISSING, 'blocking', `阻容感缺 Value：${passiveWithoutValue.map((row) => row.Designator).join(',')}`, 'bom'));
  }

  const cpl = byKind.get('cpl');
  if (cpl && !cpl.parseError) {
    const rows = cpl.rows || [];
    const cplRefs = refSet(rows.map((row) => row.Designator));
    evidence.cpl = { ...evidence.cpl, rows: rows.length, designators: [...cplRefs] };
    if (expectedDesignators.size) {
      const missing = [...expectedDesignators].filter((ref) => !cplRefs.has(ref));
      if (missing.length) findings.push(finding(RELEASE_CODES.CPL_DESIGNATOR_MISMATCH, 'blocking', `CPL 缺位号：${missing.join(',')}`, 'cpl'));
    }
    const headerOf = (pattern) => (cpl.headers || []).find((header) => pattern.test(header));
    const xKey = headerOf(/mid\s*x/i);
    const yKey = headerOf(/mid\s*y/i);
    const layerKey = headerOf(/^layer$/i);
    const rotationKey = headerOf(/rotation/i);
    if (layerKey) {
      const noLayer = rows.filter((row) => !String(row[layerKey] || '').trim());
      if (noLayer.length) findings.push(finding(RELEASE_CODES.CPL_LAYER_MISSING, 'blocking', `${noLayer.length} 条 CPL 行没有贴装面（T/B）`, 'cpl'));
    } else findings.push(unknown(RELEASE_CODES.CPL_LAYER_MISSING, 'CPL 里找不到 Layer 列：无法确认贴装面'));
    // 坐标必须与实机读回对齐：对不上说明这份 CPL 不是这块板的当前状态
    const live = new Map((design.placement || []).map((item) => [normalizeRef(item.ref), item]));
    if (xKey && yKey && live.size) {
      const toleranceMm = Number.isFinite(Number(design.coordinateToleranceMm)) ? Number(design.coordinateToleranceMm) : 0.05;
      const mismatched = [];
      const bases = new Set();
      for (const row of rows) {
        const ref = normalizeRef(row.Designator);
        const observed = live.get(ref);
        if (!observed) continue;
        const xMm = Number.parseFloat(String(row[xKey] || '').replace(/[^\d.+-]/g, ''));
        const yMm = Number.parseFloat(String(row[yKey] || '').replace(/[^\d.+-]/g, ''));
        if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) { mismatched.push(`${ref}(坐标解析不出)`); continue; }
        // 坐标基准修正（真机第 57 轮）：EDA 导出的 CPL 里 Mid X/Y 是**器件原点**，
        // 而 design.placement 的 xMm/yMm 是**包围盒中心**（非对称封装可差几毫米）。
        // 原实现只拿中心比，会对 USB/座子/模组等非对称封装稳定误报 CPL 坐标不一致。
        // 现在两套基准都试，取最小误差，并在证据里记下用的是哪套基准。
        const candidates = [{ basis: 'center', x: Number(observed.xMm), y: Number(observed.yMm) }];
        if (Number.isFinite(Number(observed.originXMm)) && Number.isFinite(Number(observed.originYMm))) {
          candidates.push({ basis: 'origin', x: Number(observed.originXMm), y: Number(observed.originYMm) });
        }
        let best = candidates[0];
        let errorMm = Math.hypot(xMm - best.x, yMm - best.y);
        for (const candidate of candidates.slice(1)) {
          const candidateError = Math.hypot(xMm - candidate.x, yMm - candidate.y);
          if (candidateError < errorMm) { errorMm = candidateError; best = candidate; }
        }
        if (errorMm > toleranceMm) mismatched.push(`${ref}(偏差 ${round(errorMm, 3)}mm)`);
        else bases.add(best.basis);
      }
      if (mismatched.length) findings.push(finding(RELEASE_CODES.CPL_COORD_MISMATCH, 'blocking', `CPL 坐标与实机读回不一致：${mismatched.slice(0, 6).join('、')}${mismatched.length > 6 ? ' …' : ''}`, 'cpl'));
      else findings.push(finding(RELEASE_CODES.GATE_PASSED, 'info', `CPL 坐标与实机读回一致（${rows.length} 个位号，容差 ${toleranceMm}mm，基准 ${[...bases].join('/') || 'center'}）`));
    }
    if (rotationKey === undefined) findings.push(unknown(RELEASE_CODES.CPL_COORD_MISMATCH, 'CPL 里找不到 Rotation 列：无法确认贴装角度'));
  }

  const step = byKind.get('step');
  if (step && !step.parseError) {
    const header = String(step.head || '');
    const looksLikeStep = /ISO-10303-21/.test(header);
    evidence.step = { ...evidence.step, headerOk: looksLikeStep };
    if (!looksLikeStep) findings.push(finding(RELEASE_CODES.STEP_INVALID, 'blocking', 'STEP 文件头不是 ISO-10303-21：这不是有效的 STEP', 'step'));
  }
  return gate('artifacts', '生产文件', findings, evidence);
}

export function gateSupply({ bom = null, pricing = null, staleAfterHours = 24, now = Date.now() } = {}) {
  const findings = [];
  const rows = bom?.rows || [];
  if (!rows.length) findings.push(unknown(RELEASE_CODES.SUPPLY_IDENTITY_MISSING, '没有 BOM 行，无法确认物料身份'));
  const header = (bom?.headers || []).find((item) => /supplier\s*part/i.test(item));
  if (header) {
    const unknownRows = rows.filter((row) => !/^C\d+$/i.test(String(row[header] || '').trim()));
    if (unknownRows.length) findings.push(finding(RELEASE_CODES.SUPPLY_IDENTITY_MISSING, 'blocking', `${unknownRows.length} 条 BOM 行的供应商料号不是 LCSC 编号（Cxxxxx）`, 'supply'));
  }
  // 价格/库存：拿不到就说拿不到，绝不用 0 或空值冒充
  const priced = new Set((pricing?.entries || []).map((entry) => String(entry.lcsc || '').toUpperCase()));
  if (!pricing || !pricing.entries?.length) findings.push(finding(RELEASE_CODES.SUPPLY_PRICE_STOCK_UNKNOWN, 'warning', '没有价格/库存证据：下单前请用立创商城 BOM 导出或开放平台凭据补齐（本系统不猜价格）', 'supply'));
  else if (header) {
    const missing = rows.map((row) => String(row[header] || '').toUpperCase()).filter((lcsc) => lcsc && !priced.has(lcsc));
    if (missing.length) findings.push(finding(RELEASE_CODES.SUPPLY_PRICE_STOCK_UNKNOWN, 'warning', `${missing.length} 颗器件没有价格/库存记录：${[...new Set(missing)].join(',')}`, 'supply'));
  }
  if (pricing && pricing.freshnessKnown === false) findings.push(finding(RELEASE_CODES.FRESHNESS_UNKNOWN, 'warning', '价格/库存没有更新时间：无法判断是否过期', 'supply'));
  // B3：证据有 TTL。超过阈值就明确标 stale（下单前必须重查），不能把旧价当现价。
  const checkedAt = pricing?.checkedAt ? Date.parse(pricing.checkedAt) : NaN;
  if (Number.isFinite(checkedAt)) {
    const ageHours = Math.round(((now - checkedAt) / 3_600_000) * 10) / 10;
    if (ageHours > staleAfterHours) findings.push(finding(RELEASE_CODES.FRESHNESS_STALE, 'warning', `价格/库存证据已 ${ageHours} 小时（阈值 ${staleAfterHours} 小时）：下单前必须重新查价`, 'supply'));
  }
  return gate('supply', '物料与供应链', findings, { rows: rows.length, priced: priced.size });
}

/**
 * A1 需求硬约束闸门：硬性且可量化的需求必须逐条 pass；拿不到事实 → unknown（阻断），
 * 无法量化的需求 → warning（人工确认），绝不用“没提供约束”冒充“约束已满足”。
 */
export function gateConstraints({ constraints = [], designFacts = null } = {}) {
  if (!Array.isArray(constraints) || !constraints.length) {
    return gate('constraints', '需求硬约束', [finding(RELEASE_CODES.CONSTRAINT_UNCLASSIFIED, 'info', '没有提供结构化硬约束：本闸门不阻断，但也不代表需求约束已被满足', 'constraints')], { provided: false, checked: 0 });
  }
  const result = checkConstraints({ constraints, facts: designFacts || {} });
  const findings = [];
  for (const item of result.report) {
    if (item.status === 'pass') findings.push(finding(RELEASE_CODES.CONSTRAINT_PASS, 'info', `${item.name}：${item.message}`, 'constraints'));
    else if (item.status === 'fail') findings.push(finding(RELEASE_CODES.CONSTRAINT_FAILED, 'blocking', `${item.name}：${item.message}`, 'constraints'));
    else if (item.status === 'unknown') findings.push(unknown(RELEASE_CODES.CONSTRAINT_FACT_UNKNOWN, `${item.name}：${item.message}`));
    else findings.push(finding(RELEASE_CODES.CONSTRAINT_UNCLASSIFIED, 'warning', `${item.name}：${item.message}`, 'constraints'));
  }
  return gate('constraints', '需求硬约束', findings, { provided: true, checked: result.report.length, facts: result.facts, report: result.report });
}

// ---------------------------------------------------------------- 合成裁决

/**
 * A16：工程分析/布局规则审计结果纳入放行证据。
 *
 * 语义严格区分"没跑"与"跑了没过"：
 *   - 未提供工程分析/布局审计 → gate.status='skipped' + info 说明"本次放行报告未覆盖"，**不冒充通过、也不阻断**；
 *   - 提供了分析 → findings 按 severity 映射：blocking → 阻断，warning → 警告，其它 → 信息；
 *     布局规则审计 passed/releaseReady=false → 阻断（GATE 红线）；
 *   - 豁免必须带理由且能匹配 code（避免"一条豁免免掉所有"）；未匹配的豁免单独 warning，不静默忽略。
 */
export function gateEngineering({ analysis = null, layoutAudit = null, exemptions = [] } = {}) {
  const provided = Boolean(analysis || layoutAudit);
  if (!provided) {
    return {
      id: 'engineering',
      title: '工程分析/布局规则（A16）',
      status: 'skipped',
      blockingCount: 0,
      findings: [finding(RELEASE_CODES.ENGINEERING_NOT_READY, 'info', '本次未提供工程分析/布局规则审计结果：该证据未纳入本次放行（报告显式标记未覆盖，不冒充通过）')],
      evidence: { available: false, note: '可在验证页运行工程分析/布局规则审计后重新跑闸门' },
    };
  }
  const validExemptions = [];
  const findings = [];
  for (const exemption of Array.isArray(exemptions) ? exemptions : []) {
    const code = typeof exemption?.code === 'string' ? exemption.code.trim() : '';
    const reason = typeof exemption?.reason === 'string' ? exemption.reason.trim() : '';
    if (!code || !reason) {
      findings.push(finding(RELEASE_CODES.ENGINEERING_EXEMPTION_INVALID, 'warning', `豁免被忽略：必须同时给 code 与 reason（收到 code=${code || '空'} / reason=${reason || '空'}）`));
      continue;
    }
    validExemptions.push({ code, reason });
  }
  const usedExemptionCodes = new Set();
  const addMapped = (rawFindings, source) => {
    for (const item of Array.isArray(rawFindings) ? rawFindings : []) {
      const severity = item?.severity === 'blocking' ? 'blocking' : item?.severity === 'warning' ? 'warning' : 'info';
      if (severity === 'info') continue;
      const code = typeof item?.code === 'string' ? item.code : `${source}-finding`;
      if (severity === 'blocking') {
        const exemption = validExemptions.find((entry) => entry.code === code || entry.code === '*');
        if (exemption) {
          usedExemptionCodes.add(exemption.code);
          findings.push(finding(RELEASE_CODES.ENGINEERING_WARNING, 'warning', `${source}【已豁免，理由：${exemption.reason}】${item.message ?? code}`, item.path ?? null));
          continue;
        }
        findings.push(finding(RELEASE_CODES.ENGINEERING_BLOCKED, 'blocking', `${source}：${item.message ?? code}`, item.path ?? null));
      } else {
        findings.push(finding(RELEASE_CODES.ENGINEERING_WARNING, 'warning', `${source}：${item.message ?? code}`, item.path ?? null));
      }
    }
  };
  if (analysis) {
    addMapped(analysis.findings, '工程分析');
    if (analysis.releaseReady === false) findings.push(finding(RELEASE_CODES.ENGINEERING_NOT_READY, 'blocking', '工程报告 releaseReady=false（布局规则 GATE 未全部通过）'));
  }
  if (layoutAudit) {
    addMapped(layoutAudit.findings, '布局规则');
    if (layoutAudit.passed === false || layoutAudit.releaseReady === false) {
      const failures = layoutAudit.summary?.blockingFailures;
      findings.push(finding(RELEASE_CODES.LAYOUT_RULES_BLOCKED, 'blocking', `布局规则审计未通过（硬门禁失败 ${Number.isFinite(failures) ? failures : '未知'} 项）`));
    }
  }
  for (const exemption of validExemptions) {
    if (!usedExemptionCodes.has(exemption.code)) findings.push(finding(RELEASE_CODES.ENGINEERING_EXEMPTION_UNUSED, 'warning', `豁免 code=${exemption.code} 没有匹配任何阻断项：请核对是否写错（未静默忽略）`));
  }
  return gate('engineering', '工程分析/布局规则（A16）', findings, {
    available: true,
    analysisReportHash: analysis?.reportHash ?? null,
    analysisPassed: analysis?.passed ?? null,
    layoutAuditHash: layoutAudit?.auditHash ?? null,
    layoutReleaseReady: layoutAudit?.releaseReady ?? null,
    exempted: [...usedExemptionCodes],
  });
}

/** 统一契约证据的绑定校验：没有 pcbUuid 或与目标不一致 → unknown（无法归属的证据不算当前板结论）。 */
function evidenceBinding(envelope, targetPcbUuid, kind, codes) {
  const evidencePcb = String(envelope?.fingerprint?.pcbUuid ?? '').trim() || null;
  const target = typeof targetPcbUuid === 'string' && targetPcbUuid.trim() ? targetPcbUuid.trim() : null;
  if (!target) return { findings: [], info: { targetPcbUuid: null, evidencePcbUuid: evidencePcb, matched: null } };
  if (!evidencePcb) return { findings: [unknown(codes.missing || codes.unbound, `${kind} 证据没有 pcbUuid，无法确认它属于当前 PCB ${target}：不能把无法归属的报告当作当前板结论`)], info: { targetPcbUuid: target, evidencePcbUuid: null, matched: false } };
  if (evidencePcb !== target) return { findings: [finding(codes.unbound, 'blocking', `${kind} 证据属于 PCB ${evidencePcb}，当前目标是 ${target}：这是另一块板/上一版板的证据`, kind)], info: { targetPcbUuid: target, evidencePcbUuid: evidencePcb, matched: false } };
  return { findings: [], info: { targetPcbUuid: target, evidencePcbUuid: evidencePcb, matched: true } };
}

/** W5-02 G2：网表一致性证据（意图 ↔ 实际逐 pin diff）。缺失/不可归属/阻断都不得放行。 */
export function gateNetlistEvidence({ envelope = null, targetPcbUuid = null } = {}) {
  if (!envelope) return gate('netlist', '网表一致性', [unknown(RELEASE_CODES.NETLIST_EVIDENCE_MISSING, '没有网表 diff 证据：无法确认实际连线符合设计意图，不能下单')], { verdict: null });
  let validated;
  try { validated = assertEvidenceEnvelope(envelope); } catch (error) { return gate('netlist', '网表一致性', [finding(RELEASE_CODES.NETLIST_EVIDENCE_MISSING, 'blocking', `网表证据不符合统一证据契约：${String(error?.message || error).slice(0, 200)}`)], { verdict: null }); }
  const binding = evidenceBinding(validated, targetPcbUuid, 'netlist-diff', { missing: RELEASE_CODES.NETLIST_EVIDENCE_UNBOUND, unbound: RELEASE_CODES.NETLIST_EVIDENCE_UNBOUND });
  const findings = [...binding.findings];
  if (validated.verdict === 'blocked') findings.push(finding(RELEASE_CODES.NETLIST_BLOCKED, 'blocking', `网表 diff 阻断：${validated.findings.filter((item) => item.severity === 'error').length} 条错误（GND 空网/网络缺失/引脚错接/悬空等）`));
  else if (validated.verdict === 'unknown') findings.push(unknown(RELEASE_CODES.NETLIST_EVIDENCE_MISSING, validated.blockedReason || '网表证据为 unknown：无法据此放行'));
  else findings.push(finding(RELEASE_CODES.GATE_PASSED, 'info', '网表 diff 通过'));
  return gate('netlist', '网表一致性', findings, { verdict: validated.verdict, counts: validated.counts, digest: validated.digest, binding: binding.info });
}

/** W5-02 G3：规则证据（ERC/DRC）。缺失/不可归属/阻断都不得放行。 */
export function gateRulesEvidence({ envelope = null, targetPcbUuid = null } = {}) {
  if (!envelope) return gate('rules', 'ERC/DRC 规则', [unknown(RELEASE_CODES.RULES_EVIDENCE_MISSING, '没有规则证据（ERC/DRC）：不知道电气与布线规则是否满足，不能下单')], { verdict: null });
  let validated;
  try { validated = assertEvidenceEnvelope(envelope); } catch (error) { return gate('rules', 'ERC/DRC 规则', [finding(RELEASE_CODES.RULES_EVIDENCE_MISSING, 'blocking', `规则证据不符合统一证据契约：${String(error?.message || error).slice(0, 200)}`)], { verdict: null }); }
  const binding = evidenceBinding(validated, targetPcbUuid, 'rules', { missing: RELEASE_CODES.RULES_EVIDENCE_UNBOUND, unbound: RELEASE_CODES.RULES_EVIDENCE_UNBOUND });
  const findings = [...binding.findings];
  if (validated.verdict === 'blocked') findings.push(finding(RELEASE_CODES.RULES_BLOCKED, 'blocking', `规则检查阻断：${validated.findings.filter((item) => item.severity === 'error').length} 条错误未处理`));
  else if (validated.verdict === 'unknown') findings.push(unknown(RELEASE_CODES.RULES_EVIDENCE_MISSING, validated.blockedReason || '规则证据为 unknown：无法据此放行'));
  else findings.push(finding(RELEASE_CODES.GATE_PASSED, 'info', 'ERC/DRC 规则通过'));
  return gate('rules', 'ERC/DRC 规则', findings, { verdict: validated.verdict, counts: validated.counts, digest: validated.digest, binding: binding.info });
}

export function gateFabricationRelease({ acceptance = null, drcReport = null, exemptions = [], placementVerification = null, writeback = null, userConfirmed = false, artifacts = [], design = {}, draftPathsReplaced = [], pricing = null, constraints = [], designFacts = null, engineering = null, layoutAudit = null, engineeringExemptions = [], targetPcbUuid = null, simulationEvidence = null, netlistEvidence = null, rulesEvidence = null, generatedAt = new Date().toISOString() } = {}) {
  if (!design || typeof design !== 'object') design = {};
  const gates = [
    gateSchematic({ acceptance }),
    gateSimulation({ acceptance }),
    gateDrc({ report: drcReport, exemptions, targetPcbUuid }),
    gatePlacement({ placementVerification, writeback, userConfirmed }),
    gateArtifacts({ artifacts, design, draftPathsReplaced }),
    gateSupply({ bom: artifacts.find((artifact) => artifact?.kind === 'bom') || null, pricing }),
    gateConstraints({ constraints, designFacts }),
    gateEngineering({ analysis: engineering, layoutAudit, exemptions: engineeringExemptions }),
    // 只有调用方提供网表/规则证据时才纳入（旧调用方保持原行为）；提供了一类缺失另一类 → fail-closed。
    ...(netlistEvidence || rulesEvidence ? [gateNetlistEvidence({ envelope: netlistEvidence, targetPcbUuid }), gateRulesEvidence({ envelope: rulesEvidence, targetPcbUuid })] : []),
  ];
  const findings = gates.flatMap((item) => item.findings);
  const blocking = findings.filter((item) => item.severity === 'blocking' || item.severity === 'unknown');
  const warnings = findings.filter((item) => item.severity === 'warning');
  const ready = blocking.length === 0;
  const fingerprint = designFingerprint({ netlistSha256: design.netlistSha256 ?? acceptance?.netlist?.meta?.sha256 ?? null, placement: design.placement ?? null, outlineSource: design.outlineSource ?? null, drcDigest: drcReport?.digest ?? null });
  findings.push(ready
    ? finding(warnings.length ? RELEASE_CODES.RELEASE_WITH_WARNINGS : RELEASE_CODES.RELEASE_READY, warnings.length ? 'warning' : 'info', ready && warnings.length ? `可以下单，但有 ${warnings.length} 条需要人工知悉的警告` : '全部闸门通过：可以出生产文件下单')
    : finding(RELEASE_CODES.RELEASE_BLOCKED, 'blocking', `不能下单：${blocking.length} 条阻断（${[...new Set(blocking.map((item) => item.code))].join('、')}）`));
  const report = {
    kind: 'fabrication-release-gate',
    schemaVersion: 1,
    generatedAt,
    ready,
    verdict: ready ? (warnings.length ? 'ready-with-warnings' : 'ready-to-order') : 'blocked',
    blockers: blocking.map((item) => ({ code: item.code, message: item.message, field: item.field ?? null })),
    warnings: warnings.map((item) => ({ code: item.code, message: item.message, field: item.field ?? null })),
    gates: gates.map((item) => ({ id: item.id, title: item.title, status: item.status, blockingCount: item.blockingCount, evidence: item.evidence, findings: item.findings })),
    fingerprint,
    /** 证据接线自证（第 61 轮）：放行报告必须能回答"这份 DRC 绑的是哪块板、消费了哪份仿真证据"。 */
    evidenceBinding: { targetPcbUuid: targetPcbUuid ?? null, simulation: simulationEvidence ?? null, netlist: netlistEvidence?.digest ?? null, rules: rulesEvidence?.digest ?? null },
    /** 下单这件事永远需要人签字：机器只能把"能不能"的证据摆出来 */
    humanSignoffRequired: true,
  };
  /**
   * 产出决策直接挂在报告里：它就是"能不能出正式生产文件"的答案。
   * 放在这里而不是让界面各算一遍，是为了只有一处规则——界面/脚本/未来导出器都读同一份结论。
   * 必须把 `draftPathsReplaced` 原样传进来：否则门禁已承认"本次正式导出会覆盖自产草稿"，
   * 报告里的 outputDecision 却仍按未替换裁决 → 按钮永远显示"有草稿文件不能用"（P0-6）。
   */
  report.outputDecision = decideProductionOutput({ gate: report, requested: 'final', artifacts, draftPathsReplaced });
  return report;
}

// ---------------------------------------------------------------- 从磁盘收集真实产物

export function collectArtifacts({ files = {} } = {}) {
  const artifacts = [];
  for (const [kind, filePath] of Object.entries(files)) {
    if (!filePath) { artifacts.push({ kind, path: null, missing: true, bytes: 0 }); continue; }
    if (!existsSync(filePath)) { artifacts.push({ kind, path: filePath, missing: true, bytes: 0 }); continue; }
    let buffer;
    try { buffer = readFileSync(filePath); } catch (error) { artifacts.push({ kind, path: filePath, bytes: 0, parseError: String(error?.message || error).slice(0, 160) }); continue; }
    const artifact = { kind, path: filePath, bytes: buffer.length, mtimeMs: statSync(filePath).mtimeMs };
    try {
      if (kind === 'gerber') {
        const { entries, declaredCount, consistent } = readZipEntries(buffer);
        artifact.entries = entries;
        artifact.archive = { declaredCount, consistent };
      } else if (kind === 'bom' || kind === 'cpl') {
        const table = parseTable(decodeText(buffer));
        artifact.headers = table.headers;
        artifact.rows = table.rows;
        artifact.delimiter = table.delimiter;
      } else if (kind === 'step') {
        artifact.head = Buffer.from(buffer.subarray(0, 512)).toString('utf8');
      }
    } catch (error) {
      artifact.parseError = String(error?.message || error).slice(0, 160);
    }
    artifacts.push(artifact);
  }
  return artifacts;
}
