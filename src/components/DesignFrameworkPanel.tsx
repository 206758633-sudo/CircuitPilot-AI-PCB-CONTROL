import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, FlaskConical, Play, RefreshCw } from 'lucide-react';
import { runtimeClient, RuntimeApiError } from '../services/runtimeClient';
import type { DesignFrameworkGoldenReport, DesignFrameworkLoopSummary, DesignFrameworkStatus } from '../types';
import { Badge, Button, Panel, Stat } from './ui';

/** 离线设计闭环演示模型：两个器件重叠，求解器应重排布局后再验证。 */
const DEMO_MODEL = {
  meta: { title: 'design-framework-demo', source: 'ui' },
  board: { widthMm: 60, heightMm: 40, layers: 2, thicknessMm: 1.6, copperOz: 1 },
  components: [
    { ref: 'U1', mpn: 'MCU-A', xMm: 20, yMm: 20, widthMm: 10, heightMm: 10 },
    { ref: 'C1', mpn: '100nF', xMm: 22, yMm: 22, widthMm: 5, heightMm: 3 },
  ],
  nets: [{ name: '3V3', pins: ['U1.1', 'C1.1'], kind: 'power', currentA: 0.2 }],
  rules: { minClearanceMm: 0.3, minEdgeClearanceMm: 0.5 },
};

const statusTone = (status: string | null | undefined) => (status === 'passed' ? 'success' : status === 'blocked' ? 'danger' : status === 'needs-review' ? 'warning' : 'neutral');
const statusLabel = (status: string | null | undefined) => (status === 'passed' ? '通过（仍需官方 DRC/审批）' : status === 'blocked' ? '阻断（不可自动修复）' : status === 'needs-review' ? '需人工审阅（不是 passed）' : '未知');

/**
 * 复合设计框架面板（只读离线闭环）。
 *
 * 边界：只调用只读 Runtime 路由，不写 EDA、不签核；blocked/needs-review 一律如实展示，
 * 绝不把 needs-review 渲染成"通过"。
 */
export function DesignFrameworkPanel() {
  const [status, setStatus] = useState<DesignFrameworkStatus | null>(null);
  const [golden, setGolden] = useState<DesignFrameworkGoldenReport | null>(null);
  const [result, setResult] = useState<DesignFrameworkLoopSummary | null>(null);
  const [modelText, setModelText] = useState(() => JSON.stringify(DEMO_MODEL, null, 2));
  const [sourceMode, setSourceMode] = useState<'model' | 'project'>('model');
  const [busy, setBusy] = useState<'status' | 'golden' | 'run' | null>(null);
  const [error, setError] = useState('');

  const reasonOf = (caught: unknown) => (caught instanceof RuntimeApiError ? `${caught.code}: ${caught.message}` : String((caught as Error)?.message ?? caught));

  const loadStatus = useCallback(async () => {
    setBusy('status');
    setError('');
    try {
      setStatus(await runtimeClient.designFrameworkStatus());
    } catch (caught) {
      setError(`读取框架状态失败：${reasonOf(caught)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const runGolden = async () => {
    setBusy('golden');
    setError('');
    try {
      setGolden(await runtimeClient.designFrameworkGolden());
    } catch (caught) {
      setError(`金板评估失败：${reasonOf(caught)}`);
    } finally {
      setBusy(null);
    }
  };

  const runLoop = async () => {
    setBusy('run');
    setError('');
    setResult(null);
    try {
      if (sourceMode === 'project') {
        // 真实 EDA 模式：Runtime 只读读回当前项目 + EDA（板框/层数/器件几何/网表）。
        setResult(await runtimeClient.designFrameworkRun({ source: 'project', options: { maxIterations: 4 } }));
        return;
      }
      const model = JSON.parse(modelText);
      if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('model 必须是 JSON 对象');
      setResult(await runtimeClient.designFrameworkRun({ model, options: { maxIterations: 4 } }));
    } catch (caught) {
      setError(`运行闭环失败：${reasonOf(caught)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="离线设计闭环（复合框架）"
      eyebrow="DESIGN FRAMEWORK · READ-ONLY"
      meta="IR → Rule-as-Code + 求解器 + Plan-Verify-Repair；只读离线分析，不写 EDA、不签核"
      actions={<Button loading={busy === 'status'} icon={<RefreshCw size={14} />} onClick={() => void loadStatus()}>刷新状态</Button>}
    >
      {error && <div className="banner banner-danger" style={{ marginBottom: 8 }}><AlertTriangle size={14} /> {error}</div>}

      <div className="stat-grid">
        <Stat
          label="KiCad CLI"
          value={status ? (status.kicad.available ? '可用' : '不可用') : '—'}
          tone={status?.kicad.available ? 'success' : 'warning'}
          hint={status?.kicad.reason ?? '外部 DRC 适配器；缺失时 fail-closed'}
        />
        <Stat
          label="外部求解器"
          value={status ? ['ortools', 'z3', 'shapely'].filter((id) => status.externalSolvers[id]?.available).length : '—'}
          tone={status && ['ortools', 'z3', 'shapely'].some((id) => status.externalSolvers[id]?.available) ? 'success' : 'warning'}
          hint="OR-Tools / Z3 / Shapely；不可用时纯 JS 兜底，绝不假装可用"
        />
        <Stat label="规则覆盖率" value={result?.summary.ruleCoverage !== null && result?.summary.ruleCoverage !== undefined ? `${(result.summary.ruleCoverage * 100).toFixed(1)}%` : golden?.metrics.ruleCoverageAvg !== null && golden?.metrics.ruleCoverageAvg !== undefined ? `${(golden.metrics.ruleCoverageAvg * 100).toFixed(1)}%` : '—'} hint="有机器判据的规则占比（其余为 REVIEW）" />
        <Stat
          label="金板"
          value={golden ? `${golden.metrics.passed}/${golden.metrics.total}` : '—'}
          tone={golden ? (golden.ok ? 'success' : 'danger') : 'neutral'}
          hint={golden ? `needs-review=${golden.metrics.statusCounts['needs-review'] ?? 0} · blocked=${golden.metrics.statusCounts.blocked ?? 0}` : '点击「运行金板评估」'}
        />
      </div>

      <div className="row-actions" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <label className="muted" htmlFor="design-loop-source">输入来源</label>
        <select
          id="design-loop-source"
          aria-label="板级 IR 输入来源"
          value={sourceMode}
          onChange={(event) => { setSourceMode(event.target.value === 'project' ? 'project' : 'model'); setResult(null); setError(''); }}
        >
          <option value="model">手填板级 IR（model）</option>
          <option value="project">当前项目 + EDA 只读读回（source=project）</option>
        </select>
        <Button loading={busy === 'golden'} icon={<FlaskConical size={14} />} onClick={() => void runGolden()}>运行金板评估</Button>
        <Button loading={busy === 'run'} variant="primary" icon={<Play size={14} />} onClick={() => void runLoop()}>运行设计闭环</Button>
      </div>

      {result && (
        <div style={{ marginTop: 10 }}>
          <div className="row-actions" style={{ gap: 8, alignItems: 'center' }}>
            <Badge tone={statusTone(result.status)}>{statusLabel(result.status)}</Badge>
            <span className="muted">迭代 {result.summary.iterations} · 修复 {result.repairCount} · blocking {result.summary.blocking ?? '—'} · review {result.summary.review ?? '—'} · 规则覆盖 {result.summary.ruleCoverage === null ? '—' : `${(result.summary.ruleCoverage * 100).toFixed(1)}%`}</span>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>
            finalDigest={result.summary.finalDigest?.slice(0, 16) ?? '—'}… · 编译操作 {result.plan.operations} 项
            {result.plan.skipped.length ? ` · 跳过 ${result.plan.skipped.length} 项（缺 placementId，不按 ref 猜）` : ''}
          </p>
        </div>
      )}

      {sourceMode === 'project' ? (
        <p className="muted" style={{ marginTop: 10 }}>
          source=project：Runtime 用当前项目 + EDA 只读读回（pcb.outline.read / pcb.layers.copperCount /
          pcb.placement.read / schematic.netlist.export）构建 IR；EDA 离线或未选中 PCB 时返回
          DESIGN_FRAMEWORK_EDA_OFFLINE（不编造尺寸）。本面板只发起只读请求。
        </p>
      ) : (
        <>
          <FieldLabel text="板级 IR（JSON，可编辑）" />
          <textarea
        value={modelText}
        onChange={(event) => setModelText(event.target.value)}
        rows={10}
        spellCheck={false}
        aria-label="板级 IR JSON"
            style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
          />
        </>
      )}
      <p className="muted" style={{ marginTop: 6 }}>
        边界：闭环结果只是「执行候选 + 证据」；写 EDA 仍需官方 ERC/DRC、人工审批与 cp_approve → cp_execute。
      </p>
    </Panel>
  );
}

function FieldLabel({ text }: { text: string }) {
  return <div className="muted" style={{ margin: '10px 0 4px' }}>{text}</div>;
}
