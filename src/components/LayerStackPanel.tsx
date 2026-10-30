import { useState } from 'react';
import { AlertTriangle, KeyRound, Layers3, RefreshCw, ShieldCheck } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { RuntimeApiError, runtimeClient } from '../services/runtimeClient';
import { Badge, Button, Field, Panel, TableFrame } from '../components/ui';
import { ConfirmDialog } from '../components/overlays';
import type { PcbLayerStack, PcbLayerStackChange } from '../types';

/** 官方 setTheNumberOfCopperLayers 允许的偶数值：2,4,…,32。 */
const ALLOWED_COPPER_COUNTS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];

/**
 * 叠层（铜层数）受控读写面板（4 层能力的前端入口）。
 *
 * 为什么需要它：运行时已有 `GET/POST /api/eda/pcb/layers`（读铜层数/层列表 + 带 write 批准、
 * 写后读回校验与取证的写入口），但前端此前没有任何入口——用户只能看到只读的"实测铜层"。
 * 这里把「读 → 填目标层数 → 签发一次性写批准 → 写 → 读回校验/保存/取证」接成 UI 流程。
 *
 * 纪律（与其它写面板一致）：
 * - 写板一律消费服务端签发的 write 批准（不自己造"已批准"）；
 * - 绝不凭 setCount 返回值声称成功——只认服务端写后读回的结果；
 * - 官方 Beta 能力：即使写成功也提示人工复核叠层与设计规则。
 */
export function LayerStackPanel() {
  const { state, notify, addAudit, reportIssue } = useApp();
  const [stack, setStack] = useState<PcbLayerStack | null>(null);
  const [change, setChange] = useState<PcbLayerStackChange | null>(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState<null | 'read' | 'write'>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const demo = !state.runtime.reachable || state.runtime.mode === 'demo';
  const writeBlocked = demo || !state.eda.connected || state.settings.writePaused || state.eda.writePaused;

  const fail = (caught: unknown, action: string) => {
    const detail = caught instanceof RuntimeApiError ? `[${caught.code}] ${caught.message}` : caught instanceof Error ? caught.message : '未知错误';
    setError(detail);
    reportIssue({
      fingerprint: `layer-stack:${action}`,
      source: 'eda',
      severity: 'error',
      status: 'open',
      code: caught instanceof RuntimeApiError ? caught.code : 'LAYER_STACK_UI_FAILED',
      summary: `叠层${action}失败`,
      detail,
      suggestedAction: '确认嘉立创EDA 打开的是目标 PCB、桥接可用；写失败不会伪造成功，读回不符时以服务端返回的 before/after 为准。',
    });
    addAudit('eda', `叠层${action}失败`, detail, 'error');
    notify(`叠层${action}失败`, detail, 'danger');
  };

  const read = async () => {
    setBusy('read');
    setError(null);
    try {
      const result = await runtimeClient.pcbLayers();
      setStack(result.layers);
      setChange(null);
      setTarget(String(result.layers.copperCount));
      addAudit('eda', '读取 PCB 叠层', `${result.layers.copperCount} 层 / ${result.layers.layers.length} 个层对象`, 'info');
      notify('已读取叠层', `当前铜层 ${result.layers.copperCount} 层。`, 'info');
    } catch (caught) {
      fail(caught, '读取');
    } finally {
      setBusy(null);
    }
  };

  const requestWrite = () => {
    const copperLayers = Number(target);
    if (!ALLOWED_COPPER_COUNTS.includes(copperLayers)) {
      notify('层数不合法', '铜层数必须是 2,4,6,…,32 之一。', 'warning');
      return;
    }
    if (stack && copperLayers === stack.copperCount) {
      notify('层数没有变化', `当前已经是 ${copperLayers} 层；只在需要变更时写入。`, 'warning');
      return;
    }
    setConfirmOpen(true);
  };

  const write = async () => {
    setConfirmOpen(false);
    const copperLayers = Number(target);
    setBusy('write');
    setError(null);
    try {
      // 写板批准一次一用：批准在服务端绑定当前窗口+工程+文档指纹，绑定不上会直接 409。
      const approval = await runtimeClient.issueAutomationApproval({ scope: 'write', note: `叠层铜层数 ${stack?.copperCount ?? '?'} → ${copperLayers}` });
      const result = await runtimeClient.setPcbLayers({ copperLayers, approvalIds: [approval.approvalId], save: true });
      setChange(result);
      setStack({ copperCount: result.after.copperCount, count: result.after.layers.length, layers: result.after.layers });
      setTarget(String(result.after.copperCount));
      addAudit('eda', `叠层变更为 ${copperLayers} 层`, `${result.changed ? '已变更' : '层数未变'} · 读回校验通过 · ${result.saved ? '已保存' : '未保存'}`, result.changed ? 'success' : 'warning');
      notify(
        result.changed ? `叠层已改为 ${copperLayers} 层` : `层数仍为 ${copperLayers} 层`,
        `写后读回校验通过（铜层 ${result.verification.expectedLayerIds.join('/')}）；官方 Beta 能力，请人工复核叠层与设计规则。`,
        result.changed ? 'success' : 'warning',
      );
    } catch (caught) {
      fail(caught, '写入');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      eyebrow="PCB LAYER STACK · 叠层"
      title="叠层与铜层数（2 → 4 层等）"
      meta={(
        <span>
          {stack ? <Badge tone="info">当前 {stack.copperCount} 层</Badge> : <Badge tone="neutral">未读取</Badge>}
          {' '}
          <Badge tone="warning">官方 Beta · 需人工复核</Badge>
        </span>
      )}
      actions={(
        <div className="row-actions">
          <Button icon={<RefreshCw size={15} />} loading={busy === 'read'} disabled={Boolean(busy) || demo || !state.eda.connected} onClick={() => void read()}>
            读取当前叠层
          </Button>
          <Button
            variant="primary"
            icon={<KeyRound size={15} />}
            loading={busy === 'write'}
            disabled={Boolean(busy) || writeBlocked || !stack || !target.trim()}
            title={writeBlocked ? '需要 Runtime + 已连接 EDA，且未暂停写入' : !stack ? '先读取当前叠层' : undefined}
            onClick={requestWrite}
          >
            签发批准并设置层数
          </Button>
        </div>
      )}
    >
      <div className="form-grid">
        <Field label="目标铜层数" hint="必须是 2,4,6,…,32 之一；<b>叠层序号 ≠ 层号</b>：4 层铜层是 1/15/16/2（3/4 是丝印、5/6 是阻焊）。">
          <input
            className="input"
            value={target}
            onChange={(event) => setTarget(event.target.value.trim())}
            placeholder="例如 4"
            inputMode="numeric"
          />
        </Field>
      </div>
      <div className="inline-alert inline-alert--warning">
        <AlertTriangle size={16} style={{ flex: 'none' }} />
        <span>
          设置层数会改变板子的铜层结构（<b>写板</b>），Runtime 会先消费一次性写批准，再读回校验层数与层类型（SIGNAL），
          校验通过后默认保存并落叠层证据；任一步不符都会报错，不会假装成功。官方 Beta API，变更后必须人工复核叠层与设计规则。
        </span>
      </div>
      {error && <div className="inline-alert inline-alert--danger"><AlertTriangle size={16} /><span>{error}</span></div>}
      {stack && (
        <>
          <p>
            <small>
              铜层数 <strong>{stack.copperCount}</strong> · 层对象 <strong>{stack.layers.length}</strong> 个（含非铜层）
            </small>
          </p>
          <TableFrame label="PCB 层列表">
            <table className="table">
              <thead><tr><th>层号</th><th>名称</th><th>类型</th><th>状态</th></tr></thead>
              <tbody>
                {stack.layers.map((layer) => (
                  <tr key={`${layer.id}-${layer.name}`}>
                    <td><code>{layer.id}</code></td>
                    <td>{layer.name || '—'}</td>
                    <td>{String(layer.type || '').toUpperCase() === 'SIGNAL' ? <Badge tone="success">SIGNAL（铜）</Badge> : layer.type || '—'}</td>
                    <td>{layer.locked ? '锁定' : layer.layerStatus || '—'}</td>
                  </tr>
                ))}
                {!stack.layers.length && <tr><td colSpan={4}>层列表为空（服务端返回空数组，不猜测层数）。</td></tr>}
              </tbody>
            </table>
          </TableFrame>
        </>
      )}
      {change && (
        <div className="detail-stack">
          <div className="validation-summary">
            <ShieldCheck size={18} style={{ color: 'var(--green)', flex: 'none' }} />
            <div>
              <strong>写后读回校验通过</strong>
              <p>
                层数 {change.before.copperCount} → {change.after.copperCount}（期望铜层 {change.verification.expectedLayerIds.join('/')}）·
                {change.changed ? ' 层数已变更' : ' 层数未变'} · {change.saved ? '已保存' : '未保存（save=false）'}
              </p>
            </div>
            <Badge tone={change.saved && change.verification.matched ? 'success' : 'warning'}>{change.saved ? 'SAVED' : 'NOT SAVED'}</Badge>
          </div>
          <div className="permission-matrix">
            <div><span>变更前</span><strong>{change.before.copperCount} 层 / {change.before.layers.length} 个层对象</strong></div>
            <div><span>变更后</span><strong>{change.after.copperCount} 层 / {change.after.layers.length} 个层对象</strong></div>
            <div><span>期望铜层</span><strong><code>{change.verification.expectedLayerIds.join(' / ')}</code></strong></div>
            <div><span>保存</span><strong>{change.saved ? 'pcb.save 已确认' : '未保存'}</strong></div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void write()}
        title={`把铜层数改为 ${target} 层？`}
        description={`这是写板动作：将签发一次性写批准并调用官方 Beta API 设置铜层数（当前 ${stack?.copperCount ?? '未读取'} → ${target}）。Runtime 会写后读回校验并默认保存；校验不符会报错且不会伪造成功。变更后请人工复核叠层与设计规则。`}
        confirmLabel="确认设置层数"
      />
    </Panel>
  );
}
