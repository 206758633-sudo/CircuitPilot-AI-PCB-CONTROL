import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LongTaskPanel } from '../LongTaskPanel';
import type { LongTaskSnapshot } from '../../services/longTask';

const snapshot = (overrides: Partial<LongTaskSnapshot<unknown>>): LongTaskSnapshot<unknown> => ({
  status: 'idle', polls: 0, startedAt: null, finishedAt: null, elapsedMs: 0, result: null, error: null, note: null, ...overrides,
});

describe('D8 长任务面板', () => {
  it('运行中显示状态/轮询次数/取消按钮', () => {
    const html = renderToStaticMarkup(<LongTaskPanel snapshot={snapshot({ status: 'running', polls: 3, elapsedMs: 6_400 })} onCancel={() => {}} />);
    expect(html).toContain('运行中');
    expect(html).toContain('已轮询');
    expect(html).toContain('取消');
    expect(html).not.toContain('重试');
  });

  it('失败显示具体错误与重试按钮；超时说明“可能仍在后台执行”', () => {
    const failed = renderToStaticMarkup(<LongTaskPanel snapshot={snapshot({ status: 'failed', error: 'EDA 渲染进程崩溃' })} onRetry={() => {}} />);
    expect(failed).toContain('失败');
    expect(failed).toContain('EDA 渲染进程崩溃');
    expect(failed).toContain('重试');
    const timeout = renderToStaticMarkup(<LongTaskPanel snapshot={snapshot({ status: 'timeout', note: '后台任务可能仍在执行' })} onRetry={() => {}} />);
    expect(timeout).toContain('超时');
    expect(timeout).toContain('后台任务可能仍在执行');
  });

  it('已停止等待不冒充成功：显示说明且不出现“已完成”', () => {
    const html = renderToStaticMarkup(<LongTaskPanel snapshot={snapshot({ status: 'cancelled', note: '本页停止等待' })} onRetry={() => {}} />);
    expect(html).toContain('已停止等待');
    expect(html).not.toContain('已完成');
  });
});
