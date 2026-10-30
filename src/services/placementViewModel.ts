import type {
  PlacementFinding, PlacementItem, PlacementPlanResult, PlacementVerification, PlacementWritebackResult, ProductionOutputDecision, ReleaseGateReport, ReleaseGateSection, Tone,
} from '../types';

/**
 * 布局微调与下单前闸门的**展示逻辑**，全部做成纯函数以便单测：
 * 这些判断一旦错了，界面就会给出乐观结论（"看起来没问题"），而那正是本项目最怕的失败模式。
 */

/** 用户在一次微调里改的数值（mm / 度）。只包含真的被改过的器件。 */
export interface PlacementEdit { ref: string; xMm: number; yMm: number; rotationDeg: number }

/** 写回计划：只用 primitiveId + mm，单位换算由运行时负责（EDA 文档单位是 mil）。 */
export function buildFineTunePlan(placements: PlacementItem[], edits: PlacementEdit[]) {
  const byRef = new Map(edits.map((edit) => [edit.ref, edit]));
  const items = placements
    .filter((item) => item.primitiveId && byRef.has(item.ref))
    .map((item) => {
      const edit = byRef.get(item.ref)!;
      return { ref: item.ref, primitiveId: item.primitiveId, xMm: edit.xMm, yMm: edit.yMm, rotationDeg: edit.rotationDeg, side: item.side, widthMm: item.widthMm ?? null, heightMm: item.heightMm ?? null };
    });
  return { placements: items };
}

/** 把"当前实际位置"还原成一份写回计划：用于一键还原/撤销。 */
export function buildRestorePlan(placements: PlacementItem[]) {
  return {
    placements: placements
      .filter((item) => item.primitiveId && item.current)
      .map((item) => ({ ref: item.ref, primitiveId: item.primitiveId, xMm: item.current!.xMm, yMm: item.current!.yMm, rotationDeg: item.current!.rotationDeg, side: item.side })),
  };
}

/** 写回结果 → 一句人话。**预演、未保存、已回滚都必须说清楚**，不能让人误以为板上已经变了。 */
export function summarizeWriteback(result: PlacementWritebackResult): { tone: Tone; headline: string; detail: string } {
  const findings = result.findings || [];
  const has = (code: string) => findings.some((finding) => finding.code === code);
  const moved = result.updates?.length ?? 0;
  if (result.dryRun) {
    return { tone: 'info', headline: `预演：会移动 ${moved} 个器件（未写入 EDA）`, detail: '预演不改变板子。确认无误后点"执行写回"。' };
  }
  if (has('PLACEMENT_WRITE_ROLLBACK_FAILED')) {
    return { tone: 'danger', headline: '写回失败且回滚没能确认还原', detail: '请按结果里的 manualCoordinates 手工改回（单位 mil），或从源码快照恢复。' };
  }
  if (has('PLACEMENT_WRITE_ROLLED_BACK')) {
    return { tone: 'warning', headline: '写回未通过校验，已自动回滚', detail: '板子保持原样。请先看复核发现的问题（越界/重叠/回读不符）再重试。' };
  }
  if (result.applied && result.ok) {
    return { tone: 'success', headline: `${moved} 个器件已写回并逐项回读确认`, detail: result.saved ? '已在 EDA 中保存。' : '注意：尚未保存——请在嘉立创EDA 中确认外观后手动保存。' };
  }
  return { tone: 'danger', headline: `写回未完成（applied=${String(result.applied)}）`, detail: findings.map((finding) => finding.message).slice(0, 2).join('；') || '未说明原因。' };
}

export interface VerificationRow { tone: Tone; title: string; message: string; phase: string }

/** 复核发现 → 界面行。blocking 必须是 danger，unknown 不许显示成"通过"。 */
export function verificationRows(verification: PlacementVerification | null | undefined, phase: string): VerificationRow[] {
  if (!verification) return [{ tone: 'neutral', title: '没有复核结果', message: '没有复核结果时不能当作通过。', phase }];
  const rows: VerificationRow[] = (verification.findings || []).map((finding) => ({
    tone: finding.severity === 'blocking' ? 'danger' : finding.severity === 'warning' ? 'warning' : finding.severity === 'unknown' ? 'warning' : 'info',
    title: finding.code,
    message: finding.message,
    phase,
  }));
  if (verification.ok && !rows.length) rows.push({ tone: 'success', title: '复核通过', message: `已检查 ${verification.checkedCount} 个器件：都在板框内、无越界重叠。`, phase });
  return rows;
}

/** 方案复核里会影响"能不能直接写回"的关键信息，单独拎出来给界面提示。 */
export function planHighlights(plan: PlacementPlanResult): string[] {
  const lines: string[] = [];
  lines.push(`板框 ${plan.outline?.points?.length ?? 0} 个顶点（${plan.outline?.closed ? '闭合' : '未闭合'}）`);
  lines.push(`器件 ${plan.componentCount} 个，自动放置 ${plan.plan?.stats?.placedCount ?? plan.plan?.placements?.length ?? 0} 个`);
  const utilization = plan.plan?.stats?.utilization;
  if (typeof utilization === 'number') lines.push(`板面利用率 ${(utilization * 100).toFixed(1)}%`);
  if (plan.unknownSize?.length) lines.push(`⚠️ ${plan.unknownSize.length} 个器件尺寸未知（未被自动放置）：${plan.unknownSize.join('、')}`);
  if (plan.diff) lines.push(`与现状相比：移动 ${plan.diff.movedCount}、新增 ${plan.diff.newCount}、不变 ${plan.diff.unchangedCount}`);
  if (plan.affinity?.topPairs?.length) lines.push(`网络关联最强：${plan.affinity.topPairs.slice(0, 3).map(([pair, weight]) => `${pair}(${weight.toFixed(2)})`).join('、')}`);
  return lines;
}

export function gateStatusTone(status: ReleaseGateSection['status']): Tone {
  return status === 'pass' ? 'success' : status === 'warn' ? 'warning' : status === 'blocked' ? 'danger' : 'warning';
}

export function gateStatusLabel(status: ReleaseGateSection['status']): string {
  return status === 'pass' ? '通过' : status === 'warn' ? '有警告' : status === 'blocked' ? '阻断' : '证据缺失';
}

/** 门禁报告 → 界面文案。三方口径必须一致：ready=false 就是不能下单。 */
export function summarizeGate(report: ReleaseGateReport | null): { tone: Tone; headline: string; detail: string } {
  if (!report) return { tone: 'neutral', headline: '还没有运行门禁', detail: '点"运行下单前闸门"开始。' };
  const blocking = report.blockers?.length ?? 0;
  const warnings = report.warnings?.length ?? 0;
  if (report.verdict === 'ready-to-order') return { tone: 'success', headline: '可以下单', detail: `六道闸门全部通过。设计指纹 ${report.fingerprint.sha256.slice(0, 12)}。` };
  if (report.verdict === 'ready-with-warnings') return { tone: 'warning', headline: `可以下单，但有 ${warnings} 条警告`, detail: '请逐条确认（例：价格/库存未接入）。' };
  const codes = [...new Set((report.blockers || []).map((item) => item.code))];
  return { tone: 'danger', headline: `不能下单：${blocking} 条阻断`, detail: `涉及：${codes.join('、')}` };
}

/** 阻断项按"要修什么"分组，避免界面丢一堆码让人无从下手。 */
export function groupBlockers(report: ReleaseGateReport | null): Array<{ title: string; items: PlacementFinding[] }> {
  if (!report) return [];
  const titles: Record<string, string> = {
    RELEASE_SCHEMATIC_NOT_READY: '原理图问题（要改设计）',
    RELEASE_SIMULATION_FAILED: '仿真未通过（要改设计）',
    RELEASE_SIMULATION_NOT_RUN: '仿真没跑成（不能算通过）',
    RELEASE_DRC_UNEXPLAINED: 'DRC 未处理项（要布线或登记豁免）',
    RELEASE_DRC_EXEMPTION_INVALID: '豁免无效（理由/风险没写清）',
    RELEASE_PLACEMENT_NOT_VERIFIED: '布局复核未通过',
    RELEASE_PLACEMENT_NOT_CONFIRMED: '布局没被人确认',
    RELEASE_PLACEMENT_ROLLED_BACK: '写回已回滚/半改状态',
    RELEASE_ARTIFACT_DRAFT_MARKER: '产物是草稿（名字带 DRAFT）',
    RELEASE_ARTIFACT_MISSING: '产物缺失',
    RELEASE_ARTIFACT_EMPTY: '产物是空文件',
    RELEASE_GERBER_COPPER_MISSING: 'Gerber 铜层/板框/钻孔不全',
    RELEASE_BOM_DESIGNATOR_MISMATCH: 'BOM 位号与网表不一致',
    RELEASE_CPL_DESIGNATOR_MISMATCH: 'CPL 位号与网表不一致',
    RELEASE_CPL_COORD_MISMATCH: 'CPL 坐标与实机不符',
    RELEASE_BOM_SUPPLIER_MISSING: 'BOM 料号缺失',
    RELEASE_SUPPLY_IDENTITY_MISSING: '物料身份不明',
  };
  const groups = new Map<string, PlacementFinding[]>();
  for (const blocker of report.blockers || []) {
    const key = titles[blocker.code] || blocker.code;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ code: blocker.code, severity: 'blocking', message: blocker.message, field: blocker.field ?? null });
  }
  return [...groups.entries()].map(([title, items]) => ({ title, items }));
}

/** 两位小数的 mm 文本；未知必须是"—"而不是 0。 */
export function formatMm(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—';
}

/**
 * 产出裁决 → 界面文案。规则只有运行时一处实现，界面只负责显示，所以这里永远不做二次判断。
 */
export function summarizeOutputDecision(decision: ProductionOutputDecision | null | undefined): { tone: Tone; headline: string; detail: string; fix: string[]; naming: string | null; ticket: string | null } {
  if (!decision) {
    return { tone: 'neutral', headline: '还没有产出裁决', detail: '先运行下单前闸门，报告里会带出"现在能出什么文件"。', fix: [], naming: null, ticket: null };
  }
  const naming = decision.outputClass === 'final'
    ? (decision.exampleNames?.[0] ?? null)
    : (decision.draftNaming ?? null);
  if (decision.allowed && decision.outputClass === 'final') {
    return { tone: 'success', headline: '允许按正式命名产出生产文件', detail: `${decision.message ?? ''}${decision.ticket ? ` 放行凭据 ${decision.ticket}` : ''}`.trim(), fix: decision.fix ?? [], naming, ticket: decision.ticket ?? null };
  }
  if (decision.allowed && decision.outputClass === 'draft') {
    return { tone: 'warning', headline: '只允许出草稿文件', detail: decision.warning ?? '草稿不得用于下单。', fix: decision.fix ?? [], naming, ticket: decision.ticket ?? null };
  }
  return {
    tone: 'danger',
    headline: '正式生产文件已被拒绝',
    detail: decision.message ?? '门禁未通过。',
    fix: decision.fix ?? [],
    naming,
    ticket: decision.ticket ?? null,
  };
}
