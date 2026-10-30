/**
 * 原理图验收链：把"导出网表 → 结构/计划比对 → ERC → 仿真"串成一次可复现的判定。
 *
 * 为什么必须串起来：这三件事此前各自存在（bridge 命令、schematic.mjs、simulation.mjs），
 * 但没有任何地方把它们组成"一次验收"——于是"原理图画好了"只能靠人肉看，或者靠
 * 印象宣布通过。这里产出的是**一句可复核的话**：谁（哪条网络/哪个位号）不合格、依据是什么。
 *
 * 依赖注入 `execute`（命令 id + 参数 → 结果），所以它既能接真桥接做真机验收，
 * 也能在测试里用假 execute 精确构造"导出失败/仿真不可用"等分支。
 */
import { createHash } from 'node:crypto';
import { normalizeErcReport } from './erc.mjs';
import { mergeErcDetail } from './eda-erc-detail.mjs';
import { checkOperatingPoint, discoverSolver, runSimulation } from './simulation.mjs';
import { checksFromDesign, runSpiceChecks } from './spice-checks.mjs';
import { verifySchematic } from './schematic.mjs';
import { auditNetConnectivity } from './net-connectivity.mjs';

export const ACCEPTANCE_CODES = {
  SIMULATION_CHECK_FAILED: 'ACCEPTANCE_SIMULATION_CHECK_FAILED',
  EXECUTE_REQUIRED: 'ACCEPTANCE_EXECUTE_REQUIRED',
  NETLIST_EXPORT_FAILED: 'ACCEPTANCE_NETLIST_EXPORT_FAILED',
  NETLIST_EMPTY: 'ACCEPTANCE_NETLIST_EMPTY',
  NETLIST_WRONG_DOCUMENT: 'ACCEPTANCE_NETLIST_WRONG_DOCUMENT',
  ERC_FAILED: 'ACCEPTANCE_ERC_FAILED',
  SIMULATION_NOT_RUNNABLE: 'ACCEPTANCE_SIMULATION_NOT_RUNNABLE',
  NET_CONNECTIVITY_UNAVAILABLE: 'ACCEPTANCE_NET_CONNECTIVITY_UNAVAILABLE',
  SIMULATION_FAILED: 'ACCEPTANCE_SIMULATION_FAILED',
};

const finding = (code, message, field = 'schematic', severity = 'blocking') => ({ code, message, field, severity });
const unwrap = (value) => (value && typeof value === 'object' && 'result' in value ? value.result : value);

/**
 * 导出网表文本：小网表内联返回；大网表（真机 180 器件 ≈432KB）按分片取回。
 * 分片失败必须返回 null + 原因，不能把半截网表当完整结果——半截网表会让下游读到错误的网络集合。
 */
export async function exportSchematicNetlistText(execute) {
  const exported = unwrap(await execute('schematic.netlist.export', { fileName: 'circuitpilot-netlist', netlistType: 'EasyEDA' }));
  if (!exported) return { exported: null, text: null, reason: null };
  if (typeof exported.text === 'string') return { exported, text: exported.text, reason: null };
  const chunks = Number(exported.chunks);
  if (!exported.exportId || !Number.isInteger(chunks) || chunks < 1) return { exported, text: null, reason: 'NO_INLINE_AND_NO_CHUNKS' };
  let text = '';
  for (let index = 0; index < chunks; index += 1) {
    const part = unwrap(await execute('schematic.netlist.chunk', { exportId: exported.exportId, index }));
    if (!part || typeof part.text !== 'string') return { exported, text: null, reason: part?.error || 'CHUNK_INVALID' };
    text += part.text;
  }
  return { exported, text, reason: null };
}


/**
 * @param {{execute: Function, plan?: object, skipSimulation?: boolean, solverPath?: string, timeoutMs?: number, expectations?: object, discover?: Function}} options
 */
export async function runSchematicAcceptance({ execute, plan = null, skipSimulation = false, solverPath, timeoutMs, expectations = null, discover = discoverSolver, simulationRun = runSimulation, checksRunner = runSpiceChecks, ercDetail = null, loadSimulationEvidence = null, pcbUuid = null } = {}) {
  if (typeof execute !== 'function') throw Object.assign(new Error('原理图验收需要桥接 execute'), { code: ACCEPTANCE_CODES.EXECUTE_REQUIRED });
  const findings = [];
  const steps = [];

  // 0) 先确认**当前活动文档真的是原理图**。
  //
  // 真机教训（2026-10-13，本轮）：活动文档是 PCB 时，导出命令既不报错也不返回内容——
  // 于是"读错了文档"会被下游读成"网表里 0 个器件 ⇒ 设计没问题"，
  // 这是最危险的一类假证据。更糟的是有些情况下这次导出会一直排到 60s 超时才返回空。
  // 所以这里先问 document.current（真机 1~6ms），文档类型不对就直接给出可定位的发现，
  // 且**不再调用导出**（省掉那次 60s 白等）。
  const SCHEMATIC_DOCUMENT_TYPE = 1;
  let activeDocument = null;
  let wrongDocument = false;
  try {
    activeDocument = unwrap(await execute('document.current', {}));
    const type = activeDocument?.documentType;
    if (typeof type === 'number' && type !== SCHEMATIC_DOCUMENT_TYPE) wrongDocument = true;
  } catch { activeDocument = null; }

  // 1) 网表：这是唯一的权威网络读回（sch_Net 在原理图上下文返回 0 条，见审计文档）。
  let netlistText = null;
  let netlistMeta = null;
  if (wrongDocument) {
    findings.push(finding(ACCEPTANCE_CODES.NETLIST_WRONG_DOCUMENT, `当前活动文档不是原理图（documentType=${activeDocument?.documentType}）：导出只会得到空网表。请先打开原理图页面再跑验收；本步骤已跳过，未做任何"通过"判断。`));
    steps.push({ step: 'netlist', ok: false, skipped: 'wrong-document', documentType: activeDocument?.documentType ?? null });
  } else try {
    const { exported, text, reason } = await exportSchematicNetlistText(execute);
    netlistText = typeof text === 'string' ? text : null;
    // 网表 sha256 是**设计指纹的唯一内容来源**：真机发现门禁指纹里的 netlistSha256 一直是 null，
    // 于是改了原理图（8→12 个元件）指纹却纹丝不动——指纹不覆盖设计内容就等于没有指纹。
    netlistMeta = exported ? {
      name: exported.name ?? null,
      size: exported.size ?? (netlistText ? netlistText.length : 0),
      sha256: netlistText ? createHash('sha256').update(netlistText).digest('hex') : null,
      chunks: Number(exported.chunks) || 1,
      inline: exported.inline !== false,
    } : null;
    if (!netlistText) findings.push(finding(ACCEPTANCE_CODES.NETLIST_EMPTY, reason
      ? `网表导出成功但分片取回失败（${reason}）：没有拿到完整网表，不能判定结构/网络。`
      : '嘉立创EDA 没有返回原理图网表（工程未保存或当前文档不是原理图）'));
    steps.push({ step: 'netlist', ok: Boolean(netlistText), size: netlistMeta?.size ?? 0, chunks: netlistMeta?.chunks ?? 0, inline: netlistMeta?.inline ?? null, ...(reason ? { reason } : {}) });
  } catch (error) {
    findings.push(finding(ACCEPTANCE_CODES.NETLIST_EXPORT_FAILED, `网表导出失败：${String(error?.message || error).slice(0, 200)}`));
    steps.push({ step: 'netlist', ok: false, error: String(error?.code || error?.name || 'ERROR') });
  }

  // 2) ERC：EDA 扩展 API 只有聚合计数；明细要靠 GUI 面板抓取（ercDetail 回调注入）。
  //    抓不到明细时如实保留聚合结论；抓到明细时用逐条 finding 替换聚合 finding，让"错在哪"可执行。
  let ercRaw = null;
  let ercReport = null;
  try {
    ercRaw = unwrap(await execute('schematic.drc', {}));
    ercReport = normalizeErcReport(ercRaw);
    steps.push({ step: 'erc', ok: true, raw: ercRaw });
    if (ercReport.aggregateOnly && typeof ercDetail === 'function' && (ercReport.counts.error > 0 || ercReport.counts.fatal > 0 || ercReport.counts.warning > 0)) {
      const detail = await ercDetail().catch(() => null);
      const merged = mergeErcDetail(ercReport, detail);
      if (merged && merged.detailSource) {
        ercReport = merged;
        steps.push({ step: 'erc-detail', ok: true, source: merged.detailSource, counts: merged.counts, partial: merged.detailCounts?.partial ?? null });
      } else {
        steps.push({ step: 'erc-detail', ok: false, reason: String(detail?.reason || 'DETAIL_UNAVAILABLE').slice(0, 120) });
      }
    }
  } catch (error) {
    findings.push(finding(ACCEPTANCE_CODES.ERC_FAILED, `ERC 未能执行：${String(error?.message || error).slice(0, 200)}（没有 ERC 结论不代表没有问题）`, 'erc', 'warning'));
    steps.push({ step: 'erc', ok: false, error: String(error?.code || error?.name || 'ERROR') });
  }

  // 3) 结构 + 计划比对
  let verification = null;
  if (netlistText) {
    verification = verifySchematic({ netlistText, erc: ercRaw, plan });
    findings.push(...verification.findings);
    // 真机/离线都踩到过：网表存在但**不可解析**时 `verification.parsed` 是 null，
    // 这里直接读 `.netCount` 会把整次验收炸成一个 500/400，连"网表不可解析"这个结论都拿不到。
    // 判据本身没错，错在没把"没有解析结果"当合法情况处理。
    steps.push({
      step: 'verify',
      ok: verification.ready,
      nets: verification.parsed?.netCount ?? null,
      components: verification.parsed?.componentCount ?? null,
      netsSource: verification.parsed?.netsSource ?? null,
    });
    // 抓到了逐条 ERC 明细时，把"聚合计数"类 finding 升级成逐条结论（保留计数信息，不重复阻断）。
    if (ercReport?.detailSource && ercReport.detailAvailable) {
      const aggregateErcCodes = new Set(['SCHEMATIC_ERC_ERROR', 'SCHEMATIC_ERC_WARNING', 'SCHEMATIC_ERC_AGGREGATE_ONLY']);
      const perItem = ercReport.findings.filter((item) => !item.aggregate);
      const blockingItems = perItem.filter((item) => item.severity === 'error' || item.severity === 'fatal');
      const warningItems = perItem.filter((item) => item.severity === 'warning');
      if (perItem.length) {
        const kept = findings.filter((item) => !aggregateErcCodes.has(item.code));
        findings.length = 0;
        findings.push(...kept);
        for (const item of blockingItems) {
          findings.push({
            code: item.code,
            message: `ERC 错误（逐条）：${item.detail}${item.object && item.object !== 'unknown' ? `（对象 ${item.object}）` : ''}${item.suggestion ? `；建议：${item.suggestion}` : ''}`,
            field: 'erc',
            severity: 'blocking',
          });
        }
        for (const item of warningItems.slice(0, 20)) {
          findings.push({ code: item.code, message: `ERC 警告（逐条）：${item.detail}${item.object && item.object !== 'unknown' ? `（对象 ${item.object}）` : ''}`, field: 'erc', severity: 'warning' });
        }
        findings.push({
          code: 'SCHEMATIC_ERC_DETAIL',
          message: `ERC 明细来自 EDA 检查面板（逐条 ${perItem.length} 条：错误 ${blockingItems.length} / 警告 ${warningItems.length} / 其它 ${perItem.length - blockingItems.length - warningItems.length}）`,
          field: 'erc',
          severity: 'info',
        });
      }
    }
  }


  // 3b) 网络连通性：网表里的引脚网络必须和 PCB 焊盘网络一致。
  // 真机教训（2026-10-22）：只验"网表能导出 + ERC 无 error + 器件数对"会给出 ready=true，
  // 但同一块板真机读回来是 171/278 个焊盘没有网络、GND 引脚被并进 +3V3——"验收通过"与
  // "板子能造"之间没有闸门。判据见 runtime/net-connectivity.mjs（只读、可单测）。
  let netConnectivity = null;
  if (netlistText) {
    try {
      if (!pcbUuid) throw Object.assign(new Error('没有 PCB 文档 UUID：无法读取焊盘网络'), { code: 'PCB_UUID_REQUIRED' });
      const readback = unwrap(await execute('pcb.pads.read', { pcbUuid, restoreUuid: activeDocument?.uuid ?? null }));
      const pcbComponents = Array.isArray(readback?.components) ? readback.components : null;
      if (readback?.ok === false) throw Object.assign(new Error(`PCB 焊盘读取失败：${readback.error || 'unknown'}`), { code: readback.error || 'PCB_PADS_READ_FAILED' });
      if (pcbComponents && pcbComponents.length) {
        // 显式 No-Connect 归因：网表导出不带 NC 标记，必须从原理图引脚读回（schematic.components）拿
        let noConnectPins = [];
        try {
          const schematicRead = unwrap(await execute('schematic.components', {}));
          for (const component of (Array.isArray(schematicRead?.components) ? schematicRead.components : [])) {
            const designator = String(component?.designator ?? component?.props?.Designator ?? '').trim();
            if (!designator) continue;
            const primitiveId = component?.primitiveId ?? component?.id;
            for (const pin of (schematicRead?.pins?.[primitiveId] || [])) {
              if (pin?.noConnected === true) noConnectPins.push({ designator, pin: String(pin.pinNumber ?? pin.number ?? '') });
            }
          }
        } catch { noConnectPins = []; }
        const components = pcbComponents.map((component) => ({
          designator: String(component?.designator ?? ''),
          pads: (Array.isArray(component?.pads) ? component.pads : []).map((pad) => ({ padNumber: String(pad?.padNumber ?? ''), net: String(pad?.net ?? '') })),
        }));
        netConnectivity = auditNetConnectivity({ netlistText, components, noConnectPins });
        findings.push(...netConnectivity.findings);
        steps.push({
          step: 'net-connectivity',
          ok: netConnectivity.ready,
          counts: netConnectivity.counts,
          blocking: netConnectivity.findings.filter((item) => item.severity === 'blocking').length,
          warning: netConnectivity.findings.filter((item) => item.severity === 'warning').length,
          noConnectPins: noConnectPins.length,
        });
      } else {
        steps.push({ step: 'net-connectivity', ok: false, skipped: 'pcb-pads-unavailable', reason: readback?.error || null });
        findings.push(finding(ACCEPTANCE_CODES.NET_CONNECTIVITY_UNAVAILABLE, 'PCB 焊盘读回来是空的：无法核对"网表网络 ↔ 焊盘网络"，这一步没有通过也不代表一致', 'pcb', 'warning'));
      }
    } catch (error) {
      steps.push({ step: 'net-connectivity', ok: false, skipped: 'pcb-read-failed', error: String(error?.code || error?.name || 'ERROR') });
      findings.push(finding(ACCEPTANCE_CODES.NET_CONNECTIVITY_UNAVAILABLE, `PCB 焊盘读取失败（${String(error?.message || error).slice(0, 160)}）：无法核对网表与焊盘网络是否一致`, 'pcb', 'warning'));
    }
  }

  // 4) 仿真：仿真网表由 EDA 导出，结论由真实求解器产出；缺一不可，缺了就如实报"不可执行"。

  let simulation = null;
  let designChecks = null;
  if (skipSimulation) {
    findings.push(finding(ACCEPTANCE_CODES.SIMULATION_NOT_RUNNABLE, '本次验收显式跳过仿真（不要把它当成"仿真通过"）', 'simulation', 'warning'));
    steps.push({ step: 'simulation', ok: false, skipped: true });
  } else {
    let simNetlistText = null;
    try {
      const exported = unwrap(await execute('schematic.simulation.netlist.export', { fileName: 'circuitpilot-sim', netlistType: 'Ngspice' }));
      simNetlistText = typeof exported?.text === 'string' ? exported.text : null;
    } catch (error) {
      findings.push(finding(ACCEPTANCE_CODES.SIMULATION_FAILED, `SPICE 网表导出报错：${String(error?.message || error).slice(0, 200)}`, 'simulation', 'warning'));
    }
    const solver = discover();
    if (!simNetlistText) {
      // EDA 导不出 SPICE 网表 ≠ 不能仿真：从真实网表推断出具体电路检查点，自己建网表真跑求解器。
      // 这一步的存在是为了不把"没有仿真"当成验收结论——它给出的是**有范围的**仿真结论。
      steps.push({ step: 'simulation', ok: false, code: 'SIMULATION_NETLIST_UNAVAILABLE', solver: { path: solver.path, source: solver.source } });
      if (solver.path && verification?.parsed) {
        const checks = checksFromDesign({ nets: verification.parsed.nets, components: verification.parsed.components });
        if (checks.some((check) => check.applies !== false)) {
          designChecks = await checksRunner({ checks, solverPath: solver.path, timeoutMs: timeoutMs ?? 20_000, run: simulationRun });
          findings.push(...designChecks.findings.map((item) => ({ ...item, field: `design-checks:${item.field}` })));
          steps.push({ step: 'design-checks', ok: designChecks.ok, summary: designChecks.summary, results: designChecks.results.map((item) => ({ id: item.id, title: item.title, status: item.status, measured: item.measurements ?? null })) });
          if (designChecks.summary.simulated) {
            findings.push(finding(ACCEPTANCE_CODES.SIMULATION_NOT_RUNNABLE, `EDA 导不出 SPICE 网表（原理图没有绑定仿真模型），已改用**设计检查点**仿真（${designChecks.results.filter((item) => item.status === 'pass' || item.status === 'fail').map((item) => item.title).join('、')}）。注意：覆盖范围只限这些检查点，**不等于全电路仿真**。`, 'simulation', 'info'));
          }
        }
      }
      if (!designChecks?.summary?.simulated) {
        // 反向回退：EDA 导不出网表、检查点也跑不了时，若本机已落盘**真实求解器**产出的
        // spice-simulation 证据（如用显式 netlistText + ngspice 跑过），验收引用它并标注覆盖范围。
        // 这只是"复用历史证据"，绝不把"没有仿真"说成"仿真通过"；覆盖范围由 scopeNote 如实给出。
        let reused = null;
        let reuseRejected = null;
        if (typeof loadSimulationEvidence === 'function') {
          const stored = await Promise.resolve().then(() => loadSimulationEvidence()).catch(() => null);
          // 加载器可以返回证据条目本身，也可以返回 {entry, rejected:[{reason, problems}]}。
          // 后者用于把"为什么不复用"如实写进报告（时效/工程/文档归属不符时不能拿来充数）。
          reuseRejected = Array.isArray(stored?.rejected) ? stored.rejected : null;
          const entry = stored?.entry ?? (stored && stored.payload ? stored : null);
          const payload = entry?.payload || null;
          const storedSim = payload?.simulation || payload?.evidence || null;
          const hash = storedSim?.evidenceHash || entry?.digest || null;
          if (stored) {
            stored.path = entry?.path ?? null;
            stored.savedAt = entry?.savedAt ?? null;
          }
          if (storedSim && hash) {
            reused = {
              source: storedSim.source || payload?.source || 'stored-evidence',
              solver: storedSim.solver ?? null,
              evidenceHash: hash,
              operatingPoint: storedSim.operatingPoint ?? null,
              scopeNote: payload?.scopeNote || (payload?.designChecks?.summary?.simulated ? '设计检查点仿真（EDA 导不出 SPICE 网表时的降级结论）' : '外部网表 SPICE 仿真（非 EDA 导出网表，覆盖关键电路而非全板）'),
              evidencePath: stored?.path ?? null,
              savedAt: stored?.savedAt ?? null,
            };
          }
        }
        if (reused) {
          simulation = reused;
          findings.push(finding(ACCEPTANCE_CODES.SIMULATION_NOT_RUNNABLE, `EDA 导不出 SPICE 网表；已引用本机落盘的 SPICE 仿真证据（证据哈希 ${String(reused.evidenceHash).slice(0, 12)}，来源 ${reused.source}）。覆盖范围：${reused.scopeNote}。这是真实求解器产出，但不等于全电路仿真。`, 'simulation', 'info'));
          steps.push({ step: 'simulation', ok: true, code: 'SIMULATION_EVIDENCE_REUSED', evidenceHash: reused.evidenceHash, source: reused.source, evidencePath: reused.evidencePath });
        } else {
          const rejectedText = Array.isArray(reuseRejected) && reuseRejected.length
            ? `本机虽有落盘证据但未引用：${reuseRejected.map((item) => `${item.reason}${Array.isArray(item.problems) ? `（${item.problems.join('；')}）` : ''}`).join(' | ')}。`
            : '';
          findings.push(finding(ACCEPTANCE_CODES.SIMULATION_NOT_RUNNABLE, `仿真未执行：EDA 导不出 SPICE 网表（原理图没绑定仿真模型）${solver.path ? '' : '，且本机没有 ngspice/spice3/xyce'}，也没有可复用的落盘仿真证据、没能推断出可跑的设计检查点。${rejectedText}这不是"仿真通过"，是"没有仿真"。`, 'simulation', 'warning'));
        }
      }
    } else {
      const result = await simulationRun({ netlistText: simNetlistText, solverPath, timeoutMs });
      simulation = result.evidence;
      if (!result.ran) findings.push(finding(ACCEPTANCE_CODES.SIMULATION_FAILED, `仿真未跑成：${result.code} ${result.message}`, 'simulation'));
      findings.push(...result.findings);
      // 仿真"通过"必须落到具体数值上：给了期望区间就逐节点核对，不给就只报"跑过了"。
      if (expectations && simulation) findings.push(...checkOperatingPoint(simulation.operatingPoint, expectations).findings.map((item) => ({ ...item, severity: item.severity || 'blocking' })));
      steps.push({ step: 'simulation', ok: result.ok, code: result.code, evidenceHash: result.evidence?.evidenceHash ?? null });
    }
  }

  const ready = findings.every((item) => item.severity !== 'blocking');
  return {
    kind: 'schematic-acceptance-report',
    schemaVersion: 1,
    ready,
    findings,
    // 同样必须容错：`verification.parsed` 为 null（网表不可解析）时，这里如实给 null，
    // 而不是把"网表读不出来"变成一次崩溃——崩溃会把真正的结论一起吞掉。
    netlist: verification ? { components: verification.parsed?.componentCount ?? null, nets: verification.parsed?.netCount ?? null, pins: verification.parsed?.pinCount ?? null, namedPins: verification.parsed?.namedPinCount ?? null, netsSource: verification.parsed?.netsSource ?? null, meta: netlistMeta } : null,
    plan: verification?.identity?.length ? { identity: verification.identity } : null,
    netConnectivity: netConnectivity ? { ready: netConnectivity.ready, counts: netConnectivity.counts, nets: netConnectivity.nets, findings: netConnectivity.findings } : null,
    erc: ercReport ? { ran: ercReport.ran, aggregateOnly: ercReport.aggregateOnly, detailAvailable: ercReport.detailAvailable, detailSource: ercReport.detailSource ?? null, counts: ercReport.counts, findings: ercReport.findings.map((item) => ({ severity: item.severity, code: item.code, object: item.object, detail: item.detail, aggregate: item.aggregate, count: item.count })) } : null,
    simulation: simulation ? { source: simulation.source, solver: simulation.solver, evidenceHash: simulation.evidenceHash, operatingPoint: simulation.operatingPoint, scopeNote: simulation.scopeNote ?? null, evidencePath: simulation.evidencePath ?? null, savedAt: simulation.savedAt ?? null } : null,
    designChecks: designChecks ? { ok: designChecks.ok, summary: designChecks.summary, results: designChecks.results.map((item) => ({ id: item.id, title: item.title, status: item.status, spec: item.spec ?? null, measured: item.measurements ?? null, defect: item.defect ?? null, recommendation: item.recommendation ?? null, evidenceHash: item.evidence?.evidenceHash ?? null })) } : null,
    steps,
    humanReviewRequired: true,
  };
}
