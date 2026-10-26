/**
 * D8：统一长任务状态面板（纯展示，状态机在 src/services/longTask.ts）。
 * 关键措辞纪律：取消/超时只代表"本页停止等待"，不冒充任务已终止。
 */
import type { LongTaskSnapshot } from '../services/longTask';
import { Badge, Button } from './ui';
import { RefreshCw, XCircle } from 'lucide-react';

const STATUS_TEXT: Record<LongTaskSnapshot<unknown>['status'], string> = {
  idle: '未开始',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  timeout: '超时（可能仍在后台执行）',
  cancelled: '已停止等待',
};

const STATUS_TONE: Record<LongTaskSnapshot<unknown>['status'], 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  idle: 'neutral',
  running: 'info',
  done: 'success',
  failed: 'danger',
  timeout: 'warning',
  cancelled: 'warning',
};

export function LongTaskPanel({ title, snapshot, onCancel, onRetry, cancelLabel = '取消', retryLabel = '重试' }: {
  title?: string;
  snapshot: LongTaskSnapshot<unknown> | null;
  onCancel?: () => void;
  onRetry?: () => void;
  cancelLabel?: string;
  retryLabel?: string;
}) {
  if (!snapshot) return null;
  const terminal = snapshot.status === 'failed' || snapshot.status === 'timeout' || snapshot.status === 'cancelled';
  return (
    <div className="detail-block">
      {title ? <span>{title}</span> : null}
      <p>
        状态：<Badge tone={STATUS_TONE[snapshot.status]}>{STATUS_TEXT[snapshot.status]}</Badge>
        {snapshot.polls > 0 ? <> · 已轮询 <strong>{snapshot.polls}</strong> 次</> : null}
        {snapshot.elapsedMs > 0 ? <> · 已用 <strong>{(snapshot.elapsedMs / 1000).toFixed(1)}s</strong></> : null}
      </p>
      {snapshot.error ? <p><small style={{ color: 'var(--danger, #b42318)' }}>错误：{snapshot.error}</small></p> : null}
      {snapshot.note ? <p><small>{snapshot.note}</small></p> : null}
      <div className="row-actions">
        {snapshot.status === 'running' && onCancel ? <Button icon={<XCircle size={15} />} onClick={onCancel}>{cancelLabel}</Button> : null}
        {terminal && onRetry ? <Button icon={<RefreshCw size={15} />} onClick={onRetry}>{retryLabel}</Button> : null}
      </div>
    </div>
  );
}
